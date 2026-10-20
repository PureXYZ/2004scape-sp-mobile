import Foundation

/// Native log.
///
/// Every line goes to stdout. `setUp()` switches stdout to line buffering: when it is a pipe or
/// pty (`xcrun devicectl device process launch --console`, `xcrun simctl launch --console-pty`)
/// it is block-buffered by default, so lines would otherwise arrive in 4 KB bursts, or never if
/// the app is killed. Lines are also appended to `Library/Caches/Logs/lostcity.log` (rotated at
/// 2 MB), so a session that ran without a console can be inspected afterwards:
///
///     xcrun devicectl device copy from --device <udid> --domain-type appDataContainer \
///       --domain-identifier io.github.purexyz.scape2004 --source Library/Caches/Logs/lostcity.log --destination .
///
/// The file is kept out of Documents on purpose: Documents is the save area listed by
/// `/save-index` and shown in the Files app.
nonisolated enum Log {
    /// Extra per-request / per-keystroke lines. Launch with `-LostCityVerbose YES` to enable.
    static let verbose = UserDefaults.standard.bool(forKey: "LostCityVerbose")

    /// Longest line written; page console output can be arbitrarily large objects.
    private static let maxLineLength = 16 * 1024

    static func setUp() {
        setvbuf(stdout, nil, _IOLBF, 0)
        setvbuf(stderr, nil, _IONBF, 0)
        LogFile.shared.start()
    }

    /// `[HH:MM:SS.mmm] [tag] message`
    static func info(_ tag: String, _ message: String) {
        write("[\(tag)] \(message)")
    }

    static func debug(_ tag: String, _ message: @autoclosure () -> String) {
        guard verbose else { return }
        write("[\(tag)] \(message())")
    }

    static func write(_ line: String) {
        var line = line
        if line.utf8.count > maxLineLength {
            line = String(line.prefix(maxLineLength)) + " …(truncated)"
        }
        let stamped = "\(timestamp()) \(line)"
        print(stamped)
        LogFile.shared.append(stamped)
    }

    /// Pushes buffered output to disk; called before the app may be suspended or terminated.
    static func flush() {
        fflush(stdout)
        LogFile.shared.flush()
    }

    private static func timestamp() -> String {
        var now = timeval()
        gettimeofday(&now, nil)
        var seconds = now.tv_sec
        var parts = tm()
        localtime_r(&seconds, &parts)
        return String(format: "%02d:%02d:%02d.%03d", parts.tm_hour, parts.tm_min, parts.tm_sec, Int(now.tv_usec / 1000))
    }
}

/// Buffered, rotating append-only log file. All state is confined to `queue`.
nonisolated private final class LogFile: @unchecked Sendable {
    static let shared = LogFile()

    private let queue = DispatchQueue(label: "lostcity.log-file", qos: .utility)
    private let url: URL
    private let rotatedURL: URL
    private var handle: FileHandle?
    private var size: UInt64 = 0
    private var buffer = Data()
    private var flushScheduled = false

    private static let rotateAt: UInt64 = 2 * 1024 * 1024
    private static let flushAt = 32 * 1024

    private init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let directory = caches.appendingPathComponent("Logs", isDirectory: true)
        url = directory.appendingPathComponent("lostcity.log")
        rotatedURL = directory.appendingPathComponent("lostcity.1.log")
    }

    func start() {
        queue.async { [self] in
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            openFile()
            buffer.append(Data("\n===== launch \(Date()) =====\n".utf8))
        }
    }

    func append(_ line: String) {
        let data = Data((line + "\n").utf8)
        queue.async { [self] in
            buffer.append(data)
            if buffer.count >= Self.flushAt {
                writeBuffer()
            } else if !flushScheduled {
                flushScheduled = true
                queue.asyncAfter(deadline: .now() + 0.3) { [self] in
                    flushScheduled = false
                    writeBuffer()
                }
            }
        }
    }

    func flush() {
        queue.sync { writeBuffer() }
    }

    private func openFile() {
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        handle = try? FileHandle(forWritingTo: url)
        size = (try? handle?.seekToEnd()) ?? 0
        if size >= Self.rotateAt { rotate() }
    }

    private func rotate() {
        try? handle?.close()
        handle = nil
        try? FileManager.default.removeItem(at: rotatedURL)
        try? FileManager.default.moveItem(at: url, to: rotatedURL)
        FileManager.default.createFile(atPath: url.path, contents: nil)
        handle = try? FileHandle(forWritingTo: url)
        size = 0
    }

    private func writeBuffer() {
        guard !buffer.isEmpty else { return }
        if handle == nil { openFile() }
        guard let handle else {
            buffer.removeAll()
            return
        }
        do {
            try handle.write(contentsOf: buffer)
            size += UInt64(buffer.count)
        } catch {
            // Disk full or similar: drop the log rather than grow memory without bound.
        }
        buffer.removeAll(keepingCapacity: true)
        if size >= Self.rotateAt { rotate() }
    }
}
