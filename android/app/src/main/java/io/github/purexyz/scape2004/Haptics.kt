// Haptics: the page's `{type:'haptic', style, intensity?}` and native's own haptics on the phone's vibrator (ports
// ios/LostCity/Haptics.swift; ARCHITECTURE.md §7 `haptic`; docs/ANDROID.md §4 "Shell: haptics").
//
// * Styles, as on iOS: the impacts `light`, `medium`, `heavy`, `soft`, `rigid`; `selection`; the notifications `success`,
//   `warning`, `error`. Anything else plays a medium impact. `intensity` (0…1, clamped) scales impacts only.
// * Three ways to play one, the best the phone has (chosen once): A, a composition of the vibrator's own primitives
//   (CLICK, TICK, LOW_TICK: short, crisp taps, the closest Android has to the Taptic Engine's), when it supports CLICK and
//   TICK; B, the predefined effects (EFFECT_CLICK, …); C, View.performHapticFeedback on the game's view (any phone with
//   a vibrator, but no intensity). HapticTable says what each style is in each; it is pure, so HapticsTest checks it.
// * Every vibration is a touch vibration (VibrationAttributes USAGE_TOUCH; below API 33 AudioAttributes
//   USAGE_ASSISTANCE_SONIFICATION, which the system files as touch), so the system's Settings › Sound & vibration ›
//   Touch feedback governs it, intensity and off, as the iPhone's System Haptics switch governs UIKit's generators.
//   With Touch feedback off (`haptic_feedback_enabled` 0) nothing is sent at all.
// * The effects are built once per style; `prepare()` builds the common ones when the player enters the world (iOS
//   warms its generators then), so the first tap in the world allocates nothing.
// * Settings › Vibration is the page's: the page sends nothing while it is off, and GameSession.playHaptic checks it for
//   the haptics native plays itself (a refused key: `warning`; a fatal error: `error`), as GameViewController does.
// * A phone without a vibrator (many tablets) plays nothing; LostCityNative.haptics is false there and the page hides
//   the Vibration row. DEBUG builds keep the last 32 styles asked for (played or not), which the `haptics` debug action
//   returns and clears, as iOS's debugTakePlayed; the verbose log has `[haptic] <style>`.
package io.github.purexyz.scape2004

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.os.Build
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.view.HapticFeedbackConstants
import android.view.View
import android.widget.FrameLayout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** What each style plays, for each kind of vibrator. Pure: no Android calls. */
object HapticTable {
    /** The styles the page sends (ARCHITECTURE.md §7); anything else is played as `medium`. */
    val STYLES = listOf("light", "medium", "heavy", "soft", "rigid", "selection", "success", "warning", "error")

    /** How a style is played: the vibrator's primitives, a predefined effect, or the view's haptic feedback. */
    enum class Tier(val description: String) {
        COMPOSITION("composition primitives"),
        PREDEFINED("predefined effects"),
        FEEDBACK("view haptic feedback"),
        NONE("no vibrator"),
    }

    /** One step of a composition: VibrationEffect.Composition.PRIMITIVE_*, its scale (0…1), the pause before it. */
    data class Primitive(val id: Int, val scale: Float, val delayMs: Int = 0)

    /** A style on each tier. `impact`: iOS's impact generators, the only ones `intensity` scales. */
    data class Entry(val composition: List<Primitive>, val effect: Int, val feedback: Int, val impact: Boolean)

    private const val CLICK = VibrationEffect.Composition.PRIMITIVE_CLICK
    private const val TICK = VibrationEffect.Composition.PRIMITIVE_TICK
    @SuppressLint("InlinedApi") // (only played where the vibrator says it has it: API 31+)
    private const val LOW_TICK = VibrationEffect.Composition.PRIMITIVE_LOW_TICK

    /** The tier for a vibrator: compositions need CLICK and TICK; predefined effects need all four used below. */
    fun tier(hasVibrator: Boolean, primitives: Boolean, effects: Boolean): Tier = when {
        !hasVibrator -> Tier.NONE
        primitives -> Tier.COMPOSITION
        effects -> Tier.PREDEFINED
        else -> Tier.FEEDBACK
    }

    /** The predefined effects tier B uses (all must be supported for it). */
    val EFFECTS = intArrayOf(VibrationEffect.EFFECT_CLICK, VibrationEffect.EFFECT_TICK, VibrationEffect.EFFECT_HEAVY_CLICK, VibrationEffect.EFFECT_DOUBLE_CLICK)

