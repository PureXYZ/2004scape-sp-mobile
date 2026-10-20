// Log: the native log (ports ios/LostCity/Log.swift).
//
// Every line goes to logcat under the tag "LostCity" (the iOS app's line-buffered stdout: stream it with
// `adb logcat -s LostCity:V`), and to a rotating file, so a session that ran without adb can be read afterwards:
//
//     adb pull /sdcard/Android/data/io.github.purexyz.scape2004/files/Logs/lostcity.log .
//
// The file lives in the app's external files folder: out of Documents on purpose (Documents is the save area that
// /save-index lists and the Files app shows), hidden from the Files app since Android 11, and readable over adb on a
// release build too, where `run-as` is not allowed. Without that folder it falls back to cacheDir/Logs.
//
// Until setUp() runs (the JVM unit tests never run it) lines go to stdout, so the pure-Kotlin parts log in tests too.
package io.github.purexyz.scape2004

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

object Log {
    /**
     * Extra per-request and per-keystroke lines (the iOS app's `-LostCityVerbose YES`). In a debug build, launch with
     * `adb shell am start -n io.github.purexyz.scape2004/.GameActivity --ez lostcity.verbose true` to turn it on (it is kept;
     * `false` turns it off again). A release build never turns it on, nor reads the switch a debug build kept.
     */
    @Volatile
    var verbose = false

    /** logcat's own limit is about 4 KB per entry: longer lines are split, the file keeps them whole. */
    private const val LOGCAT_CHUNK = 4000
    private const val LOGCAT_TAG = "LostCity"

    /** Longest line written; page console output can be arbitrarily large objects. */
    private const val MAX_LINE = 16 * 1024

    private const val PREFS = "LostCity"
    private const val VERBOSE_KEY = "verbose"

    @Volatile
    private var logcat = false
    @Volatile
    private var file: LogFile? = null
    private val timestamp = DateTimeFormatter.ofPattern("HH:mm:ss.SSS")

    /** First thing at launch (LostCityApp.onCreate): logcat, the log file, and the kept verbose switch. */
    fun setUp(context: Context) {
        verbose = BuildConfig.DEBUG && context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(VERBOSE_KEY, false)
        logcat = true
        val directory = File(context.getExternalFilesDir(null) ?: context.cacheDir, "Logs")
        file = LogFile(directory).also { it.start() }
    }

    /** Turns verbose logging on or off for this and later launches (a debug build's `lostcity.verbose` intent extra). */
    fun setVerbose(context: Context, on: Boolean) {
        verbose = on
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(VERBOSE_KEY, on).apply()
        info("app", "verbose log ${if (on) "on" else "off"}")
    }

    /** `HH:MM:SS.mmm [tag] message` */
    fun info(tag: String, message: String) = write("[$tag] $message")

    /** Only with verbose on; the message is not even built otherwise. */
    inline fun debug(tag: String, message: () -> String) {
        if (verbose) write("[$tag] ${message()}")
    }

    fun write(line: String) {
        val text = if (line.length > MAX_LINE) line.take(MAX_LINE) + " …(truncated)" else line
        if (logcat) {
            var start = 0
            while (start < text.length) {
                val end = minOf(text.length, start + LOGCAT_CHUNK)
                android.util.Log.i(LOGCAT_TAG, text.substring(start, end))
                start = end
            }
        } else {
            println(text)
        }
        file?.append("${LocalDateTime.now().format(timestamp)} $text")
    }

    /** Pushes buffered output to disk; called before the app may be stopped or killed (onStop, after each flush). */
    fun flush() {
        file?.flush()
    }
}

/**
 * Buffered, rotating append-only log file (LogFile in Log.swift). All state is confined to one thread, `lostcity-log`:
 * lines are written at 32 KB or 0.3 s after the first line of a burst, the file is rotated at 2 MB to lostcity.1.log,
 * and a write error (a full disk) drops the buffer rather than grow memory without bound.
 */
private class LogFile(private val directory: File) {
    private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "lostcity-log").apply { isDaemon = true }
    }
    private val file = File(directory, "lostcity.log")
    private val rotated = File(directory, "lostcity.1.log")
    private var stream: FileOutputStream? = null
    private var size = 0L
    private val buffer = StringBuilder()
    private var flushScheduled = false

    fun start() {
        executor.execute {
            directory.mkdirs()
            open()
            buffer.append("\n===== launch ${java.util.Date()} =====\n")
        }
    }

    fun append(line: String) {
        executor.execute {
            buffer.append(line).append('\n')
            if (buffer.length >= FLUSH_AT) {
                writeBuffer()
            } else if (!flushScheduled) {
                flushScheduled = true
                executor.schedule({
                    flushScheduled = false
                    writeBuffer()
                }, 300, TimeUnit.MILLISECONDS)
            }
        }
    }

    /** Synchronous, but never for long: the UI thread calls it in onStop (at most one second). */
    fun flush() {
        try {
            executor.submit { writeBuffer() }.get(1, TimeUnit.SECONDS)
        } catch (_: Exception) {
            // a slow disk: the scheduled write still happens
        }
    }

    private fun open() {
        try {
            stream = FileOutputStream(file, true)
            size = file.length()
            if (size >= ROTATE_AT) rotate()
        } catch (_: Exception) {
            stream = null
        }
    }

    private fun rotate() {
        try {
            stream?.close()
        } catch (_: Exception) {
        }
        stream = null
        rotated.delete()
        file.renameTo(rotated)
        try {
            stream = FileOutputStream(file, false)
        } catch (_: Exception) {
            stream = null
        }
        size = 0
    }

    private fun writeBuffer() {
        if (buffer.isEmpty()) return
        if (stream == null) open()
        val out = stream
        if (out == null) {
            buffer.setLength(0)
            return
        }
        val bytes = buffer.toString().toByteArray(Charsets.UTF_8)
        buffer.setLength(0)
        try {
            out.write(bytes)
            size += bytes.size
        } catch (_: Exception) {
            // disk full or similar: drop the log rather than grow memory without bound
        }
        if (size >= ROTATE_AT) rotate()
    }

    private companion object {
        const val ROTATE_AT = 2L * 1024 * 1024
        const val FLUSH_AT = 32 * 1024
    }
}
