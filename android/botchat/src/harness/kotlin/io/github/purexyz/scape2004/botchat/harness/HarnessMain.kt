// The bots' chat model's native router on the Mac JVM (android/test/native/lm-harness.mjs builds liblcllm.dylib and runs
// this): the app's own BotChatModel, OnlineModel and LocalModel (:botchat) with the C++ core (android/llm/src/main/cpp,
// built for macOS against llama.cpp b11297's macOS prebuilt, CPU only, as on Android) against the local mock of the
// Messages API (web/test/lm/mock-claude.mjs), so the online path is tested without a key and the fallback chain without a
// phone. The Kotlin port of the iOS harness, web/test/native/lm-harness/main.swift: the same 49 checks, with the same names
// in the same order, then the Android extras A1-A5:
//   A1 the GGUF read through a file descriptor at an offset (an APK's stored asset): mmapped when aligned, read when not
//   A2 a pause stops a long prompt inside its batch (llama.cpp's abort callback), and the next request works
//   A3 the compute buffer stays small (n_outputs_max 1)
//   A4 a note that is not UTF-8 breaks nothing (a fake native layer)
//   A5 every request the mock got is exactly the iPhone's body, with and without the bot's facts
//
//   lm-harness <mock url> <model folder | none> <bench-prompts.json>
// Prints `CHECK <ok|FAIL> <name> — <detail>` lines and `DONE pass=N fail=M`.
package io.github.purexyz.scape2004.botchat.harness

import io.github.purexyz.scape2004.botchat.BotChatModel
import io.github.purexyz.scape2004.botchat.FdSlice
import io.github.purexyz.scape2004.botchat.GenOut
import io.github.purexyz.scape2004.botchat.JsonBridge
import io.github.purexyz.scape2004.botchat.LlmJni
import io.github.purexyz.scape2004.botchat.LlmNative
import io.github.purexyz.scape2004.botchat.LoadOut
import io.github.purexyz.scape2004.botchat.LocalModel
import io.github.purexyz.scape2004.botchat.LogSink
import io.github.purexyz.scape2004.botchat.MainPoster
import io.github.purexyz.scape2004.botchat.MemoryKeyStore
import io.github.purexyz.scape2004.botchat.ModelInfo
import io.github.purexyz.scape2004.botchat.ModelSource
import io.github.purexyz.scape2004.botchat.OnlineModel
import io.github.purexyz.scape2004.botchat.ThermalLevel
import io.github.purexyz.scape2004.botchat.ThermalProvider
import io.github.purexyz.scape2004.botchat.ThinkSupport
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import java.io.File
import java.io.FileDescriptor
import java.io.RandomAccessFile
import java.net.URI
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.system.exitProcess

/** ios/LostCity/Log.swift's lines for the harness (stdout, prefixed so the runner can tell them apart), kept for A3. */
object HarnessLog : LogSink {
    private val verbose = System.getenv("LM_VERBOSE") == "1"
    val lines = CopyOnWriteArrayList<String>()

    override fun info(tag: String, message: String) {
        lines += "[$tag] $message"
        println("LOG [$tag] $message")
    }

    override fun debug(tag: String, message: () -> String) {
        if (verbose) println("LOG [$tag] ${message()}")
    }
}

/** The main thread (BotChatModel's): one thread, which the harness waits on. */
class HarnessMain : MainPoster {
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "harness-main").apply { isDaemon = true } }

    override fun post(block: () -> Unit) {
        executor.execute(block)
    }

    fun <T> run(block: () -> T): T = executor.submit<T> { block() }.get(120, TimeUnit.SECONDS)
}

class Harness(private val modelInfo: ModelInfo?, private val mockUrl: String, private val local: Map<String, Any?>, private val online: Map<String, Any?>) {
    val main = HarnessMain()
    val model: BotChatModel = main.run {
        BotChatModel(LocalModel(modelInfo, if (LlmJni.loaded) LlmJni else null, main, HarnessLog), OnlineModel(main), MemoryKeyStore(), HarnessLog)
    }
    @Volatile var key: String? = null
    /** replies as JSON text, by id (as the Swift harness keeps them: what the page would parse) */
    private val replies = ConcurrentHashMap<Int, LinkedBlockingQueue<String>>()
    private var nextId = 1
    var pass = 0
    var fail = 0

