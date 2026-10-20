// The bundled model, as prepare-model.sh describes it in Model/model.json: {name, file, bytes, sha256, ctx, template}. The
// Kotlin port of the iOS app's `ModelInfo` and `LocalModel.ThinkSupport` (ios/LostCity/LocalModel.swift).
// Where the GGUF is read from is the platform's business: on Android a stored asset inside the APK, opened by file
// descriptor at its offset (android/llm ModelAssets.kt); on the Mac a file.
package io.github.purexyz.scape2004.botchat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * Whether the model writes a short note in Qwen's think block before its reply ("asks: my inventory. uses: carrying 3 rune
 * full helm. tone: blunt."), from model.json's template:
 * - [NEVER]: 'qwen-chatml-nothink' (the first 2004 model; also a template this build does not know)
 * - [ALWAYS]: 'qwen-chatml-think' (the note variant)
 * - [OPTION]: 'qwen-chatml-hybrid' (one model trained in both modes): the request decides (Settings › Bot chat › Think first)
 *
 * The status's `local.think` (docs/ARCHITECTURE.md §7.1).
 */
enum class ThinkSupport(val raw: String) {
    NEVER("never"),
    ALWAYS("always"),
    OPTION("option");

    /** Whether a request writes the note: what it asked where the model offers the choice, else the model's way. */
    fun writesNote(asked: Boolean): Boolean = when (this) {
        NEVER -> false
        ALWAYS -> true
        OPTION -> asked
    }

    companion object {
        const val PLAIN_TEMPLATE = "qwen-chatml-nothink"
        const val THINK_TEMPLATE = "qwen-chatml-think"
        const val HYBRID_TEMPLATE = "qwen-chatml-hybrid"

        fun of(template: String): ThinkSupport = when (template) {
            THINK_TEMPLATE -> ALWAYS
            HYBRID_TEMPLATE -> OPTION
            else -> NEVER
        }
    }
}

/**
 * A slice of an open file: the APK's descriptor and where the asset starts in it (Android's AssetFileDescriptor), or a test's
 * padded copy of the GGUF. [close] gives it back; native code keeps its own duplicate of [fd] for as long as it needs one.
 */
class FdSlice(val fd: Int, val offset: Long, val length: Long, private val closer: () -> Unit) : AutoCloseable {
    override fun close() = closer()
}

/** Where the GGUF is: re-opened at every load (a load happens again after the idle unload or the background). */
sealed interface ModelSource {
    /** Inside another file (a stored APK asset), by descriptor and offset: mmapped when its data is aligned for it. */
    class Slice(val open: () -> FdSlice) : ModelSource

    /** A file of its own (the Mac harness, a debug build's sideloaded model). */
    class File(val path: String) : ModelSource
}

data class ModelInfo(
    val name: String,
    val file: String,
    val bytes: Long,
    val sha256: String,
    val ctx: Int,
    /** 'qwen-chatml-nothink', 'qwen-chatml-think' or 'qwen-chatml-hybrid': whether the model writes its note (`think`) */
    val template: String,
    val source: ModelSource,
) {
    /** Whether the model writes a reasoning note before its reply, as its template says. */
    val think: ThinkSupport get() = ThinkSupport.of(template)

    companion object {
        /**
         * Reads model.json as the iOS app does (LM-1): null when there is no JSON object, when `file` is missing, empty or
         * contains a "/", or when the GGUF is not there (`sizeOf` null or not positive). The defaults: `name` the file,
         * `bytes` its real size, `ctx` 1024, `template` 'qwen-chatml-nothink'. The sha256 is not checked here (the build
         * checks it: the plugin lostcity.model's verifyModel task).
         */
        fun parse(json: String?, sizeOf: (String) -> Long?, source: (String) -> ModelSource): ModelInfo? {
            if (json == null) return null
            val root = runCatching { Json.parseToJsonElement(json) }.getOrNull() as? JsonObject ?: return null
            val values = JsonBridge.toMap(root)
            val file = values["file"] as? String ?: return null
            if (file.isEmpty() || file.contains("/")) return null
            val size = sizeOf(file) ?: 0
            if (size <= 0) return null
            return ModelInfo(
                name = values["name"] as? String ?: file,
                file = file,
                bytes = SwiftCast.exactLong(values["bytes"]) ?: size,
                sha256 = values["sha256"] as? String ?: "",
                ctx = SwiftCast.exactLong(values["ctx"])?.toInt() ?: 1024,
                template = values["template"] as? String ?: ThinkSupport.PLAIN_TEMPLATE,
                source = source(file),
            )
        }

        /** A model folder on disk (the Mac harness; a debug build's sideloaded Model/). */
        fun load(folder: java.io.File): ModelInfo? {
            val json = runCatching { java.io.File(folder, "model.json").readText() }.getOrNull()
            return parse(json, { java.io.File(folder, it).takeIf { f -> f.isFile }?.length() }, { ModelSource.File(java.io.File(folder, it).path) })
        }
    }
}
