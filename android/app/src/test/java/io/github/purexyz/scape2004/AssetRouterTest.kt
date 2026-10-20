// AssetRouter on the JVM: ARCHITECTURE.md §3's routes for the Android origin (docs/ANDROID.md §3.2), the iOS statuses and
// texts, MIME types, the headers every response carries, the 403 for other hosts, strict percent-decoding, and the
// X-LC-Body / X-LC-Length checks in web/test/serve.mjs's order.
package io.github.purexyz.scape2004

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Base64

class AssetRouterTest {
    private lateinit var dir: File
    private lateinit var game: File
    private lateinit var saves: SaveStore
    private lateinit var router: AssetRouter

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("router").toFile()
        game = File(dir, "Game").apply { mkdirs() }
        File(game, "index.html").writeText("<!doctype html>")
        File(game, "engine").mkdirs()
        File(game, "engine/boot.js").writeText("// boot")
        File(game, "engine/bzip2.wasm").writeBytes(byteArrayOf(0, 0x61, 0x73, 0x6d))
        File(game, "crc").writeBytes(ByteArray(40))
        File(game, "title410306098").writeBytes(ByteArray(10))
        File(game, "ui/fonts").mkdirs()
        File(game, "ui/fonts/p12.ttf").writeBytes(ByteArray(3))
        File(game, "a+b.txt").writeText("plus")
        saves = SaveStore(File(dir, "Documents"), NioFileOps())
        router = AssetRouter(DirectoryAssets(game), saves)
    }

    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    private fun request(method: String, path: String, query: String? = null, headers: Map<String, String> = emptyMap(), host: String = AssetRouter.HOST, scheme: String = "https") =
        router.handle(RouterRequest(method, scheme, host, path, query, headers))

    private fun body(reply: RouterReply): ByteArray = when (val b = reply.body) {
        is RouterReply.Body.Bytes -> b.data
        is RouterReply.Body.Stream -> b.stream.use { it.readBytes() }
        is RouterReply.Body.Headers -> ByteArray(0)
    }

    private fun text(reply: RouterReply) = String(body(reply), Charsets.UTF_8)

    private fun b64(data: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(data)

    private fun put(path: String, data: ByteArray, length: String = data.size.toString(), encoded: String = b64(data)) =
        request("PUT", path, headers = mapOf("X-LC-Body" to encoded, "X-LC-Length" to length))

    // ------------------------------------------------------------------------------------------------ bundle files

    @Test
    fun bundleFilesWithTheirTypes() {
        val index = request("GET", "/")
        assertEquals(200, index.status)
        assertEquals("text/html; charset=utf-8", index.contentType)
        assertEquals("<!doctype html>", text(index))
        assertEquals(200, request("GET", "/index.html").status)
        assertEquals("text/javascript; charset=utf-8", request("GET", "/engine/boot.js").contentType)
        assertEquals("application/wasm", request("GET", "/engine/bzip2.wasm").contentType)
        assertEquals("font/ttf", request("GET", "/ui/fonts/p12.ttf").contentType)
        assertEquals("application/octet-stream", request("GET", "/crc").contentType)
        assertEquals("application/octet-stream", request("GET", "/title410306098").contentType)
        assertEquals("plus", text(request("GET", "/a+b.txt"))) // + is not a space in a path
    }

    @Test
    fun everyResponseCarriesTheHeadersAndAReason() {
        for (reply in listOf(request("GET", "/crc"), request("GET", "/missing"), request("PUT", "/crc"), request("GET", "/save/players/main/none.sav"))) {
            val headers = reply.allHeaders()
            assertEquals("no-store", headers["Cache-Control"])
            assertEquals("*", headers["Access-Control-Allow-Origin"])
            assertEquals(reply.contentLength.toString(), headers["Content-Length"])
            assertTrue(reply.reason.isNotEmpty())
        }
        assertEquals("40", request("GET", "/crc").allHeaders()["Content-Length"])
        assertEquals("OK", request("GET", "/crc").reason)
        assertEquals("Not Found", request("GET", "/missing").reason)
    }

    @Test
    fun headGivesTheLengthOnly() {
        val head = request("HEAD", "/crc")
        assertEquals(200, head.status)
        assertEquals(40L, head.contentLength)
        assertEquals(0, body(head).size)
    }

    @Test
    fun missingFoldersAndBadPaths() {
        val missing = request("GET", "/nope.js")
        assertEquals(404, missing.status)
        assertEquals("not found: /nope.js\n", text(missing))
        assertEquals("text/plain; charset=utf-8", missing.contentType)
        assertEquals(404, request("GET", "/engine").status) // a folder is not a file
        assertEquals(404, request("GET", "/engine/").status) // a folder's path means its index.html, which it has not
        assertEquals(400, request("GET", "/engine/../index.html").status)
        assertEquals(400, request("GET", "/engine/%2e%2e/index.html").status) // decoded once, then checked
        assertEquals(400, request("GET", "/a//b").status)
        val malformed = request("GET", "/bad%zzescape")
        assertEquals(400, malformed.status)
        assertEquals("malformed path\n", text(malformed))
        assertEquals(400, request("GET", "/bad%e9").status) // not UTF-8
    }

    @Test
    fun onlyGetAndHeadForBundleFiles() {
        val reply = request("POST", "/index.html")
        assertEquals(405, reply.status)
        assertEquals("GET, HEAD", reply.headers["Allow"])
        assertEquals("Method Not Allowed", reply.reason)
    }

    @Test
    fun otherHostsAreForbidden() {
        val reply = request("GET", "/index.html", host = "example.com")
        assertEquals(403, reply.status)
        assertEquals("Forbidden", reply.reason)
        assertEquals(0L, reply.contentLength)
        assertEquals(403, request("GET", "/index.html", scheme = "http").status)
    }

    // ------------------------------------------------------------------------------------------------ saves

    @Test
    fun saveRoundTripThroughTheHeader() {
        val data = ByteArray(511) { (it * 7).toByte() } // (511 % 3 = 1: a length that needs base64 padding)
        val written = put("/save/players/main/zezima.sav", data)
        assertEquals(204, written.status)
        assertEquals("No Content", written.reason)
        val read = request("GET", "/save/players/main/zezima.sav")
        assertEquals(200, read.status)
        assertEquals("application/octet-stream", read.contentType)
        assertArrayEquals(data, body(read))
        val head = request("HEAD", "/save/players/main/zezima.sav")
        assertEquals(511L, head.contentLength)
        assertEquals(0, body(head).size)
        // a second version keeps the first as .bak
        assertEquals(204, put("/save/players/main/zezima.sav", byteArrayOf(1)).status)
        assertArrayEquals(data, body(request("GET", "/save/players/main/zezima.sav.bak")))
    }

    @Test
    fun headerNamesAnyCase() {
        val data = byteArrayOf(5, 6, 7)
        val reply = request("POST", "/save/bots/main/bots.sav", headers = mapOf("x-lc-body" to b64(data), "x-lc-length" to "3"))
        assertEquals(204, reply.status)
        assertArrayEquals(data, saves.read("bots/main/bots.sav"))
    }

    @Test
    fun badHeaderBodiesAreRefusedLikeServeMjs() {
        val p1 = ByteArray(511) { it.toByte() }
        saves.write("players/main/a.sav", byteArrayOf(42))
        val cases = listOf(
            Triple("X-LC-Length one short", put("/save/players/main/a.sav", p1, (p1.size - 1).toString()), 400),
            Triple("X-LC-Length one long", put("/save/players/main/a.sav", p1, (p1.size + 1).toString()), 400),
            Triple("X-LC-Length missing", request("PUT", "/save/players/main/a.sav", headers = mapOf("X-LC-Body" to b64(p1))), 400),
            Triple("X-LC-Length not a number", put("/save/players/main/a.sav", p1, "12x"), 400),
            Triple("standard base64 (+ / =)", put("/save/players/main/a.sav", byteArrayOf(-5, -1), "2", "+/8="), 400),
            Triple("an impossible base64 length", put("/save/players/main/a.sav", p1, "1", "AAAAA"), 400),
            Triple("above 32 MiB", put("/save/players/main/a.sav", p1, (BodyHeader.MAX_BYTES + 1).toString(), "!!!"), 413),
            Triple("empty (X-LC-Length 0)", put("/save/players/main/a.sav", ByteArray(0)), 400),
            Triple("no X-LC-Body at all", request("PUT", "/save/players/main/a.sav"), 400),
        )
        for ((name, reply, status) in cases) assertEquals(name, status, reply.status)
        assertArrayEquals("the save untouched", byteArrayOf(42), saves.read("players/main/a.sav"))
        assertEquals("Content Too Large", cases[6].second.reason)
    }

    @Test
    fun theDecoderAlone() {
        assertTrue(BodyHeader.decode(null, null) is BodyHeader.Decoded.Absent)
        val ok = BodyHeader.decode("AAEC", "3") as BodyHeader.Decoded.Bytes
        assertArrayEquals(byteArrayOf(0, 1, 2), ok.data)
        assertEquals(413, (BodyHeader.decode("AA", "33554433") as BodyHeader.Decoded.Refused).status)
        assertEquals(400, (BodyHeader.decode("AA==", "1") as BodyHeader.Decoded.Refused).status) // padding refused
        assertEquals(400, (BodyHeader.decode("AA", "-1") as BodyHeader.Decoded.Refused).status)
        assertEquals(400, (BodyHeader.decode("AA", "1234567890123456") as BodyHeader.Decoded.Refused).status) // 16 digits
        val big = ByteArray(2_000_000) { (it % 251).toByte() }
        assertArrayEquals(big, (BodyHeader.decode(b64(big), big.size.toString()) as BodyHeader.Decoded.Bytes).data)
    }

    @Test
    fun saveStatusesAndTexts() {
        val missing = request("GET", "/save/players/main/none.sav")
        assertEquals(404, missing.status)
        assertEquals("no such save: players/main/none.sav\n", text(missing))
        val invalid = request("GET", "/save/../secret")
        assertEquals(400, invalid.status)
        assertEquals("invalid save path: ../secret\n", text(invalid))
        assertEquals(400, request("GET", "/save/players/.hidden").status)
        assertEquals(400, request("GET", "/save/players/..%2Fx").status)
        val options = request("OPTIONS", "/save/players/main/a.sav")
        assertEquals(204, options.status)
        assertEquals("GET, HEAD, PUT, POST, DELETE", options.headers["Allow"])
        val patch = request("PATCH", "/save/players/main/a.sav")
        assertEquals(405, patch.status)
        assertEquals("GET, HEAD, PUT, POST, DELETE", patch.headers["Allow"])
        val empty = request("PUT", "/save/players/main/a.sav")
        assertTrue(text(empty).startsWith("empty body"))
    }

    @Test
    fun deleteKeepsABackup() {
        put("/save/players/main/a.sav", byteArrayOf(1, 2))
        assertEquals(204, request("DELETE", "/save/players/main/a.sav").status)
        assertEquals(404, request("GET", "/save/players/main/a.sav").status)
        assertArrayEquals(byteArrayOf(1, 2), body(request("GET", "/save/players/main/a.sav.bak")))
        assertEquals(204, request("DELETE", "/save/players/main/a.sav.bak").status)
        assertEquals(404, request("DELETE", "/save/players/main/a.sav.bak").status)
    }

    @Test
    fun saveIndexIsSortedJsonWithUnescapedSlashes() {
        put("/save/players/main/b.sav", byteArrayOf(1, 2, 3))
        put("/save/bots/main/bots.sav", byteArrayOf(1))
        put("/save/players/main/b.sav", byteArrayOf(4))
        val reply = request("GET", "/save-index")
        assertEquals(200, reply.status)
        assertEquals("application/json", reply.contentType)
        val json = text(reply)
        assertTrue(json, json.startsWith("[{\"modified\":"))
        assertTrue("'/' is not escaped: $json", json.contains("\"path\":\"bots/main/bots.sav\"") && !json.contains("\\/"))
        val rows = Json.parseToJsonElement(json) as JsonArray
        assertEquals(listOf("bots/main/bots.sav", "players/main/b.sav", "players/main/b.sav.bak"), rows.map { (it as JsonObject)["path"]!!.jsonPrimitive.content })
        assertEquals(listOf("modified", "path", "size"), (rows[0] as JsonObject).keys.toList())
        assertEquals(405, request("POST", "/save-index").status)
        assertEquals("[]", text(AssetRouter(DirectoryAssets(game), SaveStore(File(dir, "Empty"), NioFileOps())).handle(RouterRequest("GET", "https", AssetRouter.HOST, "/save-index", null))))
    }

    // ------------------------------------------------------------------------------------------------ log

    @Test
    fun logTakesTheHeaderOrTheQuery() {
        assertEquals(204, request("POST", "/log", "src=engine&level=warn", mapOf("X-LC-Body" to b64("line one\nline two".toByteArray()), "X-LC-Length" to "17")).status)
        assertEquals(204, request("POST", "/log", "text=from+the+query%21").status)
        assertEquals(204, request("PUT", "/log").status)
        assertEquals(405, request("GET", "/log").status)
        assertEquals("POST, PUT", request("GET", "/log").headers["Allow"])
        assertEquals(400, request("POST", "/log", headers = mapOf("X-LC-Body" to "AA")).status)
    }

    // ------------------------------------------------------------------------------------------------ helpers

    @Test
    fun percentDecodingIsStrictAndOnce() {
        assertEquals("/a b", PercentDecoding.path("/a%20b"))
        assertEquals("/a+b", PercentDecoding.path("/a+b"))
        assertEquals("/%41", PercentDecoding.path("/%2541")) // once
        assertEquals("/é", PercentDecoding.path("/%C3%A9"))
        assertNull(PercentDecoding.path("/%"))
        assertNull(PercentDecoding.path("/%4"))
        assertNull(PercentDecoding.path("/%G1"))
        assertNull(PercentDecoding.path("/%C3"))
        assertEquals(mapOf("src" to "engine", "text" to "a b", "x" to ""), PercentDecoding.query("src=worker&src=engine&text=a+b&x"))
    }

    @Test
    fun mimeTable() {
        assertEquals("text/html; charset=utf-8", Mime.forExtension("HTML"))
        assertEquals("application/json", Mime.forExtension("map"))
        assertEquals("application/octet-stream", Mime.forExtension("sf2"))
        assertEquals("", Mime.extensionOf("crc"))
        assertEquals("idx0", Mime.extensionOf("cache/main_file_cache.idx0"))
        assertEquals("", Mime.extensionOf("ui/.hidden"))
        assertEquals("text/javascript" to "utf-8", Mime.split("text/javascript; charset=utf-8"))
        assertEquals("image/png" to null, Mime.split("image/png"))
        assertFalse(RouterReply.reasonPhrase(299).isEmpty())
    }
}
