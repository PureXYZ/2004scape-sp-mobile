// KeyboardInsets: where the IME is, for the bar and for the page (the keyboard-frame half of ios/LostCity/KeyboardBridge.swift:
// its will-show/will-hide/did-show/did-hide observers and the accessory bar riding on the keyboard).
//
// * The bar rides on the IME frame by frame, as an inputAccessoryView rides on the iOS keyboard: WindowInsetsAnimation's
//   onProgress moves it up by the IME's inset (translationY), and a change without an animation moves it at once.
// * The page hears once per animation, at its start, with the end state and the IME's own duration (iOS's will-show and
//   will-hide), and again at the end (a no-op unless something changed): KeyboardBridge.reportCovered sends
//   `LostCityHost.keyboard.frame(dp, seconds, 'cubic-bezier(0.2, 0, 0, 1)')`.
// * The IME going away while the keyboard is requested is how the player closes it on Android (Back, its hide key, a swipe
//   down): KeyboardBridge decides whether that is a dismissal (not when a hardware keyboard came, or the window lost focus).
// * The IME brings the navigation bar back with it; once the IME is gone the system bars are hidden
//   again, as GameActivity keeps them.
// * The bar keeps clear of the display cutout and of a navigation bar on the side (the safe area, as iOS's
//   safeAreaLayoutGuide).
//
// Everything is registered on the bridge's own focus-holding view, never on the activity's root, so the WebView's insets and
// any other track's listeners on the root are left alone (the insets are passed on unconsumed).
package io.github.purexyz.scape2004

import android.view.View
import android.view.Window
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat

class KeyboardInsets(
    private val anchor: View,
    private val bar: KeyboardAccessoryBar,
    private val bridge: KeyboardBridge,
    private val window: () -> Window?,
) {
    private val density = anchor.resources.displayMetrics.density

    /** The IME's inset now (px, from the bottom of the window); > 0 while it shows or moves. */
    var imePx = 0
        private set

    /** An IME animation is running (between onPrepare and onEnd). */
    var animating = false
        private set
    private var startPx = 0
    private var endPx = 0

    /** The IME is (or is becoming) visible. */
    val imeVisible: Boolean get() = if (animating) endPx > 0 else imePx > 0

    fun install() {
        ViewCompat.setOnApplyWindowInsetsListener(anchor) { _, insets ->
            applied(insets)
            insets // unconsumed: the WebView and everything else still get them
        }
        ViewCompat.setWindowInsetsAnimationCallback(anchor, callback)
        ViewCompat.requestApplyInsets(anchor)
    }

    fun uninstall() {
        ViewCompat.setOnApplyWindowInsetsListener(anchor, null)
        ViewCompat.setWindowInsetsAnimationCallback(anchor, null)
    }

    private fun dp(px: Int) = px / density

    private var rotation: Int? = null

    private fun applied(insets: WindowInsetsCompat) {
        val sides = insets.getInsets(WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.navigationBars())
        val side = maxOf(sides.left, sides.right) // the sides made equal, as iOS's landscape safe area and the page's
        bar.setSafeInsets(side, side)
        // a 180° turn moves the cutout to the other side and takes the IME away for a moment, with no configuration
        // change: KeyboardBridge must not take that for the player closing it
        val turned = anchor.display?.rotation
        if (turned != null && turned != rotation) {
            if (rotation != null) bridge.displayRotated()
            rotation = turned
        }
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
        if (animating) {
            endPx = ime // (the end state, dispatched between onPrepare and onStart)
            return
        }
        if (ime == imePx) return
        imePx = ime
        place()
        bridge.imeSettled(dp(ime))
        if (ime == 0) imeGone()
    }

    private val callback = object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
        override fun onPrepare(animation: WindowInsetsAnimationCompat) {
            if (!isIme(animation)) return
            animating = true
            startPx = imePx
            endPx = imePx
        }

        override fun onStart(animation: WindowInsetsAnimationCompat, bounds: WindowInsetsAnimationCompat.BoundsCompat): WindowInsetsAnimationCompat.BoundsCompat {
            if (!isIme(animation)) return bounds
            val dispatched = endPx
            val root = ViewCompat.getRootWindowInsets(anchor)?.getInsets(WindowInsetsCompat.Type.ime())?.bottom
            Log.debug("kbd") { "ime onStart: end $dispatched px dispatched, $root px in the root, bounds ${bounds.lowerBound.bottom}..${bounds.upperBound.bottom}, from $startPx" }
            root?.let { endPx = it }
            bridge.imeAnimationStarted(dp(startPx), dp(endPx), animation.durationMillis / 1000.0)
            return bounds
        }

        override fun onProgress(insets: WindowInsetsCompat, runningAnimations: List<WindowInsetsAnimationCompat>): WindowInsetsCompat {
            if (runningAnimations.any(::isIme)) {
                imePx = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
                place()
            }
            return insets
        }

        override fun onEnd(animation: WindowInsetsAnimationCompat) {
            if (!isIme(animation)) return
            animating = false
            imePx = ViewCompat.getRootWindowInsets(anchor)?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: endPx
            place()
            bridge.imeAnimationEnded(dp(imePx))
            if (imePx == 0) imeGone()
        }
    }

    private fun isIme(animation: WindowInsetsAnimationCompat) = (animation.typeMask and WindowInsetsCompat.Type.ime()) != 0

    /** The bar sits on the IME (at the bottom of the screen without one). */
    fun place() {
        bar.translationY = -imePx.toFloat()
    }

    /** The IME is down: a bar that is no longer wanted goes now, and the navigation bar the IME brought is hidden again. */
    private fun imeGone() {
        if (!bridge.requested || bridge.lent) bar.visibility = View.GONE
        hideSystemBars()
    }

    fun hideSystemBars() {
        val window = window() ?: return
        WindowCompat.getInsetsController(window, window.decorView).hide(WindowInsetsCompat.Type.systemBars())
    }
}
