// ServerDialog: the Add / Edit server box (`{type:'server', action:'ask', title, address, name}`; the iOS app's
// UIAlertController in GameViewController.presentServerAlert; docs/ARCHITECTURE.md §7.5, docs/ANDROID.md §7), in the 2004
// look of the native views (RSTheme: the stone fill, the window edge, the game's fonts and buttons).
//
//     Add a server
//     Address, and a name (optional).
//     Address  [192.168.1.20 or my-mac.local:8888]
//     Name     [Optional]
//                                   [Cancel] [OK]
//
// - The fields take plain text: the address with no suggestions, no personalised learning, no autofill (a URI keyboard,
//   the IME's Next goes to Name); Name's Done is OK. Their text and the placeholders are in the game's Plain 12.
// - Cancel, Back and a tap outside answer null; OK answers what was typed, trimmed (`LostCityHost.servers.answer`). The
//   page checks the address, says what is wrong and probes it (docs/ONLINE.md).
// - The game is landscape, and a phone in landscape has no room for the box and the keyboard together, so on such a
//   screen the box comes up with the keyboard down, as the Claude key's box (llm/KeyEntryDialog.kt): a tap on a field
//   opens the IME's full-screen editor for it (Gboard's, in landscape, with Next and Done). A screen tall enough for both
//   (a tablet) gets the keyboard at once.
// - One box at a time. The keyboard bridge lends its input focus while it is up and takes it back after (iOS:
//   yieldFirstResponder, then keyboard.activate()).
package io.github.purexyz.scape2004

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Dialog
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import kotlin.math.min
import kotlin.math.roundToInt

