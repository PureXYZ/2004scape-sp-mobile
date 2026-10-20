// CoverGeometry (LoadingCover.kt; docs/ANDROID.md §1 Pixels): host.js layout()'s zoom with the
// crisp pixel snap for web/test/android-stub.mjs's Android screens (and iOS's), and the loader where the page's own lands
// on the Medium Phone AVD (2400 × 1080 at 2.625), as measured on the emulator's screen (android/test/shell.mjs `cover`):
// with the snap's CSS zoom the bar from device px 693 to 795, the text's baseline at 756, the caption at x 919.5.
package io.github.purexyz.scape2004

import org.junit.Assert.assertEquals
import org.junit.Test

class CoverGeometryTest {
    private fun zoom(widthPx: Int, heightPx: Int, dpr: Double, safeLeft: Double = 0.0) =
        CoverGeometry.pageZoom(CoverGeometry.innerSize(widthPx, dpr), CoverGeometry.innerSize(heightPx, dpr), CoverGeometry.Edges(left = safeLeft), dpr)

    @Test
    fun theAndroidScreens() {
        // (web/test/android-stub.mjs ANDROID_SCREENS: view CSS px, dpr, safe left, zoom)
        assertEquals(3 / 2.625, zoom(2400, 1080, 2.625), 1e-12) // a-medium: the AVD, 800 × 360 HUD px
        assertEquals(3 / 2.625, zoom(2424, 1080, 2.625, safeLeft = 32.0), 1e-12) // a-pixel10
        assertEquals(1.0, zoom(2856, 1281, 3.0, safeLeft = 32.0), 0.0) // a-pro: a whole ratio, the iPhone rules
        assertEquals(1.0, zoom(2400, 1080, 3.0, safeLeft = 30.0), 0.0) // a-800
        assertEquals(3 / 2.625, zoom(1920, 1080, 2.625, safeLeft = 24.0), 1e-12) // a-732
        assertEquals(1.0, zoom(1280, 720, 2.0), 0.0) // a-640
        assertEquals(1.5, zoom(2560, 1600, 2.0), 0.0) // a-tablet
    }

    @Test
    fun aLargerDisplaySizeNeverShrinksTheHud() {
        // the AVD (2400 × 1080) at its Display sizes, 356, 420, 460, 500 and 540 dpi (android-stub.mjs a-small … a-largest;
        // the density as DisplayMetrics makes it, densityDpi × (1f / 160): 2.2250001 at 356, which the WebView reports too)
        val densities = listOf(356, 420, 460, 500, 540).map { (it * (1f / 160)).toDouble() }
        val zooms = densities.map { zoom(2400, 1080, it) }
        assertEquals(2 / densities[0], zooms[0], 1e-12) // crisp: 2 device px per HUD px (3 also fits: rounding down is fine)
        assertEquals(3 / 2.625, zooms[1], 1e-12) // crisp 3
        assertEquals(3 / 2.875, zooms[2], 1e-12) // crisp 3
        assertEquals(1.0, zooms[3], 0.0) // 3 would be the default's size and 4 leaves 270 HUD px of height: 3.125, soft
        assertEquals(1.0, zooms[4], 0.0) // 3.375
        val scales = densities.zip(zooms) { dpr, z -> dpr * z }
        assertEquals("device px per HUD px never fall as the Display size grows", scales.sorted(), scales)
        assertEquals(1.0, zoom(2424, 1080, 3.125, safeLeft = 32.0), 0.0) // the Pixel 10 at Larger too
    }

    @Test
    fun theIosScreensKeepTheirZoom() {
        assertEquals(1.0, CoverGeometry.pageZoom(812.0, 375.0, CoverGeometry.Edges(left = 50.0, right = 50.0), 3.0), 0.0) // iPhone 13 mini
        assertEquals(1.5, CoverGeometry.pageZoom(1133.0, 744.0, CoverGeometry.Edges(), 2.0), 0.0) // iPad mini: 2 would leave 566 px
        assertEquals(2.0, CoverGeometry.pageZoom(1376.0, 1032.0, CoverGeometry.Edges(), 2.0), 0.0) // 13-inch iPad
    }

    @Test
    fun theSnapKeepsTheHudItsRoom() {
        // 2.625 at 600 × 300 CSS px: 8/7 would leave 280 HUD px of height (< 320): the unsnapped zoom stays
        assertEquals(1.0, CoverGeometry.snapZoom(1.0, 2.625, 600.0, 300.0), 0.0)
        // 2.75 → 3/2.75
        assertEquals(3 / 2.75, CoverGeometry.snapZoom(1.0, 2.75, 850.0, 392.0), 1e-12)
        // 1.75 → 2/1.75 (at 1.5 the HUD must keep 667)
        assertEquals(2 / 1.75, CoverGeometry.snapZoom(1.0, 1.75, 731.0, 411.0), 1e-12)
        assertEquals(1.5, CoverGeometry.snapZoom(1.5, 1.75, 1100.0, 600.0), 0.0) // round(2.625)/1.75 = 1.714: 1100/1.714 < 667
    }

