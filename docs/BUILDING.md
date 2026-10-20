# Building 2004Scape

Everything a developer needs, from a fresh clone to an app on a phone, and the tests. Both apps bundle the same web
build (`build/Game`: the engine worker, the patched client, the host page and the HUD), so the first steps are shared.
Releases for other people: [RELEASING.md](RELEASING.md). How the pieces fit: [ARCHITECTURE.md](ARCHITECTURE.md).

All commands run from the repository root unless they say otherwise.

## Requirements

| For | You need |
|---|---|
| Everything | **git** and **Node.js 24** or later (`npm` comes with it) |
| The iPhone app | **macOS** with **Xcode 27** (the iOS 27 SDK). The app's deployment target is iOS 18.4 |
| The Android app | **JDK 17** or later (Android Studio's bundled JBR works, and `android/scripts/deploy.sh` uses it by default); the **Android SDK** with platform 37, its platform tools and build tools, **NDK 30.0.16248370** and **CMake 4.1.2** (all from Android Studio's SDK Manager). Gradle 9.6.0 comes through the wrapper (`android/gradlew`); the build uses AGP 9.4.1 and Kotlin 2.2.10 |
| The chat model (optional) | about 600 MB of disk for the download, which is cached outside the clone |

**Other systems.** The web build (`scripts/build-web.mjs`) and `scripts/fetch-upstream.mjs` are plain Node and git.
The iPhone app needs a Mac. The Android build has been done on macOS only: `android/scripts/deploy.sh` defaults
`ANDROID_HOME` to `~/Library/Android/sdk` and `JAVA_HOME` to Android Studio's JBR on macOS (set both elsewhere), and
`android/scripts/prepare-model.sh` is written for macOS and Linux. Most desktop tests drive Google Chrome at its macOS
path, and some engine tests use the macOS JavaScriptCore shell. Windows is untested.

## 1. The shared steps

```sh
node scripts/fetch-upstream.mjs     # the pinned Lost City sources (Engine-TS, Content, Client-TS) into upstream/
(cd web && npm ci)                  # the build tools: esbuild, fflate, node-forge
node scripts/build-web.mjs          # build/Game (the first build packs the game data: about 10 s more)
```

`fetch-upstream.mjs` makes shallow clones of the three repositories at the commits [upstream.json](../upstream.json)
pins, in the git-ignored `upstream/`. `--check` reports which folder the build uses and whether it is at the pinned
commits, `--update` moves a clean checkout to the pinned commit after `upstream.json` changed, and `--dir <folder>`
clones somewhere else. The build refuses sources that are not at the pinned commits, unless you pass
`--allow-upstream-mismatch`.

