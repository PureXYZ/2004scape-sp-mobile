import UIKit
import WebKit

/// Hosts the game: a full-screen WKWebView running the web client (page) and the engine (a module
/// Web Worker in the same page), all loaded from the app bundle through `AssetSchemeHandler`,
/// plus the native side of the page contract (ARCHITECTURE.md §7): keyboard, haptics, settings,
/// status, lifecycle, memory warnings, recovery from a WebContent process crash, and the bots' chat
/// model (§7.1: `BotChatModel`, the Claude key's secure box).
///
/// The screen has one loader and one error UI: `LoadingOverlay` draws the page's own loader until the page has drawn
/// it (fonts and logo in, two frames later), and errors the page reports (`fatal`) are shown by the page alone;
/// native shows its 2004 error screen only when there is no page to show one.
final class GameViewController: UIViewController {
    private var webView: WKWebView!
    private let saveStore = SaveStore.documents()
    private let settings = NativeSettings()
    private let page = PageBridge()
    private lazy var schemeHandler = AssetSchemeHandler(bundleRoot: Self.gameFolder, saveStore: saveStore)
    private lazy var keyboard = KeyboardBridge(bridge: page)
    private lazy var lifecycle = LifecycleCoordinator(bridge: page)
    private lazy var haptics = Haptics(view: view)
    private let overlay = LoadingOverlay()
    private lazy var botChat = makeBotChat()
    /// The Claude key's secure box while it is up (Settings › Bot chat › Set key…).
    private var keyAlert: UIAlertController?
    private var observers: [NSObjectProtocol] = []
    private var overlayFallback: Task<Void, Never>?
    private var terminations: [Date] = []
    /// WebContent terminations since launch (the phone spike's log).
    private var terminationCount = 0
    private var reloadWhenActive = false
    /// The screen stays on while playing; a phone put down mid-session may lock again after this long
    /// without input (locking pauses the world and saves, like leaving the app).
    private static let keepAwakeAfterInput: Duration = .seconds(5 * 60)
    private var inGame = false
    private var lastUserActivity = ContinuousClock.now
    private var keepAwakeTimer: Timer?
    /// The navigation started by `loadGame`: only its failure leaves the screen without a page.
    private var gameLoad: WKNavigation?
    /// Counts documents, so an answer from a page that has gone since cannot uncover its successor's loader.
    private var pageSerial = 0
    private var uncovering = false

    private static var gameFolder: URL {
        Bundle.main.url(forResource: "Game", withExtension: nil) ?? Bundle.main.bundleURL.appendingPathComponent("Game")
    }

