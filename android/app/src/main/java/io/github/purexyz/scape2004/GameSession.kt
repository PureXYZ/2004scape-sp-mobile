// GameSession: the game, for the life of the process (ports GameViewController.swift; docs/ANDROID.md §3.1-3.4).
//
// It owns the WebView (on a MutableContextWrapper), the router, saves, settings, the page bridge, the lifecycle
// coordinator, keep-awake and the cover, and the native side of the page contract (ARCHITECTURE.md §7): the page's
// messages, status, fatal errors, settings, memory warnings, recovery from a renderer crash, and the debug hooks.
// GameActivity only binds a window to it: a recreated activity re-attaches the same WebView and the game is never
// reloaded (D5).
//
// Other tracks plug in as SessionComponents (keyboard, haptics, audio, cover, bot chat): they register the page messages
// they handle (`handle("keyboard") { … }`) and are called at the points GameViewController.swift calls them.
//
// Everything here runs on the UI thread, which never blocks waiting for the page: evaluateJavascript results and the
// page's messages arrive on it.
package io.github.purexyz.scape2004

import android.content.ActivityNotFoundException
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import android.content.MutableContextWrapper
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.webkit.WebView
import android.webkit.WebViewRenderProcess
import android.webkit.WebViewRenderProcessClient
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewFeature
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

class GameSession(private val app: LostCityApp) {
    private val scheduler: Scheduler = MainScheduler
    val saveStore: SaveStore = app.saveStore
    val settings = NativeSettings(NativeSettings.Prefs(app))
    private val router = AssetRouter(ApkAssets(app.assets), saveStore)
    val page = PageBridge(scheduler) {
        webView?.let { web -> PageBridge.JsEvaluator { script, result -> web.evaluateJavascript(script) { result(it) } } }
    }
    val lifecycle = LifecycleCoordinator({ path, args, completion -> page.call(path, args, completion = completion) }, scheduler)
    val keepAwake = KeepAwake(scheduler)
    val cover = CoverController().apply { margins = coverMargins() }

    /** The cover's view for an activity; the loading-cover track replaces the plain one. */
    var coverViewFactory: (Context) -> CoverView = { PlainCover(it) }

    /** The parts other tracks add (keyboard, haptics, audio, bot chat), called in this order. */
    val components = mutableListOf<SessionComponent>()
    private val messageHandlers = HashMap<String, (JsonObject) -> Unit>()
    private val debugActions = HashMap<String, (JsonObject, (JsonElement?) -> Unit) -> Unit>()
    private val unhandledSeen = HashSet<String>()

    /**
     * The bots' chat model's status (ARCHITECTURE.md §7.1), in `window.LostCityNative.lm`; the bot chat glue sets it
     * (which re-registers the document-start info, as iOS reinstalls its user scripts) and then calls
     * `bots.lmStatus`. Until then: no model in the app and no key, as an iOS build without a model reports.
     */
    var lmStatus: JsonObject = DEFAULT_LM_STATUS
        set(value) {
            field = value
            refreshInfo()
        }

    var webView: GameWebView? = null
        private set
    private var scripts: NativeScripts? = null

    /** The activity showing the game, if any. */
    var activity: GameActivity? = null
        private set

    /** That activity's root view (the WebView is its first child). */
    private var root: FrameLayout? = null
    private var coverView: CoverView? = null
    private var launched = false
    private var started = false
    private var resumed = false
    private var webViewPaused = false

    /** In the world (status `ingame`). */
    var inGame = false
        private set
    private val terminations = ArrayDeque<Long>()

    /** Renderer deaths since launch. */
    var terminationCount = 0
        private set
    private var reloadWhenActive = false
    /** reloadIfNeeded is waiting for the window's first frame (or REVEAL_FALLBACK_MS) before it loads. */
    private var reloadWaitingForDraw = false

    /** Counts documents, so an answer from a page that has gone since cannot uncover its successor's loader. */
    private var pageSerial = 0
    private var uncovering = false
    private var overlayFallback: Cancellable? = null

    /** The load started by loadGame is in flight: only its failure leaves the screen without a page. */
    private var gameLoadPending = false
    private var lastMemoryWarning = Long.MIN_VALUE / 2
    private var unresponsiveSince: Long? = null
    private var unresponsiveCheck: Cancellable? = null
    private val flushWaiters = ArrayList<() -> Unit>()

    /** DEBUG builds: a higher WebView floor from the launch intent, to see the error screen (lostcity.webViewFloor). */
    var debugWebViewFloor: Int? = null

    /** DEBUG builds: this many more WebViews fail to be made (the `webview-fail` action), to see the error screen. */
    private var debugWebViewFailures = 0

