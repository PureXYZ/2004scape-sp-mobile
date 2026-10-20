// AppInfo: facts about this build and device, injected as `window.LostCityNative` (ports AppInfo in
// ios/LostCity/NativeSettings.swift; docs/ANDROID.md §3.1) and printed in the launch log line.
//
// `window.LostCityNative` on Android: {platform: 'android', appVersion, build, osVersion, sdkInt, deviceModel,
// manufacturer, simulator: false, emulator, debug, webView, haptics, settings, lm}. `simulator` stays false (there is no
// iOS simulator here, and the page's "Not on the simulator" means llama.cpp is missing, which an emulator is not);
// `emulator` says whether this is the Android emulator. The page ignores keys it does not know.
package io.github.purexyz.scape2004

import android.content.Context
import android.os.Build
import android.os.Process
import android.os.Vibrator
import android.webkit.WebView
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

object AppInfo {
    val version: String get() = BuildConfig.VERSION_NAME
    val build: String get() = BuildConfig.VERSION_CODE.toString()
    val isDebug: Boolean get() = BuildConfig.DEBUG

    /** e.g. "sdk_gphone64_arm64" on the emulator, "Pixel 10" on the phone. */
    val deviceModel: String get() = Build.MODEL ?: "?"

    /** The Android emulator. */
    val isEmulator: Boolean by lazy {
        val fingerprint = Build.FINGERPRINT ?: ""
        fingerprint.startsWith("generic") || fingerprint.contains("emulator") ||
            Build.HARDWARE == "ranchu" || Build.HARDWARE == "goldfish" || (Build.PRODUCT ?: "").contains("sdk")
    }

    /**
     * The installed Android System WebView's version (e.g. "145.0.7632.218"), or null without one. Asks the system which
     * package it would load; it does not load WebView itself, so it is cheap enough for the launch line.
     */
    val webViewVersion: String?
        get() = try {
            WebView.getCurrentWebViewPackage()?.versionName
        } catch (_: Throwable) {
            null
        }

    /** `Lost City <version> (<build>[, debug]) on <maker> <model>, Android <release> (API <n>), WebView <v>, pid <pid>` */
    fun launchLine(): String =
        "Lost City $version ($build${if (isDebug) ", debug" else ""}) on ${Build.MANUFACTURER} $deviceModel, " +
            "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}), WebView ${webViewVersion ?: "none"}, pid ${Process.myPid()}"

    /** Whether the phone can vibrate (the emulator cannot). */
    fun canVibrate(context: Context): Boolean = try {
        context.getSystemService(Vibrator::class.java)?.hasVibrator() == true
    } catch (_: Throwable) {
        false
    }

    /** The object injected as `window.LostCityNative` (keys sorted when it is encoded). */
    fun pageInfo(context: Context, settings: JsonObject, lm: JsonObject): JsonObject = buildJsonObject {
        put("platform", JsonPrimitive("android"))
        put("appVersion", JsonPrimitive(version))
        put("build", JsonPrimitive(build))
        put("osVersion", JsonPrimitive(Build.VERSION.RELEASE ?: "?"))
        put("sdkInt", JsonPrimitive(Build.VERSION.SDK_INT))
        put("deviceModel", JsonPrimitive(deviceModel))
        put("manufacturer", JsonPrimitive(Build.MANUFACTURER ?: "?"))
        put("simulator", JsonPrimitive(false))
        put("emulator", JsonPrimitive(isEmulator))
        put("debug", JsonPrimitive(isDebug))
        put("webView", JsonPrimitive(webViewVersion ?: "none"))
        put("haptics", JsonPrimitive(canVibrate(context)))
        put("settings", settings)
        put("lm", lm)
    }
}
