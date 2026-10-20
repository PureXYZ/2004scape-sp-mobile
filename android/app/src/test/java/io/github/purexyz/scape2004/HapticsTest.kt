// HapticTable (Haptics.kt): every style on each tier, unknown styles as `medium`,
// `intensity` on impacts only (clamped), the tier chosen from what the vibrator supports.
package io.github.purexyz.scape2004

import android.os.VibrationEffect
import android.view.HapticFeedbackConstants
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HapticsTest {
    private val click = VibrationEffect.Composition.PRIMITIVE_CLICK
    private val tick = VibrationEffect.Composition.PRIMITIVE_TICK
    private val lowTick = VibrationEffect.Composition.PRIMITIVE_LOW_TICK
    private fun p(id: Int, scale: Float, delay: Int = 0) = HapticTable.Primitive(id, scale, delay)

    @Test
    fun theTable() {
        val expected = mapOf(
            "light" to HapticTable.Entry(listOf(p(click, 0.5f)), VibrationEffect.EFFECT_TICK, HapticFeedbackConstants.KEYBOARD_TAP, impact = true),
            "medium" to HapticTable.Entry(listOf(p(click, 0.75f)), VibrationEffect.EFFECT_CLICK, HapticFeedbackConstants.CONTEXT_CLICK, impact = true),
            "heavy" to HapticTable.Entry(listOf(p(click, 1f)), VibrationEffect.EFFECT_HEAVY_CLICK, HapticFeedbackConstants.LONG_PRESS, impact = true),
            "soft" to HapticTable.Entry(listOf(p(tick, 0.8f)), VibrationEffect.EFFECT_TICK, HapticFeedbackConstants.KEYBOARD_TAP, impact = true),
            "rigid" to HapticTable.Entry(listOf(p(click, 0.9f)), VibrationEffect.EFFECT_CLICK, HapticFeedbackConstants.VIRTUAL_KEY, impact = true),
            "selection" to HapticTable.Entry(listOf(p(tick, 0.5f)), VibrationEffect.EFFECT_TICK, HapticFeedbackConstants.CLOCK_TICK, impact = false),
            "success" to HapticTable.Entry(listOf(p(click, 0.6f), p(click, 1f, 80)), VibrationEffect.EFFECT_DOUBLE_CLICK, HapticFeedbackConstants.CONFIRM, impact = false),
            "warning" to HapticTable.Entry(listOf(p(click, 1f), p(click, 0.5f, 120)), VibrationEffect.EFFECT_DOUBLE_CLICK, HapticFeedbackConstants.REJECT, impact = false),
            "error" to HapticTable.Entry(listOf(p(click, 1f), p(click, 1f, 60), p(click, 1f, 60)), VibrationEffect.EFFECT_HEAVY_CLICK, HapticFeedbackConstants.REJECT, impact = false),
        )
        assertEquals(HapticTable.STYLES.toSet(), expected.keys)
        for ((style, entry) in expected) assertEquals(style, entry, HapticTable.entry(style, lowTick = false, sdk = 33))
    }

    @Test
    fun unknownStylesAreMedium() {
        assertEquals(HapticTable.entry("medium", false, 37), HapticTable.entry("thud", false, 37))
        assertEquals(HapticTable.entry("medium", false, 37), HapticTable.entry("", false, 37))
        assertEquals("medium", HapticTable.styleOf(buildJsonObject {}))
        assertEquals("medium", HapticTable.styleOf(buildJsonObject { put("style", JsonPrimitive(3)) }))
        assertEquals("error", HapticTable.styleOf(buildJsonObject { put("style", JsonPrimitive("error")) }))
    }

    @Test
    fun selectionUsesTheLightestTickAndTheNewerFeedback() {
        assertEquals(listOf(p(lowTick, 1f)), HapticTable.entry("selection", lowTick = true, sdk = 37).composition)
        assertEquals(HapticFeedbackConstants.SEGMENT_TICK, HapticTable.entry("selection", lowTick = true, sdk = 34).feedback)
        assertEquals(HapticFeedbackConstants.CLOCK_TICK, HapticTable.entry("selection", lowTick = true, sdk = 33).feedback)
    }

    @Test
    fun intensityScalesImpactsOnly() {
        val heavy = HapticTable.entry("heavy", false, 37)
        assertEquals(listOf(p(click, 0.25f)), HapticTable.composition(heavy, 0.25))
        assertEquals(listOf(p(click, 0f)), HapticTable.composition(heavy, -1.0)) // clamped
        assertEquals(listOf(p(click, 1f)), HapticTable.composition(heavy, 7.0))
        assertEquals(heavy.composition, HapticTable.composition(heavy, null))
        assertEquals(heavy.composition, HapticTable.composition(heavy, Double.NaN))
        val medium = HapticTable.entry("medium", false, 37)
        assertEquals(0.375f, HapticTable.composition(medium, 0.5).single().scale, 1e-6f)
        // notifications and selection ignore it, as UIKit's generators do
        for (style in listOf("success", "warning", "error", "selection")) {
            val entry = HapticTable.entry(style, false, 37)
            assertFalse(entry.impact)
            assertEquals(style, entry.composition, HapticTable.composition(entry, 0.1))
        }
        for (style in listOf("light", "medium", "heavy", "soft", "rigid")) assertTrue(HapticTable.entry(style, false, 37).impact)
    }

    @Test
    fun theTier() {
        assertEquals(HapticTable.Tier.NONE, HapticTable.tier(hasVibrator = false, primitives = true, effects = true))
        assertEquals(HapticTable.Tier.COMPOSITION, HapticTable.tier(hasVibrator = true, primitives = true, effects = false))
        assertEquals(HapticTable.Tier.PREDEFINED, HapticTable.tier(hasVibrator = true, primitives = false, effects = true))
        assertEquals(HapticTable.Tier.FEEDBACK, HapticTable.tier(hasVibrator = true, primitives = false, effects = false))
    }
}
