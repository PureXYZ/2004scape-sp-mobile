// AudioSessionController: the game's sound on Android, audio focus, calls and the background (no Swift file: iOS gets
// this from WebKit's Audio Session API, host.js applyAudioSession; docs/ANDROID.md §1 Sound, §3.3 `audio.setMuted`,
// §4.4).
//
// Android has no sound setting (iOS's Settings › Sound follows its silent switch; a Pixel has none), so the game always
// plays as iOS's "Play" does: whatever the ringer says, and with audio focus while the game is in front (AUDIOFOCUS_GAIN,
// USAGE_GAME), so other apps' music pauses, as iOS's playback category interrupts it. The page's `soundMode` is ignored.
// * Focus is given back in onPause. Losing it (another app's music, a call: AUDIOFOCUS_LOSS or LOSS_TRANSIENT) mutes the
//   game; GAIN brings the sound back. A request refused (during a call) mutes it too. "Can duck" losses are left to the
//   system, which lowers a game's volume by itself.
// * Always muted while the activity is stopped (in the background): Android keeps a page's Web Audio playing with the
//   screen off, where iOS suspends the app.
// The mute is WebViewCompat.setAudioMuted (WebView feature MUTE_AUDIO: the whole WebView, instantly); without that
// feature the page's own LostCityHost.audio.setMuted(muted), which suspends the client's AudioContext. The volume keys
// change the music stream (USAGE_GAME's), not the ringer.
//
// AudioSession is the pure state machine (AudioSessionTest drives it with a fake AudioManager); the controller below is
// its Android half and a SessionComponent.
package io.github.purexyz.scape2004

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.widget.FrameLayout
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** The sound rules (above), independent of Android: what to ask of the AudioManager and whether the game is muted. */
class AudioSession(private val platform: Platform) {
    /** What AudioSession needs from Android (a fake in the JVM tests). */
    interface Platform {
        /** AudioManager.requestAudioFocus for the game: an AUDIOFOCUS_REQUEST_* result; changes arrive at [focusChanged]. */
        fun requestFocus(): Int

        fun abandonFocus()

        /** Mutes or unmutes the game (only called on a change, or when [AudioSession.reapply] asks). */
        fun applyMute(muted: Boolean, reason: String)
    }

    enum class Focus { NONE, HELD, LOST, LOST_TRANSIENT, REFUSED }

    var focus = Focus.NONE
        private set
    var started = false
        private set
    var resumed = false
        private set
    private var applied: Boolean? = null

    /** Why the game is muted now, or null when it plays. */
    val muteReason: String?
        get() = when {
            !started -> "in the background"
            focus == Focus.LOST -> "audio focus lost"
            focus == Focus.LOST_TRANSIENT -> "audio focus lost for now"
            focus == Focus.REFUSED -> "audio focus refused"
            else -> null
        }

    val muted: Boolean get() = muteReason != null

    fun start() {
        started = true
        update()
    }

    fun resume() {
        resumed = true
        update()
    }

    fun pause() {
        resumed = false
        update()
    }

    fun stop() {
        started = false
        resumed = false
        update()
    }

    /** AudioManager's focus listener. */
    fun focusChanged(change: Int) {
        if (focus == Focus.NONE) return // (a late callback for a request already given back)
        when (change) {
            AudioManager.AUDIOFOCUS_GAIN -> focus = Focus.HELD
            AudioManager.AUDIOFOCUS_LOSS -> {
                // Another app has taken it for good: the system has dropped the request. The game stays muted until it
                // asks again, at the next resume (iOS: an interruption by another app's playback lasts until then too).
                focus = Focus.LOST
                platform.abandonFocus()
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> focus = Focus.LOST_TRANSIENT
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> return // (the system ducks a game by itself)
            else -> return
        }
        Log.info("audio", "audio focus ${focusName(change)}")
        applyMute()
    }

    /** Applies the current state again (a new WebView, or a page that only now has its own mute). */
    fun reapply() {
        applied = null
        applyMute()
    }

    private fun update() {
        val wantsFocus = resumed
        if (wantsFocus && (focus == Focus.NONE || focus == Focus.REFUSED)) {
            val result = platform.requestFocus()
            focus = if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) Focus.HELD else Focus.REFUSED
            Log.info("audio", "audio focus requested: ${if (focus == Focus.HELD) "granted" else "refused ($result)"}")
        } else if (!wantsFocus && focus != Focus.NONE) {
            if (focus != Focus.LOST && focus != Focus.REFUSED) {
                platform.abandonFocus()
                Log.info("audio", "audio focus given back")
            }
            focus = Focus.NONE
        }
        applyMute()
    }

