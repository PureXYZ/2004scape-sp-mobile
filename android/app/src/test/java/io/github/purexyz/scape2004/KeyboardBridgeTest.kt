// KeyboardBridge on the JVM (the iOS KeyboardBridge.swift behaviour it ports): the input rules
// and every charset, message parsing, the optimistic echo and its reconcile, Return, chips, paste, refusals (the warning
// haptic and the flash, at most every 0.3 s), cancel/hide/dismissed, the hardware keys' down/up and repeat, the covered
// height reported to the page, the IME closed by the player, Back, focus lending and a page reset. A fake page records the
// LostCityHost.keyboard calls; a fake Surface stands in for the activity's views; the clock is FakeScheduler's.
package io.github.purexyz.scape2004

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import android.view.KeyEvent

class KeyboardBridgeTest {
    private lateinit var clock: FakeScheduler
    private lateinit var scripts: MutableList<String>
    private lateinit var page: PageBridge
    private lateinit var bridge: KeyboardBridge
    private lateinit var surface: FakeSurface
    private val haptics = ArrayList<String>()
    private var activity = 0

    private class FakeSurface : KeyboardBridge.Surface {
        val calls = ArrayList<String>()
        var focused = true
        var shownText = ""
        var shownChips: List<KeyboardBridge.Chip> = emptyList()
        var flashes = 0

        override fun configure(prompt: String, submitTitle: String, secure: Boolean, numeric: Boolean, text: String, cancellable: Boolean, chips: List<KeyboardBridge.Chip>) {
            calls += "configure:$prompt:$submitTitle:$secure:$numeric:$text:$cancellable:${chips.size}"
            shownText = text
            shownChips = chips
        }

        override fun setPrompt(prompt: String) {
            calls += "prompt:$prompt"
        }

        override fun setText(text: String) {
            shownText = text
        }

        override fun setChips(chips: List<KeyboardBridge.Chip>) {
            shownChips = chips
        }

        override fun setCancellable(cancellable: Boolean) {
            calls += "cancellable:$cancellable"
        }

        override fun flashRejected() {
            flashes += 1
        }

        override val holdsFocus: Boolean get() = focused

        override fun takeFocus(): Boolean {
            calls += "takeFocus"
            focused = true
            return true
        }

        override fun giveUpFocus() {
            calls += "giveUpFocus"
            focused = false
        }

        override fun restoreFocus() {
            calls += "restoreFocus"
        }

        override fun openKeyboard(reconfigure: Boolean) {
            calls += "open:$reconfigure"
        }

        override fun closeKeyboard() {
            calls += "close"
        }

        override fun textChanged() {}

        /** The bar's text each time a composition was abandoned (so before the change that asked for it). */
        val abandons = ArrayList<String>()

        override fun abandonComposition() {
            abandons += shownText
        }

        override fun debugState(): Map<String, JsonElement> = emptyMap()

        override val visibleChips: List<KeyboardBridge.Chip> get() = KeyboardBridge.visibleChips(shownChips, shownText)

        override fun debugHardwareKey(name: String, down: Boolean): Boolean = false
    }

    @Before
    fun setUp() {
        clock = FakeScheduler()
        scripts = ArrayList()
        page = PageBridge(clock) { PageBridge.JsEvaluator { script, result -> scripts.add(script); result("1") } }
        bridge = KeyboardBridge(page, clock)
        bridge.onHaptic = { haptics.add(it) }
        bridge.onActivity = { activity += 1 }
        surface = FakeSurface()
        bridge.attachSurface(surface)
    }

    /** The LostCityHost.keyboard calls made since the last take, as "path(args…)" (args as compact JSON). */
    private fun calls(): List<String> {
        val pattern = Regex("""__lcCall\((\d+),("(?:[^"\\]|\\.)*"),(\[.*])\),1\)""")
        val list = scripts.mapNotNull { script ->
            val match = pattern.find(script) ?: return@mapNotNull null
            val path = Json.parseToJsonElement(match.groupValues[2]).jsonPrimitive.content.removePrefix("keyboard.")
            val args = Json.parseToJsonElement(match.groupValues[3]) as JsonArray
            if (args.isEmpty()) path else "$path(${args.joinToString(",") { it.toString() }})"
        }
        scripts.clear()
        return list
    }