    init {
        main.run {
            model.online.endpoint = mockUrl
            model.readKey = { key }
            model.onReply = { reply ->
                val id = reply["id"] as Int
                queueFor(id).put(JsonBridge.toJson(reply).toString())
            }
        }
    }

    private fun queueFor(id: Int) = replies.computeIfAbsent(id) { LinkedBlockingQueue() }

    fun check(name: String, ok: Boolean, detail: String = "") {
        if (ok) pass++ else fail++
        println("CHECK ${if (ok) "ok" else "FAIL"} $name${if (detail.isEmpty()) "" else " — $detail"}")
    }

    /** A request as the page sends it; its id. `think`: Settings › Bot chat › Think first (null: a request without it). */
    fun send(mode: String, fallback: Boolean? = null, think: Boolean? = null, timeoutMs: Int = 9000, onlinePrompt: Map<String, Any?> = online): Int {
        val id = nextId++
        val message = linkedMapOf<String, Any?>("type" to "lm", "id" to id, "mode" to mode, "local" to local, "online" to onlinePrompt, "maxChars" to 80, "timeoutMs" to timeoutMs)
        if (fallback != null) message["fallback"] = fallback
        if (think != null) message["think"] = think
        main.run { model.handle(message) }
        return id
    }

    /** The reply to request `id`, as the page hears it. */
    fun answer(id: Int): Map<String, Any?> {
        val json = queueFor(id).poll(120, TimeUnit.SECONDS) ?: return emptyMap()
        return JsonBridge.toMap(Json.parseToJsonElement(json) as JsonObject)
    }

    fun ask(mode: String, fallback: Boolean? = null, think: Boolean? = null, timeoutMs: Int = 9000): Map<String, Any?> =
        answer(send(mode, fallback, think, timeoutMs))

    /** The on-device model asked directly (not through the router): its whole output, the note included. */
    fun generate(localModel: LocalModel, think: Boolean): Result<LocalModel.Output> {
        val result = LinkedBlockingQueue<Result<LocalModel.Output>>()
        localModel.generate(local["system"] as? String ?: "", local["user"] as? String ?: "", think, System.nanoTime() + 30_000_000_000L) { result.put(it) }
        return result.poll(120, TimeUnit.SECONDS) ?: Result.failure(IllegalStateException("no answer"))
    }

    @Suppress("UNCHECKED_CAST")
    val onlineStatus: Map<String, Any?> get() = main.run { model.status["online"] as Map<String, Any?> }

    @Suppress("UNCHECKED_CAST")
    val localStatus: Map<String, Any?> get() = main.run { model.status["local"] as Map<String, Any?> }

    val localThink: String? get() = localStatus["think"] as? String

    fun describe(reply: Map<String, Any?>): String =
        "source ${reply["source"] ?: "?"}, error ${reply["error"] ?: "none"}, ${(reply["ms"] as? Number)?.toInt() ?: -1} ms: ${reply["text"] as? String ?: "(no text)"}"

    @Suppress("UNCHECKED_CAST")
    private fun timingsOf(reply: Map<String, Any?>) = reply["timings"] as? Map<String, Any?> ?: emptyMap()

    /** The timings' note fields, for a check's detail. */
    fun noteOf(reply: Map<String, Any?>): String {
        val t = timingsOf(reply)
        return "think ${(t["think"] as? Boolean)?.let { if (it) "on" else "off" } ?: "-"}, note ${t["noteTokens"] ?: "-"} tokens in ${t["noteMs"] ?: "-"} ms, reply ${t["generatedTokens"] ?: "-"} tokens, total ${t["totalMs"] ?: "-"} ms"
    }

