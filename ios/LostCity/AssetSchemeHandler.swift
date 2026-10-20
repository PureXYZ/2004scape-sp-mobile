import Foundation
import WebKit

/// Serves the origin `lostcity://game` (ARCHITECTURE.md §3):
///
/// | Method          | Path               | Behaviour                                                        |
/// |-----------------|--------------------|------------------------------------------------------------------|
/// | GET/HEAD        | `/<file>`          | bundle `Game/<file>` (`/` → `index.html`), 404 if missing          |
/// | GET/HEAD        | `/save/<relpath>`  | `Documents/<relpath>` → 200 bytes / 404                          |
/// | PUT/POST        | `/save/<relpath>`  | atomic write, previous version kept as `.bak` → 204 / 400 / 500   |
/// | DELETE          | `/save/<relpath>`  | 204 / 404 (the deleted file is kept as `.bak`)                   |
/// | GET             | `/save-index`      | JSON `[{path, size, modified}]` of everything under Documents     |
/// | POST/PUT        | `/log`             | body = UTF-8 line(s) → native log (for workers) → 204             |
///
/// Every response carries `Cache-Control: no-store`. Invalid save paths get 400.
///
/// Threading: WebKit calls `start`/`stop` on the main thread. All file IO runs off the main thread
/// and the response is handed back to the task on the main thread. The main thread must never
/// block waiting for JavaScript: the engine worker does *synchronous* XHRs to `/save`, and WebKit
/// can only start those scheme tasks while the main thread is free. Files larger than one chunk
/// are streamed in 1 MB pieces, each delivered in its own main-thread turn, so a 20 MB cache file
/// neither holds the main thread nor needs a 20 MB buffer.
///
/// Responses go back through the main *run loop* (`onMainRunLoop`), not the main dispatch queue
/// (MainActor): `LifecycleCoordinator.terminate()` keeps the final save alive by spinning a nested
/// run loop, and when that happens inside a main-queue block (as `willTerminate` can be),
/// main-queue work cannot run until it returns. Measured: through the main queue the engine's
/// sync save XHR waited out the whole 4 s deadline; through the run loop it completes in ms.
///
/// WebKit raises an Objective-C exception if a task is touched after `webView(_:stop:)`, so tasks
/// are tracked in `tasks` (keyed by a private token, not by object address, which can be reused
/// by a later task once the stopped one is freed) and only live tasks are ever answered.
final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
    nonisolated static let scheme = "lostcity"
    nonisolated static let host = "game"
    nonisolated static let indexURL = URL(string: "\(scheme)://\(host)/index.html")!

    private let router: Router
    private var tasks: [UInt64: any WKURLSchemeTask] = [:]
    private var tokens: [ObjectIdentifier: UInt64] = [:]
    private var nextToken: UInt64 = 0

    init(bundleRoot: URL, saveStore: SaveStore) {
        router = Router(bundleRoot: bundleRoot, saves: saveStore)
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        nextToken += 1
        let token = nextToken
        tasks[token] = urlSchemeTask
        tokens[ObjectIdentifier(urlSchemeTask)] = token

        let request = Request(urlSchemeTask.request)
        let router = self.router
        Task.detached(priority: .userInitiated) {
            let started = ContinuousClock.now
            let reply = router.handle(request)
            let delivered = await self.deliver(reply, token: token, request: request)
            if Log.verbose || reply.status >= 400 {
                let elapsed = (ContinuousClock.now - started).milliseconds
                Log.info("scheme", "\(request.method) \(request.displayPath) → \(reply.status)\(delivered ? "" : " (cancelled)") \(String(format: "%.1f", elapsed)) ms")
            }
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        if let token = tokens.removeValue(forKey: ObjectIdentifier(urlSchemeTask)) {
            tasks[token] = nil
        }
    }

    // MARK: - Delivery (runs on the detached task; every task access hops to the main run loop)

    /// Returns false if WebKit stopped the task before the response was complete.
    private nonisolated func deliver(_ reply: Reply, token: UInt64, request: Request) async -> Bool {
        let url = request.url
        switch reply.body {
        case .data(let data):
            guard await onMainRunLoop({ self.begin(token, reply, url: url) }) else { return false }
            if !data.isEmpty, request.method != "HEAD" {
                guard await onMainRunLoop({ self.receive(token, data) }) else { return false }
            }
            return await onMainRunLoop { self.finish(token) }

        case .headers:
            guard await onMainRunLoop({ self.begin(token, reply, url: url) }) else { return false }
            return await onMainRunLoop { self.finish(token) }

        case .file(let file, let length):
            guard request.method != "HEAD" else {
                guard await onMainRunLoop({ self.begin(token, reply, url: url) }) else { return false }
                return await onMainRunLoop { self.finish(token) }
            }
            let handle: FileHandle
            do {
                handle = try FileHandle(forReadingFrom: file)
            } catch {
                let failure = Reply.text(500, "cannot open \(file.lastPathComponent): \(error.localizedDescription)")
                return await deliver(failure, token: token, request: request)
            }
            defer { try? handle.close() }
            guard await onMainRunLoop({ self.begin(token, reply, url: url) }) else { return false }
            var remaining = length
            while remaining > 0 {
                let chunk: Data
                do {
                    chunk = try handle.read(upToCount: min(Self.chunkSize, remaining)) ?? Data()
                } catch {
                    let failure = error as NSError
                    await onMainRunLoop { self.fail(token, failure) }
                    return false
                }
                if chunk.isEmpty { break }  // file shrank underneath us
                guard await onMainRunLoop({ self.receive(token, chunk) }) else { return false }
                remaining -= chunk.count
            }
            return await onMainRunLoop { self.finish(token) }
        }
    }

    /// Runs `body` on the main thread from the main run loop (`CFRunLoopPerformBlock` in the common
    /// modes), which also turns inside nested `RunLoop.run` calls — see the type comment.
    private nonisolated func onMainRunLoop<T: Sendable>(_ body: @escaping @MainActor () -> T) async -> T {
        await withCheckedContinuation { continuation in
            let main = CFRunLoopGetMain()
            CFRunLoopPerformBlock(main, CFRunLoopMode.commonModes.rawValue) {
                continuation.resume(returning: MainActor.assumeIsolated(body))
            }
            CFRunLoopWakeUp(main)
        }
    }

    private nonisolated static let chunkSize = 1 << 20

    private func begin(_ token: UInt64, _ reply: Reply, url: URL) -> Bool {
        guard let task = tasks[token] else { return false }
        var headers = reply.headers
        headers["Cache-Control"] = "no-store"
        headers["Access-Control-Allow-Origin"] = "*"
        headers["Content-Length"] = String(reply.contentLength)
        guard let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            fail(token, URLError(.badServerResponse))
            return false
        }
        task.didReceive(response)
        return true
    }

    private func receive(_ token: UInt64, _ data: Data) -> Bool {
        guard let task = tasks[token] else { return false }
        task.didReceive(data)
        return true
    }

    private func finish(_ token: UInt64) -> Bool {
        guard let task = forget(token) else { return false }
        task.didFinish()
        return true
    }

    private func fail(_ token: UInt64, _ error: any Error) {
        forget(token)?.didFailWithError(error)
    }

    @discardableResult
    private func forget(_ token: UInt64) -> (any WKURLSchemeTask)? {
        guard let task = tasks.removeValue(forKey: token) else { return nil }
        tokens[ObjectIdentifier(task)] = nil
        return task
    }
}