    /**
     * Why the game could not start (Android System WebView missing, disabled, too old or lacking a feature), while
     * native's error screen says so. The user can fix that outside the app (the Play Store, Settings › Apps) and come
     * back, so the screen's button and every return to the front check again (recheckStart).
     */
    private var startProblem: String? = null
    private var recheckWhenResumed = false

    /**
     * Input focus for a native text field (docs/ANDROID.md §4.1): the keyboard bridge holds focus for good, and a dialog
     * that needs the IME (the bot chat track's Claude key box) borrows it with `keyboardFocus?.lend()`, closing the
     * handle when it goes. Set by KeyboardBridge.install.
     */
    var keyboardFocus: KeyboardFocus? = null

    init {
        Shell.install(this, app) // haptics, sound and the loading cover (Shell.kt)
        LmComponent.install(this, app) // the bots' chat model (LmComponent.kt)
        KeyboardBridge.install(this) // the keyboard and its bar (docs/ANDROID.md §4.1)
        lifecycle.onFlushFinished = {
            val waiters = flushWaiters.toList()
            flushWaiters.clear()
            waiters.forEach { it() }
            pauseWebViewIfStopped()
        }
    }

    // ------------------------------------------------------------------------------------------------ components

    /** Routes the page's `{type: <type>}` messages to a component. */
    fun handle(type: String, handler: (JsonObject) -> Unit) {
        messageHandlers[type] = handler
    }

    /** A DEBUG build's `{type:'debug', action: <action>}`; `reply` answers through window.__lcDebugReply. */
    fun debugAction(action: String, handler: (message: JsonObject, reply: (JsonElement?) -> Unit) -> Unit) {
        debugActions[action] = handler
    }

    // ------------------------------------------------------------------------------------------------ activity

