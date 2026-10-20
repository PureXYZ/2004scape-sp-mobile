// AssetRouter: serves the origin https://appassets.androidplatform.net (ports AssetSchemeHandler.swift's Router;
// ARCHITECTURE.md §3, docs/ANDROID.md §1 Origin and §3.2):
//
// | Method          | Path               | Behaviour                                                              |
// |-----------------|--------------------|------------------------------------------------------------------------|
// | GET/HEAD        | `/<file>`          | bundle `Game/<file>` (`/` → `index.html`), 404 if missing               |
// | GET/HEAD        | `/save/<relpath>`  | `Documents/<relpath>` → 200 bytes / 404                                |
// | PUT/POST        | `/save/<relpath>`  | atomic write, previous version kept as `.bak` → 204 / 400 / 413 / 500   |
// | DELETE          | `/save/<relpath>`  | 204 / 404 (the deleted file is kept as `.bak`)                         |
// | GET/HEAD        | `/save-index`      | JSON `[{modified, path, size}]` of everything under Documents           |
// | POST/PUT        | `/log`             | text line(s) → native log (for workers) → 204                          |
//
// shouldInterceptRequest never sees a request body, so on Android every write carries its bytes base64url (no padding) in
// the X-LC-Body header with their count in X-LC-Length, and sends no body (docs/ANDROID.md §3.2; runtime/xhr.ts does it in
// the engine worker). The checks, in order, as web/test/serve.mjs makes them: X-LC-Length missing or not a decimal
// count → 400; above 32 MiB → 413, before anything is decoded; X-LC-Body not base64url without padding → 400; decoded
// size ≠ X-LC-Length → 400. Then the bytes go through the iOS rules (an empty write → 400, identical bytes skipped, .bak).
//
// Every response has a non-empty reason phrase (WebResourceResponse throws on an empty one), Cache-Control: no-store,
// Access-Control-Allow-Origin: * and a Content-Length. A request to any other http(s) host is answered 403: the game never
// touches the network (iOS gets that for free from its custom scheme).
//
// Threading: Chromium calls shouldInterceptRequest on its own thread pool (also for the engine worker's synchronous XHRs),
// several at a time, and may block there; nothing here touches the UI thread. The router is stateless apart from the
// bundle (immutable) and SaveStore (locked).
//
// Pure Kotlin (no android.webkit types), so the JVM unit tests drive it directly; GameWebViewClient converts
// WebResourceRequest/WebResourceResponse.
package io.github.purexyz.scape2004

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.Base64
import java.util.Locale

/** The parts of a WebResourceRequest the router needs. */
class RouterRequest(
    method: String,
    scheme: String,
    host: String,
    /** The path as it is in the URL (still percent-encoded). */
    val encodedPath: String,
    /** The query as it is in the URL, without `?`, or null. */
    val encodedQuery: String?,
    headers: Map<String, String> = emptyMap(),
) {
    val method = method.uppercase(Locale.ROOT)
    val scheme = scheme.lowercase(Locale.ROOT)
    val host = host.lowercase(Locale.ROOT)
    private val headers = headers.mapKeys { it.key.lowercase(Locale.ROOT) }

    /** A request header, by any case (Chromium may change it). */
    fun header(name: String): String? = headers[name.lowercase(Locale.ROOT)]

    val query: Map<String, String> by lazy { PercentDecoding.query(encodedQuery) }

    /** For log lines: the path and query as requested. */
    val displayPath: String get() = encodedPath + (encodedQuery?.let { "?$it" } ?: "")
}

