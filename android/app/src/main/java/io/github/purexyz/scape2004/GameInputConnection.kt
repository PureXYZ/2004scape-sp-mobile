// GameInputConnection: the IME's side of the keyboard bridge (the UIKeyInput half of ios/LostCity/KeyboardBridge.swift:
// insertText, deleteBackward and Return).
//
// The game owns the text: every edit the IME makes becomes keyboard.insertText / deleteBackward / submit through
// KeyboardBridge (its input rules, echo and refusals). The IME still needs an editor to look at, so the connection keeps
// an editable that mirrors what the bar shows (KeyboardBridge.displayText, cursor always at the end): Backspace then
// always has something to delete, the IME's idea of the field matches the bar, and a composing keyboard can be followed.
//
// * commitText: characters (any number of them; "\n" submits, as Return on iOS). A commit of several characters with a
//   line break in it (any kind: \r\n, U+2028, NEL…) is a paste (Gboard's clipboard chip): one line, through
//   KeyboardBridge.pasteText, never one submit per line.
// * setComposingText (voice input, an IME that composes despite the flags, CJK): the composition is sent as it goes, by
//   difference with what was sent for it: Backspaces for what changed, then the new characters, filtered against the
//   line as it was when the composition began. finishComposingText keeps it; a commit replaces it. A change to the line
//   from outside the IME (the bar's Send, a chip, a hardware Enter or Backspace, another field) ends it and restarts the
//   editor (KeyboardBridgeView.abandonComposition), so the IME's next edit starts afresh on the new line.
// * deleteSurroundingText(before, after): `before` Backspaces, even past the mirror's start (the game's line may be
//   longer than the bar knows); the cursor is always at the end, so `after` is nothing.
// * sendKeyEvent (IMEs send Backspace and Enter as key events): DEL → deleteBackward, ENTER → submit, a character key →
//   insertText; nothing else (an IME's cursor keys) reaches the game.
// * performEditorAction (Send, Go, Done; the number pad's action key) → submit.
// * Stickers and GIFs (commitContent), private commands, cursor anchors, corrections and completions are refused, and a
//   selection snaps back to the end.
package io.github.purexyz.scape2004

import android.os.Bundle
import android.text.Editable
import android.text.Selection
import android.text.SpannableStringBuilder
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.CompletionInfo
import android.view.inputmethod.CorrectionInfo
import android.view.inputmethod.InputContentInfo
import android.view.inputmethod.InputMethodManager

