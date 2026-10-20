import UIKit

/// UIScene lifecycle (mandatory when building with the iOS 27 SDK). App-level lifecycle events are
/// observed by `GameViewController` through the UIApplication notifications.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = GameWindow(windowScene: windowScene)
        window.backgroundColor = .black  // no white flash between the launch screen and the first frame
        window.rootViewController = GameViewController()
        window.makeKeyAndVisible()
        self.window = window
    }
}
