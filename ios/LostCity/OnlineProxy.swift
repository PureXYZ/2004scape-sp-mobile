import Foundation

/// The online routes of `lostcity://game` (docs/ARCHITECTURE.md §3.1): while the page load plays on a server
/// (`OnlineServer`), the game's own requests for `/crc` and the archives are answered from that server, fetched natively
/// (a page cannot read them itself: Engine-TS sends no CORS headers), and its OnDemand files are kept in a native cache.
///
/// | Method   | Path                          | Behaviour                                                                    |
/// |----------|-------------------------------|------------------------------------------------------------------------------|
/// | GET      | `/crc…`                       | `<base>/crc` (10 s), 40 bytes with the client's trailer → 200, else 502       |
/// | GET      | `/<archive><crc>`             | bundle `Game/<archive><crc>`, else the cached copy whose CRC-32 is `<crc>`,    |
/// |          |                               | else `<base>/<archive><crc>` (30 s), checked, stored, served; else 502         |
/// | GET      | `/ondemand/<archive>/<file>`  | the cached OnDemand file → 200, or 404                                        |
/// | PUT      | `/ondemand/<archive>/<file>`  | body (1 B - 4 MiB, the page checked it) stored atomically → 204               |
/// | GET      | `/server-probe?url=<address>` | in every mode: `/crc`, `/rs2.cgi`, `/client/client.js` of that address → JSON |
///
/// A 502's body is one line of plain words the page can show: `unreachable`, `timed out`, `not a 2004scape server`,
/// `http <status>`, `local network` (iOS's Local Network privacy refused it: `LocalNetworkPrivacy`), and for an archive
/// `checksum mismatch`. Offline every path but `/server-probe` goes to the bundle
/// routes exactly as before (`handle` answers nil).
///
/// The cache is `Library/Caches/online/<server id>/` (purgeable: everything in it can be fetched again): the archives
/// by name, OnDemand files under `od/<archive>/<file>`. An archive's name carries its CRC, so a cached one never goes
/// stale; deleting the server deletes its folder (`deleteCache`).
///
/// Runs on the scheme handler's detached tasks, never on the main thread; `pageLoaded` (main thread) sets the server for
/// the page load that is starting, under a lock.
nonisolated final class OnlineProxy: @unchecked Sendable {
    static let archives: Set<String> = ["title", "config", "interface", "media", "versionlist", "textures", "wordenc", "sounds"]
    private static let crcTimeout: Duration = .seconds(10)
    private static let archiveTimeout: Duration = .seconds(30)
    private static let maxOnDemandBytes = 4 * 1024 * 1024

    let bundleRoot: URL
    let cacheRoot: URL
    private let session: URLSession
    private let lock = NSLock()
    private var current: OnlineServer?
    /// The server's `/crc` table, as fetched for this page load (logged against the bundle's).
    private var table: [Int32]?
    /// The probe has waited for the system's Local Network question once (the system asks once per install).
    private static let localNetworkAskedKey = "LostCity.localNetworkAsked"

    init(bundleRoot: URL, cacheRoot: URL = OnlineProxy.defaultCacheRoot) {
        self.bundleRoot = bundleRoot
        self.cacheRoot = cacheRoot
        session = URLSession(configuration: Self.configuration)
    }

    static var defaultCacheRoot: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("online", isDirectory: true)
    }

    /// No cookies, no HTTP cache (the archives are cached by CRC here), the app's User-Agent; timeouts are per request.
    static var configuration: URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpAdditionalHeaders = ["User-Agent": AppInfo.userAgent]
        configuration.waitsForConnectivity = false
        return configuration
    }

    /// The server of the page load that is starting (nil: offline).
    func pageLoaded(_ server: OnlineServer?) {
        lock.withLock {
            current = server
            table = nil
        }
        Log.info("online", server.map { "this page plays on \($0.name) (\($0.base))" } ?? "this page plays offline")
    }

    var server: OnlineServer? { lock.withLock { current } }

    func cacheFolder(_ id: String) -> URL {
        cacheRoot.appendingPathComponent(id, isDirectory: true)
    }

    /// Deletes a server's cached archives and OnDemand files (`server delete`).
    func deleteCache(_ id: String) {
        guard OnlineServer.isValidID(id) else { return }
        let folder = cacheFolder(id)
        guard FileManager.default.fileExists(atPath: folder.path(percentEncoded: false)) else { return }
        do {
            try FileManager.default.removeItem(at: folder)
            Log.info("online", "deleted the cache of server \(id)")
        } catch {
            Log.info("online", "could not delete the cache of server \(id): \(error.localizedDescription)")
        }
    }

    // MARK: - Routing

    /// The reply for an online route, or nil when the bundle routes take the request.
    func handle(_ request: Request) async -> Reply? {
        guard let path = request.path else { return nil }
        if path == "/server-probe" {
            return await probeRoute(request)
        }
        guard let server else { return nil }
        if path.hasPrefix("/crc") {
            return await crc(request, server: server)
        }
        if path.hasPrefix("/ondemand/") {
            return onDemand(request, server: server, relative: String(path.dropFirst("/ondemand/".count)))
        }
        if let (archive, crc) = Self.archiveName(path) {
            return await archiveFile(request, server: server, name: "\(archive)\(crc)", crc: crc)
        }
        return nil
    }

    /// `/title410306098` → ("title", 410306098); nil for anything that is not an archive with a CRC.
    static func archiveName(_ path: String) -> (String, Int32)? {
        let name = path.dropFirst()
        guard path.hasPrefix("/"), let digits = name.firstIndex(where: { $0 == "-" || $0.isNumber }) else { return nil }
        let archive = String(name[..<digits])
        guard archives.contains(archive), let crc = Int32(name[digits...]), "\(crc)" == name[digits...] else { return nil }
        return (archive, crc)
    }

    private func readOnly(_ request: Request) -> Reply? {
        request.method == "GET" || request.method == "HEAD" ? nil : .text(405, "method not allowed", headers: ["Allow": "GET, HEAD"])
    }

    // MARK: /crc

    private func crc(_ request: Request, server: OnlineServer) async -> Reply {
        if let refused = readOnly(request) { return refused }
        guard let url = server.url("crc") else { return Self.failure("unreachable") }
        switch await fetch(url, timeout: Self.crcTimeout) {
        case .failure(let failure):
            Log.info("online", "/crc of \(server.displayHost): \(failure.words)")
            return Self.failure(failure.words)
        case .success(let data):
            guard let table = CRC32.table(fromCRCFile: data) else {
                Log.info("online", "/crc of \(server.displayHost): \(data.count) bytes, not a CRC table")
                return Self.failure(FetchFailure.notGame.words)
            }
            lock.withLock { self.table = table }
            let differ = zip(Self.archiveOrder, table.dropFirst()).filter { !bundleHas("\($0)\($1)") }.map(\.0)
            Log.info("online", "/crc of \(server.displayHost): \(differ.isEmpty ? "the same archives as the bundle" : "differs from the bundle in \(differ.joined(separator: ", "))")")
            return .data(data, type: "application/octet-stream")
        }
    }

    /// The archives in `/crc` order (index 1 to 8; 0 is unused).
    private static let archiveOrder = ["title", "config", "interface", "media", "versionlist", "textures", "wordenc", "sounds"]

    // MARK: Archives

    private func archiveFile(_ request: Request, server: OnlineServer, name: String, crc: Int32) async -> Reply {
        if let refused = readOnly(request) { return refused }
        // 1. the bundle's copy: the same name is the same CRC, so the same bytes
        if let size = bundleSize(name) {
            return Reply(status: 200, headers: ["Content-Type": "application/octet-stream"],
                         body: request.method == "HEAD" ? .headers(length: size) : .file(bundleRoot.appendingPathComponent(name), length: size))
        }
        // 2. this server's cached copy, if it still checks out
        let cached = cacheFolder(server.id).appendingPathComponent(name)
        if let data = try? Data(contentsOf: cached) {
            if CRC32.checksum(data) == crc {
                return .data(data, type: "application/octet-stream")
            }
            Log.info("online", "cached \(name) of \(server.displayHost) fails its CRC; fetching it again")
            try? FileManager.default.removeItem(at: cached)
        }
        // 3. the server's
        guard let url = server.url(name) else { return Self.failure("unreachable") }
        switch await fetch(url, timeout: Self.archiveTimeout) {
        case .failure(let failure):
            Log.info("online", "\(name) of \(server.displayHost): \(failure.words)")
            return Self.failure(failure.words)
        case .success(let data):
            guard CRC32.checksum(data) == crc else {
                Log.info("online", "\(name) of \(server.displayHost): \(data.count) bytes with CRC \(CRC32.checksum(data))")
                return Self.failure("checksum mismatch")
            }
            do {
                try FileManager.default.createDirectory(at: cached.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: cached, options: .atomic)
            } catch {
                Log.info("online", "could not cache \(name): \(error.localizedDescription)")
            }
            Log.info("online", "\(name) of \(server.displayHost): \(data.count) bytes, cached")
            return .data(data, type: "application/octet-stream")
        }
    }

    private func bundleSize(_ name: String) -> Int? {
        var info = stat()
        guard stat(bundleRoot.appendingPathComponent(name).path(percentEncoded: false), &info) == 0, (info.st_mode & S_IFMT) == S_IFREG
        else { return nil }
        return Int(info.st_size)
    }

    private func bundleHas(_ name: String) -> Bool { bundleSize(name) != nil }

    // MARK: OnDemand

    private func onDemand(_ request: Request, server: OnlineServer, relative: String) -> Reply {
        let parts = relative.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, ["0", "1", "2", "3"].contains(parts[0]), Self.isPlainNumber(parts[1]),
              let file = Int(parts[1]), file <= 65535
        else { return .text(400, "invalid OnDemand path") }
        let url = cacheFolder(server.id).appendingPathComponent("od/\(parts[0])/\(file)")
        switch request.method {
        case "GET", "HEAD":
            guard let data = try? Data(contentsOf: url) else { return .text(404, "not cached") }
            return request.method == "HEAD"
                ? Reply(status: 200, headers: ["Content-Type": "application/octet-stream"], body: .headers(length: data.count))
                : .data(data, type: "application/octet-stream")
        case "PUT":
            let body = request.body() ?? Data()
            guard !body.isEmpty else { return .text(400, "empty body") }
            guard body.count <= Self.maxOnDemandBytes else { return .text(413, "too large") }
            do {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try body.write(to: url, options: .atomic)
                return .empty(204)
            } catch {
                Log.info("online", "could not cache OnDemand \(relative): \(error.localizedDescription)")
                return .text(500, error.localizedDescription)
            }
        default:
            return .text(405, "method not allowed", headers: ["Allow": "GET, HEAD, PUT"])
        }
    }

    /// Decimal digits with no sign and no leading zero (`0` itself is fine).
    private static func isPlainNumber(_ text: Substring) -> Bool {
        !text.isEmpty && text.count <= 5 && text.allSatisfy { $0.isASCII && $0.isNumber } && (text == "0" || !text.hasPrefix("0"))
    }

    // MARK: - /server-probe

    private func probeRoute(_ request: Request) async -> Reply {
        if let refused = readOnly(request) { return refused }
        guard let typed = request.query["url"] else { return .text(400, "missing url") }
        let result = await probe(typed)
        let data = (try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data("{}".utf8)
        return .data(data, type: "application/json")
    }

    /// What Add server shows: `/crc` (40 bytes with a good trailer: it speaks 2004scape), then
    /// the world's node id and members flag from `/rs2.cgi`'s `new Client(<node>, <lowmem>, <members>)`, then the login
    /// key from `/client/client.js`, 10 s each. `ok` = a good `/crc`. The first time the Local Network question stops
    /// `/crc`, it is tried again each second while the player answers (30 s at most).
    func probe(_ typed: String) async -> [String: Any] {
        var result: [String: Any] = ["ok": false, "url": NSNull(), "crc": false, "nodeId": 10, "members": true,
                                     "rsa": NSNull(), "notes": [String]()]
        guard let base = OnlineServer.normalize(typed) else {
            result["error"] = "invalid address"
            return result
        }
        result["url"] = base
        let server = OnlineServer(id: "probe", name: base, base: base)
        let host = server.displayHost
        guard let crcURL = server.url("crc") else {
            result["error"] = "invalid address"
            return result
        }
        var crc = await fetch(crcURL, timeout: Self.crcTimeout)
        if case .failure(.localNetwork) = crc, !UserDefaults.standard.bool(forKey: Self.localNetworkAskedKey) {
            // the first local connection of this install: the system is asking the player now; once answered, again
            UserDefaults.standard.set(true, forKey: Self.localNetworkAskedKey)
            Log.info("online", "probe \(host): the local network is not allowed (yet): waiting for the player's answer")
            for _ in 0 ..< 30 {
                try? await Task.sleep(for: .seconds(1))
                crc = await fetch(crcURL, timeout: Self.crcTimeout)
                if case .failure(.localNetwork) = crc { continue }
                break
            }
        }
        switch crc {
        case .failure(let failure):
            result["error"] = failure.words
            Log.info("online", "probe \(host): \(failure.words)")
            return result
        case .success(let data):
            guard CRC32.table(fromCRCFile: data) != nil else {
                result["error"] = FetchFailure.notGame.words
                Log.info("online", "probe \(host): /crc is \(data.count) bytes, not a CRC table")
                return result
            }
        }
        result["ok"] = true
        result["crc"] = true
        var notes: [String] = []

        if let url = server.url("rs2.cgi"), case .success(let data) = await fetch(url, timeout: Self.crcTimeout),
           let world = Self.worldSettings(String(decoding: data, as: UTF8.self)) {
            result["nodeId"] = world.nodeId
            result["members"] = world.members
        } else {
            notes.append("No world settings found: world 10, members.")
        }
        if let url = server.url("client/client.js"), case .success(let data) = await fetch(url, timeout: Self.crcTimeout),
           let key = Self.loginKey(String(decoding: data, as: UTF8.self)) {
            result["rsa"] = ["n": key.n, "e": key.e]
        } else {
            notes.append("No login key found: the built-in key.")
        }
        result["notes"] = notes
        Log.info("online", "probe \(host): a 2004scape server, world \(result["nodeId"] ?? 10), \(result["members"] as? Bool == false ? "free" : "members"), \(result["rsa"] is NSNull ? "built-in key" : "its own key")")
        return result
    }

    /// `new Client(<node id>, <low memory>, <members>)` in the server's game page (Engine-TS view/client.ejs).
    static func worldSettings(_ page: String) -> (nodeId: Int, members: Bool)? {
        guard let match = firstMatch(#"new\s+Client\(\s*(\d{1,5})\s*,\s*[^,()]*,\s*(true|false|1|0)\s*\)"#, in: page),
              let nodeId = Int(match[1])
        else { return nil }
        return (nodeId, match[2] == "true" || match[2] == "1")
    }

    /// The login key's two decimal literals in the server's client bundle: `rsaenc(BigInt("<n>"), BigInt("<e>"))`, or,
    /// in a minified bundle that renamed `rsaenc`, the only distinct adjacent pair `BigInt("<40+ digits>"),BigInt("…")`.
    static func loginKey(_ script: String) -> (n: String, e: String)? {
        let literal = #"BigInt\(\s*(["'])(\d+)\1\s*\)"#
        if let match = firstMatch(#"rsaenc\(\s*"# + literal + #"\s*,\s*"# + literal.replacingOccurrences(of: #"\1"#, with: #"\3"#), in: script) {
            return (match[2], match[4])
        }
        let pair = #"BigInt\(\s*(["'])(\d{40,})\1\s*\)\s*,\s*BigInt\(\s*(["'])(\d+)\3\s*\)"#
        let pairs = Set(allMatches(pair, in: script).map { "\($0[2]) \($0[4])" })
        guard pairs.count == 1, let only = pairs.first?.split(separator: " ") else { return nil }
        return (String(only[0]), String(only[1]))
    }

    private static func firstMatch(_ pattern: String, in text: String) -> [String]? {
        allMatches(pattern, in: text, limit: 1).first
    }

    private static func allMatches(_ pattern: String, in text: String, limit: Int = .max) -> [[String]] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: range).prefix(limit).map { match in
            (0 ..< match.numberOfRanges).map { index in
                Range(match.range(at: index), in: text).map { String(text[$0]) } ?? ""
            }
        }
    }

    // MARK: - Fetching

    enum FetchFailure: Error {
        case unreachable, timedOut, notGame, http(Int), localNetwork

        /// The plain words a 502 carries.
        var words: String {
            switch self {
            case .unreachable: "unreachable"
            case .timedOut: "timed out"
            case .notGame: "not a 2004scape server"
            case .http(let status): "http \(status)"
            case .localNetwork: LocalNetworkPrivacy.words
            }
        }
    }

    /// GET `url` within `timeout` (the whole response): its body on 200; 404 means the address does not serve the game.
    private func fetch(_ url: URL, timeout: Duration) async -> Result<Data, FetchFailure> {
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: TimeInterval(timeout.components.seconds))
        let session = self.session
        return await withTaskGroup(of: Result<Data, FetchFailure>?.self) { group in
            group.addTask {
                do {
                    let (data, response) = try await session.data(for: request)
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    switch status {
                    case 200: return .success(data)
                    case 404: return .failure(.notGame)
                    default: return .failure(.http(status))
                    }
                } catch {
                    if Task.isCancelled { return nil }
                    if LocalNetworkPrivacy.refused(error, host: url.host()) { return .failure(.localNetwork) }
                    return .failure((error as? URLError)?.code == .timedOut ? .timedOut : .unreachable)
                }
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return Task.isCancelled ? nil : .failure(.timedOut)
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first ?? .failure(.timedOut)
        }
    }

    private static func failure(_ words: String) -> Reply {
        Reply(status: 502, headers: ["Content-Type": "text/plain; charset=utf-8"], body: .data(Data(words.utf8)))
    }
}
