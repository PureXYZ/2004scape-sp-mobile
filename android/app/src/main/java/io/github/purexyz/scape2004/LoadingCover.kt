// LoadingCover: native's cover in the page's own look, a pixel copy of the page's 2004 loader, its error screen and the
// notices (ports ios/LostCity/LoadingOverlay.swift and its Notice; docs/ANDROID.md §1 Pixels, §3.3 `loader-drawn`,
// §4 "Shell: the loading cover"). Cover.kt's CoverController keeps the state; this is the view
// GameSession.coverViewFactory makes for each activity.
//
// * The loader is web/host/index.html's `#loading` with host.css's geometry, drawn by hand with RSTheme: the RuneScape
//   logo (ui/sprites/logo.png, 444 × 142, at most 80 % of the width, nearest-neighbour), 18 below it the 304 × 34 bar
//   (a 2 px #8c1111 border, the #8c1111 fill at the 6 % the page's loader starts from, "Loading - please wait." in RS
//   Bold 12, white, the hard shadow), 12 below that "2004Scape · November 2004 · offline" in RS Plain 11, #75a9a9, the
//   card centred in the overlay's box (10 px top and bottom, 12 px + the safe area at the sides).
// * At the page's zoom, which CoverGeometry computes as host.js layout() does from the same numbers (the view's size in
//   CSS px = dp, the display cutout's safe area, the density as the device pixel ratio): ×2 or ×1.5 on a tall screen,
//   then the crisp pixel snap at a fractional ratio (snapZoom: 2.625 → 8/7, 3 device px per game px). Every length is
//   placed as Chromium places the page's: laid out and rounded in the page's layout px, then drawn (CoverGeometry.loader
//   below; with the snap the page's layer is CSS-zoomed, so its layout px are device px and every edge is whole), so the
//   hand-over to the page's loader changes no pixel of the bar and its text (android/test/shell.mjs `cover` compares the
//   two and reports what differs).
// * The cover goes when the page posts {type:'loader-drawn'} (its fonts loaded, its logo decoded, two frames drawn), or
//   3 s after the page loaded at the latest (GameSession's fallback), fading out over 0.25 s, as on iOS. The system's
//   launch screen (Android 12+) is plain black with no icon (res/values-v31/themes.xml) and gives way to this cover at
//   the activity's first frame, as the iOS launch screen gives way to LoadingOverlay.
// * The error screen (only when there is no page to show one: the game could not be loaded, the renderer keeps
//   crashing, the WebView is too old) is the page's `#error`: "Error - unable to continue!" in yellow RS Bold 12 at
//   twice the size, the message in RS Plain 12 on 18 px lines (8 at most), the title-screen button ("Try again",
//   "Update"), all at the zoom; real views, so TalkBack and the tests (uiautomator: id cover_retry) find them.
// * Notices: RS Plain 12 in yellow with the shadow on black at 0.8 with a 1 px #5d5447 border, padded 10/16, centred
//   14 px below the safe area's top, at most 80 % of its width; in for 0.2 s, out over 0.4 s after 3.5 s. They use the
//   crisp snap's scale (3 device px per game px on a 2.625 phone, as an iPhone's 3x), never the tablet zoom (iOS's
//   notices are not zoomed on an iPad either).
package io.github.purexyz.scape2004

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.text.Layout
import android.text.TextPaint
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.accessibility.AccessibilityEvent
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** The page's zoom and the cover's frames, in CSS px (= dp). Pure, so CoverGeometryTest checks it against host.js. */
object CoverGeometry {
    /** HUD px: the iPhone SE, the narrowest phone the HUD is laid out for (host.js HUD_MIN_WIDTH). */
    const val HUD_MIN_WIDTH = 667.0

    /** HUD px: the smallest screen the HUD is tested at; the snap never leaves less (host.js HUD_SNAP_MIN). */
    const val SNAP_MIN_WIDTH = 568.0
    const val SNAP_MIN_HEIGHT = 320.0

    /** Where the page's loader starts (host.js showLoaderProgress: 0.06 + 0.94 × progress), so it never runs backwards. */
    const val PROGRESS = 0.06

    data class Edges(val left: Double = 0.0, val top: Double = 0.0, val right: Double = 0.0, val bottom: Double = 0.0)

    data class Box(val x: Double, val y: Double, val w: Double, val h: Double) {
        val right: Double get() = x + w
        val bottom: Double get() = y + h
        fun json(): JsonArray = JsonArray(listOf(x, y, w, h).map { JsonPrimitive(it) })
    }

