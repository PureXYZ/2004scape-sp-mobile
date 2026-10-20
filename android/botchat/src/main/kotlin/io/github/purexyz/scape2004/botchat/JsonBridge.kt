// Between the page's JSON and the plain values the bots' chat model works with. The iOS app gets `[String: Any]` from
// WebKit and hands `[String: Any]` back (JSONSerialization); the Android app speaks kotlinx-serialization's JsonElement
// (docs/ANDROID.md §1: the JsonElement API only, no compiler plugin). BotChatModel keeps the Swift shapes, so its code reads
// like the Swift, and this file converts at the edges (AndroidBotChat, the harness).
package io.github.purexyz.scape2004.botchat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

object JsonBridge {
    /** A JSON value as String, Boolean, Long or Double, List, Map (insertion order) or null. */
    fun toAny(element: JsonElement?): Any? = when (element) {
        null, JsonNull -> null
        is JsonObject -> toMap(element)
        is JsonArray -> element.map { toAny(it) }
        is JsonPrimitive -> when {
            element.isString -> element.content
            element.booleanOrNull != null -> element.booleanOrNull
            else -> element.longOrNull ?: element.doubleOrNull
        }
    }

    fun toMap(element: JsonObject): Map<String, Any?> = element.entries.associateTo(LinkedHashMap()) { (key, value) -> key to toAny(value) }

    /**
     * A plain value as JSON. A null is JSON null (Swift's NSNull: `text: null` reaches the page as null); a number that is not
     * finite, which JSON cannot carry, becomes null too.
     */
    fun toJson(value: Any?): JsonElement = when (value) {
        null -> JsonNull
        is JsonElement -> value
        is String -> JsonPrimitive(value)
        is Boolean -> JsonPrimitive(value)
        is Int -> JsonPrimitive(value)
        is Long -> JsonPrimitive(value)
        is Double -> if (value.isFinite()) JsonPrimitive(value) else JsonNull
        is Float -> if (value.isFinite()) JsonPrimitive(value) else JsonNull
        is Number -> JsonPrimitive(value)
        is Map<*, *> -> JsonObject(value.entries.associateTo(LinkedHashMap()) { (key, item) -> key.toString() to toJson(item) })
        is List<*> -> JsonArray(value.map { toJson(it) })
        is DoubleArray -> JsonArray(value.map { toJson(it) })
        is IntArray -> JsonArray(value.map { JsonPrimitive(it) })
        else -> JsonPrimitive(value.toString())
    }

    fun toJsonObject(value: Map<String, Any?>): JsonObject = toJson(value) as JsonObject
}
