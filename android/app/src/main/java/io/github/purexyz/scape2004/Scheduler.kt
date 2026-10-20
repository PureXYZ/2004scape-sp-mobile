// Scheduler: the UI thread and its clock, behind an interface so the pure-Kotlin parts (PageBridge, LifecycleCoordinator,
// KeepAwake) run in JVM unit tests with a fake clock. In the app it is the main looper and
// SystemClock.elapsedRealtime(), the monotonic clock (the iOS code's ContinuousClock).
package io.github.purexyz.scape2004

import android.os.Handler
import android.os.Looper
import android.os.SystemClock

interface Scheduler {
    /** Runs `action` on the UI thread soon (after what is running now). */
    fun post(action: () -> Unit)

    /** Runs `action` on the UI thread after `delayMs`; the returned handle cancels it. */
    fun postDelayed(delayMs: Long, action: () -> Unit): Cancellable

    /** True on the UI thread. */
    fun isMainThread(): Boolean

    /** Monotonic milliseconds. */
    fun now(): Long
}

fun interface Cancellable {
    fun cancel()
}

/** The app's scheduler: the main looper. */
object MainScheduler : Scheduler {
    private val handler = Handler(Looper.getMainLooper())

    override fun post(action: () -> Unit) {
        handler.post(action)
    }

    override fun postDelayed(delayMs: Long, action: () -> Unit): Cancellable {
        val runnable = Runnable(action)
        handler.postDelayed(runnable, delayMs)
        return Cancellable { handler.removeCallbacks(runnable) }
    }

    override fun isMainThread(): Boolean = Looper.myLooper() == Looper.getMainLooper()

    override fun now(): Long = SystemClock.elapsedRealtime()
}
