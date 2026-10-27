import Foundation

/// The page's WebSockets online (docs/ARCHITECTURE.md §7.3): the page's `NativeSocket` (host.js) stands in for
/// `window.WebSocket`, and its sockets are opened here, with `URLSessionWebSocketTask`, to the server of the page load
/// (`OnlineProxy.server`), whatever URL the client asked for.
///
/// page → native `{type:'socket', action:'open'|'send'|'close', id, purpose?, data?}`; native → page
/// `LostCityHost.socket.events([{id, event, data?, code?, reason?}])`, one call for everything that arrived together (a
/// batch is sent 2 ms after its first event), in arrival order. Events: `open`; `message` (`data`: base64 of one binary message); `error`
/// (`reason`: `refused`, `timed out`, `not found`, `dns`, `tls`, `http <status>`, `local network`, `network`, `no server`,
/// `text frame`),
/// always followed by `close` (1006 and the same words); `close` (the server's code and reason), final.
///
/// * The upgrade asks for the `binary` subprotocol, sends the app's User-Agent and **no Origin** (the app does not pose
///   as any web site), no cookies. 10 s to open.
/// * Sends keep their order: they wait until the socket is open and then go one at a time.
/// * A close from the page ends the socket with 1000 and no more events for it (the page fires its own `close`, as
///   EngineSocket does). Sockets of a page that goes away (reload, WebContent ended) are closed with 1001 (`reset`), and
///   events still on their way are dropped.
/// * Nothing is kept alive in the background. A socket that ended while the app was suspended is reported when the app
///   runs again.
/// * The log has each socket's host, purpose, open, close code, error and message counts, never what was sent (the
///   login block holds the password).
final class SocketBridge {
    private let bridge: PageBridge
    /// The page load's server (nil: offline, where every `open` fails with `no server`).
    var server: () -> OnlineServer? = { nil }
    private var sockets: [Int: Connection] = [:]
    private var byTask: [Int: Connection] = [:]
    private var pending: [[String: Any]] = []
    private var flushScheduled = false
    /// How long a batch collects events. Each receive completes in its own main-queue block, and the next one is only
    /// asked for then, so a burst the server sent in one write arrives as a string of blocks with the run loop idle in
    /// between (measured on the simulator: 50 messages, 43 turns); within 2 ms they come as one call.
    private static let batchWindow: DispatchTimeInterval = .milliseconds(2)
    /// Counts pages: events of a socket from an earlier page are dropped.
    private var page = 0
    private let delegate = Delegate()
    private lazy var session: URLSession = {
        let configuration = OnlineProxy.configuration
        // the client notices a silent server itself (its 30 s read timeout); this only bounds a connection that is stuck
        configuration.timeoutIntervalForRequest = 120
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: .main)
        delegate.bridge = self
        return session
    }()

    static let openTimeout: Duration = .seconds(10)
    /// How long a close (or failure) waits for the messages that arrived before it, which the receive loop delivers.
    private static let drainTimeout: Duration = .milliseconds(1000)

    init(bridge: PageBridge) {
        self.bridge = bridge
    }

    /// Sockets open now (the debug hook `online-state`).
    var openCount: Int { sockets.count }

    // MARK: - Page → native

    func handle(_ message: [String: Any]) {
        guard let id = (message["id"] as? NSNumber)?.intValue else {
            Log.info("socket", "ignored a socket message without an id")
            return
        }
        switch message["action"] as? String {
        case "open":
            open(id, purpose: message["purpose"] as? String ?? "game")
        case "send":
            guard let connection = sockets[id] else { return }
            guard let text = message["data"] as? String, let data = Data(base64Encoded: text) else {
                Log.info("socket", "\(connection.label): ignored a send that is not base64")
                return
            }
            connection.queue.append(data)
            pump(connection)
        case "close":
            guard let connection = sockets[id] else { return }
            Log.info("socket", "\(connection.label) closed by the page (sent \(connection.sent), received \(connection.received))")
            forget(connection)
            connection.task?.cancel(with: .normalClosure, reason: nil)
        default:
            Log.info("socket", "unknown socket action: \(message["action"] ?? "none")")
        }
    }

    private func open(_ id: Int, purpose: String) {
        guard sockets[id] == nil else {
            Log.info("socket", "socket \(id): already open, ignored")
            return
        }
        let connection = Connection(id: id, purpose: purpose, page: page)
        sockets[id] = connection
        guard let server = server(), let url = server.socketURL else {
            Log.info("socket", "\(connection.label): no server for this page")
            fail(connection, "no server")
            return
        }
        connection.host = server.displayHost
        var request = URLRequest(url: url)
        request.setValue("binary", forHTTPHeaderField: "Sec-WebSocket-Protocol")
        let task = session.webSocketTask(with: request)
        connection.task = task
        byTask[task.taskIdentifier] = connection
        Log.info("socket", "\(connection.label) opening \(url.absoluteString)")
        task.resume()
        connection.timer = Task { [weak self, weak connection] in
            try? await Task.sleep(for: Self.openTimeout)
            guard !Task.isCancelled, let self, let connection, connection.state == .connecting else { return }
            Log.info("socket", "\(connection.label): no answer in \(Self.openTimeout)")
            self.fail(connection, "timed out")
            connection.task?.cancel()
        }
    }

    /// Native's own failure (no server, timed out, a text frame): error and close at once.
    private func fail(_ connection: Connection, _ words: String) {
        guard connection.state != .closed else { return }
        emit(connection, ["event": "error", "reason": words])
        emit(connection, ["event": "close", "code": 1006, "reason": words])
        Log.info("socket", "\(connection.label) error: \(words)")
        forget(connection)
    }

    private func pump(_ connection: Connection) {
        guard connection.state == .open, !connection.sending, !connection.queue.isEmpty, let task = connection.task else { return }
        let data = connection.queue.removeFirst()
        connection.sending = true
        task.send(.data(data)) { [weak self, weak connection] error in
            Self.onMain {
                guard let self, let connection else { return }
                connection.sending = false
                guard error == nil else { return }  // (the task's completion reports why)
                connection.sent += 1
                self.pump(connection)
            }
        }
    }

    // MARK: - URLSession → events

    fileprivate func didOpen(_ task: URLSessionWebSocketTask) {
        guard let connection = byTask[task.taskIdentifier], connection.state == .connecting else { return }
        connection.state = .open
        connection.timer?.cancel()
        Log.info("socket", "\(connection.label) open")
        emit(connection, ["event": "open"])
        connection.receiving = true
        receive(connection)
        pump(connection)
    }

    private func receive(_ connection: Connection) {
        connection.task?.receive { [weak self, weak connection] result in
            Self.onMain {
                guard let self, let connection, connection.state != .closed else { return }
                switch result {
                case .success(.data(let data)):
                    connection.received += 1
                    self.emit(connection, ["event": "message", "data": data.base64EncodedString()])
                    self.receive(connection)
                case .success:
                    // the game speaks binary only
                    Log.info("socket", "\(connection.label): a text frame")
                    self.fail(connection, "text frame")
                    connection.task?.cancel(with: .unsupportedData, reason: nil)
                case .failure:
                    connection.receiving = false
                    self.finishIfDrained(connection)
                }
            }
        }
    }

    fileprivate func didClose(_ task: URLSessionWebSocketTask, code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard let connection = byTask[task.taskIdentifier], connection.state != .closed, connection.ending == nil else { return }
        let words = reason.map { String(decoding: $0, as: UTF8.self) } ?? ""
        connection.ending = .closed(code: code == .invalid ? 1005 : code.rawValue, reason: words)
        waitForDrain(connection)
    }

    fileprivate func didComplete(_ task: URLSessionTask, error: (any Error)?) {
        guard let connection = byTask.removeValue(forKey: task.taskIdentifier), connection.state != .closed else { return }
        if connection.ending == nil {
            connection.ending = .failed(Self.words(for: error, response: task.response, host: task.originalRequest?.url?.host()))
        }
        if connection.state == .connecting { connection.receiving = false }
        waitForDrain(connection)
    }

    /// The final events wait for the receive loop to hand over the messages that came before the close.
    private func waitForDrain(_ connection: Connection) {
        guard !finishIfDrained(connection), connection.drainTimer == nil else { return }
        connection.drainTimer = Task { [weak self, weak connection] in
            try? await Task.sleep(for: Self.drainTimeout)
            guard !Task.isCancelled, let self, let connection else { return }
            connection.receiving = false
            self.finishIfDrained(connection)
        }
    }

    @discardableResult
    private func finishIfDrained(_ connection: Connection) -> Bool {
        guard connection.state != .closed, !connection.receiving, let ending = connection.ending else { return false }
        connection.drainTimer?.cancel()
        switch ending {
        case .closed(let code, let reason):
            Log.info("socket", "\(connection.label) closed \(code)\(reason.isEmpty ? "" : " (\(reason))") (sent \(connection.sent), received \(connection.received))")
            emit(connection, ["event": "close", "code": code, "reason": reason])
            forget(connection)
        case .failed(let words):
            fail(connection, words)
        }
        return true
    }

    /// The plain words for a failed upgrade or a dropped connection (`local network`: iOS's Local Network privacy refused it).
    static func words(for error: (any Error)?, response: URLResponse?, host: String? = nil) -> String {
        if let status = (response as? HTTPURLResponse)?.statusCode, status != 101 {
            return "http \(status)"
        }
        if LocalNetworkPrivacy.refused(error, host: host) {
            return LocalNetworkPrivacy.words
        }
        switch (error as? URLError)?.code {
        case .cannotConnectToHost?: return "refused"
        case .timedOut?: return "timed out"
        case .cannotFindHost?: return "not found"
        case .dnsLookupFailed?: return "dns"
        case .secureConnectionFailed?, .serverCertificateHasBadDate?, .serverCertificateUntrusted?, .serverCertificateHasUnknownRoot?,
             .serverCertificateNotYetValid?, .clientCertificateRejected?, .clientCertificateRequired?:
            return "tls"
        default: return "network"
        }
    }

    /// A task's completion handler, on the main thread (the session's delegate queue, where they normally run already).
    private nonisolated static func onMain(_ body: @escaping @MainActor @Sendable () -> Void) {
        if Thread.isMainThread {
            MainActor.assumeIsolated(body)
        } else {
            DispatchQueue.main.async { MainActor.assumeIsolated(body) }
        }
    }

    // MARK: - Batching

    private func emit(_ connection: Connection, _ event: [String: Any]) {
        guard connection.page == page else { return }
        var event = event
        event["id"] = connection.id
        pending.append(event)
        guard !flushScheduled else { return }
        flushScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.batchWindow) { [weak self] in
            MainActor.assumeIsolated { self?.flush() }
        }
    }

    private func flush() {
        flushScheduled = false
        guard !pending.isEmpty else { return }
        let events = pending
        pending.removeAll()
        bridge.call("socket.events", [events]) { outcome in
            if case .failed(let message) = outcome { Log.info("socket", "socket.events failed: \(message)") }
        }
    }

    private func forget(_ connection: Connection) {
        connection.state = .closed
        connection.timer?.cancel()
        connection.drainTimer?.cancel()
        if sockets[connection.id] === connection { sockets[connection.id] = nil }
    }

    /// The page went away: its sockets are closed (1001) and their events dropped.
    func reset() {
        page += 1
        pending.removeAll()
        let open = Array(sockets.values)
        sockets.removeAll()
        for connection in open {
            Log.info("socket", "\(connection.label) closed: the page went away (sent \(connection.sent), received \(connection.received))")
            forget(connection)
            connection.task?.cancel(with: .goingAway, reason: nil)
        }
    }

    // MARK: - Types

    private final class Connection {
        enum State { case connecting, open, closed }
        enum Ending { case closed(code: Int, reason: String), failed(String) }

        let id: Int
        let purpose: String
        let page: Int
        var host = ""
        var task: URLSessionWebSocketTask?
        var state = State.connecting
        var queue: [Data] = []
        var sending = false
        var receiving = false
        var ending: Ending?
        var timer: Task<Void, Never>?
        var drainTimer: Task<Void, Never>?
        var sent = 0
        var received = 0

        init(id: Int, purpose: String, page: Int) {
            self.id = id
            self.purpose = purpose
            self.page = page
        }

        var label: String { "socket \(id) (\(purpose)\(host.isEmpty ? "" : " @ \(host)"))" }
    }

    /// URLSession's delegate calls arrive on the main queue (`delegateQueue: .main`).
    @MainActor private final class Delegate: NSObject, URLSessionWebSocketDelegate {
        weak var bridge: SocketBridge?

        nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
            MainActor.assumeIsolated { bridge?.didOpen(webSocketTask) }
        }

        nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
            MainActor.assumeIsolated { bridge?.didClose(webSocketTask, code: closeCode, reason: reason) }
        }

        nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
            MainActor.assumeIsolated { bridge?.didComplete(task, error: error) }
        }
    }
}
