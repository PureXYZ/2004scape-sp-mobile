// KeyboardAccessoryBar: the bar above the software keyboard (alone at the bottom of the screen when a hardware keyboard
// is attached), a strip of the 2004 interface (ports ios/LostCity/KeyboardAccessoryBar.swift). In
// landscape the keyboard covers the game's chat line, so the bar shows what is being typed:
//
//     [prompt] [input line*] [chip] [chip] …  [Cancel] [x Remember] [Send] [v]
//
// * the prompt and the game's current input line with its blinking "*" caret (masked when the input is a password);
// * chips (ChipStrip), one-tap entries from the page (the '::' key and recent developer commands for chat, amounts for an
//   amount prompt). A `whenEmpty` chip only shows while the line is empty; once something is typed into a text input the
//   row gets less room (30 % of the bar instead of 45 %), the line more;
// * Cancel (only for prompts the page marks cancellable), the Remember box (only for an online server's password, when
//   the page says whether it is ticked), the submit button (the number pad has no Return key) and the hide button.
//
// iOS lays it out with Auto Layout; here a custom ViewGroup does the same arithmetic: the row is centred 1 dp below the
// middle, 12 dp from the leading safe edge and 6 dp from the trailing one, 10 dp between items (6 after Cancel and after
// the submit button, 8 after the Remember box); the field takes what the others leave but at least 180 dp (120 for an amount); when that is short
// the chips give way first, then the prompt (iOS's priorities: chips 700, prompt 750, the field's minimum required).
//
// It is a child of the activity's root at the bottom (52 dp tall), above the WebView, GONE unless the keyboard is
// requested; KeyboardInsets moves it up with the IME (translationY). It takes every touch on it, so none reaches the game.
package io.github.purexyz.scape2004

import android.animation.ArgbEvaluator
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.transition.ChangeBounds
import android.transition.TransitionManager
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.animation.LinearInterpolator
import android.view.animation.PathInterpolator
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

@SuppressLint("ViewConstructor")
class KeyboardAccessoryBar(context: Context) : ViewGroup(context) {
    var onSubmit: (() -> Unit)? = null
    var onHide: (() -> Unit)? = null
    var onCancel: (() -> Unit)? = null
    var onChip: ((KeyboardBridge.Chip) -> Unit)? = null

    /** The Remember box was tapped: its new state. */
    var onRemember: ((Boolean) -> Unit)? = null

    private val density = resources.displayMetrics.density
    private val promptLabel = RSTextView(context)
    private val inputField = Field(context)
    private val chipStrip = ChipStrip(context)
    private val cancelButton = RSButton(context)
    private val rememberBox = RememberBox(context)
    private val submitButton = RSButton(context)
    private val hideButton = RSButton(context)
    private val fill = RSTheme.stoneFillDrawable(density)
    private val edgePaint = Paint()

    private var chips: List<KeyboardBridge.Chip> = emptyList()
    private val chipViews = ArrayList<RSButton>()
    private var text = ""
    private var secure = false
    private var numeric = false

    /** The Remember box: null while it is not shown. */
    var remember: Boolean? = null
        private set

    /** The chips' share of the bar's width: 45 % while the line is empty, 30 % while typing, none for an amount. */
    private var chipLimit: Float? = CHIP_LIMIT_EMPTY

    /** The safe area's left and right (px): the cutout, or a navigation bar on the side. */
    private var safeLeft = 0
    private var safeRight = 0

    init {
        id = R.id.kbd_bar
        setWillNotDraw(false)
        importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        isFocusable = false
        isFocusableInTouchMode = false
        // RTL never: the game is 2004 English (the root is LTR already; the bar may be added elsewhere in tests)
        layoutDirection = LAYOUT_DIRECTION_LTR

        promptLabel.apply {
            id = R.id.kbd_prompt
            font = RSTheme.Font.PLAIN12
            textColor = RSTheme.YELLOW
            ellipsize = TextUtils.TruncateAt.END
            visibility = GONE
        }

        chipStrip.id = R.id.kbd_chips
        chipStrip.visibility = GONE

        cancelButton.apply {
            id = R.id.kbd_cancel
            insetTop = 6f; insetLeading = 12f; insetBottom = 6f; insetTrailing = 12f
            title = "Cancel"
            visibility = GONE
            onTap = { onCancel?.invoke() }
        }
        rememberBox.apply {
            id = R.id.kbd_remember
            visibility = GONE
            setOnClickListener { rememberTapped() }
        }
        submitButton.apply {
            id = R.id.kbd_submit
            insetTop = 6f; insetLeading = 14f; insetBottom = 6f; insetTrailing = 14f
            title = "OK"
            onTap = { onSubmit?.invoke() }
        }
        hideButton.apply {
            id = R.id.kbd_hide
            insetTop = 8f; insetLeading = 10f; insetBottom = 8f; insetTrailing = 10f
            icon = RSButton.chevron(density)
            iconWidthDp = RSButton.CHEVRON_WIDTH_DP
            iconHeightDp = RSButton.CHEVRON_HEIGHT_DP
            accessibilityLabel = "Hide keyboard"
            onTap = { onHide?.invoke() }
        }
        for (view in listOf(promptLabel, inputField, chipStrip, cancelButton, rememberBox, submitButton, hideButton)) addView(view)
    }

