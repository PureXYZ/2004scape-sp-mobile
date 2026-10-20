// The native half of the on-device chat model: liblcllm, the C++ core and its JNI layer
// (android/llm/src/main/cpp). The iOS app calls llama.cpp from Swift directly; Kotlin cannot, so LocalModel.kt keeps the
// Swift class's queue, lock, timings and failures and hands the llama.cpp part (load, the generation loop) to this. The
// same library name loads on Android (from the APK) and on the Mac JVM (the harness: -Djava.library.path), so LocalModel
// runs the same code in both. The unit tests swap in a fake [LlmNative].
package io.github.purexyz.scape2004.botchat

import java.util.concurrent.atomic.AtomicReference

/** What LocalModel needs from native code; [LlmJni] is the real one. Text crosses as UTF-8 bytes. */
interface LlmNative {
    /**
     * Installs llama.cpp's log callback, loads ggml's CPU backend and initialises llama.cpp, once. Returns the CPU variant
     * loaded (Android: e.g. "libggml-cpu-android_armv8.2_2.so"; "" on the Mac), or null when no backend loads here.
     */
    fun init(): String?

    /** LocalModel's `abortRequested || suspended`, stored under its lock. */
    fun setStop(stop: Boolean)

    /**
     * Loads the GGUF (from [fd] at [offset], or from [path] when [fd] is negative) and makes its context. Returns a handle,
     * or 0 with [LoadOut.error] set. [mmap]: -1 when aligned, 0 never, 1 always.
     */
    fun load(fd: Int, offset: Long, path: String?, ctx: Int, threads: Int, batchThreads: Int, gpuLayers: Int, mmap: Int,
             repack: Boolean, cpuOnly: Boolean, out: LoadOut): Long

    fun free(handle: Long)

    /**
     * One reply (LocalModel.swift's `run` from the prompt on). Returns 0 (done), 1 (stopped: a pause), 2 (the deadline) or
     * 3 (failed: [GenOut.error]). [remainingNanos]: the time left until the request's deadline.
     */
    fun generate(handle: Long, system: ByteArray, user: ByteArray, note: Boolean, remainingNanos: Long, temp: Float,
                 topP: Float, topK: Int, repeatPenalty: Float, repeatLastN: Int, maxTokens: Int, maxChars: Int,
                 noteMaxTokens: Int, seed: Int, out: GenOut): Int

    companion object {
        const val OK = 0
        const val ABORTED = 1
        const val TIMEOUT = 2
        const val FAILED = 3
    }
}

/** A load's outcome (filled by native code: the field names are its contract, kept by the consumer ProGuard rules). */
class LoadOut {
    @JvmField var totalMs = 0.0
    @JvmField var modelMs = 0.0
    @JvmField var contextMs = 0.0
    @JvmField var nLayer = 0
    @JvmField var ctx = 0
    @JvmField var recurrent = false
    /** mapped from the file (else read into memory, with the reason in [readReason]) */
    @JvmField var mmap = false
    @JvmField var readReason: String? = null
    @JvmField var error: String? = null
}

/** A generation's outcome (filled by native code, as [LoadOut]). The text and the note are raw UTF-8, untrimmed. */
class GenOut {
    @JvmField var text: ByteArray? = null
    @JvmField var note: ByteArray? = null
    /** the model closed its note itself (else it was closed for it, at 64 tokens or at an end of generation) */
    @JvmField var closed = false
    @JvmField var promptTokens = 0
    @JvmField var reusedTokens = 0
    @JvmField var generatedTokens = 0
    @JvmField var resampled = 0
    @JvmField var noteTokens = 0
    @JvmField var promptMs = 0.0
    @JvmField var noteMs = 0.0
    @JvmField var generateMs = 0.0
    @JvmField var error: String? = null
}

/** liblcllm through JNI. [loaded] is false when the library is not there (then the model is unavailable, `no-runtime`). */
object LlmJni : LlmNative {
    private val failure = AtomicReference<Throwable?>(null)

