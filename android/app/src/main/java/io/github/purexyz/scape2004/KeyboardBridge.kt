// KeyboardBridge: the native keyboard, its logic and state (ports ios/LostCity/KeyboardBridge.swift; ARCHITECTURE.md §7: the
// `{type:'keyboard', action:'show'|'update'|'hide'}` messages and the LostCityHost.keyboard.* calls; docs/ANDROID.md §3.3
// `keyboard.frame(…, curve)` and §4.1).
//
// iOS keeps a hidden 1×1 UIKeyInput view first responder for the life of the app, in two modes: *requested* (after
// `show`: the system keyboard with the accessory bar above it) and *idle* (no software keyboard, but hardware keys still
// arrive there, whatever DOM element has focus). Android does the same with a focus-holding view (KeyboardBridgeView, one
// per activity): it keeps input focus for good (the WebView is never focusable, so a tap on the game cannot take it and
// close the keyboard), is a text editor only while requested (GameInputConnection), and gets the hardware keys in
// dispatchKeyEvent. This class is the part both platforms share, line for line where it can be: the input rules, the
// optimistic echo, chips, paste, the hardware keys' down/up and repeat, the covered height reported to the page, the
// per-kind tables, and the log lines. It touches no Android view (the activity's views are a [Surface]), so the JVM unit
// tests run it with a fake clock and a fake page.
//
// What differs from iOS, and why:
// * The software keyboard can be closed by the player without the bar (Back, the IME's own hide key, a swipe down on
//   Gboard): that is reported as `dismissed()`, as iOS reports the bar's hide button ([imeClosing]).
// * Back with the bar up and no IME showing (a hardware keyboard) closes the bar, as iOS's hide button ([back]).
// * The covered height is the IME's inset plus the 52 dp bar, reported once per IME animation start and at its end
//   (KeyboardInsets), with the IME's own duration and Android's IME curve.
// * Characters are counted as grapheme clusters (java.text.BreakIterator), as Swift counts Characters.
//
// UI thread only.
package io.github.purexyz.scape2004

import android.content.res.Configuration
import android.widget.FrameLayout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.text.BreakIterator
import java.util.Locale
import kotlin.math.max
import kotlin.math.roundToInt

class KeyboardBridge(private val page: PageBridge, private val scheduler: Scheduler) : SessionComponent, KeyboardFocus {
    // ------------------------------------------------------------------------------------------------ input rules

    /**
     * The characters an input takes (`charset` in the show message): at most what the client's own input code keeps
     * (Client.ts), so the bar never shows a character that the game then drops.
     */
    enum class Charset(val id: String) {
        /** Public chat: printable ASCII up to `z`, and `{ | } ~` only in a `::` command, the one place the client takes them. */
        CHAT("chat"),

        /** A private message: printable ASCII up to `z`. */
        TEXT("text"),

        /** Report abuse: letters, digits and space. */
        ALNUM("alnum"),

        /** The login password: the client's `CHARSET` (letters, digits, space and `!"£$%^&*()-_=+[{]};:'@#~,<.>/?\|`). */
        GAME("game"),

        /** The login username and the name prompts: letters, digits, space, `-` and `_`. */
        NAME("name"),
        DIGITS("digits"),
        ANY("any");

        /** Whether the input takes `character` (one grapheme cluster) after `line`, the text it holds so far. */
        fun allows(character: String, line: String): Boolean {
            if (this == ANY) return true
            // (one Unicode scalar, as Swift's `character.unicodeScalars.count == 1`)
            if (character.isEmpty() || character.codePointCount(0, character.length) != 1) return false
            val value = character.codePointAt(0)
            return when (this) {
                CHAT -> value in 32..122 || (value in 123..126 && line.startsWith("::"))
                TEXT -> value in 32..122
                ALNUM -> isAsciiLetterOrDigit(value) || value == ' '.code
                GAME -> value in GAME_CHARACTERS
                NAME -> isAsciiLetterOrDigit(value) || value == ' '.code || value == '-'.code || value == '_'.code
                DIGITS -> value in 48..57
                ANY -> true
            }
        }

        companion object {
            fun of(id: String): Charset? = entries.firstOrNull { it.id == id }

            private fun isAsciiLetterOrDigit(value: Int) = value in 'A'.code..'Z'.code || value in 'a'.code..'z'.code || value in '0'.code..'9'.code

            /** Client.CHARSET. */
            private val GAME_CHARACTERS: Set<Int> =
                "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!\"£$%^&*()-_=+[{]};:'@#~,<.>/?\\| "
                    .codePoints().toArray().toSet()
        }
    }

    /** What the current input takes; characters outside it never reach the page. */
    data class Rules(val charset: Charset = Charset.ANY, val maxLength: Int? = null) {
        data class Filtered(val accepted: String, val rejected: Boolean)

        /**
         * The characters of `text` that fit after `current`, and whether any were dropped. Each one is checked against the
         * line as it would be with the characters taken before it (a pasted or chip `::~bank` keeps its `~`).
         */
        fun filter(text: String, current: String): Filtered {
            var room = maxLength?.let { max(0, it - graphemeCount(current)) } ?: Int.MAX_VALUE
            val accepted = StringBuilder()
            val line = StringBuilder(current)
            var rejected = false
            for (character in graphemes(text)) {
                if (room > 0 && charset.allows(character, line.toString())) {
                    accepted.append(character)
                    line.append(character)
                    room -= 1
                } else {
                    rejected = true
                }
            }
            return Filtered(accepted.toString(), rejected)
        }
    }

    /** A one-tap entry from the page's `chips`: `text` replaces the input line, then it is submitted if `submit`. */
    data class Chip(val label: String, val text: String, val submit: Boolean, val whenEmpty: Boolean)

    // ------------------------------------------------------------------------------------------------ the activity's views

    /**
     * One activity's views (KeyboardBridgeView: the focus-holding view, the accessory bar, the IME insets). Null between
     * activities; the state here lives on and is shown again by the next one.
     */
    interface Surface {
        // the bar (KeyboardAccessoryBar)
        fun configure(prompt: String, submitTitle: String, secure: Boolean, numeric: Boolean, text: String, cancellable: Boolean, chips: List<Chip>)
        fun setPrompt(prompt: String)
        fun setText(text: String)
        fun setChips(chips: List<Chip>)
        fun setCancellable(cancellable: Boolean)

        /** Feedback for characters the input does not take (with the warning haptic native plays). */
        fun flashRejected()

        // input focus and the IME
        /** The view has input focus (iOS isFirstResponder). */
        val holdsFocus: Boolean

