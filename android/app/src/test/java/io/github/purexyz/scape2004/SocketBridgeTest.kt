// SocketBridge on the JVM against a local WebSocket server (MockWebServer): the events and their order, base64 both
// ways, batching, the upgrade's headers (binary, the User-Agent, no Origin), the server's close with its code and reason
// after every message, a text frame, a dropped connection, a refused upgrade, nothing listening, no server, the page's
// own close (no events after it, 1000 at the server), a page reset (1001), and unknown ids.
//
// The "UI thread" is one executor thread here: the bridge's state is touched only there, as in the app.
package io.github.purexyz.scape2004

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.ServerSocket
import java.util.Base64
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

class SocketBridgeTest {
    /** A Scheduler on one thread of its own (the bridge's "UI thread"). */
    private class ThreadScheduler : Scheduler {
        val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { Thread(it, "ui") }

        override fun post(action: () -> Unit) {
            executor.execute(action)
        }

        override fun postDelayed(delayMs: Long, action: () -> Unit): Cancellable {
            val future = executor.schedule(action, delayMs, TimeUnit.MILLISECONDS)
            return Cancellable { future.cancel(false) }
        }

        override fun isMainThread() = Thread.currentThread().name == "ui"

        override fun now() = System.nanoTime() / 1_000_000
    }

    /** What the server side saw of each connection. */
    private class Seen(val request: RecordedRequest?) {
        @Volatile var closeCode: Int? = null
        @Volatile var failed = false
        val received: MutableList<ByteString> = Collections.synchronizedList(ArrayList())
    }

    private lateinit var scheduler: ThreadScheduler
    private lateinit var server: MockWebServer
    private lateinit var bridge: SocketBridge
    private val calls: MutableList<JsonArray> = Collections.synchronizedList(ArrayList())
    private val connections: MutableList<Seen> = Collections.synchronizedList(ArrayList())
    @Volatile private var target: OnlineServer? = null

