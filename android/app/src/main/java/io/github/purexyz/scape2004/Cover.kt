// Cover: what native shows over (or instead of) the page (the state half of ios/LostCity/LoadingOverlay.swift and Notice).
//
// * Loading: from launch (and every reload) until the page has drawn its own loader: `ready` or the first `status`
//   uncovers it (GameSession.uncover), or 3 s after the page loaded at the latest. It takes the touches meanwhile.
// * Error: native's own error screen, only when there is no page to show one: the page could not be loaded, the WebView
//   renderer keeps crashing, or Android System WebView is missing or too old. Errors the page can show itself are the
//   page's (`fatal`).
// * Notices: a short line over the game ("The game stopped unexpectedly … and is restarting.").
//
// The state lives in the process-scoped GameSession (CoverController), so a recreated activity shows the same thing; the
// view is per activity. This file has a plain view (PlainCover: black, the error screen in the game's fonts, a notice
// line); the loading-cover track replaces it with the pixel copy of the page's loader (LoadingOverlay.swift) by
// setting GameSession.coverViewFactory, without touching the state machine here.
package io.github.purexyz.scape2004

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.text.Layout
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.accessibility.AccessibilityEvent
import android.widget.FrameLayout
import android.widget.LinearLayout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlin.math.roundToInt

/** What the cover shows. */
sealed interface CoverState {
    data object Hidden : CoverState
    data object Loading : CoverState

    /** `button` runs `action` once (Try again, Update). */
    class Error(val message: String, val button: String, val action: () -> Unit) : CoverState
}

/** One activity's cover view. */
interface CoverView {
    val view: View

    /** Shows `state`; `animated`: a fade (hiding takes 0.25 s, as iOS). */
    fun render(state: CoverState, animated: Boolean)

    /** A short line over the game, gone after `durationMs`. */
    fun notice(text: String, durationMs: Long)

    /** The zoom and frames the view lays out, for the DEBUG `ui-state` action's `overlayLayout` (iOS's debugLayout). */
    val debugLayout: JsonElement get() = JsonNull

    /** Settings › Display's margins, which the page lays its overlay out with (host.js readSafeArea). */
    fun margins(margins: CoverMargins) {}
}

/**
 * Settings › Display › Side margin, Top margin and Bottom margin (`safeSides`, `safeTop`, `safeBottom`, CSS px): -1 None,
 * 0 Auto, 16 or 32 more.
 */
data class CoverMargins(val sides: Double = 0.0, val top: Double = 0.0, val bottom: Double = 0.0)

/** The cover's state, kept by the session across activities. */
class CoverController {
    var state: CoverState = CoverState.Hidden
        private set

    private var view: CoverView? = null

    val isShowing: Boolean get() = state != CoverState.Hidden
    val isShowingError: Boolean get() = state is CoverState.Error

    /** Settings › Display's margins (the session keeps them current from the page's settings). */
    var margins = CoverMargins()
        set(value) {
            if (value == field) return
            field = value
            view?.margins(value)
        }

    fun attach(view: CoverView) {
        this.view = view
        view.margins(margins)
        view.render(state, animated = false)
    }

    fun detach(view: CoverView) {
        if (this.view === view) this.view = null
    }

    /** The loader (also clears an error). */
    fun show() {
        state = CoverState.Loading
        view?.render(state, animated = false)
    }

    /** Fades it out; nothing when hidden already. */
    fun hide() {
        if (!isShowing) return
        state = CoverState.Hidden
        view?.render(state, animated = true)
    }

    /** Native's error screen; `action` runs once, from its button. */
    fun showError(message: String, button: String = "Try again", action: () -> Unit) {
        var used = false
        state = CoverState.Error(message, button) {
            if (!used) {
                used = true
                action()
            }
        }
        view?.render(state, animated = false)
    }

    fun notice(text: String, durationMs: Long = NOTICE_MS) {
        Log.info("host", "notice: $text")
        view?.notice(text, durationMs)
    }

    companion object {
        const val NOTICE_MS = 3_500L
    }
}

/**
 * The plain cover: black while loading; the 2004 error screen ("Error - unable to continue!" in yellow Bold 12 at twice
 * the size, the message in Plain 12, a title-screen button); notices as yellow game text on black.
 */
class PlainCover(context: Context) : FrameLayout(context), CoverView {
    override val view: View get() = this

