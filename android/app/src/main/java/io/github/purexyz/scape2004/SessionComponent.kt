// SessionComponent: the seam for the parts of the shell other tracks build on top of the native core (docs/ANDROID.md §2,
// §4.1): the keyboard bridge and its accessory bar, haptics,
// the audio session, the loading cover and notices, the bot chat glue.
//
// GameViewController.swift calls each of those directly at fixed points (keyboard.reset() on a page reset,
// keyboard.releaseHeldKeys() on resign-active, botChat.pause(), haptics.prepare() on `ingame`, …). Here GameSession calls
// every registered component at the same points, in registration order, and a component registers the page → native
// messages it handles (GameSession.handle("keyboard") { … }) and its debug actions (GameSession.debugAction("type") { … }).
// Messages nobody handles yet are logged and ignored. Every method has a default, so a component overrides only what it
// needs.
package io.github.purexyz.scape2004

import android.content.res.Configuration
import android.widget.FrameLayout
import kotlinx.serialization.json.JsonObject

interface SessionComponent {
    /** A (new) activity shows the game: add views to `root` (above the WebView, below the cover). */
    fun attach(activity: GameActivity, root: FrameLayout) {}

    /** The activity goes away (destroyed or recreated); the session and the page live on. */
    fun detach(activity: GameActivity) {}

    /** The page went away (a load, a reload, a renderer crash): forget its state (iOS keyboard.reset, botChat.pageReset). */
    fun pageReset() {}

    /** The page posted `ready` (iOS: keyboard.activate()). */
    fun pageReady() {}

    /** The page's `status` phase (`booting`, `engine-ready`, `title`, `ingame`, `error`; iOS: haptics.prepare on ingame). */
    fun status(phase: String) {}

    /** The settings changed (`{type:'settings'}`). */
    fun settingsChanged(values: JsonObject) {}

    /** The page reported a fatal error (iOS: keyboard.hide(userInitiated: false)). */
    fun fatal() {}

    /** A memory warning (iOS: botChat.memoryWarning()). */
    fun memoryWarning() {}

    /** onStart, before the lifecycle's `foreground` (e.g. unmute). */
    fun start() {}

    /** onResume, after the lifecycle's `resume` (iOS didBecomeActive: botChat.resume, keyboard.activate). */
    fun resume() {}

    /** onPause, before the lifecycle's `pause` (iOS willResignActive: keyboard.releaseHeldKeys, botChat.pause). */
    fun pause() {}

    /** onStop, after the lifecycle's `background` (iOS didEnterBackground: botChat.suspend; mute). */
    fun stop() {}

    fun windowFocusChanged(hasFocus: Boolean) {}

    fun configurationChanged(configuration: Configuration) {}
}
