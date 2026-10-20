// :botchat, the bots' chat model in plain Kotlin/JVM (docs/ARCHITECTURE.md §7.1, docs/ANDROID.md §2):
// BotChatModel, LocalModel, ModelInfo, OnlineModel, ModelKeyStore and the JNI binding LlmJni, ports of the iOS app's
// LostCity/{BotChatModel,LocalModel,OnlineModel,ModelKeyStore}.swift. No android.* import anywhere, so the same classes run
// in the app (through :llm) and on the Mac JVM:
//
//   ./gradlew :botchat:test                        unit tests, with a fake native layer (no model, a few seconds)
//   ./gradlew :botchat:lmHarness --args="<mock url> <model dir | none> <bench-prompts.json> [lib dir]"
//                                                  the Mac harness (android/test/native/lm-harness.mjs runs it with the
//                                                  real GGUF, liblcllm.dylib and the mock of the Messages API)
plugins {
    id("org.jetbrains.kotlin.jvm")
    `java-library`
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

// The Mac harness (src/harness: HarnessMain.kt, the Kotlin port of web/test/native/lm-harness/main.swift). A source set of
// its own, so neither the app nor the unit tests carry it.
val harness: SourceSet by sourceSets.creating {
    compileClasspath += sourceSets.main.get().output
    runtimeClasspath += sourceSets.main.get().output
}
configurations[harness.implementationConfigurationName].extendsFrom(configurations.implementation.get())
configurations[harness.runtimeOnlyConfigurationName].extendsFrom(configurations.runtimeOnly.get())

dependencies {
    // (the page's messages and the API's replies; the JsonElement API only, as the app: docs/ANDROID.md §1)
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    testImplementation("junit:junit:4.13.2")
}

tasks.register<JavaExec>("lmHarness") {
    group = "verification"
    description = "The bots' chat model on the Mac JVM against the real model and the Messages API mock (android/test/native/lm-harness.mjs)."
    classpath = harness.runtimeClasspath
    mainClass.set("io.github.purexyz.scape2004.botchat.harness.HarnessMainKt")
    val libDir = providers.gradleProperty("lcllmDir").orElse(rootProject.layout.buildDirectory.dir("tmp/lm-harness/cmake").map { it.asFile.path })
    jvmArgs(
        // (liblcllm.dylib, built by lm-harness.mjs with CMake -DLC_HOST=ON)
        libDir.map { "-Djava.library.path=$it" }.get(),
        // (JDK 24+ warns about System.loadLibrary from the class path otherwise)
        "--enable-native-access=ALL-UNNAMED",
        // (the A1 check passes a RandomAccessFile's descriptor to native code, as Android passes an asset's)
        "--add-opens=java.base/java.io=ALL-UNNAMED",
        "-Xss8m",
    )
    standardOutput = System.out
    errorOutput = System.err
}
