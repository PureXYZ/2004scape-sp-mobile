// What the unit tests share: a "main thread" of their own (BotChatModel is main-thread only, as the Swift class is
// @MainActor), a log that records, and a fake native layer with scripted loads and generations.
package io.github.purexyz.scape2004.botchat

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** A single thread standing in for Android's main looper. */
class TestMain : MainPoster {
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "test-main").apply { isDaemon = true } }

    override fun post(block: () -> Unit) {
        executor.execute(block)
    }

    /** Runs [block] on the main thread and waits for it. */
    fun <T> run(block: () -> T): T = executor.submit<T> { block() }.get(30, TimeUnit.SECONDS)

    /** Waits until everything posted so far has run. */
    fun drain() = run { }
}

class RecordingLog : LogSink {
    val lines = CopyOnWriteArrayList<String>()

    override fun info(tag: String, message: String) {
        lines += "[$tag] $message"
    }

    override fun debug(tag: String, message: () -> String) {
        lines += "debug [$tag] ${message()}"
    }

    fun has(fragment: String) = lines.any { it.contains(fragment) }
}

/** One generation as the fake saw it. */
class FakeGeneration(val system: String, val user: String, val note: Boolean, val remainingNanos: Long, val maxTokens: Int, val maxChars: Int)

/** A native layer without llama.cpp: loads succeed (or fail) as told, generations run the script. */
class FakeNative : LlmNative {
    var initResult: String? = "libggml-cpu-fake.so"
    var loadError: String? = null
    var loadDelayMs = 0L
    val loads = AtomicInteger()
    val frees = AtomicInteger()
    val stop = AtomicBoolean()
    val generations = CopyOnWriteArrayList<FakeGeneration>()
    val loadArgs = CopyOnWriteArrayList<List<Any?>>()

    /** The generation: fill [GenOut] and return a status. The default writes "hey there" (and a note when asked). */
    var script: (FakeGeneration, GenOut) -> Int = { call, out ->
        out.promptTokens = 300
        out.promptMs = 1000.0
        out.generatedTokens = 3
        out.generateMs = 50.0
        out.text = "  hey there \n".toByteArray()
        if (call.note) {
            out.note = " asks: hi. uses: nothing. tone: chill.\n".toByteArray()
            out.noteTokens = 12
            out.noteMs = 200.0
            out.closed = true
        }
        LlmNative.OK
    }

    override fun init(): String? = initResult

    override fun setStop(stop: Boolean) = this.stop.set(stop)

    override fun load(fd: Int, offset: Long, path: String?, ctx: Int, threads: Int, batchThreads: Int, gpuLayers: Int, mmap: Int,
                      repack: Boolean, cpuOnly: Boolean, out: LoadOut): Long {
        loads.incrementAndGet()
        loadArgs += listOf(fd, offset, path, ctx, threads, batchThreads, gpuLayers, mmap, repack, cpuOnly)
        if (loadDelayMs > 0) Thread.sleep(loadDelayMs)
        loadError?.let {
            out.error = it
            return 0
        }
        out.totalMs = 12.0
        out.contextMs = 2.0
        out.nLayer = 24
        out.ctx = ctx
        out.recurrent = true
        out.mmap = fd < 0 || offset % 32 == 0L
        if (!out.mmap) out.readReason = "read: not 32-byte aligned in the APK"
        return 42
    }

    override fun free(handle: Long) {
        frees.incrementAndGet()
    }

    override fun generate(handle: Long, system: ByteArray, user: ByteArray, note: Boolean, remainingNanos: Long, temp: Float,
                          topP: Float, topK: Int, repeatPenalty: Float, repeatLastN: Int, maxTokens: Int, maxChars: Int,
                          noteMaxTokens: Int, seed: Int, out: GenOut): Int {
        val call = FakeGeneration(String(system), String(user), note, remainingNanos, maxTokens, maxChars)
        generations += call
        return script(call, out)
    }
}

/** A model.json-shaped ModelInfo for the fake (no file behind it). */
fun fakeInfo(template: String = ThinkSupport.HYBRID_TEMPLATE) = ModelInfo(
    name = "2004 chat (test)", file = "bots-2004.gguf", bytes = 529_297_728, sha256 = "e863", ctx = 1024, template = template,
    source = ModelSource.File("/nonexistent/bots-2004.gguf"),
)

/** Replies by arrival. */
class Replies {
    val queue = LinkedBlockingQueue<Map<String, Any?>>()

    fun next(seconds: Long = 10): Map<String, Any?> = queue.poll(seconds, TimeUnit.SECONDS) ?: error("no reply in $seconds s")

    fun none(ms: Long = 200): Boolean = queue.poll(ms, TimeUnit.MILLISECONDS) == null
}

fun request(id: Any?, mode: String = "local", think: Boolean? = null, fallback: Boolean? = null, timeoutMs: Any? = 9000): Map<String, Any?> {
    val message = linkedMapOf<String, Any?>(
        "type" to "lm", "id" to id, "mode" to mode,
        "local" to mapOf("system" to "  You are a bot.\n", "user" to "hi\u0085"),
        "online" to mapOf("system" to "guide", "context" to "facts", "user" to "hi"),
        "maxChars" to 80, "timeoutMs" to timeoutMs,
    )
    if (think != null) message["think"] = think
    if (fallback != null) message["fallback"] = fallback
    return message
}
