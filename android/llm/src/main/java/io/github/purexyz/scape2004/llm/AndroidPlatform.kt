// :botchat's platform interfaces on Android (Platform.kt there): the main looper and a log for when the app gives none.
// The iOS app has these from Foundation (DispatchQueue.main) and ios/LostCity/Log.swift (docs/ARCHITECTURE.md §7.1).
package io.github.purexyz.scape2004.llm

import android.os.Handler
import android.os.Looper
import android.util.Log
import io.github.purexyz.scape2004.botchat.LogSink
import io.github.purexyz.scape2004.botchat.MainPoster

/** `DispatchQueue.main.async`: BotChatModel lives on the main thread, and every completion is posted there. */
object MainThread : MainPoster {
    private val handler = Handler(Looper.getMainLooper())

    override fun post(block: () -> Unit) {
        handler.post(block)
    }
}

/**
 * Lines to logcat as `[tag] message` under the tag LostCity, the app's own. The app passes
 * its LcLog instead (the same lines, also written to its log file); this is for the instrumented tests and for a caller
 * that has none.
 */
object AndroidLog : LogSink {
    override fun info(tag: String, message: String) {
        Log.i("LostCity", "[$tag] $message")
    }

    override fun debug(tag: String, message: () -> String) {
        if (Log.isLoggable("LostCity", Log.DEBUG)) Log.d("LostCity", "[$tag] ${message()}")
    }
}
