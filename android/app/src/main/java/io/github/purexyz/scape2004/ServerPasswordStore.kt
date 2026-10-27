// ServerPasswordStore: passwords the player asked a server's login to remember (the Remember box; ports
// ios/LostCity/ServerPasswordStore.swift, which keeps them in the Keychain; docs/ARCHITECTURE.md §7.4,
// docs/ANDROID.md §7), wrapped as the Claude key is (llm/AndroidModelKeyStore.kt):
//
// - One AES-256-GCM key in the AndroidKeyStore, alias io.github.purexyz.scape2004.server-passwords: it never leaves the
//   secure hardware or the device, needs no user authentication, and is usable after the first unlock (the analogue of
//   AfterFirstUnlockThisDeviceOnly).
// - One file per account, noBackupFilesDir/server-passwords/<server id>/<hex of the lower-case UTF-8 name>.bin: "LCP1", one
//   byte of IV length, the IV, then the ciphertext and its tag; the AAD is `<server id>/<lower-case name>`, so a file
//   moved to another name cannot be opened. noBackupFilesDir is outside Auto Backup and device transfer (ThisDeviceOnly).
//   Which names have a password is the folder listing (no decryption), as iOS lists Keychain attributes.
// - A file that cannot be opened (a wrong tag, a damaged file, the Keystore key gone) is no password and is removed; any
//   other failure only skips that read.
// - Passwords never reach a log (only the exception's class), the settings, the page's storage or a backup; the page gets
//   one only for the login it asks for (`accounts.login`).
//
// Thread-safe (one lock); called on the UI thread for one small file at a time.
package io.github.purexyz.scape2004

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import java.util.Locale
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class ServerPasswordStore(
    /** noBackupFilesDir/server-passwords in the app; a temp folder in the tests. */
    private val root: File,
    /** The Keystore key (null when there is none and `create` is false); the JVM tests give a plain AES key. */
    private val keys: (create: Boolean) -> SecretKey? = { create -> keystoreKey(create) },
) {
    private val lock = Any()

    private fun file(server: String, name: String): File =
        File(File(root, server), name.lowercase(Locale.ROOT).toByteArray(Charsets.UTF_8).joinToString("") { "%02x".format(it) } + SUFFIX)

    private fun aad(server: String, name: String) = "$server/${name.lowercase(Locale.ROOT)}".toByteArray(Charsets.UTF_8)

    fun read(server: String, name: String): String? = synchronized(lock) {
        if (!OnlineServer.isValidId(server) || !isValid(name)) return null
        val file = file(server, name)
        if (!file.isFile) return null
        fun lost(why: String): String? {
            Log.info("accounts", "a stored password of $server could not be read ($why): removed")
            file.delete()
            return null
        }
        return try {
            val bytes = file.readBytes()
            require(bytes.size > MAGIC.size + 1 && bytes.copyOfRange(0, MAGIC.size).contentEquals(MAGIC)) { "not a password file" }
            val ivLength = bytes[MAGIC.size].toInt() and 0xff
            val start = MAGIC.size + 1
            require(ivLength in 12..16 && bytes.size > start + ivLength) { "bad IV" }
            val secret = keys(false) ?: return lost("no Keystore key")
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(128, bytes.copyOfRange(start, start + ivLength)))
            cipher.updateAAD(aad(server, name))
            String(cipher.doFinal(bytes, start + ivLength, bytes.size - start - ivLength), Charsets.UTF_8).takeIf { it.isNotEmpty() }
        } catch (error: AEADBadTagException) {
            lost(error.javaClass.simpleName)
        } catch (error: IllegalArgumentException) {
            lost(error.javaClass.simpleName)
        } catch (error: Exception) {
            Log.info("accounts", "a stored password of $server could not be read now (${error.javaClass.simpleName})")
            null
        }
    }

    /** Saves (or replaces) a password. False if the Keystore or the file system refused it. */
    fun save(server: String, name: String, password: String): Boolean = synchronized(lock) {
        if (!OnlineServer.isValidId(server) || !isValid(name, password)) return false
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, keys(true))
            cipher.updateAAD(aad(server, name))
            val sealed = cipher.doFinal(password.toByteArray(Charsets.UTF_8))
            val iv = cipher.iv
            OnlineProxy.writeAtomically(file(server, name), MAGIC + byteArrayOf(iv.size.toByte()) + iv + sealed)
            true
        } catch (error: Exception) {
            Log.info("accounts", "the Keystore refused a password for $server (${error.javaClass.simpleName})")
            false
        }
    }

    fun remove(server: String, name: String): Boolean = synchronized(lock) {
        if (!OnlineServer.isValidId(server)) return false
        val file = file(server, name)
        file.delete()
        file.parentFile?.takeIf { it.list()?.isEmpty() == true }?.delete()
        !file.exists()
    }

    /** Removes every password of a server; returns how many there were. */
    fun removeAll(server: String): Int = synchronized(lock) {
        if (!OnlineServer.isValidId(server)) return 0
        val folder = File(root, server)
        val count = folder.listFiles { file -> file.name.endsWith(SUFFIX) }?.size ?: 0
        folder.deleteRecursively()
        count
    }

    /** The names with a stored password, per server id (lower-case, sorted). */
    fun saved(): Map<String, List<String>> = synchronized(lock) {
        val result = sortedMapOf<String, List<String>>()
        for (folder in root.listFiles().orEmpty()) {
            if (!folder.isDirectory || !OnlineServer.isValidId(folder.name)) continue
            val names = folder.listFiles().orEmpty().mapNotNull { nameOf(it.name) }.sorted()
            if (names.isNotEmpty()) result[folder.name] = names
        }
        result
    }

    private fun nameOf(fileName: String): String? {
        val hex = fileName.removeSuffix(SUFFIX).takeIf { fileName.endsWith(SUFFIX) && it.length % 2 == 0 && it.isNotEmpty() } ?: return null
        return try {
            String(ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }, Charsets.UTF_8)
        } catch (_: NumberFormatException) {
            null
        }
    }

    companion object {
        const val ALIAS = "io.github.purexyz.scape2004.server-passwords"
        const val FOLDER = "server-passwords"
        private const val SUFFIX = ".bin"
        private val MAGIC = "LCP1".toByteArray(Charsets.US_ASCII)
        private const val TRANSFORMATION = "AES/GCM/NoPadding"

        /** A login the game would send: a name of 1-12 characters and a password of 1-20 (Engine-TS refuses others). */
        fun isValid(name: String, password: String? = null): Boolean =
            name.length in 1..12 && (password == null || password.length in 1..20)

        /** The AndroidKeyStore's AES key for the passwords (made when `create` and there is none yet). */
        fun keystoreKey(create: Boolean): SecretKey? {
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
            if (!create) return null
            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            generator.init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setRandomizedEncryptionRequired(true)
                    .setUserAuthenticationRequired(false)
                    .build(),
            )
            return generator.generateKey()
        }
    }
}