    // ------------------------------------------------------------------------------------------------ content

    fun configure(prompt: String, submitTitle: String, secure: Boolean, numeric: Boolean, text: String, cancellable: Boolean, chips: List<KeyboardBridge.Chip>) {
        setPrompt(prompt)
        submitButton.title = submitTitle
        setCancellable(cancellable)
        this.numeric = numeric
        this.secure = secure
        this.text = text
        setChips(chips)
        setText(text)
        requestLayout()
    }

    fun setPrompt(prompt: String) {
        promptLabel.text = prompt
        promptLabel.visibility = if (prompt.isEmpty()) GONE else VISIBLE
    }

    fun setCancellable(cancellable: Boolean) {
        cancelButton.visibility = if (cancellable) VISIBLE else GONE
    }

    /** Shows the Remember box ticked or not, or hides it (null). */
    fun setRemember(on: Boolean?) {
        val shown = (remember != null) != (on != null)
        remember = on
        rememberBox.on = on == true
        rememberBox.visibility = if (on == null) GONE else VISIBLE
        if (shown) requestLayout()
    }

    private fun rememberTapped() {
        val on = remember ?: return
        setRemember(!on)
        onRemember?.invoke(!on)
    }

    /** Taps the Remember box as a finger does (test pages); false when it is not shown. */
    fun debugTapRemember(): Boolean {
        if (rememberBox.visibility != VISIBLE) return false
        rememberBox.performClick()
        return true
    }

    fun setText(text: String) {
        this.text = text
        inputField.setText(if (secure) "*".repeat(KeyboardBridge.graphemeCount(text)) else text, secure, KeyboardBridge.graphemeCount(text))
        updateChips(animated = true)
    }

    fun setChips(chips: List<KeyboardBridge.Chip>) {
        if (chips == this.chips) return
        this.chips = chips
        chipStrip.row.removeAllViews()
        chipViews.clear()
        for (chip in chips) {
            val button = makeChipButton(chip)
            chipViews.add(button)
            chipStrip.row.addView(button)
        }
        chipStrip.scrollToStart()
        updateChips(animated = false)
    }

    /** Feedback for characters the input does not take (with the warning haptic native plays). */
    fun flashRejected() = inputField.flash()

    /** The caret's blink restarts on every show (iOS restarts it whenever the bar enters a window). */
    fun restartCaret() = inputField.restartBlink()

    val displayedText: String get() = inputField.shownText

    /** The chips on show, in order. */
    val visibleChips: List<KeyboardBridge.Chip>
        get() = if (chipStrip.visibility != VISIBLE) emptyList() else chips.zip(chipViews).filter { it.second.visibility == VISIBLE }.map { it.first }
    val isCancelShown: Boolean get() = cancelButton.visibility == VISIBLE

    /** The field is flashing for refused characters (`flashRejected()`, 0.35 s). */
    val isFlashingRejected: Boolean get() = inputField.isFlashing
    val submitTitle: String get() = submitButton.title

    /** The safe area's sides (px), from the window insets. */
    fun setSafeInsets(left: Int, right: Int) {
        if (left == safeLeft && right == safeRight) return
        safeLeft = left
        safeRight = right
        requestLayout()
    }

