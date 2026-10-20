import WebKit

/// Native → page calls on `window.LostCityHost` (ARCHITECTURE.md §7), e.g.
/// `call("keyboard.insertText", ["a"])` runs `await LostCityHost.keyboard.insertText("a")`.
///
/// Calls go through `callAsyncJavaScript` in the page world, so a returned Promise is awaited
/// (`lifecycle` resolves only after the saves are written). WebKit runs them in the order they
/// are made, which keeps keystrokes in order. A missing host or method (page still booting, or a
/// test page) is reported as `.missing`, not as an error.
final class PageBridge {
    enum Outcome: CustomStringConvertible {
        case returned(Any?)
        case missing
        case failed(String)

        /// "Nothing went wrong": a missing host has nothing to save or resume either.
        var succeeded: Bool {
            if case .failed = self { return false }
            return true
        }

        /// `succeeded`, and for calls that answer `{ ok, error }` (lifecycle), `ok` is not false: a page that
        /// could not write a save resolves normally with `{ ok: false }`.
        var reportedSuccess: Bool {
            guard succeeded else { return false }
            if case .returned(let value) = self, let reply = value as? [String: Any], let ok = reply["ok"] as? Bool {
                return ok
            }
            return true
        }

        var description: String {
            switch self {
            case .returned(let value): "ok\(value.map { " → \(Self.compact($0))" } ?? "")"
            case .missing: "no LostCityHost handler on the page"
            case .failed(let message): "failed: \(message)"
            }
        }

        /// One-line JSON for logs (NSDictionary descriptions span several lines).
        private static func compact(_ value: Any) -> String {
            guard JSONSerialization.isValidJSONObject(value),
                  let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
                  let text = String(data: data, encoding: .utf8)
            else { return String(describing: value) }
            return text
        }
    }

    weak var webView: WKWebView?

    func call(_ path: String, _ arguments: [Any] = [], completion: ((Outcome) -> Void)? = nil) {
        guard let webView else {
            completion?(.failed("no web view"))
            return
        }
        webView.callAsyncJavaScript(Self.invoke, arguments: ["path": path, "args": arguments], in: nil, in: .page) { result in
            switch result {
            case .success(let value):
                let reply = value as? [String: Any]
                if reply?["missing"] as? Bool == true {
                    completion?(.missing)
                } else {
                    let returned = reply?["value"]
                    completion?(.returned(returned is NSNull ? nil : returned))
                }
            case .failure(let error):
                let message = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription
                completion?(.failed(message))
            }
        }
    }

    /// Resolves `path` on `window.LostCityHost`, calls it with `args`, awaits the result and
    /// returns it JSON-normalized (callAsyncJavaScript fails on values it cannot convert).
    private static let invoke = """
    const keys = path.split('.');
    let owner = window.LostCityHost;
    for (let i = 0; i < keys.length - 1 && owner != null; i++) owner = owner[keys[i]];
    const fn = owner == null ? undefined : owner[keys[keys.length - 1]];
    if (typeof fn !== 'function') return { missing: true };
    const value = await fn.apply(owner, args);
    try {
        return { value: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
    } catch {
        return { value: String(value) };
    }
    """
}
