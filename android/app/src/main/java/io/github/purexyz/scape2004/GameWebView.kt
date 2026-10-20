// GameWebView: the one WebView the game runs in, and how it is set up (the WKWebView configuration and hardening of
// GameViewController.swift's makeWebView).
//
// It is created on a MutableContextWrapper and owned by the process-scoped GameSession, so a recreated activity re-attaches
// it (its wrapper pointed at the new activity) and the game is never reloaded by a configuration change.
//
// It never takes focus: the keyboard bridge's own view holds focus (the iOS first responder that never resigns), so a tap
// on the game can never close the keyboard, hardware keys reach the bridge whatever DOM element has focus, and Chromium
// never shows its own IME. Long-press is the game's (its options menu): no selection, action mode, context menu, drag
// or system haptic.
package io.github.purexyz.scape2004

import android.annotation.SuppressLint
import android.content.MutableContextWrapper
import android.graphics.Color
import android.view.ActionMode
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

@SuppressLint("ViewConstructor")
class GameWebView(val wrapper: MutableContextWrapper) : WebView(wrapper) {
    /** Never an input target: the keyboard bridge is. */
    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? = null

    override fun onCheckIsTextEditor(): Boolean = false

    /** No floating text toolbar (iOS: isTextInteractionEnabled = false). */
    override fun startActionMode(callback: ActionMode.Callback?): ActionMode? = null

    override fun startActionMode(callback: ActionMode.Callback?, type: Int): ActionMode? = null

    override fun performLongClick(): Boolean = true

    companion object {
        /**
         * A configured WebView: settings, view flags, debugging (debug builds). The listener, scripts and clients are
         * GameSession's (it owns what they call).
         */
        @SuppressLint("SetJavaScriptEnabled")
        fun create(wrapper: MutableContextWrapper): GameWebView {
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG) // chrome://inspect and the CDP tests (android/test)
            val web = GameWebView(wrapper)
            web.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true // localStorage (chips, command history), sessionStorage (lostcity.notice)
                mediaPlaybackRequiresUserGesture = false // the title music without a tap (WKWebView: no user action)
                allowFileAccess = false
                allowContentAccess = false
                textZoom = 100 // never follow the system font scale: the HUD's text is in fixed px, as iOS ignores Dynamic Type
                setSupportZoom(false)
                builtInZoomControls = false
                displayZoomControls = false
                useWideViewPort = true
                loadWithOverviewMode = false
                javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false)
                setGeolocationEnabled(false)
                cacheMode = WebSettings.LOAD_NO_CACHE // every response is no-store anyway
                safeBrowsingEnabled = false // offline: never look anything up (also the manifest's meta-data)
                disabledActionModeMenuItems = WebSettings.MENU_ITEM_SHARE or WebSettings.MENU_ITEM_WEB_SEARCH or
                    WebSettings.MENU_ITEM_PROCESS_TEXT
            }
            if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
                WebSettingsCompat.setAlgorithmicDarkeningAllowed(web.settings, false) // the 2004 colours, in dark mode too
            }
            web.apply {
                setBackgroundColor(Color.BLACK) // black, never white, before the first paint
                isForceDarkAllowed = false
                overScrollMode = View.OVER_SCROLL_NEVER
                isVerticalScrollBarEnabled = false
                isHorizontalScrollBarEnabled = false
                isFocusable = false
                isFocusableInTouchMode = false
                defaultFocusHighlightEnabled = false
                isLongClickable = false
                setOnLongClickListener { true }
                isHapticFeedbackEnabled = false // the game plays its own (Chromium's long-press must not add one)
                isSoundEffectsEnabled = false
                setOnDragListener { _, _ -> true } // nothing is dropped into the page
                setOnCreateContextMenuListener(null)
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
                // the renderer is the first thing the low-memory killer takes on a small phone: keep it important while
                // the game is on screen (waived when it is not)
                setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true)
            }
            return web
        }

        /** The features the shell cannot work without. */
        val requiredFeatures = listOf(WebViewFeature.DOCUMENT_START_SCRIPT, WebViewFeature.WEB_MESSAGE_LISTENER)
    }
}
