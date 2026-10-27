// RVHost (render-verify): a bare macOS WKWebView (the Mac's WebKit, the same engine version as the iPhone's) that loads
// the game page for web/test/render-verify/webkit.mjs. Built from the performance work's MacHost: an offscreen window
// with occlusion detection and hidden-page throttling off (private prefs, tests only), so the page runs as if visible.
//   RVHost <url> <inject.js> <width> <height> [user agent]
// The page gets <inject.js> at document start. Commands on stdin, one per line:
//   EVAL <id> <base64 JS function body>   callAsyncJavaScript (awaits a returned promise); answers
//                                         RES <id> <base64 JSON> or ERR <id> <base64 message>
//   RESIZE <id> <width> <height>          the window and the web view; answers RES <id>
//   SNAP <id> <path>                      a PNG of the web view; answers RES <id>
//   QUIT
// Also prints PID <WebContent pid>, and MSG <json> for what the page posts to webkit.messageHandlers.rv.
import AppKit
import WebKit

func out(_ s: String) {
    print(s)
    fflush(stdout)
}

func b64(_ s: String) -> String { Data(s.utf8).base64EncodedString() }

final class Host: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    let url: URL
    let inject: String
    var size: NSSize
    let ua: String?
    init(url: URL, inject: String, size: NSSize, ua: String?) {
        self.url = url
        self.inject = inject
        self.size = size
        self.ua = ua
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "rv")
        config.userContentController.addUserScript(WKUserScript(source: inject, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.mediaTypesRequiringUserActionForPlayback = []
        let prefs = config.preferences
        for name in ["_setHiddenPageDOMTimerThrottlingEnabled:", "_setHiddenPageDOMTimerThrottlingAutoIncreases:", "_setPageVisibilityBasedProcessSuppressionEnabled:"] {
            let sel = NSSelectorFromString(name)
            if prefs.responds(to: sel) { _ = prefs.perform(sel, with: nil) }
        }
        web = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
        web.navigationDelegate = self
        if let ua { web.customUserAgent = ua }
        let occ = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        if web.responds(to: occ) { _ = web.perform(occ, with: nil) }
        web.isInspectable = true
        window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = web
        window.orderFrontRegardless()
        web.load(URLRequest(url: url))
        out("LOADING \(url)")
        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in self?.reportPid() }
        Thread.detachNewThread { self.readCommands() }
    }

    var lastPid: Int32 = 0
    func reportPid() {
        guard let pid = web.value(forKey: "_webProcessIdentifier") as? Int32, pid != lastPid, pid > 0 else { return }
        lastPid = pid
        out("PID \(pid)")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { reportPid() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { out("TERMINATED") }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let data = try? JSONSerialization.data(withJSONObject: message.body, options: [.fragmentsAllowed]), let s = String(data: data, encoding: .utf8) { out("MSG \(s)") }
    }

    func readCommands() {
        while let line = readLine() {
            let parts = line.split(separator: " ", maxSplits: 2).map(String.init)
            guard let cmd = parts.first else { continue }
            DispatchQueue.main.async { self.run(cmd, parts) }
        }
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }

    func run(_ cmd: String, _ parts: [String]) {
        switch cmd {
        case "EVAL":
            guard parts.count == 3, let data = Data(base64Encoded: parts[2]), let body = String(data: data, encoding: .utf8) else { return }
            let id = parts[1]
            web.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success(let value):
                    out("RES \(id) \(b64((value as? String) ?? "null"))")
                case .failure(let error):
                    let e = error as NSError
                    let detail = (e.userInfo["WKJavaScriptExceptionMessage"] as? String) ?? e.localizedDescription
                    out("ERR \(id) \(b64(detail))")
                }
            }
        case "RESIZE":
            guard parts.count == 3 else { return }
            let wh = parts[2].split(separator: " ").compactMap { Double($0) }
            guard wh.count == 2 else { return }
            size = NSSize(width: wh[0], height: wh[1])
            window.setContentSize(size)
            web.frame = NSRect(origin: .zero, size: size)
            out("RES \(parts[1]) \(b64("true"))")
        case "SNAP":
            guard parts.count == 3 else { return }
            let id = parts[1], path = parts[2]
            web.takeSnapshot(with: nil) { image, _ in
                if let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: path))
                }
                out("RES \(id) \(b64("true"))")
            }
        case "QUIT":
            NSApp.terminate(nil)
        default:
            break
        }
    }
}

let argv = CommandLine.arguments
guard argv.count >= 5, let url = URL(string: argv[1]), let inject = try? String(contentsOfFile: argv[2], encoding: .utf8), let w = Double(argv[3]), let h = Double(argv[4]) else {
    FileHandle.standardError.write("usage: RVHost <url> <inject.js> <width> <height> [user agent]\n".data(using: .utf8)!)
    exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let host = Host(url: url, inject: inject, size: NSSize(width: w, height: h), ua: argv.count >= 6 ? argv[5] : nil)
app.delegate = host
app.run()
