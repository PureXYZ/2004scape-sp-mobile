// GameChromeClient: the page's browser chrome (the WKUIDelegate of GameViewController.swift).
//
// * Console: the main frame's console reaches the native log through the console bridge (NativeScripts), formatted as
//   on iOS. Chromium's own copy of every console line, also the World map frame's, is logged here with verbose on
//   (`[console:<level>]`), and never printed to logcat's "chromium" tag twice.
// * JS alert/confirm: a dark AlertDialog on top (OK / Cancel), as iOS presents a UIAlertController.
// * No fullscreen element, no geolocation, no camera or microphone, no file chooser; a new window (window.open, a
//   target=_blank link) opens an http(s) URL in the browser instead.
package io.github.purexyz.scape2004

import android.app.AlertDialog
import android.net.Uri
import android.os.Message
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView

class GameChromeClient(private val session: GameSession) : WebChromeClient() {
    override fun onConsoleMessage(message: ConsoleMessage): Boolean {
        Log.debug("console:${message.messageLevel().name.lowercase()}") {
            "${message.message()} (${message.sourceId()?.substringAfterLast('/')}:${message.lineNumber()})"
        }
        return true
    }

    override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
        val activity = session.activity ?: run {
            result.cancel()
            return true
        }
        AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setMessage(message)
            .setPositiveButton("OK") { _, _ -> result.confirm() }
            .setOnCancelListener { result.cancel() }
            .show()
        return true
    }

    override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
        val activity = session.activity ?: run {
            result.cancel()
            return true
        }
        AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setMessage(message)
            .setNegativeButton("Cancel") { _, _ -> result.cancel() }
            .setPositiveButton("OK") { _, _ -> result.confirm() }
            .setOnCancelListener { result.cancel() }
            .show()
        return true
    }

    override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?): Boolean {
        val url = view.hitTestResult.extra
        if (url != null && isUserGesture) {
            val uri = Uri.parse(url)
            if (uri.scheme == "http" || uri.scheme == "https") session.openExternally(uri)
        }
        return false
    }

    /** iOS: isElementFullscreenEnabled = false. */
    override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
        callback?.onCustomViewHidden()
    }

    override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) {
        callback?.invoke(origin, false, false)
    }

    override fun onPermissionRequest(request: PermissionRequest) {
        request.deny()
    }

    override fun onShowFileChooser(view: WebView?, callback: ValueCallback<Array<Uri>>?, params: FileChooserParams?): Boolean = false
}
