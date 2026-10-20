// The player's Claude API key on Android (docs/ARCHITECTURE.md §7.1, docs/ANDROID.md §1 Bot chat):
// what the iOS app keeps in the Keychain (ios/LostCity/ModelKeyStore.swift: a generic password, service
// io.github.purexyz.scape2004.claude, account api-key, AfterFirstUnlockThisDeviceOnly).
//
// - An AES-256-GCM key in the AndroidKeyStore, alias io.github.purexyz.scape2004.claude.api-key: it never leaves the secure
//   hardware or the device, needs no user authentication, and is usable after the first unlock (setUnlockedDeviceRequired
//   is left off: the analogue of AfterFirstUnlock). Not StrongBox: 50-100 ms an operation, and not on every phone.
// - It wraps the key in noBackupFilesDir/claude-key.bin: "LCK1", one byte of IV length, the IV, then the ciphertext and its
//   tag; the AAD names the item. noBackupFilesDir is outside Auto Backup and device transfer (ThisDeviceOnly); a file that
//   ever arrives without its key cannot be decrypted, and counts as no key (it is removed). Only such a definite loss (a
//   wrong tag, a damaged file, the Keystore key gone) removes it: any other failure (the Keystore service restarting
//   after an update, a binder or TEE error, the file system) only skips this read, as a failed Keychain read on iOS
//   does, and the next status or request reads it again.
// - The key never reaches a log (only the exception's class), the page, the settings or a backup.
// - EncryptedSharedPreferences (androidx.security, deprecated since 1.1.0) is not used: Google's guidance is this, plain
//   storage with javax.crypto and an AndroidKeyStore key. One secret needs no Tink.
//
// The decrypted key is kept in memory after the first read, and only this class writes the file, so a read is the iOS
// read (the Keychain on every status and request) without a Keystore operation on the main thread each time.
package io.github.purexyz.scape2004.llm

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import io.github.purexyz.scape2004.botchat.LogSink
import io.github.purexyz.scape2004.botchat.ModelKeyStore
import java.io.File
import java.security.KeyStore
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class AndroidModelKeyStore(
    context: Context,
    private val log: LogSink,
    /** The Keystore key (null when there is none and `create` is false); KeyStoreDeviceTest makes it fail. */
    private val keys: (create: Boolean) -> SecretKey? = { create -> keystoreKey(create) },
) : ModelKeyStore {
    companion object {
        const val ALIAS = "io.github.purexyz.scape2004.claude.api-key"
        const val FILE_NAME = "claude-key.bin"
        private val MAGIC = "LCK1".toByteArray(Charsets.US_ASCII)
        private val AAD = "io.github.purexyz.scape2004.claude/api-key".toByteArray(Charsets.US_ASCII)
        private const val TRANSFORMATION = "AES/GCM/NoPadding"

        /** The AndroidKeyStore's AES key for the Claude key (made when `create` and there is none yet). */
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

    /** noBackupFilesDir/claude-key.bin */
    val file = File(context.noBackupFilesDir, FILE_NAME)
    private val atomic = AtomicFile(file)
    private val lock = Any()
    private var cached: String? = null
    private var cachedValid = false

    /** A failure that may pass (the Keystore service, the file system): the file is kept and read again next time. */
    private class Unavailable : Exception()

    override fun read(): String? = synchronized(lock) {
        if (cachedValid) return cached
        val key = try {
            decrypt()
        } catch (_: Unavailable) {
            return null // (not cached: the next status or request tries again)
        }
        cached = key?.takeIf { it.isNotEmpty() }
        cachedValid = true
        cached
    }

    override fun save(key: String): Boolean = synchronized(lock) {
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, keys(true))
            cipher.updateAAD(AAD)
            val sealed = cipher.doFinal(key.toByteArray(Charsets.UTF_8))
            val iv = cipher.iv
            val stream = atomic.startWrite()
            try {
                stream.write(MAGIC)
                stream.write(iv.size)
                stream.write(iv)
                stream.write(sealed)
                atomic.finishWrite(stream)
            } catch (error: Exception) {
                atomic.failWrite(stream)
                throw error
            }
            cached = key
            cachedValid = true
            true
        } catch (error: Exception) {
            log.info("lm", "the Keystore refused the Claude key (${error.javaClass.simpleName})")
            false
        }
    }

    override fun remove(): Boolean = synchronized(lock) {
        cached = null
        cachedValid = true
        atomic.delete()
        !file.exists()
    }

    /**
     * The stored key, or null: no file, or one this phone's Keystore key cannot open (a wrong tag, a damaged file, the
     * Keystore key gone: it is then removed). Throws Unavailable, leaving the file, for any other failure.
     */
    private fun decrypt(): String? {
        if (!file.exists()) return null
        fun lost(why: String): String? {
            log.info("lm", "the stored Claude key could not be read ($why): removed")
            atomic.delete()
            return null
        }
        return try {
            val bytes = atomic.readFully()
            require(bytes.size > MAGIC.size + 1 && bytes.copyOfRange(0, MAGIC.size).contentEquals(MAGIC)) { "not a key file" }
            val ivLength = bytes[MAGIC.size].toInt() and 0xff
            val start = MAGIC.size + 1
            require(ivLength in 12..16 && bytes.size > start + ivLength) { "bad IV" }
            val iv = bytes.copyOfRange(start, start + ivLength)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            val secret = keys(false) ?: return lost("no Keystore key")
            cipher.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(128, iv))
            cipher.updateAAD(AAD)
            String(cipher.doFinal(bytes, start + ivLength, bytes.size - start - ivLength), Charsets.UTF_8)
        } catch (error: AEADBadTagException) {
            lost(error.javaClass.simpleName)
        } catch (error: IllegalArgumentException) { // (the format checks above)
            lost(error.javaClass.simpleName)
        } catch (error: Exception) {
            log.info("lm", "the stored Claude key could not be read now (${error.javaClass.simpleName}): kept, read again later")
            throw Unavailable()
        }
    }
}
