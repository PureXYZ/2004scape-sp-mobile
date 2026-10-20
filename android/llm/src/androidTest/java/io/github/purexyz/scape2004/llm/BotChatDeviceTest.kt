// AndroidBotChat as the app uses it, on a real Android: the page's messages in, replies
// and statuses out through its Host; the key's secure box driven as the debug lm-key-alert drives it (Save, Cancel keeping
// the key, "not a key", Remove); the thermal gate under `cmd thermalservice override-status`; the bench's actions; and,
// when the runner passes the mock's URL (-Pandroid.testInstrumentationRunnerArguments.mock=http://127.0.0.1:47591/v1/messages,
// with adb reverse tcp:47591 tcp:47591), Claude online over HttpURLConnection with the iPhone's exact body.
package io.github.purexyz.scape2004.llm

import android.app.Activity
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.purexyz.scape2004.botchat.JsonBridge
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(AndroidJUnit4::class)
class BotChatDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private lateinit var botChat: AndroidBotChat
    private val replies = LinkedBlockingQueue<Map<String, Any?>>()
    private val statuses = CopyOnWriteArrayList<Map<String, Any?>>()
    private val debugReplies = LinkedBlockingQueue<Pair<Int, Any?>>()
    private val haptics = AtomicInteger()
    private val focus = CopyOnWriteArrayList<String>()
    @Volatile private var activity: Activity? = null

    private fun <T> onMain(block: () -> T): T {
        var value: T? = null
        instrumentation.runOnMainSync { value = block() }
        @Suppress("UNCHECKED_CAST")
        return value as T
    }

    private fun json(text: String) = Json.parseToJsonElement(text) as JsonObject

    @Before
    fun create() {
        AndroidModelKeyStore(context, TestLog).remove()
        botChat = onMain { AndroidBotChat.create(context, TestLog, debug = true) }
        botChat.host = object : AndroidBotChat.Host {
            override fun lmReply(reply: JsonObject) {
                replies.put(JsonBridge.toMap(reply))
            }

            override fun lmStatus(status: JsonObject) {
                statuses += JsonBridge.toMap(status)
            }

            override fun activity(): Activity? = activity

            override fun lendKeyboardFocus(lend: Boolean) {
                focus += "lend $lend"
            }

            override fun activateKeyboard() {
                focus += "activate"
            }

            override fun errorHaptic() {
                haptics.incrementAndGet()
            }

            override fun debugReply(id: Int, value: JsonElement) {
                debugReplies.put(id to JsonBridge.toAny(value))
            }
        }
    }

    @After
    fun destroy() {
        shell("cmd thermalservice reset")
        botChat.model.local.shutdown()
        botChat.keyStore.remove()
    }

    private fun request(id: Int, mode: String = "local", think: Boolean = false, fallback: Boolean? = null): JsonObject {
        val prompt = """{"system": "RuneScape, late 2004. You are Kat123, a player. Reply in one short chat line.", "user": "Dark Lord 91: selling logs"}"""
        val online = """{"system": "a 2004 guide", "context": "the bot's facts", "user": "Dark Lord 91: selling logs"}"""
        return json("""{"type": "lm", "id": $id, "mode": "$mode", "think": $think, "local": $prompt, "online": $online, "maxChars": 80, "timeoutMs": 9000${fallback?.let { ", \"fallback\": $it" } ?: ""}}""")
    }

    private fun nextReply(): Map<String, Any?> = replies.poll(60, TimeUnit.SECONDS) ?: throw AssertionError("no reply")

    @Suppress("UNCHECKED_CAST")
    private fun section(status: Map<String, Any?>, name: String) = status[name] as Map<String, Any?>

    /** The last status the page heard (empty before the first). */
    private fun lastOnline(): Map<String, Any?> = statuses.lastOrNull()?.let { section(it, "online") } ?: emptyMap()

    @Test
    fun theStatusAndLocalReplies() {
        val status = JsonBridge.toMap(onMain { botChat.status })
        val local = section(status, "local")
        if (!expectModel) {
            // a build without the model: "Not in this build", and requests answered at once
            assertEquals(mapOf("available" to false, "loaded" to false, "think" to "never", "reason" to "no-model"), local)
            onMain { botChat.dispatch(request(1)) }
            assertEquals("unavailable", nextReply()["error"])
            return
        }
        assertEquals(true, local["available"])
        assertEquals("option", local["think"])
        assertEquals("2004 chat (Qwen3.5 0.8B + LoRA)", local["name"])
        assertEquals(529_297_728L, local["bytes"])
        assertEquals(false, section(status, "online")["keySet"])

        assertTrue(onMain { botChat.dispatch(json("""{"type": "lm-warm"}""")) })
        waitFor("the warm-up's status") { statuses.any { section(it, "local")["loaded"] == true } }

        onMain { botChat.dispatch(request(1)) }
        val plain = nextReply()
        assertEquals("local", plain["source"])
        @Suppress("UNCHECKED_CAST") val plainTimings = plain["timings"] as Map<String, Any?>
        assertEquals(false, plainTimings["think"])
        onMain { botChat.dispatch(request(2, think = true)) }
        val noted = nextReply()
        @Suppress("UNCHECKED_CAST") val notedTimings = noted["timings"] as Map<String, Any?>
        assertEquals(true, notedTimings["think"])
        assertTrue((notedTimings["noteTokens"] as Number).toInt() > 0)
        assertFalse(noted.containsKey("note"))
        TestLog.result("facade: plain ${plain["ms"]} ms \"${plain["text"]}\", noted ${noted["ms"]} ms \"${noted["text"]}\"")

        // rules, and the fourth at once
        onMain { botChat.dispatch(json("""{"type": "lm", "id": 3, "mode": "rules"}""")) }
        assertEquals("unavailable", nextReply()["error"])
        val busy = onMain {
            for (id in 4..7) botChat.dispatch(request(id))
            replies.poll()
        }
        assertEquals(7, (busy?.get("id") as Number).toInt())
        assertEquals("busy", busy["error"])
        repeat(3) { nextReply() }
        assertFalse(onMain { botChat.dispatch(json("""{"type": "keyboard"}""")) })
    }

    @Test
    fun aHotPhoneSaysBusy() {
        assumeTrue("a build without the model", expectModel)
        assertEquals(io.github.purexyz.scape2004.botchat.ThermalLevel.NOMINAL, botChat.thermal.level())
        shell("cmd thermalservice override-status 3")
        waitFor("the override", 10) { botChat.thermal.status() == 3 }
        assertEquals(io.github.purexyz.scape2004.botchat.ThermalLevel.SERIOUS, botChat.thermal.level())
        onMain { botChat.dispatch(request(1)) }
        val reply = nextReply()
        assertEquals("busy", reply["error"])
        assertTrue(TestLog.has("#1 the phone is hot (thermal status severe): no on-device reply"))
        shell("cmd thermalservice override-status 2")
        waitFor("moderate", 10) { botChat.thermal.status() == 2 }
        onMain { botChat.dispatch(request(2)) }
        assertEquals("local", nextReply()["source"])
        shell("cmd thermalservice reset")
    }

    @Test
    fun theKeysSecureBox() {
        ActivityScenario.launch(TestActivity::class.java).use { scenario ->
            scenario.onActivity { activity = it }
            fun alert(id: Int, text: String, button: String): Map<*, *> {
                onMain { botChat.debugAction(id, "lm-key-alert", json("""{"text": "$text", "button": "$button"}""")) }
                val (replyId, value) = debugReplies.poll(10, TimeUnit.SECONDS)!!
                assertEquals(id, replyId)
                return value as Map<*, *>
            }
            fun openBox() {
                onMain { botChat.dispatch(json("""{"type": "lm-key", "action": "set"}""")) }
                waitFor("the box", 10) { onMain { botChat.keyDialog?.dialog?.isShowing == true && botChat.keyDialog?.field?.hasFocus() == true } }
            }

            assertEquals(mapOf("shown" to false), alert(1, "x", "save"))
            openBox()
            assertEquals(listOf("lend true"), focus.toList())
            val shown = alert(2, "sk-ant-test-ok-abcd", "save")
            assertEquals(mapOf("shown" to true, "secure" to true, "title" to "Claude API key", "firstResponder" to true), shown)
            waitFor("the key", 10) { lastOnline()["hint"] == "…abcd" }
            assertEquals(listOf("lend true", "lend false", "activate"), focus.toList())
            assertTrue(onMain { botChat.keyDialog == null })

            // Cancel keeps the key
            openBox()
            alert(3, "sk-ant-test-other-9999", "cancel")
            waitFor("the box to close", 10) { onMain { botChat.keyDialog == null } }
            assertEquals("…abcd", section(JsonBridge.toMap(onMain { botChat.status }), "online")["hint"])

            // what cannot be a key: "not a key", the error haptic, the key as it was
            openBox()
            alert(4, "nope", "save")
            waitFor("the problem", 10) { lastOnline()["problem"] == "not a key" }
            assertEquals(1, haptics.get())
            assertEquals("…abcd", lastOnline()["hint"])

            // Remove
            onMain { botChat.dispatch(json("""{"type": "lm-key", "action": "remove"}""")) }
            waitFor("the removal", 10) { lastOnline()["keySet"] == false }
            assertTrue(TestLog.has("[lm] Claude key removed"))
            assertFalse(statuses.any { it.toString().contains("sk-ant") })
            // (what was typed into the box never reaches a log)
            val log = shell("logcat -d")
            assertFalse(log.contains("sk-ant-test-ok-abcd") || log.contains("sk-ant-test-other-9999"))
            activity = null
        }
    }

    @Test
    fun theBench() {
        assumeTrue("a build without the model", expectModel)
        fun bench(id: Int, body: String): Any? {
            onMain { botChat.dispatch(json("""{"type": "lm-bench", "id": $id, $body}""")) }
            val (replyId, value) = debugReplies.poll(60, TimeUnit.SECONDS)!!
            assertEquals(id, replyId)
            return value
        }
        val options = bench(1, """"action": "options", "threads": 3, "idleSec": 120""") as Map<*, *>
        assertEquals(mapOf("threads" to 3L, "gpuLayers" to 0L, "idleSec" to 120.0), options)
        val generated = bench(2, """"action": "generate", "system": "You are Kat123. Reply in one short chat line.", "user": "hi", "think": true, "timeoutMs": 20000""") as Map<*, *>
        assertTrue("$generated", (generated["text"] as String).isNotEmpty())
        assertTrue((generated["note"] as String).isNotEmpty())
        val stats = bench(3, """"action": "stats"""") as Map<*, *>
        for (key in listOf("battery", "footprintMB", "availableMB", "thermal", "lowPower", "loaded", "think", "queued", "terminations", "options", "lastLoad", "thermalStatus", "cpuVariant", "mmap", "repack")) {
            assertTrue("stats has $key: $stats", stats.containsKey(key))
        }
        assertEquals("nominal", stats["thermal"])
        assertEquals(true, stats["loaded"])
        assertEquals("option", stats["think"])
        TestLog.result("bench stats: $stats")
        assertEquals(true, bench(4, """"action": "unload""""))
        waitFor("the unload", 10) { !botChat.model.local.isLoaded }
        assertEquals(null, bench(5, """"action": "nothing""""))
    }

    @Test
    fun claudeOnlineThroughTheMock() {
        val mock = InstrumentationRegistry.getArguments().getString("mock")
        assumeTrue("no mock URL (-Pandroid.testInstrumentationRunnerArguments.mock=...)", mock != null)
        onMain { botChat.debugAction(1, "lm-endpoint", json("""{"url": "$mock"}""")) }
        assertEquals(1 to mock, debugReplies.poll(10, TimeUnit.SECONDS))
        assertTrue(botChat.keyStore.save("sk-ant-test-ok-dev1"))
        onMain { botChat.dispatch(request(1, mode = "online")) }
        val reply = nextReply()
        assertEquals("online", reply["source"])
        assertTrue(reply["text"] is String)
        assertNotNull(reply["usage"])
        // a refused key: the on-device model answers, and the status says so
        assertTrue(botChat.keyStore.save("sk-ant-test-bad-dev2"))
        onMain { botChat.dispatch(request(2, mode = "online")) }
        val fallback = nextReply()
        if (expectModel) assertEquals("local", fallback["source"]) else assertEquals("refused", fallback["error"])
        assertEquals("key refused", section(JsonBridge.toMap(onMain { botChat.status }), "online")["problem"])
        // the Test: Claude's error, never the on-device model's line
        onMain { botChat.dispatch(request(3, mode = "online", fallback = false)) }
        assertEquals("refused", nextReply()["error"])
        // a slow API is given up on in time
        assertTrue(botChat.keyStore.save("sk-ant-test-slow-dev3"))
        val started = System.nanoTime()
        onMain { botChat.dispatch(json("""{"type": "lm", "id": 4, "mode": "online", "fallback": false, "online": {"system": "g", "context": "", "user": "u"}, "timeoutMs": 3000}""")) }
        assertEquals("timeout", nextReply()["error"])
        assertTrue((System.nanoTime() - started) / 1e9 < 4.5)
        TestLog.result("online via the mock: ok")
    }
}
