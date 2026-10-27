import Foundation
#if os(iOS)
import os
#endif

/// The bots' chat model, native side (docs/ARCHITECTURE.md §7.1): the page hands over a reply the engine wants written
/// (`{type:'lm', id, mode, local, online, maxChars, timeoutMs}`), and this answers it through `LostCityHost.bots.lmReply`
/// with a line or with null and why. The engine decides everything else (whether a bot replies, when, and its fallback:
/// the rules' line); a line here is only words.
///
/// - The mode is the player's (Settings › Bot chat), sent with each request: `online` uses Claude when a key is saved and
///   falls back to the on-device model, then to nothing; `local` uses the on-device model, else nothing. A request that
///   says `fallback: false` (the page's Test button) gets Claude's answer or its error, never the on-device model's.
/// - `think` (Settings › Bot chat › Think first; absent: false): the on-device model writes its short note before the
///   reply, when it is a model that offers the choice (`LocalModel.ThinkSupport`); also on Claude's fallback to it.
///   Claude online ignores it.
/// - At most 3 requests at a time; more are answered 'busy' at once. Each has the page's `timeoutMs` (9 s) in all.
/// - Memory: after a memory warning, iOS announcing memory pressure for the phone, or a load refused for memory (the app's
///   own room, or the phone under pressure), the on-device model rests (`memoryRest`, 10 min, then until the phone is
///   not under pressure): requests get 'unavailable' at once and the status says `local.rest: 'memory'`, so the page
///   tells the engine there is no on-device model meanwhile, and the player in the chat.
/// - The status (`LostCityHost.bots.lmStatus`, and `window.LostCityNative.lm` at document start): the on-device model
///   (in this build at all, its name and size, whether it is loaded, whether it writes the note: `think` 'never',
///   'always' or 'option', how long its last load took: `lastLoadMs`, `ModelLoadRecord`) and the Claude key (set, its
///   last four characters, refused by the API, the last problem).
@MainActor
final class BotChatModel {
    static let maxInFlight = 3
    static let defaultTimeoutMs = 9000

    let local: LocalModel
    let online = OnlineModel()
    /// The Claude key, when a request needs it (the Keychain; a test's stand-in).
    var readKey: () -> String? = { ModelKeyStore.read() }
    /// The on-device model's last load time, kept across launches (the status's `lastLoadMs`; a test's stand-in).
    var loadRecord = ModelLoadRecord()
    /// A reply for the page (`LostCityHost.bots.lmReply`).
    var onReply: (([String: Any]) -> Void)?
    /// The status changed (`LostCityHost.bots.lmStatus`).
    var onStatus: (([String: Any]) -> Void)?

    private var inFlight = 0
    /// bumped when the page goes away (pageReset): a reply asked by an older page is dropped
    private var generation = 0
    /// The phone is hot (iOS's thermal state serious or critical): the on-device model does not run until it cools down
    /// (the engine says the bots' own lines meanwhile); Claude online is not affected. Measured on an iPhone 13 mini: a
    /// reply every 5 s for 14 minutes, on USB power with 500 bots, reaches serious.
    var thermalState: () -> ProcessInfo.ThermalState = { ProcessInfo.processInfo.thermalState }
    private var tooHot: Bool { thermalState().rawValue >= ProcessInfo.ThermalState.serious.rawValue }
    /// After the phone ran short of memory (a memory warning, iOS announcing memory pressure for the whole phone, or a
    /// load refused for memory) the on-device model is freed and rests this long, and after that until the phone is not
    /// under memory pressure (the engine says the bots' own lines meanwhile; the page tells the player in the chat).
    /// Measured on an iPhone 13 mini with 1000 bots (2026-10-27): the model loaded again 12 s after a memory warning, the
    /// next warning came 26 s later, and iOS ended the game's WebContent process 0.2 s after it.
    static let memoryRest: TimeInterval = 10 * 60
    /// The clock of the rest (a test's stand-in).
    var now: () -> Date = { Date() }
    /// iOS's memory pressure for the whole phone (1 normal, 2 warning, 4 critical), or nil where the app may not read it
    /// (then the last change iOS announced counts, `watchMemoryPressure`); a test's stand-in.
    var phonePressure: () -> Int? = { DeviceStats.memoryPressure }
    /// Until when the on-device model rests (nil: it does not).
    private(set) var restingUntil: Date?
    private var restWork: DispatchWorkItem?
    private var pressureSource: DispatchSourceMemoryPressure?
    /// the last level iOS announced, and when
    private var announced: (level: Int, at: Date)?
    /// nil until Claude answered or refused the key; false after a 401.
    private var keyValid: Bool?
    private var onlineProblem: String?
    private var stats = (requests: 0, local: 0, online: 0, failed: 0, busy: 0, hot: 0, memory: 0)

