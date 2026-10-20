// FileOps: the file-system primitives SaveStore installs a save with, behind an interface so
// SaveStore runs unchanged in JVM unit tests (a temp folder on the Mac, a pure-Kotlin swap) and on the phone (renameat2
// through JNI, android.system.Os).
//
// Error texts follow the iOS store, whose messages carry strerror's words ("rename failed: Permission denied",
// "write failed: No space left on device"): `describe` digs the errno out of Android's exceptions for that.
package io.github.purexyz.scape2004

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.FileSystemException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption

interface FileOps {
    /**
     * Swaps the two paths in one step (renameat2 RENAME_EXCHANGE, the iOS renamex_np RENAME_SWAP): 0, or the errno.
     * ENOENT when either is missing; EINVAL, ENOSYS or EOPNOTSUPP when the swap is not available here.
     */
    fun exchange(a: File, b: File): Int

    /** rename(2): atomically replaces `to`. Throws an IOException (or Android's ErrnoException) on failure. */
    fun rename(from: File, to: File)

    /**
     * fsync(2) on a folder: the renames made in it (a save swapped in, its `.bak`) reach the disk, not only the files'
     * bytes. Throws an IOException on failure.
     */
    fun syncFolder(folder: File)

    /** strerror's words for an exception from these calls or from a file write. */
    fun describe(error: Throwable): String

    /** strerror(errno). */
    fun strerror(errno: Int): String

    companion object {
        const val ENOENT = 2
        const val EINVAL = 22
        const val ENOSYS = 38
        const val EOPNOTSUPP = 95

        /** The phone's: Fsx (JNI) when its library loaded, android.system.Os otherwise. */
        val platform: FileOps by lazy { AndroidFileOps() }
    }
}

/**
 * Plain java.nio, which the JVM tests use: rename is java.nio's atomic move (rename(2) on Linux and macOS), and there is
 * no swap (ENOSYS), so SaveStore takes its copy-and-rename fallback unless a test supplies one.
 */
open class NioFileOps : FileOps {
    override fun exchange(a: File, b: File): Int = FileOps.ENOSYS

    override fun rename(from: File, to: File) {
        Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE)
    }

    override fun syncFolder(folder: File) {
        FileChannel.open(folder.toPath(), StandardOpenOption.READ).use { it.force(true) }
    }

    override fun describe(error: Throwable): String {
        var cause: Throwable? = error
        while (cause != null) {
            if (cause is FileSystemException) return cause.reason ?: cause.message ?: cause.toString()
            cause = cause.cause
        }
        return error.message ?: error.toString()
    }

    override fun strerror(errno: Int): String = when (errno) {
        FileOps.ENOENT -> "No such file or directory"
        FileOps.EINVAL -> "Invalid argument"
        FileOps.ENOSYS -> "Function not implemented"
        FileOps.EOPNOTSUPP -> "Operation not supported"
        else -> "error $errno"
    }
}

/** The phone's file system: renameat2 through Fsx, rename(2) and fsync(2) through android.system.Os, strerror from bionic. */
class AndroidFileOps : NioFileOps() {
    override fun exchange(a: File, b: File): Int =
        if (Fsx.loaded) Fsx.exchange(a.path, b.path) else FileOps.ENOSYS

    override fun rename(from: File, to: File) {
        try {
            Os.rename(from.path, to.path)
        } catch (error: ErrnoException) {
            throw IOException(error)
        }
    }

    override fun syncFolder(folder: File) {
        try {
            val fd = Os.open(folder.path, OsConstants.O_RDONLY or OsConstants.O_CLOEXEC, 0)
            try {
                Os.fsync(fd)
            } finally {
                Os.close(fd)
            }
        } catch (error: ErrnoException) {
            throw IOException(error)
        }
    }

    override fun describe(error: Throwable): String {
        var cause: Throwable? = error
        while (cause != null) {
            if (cause is ErrnoException) return Os.strerror(cause.errno)
            cause = cause.cause
        }
        return super.describe(error)
    }

    override fun strerror(errno: Int): String = Os.strerror(errno)
}

/** fsx.c (src/main/cpp): renameat2(RENAME_EXCHANGE). */
object Fsx {
    /** False when libfsx.so could not be loaded (SaveStore then copies the backup instead of swapping). */
    val loaded: Boolean = try {
        System.loadLibrary("fsx")
        true
    } catch (error: Throwable) {
        Log.info("save", "libfsx not loaded ($error): saves keep their backup by copying")
        false
    }

    /** 0 when the paths were swapped, else the errno. */
    @JvmStatic
    external fun exchange(a: String, b: String): Int
}
