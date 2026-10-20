# web/client: the patched Client-TS 274 build

This directory builds the upstream webclient (Client-TS 274 at the commit `upstream.json` pins, a read-only input)
with this project's patches and overrides, and writes the client part of `build/Game/` (docs/ARCHITECTURE.md §2), which
both apps use. The patches are named `ios:` and their lines marked `custom (ios)` because they were first made for the
iPhone app; they apply to Android unchanged.

```
<out>/client/client.js [client.js.map]   patched bundle (ESM, exports Client)
<out>/client/mapview.js [mapview.js.map] the World map (patch 18: MobileMapView, upstream's 2004 map applet for touch)
<out>/worldmap.jag                       its data, from the engine's data/pack/mapview/ (the engine's packer)
<out>/client/tinymidipcm.wasm            from webclient src/3rdparty/tinymidipcm/
<out>/client/SCC1_Florestan.sf2          from the engine's public/client/
<out>/crc                                40 bytes = engine CrcBuffer.data
<out>/title410306098 … <out>/sounds-759577225   the 8 jag archives, named /<name><signed crc> as the client requests them
```

## Build

```js
import { buildClient } from './web/client/build.mjs';
const summary = await buildClient({ out, debug = false, webclientDir, engineDir }); // defaults: the upstream checkouts (scripts/lib/upstream.mjs)
```
```sh
node web/client/build.mjs --out build/Game [--debug] [--webclient <dir>] [--engine <dir>] [--json]
```

Takes about 0.4 s. Output is deterministic (same inputs give byte-identical client.js and map). Steps:

1. **Cache-derived files.** Reads `engine/data/pack/main_file_cache.*` with a port of engine `FileStream.read`,
   builds `/crc` exactly as `CrcTable.makeCrcs()` does and the 8 archives as `web.ts` serves them
   (`cache.read(0, i)`). The build fails if:
   - archive 0 does not hold exactly 9 files;
   - an archive cannot be read (broken sector chain);
   - the CRC trailer or an archive CRC fails the client's own checks;
   - any loose copy (`data/pack/client/*`, `data/raw/wordenc`) differs from the cache copy, meaning the pack is half-updated;
   - any of the 6,203 OnDemand files fails `OnDemandWorker.validate()` against the versionlist. This check runs
     the client's own `BZip2.js` and matters because LocalOnDemand serves those files straight from this cache.
2. **RSA.** `LOGIN_RSAN`/`LOGIN_RSAE` come from `engine/data/config/private.pem` (the file World.ts reads;
   `public.pem` has n and e swapped and is ignored). The build encrypts a login-shaped block the client's way
   (m^E mod N) and requires it to decrypt the engine's way (CRT with p, q, dP, dQ, qInv) and with d.
3. **Source tree.** Copies `webclient/{src,tsconfig.json,package.json}` to `build/tmp/client/work-<mode>/` and
   `git apply`s `patches/*.patch` in order. Before applying anything it runs `--check`; on failure it reports the
   patch, git's message, the base/current commit drift and how to rebase.
4. **Overrides.** `overrides/<path>` stands in for `<webclient>/<path>`, through an esbuild resolve plugin (a true
   alias, so source maps show the override files). A `#/` import of a module that exists only in overrides is
   an addition. The build fails if a patch touches an overridden file, or if an override is never used.
5. **esbuild 0.28** (from `web/node_modules`): `bundle`, `format: esm`, `platform: browser`,
   `target: safari16`, the tree's tsconfig paths, and `fflate` resolved from `web/node_modules`.
   - defines: `SECURE_ORIGIN='false'`, `LOGIN_RSAN`, `LOGIN_RSAE`, `BUILD_TIME`.
   - Release: `minify` (whitespace, syntax and identifiers; never property names) plus `drop: ['console']`, about 465 KB.
   - Debug: unminified, linked source map, console kept: about 950 KB plus a 2 MB map.
6. **Bundle checks.** The build fails unless:
   - the bundle has a `Client` export;
   - every client member the host touches is present by name (`keyHeld`, `idleTimer`, `loginUser`,
     `setTargetedFramerate`, …);
   - no `process.env` is left;
   - there is no `new Worker(` or `ondemandworker.js` (LocalOnDemand is in effect);
   - the overrides are present.
