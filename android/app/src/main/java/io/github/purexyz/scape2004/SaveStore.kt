// SaveStore: the files the game writes, under filesDir/Documents (ports ios/LostCity/SaveStore.swift; ARCHITECTURE.md §3, §5;
// docs/ANDROID.md §1 Saves on disk). Player saves are
// `players/<profile>/<name>.sav`, the bots' world `bots/<profile>/bots.sav`, exactly the iOS layout.
//
// * Paths are relative to Documents and validated component by component: no absolute paths, no `.`/`..`, no empty
//   components (`a//b`), no hidden (dot) components, no backslashes or NULs, at most 1024 bytes in all and 255 per
//   component. Hidden names are reserved for this store's own temp files.
// * Writes are atomic. The bytes go to a hidden temp file in the target folder, which is then exchanged with the target
//   in one step (renameat2 RENAME_EXCHANGE through JNI: the iOS renamex_np RENAME_SWAP), and the swapped-out previous
//   version is renamed to `<file>.bak`. The target therefore always holds a complete file, the old one or the new one,
//   even if the app is killed mid-write (the engine rejects a save whose CRC does not match, so a torn write would lose
//   the character). iOS falls back to a hard-linked `.bak`; Android refuses link() in app storage (EACCES), so without
//   the swap the current file is copied to the `.bak` first, then the new one renamed over it.
// * Player saves are fsynced before they are installed and their folder after (small and rare: logout, the 15-minute
//   autosave, a pause), so the 204 comes only once the new save would survive a power loss: the swap and the `.bak`'s
//   rename are folder entries, which the file's own fsync does not cover. iOS does neither; the bots' store (about 1 MB,
//   rewritten often with many bots) is not synced either, as on iOS.
// * Unchanged writes are skipped: saving the same bytes again (pause, then background, both save a paused world) would
//   otherwise replace the useful `.bak` with a copy of the current file. Likewise an empty previous file (the Files
//   app's placeholder: it creates a document, then writes it) is never kept as the `.bak`, so importing a file into a
//   deleted save's name leaves that save's `.bak` alone (iOS's Files app writes into Documents itself).
// * DELETE keeps a backup: the deleted file becomes `<file>.bak` (deleting a `.bak` removes it).
// * Locking is per save: a file and its `.bak` share one lock, so a write can never interleave with another write or a
//   delete of the same save, while a 1 MB bots.sav write does not hold up a player's save (iOS has one lock for all; its
//   saves never ran concurrently enough to matter). The index takes no lock: temp files are hidden, and every installed
//   file is complete.
// * Temp files older than a minute, left behind by a write the app was killed in, are removed at launch.
package io.github.purexyz.scape2004

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

