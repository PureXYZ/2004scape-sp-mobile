// :llm, the bots' chat model on Android (docs/ARCHITECTURE.md §7.1, docs/ANDROID.md §1 Bot chat and §4):
// the C++ core and its JNI layer (src/main/cpp, linked against llama.cpp b11297's official Android arm64 prebuilt,
// which android/scripts/fetch-llama.sh fetches), and the Android pieces around :botchat: the key store (AndroidKeyStore),
// the thermal gate (PowerManager), the model asset (read by file descriptor from the APK), the key's secure box, the bench's
// device stats, and the facade the app wires in, AndroidBotChat.
//
//   ./gradlew :llm:assembleDebug                     the library (liblcllm.so + llama.cpp's libraries)
//   ./gradlew :llm:connectedDebugAndroidTest         the instrumented tests, with the real model from the test APK
//   -Plc.model=none                                  leave the model out of the test APK (lostcity.model)
plugins {
    id("com.android.library")
    // the model as a stored, 32-byte-aligned asset of the test APK (and of the app's APK: :app applies it too)
    id("lostcity.model")
}

/** llama.cpp's prebuilt libraries, unpacked by android/scripts/fetch-llama.sh. */
val llama = File(rootDir, "build/vendor/llama-b11297")

android {
    namespace = "io.github.purexyz.scape2004.llm"
    compileSdk {
        version = release(37)
    }
    ndkVersion = "30.0.16248370"

    defaultConfig {
        minSdk = 30
        ndk { abiFilters += listOf("arm64-v8a") }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // (what JNI reaches by name: the native methods, the out objects' fields, the log callback)
        consumerProguardFiles("consumer-rules.pro")
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "4.1.2"
        }
    }

    sourceSets {
        getByName("main") {
            // ggml's CPU backend, one library per CPU generation: dlopen'ed by name at run time (lc_backend_android.cpp),
            // so AGP packages them as plain jniLibs (libllama, libggml and libggml-base come with CMake's IMPORTED targets)
            jniLibs.directories.add(File(llama, "variants").path)
        }
        getByName("androidTest") {
            // (web/test/lm/bench-prompts.json: the instrumented tests ask the model what the harness and the bench ask it)
            assets.directories.add(File(rootDir, "../web/test/lm").path)
        }
    }

    packaging {
        // stored and page-aligned in the APK, never extracted: the CPU variants are found inside base.apk by name
        jniLibs { useLegacyPackaging = false }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        // (a test's timings are the point: the instrumented tests run on the emulator's or phone's own speed)
        targetSdk = 37
    }
}

dependencies {
    api(project(":botchat"))
    implementation("androidx.annotation:annotation:1.9.1")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:core:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
}

// llama.cpp's prebuilts must be there before CMake or the jniLibs merge look for them (quick when they are).
val stamp = File(llama, ".lostcity-b11297")
val fetchLlama = tasks.register<Exec>("fetchLlama") {
    group = "build"
    description = "Fetches llama.cpp b11297's prebuilt libraries (android/scripts/fetch-llama.sh)."
    commandLine(File(rootDir, "scripts/fetch-llama.sh").path)
    outputs.file(stamp)
}
tasks.named("preBuild") {
    dependsOn(fetchLlama)
}
