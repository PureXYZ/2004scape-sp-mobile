// What the instrumented tests share: the test log (logcat tag LostCityTest, which the runner reads
// for the numbers), shell commands as the shell user (thermal overrides), memory readings and waits.
package io.github.purexyz.scape2004.llm

import android.os.Debug
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import io.github.purexyz.scape2004.botchat.LogSink
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

object TestLog : LogSink {
    val lines = CopyOnWriteArrayList<String>()

    override fun info(tag: String, message: String) {
        lines += "[$tag] $message"
        Log.i("LostCity", "[$tag] $message")
    }

    override fun debug(tag: String, message: () -> String) = Unit

    /** A result line for the runner (adb logcat -s LostCityTest). */
    fun result(text: String) {
        Log.i("LostCityTest", text)
    }

    fun has(fragment: String) = lines.any { it.contains(fragment) }
}

/** Runs a shell command as the shell user (UiAutomation) and returns its output. */
fun shell(command: String): String {
    val pfd = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)
    return ParcelFileDescriptor.AutoCloseInputStream(pfd).use { String(it.readBytes()) }
}

/** The process's memory now: PSS (total, native heap), and RSS split into anonymous and file-backed (/proc/self/status). */
fun memory(): String {
    val info = Debug.MemoryInfo()
    Debug.getMemoryInfo(info)
    val status = File("/proc/self/status").readLines().associate { line ->
        line.substringBefore(':') to line.substringAfter(':').trim()
    }
    return "PSS ${info.totalPss / 1024} MB (native heap ${info.nativePss / 1024} MB), RSS ${status["VmRSS"]} (anon ${status["RssAnon"]}, file ${status["RssFile"]})"
}

/**
 * Whether this test APK carries the model: the runner passes -Pandroid.testInstrumentationRunnerArguments.model=none for a
 * -Plc.model=none build (the two configurations), and the tests then expect "Not in this build".
 */
val expectModel: Boolean get() = InstrumentationRegistry.getArguments().getString("model") != "none"

fun waitFor(what: String, seconds: Int = 120, condition: () -> Boolean) {
    val until = System.currentTimeMillis() + seconds * 1000L
    while (!condition()) {
        if (System.currentTimeMillis() > until) throw AssertionError("timed out waiting for $what")
        Thread.sleep(20)
    }
}
