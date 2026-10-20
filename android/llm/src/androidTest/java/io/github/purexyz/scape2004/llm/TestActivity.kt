// A bare activity for the instrumented tests: the key's secure box (KeyEntryDialog) needs one to show over, as it shows
// over the game's in the app.
package io.github.purexyz.scape2004.llm

import android.app.Activity
import android.os.Bundle
import android.widget.FrameLayout

class TestActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(FrameLayout(this))
    }
}