class SaveStore(
    val root: File,
    private val ops: FileOps = FileOps.platform,
    /** fsync player saves before installing them, and their folder after. */
    private val syncPlayers: Boolean = true,
) {
    /** Why an operation was refused; the router maps each to the iOS status and text. */
    sealed class Failure(message: String) : Exception(message) {
        data object InvalidPath : Failure("invalid path")
        data object NotFound : Failure("not found")
        data object EmptyBody : Failure("empty body")
        class Io(message: String) : Failure(message)
    }

    /** One row of /save-index. `modified` is milliseconds since 1970 (JavaScript Date time). */
    data class Entry(val path: String, val size: Long, val modified: Long)

    data class Info(val size: Long, val modified: Long)

    /**
     * Called after a write, rename or delete changed something under the root, with the folder it happened in (relative
     * to the root, "" for the root itself), so the Files app's view can be told (the DocumentsProvider track hooks it).
     */
    @Volatile
    var onChange: ((folder: String) -> Unit)? = null

    private val locks = ConcurrentHashMap<String, ReentrantLock>()
    private val rootCanonical: String

    @Volatile
    private var swapWarned = false

    init {
        root.mkdirs()
        rootCanonical = root.canonicalPath
    }

    // ------------------------------------------------------------------------------------------------ operations

    fun read(relative: String): ByteArray {
        val file = resolve(relative)
        return locked(relative) {
            if (!file.isFile) throw Failure.NotFound
            try {
                file.readBytes()
            } catch (error: IOException) {
                throw Failure.Io("read failed: ${ops.describe(error)}")
            }
        }
    }

    fun info(relative: String): Info {
        val file = resolve(relative)
        return locked(relative) {
            if (!file.isFile) throw Failure.NotFound
            Info(file.length(), modifiedMillis(file))
        }
    }

    /** Writes `data` atomically, keeping the previous version as `.bak`. False when the bytes were already there. */
    fun write(relative: String, data: ByteArray): Boolean {
        val file = resolve(relative)
        // An empty body is never a valid save. It is also what arrives when a write's bytes were lost on the way (a Blob
        // body in WebKit; a missing X-LC-Body here), so refuse rather than truncate.
        if (data.isEmpty()) throw Failure.EmptyBody
        return locked(relative) {
            if (file.isDirectory) throw Failure.InvalidPath // never swap a whole folder out to ".bak"
            if (file.isFile && file.length() == data.size.toLong() && sameBytes(file, data)) return@locked false
            val folder = file.parentFile!!
            if (!folder.isDirectory && !folder.mkdirs() && !folder.isDirectory) {
                throw Failure.Io("mkdir failed: could not create ${folder.name}")
            }
            val temp = File(folder, ".${file.name}.${UUID.randomUUID()}.tmp")
            val sync = syncPlayers && relative.startsWith("players/")
            try {
                // (created exclusively, as iOS writes `.withoutOverwriting`)
                if (!temp.createNewFile()) throw IOException("${temp.name} already exists")
                FileOutputStream(temp).use { out ->
                    out.write(data)
                    if (sync) out.fd.sync()
                }
            } catch (error: Exception) {
                temp.delete()
                throw Failure.Io("write failed: ${ops.describe(error)}")
            }
            install(temp, file)
            if (sync) syncFolder(folder)
            true
        }.also { changed -> if (changed) changed(relative) }
    }

    /** Returns normally if the file existed (kept as `<file>.bak`), throws NotFound if not. */
    fun delete(relative: String) {
        val file = resolve(relative)
        locked(relative) {
            if (!file.isFile) throw Failure.NotFound
            if (file.name.endsWith(BACKUP_SUFFIX)) {
                try {
                    Files.delete(file.toPath())
                } catch (error: IOException) {
                    throw Failure.Io("unlink failed: ${ops.describe(error)}")
                }
            } else {
                try {
                    ops.rename(file, File(file.path + BACKUP_SUFFIX))
                } catch (error: Exception) {
                    throw Failure.Io("rename failed: ${ops.describe(error)}")
                }
            }
        }
        changed(relative)
    }

    /** Every regular file under the root (hidden files, temp files and hidden folders left out), sorted by path. */
    fun index(): List<Entry> {
        val entries = ArrayList<Entry>()
        fun walk(folder: File, prefix: String) {
            val children = folder.listFiles() ?: return
            for (child in children) {
                if (child.name.startsWith(".")) continue // (a hidden folder is skipped whole)
                val relative = prefix + child.name
                when {
                    child.isDirectory -> walk(child, "$relative/")
                    child.isFile -> {
                        val size = child.length()
                        val modified = try {
                            modifiedMillis(child)
                        } catch (_: IOException) {
                            continue // deleted while we looked
                        }
                        entries.add(Entry(relative, size, modified))
                    }
                }
            }
        }
        walk(root, "")
        entries.sortBy { it.path }
        return entries
    }

    /** Temp files left behind by a write the app was killed in (older than a minute); run off the UI thread at launch. */
    fun removeStaleTempFiles() {
        val cutoff = System.currentTimeMillis() - 60_000
        fun walk(folder: File, prefix: String) {
            for (child in folder.listFiles() ?: return) {
                val relative = prefix + child.name
                if (child.isDirectory) {
                    walk(child, "$relative/")
                } else if (child.name.startsWith(".") && child.name.endsWith(".tmp") && child.lastModified() < cutoff) {
                    if (child.delete()) Log.info("save", "removed stale temp file $relative")
                }
            }
        }
        walk(root, "")
    }

    /**
     * Runs `body` holding the lock of the save at `relative` (and of its `.bak`): the Files app's renames and copies
     * (SavesDocumentsProvider) never interleave with the game's writes of the same save.
     */
    fun <T> withLock(relative: String, body: () -> T): T = locked(relative, body)

    /** Reports a change made beside the store (a rename or a new folder from the Files app) to [onChange]. */
    fun notifyChanged(relative: String) = changed(relative)

    // ------------------------------------------------------------------------------------------------ paths

    private fun resolve(relative: String): File {
        val parts = components(relative) ?: throw Failure.InvalidPath
        val file = File(root, parts.joinToString("/"))
        // Belt and braces: the components above cannot climb out of the root.
        val canonical = try {
            file.canonicalPath
        } catch (_: IOException) {
            throw Failure.InvalidPath
        }
        if (!canonical.startsWith("$rootCanonical/")) throw Failure.InvalidPath
        return file
    }

    // ------------------------------------------------------------------------------------------------ helpers

    /** Moves `temp` to `file`, keeping the previous `file` (if any) as `file.bak`. */
    private fun install(temp: File, file: File) {
        val backup = File(file.path + BACKUP_SUFFIX)
        val swap = ops.exchange(temp, file)
        if (swap == 0) {
            // `file` is now the new data and `temp` the previous version: make that the backup (rename replaces any older
            // backup atomically). An empty previous version is no save but the Files app's placeholder (createDocument,
            // just before its bytes are written): it is dropped, never kept over a real backup (a deleted save's .bak).
            if (temp.length() == 0L) {
                temp.delete()
                return
            }
            try {
                ops.rename(temp, backup)
            } catch (error: Exception) {
                Log.info("save", "keeping backup of ${file.name} failed: ${ops.describe(error)}")
                temp.delete()
            }
            return
        }
        if (swap == FileOps.ENOENT && !file.isFile) {
            // first save of this file: nothing to back up
            try {
                ops.rename(temp, file)
            } catch (error: Exception) {
                temp.delete()
                throw Failure.Io("rename failed: ${ops.describe(error)}")
            }
            return
        }
        // No swap here (EINVAL: a file system without exchange; ENOSYS: no libfsx). Copy the current file to the backup
        // (through a hidden temp, so the .bak is also always complete), then atomically replace it: the target still
        // never disappears, at the cost of one extra copy of the old version.
        if (!swapWarned) {
            swapWarned = true
            Log.info("save", "atomic swap unavailable (${ops.strerror(swap)}): the backup is copied")
        }
        if (file.isFile && file.length() > 0) { // (an empty file is no save: see above)
            val backupTemp = File(file.parentFile, ".${file.name}.bak.${UUID.randomUUID()}.tmp")
            try {
                file.copyTo(backupTemp, overwrite = false)
                ops.rename(backupTemp, backup)
            } catch (error: Exception) {
                backupTemp.delete()
                Log.info("save", "keeping backup of ${file.name} failed: ${ops.describe(error)}")
            }
        }
        try {
            ops.rename(temp, file)
        } catch (error: Exception) {
            temp.delete()
            throw Failure.Io("rename failed: ${ops.describe(error)} (swap: ${ops.strerror(swap)})")
        }
    }

    /**
     * After a player save is installed: the folder's fsync, so the swap is on disk before the 204. A failure is logged
     * and the write still succeeds (the new save is in place and readable; iOS never syncs at all).
     */
    private fun syncFolder(folder: File) {
        try {
            ops.syncFolder(folder)
        } catch (error: Exception) {
            Log.info("save", "syncing the folder ${folder.name} failed: ${ops.describe(error)}")
        }
    }

    private fun sameBytes(file: File, data: ByteArray): Boolean = try {
        file.readBytes().contentEquals(data)
    } catch (_: IOException) {
        false
    }

    /** Milliseconds since 1970, rounded (as iOS rounds `timeIntervalSince1970 × 1000`). */
    private fun modifiedMillis(file: File): Long = (Files.getLastModifiedTime(file.toPath()).to(TimeUnit.MICROSECONDS) + 500) / 1000

    private fun changed(relative: String) {
        val listener = onChange ?: return
        try {
            listener(relative.substringBeforeLast('/', ""))
        } catch (error: Exception) {
            Log.info("save", "change listener failed: $error")
        }
    }

    /** A save and its `.bak` share one lock. */
    private inline fun <T> locked(relative: String, body: () -> T): T =
        locks.computeIfAbsent(relative.removeSuffix(BACKUP_SUFFIX)) { ReentrantLock() }.withLock(body)

    companion object {
        const val BACKUP_SUFFIX = ".bak"

        /** The validated components of a relative save path, or null if it must be refused. */
        fun components(relative: String): List<String>? {
            if (relative.isEmpty() || relative.toByteArray(Charsets.UTF_8).size > 1024 || relative.startsWith("/") ||
                relative.contains('\\') || relative.contains('\u0000')
            ) {
                return null
            }
            val parts = relative.split('/')
            for (part in parts) {
                if (part.isEmpty() || part.startsWith(".") || part.toByteArray(Charsets.UTF_8).size > 255) return null
            }
            return parts
        }
    }
}
