// SavesDocumentsProvider: the saves in the system Files app, as "2004Scape" (the iOS app's UIFileSharingEnabled +
// LSSupportsOpeningDocumentsInPlace: Files › On My iPhone › 2004Scape; docs/ANDROID.md §1 Saves on disk, §4 "Shell: the
// Files app"). It ports no Swift file: on iOS the Files app reads Documents itself.
//
// * One root, "2004Scape" ("Characters and the bots' world"), for filesDir/Documents: players/<profile>/<name>.sav and
//   bots/<profile>/bots.sav, the game's own folders. Document ids are "root" and "root/<path>", the path checked with
//   SaveStore's rules (no hidden, empty, `.` or `..` components, no backslash or NUL, 255 bytes a name, 1024 in all).
// * Hidden files (the store's temp files: `.<name>.<uuid>.tmp`) are never listed or opened, as /save-index leaves them
//   out; `.bak` files are listed, so a deleted save can be brought back by renaming `zezima.sav.bak` to `zezima.sav`
//   (the README's promise), which works once `zezima.sav` is gone: a rename never replaces a file.
// * Writes from the Files app go through SaveStore: the bytes land in a hidden temp file beside the save and, when the
//   writer closes it, SaveStore.write installs them atomically with the previous version kept as `.bak`, under the save's
//   lock, skipping unchanged bytes. A copy made in Files can never leave a torn save, and the game's own write of the
//   same save never interleaves with it (the game's next save of a character in the world wins, as on iOS).
// * Delete is the DELETE route's, a save becoming `<name>.bak`, except when a `.bak` is already there: then the save is
//   removed outright and the `.bak` kept, as the iOS Files app deletes (the README's restore is "delete zezima.sav, rename
//   zezima.sav.bak", which must not overwrite that .bak). Deleting a `.bak` removes it; a folder goes with everything in
//   it. Renames, copies and moves stay inside the folder, under the locks.
// * Change notifications: SaveStore.onChange (the game's writes) and this provider's own operations notify the folder
//   and every folder above it, at most once per folder every 2 s (bots.sav is rewritten up to every 30 s, and a busy
//   world must not keep the Files app re-querying), the last change always delivered.
// * The system starts this provider with the app's process, before LostCityApp.onCreate and with or without the game:
//   onCreate only hooks the store; nothing here touches the WebView.
package io.github.purexyz.scape2004

import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.CancellationSignal
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import android.webkit.MimeTypeMap
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.nio.file.Files

/** The provider's naming rules (pure) and its delete of a file (SavesDocumentsTest). */
object SaveDocuments {
    const val AUTHORITY = "io.github.purexyz.scape2004.documents"
    const val ROOT_ID = "saves"
    const val ROOT_DOCUMENT = "root"

    /** The most the Files app may write into one file: the router's limit for the game's own writes. */
    const val MAX_WRITE_BYTES = 32L * 1024 * 1024

    /** The document id of a path relative to Documents ("" is the root). */
    fun documentId(relative: String): String = if (relative.isEmpty()) ROOT_DOCUMENT else "$ROOT_DOCUMENT/$relative"

    /** The relative path a document id names ("" for the root), or null when it is not one of ours or breaks a rule. */
    fun relative(documentId: String): String? {
        if (documentId == ROOT_DOCUMENT) return ""
        if (!documentId.startsWith("$ROOT_DOCUMENT/")) return null
        val path = documentId.substring(ROOT_DOCUMENT.length + 1)
        return if (SaveStore.components(path) != null) path else null
    }

    /** A file or folder name the Files app may create or rename to: one path component by SaveStore's rules. */
    fun validName(name: String): Boolean = !name.contains('/') && SaveStore.components(name)?.size == 1

    /** Hidden: the store's temp files (and anything else starting with a dot), never shown. */
    fun hidden(name: String): Boolean = name.startsWith(".")