**Editors.** The engine's TypeScript configs (`web/engine/tsconfig.json`, `web/engine/bots/tsconfig.json` and
`web/engine/test/fixtures/stub-bots/tsconfig.json`) find the engine's sources and packages in a Lost City Server
checkout beside the clone, `../Server`, because a tsconfig cannot follow `LC_UPSTREAM_DIR` or the resolver. The build
and the tests do not need that (they type-check a copy whose paths point at the folder in use: `derivedTsconfig` in
`scripts/lib/upstream.mjs`), but an editor does: with the sources in `upstream/`, it reports the engine's imports
(`#/...`, `kleur`, `fflate`) as missing. To have them resolve, link `upstream/` there, from the clone:
`ln -s "$PWD/upstream" ../Server` (after a first `node scripts/build-web.mjs`, which installs the engine's packages).

`npm ci` reports two advisories, neither of which reaches the apps. node-forge (GHSA-86w9-cpqp-85rv, RSA signature
verification) runs only at build time, in `web/client/build.mjs`, to read the engine's RSA key; it never verifies a
signature, and the engine bundle uses its own `forge-lite.ts` instead. The esbuild one concerns its development server
on Windows, which the build never starts.

### build-web options

| Option | What |
|---|---|
| (none) | Release build: minified |
| `--debug` | Unminified, with sourcemaps and the worker's console kept (for Safari Web Inspector or chrome://inspect) |
| `--skip-pack` | Do not run the engine's packer, unless its output is missing (it writes `upstream/engine/data/pack`) |
| `--autotest` | Inject `web/test/autotest.js`: the self-playing in-app test (`web/test/app-test.mjs` does this itself) |
| `--out <dir>` | Build somewhere other than `build/Game` (the Android build uses `android/build/web/Game`) |
| `--no-bots` | Without the bots: `engine.js` only |
| `--rebuild-bot-scripts` | Recompile the bots' content-script overlay (otherwise cached) |
| `--require-bots` | Fail when the bots' overlay does not compile (otherwise the build goes on without the bots, with a warning) |
| `--bots-lib <dir>` | Another bot library than `web/engine/bots/src` |
| `--allow-upstream-mismatch` | Build although a checkout is not at its pinned commit |

The build also writes `build/Version.xcconfig`, the iPhone app's version from [VERSION](../VERSION).

### Environment variables

| Variable | What |
|---|---|
| `LC_UPSTREAM_DIR` | A folder holding `engine/`, `content/` and `webclient/` to build from, instead of `upstream/` (`LC_SERVER_DIR` is its older name). Without either, the resolver (`scripts/lib/upstream.mjs`) uses `upstream/`, then a Lost City Server checkout beside the clone (`../Server`) |
| `LC_CACHE_DIR` | The download and model cache shared by both apps' scripts (`scripts/lib/cache.sh`). Default: `~/Library/Caches/2004scape` on macOS, `${XDG_CACHE_HOME:-~/.cache}/2004scape` elsewhere. It holds `downloads/` (llama.cpp's archives, each checked by sha256) and `models/` (the trained chat model) |
| `ANDROID_HOME`, `JAVA_HOME` | The Android SDK and the JDK for Gradle (see above) |
| `LC_BOTS_SRC` | Bot tests only: run them against another copy of the bot library (an A/B run) |

## 2. The iPhone app

The Xcode project is `ios/LostCity.xcodeproj` (the target and scheme are called `LostCity`, the code name; the app is
called 2004Scape on the home screen). It references `build/Game`, `build/Model` and `build/Vendor/llama.xcframework`,
so build the web bundle and fetch llama.cpp before building in Xcode.

### Signing

The project has no team in it. For a device build, copy `ios/Config/Local.xcconfig.example` to
`ios/Config/Local.xcconfig` (git-ignored) and set:

- `DEVELOPMENT_TEAM`: your team id (Xcode › Settings › Accounts; a free Personal Team works, and its apps expire after
  7 days).
- `BUNDLE_ID_SUFFIX`: a bundle id belongs to the first team that registers it, so add a suffix of your own, for example
  `.yourname` for `io.github.purexyz.scape2004.yourname`.

Or pass `TEAM=<team id>` to `deploy.sh` (below); without `BUNDLE_ID` it then uses
`io.github.purexyz.scape2004.<team id>`. The simulator and unsigned builds need no team.

### deploy.sh: build, install and launch

```sh
ios/scripts/deploy.sh               # the connected iPhone (paired with Xcode, unlocked, Developer Mode on)
ios/scripts/deploy.sh --sim         # the iOS Simulator
```

`ios/scripts/deploy.sh` builds the web bundle, fetches llama.cpp's framework (`ios/scripts/fetch-llama.sh`), builds the
app with `xcodebuild` into `build/DerivedData`, installs it and launches it. Its options are environment variables:

| Variable | What |
|---|---|
| `LOGS=1` | Stream the app's log here, including the web console; Ctrl-C then quits the app |
| `CONFIG=Release` | An optimized build (the default is Debug). Release strips the binary |
| `WEB_DEBUG=1` | The web build with `--debug` |
| `NO_BUILD_WEB=1` | Reuse `build/Game` |
| `DEVICE=<udid>` | A specific iPhone, when several are connected |
| `SIM_NAME=<name>` | With `--sim`: the simulator to use (default `iPhone 17`) |
| `TEAM=<team id>`, `BUNDLE_ID=<id>` | Override the signing settings |

