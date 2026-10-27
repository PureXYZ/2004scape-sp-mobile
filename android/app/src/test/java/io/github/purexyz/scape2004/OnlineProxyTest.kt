// OnlineProxy on the JVM, through AssetRouter as the WebView reaches it, against a local HTTP server (MockWebServer)
// standing in for a game server: which page loads play online, /crc (the trailer, the words of every failure, the
// timeout), the archives (the bundle's copy, fetched and checked, cached, a cached copy that fails its CRC, a mismatch),
// OnDemand's cache and its limits, the probe's JSON (rs2.cgi, client.js in both quote styles and minified), offline
// untouched, and a server's cache deleted.
package io.github.purexyz.scape2004

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.ServerSocket
import java.nio.ByteBuffer
import java.nio.file.Files
import java.util.Base64
import java.util.Collections
import java.util.concurrent.TimeUnit

class OnlineProxyTest {
    private lateinit var dir: File
    private lateinit var game: File
    private lateinit var cache: File
    private lateinit var server: MockWebServer
    private lateinit var proxy: OnlineProxy
    private lateinit var router: AssetRouter
    private var settings: JsonObject = JsonObject(emptyMap())
    private val requests: MutableList<RecordedRequest> = Collections.synchronizedList(ArrayList())

    private val config = "config archive served by the test server ".repeat(20).toByteArray()
    private val bundleTitle = ByteArray(64) { it.toByte() }
    private val titleCrc = GameCrc.checksum(bundleTitle)
    private val crcs = intArrayOf(0, titleCrc, GameCrc.checksum(config), GameCrc.checksum("what the name promises".toByteArray()), 4, 5, 6, 7, 8)
    private val client = Network.client("2004Scape/test (Android test)")

    private fun table(values: IntArray = crcs, trailerOffset: Int = 0): ByteArray {
        val buffer = ByteBuffer.allocate(40)
        var check = 1234
        for (crc in values) {
            buffer.putInt(crc)
            check = (check shl 1) + crc
        }
        buffer.putInt(check + trailerOffset)
        return buffer.array()
    }

    private fun bytes(data: ByteArray) = MockResponse().setBody(Buffer().write(data))

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("online").toFile()
        game = File(dir, "Game").apply { mkdirs() }
        File(game, "index.html").writeText("<!doctype html>")
        File(game, "crc").writeBytes(ByteArray(40))
        File(game, "title$titleCrc").writeBytes(bundleTitle)
        cache = File(dir, "cache/online")
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.path ?: ""
                return when {
                    path == "/crc" || path == "/game/crc" -> bytes(table())
                    path == "/short/crc" -> bytes(table().copyOf(39))
                    path == "/badtrailer/crc" -> bytes(table(trailerOffset = 1))
                    path == "/http500/crc" -> MockResponse().setResponseCode(500).setBody("oops")
                    path == "/slow/crc" -> bytes(table()).setBodyDelay(3, TimeUnit.SECONDS)
                    path == "/rs2.cgi" -> MockResponse().setBody("<script>\n const client = new Client(7, 0, false);\n</script>")
                    path == "/client/client.js" -> MockResponse().setBody("function x(){this.out.rsaenc(BigInt('${"9".repeat(40)}1234567'), BigInt('65537'));}")
                    path == "/game/rs2.cgi" -> MockResponse().setBody("new Client( 12 , lowmem, 1 )")
                    // Engine-TS's minified bundle: rsaenc renamed, one pair of literals
                    path == "/game/client/client.js" -> MockResponse().setBody("a.b(BigInt(\"${"7".repeat(45)}\"),BigInt(\"3\"));c(BigInt(\"1\"),BigInt(\"2\"))")
                    path == "/config${crcs[2]}" -> bytes(config)
                    path == "/media${crcs[3]}" -> bytes("bytes that do not match their name".toByteArray())
                    path == "/textures${crcs[6]}" -> MockResponse().setResponseCode(404)
                    path == "/wordenc${crcs[7]}" -> MockResponse().setResponseCode(500)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        proxy = OnlineProxy(DirectoryAssets(game), cache, { settings }, client, crcTimeoutMs = 1_500, archiveTimeoutMs = 1_500)
        router = AssetRouter(DirectoryAssets(game), SaveStore(File(dir, "Documents"), NioFileOps()), proxy)
    }