        /** requestFocus (iOS becomeFirstResponder); false if it could not take focus. */
        fun takeFocus(): Boolean

        /** A native text field needs the keyboard (yieldFirstResponder): the view gives up focus until [restoreFocus]. */
        fun giveUpFocus()
        fun restoreFocus()

        /** The bar shows and the IME is asked for; `reconfigure`: the editor changed (restartInput, iOS reloadInputViews). */
        fun openKeyboard(reconfigure: Boolean)

        /** Back to idle: the IME hides, the view is no text editor any more, the bar goes (with the IME, if it is up). */
        fun closeKeyboard()

        /** The text the bar shows changed outside an IME edit (a page update, the reconcile): the IME's mirror follows. */
        fun textChanged()

        /**
         * The line is about to change outside the IME (the bar's Send, a chip, a hardware Enter or Backspace, another
         * field): an open composition (voice input) ends and the IME is told (restartInput), so its next edit is not
         * diffed against a line that is gone. iOS has no marked text on its UIKeyInput. Not for the IME's own edits.
         */
        fun abandonComposition()

        /** The bar's state for `keyboard-state` (displayText, chips, cancelShown, flashing, submitTitle, …). */
        fun debugState(): Map<String, JsonElement>

        /** The chips on show, in order. */
        val visibleChips: List<Chip>

        /** A synthetic hardware key through the view's key path; false if the view has no such key. */
        fun debugHardwareKey(name: String, down: Boolean): Boolean
    }

    var surface: Surface? = null
        private set

    // ------------------------------------------------------------------------------------------------ state

    /** Typing on the software keyboard or its bar (they live in the IME's window: the activity does not see them). */
    var onActivity: (() -> Unit)? = null

    /** Plays a haptic style (`warning` when a character is refused), unless Settings › Vibration is off. */
    var onHaptic: ((String) -> Unit)? = null

    var requested = false
        private set
    var kind = ""
        private set
    var secure = false
        private set
    var numeric = false
        private set
    var cancellable = false
        private set
    var rules = Rules()
        private set
    var chips: List<Chip> = emptyList()
        private set
    var prompt = ""
        private set
    var submitTitle = "OK"
        private set

    /** The editor's input type and IME action (the EditorInfo of GameInputConnection), from the kind and `numeric`. */
    var inputType = TEXT_INPUT_TYPE
        private set
    var imeAction = IME_ACTION_DONE
        private set

    /** What the bar shows; may run ahead of [hostText] by the keys typed since the last `update`. */
    var displayText = ""
        private set

    /** The game's input line as last reported by the page. */
    private var hostText = ""
    private var echoDeadline = 0L
    private var reconcileTask: Cancellable? = null

    private val heldKeys = LinkedHashMap<Int, String>()
    private var repeatTask: Cancellable? = null
    private var repeatingKey: Int? = null

    /** The IME's inset (dp), as last reported by KeyboardInsets; > 0: the software keyboard is up. */
    var imeHeight = 0f
        private set
    val softwareKeyboardVisible: Boolean get() = imeHeight > 0f

    /** Where the IME is going (an animation's end; else where it is): what a settle reports. */
    private var imeTarget = 0f

    /** How much of the web view the keyboard and the bar cover, as last reported to the page (`keyboard.frame`), dp. */
    var coveredHeight = 0
        private set

    /** The last IME animation's duration (285 ms for Gboard on the emulator); iOS's default before the first one. */
    private var keyboardAnimation = 0.25
    private var lastRejection = Long.MIN_VALUE / 2
    var rejections = 0
        private set

    /** While a native text field has the keyboard (KeyboardFocus.lend): how many lends are open. */
    private var lends = 0
    val lent: Boolean get() = lends > 0

    private var resumed = false
    private var windowFocused = false
    private var lastWindowFocusChange = Long.MIN_VALUE / 2
    private var hardKeyboardHidden: Int? = null
    private var lastHardKeyboardChange = Long.MIN_VALUE / 2
    private var lastRotation = Long.MIN_VALUE / 2
    private var reask: Cancellable? = null

    /** When the app last came to the front (resumed, with window focus): the system hides and shows the IME meanwhile. */
    private var frontSince = Long.MIN_VALUE / 2

    // ------------------------------------------------------------------------------------------------ the session

    /** A (new) activity's views. If the page wants the keyboard, they show it again (with focus, once it is in front). */
    fun attachSurface(surface: Surface) {
        this.surface = surface
        if (requested) {
            surface.configure(prompt, submitTitle, secure, numeric, displayText, cancellable, chips)
        }
    }

    fun detachSurface(surface: Surface) {
        if (this.surface === surface) this.surface = null
    }

    /**
     * Takes input focus (idle or requested mode) if the view does not have it, and with the keyboard requested asks for
     * the IME again (iOS: becoming first responder with the keyboard requested brings the keyboard back; Android needs
     * the request). Called at `ready`, on resume, when the window gets focus back and when a lend ends.
     */
    fun activate() {
        val view = surface ?: return
        if (lent) return
        if (!view.holdsFocus) {
            val ok = view.takeFocus()
            Log.info("kbd", "first responder (${if (requested) "keyboard" else "hardware keys"}): $ok")
        }
        if (requested && view.holdsFocus) view.openKeyboard(reconfigure = false)
    }

    /** While a native text field needs the keyboard (the Claude key box), the view gives up focus; [activate] waits. */
    private fun yieldFirstResponder(give: Boolean) {
        val view = surface
        if (give) {
            if (view != null && view.holdsFocus) {
                view.giveUpFocus()
                Log.info("kbd", "first responder given to a native text field")
            }
            reportCovered(0, 0.0)
        } else {
            view?.restoreFocus()
        }
    }

    /** KeyboardFocus: the bot chat track's key dialog takes focus; closing the handle gives it back. */
    override fun lend(): AutoCloseable {
        lends += 1
        if (lends == 1) yieldFirstResponder(true)
        var closed = false
        return AutoCloseable {
            if (closed) return@AutoCloseable
            closed = true
            lends -= 1
            if (lends == 0) {
                yieldFirstResponder(false)
                activate()
            }
        }
    }

    // ------------------------------------------------------------------------------------------------ page → native