The first install from an Apple Account will not launch until you trust it on the iPhone: Settings › General › VPN & Device
Management › your Apple Development profile › Trust (needs internet). The script waits for that, and for the phone to
be unlocked. Run it again within 7 days to refresh a free-team build; reinstalling keeps the saves.

On a device, Safari › Develop › (your iPhone) › 2004Scape opens Web Inspector for the page and the engine worker
(turn on Settings › Apps › Safari › Advanced › Web Inspector on the phone).

### Building without deploy.sh

```sh
node scripts/build-web.mjs
ios/scripts/fetch-llama.sh
xcodebuild -project ios/LostCity.xcodeproj -scheme LostCity -configuration Release \
    -destination generic/platform=iOS -derivedDataPath build/DerivedData CODE_SIGNING_ALLOWED=NO build
```

That is an unsigned device build: the app is `build/DerivedData/Build/Products/Release-iphoneos/LostCity.app` (without
`-derivedDataPath`, Xcode puts it in its own `~/Library/Developer/Xcode/DerivedData/LostCity-<hash>/`). A sideloading
tool takes an IPA, which is that app zipped in a `Payload` folder:

```sh
rm -rf build/ipa && mkdir -p build/ipa/Payload
ditto build/DerivedData/Build/Products/Release-iphoneos/LostCity.app build/ipa/Payload/LostCity.app
(cd build/ipa && zip -qry ../LostCity.ipa Payload)   # build/LostCity.ipa
```

The release IPAs are made this way ([RELEASING.md](RELEASING.md)); `scripts/release.sh --skip-android --allow-dirty`
makes both iPhone builds, with and without the chat model, in `dist/<version>/`. For the simulator use
`-destination 'generic/platform=iOS Simulator'`. Opening `ios/LostCity.xcodeproj` in Xcode works the same way once
`build/` is filled.

### The chat model

Without a model the app builds and runs, and Settings › Bot chat says "Not in this build". To bundle one:

```sh
ios/scripts/prepare-model.sh --download   # the trained model: downloaded into the cache once, checked, then bundled
ios/scripts/prepare-model.sh              # the same from the cache, without downloading
ios/scripts/prepare-model.sh <file.gguf>  # a model of your own (its name and template from a model.json beside it)
ios/scripts/prepare-model.sh --spike      # the untrained Qwen3.5 0.8B Q4_K_M (pinned), for comparisons
ios/scripts/prepare-model.sh --none       # no model
```

