import Foundation

/// The bots' online chat model: Claude through the Messages API, with the player's own key (ModelKeyStore), when they
/// choose Claude online in Settings › Bot chat (docs/ARCHITECTURE.md §7.1). The prompt is the engine's `renderOnline`:
/// a static 2004 style guide (the same for every request, so it is cached), the bot's facts, and the chat.
///
/// Every field below was checked against the official API documentation on 2026-10-17:
/// - `POST https://api.anthropic.com/v1/messages` with the headers `x-api-key`, `anthropic-version: 2023-06-01` and
///   `content-type: application/json` (https://platform.claude.com/docs/en/api/overview).
/// - `model: "claude-haiku-5-5"`, the Claude API ID of Claude Haiku 5.5 (https://platform.claude.com/docs/en/models/overview).
/// - `max_tokens`, `system` as text blocks (a block takes `cache_control: {type: "ephemeral"}`), `messages`, `thinking`,
///   `output_config.effort` (https://platform.claude.com/docs/en/api/messages).
/// - Thinking off: Claude Haiku 5.5 thinks by default (thinking tokens count toward `max_tokens`, which a 60-token chat
///   line cannot spare) and "accepts `thinking: {type: "disabled"}` at effort high or below"
///   (https://platform.claude.com/docs/en/build-with-claude/thinking); effort `low`, "for chat, short tool tasks, and
///   simple, high-volume requests" (https://platform.claude.com/docs/en/build-with-claude/effort). No `temperature`,
///   `top_p` or `top_k`: non-default values return a 400 on this model (the thinking page, "sampling").
/// - Caching: the guide's block is marked `cache_control: {type: "ephemeral"}` (5 minutes); Claude Haiku 5.5 caches a
///   prefix of 512 tokens or more, and a shorter one is simply not cached, with no error; `usage` reports
///   `cache_creation_input_tokens` and `cache_read_input_tokens`
///   (https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
/// - The reply: `content` blocks read by `type` (`"text"` has `text`), `stop_reason` (`end_turn`, `max_tokens`,
///   `refusal`, ...) (https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons). A classifier refusal
///   is an HTTP 200 with `stop_reason: "refusal"`, empty `content` and `stop_details.category`, and Claude Haiku 5.5 has
///   no server-side fallback (https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback): here the
///   on-device model, then the rules, are the fallback.
/// - Errors: a JSON body `{type: "error", error: {type, message}, request_id}`; 401 `authentication_error` (the key is
///   malformed, revoked or expired), 402 `billing_error`, 403 `permission_error`, 429 `rate_limit_error`, 500
///   `api_error`, 529 `overloaded_error` (https://platform.claude.com/docs/en/api/errors).
///
/// The key is read from the Keychain for each request and never logged. A request gives up after 8 s.
nonisolated final class OnlineModel: @unchecked Sendable {
    static let model = "claude-haiku-5-5"
    static let maxTokens = 60
    static let apiVersion = "2023-06-01"
    static let defaultEndpoint = URL(string: "https://api.anthropic.com/v1/messages")!

    nonisolated struct Usage: Sendable {
        var input = 0
        var output = 0
        var cacheRead = 0
        var cacheWrite = 0

        var dictionary: [String: Any] {
            ["input": input, "output": output, "cacheRead": cacheRead, "cacheWrite": cacheWrite]
        }
    }

    nonisolated struct Output: Sendable {
        let text: String
        let usage: Usage
        let ms: Double
    }

    nonisolated enum Failure: Error, CustomStringConvertible {
        /// 401: the key was refused (the page says so: set it again).
        case keyRefused
        /// A classifier declined the request (HTTP 200, `stop_reason: "refusal"`).
        case declined(String?)
        case timeout
        /// Any other HTTP status, with the API's error type.
        case http(Int, String)
        case network(String)
        /// A 200 with no text (a reply cut off before any).
        case empty(String)

        /// The reason as the page protocol words it.
        var reason: String {
            switch self {
            case .keyRefused, .declined: "refused"
            case .timeout: "timeout"
            case .http(429, _): "failed: rate limited"
            case .http(529, _): "failed: overloaded"
            case .http(402, _): "failed: billing"
            case .http(403, _): "failed: permission"
            case .http(let code, _): "failed: http \(code)"
            case .network: "failed: network"
            case .empty: "failed: empty"
            }
        }

        /// For the Bot chat page (the key's status line).
        var problem: String {
            switch self {
            case .keyRefused: "key refused"
            case .declined: "declined"
            case .timeout: "timed out"
            case .http(429, _): "rate limited"
            case .http(529, _): "overloaded"
            case .http(402, _): "billing problem"
            case .http(403, _): "no permission"
            case .http(let code, _): "error \(code)"
            case .network: "no connection"
            case .empty: "empty reply"
            }
        }

        var description: String {
            switch self {
            case .declined(let category): "declined (\(category ?? "no category"))"
            case .http(let code, let type): "http \(code) \(type)"
            case .network(let why): "network: \(why)"
            case .empty(let stop): "no text (stop_reason \(stop))"
            default: reason
            }
        }
    }

    /// Where requests go; a DEBUG build's tests point it at a local mock server (never with a real key).
    var endpoint: URL {
        get { lock.withLock { _endpoint } }
        set { lock.withLock { _endpoint = newValue } }
    }

    private let lock = NSLock()
    private var _endpoint = OnlineModel.defaultEndpoint
    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 8
        config.waitsForConnectivity = false
        config.httpShouldSetCookies = false
        config.urlCache = nil
        session = URLSession(configuration: config)
    }

    /// The request body: the guide first (cached), then the bot's own facts (left out when empty), one user turn.
    static func body(system: String, context: String, user: String) -> [String: Any] {
        var blocks: [[String: Any]] = [["type": "text", "text": system, "cache_control": ["type": "ephemeral"]]]
        if !context.isEmpty {
            blocks.append(["type": "text", "text": context])
        }
        return [
            "model": model,
            "max_tokens": maxTokens,
            "thinking": ["type": "disabled"],
            "output_config": ["effort": "low"],
            "system": blocks,
            "messages": [["role": "user", "content": user]],
        ]
    }

    /// Writes one reply; the completion runs on the main queue.
    func generate(key: String, system: String, context: String, user: String, timeout: TimeInterval,
                  completion: @escaping @MainActor @Sendable (Result<Output, Failure>) -> Void) {
        let started = DispatchTime.now().uptimeNanoseconds
        var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: max(1, min(8, timeout)))
        request.httpMethod = "POST"
        request.setValue(key, forHTTPHeaderField: "x-api-key")
        request.setValue(Self.apiVersion, forHTTPHeaderField: "anthropic-version")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: Self.body(system: system, context: context, user: user))
        let finish: @Sendable (Result<Output, Failure>) -> Void = { result in
            DispatchQueue.main.async { completion(result) }
        }
        session.dataTask(with: request) { data, response, error in
            let ms = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
            if let error {
                let nsError = error as NSError
                finish(.failure(nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorTimedOut
                    ? .timeout : .network("\(nsError.domain) \(nsError.code)")))
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            guard status == 200 else {
                if status == 401 {
                    finish(.failure(.keyRefused))
                } else {
                    let type = (json?["error"] as? [String: Any])?["type"] as? String ?? "?"
                    finish(.failure(.http(status, type)))
                }
                return
            }
            let stop = json?["stop_reason"] as? String ?? "?"
            if stop == "refusal" {
                finish(.failure(.declined((json?["stop_details"] as? [String: Any])?["category"] as? String)))
                return
            }
            let blocks = json?["content"] as? [[String: Any]] ?? []
            let text = blocks.filter { $0["type"] as? String == "text" }
                .compactMap { $0["text"] as? String }
                .joined()
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else {
                finish(.failure(.empty(stop)))
                return
            }
            let usage = json?["usage"] as? [String: Any] ?? [:]
            finish(.success(Output(text: text, usage: Usage(
                input: usage["input_tokens"] as? Int ?? 0, output: usage["output_tokens"] as? Int ?? 0,
                cacheRead: usage["cache_read_input_tokens"] as? Int ?? 0,
                cacheWrite: usage["cache_creation_input_tokens"] as? Int ?? 0), ms: ms)))
        }.resume()
    }
}