7. **Write.** Replaces `out/client/` wholesale, so no stale map survives a debug-to-release switch. Writes `crc`
   and the jags. Deletes only stale *jag-named* files from `out/`.

The returned summary has the CRCs, sizes, commit, patch and override lists, and OnDemand counts, for `build-info.json`.

## Overrides (whole modules, `overrides/src/...`)

| Module | Why |
|---|---|
| `io/OnDemand.ts` (LocalOnDemand) | Same public surface as upstream. `request()` reads the raw file synchronously from `globalThis.__LC_CACHE__ = {dat, idx[5]}` (FileStream.read port: 6-byte idx entries, 520-byte sectors, chain validated). It checks the file against the versionlist (version trailer + CRC, like `OnDemandWorker.validate`; a bad file becomes "missing" instead of throwing inside the game loop) and queues it as completed. The unchanged `loop()` strips the trailer and gunzips. There is no worker, no second WebSocket and no IndexedDB. `prefetch*`/`clearPrefetches` are no-ops; `run()` only ticks `cycle`. A missing `__LC_CACHE__` fails loudly with "loaderror - …" on the canvas. |
| `client/MobileKeyboard.ts` | Same default-export surface. With `lcHost.keyboard`, `show/hide/isDisplayed` delegate to it: Swift raises the keyboard, which also works outside a user gesture (e.g. the server's amount dialog). Without a host, a hidden `<input type=text>` is used for desktop testing (upstream's `type=password` brought up iOS's password AutoFill bar). The on-canvas QWERTY is gone, so `isWithinCanvasKeyboard` is always false. |
| `client/LcHost.ts` (new) | Typed access to `globalThis.lcHost` (`lcSetting`, `lcHaptic`, `lcTakeSecondaryClick`, `lcEvent`, `lcKeyboard`). Every host call is wrapped so a host bug cannot throw into the game loop. With no host, the client behaves as upstream. |
| `client/TouchWording.ts` (new) | `touchWording(line)` and its table: exact, case-sensitive phrases from the rev-274 content ("use your left mouse-button to click" → "tap", "right click" → "long-press", "use your keyboard's arrow keys to rotate the view" → "drag the view with your finger to turn it", ...), applied per line, with start/end-anchored pieces for phrases the server's own line splitting breaks in two. Used by patch 15. |

## Patches (`patches/NNNN-*.patch`, unified diffs against the upstream webclient, base in `patches/BASE`)

Each patch file starts with its rationale (the commit message). Every changed line is commented `custom (ios)`.

| # | Patch | What and why |
|---|---|---|
| 1 | never-open-indexeddb | `this.db = null` instead of opening IndexedDB: all files are local, and in WKWebView the IndexedDB path made startup ~10x slower. Low detail still unloads unused models after a map build, because LocalOnDemand can re-read them (upstream did so only with a db). |
| 2 | harden-isfullscreen | `!!document.fullscreenElement` (WKWebView has no Fullscreen API; `undefined !== null` would map every tap through the letterbox branch). |
| 3 | pointer-robustness | **One finger at a time:** extra touch/pen pointers are ignored until they lift, so multi-touch gives no extra clicks, drags or pans. The filter tracks pointer ids rather than `isPrimary` alone: a finger resting on a host overlay button makes every later canvas touch non-primary. A primary pointerdown self-heals the tracking. **`pointercancel`** gives no click, ends drag/pan (an item drag is aborted, not dropped) and releases the arrow keys. **pointerdown focuses the canvas** (`preventScroll`, never stealing focus from a text field) so a hardware keyboard works. |
| 4 | touch-gestures | **Long-press on hold:** after `settings.longPressMs` (default 450 ms) within `TOUCH_SLOP` (10 CSS px), with no drag or pan, the client right-clicks under the finger and calls `haptic('medium')`, so the menu opens while you hold. Releasing over an option picks it; releasing elsewhere leaves the menu open; the release never clicks. A starved timer is still honoured on release. **Right-click mode:** a tap clicks with button 2 when `takeSecondaryClick()` returns true. **Frame-synced taps:** a left click runs the top minimenu entry, which each *draw* rebuilds from the pointer position. A quick tap could lift before any frame was drawn there and run the previous spot's action (seen: a 60 ms tap on "Accept" did "Cancel"), so the click waits for a frame drawn since pointerdown, at most one frame. **Proportional camera:** yaw -4 and pitch +2 units per CSS px, times `settings.cameraSensitivity`; pitch clamped to 128..383; no momentum; `sendCamera` set. This replaces upstream's held-arrow joystick, which kept spinning while the finger rested. Touches no longer hold or release arrow keys. Side/chat drag emulation now starts at `TOUCH_SLOP` instead of 5 px, so a wobbly long-press on an item is not a drag. |
| 5 | keyboard-follows-input | `syncMobileKeyboard()` runs once per client cycle on mobile. It derives the typing context in `handleInputKey()`'s order: `login-user`, `login-pass`, `report`, `social`, `dialog`, `chat` or none (the §7 kinds). It acts only on a change, so a keyboard the player dismissed stays down. Opening the amount dialog (P_COUNTDIALOG), report abuse (button or menu) or social input (add/delete friend or ignore, PM) shows the keyboard; upstream never did for social input. A login field change while the keyboard is up re-shows it so the host can switch prompt and secure entry. Any other change while it is up (input closed, logged in or out) hides it. A tap on an input area always (re)shows it, and selects the tapped login field first; upstream hid it when you tapped from username to password. Upstream's two direct `show()` calls from packet handlers are replaced by the sync. |
| 6 | stay-logged-in | With `settings.stayLoggedIn`, the client never sends IDLE_TIMER (opcode 209) and never arms `logoutTimer` after 90 s without input. |
| 7 | host-events | `onClientEvent('ingame', bool)`, `('menu-open', {area, x, y, width, height, options[] top→bottom with colour tags})` and `('menu-close')`. |
| 8 | drag-to-scroll | A vertical-first drag on the content of a scrollable layer (side lists, the bank, chat modals) or on the chat history scrolls it, with the content following the finger. Upstream offered only the 12 pt scrollbars, and a drag on chat text clicked at the release point. Horizontal-first drags and drags on a scrollbar keep the left-button emulation (moving items, dragging scrollbars). |
| 9 | offline-new-user | "New User" opens the login form with the hint "New character: choose any username and password." (the offline world creates a character for any new name; upstream's screen pointed to account creation on the website). |
| 10 | drag-press-point | An item drag presses where the finger went down, with the minimenu rebuilt for that point (mouseLoop takes the dragged slot from it). It used to press where the finger was after `TOUCH_SLOP`, which could be the neighbouring inventory or bank slot. |
| 11 | mobile-layout | For the mobile HUD (ARCHITECTURE.md §6.1): with `setSurfaceLayout()` the viewport, minimap, side panel and chat draw into canvases of their own (`PixMap.retarget`). The viewport can be any size from 512×334 (Pix3D clipping, `World.resetVisCalc`, areaGame follow it) and lives on an input "island" at virtual x 1024+, so the other areas keep their classic rects and hit tests; only the viewport's `4, 4, 512, 334` sites take the new rect. `setViewportInsets()` places the main modal, the overlay and the viewport texts clear of the HUD (a main modal wider than the free part starts at its left edge and runs on under the HUD on the right, never into the left inset with the notch). Every surface gets the canvas's pointer handlers, mapped onto its virtual rect (frozen per touch, pointer capture); a drag that leaves its surface never clicks into another area. HUD API: `tapAt`, `hudState`, `hudChatLines`, `hudSetRun`, `cancelPointer(On)`. In this layout a tap on the compass faces north. World menus stay inside the free part when they fit; the "moved away from the menu" close test includes the point the menu was opened at; a long-press release picks an option only after the finger slid to it (also in classic: near the bottom edge the clamped menu used to put Cancel under a resting finger). `hudSetRun` refuses while a window is open (the Walk/Run buttons' script closes it); `reconnecting` is set while lostCon logs in again. Without a layout everything else is classic and unchanged. |
| 12 | host-menus-pinch-zoom-hud-stats | For the redesigned HUD: **host menus** (`setHostMenus(true)`: the host shows the options menu itself; the client neither draws it nor picks from or closes it on its own; `hudMenu()`, `hudMenuSelect(serial, index)`, `hudMenuClose(serial)` run in the next cycle like a click on the menu, and a close does not undo a pick of the same menu made before that cycle; every menu gets a serial; `'menu-open'` carries the serial and the `pointerId` of the finger that long-pressed it while it is down, else -1). **Pinch zoom** (`setCameraZoom(zoom)` → applied zoom: the orbit camera's distance × 0.6..1.4). The tile-visibility matrix is computed once, at maininit and on a viewport resize, with the frustum's height range widened to cover every zoom (`World.resetVisCalc(distance, 500 + ceil(hMax × 0.4), 800 + ceil(hMax × 0.4), w, h)`, hMax = the steepest pitch's camera height): recomputing it per zoom stalled pinches by 60-300 ms. `TOUCH_SLOP` 14 px, long-press 400 ms, the tooltip only while a finger is down (a use or target mode that a tap selected keeps its prompt, "Use Tinderbox with...", not the option last under the finger), `hudState()` hp/prayer/cameraYaw/cameraZoom, `hudFaceNorth()`. |
| 13 | touch-model | Every touch is exactly one of tap, long-press, camera turn, item/scrollbar drag or scroll: the turn starts at `TOUCH_SLOP` with the whole way from the touch-down point (no dead band, nothing lost); a touch released past the slop never clicks (a drifting long-press attacked or walked). A long-press opens a menu only where there is something besides "Cancel" (not on the minimap or bare stone), and no longer plays the haptic itself (the host does, on `'menu-open'`); `hudState().longPressable` says whether a long-press at the pointer would open one. In game, a tap while the keyboard is up only hides it (an open menu still takes it). On touch an inventory slot takes its whole grid cell (icon plus half the margins) for options, drags and drops, and exactly one slot takes a point: where cells overlap (worn equipment, icons 41 px apart) the slot whose icon is under the finger, else the one whose icon is nearest. Drag-to-scroll glides on after the finger lifts (speed over the last 80 ms, × 0.9 per cycle, stops at the end, when the interface closes or at the next touch); a tap on the list while it glides (1 px per cycle or more) only stops it, as on a native list, while a tap elsewhere or a right click acts as usual. A finger pressing an interface button (IF_BUTTON, toggle, select, close, continue) or a title button gets `haptic('selection')`. |
| 14 | dialogue-helpers | `hudState().chatContinue` (the chat modal's only button is "Click here to continue"): a touch tap anywhere on the chatbox continues it ('selection' haptic); `hudContinue()` does it for the host. `hudDialog()`: `null`, or `{options: [{text, x, y, w, h}]}`, the chat modal's answers (text buttons of buttontype "normal" with a text) top to bottom with their clickable virtual rects, for `tapAt`. `hudCancelInput()` closes an amount prompt, a name prompt or the report screen. `hudState().tutorialKey` identifies the tutorial instruction shown; `hudState().tutorialMessage` says the tutorial's chatbox shows a game message until the next click (it still counts in `chatModal`), so the HUD can tell it from a dialogue. |
| 15 | touch-wording | On touch, IF_SETTEXT texts and the interfaces' own texts go through `touchWording` (overrides `TouchWording.ts`); "Click to continue" in the tutorial box becomes "Tap to continue". Checked against every script text with mouse/click/arrow-key wording: 96 lines rewritten, each within the width the server split it to and static texts within their component. |
| 16 | login-form | The keyboard opens by itself when the login form opens (typing context none → `login-user`, not while reconnecting). The username and password rows are 30 px tall (upstream 15) in `titleScreenLoop` and `insideLoginUser`/`insideLoginPass` (across the title box), nothing drawn differently. |
| 17 | minimap-zoom | `setMinimapZoom(zoom)`: the minimap at 0.75..2 times its pixels per tile (the HUD's slider); the map, its dots, the hint arrow and a tap on the map follow it, `hudState().minimapZoom` reports it. 1 = upstream. |
| 18 | world-map | The HUD's World map (ARCHITECTURE.md §6.1). `src/mapview/MobileMapView.ts` (new, the entry of `client/mapview.js`, run in `mapview.html`'s iframe): upstream's MapView with touch controls in place of the applet's buttons and keys. Drag pans (gliding on), a pinch zooms and settles on the applet's 37/50/75/100 % (its labels are drawn at those only), a double-tap zooms in, a two-finger tap out. It draws the player (a white dot in a ring flashing red and white), the overview on request and a key's flashing icons (gliding to the nearest when none is in view), shows the map the player is on (surface, underground, other places: MapView's three maps) and, on a switch, what lies under or over the view. The map is drawn into a buffer a little larger than the canvas and shown from a fraction of a tile in, so panning is smooth, and redrawn only when its tiles change. The host drives it with postMessage (`show`, `player`, `centre`, `area`, `overview`, `key`, `pause`); it answers `state` and `keys`. MapView's grids are columns of typed arrays (as nested plain arrays its 1600×1408 tiles took ~96 MB of JS heap). `hudPlayerTile()` gives the local player's world tile. |
| 19 | tap-to-drop | `setTapToDrop(on)`: the HUD's tap-to-drop (as on OSRS mobile). While on, a tap on an item in the inventory tab drops it (OP_HELD5, the item's fifth op: "Drop", for a bloated toad "Release") instead of doing its first op: the item drag's release (`objDragArea`) picks the drop entry of the top entry's slot (`tapDropOption`). Only for the item's own ops in the tab panel, so a long-press (the menu), a drag (moving the item), a use or target mode and side modals' inventories (bank, shop, trade) are unchanged. `hudState().tapToDrop` reports it. Off by default: nothing changes. |
| 20 | action-label | On a touch screen nothing hovers and the finger covers what it taps, so after an action that starts a red cross (an op on an NPC, player, loc or ground item, an item used or a spell cast on one, also from the long-press menu) or acts on an item in a slot (inventory, worn equipment, bank, shop) the client sends `onClientEvent('action-label', {text, x, y})`: the option as drawn, with its colour tags, and the red cross or the tapped point in page px (`GameShell.pagePoint`, the inverse of `getMousePos`). The host shows it beside that point (menu.js). Touch screens only. |
| 21 | landing-menu | A touch acts on what was under the finger when it landed: the first frame drawn after pointerdown builds the minimenu and later frames keep it (`holdsLandingMenu`) while the finger can still tap or long-press, and after it lifts until its tap's click has been handled. Its NPC and player options follow one that walked off, and its "Walk here" walks to the ground tile picked in that frame (`menuGroundX/Z`, `walkToMenuGround`). A change of the open windows, tab, use or target mode or map drops it. Before, a long-press opened what was there 0.4 s later. Touch screens only. |
| 22 | head icons stack above the head | A player's head icons stack up from the head in 274's order: the skull just above it, a protection prayer's icon over that, a player's hint arrow over them all. Upstream (as 274 did) drew each next icon 25 px lower, so a skulled player with a protection prayer had the prayer's icon on the face. |
| 23 | overhead text of stacked players stays on top | Only the first entity on a tile's centre is drawn each frame (upstream's `tileLastOccupiedCycle`); the others never build a model, so their `height` stayed 0 and their chat, health bar, hitsplats and head icons sat on the ground. A skipped player or NPC takes the height of the entity drawn on its tile (`tileOccupant`). Common with hundreds of bots sharing tiles. |
| 24 | tap-to-drop deposits all in the bank | With tap-to-drop on (patch 19), a tap on an item in the bank's side inventory deposits all of it (its "Deposit All" op) instead of one: `tapDropOption` picks that entry of the same slot and component when the top entry is one of the side inventory's own ops. Shops and trades (no "Deposit All") are unchanged, as are a long-press and a drag. `hudState().tapDeposit` says the side modal holds such an inventory, for the HUD's red frame. |
| 25 | tap options | What a tap does with Attack on NPCs and on players (Settings › Tap options): `setAttackOptions(npc, player)`, each `'tap'` (Attack is always the top entry), `'level'` (upstream: below the next entry when their combat level is above yours), `'hold'` (always below it: Attack only from the long-press menu) or `'hidden'` (no Attack entry). Only an op called "Attack" is affected. |

What the client asks of `lcHost` (ARCHITECTURE.md §6):
- `keyboard.show()`, `keyboard.hide()` and `keyboard.isShown()`. These take no arguments; the host derives the
  kind from `__client`, and `test/stub/stub-host.js` `kindOf()` is a reference implementation of the same order
  as the patch.
- `haptic('selection')` when a finger presses an interface button or a title button, or continues a dialogue with a tap
  on the chatbox (the long-press haptic is the host's, on `'menu-open'`).
- `takeSecondaryClick()` once per tap.
- `settings.{stayLoggedIn, longPressMs, cameraSensitivity}`, read live.
- `onClientEvent(...)`: `'ingame'`, `'menu-open'` (`{serial, area, options, x, y, width, height, pointerId}`),
  `'menu-close'`, `'action-label'` (`{text, x, y}`).

What the host may call (listed in `HOST_FIELDS` so the build fails if a name is lost): patch 11 `setSurfaceLayout`,
`setViewportInsets`, `tapAt`, `hudState`, `hudChatLines`, `hudSetRun`, `cancelPointer`, `cancelPointerOn`; patch 12
`setHostMenus`, `hudMenu`, `hudMenuSelect`, `hudMenuClose`, `setCameraZoom`, `hudFaceNorth`; patch 14 `hudContinue`,
`hudDialog`, `hudCancelInput` and the `hudState()` keys `longPressable` (patch 13), `chatContinue`, `tutorialKey`,
`tutorialMessage`; patch 18 `hudPlayerTile`; patch 19 `setTapToDrop` and the `hudState()` key `tapToDrop`. Not in `HOST_FIELDS` but called or read
by the host too: patch 24's `hudState().tapDeposit` and patch 25's `setAttackOptions`; patch 20 sends the
`'action-label'` event. The suite below runs the classic layout (its stub page sets no layout); `web/test/hud.mjs` covers the
mobile one.

## Updating the patches when upstream changes

```sh
node web/client/patches.mjs check                 # do the patches still apply? (what build.mjs does)
node web/client/patches.mjs edit --onto-current   # git repo in build/tmp/client/patch-work:
                                                  #   upstream@BASE (git archive) + one commit per patch,
                                                  #   then a real 3-way `git rebase` onto the current webclient
# resolve any conflicts there (git add, git rebase --continue, then `git tag -f upstream upstream-new`)
node web/client/patches.mjs export                # rewrite patches/*.patch (header = commit message) + patches/BASE
node web/client/test/typecheck.mjs && node web/client/test/run.mjs --quick
```
- **Editing or adding a patch.** Run `patches.mjs edit`, change files in `patch-work` and commit. Amend or fixup
  the matching commit, one commit per patch. Then run `export`; an edit/export round trip is byte-stable.
- **When a build fails.** It prints the failing patch and git's reason.
- **Where the base comes from.** The rebase needs the webclient checkout to be a git repository that still contains
  the `BASE` commit (`scripts/fetch-upstream.mjs --update` keeps the commit it moves from).

## Tests (`test/`, ports 47400-47449 only)

```sh
node web/client/test/typecheck.mjs          # tsc --noEmit: patched+overrides vs upstream; fails on any new diagnostic
node web/client/test/run.mjs [--quick] [--debug] [--no-engine] [--engine-bundle <dir>] [--engine-layout auto|old|new]
node web/client/test/serve.mjs --game <dir> # just serve a Game dir + stub page on :47400 (manual poking)
```

What `run.mjs` does:
- Builds the client into `build/tmp/client/test-game`.
- Serves it on `127.0.0.1:47400`, with `/cache/*` mapped to the engine pack, `/engine/*` to an engine worker
  build, in-memory `/save/*` and `/log`, and the stub page `test/stub/`. The stub provides:
  - `lcHost`, which records every call;
  - a fake global `WebSocket` (EngineSocket) bridging to the engine worker with init→booted→start→ready and
    connect/data/close (old engine-compat and new §4 layouts), or to a canned "invalid login" in `--no-engine`;
  - `__LC_CACHE__`;
  - spies on `indexedDB.open`, `Worker` and clicks.
- Drives headless Chrome over CDP (`:47401`) as an **iPhone 13 mini in landscape (812x375, DPR 3, touch, iPhone UA)**,
  with real `Input.dispatchTouchEvent` touches.
- Engine bundle: `--engine-bundle`, else `build/Game/engine` (build it first with `node scripts/build-web.mjs`).

Checks:
- **Title.** LocalOnDemand (`db===null`, `indexedDB.open` never called, no ondemand worker, socket or
  request); `/crc` and the 8 jags served 200.
- **Multi-touch.** A second finger gives no click.
- **Login form.** Opening it (Existing User) shows the keyboard for the username by itself; the title button gives
  `haptic('selection')`.
- **Canvas focus.** pointerdown focuses the canvas.
- **Login keyboard.** Tap user field → show `login-user`; Enter → show `login-pass`; tapping user→pass never
  hides; Login → hide.
- **Login.** New account on Tutorial Island through the engine worker; `ingame` event.
- **Taps.** Tap "Accept"; tap = exactly one left click with the default action.
- **Long-press.**
  - Menu open *before* lift, right click only, no client haptic, `menu-open` event with the finger's `pointerId`.
  - Release keeps the menu open with no click.
  - Tap an option; press-drag-release onto an option.
- **Right-click mode.** One-shot; its `menu-open` has `pointerId` -1.
- **Camera.**
  - 40 px → exactly 160 yaw; unchanged while the finger rests; 80 px back → 320.
  - Pitch +60 for 30 px.
  - No keys held; release does not click.
  - Sensitivity 0.5 → 80.
  - An 18 px drag turns 72 (the turn starts at the slop with the whole way), no click.
- **pointercancel.** Cancels a pending long-press, a pan, and a side-panel drag (button up, item drag aborted).
- **Chat.** Tap shows `chat`, typing lands in `chatInput`, tap elsewhere hides (and does nothing else in game).
- **Amount dialog.**
  - `::give coins 100`, `::~bank`.
  - Long-press the coins → menu with Deposit options; "Deposit X" → server P_COUNTDIALOG → show `dialog`.
  - "5" + Enter → hide.
- **Report abuse.** Button → show `report`; closed → hide.
- **Social input.**
  - `::setvar tutorial 1000`, log out, log in again (the save round-trips).
  - Ignore tab → Add → show `social`; submitted → hide.
- **Drag-to-scroll.**
  - The quest list (`scrollPos` 0→42) scrolls with no click.
  - Horizontal-first keeps the drag emulation.
  - Chat history down reveals older lines.
- **Idle.**
  - `stayLoggedIn=true` and **95 s of real idle** (`--quick` back-dates instead): no 209, `logoutTimer` 0, still in game.
  - Control with `stayLoggedIn=false`: 209 sent once.
- **No host.** The keyboard falls back to a hidden text input whose keys reach the login field; tapping outside
  re-focuses the canvas.

Results, screenshots (title, login, long-press menu held, camera, amount dialog, report, social, chat scrolled),
the stub log, the console and the request log are in
`build/tmp/client/test-results-<release|debug>-<newengine|oldengine|noengine>-<full|quick>/`. A full run includes 95 s
of real idle time to check that the client sends no IDLE_TIMER; `--quick` back-dates the timers instead.

## Notes and open issues

- **Device-only behaviour.** Chrome (Blink) emulation is not WebKit. Long-press against WebKit's own gestures,
  implicit pointer capture for touch, the native keyboard round trip and haptics are covered by the in-app tests
  (`web/test/app-test.mjs`, `web/test/native/`), not here. The host keeps `touch-action:none`,
  `-webkit-touch-callout:none` and `isTextInteractionEnabled=false` for that reason.
- **Tutorial messages.** During the tutorial a server game message goes to the tutorial box, and upstream uses
  the next click anywhere to dismiss it. This is game behaviour, left unchanged; the harness taps once to dismiss.
- **pointercancel and host keys.** pointercancel releases arrow keys 1-4. A canvas gesture cancelled while a host
  overlay button holds an arrow key would release that key too. Touches themselves no longer touch `keyHeld`.
- **Drag threshold.** `TOUCH_SLOP` (14 CSS px since patch 12; 10 in patch 4) also raises upstream's 5 px side/chat drag
  threshold.