    @Test
    fun innerSizeDropsTheFraction() {
        assertEquals(914.0, CoverGeometry.innerSize(2400, 2.625), 0.0)
        assertEquals(411.0, CoverGeometry.innerSize(1080, 2.625), 0.0)
        assertEquals(923.0, CoverGeometry.innerSize(2424, 2.625), 0.0)
        assertEquals(800.0, CoverGeometry.innerSize(2400, 3.0), 0.0)
    }

    @Test
    fun blinksFontMetrics() {
        val bold = CoverGeometry.FontShape(0.75, 0.25)
        val small = CoverGeometry.FontShape(0.625, 0.125)
        assertEquals(32.0 to 11.0, CoverGeometry.metrics(bold, 42.0)) // 31.5/10.5 rounded up
        assertEquals(25.0 to 6.0, CoverGeometry.metrics(small, 42.0)) // 26.25/5.25: the descent rounded down takes a unit
        assertEquals(36.0 to 12.0, CoverGeometry.metrics(bold, 48.0))
        assertEquals(30.0 to 6.0, CoverGeometry.metrics(small, 48.0))
        // the half leading above is floored: a 42 px line of 43 px of font starts a px early
        assertEquals(661.0, CoverGeometry.baseline(630.0, 42.0, bold, 42.0), 0.0)
        assertEquals(752.125, CoverGeometry.baseline(727.125, 31.5, small, 42.0), 0.0)
    }

    @Test
    fun layoutUnits() {
        assertEquals(47.265625, CoverGeometry.lu(788 * 0.06), 0.0)
        assertEquals(2100.0, CoverGeometry.lu(2400 / (3 / 2.625)), 0.0)
        assertEquals(160.125, CoverGeometry.half(320.25), 0.0)
        assertEquals(-0.5, CoverGeometry.half(-1.0), 0.0)
        assertEquals(383.25, CoverGeometry.luCeil(146 * 2.625), 0.0)
        assertEquals(607.0, CoverGeometry.round(606.5), 0.0)
    }

    @Test
    fun theLoaderOnTheAvd() {
        val z = 3 / 2.625
        // "Loading - please wait." is 146 game px in RS Bold 12, the caption 187 in RS Plain 11 (the page's own widths).
        // With the snap the page's layer is CSS-zoomed: laid out at 3 device px a CSS px, every edge on a device px.
        val loader = CoverGeometry.loader(2400, 1080, CoverGeometry.Edges(), 2.625, z, textAdvance = 146.0, captionAdvance = 187.0)
        val e = 1e-9
        assertEquals(z, loader.zoom, 0.0)
        with(loader.bar) { // the card (1332 × 654) centred in 2328 × 1020 (padding 36 and 30): the bar 912 × 102
            assertEquals(744.0, left, e)
            assertEquals(693.0, top, e)
            assertEquals(1656.0, right, e)
            assertEquals(795.0, bottom, e)
        }
        with(loader.inside) { // the border: 2 CSS px = 6 device px
            assertEquals(750.0, left, e)
            assertEquals(699.0, top, e)
            assertEquals(1650.0, right, e)
            assertEquals(789.0, bottom, e)
        }
        with(loader.fill) {
            assertEquals(750.0, left, e)
            assertEquals(804.0, right, e) // 6 % of 900
            assertEquals(699.0, top, e)
            assertEquals(789.0, bottom, e)
        }
        with(loader.text) {
            assertEquals(981.0, x, e)
            assertEquals(756.0, baseline, 0.0)
            assertEquals(48.0, size, e)
            assertEquals(984.0, shadowX, e)
            assertEquals(759.0, shadowBaseline, 0.0)
        }
        with(loader.caption) {
            assertEquals(919.5, x, e) // centred: half a device px over, as the page's glyphs (subpixel positioning)
            assertEquals(861.0, baseline, 0.0)
        }
        with(loader.logo) { // 444 × 142 at exactly 3 device px each
            assertEquals(534.0, left, e)
            assertEquals(213.0, top, e)
            assertEquals(1866.0, right, e)
            assertEquals(639.0, bottom, e)
        }
    }

