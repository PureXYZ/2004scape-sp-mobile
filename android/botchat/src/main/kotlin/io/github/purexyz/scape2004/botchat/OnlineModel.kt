// The bots' online chat model: Claude through the Messages API, with the player's own key (ModelKeyStore), when they choose
// Claude online in Settings › Bot chat (docs/ARCHITECTURE.md §7.1). The Kotlin port of the iOS app's
// ios/LostCity/OnlineModel.swift: the same request, byte for byte the same body, the same
// headers, the same error mapping and the same 8 s. The prompt is the engine's `renderOnline`: a static 2004 style guide (the
// same for every request, so it is cached), the bot's facts, and the chat.
//
// Every field was checked against the official API documentation on 2026-10-17 (the URLs are in OnlineModel.swift's
// header); in short:
// - `POST https://api.anthropic.com/v1/messages` with `x-api-key`, `anthropic-version: 2023-06-01` and
//   `content-type: application/json`.
// - `model: "claude-haiku-5-5"`, `max_tokens: 60`, `system` as text blocks (the guide's block with
//   `cache_control: {type: "ephemeral"}`, the bot's facts after it when there are any), one user turn whose content is a
//   string, `thinking: {type: "disabled"}` (Claude Haiku 5.5 thinks by default and accepts disabled at effort high or
//   below), `output_config: {effort: "low"}` (its default is medium). No `temperature`, `top_p` or `top_k`: non-default
//   values return a 400 on this model.
// - The reply's `content` blocks are read by `type`; `stop_reason: "refusal"` (an HTTP 200 with empty content and
//   `stop_details.category`) counts as declined; errors are `{type: "error", error: {type, message}}`.
//
// Decided for Android (docs/ANDROID.md §1 Bot chat): plain HttpURLConnection, not the Java SDK: the body must be exactly
// the one above (the mock in web/test/lm/mock-claude.mjs refuses any other field), the iPhone never retries (a 429 or 529
// falls back to the on-device model at once), and one POST needs no SDK. [Android differs, deliberately]: the 8 s is one
// limit on the whole call (URLSession's per-request value is an idle timeout, but the API answers in one piece, so the two
// behave the same here). The host lookup is inside it, as in URLSession's timeoutIntervalForResource: a disconnect cannot
// interrupt Android's blocking lookup (a network that drops DNS stalls it for 10-40 s), so at the limit the completion is
// a timeout at once, and the stuck request's own answer is dropped when it comes.
//
// The key is read for each request and never logged. Several requests may be in flight (BotChatModel allows 3).
package io.github.purexyz.scape2004.botchat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.max
import kotlin.math.min

class OnlineModel(private val main: MainPoster) {
    companion object {
        const val MODEL = "claude-haiku-5-5"
        const val MAX_TOKENS = 60
        const val API_VERSION = "2023-06-01"
        const val DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages"

        /** The request body: the guide first (cached), then the bot's own facts (left out when empty), one user turn. */
        fun body(system: String, context: String, user: String): JsonObject = buildJsonObject {
            put("model", MODEL)
            put("max_tokens", MAX_TOKENS)
            put("thinking", buildJsonObject { put("type", "disabled") })
            put("output_config", buildJsonObject { put("effort", "low") })
            put("system", buildJsonArray {
                add(buildJsonObject {
                    put("type", "text")
                    put("text", system)
                    put("cache_control", buildJsonObject { put("type", "ephemeral") })
                })
                if (context.isNotEmpty()) {
                    add(buildJsonObject {
                        put("type", "text")
                        put("text", context)
                    })
                }
            })
            put("messages", JsonArray(listOf(buildJsonObject {
                put("role", "user")
                put("content", user)
            })))
        }
    }

    data class Usage(val input: Long = 0, val output: Long = 0, val cacheRead: Long = 0, val cacheWrite: Long = 0) {
        val dictionary: Map<String, Any?> get() = linkedMapOf("input" to input, "output" to output, "cacheRead" to cacheRead, "cacheWrite" to cacheWrite)
    }

    class Output(val text: String, val usage: Usage, val ms: Double)

    sealed class Failure : Exception() {
        /** 401: the key was refused (the page says so: set it again). */
        object KeyRefused : Failure() {
            private fun readResolve(): Any = KeyRefused
        }
        /** A classifier declined the request (HTTP 200, `stop_reason: "refusal"`). */
        class Declined(val category: String?) : Failure()
        object Timeout : Failure() {
            private fun readResolve(): Any = Timeout
        }
        /** Any other HTTP status, with the API's error type. */
        class Http(val code: Int, val type: String) : Failure()
        class Network(val why: String) : Failure()
        /** A 200 with no text (a reply cut off before any). */
        class Empty(val stop: String) : Failure()

        /** The reason as the page protocol words it. */
        val reason: String
            get() = when (this) {
                KeyRefused, is Declined -> "refused"
                Timeout -> "timeout"
                is Http -> when (code) {
                    429 -> "failed: rate limited"
                    529 -> "failed: overloaded"
                    402 -> "failed: billing"
                    403 -> "failed: permission"
                    else -> "failed: http $code"
                }
                is Network -> "failed: network"
                is Empty -> "failed: empty"
            }

        /** For the Bot chat page (the key's status line). */
        val problem: String
            get() = when (this) {
                KeyRefused -> "key refused"
                is Declined -> "declined"
                Timeout -> "timed out"
                is Http -> when (code) {
                    429 -> "rate limited"
                    529 -> "overloaded"
                    402 -> "billing problem"
                    403 -> "no permission"
                    else -> "error $code"
                }
                is Network -> "no connection"
                is Empty -> "empty reply"
            }

