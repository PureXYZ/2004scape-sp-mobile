// StretchDrawable: a game sprite stretched around a fixed frame, the native counterpart of the page's CSS
// `border-image: … <cap> fill / <cap>px stretch` and of UIKit's resizableImage(withCapInsets:) in RSTheme.swift.
// The sprites have no .9.png chunk, so the nine regions are drawn by hand: the corners at
// their size, the edges and the centre stretched, all with nearest-neighbour sampling so the game's pixels stay square.
package io.github.purexyz.scape2004

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.Drawable
import kotlin.math.roundToInt

class StretchDrawable(
    private val bitmap: Bitmap,
    /** The frame, in sprite pixels, on every side. */
    private val cap: Int,
    /** Device pixels per sprite pixel (dp per game pixel × density). */
    private val pixelScale: Float,
) : Drawable() {
    private val paint = RSTheme.nearestPaint()
    private val src = Rect()
    private val dst = Rect()

    override fun draw(canvas: Canvas) {
        val b = bounds
        if (b.isEmpty) return
        val w = bitmap.width
        val h = bitmap.height
        val c = minOf(cap, w / 2, h / 2)
        // the frame in device pixels, whole pixels so neighbouring regions never leave a seam
        val d = minOf((c * pixelScale).roundToInt(), b.width() / 2, b.height() / 2)
        val xs = intArrayOf(0, c, w - c, w)
        val ys = intArrayOf(0, c, h - c, h)
        val dxs = intArrayOf(b.left, b.left + d, b.right - d, b.right)
        val dys = intArrayOf(b.top, b.top + d, b.bottom - d, b.bottom)
        for (row in 0 until 3) {
            for (col in 0 until 3) {
                if (xs[col + 1] <= xs[col] || ys[row + 1] <= ys[row]) continue
                if (dxs[col + 1] <= dxs[col] || dys[row + 1] <= dys[row]) continue
                src.set(xs[col], ys[row], xs[col + 1], ys[row + 1])
                dst.set(dxs[col], dys[row], dxs[col + 1], dys[row + 1])
                canvas.drawBitmap(bitmap, src, dst, paint)
            }
        }
    }

    override fun getIntrinsicWidth(): Int = (bitmap.width * pixelScale).roundToInt()

    override fun getIntrinsicHeight(): Int = (bitmap.height * pixelScale).roundToInt()

    override fun setAlpha(alpha: Int) {
        paint.alpha = alpha
        invalidateSelf()
    }

    override fun setColorFilter(colorFilter: ColorFilter?) {
        paint.colorFilter = colorFilter
        invalidateSelf()
    }

    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
