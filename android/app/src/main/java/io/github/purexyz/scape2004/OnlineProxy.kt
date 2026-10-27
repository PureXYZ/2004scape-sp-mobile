// OnlineProxy: the online routes of https://appassets.androidplatform.net (ports ios/LostCity/OnlineProxy.swift;
// docs/ARCHITECTURE.md §3.1, docs/ANDROID.md §7): while the page load plays on a server (OnlineServer), the game's own
// requests for `/crc` and the archives are answered from that server, fetched natively (a page cannot read them itself:
// Engine-TS sends no CORS headers), and its OnDemand files are kept in a native cache.
//
// | Method   | Path                          | Behaviour                                                                    |
// |----------|-------------------------------|------------------------------------------------------------------------------|
// | GET      | `/crc…`                       | `<base>/crc` (10 s), 40 bytes with the client's trailer → 200, else 502       |
// | GET      | `/<archive><crc>`             | bundle `Game/<archive><crc>`, else the cached copy whose CRC-32 is `<crc>`,    |
// |          |                               | else `<base>/<archive><crc>` (30 s), checked, stored, served; else 502         |
// | GET      | `/ondemand/<archive>/<file>`  | the cached OnDemand file → 200, or 404                                        |
// | PUT      | `/ondemand/<archive>/<file>`  | X-LC-Body (1 B - 4 MiB, the page checked it) stored atomically → 204          |
// | GET      | `/server-probe?url=<address>` | in every mode: `/crc`, `/rs2.cgi`, `/client/client.js` of that address → JSON |
//
// A 502's body is one line of plain words the page can show: `unreachable`, `timed out`, `not a 2004scape server`,
// `http <status>`, for an archive `checksum mismatch`, and on Android 17 `local network` (the system refused a local
// address: LocalNetwork). Offline every path but `/server-probe` goes to the bundle routes exactly as before (`handle`
// answers null).
//
// The server of a page load is decided when the router is asked for the main document (`/`, `/index.html`), from the
// stored settings, as iOS decides it on the navigation. The cache is `cacheDir/online/<server id>/` (the system may clear
// it: everything in it can be fetched again): the archives by name, OnDemand files under `od/<archive>/<file>`. An
// archive's name carries its CRC, so a cached one never goes stale; deleting the server deletes its folder.
//
// Runs on Chromium's request threads, several at a time, and may block there (OkHttp's execute(), with a call timeout);
// the server is kept under a lock. Pure Kotlin: the JVM unit tests run it against a local HTTP server.
package io.github.purexyz.scape2004

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.TimeUnit

