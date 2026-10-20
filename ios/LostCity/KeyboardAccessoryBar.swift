import UIKit

/// The bar above the software keyboard (alone at the bottom of the screen when a hardware keyboard is attached), a
/// strip of the 2004 interface (RSTheme: stone, yellow prompt, the game's fonts and buttons). In landscape the
/// keyboard covers the game's chat line, so the bar shows what is being typed:
///
///     [prompt] [input line*] [chip] [chip] …  [Cancel] [Send] [v]
///
/// * the prompt and the game's current input line with its "*" caret (masked when the input is a password);
/// * chips, one-tap entries from the page (the '::' key and recent developer commands for chat, amounts for an amount
///   prompt): the Game Options tab's small buttons in a row that scrolls sideways when it does not fit, its edges
///   fading where there is more. A `whenEmpty` chip only shows while the line is empty; once something is typed into a
///   text input the row gets less room, the line more;
/// * Cancel (only for prompts the page marks cancellable), the submit button (the number pad has no Return key) and
///   the hide button.
final class KeyboardAccessoryBar: UIInputView {
    static let height: CGFloat = 52

    /// A one-tap entry from the page's `chips`: `text` replaces the input line, then it is submitted if `submit`.
    struct Chip: Equatable {
        let label: String
        let text: String
        let submit: Bool
        let whenEmpty: Bool
    }

    var onSubmit: (() -> Void)?
    var onHide: (() -> Void)?
    var onCancel: (() -> Void)?
    var onChip: ((Chip) -> Void)?

    private let promptLabel = UILabel()
    private let field = UIView()
    private let textLabel = UILabel()
    private let caret = UILabel()
    private let chipStrip = ChipStrip()
    private let cancelButton = UIButton(type: .custom)
    private let submitButton = UIButton(type: .custom)
    private let hideButton = UIButton(type: .custom)
    private var fieldMinWidth: NSLayoutConstraint!
    /// The chips' share of the bar while the line is empty, and while something is typed.
    private var chipLimitEmpty: NSLayoutConstraint!
    private var chipLimitTyping: NSLayoutConstraint!
    private var chips: [Chip] = []
    private var text = ""
    private var secure = false
    private var numeric = false