    init(local: LocalModel = LocalModel()) {
        self.local = local
        local.onLoadedChange = { [weak self] loaded in
            MainActor.assumeIsolated { self?.loadedChanged(loaded) }
        }
    }

    // MARK: - Status

    var status: [String: Any] {
        var localStatus: [String: Any] = ["available": local.available, "loaded": local.isLoaded, "think": local.thinkSupport.rawValue]
        if let info = local.info {
            localStatus["name"] = info.name
            localStatus["bytes"] = info.bytes
        }
        if let reason = local.unavailableReason {
            localStatus["reason"] = reason
        }
        if let ms = loadRecord.lastLoadMs {
            localStatus["lastLoadMs"] = ms.rounded()
        }
        if restingUntil != nil {
            localStatus["rest"] = "memory"
        }
        let hint = readKey().map { "…" + String($0.suffix(4)) }
        var onlineStatus: [String: Any] = ["keySet": hint != nil, "model": OnlineModel.model]
        if let hint { onlineStatus["hint"] = hint }
        if let keyValid { onlineStatus["valid"] = keyValid }
        if let onlineProblem { onlineStatus["problem"] = onlineProblem }
        return ["local": localStatus, "online": onlineStatus]
    }

    private func statusChanged() {
        onStatus?(status)
    }

    private func loadedChanged(_ loaded: Bool) {
        if loaded, let ms = local.lastLoad?.first {
            loadRecord.record(ms)
        }
        // (what the phone had then: the memory rest's thresholds are iOS's, this line shows where they stand)
        Log.info("lm", "memory with the model \(loaded ? "in" : "out")\(DeviceStats.memorySummary)")
        statusChanged()
    }

    // MARK: - The key (Settings › Bot chat)

    /// Saves a key typed into the native secure box. False if it cannot be a key or the Keychain refused it.
    func setKey(_ typed: String) -> Bool {
        guard let key = ModelKeyStore.normalized(typed), ModelKeyStore.save(key) else { return false }
        keyValid = nil
        onlineProblem = nil
        Log.info("lm", "Claude key saved (\(ModelKeyStore.hint ?? "?"))")
        statusChanged()
        return true
    }

    /// Something about the key to show on the Bot chat page ("not a key": what was typed cannot be one).
    func keyProblem(_ problem: String) {
        onlineProblem = problem
        statusChanged()
    }

    func removeKey() {
        ModelKeyStore.remove()
        keyValid = nil
        onlineProblem = nil
        Log.info("lm", "Claude key removed")
        statusChanged()
    }

    // MARK: - App events

    /// The player entered the world with a model chosen (the page's `{type:'lm-warm'}`): the model loads now, in the
    /// background, so that the first reply does not wait for it (about 1 s; the first load after an install, while Metal
    /// prepares its shaders, about 15 s on an iPhone 13 mini). The idle unload still applies.
    func warm() {
        guard local.available, !tooHot, memoryRefusal() == nil else { return }
        local.warmUp()
    }

    /// The phone is short of memory (UIKit's memory warning, or iOS announcing memory pressure): the reply being written
    /// stops, the model is freed at once, and it rests (`memoryRest`).
    func memoryWarning(_ why: String = "memory warning") {
        local.release(reason: why)
        rest(why)
    }