    @Test
    fun aScaledUpLayerIsPaintedWithTheZoom() {
        // a-tablet: 2560 × 1600 at a whole ratio of 2 with ×1.5 (host.css html.ui-zoomed: a transform, not the snap):
        // laid out at 2 layout px a CSS px in a layer of the viewport ÷ 1.5, then painted 1.5 times larger
        val loader = CoverGeometry.loader(2560, 1600, CoverGeometry.Edges(), 2.0, 1.5, 146.0, 187.0)
        // the layer 1706.65625 × 1066.65625; padding 24 and 20; the card 888 × 436; the bar 608 × 68 at layout px
        // 24 + half(1658.65625 - 888) = 409.328125 + 140 across, 20 + half(1026.65625 - 436) + 284 + 36 = 635.328125 down
        assertEquals(round(549.328125) * 1.5, loader.bar.left, 1e-9)
        assertEquals(round(635.328125) * 1.5, loader.bar.top, 1e-9)
        assertEquals(4 * 1.5, loader.inside.left - loader.bar.left, 1e-9) // the 2 px border: 4 layout px, zoomed
    }

    private fun round(v: Double) = CoverGeometry.round(v)

    @Test
    fun theCardStaysBetweenTheSafeAreas() {
        val z = 3 / 2.625
        val plain = CoverGeometry.loader(2424, 1080, CoverGeometry.Edges(), 2.625, z, 146.0, 187.0)
        val cutout = CoverGeometry.loader(2424, 1080, CoverGeometry.Edges(left = 32.0), 2.625, z, 146.0, 187.0)
        // the padding grows by the safe area (zoomed with the layer: 32 × 3 device px); the card moves by half of it
        assertEquals(32 * 3.0 / 2, cutout.bar.left - plain.bar.left, 1.0)
        assertEquals(plain.bar.top, cutout.bar.top, 0.0)
    }

    @Test
    fun theMarginsAreThePages() {
        // host.js readSafeArea: the sides equal (the camera hole's on both), None 0, +16 more; the bottom a curved edge's
        val hole = CoverGeometry.Edges(left = 32.0)
        assertEquals(CoverGeometry.Edges(32.0, 0.0, 32.0, 0.0), CoverGeometry.pageSafe(hole, CoverMargins()))
        assertEquals(CoverGeometry.Edges(0.0, 0.0, 0.0, 0.0), CoverGeometry.pageSafe(hole, CoverMargins(sides = -1.0)))
        assertEquals(CoverGeometry.Edges(48.0, 16.0, 48.0, 32.0), CoverGeometry.pageSafe(hole, CoverMargins(16.0, 16.0, 32.0)))
        // a curved edge's top and bottom, each with its own margin
        val curved = CoverGeometry.Edges(top = 21.0, bottom = 21.0)
        assertEquals(CoverGeometry.Edges(0.0, 21.0, 0.0, 21.0), CoverGeometry.pageSafe(curved, CoverMargins()))
        assertEquals(CoverGeometry.Edges(0.0, 0.0, 0.0, 37.0), CoverGeometry.pageSafe(curved, CoverMargins(top = -1.0, bottom = 16.0)))
        // a bottom margin lifts the card by half of it (zoomed with the layer: 3 device px a CSS px)
        val z = 3 / 2.625
        val plain = CoverGeometry.loader(2424, 1080, CoverGeometry.Edges(), 2.625, z, 146.0, 187.0)
        val lifted = CoverGeometry.loader(2424, 1080, CoverGeometry.Edges(bottom = 32.0), 2.625, z, 146.0, 187.0)
        assertEquals(-32 * 3.0 / 2, lifted.bar.top - plain.bar.top, 1.0)
        // and a top margin lowers it by half of it
        val lowered = CoverGeometry.loader(2424, 1080, CoverGeometry.Edges(top = 32.0), 2.625, z, 146.0, 187.0)
        assertEquals(32 * 3.0 / 2, lowered.bar.top - plain.bar.top, 1.0)
    }

    @Test
    fun aWholeRatioLandsOnWholePixels() {
        // a-800: 2400 × 1080 at 3, zoom 1: every edge and baseline on a device px, as on a 3x iPhone
        val loader = CoverGeometry.loader(2400, 1080, CoverGeometry.Edges(left = 30.0), 3.0, 1.0, 146.0, 187.0)
        for (v in listOf(loader.bar.left, loader.bar.top, loader.bar.right, loader.bar.bottom, loader.inside.left, loader.fill.right,
            loader.text.baseline, loader.caption.baseline, loader.logo.left, loader.logo.top)) {
            assertEquals(v, Math.rint(v), 0.0)
        }
        assertEquals(6.0, loader.inside.top - loader.bar.top, 0.0) // the 2 px border: 6 device px
        assertEquals(48.0, loader.text.size, 0.0)
    }
}
