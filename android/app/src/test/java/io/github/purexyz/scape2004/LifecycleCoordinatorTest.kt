// LifecycleCoordinator's rules (LifecycleCoordinator.swift's, unchanged) with a fake page and clock: one flush in flight,
// no double sends, a failed flush retried by the next suspending event, a resume queued behind a flush, the 8 s timeout,
// late answers ignored, reset.
package io.github.purexyz.scape2004

import io.github.purexyz.scape2004.LifecycleCoordinator.Event
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class LifecycleCoordinatorTest {
    private class Call(val event: String, val completion: (PageBridge.Outcome) -> Unit)

    private lateinit var clock: FakeScheduler
    private lateinit var calls: MutableList<Call>
    private lateinit var coordinator: LifecycleCoordinator
    private val finished = ArrayList<Boolean>()

    private val ok = PageBridge.Outcome.Returned(buildJsonObject { put("ok", JsonPrimitive(true)) })
    private val notSaved = PageBridge.Outcome.Returned(buildJsonObject { put("ok", JsonPrimitive(false)); put("error", JsonPrimitive("timeout")) })

    @Before
    fun setUp() {
        clock = FakeScheduler()
        calls = ArrayList()
        coordinator = LifecycleCoordinator({ path, args, completion ->
            assertEquals("lifecycle", path)
            calls.add(Call(args[0].jsonPrimitive.content, completion))
        }, clock)
        coordinator.onFlushFinished = { finished.add(it) }
    }

    private fun sent() = calls.map { it.event }

    @Test
    fun pauseThenBackgroundSendsOneFlush() {
        coordinator.handle(Event.PAUSE)
        coordinator.handle(Event.BACKGROUND) // in flight: not re-sent
        assertEquals(listOf("pause"), sent())
        assertTrue(coordinator.isFlushing)
        clock.advance(14)
        calls[0].completion(ok)
        assertFalse(coordinator.isFlushing)
        assertEquals("paused (saved)", coordinator.stateDescription)
        coordinator.handle(Event.BACKGROUND) // already paused and saved
        coordinator.handle(Event.TERMINATE)
        assertEquals(listOf("pause"), sent())
        assertEquals(listOf(true), finished)
    }

    @Test
    fun onlyTheFirstResumeIsSent() {
        coordinator.handle(Event.PAUSE)
        calls[0].completion(ok)
        coordinator.handle(Event.FOREGROUND)
        coordinator.handle(Event.RESUME) // already running
        assertEquals(listOf("pause", "foreground"), sent())
        assertEquals("running", coordinator.stateDescription)
        coordinator.handle(Event.RESUME)
        assertEquals(2, calls.size)
    }

    @Test
    fun aFailedFlushIsRetriedByTheNextSuspendingEvent() {
        coordinator.handle(Event.PAUSE)
        calls[0].completion(notSaved) // {ok: false}: a save could not be written
        assertEquals("paused (not saved)", coordinator.stateDescription)
        coordinator.handle(Event.BACKGROUND)
        assertEquals(listOf("pause", "background"), sent())
        calls[1].completion(ok)
        assertEquals(listOf(false, true), finished)
    }

    @Test
    fun aFailedCallIsAFailedFlush() {
        coordinator.handle(Event.PAUSE)
        calls[0].completion(PageBridge.Outcome.Failed("page gone"))
        coordinator.handle(Event.BACKGROUND)
        assertEquals(2, calls.size)
    }

    @Test
    fun aMissingHostCountsAsSaved() {
        coordinator.handle(Event.PAUSE)
        calls[0].completion(PageBridge.Outcome.Missing) // nothing to save on a page still booting
        coordinator.handle(Event.BACKGROUND)
        assertEquals(1, calls.size)
    }

    @Test
    fun aResumeDuringAFlushIsSentAfterIt() {
        coordinator.handle(Event.PAUSE)
        coordinator.handle(Event.RESUME)
        assertEquals(listOf("pause"), sent())
        calls[0].completion(ok)
        assertEquals(listOf("pause", "resume"), sent())
        assertEquals("running", coordinator.stateDescription)
    }

    @Test
    fun aSuspendingEventCancelsTheQueuedResume() {
        coordinator.handle(Event.PAUSE)
        coordinator.handle(Event.RESUME)
        coordinator.handle(Event.BACKGROUND) // going down again: the queued resume is superseded
        calls[0].completion(ok)
        assertEquals(listOf("pause"), sent())
        assertEquals("paused (saved)", coordinator.stateDescription)
    }

    @Test
    fun theFlushTimesOutAfterEightSecondsAndALateAnswerIsIgnored() {
        coordinator.handle(Event.PAUSE)
        clock.advance(7_999)
        assertTrue(coordinator.isFlushing)
        clock.advance(1)
        assertFalse(coordinator.isFlushing)
        assertEquals("paused (not saved)", coordinator.stateDescription)
        assertEquals(listOf(false), finished)
        calls[0].completion(ok) // answered late: no change
        assertEquals("paused (not saved)", coordinator.stateDescription)
        assertEquals(listOf(false), finished)
        coordinator.handle(Event.BACKGROUND) // retried
        assertEquals(listOf("pause", "background"), sent())
    }

    @Test
    fun resetAbandonsAFlush() {
        coordinator.handle(Event.PAUSE)
        coordinator.reset()
        assertEquals("running", coordinator.stateDescription)
        calls[0].completion(ok) // the old page's answer: late
        assertEquals("running", coordinator.stateDescription)
        clock.advance(10_000) // the timeout was cancelled
        assertEquals(emptyList<Boolean>(), finished)
        coordinator.handle(Event.RESUME) // running: nothing
        assertEquals(1, calls.size)
    }

    @Test
    fun eventNames() {
        assertEquals(Event.TERMINATE, Event.of("terminate"))
        assertEquals(null, Event.of("bogus"))
        assertTrue(Event.BACKGROUND.suspends)
        assertFalse(Event.FOREGROUND.suspends)
    }
}
