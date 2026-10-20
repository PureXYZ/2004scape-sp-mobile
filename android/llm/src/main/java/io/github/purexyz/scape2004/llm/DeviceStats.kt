// The app's memory, battery and heat, for the on-device model's bench (DEBUG builds' {type:'lm-bench', action:'stats'};
// web/test/autotest.js lmBenchChecks) and the logs: the iOS app's DeviceStats (ios/LostCity/BotChatModel.swift) and the
// battery part of GameViewController.handleModelBench. The keys are iOS's, so the bench's gates
// read the same on both phones; Android's own extras are added beside them.
package io.github.purexyz.scape2004.llm

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Debug
import android.os.PowerManager

object DeviceStats {
    /** The app process's proportional set size in MB (the model lives in this process, as on iOS; iOS: phys_footprint). */
    fun footprintMB(): Double {
        val info = Debug.MemoryInfo()
        Debug.getMemoryInfo(info)
        return info.totalPss / 1024.0
    }

    /** What the system still has free, in MB (iOS: os_proc_available_memory, the app's own headroom). */
    fun availableMB(context: Context): Double {
        val info = ActivityManager.MemoryInfo()
        context.getSystemService(ActivityManager::class.java)?.getMemoryInfo(info)
        return info.availMem / 1_048_576.0
    }

    /**
     * What the system can still give before it counts memory as low and starts ending apps (`availMem` above `threshold`),
     * in bytes: the on-device model's load check (iOS: os_proc_available_memory, the app's own headroom).
     */
    fun headroomBytes(context: Context): Long? {
        val manager = context.getSystemService(ActivityManager::class.java) ?: return null
        val info = ActivityManager.MemoryInfo()
        manager.getMemoryInfo(info)
        return (info.availMem - info.threshold).coerceAtLeast(0)
    }

    /** {level 0-1, state charging|full|unplugged|unknown}, as UIDevice's battery. */
    fun battery(context: Context): Map<String, Any?> {
        val intent: Intent? = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val state = when (intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1)) {
            BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
            BatteryManager.BATTERY_STATUS_FULL -> "full"
            BatteryManager.BATTERY_STATUS_DISCHARGING, BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "unplugged"
            else -> "unknown"
        }
        return linkedMapOf("level" to if (level >= 0 && scale > 0) level.toDouble() / scale else -1.0, "state" to state)
    }

    /** Battery saver (iOS: Low Power Mode). */
    fun lowPower(context: Context): Boolean = context.getSystemService(PowerManager::class.java)?.isPowerSaveMode ?: false
}
