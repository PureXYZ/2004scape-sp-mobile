# The iOS app's native layer (`ios/LostCity/`)

The Swift side of the iPhone app (`LostCity` is the target's code name; the app is called 2004Scape). It hosts one `WKWebView` that runs the web client (the
page) and the engine (a module Web Worker in the same page), serves everything from the app
bundle through a custom URL scheme, keeps saves in Documents, and provides the native pieces of
the page contract. The contract is `docs/ARCHITECTURE.md` §3 (routes) and §7 (page ↔ native);
this file describes how the native layer implements it and where it goes beyond it.

## Files

| File | What |
|---|---|
| `AppDelegate.swift` | Line-buffers stdout first thing; turns off shake-to-undo |
| `SceneDelegate.swift` | UIScene lifecycle (required by the iOS 27 SDK); black window |
| `GameViewController.swift` | WKWebView setup and hardening, user scripts, `native`/`log` message dispatch, status, fatal handling, crash recovery, debug hooks |
| `AssetSchemeHandler.swift` | `lostcity://game/*`: bundle files, `/save`, `/save-index`, `/log` |
| `SaveStore.swift` | Atomic writes with `.bak`, path validation, index |
| `PageBridge.swift` | Native → page: `LostCityHost.<path>(…)` via `callAsyncJavaScript` |
| `LifecycleCoordinator.swift` | App lifecycle → `LostCityHost.lifecycle(event)`, background tasks |
| `KeyboardBridge.swift` | Hidden first-responder `UIKeyInput` view; soft and hardware keyboard; input limits, paste, chips; the keyboard's covered height for the page |
| `KeyboardAccessoryBar.swift` | Prompt, live text, chips, Cancel, submit and hide buttons above the keyboard, in the 2004 look |
| `RSTheme.swift` | The 2004 look for native views: registers the game's fonts from `Game/ui/fonts` (CoreText, process scope), loads `Game/ui/sprites`, colours; falls back to system fonts if the files are missing |
| `Haptics.swift` | `{type:'haptic'}` with prepared feedback generators |
| `NativeSettings.swift` | `{type:'settings'}` → UserDefaults; `AppInfo` for `window.LostCityNative` |
| `LoadingOverlay.swift` | The launch cover, a pixel copy of the page's own loader (logo, red bar, caption) at the page's zoom (host.js `layout()`'s `--ui-zoom`: 1 on an iPhone, ×1.5 or ×2 on an iPad), so the hand-over does not show; the 2004 error screen ("Error - unable to continue!", Try again) for a failed load or a crash loop; short `Notice` toasts (yellow game text on black) |
| `Log.swift` | stdout + `Library/Caches/Logs/lostcity.log` |
| `BotChatModel.swift` | **Bots**: the chat model's router (`{type:'lm'}` → `LostCityHost.bots.lmReply`): Claude online, then the on-device model, then nothing; at most 3 at once; the request's `think` (Think first) to the on-device model; the status (`lmStatus`, `LostCityNative.lm`, with the model's note support `local.think`); `DeviceStats` (phys_footprint, `os_proc_available_memory`, thermal state) |
| `LocalModel.swift` | **Bots**: the on-device model: llama.cpp (Metal) on `Model/` (its `model.json` and GGUF), lazy load, one generation at a time on its own queue, unload when idle, on a memory warning and in the background; the note before the reply as the template says (`ThinkSupport`: never, always, or when the request asks) |
| `OnlineModel.swift` | **Bots**: Claude through the Messages API (URLSession, 8 s), the request as the official docs give it (URLs in the file) |
| `ModelKeyStore.swift` | **Bots**: the Claude key in the Keychain (`AfterFirstUnlockThisDeviceOnly`); the page only learns whether one is set and its last four characters |
| `Assets.xcassets/LaunchBackground` | Black launch screen colour (`ios/Config/Info.plist` → `UILaunchScreen.UIColorName`) |

The `LostCity/` folder is a synchronized group, so new `.swift` files compile without editing the
project. `ios/Config/Info.plist` also sets `UIUserInterfaceStyle = Dark` (dark keyboard and alerts,
black launch screen even without the colour asset).

## Routes (`AssetSchemeHandler`)

| Method | Path | Result |
|---|---|---|
| GET / HEAD | `/<file>` | Bundle `Game/<file>`; `/` and `dir/` map to `index.html`; 404 if missing; 405 for other methods |
| GET / HEAD | `/save/<relpath>` | `Documents/<relpath>`: 200 `application/octet-stream`, or 404 |
| PUT / POST | `/save/<relpath>` | Atomic write: 204. An empty body gets 400 (see below). An I/O error gets 500 |
| DELETE | `/save/<relpath>` | 204, or 404 if missing. The deleted file is kept as `<relpath>.bak` |
| GET / HEAD | `/save-index` | `[{path, size, modified}]`, sorted by path. `modified` is in **milliseconds** since 1970. Hidden files are left out; `.bak` files are included |
| POST / PUT | `/log` | Body lines go to the native log, tagged `[worker]`. Optional `?src=engine&level=warn` gives `[engine:warn]`. Returns 204 |

The rules that apply to every route:
- **Invalid paths get 400.** For save paths that covers an empty path, an absolute path, `..`, `.`, empty segments, dot-files (reserved for temp files), `\`, NUL and malformed `%` escapes; a PUT onto a directory also gets 400. Bundle paths get 400 for `..`, `.` and empty segments. The path is percent-decoded exactly once, so `..%2F` is caught too.
- **Every response sends `Cache-Control: no-store`.** It also sends `Content-Length`, and HEAD returns that length with no body.
- **MIME types follow ARCHITECTURE.md §3:**
  - `html` → `text/html`, `js`/`mjs` → `text/javascript` (with `; charset=utf-8`)
  - `wasm` → `application/wasm`, `json`/`map` → `application/json`
  - `css` → `text/css`, `png` → `image/png`
  - A few extras: `txt`, `svg`, `jpg`, `gif`, `webp`, `ico`, `wav`, fonts
  - **Everything else, including the extensionless jag archives and `/crc`, is `application/octet-stream`.**
- **WebKit drops Blob request bodies.** So an empty PUT/POST body is refused with 400 rather than truncating a save. Send an `ArrayBuffer` or `Uint8Array`.

### Threading

- **Main thread.** WebKit calls `start` and `stop` here.
- **File I/O never runs on the main thread.** It happens in a detached task.
- **Large files are streamed** in 1 MB chunks, one main-thread turn per chunk.
- **The main thread never waits for JavaScript.** The engine worker's synchronous save XHRs need the main thread free so WebKit can start their scheme tasks.
- **Live tasks are tracked by a private token,** not by object address. Nothing is sent to a task after `stop`, which would raise an exception in WebKit.
- **Responses return through the main run loop** (`CFRunLoopPerformBlock`), not the main dispatch queue. `willTerminate` keeps the last save alive by spinning a nested run loop, and if that happens inside a main-queue block, main-queue work cannot run. This was measured with the debug `terminate` hook: through the main queue, the save XHR waited out the whole 4 s deadline; through the run loop it took 6 ms.

## Saves (`SaveStore`)

- **Atomic writes.** The bytes are written to a hidden temp file next to the target. `renamex_np(RENAME_SWAP)` then exchanges the two in one step, and the swapped-out previous version is renamed to `<file>.bak`. The target is always a complete old or new file. Without APFS swap support, the fallback is a hard-linked `.bak` followed by `rename`.
- **Durability** is the same as `.atomic`: there is no fsync.
- **Unchanged writes are skipped.** Writing identical bytes (for example `pause` followed by `terminate`) would otherwise replace the useful `.bak` with a copy of the current file.
- **One lock serialises all operations.** Temp files older than a minute, left behind by a killed write, are removed at launch.

## Page → native (`webkit.messageHandlers.native`)

| Message | Native behaviour |
|---|---|
| `{type:'ready'}` | Fades the loading cover (0.25 s) once the page has drawn its own identical loader (fonts ready, logo decoded, two frames, 0.8 s at most); re-asserts the keyboard responder. Any `status` does the same |
| `{type:'status', phase, detail?}` | Logged. `ingame` keeps the screen awake (`isIdleTimerDisabled`) while there was a touch, key press or keystroke in the last 5 minutes (`GameWindow` reports touches and presses, `KeyboardBridge` typing), so a phone put down mid-session still locks, which pauses and saves; `ingame` also warms up haptics. Any other phase lets it sleep |
| `{type:'keyboard', action:'show'\|'update'\|'hide', …}` | See [Keyboard](#keyboard) |
| `{type:'haptic', style, intensity?}` | `light` `medium` `heavy` `soft` `rigid` (impact), `selection`, `success` `warning` `error`. Unknown styles play medium. The page sends none while Settings › Vibration is off; the haptics native plays itself (a refused keystroke, `fatal`) check the stored `haptics` setting instead (absent means on) |
| `{type:'settings', values}` | **Shallow-merged** into the stored object; a `null` value deletes the key. Stored in UserDefaults as JSON (max 64 KB). The document-start script is reinstalled, so even a crash reload sees the new values |
| `{type:'fatal', message}` | The page shows its own 2004 error screen with Restart, so native shows nothing: it logs the message, plays the `error` haptic (unless Vibration is off), lets the screen lock and hides the keyboard and any loading cover still up |
| `{type:'lm', id, mode, think, local, online, maxChars, timeoutMs, fallback?}` | **Bots**: `BotChatModel.handle`; the answer comes as `LostCityHost.bots.lmReply` (ARCHITECTURE.md §7.1) |
| `{type:'lm-key', action:'set'\|'remove'}` | **Bots**: `set` presents a `UIAlertController` with a secure field ("Claude API key"; the keyboard bridge gives up first responder while it is up); Save keeps a key that can be one in the Keychain. The page hears a status (`LostCityHost.bots.lmStatus`) |
| `{type:'lm-warm'}` | **Bots**: loads the on-device model in the background (the player entered the world with a model chosen) |
| `{type:'debug', id, action, …}` | DEBUG builds only; see [Testing](#testing) |

The separate `log` handler takes `{level, text}`, printed as `[js:<level>] text`. A document-start
script forwards `console.*`, uncaught errors and unhandled rejections there.

At document start the page also gets `window.LostCityNative`:

```js
{ platform: 'ios', appVersion: '1.0', build: '1', osVersion: '26.5', deviceModel: 'iPhone14,4',
  simulator: false, debug: true, settings: { …last saved values… } }
```

## Native → page (`window.LostCityHost`, via `callAsyncJavaScript`)

- **`lifecycle(event)`** (awaited):
  - `pause` on will-resign-active, `background`, `terminate`, `foreground`, `resume` on did-become-active.
  - A missing host or method counts as success, since a booting page has nothing to save.
  - A failed flush is a rejected promise or a reply of `{ ok: false }` (the page could not write a save, or the engine did not answer in time).
- **`keyboard.insertText(text)`, `keyboard.deleteBackward()`, `keyboard.submit()`.** These come from the soft keyboard and from hardware characters. `insertText` only ever gets text that passed the input limits (below), converted to the game's ASCII.
- **`keyboard.dismissed()`.** Only when the player hides the keyboard with the bar's button, never after a page `hide`.
- **`keyboard.cancel()`.** The bar's Cancel (prompts): native has already hidden the keyboard. If the page has no `cancel`, native calls `dismissed()` instead.
- **`keyboard.frame(overlap, duration)`.** How many points of the web view's bottom the keyboard plus the bar cover (0 when hidden, not requested, floating or off view) and the animation's length in seconds, from will-show, will-change-frame and will-hide, only when it changes. iOS reports 0 s when the page hides the keyboard although it animates for about 0.4 s, so native then sends the last non-zero duration (0.38 s on an iPhone).
- **`keyboard.pressKey(key, down)`.** Hardware keys, using `KeyboardEvent.key` names from `KeyCodes.ts`:
  - `ArrowLeft/Right/Up/Down`, `Escape`, `Tab`, `F1`–`F12`
  - **`Enter` and `Backspace`** (the hardware ones go here, *not* to `submit`/`deleteBackward`), and `Delete`
  - `Home`, `End`, `PageUp`, `PageDown`, `Insert`, `Control`

  Held `Backspace`/`Delete` auto-repeat: repeated `pressKey(key, true)` every 50 ms after 0.4 s, then one `pressKey(key, false)`. All held keys are released when the app resigns active or the page is replaced. **The host should turn `pressKey` into `keydown`/`keyup` events on the canvas** with `{key, code: key}`.
- **`memoryWarning()`.** On `UIApplication.didReceiveMemoryWarningNotification` (the on-device chat model is unloaded too).
- **`bots.lmReply(reply)`, `bots.lmStatus(status)`.** The bots' chat model (ARCHITECTURE.md §7.1). The model stops at its
  next token and unloads when the app resigns active (no GPU work in the background).

## Keyboard

`KeyboardBridge` is a hidden 1×1 `UIKeyInput` view. **It becomes first responder at launch and
never gives it up** (`canResignFirstResponder == false`):

- **Requested** (after `show`): `inputView = nil`, so the system keyboard appears with `KeyboardAccessoryBar` above it. With a hardware keyboard attached, only the bar appears.
- **Idle** (initially, and after `hide` or a user dismissal): `inputView` is an empty view, so nothing appears, but the hardware keyboard still arrives:
  - characters through `insertText`, so UIKit applies the layout, Shift and Option
  - special keys through `pressesBegan`/`pressesEnded` → `pressKey`

  **Hardware keys therefore reach the game regardless of DOM focus.**
- **Why it never resigns.** WKWebView's content view asks for first responder when it is tapped. If it got it, every tap on the game would close the keyboard, and a tap on the chat line would close and reopen it. The page decides instead, by sending `hide` or `show`.

**Traits:**
- No autocorrect, autocapitalisation, spell check, smart quotes/dashes/insert-delete, inline prediction, math completion, Writing Tools or grammar check.
- `.asciiCapable`, or `.asciiCapableNumberPad` when `numeric`. The bar's submit button stands in for the Return key the number pad lacks.
- `keyboardAppearance = .dark`.
- Return key by kind: chat/social **Send**, login-user and login-pass **Go** ("Log in": offline a name is enough, the page fills a password in; the two fields' traits are identical, so switching fields does not reload the keyboard), others **Done**.
- **Passwords never set `isSecureTextEntry`,** which would bring up the iOS Passwords/AutoFill bar. The bar masks them with `*` instead.

**Input limits** (`show`/`update` may carry `maxLength` and `charset`, at most what the client's input code keeps):

| `charset` | Takes | Used for |
|---|---|---|
| `chat` | ASCII 32-122; `{ \| } ~` (123-126) only while the line (its text plus what the same insertion took before) starts with `::` | Public chat |
| `text` | ASCII 32-122 | Private messages |
| `alnum` | Letters, digits and space | Report abuse |
| `game` | The client's `CHARSET`: letters, digits, space, ``!"£$%^&*()-_=+[{]};:'@#~,<.>/?``, `\` and `\|` | The login password |
| `name` | Letters, digits, space, `-` and `_` | The login username, name prompts |
| `digits` | `0`-`9` | Amounts |
| `any`, or a name native does not know | Anything | |

`RSTheme.gameText` first turns curly quotes, dashes and the ellipsis into ASCII; then a character that the charset
refuses or that no longer fits (counted from the bar's text: the page's last report plus keys sent since) is dropped,
with a `warning` haptic (at most every 0.3 s, and none while Settings › Vibration is off) and a red flash of the field.
**Paste** (`paste(_:)`, ⌘V) sends the pasteboard's text through the same filter, line breaks as spaces, never
submitting. It is cut to 80 characters, the longest input the game has (the rest counts as refused), so a big clipboard
cannot flood the page's key queue; with no input requested (⌘V on a hardware keyboard in game, which types into the
chat line) it is filtered as `chat`, counted from an empty line.

**Bar:**
- Prompt in yellow: the page's `prompt`, or a per-kind default.
- Live text with a blinking caret, truncated at the head so the end stays visible.
- **Chips** (`chips: [{label, text, submit?, whenEmpty?}]`, at most 24, also replaced by `update`): 2004 stone buttons in a scrolling row. A chip replaces the input line with its text (Backspaces for the current text, then one `insertText`) and submits if `submit`; a `whenEmpty` chip shows only while the line is empty. The page sends `::` and the recent developer commands for chat, and recent and common amounts for "Enter amount".
- **Cancel** (`cancellable: true`, prompts) hides the keyboard and calls `keyboard.cancel()`.
- A submit button ("Send", "Log in" or "OK") and a hide button.
- Follows the safe area. It is 52 pt tall; the keyboard plus bar is 222 pt of 375 on the iPhone 13 mini in landscape.
- **Keystrokes show immediately (optimistic echo).** The page's `update` text wins once it catches up, or after 0.5 s. `submit` or Enter on the chat line empties the bar at once, so the next message's first letters count from an empty line rather than from the one just sent (the page reports it gone only on its next poll; if Enter did nothing, the line comes back after 0.5 s); on the other inputs it ends the grace period at once.

**For the host page:**
- **Use the native bridge for all text entry.** Because the native view owns first responder, a DOM `<input>` can never get the iOS keyboard.
- **Lay out with `innerHeight`, not `visualViewport`.** While the keyboard is up, WebKit still shrinks `visualViewport` (812×375 → 812×153 on the iPhone 13 mini), but `innerHeight` stays 375. A layout that follows `visualViewport` would make the canvas jump.

## Lifecycle

`LifecycleCoordinator`:
- **One flush at a time.**
- **No double sends.**
  - A suspending event during a flush only keeps the background task alive.
  - After a successful flush, further suspending events are skipped: the world is paused and unchanged.
  - A failed flush is retried by the next suspending event.
  - Only the first of `foreground`/`resume` is sent.
  - **So the host must treat `pause`, `background` and `terminate` alike, and likewise `foreground` and `resume`.**
- **A resume that arrives mid-flush is sent after the flush ends.**
- **The background task always ends:** on the page's answer, after 8 s, or on expiry.
- **`willTerminate`** starts or joins a flush, then spins the main run loop for up to 4 s so the engine's sync save XHR can be served.

## Recovery and appearance

- **WebContent process terminated:**
  - **Visible app:** a "restarting" notice, the overlay, then a reload.
  - **App in the background:** the reload waits until the app is active again.
  - **A third termination within 2 minutes** stops auto-restarting and shows the 2004 error screen with **Try again**.
  - **Page-owned native state is reset** on every new document: keyboard (and its reported covered height), lifecycle and keep-awake.
- **Black from launch to first paint, never white:**
  - black launch screen colour and dark style
  - black window
  - a non-opaque black web view with `underPageBackgroundColor` black
  - the `LoadingOverlay` cover until `ready`, with a 3 s fallback after load (it looks exactly like the page's own loader, which takes over)
  - the 2004 error screen with **Try again** if `index.html` fails to load
- **WKWebView hardening:**
  - Text, selection and links: `isTextInteractionEnabled = false`, `allowsLinkPreview = false`, `dataDetectorTypes = []`, no context menus (the UI delegate returns nil), and WebKit's drag interaction disabled.
  - Navigation and scrolling: no back/forward gestures, no scroll, bounce or zoom, and `contentInsetAdjustmentBehavior = .never`.
  - No element fullscreen, inline predictions, Writing Tools or fraudulent-site lookups.
  - Media capture is denied.
  - `isInspectable = true`.
  - Navigations are limited to `lostcity:`, `about:`, `blob:` and `data:`. A tapped http(s) link opens in Safari.

## Logging

- **stdout is line-buffered,** so every line reaches `devicectl … --console` or `simctl launch --console-pty` as it is written.
- **Line format:** `HH:MM:SS.mmm [tag] message`.
- **Lines are also written to `Library/Caches/Logs/lostcity.log`.** It rotates at 2 MB to `lostcity.1.log` and is flushed every 0.3 s and on background. Fetch it with:

  ```
  xcrun devicectl device copy from --device <udid> --domain-type appDataContainer \
    --domain-identifier io.github.purexyz.scape2004 --source Library/Caches/Logs/lostcity.log --destination .
  ```
- **Verbose mode:** launch with `-LostCityVerbose YES` for every scheme request, keystroke and background task.

## Testing

The simulator harness lives in `web/test/native/` (runs and evidence go to the git-ignored `build/tmp/swift/`):

| File | What |
|---|---|
| `game-test/` | Test page standing in for `Game/`: a fake `LostCityHost`, an engine-like module worker at `engine/worker.js` that does sync-XHR saves and `/log`, and MIME fixtures (`drive.mjs` adds the 8 MB pattern file `t/big.bin`) |
| `drive.mjs` | Copies the built app, swaps `Game/` for `game-test/` (keeping the built `Game/ui`, the fonts and sprites of the native views), re-signs ad hoc, does a fresh install, launches with `--console-pty`, and reacts to the page's `SHOT`/`ACTION`/`DONE` markers (screenshots, background/foreground via the Settings app, `kill -9` WebContent). `START_PHASE=lifecycle` skips ahead |
| `drive-hw.mjs` | Real hardware keys: opens Xcode 27's DeviceHub, which replaced Simulator.app, and types with System Events |
| `lm-harness.mjs` | The bots' chat model's Swift (BotChatModel, OnlineModel, LocalModel) compiled for the Mac with the macOS slice of llama.cpp's framework, against `web/test/lm/mock-claude.mjs`: the fallback chain, every Claude failure, busy, the requests' fields; with a hybrid model (template `qwen-chatml-hybrid`) the requests' `think` |

```
xcodebuild -project ios/LostCity.xcodeproj -scheme LostCity -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build/DerivedData-swift build
xcrun simctl create LC-test com.apple.CoreSimulator.SimDeviceType.iPhone-13-mini \
  com.apple.CoreSimulator.SimRuntime.iOS-26-5 > build/tmp/swift/sim-udid.txt   # (mkdir -p it first) or UDID=<udid> below
node web/test/native/drive.mjs       # fresh install, all phases; START_PHASE=keyboard|lifecycle to skip ahead
node web/test/native/drive-hw.mjs    # after drive.mjs; the first run after DeviceHub launches can drop keys: rerun
```

Each run leaves its console log and screenshots in `build/tmp/swift/`. `drive.mjs` checks the routes and MIME types,
saves and their `.bak`, the keyboard bridge (charsets, the paste cap, chips, Cancel, the chat line emptied on Send),
haptics and the Vibration setting, the lifecycle (background, a hang past the flush timeout, `willTerminate`), a
killed WebContent process and the crash loop's error screen, the loading cover's zoom, and the chat model's status,
key box and requests against the mock. On the simulator `willTerminate` delivered through the main queue took the
whole 4 s deadline, and through the run loop 6 ms (above, Threading).

**Simulator keyboard state:** after DeviceHub has been used, the device keeps "hardware keyboard connected" (only the bar shows). `xcrun simctl erase` resets it.

**Debug hooks** (DEBUG builds only) take `{type:'debug', id, action}` and reply through `window.__lcDebugReply(id, value)`:

| Action | What it does |
|---|---|
| `type` | Feeds text through `insertText`/`deleteBackward` exactly as the system keyboard does |
| `key` | Hardware-key path |
| `bar` | Bar buttons: `{button: 'submit' \| 'hide' \| 'cancel'}` |
| `chip` | Taps chip `{index}`; returns its label or null |
| `paste` | Pastes `{text}` through the paste path |
| `overlay` | `{mode: 'loading' \| 'error' \| 'retry' \| 'hide', message?}` on the loading cover |
| `ui-state` | Returns `overlayShowing`, `overlayError`, `overlayLayout` (the cover's zoom, font size and frames) and the presented view controller |
| `keyboard-state` | Returns the keyboard state (incl. `cancellable`, `cancelShown`, `submitTitle`, `charset`, `maxLength`, `chips`, `coveredHeight`, `rejections`, `flashing`, `canPaste`) |
| `haptics` | Returns the haptic styles played since the last call, oldest first (the simulator has no Taptic Engine) |
| `idle-timer` | Returns the keep-awake flag |
| `memory-warning` | Posts the UIKit notification |
| `lifecycle` | Sends one lifecycle event |
| `terminate` | `willTerminate` from a main-queue block, the worst case |
| `settings` | Returns the stored settings |
| `reload` | Reloads the page |
| `lm-status` | Returns the chat model's status and counters |
| `lm-endpoint` | `{url}`: Claude's endpoint (a local mock in the tests; none: the API's) |
| `lm-key-alert` | `{text, button: 'save' \| 'cancel'}`: types into the presented key box and presses the button; returns `shown`, `secure`, `firstResponder`, `title` |
| `activity` | Counts as user activity (keeps the screen awake during a long in-app test) |

`{type:'lm-bench', id, action}` (DEBUG) runs the on-device model directly for its benchmark on a phone (`app-test.mjs
--lm-bench`): `generate` {system, user, think?, timeoutMs} (the line, its timings and its note; `think` from `--lm-think`),
`stats` (memory, thermal state, the model's state, note support and last load, WebContent terminations), `options`
{threads, gpuLayers, idleSec}, `unload`.

**Not covered in the simulator:**
- **A real memory warning.** DeviceHub has no scriptable trigger, so the hook posts the same notification UIKit posts.
- **A real `willTerminate`.**
- **Device behaviour:**
  - WebContent suspension in the background
  - haptic feel
  - the iPad keyboard's dismiss key, which the non-resigning responder may block; the bar's hide button works
