# Architecture

How 2004Scape is put together: an offline, single-player port of Lost City (2004scape), revision **274**, for iOS
and Android. Everything runs on the phone. The iOS app:

```
┌──────────────────────────── iOS app (Swift, UIKit) ─────────────────────────────┐
│ GameViewController                                                               │
│  ├─ WKWebView  (one WebContent process, JIT)                                     │
│  │    page: lostcity://game/index.html                                           │
│  │     ├─ host.js      boot, fake WebSocket, native bridge, layout, settings     │
│  │     ├─ hud.js       the mobile HUD (2004 look) around the full-screen world   │
│  │     ├─ client.js    Client-TS 274 (patched): <canvas id=canvas> on the title  │
│  │     │               screen, its area canvases (surfaces) in game              │
│  │     └─ Worker(engine/boot.js, module)                                         │
│  │          └─ engine.js   Engine-TS 274 game world (shimmed for the browser)    │
│  │             or engine-bots.js  the same + the bots (Settings › World › Bots) │
│  ├─ AssetSchemeHandler  lostcity://game/*  → app bundle "Game" folder + saves   │
│  ├─ KeyboardBridge      hidden UIKeyInput view + accessory bar                   │
│  └─ SaveStore           Documents/players/<profile>/<name>.sav (atomic, .bak)    │
│                         Documents/bots/<profile>/bots.sav (the bots, if any)     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

The optional bots (2004sp-progressive's AI, ported) are described in [BOTS.md](BOTS.md); their additions to the
contracts below are marked **Bots**.

**Online mode** ([ONLINE.md](ONLINE.md)) plays on a game server (Engine-TS 274) instead: the page then runs no engine
worker, and native code carries the client's sockets and fetches the server's files; its contracts are §7.2, and its
additions elsewhere are marked **Online**.

**Android.** The same web bundle also runs in an Android app (`android/`, Kotlin, Android System WebView). Everything in
this document applies there too, except where [ANDROID.md](ANDROID.md) says otherwise: the origin
(`https://appassets.androidplatform.net` instead of `lostcity://game`), the page ↔ native bridge (`lcAndroid` and
`window.__lcCall` instead of `webkit.messageHandlers` and `evaluateJavaScript`), saves sent in a request header (a
WebView request handler never sees a body), Back doing nothing, no silent switch setting, the crisp pixel snap at fractional pixel ratios, and the
bots' chat model on the CPU. Read ANDROID.md alongside this one before changing a contract: `web/` is shared, so a change
to the page reaches both apps.

Source repos (read-only inputs, never modified), at the commits `upstream.json` pins: `engine` (Engine-TS 274),
`content` (Content 274), `webclient` (Client-TS 274), found by `scripts/lib/upstream.mjs` in `LC_UPSTREAM_DIR`, else
`upstream/` (`node scripts/fetch-upstream.mjs`), else the sibling `../Server`. The packed game data comes from
`engine/data/pack` (produced by `npm run build` in the engine).

## 1. Repository layout

