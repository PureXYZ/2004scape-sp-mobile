// Mime: Content-Type by file extension, the table of AssetSchemeHandler.swift's Router.mimeType (ARCHITECTURE.md §3).
// Anything not listed, including the extensionless jag archives and /crc, is
// application/octet-stream. Module scripts and workers are refused unless served as JavaScript, and
// instantiateStreaming needs application/wasm, so this table is load-bearing.
package io.github.purexyz.scape2004

object Mime {
    const val OCTET_STREAM = "application/octet-stream"
    const val TEXT = "text/plain; charset=utf-8"
    const val JSON = "application/json"

    fun forExtension(extension: String): String = when (extension.lowercase()) {
        "html", "htm" -> "text/html; charset=utf-8"
        "js", "mjs" -> "text/javascript; charset=utf-8"
        "wasm" -> "application/wasm"
        "json", "map" -> JSON
        "css" -> "text/css; charset=utf-8"
        "png" -> "image/png"
        "txt" -> TEXT
        "svg" -> "image/svg+xml"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "ico" -> "image/x-icon"
        "wav" -> "audio/wav"
        "woff2" -> "font/woff2"
        "woff" -> "font/woff"
        "ttf" -> "font/ttf"
        else -> OCTET_STREAM
    }

    /** The extension of the last path component ("" for `crc` or `title410306098`, and for a dot-name). */
    fun extensionOf(path: String): String {
        val name = path.substringAfterLast('/')
        val dot = name.lastIndexOf('.')
        return if (dot <= 0) "" else name.substring(dot + 1)
    }

    /**
     * WebResourceResponse takes the MIME type and the charset separately: `text/javascript; charset=utf-8` becomes
     * ("text/javascript", "utf-8").
     */
    fun split(contentType: String): Pair<String, String?> {
        val parts = contentType.split(';').map { it.trim() }
        val charset = parts.drop(1).firstOrNull { it.startsWith("charset=", ignoreCase = true) }?.substringAfter('=')
        return parts[0] to charset
    }
}