    /** JavaScript's Math.round (half up). */
    fun jsRound(value: Double): Double = floor(value + 0.5)

    /** host.js layout()'s zoom before the snap: ×2 or ×1.5 where the height allows and the HUD keeps 667 px, else 1. */
    fun baseZoom(vw: Double, vh: Double, safe: Edges): Double {
        val heightZoom = if (vh >= 720) 2.0 else if (vh >= 540) 1.5 else 1.0
        return listOf(2.0, 1.5).firstOrNull { it <= heightZoom && (vw - safe.left - safe.right) / it >= HUD_MIN_WIDTH } ?: 1.0
    }

    /**
     * host.js snapZoom: a whole number of device px per HUD px at a fractional ratio, where the HUD keeps its room; never
     * rounded down where the next whole number has no room (a larger Display size keeps the zoom it asks for).
     */
    fun snapZoom(zoom: Double, dpr: Double, room: Double, vh: Double): Double {
        if (!(dpr > 0) || dpr == floor(dpr)) return zoom
        val minWidth = if (zoom > 1) HUD_MIN_WIDTH else SNAP_MIN_WIDTH
        fun fits(px: Double) = px > 0 && room / (px / dpr) >= minWidth && vh / (px / dpr) >= SNAP_MIN_HEIGHT
        val px = jsRound(dpr * zoom)
        if (px < dpr * zoom && !fits(px + 1)) return zoom
        return if (fits(px)) px / dpr else zoom
    }

    /** The zoom host.js layout() gives a page of innerWidth `vw` × innerHeight `vh` with this safe area and ratio. */
    fun pageZoom(vw: Double, vh: Double, safe: Edges, dpr: Double): Double =
        snapZoom(baseZoom(vw, vh, safe), dpr, vw - safe.left - safe.right, vh)

    /** window.innerWidth/innerHeight for a WebView `px` device px wide at `dpr`: whole CSS px, the fraction dropped. */
    fun innerSize(px: Int, dpr: Double): Double = floor(px / dpr + 1e-6)

    /**
     * The overlay's content box (`.overlay`: padding 10 + the safe area at the top and bottom and 12 + the safe area at
     * the sides, scaled with the layer by the zoom).
     */
    fun content(width: Double, height: Double, safe: Edges, z: Double): Box =
        Box((12 + safe.left) * z, (10 + safe.top) * z, width - (24 + safe.left + safe.right) * z, height - (20 + safe.top + safe.bottom) * z)

    /**
     * host.js readSafeArea: the display cutout (CSS px) with Settings › Display's margins: the sides equal, the larger
     * of the two plus the side margin (0 at None); the top and the bottom the cutout's (a curved edge's) plus the top and
     * bottom margins (0 at None).
     */
    fun pageSafe(cutout: Edges, margins: CoverMargins): Edges {
        val side = if (margins.sides < 0) 0.0 else max(cutout.left, cutout.right) + margins.sides
        val top = if (margins.top < 0) 0.0 else cutout.top + margins.top
        val bottom = if (margins.bottom < 0) 0.0 else cutout.bottom + margins.bottom
        return Edges(side, top, side, bottom)
    }

    // ------------------------------------------------------------------------------------------------ the loader
    //
    // Chromium lays the page's #loading out in "layout px" (LayoutUnits of 1/64 px), rounds each box's edges to whole
    // layout px and floors border widths, then paints. Two cases:
    // * With the crisp pixel snap (a fractional ratio and a zoom: host.css html.ui-snapped) the layer is CSS-zoomed, so
    //   it is laid out at its final scale: a layout px is a device px (CSS px × zoom × ratio, 3 at 2.625 with 8/7), the
    //   layer is the viewport, and every box edge and baseline lands on a whole device px (measured on the emulator with
    //   WebView 145: android/test/shell.mjs `cover`, android/test/crisp.mjs).
    // * Otherwise (a tablet's ×1.5 or ×2 at a whole ratio, host.css html.ui-zoomed) the layer is `scale(zoom)`d from its
    //   top left: laid out at the viewport's size ÷ zoom in layout px of CSS px × the ratio, then painted with the zoom,
    //   anti-aliased (an edge at layout px 606 at a zoom of 8/7 would land at device px 692.57). With no zoom both agree.
    // Text: the baseline from Blink's rounded font metrics (with its Android rule that moves a unit from the ascent to a
    // rounded-down descent) and line-box leading (the half above floored), rounded to a whole layout px, then to a
    // device px when painted; horizontally the glyphs keep their fraction (Skia's subpixel positioning). The cover
    // computes the same numbers and draws them the same way, so the two match pixel for pixel where Chromium and
    // Android's Skia rasterise alike.