    private fun idOf(path: String): Long =
        Regex("""__lcCall\((\d+),"$path"""").find(scripts.last { it.contains("\"$path\"") })!!.groupValues[1].toLong()

    private fun show(kind: String = "chat", text: String = "", charset: String? = "chat", maxLength: Int? = 80, chips: JsonArray? = null, numeric: Boolean = false, cancellable: Boolean = false) {
        bridge.handle(buildJsonObject {
            put("type", JsonPrimitive("keyboard"))
            put("action", JsonPrimitive("show"))
            put("kind", JsonPrimitive(kind))
            put("prompt", JsonPrimitive(""))
            put("text", JsonPrimitive(text))
            put("secure", JsonPrimitive(kind == "login-pass"))
            put("numeric", JsonPrimitive(numeric))
            put("cancellable", JsonPrimitive(cancellable))
            charset?.let { put("charset", JsonPrimitive(it)) }
            maxLength?.let { put("maxLength", JsonPrimitive(it)) }
            chips?.let { put("chips", it) }
        })
        scripts.clear()
    }

    private fun chip(label: String?, text: String?, submit: Boolean? = null, whenEmpty: Boolean? = null) = buildJsonObject {
        label?.let { put("label", JsonPrimitive(it)) }
        text?.let { put("text", JsonPrimitive(it)) }
        submit?.let { put("submit", JsonPrimitive(it)) }
        whenEmpty?.let { put("whenEmpty", JsonPrimitive(it)) }
    }

    /** In front with window focus, long enough ago that an IME closing now is the player's doing. */
    private fun inFront() {
        bridge.resume()
        bridge.windowFocusChanged(true)
        clock.advance(2_000)
        scripts.clear()
        surface.calls.clear()
    }

    // ------------------------------------------------------------------------------------------------ rules

    @Test
    fun everyCharset() {
        val chat = KeyboardBridge.Charset.CHAT
        assertTrue(chat.allows("a", ""))
        assertTrue(chat.allows("z", ""))
        assertTrue(chat.allows(" ", ""))
        assertFalse("{ outside a :: command", chat.allows("{", "hello"))
        assertTrue("{ | } ~ in a :: command", listOf("{", "|", "}", "~").all { chat.allows(it, "::x") })
        assertFalse(chat.allows("\u007F", "::"))
        assertFalse(chat.allows("é", ""))

        val text = KeyboardBridge.Charset.TEXT
        assertTrue(text.allows("!", ""))
        assertFalse(text.allows("~", "::"))

        val alnum = KeyboardBridge.Charset.ALNUM
        assertTrue(listOf("a", "Z", "5", " ").all { alnum.allows(it, "") })
        assertFalse(listOf("-", "_", ".", "é").any { alnum.allows(it, "") })

        val game = KeyboardBridge.Charset.GAME
        assertTrue(listOf("a", "9", " ", "!", "\"", "£", "$", "%", "^", "&", "*", "(", ")", "-", "_", "=", "+", "[", "{", "]", "}", ";", ":", "'", "@", "#", "~", ",", "<", ".", ">", "/", "?", "\\", "|").all { game.allows(it, "") })
        assertFalse("€ and ` are not in Client.CHARSET", game.allows("€", "") || game.allows("`", ""))

        val name = KeyboardBridge.Charset.NAME
        assertTrue(listOf("a", "Q", "0", " ", "-", "_").all { name.allows(it, "") })
        assertFalse(name.allows(".", ""))

        val digits = KeyboardBridge.Charset.DIGITS
        assertTrue((0..9).all { digits.allows("$it", "") })
        assertFalse(digits.allows("a", "") || digits.allows("-", ""))

        val any = KeyboardBridge.Charset.ANY
        assertTrue(any.allows("👍🏽", "") && any.allows("é", ""))
        // one Unicode scalar per character, as iOS: an emoji with a skin tone is refused (and counts as one)
        assertFalse(text.allows("👍🏽", ""))
    }

    @Test
    fun theFilterCountsTheLineAsItGrows() {
        val chat = KeyboardBridge.Rules(KeyboardBridge.Charset.CHAT, 80)
        assertEquals(KeyboardBridge.Rules.Filtered("::~bank", false), chat.filter("::~bank", ""))
        assertEquals(KeyboardBridge.Rules.Filtered("a", true), chat.filter("a~", ""))
        val name = KeyboardBridge.Rules(KeyboardBridge.Charset.NAME, 12)
        assertEquals(KeyboardBridge.Rules.Filtered("abcdef", true), name.filter("abc.def", "ab"))
        assertEquals("room: 12 minus the line", KeyboardBridge.Rules.Filtered("cdefghijkl", true), name.filter("cdefghijklmn", "ab"))
        val digits = KeyboardBridge.Rules(KeyboardBridge.Charset.DIGITS, 3)
        assertEquals(KeyboardBridge.Rules.Filtered("23", true), digits.filter("2345", "1"))
        assertEquals(KeyboardBridge.Rules.Filtered("", true), digits.filter("5", "123"))
        assertEquals(KeyboardBridge.Rules.Filtered("👍🏽x", false), KeyboardBridge.Rules().filter("👍🏽x", ""))
    }

    @Test
    fun messageParsing() {
        assertNull(KeyboardBridge.rules(buildJsonObject { put("text", JsonPrimitive("a")) }))
        assertEquals(KeyboardBridge.Rules(KeyboardBridge.Charset.ANY, null), KeyboardBridge.rules(buildJsonObject { put("charset", JsonPrimitive("klingon")) }))
        assertEquals("maxLength ≤ 0 is no limit", KeyboardBridge.Rules(KeyboardBridge.Charset.NAME, null), KeyboardBridge.rules(buildJsonObject { put("charset", JsonPrimitive("name")); put("maxLength", JsonPrimitive(0)) }))
        assertEquals(KeyboardBridge.Rules(KeyboardBridge.Charset.ANY, 12), KeyboardBridge.rules(buildJsonObject { put("maxLength", JsonPrimitive(12)) }))

        assertNull("absent: keep the current chips", KeyboardBridge.chips(null))
        assertNull(KeyboardBridge.chips(kotlinx.serialization.json.JsonNull))
        assertEquals("not a list", emptyList<KeyboardBridge.Chip>(), KeyboardBridge.chips(JsonPrimitive("::")))
        assertEquals("a list with something that is not a chip", emptyList<KeyboardBridge.Chip>(), KeyboardBridge.chips(JsonArray(listOf(chip("a", "a"), JsonPrimitive(1)))))
        val parsed = KeyboardBridge.chips(JsonArray(listOf(chip(null, "::", whenEmpty = true), chip("", "5", submit = true), chip("x", ""), chip("Bank", "::~bank"))))!!
        assertEquals(
            listOf(
                KeyboardBridge.Chip("::", "::", submit = false, whenEmpty = true),
                KeyboardBridge.Chip("5", "5", submit = true, whenEmpty = false),
                KeyboardBridge.Chip("Bank", "::~bank", submit = false, whenEmpty = false),
            ),
            parsed,
        )
        assertEquals("at most 24", 24, KeyboardBridge.chips(JsonArray((1..30).map { chip("$it", "$it") }))!!.size)
    }

    @Test
    fun perKindTables() {
        assertEquals(KeyboardBridge.IME_ACTION_SEND, KeyboardBridge.imeAction("chat"))
        assertEquals(KeyboardBridge.IME_ACTION_SEND, KeyboardBridge.imeAction("social"))
        assertEquals(KeyboardBridge.IME_ACTION_GO, KeyboardBridge.imeAction("login-user"))
        assertEquals(KeyboardBridge.IME_ACTION_GO, KeyboardBridge.imeAction("login-pass"))
        assertEquals(KeyboardBridge.IME_ACTION_DONE, KeyboardBridge.imeAction("dialog"))
        assertEquals(listOf("Send", "Send", "Log in", "Log in", "OK"), listOf("chat", "social", "login-user", "login-pass", "dialog").map(KeyboardBridge::submitTitle))
        assertEquals(listOf("Chat", "Username", "Password", "Enter amount", "Player name", ""), listOf("chat", "login-user", "login-pass", "dialog", "report", "social").map(KeyboardBridge::defaultPrompt))
        // VISIBLE_PASSWORD | NO_SUGGESTIONS, never the PASSWORD variation; a number pad for amounts
        assertEquals(0x80091, KeyboardBridge.TEXT_INPUT_TYPE)
        assertEquals(2, KeyboardBridge.NUMBER_INPUT_TYPE)
    }

    @Test
    fun hardwareKeyNamesAreIosOnes() {
        val names = KeyboardBridge.GAME_KEYS
        assertEquals("ArrowLeft", names[KeyEvent.KEYCODE_DPAD_LEFT])
        assertEquals("Enter", names[KeyEvent.KEYCODE_NUMPAD_ENTER])
        assertEquals("Backspace", names[KeyEvent.KEYCODE_DEL])
        assertEquals("Delete", names[KeyEvent.KEYCODE_FORWARD_DEL])
        assertEquals("Control", names[KeyEvent.KEYCODE_CTRL_RIGHT])
        assertEquals("F12", names[KeyEvent.KEYCODE_F12])
        assertNull("Space is a character, never a named key", names[KeyEvent.KEYCODE_SPACE])
        assertEquals(29, names.size)
    }

    // ------------------------------------------------------------------------------------------------ show, typing

    @Test
    fun showConfiguresTheBarAndRestartsOnlyWhenTheEditorChanges() {
        show(kind = "login-user", text = "bob", charset = "name", maxLength = 12)
        assertEquals("configure:Username:Log in:false:false:bob:false:0", surface.calls[0])
        assertEquals("open:true", surface.calls.last())
        assertEquals("bob", bridge.displayText)
        surface.calls.clear()
        show(kind = "login-pass", text = "", charset = "game", maxLength = 20)
        assertEquals("the same editor (text, Go): nothing to restart", "open:false", surface.calls.last())
        show(kind = "dialog", numeric = true, charset = "digits", maxLength = 10, cancellable = true)
        assertEquals("a number pad: restart", "open:true", surface.calls.last())
        assertEquals(KeyboardBridge.NUMBER_INPUT_TYPE, bridge.inputType)
        assertEquals("configure:Enter amount:OK:false:true::true:0", surface.calls.first { it.startsWith("configure:Enter") })
    }

    @Test
    fun typingIsFilteredEchoedAndReconciled() {
        show(kind = "login-user", charset = "name", maxLength = 5)
        bridge.insertText("ab.c")
        assertEquals(listOf("insertText(\"abc\")"), calls())
        assertEquals(listOf("warning"), haptics)
        assertEquals(1, surface.flashes)
        assertEquals("abc", bridge.displayText)
        assertEquals("abc", surface.shownText)
        // a poll older than the keystroke: the bar keeps the echo
        clock.advance(100)
        bridge.update(prompt = null, text = "a")
        assertEquals("abc", bridge.displayText)
        // the page's text wins once the grace has passed and nothing newer came
        clock.advance(500)
        assertEquals("a", bridge.displayText)
        assertEquals("a", surface.shownText)
        // a poll that matches is taken at once
        bridge.insertText("x")
        bridge.update(prompt = null, text = "ax")
        assertEquals("ax", bridge.displayText)
        // past maxLength: refused
        bridge.insertText("1234")
        assertEquals(listOf("insertText(\"x\")", "insertText(\"123\")"), calls())
        assertTrue(activity > 0)
    }

    @Test
    fun refusalsAreFeltAtMostEvery300Ms() {
        show(charset = "digits", maxLength = 10)
        bridge.insertText("a")
        clock.advance(100)
        bridge.insertText("b")
        assertEquals(2, bridge.rejections)
        assertEquals(listOf("warning"), haptics)
        clock.advance(301)
        bridge.insertText("c")
        assertEquals(listOf("warning", "warning"), haptics)
        assertEquals(2, surface.flashes)
        assertTrue("nothing reached the page", calls().isEmpty())
    }

    @Test
    fun returnSubmitsAndTheChatBarEmptiesAtOnce() {
        show(kind = "chat")
        bridge.insertText("hi\n")
        assertEquals(listOf("insertText(\"hi\")", "submit"), calls())
        assertEquals("", bridge.displayText)
        bridge.insertText("a\r\nb")
        assertEquals("\\r\\n is one Return", listOf("insertText(\"a\")", "submit", "insertText(\"b\")"), calls())

        show(kind = "login-user", text = "bob", charset = "name", maxLength = 12)
        bridge.submit("bar")
        assertEquals(listOf("submit"), calls())
        assertEquals("other inputs: the page decides", "bob", bridge.displayText)
        bridge.update(prompt = null, text = "")
        assertEquals("…and its next update wins at once", "", bridge.displayText)
    }

    @Test
    fun quotesAndDashesBecomeAscii() {
        show(kind = "chat")
        bridge.insertText("“ok” ‘a’ –— …")
        assertEquals(listOf("insertText(\"\\\"ok\\\" 'a' -- ...\")"), calls())
    }

    @Test
    fun chipsReplaceTheLineAndMaySubmit() {
        show(kind = "dialog", text = "12", numeric = true, charset = "digits", maxLength = 10, chips = JsonArray(listOf(chip("5", "5", submit = true))))
        bridge.update(prompt = null, text = "123") // the game has one more than the bar showed
        bridge.apply(bridge.chips[0])
        assertEquals(listOf("deleteBackward", "deleteBackward", "deleteBackward", "insertText(\"5\")", "submit"), calls())
        assertEquals("5", bridge.debugTapChip(0))

        show(kind = "chat", chips = JsonArray(listOf(chip("::", "::", whenEmpty = true), chip("::tele", "::tele 3222 3222"))))
        assertEquals(listOf("::", "::tele"), surface.visibleChips.map { it.label })
        bridge.insertText("x")
        assertEquals("a whenEmpty chip only shows while the line is empty", listOf("::tele"), surface.visibleChips.map { it.label })
        assertEquals(listOf("::tele"), KeyboardBridge.visibleChips(bridge.chips, "x").map { it.label })
        scripts.clear()
        bridge.hide(userInitiated = false)
        bridge.apply(KeyboardBridge.Chip("a", "a", false, false))
        assertTrue("no chips while idle", calls().isEmpty())
    }

    @Test
    fun aChangeOutsideTheImeEndsItsCompositionFirst() {
        show(kind = "chat", chips = JsonArray(listOf(chip("::tele", "::tele 3222 3222"))))
        // the IME's own edits never do (a composition goes through replaceTail; the IME's calls end it themselves)
        bridge.replaceTail(0, "hello")
        bridge.insertText("!")
        bridge.deleteBackward()
        assertEquals(emptyList<String>(), surface.abandons)
        // the bar's Send, before the line empties (else voice input's next edit is diffed against the sent line)
        bridge.submit("bar")
        assertEquals(listOf("hello"), surface.abandons)
        // a chip, before its deletes
        bridge.replaceTail(0, "wor")
        bridge.apply(bridge.chips[0])
        assertEquals(listOf("hello", "wor"), surface.abandons)
        // a hardware Backspace, then Enter
        bridge.keyDown(KeyEvent.KEYCODE_DEL, "Backspace")
        bridge.keyUp(KeyEvent.KEYCODE_DEL)
        bridge.keyDown(KeyEvent.KEYCODE_ENTER, "Enter")
        bridge.keyUp(KeyEvent.KEYCODE_ENTER)
        assertEquals(listOf("hello", "wor", "::tele 3222 3222", "::tele 3222 322"), surface.abandons)
        // another field: a restarted editor ends it by itself (openKeyboard(true)); the same editor (username → password,
        // both text with Go) is told
        show(kind = "login-user", text = "bob", charset = "name", maxLength = 12)
        assertEquals(4, surface.abandons.size)
        show(kind = "login-pass", text = "", charset = "game", maxLength = 20)
        assertEquals(5, surface.abandons.size)
        assertEquals("open:false", surface.calls.last())
    }

    @Test
    fun pasteIsOneLineOfAtMost80() {
        show(kind = "chat")
        bridge.pasteText("“Hi”—there\n\n friend…\n")
        assertEquals("line breaks (runs of them) are one space, never a submit", listOf("insertText(\"\\\"Hi\\\"-there  friend...\")"), calls())
        assertTrue(haptics.isEmpty())
        bridge.submit("bar")
        calls()
        bridge.pasteText("x".repeat(81))
        assertEquals(listOf("insertText(\"${"x".repeat(80)}\")"), calls())
        assertEquals("what is cut off is refused", listOf("warning"), haptics)

        // with no keyboard asked for (Ctrl+V in game) it takes what chat takes
        bridge.hide(userInitiated = false)
        clock.advance(400)
        bridge.pasteText("a{b")
        assertEquals(listOf("insertText(\"ab\")"), calls())
        assertEquals(2, haptics.size)
        assertEquals("no bar to flash while idle", 1, surface.flashes)
        assertEquals("a b", KeyboardBridge.pasteLine("a b"))
    }

    @Test
    fun aCommitWithAnyLineBreakIsAPaste() {
        // GameInputConnection.commitText: several characters with a line break among them (the IME's clipboard chip) are
        // one pasted line; Unicode's line breaks count as iOS counts them (Character.isNewline), not only \n and \r
        for (text in listOf("a\nb", "a\rb", "a\r\nb", "a b", "a b", "a\u0085b", "a\u000Bb", "a\u000Cb", "a ", " b")) {
            assertTrue("a paste: ${text.map { it.code.toString(16) }}", KeyboardBridge.isPaste(text))
            assertEquals("one line: ${text.map { it.code.toString(16) }}", text.filter { it in "ab" }.toList().joinToString(" "), KeyboardBridge.pasteLine(text))
        }
        for (text in listOf("\n", "\r", "\r\n", " ", "\u0085", "ab", "a", "")) {
            assertFalse("not a paste: ${text.map { it.code.toString(16) }}", KeyboardBridge.isPaste(text))
        }
        show(kind = "chat")
        bridge.pasteText("hi there friend\r\nok")
        assertEquals("never a submit", listOf("insertText(\"hi there friend ok\")"), calls())
    }

    // ------------------------------------------------------------------------------------------------ cancel, hide, reset

    @Test
    fun cancelFallsBackToDismissedOnAPageWithoutIt() {
        show(kind = "dialog", numeric = true, charset = "digits", cancellable = true)
        bridge.cancel()
        assertFalse(bridge.requested)
        assertTrue(surface.calls.contains("close"))
        val id = idOf("keyboard.cancel")
        assertTrue("cancel waits for its answer", id > 0)
        page.onReply(buildJsonObject {
            put("ch", JsonPrimitive("reply")); put("id", JsonPrimitive(id)); put("ok", JsonPrimitive(false)); put("error", JsonPrimitive("missing"))
        })
        assertEquals(listOf("cancel", "dismissed"), calls())
        bridge.cancel()
        assertTrue("only while requested", calls().isEmpty())
    }

    @Test
    fun onlyTheUsersHideIsDismissed() {
        show()
        bridge.hide(userInitiated = false)
        assertTrue(calls().isEmpty())
        show()
        bridge.hide(userInitiated = true)
        assertEquals(listOf("dismissed"), calls())
        bridge.hide(userInitiated = true)
        assertTrue(calls().isEmpty())
    }

    @Test
    fun theBarsSendDoesNothingOnceTheKeyboardIsHidden() {
        // after a hide the bar rides down with the IME for a moment; a tap on its Send then must not submit
        show(kind = "chat", text = "hi")
        calls()
        bridge.debugTapBar("submit") // (what the bar's button calls)
        assertEquals(listOf("submit"), calls())
        bridge.hide(userInitiated = false) // the page hid it (a tap in the world)
        bridge.debugTapBar("submit")
        assertEquals("no submit after the page's hide", emptyList<String>(), calls())
        show(kind = "chat", text = "hi")
        calls()
        bridge.debugTapBar("hide") // the player's hide: dismissed, then the bar rides down
        assertEquals(listOf("dismissed"), calls())
        bridge.debugTapBar("submit")
        assertEquals("no submit after the player's hide", emptyList<String>(), calls())
        bridge.submit("return") // (the IME's own Return is not the bar's)
        assertEquals(listOf("submit"), calls())
    }

    @Test
    fun aPageResetForgetsEverything() {
        show(text = "abc")
        bridge.keyDown(KeyEvent.KEYCODE_DPAD_LEFT, "ArrowLeft")
        bridge.reportCovered(347, 0.285)
        calls()
        bridge.reset()
        assertEquals("held keys go up", listOf("pressKey(\"ArrowLeft\",false)"), calls())
        assertFalse(bridge.requested)
        assertEquals("", bridge.displayText)
        assertEquals("what a new page assumes (without telling the old one)", 0, bridge.coveredHeight)
        assertEquals("close", surface.calls.last())
        assertEquals(KeyboardBridge.Rules(), bridge.rules)
    }

    // ------------------------------------------------------------------------------------------------ hardware keys

    @Test
    fun heldBackspaceRepeatsAsIos() {
        show(text = "abcdef")
        bridge.keyDown(KeyEvent.KEYCODE_DEL, "Backspace")
        bridge.keyDown(KeyEvent.KEYCODE_DEL, "Backspace") // (a second down while held: nothing)
        assertEquals(listOf("pressKey(\"Backspace\",true)"), calls())
        clock.advance(399)
        assertTrue(calls().isEmpty())
        clock.advance(1)
        clock.advance(100)
        assertEquals("first at 400 ms, then every 50 ms (400, 450, 500)", 3, calls().count { it == "pressKey(\"Backspace\",true)" })
        assertEquals("the bar follows every one (the first down and three repeats)", "ab", bridge.displayText)
        bridge.keyUp(KeyEvent.KEYCODE_DEL)
        clock.advance(500)
        assertEquals(listOf("pressKey(\"Backspace\",false)"), calls())
        bridge.keyUp(KeyEvent.KEYCODE_DEL)
        assertTrue(calls().isEmpty())
    }

    @Test
    fun enterCommitsTheLineAndArrowsDoNotRepeat() {
        show(kind = "chat", text = "hello")
        bridge.keyDown(KeyEvent.KEYCODE_ENTER, "Enter")
        assertEquals("", bridge.displayText)
        bridge.keyDown(KeyEvent.KEYCODE_DPAD_UP, "ArrowUp")
        clock.advance(2_000)
        bridge.keyUp(KeyEvent.KEYCODE_ENTER)
        assertEquals(listOf("pressKey(\"Enter\",true)", "pressKey(\"ArrowUp\",true)", "pressKey(\"Enter\",false)"), calls())
        assertEquals(listOf("ArrowUp"), bridge.heldKeyNames)
        bridge.pause()
        assertEquals("pause releases what is held", listOf("pressKey(\"ArrowUp\",false)"), calls())
    }

    // ------------------------------------------------------------------------------------------------ covered height

    @Test
    fun theCoveredHeightFollowsTheImeWithItsDuration() {
        inFront()
        show()
        bridge.imeAnimationStarted(0f, 295.24f, 0.285)
        assertEquals(listOf("frame(347.0,0.285,\"cubic-bezier(0.2, 0, 0, 1)\")"), calls())
        bridge.imeAnimationEnded(295.24f)
        assertTrue("unchanged: not sent again", calls().isEmpty())
        assertTrue(bridge.softwareKeyboardVisible)
        bridge.hide(userInitiated = false)
        bridge.imeAnimationStarted(295.24f, 0f, 0.285)
        assertEquals(listOf("frame(0.0,0.285,\"cubic-bezier(0.2, 0, 0, 1)\")"), calls())
        bridge.imeAnimationEnded(0f)
        assertFalse(bridge.softwareKeyboardVisible)
        // the bar alone (a hardware keyboard): up at once, down with the last animation's duration (iOS's rule)
        show()
        bridge.settle()
        assertEquals(listOf("frame(52.0,0.0,\"cubic-bezier(0.2, 0, 0, 1)\")"), calls())
        bridge.hide(userInitiated = false)
        bridge.settle()
        assertEquals(listOf("frame(0.0,0.285,\"cubic-bezier(0.2, 0, 0, 1)\")"), calls())
        assertEquals(0, bridge.coveredFor(300f))
    }

    @Test
    fun anImeTheUserClosesIsDismissed() {
        inFront()
        show()
        bridge.imeAnimationStarted(0f, 295f, 0.285)
        bridge.imeAnimationEnded(295f)
        calls()
        bridge.imeAnimationStarted(295f, 0f, 0.285)
        assertEquals(listOf("dismissed", "frame(0.0,0.285,\"cubic-bezier(0.2, 0, 0, 1)\")"), calls())
        assertFalse(bridge.requested)

        // an IME without an animation
        show()
        bridge.imeSettled(295f)
        calls()
        bridge.imeSettled(0f)
        assertEquals("dismissed", calls().first())
    }

    @Test
    fun anImeTheSystemClosesIsNot() {
        inFront()
        show()
        bridge.imeAnimationEnded(295f)
        // a hardware keyboard attached: the IME goes, the bar stays (covering 52)
        bridge.hardKeyboardChanged(KeyboardBridge.HARD_KEYBOARD_PRESENT + 1)
        bridge.hardKeyboardChanged(KeyboardBridge.HARD_KEYBOARD_PRESENT)
        clock.advance(100)
        calls()
        bridge.imeAnimationStarted(295f, 0f, 0.285)
        assertTrue(bridge.requested)
        assertEquals(listOf("frame(52.0,0.285,\"cubic-bezier(0.2, 0, 0, 1)\")"), calls())
        // the app leaving the front: kept, and the page is not told (its chatbox would drop and jump back on return)
        bridge.imeAnimationEnded(295f)
        calls()
        bridge.pause()
        bridge.imeAnimationStarted(295f, 0f, 0.285)
        bridge.imeAnimationEnded(0f)
        assertTrue(bridge.requested)
        assertTrue(calls().isEmpty())
        // a lend (a native text field took the keyboard)
        bridge.resume()
        clock.advance(1_000)
        bridge.imeAnimationEnded(295f)
        val handle = bridge.lend()
        bridge.imeAnimationStarted(295f, 0f, 0.285)
        assertTrue(bridge.requested)
        handle.close()
        // window focus coming back (the system may hide the IME then)
        bridge.imeAnimationEnded(295f)
        bridge.windowFocusChanged(false)
        bridge.windowFocusChanged(true)
        clock.advance(100)
        bridge.imeAnimationStarted(295f, 0f, 0.285)
        assertTrue(bridge.requested)
        assertFalse(calls().contains("dismissed"))
    }

    @Test
    fun aRotationKeepsTheKeyboardAndAsksForTheImeAgain() {
        inFront()
        show()
        bridge.imeAnimationEnded(295f)
        calls()
        surface.calls.clear()
        // a 180° turn: the IME goes without an animation; the page hears nothing (its chatbox would dip)
        bridge.displayRotated()
        bridge.imeSettled(0f)
        assertTrue(bridge.requested)
        assertTrue(calls().isEmpty())
        // it does not come back by itself: asked for again, and once the rotation is over the bar alone is reported
        clock.advance(KeyboardBridge.REASK_MS)
        assertEquals(listOf("open:false"), surface.calls)
        assertTrue(calls().isEmpty())
        clock.advance(KeyboardBridge.SYSTEM_CHANGE_GRACE_MS - KeyboardBridge.REASK_MS)
        assertEquals("(going down with no animation of its own: iOS's default duration, none seen yet)", listOf("frame(52.0,0.25,\"cubic-bezier(0.2, 0, 0, 1)\")"), calls())
        bridge.settle()
        assertTrue(calls().isEmpty())
        // it comes back with an animation while a settle is pending: the settle goes by where it is going
        bridge.imeAnimationStarted(0f, 295f, 0.285)
        assertEquals(listOf("frame(347.0,0.285,\"cubic-bezier(0.2, 0, 0, 1)\")"), calls())
        bridge.displayRotated()
        bridge.imeSettled(0f)
        bridge.imeAnimationStarted(0f, 295f, 0.285)
        clock.advance(KeyboardBridge.SYSTEM_CHANGE_GRACE_MS)
        bridge.settle()
        assertTrue("no dip while it animates back in", calls().isEmpty())
        // when it comes back by itself nothing more is asked
        bridge.imeAnimationStarted(0f, 295f, 0.285)
        bridge.imeAnimationEnded(295f)
        surface.calls.clear()
        bridge.displayRotated()
        bridge.imeSettled(0f)
        bridge.imeSettled(295f)
        clock.advance(KeyboardBridge.REASK_MS)
        assertTrue(surface.calls.isEmpty())
    }

    @Test
    fun anImeThatResizesItselfIsFollowedAtOnce() {
        inFront()
        show()
        // Gboard now and then comes up 24 px (9 dp) taller and settles lower a moment later, with no animation of its own
        bridge.imeAnimationStarted(0f, 304f, 0.285)
        bridge.imeAnimationEnded(304f)
        assertEquals(listOf("frame(356.0,0.285,\"cubic-bezier(0.2, 0, 0, 1)\")"), calls())
        bridge.imeSettled(295f)
        assertEquals("(the IME and the bar are there already: the page moves with them, not after them)", listOf("frame(347.0,0.0,\"cubic-bezier(0.2, 0, 0, 1)\")"), calls())
        // a keyboard going down with no animation of its own still takes the duration it came up with (iOS's rule)
        bridge.hide(userInitiated = false)
        calls()
        show()
        bridge.imeSettled(295f)
        calls()
        bridge.handle(buildJsonObject { put("type", JsonPrimitive("keyboard")); put("action", JsonPrimitive("hide")) })
        bridge.imeSettled(0f)
        assertEquals(listOf("frame(0.0,0.285,\"cubic-bezier(0.2, 0, 0, 1)\")"), calls().filter { it.startsWith("frame") })
    }

    @Test
    fun aRequestWaitsLongerForTheImeWithoutAHardwareKeyboard() {
        // without a hardware keyboard the IME is coming, however slowly it starts: no step to the bar's 52 dp first
        bridge.hardKeyboardChanged(KeyboardBridge.HARD_KEYBOARD_PRESENT + 1)
        assertEquals(KeyboardBridge.SETTLE_IME_MS, bridge.settleDelayMs())
        // with one it may never come (Show on-screen keyboard off): the bar alone covers the page soon
        bridge.hardKeyboardChanged(KeyboardBridge.HARD_KEYBOARD_PRESENT)
        assertEquals(KeyboardBridge.SETTLE_HARD_KEYBOARD_MS, bridge.settleDelayMs())
    }

    @Test
    fun settleWaitsBeforeLoweringWhileRequested() {
        inFront()
        show()
        bridge.imeAnimationStarted(0f, 295f, 0.285)
        bridge.imeAnimationEnded(295f)
        calls()
        // back in the app: the system hides the IME for an instant (not passed on while not in front)...
        bridge.pause()
        bridge.imeSettled(0f)
        bridge.windowFocusChanged(false)
        bridge.resume()
        bridge.windowFocusChanged(true)
        clock.advance(300)
        bridge.settle() // openKeyboard's check finds no IME yet
        clock.advance(KeyboardBridge.SETTLE_AGAIN_MS)
        bridge.imeSettled(0f) // (and the system hides it once more, a second after the return)
        clock.advance(600)
        bridge.imeSettled(295f) // ...and it is back
        clock.advance(KeyboardBridge.RETURN_GRACE_MS)
        assertTrue("the page's chatbox never dropped", calls().none { it.startsWith("frame") })
        // an IME that does not come back: the bar alone, once the return is over
        bridge.pause()
        bridge.windowFocusChanged(false)
        bridge.resume()
        bridge.windowFocusChanged(true)
        bridge.imeSettled(0f)
        bridge.settle()
        clock.advance(KeyboardBridge.RETURN_GRACE_MS - 1)
        assertTrue(calls().isEmpty())
        clock.advance(1)
        assertEquals(listOf("frame(52.0,0.285,\"cubic-bezier(0.2, 0, 0, 1)\")"), calls())
        bridge.imeSettled(295f)
        calls()
        // a hidden keyboard (not requested) is reported at once
        bridge.hide(userInitiated = false)
        bridge.settle()
        assertEquals(listOf("frame(0.0,0.285,\"cubic-bezier(0.2, 0, 0, 1)\")"), calls())
    }

    // ------------------------------------------------------------------------------------------------ focus

    @Test
    fun aLendGivesFocusAwayAndBack() {
        inFront()
        show()
        bridge.reportCovered(347, 0.285)
        calls()
        surface.calls.clear()
        val first = bridge.lend()
        val second = bridge.lend()
        assertEquals(listOf("giveUpFocus"), surface.calls)
        assertTrue(bridge.lent)
        assertEquals("the page hears the keyboard go", listOf("frame(0.0,0.285,\"cubic-bezier(0.2, 0, 0, 1)\")"), calls())
        bridge.activate()
        assertEquals("activate waits while lent", listOf("giveUpFocus"), surface.calls)
        first.close()
        first.close()
        assertTrue("nested: still lent", bridge.lent)
        second.close()
        assertFalse(bridge.lent)
        assertEquals(listOf("giveUpFocus", "restoreFocus", "takeFocus", "open:false"), surface.calls)
    }

    @Test
    fun activateTakesFocusAndAsksForTheKeyboardAgain() {
        surface.focused = false
        bridge.activate()
        assertEquals(listOf("takeFocus"), surface.calls)
        show()
        surface.calls.clear()
        bridge.windowFocusChanged(true)
        assertEquals(listOf("open:false"), surface.calls)
    }

    @Test
    fun debugStateHasTheIosKeys() {
        show(kind = "login-pass", charset = "game", maxLength = 20)
        val state = bridge.debugState()
        for (key in listOf("isFirstResponder", "requested", "kind", "secure", "numeric", "keyboardType", "returnKeyType", "isSecureTextEntry", "displayText", "softwareKeyboardVisible", "inputView", "heldKeys", "cancellable", "cancelShown", "submitTitle", "charset", "maxLength", "chips", "coveredHeight", "rejections", "flashing", "canPaste", "imeVisible", "imeHeight")) {
            assertTrue(key, state.containsKey(key))
        }
        assertEquals(JsonPrimitive(false), state["isSecureTextEntry"])
        assertEquals(JsonPrimitive("game"), state["charset"])
        assertEquals(JsonPrimitive("system keyboard"), state["inputView"])
        assertTrue((state["requested"] as JsonPrimitive).content.toBoolean())
        assertEquals(JsonObject::class, state::class)
    }
}