    /** Shows the `whenEmpty` chips only while the line is empty, and gives the line more room once something is typed. */
    private fun updateChips(animated: Boolean) {
        val empty = text.isEmpty()
        var changed = false
        for ((chip, view) in chips.zip(chipViews)) {
            if (chip.whenEmpty && (view.visibility == GONE) == empty) {
                view.visibility = if (empty) VISIBLE else GONE
                changed = true
            }
        }
        val anyShown = chipViews.any { it.visibility == VISIBLE }
        if ((chipStrip.visibility == GONE) == anyShown) {
            chipStrip.visibility = if (anyShown) VISIBLE else GONE
            changed = true
        }
        // (an amount's few digits never need the room)
        val limit = if (numeric) null else if (empty) CHIP_LIMIT_EMPTY else CHIP_LIMIT_TYPING
        if (limit != chipLimit) {
            chipLimit = limit
            changed = true
        }
        if (!changed) return
        if (animated && isAttachedToWindow && visibility == VISIBLE) {
            TransitionManager.beginDelayedTransition(this, ChangeBounds().setDuration(150).setInterpolator(EASE_IN_OUT))
        }
        requestLayout()
    }

    /** A chip: the Game Options tab's small button, in its "chosen" look (red, yellow text) while pressed. */
    private fun makeChipButton(chip: KeyboardBridge.Chip): RSButton = RSButton(context).apply {
        look = RSButton.Look.OPTION
        font = RSTheme.Font.PLAIN12
        titleColor = RSTheme.WHITE
        pressedTitleColor = RSTheme.YELLOW
        insetTop = 0f; insetLeading = 8f; insetBottom = 0f; insetTrailing = 8f
        heightDp = 32f
        minWidthDp = 44f
        maxWidthDp = 220f
        title = chip.label
        hint = if (chip.submit) "Enters and sends ${chip.text}" else "Enters ${chip.text}"
        onTap = { onChip?.invoke(chip) }
    }

    // ------------------------------------------------------------------------------------------------ layout

    private fun dp(value: Float) = (value * density).roundToInt()

    /** The visible items in order with the space after each (px). */
    private fun items(): List<Pair<View, Int>> {
        val list = ArrayList<Pair<View, Int>>()
        for (view in listOf(promptLabel, inputField, chipStrip, cancelButton, rememberBox, submitButton, hideButton)) {
            if (view.visibility == GONE) continue
            val after = if (view === cancelButton || view === submitButton) dp(6f) else if (view === rememberBox) dp(8f) else dp(10f)
            list.add(view to after)
        }
        return list
    }

    private var widths = HashMap<View, Int>()

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val height = dp(HEIGHT_DP.toFloat())
        val unspecified = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
        val start = dp(12f) + safeLeft
        val end = dp(6f) + safeRight
        val available = width - start - end
        val visible = items()
        // the space between items (none after the last)
        val spacing = visible.dropLast(1).sumOf { it.second }