    /** A font's ascent and descent per em (RS Bold 12: 0.75 and 0.25; RS Plain 11: 0.625 and 0.125). */
    data class FontShape(val ascent: Double, val descent: Double)

    /** A rectangle in device px, fractional where the page's is (both are drawn anti-aliased). */
    data class Area(val left: Double, val top: Double, val right: Double, val bottom: Double) {
        fun json(scale: Double): JsonArray = JsonArray(listOf(left, top, right - left, bottom - top).map { JsonPrimitive(it / scale) })
    }

    /** A line of text in device px: where its baseline starts, its size, and its hard shadow's origin. */
    data class Line(val x: Double, val baseline: Double, val size: Double, val shadowX: Double, val shadowBaseline: Double)

    data class Loader(val zoom: Double, val logo: Area, val bar: Area, val inside: Area, val fill: Area, val text: Line, val caption: Line)

    /** Blink's LayoutUnit: 1/64 px, truncated toward zero (a hair outward first: 2099.9999 from a float division is 2100). */
    fun lu(value: Double): Double {
        val raw = value * 64
        return (if (raw >= 0) floor(raw + 1e-6) else ceil(raw - 1e-6)) / 64.0
    }

    /** A text width as Blink sizes its box: up to the next 1/64 px. */
    fun luCeil(value: Double): Double = ceil(value * 64 - 1e-6) / 64.0

    /** Half a LayoutUnit length (flex centring), truncated to 1/64. */
    fun half(value: Double): Double = lu(value / 2)

    /** LayoutUnit::Round, Skia's rounding: halves up. */
    fun round(value: Double): Double = floor(value + 0.5)

    /** Blink's ascent and descent at `size` layout px: rounded, a unit moved from the ascent to a rounded-down descent. */
    fun metrics(font: FontShape, size: Double): Pair<Double, Double> {
        var ascent = round(font.ascent * size)
        var descent = round(font.descent * size)
        if (descent < font.descent * size && ascent >= 1) {
            descent += 1
            ascent -= 1
        }
        return ascent to descent
    }

    /** The baseline of a line box at `top`, `lineHeight` tall, in layout px: half the leading above (floored). */
    fun baseline(top: Double, lineHeight: Double, font: FontShape, size: Double): Double {
        val (ascent, descent) = metrics(font, size)
        return top + floor(half(lineHeight - ascent - descent)) + ascent
    }

