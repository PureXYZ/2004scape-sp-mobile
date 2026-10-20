# Native-layer parity: iOS checks → Android tests

Every check of the iOS app's native-layer harness, `web/test/native/drive.mjs` (the test page
`web/test/native/game-test/test.js` on the simulator) and `web/test/native/drive-hw.mjs` (real hardware keys), with the
Android test that covers it. The page is shared: `android/test/drive.mjs` runs the same `test.js` in the Android app (a
debug APK whose web bundle is the test page, built without the chat model as the simulator has none), so almost every
row is the same check by the same name. Where the platforms differ by contract, `test.js` checks Android's meaning on
Android (its `ANDROID` branches; the iOS path is unchanged) and the row says what that meaning is.

On Android `drive.mjs` makes every check of the iOS run plus the checks only Android has: those of the header
transport (§3.2 of docs/ANDROID.md), and the ones the driver makes itself (the crash loop's error screen and its Try
again, a real renderer crash noticed in the background and in front).

Legend for the Android column:

| Mark | Meaning |
|---|---|
| **drive** | `node android/test/drive.mjs`: the same check, the same expectation |
| **drive (A)** | the same check with Android's meaning (the Notes column) |
| `JVM Class.test` | `./gradlew :app:testDebugUnitTest` (`android/app/src/test`) or `:botchat:test` |
| `smoke:phase` | `node android/test/smoke.mjs` (the real game page) |
| `keyboard:phase`, `shell:phase` | `node android/test/keyboard.mjs`, `node android/test/shell.mjs` |
| `lm:phase` | `node android/test/lm.mjs` (the chat model in the real app) |
| `inst Class.test` | `./gradlew :llm:connectedDebugAndroidTest` (on the emulator, with the mock) |
| `lm-harness` | `node android/test/native/lm-harness.mjs` (the bots' chat port on the Mac JVM) |

What differs by contract, once (docs/ANDROID.md §3, §4):

- Page → native: `LostCityNativeBridge` (one WebMessageListener) instead of `window.webkit.messageHandlers`; native →
  page: `window.__lcCall(id, path, args)` (the test page defines it on Android, as host.js does in the game).
- Writes: the router never sees a request body, so the bytes go base64url in `X-LC-Body` with `X-LC-Length` (the page's
  `writeInit`, the worker's `xhr`). A raw body is what WebKit's dropped Blob body is on iOS: a write of nothing, 400.
- Origin `https://appassets.androidplatform.net` instead of `lostcity://game`.
- Keyboard traits are the EditorInfo's: inputType `0x80091` (TEXT | VISIBLE_PASSWORD | NO_SUGGESTIONS) or `2`
  (NUMBER) for iOS's keyboardType 1 / 11; IME action Send `4`, Go `2` for returnKeyType 7 / 1; inputView `"none (hardware
  only)"` for iOS's `"empty…"`. Gboard is shown beside the AVD's hardware keyboard (`show_ime_with_hard_keyboard`).
- The chat model: the simulator has none (reason `simulator`); the Android test APK is built `-Plc.model=none` (reason
  `no-model`), so every lm row checks the same answers.
- The loading cover's zoom includes host.js's crisp snap (8/7 on the AVD at 2.625), and its frames follow Chromium's
  layout px (box edges rounded before the zoom): sizes within two layout px after the zoom (under a device px), not
  0.01 dp.
- Backgrounding opens the Settings app (`am start -a android.settings.SETTINGS`), as the iOS driver opens Settings; the
  game comes back with `am start` (singleTask: the same activity). onPause → pause, onStop → background (deduplicated),
  onStart → foreground, onResume → resume (deduplicated).
- WebContent killed: the AVD has no root, and the renderer is an isolated process, so the driver ends it through DEBUG
  hooks over CDP: `renderer-crash` (chrome://crash: a real crash, didCrash true, as iOS's SIGKILL) for the background and
  front kills, `renderer-kill` (WebViewRenderProcess.terminate()) for the third.
- Terminate: Android has no blocking `willTerminate`; DEBUG `terminate` starts (or joins) the flush and answers when it
  settles (docs/ANDROID.md §3.4), so "inside the nested run loop" means "the flush ends, under 3 s".
- Hardware keys: `adb shell input keyevent` (the system's input pipeline, a virtual hardware keyboard) instead of System
  Events keystrokes into the Simulator.

## Phase "routes" (ARCHITECTURE.md §3: the router)

| # | iOS check | Android | Notes |
|---|---|---|---|
| 1 | loading cover at the page's zoom (1): 444×142 logo, 304×34 bar, 16 pt text, centred | **drive (A)**, `JVM CoverGeometryTest.theLoaderOnTheAvd`, `shell:cover` | zoom 8/7 (the snap); sizes within 2 layout px; shell.mjs compares the cover with the page pixel by pixel |
| 2 | native.injected | **drive (A)**, `smoke:boot` | platform `android` |
| 3-23 | mime `/`, `/index.html`, `/index.html?x=1`, `/t/a.js`, `/t/a.mjs`, `/t/mod.js`, `/t/UPPER.JS`, `/engine/worker.js`, `/t/a.wasm`, `/t/a.json`, `/t/a.map`, `/t/a.css`, `/t/a.png`, `/t/a.html`, `/t/a.txt`, `/t/with%20space.txt`, `/crc`, `/title410306098`, `/t/a.dat`, `/t/a.sf2`, `/t/main_file_cache.idx0` (21 checks: status, type, `no-store`, Content-Length = body) | **drive** (each), `JVM AssetRouterTest.mimeTable`, `.bundleFilesWithTheirTypes`, `.everyResponseCarriesTheHeadersAndAReason` | found a bug: the page saw `Content-Length: 1257, 1257` (Chromium adds its own from the stream's available(); fixed in GameWebViewClient.response) |
| 24 | head bundle file | **drive**, `JVM AssetRouterTest.headGivesTheLengthOnly` | was `0, 8388731` before the fix (HEAD's stream now reports the length) |
| 25 | head missing → 404 | **drive**, `JVM AssetRouterTest.missingFoldersAndBadPaths` | |
| 26-43 | GET /missing.js → 404, GET /t/ → 404, GET /t → 404, GET /save → 404, GET /save/ → 400, GET /save/..%2Fescape.sav → 400, GET /save/%2Fetc%2Fpasswd → 400, GET /save/a//b.sav → 400, GET /save/.hidden → 400, GET /save/x%00y → 400, GET /save/a%5Cb → 400, PUT /save/..%2F..%2Fescape.sav → 400, PUT /save/players/%2E%2E%2Fx → 400, PUT /t/a.js → 405, GET /log → 405, POST /save-index → 405, GET /save/players/none/nobody.sav → 404, DELETE /save/players/none/nobody.sav → 404 (18 checks) | **drive** (each), `JVM AssetRouterTest.missingFoldersAndBadPaths`, `.onlyGetAndHeadForBundleFiles`, `.saveStatusesAndTexts`, `.percentDecodingIsStrictAndOnce`, `SaveStoreTest.pathRulesMatchIos`, `.invalidPathsAreRefusedByEveryOperation` | |
| 44 | classic scripts | **drive** | |
| 45 | module import .mjs | **drive** | |
| 46 | module import .js | **drive** | |
| 47 | wasm instantiateStreaming | **drive** | |
| 48 | save PUT v1 → 204 | **drive (A)**, `JVM AssetRouterTest.saveRoundTripThroughTheHeader`, `smoke:save` | through X-LC-Body |
| 49 | save GET v1 | **drive** | |
| 50 | save no .bak after first write | **drive**, `JVM SaveStoreTest.firstWriteThenBackupThroughTheSwap` | |
| 51 | save PUT v2 (ArrayBuffer) → 204 | **drive (A)** | |
| 52 | save GET v2 | **drive** | |
| 53 | save .bak = v1 | **drive**, `JVM SaveStoreTest.firstWriteThenBackupThroughTheSwap` | on the device: renameat2(RENAME_EXCHANGE) through JNI |
| 54 | save PUT v2 again → 204 | **drive (A)** | |
| 55 | save identical write keeps .bak = v1 | **drive**, `JVM SaveStoreTest.unchangedBytesAreSkippedAndKeepTheBackup` | |
| 56 | save POST v3 → 204 | **drive (A)** | |
| 57 | save .bak = v2 after v3 | **drive** | |
| 58 | save HEAD | **drive** | the Content-Length fix as row 24 |
| 59 | save-index entry | **drive**, `JVM AssetRouterTest.saveIndexIsSortedJsonWithUnescapedSlashes` | |
| 60 | save-index lists .bak | **drive**, `JVM SaveStoreTest.indexListsRegularFilesSortedWithoutHiddenOnes` | |
| 61 | save-index has no hidden/temp files | **drive**, `JVM SaveStoreTest.indexListsRegularFilesSortedWithoutHiddenOnes` | |
| 62 | save DELETE → 204 | **drive**, `JVM AssetRouterTest.deleteKeepsABackup` | |
| 63 | save GET after delete → 404 | **drive** | |
| 64 | save deleted file kept as .bak | **drive**, `JVM SaveStoreTest.deleteKeepsABackupAndDeletingTheBackupRemovesIt` | |
| 65 | save DELETE again → 404 | **drive** | |
| 66 | save PUT onto a directory → 400 | **drive (A)**, `JVM SaveStoreTest.emptyWritesAndFoldersAreRefused` | |
| 67 | save Blob body → 400 (WebKit drops Blob bodies) | **drive (A)**: "save a body without X-LC-Body (the router never sees bodies) → 400" | the same failure on each platform: native cannot read the body |
| 68 | save empty body → 400 | **drive (A)**, `JVM SaveStoreTest.emptyWritesAndFoldersAreRefused` | `X-LC-Length: 0` |
| 69 | save string body → 204 | **drive (A)** | UTF-8 bytes in X-LC-Body |
| 70 | save string readback | **drive** | |
| 71 | save 1 MB PUT | **drive (A)** | 1.4 MB of base64url in one header |
| 72 | save 1 MB readback | **drive** | |
| 73 | worker.location | **drive (A)** | `https://appassets.androidplatform.net/engine/worker.js` |
| 74 | worker.noWebkit | **drive (A)** | no `webkit`, `lcAndroid` or `LostCityNativeBridge` in a worker |
| 75 | worker.syncGET.missing404 | **drive** | |
| 76 | worker.syncPUT.arraybuffer | **drive (A)** | sync XHR with X-LC-Body, as the engine's runtime/xhr.ts |
| 77 | worker.syncGET.readback | **drive** | |
| 78 | worker.syncPUT.uint8array | **drive (A)** | |
| 79 | worker.syncGET.bakIsPrevious | **drive** | |
| 80 | worker.syncGET.current | **drive** | |
| 81 | worker.syncPUT.x50 | **drive (A)** | the average per PUT is in the detail |
| 82 | worker.syncGET.big8MB | **drive** | |
| 83 | worker.log.syncPOST | **drive (A)**, `JVM AssetRouterTest.logTakesTheHeaderOrTheQuery` | |
| 84 | worker.log.asyncPOST | **drive (A)** | |
| 85 | page POST /log → 204 | **drive (A)** | |
| 86 | big file 8 MB, every byte | **drive** | |
| 87 | aborted requests (WKURLSchemeTask stop) | **drive** | Chromium cancels reading the stream |
| 88 | 60 parallel requests after aborts | **drive** | |
| 89 | blocked external navigation leaves the page running | **drive (A)** | the origin stays `https://appassets.androidplatform.net`; `JVM AssetRouterTest.otherHostsAreForbidden` for fetches |
| 90 | haptics survived | **drive**, `shell:haptics` (every style played, in dumpsys vibrator_manager), `JVM HapticsTest.*` | the AVD has a real HAL vibrator: shell.mjs checks they are played |
| 91 | status ingame → idle timer disabled | **drive**, `smoke:login` (in the world: the screen kept on), `smoke:recreate` | |
| 92 | status title → idle timer enabled | **drive** | |
| 93 | memory warning reaches the page | **drive**, `smoke:memory` (a real `am send-trim-memory`) | |
| 94 | settings stored natively | **drive**, `smoke:settings`, `JVM NativeSettingsTest.*` | |

Android only, in this phase (**drive**): `save header transport: X-LC-Length missing → 400`, `… not a count → 400`,
`… above 32 MiB → 413`, `… X-LC-Body padded → 400`, `… with + and / (base64, not base64url) → 400`, `… decoded size
not X-LC-Length → 400`, `… the refused writes left the save and its .bak alone` (also `JVM
AssetRouterTest.badHeaderBodiesAreRefusedLikeServeMjs`, `.theDecoderAlone`, `.headerNamesAnyCase`).

## Phase "keyboard" (ARCHITECTURE.md §7 keyboard; docs/ANDROID.md §4.1)

| # | iOS check | Android | Notes |
|---|---|---|---|
| 95 | settings injected after reload | **drive**, `smoke:settings` | |
| 96 | kbd idle: first responder, no software keyboard | **drive (A)**, `keyboard:idle` | inputView "none (hardware only)" |
| 97 | kbd show chat: system keyboard requested | **drive**, `keyboard:chat` | Gboard shown |
| 98 | kbd chat traits: asciiCapable, Send, not secure | **drive (A)**, `keyboard:chat`, `JVM KeyboardBridgeTest.perKindTables` | inputType 0x80091, IME action Send (4) |
| 99 | kbd insertText reaches page in order | **drive**, `keyboard:chat` (Gboard taps) | |
| 100 | kbd bar shows typed text | **drive** | |
| 101 | kbd deleteBackward + insertText + submit | **drive** | |
| 102 | kbd event sequence | **drive** | |
| 103 | kbd bar cleared after submit (host update) | **drive** | |
| 104 | kbd login-user: Go key, "Log in" | **drive (A)**, `keyboard:login` | IME action Go (2) |
| 105 | kbd login-pass: masked, not secure entry, Go key | **drive (A)**, `keyboard:login` | never a password inputType |
| 106 | kbd login-pass: echo stays masked | **drive** | |
| 107 | kbd numeric: asciiCapableNumberPad | **drive (A)**, `keyboard:amount` | TYPE_CLASS_NUMBER (2) |
| 108 | kbd bar submit button → submit() | **drive** | |
| 109 | kbd hide: idle, still first responder, keyboard gone | **drive (A)** | |
| 110 | kbd hide by page: no dismissed() | **drive**, `JVM KeyboardBridgeTest.onlyTheUsersHideIsDismissed` | |
| 111 | kbd user dismissal → dismissed() once | **drive**, `keyboard:dismiss` (system Back, Gboard's hide key) | the bar's chevron here |
| 112 | kbd after user dismissal: idle | **drive** | |
| 113 | hw ArrowLeft down/up | **drive**, `keyboard:hardware` (adb keyevents) | DEBUG `key`: a synthetic KeyEvent through the view |
| 114 | hw Backspace auto-repeat then up | **drive**, `keyboard:chat` (a held Backspace), `JVM KeyboardBridgeTest.heldBackspaceRepeatsAsIos` | |
| 115 | hw F5 | **drive** | |
| 116 | charset chat: { \| } ~ refused outside a :: command | **drive**, `JVM KeyboardBridgeTest.everyCharset` | |
| 117 | charset chat: { \| } ~ taken in a :: command | **drive**, `keyboard:chat` | |
| 118 | charset chat: the line the page reported counts | **drive**, `JVM KeyboardBridgeTest.theFilterCountsTheLineAsItGrows` | |
| 119 | charset text (private message): ASCII up to z, even after :: | **drive** | |
| 120 | charset alnum (report): letters, digits and space | **drive** | |
| 121 | charset game (password): the client's CHARSET, £ included | **drive** | |
| 122 | charset name: letters, digits, space, - and _ | **drive**, `keyboard:login` (a refused '.') | |
| 123 | unknown charset: takes anything | **drive** | |
| 124 | chip ::~bank on a chat line: replaces the line, keeps the ~ | **drive**, `keyboard:chat` (the '::' chip), `JVM KeyboardBridgeTest.chipsReplaceTheLineAndMaySubmit` | |
| 125 | paste: line breaks become spaces, filtered, never submitted | **drive**, `keyboard:chat` (paste, Ctrl+V), `JVM KeyboardBridgeTest.quotesAndDashesBecomeAscii` | |
| 126 | paste: cut to 80 characters with no maxLength, the rest refused | **drive**, `JVM KeyboardBridgeTest.pasteIsOneLineOfAtMost80` | |
| 127 | paste with no keyboard requested: cut to 80, filtered as chat | **drive** | |
| 128 | paste with no keyboard requested: a :: command keeps its ~ | **drive** | |
| 129 | chat Send: the bar empties at once and the next letters fit | **drive**, `keyboard:chat`, `JVM KeyboardBridgeTest.returnSubmitsAndTheChatBarEmptiesAtOnce` | |
| 130 | chat Send: the page's reports agree | **drive** | |
| 131 | login Send: the line stays until the page reports it | **drive** | |
| 132 | chat Send that the game ignores: the line comes back | **drive** | |
| 133 | hardware Enter on the chat line: the same | **drive**, `keyboard:hardware` | |
| 134 | Vibration off: no native haptics (refused key, fatal), the bar still flashes | **drive**, `shell:haptics` | |
| 135 | Vibration on (the default): warning for a refused key, error for a fatal error | **drive**, `shell:haptics` | |

## Phase "lm" (ARCHITECTURE.md §7.1; docs/ANDROID.md §5)

| # | iOS check | Android | Notes |
|---|---|---|---|
| 136 | lm: LostCityNative.lm at document start: no on-device model on the simulator, no key | **drive (A)** "… in a build without the model …", `lm:none`, `lm:model` (with the model) | reason `no-model` |
| 137 | lm: the status says whether the on-device model writes its note: never here | **drive (A)**, `lm:none`, `lm:model` (offered with the hybrid model) | |
| 138 | lm: drive.mjs runs the mock Messages API | **drive** | the mock behind `adb reverse` |
| 139 | lm: {type:lm-key, action:set} opens a native alert ("Claude API key") with a secure field holding the keyboard | **drive**, `lm:model` (the real box: uiautomator, FLAG_SECURE, typed with `input text`), `inst BotChatDeviceTest.theKeysSecureBox` | KeyEntryDialog |
| 140 | lm: Save keeps the key: the status says set, ends in …abcd, and never carries the key | **drive**, `lm:model`, `inst KeyStoreDeviceTest.savesReadsAndRemoves` | AndroidKeyStore-wrapped file |
| 141 | lm: after the alert the keyboard bridge is first responder again | **drive**, `JVM LmHostTest.focusIsLentForTheBoxAndTakenBackOnce` | |
| 142 | lm: online: Claude's line through LostCityHost.bots.lmReply ({id, text, source, ms}) | **drive**, `lm:model`, `inst BotChatDeviceTest.claudeOnlineThroughTheMock` | |
| 143 | lm: local on the simulator: null, unavailable, at once | **drive (A)**, `lm:none` | |
| 144 | lm: online with think: Claude's line, as without it | **drive**, `lm-harness` | |
| 145 | lm: local with think on the simulator: null, unavailable, at once | **drive (A)**, `lm:none` | |
| 146 | lm: the Test (no fallback) with a good key: Claude's line | **drive**, `lm:model` (Bot chat › Test) | |
| 147 | lm: Cancel keeps the key as it was (…abcd) | **drive**, `lm:model` | |
| 148 | lm: a refused key (401): null, refused (no on-device fallback here); the status says key refused | **drive**, `lm:model` (with the model: the fallback answers), `JVM BotChatModelTest.aRefusedKeyFallsBackAndSaysSo` | |
| 149 | lm: what cannot be a key is refused: the key stays, the status says "not a key" | **drive**, `lm:model` (+ the error haptic) | |
| 150 | lm: 4 requests at once: the fourth is busy at once, the others time out (a slow API) | **drive**, `JVM BotChatModelTest.theFourthAtOnceIsBusyInsideHandle` | |
| 151 | lm: Think first kept by native ({type:settings} botThink: true) | **drive** | |
| 152 | lm: after a reload LostCityNative.lm has the key's status (…zzzz) | **drive**, `lm:model` | |
| 153 | lm: after a reload Think first is still On (LostCityNative.settings.botThink) | **drive**, `lm:model` | |
| 154 | lm: and back to the default (null removes it) | **drive** | |
| 155 | lm: {type:lm-key, action:remove} deletes the key: the status says not set | **drive**, `lm:model` (Remove with its confirm box) | |

## Phases "lifecycle", "crash-bg", "crash" (ARCHITECTURE.md §7 lifecycle, WebContent termination; docs/ANDROID.md §3.4, §4)

| # | iOS check | Android | Notes |
|---|---|---|---|
| 156 | terminate flush completes inside the nested run loop | **drive (A)**, `JVM LifecycleCoordinatorTest.*` | no blocking terminate on Android: the flush ends, under 3 s |
| 157 | terminate then resume | **drive** | |
| 158 | lifecycle: came back to foreground | **drive (A)**, `smoke:home` | the Settings app in front for 5 s |
| 159 | lifecycle cycle: exactly pause then foreground | **drive**, `smoke:home`, `JVM LifecycleCoordinatorTest.pauseThenBackgroundSendsOneFlush`, `.onlyTheFirstResumeIsSent` | |
| 160 | lifecycle cycle: save written via sync XHR | **drive (A)** | |
| 161 | lifecycle hang: came back to foreground | **drive (A)** | 12 s in the background |
| 162 | lifecycle hang: pause sent once, foreground after timeout | **drive**, `JVM LifecycleCoordinatorTest.theFlushTimesOutAfterEightSecondsAndALateAnswerIsIgnored` | |
| 163 | crash-bg: page restarted after WebContent died in the background | **drive (A)** | DEBUG renderer-crash (chrome://crash) in the background |
| 164 | crash-bg: restarted while visible | **drive** | |
| 165 | crash: page reloaded by native after WebContent termination | **drive (A)**, `smoke:crash` (renderer-kill) | renderer-crash in front |
| 166 | crash: settings still injected | **drive** | |
| 167 | crash: keyboard state reset | **drive**, `JVM KeyboardBridgeTest.aPageResetForgetsEverything` | |
| (only on failure) | crash-bg: WebContent was killed / crash: WebContent was killed / phase X threw / worker.load | **drive** | the same lines, if the kill never comes |
| (drive.mjs: the screenshot only) | the third WebContent death in two minutes: "tap to try again" (kill-webcontent-loop) | **drive** (driver checks): "crash loop: the third renderer death in two minutes (this one terminate(), not a crash) stops at the error screen with Try again", "crash loop: Try again reloads the page"; `smoke:crashloop` | uiautomator sees cover_retry and "Try again" |

Android only (driver checks, **drive**): "crash-bg: a real renderer crash in the background is noticed there (no reload
until the app is back)", "crash: a real renderer crash in front is noticed (crash=true, the app visible)".

## drive-hw.mjs: real hardware keys (phase "hwkeys")

| # | iOS check | Android | Notes |
|---|---|---|---|
| 168 | hw idle: characters arrive via insertText | **drive (A)**, `keyboard:hardware` | `adb shell input keyevent`: a b ← Esc F1 ⌫ ↩ ⇥ |
| 169 | hw idle: ← Esc F1 ⌫ ↩ ⇥ arrive via pressKey down+up | **drive (A)**, `keyboard:hardware` (+ Tab, Control, Home, PageDown, a held arrow) | |
| 170 | hw idle: no duplicate deleteBackward/submit | **drive (A)** | |
| 171 | hw shown: characters via insertText | **drive (A)**, `keyboard:hardware` (the bar only, no IME) | with Gboard up |
| 172 | hw shown: ⌫ ↩ via pressKey | **drive (A)** | |

## What drive.mjs does besides checks, and the rest of web/test/native

| iOS | Android |
|---|---|
| The launch burst (6 screenshots over 1.5 s: launch screen → black → cover) | **drive** (the same burst); `shell:cover` films the launch screen frame by frame and checks it has no icon |
| The mock API's requests all well-formed (a malformed one fails the run) | **drive** (the same rule), `lm:model`, `inst BotChatDeviceTest.claudeOnlineThroughTheMock` |
| The Documents tree and the app's logs copied at the end | **drive** (`run-as … find files/Documents`, the app's log file pulled) |
| `web/test/native/lm-harness.mjs` (the Swift chat model on the Mac: 49 checks) | `node android/test/native/lm-harness.mjs`: the same 49 + A1-A5 on the Kotlin port |

## Not covered on Android

Nothing of the iOS checks is uncovered. Weaker than iOS, and why:

- The renderer is ended through DEBUG hooks (chrome://crash, terminate()), not killed from outside as iOS's `kill -9`:
  without root an isolated process cannot be signalled. A low-memory kill by the system (lmkd) is not provoked.
- Hardware keys come from adb's virtual keyboard device, not a USB/Bluetooth keyboard (the AVD's own QEMU keyboard is
  the same input path; a real keyboard has not been tried yet).
- Terminate is a DEBUG event: Android sends nothing when a process is killed, so there is no real terminate to test
  (the onPause/onStop flush is the guarantee, docs/ANDROID.md §3.4).
- The haptics the page sends are played and recorded (`shell:haptics`), but not felt: tuning waits for a phone.

## The in-app test (web/test/app-test.mjs + autotest.js)

`node android/test/app-test.mjs` runs the same `autotest.js` in the Android app (boot, native-keyboard login, walk,
World map, save, background 5 s and 25 s, dropped connection, reload, re-login, memory warning, Saved data; with bots
their checks; `--lm-bench` the chat model under load), so its checks are the iOS ones by name. Android differences are
in the driver only (Settings app for the background, dumpsys meminfo for memory, logcat for the page's console).