        // the buttons at their own size
        var fixed = 0
        for (button in listOf(cancelButton, rememberBox, submitButton, hideButton)) {
            if (button.visibility == GONE) continue
            button.measure(unspecified, MeasureSpec.makeMeasureSpec(dp(if (button === rememberBox) 32f else 36f), MeasureSpec.EXACTLY))
            fixed += button.measuredWidth
        }
        // the prompt: its text, at most 38 % of the bar
        var promptWidth = 0
        if (promptLabel.visibility != GONE) {
            promptLabel.measure(MeasureSpec.makeMeasureSpec((width * 0.38f).toInt(), MeasureSpec.AT_MOST), unspecified)
            promptWidth = promptLabel.measuredWidth
        }
        // the chips: all of them if they fit, within their share
        var chipsWidth = 0
        if (chipStrip.visibility != GONE) {
            chipStrip.measure(unspecified, MeasureSpec.makeMeasureSpec(dp(34f), MeasureSpec.EXACTLY))
            chipsWidth = chipStrip.contentWidth
            chipLimit?.let { chipsWidth = min(chipsWidth, (width * it).toInt()) }
        }
        // the field takes the rest, but at least its minimum: the chips give way first, then the prompt
        val fieldMin = dp(if (numeric) 120f else 180f)
        var rest = available - spacing - fixed - promptWidth - chipsWidth
        if (rest < fieldMin) {
            var deficit = fieldMin - rest
            val fromChips = min(deficit, chipsWidth)
            chipsWidth -= fromChips
            deficit -= fromChips
            val fromPrompt = min(deficit, promptWidth)
            promptWidth -= fromPrompt
            rest = fieldMin
        }
        if (promptLabel.visibility != GONE) {
            promptLabel.measure(MeasureSpec.makeMeasureSpec(promptWidth, MeasureSpec.EXACTLY), unspecified)
        }
        if (chipStrip.visibility != GONE) {
            chipStrip.measure(MeasureSpec.makeMeasureSpec(chipStrip.windowWidth(chipsWidth), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(dp(34f), MeasureSpec.EXACTLY))
        }
        inputField.measure(MeasureSpec.makeMeasureSpec(rest, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(dp(40f), MeasureSpec.EXACTLY))
        widths = hashMapOf(promptLabel to promptWidth, chipStrip to chipsWidth, inputField to rest)
        setMeasuredDimension(width, height)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val centre = (b - t) / 2 + dp(1f)
        var x = dp(12f) + safeLeft
        for ((view, after) in items()) {
            val w = view.measuredWidth
            val h = view.measuredHeight
            val top = centre - h / 2
            view.layout(x, top, x + w, top + h)
            // (the chips' strip may be narrower than its share: the overflow window; the share still counts)
            x += max(w, widths[view] ?: w) + after
        }
    }

    override fun onDraw(canvas: Canvas) {
        fill.setBounds(0, 0, width, height)
        fill.draw(canvas)
        // the window edge: 1 dp black, then 2 dp light stone
        val one = dp(1f).toFloat()
        edgePaint.color = RSTheme.BLACK
        canvas.drawRect(0f, 0f, width.toFloat(), one, edgePaint)
        edgePaint.color = RSTheme.STONE_LIGHT
        canvas.drawRect(0f, one, width.toFloat(), one + dp(2f), edgePaint)
    }

    /** Every touch on the bar is the bar's: none falls through to the game. */
    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean = true

    /**
     * The caret blinks only while the bar is on screen (iOS restarts the animation whenever the bar enters a window); a
     * forever animation on a hidden bar would keep the UI thread's frames (and uiautomator's idle wait) busy for nothing.
     */
    override fun onVisibilityAggregated(isVisible: Boolean) {
        super.onVisibilityAggregated(isVisible)
        if (isVisible) inputField.restartBlink() else inputField.stopBlink()
    }

    /** Where the bar's parts are on the screen (px: left, top, width, height), for the tests' taps. */
    fun debugRects(): Map<String, JsonElement> {
        fun rect(view: View): JsonElement {
            if (view.visibility != VISIBLE || !view.isShown) return JsonNull
            val at = IntArray(2)
            view.getLocationOnScreen(at)
            return JsonArray(listOf(at[0], at[1], view.width, view.height).map(::JsonPrimitive))
        }
        return mapOf(
            "bar" to rect(this),
            "prompt" to rect(promptLabel),
            "field" to rect(inputField),
            "text" to rect(inputField.textView),
            "chipStrip" to rect(chipStrip),
            "chips" to JsonArray(chipViews.map(::rect)),
            "cancel" to rect(cancelButton),
            "remember" to rect(rememberBox),
            "submit" to rect(submitButton),
            "hide" to rect(hideButton),
        )
    }

    /**
     * The Remember box's frame in the bar, `[x, y, width, height]` in dp, beside the submit button's, the input line's and
     * the bar's (iOS's debugRememberLayout in points: the box sits left of the submit button, clear of the line).
     */
    fun debugRememberLayout(): JsonElement {
        fun frame(view: View) = JsonArray(listOf(view.left, view.top, view.width, view.height).map { JsonPrimitive(it / density) })
        return kotlinx.serialization.json.JsonObject(
            mapOf(
                "remember" to frame(rememberBox),
                "submit" to frame(submitButton),
                "field" to frame(inputField),
                "bar" to JsonArray(listOf(0f, 0f, width / density, height / density).map(::JsonPrimitive)),
            ),
        )
    }

    /**
     * The Remember box: a check box drawn in game pixels (a black square, dark inside, a yellow tick with a black shadow
     * when ticked) and "Remember" on the Game Options tab's small button (red while pressed), yellow while ticked
     * (KeyboardAccessoryBar.swift styleRememberButton). 8 dp in, 6 between the box and the word, 10 dp out.
     */
    private class RememberBox(context: Context) : View(context) {
        private val density = resources.displayMetrics.density
        private val paint = android.text.TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            isSubpixelText = false
            hinting = Paint.HINTING_OFF
        }
        private val pixels = Paint().apply { isAntiAlias = false }
        private val normal = RSTheme.optionButtonImage(density = density)
        private val pressedLook = RSTheme.optionButtonImage(on = true, density = density)

        var on = false
            set(value) {
                if (field == value) return
                field = value
                stateDescription = if (value) "on" else "off"
                invalidate()
            }

        init {
            isClickable = true
            isFocusable = false
            isFocusableInTouchMode = false
            isSoundEffectsEnabled = false
            contentDescription = "Remember password"
            stateDescription = "off"
        }

        private fun dp(value: Float) = value * density
        private val shadowPx: Float get() = density.roundToInt().toFloat()

        private fun applyPaint() {
            paint.typeface = RSTheme.typeface(RSTheme.Font.PLAIN12)
            paint.textSize = RSTheme.textSizePx(RSTheme.Font.PLAIN12, 1f, density)
        }

        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            applyPaint()
            val width = dp(8f) + dp(2f * BOX) + dp(6f) + paint.measureText(TITLE) + shadowPx + dp(10f)
            setMeasuredDimension(resolveSize(kotlin.math.ceil(width).toInt(), widthMeasureSpec), resolveSize(dp(32f).roundToInt(), heightMeasureSpec))
        }