    private fun applyMute() {
        val reason = muteReason
        val muted = reason != null
        if (applied == muted) return
        applied = muted
        platform.applyMute(muted, reason ?: "sound on")
    }

    /** For the `audio` debug action and the log. */
    fun state(): JsonObject = buildJsonObject {
        put("muted", JsonPrimitive(muted))
        put("reason", JsonPrimitive(muteReason ?: ""))
        put("focus", JsonPrimitive(focus.name.lowercase()))
        put("started", JsonPrimitive(started))
        put("resumed", JsonPrimitive(resumed))
    }

    private fun focusName(change: Int) = when (change) {
        AudioManager.AUDIOFOCUS_GAIN -> "gained"
        AudioManager.AUDIOFOCUS_LOSS -> "lost"
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> "lost for now"
        else -> "change $change"
    }
}

/**
 * The sound rules in the session: the AudioManager's focus, and the mute on the session's (current) WebView or, without
 * MUTE_AUDIO, on the page. DEBUG action `audio`: the state.
 */
class AudioSessionController(private val session: GameSession, context: Context) : SessionComponent {
    private val app = context.applicationContext
    private val audioManager = app.getSystemService(AudioManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val nativeMute = try {
        WebViewFeature.isFeatureSupported(WebViewFeature.MUTE_AUDIO)
    } catch (_: Throwable) {
        false
    }
    /** The last state logged: a re-application after a page load is not news. */
    private var logged: String? = null

    private val focusRequest: AudioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_GAME).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
        .setOnAudioFocusChangeListener({ change -> audio.focusChanged(change) }, main)
        .build()

    val audio = AudioSession(object : AudioSession.Platform {
        override fun requestFocus(): Int = audioManager?.requestAudioFocus(focusRequest) ?: AudioManager.AUDIOFOCUS_REQUEST_FAILED
        override fun abandonFocus() {
            audioManager?.abandonAudioFocusRequest(focusRequest)
        }
        override fun applyMute(muted: Boolean, reason: String) = mute(muted, reason)
    })

    init {
        session.debugAction("audio") { _, reply ->
            reply(buildJsonObject {
                for ((key, value) in audio.state()) put(key, value)
                put("primitive", JsonPrimitive(if (nativeMute) "webview" else "page"))
            })
        }
    }

    override fun attach(activity: GameActivity, root: FrameLayout) {
        // the volume keys: the game's stream (USAGE_GAME plays on the music stream), not the ringer's, also on the title
        activity.volumeControlStream = AudioManager.STREAM_MUSIC
        audio.reapply()
    }

    override fun start() {
        audio.start()
    }

    override fun resume() {
        audio.resume()
    }

    override fun pause() {
        audio.pause()
    }

    override fun stop() {
        audio.stop()
    }

    /** A new document, perhaps in a new WebView (after a renderer crash): it starts unmuted, so apply the state again. */
    override fun pageReset() {
        audio.reapply()
    }

    /** host.js is running: the page fallback can be applied now. */
    override fun pageReady() {
        if (!nativeMute) audio.reapply()
    }

    @SuppressLint("RequiresFeature") // (nativeMute: MUTE_AUDIO checked once at start)
    private fun mute(muted: Boolean, reason: String) {
        if (nativeMute) {
            val web = session.webView ?: return // (applied again when the WebView is attached)
            WebViewCompat.setAudioMuted(web, muted)
        } else {
            session.page.call("audio.setMuted", listOf(JsonPrimitive(muted))) { outcome ->
                Log.debug("audio") { "audio.setMuted($muted) → ${outcome.description}" }
            }
        }
        val line = if (muted) "muted ($reason)" else "sound on"
        if (line != logged) Log.info("audio", line) else Log.debug("audio") { "$line (again)" }
        logged = line
    }
}
