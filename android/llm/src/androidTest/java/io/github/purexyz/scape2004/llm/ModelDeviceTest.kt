// The on-device model on a real Android (the arm64 emulator or a phone): the GGUF stored and
// 32-byte aligned in the APK, loaded from it by file descriptor in every load mode, and replies with and without the note,
// with their timings and the process's memory written to logcat (tag LostCityTest) for the record.
package io.github.purexyz.scape2004.llm

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.purexyz.scape2004.botchat.JsonBridge
import io.github.purexyz.scape2004.botchat.LlmJni
import io.github.purexyz.scape2004.botchat.LocalModel
import io.github.purexyz.scape2004.botchat.ModelSource
import io.github.purexyz.scape2004.botchat.ThinkSupport
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class ModelDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    /** The first bench prompt (web/test/lm/bench-prompts.json #1, the engine's renderLocal), as the Mac harness uses it. */
    private val prompt: Map<String, Any?> by lazy {
        val json = context.assets.open("bench-prompts.json").use { String(it.readBytes()) }
        @Suppress("UNCHECKED_CAST")
        val first = (JsonBridge.toMap(Json.parseToJsonElement(json) as JsonObject)["prompts"] as List<Map<String, Any?>>)[0]
        @Suppress("UNCHECKED_CAST")
        first["local"] as Map<String, Any?>
    }
    private val system by lazy { prompt["system"] as String }
    private val user by lazy { prompt["user"] as String }

    @Before
    fun needTheModel() = assumeTrue("a build without the model (-Plc.model=none)", expectModel)

    private fun model(mmap: Int = -1): LocalModel {
        assertTrue("liblcllm: ${LlmJni.loadError}", LlmJni.loaded)
        val info = ModelAssets.load(context, TestLog, debug = false)
        assertNotNull("no model in the test APK (android/scripts/prepare-model.sh, and not -Plc.model=none)", info)
        return LocalModel(info, LlmJni, MainThread, TestLog).also { it.options = it.options.copy(mmap = mmap) }
    }

    private fun ask(model: LocalModel, think: Boolean): LocalModel.Output {
        val result = LinkedBlockingQueue<Result<LocalModel.Output>>()
        model.generate(system, user, think, System.nanoTime() + 30_000_000_000L) { result.put(it) }
        return result.poll(120, TimeUnit.SECONDS)!!.getOrThrow()
    }

    @Test
    fun theModelIsStoredAndAlignedInTheApk() {
        val info = ModelAssets.load(context, TestLog, debug = false)!!
        assertEquals("2004 chat (Qwen3.5 0.8B + LoRA)", info.name)
        assertEquals(ThinkSupport.OPTION, info.think)
        context.assets.openFd("Model/${info.file}").use { asset ->
            TestLog.result("asset ${info.file}: offset ${asset.startOffset} (mod 32 = ${asset.startOffset % 32}), ${asset.length} bytes")
            assertEquals(info.bytes, asset.length)
            assertEquals("the model's offset in the APK (lostcity.model's zipalign)", 0L, asset.startOffset % 32)
        }
        assertTrue(info.source is ModelSource.Slice)
    }

    @Test
    fun loadsFromTheApkInEveryMode() {
        for (mode in listOf(-1, 0, 1)) {
            val model = model(mode)
            val started = System.nanoTime()
            model.warmUp()
            waitFor("the load (mmap $mode)") { model.isLoaded }
            val ms = (System.nanoTime() - started) / 1e6
            TestLog.result("load mmap=$mode: mapped ${model.mapped}, ${ms.toInt()} ms, lastLoad ${model.lastLoad?.map { it.toInt() }}, cpu ${model.cpuVariant}; ${memory()}")
            assertEquals(mode != 0, model.mapped)
            val output = ask(model, false)
            assertTrue(output.text.isNotEmpty())
            model.shutdown()
        }
    }

    @Test
    fun repliesWithAndWithoutTheNote() {
        val model = model()
        model.warmUp()
        waitFor("the load") { model.isLoaded }
        TestLog.result("loaded: lastLoad ${model.lastLoad?.map { it.toInt() }} ms (total, model, context), cpu ${model.cpuVariant}, mapped ${model.mapped}; ${memory()}")
        for (think in listOf(false, true, false, true, false, true)) {
            val output = ask(model, think)
            val t = output.timings
            TestLog.result("think ${if (think) "on " else "off"}: total ${t.totalMs.toInt()} ms, prompt ${t.promptTokens} tokens at ${t.promptTokensPerSecond.toInt()}/s, " +
                (if (think) "note ${t.noteTokens} tokens in ${t.noteMs.toInt()} ms, " else "") +
                "reply ${t.generatedTokens} tokens at ${t.generateTokensPerSecond.toInt()}/s: \"${output.text}\"" + (output.note?.let { " | note: $it" } ?: ""))
            assertTrue(output.text.isNotEmpty())
            assertFalse(output.text.contains("think>"))
            assertEquals(think, t.think)
            if (think) {
                assertTrue(t.noteTokens > 0)
                assertTrue(output.note!!.isNotEmpty())
                assertFalse(output.text.contains(output.note!!))
            } else {
                assertEquals(null, output.note)
            }
        }
        TestLog.result("after 6 replies: ${memory()}")
        model.shutdown()
    }

    @Test
    fun aPauseStopsAPromptInsideItsBatch() {
        val model = model()
        model.warmUp()
        waitFor("the load") { model.isLoaded }
        val result = LinkedBlockingQueue<Result<LocalModel.Output>>()
        model.generate(system, user, false, System.nanoTime() + 30_000_000_000L) { result.put(it) }
        Thread.sleep(100)
        val paused = System.nanoTime()
        model.pause()
        val stopped = result.poll(10, TimeUnit.SECONDS)!!
        val ms = (System.nanoTime() - paused) / 1e6
        TestLog.result("pause 100 ms into a reply: ${(stopped.exceptionOrNull() as? LocalModel.Failure)?.description} after ${ms.toInt()} ms")
        assertEquals("failed: interrupted", (stopped.exceptionOrNull() as LocalModel.Failure).description)
        assertTrue("stopped in $ms ms", ms < 500)
        model.resume()
        assertTrue(ask(model, false).text.isNotEmpty())
        model.shutdown()
    }
}
