// The Claude key's store on a real Android: saved, read and removed through the
// AndroidKeyStore; a damaged file or a lost Keystore key counts as no key (and the file goes), while a Keystore failure
// that may pass keeps the file and is read again; the key never reaches logcat.
package io.github.purexyz.scape2004.llm

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.purexyz.scape2004.botchat.ModelKeyStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore
import java.security.ProviderException

@RunWith(AndroidJUnit4::class)
class KeyStoreDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val key = "sk-ant-test-device-wxyz"

    @Before
    fun clean() {
        AndroidModelKeyStore(context, TestLog).remove()
    }

    @Test
    fun savesReadsAndRemoves() {
        val store = AndroidModelKeyStore(context, TestLog)
        assertNull(store.read())
        assertTrue(store.save(key))
        assertEquals(key, store.read())
        assertEquals("…wxyz", ModelKeyStore.hint(store.read()))
        // a new instance (the next launch) reads it back from the file through the Keystore
        val again = AndroidModelKeyStore(context, TestLog)
        assertEquals(key, again.read())
        assertTrue(again.file.exists())
        val bytes = again.file.readBytes()
        assertEquals("LCK1", String(bytes, 0, 4))
        assertFalse("the key is not in the file in clear", String(bytes, Charsets.ISO_8859_1).contains("sk-ant"))
        assertTrue(again.remove())
        assertFalse(again.file.exists())
        assertNull(AndroidModelKeyStore(context, TestLog).read())
        assertTrue(again.remove())  // (none: still true)
    }

    @Test
    fun aDamagedFileIsNoKeyAndGoes() {
        AndroidModelKeyStore(context, TestLog).save(key)
        val store = AndroidModelKeyStore(context, TestLog)
        val bytes = store.file.readBytes()
        bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 0x55).toByte()
        store.file.writeBytes(bytes)
        assertNull(store.read())
        assertFalse(store.file.exists())
        assertTrue(TestLog.has("the stored Claude key could not be read (AEADBadTagException): removed"))
    }

    @Test
    fun aLostKeystoreKeyIsNoKey() {
        AndroidModelKeyStore(context, TestLog).save(key)
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(AndroidModelKeyStore.ALIAS)
        val store = AndroidModelKeyStore(context, TestLog)
        assertNull(store.read())
        assertFalse(store.file.exists())
        // and a new key can be saved again (the Keystore key is made again)
        assertTrue(store.save(key))
        assertEquals(key, AndroidModelKeyStore(context, TestLog).read())
        store.remove()
    }

    @Test
    fun aKeystoreFailureKeepsTheKeyAndIsReadAgain() {
        AndroidModelKeyStore(context, TestLog).save(key)
        var failures = 2
        val store = AndroidModelKeyStore(context, TestLog) { create ->
            // (what keystore2 throws while it restarts after an update, or on a TEE glitch)
            if (failures-- > 0) throw ProviderException("Keystore operation failed")
            AndroidModelKeyStore.keystoreKey(create)
        }
        assertNull(store.read())
        assertTrue("the file is kept", store.file.exists())
        assertTrue(TestLog.has("the stored Claude key could not be read now (ProviderException): kept, read again later"))
        assertNull("not cached: read again, and failing again", store.read())
        assertTrue(store.file.exists())
        assertEquals("the next read gets the key", key, store.read())
        store.remove()
    }

    @Test
    fun theKeyNeverReachesLogcat() {
        val store = AndroidModelKeyStore(context, TestLog)
        store.save(key)
        store.read()
        store.remove()
        val log = shell("logcat -d")
        assertFalse(log.contains(key))
        assertFalse(log.contains("sk-ant-test-device"))
    }
}