    /// iOS's announcements of the whole phone's memory pressure: a warning or worse frees the model and starts its rest
    /// (UIKit's memory warning may not come for it: that one is about the app's own share too). Called once, by the app.
    func watchMemoryPressure() {
        guard pressureSource == nil else { return }
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.normal, .warning, .critical], queue: .main)
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.pressureChanged() }
        }
        source.activate()
        pressureSource = source
    }

    private func pressureChanged() {
        guard let event = pressureSource?.data else { return }
        let level = event.contains(.critical) ? 4 : event.contains(.warning) ? 2 : 1
        announced = (level, now())
        Log.info("lm", "iOS: the phone's memory pressure is \(DeviceStats.pressureName(level))\(DeviceStats.memorySummary)")
        if level >= 2 {
            memoryWarning("memory pressure \(DeviceStats.pressureName(level))")
        }
    }

    /// The pressure now: iOS's own reading, else the last change it announced (for as long as a rest lasts: a warning with
    /// no word since is not held against the phone for ever), else nil.
    private var pressureNow: Int? {
        if let level = phonePressure() { return level }
        if let announced, now().timeIntervalSince(announced.at) < Self.memoryRest { return announced.level }
        return nil
    }

    /// Why the on-device model may not load or run now, or nil: it rests, or it is not loaded and the phone is under
    /// memory pressure (which starts a rest: the page tells the player once).
    private func memoryRefusal() -> String? {
        if restingUntil != nil { return "resting" }
        if !local.isLoaded, let level = pressureNow, level >= 2 {
            rest("not loaded: the phone's memory pressure is \(DeviceStats.pressureName(level))")
            return "pressure"
        }
        return nil
    }

    private func rest(_ why: String) {
        let first = restingUntil == nil
        restingUntil = now().addingTimeInterval(Self.memoryRest)
        Log.info("lm", "\(first ? "the on-device model rests" : "its rest starts again") for \(Int(Self.memoryRest / 60)) min (\(why))\(DeviceStats.memorySummary)")
        scheduleRestEnd(after: Self.memoryRest)
        if first {
            statusChanged()
        }
    }

    private func scheduleRestEnd(after seconds: TimeInterval) {
        restWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.endRestIfRoom() }
        }
        restWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    /// The rest's time is up: the model may load again once the phone is not under memory pressure (looked at again every
    /// minute until then). The page hears it in the status.
    func endRestIfRoom() {
        guard let until = restingUntil else { return }
        let left = until.timeIntervalSince(now())
        if left > 0 {
            scheduleRestEnd(after: left)
            return
        }
        if let level = pressureNow, level >= 2 {
            scheduleRestEnd(after: 60)
            return
        }
        restWork?.cancel()
        restWork = nil
        restingUntil = nil
        Log.info("lm", "the on-device model may load again\(DeviceStats.memorySummary)")
        statusChanged()
    }

    /// The app is inactive for a moment: the reply being written stops (no GPU work then); the model stays loaded.
    func pause() {
        local.pause()
    }

    /// The app is in the background: the model is freed too.
    func suspend() {
        local.suspend()
    }

    /// The page went away (a reload, a new document): answers still being written were asked by the old page, whose ids
    /// the new one counts again from 1, so they are dropped (the review of the merge).
    func pageReset() {
        generation += 1
    }

    func resume() {
        local.resume()
    }

    // MARK: - Requests

    func handle(_ message: [String: Any]) {
        guard let id = (message["id"] as? NSNumber)?.intValue else {
            Log.info("lm", "ignored a request without an id")
            return
        }
        let started = DispatchTime.now()
        let gen = generation
        let mode = message["mode"] as? String ?? "local"
        let localPrompt = message["local"] as? [String: Any] ?? [:]
        let onlinePrompt = message["online"] as? [String: Any] ?? [:]
        let fallback = message["fallback"] as? Bool ?? true
        let think = message["think"] as? Bool ?? false  // (the on-device model's note: Settings › Bot chat › Think first)
        let timeoutMs = min(30_000, max(1000, (message["timeoutMs"] as? NSNumber)?.intValue ?? Self.defaultTimeoutMs))
        let deadline = started + .milliseconds(timeoutMs)
        stats.requests += 1

        func reply(_ text: String?, source: String?, error: String?, extra: [String: Any] = [:]) {
            guard gen == generation else {
                Log.info("lm", "#\(id) answered after the page reloaded: dropped")
                return
            }
            let ms = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000
            var out: [String: Any] = ["id": id, "text": text ?? NSNull(), "source": source ?? NSNull(), "ms": (ms * 10).rounded() / 10]
            if let error { out["error"] = error }
            out.merge(extra) { a, _ in a }
            onReply?(out)
        }

        guard mode == "local" || mode == "online" else {
            reply(nil, source: nil, error: "unavailable")  // ('rules': the page answers those itself)
            return
        }
        guard inFlight < Self.maxInFlight else {
            stats.busy += 1
            reply(nil, source: nil, error: "busy")
            return
        }
        inFlight += 1

        let runLocal: (String?) -> Void = { [weak self] onlineError in
            guard let self else { return }
            guard fallback || mode == "local", self.local.available else {
                self.inFlight -= 1
                self.stats.failed += 1
                reply(nil, source: nil, error: onlineError ?? "unavailable")
                return
            }
            guard !self.tooHot else {
                self.inFlight -= 1
                self.stats.hot += 1
                Log.info("lm", "#\(id) the phone is hot (thermal state \(DeviceStats.name(self.thermalState()))): no on-device reply")
                reply(nil, source: nil, error: onlineError ?? "busy")
                return
            }
            if let refusal = self.memoryRefusal() {
                self.inFlight -= 1
                self.stats.memory += 1
                Log.info("lm", "#\(id) the phone is short of memory (\(refusal)): no on-device reply")
                reply(nil, source: nil, error: onlineError ?? "unavailable")
                return
            }
            self.local.generate(system: localPrompt["system"] as? String ?? "", user: localPrompt["user"] as? String ?? "", think: think, deadline: deadline) { result in
                self.inFlight -= 1
                switch result {
                case .success(let output):
                    self.stats.local += 1
                    let t = output.timings
                    // (the mode the model ran in: the request's think, as the model allows it)
                    Log.info("lm", "#\(id) local, think \(t.think ? "on" : "off")\(t.think != think ? " (asked \(think ? "on" : "off"))" : ""), in \(Int(t.totalMs)) ms\(t.loadMs.map { " (load \(Int($0)) ms)" } ?? ""): prompt \(t.promptTokens) tokens at \(Int(t.promptTokensPerSecond))/s\(t.think ? ", note \(t.noteTokens) tokens in \(Int(t.noteMs)) ms" : ""), \(t.generatedTokens) tokens at \(Int(t.generateTokensPerSecond))/s")
                    reply(output.text.isEmpty ? nil : output.text, source: output.text.isEmpty ? nil : "local",
                          error: output.text.isEmpty ? "failed: empty" : nil, extra: ["timings": t.dictionary])
                case .failure(let failure):
                    self.stats.failed += 1
                    Log.info("lm", "#\(id) local, think \(self.local.thinkSupport.writesNote(asked: think) ? "on" : "off"), failed: \(failure)\(onlineError.map { " (after Claude: \($0))" } ?? "")")
                    if case .unavailable("memory") = failure {
                        self.rest("not loaded: too little left for the app")
                    }
                    reply(nil, source: nil, error: failure.description)  // (the last try's reason; Claude's is in the status)
                }
            }
        }

        let key = mode == "online" ? readKey() : nil
        guard let key else {
            if mode == "online", !fallback {
                inFlight -= 1
                reply(nil, source: nil, error: "unavailable")
                return
            }
            runLocal(nil)
            return
        }
        // (signed: the key's Keychain read on this thread may have run past the deadline; an unsigned subtraction traps)
        let remaining = Double(Int64(bitPattern: deadline.uptimeNanoseconds) - Int64(bitPattern: DispatchTime.now().uptimeNanoseconds)) / 1e9
        guard remaining > 0.5 else {
            inFlight -= 1
            reply(nil, source: nil, error: "timeout")
            return
        }
        online.generate(key: key, system: onlinePrompt["system"] as? String ?? "", context: onlinePrompt["context"] as? String ?? "",
                        user: onlinePrompt["user"] as? String ?? "", timeout: min(8, remaining)) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let output):
                self.inFlight -= 1
                self.stats.online += 1
                let u = output.usage
                Log.info("lm", "#\(id) Claude in \(Int(output.ms)) ms (input \(u.input), cache read \(u.cacheRead), write \(u.cacheWrite), output \(u.output) tokens)")
                if self.keyValid != true || self.onlineProblem != nil {
                    self.keyValid = true
                    self.onlineProblem = nil
                    self.statusChanged()
                }
                reply(output.text, source: "online", error: nil, extra: ["usage": u.dictionary])
            case .failure(let failure):
                Log.info("lm", "#\(id) Claude failed: \(failure)\(fallback ? (self.local.available ? "; the on-device model answers" : "") : "")")
                let valid: Bool? = if case .keyRefused = failure { false } else { self.keyValid }
                if valid != self.keyValid || self.onlineProblem != failure.problem {
                    self.keyValid = valid
                    self.onlineProblem = failure.problem
                    self.statusChanged()
                }
                if fallback {
                    runLocal(failure.reason)
                } else {
                    self.inFlight -= 1
                    self.stats.failed += 1
                    reply(nil, source: nil, error: failure.reason)
                }
            }
        }
    }

    /// For the phone spike's log.
    var counters: [String: Any] {
        ["requests": stats.requests, "local": stats.local, "online": stats.online, "failed": stats.failed, "busy": stats.busy, "hot": stats.hot, "memory": stats.memory, "inFlight": inFlight]
    }
}

