// ServerPasswordStore on the JVM, with a plain AES key where the app has the AndroidKeyStore's: save, read, replace,
// forget, a server's passwords all at once, the listing (lower-case names, no decryption), the game's limits, a file
// that is not one, a file moved to another account (the AAD), a lost key, and that no file holds the password as text.
package io.github.purexyz.scape2004

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

class ServerPasswordStoreTest {
    private lateinit var dir: File
    private var key: SecretKey? = null
    private lateinit var store: ServerPasswordStore

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("passwords").toFile()
        store = ServerPasswordStore(dir) { create ->
            if (key == null && create) key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
            key
        }
    }

    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    @Test
    fun saveReadReplaceForget() {
        assertTrue(store.save("s-abc12345", "Tester", "Pw4OnlineT3st"))
        assertEquals("Pw4OnlineT3st", store.read("s-abc12345", "Tester"))
        assertEquals("names compare in lower case", "Pw4OnlineT3st", store.read("s-abc12345", "TESTER"))
        assertNull("another server", store.read("s-other", "Tester"))
        assertTrue(store.save("s-abc12345", "tester", "second"))
        assertEquals("second", store.read("s-abc12345", "Tester"))
        assertEquals(mapOf("s-abc12345" to listOf("tester")), store.saved())
        assertTrue(store.remove("s-abc12345", "TeStEr"))
        assertNull(store.read("s-abc12345", "Tester"))
        assertEquals(emptyMap<String, List<String>>(), store.saved())
        assertTrue("forgetting nothing is fine", store.remove("s-abc12345", "nobody"))
    }

    @Test
    fun theListingAndAServersPasswordsAtOnce() {
        store.save("s-stub", "Tester", "a")
        store.save("s-stub", "Zed Two", "b")
        store.save("s-down", "Other", "c")
        assertEquals(mapOf("s-down" to listOf("other"), "s-stub" to listOf("tester", "zed two")), store.saved())
        assertEquals(2, store.removeAll("s-stub"))
        assertEquals(mapOf("s-down" to listOf("other")), store.saved())
        assertFalse(File(dir, "s-stub").exists())
        assertEquals(0, store.removeAll("s-stub"))
    }

    @Test
    fun theGamesLimits() {
        assertFalse("a 13-character name", store.save("s-1", "Thirteen_char", "x"))
        assertFalse("a 21-character password", store.save("s-1", "Tester", "x".repeat(21)))
        assertFalse("an empty password", store.save("s-1", "Tester", ""))
        assertFalse("no name", store.save("s-1", "", "x"))
        assertFalse("not a server id", store.save("../x", "Tester", "x"))
        assertTrue(store.save("s-1", "x".repeat(12), "y".repeat(20)))
        assertEquals(mapOf("s-1" to listOf("x".repeat(12))), store.saved())
    }

    @Test
    fun nothingReadableOnDisk() {
        store.save("s-1", "Tester", "Pw4OnlineT3st")
        val files = dir.walkTopDown().filter { it.isFile }.toList()
        assertEquals(1, files.size)
        val bytes = files[0].readBytes()
        assertFalse(String(bytes, Charsets.ISO_8859_1).contains("Pw4OnlineT3st"))
        assertEquals("LCP1", String(bytes, 0, 4, Charsets.US_ASCII))
        assertFalse("no temporary files left", dir.walkTopDown().any { it.name.endsWith(".tmp") })
    }

    @Test
    fun aFileMovedToAnotherAccountOrDamagedIsNoPassword() {
        store.save("s-1", "Alice", "secret")
        store.save("s-1", "Bob", "other")
        val folder = File(dir, "s-1")
        val alice = File(folder, "alice".toByteArray().joinToString("") { "%02x".format(it) } + ".bin")
        val bob = File(folder, "bob".toByteArray().joinToString("") { "%02x".format(it) } + ".bin")
        // Alice's file under Bob's name: the AAD names the account, so it does not open (and is removed)
        alice.copyTo(bob, overwrite = true)
        assertNull(store.read("s-1", "Bob"))
        assertFalse(bob.exists())
        assertEquals("secret", store.read("s-1", "Alice"))
        alice.writeBytes(byteArrayOf(1, 2, 3))
        assertNull(store.read("s-1", "Alice"))
        assertFalse(alice.exists())
    }

    @Test
    fun aLostKeyIsNoPassword() {
        store.save("s-1", "Tester", "secret")
        key = null
        assertNull(store.read("s-1", "Tester"))
        assertEquals(emptyMap<String, List<String>>(), store.saved())
    }
}
