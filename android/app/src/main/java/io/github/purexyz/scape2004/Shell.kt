// Shell: the parts of the Android shell built on the native core's seams by the "shell" track (docs/ANDROID.md §4
// "Shell"): haptics (Haptics.kt), the sound mode, audio focus and the
// background mute (AudioSessionController.kt), and the pixel copy of the page's loader with its error screen and
// notices (LoadingCover.kt). GameSession installs them once, before its first activity attaches, in the order iOS's
// GameViewController calls their counterparts. (The Files app's view of the saves, SavesDocumentsProvider, needs no
// session: the system starts it by itself, with or without the game.)
package io.github.purexyz.scape2004

object Shell {
    fun install(session: GameSession, app: LostCityApp) {
        session.components += HapticsComponent(session, app)
        session.components += AudioSessionController(session, app)
        session.components += LoadingCoverComponent(session)
        // (DEBUG: the provider's operations as the Files app calls them, for android/test/shell.mjs)
        session.debugAction("documents") { message, reply ->
            Thread({
                val result = SavesDocumentsDebug.run(app, message)
                MainScheduler.post { reply(result) }
            }, "lostcity-documents-debug").start()
        }
    }
}