    override func loadView() {
        let root = UIView()
        root.backgroundColor = .black
        let webView = makeWebView()
        webView.frame = root.bounds
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        root.addSubview(webView)
        root.addSubview(keyboard)  // 1×1 and transparent: it only exists to be first responder
        overlay.frame = root.bounds
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        applyOverlayMargins()
        root.addSubview(overlay)
        self.webView = webView
        page.webView = webView
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observeApp()
        keyboard.onActivity = { [weak self] in self?.userActivity() }
        keyboard.onHaptic = { [weak self] in self?.playHaptic($0) }
        let timer = Timer(timeInterval: 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.updateKeepAwake() }
        }
        RunLoop.main.add(timer, forMode: .common)
        keepAwakeTimer = timer
        loadGame(reason: "launch")
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        setNeedsUpdateOfHomeIndicatorAutoHidden()
        setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
        (view.window as? GameWindow)?.onUserActivity = { [weak self] in self?.userActivity() }
        keyboard.activate()
    }

    // MARK: - Chrome

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    /// A stray swipe from an edge (the HUD's chat buttons, tab column and side panel reach the screen edges) needs a
    /// second swipe.
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }

    // MARK: - Web view

    private func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(schemeHandler, forURLScheme: AssetSchemeHandler.scheme)
        config.websiteDataStore = .default()  // persistent; storage is keyed by the fixed origin
        config.mediaTypesRequiringUserActionForPlayback = []  // AudioContext runs without a gesture
        config.allowsInlineMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = false
        config.allowsAirPlayForMediaPlayback = false
        config.dataDetectorTypes = []
        config.allowsInlinePredictions = false
        if #available(iOS 18.0, *) { config.writingToolsBehavior = .none }
        config.defaultWebpagePreferences.preferredContentMode = .mobile
        config.preferences.isTextInteractionEnabled = false  // no selection, loupe or callout on long-press
        config.preferences.isElementFullscreenEnabled = false
        config.preferences.isFraudulentWebsiteWarningEnabled = false  // offline; never look anything up
        config.preferences.javaScriptCanOpenWindowsAutomatically = false

        let scripts = config.userContentController
        let proxy = ScriptMessageProxy(self)
        scripts.add(proxy, name: "log")
        scripts.add(proxy, name: "native")
        installUserScripts(scripts)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isInspectable = true  // Safari ▸ Develop; kept on for now (also in release builds)
        webView.isOpaque = false  // with a black background: black, never white, before first paint
        webView.backgroundColor = .black
        webView.underPageBackgroundColor = .black
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.isFindInteractionEnabled = false
        let scrollView = webView.scrollView
        scrollView.backgroundColor = .black
        scrollView.isScrollEnabled = false
        scrollView.bounces = false
        scrollView.bouncesZoom = false
        scrollView.alwaysBounceVertical = false
        scrollView.alwaysBounceHorizontal = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.contentInsetAdjustmentBehavior = .never  // the page lays out around env(safe-area-inset-*)
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 1
        disableZoomAndDrag(webView)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        return webView
    }

    /// The pinch recognizer and WebKit's drag interaction (long-press lifts images/links into a
    /// drag preview) can appear with page content; called again after each load.
    private func disableZoomAndDrag(_ webView: WKWebView) {
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        for content in webView.scrollView.subviews where String(describing: type(of: content)).hasPrefix("WKContentView") {
            for case let drag as UIDragInteraction in content.interactions { drag.isEnabled = false }
        }
    }

    /// (Re)installs the document-start scripts; called again when settings change, so a reload
    /// (including the automatic one after a crash) sees the current settings.
    private func installUserScripts(_ scripts: WKUserContentController) {
        scripts.removeAllUserScripts()
        scripts.addUserScript(WKUserScript(source: Self.consoleBridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let info = AppInfo.pageInfo(settings: settings.values, lm: botChat.status)
        let json = (try? JSONSerialization.data(withJSONObject: info, options: [.sortedKeys]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{\"platform\":\"ios\",\"settings\":{}}"
        scripts.addUserScript(WKUserScript(source: "window.LostCityNative = \(json);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    private func loadGame(reason: String) {
        Log.info("host", "loading \(AssetSchemeHandler.indexURL.absoluteString) (\(reason))")
        resetPageState()
        overlay.show()
        overlayFallback?.cancel()
        gameLoad = webView.load(URLRequest(url: AssetSchemeHandler.indexURL))
    }

    /// Native state that belongs to the page that is going away.
    private func resetPageState() {
        keyboard.reset()
        lifecycle.reset()
        inGame = false
        setKeepAwake(false)
        pageSerial += 1
        uncovering = false
        botChat.pageReset()
    }

    /// The page is up (`ready`, or any status): fades the loader out once the page has drawn its own, identical one
    /// (its fonts loaded, its logo decoded, two frames later; 0.8 s at most), so the hand-over never shows a
    /// half-drawn loader.
    private func uncover() {
        guard overlay.isShowing, !overlay.isShowingError, !uncovering else { return }
        uncovering = true
        let serial = pageSerial
        webView.callAsyncJavaScript(Self.loaderDrawn, arguments: [:], in: nil, in: .page) { [weak self] _ in
            guard let self, self.pageSerial == serial else { return }
            self.uncovering = false
            if !self.overlay.isShowingError { self.overlay.hide() }
        }
    }

    private static let loaderDrawn = """
    const drawn = (async () => {
        await document.fonts.ready;
        const logo = new Image();
        logo.src = 'ui/sprites/logo.png';
        await logo.decode().catch(() => {});
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })();
    await Promise.race([drawn, new Promise((resolve) => setTimeout(resolve, 800))]);
    return true;
    """

    // MARK: - App events

    private func observeApp() {
        func on(_ name: Notification.Name, _ action: @escaping @MainActor (GameViewController) -> Void) {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    if let self { action(self) }
                }
            })
        }
        on(UIApplication.willResignActiveNotification) {
            $0.keyboard.releaseHeldKeys()
            $0.lifecycle.handle(.pause)
            $0.botChat.pause()  // (no GPU work while inactive; the model stays loaded for a moment's interruption)
        }
        on(UIApplication.didEnterBackgroundNotification) {
            $0.lifecycle.handle(.background)
            $0.botChat.suspend()  // (and in the background it is freed)
            Log.flush()
        }
        on(UIApplication.willEnterForegroundNotification) {
            $0.lifecycle.handle(.foreground)
        }
        on(UIApplication.didBecomeActiveNotification) {
            $0.lifecycle.handle(.resume)
            $0.botChat.resume()
            $0.reloadIfNeeded()
            $0.keyboard.activate()
        }
        on(UIApplication.willTerminateNotification) {
            Log.info("app", "will terminate")
            $0.lifecycle.terminate()
            Log.flush()
        }
        on(UIApplication.didReceiveMemoryWarningNotification) {
            $0.memoryWarning()
        }
    }

    private func memoryWarning() {
        Log.info("host", "memory warning")
        botChat.memoryWarning()
        page.call("memoryWarning") { outcome in
            Log.info("host", "memoryWarning → \(outcome)")
        }
    }

    private func userActivity() {
        lastUserActivity = .now
        updateKeepAwake()
    }

    private func updateKeepAwake() {
        setKeepAwake(inGame && ContinuousClock.now - lastUserActivity < Self.keepAwakeAfterInput)
    }

    private func setKeepAwake(_ awake: Bool) {
        guard UIApplication.shared.isIdleTimerDisabled != awake else { return }
        UIApplication.shared.isIdleTimerDisabled = awake
        Log.info("host", "keep screen awake: \(awake)")
    }

    /// The WebContent process died while the app was in the background: restart it now that
    /// the app is visible (a page started in the background would just be suspended mid-boot).
    private func reloadIfNeeded() {
        guard reloadWhenActive else { return }
        reloadWhenActive = false
        Notice.show("2004Scape was closed by iOS while in the background and is restarting.", in: view)
        loadGame(reason: "web content ended while in the background")
    }

    // MARK: - Page → native

    private func handleNativeMessage(_ body: Any) {
        guard let message = body as? [String: Any], let type = message["type"] as? String else {
            Log.info("host", "ignored malformed native message: \(body)")
            return
        }
        switch type {
        case "ready":
            Log.info("host", "page ready")
            uncover()
            keyboard.activate()
        case "status":
            handleStatus(message["phase"] as? String ?? "?", detail: message["detail"])
        case "keyboard":
            keyboard.handle(message)
        case "haptic":
            haptics.play(message["style"] as? String ?? "medium", intensity: message["intensity"] as? Double)
        case "settings":
            if settings.merge(message["values"]) {
                installUserScripts(webView.configuration.userContentController)
                applyOverlayMargins()
                Log.info("host", "settings saved (\(settings.values.keys.sorted().joined(separator: ", ")))")
            } else {
                Log.info("host", "settings rejected: values must be a JSON object under 64 KB")
            }
        case "fatal":
            pageFailed(message["message"] as? String ?? "Unknown error")
        case "lm":
            botChat.handle(message)
        case "lm-warm":
            botChat.warm()
        case "lm-key":
            handleModelKey(message["action"] as? String ?? "")
        #if DEBUG
        case "debug":
            handleDebug(message)
        case "lm-bench":
            handleModelBench(message)
        #endif
        default:
            Log.info("host", "unhandled native message: \(type)")
        }
    }

    private func handleStatus(_ phase: String, detail: Any?) {
        let detailText = detail.flatMap { $0 is NSNull ? nil : " — \($0)" } ?? ""
        Log.info("host", "status \(phase)\(detailText)")
        uncover()
        inGame = phase == "ingame"
        if inGame {
            lastUserActivity = .now
            haptics.prepare()
        }
        updateKeepAwake()
    }

    /// The loading cover's margins: Settings › Display's, as the page lays out its own (`LoadingOverlay.margins`).
    private func applyOverlayMargins() {
        let margin = { (key: String) in CGFloat((self.settings.values[key] as? NSNumber)?.doubleValue ?? 0) }
        overlay.margins = (margin("safeSides"), margin("safeTop"), margin("safeBottom"))
    }

    /// A haptic that native starts itself (a refused keystroke, a fatal error), unless Settings › Vibration is off:
    /// the page's `haptics` setting, absent (on) until the player changes it. The page's own `{type:'haptic'}`
    /// messages have passed that check already.
    private func playHaptic(_ style: String) {
        guard (settings.values["haptics"] as? Bool) != false else { return }
        haptics.play(style)
    }

    /// `{type:'fatal'}`: the page shows its own 2004 error screen, with Restart, so native adds no second error UI. It
    /// records the failure, plays the error haptic (unless Vibration is off), lets the screen sleep, and gets the
    /// keyboard (and a loader still up after a failure before `ready`) out of the way of the page's screen.
    private func pageFailed(_ message: String) {
        Log.info("host", "FATAL (the page shows it): \(message)")
        playHaptic("error")
        inGame = false
        setKeepAwake(false)
        keyboard.hide(userInitiated: false)
        if overlay.isShowing, !overlay.isShowingError {
            overlayFallback?.cancel()
            overlay.hide()
        }
    }

    // MARK: - The bots' chat model (ARCHITECTURE.md §7.1)

    private func makeBotChat() -> BotChatModel {
        let model = BotChatModel()
        model.onReply = { [weak self] reply in
            self?.page.call("bots.lmReply", [reply])
        }
        model.onStatus = { [weak self] status in
            guard let self else { return }
            // (a reload sees it in window.LostCityNative.lm)
            self.installUserScripts(self.webView.configuration.userContentController)
            self.page.call("bots.lmStatus", [status])
        }
        return model
    }

    /// `{type:'lm-key', action}`: `set` opens the native secure box for the Claude key (the page never sees the key),
    /// `remove` deletes it from the Keychain. The page hears the outcome as a status (`LostCityHost.bots.lmStatus`).
    private func handleModelKey(_ action: String) {
        switch action {
        case "set":
            presentKeyAlert()
        case "remove":
            botChat.removeKey()
        default:
            Log.info("lm", "unknown lm-key action: \(action)")
        }
    }

    private func presentKeyAlert() {
        guard keyAlert == nil else { return }
        let alert = UIAlertController(
            title: "Claude API key",
            message: "Paste your key from platform.claude.com. It stays in this iPhone's Keychain, never in the game. While Claude online is on, the chat and the bot's state go to Anthropic.",
            preferredStyle: .alert)
        alert.addTextField { field in
            field.isSecureTextEntry = true
            field.placeholder = "sk-ant-…"
            field.autocorrectionType = .no
            field.autocapitalizationType = .none
            field.spellCheckingType = .no
            field.smartQuotesType = .no
            field.smartDashesType = .no
            field.smartInsertDeleteType = .no
            field.keyboardType = .asciiCapable
            field.keyboardAppearance = .dark
            field.clearButtonMode = .whileEditing
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            self?.keyAlertClosed(typed: nil)
        })
        let save = UIAlertAction(title: "Save", style: .default) { [weak self, weak alert] _ in
            self?.keyAlertClosed(typed: alert?.textFields?.first?.text ?? "")
        }
        alert.addAction(save)
        alert.preferredAction = save
        keyboard.yieldFirstResponder(true)  // (the bridge never gives up first responder otherwise)
        keyAlert = alert
        presentOnTop(alert)
    }

    private func keyAlertClosed(typed: String?) {
        keyAlert = nil
        keyboard.yieldFirstResponder(false)
        keyboard.activate()
        guard let typed else { return }
        if !botChat.setKey(typed) {
            botChat.keyProblem("not a key")
            playHaptic("error")
        }
    }

    private func presentOnTop(_ controller: UIViewController) {
        var top: UIViewController = self
        while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
        top.present(controller, animated: true)
    }

    // MARK: - Debug hooks for test pages (`{type:'debug', id, action, …}`; reply via `window.__lcDebugReply(id, value)`)

    #if DEBUG
    private func handleDebug(_ message: [String: Any]) {
        let id = message["id"] as? Int ?? 0
        var reply: Any = NSNull()
        switch message["action"] as? String {
        case "terminate":
            // The willTerminate path, in its worst case: called from a main-queue block, where a
            // nested run loop cannot run main-queue (MainActor) jobs. The flush must still finish.
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    let started = CACurrentMediaTime()
                    self.lifecycle.terminate()
                    let ms = (CACurrentMediaTime() - started) * 1000
                    Log.info("debug", "terminate() returned after \(Int(ms)) ms")
                    self.lifecycle.handle(.resume)
                    self.debugReply(id, ["ms": ms])
                }
            }
            return
        case "type":
            keyboard.debugType(message["text"] as? String ?? "")
        case "key":
            keyboard.debugHardwareKey(message["key"] as? String ?? "", down: message["down"] as? Bool ?? true)
        case "bar":
            keyboard.debugTapBar(message["button"] as? String ?? "submit")
        case "chip":
            reply = keyboard.debugTapChip(message["index"] as? Int ?? 0) ?? NSNull()
        case "paste":
            keyboard.debugPaste(message["text"] as? String ?? "")
        case "keyboard-state":
            reply = keyboard.debugState()
        case "idle-timer":
            reply = UIApplication.shared.isIdleTimerDisabled
        case "ui-state":
            reply = [
                "overlayShowing": overlay.isShowing,
                "overlayError": overlay.isShowingError,
                "overlayLayout": overlay.debugLayout,
                "presented": presentedViewController.map { String(describing: type(of: $0)) } ?? "",
            ]
        case "haptics":
            reply = haptics.debugTakePlayed()
        case "overlay":
            // The native loader or error screen over the running page, for screenshots: `loading`, `error`, `retry`
            // (taps "Try again", which reloads the page), `hide`.
            switch message["mode"] as? String {
            case "loading": overlay.show()
            case "error":
                overlay.showError(message["message"] as? String ?? "The game could not be loaded.") { [weak self] in
                    self?.loadGame(reason: "debug retry")
                }
            case "retry": overlay.debugTapRetry()
            default: overlay.hide()
            }
        case "memory-warning":
            NotificationCenter.default.post(name: UIApplication.didReceiveMemoryWarningNotification, object: UIApplication.shared)
        case "lifecycle":
            if let event = (message["event"] as? String).flatMap(LifecycleCoordinator.Event.init(rawValue:)) {
                lifecycle.handle(event)
            }
        case "settings":
            reply = settings.values
        case "reload":
            loadGame(reason: "debug reload")
        case "lm-status":
            reply = ["status": botChat.status, "counters": botChat.counters]
        case "lm-endpoint":
            // The online model's endpoint, for the tests' local mock server (never with a real key); none: the API's.
            let url = (message["url"] as? String).flatMap(URL.init(string:)) ?? OnlineModel.defaultEndpoint
            botChat.online.endpoint = url
            reply = url.absoluteString
        case "lm-key-alert":
            // The Claude key's secure box as the player would use it: the text typed in, then Save or Cancel.
            guard let alert = keyAlert, let field = alert.textFields?.first else {
                reply = ["shown": false]
                break
            }
            reply = ["shown": true, "secure": field.isSecureTextEntry, "title": alert.title ?? "",
                     "firstResponder": field.isFirstResponder]
            let save = message["button"] as? String != "cancel"
            field.text = message["text"] as? String ?? ""
            let typed = save ? field.text ?? "" : nil
            alert.dismiss(animated: false) { [weak self] in self?.keyAlertClosed(typed: typed) }
        case "activity":
            userActivity()  // (a long in-app test keeps the screen awake)
        default:
            Log.info("debug", "unknown debug action: \(message)")
        }
        debugReply(id, reply)
    }

    private func debugReply(_ id: Int, _ value: Any) {
        webView.callAsyncJavaScript("window.__lcDebugReply?.(id, value);", arguments: ["id": id, "value": value], in: nil, in: .page)
    }

    /// `{type:'lm-bench', id, action, …}` (DEBUG builds; the phone spike: web/test/autotest.js lm-bench, app-test.mjs
    /// --lm-bench): `generate` {system, user, think?, timeoutMs} runs the on-device model directly and answers the line,
    /// its timings and its note (`think`: the note first, as a request's Think first; app-test --lm-think); `stats` answers
    /// the app's memory (phys_footprint, os_proc_available_memory), the thermal state, the model's state and note support
    /// (`think`), its last load (total, model, context ms) and the WebContent terminations since launch; `options`
    /// {threads, gpuLayers} applies to the next load (the model is unloaded), {idleSec} sets the idle unload; `unload`.
    /// Replies through `window.__lcDebugReply(id, value)`.
    private func handleModelBench(_ message: [String: Any]) {
        let id = message["id"] as? Int ?? 0
        let local = botChat.local
        switch message["action"] as? String {
        case "generate":
            let timeoutMs = (message["timeoutMs"] as? NSNumber)?.intValue ?? BotChatModel.defaultTimeoutMs
            local.generate(system: message["system"] as? String ?? "", user: message["user"] as? String ?? "",
                           think: message["think"] as? Bool ?? false, deadline: .now() + .milliseconds(timeoutMs)) { [weak self] result in
                switch result {
                case .success(let output):
                    var reply: [String: Any] = ["text": output.text, "timings": output.timings.dictionary]
                    if let note = output.note { reply["note"] = note }
                    self?.debugReply(id, reply)
                case .failure(let failure):
                    self?.debugReply(id, ["error": failure.description])
                }
            }
        case "stats":
            UIDevice.current.isBatteryMonitoringEnabled = true
            let battery: String = switch UIDevice.current.batteryState {
            case .charging: "charging"
            case .full: "full"
            case .unplugged: "unplugged"
            default: "unknown"
            }
            debugReply(id, [
                "battery": ["level": Double(UIDevice.current.batteryLevel), "state": battery],
                "footprintMB": Double(DeviceStats.physFootprint) / 1_048_576,
                "availableMB": Double(DeviceStats.availableMemory) / 1_048_576,
                "thermal": DeviceStats.thermalState,
                "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled,
                "loaded": local.isLoaded,
                "think": local.thinkSupport.rawValue,
                "queued": local.queued,
                "terminations": terminationCount,
                "options": ["threads": local.options.threads, "gpuLayers": local.options.gpuLayers, "idleSec": local.options.idleUnload],
                "lastLoad": local.lastLoad.map { $0 as Any } ?? NSNull(),
            ])
        case "options":
            var options = local.options
            if let threads = (message["threads"] as? NSNumber)?.int32Value {
                options.threads = threads
                options.batchThreads = threads
            }
            if let layers = (message["gpuLayers"] as? NSNumber)?.int32Value { options.gpuLayers = layers }
            if let idle = (message["idleSec"] as? NSNumber)?.doubleValue { options.idleUnload = idle }
            local.options = options
            if message["threads"] != nil || message["gpuLayers"] != nil {
                local.unload(reason: "bench options")
            }
            debugReply(id, ["threads": options.threads, "gpuLayers": options.gpuLayers, "idleSec": options.idleUnload])
        case "unload":
            local.unload(reason: "bench")
            debugReply(id, true)
        default:
            debugReply(id, NSNull())
        }
    }
    #endif

    // MARK: - Console bridge

    /// Forwards page console output and uncaught errors to the native log (`log` handler), so they
    /// appear in `devicectl … --console` without Web Inspector. Workers have no `webkit` object:
    /// they POST to `/log` or relay through the page.
    private static let consoleBridge = """
    (() => {
        const handler = window.webkit?.messageHandlers?.log;
        if (!handler || window.__lcConsoleBridge) return;
        window.__lcConsoleBridge = true;
        const format = (value) => {
            if (typeof value === 'string') return value;
            if (value instanceof Error) return value.stack || String(value);
            if (value !== null && typeof value === 'object') {
                try { return JSON.stringify(value); } catch { return String(value); }
            }
            return String(value);
        };
        const post = (level, args) => {
            try {
                let text = Array.prototype.map.call(args, format).join(' ');
                if (text.length > 16000) text = text.slice(0, 16000) + ' …(truncated)';
                handler.postMessage({ level, text });
            } catch {}
        };
        for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
            const original = console[level];
            console[level] = function (...args) { original.apply(console, args); post(level, args); };
        }
        addEventListener('error', (e) => post('error', [`Uncaught ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`, e.error?.stack ?? '']));
        addEventListener('unhandledrejection', (e) => post('error', ['Unhandled rejection:', e.reason?.stack ?? String(e.reason)]));
    })();
    """
}

