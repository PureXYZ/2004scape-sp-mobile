// BotChatModel's router step by step (BCM-14 1-10), with a fake native layer and, for Claude, a tiny local server:
// the missing id, the clamp, rules, busy at once, the page reset, the half second, the merge, the
// status, the hot phone and the fallback chain.
package io.github.purexyz.scape2004.botchat

import com.sun.net.httpserver.HttpServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class BotChatModelTest {
    private val main = TestMain()
    private val log = RecordingLog()
    private val native = FakeNative()
    private val replies = Replies()
    private val statuses = java.util.concurrent.CopyOnWriteArrayList<Map<String, Any?>>()
    private var key: String? = null
    private var server: HttpServer? = null

    private fun model(info: ModelInfo? = fakeInfo(), withNative: Boolean = true): BotChatModel = main.run {
        BotChatModel(LocalModel(info, if (withNative) native else null, main, log), OnlineModel(main), MemoryKeyStore(), log).also {
            it.readKey = { key }
            it.onReply = { reply -> replies.queue.put(reply) }
            it.onStatus = { status -> statuses += status }
        }
    }

    /** A stand-in for the Messages API answering every request with [status] and [body]. */
    private fun claude(status: Int, body: String, delayMs: Long = 0): String {
        val http = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        http.createContext("/v1/messages") { exchange ->
            exchange.requestBody.readBytes()
            if (delayMs > 0) Thread.sleep(delayMs)
            val bytes = body.toByteArray()
            exchange.responseHeaders.add("content-type", "application/json")
            runCatching {
                exchange.sendResponseHeaders(status, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
            }
        }
        http.executor = java.util.concurrent.Executors.newCachedThreadPool()
        http.start()
        server = http
        return "http://127.0.0.1:${http.address.port}/v1/messages"
    }

    @After
    fun stop() {
        server?.stop(0)
    }

    @Test
    fun aRequestWithoutAnIdGetsNoReply() {
        val chat = model()
        main.run { chat.handle(request(null)) }
        assertTrue(replies.none())
        assertTrue(log.has("[lm] ignored a request without an id"))
    }

    @Test
    fun localReplyWithTimingsMergedWithoutOverriding() {
        val chat = model()
        main.run { chat.handle(request(7.9)) }  // (NSNumber.intValue: 7)
        val reply = replies.next()
        assertEquals(listOf("id", "text", "source", "ms", "timings"), reply.keys.toList())
        assertEquals(7, reply["id"])
        assertEquals("hey there", reply["text"])
        assertEquals("local", reply["source"])
        @Suppress("UNCHECKED_CAST") val timings = reply["timings"] as Map<String, Any?>
        assertEquals(false, timings["think"])
        assertTrue(timings.containsKey("loadMs"))  // (this request loaded the model)
        // the prompt as Swift trims it (U+0085 included), and the model's defaults
        val call = native.generations.single()
        assertEquals("You are a bot.", call.system)
        assertEquals("hi", call.user)
        assertEquals(40, call.maxTokens)
        assertEquals(120, call.maxChars)  // (the request's maxChars is not native's: the grammar's 120)
        assertTrue(log.lines.any { it.startsWith("[lm] #7 local, think off, in ") && it.contains("(load ") && it.contains(": prompt 300 tokens at 300/s, 3 tokens at 60/s") })
    }

    @Test
    fun timeoutIsClamped() {
        val chat = model()
        main.run { chat.handle(request(1, timeoutMs = 10)) }
        replies.next()
        val low = native.generations.last().remainingNanos
        assertTrue("$low", low in 500_000_000L..1_000_000_000L)
        main.run { chat.handle(request(2, timeoutMs = 99_999)) }
        replies.next()
        val high = native.generations.last().remainingNanos
        assertTrue("$high", high in 29_000_000_000L..30_000_000_000L)
        main.run { chat.handle(request(3, timeoutMs = "x")) }
        replies.next()
        assertTrue(native.generations.last().remainingNanos in 8_000_000_000L..9_000_000_000L)
    }

    @Test
    fun rulesModeIsUnavailableWithoutTakingASlot() {
        val chat = model()
        key = "sk-ant-test-ok-abcd"
        main.run { chat.handle(request(1, mode = "rules")) }
        val reply = replies.next()
        assertNull(reply["text"])
        assertTrue(reply.containsKey("text"))
        assertEquals("unavailable", reply["error"])
        assertEquals(0, main.run { chat.counters["inFlight"] })
    }

    @Test
    fun theFourthAtOnceIsBusyInsideHandle() {
        val chat = model()
        val release = CountDownLatch(1)
        native.script = { _, out ->
            release.await(10, TimeUnit.SECONDS)
            out.text = "ok".toByteArray()
            LlmNative.OK
        }
        val busy = main.run {
            repeat(3) { chat.handle(request(it + 1)) }
            chat.handle(request(4))
            replies.queue.poll()  // (synchronously, before handle returned)
        }
        assertEquals(4, busy?.get("id"))
        assertEquals("busy", busy?.get("error"))
        release.countDown()
        val rest = (1..3).map { replies.next()["id"] }.toSet()
        assertEquals(setOf(1, 2, 3), rest)
        assertEquals(1, main.run { chat.counters["busy"] })
    }

    @Test
    fun anAnswerForAnOldPageIsDropped() {
        val chat = model()
        val release = CountDownLatch(1)
        native.script = { _, out ->
            release.await(10, TimeUnit.SECONDS)
            out.text = "late".toByteArray()
            LlmNative.OK
        }
        main.run {
            chat.handle(request(1))
            chat.pageReset()
        }
        release.countDown()
        assertTrue(replies.none(500))
        assertTrue(log.has("[lm] #1 answered after the page reloaded: dropped"))
    }

    @Test
    fun anEmptyLineIsFailedEmptyWithItsTimings() {
        val chat = model()
        native.script = { _, out ->
            out.text = " \n".toByteArray()
            LlmNative.OK
        }
        main.run { chat.handle(request(1)) }
        val reply = replies.next()
        assertNull(reply["text"])
        assertNull(reply["source"])
        assertEquals("failed: empty", reply["error"])
        assertTrue(reply.containsKey("timings"))
    }

    @Test
    fun nativeFailuresAreThePagesWords() {
        val chat = model()
        native.script = { _, out ->
            out.error = "decode 1"
            LlmNative.FAILED
        }
        main.run { chat.handle(request(1, think = true)) }
        assertEquals("failed: decode 1", replies.next()["error"])
        assertTrue(log.has("[lm] #1 local, think on, failed: failed: decode 1"))
        native.script = { _, _ -> LlmNative.ABORTED }
        main.run { chat.handle(request(2)) }
        assertEquals("failed: interrupted", replies.next()["error"])
        native.script = { _, _ -> LlmNative.TIMEOUT }
        main.run { chat.handle(request(3)) }
        assertEquals("timeout", replies.next()["error"])
    }

    @Test
    fun statusShapes() {
        key = "sk-ant-test-ok-abcd"
        val chat = model()
        val status = main.run { chat.status }
        @Suppress("UNCHECKED_CAST") val local = status["local"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST") val online = status["online"] as Map<String, Any?>
        assertEquals(listOf("available", "loaded", "think", "name", "bytes"), local.keys.toList())
        assertEquals(true, local["available"])
        assertEquals("option", local["think"])
        assertEquals(529_297_728L, local["bytes"])
        assertEquals(listOf("keySet", "model", "hint"), online.keys.toList())
        assertEquals("…abcd", online["hint"])
        assertEquals("claude-haiku-5-5", online["model"])

        key = null
        val none = model(info = null)
        @Suppress("UNCHECKED_CAST") val noModel = main.run { none.status }["local"] as Map<String, Any?>
        assertEquals(mapOf("available" to false, "loaded" to false, "think" to "never", "reason" to "no-model"), noModel)
        val noRuntime = model(withNative = false)
        @Suppress("UNCHECKED_CAST") val runtime = main.run { noRuntime.status }["local"] as Map<String, Any?>
        assertEquals("no-runtime", runtime["reason"])
        assertEquals("never", runtime["think"])
        assertEquals("2004 chat (test)", runtime["name"])  // (model.json is there, even if it cannot run)
        main.run { noRuntime.handle(request(1)) }
        assertEquals("unavailable", replies.next()["error"])
    }

    @Test
    fun theKey() {
        val store = MemoryKeyStore()
        val chat = main.run { BotChatModel(LocalModel(fakeInfo(), native, main, log), OnlineModel(main), store, log).also { it.onStatus = { s -> statuses += s } } }
        assertFalse(main.run { chat.setKey("not a key") })
        assertNull(store.read())
        assertTrue(main.run { chat.setKey(" sk-ant-test-ok-abcd\n") })
        assertEquals("sk-ant-test-ok-abcd", store.read())
        assertTrue(log.has("[lm] Claude key saved (…abcd)"))
        main.run { chat.keyProblem("not a key") }
        @Suppress("UNCHECKED_CAST")
        assertEquals("not a key", (statuses.last()["online"] as Map<String, Any?>)["problem"])
        main.run { chat.removeKey() }
        assertNull(store.read())
        assertTrue(log.has("[lm] Claude key removed"))
        @Suppress("UNCHECKED_CAST") val online = statuses.last()["online"] as Map<String, Any?>
        assertEquals(mapOf("keySet" to false, "model" to "claude-haiku-5-5"), online)
    }

    @Test
    fun aHotPhoneSaysBusyAndSkipsTheWarmUp() {
        val chat = model()
        main.run {
            chat.thermal = ThermalProvider.fixed(ThermalLevel.SERIOUS)
            chat.warm()
            chat.handle(request(1))
        }
        assertEquals("busy", replies.next()["error"])
        assertTrue(log.has("[lm] #1 the phone is hot (thermal state serious): no on-device reply"))
        Thread.sleep(100)
        assertEquals(0, native.loads.get())
        main.run { chat.thermal = ThermalProvider.fixed(ThermalLevel.FAIR) }
        main.run { chat.handle(request(2)) }
        assertEquals("local", replies.next()["source"])
    }

    @Test
    fun onlineWithoutAKey() {
        val chat = model()
        main.run { chat.handle(request(1, mode = "online")) }
        assertEquals("local", replies.next()["source"])
        main.run { chat.handle(request(2, mode = "online", fallback = false)) }
        val reply = replies.next()
        assertEquals("unavailable", reply["error"])
        assertEquals(0, main.run { chat.counters["inFlight"] })
    }

    @Test
    fun lessThanHalfASecondLeftIsTimeout() {
        val chat = model()
        main.run {
            chat.readKey = {
                Thread.sleep(600)
                "sk-ant-test-ok-abcd"
            }
            chat.handle(request(1, mode = "online", timeoutMs = 1000))
        }
        val reply = replies.next()
        assertEquals("timeout", reply["error"])
        assertEquals(0, main.run { chat.counters["inFlight"] })
    }

    @Test
    fun claudeAnswersAndTheKeyIsValid() {
        val chat = model()
        main.run {
            chat.online.endpoint = claude(200, """{"content":[{"type":"text","text":" sup m8 "}],"stop_reason":"end_turn","usage":{"input_tokens":180,"output_tokens":6,"cache_read_input_tokens":700,"cache_creation_input_tokens":0}}""")
        }
        key = "sk-ant-test-ok-abcd"
        main.run { chat.handle(request(1, mode = "online", think = true)) }
        val reply = replies.next()
        assertEquals("sup m8", reply["text"])
        assertEquals("online", reply["source"])
        assertEquals(mapOf("input" to 180L, "output" to 6L, "cacheRead" to 700L, "cacheWrite" to 0L), reply["usage"])
        assertFalse(reply.containsKey("timings"))
        @Suppress("UNCHECKED_CAST") val online = main.run { chat.status }["online"] as Map<String, Any?>
        assertEquals(true, online["valid"])
        assertTrue(log.lines.any { it.startsWith("[lm] #1 Claude in ") && it.endsWith("ms (input 180, cache read 700, write 0, output 6 tokens)") })
        assertTrue(native.generations.isEmpty())
    }

    @Test
    fun aRefusedKeyFallsBackAndSaysSo() {
        val chat = model()
        main.run { chat.online.endpoint = claude(401, """{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}""") }
        key = "sk-ant-test-bad-1234"
        main.run { chat.handle(request(1, mode = "online", think = true)) }
        val reply = replies.next()
        assertEquals("local", reply["source"])
        @Suppress("UNCHECKED_CAST") val timings = reply["timings"] as Map<String, Any?>
        assertEquals(true, timings["think"])  // (Claude's fallback keeps the request's think)
        @Suppress("UNCHECKED_CAST") val online = main.run { chat.status }["online"] as Map<String, Any?>
        assertEquals(false, online["valid"])
        assertEquals("key refused", online["problem"])
        assertTrue(log.has("[lm] #1 Claude failed: refused; the on-device model answers"))
        main.run { chat.handle(request(2, mode = "online", fallback = false)) }
        val test = replies.next()
        assertNull(test["text"])
        assertEquals("refused", test["error"])
    }

    @Test
    fun claudeStuckWhereTheCutCannotReachStillTimesOutAtTheLimit() {
        // Android's HttpURLConnection looks the host up inside getOutputStream(), and a disconnect cannot interrupt that
        // (no socket yet): a network that drops DNS stalls it for 10-40 s. The limit must still answer, and free the slot.
        val release = CountDownLatch(1)
        val chat = model(info = null)
        main.run {
            chat.online.open = { url ->
                object : java.net.HttpURLConnection(java.net.URI(url).toURL()) {
                    override fun connect() = Unit
                    override fun disconnect() = Unit // (nothing to close during the lookup)
                    override fun usingProxy() = false
                    override fun getOutputStream(): java.io.OutputStream {
                        release.await(30, TimeUnit.SECONDS)
                        throw java.net.UnknownHostException("api.anthropic.com")
                    }
                }
            }
        }
        key = "sk-ant-test-dns-3333"
        val started = System.nanoTime()
        main.run { chat.handle(request(1, mode = "online", timeoutMs = 1500)) }
        val reply = replies.next(5)
        val ms = (System.nanoTime() - started) / 1_000_000
        assertEquals("timeout", reply["error"])
        assertTrue("answered at the limit, not when the lookup gives up: $ms ms", ms in 900..2_500)
        assertEquals(0, main.run { chat.counters["inFlight"] })
        assertTrue(log.has("[lm] #1 Claude failed: timeout"))
        // the stuck request's own late answer is dropped
        release.countDown()
        assertTrue(replies.none(500))
    }

    @Test
    fun claudeFailingWithNoModelGivesClaudesReason() {
        val chat = model(info = null)
        main.run { chat.online.endpoint = claude(529, """{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}""") }
        key = "sk-ant-test-busy-2222"
        main.run { chat.handle(request(1, mode = "online")) }
        assertEquals("failed: overloaded", replies.next()["error"])
        assertTrue(log.has("[lm] #1 Claude failed: http 529 overloaded_error"))
        assertFalse(log.has("the on-device model answers"))
    }
}
