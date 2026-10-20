// The player's Claude API key for the bots' online chat (Settings › Bot chat › Claude online): where it is kept is the
// platform's (iOS: the Keychain, ios/LostCity/ModelKeyStore.swift; Android: a file in noBackupFilesDir encrypted with an
// AndroidKeyStore key, android/llm AndroidModelKeyStore.kt). It is typed into a native secure box and never reaches the game
// page, a log or the settings; the page only learns whether a key is set and its last four characters
// (docs/ARCHITECTURE.md §7.1).
package io.github.purexyz.scape2004.botchat

interface ModelKeyStore {
    /** The key, or null (none saved, or it cannot be read). */
    fun read(): String?

    /** Saves (or replaces) the key. False if the store refused it. */
    fun save(key: String): Boolean

    /** True if it was deleted or there was none. */
    fun remove(): Boolean

    companion object {
        /** A key as typed or pasted, cleaned up (spaces and line breaks around it), or null if it cannot be one. */
        fun normalized(typed: String): String? {
            val key = typed.swiftTrim()
            if (key.length !in 8..512) return null
            if (!key.all { it.code in 33..126 }) return null
            return key
        }

        /** "…abcd": the key's last four characters, as the page shows it. */
        fun hint(key: String?): String? = key?.let { "…" + it.takeLast(4) }
    }
}

/** A key store in memory (the unit tests and the Mac harness). */
class MemoryKeyStore(private var key: String? = null) : ModelKeyStore {
    override fun read(): String? = key?.takeIf { it.isNotEmpty() }

    override fun save(key: String): Boolean {
        this.key = key
        return true
    }

    override fun remove(): Boolean {
        key = null
        return true
    }
}
