// NativeScripts: the document-start scripts and the page → native listener (the WKUserScripts and script message handlers
// of GameViewController.swift; docs/ANDROID.md §3.1).
//
// * One WebMessageListener object, `lcAndroid`, for the game's origin. Messages are taken from the main frame only (the
//   World map's same-origin iframe gets the object too, and is ignored, as WKWebView's handlers are main-frame here).
// * The bridge script defines `window.LostCityNativeBridge = {native: {postMessage}, log: {postMessage}}`, which posts
//   JSON.stringify({ch: 'native'|'log', msg}) to lcAndroid. host.js picks its handlers from
//   `window.webkit?.messageHandlers ?? window.LostCityNativeBridge`; nothing fakes window.webkit, so iOS keeps its path.
// * The console bridge is iOS's, verbatim apart from where it finds the handler: page console output and uncaught errors
//   go to the native log as `[js:<level>] <text>` (workers relay theirs through the page).
// * `window.LostCityNative = {...}` (AppInfo.pageInfo: the platform, versions, settings, the chat model's status) is
//   re-registered whenever the settings or that status change, so a reload, including the automatic one after a renderer
//   crash, sees current values, as iOS reinstalls its user scripts.
//
// Every script starts with `if (window.top !== window) return`: androidx injects document-start scripts into every frame
// of a matching origin (iOS: forMainFrameOnly). Scripts run in the order they were added; the bridge comes first.
package io.github.purexyz.scape2004

import android.annotation.SuppressLint
import android.webkit.WebView
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.serialization.json.JsonObject

class NativeScripts(private val webView: WebView, private val onMessage: (JsonObject) -> Unit) {
    private var infoHandle: ScriptHandler? = null

    /** The listener and the static scripts; once per WebView, before its first load. */
    @SuppressLint("RequiresFeature") // (checked here, and by GameSession before the WebView was made)
    fun install() {
        check(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            "the WebView has no WebMessageListener or document-start scripts"
        }
        val origins = setOf(AssetRouter.ORIGIN)
        WebViewCompat.addWebMessageListener(webView, LISTENER, origins) { view, message, origin, isMainFrame, _ ->
            if (view !== webView) return@addWebMessageListener
            if (!isMainFrame || origin.toString() != AssetRouter.ORIGIN) {
                Log.debug("host") { "ignored a bridge message from ${if (isMainFrame) origin else "a frame"}" }
                return@addWebMessageListener
            }
            if (message.type != WebMessageCompat.TYPE_STRING) {
                Log.info("host", "ignored a binary bridge message")
                return@addWebMessageListener
            }
            val parsed = message.data?.let(JsonText::parse) as? JsonObject
            if (parsed == null) {
                Log.info("host", "ignored malformed bridge message: ${message.data?.take(200)}")
                return@addWebMessageListener
            }
            onMessage(parsed)
        }
        WebViewCompat.addDocumentStartJavaScript(webView, BRIDGE, origins)
        WebViewCompat.addDocumentStartJavaScript(webView, CONSOLE_BRIDGE, origins)
    }

    /** (Re)registers `window.LostCityNative = <json>` for the next document. */
    @SuppressLint("RequiresFeature") // (install() checked)
    fun setInfo(json: String) {
        infoHandle?.remove()
        infoHandle = WebViewCompat.addDocumentStartJavaScript(webView, "if (window.top === window) window.LostCityNative = $json;", setOf(AssetRouter.ORIGIN))
    }

    companion object {
        /** The WebMessageListener's name in the page (docs/ANDROID.md §3.1). */
        const val LISTENER = "lcAndroid"

        /** The page's message handlers over lcAndroid (iOS: window.webkit.messageHandlers.native / .log). */
        val BRIDGE = """
            (() => {
                if (window.top !== window || window.LostCityNativeBridge) return;
                const channel = window.$LISTENER;
                if (!channel) return;
                const handler = (ch) => Object.freeze({
                    postMessage(msg) {
                        try { channel.postMessage(JSON.stringify({ ch, msg })); } catch (e) {}
                    }
                });
                window.LostCityNativeBridge = Object.freeze({ native: handler('native'), log: handler('log') });
            })();
        """.trimIndent()

        /**
         * GameViewController.swift's consoleBridge: page console output and uncaught errors to the native log, so they
         * appear in logcat without DevTools. Workers have no handler: they POST to /log or relay through the page.
         */
        val CONSOLE_BRIDGE = """
            (() => {
                if (window.top !== window) return;
                const handler = window.webkit?.messageHandlers?.log ?? window.LostCityNativeBridge?.log;
                if (!handler || window.__lcConsoleBridge) return;
                window.__lcConsoleBridge = true;
                const format = (value) => {
                    if (typeof value === 'string') return value;
                    if (value instanceof Error) return value.stack || String(value);
                    if (value !== null && typeof value === 'object') {
                        try { return JSON.stringify(value); } catch { return String(value); }
                    }
                    return String(value);
                };
                const post = (level, args) => {
                    try {
                        let text = Array.prototype.map.call(args, format).join(' ');
                        if (text.length > 16000) text = text.slice(0, 16000) + ' …(truncated)';
                        handler.postMessage({ level, text });
                    } catch {}
                };
                for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
                    const original = console[level];
                    console[level] = function (...args) { original.apply(console, args); post(level, args); };
                }
                addEventListener('error', (e) => post('error', [`Uncaught ${'$'}{e.message} @ ${'$'}{e.filename}:${'$'}{e.lineno}:${'$'}{e.colno}`, e.error?.stack ?? '']));
                addEventListener('unhandledrejection', (e) => post('error', ['Unhandled rejection:', e.reason?.stack ?? String(e.reason)]));
            })();
        """.trimIndent()

        /**
         * GameViewController.swift's loaderDrawn: the page has drawn its own loader (its fonts loaded, its logo decoded,
         * two frames later; 0.8 s at most), so the cover can go without the hand-over showing.
         */
        val LOADER_DRAWN = """
            const drawn = (async () => {
                await document.fonts.ready;
                const logo = new Image();
                logo.src = 'ui/sprites/logo.png';
                await logo.decode().catch(() => {});
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            })();
            await Promise.race([drawn, new Promise((resolve) => setTimeout(resolve, 800))]);
            return true;
        """.trimIndent()
    }
}
