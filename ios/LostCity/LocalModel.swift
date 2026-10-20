import Foundation
#if canImport(llama)
import llama
#endif
#if os(iOS)
import os
#endif

/// The bundled model, as `ios/scripts/prepare-model.sh` describes it in `Model/model.json`: `{name, file, bytes, sha256, ctx,
/// template}`. nil when the app has no model (an empty `Model/`), or the build has no llama.cpp (the simulator: llama.cpp's
/// release has no simulator slice).
nonisolated struct ModelInfo: Sendable {
    let name: String
    let file: String
    let bytes: Int
    let sha256: String
    let ctx: Int
    /// 'qwen-chatml-nothink', 'qwen-chatml-think' or 'qwen-chatml-hybrid': whether the model writes its note (`think`)
    let template: String
    let url: URL

    /// Whether the model writes a reasoning note before its reply, as its template says.
    var think: LocalModel.ThinkSupport { LocalModel.ThinkSupport(template: template) }

    static func load(folder: URL? = Bundle.main.url(forResource: "Model", withExtension: nil)) -> ModelInfo? {
        guard let folder,
              let data = try? Data(contentsOf: folder.appendingPathComponent("model.json")),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let file = json["file"] as? String, !file.isEmpty, !file.contains("/")
        else { return nil }
        let url = folder.appendingPathComponent(file)
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size > 0 else { return nil }
        return ModelInfo(name: json["name"] as? String ?? file, file: file, bytes: json["bytes"] as? Int ?? size,
                         sha256: json["sha256"] as? String ?? "", ctx: json["ctx"] as? Int ?? 1024,
                         template: json["template"] as? String ?? "qwen-chatml-nothink", url: url)
    }
}

