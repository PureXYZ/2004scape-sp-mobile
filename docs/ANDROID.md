# 2004Scape for Android: architecture and contracts

The Android app has full parity with the iOS app. The same web bundle (`build/Game`: host page, HUD, patched client,
engine worker) runs in the Android System WebView, inside a Kotlin shell that does what the Swift shell does on iOS.
Read [ARCHITECTURE.md](ARCHITECTURE.md) first: everything there applies unless this file says otherwise. How to build it:
[BUILDING.md](BUILDING.md); installing and using it on a phone: [android/README.md](../android/README.md).

Numbers marked "measured" come from the arm64 emulator (AVD `Medium_Phone_API_37.0`: 2400×1080 at 420 dpi, a device
pixel ratio of 2.625, Android 17 / API 37, WebView 145.0.7632.218, Gboard) on an Apple M2 Mac, unless they say
otherwise. The app has been tested on the emulator; what only a phone can show is listed in §8.

## 1. Decisions

| Topic | Decision |
|---|---|
| Where | `android/` in this repo (Gradle root). `web/` stays shared: one commit updates both apps. The iOS code never depends on `android/`. |
| Identity | applicationId and namespace `io.github.purexyz.scape2004`, label **2004Scape**, the iOS icon (`ios/Config/AppIcon-source.png`) as an adaptive icon. versionName and versionCode from the repo's `VERSION` (1.0.0 → 10000: major × 10000 + minor × 100 + patch). |
| SDKs | compileSdk and targetSdk 37, **minSdk 30**, **arm64-v8a only**. AGP 9.4.1 with built-in Kotlin (2.2.10), Gradle 9.6.0, JDK = Android Studio's JBR (Java 17 target). Plain Views, no Compose. androidx core-ktx 1.19.1, activity 1.13.0, webkit 1.17.1. JSON: **kotlinx-serialization-json 1.9.0**, the `JsonElement` API only, no compiler plugin (built with Kotlin 2.2; unlike `org.json` it also runs in JVM unit tests). Release builds are **R8-minified**: native methods are kept by `app/proguard-rules.pro`; anything C calls back by name or reflection reaches is marked `@androidx.annotation.Keep`. |
| Signing | One release key, outside the repo: `~/.android/2004scape/release.jks` (PKCS12: one password for the store and the key) plus `~/.android/2004scape/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`; mode 600, folder 700). **Debug and Release are both signed with it**, so either build installs over the other and keeps the saves. If the key is missing, the build falls back to the debug key and prints a warning (task `signingWarning`). The release key's certificate is `CN=2004Scape`, created 2026-10-20 and valid for 36,500 days, SHA-256 `88:47:5C:3F:C0:29:42:05:46:56:3E:CA:F8:87:21:37:B1:35:38:6A:0F:5D:53:24:0D:BE:1B:0D:AB:12:82:65`; `~/.android/2004scape/` must be backed up ([RELEASING.md](RELEASING.md)). |
| Install | Release APKs from GitHub Releases (README); developers sideload with adb (`android/scripts/deploy.sh`). No Play Store. |
| Device | Tuned for a Pixel 10-class phone (2424×1080 at 420 dpi); developed and tested on the arm64 emulator. |
| Origin | **`https://appassets.androidplatform.net`**, everything served at its root by our own router in `shouldInterceptRequest` (not WebViewAssetLoader). Never change it: localStorage and sessionStorage are keyed by it. |
| Orientation | Landscape (`sensorLandscape`), immersive: system bars hidden, transient on swipe. Cutout mode ALWAYS. `env(safe-area-inset-*)` reports the cutout in WebView 145, so host.js's safe area works unchanged; its sides are made equal (the larger of the two, as iOS reports them in landscape), so a camera hole on one side keeps the HUD the same distance from both edges (host.js `readSafeArea`, host.css `--safe-left/right`, the cover and the keyboard bar alike). |
| Back | **Back does nothing** (the gesture and the button), as an iPhone has no Back: a swipe from the edge while playing must not close the bank or the chat. GameActivity consumes it, so the activity never finishes on Back. The IME and native dialogs (the Claude key's box) still take Back themselves. |
| Sound | **No sound setting on Android**: a phone has no silent switch, so Settings › Sound has only Vibration (iOS keeps "Silent switch: Mute / Play"). The game always plays as iOS's Play (`playback`) does: on silent and vibrate too, with audio focus, so other apps' music pauses. A stored `soundMode` is ignored. The game is always muted in the background. |
| Pixels | Crisp pixel snap at fractional device pixel ratios (2.625 → 3 device px per HUD px and per game px; about 808×360 of world on a Pixel 10), done with **CSS zoom** on the HUD's layers. It does nothing at a whole-number ratio, so iOS is unchanged. Details: §6. |
| bots.sav | Written at most once every 30 s, plus at every save occasion (pause, background, Save now, autosave, your logout, Reset world). Both apps. |
| Saves on disk | `filesDir/Documents/` with the iOS layout (`players/<profile>/<name>.sav`, `bots/<profile>/bots.sav`), atomic writes with `.bak` (JNI `renameat2(RENAME_EXCHANGE)`; `link()` is EACCES under SELinux). A player save is fsynced, the file and then its folder (the swap is a folder entry), before its 204; bots.sav is not (iOS syncs neither). A `DocumentsProvider` shows the folder in the system Files app as **2004Scape** (§4.6). `android:hasFragileUserData="true"`, so an uninstall from the launcher or Settings offers to keep the data. |
| Bot chat | The same three choices. On-device: llama.cpp **b11297**'s official Android arm64 prebuilt, **CPU only**, the same GGUF and model.json as iOS, loaded from the APK by fd (stored uncompressed, 32-byte aligned by the build, mmapped). Claude online: the same request, through `HttpURLConnection` (not the Java SDK), with the key in an AndroidKeyStore-wrapped file. Details: §5. |

## 2. Layout of `android/`

```
android/
  settings.gradle.kts  build.gradle.kts  gradle.properties  gradle/  gradlew
  app/                     the app (io.github.purexyz.scape2004): shell, router, saves, keyboard, sound, haptics, cover, Files
    src/main/java/io/github/purexyz/scape2004/...    provider, bot chat glue (§4, §5.2)
    src/main/cpp/          fsx.c (renameat2)
    src/test/              JVM unit tests
    src/debug/res/xml/     network_security_config.xml (cleartext to 127.0.0.1: the Claude mock)
  botchat/                 pure Kotlin/JVM library: BotChatModel, LocalModel, OnlineModel, ModelKeyStore, LlmJni (runs on the Mac JVM too)
  llm/                     Android library: liblcllm (src/main/cpp: the llama.cpp C++ core + JNI), AndroidBotChat (the facade),
                           AndroidModelKeyStore, ThermalGate, ModelAssets, KeyEntryDialog, DeviceStats; instrumented tests
  build-logic/             included build: the plugin lostcity.model (the chat model in an APK: §5.3)
  scripts/                 deploy.sh, fetch-llama.sh, prepare-model.sh, make-icon.swift
  store/                   icon-512.png
  test/                    all.mjs (every test, one build), smoke.mjs, keyboard.mjs, shell.mjs, lm.mjs, crisp.mjs, app-test.mjs,
                           drive.mjs (the real app on an emulator or phone, over adb and CDP), PARITY.md, lib/ (adb + CDP,
                           screen pixels, test builds); native/lm-harness.mjs (the bot chat on the Mac JVM),
                           native/check-apk-alignment.mjs
  build/                   generated, git-ignored: web/Game (the web bundle), model-assets/Model (prepare-model.sh),
                           vendor/llama-b11297 (fetch-llama.sh), the tests' evidence (smoke/, keyboard/, …), gradle outputs
```

The web bundle for Android is built with `node scripts/build-web.mjs --out android/build/web/Game [--debug]
[--autotest] [--skip-pack]` and added to the APK as `assets/Game/**` (uncompressed: `noCompress += ""`). Gradle's
`:app:buildWeb` task runs it (from the repo root, with `--skip-pack`) before every `merge*Assets`, so `./gradlew
:app:assembleDebug` alone gives a complete APK. Properties: `-PnoBuildWeb` (use the bundle already there; the build fails
if `Game/index.html` is missing), `-PwebDebug` (`--debug`), `-PwebAutotest` (`--autotest`), `-PwebPack` (let the engine's
incremental packer run: no `--skip-pack`), `-Pnode=<path>` (when the Gradle daemon has no `node` on its PATH),
`-Plc.model=none` (no chat model in the APK, §5.3). `:llm` runs `android/scripts/fetch-llama.sh` itself.

## 3. Contracts that differ from iOS

### 3.1 Page ↔ native bridge

- **Page → native.** Native registers one `WebViewCompat.addWebMessageListener` object, **`lcAndroid`**, for the origin
  above. It is used only in the main frame; messages from iframes are ignored. A document-start script (main frame only:
  guard with `window.top === window`) defines
  `window.LostCityNativeBridge = { native: { postMessage(m) }, log: { postMessage(m) } }`. These post
  `JSON.stringify({ch: 'native', msg: m})` and `JSON.stringify({ch: 'log', msg: m})` to `lcAndroid`.
  host.js and autotest.js pick their handlers from `window.webkit?.messageHandlers ?? window.LostCityNativeBridge`.
  Nothing fakes `window.webkit`. The messages themselves are exactly the iOS ones (ARCHITECTURE.md §7).
- **Native → page.** `evaluateJavascript("window.__lcCall(<id>, <path as JSON>, <args as JSON array>)")`. host.js
  defines `__lcCall`: it resolves the dotted path on `window.LostCityHost` (e.g. `"keyboard.insertText"`), calls it,
  awaits the result and, when `id > 0`, posts `{ch: 'reply', id, ok: true, value}` or `{ch: 'reply', id, ok: false,
  error}`. A missing function is `ok: false, error: 'missing'`. Native keeps its own timeouts (lifecycle: 4 s, as iOS).
  `id 0` is fire-and-forget (keystrokes). DEBUG replies stay `window.__lcDebugReply(id, value)`.
- **`window.LostCityNative`** (document start, main frame): `{platform: 'android', appVersion, build, osVersion,
  sdkInt, deviceModel, simulator: false, emulator, debug, webView, haptics, settings, lm}`. Native re-registers it
  when the settings change, as iOS does with its user script.

### 3.2 Routes and the save transport

The router implements ARCHITECTURE.md §3 for the origin above. `shouldInterceptRequest` never sees a request body, so:

- **Every PUT/POST to native carries its bytes base64url (no padding) in the `X-LC-Body` request header, with the byte
  count in `X-LC-Length`, and sends no body.** In the engine, `runtime/xhr.ts` does this when
  `globalThis.__LC_PLATFORM__ === 'android'`. boot.js sets that global from the `init` message's `platform` field,
  which host.js fills from `LostCityNative.platform`. Encoding uses `Uint8Array.prototype.toBase64` (WebView 140+),
  with a `btoa` fallback. The checks, in order (as `web/test/serve.mjs` does them): `X-LC-Length` missing or not a
  decimal count → 400; above 32 MiB (33,554,432 bytes) → 413, before anything is decoded; `X-LC-Body` not base64url
  without padding (`[A-Za-z0-9_-]`, length mod 4 ≠ 1) → 400; decoded size ≠ `X-LC-Length` → 400. Then the bytes go
  through the iOS rules (an empty write → 400, identical bytes skipped, `.bak`; 204, or 500 when the write fails).
- Measured with the real engine and 1,000 bots: bots.sav (about 1 MB) takes 18–33 ms, a player save 3–4 ms.
- `POST /log` takes its text from `X-LC-Body` or from `?text=`.
- Desktop tests: `serve.mjs` accepts both kinds of write (`--android` / `android: true`: only the header, as the
  router), and `node web/test/e2e.mjs --platform android` runs the page with an Android `LostCityNative`, a recording
  `LostCityNativeBridge`/`lcAndroid` stub (`web/test/android-stub.mjs`) and the header transport against the Android-only
  server, and checks every save arrives in `X-LC-Body`, that `__lcCall` replies, and the §3.3 API. `hud.mjs --platform
  android` and `gallery/gallery.mjs --platform android` run the HUD on Android screens at their real (fractional) pixel
  ratios and check the pixel snap's zoom and world size for each (but not its crispness: §6).
- Every response has a non-empty reason phrase, `Cache-Control: no-store` and a `Content-Length`. A request to any other
  http(s) host is answered 403: the game never touches the network. Claude online is native code, not the page.

### 3.3 Page API added for Android (both platforms carry it; iOS ignores what it does not call)

| Member | Meaning |
|---|---|
| `LostCityHost.keyboard.frame(overlap, duration, curve?)` | An optional CSS easing for the lift. Android sends its IME animation's own duration with `cubic-bezier(0.2, 0, 0, 1)`. The page takes only `cubic-bezier(x1, y1, x2, y2)` with four plain numbers and both x in 0..1 (what CSS takes; rebuilt from the numbers); anything else, or none (iOS), is the iOS curve. |
| `LostCityHost.audio.setMuted(muted)` → `{muted}` | A fallback mute (it suspends and resumes the client's AudioContext, and suspends it again whenever the client resumes it while muted). Native uses it only where `WebViewCompat.setAudioMuted` (feature `MUTE_AUDIO`) is missing. |
| page → native `{type: 'loader-drawn'}` | Posted once the page's own loader is painted (fonts ready, the logo decoded, two frames; at most 0.8 s after `ready`), so native can remove its launch cover without a visible hand-over. Only on Android (iOS would log it as unhandled; its native runs the same script itself). On Android the loader's fill also starts at the 6 % the native cover draws, rather than growing from 0 behind it. |
| WebView too old | Before it starts the engine the page checks for the iterator helpers (Chrome 122); without them it shows "This phone's Android System WebView is too old for the game (Chrome N; 122 or later is needed). Update "Android System WebView" in Google Play…" and posts `fatal` (native checks the version before loading the page too, §4.2). |
| Settings › Sound, Vibration | On Android the silent switch row and its note are hidden (native always plays and ignores `soundMode`; the page's `applyAudioSession` does nothing there). The Vibration row is hidden when `LostCityNative.haptics === false`, and the Sound category too when that leaves it empty (an Android tablet without a vibrator). |

Strings that name the iPhone, Files › On My iPhone, the Keychain or the simulator come from a
platform table chosen by `LostCityNative.platform` (host.js `STRINGS`: "Saved on this phone: Files > 2004Scape >
players", "Is the phone's storage full?", "Only in the app", "It is deleted from this phone. Claude online then answers
with the on-device model, or with the rules."; status reason `emulator` → "Not on the emulator"). Without
a native app (desktop tests) the page keeps the iOS wording.

### 3.4 Lifecycle

`onPause` → `pause`, `onStop` → `background`, `onStart` → `foreground`, `onResume` → `resume`, with the iOS
coordinator's rules (§7 of ARCHITECTURE.md: de-duplication, 4 s answer timeout, retry of a failed flush at the next
suspending event). The UI thread never blocks waiting for the page. After a successful pause, native calls
`webView.onPause()` and `pauseTimers()`. On foreground it calls `resumeTimers()` and `onResume()` first, then
`foreground` and `resume`. A `GameSession` scoped to the process owns the WebView, so a recreated activity re-attaches
it and never reloads the game. Only the activity that shows the game reports lifecycle, window focus and configuration
changes (§4.2). `onRenderProcessGone` recreates the WebView and reloads; saves are safe because every write is
synchronous.

## 4. The native shell (`android/app/src/main/java/io/github/purexyz/scape2004/`)

Each Kotlin file names the Swift file it ports (`LostCity/*.swift`) and the section of this document it implements in its
header.

### 4.1 Session, activity and components

`LostCityApp` (AppDelegate: the log, the launch line, the save store's stale-temp sweep) holds a process-scoped
`GameSession` (GameViewController: the WebView on a `MutableContextWrapper`, the router, saves, settings, the page
bridge, the lifecycle coordinator, keep-awake, the cover, recovery, the debug hooks); `GameActivity` is only a window for
it. `AssetRouter` (+ `GameAssets`, `Mime`, `BodyHeader`), `SaveStore` (+ `FileOps`, `Fsx` and `src/main/cpp/fsx.c`),
`PageBridge`, `LifecycleCoordinator`, `NativeSettings`, `AppInfo`, `Log`, `KeepAwake`, `NativeScripts`, `GameWebView`,
`GameWebViewClient`, `GameChromeClient`, `RSTheme` (+ `RSTextView`, `StretchDrawable`) and `Cover` are the core.

- **Components.** Everything else is a `SessionComponent` in `session.components`, installed by one line each in
  GameSession's init, in this order: `Shell.install` (haptics, sound, the loading cover: §4.4, §4.5), `LmComponent.install`
  (the bots' chat model: §5.2), `KeyboardBridge.install` (§4.3). GameSession calls each at iOS's points (`pageReset`,
  `pageReady`, `status`, `settingsChanged`, `fatal`, `memoryWarning`, `start`/`resume`/`pause`/`stop`, `attach`/`detach` of an activity with its root view, focus and
  configuration changes). A component registers the page messages it handles with `session.handle("keyboard") { msg ->
  … }` (also `haptic`, `lm`, `lm-key`, `lm-warm`, `lm-bench`, `loader-drawn`); a message nobody registered is logged once
  and ignored. Native's own haptics (`session.playHaptic(style)`, the Vibration setting applied) go to the `haptic`
  handler. DEBUG actions: `session.debugAction(name) { msg, reply -> … }`. The cover's view comes from
  `session.coverViewFactory` (the loading cover's, §4.5); its state machine (`CoverController`) is the core's.
  `session.lmStatus` feeds `LostCityNative.lm`; `SaveStore.onChange` reports changed folders (for the Files provider);
  `GameActivity.presenting(dialog)` names a dialog for `ui-state`; `session.keyboardFocus` is the keyboard's focus seam
  (§4.3).
- **Views.** `attach` puts the WebView at index 0 of the activity's root, then each component's views (the keyboard's
  focus-holding view and its bar), then the cover on top of everything.
- **Only the current activity counts.** Android 17's PackageUpdateController relaunches an app that is updated while on
  screen (deploy.sh, `adb install -r`) with `FLAG_ACTIVITY_CLEAR_TASK`, and a launcher or notification can do the same:
  the new activity is created, started and resumed before the old one's `onStop` and `onDestroy`. GameActivity passes
  lifecycle, window focus and configuration calls to the session only while `session.activity` is itself, so that late
  `onStop` never pauses the WebView or mutes the game under the new activity (the log says `an older activity stopped
  after a newer one took the game: ignored`; smoke.mjs `update`).
- **Native → page.** `PageBridge.call(path, args)` evaluates `typeof window.__lcCall==='function' ? (__lcCall(id, path,
  args), 1) : 0`: `0` is `missing` at once (host.js not running yet); a reply on `lcAndroid` completes it; every call
  with a completion has a timeout (30 s by default); a page reset fails pending calls. `PageBridge.run(source)` runs an
  async snippet that replies itself.

### 4.2 Lifecycle, recovery, logs

- **Lifecycle.** The coordinator keeps iOS's 8 s flush timeout (the page's own engine request times out after 4 s).
  After a flush ends with the activity stopped, the WebView's timers are paused (`onPause` + `pauseTimers`); `onStart`
  resumes them before `foreground`.
- **Safe area.** Nothing is injected: WebView reads the cutout through `env(safe-area-inset-*)` and follows a 180°
  rotation live (checked by the smoke test with the emulator's tall cutout). The page, the cover and the keyboard bar
  make the sides equal, the larger of the two, as iOS's landscape safe area. A waterfall (curved-edge) display reports
  its curves as top and bottom insets in landscape (21 dp each on the emulator's overlay): the HUD keeps clear of both
  (Bottom margin Auto is the reported bottom on Android, 0 on iOS, whose bottom inset is the home indicator, which the
  HUD covers on purpose). Settings › Display › Screen margins (a page of its own: Side, Top, Bottom; `safeSides`,
  `safeTop`, `safeBottom`: None -1, Auto 0, +16, +32 CSS px) change them; native's cover follows them
  (`CoverView.margins`, `CoverGeometry.pageSafe`); the keyboard bar keeps the cutout's own sides.
- **Back.** Nothing (§1 Back): `GameSession.back` logs `[host] back: ignored`. A dialog (the Claude key's box) takes
  Back itself.
- **Renderer death.** The dead WebView is destroyed and a new one (same settings, listener and scripts) takes its place,
  then iOS's policy: a notice and a reload; in the background, the reload waits for the next resume and then for the window to be visible again (its next draw, 1.5 s at most), so the page never boots hidden; three in two
  minutes, the error screen. A renderer unresponsive for 20 s while the app is in front is ended (and so reloaded). If no
  new WebView can be made, the error screen says "Android System WebView is missing or disabled." and its Try again
  makes one in the activity showing the game and loads the game (smoke.mjs `nowebview`).
- **WebView floor.** Below Chrome 122, or without document-start scripts or WebMessageListener, native's error screen
  says "Android System WebView is too old (…). Update it from the Play Store." with Update (the Play Store page). The
  WebView is checked again when Update is tapped (passing now, the game starts instead) and whenever the app comes back
  to the front: once it passes, the WebView is made and the game loads in the same process (smoke.mjs `floor`).
- **Memory.** `onTrimMemory` at BACKGROUND or worse (and RUNNING_LOW/CRITICAL below API 34) and `onLowMemory` are a
  memory warning, at most one per 10 s (the renderer-gone path is the real safety net).
- **Logs.** logcat tag `LostCity` (`adb logcat -s LostCity:V`), and `Android/data/io.github.purexyz.scape2004/files/Logs/lostcity.log`
  (2 MB, rotated to `lostcity.1.log`; readable with `adb pull` on a release build too). A debug build launched
  with `--ez lostcity.verbose true` writes the verbose lines too (kept until `false`). Like every launch extra
  (`lostcity.settings`, `lostcity.webViewFloor`), a release build ignores it, and the switch a debug build kept: the
  activity is exported, so any app could send it (lm.mjs `release` checks).
- **DEBUG builds.** `WebView.setWebContentsDebuggingEnabled` (chrome://inspect, CDP); `{type:'debug'}` actions:
  iOS's (`terminate`, `idle-timer`, `ui-state`, `overlay`, `memory-warning`, `lifecycle`, `settings`, `reload`,
  `activity`) and `back`, `renderer-kill` (WebViewRenderProcess.terminate()), `renderer-crash` (chrome://crash: a real
  crash, didCrash true), `webview-fail {count}` (the next WebViews cannot be made), `recreate`, `trim {level}`, `config`,
  `webview`, `insets`, `session`, plus the components'
  (§4.3-4.6, §5.2); launch extras `--es lostcity.settings '<json>'` (merged before the page loads) and
  `--ei lostcity.webViewFloor <major>` (a later intent changes it too: the floor lowered while the error screen waits
  is how smoke.mjs plays an update). Release builds compile the hooks but answer `unhandled native message: debug`.
- **Router responses.** Chromium's stream loader adds a Content-Length of its own (the stream's `available()`) before
  the WebResourceResponse's headers, so `GameWebViewClient.response` leaves the router's out when the stream reports the
  same length (one header, as on iOS), and a HEAD reply's stream reports the length and yields no byte.

### 4.3 Keyboard

Ports `ios/LostCity/KeyboardBridge.swift` and `KeyboardAccessoryBar.swift`; the page contract is ARCHITECTURE.md §7's, unchanged
(`{type:'keyboard', action:'show'|'update'|'hide'}` in; `LostCityHost.keyboard.insertText / deleteBackward / submit /
cancel / dismissed / pressKey / frame` out), with the iOS log lines (`[kbd] show kind=…`, `dismissed by the player`,
`cancelled by the player`, `covers N dp of the page (s s)`, verbose `insertText (n chars)`, `pressKey X down|up`, `refused
characters (…)`).

| File | What |
|---|---|
| `KeyboardBridge.kt` | The logic and state, no Android views (JVM-tested): show/update/hide per kind, the input rules (`maxLength`; charsets `chat` with its `::` rule, `text`, `alnum`, `game` with £, `name`, `digits`, `any`), the warning haptic (`session.playHaptic`, played by the Haptics component) and bar flash at most every 0.3 s, the optimistic echo (0.5 s, reconcile at 0.55 s), chips (replace the line, `submit`, `whenEmpty`), paste (quotes/dashes/ellipsis to ASCII, line breaks to one space, 80 at most, chat-only when nothing is requested), Return (the chat bar empties at once), hardware keys' down/up with iOS's names and its own Backspace/Delete repeat (400 ms, then 50 ms), the covered height, Back, focus lending. Characters are grapheme clusters, as Swift's. |
| `KeyboardBridgeView.kt` | The 1×1 view that holds input focus for good (the WebView is never focusable): a text editor only while requested; `dispatchKeyEvent` for hardware keys (named keys → `pressKey`, system repeats dropped; characters with the key map's layout, Shift and dead keys → `insertText`, Space included; Ctrl+V / Paste → the clipboard; Back, volume and other system keys pass on). It owns the bar and the insets and is the bridge's `Surface`. |
| `GameInputConnection.kt` | `TYPE_CLASS_TEXT \| VISIBLE_PASSWORD \| NO_SUGGESTIONS` (a number pad for amounts), never a password type; `imeOptions` `NO_EXTRACT_UI \| NO_FULLSCREEN \| NO_PERSONALIZED_LEARNING \| FORCE_ASCII` + Send / Go / Done by kind. An editable mirrors the bar's text (cursor at the end): `commitText` of any length (`\n` submits; several characters with a line break, any of Swift's isNewline ones (`\r\n`, U+2028/2029, NEL, VT, FF), are a paste), composing followed by difference (a change to the line from outside the IME, the bar's Send, a chip, a hardware Enter or Backspace or another field with the same editor, ends a composition and restarts the editor), `deleteSurroundingText` past the mirror, `sendKeyEvent` (DEL, ENTER, characters), `performEditorAction` → submit; stickers, private commands and selections refused. |
| `KeyboardInsets.kt` | `WindowInsetsAnimationCompat` on the bridge's own view (never the root): the bar rides the IME frame by frame; `keyboard.frame(IME + 52 dp, the IME's duration, 'cubic-bezier(0.2, 0, 0, 1)')` once per animation start and at its end; the navigation bar the IME brings back is hidden again; the bar keeps out of the cutout. |
| `KeyboardAccessoryBar.kt`, `ChipStrip.kt`, `RSButton.kt` | The 2004 bar, iOS's layout in dp: 52 tall, prompt (≤ 38 %), field (≥ 180, 120 for amounts; text at scale 2 cut at the head, blinking `*` caret, masked when secure, red flash), chips (Game Options buttons, 6 apart, 45 %/30 % of the bar, scrolling with faded edges and the 14 dp window rule), Cancel, the submit button, the chevron hide button. View ids `kbd_*` (`res/values/ids.xml`). |

Android-only behaviour, each where iOS has its own way:

- **The IME closed by the player** (Back, its own hide key, a swipe down on Gboard) is `dismissed()`, as iOS's hide button. Not
  when the app is leaving the front or the window lost focus, nor within 0.5 s of a hardware keyboard, window focus or
  display rotation change (a 180° turn takes the IME away for an instant with no configuration change); then the keyboard
  stays and the IME is asked for again if it does not come back by itself (0.4 s). While the app is not in front the
  page is not told of the IME at all, and a lower height is reported only once the system is done moving the IME about
  (1.5 s after the app comes to the front, 0.5 s after a rotation or focus change, 0.3 s after a settle check), so the
  page's chatbox never dips (iOS keeps the keyboard across an app switch).
- **An IME that resizes itself.** Gboard now and then comes up 24 px (9 dp) taller, at its first show after a launch or
  on the way back from HOME, and settles to its real height a moment later without an animation (measured: 304 → 295
  dp). The page follows the IME's height, and a resize of an IME that stays up is reported with 0 s (the IME and the
  bar are already there), not with the hide rule's duration (`ime resized A → B dp` in the log).
- **Waiting for the IME.** A request reports the bar alone (52 dp) if no IME animation has started after 300 ms when a
  hardware keyboard is attached (the IME may never come), and after 1.5 s without one (the IME is the only way to type,
  and Gboard's first show after a launch can take longer than 300 ms). Not longer with a hardware keyboard: beside one,
  a phone's on-screen keyboard is off by default, and the bar would cover the page's input line meanwhile. So an IME
  that does come, slowly (the AVD shows Gboard beside its hardware keyboard; right after a cold boot it can start after
  300 ms), gets a 52 dp frame (0 s) and then its own animated frame; keyboard.mjs allows that bar-only frame first only
  with a hardware keyboard.
- **Back** with the bar up and no IME (a hardware keyboard) does nothing, as everywhere (§1 Back): the bar's hide button
  closes it. With an IME up the IME takes Back itself and closes (`dismissed()`).
- **A hardware keyboard and no IME**: the bar alone at the bottom covers 52 dp, as iOS's accessory bar does.
- **The client hides the keyboard** on a tap in the world (its MobileKeyboard, as on iOS); the focus never leaves the bridge.
- **The bar riding down** after a hide (it goes with the IME's animation) takes no Send: the bar's Send submits only while
  the keyboard is requested, as iOS's accessory bar takes no touch while it animates out.

**Focus lending** (`KeyboardFocus`, for the Claude key's box, §5.2): `session.keyboardFocus?.lend()` returns an
`AutoCloseable`. While a lend is open the bridge's view is not focusable (its IME and bar go, the page hears
`keyboard.frame(0)`), so the dialog's own field gets the IME; closing the handle (once is enough, twice does nothing;
lends nest) makes the view focusable again and re-takes focus and, when the page still wants it, the keyboard
(`AndroidBotChat.Host.lendKeyboardFocus(true/false)` + `activateKeyboard()` map onto `lend()` and `close()`).

DEBUG actions (iOS's names): `type {text}` (`\u0008` is Backspace), `key {key, down}` (a synthetic hardware KeyEvent
through the view), `bar {button: hide|cancel|submit}`, `chip {index}` (→ its label), `paste {text}`, `keyboard-state`
(iOS's keys with Android values: `keyboardType` is the inputType, `returnKeyType` the IME action, `inputView` `"system
keyboard"` / `"none (hardware only)"`; plus `imeVisible`, `imeHeight`, `hardKeyboard`, `barVisible`, `barTop`, `editor`,
`editable`, `composing`, `focused`, `webViewFocused`, `lent` and `views`, the bar's parts in screen px); Android's own
`kbd-lend {ms}`, `kbd-ime {ops: [[method, args…], …]}` (setComposingText, commitText, finishComposingText,
setComposingRegion, deleteSurroundingText, sendKeyEvent, performEditorAction on the live InputConnection, and
barSubmit, in one go; → the bar's text, the mirror, the composition and whether the editor restarted after each) and
`clipboard {text}`.

### 4.4 Haptics and sound

- **Haptics** (`Haptics.kt`, ports Haptics.swift). The page's nine styles (+ `intensity` on impacts, iOS parity) and
  native's own (`session.playHaptic`: a refused key's `warning`, the fatal path's `error`; skipped when Settings ›
  Vibration is off) play as the vibrator's composition primitives (CLICK, TICK, LOW_TICK), else predefined effects, else
  `View.performHapticFeedback` (`HapticTable` in `Haptics.kt`). Every vibration is a touch vibration
  (`VibrationAttributes.USAGE_TOUCH`; API 30: `USAGE_ASSISTANCE_SONIFICATION`), so the system's Touch feedback setting
  governs it; with it off nothing is sent. VibratorManager from API 31, the Vibrator service on 30. The AVD has a HAL
  vibrator with primitives, so it plays tier A and `dumpsys vibrator_manager` lists each one. Verbose log `[haptic]
  <style>`. `LostCityNative.haptics` (AppInfo) is false without a vibrator: the page hides the Vibration row.
- **Sound** (`AudioSessionController.kt`, `AudioSession` is the pure rules). No setting (§1 Sound), so always iOS's
  `playback`: audio focus `AUDIOFOCUS_GAIN`/`USAGE_GAME` while resumed (given back in onPause), muted on
  LOSS/LOSS_TRANSIENT (another app's music, a call) or a refused request, back on GAIN; CAN_DUCK is left to the system.
  The ringer is never read. Always muted while stopped (alongside the chat model's unload, §5.2). Mute =
  `WebViewCompat.setAudioMuted` (MUTE_AUDIO, present in WebView 145), else `LostCityHost.audio.setMuted`; re-applied on
  every page reset (a new WebView after a crash starts unmuted). `volumeControlStream = STREAM_MUSIC`. Log `[audio] muted
  (<reason>)` / `sound on` / `audio focus …`.
- DEBUG actions: `haptics` (iOS's: the styles played, cleared), `haptics-state`, `native-haptic {style}` (through
  playHaptic), `audio` (the sound state).

### 4.5 The loading cover

`LoadingCover.kt` (ports LoadingOverlay.swift and Notice) is `session.coverViewFactory`'s view: the page's `#loading`
drawn by hand at host.js's zoom (`CoverGeometry.pageZoom`: `baseZoom` + `snapZoom` from the view's size, the density and
the display cutout; 8/7 on the AVD), with RSTheme.

- **Placement** follows how Chromium paints the page's overlay (`CoverGeometry.loader`): Blink lays it out in layout px
  (LayoutUnits of 1/64), rounds box edges to whole layout px and floors border widths, text baselines from Blink's
  rounded font metrics (Android moves a unit from the ascent to a rounded-down descent; the half leading above is
  floored), glyph x unrounded (subpixel positioning). With the snap the overlay is CSS-zoomed (§6), so a layout px is a
  device px and every edge lands on one (the bar from device px 693 to 795, its border 6 px, the text's baseline at
  756); a scaled-up overlay (a tablet's ×1.5 at a whole ratio) is laid out at the viewport ÷ zoom and painted zoomed and
  anti-aliased. Measured (shell.mjs `cover`): the bar, its border, fill, text and the logo identical to the page's, pixel
  for pixel; the caption differs in 12 px by 1/255. Without the snap at a fractional ratio (Display size Larger or Largest
  on a 1080 px phone, §6) the page draws its text at a fractional scale, anti-aliased between device px, and the cover
  does not copy that blur: placement and the bar's frame still match (shell.mjs `cover` at `wm density 500`: frame 0 px,
  text 1,035 px and caption 1,299 px differing), so the loader's text softens a little during the fade.
- **The hand-over.** The cover goes on the page's `{type:'loader-drawn'}` (GameSession's `uncover` leaves it to the page
  when this handler is registered; its 3 s fallback stays; a `loader-drawn` before the page's `ready` is ignored),
  fading over 0.25 s. Both draw the fill at 6 % then (§3.3).
- **The launch screen.** The system launch screen stays black with no icon (values-v31) and ends at the activity's first
  frame, which is the complete cover (filmed: no icon pixel before it), as iOS's launch screen gives way to
  LoadingOverlay; it is not held until `loader-drawn`, which would only show black longer.
- **The error screen** is real views (ids `cover`, `cover_retry`) at the zoom; **notices** are RS Plain 12 yellow on
  black 0.8 with the 1 px border, at the crisp snap's scale (never the tablet zoom, as iOS).
- DEBUG actions: `notice {text}`, `cover-hold {ms}` (the next hand-over waits, for photographs); `ui-state.overlayLayout`
  is the cover's zoom and frames in dp.

### 4.6 The Files app

`SavesDocumentsProvider.kt` (authority `io.github.purexyz.scape2004.documents`, permission MANAGE_DOCUMENTS): one root
"2004Scape" ("Characters and the bots' world") over `filesDir/Documents`; ids `root` and `root/<path>` by SaveStore's
path rules; hidden (temp) files never listed or opened, `.bak` listed. Files-app writes go to a hidden temp and through
`SaveStore.write` on close (atomic, `.bak`, unchanged skipped, under the save's lock; at most 32 MB, an empty write
leaves the file as it was; an empty previous version, a created document's placeholder, is never kept as the `.bak`). Delete = a save → `.bak` (the DELETE route) when no `.bak` is there, otherwise the save removed and the `.bak` kept (as
the iOS Files app deletes); a `.bak` removed; a folder recursively. Rename never replaces (restoring `zezima.sav.bak`
needs `zezima.sav` gone: delete it, or rename it out of the way first); copy/move within the root; create picks "name
(1).ext". `SaveStore.onChange` and the provider's own operations notify a folder and every folder above it, at most once
per folder every 2 s (`ChangeThrottle`); DocumentsUI reloads a few seconds after a notification. The system starts the
process for the provider without an activity (DocumentsUI refreshes its roots after an install or a data clear), so a
launch right after one can be WARM; nothing heavy runs then. DEBUG action: `documents {op, …}` (DocumentsContract calls
as the Files app makes them: list, create, write, read, rename, delete, copy, move).

### 4.7 The icon

`android/scripts/make-icon.swift` makes it from `ios/Config/AppIcon-source.png`: an adaptive icon (`mipmap-anydpi`:
background = the art mirrored outwards and darkened, foreground = the art at 72 dp with a 6 dp feathered edge so a circle
never cuts the stones, monochrome = the stones without the carved letters, for themed icons) at mdpi…xxxhdpi,
`android:icon`/`roundIcon`, and `android/store/icon-512.png`. No 48 dp legacy bitmaps: at minSdk 30 every launcher takes
the adaptive icon.

## 5. The bots' chat model (ARCHITECTURE.md §7.1)

The page contract is iOS's, unchanged: `{type:'lm'|'lm-warm'|'lm-key'}` in, `LostCityHost.bots.lmReply` and `lmStatus` out,
`window.LostCityNative.lm` at document start, the same reply, timings, usage and status shapes, error strings and log
lines. `android/botchat` is a line-for-line Kotlin port of `LostCity/{BotChatModel,LocalModel,OnlineModel,
ModelKeyStore}.swift`; `android/llm/src/main/cpp/lc_llm.cpp` is LocalModel.swift's llama.cpp half (load, prompt, sampling
loop) in C++. Its checks are iOS's: `android/test/native/lm-harness.mjs` runs the iOS harness's on the port.

### 5.1 What differs from iOS (deliberately; the page cannot tell)

| | iOS | Android |
|---|---|---|
| Backend | Metal, all layers | ggml's CPU backend (`gpuLayers` 0), the best of the prebuilt's seven `libggml-cpu-android_*` variants by score (the emulator: `armv8.2_2`), weight repacking on |
| No runtime | reason `simulator` | reason `no-runtime` (liblcllm did not load, or no CPU variant runs here); the page shows "Not in this build" |
| Stopping | at the next token | also inside a prompt batch (llama.cpp's abort callback: a pause or the deadline) |
| Claude's 8 s | URLSession's request timeout | one limit on the whole call, the host lookup included (a watchdog disconnects and completes with a timeout; a lookup it cannot interrupt finishes later, dropped) |
| Thermal | `ProcessInfo.thermalState` ≥ serious | `PowerManager.currentThermalStatus` ≥ `THERMAL_STATUS_SEVERE`; the log says `thermal status severe` |
| Key | Keychain generic password | AES-256-GCM AndroidKeyStore key `io.github.purexyz.scape2004.claude.api-key` wrapping `noBackupFilesDir/claude-key.bin` (`LCK1`, IV, ciphertext); log `the Keystore refused the Claude key (<Exception>)`; the file is removed only when it can never be read (wrong tag, bad format, Keystore key gone), any other read failure skips that read (as iOS) |
| Load log | `… 99 on the GPU, 2 threads)` | `… 0 on the GPU, 2 threads, mmap)` or `…, read: not 32-byte aligned in the APK)` |
| llama log | | debug output, not info: `repack: repack tensor` (one per weight at every load; iOS never repacks), `create_tensor: loading tensor` and `llama_graph_n_input_tensors:` (about 950 lines a load; iOS's filter still lets those two through) |
| Key box text | "…stays in this iPhone's Keychain…" | "…stays encrypted on this phone…" (native `KeyEntryDialog`, `FLAG_SECURE`) |

### 5.2 In the app (`LmComponent`)

`app/build.gradle.kts` applies `lostcity.model` and depends on `:llm`; `LmComponent.install` (one line in GameSession's
init, after `Shell.install`) makes `AndroidBotChat` and registers it. `LmComponent.kt` ports GameViewController.swift's
§7.1 glue; `LmHost` is the facade's `Host` on an `LmSeam` (the session; a fake in the JVM test):

```kotlin
val botChat = AndroidBotChat.create(context, log = <LcLog as a botchat LogSink>, debug = BuildConfig.DEBUG)
botChat.host = object : AndroidBotChat.Host {
    override fun lmReply(reply: JsonObject)  // page.call("bots.lmReply", reply)
    override fun lmStatus(status: JsonObject) // session.lmStatus = status (LostCityNative.lm), then page.call("bots.lmStatus", status)
    override fun activity(): Activity?        // the game's activity between onStart and onStop
    override fun lendKeyboardFocus(lend: Boolean); override fun activateKeyboard(); override fun errorHaptic()
    override fun debugReply(id: Int, value: JsonElement)  // window.__lcDebugReply(id, value)
    override fun terminations(): Int          // session.terminationCount (the bench's stats)
}
```

- **Status.** Computed once before the first page load (`session.lmStatus = botChat.status`), so the first document has
  `LostCityNative.lm` (with liblcllm's load, model.json and the key's read: 23 ms on the main thread at launch, the
  verbose line `[lm] bot chat ready in N ms`). Each status from the facade first registers the document-start info
  again, then calls `LostCityHost.bots.lmStatus`; replies go to `LostCityHost.bots.lmReply` (fire and forget, as iOS's
  page.call without a completion). A status that changes between a new document's start and host.js's first lines
  reaches neither (iOS the same); the next status corrects it.
- **Messages.** `session.handle` for `lm`, `lm-warm`, `lm-key`, `lm-bench` → `botChat.dispatch` (a release build logs
  `unhandled native message: lm-bench`, as an iOS release build does). DEBUG actions `lm-status`, `lm-endpoint`,
  `lm-key-alert` → `botChat.debugAction`, replying through `window.__lcDebugReply`.
- **App events.** `pause` → `pause()` (the reply being written stops), `stop` → `suspend()` (the model is freed:
  `local model unloaded (background)`, while the sound is muted), `resume` → `resume()`, the session's memory warning →
  `memoryWarning()` (the reply being written stops, those waiting are dropped, the model is freed at once; a load
  needs 1 GB free above the low-memory line, `DeviceStats.headroomBytes`), every page reset (load, reload, renderer crash) → `pageReset()` (`#N answered after the page
  reloaded: dropped`). The warm-up is the page's: `{type:'lm-warm'}` when the player enters the world with the bots on
  and the on-device model in use.
- **The key's box** (`KeyEntryDialog`). Shown only while the activity is started, with the keyboard bridge's focus lent
  through `session.keyboardFocus?.lend()` and closed once when the box goes (closing also re-activates the bridge, so
  `activateKeyboard()` adds nothing); `GameActivity.presenting` names it for `ui-state` (`AlertDialog`). An activity
  destroyed with the box up dismisses it first, as Cancel, so the focus is never left lent. A refused key plays
  `session.playHaptic("error")`. The field is masked (single line is set before the password input type: after it,
  `setSingleLine` would replace the password transformation and show the key; lm-key-alert's `secure` also requires the
  transformation). On a landscape phone Gboard takes about 295 of 411 dp, which would leave the box no room for its
  field or buttons, so below 560 dp the box opens with the field focused and the keyboard down, and a tap on the field
  opens the IME's full-screen editor with a Save key; taller screens get the keyboard at once. FLAG_SECURE: the box is
  black in screenshots, the game beside it is not (with the IME up over the box, all of the screen is black).
- **Network.** `INTERNET` comes from `:llm`'s manifest. Debug builds use `src/debug/res/xml/network_security_config.xml`
  (cleartext to `127.0.0.1` only: the mock through `adb reverse`); release keeps HTTPS only. The page still cannot reach
  anything: a fetch to `127.0.0.1:<mock>` or `api.anthropic.com` gets the router's 403.
- **R8.** `llm/consumer-rules.pro` keeps what JNI reaches (LlmJni's natives, LoadOut/GenOut fields, LlmLog.line);
  verified with the minified release APK on the emulator (lm.mjs `release`).

### 5.3 The model in the APK (`lostcity.model`, android/build-logic)

- `android/scripts/prepare-model.sh [--download | <gguf> | --spike | --none]` writes `android/build/model-assets/Model/`
  (by default the iPhone's model, `models/bots-2004.json`: the cache's `models/bots-2004-q4km.gguf`, sha256 `94ef25e0…`,
  template `qwen-chatml-hybrid`; a relative path is taken from where the script is run). The plugin adds it to every APK component's assets (`assets/Model/`),
  stored (`noCompress "gguf"`). Without a prepared model the build warns and the APK has none; `-Plc.model=none` leaves
  it out on purpose. `verifyModel` checks size and sha256 against model.json before the assets merge.
- **Alignment.** AGP aligns stored entries to 4 bytes only (measured: the model landed at `mod 32 = 20`). The plugin
  transforms every APK (`SingleArtifact.APK`, `toTransformMany`): `zipalign -f -P 16 32`, then `apksigner sign
  --alignment-preserved true` with the variant's own key (the 2004Scape release key for :app; apksigner otherwise
  re-aligns everything to 4), then checks every stored entry and fails the build if the model is not 32-byte aligned. The
  build log says `lostcity.model: <apk>: assets/Model/bots-2004.gguf at offset N (mod 32 = 0): mmap from the APK`.
  `node android/test/native/check-apk-alignment.mjs <apk>` checks any APK independently.
- At run time `ModelAssets` reads `Model/model.json` and opens the GGUF with `AssetManager.openFd` at each load; the C++
  core `dup`s the descriptor, peeks the GGUF's data offset and mmaps when it is 32-byte aligned (else reads it into
  memory: about 200 MB more anonymous memory). Debug builds: a model in `getExternalFilesDir(null)/Model/` wins
  ("(sideloaded)").
- Known: with a FILE*, llama.cpp maps and prefaults the whole APK (`MAP_POPULATE`), so file-backed RSS is about the APK's
  size (clean, reclaimable pages).

### 5.4 Measured (the emulator, 2 threads, the iPhone's model)

| | The library (bench prompt #1, :llm instrumented) | In the app (lm.mjs) |
|---|---|---|
| Load from the APK | 1.2-1.7 s mmap (2.0 s cold), 1.45-1.85 s read | the warm-up 1.2-1.8 s (mmap); R8 release 1.19-3.4 s |
| Prompt (about 280 tokens) | 163-219 tok/s | about 180-195 tok/s |
| Generation | 42-61 tok/s | about 45-50 tok/s |
| A plain reply | 1.37-1.82 s in all | 1.35-1.55 s |
| With the note (13-24 tokens) | 1.59-1.99 s in all (the note 240-360 ms) | 1.8-2.2 s (the note 270-500 ms) |
| First reply after the background | | 2.9-3.5 s (load 1.4-1.8 s) |
| Memory, model loaded (mmap) | anonymous RSS about 680 MB, PSS about 1.15 GB (of which the mapped APK about 0.5 GB, clean); read mode: anonymous about 885 MB, PSS about 860 MB | |
| Compute buffer | 43.16 MiB (`n_outputs_max` 1) | |
| A pause inside a prompt | stops in 4-8 ms | |

## 6. The crisp pixel snap

At a fractional device pixel ratio (2.625, 2.75, 3.5…) a HUD px of 1 CSS px is 2.625 device px, so the 2004 sprites and
bitmap fonts alternate 2 and 3 device px and look soft. As built (host.js `snapZoom`, hud.js `crispSize`/`hudView`,
host.css `html.ui-snapped`):

- **The HUD zoom** is `round(dpr·z)/dpr` (8/7 at 2.625: an 800×360 HUD on 914×411, as an iPhone 13 mini's 812×375 at
  3x) while the HUD keeps at least 568×320 HUD px (667 wide for ×1.5/×2); its area is the whole HUD px inside the screen
  (799×359) and the safe area whole HUD px. It never rounds down where the next whole number has no room: then a larger
  Display size could never make the HUD bigger, so the zoom stays the one the system asks for (soft), as iOS's Display
  Zoom makes everything bigger. On the AVD (2400×1080) the Display sizes give 2, 3, 3, 3.125 and 3.375 device px per HUD
  px (356, 420, 460, 500, 540 dpi): Small, Default and Large crisp (4 would leave 270 HUD px of height), Larger and
  Largest soft and bigger; before, the last four were all 3. `html.ui-snapped` is set only when the zoom is not 1 and the ratio is not a
  whole number: never on an iPhone, an iPad or in the iOS desktop tests.
- **CSS zoom, not a transform.** Measured on the emulator (android/test/crisp.mjs; WebView 145): a phone's WebView lays
  the page out in device px (Blink's zoom for the device scale factor), so a box under `transform: scale(8/7)` is laid
  out at 2.625 device px a CSS px with its edges rounded there, then scaled 8/7 and resampled: the tab icons matched 17 %
  of their sprite pixels, the RS fonts and the 2px borders smeared over device px, with or without `will-change`. Under
  `zoom: 8/7` Blink lays the box out at its final scale, 3 device px a HUD px, every edge on a whole device px: the tab
  icons match 585/585 sprite pixels on their own 3×3 blocks, every ink block of the RS fonts is whole, a 2px border is
  6 device px (a 1px border 3), the side panel's canvas is exactly 474×654 device px on whole edges. So with the snap
  `#hud-ui` (hud.js), `#menu-layer`, `#label-layer` and every `.overlay` (the loader included, §4.5) are CSS-zoomed;
  they keep `will-change: transform`, so they stay the stacking contexts and containing blocks the transformed layers
  are. DOM geometry reads the same either way (offset and client sizes in HUD px, getBoundingClientRect in CSS px).
  The world map's iframe (MapView, in an overlay) gets the zoom too: its document sees a device pixel ratio of 3 and
  the same CSS size as before (checked on the emulator). WebKit's CSS zoom has its own text bug, which is
  why iOS (and a tablet at a whole ratio) keep the transform.
- **Desktop Chrome cannot judge this.** Its emulated device pixel ratio lays the page out in CSS px and scales the
  result, so there the transform looks crisp and the zoom soft, and a zoomed 3px border rounds down to whole CSS px.
  hud.mjs and gallery.mjs `--platform android` check the zoom and the sizes the page asks for (with a desktop-only
  tolerance for that border rounding); crisp.mjs on an emulator or phone checks the pixels.
- **The world** renders at the smallest whole k ≥ round(dpr) device px per game px that gives ≥ 512×334, ≤ 410,000 px
  and a 512 px window beside the panel (else the iPhone rule, soft), with the HUD's exception: no rounding down where
  k + 1 has no room (Larger: 768×345 game px, Largest: 742×334, instead of the default's 800×360); its surface is W·k/dpr CSS px from the top left,
  covering the screen. The chatbox's canvas is 3 device px per game px; the side panel's is 5/6 of the 2004 size (2.5
  device px per game px, as on a 3x iPhone), soft by design.
- Screens and the sizes they get: `web/test/android-stub.mjs`.

## 7. Tests

| What | Command (from the repo root unless it says otherwise) |
|---|---|
| JVM unit tests: router, saves, lifecycle, settings, bridge, keyboard, haptics, sound, cover geometry, Files provider, bot chat glue | `./gradlew :app:testDebugUnitTest` (android/) |
| The bot chat library on the JVM (fake native, a local HTTP stand-in) | `./gradlew :botchat:test` (android/) |
| The Mac harness: iOS's 44 checks + A1-A5, real GGUF, the mock | `node android/test/native/lm-harness.mjs [--no-model]` |
| Instrumented tests (emulator or phone) | `ANDROID_SERIAL=<serial> ./gradlew :llm:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.mock=http://127.0.0.1:47591/v1/messages` (android/; with `node web/test/lm/mock-claude.mjs --port 47591` and `adb reverse tcp:47591 tcp:47591`); add `-Plc.model=none -Pandroid.testInstrumentationRunnerArguments.model=none` for the build without the model |
| Lint | `./gradlew :app:lintDebug` (android/) |
| Smoke: boot, login, walk, Save now, Back, HOME, activity recreation, settings, trim, rotation, renderer crash and the crash-loop screen, no WebView after a crash, 25 bots, an update while on screen, the WebView floor (and its screen checking again) | `node android/test/smoke.mjs [--serial S] [--no-build] [--no-install] [--only phases] [--skip phases]` |
| Keyboard: Gboard key taps (its landscape layout on the AVD) and `adb shell input` hardware keys on the real app, through `keyboard-state`, the native log and the calls that reach `LostCityHost.keyboard` | `node android/test/keyboard.mjs [--serial S] [--no-build] [--only idle,login,chat,dismiss,amount,hardware,focus,cutout]` |
| Shell: haptics (dumpsys vibrator_manager), audio (focus, the ringer ignored, a call), the cover against the page pixel for pixel and the filmed hand-over, the Files provider and DocumentsUI, the icon | `node android/test/shell.mjs [--serial S] [--no-build] [--only haptics,audio,cover,provider,files,icon]` |
| The chat model in the real app (`model`: status, Settings › Bot chat, the warm-up, real replies, the key's box and the focus lend, Claude online against the mock, thermal, unloads; `release`: the R8 build with a probe; `none`: `-Plc.model=none`) | `node android/test/lm.mjs [--serial S] [--no-build] [--only model,release,none] [--mock-port 47591]` |
| The pixel snap on the device's own screen | `node android/test/crisp.mjs [--serial S] [--no-build] [--no-install]` |
| Everything on one device, one build (JVM, smoke, keyboard, shell, lm `--only model`, drive, app-test; a summary table in `android/build/all/`) | `node android/test/all.mjs [--serial S] [--quick] [--no-build] [--only a,b] [--skip a,b] [--bots N] [--instrumented]` |
| The in-app test: the same `autotest.js` run as the iPhone's app-test, and the chat model's bench under load (`--lm-bench[=MIN] [--lm-think]`) | `node android/test/app-test.mjs [--serial S \| --device [serial]] [--bots N] [--lm-bench[=MIN]] [--lm-think] [--keep-data] [--no-build]` |
| The native layer: iOS's drive.mjs / drive-hw.mjs page with Android's meanings; `android/test/PARITY.md` maps every iOS check | `node android/test/drive.mjs [--serial emulator-S] [--no-build] [--start-phase P]` |
| The page as Android runs it, in desktop Chrome | `node web/test/e2e.mjs --platform android`, `node web/test/hud.mjs --platform android`, `node web/test/gallery/gallery.mjs --platform android` |

Each device test writes its screenshots and `results.json` to `android/build/<test>/`. On the AVD Gboard shows beside
its hardware keyboard whatever `show_ime_with_hard_keyboard` says, so keyboard.mjs's bar-only checks disable every IME
for a moment (put back at the end, with the setting); uiautomator cannot see the IME window, so the test taps Gboard by
its measured layout. The test scripts stop the app before they install it (`d.install`): Android 17 otherwise swaps an
app updated on screen for a placeholder and relaunches it, which can race the test's own launch.

How the test tools work:

- **`node android/test/all.mjs [--serial S] [--quick] [--no-build] [--only a,b] [--skip a,b] [--bots N]
  [--instrumented]`** builds the debug APK once and runs, on one device: the JVM tests (`:app:testDebugUnitTest
  :botchat:test`), smoke, keyboard, shell, lm (`--only model`), drive and app-test, with a summary table
  (`android/build/all/summary.txt`, `.json`; every step's output in `<step>.log`). `--quick`: build, JVM, smoke.
  `--instrumented` adds `:llm:connectedDebugAndroidTest` with the mock. drive and app-test build their own test
  variants and put the normal build back, so the order never installs a test variant where the next test expects the app.
- **`node android/test/app-test.mjs [--serial S | --device [serial]] [--bots N] [--lm-bench[=MIN]] [--lm-think]
  [--profile P] [--keep-data] [--no-build] [--debug-web] [--pack] [--keep-test-build]`**: web/test/app-test.mjs's twin.
  The debug APK with the autotest web variant (`:app:buildWeb -PwebAutotest`, autotest.json and the profile in the
  bundle) is copied to `android/build/app-test/app-autotest.apk`; the same `autotest.js` run plays (boot, native
  keyboard login, walk, World map, save, background 5 s / 25 s through the Settings app, dropped connection, reload,
  re-login, memory warning, Saved data; the bots' checks; the chat model's bench). The page's `LCTEST` lines reach
  logcat through the console bridge (debug and release builds); logcat entries cut at 4,000 characters are joined again,
  and the bench's samples and summary come from the app's log file. Memory: `dumpsys meminfo` of the app and of the
  renderer its SandboxedProcessService binding names. At the end the normal debug APK is installed again. Output:
  `android/build/app-test/<emulator|device>-<time>/`.
- **`node android/test/drive.mjs [--serial emulator-S] [--no-build] [--start-phase P]`**: web/test/native/drive.mjs's
  and drive-hw.mjs's twin: the same `web/test/native/game-test` page (its `ANDROID` branches check Android's meaning
  where the contract differs) in a debug APK built `-Plc.model=none`, the markers from logcat, the renderer crashed and
  ended over CDP, real key events with `adb shell input keyevent`, the mock behind `adb reverse`. Emulators only (it
  clears the app's data). `android/test/PARITY.md` maps every iOS check to its Android test.
- **`lib/testbuild.mjs`**: a test variant of the web bundle built into the debug APK without being left in
  `android/build/web/Game` or `app-debug.apk` (the normal ones are set aside for the build and put back before the run;
  an interrupted build is put right by the next).

## 8. Not yet verified on a phone

Everything above was checked on the emulator. What only a phone can show, and has not been checked on one yet: the IME heights, OEM keyboards and voice typing (composing
IMEs), a hardware keyboard attached while typing and the gesture-navigation swipe-down; the 560 dp threshold and Gboard's
full-screen editor in the key's box; the haptic scales and the Touch feedback intensity levels; the chat model's timings,
memory, threads (2/3/4) and the SEVERE thermal threshold; the crisp snap on a phone's own screen, such as a Pixel 10's
2424×1080 with its camera hole (crisp.mjs); Auto Backup (bmgr), a full disk (ENOSPC) and a failed main-frame load (not provoked on the emulator
either). The chat model's bench (`app-test.mjs --lm-bench`) runs on the emulator, but its numbers only mean something
on the phone.
