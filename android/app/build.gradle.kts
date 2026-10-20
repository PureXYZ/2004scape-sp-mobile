// The 2004Scape app (io.github.purexyz.scape2004): the Kotlin shell around Android System WebView that runs the same web
// bundle as the iOS app (docs/ANDROID.md §1 Decisions, §2 Layout; the iOS side is ios/LostCity.xcodeproj).
//
//   ./gradlew :app:assembleDebug                 the web bundle is built first (task buildWeb), then the APK
//   ./gradlew :app:assembleRelease               R8-minified, signed with the same key
//   -PnoBuildWeb    use the bundle already in android/build/web/Game (e.g. deploy.sh built it), do not rebuild it
//   -PwebDebug      build the web bundle unminified, with sourcemaps and the worker's console (build-web.mjs --debug)
//   -PwebAutotest   inject the in-app test run (build-web.mjs --autotest; web/test/app-test.mjs)
//   -PwebPack       let build-web.mjs run the engine's incremental packer (it writes Server/engine/data/pack); without
//                   it the existing pack is used (--skip-pack)
//   -Pnode=<path>   the node binary, when the Gradle daemon's PATH has none (Android Studio started from the Dock)
//   -Plc.model=none leave the bots' chat model out (lostcity.model: Settings › Bot chat then says "Not in this build");
//                   with it, the APK carries android/build/model-assets/Model (android/scripts/prepare-model.sh)
import java.util.Properties

plugins {
    id("com.android.application")
    // the bots' chat model as a stored, 32-byte-aligned asset of the APK (docs/ANDROID.md §5.3)
    id("lostcity.model")
}

/** The repository root: android/ is the Gradle root, web/ and scripts/ are its siblings. */
val repoRoot: File = rootDir.parentFile

// android/build/web: build-web.mjs writes Game/ in it, and it is an assets folder, so the APK has assets/Game/<all>.
// (A line comment on purpose: Kotlin block comments nest, so a path glob inside a KDoc opens a second comment that
// silently swallows the code after it.)
val webAssets: File = File(rootDir, "build/web")

// The version: the repo's VERSION (major.minor.patch, the iOS app's too), versionCode major × 10000 + minor × 100 + patch
val appVersion: String = providers.fileContents(objects.fileProperty().fileValue(File(repoRoot, "VERSION"))).asText.get().trim()
val appVersionCode: Int = Regex("(\\d+)\\.(\\d{1,2})\\.(\\d{1,2})").matchEntire(appVersion)?.groupValues?.drop(1)?.map(String::toInt)
    ?.let { (major, minor, patch) -> major * 10000 + minor * 100 + patch }
    ?: throw GradleException("VERSION is '$appVersion': it must be major.minor.patch (minor and patch at most 99)")

// ------------------------------------------------------------------------------------------------------ signing
// One release key for every build, outside the repo (docs/ANDROID.md §1 Signing): ~/.android/2004scape/release.jks
// and keystore.properties (storeFile, storePassword, keyAlias, keyPassword). Debug and Release are both signed with it,
// so either build installs over the other and keeps the saves. Without it the build still works, signed with the SDK's
// debug key, and says so (task signingWarning): such an APK cannot be installed over one signed with the release key.

val keyDir = File(System.getProperty("user.home"), ".android/2004scape")

/** The release key's settings, or null with the reason in [keyProblem]. */
var keyProblem: String? = null
val releaseKey: Properties? = run {
    val file = File(keyDir, "keystore.properties")
    val text = providers.fileContents(objects.fileProperty().fileValue(file)).asText.orNull
    if (text == null) {
        keyProblem = "$file is missing"
        return@run null
    }
    val properties = Properties().apply { load(text.reader()) }
    val missing = listOf("storeFile", "storePassword", "keyAlias", "keyPassword").filter { properties.getProperty(it).isNullOrEmpty() }
    val store = properties.getProperty("storeFile")?.let { File(it).let { f -> if (f.isAbsolute) f else File(keyDir, it) } }
    when {
        missing.isNotEmpty() -> {
            keyProblem = "$file has no ${missing.joinToString()}"
            null
        }
        store == null || !store.isFile -> {
            keyProblem = "the key store $store is missing"
            null
        }
        else -> properties.apply { setProperty("storeFile", store.path) }
    }
}

