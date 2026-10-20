import Foundation

// The bots' chat model's native router on the Mac (web/test/native/lm-harness.mjs builds and runs this): the app's own
// BotChatModel, OnlineModel and LocalModel (LostCity/*.swift, compiled with the macOS slice of llama.cpp's framework)
// against the local mock of the Messages API (web/test/lm/mock-claude.mjs), so the online path is tested without a key
// and the fallback chain without a phone. The key comes from a stand-in (the Keychain is the app's). With a model whose
// template is 'qwen-chatml-hybrid' (the base model as a stand-in: model.json beside it, then ios/scripts/prepare-model.sh) the
// requests' think (Settings › Bot chat › Think first) is tested too: the note when asked, never in the reply; and the
// templates that decide alone (the same GGUF told it is the note variant, or the plain model).
//
//   lm-harness <mock url> <model folder | none> <bench-prompts.json>
// Prints `CHECK <ok|FAIL> <name> — <detail>` lines and `DONE pass=N fail=M`.

let args = CommandLine.arguments
guard args.count >= 4 else {
    print("usage: lm-harness <mock url> <model folder | none> <bench-prompts.json>")
    exit(2)
}
let mockURL = URL(string: args[1])!
let modelInfo = args[2] == "none" ? nil : ModelInfo.load(folder: URL(fileURLWithPath: args[2]))
let promptsJSON = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[3]))) as! [String: Any]
let prompts = (promptsJSON["prompts"] as! [[String: Any]])
let local = prompts[0]["local"] as! [String: String]
let online = prompts[0]["online"] as! [String: String]

@MainActor
final class Harness {
    let model: BotChatModel
    var key: String?
    /// replies as JSON text (Sendable), by id: a continuation waiting for one, or the reply that came first (busy
    /// answers come at once, inside handle())
    var waiters: [Int: CheckedContinuation<String, Never>] = [:]
    var received: [Int: String] = [:]
    var statuses: [[String: Any]] = []
    var nextId = 1
    /// the memory warning's two requests, by order
    var released: [Int: Result<LocalModel.Output, LocalModel.Failure>] = [:]
    var pass = 0
    var fail = 0

    init(modelInfo: ModelInfo?, mockURL: URL) {
        model = BotChatModel(local: LocalModel(info: modelInfo))
        model.online.endpoint = mockURL
        model.readKey = { [weak self] in self?.key }
        model.onReply = { [weak self] reply in
            guard let self, let id = reply["id"] as? Int,
                  let data = try? JSONSerialization.data(withJSONObject: reply), let json = String(data: data, encoding: .utf8)
            else { return }
            if let waiter = self.waiters.removeValue(forKey: id) {
                waiter.resume(returning: json)
            } else {
                self.received[id] = json
            }
        }
        model.onStatus = { [weak self] status in self?.statuses.append(status) }
    }

    func check(_ name: String, _ ok: Bool, _ detail: String = "") {
        if ok { pass += 1 } else { fail += 1 }
        print("CHECK \(ok ? "ok" : "FAIL") \(name)\(detail.isEmpty ? "" : " — \(detail)")")
    }

    /// A request as the page sends it; its id. `think`: Settings › Bot chat › Think first (nil: a request without it).
    func send(mode: String, fallback: Bool? = nil, think: Bool? = nil, timeoutMs: Int = 9000) -> Int {
        let id = nextId
        nextId += 1
        var message: [String: Any] = ["type": "lm", "id": id, "mode": mode, "local": local, "online": online, "maxChars": 80, "timeoutMs": timeoutMs]
        if let fallback { message["fallback"] = fallback }
        if let think { message["think"] = think }
        model.handle(message)
        return id
    }

