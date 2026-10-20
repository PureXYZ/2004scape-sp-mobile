import UIKit

/// Black cover from launch until the page is up, and while the page restarts. It is the page's own loader, drawn
/// natively with the same geometry (web/host/index.html `#loading` + host.css), so when the page takes over there is
/// nothing to see:
///
/// * the RuneScape logo (`ui/sprites/logo.png`, 444 × 142, at most 80 % of the width), the card centred vertically;
/// * 18 pt below it the 304 × 34 bar: a 2 pt `#8c1111` border, a `#8c1111` fill from the left (`progress`, the
///   value the page's loader starts from) and "Loading - please wait." in RS Bold 12, white with the hard shadow;
/// * 12 pt below the bar "2004Scape · November 2004 · offline" in RS Plain 11, `#75a9a9`.
///
/// On a large screen the page draws its overlays zoomed as a whole (host.js `layout()`'s `--ui-zoom`: ×1.5 or ×2 on
/// an iPad, see `zoom(for:insets:)`), and so does the cover: every length here and in the error screen below, the
/// padding, fonts, borders, shadows and line heights included, is multiplied by the same zoom. On an iPhone it is 1.
///
/// Frames are rounded to device pixels so the game's pixel fonts and the logo stay as sharp as on the page.
///
/// When native has no page to show (the page could not be loaded, or WebContent keeps crashing) it becomes the
/// 2004 error screen, like the page's `#error`: "Error - unable to continue!" in yellow RS Bold 12 at 32 pt, the
/// message in RS Plain 12, and a title-screen button, "Try again". Errors the page can show itself are the page's.
final class LoadingOverlay: UIView {
    /// The bar's fill while native has the screen: where the page's loader starts (host.js `showLoaderProgress`,
    /// 0.06 + 0.94 × progress), so it never runs backwards at the hand-over.
    static let progress: CGFloat = 0.06

    private static let loadingText = "Loading - please wait."
    private static let captionText = "2004Scape \u{00B7} November 2004 \u{00B7} offline"
    /// logo 142 + 18 + bar 34 + 12 + caption line 12
    private static let cardHeight: CGFloat = 218

    /// The page's zoom for these bounds (`zoom(for:insets:)`), which `layoutSubviews` keeps up to date.
    private var zoom: CGFloat = 1

    /// Settings › Display › Side margin, Top margin and Bottom margin (`safeSides`, `safeTop`, `safeBottom`: -1 None,
    /// 0 Auto, 16 or 32 more), which the page lays its overlay out with (`pageInsets`); GameViewController keeps them
    /// current.
    var margins: (sides: CGFloat, top: CGFloat, bottom: CGFloat) = (0, 0, 0) {
        didSet {
            if margins != oldValue { setNeedsLayout() }
        }
    }

    private let logo = UIImageView()
    private let logoFallback = UILabel()
    private let bar = UIView()
    private let barFill = UIView()
    private let barText = UILabel()
    private let caption = UILabel()

    private let errorTitle = UILabel()
    private let errorText = UILabel()
    private let retryButton = UIButton(type: .custom)
    private var retry: (() -> Void)?
    private var errorMessage = ""