| Path | What |
|---|---|
| `ios/LostCity.xcodeproj`, `ios/Config/Info.plist`, `ios/Config/Signing.xcconfig` | Hand-written project (objectVersion 77, synchronized `LostCity/` group, folder reference `../build/Game` → bundle `Game/`); the target's base configuration `Signing.xcconfig` (bundle id, team from the git-ignored `Local.xcconfig`, version from `build/Version.xcconfig`) |
| `ios/LostCity/` | Swift sources + `Assets.xcassets` |
| `web/package.json` | Pinned build tools: esbuild 0.28.0, fflate 0.8.3, node-forge 1.4.0 (`npm install` in `web`) |
| `web/engine/` | Engine worker: `build.mjs`, `src/` (entry, transport, shims; `entry-bots.ts` + `runtime/bots/`: the bots' glue), `test/` |
| `web/engine/bots/` | **Bots**: the ported bot library (`src/`, imported as `#/engine/bot/*`), its data, tests, and `content/` (the bots' script patches and their compiler) — [BOTS.md](BOTS.md) |
| `web/client/` | Client build: `build.mjs`, `overrides/` (whole-module replacements), `patches/` (diffs against the upstream webclient), `test/` |
| `web/host/` | `index.html`, `host.js`, `hud.js`, `menu.js`, `worldmap.js`, `mapview.html`, `host.css` — the page that ties it together (§6.1 for the HUD and its World map, §6.2 for the options menu and gestures) |
| `web/ui/` | `build.mjs`: the game's bitmap fonts as TrueType and its sprites as transparent PNGs, from the upstream content, for the HUD (`web/ui/README.md`) |
| `web/test/` | Desktop test server (`serve.mjs`, implements the same routes as the Swift scheme handler), the end-to-end harness (`e2e.mjs`), the HUD harness (`hud.mjs`), the HUD gallery (`gallery/`: `capture.mjs` records real game pixels once, `gallery.mjs` renders every HUD state at four iPhone sizes around a stub client, iPads and the SE with Display Zoom on request), the in-app test (`app-test.mjs` + `autotest.js`) and the simulator harness for the native layer (`native/`) |
| `scripts/build-web.mjs` | Orchestrator → `build/Game/` (and `build/Version.xcconfig` from `VERSION`) |
| `upstream.json`, `scripts/fetch-upstream.mjs`, `scripts/lib/upstream.mjs` | The pinned upstream commits, the script that clones them into `upstream/`, the resolver every script uses |
| `ios/scripts/deploy.sh` | xcodebuild + install + launch (device or simulator) |
| `android/` | The Android app (Gradle root: `:app`, `:botchat`, `:llm`, `build-logic`; its scripts and device tests): [ANDROID.md](ANDROID.md) |
| `models/bots-2004.json` | The published chat model's pin (size, sha256, template, release URL) |
| `VERSION` | The version both apps carry |
| `ios/scripts/fetch-llama.sh`, `ios/scripts/prepare-model.sh` | **Bots**: llama.cpp's prebuilt framework (release b11297, sha256-pinned) into `build/Vendor/`, and the bots' on-device chat model into `build/Model/` (§7.1) |
| `build/` | `build/Game/` (bundled into the app), `build/Model/` (bundled as `Model/`), `build/Vendor/llama.xcframework`, DerivedData, temp dirs. Git-ignored. |

Every build module exports an async function **and** works as a CLI:

```js
// web/engine/build.mjs
export async function buildEngine({ out, debug = false, engineDir, contentDir, bots }) // writes out/engine/**, out/cache/**
//   bots: default on (web/engine/bots/src + the compiled overlay) → also engine-bots.js etc.; false → engine.js only
// web/client/build.mjs
export async function buildClient({ out, debug = false, webclientDir, engineDir }) // writes out/client/**, out/crc, out/<jag><crc>
// web/ui/build.mjs
export async function buildUi({ out, contentDir }) // writes out/ui/** (HUD fonts and sprites)
```
`out` is the `Game` root (normally `build/Game`). Defaults: `engineDir`, `contentDir` and `webclientDir` are the
upstream checkouts `scripts/lib/upstream.mjs` resolves. `debug` = unminified + sourcemaps + console kept.

## 2. `build/Game/` layout (served at `lostcity://game/…`)

```
index.html  serverurl.js  host.js  bzip2.js  hud.js  menu.js  worldmap.js  mapview.html  host.css   (web/host, copied recursively)
ui/fonts/p11.ttf p12.ttf b12.ttf q8.ttf           the game's four fonts ('RS Plain 11/12', 'RS Bold 12', 'RS Quill 8')  (web/ui)
ui/sprites/<name>[-<tile>].png                    every content sprite and title image, magenta → transparent           (web/ui)
ui/manifest.json                                  font metrics and sprite sizes                                          (web/ui)
crc                                               40-byte CRC table, exactly engine CrcBuffer.data   (client build)
title<crc> config<crc> interface<crc> media<crc>  jag archives, names embed signed decimal CRCs      (client build)
versionlist<crc> textures<crc> wordenc<crc> sounds<crc>
client/client.js [client.js.map]                  patched Client-TS bundle                          (client build)
client/tinymidipcm.wasm  client/SCC1_Florestan.sf2                                                    (client build)
client/mapview.js  worldmap.jag                   the World map: MobileMapView (patch 0018) and its data (client build)
cache/main_file_cache.dat  cache/main_file_cache.idx0..idx4    shared by client (OnDemand) and engine (engine build)
engine/boot.js                                    module-worker bootstrap: preload VFS, then import engine.js (or engine-bots.js)
engine/engine.js [engine.js.map]                  engine bundle
engine/engine-bots.js [.map]                      Bots: the same engine + the bot library and its glue (built unless --no-bots)
engine/vfs-manifest-bots.json                     Bots: the extra vfs file (vfs/bots/scripts.bin, the 24 overlaid scripts)
engine/bzip2.wasm                                 optional; engine falls back to pure-JS bzip2 if WASM is unavailable; the page's bzip2.js uses it too
engine/vfs-manifest.json                          [[vfsPath, urlRelativeToEngineDir], …]
engine/vfs/…                                      engine runtime files other than the cache (server packs, maps zip, csv, pem, world.json, wordenc, the start-up tables, …)
build-info.json                                   versions/commits of the inputs                    (orchestrator)
```

Absolute paths the client requests (`/crc`, `/title410306098`, …) resolve against the origin root, which is why the jag
archives live at the root of `Game/`.

## 3. Origin and URL routes (Swift `AssetSchemeHandler`; mirrored by `web/test/serve.mjs`)

Origin: **`lostcity://game`** — never change it (WebKit storage is keyed by origin).

| Method | Path | Behaviour |
|---|---|---|
| GET/HEAD | `/<file>` | File from bundle `Game/`. `/` → `index.html`. MIME: `.html` text/html, `.js/.mjs` text/javascript, `.wasm` application/wasm, `.json` application/json, `.css` text/css, `.png` image/png, `.svg` image/svg+xml, `.ttf` font/ttf, `.woff2` font/woff2 (and a few more image/font types), anything else (incl. extensionless jag/crc) application/octet-stream. 404 if missing. `Cache-Control: no-store`. |
| GET | `/save/<relpath>` | Read `Documents/<relpath>` → 200 bytes, or 404. |
| PUT/POST | `/save/<relpath>` | Body (`httpBody`, ArrayBuffer/Uint8Array — **never a Blob**, WebKit drops Blob bodies) written **atomically** to `Documents/<relpath>`; the previous version is kept as `<relpath>.bak`. 204 on success, 500 on failure. |
| DELETE | `/save/<relpath>` | Delete → 204/404. |
| GET | `/save-index` | JSON `[{path,size,modified}]` of everything under Documents (`modified` in ms since 1970; hidden and temp files excluded). |
| POST | `/log` | Body = UTF-8 text line(s); printed to the native log (for workers that cannot reach `webkit.messageHandlers`). |

**Online** (§7.2) native adds, for a page load whose `settings.server` names a server: `GET /crc…` and the 8 jags from
the server through a proxy (the bundled jag when its name is the server's), `GET`/`PUT /ondemand/<archive>/<file>` (the
app's cache of the server's OnDemand files), and in every mode `GET /server-probe?url=<address>`.

`relpath` must not escape the Documents folder (reject `..`, absolute paths). Player saves live at
`players/<profile>/<safe_name>.sav` (profile defaults to `main`); **Bots**: all bots of a profile in one file,
`bots/<profile>/bots.sav` (§5).

### 3.1 Online routes (Swift `OnlineProxy`)

While the page load plays on a server (§7.2), the game's own requests are that server's: native fetches them (a page
cannot: Engine-TS sends no CORS headers) and caches what it can in `Library/Caches/online/<server id>/` (purgeable;
deleted with the server). Offline these paths are the bundle routes above, unchanged, except `/server-probe`.

| Method | Path | Behaviour |
|---|---|---|
| GET | `/crc…` (any suffix) | `<base>/crc`, 10 s. 40 bytes with the client's trailer (1234, then `(c << 1) + crc[i]` over the 9) → 200; else 502. |
| GET | `/<archive><crc>` (title, config, interface, media, versionlist, textures, wordenc, sounds) | 1) bundle `Game/<archive><crc>` (same name, same CRC, same bytes); 2) the cached copy, if its CRC-32 is `<crc>` (else it is deleted); 3) `<base>/<archive><crc>`, 30 s, its CRC-32 checked, stored atomically, served; else 502. |
| GET/HEAD | `/ondemand/<archive>/<file>` | The server's cached OnDemand file (`od/<archive>/<file>`) → 200, or 404. Archive `0`-`3`, file `0`-`65535` in plain decimal, else 400. |
| PUT | `/ondemand/<archive>/<file>` | Body (1 B to 4 MiB, else 400 / 413; the page checked it against the server's versionlist) stored atomically → 204. |
| GET | `/server-probe?url=<address>` | In every mode. JSON `{ok, error?, url, crc, nodeId, members, rsa, notes}`: `/crc` (10 s; `ok` = a good table), then `/rs2.cgi`'s `new Client(<node>, <lowmem>, <members>)` (else world 10, members, and a note) and `/client/client.js`'s `rsaenc(BigInt("<n>"), BigInt("<e>"))` or the only `BigInt("<40+ digits>"),BigInt("…")` pair (else `rsa: null`, the built-in key, and a note). No `url` → 400; an address that does not normalize → `error: 'invalid address'`. |

A 502's body is the plain words the page shows: `unreachable` (refused, no such host, DNS, TLS, a dropped connection),
`timed out`, `not a 2004scape server` (404, not 40 bytes, a bad trailer), `http <status>`, and for an archive `checksum
mismatch`. Requests send the app's User-Agent (`2004Scape/<version> (iOS <version>)`), no cookies, no Origin. Nothing
runs on the main thread. `web/test/native/drive.mjs --online` checks every case on the simulator against a stand-in server.

## 4. Page ↔ engine worker protocol (`worker.postMessage`, NOT MessageChannel — 4–8× faster in WebKit)

The page creates `new Worker('engine/boot.js', { type: 'module' })`.

**page → engine**

| Message | Meaning |
|---|---|
| `{type:'init', config}` | Sent once, right after creation. `config` = world-config overrides merged into `world.json` before the engine is imported (e.g. `{node:{members:true, xpRate:1}}`). boot.js then preloads the VFS and imports `engine.js`. **Bots**: `config.bots = {count: N}` (Settings › World › Bots; 0 = off); with N > 0 boot.js also preloads `vfs-manifest-bots.json` and imports `engine-bots.js` instead ([BOTS.md](BOTS.md) §4.1). **Staff level**: `config.staffModLevel` (0–4) is what every login gets (Settings › World › Jmod: On sends 4, Off 0; absent: 4 unless `production`) (§8). |
| `{type:'start'}` | Start the world (after `booted`). |
| `{type:'connect', id}` | New client connection `id` (integer, unique per page). The engine sends nothing on connect (rev 274: client speaks first). |
| `{type:'data', id, data}` | Bytes from the client; `data` is an `ArrayBuffer` (transferred). |
| `{type:'close', id}` | Client closed the connection. |
| `{type:'lifecycle', reqId, event}` | `event` ∈ `pause` (save all + stop ticking), `resume` (rebase clock: no catch-up burst; restart ticking), `save` (save all players now). Engine replies `lifecycle-done` after the work (incl. save writes) is complete. |
| `{type:'delete', reqId, name}` | Settings › Saved data deletes a character (§5.1): the engine deletes `players/<profile>/<name>.sav` (`DELETE`; native keeps it as `.bak`) and drops a copy it still holds in memory (a write that failed and is retried), so nothing writes it back; never one in the world. Replies `delete-done`. **Bots**: the character's friend and ignore lists leave the bots' store. |

**engine → page**

| Message | Meaning |
|---|---|
| `{type:'progress', stage, detail?}` | Boot progress for the loading screen (`preload`, `import`, `start`, …). |
| `{type:'booted', preloadMs, evalMs, files, bytes, bundle, bots}` | VFS loaded and bundle evaluated. **Bots**: `bundle` is `'engine.js'` or `'engine-bots.js'`, `bots` the count it runs (0 when the bots bundle is missing or failed to load). |
| `{type:'bots', active:false, reason, detail}` | **Bots**: asked for but not running this session (`reason`: `no-bundle`, `load-failed`, `store-unreadable`, `store-corrupt`, `mismatch`, `failed`); the page shows it once. Never sent with the bots off. |
| `{type:'ready', ms}` | World started and ticking; client may connect. |
| `{type:'data', id, data}` | Bytes for client `id`; `data` is an `ArrayBuffer` (transferred). All sends of one macrotask are batched into one message per connection. |
| `{type:'close', id}` | Engine closed connection `id` (after delivering any queued bytes). |
| `{type:'delete-done', reqId, ok, error?}` | Reply to `delete`. `ok` also when there was no save; `error: 'in-world'` for a character in the world (or logging out), else why the `DELETE` failed. |
| `{type:'lifecycle-done', reqId, ok, error?, bots?}` | Reply to `lifecycle`. `ok` is about the human players' saves. **Bots**: `bots: {ok, error?}` says whether the bots' store was written (a failed write is kept and retried; `resume` writes it first; Settings › Restart waits on it like on a failed save). |
| `{type:'log', level, text}` | Worker console output (page forwards it to native). |
| `{type:'exit', code}` | Engine stopped (fatal error or shutdown). Saves of connected players were attempted first. Page shows an error / restarts. |

Engine-side rules (details in `web/engine/README.md`): socket `remoteAddress = '127.0.0.1'`; `send()` copies
(engine buffers are reused) and batches per microtask; close events are asynchronous; when a connection closes, **every**
player whose `client` is that socket gets a `NullClientSocket` (fixes both upstream reconnect bugs without patching
`World.ts`); missed ticks after a freeze are dropped (no catch-up burst); `process.exit` is shimmed to flush saves and
post `exit`.

## 5. Saves (engine ↔ native)

The engine's login thread runs in-process (`worker_threads` shim). With `login.enabled=false` it loads/saves
`data/players/<profile>/<name>.sav`. In the iOS build those reads/writes go **directly to native storage** with
synchronous XHR from the worker: `GET ../save/players/<profile>/<name>.sav` (404 → new player) and
`PUT ../save/players/<profile>/<name>.sav` (ArrayBuffer body). Saves happen on logout, every 15 min (engine autosave), and on
`lifecycle: pause|save`. Native writes are atomic with a `.bak` of the previous version.

**Bots**: every bot of a profile is kept in one file, `bots/<profile>/bots.sav` (`"LCBOTS01"`, a count, then each bot's
name and its standard player save, plus a `_meta` record: the bots that quit and, with the bots on, the characters'
friend lists), read once when the bots start and written once per save occasion, after the human saves, through the
same routes. A read that fails turns the bots off for the session (nothing is written); a
corrupt file falls back to `bots.sav.bak`. The title's Characters list reads only `players/<profile>/*.sav`, so it never
shows a bot ([BOTS.md](BOTS.md) §4.5).

### 5.1 Saved data (Settings › Saved data, `host.js` `savedData`)

A category of Settings lists the characters (`players/<profile>/*.sav` from
`/save-index`, with when each was last played) and the world (`bots/<profile>/bots.sav`: how many bots it holds and how
many quit, read from the store itself). Each action asks first in a 2004-style confirm box, and a deleted file stays as
`<file>.bak` (native `DELETE`) until that file is saved again, so a mistake can be undone by hand in the Files app.

- **Delete** (a character): through the engine (`delete`, §4); the one in the world has no Delete ("In the world now:
  log out to delete"). No restart: the sheet and the title's "Continue as" / Characters update.
- **Reset world**: the world is paused and saved (`lifecycle: pause`; a character's save that fails stops it, as for
  Restart), the engine worker is terminated so that nothing writes a save again (no autosave, no bot leaving, no retry),
  `bots.sav` is deleted, and the page reloads: a new bot world, the characters kept (their friend lists were in the
  store). Off while there is no store.
- **Delete everything**: the same, deleting every character and the store (read from `/save-index` after the engine
  stopped: the pause may have written a first save), and (2026-10-27) the rest the game kept: the `::` commands and
  amounts typed lately (`localStorage` `lostcity.cmdHistory`, `lostcity.amounts`) and native's log (`{type:'clear-log'}`,
  §7). Settings (the server list among them), the Claude key and the remembered server passwords are kept; so are the
  `.bak` copies, the undo.

Anything still listed after the deletes is deleted once more (a write the engine had started may land late). After the
reload the status line says what happened ("The world was reset.", "Everything was deleted.", or that something could
not be deleted), carried over the reload in `sessionStorage` (`lostcity.notice`).

## 6. Page ↔ client contract

Before `client.js` is imported, the host page:
1. Assigns `window.WebSocket = EngineSocket` (global; static `CONNECTING/OPEN/CLOSING/CLOSED`; `readyState` set to 3
   *before* firing error/close; `binaryType`, `bufferedAmount` (0), `send(Uint8Array|ArrayBuffer)`, `close()`, `onopen/
   onmessage/onerror/onclose` + `addEventListener`). The client's `e instanceof WebSocket && e.readyState === 3` checks depend
   on this being the global. **Online**: `NativeSocket`, the same surface over native's socket bridge (§7.2); host.js
   reads `settings.server` (with `serverurl.js`'s rules, loaded just before it) to choose.
2. Sets `globalThis.__LC_CACHE__ = { dat: Uint8Array, idx: [Uint8Array ×5] }` (from `cache/main_file_cache.*`) — the
   patched client's OnDemand reads models/anims/midi/maps from it synchronously (no worker, no second socket, no IndexedDB).
   With it, `globalThis.__LC_BZIP2__ = { decompress(stream) }`: libbzip2 (`engine/bzip2.wasm` through
   `web/host/bzip2.js`), with which the client's `src/io/BZip2.js` override unpacks its jag archives about 10× faster
   than with its own JavaScript decoder, to the same bytes. Deleted once the client has loaded (`lastProgressPercent`
   100), which frees the instance; without WebAssembly (Lockdown Mode) there is none and the client decodes as upstream.
   The World map's page (`mapview.html`) does the same for `worldmap.jag` until its first map is ready.
3. Sets `globalThis.lcHost` (API below).

Then it does `const { Client } = await import('./client/client.js'); window.__client = new Client(10, lowMemory, members)`
(nodeId 10 and the Settings' detail and members choice — must match the engine's `node.id`/`node.members`; **Online**: the
server entry's `nodeId` and `members`, and no engine worker is started). The engine
worker, the cache's fetch and the import of `client.js` start first, right after the stored settings are read, so that
they load while the page builds its own controls and lays itself out; the Client is made once both are there (the
worker's messages wait for that init: the page's first `await`).

One loader (`#loading`) shows from launch to the title screen: its bar fills with the world's preload and start and the
client's own loading, and it fades once the title screen is drawn and the world is ready (checked every 50 ms while the
loader shows, and by the page's 200 ms watcher). A client that fails to load
(`errorLoading`, `errorHost`, `errorStarted`) draws its own error screen, and the loader gives way to it at once.
Otherwise it gives way after 45 s; a world still starting then says so in the status pill ("The world is still
starting…"), and one not started after 90 s is ended and reported: the 2004 error screen with Restart (`fatal`, §7). Both
times count only while the page runs, so a launch spent in the background does not time out. **Online** the loader waits
for the client alone, and a server that cannot be reached gets the unreachable box within seconds instead (§7.2).

The client's AudioContext (`window.audioContext`, 22,050 Hz) can be suspended in silences (`host.js` `audioIdle`): once
no source has played on it for 10 s, and resumed when one starts (the music's next buffer, a sound effect: it plays once
the resume is done, with the same samples) and, ahead of that, on a touch. WebKit keeps the audio output running while a
context runs, silent or not (audiomxd 14-17.5 % of a core on an iPhone 13 mini, 0.1-0.7 % with it suspended). One
constant decides where (`AUDIO_IDLE_SUSPEND`): `'ambient'`, as shipped: only while Settings › Sound follows the silent
switch (Mute), where the session mixes with other apps' audio anyway. On an iPhone 13 mini a silent stretch there costs
about 23 points of a core less, and a sound with no touch before it (a hit, a level-up, the next song) is out about 7 ms
later, about 40 ms after minutes of silence. `'all'` would also suspend in Play (`playback`, the default), but there the
page is the phone's Now Playing app while its context runs, and WebKit drops a suspended context from Now Playing:
Control Center would show the previous app in the game's silences. (WebKit keeps the audio session active through a
suspend, so other apps' audio would stay interrupted as it is now.) `'off'` suspends nothing. `e2e.mjs` checks whichever
it says. Never on Android. Native's mute and the lifecycle's pause own the context while they last (the 10 s start again
after them).

`globalThis.lcHost` (implemented by `web/host/host.js`, consumed by client patches/overrides):

| Member | Used by | Meaning |
|---|---|---|
| `keyboard.show()` / `keyboard.hide()` / `keyboard.isShown()` | MobileKeyboard override | Request/dismiss the native keyboard. The host inspects `__client` to decide the context (chat, login user/pass, amount dialog, social, report). |
| `haptic(style)` | touch patches | `'light'|'medium'|'heavy'|'selection'` (nothing when the Vibration setting is off) |
| `takeSecondaryClick()` | touch patch (`pointerUp` tap path) | Returns `true` (once) if the player armed the options-menu button (`#btn-secondary`, "next tap opens the options menu", in the classic layout's rail: the HUD has tap-to-drop in its place; it disarms after 5 s, another button or the HUD showing) → the tap clicks with button 2. |
| `settings` | client patches | `{ stayLoggedIn: boolean, longPressMs: number, cameraSensitivity: number }` (read live; `longPressMs` is Settings › Hold for menu: 300, 400 (the default) or 600; `cameraSensitivity` is Camera drag: 0.35, 0.6 (the default) or 1; the host's other settings are its own) |
| `server` | client patch 0030 (`lcLoginKey()`), the LocalOnDemand override (`lcServer()`) | **Online**: `{id, name, url, nodeId, members, rsa}` (`rsa`: `{n, e}` decimal strings, or null for the build-time key); null offline |
| `openSocket(purpose)` | the LocalOnDemand override (`lcOpenSocket('ondemand')`) | **Online**: a `NativeSocket` to the server for OnDemand's remote files; null offline |
| `platform` | client patch 0026 (`lcPlatform()`) | Which app the page runs in, as the engine's `init` is told: `LostCityNative.platform` (`'ios'`, `'android'`), or `'web'` without an app (desktop tests). On `'android'` a canvas gets its whole frame when any of its pixels changed; everywhere else the rect of the changed pixels (§6.1) |
| `onClientEvent(name, detail)` | client patches (optional) | `('ingame', bool)` (the host switches between the title canvas and the HUD in the same frame), `('menu-open', {serial, area, options, pointerId, x, y, width, height})` (the host shows its large menu, §6.2, and plays the long-press haptic), `('menu-close')`, `('action-label', {text, x, y})` (patch 0020: the host shows what a tap did beside x, y, page px), `('stat', {stat, xp, level})` (patch 0035: each UPDATE_STAT, for the XP counter, §6.1) |

Client fields the host touches at runtime (property names are preserved by esbuild; all listed in `HOST_FIELDS` in
`web/client/build.mjs`, which fails the build if one disappears): `keyHeld[1..5]` (arrows, ctrl), `timeoutTimer`,
`idleTimer`, `noTimeoutTimer` (reset on resume), `ingame`, `reconnecting`, `loginscreen`, `loginSelect`, `loginUser`,
`loginPass`, `loginMes1/2`, `titleFlames`, `lastProgressPercent`, `errorLoading`/`errorHost`/`errorStarted` (the loader),
`keyQueueReadPos/WritePos`, `nextMouseClick*` (the Login click), `chatInput`, `dialogInputOpen`, `dialogInput`,
`socialInputOpen`, `socialInput`, `socialInputHeader`, `socialInputType` (a private message or a name), `reportAbuseInput`,
`mainModalId`, `sideModalId` (the how-to card waits for no window), `reportAbuseComId`, `chatModalId`, `tfps`,
`setTargetedFramerate(n)`, `lastProgressMessage` (**Online**: the client's own retry screen, §7.2), plus the HUD API
below. The list also keeps `isMenuOpen`, which `web/test/hud.mjs` reads.
Typed characters are injected as
`KeyboardEvent('keydown'/'keyup', {key, code: key})` on `#canvas` (GameShell drops untrusted events with an empty `code`);
in the HUD `#canvas` stays in the page (opacity 0, no pointer events) for exactly that reason.

### 6.1 The mobile layout (client patches 0011-0014, `web/host/hud.js`)

Without a layout set the client is the classic 765×503 canvas, unchanged. `setSurfaceLayout({game, map, side, chat,
width, height, insets})` makes the in-game areas draw into four canvases of their own (`#surface-game`/`-map`/`-side`/
`-chat`), which the page places and scales with CSS. Each draw sends its canvas only the pixels that changed (patch
0026; on Android the whole frame, and only when a pixel changed). WebKit can drop a canvas's pixels without a word (an
iPhone's inventory panel came back as bare stone, its tab selected), so every canvas the client shows gets the frame it
last sent again, whole, every 2 s and at once when the page is shown again, and the HUD has a surface's frame sent at
once when it shows the panel, the chatbox or the minimap again (patch 0032, `PixMap.keepShown`, `resendSurface`; the
title screen and the classic layout's pieces too). While the camera is still, the world's 3D scene is
itself drawn again only where something in it changed, with the pixels a full render gives (patch 0029,
`dash3d/IncrRender.ts`):

| Area | Size (game px) | Virtual rect (input) | HUD placement |
|---|---|---|---|
| world (viewport) | `width`×`height`, at least 512×334 (812×375 on the iPhone 13 mini: 1 game px per CSS px; up to 410,000 px, so the 932×430 Pro Max is 1:1 too; wider where a 512 px window must fit beside the side panel, e.g. 731×411 on a 667 px SE) | `(1024, 4)` + size: an "island" right of the classic 765×503 space, so it never overlaps the others | full screen |
| minimap | 172×156 | classic `(550, 4)` | top right, as a round map: the canvas in a circular clip of radius 64 game px around the player (98, 80) — further out are the mapback's stone and dragons — inside a thin (4 px) ring of rough stone, scaled so the ring clears the side panel (radius 40-78 HUD px: 65 on the 13 mini and the SE, 73 on the 13, 78 on the Pro Max). The client's own compass corner is clipped away; the HUD's compass button and the zoom slider's knob sit on the ring |
| side panel | 190×261 | classic `(553, 205)` | at 5/6 (158×218 CSS px: 2.5 device px per game px on a 3x iPhone; 1:1 reached in towards the player) in a stone frame, left of the tab column, its bottom by the screen's; at the right edge while a side modal is open |
| chatbox | 479×96 | classic `(17, 357)` | bottom left, 1:1 in a stone frame (scaled down to fit beside an open panel), above the chat buttons; above the keyboard while typing |

The rest of the HUD is HTML in the 2004 look (`#hud-ui`, laid out in HUD px). On a large screen it is zoomed as a
whole, and so are the options menu (`#menu-layer`) and the overlays (loader, error, Settings; both through
`--ui-zoom` and `html.ui-zoomed`): by the largest of ×2 and ×1.5 that the height allows (720 and 540 px) and that
still leaves the HUD the 667 px of the narrowest phone it is laid out for (an iPhone SE) between the safe areas, else
×1. That is ×1 on every iPhone, ×1.5 on an iPad mini or an 11-inch iPad and ×2 on a 13-inch one. Each zoomed layer is
laid out at the viewport's size divided by the zoom and scaled up with a `transform`, not CSS `zoom`: WebKit's zoom,
and WKWebView's `pageZoom` alike, leave the text of any element that sets its own font at 1× inside a zoomed box (and
the page zoom also centres `inset: 0` overlays in the unzoomed viewport), which Chrome does not show. The native launch
cover computes the same zoom (§7).

The HUD follows the client's frames, not the display's: `hud.js` runs its update right after each `mainredraw` (it
wraps the client's), and the host calls it directly for its own events (a tap on the HUD, the keyboard, a layout). What
it shows changes only then, so the update lands in the same rendering update as it would from a requestAnimationFrame
loop, without asking the browser for a frame on every vsync (60 a second on an iPhone, up to 120 on a Pixel; in Chrome
at 60 Hz the page's main frames went from 60 to 48 a second, their cost from 8.9 to 5.1 ms/s at idle). A client without
`mainredraw` (the gallery's stub) keeps the display's frames.

- **Orbs** (top right, left of the compass): hitpoints and prayer (`hudState().hp/hpMax/prayer/prayerMax`, coloured by
  how much is left; a tap opens the Stats / Prayer tab), and **Run** (the word and the run energy; red while running;
  dimmed during a dialogue, `runAvailable`). Hidden while a window is open or while typing.
- **XP counter and drops** (Settings › XP drops, a category of the mobile layout only: XP drops On (default) / Off;
  Speed Slow 25 / Normal 40 (default) / Fast 60 HUD px/s; Style Separate (default) / Combined: one row of the skills'
  icons and their sum; Speed and Style greyed out while Off): under the orbs,
  left of the minimap's ring, the total XP of all skills on a stone plate like theirs with the Stats tab's icon (a tap
  opens that tab); under it a lane (66 HUD px; shorter above the panel on a short screen or above a long list of
  dialogue answers, away when they reach the plate) through which each gain rises into the plate at the chosen speed:
  one drop per server tick, a row per skill (its 2004 `staticons` icon and "+amount"; or the combined row), clipped and faded at the lane's ends
  (a drop waits unseen below the lane until the one before has room; past 8 waiting, gains add to the newest). From
  patch 0035's `'stat'` events: the first of each stat after `'ingame'` is where the character stands (the login set,
  no drops), a higher XP later a gain. Hidden with the orbs; gains made while hidden count in the total but get no drop.
  Both right edges stay clear of the ring, the compass and the zoom slider along its whole groove.
- **Battery** (top left corner; the status bar is hidden): a 14×8 pixel glyph filled to the charge and the percentage
  in the small font, faint white (70 % opacity), red at 20 % and below unplugged, green on the charger; taps go
  through. From native's `LostCityHost.battery(level, charging)` (§7); none until native reports a level (the
  simulator, desktop Chrome). Hidden with the orbs, and where a long list of dialogue answers reaches the corner. While
  it shows, the client's top inset is its bottom (16 HUD px), so the tooltip and a use prompt go under it.
- **Tab column**: the 13 classic tabs (sideicons) and Settings on slabs (the red stone `redstone2` for the open tab,
  the same shape in grey for the others) in a framed column of rough stone (34 px per tab, 76 px in all) under the
  minimap, bottom-aligned with the panel. The rough stone (`ui/textures/stone.png`, web/ui/build.mjs: the world texture
  `pebblefloor` recoloured with the 2004 frame's stones) is also the minimap's ring, the compass's and the zoom knob's,
  and shows through the bevels of the panel's and the chatbox's frames.
- **Minimap zoom**: a groove along the ring's lower left (192° to 120° clockwise from the right, its lower end moved up
  where the knob would come near the column or the panel) with a knob (a magnifying glass) the finger drags round it, +
  and - at the ends. Logarithmic over the client's 0.5..2 (`setMinimapZoom`), with a detent and a haptic click at 1 (the
  2004 zoom) and at the ends; saved in the `minimapZoom` setting (the classic layout always draws the 2004 zoom).
- **World map**: a globe on the ring's lower right, opposite the compass (a stone knob the zoom knob's size), opens a
  stone-framed sheet filling the safe area like Settings (`web/host/worldmap.js`); the game runs on behind it. The map is
  upstream's 2004 map applet with touch controls (client patch 0018, `client/mapview.js` with `worldmap.jag`) in an
  iframe of its own, `mapview.html`, so its GameShell, canvas and Pix2D are separate from the game's. The iframe is made
  at the first opening (~0.8 s to draw the world once in the simulator; about +75 MB footprint while open) and kept,
  its loop asleep while the sheet is closed. It leaves out the applet's four grids that only its keys draw (items,
  npcs, multi-combat and free-to-play areas, 9 MB), which a phone's map never shows. Header: **Key** (the map's kinds
  of icons by name, from the map's `keys`
  message, with their `mapfunction` sprites; a tap flashes them all and glides to the nearest when none is in view),
  **Overview** (the applet's), **Surface / Underground** (the map shown; a switch shows what lies under or over the view;
  the map the player is on is shown when the sheet opens), a centre button (glides back to the player) and **Close**
  (also Escape, a tap beside the sheet, and leaving the game). While it is open the host sends the player's tile
  (`hudPlayerTile()`) every 300 ms. Page and map talk by `postMessage` (see `MobileMapView.ts`).
- **Chat bar** (bottom left): tap-to-drop, the keyboard, the chat button; the 2004 Public/Private/Trade filters beside
  them only while a chatbox the player opened shows (Report abuse is left out: nobody to report), with
  their 2004 labels ("Public chat") where those fit, else short ones ("Public"); where neither fits (the panel open on
  a narrow screen) the filters give way until there is room. A label is never cut off.
  The newest chat lines float over the world above them (pointer-events none, fading out 12 s after the last new line).
- **Tap-to-drop** (OSRS mobile's; the chat bar's first button, where the classic layout's rail has the options-menu
  button, which the HUD leaves out: a long-press gives the menu): `setTapToDrop(on)` (client patch 0019). While it is
  on, the button is the red interface button (like Run) and the inventory tab's panel has a red frame
  (`#hud-panel.drop-mode`), and a tap on an item there drops it (its fifth op, OP_HELD5) instead of doing its first op.
  A long-press still gives the item's menu and a drag still moves it; a use or target mode and the inventories of side
  modals (bank, shop, trade) are unchanged. It stays on with other tabs open and is off again in a new session (and in
  the classic layout).
- **Action label** (client patch 0020 + menu.js `label()`, in both layouts): the 2004 hover text shows only while a
  finger is down, so after an action that starts a red cross (an op on an NPC, player, loc or ground item, an item used
  or a spell cast on one, also from the long-press menu) or acts on an item in a slot (inventory, worn equipment, bank,
  shop) the client sends `'action-label'` { text with colour tags, x, y: the cross or the tapped point in page px, via
  `GameShell.pagePoint` }. The host shows it as one row in the menu's look (`#label-layer`, no pointer events), placed
  like the menu: 24 px beside the point on the side with more room, level with it; in quickly, then fading out over
  1 s (`action-label-fade`). The next one replaces it, a menu opening hides it; a walk or a button leaves it.
- **Dialogue answers**: when `hudDialog()` reports a choice, the answers replace the chatbox as 40 px parchment rows
  (`#hud-dialog`, the quill font); a tap calls `tapAt` at the answer's own rect.
- **Camera pad** (optional, Settings): the character designer's arrow stones as a D-pad at the left, halfway up the
  room above the chat or a dialogue's answers; hidden where they leave it no room (five answers on a 13 mini).

What the player opened gives way to what the game opens: the panel steps aside for a dialogue, a prompt or a window
without a side panel and comes back afterwards (not for Tutorial Island's game messages, `hudState().tutorialMessage`,
which come with every action there: the chatbox shows them beside the panel). A tab the player taps while such a window
is open shows its panel over the window, which stays where it is. The minimap, orbs and tab column give way to a side
modal (bank, shop, trade), and the panel then sits at the edge so a 512 px window fits beside it. Tutorial Island's
instruction box opens the chatbox but can be put away (the chat button glows until a new step,
`hudState().tutorialKey`, shows it again). While the native keyboard covers the page (`LostCityHost.keyboard.frame`,
§7) and types into the chatbox, the chatbox slides above it and the bar, lines and orbs hide; it scales down to fit
beside what shows at its height there (the tops of the panel and the tab column, the minimap and its compass, and the
zoom slider's knob anywhere along its groove and its + and - marks, which stand out of the ring), and on a short screen
above the keyboard at all. The groove's ends move along the ring until the knob and the marks clear the tab column and
the panel (its zoomed-out end) and the compass and the orbs (its zoomed-in end, on a small minimap). A geometry solver places everything for the view and the HUD state so that no
control overlaps another or runs off the screen at any size (checked by `web/test/hud.mjs`, from the SE with Display
Zoom to the 13-inch iPad, and `--platform android` on the Android screens; the zoom knob at points all along its
groove, wherever the player may leave it).

Every pointer on a surface reaches the client as one virtual coordinate (the surface's CSS box mapped onto its rect,
frozen per touch, with pointer capture), so all classic hit tests for the minimap, panel, chat, tabs and chat buttons
still apply; only the viewport's own `4, 4, 512, 334` sites follow the island. A drag that leaves its surface never
clicks what lies at those coordinates in another area. The tab strips and the chat-mode strip are still drawn (to the
hidden `#canvas`), which keeps the tutorial's TUT_CLICKSIDE logic intact.

Client HUD API (in `HOST_FIELDS`, checked by the client build):

| Member | Meaning |
|---|---|
| `setSurfaceLayout(layout \| null)` | As above; `null` = classic. Re-run when the size changes (it re-runs `World.resetVisCalc`). |
| `setViewportInsets({left, top, right, bottom})` | How much of each viewport edge the HUD covers (viewport px). The client centres main modals (bank, shop…) in the rest (one wider than the rest starts at its left edge and runs on under the HUD on the right, never into the notch), keeps the main overlay's right edge on it (overlay content is right-aligned), keeps drawn world menus inside it when they fit, and draws the tooltip, split private chat, system update timer and "Connection lost"/"Loading" inside it. Overhead chat is not moved: it stays centred over the speaker's head, as upstream (a line next to the HUD runs on under it; the chatbox has it too). A panel the player opened over a window is left out of the right inset, so the window stays where it is. |
| `tapAt(x, y, button)` | A click at virtual (x, y) like a tap there (pointer moved, minimenu rebuilt first): exact for 2D areas (the tab column taps the classic tab centres, the chat buttons the classic chat-mode buttons, the dialogue sheet an answer's rect). On the world the options come from the last frame's 3D picking, which a real tap waits a frame for, so use a real touch there. |
| `hudState()` | `{ingame, activeTab, tabs[15] (classic indices 0-13), flashingTab, sideModal, mainModal, chatModal, tutorialChat, tutorialKey, tutorialMessage, chatInput, chatTyping, chatContinue, chatModes[3], runEnergy, running, runExists, runAvailable, reconnecting, menuOpen, menuArea, longPressable, hp, hpMax, prayer, prayerMax, cameraYaw, cameraZoom, minimapZoom}`, read every frame by hud.js (`longPressable`, `chatContinue`, `tutorialKey` and `tutorialMessage` are in `HOST_FIELDS` too). `runAvailable` is false while a window or a dialogue is open: the Walk/Run buttons' script closes it. `reconnecting`: after a dropped connection the client logs in again with `ingame` false; the host keeps the HUD up. `chatContinue`: the chatbox waits for "Click here to continue" (a touch anywhere on it continues). `tutorialMessage`: the tutorial's chatbox shows a game message until the next click (it counts in `chatModal` too). `longPressable`: a long-press at the pointer would open a menu (something besides "Cancel"; the hold ring shows only then). |
| `hudChatLines(max)` | The chatbox's newest lines (its filters applied) for the compact chat over the world. |
| `hudSetRun(run)` | The Player controls tab's Walk / Run button (IF_BUTTON + optimistic varp 173); false while that tab does not exist. |
| `hudFaceNorth()` | The compass button: the camera faces north. |
| `setTapToDrop(on)` → the mode now on | Tap-to-drop (patch 0019): a tap on an item in the inventory tab drops it; `hudState().tapToDrop` reports it. |
| `setMinimapZoom(zoom)` → applied zoom | The minimap's pixels per tile × 0.5..2 (1 = upstream's 4 px per tile; the anti-macro wobble stays on top). Drawing, the dots and hint arrow (their range and the arrow's switch to a dot measured on the map) and a tap on the map (`minimapLoop`) follow it. Zoomed out, the drawn map can reach past the black margin of the 512×512 minimap image (the player can stand 16 tiles from the build area's edge): it is drawn black there, where upstream's sampling wraps round. Below 2/3 it samples a half-size copy of the image (the mean of each 2×2, made once per map build), as every other pixel would skip the map's 1 px walls. |
| `setCameraZoom(zoom)` → applied zoom | Pinch zoom: the orbit camera's distance × 0.6..1.4. One tile-visibility matrix covers the whole range, computed only at maininit and when the viewport changes size: `World.resetVisCalc` with upstream's frustum height range widened by hMax × 0.4 on both sides (`500 + ceil(hMax × 0.4)` below, `800 + ceil(hMax × 0.4)` above; hMax = the steepest pitch's camera height). That costs about 1.5× upstream's one-time compute and about 8 % more visible tile cells each frame; recomputing it per zoom stalled pinches by 60-300 ms. |
| `setHostMenus(on)`, `hudMenu()`, `hudMenuSelect(serial, index)`, `hudMenuClose(serial)` | The host shows the options menu itself (§6.2): the client neither draws it nor picks from or closes it on its own; picks and closes by the menu's serial run in the next cycle like a click on the menu (a close does not undo a pick of the same menu made before that cycle). |
| `hudDialog()` | `null`, or `{options: [{text, x, y, w, h}]}`: a chat modal's selectable answers with their virtual rects. |
| `hudContinue()` | Continue a "Click here to continue" (hardware Space/Return). |
| `hudCancelInput()` | Close an open amount/name prompt or the report screen (the keyboard bar's Cancel, Escape). |
| `cancelPointer()` / `cancelPointerOn(el)` | End a touch like a pointercancel (the host hides a surface under a finger, or a pinch starts). |

The host keeps the layout in the `layout` setting (`'mobile'` default, `'classic'`): `host.js` `layout()` shows the
classic canvas + rails on the title screen and in the classic layout, and hands the in-game screen to `hud.js`
otherwise. Safe-area insets are read live through `env(safe-area-inset-*)` (re-checked by the watcher, since WKWebView
reports them late and rotation moves the notch). The title screen fits its top 413 game px (the floor below the
titlebox runs off the screen), shows Settings in the top right corner and, under the titlebox, "Continue as <name>" /
"Characters" from `/save-index` (a login is a name: the host fills the form and clicks Login), and lifts the login form
above the keyboard.

### 6.2 Touch on the host side (`web/host/menu.js`, `host.js`)

The gestures themselves are the client's (patches 0012-0013, `web/client/README.md`): every touch is one of a tap, a
long-press (held for `settings.longPressMs`, within `TOUCH_SLOP` = 14 px along either axis), a camera turn, an item or
scrollbar drag, or a scroll, which glides on after the finger lifts; a tap on a list that is still gliding only stops
it. On touch an inventory slot takes its whole grid cell, and exactly one slot takes a point (where cells overlap, as in
the worn equipment, the one whose icon is under the finger or nearest). The hover tooltip shows only while a finger is
down, but a use or target mode that a tap selected keeps its prompt ("Use Tinderbox with...") until it ends. The host
adds:

- **Options menu**: with `setHostMenus(true)` (Settings › Options menu: Large, the default, in both layouts) `menu.js`
  shows the client's menu as the 2004 menu with 40 px rows, beside the finger that long-pressed (`pointerId` from
  'menu-open'; on the side with more room, the top option level with the finger, never under it). Press-drag-release:
  sliding onto an option highlights it ('selection' haptic) and lifting there picks it ('light'); lifting elsewhere
  leaves it open for a tap; a tap beside it closes it. It is scaled with the HUD on a large screen.
- **Settings**: a stone sheet in the safe area (`#settings`), its categories down the left as the Game Options tab's
  buttons (Display, Sound, Controls, Tap options, World, Bot chat, Saved data, About; `host.js` `showSettingsSection`)
  and the chosen one's rows on the right, each category scrolling on its own if it must (Saved data's list). Display ›
  Screen margins (**Adjust**) opens a page of its own over the game (Side, Top, Bottom). The
  sheet keeps its height from one category to the next and opens again on the last one shown; Help and Save now (only
  in the world) at the top left, Restart in World (with a yellow mark on World while a changed setting waits for it).
  Gallery states `settings`, `settings-world`, `tapoptions`, `botchat`, `savedata` check the fit on every size.
- **Tap options**: Settings › Tap options (a category; the settings `npcAttack` and `playerAttack`) sends `setAttackOptions(npc, player)` (patch 0025, at once and
  at boot). Each is `'tap'` (Attack's entry never gets the 2000 priority offset, so it is the top entry), `'level'`
  (upstream: the offset when their combat level is above yours), `'hold'` (always the offset: a tap does the next entry,
  often Walk here) or `'hidden'` (no Attack entry). Only an op called "Attack" is affected, as upstream's level check.
- **Pinch zoom**: two fingers on the world (the HUD's world surface or the classic canvas's viewport) zoom the camera
  (`setCameraZoom`, saved in the `cameraZoom` setting); the first finger's gesture is cancelled (`cancelPointer`) and the
  second never reaches the client (its events stop in the capture phase until it lifts). The mouse wheel zooms on a
  desktop.
- **Hold ring**: a ring fills under a finger held still on the world, panel or chatbox from 140 ms until the long-press
  time, so a hold visibly works; not where a long-press would offer nothing but "Cancel" (`longPressable`). It gives up
  exactly where the client's long-press does: a move of more than 14 px along either axis.
- **Buttons** act on release and cancel when the finger slides off (16 px beyond the button or 28 px of travel). The
  keyboard, Run and Settings buttons move between the title's rail and the HUD (the options-menu button stays in the
  rail: the classic layout's only); a press on one that
  moves under the finger ends there without acting.
- **Hardware keys**: Escape closes what is on top: a confirm box, Settings (it opens again on the category it showed), the how-to card, the characters list, the options menu
  (the large one, or the drawn 2004 one with Options menu: Classic), a prompt, then a chatbox or panel the player opened
  (Tutorial Island's instructions are put away as by the chat button). Return and Space continue a dialogue that waits
  for "Click here to continue" (not while a chat line is typed). Return comes as `pressKey`; Space comes as typed text
  (`insertText(' ')`, through UIKit's text system) and otherwise types a space.

## 7. Page ↔ native contract

Page → native: `window.webkit.messageHandlers.native.postMessage(msg)`

| Message | Meaning |
|---|---|
| `{type:'ready'}` | Host page loaded. |
| `{type:'status', phase, detail?}` | `booting`, `engine-ready`, `title`, `ingame`, `error`. |
| `{type:'keyboard', action:'show', kind, prompt, text, secure, numeric, cancellable?, maxLength?, charset?, chips?}` | Show the native keyboard. `kind` ∈ `chat`, `login-user`, `login-pass`, `dialog`, `social`, `report`. The accessory bar shows `prompt` and `text` (`secure` → masked; on the login form the prompt is the form's status line, e.g. "Connecting to server...", while there is one). `cancellable`: a Cancel button (prompts). `maxLength` / `charset`: the bar refuses what the input would not take (with a warning haptic and a flash of the bar), each character checked against the line with the ones before it. `charset`: `chat` (public chat: ASCII 32-122, and 123-126, `{ \| } ~`, only while the line starts with `::`, the one place the client takes them), `text` (a private message: ASCII 32-122), `alnum` (the name to report: letters, digits, space), `game` (the password: exactly the client's `CHARSET`, letters, digits, space and the 2004 keyboard's punctuation, £ included), `name` (the username and name prompts: letters, digits, space, `-`, `_`), `digits` (an amount), `any`; a name native does not know means `any`. `chips`: `[{label, text, submit?, whenEmpty?}]` one-tap entries that replace the input line (and submit): `::` and the recent developer commands for chat, recent and common amounts for "Enter amount". `remember` (kind `login-pass`, online only): the bar's Remember box, ticked or not (§7.2, §7.5). |
| `{type:'keyboard', action:'update', prompt, text, chips?, charset?, maxLength?, cancellable?, remember?}` | Current input line changed (host polls the client while the keyboard is up). `chips`, `charset`/`maxLength`, `cancellable` and `remember`, when present, replace the bar's (the host sends `chips`, which change as commands and amounts are used). |
| `{type:'keyboard', action:'hide'}` | Dismiss. |
| `{type:'haptic', style}` | `UIImpactFeedbackGenerator` / selection feedback. The page sends none while Settings › Vibration is off, and native's own haptics (a refused key, a fatal error) follow that setting too. |
| `{type:'settings', values}` | Persist settings (native stores them; injected again on next launch). At boot the page checks them against the Settings sheet: a value it no longer offers becomes the nearest offered number (an earlier version's 450 ms hold: 400) or the default, saved once. |
| `{type:'fatal', message}` | Unrecoverable error. The page shows its own 2004 error screen with Restart; native logs it, plays the error haptic (unless Vibration is off) and lets the screen lock (no alert). |
| `{type:'clear-log'}` | Settings › Saved data › Delete everything: native empties its log (`Log.clear`: both files and the lines not yet written; the next line is `log cleared`). |
| `{type:'lm', id, mode, think, ambient?, local, online, maxChars, timeoutMs, fallback?}` | **Bots**: a bot's reply for the chat model to write (§7.1; `think`: Settings › Bot chat › Think first; `ambient`: a line of the bots' own talk, Settings › Bot chat › Bots' own talk). Answered through `LostCityHost.bots.lmReply`. |
| `{type:'lm-key', action}` | **Bots**: `set` opens native's secure box for the Claude key; `remove` deletes it (§7.1). Answered with a status. |
| `{type:'lm-warm'}` | **Bots**: the player starts to chat with the on-device model chosen (and it is not loaded), or enters the world while no quick load is on record: native loads it in the background (§7.1). |
| `{type:'socket', action:'open'\|'send'\|'close', id, purpose?, data?}` | **Online**: the page's WebSockets, opened natively to the page load's server (§7.2, §7.4). |
| `{type:'account', action:'save-password'\|'forget-password'\|'login', server, name, password?}` | **Online**: remembered passwords (§7.2, §7.5). |
| `{type:'server', action:'use'\|'delete'\|'ask', id?, title?, address?, name?}` | **Online**: switch server and reload, delete a server's cache and passwords, the Add / Edit server box (§7.2, §7.6). |

Console output goes through the separate `log` handler: `{level, text}`.

Native → page: `webView.callAsyncJavaScript` on `window.LostCityHost`

| Call | Meaning |
|---|---|
| `LostCityHost.lifecycle(event)` → Promise of `{ok, error}` | `pause` / `background` / `terminate` → engine saves all players and pauses (resolves after saves are written); `foreground` / `resume` → engine rebases its clock and resumes, client timers reset, audio resumed; `save` → save only. Never rejects: `ok: false` (a save could not be written, or the engine did not answer within 4 s) is a failed flush, and native retries it on the next suspending event. Native de-duplicates: after a successful `pause` it does not send `background`/`terminate`, and only the first of `foreground`/`resume`. |
| `LostCityHost.keyboard.insertText(text)` | Characters typed on the native keyboard, and a hardware keyboard's characters, Space included (a Space with the software keyboard down continues a dialogue, §6.2). A paste comes the same way: quotes and dashes as ASCII, line breaks as spaces, at most 80 characters (the longest input), and with no input requested only what chat takes. |
| `LostCityHost.keyboard.deleteBackward()` | Backspace. |
| `LostCityHost.keyboard.submit()` | Return key / the bar's button → `Enter`; on the login form (a username typed) it clicks **Login** instead, because Enter there only switches fields in the 274 client; an empty password is filled in (offline the engine loads the save by name). A `::` command or an amount is remembered for the chips. |
| `LostCityHost.keyboard.cancel()` | The bar's Cancel on a prompt: closes it (`hudCancelInput`). |
| `LostCityHost.keyboard.frame(overlap, duration, curve?)` | How much of the web view the keyboard and its bar cover (pt = CSS px, 0 when hidden) and the animation's length in seconds: the HUD lifts the chatbox above it, the title screen its login form. iOS sends no `curve` (the page's own, close to the iOS keyboard's); Android sends its IME's (docs/ANDROID.md §3.3). |
| `LostCityHost.keyboard.dismissed()` | The player dismissed the native keyboard. |
| `LostCityHost.keyboard.pressKey(key, down)` | Hardware keyboard keys as separate key-down (`down: true`, repeated while Backspace is held) and key-up events: `Enter`, `Backspace`, `ArrowLeft`/`Right`/`Up`/`Down`, `Escape`, `Tab`, `Control`, `F1`… Enter on the login form behaves like `submit()`. |
| `LostCityHost.memoryWarning()` | iOS memory warning. |
| `LostCityHost.battery(level, charging)` | The battery for the HUD's corner (§6.1): `UIDevice.batteryLevel` (0..1; -1 unknown, which hides it) and whether it is on the charger (`charging` or `full`). At `ready`, on becoming active and at each `batteryLevelDidChange` / `batteryStateDidChange`. |
| `LostCityHost.audio.setMuted(muted)` | Android only (docs/ANDROID.md §3.3): a fallback mute. |
| `LostCityHost.bots.lmReply({id, text, source, error?, ms, timings?, usage?})` | **Bots**: native's answer to `{type:'lm'}` (§7.1). |
| `LostCityHost.bots.lmStatus({local, online})` | **Bots**: the chat model's status changed (§7.1). |
| `LostCityHost.socket.events([{id, event, data?, code?, reason?}])` | **Online**: what the page's sockets received, in order (§7.2, §7.4). |
| `LostCityHost.accounts.saved({<server id>: [names]})`, `LostCityHost.accounts.login(name, password \| null)` | **Online**: which names have a remembered password; the answer to `account login` (§7.2, §7.5). |
| `LostCityHost.keyboard.remember(on)` | **Online**: the player tapped the keyboard bar's Remember box (§7.2, §7.5). |
| `LostCityHost.servers.answer({address, name} \| null)` | **Online**: the Add / Edit server box closed (§7.2, §7.6). |

Native → page at document start (WKUserScript): `window.LostCityNative = { platform: 'ios', appVersion, build,
osVersion, deviceModel, simulator, debug, settings, lm, savedPasswords }` (`lm`: the chat model's status, as `lmStatus` sends
it, §7.1; `savedPasswords`: as `accounts.saved` sends it, `{}` when none, §7.2, §7.5).

The native views (keyboard bar, loading cover, notices) use the same 2004 assets through `ios/LostCity/RSTheme.swift`, which
registers `Game/ui/fonts/*.ttf` with CoreText (process scope) and loads `Game/ui/sprites/*.png`. The loading cover is a
copy of the page's loader drawn at the page's zoom (§6.1, computed from the cover's own bounds and safe area), so the
hand-over at `ready` does not show.

### 7.1 The bots' chat model (Settings › Bot chat)

**Bots** (the engine's half: [BOTS.md](BOTS.md) §4.1 and §4.9). With a chat model the bots write the
words of their replies to the player; the engine still decides whether a bot replies, when, what it does, and its
fallback (the rules' line). Three choices, Settings › Bot chat (the setting `botChat`): **Rules** (the engine alone),
**On-device** (`local`: a small model in the app; the default when the app has one) and **Claude online** (`online`:
Claude Haiku 5.5 with the player's own key, falling back to the on-device model, then to nothing). With a model trained
both ways the same page offers **Think first** (the setting `botThink`): the on-device model writes a short note before
each reply ("asks: … uses: … tone: …", Qwen's think block), the page asks for it with every On-device request
(`think`). (Bots ideas, round 4) **Bots' own talk** (the setting `botAmbient`, `rules` or `model`; Rules by default
until the phone heat test passes and the player agrees): with Model the on-device model also words the bots' talk
between themselves near the player (a topic thread's turns after its opener, a bot's answer to another bot's question:
the engine's `port/BotModelAmbient`), always on the device and never with the note, even with Claude online.

```
engine worker (engine-bots.js)           page (host.js lm)                          native (BotChatModel, app process)
 {type:'bots-lm', id, mode, local,  ->   Rules, no native, the chosen model    ->   {type:'lm', ..., think}: at most 3
  online, maxChars, timeoutMs,           not there: null 'unavailable' at once;     at once (more: 'busy'); online:
  ambient?}                              ambient: local, think false
                                         else to native, + think (Think first)      OnlineModel, then LocalModel;
 {type:'bots-lm-reply', id, text,   <-   ms from the page's send; no answer    <-   local: LocalModel (think: the note
  source, error?, ms}                    by timeoutMs + 3 s: 'timeout'              first, if the model offers it)
                                                                                    LostCityHost.bots.lmReply(...)
 {type:'bots-lm-mode', mode, local, <-   before the world starts (on 'booted')      LostCityHost.bots.lmStatus(...)
  online, ambient}                       and on every change                        Keychain (the key), Model/ (GGUF)
```

- **Only the bots' engine hears any of it.** With the bots off the engine is `engine.js` and the page sends it no
  `bots-lm-*` message; native's model code stays idle (nothing is loaded until asked).
- **page → engine, `bots-lm-mode`**: `{mode, local, online}`: the player's choice and what is there (`local`: a model in
  the app; `online`: a key saved), sent right after `booted` (before `start`) and whenever the choice or the status
  changes. The engine asks only when the chosen backend, or its fallback, is there. While the model in the app rests
  for memory (the status's `local.rest`) `local` is false: the bots say their own lines and ask nothing. (Bots ideas,
  round 4) `ambient`: Bots' own talk is Model and can be used (`lm.ambientUsable`: a model in the app and a chat model
  other than Rules); false, the bots' own talk is the rules' and nothing of it draws a random number.
- **page → engine, `bots-lm-notice`**: `{lines}`: game messages for the humans in the world (at most 80 characters each),
  from host.js `lm.notice`: while the bots talk with the model in the app (On-device, or Claude online with no key), the
  player reads "Warning: low memory. The on-device chat model is off for 10+ minutes." and "Bots use scripted replies. Fewer bots (Settings > World) helps." once when a
  rest starts (or on entering the world while one lasts, 2 s after), and "The on-device chat model is back on." when it ends, if
  they were told it started in this world session.
- **engine → page, `bots-lm`**: `{id, mode, local: {system, user}, online: {system, context, user}, maxChars,
  timeoutMs}`. `local` is the on-device prompt (the engine's `renderLocal`: the fine-tuned model's training format),
  `online` Claude's (a static 2004 guide, cached, then the bot's facts). The page answers at once, with null and
  `'unavailable'`, when there is no native app (a desktop browser), when the choice is Rules, or when the chosen backend
  and its fallback are missing; otherwise it posts `{type:'lm', id, mode, think, local, online, maxChars, timeoutMs}`
  to native (the mode is the page's current choice; `think` the player's Think first as it is now, `botThink`, with
  On-device, else false: the engine never hears of it). (Bots ideas, round 4) `ambient: true`: a line of the bots' own
  talk near the player (`port/BotModelAmbient`; at most one request in 20 s world-wide, only with no request in flight,
  so a reply to the player never waits behind one): always `mode: 'local'`, and the page sends it with `think: false`
  and `ambient: true`, or answers `'unavailable'` at once when Bots' own talk is Rules, cannot be used, or the model
  rests.
- **page → native, `think`** (absent: false): the on-device model writes its note before the reply, if it is a model
  that offers the choice (the status's `local.think` `'option'`); a model that always or never writes one does as it
  was trained. The page sends it only with On-device: with Claude online it is false, so Claude's fallback to the
  on-device model answers without the note (native would honour it there; Claude online itself never thinks).
- **page → engine, `bots-lm-reply`**: `{id, text, source, error?, ms}`: native's line (`source` `local` or `online`) or
  null and why: `'unavailable'`, `'timeout'`, `'busy'`, `'refused'` (Claude refused the key, or declined the request),
  `'failed: …'` (`network`, `rate limited`, `overloaded`, `billing`, `permission`, `http <code>`, `empty`,
  `interrupted`, `decode <rc>`, …). `ms` is measured by the page from its send. A reply native never sends is answered
  `'timeout'` by the page `timeoutMs` + 3 s after the send; a late reply is then dropped.
- **native → page, `LostCityHost.bots.lmReply(reply)`**: `{id, text, source, error?, ms}` (native's own time), plus
  `timings` (on-device: `promptTokens`, `reusedTokens`, `promptMs`, `promptTps`, `generatedTokens`, `generateMs`,
  `generateTps`, `resampled`, `think` (the mode it ran in), `totalMs`, `loadMs` when this request loaded the model, and
  with the note `noteTokens` and `noteMs`: `generatedTokens`, `generateMs` and `generateTps` are then the reply's alone)
  or `usage` (Claude: `input`, `output`, `cacheRead`, `cacheWrite` tokens). The note itself never reaches the page.
- **native → page, `LostCityHost.bots.lmStatus(status)`** and `window.LostCityNative.lm`: `{local: {available, loaded,
  think, name?, bytes?, reason?, lastLoadMs?, rest?}, online: {keySet, hint?, valid?, problem?, model}}`. `rest`:
  `'memory'` while the on-device model rests because the phone ran short of memory (below). `think`: whether the on-device
  model writes its note, from its model.json template: `'never'` (also with no model that runs here), `'always'`, or
  `'option'` (the request's `think` decides: the page offers Think first only then). `reason`: `simulator` (no llama.cpp
  there), `no-model` (an app built without one). `lastLoadMs`: how long the model's last load took on this install,
  app version and system version, kept across launches (`ModelLoadRecord`: UserDefaults; Android SharedPreferences
  `lostcity-lm`); none until the first load after an install, an app update or a system update. `hint`: the key's last four characters (`…abcd`); the key itself never
  reaches the page. `valid`: false after Claude refused the key (401), true after it answered. `problem`: the last
  trouble in plain words (`key refused`, `declined`, `timed out`, `rate limited`, `overloaded`, `billing problem`, `no
  permission`, `error <code>`, `no connection`, `empty reply`, `not a key`).
- **`{type:'lm', …, fallback: false}`**: the page's Test button (a negative `id`): Claude's line or its error, never
  the on-device model's. The page routes negative ids to the Bot chat page, not to the engine.

**The fallback chain** (BotChatModel): `online` with a key → Claude; any failure (401, 402, 403, 429, 5xx, a refusal,
no text, the network, 8 s) → the on-device model with what is left of the request's time → null with the last reason.
`online` without a key → the on-device model. `local` → the on-device model or null `'unavailable'`. A request whose
`mode` is neither `local` nor `online` is answered `'unavailable'`. While iOS reports the phone's thermal state as
serious or critical the on-device model does not run (`'busy'`: the bots say their own lines until it cools down; Claude
online is not affected; the page's warm-up is skipped too). After the phone ran short of memory the on-device model
**rests** (`BotChatModel.memoryRest`, 10 minutes, then until iOS no longer reports memory pressure for the phone): on a
memory warning (UIKit's, or iOS announcing memory pressure for the whole phone: a `DispatchSource` memory-pressure
source at warning or critical), or when a load is refused for memory (too little left for the app, or the phone under
memory pressure: `kern.memorystatus_vm_pressure_level` at 2 or more, or where the app may not read it the last level
iOS announced). Meanwhile its requests answer `'unavailable'` at once, the warm-up is skipped, and the status says
`local.rest: 'memory'`, so the page tells the engine there is no model in the app (`bots-lm-mode` local false) and the
player in the chat (`bots-lm-notice`). A warning during a rest starts it again. Measured on an iPhone 13 mini with 1000
bots (2026-10-27): with the model loaded again 12 s after a memory warning, the next warning came 26 s later and iOS
ended the game's WebContent process 0.2 s after it (the page reloaded); before that iOS had ended WebKit's GPU process
twice (the whole screen black for a moment). The app also collects the page's heap on a warning and before a load
(§7.7). Claude online is not affected. At most 3 requests run at a time (the model
generates one at a time on its own queue; the others wait); a fourth is answered `'busy'` at once ((bots ideas, round 4
fixes) a line of the bots' own talk is not counted toward the replies' 3). Each request has the
page's `timeoutMs` (9 s) in all. (Bots ideas, round 4) **An ambient request** (the bots' own talk) is the on-device
model's whatever its `mode`, never with the note, and is refused at once: `'hot'` at thermal state fair or above (a
reply's gate stays serious: the heat's headroom is the player's), `'unavailable'` while the model rests for memory, and
`'busy'` while a reply to the player waits or runs on the model. It may load the model (so a trial is real: the model
then stays in while the player is near talking bots, and unloads after 5 quiet minutes). The model's queue serves the
replies first (`LocalModel.generate`'s `ambient`: a line of the bots' own talk waits behind every reply asked before it
runs; (round 4 fixes) one running when a reply is asked stops at its next token, `LocalModel.Failure.preempted`, and is
answered `'busy'`, which the engine falls back on: "#N local (ambient): stopped for a reply to the player: busy"). Its
log lines say `(ambient)`; the counters (`lm-status`) count them (`ambient`, `ambientRefused`, `ambientStopped`).

**The on-device model** (`ios/LostCity/LocalModel.swift`): llama.cpp (the prebuilt framework of release **b11297**, linked
for the device only: its release has no simulator slice, so on the simulator the model is `unavailable`, reason
`simulator`) running the bundled GGUF on the GPU (Metal, all layers), in the app process (not the game's WebContent
process, whose memory it would share).
- The model is `Model/model.json` + its GGUF in the app bundle (`build/Model/`, filled by `ios/scripts/prepare-model.sh`:
  the 2004 model from the cache (`--download` fetches it), or `--spike` for the untrained Qwen3.5 0.8B Q4_K_M, or `--none`). No model: the app builds and runs,
  and Bot chat says "Not in this build".
- model.json's `template` says whether the model writes a short note before its reply (`LocalModel.ThinkSupport`, the
  status's `local.think`): `qwen-chatml-nothink` never (the first 2004
  model; also any template the app does not know, which `prepare-model.sh` refuses), `qwen-chatml-think` always (the
  note variant), `qwen-chatml-hybrid` when the request's `think` asks (one model trained in both modes, Qwen3.5's
  thinking switch; Settings › Bot chat › Think first). A request writes the note when hybrid ? its `think` : the
  template's.
- Loaded at the first request, or ahead of it with On-device chosen (or Claude online without a key, which answers with
  it): the page's `{type:'lm-warm'}` (host.js `lm.warm`) when the player starts to chat while it is not loaded (the chat
  keyboard opens on the chat, a private message or another social prompt, or a hardware keyboard types there, not a
  Space that continues a dialogue; asked once while it loads), so it loads while the line is typed. A staff character
  (Settings › World › Jmod) warms it only at a chat line a bot may hear: once the line is neither empty, `:` nor a `::`
  command, which the client sends as a command and never as chat, judged with the keys the client has not read yet
  (its key queue and the page's), so a `::tele` typed however fast does not load it; a normal player's `::` does
  nothing, so for them the keyboard's opening does, the timing measured on the iPhone. And on entering the world (or
  choosing it there) only until a load here has been quick (the status's `lastLoadMs` under 5 s): the first load after
  an install, an app or a system update is the slow one on an iPhone, and it starts as soon as the player is in the
  world. A world entry with no chat after it so leaves the model out (about 140 MB of the app process for 5 minutes on
  an iPhone 13 mini, about 680 MB on Android). Not when memory is short: under 256 MB left
  for the app (`os_proc_available_memory`; Android: under 1 GB free above ActivityManager's low-memory line, the load
  itself being about 680 MB there) the request answers `unavailable` and the bots say their own lines. Unloaded after 5
  idle minutes, on a memory warning and in the background; a memory warning also stops the reply being written and
  drops those waiting (`failed: interrupted`), so the model is freed at once, not after them. A moment's inactivity (Notification or Control Center, a call banner) only stops the
  generation in progress at its next token (no GPU work then) and keeps the model loaded; it is freed once the app is in
  the background. While iOS reports the phone hot (thermal state serious or critical) the on-device model does not run:
  its requests answer `busy` and the bots say their own lines. A load takes about 1 s on an iPhone 13 mini (0.4 s again soon after), and about 15 s the first time after
  an install (Metal prepares llama.cpp's shaders once).
- The prompt: Qwen's chat template, thinking off, exactly as the model was trained:
  `<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`
  (the turns trimmed; the markers tokenized as special tokens, the turns' text as plain text, so a chat line can never
  become a marker). With the note the prompt ends at the open think block (`…<|im_start|>assistant\n<think>\n`, the
  template's enable_thinking): the note ("asks: <topic>. uses: <the facts it will state>. tone: <the persona's>.") is
  sampled freely (no grammar) to the block's close, at most 64 tokens (then closed for it: the untrained base model
  always runs to it), the blank line after it as trained, then the reply as without one. Only the reply is the answer;
  the note stays in native (the bench's `generate` shows it).
- Sampling: top-k 40, a repetition penalty of 1.1 over the last 64 tokens, top-p 0.9, temperature 0.8; at most 40
  tokens; stop at a newline, an end-of-generation token (`<|im_end|>`, `<|endoftext|>`), a control token or a think
  block marker (`<think>`, `</think>`: plain added tokens in Qwen3.5's vocabulary, whose text the grammar would pass);
  a GBNF grammar keeps the line to the chat's characters (`root ::= [ -z]{1,120}`; the engine's guard cuts to 80). The
  chain samples in C (llama.cpp's `llama_sampler_sample`); only a token the grammar refuses sends the whole vocabulary
  through the grammar (llama.cpp's own optimization). The log line of each reply says its mode (`think on` / `off`) with
  its timings and, with the note, the note's tokens and time.
- Context 1,024 tokens, one sequence, one output (`n_outputs_max` 1: the default reserves logits for a whole 512-token
  batch, a 490 MB compute buffer instead of 41 MB), 2 threads. The tokens of the last prompt stay in the context; a
  prompt that starts the same way reuses them where the model's memory allows. Qwen3.5 is a hybrid whose recurrent layers
  keep one state for the whole sequence, so with it only a pure extension of what the context holds is reused, and any
  other prompt starts afresh (a cut back would clear the recurrent state but keep the attention's).
- Answers are tied to the page that asked: when the page goes away (a reload, a new document), answers still being
  written are dropped, since the new page counts its request ids from 1 again.

**Claude online** (`ios/LostCity/OnlineModel.swift`, the key in `ios/LostCity/ModelKeyStore.swift`): `POST
https://api.anthropic.com/v1/messages` with `x-api-key`, `anthropic-version: 2023-06-01`, `content-type:
application/json`; the body `{model: 'claude-haiku-5-5', max_tokens: 60, thinking: {type: 'disabled'}, output_config:
{effort: 'low'}, system: [{type: 'text', text: <the guide>, cache_control: {type: 'ephemeral'}}, {type: 'text', text:
<the bot's facts>}], messages: [{role: 'user', content: <the chat>}]}` (no sampling parameters: Claude Haiku 5.5 refuses
non-default ones). Every field was checked against the official documentation (the URLs are in the file's header). The
reply's text blocks are read by type; `stop_reason: "refusal"` (an HTTP 200 with empty content) counts as declined.
8 s at most. The key lives in the Keychain (a generic password, `AfterFirstUnlockThisDeviceOnly`), typed into a
`UIAlertController` with a secure field (the keyboard bridge gives up first responder while it is up); it is never in
the page, a file, a log or the settings.

**Settings › Bot chat** (host.js `botChat`, a category of Settings): the Chat model buttons (Rules / On-device / Claude
online; applied at once), the model in the app (name and size, "loaded"; or "Not in this build", "Not on the
simulator", "Only in the iPhone app"), **Think first** (Off / On, the setting `botThink`; shown only while the status's
`local.think` is `'option'`; "The bots plan each reply first: about a second slower."; greyed out,
its buttons off and its choice kept, with "Only with the On-device chat model." while Rules or Claude online is chosen
(it has no use there: the page sends `think` only with On-device); applied at once:
the next request carries it; its default is host.js's `BOT_THINK_DEFAULT`, On), the Claude key (Not set / Ends in …abcd, and why it does not work; Set key / Change, Remove with a confirm
box), Test (one line from Claude) and what Claude online sends ("the chat and the bot's state go to Anthropic"). (Bots
ideas, round 4) **Bots' own talk** (Rules / Model, the setting `botAmbient`, default Rules; "Talk between bots near
you" (round 4 fixes: stage 1 words no reactions to the player; stage 2's row would say "Reactions to you and talk
between bots near you"); greyed out, its buttons off and its choice kept, unless the on-device model is in the app and a
chat model other than Rules is chosen: "Only with the on-device model.", "Only with a chat model (not Rules).", "Only in
the iPhone app"; applied at once: the engine hears it in `bots-lm-mode`). It fits
an iPhone 13 mini without scrolling, also with Display Zoom (320 px tall: its rows a little tighter there; (round 4
fixes) tighter still on a layer under 370 HUD px, `html.ui-short`, Display Zoom's and Android's 360, so it fits there
too: gallery.mjs's `botchat` fails if it scrolls from 320 HUD px up).

**DEBUG builds** add `{type:'lm-bench', id, action, …}` (a benchmark of the on-device model: `generate` {system, user, think?, timeoutMs}:
the line, its timings and its note; `stats` (the model's note support among them), `options`, `unload`; answered through
`window.__lcDebugReply`) and the debug actions `lm-status`, `lm-endpoint` (point Claude at a local mock:
the tests never call the real API), `lm-key-alert` (type into the key's secure box and press Save or Cancel) and
`activity` (keep the screen awake during a long in-app test).

**Tests**: `web/test/e2e.mjs --lm-stub` (the relay in Chrome, a stub native, a request posted from inside the engine
worker; Think first: shown for `'option'`, the requests' `think` as the setting says at once, kept across a reload;
(bots ideas, round 4) Bots' own talk: Rules by default, Model saved and heard by the engine at once, an ambient request
to native with `mode: 'local'` and `think: false` (also with Claude online), greyed out with Rules and without native,
kept across a reload;
the warm-up: a chat line typed either way loads the model once; a Jmod's `::` command typed any way, with no gap
between the keys too, never does; with `--no-jmod` the chat keyboard's opening does),
`web/test/native/lm-harness.mjs` (the app's BotChatModel, OnlineModel and LocalModel compiled for the Mac against the
macOS framework and a local mock of the Messages API, `web/test/lm/mock-claude.mjs`; with a hybrid model, the base GGUF
with a model.json `"template": "qwen-chatml-hybrid"` beside it put in by `prepare-model.sh`: no note when off, the note
first when on, also on Claude's fallback, never in the reply, and the templates that decide alone; (bots ideas, round
4) an ambient request: the on-device model even with a key, refused 'hot' at fair (a reply still answered), 'busy'
behind a reply, 'unavailable' while resting, never the note, the queue serving the replies first, (round 4 fixes) one
running stopped by a reply ('busy') and not counted toward the replies' 3, a load for it;
Android's `android/test/native/lm-harness.mjs` the same), the `lm` phase of
`web/test/native/drive.mjs` (the simulator: status (`think` 'never': no model runs there), the key's secure box,
requests to the mock with and without `think`, `botThink` kept across a reload), `web/test/hud.mjs` (the page's fit,
Think first shown or not by the status), `web/test/gallery/gallery.mjs` (the page on every phone size, `mini-zoomed`
and `se-zoomed` when named: never scrolling) and `web/test/app-test.mjs --device --lm-bench` (the on-device model's benchmark;
`--lm-think` benches the note mode).

### 7.2 Online mode

**Online** ([ONLINE.md](ONLINE.md) for players and server owners): the page plays on one game server, an Engine-TS 274,
per page load. The page never touches the network: native code carries the client's sockets (the socket bridge) and
fetches the server's files (the proxy routes). Switching server, or between online and the world on the phone, reloads
the page. Offline nothing here applies: the bundle, the routes and the page behave as before.

**The choice** (settings, checked at boot like the others: a malformed entry dropped, an address stored normalized, a
correction saved once; never a password):

```
server   'offline' | '<server id>'                          default 'offline'
servers  [{ id, name, url, nodeId, members, rsa, added }]   at most 50; id /^[A-Za-z0-9_-]{1,40}$/ (the page makes 's-' + 8 base36)
         name 1-40 characters (else the host); url normalized; nodeId 1-65535 (default 10); members (default true);
         rsa { n, e } decimal strings, or null (the build-time key); added ms
accounts { '<server id>': [{ name, lastPlayed }] }          usernames only, newest first, at most 20
rememberDefault { '<server id>': boolean }                  the Remember box's last state on each server
```

The page is online when `server` is the `id` of an entry whose `url` normalizes; native decides the same way when the
page's `/index.html` is requested, and that holds for the page load. Address rules (`web/host/serverurl.js`, the same
on every side, vectors in `web/test/online/serverurl-vectors.json`): `host`, `host:port`, `http(s)://` or `ws(s)://`
with an optional path; ws is http and wss https, no scheme is http, the host lower-cased (IPv6 in brackets), a default
port dropped, no trailing slash, query or fragment; credentials, other schemes, a bad port, `.`/`..` segments are not
addresses. The socket URL is the base with http → ws, https → wss (`/` when there is no path). No host is refused or
treated specially.

**The socket bridge** (page → native `{type:'socket', …}`; native → page `LostCityHost.socket.events(batch)`):

| Message / event | Meaning |
|---|---|
| `{action:'open', id, purpose}` | A WebSocket to the server's socket URL, subprotocol `binary`, no `Origin`, the app's User-Agent, 10 s to open. `id` 1, 2, 3… per page; `purpose` `'game'` (the client's) or `'ondemand'` (LocalOnDemand's: `lcHost.openSocket`), for the log. |
| `{action:'send', id, data}` | One binary message, standard base64 with padding; in order per socket, queued until open. |
| `{action:'close', id}` | Close (1000); native sends nothing more for that id. |
| `open` / `message` (`data`: base64) | The upgrade done; one binary message (a text message: error `text frame`, closed 1003). |
| `error` (`reason`) | `refused`, `timed out`, `not found`, `dns`, `tls`, `http <status>` (the upgrade refused), `local network` (the phone's local network privacy refused it: iOS's Local Network, Android 17's permission), `network` (a drop too, and an unknown host while the phone has no network), `no server` (an offline page). Always followed by `close` 1006 with the same words. |
| `close` (`code`, `reason`) | Final. A close from the server keeps its code. |

Native batches what arrived together into one call, in order (everything within 2 ms of the first: iOS §7.4, Android
ANDROID.md §7), and closes a page's sockets when it goes away
(a reload, WebContent's or the renderer's death). No keep-alive in the background: a socket that died while the app
was suspended is reported when it runs again, and the client's own reconnect (opcode 18) does the rest. The page's
`NativeSocket` has EngineSocket's surface; it sets `readyState` 3 before `error` and `close` fire (a socket still
connecting that gets `close` alone fires `error` first). Connections are logged with the host and code, never their
contents.

**The proxy routes** (native, while the page load is online; offline these paths are the bundle's as before):

| Route | Behaviour |
|---|---|
| `GET /crc…` | `<base>/crc` (10 s), 40 bytes with the client's trailer; 200, `no-store`, kept for the page load. Else 502 with one line: `unreachable`, `timed out`, `not a 2004scape server` (404, the size, the trailer), `http <status>`, `local network`. |
| `GET /<jag><crc>` (title, config, interface, media, versionlist, textures, wordenc, sounds) | The bundled file of that name (same name, same CRC, same bytes); else `<caches>/online/<id>/<jag><crc>` when its CRC32 is the name's; else `<base>/<jag><crc>` (30 s), its CRC32 checked, stored atomically, served; else 502 (the words above, or `checksum mismatch`). |
| `GET /ondemand/<archive>/<file>` | `<caches>/online/<id>/od/<archive>/<file>`, or 404. Archive 0-3, file 0-65535 in plain decimal, else 400. |
| `PUT /ondemand/<archive>/<file>` | Stores it (1 byte to 4 MiB, else 400/413): 204. iOS: the body; Android: `X-LC-Body` + `X-LC-Length` as the saves. Offline: 405. |
| `GET /server-probe?url=<address>` | In every mode: `{ok, error?, url, crc, nodeId, members, rsa, notes}`. `ok` = a good `/crc`; then `rs2.cgi`'s `new Client(<nodeid>, <lowmem>, <members>)` (else 10 and members, noted) and the key pair in `client/client.js` (`rsaenc(BigInt("…"),BigInt("…"))`, either quote, or the only adjacent pair of a minified bundle; else null, noted). `error`: `invalid address` or a `/crc` word. 400 without `url`. The first time `/crc` meets the iPhone's Local Network question (once per install), it is tried again each second for up to 30 s while the player answers. |

`<caches>` is iOS `Library/Caches` (purgeable: re-downloaded when needed), Android `cacheDir`. Deleting a server deletes
its folder and its kept passwords.

**Accounts and passwords**:

| Direction | Message | Meaning |
|---|---|---|
| page → native | `{type:'account', action:'save-password', server, name, password}` | After a new login reached the world (not a reconnect) with Remember on. iOS: a Keychain generic password (service `<bundle id>.server`, account `<server id>/<lower-case name>`, `AfterFirstUnlockThisDeviceOnly`); Android: an AndroidKeyStore-wrapped AES-GCM file. Refused for an unknown server, a name not 1-12 or a password not 1-20 characters. |
| page → native | `{type:'account', action:'forget-password', server, name}` | Remember off at such a login while one was kept, Accounts › Forget password, Accounts › Remove. |
| page → native | `{type:'account', action:'login', server, name}` | "Continue as", Accounts › Log in: native answers `LostCityHost.accounts.login(name, password \| null)`. With a password the page fills the form and presses Login (keeping nothing); with null it fills the name and opens the password field. The page takes an answer only for the name it asked for, within 30 s, on the title. |
| native → page | `LostCityNative.savedPasswords` (document start), `LostCityHost.accounts.saved(map)` (after each change) | `{<server id>: [lower-case names]}` with a kept password, `{}` when none. |

The keyboard's `show` for `login-pass` carries `remember: true|false` online (absent offline: no box), and every
`update` while it is up; native draws a 2004 checkbox "Remember" in its bar left of the submit button, and a tap flips
it and calls `LostCityHost.keyboard.remember(on)`. The page's first state: on when this name has a kept password, else
`rememberDefault[<server id>]` (off at first); a tap becomes that default.

**The server choice**:

| Direction | Message | Meaning |
|---|---|---|
| page → native | `{type:'server', action:'use', id}` | Sent after the page's `settings` message with the new `server`: native stores it, closes the page's sockets and reloads (its usual cover, with the right caption); also for the server in use, after Edit › Use changed its entry. An id that is neither `offline` nor in `servers` is ignored. |
| page → native | `{type:'server', action:'delete', id}` | Native deletes the server's cache folder and kept passwords (the page has removed the entry from the settings). |
| page → native | `{type:'server', action:'ask', title, address, name}` | Native's Add / Edit server box (Address, placeholder `192.168.1.20 or my-mac.local:8888`; Name, optional; Cancel / OK), in the Claude key box's style: `LostCityHost.servers.answer({address, name} \| null)`, trimmed. `title` `Add a server` or `Edit <name>`; `address`/`name` the prefill (`''`: the placeholders). |

**The page online** (host.js): `window.WebSocket = NativeSocket`; `lcHost.server` set; no engine worker, no VFS,
no bots or chat model; `engineState` `'remote'`; the loader waits for the client alone; the client's timers are not
frozen in a pause (the server keeps ticking: a socket that died must be noticed). Hidden or off: Save now, the autosave,
the save warnings, Settings › Bot chat and Saved data, Settings › World's world rows and Restart (one note instead;
Detail stays), the engine's timeouts and "The world is still starting…", the password filled in (online the
username's key goes on to the password field). Back: Report abuse in the HUD's chat bar. The words: the loader caption
"online" (one text node set before the first paint, so native's covers match it pixel for pixel), the title's hint and
World button, New User's hint ("Type a name and a password. / Your server may ask you to register first.") and
response 6 ("This server runs a different / game version or key."), replaced as the client sets them, About
("Online: <name> (<host>)"). A `/crc` 502 at boot (the page asks once beside the client), the client's own retry screen,
or a login whose socket failed opens the unreachable box within seconds: the reason in plain words, Try again (a
reload), Play offline, Choose world. The worlds sheet (the title's World button, Settings › World › Play on › Change):
This phone (offline), the servers (Edit, Delete with a confirm box), Add server (native's box, then the probe's result
in the sheet: Use, Save, Cancel). An Edit to another address of a server with kept passwords asks "The same server?"
first (Forget sends `forget-password` for each). A login with a kept password that ends on the title (refused) leaves
the form to the player: a password typed there is kept by the Remember box as any other. The stored server settings are
compared with sorted keys (native keeps them sorted), so they are saved again only when something was corrected. A
game socket the server opened and never answered (the client gives up after 30 s, patch 0031) shows the box with
`timed out`. Switching: offline the world is saved first (as Restart); online in game the page logs out
through the client (the Logout tab, then its button, until the title shows, at most 5 s; else it says so and stays),
then `settings` and `server use` (while the connection is lost and the client reconnects, at once: there is nothing to
log out of).

**The client**: patch 0030 encrypts the login with `lcLoginKey()` (the server's key) or, null, the build-time key (the
same packet offline). Patch 0031: a login read that times out with the socket still open (a server that never
answers) is an IO error, the socket closed, where upstream rethrew and its loop ended. LocalOnDemand (overrides `io/OnDemand.ts`) checks the bundled files against the server's
versionlist; another version comes from `GET ondemand/…`, else over an OnDemand `NativeSocket` with upstream's protocol
on the main thread (no Worker, no IndexedDB), is checked, kept in memory and `PUT` back (web/client/README.md). Its 20 ms
timer stops when nothing is queued or pending, except in game (the keep-alive).

**Tests**: `node web/test/serve.mjs --check` (the desktop double's routes, probe, bridge, against stub servers),
`node web/test/e2e.mjs --engine <copy> [--platform android]` (end to end against a local Engine-TS and its variants),
`node web/client/test/run.mjs` §17 (the login key, a failed socket, the OnDemand fallback), `web/test/gallery/gallery.mjs`
(the online states on every screen). `web/test/online/native-double.mjs` is native's side for those desktop runs, a
reference for the contracts above. In the apps: `web/test/native/drive.mjs --online` and `android/test/drive.mjs
--online` (the native layer: bridge, proxy, probe, Keychain or Keystore, the server box, Remember), and `app-test
--server` on both (`web/test/app-test.mjs`, `android/test/app-test.mjs`: the same `autotest.js` run against a local
Engine-TS, docs/BUILDING.md §4). Android's native side is described in [ANDROID.md](ANDROID.md) §7.

### 7.3 Online on iOS: the server of a page load

`settings.server` (`'offline'` or a server id) names an entry of `settings.servers` (`{id, name, url, nodeId, members,
rsa, added}`, kept by the page). Native reads it when a page starts loading (the main frame's navigation: a load, a
reload the page does itself, a restart after a crash) and keeps it for that page load: the routes of §3.1 and the
sockets of §7.4 use it. It plays on the server when the id is a plain name (1-64 letters, digits, `-`, `_`; it names a
cache folder) and the entry's `url` normalizes (the page's rules: no scheme, `ws` → `http`, `wss` → `https`, default
ports dropped, the host lower-cased, query, fragment and a trailing `/` dropped; credentials, other schemes and bad
ports refused). No host is refused or treated differently. Anything else is offline, and the app behaves exactly as
without online mode. The loading cover's caption ends in `online` or `offline` to match the page's, and the restart
notices after a WebContent crash add "You will need to log in again." online. `ios/Config/Info.plist` allows
user-typed `http`/`ws` hosts (`NSAllowsArbitraryLoads`) and explains the Local Network prompt
(`NSLocalNetworkUsageDescription`).

### 7.4 Online on iOS: the socket bridge (Swift `SocketBridge`)

Online the page's `NativeSocket` replaces `window.WebSocket` and its sockets are native `URLSessionWebSocketTask`s to
the page load's server: the base URL with `http` → `ws`, `https` → `wss` (path or `/`), whatever URL the client asked
for. `open` (`purpose` `game` or `ondemand`, for the log) upgrades with `Sec-WebSocket-Protocol: binary`, the app's
User-Agent, **no Origin** and no cookies, within 10 s. `send` (`data`: base64 of one binary message) waits until the
socket is open; sends go one at a time, in order. `close` closes with 1000; after it no event comes for that id, and
`send`/`close` for an unknown id or `open` for an id in use are ignored.

`LostCityHost.socket.events` carries `open`; `message` (`data`: base64); `error` (`reason`: `refused`, `timed out`, `not
found`, `dns`, `tls`, `http <status>` for a refused upgrade, `local network`, `network`, `no server` offline, `text
frame`), always
followed by `close` with 1006 and the same words; `close` (the server's code and reason). Messages that arrived before
a close are delivered before it. Events go in one call per batch (everything within 2 ms of the first: receives complete
one main-queue block at a time, so a burst arrives over several run-loop turns; on the simulator 50 messages sent in one
write came in one call). A page that goes away (reload, WebContent ended) has its sockets closed (1001) and its pending
events dropped. Nothing is kept alive in the background; a socket that died meanwhile reports its close when the app
runs again. The log has the host, purpose, open, close code, error and message counts, never contents (the login block
holds the password).

### 7.5 Online on iOS: accounts and the Remember box (Swift `ServerPasswordStore`, `KeyboardAccessoryBar`)

Passwords are remembered only when the player asks (the Remember box), in the Keychain: generic passwords of the
service `<bundle id>.server`, account `<server id>/<lower-case name>`, `AfterFirstUnlockThisDeviceOnly`. Never in the
settings, the page's storage, a file or a log. `save-password` (after a login that worked, Remember on) is refused for
a server not in `settings.servers`, a name not 1-12 characters or a password not 1-20; `forget-password` removes one;
`login` answers `accounts.login(name as sent, password | null)`, and the page fills the form and clicks Login without
keeping it. `accounts.saved` (lower-case names per server id in `settings.servers`) follows every save, forget and
server delete, and `LostCityNative.savedPasswords` carries the same at document start. Keychain items outlive the app:
at launch, once the stored settings are read (or there are none), the passwords of server ids not in `settings.servers`
are deleted (`ServerPasswordStore.purge`).

**Local Network** (`LocalNetworkPrivacy`): the first connection to the player's network brings up the system's question,
and while it is up, or after Don't Allow, URLSession fails at once with "not connected to the internet" (the path:
"Local network prohibited"). That failure, or one to a local address (Android's rule: private, link-local and
unique-local literals, `.local` names), is reported as `local network`; the page says where to allow it.

The keyboard's `show` for kind `login-pass` online carries `remember: true|false`: the bar shows a 2004-style check box
"Remember" (the Game Options tab's small button with a yellow tick) left of Log in. A tap flips it and calls
`LostCityHost.keyboard.remember(on)`; the page's next `remember` wins, and an `update` without it leaves it. Without
`remember` (offline, the username) there is no box.

### 7.6 Online on iOS: server choice and the Add server box

`server use` stores `settings.server` (`offline` or an id in `settings.servers`; any other id is ignored), closes the
page's sockets and reloads the page through native's load path, with the cover's caption for the new choice; it always
reloads, also for the id in use. `server delete` deletes the server's cache folder and remembered passwords (the page
removes the entry). `server ask` shows a native alert in the Claude key box's style: `title`, fields Address
(placeholder `192.168.1.20 or my-mac.local:8888`) and Name (`Optional`), prefilled from `address`/`name`, Cancel / OK,
answered with `servers.answer({address, name})` (trimmed) or `null`. The page probes the address (`/server-probe`) and
shows the result.

Tests: `web/test/native/drive.mjs --online` (game-test/online.js against web/test/native/online-stub.mjs, an address
where nothing listens and, with `ENGINE_URL`, a local Engine-TS), with the debug hooks `server-alert`, `remember-tap`,
`online-state`, `online-cache`, `last-notice`, `url-normalize` (native's address rules over every vector of
web/test/online/serverurl-vectors.json, the page's own test file) and `purge-passwords` (the launch's sweep), and the
built app's `NSAllowsArbitraryLoads` and `NSLocalNetworkUsageDescription` (drive.mjs reads its Info.plist: the test
servers are IP literals, which ATS does not cover) (ios/LostCity/README.md).

### 7.7 The page's JavaScript heap (iOS: `PageMemory`)

WebKit lets a JavaScript heap grow to about twice what is alive in it before it collects it in full, and the page's
heap (the client's; the engine worker has its own) holds garbage that outlives WebKit's quick young collections. On an
iPhone 13 mini at Lumbridge with 1000 bots (2026-10-27, read through the phone's Web Inspector) 180 MB of it was alive
and it reached up to 390 MB; one full collection gave back 182 MB of the game's WebContent process at once (a full
collection of the engine worker's heap gave back only 10-20 MB). So the app collects the page's heap itself: every 30 s
while the player is in the world and the app is active (WebContent's median 776 -> 742 MB, the page's heap 274 -> 222;
frames over 25 ms 7 -> 9 in 4 minutes), and at once on a memory warning or memory pressure (`BotChatModel.onMemoryWarning`,
with the chat model's own rest, §7.1) and just before the bots' chat model loads (`onWillLoad`: a warm-up, or a request
while it is not in memory). WebKit has no public call for it: `PageMemory` uses WKProcessPool's
`_garbageCollectJavaScriptObjectsForTesting` (each web process's main-thread VM), looked up at run time; a WebKit without
it is left alone (logged once). Not on Android (WebView has no such call; V8 sizes its heap differently). Debug hooks:
`page-gc` (one collection), `page-gc-every` (`{sec}`: the timer's period, 0 = off; the soak option `pageGcEverySec`).

## 8. World configuration (engine `data/config/world.json` in the VFS)

`build.liveReload=false` (no packer thread), `node.id=10`, `node.members=true`, `node.production=false`
(no login rate limits; staff level 4 → `::` dev commands in single-player unless Settings › World › Jmod is Off, which
sends `staffModLevel: 0`: a normal player). Other flags as decided by
the engine build (documented in `web/engine/README.md`). **Bots**: `bots.count` (0–1000), and for tests and debugging
`bots.debug`, `bots.spawnPerTick` and `bots.pathSearchesPerTick`; the engine's `WorldConfig` ignores them, the bots' glue reads them from the merged
file. **`staffModLevel`** (0–4) likewise: `runtime/threads.ts` (the offline login) reads it once and gives it to every
login.
