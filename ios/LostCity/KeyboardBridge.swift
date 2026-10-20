import UIKit

/// The native keyboard (ARCHITECTURE.md §7): `{type:'keyboard', action:'show'|'update'|'hide'}` from the page;
/// `LostCityHost.keyboard.insertText / deleteBackward / submit / cancel / dismissed / pressKey / frame` back to it.
///
/// A hidden 1×1 `UIKeyInput` view that becomes first responder once and then **stays** first
/// responder for the life of the app, in one of two modes:
///
/// * **Requested** (after `show`): `inputView` is nil, so iOS shows the system keyboard, with
///   `KeyboardAccessoryBar` above it. Traits are set for the game's plain-ASCII input: no
///   autocorrect, autocapitalisation, spell check, smart quotes/dashes/insert-delete or inline
///   predictions; `.asciiCapable`, or `.asciiCapableNumberPad` for numeric prompts. Passwords are
///   *not* marked `isSecureTextEntry` (that brings up the iOS "Passwords" AutoFill bar and secure
///   keyboard); they are masked in the bar instead. Both login fields have the Go key and "Log in"
///   (offline the password is never checked), so moving between them changes only the bar.
/// * **Idle** (initially, and after `hide`): `inputView` is an empty view, so no software
///   keyboard appears, but the view still owns the hardware keyboard. Characters arrive through
///   `insertText` (UIKit applies the layout, Shift, Option…), special keys through
///   `pressesBegan/Ended` → `pressKey(key, down)`. Hardware keys therefore reach the game no matter
///   which DOM element has focus, and WebKit never has to be first responder.
///
/// The view refuses to resign first responder. WKWebView's content view asks for first responder
/// when it is tapped; if it got it, every tap on the game would close the keyboard (and a tap on
/// the chat line would close and reopen it). The page decides instead: it sends `hide`, or the
/// user taps the bar's hide button (reported as `dismissed()`) or its Cancel (`cancel()`).
///
/// What the page's show message may add:
/// * `maxLength` and `charset` (`chat`, `text`, `alnum`, `game`, `name`, `digits` or `any`, see `Charset`; a name
///   native does not know takes anything): typed or pasted characters that the input would refuse are dropped here,
///   with the warning haptic (which GameViewController leaves out when Settings › Vibration is off) and a flash of
///   the bar's field, instead of showing in the bar and vanishing. Curly quotes, dashes and the ellipsis become ASCII
///   first (`RSTheme.gameText`) in every mode. Pasted text is cut to the longest input the game has, and with no
///   input requested (⌘V on a hardware keyboard in game) it takes what the chat line takes.
/// * `cancellable`: the bar shows Cancel.
/// * `chips` (also in `update`): one-tap entries; a chip replaces the line (Backspace for its current length, then
///   the chip's text, through the same calls as typing) and submits it if `submit`.
///
/// Native also tells the page how much of the web view the keyboard and its bar cover, whenever that changes:
/// `keyboard.frame(points, seconds)`, 0 when hidden.
final class KeyboardBridge: UIView, UIKeyInput {
    // MARK: UITextInputTraits

    var autocapitalizationType: UITextAutocapitalizationType = .none
    var autocorrectionType: UITextAutocorrectionType = .no
    var spellCheckingType: UITextSpellCheckingType = .no
    var smartQuotesType: UITextSmartQuotesType = .no
    var smartDashesType: UITextSmartDashesType = .no
    var smartInsertDeleteType: UITextSmartInsertDeleteType = .no
    var inlinePredictionType: UITextInlinePredictionType = .no
    var keyboardType: UIKeyboardType = .asciiCapable
    var keyboardAppearance: UIKeyboardAppearance = .dark
    var returnKeyType: UIReturnKeyType = .default
    var enablesReturnKeyAutomatically = false
    var isSecureTextEntry = false  // see the type comment: never true

    @available(iOS 18.0, *)
    var mathExpressionCompletionType: UITextMathExpressionCompletionType {
        get { .no }
        set {}
    }

    @available(iOS 18.0, *)
    var writingToolsBehavior: UIWritingToolsBehavior {
        get { .none }
        set {}
    }

