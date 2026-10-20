// The Claude key's secure box (Settings › Bot chat › Set key…; docs/ARCHITECTURE.md §7.1):
// the iOS app's UIAlertController with a secure text field (GameViewController.presentKeyAlert), as a native
// AlertDialog. The key is typed here, never in the page, and goes straight to the key store.
//
// - Title "Claude API key"; the message says where the key stays (this phone, encrypted) and what Claude online sends.
// - One password field: no suggestions, no personalised learning, no autofill (a password manager must not offer to keep
//   it). The IME's action key says Save and saves.
// - The game is landscape, and a phone in landscape has no room for the box and the keyboard together (measured on the
//   emulator's 411 dp tall screen: Gboard takes 295 dp, the box keeps the title and message, and the field and the
//   buttons get no height at all). So on such a screen the box comes up with the field focused and the keyboard down: the
//   message is read first, a long-press pastes, and a tap on the field opens the IME's full-screen editor (Gboard's, in
//   landscape: the masked field and a Save key). A screen tall enough for both (a tablet) gets the keyboard at once, as
//   the iPhone's alert does.
// - FLAG_SECURE on the box's own window: screenshots, recordings and the recents thumbnail show it black, while the game's
//   window stays capturable (measured on API 37: so is the keyboard while it types into the box).
// - Cancel, Back and a tap outside all cancel. One box at a time. The keyboard bridge lends its focus while it is up and
//   takes it back after (iOS: yieldFirstResponder, then keyboard.activate()).
// - Saved text that cannot be a key: the status says "not a key" and the error haptic plays (Settings › Vibration permitting).
package io.github.purexyz.scape2004.llm

import android.app.Activity
import android.app.AlertDialog
import android.content.DialogInterface
import android.text.InputType
import android.text.method.PasswordTransformationMethod
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout

class KeyEntryDialog(
    private val activity: Activity,
    /** what was typed (Save), or null (Cancel, Back, outside); called once the box is gone */
    private val closed: (String?) -> Unit,
) {
    companion object {
        const val TITLE = "Claude API key"
        const val MESSAGE = "Paste your key from platform.claude.com. It stays encrypted on this phone, never in the game. " +
            "While Claude online is on, the chat and the bot's state go to Anthropic."

        /** The screen height (dp) from which the box and a keyboard fit together: about 300 dp of keyboard, 250 of box. */
        const val KEYBOARD_AT_ONCE_DP = 560
    }

    val field: EditText = EditText(activity).apply {
        // (single line first: setSingleLine replaces the transformation method, so after the input type it would undo the
        // password's masking and show the key as it is typed; a text input type without MULTI_LINE is one line anyway)
        isSingleLine = true
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        hint = "sk-ant-…"
        imeOptions = EditorInfo.IME_ACTION_DONE or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        setImeActionLabel("Save", EditorInfo.IME_ACTION_DONE)
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
    }

    private var typed: String? = null

    val dialog: AlertDialog = AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
        .setTitle(TITLE)
        .setMessage(MESSAGE)
        .setView(FrameLayout(activity).apply {
            val margin = (20 * activity.resources.displayMetrics.density).toInt()
            setPadding(margin, 0, margin, 0)
            addView(field)
        })
        .setNegativeButton("Cancel", null)
        .setPositiveButton("Save") { _, _ -> typed = field.text?.toString() ?: "" }
        .create()
        .apply {
            setCanceledOnTouchOutside(true)
            setOnDismissListener {
                field.setText("")
                closed(typed)
            }
        }

    init {
        field.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_DONE) {
                pressSave()
                true
            } else {
                false
            }
        }
    }

    fun show() {
        // (the keyboard at once only where the box still fits above it: see the header)
        val keyboardAtOnce = activity.resources.configuration.screenHeightDp >= KEYBOARD_AT_ONCE_DP
        dialog.window?.apply {
            addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            setSoftInputMode(if (keyboardAtOnce) WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE else WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN)
        }
        dialog.show()
        field.requestFocus()
    }

    val title: String get() = TITLE

    /** The field masks what is typed (the debug lm-key-alert's `secure`): a password input type, drawn as dots. */
    val secure: Boolean
        get() = (this.field.inputType and InputType.TYPE_MASK_VARIATION) == InputType.TYPE_TEXT_VARIATION_PASSWORD &&
            this.field.transformationMethod is PasswordTransformationMethod  // (this.: `field` alone is a getter's backing field)

    fun pressSave() {
        dialog.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
    }

    fun pressCancel() {
        dialog.getButton(DialogInterface.BUTTON_NEGATIVE).performClick()
    }
}
