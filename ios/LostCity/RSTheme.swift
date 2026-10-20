import CoreText
import UIKit

/// The 2004 look for the few native views (keyboard bar, loading and error cover, notices): the game's bitmap fonts and
/// sprites, which `web/ui/build.mjs` converts from Server/content into the bundle's `Game/ui/` (TrueType fonts drawn
/// from one square per game pixel, and PNG sprites with transparency) for the web page's HUD.
///
/// Font sizes: 16 pt draws one game pixel per point, like the page (3 device pixels on an iPhone), so the glyphs stay
/// sharp; use multiples of 16 (or of 8 on a 2× screen: the loading cover's ×1.5 zoom on an iPad draws 24 pt, 3
/// device pixels per game pixel there). At 16 pt every font has whole-point metrics (ascent/descent: Plain 11 10/2,
/// Plain 12 and Bold 12 12/4, Quill 8 15/5, no leading), so a label exactly one line tall puts its baseline where the
/// page's CSS line box of the same height does. Everything falls back to system fonts and plain colours if the files
/// are missing.
enum RSTheme {
    enum Font: String {
        case plain11 = "p11"
        case plain12 = "p12"
        case bold12 = "b12"
        case quill8 = "q8"
    }

    static let yellow = UIColor(red: 1, green: 1, blue: 0, alpha: 1)
    static let orange = UIColor(red: 1, green: 0x98 / 255.0, blue: 0x1F / 255.0, alpha: 1)
    static let red = UIColor(red: 1, green: 0, blue: 0, alpha: 1)
    static let stone = UIColor(red: 0x45 / 255.0, green: 0x3C / 255.0, blue: 0x30 / 255.0, alpha: 1)
    static let stoneLight = UIColor(red: 0x77 / 255.0, green: 0x67 / 255.0, blue: 0x54 / 255.0, alpha: 1)
    static let stoneDark = UIColor(red: 0x20 / 255.0, green: 0x1B / 255.0, blue: 0x15 / 255.0, alpha: 1)
    static let menu = UIColor(red: 0x5D / 255.0, green: 0x54 / 255.0, blue: 0x47 / 255.0, alpha: 1)
    /// The 2004 loader's bar (`#8c1111`) and the line under it (`#75a9a9`), as on the page's `#loading`.
    static let loadingRed = UIColor(red: 0x8C / 255.0, green: 0x11 / 255.0, blue: 0x11 / 255.0, alpha: 1)
    static let loadingCaption = UIColor(red: 0x75 / 255.0, green: 0xA9 / 255.0, blue: 0xA9 / 255.0, alpha: 1)

    static var uiDirectory: URL {
        (Bundle.main.url(forResource: "Game", withExtension: nil) ?? Bundle.main.bundleURL.appendingPathComponent("Game"))
            .appendingPathComponent("ui")
    }

    /// The font at `scale` game pixels per point (1 = 16 pt), or a system font of about the same size.
    static func font(_ font: Font, scale: CGFloat = 1) -> UIFont {
        let size = 16 * scale
        if let descriptor = descriptors[font] {
            return UIFont(descriptor: descriptor, size: size)
        }
        return font == .bold12 ? .boldSystemFont(ofSize: 12 * scale) : .systemFont(ofSize: 12 * scale)
    }

