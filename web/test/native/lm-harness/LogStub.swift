import Foundation

// ios/LostCity/Log.swift's interface for the Mac harness (lines to stdout, prefixed so the runner can tell them apart).
nonisolated enum Log {
    static let verbose = ProcessInfo.processInfo.environment["LM_VERBOSE"] == "1"

    static func info(_ tag: String, _ message: String) {
        print("LOG [\(tag)] \(message)")
    }

    static func debug(_ tag: String, _ message: @autoclosure () -> String) {
        if verbose { print("LOG [\(tag)] \(message())") }
    }
}