    fun handle(message: JsonObject) {
        when (message.string("action")) {
            "show" -> show(
                kind = message.string("kind") ?: "chat",
                prompt = message.string("prompt") ?: "",
                text = message.string("text") ?: "",
                secure = message.bool("secure") ?: false,
                numeric = message.bool("numeric") ?: false,
                cancellable = message.bool("cancellable") ?: false,
                rules = rules(message) ?: Rules(),
                chips = chips(message["chips"]) ?: emptyList(),
            )
            "update" -> update(
                prompt = message.string("prompt"),
                text = message.string("text"),
                chips = chips(message["chips"]),
                rules = rules(message),
                cancellable = message.bool("cancellable"),
            )
            "hide" -> hide(userInitiated = false)
            else -> Log.info("kbd", "unknown keyboard message: ${JsonText.canonical(message)}")
        }
    }

    fun show(
        kind: String,
        prompt: String,
        text: String,
        secure: Boolean,
        numeric: Boolean,
        cancellable: Boolean = false,
        rules: Rules = Rules(),
        chips: List<Chip> = emptyList(),
    ) {
        val type = if (numeric) NUMBER_INPUT_TYPE else TEXT_INPUT_TYPE
        val action = imeAction(kind)
        // Only a different keyboard or action key needs the editor restarted (iOS reloadInputViews).
        val reconfigure = !requested || type != inputType || action != imeAction
        this.kind = kind
        this.secure = secure
        this.numeric = numeric
        this.cancellable = cancellable
        this.rules = rules
        this.chips = chips
        inputType = type
        imeAction = action
        requested = true
        reconcileTask?.cancel()
        echoDeadline = 0
        hostText = text
        displayText = text
        this.prompt = prompt.ifEmpty { defaultPrompt(kind) }
        submitTitle = submitTitle(kind)
        val view = surface
        view?.configure(this.prompt, submitTitle, secure, numeric, text, cancellable, chips)
        Log.info(
            "kbd",
            "show kind=$kind numeric=$numeric secure=$secure cancellable=$cancellable " +
                "charset=${rules.charset.id} max=${rules.maxLength ?: "-"} chips=${chips.size}",
        )
        if (view == null || lent) return // the next activity, or the end of the lend, shows it
        if (!view.holdsFocus) {
            if (!view.takeFocus()) Log.info("kbd", "show: becomeFirstResponder failed")
            view.openKeyboard(reconfigure = true)
        } else {
            // (with nothing to reconfigure the IME is only asked for again: it may have been closed by a hardware keyboard;
            // a composition in the old field ends, as a reconfigure ends it)
            if (!reconfigure) view.abandonComposition()
            view.textChanged()
            view.openKeyboard(reconfigure)
        }
    }

    fun update(prompt: String?, text: String?, chips: List<Chip>? = null, rules: Rules? = null, cancellable: Boolean? = null) {
        if (!requested) return
        if (prompt != null) {
            this.prompt = prompt.ifEmpty { defaultPrompt(kind) }
            surface?.setPrompt(this.prompt)
        }
        if (rules != null) this.rules = rules
        if (chips != null) {
            this.chips = chips
            surface?.setChips(chips)
        }
        if (cancellable != null) {
            this.cancellable = cancellable
            surface?.setCancellable(cancellable)
        }
        if (text == null) return
        hostText = text
        if (text == displayText || scheduler.now() >= echoDeadline) {
            if (displayText != text) {
                displayText = text
                surface?.textChanged()
            }
            surface?.setText(text)
        }
        // Otherwise a keystroke newer than this poll is on screen; reconcile() settles it.
    }

    /** `userInitiated`: the player closed it (the IME's Back or hide key, Back with only the bar) — `dismissed()`. */
    fun hide(userInitiated: Boolean) {
        if (!requested) return
        endRequest()
        Log.info("kbd", if (userInitiated) "dismissed by the player" else "hide")
        if (userInitiated) page.call("keyboard.dismissed")
    }

    /** The bar's Cancel: hides the keyboard and cancels the prompt (`keyboard.cancel()`). */
    fun cancel() {
        if (!requested) return
        onActivity?.invoke()
        endRequest()
        Log.info("kbd", "cancelled by the player")
        page.call("keyboard.cancel") { outcome ->
            // A page without cancel() still has to forget its keyboard, as for the hide button.
            if (outcome == PageBridge.Outcome.Missing) page.call("keyboard.dismissed")
        }
    }

    private fun endRequest() {
        requested = false
        rules = Rules()
        reconcileTask?.cancel()
        surface?.closeKeyboard()
    }

    /** The page went away (reload, renderer crash, fatal error): forget its keyboard state. */
    fun reset() {
        releaseHeldKeys()
        reconcileTask?.cancel()
        hostText = ""
        displayText = ""
        rules = Rules()
        coveredHeight = 0 // what a new page assumes
        if (requested) {
            requested = false
            surface?.closeKeyboard()
            Log.info("kbd", "reset")
        }
    }

    // ------------------------------------------------------------------------------------------------ typing

    /** Typing on the software keyboard or the bar (and a hardware keyboard's characters). */
    fun activity() {
        onActivity?.invoke()
    }

    /**
     * Characters from the IME or a hardware keyboard. Return arrives as "\n"; an IME or a hardware paste may deliver
     * several characters, line breaks included, in one call.
     */
    fun insertText(text: String) {
        onActivity?.invoke()
        val run = StringBuilder()
        for (character in graphemes(RSTheme.gameText(text))) {
            if (isNewline(character)) {
                if (run.isNotEmpty()) send(run.toString())
                run.setLength(0)
                submit("return")
            } else {
                run.append(character)
            }
        }
        if (run.isNotEmpty()) send(run.toString())
    }

    fun deleteBackward() {
        onActivity?.invoke()
        echo { dropLastGrapheme(it) }
        Log.debug("kbd") { "deleteBackward" }
        page.call("keyboard.deleteBackward")
    }

    /**
     * Sends what the input takes. The room left is counted from the bar's text: the page's last report plus the keys sent
     * since (the page has them queued already). `dropped`: the text has lost characters already (the end of a long
     * paste), which are refused as well.
     */
    private fun send(text: String, dropped: Boolean = false) {
        val (accepted, rejected) = rules.filter(text, displayText)
        if (rejected || dropped) refused()
        if (accepted.isEmpty()) return
        echo { it + accepted }
        Log.debug("kbd") { "insertText (${graphemeCount(accepted)} chars)" }
        page.call("keyboard.insertText", listOf(JsonPrimitive(accepted)))
    }

    /**
     * A composing IME's edit (GameInputConnection): `deletes` Backspaces, then `text`, already filtered against the line
     * as it was when the composition began, through the same echo as typing.
     */
    fun replaceTail(deletes: Int, text: String) {
        onActivity?.invoke()
        repeat(deletes) {
            echo { dropLastGrapheme(it) }
            page.call("keyboard.deleteBackward")
        }
        if (text.isEmpty()) return
        echo { it + text }
        Log.debug("kbd") { "insertText (${graphemeCount(text)} chars, composing)" }
        page.call("keyboard.insertText", listOf(JsonPrimitive(text)))
    }

