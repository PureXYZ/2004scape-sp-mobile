// A Scheduler with a clock the test moves by hand (Scheduler.kt): nothing runs until advance().
package io.github.purexyz.scape2004

class FakeScheduler : Scheduler {
    private class Task(val at: Long, val order: Long, val action: () -> Unit) {
        var cancelled = false
    }

    var time = 0L
        private set
    private var order = 0L
    private val tasks = ArrayList<Task>()

    override fun post(action: () -> Unit) {
        postDelayed(0, action)
    }

    override fun postDelayed(delayMs: Long, action: () -> Unit): Cancellable {
        val task = Task(time + delayMs, order++, action)
        tasks.add(task)
        return Cancellable { task.cancelled = true }
    }

    override fun isMainThread(): Boolean = true

    override fun now(): Long = time

    /** Moves the clock forward, running every task that falls due, in order. */
    fun advance(ms: Long) {
        val target = time + ms
        while (true) {
            val next = tasks.filter { !it.cancelled && it.at <= target }.minWithOrNull(compareBy({ it.at }, { it.order })) ?: break
            tasks.remove(next)
            time = next.at
            next.action()
        }
        tasks.removeAll { it.cancelled }
        time = target
    }

    /** Tasks waiting (not cancelled). */
    val pending: Int get() = tasks.count { !it.cancelled }
}
