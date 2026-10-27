// SocketBridge: the page's WebSockets online (ports ios/LostCity/SocketBridge.swift; docs/ARCHITECTURE.md §7.3,
// docs/ANDROID.md §7). The page's `NativeSocket` (host.js) stands in for `window.WebSocket`, and its sockets are opened
// here, with OkHttp, to the server of the page load (OnlineProxy.server), whatever URL the client asked for. (WebView's
// own WebSocket would send the app's origin and, from the https origin, could not use a plain `ws://` server at all.)
//
// page → native `{type:'socket', action:'open'|'send'|'close', id, purpose?, data?}`; native → page
// `LostCityHost.socket.events([{id, event, data?, code?, reason?}])`, one call for everything that arrived together (a
// batch is sent 2 ms after its first event), in arrival order. Events: `open`; `message` (`data`: base64 of one binary
// message); `error` (`reason`: `refused`, `timed out`, `not found`, `dns`, `tls`, `http <status>`, `network`, `no
// server`, `text frame`, `local network`), always followed by `close` (1006 and the same words); `close` (the server's
// code and reason), final.
//
// * The upgrade asks for the `binary` subprotocol, sends the app's User-Agent and no Origin, no cookies (Network). 10 s to
//   open.
// * Sends keep their order: OkHttp queues them until the socket is open and writes them one at a time.
// * OkHttp reads each socket on one thread and its callbacks are posted to the UI thread in that order, so the messages
//   that came before a close are always handed over before it (iOS waits for its receive loop to drain).
// * A close from the page ends the socket with 1000 and no more events for it (the page fires its own `close`, as
//   EngineSocket does). Sockets of a page that goes away (a load, a reload, a renderer death) are closed with 1001
//   (`reset`), and events still on their way are dropped.
// * Nothing is kept alive in the background (no pings). A socket that ended while the app was stopped is reported when
//   the WebView's timers run again.
// * The log has each socket's host, purpose, open, close code, error and message counts, never what was sent (the login
//   block holds the password).
//
// The UI thread owns the state (handle, reset and the posted callbacks); OkHttp's threads only post.
package io.github.purexyz.scape2004

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.UnknownHostException
import java.util.Base64
import javax.net.ssl.SSLException