        override fun drawableStateChanged() {
            super.drawableStateChanged()
            invalidate()
        }

        override fun onDraw(canvas: Canvas) {
            (if (isPressed) pressedLook else normal).apply {
                setBounds(0, 0, width, height)
                draw(canvas)
            }
            // the box: 11 × 11 game pixels at 2 dp each
            val pixel = dp(2f).roundToInt().toFloat()
            val left = dp(8f).roundToInt().toFloat()
            val top = ((height - BOX * pixel) / 2f).roundToInt().toFloat()
            pixels.color = RSTheme.BLACK
            canvas.drawRect(left, top, left + BOX * pixel, top + BOX * pixel, pixels)
            pixels.color = RSTheme.STONE_DARK
            canvas.drawRect(left + pixel, top + pixel, left + (BOX - 1) * pixel, top + (BOX - 1) * pixel, pixels)
            if (on) {
                for ((colour, offset) in listOf(RSTheme.BLACK to 1, RSTheme.YELLOW to 0)) {
                    pixels.color = colour
                    for ((x, y) in TICK) {
                        val l = left + (x + offset) * pixel
                        val t = top + (y + offset) * pixel
                        canvas.drawRect(l, t, l + pixel, t + pixel, pixels)
                    }
                }
            }
            // the word, centred vertically like RSButton's title, with the hard shadow
            applyPaint()
            val x = (left + BOX * pixel + dp(6f)).roundToInt().toFloat()
            val metrics = paint.fontMetricsInt
            val boxHeight = metrics.descent - metrics.ascent + shadowPx
            val baseline = ((height - boxHeight) / 2f).roundToInt() - metrics.ascent.toFloat()
            paint.color = RSTheme.BLACK
            canvas.drawText(TITLE, x + shadowPx, baseline + shadowPx, paint)
            paint.color = if (on) RSTheme.YELLOW else RSTheme.WHITE
            canvas.drawText(TITLE, x, baseline, paint)
        }

        override fun onInitializeAccessibilityNodeInfo(info: android.view.accessibility.AccessibilityNodeInfo) {
            super.onInitializeAccessibilityNodeInfo(info)
            info.className = android.widget.CheckBox::class.java.name
            info.isCheckable = true
            info.isChecked = on
            info.hintText = "Keeps the password on this phone, encrypted, for the next login"
        }

