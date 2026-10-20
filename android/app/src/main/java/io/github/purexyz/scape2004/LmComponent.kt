// LmComponent: the bots' chat model in the app (ports the §7.1 glue of ios/LostCity/GameViewController.swift: makeBotChat,
// handleModelKey, presentKeyAlert/keyAlertClosed, the lm-* debug actions, handleModelBench, and the botChat calls in its
// app events and resetPageState; docs/ARCHITECTURE.md §7.1, docs/ANDROID.md §5.2).
//
// :llm's AndroidBotChat does the work (the router, the on-device model, Claude online, the key store and the key's secure
// box, the bench); this wires it into the session, at the points GameViewController.swift calls its BotChatModel:
//
// * page → native: `{type:'lm'|'lm-warm'|'lm-key'}`, and in debug builds `{type:'lm-bench'}` (session.handle; a release
//   build logs lm-bench as unhandled, as an iOS release build does) and the debug actions `lm-status`, `lm-endpoint` and
//   `lm-key-alert` (session.debugAction; `activity` stays the session's).
// * native → page: a reply through `LostCityHost.bots.lmReply`; a status through `LostCityHost.bots.lmStatus`, after
//   `window.LostCityNative.lm` has been registered again for the next document (session.lmStatus), as iOS reinstalls its
//   user scripts first, so a reload (also the one after a renderer crash) starts with the current status; debug replies
//   through `window.__lcDebugReply`.
// * app events: onPause (willResignActive) → pause, the reply being written stops; onStop (didEnterBackground) →
//   suspend, the model is freed; onResume (didBecomeActive) → resume; a memory warning → the model is freed; every page
//   load, reload and renderer crash (resetPageState) → pageReset, so answers asked by the old page are dropped.
// * the key's box (Settings › Bot chat › Set key): shown over the game's activity while it is started, with the keyboard
//   bridge's input focus lent to it (session.keyboardFocus; closing the lend gives the focus back and shows the game's
//   keyboard again if it was up: iOS's yieldFirstResponder(false) + keyboard.activate()). A refused key plays the error
//   haptic as Settings › Vibration allows (session.playHaptic). An activity that goes away with the box up (recreated, or
//   finished) takes the box with it, as Cancel, so the focus is never left lent.
//
// The model's status is computed once here, before the first page load (the session's init), so the first document
// already has it in `window.LostCityNative.lm`. Main thread only, as GameViewController is @MainActor.
package io.github.purexyz.scape2004

import android.app.Activity
import android.os.SystemClock
import io.github.purexyz.scape2004.botchat.LogSink
import io.github.purexyz.scape2004.llm.AndroidBotChat
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

class LmComponent internal constructor(private val botChat: AndroidBotChat, private val host: LmHost) : SessionComponent {
    override fun pageReset() = botChat.pageReset()

    override fun memoryWarning() = botChat.memoryWarning()

    override fun start() {
        host.started = true
    }

    override fun resume() = botChat.resume()

    override fun pause() = botChat.pause()

    override fun stop() {
        host.started = false
        botChat.suspend()
    }

    override fun detach(activity: GameActivity) {
        // (a dialog outlives nothing: the activity's window goes with it, and its dismiss listener would never run, so the
        // keyboard bridge's focus would stay lent; dismissed here it closes as Cancel does)
        val box = botChat.keyDialog?.dialog ?: return
        if (host.boxActivity === activity && box.isShowing) {
            Log.info("lm", "the Claude key box closed with its activity")
            box.dismiss()
        }
    }

    companion object {
        /** What GameSession's init calls: the bot chat, its page messages, debug actions and app events. */
        fun install(session: GameSession, app: LostCityApp): LmComponent {
            val began = SystemClock.elapsedRealtime()
            val botChat = AndroidBotChat.create(app, AppLog, BuildConfig.DEBUG)
            val host = LmHost(SessionSeam(session)) { botChat.keyDialog?.dialog }
            botChat.host = host
            // (before the first page load: window.LostCityNative.lm at document start, GVC-3)
            session.lmStatus = botChat.status
            val component = LmComponent(botChat, host)
            session.components += component
            for (type in MESSAGES) {
                session.handle(type) { message ->
                    // (false: lm-bench in a release build, which iOS compiles out of its release builds)
                    if (!botChat.dispatch(message)) Log.info("host", "unhandled native message: $type")
                }
            }
            if (BuildConfig.DEBUG) {
                for (action in DEBUG_ACTIONS) {
                    session.debugAction(action) { message, reply ->
                        // (the facade answers through LmHost.debugReply with the message's id)
                        if (!botChat.debugAction(message.long("id")?.toInt() ?: 0, action, message)) reply(JsonNull)
                    }
                }
            }
            Log.debug("lm") { "bot chat ready in ${SystemClock.elapsedRealtime() - began} ms: ${JsonText.canonical(session.lmStatus)}" }
            return component
        }

        /** The page messages the bot chat answers (GameViewController.handleNativeMessage's lm cases). */
        val MESSAGES = listOf("lm", "lm-warm", "lm-key", "lm-bench")

        /** Its debug actions (GameViewController.handleDebug's lm cases). */
        val DEBUG_ACTIONS = listOf("lm-status", "lm-endpoint", "lm-key-alert")
    }
}