class SocketBridge(
    private val scheduler: Scheduler,
    /** `LostCityHost.socket.events(events)` on the page. */
    private val deliver: (JsonArray) -> Unit,
    private val client: OkHttpClient = Network.client,
    private val localNetwork: LocalNetwork = LocalNetwork.None,
    /** The phone has a network with internet (an unknown host without one is `network`, not `not found`). */
    private val hasNetwork: () -> Boolean = { true },
) {
    /** The page load's server (null: offline, where every `open` fails with `no server`). */
    var server: () -> OnlineServer? = { null }

    private val sockets = HashMap<Int, Connection>()
    private val pending = ArrayList<JsonObject>()
    private var flushScheduled = false

    /** Counts pages: events of a socket from an earlier page are dropped. */
    private var page = 0

    /** Sockets open now (the debug hook `online-state`). */
    val openCount: Int get() = sockets.size

    // ------------------------------------------------------------------------------------------------ page → native

    fun handle(message: JsonObject) {
        val id = message.long("id")?.toInt()
        if (id == null) {
            Log.info("socket", "ignored a socket message without an id")
            return
        }
        when (message.string("action")) {
            "open" -> open(id, message.string("purpose") ?: "game")
            "send" -> {
                val connection = sockets[id] ?: return
                val data = message.string("data")?.let {
                    try {
                        Base64.getDecoder().decode(it)
                    } catch (_: IllegalArgumentException) {
                        null
                    }
                }
                if (data == null) {
                    Log.info("socket", "${connection.label}: ignored a send that is not base64")
                    return
                }
                if (connection.socket?.send(data.toByteString()) == true) connection.sent += 1
            }
            "close" -> {
                val connection = sockets[id] ?: return
                Log.info("socket", "${connection.label} closed by the page (sent ${connection.sent}, received ${connection.received})")
                val wasOpen = connection.state == State.OPEN
                forget(connection)
                if (wasOpen) connection.socket?.close(1000, null) else connection.socket?.cancel()
            }
            else -> Log.info("socket", "unknown socket action: ${message.string("action") ?: "none"}")
        }
    }

    private fun open(id: Int, purpose: String) {
        if (sockets.containsKey(id)) {
            Log.info("socket", "socket $id: already open, ignored")
            return
        }
        val connection = Connection(id, purpose, page)
        sockets[id] = connection
        val server = server()
        val request = server?.let {
            try {
                Request.Builder().url(it.socketUrl).header("Sec-WebSocket-Protocol", "binary").build()
            } catch (_: IllegalArgumentException) {
                null
            }
        }
        if (server == null || request == null) {
            Log.info("socket", "${connection.label}: no server for this page")
            fail(connection, "no server")
            return
        }
        connection.host = server.displayHost
        connection.hostName = server.host
        Log.info("socket", "${connection.label} opening ${server.socketUrl}")
        connection.socket = client.newWebSocket(request, Listener(connection))
        connection.timer = scheduler.postDelayed(OPEN_TIMEOUT_MS) {
            if (connection.state != State.CONNECTING) return@postDelayed
            Log.info("socket", "${connection.label}: no answer in ${OPEN_TIMEOUT_MS / 1000} s")
            fail(connection, if (localNetwork.refused(connection.hostName, java.net.SocketTimeoutException())) LocalNetwork.WORDS else "timed out")
            connection.socket?.cancel()
        }
    }

    /** An error and its close at once (no server, timed out, a text frame, a failure). */
    private fun fail(connection: Connection, words: String) {
        if (connection.state == State.CLOSED) return
        emit(connection, buildJsonObject { put("event", JsonPrimitive("error")); put("reason", JsonPrimitive(words)) })
        emit(connection, closeEvent(1006, words))
        Log.info("socket", "${connection.label} error: $words")
        forget(connection)
    }

    private fun closeEvent(code: Int, reason: String) = buildJsonObject {
        put("event", JsonPrimitive("close"))
        put("code", JsonPrimitive(code))
        put("reason", JsonPrimitive(reason))
    }

    // ------------------------------------------------------------------------------------------------ OkHttp → events

    /** OkHttp's callbacks for one socket, on its threads: each is posted to the UI thread, in order. */
    private inner class Listener(private val connection: Connection) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = scheduler.post {
            if (connection.state != State.CONNECTING) return@post
            connection.state = State.OPEN
            connection.timer?.cancel()
            Log.info("socket", "${connection.label} open")
            emit(connection, buildJsonObject { put("event", JsonPrimitive("open")) })
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) = scheduler.post {
            if (connection.state == State.CLOSED) return@post
            connection.received += 1
            emit(connection, buildJsonObject {
                put("event", JsonPrimitive("message"))
                put("data", JsonPrimitive(Base64.getEncoder().encodeToString(bytes.toByteArray())))
            })
        }

        override fun onMessage(webSocket: WebSocket, text: String) = scheduler.post {
            // the game speaks binary only
            if (connection.state == State.CLOSED) return@post
            Log.info("socket", "${connection.label}: a text frame")
            fail(connection, "text frame")
            webSocket.close(1003, null)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            // (the close handshake's answer; a code that may not be sent, such as 1005 for none, is answered 1000)
            try {
                webSocket.close(if (code in 1000..4999 && code !in 1004..1006 && code != 1015) code else 1000, null)
            } catch (_: IllegalArgumentException) {
                webSocket.close(1000, null)
            }
            scheduler.post {
                if (connection.state == State.CLOSED) return@post
                Log.info("socket", "${connection.label} closed $code${if (reason.isEmpty()) "" else " ($reason)"} (sent ${connection.sent}, received ${connection.received})")
                emit(connection, closeEvent(code, reason))
                forget(connection)
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            val words = words(t, response, connection.hostName, localNetwork, hasNetwork)
            scheduler.post { fail(connection, words) }
        }
    }

    // ------------------------------------------------------------------------------------------------ batching

    private fun emit(connection: Connection, event: JsonObject) {
        if (connection.page != page) return
        pending += JsonObject(event + ("id" to JsonPrimitive(connection.id)))
        if (flushScheduled) return
        flushScheduled = true
        scheduler.postDelayed(BATCH_WINDOW_MS) { flush() }
    }

    private fun flush() {
        flushScheduled = false
        if (pending.isEmpty()) return
        val events = JsonArray(pending.toList())
        pending.clear()
        deliver(events)
    }

    private fun forget(connection: Connection) {
        connection.state = State.CLOSED
        connection.timer?.cancel()
        if (sockets[connection.id] === connection) sockets.remove(connection.id)
    }

    /** The page went away: its sockets are closed (1001) and their events dropped. */
    fun reset() {
        page += 1
        pending.clear()
        val open = sockets.values.toList()
        sockets.clear()
        for (connection in open) {
            Log.info("socket", "${connection.label} closed: the page went away (sent ${connection.sent}, received ${connection.received})")
            val wasOpen = connection.state == State.OPEN
            forget(connection)
            if (wasOpen) connection.socket?.close(1001, null) else connection.socket?.cancel()
        }
    }

    // ------------------------------------------------------------------------------------------------ types

    private enum class State { CONNECTING, OPEN, CLOSED }

    private class Connection(val id: Int, val purpose: String, val page: Int) {
        var host = ""
        var hostName = ""
        var socket: WebSocket? = null
        var state = State.CONNECTING
        var timer: Cancellable? = null
        var sent = 0
        var received = 0

        val label: String get() = "socket $id ($purpose${if (host.isEmpty()) "" else " @ $host"})"
    }

    companion object {
        const val OPEN_TIMEOUT_MS = 10_000L

        /**
         * How long a batch collects events: OkHttp's reader hands the messages of one burst over one by one, each posted on
         * its own; within 2 ms they go to the page as one call (iOS measured 50 messages in 43 run-loop turns without it).
         */
        const val BATCH_WINDOW_MS = 2L

        /**
         * The plain words for a failed upgrade or a dropped connection. An unknown host is `not found` only while the phone
         * has a network: without one (airplane mode, no Wi-Fi) Android's resolver says the same ("No address associated
         * with hostname"), and that is `network`, as iOS reports it.
         */
        fun words(error: Throwable, response: Response?, host: String, localNetwork: LocalNetwork, hasNetwork: () -> Boolean = { true }): String {
            if (response != null && response.code != 101) return "http ${response.code}"
            if (localNetwork.refused(host, error)) return LocalNetwork.WORDS
            return when (error) {
                is UnknownHostException -> when {
                    !hasNetwork() -> "network"
                    error.message?.contains("Try again") == true || error.message?.contains("EAI_AGAIN") == true -> "dns"
                    else -> "not found"
                }
                is ConnectException -> "refused"
                is InterruptedIOException -> "timed out" // (SocketTimeoutException too)
                is SSLException -> "tls"
                else -> "network"
            }
        }
    }
}
