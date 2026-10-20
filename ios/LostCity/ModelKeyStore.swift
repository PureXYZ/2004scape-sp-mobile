import Foundation
import Security

/// The player's Claude API key for the bots' online chat (Settings › Bot chat › Claude online), in the Keychain: a
/// generic password readable after the first unlock, on this device only (it is not backed up to another device). It is
/// typed into a native secure box and never reaches the game page, a file, a log or the settings; the page only learns
/// whether a key is set and its last four characters (docs/ARCHITECTURE.md §7.1).
nonisolated enum ModelKeyStore {
    private static let service = "io.github.purexyz.scape2004.claude"
    private static let account = "api-key"

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    /// The key, or nil.
    static func read() -> String? {
        var item: CFTypeRef?
        var search = query
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        guard SecItemCopyMatching(search as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, let key = String(data: data, encoding: .utf8), !key.isEmpty
        else { return nil }
        return key
    }

    static var isSet: Bool { read() != nil }

    /// "…abcd": the key's last four characters, as the page shows it.
    static var hint: String? {
        read().map { "…" + String($0.suffix(4)) }
    }

    /// A key as typed or pasted, cleaned up (spaces and line breaks around it), or nil if it cannot be one.
    static func normalized(_ typed: String) -> String? {
        let key = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (8 ... 512).contains(key.count),
              key.unicodeScalars.allSatisfy({ $0.isASCII && $0.value > 32 && $0.value < 127 })
        else { return nil }
        return key
    }

    /// Saves (or replaces) the key. False if the Keychain refused it.
    @discardableResult
    static func save(_ key: String) -> Bool {
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = Data(key.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        if status != errSecSuccess {
            Log.info("lm", "the Keychain refused the Claude key (OSStatus \(status))")
        }
        return status == errSecSuccess
    }

    @discardableResult
    static func remove() -> Bool {
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