    /**
     * The bar's Send: Return, only while the keyboard is requested. After a hide the bar rides down with the IME for a
     * moment, and a tap on it then must not submit the line (iOS's accessory bar takes no touch while it animates out).
     */
    fun barSubmit() {
        if (!requested) return
        submit("bar")
    }

    /** Return (the IME's action key, its Enter, the bar's button). */
    fun submit(source: String) {
        onActivity?.invoke()
        Log.debug("kbd") { "submit ($source)" }
        lineCommitted()
        page.call("keyboard.submit")
    }

    /**
     * Return (the keyboard's, the bar's button or a hardware Enter) commits the line. The chat line stays open and Return
     * empties it, so the bar empties at once: the next message's first letters then count from an empty line instead of
     * the sent one, which the page reports gone only on its next poll (if Return did nothing, reconcile() brings the line
     * back). What the other inputs do with the line (log in, close the prompt) is up to the page, so its next update wins
     * at once. (A pending reconcile stays scheduled in case no update comes.)
     */
    private fun lineCommitted() {
        surface?.abandonComposition()
        if (kind == "chat") {
            echo { "" }
        } else {
            echoDeadline = 0
        }
    }

    /** A character the input does not take: the warning haptic (at most every 0.3 s, e.g. for a held key) and a flash. */
    fun refused() {
        rejections += 1
        val now = scheduler.now()
        if (now - lastRejection <= REJECTION_EVERY_MS) return
        lastRejection = now
        Log.debug("kbd") { "refused characters (charset ${rules.charset.id}, max ${rules.maxLength ?: "-"})" }
        onHaptic?.invoke("warning")
        if (requested) surface?.flashRejected()
    }

    /**
     * A chip replaces the line with its text: Backspace for the line's current length (extra ones do nothing), the text
     * through the same filter as typing, then Return if it says so.
     */
    fun apply(chip: Chip) {
        if (!requested) return
        onActivity?.invoke()
        Log.debug("kbd") { "chip ${chip.label}" }
        surface?.abandonComposition()
        val deletes = max(graphemeCount(displayText), graphemeCount(hostText))
        if (deletes > 0) {
            echo { "" }
            repeat(deletes) { page.call("keyboard.deleteBackward") }
        }
        insertText(chip.text)
        if (chip.submit) submit("chip")
    }

    /**
     * Pasted text is one line: its line breaks become spaces rather than submitting it. It is cut to the longest input
     * the game has, so a large clipboard cannot flood the page's key queue (what is cut off is refused like any character
     * that does not fit). With no input requested, the paste (Ctrl+V on a hardware keyboard in game) types into the chat
     * line, so it takes what chat takes, counted from an empty line: native does not see that line.
     */
    fun pasteText(string: String) {
        onActivity?.invoke()
        val joined = pasteLine(string)
        val all = graphemes(joined)
        var line = all.take(LONGEST_INPUT).joinToString("")
        var dropped = all.size > LONGEST_INPUT
        if (!requested) {
            val chat = Rules(Charset.CHAT, LONGEST_INPUT).filter(line, "")
            line = chat.accepted
            dropped = dropped || chat.rejected
        }
        Log.debug("kbd") { "paste (${graphemeCount(line)} of ${all.size} chars)" }
        send(line, dropped)
    }

    // ------------------------------------------------------------------------------------------------ optimistic echo

    private fun echo(edit: (String) -> String) {
        if (!requested) return
        displayText = edit(displayText)
        surface?.setText(displayText)
        surface?.textChanged()
        echoDeadline = scheduler.now() + ECHO_GRACE_MS
        reconcileTask?.cancel()
        reconcileTask = scheduler.postDelayed(ECHO_GRACE_MS + 50) { reconcile() }
    }

    private fun reconcile() {
        if (!requested || displayText == hostText) return
        displayText = hostText
        surface?.setText(hostText)
        surface?.textChanged()
    }

    // ------------------------------------------------------------------------------------------------ hardware keys

    /** A named key went down (KeyboardBridgeView: system repeats are dropped there; ours below are iOS's). */
    fun keyDown(code: Int, name: String) {
        if (heldKeys.containsKey(code)) return
        heldKeys[code] = name
        sendKeyDown(name)
        if (name in REPEATING_KEYS) startRepeating(code, name)
    }

    /** A hardware key-down or auto-repeat. Keeps the bar in step the way the IME's deleteBackward/submit do. */
    private fun sendKeyDown(name: String) {
        when (name) {
            "Backspace", "Delete" -> {
                surface?.abandonComposition()
                echo { dropLastGrapheme(it) }
            }
            "Enter" -> lineCommitted()
        }
        pressKey(name, true)
    }

    fun keyUp(code: Int) {
        val name = heldKeys.remove(code) ?: return
        if (repeatingKey == code) stopRepeating()
        pressKey(name, false)
    }

    /** Key-up for every key still down (focus loss, pause, page reload), so the game is never left with a stuck arrow key. */
    fun releaseHeldKeys() {
        stopRepeating()
        for (name in heldKeys.values) pressKey(name, false)
        heldKeys.clear()
    }

    private fun pressKey(name: String, down: Boolean) {
        Log.debug("kbd") { "pressKey $name ${if (down) "down" else "up"}" }
        page.call("keyboard.pressKey", listOf(JsonPrimitive(name), JsonPrimitive(down)))
    }

    /** Held Backspace repeats as a browser's keydown does (the game deletes one character per Backspace keydown). */
    private fun startRepeating(code: Int, name: String) {
        stopRepeating()
        repeatingKey = code
        fun schedule(delay: Long) {
            repeatTask = scheduler.postDelayed(delay) {
                if (repeatingKey != code) return@postDelayed
                sendKeyDown(name)
                schedule(REPEAT_EVERY_MS)
            }
        }
        schedule(REPEAT_AFTER_MS)
    }

    private fun stopRepeating() {
        repeatTask?.cancel()
        repeatTask = null
        repeatingKey = null
    }

    val heldKeyNames: List<String> get() = heldKeys.values.sorted()

    // ------------------------------------------------------------------------------------------------ covered height

    /** What the keyboard covers with an IME of `imeDp`: the IME and the bar while requested (the bar alone without one). */
    fun coveredFor(imeDp: Float): Int = if (requested && !lent) (imeDp + BAR_HEIGHT_DP).roundToInt() else 0