/// The app's memory and heat, for the phone spike (app-test --lm-bench) and the logs.
nonisolated enum DeviceStats {
    /// The app process's footprint (what jetsam counts), in bytes.
    static var physFootprint: UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? info.phys_footprint : 0
    }

    /// How much more the app process may use before jetsam (iOS), in bytes.
    static var availableMemory: UInt64 {
        #if os(iOS)
        UInt64(os_proc_available_memory())
        #else
        0
        #endif
    }

    /// iOS's memory pressure for the whole phone (`kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical),
    /// or nil where the system does not let the app read it (the Mac: nil, no check).
    static var memoryPressure: Int? {
        #if os(iOS)
        sysctlInt("kern.memorystatus_vm_pressure_level")
        #else
        nil
        #endif
    }

    /// The share of the phone's memory iOS counts as available (`kern.memorystatus_level`, %), or nil: for the log.
    static var memoryFreePercent: Int? {
        #if os(iOS)
        sysctlInt("kern.memorystatus_level")
        #else
        nil
        #endif
    }

    static func pressureName(_ level: Int) -> String {
        level >= 4 ? "critical" : level >= 2 ? "warning" : "normal"
    }

    /// For a log line: "; phone: 23 % free, pressure normal; app: 1,830 MB left", what of it can be read.
    static var memorySummary: String {
        var parts: [String] = []
        if let free = memoryFreePercent { parts.append("\(free) % free") }
        if let level = memoryPressure { parts.append("pressure \(pressureName(level))") }
        let phone = parts.isEmpty ? "" : "; phone: " + parts.joined(separator: ", ")
        #if os(iOS)
        return phone + "; app: \(availableMemory >> 20) MB left"
        #else
        return phone
        #endif
    }

    private static func sysctlInt(_ name: String) -> Int? {
        var value: Int32 = 0
        var size = MemoryLayout<Int32>.size
        return sysctlbyname(name, &value, &size, nil, 0) == 0 ? Int(value) : nil
    }

    static var thermalState: String { name(ProcessInfo.processInfo.thermalState) }

    static func name(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: "nominal"
        case .fair: "fair"
        case .serious: "serious"
        case .critical: "critical"
        @unknown default: "unknown"
        }
    }
}

