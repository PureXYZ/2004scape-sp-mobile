// OnlineServer: the server a page load plays on (ports ios/LostCity/OnlineServer.swift; docs/ARCHITECTURE.md §3.1, §7.2,
// docs/ANDROID.md §7). `settings.server` names an entry of `settings.servers` (`{id, name, url, nodeId, members, rsa,
// added}`, kept by the page). Anything else is offline, and every route and socket is as it was before online mode.
//
// Native re-validates what the page stored: the id must be a plain file name (it names the server's cache folder and its
// password files) and the URL must pass `normalize`, the page's rules (web/host/serverurl.js; OnlineServerTest runs the
// shared vectors in web/test/online/serverurl-vectors.json): `192.168.1.20` → `http://192.168.1.20`,
// `wss://Scape.Example.com/game/` → `https://scape.example.com/game`. No host is refused or treated differently.
//
// Pure Kotlin (the JVM unit tests run it).
package io.github.purexyz.scape2004

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import java.util.Locale
import java.util.zip.CRC32

data class OnlineServer(
    val id: String,
    val name: String,
    /** The normalized base URL, without a trailing `/` (`http://192.168.1.20`, `https://scape.example.com/game`). */
    val base: String,
) {
    /** `<base>/<path>` (`path` without a leading `/`). */
    fun url(path: String): String = "$base/$path"

    /** The game's WebSocket: the base URL with `http` → `ws`, `https` → `wss`, the same host, port and path (or `/`). */
    val socketUrl: String
        get() {
            val secure = base.startsWith("https://")
            val rest = base.removePrefix(if (secure) "https://" else "http://")
            return (if (secure) "wss://" else "ws://") + rest + if (rest.contains('/')) "" else "/"
        }

    /** The host and port, for logs. */
    val displayHost: String get() = base.substringAfter("://").substringBefore('/')

    /** The host alone, without brackets (an IPv6 literal) or port. */
    val host: String
        get() {
            val authority = displayHost
            return if (authority.startsWith("[")) authority.substring(1, authority.indexOf(']')) else authority.substringBefore(':')
        }

    companion object {
        /** The server this settings object plays on, or null (offline). */
        fun current(settings: JsonObject): OnlineServer? {
            val id = settings.string("server") ?: return null
            if (id == "offline") return null
            val entry = entry(id, settings) ?: return null
            val base = entry.string("url")?.let(::normalize) ?: return null
            val name = entry.string("name")?.takeIf { it.isNotEmpty() } ?: base
            return OnlineServer(id, name, base)
        }

        /** The entry of `settings.servers` with this id (and a usable id), or null. */
        fun entry(id: String, settings: JsonObject): JsonObject? {
            if (!isValidId(id)) return null
            return (settings["servers"] as? JsonArray)?.firstOrNull { (it as? JsonObject)?.string("id") == id } as? JsonObject
        }

        /** The ids of `settings.servers` that native can use. */
        fun ids(settings: JsonObject): Set<String> =
            (settings["servers"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.string("id") }.filter(::isValidId).toSet()

        /**
         * A server id names a cache folder and a password folder: 1-64 letters, digits, `-` or `_` (the page's ids are
         * `s-` and 8 base36 characters).
         */
        fun isValidId(id: String): Boolean = id.length in 1..64 && id.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '-' || it == '_' }

        /**
         * An address as the player typed it (`host`, `host:port`, `http(s)://…`, `ws(s)://…`, an optional path) as a base
         * URL, or null when it cannot be one: web/host/serverurl.js's `normalize`, rule for rule. `ws` → `http`, `wss` →
         * `https`, no scheme → `http`; the host is lower-cased (a name of letters, digits, `-`, `_` and dots, or an IPv6
         * address in brackets); the default port (80, 443) is dropped; the path keeps its segments but not a trailing
         * `/`; query and fragment are dropped. Credentials, other schemes, a port that is empty or outside 1-65535, `.` or
         * `..` segments and spaces are refused.
         */
        fun normalize(typed: String): String? {
            var rest = typed.trim()
            var scheme = "http"
            SCHEME.find(rest)?.let { prefix ->
                scheme = when (prefix.groupValues[1].lowercase(Locale.ROOT)) {
                    "http", "ws" -> "http"
                    "https", "wss" -> "https"
                    else -> return null
                }
                rest = rest.substring(prefix.value.length)
            }
            val end = rest.indexOfFirst { it == '/' || it == '?' || it == '#' }
            val authority = if (end < 0) rest else rest.substring(0, end)
            var path = if (end < 0) "" else rest.substring(end)
            if (authority.isEmpty() || authority.contains('@')) return null

            val host: String
            var port: String? = null
            if (authority.startsWith("[")) {
                val close = authority.indexOf(']')
                val inner = if (close > 0) authority.substring(1, close) else ""
                if (!IPV6.matches(inner) || !inner.contains(':')) return null
                host = "[${inner.lowercase(Locale.ROOT)}]"
                val after = authority.substring(close + 1)
                if (after.isNotEmpty()) {
                    if (!after.startsWith(":")) return null
                    port = after.substring(1)
                }
            } else {
                val parts = authority.split(':')
                if (parts.size > 2) return null // (an IPv6 address needs its brackets)
                host = parts[0].lowercase(Locale.ROOT)
                port = parts.getOrNull(1)
                val labels = (if (host.endsWith(".")) host.dropLast(1) else host).split('.')
                if (host.length > 253 || !labels.all(LABEL::matches)) return null
            }
            var portText = ""
            if (port != null) {
                if (!PORT.matches(port)) return null
                val number = port.toInt()
                if (number !in 1..65535) return null
                if (number != (if (scheme == "http") 80 else 443)) portText = ":$number"
            }
            path = path.replace(QUERY, "").trimEnd('/')
            if (path.isNotEmpty() && (!PATH.matches(path) || path.split('/').any { it == "." || it == ".." })) return null
            return "$scheme://$host$portText$path"
        }

        private val SCHEME = Regex("^([A-Za-z][A-Za-z0-9+.-]*)://")
        private val IPV6 = Regex("^[0-9A-Fa-f:.]+$")
        private val LABEL = Regex("^[a-z0-9_-]{1,63}$")
        private val PORT = Regex("^[0-9]{1,5}$")
        private val QUERY = Regex("[?#].*$")
        private val PATH = Regex("^(/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)+$")
    }
}

/** The CRC-32 the game writes in `/crc` and in the archives' names (IEEE, as zlib), as a signed 32-bit value. */
object GameCrc {
    fun checksum(data: ByteArray): Int = CRC32().apply { update(data) }.value.toInt()

    /**
     * The 9 archive CRCs of a `/crc` table (40 bytes, big-endian), or null unless its trailer is the client's own check:
     * 1234, then `(c << 1) + crc[i]` over the 9 entries (Client.ts `getJagChecksums`).
     */
    fun table(data: ByteArray): IntArray? {
        if (data.size != 40) return null
        val values = IntArray(10) { i ->
            ((data[i * 4].toInt() and 0xff) shl 24) or ((data[i * 4 + 1].toInt() and 0xff) shl 16) or
                ((data[i * 4 + 2].toInt() and 0xff) shl 8) or (data[i * 4 + 3].toInt() and 0xff)
        }
        var check = 1234
        for (i in 0 until 9) check = (check shl 1) + values[i]
        return if (check == values[9]) values.copyOf(9) else null
    }
}
