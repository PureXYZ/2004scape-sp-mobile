// Json: the few JSON helpers the shell needs on top of kotlinx-serialization's JsonElement API (docs/ANDROID.md §1 SDKs:
// the element API only, no compiler plugin). The iOS app uses JSONSerialization with `.sortedKeys` wherever JSON is
// stored, measured or logged (NativeSettings, the injected LostCityNative, PageBridge's log lines); `canonical` is that
// encoding: keys sorted at every level, compact, '/' not escaped.
package io.github.purexyz.scape2004

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

object JsonText {
    /** The element with every object's keys sorted (recursively): `JSONSerialization` with `.sortedKeys`. */
    fun sorted(element: JsonElement): JsonElement = when (element) {
        is JsonObject -> JsonObject(element.entries.sortedBy { it.key }.associateTo(LinkedHashMap()) { it.key to sorted(it.value) })
        is JsonArray -> JsonArray(element.map(::sorted))
        else -> element
    }

    /** Compact JSON with sorted keys. */
    fun canonical(element: JsonElement): String = sorted(element).toString()

    /** The parsed element, or null when `text` is not JSON. */
    fun parse(text: String): JsonElement? = try {
        Json.parseToJsonElement(text)
    } catch (_: Exception) {
        null
    }

    /** A string as a JSON string literal (for scripts handed to evaluateJavascript). */
    fun quote(text: String): String = JsonPrimitive(text).toString()
}

/** A string member, or null when absent or not a string. */
fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

/** A boolean member, or null. */
fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

/** A whole-number member, or null. */
fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.let { it.longOrNull ?: it.doubleOrNull?.toLong() }

/** A number member, or null. */
fun JsonObject.double(key: String): Double? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull

/** How the iOS log lines print a value: a string as it is, anything else as compact JSON. */
fun JsonElement?.display(): String = when {
    this == null || this is JsonNull -> "null"
    this is JsonPrimitive && isString -> content
    else -> JsonText.canonical(this)
}
