// KeyboardBridgeView: the view that holds input focus for the game, one per activity (the UIView/UIKeyInput half of
// ios/LostCity/KeyboardBridge.swift: first responder for good, the system keyboard while requested, the hardware keys always;
// docs/ANDROID.md §4.3).
//
// * A 1×1, transparent view that takes focus and keeps it: the WebView is never focusable (GameWebView), so a tap on the
//   game cannot take focus and close the keyboard, and Chromium never shows an IME of its own. It gives focus up only to
//   a native text field that borrows it (KeyboardFocus.lend).
// * Requested: a text editor (onCheckIsTextEditor) whose InputConnection (GameInputConnection) turns the IME's edits
//   into keyboard.insertText / deleteBackward / submit. The editor is plain ASCII text with every IME aid off
//   (VISIBLE_PASSWORD | NO_SUGGESTIONS; a number pad for amounts), never fullscreen or an extract UI in landscape, and
//   its action key is Send, Go or Done by kind. Idle: no editor (no InputConnection), but the focused view still gets
//   every hardware key: the iOS bridge's empty inputView.
// * Hardware keys (dispatchKeyEvent): the named keys (arrows, Escape, Tab, Enter, Backspace, Delete, Home/End, PageUp/
//   PageDown, Insert, Control, F1-F12) go to the page as separate key-down and key-up events (keyboard.pressKey) with
//   iOS's names; the system's own key repeats are dropped and KeyboardBridge repeats Backspace and Delete as iOS does.
//   Characters (the layout, Shift and dead keys applied by the key character map) go through insertText, Space
//   included, so the page's "Space continues a dialogue" works. Ctrl+V and the Paste key paste the clipboard. Back,
//   volume and the other system keys pass on.
// * It owns the activity's bar (KeyboardAccessoryBar) and the IME insets (KeyboardInsets), and is KeyboardBridge's Surface.
package io.github.purexyz.scape2004

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.SystemClock
import android.view.Gravity
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.inputmethod.EditorInfoCompat
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlin.math.roundToInt

@SuppressLint("ViewConstructor")
class KeyboardBridgeView(private val activity: Activity, private val bridge: KeyboardBridge) : View(activity), KeyboardBridge.Surface {
    private val density = resources.displayMetrics.density
    private val imm = activity.getSystemService(InputMethodManager::class.java)
    val bar = KeyboardAccessoryBar(activity)
    private val insets = KeyboardInsets(this, bar, bridge) { activity.window }
    private var connection: GameInputConnection? = null

    /** A dead key's accent (KeyCharacterMap.COMBINING_ACCENT), combined with the next character. */
    private var deadAccent = 0
    private var showRetry: Cancellable? = null
    private var settleCheck: Cancellable? = null

    init {
        id = R.id.kbd_input
        isFocusable = true
        isFocusableInTouchMode = true
        defaultFocusHighlightEnabled = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        if (Build.VERSION.SDK_INT >= 33) isAutoHandwritingEnabled = false // no stylus handwriting into the game
        isHapticFeedbackEnabled = false
        isSoundEffectsEnabled = false
        bar.visibility = GONE
        bar.onSubmit = { bridge.barSubmit() }
        bar.onHide = { bridge.hide(userInitiated = true) }
        bar.onCancel = { bridge.cancel() }
        bar.onChip = { bridge.apply(it) }
    }

