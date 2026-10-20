// GameActivity: the app's one activity, a window for the game session (ports SceneDelegate.swift, GameWindow.swift and
// the window half of GameViewController.swift; docs/ANDROID.md §1 Orientation and Back, §3.4).
//
// * Landscape (sensorLandscape), full screen under the display cutout (ALWAYS), edge to edge, the system bars hidden and
//   shown for a moment by a swipe (iOS: status bar hidden, home indicator auto-hidden, edges deferring system gestures).
//   The page lays out around env(safe-area-inset-*), which WebView 145 reports from the cutout.
// * The manifest's configChanges keep a rotation, a keyboard, a theme or a font change from recreating the activity; when
//   it is recreated anyway (Don't keep activities), the session's WebView is re-attached and the game never reloads.
// * Back does nothing (GameSession.back), as an iPhone has no Back; the activity never finishes on Back.
// * While in the world, both side edges are excluded from the back gesture (with the bars hidden
//   the system's 200 dp cap on excluded edges does not apply), so a camera drag from an edge is never taken for Back.
// * Lifecycle: onPause/onStop/onStart/onResume → the session (LifecycleCoordinator: pause, background, foreground,
//   resume); touches and keys keep the screen awake in the world (KeepAwake); onTrimMemory → a memory warning.
package io.github.purexyz.scape2004

import android.app.Dialog
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Rect
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlin.math.roundToInt

class GameActivity : ComponentActivity() {
    private val session: GameSession get() = (application as LostCityApp).session
    private lateinit var root: FrameLayout
    private var gameGestures = false

    /** How many gesture-exclusion rects are set (the debug `session` action). */
    var gestureExclusionCount = 0
        private set

    /** The class of a dialog this activity shows (the debug `ui-state` action's `presented`), else null. */
    var presentedDialog: String? = null
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.attributes = window.attributes.apply {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        }
        hideSystemBars()

        root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            layoutDirection = View.LAYOUT_DIRECTION_LTR // the game is 2004 English
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS // the login form is drawn, not a form
            addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> applyGestureExclusion() }
        }
        setContentView(root)

        applyIntent(intent)
        session.attach(this, root)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                session.back()
            }
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        applyIntent(intent)
    }

    /**
     * This activity shows the game. Not any more once a newer one has attached the session: an activity started with
     * FLAG_ACTIVITY_CLEAR_TASK (Android 17's PackageUpdateController relaunches the task this way when the app is updated
     * on screen, e.g. by deploy.sh; a launcher or notification can do the same) is created, started and resumed before
     * the old one's onStop and onDestroy. Those late calls are the old window's own business: passed on, the session
     * would think the app went to the background while the new activity is in front (the WebView paused, the sound
     * muted, the page stuck on its loader).
     */
    private val showsGame: Boolean get() = session.activity === this

    override fun onStart() {
        super.onStart()
        if (showsGame) session.activityStarted()
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars() // some phones show the bars again after a dialog or the keyboard
        if (showsGame) session.activityResumed()
    }

    override fun onPause() {
        if (showsGame) session.activityPaused()
        super.onPause()
    }

    override fun onStop() {
        if (showsGame) session.activityStopped() else Log.info("host", "an older activity stopped after a newer one took the game: ignored")
        super.onStop()
    }

    override fun onDestroy() {
        session.detach(this, finishing = isFinishing && !isChangingConfigurations)
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
        if (showsGame) session.windowFocusChanged(hasFocus) // (an older window losing focus is not the game's)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (showsGame) session.configurationChanged(newConfig)
    }

    /**
     * Every touch down and every key event the activity dispatches, a held key's repeats included (Activity's
     * dispatchKeyEvent calls it for each): iOS GameWindow.sendEvent. Typing on the software keyboard happens in the IME's
     * window; the keyboard track reports that itself.
     */
    override fun onUserInteraction() {
        super.onUserInteraction()
        session.userActivity()
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        session.trimMemory(level)
    }

    @Deprecated("Deprecated in Java")
    override fun onLowMemory() {
        @Suppress("DEPRECATION")
        super.onLowMemory()
        session.memoryWarning("low memory")
    }

    /** Remembers a dialog this activity shows, for the debug hooks (the bot chat track's key dialog). */
    fun presenting(dialog: Dialog?) {
        presentedDialog = dialog?.javaClass?.simpleName
    }

    /** In the world: both side edges belong to the game, not the back gesture. */
    fun setGameGestures(inWorld: Boolean) {
        if (gameGestures == inWorld) return
        gameGestures = inWorld
        if (::root.isInitialized) applyGestureExclusion()
    }

    private fun applyGestureExclusion() {
        val width = root.width
        val height = root.height
        val rects = if (gameGestures && width > 0 && height > 0) {
            val edge = (EDGE_DP * resources.displayMetrics.density).roundToInt()
            listOf(Rect(0, 0, edge, height), Rect(width - edge, 0, width, height))
        } else {
            emptyList()
        }
        if (rects.size == gestureExclusionCount && rects.isEmpty()) return
        root.systemGestureExclusionRects = rects
        gestureExclusionCount = rects.size
    }

    private fun hideSystemBars() {
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    /**
     * Launch switches, in DEBUG (debuggable) builds only: the activity is exported, so any app could send them, and a
     * release build takes none. `--ez lostcity.verbose true|false` (the verbose log, kept until false; iOS's
     * `-LostCityVerbose YES` launch argument only comes from Xcode), `--es lostcity.settings '<json>'` (merged into the
     * saved settings before the page loads; the tests start with known settings) and `--ei lostcity.webViewFloor <major>`
     * (a higher WebView floor, to see the error screen; a later intent changes it too, and the error screen checks again
     * when the app comes back to the front: a WebView updated meanwhile).
     */
    private fun applyIntent(intent: Intent?) {
        intent ?: return
        if (!BuildConfig.DEBUG) return
        if (intent.hasExtra(EXTRA_VERBOSE)) Log.setVerbose(this, intent.getBooleanExtra(EXTRA_VERBOSE, false))
        intent.getStringExtra(EXTRA_SETTINGS)?.let { json ->
            val merged = session.settings.merge(JsonText.parse(json))
            Log.info("debug", "settings from the launch intent ${if (merged) "merged" else "refused"}: $json")
            if (merged) session.refreshInfo()
        }
        if (intent.hasExtra(EXTRA_WEBVIEW_FLOOR)) {
            session.debugWebViewFloor = intent.getIntExtra(EXTRA_WEBVIEW_FLOOR, GameSession.MIN_WEBVIEW_MAJOR)
        }
    }

    private companion object {
        /** The width of each side edge kept from the back gesture in the world. */
        const val EDGE_DP = 48
        const val EXTRA_VERBOSE = "lostcity.verbose"
        const val EXTRA_SETTINGS = "lostcity.settings"
        const val EXTRA_WEBVIEW_FLOOR = "lostcity.webViewFloor"
    }
}