/** A response: status, Content-Type (null for none), extra headers and the body. */
class RouterReply(
    val status: Int,
    val contentType: String? = null,
    val headers: Map<String, String> = emptyMap(),
    val body: Body = Body.Bytes(ByteArray(0)),
) {
    sealed interface Body {
        class Bytes(val data: ByteArray) : Body

        /** A bundle file, streamed by Chromium. */
        class Stream(val stream: InputStream, val length: Long) : Body

        /** A HEAD reply: the resource's length, no body. */
        class Headers(val length: Long) : Body
    }

    val contentLength: Long
        get() = when (body) {
            is Body.Bytes -> body.data.size.toLong()
            is Body.Stream -> body.length
            is Body.Headers -> body.length
        }

    val reason: String get() = reasonPhrase(status)

    /** Every header the response carries besides Content-Type (which WebResourceResponse takes on its own). */
    fun allHeaders(): Map<String, String> = LinkedHashMap(headers).apply {
        this["Cache-Control"] = "no-store"
        this["Access-Control-Allow-Origin"] = "*"
        this["Content-Length"] = contentLength.toString()
    }

    companion object {
        fun empty(status: Int, headers: Map<String, String> = emptyMap()) = RouterReply(status, headers = headers)

        /** `text/plain; charset=utf-8` with the message and a newline, as the iOS router's `.text`. */
        fun text(status: Int, message: String, headers: Map<String, String> = emptyMap()) =
            RouterReply(status, Mime.TEXT, headers, Body.Bytes("$message\n".toByteArray(Charsets.UTF_8)))

        fun data(data: ByteArray, type: String) = RouterReply(200, type, body = Body.Bytes(data))

        /** The phrases WebResourceResponse is given (it refuses an empty one). */
        fun reasonPhrase(status: Int): String = when (status) {
            200 -> "OK"
            204 -> "No Content"
            400 -> "Bad Request"
            403 -> "Forbidden"
            404 -> "Not Found"
            405 -> "Method Not Allowed"
            413 -> "Content Too Large"
            500 -> "Internal Server Error"
            else -> if (status in 200..299) "OK" else "Error"
        }
    }
}

class AssetRouter(private val assets: AssetSource, private val saves: SaveStore) {
    fun handle(request: RouterRequest): RouterReply {
        if (request.host != HOST || request.scheme != "https") {
            // (only http(s) requests reach the router: GameWebViewClient leaves data: and blob: to WebView)
            Log.info("scheme", "blocked ${request.scheme}://${request.host}${request.displayPath}")
            return RouterReply.empty(403)
        }
        val path = PercentDecoding.path(request.encodedPath) ?: return RouterReply.text(400, "malformed path")
        return when {
            path == "/save-index" -> saveIndex(request)
            path == "/log" -> log(request)
            path.startsWith("/save/") -> save(request, path.removePrefix("/save/"))
            else -> bundleFile(request, path)
        }
    }

    // ------------------------------------------------------------------------------------------------ bundle files

    private fun bundleFile(request: RouterRequest, path: String): RouterReply {
        if (request.method != "GET" && request.method != "HEAD") {
            return RouterReply.text(405, "method not allowed", mapOf("Allow" to "GET, HEAD"))
        }
        var relative = path.trimStart('/')
        if (relative.isEmpty() || relative.endsWith("/")) relative += "index.html"
        val parts = relative.split('/')
        if (parts.any { it.isEmpty() || it == "." || it == ".." || it.contains('\u0000') }) {
            return RouterReply.text(400, "invalid path")
        }
        val asset = assets.open(relative) ?: return RouterReply.text(404, "not found: $path")
        val type = Mime.forExtension(Mime.extensionOf(relative))
        if (request.method == "HEAD") {
            asset.stream.close()
            return RouterReply(200, type, body = RouterReply.Body.Headers(asset.length))
        }
        return RouterReply(200, type, body = RouterReply.Body.Stream(asset.stream, asset.length))
    }

    // ------------------------------------------------------------------------------------------------ saves

