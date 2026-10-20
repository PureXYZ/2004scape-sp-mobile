// KeepAwake: the screen stays on while someone is playing (ports the keep-awake half of GameViewController.swift and
// GameWindow.swift). iOS disables the idle timer; Android sets FLAG_KEEP_SCREEN_ON on the
// activity's window.
//
// In the world (status `ingame`) the screen is kept on while there was a touch, a key press or a keystroke in the last 5
// minutes (GameActivity.onUserInteraction / dispatchKeyEvent report them), so a phone put down mid-session still turns
// its screen off, which pauses the world and saves, like leaving the app. Any other phase, a fatal error and every page
// reset let it sleep. A 30 s timer re-checks while an activity is attached; the flag is re-applied to a new activity's
// window (it belongs to the window, not the app).
package io.github.purexyz.scape2004

import android.view.Window
import android.view.WindowManager

class KeepAwake(private val scheduler: Scheduler) {
    private var window: Window? = null
    private var timer: Cancellable? = null
    private var inGame = false
    private var lastUserActivity = scheduler.now()

    /** Whether the screen is being kept on (the debug `idle-timer` action). */
    var isOn = false
        private set

    fun attach(window: Window) {
        this.window = window
        apply()
        schedule()
    }

    fun detach() {
        timer?.cancel()
        timer = null
        window = null
    }

    /** A touch, key or keystroke. */
    fun userActivity() {
        lastUserActivity = scheduler.now()
        update()
    }

    /** The page's status: in the world or not (entering it counts as activity). */
    fun setInGame(inGame: Boolean) {
        this.inGame = inGame
        if (inGame) lastUserActivity = scheduler.now()
        update()
    }

    fun update() {
        set(inGame && scheduler.now() - lastUserActivity < KEEP_AWAKE_AFTER_INPUT_MS)
    }

    private fun set(awake: Boolean) {
        if (isOn == awake) return
        isOn = awake
        apply()
        Log.info("host", "keep screen awake: $awake")
    }

    private fun apply() {
        val window = window ?: return
        if (isOn) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun schedule() {
        timer?.cancel()
        timer = scheduler.postDelayed(CHECK_EVERY_MS) {
            update()
            if (window != null) schedule()
        }
    }

    companion object {
        /** A phone put down mid-session may sleep again after this long without input. */
        const val KEEP_AWAKE_AFTER_INPUT_MS = 5 * 60_000L
        const val CHECK_EVERY_MS = 30_000L
    }
}