    /** A reply written with the note (timings' think, noteTokens > 0) whose text has no trace of the think block. */
    fun notedReply(reply: Map<String, Any?>): Boolean {
        val t = timingsOf(reply)
        val text = reply["text"] as? String ?: ""
        return t["think"] == true && ((t["noteTokens"] as? Number)?.toInt() ?: 0) > 0 && !reply.containsKey("note") && !text.contains("think>")
    }

    /** A reply written without the note. */
    fun plainReply(reply: Map<String, Any?>): Boolean {
        val t = timingsOf(reply)
        return t["think"] == false && !t.containsKey("noteTokens") && !t.containsKey("noteMs") && !reply.containsKey("note")
    }

    private fun isNull(reply: Map<String, Any?>, key: String) = reply.containsKey(key) && reply[key] == null

    private fun waitLoaded(localModel: LocalModel, seconds: Int = 60): Boolean {
        var waited = 0
        while (!localModel.isLoaded && waited < seconds * 10) {
            Thread.sleep(100)
            waited++
        }
        return localModel.isLoaded
    }

    fun run() {
        val hasLocal = model.local.available
        println("INFO local model: ${modelInfo?.name ?: "none"} (available $hasLocal${if (!LlmJni.loaded) ", liblcllm: ${LlmJni.loadError}" else ""})")

        // warm: the model loads ahead of the first request (the page asks when the player enters the world)
        if (hasLocal) {
            main.run { model.warm() }
            waitLoaded(model.local)
            check("warm: the model loads ahead of the first request", model.local.isLoaded, "load ${model.local.lastLoad?.map { it.toInt() } ?: "?"} ms (total, model, context)")
        }

        // no key: the status says so; Claude online with the fallback answers from the model in the app (or not at all)
        key = null
        check("status: no key, the model in the app as it is", onlineStatus["keySet"] == false && localStatus["available"] == hasLocal, "${main.run { model.status }}")
        var reply = ask("online")
        check("online without a key: the on-device model answers (else unavailable)", if (hasLocal) reply["source"] == "local" && reply["text"] is String else reply["error"] == "unavailable", describe(reply))
        reply = ask("online", fallback = false)
        check("online without a key, no fallback (the Test): unavailable", reply["error"] == "unavailable" && isNull(reply, "text"), describe(reply))
        key = "sk-ant-test-ok-abcd"
        reply = ask("rules")
        check("a request in Rules mode is answered with nothing (unavailable), even with a key", isNull(reply, "text"), describe(reply))
        key = null

        if (hasLocal) {
            reply = ask("local")
            check("local: a line from the model in the app, with its timings", reply["source"] == "local" && (reply["text"] as? String)?.isNotEmpty() == true && ((timingsOf(reply)["promptTokens"] as? Number)?.toInt() ?: 0) > 0, describe(reply))
        } else {
            reply = ask("local")
            check("local with no model in the app: unavailable at once", reply["error"] == "unavailable", describe(reply))
        }

        // Think first: the status says whether the model writes its short note before a reply (model.json's template); one
        // trained in both modes ('qwen-chatml-hybrid') writes it when the request asks (think), and the note is never part
        // of the reply
        val support = if (hasLocal) modelInfo?.think?.raw ?: "never" else "never"
        check("status: local.think says whether the model writes its note ($support, template ${modelInfo?.template ?: "none"})", localThink == support, "$localStatus")
        if (model.local.thinkSupport == ThinkSupport.OPTION) {
            reply = ask("local", think = false)
            check("think off: the reply at once, no note", reply["source"] == "local" && plainReply(reply), "${describe(reply)}; ${noteOf(reply)}")
            val plainMs = (timingsOf(reply)["totalMs"] as? Number)?.toDouble() ?: 0.0
            reply = ask("local")
            check("a request without think: as off", reply["source"] == "local" && plainReply(reply), "${describe(reply)}; ${noteOf(reply)}")
            reply = ask("local", think = true)
            check("think on: the note first (noteTokens), then the reply; nothing of the note in what the page gets", reply["source"] == "local" && notedReply(reply), "${describe(reply)}; ${noteOf(reply)} (off: ${plainMs.toInt()} ms)")
            // the model's whole output: the note it wrote, and the reply apart from it
            val name = "think on, the model's own output: a note, and a reply that does not contain it"
            val output = generate(model.local, think = true)
            output.onSuccess {
                val note = it.note ?: ""
                check(name, note.isNotEmpty() && !it.text.contains(note) && !it.text.contains("think>") && it.timings.noteTokens > 0,
                    "note ${it.timings.noteTokens} tokens: ${note.take(160).replace("\n", " / ")}… | reply: ${it.text}")
            }.onFailure { check(name, false, "$it") }
            reply = ask("local", think = false)
            check("think off again: no note (the switch is per request)", reply["source"] == "local" && plainReply(reply), "${describe(reply)}; ${noteOf(reply)}")
        }

        // a good key: Claude answers; the status learns the key works and shows its last four characters
        key = "sk-ant-test-ok-abcd"
        reply = ask("online")
        check("online: Claude's line (source online, usage)", reply["source"] == "online" && reply["text"] == "hey whats up" && reply["usage"] != null, describe(reply))
        check("status: key set, ends in …abcd, valid", onlineStatus["keySet"] == true && onlineStatus["hint"] == "…abcd" && onlineStatus["valid"] == true, "$onlineStatus")
        reply = ask("online")
        @Suppress("UNCHECKED_CAST") val usage = reply["usage"] as? Map<String, Any?>
        check("online again: the guide is read from the cache", ((usage?.get("cacheRead") as? Number)?.toInt() ?: 0) > 0, "${usage ?: emptyMap<String, Any?>()}")
        // (Claude online ignores think: its request stays the same, which the runner checks in every request the mock got)
        reply = ask("online", think = true)
        check("online with think: Claude's line, as without it", reply["source"] == "online" && reply["text"] is String && !reply.containsKey("timings"), describe(reply))

        // failures fall back to the model in the app; the status says what went wrong
        for ((problemKey, problem, reason) in listOf(
            Triple("sk-ant-test-bad-1234", "key refused", "refused"), Triple("sk-ant-test-rate-1111", "rate limited", "failed: rate limited"),
            Triple("sk-ant-test-busy-2222", "overloaded", "failed: overloaded"), Triple("sk-ant-test-broke-3333", "error 500", "failed: http 500"),
            Triple("sk-ant-test-refuse-4444", "declined", "refused"), Triple("sk-ant-test-empty-5555", "empty reply", "failed: empty"),
        )) {
            key = problemKey
            reply = ask("online")
            val fellBack = if (hasLocal) reply["source"] == "local" && reply["text"] is String else reply["error"] == reason
            check("online, $problem: ${if (hasLocal) "the on-device model answers" else "null, $reason"}", fellBack, describe(reply))
            val status = onlineStatus
            check("status after $problem", status["problem"] == problem && (if (problem == "key refused") status["valid"] == false else true), "$status")
            reply = ask("online", fallback = false)
            check("online, $problem, no fallback (the Test): null, $reason", isNull(reply, "text") && reply["error"] == reason, describe(reply))
        }

        // Claude's fallback to the on-device model keeps the request's think (Claude failing, or no key)
        if (model.local.thinkSupport == ThinkSupport.OPTION) {
            key = "sk-ant-test-broke-8888"
            reply = ask("online", think = true)
            check("online, Claude failing, think on: the on-device model answers with its note", reply["source"] == "local" && notedReply(reply), "${describe(reply)}; ${noteOf(reply)}")
            reply = ask("online", think = false)
            check("online, Claude failing, think off: the on-device model answers without one", reply["source"] == "local" && plainReply(reply), "${describe(reply)}; ${noteOf(reply)}")
            key = null
            reply = ask("online", think = true)
            check("online without a key, think on: the on-device model answers with its note", reply["source"] == "local" && notedReply(reply), "${describe(reply)}; ${noteOf(reply)}")
        }

        // the template decides who decides: a note variant writes its note always, the first 2004 model (and a template this
        // build does not know) never, whatever the request asks; the status says which (the same GGUF, told otherwise)
        if (hasLocal && modelInfo != null) {
            for ((template, support2, asked) in listOf(
                Triple(ThinkSupport.THINK_TEMPLATE, "always", false), Triple(ThinkSupport.PLAIN_TEMPLATE, "never", true), Triple("qwen-chatml-unknown", "never", true),
            )) {
                val variant = modelInfo.copy(template = template)
                val other = main.run { BotChatModel(LocalModel(variant, LlmJni, main, HarnessLog), OnlineModel(main), MemoryKeyStore(), HarnessLog) }
                @Suppress("UNCHECKED_CAST") val status = main.run { (other.status["local"] as Map<String, Any?>)["think"] as? String }
                val writes = support2 == "always"
                val name = "template $template: status think '$support2'; asked ${if (asked) "on" else "off"}, ${if (writes) "the note anyway" else "no note"}"
                generate(other.local, asked).onSuccess {
                    check(name, status == support2 && it.timings.think == writes && (it.timings.noteTokens > 0) == writes && (it.note != null) == writes,
                        "status ${status ?: "-"}, note ${it.timings.noteTokens} tokens, reply: ${it.text}")
                }.onFailure { check(name, false, "$it") }
                other.local.shutdown()
            }
        }

        // a slow API: Claude is given up on within the request's time
        key = "sk-ant-test-slow-6666"
        val started = System.nanoTime()
        reply = ask("online", fallback = false, timeoutMs = 3000)
        val waited = (System.nanoTime() - started) / 1e9
        check("online, slow: given up within the request's 3 s (timeout)", reply["error"] == "timeout" && waited < 4.5, "${"%.1f".format(waited)} s, ${describe(reply)}")

        // a hot phone: no on-device reply ('busy'), Claude still answers
        if (hasLocal) {
            main.run { model.thermal = ThermalProvider.fixed(ThermalLevel.SERIOUS) }
            key = null
            reply = ask("local")
            check("a hot phone (thermal serious): the on-device model does not run (busy)", reply["error"] == "busy" && isNull(reply, "text"), describe(reply))
            key = "sk-ant-test-ok-hot1"
            reply = ask("online")
            check("a hot phone: Claude online still answers", reply["source"] == "online", describe(reply))
            main.run { model.thermal = ThermalProvider.NOMINAL }
        }

        // memory: a load needs room; a memory warning stops the reply being written and drops those waiting
        if (hasLocal) {
            val tight = LocalModel(modelInfo, LlmJni, main, HarnessLog) { 100L shl 20 }
            val refused = generate(tight, false)
            check("100 MB left for the app: the model is not loaded (unavailable)", (refused.exceptionOrNull() as? LocalModel.Failure)?.description == "unavailable" && !tight.isLoaded, "$refused")

            val roomy = LocalModel(modelInfo, LlmJni, main, HarnessLog) { 2048L shl 20 }
            generate(roomy, false)
            val released = (0 until 2).map { LinkedBlockingQueue<Result<LocalModel.Output>>() }
            for ((i, think) in listOf(true, false).withIndex()) {
                roomy.generate(local["system"] as? String ?: "", local["user"] as? String ?: "", think, System.nanoTime() + 30_000_000_000L) { released[i].put(it) }
            }
            Thread.sleep(50)
            val warned = System.nanoTime()
            roomy.release("harness: memory warning")
            val results = released.map { it.poll(10, TimeUnit.SECONDS) }
            while (roomy.isLoaded && System.nanoTime() - warned < 10_000_000_000L) Thread.sleep(10)
            val freedIn = (System.nanoTime() - warned) / 1e9
            fun aborted(result: Result<LocalModel.Output>?) = (result?.exceptionOrNull() as? LocalModel.Failure)?.description == "failed: interrupted"
            check("a memory warning: the reply being written stops (interrupted)", aborted(results[0]), "${results[0] ?: "none"}")
            check("a memory warning: the request waiting is dropped (interrupted)", aborted(results[1]), "${results[1] ?: "none"}")
            check("a memory warning: the model is freed within 1 s", !roomy.isLoaded && freedIn < 1, "${(freedIn * 1000).toInt()} ms")
            val after = generate(roomy, false)
            check("a request after the warning loads the model again", after.isSuccess && roomy.isLoaded, "$after")
            roomy.unload("harness: memory")
        }

        // more than 3 at once: busy
        key = "sk-ant-test-slow-7777"
        val ids = (0 until 4).map { send("online", fallback = false, timeoutMs = 2000) }
        val errors = ids.map { answer(it)["error"] as? String ?: "-" }
        check("4 requests at once: the fourth is busy at once, the others wait", errors == listOf("timeout", "timeout", "timeout", "busy"), errors.joinToString(", "))
        key = null

        androidExtras(hasLocal)
        println("DONE pass=$pass fail=$fail")
    }

