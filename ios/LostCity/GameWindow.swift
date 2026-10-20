import UIKit

/// The app's window. Reports touches and key presses, so `GameViewController` can keep the screen
/// awake while someone is playing but let a phone that was put down mid-session lock as usual.
final class GameWindow: UIWindow {
    var onUserActivity: (() -> Void)?

    override func sendEvent(_ event: UIEvent) {
        if event.type == .touches || event.type == .presses {
            onUserActivity?()
        }
        super.sendEvent(event)
    }
}