        /** For the log (never the key). */
        val description: String
            get() = when (this) {
                is Declined -> "declined (${category ?: "no category"})"
                is Http -> "http $code $type"
                is Network -> "network: $why"
                is Empty -> "no text (stop_reason $stop)"
                else -> reason
            }

        override val message: String get() = description

        override fun toString() = description
    }

    /** Where requests go; a debug build's tests point it at a local mock server (never with a real key). */
    @Volatile var endpoint: String = DEFAULT_ENDPOINT

    // Requests run on their own threads (at most BotChatModel's 3 at once); one more thread enforces each request's limit.
    private val requests = Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "lostcity.online-model").apply { isDaemon = true }
    }
    private val watchdog = ScheduledThreadPoolExecutor(1) { runnable ->
        Thread(runnable, "lostcity.online-model.timeout").apply { isDaemon = true }
    }.apply { removeOnCancelPolicy = true }

    /** Writes one reply; [timeoutSec] is clamped to 1-8 s. The completion runs on the main thread, a [Failure] if it fails. */
    fun generate(key: String, system: String, context: String, user: String, timeoutSec: Double, completion: (Result<Output>) -> Unit) {
        val started = System.nanoTime()
        val url = endpoint
        val limitMs = (max(1.0, min(8.0, timeoutSec)) * 1000).toLong()
        val body = body(system, context, user).toString().toByteArray(Charsets.UTF_8)
        // (the first of the answer and the limit completes, once; the other is dropped)
        val done = AtomicBoolean(false)
        val finish: (Result<Output>) -> Unit = { result -> if (done.compareAndSet(false, true)) main.post { completion(result) } }
        requests.execute { finish(post(url, key, body, limitMs, started, finish)) }
    }

    /** Opens the connection (a test stands in one that a disconnect cannot cut, as Android's during the host lookup). */
    internal var open: (String) -> HttpURLConnection = { url -> URI(url).toURL().openConnection() as HttpURLConnection }

    private fun post(url: String, key: String, body: ByteArray, limitMs: Long, started: Long, finish: (Result<Output>) -> Unit): Result<Output> {
        val timedOut = AtomicBoolean(false)
        val connection = AtomicReference<HttpURLConnection?>(null)
        // (one limit on the whole call: the connection is cut when it is reached, wherever the request is, and the
        // completion is a timeout then even if the cut cannot reach the request, stuck in a host lookup)
        val cut = watchdog.schedule({
            timedOut.set(true)
            connection.get()?.disconnect()
            finish(Result.failure(Failure.Timeout))
        }, limitMs, TimeUnit.MILLISECONDS)
        return try {
            val opened = open(url)
            connection.set(opened)
            opened.requestMethod = "POST"
            opened.doOutput = true
            opened.useCaches = false
            opened.connectTimeout = limitMs.toInt()
            opened.readTimeout = limitMs.toInt()
            opened.setRequestProperty("x-api-key", key)
            opened.setRequestProperty("anthropic-version", API_VERSION)
            opened.setRequestProperty("content-type", "application/json")
            opened.setRequestProperty("accept", "application/json")
            opened.setFixedLengthStreamingMode(body.size)
            if (timedOut.get()) throw SocketTimeoutException("timeout")
            opened.outputStream.use { it.write(body) }
            val status = opened.responseCode
            val stream = if (status >= 400) opened.errorStream else opened.inputStream
            val text = stream?.use { String(it.readBytes(), Charsets.UTF_8) }
            val ms = msSince(started)
            val json = text?.let { runCatching { Json.parseToJsonElement(it) as? JsonObject }.getOrNull() }?.let(JsonBridge::toMap)
            map(status, json, ms)
        } catch (error: IOException) {
            Result.failure(if (timedOut.get() || error is SocketTimeoutException) Failure.Timeout else Failure.Network(networkWhy(error)))
        } catch (error: Exception) {
            Result.failure(if (timedOut.get()) Failure.Timeout else Failure.Network(networkWhy(error)))
        } finally {
            cut.cancel(false)
            connection.get()?.disconnect()
        }
    }

    /** OM-5: the status and the reply's JSON to a line or a failure. */
    private fun map(status: Int, json: Map<String, Any?>?, ms: Double): Result<Output> {
        if (status != 200) {
            if (status == 401) return Result.failure(Failure.KeyRefused)
            val type = SwiftCast.map(json?.get("error"))?.get("type") as? String ?: "?"
            return Result.failure(Failure.Http(status, type))
        }
        val stop = json?.get("stop_reason") as? String ?: "?"
        if (stop == "refusal") {
            return Result.failure(Failure.Declined(SwiftCast.map(json?.get("stop_details"))?.get("category") as? String))
        }
        val blocks = (json?.get("content") as? List<*>)?.mapNotNull { SwiftCast.map(it) } ?: emptyList()
        val text = blocks.filter { it["type"] as? String == "text" }
            .mapNotNull { it["text"] as? String }
            .joinToString("")
            .swiftTrim()
        if (text.isEmpty()) return Result.failure(Failure.Empty(stop))
        val usage = SwiftCast.map(json?.get("usage")) ?: emptyMap()
        return Result.success(Output(text, Usage(
            input = SwiftCast.exactLong(usage["input_tokens"]) ?: 0,
            output = SwiftCast.exactLong(usage["output_tokens"]) ?: 0,
            cacheRead = SwiftCast.exactLong(usage["cache_read_input_tokens"]) ?: 0,
            cacheWrite = SwiftCast.exactLong(usage["cache_creation_input_tokens"]) ?: 0,
        ), ms))
    }

    /** The transport's trouble in a few words for the log (iOS: "<domain> <code>"). Never the request, so never the key. */
    private fun networkWhy(error: Throwable): String = error.javaClass.simpleName + (error.message?.let { " $it" } ?: "")
}