    /** An IME animation begins (KeyboardInsets.onStart: will show / will hide, with its end state and duration). */
    fun imeAnimationStarted(fromDp: Float, toDp: Float, seconds: Double) {
        Log.info("kbd", "ime will ${if (toDp > 0f) "show" else "hide"} ${toDp.roundToInt()} dp (${format(seconds)} s) requested=$requested")
        imeTarget = toDp
        if (fromDp > 0f && toDp <= 0f) imeClosing()
        reportFromIme(coveredFor(toDp), seconds)
    }

    /** The animation ended (did show / did hide). */
    fun imeAnimationEnded(imeDp: Float) {
        val was = imeHeight
        imeHeight = imeDp
        imeTarget = imeDp
        if ((was > 0f) != (imeDp > 0f) || Log.verbose) {
            Log.info("kbd", "ime did ${if (imeDp > 0f) "show" else "hide"} ${imeDp.roundToInt()} dp requested=$requested")
        }
        reportFromIme(coveredFor(imeDp), 0.0)
    }

    /**
     * The IME's inset changed without an animation (an IME that does not animate, a hardware keyboard toggling, or an IME
     * that resizes itself: Gboard comes up 24 px taller now and then, at its first show after a launch or on the way back
     * into the app, and settles 9 dp lower a moment later). A resize of an IME that stays up is reported at once: the IME
     * and the bar are already there, so the page moves with them rather than gliding after them with the hide rule's
     * duration.
     */
    fun imeSettled(imeDp: Float) {
        val was = imeHeight
        imeHeight = imeDp
        imeTarget = imeDp
        if (was > 0f && imeDp <= 0f) imeClosing()
        if ((was > 0f) != (imeDp > 0f)) {
            Log.info("kbd", "ime ${if (imeDp > 0f) "shown" else "hidden"} ${imeDp.roundToInt()} dp (no animation) requested=$requested")
        } else if (was > 0f && was != imeDp) {
            Log.info("kbd", "ime resized ${was.roundToInt()} → ${imeDp.roundToInt()} dp (no animation)")
        }
        reportFromIme(coveredFor(imeDp), 0.0, resize = was > 0f && imeDp > 0f)
    }

    /**
     * What the IME does while the app is not in front (leaving, coming back: the system hides it and shows it again) is
     * not passed on while the keyboard is requested: the page would see its chatbox drop and jump back. The IME is asked
     * for again when the app is back (activate), and openKeyboard's settle reports what is there then.
     */
    private fun reportFromIme(height: Int, seconds: Double, resize: Boolean = false) {
        if (requested && !(resumed && windowFocused)) return
        // (likewise when a rotation, a focus change or the way back into the app takes the IME away: it comes straight
        // back, or is asked for; what is there once that is over is reported then)
        val grace = graceLeft()
        if (requested && height < coveredHeight && grace > 0) {
            settleLater(grace)
            return
        }
        reportCovered(height, seconds, immediate = resize)
    }

    /** How long the system may still be moving the IME about on its own: after a rotation, a focus change, a return. */
    private fun graceLeft(): Long = maxOf(
        lastRotation + SYSTEM_CHANGE_GRACE_MS,
        lastWindowFocusChange + SYSTEM_CHANGE_GRACE_MS,
        frontSince + RETURN_GRACE_MS,
    ) - scheduler.now()

    /**
     * How long a keyboard request waits for the IME's animation before the bar alone covers the page (KeyboardBridgeView's
     * settle check). With a hardware keyboard the IME may never come (Android's "Show on-screen keyboard" off), so not
     * long; without one the IME is the only way to type and is coming, however slowly it starts (Gboard's first show after
     * a launch can take more than 300 ms): waiting for it spares the page a step to the bar's 52 dp before the IME's
     * height.
     */
    fun settleDelayMs(): Long = if (hardKeyboardHidden == HARD_KEYBOARD_PRESENT) SETTLE_HARD_KEYBOARD_MS else SETTLE_IME_MS

    /**
     * The bar alone covers the page (the IME did not come: a hardware keyboard), or a request settles without an IME. With
     * the keyboard requested, a lower height is only reported once it is still so a moment later (and the system is done
     * moving the IME about): coming back to the app, the system hides the IME for up to a second before it shows again,
     * and the page's chatbox must not drop meanwhile.
     */
    fun settle() {
        val height = coveredFor(imeTarget)
        if (requested && height < coveredHeight) {
            settleLater(maxOf(SETTLE_AGAIN_MS, graceLeft()))
            return
        }
        settleAgain?.cancel()
        settleAgain = null
        reportCovered(height, 0.0)
    }

    private var settleAgain: Cancellable? = null

    /** Reports what the keyboard covers after `delayMs` (unless the system is still moving the IME about then). */
    private fun settleLater(delayMs: Long) {
        settleAgain?.cancel()
        settleAgain = scheduler.postDelayed(delayMs) {
            settleAgain = null
            val height = coveredFor(imeTarget)
            val grace = graceLeft()
            when {
                height == coveredHeight -> {}
                requested && height < coveredHeight && grace > 0 -> settleLater(grace)
                else -> reportCovered(height, 0.0)
            }
        }
    }

    /**
     * The IME is going away while the keyboard is requested and we did not hide it: the player closed it (Back, its own
     * hide key, a swipe down on Gboard), which iOS can only do with the bar's hide button, reported as `dismissed()`.
     * Not when it goes because the app left the front or the window lost focus (it comes back with [activate]), or
     * because a hardware keyboard was attached (the bar stays, as on iOS).
     */
    private fun imeClosing() {
        if (!requested || lent) return
        val now = scheduler.now()
        when {
            !resumed || !windowFocused -> Log.info("kbd", "ime hidden with the app not in front: keyboard kept")
            now - lastHardKeyboardChange < SYSTEM_CHANGE_GRACE_MS -> Log.info("kbd", "ime hidden by a hardware keyboard: keyboard kept")
            now - lastWindowFocusChange < SYSTEM_CHANGE_GRACE_MS -> {
                Log.info("kbd", "ime hidden by a focus change: keyboard kept")
                askAgainLater()
            }
            now - lastRotation < SYSTEM_CHANGE_GRACE_MS -> {
                Log.info("kbd", "ime hidden by a rotation: keyboard kept")
                askAgainLater()
            }
            else -> hide(userInitiated = true)
        }
    }