    /** Whether liblcllm (and llama.cpp's libraries it links) loaded. Tried once. */
    val loaded: Boolean by lazy {
        try {
            System.loadLibrary("lcllm")
            true
        } catch (t: Throwable) {
            failure.set(t)
            false
        }
    }

    /** Why [loaded] is false, for the log. */
    val loadError: Throwable? get() = failure.get()

    override fun init(): String? = nativeInit()

    override fun setStop(stop: Boolean) = nativeSetStop(stop)

    override fun load(fd: Int, offset: Long, path: String?, ctx: Int, threads: Int, batchThreads: Int, gpuLayers: Int,
                      mmap: Int, repack: Boolean, cpuOnly: Boolean, out: LoadOut): Long =
        nativeLoad(fd, offset, path?.toByteArray(Charsets.UTF_8), ctx, threads, batchThreads, gpuLayers, mmap, repack, cpuOnly, out)

    override fun free(handle: Long) = nativeFree(handle)

    override fun generate(handle: Long, system: ByteArray, user: ByteArray, note: Boolean, remainingNanos: Long, temp: Float,
                          topP: Float, topK: Int, repeatPenalty: Float, repeatLastN: Int, maxTokens: Int, maxChars: Int,
                          noteMaxTokens: Int, seed: Int, out: GenOut): Int =
        nativeGenerate(handle, system, user, note, remainingNanos, temp, topP, topK, repeatPenalty, repeatLastN, maxTokens,
            maxChars, noteMaxTokens, seed, out)

    @JvmStatic private external fun nativeInit(): String?

    @JvmStatic private external fun nativeSetStop(stop: Boolean)

    @JvmStatic private external fun nativeLoad(fd: Int, offset: Long, path: ByteArray?, ctx: Int, threads: Int, batchThreads: Int,
                                               gpuLayers: Int, mmap: Int, repack: Boolean, cpuOnly: Boolean, out: LoadOut): Long

    @JvmStatic private external fun nativeFree(handle: Long)

    @JvmStatic private external fun nativeGenerate(handle: Long, system: ByteArray, user: ByteArray, note: Boolean,
                                                   remainingNanos: Long, temp: Float, topP: Float, topK: Int,
                                                   repeatPenalty: Float, repeatLastN: Int, maxTokens: Int, maxChars: Int,
                                                   noteMaxTokens: Int, seed: Int, out: GenOut): Int
}

/**
 * llama.cpp's own log lines (native code calls [line] on the model's thread), filtered as the iOS app does (LM-16):
 * errors and warnings always reach the app's log; while the model loads, its account of the load does too (where the time
 * goes), without the per-tensor and per-key lines; everything else is debug output.
 */
object LlmLog {
    @Volatile var sink: LogSink? = null

    /** LocalModel.swift's `loading`: set around a load on the model's thread. */
    @Volatile var loading = false

    private const val WARN = 3
    private const val ERROR = 4

    private val noisy = listOf(
        "llama_model_loader: - ", "load_tensors: layer", "print_info:", "load: control token", "llama_kv_cache: layer",
        "llama_memory_recurrent, layer", "llama_memory_recurrent: layer", "graph_reserve:", "load:   - ",
        "llama_model_loader: Dumping",
        // [Android] ggml's CPU backend repacks every weight at load, a line each (iOS runs on Metal and never sees them)
        "repack: repack tensor",
        // [Android] llama.cpp's debug account of every tensor it creates and every graph input it reserves (about 950
        // lines a load at b11297). The iOS filter (LocalModel.swift) lets them through too, as the load's own lines;
        // it is left as it is there.
        "create_tensor: loading tensor", "llama_graph_n_input_tensors:",
    )

    @JvmStatic
    fun line(level: Int, text: ByteArray) {
        val sink = sink ?: return
        val line = String(text, Charsets.UTF_8).swiftTrimNewlines()
        if (line.isEmpty() || line == ".") return
        when {
            level == ERROR || level == WARN -> sink.info("llama", line)
            loading && noisy.none { line.startsWith(it) } -> sink.info("llama", line)
            else -> sink.debug("llama") { line }
        }
    }
}
