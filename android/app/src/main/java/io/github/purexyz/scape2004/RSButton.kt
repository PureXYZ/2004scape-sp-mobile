// RSButton: a 2004 interface button for the keyboard bar (the UIButton configurations of ios/LostCity/KeyboardAccessoryBar.swift
// and RSTheme.swift's buttonConfiguration/buttonTitle).
//
// Two looks, both stretched sprites drawn with nearest-neighbour sampling (StretchDrawable):
// * STONE: Cancel, the submit button and the hide button: `miscgraphics-0` over 5 px caps, 25 % brighter while pressed
//   (the page's `.stone-btn`), its title in Bold 12, white, with the hard shadow;
// * OPTION: a chip, the Game Options tab's small button (`miscgraphics3-0`, red `-1` while pressed), its title in Plain 12,
//   white, yellow while pressed, cut at the tail when it does not fit.
//
// It is a plain View that draws its title itself (the hard 2004 shadow, as RSTextView) or an icon (the hide button's
// chevron). Sizes are dp: `insets` around the title as UIButton's contentInsets, `heightDp` fixed, the width the title's
// plus the insets, between `minWidthDp` and `maxWidthDp`. The pressed look shows at once (no tap-timeout delay: the chip
// strip does not delay its children's pressed state), and a tap runs `onTap`.
package io.github.purexyz.scape2004

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.drawable.Drawable
import android.text.TextPaint
import android.text.TextUtils
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Button
import kotlin.math.ceil
import kotlin.math.roundToInt

class RSButton(context: Context) : View(context) {
    enum class Look { STONE, OPTION }