// MARK: - Request / reply

/// The parts of a `URLRequest` the router needs, captured on the main thread.
nonisolated struct Request: Sendable {
    let url: URL
    let host: String
    let method: String
    /// Percent-decoded exactly once; nil if the path has an invalid escape.
    let path: String?
    let query: [String: String]
    private let bodyData: Data?
    private let bodyStream: UncheckedSendable<InputStream>?

    init(_ request: URLRequest) {
        let url = request.url ?? AssetSchemeHandler.indexURL
        self.url = url
        host = url.host(percentEncoded: false) ?? ""
        method = (request.httpMethod ?? "GET").uppercased()
        path = url.path(percentEncoded: true).removingPercentEncoding
        var query: [String: String] = [:]
        for item in URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [] {
            query[item.name] = item.value ?? ""
        }
        self.query = query
        bodyData = request.httpBody
        // WebKit has only ever been seen to use httpBody, but a stream is legal; it is read on the
        // background task, never on the main thread.
        bodyStream = request.httpBody == nil ? request.httpBodyStream.map(UncheckedSendable.init) : nil
    }

    var displayPath: String { url.path(percentEncoded: true) + (url.query(percentEncoded: true).map { "?" + $0 } ?? "") }

    /// The request body (reads the stream, if that is how it arrived).
    func body() -> Data? {
        if let bodyData { return bodyData }
        guard let stream = bodyStream?.value else { return nil }
        var data = Data()
        stream.open()
        defer { stream.close() }
        let capacity = 64 * 1024
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
        defer { buffer.deallocate() }
        while true {
            let count = stream.read(buffer, maxLength: capacity)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

nonisolated struct Reply: Sendable {
    enum Body: Sendable {
        case data(Data)
        /// Streamed from disk in chunks (headers only for HEAD).
        case file(URL, length: Int)
        /// A HEAD reply: `Content-Length` of the resource, no body.
        case headers(length: Int)
    }

    var status: Int
    var headers: [String: String] = [:]
    var body: Body = .data(Data())

    var contentLength: Int {
        switch body {
        case .data(let data): data.count
        case .file(_, let length), .headers(let length): length
        }
    }

    static func empty(_ status: Int, headers: [String: String] = [:]) -> Reply {
        Reply(status: status, headers: headers)
    }

    static func text(_ status: Int, _ message: String, headers: [String: String] = [:]) -> Reply {
        var headers = headers
        headers["Content-Type"] = "text/plain; charset=utf-8"
        return Reply(status: status, headers: headers, body: .data(Data((message + "\n").utf8)))
    }

    static func data(_ data: Data, type: String, headers: [String: String] = [:]) -> Reply {
        var headers = headers
        headers["Content-Type"] = type
        return Reply(status: 200, headers: headers, body: .data(data))
    }
}

// MARK: - Routing (pure, blocking IO; always called off the main thread)

nonisolated struct Router: Sendable {
    let bundleRoot: URL
    let saves: SaveStore

    func handle(_ request: Request) -> Reply {
        guard request.host == AssetSchemeHandler.host else {
            return .text(400, "unknown host \(request.host)")
        }
        guard let path = request.path else {
            return .text(400, "malformed path")
        }
        if path == "/save-index" {
            return saveIndex(request)
        }
        if path == "/log" {
            return log(request)
        }
        if path.hasPrefix("/save/") {
            return save(request, relative: String(path.dropFirst("/save/".count)))
        }
        return bundleFile(request, path: path)
    }

    // MARK: Bundle files

    private func bundleFile(_ request: Request, path: String) -> Reply {
        guard request.method == "GET" || request.method == "HEAD" else {
            return .text(405, "method not allowed", headers: ["Allow": "GET, HEAD"])
        }
        var relative = String(path.drop(while: { $0 == "/" }))
        if relative.isEmpty || relative.hasSuffix("/") {
            relative += "index.html"
        }
        let parts = relative.split(separator: "/", omittingEmptySubsequences: false)
        guard !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." || $0.contains("\0") }) else {
            return .text(400, "invalid path")
        }
        var file = bundleRoot
        for part in parts { file.appendPathComponent(String(part), isDirectory: false) }

        var info = stat()
        guard stat(file.path(percentEncoded: false), &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
            return .text(404, "not found: \(path)")
        }
        return Reply(status: 200, headers: ["Content-Type": Self.mimeType(for: file.pathExtension)],
                     body: .file(file, length: Int(info.st_size)))
    }

    /// ARCHITECTURE.md §3. Anything not listed — including the extensionless jag archives and
    /// `/crc` — is `application/octet-stream`. Module scripts and workers are rejected by WebKit
    /// unless served as JavaScript, and `instantiateStreaming` requires `application/wasm`.
    static func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html", "htm": "text/html; charset=utf-8"
        case "js", "mjs": "text/javascript; charset=utf-8"
        case "wasm": "application/wasm"
        case "json", "map": "application/json"
        case "css": "text/css; charset=utf-8"
        case "png": "image/png"
        case "txt": "text/plain; charset=utf-8"
        case "svg": "image/svg+xml"
        case "jpg", "jpeg": "image/jpeg"
        case "gif": "image/gif"
        case "webp": "image/webp"
        case "ico": "image/x-icon"
        case "wav": "audio/wav"
        case "woff2": "font/woff2"
        case "woff": "font/woff"
        case "ttf": "font/ttf"
        default: "application/octet-stream"
        }
    }

    // MARK: Saves

    private func save(_ request: Request, relative: String) -> Reply {
        do {
            switch request.method {
            case "GET":
                return .data(try saves.read(relative), type: "application/octet-stream")
            case "HEAD":
                let info = try saves.info(relative)
                return Reply(status: 200, headers: ["Content-Type": "application/octet-stream"],
                             body: .headers(length: info.size))
            case "PUT", "POST":
                let body = request.body() ?? Data()
                let started = ContinuousClock.now
                try saves.write(relative, data: body)
                Log.info("save", "\(request.method) \(relative) \(body.count) B → 204 (\(String(format: "%.1f", (ContinuousClock.now - started).milliseconds)) ms)")
                return .empty(204)
            case "DELETE":
                try saves.delete(relative)
                let kept = relative.hasSuffix(SaveStore.backupSuffix) ? "" : " (kept as \(relative)\(SaveStore.backupSuffix))"
                Log.info("save", "DELETE \(relative) → 204\(kept)")
                return .empty(204)
            case "OPTIONS":
                return .empty(204, headers: ["Allow": "GET, HEAD, PUT, POST, DELETE"])
            default:
                return .text(405, "method not allowed", headers: ["Allow": "GET, HEAD, PUT, POST, DELETE"])
            }
        } catch {
            switch error {
            case .invalidPath:
                return .text(400, "invalid save path: \(relative)")
            case .notFound:
                return .text(404, "no such save: \(relative)")
            case .emptyBody:
                Log.info("save", "\(request.method) \(relative): refused empty body (Blob bodies are dropped by WebKit — send an ArrayBuffer)")
                return .text(400, "empty body (send an ArrayBuffer or Uint8Array, not a Blob)")
            case .io(let message):
                Log.info("save", "\(request.method) \(relative) FAILED: \(message)")
                return .text(500, message)
            }
        }
    }

    private func saveIndex(_ request: Request) -> Reply {
        guard request.method == "GET" || request.method == "HEAD" else {
            return .text(405, "method not allowed", headers: ["Allow": "GET, HEAD"])
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = (try? encoder.encode(saves.index())) ?? Data("[]".utf8)
        return .data(data, type: "application/json")
    }

    // MARK: Log

    /// Workers have no `webkit.messageHandlers`; they POST their console output here.
    /// Optional query: `?src=<tag>&level=<level>` (default tag `worker`).
    private func log(_ request: Request) -> Reply {
        guard request.method == "POST" || request.method == "PUT" else {
            return .text(405, "method not allowed", headers: ["Allow": "POST, PUT"])
        }
        let text = String(decoding: request.body() ?? Data(), as: UTF8.self)
        let source = request.query["src"].flatMap { $0.isEmpty ? nil : $0 } ?? "worker"
        let level = request.query["level"].flatMap { $0.isEmpty || $0 == "log" || $0 == "info" ? nil : $0 }
        let tag = level.map { "\(source):\($0)" } ?? source
        for line in text.split(omittingEmptySubsequences: true, whereSeparator: \.isNewline) {
            Log.write("[\(tag)] \(line)")
        }
        return .empty(204)
    }
}

/// Carries a value that is only ever used from one place at a time across an isolation boundary.
nonisolated struct UncheckedSendable<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}

private extension Duration {
    nonisolated var milliseconds: Double {
        Double(components.seconds) * 1000 + Double(components.attoseconds) / 1e15
    }
}
