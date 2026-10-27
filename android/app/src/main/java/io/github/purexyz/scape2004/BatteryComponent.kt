// BatteryComponent: the phone's battery for the HUD's top left corner (the status bar is hidden), as iOS's
// GameViewController.reportBattery: `LostCityHost.battery(level, charging)` when the page is ready and at each change.
// The readings come from the sticky ACTION_BATTERY_CHANGED broadcast while the activity is started (registering hands
// back the current one at once). It comes with every change of voltage or temperature too, so only a new percentage or
// a plug change reaches the page. `charging` is "on the charger" (EXTRA_PLUGGED), as iOS's charging or full.
package io.github.purexyz.scape2004

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import kotlinx.serialization.json.JsonPrimitive

class BatteryComponent(private val session: GameSession, private val app: Context) : SessionComponent {
    private data class Reading(val percent: Int, val charging: Boolean)

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = read(intent)
    }
    private var registered = false
    private var pageReady = false
    private var last: Reading? = null

    /** What this page was last told, null until it was told anything. */
    private var sent: Reading? = null

    override fun start() {
        if (registered) return
        registered = true
        // (a system broadcast only: no RECEIVER_EXPORTED / NOT_EXPORTED flag, as Android 14 allows for those)
        app.registerReceiver(receiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED))?.let(::read)
    }

    override fun stop() {
        if (!registered) return
        registered = false
        app.unregisterReceiver(receiver)
    }

    override fun pageReset() {
        pageReady = false
        sent = null
    }

    override fun pageReady() {
        pageReady = true
        send()
    }

    private fun read(intent: Intent) {
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        if (level < 0 || scale <= 0) return
        val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
        last = Reading(Math.round(level * 100f / scale).coerceIn(0, 100), plugged)
        send()
    }

    private fun send() {
        val reading = last ?: return
        if (!pageReady || reading == sent) return
        sent = reading
        session.page.call("battery", listOf(JsonPrimitive(reading.percent / 100.0), JsonPrimitive(reading.charging)))
    }
}
