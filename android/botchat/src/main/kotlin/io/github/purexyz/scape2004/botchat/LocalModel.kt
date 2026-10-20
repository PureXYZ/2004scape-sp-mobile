// The bots' on-device chat model: llama.cpp running the bundled GGUF (Qwen3.5 0.8B with the 2004 LoRA fused in, Q4_K_M) on
// the phone's CPU, in the app process, not the WebView's renderer, whose memory it would share (docs/ARCHITECTURE.md §7.1,
// docs/ANDROID.md §1 Bot chat). The Kotlin port of the iOS app's ios/LostCity/LocalModel.swift: this
// keeps the Swift class's queue, lock, lifecycle, timings and failure strings; the llama.cpp part (the load, the prompt,
// the sampling loop) is the C++ core behind LlmNative, ported line for line from the same Swift.
//
// - Loaded lazily, at the first request (or a warm-up), when there is room for it ([Options.minFreeToLoad]); unloaded
//   after 5 idle minutes, on a memory warning ([release]: the reply being written stops first) and in the background.
// - One generation at a time, on its own thread (`generate` from any thread; the completion comes on the main thread). All
//   llama.cpp state is confined to that thread.
// - The prompt is the engine's `renderLocal` (a system and a user turn) in Qwen's chat template with the empty think block
//   (thinking off), exactly as the model was trained: temperature 0.8, top-p 0.9, top-k 40, a repetition penalty of 1.1
//   over the last 64 tokens, at most 40 tokens, one line of the chat's characters (a GBNF grammar), stopping at a newline,
//   `<|im_end|>`, the end of text or a think block marker.
// - A model trained to write a short note first ([ThinkSupport], from model.json's template) gets the think block open
//   instead and writes the note before the reply: always ('qwen-chatml-think'), or when the request asks for it
//   ('qwen-chatml-hybrid': one model in both modes, Settings › Bot chat › Think first).
// - The tokens of the last prompt stay in the context; a prompt that starts the same way reuses them where the model's
//   memory allows it (Qwen3.5 is a hybrid: its recurrent layers cannot be cut back, so it usually starts afresh).
//
// [Android differs] (each one deliberate, none visible to the page): the CPU, not the GPU (gpuLayers 0, ggml's CPU
// backend with weight repacking); the GGUF read from the APK by descriptor and mmapped when it is aligned there; a pause or
// the deadline also stops a decode inside a prompt batch (llama.cpp's abort callback); `no-runtime` instead of `simulator`
// when the native library is missing; the room a load needs is the system's ([availableMemory]: ActivityManager's free
// memory above its low-memory line), and more of it (the CPU's weights are an anonymous copy, not mapped GPU memory).
package io.github.purexyz.scape2004.botchat

import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.random.Random

