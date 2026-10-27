import Foundation

/// The server a page load plays on (docs/ARCHITECTURE.md §3.1, §7.2): `settings.server` names an entry of
/// `settings.servers` (`{id, name, url, nodeId, members, rsa, added}`, kept by the page). Anything else is offline, and
/// every route and socket is as it was before online mode existed.
///
/// Native re-validates what the page stored: the id must be a plain file name (it names the server's cache folder) and
/// the URL must pass `normalize`, the same rules as the page's (contract: `192.168.1.20` → `http://192.168.1.20`,
/// `wss://Scape.Example.com/game/` → `https://scape.example.com/game`). No host is refused or treated differently.
nonisolated struct OnlineServer: Sendable, Equatable {
    let id: String
    let name: String
    /// The normalized base URL, without a trailing `/` (`http://192.168.1.20`, `https://scape.example.com/game`).
    let base: String

    /// The server this settings object plays on, or nil (offline).
    static func current(in settings: [String: Any]) -> OnlineServer? {
        guard let id = settings["server"] as? String, id != "offline", let entry = entry(id, in: settings),
              let base = (entry["url"] as? String).flatMap(normalize)
        else { return nil }
        let name = (entry["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? base
        return OnlineServer(id: id, name: name, base: base)
    }

    /// The entry of `settings.servers` with this id (and a usable id), or nil.
    static func entry(_ id: String, in settings: [String: Any]) -> [String: Any]? {
        guard isValidID(id) else { return nil }
        return (settings["servers"] as? [[String: Any]])?.first { $0["id"] as? String == id }
    }

    /// The ids of `settings.servers` that native can use.
    static func ids(in settings: [String: Any]) -> Set<String> {
        Set((settings["servers"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }.filter(isValidID))
    }

    /// A server id names a cache folder and a Keychain account prefix: 1-64 letters, digits, `-` or `_` (the page's
    /// ids are `s-` and 8 base36 characters).
    static func isValidID(_ id: String) -> Bool {
        (1 ... 64).contains(id.utf8.count) && id.utf8.allSatisfy { $0.isASCIILetterOrDigit || $0 == UInt8(ascii: "-") || $0 == UInt8(ascii: "_") }
    }

    /// `<base>/<path>` (`path` without a leading `/`).
    func url(_ path: String) -> URL? {
        URL(string: base + "/" + path)
    }

    /// The game's WebSocket: the base URL with `http` → `ws`, `https` → `wss`, the same host, port and path (or `/`).
    var socketURL: URL? {
        let secure = base.hasPrefix("https://")
        let rest = base.dropFirst(secure ? "https://".count : "http://".count)
        return URL(string: (secure ? "wss://" : "ws://") + rest + (rest.contains("/") ? "" : "/"))
    }

    /// The host and port, for logs.
    var displayHost: String {
        let rest = base.drop(while: { $0 != "/" }).dropFirst(2)
        return String(rest.prefix(while: { $0 != "/" }))
    }

    // MARK: - URL normalization (the page's rules: web/host/serverurl.js)

    /// An address as the player typed it (`host`, `host:port`, `http(s)://…`, `ws(s)://…`, an optional path) as a base
    /// URL, or nil when it cannot be one, by the page's rules (web/host/serverurl.js), step for step: `ws` → `http`,
    /// `wss` → `https`, no scheme → `http`; the host lower-cased, a name of labels (1-63 letters, digits, `-` or `_`; at
    /// most 253 characters, one trailing dot allowed) or an IPv6 address in brackets; the default port (80, 443) dropped;
    /// query and fragment dropped, and so is a trailing `/`. Credentials, other schemes, a port that is empty or outside
    /// 1-65535, empty, `.` or `..` path segments and spaces are refused. web/test/online/serverurl-vectors.json is the
    /// shared test (the debug hook `url-normalize` runs it here).
    static func normalize(_ typed: String) -> String? {
        var rest = Substring(typed.trimmingCharacters(in: .whitespacesAndNewlines))
        var scheme = "http"
        // a scheme: a letter, then letters, digits, `+`, `.` or `-`, then `://`
        if let separator = rest.range(of: "://"), let first = rest.first, first.isASCIILetter,
           rest[..<separator.lowerBound].allSatisfy({ $0.isASCIILetter || $0.isASCIIDigit || "+.-".contains($0) }) {
            switch rest[..<separator.lowerBound].lowercased() {
            case "http", "ws": scheme = "http"
            case "https", "wss": scheme = "https"
            default: return nil
            }
            rest = rest[separator.upperBound...]
        }
        let authority = rest.prefix(while: { $0 != "/" && $0 != "?" && $0 != "#" })
        var path = rest.dropFirst(authority.count)
        guard !authority.isEmpty, !authority.contains("@") else { return nil }

        let host: String
        var port: Substring?
        if authority.hasPrefix("[") {
            guard let close = authority.firstIndex(of: "]") else { return nil }
            let inside = authority[authority.index(after: authority.startIndex) ..< close]
            guard !inside.isEmpty, inside.contains(":"), inside.allSatisfy({ $0.isHexDigit && $0.isASCII || $0 == ":" || $0 == "." })
            else { return nil }
            host = "[\(inside.lowercased())]"
            let after = authority[authority.index(after: close)...]
            if !after.isEmpty {
                guard after.hasPrefix(":") else { return nil }
                port = after.dropFirst()
            }
        } else {
            let parts = authority.split(separator: ":", omittingEmptySubsequences: false)
            guard parts.count <= 2 else { return nil } // (an IPv6 address needs its brackets)
            host = parts[0].lowercased()
            port = parts.count == 2 ? parts[1] : nil
            let name = host.hasSuffix(".") ? host.dropLast() : Substring(host)
            let labels = name.split(separator: ".", omittingEmptySubsequences: false)
            guard host.utf16.count <= 253,
                  labels.allSatisfy({ (1 ... 63).contains($0.count) && $0.allSatisfy { $0.isASCIILetter || $0.isASCIIDigit || $0 == "-" || $0 == "_" } })
            else { return nil }
        }
        var portText = ""
        if let port {
            guard (1 ... 5).contains(port.count), port.allSatisfy(\.isASCIIDigit), let number = Int(port), (1 ... 65535).contains(number)
            else { return nil }
            if !(scheme == "http" && number == 80) && !(scheme == "https" && number == 443) {
                portText = ":\(number)"
            }
        }
        if let end = path.firstIndex(where: { $0 == "?" || $0 == "#" }) {
            path = path[..<end]
        }
        while path.hasSuffix("/") { path = path.dropLast() }
        if !path.isEmpty {
            let segments = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
            guard path.hasPrefix("/"), segments.allSatisfy({ segment in
                !segment.isEmpty && segment != "." && segment != ".."
                    && segment.allSatisfy { $0.isASCIILetter || $0.isASCIIDigit || "._~!$&'()*+,;=:@%-".contains($0) }
            }) else { return nil }
        }
        return "\(scheme)://\(host)\(portText)\(path)"
    }
}

private extension UInt8 {
    nonisolated var isASCIILetterOrDigit: Bool {
        (UInt8(ascii: "a") ... UInt8(ascii: "z")).contains(self) || (UInt8(ascii: "A") ... UInt8(ascii: "Z")).contains(self)
            || (UInt8(ascii: "0") ... UInt8(ascii: "9")).contains(self)
    }
}

private extension Character {
    nonisolated var isASCIIDigit: Bool { isASCII && ("0" ... "9").contains(self) }
    nonisolated var isASCIILetter: Bool { isASCII && (("a" ... "z").contains(self) || ("A" ... "Z").contains(self)) }
}

/// iOS's Local Network privacy: the first connection to a device on the player's network brings up the system's question
/// ("2004Scape would like to find and connect to devices on your local network"), and while it is up, or after Don't
/// Allow, URLSession fails at once with "not connected to the internet" (its path unsatisfied: "Local network
/// prohibited"). Native reports that with the words `local network` (as Android 17's own
/// refusal), which the page turns into where to allow it; the probe waits for the player's answer the first time
/// (`OnlineProxy.probe`). Not on the simulator: it never asks.
nonisolated enum LocalNetworkPrivacy {
    static let words = "local network"

    /// The system's refusal: no connection at all, with the path saying so or to a local address.
    static func refused(_ error: (any Error)?, host: String?) -> Bool {
        guard let error = error as? URLError, error.code == .notConnectedToInternet else { return false }
        return String(describing: error.userInfo).contains("Local network prohibited") || host.map(isLocal) == true
    }

    /// A host on the local network, as Android counts it (Network.kt `LocalNetwork.isLocalHost`): an IPv4 literal in
    /// 10/8, 172.16/12, 192.168/16 or 169.254/16, an IPv6 literal in fc00::/7 or fe80::/10, or a `.local` name.
    static func isLocal(_ host: String) -> Bool {
        var name = host.lowercased()
        if name.hasPrefix("["), name.hasSuffix("]") { name = String(name.dropFirst().dropLast()) }
        while name.hasSuffix(".") { name.removeLast() }
        if name.hasSuffix(".local") { return true }
        let parts = name.split(separator: ".", omittingEmptySubsequences: false)
        if parts.count == 4 {
            let v4 = parts.compactMap { Int($0) }
            guard v4.count == 4, v4.allSatisfy({ (0 ... 255).contains($0) }) else { return false }
            return v4[0] == 10 || (v4[0] == 172 && (16 ... 31).contains(v4[1])) || (v4[0] == 192 && v4[1] == 168) || (v4[0] == 169 && v4[1] == 254)
        }
        guard name.contains(":"), let first = Int(name.prefix(while: { $0 != ":" }).isEmpty ? "0" : String(name.prefix(while: { $0 != ":" })), radix: 16)
        else { return false }
        return first & 0xfe00 == 0xfc00 || first & 0xffc0 == 0xfe80
    }
}

/// CRC-32 (IEEE, as zlib and the client's `Packet.getcrc`), as the signed 32-bit value the game writes in `/crc` and in
/// the archives' names.
nonisolated enum CRC32 {
    private static let table: [UInt32] = (0 ..< 256).map { index in
        var value = UInt32(index)
        for _ in 0 ..< 8 { value = value & 1 == 1 ? 0xEDB8_8320 ^ (value >> 1) : value >> 1 }
        return value
    }

    static func checksum(_ data: Data) -> Int32 {
        var crc: UInt32 = 0xFFFF_FFFF
        data.withUnsafeBytes { raw in
            for byte in raw.bindMemory(to: UInt8.self) {
                crc = table[Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8)
            }
        }
        return Int32(bitPattern: crc ^ 0xFFFF_FFFF)
    }

    /// The 9 archive CRCs of a `/crc` table (40 bytes, big-endian), or nil unless its trailer is the client's own check:
    /// 1234, then `(c << 1) + crc[i]` over the 9 entries (Client.ts `getJagChecksums`).
    static func table(fromCRCFile data: Data) -> [Int32]? {
        guard data.count == 40 else { return nil }
        let bytes = [UInt8](data)
        let values = (0 ..< 10).map { (i: Int) -> Int32 in
            var value: UInt32 = 0
            for byte in bytes[i * 4 ..< i * 4 + 4] { value = value << 8 | UInt32(byte) }
            return Int32(bitPattern: value)
        }
        var check: Int32 = 1234
        for value in values.prefix(9) { check = (check << 1) &+ value }
        return check == values[9] ? Array(values.prefix(9)) : nil
    }
}
