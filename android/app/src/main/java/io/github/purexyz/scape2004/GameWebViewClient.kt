// GameWebViewClient: requests, navigation, load failures and renderer death (the WKURLSchemeHandler registration and the
// WKNavigationDelegate of GameViewController.swift; docs/ANDROID.md §1 Origin, §3.2, §3.4,
// §2.4 b, §3.8).
//
// * shouldInterceptRequest → AssetRouter, for every request of the page, its worker and its iframe,
//   on Chromium's thread pool. Any other http(s) host gets 403; data: and blob: are left to WebView.
// * shouldOverrideUrlLoading: the game's origin, about:, blob: and data: load; an http(s) or mailto link the player tapped
//   opens outside the app; anything else is blocked.
// * onPageStarted is iOS's didCommit (a new document, also a reload the page made itself), onPageFinished its didFinish.
// * A failed load of the game's page is native's error screen (there is no page to show one); a failed subresource is
//   only logged (verbose).
// * onRenderProcessGone always returns true (the app must not crash with its renderer); GameSession replaces the dead
//   WebView and applies iOS's WebContent-crash policy.
//
// Callbacks from a WebView that is no longer the session's (one replaced after a renderer crash) are ignored.
package io.github.purexyz.scape2004

import android.graphics.Bitmap
import android.net.Uri
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream
import java.io.InputStream

class GameWebViewClient(private val session: GameSession, private val router: AssetRouter) : WebViewClient() {
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        val scheme = url.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null // data:, blob:, about: (file: and content: are off)
        val started = System.nanoTime()
        val routed = RouterRequest(
            method = request.method ?: "GET",
            scheme = scheme,
            host = url.host ?: "",
            encodedPath = url.encodedPath ?: "/",
            encodedQuery = url.encodedQuery,
            headers = request.requestHeaders ?: emptyMap(),
        )
        val reply = try {
            router.handle(routed)
        } catch (error: Throwable) {
            Log.info("scheme", "${routed.method} ${routed.displayPath} threw $error")
            RouterReply.text(500, "internal error: $error")
        }
        if (Log.verbose || reply.status >= 400) {
            val ms = (System.nanoTime() - started) / 1e6
            Log.info("scheme", "${routed.method} ${routed.displayPath.take(300)} → ${reply.status} ${String.format(java.util.Locale.ROOT, "%.1f", ms)} ms")
        }
        return response(reply)
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        val text = url.toString()
        val scheme = url.scheme?.lowercase()
        return when {
            text.startsWith(AssetRouter.ORIGIN + "/") || text == AssetRouter.ORIGIN -> false
            scheme == "about" || scheme == "blob" || scheme == "data" -> false
            scheme == "http" || scheme == "https" || scheme == "mailto" -> {
                // everything the game needs is in the app; a link the player taps opens in the browser
                if (request.hasGesture() && request.isForMainFrame) session.openExternally(url) else Log.info("host", "blocked navigation to $text")
                true
            }
            else -> {
                Log.info("host", "blocked navigation to $text")
                true
            }
        }
    }

    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        if (view !== session.webView || url == null || !url.startsWith(AssetRouter.ORIGIN)) return
        session.pageStarted(url)
    }

    override fun onPageFinished(view: WebView, url: String?) {
        if (view !== session.webView || url == null || !url.startsWith(AssetRouter.ORIGIN)) return
        session.pageFinished(url)
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (view !== session.webView) return
        val description = error.description?.toString() ?: "error ${error.errorCode}"
        // a load superseded by another (a quick restart) is not a failure
        if (error.errorCode == ERROR_UNKNOWN && description.contains("ERR_ABORTED")) return
        if (request.isForMainFrame && session.isGameLoad(request.url)) {
            session.gameLoadFailed(description)
        } else {
            Log.debug("host") { "navigation failed (page unaffected): ${error.errorCode} $description ${request.url}" }
        }
    }

    override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
        if (view !== session.webView) return
        if (request.isForMainFrame && session.isGameLoad(request.url)) {
            session.gameLoadFailed("HTTP ${errorResponse.statusCode}")
        } else {
            Log.debug("host") { "navigation failed (page unaffected): HTTP ${errorResponse.statusCode} ${request.url}" }
        }
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        session.rendererGone(view, detail.didCrash(), detail.rendererPriorityAtExit())
        return true
    }

    companion object {
        /**
         * The router's reply as WebView takes it: MIME type and charset apart, a non-empty reason phrase, a stream.
         *
         * Chromium's stream loader (android_stream_reader_url_loader) adds a Content-Length of its own, the stream's
         * available(), before the headers given here, so the router's Content-Length as well reached the page as
         * "1257, 1257" (and a HEAD as "0, 8388731": android/test/drive.mjs's MIME and HEAD checks). The length is left
         * to Chromium when the stream reports the router's: always for bytes and for stored assets (AssetFileDescriptor's
         * stream counts down its declared length). A HEAD reply's stream reports the resource's length and yields no byte.
         */
        fun response(reply: RouterReply): WebResourceResponse {
            val (mime, charset) = Mime.split(reply.contentType ?: Mime.TEXT)
            val stream: InputStream = when (val body = reply.body) {
                is RouterReply.Body.Bytes -> ByteArrayInputStream(body.data)
                is RouterReply.Body.Stream -> body.stream
                is RouterReply.Body.Headers -> HeadStream(body.length)
            }
            val headers = LinkedHashMap(reply.allHeaders())
            val available = try {
                stream.available().toLong()
            } catch (_: java.io.IOException) {
                -1L
            }
            if (available == reply.contentLength) headers.remove("Content-Length")
            return WebResourceResponse(mime, charset, reply.status, reply.reason, headers, stream)
        }

        /** The URL without its query and fragment, for comparing with the game's index. */
        fun withoutQuery(uri: Uri): String = uri.buildUpon().clearQuery().fragment(null).build().toString()
    }
}

/** A HEAD reply's body: nothing to read, but the resource's length available, which Chromium takes as Content-Length. */
private class HeadStream(private val length: Long) : InputStream() {
    override fun read(): Int = -1

    override fun read(b: ByteArray, off: Int, len: Int): Int = -1

    override fun available(): Int = length.coerceIn(0L, Int.MAX_VALUE.toLong()).toInt()
}
