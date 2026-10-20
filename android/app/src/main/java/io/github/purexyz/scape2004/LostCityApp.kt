// LostCityApp: the process (ports AppDelegate.swift).
//
// The log comes first, then the launch line, then the save store (whose stale-temp sweep runs off the UI thread). The
// game session (the WebView and everything around it) is created when the first activity needs it, never here: the
// system can start this process without an activity (a backup, the Files app's view of the saves), and creating a
// WebView costs a few hundred milliseconds.
package io.github.purexyz.scape2004

import android.app.Application
import java.io.File

class LostCityApp : Application() {
    /** filesDir/Documents: the saves, in the iOS app's layout (docs/ANDROID.md §1 Saves on disk). */
    val saveStore: SaveStore by lazy { SaveStore(File(filesDir, "Documents")) }

    /** The game, for the life of the process (D5: a recreated activity re-attaches it, never reloads it). */
    val session: GameSession by lazy { GameSession(this) }

    override fun onCreate() {
        super.onCreate()
        Log.setUp(this)
        Log.info("app", AppInfo.launchLine())
        RSTheme.init(this)
        Thread({ saveStore.removeStaleTempFiles() }, "lostcity-sweep").start()
    }
}
