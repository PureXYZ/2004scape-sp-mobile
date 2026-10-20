// The bots' chat model, native side (docs/ARCHITECTURE.md §7.1): the page hands over a reply the engine wants written
// (`{type:'lm', id, mode, local, online, maxChars, timeoutMs}`), and this answers it through `LostCityHost.bots.lmReply`
// with a line or with null and why. The engine decides everything else (whether a bot replies, when, and its fallback: the
// rules' line); a line here is only words. The Kotlin port of the iOS app's ios/LostCity/BotChatModel.swift:
// the same constants, the same order of checks, the same reply shapes, the same log lines.
//
// - The mode is the player's (Settings › Bot chat), sent with each request: `online` uses Claude when a key is saved and
//   falls back to the on-device model, then to nothing; `local` uses the on-device model, else nothing. A request that says
//   `fallback: false` (the page's Test button) gets Claude's answer or its error, never the on-device model's.
// - `think` (Settings › Bot chat › Think first; absent: false): the on-device model writes its short note before the reply,
//   when it is a model that offers the choice ([ThinkSupport]); also on Claude's fallback to it. Claude online ignores it.
// - At most 3 requests at a time; more are answered 'busy' at once. Each has the page's `timeoutMs` (9 s) in all.
// - The status (`LostCityHost.bots.lmStatus`, and `window.LostCityNative.lm` at document start): the on-device model (in
//   this build at all, its name and size, whether it is loaded, whether it writes the note: `think` 'never', 'always' or
//   'option') and the Claude key (set, its last four characters, refused by the API, the last problem).
//
// Main thread only, as the Swift class is @MainActor: every method, and every completion (LocalModel and OnlineModel post
// theirs to the main thread). Messages and replies are plain maps in the Swift shapes (JsonBridge converts at the edge).
package io.github.purexyz.scape2004.botchat

import kotlin.math.max
import kotlin.math.min