android {
    namespace = "io.github.purexyz.scape2004"
    compileSdk {
        version = release(37)
    }
    ndkVersion = "30.0.16248370"

    defaultConfig {
        applicationId = "io.github.purexyz.scape2004"
        minSdk = 30
        targetSdk = 37
        versionCode = appVersionCode
        versionName = appVersion
        // the reference phone is a Pixel 10 and the emulator is arm64: one ABI keeps the APK (and llama.cpp) small
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    signingConfigs {
        if (releaseKey != null) {
            create("release") {
                storeFile = File(releaseKey.getProperty("storeFile"))
                storePassword = releaseKey.getProperty("storePassword")
                keyAlias = releaseKey.getProperty("keyAlias")
                keyPassword = releaseKey.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        val signing = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        debug {
            signingConfig = signing
        }
        release {
            signingConfig = signing
            // R8: smaller and faster, as the iOS app's whole-module optimisation. What JNI or reflection reaches by name
            // is kept by proguard-rules.pro (native methods) or marked @androidx.annotation.Keep.
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true // BuildConfig.DEBUG and the version: the launch log line and LostCityNative.debug
    }

    // fsx.c: renameat2(RENAME_EXCHANGE) for SaveStore's atomic swap with a .bak (docs/ANDROID.md §1 Saves on disk; the iOS
    // SaveStore's renamex_np(RENAME_SWAP)). CMake 4.1.2 from the SDK, NDK 30.
    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "4.1.2"
        }
    }

    testOptions {
        // JVM unit tests (app/src/test) run the pure-Kotlin parts (SaveStore with a JVM swap, AssetRouter, the lifecycle
        // coordinator, settings): android.jar's stubs answer defaults instead of throwing where one is touched in passing.
        unitTests.isReturnDefaultValues = true
    }

    androidResources {
        // The web bundle is served from AssetManager by the app's own router: stored, not deflated, so a file is read
        // without inflating it and openFd() gives its Content-Length.
        noCompress += listOf("")
    }

    sourceSets {
        getByName("main") {
            // (built by buildWeb: the dependency travels with the folder, so every task that reads the assets waits)
            assets.srcDir(if (providers.gradleProperty("noBuildWeb").isPresent) files(webAssets) else files(webAssets).builtBy("buildWeb"))
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity:1.13.0")
    implementation("androidx.webkit:webkit:1.17.1")
    // JSON for the page bridge, settings and the chat model's requests: the JsonElement API only, no compiler plugin
    // (1.9.0 is built with Kotlin 2.2, as this AGP's Kotlin). Unlike Android's org.json it also works in JVM unit tests.
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    // the bots' chat model (docs/ANDROID.md §5): llama.cpp's C++ core and JNI layer, the key store, AndroidBotChat
    implementation(project(":llm"))

    testImplementation("junit:junit:4.13.2")
}

// ------------------------------------------------------------------------------------------------------ the web bundle
// build-web.mjs builds the shared web bundle (host page, HUD, patched client, engine worker) into android/build/web/Game,
// never into the iOS app's build/Game (docs/ANDROID.md §2). It runs on every build unless -PnoBuildWeb: its inputs are
// all of web/ and the Server checkout, and it is the same 20-odd seconds the iOS deploy.sh spends.

val webDebug = providers.gradleProperty("webDebug").isPresent
val webAutotest = providers.gradleProperty("webAutotest").isPresent
val webPack = providers.gradleProperty("webPack").isPresent
val node = providers.gradleProperty("node").orElse("node")

val buildWeb = tasks.register<Exec>("buildWeb") {
    group = "build"
    description = "Builds the web bundle into android/build/web/Game (scripts/build-web.mjs)."
    workingDir = repoRoot
    commandLine(
        listOfNotNull(
            node.get(),
            "scripts/build-web.mjs",
            "--out",
            "android/build/web/Game",
            if (webPack) null else "--skip-pack",
            if (webDebug) "--debug" else null,
            if (webAutotest) "--autotest" else null
        )
    )
    outputs.dir(webAssets)
    outputs.upToDateWhen { false }
}

// With -PnoBuildWeb the bundle must already be there: an APK without it would open on a blank page.
val checkWeb = tasks.register("checkWeb") {
    val index = File(webAssets, "Game/index.html")
    val skipped = providers.gradleProperty("noBuildWeb").isPresent
    onlyIf { skipped }
    doLast {
        if (!index.isFile) {
            throw GradleException("-PnoBuildWeb, but $index is missing: build the web bundle first (node scripts/build-web.mjs --out android/build/web/Game)")
        }
    }
}

val signingWarning = tasks.register("signingWarning") {
    val problem = keyProblem
    onlyIf { problem != null }
    doLast {
        logger.warn("WARNING: signing with the SDK's debug key, not the 2004Scape release key ($problem). This APK cannot be installed over one signed with the release key (docs/ANDROID.md §1 Signing).")
    }
}

tasks.named("preBuild") {
    dependsOn(signingWarning, checkWeb)
}
// (release's lint-vital tasks read the assets folder too, and Gradle refuses a reader that does not wait for buildWeb)
tasks.configureEach {
    val readsAssets = (name.startsWith("merge") && name.endsWith("Assets")) || name.contains("lint", ignoreCase = true)
    if (readsAssets && name != "buildWeb" && !providers.gradleProperty("noBuildWeb").isPresent) {
        dependsOn(buildWeb)
    }
}
