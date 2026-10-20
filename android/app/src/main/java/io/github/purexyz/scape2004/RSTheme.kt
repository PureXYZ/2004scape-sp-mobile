// RSTheme: the 2004 look for the few native views (the keyboard bar, the loading cover and error screen, notices), from
// the game's own fonts and sprites that web/ui/build.mjs puts in the bundle's Game/ui for the page's HUD (ports
// ios/LostCity/RSTheme.swift; ARCHITECTURE.md §7 end).
//
// Sizes: like the page, 16 px of font size per game pixel at scale 1, so one game pixel is one dp (CSS px = dp on
// Android: the page runs at width=device-width, devicePixelRatio = density). At 16 every font has whole-pixel metrics
// (ascent/descent: Plain 11 10/2, Plain 12 and Bold 12 12/4, Quill 8 15/5, no leading), so a label exactly one line
// tall puts its baseline where the page's CSS line box of the same height does. Sizes are always in px (never sp): the
// 2004 look must not follow the system font scale, as iOS ignores Dynamic Type.
//
// Sprites are decoded unscaled (inScaled = false) and drawn with nearest-neighbour sampling (filterBitmap = false), so
// Android never smooths the game's pixels when it scales or stretches them (`image-rendering: pixelated` on the page).
// Everything falls back to system fonts and plain colours if Game/ui is missing, as on iOS.
//
// UI thread only (the caches are not synchronised).
package io.github.purexyz.scape2004

import android.content.Context
import android.content.res.AssetManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.ShapeDrawable
import android.graphics.drawable.shapes.RectShape

object RSTheme {
    enum class Font(val file: String) {
        PLAIN11("p11"), PLAIN12("p12"), BOLD12("b12"), QUILL8("q8")
    }

    const val YELLOW = 0xFFFFFF00.toInt()
    const val ORANGE = 0xFFFF981F.toInt()
    const val RED = 0xFFFF0000.toInt()
    const val WHITE = 0xFFFFFFFF.toInt()
    const val BLACK = 0xFF000000.toInt()
    const val STONE = 0xFF453C30.toInt()
    const val STONE_LIGHT = 0xFF776754.toInt()
    const val STONE_DARK = 0xFF201B15.toInt()
    const val MENU = 0xFF5D5447.toInt()

    /** The 2004 loader's bar (`#8c1111`) and the line under it (`#75a9a9`), as on the page's `#loading`. */
    const val LOADING_RED = 0xFF8C1111.toInt()
    const val LOADING_CAPTION = 0xFF75A9A9.toInt()

    private var assets: AssetManager? = null
    private val typefaces = HashMap<Font, Typeface?>()
    private val sprites = HashMap<String, Bitmap?>()

    /** Called once with the application context (LostCityApp). */
    fun init(context: Context) {
        assets = context.applicationContext.assets
    }

    /** The game font, or null when Game/ui/fonts is missing (then [typeface] gives a system font). */
    fun gameTypeface(font: Font): Typeface? = typefaces.getOrPut(font) {
        val manager = assets ?: return@getOrPut null
        try {
            Typeface.createFromAsset(manager, "Game/ui/fonts/${font.file}.ttf")
        } catch (error: Exception) {
            Log.info("theme", "font ${font.file} not registered ($error)")
            null
        }
    }

    fun typeface(font: Font): Typeface =
        gameTypeface(font) ?: if (font == Font.BOLD12) Typeface.DEFAULT_BOLD else Typeface.DEFAULT

    /** Text size in device px for `scale` game pixels per dp: 16 px per game pixel, or a system font of about that size. */
    fun textSizePx(font: Font, scale: Float, density: Float): Float =
        (if (gameTypeface(font) != null) 16f else 12f) * scale * density

    /** `Game/ui/sprites/<name>.png` at its own pixel size, or null when missing. */
    fun sprite(name: String): Bitmap? = sprites.getOrPut(name) {
        val manager = assets ?: return@getOrPut null
        try {
            manager.open("Game/ui/sprites/$name.png").use { stream ->
                BitmapFactory.decodeStream(stream, null, BitmapFactory.Options().apply { inScaled = false })
            }
        } catch (_: Exception) {
            null
        }
    }