    private fun save(request: RouterRequest, relative: String): RouterReply {
        try {
            return when (request.method) {
                "GET" -> RouterReply.data(saves.read(relative), Mime.OCTET_STREAM)
                "HEAD" -> RouterReply(200, Mime.OCTET_STREAM, body = RouterReply.Body.Headers(saves.info(relative).size))
                "PUT", "POST" -> {
                    val body = when (val decoded = BodyHeader.decode(request)) {
                        is BodyHeader.Decoded.Refused -> {
                            Log.info("save", "${request.method} $relative: ${decoded.message}")
                            return RouterReply.text(decoded.status, decoded.message)
                        }
                        // shouldInterceptRequest has no request bodies: a write without X-LC-Body arrives empty
                        BodyHeader.Decoded.Absent -> ByteArray(0)
                        is BodyHeader.Decoded.Bytes -> decoded.data
                    }
                    val started = System.nanoTime()
                    saves.write(relative, body)
                    val ms = (System.nanoTime() - started) / 1e6
                    Log.info("save", "${request.method} $relative ${body.size} B → 204 (${String.format(Locale.ROOT, "%.1f", ms)} ms)")
                    RouterReply.empty(204)
                }
                "DELETE" -> {
                    saves.delete(relative)
                    val kept = if (relative.endsWith(SaveStore.BACKUP_SUFFIX)) "" else " (kept as $relative${SaveStore.BACKUP_SUFFIX})"
                    Log.info("save", "DELETE $relative → 204$kept")
                    RouterReply.empty(204)
                }
                "OPTIONS" -> RouterReply.empty(204, mapOf("Allow" to SAVE_METHODS))
                else -> RouterReply.text(405, "method not allowed", mapOf("Allow" to SAVE_METHODS))
            }
        } catch (failure: SaveStore.Failure) {
            return when (failure) {
                SaveStore.Failure.InvalidPath -> RouterReply.text(400, "invalid save path: $relative")
                SaveStore.Failure.NotFound -> RouterReply.text(404, "no such save: $relative")
                SaveStore.Failure.EmptyBody -> {
                    Log.info("save", "${request.method} $relative: refused empty body (shouldInterceptRequest has no request bodies: send the bytes in X-LC-Body)")
                    RouterReply.text(400, "empty body (send the bytes in X-LC-Body with X-LC-Length)")
                }
                is SaveStore.Failure.Io -> {
                    Log.info("save", "${request.method} $relative FAILED: ${failure.message}")
                    RouterReply.text(500, failure.message ?: "write failed")
                }
            }
        }
    }

    private fun saveIndex(request: RouterRequest): RouterReply {
        if (request.method != "GET" && request.method != "HEAD") {
            return RouterReply.text(405, "method not allowed", mapOf("Allow" to "GET, HEAD"))
        }
        // [{"modified":…,"path":"…","size":…}]: sorted keys, '/' not escaped (JSONEncoder with .sortedKeys and
        // .withoutEscapingSlashes on iOS; kotlinx never escapes '/', unlike org.json)
        val json = try {
            JsonArray(saves.index().map { entry ->
                buildJsonObject {
                    put("modified", JsonPrimitive(entry.modified))
                    put("path", JsonPrimitive(entry.path))
                    put("size", JsonPrimitive(entry.size))
                }
            }).toString()
        } catch (_: Exception) {
            "[]"
        }
        val reply = RouterReply.data(json.toByteArray(Charsets.UTF_8), Mime.JSON)
        return if (request.method == "HEAD") RouterReply(200, Mime.JSON, body = RouterReply.Body.Headers(reply.contentLength)) else reply
    }

    // ------------------------------------------------------------------------------------------------ log

    /**
     * Workers have no message handler; they POST their console output here. The text comes in X-LC-Body (or `?text=`),
     * since there is no body on Android. Optional query: `?src=<tag>&level=<level>` (default tag `worker`).
     */
    private fun log(request: RouterRequest): RouterReply {
        if (request.method != "POST" && request.method != "PUT") {
            return RouterReply.text(405, "method not allowed", mapOf("Allow" to "POST, PUT"))
        }
        val text = when (val decoded = BodyHeader.decode(request)) {
            is BodyHeader.Decoded.Refused -> return RouterReply.text(decoded.status, decoded.message)
            is BodyHeader.Decoded.Bytes -> String(decoded.data, Charsets.UTF_8)
            BodyHeader.Decoded.Absent -> request.query["text"] ?: ""
        }
        val source = request.query["src"]?.takeIf { it.isNotEmpty() } ?: "worker"
        val level = request.query["level"]?.takeIf { it.isNotEmpty() && it != "log" && it != "info" }
        val tag = if (level != null) "$source:$level" else source
        for (line in text.split('\n', '\r')) {
            if (line.isNotEmpty()) Log.write("[$tag] $line")
        }
        return RouterReply.empty(204)
    }

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$HOST"
        const val INDEX_URL = "$ORIGIN/index.html"
        private const val SAVE_METHODS = "GET, HEAD, PUT, POST, DELETE"
    }
}

