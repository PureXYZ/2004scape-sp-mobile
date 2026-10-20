// PageBridge: native → page calls on `window.LostCityHost` (ports ios/LostCity/PageBridge.swift; ARCHITECTURE.md §7,
// docs/ANDROID.md §3.1). `call("keyboard.insertText", [text])` runs
// `await LostCityHost.keyboard.insertText(text)` in the page.
//
// iOS uses callAsyncJavaScript, which awaits what the call returns. Android's evaluateJavascript cannot await, so the page
// (host.js) defines `window.__lcCall(id, path, args)`: it resolves the dotted path on LostCityHost, awaits the result and,
// for an id above 0, posts {ch:'reply', id, ok:true, value} or {ch:'reply', id, ok:false, error} back to the app's
// `lcAndroid` listener (error 'missing' when there is no such function). GameSession hands those replies to onReply.
//
// * Order: evaluateJavascript runs scripts in the order they are posted on the page's main thread, which keeps keystrokes
//   in order, as WebKit's calls do on iOS.
// * id 0 is fire and forget (keystrokes): no reply is posted or waited for.
// * A page without `__lcCall` (still booting, or not our page) is Missing at once, like iOS's `.missing`.
// * Every call with a completion has its own timeout (30 s unless the caller gives one); the lifecycle coordinator keeps
//   its own, shorter one, as on iOS. A reload fails every pending call (`reset`), and ids never repeat within the process,
//   so a late reply from an old document can never complete a new call.
// * Calls are made on the UI thread (posted there when needed); replies arrive there from the WebMessageListener.
package io.github.purexyz.scape2004

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull

class PageBridge(private val scheduler: Scheduler, private val evaluator: () -> JsEvaluator?) {
    /** evaluateJavascript: `result` gets the script's value as JSON text, or null. */
    fun interface JsEvaluator {
        fun evaluate(script: String, result: (String?) -> Unit)
    }

    sealed interface Outcome {
        /** What the call returned (null for undefined/null). */
        data class Returned(val value: JsonElement?) : Outcome

        /** No LostCityHost function at that path (the page is still booting, or a test page). */
        data object Missing : Outcome

        data class Failed(val message: String) : Outcome

        /** "Nothing went wrong": a missing host has nothing to save or resume either. */
        val succeeded: Boolean get() = this !is Failed

        /**
         * `succeeded`, and for calls that answer `{ok, error}` (lifecycle), `ok` is not false: a page that could not write
         * a save resolves normally with `{ok: false}`.
         */
        val reportedSuccess: Boolean
            get() {
                if (!succeeded) return false
                val ok = ((this as? Returned)?.value as? JsonObject)?.get("ok") as? JsonPrimitive
                return ok?.takeIf { !it.isString }?.booleanOrNull ?: true
            }

        /** For log lines: `ok`, `ok → <compact sorted JSON>`, `no LostCityHost handler on the page`, `failed: <msg>`. */
        val description: String
            get() = when (this) {
                is Returned -> if (value == null) "ok" else "ok → ${JsonText.canonical(value)}"
                Missing -> "no LostCityHost handler on the page"
                is Failed -> "failed: $message"
            }
    }

    private class Pending(val path: String, val completion: (Outcome) -> Unit, val timeout: Cancellable)

    private var nextId = 1L
    private val pending = HashMap<Long, Pending>()

    /** `LostCityHost.<path>(...args)`; `completion` gets the outcome (none: fire and forget, id 0). */
    fun call(path: String, args: List<JsonElement> = emptyList(), timeoutMs: Long = DEFAULT_TIMEOUT_MS, completion: ((Outcome) -> Unit)? = null) {
        if (!scheduler.isMainThread()) {
            scheduler.post { call(path, args, timeoutMs, completion) }
            return
        }
        val script = { id: Long ->
            "(typeof window.__lcCall==='function'?(window.__lcCall($id,${JsonText.quote(path)},${JsonArray(args)}),1):0)"
        }
        send(path, script, timeoutMs, completion)
    }

    /**
     * Runs an async snippet (`await` allowed, its `return` value is the result) and reports the outcome the same way: the
     * loader-drawn check. The reply goes straight to `lcAndroid`, so it works before host.js has run.
     */
    fun run(asyncBody: String, timeoutMs: Long = DEFAULT_TIMEOUT_MS, completion: ((Outcome) -> Unit)? = null) {
        if (!scheduler.isMainThread()) {
            scheduler.post { run(asyncBody, timeoutMs, completion) }
            return
        }
        val script = { id: Long ->
            "(window.lcAndroid?((async()=>{let r;try{const v=await(async()=>{$asyncBody\n})();" +
                "r={ch:'reply',id:$id,ok:true,value:v===undefined?null:v}}catch(e){r={ch:'reply',id:$id,ok:false,error:String(e&&e.message||e)}}" +
                "if($id>0){try{window.lcAndroid.postMessage(JSON.stringify(r))}catch(e){}}})(),1):0)"
        }
        send("(script)", script, timeoutMs, completion)
    }

    /** A `{ch:'reply', id, ok, value|error}` message from the page. */
    fun onReply(message: JsonObject) {
        val id = (message["id"] as? JsonPrimitive)?.longOrNull ?: return
        val entry = pending.remove(id) ?: return // a page that has gone since, or answered after its timeout
        entry.timeout.cancel()
        val ok = (message["ok"] as? JsonPrimitive)?.booleanOrNull == true
        val outcome = when {
            ok -> Outcome.Returned(message["value"]?.takeIf { it !is JsonNull })
            message.string("error") == "missing" -> Outcome.Missing
            else -> Outcome.Failed(message["error"].display())
        }
        entry.completion(outcome)
    }

    /** The page went away (a reload, a new document, a renderer crash): every pending call fails with `reason`. */
    fun reset(reason: String) {
        if (pending.isEmpty()) return
        val calls = pending.values.toList()
        pending.clear()
        for (call in calls) {
            call.timeout.cancel()
            call.completion(Outcome.Failed(reason))
        }
    }

    /** Calls still waiting for the page (debug). */
    val pendingCount: Int get() = pending.size

    private fun send(path: String, script: (Long) -> String, timeoutMs: Long, completion: ((Outcome) -> Unit)?) {
        val web = evaluator()
        if (web == null) {
            completion?.invoke(Outcome.Failed("no web view"))
            return
        }
        if (completion == null) {
            web.evaluate(script(0)) { }
            return
        }
        val id = nextId++
        val timeout = scheduler.postDelayed(timeoutMs) {
            pending.remove(id)?.let {
                Log.info("host", "page call ${it.path} still unanswered after ${timeoutMs / 1000.0} s")
                it.completion(Outcome.Failed("no answer after ${timeoutMs / 1000.0} s"))
            }
        }
        pending[id] = Pending(path, completion, timeout)
        web.evaluate(script(id)) { result ->
            // "1": sent, the reply follows; "0": no __lcCall (or no lcAndroid) in this page; null: the page went away
            if (result == "1") return@evaluate
            val entry = pending.remove(id) ?: return@evaluate
            entry.timeout.cancel()
            entry.completion(if (result == "0") Outcome.Missing else Outcome.Failed("page gone"))
        }
    }

    companion object {
        const val DEFAULT_TIMEOUT_MS = 30_000L
    }
}
