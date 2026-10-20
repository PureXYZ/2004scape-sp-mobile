// The bots' chat model as the Android app wires it in (docs/ARCHITECTURE.md §7.1, docs/ANDROID.md §1 Bot chat): the iOS
// GameViewController's §7.1 glue around :botchat's BotChatModel, with the Android
// pieces: the key store (AndroidModelKeyStore), the thermal gate, the model asset (ModelAssets), the key's secure box
// (KeyEntryDialog), the bench's device stats. The app (the shell, GameSession) owns the page, the keyboard, the haptics and
// the lifecycle; it calls this and hears back through [Host]:
//
//   val botChat = AndroidBotChat.create(context, log = lcLogSink, debug = BuildConfig.DEBUG)   // on the main thread
//   botChat.host = object : AndroidBotChat.Host { ... }                                        // before the first page load
//   window.LostCityNative.lm = botChat.status (document start; reinstalled when Host.lmStatus is called)
//   page → native  {type:'lm'|'lm-warm'|'lm-key'} and, in debug builds, {type:'lm-bench'}: botChat.dispatch(message)
//                  {type:'debug', action:'lm-status'|'lm-endpoint'|'lm-key-alert'}: botChat.debugAction(id, action, message)
//   lifecycle      onPause → pause(), onStop → suspend(), onResume → resume(), onTrimMemory/onLowMemory → memoryWarning()
//   every page load and reload (resetPageState, onRenderProcessGone's reload) → pageReset()
//
// Main thread only, every method (the iOS glue is @MainActor; WebMessageListener calls back on the main thread).
package io.github.purexyz.scape2004.llm

import android.app.Activity
import android.content.Context
import android.content.pm.ApplicationInfo
import io.github.purexyz.scape2004.botchat.BotChatModel
import io.github.purexyz.scape2004.botchat.JsonBridge
import io.github.purexyz.scape2004.botchat.LlmJni
import io.github.purexyz.scape2004.botchat.LocalModel
import io.github.purexyz.scape2004.botchat.LogSink
import io.github.purexyz.scape2004.botchat.ModelKeyStore
import io.github.purexyz.scape2004.botchat.OnlineModel
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.net.URI