/// The bots' on-device chat model: llama.cpp (Metal) running the bundled GGUF (Qwen3.5 0.8B, Q4_K_M; with the 2004 LoRA
/// fused in once the training is done), in the app process: not the game's WebContent process, whose memory it would
/// share (docs/ARCHITECTURE.md §7.1).
///
/// - Loaded lazily, at the first request, when the app has room for it (`Options.minFreeToLoad`); unloaded after 5 idle
///   minutes, on a memory warning (`release`: the reply being written stops first) and in the background.
/// - One generation at a time, on its own serial queue (`generate` from any thread; the completion comes on the main
///   queue). All llama.cpp state is confined to that queue.
/// - The prompt is the engine's `renderLocal` (a system and a user turn) in Qwen's chat template with the empty think
///   block (thinking off), exactly as the model was trained (the engine's sampling settings, docs/ARCHITECTURE.md §7.1): temperature 0.8, top-p 0.9, top-k 40, a
///   repetition penalty of 1.1 over the last 64 tokens, at most 40 tokens, one line of the chat's characters (a GBNF
///   grammar), stopping at a newline, `<|im_end|>`, the end of text or a think block marker.
/// - A model trained to write a short note first (`ThinkSupport`, from model.json's template) gets the think block open
///   instead and writes the note before the reply: always ('qwen-chatml-think'), or when the request asks for it
///   ('qwen-chatml-hybrid': one model in both modes, Settings › Bot chat › Think first).
/// - The tokens of the last prompt stay in the context; a prompt that starts the same way reuses them where the model's
///   memory allows it (Qwen3.5 is a hybrid: its recurrent layers cannot be cut back, so it usually starts afresh).
nonisolated final class LocalModel: @unchecked Sendable {
    nonisolated struct Options: Sendable {
        /// Threads for the CPU's share (the GPU does the layers): the game's client draws on the CPU, so few.
        var threads: Int32 = 2
        var batchThreads: Int32 = 2
        /// Layers on the GPU (99: all).
        var gpuLayers: Int32 = 99
        var temperature: Float = 0.8
        var topP: Float = 0.9
        var topK: Int32 = 40
        var repeatPenalty: Float = 1.1
        var repeatLastN: Int32 = 64
        var maxTokens = 40
        /// The grammar's longest line (the engine's guard cuts to 80).
        var maxChars = 120
        /// Unloaded after this long without a request.
        var idleUnload: TimeInterval = 5 * 60
        /// Not loaded when the app has less than this left before iOS ends it (`os_proc_available_memory`): a load adds
        /// well under that to the footprint (the phone's bench: at most 161 MB in all with the model in, its weights mapped
        /// and on Metal), so this is room left for the game.
        var minFreeToLoad: UInt64 = 256 << 20
    }

    nonisolated struct Timings: Sendable {
        /// The model's load, when this request loaded it.
        var loadMs: Double?
        var promptTokens = 0
        /// Prompt tokens already in the context (not evaluated again).
        var reusedTokens = 0
        var promptMs: Double = 0
        var generatedTokens = 0
        var generateMs: Double = 0
        /// A token the grammar refused, sampled again from the whole vocabulary.
        var resampled = 0
        /// The model wrote its note before the reply (the request's mode, as the model's `ThinkSupport` allows it).
        var think = false
        /// (think) the note's tokens and its time (the think block's close and the blank line after it included);
        /// `generatedTokens` and `generateMs` are then the reply's alone
        var noteTokens = 0
        var noteMs: Double = 0
        var totalMs: Double = 0

        var promptTokensPerSecond: Double { promptMs > 0 ? Double(promptTokens - reusedTokens) * 1000 / promptMs : 0 }
        var generateTokensPerSecond: Double { generateMs > 0 ? Double(generatedTokens) * 1000 / generateMs : 0 }

        var dictionary: [String: Any] {
            var out: [String: Any] = [
                "promptTokens": promptTokens, "reusedTokens": reusedTokens, "promptMs": Self.round(promptMs),
                "promptTps": Self.round(promptTokensPerSecond), "generatedTokens": generatedTokens,
                "generateMs": Self.round(generateMs), "generateTps": Self.round(generateTokensPerSecond),
                "resampled": resampled, "think": think, "totalMs": Self.round(totalMs),
            ]
            if let loadMs { out["loadMs"] = Self.round(loadMs) }
            if think {
                out["noteTokens"] = noteTokens
                out["noteMs"] = Self.round(noteMs)
            }
            return out
        }

        private static func round(_ value: Double) -> Double { (value * 10).rounded() / 10 }
    }

    nonisolated enum Failure: Error, CustomStringConvertible {
        case unavailable(String)
        case timeout
        case aborted
        case failed(String)

        /// The reason as the page protocol words it (ARCHITECTURE.md §7.1).
        var description: String {
            switch self {
            case .unavailable: "unavailable"
            case .timeout: "timeout"
            case .aborted: "failed: interrupted"
            case .failed(let why): "failed: \(why)"
            }
        }
    }

    nonisolated struct Output: Sendable {
        let text: String
        let timings: Timings
        /// (the note variant) the note the model wrote before its reply; nil for a model without one
        var note: String? = nil
    }

    /// (the note variant) the model writes a short note in Qwen's think block before its reply
    /// ("asks: my inventory. uses: carrying 3 rune full helm. tone: blunt."): the prompt opens the block, the note is
    /// sampled freely up to the block's close (at most `noteMaxTokens`, then closed for it), the reply as without one.
    /// Only the reply is the answer: the page never gets the note (`Output.note` is for the logs and the bench).
    ///
    /// Which models write it (model.json's template):
    /// - `never`: 'qwen-chatml-nothink' (the first 2004 model; also a template this build does not know)
    /// - `always`: 'qwen-chatml-think' (the note variant)
    /// - `option`: 'qwen-chatml-hybrid' (one model trained in both modes, Qwen3.5's thinking switch): the request decides
    ///   (Settings › Bot chat › Think first, the page's `think` with every request)
    ///
    /// The status's `local.think` (docs/ARCHITECTURE.md §7.1).
    nonisolated enum ThinkSupport: String, Sendable {
        case never, always, option

        init(template: String) {
            switch template {
            case LocalModel.thinkTemplate: self = .always
            case LocalModel.hybridTemplate: self = .option
            default: self = .never
            }
        }

        /// Whether a request writes the note: what it asked where the model offers the choice, else the model's way.
        func writesNote(asked: Bool) -> Bool {
            switch self {
            case .never: false
            case .always: true
            case .option: asked
            }
        }
    }

    static let plainTemplate = "qwen-chatml-nothink"
    static let thinkTemplate = "qwen-chatml-think"
    static let hybridTemplate = "qwen-chatml-hybrid"
    private static let noteMaxTokens = 64

    /// The model in the app, or nil.
    let info: ModelInfo?
    /// True when this build can run a model at all (llama.cpp linked: device builds).
    static var compiled: Bool {
        #if canImport(llama)
        true
        #else
        false
        #endif
    }

    var available: Bool { Self.compiled && info != nil }
    /// Why there is no model, in the page's words (Settings › Bot chat).
    var unavailableReason: String? {
        if !Self.compiled { return "simulator" }
        if info == nil { return "no-model" }
        return nil
    }
    /// Whether the model here writes its note (`never` when no model can run here: none in the app, or the simulator).
    var thinkSupport: ThinkSupport { available ? info?.think ?? .never : .never }

    var options: Options {
        get { lock.withLock { _options } }
        set { lock.withLock { _options = newValue } }
    }

    /// Whether the model is in memory (read on any thread).
    var isLoaded: Bool { lock.withLock { loaded } }
    /// The last load: [total, model, context] ms (the phone spike's log), or nil.
    var lastLoad: [Double]? { lock.withLock { _lastLoad } }
    /// Called on the main queue when the model is loaded or unloaded.
    var onLoadedChange: (@MainActor @Sendable (Bool) -> Void)? {
        get { lock.withLock { _onLoadedChange } }
        set { lock.withLock { _onLoadedChange = newValue } }
    }

    private let queue = DispatchQueue(label: "lostcity.local-model", qos: .userInitiated)
    private let lock = NSLock()
    // (lock) shared with the main thread
    private var _options = Options()
    private var loaded = false
    private var _lastLoad: [Double]?
    private var _onLoadedChange: (@MainActor @Sendable (Bool) -> Void)?
    private var suspended = false
    private var abortRequested = false
    private var pending = 0
    /// bumped by `release`: a request asked before it stops (the one running at its next token, those waiting at once)
    private var epoch = 0

    // (queue) llama.cpp state
    #if canImport(llama)
    private var model: OpaquePointer?
    private var context: OpaquePointer?
    private var vocab: OpaquePointer?
    private var candidates: [llama_token_data] = []
    private var cached: [llama_token] = []
    /// the model keeps a recurrent state (Qwen3.5's linear-attention layers): only a pure extension reuses the context
    private var recurrent = false
    #endif
    private var idleWork: DispatchWorkItem?
    private var contextSize = 1024
    private var batchSize = 512

    /// How much more the app may use before iOS ends it, or nil where that is not known (the Mac: no check).
    private let availableMemory: @Sendable () -> UInt64?

    init(info: ModelInfo? = ModelInfo.load(), availableMemory: @escaping @Sendable () -> UInt64? = LocalModel.processAvailableMemory) {
        self.info = info
        self.availableMemory = availableMemory
    }

    static let processAvailableMemory: @Sendable () -> UInt64? = {
        #if os(iOS)
        DeviceStats.availableMemory
        #else
        nil
        #endif
    }

    /// Requests waiting or running.
    var queued: Int { lock.withLock { pending } }

    // MARK: - Requests

    /// Writes one reply. `think`: the request asks for the note first (it is written when the model offers the choice,
    /// `ThinkSupport.option`; a model that always or never writes one does as it was trained). `deadline`: past it the
    /// generation stops and fails with `.timeout`. The completion runs on the main queue.
    func generate(system: String, user: String, think: Bool, deadline: DispatchTime,
                  completion: @escaping @MainActor @Sendable (Result<Output, Failure>) -> Void) {
        guard available, let info else {
            DispatchQueue.main.async { completion(.failure(.unavailable(self.unavailableReason ?? "no-model"))) }
            return
        }
        let note = info.think.writesNote(asked: think)
        let epoch = lock.withLock {
            pending += 1
            return self.epoch
        }
        queue.async { [self] in
            let result: Result<Output, Failure>
            do {
                result = .success(try run(system: system, user: user, note: note, deadline: deadline, epoch: epoch))
            } catch let failure as Failure {
                result = .failure(failure)
            } catch {
                result = .failure(.failed(String(describing: error)))
            }
            lock.withLock { pending -= 1 }
            scheduleIdleUnload()
            DispatchQueue.main.async { completion(result) }
        }
    }

    /// Loads the model now if it is not in memory (in the background, on the model's queue), so that the next request does
    /// not wait for the load; the idle unload starts over.
    func warmUp() {
        guard available else { return }
        queue.async { [self] in
            #if canImport(llama)
            if model == nil, !lock.withLock({ suspended }) {
                do {
                    _ = try load()
                } catch {
                    Log.info("lm", "warming the local model failed: \(error)")
                }
            }
            #endif
            scheduleIdleUnload()
        }
    }

    /// Frees the model (the idle timer, the background). A generation running finishes first.
    func unload(reason: String) {
        queue.async { [self] in freeModel(reason: reason) }
    }

    /// Memory is short (a memory warning): the reply being written stops at its next token, the requests waiting fail at
    /// once (`.aborted`), and the model is freed right after them, not up to a reply's 9 s later. A request asked after
    /// this loads it again if the app has room (`Options.minFreeToLoad`).
    func release(reason: String) {
        lock.withLock { epoch += 1 }
        unload(reason: reason)
    }

    /// The app is inactive for a moment (Notification or Control Center, a call banner, a system alert): the generation
    /// running stops at its next token and nothing new starts until `resume`, but the model stays loaded (the review of
    /// the merge: every pull of Notification Center freed it, and the next reply paid the reload).
    func pause() {
        lock.withLock {
            suspended = true
            abortRequested = true
        }
    }

    /// The app is in the background: as `pause`, and the model is freed (no GPU work and no 0.5 GB held there).
    func suspend() {
        pause()
        unload(reason: "background")
    }

    func resume() {
        lock.withLock {
            suspended = false
            abortRequested = false
        }
    }

    // MARK: - On the queue

    private func shouldStop(_ deadline: DispatchTime, epoch: Int) throws {
        if lock.withLock({ abortRequested || suspended || epoch != self.epoch }) { throw Failure.aborted }
        if DispatchTime.now() >= deadline { throw Failure.timeout }
    }

    private func scheduleIdleUnload() {
        idleWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.lock.withLock({ self.pending }) == 0 else { return }
            self.freeModel(reason: "idle")
        }
        idleWork = work
        queue.asyncAfter(deadline: .now() + options.idleUnload, execute: work)
    }

    private static func ms(since start: UInt64) -> Double {
        Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
    }

    #if canImport(llama)
    /// While the model loads, llama.cpp's own account of it goes to the log too (where the time goes), its per-tensor and
    /// per-key lines left out.
    nonisolated(unsafe) private static var loading = false

    private static let backend: Void = {
        llama_log_set({ level, text, _ in
            guard let text else { return }
            let line = String(cString: text).trimmingCharacters(in: .newlines)
            guard !line.isEmpty, line != "." else { return }
            if level == GGML_LOG_LEVEL_ERROR || level == GGML_LOG_LEVEL_WARN {
                Log.info("llama", line)
            } else if LocalModel.loading, !LocalModel.noisy.contains(where: { line.hasPrefix($0) }) {
                Log.info("llama", line)
            } else {
                Log.debug("llama", line)
            }
        }, nil)
        llama_backend_init()
    }()

    private static let noisy = ["llama_model_loader: - ", "load_tensors: layer", "print_info:", "load: control token", "llama_kv_cache: layer",
                                "llama_memory_recurrent, layer", "llama_memory_recurrent: layer", "graph_reserve:", "load:   - ", "llama_model_loader: Dumping"]

    private func load() throws -> Double {
        guard let info else { throw Failure.unavailable("no-model") }
        let opts = options
        if let free = availableMemory(), free < opts.minFreeToLoad {
            Log.info("lm", "the local model is not loaded: \(free >> 20) MB left for the app, \(opts.minFreeToLoad >> 20) MB needed")
            throw Failure.unavailable("memory")
        }
        let started = DispatchTime.now().uptimeNanoseconds
        Self.loading = true
        defer { Self.loading = false }
        _ = Self.backend
        var params = llama_model_default_params()
        params.n_gpu_layers = opts.gpuLayers
        guard let loadedModel = llama_model_load_from_file(info.url.path, params) else {
            throw Failure.failed("the model did not load")
        }
        let modelMs = Self.ms(since: started)
        contextSize = max(256, info.ctx)
        batchSize = min(512, contextSize)
        var cparams = llama_context_default_params()
        cparams.n_ctx = UInt32(contextSize)
        cparams.n_batch = UInt32(batchSize)
        cparams.n_ubatch = UInt32(batchSize)
        cparams.n_seq_max = 1
        // Only the last token's logits are read: one output. (The default, an output per token of a 512-token batch,
        // reserves 512 x 248k logits: a 490 MB compute buffer instead of about 30.)
        cparams.n_outputs_max = 1
        cparams.n_outputs_max_per_seq = 1
        cparams.n_threads = opts.threads
        cparams.n_threads_batch = opts.batchThreads
        cparams.no_perf = true
        guard let loadedContext = llama_init_from_model(loadedModel, cparams) else {
            llama_model_free(loadedModel)
            throw Failure.failed("no context for the model")
        }
        model = loadedModel
        context = loadedContext
        vocab = llama_model_get_vocab(loadedModel)
        recurrent = llama_model_is_recurrent(loadedModel) || llama_model_is_hybrid(loadedModel)
        candidates = Array(repeating: llama_token_data(id: 0, logit: 0, p: 0), count: Int(llama_vocab_n_tokens(vocab)))
        cached = []
        let elapsed = Self.ms(since: started)
        lock.withLock {
            loaded = true
            _lastLoad = [elapsed, modelMs, elapsed - modelMs]
        }
        Log.info("lm", "local model loaded in \(Int(elapsed)) ms (model \(Int(modelMs)) ms, context \(Int(elapsed - modelMs)) ms): \(info.name) (\(info.bytes / 1_048_576) MB, \(llama_model_n_layer(loadedModel)) layers, ctx \(contextSize), \(opts.gpuLayers >= llama_model_n_layer(loadedModel) ? "all" : String(opts.gpuLayers)) on the GPU, \(opts.threads) threads)")
        notifyLoaded(true)
        return elapsed
    }

    private func freeModel(reason: String) {
        idleWork?.cancel()
        idleWork = nil
        guard model != nil || context != nil else { return }
        if let context { llama_free(context) }
        if let model { llama_model_free(model) }
        context = nil
        model = nil
        vocab = nil
        candidates = []
        cached = []
        lock.withLock { loaded = false }
        Log.info("lm", "local model unloaded (\(reason))")
        notifyLoaded(false)
    }

    private func notifyLoaded(_ value: Bool) {
        guard let onLoadedChange else { return }
        DispatchQueue.main.async { onLoadedChange(value) }
    }

    private func tokenize(_ text: String, special: Bool) -> [llama_token] {
        let utf8 = Array(text.utf8)
        var tokens = [llama_token](repeating: 0, count: utf8.count + 8)
        var n = llama_tokenize(vocab, text, Int32(utf8.count), &tokens, Int32(tokens.count), false, special)
        if n < 0 {
            tokens = [llama_token](repeating: 0, count: Int(-n))
            n = llama_tokenize(vocab, text, Int32(utf8.count), &tokens, Int32(tokens.count), false, special)
        }
        return Array(tokens.prefix(Int(max(0, n))))
    }

    /// Qwen's chat template (ChatML) as its own template renders it: the turns trimmed, the template's markers as special
    /// tokens, the turns' text as plain text (a chat line can never become a marker). Thinking off: the empty think block;
    /// with the note (`note`, the template's enable_thinking): the block opened for the model to write in.
    private func promptTokens(system: String, user: String, note: Bool) -> [llama_token] {
        tokenize("<|im_start|>system\n", special: true)
            + tokenize(system.trimmingCharacters(in: .whitespacesAndNewlines), special: false)
            + tokenize("<|im_end|>\n<|im_start|>user\n", special: true)
            + tokenize(user.trimmingCharacters(in: .whitespacesAndNewlines), special: false)
            + tokenize(note ? "<|im_end|>\n<|im_start|>assistant\n<think>\n" : "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n", special: true)
    }

    private func decode(_ tokens: ArraySlice<llama_token>) -> Int32 {
        var chunk = Array(tokens)
        return chunk.withUnsafeMutableBufferPointer { buffer in
            llama_decode(context, llama_batch_get_one(buffer.baseAddress, Int32(buffer.count)))
        }
    }

    private func piece(_ token: llama_token) -> [UInt8] {
        var buffer = [CChar](repeating: 0, count: 64)
        var n = llama_token_to_piece(vocab, token, &buffer, Int32(buffer.count), 0, false)
        if n < 0 {
            buffer = [CChar](repeating: 0, count: Int(-n))
            n = llama_token_to_piece(vocab, token, &buffer, Int32(buffer.count), 0, false)
        }
        return buffer.prefix(Int(max(0, n))).map { UInt8(bitPattern: $0) }
    }

    /// One line of the chat's characters (274's chat: ASCII 32-122), at most `maxChars`.
    private static func grammar(maxChars: Int) -> String {
        "root ::= [ -z]{1,\(maxChars)}"
    }

    private func makeChain(_ opts: Options) -> UnsafeMutablePointer<llama_sampler> {
        let chain = llama_sampler_chain_init(llama_sampler_chain_default_params())!
        llama_sampler_chain_add(chain, llama_sampler_init_top_k(opts.topK))
        llama_sampler_chain_add(chain, llama_sampler_init_penalties(llama_vocab_n_tokens(vocab), opts.repeatLastN, opts.repeatPenalty, 0, 0))
        llama_sampler_chain_add(chain, llama_sampler_init_top_p(opts.topP, 1))
        llama_sampler_chain_add(chain, llama_sampler_init_temp(opts.temperature))
        llama_sampler_chain_add(chain, llama_sampler_init_dist(UInt32.random(in: 0 ... UInt32.max)))
        return chain
    }

    /// The last token's logits filtered by the grammar, then sampled by the chain (the rare case: the chain's own choice
    /// broke the grammar). The chain does not accept the token here.
    private func sampleWithGrammar(chain: UnsafeMutablePointer<llama_sampler>, grammar: UnsafeMutablePointer<llama_sampler>) -> llama_token {
        let logits = llama_get_logits_ith(context, -1)!
        return candidates.withUnsafeMutableBufferPointer { buffer in
            for i in 0 ..< buffer.count {
                buffer[i] = llama_token_data(id: llama_token(i), logit: logits[i], p: 0)
            }
            var array = llama_token_data_array(data: buffer.baseAddress, size: buffer.count, selected: -1, sorted: false)
            llama_sampler_apply(grammar, &array)
            llama_sampler_apply(chain, &array)
            guard array.selected >= 0, array.selected < array.size else { return llama_vocab_eos(vocab) }
            return array.data[Int(array.selected)].id
        }
    }

    private static func grammarAllows(_ grammar: UnsafeMutablePointer<llama_sampler>, _ token: llama_token) -> Bool {
        var single = llama_token_data(id: token, logit: 1, p: 0)
        return withUnsafeMutablePointer(to: &single) { pointer in
            var array = llama_token_data_array(data: pointer, size: 1, selected: -1, sorted: false)
            llama_sampler_apply(grammar, &array)
            return array.data[0].logit.isFinite
        }
    }

    /// One reply; `note`: the model writes its note first (`generate` decided it from the request and the model).
    private func run(system: String, user: String, note think: Bool, deadline: DispatchTime, epoch: Int) throws -> Output {
        let started = DispatchTime.now().uptimeNanoseconds
        var timings = Timings()
        timings.think = think
        // (one look under the lock: a suspend between a check and the reset would otherwise be lost)
        let suspendedNow = lock.withLock {
            if !suspended { abortRequested = false }
            return suspended
        }
        if suspendedNow { throw Failure.unavailable("background") }
        if lock.withLock({ self.epoch }) != epoch { throw Failure.aborted }  // (asked before a release: not loaded again for it)
        if model == nil {
            timings.loadMs = try load()
        }
        try shouldStop(deadline, epoch: epoch)
        let opts = options
        let prompt = promptTokens(system: system, user: user, note: think)
        timings.promptTokens = prompt.count
        guard prompt.count + opts.maxTokens + (think ? Self.noteMaxTokens + 2 : 0) < contextSize else {
            throw Failure.failed("the prompt is too long (\(prompt.count) tokens)")
        }

        // What the context holds of this prompt already (its recurrent layers may refuse to be cut back: start afresh).
        let memory = llama_get_memory(context)
        var keep = zip(cached, prompt).prefix { $0 == $1 }.count
        if keep >= prompt.count { keep = prompt.count - 1 }  // (the last token is evaluated again, for its logits)
        // (a recurrent or hybrid model, as Qwen3.5 is, keeps one state for the whole sequence: only a pure extension of
        // what it holds may reuse it. A cut back clears the recurrent state but keeps the attention's, and the reply is
        // computed from the two out of step: the review of the merge)
        if recurrent, keep != cached.count { keep = 0 }
        if keep > 0, !llama_memory_seq_rm(memory, 0, llama_pos(keep), -1) { keep = 0 }
        if keep == 0 { llama_memory_clear(memory, true) }
        cached = Array(prompt.prefix(keep))
        timings.reusedTokens = keep

        let promptStart = DispatchTime.now().uptimeNanoseconds
        var at = keep
        while at < prompt.count {
            try shouldStop(deadline, epoch: epoch)
            let end = min(prompt.count, at + batchSize)
            let rc = decode(prompt[at ..< end])
            guard rc == 0 else {
                llama_memory_clear(memory, true)
                cached = []
                throw Failure.failed("decode \(rc)")
            }
            cached.append(contentsOf: prompt[at ..< end])
            at = end
        }
        llama_synchronize(context)  // (decode returns before the GPU is done)
        timings.promptMs = Self.ms(since: promptStart)

        let chain = makeChain(opts)
        let grammar = llama_sampler_init_grammar(vocab, Self.grammar(maxChars: opts.maxChars), "root")
        defer {
            llama_sampler_free(chain)
            if let grammar { llama_sampler_free(grammar) }
        }
        let noteStart = DispatchTime.now().uptimeNanoseconds
        var note: String? = nil
        if think {
            // the note: sampled freely (no grammar) to the think block's close, then the blank line before the reply
            let close = tokenize("</think>", special: true)
            let blank = tokenize("\n\n", special: false)
            var noteBytes: [UInt8] = []
            var closed = false
            while timings.noteTokens < Self.noteMaxTokens {
                try shouldStop(deadline, epoch: epoch)
                let token = llama_sampler_sample(chain, context, -1)
                if close.count == 1, token == close[0] {
                    closed = true
                    break
                }
                if llama_vocab_is_eog(vocab, token) { break }
                noteBytes.append(contentsOf: piece(token))
                timings.noteTokens += 1
                let rc = decode([token][...])
                guard rc == 0 else {
                    llama_memory_clear(memory, true)
                    cached = []
                    throw Failure.failed("decode \(rc)")
                }
                cached.append(token)
            }
            // (the close as the model wrote it, or for it at the note's limit, after the note's own line break as trained:
            // "note\n</think>\n\n"; the blank line as trained)
            let noteEndsLine = noteBytes.last == 0x0A
            let tail = closed || noteEndsLine ? close + blank : tokenize("\n", special: false) + close + blank
            for token in closed ? blank : tail { llama_sampler_accept(chain, token) }  // (a sampled close is accepted)
            let rc = decode(tail[...])
            guard rc == 0 else {
                llama_memory_clear(memory, true)
                cached = []
                throw Failure.failed("decode \(rc)")
            }
            cached.append(contentsOf: tail)
            note = String(decoding: noteBytes, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            if !closed { Log.info("lm", "the note ran to \(Self.noteMaxTokens) tokens: closed for it") }
            llama_synchronize(context)  // (the close's decode, on the GPU, is the note's time)
            timings.noteMs = Self.ms(since: noteStart)
        }
        // (the think block's markers end the reply: Qwen's are plain added tokens, not control ones, and their text would
        // pass the grammar, so a confused model could start a second note there)
        let markers = Set([tokenize("<think>", special: true), tokenize("</think>", special: true)].filter { $0.count == 1 }.map { $0[0] })
        let generateStart = DispatchTime.now().uptimeNanoseconds
        var bytes: [UInt8] = []
        while timings.generatedTokens < opts.maxTokens {
            try shouldStop(deadline, epoch: epoch)
            // (llama.cpp's own way: the chain picks a token and accepts it, in C; only a token the grammar refuses makes
            // the whole vocabulary go through the grammar)
            var token = llama_sampler_sample(chain, context, -1)
            if let grammar, !Self.grammarAllows(grammar, token) {
                token = sampleWithGrammar(chain: chain, grammar: grammar)
                llama_sampler_accept(chain, token)
                timings.resampled += 1
            }
            if llama_vocab_is_eog(vocab, token) || llama_vocab_is_control(vocab, token) || markers.contains(token) { break }
            if let grammar { llama_sampler_accept(grammar, token) }
            let text = piece(token)
            if let newline = text.firstIndex(where: { $0 == 0x0A || $0 == 0x0D }) {
                bytes.append(contentsOf: text[..<newline])
                break
            }
            bytes.append(contentsOf: text)
            timings.generatedTokens += 1
            if bytes.count >= opts.maxChars || timings.generatedTokens >= opts.maxTokens { break }
            let rc = decode([token][...])
            guard rc == 0 else {
                llama_memory_clear(memory, true)
                cached = []
                throw Failure.failed("decode \(rc)")
            }
            cached.append(token)
        }
        timings.generateMs = Self.ms(since: generateStart)
        timings.totalMs = Self.ms(since: started)
        let text = String(decoding: bytes, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return Output(text: text, timings: timings, note: note)
    }
    #else
    private func freeModel(reason: String) {
        idleWork?.cancel()
        idleWork = nil
    }

    private func run(system: String, user: String, note: Bool, deadline: DispatchTime, epoch: Int) throws -> Output {
        throw Failure.unavailable("simulator")
    }
    #endif
}
