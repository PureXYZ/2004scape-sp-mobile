import WebKit

/// The page's JavaScript heap, collected by the app (ARCHITECTURE.md §7.7). WebKit lets a JavaScript heap grow to about
/// twice what is alive in it before a full collection, and the page's own (the client's: the engine worker has its own)
/// holds garbage that lives past WebKit's quick young collections. Measured on an iPhone 13 mini at Lumbridge with 1000
/// bots (2026-10-27, the phone's Web Inspector): 180 MB alive, up to 390 MB in all; one full collection gave back
/// 182 MB of the game's WebContent process at once. Collected every `period` seconds in the world (WebContent's median
/// 776 -> 742 MB, the page's heap 274 -> 222; frames over 25 ms 7 -> 9 in 4 minutes), and at once on a memory warning or
/// memory pressure and before the bots' chat model loads (`BotChatModel.onMemoryWarning`, `onWillLoad`).
///
/// WebKit has no public call for it: this is WKProcessPool's `_garbageCollectJavaScriptObjectsForTesting` (a full
/// collection of each web process's main-thread VM), looked up at run time. A WebKit without it: nothing happens.
@MainActor
final class PageMemory {
    private static let selector = NSSelectorFromString("_garbageCollectJavaScriptObjectsForTesting")

    /// Seconds between the timer's collections (0: no timer; a test run's A/B sets it, debug `page-gc-every`).
    var period: TimeInterval = 30 {
        didSet {
            timer?.invalidate()
            timer = nil
            setRunning(running)
        }
    }
    /// Whether this WebKit has the call (logged once when it has not).
    let available: Bool

    private weak var webView: WKWebView?
    private var timer: Timer?
    private var running = false

    init(webView: WKWebView) {
        self.webView = webView
        available = webView.configuration.processPool.responds(to: Self.selector)
        if !available {
            Log.info("memory", "this WebKit cannot collect the page's heap on request: left to WebKit")
        }
    }

    /// A full collection of the page's heap now; `reason` is logged (the timer's are not). False without the call.
    @discardableResult
    func collect(_ reason: String? = nil) -> Bool {
        guard available, let pool = webView?.configuration.processPool else { return false }
        pool.perform(Self.selector)
        if let reason {
            Log.info("memory", "the page's heap collected (\(reason))")
        }
        return true
    }

    /// The timer runs while the player is in the world and the app is active.
    func setRunning(_ running: Bool) {
        self.running = running
        guard running, available, period > 0 else {
            timer?.invalidate()
            timer = nil
            return
        }
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: period, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { _ = self?.collect() }
        }
    }
}