class BotChatModel(
    val local: LocalModel,
    val online: OnlineModel,
    private val keyStore: ModelKeyStore,
    private val log: LogSink,
) {
    companion object {
        const val MAX_IN_FLIGHT = 3
        const val DEFAULT_TIMEOUT_MS = 9000
    }

    /** The Claude key, when a request needs it (the key store; a test's stand-in). */
    var readKey: () -> String? = { keyStore.read() }

    /** A reply for the page (`LostCityHost.bots.lmReply`). */
    var onReply: ((Map<String, Any?>) -> Unit)? = null

    /** The status changed (`LostCityHost.bots.lmStatus`). */
    var onStatus: ((Map<String, Any?>) -> Unit)? = null

    /**
     * How hot the phone is. Hot (iOS's serious or critical; Android's SEVERE and up: android/llm ThermalGate.kt): the
     * on-device model does not run until it cools down (the engine says the bots' own lines meanwhile); Claude online is not
     * affected. Measured on an iPhone 13 mini: a reply every 5 s for 14 minutes, on USB power with 500 bots, reaches serious.
     */
    var thermal: ThermalProvider = ThermalProvider.NOMINAL

    private val tooHot: Boolean get() = thermal.level() >= ThermalLevel.SERIOUS

    private var inFlight = 0

    /** bumped when the page goes away ([pageReset]): a reply asked by an older page is dropped */
    private var generation = 0

    /** null until Claude answered or refused the key; false after a 401. */
    private var keyValid: Boolean? = null
    private var onlineProblem: String? = null

    private class Stats {
        var requests = 0
        var local = 0
        var online = 0
        var failed = 0
        var busy = 0
        var hot = 0
    }

    private val stats = Stats()

    init {
        local.onLoadedChange = { statusChanged() }
    }

    // --------------------------------------------------------------------------------------------------------- status

    val status: Map<String, Any?>
        get() {
            val localStatus = linkedMapOf<String, Any?>("available" to local.available, "loaded" to local.isLoaded, "think" to local.thinkSupport.raw)
            local.info?.let {
                localStatus["name"] = it.name
                localStatus["bytes"] = it.bytes
            }
            local.unavailableReason?.let { localStatus["reason"] = it }
            val hint = ModelKeyStore.hint(readKey())
            val onlineStatus = linkedMapOf<String, Any?>("keySet" to (hint != null), "model" to OnlineModel.MODEL)
            hint?.let { onlineStatus["hint"] = it }
            keyValid?.let { onlineStatus["valid"] = it }
            onlineProblem?.let { onlineStatus["problem"] = it }
            return linkedMapOf("local" to localStatus, "online" to onlineStatus)
        }

    private fun statusChanged() {
        onStatus?.invoke(status)
    }

    // ------------------------------------------------------------------------------------- the key (Settings › Bot chat)

    /** Saves a key typed into the native secure box. False if it cannot be a key or the store refused it. */
    fun setKey(typed: String): Boolean {
        val key = ModelKeyStore.normalized(typed) ?: return false
        if (!keyStore.save(key)) return false
        keyValid = null
        onlineProblem = null
        log.info("lm", "Claude key saved (${ModelKeyStore.hint(keyStore.read()) ?: "?"})")
        statusChanged()
        return true
    }

    /** Something about the key to show on the Bot chat page ("not a key": what was typed cannot be one). */
    fun keyProblem(problem: String) {
        onlineProblem = problem
        statusChanged()
    }

    fun removeKey() {
        keyStore.remove()
        keyValid = null
        onlineProblem = null
        log.info("lm", "Claude key removed")
        statusChanged()
    }

    // ------------------------------------------------------------------------------------------------------ app events

    /**
     * The player entered the world with a model chosen (the page's `{type:'lm-warm'}`): the model loads now, in the
     * background, so that the first reply does not wait for it. The idle unload still applies.
     */
    fun warm() {
        if (!local.available || tooHot) return
        local.warmUp()
    }

    /** The reply being written stops and the model is freed at once. */
    fun memoryWarning() {
        local.release("memory warning")
    }

    /** The app is inactive for a moment: the reply being written stops; the model stays loaded. */
    fun pause() {
        local.pause()
    }

    /** The app is in the background: the model is freed too. */
    fun suspend() {
        local.suspend()
    }

    /**
     * The page went away (a reload, a new document): answers still being written were asked by the old page, whose ids the
     * new one counts again from 1, so they are dropped.
     */
    fun pageReset() {
        generation += 1
    }

    fun resume() {
        local.resume()
    }

    // -------------------------------------------------------------------------------------------------------- requests

    fun handle(message: Map<String, Any?>) {
        val id = SwiftCast.intValue(message["id"])
        if (id == null) {
            log.info("lm", "ignored a request without an id")
            return
        }
        val started = System.nanoTime()
        val gen = generation
        val mode = message["mode"] as? String ?: "local"
        val localPrompt = SwiftCast.map(message["local"]) ?: emptyMap()
        val onlinePrompt = SwiftCast.map(message["online"]) ?: emptyMap()
        val fallback = SwiftCast.bool(message["fallback"]) ?: true
        val think = SwiftCast.bool(message["think"]) ?: false  // (the on-device model's note: Settings › Bot chat › Think first)
        val timeoutMs = min(30_000, max(1000, SwiftCast.intValue(message["timeoutMs"]) ?: DEFAULT_TIMEOUT_MS))
        val deadline = started + timeoutMs * 1_000_000L
        stats.requests += 1

        fun reply(text: String?, source: String?, error: String?, extra: Map<String, Any?> = emptyMap()) {
            if (gen != generation) {
                log.info("lm", "#$id answered after the page reloaded: dropped")
                return
            }
            val out = linkedMapOf<String, Any?>("id" to id, "text" to text, "source" to source, "ms" to round1(msSince(started)))
            if (error != null) out["error"] = error
            for ((key, value) in extra) {
                if (!out.containsKey(key)) out[key] = value  // (merged without overriding, as Swift's { a, _ in a })
            }
            onReply?.invoke(out)
        }

        if (mode != "local" && mode != "online") {
            reply(null, null, "unavailable")  // ('rules': the page answers those itself)
            return
        }
        if (inFlight >= MAX_IN_FLIGHT) {
            stats.busy += 1
            reply(null, null, "busy")
            return
        }
        inFlight += 1

        val runLocal: (String?) -> Unit = runLocal@{ onlineError ->
            if (!(fallback || mode == "local") || !local.available) {
                inFlight -= 1
                stats.failed += 1
                reply(null, null, onlineError ?: "unavailable")
                return@runLocal
            }
            if (tooHot) {
                inFlight -= 1
                stats.hot += 1
                log.info("lm", "#$id the phone is hot (${thermal.describe()}): no on-device reply")
                reply(null, null, onlineError ?: "busy")
                return@runLocal
            }
            local.generate(localPrompt["system"] as? String ?: "", localPrompt["user"] as? String ?: "", think, deadline) { result ->
                inFlight -= 1
                val output = result.getOrNull()
                if (output != null) {
                    stats.local += 1
                    val t = output.timings
                    // (the mode the model ran in: the request's think, as the model allows it)
                    val asked = if (t.think != think) " (asked ${if (think) "on" else "off"})" else ""
                    val load = t.loadMs?.let { " (load ${it.toInt()} ms)" } ?: ""
                    val note = if (t.think) ", note ${t.noteTokens} tokens in ${t.noteMs.toInt()} ms" else ""
                    log.info("lm", "#$id local, think ${if (t.think) "on" else "off"}$asked, in ${t.totalMs.toInt()} ms$load: " +
                        "prompt ${t.promptTokens} tokens at ${t.promptTokensPerSecond.toInt()}/s$note, ${t.generatedTokens} tokens at ${t.generateTokensPerSecond.toInt()}/s")
                    val empty = output.text.isEmpty()
                    reply(if (empty) null else output.text, if (empty) null else "local", if (empty) "failed: empty" else null,
                        mapOf("timings" to t.dictionary))
                } else {
                    val failure = result.exceptionOrNull() as? LocalModel.Failure ?: LocalModel.Failure.Failed(result.exceptionOrNull().toString())
                    stats.failed += 1
                    val after = onlineError?.let { " (after Claude: $it)" } ?: ""
                    log.info("lm", "#$id local, think ${if (local.thinkSupport.writesNote(think)) "on" else "off"}, failed: ${failure.description}$after")
                    reply(null, null, failure.description)  // (the last try's reason; Claude's is in the status)
                }
            }
        }

        val key = if (mode == "online") readKey() else null
        if (key == null) {
            if (mode == "online" && !fallback) {
                inFlight -= 1
                reply(null, null, "unavailable")
                return
            }
            runLocal(null)
            return
        }
        // (signed: the key's read on this thread may have run past the deadline)
        val remaining = (deadline - System.nanoTime()) / 1e9
        if (remaining <= 0.5) {
            inFlight -= 1
            reply(null, null, "timeout")
            return
        }
        online.generate(key, onlinePrompt["system"] as? String ?: "", onlinePrompt["context"] as? String ?: "",
            onlinePrompt["user"] as? String ?: "", min(8.0, remaining)) { result ->
            val output = result.getOrNull()
            if (output != null) {
                inFlight -= 1
                stats.online += 1
                val u = output.usage
                log.info("lm", "#$id Claude in ${output.ms.toInt()} ms (input ${u.input}, cache read ${u.cacheRead}, write ${u.cacheWrite}, output ${u.output} tokens)")
                if (keyValid != true || onlineProblem != null) {
                    keyValid = true
                    onlineProblem = null
                    statusChanged()
                }
                reply(output.text, "online", null, mapOf("usage" to u.dictionary))
            } else {
                val failure = result.exceptionOrNull() as? OnlineModel.Failure ?: OnlineModel.Failure.Network(result.exceptionOrNull().toString())
                val answers = if (fallback && local.available) "; the on-device model answers" else ""
                log.info("lm", "#$id Claude failed: ${failure.description}$answers")
                val valid: Boolean? = if (failure is OnlineModel.Failure.KeyRefused) false else keyValid
                if (valid != keyValid || onlineProblem != failure.problem) {
                    keyValid = valid
                    onlineProblem = failure.problem
                    statusChanged()
                }
                if (fallback) {
                    runLocal(failure.reason)
                } else {
                    inFlight -= 1
                    stats.failed += 1
                    reply(null, null, failure.reason)
                }
            }
        }
    }

    /** For the bench's log. */
    val counters: Map<String, Any?>
        get() = linkedMapOf(
            "requests" to stats.requests, "local" to stats.local, "online" to stats.online, "failed" to stats.failed,
            "busy" to stats.busy, "hot" to stats.hot, "inFlight" to inFlight,
        )
}