    /**
     * `style` on each tier. `lowTick`: the vibrator has PRIMITIVE_LOW_TICK (the lightest, for `selection`); `sdk`: the
     * API level (SEGMENT_TICK, the newer selection feedback, is API 34+).
     */
    fun entry(style: String, lowTick: Boolean, sdk: Int): Entry = when (style) {
        "selection" -> Entry(
            listOf(if (lowTick) Primitive(LOW_TICK, 1f) else Primitive(TICK, 0.5f)),
            VibrationEffect.EFFECT_TICK,
            if (sdk >= 34) HapticFeedbackConstants.SEGMENT_TICK else HapticFeedbackConstants.CLOCK_TICK,
            impact = false,
        )
        "light" -> Entry(listOf(Primitive(CLICK, 0.5f)), VibrationEffect.EFFECT_TICK, HapticFeedbackConstants.KEYBOARD_TAP, impact = true)
        "heavy" -> Entry(listOf(Primitive(CLICK, 1f)), VibrationEffect.EFFECT_HEAVY_CLICK, HapticFeedbackConstants.LONG_PRESS, impact = true)
        "soft" -> Entry(listOf(Primitive(TICK, 0.8f)), VibrationEffect.EFFECT_TICK, HapticFeedbackConstants.KEYBOARD_TAP, impact = true)
        "rigid" -> Entry(listOf(Primitive(CLICK, 0.9f)), VibrationEffect.EFFECT_CLICK, HapticFeedbackConstants.VIRTUAL_KEY, impact = true)
        "success" -> Entry(
            listOf(Primitive(CLICK, 0.6f), Primitive(CLICK, 1f, 80)),
            VibrationEffect.EFFECT_DOUBLE_CLICK, HapticFeedbackConstants.CONFIRM, impact = false,
        )
        "warning" -> Entry(
            listOf(Primitive(CLICK, 1f), Primitive(CLICK, 0.5f, 120)),
            VibrationEffect.EFFECT_DOUBLE_CLICK, HapticFeedbackConstants.REJECT, impact = false,
        )
        "error" -> Entry(
            listOf(Primitive(CLICK, 1f), Primitive(CLICK, 1f, 60), Primitive(CLICK, 1f, 60)),
            VibrationEffect.EFFECT_HEAVY_CLICK, HapticFeedbackConstants.REJECT, impact = false,
        )
        // "medium" and anything unknown: iOS plays a medium impact
        else -> Entry(listOf(Primitive(CLICK, 0.75f)), VibrationEffect.EFFECT_CLICK, HapticFeedbackConstants.CONTEXT_CLICK, impact = true)
    }

    /** The composition with `intensity` applied: impacts' scales × intensity (clamped 0…1); others as they are. */
    fun composition(entry: Entry, intensity: Double?): List<Primitive> {
        val factor = intensity?.takeIf { entry.impact && !it.isNaN() }?.coerceIn(0.0, 1.0)?.toFloat() ?: return entry.composition
        return entry.composition.map { it.copy(scale = (it.scale * factor).coerceIn(0f, 1f)) }
    }

    /** The style a message names, as iOS reads it: `medium` when it names none. */
    fun styleOf(message: JsonObject): String = message.string("style") ?: "medium"
}

