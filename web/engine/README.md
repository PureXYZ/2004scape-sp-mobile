# Engine worker (`web/engine`)

Engine-TS 274 (the LostCity game server) bundled to run as a **module Web Worker inside the app's web view** (WKWebView on
iOS, Android System WebView on Android), next to the web client. Single player, offline, no engine source patches. Contract: `docs/ARCHITECTURE.md`
(§2 layout, §4 page↔engine protocol, §5 saves, §8 world config).

```
node web/engine/build.mjs --out build/Game [--debug] [--no-bots] [--autotest]   # or: import { buildEngine } from './web/engine/build.mjs'
node web/engine/test/all.mjs [--skip-chrome] [--port P]    # every test below, ~10 min (the bots against the real library and the stub)
```

With bots (`docs/BOTS.md`) the build also writes `engine-bots.js`, which boot.js loads instead of `engine.js` only when
`init.config.bots.count > 0`; `engine.js` stays exactly the vanilla engine. See [Bots](#bots-docsbotsmd).

## Output (`<out>` = the Game folder)

| File | What |
|---|---|
| `engine/boot.js` | Module-worker bootstrap (3.5 KB). Preloads the vfs, merges `init.config` into `world.json`, imports `engine.js` (or, with `init.config.bots.count > 0`, `engine-bots.js` after also preloading `vfs-manifest-bots.json`), forwards the worker console. |
| `engine/engine.js` (+ `.map` in debug) | The bundle: `src/entry.ts` + 432 engine sources + 3 npm packages (fflate, kleur, ttlcache) + `src/shims`. Release 464 KB (128 KB gzip, 104 KB brotli); debug 980 KB + linked map. |
| `engine/bzip2.wasm` | The engine's libbzip2 build (87 KB). Optional: without it (or without WebAssembly) a TypeScript decoder is used. The host page loads it too, for the client's jag archives (`web/host/bzip2.js`). |
| `engine/vfs-manifest.json` | `[[vfsPath, urlRelativeToEngineDir], …]` – 38 entries. |
| `engine/vfs/**` | 32 runtime files (21.6 MB) incl. the generated `data/config/world.json` and `data/derived/startup-tables.json`. |
| `cache/main_file_cache.{dat,idx0..4}` | The cache (8.9 MB), shared with the client; the manifest points at `../cache/…`. |
| `engine/engine-bots.js` (+ `.map` in debug) | Unless `bots: false`: `src/entry-bots.ts` = the same entry and engine + the bot library (`bots/src`, `#/engine/bot/*`) + the glue (`src/runtime/bots`). |
| `engine/vfs-manifest-bots.json` | What boot.js preloads on top of the 38 for `engine-bots.js`: 1 entry. |
| `engine/vfs/bots/scripts.bin` | The bots' content-script overlay (24 scripts, 14.5 KB; `bots/content/compile.mjs`). |

`buildEngine({ out, debug = false, engineDir, contentDir, bots = {}, autotest = false })` (the directories default to the upstream
checkouts `scripts/lib/upstream.mjs` resolves) returns
`{ ms, bundle: {bytes, gzip, inputs}, data: {files, bytes}, startupTables: {bytes, reused, ms}, redirects, injectedBuffer,
processRefs, bots }`. It deletes and rewrites `<out>/engine` and `<out>/cache` only. Build time ≈ 0.15 s (files are APFS
clones), + ~0.1 s for the bots bundle; the start-up tables come from `build/tmp/startup-tables` (14 ms) unless the
cache, the loaders or `startup-tables.mjs` itself changed (~0.4 s to make them again). `bots`: `false` = the vanilla files only; `{ lib, overlay, rebuildScripts }` = the bot library (default
`bots/src`), a `compileBotScripts()` result to use (else it is compiled or taken from the cache), force a recompile.
`autotest: true` (`scripts/build-web.mjs --autotest`, the in-app test's build) bundles `src/autotest/entry.ts` and
`src/autotest/entry-bots.ts` in place of the two entries: the same entries plus the engine's measurements for
`app-test --soak` (below, [Test builds](#test-builds-autotest)); the build fails if a test build's bundle lacks them or a
normal build's names them (`'lctest-perf'`).
`info.bots` = `{ ms, lib, bundle: {bytes, gzip, inputs, libModules}, data, overlay: {key, reused, scripts, bytes, base,
patches, vanillaScriptDat}, commands, injectedBuffer, processRefs }`.

### Runtime file set (what the engine reads – verified, not guessed)

`test/vm.test.mjs` records every vfs path the engine touches during the full session and fails if any staged file is
never read: all **38** are used.

| vfs path | Size | Reader |
|---|---|---|
| `/engine/data/config/private.pem` | 562 B | `World.ts:104` (RSA key, at import) |
| `/engine/data/config/world.json` | 0.4 KB | `WorldConfig.ts:295` (at import) – generated, see below |
| `/engine/data/raw/wordenc` | 13 KB | `WordEnc.ts:36` |
| `/engine/data/pack/client/{config,interface,title}` | 340 KB | config loaders, `Component.ts:32`, `FontType.ts:7` |
| `/engine/data/pack/server/*.dat` (21) + `script.idx` | 7.4 MB | `World.reload()` loaders, `Component`, `ScriptProvider` |
| `/engine/data/pack/.cache/maps-server.zip` → `vfs/data/pack/maps-server.zip` | 15.3 MB | `GameMap.ts:66` (no dot-dir in the app bundle) |
| `/content/maps/{multiway,free2play}.csv` | 140 KB | `GameMap.ts:58-64` – without `<srcDir>/maps` the map silently does not load |
| `/engine/data/derived/startup-tables.json` | 181 KB | `runtime/startup-tables.ts` (`Midi.load`, `AnimFrame.load`) – made from the staged cache by `startup-tables.mjs` |
| `/engine/data/pack/main_file_cache.{dat,idx0-4}` → `../cache/…` | 8.9 MB | `FileStream`: the CRC table (`CrcTable.ts`, archive 0), the start-up tables' guard (idx2/3); anims and midi only without a table |

Not staged: `flo.dat` (never loaded by World), other `.idx`, `client/{media,textures,sounds,versionlist}`, other
`.cache` zips, `public.pem` (n/e swapped – `private.pem` is authoritative and equals the client's built-in key).

## How it works

```
page                     boot.js                               engine.js (src/entry.ts)
 new Worker(boot.js) ──►  installs console→{type:'log'}
 {type:'init',config} ─►  fetch vfs-manifest + 38 files ─► globalThis.__LC_VFS__   (progress: preload)
                          deep-merge config into world.json
                          import('./engine.js') ──────────► modules evaluate (read pem/world.json/cache; bzip2 init)
              ◄─ booted   attach({post}); replay queued msgs    (progress: import)
 {type:'start'} ───────────────────────────────────────────► World.start(false,false)   (progress: start …)
                                                              release start-up data; first tick
              ◄─ ready                                        tick loop (runtime/ticker.ts)
 connect/data/close ◄────────────────────────────────────►  runtime/transport.ts  (WorkerClientSocket)
 lifecycle pause|resume|save ──────────────────────────────► save all (sync XHR) / pause / rebase clock
              ◄─ lifecycle-done (after the saves are written)
                                     player saves ─────────► GET/PUT lostcity://game/save/players/<profile>/<name>.sav
```

* **Import order** (`src/entry.ts`): vfs guard → patches (kleur off, flat `Packet.gjstr`) → in-process threads
  (must be registered before `World.ts` evaluates: its Workers are field initialisers) → World and friends.
* **Tick loop** (`runtime/ticker.ts`): `World.start(false, false)` (no `OnDemandThread`, no upstream loop), then an
  own-property wrapper on `World.cycle` – `World.ts:508` reschedules through `this.cycle.bind(this)`, so it sees
  every tick. It (1) drops missed ticks when more than 5 ticks late (`nextTick = now`), so a frozen-then-thawed
  worker runs ~2 ticks, not ~100 (upstream catch-up would also force-logout the player after 100 silent ticks);
  (2) swallows a tick while paused, which ends the setTimeout chain; (3) on resume sets `nextTick = now + tickRate`
  and restarts the chain only if it ended (never two chains); (4) stops after `process.exit`.
* **Connections** (`runtime/transport.ts`, modelled on `web.ts:87-136`): `remoteAddress = '127.0.0.1'` (anything
  without `.`/`:` never enters `playerLoop`, `World.ts:910-930`); `send()` copies (engine buffers are reused) and all
  sends of a macrotask go out as **one transferred ArrayBuffer per connection** (one message per tick);
  `close()` flushes first, `terminate()` drops queued bytes; the "socket closed" handling runs on a later
  macrotask like a ws `close` event, and nulls **every** player whose `client` is that socket (+ drops a pending
  `loginRequests` entry). That fixes both upstream reconnect bugs without touching
  `World.ts`: after opcode 18 the old socket's close no longer cuts off the reconnected session (bug 1), and the new
  socket's close detaches the in-world player even though `socket.player` is the temporary login player (bug 2).
* **Threads** (`shims/worker_threads.ts`, `runtime/threads.ts`): in-process registry by URL. LoginThread = the
  `login.enabled=false` branch on native storage (always acknowledges `player_logout`, otherwise `World` blocks that
  name forever); Friend/Logger = sinks (upstream no-ops with their servers off); OnDemandThread = sink (the client
  reads its own cache – a client opening opcode 15 gets nothing); DevThread = sink + warning.
* **Saves** (`runtime/saves.ts`): synchronous XHR relative to the worker script URL –
  `GET ../save/players/<profile>/<name>.sav` (200 → load, 404 → new player, anything else → refuse the login with
  code 8 rather than create a fresh character that would overwrite the real save) and `PUT` with an exact-length
  **ArrayBuffer** body (never a Blob). Every save first goes into an in-memory `pending` map and leaves it only
  after a 2xx; a failed PUT is logged as an error, retried every 15 s / on the next save / on lifecycle save, pause,
  resume and on exit, and a login prefers the pending copy, so a failed write never blocks re-login. A pending save
  lives only in worker memory until a write succeeds: `lifecycle-done` reports `ok:false` meanwhile, the host page
  warns the player and will not reload (Restart) over it without a second tap, and native retries the flush on the
  next suspend. Saves happen at logout, the engine's 15-minute autosave, `lifecycle pause|save` and
  exit.
* **Exit** (`shims/globals.ts` + entry): `process.exit` → `__lc_exit`: first call only – stop ticking, save every
  player still in the world and every pending `logoutRequests` entry (the tick-crash path removes everyone and exits
  before World posts those), close all connections, post `{type:'exit', code}`; then throw `EngineExit`, which the
  tick wrapper / message handlers swallow. Later messages are ignored (`lifecycle` answers `ok:false`).
* **Memory** (`runtime/patches.ts`, entry): `Packet.gjstr` builds flat strings (see numbers below; exact original
  semantics: ISO-8859-1 per byte via `String.fromCharCode`, first terminator consumed, last byte dropped when there is
  no terminator, out-of-range `pos` defers to the original so the RangeError is identical; fuzzed in
  `test/gjstr.test.mjs`). After `World.start` the entry drops the bytes of **every** vfs file (the map zip, CSVs,
  packs and the cache: 30.3 MB), the archive-0 files `OnDemand.cache` memoised for the CRC table, and the WASM bzip2
  instance. Evicted files still exist for `existsSync`/`readdirSync`; a later read (only the `::reload` cheat does
  that) re-fetches them with a synchronous XHR from their manifest URL and they are dropped again afterwards.
  `fs.readFileSync` returns zero-copy views (all binary readers on the graph copy or only read), which keeps 15 MB +
  6 MB of garbage out of the start-up peak.
* **Tick** (`runtime/tick.ts`, imported after World): patches for the cost of a tick that keep every call, state,
  random draw and client byte the same (seeded worlds hashed every tick against main: V8 and JSC idle with 5 players
  and with 250 and 500 bots, V8 with 1000). (1) The collection loops - `World.npcs`, `playerLoop.all()`, the queue and zone
  lists, a zone's contents - run on plain iterator objects instead of generators (`runtime/iterators.ts`: the
  generators' steps at the same moments; `EntityList` stops after the highest id it filled; `test/iterators.test.mjs`
  compares 48 000 programs with upstream's generators). (2) `HuntType.get(-1)` without the read outside the array,
  (3) `ScriptRunner.HANDLERS` as a packed array instead of a dictionary-mode object, (4) rsbuf's per-tick reset of
  only the ids its renderers wrote (`runtime/rsbuf.ts`, `test/rsbuf.test.mjs`): three V8 slow paths ((2) and (3) in
  `runtime/lookups.ts`). (5) `processInfo` leaves out `rsbuf.computeNpc` for npcs whose rsbuf mirror already holds what
  the call would write (`runtime/npc-info.ts`, `test/tick.test.mjs`).
  JSC instructions a tick, all of them: −31.5 % idle, −12.3 % with 500 bots, −10.6 % with 1000.
* **Memory** (`runtime/memory.ts`): the 89 527 collision zones (of 123 676) that never hold a flag share one
  all-zero array until their first non-zero write; the scripts' bytecode and line tables are typed arrays
  (`Uint16Array` opcodes, `Int32Array` operands; a string instruction's operand hole reads 0, which nothing reads).
  The Map keeps the same keys and values, the scripts the same values (`test/collision.test.mjs`,
  `test/script-arrays.test.mjs`). JSC heap after start −25 MB and −6 MB; peak RSS −27 MB and +4 MB (within noise).
* **Start-up tables** (`startup-tables.mjs` at build time, `runtime/startup-tables.ts`): `World.start` gunzipped all
  345 MIDI files (`Midi.load`) and 336 animation files (`AnimFrame.load`, through `SeqType.load`) only to keep 345
  song lengths and 10 100 frame delays. The build runs the engine's own two loaders (bundled with these shims) over
  the staged cache and stages what they leave as `vfs/data/derived/startup-tables.json`: `Midi.lengths`, each frame's
  delay, base and length, `AnimFrame.order` and what the loaders printed. At run time both loaders take the table's
  values and print the same lines; the frames' transform arrays are not kept (the server reads only `.delay`,
  `SeqType.ts:108`). Without the table, with an unreadable one or one made from another cache (the archive's file
  count and the CRC of its index file), the original loaders run. `test/startup-tables.test.mjs` compares every value
  (and every `SeqType`) with the loaders'. JSC: boot to two ticks after a login 12.7 → 8.2 G instructions (−35 %),
  `World.start` 498 → 262 ms, heap −6.7 MB, peak RSS +12 MB (384 → 396); V8: 22.3 → 10.8 G, peak RSS 885 → 457 MB.
* **bzip2** (`shims/bzip2.ts`): "auto". At start-up the engine's `bzip2.wasm` decodes the jag archives through
  `shims/bzip2-wasm.ts`, a 100-line **synchronous** loader that replaces emscripten's glue: in JSC the glue's
  instance (≈33 MB of `gcHeapSize`) stayed reachable forever after every reference was dropped, and instances made by
  async `WebAssembly.instantiate()` were never collected either; a synchronously instantiated module is (measured,
  see below). Without WebAssembly (Lockdown Mode), and after `release()`, `shims/bunzip2.ts` – a TypeScript port of
  libbzip2's decoder with CRC checks – is used. Both are byte-identical to the engine's decoder on all 152 jag
  entries and on synthetic multi-block data, never modify their input, and reject what libbzip2 rejects
  (`test/bzip2.test.mjs`); the web client's SheetJS decoder (the earlier prototype's fallback) gets `title.dat` wrong.
* **Logs**: `boot.js` wraps `console.*` → `{type:'log', level, text}` (args formatted once, 8 KB cap); debug builds
  also keep the worker's own console (Safari Web Inspector). Engine log colours (kleur) are off.

### Shims (`src/shims`)

| Module / specifier | Replacement | Why |
|---|---|---|
| `fs`, `fs/promises` | `fs.ts` over `vfs.ts` | sync reads/existence/fd API (`RandomAccessFile`) on the in-memory vfs; streams/watch throw |
| `path`, `path/posix` | `path.ts` | POSIX, `resolve` against the vfs cwd `/engine` (so `../content` = `/content`) |
| `zlib` | `zlib.ts` (fflate) | `gunzipSync` for cache archives 2/3 at start |
| `crypto` | `crypto.ts` | `randomUUID` from `getRandomValues` (ClientSocket ids), no secure-context dependency |
| `worker_threads` | `worker_threads.ts` + `runtime/threads.ts` | helper threads in-process (see above) |
| `buffer` / `Buffer` | `buffer.ts`, injected only into `World.ts` and `RandomAccessFile.ts` | a global `Buffer` would flip third-party `typeof Buffer` checks |
| `v8`, `module` | stubs | `::snapshot` answers with a message; `createRequire` throws |
| `node-forge` | `forge-lite.ts` (native BigInt) | PEM parse + jsbn `BigInteger` for `rsadec`; byte-identical (`test/forge-lite.test.mjs`), −280 KB |
| `prom-client` | no-op metrics | built at import by `server/Metrics.ts` |
| `ws` | throwing stub | only used with login/friend/logger servers |
| `#/db/query.js` | `db-query.ts` | upstream opens `node:sqlite` at import (reached via `World.ts:71 → FriendServer.ts`) |
| `#/io/BZip2.js` | `bzip2.ts` | see bzip2 above (no top-level-await emscripten glue) |
| `process.exit` / `.memoryUsage` / `.platform` | `define` → `__lc_exit` / `__lc_memoryUsage` / `"browser"` (`globals.ts`, injected) | |

Deny by default: any other Node built-in, any `#tools/` import and any npm package outside the allowlist
(`kleur`, `fflate`, `@isaacs/ttlcache`; e.g. kysely, mysql2, fastify, ejs, jimp, runescript, bcrypt, prisma) fail the
build; the build also fails if the output still contains `import` statements, `import()` or `__require`. The
remaining `process.` mentions are guarded (`typeof process`) code in kleur and ttlcache.

## Bots (`docs/BOTS.md`)

The AI bots of 2004sp-progressive (a rev-254 mod) come as a second bundle. Nothing of them is in `engine.js`: with
`bots.count` 0 (Settings › World › Bots: Off), the worker fetches and runs exactly what it did before (`test/bots.test.mjs` checks that
byte for byte and runs the vanilla session against it).

```
init {…, bots:{count:N}} ─► boot.js: N = integer clamped to 0..1000 (absent or junk: 0)
   N = 0 ─► vfs-manifest.json (38 files) ──────────────────────► import engine.js        (src/entry.ts)
   N > 0 ─► + vfs-manifest-bots.json (vfs/bots/scripts.bin) ───► import engine-bots.js   (src/entry-bots.ts:
            world.json bots.count = N                                entry.ts, then runtime/bots)
        ◄─ booted {…, files, bundle:'engine.js'|'engine-bots.js', bots:N}
```

A build without the bots bundle (`--no-bots`) starts without bots when asked for them (a logged warning), and so does
one whose `engine-bots.js` throws while it loads (bot code failing at import: a logged error, `engine.js` instead).
`world.json` may also carry `bots.debug` (verbose bot logging) and `bots.spawnPerTick` (default: the library's 5).

**Build** (`build.mjs`). `#/engine/bot/*` resolves (exact case: APFS is case-insensitive) to the library, `bots/src`
by default, and is an error in the vanilla build; the scoped `Buffer` injection covers the library; its JSON imports
are bundled. Guards, each a build failure: `engine.js` contains a bot module or one of `LCBOTS01`, `[bots]`, `P_ISBOT`;
the library imports a Node built-in (also the shimmed `fs`/`path`), `ws`, `#/db/*` or `#tools/*` (docs/BOTS.md §5);
`engine-bots.js` has `process.*` references beyond `engine.js`'s (compared as `process.a.b` paths with counts:
`engine.js` has a guarded `process.env`) or any `import`/`import()`/`__require`; `P_ISBOT`/`P_BOT_INTERACT_TRADE`
are taken in the engine's `ScriptOpcodeMap`; `scripts.bin` was not diffed against the `script.dat` being staged.

**Content-script overlay** (`bots/content`). Progressive changes three scripts for bots; only those hunks are kept,
as patches against the upstream content (commit in `BASE`): `engine.rs2` declares `p_isbot`/`.p_isbot` and
`p_bot_interact_trade`/`.p_bot_interact_trade`, `trade.rs2` tells a bot that a player wants to trade with it (the
library takes the request or declines) and clears the bot's trade when the trade window closes, `death.rs2` lets bots
keep their items (a human who kills one in PvP gets 1–50,000 coins). `compile.mjs` clones the content into
`build/tmp/bots`, applies the patches (`git apply`, outside any repository) and runs the upstream engine's own server-script
compiler in place under its `tsx --tsconfig` with the cwd in `build/tmp/bots` (`compile.mts`: the two commands at the
explicit opcodes of `bots/src/port/BotScriptCommands.ts`, 10100/10101, asserted free – never by editing
`ScriptOpcode.ts`, which re-numbers every later opcode). It diffs the result against the vanilla
`script.dat`/`.idx` (source paths aside) and keeps the scripts that differ: 24 (4 in their code – `[opplayer4,_]`,
`[if_close,trademain]`, `[proc,player_death_lose_items]`, `[proc,pvp_death_lose_items]` – 20 only in line tables),
14,488 bytes. Invariant: only scripts from patched files differ – otherwise the vanilla pack is stale against
the upstream content and the build says so. `scripts.bin` (format in `compile.mjs`): magic `LCBOTSC1`, sha256 of the vanilla
`script.dat` and `.idx`, the command numbers, then per script id, name, the CRC of the vanilla script it replaces and
its bytes (with the vanilla source path). Cached in `build/tmp/bots` by sha256 of the vanilla pack, the patches and
`BASE`, the compiler, the opcode file and the runescript version: a cold compile takes 3.9 s, a cached one 3–5 ms (also
with `--skip-pack`). It writes nothing in the upstream checkouts.

**Glue** (`src/runtime/bots`, evaluated right after the entry; with a count of 0 it installs nothing). Every target is
checked before anything is wrapped (a missing one switches the bots off, logged, and the world runs on), and every
hook body is guarded – an exception from bot code must not reach `World.cycle`'s catch (all players removed, exit) or
`processClientsIn`'s (the human disconnected). No engine, `entry.ts`, `saves.ts` or `threads.ts` source changes:

| Hook | What |
|---|---|
| `ScriptRunner.HANDLERS[10100/10101]` | `p_isbot` (1 if the active player – with int operand 1 the secondary one – is a bot) and `p_bot_interact_trade(uid, stage)`: stage 0 = a human asks this bot to trade → `BotTrade.onTradeRequest(human, bot)` (a trading bot that is free takes it, any other declines), stage −1 = the trade window closed → the bot's trade target is cleared (upstream wrote the target only while it was −1, so its reset did nothing); asserted free first |
| `ScriptProvider.load` | after every load (`World.start`, `::reload`): the overlay replaces its 24 scripts, only if each id still has its name and its vanilla bytes (CRC) – else the vanilla scripts stay and the bots are switched off |
| `World.start` | after `World.start(false,false)`, before the first tick: the bot store is read, one `GET /save-index`, `BotManager.start` (upstream started them inside the `startCycle` branch, which the worker never takes) |
| `World.processPlayers` | then `BotManager.tick()` (keep-alive, staggered spawning, the AI) – the bots' share of the tick is measured |
| `World.processClientsIn` | then `BotManager.clearAfkEvents()`: the engine's own random-event roll is cleared for every bot (the flag is set in there); the bot library arms bots near a human itself (`port/BotRandomEvents`), and those keep the flag |
| `World.sendPrivateMessage` | a human's PM to `BotChat.onPrivateMessage` first ("come here"); consumed ones go no further |
| `World.addFriend` | a bot in the world shows online (`UPDATE_FRIENDLIST` with this world; the friend server is a sink) |
| `MessagePublicHandler.handle` | after a successful one: `BotChat.onPublicMessage` with the WordEnc-filtered line |
| `saves.write` / `saves.retryPending` | saves of names `BotManager.ownsName()` go to the bot store (below) instead of `players/` |
| `World.onLoginMessage` | a human logging in with the name of a bot in the world waits for the bot to leave (below) |
| `World.cycle` | after every tick: a held login's wait is counted (below); a self-check after the first ticks: the hooks ran, and once bots are in the world their keep-alive holds; if not, the bots are switched off with a logged error |
| `console.error` / `console.warn` (`runtime/bots/logs.ts`) | each distinct line (by its first line) at most 3 times per 100 ticks, then one summary line per window; a first occurrence, and every line after an exit, always shown; counted (`engineErrors`, `linesNotShown`) – a bot whose engine turn throws stays in the world (no client to log out), and the engine logged its stack every tick |
| `attach` (`src/entry-bots.ts`, `runtime/bots/page.ts`) | `lifecycle-done` gains `bots: {ok, error?}` (the bot store); a `resume` first writes a store that could not be written; the `{type:'bots', active:false, reason, detail}` notice |

Switched off for the session (a hook target missing, the overlay not matching, the bot store unreadable or corrupt,
`BotManager.start` or 10 ticks in a row of `BotManager.tick` failing, the self-check): one logged error and one
`{type:'bots', active:false, reason, detail}` message to the page (reason `mismatch`, `store-unreadable`,
`store-corrupt` or `failed`; boot.js sends `no-bundle` or `load-failed` itself), which shows it once in plain words;
bots in the world leave through the normal logout path (their saves still go to the bot store), every hook passes
through. Nothing is sent with the bots off.

**Bot store** (`runtime/bots/store.ts`). All bots in one file, `Documents/bots/<profile>/bots.sav`, through the
player saves' routes (`GET/PUT ../save/bots/<profile>/bots.sav`, sync XHR, ArrayBuffer body; native keeps the `.bak`):
`"LCBOTS01"`, u16 count, count × {u8 name length, name (the normalised username), u32 save length, a player `.sav`},
big endian. Read once when the bots start: 404 = none yet; a read that fails (an I/O error, retried once) = the bots are
off for the session and the store is never written (the older `.bak` would rotate the newer file away on the next two
writes); corrupt = `bots.sav.bak` (a warning); both corrupt = off, never written. A record that fails `PlayerLoading.verify` keeps
that bot out for the session (its record is written back unchanged); records of bots that did not spawn are carried
over. Logout, the 15-minute autosave (through the login thread), `lifecycle pause|save` and exit (through `saveAll`)
all route bot saves into it; it is written once per occasion, after the human saves: at the end of `saveAll` (its last
step is `saves.retryPending`) or on the microtask after the login thread's batch. A failed write is logged, kept and
retried (15 s, the next occasion, a `resume`), and reported apart: `lifecycle-done.ok` stays about the human's saves,
`lifecycle-done.bots` says whether the bots were saved (Settings › Restart waits on it like on a failed save). The
Characters list (`players/<profile>/*.sav`) never sees a bot.

**Names** (`runtime/bots/routing.ts`). `isReservedName` = a human save in `players/<profile>/` (one `GET /save-index` at
start), a human saved or logged in this session, or a human online. Inside `BotManager.tick` "a human online" comes from
one map of the players made at the tick's first question, with `World.getPlayerByUsername`'s answers (no player leaves
and no human joins during the tick): a newcomer asks it of every unused name, about 2,800 at 1000 bots, each a walk over
every player before. A human logging in with the name of a bot in the
world (the login thread already answered "new player") is held: the bot is retired (normal logout path), its final
save reaches the store, the name is released (`BotManager.release`) and the login answered – a fresh character
(measured: 28 ms at 100 ms ticks). A bot leaving for a human drops the combat logout lock. After 17 world ticks, about
10 s (`__LC_ENGINE_TEST__.botsCollisionTicks` in tests; a paused world holds the login, it is not refused), it is
refused like an account that is online (World answers 5).

## Protocol notes (ARCHITECTURE.md §4)

Implemented as specified. Compatible additions, all optional for the page:
* `{type:'progress'}` stages: `preload` (with `fraction` 0–1 and "Loading game data (n/38)"), `import`, `start` with
  `detail` = `Starting the world`, `Loading game configuration`, `Loading scripts`, `Loading the world map` (World.start
  is one synchronous call; these are posted from inside it).
* `lifecycle` also accepts the native names `background`/`terminate` (→ pause) and `foreground` (→ resume).
* Messages other than `init` that arrive while booting are queued and replayed after `booted`. `start` twice is
  ignored; unknown types are logged. `pause` before `start`: the world starts (and `ready` is sent) but does not tick
  until `resume`. `lifecycle-done` has `ok:false, error` when a save could not be written (it stays in memory).
* Saves run synchronously inside the worker, so `lifecycle-done` for `pause`/`save` is sent after native storage
  answered every PUT.

### Test builds (autotest)

A test build (`build-web.mjs --autotest`) answers one more message, `{type:'lctest-perf', reqId, since}`, for the in-app
test's soak phases (`web/test/autotest.js`, `app-test --soak`, docs/BUILDING.md §4). `src/autotest/perf.ts` wraps
`World.cycle` once more, outside `runtime/ticker.ts` and the bots glue (World looks the method up on every reschedule),
and `World.start`; neither changes what it calls. It keeps the last 4,096 ticks: each tick's start (epoch ms,
`performance.timeOrigin + now`, so the page can put it on its own clock), the ticker's duration, the whole timer callback
(with the bots glue's after-tick work: the bot store's writes), `World.lastCycleStats` (the 12 WorldStat phases, whole
ms) and, in `engine-bots.js`, the bots' share (`BotManager.tick` as `runtime/bots/hooks.ts` times it). The reply has the
ticks from `since` on (`from`, `ticks`, `start`, `tickMs`, `callbackMs`, `phases` 12 a tick, `extraMs`), the start-up's
marks (`evaluated`: the engine's modules ran; `worldStart`, `worldStarted`; `firstTickStart`, `firstTickEnd`; `ready`
sent), the ticker's state and clamps, the players and NPCs, and in `engine-bots.js` the counts of `BotManager.stats()`,
the glue's phase and the store's writes. A normal build has none of this: its bundles are byte-identical to a build
without `src/autotest`.

## Configuration (`world.json`, ARCHITECTURE.md §8)

`build.liveReload=false` (no DevThread), `node.id=10`, `node.members=true`, `node.production=false`, plus:

* **`node.debug = true`** (the engine default). Every effect in the source:
  `IdleTimerHandler.ts:8` the client's IDLE_TIMER (sent after 90 s without input) is **ignored** – no forced logout
  of a phone left on the table; `PlayerOps.ts:1115` `afk_event` keeps **random events working** for our staff-level
  player (with `debug=false` and staffmodlevel 4 they would never fire); `IfButtonHandler.ts:35`,
  `InvButtonHandler.ts:56`, `InvButtonDHandler.ts:53`, `OpHeldHandler.ts:69`, `OpHeldTHandler.ts:65`,
  `OpHeldUHandler.ts:120` print "No trigger for [...]" for unscripted interactions (rare in 274 content; with
  `production=false`, `Player.ts:1123` already prints similar messages for ops regardless); `World.ts:275`
  broadcasts "Loaded N scripts." on `::reload`; `web.ts:142,254` are not in the bundle. Pass `{node:{debug:false}}`
  in `init.config` to make IDLE_TIMER log the player out (e.g. if `lcHost.settings.stayLoggedIn` should be
  enforced by the server) at the cost of random events.
* `build.verbose = true` – `printError(Error)` includes the stack (`Logger.ts:24`); only affects error logs.
* `node.profile = 'main'`, `node.xpRate = 1`, `node.clientRoutefinder = true`, `node.debugProfile = false`,
  `login/friend/logger.enabled = false` (explicit).
* Consequences of `production=false` (by contract): staffmodlevel 4 (all `::` cheats and `::~debugprocs`; the client
  is told `min(4,2)` = 2: a gold crown on the player's own chat lines and the moderator report-abuse options), no
  login rate limits, script errors print a stack trace to the player instead of kicking.
* **`staffModLevel`** (top level, 0–4, clamped; not a `WorldConfig` key): the staff level `runtime/threads.ts` gives
  every login, read once from the merged world.json. The page sends 4 or 0 (Settings › World › Jmod On/Off); absent,
  the engine's own rule (`LoginThread.ts:63-67`: 4 unless `production`). 0 is a normal player with `production=false`
  kept: no `::` commands (`ClientCheatHandler` needs 2+), no crown, ordinary report options, no walking into
  unallocated zones (`PathingEntity.ts:293`, staff 3+). Random events and deaths are the same either way (`node.debug`
  opens `afk_event` to staff; `death.rs2` spares staff only when `map_live`, i.e. production). The start-up log line
  says which level.

## Tests (`web/engine/test`, each one command; all build into `build/tmp/engine`)

| Command | What |
|---|---|
| `node --expose-gc --experimental-vm-modules web/engine/test/vm.test.mjs [--debug] [--player]` | (a) `boot.js` → `engine.js` as `vm.SourceTextModule`s in a context with only web globals (no `process`/`Buffer`/`require`/`setImmediate` – asserted), messages through `structuredClone`+transfer, `fetch`/sync `XMLHttpRequest` served from the build output and a temp Documents dir (atomic write + `.bak`, failure injection). Runs `lib/session.mjs` (64 checks) and asserts all 38 staged files are read and every PUT body was an ArrayBuffer. The `--debug` run also sends `start` before `booted` (queued by boot.js). `--measure [--no-flat-strings] [--no-release]` boots only and reports heap/ticks; `--soak=N` keeps a player online for N ticks at 20 ms. |
| `node --expose-gc --experimental-vm-modules web/engine/test/vfs-release.test.mjs [--no-build] [--bots=N] [--no-transfer]` | The start-up files' release (`vfs.evictReloadable`), in the vm sandbox with WeakRefs to every preloaded buffer: at `ready` each evicted file's buffer is detached (`transfer(0)`: its bytes freed without a collection) and after two full GCs none is reachable, so no reader can meet a detached buffer; the same after `::reload` (26 files fetched again and let go again); only `world.json` stays. `--bots=N`: `engine-bots.js` with N bots of the real library playing on the released files. `--no-transfer`: a runtime without `ArrayBuffer.prototype.transfer` (an Android WebView before Chrome 114): nothing detached, as before, and the same reachability. |
| `node web/engine/test/jsc.test.mjs [--only=jit\|nojit]` | (b) the same session inside the macOS JavaScriptCore shell (`jsc-harness.mjs` supplies the missing web APIs, nothing from Node), with the JIT and with `--useJIT=false --useWasm=false` (≈ iOS Lockdown Mode). `--measure` likewise. |
| `node web/engine/test/chrome.test.mjs [--port P]` | (c) a real module Web Worker in headless Chrome 154, loaded from a static server on 127.0.0.1:47310 (CDP 47311; `--port`: P and P+1) implementing the scheme handler's routes; protocol-level checks (43). |
| `node web/engine/test/bzip2.test.mjs` | WASM loader and TS decoder vs the engine's emscripten decoder (236 comparisons). |
| `node web/engine/test/forge-lite.test.mjs` | forge-lite vs node-forge (key fields, 3000 RSA round trips, `Packet.rsadec` of a client block). |
| `node web/engine/test/iterators.test.mjs` | `runtime/iterators.ts` vs upstream's own generators (bundled from the pinned sources): 48 000 seeded programs of unlinks, adds, nested and reverse walks, breaks, resets, validity flips, throwing `isValid`, `next`/`return` by hand; four wrong iterators caught. |
| `node web/engine/test/rsbuf.test.mjs` | `runtime/rsbuf.ts` vs upstream's renderer resets: 120 seeded programs, every slot hashed after each reset; a reset that misses `cache()`'s ids is caught. |
| `node web/engine/test/tick.test.mjs` | `runtime/npc-info.ts` vs upstream's `processInfo`: a stand-in World runs the npc loop taken from the pinned `World.ts` on the pinned rsbuf; 40 seeded programs (npcs that rest with stale hitmarks and says, walk, run, teleport, turn, change type, despawn and come back on their nid; observers that come and go) give the same `npcInfo()` bytes and observer counts every tick; five wrong patches caught; the source shapes it relies on (only `World.processInfo/addNpc/removeNpc` call `computeNpc/addNpc/removeNpc`, every mirror field `computeNpc` writes is compared or reset). `runtime/lookups.ts`: `HuntType.get` for every id, the packed `HANDLERS` at every opcode. |
| `node web/engine/test/collision.test.mjs` | `runtime/memory.ts`'s shared zero zones vs upstream's `CollisionEngine`: 2 000 seeded programs (all writes and `change*` helpers, all four levels), every read and every zone after every step; a write into the shared array is caught. |
| `node web/engine/test/script-arrays.test.mjs` | `runtime/memory.ts`'s typed script arrays vs upstream's `ScriptFile.decode` over all 10 938 scripts: every value, `lineNumber()` for every pc, the other fields; the operand holes all at `PUSH_CONSTANT_STRING`. |
| `node web/engine/test/startup-tables.test.mjs` | `runtime/startup-tables.ts` vs the loaders over the engine's cache: every `Midi`, `AnimFrame` and `SeqType` value and printed line; six bad tables fall back; a wrong delay is caught. |
| `node web/engine/test/gjstr.test.mjs` | flat `gjstr` vs the original, 200 000 fuzzed cases (string, pos, exceptions). |
| `node --expose-gc --experimental-vm-modules web/engine/test/bots.test.mjs [--real] [--only=build\|vm\|jsc] [--nojit] [--bots=N]` | (d) the bots, against the stub library (`test/fixtures/stub-bots`, scripted, so the glue's checks can be exact) or the real one (`--real`): the build checks (below), then the boots of `lib/bots-session.mjs` (six on one Documents folder, a vanilla build asked for bots, and a broken library), each in a fresh process, in the vm sandbox (`lib/vm-worker.mjs`, shared with (a)) and in JavaScriptCore with the JIT (`--nojit` adds the slow no-JIT run). `--only=vm`/`jsc` reuse the last build (`--only=build` makes one). |
| `node --expose-gc --experimental-vm-modules web/engine/test/perf.test.mjs` | the test build's measurements ([Test builds](#test-builds-autotest)) in the vm sandbox: a test build with the stub bots answers `lctest-perf` and a normal build never names it; the start-up marks in order and World.start's agreeing with `ready.ms`; every tick from 0 with its start, durations and 12 phases, 100 ms apart from start to start (`World.tickRate` 100); `since`; no tick counted while paused; with 5 stub bots and a human, the bots' share within each tick and their numbers (17 checks). |
| `node web/engine/test/measure.mjs [--runs=3]` | the numbers below. `--bots [--real] [--counts=0,25,50,100,250,500,750,1000] [--ticks=100] [--rate=300] [--runtimes=vm,jsc,jsc-nojit] [--searches=N]`: the bots matrix (the real AI with `--real`, else the stub; the bots' path searches per tick, how many ticks used the whole budget; `--searches` sets that budget). |
| (in `all.mjs`) | type-check with the upstream engine's TypeScript: `tsconfig.json` (the glue with the real bot library) and `test/fixtures/stub-bots/tsconfig.json` (the same with the stub), each through a copy whose paths point at the resolved upstream folder (`scripts/lib/upstream.mjs` `derivedTsconfig`). |
| `node web/engine/test/all.mjs [--skip-chrome] [--port P]` | everything above except measure and soak; the type-check and (d) run against both the real bot library and the stub; ~10 min. |

`lib/session.mjs` (shared by a/b/c; pure JS) drives the real protocol with a rev-274 bot (`lib/protocol.mjs`:
ISAAC, the client's RSA with its default n/e – asserted equal to `private.pem` by `lib/fixture.mjs` – and the CRC
block from the cache): `init`(with a `node.profile` override) → `booted` → `start` → `ready` and progress stages;
login of a new player (GET 404, response 2, staff byte 2), packets every tick (one data message per tick),
`::tele`/`::setstat`; `lifecycle save` (PUT before `lifecycle-done`, **PUT body == `player.save()`**); logout via
the logout button (LOGOUT, close, PUT == `player.save()`, `logoutRequests` empty); **re-login restores position and
stats**; **reconnect with opcode 18** (response 15, engine closes the old socket, client closes it too, packets keep
flowing on the new one, player bound to the new socket); **pause → 60 s simulated freeze → resume** (save written,
no ticks while paused, 2–3 ticks in the 1.5 s after resume, player not logged out); unannounced 60 s freeze (drift
clamp, ≤ 4 ticks); `::reload` after the vfs was released (26 files re-fetched, released again); dropping the
connection without reconnecting (player detached at once, idle logout after **51** ticks – not 100 – and saved);
**write failure** (error logged, re-login not blocked and served from memory, `lifecycle save` reports `ok:false`,
then succeeds and stores the newest bytes after storage recovers); read failure (login refused with 8, nothing
written); **crash in a tick** (exactly one `{type:'exit', code:1}`, the connected player's save written first,
connection closed, nothing but logs afterwards, ticking stopped, later `lifecycle` → `ok:false`). The clock-based
and engine-internal checks are skipped in Chrome (no hooks into a real worker).

(d) `bots.test.mjs` first builds both bundles and checks: every vanilla file (`engine.js`, `boot.js`, the 38 and their
manifest) byte-identical with and without the bots build, which adds exactly `engine-bots.js`, `vfs-manifest-bots.json`
and `vfs/bots/scripts.bin`; no bot marker in `engine.js`; `scripts.bin` made from the staged `script.dat`; and that a
Node built-in, `process.env.X`, the database or a wrong-case import in the library each fail the build. Then
`lib/bots-session.mjs` (pure JS, 10 bots, ticks at 100 ms):
- **main** (fresh Documents): `booted` names `engine-bots.js` and 10 bots, 39 files (+ `scripts.bin`); `bots.sav` read
  once (404) and `/save-index` once; the overlay in place (`[proc,player_death_lose_items]` opens with 10100/0,
  `[opplayer4,_]` uses 10100/1 and 10101/1); handlers and hooks installed; **nothing spawns in 15 ticks without a
  human**; after a login **staggered** (≤ 5 a tick) and **never before the human's tick or on tick 0**; client-less
  `is_bot` players; **all still there 120 ticks later**, self-check passed; **the random-event flag cleared for bots,
  not for the human**; public chat reaches `BotChat` (the stub answers "hi Botstest1" when named, not otherwise);
  "come here" consumed and the bot comes over (real AI: the nearest bot, put back on the spawn road if it wandered
  beyond the 50 tiles BotChat answers within); **`UPDATE_FRIENDLIST` with node 10** for a bot; **OPPLAYER4 on a bot runs
  the overlay's `[opplayer4,_]`** (`.p_bot_interact_trade(uid, 0)` reaches `BotTrade.onTradeRequest`: the stub takes it
  and says "One moment please, Botstest1" once; the real bot says it if and only if it took the request; stage −1
  clears the target); **`player_death_lose_items` leaves a bot's whole inventory as it was**; **`lifecycle save` and the autosave PUT the human,
  then ONE `bots.sav` whose every record == that bot's `save()`**; **a human logging in with a bot's name** gets 2 (a
  fresh character) although the bot is under a combat logout lock, the bot's final save in `bots.sav`, the name
  released, the human's own save in `players/`; a login held through a pause is answered after the resume; a bot that
  cannot leave (no access) → the login refused with 5 after the hold, and the bot saved once it can leave; a failed
  `bots.sav` write → `lifecycle-done.bots.ok` false, written on the next `resume`; pause (the human, then `bots.sav`; no
  ticks) / resume (bots online and kept alive); an engine error every tick → shown 3 times a window, then summarised;
  no other errors; a crash in a tick → the human's save and one `bots.sav` with every bot; **no bot save ever under
  `players/`**.
- **restore** (same Documents): `bots.sav` read (200); the name the human took is reserved (from `/save-index`),
  skipped and backfilled from the end of the list; the others **back at their saved position with boot 1's stats**.
- **unreadable**: reading `bots.sav` fails (500, twice) → bots off for the session (one error, the `store-unreadable`
  message), the `.bak` never read, nothing under `bots/` written.
- **bak**: `bots.sav` garbage → loaded from `bots.sav.bak` (warning), the bots back, the next save writes a good one.
- **corrupt**: both garbage → bots off for the session (one error), the human plays, **nothing under `bots/`
  written**.
- **off** (`bots.count` 0): **the vanilla 64-check session** plus: `engine.js`, `bots` 0, the 38 vanilla files and
  nothing of the bots fetched, the vanilla `script.dat` and no overlay, no request under `bots/` and no `/save-index`,
  no bot hook on `World`.
- **nobundle** (bots asked of a build without them): `engine.js`, the `no-bundle` message.
- **broken** (a build whose library throws while it loads): `booted` names `engine.js` with 0 bots and the error is
  logged (the `load-failed` message); the world starts and a human logs in.

## Measured (macOS 27, Apple M2; `test/measure.mjs`, best of 3, idle world = 7 322 NPCs, 81 090 locs)

The build machine was shared with other jobs: start and tick times are upper bounds; heap numbers are stable across
runs. Measured 2026-10-23 with the performance changes of 2026-10-23 (`runtime/tick.ts`, `runtime/memory.ts`, the
start-up tables; these runs also had a maps zip slimmed at build time, taken out since: with the zip as shipped the heap
after start is the same, 112.0 MB in the peak runs below, and `World.start` was not measured again). Until then the V8
rows came from a contextified vm sandbox, whose global lookups are far slower than a worker's: on one build that made
`World.start` ~8 % and the idle tick ~1.6× slower than V8 is (`lib/vm-worker.mjs` now makes an ordinary global object).

| Runtime / variant | `World.start` | JS heap after start (GC) | Idle tick avg / p95 |
|---|---:|---:|---:|
| JSC JIT, shipped config | **236 ms** | **107.9 MB** `gcHeapSize` | 13.5 / 17.5 ms |
| JSC JIT, without flat strings | 270 ms | 195.4 MB (**−87.5 MB, −45 %** with the patch) | |
| JSC JIT, without the post-start release | 235 ms | 166.5 MB (release saves **58.6 MB**: 25.6 MB vfs + the WASM instance) | |
| JSC JIT, JS bzip2 only | 277 ms | 108.2 MB | |
| JSC `--useJIT=false --useWasm=false` | 3.6 s | 102.5 MB | 58 / 72 ms |
| V8 (Node 24 vm), shipped config | 361 ms | **114.9 MB** `heapUsed` (+13 MB ArrayBuffers: collision zones, packets) | 15.7 / 20.4 ms |
| V8, without flat strings | 401 ms | 184.6 MB (**−70 MB, −38 %**; start −40 ms) | |
| V8, without release | 360 ms | 114.9 MB heap, ArrayBuffers 39 MB (vfs is external memory in V8) | |

Before those changes (main 3bae7e3, the same machine and sandbox, `measure.mjs --bots --real`, one run each, 100 ticks
at 300 ms after the spawn ramp), and the JSC instructions a tick (the slope between two tick counts, 2 interleaved
runs):

| | `World.start` V8 / JSC | JSC heap after start / after the run | tick avg V8 / JSC | JSC instructions a tick |
|---|---:|---:|---:|---:|
| 0 bots | 789 → 368 / 471 → 239 ms | 146.2 → 107.8 / 149.2 → 111.2 MB | 21.7 → 18.1 / 17.2 → 16.0 ms | 57.8 → 39.6 M (−31.5 %) |
| 500 bots | 911 → 370 / 487 → 240 ms | 160.1 → 120.6 / 204.3 → 168.8 MB | 58.9 → 56.0 / 47.2 → 44.6 ms | 268.6 → 235.6 M (−12.3 %) |
| 1000 bots | 902 → 357 / 485 → 241 ms | 159.5 → 121.2 / 233.1 → 196.0 MB | 80.1 → 74.2 / 61.6 → 59.6 ms | 406.4 → 363.4 M (−10.6 %) |

Peak memory of the start (JSC shell, boot + `World.start` + a login + two ticks; `/usr/bin/time -l`, 4 interleaved
runs, median and range): main 3bae7e3 375 MB peak footprint (367–392), 385 MB peak RSS, heap after start 150.6 MB;
these changes 375 MB (364–384), 382 MB, 112.0 MB. So the heap after start is 38.6 MB lower and the peak where it was.
The WebContent process on a phone was not measured.

Soak (vm, `--soak=3000`, one player online, keepalives, 20 ms ticks, includes the tick-1500 autosave): heap 116.2 MB
after login, 120.5 MB after 600 ticks of warm-up, then 120.5 → 120.0 MB over the next 2 400 ticks – no growth; ticks
avg 6.6 ms, p95 8.6 ms.

Boot (manifest + 38 files from the local server, then evaluating the bundle; V8): 10–13 ms preload, 23–28 ms eval.
During the session with one player (JSC JIT, `jsc.test.mjs`): ticks avg 12.3 ms, p50 10.1 ms, p95 19.4 ms, max 162 ms
(the `::reload` tick); without JIT: avg 70 ms, p95 84 ms. Login (new player) answers in ~600 ms = next tick. A save
round-trip (sync XHR to the fake scheme handler) is < 5 ms. JSC `gcHeapSize` at the end of the JIT session: 112.1 MB.

### Bots (`measure.mjs --bots --real`, the real library)

A human at Lumbridge, the spawn ramp (5 a tick), then 200 ticks at 300 ms; one run each. These numbers predate much of
the bots' later behaviour and the performance changes of 2026-10-23 (their V8 lines come from the old contextified sandbox);
[docs/BOTS.md](../../docs/BOTS.md) §6 has current numbers for 500 to 1000 bots.

| JSC JIT | start | heap after start / after the run | tick avg / p50 / p95 / max | `BotManager.tick` avg / p95 | ramp max | `lifecycle save` |
|---|---:|---:|---:|---:|---:|---:|
| 0 bots (`engine.js`) | 453 ms | 146.6 / 150.3 MB | 17.7 / 18.2 / 22.6 / 24.8 ms | – | – | 2 ms, 1 PUT |
| 10 | 449 ms | 150.6 / 155.2 MB | 19.7 / 19.8 / 25.4 / 28.2 ms | 1.0 / 4.1 ms | 34.8 ms | 3 ms, 2 PUTs, 11.3 KB |
| 25 | 508 ms | 150.3 / 158.1 MB | 20.2 / 20.6 / 26.8 / 32.2 ms | 1.7 / 6.0 ms | 38.2 ms | 3 ms, 2 PUTs, 26.9 KB |
| 50 | 468 ms | 150.6 / 158.3 MB | 21.3 / 21.2 / 26.8 / 30.5 ms | 2.8 / 7.6 ms | 41.9 ms | 5 ms, 2 PUTs, 53.0 KB |
| 100 | 461 ms | 150.6 / 160.9 MB | 23.2 / 23.5 / 32.2 / 38.6 ms | 4.8 / 11.6 ms | 40.9 ms | 7 ms, 2 PUTs, 105.1 KB |

V8 (vm): `BotManager.tick` 1.4 / 9.1 ms avg at 10 / 100 bots, the whole tick 29.5 (0) → 41.1 ms (100). On the iPhone
13 mini (`app-test.mjs --device --bots N`): 50 fps with 25, 50 and 100 bots, ticks p95 12–27 ms late, a save with
every bot in 11–16 ms.

### Bots (`measure.mjs --bots`, the **stub** library)

The stub has no AI, so this is what the bots *runtime* costs – the second bundle, the glue, spawning, keep-alive,
strolling with path searches, the store – not the real bots' AI (`--real` for that; docs/BOTS.md §6 has the budgets).
A human at Lumbridge, the spawn ramp (5 a tick), then 100 ticks at 300 ms; one run each, machine otherwise idle.

| JSC JIT | start | heap after start / after the run | tick avg / p50 / p95 / max | `BotManager.tick` avg / p95 | ramp max | `lifecycle save` |
|---|---:|---:|---:|---:|---:|---:|
| 0 bots (`engine.js`) | 454 ms | 146.9 / 150.0 MB | 16.9 / 18.0 / 21.8 / 22.7 ms | – | – | 2 ms, 1 PUT |
| 10 | 464 ms | 147.3 / 151.3 MB | 17.2 / 17.7 / 21.0 / 23.2 ms | 0.08 / 0.16 ms | 24.6 ms | 3 ms, 2 PUTs, 9.0 KB |
| 25 | 454 ms | 147.3 / 151.9 MB | 17.3 / 17.7 / 22.8 / 24.5 ms | 0.48 / 1.84 ms | 27.1 ms | 3 ms, 2 PUTs, 21.2 KB |
| 50 | 454 ms | 147.3 / 153.0 MB | 17.6 / 18.0 / 22.2 / 25.6 ms | 0.69 / 2.72 ms | 26.4 ms | 4 ms, 2 PUTs, 41.7 KB |
| 100 | 453 ms | 147.3 / 154.9 MB | 18.6 / 19.3 / 23.1 / 24.6 ms | 1.38 / 3.28 ms | 26.9 ms | 6 ms, 2 PUTs, 82.6 KB |

V8 (vm, `heapUsed`): start 881–1064 ms at every count, heap after start 145.2–145.4 MB, after the run 150.3 (0) →
152.7 MB (100); `BotManager.tick` 0.26 / 2.48 ms avg at 10 / 100 bots; `lifecycle save` 3 ms (0) → 10 ms (100).
Bundle: `engine-bots.js` with the stub 494 KB (138 KB gzip; `engine.js` 464 KB): the glue and the stub add ~30 KB. A bot's save
is ~840 bytes, so `bots.sav` with 100 bots is ~83 KB, one PUT per occasion.

## Design notes (and why)

1. bzip2 "auto" uses the engine's `bzip2.wasm` through an own synchronous loader instead of `bzip2-wasm.js` +
   emscripten glue, and an own TS decoder instead of the web client's SheetJS one: the glue leaked ~33 MB per worker
   in JSC and SheetJS mis-decodes `title.dat`; both replacements are differentially tested against the original.
2. 38 runtime files, not 40: `flo.dat` is never read; `bzip2.wasm` is fetched by the bzip2 shim, not via the vfs.
3. Everything re-fetchable is released after start (not only the maps zip). This relies on `engine/vfs/**` and
   `cache/**` staying readable through the scheme handler for the life of the worker (they are bundle files). The
   released files' bytes are freed at once (`shims/vfs.ts` detaches each buffer with `ArrayBuffer.prototype.transfer(0)`,
   JavaScriptCore from iOS 17.4, V8 from Chrome 114), not at the worker's next full collection, which in WebKit can be a
   minute later: they were preloaded, so they are old by then and the young collections never take them. Nothing holds
   them after the release (`test/vfs-release.test.mjs`); without `transfer`, for a view of part of a buffer, or a buffer
   that cannot be detached, they wait for the collector as before.
4. Release builds keep `console` calls: the forwarded engine log is the only diagnostic on device. Only the worker's
   own console echo is debug-only.
5. `player_logout` is acknowledged even if the PUT failed (the save stays in memory, is retried and wins over storage on
   the next login); otherwise World would refuse that name until the write succeeds.
6. Protocol additions listed under "Protocol notes" (`fraction`, lifecycle aliases).
7. Bots: every hook is installed from `engine-bots.js` at run time, `entry.ts`, `saves.ts` and `threads.ts` are
   unchanged (so `engine.js` is byte-identical): bot saves are routed by wrapping the `saves` instance's `write` and
   `retryPending`, the name collision by wrapping `World.onLoginMessage`. `HANDLERS[10100]` being undefined with bots
   off follows from construction (no glue module and no `P_ISBOT` in `engine.js`, both build-checked) – `engine.js`
   exposes no handle to `ScriptRunner` to look at it at run time. The overlay's scripts carry the vanilla scripts'
   source paths (from where the upstream engine was packed), not the build's temp paths.

## Open issues

* Bots: esbuild bundles the library with its own nearest `tsconfig.json` (`bots/tsconfig.json`: keep class-field
  semantics, i.e. target ≥ ES2022); `tsc -p web/engine` checks it under this one (strict).
* Bots: native `LifecycleCoordinator` reads only `lifecycle-done.ok`, so a `bots.sav` that cannot be written while the
  app goes to the background is not retried on `background`/`terminate` (the next `resume`, Restart and the 15 s retry
  cover the foreground; an app killed while suspended loses the bots' unsaved progress).
* Bots: a bot whose engine turn throws every tick stays in the world (the engine's per-player catch cannot be tied to
  a bot without an engine patch); its lines are rate-limited and counted.
* Integration note: a save is a synchronous XHR that the native scheme handler starts on the **main thread**. Native
  code must never block the main thread while waiting for `lifecycle-done` (use `callAsyncJavaScript` + a background
  task), or pause/save deadlocks.
* The engine logs "World ready: Visit http://localhost:8888/rs2.cgi" (cosmetic, from `World.ts:326`).
* Offline limitations inherited from the disabled friend and logger servers: without the bots, friend and ignore lists
  last one login and private messages go nowhere (with the bots, `runtime/bots/friends.ts` keeps the lists:
  docs/BOTS.md §4.8); `::snapshot` cannot write a heap snapshot.
* `test/chrome.test.mjs` covers the protocol only; clock-freeze and crash paths are covered by (a) and (b).
