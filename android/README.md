# 2004Scape for Android

The Android twin of the iPhone app ([../README.md](../README.md)): [Lost City](https://lostcity.rs) (2004scape),
called **2004Scape** in the launcher, running **entirely on the phone**. The Engine-TS game server runs as a Web Worker
and the Client-TS web client renders in a full-screen Android System WebView, wrapped in a Kotlin app with the same
mobile HUD in the 2004 look, a native keyboard bridge and on-device saves. It is the same web bundle as the iPhone's
(`web/` is shared), so the game, the HUD, the settings and the bots behave the same; the Kotlin shell does what the
Swift shell does on iOS. Design and contracts: [docs/ANDROID.md](../docs/ANDROID.md) (on top of
[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)).

Single-player and offline. Tap **New User** or **Existing User** and type any name (no password needed); a new name
creates a new character on Tutorial Island, and next time **Continue as <name>** brings it back with one tap. Your
characters are saved on the phone (Files › 2004Scape › players). Settings › World › **Bots** fills the world with other
players (500 online by default), as on the iPhone.

## Requirements

- To play: a phone with **Android 11 (API 30) or later**, an **arm64** CPU (every phone of the last years; there are
  no 32-bit or x86 builds), and **Android System WebView 122 or later** (the engine's scripts use JavaScript iterator
  helpers). Without them the app says so: "Android System WebView is too old … Update it from the Play Store."
  Installing a release APK: [../docs/INSTALL-ANDROID.md](../docs/INSTALL-ANDROID.md).
- To build: the requirements and the shared steps in [docs/BUILDING.md](../docs/BUILDING.md) (Node.js, the pinned Lost
  City sources, the Android SDK with NDK 30.0.16248370 and CMake 4.1.2, a JDK).
- Developed and tested on the arm64 emulator (AVD `Medium_Phone_API_37.0`, Android 17, WebView 145), with the screen
  tuned for a Pixel 10-class phone ([screen notes](#screen-notes)).

## Build and run

Once, in a fresh checkout:

```sh
node scripts/fetch-upstream.mjs                      # the pinned Lost City sources into upstream/
(cd web && npm ci)                                   # esbuild, fflate, node-forge
sh android/scripts/prepare-model.sh --download       # the bots' chat model (optional; without --download: from the cache)
```

Then:

```sh
android/scripts/deploy.sh          # builds the web bundle and the app, installs it on the connected phone and launches it
android/scripts/deploy.sh --emu    # the emulator instead: the running one, or it starts the AVD
```

`deploy.sh` options: `LOGS=1` (stream the app's log here, including the page's console; Ctrl-C then quits the app),
`CONFIG=Release` (R8-minified and not debuggable), `DEVICE=<serial>` (one of `adb devices`, when several are connected),
`WEB_DEBUG=1` (unminified web code with sourcemaps), `NO_BUILD_WEB=1` (reuse `android/build/web/Game`), `PACK=1` (let the
web build run the engine's packer after content changes; it writes the upstream engine's `data/pack`), `VERBOSE=1` (the verbose
native log, kept until `VERBOSE=0`; debug builds only), `AVD=<name>` (another emulator for `--emu`).

There is no 7-day expiry and no trust step on Android, and installing never deletes the saves (`adb install -r`).
Gradle alone works too (from `android/`): `./gradlew :app:assembleDebug` or `:app:assembleRelease` gives a complete APK
in `app/build/outputs/apk/`; it builds the web bundle itself and fetches llama.cpp's prebuilt libraries
(`android/scripts/fetch-llama.sh`, release b11297, checked by sha256, cached in `~/Library/Caches/2004scape/downloads/`
or `LC_CACHE_DIR`). Without
`prepare-model.sh` the build warns and the app has no on-device chat model (Settings › Bot chat says "Not in this
build"); `-Plc.model=none` leaves it out on purpose (an APK of about 55 MB instead of 580 MB).

### On a phone over USB

1. On the phone: Settings › About phone › tap **Build number** seven times; then Settings › System › Developer options ›
   **USB debugging** on.
2. Connect it with a USB cable and accept **Allow USB debugging?** (tick "Always allow from this computer").
   `$ANDROID_HOME/platform-tools/adb devices` lists it as `device` (`unauthorized` until you accept).
3. `android/scripts/deploy.sh`. The phone can be locked while it installs; the launch waits until you unlock it.

Some phones (Xiaomi, Oppo, Vivo) also need Developer options › **Install via USB** and a tap on their own prompt.

### On a phone over Wi-Fi

On the same network: Developer options › **Wireless debugging** on › **Pair device with pairing code**, then on the
Mac `adb pair <ip>:<pairing port>` with the six-digit code, and `adb connect <ip>:<port>` (the port shown on the
Wireless debugging screen, not the pairing one). Then `DEVICE=<ip>:<port> android/scripts/deploy.sh`. Pairing is kept;
after a reboot of the phone only `adb connect` is needed again.

### The emulator

`android/scripts/deploy.sh --emu` starts the AVD named by `AVD` (default `Medium_Phone_API_37.0`; create one in Android
Studio's Device Manager: a phone, API 37, arm64) when none is running. To start it yourself:
`$ANDROID_HOME/emulator/emulator -avd Medium_Phone_API_37.0`. The emulator plays the game well, the bots' on-device
chat model included.

### Release

`CONFIG=Release android/scripts/deploy.sh` builds the R8-minified, non-debuggable app. Debug and Release are both
signed with the same key, so either installs over the other and keeps the saves; Debug adds chrome://inspect and the
test hooks.

## The signing key

Both builds are signed with one key outside the repo, in `~/.android/2004scape/` (`release.jks` and
`keystore.properties` with its passwords). Without that folder the build signs with Android Studio's debug key and
prints a warning (`signingWarning`); that build cannot be installed over one signed with the release key (Android
installs an update only when it carries the same key): the install fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, and
the only way forward is to uninstall the app, which deletes its saves unless you keep them (below). The project's
release key (certificate `CN=2004Scape`, SHA-256 `88:47:5C:3F:…:12:82:65`), how to look after it, and how to make a key
of your own: [docs/RELEASING.md](../docs/RELEASING.md#the-android-signing-key), [docs/BUILDING.md](../docs/BUILDING.md#signing-1).

## Saves

Your characters and the bots' world are in the app's own storage, with the same layout as on the iPhone
(`players/<profile>/<name>.sav`, `bots/<profile>/bots.sav`, each with a `.bak` of the previous save). The system's
**Files** app shows them under **2004Scape** in its side menu ("Characters and the bots' world"): copy them out, put a
save back, or restore a `.bak` by first deleting the current save (or renaming it out of the way, e.g. `zezima-old.sav`),
then renaming `zezima.sav.bak` → `zezima.sav`; deleting a save keeps the `.bak` beside it as it is. Files' own writes
go through the same atomic save as the game's, keeping a `.bak` of what they replace.

Updating the app keeps the saves. **Uninstalling** asks whether to **keep the app's data** (the launcher's and Settings'
uninstall dialog shows a "Keep … of app data" box): tick it and a later install of 2004Scape signed with the same key
finds everything again. Without it the saves are deleted, so copy them out with Files first. `adb uninstall` keeps
nothing unless you pass `-k`.

## Controls

As on the iPhone ([../README.md](../README.md#playing)): the world full screen, the minimap and orbs top right, the
tabs on the right, the chat bottom left, tap = left click, hold = the options menu, drag = camera, pinch = zoom, the
native keyboard's 2004 bar for typing. Android adds:

- **Back** (the gesture or the button) does nothing, as an iPhone has no Back: close things with their own buttons. It
  never leaves the game. With the keyboard up, Back closes the keyboard. In the world both screen edges belong to the
  game, so a camera drag from an edge is never taken for Back.
- **Sound** always plays, also with the phone on silent or vibrate, and pauses other apps' music; there is no silent
  switch setting (the iPhone's follows its switch). The volume buttons set it, a call mutes it, and it is always muted
  in the background. Settings › Sound › **Vibration** follows the system's Touch feedback setting too (off there: no
  vibration here).
- The keyboard is the phone's own (Gboard or another) with the 2004 bar above it: what you type, **Cancel** for prompts,
  one-tap amounts, `::` and your last developer commands for chat. Swiping the keyboard down, Back or the bar's chevron
  closes it. A
  hardware keyboard works as on an iPad: Escape, Space and Return as there, the arrow keys turn the camera.
- The app is landscape and full screen; swipe from an edge to see the system bars for a moment.

## Bots and Bot chat

Settings › World › **Bots** and everything about them is as on the iPhone ([../README.md](../README.md#bots)).

Settings › **Bot chat** chooses who writes the bots' replies when you talk to them:

- **Rules**: the bots' own answers.
- **On-device** (the default when the app has a model): the same small language model as the iPhone's, inside the APK,
  run by llama.cpp on the phone's CPU (offline). On the emulator a reply takes 1.4-2.2 s; a phone's should be faster.
  The model is freed when the app goes to the background and loads again (about 1.5 s) for the next reply. While the
  phone reports it is hot (thermal status severe or worse), the bots answer with their own lines.
- **Claude online**: Claude (Haiku 5.5) with your own API key from [platform.claude.com](https://platform.claude.com):
  tap **Set key** and paste it into the app's secure box (screenshots of it are black). The key is kept encrypted on
  this phone (Android Keystore), never in the game or its saves, and never in a backup. While this is on, the chat and
  the bot's state go to Anthropic; if Claude cannot answer, the on-device model does. **Test** asks Claude for one line.
  On a landscape phone the box first shows whole with the keyboard down; tap the field to type (the keyboard then opens
  its own full-screen editor with a Save key).

**Think first** works as on the iPhone (On-device only).

## Developing

Everything in [docs/BUILDING.md](../docs/BUILDING.md#4-tests) applies (the web bundle, the desktop tests).
The Android-specific checks, from the repo root (an emulator or phone; `--serial` picks one, `--no-build` reuses the
last APK):

```sh
(cd android && ./gradlew :app:testDebugUnitTest :botchat:test)  # JVM unit tests: router, saves, lifecycle, keyboard, sound, haptics, the cover, Files, bot chat
(cd android && ./gradlew :app:lintDebug)                       # lint (no errors expected)
node android/test/all.mjs --serial emulator-5554               # every test below on one device from one build, with a summary table (--quick: JVM + smoke)
node android/test/app-test.mjs --serial emulator-5554          # the iPhone's in-app test (autotest.js): login, walk, save, background, reconnect, bots (--bots N)
node android/test/app-test.mjs --device --lm-bench             # the on-device chat model under load with 500 bots, on the phone (--lm-think: with the note)
node android/test/drive.mjs --serial emulator-5554             # the native layer: iOS's drive.mjs checks with Android's meanings (android/test/PARITY.md)
node android/test/smoke.mjs --serial emulator-5554             # boot, login, walk, save, Back, HOME, recreation, rotation, crash, bots, an update, the WebView floor
node android/test/keyboard.mjs --serial emulator-5554          # Gboard and hardware keys on the real app, the bar, focus, the cutout
node android/test/shell.mjs --serial emulator-5554             # haptics, audio focus (the ringer ignored), the launch cover vs the page, Files, the icon
node android/test/lm.mjs --serial emulator-5554                # the chat model in the app: replies, the key's box, Claude against a mock, thermal, unloads; R8 release; no model
node android/test/crisp.mjs --serial emulator-5554             # the pixel snap on the screen itself: sprites, fonts and borders on whole device pixels
node android/test/native/lm-harness.mjs                        # the bot chat code on the Mac's JVM with the real model and a mock of Claude's API
node web/test/e2e.mjs --platform android                       # the page as the Android app runs it, in desktop Chrome
node web/test/hud.mjs --platform android                       # the HUD on Android screens at their real pixel ratios
node web/test/gallery/gallery.mjs --platform android           # the HUD in every state on the Android screens
```

The instrumented tests of the chat model library need a mock of Claude's API reachable from the device:

```sh
node web/test/lm/mock-claude.mjs --port 47591 &
adb -s emulator-5554 reverse tcp:47591 tcp:47591
(cd android && ANDROID_SERIAL=emulator-5554 ./gradlew :llm:connectedDebugAndroidTest \
    -Pandroid.testInstrumentationRunnerArguments.mock=http://127.0.0.1:47591/v1/messages)
```

Each device test leaves screenshots and `results.json` in `android/build/<test>/`. In a Debug build,
chrome://inspect on the Mac opens DevTools for the page (and the engine worker); `adb logcat -s LostCity:V` is the
native log (also in `Android/data/io.github.purexyz.scape2004/files/Logs/lostcity.log`). Measured numbers and the reasons
behind the design: [docs/ANDROID.md](../docs/ANDROID.md).

## Screen notes

A Pixel 10 (2424×1080 at 420 dpi: a device pixel ratio of 2.625, its camera hole on the left in landscape) gets the
crisp pixel snap: every HUD pixel and game pixel 3×3 device pixels, about 808×360 of world, the HUD clear of the camera
hole. On a real phone, check what the emulator cannot show: Gboard's height in landscape (and other keyboards, voice
typing), the key box's layout, the haptics' strength, the chat model's speed, memory and the thermal threshold, and
`node android/test/crisp.mjs --serial <serial>` on the phone's own screen ([docs/ANDROID.md](../docs/ANDROID.md#8-not-yet-verified-on-a-phone)).