/** A write's bytes from the X-LC-Body / X-LC-Length request headers (docs/ANDROID.md §3.2). */
object BodyHeader {
    /** The largest write taken (bots.sav is about 1.2 MB at most); 413 above it. */
    const val MAX_BYTES = 32L * 1024 * 1024

    sealed interface Decoded {
        /** No X-LC-Body: the request has no bytes (shouldInterceptRequest never sees a body). */
        data object Absent : Decoded
        class Bytes(val data: ByteArray) : Decoded
        class Refused(val status: Int, val message: String) : Decoded
    }

    private val lengthPattern = Regex("^\\d{1,15}$")
    private val base64urlPattern = Regex("^[A-Za-z0-9_-]*$")

    fun decode(request: RouterRequest): Decoded = decode(request.header("X-LC-Body"), request.header("X-LC-Length"))

    fun decode(encoded: String?, lengthHeader: String?): Decoded {
        if (encoded == null) return Decoded.Absent
        if (lengthHeader == null || !lengthPattern.matches(lengthHeader)) {
            return Decoded.Refused(400, "X-LC-Body without a valid X-LC-Length")
        }
        val length = lengthHeader.toLong()
        if (length > MAX_BYTES) return Decoded.Refused(413, "too large ($length bytes, at most $MAX_BYTES)")
        if (!base64urlPattern.matches(encoded) || encoded.length % 4 == 1) {
            return Decoded.Refused(400, "X-LC-Body is not base64url without padding")
        }
        val data = try {
            Base64.getUrlDecoder().decode(encoded)
        } catch (_: IllegalArgumentException) {
            return Decoded.Refused(400, "X-LC-Body is not base64url without padding")
        }
        if (data.size.toLong() != length) {
            return Decoded.Refused(400, "X-LC-Length $length does not match the ${data.size} bytes of X-LC-Body")
        }
        return Decoded.Bytes(data)
    }
}

/** Percent-decoding for the router (the iOS `removingPercentEncoding`: exactly once, strictly). */
object PercentDecoding {
    /**
     * The path decoded once, or null for an invalid escape (`%` not followed by two hex digits) or bytes that are not
     * UTF-8. `+` stays `+` (unlike URLDecoder), so `..%2F` is caught by the component checks after it.
     */
    fun path(encoded: String): String? = decode(encoded, plusIsSpace = false)

    /** `a=1&b=2` → map (the last of a repeated name wins, as the iOS query loop); `+` is a space, as URLSearchParams. */
    fun query(encoded: String?): Map<String, String> {
        if (encoded.isNullOrEmpty()) return emptyMap()
        val result = LinkedHashMap<String, String>()
        for (item in encoded.split('&')) {
            if (item.isEmpty()) continue
            val eq = item.indexOf('=')
            val name = if (eq < 0) item else item.substring(0, eq)
            val value = if (eq < 0) "" else item.substring(eq + 1)
            result[decode(name, true) ?: name] = decode(value, true) ?: value
        }
        return result
    }

    private fun decode(encoded: String, plusIsSpace: Boolean): String? {
        if (encoded.indexOf('%') < 0 && !(plusIsSpace && encoded.indexOf('+') >= 0)) return encoded
        val bytes = ByteArrayOutputStream(encoded.length)
        var i = 0
        while (i < encoded.length) {
            val c = encoded[i]
            when {
                c == '%' -> {
                    if (i + 2 >= encoded.length) return null
                    val high = Character.digit(encoded[i + 1], 16)
                    val low = Character.digit(encoded[i + 2], 16)
                    if (high < 0 || low < 0) return null
                    bytes.write(high * 16 + low)
                    i += 3
                    continue
                }
                c == '+' && plusIsSpace -> bytes.write(' '.code)
                else -> {
                    // (a raw non-ASCII character: its UTF-8 bytes; a surrogate pair is taken whole)
                    val end = if (Character.isHighSurrogate(c) && i + 1 < encoded.length) i + 2 else i + 1
                    bytes.write(encoded.substring(i, end).toByteArray(Charsets.UTF_8))
                    i = end
                    continue
                }
            }
            i++
        }
        return try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes.toByteArray()))
                .toString()
        } catch (_: CharacterCodingException) {
            null
        }
    }
}