    /**
     * The loader for a WebView `widthPx` × `heightPx` device px at `dpr`, the safe area in CSS px, the page's `zoom`;
     * `textAdvance` and `captionAdvance` are the two lines' widths in game px (CSS px at the 16 px font size).
     */
    fun loader(
        widthPx: Int, heightPx: Int, safe: Edges, dpr: Double, zoom: Double, textAdvance: Double, captionAdvance: Double,
        bold: FontShape = FontShape(0.75, 0.25), small: FontShape = FontShape(0.625, 0.125), logoWidth: Int = 444, logoHeight: Int = 142,
    ): Loader {
        // host.css html.ui-snapped: the layer is CSS-zoomed (laid out at its final scale) rather than scaled up
        val snapped = zoom != 1.0 && dpr != floor(dpr)
        val d = if (snapped) dpr * zoom else dpr // layout px per CSS px
        val paint = if (snapped) 1.0 else zoom // device px per layout px
        fun css(px: Double) = lu(px * d)
        // the layer: the viewport (÷ zoom when it is scaled up); `.overlay`'s padding: 10px + the safe area at the top
        // and bottom, 12px + the safe area at the sides
        val layerW = if (snapped) widthPx.toDouble() else lu(widthPx / zoom)
        val layerH = if (snapped) heightPx.toDouble() else lu(heightPx / zoom)
        val padL = lu((12 + safe.left) * d)
        val padR = lu((12 + safe.right) * d)
        val padT = lu((10 + safe.top) * d)
        val padB = lu((10 + safe.bottom) * d)
        val contentW = layerW - padL - padR
        val contentH = layerH - padT - padB
        // the card: logo 142, 18, bar 34, 12, caption 12 (a column, centred both ways, its items centred across)
        val logoW = lu(min(444 * d, 0.8 * widthPx * (if (snapped) zoom else 1.0))) // `max-width: 80vw` (zoomed with the layer)
        val logoH = css(142.0)
        val barW = css(304.0)
        val barH = css(34.0)
        val captionW = luCeil(captionAdvance * d)
        val cardW = max(max(logoW, barW), captionW)
        val cardH = logoH + css(18.0) + barH + css(12.0) + css(12.0)
        val cardX = padL + half(contentW - cardW)
        val cardY = padT + half(contentH - cardH)
        val logoX = cardX + half(cardW - logoW)
        val barX = cardX + half(cardW - barW)
        val barY = cardY + logoH + css(18.0)
        val captionX = cardX + half(cardW - captionW)
        val captionY = barY + barH + css(12.0)
        // painted: edges rounded to layout px, then scaled up (only when the layer is)
        fun area(x0: Double, y0: Double, x1: Double, y1: Double) = Area(round(x0) * paint, round(y0) * paint, round(x1) * paint, round(y1) * paint)
        // the logo, `background: center / contain` in its snapped box (a tile within half a px of the box fills it)
        val boxL = round(logoX)
        val boxT = round(cardY)
        val boxW = round(logoX + logoW) - boxL
        val boxH = round(cardY + logoH) - boxT
        val fit = min(boxW / logoWidth, boxH / logoHeight)
        val tileW = (logoWidth * fit).let { if (kotlin.math.abs(it - boxW) <= 0.5) boxW else it }
        val tileH = (logoHeight * fit).let { if (kotlin.math.abs(it - boxH) <= 0.5) boxH else it }
        val tileL = boxL + (boxW - tileW) / 2
        val tileT = boxT + (boxH - tileH) / 2
        val logo = Area(tileL * paint, tileT * paint, (tileL + tileW) * paint, (tileT + tileH) * paint)
        // the bar: a 2px border (floored to whole layout px, at least 1: 5 at 2.625, 6 with the snap), the fill 6 % of
        // the padding box from its left
        val border = max(1.0, floor(2 * d + 1e-6))
        val bar = area(barX, barY, barX + barW, barY + barH)
        val inside = Area(bar.left + border * paint, bar.top + border * paint, bar.right - border * paint, bar.bottom - border * paint)
        val padX = barX + border
        val padY = barY + border
        val padW = barW - 2 * border
        val padH = barH - 2 * border
        val fill = area(padX, padY, padX + lu(padW * PROGRESS), padY + padH)
        // the bar's text: centred both ways in the padding box, a 16px line of RS Bold 12 with a 1px shadow
        val textW = luCeil(textAdvance * d)
        val textLine = css(16.0)
        val text = line(padX + half(padW - textW), padY + half(padH - textLine), textLine, bold, css(16.0), paint, shadow = d)
        // the caption: RS Plain 11 at 16px on a 12px line, no shadow
        val caption = line(captionX, captionY, css(12.0), small, css(16.0), paint, shadow = 0.0)
        return Loader(zoom, logo, bar, inside, fill, text, caption)
    }

    private fun line(x: Double, top: Double, lineHeight: Double, font: FontShape, size: Double, paint: Double, shadow: Double): Line {
        val base = round(baseline(top, lineHeight, font, size))
        return Line(x * paint, round(base * paint), size * paint, (x + shadow) * paint, round((base + shadow) * paint))
    }

    /** The error screen's frames (`.error-panel`, at most 520 wide: title 32, 12, text, 16, button 41). */
    data class Error(val title: Box, val text: Box, val button: Box)

    fun error(width: Double, height: Double, safe: Edges, z: Double, titleAdvance: Double, textHeight: (Double) -> Double, buttonIntrinsic: Double): Error {
        val box = content(width, height, safe, z)
        val panel = min(520 * z, box.w)
        val text = textHeight(panel)
        val titleWidth = min(panel, titleAdvance)
        val buttonWidth = max(147 * z, buttonIntrinsic)
        val total = (32 + 12 + 16 + 41) * z + text
        val top = box.y + max(0.0, (box.h - total) / 2)
        val middle = box.x + box.w / 2
        return Error(
            Box(middle - titleWidth / 2, top, titleWidth, 32 * z),
            Box(middle - panel / 2, top + 44 * z, panel, text),
            Box(middle - buttonWidth / 2, top + 60 * z + text, buttonWidth, 41 * z),
        )
    }

