import UIKit

/// `{type:'haptic', style}` → UIKit feedback generators.
///
/// Styles: `light`, `medium`, `heavy`, `soft`, `rigid` (impact), `selection`, and `success`,
/// `warning`, `error` (notification). Anything else plays a medium impact. An optional
/// `intensity` (0…1) scales impacts.
///
/// Generators are created once and `prepare()`d again after every use: an unprepared Taptic
/// Engine can lag by tens of milliseconds, which is noticeable on long-press feedback. Haptics
/// are silently unavailable in the simulator and on devices without a Taptic Engine.
///
/// Settings › Vibration is the page's: it sends no haptic message while the setting is off, and
/// GameViewController checks it for the haptics native plays itself.
final class Haptics {
    private weak var view: UIView?
    private var impacts: [UIImpactFeedbackGenerator.FeedbackStyle: UIImpactFeedbackGenerator] = [:]
    private var selectionGenerator: UISelectionFeedbackGenerator?
    private var notificationGenerator: UINotificationFeedbackGenerator?
    #if DEBUG
    private var played: [String] = []
    #endif

    init(view: UIView?) {
        self.view = view
    }

    func play(_ style: String, intensity: Double? = nil) {
        switch style {
        case "selection":
            let generator = selection()
            generator.selectionChanged()
            generator.prepare()
        case "success", "warning", "error":
            let generator = notification()
            generator.notificationOccurred(style == "success" ? .success : style == "warning" ? .warning : .error)
            generator.prepare()
        default:
            let generator = impact(Self.impactStyle(style))
            if let intensity {
                generator.impactOccurred(intensity: CGFloat(min(1, max(0, intensity))))
            } else {
                generator.impactOccurred()
            }
            generator.prepare()
        }
        Log.debug("haptic", style)
        #if DEBUG
        played.append(style)
        if played.count > 32 { played.removeFirst() }
        #endif
    }

    /// Warms up the common generators, e.g. when the player enters the game.
    func prepare() {
        impact(.light).prepare()
        impact(.medium).prepare()
        selection().prepare()
    }

    #if DEBUG
    /// The styles played since the last call (at most the last 32), oldest first: the simulator has no Taptic Engine,
    /// so test pages read them through GameViewController's `haptics` debug hook.
    func debugTakePlayed() -> [String] {
        defer { played.removeAll() }
        return played
    }
    #endif

    private static func impactStyle(_ style: String) -> UIImpactFeedbackGenerator.FeedbackStyle {
        switch style {
        case "light": .light
        case "heavy": .heavy
        case "soft": .soft
        case "rigid": .rigid
        default: .medium
        }
    }

    private func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle) -> UIImpactFeedbackGenerator {
        if let generator = impacts[style] { return generator }
        let generator: UIImpactFeedbackGenerator
        if #available(iOS 17.5, *), let view {
            generator = UIImpactFeedbackGenerator(style: style, view: view)
        } else {
            generator = UIImpactFeedbackGenerator(style: style)
        }
        impacts[style] = generator
        return generator
    }

    private func selection() -> UISelectionFeedbackGenerator {
        if let selectionGenerator { return selectionGenerator }
        let generator: UISelectionFeedbackGenerator
        if #available(iOS 17.5, *), let view {
            generator = UISelectionFeedbackGenerator(view: view)
        } else {
            generator = UISelectionFeedbackGenerator()
        }
        selectionGenerator = generator
        return generator
    }

    private func notification() -> UINotificationFeedbackGenerator {
        if let notificationGenerator { return notificationGenerator }
        let generator: UINotificationFeedbackGenerator
        if #available(iOS 17.5, *), let view {
            generator = UINotificationFeedbackGenerator(view: view)
        } else {
            generator = UINotificationFeedbackGenerator()
        }
        notificationGenerator = generator
        return generator
    }
}