    /// A sprite from `Game/ui/sprites/<name>.png` at `scale` points per game pixel (1: one game pixel per point). It is
    /// redrawn once at the screen's scale with nearest-neighbour sampling, so UIKit never smooths the game's pixels
    /// when it scales or stretches it.
    static func sprite(_ name: String, scale: CGFloat = 1) -> UIImage? {
        let key = scale == 1 ? name : "\(name)@\(scale)"
        if let cached = spriteCache[key] {
            return cached
        }
        let url = uiDirectory.appendingPathComponent("sprites/\(name).png")
        guard let data = try? Data(contentsOf: url), let decoded = UIImage(data: data, scale: 1) else { return nil }
        let size = CGSize(width: decoded.size.width * scale, height: decoded.size.height * scale)
        let format = UIGraphicsImageRendererFormat.preferred() // the screen's scale
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            context.cgContext.interpolationQuality = .none
            decoded.draw(in: CGRect(origin: .zero, size: size))
        }
        spriteCache[key] = image
        return image
    }

    /// `sprite(name, scale:)` with every colour channel multiplied by `factor`, like the page's CSS `filter:
    /// brightness()` on a pressed button.
    static func brightSprite(_ name: String, factor: CGFloat, scale: CGFloat = 1) -> UIImage? {
        let key = scale == 1 ? "\(name)*\(factor)" : "\(name)@\(scale)*\(factor)"
        if let cached = spriteCache[key] {
            return cached
        }
        guard let base = sprite(name, scale: scale) else { return nil }
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = base.scale
        format.preferredRange = .standard // clamp at white, as CSS does
        let image = UIGraphicsImageRenderer(size: base.size, format: format).image { context in
            context.cgContext.interpolationQuality = .none
            let rect = CGRect(origin: .zero, size: base.size)
            base.draw(in: rect)
            // c + (factor - 1) × c: the sprite again, added on top
            base.draw(in: rect, blendMode: .plusLighter, alpha: factor - 1)
        }
        spriteCache[key] = image
        return image
    }

    /// `text` with the punctuation the game's fonts do not have (they cover Latin-1 and the euro) replaced by what the
    /// 2004 client would write, so a label does not fall back to a system font for an ellipsis or a curly quote, and
    /// typed text is not dropped by the client (it takes plain ASCII).
    static func gameText(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{2026}", with: "...")
            .replacingOccurrences(of: "\u{2018}", with: "'")
            .replacingOccurrences(of: "\u{2019}", with: "'")
            .replacingOccurrences(of: "\u{201C}", with: "\"")
            .replacingOccurrences(of: "\u{201D}", with: "\"")
            .replacingOccurrences(of: "\u{2013}", with: "-")
            .replacingOccurrences(of: "\u{2014}", with: "-")
    }

    /// A 2004 interface button (grey, or red when `on`), stretched around its 5-pixel bevel like the page's
    /// `.stone-btn`; `pressed` is 25 % brighter (`.stone-btn.pressed`).
    static func buttonImage(on: Bool = false, pressed: Bool = false) -> UIImage? {
        let name = on ? "miscgraphics-9" : "miscgraphics-0"
        return (pressed ? brightSprite(name, factor: 1.25) : sprite(name))?
            .resizableImage(withCapInsets: UIEdgeInsets(top: 5, left: 5, bottom: 5, right: 5), resizingMode: .stretch)
    }

    /// The Game Options tab's small button (grey, or red when `on`), stretched around its 4-pixel frame like the
    /// page's `.seg button`.
    static func optionButtonImage(on: Bool = false) -> UIImage? {
        sprite(on ? "miscgraphics3-1" : "miscgraphics3-0")?
            .resizableImage(withCapInsets: UIEdgeInsets(top: 4, left: 4, bottom: 4, right: 4), resizingMode: .stretch)
    }

    /// The title screen's slate button, stretched around its 6-pixel frame like the page's `.title-btn`
    /// (`border-image: … 6 fill / 6px stretch`), at `scale` points per game pixel; `pressed` is 20 % brighter
    /// (`.title-btn:active`).
    static func titleButtonImage(pressed: Bool = false, scale: CGFloat = 1) -> UIImage? {
        (pressed ? brightSprite("titlebutton", factor: 1.2, scale: scale) : sprite("titlebutton", scale: scale))?
            .resizableImage(withCapInsets: UIEdgeInsets(top: 6 * scale, left: 6 * scale, bottom: 6 * scale, right: 6 * scale),
                            resizingMode: .stretch)
    }

    /// The brown stone fill of the game's windows, as a tiling colour.
    static var stoneFill: UIColor {
        sprite("tradebacking").map { UIColor(patternImage: $0) } ?? stone
    }

    /// Gives a label the game's hard black text shadow (one game pixel down and right).
    static func applyShadow(to label: UILabel, scale: CGFloat = 1) {
        label.shadowColor = .black
        label.shadowOffset = CGSize(width: scale, height: scale)
    }

    /// A button configuration drawn entirely by the game's sprite `background` (one of the images above): no system
    /// tint, highlight or rounding (a configuration rounds its background by default, which clips the sprite's
    /// square-notched corners).
    static func buttonConfiguration(background: UIImage?, insets: NSDirectionalEdgeInsets) -> UIButton.Configuration {
        var configuration = UIButton.Configuration.plain()
        configuration.background.image = background
        configuration.background.imageContentMode = .scaleToFill
        configuration.background.cornerRadius = 0
        configuration.cornerStyle = .fixed
        configuration.contentInsets = insets
        if background == nil { // no sprites: still a recognisable button
            configuration.background.backgroundColor = stone
            configuration.background.strokeColor = stoneLight
            configuration.background.strokeWidth = 1
        }
        return configuration
    }

    /// A button title in the game's look: the game font (at `scale`) in `color` with the hard black shadow.
    static func buttonTitle(_ title: String, font: Font = .bold12, color: UIColor = .white, scale: CGFloat = 1) -> AttributedString {
        let shadow = NSShadow()
        shadow.shadowColor = UIColor.black
        shadow.shadowOffset = CGSize(width: scale, height: scale)
        shadow.shadowBlurRadius = 0
        let string = NSAttributedString(string: gameText(title), attributes: [
            .font: self.font(font, scale: scale), .foregroundColor: color, .shadow: shadow,
        ])
        return (try? AttributedString(string, including: \.uiKit)) ?? AttributedString(title)
    }

    // MARK: - Registration

    private static var spriteCache: [String: UIImage] = [:]

    /// Registered once, on first use (process scope: nothing is installed system-wide).
    private static let descriptors: [Font: UIFontDescriptor] = {
        var result: [Font: UIFontDescriptor] = [:]
        for font in [Font.plain11, .plain12, .bold12, .quill8] {
            let url = uiDirectory.appendingPathComponent("fonts/\(font.rawValue).ttf")
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            var error: Unmanaged<CFError>?
            if !CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
                // already registered (a second scene) is fine; anything else falls back to system fonts
                let code = (error?.takeRetainedValue()).map { CFErrorGetCode($0) } ?? 0
                if code != CTFontManagerError.alreadyRegistered.rawValue {
                    Log.info("theme", "font \(font.rawValue) not registered (CoreText error \(code))")
                    continue
                }
            }
            guard let list = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor], let first = list.first,
                  let name = CTFontDescriptorCopyAttribute(first, kCTFontNameAttribute) as? String else { continue }
            result[font] = UIFontDescriptor(name: name, size: 16)
        }
        return result
    }()
}