    init() {
        super.init(frame: .zero)
        backgroundColor = .black

        logo.contentMode = .scaleAspectFit
        logo.layer.magnificationFilter = .nearest // `image-rendering: pixelated`
        logo.layer.minificationFilter = .nearest
        logo.isAccessibilityElement = true
        logo.accessibilityLabel = "RuneScape"
        logoFallback.text = "2004Scape"
        logoFallback.textColor = RSTheme.yellow
        logoFallback.textAlignment = .center

        bar.backgroundColor = .black
        bar.layer.borderColor = RSTheme.loadingRed.cgColor
        barFill.backgroundColor = RSTheme.loadingRed
        barText.text = Self.loadingText
        barText.textColor = .white
        caption.text = Self.captionText
        caption.textColor = RSTheme.loadingCaption

        errorTitle.text = "Error - unable to continue!"
        errorTitle.textColor = RSTheme.yellow
        errorText.numberOfLines = 8
        errorText.lineBreakMode = .byTruncatingTail
        retryButton.configurationUpdateHandler = { [weak self] button in
            button.configuration?.background.image = RSTheme.titleButtonImage(pressed: button.isHighlighted, scale: self?.zoom ?? 1)
        }
        retryButton.addAction(UIAction { [weak self] _ in self?.retryTapped() }, for: .primaryActionTriggered)
        applyZoom()

        for view in [logo, logoFallback, bar, caption, errorTitle, errorText, retryButton] { addSubview(view) }
        bar.addSubview(barFill)
        bar.addSubview(barText)
        setError(false)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    var isShowing: Bool { !isHidden && alpha > 0 }
    /// Showing the error screen (waiting for "Try again"), as opposed to the loader.
    var isShowingError: Bool { isShowing && retry != nil }

    /// The loader.
    func show() {
        layer.removeAllAnimations()
        retry = nil
        setError(false)
        appear()
    }

    /// The error screen; "Try again" calls `retry`.
    func showError(_ message: String, retry: @escaping () -> Void) {
        layer.removeAllAnimations()
        self.retry = retry
        errorMessage = message
        styleErrorText()
        setError(true)
        appear()
        UIAccessibility.post(notification: .screenChanged, argument: errorTitle)
    }

    /// The error message as the page's `.error-text` (`font: 16px/18px`), at `zoom`.
    private func styleErrorText() {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.minimumLineHeight = 18 * zoom
        paragraph.maximumLineHeight = 18 * zoom
        paragraph.lineBreakMode = .byTruncatingTail // wraps by word; a ninth line would end in "..."
        errorText.attributedText = NSAttributedString(string: RSTheme.gameText(errorMessage), attributes: [
            .font: RSTheme.font(.plain12, scale: zoom), .foregroundColor: UIColor.white, .paragraphStyle: paragraph,
            .baselineOffset: zoom, // CSS splits the 2 pt of leading around the text; TextKit puts it all above
        ])
    }

    func hide() {
        guard isShowing else { return }
        retry = nil
        isUserInteractionEnabled = false
        UIView.animate(withDuration: 0.25, animations: { self.alpha = 0 }, completion: { finished in
            guard finished else { return }
            self.isHidden = true
        })
    }

    private func appear() {
        alpha = 1
        isHidden = false
        isUserInteractionEnabled = true // the page underneath gets no touches meanwhile
        setNeedsLayout()
    }

    private func setError(_ error: Bool) {
        for view in [logo, bar, caption] { view.isHidden = error }
        logoFallback.isHidden = error || logo.image != nil
        for view in [errorTitle, errorText, retryButton] { view.isHidden = !error }
    }

    private func retryTapped() {
        guard let retry else { return }
        self.retry = nil
        retry()
    }

    #if DEBUG
    /// "Try again", as a tap delivers it (test pages, through GameViewController's debug hooks).
    func debugTapRetry() {
        retryButton.sendActions(for: .primaryActionTriggered)
    }

    /// The zoom and the frames, `[x, y, width, height]` in points (the bar's text and fill in the bar), for test pages
    /// through GameViewController's `ui-state` debug hook.
    var debugLayout: [String: Any] {
        let frame = { (view: UIView) in [view.frame.minX, view.frame.minY, view.frame.width, view.frame.height].map { Double($0) } }
        return [
            "zoom": Double(zoom), "font": Double(barText.font.pointSize),
            "logo": frame(logo), "bar": frame(bar), "barFill": frame(barFill), "barText": frame(barText), "caption": frame(caption),
            "errorTitle": frame(errorTitle), "errorText": frame(errorText), "retry": frame(retryButton),
        ]
    }
    #endif

    // MARK: - Layout (the page's CSS, in points = CSS px)

    /// host.js `layout()`'s zoom (ARCHITECTURE.md §6.1) for a view of `size` points with the safe-area `insets`: the
    /// largest of ×2 and ×1.5 that the height allows (720 and 540 pt) and that still leaves at least 667 pt (the
    /// narrowest phone the HUD is laid out for) between the safe areas at that zoom; otherwise 1. That is 1 on every
    /// iPhone, 1.5 on an iPad mini or an 11-inch iPad and 2 on a 13-inch one.
    /// host.js `readSafeArea` for the system's safe area `system` and the margins: the sides equal, the larger of the
    /// two plus `sides` (0 at None); the top the system's plus `top` (0 at None); the bottom `bottom` (0 at None and at
    /// Auto: iOS's bottom inset is the home indicator, which the page covers).
    static func pageInsets(_ system: UIEdgeInsets, sides: CGFloat, top: CGFloat, bottom: CGFloat) -> UIEdgeInsets {
        let side = sides < 0 ? 0 : max(system.left, system.right) + sides
        return UIEdgeInsets(top: top < 0 ? 0 : system.top + top, left: side, bottom: max(0, bottom), right: side)
    }

    static func zoom(for size: CGSize, insets: UIEdgeInsets) -> CGFloat {
        let heightZoom: CGFloat = size.height >= 720 ? 2 : size.height >= 540 ? 1.5 : 1
        let usable = size.width - insets.left - insets.right
        let zooms: [CGFloat] = [2, 1.5]
        return zooms.first { $0 <= heightZoom && usable / $0 >= 667 } ?? 1
    }

    /// The fonts, shadows, borders and sprites at `zoom` (the frames follow in `layoutSubviews`).
    private func applyZoom() {
        logo.image = RSTheme.sprite("logo", scale: zoom)
        logoFallback.font = RSTheme.font(.bold12, scale: 2 * zoom)
        RSTheme.applyShadow(to: logoFallback, scale: 2 * zoom)
        bar.layer.borderWidth = 2 * zoom
        barText.font = RSTheme.font(.bold12, scale: zoom)
        RSTheme.applyShadow(to: barText, scale: zoom)
        caption.font = RSTheme.font(.plain11, scale: zoom)

        errorTitle.font = RSTheme.font(.bold12, scale: 2 * zoom)
        RSTheme.applyShadow(to: errorTitle, scale: 2 * zoom)
        styleErrorText()
        var button = RSTheme.buttonConfiguration(background: RSTheme.titleButtonImage(scale: zoom),
                                                 insets: NSDirectionalEdgeInsets(top: 0, leading: 14 * zoom, bottom: 0, trailing: 14 * zoom))
        button.attributedTitle = RSTheme.buttonTitle("Try again", scale: zoom)
        retryButton.configuration = button
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let insets = Self.pageInsets(safeAreaInsets, sides: margins.sides, top: margins.top, bottom: margins.bottom)
        let zoom = Self.zoom(for: bounds.size, insets: insets)
        if zoom != self.zoom {
            self.zoom = zoom
            applyZoom()
        }
        // `.overlay`: flex-centred in a box padded 10 + the safe area top and bottom, 12 + the safe area left and right;
        // CSS `zoom` scales the box's padding too
        let content = CGRect(x: (12 + insets.left) * zoom, y: (10 + insets.top) * zoom,
                             width: bounds.width - (24 + insets.left + insets.right) * zoom,
                             height: bounds.height - (20 + insets.top + insets.bottom) * zoom)
        if retry == nil {
            layoutLoader(in: content)
        } else {
            layoutError(in: content)
        }
    }

    private func layoutLoader(in content: CGRect) {
        let z = zoom
        let middle = content.midX
        let top = content.minY + (content.height - Self.cardHeight * z) / 2
        let logoWidth = min(444 * z, bounds.width * 0.8) // `max-width: 80vw`; the box stays 142 tall, the image contained
        logo.frame = snap(CGRect(x: middle - logoWidth / 2, y: top, width: logoWidth, height: 142 * z))
        logoFallback.frame = logo.frame
        bar.frame = snap(CGRect(x: middle - 152 * z, y: top + 160 * z, width: 304 * z, height: 34 * z))
        // inside the 2 pt border (300 × 30): the fill from the left, the text's 16 pt line box centred
        barFill.frame = snap(CGRect(x: 2 * z, y: 2 * z, width: 300 * z * Self.progress, height: 30 * z))
        barText.frame = snap(CGRect(x: 2 * z + (300 * z - Self.advance(barText)) / 2, y: 9 * z,
                                    width: ceil(barText.intrinsicContentSize.width), height: 16 * z), text: true)
        caption.frame = snap(CGRect(x: middle - Self.advance(caption) / 2, y: top + 206 * z,
                                    width: ceil(caption.intrinsicContentSize.width), height: 12 * z), text: true)
    }

    /// The width a line of text takes in CSS (UILabel's intrinsic width also counts its shadow).
    private static func advance(_ label: UILabel) -> CGFloat {
        ceil(((label.text ?? "") as NSString).size(withAttributes: [.font: label.font as Any]).width)
    }

    private func layoutError(in content: CGRect) {
        // `.error-panel`: at most 520 wide; title (32), 12, text (18 per line), 16, button (41)
        let z = zoom
        let width = min(520 * z, content.width)
        let textHeight = ceil(errorText.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
        let titleWidth = min(width, Self.advance(errorTitle))
        let buttonWidth = max(147 * z, ceil(retryButton.intrinsicContentSize.width))
        let total = (32 + 12 + 16 + 41) * z + textHeight
        let top = content.minY + max(0, (content.height - total) / 2)
        errorTitle.frame = snap(CGRect(x: content.midX - titleWidth / 2, y: top,
                                       width: min(width, ceil(errorTitle.intrinsicContentSize.width)), height: 32 * z), text: true)
        errorText.frame = snap(CGRect(x: content.midX - width / 2, y: top + 44 * z, width: width, height: textHeight))
        retryButton.frame = snap(CGRect(x: content.midX - buttonWidth / 2, y: top + 60 * z + textHeight, width: buttonWidth, height: 41 * z))
    }

    /// Rounds a frame to device pixels, so text and sprites are not resampled: half up, as WebKit snaps boxes; for
    /// `text`, a horizontal half pixel rounds down, as the page's unsmoothed glyphs land (measured in the simulator).
    private func snap(_ rect: CGRect, text: Bool = false) -> CGRect {
        let scale = max(1, traitCollection.displayScale)
        func round(_ value: CGFloat) -> CGFloat { (value * scale).rounded(.toNearestOrAwayFromZero) / scale }
        let x = text ? ((rect.minX * scale) - 0.5).rounded(.up) / scale : round(rect.minX)
        let y = round(rect.minY)
        return CGRect(x: x, y: y, width: round(x + rect.width) - x, height: round(rect.maxY) - y)
    }
}

/// A short native notice over the game (e.g. "restarting after a crash"), fading out by itself.
enum Notice {
    static func show(_ text: String, in host: UIView, duration: TimeInterval = 3.5) {
        let label = PaddedLabel()
        label.text = RSTheme.gameText(text)
        label.font = RSTheme.font(.plain12)
        label.textColor = RSTheme.yellow
        RSTheme.applyShadow(to: label)
        label.numberOfLines = 0
        label.textAlignment = .center
        label.backgroundColor = UIColor(white: 0, alpha: 0.8)
        label.layer.borderColor = RSTheme.menu.cgColor
        label.layer.borderWidth = 1
        label.clipsToBounds = true
        label.alpha = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: host.centerXAnchor),
            label.topAnchor.constraint(equalTo: host.safeAreaLayoutGuide.topAnchor, constant: 14),
            label.widthAnchor.constraint(lessThanOrEqualTo: host.safeAreaLayoutGuide.widthAnchor, multiplier: 0.8),
        ])
        UIView.animate(withDuration: 0.2) { label.alpha = 1 }
        UIView.animate(withDuration: 0.4, delay: duration, options: [], animations: { label.alpha = 0 }, completion: { _ in
            label.removeFromSuperview()
        })
    }

    private final class PaddedLabel: UILabel {
        private let insets = UIEdgeInsets(top: 10, left: 16, bottom: 10, right: 16)

        override func drawText(in rect: CGRect) {
            super.drawText(in: rect.inset(by: insets))
        }

        override func textRect(forBounds bounds: CGRect, limitedToNumberOfLines numberOfLines: Int) -> CGRect {
            let rect = super.textRect(forBounds: bounds.inset(by: insets), limitedToNumberOfLines: numberOfLines)
            return rect.inset(by: UIEdgeInsets(top: -insets.top, left: -insets.left, bottom: -insets.bottom, right: -insets.right))
        }
    }
}