        companion object {
            const val TITLE = "Remember"
            const val BOX = 11
            val TICK = listOf(2 to 5, 3 to 6, 4 to 7, 5 to 6, 6 to 5, 7 to 4, 8 to 3)
        }
    }

    /**
     * The input line: a dark inset in the stone (black at 55 %, a 1 dp dark stone border), the text in the game's font at
     * two game pixels per dp, cut at the head when it overflows (typing happens at the end), and the 2004 client's "*"
     * caret after it, blinking.
     */
    private class Field(context: Context) : ViewGroup(context) {
        private val density = resources.displayMetrics.density
        private val text = RSTextView(context)
        val textView: View get() = text
        private val caret = RSTextView(context)
        private val border = GradientDrawable().apply {
            setColor(0x8C000000.toInt())
            setStroke(density.roundToInt(), RSTheme.STONE_DARK)
        }
        private var blink: ObjectAnimator? = null
        private var flashAnimator: ValueAnimator? = null
        var shownText = ""
            private set

        init {
            id = R.id.kbd_field
            background = border
            text.apply {
                id = R.id.kbd_text
                font = RSTheme.Font.PLAIN12
                scale = 2f
                textColor = RSTheme.WHITE
                ellipsize = TextUtils.TruncateAt.START
                importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            }
            caret.apply {
                font = RSTheme.Font.PLAIN12
                scale = 2f
                textColor = RSTheme.YELLOW
                this.text = "*"
                importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            }
            addView(text)
            addView(caret)
            contentDescription = "Input"
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        }

        fun setText(shown: String, secure: Boolean, count: Int) {
            shownText = shown
            text.text = shown
            stateDescription = if (secure) "$count characters" else shown
            requestLayout()
            // ...and at once in the size it has: while the bar animates its chips (ChangeBounds), the bar's layout is
            // suppressed, and the line would show the previous text's width (an ellipsis) until the animation ends
            if (width > 0 && height > 0) {
                measureContent(width)
                layoutContent(height)
            }
        }

        private fun dp(value: Float) = (value * density).roundToInt()

        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val width = MeasureSpec.getSize(widthMeasureSpec)
            val height = MeasureSpec.getSize(heightMeasureSpec)
            measureContent(width)
            setMeasuredDimension(width, height)
        }

        private fun measureContent(width: Int) {
            val unspecified = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
            caret.measure(unspecified, unspecified)
            // 10 dp in, the caret 2 dp after the text and at most 10 dp from the end
            val room = max(0, width - dp(10f) - dp(2f) - caret.measuredWidth - dp(10f))
            text.measure(MeasureSpec.makeMeasureSpec(room, MeasureSpec.AT_MOST), unspecified)
        }

        override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) = layoutContent(b - t)

        private fun layoutContent(height: Int) {
            val middle = height / 2
            val x = dp(10f)
            val textTop = middle - text.measuredHeight / 2
            text.layout(x, textTop, x + text.measuredWidth, textTop + text.measuredHeight)
            val caretX = x + text.measuredWidth - shadowOf(text) + dp(2f)
            val caretTop = middle - caret.measuredHeight / 2
            caret.layout(caretX, caretTop, caretX + caret.measuredWidth, caretTop + caret.measuredHeight)
        }

        /** RSTextView's width includes its shadow; the caret follows the glyphs (iOS: the label's text, then 2 pt). */
        private fun shadowOf(view: RSTextView) = (view.scale * density).roundToInt()

        /** Opacity 1 → 0 over 0.5 s, back, forever, linear (iOS's CABasicAnimation). */
        fun restartBlink() {
            blink?.cancel()
            caret.alpha = 1f
            if (!isAttachedToWindow || !isShown) return
            blink = ObjectAnimator.ofFloat(caret, ALPHA, 1f, 0f).apply {
                duration = 500
                repeatMode = ValueAnimator.REVERSE
                repeatCount = ValueAnimator.INFINITE
                interpolator = LinearInterpolator()
                start()
            }
        }

        fun stopBlink() {
            blink?.cancel()
            blink = null
        }

        /** The border goes red → dark stone and 2 → 1 dp over 0.35 s, ease-in. */
        fun flash() {
            flashAnimator?.cancel()
            val colours = ArgbEvaluator()
            flashAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = 350
                interpolator = EASE_IN
                addUpdateListener { animation ->
                    val f = animation.animatedValue as Float
                    val width = (2f - f) * density
                    border.setStroke(width.roundToInt().coerceAtLeast(1), colours.evaluate(f, RSTheme.RED, RSTheme.STONE_DARK) as Int)
                }
                start()
            }
        }

        val isFlashing: Boolean get() = flashAnimator?.isRunning == true
    }

    companion object {
        const val HEIGHT_DP = KeyboardBridge.BAR_HEIGHT_DP
        const val CHIP_LIMIT_EMPTY = 0.45f
        const val CHIP_LIMIT_TYPING = 0.3f

        /** UIKit's default animation curve and CAMediaTimingFunction(.easeIn). */
        val EASE_IN_OUT = PathInterpolator(0.42f, 0f, 0.58f, 1f)
        val EASE_IN = PathInterpolator(0.42f, 0f, 1f, 1f)
    }
}