    /**
     * An error screen frame in device px (`scale` device px per CSS px): edges rounded, halves away from zero; for text
     * the left edge rounds a half pixel down (LoadingOverlay.swift's rule). The error screen is native's own (the page is
     * not there to hand over to), so iOS's rule is enough.
     */
    fun snap(box: Box, scale: Double, text: Boolean = false): Rect {
        fun round(value: Double): Int = if (value >= 0) floor(value * scale + 0.5).toInt() else -floor(-value * scale + 0.5).toInt()
        val x = if (text) ceil(box.x * scale - 0.5).toInt() else round(box.x)
        val y = round(box.y)
        val right = if (text) x + round(box.w) else round(box.right)
        return Rect(x, y, right, round(box.bottom))
    }
}

/** The cover view: the loader drawn in onDraw, the error screen as views, notices on top. UI thread. */
class LoadingCover(context: Context) : ViewGroup(context), CoverView {
    override val view: View get() = this

    private val density = resources.displayMetrics.density.toDouble()
    private var shownState: CoverState = CoverState.Hidden
    private var action: (() -> Unit)? = null
    private var zoom = 1.0
    private var styledZoom = -1.0
    private var safe = CoverGeometry.Edges()
    private var margins = CoverMargins()
    private var loader: CoverGeometry.Loader? = null
    private var errorFrames: CoverGeometry.Error? = null

    private val logo: Bitmap? = RSTheme.sprite("logo")
    private val nearest = RSTheme.nearestPaint().apply { isAntiAlias = true } // (edges as Skia's: covered fractions)
    private val fill = Paint().apply { isAntiAlias = true } // (a scaled-up layer's boxes land between device px, anti-aliased)
    private val barText = textPaint(RSTheme.Font.BOLD12)
    private val caption = textPaint(RSTheme.Font.PLAIN11)
    private val fallbackLogo = textPaint(RSTheme.Font.BOLD12)
    private val rect = RectF()

    /** The fallback logo's text size (twice the bar's), set with the frames (no allocation in onDraw). */
    private var fallbackLine: CoverGeometry.Line? = null

    private val errorTitle = RSTextView(context)
    private val errorText = RSTextView(context)
    private val retry = RSTextView(context)

    init {
        id = R.id.cover
        setWillNotDraw(false)
        setBackgroundColor(RSTheme.BLACK)
        isClickable = true // swallows the page's touches while it shows
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        errorTitle.apply {
            text = "Error - unable to continue!"
            font = RSTheme.Font.BOLD12
            textColor = RSTheme.YELLOW
            alignment = Layout.Alignment.ALIGN_CENTER
        }
        errorText.apply {
            font = RSTheme.Font.PLAIN12
            textColor = RSTheme.WHITE
            alignment = Layout.Alignment.ALIGN_CENTER
            maxLines = 8 // wraps by word; a ninth line would end in "..."
            ellipsize = TextUtils.TruncateAt.END
        }
        retry.apply {
            id = R.id.cover_retry
            font = RSTheme.Font.BOLD12
            textColor = RSTheme.WHITE
            alignment = Layout.Alignment.ALIGN_CENTER
            isClickable = true
            isFocusable = true
            setOnClickListener {
                val run = action
                action = null
                run?.invoke()
            }
        }
        for (child in listOf(errorTitle, errorText, retry)) {
            child.visibility = GONE
            addView(child)
        }
        visibility = GONE
    }

    // ------------------------------------------------------------------------------------------------ state