    /** A (new) activity shows the game: the WebView, the components' views and the cover go into its `root`. */
    fun attach(activity: GameActivity, root: FrameLayout) {
        this.activity?.let { previous -> if (previous !== activity) detach(previous, finishing = false) }
        this.activity = activity
        this.root = root
        var problem: String? = null
        if (!launched) {
            Log.info("host", "starting the game session")
            problem = webViewProblem() ?: missingFeature()
                ?: if (createWebView(activity) == null) NO_WEBVIEW else null
        }
        webView?.let { web ->
            (web.parent as? ViewGroup)?.removeView(web)
            web.wrapper.baseContext = activity
            root.addView(web, 0, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        }
        for (component in components) component.attach(activity, root)
        val view = coverViewFactory(activity)
        root.addView(view.view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        coverView = view
        cover.attach(view)
        keepAwake.attach(activity.window)
        activity.setGameGestures(inGame)
        if (!launched) {
            launched = true
            if (problem != null) showWebViewProblem(problem) else loadGame("launch")
        } else {
            Log.info("host", "activity re-attached; the page keeps running")
        }
    }

    /** The activity goes away. A finishing one (not a configuration change) is iOS's willTerminate, best effort. */
    fun detach(activity: GameActivity, finishing: Boolean) {
        if (this.activity !== activity) return // a newer activity has the game already
        if (finishing) {
            Log.info("app", "will terminate")
            lifecycle.handle(LifecycleCoordinator.Event.TERMINATE)
            Log.flush()
        }
        Log.info("host", "activity detached${if (finishing) " (finishing)" else ""}; the page keeps running")
        for (component in components) component.detach(activity)
        keepAwake.detach()
        coverView?.let { view ->
            cover.detach(view)
            (view.view.parent as? ViewGroup)?.removeView(view.view)
        }
        coverView = null
        webView?.let { web ->
            (web.parent as? ViewGroup)?.removeView(web)
            web.wrapper.baseContext = app // the WebView must not keep the old activity alive
        }
        this.activity = null
        this.root = null
    }

    fun activityStarted() {
        started = true
        resumeWebView() // before `foreground`: the page's engine request has a setTimeout
        for (component in components) component.start()
        lifecycle.handle(LifecycleCoordinator.Event.FOREGROUND)
    }

    fun activityResumed() {
        resumed = true
        lifecycle.handle(LifecycleCoordinator.Event.RESUME)
        for (component in components) component.resume()
        reloadIfNeeded()
        if (recheckWhenResumed) {
            recheckWhenResumed = false
            if (startProblem != null) recheckStart("the WebView passed its check again")?.let(::showWebViewProblem)
        }
    }

    fun activityPaused() {
        resumed = false
        recheckWhenResumed = startProblem != null // (back from the Play Store or Settings: check again)
        for (component in components) component.pause()
        lifecycle.handle(LifecycleCoordinator.Event.PAUSE)
    }

    fun activityStopped() {
        started = false
        lifecycle.handle(LifecycleCoordinator.Event.BACKGROUND)
        for (component in components) component.stop()
        Log.flush()
        if (!lifecycle.isFlushing) pauseWebViewIfStopped() // else when the flush ends (onFlushFinished)
    }

    fun windowFocusChanged(hasFocus: Boolean) {
        for (component in components) component.windowFocusChanged(hasFocus)
    }

    fun configurationChanged(configuration: android.content.res.Configuration) {
        Log.debug("host") { "configuration changed: orientation ${configuration.orientation}, ${configuration.screenWidthDp}×${configuration.screenHeightDp} dp" }
        for (component in components) component.configurationChanged(configuration)
    }

    /** A touch, key or keystroke (keep-awake). */
    fun userActivity() {
        keepAwake.userActivity()
    }

    /**
     * Back (docs/ANDROID.md §1 Back) does nothing, as an iPhone has no Back: a swipe from the edge while playing must
     * not close the bank or the chat. GameActivity consumes it, so the activity never finishes on Back. (The IME and
     * dialogs take Back themselves before it gets here.)
     */
    fun back() {
        userActivity()
        Log.info("host", "back: ignored")
    }

    /**
     * onTrimMemory: a memory warning for RUNNING_LOW/CRITICAL (only below API 34) and BACKGROUND or worse; UI_HIDDEN is
     * onStop's business. At most one per 10 s: since API 34 a phone under pressure in the foreground gets no warning at
     * all before the renderer is killed, and the renderer-gone path is the real safety net.
     */
    fun trimMemory(level: Int) {
        @Suppress("DEPRECATION")
        val warn = level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND ||
            level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW || level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL
        if (warn) memoryWarning("level $level") else Log.debug("host") { "trim memory level $level" }
    }

    fun memoryWarning(source: String, force: Boolean = false) {
        val now = scheduler.now()
        if (!force && now - lastMemoryWarning < MEMORY_WARNING_EVERY_MS) {
            Log.debug("host") { "memory warning ($source) within 10 s of the last: not passed on" }
            return
        }
        lastMemoryWarning = now
        Log.info("host", "memory warning ($source)")
        for (component in components) component.memoryWarning()
        page.call("memoryWarning") { outcome -> Log.info("host", "memoryWarning → ${outcome.description}") }
    }

    /** A haptic that native starts itself (a fatal error, a refused key), unless Settings › Vibration is off. */
    fun playHaptic(style: String) {
        if (settings.values.bool("haptics") == false) return
        val handler = messageHandlers["haptic"]
        if (handler != null) handler(buildJsonObject { put("type", JsonPrimitive("haptic")); put("style", JsonPrimitive(style)) })
        else Log.debug("haptic") { "$style (no haptics component)" }
    }

    /** Opens an http(s) or mailto link outside the app (a link the player tapped). */
    fun openExternally(uri: Uri) {
        val context = activity ?: return
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            Log.info("host", "nothing can open $uri")
        }
    }

    // ------------------------------------------------------------------------------------------------ the WebView

    private fun createWebView(context: Context): GameWebView? {
        if (BuildConfig.DEBUG && debugWebViewFailures > 0) {
            debugWebViewFailures -= 1
            Log.info("host", "the WebView could not be created: (debug webview-fail)")
            return null
        }
        val web = try {
            GameWebView.create(MutableContextWrapper(context))
        } catch (error: Throwable) {
            Log.info("host", "the WebView could not be created: $error")
            return null
        }
        val scripts = try {
            NativeScripts(web, ::handleBridgeMessage).also { it.install() }
        } catch (error: Throwable) {
            Log.info("host", "the WebView's scripts could not be installed: $error")
            web.destroy()
            return null
        }
        web.webViewClient = GameWebViewClient(this, router)
        web.webChromeClient = GameChromeClient(this)
        web.setWebViewRenderProcessClient(app.mainExecutor, renderProcessClient)
        this.webView = web
        this.scripts = scripts
        refreshInfo()
        return web
    }

    /** The WebView's renderer died: the WebView cannot be used again, so a new one takes its place in the view tree. */
    private fun replaceWebView() {
        val old = webView ?: return
        val parent = old.parent as? ViewGroup
        val index = parent?.indexOfChild(old) ?: 0
        parent?.removeView(old)
        webView = null
        scripts = null
        try {
            old.destroy()
        } catch (error: Throwable) {
            Log.info("host", "destroying the dead WebView failed: $error")
        }
        val fresh = createWebView(activity ?: app) ?: return
        parent?.addView(fresh, index, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    }

    /**
     * No new WebView could be made after a renderer death: the error screen's Try again makes one again, in the activity
     * showing the game (a recreated activity only re-attaches the WebView there is), and loads the game in it; if it still
     * cannot be made, the screen stays.
     */
    private fun showNoWebView() {
        cover.showError(NO_WEBVIEW) {
            if (!restartWebView("retry after the WebView could not be made")) showNoWebView()
        }
    }

    /** Makes a WebView where there is none, puts it under everything in the activity's root and loads the game in it. */
    private fun restartWebView(reason: String): Boolean {
        val activity = activity ?: return false
        val web = webView ?: createWebView(activity) ?: return false
        if (web.parent == null) {
            root?.addView(web, 0, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        }
        loadGame(reason)
        return true
    }

    /**
     * The installed WebView is missing or below the floor (the engine's iterator helpers need Chrome 122). The version is
     * the provider package's versionName, which is the Chromium version for Google's providers: the standalone or
     * Trichrome WebView (com.google.android.webview and its beta/dev/canary, the only kinds from Android 10, below our
     * minSdk 30) and Chrome as the provider (Android 7-9) all take it from Chromium's VERSION file (on the AVD:
     * 145.0.7632.218 = navigator.userAgentData's full Chromium version; the reduced user agent says only 145.0.0.0).
     */
    private fun webViewProblem(): String? {
        val version = AppInfo.webViewVersion ?: return NO_WEBVIEW
        val major = version.substringBefore('.').toIntOrNull() ?: 0
        val floor = debugWebViewFloor ?: MIN_WEBVIEW_MAJOR
        return if (major < floor) "Android System WebView is too old ($version). Update it from the Play Store." else null
    }

    /** The WebView lacks what the bridge is built on (document-start scripts, WebMessageListener). */
    private fun missingFeature(): String? {
        val missing = try {
            GameWebView.requiredFeatures.filterNot { WebViewFeature.isFeatureSupported(it) }
        } catch (error: Throwable) {
            Log.info("host", "the WebView's features could not be read: $error")
            return NO_WEBVIEW
        }
        if (missing.isEmpty()) return null
        Log.info("host", "the WebView lacks ${missing.joinToString()}")
        return "Android System WebView is too old (${AppInfo.webViewVersion ?: "?"}). Update it from the Play Store."
    }

    private fun showWebViewProblem(problem: String) {
        Log.info("host", "cannot start: $problem")
        startProblem = problem
        cover.showError(problem, "Update") {
            // (updated or enabled meanwhile, the app still in front: the game starts instead)
            val still = recheckStart("the WebView passed its check again") ?: return@showError
            val store = Uri.parse("market://details?id=$WEBVIEW_PACKAGE")
            try {
                activity?.startActivity(Intent(Intent.ACTION_VIEW, store))
            } catch (_: ActivityNotFoundException) {
                openExternally(Uri.parse("https://play.google.com/store/apps/details?id=$WEBVIEW_PACKAGE"))
            }
            showWebViewProblem(still) // (the button works again when the player comes back)
        }
    }

    /**
     * Checks the WebView again after the game could not start; when it passes now, makes the WebView in the activity
     * showing the game and loads the game. The problem that remains, or null when the game is starting.
     */
    private fun recheckStart(reason: String): String? {
        val problem = webViewProblem() ?: missingFeature() ?: if (restartWebView(reason)) null else NO_WEBVIEW
        startProblem = problem
        return problem
    }

    private val renderProcessClient = object : WebViewRenderProcessClient() {
        override fun onRenderProcessUnresponsive(view: WebView, renderer: WebViewRenderProcess?) {
            if (view !== webView || unresponsiveSince != null) return
            unresponsiveSince = scheduler.now()
            Log.info("host", "renderer unresponsive")
            unresponsiveCheck = scheduler.postDelayed(UNRESPONSIVE_KILL_MS) {
                if (unresponsiveSince == null || view !== webView) return@postDelayed
                if (!resumed) {
                    Log.info("host", "renderer still unresponsive after ${UNRESPONSIVE_KILL_MS / 1000} s (app not in front: left alone)")
                    return@postDelayed
                }
                Log.info("host", "renderer still unresponsive after ${UNRESPONSIVE_KILL_MS / 1000} s: ending it")
                view.webViewRenderProcess?.terminate() // → onRenderProcessGone → a new WebView and a reload
            }
        }

        override fun onRenderProcessResponsive(view: WebView, renderer: WebViewRenderProcess?) {
            val since = unresponsiveSince ?: return
            unresponsiveSince = null
            unresponsiveCheck?.cancel()
            unresponsiveCheck = null
            Log.info("host", "renderer responsive again after ${scheduler.now() - since} ms")
        }
    }

    private fun pauseWebViewIfStopped() {
        val web = webView ?: return
        if (started || webViewPaused || lifecycle.isFlushing) return
        webViewPaused = true
        web.onPause()
        web.pauseTimers() // (process-wide: every WebView's timers, layout and parsing)
        Log.info("host", "web view paused (timers stopped) while in the background")
    }

    private fun resumeWebView() {
        if (!webViewPaused) return
        webViewPaused = false
        webView?.let { web ->
            web.resumeTimers()
            web.onResume()
        }
        Log.info("host", "web view resumed")
    }

    // ------------------------------------------------------------------------------------------------ loading

    fun loadGame(reason: String) {
        val web = webView ?: return
        Log.info("host", "loading ${AssetRouter.INDEX_URL} ($reason)")
        resetPageState()
        cover.show()
        overlayFallback?.cancel()
        overlayFallback = null
        gameLoadPending = true
        web.loadUrl(AssetRouter.INDEX_URL)
    }

    /** Native state that belongs to the page that is going away. */
    private fun resetPageState() {
        for (component in components) component.pageReset()
        lifecycle.reset()
        setInGame(false)
        pageSerial += 1
        uncovering = false
        page.reset("page reset")
        flushWaiters.clear()
    }

    private fun setInGame(inGame: Boolean) {
        this.inGame = inGame
        keepAwake.setInGame(inGame)
        activity?.setGameGestures(inGame)
    }

    /** A new document replaced the old one (iOS didCommit), also a reload the page made itself (Saved data). */
    fun pageStarted(url: String) {
        Log.debug("host") { "page started: $url" }
        resetPageState()
    }

    fun pageFinished(url: String) {
        Log.info("host", "page loaded: $url")
        gameLoadPending = false
        // The page normally hides the cover by sending `ready`; never leave it up for good.
        overlayFallback?.cancel()
        overlayFallback = scheduler.postDelayed(OVERLAY_FALLBACK_MS) {
            if (cover.isShowing && !cover.isShowingError) {
                Log.info("host", "no `ready` from the page 3 s after load; uncovering it")
                cover.hide()
            }
        }
    }

    /** The main-frame request is loadGame's (only its failure leaves the screen without a page). */
    fun isGameLoad(uri: Uri): Boolean = gameLoadPending && GameWebViewClient.withoutQuery(uri) == AssetRouter.INDEX_URL

    fun gameLoadFailed(description: String) {
        gameLoadPending = false
        Log.info("host", "page failed to load: $description")
        overlayFallback?.cancel()
        cover.showError("The game could not be loaded.\n$description") { loadGame("retry after load failure") }
    }

    /**
     * The page is up (`ready`, or any status): the cover goes once the page has drawn its own, identical loader (its fonts
     * loaded, its logo decoded, two frames later; 0.8 s at most), so the hand-over never shows a half-drawn loader.
     */
    private fun uncover() {
        if (!cover.isShowing || cover.isShowingError || uncovering) return
        if ("loader-drawn" in messageHandlers) return // the page posts {type:'loader-drawn'} itself (the cover's component)
        uncovering = true
        val serial = pageSerial
        page.run(NativeScripts.LOADER_DRAWN, timeoutMs = 3_000) {
            if (pageSerial != serial) return@run
            uncovering = false
            if (!cover.isShowingError) cover.hide()
        }
    }

    /**
     * The renderer died (iOS: the WebContent process terminated). Saves are written natively as they happen, so a fresh
     * page resumes from them. Three times in two minutes is a crash loop: stop and let the player decide.
     */
    fun rendererGone(view: WebView, crashed: Boolean, priority: Int) {
        if (view !== webView) {
            Log.info("host", "a replaced WebView's renderer is gone (crash=$crashed)")
            return
        }
        val now = scheduler.now()
        terminationCount += 1
        while (terminations.isNotEmpty() && now - terminations.first() >= CRASH_WINDOW_MS) terminations.removeFirst()
        terminations.addLast(now)
        val visible = started && activity != null
        Log.info("host", "WebView renderer gone (crash=$crashed, priority=$priority, ${terminations.size}× in 2 min, app ${if (visible) "visible" else "in background"})")
        unresponsiveSince = null
        unresponsiveCheck?.cancel()
        replaceWebView()
        resetPageState()
        overlayFallback?.cancel()
        if (webView == null) {
            showNoWebView()
            return
        }
        if (terminations.size >= 3) {
            cover.showError("The game stopped unexpectedly ${terminations.size} times in a row.") {
                terminations.clear()
                loadGame("retry after repeated crashes")
            }
            return
        }
        if (!visible) {
            reloadWhenActive = true
            return
        }
        cover.notice("The game stopped unexpectedly (probably out of memory) and is restarting.")
        loadGame("web content process terminated")
    }

    /** The renderer died while the app was in the background: restart the page now that it is visible. */
    private fun reloadIfNeeded() {
        if (!reloadWhenActive) return
        // onResume comes before Android shows the window again: its visibility reaches the views in the next
        // traversal, and Chromium takes the page's visibility from it (onWindowVisibilityChanged; View.isShown only
        // reads view flags, which stay visible while the activity is stopped). A page loaded now would boot hidden:
        // document.visibilityState 'hidden' and no animation frames until then. iOS reloads on didBecomeActive, with
        // the window on screen; here the load waits for a draw with the window visible, or REVEAL_FALLBACK_MS at the
        // latest (a WebView that never draws still gets its page).
        val web = webView
        if (web != null && web.windowVisibility != View.VISIBLE) {
            if (reloadWaitingForDraw) return
            reloadWaitingForDraw = true
            var fallback: Cancellable? = null
            val listener = object : ViewTreeObserver.OnPreDrawListener {
                override fun onPreDraw(): Boolean {
                    if (web.windowVisibility == View.VISIBLE) revealed()
                    return true
                }

                fun revealed() {
                    if (!reloadWaitingForDraw) return
                    reloadWaitingForDraw = false
                    fallback?.cancel()
                    if (web.viewTreeObserver.isAlive) web.viewTreeObserver.removeOnPreDrawListener(this)
                    if (resumed && web === webView) reloadIfNeeded()
                }
            }
            web.viewTreeObserver.addOnPreDrawListener(listener)
            fallback = scheduler.postDelayed(REVEAL_FALLBACK_MS) { listener.revealed() }
            return
        }
        reloadWhenActive = false
        cover.notice("2004Scape was closed by Android while in the background and is restarting.")
        loadGame("web content ended while in the background")
    }

    /** The cover's margins: Settings › Display's, as the page lays out its own. */
    private fun coverMargins() = CoverMargins(
        settings.values.double("safeSides") ?: 0.0,
        settings.values.double("safeTop") ?: 0.0,
        settings.values.double("safeBottom") ?: 0.0,
    )

    /** (Re)registers `window.LostCityNative` for the next document: settings and the chat model's status. */
    fun refreshInfo() {
        val scripts = scripts ?: return
        val json = try {
            JsonText.canonical(AppInfo.pageInfo(app, settings.values, lmStatus))
        } catch (error: Exception) {
            Log.info("host", "LostCityNative could not be encoded: $error")
            "{\"platform\":\"android\",\"settings\":{}}"
        }
        scripts.setInfo(json)
    }

    // ------------------------------------------------------------------------------------------------ page → native

    /** A message on the lcAndroid listener: {ch: 'native'|'log', msg} or {ch: 'reply', id, ok, value|error}. */
    private fun handleBridgeMessage(message: JsonObject) {
        when (message.string("ch")) {
            "native" -> handleNativeMessage(message["msg"])
            "log" -> {
                val body = message["msg"] as? JsonObject
                val level = body?.string("level") ?: "log"
                val text = body?.string("text") ?: message["msg"].display()
                Log.write("[js:$level] $text")
            }
            "reply" -> page.onReply(message)
            else -> Log.info("host", "ignored bridge message: ${JsonText.canonical(message).take(200)}")
        }
    }

    private fun handleNativeMessage(body: JsonElement?) {
        val message = body as? JsonObject
        val type = message?.string("type")
        if (message == null || type == null) {
            Log.info("host", "ignored malformed native message: ${body.display()}")
            return
        }
        when (type) {
            "ready" -> {
                Log.info("host", "page ready")
                uncover()
                for (component in components) component.pageReady()
            }
            "status" -> handleStatus(message.string("phase") ?: "?", message["detail"])
            "settings" -> if (settings.merge(message["values"])) {
                refreshInfo()
                Log.info("host", "settings saved (${settings.values.keys.sorted().joinToString(", ")})")
                cover.margins = coverMargins()
                for (component in components) component.settingsChanged(settings.values)
            } else {
                Log.info("host", "settings rejected: values must be a JSON object under 64 KB")
            }
            "fatal" -> pageFailed(message.string("message") ?: "Unknown error")
            "debug" -> if (BuildConfig.DEBUG) handleDebug(message) else Log.info("host", "unhandled native message: debug")
            else -> {
                val handler = messageHandlers[type]
                when {
                    handler != null -> handler(message)
                    type in COMPONENT_MESSAGES -> if (unhandledSeen.add(type)) {
                        Log.info("host", "'$type' messages are not handled in this build yet (no component): ignored")
                    } else {
                        Log.debug("host") { "ignored '$type' message" }
                    }
                    else -> Log.info("host", "unhandled native message: $type")
                }
            }
        }
    }

    private fun handleStatus(phase: String, detail: JsonElement?) {
        val detailText = if (detail == null || detail is JsonNull) "" else " — ${detail.display()}"
        Log.info("host", "status $phase$detailText")
        uncover()
        setInGame(phase == "ingame")
        for (component in components) component.status(phase)
    }

    /**
     * `{type:'fatal'}`: the page shows its own 2004 error screen, with Restart, so native adds no second error UI. It
     * records the failure, plays the error haptic (unless Vibration is off), lets the screen sleep, and gets the keyboard
     * (and a cover still up after a failure before `ready`) out of the way of the page's screen.
     */
    private fun pageFailed(message: String) {
        Log.info("host", "FATAL (the page shows it): $message")
        playHaptic("error")
        setInGame(false)
        for (component in components) component.fatal()
        if (cover.isShowing && !cover.isShowingError) {
            overlayFallback?.cancel()
            cover.hide()
        }
    }

    // ------------------------------------------------------------------------------------------------ debug hooks

    /**
     * Test pages' `{type:'debug', id, action, …}` (DEBUG builds only; replies through `window.__lcDebugReply(id, value)`).
     * iOS's actions with Android meanings, plus Android's own (back, renderer-kill, renderer-crash, webview-fail, recreate,
     * trim, config, webview, insets, session). Components register theirs (keyboard, haptics, overlay, lm-*) with debugAction().
     */
    private fun handleDebug(message: JsonObject) {
        val id = message.long("id") ?: 0
        val reply = { value: JsonElement? -> debugReply(id, value) }
        val action = message.string("action")
        debugActions[action]?.let { handler ->
            handler(message, reply)
            return
        }
        when (action) {
            "terminate" -> {
                val begun = scheduler.now()
                lifecycle.handle(LifecycleCoordinator.Event.TERMINATE)
                whenFlushSettled {
                    val ms = scheduler.now() - begun
                    Log.info("debug", "terminate settled after $ms ms")
                    lifecycle.handle(LifecycleCoordinator.Event.RESUME)
                    reply(buildJsonObject { put("ms", JsonPrimitive(ms)) })
                }
            }
            "idle-timer" -> reply(JsonPrimitive(keepAwake.isOn))
            "ui-state" -> reply(buildJsonObject {
                put("overlayShowing", JsonPrimitive(cover.isShowing))
                put("overlayError", JsonPrimitive(cover.isShowingError))
                put("overlayLayout", coverView?.debugLayout ?: JsonNull)
                put("presented", JsonPrimitive(activity?.presentedDialog ?: ""))
            })
            "overlay" -> {
                when (message.string("mode")) {
                    "loading" -> cover.show()
                    "error" -> cover.showError(message.string("message") ?: "The game could not be loaded.") { loadGame("debug retry") }
                    "retry" -> (cover.state as? CoverState.Error)?.action?.invoke()
                    else -> cover.hide()
                }
                reply(JsonNull)
            }
            "memory-warning" -> {
                memoryWarning("debug", force = true)
                reply(JsonNull)
            }
            "trim" -> {
                trimMemory(message.long("level")?.toInt() ?: ComponentCallbacks2.TRIM_MEMORY_BACKGROUND)
                reply(JsonNull)
            }
            "lifecycle" -> {
                LifecycleCoordinator.Event.of(message.string("event"))?.let(lifecycle::handle)
                reply(JsonNull)
            }
            "settings" -> reply(settings.values)
            "reload" -> {
                reply(JsonNull)
                loadGame("debug reload")
            }
            "activity" -> {
                userActivity()
                reply(JsonNull)
            }
            "back" -> {
                back()
                reply(JsonNull)
            }
            "renderer-kill" -> {
                val renderer = webView?.webViewRenderProcess
                Log.info("debug", "ending the renderer (${if (renderer != null) "it will be replaced" else "none"})")
                reply(JsonPrimitive(renderer != null))
                // (after the reply has reached the page: the page goes with its renderer)
                scheduler.postDelayed(500) { renderer?.terminate() }
            }
            "renderer-crash" -> {
                // a real renderer crash (onRenderProcessGone with didCrash true), as iOS's tests SIGKILL WebContent: the
                // AVD has no root to kill the isolated renderer process, and renderer-kill's terminate() is not a crash
                val alive = webView?.webViewRenderProcess != null
                Log.info("debug", "crashing the renderer (chrome://crash)")
                reply(JsonPrimitive(alive))
                scheduler.postDelayed(500) { webView?.loadUrl("chrome://crash") }
            }
            "recreate" -> {
                // a new activity in place of this one, as "Don't keep activities" or an unhandled change would make
                reply(JsonNull)
                scheduler.postDelayed(200) { activity?.recreate() }
            }
            "webview-fail" -> {
                // the next WebViews fail to be made (with renderer-kill: the screen after a renderer death)
                debugWebViewFailures = message.long("count")?.toInt() ?: 1
                reply(JsonNull)
            }
            "config" -> reply(configuration())
            "webview" -> reply(buildJsonObject {
                put("version", JsonPrimitive(AppInfo.webViewVersion ?: "none"))
                put("features", buildJsonObject {
                    for ((name, feature) in DEBUG_FEATURES) put(name, JsonPrimitive(WebViewFeature.isFeatureSupported(feature)))
                })
            })
            "insets" -> reply(insets())
            "session" -> reply(buildJsonObject {
                put("pageSerial", JsonPrimitive(pageSerial))
                put("inGame", JsonPrimitive(inGame))
                put("terminations", JsonPrimitive(terminationCount))
                put("lifecycle", JsonPrimitive(lifecycle.stateDescription))
                put("keepAwake", JsonPrimitive(keepAwake.isOn))
                put("webViewPaused", JsonPrimitive(webViewPaused))
                put("started", JsonPrimitive(started))
                put("resumed", JsonPrimitive(resumed))
                put("gestureExclusion", JsonPrimitive(activity?.gestureExclusionCount ?: 0))
                put("components", JsonPrimitive(components.size))
            })
            else -> {
                Log.info("debug", "unknown debug action: ${JsonText.canonical(message).take(300)}")
                reply(JsonNull)
            }
        }
    }

    private fun whenFlushSettled(action: () -> Unit) {
        if (lifecycle.isFlushing) flushWaiters.add(action) else action()
    }

    private fun debugReply(id: Long, value: JsonElement?) {
        webView?.evaluateJavascript("window.__lcDebugReply?.($id, ${(value ?: JsonNull)});", null)
    }

    private fun configuration(): JsonObject {
        val config = (activity ?: app).resources.configuration
        val rotation = activity?.display?.rotation ?: -1
        return buildJsonObject {
            put("orientation", JsonPrimitive(config.orientation))
            put("rotation", JsonPrimitive(rotation))
            put("keyboard", JsonPrimitive(config.keyboard))
            put("hardKeyboardHidden", JsonPrimitive(config.hardKeyboardHidden))
            put("densityDpi", JsonPrimitive(config.densityDpi))
            put("screenWidthDp", JsonPrimitive(config.screenWidthDp))
            put("screenHeightDp", JsonPrimitive(config.screenHeightDp))
        }
    }

    /** The window's insets in dp (cutout, system gestures, system bars, IME). */
    private fun insets(): JsonObject {
        val root = activity?.window?.decorView ?: return buildJsonObject {}
        val insets = ViewCompat.getRootWindowInsets(root) ?: return buildJsonObject {}
        val density = root.resources.displayMetrics.density
        fun edges(type: Int) = buildJsonObject {
            val i = insets.getInsets(type)
            put("top", JsonPrimitive(i.top / density))
            put("right", JsonPrimitive(i.right / density))
            put("bottom", JsonPrimitive(i.bottom / density))
            put("left", JsonPrimitive(i.left / density))
        }
        return buildJsonObject {
            put("cutout", edges(WindowInsetsCompat.Type.displayCutout()))
            put("gestures", edges(WindowInsetsCompat.Type.mandatorySystemGestures()))
            put("bars", edges(WindowInsetsCompat.Type.systemBars()))
            put("ime", edges(WindowInsetsCompat.Type.ime()))
        }
    }

    companion object {
        /** The engine's iterator helpers need Chrome 122. */
        const val MIN_WEBVIEW_MAJOR = 122
        const val WEBVIEW_PACKAGE = "com.google.android.webview"
        const val NO_WEBVIEW = "Android System WebView is missing or disabled."
        const val OVERLAY_FALLBACK_MS = 3_000L
        const val REVEAL_FALLBACK_MS = 1_500L
        const val CRASH_WINDOW_MS = 120_000L
        const val MEMORY_WARNING_EVERY_MS = 10_000L
        const val UNRESPONSIVE_KILL_MS = 20_000L

        /** Page messages other tracks' components handle (logged once and ignored until one is registered). */
        val COMPONENT_MESSAGES = setOf("keyboard", "haptic", "lm", "lm-key", "lm-warm", "lm-bench", "loader-drawn", "gesture-exclusion")

        /** No model in the app, no key: what an iOS build without a model reports (ARCHITECTURE.md §7.1). */
        val DEFAULT_LM_STATUS: JsonObject = buildJsonObject {
            put("local", buildJsonObject {
                put("available", JsonPrimitive(false))
                put("loaded", JsonPrimitive(false))
                put("think", JsonPrimitive("never"))
                put("reason", JsonPrimitive("no-model"))
            })
            put("online", buildJsonObject {
                put("keySet", JsonPrimitive(false))
                put("model", JsonPrimitive("claude-haiku-5-5"))
            })
        }

        private val DEBUG_FEATURES = listOf(
            "DOCUMENT_START_SCRIPT" to WebViewFeature.DOCUMENT_START_SCRIPT,
            "WEB_MESSAGE_LISTENER" to WebViewFeature.WEB_MESSAGE_LISTENER,
            "WEB_MESSAGE_ARRAY_BUFFER" to WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER,
            "MUTE_AUDIO" to WebViewFeature.MUTE_AUDIO,
            "ALGORITHMIC_DARKENING" to WebViewFeature.ALGORITHMIC_DARKENING,
        )
    }
}