    /** Into the activity's root: this view (1×1, top left) and the bar (full width, 52 dp, at the bottom). */
    fun attachTo(root: FrameLayout) {
        root.addView(this, FrameLayout.LayoutParams(1, 1))
        root.addView(bar, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, (KeyboardAccessoryBar.HEIGHT_DP * density).roundToInt(), Gravity.BOTTOM))
        insets.install()
    }

    fun detachFromRoot() {
        showRetry?.cancel()
        settleCheck?.cancel()
        insets.uninstall()
        connection?.endComposition()
        connection = null
        (bar.parent as? FrameLayout)?.removeView(bar)
        (parent as? FrameLayout)?.removeView(this)
    }

    private val editing: Boolean get() = bridge.requested && !bridge.lent

    // ------------------------------------------------------------------------------------------------ the editor

    override fun onCheckIsTextEditor(): Boolean = editing

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        if (!editing) {
            connection = null
            return null // idle: no software keyboard, the hardware keys still come to dispatchKeyEvent
        }
        val text = bridge.displayText
        outAttrs.inputType = bridge.inputType
        // No fullscreen extract editor in landscape (the two flags are mandatory there), nothing learnt from what is
        // typed, an ASCII-capable keyboard (iOS .asciiCapable), and the action key the kind wants.
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN or
            EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING or EditorInfo.IME_FLAG_FORCE_ASCII or bridge.imeAction
        outAttrs.actionLabel = bridge.submitTitle
        outAttrs.actionId = bridge.imeAction
        outAttrs.initialSelStart = text.length
        outAttrs.initialSelEnd = text.length
        outAttrs.initialCapsMode = 0
        EditorInfoCompat.setInitialSurroundingText(outAttrs, text)
        return GameInputConnection(this, bridge, imm).also { connection = it }
    }

    // ------------------------------------------------------------------------------------------------ Surface: the bar

    override fun configure(prompt: String, submitTitle: String, secure: Boolean, numeric: Boolean, text: String, cancellable: Boolean, chips: List<KeyboardBridge.Chip>) =
        bar.configure(prompt, submitTitle, secure, numeric, text, cancellable, chips)

    override fun setPrompt(prompt: String) = bar.setPrompt(prompt)

    override fun setText(text: String) = bar.setText(text)

    override fun setChips(chips: List<KeyboardBridge.Chip>) = bar.setChips(chips)

    override fun setCancellable(cancellable: Boolean) = bar.setCancellable(cancellable)

    override fun flashRejected() = bar.flashRejected()

    override val visibleChips: List<KeyboardBridge.Chip> get() = bar.visibleChips

    // ------------------------------------------------------------------------------------------------ Surface: focus, IME

    override val holdsFocus: Boolean get() = isFocused

    override fun takeFocus(): Boolean = requestFocus()

    override fun giveUpFocus() {
        showRetry?.cancel()
        if (insets.imeVisible) imm.hideSoftInputFromWindow(windowToken, 0)
        bar.visibility = GONE
        // not focusable: clearFocus would otherwise hand focus straight back to this view, the only focusable one
        isFocusable = false
        isFocusableInTouchMode = false
        clearFocus()
    }

    override fun restoreFocus() {
        isFocusable = true
        isFocusableInTouchMode = true
    }

    override fun openKeyboard(reconfigure: Boolean) {
        if (!editing) return
        if (bar.visibility != VISIBLE) {
            insets.place()
            bar.visibility = VISIBLE
            bar.restartCaret()
        }
        if (!isFocused) requestFocus()
        if (reconfigure) {
            connection?.endComposition()
            imm.restartInput(this) // a new editor (iOS reloadInputViews)
        }
        showIme()
        // Some IMEs ignore the first request right after focus: ask once more. With a hardware keyboard the IME may not
        // come at all (Settings › Show on-screen keyboard off): the bar alone covers the page then.
        showRetry?.cancel()
        showRetry = MainScheduler.postDelayed(SHOW_RETRY_MS) {
            if (editing && !insets.imeVisible && hasWindowFocus()) imm.showSoftInput(this, 0)
        }
        settleCheck?.cancel()
        settleCheck = MainScheduler.postDelayed(bridge.settleDelayMs()) { if (!insets.animating) bridge.settle() }
    }

    private fun showIme() {
        val window = activity.window ?: return
        WindowCompat.getInsetsController(window, this).show(WindowInsetsCompat.Type.ime())
    }

    override fun closeKeyboard() {
        showRetry?.cancel()
        connection?.endComposition()
        // (on screen now, wherever it is going: a hide that starts from the IME's own closing still rides down with it)
        val imeUp = insets.imePx > 0
        if (insets.imeVisible) WindowCompat.getInsetsController(activity.window, this).hide(WindowInsetsCompat.Type.ime())
        imm.hideSoftInputFromWindow(windowToken, 0)
        imm.restartInput(this) // back to no editor: the hardware keys only
        // the bar rides down with the IME and goes when it is gone (KeyboardInsets); without one it goes now
        if (!imeUp) {
            bar.visibility = GONE
            bridge.settle()
        }
        settleCheck?.cancel()
        settleCheck = MainScheduler.postDelayed(CLOSE_SETTLE_MS) {
            if (bridge.requested || insets.animating) return@postDelayed
            bar.visibility = GONE
            bridge.settle()
        }
    }

    override fun textChanged() {
        connection?.syncEditable(force = false)
    }

    override fun abandonComposition() {
        val ic = connection ?: return
        if (!ic.isComposing) return
        ic.endComposition()
        ic.syncEditable(force = true)
        imm.restartInput(this) // (the IME's own composition goes with its editor)
    }

    // ------------------------------------------------------------------------------------------------ hardware keys

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (handleKey(event)) return true
        return super.dispatchKeyEvent(event)
    }

    /** True when the key is the game's (it then goes no further: no focus search, no system shortcut). */
    private fun handleKey(event: KeyEvent): Boolean {
        val code = event.keyCode
        // a soft keyboard's key that came this way instead of through the InputConnection
        if (event.flags and KeyEvent.FLAG_SOFT_KEYBOARD != 0) return connection?.softKey(event) ?: softKey(event)
        if (code == KeyEvent.KEYCODE_BACK) return false // GameActivity's Back (which does nothing)
        if (code == KeyEvent.KEYCODE_PASTE || (code == KeyEvent.KEYCODE_V && event.isCtrlPressed && !event.isAltPressed)) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) pasteFromClipboard()
            return true
        }
        val name = KeyboardBridge.GAME_KEYS[code]
        if (name != null) {
            when (event.action) {
                // (system repeats are dropped: the bridge repeats Backspace and Delete itself, at iOS's rate)
                KeyEvent.ACTION_DOWN -> if (event.repeatCount == 0) bridge.keyDown(code, name)
                KeyEvent.ACTION_UP -> bridge.keyUp(code)
            }
            return name !in KeyboardBridge.MODIFIER_KEYS // modifiers go on: the framework tracks the meta state
        }
        return when (event.action) {
            @Suppress("DEPRECATION")
            KeyEvent.ACTION_MULTIPLE -> {
                @Suppress("DEPRECATION")
                val characters = event.characters ?: return false
                bridge.insertText(characters)
                true
            }
            KeyEvent.ACTION_DOWN -> character(event)
            KeyEvent.ACTION_UP -> !event.isCtrlPressed && !event.isMetaPressed && event.getUnicodeChar(event.metaState) != 0
            else -> false
        }
    }

    /** A character key: the layout's character for the meta state, a pending dead key combined with it. */
    private fun character(event: KeyEvent): Boolean {
        if (event.isCtrlPressed || event.isMetaPressed) return false // shortcuts, not text (iOS types nothing for them)
        val unicode = event.getUnicodeChar(event.metaState)
        if (unicode == 0) return false
        if (unicode and KeyCharacterMap.COMBINING_ACCENT != 0) {
            deadAccent = unicode and KeyCharacterMap.COMBINING_ACCENT_MASK
            return true
        }
        val accent = deadAccent
        deadAccent = 0
        val text = if (accent != 0) {
            val combined = KeyCharacterMap.getDeadChar(accent, unicode)
            if (combined != 0) String(Character.toChars(combined)) else String(Character.toChars(accent)) + String(Character.toChars(unicode))
        } else {
            String(Character.toChars(unicode))
        }
        bridge.insertText(text)
        return true
    }

    /** A soft key with no InputConnection to take it (GameInputConnection.softKey has the same rules). */
    private fun softKey(event: KeyEvent): Boolean = GameInputConnection.softKeyToBridge(event, bridge)

    /** Ctrl+V or the Paste key: the clipboard's text as one line (Android 13+ shows its own "pasted" toast). */
    private fun pasteFromClipboard() {
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        val text = try {
            clipboard?.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
        } catch (error: Exception) {
            Log.info("kbd", "the clipboard could not be read: $error")
            null
        }
        if (text.isNullOrEmpty()) return
        bridge.pasteText(text)
    }

    override fun onFocusChanged(gainFocus: Boolean, direction: Int, previouslyFocusedRect: android.graphics.Rect?) {
        super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
        if (!gainFocus) {
            deadAccent = 0
            bridge.releaseHeldKeys()
        }
    }

    // ------------------------------------------------------------------------------------------------ debug

    override fun debugHardwareKey(name: String, down: Boolean): Boolean {
        val code = KeyboardBridge.GAME_KEYS.entries.firstOrNull { it.value == name }?.key ?: return false
        val now = SystemClock.uptimeMillis()
        // a key from a hardware keyboard (device 1), not the soft keyboard, through the real key path
        val event = KeyEvent(now, now, if (down) KeyEvent.ACTION_DOWN else KeyEvent.ACTION_UP, code, 0, 0, 1, 0, 0, android.view.InputDevice.SOURCE_KEYBOARD)
        handleKey(event)
        return true
    }

    /**
     * Runs IME calls on the live InputConnection, as a composing or pasting IME would make them (Gboard's text layout on
     * the emulator never composes): `[[method, args…], …]` with setComposingText, commitText, finishComposingText,
     * setComposingRegion, deleteSurroundingText, sendKeyEvent (a keycode, down and up, from the soft keyboard) and
     * performEditorAction, and the bar's Send (barSubmit) between them, all in one go (the real IME cannot step in
     * between: it would end a composition it did not make). Each call goes to the editor live at the time (a restart
     * makes a new one). Returns, after each call, the mirror, whether a composition is open and the bar's text; null
     * without an editor.
     */
    fun debugIme(ops: kotlinx.serialization.json.JsonArray): JsonElement? {
        if (connection == null) return null
        val steps = ArrayList<JsonElement>()
        for (op in ops) {
            val ic = connection ?: break
            val list = op as? kotlinx.serialization.json.JsonArray ?: continue
            val name = (list.getOrNull(0) as? JsonPrimitive)?.content ?: continue
            fun text(i: Int) = (list.getOrNull(i) as? JsonPrimitive)?.content ?: ""
            fun int(i: Int) = (list.getOrNull(i) as? JsonPrimitive)?.content?.toIntOrNull() ?: 0
            when (name) {
                "setComposingText" -> ic.setComposingText(text(1), 1)
                "commitText" -> ic.commitText(text(1), 1)
                "finishComposingText" -> ic.finishComposingText()
                "setComposingRegion" -> ic.setComposingRegion(int(1), int(2))
                "deleteSurroundingText" -> ic.deleteSurroundingText(int(1), int(2))
                "sendKeyEvent" -> {
                    val now = SystemClock.uptimeMillis()
                    for (action in listOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
                        ic.sendKeyEvent(KeyEvent(now, now, action, int(1), 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, KeyEvent.FLAG_SOFT_KEYBOARD or KeyEvent.FLAG_KEEP_TOUCH_MODE))
                    }
                }
                "performEditorAction" -> ic.performEditorAction(bridge.imeAction)
                "barSubmit" -> bar.onSubmit?.invoke()
                else -> Log.info("kbd", "debug: no IME call named $name")
            }
            val live = connection ?: ic
            steps += kotlinx.serialization.json.buildJsonObject {
                put("op", JsonPrimitive(name))
                put("editable", JsonPrimitive(live.editableText))
                put("composing", JsonPrimitive(live.isComposing))
                put("restarted", JsonPrimitive(live !== ic))
                put("displayText", JsonPrimitive(bridge.displayText))
            }
        }
        return kotlinx.serialization.json.JsonArray(steps)
    }

    override fun debugState(): Map<String, JsonElement> {
        val root = rootView
        val focused = root?.findFocus()
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        val config = resources.configuration
        return mapOf(
            "displayText" to JsonPrimitive(bar.displayedText),
            "chips" to kotlinx.serialization.json.JsonArray(bar.visibleChips.map { JsonPrimitive(it.label) }),
            "cancelShown" to JsonPrimitive(bar.isCancelShown),
            "submitTitle" to JsonPrimitive(bar.submitTitle),
            "flashing" to JsonPrimitive(bar.isFlashingRejected),
            "canPaste" to JsonPrimitive(clipboard?.hasPrimaryClip() == true),
            "imeVisible" to JsonPrimitive(insets.imeVisible),
            "imeHeight" to JsonPrimitive((insets.imePx / density).toDouble()),
            "hardKeyboard" to JsonPrimitive(config.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO),
            "barVisible" to JsonPrimitive(bar.visibility == VISIBLE),
            "barTop" to JsonPrimitive(((bar.top + bar.translationY) / density).toDouble()),
            "barHeight" to JsonPrimitive((bar.height / density).toDouble()),
            "editor" to JsonPrimitive(connection != null),
            "editable" to JsonPrimitive(connection?.editableText ?: ""),
            "composing" to JsonPrimitive(connection?.isComposing == true),
            "hasWindowFocus" to JsonPrimitive(hasWindowFocus()),
            "focused" to JsonPrimitive(focused?.javaClass?.simpleName ?: ""),
            "webViewFocused" to JsonPrimitive(focused is android.webkit.WebView || findWebView(root)?.hasFocus() == true),
            "views" to kotlinx.serialization.json.JsonObject(bar.debugRects()),
        )
    }

    private fun findWebView(view: View?): android.webkit.WebView? {
        if (view is android.webkit.WebView) return view
        if (view is android.view.ViewGroup) {
            for (i in 0 until view.childCount) findWebView(view.getChildAt(i))?.let { return it }
        }
        return null
    }

    private companion object {
        const val SHOW_RETRY_MS = 100L

        /** A hide whose IME animation never came: the bar goes and the page hears 0. */
        const val CLOSE_SETTLE_MS = 600L
    }
}