    init() {
        super.init(frame: CGRect(x: 0, y: 0, width: 320, height: Self.height), inputViewStyle: .default)
        allowsSelfSizing = true
        backgroundColor = RSTheme.stoneFill
        build()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: Self.height)
    }

    // MARK: - Content

    func configure(prompt: String, submitTitle: String, secure: Bool, numeric: Bool, text: String, cancellable: Bool, chips: [Chip]) {
        setPrompt(prompt)
        submitButton.configuration?.attributedTitle = RSTheme.buttonTitle(submitTitle)
        submitButton.accessibilityLabel = submitTitle
        setCancellable(cancellable)
        // an amount needs little room; a chat line as much as it can get
        fieldMinWidth.constant = numeric ? 120 : 180
        self.numeric = numeric
        self.secure = secure
        self.text = text
        setChips(chips)
        setText(text)
    }

    func setPrompt(_ prompt: String) {
        promptLabel.text = RSTheme.gameText(prompt)
        promptLabel.isHidden = prompt.isEmpty
    }

    func setCancellable(_ cancellable: Bool) {
        cancelButton.isHidden = !cancellable
    }

    func setText(_ text: String) {
        self.text = text
        textLabel.text = secure ? String(repeating: "*", count: text.count) : text
        textLabel.accessibilityValue = secure ? "\(text.count) characters" : text
        updateChips(animated: true)
    }

    func setChips(_ chips: [Chip]) {
        guard chips != self.chips else { return }
        self.chips = chips
        for view in chipStrip.row.arrangedSubviews { view.removeFromSuperview() }
        for chip in chips { chipStrip.row.addArrangedSubview(makeChipButton(chip)) }
        chipStrip.scrollToStart()
        updateChips(animated: false)
    }

    /// Feedback for characters the input does not take (with the warning haptic native plays).
    func flashRejected() {
        let color = CABasicAnimation(keyPath: "borderColor")
        color.fromValue = RSTheme.red.cgColor
        color.toValue = RSTheme.stoneDark.cgColor
        let width = CABasicAnimation(keyPath: "borderWidth")
        width.fromValue = 2
        width.toValue = 1
        let flash = CAAnimationGroup()
        flash.animations = [color, width]
        flash.duration = 0.35
        flash.timingFunction = CAMediaTimingFunction(name: .easeIn)
        field.layer.add(flash, forKey: "rejected")
    }

    var displayedText: String { textLabel.text ?? "" }
    /// The chips on show, in order.
    var visibleChips: [Chip] {
        zip(chips, chipStrip.row.arrangedSubviews).filter { !$0.1.isHidden && !chipStrip.isHidden }.map(\.0)
    }
    var isCancelShown: Bool { !cancelButton.isHidden }
    /// The field is flashing for refused characters (`flashRejected()`, 0.35 s).
    var isFlashingRejected: Bool { field.layer.animation(forKey: "rejected") != nil }
    var submitTitle: String { submitButton.accessibilityLabel ?? "" }

    /// Shows the `whenEmpty` chips only while the line is empty, and gives the line more room once something is typed.
    private func updateChips(animated: Bool) {
        let empty = text.isEmpty
        var changed = false
        for (chip, view) in zip(chips, chipStrip.row.arrangedSubviews) where chip.whenEmpty && view.isHidden == empty {
            view.isHidden = !empty
            changed = true
        }
        let anyShown = chipStrip.row.arrangedSubviews.contains { !$0.isHidden }
        if chipStrip.isHidden == anyShown {
            chipStrip.isHidden = !anyShown
            changed = true
        }
        // (an amount's few digits never need the room)
        let limit = numeric ? nil : empty ? chipLimitEmpty : chipLimitTyping
        for constraint in [chipLimitEmpty!, chipLimitTyping!] where constraint.isActive != (constraint === limit) {
            constraint.isActive = constraint === limit
            changed = true
        }
        guard changed else { return }
        chipStrip.setNeedsLayout()
        if animated, window != nil {
            UIView.animate(withDuration: 0.15, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
                self.layoutIfNeeded()
            }
        }
    }

    // MARK: - Layout

    /// A 2004 interface button: grey stone, 25 % brighter while pressed (the page's `.stone-btn`).
    private static func styleStoneButton(_ button: UIButton, insets: NSDirectionalEdgeInsets) {
        button.configuration = RSTheme.buttonConfiguration(background: RSTheme.buttonImage(), insets: insets)
        button.configurationUpdateHandler = { button in
            button.configuration?.background.image = RSTheme.buttonImage(pressed: button.isHighlighted)
        }
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
    }

    /// A chip: the Game Options tab's small button, in its "chosen" look (red, yellow text) while pressed.
    private func makeChipButton(_ chip: Chip) -> UIButton {
        var configuration = RSTheme.buttonConfiguration(background: RSTheme.optionButtonImage(),
                                                        insets: NSDirectionalEdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
        configuration.attributedTitle = RSTheme.buttonTitle(chip.label, font: .plain12)
        configuration.titleLineBreakMode = .byTruncatingTail
        let button = UIButton(configuration: configuration)
        button.configurationUpdateHandler = { button in
            let pressed = button.isHighlighted
            button.configuration?.background.image = RSTheme.optionButtonImage(on: pressed)
            button.configuration?.attributedTitle = RSTheme.buttonTitle(chip.label, font: .plain12, color: pressed ? RSTheme.yellow : .white)
        }
        button.accessibilityLabel = chip.label
        button.accessibilityHint = chip.submit ? "Enters and sends \(chip.text)" : "Enters \(chip.text)"
        button.addAction(UIAction { [weak self] _ in self?.onChip?(chip) }, for: .primaryActionTriggered)
        button.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            button.heightAnchor.constraint(equalToConstant: 32),
            button.widthAnchor.constraint(greaterThanOrEqualToConstant: 44),
            button.widthAnchor.constraint(lessThanOrEqualToConstant: 220),
        ])
        return button
    }

    /// A chevron pointing down, drawn in game pixels: a one-pixel yellow V with a black outline, like the HUD's.
    private static func chevronImage() -> UIImage {
        let pixels = 2.0 // points per game pixel
        let points = [(1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 4), (7, 3), (8, 2), (9, 1)]
        return UIGraphicsImageRenderer(size: CGSize(width: 11 * pixels, height: 7 * pixels)).image { context in
            UIColor.black.setFill()
            for (x, y) in points {
                context.fill(CGRect(x: Double(x - 1) * pixels, y: Double(y - 1) * pixels, width: 3 * pixels, height: 3 * pixels))
            }
            RSTheme.yellow.setFill()
            for (x, y) in points {
                context.fill(CGRect(x: Double(x) * pixels, y: Double(y) * pixels, width: pixels, height: pixels))
            }
        }
    }

    private func build() {
        let edge = UIView()
        edge.backgroundColor = RSTheme.stoneLight
        let edgeDark = UIView()
        edgeDark.backgroundColor = .black

        promptLabel.font = RSTheme.font(.plain12)
        promptLabel.textColor = RSTheme.yellow
        RSTheme.applyShadow(to: promptLabel)
        promptLabel.lineBreakMode = .byTruncatingTail
        promptLabel.setContentHuggingPriority(.required, for: .horizontal)
        promptLabel.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)

        // the input line: dark inset in the stone, the text in the game's font at two game pixels per point
        field.backgroundColor = UIColor(white: 0, alpha: 0.55)
        field.layer.borderColor = RSTheme.stoneDark.cgColor
        field.layer.borderWidth = 1
        field.setContentHuggingPriority(UILayoutPriority(1), for: .horizontal) // takes the room the others leave
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        textLabel.font = RSTheme.font(.plain12, scale: 2)
        textLabel.textColor = .white
        RSTheme.applyShadow(to: textLabel, scale: 2)
        // Typing happens at the end of the line: when it overflows, keep the end visible.
        textLabel.lineBreakMode = .byTruncatingHead
        textLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        textLabel.setContentHuggingPriority(.required, for: .horizontal)
        textLabel.isAccessibilityElement = true
        textLabel.accessibilityLabel = "Input"

        // the 2004 client's input caret is a "*" after the text
        caret.text = "*"
        caret.font = RSTheme.font(.plain12, scale: 2)
        caret.textColor = RSTheme.yellow
        RSTheme.applyShadow(to: caret, scale: 2)
        caret.isAccessibilityElement = false

        chipStrip.setContentHuggingPriority(.required, for: .horizontal)
        chipStrip.isHidden = true

        Self.styleStoneButton(cancelButton, insets: NSDirectionalEdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
        cancelButton.configuration?.attributedTitle = RSTheme.buttonTitle("Cancel")
        cancelButton.accessibilityLabel = "Cancel"
        cancelButton.isHidden = true
        cancelButton.addAction(UIAction { [weak self] _ in self?.onCancel?() }, for: .primaryActionTriggered)

        Self.styleStoneButton(submitButton, insets: NSDirectionalEdgeInsets(top: 6, leading: 14, bottom: 6, trailing: 14))
        submitButton.addAction(UIAction { [weak self] _ in self?.onSubmit?() }, for: .primaryActionTriggered)

        Self.styleStoneButton(hideButton, insets: NSDirectionalEdgeInsets(top: 8, leading: 10, bottom: 8, trailing: 10))
        hideButton.configuration?.image = Self.chevronImage()
        hideButton.accessibilityLabel = "Hide keyboard"
        hideButton.addAction(UIAction { [weak self] _ in self?.onHide?() }, for: .primaryActionTriggered)

        let row = UIStackView(arrangedSubviews: [promptLabel, field, chipStrip, cancelButton, submitButton, hideButton])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 10
        row.setCustomSpacing(6, after: cancelButton) // Cancel and submit read as a pair
        row.setCustomSpacing(6, after: submitButton)

        for view in [edge, edgeDark, row, textLabel, caret] { view.translatesAutoresizingMaskIntoConstraints = false }
        addSubview(edgeDark)
        addSubview(edge)
        addSubview(row)
        field.addSubview(textLabel)
        field.addSubview(caret)

        fieldMinWidth = field.widthAnchor.constraint(greaterThanOrEqualToConstant: 180)
        chipLimitEmpty = chipStrip.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, multiplier: 0.45)
        chipLimitTyping = chipStrip.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, multiplier: 0.3)
        // all the chips if they fit; otherwise the row scrolls (it gives way before the prompt does)
        let chipsWhole = chipStrip.widthAnchor.constraint(equalTo: chipStrip.row.widthAnchor)
        chipsWhole.priority = UILayoutPriority(700)

        // Follow the safe area: in landscape the notch side has a ~50 pt inset.
        let guide = safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            edgeDark.topAnchor.constraint(equalTo: topAnchor),
            edgeDark.leadingAnchor.constraint(equalTo: leadingAnchor),
            edgeDark.trailingAnchor.constraint(equalTo: trailingAnchor),
            edgeDark.heightAnchor.constraint(equalToConstant: 1),
            edge.topAnchor.constraint(equalTo: edgeDark.bottomAnchor),
            edge.leadingAnchor.constraint(equalTo: leadingAnchor),
            edge.trailingAnchor.constraint(equalTo: trailingAnchor),
            edge.heightAnchor.constraint(equalToConstant: 2),

            row.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 12),
            row.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -6),
            row.centerYAnchor.constraint(equalTo: centerYAnchor, constant: 1),
            heightAnchor.constraint(equalToConstant: Self.height),

            promptLabel.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, multiplier: 0.38),
            field.heightAnchor.constraint(equalToConstant: 40),
            fieldMinWidth,
            chipStrip.heightAnchor.constraint(equalToConstant: 34),
            chipStrip.widthAnchor.constraint(lessThanOrEqualTo: chipStrip.row.widthAnchor),
            chipsWhole,
            chipLimitEmpty,
            cancelButton.heightAnchor.constraint(equalToConstant: 36),
            submitButton.heightAnchor.constraint(equalToConstant: 36),
            hideButton.heightAnchor.constraint(equalToConstant: 36),

            textLabel.leadingAnchor.constraint(equalTo: field.leadingAnchor, constant: 10),
            textLabel.centerYAnchor.constraint(equalTo: field.centerYAnchor),
            caret.leadingAnchor.constraint(equalTo: textLabel.trailingAnchor, constant: 2),
            caret.trailingAnchor.constraint(lessThanOrEqualTo: field.trailingAnchor, constant: -10),
            caret.centerYAnchor.constraint(equalTo: textLabel.centerYAnchor),
        ])
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // Core Animation drops animations when a layer leaves the window; restart on every show.
        caret.layer.removeAnimation(forKey: "blink")
        guard window != nil else { return }
        let blink = CABasicAnimation(keyPath: "opacity")
        blink.fromValue = 1
        blink.toValue = 0
        blink.duration = 0.5
        blink.autoreverses = true
        blink.repeatCount = .infinity
        blink.timingFunction = CAMediaTimingFunction(name: .linear)
        caret.layer.add(blink, forKey: "blink")
    }
}