/** The phone's vibrator, playing [HapticTable]'s styles. UI thread. */
class Haptics(private val context: Context) {
    private val vibrator: Vibrator? = try {
        // (VibratorManager is API 31; Android 11 has the one Vibrator service)
        if (Build.VERSION.SDK_INT >= 31) {
            context.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Vibrator::class.java)
        }
    } catch (error: Throwable) {
        Log.info("haptic", "no vibrator service ($error)")
        null
    }

    val hasVibrator: Boolean = try {
        vibrator?.hasVibrator() == true
    } catch (_: Throwable) {
        false
    }

    private val lowTick: Boolean = Build.VERSION.SDK_INT >= 31 && hasVibrator && supportsPrimitives(VibrationEffect.Composition.PRIMITIVE_LOW_TICK)

    val tier: HapticTable.Tier = HapticTable.tier(
        hasVibrator,
        primitives = hasVibrator && supportsPrimitives(VibrationEffect.Composition.PRIMITIVE_CLICK, VibrationEffect.Composition.PRIMITIVE_TICK),
        effects = hasVibrator && vibrator?.areAllEffectsSupported(*HapticTable.EFFECTS) == Vibrator.VIBRATION_EFFECT_SUPPORT_YES,
    )

    /** The game's view, for tier C (the activity's root while one is attached). */
    var view: View? = null

    private val effects = HashMap<String, VibrationEffect>()
    private val played = ArrayDeque<String>()

    private val touch: Any? = if (Build.VERSION.SDK_INT >= 33) {
        VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH)
    } else {
        AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
    }

    init {
        Log.debug("haptic") { "vibrator: ${tier.description}${if (lowTick) ", low tick" else ""}" }
    }

    fun play(style: String, intensity: Double? = null) {
        val known = if (style in HapticTable.STYLES) style else "medium"
        Log.debug("haptic") { style }
        if (BuildConfig.DEBUG) {
            played.addLast(style)
            if (played.size > MAX_PLAYED) played.removeFirst()
        }
        if (tier == HapticTable.Tier.NONE) return
        if (!touchFeedbackOn()) {
            Log.debug("haptic") { "$style not played: Touch feedback is off" }
            return
        }
        try {
            when (tier) {
                HapticTable.Tier.COMPOSITION -> {
                    val entry = HapticTable.entry(known, lowTick, Build.VERSION.SDK_INT)
                    val effect = if (intensity != null && entry.impact) compose(HapticTable.composition(entry, intensity)) else effect(known)
                    vibrate(effect)
                }
                HapticTable.Tier.PREDEFINED -> vibrate(effect(known))
                HapticTable.Tier.FEEDBACK -> view?.performHapticFeedback(HapticTable.entry(known, lowTick, Build.VERSION.SDK_INT).feedback)
                HapticTable.Tier.NONE -> Unit
            }
        } catch (error: Throwable) {
            // (a vibrator HAL that refuses a composition it said it supports must not take the page's message down)
            Log.info("haptic", "$style failed: $error")
        }
    }

    /** Builds the common styles' effects ahead of use (iOS prepares its light, medium and selection generators). */
    fun prepare() {
        if (tier == HapticTable.Tier.COMPOSITION || tier == HapticTable.Tier.PREDEFINED) {
            for (style in PREPARED) effect(style)
        }
    }

    /** The styles asked for since the last call (at most 32), oldest first; DEBUG builds (the `haptics` debug action). */
    fun debugTakePlayed(): List<String> = played.toList().also { played.clear() }

    /** For the `haptics-state` debug action. */
    fun debugState(): JsonObject = buildJsonObject {
        put("tier", JsonPrimitive(tier.name.lowercase()))
        put("hasVibrator", JsonPrimitive(hasVibrator))
        put("lowTick", JsonPrimitive(lowTick))
        put("touchFeedback", JsonPrimitive(touchFeedbackOn()))
    }

    private fun effect(style: String): VibrationEffect = effects.getOrPut(style) {
        val entry = HapticTable.entry(style, lowTick, Build.VERSION.SDK_INT)
        if (tier == HapticTable.Tier.COMPOSITION) compose(entry.composition) else VibrationEffect.createPredefined(entry.effect)
    }

    @SuppressLint("WrongConstant") // (the ids are HapticTable's PRIMITIVE_* constants)
    private fun compose(primitives: List<HapticTable.Primitive>): VibrationEffect {
        val composition = VibrationEffect.startComposition()
        for (step in primitives) composition.addPrimitive(step.id, step.scale, step.delayMs)
        return composition.compose()
    }

    private fun vibrate(effect: VibrationEffect) {
        val vibrator = vibrator ?: return
        if (Build.VERSION.SDK_INT >= 33) vibrator.vibrate(effect, touch as VibrationAttributes) else vibrator.vibrate(effect, touch as AudioAttributes)
    }

    /** Settings › Sound & vibration › Touch feedback (the system also applies it to USAGE_TOUCH; this skips the call). */
    private fun touchFeedbackOn(): Boolean = try {
        Settings.System.getInt(context.contentResolver, Settings.System.HAPTIC_FEEDBACK_ENABLED, 1) != 0
    } catch (_: Throwable) {
        true
    }

    @SuppressLint("WrongConstant") // (HapticTable's PRIMITIVE_* constants)
    private fun supportsPrimitives(vararg ids: Int): Boolean = try {
        vibrator?.areAllPrimitivesSupported(*ids) == true
    } catch (_: Throwable) {
        false
    }

    companion object {
        const val MAX_PLAYED = 32
        private val PREPARED = listOf("light", "medium", "selection")
    }
}

/**
 * Haptics in the session (docs/ANDROID.md §4 seams): the `haptic` page message (also native's own, through
 * GameSession.playHaptic once Settings › Vibration allowed it), `prepare()` on `ingame`, the activity's root for tier C,
 * and the DEBUG actions `haptics` (iOS's: the styles played, cleared) and `haptics-state`.
 */
class HapticsComponent(private val session: GameSession, context: Context) : SessionComponent {
    val haptics = Haptics(context)

    init {
        session.handle("haptic") { message -> haptics.play(HapticTable.styleOf(message), message.double("intensity")) }
        session.debugAction("haptics") { _, reply -> reply(JsonArray(haptics.debugTakePlayed().map(::JsonPrimitive))) }
        session.debugAction("haptics-state") { _, reply -> reply(haptics.debugState()) }
        // (a native haptic from a test page: GameSession.playHaptic with the Vibration setting applied, as a refused key)
        session.debugAction("native-haptic") { message, reply ->
            session.playHaptic(message.string("style") ?: "warning")
            reply(null)
        }
    }

    override fun attach(activity: GameActivity, root: FrameLayout) {
        haptics.view = root
    }

    override fun detach(activity: GameActivity) {
        haptics.view = null
    }

    override fun status(phase: String) {
        if (phase == "ingame") haptics.prepare()
    }
}