    @available(iOS 27.0, *)
    var grammarCheckingType: UITextGrammarCheckingType {
        get { .no }
        set {}
    }

    // MARK: Input rules

    /// The characters an input takes (`charset` in the show message): at most what the client's own input code keeps
    /// (Client.ts), so the bar never shows a character that the game then drops.
    enum Charset: String {
        /// Public chat: printable ASCII up to `z`, and `{ | } ~` only in a `::` command, the one place the client
        /// takes them.
        case chat
        /// A private message: printable ASCII up to `z`.
        case text
        /// Report abuse: letters, digits and space.
        case alnum
        /// The login password: the client's `CHARSET` (letters, digits, space and `!"£$%^&*()-_=+[{]};:'@#~,<.>/?\|`).
        case game
        /// The login username and the name prompts: letters, digits, space, `-` and `_`.
        case name
        case digits, any

        /// Whether the input takes `character` after `line`, the text it holds so far.
        func allows(_ character: Character, after line: String) -> Bool {
            guard self != .any else { return true }
            guard character.unicodeScalars.count == 1, let value = character.unicodeScalars.first?.value else { return false }
            switch self {
            case .chat: return (32...122).contains(value) || ((123...126).contains(value) && line.hasPrefix("::"))
            case .text: return (32...122).contains(value)
            case .alnum: return character.isASCII && (character.isLetter || character.isNumber || character == " ")
            case .game: return Self.gameCharacters.contains(character)
            case .name: return character.isASCII && (character.isLetter || character.isNumber || character == " " || character == "-" || character == "_")
            case .digits: return (48...57).contains(value)
            case .any: return true
            }
        }

