// OnlineComponent: online mode's page messages in the app (ports the §7.2-7.5 half of ios/LostCity/GameViewController.swift:
// makeSockets, handleAccount, handleServer, presentServerAlert/serverAlertClosed and the online debug actions;
// docs/ARCHITECTURE.md §7.2-7.5, docs/ANDROID.md §7).
//
// * `{type:'socket'}` → SocketBridge (its events go back through `LostCityHost.socket.events`); every page reset closes
//   the page's sockets.
// * `{type:'account', action, server, name, password?}`: `save-password` (after a login that worked, with Remember on),
//   `forget-password`, and `login` (answered with `LostCityHost.accounts.login(name, password | null)`). Which names have
//   a password goes to the page at document start (`LostCityNative.savedPasswords`, GameSession.refreshInfo) and after
//   every change (`LostCityHost.accounts.saved`). Passwords are never logged.
// * `{type:'server', action, …}`: `use` (store the choice, close the page's sockets, reload with the right cover),
//   `delete` (the server's cache and remembered passwords; the page removes its entry), `ask` (the Add / Edit box,
//   ServerDialog, answered with `LostCityHost.servers.answer({address, name} | null)`).
// * Android 17's local network permission (Network.kt): when a connection was refused for want of it, a notice says why
//   and the system asks the player (once a page load).
// * DEBUG actions (iOS's names): `server-alert {address?, name?, button?}` (what the box shows, then filled and closed
//   like a tap), `online-state`, `online-cache {op?: 'corrupt', path?}`, `last-notice`, `url-normalize {inputs}`
//   (native's address rules over the shared vectors); Android's own `local-network` (whether the permission exists and
//   is granted).
//
// UI thread only, as GameViewController is @MainActor.
package io.github.purexyz.scape2004

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.File

class OnlineComponent private constructor(private val session: GameSession) : SessionComponent {
    val sockets = SocketBridge(MainScheduler, { events -> session.page.call("socket.events", listOf(events)) }, localNetwork = session.localNetwork,
        hasNetwork = session::hasNetwork)
        .apply { server = { session.online.server } }

    /** The Add / Edit server box while it is up. */
    private var serverDialog: ServerDialog? = null
    private var focusLend: AutoCloseable? = null

    /** The local network permission was asked for on this page load already. */
    private var askedLocalNetwork = false

    override fun pageReset() {
        sockets.reset()
        askedLocalNetwork = false
    }

    override fun detach(activity: GameActivity) {
        // (a dialog goes with its activity's window, and its dismiss listener would not run: closed here, as Cancel)
        val box = serverDialog ?: return
        if (box.dialog.ownerActivity === activity) {
            Log.info("online", "the server box closed with its activity")
            box.pressCancel()
        }
    }

    // ------------------------------------------------------------------------------------------------ accounts

    private fun handleAccount(message: JsonObject) {
        val action = message.string("action") ?: ""
        val server = message.string("server") ?: ""
        val name = message.string("name") ?: ""
        val known = OnlineServer.entry(server, session.settings.values) != null && ServerPasswordStore.isValid(name)
        when (action) {
            "save-password" -> {
                val password = message.string("password")
                if (!known || password == null || !ServerPasswordStore.isValid(name, password)) {
                    Log.info("accounts", "save-password refused: not a server in the settings, or not a name and password the game takes")
                    return
                }
                if (session.passwords.save(server, name, password)) {
                    Log.info("accounts", "remembered the password of $name on $server")
                    passwordsChanged()
                }
            }
            "forget-password" -> {
                if (!OnlineServer.isValidId(server) || name.isEmpty()) return
                session.passwords.remove(server, name)
                Log.info("accounts", "forgot the password of $name on $server")
                passwordsChanged()
            }
            "login" -> {
                val password = if (known) session.passwords.read(server, name) else null
                Log.info("accounts", "login as $name on $server: ${if (password == null) "no stored password" else "the stored password"}")
                session.page.call("accounts.login", listOf(JsonPrimitive(name), password?.let(::JsonPrimitive) ?: JsonNull))
            }
            else -> Log.info("accounts", "unknown account action: $action")
        }
    }