class AndroidBotChat private constructor(
    private val context: Context,
    /** The router itself (status, counters, the online model's endpoint, the local model's options and state). */
    val model: BotChatModel,
    val keyStore: ModelKeyStore,
    val thermal: ThermalGate,
    private val log: LogSink,
    /** Debug builds: the debug actions, lm-bench, the sideloaded model. */
    val debug: Boolean,
) {
    /** What the shell gives the bot chat. */
    interface Host {
        /** `LostCityHost.bots.lmReply(reply)`: native's answer to a `{type:'lm'}`. */
        fun lmReply(reply: JsonObject)

        /**
         * The status changed: reinstall the document-start script first (a reload must see `window.LostCityNative.lm` =
         * [status]), then `LostCityHost.bots.lmStatus(status)`.
         */
        fun lmStatus(status: JsonObject)

        /** The activity to show the key's box over, or null when there is none in the foreground (the box is not shown). */
        fun activity(): Activity?

        /** The keyboard bridge lends its input focus while the box is up (true) and has it back after (false). */
        fun lendKeyboardFocus(lend: Boolean)

        /** After the box: the keyboard bridge takes the keyboard again (iOS keyboard.activate()). */
        fun activateKeyboard()

        /** The error haptic (a refused key), as Settings › Vibration allows. */
        fun errorHaptic()

        /** Debug builds: `window.__lcDebugReply(id, value)`. */
        fun debugReply(id: Int, value: JsonElement) {}

        /** The WebView renderer's terminations since launch (the bench's stats). */
        fun terminations(): Int = 0
    }

    var host: Host? = null

    /** The key's secure box while it is up. */
    var keyDialog: KeyEntryDialog? = null
        private set

    init {
        model.thermal = thermal
        model.onReply = { reply -> host?.lmReply(JsonBridge.toJsonObject(reply)) }
        model.onStatus = { status -> host?.lmStatus(JsonBridge.toJsonObject(status)) }
    }

    /** `window.LostCityNative.lm` and what `lmStatus` sends: `{local: {...}, online: {...}}` (docs/ARCHITECTURE.md §7.1). */
    val status: JsonObject get() = JsonBridge.toJsonObject(model.status)

    // ------------------------------------------------------------------------------------------------ page → native

    /**
     * A page message of the bot chat's: `lm`, `lm-warm`, `lm-key`, and in debug builds `lm-bench`. False when the type is not
     * one of these (the shell handles it, or logs it as unhandled).
     */
    fun dispatch(message: JsonObject): Boolean {
        val values = JsonBridge.toMap(message)
        when (values["type"] as? String) {
            "lm" -> model.handle(values)
            "lm-warm" -> model.warm()
            "lm-key" -> keyAction(values["action"] as? String ?: "")
            "lm-bench" -> if (debug) bench(values) else return false
            else -> return false
        }
        return true
    }

    /** `{type:'lm'}`: a reply for the router to write (answered through [Host.lmReply]). */
    fun handle(message: JsonObject) = model.handle(JsonBridge.toMap(message))

    /** `{type:'lm-warm'}`: the player entered the world with the on-device model chosen. */
    fun warm() = model.warm()

    /**
     * `{type:'lm-key', action}`: `set` opens the secure box for the Claude key (the page never sees the key), `remove`
     * deletes it. The page hears the outcome as a status.
     */
    fun keyAction(action: String) {
        when (action) {
            "set" -> presentKeyDialog()
            "remove" -> model.removeKey()
            else -> log.info("lm", "unknown lm-key action: $action")
        }
    }

    // ------------------------------------------------------------------------------------------------------ lifecycle

    /** Activity.onPause (iOS willResignActive): the reply being written stops; the model stays loaded. */
    fun pause() = model.pause()

    /** Activity.onStop (iOS didEnterBackground): as pause, and the model is freed. */
    fun suspend() = model.suspend()

    /** Activity.onResume (iOS didBecomeActive). */
    fun resume() = model.resume()

    /** onTrimMemory / onLowMemory (iOS's memory warning): the model is freed. */
    fun memoryWarning() = model.memoryWarning()

    /** Every page load and reload: answers still being written for the old page are dropped. */
    fun pageReset() = model.pageReset()

    // -------------------------------------------------------------------------------------------------- the key's box

    private fun presentKeyDialog() {
        // (one box at a time; a box whose activity went away without closing it does not block the next one)
        if (keyDialog?.dialog?.isShowing == true) return
        keyDialog = null
        val host = host ?: return
        val activity = host.activity()?.takeIf { !it.isFinishing && !it.isDestroyed } ?: run {
            log.info("lm", "the Claude key box needs the game in the foreground")
            return
        }
        val box = KeyEntryDialog(activity) { typed -> keyDialogClosed(typed) }
        host.lendKeyboardFocus(true)  // (the bridge never gives up its focus otherwise)
        keyDialog = box
        box.show()
    }

    private fun keyDialogClosed(typed: String?) {
        keyDialog = null
        host?.lendKeyboardFocus(false)
        host?.activateKeyboard()
        if (typed == null) return
        if (!model.setKey(typed)) {
            model.keyProblem("not a key")
            host?.errorHaptic()
        }
    }

    // ------------------------------------------------------------------------------------------------- debug builds

    /**
     * The debug actions of the bot chat's (`{type:'debug', id, action, …}`, debug builds): `lm-status`, `lm-endpoint` (point
     * Claude at a local mock: the tests never call the real API), `lm-key-alert` (type into the key's box and press Save or
     * Cancel). Replies through [Host.debugReply]. False when the action is not one of these.
     */
    fun debugAction(id: Int, action: String, message: JsonObject): Boolean {
        if (!debug) return false
        val values = JsonBridge.toMap(message)
        val reply: Any? = when (action) {
            "lm-status" -> linkedMapOf("status" to model.status, "counters" to model.counters)
            "lm-endpoint" -> {
                // (the online model's endpoint, for the tests' local mock server, never with a real key; none: the API's)
                val url = (values["url"] as? String)?.takeIf { runCatching { URI(it).toURL() }.isSuccess } ?: OnlineModel.DEFAULT_ENDPOINT
                model.online.endpoint = url
                url
            }
            "lm-key-alert" -> {
                // the key's box as the player would use it: the text typed in, then Save or Cancel
                val box = keyDialog
                if (box == null) {
                    mapOf("shown" to false)
                } else {
                    val shown = linkedMapOf<String, Any?>("shown" to true, "secure" to box.secure, "title" to box.title, "firstResponder" to box.field.hasFocus())
                    box.field.setText(values["text"] as? String ?: "")
                    if (values["button"] as? String == "cancel") box.pressCancel() else box.pressSave()
                    shown
                }
            }
            else -> return false
        }
        host?.debugReply(id, JsonBridge.toJson(reply))
        return true
    }

    /**
     * `{type:'lm-bench', id, action, …}` (debug builds; the phone bench: web/test/autotest.js lm-bench, app-test --lm-bench):
     * `generate` {system, user, think?, timeoutMs} runs the on-device model directly and answers the line, its timings and its
     * note; `stats` the app's memory, battery and heat, the model's state and note support, its last load and the renderer's
     * terminations (iOS's keys; Android's extras beside them); `options` {threads, gpuLayers, idleSec, repack, mmap} applies
     * to the next load (the model is unloaded); `unload`. Replies through [Host.debugReply].
     */
    private fun bench(message: Map<String, Any?>) {
        val id = (message["id"] as? Number)?.toInt() ?: 0
        val local = model.local
        fun reply(value: Any?) = host?.debugReply(id, JsonBridge.toJson(value))
        when (message["action"] as? String) {
            "generate" -> {
                val timeoutMs = (message["timeoutMs"] as? Number)?.toInt() ?: BotChatModel.DEFAULT_TIMEOUT_MS
                local.generate(message["system"] as? String ?: "", message["user"] as? String ?: "", message["think"] as? Boolean ?: false,
                    System.nanoTime() + timeoutMs * 1_000_000L) { result ->
                    val output = result.getOrNull()
                    if (output != null) {
                        val out = linkedMapOf<String, Any?>("text" to output.text, "timings" to output.timings.dictionary)
                        output.note?.let { out["note"] = it }
                        reply(out)
                    } else {
                        reply(mapOf("error" to ((result.exceptionOrNull() as? LocalModel.Failure)?.description ?: "failed: ${result.exceptionOrNull()}")))
                    }
                }
            }
            "stats" -> {
                val options = local.options
                reply(linkedMapOf(
                    "battery" to DeviceStats.battery(context),
                    "footprintMB" to DeviceStats.footprintMB(),
                    "availableMB" to DeviceStats.availableMB(context),
                    "thermal" to thermal.level().iosName,
                    "lowPower" to DeviceStats.lowPower(context),
                    "loaded" to local.isLoaded,
                    "think" to local.thinkSupport.raw,
                    "queued" to local.queued,
                    "terminations" to (host?.terminations() ?: 0),
                    "options" to linkedMapOf("threads" to options.threads, "gpuLayers" to options.gpuLayers, "idleSec" to options.idleUnloadMs / 1000.0),
                    "lastLoad" to local.lastLoad,
                    // Android's extras (the bench's gates ignore them)
                    "thermalStatus" to thermal.status(),
                    "thermalHeadroom" to thermal.headroom().toDouble().takeIf { !it.isNaN() },
                    "cpuVariant" to local.cpuVariant,
                    "mmap" to local.mapped,
                    "repack" to options.repack,
                ))
            }
            "options" -> {
                var options = local.options
                (message["threads"] as? Number)?.toInt()?.let { options = options.copy(threads = it, batchThreads = it) }
                (message["gpuLayers"] as? Number)?.toInt()?.let { options = options.copy(gpuLayers = it) }
                (message["idleSec"] as? Number)?.toDouble()?.let { options = options.copy(idleUnloadMs = (it * 1000).toLong()) }
                (message["repack"] as? Boolean)?.let { options = options.copy(repack = it) }
                (message["mmap"] as? Number)?.toInt()?.let { options = options.copy(mmap = it) }
                local.options = options
                if (listOf("threads", "gpuLayers", "repack", "mmap").any { message.containsKey(it) }) {
                    local.unload("bench options")
                }
                reply(linkedMapOf("threads" to options.threads, "gpuLayers" to options.gpuLayers, "idleSec" to options.idleUnloadMs / 1000.0))
            }
            "unload" -> {
                local.unload("bench")
                reply(true)
            }
            else -> host?.debugReply(id, JsonNull)
        }
    }

    companion object {
        /**
         * Makes the bot chat (main thread; before the first page load, since `window.LostCityNative.lm` needs its status).
         * Nothing native runs yet beyond loading liblcllm: llama.cpp starts at the first request or warm-up.
         */
        fun create(context: Context, log: LogSink = AndroidLog, debug: Boolean = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0): AndroidBotChat {
            val app = context.applicationContext
            val native = if (LlmJni.loaded) {
                LlmJni
            } else {
                log.info("lm", "the on-device model's library did not load: ${LlmJni.loadError}")
                null
            }
            val local = LocalModel(ModelAssets.load(app, log, debug), native, MainThread, log) { DeviceStats.headroomBytes(app) }
            val keyStore = AndroidModelKeyStore(app, log)
            val model = BotChatModel(local, OnlineModel(MainThread), keyStore, log)
            return AndroidBotChat(app, model, keyStore, ThermalGate(app), log, debug)
        }
    }
}