    @After
    fun tearDown() {
        server.shutdown()
        dir.deleteRecursively()
    }

    private val base: String get() = server.url("/").toString().trimEnd('/')

    /** Settings that play on `url` as server s-test, then the main document requested (as a page load does). */
    private fun playOn(url: String?) {
        settings = if (url == null) buildJsonObject { put("server", JsonPrimitive("offline")) } else buildJsonObject {
            put("server", JsonPrimitive("s-test"))
            put("servers", JsonArray(listOf(buildJsonObject {
                put("id", JsonPrimitive("s-test"))
                put("name", JsonPrimitive("Test"))
                put("url", JsonPrimitive(url))
            })))
        }
        assertEquals(200, get("/index.html").status)
    }

    private fun request(method: String, path: String, query: String? = null, headers: Map<String, String> = emptyMap()) =
        router.handle(RouterRequest(method, "https", AssetRouter.HOST, path, query, headers))

    private fun get(path: String, query: String? = null) = request("GET", path, query)

    private fun body(reply: RouterReply): ByteArray = when (val b = reply.body) {
        is RouterReply.Body.Bytes -> b.data
        is RouterReply.Body.Stream -> b.stream.use { it.readBytes() }
        is RouterReply.Body.Headers -> ByteArray(0)
    }

    private fun text(reply: RouterReply) = String(body(reply), Charsets.UTF_8)

    private fun put(path: String, data: ByteArray) = request(
        "PUT", path,
        headers = mapOf("X-LC-Body" to Base64.getUrlEncoder().withoutPadding().encodeToString(data), "X-LC-Length" to data.size.toString()),
    )

    private fun count(path: String) = synchronized(requests) { requests.count { it.path == path } }

    // ------------------------------------------------------------------------------------------------ which page plays

    @Test
    fun theMainDocumentDecidesThePageLoadsServer() {
        playOn(base)
        assertEquals("s-test", proxy.server?.id)
        assertEquals(base, proxy.server?.base)
        // a later settings change does not move this page; the next document does
        settings = JsonObject(emptyMap())
        assertEquals("s-test", proxy.server?.id)
        get("/")
        assertNull(proxy.server)
    }

    @Test
    fun offlineEveryPathIsTheBundlesAsBefore() {
        playOn(null)
        val crc = get("/crc")
        assertEquals(200, crc.status)
        assertArrayEquals(ByteArray(40), body(crc))
        assertEquals(404, get("/config${crcs[2]}").status)
        assertEquals(404, get("/ondemand/1/5").status)
        assertEquals(405, put("/ondemand/1/5", byteArrayOf(1)).status)
        assertEquals("the server is never asked offline", 0, requests.size)
    }

    // ------------------------------------------------------------------------------------------------ /crc

    @Test
    fun crcIsTheServersTable() {
        playOn(base)
        val reply = get("/crc")
        assertEquals(200, reply.status)
        assertArrayEquals(table(), body(reply))
        assertEquals("no-store", reply.allHeaders()["Cache-Control"])
        assertEquals(200, get("/crc", "x=12345").status)
        assertEquals(200, get("/crc12345").status)
        val first = requests.first()
        assertEquals("2004Scape/test (Android test)", first.getHeader("User-Agent"))
        assertNull(first.getHeader("Origin"))
        assertNull(first.getHeader("Cookie"))
        assertEquals(405, request("PUT", "/crc").status)
    }

    private fun failure(url: String): String {
        playOn(url)
        val reply = get("/crc")
        assertEquals(502, reply.status)
        assertEquals("text/plain; charset=utf-8", reply.contentType)
        return text(reply)
    }

    @Test
    fun crcFailuresInPlainWords() {
        assertEquals("not a 2004scape server", failure("$base/short"))
        assertEquals("not a 2004scape server", failure("$base/badtrailer"))
        assertEquals("not a 2004scape server", failure("$base/nothing"))
        assertEquals("http 500", failure("$base/http500"))
        val started = System.nanoTime()
        assertEquals("timed out", failure("$base/slow"))
        val ms = (System.nanoTime() - started) / 1_000_000
        assertTrue("the call timeout ($ms ms)", ms in 1_400..2_900)
        val closed = ServerSocket(0).use { it.localPort }
        assertEquals("unreachable", failure("http://127.0.0.1:$closed"))
    }

    // ------------------------------------------------------------------------------------------------ archives