class ServerDialog(
    private val activity: Activity,
    val title: String,
    address: String,
    name: String,
    /** (address, name) trimmed for OK, null for Cancel, Back or outside; called once the box is gone. */
    private val closed: (Pair<String, String>?) -> Unit,
) {
    private val density = activity.resources.displayMetrics.density
    private fun dp(value: Float) = (value * density).roundToInt()

    val addressField: EditText = field(ADDRESS_PLACEHOLDER).apply {
        id = R.id.server_address
        setText(address)
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        imeOptions = EditorInfo.IME_ACTION_NEXT or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        contentDescription = "Address"
    }

    val nameField: EditText = field(NAME_PLACEHOLDER).apply {
        id = R.id.server_name
        setText(name)
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        imeOptions = EditorInfo.IME_ACTION_DONE or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        contentDescription = "Name"
        setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_DONE) {
                pressOk()
                true
            } else {
                false
            }
        }
    }

    private val cancelButton = RSButton(activity).apply {
        id = R.id.server_cancel
        title = "Cancel"
        onTap = { pressCancel() }
    }

    private val okButton = RSButton(activity).apply {
        id = R.id.server_ok
        insetLeading = 18f
        insetTrailing = 18f
        title = "OK"
        onTap = { pressOk() }
    }

    private var answer: Pair<String, String>? = null

    val dialog: Dialog = Dialog(activity, android.R.style.Theme_DeviceDefault_Dialog_NoActionBar).apply {
        setContentView(content())
        setCanceledOnTouchOutside(true)
        setOnDismissListener { closed(answer) }
    }

    /** The placeholders as the fields show them (the debug `server-alert`). */
    val placeholders: List<String> get() = listOf(addressField.hint.toString(), nameField.hint.toString())

    fun show() {
        val keyboardAtOnce = activity.resources.configuration.screenHeightDp >= KEYBOARD_AT_ONCE_DP
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setLayout(min(dp(460f), activity.resources.displayMetrics.widthPixels - dp(32f)), ViewGroup.LayoutParams.WRAP_CONTENT)
            setSoftInputMode(
                (if (keyboardAtOnce) WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE else WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN) or
                    WindowManager.LayoutParams.SOFT_INPUT_ADJUST_PAN,
            )
        }
        dialog.show()
        addressField.requestFocus()
        addressField.setSelection(addressField.text.length)
    }

    fun pressOk() {
        answer = addressField.text.toString().trim() to nameField.text.toString().trim()
        dialog.dismiss()
    }

    fun pressCancel() {
        answer = null
        dialog.dismiss()
    }

    // ------------------------------------------------------------------------------------------------ views

    @SuppressLint("SetTextI18n")
    private fun content(): View {
        val panel = Panel(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16f), dp(14f), dp(16f), dp(14f))
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            layoutDirection = View.LAYOUT_DIRECTION_LTR
        }
        panel.addView(RSTextView(activity).apply {
            id = R.id.server_title
            font = RSTheme.Font.BOLD12
            textColor = RSTheme.YELLOW
            text = title
        })
        panel.addView(RSTextView(activity).apply {
            font = RSTheme.Font.PLAIN12
            textColor = RSTheme.WHITE
            text = "Address, and a name (optional)."
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6f) })
        panel.addView(row("Address", addressField), rowParams(10f))
        panel.addView(row("Name", nameField), rowParams(8f))
        panel.addView(LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            addView(cancelButton)
            addView(okButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(8f) })
        }, rowParams(14f))
        return panel
    }

    private fun rowParams(top: Float) = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(top) }

    private fun row(label: String, field: EditText): View = LinearLayout(activity).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        addView(RSTextView(activity).apply {
            font = RSTheme.Font.PLAIN12
            textColor = RSTheme.ORANGE
            text = label
        }, LinearLayout.LayoutParams(dp(64f), ViewGroup.LayoutParams.WRAP_CONTENT))
        addView(field, LinearLayout.LayoutParams(0, dp(36f), 1f))
    }

    /** A text field as the keyboard bar's input line: a dark inset in the stone, white game text, a grey placeholder. */
    private fun field(placeholder: String): EditText = EditText(activity).apply {
        isSingleLine = true
        hint = placeholder
        typeface = RSTheme.typeface(RSTheme.Font.PLAIN12)
        setTextSize(TypedValue.COMPLEX_UNIT_PX, RSTheme.textSizePx(RSTheme.Font.PLAIN12, 1f, density))
        setTextColor(RSTheme.WHITE)
        setHintTextColor(HINT)
        background = GradientDrawable().apply {
            setColor(0x8C000000.toInt())
            setStroke(density.roundToInt(), RSTheme.STONE_DARK)
        }
        setPadding(dp(8f), 0, dp(8f), 0)
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        isSoundEffectsEnabled = false
    }

    /** The stone fill with the game's window edge: 1 dp black outside, 2 dp light stone, 1 dp dark stone inside. */
    private class Panel(context: android.content.Context) : LinearLayout(context) {
        private val density = resources.displayMetrics.density
        private val fill = RSTheme.stoneFillDrawable(density)
        private val paint = Paint()

        init {
            setWillNotDraw(false)
        }

        override fun onDraw(canvas: Canvas) {
            val w = width.toFloat()
            val h = height.toFloat()
            fill.setBounds(0, 0, width, height)
            fill.draw(canvas)
            val one = density.roundToInt().toFloat()
            fun frame(inset: Float, thickness: Float, color: Int) {
                paint.color = color
                canvas.drawRect(inset, inset, w - inset, inset + thickness, paint)
                canvas.drawRect(inset, h - inset - thickness, w - inset, h - inset, paint)
                canvas.drawRect(inset, inset, inset + thickness, h - inset, paint)
                canvas.drawRect(w - inset - thickness, inset, w - inset, h - inset, paint)
            }
            frame(0f, one, RSTheme.BLACK)
            frame(one, 2 * one, RSTheme.STONE_LIGHT)
            frame(3 * one, one, RSTheme.STONE_DARK)
        }
    }

    companion object {
        const val ADDRESS_PLACEHOLDER = "192.168.1.20 or my-mac.local:8888"
        const val NAME_PLACEHOLDER = "Optional"

        /** The screen height (dp) from which the box and a keyboard fit together (KeyEntryDialog's). */
        const val KEYBOARD_AT_ONCE_DP = 560

        private const val HINT = 0xFF9A8E7C.toInt()
    }
}
