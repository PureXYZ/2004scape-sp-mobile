// The few things the bots' chat model needs from its platform, as plain interfaces, so the same classes run in the app
// (android/llm gives the Android ones: the main looper, PowerManager's thermal status, the app's log) and on the Mac JVM
// (the harness and the unit tests give theirs). The iOS app gets these from Foundation: DispatchQueue.main,
// ProcessInfo.thermalState, ios/LostCity/Log.swift (docs/ARCHITECTURE.md §7.1).
package io.github.purexyz.scape2004.botchat

import kotlin.math.ceil
import kotlin.math.floor

/** Runs a block on the main thread, later (iOS: `DispatchQueue.main.async`). BotChatModel lives on that thread. */
fun interface MainPoster {
    fun post(block: () -> Unit)
}

/** iOS's thermal states, which the page's bench gate and BotChatModel's rule are written in (`serious` and up: too hot). */
enum class ThermalLevel(val iosName: String) {
    NOMINAL("nominal"),
    FAIR("fair"),
    SERIOUS("serious"),
    CRITICAL("critical"),
}

/** How hot the phone is, read at each request (iOS: `ProcessInfo.processInfo.thermalState`). */
interface ThermalProvider {
    fun level(): ThermalLevel

    /** For the log line of a refused request: iOS says "thermal state serious", Android "thermal status severe". */
    fun describe(): String = "thermal state ${level().iosName}"

    companion object {
        /** Always nominal (the Mac, the tests' default). */
        val NOMINAL: ThermalProvider = fixed(ThermalLevel.NOMINAL)

        fun fixed(level: ThermalLevel): ThermalProvider = object : ThermalProvider {
            override fun level() = level
        }
    }
}

/** The app's log (ios/LostCity/Log.swift's `Log.info` and `Log.debug`; debug lines only when verbose). */
interface LogSink {
    fun info(tag: String, message: String)

    fun debug(tag: String, message: () -> String)
}

/**
 * Swift's `trimmingCharacters(in: .whitespacesAndNewlines)`: Unicode's space separators (Zs), the line and paragraph
 * separators (Zl, Zp), U+0009-U+000D and U+0085. Kotlin's own `trim()` is not that set: it also strips U+001C-U+001F (Java
 * counts them as whitespace) and keeps U+0085, and the prompt the model sees must be the iPhone's byte for byte.
 */
fun String.swiftTrim(): String = trim { it.isSwiftWhitespaceOrNewline() }

/** Swift's `trimmingCharacters(in: .newlines)`: U+000A-U+000D, U+0085, U+2028, U+2029 (llama.cpp's log lines). */
fun String.swiftTrimNewlines(): String = trim { it in '\u000A'..'\u000D' || it == '\u0085' || it == ' ' || it == ' ' }

private fun Char.isSwiftWhitespaceOrNewline(): Boolean = when {
    this in '\u0009'..'\u000D' || this == '\u0085' -> true
    else -> when (Character.getType(this).toByte()) {
        Character.SPACE_SEPARATOR, Character.LINE_SEPARATOR, Character.PARAGRAPH_SEPARATOR -> true
        else -> false
    }
}

/** Swift's `.rounded()` (to nearest, halves away from zero), unlike Kotlin's `round` (halves to even). */
internal fun roundAway(value: Double): Double = if (value >= 0) floor(value + 0.5) else ceil(value - 0.5)

/** To 0.1, as the iOS dictionaries round their milliseconds: `(value * 10).rounded() / 10`. */
internal fun round1(value: Double): Double = roundAway(value * 10) / 10

/** Milliseconds since a `System.nanoTime()` (iOS: `DispatchTime.now().uptimeNanoseconds`; both monotonic). */
internal fun msSince(startNanos: Long): Double = (System.nanoTime() - startNanos) / 1_000_000.0

/**
 * How a value from a page message reads where Swift casts it, so a message the page sends oddly is read as the iPhone reads
 * it. The page's messages are JSON, so the values are String, Boolean, Number (Long or Double), List, Map or null
 * (JsonBridge.kt), and Swift's JSONSerialization gives NSString, NSNumber (booleans too), NSArray, NSDictionary, NSNull.
 */
internal object SwiftCast {
    /** `(x as? NSNumber)?.intValue`: any number, truncated; a boolean is an NSNumber too (1 or 0). */
    fun intValue(value: Any?): Int? = when (value) {
        is Boolean -> if (value) 1 else 0
        is Double -> value.toInt()
        is Float -> value.toInt()
        is Number -> value.toLong().toInt()
        else -> null
    }

    /** `x as? Bool`: a boolean, or a number that is exactly 0 or 1 (Swift bridges those NSNumbers to Bool). */
    fun bool(value: Any?): Boolean? = when (value) {
        is Boolean -> value
        is Number -> when (value.toDouble()) {
            0.0 -> false
            1.0 -> true
            else -> null
        }
        else -> null
    }

    /** `x as? Int` for a value read from model.json: an integer, or a number with no fraction. */
    fun exactLong(value: Any?): Long? = when (value) {
        is Long -> value
        is Int -> value.toLong()
        is Double -> if (value == floor(value) && !value.isInfinite()) value.toLong() else null
        else -> null
    }

    fun string(value: Any?): String? = value as? String

    @Suppress("UNCHECKED_CAST")
    fun map(value: Any?): Map<String, Any?>? = value as? Map<String, Any?>
}
