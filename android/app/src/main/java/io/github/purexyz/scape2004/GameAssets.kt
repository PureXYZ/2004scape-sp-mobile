// GameAssets: the web bundle the router serves, `assets/Game/**` in the APK (ports the bundle half of
// AssetSchemeHandler.swift; docs/ANDROID.md §2).
//
// The bundle is stored uncompressed in the APK (app/build.gradle.kts: noCompress += ""), so AssetManager.openFd() finds a
// file without inflating it and gives its exact length for Content-Length, and its stream
// reads straight from the APK. openFd() also tells a file from a folder: a folder (or a missing file) throws, and is a 404
// as on iOS. Chromium reads the stream on its own thread, so the iOS 1 MB chunking is not needed.
package io.github.purexyz.scape2004

import android.content.res.AssetManager
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream

/** An opened bundle file: its exact length and a stream of its bytes (the caller closes it). */
class OpenAsset(val length: Long, val stream: InputStream)

interface AssetSource {
    /** The bundle file at `path` (relative to Game/, already validated), or null when it is not a regular file. */
    fun open(path: String): OpenAsset?
}

/** The APK's assets/Game. */
class ApkAssets(private val assets: AssetManager, private val folder: String = "Game") : AssetSource {
    override fun open(path: String): OpenAsset? {
        val name = "$folder/$path"
        return try {
            val descriptor = assets.openFd(name)
            OpenAsset(descriptor.length, descriptor.createInputStream())
        } catch (_: FileNotFoundException) {
            // missing, a folder, or (in a build that compressed it after all) a deflated file: open() still reads that
            openCompressed(name)
        } catch (_: IOException) {
            openCompressed(name)
        }
    }

    private fun openCompressed(name: String): OpenAsset? = try {
        val stream = assets.open(name, AssetManager.ACCESS_STREAMING)
        OpenAsset(stream.available().toLong(), stream)
    } catch (_: IOException) {
        null
    }
}

/** A folder on disk (JVM unit tests: a bundle built into a temp folder). */
class DirectoryAssets(private val root: File) : AssetSource {
    override fun open(path: String): OpenAsset? {
        val file = File(root, path)
        if (!file.isFile) return null
        return try {
            OpenAsset(file.length(), FileInputStream(file))
        } catch (_: IOException) {
            null
        }
    }
}
