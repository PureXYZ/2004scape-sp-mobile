// lostcity.model (src/main/kotlin/ModelPlugin.kt): the bots' chat model in an APK. AGP's API is compileOnly: the plugin runs
// with the AGP the Android build already loads (android/build.gradle.kts), never a second copy.
plugins {
    `kotlin-dsl`
}

dependencies {
    compileOnly("com.android.tools.build:gradle-api:9.4.1")
}

gradlePlugin {
    plugins {
        create("model") {
            id = "lostcity.model"
            implementationClass = "ModelPlugin"
        }
    }
}
