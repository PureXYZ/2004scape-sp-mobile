// LocalModel's queue and lifecycle with a fake native layer: the warm-up, the
// idle unload, pause and resume, the background, a missing CPU backend, the slice source, and a note that is not UTF-8
// (A4).
package io.github.purexyz.scape2004.botchat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class LocalModelTest {
    private val main = TestMain()
    private val log = RecordingLog()
    private val native = FakeNative()

    private fun ask(model: LocalModel, think: Boolean = false, timeoutMs: Long = 9000): Result<LocalModel.Output> {
        val result = LinkedBlockingQueue<Result<LocalModel.Output>>()
        model.generate("system", "user", think, System.nanoTime() + timeoutMs * 1_000_000) { result.put(it) }
        return result.poll(20, TimeUnit.SECONDS) ?: error("no answer")
    }

    private fun waitFor(what: String, condition: () -> Boolean) {
        val until = System.currentTimeMillis() + 10_000
        while (!condition()) {
            if (System.currentTimeMillis() > until) error("timed out waiting for $what")
            Thread.sleep(10)
        }
    }

    @Test
    fun warmUpLoadsAndTheIdleTimerUnloads() {
        val model = LocalModel(fakeInfo(), native, main, log)
        val changes = CopyOnWriteArrayList<Boolean>()
        model.onLoadedChange = { changes += it }
        model.options = model.options.copy(idleUnloadMs = 300)
        model.warmUp()
        waitFor("the load") { log.has("local model loaded in") }
        assertTrue(model.isLoaded)
        assertEquals(listOf(-1, 0L, "/nonexistent/bots-2004.gguf", 1024, 2, 2, 0, -1, true, true), native.loadArgs.single())
        assertTrue(log.lines.any { it.startsWith("[lm] local model loaded in ") && it.endsWith("2004 chat (test) (504 MB, 24 layers, ctx 1024, 0 on the GPU, 2 threads, mmap)") })
        assertEquals(3, model.lastLoad?.size)
        waitFor("the idle unload") { log.has("[lm] local model unloaded (idle)") }
        assertFalse(model.isLoaded)
        main.drain()
        assertEquals(listOf(true, false), changes.toList())
        assertEquals(1, native.frees.get())
    }

    @Test
    fun aRequestLoadsOnceAndReportsItsLoad() {
        val model = LocalModel(fakeInfo(), native, main, log)
        val first = ask(model).getOrThrow()
        assertTrue(first.timings.loadMs != null)
        assertEquals("hey there", first.text)
        val second = ask(model).getOrThrow()
        assertEquals(null, second.timings.loadMs)
        assertEquals(1, native.loads.get())
        assertEquals(0, model.queued)
    }

    @Test
    fun theNoteIsTrimmedAndApart() {
        val model = LocalModel(fakeInfo(), native, main, log)
        val output = ask(model, think = true).getOrThrow()
        assertEquals("asks: hi. uses: nothing. tone: chill.", output.note)
        assertEquals("hey there", output.text)
        assertTrue(output.timings.think)
        assertEquals(12, output.timings.noteTokens)
        val plain = LocalModel(fakeInfo(ThinkSupport.PLAIN_TEMPLATE), native, main, log)
        val never = ask(plain, think = true).getOrThrow()
        assertEquals(null, never.note)
        assertFalse(never.timings.think)
        val always = LocalModel(fakeInfo(ThinkSupport.THINK_TEMPLATE), native, main, log)
        assertTrue(ask(always, think = false).getOrThrow().timings.think)
    }

    @Test
    fun aNoteClosedForTheModelIsLogged() {
        native.script = { _, out ->
            out.note = "asks: everything".toByteArray()
            out.closed = false
            out.text = "ok".toByteArray()
            LlmNative.OK
        }
        val model = LocalModel(fakeInfo(), native, main, log)
        ask(model, think = true).getOrThrow()
        assertTrue(log.has("[lm] the note ran to 64 tokens: closed for it"))
    }

    @Test
    fun aNoteThatIsNotUtf8DoesNotBreakTheReply() {
        native.script = { _, out ->
            out.note = byteArrayOf('a'.code.toByte(), 0xE2.toByte(), 0x82.toByte(), ' '.code.toByte(), 0xFF.toByte(), 'b'.code.toByte())
            out.closed = true
            out.text = "fine".toByteArray()
            LlmNative.OK
        }
        val model = LocalModel(fakeInfo(), native, main, log)
        val output = ask(model, think = true).getOrThrow()
        assertTrue(output.note!!.contains('�'))
        assertTrue(output.note!!.startsWith("a") && output.note!!.endsWith("b"))
        assertEquals("fine", output.text)
    }

    @Test
    fun pauseStopsTheRunningOneAndNothingStartsUntilResume() {
        val started = java.util.concurrent.CountDownLatch(1)
        native.script = { _, _ ->
            started.countDown()
            while (!native.stop.get()) Thread.sleep(5)
            LlmNative.ABORTED
        }
        val model = LocalModel(fakeInfo(), native, main, log)
        val result = LinkedBlockingQueue<Result<LocalModel.Output>>()
        model.generate("s", "u", false, System.nanoTime() + 9_000_000_000) { result.put(it) }
        assertTrue(started.await(10, TimeUnit.SECONDS))
        model.pause()
        val paused = result.poll(5, TimeUnit.SECONDS)!!
        assertEquals("failed: interrupted", (paused.exceptionOrNull() as LocalModel.Failure).description)
        assertTrue(model.isLoaded)  // (a moment's pause keeps the model)
        // while paused: nothing starts (unavailable, "background")
        val refused = ask(model)
        assertEquals("unavailable", (refused.exceptionOrNull() as LocalModel.Failure).description)
        model.resume()
        assertFalse(native.stop.get())
        native.script = { _, out ->
            out.text = "back".toByteArray()
            LlmNative.OK
        }
        assertEquals("back", ask(model).getOrThrow().text)
    }

    @Test
    fun littleMemoryLeftDoesNotLoad() {
        val model = LocalModel(fakeInfo(), native, main, log) { 100L shl 20 }
        val refused = ask(model)
        assertEquals("unavailable", (refused.exceptionOrNull() as LocalModel.Failure).description)
        assertEquals(0, native.loads.get())
        assertTrue(log.has("[lm] the local model is not loaded: 100 MB free, 1024 MB needed"))
        val roomy = LocalModel(fakeInfo(), native, main, log) { 2048L shl 20 }
        assertEquals("hey there", ask(roomy).getOrThrow().text)
    }

    @Test
    fun aMemoryWarningStopsTheRunningOneDropsTheWaitingAndFrees() {
        val started = java.util.concurrent.CountDownLatch(1)
        native.script = { _, _ ->
            started.countDown()
            while (!native.stop.get()) Thread.sleep(5)
            LlmNative.ABORTED
        }
        val model = LocalModel(fakeInfo(), native, main, log)
        val results = LinkedBlockingQueue<Result<LocalModel.Output>>()
        model.generate("s", "u", false, System.nanoTime() + 9_000_000_000) { results.put(it) }
        model.generate("s", "u", false, System.nanoTime() + 9_000_000_000) { results.put(it) }
        assertTrue(started.await(10, TimeUnit.SECONDS))
        model.release("memory warning")
        for (i in 0 until 2) {
            val result = results.poll(5, TimeUnit.SECONDS)!!
            assertEquals("failed: interrupted", (result.exceptionOrNull() as LocalModel.Failure).description)
        }
        assertEquals(1, native.generations.size)  // (the one waiting never reached llama.cpp)
        waitFor("the unload") { log.has("[lm] local model unloaded (memory warning)") }
        assertFalse(model.isLoaded)
        // a request after it: loaded again, not stopped
        native.script = { _, out ->
            out.text = "back".toByteArray()
            LlmNative.OK
        }
        assertEquals("back", ask(model).getOrThrow().text)
        assertTrue(model.isLoaded)
        assertFalse(native.stop.get())
    }

    @Test
    fun theBackgroundFreesTheModel() {
        val model = LocalModel(fakeInfo(), native, main, log)
        ask(model).getOrThrow()
        model.suspend()
        waitFor("the unload") { log.has("[lm] local model unloaded (background)") }
        assertFalse(model.isLoaded)
        model.resume()
        model.warmUp()
        waitFor("the reload") { model.isLoaded }
    }

    @Test
    fun aDeadlineAlreadyPastIsTimeout() {
        val model = LocalModel(fakeInfo(), native, main, log)
        model.warmUp()
        waitFor("the load") { model.isLoaded }
        val result = ask(model, timeoutMs = -1)
        assertEquals("timeout", (result.exceptionOrNull() as LocalModel.Failure).description)
        assertTrue(native.generations.isEmpty())
    }

    @Test
    fun noCpuBackendMakesTheModelUnavailable() {
        native.initResult = null
        val model = LocalModel(fakeInfo(), native, main, log)
        val changes = CopyOnWriteArrayList<Boolean>()
        model.onLoadedChange = { changes += it }
        assertTrue(model.available)
        val result = ask(model)
        assertEquals("failed: no CPU backend for llama.cpp", (result.exceptionOrNull() as LocalModel.Failure).description)
        assertFalse(model.available)
        assertEquals("no-runtime", model.unavailableReason)
        main.drain()
        assertEquals(listOf(false), changes.toList())  // (so the page hears the new status)
    }

    @Test
    fun aLoadThatFailsSaysWhy() {
        native.loadError = "the model did not load"
        val model = LocalModel(fakeInfo(), native, main, log)
        assertEquals("failed: the model did not load", (ask(model).exceptionOrNull() as LocalModel.Failure).description)
        model.warmUp()
        waitFor("the warm-up's log") { log.has("[lm] warming the local model failed: failed: the model did not load") }
    }

    @Test
    fun aSliceIsOpenedForEachLoadAndClosed() {
        var opened = 0
        var closed = 0
        val info = fakeInfo().copy(source = ModelSource.Slice {
            opened++
            FdSlice(77, 1_000_007, 529_297_728) { closed++ }
        })
        val model = LocalModel(info, native, main, log)
        ask(model).getOrThrow()
        assertEquals(1, opened)
        assertEquals(1, closed)
        assertEquals(77, native.loadArgs.single()[0])
        assertEquals(1_000_007L, native.loadArgs.single()[1])
        assertTrue(log.lines.any { it.endsWith("2 threads, read: not 32-byte aligned in the APK)") })
    }

    @Test
    fun noModelOrNoRuntimeIsUnavailableAtOnce() {
        val none = LocalModel(null, native, main, log)
        assertEquals("unavailable", (ask(none).exceptionOrNull() as LocalModel.Failure).description)
        assertEquals("no-model", none.unavailableReason)
        val noRuntime = LocalModel(fakeInfo(), null, main, log)
        assertEquals("no-runtime", noRuntime.unavailableReason)
        assertEquals(ThinkSupport.NEVER, noRuntime.thinkSupport)
        assertEquals(0, native.loads.get())
    }
}