    /** The server: echoes binary messages; a message that starts with 0xFF is a command (online-stub.mjs's). */
    private val serverSide = object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            val seen = connections.last()
            seen.received += bytes
            if (bytes.size == 0 || bytes[0] != 0xff.toByte()) {
                webSocket.send(bytes)
                return
            }
            val command = bytes.substring(1).utf8().split(' ')
            when (command[0]) {
                "burst" -> repeat(command[1].toInt()) { i -> webSocket.send(byteArrayOf(0xb0.toByte(), (i shr 8).toByte(), i.toByte(), 0).toByteString()) }
                "then-close" -> {
                    for (i in 1..3) webSocket.send(byteArrayOf(i.toByte()).toByteString())
                    webSocket.close(4000, "bye")
                }
                "text" -> webSocket.send("hello")
                "drop" -> webSocket.cancel()
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            connections.last().closeCode = code
            webSocket.close(code, null)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            connections.last().failed = true
        }
    }

    @Before
    fun setUp() {
        scheduler = ThreadScheduler()
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                connections += Seen(request)
                return if (request.path?.startsWith("/refuse") == true) MockResponse().setResponseCode(403)
                else MockResponse().withWebSocketUpgrade(serverSide)
            }
        }
        server.start()
        bridge = SocketBridge(scheduler, { calls += it }, Network.client("2004Scape/test (Android test)"))
        bridge.server = { target }
        target = OnlineServer("s-test", "Test", server.url("/").toString().trimEnd('/'))
    }

    @After
    fun tearDown() {
        onUi { bridge.reset() }
        server.shutdown()
        scheduler.executor.shutdownNow()
    }

    private fun <T> onUi(block: () -> T): T = scheduler.executor.submit<T> { block() }.get(5, TimeUnit.SECONDS)

    private fun message(action: String, id: Int, extra: Map<String, String> = emptyMap()) = onUi {
        bridge.handle(buildJsonObject {
            put("type", JsonPrimitive("socket"))
            put("action", JsonPrimitive(action))
            put("id", JsonPrimitive(id))
            for ((k, v) in extra) put(k, JsonPrimitive(v))
        })
    }

    private fun open(id: Int) = message("open", id, mapOf("purpose" to "game"))
    private fun send(id: Int, bytes: ByteArray) = message("send", id, mapOf("data" to Base64.getEncoder().encodeToString(bytes)))
    private fun command(id: Int, text: String) = send(id, byteArrayOf(0xff.toByte()) + text.toByteArray())
    private fun close(id: Int) = message("close", id)

    private fun events(id: Int): List<JsonObject> = synchronized(calls) { calls.flatten() }.map { it.jsonObject }.filter { it["id"]?.jsonPrimitive?.int == id }

    private fun summary(id: Int) = events(id).map { e ->
        val event = e.string("event")
        if (event == "message") "m" + Base64.getDecoder().decode(e.string("data")).joinToString(",") else event + (e.long("code") ?: "") + (e.string("reason")?.takeIf { it.isNotEmpty() }?.let { " $it" } ?: "")
    }

    private fun until(ms: Long = 5000, condition: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return true
            Thread.sleep(20)
        }
        return condition()
    }

    @Test
    fun openSendInOrderAndEcho() {
        open(1)
        send(1, byteArrayOf(1, 2, 3)) // (before the open event: OkHttp queues it)
        send(1, byteArrayOf(4, 5))
        assertTrue(until { summary(1).size >= 3 })
        assertEquals(listOf("open", "m1,2,3", "m4,5"), summary(1))
        // a 5,000-byte message, byte for byte
        val big = ByteArray(5000) { (it * 13 + 7).toByte() }
        send(1, big)
        assertTrue(until { summary(1).size >= 4 })
        assertArrayEquals(big, Base64.getDecoder().decode(events(1)[3].string("data")))
        // 60 in a row come back in order
        for (i in 0 until 60) send(1, byteArrayOf(0xa0.toByte(), i.toByte()))
        assertTrue(until { summary(1).size >= 64 })
        assertEquals((0 until 60).map { "m-96,$it" }, summary(1).drop(4))
        // the upgrade: binary, the app's User-Agent, no Origin, no cookie
        val upgrade = connections.first().request!!
        assertEquals("binary", upgrade.getHeader("Sec-WebSocket-Protocol"))
        assertEquals("2004Scape/test (Android test)", upgrade.getHeader("User-Agent"))
        assertNull(upgrade.getHeader("Origin"))
        assertNull(upgrade.getHeader("Cookie"))
        assertEquals(1, onUi { bridge.openCount })
    }

    @Test
    fun aBurstComesInFewCalls() {
        open(2)
        assertTrue(until { summary(2) == listOf("open") })
        val before = calls.size
        command(2, "burst 50")
        assertTrue(until { summary(2).size >= 51 })
        val burst = events(2).drop(1).map { Base64.getDecoder().decode(it.string("data")) }
        assertTrue(burst.withIndex().all { (i, m) -> m[0] == 0xb0.toByte() && ((m[1].toInt() and 0xff) shl 8 or (m[2].toInt() and 0xff)) == i })
        val used = calls.size - before
        assertTrue("50 messages in $used calls", used < 25)
    }

    @Test
    fun theServersCloseAfterEveryMessage() {
        open(3)
        assertTrue(until { summary(3) == listOf("open") })
        command(3, "then-close")
        assertTrue(until { summary(3).lastOrNull()?.startsWith("close") == true })
        assertEquals(listOf("open", "m1", "m2", "m3", "close4000 bye"), summary(3))
        assertEquals(0, onUi { bridge.openCount })
    }

    @Test
    fun aTextFrameIsAnError() {
        open(4)
        assertTrue(until { summary(4) == listOf("open") })
        command(4, "text")
        assertTrue(until { summary(4).lastOrNull()?.startsWith("close") == true })
        assertEquals(listOf("open", "error text frame", "close1006 text frame"), summary(4))
        assertTrue(until { connections.last().closeCode == 1003 })
    }

    @Test
    fun aDroppedConnection() {
        open(5)
        assertTrue(until { summary(5) == listOf("open") })
        command(5, "drop")
        assertTrue(until { summary(5).lastOrNull()?.startsWith("close") == true })
        assertEquals(listOf("open", "error network", "close1006 network"), summary(5))
    }

    @Test
    fun aRefusedUpgradeNothingListeningAndNoServer() {
        target = OnlineServer("s-test", "Test", server.url("/refuse").toString().trimEnd('/'))
        open(6)
        assertTrue(until { summary(6).size == 2 })
        assertEquals(listOf("error http 403", "close1006 http 403"), summary(6))
        val closed = ServerSocket(0).use { it.localPort }
        target = OnlineServer("s-test", "Test", "http://127.0.0.1:$closed")
        open(7)
        assertTrue(until { summary(7).size == 2 })
        assertEquals(listOf("error refused", "close1006 refused"), summary(7))
        target = null
        open(8)
        assertTrue(until { summary(8).size == 2 })
        assertEquals(listOf("error no server", "close1006 no server"), summary(8))
    }

    @Test
    fun thePagesCloseAndReset() {
        open(9)
        assertTrue(until { summary(9) == listOf("open") })
        close(9)
        close(9) // (idempotent)
        send(9, byteArrayOf(9)) // (ignored)
        assertTrue(until { connections.first().closeCode == 1000 })
        Thread.sleep(300)
        assertEquals("no event after the page's close", listOf("open"), summary(9))
        // unknown ids, an id in use
        send(4242, byteArrayOf(1))
        close(4242)
        open(10)
        assertTrue(until { summary(10) == listOf("open") })
        open(10)
        Thread.sleep(300)
        assertEquals(listOf("open"), summary(10))
        assertTrue(events(4242).isEmpty())
        // the page goes away: its sockets close with 1001, nothing more reaches the page
        onUi { bridge.reset() }
        assertTrue(until { connections.last().closeCode == 1001 })
        Thread.sleep(300)
        assertEquals(listOf("open"), summary(10))
        assertEquals(0, onUi { bridge.openCount })
    }

    @Test
    fun errorWords() {
        val none = LocalNetwork.None
        assertEquals("refused", SocketBridge.words(java.net.ConnectException("ECONNREFUSED"), null, "h", none))
        assertEquals("timed out", SocketBridge.words(java.net.SocketTimeoutException(), null, "h", none))
        assertEquals("not found", SocketBridge.words(java.net.UnknownHostException("Unable to resolve host \"x\": No address associated with hostname"), null, "h", none))
        assertEquals("dns", SocketBridge.words(java.net.UnknownHostException("Unable to resolve host \"x\": Try again"), null, "h", none))
        assertEquals("tls", SocketBridge.words(javax.net.ssl.SSLHandshakeException("bad cert"), null, "h", none))
        assertEquals("network", SocketBridge.words(java.io.EOFException(), null, "h", none))
        // no network at all (airplane mode): the resolver says "no address" as for a host that does not exist
        assertEquals("network", SocketBridge.words(java.net.UnknownHostException("Unable to resolve host \"x\": No address associated with hostname"), null, "h", none) { false })
        assertEquals("network", SocketBridge.words(java.net.UnknownHostException("Unable to resolve host \"x\": Try again"), null, "h", none) { false })
        // Android 17's refusal of the local network, when the permission is missing
        val missing = object : LocalNetwork {
            override fun refused(host: String, error: Throwable) = LocalNetwork.looksRefused(error)
        }
        val eperm = java.net.ConnectException("Failed to connect").apply { initCause(java.net.SocketException("connect failed: EPERM (Operation not permitted)")) }
        assertEquals("local network", SocketBridge.words(eperm, null, "192.168.1.20", missing))
        assertEquals("refused", SocketBridge.words(eperm, null, "192.168.1.20", none))
    }

    @Test
    fun localNetworkAsAndroid17SeesIt() {
        for (host in listOf("192.168.1.20", "10.0.2.2", "172.16.0.1", "172.31.255.255", "169.254.1.1", "my-mac.local", "My-Mac.local.", "fd00::1", "fe80::1")) {
            assertTrue(host, LocalNetwork.isLocalHost(host))
        }
        for (host in listOf("127.0.0.1", "8.8.8.8", "172.32.0.1", "192.169.0.1", "::1", "scape.example.com", "local", "2001:db8::1", "300.1.1.1")) {
            assertTrue(host, !LocalNetwork.isLocalHost(host))
        }
        // (measured on the API 37 emulator with the restriction on: a local address times out)
        assertTrue(LocalNetwork.blocks("10.0.2.2", java.net.SocketTimeoutException()))
        assertTrue(LocalNetwork.blocks("192.168.1.20", java.io.InterruptedIOException("timeout")))
        assertTrue(LocalNetwork.blocks("scape.example.com", java.net.SocketException("EPERM (Operation not permitted)")))
        assertTrue(!LocalNetwork.blocks("scape.example.com", java.net.SocketTimeoutException()))
        assertTrue(!LocalNetwork.blocks("127.0.0.1", java.net.ConnectException("ECONNREFUSED")))
        assertTrue("a local server not listening stays refused", !LocalNetwork.blocks("192.168.1.20", java.net.ConnectException("ECONNREFUSED")))
    }
}
