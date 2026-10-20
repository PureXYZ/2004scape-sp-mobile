// RSTextView: a text label in the game's look, the native views' counterpart of the page's game text (the labels and
// button titles of RSTheme.swift: a game font, a colour, the hard black shadow one game pixel down and right).
//
// It is a plain View that lays its text out with StaticLayout and draws it itself, twice: once in black, offset by one
// game pixel, then in its colour. Android's own text shadow cannot do that: setShadowLayer with a radius of 0 draws no
// shadow, and any radius above 0 blurs (the 2004 shadow is hard), and redrawing a TextView in another colour from onDraw
// would invalidate it every frame.
//
// Sizes are dp: `scale` game pixels per dp (1 = the page's 1:1; the loading cover draws its title at 2), the text size
// is RSTheme.textSizePx (16 px per game pixel), never sp. Text is passed through RSTheme.gameText.
package io.github.purexyz.scape2004

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.view.View
import kotlin.math.ceil
import kotlin.math.roundToInt

class RSTextView(context: Context) : View(context) {
    private val density = resources.displayMetrics.density
    private val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        isSubpixelText = false
        hinting = Paint.HINTING_OFF // glyphs as Chromium/Skia draws them on the page
    }
    private var layout: StaticLayout? = null
    private var layoutWidth = -1

    var text: String = ""
        set(value) {
            val game = RSTheme.gameText(value)
            if (field == game) return
            field = game
            contentDescription = game
            changed()
        }

    var font: RSTheme.Font = RSTheme.Font.PLAIN12
        set(value) {
            field = value
            changed()
        }

    /** Game pixels per dp. */
    var scale: Float = 1f
        set(value) {
            field = value
            changed()
        }

    var textColor: Int = RSTheme.WHITE
        set(value) {
            field = value
            invalidate()
        }

    /** The hard black shadow, one game pixel (× scale) down and right. */
    var shadow: Boolean = true
        set(value) {
            field = value
            changed()
        }

    var alignment: Layout.Alignment = Layout.Alignment.ALIGN_NORMAL
        set(value) {
            field = value
            changed()
        }

    var maxLines: Int = 1
        set(value) {
            field = value
            changed()
        }

    /** Where a line that does not fit is cut (END: "abc…", START: "…xyz"); null wraps or clips. */
    var ellipsize: TextUtils.TruncateAt? = TextUtils.TruncateAt.END
        set(value) {
            field = value
            changed()
        }

    /** The line height in dp; null: the font's own (16 × scale for Plain 12 and Bold 12). */
    var lineHeightDp: Float? = null
        set(value) {
            field = value
            changed()
        }

    /** The widest the view measures itself (px), besides what its parent allows. */
    var maxWidthPx: Int = Int.MAX_VALUE
        set(value) {
            field = value
            changed()
        }

    private val shadowPx: Int get() = if (shadow) (scale * density).roundToInt() else 0

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    }

    private fun changed() {
        layout = null
        requestLayout()
        invalidate()
    }

    private fun applyPaint() {
        paint.typeface = RSTheme.typeface(font)
        paint.textSize = RSTheme.textSizePx(font, scale, density)
        paint.color = textColor
    }

    private fun build(width: Int): StaticLayout {
        applyPaint()
        val metrics = paint.fontMetricsInt
        val natural = metrics.descent - metrics.ascent
        val extra = lineHeightDp?.let { (it * density).roundToInt() - natural } ?: 0
        val builder = StaticLayout.Builder.obtain(text, 0, text.length, paint, maxOf(1, width))
            .setAlignment(alignment)
            .setIncludePad(false)
            .setLineSpacing(extra.toFloat(), 1f)
            .setMaxLines(maxLines)
        ellipsize?.let { builder.setEllipsize(it) }
        return builder.build().also {
            layout = it
            layoutWidth = width
        }
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        applyPaint()
        val desired = ceil(Layout.getDesiredWidth(text, paint)).toInt() + shadowPx + paddingLeft + paddingRight
        val widthMode = MeasureSpec.getMode(widthMeasureSpec)
        val widthSize = MeasureSpec.getSize(widthMeasureSpec)
        val width = when (widthMode) {
            MeasureSpec.EXACTLY -> widthSize
            MeasureSpec.AT_MOST -> minOf(desired, widthSize, maxWidthPx)
            else -> minOf(desired, maxWidthPx)
        }.coerceAtLeast(suggestedMinimumWidth)
        val textWidth = width - paddingLeft - paddingRight - shadowPx
        val built = build(textWidth)
        val desiredHeight = built.height + shadowPx + paddingTop + paddingBottom
        val height = resolveSize(maxOf(desiredHeight, suggestedMinimumHeight), heightMeasureSpec)
        setMeasuredDimension(width, height)
    }

    override fun onDraw(canvas: Canvas) {
        val textWidth = width - paddingLeft - paddingRight - shadowPx
        val built = layout?.takeIf { layoutWidth == textWidth } ?: build(textWidth)
        // vertically centred in whatever height the view was given
        val top = paddingTop + maxOf(0, (height - paddingTop - paddingBottom - shadowPx - built.height) / 2)
        canvas.save()
        canvas.translate(paddingLeft.toFloat(), top.toFloat())
        if (shadow) {
            canvas.save()
            canvas.translate(shadowPx.toFloat(), shadowPx.toFloat())
            paint.color = RSTheme.BLACK
            built.draw(canvas)
            canvas.restore()
        }
        paint.color = textColor
        built.draw(canvas)
        canvas.restore()
    }
}