    /** The system hid the IME (a rotation, a focus change): unless it comes back by itself, ask for it again. */
    private fun askAgainLater() {
        reask?.cancel()
        reask = scheduler.postDelayed(REASK_MS) {
            if (requested && !lent && resumed && windowFocused && imeTarget <= 0f) surface?.openKeyboard(reconfigure = false)
        }
    }

    /** The display turned (180° in landscape: no configuration change, but the IME goes away and comes back). */
    fun displayRotated() {
        lastRotation = scheduler.now()
        Log.info("kbd", "display rotated${if (requested) " with the keyboard up" else ""}")
    }

    /**
     * `LostCityHost.keyboard.frame(dp, seconds, curve)` when the covered height changes. A keyboard going down with no
     * duration of its own reports the duration it came up with, so the page moves along with it (iOS's rule); not an
     * `immediate` change (an IME that resized itself without an animation, already in place).
     */
    fun reportCovered(height: Int, duration: Double, immediate: Boolean = false) {
        if (duration > 0) keyboardAnimation = duration
        if (height == coveredHeight) return
        val seconds = if (immediate || duration > 0 || height > coveredHeight) duration else keyboardAnimation
        coveredHeight = height
        Log.info("kbd", "covers $height dp of the page (${format(seconds)} s)")
        page.call("keyboard.frame", listOf(JsonPrimitive(height.toDouble()), JsonPrimitive(seconds), JsonPrimitive(IME_CURVE))) { outcome ->
            Log.debug("kbd") { "keyboard.frame → ${outcome.description}" }
        }
    }

    // ------------------------------------------------------------------------------------------------ SessionComponent

    override fun pageReset() = reset()

    override fun pageReady() = activate()

    override fun fatal() = hide(userInitiated = false)

    override fun resume() {
        if (!resumed && windowFocused) frontSince = scheduler.now()
        resumed = true
        activate()
    }

    override fun pause() {
        resumed = false
        releaseHeldKeys()
    }

    /** A (new) activity: its focus-holding view, the bar and the IME insets go into its root, above the WebView. */
    override fun attach(activity: GameActivity, root: FrameLayout) {
        hardKeyboardHidden = activity.resources.configuration.hardKeyboardHidden
        val view = KeyboardBridgeView(activity, this)
        view.attachTo(root)
        attachSurface(view)
    }

    override fun detach(activity: GameActivity) {
        val view = surface as? KeyboardBridgeView ?: return
        releaseHeldKeys()
        view.detachFromRoot()
        detachSurface(view)
    }

    override fun configurationChanged(configuration: Configuration) = hardKeyboardChanged(configuration.hardKeyboardHidden)

    override fun windowFocusChanged(hasFocus: Boolean) {
        if (hasFocus && !windowFocused && resumed) frontSince = scheduler.now()
        windowFocused = hasFocus
        lastWindowFocusChange = scheduler.now()
        if (hasFocus) activate() else releaseHeldKeys()
    }

    /** Remembers when a hardware keyboard came or went (the IME hides or shows then; that is no user dismissal). */
    fun hardKeyboardChanged(hidden: Int) {
        val previous = hardKeyboardHidden
        hardKeyboardHidden = hidden
        if (previous == null || previous == hidden) return
        lastHardKeyboardChange = scheduler.now()
        Log.info("kbd", "hardware keyboard ${if (hidden == HARD_KEYBOARD_PRESENT) "attached" else "detached"}")
        if (requested && !lent) surface?.openKeyboard(reconfigure = false)
    }

    // ------------------------------------------------------------------------------------------------ debug hooks

    /** Feeds characters through the IME entry points exactly as the software keyboard does; `\u0008` is Backspace. */
    fun debugType(text: String) {
        for (character in graphemes(text)) {
            if (character == "\u0008") deleteBackward() else insertText(character)
        }
    }

    /** Runs the hardware-key path: the view's dispatchKeyEvent with a synthetic hardware KeyEvent, else by name here. */
    fun debugHardwareKey(name: String, down: Boolean) {
        if (surface?.debugHardwareKey(name, down) == true) return
        val code = GAME_KEYS.entries.firstOrNull { it.value == name }?.key
        if (code == null) {
            Log.info("kbd", "debug: no hardware key named $name")
            return
        }
        if (down) keyDown(code, name) else keyUp(code)
    }

    /** `hide`, `cancel` or `submit`, as the bar's buttons do. */
    fun debugTapBar(button: String) {
        when (button) {
            "hide" -> hide(userInitiated = true)
            "cancel" -> cancel()
            else -> barSubmit()
        }
    }

    /** Taps the chip on show at `index`; returns its label, or null if there is none. */
    fun debugTapChip(index: Int): String? {
        val shown = surface?.visibleChips ?: visibleChips(chips, displayText)
        val chip = shown.getOrNull(index) ?: return null
        apply(chip)
        return chip.label
    }

    fun debugState(): JsonObject = buildJsonObject {
        put("isFirstResponder", JsonPrimitive(surface?.holdsFocus == true))
        put("requested", JsonPrimitive(requested))
        put("kind", JsonPrimitive(kind))
        put("secure", JsonPrimitive(secure))
        put("numeric", JsonPrimitive(numeric))
        put("keyboardType", JsonPrimitive(inputType))
        put("returnKeyType", JsonPrimitive(imeAction))
        put("isSecureTextEntry", JsonPrimitive(false))
        put("displayText", JsonPrimitive(displayText))
        put("softwareKeyboardVisible", JsonPrimitive(softwareKeyboardVisible))
        put("inputView", JsonPrimitive(if (requested && !lent) "system keyboard" else "none (hardware only)"))
        put("heldKeys", JsonArray(heldKeyNames.map(::JsonPrimitive)))
        put("cancellable", JsonPrimitive(cancellable))
        put("cancelShown", JsonPrimitive(false))
        put("submitTitle", JsonPrimitive(submitTitle))
        put("charset", JsonPrimitive(rules.charset.id))
        put("maxLength", rules.maxLength?.let(::JsonPrimitive) ?: JsonNull)
        put("chips", JsonArray(visibleChips(chips, displayText).map { JsonPrimitive(it.label) }))
        put("coveredHeight", JsonPrimitive(coveredHeight.toDouble()))
        put("rejections", JsonPrimitive(rejections))
        put("flashing", JsonPrimitive(false))
        put("canPaste", JsonPrimitive(false))
        put("imeVisible", JsonPrimitive(softwareKeyboardVisible))
        put("imeHeight", JsonPrimitive(imeHeight.toDouble()))
        put("lent", JsonPrimitive(lent))
        put("prompt", JsonPrimitive(prompt))
        // the activity's views overwrite the bar's own fields (displayText, chips, cancelShown, flashing, canPaste, …)
        surface?.debugState()?.forEach { (key, value) -> put(key, value) }
    }