        /// Client.CHARSET.
        private static let gameCharacters = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!\"\u{00A3}$%^&*()-_=+[{]};:'@#~,<.>/?\\| ")
    }

    /// What the current input takes; characters outside it never reach the page.
    struct Rules: Equatable {
        var charset = Charset.any
        var maxLength: Int?

        /// The characters of `text` that fit after `current`, and whether any were dropped. Each one is checked against
        /// the line as it would be with the characters taken before it (a pasted or chip `::~bank` keeps its `~`).
        func filter(_ text: String, after current: String) -> (accepted: String, rejected: Bool) {
            var room = maxLength.map { max(0, $0 - current.count) } ?? Int.max
            var accepted = ""
            var line = current
            var rejected = false
            for character in text {
                if room > 0, charset.allows(character, after: line) {
                    accepted.append(character)
                    line.append(character)
                    room -= 1
                } else {
                    rejected = true
                }
            }
            return (accepted, rejected)
        }
    }

    // MARK: State

    private let bridge: PageBridge
    private let bar = KeyboardAccessoryBar()
    /// Replaces the system keyboard while idle: hardware keys still arrive, nothing is drawn.
    private let emptyInputView = UIView(frame: .zero)

    private(set) var requested = false
    private var kind = ""
    private var secure = false
    private var numeric = false
    private var cancellable = false
    private var rules = Rules()
    private var chips: [KeyboardAccessoryBar.Chip] = []

    /// What the bar shows; may run ahead of `hostText` by the keys typed since the last `update`.
    private var displayText = ""
    /// The game's input line as last reported by the page.
    private var hostText = ""
    private var echoDeadline: CFTimeInterval = 0
    private var reconcileTask: Task<Void, Never>?
    /// The page polls the game and reports changes; until a poll catches up with a keystroke the
    /// bar shows the keystroke optimistically. After this long the page's text wins.
    private static let echoGrace: CFTimeInterval = 0.5

    private var heldKeys: [UIKeyboardHIDUsage: String] = [:]
    private var repeatTimer: Timer?
    private var repeatingKey: UIKeyboardHIDUsage?
    private(set) var softwareKeyboardVisible = false
    /// How much of the web view the keyboard and the bar cover, as last reported to the page (`keyboard.frame`).
    private(set) var coveredHeight: CGFloat = 0
    /// The last keyboard animation iOS gave a duration for (0.38 s for the iPhone keyboard).
    private var keyboardAnimation: Double = 0.25
    private var lastRejection: CFTimeInterval = 0
    private(set) var rejections = 0
    private var observers: [NSObjectProtocol] = []

    /// Typing on the software keyboard or its bar (they live in the system's keyboard window, so
    /// `GameWindow` does not see those touches).
    var onActivity: (() -> Void)?
    /// Plays a `Haptics` style (`warning` when a character is refused), unless Settings › Vibration is off.
    var onHaptic: ((String) -> Void)?

    init(bridge: PageBridge) {
        self.bridge = bridge
        super.init(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        backgroundColor = .clear
        // iPad: no shortcuts bar (undo/redo/paste) for a hardware keyboard.
        inputAssistantItem.leadingBarButtonGroups = []
        inputAssistantItem.trailingBarButtonGroups = []
        bar.onSubmit = { [weak self] in self?.submit(source: "bar") }
        bar.onHide = { [weak self] in self?.hide(userInitiated: true) }
        bar.onCancel = { [weak self] in self?.cancel() }
        bar.onChip = { [weak self] in self?.apply($0) }
        observeKeyboard()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    // MARK: First responder

    override var canBecomeFirstResponder: Bool { true }
    override var canResignFirstResponder: Bool { lent }
    override var inputView: UIView? { requested ? nil : emptyInputView }
    override var inputAccessoryView: UIView? { requested ? bar : nil }

    /// While a native text field needs the keyboard (the Claude key's secure box, Settings › Bot chat), the bridge gives up
    /// first responder, and `activate` waits until it is given back.
    private var lent = false  // (not `yielding`: a Swift 6.2 accessor keyword)

    func yieldFirstResponder(_ give: Bool) {
        lent = give
        if give, isFirstResponder {
            _ = resignFirstResponder()
            Log.info("kbd", "first responder given to a native text field")
        }
    }

    /// Takes first responder (idle or requested mode) if it does not already have it.
    func activate() {
        guard window != nil, !isFirstResponder, !lent else { return }
        let ok = becomeFirstResponder()
        Log.info("kbd", "first responder (\(requested ? "keyboard" : "hardware keys")): \(ok)")
    }

    // MARK: Page → native

    func handle(_ message: [String: Any]) {
        switch message["action"] as? String {
        case "show":
            show(kind: message["kind"] as? String ?? "chat",
                 prompt: message["prompt"] as? String ?? "",
                 text: message["text"] as? String ?? "",
                 secure: message["secure"] as? Bool ?? false,
                 numeric: message["numeric"] as? Bool ?? false,
                 cancellable: message["cancellable"] as? Bool ?? false,
                 rules: Self.rules(from: message) ?? Rules(),
                 chips: Self.chips(from: message["chips"]) ?? [])
        case "update":
            update(prompt: message["prompt"] as? String, text: message["text"] as? String,
                   chips: Self.chips(from: message["chips"]), rules: Self.rules(from: message),
                   cancellable: message["cancellable"] as? Bool)
        case "hide":
            hide(userInitiated: false)
        default:
            Log.info("kbd", "unknown keyboard message: \(message)")
        }
    }

    func show(kind: String, prompt: String, text: String, secure: Bool, numeric: Bool,
              cancellable: Bool = false, rules: Rules = Rules(), chips: [KeyboardAccessoryBar.Chip] = []) {
        let keyboard: UIKeyboardType = numeric ? .asciiCapableNumberPad : .asciiCapable
        let returnKey = Self.returnKey(for: kind)
        // Only a different keyboard or Return key needs a reload, which hides the bar for a frame.
        let reconfigure = !requested || keyboard != keyboardType || returnKey != returnKeyType
        self.kind = kind
        self.secure = secure
        self.numeric = numeric
        self.cancellable = cancellable
        self.rules = rules
        self.chips = chips
        keyboardType = keyboard
        returnKeyType = returnKey
        requested = true
        reconcileTask?.cancel()
        echoDeadline = 0
        hostText = text
        displayText = text
        bar.configure(prompt: prompt.isEmpty ? Self.defaultPrompt(for: kind) : prompt,
                      submitTitle: Self.submitTitle(for: kind), secure: secure, numeric: numeric, text: text,
                      cancellable: cancellable, chips: chips)
        Log.info("kbd", "show kind=\(kind) numeric=\(numeric) secure=\(secure) cancellable=\(cancellable) " +
                 "charset=\(rules.charset.rawValue) max=\(rules.maxLength.map(String.init) ?? "-") chips=\(chips.count)")
        if !isFirstResponder {
            if !becomeFirstResponder() { Log.info("kbd", "show: becomeFirstResponder failed") }
        } else if reconfigure {
            // Swaps the empty input view for the system keyboard (or applies new traits).
            reloadInputViews()
        }
    }

    func update(prompt: String?, text: String?, chips: [KeyboardAccessoryBar.Chip]? = nil, rules: Rules? = nil, cancellable: Bool? = nil) {
        guard requested else { return }
        if let prompt {
            bar.setPrompt(prompt.isEmpty ? Self.defaultPrompt(for: kind) : prompt)
        }
        if let rules { self.rules = rules }
        if let chips {
            self.chips = chips
            bar.setChips(chips)
        }
        if let cancellable {
            self.cancellable = cancellable
            bar.setCancellable(cancellable)
        }
        guard let text else { return }
        hostText = text
        if text == displayText || CACurrentMediaTime() >= echoDeadline {
            displayText = text
            bar.setText(text)
        }
        // Otherwise a keystroke newer than this poll is on screen; reconcile() settles it.
    }

    /// `userInitiated`: the bar's hide button — reported to the page as `dismissed()`.
    func hide(userInitiated: Bool) {
        guard requested else { return }
        endRequest()
        Log.info("kbd", userInitiated ? "dismissed by the player" : "hide")
        if userInitiated {
            bridge.call("keyboard.dismissed")
        }
    }

    /// The bar's Cancel: hides the keyboard and cancels the prompt (`keyboard.cancel()`).
    private func cancel() {
        guard requested else { return }
        onActivity?()
        endRequest()
        Log.info("kbd", "cancelled by the player")
        bridge.call("keyboard.cancel") { [weak self] outcome in
            // A page without cancel() still has to forget its keyboard, as for the hide button.
            if case .missing = outcome { self?.bridge.call("keyboard.dismissed") }
        }
    }

    private func endRequest() {
        requested = false
        rules = Rules()
        reconcileTask?.cancel()
        if isFirstResponder { reloadInputViews() }
    }

    /// The page went away (reload, WebContent crash, fatal error): forget its keyboard state.
    func reset() {
        releaseHeldKeys()
        reconcileTask?.cancel()
        hostText = ""
        displayText = ""
        rules = Rules()
        coveredHeight = 0  // what a new page assumes
        if requested {
            requested = false
            if isFirstResponder { reloadInputViews() }
            Log.info("kbd", "reset")
        }
    }

    // MARK: UIKeyInput

    var hasText: Bool { true }  // the game owns the text; always let Backspace through

    func insertText(_ text: String) {
        onActivity?()
        // Return arrives as "\n"; dictation or a hardware paste may deliver several characters,
        // including line breaks, in one call.
        var run = ""
        for character in RSTheme.gameText(text) {
            if character.isNewline {
                if !run.isEmpty { send(run) }
                run = ""
                submit(source: "return")
            } else {
                run.append(character)
            }
        }
        if !run.isEmpty { send(run) }
    }

    func deleteBackward() {
        onActivity?()
        echo { if !$0.isEmpty { $0.removeLast() } }
        Log.debug("kbd", "deleteBackward")
        bridge.call("keyboard.deleteBackward")
    }

    /// Sends what the input takes. The room left is counted from the bar's text: the page's last report plus the keys
    /// sent since (the page has them queued already). `dropped`: the text has lost characters already (the end of a
    /// long paste), which are refused as well.
    private func send(_ text: String, dropped: Bool = false) {
        let (accepted, rejected) = rules.filter(text, after: displayText)
        if rejected || dropped { refused() }
        guard !accepted.isEmpty else { return }
        echo { $0 += accepted }
        Log.debug("kbd", "insertText (\(accepted.count) chars)")
        bridge.call("keyboard.insertText", [accepted])
    }

    private func submit(source: String) {
        onActivity?()
        Log.debug("kbd", "submit (\(source))")
        lineCommitted()
        bridge.call("keyboard.submit")
    }

    /// Return (the keyboard's, the bar's button or a hardware Enter) commits the line. The chat line stays open and
    /// Return empties it, so the bar empties at once: the next message's first letters then count from an empty line
    /// instead of the sent one, which the page reports gone only on its next poll (if Return did nothing, reconcile()
    /// brings the line back). What the other inputs do with the line (log in, close the prompt) is up to the page, so
    /// its next update wins at once. (A pending reconcile stays scheduled in case no update comes.)
    private func lineCommitted() {
        if kind == "chat" {
            echo { $0 = "" }
        } else {
            echoDeadline = 0
        }
    }

    /// A character the input does not take: the warning haptic (at most every 0.3 s, e.g. for a held key) and a flash.
    private func refused() {
        rejections += 1
        let now = CACurrentMediaTime()
        guard now - lastRejection > 0.3 else { return }
        lastRejection = now
        Log.debug("kbd", "refused characters (charset \(rules.charset.rawValue), max \(rules.maxLength.map(String.init) ?? "-"))")
        onHaptic?("warning")
        if requested { bar.flashRejected() }
    }

    /// A chip replaces the line with its text: Backspace for the line's current length (extra ones do nothing), the
    /// text through the same filter as typing, then Return if it says so.
    private func apply(_ chip: KeyboardAccessoryBar.Chip) {
        guard requested else { return }
        onActivity?()
        Log.debug("kbd", "chip \(chip.label)")
        let deletes = max(displayText.count, hostText.count)
        if deletes > 0 {
            echo { $0 = "" }
            for _ in 0..<deletes { bridge.call("keyboard.deleteBackward") }
        }
        insertText(chip.text)
        if chip.submit { submit(source: "chip") }
    }

    // MARK: Paste

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)) {
            return UIPasteboard.general.hasStrings
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        guard let string = UIPasteboard.general.string else { return }
        pasteText(string)
    }

    /// ⌘V on a hardware keyboard (iPhone has no Edit menu to route it).
    override var keyCommands: [UIKeyCommand]? { [pasteCommand] }

    private lazy var pasteCommand: UIKeyCommand = {
        let command = UIKeyCommand(input: "v", modifierFlags: .command, action: #selector(paste(_:)))
        command.wantsPriorityOverSystemBehavior = true
        return command
    }()

    /// The longest input the game has: the chat line and private messages (names take 12, amounts 10, the password 20).
    private static let longestInput = 80

    /// Pasted text is one line: its line breaks become spaces rather than submitting it. It is cut to the longest input
    /// the game has, so a large clipboard cannot flood the page's key queue (what is cut off is refused like any
    /// character that does not fit). With no input requested, the paste (⌘V on a hardware keyboard in game) types
    /// into the chat line, so it takes what chat takes, counted from an empty line: native does not see that line.
    private func pasteText(_ string: String) {
        onActivity?()
        let joined = RSTheme.gameText(string).split(whereSeparator: \.isNewline).joined(separator: " ")
        var line = String(joined.prefix(Self.longestInput))
        var dropped = line.count < joined.count
        if !requested {
            let chat = Rules(charset: .chat, maxLength: Self.longestInput).filter(line, after: "")
            line = chat.accepted
            dropped = dropped || chat.rejected
        }
        Log.debug("kbd", "paste (\(line.count) of \(joined.count) chars)")
        send(line, dropped: dropped)
    }

    // MARK: Optimistic echo

    private func echo(_ edit: (inout String) -> Void) {
        guard requested else { return }
        edit(&displayText)
        bar.setText(displayText)
        echoDeadline = CACurrentMediaTime() + Self.echoGrace
        reconcileTask?.cancel()
        reconcileTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.echoGrace + 0.05))
            guard !Task.isCancelled else { return }
            self?.reconcile()
        }
    }

    private func reconcile() {
        guard requested, displayText != hostText else { return }
        displayText = hostText
        bar.setText(hostText)
    }

    // MARK: Hardware keyboard

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var forward = Set<UIPress>()
        for press in presses {
            guard let key = press.key, let name = Self.gameKeyName(key.keyCode) else {
                forward.insert(press)  // characters: UIKit's text system → insertText
                continue
            }
            keyDown(key.keyCode, name: name)
            if Self.modifierKeys.contains(name) { forward.insert(press) }  // UIKit tracks modifiers too
        }
        if !forward.isEmpty { super.pressesBegan(forward, with: event) }
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let forward = keysUp(presses)
        if !forward.isEmpty { super.pressesEnded(forward, with: event) }
    }

    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let forward = keysUp(presses)
        if !forward.isEmpty { super.pressesCancelled(forward, with: event) }
    }

    /// Sends key-up for every key still down (focus loss, app deactivation, page reload), so the
    /// game is never left with a stuck arrow key.
    func releaseHeldKeys() {
        stopRepeating()
        for name in heldKeys.values { pressKey(name, down: false) }
        heldKeys.removeAll()
    }

    private func keysUp(_ presses: Set<UIPress>) -> Set<UIPress> {
        var forward = Set<UIPress>()
        for press in presses {
            guard let code = press.key?.keyCode, let name = heldKeys[code] else {
                forward.insert(press)
                continue
            }
            keyUp(code)
            if Self.modifierKeys.contains(name) { forward.insert(press) }
        }
        return forward
    }

    private func keyDown(_ code: UIKeyboardHIDUsage, name: String) {
        guard heldKeys.updateValue(name, forKey: code) == nil else { return }
        sendKeyDown(name)
        if Self.repeatingKeys.contains(name) { startRepeating(code, name: name) }
    }

    /// A hardware key-down or auto-repeat. Keeps the bar in step the way the soft keyboard's
    /// deleteBackward/submit do (the page still decides what the key does).
    private func sendKeyDown(_ name: String) {
        switch name {
        case "Backspace", "Delete":
            echo { if !$0.isEmpty { $0.removeLast() } }
        case "Enter":
            lineCommitted()
        default:
            break
        }
        pressKey(name, down: true)
    }

    private func keyUp(_ code: UIKeyboardHIDUsage) {
        guard let name = heldKeys.removeValue(forKey: code) else { return }
        if repeatingKey == code { stopRepeating() }
        pressKey(name, down: false)
    }

    private func pressKey(_ name: String, down: Bool) {
        Log.debug("kbd", "pressKey \(name) \(down ? "down" : "up")")
        bridge.call("keyboard.pressKey", [name, down])
    }

    /// UIKit does not repeat `pressesBegan`; browsers repeat keydown for held keys, and the game
    /// deletes one character per Backspace keydown.
    private func startRepeating(_ code: UIKeyboardHIDUsage, name: String) {
        stopRepeating()
        repeatingKey = code
        let timer = Timer(fire: Date().addingTimeInterval(0.4), interval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sendKeyDown(name) }
        }
        RunLoop.main.add(timer, forMode: .common)
        repeatTimer = timer
    }

    private func stopRepeating() {
        repeatTimer?.invalidate()
        repeatTimer = nil
        repeatingKey = nil
    }

    /// `KeyboardEvent.key` names (webclient KeyCodes.ts) for the keys that are not text.
    private static let gameKeys: [UIKeyboardHIDUsage: String] = [
        .keyboardLeftArrow: "ArrowLeft", .keyboardRightArrow: "ArrowRight",
        .keyboardUpArrow: "ArrowUp", .keyboardDownArrow: "ArrowDown",
        .keyboardEscape: "Escape", .keyboardTab: "Tab",
        .keyboardReturnOrEnter: "Enter", .keypadEnter: "Enter",
        .keyboardDeleteOrBackspace: "Backspace", .keyboardDeleteForward: "Delete",
        .keyboardHome: "Home", .keyboardEnd: "End", .keyboardPageUp: "PageUp", .keyboardPageDown: "PageDown",
        .keyboardInsert: "Insert",
        .keyboardLeftControl: "Control", .keyboardRightControl: "Control",
        .keyboardF1: "F1", .keyboardF2: "F2", .keyboardF3: "F3", .keyboardF4: "F4",
        .keyboardF5: "F5", .keyboardF6: "F6", .keyboardF7: "F7", .keyboardF8: "F8",
        .keyboardF9: "F9", .keyboardF10: "F10", .keyboardF11: "F11", .keyboardF12: "F12",
    ]

    static func gameKeyName(_ code: UIKeyboardHIDUsage) -> String? {
        gameKeys[code]
    }

    private static let modifierKeys: Set<String> = ["Control"]
    private static let repeatingKeys: Set<String> = ["Backspace", "Delete"]

    // MARK: Per-kind presentation

    private static func returnKey(for kind: String) -> UIReturnKeyType {
        switch kind {
        case "chat", "social": .send
        case "login-user", "login-pass": .go  // the same on both fields: switching them reloads nothing
        default: .done
        }
    }

    private static func submitTitle(for kind: String) -> String {
        switch kind {
        case "chat", "social": "Send"
        case "login-user", "login-pass": "Log in"
        default: "OK"
        }
    }

    private static func defaultPrompt(for kind: String) -> String {
        switch kind {
        case "chat": "Chat"
        case "login-user": "Username"
        case "login-pass": "Password"
        case "dialog": "Enter amount"
        case "report": "Player name"
        default: ""
        }
    }

    // MARK: Message parsing

    /// `maxLength` / `charset` of a show or update message; nil when it has neither.
    private static func rules(from message: [String: Any]) -> Rules? {
        let maxLength = (message["maxLength"] as? NSNumber)?.intValue
        let charset = message["charset"] as? String
        guard maxLength != nil || charset != nil else { return nil }
        if let charset, Charset(rawValue: charset) == nil {
            Log.info("kbd", "unknown charset '\(charset)': not filtering")
        }
        return Rules(charset: charset.flatMap(Charset.init(rawValue:)) ?? .any,
                     maxLength: maxLength.flatMap { $0 > 0 ? $0 : nil })
    }

    /// `chips: [{label, text, submit?, whenEmpty?}]`; nil when the message has none (an update keeps the current ones).
    private static func chips(from value: Any?) -> [KeyboardAccessoryBar.Chip]? {
        guard let value, !(value is NSNull) else { return nil }
        guard let list = value as? [[String: Any]] else { return [] }
        return list.prefix(24).compactMap { item in
            guard let text = item["text"] as? String, !text.isEmpty else { return nil }
            let label = (item["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? text
            return KeyboardAccessoryBar.Chip(label: label, text: text, submit: item["submit"] as? Bool ?? false,
                                             whenEmpty: item["whenEmpty"] as? Bool ?? false)
        }
    }

    // MARK: Keyboard frame → page

    private func observeKeyboard() {
        let names: [Notification.Name] = [
            UIResponder.keyboardWillShowNotification, UIResponder.keyboardDidShowNotification,
            UIResponder.keyboardWillHideNotification, UIResponder.keyboardDidHideNotification,
            UIResponder.keyboardWillChangeFrameNotification,
        ]
        for name in names {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue ?? .zero
                let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0
                let screen = note.object as? UIScreen
                let event = name.rawValue.replacingOccurrences(of: "UIKeyboard", with: "").replacingOccurrences(of: "Notification", with: "")
                MainActor.assumeIsolated {
                    guard let self else { return }
                    switch name {
                    case UIResponder.keyboardDidShowNotification:
                        self.softwareKeyboardVisible = frame.height > 0
                    case UIResponder.keyboardDidHideNotification:
                        self.softwareKeyboardVisible = false
                    case UIResponder.keyboardWillHideNotification:
                        // Its end frame can still be the bar's (812×52 at the bottom): hidden is 0.
                        self.reportCovered(0, duration: duration)
                    default: // will show, will change frame
                        self.reportCovered(self.requested ? self.covered(by: frame, on: screen) : 0, duration: duration)
                    }
                    if name != UIResponder.keyboardWillChangeFrameNotification || Log.verbose {
                        Log.info("kbd", "\(event) frame=\(Int(frame.minX)),\(Int(frame.minY)) \(Int(frame.width))x\(Int(frame.height)) " +
                                 "\(String(format: "%.2f", duration)) s requested=\(self.requested)")
                    }
                }
            })
        }
    }

    /// How much of the bottom of the web view a keyboard frame (screen coordinates) covers: 0 when it is off the view
    /// or floating (an iPad keyboard that does not reach the bottom edge covers no strip of it).
    private func covered(by frame: CGRect, on screen: UIScreen?) -> CGFloat {
        let target: UIView? = bridge.webView ?? superview
        guard let view = target, view.window != nil, frame.height > 0 else { return 0 }
        let local: CGRect
        if let space = (screen ?? view.window?.windowScene?.screen)?.coordinateSpace {
            local = view.convert(frame, from: space)
        } else {
            local = view.convert(frame, from: nil)
        }
        let bounds = view.bounds
        guard local.maxY >= bounds.maxY - 1, local.minY < bounds.maxY, local.maxX > bounds.minX, local.minX < bounds.maxX else { return 0 }
        return (bounds.maxY - max(local.minY, bounds.minY)).rounded()
    }

    /// `LostCityHost.keyboard.frame(points, seconds)` when the covered height changes. iOS animates a keyboard that
    /// goes away (`DidHide` follows about 0.4 s later) but reports 0 s for it when the page hid it: a keyboard going
    /// down with no duration of its own reports the duration it came up with, so the page moves along with it.
    private func reportCovered(_ height: CGFloat, duration: Double) {
        if duration > 0 { keyboardAnimation = duration }
        guard height != coveredHeight else { return }
        let seconds = duration > 0 || height > coveredHeight ? duration : keyboardAnimation
        coveredHeight = height
        Log.info("kbd", "covers \(Int(height)) pt of the page (\(String(format: "%.2f", seconds)) s)")
        bridge.call("keyboard.frame", [Double(height), seconds]) { outcome in
            Log.debug("kbd", "keyboard.frame → \(outcome)")
        }
    }

    // MARK: Debug hooks (test pages drive these through `{type:'debug'}`)

    #if DEBUG
    /// Feeds characters through the UIKeyInput entry points exactly as the system keyboard does.
    /// `\u{8}` stands for the Backspace key.
    func debugType(_ text: String) {
        for character in text {
            if character == "\u{8}" { deleteBackward() } else { insertText(String(character)) }
        }
    }

    /// Runs the hardware-key path (minus UIPress delivery, which cannot be synthesized).
    func debugHardwareKey(_ name: String, down: Bool) {
        guard let code = Self.gameKeys.first(where: { $0.value == name })?.key else {
            Log.info("kbd", "debug: no hardware key named \(name)")
            return
        }
        down ? keyDown(code, name: name) : keyUp(code)
    }

    /// `hide`, `cancel` or `submit`, as the bar's buttons do.
    func debugTapBar(_ button: String) {
        switch button {
        case "hide": hide(userInitiated: true)
        case "cancel": cancel()
        default: submit(source: "bar")
        }
    }

    /// Taps the chip on show at `index`; returns its label, or nil if there is none.
    func debugTapChip(_ index: Int) -> String? {
        let chips = bar.visibleChips
        guard chips.indices.contains(index) else { return nil }
        apply(chips[index])
        return chips[index].label
    }

    /// Pastes `text` as `paste(_:)` does with the pasteboard's string (reading the real pasteboard from a script
    /// would raise the paste permission prompt).
    func debugPaste(_ text: String) {
        pasteText(text)
    }

    func debugState() -> [String: Any] {
        [
            "isFirstResponder": isFirstResponder,
            "requested": requested,
            "kind": kind,
            "secure": secure,
            "numeric": numeric,
            "keyboardType": keyboardType.rawValue,
            "returnKeyType": returnKeyType.rawValue,
            "isSecureTextEntry": isSecureTextEntry,
            "displayText": bar.displayedText,
            "softwareKeyboardVisible": softwareKeyboardVisible,
            "inputView": inputView == nil ? "system keyboard" : "empty (hardware only)",
            "heldKeys": Array(heldKeys.values).sorted(),
            "cancellable": cancellable,
            "cancelShown": bar.isCancelShown,
            "submitTitle": bar.submitTitle,
            "charset": rules.charset.rawValue,
            "maxLength": rules.maxLength ?? NSNull(),
            "chips": bar.visibleChips.map(\.label),
            "coveredHeight": Double(coveredHeight),
            "rejections": rejections,
            "flashing": bar.isFlashingRejected,
            "canPaste": canPerformAction(#selector(paste(_:)), withSender: nil),
        ]
    }
    #endif
}
