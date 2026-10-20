// PageBridge with a fake evaluateJavascript: the __lcCall script, replies by id, 'missing', fire and forget, timeouts,
// a reset failing pending calls, and the outcome descriptions iOS logs.
package io.github.purexyz.scape2004

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PageBridgeTest {
    private lateinit var clock: FakeScheduler
    private lateinit var scripts: MutableList<String>
    private var answer: String? = "1"
    private lateinit var bridge: PageBridge

    @Before
    fun setUp() {
        clock = FakeScheduler()
        scripts = ArrayList()
        bridge = PageBridge(clock) { PageBridge.JsEvaluator { script, result -> scripts.add(script); result(answer) } }
    }

    private fun reply(id: Long, ok: Boolean, value: Any? = null, error: String? = null) = buildJsonObject {
        put("ch", JsonPrimitive("reply"))
        put("id", JsonPrimitive(id))
        put("ok", JsonPrimitive(ok))
        when (value) {
            is JsonObject -> put("value", value)
            is Boolean -> put("value", JsonPrimitive(value))
            null -> put("value", JsonNull)
        }
        if (error != null) put("error", JsonPrimitive(error))
    }

    @Test
    fun aCallIsAnsweredByItsReply() {
        var outcome: PageBridge.Outcome? = null
        bridge.call("lifecycle", listOf(JsonPrimitive("pause"))) { outcome = it }
        assertEquals(1, scripts.size)
        assertTrue(scripts[0], scripts[0].contains("window.__lcCall(1,\"lifecycle\",[\"pause\"])"))
        assertNull(outcome)
        bridge.onReply(reply(1, true, buildJsonObject { put("ok", JsonPrimitive(false)) }))
        val returned = outcome as PageBridge.Outcome.Returned
        assertTrue(returned.succeeded)
        assertFalse("{ok: false} is not reported success", returned.reportedSuccess)
        assertEquals("ok → {\"ok\":false}", returned.description)
        bridge.onReply(reply(1, true)) // a second answer to the same id: ignored
    }

    @Test
    fun missingAndFailed() {
        val outcomes = ArrayList<PageBridge.Outcome>()
        bridge.call("back") { outcomes.add(it) }
        bridge.call("keyboard.nope") { outcomes.add(it) }
        bridge.onReply(reply(2, false, error = "missing"))
        bridge.onReply(reply(1, false, error = "boom"))
        assertEquals(PageBridge.Outcome.Missing, outcomes[0])
        assertEquals(PageBridge.Outcome.Failed("boom"), outcomes[1])
        assertEquals("no LostCityHost handler on the page", outcomes[0].description)
        assertEquals("failed: boom", outcomes[1].description)
        assertTrue(outcomes[0].reportedSuccess)
    }

    @Test
    fun aPageWithoutLcCallIsMissingAtOnce() {
        answer = "0"
        var outcome: PageBridge.Outcome? = null
        bridge.call("memoryWarning") { outcome = it }
        assertEquals(PageBridge.Outcome.Missing, outcome)
        assertEquals(0, bridge.pendingCount)
        answer = "null"
        bridge.call("memoryWarning") { outcome = it }
        assertEquals(PageBridge.Outcome.Failed("page gone"), outcome)
    }

    @Test
    fun fireAndForgetUsesIdZero() {
        bridge.call("keyboard.insertText", listOf(JsonPrimitive("a\"b")))
        assertTrue(scripts[0], scripts[0].contains("window.__lcCall(0,\"keyboard.insertText\",[\"a\\\"b\"])"))
        assertEquals(0, bridge.pendingCount)
    }

    @Test
    fun noWebViewFails() {
        val none = PageBridge(clock) { null }
        var outcome: PageBridge.Outcome? = null
        none.call("lifecycle") { outcome = it }
        assertEquals(PageBridge.Outcome.Failed("no web view"), outcome)
    }

    @Test
    fun timeoutsAndReset() {
        val outcomes = ArrayList<PageBridge.Outcome>()
        bridge.call("slow", timeoutMs = 1_000) { outcomes.add(it) }
        bridge.call("other") { outcomes.add(it) }
        clock.advance(1_000)
        assertEquals(PageBridge.Outcome.Failed("no answer after 1.0 s"), outcomes.single())
        bridge.reset("page reset")
        assertEquals(PageBridge.Outcome.Failed("page reset"), outcomes[1])
        assertEquals(0, bridge.pendingCount)
        bridge.onReply(reply(2, true)) // the old page's late answer
        assertEquals(2, outcomes.size)
        // ids keep counting after a reset: a new call can never take an old reply
        bridge.call("next") { outcomes.add(it) }
        assertTrue(scripts.last().contains("__lcCall(3,"))
    }

    @Test
    fun runPostsItsOwnReply() {
        var outcome: PageBridge.Outcome? = null
        bridge.run("return 42;") { outcome = it }
        assertTrue(scripts[0].contains("window.lcAndroid.postMessage"))
        bridge.onReply(reply(1, true, true))
        assertEquals(PageBridge.Outcome.Returned(JsonPrimitive(true)), outcome)
    }
}
