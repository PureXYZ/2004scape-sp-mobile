// LifecycleCoordinator: the activity's lifecycle → `LostCityHost.lifecycle(event)` (a faithful port of
// ios/LostCity/LifecycleCoordinator.swift; ARCHITECTURE.md §7, docs/ANDROID.md §3.4).
//
// Where the events come from on Android: onPause → pause, onStop → background, onStart → foreground, onResume → resume,
// and onDestroy of a finishing activity → terminate (best effort).
//
// Suspending events (pause, background, terminate) make the engine save every player and stop ticking; the page's
// promise resolves once the saves are on disk (the engine worker PUTs them with synchronous XHR, which AssetRouter serves
// on Chromium's threads). Resuming events (foreground, resume) restart it.
//
// Rules (iOS's, unchanged):
// * One flush in flight. A suspending event that arrives while a flush is running is not sent again.
// * No double sends. After a successful flush the world is paused and unchanged, so further suspending events
//   (background after pause) are skipped; a failed one is retried by the next. Only the first of foreground/resume is
//   sent.
// * Ordering. A resume that arrives while a flush is still running is sent after it ends.
// * The flush always ends: when the page answers, or after `FLUSH_TIMEOUT_MS`, whichever comes first.
//
// What differs from iOS:
// * There is no background task to keep the app alive, and none is needed: the flush starts in onPause while the activity
//   is still visible, and a stopped app is frozen only after about 10 s, past the 8 s timeout. The iOS BackgroundTask is
//   `FlushGuard` here, which only logs, so the log reads the same.
// * There is no blocking `terminate()`. iOS spins its run loop until the last save is written; on Android the UI thread
//   must never wait for the page (evaluateJavascript results and WebMessageListener replies arrive on it), so terminate
//   only starts or joins a flush. The onPause/onStop flush is the guarantee, with the engine's 15-minute autosave.
// * `onFlushFinished` tells GameSession when a flush ended, so it can pause the WebView's timers if the app is still
//   stopped by then (never while a flush runs: the page's engine request times out with setTimeout).
//
// Pure Kotlin with an injected Scheduler and PageCaller, so the JVM unit tests run every rule with a fake clock.
package io.github.purexyz.scape2004

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import java.util.Locale

class LifecycleCoordinator(private val caller: PageCaller, private val scheduler: Scheduler) {
    /** `LostCityHost.lifecycle(event)` through PageBridge (a fake in tests). */
    fun interface PageCaller {
        fun call(path: String, args: List<JsonElement>, completion: (PageBridge.Outcome) -> Unit)
    }

    enum class Event(val raw: String) {
        PAUSE("pause"), BACKGROUND("background"), TERMINATE("terminate"), FOREGROUND("foreground"), RESUME("resume");

        val suspends: Boolean get() = this == PAUSE || this == BACKGROUND || this == TERMINATE

        override fun toString() = raw

        companion object {
            fun of(raw: String?): Event? = entries.firstOrNull { it.raw == raw }
        }
    }

    private sealed interface State {
        data object Running : State
        data class Flushing(val serial: Int) : State
        data class Paused(val saved: Boolean) : State
    }

    /** Called when a flush ended (done, failed, or timed out), with whether the saves were written. */
    var onFlushFinished: ((saved: Boolean) -> Unit)? = null

    private val guard = FlushGuard("lostcity-save")
    private var state: State = State.Running
    private var serial = 0
    private var flushStarted = 0L
    private var pendingResume: Event? = null
    private var timeout: Cancellable? = null

    /** True while a flush waits for the page. */
    val isFlushing: Boolean get() = state is State.Flushing

    /** `running`, `flushing #n`, `paused (saved)` or `paused (not saved)`, for the debug hooks. */
    val stateDescription: String
        get() = when (val s = state) {
            State.Running -> "running"
            is State.Flushing -> "flushing #${s.serial}"
            is State.Paused -> if (s.saved) "paused (saved)" else "paused (not saved)"
        }

    fun handle(event: Event) {
        if (event.suspends) suspend(event) else resume(event)
    }

    /** The page is being (re)loaded: a fresh engine boots running, and whatever the old page was doing is moot. */
    fun reset() {
        (state as? State.Flushing)?.let { Log.info("life", "flush #${it.serial} abandoned: page reloading") }
        timeout?.cancel()
        timeout = null
        pendingResume = null
        state = State.Running
        guard.end()
    }

    // ------------------------------------------------------------------------------------------------ suspend

    private fun suspend(event: Event) {
        when (val s = state) {
            is State.Flushing -> {
                pendingResume = null // superseded: we are going down again
                guard.begin()
                Log.info("life", "$event: flush #${s.serial} already in flight, not re-sent")
            }
            is State.Paused -> if (s.saved) {
                pendingResume = null
                Log.info("life", "$event: already paused and saved, not re-sent")
            } else {
                startFlush(event)
            }
            State.Running -> startFlush(event)
        }
    }

    private fun startFlush(event: Event) {
        serial += 1
        val serial = this.serial
        state = State.Flushing(serial)
        flushStarted = scheduler.now()
        guard.begin()
        Log.info("life", "$event → flush #$serial started")
        caller.call("lifecycle", listOf(JsonPrimitive(event.raw))) { outcome ->
            // {ok: false} (a save could not be written) is a failed flush, retried by the next suspending event
            finishFlush(serial, outcome.reportedSuccess, outcome.description)
        }
        timeout?.cancel()
        timeout = scheduler.postDelayed(FLUSH_TIMEOUT_MS) {
            finishFlush(serial, false, "timed out after ${FLUSH_TIMEOUT_MS / 1000} s")
        }
    }

    private fun finishFlush(serial: Int, saved: Boolean, detail: String) {
        if (state != State.Flushing(serial)) {
            Log.info("life", "flush #$serial answered late: $detail")
            return
        }
        val elapsed = String.format(Locale.ROOT, "%d ms", scheduler.now() - flushStarted)
        state = State.Paused(saved)
        timeout?.cancel()
        timeout = null
        Log.info("life", "flush #$serial ${if (saved) "done" else "FAILED"} in $elapsed: $detail")
        guard.end()
        Log.flush()
        val next = pendingResume
        if (next != null) {
            pendingResume = null
            send(next)
        }
        onFlushFinished?.invoke(saved)
    }

    // ------------------------------------------------------------------------------------------------ resume

    private fun resume(event: Event) {
        when (val s = state) {
            State.Running -> Log.debug("life") { "$event: already running, not re-sent" }
            is State.Flushing -> {
                pendingResume = event
                Log.info("life", "$event: queued until flush #${s.serial} finishes")
            }
            is State.Paused -> send(event)
        }
    }

    private fun send(event: Event) {
        state = State.Running
        Log.info("life", "$event → sent")
        caller.call("lifecycle", listOf(JsonPrimitive(event.raw))) { outcome ->
            Log.info("life", "$event → ${outcome.description}")
        }
    }

    companion object {
        /** Generous for a few KB of saves and a 1 MB bots.sav (14 ms measured on the emulator), below the ~10 s freezer. */
        const val FLUSH_TIMEOUT_MS = 8_000L
    }
}

/**
 * The iOS BackgroundTask's place in the log: begun when a flush starts, ended exactly once. Android grants no extra time
 * and needs none (see the file comment), so it only logs `flush guard <name> began|ended`.
 */
class FlushGuard(private val name: String) {
    var isActive = false
        private set

    fun begin() {
        if (isActive) return
        isActive = true
        Log.info("life", "flush guard $name began")
    }

    fun end() {
        if (!isActive) return
        isActive = false
        Log.info("life", "flush guard $name ended")
    }
}