    /**
     * [sprite] with every colour channel multiplied by `factor` (clamped at white), like the page's CSS
     * `filter: brightness()` on a pressed button.
     */
    fun brightSprite(name: String, factor: Float): Bitmap? = sprites.getOrPut("$name*$factor") {
        val base = sprite(name) ?: return@getOrPut null
        val bright = Bitmap.createBitmap(base.width, base.height, Bitmap.Config.ARGB_8888)
        val paint = Paint().apply {
            isFilterBitmap = false
            colorFilter = ColorMatrixColorFilter(ColorMatrix().apply { setScale(factor, factor, factor, 1f) })
        }
        Canvas(bright).drawBitmap(base, 0f, 0f, paint)
        bright
    }

    /**
     * `text` with the punctuation the game's fonts do not have replaced by what the 2004 client would write, so a label
     * does not fall back to a system font for an ellipsis or a curly quote, and typed text is not dropped by the client
     * (it takes plain ASCII).
     */
    fun gameText(text: String): String = text
        .replace("…", "...")
        .replace('‘', '\'').replace('’', '\'')
        .replace('“', '"').replace('”', '"')
        .replace('–', '-').replace('—', '-')

    /** A paint that draws bitmaps with nearest-neighbour sampling. */
    fun nearestPaint(): Paint = Paint().apply {
        isFilterBitmap = false
        isAntiAlias = false
        isDither = false
    }

    /**
     * A 2004 interface button (grey, or red when `on`), stretched around its 5-pixel bevel like the page's `.stone-btn`;
     * `pressed` is 25 % brighter. `scale` is dp per game pixel.
     */
    fun buttonImage(on: Boolean = false, pressed: Boolean = false, scale: Float = 1f, density: Float): Drawable =
        stretch(if (on) "miscgraphics-9" else "miscgraphics-0", if (pressed) 1.25f else 1f, 5, scale, density)

    /** The Game Options tab's small button (grey, or red when `on`), stretched around its 4-pixel frame (`.seg button`). */
    fun optionButtonImage(on: Boolean = false, scale: Float = 1f, density: Float): Drawable =
        stretch(if (on) "miscgraphics3-1" else "miscgraphics3-0", 1f, 4, scale, density)

    /** The title screen's slate button, stretched around its 6-pixel frame (`.title-btn`); `pressed` is 20 % brighter. */
    fun titleButtonImage(pressed: Boolean = false, scale: Float = 1f, density: Float): Drawable =
        stretch("titlebutton", if (pressed) 1.2f else 1f, 6, scale, density)

    /** The brown stone fill of the game's windows (`tradebacking`), tiled at one game pixel per dp; plain stone without it. */
    fun stoneFillDrawable(density: Float, scale: Float = 1f): Drawable {
        val tile = sprite("tradebacking") ?: return ColorDrawable(STONE)
        return ShapeDrawable(RectShape()).apply {
            paint.isFilterBitmap = false
            paint.shader = BitmapShader(tile, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT).apply {
                setLocalMatrix(Matrix().apply { setScale(density * scale, density * scale) })
            }
        }
    }

    /** A sprite stretched around `cap` game pixels; without the sprite, a stone fill with a stone-light edge. */
    private fun stretch(name: String, factor: Float, cap: Int, scale: Float, density: Float): Drawable {
        val bitmap = if (factor == 1f) sprite(name) else brightSprite(name, factor)
        return if (bitmap != null) StretchDrawable(bitmap, cap, scale * density) else FallbackButton(density)
    }

    /** No sprites: still a recognisable button (iOS's `buttonConfiguration` fallback). */
    private class FallbackButton(private val density: Float) : Drawable() {
        private val fill = Paint().apply { color = STONE }
        private val edge = Paint().apply {
            color = STONE_LIGHT
            style = Paint.Style.STROKE
        }

        override fun draw(canvas: Canvas) {
            canvas.drawRect(bounds, fill)
            edge.strokeWidth = density
            val inset = density / 2
            canvas.drawRect(bounds.left + inset, bounds.top + inset, bounds.right - inset, bounds.bottom - inset, edge)
        }

        override fun setAlpha(alpha: Int) {
            fill.alpha = alpha
            edge.alpha = alpha
        }

        override fun setColorFilter(colorFilter: android.graphics.ColorFilter?) {
            fill.colorFilter = colorFilter
            edge.colorFilter = colorFilter
        }

        @Deprecated("Deprecated in Java")
        override fun getOpacity() = android.graphics.PixelFormat.OPAQUE
    }
}
