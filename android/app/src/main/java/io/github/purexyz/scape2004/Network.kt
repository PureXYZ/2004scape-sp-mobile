// Network: how native code reaches a game server (docs/ANDROID.md §7): one OkHttp client for the proxy's fetches
// (OnlineProxy) and the page's WebSockets (SocketBridge), and Android 17's local network access (LocalNetwork).
//
// * OkHttp, as the iOS app has URLSession for both: a WebSocket client Android does not have, and the same connection
//   pool, timeouts and TLS for the HTTP files. No cookies (OkHttp keeps none unless given a jar), no HTTP cache (the
//   archives are cached by CRC in OnlineProxy), no pings (nothing is kept alive in the background), the app's User-Agent
//   (`2004Scape/<version> (Android <release>)`) and no Origin (the app does not pose as any web site).
// * Cleartext is allowed (res/xml/network_security_config.xml): a server on a home network is plain http/ws.
// * Android 17 (API 37) has a runtime permission for the local network, ACCESS_LOCAL_NETWORK, and an app that targets
//   it does not get through to a device on the local network until the player allows it (measured on the API 37
//   emulator: the connection times out, no EPERM). So native asks first, before it connects to a local address (a
//   private, link-local or unique-local IP literal, a `.local` name): when the Add server box gives one, and when a page
//   load plays on one (OnlineComponent). A connection that still fails that way (a name that resolves to a local
//   address, the prompt refused) counts as the system's refusal, a timeout from a local address or EPERM from any:
//   native asks then (once a page load), says why in a notice, and reports the attempt with the words `local network`.
//   A server on the internet or the phone itself never needs it.
package io.github.purexyz.scape2004

import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

object Network {
    /** `2004Scape/<version> (Android <release>)`: what the app's requests to a game server say they are. */
    val userAgent: String get() = "2004Scape/${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.RELEASE ?: "?"})"

    /** The app's client; the proxy sets a call timeout per request, the bridge its own open timer. */
    val client: OkHttpClient by lazy { client(userAgent) }

    fun client(userAgent: String): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .pingInterval(0, TimeUnit.MILLISECONDS)
        .addInterceptor { chain -> chain.proceed(chain.request().newBuilder().header("User-Agent", userAgent).build()) }
        .build()

    /** The phone has a network that reaches the internet (Wi-Fi, mobile data); false in airplane mode, say. */
    fun hasNetwork(context: Context): Boolean {
        val connectivity = context.getSystemService(ConnectivityManager::class.java) ?: return true
        val capabilities = runCatching { connectivity.getNetworkCapabilities(connectivity.activeNetwork) }.getOrElse { return true } ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
}

/** Android 17's local network access, as the proxy and the socket bridge see it. */
interface LocalNetwork {
    /**
     * The connection to `host` failed because the system refused the local network (the permission not granted, and
     * EPERM, or a local address that timed out). Then the player is asked for it (once a page load) and told
     * why.
     */
    fun refused(host: String, error: Throwable): Boolean

    /** Before Android 17, and in the JVM tests: never. */
    object None : LocalNetwork {
        override fun refused(host: String, error: Throwable) = false
    }

    companion object {
        /** The error word (socket `error`, 502 body, probe `error`). */
        const val WORDS = "local network"

        /**
         * A host on the local network, as Android counts it: an IPv4 literal in 10/8, 172.16/12, 192.168/16 or 169.254/16,
         * an IPv6 literal in fc00::/7 or fe80::/10, or an mDNS `.local` name. (Loopback is the phone itself; a name that
         * resolves to a local address cannot be told without resolving it, and EPERM still says so.)
         */
        fun isLocalHost(host: String): Boolean {
            val name = host.lowercase().trimEnd('.')
            if (name.endsWith(".local")) return true
            val v4 = name.split('.').takeIf { it.size == 4 }?.map { it.toIntOrNull() ?: return false }
            if (v4 != null) {
                if (v4.any { it !in 0..255 }) return false
                return v4[0] == 10 || (v4[0] == 172 && v4[1] in 16..31) || (v4[0] == 192 && v4[1] == 168) || (v4[0] == 169 && v4[1] == 254)
            }
            if (!name.contains(':')) return false
            val first = name.substringBefore(':').ifEmpty { "0" }.toIntOrNull(16) ?: return false
            return first and 0xfe00 == 0xfc00 || first and 0xffc0 == 0xfe80
        }

        /**
         * What the system's refusal looks like without the permission: EPERM, or a local address that timed out (a
         * local server that is up but not listening refuses at once, and stays "refused").
         */
        fun blocks(host: String, error: Throwable): Boolean =
            looksRefused(error) || (isLocalHost(host) && error is java.io.InterruptedIOException)

        /** An exception whose cause chain is the system's refusal: EPERM ("Operation not permitted") or a SecurityException. */
        fun looksRefused(error: Throwable): Boolean {
            var cause: Throwable? = error
            var depth = 0
            while (cause != null && depth++ < 8) {
                if (cause is SecurityException) return true
                val message = cause.message ?: ""
                if (message.contains("EPERM") || message.contains("Operation not permitted")) return true
                cause = cause.cause
            }
            return false
        }
    }
}

/** The app's LocalNetwork: `onRefused(host)` runs (on any thread) when a connection was refused for want of it. */
class AndroidLocalNetwork(private val context: Context, private val onRefused: (String) -> Unit) : LocalNetwork {
    /** Whether this Android has the permission at all (API 37). */
    val exists: Boolean get() = Build.VERSION.SDK_INT >= 37

    val granted: Boolean
        get() = !exists || context.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED

    /** A connection to `host` needs the permission first: a local address while it is not granted. */
    fun needsAsking(host: String): Boolean = !granted && LocalNetwork.isLocalHost(host)

    override fun refused(host: String, error: Throwable): Boolean {
        if (granted) return false
        val blocked = LocalNetwork.blocks(host, error)
        if (blocked) onRefused(host)
        return blocked
    }

    companion object {
        /** Manifest.permission.ACCESS_LOCAL_NETWORK (API 37; a string here, so older releases never look it up). */
        const val PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
    }
}
