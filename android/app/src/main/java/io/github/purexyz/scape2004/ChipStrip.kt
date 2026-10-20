// ChipStrip: the keyboard bar's row of chips (the private ChipStrip of ios/LostCity/KeyboardAccessoryBar.swift).
//
// The chips (RSButton, OPTION look) sit in a row with 6 dp between them, in a horizontal scroll view without scroll bars
// or overscroll. When the row does not fit, its edges fade out where there are more chips (the scroll view's fading
// edges: a true alpha fade, as iOS's gradient mask), and the visible part always ends inside a chip, a little short of
// the room it has if need be, so a cut chip shows there is more ([windowWidth]; the bar lays the strip out at that
// width). A chip lights up as soon as it is touched (children's pressed state is not delayed), and a drag that starts on
// a chip scrolls the row (the scroll view intercepts after the touch slop and cancels the chip's press).
package io.github.purexyz.scape2004

import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.view.View
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

class ChipStrip(context: Context) : HorizontalScrollView(context) {
    private val density = resources.displayMetrics.density
    private val spacing = (SPACING_DP * density).roundToInt()

    /** The chips, in order (GONE while hidden: a `whenEmpty` chip with text in the line). */
    val row = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = android.view.Gravity.CENTER_VERTICAL
        // the 6 dp between visible chips (a divider skips the GONE ones, as UIStackView skips hidden views)
        dividerDrawable = GradientDrawable().apply { setSize(spacing, 1) }
        showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE
    }

    init {
        isHorizontalScrollBarEnabled = false
        isVerticalScrollBarEnabled = false
        overScrollMode = View.OVER_SCROLL_NEVER
        isHorizontalFadingEdgeEnabled = true
        isFocusable = false
        isFocusableInTouchMode = false
        isFillViewport = false
        addView(row, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.MATCH_PARENT))
    }

    /** A chip lights up as soon as it is touched (iOS delaysContentTouches = false). */
    override fun shouldDelayChildPressedState(): Boolean = false

    fun scrollToStart() {
        scrollTo(0, 0)
    }

    /** The visible chips' extents in the row (px), measured: left and right of each. */
    private fun chipExtents(): List<IntArray> {
        val extents = ArrayList<IntArray>()
        var x = 0
        for (i in 0 until row.childCount) {
            val chip = row.getChildAt(i)
            if (chip.visibility == View.GONE) continue
            if (extents.isNotEmpty()) x += spacing
            extents.add(intArrayOf(x, x + chip.measuredWidth))
            x += chip.measuredWidth
        }
        return extents
    }

    /** The row's natural width (px) once measured: what the strip needs to show every chip. */
    val contentWidth: Int get() = chipExtents().lastOrNull()?.get(1) ?: 0

    /**
     * `room`, or less when the row overflows and the chip at that edge would barely show (or the edge falls between two
     * chips): then the window ends 14 dp inside the chip before it (at least 24 dp into it).
     */
    fun windowWidth(room: Int): Int {
        val chips = chipExtents()
        val total = chips.lastOrNull()?.get(1) ?: 0
        if (total <= room) return room
        val next = chips.indexOfFirst { it[1] > room }
        if (next <= 0 || room - chips[next][0] >= dp(14f)) return room
        val previous = chips[next - 1]
        return max(previous[0] + dp(24f), previous[1] - dp(14f)).let { min(it, room) }
    }

    private fun dp(value: Float) = (value * density).roundToInt()

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        // the fade's length: 16 dp, or a quarter of a narrow strip
        setFadingEdgeLength(min(dp(16f), w / 4))
    }

    /** Each end fades only where more chips lie past it. */
    override fun getLeftFadingEdgeStrength(): Float = if (scrollX > 0) 1f else 0f

    override fun getRightFadingEdgeStrength(): Float {
        val content = row.width
        return if (content > width && scrollX + width < content) 1f else 0f
    }

    companion object {
        const val SPACING_DP = 6f
    }
}