class LocalModel(
    /** The model in the app, or null. */
    val info: ModelInfo?,
    /** llama.cpp, or null when this build cannot run a model at all (the native library did not load). */
    private val native: LlmNative?,
    private val main: MainPoster,
    private val log: LogSink,
    /** How much more memory there is before the system ends apps, in bytes, or null where that is not known (the Mac: no
     *  check). iOS: `os_proc_available_memory`. */
    private val availableMemory: () -> Long? = { null },
) {
    data class Options(
        /** Threads for the CPU (the game's client draws on the CPU too, so few). */
        val threads: Int = 2,
        val batchThreads: Int = 2,
        /** Layers on a GPU: none (Android's v1 is CPU only; iOS: 99, all on Metal). */
        val gpuLayers: Int = 0,
        val temperature: Float = 0.8f,
        val topP: Float = 0.9f,
        val topK: Int = 40,
        val repeatPenalty: Float = 1.1f,
        val repeatLastN: Int = 64,
        val maxTokens: Int = 40,
        /** The grammar's longest line (the engine's guard cuts to 80). */
        val maxChars: Int = 120,
        /** Unloaded after this long without a request. */
        val idleUnloadMs: Long = 5 * 60 * 1000L,
        /** [Android] ggml's CPU weight repacking (about twice the prompt speed, at the cost of an anonymous copy). Bench. */
        val repack: Boolean = true,
        /** [Android] -1: mmap the GGUF when it is aligned in the APK, 0: read it into memory, 1: mmap or fail. Bench. */
        val mmap: Int = -1,
        /** Not loaded when less than this is free ([availableMemory]). [Android differs] iOS 256 MB, room for the game
         *  alone (its weights are mapped and on Metal); here the load itself takes about 680 MB of anonymous memory (the
         *  repacked weights, docs/ANDROID.md), so 1 GB: the load and some room. */
        val minFreeToLoad: Long = 1024L shl 20,
    )

    class Timings {
        /** The model's load, when this request loaded it. */
        var loadMs: Double? = null
        var promptTokens = 0
        /** Prompt tokens already in the context (not evaluated again). */
        var reusedTokens = 0
        var promptMs = 0.0
        var generatedTokens = 0
        var generateMs = 0.0
        /** A token the grammar refused, sampled again from the whole vocabulary. */
        var resampled = 0
        /** The model wrote its note before the reply (the request's mode, as the model's [ThinkSupport] allows it). */
        var think = false
        /** (think) the note's tokens and its time (the think block's close and the blank line after it included);
         *  [generatedTokens] and [generateMs] are then the reply's alone */
        var noteTokens = 0
        var noteMs = 0.0
        var totalMs = 0.0

        val promptTokensPerSecond: Double get() = if (promptMs > 0) (promptTokens - reusedTokens) * 1000 / promptMs else 0.0
        val generateTokensPerSecond: Double get() = if (generateMs > 0) generatedTokens * 1000 / generateMs else 0.0

        /** What the page gets as the reply's `timings` (docs/ARCHITECTURE.md §7.1). */
        val dictionary: Map<String, Any?>
            get() {
                val out = linkedMapOf<String, Any?>(
                    "promptTokens" to promptTokens, "reusedTokens" to reusedTokens, "promptMs" to round1(promptMs),
                    "promptTps" to round1(promptTokensPerSecond), "generatedTokens" to generatedTokens,
                    "generateMs" to round1(generateMs), "generateTps" to round1(generateTokensPerSecond),
                    "resampled" to resampled, "think" to think, "totalMs" to round1(totalMs),
                )
                loadMs?.let { out["loadMs"] = round1(it) }
                if (think) {
                    out["noteTokens"] = noteTokens
                    out["noteMs"] = round1(noteMs)
                }
                return out
            }
    }

    /** Why there is no reply, as the page protocol words it ([description]; docs/ARCHITECTURE.md §7.1). */
    sealed class Failure(val description: String) : Exception(description) {
        class Unavailable(val why: String) : Failure("unavailable")
        object Timeout : Failure("timeout") {
            private fun readResolve(): Any = Timeout
        }
        object Aborted : Failure("failed: interrupted") {
            private fun readResolve(): Any = Aborted
        }
        class Failed(val why: String) : Failure("failed: $why")

        override fun toString() = description
    }

    class Output(
        val text: String,
        val timings: Timings,
        /** (the note variant) the note the model wrote before its reply; null for a model without one */
        val note: String? = null,
    )

    /** True when this build can run a model at all (iOS: llama.cpp linked; here: liblcllm loaded and a CPU backend). */
    val compiled: Boolean get() = native != null && !runtimeMissing

    val available: Boolean get() = compiled && info != null

    /** Why there is no model, in the page's words (Settings › Bot chat shows "Not in this build" for both). */
    val unavailableReason: String?
        get() = when {
            !compiled -> "no-runtime"
            info == null -> "no-model"
            else -> null
        }

    /** Whether the model here writes its note (`never` when no model can run here). */
    val thinkSupport: ThinkSupport get() = if (available) info?.think ?: ThinkSupport.NEVER else ThinkSupport.NEVER

    var options: Options
        get() = lock.withLock { optionsValue }
        set(value) = lock.withLock { optionsValue = value }

    /** Whether the model is in memory (read on any thread). */
    val isLoaded: Boolean get() = lock.withLock { loaded }

    /** The last load: [total, model, context] ms (the bench), or null. */
    val lastLoad: List<Double>? get() = lock.withLock { lastLoadValue }

    /** The CPU backend's library (Android), "" on the Mac, null before the first load. */
    val cpuVariant: String? get() = lock.withLock { variant }

    /** Whether the loaded model is mapped from its file (else read into memory). */
    val mapped: Boolean get() = lock.withLock { mappedValue }

    /** Called on the main thread when the model is loaded or unloaded. */
    var onLoadedChange: ((Boolean) -> Unit)?
        get() = lock.withLock { onLoadedChangeValue }
        set(value) = lock.withLock { onLoadedChangeValue = value }

    /** Requests waiting or running. */
    val queued: Int get() = lock.withLock { pending }

    // The serial queue (iOS: DispatchQueue "lostcity.local-model", userInitiated): immediate and delayed work on one thread.
    // (8 MB of stack: llama.cpp's grammar and graph code run on it)
    private val queue = ScheduledThreadPoolExecutor(1) { runnable ->
        Thread(null, runnable, "lostcity.local-model", 8L shl 20).apply { isDaemon = true }
    }.apply { removeOnCancelPolicy = true }
    private val lock = ReentrantLock()

    // (lock) shared with the main thread
    private var optionsValue = Options()
    private var loaded = false
    private var lastLoadValue: List<Double>? = null
    private var onLoadedChangeValue: ((Boolean) -> Unit)? = null
    private var suspended = false
    private var abortRequested = false
    private var pending = 0
    /** bumped by [release]: a request asked before it stops (the one running in native, those waiting at once) */
    private var epoch = 0
    private var variant: String? = null
    private var mappedValue = false

    /** No CPU backend loaded (set once, on the queue; read anywhere). */
    @Volatile private var runtimeMissing = false

    // (queue) llama.cpp state: the native model, its context and the tokens it holds
    private var handle = 0L
    private var idleWork: ScheduledFuture<*>? = null

    init {
        LlmLog.sink = log
    }

    // ------------------------------------------------------------------------------------------------------- requests

    /**
     * Writes one reply. [think]: the request asks for the note first (it is written when the model offers the choice,
     * [ThinkSupport.OPTION]; a model that always or never writes one does as it was trained). [deadlineNanos] (on
     * `System.nanoTime()`): past it the generation stops and fails with [Failure.Timeout]. The completion runs on the main
     * thread, with a [Failure] when it fails.
     */
    fun generate(system: String, user: String, think: Boolean, deadlineNanos: Long, completion: (Result<Output>) -> Unit) {
        val info = info
        if (!available || info == null) {
            val reason = unavailableReason ?: "no-model"
            main.post { completion(Result.failure(Failure.Unavailable(reason))) }
            return
        }
        val note = info.think.writesNote(think)
        val epoch = lock.withLock {
            pending += 1
            this.epoch
        }
        queue.execute {
            val result: Result<Output> = try {
                Result.success(run(system, user, note, deadlineNanos, epoch))
            } catch (failure: Failure) {
                Result.failure(failure)
            } catch (error: Throwable) {
                Result.failure(Failure.Failed(error.toString()))
            }
            lock.withLock { pending -= 1 }
            scheduleIdleUnload()
            main.post { completion(result) }
        }
    }

    /**
     * Loads the model now if it is not in memory (in the background, on the model's thread), so that the next request does
     * not wait for the load; the idle unload starts over.
     */
    fun warmUp() {
        if (!available) return
        queue.execute {
            if (handle == 0L && !lock.withLock { suspended }) {
                try {
                    load()
                } catch (error: Throwable) {
                    log.info("lm", "warming the local model failed: ${describe(error)}")
                }
            }
            scheduleIdleUnload()
        }
    }

    /** Frees the model (the idle timer, the background). A generation running finishes first. */
    fun unload(reason: String) {
        queue.execute { freeModel(reason) }
    }

    /**
     * Memory is short (a memory warning): the reply being written stops (native's stop flag), the requests waiting fail at
     * once ([Failure.Aborted]), and the model is freed right after them, not up to a reply's 9 s later. A request asked
     * after this loads it again if there is room ([Options.minFreeToLoad]).
     */
    fun release(reason: String) {
        lock.withLock {
            epoch += 1
            native?.setStop(true)
        }
        unload(reason)
    }

    /**
     * The app is inactive for a moment: the generation running stops at its next token (or, here, inside its prompt batch)
     * and nothing new starts until [resume], but the model stays loaded.
     */
    fun pause() {
        lock.withLock {
            suspended = true
            abortRequested = true
            native?.setStop(true)
        }
    }

    /** The app is in the background: as [pause], and the model is freed (no 0.5 GB held there). */
    fun suspend() {
        pause()
        unload("background")
    }

    fun resume() {
        lock.withLock {
            suspended = false
            abortRequested = false
            native?.setStop(false)
        }
    }

    /** Stops the model's thread (tests and the harness; the app's model lives as long as its process). */
    fun shutdown() {
        unload("shutdown")
        queue.shutdown()
        queue.awaitTermination(30, TimeUnit.SECONDS)
    }

    // --------------------------------------------------------------------------------------------- on the model's thread

    private fun shouldStop(deadlineNanos: Long, epoch: Int) {
        if (lock.withLock { abortRequested || suspended || epoch != this.epoch }) throw Failure.Aborted
        if (System.nanoTime() - deadlineNanos >= 0) throw Failure.Timeout
    }

    private fun scheduleIdleUnload() {
        idleWork?.cancel(false)
        idleWork = queue.schedule({
            if (lock.withLock { pending } == 0) freeModel("idle")
        }, options.idleUnloadMs, TimeUnit.MILLISECONDS)
    }

    private fun load(): Double {
        val info = info ?: throw Failure.Unavailable("no-model")
        val native = native ?: throw Failure.Unavailable("no-runtime")
        val minFree = options.minFreeToLoad
        availableMemory()?.let { free ->
            if (free < minFree) {
                log.info("lm", "the local model is not loaded: ${free shr 20} MB free, ${minFree shr 20} MB needed")
                throw Failure.Unavailable("memory")
            }
        }
        val started = System.nanoTime()
        LlmLog.loading = true
        try {
            if (lock.withLock { variant } == null) {
                val loadedVariant = native.init()
                if (loadedVariant == null) {
                    // (no CPU backend can run on this phone: the model is unavailable from now on, and the page hears so)
                    runtimeMissing = true
                    notifyLoaded(false)
                    throw Failure.Failed("no CPU backend for llama.cpp")
                }
                lock.withLock { variant = loadedVariant }
            }
            val opts = options
            val out = LoadOut()
            val loadedHandle = when (val source = info.source) {
                is ModelSource.Slice -> {
                    val slice = try {
                        source.open()
                    } catch (error: Exception) {
                        throw Failure.Failed("the model did not load (${error.javaClass.simpleName})")
                    }
                    slice.use {
                        native.load(it.fd, it.offset, null, info.ctx, opts.threads, opts.batchThreads, opts.gpuLayers, opts.mmap,
                            opts.repack, true, out)
                    }
                }
                is ModelSource.File -> native.load(-1, 0, source.path, info.ctx, opts.threads, opts.batchThreads, opts.gpuLayers,
                    opts.mmap, opts.repack, true, out)
            }
            if (loadedHandle == 0L) throw Failure.Failed(out.error ?: "the model did not load")
            handle = loadedHandle
            val elapsed = msSince(started)
            // (as Swift splits it: the model's part is everything up to the context, the backend's start included)
            val modelMs = elapsed - out.contextMs
            lock.withLock {
                loaded = true
                lastLoadValue = listOf(elapsed, modelMs, elapsed - modelMs)
                mappedValue = out.mmap
            }
            val gpu = if (opts.gpuLayers >= out.nLayer) "all" else opts.gpuLayers.toString()
            val mode = if (out.mmap) "mmap" else out.readReason ?: "read"
            log.info("lm", "local model loaded in ${elapsed.toInt()} ms (model ${modelMs.toInt()} ms, context ${(elapsed - modelMs).toInt()} ms): " +
                "${info.name} (${info.bytes / 1_048_576} MB, ${out.nLayer} layers, ctx ${out.ctx}, $gpu on the GPU, ${opts.threads} threads, $mode)")
            notifyLoaded(true)
            return elapsed
        } finally {
            LlmLog.loading = false
        }
    }

    private fun freeModel(reason: String) {
        idleWork?.cancel(false)
        idleWork = null
        if (handle == 0L) return
        native?.free(handle)
        handle = 0L
        lock.withLock { loaded = false }
        log.info("lm", "local model unloaded ($reason)")
        notifyLoaded(false)
    }

    private fun notifyLoaded(value: Boolean) {
        val callback = onLoadedChange ?: return
        main.post { callback(value) }
    }

    /** One reply; [note]: the model writes its note first (`generate` decided it from the request and the model). */
    private fun run(system: String, user: String, note: Boolean, deadlineNanos: Long, epoch: Int): Output {
        val native = native ?: throw Failure.Unavailable("no-runtime")
        val started = System.nanoTime()
        val timings = Timings()
        timings.think = note
        // (one look under the lock: a suspend between a check and the reset would otherwise be lost; native's stop flag is
        // stored in the same look)
        val suspendedNow = lock.withLock {
            if (!suspended) abortRequested = false
            native.setStop(abortRequested || suspended)
            suspended
        }
        if (suspendedNow) throw Failure.Unavailable("background")
        if (lock.withLock { this.epoch } != epoch) throw Failure.Aborted  // (asked before a release: not loaded again for it)
        if (handle == 0L) {
            timings.loadMs = load()
        }
        shouldStop(deadlineNanos, epoch)
        val opts = options
        val out = GenOut()
        val status = native.generate(
            handle, system.swiftTrim().toByteArray(Charsets.UTF_8), user.swiftTrim().toByteArray(Charsets.UTF_8), note,
            deadlineNanos - System.nanoTime(), opts.temperature, opts.topP, opts.topK, opts.repeatPenalty, opts.repeatLastN,
            opts.maxTokens, opts.maxChars, NOTE_MAX_TOKENS, Random.nextInt(), out,
        )
        timings.promptTokens = out.promptTokens
        timings.reusedTokens = out.reusedTokens
        timings.promptMs = out.promptMs
        timings.noteTokens = out.noteTokens
        timings.noteMs = out.noteMs
        timings.generatedTokens = out.generatedTokens
        timings.generateMs = out.generateMs
        timings.resampled = out.resampled
        when (status) {
            LlmNative.OK -> Unit
            LlmNative.ABORTED -> throw Failure.Aborted
            LlmNative.TIMEOUT -> throw Failure.Timeout
            else -> throw Failure.Failed(out.error ?: "?")
        }
        var noteText: String? = null
        if (note) {
            noteText = decodeUtf8(out.note).swiftTrim()
            if (!out.closed) log.info("lm", "the note ran to $NOTE_MAX_TOKENS tokens: closed for it")
        }
        timings.totalMs = msSince(started)
        return Output(decodeUtf8(out.text).swiftTrim(), timings, noteText)
    }

    companion object {
        const val NOTE_MAX_TOKENS = 64

        /** UTF-8 with U+FFFD for what is not (Swift's `String(decoding:as:)`): a token may end inside a character. */
        internal fun decodeUtf8(bytes: ByteArray?): String = if (bytes == null) "" else String(bytes, Charsets.UTF_8)

        /** A failure as Swift's `"\(error)"` prints it in the logs. */
        internal fun describe(error: Throwable): String = (error as? Failure)?.description ?: error.toString()
    }
}