    /** `child` is `parent` or inside it. */
    fun isChild(parent: String, child: String): Boolean {
        val p = relative(parent) ?: return false
        val c = relative(child) ?: return false
        return p.isEmpty() || c == p || c.startsWith("$p/")
    }

    /** The folder above a relative path ("" for a top-level one). */
    fun parentOf(relative: String): String = relative.substringBeforeLast('/', "")

    /** The folder and every folder above it, innermost first, the root ("") last. */
    fun folderAndAbove(folder: String): List<String> {
        val folders = ArrayList<String>()
        var f = folder
        while (f.isNotEmpty()) {
            folders += f
            f = parentOf(f)
        }
        folders += ""
        return folders
    }

    /**
     * The Files app's delete of the file at `relative`: a `.bak` is removed; a save becomes `<name>.bak` (the DELETE route)
     * unless a `.bak` is beside it already, which is kept as it is while the save is removed outright (as the iOS Files app
     * deletes). True when the save was kept as its `.bak`. Throws SaveStore.Failure (NotFound when there is no such file).
     */
    fun delete(store: SaveStore, relative: String): Boolean {
        if (SaveStore.components(relative) == null) throw SaveStore.Failure.InvalidPath
        if (!relative.endsWith(SaveStore.BACKUP_SUFFIX)) {
            val file = File(store.root, relative)
            val removed = store.withLock(relative) {
                if (!file.isFile || !File(file.path + SaveStore.BACKUP_SUFFIX).exists()) return@withLock false
                try {
                    Files.delete(file.toPath())
                } catch (error: IOException) {
                    throw SaveStore.Failure.Io("unlink failed: ${error.message}")
                }
                true
            }
            if (removed) {
                store.notifyChanged(relative)
                return false
            }
        }
        store.delete(relative)
        return !relative.endsWith(SaveStore.BACKUP_SUFFIX)
    }

    /** `name`, or "name (1).ext", "name (2).ext", … (the extension of a file kept last), the first that is free. */
    fun uniqueName(name: String, isDirectory: Boolean, exists: (String) -> Boolean): String {
        if (!exists(name)) return name
        val dot = if (isDirectory) -1 else name.lastIndexOf('.')
        val base = if (dot > 0) name.substring(0, dot) else name
        val extension = if (dot > 0) name.substring(dot) else ""
        for (n in 1..999) {
            val candidate = "$base ($n)$extension"
            if (!exists(candidate)) return candidate
        }
        throw IllegalStateException("no free name for $name")
    }
}

/**
 * Coalesces change notifications: a folder is notified at once, then at most once every `intervalMs`; changes in between
 * become one notification at the end of the interval. Thread-safe (the game's writes arrive on Chromium's threads, the
 * Files app's on binder threads); `notify` runs on the scheduler's thread or the caller's.
 */
class ChangeThrottle(private val scheduler: Scheduler, private val intervalMs: Long = 2_000, private val notify: (folder: String) -> Unit) {
    private val last = HashMap<String, Long>()
    private val pending = HashSet<String>()

    /** Something in `folder` changed: it and every folder above it are notified. */
    fun changed(folder: String) {
        for (f in SaveDocuments.folderAndAbove(folder)) schedule(f)
    }

    private fun schedule(folder: String) {
        val now = scheduler.now()
        val wait = synchronized(this) {
            if (folder in pending) return
            val since = last[folder]?.let { now - it } ?: Long.MAX_VALUE
            if (since >= intervalMs) {
                last[folder] = now
                0L
            } else {
                pending += folder
                intervalMs - since
            }
        }
        if (wait == 0L) {
            notify(folder)
            return
        }
        scheduler.postDelayed(wait) {
            synchronized(this) {
                pending -= folder
                last[folder] = scheduler.now()
            }
            notify(folder)
        }
    }
}

class SavesDocumentsProvider : DocumentsProvider() {
    private val store: SaveStore by lazy { (requireContext().applicationContext as LostCityApp).saveStore }
    private lateinit var throttle: ChangeThrottle

