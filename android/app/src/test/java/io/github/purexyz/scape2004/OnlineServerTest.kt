// OnlineServer on the JVM: the address rules shared with the page (web/test/online/serverurl-vectors.json, the same file
// web/host/serverurl.js is checked against), the socket URL, which settings play online, server ids, and the /crc
// table's trailer (GameCrc).
package io.github.purexyz.scape2004

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer

class OnlineServerTest {
    /** The repo's shared vectors (the unit tests run in android/app). */
    private val vectors: JsonObject by lazy {
        val file = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "web/test/online/serverurl-vectors.json") }
            .first { it.isFile }
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    @Test
    fun normalizesAsThePageDoes() {
        val wrong = ArrayList<String>()
        val cases = vectors["normalize"]!!.jsonArray
        for (case in cases) {
            val (typed, expected) = case.jsonArray.let { it[0].jsonPrimitive.content to (it[1] as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
            val got = OnlineServer.normalize(typed)
            if (got != expected) wrong += "'$typed' → $got (want $expected)"
        }
        assertTrue(wrong.joinToString("\n"), wrong.isEmpty())
        assertTrue("the shared file has the contract's vectors", cases.size >= 30)
    }

    @Test
    fun socketUrlsAsThePageMakesThem() {
        val cases = vectors["socketUrl"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val (base, expected) = case.jsonArray.let { it[0].jsonPrimitive.content to it[1].jsonPrimitive.content }
            assertEquals(base, expected, OnlineServer("s-1", "x", base).socketUrl)
        }
    }

    @Test
    fun contractVectors() {
        // iOS's OnlineServer rules, as they are written there
        assertEquals("http://192.168.1.20", OnlineServer.normalize("192.168.1.20"))
        assertEquals("http://my-mac.local:8888", OnlineServer.normalize("My-Mac.local:8888"))
        assertEquals("http://h", OnlineServer.normalize("ws://h:80/"))
        assertEquals("https://scape.example.com/game", OnlineServer.normalize("wss://Scape.Example.com/game/"))
        assertEquals("https://h", OnlineServer.normalize("https://h:443"))
        assertEquals("http://[::1]:8888", OnlineServer.normalize("http://[::1]:8888"))
        assertEquals("http://h/rs2.cgi", OnlineServer.normalize("http://h/rs2.cgi?x=1#y"))
        for (bad in listOf("ftp://h", "http://u:p@h", "http://h:0", "http://h:70000", "", "http://")) assertNull(bad, OnlineServer.normalize(bad))
        assertEquals("ws://h/", OnlineServer("s", "h", "http://h").socketUrl)
        assertEquals("wss://scape.example.com/game", OnlineServer("s", "h", "https://scape.example.com/game").socketUrl)
        assertEquals("ws://[::1]:8888/", OnlineServer("s", "h", "http://[::1]:8888").socketUrl)
    }

    @Test
    fun hostAndDisplayHost() {
        assertEquals("my-mac.local:8888", OnlineServer("s", "x", "http://my-mac.local:8888/game").displayHost)
        assertEquals("my-mac.local", OnlineServer("s", "x", "http://my-mac.local:8888/game").host)
        assertEquals("::1", OnlineServer("s", "x", "http://[::1]:8888").host)
        assertEquals("10.0.2.2", OnlineServer("s", "x", "http://10.0.2.2").host)
    }

    private fun settings(server: String?, vararg servers: JsonObject) = buildJsonObject {
        server?.let { put("server", JsonPrimitive(it)) }
        put("servers", JsonArray(servers.toList()))
    }

    private fun entry(id: String, url: String, name: String? = "Mac") = buildJsonObject {
        put("id", JsonPrimitive(id))
        put("url", JsonPrimitive(url))
        put("name", name?.let(::JsonPrimitive) ?: JsonNull)
    }

    @Test
    fun onlineOnlyForAStoredServerWithAUsableUrl() {
        val mac = entry("s-abc12345", "http://my-mac.local:8888")
        assertEquals(OnlineServer("s-abc12345", "Mac", "http://my-mac.local:8888"), OnlineServer.current(settings("s-abc12345", mac)))
        // the url is checked again (stored as the page wrote it, or not)
        assertEquals("http://my-mac.local:8888", OnlineServer.current(settings("s-abc12345", entry("s-abc12345", "My-Mac.local:8888/")))?.base)
        // a missing name is the address
        assertEquals("http://h", OnlineServer.current(settings("s-1", entry("s-1", "h", name = null)))?.name)
        assertNull(OnlineServer.current(settings("offline", mac)))
        assertNull(OnlineServer.current(settings(null, mac)))
        assertNull("a server not in the list", OnlineServer.current(settings("s-other", mac)))
        assertNull("a url that is no address", OnlineServer.current(settings("s-1", entry("s-1", "ftp://h"))))
        assertNull("an id that is no file name", OnlineServer.current(settings("../x", entry("../x", "http://h"))))
        assertNull(OnlineServer.current(JsonObject(emptyMap())))
        assertEquals(setOf("s-abc12345", "s-1"), OnlineServer.ids(settings(null, mac, entry("s-1", "h"), entry("a/b", "h"))))
    }

    @Test
    fun serverIds() {
        assertTrue(OnlineServer.isValidId("s-abc12345"))
        assertTrue(OnlineServer.isValidId("A_b-9"))
        assertTrue(OnlineServer.isValidId("x".repeat(64)))
        for (bad in listOf("", "x".repeat(65), "a/b", "..", "a b", "é", "a.b")) assertFalse(bad, OnlineServer.isValidId(bad))
    }

    private fun table(crcs: IntArray, trailer: Int? = null): ByteArray {
        val buffer = ByteBuffer.allocate(40)
        var check = 1234
        for (crc in crcs) {
            buffer.putInt(crc)
            check = (check shl 1) + crc
        }
        buffer.putInt(trailer ?: check)
        return buffer.array()
    }

    @Test
    fun crcTableTrailer() {
        val crcs = intArrayOf(0, 410306098, -12345, 7, 8, 9, -1, Int.MIN_VALUE, Int.MAX_VALUE)
        assertArrayEquals(crcs, GameCrc.table(table(crcs)))
        assertNull("a wrong trailer", GameCrc.table(table(crcs, trailer = 5)))
        assertNull("39 bytes", GameCrc.table(table(crcs).copyOf(39)))
        assertNull("41 bytes", GameCrc.table(table(crcs).copyOf(41)))
        // CRC-32 as zlib (the archives' names)
        assertEquals(0xCBF43926.toInt(), GameCrc.checksum("123456789".toByteArray()))
    }
}
