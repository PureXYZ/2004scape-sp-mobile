// How hot the phone is, for the bots' on-device chat model (docs/ARCHITECTURE.md §7.1): iOS's
// ProcessInfo.thermalState, as BotChatModel reads it at each request and warm-up. Android's PowerManager thermal status
// (a binder call of about 0.1 ms) mapped to iOS's states, so BotChatModel's rule ("serious" and up: no on-device reply, the
// bots say their own lines; Claude online is not affected) and the bench's gate (autotest.js THERMAL) read the same:
//
//   THERMAL_STATUS_NONE                        nominal    runs
//   THERMAL_STATUS_LIGHT, MODERATE             fair       runs
//   THERMAL_STATUS_SEVERE                      serious    'busy'
//   THERMAL_STATUS_CRITICAL, EMERGENCY, SHUTDOWN  critical  'busy'
//
// SEVERE is where Android tells apps to cut back; it is to be calibrated on a real phone. The
// emulator always reports NONE; tests force a status with `adb shell cmd thermalservice override-status 3` (then `reset`).
package io.github.purexyz.scape2004.llm

import android.content.Context
import android.os.PowerManager
import io.github.purexyz.scape2004.botchat.ThermalLevel
import io.github.purexyz.scape2004.botchat.ThermalProvider

class ThermalGate(context: Context) : ThermalProvider {
    private val power: PowerManager? = context.getSystemService(PowerManager::class.java)

    /** PowerManager's raw status (THERMAL_STATUS_*). */
    fun status(): Int = power?.currentThermalStatus ?: PowerManager.THERMAL_STATUS_NONE

    override fun level(): ThermalLevel = levelOf(status())

    /** For the log line of a refused request: Android's own words ("thermal status severe"). */
    override fun describe(): String = "thermal status ${nameOf(status())}"

    /** How far from SEVERE the phone is forecast to be in 10 s (1.0 = at it), or NaN where it is not known (the bench). */
    fun headroom(): Float = power?.getThermalHeadroom(10) ?: Float.NaN

    companion object {
        fun levelOf(status: Int): ThermalLevel = when (status) {
            PowerManager.THERMAL_STATUS_NONE -> ThermalLevel.NOMINAL
            PowerManager.THERMAL_STATUS_LIGHT, PowerManager.THERMAL_STATUS_MODERATE -> ThermalLevel.FAIR
            PowerManager.THERMAL_STATUS_SEVERE -> ThermalLevel.SERIOUS
            else -> if (status > PowerManager.THERMAL_STATUS_SEVERE) ThermalLevel.CRITICAL else ThermalLevel.NOMINAL
        }

        fun nameOf(status: Int): String = when (status) {
            PowerManager.THERMAL_STATUS_NONE -> "none"
            PowerManager.THERMAL_STATUS_LIGHT -> "light"
            PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
            PowerManager.THERMAL_STATUS_SEVERE -> "severe"
            PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
            PowerManager.THERMAL_STATUS_EMERGENCY -> "emergency"
            PowerManager.THERMAL_STATUS_SHUTDOWN -> "shutdown"
            else -> "unknown ($status)"
        }
    }
}