The trained model is pinned in [models/bots-2004.json](../models/bots-2004.json) (its size, sha256 and the release URL
it is downloaded from). The script writes `build/Model/`, which the app bundles as `Model/`. On the simulator the model
never runs (llama.cpp's framework has no simulator slice); the app reports it as unavailable there.

## 3. The Android app

The Gradle project is `android/` (modules `:app`, `:botchat`, `:llm` and the included build `build-logic`). Design
notes: [ANDROID.md](ANDROID.md); using the app on a phone: [android/README.md](../android/README.md).

```sh
sh android/scripts/prepare-model.sh --download   # optional: the chat model, as for iOS (same options, same cache)
android/scripts/deploy.sh                        # build, install on the connected phone over adb, launch
android/scripts/deploy.sh --emu                  # the emulator: the running one, or it starts the AVD
```

`android/scripts/deploy.sh` options (environment variables): `LOGS=1` (stream the app's log, including the page's
console; Ctrl-C then quits the app), `CONFIG=Release` (R8-minified, not debuggable), `DEVICE=<serial>` (one of `adb
devices`), `WEB_DEBUG=1`, `NO_BUILD_WEB=1` (reuse `android/build/web/Game`), `PACK=1` (let the web build run the
engine's packer, after content changes), `VERBOSE=1` (a debug build's verbose native log, kept until `VERBOSE=0`) and
`AVD=<name>` (the emulator for `--emu`, default `Medium_Phone_API_37.0`). A phone needs Developer options › USB
debugging (or Wireless debugging) and this computer allowed.

Gradle alone also builds a complete APK, building the web bundle and fetching llama.cpp itself:

```sh
cd android
ANDROID_HOME=<sdk> ./gradlew :app:assembleDebug      # app/build/outputs/apk/debug/app-debug.apk
ANDROID_HOME=<sdk> ./gradlew :app:assembleRelease    # app/build/outputs/apk/release/app-release.apk (R8-minified)
```

| Property | What |
|---|---|
| `-Plc.model=none` | Leave the chat model out on purpose (an APK of about 54 MB; about 580 MB with the model). Without it, and without a prepared model, the build warns and the APK has none |
| `-PnoBuildWeb` | Use the bundle already in `android/build/web/Game` |
| `-PwebDebug`, `-PwebAutotest`, `-PwebPack` | The web build with `--debug`, `--autotest`, or with the packer allowed to run (otherwise `--skip-pack`) |
| `-Pnode=<path>` | The `node` binary, when the Gradle daemon has none on its PATH (Android Studio started from the Dock) |

The version comes from [VERSION](../VERSION): versionName as written, versionCode major × 10000 + minor × 100 + patch.

### Signing

Both build types are signed with one key outside the repository, `~/.android/2004scape/release.jks`, described by
`~/.android/2004scape/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`). **Without that
folder the build signs with the Android SDK's debug key** and prints a warning (task `signingWarning`). That is fine for
your own builds, but an APK signed with one key cannot be installed over the same app signed with another
(`INSTALL_FAILED_UPDATE_INCOMPATIBLE`): uninstall first, which deletes the app's data unless you keep it.

To sign your own builds with a key of your own, make one and point `keystore.properties` at it:

```sh
mkdir -p ~/.android/2004scape && chmod 700 ~/.android/2004scape
keytool -genkeypair -keystore ~/.android/2004scape/release.jks -storetype PKCS12 -alias 2004scape \
    -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=<your name>"
```

The project's own release key, and how to look after a key, are in [RELEASING.md](RELEASING.md).

## 4. Tests

### Desktop (no phone)

```sh
node scripts/build-web.mjs --debug
node web/test/serve.mjs                   # http://127.0.0.1:47500/: the game in a desktop browser, the app's routes
node web/test/e2e.mjs                     # headless Chrome as an iPhone 13 mini: boot, login, save, pause/resume, reconnect, re-login, Saved data
node web/test/e2e.mjs --bots 25           # the same with 25 bots (--bots 0: explicitly off)
node web/test/e2e.mjs --lm-stub           # the chat model's relay (engine, page, a stub native) and Settings › Bot chat
node web/test/e2e.mjs --platform android  # the page as the Android app runs it
node web/test/hud.mjs                     # the mobile HUD with real touches, every screen size (--platform android too)
node web/test/gallery/capture.mjs         # once: real game pixels for the gallery
node web/test/gallery/gallery.mjs         # the HUD in every state at every phone size, in seconds (--platform android too)
node web/test/upstream.test.mjs           # the upstream pins, the resolver and fetch-upstream
node web/client/test/typecheck.mjs        # the patched client type-checks like upstream
node web/client/test/run.mjs --quick      # the client's touch, keyboard and login checks
node web/engine/test/all.mjs              # the engine worker: vm sandbox, JavaScriptCore, Chrome, the bots' glue (about 10 min)
node web/engine/bots/test/all.mjs         # the bot library (most of an hour; --full adds the long simulations)
node web/test/native/lm-harness.mjs       # the iOS app's chat model code compiled for the Mac, against a mock of Claude's API
```

