import UIKit

/// App lifecycle → `LostCityHost.lifecycle(event)` (ARCHITECTURE.md §7).
///
/// Suspending events (`pause` on will-resign-active, `background`, `terminate`) make the engine
/// save every player and stop ticking; the page's promise resolves once the saves are on disk
/// (the engine worker PUTs them to `/save` with synchronous XHR, served by `AssetSchemeHandler` on
/// this main thread — which is why nothing here ever blocks the main thread waiting for it).
/// Resuming events (`foreground`, `resume`) restart it.
///
/// Rules:
/// * **One flush in flight.** A suspending event that arrives while a flush is running is not
///   sent again; it just keeps the background task alive for the running one.
/// * **No double sends.** After a successful flush the world is paused and unchanged, so further
///   suspending events (`background` after `pause`) are skipped; a failed one is retried by the
///   next. Only the first of `foreground`/`resume` is sent.
/// * **Ordering.** A resume that arrives while a flush is still running is sent after it ends.
/// * **The background task always ends**: when the page answers, after `flushTimeout`, or when
///   iOS calls the expiration handler — whichever comes first.
final class LifecycleCoordinator {
    enum Event: String {
        case pause, background, terminate, foreground, resume

        var suspends: Bool { self == .pause || self == .background || self == .terminate }
    }

    private enum State: Equatable {
        case running
        case flushing(serial: Int)
        case paused(saved: Bool)
    }

    /// Generous for a few KB of saves (51–93 ms measured in the simulator), well inside the
    /// ~30 s iOS grants a background task.
    static let flushTimeout: Duration = .seconds(8)
    /// willTerminate: iOS kills the process ~5 s after the notification.
    static let terminateWait: TimeInterval = 4

    private let bridge: PageBridge
    private let backgroundTask = BackgroundTask(name: "lostcity-save")
    private var state = State.running
    private var serial = 0
    private var flushStarted: ContinuousClock.Instant?
    private var pendingResume: Event?
    private var timeout: Task<Void, Never>?

    init(bridge: PageBridge) {
        self.bridge = bridge
    }

    func handle(_ event: Event) {
        event.suspends ? suspend(event) : resume(event)
    }

    /// `willTerminate`: start (or join) a flush, then keep the main run loop turning until it
    /// completes. Returning would let iOS kill the process; blocking the thread outright would
    /// deadlock, because the engine's save requests are started by WebKit on this run loop.
    func terminate() {
        handle(.terminate)
        let deadline = Date().addingTimeInterval(Self.terminateWait)
        while case .flushing = state, Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
    }

    /// The page is being (re)loaded: a fresh engine boots running, and whatever the old page was
    /// doing is moot.
    func reset() {
        if case .flushing(let serial) = state {
            Log.info("life", "flush #\(serial) abandoned: page reloading")
        }
        timeout?.cancel()
        timeout = nil
        pendingResume = nil
        state = .running
        backgroundTask.end()
    }

    // MARK: - Suspend

    private func suspend(_ event: Event) {
        switch state {
        case .flushing(let serial):
            pendingResume = nil  // superseded: we are going down again
            backgroundTask.begin()
            Log.info("life", "\(event): flush #\(serial) already in flight, not re-sent")
        case .paused(saved: true):
            pendingResume = nil
            Log.info("life", "\(event): already paused and saved, not re-sent")
        case .running, .paused(saved: false):
            startFlush(event)
        }
    }

    private func startFlush(_ event: Event) {
        serial += 1
        let serial = self.serial
        state = .flushing(serial: serial)
        flushStarted = .now
        backgroundTask.begin { [weak self] in
            self?.finishFlush(serial, saved: false, detail: "background time expired")
        }
        Log.info("life", "\(event) → flush #\(serial) started")
        bridge.call("lifecycle", [event.rawValue]) { [weak self] outcome in
            // { ok: false } (a save could not be written) is a failed flush, retried by the next suspending event
            self?.finishFlush(serial, saved: outcome.reportedSuccess, detail: outcome.description)
        }
        timeout?.cancel()
        timeout = Task { [weak self] in
            try? await Task.sleep(for: Self.flushTimeout)
            guard !Task.isCancelled else { return }
            self?.finishFlush(serial, saved: false, detail: "timed out after \(Self.flushTimeout)")
        }
    }

    private func finishFlush(_ serial: Int, saved: Bool, detail: String) {
        guard state == .flushing(serial: serial) else {
            Log.info("life", "flush #\(serial) answered late: \(detail)")
            return
        }
        let elapsed = flushStarted.map { started -> String in
            let duration = ContinuousClock.now - started
            let ms = Double(duration.components.seconds) * 1000 + Double(duration.components.attoseconds) / 1e15
            return String(format: "%.0f ms", ms)
        } ?? "?"
        state = .paused(saved: saved)
        timeout?.cancel()
        timeout = nil
        Log.info("life", "flush #\(serial) \(saved ? "done" : "FAILED") in \(elapsed): \(detail)")
        backgroundTask.end()
        Log.flush()
        if let event = pendingResume {
            pendingResume = nil
            send(event)
        }
    }

    // MARK: - Resume

    private func resume(_ event: Event) {
        switch state {
        case .running:
            Log.debug("life", "\(event): already running, not re-sent")
        case .flushing(let serial):
            pendingResume = event
            Log.info("life", "\(event): queued until flush #\(serial) finishes")
        case .paused:
            send(event)
        }
    }

    private func send(_ event: Event) {
        state = .running
        Log.info("life", "\(event) → sent")
        bridge.call("lifecycle", [event.rawValue]) { outcome in
            Log.info("life", "\(event) → \(outcome)")
        }
    }
}

/// A UIKit background task that is ended exactly once: explicitly, or by its expiration handler.
final class BackgroundTask {
    private let name: String
    private var identifier = UIBackgroundTaskIdentifier.invalid
    private var onExpire: (() -> Void)?

    init(name: String) {
        self.name = name
    }

    var isActive: Bool { identifier != .invalid }

    /// Begins the task if it is not already running. `onExpire` (if given) replaces the handler.
    func begin(onExpire: (() -> Void)? = nil) {
        if let onExpire { self.onExpire = onExpire }
        guard identifier == .invalid else { return }
        identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            self?.expire()
        }
        Log.info("life", "background task \(name) began")
    }

    func end() {
        onExpire = nil
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
        Log.info("life", "background task \(name) ended")
    }

    private func expire() {
        Log.info("life", "background task \(name) expired")
        let handler = onExpire
        onExpire = nil
        handler?()
        end()
    }
}