/**
 * What the bot chat needs from the session (GameSession in the app, a fake in the JVM tests): the page, the document-start
 * status, the keyboard's focus seam, the activity, haptics and the renderer's terminations.
 */
interface LmSeam {
    /** `LostCityHost.<path>(arg)`, fire and forget (PageBridge.call; iOS page.call without a completion). */
    fun callPage(path: String, arg: JsonElement)

    /** Registers `window.LostCityNative.lm` for the next document (GameSession.lmStatus). */
    fun setDocumentStatus(status: JsonObject)

    /** Runs a script in the page (the debug replies). */
    fun evaluate(script: String)

    val keyboardFocus: KeyboardFocus?
    val activity: GameActivity?

    fun playHaptic(style: String)

    val terminations: Int
}

private class SessionSeam(private val session: GameSession) : LmSeam {
    override fun callPage(path: String, arg: JsonElement) = session.page.call(path, listOf(arg))

    override fun setDocumentStatus(status: JsonObject) {
        session.lmStatus = status
    }

    override fun evaluate(script: String) {
        session.webView?.evaluateJavascript(script, null)
    }

    override val keyboardFocus: KeyboardFocus? get() = session.keyboardFocus
    override val activity: GameActivity? get() = session.activity

    override fun playHaptic(style: String) = session.playHaptic(style)

    override val terminations: Int get() = session.terminationCount
}

/**
 * AndroidBotChat.Host on the session (GameViewController's onReply/onStatus closures and its keyboard and haptic calls
 * around the key's box). [keyBox] is the facade's box while it is up (for the debug `ui-state`'s `presented`).
 */
class LmHost(
    private val seam: LmSeam,
    private val scheduler: Scheduler = MainScheduler,
    private val keyBox: () -> android.app.Dialog?,
) : AndroidBotChat.Host {
    /** Between onStart and onStop: the key's box is shown only over an activity the player can see. */
    var started = false

    /** The activity the key's box is shown over, while it is up. */
    var boxActivity: GameActivity? = null
        private set

    private var focusLend: AutoCloseable? = null

    override fun lmReply(reply: JsonObject) = seam.callPage("bots.lmReply", reply)

    override fun lmStatus(status: JsonObject) {
        // (first: a reload sees it in window.LostCityNative.lm, GVC-2)
        seam.setDocumentStatus(status)
        seam.callPage("bots.lmStatus", status)
    }

    override fun activity(): Activity? = if (started) seam.activity else null

    override fun lendKeyboardFocus(lend: Boolean) {
        focusLend?.close()
        focusLend = null
        if (lend) {
            focusLend = seam.keyboardFocus?.lend()
            boxActivity = seam.activity
            // (the facade keeps the box right after this call, then shows it)
            scheduler.post { boxActivity?.presenting(keyBox()) }
        } else {
            boxActivity?.presenting(null)
            boxActivity = null
        }
    }

    /** Nothing more: closing the lend has the keyboard bridge take its focus back and activate (KeyboardFocus). */
    override fun activateKeyboard() {}

    override fun errorHaptic() = seam.playHaptic("error")

    override fun debugReply(id: Int, value: JsonElement) = seam.evaluate("window.__lcDebugReply?.($id, $value);")

    override fun terminations(): Int = seam.terminations

    /** Whether the keyboard bridge's focus is lent to the key's box now (the JVM tests). */
    val focusLent: Boolean get() = focusLend != null
}

/** The bot chat's lines in the app's log (logcat tag LostCity and the log file), as ios/LostCity/Log.swift has them on iOS. */
private object AppLog : LogSink {
    override fun info(tag: String, message: String) = Log.info(tag, message)

    override fun debug(tag: String, message: () -> String) = Log.debug(tag, message)
}
