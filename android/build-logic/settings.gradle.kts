// The Android build's own plugins (an included build of android/settings.gradle.kts): lostcity.model, which puts the bots'
// chat model in an APK (docs/ANDROID.md §4).
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "build-logic"
