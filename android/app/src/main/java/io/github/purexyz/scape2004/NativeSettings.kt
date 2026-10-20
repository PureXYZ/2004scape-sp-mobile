// NativeSettings: the settings the page asks native to keep (ports ios/LostCity/NativeSettings.swift; ARCHITECTURE.md §7
// `{type:'settings', values}`). They are handed back on every page load as
// `window.LostCityNative.settings` (NativeScripts), so a setting that needs a restart survives one.
//
// Stored as one JSON string in SharedPreferences ("LostCity", key "LostCity.settings"), as iOS stores JSON bytes in
// UserDefaults: page values may contain null. Incoming values are merged shallowly, so the page may send only what
// changed; a null value removes the key. The whole object must stay a JSON object of at most 64 KB (measured on the UTF-8
// bytes of its sorted-key encoding, like iOS's JSONSerialization `.sortedKeys`), or the merge is refused and the old
// values kept. Writes use apply(): Android waits for pending apply() writes at onPause/onStop.
package io.github.purexyz.scape2004

import android.content.Context
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

class NativeSettings(private val store: Store) {
    /** Where the JSON lives (SharedPreferences in the app, a string in the JVM tests). */
    interface Store {
        fun load(): String?
        fun save(json: String)
    }

    /** SharedPreferences "LostCity", key "LostCity.settings". */
    class Prefs(context: Context) : Store {
        private val prefs = context.getSharedPreferences("LostCity", Context.MODE_PRIVATE)
        override fun load(): String? = prefs.getString(KEY, null)
        override fun save(json: String) {
            prefs.edit().putString(KEY, json).apply()
        }
    }

    var values: JsonObject = (store.load()?.let(JsonText::parse) as? JsonObject) ?: JsonObject(emptyMap())
        private set

    /** Returns false (and keeps the old values) if `incoming` is not a JSON object or the result is too big. */
    fun merge(incoming: JsonElement?): Boolean {
        val update = incoming as? JsonObject ?: return false
        val next = LinkedHashMap(values)
        for ((key, value) in update) {
            if (value is JsonNull) next.remove(key) else next[key] = value
        }
        val merged = JsonObject(next)
        val json = JsonText.canonical(merged)
        if (json.toByteArray(Charsets.UTF_8).size > MAX_BYTES) return false
        values = JsonText.sorted(merged) as JsonObject
        store.save(json)
        return true
    }

    companion object {
        const val KEY = "LostCity.settings"
        const val MAX_BYTES = 64 * 1024
    }
}