/// The chips' row: scrolls sideways when it does not fit, its edges fading out where there are more chips. When the
/// row overflows, the visible part always ends inside a chip (a little short of the room it has, if need be), so a
/// cut chip shows there is more.
private final class ChipStrip: UIView, UIScrollViewDelegate {
    let row = UIStackView()
    private let scroller = Scroller()
    private let fade = CAGradientLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        scroller.showsHorizontalScrollIndicator = false
        scroller.showsVerticalScrollIndicator = false
        scroller.alwaysBounceVertical = false
        scroller.delaysContentTouches = false // a chip lights up as soon as it is touched
        scroller.contentInsetAdjustmentBehavior = .never
        scroller.delegate = self
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 6
        fade.startPoint = CGPoint(x: 0, y: 0.5)
        fade.endPoint = CGPoint(x: 1, y: 0.5)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroller) // laid out by hand (layoutSubviews)
        scroller.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: scroller.contentLayoutGuide.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: scroller.contentLayoutGuide.trailingAnchor),
            row.topAnchor.constraint(equalTo: scroller.contentLayoutGuide.topAnchor),
            row.bottomAnchor.constraint(equalTo: scroller.contentLayoutGuide.bottomAnchor),
            row.heightAnchor.constraint(equalTo: scroller.frameLayoutGuide.heightAnchor),
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    func scrollToStart() {
        scroller.contentOffset = .zero
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        scroller.frame = bounds
        scroller.layoutIfNeeded() // the chips' frames and the content size
        row.layoutIfNeeded()
        scroller.frame.size.width = visibleWidth(of: bounds.width)
        let maxOffset = max(0, scroller.contentSize.width - scroller.bounds.width)
        if scroller.contentOffset.x > maxOffset { scroller.contentOffset.x = maxOffset }
        updateFade()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        updateFade()
    }

    /// `room`, or less when the row overflows and the chip at that edge would barely show (or the edge falls between
    /// two chips): then the window ends 14 pt inside the chip before it.
    private func visibleWidth(of room: CGFloat) -> CGFloat {
        let chips = row.arrangedSubviews.filter { !$0.isHidden }
        guard row.bounds.width > room + 0.5, let next = chips.firstIndex(where: { $0.frame.maxX > room }),
              next > 0, room - chips[next].frame.minX < 14 else { return room }
        let previous = chips[next - 1].frame
        return max(previous.minX + 24, previous.maxX - 14)
    }

    private func updateFade() {
        let width = scroller.bounds.width
        let contentWidth = scroller.contentSize.width
        guard width > 0, contentWidth > width + 0.5 else {
            layer.mask = nil
            return
        }
        let offset = scroller.contentOffset.x
        let edge = min(16, width / 4) / width
        let opaque = UIColor.black.cgColor, clear = UIColor.clear.cgColor
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fade.frame = scroller.frame
        fade.colors = [offset > 0.5 ? clear : opaque, opaque, opaque, offset + width < contentWidth - 0.5 ? clear : opaque]
        fade.locations = [0, edge, 1 - edge, 1].map { NSNumber(value: Double($0)) }
        layer.mask = fade
        CATransaction.commit()
    }

    private final class Scroller: UIScrollView {
        /// A drag that starts on a chip scrolls the row (UIScrollView keeps touches that start on controls).
        override func touchesShouldCancel(in view: UIView) -> Bool { true }
    }
}
