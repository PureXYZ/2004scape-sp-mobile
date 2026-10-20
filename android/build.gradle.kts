// Root build file: the plugin versions only. AGP 9.4.1 compiles the Android modules' Kotlin itself (its built-in Kotlin,
// 2.2.10, docs/ANDROID.md §1 SDKs); :botchat is a plain JVM library, so it takes the Kotlin JVM plugin of the same version.
plugins {
    id("com.android.application") version "9.4.1" apply false
    id("com.android.library") version "9.4.1" apply false
    id("org.jetbrains.kotlin.jvm") version "2.2.10" apply false
}