    private val density = resources.displayMetrics.density
    private val panel = LinearLayout(context)
    private val title = RSTextView(context)
    private val message = RSTextView(context)
    private val button = RSTextView(context)
    private var action: (() -> Unit)? = null
    private var shownState: CoverState = CoverState.Hidden

    init {
        id = R.id.cover
        setBackgroundColor(RSTheme.BLACK)
        isClickable = true // swallows the page's touches while it shows
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES

        panel.orientation = LinearLayout.VERTICAL
        panel.gravity = Gravity.CENTER_HORIZONTAL
        title.apply {
            text = "Error - unable to continue!"
            font = RSTheme.Font.BOLD12
            scale = 2f
            textColor = RSTheme.YELLOW
        }
        message.apply {
            font = RSTheme.Font.PLAIN12
            textColor = RSTheme.WHITE
            alignment = Layout.Alignment.ALIGN_CENTER
            maxLines = 8
            lineHeightDp = 18f
            ellipsize = TextUtils.TruncateAt.END
        }
        button.apply {
            id = R.id.cover_retry
            font = RSTheme.Font.BOLD12
            textColor = RSTheme.WHITE
            alignment = Layout.Alignment.ALIGN_CENTER
            isClickable = true
            isFocusable = true
            minimumWidth = dp(147)
            minimumHeight = dp(41)
            setPadding(dp(14), dp(12), dp(14), dp(12))
            // (the pressed look 20 % brighter, from the view's own pressed state while a finger is on it)
            background = StateListDrawable().apply {
                addState(intArrayOf(android.R.attr.state_pressed), RSTheme.titleButtonImage(pressed = true, density = density))
                addState(intArrayOf(), RSTheme.titleButtonImage(pressed = false, density = density))
            }
            setOnClickListener {
                val run = action
                action = null
                run?.invoke()
            }
        }
        panel.addView(title, LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        panel.addView(message, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })
        panel.addView(button, LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) })
        addView(panel, LayoutParams(dp(520), LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        panel.visibility = GONE
        visibility = GONE
    }

    override fun render(state: CoverState, animated: Boolean) {
        shownState = state
        animate().cancel()
        when (state) {
            CoverState.Hidden -> {
                action = null
                isClickable = false
                if (animated && visibility == VISIBLE) {
                    animate().alpha(0f).setDuration(250).setListener(object : AnimatorListenerAdapter() {
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
                panel.visibility = GONE
                appear()
            }
            is CoverState.Error -> {
                message.text = state.message
                button.text = state.button
                button.contentDescription = state.button
                action = state.action
                panel.visibility = VISIBLE
                appear()
                // (a pane title change is announced: iOS posts screenChanged to the title)
                accessibilityPaneTitle = "Error - unable to continue! ${state.message}"
                title.sendAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_FOCUSED)
            }
        }
    }

    private fun appear() {
        alpha = 1f
        visibility = VISIBLE
        isClickable = true
        // (not brought to the front: it is added last, and a notice shown just before a reload stays on top of it)
    }

    override fun notice(text: String, durationMs: Long) {
        val host = parent as? FrameLayout ?: return
        val label = RSTextView(context).apply {
            this.text = text
            font = RSTheme.Font.PLAIN12
            textColor = RSTheme.YELLOW
            alignment = Layout.Alignment.ALIGN_CENTER
            maxLines = 4
            setPadding(dp(16), dp(10), dp(16), dp(10))
            background = GradientDrawable().apply {
                setColor(0xCC000000.toInt())
                setStroke(dp(1), RSTheme.MENU)
            }
            alpha = 0f
        }
        // centred, its top 14 dp below the safe area, at most 80 % of the width (Notice in LoadingOverlay.swift)
        val safeTop = rootWindowInsets?.displayCutout?.safeInsetTop ?: 0
        label.maxWidthPx = (host.width * 0.8f).roundToInt().takeIf { it > 0 } ?: Int.MAX_VALUE
        host.addView(label, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER_HORIZONTAL or Gravity.TOP).apply {
            topMargin = safeTop + dp(14)
        })
        label.animate().alpha(1f).setDuration(200).withEndAction {
            label.animate().alpha(0f).setStartDelay(durationMs).setDuration(400).withEndAction { host.removeView(label) }
        }
    }

    private fun dp(value: Int): Int = (value * density).roundToInt()
}
