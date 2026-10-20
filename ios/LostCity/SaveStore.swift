import Foundation

/// Files the game writes — player saves at `players/<profile>/<name>.sav` — kept in the app's
/// Documents folder so they survive app updates, are included in device backups and are visible
/// in the Files app (ARCHITECTURE.md §3, §5).
///
/// * **Paths** are relative to Documents and validated component by component: no absolute paths,
///   no `.`/`..`, no empty components (`a//b`), no hidden (dot) components, no backslashes or NULs.
///   Hidden names are reserved for this store's own temp files.
/// * **Writes are atomic.** The bytes go to a hidden temp file in the target directory, which is
///   then exchanged with the target in one step (`renamex_np(RENAME_SWAP)`, APFS). The swapped-out
///   previous version is renamed to `<file>.bak`. The target path therefore always holds a
///   complete file — the old one or the new one — even if the app is killed mid-write. (The engine
///   rejects a save whose CRC does not match, so a torn write would lose the character.)
///   Durability is the same as `Data.write(options: .atomic)`: no fsync.
/// * **Unchanged writes are skipped.** Saving the same bytes again (pause + background both save a
///   paused world) would otherwise replace the useful `.bak` with a copy of the current file.
/// * **DELETE keeps a backup**: the deleted file becomes `<file>.bak` (deleting a `.bak` removes it).
/// * Every operation holds one lock, so concurrent requests (page and engine worker) cannot
///   interleave a write with its backup rotation. Saves are small; contention is negligible.
nonisolated final class SaveStore: Sendable {
    enum Failure: Error, CustomStringConvertible {
        case invalidPath
        case notFound
        case emptyBody
        case io(String)

        var description: String {
            switch self {
            case .invalidPath: "invalid path"
            case .notFound: "not found"
            case .emptyBody: "empty body"
            case .io(let message): message
            }
        }
    }

    /// One row of `/save-index`. `modified` is milliseconds since 1970 (JavaScript `Date` time).
    struct Entry: Codable, Sendable {
        let path: String
        let size: Int
        let modified: Int64
    }

    struct Info: Sendable {
        let size: Int
        let modified: Date
    }

    static let backupSuffix = ".bak"

    let root: URL
    private let lock = NSLock()

    init(root: URL) {
        self.root = root
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        removeStaleTempFiles()
    }

    static func documents() -> SaveStore {
        SaveStore(root: URL.documentsDirectory)
    }

    // MARK: - Operations

    func read(_ relative: String) throws(Failure) -> Data {
        let file = try resolve(relative)
        return try locked { () throws(Failure) -> Data in
            guard Self.isRegularFile(file) else { throw .notFound }
            do {
                return try Data(contentsOf: file)
            } catch {
                throw .io("read failed: \(error.localizedDescription)")
            }
        }
    }

    func info(_ relative: String) throws(Failure) -> Info {
        let file = try resolve(relative)
        return try locked { () throws(Failure) -> Info in
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: file.path(percentEncoded: false)),
                  attributes[.type] as? FileAttributeType == .typeRegular
            else { throw .notFound }
            return Info(size: (attributes[.size] as? NSNumber)?.intValue ?? 0,
                        modified: attributes[.modificationDate] as? Date ?? .distantPast)
        }
    }

    func write(_ relative: String, data: Data) throws(Failure) {
        let file = try resolve(relative)
        // An empty body is never a valid save. It is also exactly what arrives when a page sends
        // a Blob (WebKit drops Blob bodies for custom schemes), so refuse rather than truncate.
        guard !data.isEmpty else { throw .emptyBody }
        try locked { () throws(Failure) in
            let fm = FileManager.default
            let directory = file.deletingLastPathComponent()
            var isDirectory: ObjCBool = false
            if fm.fileExists(atPath: file.path(percentEncoded: false), isDirectory: &isDirectory), isDirectory.boolValue {
                throw .invalidPath  // never swap a whole directory out to ".bak"
            }
            if Self.isRegularFile(file), let current = try? Data(contentsOf: file), current == data {
                return
            }
            do {
                try fm.createDirectory(at: directory, withIntermediateDirectories: true)
            } catch {
                throw .io("mkdir failed: \(error.localizedDescription)")
            }
            let temp = directory.appendingPathComponent(".\(file.lastPathComponent).\(UUID().uuidString).tmp")
            do {
                try data.write(to: temp, options: .withoutOverwriting)
            } catch {
                try? fm.removeItem(at: temp)
                throw .io("write failed: \(error.localizedDescription)")
            }
            try Self.install(temp, at: file)
        }
    }

    /// Returns normally if the file existed (it is kept as `<file>.bak`), throws `.notFound` if not.
    func delete(_ relative: String) throws(Failure) {
        let file = try resolve(relative)
        try locked { () throws(Failure) in
            guard Self.isRegularFile(file) else { throw .notFound }
            let path = file.path(percentEncoded: false)
            if file.lastPathComponent.hasSuffix(Self.backupSuffix) {
                guard unlink(path) == 0 else { throw .io("unlink failed: \(Self.errnoText())") }
            } else {
                guard rename(path, path + Self.backupSuffix) == 0 else { throw .io("rename failed: \(Self.errnoText())") }
            }
        }
    }

    /// Every regular file under the root (hidden files and temp files excluded), sorted by path.
    func index() -> [Entry] {
        locked { () -> [Entry] in
            let fm = FileManager.default
            guard let enumerator = fm.enumerator(atPath: root.path(percentEncoded: false)) else { return [] }
            var entries: [Entry] = []
            while let relative = enumerator.nextObject() as? String {
                let attributes = enumerator.fileAttributes ?? [:]
                let isDirectory = attributes[.type] as? FileAttributeType == .typeDirectory
                if relative.split(separator: "/").contains(where: { $0.hasPrefix(".") }) {
                    if isDirectory { enumerator.skipDescendants() }
                    continue
                }
                guard attributes[.type] as? FileAttributeType == .typeRegular else { continue }
                let modified = attributes[.modificationDate] as? Date ?? .distantPast
                entries.append(Entry(path: relative,
                                     size: (attributes[.size] as? NSNumber)?.intValue ?? 0,
                                     modified: Int64((modified.timeIntervalSince1970 * 1000).rounded())))
            }
            return entries.sorted { $0.path < $1.path }
        }
    }

    // MARK: - Paths

    /// The validated components of a relative save path, or nil if it must be refused.
    static func components(of relative: String) -> [String]? {
        guard !relative.isEmpty, relative.utf8.count <= 1024,
              !relative.hasPrefix("/"), !relative.contains("\\"), !relative.contains("\0")
        else { return nil }
        let parts = relative.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        for part in parts {
            guard !part.isEmpty, !part.hasPrefix("."), part.utf8.count <= 255 else { return nil }
        }
        return parts
    }

    private func resolve(_ relative: String) throws(Failure) -> URL {
        guard let parts = Self.components(of: relative) else { throw .invalidPath }
        var file = root
        for part in parts { file.appendPathComponent(part, isDirectory: false) }
        // Belt and braces: the components above cannot climb out of root. (Compare components:
        // `path(percentEncoded:)` keeps a directory URL's trailing slash.)
        let rootComponents = root.standardizedFileURL.pathComponents
        guard Array(file.standardizedFileURL.pathComponents.prefix(rootComponents.count)) == rootComponents
        else { throw .invalidPath }
        return file
    }

    // MARK: - Helpers

    /// Moves `temp` to `file`, keeping the previous `file` (if any) as `file.bak`.
    private static func install(_ temp: URL, at file: URL) throws(Failure) {
        let tempPath = temp.path(percentEncoded: false)
        let filePath = file.path(percentEncoded: false)
        let backupPath = filePath + backupSuffix
        if renamex_np(tempPath, filePath, UInt32(RENAME_SWAP)) == 0 {
            // `file` is now the new data and `temp` the previous version: make that the backup
            // (rename replaces any older backup atomically).
            if rename(tempPath, backupPath) != 0 {
                Log.info("save", "keeping backup of \(file.lastPathComponent) failed: \(errnoText())")
                unlink(tempPath)
            }
            return
        }
        let swapError = errno
        if swapError == ENOENT && !isRegularFile(file) {
            // First save of this file: nothing to back up.
            guard rename(tempPath, filePath) == 0 else {
                let message = errnoText()
                unlink(tempPath)
                throw .io("rename failed: \(message)")
            }
            return
        }
        // RENAME_SWAP unsupported (not APFS): hard-link the current file as the backup, then
        // atomically replace it. The target still never disappears.
        unlink(backupPath)
        _ = link(filePath, backupPath)
        guard rename(tempPath, filePath) == 0 else {
            let message = errnoText()
            unlink(tempPath)
            throw .io("rename failed: \(message) (swap: \(String(cString: strerror(swapError))))")
        }
    }

    private static func isRegularFile(_ url: URL) -> Bool {
        var info = stat()
        return stat(url.path(percentEncoded: false), &info) == 0 && (info.st_mode & S_IFMT) == S_IFREG
    }

    private static func errnoText() -> String {
        String(cString: strerror(errno))
    }

    private func locked<T, E: Error>(_ body: () throws(E) -> T) throws(E) -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    /// Temp files left behind by a write that was interrupted by the app being killed.
    private func removeStaleTempFiles() {
        let root = self.root
        DispatchQueue.global(qos: .utility).async {
            let fm = FileManager.default
            guard let enumerator = fm.enumerator(atPath: root.path(percentEncoded: false)) else { return }
            while let relative = enumerator.nextObject() as? String {
                let name = (relative as NSString).lastPathComponent
                guard name.hasPrefix("."), name.hasSuffix(".tmp"),
                      let modified = enumerator.fileAttributes?[.modificationDate] as? Date,
                      modified.timeIntervalSinceNow < -60
                else { continue }
                try? fm.removeItem(at: root.appendingPathComponent(relative))
                Log.info("save", "removed stale temp file \(relative)")
            }
        }
    }
}
