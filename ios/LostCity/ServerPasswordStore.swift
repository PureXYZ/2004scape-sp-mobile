import Foundation
import Security

/// Passwords the player asked a server's login to remember (the Remember box), in the Keychain: generic passwords of the
/// service `<bundle id>.server`, the account `<server id>/<lower-case name>`, readable after the first unlock, on this
/// device only (docs/ARCHITECTURE.md §7.4). They never go to the settings, a file or a log; the page gets one only for
/// the login it asks for (`accounts.login`), and otherwise learns which names have one.
nonisolated enum ServerPasswordStore {
    private static var service: String {
        (Bundle.main.bundleIdentifier ?? "io.github.purexyz.scape2004") + ".server"
    }

    private static func account(_ server: String, _ name: String) -> String {
        "\(server)/\(name.lowercased())"
    }

    private static func query(_ server: String, _ name: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account(server, name)]
    }

    /// A login the game would send: a name of 1-12 characters and a password of 1-20 (Engine-TS refuses others).
    static func isValid(name: String, password: String? = nil) -> Bool {
        (1 ... 12).contains(name.count) && password.map { (1 ... 20).contains($0.count) } ?? true
    }

    static func read(server: String, name: String) -> String? {
        var item: CFTypeRef?
        var search = query(server, name)
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        guard SecItemCopyMatching(search as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, let password = String(data: data, encoding: .utf8), !password.isEmpty
        else { return nil }
        return password
    }

    /// Saves (or replaces) a password. False if the Keychain refused it.
    @discardableResult
    static func save(server: String, name: String, password: String) -> Bool {
        let query = query(server, name)
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = Data(password.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        if status != errSecSuccess {
            Log.info("accounts", "the Keychain refused a password for \(server) (OSStatus \(status))")
        }
        return status == errSecSuccess
    }

    @discardableResult
    static func remove(server: String, name: String) -> Bool {
        let status = SecItemDelete(query(server, name) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    /// Removes every password of a server; returns how many there were.
    @discardableResult
    static func removeAll(server: String) -> Int {
        let names = saved()[server] ?? []
        for name in names { remove(server: server, name: name) }
        return names.count
    }

    /// Removes the passwords of every server that is not in `ids` (the settings' servers); returns how many there were.
    /// Keychain items outlive the app: after a reinstall the settings, and so the servers, are gone, and nothing else
    /// could remove them (docs/ONLINE.md). Called at launch, once the settings are read.
    @discardableResult
    static func purge(keeping ids: Set<String>) -> Int {
        var removed = 0
        for (server, names) in saved() where !ids.contains(server) {
            for name in names where remove(server: server, name: name) { removed += 1 }
        }
        if removed > 0 {
            Log.info("accounts", "forgot \(removed) password\(removed == 1 ? "" : "s") of servers no longer in the settings")
        }
        return removed
    }

    /// The names with a stored password, per server id (lower-case, sorted).
    static func saved() -> [String: [String]] {
        var items: CFTypeRef?
        let search: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                     kSecAttrService as String: service,
                                     kSecReturnAttributes as String: true,
                                     kSecMatchLimit as String: kSecMatchLimitAll]
        guard SecItemCopyMatching(search as CFDictionary, &items) == errSecSuccess, let list = items as? [[String: Any]] else { return [:] }
        var result: [String: [String]] = [:]
        for item in list {
            guard let account = item[kSecAttrAccount as String] as? String, let slash = account.firstIndex(of: "/") else { continue }
            result[String(account[..<slash]), default: []].append(String(account[account.index(after: slash)...]))
        }
        return result.mapValues { $0.sorted() }
    }
}