    /** Where writers' temp files are installed when they close them (off the binder threads). */
    private val closer: Handler by lazy { Handler(HandlerThread("lostcity-documents").apply { start() }.looper) }

    override fun onCreate(): Boolean {
        val context = context ?: return false
        throttle = ChangeThrottle(MainScheduler) { folder ->
            val uri = DocumentsContract.buildChildDocumentsUri(SaveDocuments.AUTHORITY, SaveDocuments.documentId(folder))
            Log.debug("files") { "changed: $uri" }
            context.contentResolver.notifyChange(uri, null)
        }
        // (the store is cheap to make: no log, no file walk; LostCityApp's sweep runs later, from its own onCreate)
        store.onChange = { folder -> throttle.changed(folder) }
        return true
    }

    // ------------------------------------------------------------------------------------------------ queries

    override fun queryRoots(projection: Array<out String>?): Cursor {
        val context = requireContext()
        return MatrixCursor(projection ?: ROOT_COLUMNS).apply {
            newRow().apply {
                add(Root.COLUMN_ROOT_ID, SaveDocuments.ROOT_ID)
                add(Root.COLUMN_DOCUMENT_ID, SaveDocuments.ROOT_DOCUMENT)
                add(Root.COLUMN_TITLE, context.getString(R.string.documents_root_title))
                add(Root.COLUMN_SUMMARY, context.getString(R.string.documents_root_summary))
                add(Root.COLUMN_ICON, R.mipmap.ic_launcher)
                add(Root.COLUMN_FLAGS, Root.FLAG_LOCAL_ONLY or Root.FLAG_SUPPORTS_CREATE or Root.FLAG_SUPPORTS_IS_CHILD)
                add(Root.COLUMN_AVAILABLE_BYTES, store.root.usableSpace)
            }
        }
    }

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor {
        val file = fileOf(documentId)
        if (!file.exists()) throw FileNotFoundException("no document $documentId")
        return MatrixCursor(projection ?: DOCUMENT_COLUMNS).apply { addRow(this, documentId, file) }
    }

    override fun queryChildDocuments(parentDocumentId: String, projection: Array<out String>?, sortOrder: String?): Cursor {
        val folder = fileOf(parentDocumentId)
        if (!folder.isDirectory) throw FileNotFoundException("not a folder: $parentDocumentId")
        val parent = SaveDocuments.relative(parentDocumentId)!!
        val cursor = MatrixCursor(projection ?: DOCUMENT_COLUMNS)
        for (child in folder.listFiles().orEmpty().sortedBy { it.name }) {
            if (SaveDocuments.hidden(child.name) || !(child.isFile || child.isDirectory)) continue
            addRow(cursor, SaveDocuments.documentId(if (parent.isEmpty()) child.name else "$parent/${child.name}"), child)
        }
        cursor.setNotificationUri(requireContext().contentResolver, DocumentsContract.buildChildDocumentsUri(SaveDocuments.AUTHORITY, parentDocumentId))
        return cursor
    }

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean = SaveDocuments.isChild(parentDocumentId, documentId)

    override fun getDocumentType(documentId: String): String {
        val file = fileOf(documentId)
        if (!file.exists()) throw FileNotFoundException("no document $documentId")
        return mimeType(file)
    }

    // ------------------------------------------------------------------------------------------------ reading, writing