    @Test
    fun archivesFromTheBundleTheServerOrTheCache() {
        playOn(base)
        // the bundle's copy: same name, same CRC, same bytes; the server is not asked
        val title = get("/title$titleCrc")
        assertEquals(200, title.status)
        assertArrayEquals(bundleTitle, body(title))
        assertEquals(0, count("/title$titleCrc"))
        // not in the bundle: fetched, checked, cached
        val config1 = get("/config${crcs[2]}")
        assertEquals(200, config1.status)
        assertArrayEquals(config, body(config1))
        assertEquals(1, count("/config${crcs[2]}"))
        val cached = File(cache, "s-test/config${crcs[2]}")
        assertArrayEquals(config, cached.readBytes())
        assertArrayEquals(config, body(get("/config${crcs[2]}")))
        assertEquals("the second time from the cache", 1, count("/config${crcs[2]}"))
        // a cached copy that fails its CRC is fetched again
        cached.writeText("junk")
        assertArrayEquals(config, body(get("/config${crcs[2]}")))
        assertEquals(2, count("/config${crcs[2]}"))
        assertArrayEquals(config, cached.readBytes())
        // HEAD: the length only
        val head = request("HEAD", "/config${crcs[2]}")
        assertEquals(config.size.toLong(), head.contentLength)
    }

    @Test
    fun archiveFailures() {
        playOn(base)
        val mismatch = get("/media${crcs[3]}")
        assertEquals(502, mismatch.status)
        assertEquals("checksum mismatch", text(mismatch))
        assertFalse("not cached", File(cache, "s-test/media${crcs[3]}").exists())
        assertEquals("not a 2004scape server", text(get("/textures${crcs[6]}")))
        assertEquals("http 500", text(get("/wordenc${crcs[7]}")))
        // a path that is no archive stays a bundle path
        assertEquals(404, get("/nothing-here").status)
        assertEquals(404, get("/config01").status)
        assertEquals(404, get("/titles123").status)
    }

    @Test
    fun archiveNames() {
        assertEquals("title" to 410306098, OnlineProxy.archiveName("/title410306098"))
        assertEquals("sounds" to -123, OnlineProxy.archiveName("/sounds-123"))
        for (path in listOf("/title", "/title01", "/titlex1", "/worldmap123", "title1", "/title1/x", "/title99999999999")) assertNull(path, OnlineProxy.archiveName(path))
    }

    // ------------------------------------------------------------------------------------------------ OnDemand

    @Test
    fun onDemandCache() {
        playOn(base)
        assertEquals(404, get("/ondemand/1/5").status)
        val data = ByteArray(777) { (it * 7).toByte() }
        assertEquals(204, put("/ondemand/1/5", data).status)
        val back = get("/ondemand/1/5")
        assertEquals(200, back.status)
        assertArrayEquals(data, body(back))
        assertTrue(File(cache, "s-test/od/1/5").isFile)
        for (path in listOf("/ondemand/4/1", "/ondemand/1/01", "/ondemand/1/65536", "/ondemand/1/-1", "/ondemand/1/a", "/ondemand/1", "/ondemand/1/2/3", "/ondemand/01/2")) {
            assertEquals(path, 400, get(path).status)
        }
        assertEquals("no X-LC-Body: an empty write", 400, request("PUT", "/ondemand/2/9").status)
        assertEquals(413, put("/ondemand/2/9", ByteArray(4 * 1024 * 1024 + 1)).status)
        assertEquals("too large by its count, before decoding", 413, request("PUT", "/ondemand/2/9", headers = mapOf("X-LC-Body" to "AA", "X-LC-Length" to "4194305")).status)
        assertEquals(204, put("/ondemand/0/0", byteArrayOf(1)).status)
        assertEquals(204, put("/ondemand/3/65535", byteArrayOf(2)).status)
        assertEquals(405, request("DELETE", "/ondemand/1/5").status)
        // deleting the server deletes its folder
        proxy.deleteCache("s-test")
        assertFalse(File(cache, "s-test").exists())
        proxy.deleteCache("../x") // (not a server id: nothing)
    }

    // ------------------------------------------------------------------------------------------------ probe

    private fun probe(url: String): JsonObject {
        val reply = get("/server-probe", "url=" + java.net.URLEncoder.encode(url, "UTF-8"))
        assertEquals(200, reply.status)
        assertEquals("application/json", reply.contentType)
        return Json.parseToJsonElement(text(reply)).jsonObject
    }

