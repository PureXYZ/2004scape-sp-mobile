// The small things that must match the iOS app exactly: Swift's trimming set, the key's rules,
// the templates, model.json, the timings' rounding and formulas, and every failure string the page or the log sees.
package io.github.purexyz.scape2004.botchat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PortTest {
    @Test
    fun swiftTrimIsSwiftsWhitespaceAndNewlines() {
        assertEquals("a b", "\u0085 \t\n\r\u000B\u000C a b    　 ".swiftTrim())
        // Java's whitespace, not Swift's: kept
        assertEquals("\u001Ca\u001F", "\u001Ca\u001F".swiftTrim())
        assertEquals("​a", "​a".swiftTrim())  // (a format character, not a space separator)
        assertEquals("", " \n ".swiftTrim())
        assertEquals("x", "\nx\r\n".swiftTrimNewlines())
        assertEquals(" x\t", " x\t".swiftTrimNewlines())
    }

    @Test
    fun keyRules() {
        assertNull(ModelKeyStore.normalized("sk-1234"))  // 7
        assertEquals("sk-12345", ModelKeyStore.normalized("sk-12345"))  // 8
        assertEquals("a".repeat(512), ModelKeyStore.normalized("a".repeat(512)))
        assertNull(ModelKeyStore.normalized("a".repeat(513)))
        assertNull(ModelKeyStore.normalized("sk-ant 1234"))  // a space inside
        assertNull(ModelKeyStore.normalized("sk-ant-é234"))  // not ASCII
        assertNull(ModelKeyStore.normalized("sk-ant-\u007f234"))  // DEL
        assertEquals("sk-ant-abcd", ModelKeyStore.normalized("\n  sk-ant-abcd \u0085"))
        assertEquals("…abcd", ModelKeyStore.hint("sk-ant-test-ok-abcd"))
        assertEquals("…ab", ModelKeyStore.hint("ab"))
        assertNull(ModelKeyStore.hint(null))
    }

    @Test
    fun templates() {
        assertEquals(ThinkSupport.ALWAYS, ThinkSupport.of("qwen-chatml-think"))
        assertEquals(ThinkSupport.OPTION, ThinkSupport.of("qwen-chatml-hybrid"))
        assertEquals(ThinkSupport.NEVER, ThinkSupport.of("qwen-chatml-nothink"))
        assertEquals(ThinkSupport.NEVER, ThinkSupport.of("qwen-chatml-unknown"))
        assertFalse(ThinkSupport.NEVER.writesNote(true))
        assertTrue(ThinkSupport.ALWAYS.writesNote(false))
        assertTrue(ThinkSupport.OPTION.writesNote(true))
        assertFalse(ThinkSupport.OPTION.writesNote(false))
    }

    @Test
    fun modelJson() {
        val size = { _: String -> 100L }
        val source = { file: String -> ModelSource.File(file) }
        assertNull(ModelInfo.parse(null, size, source))
        assertNull(ModelInfo.parse("[]", size, source))
        assertNull(ModelInfo.parse("""{"name": "x"}""", size, source))
        assertNull(ModelInfo.parse("""{"file": ""}""", size, source))
        assertNull(ModelInfo.parse("""{"file": "a/b.gguf"}""", size, source))
        assertNull(ModelInfo.parse("""{"file": "b.gguf"}""", { 0L }, source))
        assertNull(ModelInfo.parse("""{"file": "b.gguf"}""", { null }, source))
        val defaults = ModelInfo.parse("""{"file": "b.gguf"}""", size, source)!!
        assertEquals("b.gguf", defaults.name)
        assertEquals(100L, defaults.bytes)
        assertEquals("", defaults.sha256)
        assertEquals(1024, defaults.ctx)
        assertEquals("qwen-chatml-nothink", defaults.template)
        val full = ModelInfo.parse(
            """{"name": "2004 chat", "file": "bots-2004.gguf", "bytes": 529297728, "sha256": "e8", "ctx": 2048.0, "template": "qwen-chatml-hybrid"}""",
            size, source,
        )!!
        assertEquals(529_297_728L, full.bytes)
        assertEquals(2048, full.ctx)
        assertEquals(ThinkSupport.OPTION, full.think)
        // (Swift's `as? Int` refuses a fraction: the real size then)
        assertEquals(100L, ModelInfo.parse("""{"file": "b.gguf", "bytes": 1.5}""", size, source)!!.bytes)
    }

    @Test
    fun roundingIsSwifts() {
        assertEquals(0.3, round1(0.25), 0.0)  // (half away from zero; Kotlin's round would give 0.2)
        assertEquals(-0.3, round1(-0.25), 0.0)
        assertEquals(12.3, round1(12.34), 0.0)
        assertEquals(651.0, round1(650.96), 0.0)
    }

    @Test
    fun timingsDictionary() {
        val t = LocalModel.Timings().apply {
            promptTokens = 300
            reusedTokens = 20
            promptMs = 1400.0
            generatedTokens = 5
            generateMs = 70.0
            totalMs = 1500.04
        }
        val plain = t.dictionary
        assertEquals(listOf("promptTokens", "reusedTokens", "promptMs", "promptTps", "generatedTokens", "generateMs", "generateTps", "resampled", "think", "totalMs"), plain.keys.toList())
        assertEquals(200.0, plain["promptTps"])  // (300 - 20) * 1000 / 1400
        assertEquals(71.4, plain["generateTps"])
        assertEquals(1500.0, plain["totalMs"])
        assertEquals(false, plain["think"])
        t.loadMs = 812.36
        t.think = true
        t.noteTokens = 20
        t.noteMs = 300.06
        val noted = t.dictionary
        assertEquals(812.4, noted["loadMs"])
        assertEquals(20, noted["noteTokens"])
        assertEquals(300.1, noted["noteMs"])
        val zero = LocalModel.Timings().dictionary
        assertEquals(0.0, zero["promptTps"])
        assertEquals(0.0, zero["generateTps"])
    }

    @Test
    fun localFailures() {
        assertEquals("unavailable", LocalModel.Failure.Unavailable("background").description)
        assertEquals("timeout", LocalModel.Failure.Timeout.description)
        assertEquals("failed: interrupted", LocalModel.Failure.Aborted.description)
        assertEquals("failed: decode 1", LocalModel.Failure.Failed("decode 1").description)
    }

    @Test
    fun onlineFailures() {
        fun check(failure: OnlineModel.Failure, reason: String, problem: String, description: String) {
            assertEquals(reason, failure.reason)
            assertEquals(problem, failure.problem)
            assertEquals(description, failure.description)
        }
        check(OnlineModel.Failure.KeyRefused, "refused", "key refused", "refused")
        check(OnlineModel.Failure.Declined("general_harms"), "refused", "declined", "declined (general_harms)")
        check(OnlineModel.Failure.Declined(null), "refused", "declined", "declined (no category)")
        check(OnlineModel.Failure.Timeout, "timeout", "timed out", "timeout")
        check(OnlineModel.Failure.Http(429, "rate_limit_error"), "failed: rate limited", "rate limited", "http 429 rate_limit_error")
        check(OnlineModel.Failure.Http(529, "overloaded_error"), "failed: overloaded", "overloaded", "http 529 overloaded_error")
        check(OnlineModel.Failure.Http(402, "billing_error"), "failed: billing", "billing problem", "http 402 billing_error")
        check(OnlineModel.Failure.Http(403, "permission_error"), "failed: permission", "no permission", "http 403 permission_error")
        check(OnlineModel.Failure.Http(500, "api_error"), "failed: http 500", "error 500", "http 500 api_error")
        check(OnlineModel.Failure.Network("ConnectException refused"), "failed: network", "no connection", "network: ConnectException refused")
        check(OnlineModel.Failure.Empty("end_turn"), "failed: empty", "empty reply", "no text (stop_reason end_turn)")
    }

    @Test
    fun onlineBodyIsTheIphonesExactly() {
        assertEquals(
            """{"model":"claude-haiku-5-5","max_tokens":60,"thinking":{"type":"disabled"},"output_config":{"effort":"low"},""" +
                """"system":[{"type":"text","text":"guide","cache_control":{"type":"ephemeral"}},{"type":"text","text":"facts"}],""" +
                """"messages":[{"role":"user","content":"hi \"there\""}]}""",
            OnlineModel.body("guide", "facts", "hi \"there\"").toString(),
        )
        // (the facts' block is left out when there are none)
        assertEquals(
            """[{"type":"text","text":"guide","cache_control":{"type":"ephemeral"}}]""",
            OnlineModel.body("guide", "", "hi")["system"].toString(),
        )
    }

    @Test
    fun swiftCasts() {
        assertEquals(9000, SwiftCast.intValue(9000.7))
        assertEquals(1, SwiftCast.intValue(true))
        assertEquals(12, SwiftCast.intValue(12L))
        assertNull(SwiftCast.intValue("12"))
        assertEquals(true, SwiftCast.bool(1L))
        assertEquals(false, SwiftCast.bool(0.0))
        assertNull(SwiftCast.bool(2L))
        assertNull(SwiftCast.bool("true"))
    }

    @Test
    fun llamaLogFilter() {
        val log = RecordingLog()
        val previous = LlmLog.sink
        LlmLog.sink = log
        try {
            LlmLog.loading = true
            LlmLog.line(2, "llama_context: CPU compute buffer size =    40.95 MiB\n".toByteArray())
            LlmLog.line(2, "print_info: n_vocab = 248320\n".toByteArray())
            // (llama.cpp's per-tensor and per-graph-input debug lines: about 950 a load on Android)
            LlmLog.line(1, "create_tensor: loading tensor blk.0.attn_norm.weight\n".toByteArray())
            LlmLog.line(1, "llama_graph_n_input_tensors: input tensor 'out_ids' [i32, ne = {1, 1, 1, 1}] is used by node 'result_norm' (GET_ROWS)\n".toByteArray())
            LlmLog.line(5, ".".toByteArray())
            LlmLog.line(5, "\n".toByteArray())
            LlmLog.loading = false
            LlmLog.line(2, "llama_context: something later\n".toByteArray())
            LlmLog.line(3, "warning: a warning\n".toByteArray())
            assertEquals(
                listOf(
                    "[llama] llama_context: CPU compute buffer size =    40.95 MiB",
                    "debug [llama] print_info: n_vocab = 248320",
                    "debug [llama] create_tensor: loading tensor blk.0.attn_norm.weight",
                    "debug [llama] llama_graph_n_input_tensors: input tensor 'out_ids' [i32, ne = {1, 1, 1, 1}] is used by node 'result_norm' (GET_ROWS)",
                    "debug [llama] llama_context: something later",
                    "[llama] warning: a warning",
                ),
                log.lines.toList(),
            )
        } finally {
            LlmLog.sink = previous
            LlmLog.loading = false
        }
    }
}