    private val density = resources.displayMetrics.density
    private val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        isSubpixelText = false
        hinting = Paint.HINTING_OFF // glyphs as Chromium/Skia draws them on the page
    }
    private var normal: Drawable? = null
    private var pressedLook: Drawable? = null

    var look: Look = Look.STONE
        set(value) {
            field = value
            normal = null
            pressedLook = null
            changed()
        }

    var title: String = ""
        set(value) {
            val game = RSTheme.gameText(value)
            if (field == game) return
            field = game
            changed()
        }

    var font: RSTheme.Font = RSTheme.Font.BOLD12
        set(value) {
            field = value
            changed()
        }

    var titleColor: Int = RSTheme.WHITE
    var pressedTitleColor: Int = RSTheme.WHITE

    /** Draws the icon in its box (left, top in px); `iconWidthDp`/`iconHeightDp` give its size. Null: the title. */
    var icon: ((canvas: Canvas, left: Float, top: Float) -> Unit)? = null
    var iconWidthDp = 0f
    var iconHeightDp = 0f

    /** UIButton contentInsets (dp): top, leading, bottom, trailing. */
    var insetTop = 6f
    var insetLeading = 12f
    var insetBottom = 6f
    var insetTrailing = 12f
    var heightDp = 36f
    var minWidthDp = 0f
    var maxWidthDp = Float.MAX_VALUE

    /** For TalkBack: what the button is (iOS accessibilityLabel; the title when null) and does (accessibilityHint). */
    var accessibilityLabel: String? = null
        set(value) {
            field = value
            contentDescription = value ?: title
        }
    var hint: String? = null

    var onTap: (() -> Unit)? = null

    init {
        isClickable = true
        isFocusable = false // the keyboard bridge keeps input focus; a button never takes it
        isFocusableInTouchMode = false
        isSoundEffectsEnabled = false // UIKit buttons make no sound
        isHapticFeedbackEnabled = false
        setOnClickListener { onTap?.invoke() }
    }

    private fun changed() {
        contentDescription = accessibilityLabel ?: title
        requestLayout()
        invalidate()
    }

    private fun dp(value: Float) = value * density

    private fun applyPaint() {
        paint.typeface = RSTheme.typeface(font)
        paint.textSize = RSTheme.textSizePx(font, 1f, density)
    }

    /** The title's width (px) with its shadow. */
    private fun titleWidth(): Float {
        applyPaint()
        return paint.measureText(title) + shadowPx
    }

    private val shadowPx: Float get() = density.roundToInt().toFloat()

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val content = if (icon != null) dp(iconWidthDp) else titleWidth()
        val natural = ceil(content + dp(insetLeading) + dp(insetTrailing)).toInt()
        val bounded = natural.coerceIn(dp(minWidthDp).roundToInt(), if (maxWidthDp == Float.MAX_VALUE) Int.MAX_VALUE else dp(maxWidthDp).roundToInt())
        val width = resolveSize(bounded, widthMeasureSpec)
        val height = resolveSize(dp(heightDp).roundToInt(), heightMeasureSpec)
        setMeasuredDimension(width, height)
    }

    private fun background(pressed: Boolean): Drawable {
        val cached = if (pressed) pressedLook else normal
        if (cached != null) return cached
        val made = when (look) {
            Look.STONE -> RSTheme.buttonImage(pressed = pressed, density = density)
            Look.OPTION -> RSTheme.optionButtonImage(on = pressed, density = density)
        }
        if (pressed) pressedLook = made else normal = made
        return made
    }

    override fun drawableStateChanged() {
        super.drawableStateChanged()
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val pressed = isPressed
        background(pressed).apply {
            setBounds(0, 0, width, height)
            draw(canvas)
        }
        val drawIcon = icon
        if (drawIcon != null) {
            // centred in the box the insets leave (top/bottom insets are equal on every button here)
            val left = ((width - dp(iconWidthDp)) / 2f).roundToInt().toFloat()
            val top = ((height - dp(iconHeightDp)) / 2f).roundToInt().toFloat()
            drawIcon(canvas, left, top)
            return
        }
        applyPaint()
        val room = width - dp(insetLeading) - dp(insetTrailing) - shadowPx
        val text = if (paint.measureText(title) > room) TextUtils.ellipsize(title, paint, room, TextUtils.TruncateAt.END).toString() else title
        val textWidth = paint.measureText(text) + shadowPx
        // centred like UIButton's title; the baseline puts the font's box (ascent + descent) in the middle
        val x = ((width - textWidth) / 2f).roundToInt().toFloat()
        val metrics = paint.fontMetricsInt
        val boxHeight = metrics.descent - metrics.ascent + shadowPx
        val baseline = ((height - boxHeight) / 2f).roundToInt() - metrics.ascent.toFloat()
        paint.color = RSTheme.BLACK
        canvas.drawText(text, x + shadowPx, baseline + shadowPx, paint)
        paint.color = if (pressed) pressedTitleColor else titleColor
        canvas.drawText(text, x, baseline, paint)
    }

    override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
        super.onInitializeAccessibilityNodeInfo(info)
        info.className = Button::class.java.name
        hint?.let { info.hintText = it }
    }

    companion object {
        /**
         * The hide button's chevron, drawn in game pixels at 2 dp per pixel on an 11×7 grid: a one-pixel yellow V with a
         * black outline, like the HUD's (KeyboardAccessoryBar.swift chevronImage).
         */
        fun chevron(density: Float): (Canvas, Float, Float) -> Unit {
            val pixel = 2f * density
            val black = Paint().apply { color = RSTheme.BLACK; isAntiAlias = false }
            val yellow = Paint().apply { color = RSTheme.YELLOW; isAntiAlias = false }
            val points = listOf(1 to 1, 2 to 2, 3 to 3, 4 to 4, 5 to 5, 6 to 4, 7 to 3, 8 to 2, 9 to 1)
            return { canvas, left, top ->
                for ((x, y) in points) {
                    val l = left + (x - 1) * pixel
                    val t = top + (y - 1) * pixel
                    canvas.drawRect(l, t, l + 3 * pixel, t + 3 * pixel, black)
                }
                for ((x, y) in points) {
                    val l = left + x * pixel
                    val t = top + y * pixel
                    canvas.drawRect(l, t, l + pixel, t + pixel, yellow)
                }
            }
        }

        const val CHEVRON_WIDTH_DP = 22f // 11 game px × 2
        const val CHEVRON_HEIGHT_DP = 14f // 7 game px × 2
    }
}