// MARK: - Script messages

extension GameViewController: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "log":
            let body = message.body as? [String: Any]
            let level = body?["level"] as? String ?? "log"
            let text = body?["text"] as? String ?? String(describing: message.body)
            Log.write("[js:\(level)] \(text)")
        case "native":
            handleNativeMessage(message.body)
        default:
            break
        }
    }
}

// MARK: - Navigation

extension GameViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else { return .cancel }
        switch url.scheme?.lowercased() {
        case AssetSchemeHandler.scheme, "about", "blob", "data":
            return .allow
        case "http", "https", "mailto":
            // Everything the game needs is in the bundle; a link the player taps opens in Safari.
            if navigationAction.navigationType == .linkActivated {
                await UIApplication.shared.open(url)
            }
            return .cancel
        default:
            Log.info("host", "blocked navigation to \(url.absoluteString)")
            return .cancel
        }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        // A new document replaced the old one (including reloads the page did itself).
        resetPageState()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Log.info("host", "page loaded: \(webView.url?.absoluteString ?? "?")")
        disableZoomAndDrag(webView)
        // The page normally hides the cover by sending `ready`; never leave it up for good.
        overlayFallback?.cancel()
        overlayFallback = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled, let self, self.overlay.isShowing, !self.overlay.isShowingError else { return }
            Log.info("host", "no `ready` from the page 3 s after load; uncovering it")
            self.overlay.hide()
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        navigationFailed(navigation, error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        navigationFailed(navigation, error)
    }

    private func navigationFailed(_ navigation: WKNavigation?, _ error: any Error) {
        let nsError = error as NSError
        // Cancelled: superseded by another load (e.g. a quick restart), not a failure.
        guard !(nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled) else { return }
        // Any other navigation (e.g. one our policy cancelled: WebKit error 102) leaves the current
        // page running; only a failed game load leaves nothing on screen.
        guard let navigation, navigation === gameLoad else {
            Log.info("host", "navigation failed (page unaffected): \(nsError.domain) \(nsError.code) \(error.localizedDescription)")
            return
        }
        Log.info("host", "page failed to load: \(error)")
        overlay.showError("The game could not be loaded.\n\(error.localizedDescription)") { [weak self] in
            self?.loadGame(reason: "retry after load failure")
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        let now = Date()
        terminationCount += 1
        terminations = terminations.filter { now.timeIntervalSince($0) < 120 } + [now]
        let state = UIApplication.shared.applicationState
        Log.info("host", "WebContent process terminated (\(terminations.count)× in 2 min, app \(state == .background ? "in background" : "visible"))")
        resetPageState()
        overlayFallback?.cancel()
        if terminations.count >= 3 {
            // Crash loop (e.g. out of memory during boot): stop and let the player decide.
            overlay.showError("The game stopped unexpectedly \(terminations.count) times in a row.") { [weak self] in
                self?.terminations.removeAll()
                self?.loadGame(reason: "retry after repeated crashes")
            }
            return
        }
        if state == .background {
            reloadWhenActive = true
            return
        }
        // Player saves are written natively as they happen, so a fresh page resumes from them.
        Notice.show("The game stopped unexpectedly (probably out of memory) and is restarting.", in: view)
        loadGame(reason: "web content process terminated")
    }
}

// MARK: - UI delegate

extension GameViewController: WKUIDelegate {
    func webView(_ webView: WKWebView, contextMenuConfigurationFor elementInfo: WKContextMenuElementInfo) async -> UIContextMenuConfiguration? {
        nil
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            UIApplication.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        presentOnTop(alert)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        presentOnTop(alert)
    }

    func webView(_ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin,
                 initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
        .deny
    }
}

/// Breaks the retain cycle WKUserContentController would otherwise create with its handler.
private final class ScriptMessageProxy: NSObject, WKScriptMessageHandler {
    private weak var target: (any WKScriptMessageHandler)?

    init(_ target: any WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
