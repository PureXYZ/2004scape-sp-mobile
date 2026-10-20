// The Android app's Gradle build (docs/ANDROID.md §2). android/ is the Gradle root; the web bundle it packs is built
// from ../web by ../scripts/build-web.mjs (app/build.gradle.kts, task buildWeb).
pluginManagement {
    // lostcity.model: the bots' chat model in an APK (the GGUF as a stored, 32-byte-aligned asset; docs/ANDROID.md §4)
    includeBuild("build-logic")
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "2004Scape"
include(":app")
// The bots' chat model (docs/ANDROID.md §2 and §4): :botchat is pure Kotlin/JVM (BotChatModel,
// LocalModel, OnlineModel; it runs on the Mac JVM too, android/test/native/lm-harness.mjs), :llm the Android library around
// it (llama.cpp's C++ core and JNI layer, the key store, thermal status, the model asset, the facade AndroidBotChat).
include(":botchat", ":llm")