class GameInputConnection(
    private val view: View,
    private val bridge: KeyboardBridge,
    private val imm: InputMethodManager,
) : BaseInputConnection(view, true) {
    private val mirror: Editable = SpannableStringBuilder(bridge.displayText).also { Selection.setSelection(it, it.length) }

    /** While composing: the line as it was when the composition began, and what has been sent for the composition. */
    private var composeBase: String? = null
    private var composeSent = ""

    val isComposing: Boolean get() = composeBase != null
    val editableText: String get() = mirror.toString()

    override fun getEditable(): Editable = mirror

    // ------------------------------------------------------------------------------------------------ text

    override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
        bridge.activity()
        val committed = text?.toString() ?: ""
        val paste = KeyboardBridge.isPaste(committed)
        when {
            // the commit replaces the composition (its text is sent already, as it was composed)
            isComposing && !KeyboardBridge.hasNewline(committed) -> {
                compose(committed)
                endComposition()
            }
            isComposing -> {
                if (paste) compose("") // (the paste takes the composition's place)
                endComposition()
                if (paste) bridge.pasteText(committed) else bridge.insertText(committed)
            }
            paste -> bridge.pasteText(committed)
            committed.isNotEmpty() -> bridge.insertText(committed)
        }
        syncEditable(force = true)
        return true
    }

    override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
        bridge.activity()
        compose(text?.toString() ?: "")
        return true
    }

    /** The IME marks text already in the mirror as the composition (only at the end: the cursor never moves). */
    override fun setComposingRegion(start: Int, end: Int): Boolean {
        val length = mirror.length
        val a = minOf(start, end).coerceIn(0, length)
        val b = maxOf(start, end).coerceIn(0, length)
        if (a == b) {
            endComposition()
            return true
        }
        if (b != length) return true
        composeBase = mirror.substring(0, a)
        composeSent = mirror.substring(a, b)
        super.setComposingRegion(a, b)
        return true
    }

    override fun finishComposingText(): Boolean {
        endComposition()
        syncEditable(force = true)
        return true
    }

    /**
     * Follows a composition: what the IME composes now, filtered against the line before it, replaces what was sent for
     * it, by difference (Backspaces back to the common prefix, then the rest), through the same echo as typing.
     */
    private fun compose(text: String) {
        val base = composeBase ?: bridge.displayText.also {
            composeBase = it
            composeSent = ""
        }
        val composed = RSTheme.gameText(text).filterNot { KeyboardBridge.isNewline(it.toString()) }
        val filtered = bridge.rules.filter(composed, base)
        val sent = KeyboardBridge.graphemes(composeSent)
        val now = KeyboardBridge.graphemes(filtered.accepted)
        var common = 0
        while (common < sent.size && common < now.size && sent[common] == now[common]) common++
        bridge.replaceTail(sent.size - common, now.drop(common).joinToString(""))
        if (filtered.rejected) bridge.refused()
        composeSent = filtered.accepted
        // the mirror: the line with the composition marked at its end, for the IME's sake
        val line = bridge.displayText
        mirror.replace(0, mirror.length, line)
        val start = (line.length - composeSent.length).coerceAtLeast(0)
        super.setComposingRegion(start, line.length)
        Selection.setSelection(mirror, mirror.length)
        imm.updateSelection(view, mirror.length, mirror.length, start, line.length)
    }

    /** The composition ends where it is (nothing more is sent for it). */
    fun endComposition() {
        composeBase = null
        composeSent = ""
        removeComposingSpans(mirror)
    }

    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        bridge.activity()
        endComposition()
        // (the game owns the line: Backspace works past the mirror's start; a few at most, an IME asking for thousands
        // must not flood the page's key queue)
        repeat(beforeLength.coerceIn(0, KeyboardBridge.LONGEST_INPUT)) { bridge.deleteBackward() }
        syncEditable(force = true)
        return true
    }

    override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean =
        deleteSurroundingText(beforeLength, afterLength)

    // ------------------------------------------------------------------------------------------------ keys, actions

    override fun sendKeyEvent(event: KeyEvent): Boolean {
        bridge.activity()
        softKey(event)
        return true
    }

    /** A soft keyboard's key (here, or one that reached the view with FLAG_SOFT_KEYBOARD). */
    fun softKey(event: KeyEvent): Boolean {
        if (isComposing && event.action == KeyEvent.ACTION_DOWN) endComposition()
        val handled = softKeyToBridge(event, bridge)
        syncEditable(force = true)
        return handled
    }

    override fun performEditorAction(editorAction: Int): Boolean {
        bridge.activity()
        endComposition()
        bridge.submit("return")
        syncEditable(force = true)
        return true
    }

    override fun setSelection(start: Int, end: Int): Boolean {
        // the cursor stays at the end (the game's line has no cursor of its own)
        Selection.setSelection(mirror, mirror.length)
        imm.updateSelection(view, mirror.length, mirror.length, composingStart(), composingEnd())
        return true
    }

    override fun commitContent(inputContentInfo: InputContentInfo, flags: Int, opts: Bundle?): Boolean = false

    override fun performPrivateCommand(action: String?, data: Bundle?): Boolean = false

    override fun requestCursorUpdates(cursorUpdateMode: Int): Boolean = false

    override fun commitCorrection(correctionInfo: CorrectionInfo?): Boolean = false

    override fun commitCompletion(text: CompletionInfo?): Boolean = false

    override fun closeConnection() {
        endComposition()
        super.closeConnection()
    }

    private fun composingStart() = getComposingSpanStart(mirror)

    private fun composingEnd() = getComposingSpanEnd(mirror)

    /**
     * The mirror follows the bar's text (after an edit here, a page update or the reconcile), the cursor at the end, and
     * the IME hears where it is. Not while composing: the composition keeps its own mirror.
     */
    fun syncEditable(force: Boolean) {
        if (isComposing) return
        val text = bridge.displayText
        val changed = mirror.toString() != text
        if (changed) mirror.replace(0, mirror.length, text)
        Selection.setSelection(mirror, mirror.length)
        if (changed || force) imm.updateSelection(view, mirror.length, mirror.length, -1, -1)
    }

    companion object {
        /** DEL → Backspace, ENTER → Return, a character key → its character; key-ups and other keys are swallowed. */
        fun softKeyToBridge(event: KeyEvent, bridge: KeyboardBridge): Boolean {
            if (event.action != KeyEvent.ACTION_DOWN) return true
            when (event.keyCode) {
                KeyEvent.KEYCODE_DEL -> bridge.deleteBackward()
                KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> bridge.submit("return")
                else -> {
                    val unicode = event.getUnicodeChar(event.metaState)
                    if (unicode != 0 && unicode and KeyCharacterMap.COMBINING_ACCENT == 0) bridge.insertText(String(Character.toChars(unicode)))
                }
            }
            return true
        }
    }
}