class OnlineProxy(
    private val assets: AssetSource,
    /** `cacheDir/online` in the app; a temp folder in the tests. */
    val cacheRoot: File,
    /** The stored settings, read when the main document is requested (NativeSettings.values). */
    private val settings: () -> JsonObject,
    private val client: OkHttpClient = Network.client,
    private val localNetwork: LocalNetwork = LocalNetwork.None,
    /** `/crc`, the probe's requests (10 s) and an archive (30 s); shorter in the tests. */
    private val crcTimeoutMs: Long = CRC_TIMEOUT_MS,
    private val archiveTimeoutMs: Long = ARCHIVE_TIMEOUT_MS,
) {
    private val lock = Any()
    private var current: OnlineServer? = null

    /** The server of this page load (null: offline). */
    val server: OnlineServer? get() = synchronized(lock) { current }

    /** The server for the page load that is starting (also called by the main-document route). */
    fun pageLoaded(server: OnlineServer?) {
        synchronized(lock) { current = server }
        Log.info("online", server?.let { "this page plays on ${it.name} (${it.base})" } ?: "this page plays offline")
    }

    fun cacheFolder(id: String) = File(cacheRoot, id)

    /** Deletes a server's cached archives and OnDemand files (`server delete`). */
    fun deleteCache(id: String) {
        if (!OnlineServer.isValidId(id)) return
        val folder = cacheFolder(id)
        if (!folder.exists()) return
        if (folder.deleteRecursively()) Log.info("online", "deleted the cache of server $id")
        else Log.info("online", "could not delete all of the cache of server $id")
    }

    // ------------------------------------------------------------------------------------------------ routing

    /** The reply for an online route, or null when the bundle routes take the request. */
    fun handle(request: RouterRequest, path: String): RouterReply? {
        if (path == "/server-probe") return probeRoute(request)
        if ((path == "/" || path == "/index.html") && request.method == "GET") {
            // a new document (a load, a reload the page made itself, a restart after a renderer death)
            pageLoaded(OnlineServer.current(settings()))
            return null
        }
        val server = server ?: return null
        return when {
            path.startsWith("/crc") -> crc(request, server)
            path.startsWith("/ondemand/") -> onDemand(request, server, path.removePrefix("/ondemand/"))
            else -> archiveName(path)?.let { (archive, crc) -> archiveFile(request, server, "$archive$crc", crc) }
        }
    }

    private fun readOnly(request: RouterRequest): RouterReply? =
        if (request.method == "GET" || request.method == "HEAD") null else RouterReply.text(405, "method not allowed", mapOf("Allow" to "GET, HEAD"))

    // ------------------------------------------------------------------------------------------------ /crc

    private fun crc(request: RouterRequest, server: OnlineServer): RouterReply {
        readOnly(request)?.let { return it }
        return when (val fetched = fetch(server.url("crc"), server.host, crcTimeoutMs)) {
            is Fetched.Failed -> {
                Log.info("online", "/crc of ${server.displayHost}: ${fetched.words}")
                failure(fetched.words)
            }
            is Fetched.Ok -> {
                val table = GameCrc.table(fetched.data)
                if (table == null) {
                    Log.info("online", "/crc of ${server.displayHost}: ${fetched.data.size} bytes, not a CRC table")
                    return failure(NOT_GAME)
                }
                val differ = ARCHIVES.filterIndexed { i, name -> assets.open("$name${table[i + 1]}")?.also { it.stream.close() } == null }
                Log.info("online", "/crc of ${server.displayHost}: ${if (differ.isEmpty()) "the same archives as the bundle" else "differs from the bundle in ${differ.joinToString()}"}")
                RouterReply.data(fetched.data, Mime.OCTET_STREAM)
            }
        }
    }

    // ------------------------------------------------------------------------------------------------ archives

    private fun archiveFile(request: RouterRequest, server: OnlineServer, name: String, crc: Int): RouterReply {
        readOnly(request)?.let { return it }
        // 1. the bundle's copy: the same name is the same CRC, so the same bytes
        assets.open(name)?.let { asset ->
            if (request.method == "HEAD") {
                asset.stream.close()
                return RouterReply(200, Mime.OCTET_STREAM, body = RouterReply.Body.Headers(asset.length))
            }
            return RouterReply(200, Mime.OCTET_STREAM, body = RouterReply.Body.Stream(asset.stream, asset.length))
        }
        // 2. this server's cached copy, if it still checks out
        val cached = File(cacheFolder(server.id), name)
        if (cached.isFile) {
            val data = try {
                cached.readBytes()
            } catch (_: IOException) {
                null
            }
            if (data != null && GameCrc.checksum(data) == crc) return bytes(request, data)
            Log.info("online", "cached $name of ${server.displayHost} fails its CRC; fetching it again")
            cached.delete()
        }
        // 3. the server's
        return when (val fetched = fetch(server.url(name), server.host, archiveTimeoutMs)) {
            is Fetched.Failed -> {
                Log.info("online", "$name of ${server.displayHost}: ${fetched.words}")
                failure(fetched.words)
            }
            is Fetched.Ok -> {
                val got = GameCrc.checksum(fetched.data)
                if (got != crc) {
                    Log.info("online", "$name of ${server.displayHost}: ${fetched.data.size} bytes with CRC $got")
                    return failure("checksum mismatch")
                }
                try {
                    writeAtomically(cached, fetched.data)
                    Log.info("online", "$name of ${server.displayHost}: ${fetched.data.size} bytes, cached")
                } catch (error: IOException) {
                    Log.info("online", "could not cache $name: $error")
                }
                bytes(request, fetched.data)
            }
        }
    }

    private fun bytes(request: RouterRequest, data: ByteArray): RouterReply =
        if (request.method == "HEAD") RouterReply(200, Mime.OCTET_STREAM, body = RouterReply.Body.Headers(data.size.toLong()))
        else RouterReply.data(data, Mime.OCTET_STREAM)

    // ------------------------------------------------------------------------------------------------ OnDemand

    private fun onDemand(request: RouterRequest, server: OnlineServer, relative: String): RouterReply {
        val parts = relative.split('/')
        if (parts.size != 2 || parts[0] !in listOf("0", "1", "2", "3") || !isPlainNumber(parts[1]) || parts[1].toInt() > 65535) {
            return RouterReply.text(400, "invalid OnDemand path")
        }
        val file = File(cacheFolder(server.id), "od/${parts[0]}/${parts[1]}")
        return when (request.method) {
            "GET", "HEAD" -> {
                val data = try {
                    if (file.isFile) file.readBytes() else null
                } catch (_: IOException) {
                    null
                } ?: return RouterReply.text(404, "not cached")
                bytes(request, data)
            }
            "PUT" -> {
                // (too large by its count before anything is decoded, as the saves' 32 MiB)
                val count = request.header("X-LC-Length")?.toLongOrNull()
                if (count != null && count > MAX_ONDEMAND_BYTES) return RouterReply.text(413, "too large")
                val body = when (val decoded = BodyHeader.decode(request)) {
                    is BodyHeader.Decoded.Refused -> return RouterReply.text(decoded.status, decoded.message)
                    BodyHeader.Decoded.Absent -> ByteArray(0) // (no X-LC-Body: shouldInterceptRequest has no body)
                    is BodyHeader.Decoded.Bytes -> decoded.data
                }
                if (body.isEmpty()) return RouterReply.text(400, "empty body (send the bytes in X-LC-Body with X-LC-Length)")
                if (body.size > MAX_ONDEMAND_BYTES) return RouterReply.text(413, "too large")
                try {
                    writeAtomically(file, body)
                    RouterReply.empty(204)
                } catch (error: IOException) {
                    Log.info("online", "could not cache OnDemand $relative: $error")
                    RouterReply.text(500, error.message ?: "write failed")
                }
            }
            else -> RouterReply.text(405, "method not allowed", mapOf("Allow" to "GET, HEAD, PUT"))
        }
    }

    // ------------------------------------------------------------------------------------------------ /server-probe

    private fun probeRoute(request: RouterRequest): RouterReply {
        readOnly(request)?.let { return it }
        val typed = request.query["url"] ?: return RouterReply.text(400, "missing url")
        val json = JsonText.canonical(probe(typed))
        return if (request.method == "HEAD") RouterReply(200, Mime.JSON, body = RouterReply.Body.Headers(json.toByteArray().size.toLong()))
        else RouterReply.data(json.toByteArray(Charsets.UTF_8), Mime.JSON)
    }

    /**
     * What Add server shows: `/crc` (40 bytes with a good trailer: it speaks 2004scape), then
     * the world's node id and members flag from `/rs2.cgi`'s `new Client(<node>, <lowmem>, <members>)`, then the login
     * key from `/client/client.js`, 10 s each. `ok` = a good `/crc`.
     */
    fun probe(typed: String): JsonObject {
        var error: String? = null
        var url: String? = null
        var ok = false
        var nodeId = 10
        var members = true
        var rsa: Pair<String, String>? = null
        val notes = ArrayList<String>()
        run {
            val base = OnlineServer.normalize(typed)
            if (base == null) {
                error = "invalid address"
                return@run
            }
            url = base
            val server = OnlineServer("probe", base, base)
            when (val fetched = fetch(server.url("crc"), server.host, crcTimeoutMs)) {
                is Fetched.Failed -> {
                    error = fetched.words
                    Log.info("online", "probe ${server.displayHost}: ${fetched.words}")
                    return@run
                }
                is Fetched.Ok -> if (GameCrc.table(fetched.data) == null) {
                    error = NOT_GAME
                    Log.info("online", "probe ${server.displayHost}: /crc is ${fetched.data.size} bytes, not a CRC table")
                    return@run
                }
            }
            ok = true
            val world = (fetch(server.url("rs2.cgi"), server.host, crcTimeoutMs) as? Fetched.Ok)?.let { worldSettings(it.data.decodeToString()) }
            if (world != null) {
                nodeId = world.first
                members = world.second
            } else {
                notes += "No world settings found: world 10, members."
            }
            rsa = (fetch(server.url("client/client.js"), server.host, crcTimeoutMs) as? Fetched.Ok)?.let { loginKey(it.data.decodeToString()) }
            if (rsa == null) notes += "No login key found: the built-in key."
            Log.info("online", "probe ${server.displayHost}: a 2004scape server, world $nodeId, ${if (members) "members" else "free"}, ${if (rsa == null) "built-in key" else "its own key"}")
        }
        return buildJsonObject {
            put("ok", JsonPrimitive(ok))
            error?.let { put("error", JsonPrimitive(it)) }
            put("url", url?.let(::JsonPrimitive) ?: JsonNull)
            put("crc", JsonPrimitive(ok))
            put("nodeId", JsonPrimitive(nodeId))
            put("members", JsonPrimitive(members))
            put("rsa", rsa?.let { (n, e) -> buildJsonObject { put("n", JsonPrimitive(n)); put("e", JsonPrimitive(e)) } } ?: JsonNull)
            put("notes", JsonArray(notes.map(::JsonPrimitive)))
        }
    }

    // ------------------------------------------------------------------------------------------------ fetching

    private sealed interface Fetched {
        class Ok(val data: ByteArray) : Fetched
        class Failed(val words: String) : Fetched
    }

    /** GET `url` within `timeoutMs` (the whole call): its body on 200; 404 means the address does not serve the game. */
    private fun fetch(url: String, host: String, timeoutMs: Long): Fetched {
        val request = try {
            Request.Builder().url(url).get().build()
        } catch (_: IllegalArgumentException) {
            return Fetched.Failed(UNREACHABLE)
        }
        return try {
            client.newBuilder().callTimeout(timeoutMs, TimeUnit.MILLISECONDS).build().newCall(request).execute().use { response ->
                when (response.code) {
                    200 -> Fetched.Ok(response.body?.bytes() ?: ByteArray(0))
                    404 -> Fetched.Failed(NOT_GAME)
                    else -> Fetched.Failed("http ${response.code}")
                }
            }
        } catch (error: IOException) {
            Fetched.Failed(
                when {
                    localNetwork.refused(host, error) -> LocalNetwork.WORDS
                    error is InterruptedIOException -> "timed out" // (the call timeout, or a connect/read timeout)
                    else -> UNREACHABLE
                },
            )
        }
    }

    private fun failure(words: String) = RouterReply(502, Mime.TEXT, body = RouterReply.Body.Bytes(words.toByteArray(Charsets.UTF_8)))

    companion object {
        /** The archives in `/crc` order (index 1 to 8; 0 is unused). */
        val ARCHIVES = listOf("title", "config", "interface", "media", "versionlist", "textures", "wordenc", "sounds")
        const val CRC_TIMEOUT_MS = 10_000L
        const val ARCHIVE_TIMEOUT_MS = 30_000L
        const val MAX_ONDEMAND_BYTES = 4 * 1024 * 1024
        const val UNREACHABLE = "unreachable"
        const val NOT_GAME = "not a 2004scape server"

        /** `/title410306098` → ("title", 410306098); null for anything that is not an archive with a CRC. */
        fun archiveName(path: String): Pair<String, Int>? {
            if (!path.startsWith("/")) return null
            val name = path.substring(1)
            val digits = name.indexOfFirst { it == '-' || it in '0'..'9' }.takeIf { it >= 0 } ?: return null
            val archive = name.substring(0, digits)
            val number = name.substring(digits)
            if (archive !in ARCHIVES) return null
            val crc = number.toIntOrNull() ?: return null
            return if (crc.toString() == number) archive to crc else null
        }

        /** Decimal digits with no sign and no leading zero (`0` itself is fine), at most 5. */
        private fun isPlainNumber(text: String) = text.isNotEmpty() && text.length <= 5 && text.all { it in '0'..'9' } && (text == "0" || !text.startsWith("0"))

        private val WORLD = Regex("""new\s+Client\(\s*(\d{1,5})\s*,\s*[^,()]*,\s*(true|false|1|0)\s*\)""")
        private const val LITERAL = """BigInt\(\s*(["'])(\d+)\1\s*\)"""
        private val RSAENC = Regex("""rsaenc\(\s*""" + LITERAL + """\s*,\s*""" + LITERAL.replace("""\1""", """\3"""))
        private val PAIR = Regex("""BigInt\(\s*(["'])(\d{40,})\1\s*\)\s*,\s*BigInt\(\s*(["'])(\d+)\3\s*\)""")

        /** `new Client(<node id>, <low memory>, <members>)` in the server's game page (Engine-TS view/client.ejs). */
        fun worldSettings(page: String): Pair<Int, Boolean>? {
            val match = WORLD.find(page) ?: return null
            val nodeId = match.groupValues[1].toIntOrNull() ?: return null
            return nodeId to (match.groupValues[2] == "true" || match.groupValues[2] == "1")
        }

        /**
         * The login key's two decimal literals in the server's client bundle: `rsaenc(BigInt("<n>"), BigInt("<e>"))`, or,
         * in a minified bundle that renamed `rsaenc`, the only distinct adjacent pair `BigInt("<40+ digits>"),BigInt("…")`.
         */
        fun loginKey(script: String): Pair<String, String>? {
            RSAENC.find(script)?.let { return it.groupValues[2] to it.groupValues[4] }
            val pairs = PAIR.findAll(script).map { it.groupValues[2] to it.groupValues[4] }.toSet()
            return pairs.singleOrNull()
        }

        /** Writes `data` to `file` through a temporary file in the same folder and a rename (never a half-written file). */
        fun writeAtomically(file: File, data: ByteArray) {
            val folder = file.parentFile ?: throw IOException("no folder for $file")
            if (!folder.isDirectory && !folder.mkdirs() && !folder.isDirectory) throw IOException("could not make $folder")
            val temp = File(folder, ".${file.name}.${System.nanoTime()}.tmp")
            try {
                temp.writeBytes(data)
                Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
            } finally {
                temp.delete()
            }
        }
    }
}