    override fun render(state: CoverState, animated: Boolean) {
        shownState = state
        animate().cancel()
        when (state) {
            CoverState.Hidden -> {
                action = null
                isClickable = false
                if (animated && visibility == VISIBLE) {
                    animate().alpha(0f).setDuration(FADE_MS).setListener(object : AnimatorListenerAdapter() {
                        override fun onAnimationEnd(animation: Animator) {
                            if (shownState == CoverState.Hidden) visibility = GONE
                        }
                    })
                } else {
                    visibility = GONE
                }
            }
            CoverState.Loading -> {
                action = null
                accessibilityPaneTitle = null
                contentDescription = "RuneScape. ${LOADING_TEXT}"
                setError(false)
                appear()
            }
            is CoverState.Error -> {
                errorText.text = state.message
                retry.text = state.button
                action = state.action
                contentDescription = null
                setError(true)
                appear()
                // (a pane title change is announced, as iOS posts screenChanged to the title)
                accessibilityPaneTitle = "Error - unable to continue! ${state.message}"
                errorTitle.sendAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_FOCUSED)
            }
        }
    }

    private fun appear() {
        alpha = 1f
        visibility = VISIBLE
        isClickable = true
        requestLayout()
        invalidate()
    }

    private fun setError(error: Boolean) {
        for (child in listOf(errorTitle, errorText, retry)) child.visibility = if (error) VISIBLE else GONE
    }

    // ------------------------------------------------------------------------------------------------ layout

    override fun onApplyWindowInsets(insets: WindowInsets): WindowInsets {
        requestLayout()
        return super.onApplyWindowInsets(insets)
    }

    override fun margins(margins: CoverMargins) {
        if (margins == this.margins) return
        this.margins = margins
        requestLayout()
        invalidate()
    }

    /** The display cutout in CSS px (dp): env(safe-area-inset-*) in WebView 145. */
    private fun cutoutEdges(of: View): CoverGeometry.Edges {
        val cutout = ViewCompat.getRootWindowInsets(of)?.getInsets(WindowInsetsCompat.Type.displayCutout()) ?: return CoverGeometry.Edges()
        return CoverGeometry.Edges(cutout.left / density, cutout.top / density, cutout.right / density, cutout.bottom / density)
    }

    /** The page's view: CSS px = dp, the safe area = the cutout with Settings › Display's margins (host.js readSafeArea). */
    private fun measureZoom(widthPx: Int, heightPx: Int) {
        safe = CoverGeometry.pageSafe(cutoutEdges(this), margins)
        zoom = CoverGeometry.pageZoom(CoverGeometry.innerSize(widthPx, density), CoverGeometry.innerSize(heightPx, density), safe, density)
        if (zoom != styledZoom) applyZoom()
    }

    /** The fonts, shadows, borders and button at `zoom` (the frames follow in onLayout and onDraw). */
    private fun applyZoom() {
        styledZoom = zoom
        val z = zoom.toFloat()
        fallbackLogo.textSize = RSTheme.textSizePx(RSTheme.Font.BOLD12, 2 * z, density.toFloat())
        errorTitle.scale = 2 * z
        errorText.scale = z
        errorText.lineHeightDp = 18 * z
        retry.scale = z
        val pad = (14 * zoom * density).roundToInt()
        retry.setPadding(pad, 0, pad, 0)
        // (pressed 20 % brighter, from the view's own pressed state while a finger is on it)
        retry.background = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_pressed), RSTheme.titleButtonImage(pressed = true, scale = z, density = density.toFloat()))
            addState(intArrayOf(), RSTheme.titleButtonImage(pressed = false, scale = z, density = density.toFloat()))
        }
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val height = MeasureSpec.getSize(heightMeasureSpec)
        setMeasuredDimension(width, height)
        if (width == 0 || height == 0) return
        measureZoom(width, height)
        val w = width / density
        val h = height / density
        loader = CoverGeometry.loader(
            width, height, safe, density, zoom, advance(barText, LOADING_TEXT), advance(caption, CAPTION_TEXT),
            shape(barText), shape(caption), logo?.width ?: 444, logo?.height ?: 142,
        ).also { fallbackLine = CoverGeometry.Line(0.0, 0.0, it.text.size * 2, 0.0, 0.0) }
        if (shownState !is CoverState.Error) return
        val unspecified = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
        errorTitle.measure(unspecified, unspecified)
        retry.measure(unspecified, unspecified)
        val frames = CoverGeometry.error(
            w, h, safe, zoom,
            titleAdvance = errorTitle.measuredWidth / density,
            textHeight = { panel ->
                errorText.measure(MeasureSpec.makeMeasureSpec((panel * density).roundToInt(), MeasureSpec.EXACTLY), unspecified)
                ceil(errorText.measuredHeight / density)
            },
            buttonIntrinsic = retry.measuredWidth / density,
        )
        errorFrames = frames
        for ((child, box) in listOf(errorTitle to frames.title, errorText to frames.text, retry to frames.button)) {
            val r = CoverGeometry.snap(box, density, text = child === errorTitle)
            child.measure(MeasureSpec.makeMeasureSpec(r.width(), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(r.height(), MeasureSpec.EXACTLY))
        }
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val frames = errorFrames ?: return
        if (shownState !is CoverState.Error) return
        for ((child, box) in listOf(errorTitle to frames.title, errorText to frames.text, retry to frames.button)) {
            val rect = CoverGeometry.snap(box, density, text = child === errorTitle)
            child.layout(rect.left, rect.top, rect.left + child.measuredWidth, rect.top + child.measuredHeight)
        }
    }

    // ------------------------------------------------------------------------------------------------ the loader

    override fun onDraw(canvas: Canvas) {
        if (shownState != CoverState.Loading) return
        val frames = loader ?: return
        // the logo, `contain`ed in its box, nearest-neighbour (`image-rendering: pixelated`)
        if (logo != null) {
            canvas.drawBitmap(logo, null, rectOf(frames.logo), nearest)
        } else {
            drawLine(canvas, fallbackLogo, "2004Scape", fallbackLine ?: return, RSTheme.YELLOW, shadow = false, centre = frames.logo)
        }
        // the bar: the 2px border, black inside, the fill from the left
        fill.color = RSTheme.LOADING_RED
        canvas.drawRect(rectOf(frames.bar), fill)
        fill.color = RSTheme.BLACK
        canvas.drawRect(rectOf(frames.inside), fill)
        fill.color = RSTheme.LOADING_RED
        canvas.drawRect(rectOf(frames.fill), fill)
        drawLine(canvas, barText, LOADING_TEXT, frames.text, RSTheme.WHITE, shadow = true)
        drawLine(canvas, caption, CAPTION_TEXT, frames.caption, RSTheme.LOADING_CAPTION, shadow = false)
    }

    private fun rectOf(area: CoverGeometry.Area): RectF = rect.apply { set(area.left.toFloat(), area.top.toFloat(), area.right.toFloat(), area.bottom.toFloat()) }

    /** A line of game text at its baseline, the hard shadow first; `centre`: centred in that box instead (the fallback). */
    private fun drawLine(canvas: Canvas, paint: TextPaint, text: String, line: CoverGeometry.Line, color: Int, shadow: Boolean, centre: CoverGeometry.Area? = null) {
        paint.textSize = line.size.toFloat()
        var x = line.x.toFloat()
        var baseline = line.baseline.toFloat()
        var shadowX = line.shadowX.toFloat()
        var shadowBaseline = line.shadowBaseline.toFloat()
        if (centre != null) {
            x = ((centre.left + centre.right) / 2).toFloat() - paint.measureText(text) / 2
            baseline = ((centre.top + centre.bottom) / 2).toFloat() + (paint.fontMetrics.descent - paint.fontMetrics.ascent) / 2 - paint.fontMetrics.descent
            shadowX = x + (line.size / 16).toFloat()
            shadowBaseline = baseline + (line.size / 16).toFloat()
        }
        if (shadow || centre != null) {
            paint.color = RSTheme.BLACK
            canvas.drawText(text, shadowX, shadowBaseline, paint)
        }
        paint.color = color
        canvas.drawText(text, x, baseline, paint)
    }

    /** A line's width in game px (CSS px at the 16px font size): the bitmap fonts' advances are whole game px. */
    private fun advance(paint: TextPaint, text: String): Double {
        paint.textSize = 16f
        return paint.measureText(text).toDouble()
    }

    /** The font's ascent and descent per em, from its metrics (the TTF's hhea: RS Bold 12 0.75/0.25). */
    private fun shape(paint: TextPaint): CoverGeometry.FontShape {
        paint.textSize = 1024f
        val metrics = paint.fontMetrics
        return CoverGeometry.FontShape(-metrics.ascent / 1024.0, metrics.descent / 1024.0)
    }

    private fun textPaint(font: RSTheme.Font) = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = RSTheme.typeface(font)
        isSubpixelText = true // glyphs keep their fractional x, as Chromium's (Skia subpixel positioning)
        hinting = Paint.HINTING_OFF
    }

    // ------------------------------------------------------------------------------------------------ debug

    /** The zoom and the frames, `[x, y, width, height]` in dp (the bar's text and fill in the bar), as iOS's debugLayout. */
    override val debugLayout: JsonElement
        get() {
            val frames = loader
            val dp = { r: Rect -> CoverGeometry.Box(r.left / density, r.top / density, r.width() / density, r.height() / density).json() }
            val line = { l: CoverGeometry.Line -> JsonArray(listOf(l.x, l.baseline, l.size).map { JsonPrimitive(it / density) }) }
            return buildJsonObject {
                put("zoom", JsonPrimitive(zoom))
                put("density", JsonPrimitive(density))
                put("safe", JsonArray(listOf(safe.left, safe.top, safe.right, safe.bottom).map { JsonPrimitive(it) }))
                if (frames != null) {
                    put("font", JsonPrimitive(frames.text.size / density))
                    put("logo", frames.logo.json(density))
                    put("bar", frames.bar.json(density))
                    put("barFill", frames.fill.json(density))
                    put("barText", line(frames.text)) // [x, baseline, font size] in dp
                    put("caption", line(frames.caption))
                }
                errorFrames?.let { e ->
                    put("errorTitle", dp(CoverGeometry.snap(e.title, density, text = true)))
                    put("errorText", dp(CoverGeometry.snap(e.text, density)))
                    put("retry", dp(CoverGeometry.snap(e.button, density)))
                }
            }
        }

    // ------------------------------------------------------------------------------------------------ notices

    override fun notice(text: String, durationMs: Long) {
        val host = parent as? FrameLayout ?: return
        val width = host.width
        val height = host.height
        val sides = CoverGeometry.pageSafe(cutoutEdges(host), margins) // (the page's: its sides with the margins)
        val left = (sides.left * density).roundToInt()
        val right = (sides.right * density).roundToInt()
        val top = ViewCompat.getRootWindowInsets(host)?.getInsets(WindowInsetsCompat.Type.displayCutout())?.top ?: 0
        // the crisp snap's scale at zoom 1 (3 device px per game px on a 2.625 phone), never the tablet zoom
        val s = if (width > 0 && height > 0) {
            CoverGeometry.snapZoom(1.0, density, CoverGeometry.innerSize(width - left - right, density), CoverGeometry.innerSize(height, density))
        } else {
            1.0
        }
        fun px(dp: Double) = (dp * s * density).roundToInt()
        val label = RSTextView(context).apply {
            this.text = text
            font = RSTheme.Font.PLAIN12
            scale = s.toFloat()
            textColor = RSTheme.YELLOW
            alignment = Layout.Alignment.ALIGN_CENTER
            maxLines = 6
            ellipsize = null
            setPadding(px(16.0), px(10.0), px(16.0), px(10.0))
            background = GradientDrawable().apply {
                setColor(0xCC000000.toInt())
                setStroke(px(1.0), RSTheme.MENU)
            }
            alpha = 0f
        }
        label.maxWidthPx = ((width - left - right) * 0.8).roundToInt().takeIf { it > 0 } ?: Int.MAX_VALUE
        host.addView(label, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER_HORIZONTAL or Gravity.TOP).apply {
            topMargin = top + px(14.0)
            leftMargin = left
            rightMargin = right
        })
        label.animate().alpha(1f).setDuration(200).withEndAction {
            label.animate().alpha(0f).setStartDelay(durationMs).setDuration(400).withEndAction { host.removeView(label) }
        }
    }

    companion object {
        const val LOADING_TEXT = "Loading - please wait."
        const val CAPTION_TEXT = "2004Scape · November 2004 · offline"
        const val FADE_MS = 250L
    }
}

