// NativeSettings (NativeSettings.swift's rules): a shallow merge, null removes a key, only JSON objects, at most 64 KB of
// sorted-key JSON, the old values kept when refused, and what is stored is read back.
package io.github.purexyz.scape2004

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeSettingsTest {
    private class Memory(var json: String? = null) : NativeSettings.Store {
        override fun load() = json
        override fun save(json: String) {
            this.json = json
        }
    }

    @Test
    fun mergeIsShallowAndNullRemoves() {
        val store = Memory()
        val settings = NativeSettings(store)
        assertTrue(settings.merge(buildJsonObject { put("bots", JsonPrimitive(25)); put("jmod", JsonPrimitive(true)) }))
        assertTrue(settings.merge(buildJsonObject { put("jmod", JsonNull); put("layout", JsonPrimitive("mobile")) }))
        assertEquals("""{"bots":25,"layout":"mobile"}""", store.json)
        assertEquals(setOf("bots", "layout"), settings.values.keys)
        // read back by a new instance (the next launch)
        assertEquals(settings.values, NativeSettings(store).values)
    }

    @Test
    fun onlyObjectsAreTaken() {
        val settings = NativeSettings(Memory())
        assertFalse(settings.merge(null))
        assertFalse(settings.merge(JsonPrimitive(3)))
        assertFalse(settings.merge(JsonArray(listOf(JsonPrimitive(1)))))
        assertTrue(settings.values.isEmpty())
    }

    @Test
    fun theSizeLimitKeepsTheOldValues() {
        val store = Memory()
        val settings = NativeSettings(store)
        settings.merge(buildJsonObject { put("a", JsonPrimitive(1)) })
        val before = store.json
        val big = "x".repeat(NativeSettings.MAX_BYTES)
        assertFalse(settings.merge(buildJsonObject { put("big", JsonPrimitive(big)) }))
        assertEquals(before, store.json)
        assertEquals(setOf("a"), settings.values.keys)
        // exactly the limit is fine: {"a":1,"b":""} is 14 bytes + the string
        assertTrue(settings.merge(buildJsonObject { put("b", JsonPrimitive("y".repeat(NativeSettings.MAX_BYTES - 14))) }))
        assertEquals(NativeSettings.MAX_BYTES, store.json!!.toByteArray().size)
    }

    @Test
    fun corruptStorageStartsEmpty() {
        assertTrue(NativeSettings(Memory("{not json")).values.isEmpty())
        assertTrue(NativeSettings(Memory("[1,2]")).values.isEmpty())
    }

    @Test
    fun keysAreSortedAtEveryLevel() {
        val store = Memory()
        NativeSettings(store).merge(buildJsonObject {
            put("z", buildJsonObject { put("b", JsonPrimitive(1)); put("a", JsonPrimitive(2)) })
            put("m", JsonPrimitive("a/b"))
        })
        assertEquals("""{"m":"a/b","z":{"a":2,"b":1}}""", store.json)
    }
}
