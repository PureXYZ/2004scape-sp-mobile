// The on-device model's last load time across launches (:botchat's ModelLoadRecord, the status's `local.lastLoadMs`; the
// iOS app keeps it in UserDefaults: ModelLoadRecord in ios/LostCity/BotChatModel.swift): SharedPreferences
// `lostcity-lm`, with the app's version and the system's build it was measured under, so an app or system update (or a
// backup restored on another phone) starts without one.
package io.github.purexyz.scape2004.llm

import android.content.Context
import android.os.Build
import io.github.purexyz.scape2004.botchat.ModelLoadRecord

class AndroidLoadRecord(context: Context, private val versions: String = currentVersions(context)) : ModelLoadRecord {
    private val prefs = context.applicationContext.getSharedPreferences("lostcity-lm", Context.MODE_PRIVATE)

    override val lastLoadMs: Double?
        get() = prefs.getLong(MS, 0).takeIf { it > 0 && prefs.getString(VERSIONS, null) == versions }?.toDouble()

    override fun record(ms: Double) {
        prefs.edit().putString(VERSIONS, versions).putLong(MS, Math.round(ms)).apply()
    }

    companion object {
        private const val VERSIONS = "lastLoad.versions"
        private const val MS = "lastLoad.ms"

        /** e.g. "1.0.0 (10000), google/sdk_gphone64_arm64/emu64a:17/..." */
        fun currentVersions(context: Context): String {
            val info = try {
                context.packageManager.getPackageInfo(context.packageName, 0)
            } catch (_: Throwable) {
                null
            }
            return "${info?.versionName ?: "?"} (${info?.longVersionCode ?: 0}), ${Build.FINGERPRINT}"
        }
    }
}