    /// The reply to request `id`, as the page hears it.
    func answer(_ id: Int) async -> [String: Any] {
        let json: String
        if let ready = received.removeValue(forKey: id) {
            json = ready
        } else {
            json = await withCheckedContinuation { waiters[id] = $0 }
        }
        return (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]) ?? [:]
    }

    func ask(mode: String, fallback: Bool? = nil, think: Bool? = nil, timeoutMs: Int = 9000) async -> [String: Any] {
        await answer(send(mode: mode, fallback: fallback, think: think, timeoutMs: timeoutMs))
    }

    /// The on-device model asked directly (not through the router): its whole output, the note included.
    func generate(_ localModel: LocalModel, think: Bool) async -> Result<LocalModel.Output, LocalModel.Failure> {
        await withCheckedContinuation { continuation in
            localModel.generate(system: local["system"] ?? "", user: local["user"] ?? "", think: think, deadline: .now() + .seconds(30)) { result in
                continuation.resume(returning: result)
            }
        }
    }

    var onlineStatus: [String: Any] { model.status["online"] as? [String: Any] ?? [:] }
    var localThink: String? { (model.status["local"] as? [String: Any])?["think"] as? String }

    func describe(_ reply: [String: Any]) -> String {
        "source \(reply["source"].map { "\($0)" } ?? "?"), error \(reply["error"].map { "\($0)" } ?? "none"), \(Int(reply["ms"] as? Double ?? -1)) ms: \(reply["text"] as? String ?? "(no text)")"
    }

    /// The timings' note fields, for a check's detail.
    func noteOf(_ reply: [String: Any]) -> String {
        let t = reply["timings"] as? [String: Any] ?? [:]
        return "think \((t["think"] as? Bool).map { $0 ? "on" : "off" } ?? "-"), note \(t["noteTokens"].map { "\($0)" } ?? "-") tokens in \(t["noteMs"].map { "\($0)" } ?? "-") ms, reply \(t["generatedTokens"].map { "\($0)" } ?? "-") tokens, total \(t["totalMs"].map { "\($0)" } ?? "-") ms"
    }

    /// A reply written with the note (timings' think, noteTokens > 0) whose text has no trace of the think block.
    func notedReply(_ reply: [String: Any]) -> Bool {
        let t = reply["timings"] as? [String: Any] ?? [:]
        let text = reply["text"] as? String ?? ""
        return t["think"] as? Bool == true && t["noteTokens"] as? Int ?? 0 > 0 && reply["note"] == nil && !text.contains("think>")
    }

    /// A reply written without the note.
    func plainReply(_ reply: [String: Any]) -> Bool {
        let t = reply["timings"] as? [String: Any] ?? [:]
        return t["think"] as? Bool == false && t["noteTokens"] == nil && t["noteMs"] == nil && reply["note"] == nil
    }

    func run() async {
        let hasLocal = model.local.available
        print("INFO local model: \(modelInfo?.name ?? "none") (available \(hasLocal))")

        // warm: the model loads ahead of the first request (the page asks when the player enters the world)
        if hasLocal {
            model.warm()
            var waited = 0
            while !model.local.isLoaded, waited < 600 {
                try? await Task.sleep(for: .milliseconds(100))
                waited += 1
            }
            check("warm: the model loads ahead of the first request", model.local.isLoaded, "load \(model.local.lastLoad.map { "\($0.map { Int($0) })" } ?? "?") ms (total, model, context)")
        }

        // no key: the status says so; Claude online with the fallback answers from the model in the app (or not at all)
        key = nil
        check("status: no key, the model in the app as it is", onlineStatus["keySet"] as? Bool == false && (model.status["local"] as? [String: Any])?["available"] as? Bool == hasLocal, "\(model.status)")
        var reply = await ask(mode: "online")
        check("online without a key: the on-device model answers (else unavailable)", hasLocal ? reply["source"] as? String == "local" && reply["text"] is String : reply["error"] as? String == "unavailable", describe(reply))
        reply = await ask(mode: "online", fallback: false)
        check("online without a key, no fallback (the Test): unavailable", reply["error"] as? String == "unavailable" && reply["text"] is NSNull, describe(reply))
        key = "sk-ant-test-ok-abcd"
        reply = await ask(mode: "rules")
        check("a request in Rules mode is answered with nothing (unavailable), even with a key", reply["text"] is NSNull, describe(reply))
        key = nil

        if hasLocal {
            reply = await ask(mode: "local")
            let timings = reply["timings"] as? [String: Any]
            check("local: a line from the model in the app, with its timings", reply["source"] as? String == "local" && (reply["text"] as? String)?.isEmpty == false && timings?["promptTokens"] as? Int ?? 0 > 0, describe(reply))
        } else {
            reply = await ask(mode: "local")
            check("local with no model in the app: unavailable at once", reply["error"] as? String == "unavailable", describe(reply))
        }

        // Think first: the status says whether the model writes its short
        // note before a reply (model.json's template); one trained in both modes ('qwen-chatml-hybrid') writes it when the
        // request asks (think), and the note is never part of the reply
        let support = hasLocal ? modelInfo?.think.rawValue ?? "never" : "never"
        check("status: local.think says whether the model writes its note (\(support), template \(modelInfo?.template ?? "none"))", localThink == support, "\(model.status["local"] ?? [:])")
        if model.local.thinkSupport == .option {
            reply = await ask(mode: "local", think: false)
            check("think off: the reply at once, no note", reply["source"] as? String == "local" && plainReply(reply), "\(describe(reply)); \(noteOf(reply))")
            let plainMs = (reply["timings"] as? [String: Any])?["totalMs"] as? Double ?? 0
            reply = await ask(mode: "local")
            check("a request without think: as off", reply["source"] as? String == "local" && plainReply(reply), "\(describe(reply)); \(noteOf(reply))")
            reply = await ask(mode: "local", think: true)
            check("think on: the note first (noteTokens), then the reply; nothing of the note in what the page gets", reply["source"] as? String == "local" && notedReply(reply), "\(describe(reply)); \(noteOf(reply)) (off: \(Int(plainMs)) ms)")
            // the model's whole output: the note it wrote, and the reply apart from it
            switch await generate(model.local, think: true) {
            case .success(let output):
                let note = output.note ?? ""
                check("think on, the model's own output: a note, and a reply that does not contain it", !note.isEmpty && !output.text.contains(note) && !output.text.contains("think>") && output.timings.noteTokens > 0,
                      "note \(output.timings.noteTokens) tokens: \(note.prefix(160).replacingOccurrences(of: "\n", with: " / "))… | reply: \(output.text)")
            case .failure(let failure):
                check("think on, the model's own output: a note, and a reply that does not contain it", false, "\(failure)")
            }
            reply = await ask(mode: "local", think: false)
            check("think off again: no note (the switch is per request)", reply["source"] as? String == "local" && plainReply(reply), "\(describe(reply)); \(noteOf(reply))")
        }

        // a good key: Claude answers; the status learns the key works and shows its last four characters
        key = "sk-ant-test-ok-abcd"
        reply = await ask(mode: "online")
        check("online: Claude's line (source online, usage)", reply["source"] as? String == "online" && reply["text"] as? String == "hey whats up" && reply["usage"] != nil, describe(reply))
        check("status: key set, ends in …abcd, valid", onlineStatus["keySet"] as? Bool == true && onlineStatus["hint"] as? String == "…abcd" && onlineStatus["valid"] as? Bool == true, "\(onlineStatus)")
        reply = await ask(mode: "online")
        let usage = reply["usage"] as? [String: Any]
        check("online again: the guide is read from the cache", usage?["cacheRead"] as? Int ?? 0 > 0, "\(usage ?? [:])")
        // (Claude online ignores think: its request stays the same, which the runner checks in every request the mock got)
        reply = await ask(mode: "online", think: true)
        check("online with think: Claude's line, as without it", reply["source"] as? String == "online" && reply["text"] is String && reply["timings"] == nil, describe(reply))

        // failures fall back to the model in the app; the status says what went wrong
        for (problemKey, problem, reason) in [("sk-ant-test-bad-1234", "key refused", "refused"), ("sk-ant-test-rate-1111", "rate limited", "failed: rate limited"),
                                              ("sk-ant-test-busy-2222", "overloaded", "failed: overloaded"), ("sk-ant-test-broke-3333", "error 500", "failed: http 500"),
                                              ("sk-ant-test-refuse-4444", "declined", "refused"), ("sk-ant-test-empty-5555", "empty reply", "failed: empty")] {
            key = problemKey
            reply = await ask(mode: "online")
            let fellBack = hasLocal ? reply["source"] as? String == "local" && reply["text"] is String : reply["error"] as? String == reason
            check("online, \(problem): \(hasLocal ? "the on-device model answers" : "null, \(reason)")", fellBack, describe(reply))
            check("status after \(problem)", onlineStatus["problem"] as? String == problem && (problem == "key refused" ? onlineStatus["valid"] as? Bool == false : true), "\(onlineStatus)")
            reply = await ask(mode: "online", fallback: false)
            check("online, \(problem), no fallback (the Test): null, \(reason)", reply["text"] is NSNull && reply["error"] as? String == reason, describe(reply))
        }

        // Claude's fallback to the on-device model keeps the request's think (Claude failing, or no key)
        if model.local.thinkSupport == .option {
            key = "sk-ant-test-broke-8888"
            reply = await ask(mode: "online", think: true)
            check("online, Claude failing, think on: the on-device model answers with its note", reply["source"] as? String == "local" && notedReply(reply), "\(describe(reply)); \(noteOf(reply))")
            reply = await ask(mode: "online", think: false)
            check("online, Claude failing, think off: the on-device model answers without one", reply["source"] as? String == "local" && plainReply(reply), "\(describe(reply)); \(noteOf(reply))")
            key = nil
            reply = await ask(mode: "online", think: true)
            check("online without a key, think on: the on-device model answers with its note", reply["source"] as? String == "local" && notedReply(reply), "\(describe(reply)); \(noteOf(reply))")
        }

        // the template decides who decides: a note variant writes its note always, the first 2004 model (and a template
        // this build does not know) never, whatever the request asks; the status says which (the same GGUF, told otherwise)
        if hasLocal, let info = modelInfo {
            for (template, support, asked) in [(LocalModel.thinkTemplate, "always", false), (LocalModel.plainTemplate, "never", true), ("qwen-chatml-unknown", "never", true)] {
                let variant = ModelInfo(name: info.name, file: info.file, bytes: info.bytes, sha256: info.sha256, ctx: info.ctx, template: template, url: info.url)
                let other = BotChatModel(local: LocalModel(info: variant))
                let status = (other.status["local"] as? [String: Any])?["think"] as? String
                let writes = support == "always"
                switch await generate(other.local, think: asked) {
                case .success(let output):
                    check("template \(template): status think '\(support)'; asked \(asked ? "on" : "off"), \(writes ? "the note anyway" : "no note")",
                          status == support && output.timings.think == writes && (output.timings.noteTokens > 0) == writes && (output.note != nil) == writes,
                          "status \(status ?? "-"), note \(output.timings.noteTokens) tokens, reply: \(output.text)")
                case .failure(let failure):
                    check("template \(template): status think '\(support)'; asked \(asked ? "on" : "off"), \(writes ? "the note anyway" : "no note")", false, "\(failure)")
                }
                other.local.unload(reason: "harness: template \(template)")
            }
        }

        // a slow API: Claude is given up on within the request's time
        key = "sk-ant-test-slow-6666"
        let started = Date()
        reply = await ask(mode: "online", fallback: false, timeoutMs: 3000)
        let waited = Date().timeIntervalSince(started)
        check("online, slow: given up within the request's 3 s (timeout)", reply["error"] as? String == "timeout" && waited < 4.5, "\(String(format: "%.1f", waited)) s, \(describe(reply))")

        // a hot phone: no on-device reply ('busy'), Claude still answers
        if hasLocal {
            model.thermalState = { .serious }
            key = nil
            reply = await ask(mode: "local")
            check("a hot phone (thermal serious): the on-device model does not run (busy)", reply["error"] as? String == "busy" && reply["text"] is NSNull, describe(reply))
            key = "sk-ant-test-ok-hot1"
            reply = await ask(mode: "online")
            check("a hot phone: Claude online still answers", reply["source"] as? String == "online", describe(reply))
            model.thermalState = { .nominal }
        }

        // memory: a load needs room; a memory warning stops the reply being written and drops those waiting
        if hasLocal {
            let tight = LocalModel(info: modelInfo, availableMemory: { 100 << 20 })
            let refused = await generate(tight, think: false)
            check("100 MB left for the app: the model is not loaded (unavailable)", { if case .failure(.unavailable) = refused { true } else { false } }() && !tight.isLoaded, "\(refused)")

            let roomy = LocalModel(info: modelInfo, availableMemory: { 2 << 30 })
            _ = await generate(roomy, think: false)
            released = [:]
            for (i, think) in [true, false].enumerated() {
                roomy.generate(system: local["system"] ?? "", user: local["user"] ?? "", think: think, deadline: .now() + .seconds(30)) { [weak self] result in
                    self?.released[i] = result
                }
            }
            try? await Task.sleep(for: .milliseconds(50))
            let warned = Date()
            roomy.release(reason: "harness: memory warning")
            while released.count < 2 || roomy.isLoaded, Date().timeIntervalSince(warned) < 10 {
                try? await Task.sleep(for: .milliseconds(10))
            }
            let freedIn = Date().timeIntervalSince(warned)
            func aborted(_ result: Result<LocalModel.Output, LocalModel.Failure>?) -> Bool {
                if case .failure(.aborted) = result { true } else { false }
            }
            check("a memory warning: the reply being written stops (interrupted)", aborted(released[0]), "\(released[0].map { "\($0)" } ?? "none")")
            check("a memory warning: the request waiting is dropped (interrupted)", aborted(released[1]), "\(released[1].map { "\($0)" } ?? "none")")
            check("a memory warning: the model is freed within 1 s", !roomy.isLoaded && freedIn < 1, "\(Int(freedIn * 1000)) ms")
            let after = await generate(roomy, think: false)
            check("a request after the warning loads the model again", { if case .success = after { true } else { false } }() && roomy.isLoaded, "\(after)")
            roomy.unload(reason: "harness: memory")
        }

        // more than 3 at once: busy
        key = "sk-ant-test-slow-7777"
        let ids = (0 ..< 4).map { _ in send(mode: "online", fallback: false, timeoutMs: 2000) }
        var errors: [String] = []
        for id in ids {
            errors.append((await answer(id))["error"] as? String ?? "-")
        }
        check("4 requests at once: the fourth is busy at once, the others wait", errors == ["timeout", "timeout", "timeout", "busy"], errors.joined(separator: ", "))

        key = nil
        print("DONE pass=\(pass) fail=\(fail)")
    }
}

let done = DispatchSemaphore(value: 0)
Task { @MainActor in
    let harness = Harness(modelInfo: modelInfo, mockURL: mockURL)
    await harness.run()
    harness.model.local.unload(reason: "harness done")
    try? await Task.sleep(for: .milliseconds(500))
    exit(harness.fail == 0 ? 0 : 1)
}
while done.wait(timeout: .now() + 0.05) == .timedOut {
    RunLoop.main.run(until: Date() + 0.05)
}