    @Test
    fun probeOfAServer() {
        playOn(null) // (every mode)
        val ok = probe(" ${base.removePrefix("http://")}/ ")
        assertEquals(JsonPrimitive(true), ok["ok"])
        assertEquals(JsonPrimitive(true), ok["crc"])
        assertEquals(JsonPrimitive(base), ok["url"])
        assertEquals(JsonPrimitive(7), ok["nodeId"])
        assertEquals(JsonPrimitive(false), ok["members"])
        assertEquals(buildJsonObject { put("e", JsonPrimitive("65537")); put("n", JsonPrimitive("9".repeat(40) + "1234567")) }, ok["rsa"])
        assertEquals(JsonArray(emptyList()), ok["notes"])
        assertFalse("error" in ok)
        // the keys sorted, '/' not escaped
        assertTrue(text(get("/server-probe", "url=$base")).startsWith("{\"crc\":true,\"members\":false,\"nodeId\":7,\"notes\":[],\"ok\":true,\"rsa\":"))

        val minified = probe("ws://${base.removePrefix("http://")}/game")
        assertEquals(JsonPrimitive(12), minified["nodeId"])
        assertEquals(JsonPrimitive(true), minified["members"])
        assertEquals(buildJsonObject { put("e", JsonPrimitive("3")); put("n", JsonPrimitive("7".repeat(45))) }, minified["rsa"])

        val bare = probe("$base/badtrailer")
        assertEquals(JsonPrimitive(false), bare["ok"])
        assertEquals(JsonPrimitive("not a 2004scape server"), bare["error"])
        assertEquals(JsonArray(emptyList()), bare["notes"])
        assertEquals(JsonNull, bare["rsa"])
        assertEquals(JsonPrimitive(10), bare["nodeId"])
    }

    @Test
    fun probeNotesAndFailures() {
        playOn(null)
        // /short/… has a /crc but no rs2.cgi or client.js: both notes
        server.dispatcher.let { previous ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) =
                    if (request.path == "/norsa/crc") bytes(table()) else previous.dispatch(request)
            }
        }
        val norsa = probe("$base/norsa")
        assertEquals(JsonPrimitive(true), norsa["ok"])
        assertEquals(JsonPrimitive(10), norsa["nodeId"])
        assertEquals(JsonPrimitive(true), norsa["members"])
        assertEquals(JsonNull, norsa["rsa"])
        assertEquals(JsonArray(listOf(JsonPrimitive("No world settings found: world 10, members."), JsonPrimitive("No login key found: the built-in key."))), norsa["notes"])
        assertEquals(JsonPrimitive("http 500"), probe("$base/http500")["error"])
        val closed = ServerSocket(0).use { it.localPort }
        assertEquals(JsonPrimitive("unreachable"), probe("127.0.0.1:$closed")["error"])
        val invalid = probe("ftp://h")
        assertEquals(JsonPrimitive("invalid address"), invalid["error"])
        assertEquals(JsonNull, invalid["url"])
        assertEquals(400, get("/server-probe").status)
    }

    @Test
    fun worldSettingsAndLoginKey() {
        assertEquals(10 to true, OnlineProxy.worldSettings("const client = new Client(10, false, true);"))
        assertEquals(3 to false, OnlineProxy.worldSettings("new Client(3,0,0)"))
        assertNull(OnlineProxy.worldSettings("new Client(nodeid, lowmem, members)"))
        assertEquals("1".repeat(40) to "5", OnlineProxy.loginKey("rsaenc(BigInt(\"${"1".repeat(40)}\"), BigInt(\"5\"))"))
        assertEquals("12" to "5", OnlineProxy.loginKey("rsaenc(BigInt('12'),BigInt('5'))"))
        // two different pairs and no rsaenc: no key
        assertNull(OnlineProxy.loginKey("f(BigInt(\"${"1".repeat(40)}\"),BigInt(\"3\"));g(BigInt(\"${"2".repeat(40)}\"),BigInt(\"3\"))"))
        // the same pair twice is one key
        val pair = "BigInt(\"${"1".repeat(40)}\"),BigInt(\"3\")"
        assertEquals("1".repeat(40) to "3", OnlineProxy.loginKey("f($pair);g($pair)"))
    }
}