    /** A password was remembered or forgotten: the page hears it now (`accounts.saved`), and a reload at document start. */
    private fun passwordsChanged() {
        session.refreshInfo()
        session.page.call("accounts.saved", listOf(session.savedPasswordsJson()))
    }

    // ------------------------------------------------------------------------------------------------ servers

    private fun handleServer(message: JsonObject) {
        val id = message.string("id") ?: ""
        when (message.string("action")) {
            "use" -> {
                if (id != "offline" && OnlineServer.entry(id, session.settings.values) == null) {
                    Log.info("online", "server use $id: not a server in the settings; ignored")
                    return
                }
                session.settings.merge(buildJsonObject { put("server", JsonPrimitive(id)) })
                session.refreshInfo()
                sockets.reset()
                session.loadGame(if (id == "offline") "play offline" else "play on server $id")
            }
            "delete" -> {
                if (!OnlineServer.isValidId(id)) return
                val online = session.online
                Thread({ online.deleteCache(id) }, "online-delete").start()
                val removed = session.passwords.removeAll(id)
                Log.info("online", "server $id deleted ($removed remembered password${if (removed == 1) "" else "s"})")
                passwordsChanged()
            }
            "ask" -> presentServerDialog(message.string("title") ?: "Add server", message.string("address") ?: "", message.string("name") ?: "")
            else -> Log.info("online", "unknown server action: ${message.string("action") ?: "none"}")
        }
    }

    /** The Add / Edit server box over the game's activity; with no activity in front, the answer is Cancel's. */
    private fun presentServerDialog(title: String, address: String, name: String) {
        if (serverDialog != null) return
        val activity = session.activity
        if (activity == null) {
            Log.info("online", "server box: no activity to show it over; answered as Cancel")
            session.page.call("servers.answer", listOf(JsonNull))
            return
        }
        val box = ServerDialog(activity, title, address, name) { typed -> serverDialogClosed(typed) }
        box.dialog.setOwnerActivity(activity)
        serverDialog = box
        focusLend = session.keyboardFocus?.lend()
        activity.presenting(box.dialog)
        box.show()
        Log.info("online", "server box: $title")
    }

    private fun serverDialogClosed(typed: Pair<String, String>?) {
        val box = serverDialog
        serverDialog = null
        (box?.dialog?.ownerActivity as? GameActivity)?.presenting(null)
        focusLend?.close() // (the keyboard bridge takes its focus back and shows the game's keyboard again if it was up)
        focusLend = null
        // (a local address: Android 17's permission first, so the page's probe of it can get through)
        val host = typed?.first?.let(OnlineServer::normalize)?.let { OnlineServer("probe", it, it).host }
        askLocalNetwork(host) { answerServerBox(typed) }
    }

    private fun answerServerBox(typed: Pair<String, String>?) {
        val answer: JsonElement = typed?.let { (address, name) ->
            buildJsonObject {
                put("address", JsonPrimitive(address))
                put("name", JsonPrimitive(name))
            }
        } ?: JsonNull
        session.page.call("servers.answer", listOf(answer))
    }

    // ------------------------------------------------------------------------------------------------ local network

    /**
     * Before a connection to `host`: when it is a local address and the permission is not granted, the notice and the
     * system's prompt (once a page load), then `then` whatever the answer; else `then` at once.
     */
    fun askLocalNetwork(host: String?, then: () -> Unit) {
        val activity = session.activity
        if (host == null || activity == null || !session.localNetwork.needsAsking(host) || askedLocalNetwork) {
            then()
            return
        }
        askedLocalNetwork = true
        Log.info("online", "$host is on the local network: asking for the permission first")
        session.cover.notice(LOCAL_NETWORK_NOTICE)
        activity.requestPermission(AndroidLocalNetwork.PERMISSION) { granted ->
            Log.info("online", "local network permission ${if (granted) "granted" else "refused"}")
            then()
        }
    }

