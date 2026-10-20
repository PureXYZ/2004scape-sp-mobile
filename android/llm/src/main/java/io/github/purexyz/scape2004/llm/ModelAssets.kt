// The bundled chat model on Android (docs/ANDROID.md §4): assets/Model/model.json and its GGUF,
// stored (never deflated) and 32-byte aligned in the APK by the build (android/build-logic, the plugin lostcity.model).
// LocalModel opens the GGUF again at each load by file descriptor: the APK's own descriptor and the asset's offset in it,
// which llama.cpp maps straight from the APK (no copy, no second 529 MB on disk). The iOS app reads Model/ from its bundle
// the same way (ios/LostCity/LocalModel.swift, ModelInfo.load). The page never sees it: the app's router serves assets/Game only.
//
// Debug builds only: a model pushed to the app's external files (adb push <folder> /sdcard/Android/data/<package>/files/Model)
// wins over the one in the APK, so a new model needs no 600 MB reinstall; its name says "(sideloaded)".
package io.github.purexyz.scape2004.llm

import android.content.Context
import io.github.purexyz.scape2004.botchat.FdSlice
import io.github.purexyz.scape2004.botchat.LogSink
import io.github.purexyz.scape2004.botchat.ModelInfo
import io.github.purexyz.scape2004.botchat.ModelSource
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException

object ModelAssets {
    const val FOLDER = "Model"

    fun load(context: Context, log: LogSink, debug: Boolean): ModelInfo? {
        if (debug) {
            val folder = context.getExternalFilesDir(null)?.let { File(it, FOLDER) }
            if (folder != null && File(folder, "model.json").isFile) {
                val sideloaded = ModelInfo.load(folder)
                if (sideloaded != null) {
                    log.info("lm", "the chat model is sideloaded: $folder")
                    return sideloaded.copy(name = "${sideloaded.name} (sideloaded)")
                }
            }
        }
        val assets = context.assets
        val json = try {
            assets.open("$FOLDER/model.json").use { String(it.readBytes(), Charsets.UTF_8) }
        } catch (_: IOException) {
            return null  // (a build without a model: -Plc.model=none, or prepare-model.sh --none)
        }
        return ModelInfo.parse(
            json,
            sizeOf = { file ->
                try {
                    assets.openFd("$FOLDER/$file").use { it.length }
                } catch (_: FileNotFoundException) {
                    // (openFd refuses a compressed entry with the same exception as a missing one)
                    if (assets.list(FOLDER)?.contains(file) == true) log.info("lm", "the model is compressed in the APK: not usable")
                    null
                }
            },
            source = { file ->
                ModelSource.Slice {
                    val asset = assets.openFd("$FOLDER/$file")
                    FdSlice(asset.parcelFileDescriptor.fd, asset.startOffset, asset.length) { asset.close() }
                }
            },
        )
    }
}