    companion object {
        /** The bar's height (dp): it covers the page above the IME (KeyboardAccessoryBar.HEIGHT_DP). */
        const val BAR_HEIGHT_DP = 52

        /** The page polls the game and reports changes; until a poll catches up with a keystroke the bar shows the
         *  keystroke optimistically. After this long the page's text wins. */
        const val ECHO_GRACE_MS = 500L
        const val REJECTION_EVERY_MS = 300L
        const val REPEAT_AFTER_MS = 400L
        const val REPEAT_EVERY_MS = 50L

        /** An IME going away within this long of a hardware keyboard, rotation or window focus change is the system's doing. */
        const val SYSTEM_CHANGE_GRACE_MS = 500L

        /** How long the IME has to come back by itself after the system hid it before it is asked for again. */
        const val REASK_MS = 400L

        /** A lower covered height found by settle() is reported if it is still so this much later. */
        const val SETTLE_AGAIN_MS = 300L

        /** A request settles without an IME animation after this long with a hardware keyboard (settleDelayMs)… */
        const val SETTLE_HARD_KEYBOARD_MS = 300L

        /** …and after this long without one (the IME is coming). */
        const val SETTLE_IME_MS = 1_500L

        /** Coming back into the app, the system may hide and show the IME for this long: a lower height waits it out. */
        const val RETURN_GRACE_MS = 1_500L

        /** The longest input the game has: the chat line and private messages (names take 12, amounts 10, the password 20). */
        const val LONGEST_INPUT = 80

        /** Android's IME animation curve (WindowInsetsAnimation's for the IME), sent with every keyboard.frame. */
        const val IME_CURVE = "cubic-bezier(0.2, 0, 0, 1)"

        /**
         * Text: no suggestions, autocorrect, auto-capitalisation or composing on Gboard, Samsung Keyboard and SwiftKey
         * (VISIBLE_PASSWORD is the one variation they all honour; NO_SUGGESTIONS alone Samsung ignores). Never the
         * PASSWORD variation (iOS never sets isSecureTextEntry): that brings Autofill and the password managers.
         */
        const val TEXT_INPUT_TYPE = android.text.InputType.TYPE_CLASS_TEXT or
            android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        const val NUMBER_INPUT_TYPE = android.text.InputType.TYPE_CLASS_NUMBER
        const val IME_ACTION_SEND = android.view.inputmethod.EditorInfo.IME_ACTION_SEND
        const val IME_ACTION_GO = android.view.inputmethod.EditorInfo.IME_ACTION_GO
        const val IME_ACTION_DONE = android.view.inputmethod.EditorInfo.IME_ACTION_DONE

        /** Configuration.HARDKEYBOARDHIDDEN_NO: a hardware keyboard is there. */
        const val HARD_KEYBOARD_PRESENT = android.content.res.Configuration.HARDKEYBOARDHIDDEN_NO

        /** `KeyboardEvent.key` names (webclient KeyCodes.ts) for the keys that are not text, by Android keycode. */
        val GAME_KEYS: Map<Int, String> = buildMap {
            put(android.view.KeyEvent.KEYCODE_DPAD_LEFT, "ArrowLeft")
            put(android.view.KeyEvent.KEYCODE_DPAD_RIGHT, "ArrowRight")
            put(android.view.KeyEvent.KEYCODE_DPAD_UP, "ArrowUp")
            put(android.view.KeyEvent.KEYCODE_DPAD_DOWN, "ArrowDown")
            put(android.view.KeyEvent.KEYCODE_ESCAPE, "Escape")
            put(android.view.KeyEvent.KEYCODE_TAB, "Tab")
            put(android.view.KeyEvent.KEYCODE_ENTER, "Enter")
            put(android.view.KeyEvent.KEYCODE_NUMPAD_ENTER, "Enter")
            put(android.view.KeyEvent.KEYCODE_DEL, "Backspace")
            put(android.view.KeyEvent.KEYCODE_FORWARD_DEL, "Delete")
            put(android.view.KeyEvent.KEYCODE_MOVE_HOME, "Home")
            put(android.view.KeyEvent.KEYCODE_MOVE_END, "End")
            put(android.view.KeyEvent.KEYCODE_PAGE_UP, "PageUp")
            put(android.view.KeyEvent.KEYCODE_PAGE_DOWN, "PageDown")
            put(android.view.KeyEvent.KEYCODE_INSERT, "Insert")
            put(android.view.KeyEvent.KEYCODE_CTRL_LEFT, "Control")
            put(android.view.KeyEvent.KEYCODE_CTRL_RIGHT, "Control")
            for (i in 0 until 12) put(android.view.KeyEvent.KEYCODE_F1 + i, "F${i + 1}")
        }

        /** Modifiers go on to the framework too (it tracks the meta state). */
        val MODIFIER_KEYS = setOf("Control")
        val REPEATING_KEYS = setOf("Backspace", "Delete")

        fun imeAction(kind: String): Int = when (kind) {
            "chat", "social" -> IME_ACTION_SEND
            "login-user", "login-pass" -> IME_ACTION_GO // the same on both fields: switching them restarts nothing
            else -> IME_ACTION_DONE
        }

        fun submitTitle(kind: String): String = when (kind) {
            "chat", "social" -> "Send"
            "login-user", "login-pass" -> "Log in"
            else -> "OK"
        }

        fun defaultPrompt(kind: String): String = when (kind) {
            "chat" -> "Chat"
            "login-user" -> "Username"
            "login-pass" -> "Password"
            "dialog" -> "Enter amount"
            "report" -> "Player name"
            else -> ""
        }

        /** `maxLength` / `charset` of a show or update message; null when it has neither. */
        fun rules(message: JsonObject): Rules? {
            val maxLength = message.long("maxLength")
            val charset = message.string("charset")
            if (maxLength == null && charset == null) return null
            if (charset != null && Charset.of(charset) == null) Log.info("kbd", "unknown charset '$charset': not filtering")
            return Rules(
                charset = charset?.let(Charset::of) ?: Charset.ANY,
                maxLength = maxLength?.takeIf { it > 0 }?.coerceAtMost(Int.MAX_VALUE.toLong())?.toInt(),
            )
        }

        /** `chips: [{label, text, submit?, whenEmpty?}]`; null when the message has none (an update keeps the current ones). */
        fun chips(value: JsonElement?): List<Chip>? {
            if (value == null || value is JsonNull) return null
            val list = value as? JsonArray ?: return emptyList()
            // (as Swift's `as? [[String: Any]]`: one entry that is not an object and the list is not a list of chips)
            if (list.any { it !is JsonObject }) return emptyList()
            return list.take(24).mapNotNull { element ->
                val item = element as JsonObject
                val text = item.string("text")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                val label = item.string("label")?.takeIf { it.isNotEmpty() } ?: text
                Chip(label, text, submit = item.bool("submit") ?: false, whenEmpty = item.bool("whenEmpty") ?: false)
            }
        }

        /** The chips the bar shows for a line: `whenEmpty` ones only while it is empty. */
        fun visibleChips(chips: List<Chip>, text: String): List<Chip> = chips.filter { !it.whenEmpty || text.isEmpty() }

        /** Pasted text as one line: quotes, dashes and the ellipsis as ASCII, line breaks (runs of them) as one space. */
        fun pasteLine(string: String): String =
            splitLines(RSTheme.gameText(string)).joinToString(" ")

        /** Swift's `split(whereSeparator: \.isNewline)`: the pieces between line breaks, empty ones left out. */
        private fun splitLines(text: String): List<String> {
            val pieces = ArrayList<String>()
            val piece = StringBuilder()
            for (character in graphemes(text)) {
                if (isNewline(character)) {
                    if (piece.isNotEmpty()) pieces.add(piece.toString())
                    piece.setLength(0)
                } else {
                    piece.append(character)
                }
            }
            if (piece.isNotEmpty()) pieces.add(piece.toString())
            return pieces
        }

        /** A line break anywhere in `text` (Swift's Character.isNewline; either half of "\r\n" is one). */
        fun hasNewline(text: String): Boolean = text.any { isNewline(it.toString()) }

        /**
         * An IME's commit that is a paste (Gboard's clipboard chip) rather than typing: several characters with a line
         * break among them, any of Swift's (\n, \r, \r\n, VT, FF, NEL, U+2028, U+2029). A lone line break ("\n", "\r\n")
         * is Return.
         */
        fun isPaste(text: String): Boolean = hasNewline(text) && graphemeCount(text) > 1

        /** Swift's Character.isNewline (one grapheme: "\r\n" is one). */
        fun isNewline(character: String): Boolean = character == "\r\n" ||
            (character.length == 1 && character[0] in "\n\r\u000B\u000C\u0085  ")

        /** The grapheme clusters of `text` (Swift's Characters). */
        fun graphemes(text: String): List<String> {
            if (text.isEmpty()) return emptyList()
            // (plain ASCII is one character per char: the common case needs no BreakIterator; "\r\n" is one)
            if (text.all { it.code in 0..127 } && !text.contains("\r\n")) return text.map { it.toString() }
            val iterator = BreakIterator.getCharacterInstance(Locale.ROOT)
            iterator.setText(text)
            val result = ArrayList<String>()
            var start = iterator.first()
            var end = iterator.next()
            while (end != BreakIterator.DONE) {
                result.add(text.substring(start, end))
                start = end
                end = iterator.next()
            }
            return result
        }

        fun graphemeCount(text: String): Int = if (text.all { it.code in 0..127 } && !text.contains("\r\n")) text.length else graphemes(text).size

        fun dropLastGrapheme(text: String): String {
            if (text.isEmpty()) return text
            val all = graphemes(text)
            return all.dropLast(1).joinToString("")
        }

        private fun format(seconds: Double) = String.format(Locale.ROOT, "%.2f", seconds)

        /**
         * Registers the keyboard in the session (GameSession's init): the page's `keyboard` messages, the focus seam for
         * native text fields (session.keyboardFocus), its debug actions (iOS's `type`, `key`, `bar`, `chip`, `paste`,
         * `keyboard-state`), and the per-activity views through SessionComponent.attach.
         */
        fun install(session: GameSession): KeyboardBridge {
            val bridge = KeyboardBridge(session.page, MainScheduler)
            bridge.onActivity = session::userActivity
            bridge.onHaptic = session::playHaptic
            session.handle("keyboard", bridge::handle)
            session.keyboardFocus = bridge
            session.components += bridge
            if (BuildConfig.DEBUG) {
                session.debugAction("type") { message, reply ->
                    bridge.debugType(message.string("text") ?: "")
                    reply(JsonNull)
                }
                session.debugAction("key") { message, reply ->
                    bridge.debugHardwareKey(message.string("key") ?: "", message.bool("down") ?: true)
                    reply(JsonNull)
                }
                session.debugAction("bar") { message, reply ->
                    bridge.debugTapBar(message.string("button") ?: "submit")
                    reply(JsonNull)
                }
                session.debugAction("chip") { message, reply ->
                    reply(bridge.debugTapChip(message.long("index")?.toInt() ?: 0)?.let(::JsonPrimitive) ?: JsonNull)
                }
                session.debugAction("paste") { message, reply ->
                    bridge.pasteText(message.string("text") ?: "")
                    reply(JsonNull)
                }
                session.debugAction("keyboard-state") { _, reply -> reply(bridge.debugState()) }
                // Android's own: lend input focus for `ms` as a native text field would (KeyboardFocus), run IME calls on
                // the live InputConnection (composing, pastes), and put text on the clipboard for a Ctrl+V test (a shell
                // cannot)
                session.debugAction("kbd-lend") { message, reply ->
                    val handle = bridge.lend()
                    MainScheduler.postDelayed(message.long("ms") ?: 1000L) { handle.close() }
                    reply(JsonNull)
                }
                session.debugAction("kbd-ime") { message, reply ->
                    val view = bridge.surface as? KeyboardBridgeView
                    reply(view?.debugIme(message["ops"] as? JsonArray ?: JsonArray(emptyList())) ?: JsonNull)
                }
                session.debugAction("clipboard") { message, reply ->
                    val context = session.activity
                    val clipboard = context?.getSystemService(android.content.ClipboardManager::class.java)
                    clipboard?.setPrimaryClip(android.content.ClipData.newPlainText("test", message.string("text") ?: ""))
                    reply(JsonPrimitive(clipboard != null))
                }
            }
            return bridge
        }
    }
}

/**
 * The focus-lending seam (docs/ANDROID.md §4.1): a native text field that needs the IME (the bot chat track's Claude key
 * dialog) takes input focus from the keyboard bridge, which otherwise never gives it up, and the bridge takes it back
 * when the handle is closed (iOS: yieldFirstResponder(true), then yieldFirstResponder(false) and activate()). Lends
 * nest; closing a handle twice does nothing.
 */
fun interface KeyboardFocus {
    fun lend(): AutoCloseable
}