    /** A connection was refused for want of the local network permission (any thread). */
    fun localNetworkRefused(host: String) = MainScheduler.post {
        Log.info("online", "the system refused the local network ($host): the permission is not granted")
        if (askedLocalNetwork) return@post
        askedLocalNetwork = true
        session.cover.notice(LOCAL_NETWORK_NOTICE)
        session.activity?.requestPermission(AndroidLocalNetwork.PERMISSION) { granted ->
            Log.info("online", "local network permission ${if (granted) "granted" else "refused"}")
        }
    }

    // ------------------------------------------------------------------------------------------------ debug

    private fun debugServerAlert(message: JsonObject, reply: (JsonElement?) -> Unit) {
        val box = serverDialog
        if (box == null) {
            reply(buildJsonObject { put("shown", JsonPrimitive(false)) })
            return
        }
        reply(buildJsonObject {
            put("shown", JsonPrimitive(true))
            put("title", JsonPrimitive(box.title))
            put("address", JsonPrimitive(box.addressField.text.toString()))
            put("name", JsonPrimitive(box.nameField.text.toString()))
            put("placeholders", JsonArray(box.placeholders.map(::JsonPrimitive)))
        })
        message.string("address")?.let { box.addressField.setText(it) }
        message.string("name")?.let { box.nameField.setText(it) }
        if (message.string("button") == "cancel") box.pressCancel() else box.pressOk()
    }

    private fun debugCache(message: JsonObject): JsonElement {
        val root = session.online.cacheRoot
        if (message.string("op") == "corrupt") {
            val path = message.string("path") ?: return JsonPrimitive(false)
            if (path.contains("..")) return JsonPrimitive(false)
            return JsonPrimitive(runCatching { File(root, path).writeText("junk") }.isSuccess)
        }
        val files = root.walkTopDown().filter { it.isFile && !it.name.startsWith(".") }.map { it.relativeTo(root).path }.sorted().toList()
        return JsonArray(files.map(::JsonPrimitive))
    }

    companion object {
        /** Shown when Android 17 refused a server on the local network (the system's own prompt follows). */
        const val LOCAL_NETWORK_NOTICE = "To reach a server on your network, allow 2004Scape to find and connect to devices on your local network."

        /** What GameSession's init calls: the component, its page messages and debug actions. */
        fun install(session: GameSession): OnlineComponent {
            val component = OnlineComponent(session)
            session.components += component
            // (a page load on a local server: the permission first, so its first requests get through)
            session.beforeLoad = { server, load -> component.askLocalNetwork(server?.host, load) }
            session.handle("socket", component.sockets::handle)
            session.handle("account", component::handleAccount)
            session.handle("server", component::handleServer)
            if (BuildConfig.DEBUG) {
                session.debugAction("server-alert", component::debugServerAlert)
                session.debugAction("online-state") { _, reply ->
                    val server = session.online.server
                    reply(buildJsonObject {
                        put("server", server?.id?.let(::JsonPrimitive) ?: JsonNull)
                        put("url", server?.base?.let(::JsonPrimitive) ?: JsonNull)
                        put("sockets", JsonPrimitive(component.sockets.openCount))
                        put("caption", JsonPrimitive(LoadingCover.captionFor(session.cover.online)))
                        put("userAgent", JsonPrimitive(Network.userAgent))
                    })
                }
                session.debugAction("online-cache") { message, reply -> reply(component.debugCache(message)) }
                session.debugAction("url-normalize") { message, reply ->
                    val inputs = (message["inputs"] as? JsonArray)?.map { (it as? JsonPrimitive)?.content ?: "" } ?: emptyList()
                    reply(JsonArray(inputs.map { input -> OnlineServer.normalize(input)?.let(::JsonPrimitive) ?: JsonNull }))
                }
                session.debugAction("last-notice") { _, reply -> reply(session.cover.lastNotice?.let(::JsonPrimitive) ?: JsonNull) }
                session.debugAction("local-network") { _, reply ->
                    val access = session.localNetwork as? AndroidLocalNetwork
                    reply(buildJsonObject {
                        put("exists", JsonPrimitive(access?.exists == true))
                        put("granted", JsonPrimitive(access?.granted != false))
                    })
                }
            }
            return component
        }
    }
}
