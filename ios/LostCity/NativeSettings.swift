import UIKit

/// Settings the page asks native to keep (`{type:'settings', values}` → UserDefaults); handed
/// back on every page load as `window.LostCityNative.settings` (ARCHITECTURE.md §7).
///
/// Stored as JSON rather than as a plist dictionary because page values may contain `null`,
/// which UserDefaults cannot hold (it throws). Incoming values are merged shallowly into the
/// stored object, so the page may send only what changed; a `null` value removes the key.
final class NativeSettings {
    private static let key = "LostCity.settings"
    private static let maxBytes = 64 * 1024

    private let defaults: UserDefaults
    private(set) var values: [String: Any] = [:]
    /// The stored settings were read, or there were none (a first launch): `values` is what the page last kept.
    let readable: Bool

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.key) {
            let stored = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            values = stored ?? [:]
            readable = stored != nil
        } else {
            readable = true
        }
    }

    /// Returns false (and keeps the old values) if `incoming` is not a JSON object or is too big.
    @discardableResult
    func merge(_ incoming: Any?) -> Bool {
        guard let incoming = incoming as? [String: Any] else { return false }
        var next = values
        for (key, value) in incoming {
            if value is NSNull { next.removeValue(forKey: key) } else { next[key] = value }
        }
        guard JSONSerialization.isValidJSONObject(next),
              let data = try? JSONSerialization.data(withJSONObject: next, options: [.sortedKeys]),
              data.count <= Self.maxBytes
        else { return false }
        values = next
        defaults.set(data, forKey: Self.key)
        return true
    }
}

/// Facts about this build and device, injected as `window.LostCityNative`.
enum AppInfo {
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    static var build: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
    }

    /// `2004Scape/<version> (iOS <version>)`: what the app's requests to a game server say they are.
    nonisolated static var userAgent: String {
        let app = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let os = ProcessInfo.processInfo.operatingSystemVersion
        return "2004Scape/\(app) (iOS \(os.majorVersion).\(os.minorVersion)\(os.patchVersion > 0 ? ".\(os.patchVersion)" : ""))"
    }

    static var isSimulator: Bool {
        #if targetEnvironment(simulator)
        true
        #else
        false
        #endif
    }

    static var isDebug: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    /// Hardware model, e.g. `iPhone14,4` (iPhone 13 mini).
    static var deviceModel: String {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
            return simulated
        }
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
    }

    /// The object injected as `window.LostCityNative` (must stay JSON-serializable). `lm`: the bots' chat model status
    /// (BotChatModel.status: the on-device model, the Claude key), as `LostCityHost.bots.lmStatus` later sends it.
    /// `savedPasswords`: the names with a remembered password per server id, as `LostCityHost.accounts.saved` later
    /// sends them.
    static func pageInfo(settings: [String: Any], lm: [String: Any], savedPasswords: [String: [String]]) -> [String: Any] {
        [
            "platform": "ios",
            "appVersion": version,
            "build": build,
            "osVersion": UIDevice.current.systemVersion,
            "deviceModel": deviceModel,
            "simulator": isSimulator,
            "debug": isDebug,
            "settings": settings,
            "lm": lm,
            "savedPasswords": savedPasswords,
        ]
    }
}
