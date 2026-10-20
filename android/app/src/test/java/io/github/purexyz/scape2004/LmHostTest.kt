// LmHostTest: the bot chat's host on the session (LmComponent.kt's LmHost; GameViewController.swift's §7.1 closures),
// with a fake session: the status reaches the next document before the page,
// replies and statuses go to LostCityHost.bots, the keyboard's focus is lent for the key's box exactly once and taken back
// once, the box is only shown over a started activity, the error haptic and the debug replies.
package io.github.purexyz.scape2004

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LmHostTest {
    private class FakeSeam : LmSeam {
        val events = ArrayList<String>()
        var focus: KeyboardFocus? = null
        var lends = 0
        var closes = 0

        override fun callPage(path: String, arg: JsonElement) {
            events += "page $path ${JsonText.canonical(arg)}"
        }

        override fun setDocumentStatus(status: JsonObject) {
            events += "document ${JsonText.canonical(status)}"
        }

        override fun evaluate(script: String) {
            events += "eval $script"
        }

        override val keyboardFocus: KeyboardFocus? get() = focus
        override val activity: GameActivity? get() = null

        override fun playHaptic(style: String) {
            events += "haptic $style"
        }

        override val terminations: Int get() = 2

        /** A keyboard bridge that counts lends and closes (closing twice counts once, as KeyboardBridge.lend). */
        fun installFocus() {
            focus = KeyboardFocus {
                lends += 1
                var closed = false
                AutoCloseable {
                    if (!closed) {
                        closed = true
                        closes += 1
                    }
                }
            }
        }
    }

    private val status = buildJsonObject {
        put("local", buildJsonObject { put("available", JsonPrimitive(true)); put("loaded", JsonPrimitive(true)) })
        put("online", buildJsonObject { put("keySet", JsonPrimitive(false)) })
    }

    @Test
    fun statusIsRegisteredForTheNextDocumentBeforeThePageHearsIt() {
        val seam = FakeSeam()
        val host = LmHost(seam, FakeScheduler()) { null }
        host.lmStatus(status)
        val json = JsonText.canonical(status)
        assertEquals(listOf("document $json", "page bots.lmStatus $json"), seam.events)
    }

    @Test
    fun replyGoesToLmReplyAsItsOneArgument() {
        val seam = FakeSeam()
        val host = LmHost(seam, FakeScheduler()) { null }
        val reply = buildJsonObject {
            put("id", JsonPrimitive(7))
            put("text", JsonPrimitive("sup m8"))
            put("source", JsonPrimitive("local"))
        }
        host.lmReply(reply)
        assertEquals(listOf("page bots.lmReply {\"id\":7,\"source\":\"local\",\"text\":\"sup m8\"}"), seam.events)
    }

    @Test
    fun focusIsLentForTheBoxAndTakenBackOnce() {
        val seam = FakeSeam().apply { installFocus() }
        val host = LmHost(seam, FakeScheduler()) { null }
        host.lendKeyboardFocus(true)
        assertTrue(host.focusLent)
        assertEquals(1, seam.lends)
        host.lendKeyboardFocus(false)
        host.activateKeyboard() // (nothing more: the close did it)
        assertFalse(host.focusLent)
        assertEquals(1, seam.closes)
        host.lendKeyboardFocus(false) // a second close: nothing
        assertEquals(1, seam.closes)
    }

    @Test
    fun aSecondLendWithoutACloseGivesTheFirstBack() {
        val seam = FakeSeam().apply { installFocus() }
        val host = LmHost(seam, FakeScheduler()) { null }
        host.lendKeyboardFocus(true)
        host.lendKeyboardFocus(true)
        assertEquals(2, seam.lends)
        assertEquals(1, seam.closes)
        host.lendKeyboardFocus(false)
        assertEquals(2, seam.closes)
    }

    @Test
    fun withoutAKeyboardBridgeTheBoxStillOpensAndCloses() {
        val seam = FakeSeam()
        val host = LmHost(seam, FakeScheduler()) { null }
        host.lendKeyboardFocus(true)
        assertFalse(host.focusLent)
        host.lendKeyboardFocus(false)
        assertNull(host.boxActivity)
    }

    @Test
    fun theBoxNeedsAStartedActivity() {
        val host = LmHost(FakeSeam(), FakeScheduler()) { null }
        assertNull(host.activity())
        host.started = true
        assertNull(host.activity()) // (the fake has no activity: none to show it over either way)
    }

    @Test
    fun errorHapticDebugRepliesAndTerminations() {
        val seam = FakeSeam()
        val host = LmHost(seam, FakeScheduler()) { null }
        host.errorHaptic()
        host.debugReply(42, buildJsonObject { put("shown", JsonPrimitive(false)) })
        assertEquals(listOf("haptic error", "eval window.__lcDebugReply?.(42, {\"shown\":false});"), seam.events)
        assertEquals(2, host.terminations())
    }

    @Test
    fun theMessagesAndDebugActionsAreIosOnes() {
        assertEquals(listOf("lm", "lm-warm", "lm-key", "lm-bench"), LmComponent.MESSAGES)
        assertEquals(listOf("lm-status", "lm-endpoint", "lm-key-alert"), LmComponent.DEBUG_ACTIONS)
        // (every one of them is a message the session logs once and ignores until a component takes it)
        assertTrue(GameSession.COMPONENT_MESSAGES.containsAll(LmComponent.MESSAGES))
    }
}