    // ------------------------------------------------------------------------------------------- the Android extras A1-A5

    private fun androidExtras(hasLocal: Boolean) {
        val info = modelInfo
        if (hasLocal && info != null) {
            val gguf = File((info.source as ModelSource.File).path)
            val out = File(System.getProperty("lm.harness.out") ?: "build/tmp/lm-harness")
            out.mkdirs()
            // A1: the GGUF inside another file at an offset, read through a descriptor (as an APK's stored asset is)
            for ((padding, mapped) in listOf(7 to false, 32 to true)) {
                val padded = File(out, "padded-$padding.gguf")
                padded.outputStream().buffered(1 shl 20).use { sink ->
                    sink.write(ByteArray(padding) { 0x5A })
                    gguf.inputStream().use { it.copyTo(sink, 1 shl 20) }
                }
                val file = RandomAccessFile(padded, "r")
                val fd = descriptorOf(file.fd)
                val sliced = info.copy(source = ModelSource.Slice { FdSlice(fd, padding.toLong(), gguf.length()) {} })
                val sliceModel = LocalModel(sliced, LlmJni, main, HarnessLog)
                val output = generate(sliceModel, false)
                val name = "A1 the GGUF at offset $padding of a file, by descriptor: ${if (mapped) "mmapped" else "read (not 32-byte aligned)"}, and it writes"
                check(name, output.isSuccess && output.getOrNull()?.text?.isNotEmpty() == true && sliceModel.mapped == mapped,
                    "mapped ${sliceModel.mapped}, load ${sliceModel.lastLoad?.map { it.toInt() }} ms, ${output.getOrNull()?.text ?: output.exceptionOrNull()}")
                sliceModel.shutdown()
                file.close()
                padded.delete()
            }

            // A2: a pause stops a long prompt inside its batch, at once, and the next request after resume works
            key = null
            waitLoaded(model.local)
            val id = send("local")
            Thread.sleep(50)
            val paused = System.nanoTime()
            main.run { model.pause() }
            val stopped = answer(id)
            val stopMs = (System.nanoTime() - paused) / 1e6
            main.run { model.resume() }
            val after = ask("local")
            check("A2 a pause 50 ms into a request: failed: interrupted within 300 ms, and the next one answers",
                stopped["error"] == "failed: interrupted" && stopMs < 300 && after["source"] == "local",
                "stopped in ${stopMs.toInt()} ms: ${describe(stopped)}; then ${describe(after)}")

            // A3: one output, so a small compute buffer (the default reserves 490 MB)
            val buffers = HarnessLog.lines.mapNotNull { Regex("CPU compute buffer size =\\s*([0-9.]+) MiB").find(it)?.groupValues?.get(1)?.toDouble() }
            check("A3 the compute buffer is at most 64 MiB (n_outputs_max 1)", buffers.isNotEmpty() && buffers.all { it <= 64 }, "${buffers.map { "$it MiB" }}")
        }

        // A4: a note whose bytes are not UTF-8 (a token can end inside a character) breaks neither the note nor the reply
        val fake = object : LlmNative {
            override fun init() = ""
            override fun setStop(stop: Boolean) = Unit
            override fun load(fd: Int, offset: Long, path: String?, ctx: Int, threads: Int, batchThreads: Int, gpuLayers: Int, mmap: Int, repack: Boolean, cpuOnly: Boolean, out: LoadOut): Long {
                out.nLayer = 24
                out.ctx = ctx
                out.mmap = true
                return 1
            }
            override fun free(handle: Long) = Unit
            override fun generate(handle: Long, system: ByteArray, user: ByteArray, note: Boolean, remainingNanos: Long, temp: Float, topP: Float, topK: Int, repeatPenalty: Float, repeatLastN: Int, maxTokens: Int, maxChars: Int, noteMaxTokens: Int, seed: Int, out: GenOut): Int {
                out.note = byteArrayOf(0x61, 0xE2.toByte(), 0x82.toByte(), 0x20, 0xFF.toByte(), 0x62)
                out.closed = true
                out.noteTokens = 3
                out.text = "lol nm u".toByteArray()
                out.generatedTokens = 4
                return LlmNative.OK
            }
        }
        val fakeModel = LocalModel(ModelInfo("fake", "fake.gguf", 1, "", 1024, ThinkSupport.HYBRID_TEMPLATE, ModelSource.File("/fake.gguf")), fake, main, HarnessLog)
        val fakeOut = generate(fakeModel, true)
        check("A4 a note that is not UTF-8: U+FFFD in the note, the reply as it was", fakeOut.getOrNull()?.note?.contains('�') == true && fakeOut.getOrNull()?.text == "lol nm u",
            "note '${fakeOut.getOrNull()?.note}', reply '${fakeOut.getOrNull()?.text}'")
        fakeModel.shutdown()

        // A5: the body on the wire is the iPhone's, field for field, with the bot's facts and without them
        key = "sk-ant-test-ok-nctx"
        val withoutFacts = online.toMutableMap().apply { this["context"] = "" }
        val noContext = answer(send("online", fallback = false, onlinePrompt = withoutFacts))
        key = null
        val requests = runCatching {
            val base = mockUrl.removeSuffix("/v1/messages")
            Json.parseToJsonElement(URI("$base/requests").toURL().readText()) as JsonArray
        }.getOrNull()
        val fields = setOf("model", "max_tokens", "thinking", "output_config", "system", "messages")
        val bodies = requests?.map { JsonBridge.toAny((it as JsonObject)["body"]) as? Map<*, *> } ?: emptyList()
        val problems = requests?.flatMap { JsonBridge.toAny((it as JsonObject)["problems"]) as? List<*> ?: emptyList<Any>() } ?: listOf("no /requests")
        val systems = bodies.map { (it?.get("system") as? List<*>)?.size }
        check("A5 every request is the iPhone's body exactly (${bodies.size}): its fields, the facts' block only when there are facts",
            noContext["source"] == "online" && problems.isEmpty() && bodies.isNotEmpty() && bodies.all { it?.keys == fields } && systems.last() == 1 && systems.dropLast(1).all { it == 2 },
            "problems $problems; system blocks ${systems.groupingBy { it }.eachCount()}; the last: ${OnlineModel.body("…", "", "…")}")
    }

    /** A RandomAccessFile's descriptor number (what Android's AssetFileDescriptor hands over). */
    private fun descriptorOf(fd: FileDescriptor): Int = FileDescriptor::class.java.getDeclaredField("fd").apply { isAccessible = true }.getInt(fd)
}

fun main(args: Array<String>) {
    if (args.size < 3) {
        println("usage: lm-harness <mock url> <model folder | none> <bench-prompts.json>")
        exitProcess(2)
    }
    val modelInfo = if (args[1] == "none") null else ModelInfo.load(File(args[1]))
    val prompts = JsonBridge.toMap(Json.parseToJsonElement(File(args[2]).readText()) as JsonObject)
    @Suppress("UNCHECKED_CAST") val first = (prompts["prompts"] as List<Map<String, Any?>>)[0]
    @Suppress("UNCHECKED_CAST") val harness = Harness(modelInfo, args[0], first["local"] as Map<String, Any?>, first["online"] as Map<String, Any?>)
    harness.run()
    harness.model.local.shutdown()
    Thread.sleep(500)
    exitProcess(if (harness.fail == 0) 0 else 1)
}