/// The on-device model's last load time on this phone (the status's `local.lastLoadMs`), kept across launches in
/// UserDefaults with the versions of the app and of iOS it was measured under: after an install, an app update or an
/// iOS update there is none until the next load, which is the slow one (Metal prepares llama.cpp's shaders: about 15 s
/// on an iPhone 13 mini, about 1.3 s once they are ready). The page loads the model on entering the world only until a
/// load has been quick; after that, when the player starts to chat (host.js lm.warm).
struct ModelLoadRecord {
    static let key = "LostCity.lm.lastLoad"
    let defaults: UserDefaults
    /// What a record holds for: this app's version and build, and the system's.
    let versions: String

    init(defaults: UserDefaults = .standard, versions: String = ModelLoadRecord.currentVersions) {
        self.defaults = defaults
        self.versions = versions
    }

    /// e.g. "1.0.0 (10000), Version 26.0 (Build 23A341)"
    static var currentVersions: String {
        let info = Bundle.main.infoDictionary
        let app = "\(info?["CFBundleShortVersionString"] as? String ?? "0") (\(info?["CFBundleVersion"] as? String ?? "0"))"
        return "\(app), \(ProcessInfo.processInfo.operatingSystemVersionString)"
    }

    /// The last load's time (ms), when it was measured under these versions.
    var lastLoadMs: Double? {
        guard let record = defaults.dictionary(forKey: Self.key), record["versions"] as? String == versions,
              let ms = record["ms"] as? Double, ms > 0
        else { return nil }
        return ms
    }

    func record(_ ms: Double) {
        defaults.set(["versions": versions, "ms": ms], forKey: Self.key)
    }
}