Screenshots and logs go to `build/tmp/`. The bots' own test tools (the world simulator, the humanlike report) are
described in [BOTS.md](BOTS.md#7-tests).

### In the iPhone app

```sh
node web/test/app-test.mjs                         # the simulator "LostCity Test (iPhone 13 mini)", created if missing
node web/test/app-test.mjs --sim "iPad mini (A17 Pro)"
node web/test/app-test.mjs --device                # the connected iPhone
node web/test/app-test.mjs --device --bots 25      # with 25 bots, measured
node web/test/app-test.mjs --device --lm-bench     # the on-device model under load with 500 bots (about 45 min; --lm-think: with the note)
node web/test/native/drive.mjs                     # the native layer on the simulator, with a test page (ios/LostCity/README.md)
```

The in-app test builds a self-playing variant and plays through boot, the native keyboard's login, a walk, saves,
backgrounding, a dropped connection, a reload and a re-login, with screenshots in `build/tmp/app-test/`. After a device
run, put the normal app back with `ios/scripts/deploy.sh`.

### In the Android app

```sh
(cd android && ./gradlew :app:testDebugUnitTest :botchat:test)   # the JVM unit tests
(cd android && ./gradlew :app:lintDebug)
node android/test/all.mjs --serial emulator-5554                 # every device test from one build (--quick: build, JVM, smoke)
```

The individual device tests (`smoke.mjs`, `keyboard.mjs`, `shell.mjs`, `lm.mjs`, `crisp.mjs`, `drive.mjs`,
`app-test.mjs`) and the instrumented tests are listed in [ANDROID.md](ANDROID.md#7-tests).

## 5. Upstream sources and the client patches

This project is not a fork: it builds unmodified Lost City sources at the commits [upstream.json](../upstream.json)
pins (Engine-TS, Content and Client-TS, all on their `274` branches). Its own changes to them are:

- `web/client/patches/*.patch`: 25 patches to Client-TS, made against the commit in `web/client/patches/BASE`, plus
  whole-module overrides in `web/client/overrides/` ([web/client/README.md](../web/client/README.md)).
- `web/engine/`: shims that let Engine-TS run in a browser worker; no engine source is patched
  ([web/engine/README.md](../web/engine/README.md)).
- `web/engine/bots/content/*.patch`: three script patches for the bots, against the Content commit in
  `web/engine/bots/content/BASE` ([BOTS.md](BOTS.md#8-maintenance)).

`web/test/upstream.test.mjs` checks that both `BASE` files name the commits `upstream.json` pins.

### The client patch workflow

```sh
node web/client/patches.mjs check                 # do the patches still apply? (what the build does)
node web/client/patches.mjs edit                  # build/tmp/client/patch-work: upstream@BASE plus one commit per patch
node web/client/patches.mjs edit --onto-current   # the same, rebased onto the current webclient checkout (3-way)
node web/client/patches.mjs export                # write patches/*.patch back (header = commit message) and patches/BASE
```

To change a patch, run `edit`, change the files in `build/tmp/client/patch-work`, amend or fix up that patch's commit,
then `export`. A new patch is a new commit. Then run `node web/client/test/typecheck.mjs` and
`node web/client/test/run.mjs --quick`.

### Moving to newer upstream commits

1. Put the new commits in `upstream.json` and run `node scripts/fetch-upstream.mjs --update`.
2. Rebase the client patches: `node web/client/patches.mjs edit --onto-current`, resolve any conflicts in
   `build/tmp/client/patch-work` (`git add`, `git rebase --continue`, then `git tag -f upstream upstream-new`), and
   `node web/client/patches.mjs export`, which updates `web/client/patches/BASE`.
3. Remake the bots' script patches if they no longer apply, and put the Content commit in
   `web/engine/bots/content/BASE` ([BOTS.md](BOTS.md#8-maintenance)).
4. Build with `node scripts/build-web.mjs --rebuild-bot-scripts --require-bots` and run the tests above
   (`web/test/upstream.test.mjs` first).

The bots' upstream, 2004sp-progressive, is vendored rather than pinned: `web/engine/bots/UPSTREAM` names its commit, and
[web/engine/bots/README.md](../web/engine/bots/README.md#re-vendoring) says how to take in newer upstream code.