    override fun openDocument(documentId: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor {
        val relative = relativeOf(documentId)
        val file = fileOf(documentId)
        if (file.isDirectory || relative.isEmpty()) throw FileNotFoundException("not a file: $documentId")
        val flags = ParcelFileDescriptor.parseMode(mode)
        if (flags and (ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_READ_WRITE) == 0) {
            if (!file.isFile) throw FileNotFoundException("no document $documentId")
            return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        }
        // A write: into a hidden temp file beside the save, installed through SaveStore when the writer closes it.
        val folder = file.parentFile ?: throw FileNotFoundException("no folder for $documentId")
        if (!folder.isDirectory) throw FileNotFoundException("no folder for $documentId")
        val temp = File(folder, ".${file.name}.files-${System.nanoTime()}.tmp")
        val keep = flags and ParcelFileDescriptor.MODE_TRUNCATE == 0 &&
            (flags and ParcelFileDescriptor.MODE_APPEND != 0 || flags and ParcelFileDescriptor.MODE_READ_WRITE != 0)
        try {
            if (keep && file.isFile) store.withLock(relative) { file.copyTo(temp, overwrite = true) }
            return ParcelFileDescriptor.open(temp, flags or ParcelFileDescriptor.MODE_CREATE, closer) { error -> installWrite(relative, temp, error) }
        } catch (error: IOException) {
            temp.delete()
            throw FileNotFoundException("cannot write $documentId: ${error.message}")
        }
    }

    /** A writer closed its file: its bytes become the save (SaveStore.write: atomic, `.bak` kept, unchanged skipped). */
    private fun installWrite(relative: String, temp: File, error: IOException?) {
        try {
            if (error != null) {
                Log.info("files", "write of $relative from the Files app failed: ${error.message}")
                return
            }
            val size = temp.length()
            when {
                size > SaveDocuments.MAX_WRITE_BYTES -> Log.info("files", "write of $relative from the Files app refused: $size B is more than 32 MB")
                size == 0L -> Log.info("files", "write of $relative from the Files app was empty: the file is kept as it was")
                else -> {
                    val changed = store.write(relative, temp.readBytes())
                    Log.info("files", "wrote $relative from the Files app ($size B${if (changed) "" else ", unchanged"})")
                }
            }
        } catch (failure: SaveStore.Failure) {
            Log.info("files", "write of $relative from the Files app failed: ${failure.message}")
        } catch (failure: IOException) {
            Log.info("files", "write of $relative from the Files app failed: ${failure.message}")
        } finally {
            temp.delete()
        }
    }

    // ------------------------------------------------------------------------------------------------ changes

    override fun createDocument(parentDocumentId: String, mimeType: String, displayName: String): String {
        val parent = relativeOf(parentDocumentId)
        val folder = fileOf(parentDocumentId)
        if (!folder.isDirectory) throw FileNotFoundException("not a folder: $parentDocumentId")
        val directory = mimeType == Document.MIME_TYPE_DIR
        val wanted = displayName.trim()
        require(SaveDocuments.validName(wanted)) { "2004Scape cannot keep a file named \"$displayName\"" }
        val name = SaveDocuments.uniqueName(wanted, directory) { File(folder, it).exists() }
        val relative = if (parent.isEmpty()) name else "$parent/$name"
        val file = File(folder, name)
        store.withLock(relative) {
            // (a file starts as an empty placeholder written directly: SaveStore.write refuses an empty body; the bytes
            // the Files app writes next go through it)
            val made = if (directory) file.mkdir() else file.createNewFile()
            if (!made) throw IllegalStateException("could not create $name")
        }
        Log.info("files", "created ${if (directory) "folder" else "file"} $relative in the Files app")
        store.notifyChanged(relative)
        return SaveDocuments.documentId(relative)
    }

    override fun deleteDocument(documentId: String) {
        val relative = relativeOf(documentId)
        require(relative.isNotEmpty()) { "the 2004Scape folder itself cannot be deleted" }
        val file = fileOf(documentId)
        when {
            file.isDirectory -> {
                if (!file.deleteRecursively()) throw IllegalStateException("could not delete all of $relative")
                Log.info("files", "deleted folder $relative in the Files app")
                store.notifyChanged(relative)
            }
            file.isFile -> try {
                // a save becomes <name>.bak unless one is there already (kept, the save removed); a .bak is removed
                val kept = SaveDocuments.delete(store, relative)
                Log.info("files", "deleted $relative in the Files app${if (kept) " (kept as ${file.name}${SaveStore.BACKUP_SUFFIX})" else ""}")
            } catch (failure: SaveStore.Failure) {
                throw IllegalStateException("could not delete $relative: ${failure.message}")
            }
            else -> throw FileNotFoundException("no document $documentId")
        }
        revokeDocumentPermission(documentId)
    }

    override fun removeDocument(documentId: String, parentDocumentId: String) = deleteDocument(documentId)

    override fun renameDocument(documentId: String, displayName: String): String {
        val relative = relativeOf(documentId)
        require(relative.isNotEmpty()) { "the 2004Scape folder itself cannot be renamed" }
        val name = displayName.trim()
        require(SaveDocuments.validName(name)) { "2004Scape cannot keep a file named \"$displayName\"" }
        val file = fileOf(documentId)
        if (!file.exists()) throw FileNotFoundException("no document $documentId")
        val target = File(file.parentFile, name)
        val parent = SaveDocuments.parentOf(relative)
        val renamed = if (parent.isEmpty()) name else "$parent/$name"
        if (renamed == relative) return documentId
        move(relative, file, renamed, target)
        Log.info("files", "renamed $relative to $name in the Files app")
        revokeDocumentPermission(documentId)
        return SaveDocuments.documentId(renamed)
    }

    override fun moveDocument(sourceDocumentId: String, sourceParentDocumentId: String, targetParentDocumentId: String): String {
        val relative = relativeOf(sourceDocumentId)
        require(relative.isNotEmpty()) { "the 2004Scape folder itself cannot be moved" }
        val file = fileOf(sourceDocumentId)
        if (!file.exists()) throw FileNotFoundException("no document $sourceDocumentId")
        val targetParent = relativeOf(targetParentDocumentId)
        require(!(file.isDirectory && (targetParent == relative || targetParent.startsWith("$relative/")))) { "a folder cannot be moved into itself" }
        val folder = fileOf(targetParentDocumentId)
        if (!folder.isDirectory) throw FileNotFoundException("not a folder: $targetParentDocumentId")
        val name = SaveDocuments.uniqueName(file.name, file.isDirectory) { File(folder, it).exists() }
        val moved = if (targetParent.isEmpty()) name else "$targetParent/$name"
        move(relative, file, moved, File(folder, name))
        Log.info("files", "moved $relative to $moved in the Files app")
        revokeDocumentPermission(sourceDocumentId)
        return SaveDocuments.documentId(moved)
    }

    override fun copyDocument(sourceDocumentId: String, targetParentDocumentId: String): String {
        val relative = relativeOf(sourceDocumentId)
        val file = fileOf(sourceDocumentId)
        if (!file.exists() || relative.isEmpty()) throw FileNotFoundException("no document $sourceDocumentId")
        val targetParent = relativeOf(targetParentDocumentId)
        val folder = fileOf(targetParentDocumentId)
        if (!folder.isDirectory) throw FileNotFoundException("not a folder: $targetParentDocumentId")
        require(!(file.isDirectory && (targetParent == relative || targetParent.startsWith("$relative/")))) { "a folder cannot be copied into itself" }
        val name = SaveDocuments.uniqueName(file.name, file.isDirectory) { File(folder, it).exists() }
        val copy = if (targetParent.isEmpty()) name else "$targetParent/$name"
        copyInto(file, relative, copy)
        Log.info("files", "copied $relative to $copy in the Files app")
        store.notifyChanged(copy)
        return SaveDocuments.documentId(copy)
    }

    // ------------------------------------------------------------------------------------------------ helpers

    /** A rename that never replaces anything, under both saves' locks (files) or none (folders, whose files are many). */
    private fun move(from: String, source: File, to: String, target: File) {
        val rename = {
            if (target.exists()) throw IllegalStateException("${target.name} already exists")
            if (!source.renameTo(target)) throw IllegalStateException("could not rename ${source.name} to ${target.name}")
        }
        // (two locks always taken in the same order, so two moves in opposite directions cannot wait on each other)
        val (first, second) = listOf(from, to).sortedBy { it.removeSuffix(SaveStore.BACKUP_SUFFIX) }
        if (source.isFile) store.withLock(first) { store.withLock(second) { rename() } } else rename()
        store.notifyChanged(from)
        store.notifyChanged(to)
    }

    /** Copies a file through SaveStore (atomic), or a folder file by file. */
    private fun copyInto(source: File, from: String, relative: String) {
        if (source.isDirectory) {
            val folder = File(store.root, relative)
            if (!folder.mkdirs() && !folder.isDirectory) throw IllegalStateException("could not create $relative")
            for (child in source.listFiles().orEmpty()) {
                if (!SaveDocuments.hidden(child.name)) copyInto(child, "$from/${child.name}", "$relative/${child.name}")
            }
            return
        }
        val bytes = store.withLock(from) { source.readBytes() }
        if (bytes.isEmpty()) {
            File(store.root, relative).apply { parentFile?.mkdirs() }.createNewFile()
            return
        }
        try {
            store.write(relative, bytes)
        } catch (failure: SaveStore.Failure) {
            throw IllegalStateException("could not copy to $relative: ${failure.message}")
        }
    }

    private fun relativeOf(documentId: String): String = SaveDocuments.relative(documentId) ?: throw FileNotFoundException("no document $documentId")

    /** The file a document id names, checked to be inside Documents (no link leads out). */
    private fun fileOf(documentId: String): File {
        val relative = relativeOf(documentId)
        val file = if (relative.isEmpty()) store.root else File(store.root, relative)
        val root = store.root.canonicalPath
        val canonical = try {
            file.canonicalPath
        } catch (_: IOException) {
            throw FileNotFoundException("no document $documentId")
        }
        if (canonical != root && !canonical.startsWith("$root/")) throw FileNotFoundException("no document $documentId")
        return file
    }

    private fun addRow(cursor: MatrixCursor, documentId: String, file: File) {
        val isRoot = documentId == SaveDocuments.ROOT_DOCUMENT
        val flags = when {
            file.isDirectory && isRoot -> Document.FLAG_DIR_SUPPORTS_CREATE
            file.isDirectory -> Document.FLAG_DIR_SUPPORTS_CREATE or Document.FLAG_SUPPORTS_DELETE or Document.FLAG_SUPPORTS_RENAME or
                Document.FLAG_SUPPORTS_COPY or Document.FLAG_SUPPORTS_MOVE or Document.FLAG_SUPPORTS_REMOVE
            else -> Document.FLAG_SUPPORTS_WRITE or Document.FLAG_SUPPORTS_DELETE or Document.FLAG_SUPPORTS_RENAME or
                Document.FLAG_SUPPORTS_COPY or Document.FLAG_SUPPORTS_MOVE or Document.FLAG_SUPPORTS_REMOVE
        }
        cursor.newRow().apply {
            add(Document.COLUMN_DOCUMENT_ID, documentId)
            add(Document.COLUMN_DISPLAY_NAME, if (isRoot) requireContext().getString(R.string.documents_root_title) else file.name)
            add(Document.COLUMN_MIME_TYPE, mimeType(file))
            add(Document.COLUMN_SIZE, if (file.isFile) file.length() else null)
            add(Document.COLUMN_LAST_MODIFIED, file.lastModified())
            add(Document.COLUMN_FLAGS, flags)
        }
    }

    /** Folders, else by extension; saves (`.sav`, `.bak`) are plain bytes. */
    private fun mimeType(file: File): String {
        if (file.isDirectory) return Document.MIME_TYPE_DIR
        val extension = file.name.substringAfterLast('.', "").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "application/octet-stream"
    }

    companion object {
        private val ROOT_COLUMNS = arrayOf(
            Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE, Root.COLUMN_SUMMARY, Root.COLUMN_ICON,
            Root.COLUMN_FLAGS, Root.COLUMN_AVAILABLE_BYTES,
        )
        private val DOCUMENT_COLUMNS = arrayOf(
            Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE,
            Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS,
        )
    }
}

/**
 * DEBUG `{type:'debug', action:'documents', op, …}`: this app's own calls through DocumentsContract to the provider (the
 * Files app's calls, which adb's `content` command cannot make: they pass a Uri), for android/test/shell.mjs. `path` and
 * `parent`/`to` are paths relative to Documents ("" is the root). Ops: list, create {parent, name, dir}, write {path,
 * text}, read {path}, rename {path, name}, delete {path}, copy {path, to}, move {path, to}. Replies {ok, value|error}.
 */
object SavesDocumentsDebug {
    fun run(context: Context, message: JsonObject): JsonElement {
        val resolver = context.contentResolver
        fun uri(relative: String) = DocumentsContract.buildDocumentUri(SaveDocuments.AUTHORITY, SaveDocuments.documentId(relative))
        fun relativeOf(uri: Uri?) = uri?.let { SaveDocuments.relative(DocumentsContract.getDocumentId(it)) }
        val path = message.string("path") ?: ""
        return try {
            val value: JsonElement = when (message.string("op")) {
                "list" -> {
                    val children = DocumentsContract.buildChildDocumentsUri(SaveDocuments.AUTHORITY, SaveDocuments.documentId(path))
                    val rows = ArrayList<JsonElement>()
                    resolver.query(children, null, null, null, null)?.use { cursor ->
                        while (cursor.moveToNext()) {
                            rows += buildJsonObject {
                                put("name", JsonPrimitive(cursor.getString(cursor.getColumnIndexOrThrow(Document.COLUMN_DISPLAY_NAME))))
                                put("mime", JsonPrimitive(cursor.getString(cursor.getColumnIndexOrThrow(Document.COLUMN_MIME_TYPE))))
                                val size = cursor.getColumnIndexOrThrow(Document.COLUMN_SIZE)
                                put("size", if (cursor.isNull(size)) JsonNull else JsonPrimitive(cursor.getLong(size)))
                                put("flags", JsonPrimitive(cursor.getInt(cursor.getColumnIndexOrThrow(Document.COLUMN_FLAGS))))
                            }
                        }
                    }
                    JsonArray(rows)
                }
                "create" -> JsonPrimitive(relativeOf(DocumentsContract.createDocument(resolver, uri(message.string("parent") ?: ""),
                    if (message.bool("dir") == true) Document.MIME_TYPE_DIR else "application/octet-stream", message.string("name") ?: "")))
                "write" -> {
                    resolver.openOutputStream(uri(path), "wt")!!.use { it.write((message.string("text") ?: "").toByteArray()) }
                    JsonPrimitive(true)
                }
                "read" -> JsonPrimitive(resolver.openInputStream(uri(path))!!.use { String(it.readBytes()) })
                "rename" -> JsonPrimitive(relativeOf(DocumentsContract.renameDocument(resolver, uri(path), message.string("name") ?: "")))
                "delete" -> JsonPrimitive(DocumentsContract.deleteDocument(resolver, uri(path)))
                "copy" -> JsonPrimitive(relativeOf(DocumentsContract.copyDocument(resolver, uri(path), uri(message.string("to") ?: ""))))
                "move" -> JsonPrimitive(relativeOf(DocumentsContract.moveDocument(resolver, uri(path), uri(SaveDocuments.parentOf(path)), uri(message.string("to") ?: ""))))
                else -> throw IllegalArgumentException("unknown op ${message.string("op")}")
            }
            buildJsonObject {
                put("ok", JsonPrimitive(true))
                put("value", value)
            }
        } catch (error: Exception) {
            buildJsonObject {
                put("ok", JsonPrimitive(false))
                put("error", JsonPrimitive(error.toString()))
            }
        }
    }
}
