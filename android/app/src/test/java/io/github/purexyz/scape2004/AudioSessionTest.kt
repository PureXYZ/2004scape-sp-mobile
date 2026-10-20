// AudioSession (AudioSessionController.kt; docs/ANDROID.md §1 Sound) with a fake AudioManager:
// the game takes audio focus while resumed, is muted by losing it and in the background, and the mute is applied only
// when it changes.
package io.github.purexyz.scape2004

import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioSessionTest {
    private class FakeAudio : AudioSession.Platform {
        var grant = AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        var requests = 0
        var abandons = 0
        val mutes = ArrayList<Boolean>()

        override fun requestFocus(): Int {
            requests++
            return grant
        }

        override fun abandonFocus() {
            abandons++
        }

        override fun applyMute(muted: Boolean, reason: String) {
            mutes += muted
        }
    }

    private val fake = FakeAudio()
    private val audio = AudioSession(fake)

    private fun foreground() {
        audio.start()
        audio.resume()
    }

    @Test
    fun playbackTakesFocusWhileResumed() {
        foreground()
        assertEquals(1, fake.requests)
        assertEquals(AudioSession.Focus.HELD, audio.focus)
        assertFalse(audio.muted)
        audio.pause()
        assertEquals(1, fake.abandons)
        assertEquals(AudioSession.Focus.NONE, audio.focus)
        assertFalse("paused but visible: still playing", audio.muted)
        audio.stop()
        assertTrue(audio.muted)
        assertEquals("in the background", audio.muteReason)
        // applied only on changes: unmuted at start, muted at stop
        assertEquals(listOf(false, true), fake.mutes)
    }

    @Test
    fun alwaysMutedInTheBackground() {
        audio.start()
        audio.stop()
        assertTrue(audio.muted)
        assertEquals(0, fake.requests) // (never resumed: no focus)
    }

    @Test
    fun losingFocusMutes() {
        foreground()
        audio.focusChanged(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        assertTrue(audio.muted)
        assertEquals("audio focus lost for now", audio.muteReason)
        audio.focusChanged(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) // (the system ducks a game itself)
        assertTrue(audio.muted)
        audio.focusChanged(AudioManager.AUDIOFOCUS_GAIN)
        assertFalse(audio.muted)
        audio.focusChanged(AudioManager.AUDIOFOCUS_LOSS)
        assertTrue(audio.muted)
        assertEquals(1, fake.abandons) // the dropped request is given back
        // until the next resume asks again
        audio.pause()
        assertEquals(1, fake.abandons)
        audio.resume()
        assertEquals(2, fake.requests)
        assertFalse(audio.muted)
    }

    @Test
    fun aRefusedRequestMutesAndIsRetried() {
        fake.grant = AudioManager.AUDIOFOCUS_REQUEST_FAILED
        foreground()
        assertTrue(audio.muted)
        assertEquals(AudioSession.Focus.REFUSED, audio.focus)
        audio.pause()
        assertEquals(0, fake.abandons) // (nothing to give back)
        fake.grant = AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        audio.resume()
        assertFalse(audio.muted)
    }

    @Test
    fun lateFocusCallbacksAreIgnored() {
        foreground()
        audio.pause()
        audio.focusChanged(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        assertFalse(audio.muted)
    }

    @Test
    fun reapplyForcesTheMute() {
        foreground()
        val before = fake.mutes.size
        audio.reapply()
        assertEquals(before + 1, fake.mutes.size)
        assertEquals(false, fake.mutes.last())
    }
}
