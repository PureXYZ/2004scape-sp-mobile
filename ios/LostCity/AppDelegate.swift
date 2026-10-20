import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    override init() {
        // First thing: line-buffer stdout so every print reaches `devicectl --console` promptly.
        Log.setUp()
        super.init()
    }

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        Log.info("app", "Lost City \(AppInfo.version) (\(AppInfo.build)\(AppInfo.isDebug ? ", debug" : "")) on \(AppInfo.deviceModel), iOS \(UIDevice.current.systemVersion), pid \(getpid())")
        // The hidden keyboard view is always first responder; shaking the phone mid-game must not
        // pop up an "Undo Typing" alert.
        application.applicationSupportsShakeToEdit = false
        return true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }
}