/**
 * The cover in the session: GameSession makes a LoadingCover for each activity, and the page's {type:'loader-drawn'}
 * takes it away once the page's own, identical loader is on screen (docs/ANDROID.md §3.3). A `loader-drawn` from a page
 * that has not said `ready` yet (an old document's, posted while the next one loads) is ignored; the session's 3 s
 * fallback after the page loaded stays as it was.
 */
class LoadingCoverComponent(private val session: GameSession) : SessionComponent {
    private var ready = false

    /** DEBUG `cover-hold`: the next hand-over waits this long, so a test can photograph the cover over the page's loader. */
    private var holdMs = 0L

    init {
        session.coverViewFactory = { context -> LoadingCover(context) }
        // (DEBUG: a notice over the game, for screenshots)
        session.debugAction("notice") { message, reply ->
            session.cover.notice(message.string("text") ?: "The game stopped unexpectedly (probably out of memory) and is restarting.")
            reply(null)
        }
        session.debugAction("cover-hold") { message, reply ->
            holdMs = message.long("ms") ?: 0
            reply(null)
        }
        session.handle("loader-drawn") {
            when {
                !ready -> Log.info("host", "loader drawn before the page was ready: ignored")
                session.cover.isShowing && !session.cover.isShowingError -> if (holdMs > 0) {
                    val ms = holdMs
                    holdMs = 0
                    Log.info("debug", "the page's loader is drawn: the cover stays $ms ms (cover-hold)")
                    MainScheduler.postDelayed(ms) { uncover() }
                } else {
                    uncover()
                }
                else -> Log.debug("host") { "loader drawn (nothing to uncover)" }
            }
        }
    }

    private fun uncover() {
        if (!session.cover.isShowing || session.cover.isShowingError) return
        Log.info("host", "the page's loader is drawn: uncovering")
        session.cover.hide()
    }

    override fun pageReset() {
        ready = false
    }

    override fun pageReady() {
        ready = true
    }
}
