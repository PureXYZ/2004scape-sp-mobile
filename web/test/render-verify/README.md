# render-verify: the incremental 3D render against a full render, frame by frame

A scenario suite that tries to break the incremental 3D render (client-render-1: only the changed part of the 3D
scene is drawn while the camera is still). It puts the client into every situation where the 3D area changes while
the camera stays still, and checks **every frame** against a plain upstream full render of the same frame, in
headless Chrome (V8) and in a macOS WKWebView (JavaScriptCore and WebKit, the iPhone's engine version). The rule it
enforces: same game state, same pixels. A full refresh every second or two is a safety net, not an excuse: one stale
pixel in one frame is a failure.

It is test tooling only (no client or host change). It runs on any debug build: the client's own incremental render
(patch 0029, branch perf-render), the perf investigation's runtime prototype, or a build without either (where it checks
itself).

## Running it

```sh
node scripts/build-web.mjs --skip-pack --debug --out build/tmp/rv-game        # any branch: a debug build
node web/test/render-verify/run.mjs --game build/tmp/rv-game --engine both --impl native
```

| Option | What |
|---|---|
| `--game <dir>` | a **debug** web build (the suite exposes the renderer classes from the bundle; a release bundle has no class names). Default `build/Game` |
| `--engine chrome\|webkit\|both` | headless Chrome (V8), the WKWebView host (JSC), or both, one after the other. Default `chrome` |
| `--impl native\|prototype\|none` | the build's own incremental render (needs `World.incrBypass` and `World.incrLast`, `native-hooks.js`), the performance investigation's prototype (`prototype-incr.js`, on a build without patch 0029), or nothing (the oracle against itself: must give zero mismatches). Default `native` |
| `--impl mutant-freeze\|mutant-pick\|mutant-water` | deliberately broken renders the oracle must catch (a self-test): stale frames, a picked entity dropped, a frozen water animation |
| `--impl native-mutant` | patch 0029 with one step broken on purpose (what the last frame drew and this one did not is not redrawn): the oracle must catch it in the patch's own pipeline |
| `--every <n>`, `--bare` | development: check every nth frame only; or inject nothing (no oracle, no wrappers) to see the build exactly as it runs (with `--probe`, e.g. for screenshots) |
| `--session world\|bots\|lowdetail\|all` | `world`: no bots, Lumbridge and around (about 30 minutes); `bots`: 500 bots, Varrock West and Edgeville (about 25 minutes); `lowdetail`: Settings › World › Detail: Low (the client's low-memory renderer) with 15 of the world scenarios; `all`: the three one after the other (hours; better one at a time). Default `all` |
| `--only a,b` / `--skip a,b` | scenarios by name (below) |
| `--scale <f>` | multiplies every hold (0.15 for a quick pass that still runs every step) |
| `--out <dir>` | results; default `build/tmp/render-verify` |
| `--platform android` | Chrome only: the page as the Android app runs it (`../android-stub.mjs`: the Android user agent and native object, the Medium Phone AVD's 914x411 at 2.625, an 800x360 world; patch 0026 then sends whole frames). Results as `chrome-android-<session>.json` |
| `--port <n>` | the page server (n) and Chrome's debugging port (n+1); default 47660 |
| `--probe <module.mjs>` | development: after the session's setup, run the module's `run(ctx)` instead of the scenarios |

Typical runs (each line one session at a time; on the 16 GB Mac each inside the machine's heavy lock):

```sh
G=build/tmp/rv-game
node web/test/render-verify/run.mjs --game $G --engine both --session world --skip long-idle --scale 0.3   # quick: ~25 min
node web/test/render-verify/run.mjs --game $G --engine chrome --session world                               # full: ~30 min an engine
node web/test/render-verify/run.mjs --game $G --engine webkit --session world
node web/test/render-verify/run.mjs --game $G --engine both --session bots --scale 0.5                      # ~15 min an engine
node web/test/render-verify/run.mjs --game $G --engine both --session lowdetail --scale 0.3
node web/test/render-verify/run.mjs --game $G --engine chrome --platform android --session world --skip long-idle --scale 0.3
# the patch's full frames against main's: a main debug build's upstream-identity, then compare
node web/test/render-verify/run.mjs --game <main debug build> --impl none --engine both --session world --only upstream-identity --out build/tmp/rv-main
node web/test/render-verify/summary.mjs --identity build/tmp/rv-main build/tmp/render-verify
```

Each session is one big process (a game with its engine worker, up to 500 bots, in Chrome or the WKWebView): on a 16 GB
Mac run one at a time. Needs Google Chrome at its macOS path and Xcode's command line tools (`swiftc` builds the
WebKit host, `host/RVHost.swift`, into `build/tmp/render-verify/RVHost` on first use).

Exit code 0 only when every checked frame matched and no state, canvas or oracle error was seen.

## What is checked (oracle.js, in the page)

The oracle wraps `World.prototype.renderAll` from outside, around the build's own. For every frame:

1. the build's renderAll runs (partial or full) and leaves the 3D frame in `Pix2D.pixels`;
2. the same frame is rendered again by upstream's renderAll into a scratch buffer, from the **frame-start state**:
   the picking inputs, `World.click`/`clickX/Y`/`groundX/Z`, `Pix3D.cycle` and `texCycle`, every `minY` the build's
   frame changed, each animated loc's state as upstream's timeline has it (a shadow), and a texel pool of its own
   (texels are a pure function of the texture and its palette). Everything is put back afterwards, so the build under
   test runs exactly as without the check;
3. it compares:

| Check | What a mismatch means |
|---|---|
| pixels | a stale or wrong pixel in the 3D area (count, bounding box, samples; crops of the first frames per scene as PNGs: the build's frame, the reference, the difference in magenta) |
| picking | `Model.pickedCount` and the picked typecodes, in order, differ: the options menu would differ |
| ground | `World.groundX/groundZ/click` differ: a tap would walk elsewhere |
| heights | a player's or NPC's `height` differs: its chat, health bar or hitsplats would move |
| minY | a drawn source's `minY` differs: the next frame's occlusion tests would differ |
| textures | whether texture 17 (fountain) or 24 (animated water) animates after the frame differs (`Client.textureRunAnims` runs only when the frame fetched the texture): the water's phase would drift for good, which no single frame's pixels show |
| locanims | an animated loc's animation state drifts from upstream's (its lazy advance clamps a gap of more than 100 cycles) |

`shown.js` reads the canvases back every 25th draw and compares them with the PixMaps' pixels (client patch 0026 sends
only the changed pixels): what the oracle proves for the buffer, this proves for the screen. It also counts the world's
draws in game against the renderAll calls the oracle saw: a build that drew a frame without calling renderAll would
escape the check, and would show as more draws than calls.

Per scene the report also gives the most animated-texture triangles, animated locs, dynamic sprites, players, NPCs,
projectiles, spot animations and hitsplats seen in a frame, to show the scenario exercised what it claims.

## Scenarios (scenarios.mjs)

`world` session (no bots; a new character, the tutorial skipped, 99 in the skills used, tools and armour; about 30
minutes):

| Scenario | What |
|---|---|
| title-to-world | from the title into the world (the setup's two logins are checked too), a teleport, the camera settling |
| upstream-identity | full frames from fixed cameras at four places (32 views; no dynamic sprites, animated locs at frame 0, the colour table without its brightness jitter), hashed: `summary.mjs --identity <main results> <patch results>` compares them view by view, so the patch's full render (and `World.incrBypass`, the oracle's reference) is shown to be main's upstream render |
| lumbridge-npcs | the castle courtyard: NPCs walking in and out of view and behind walls, the fountains (texture 17), a pointer sweeping the world (picking) |
| camera-views | eight camera views of the courtyard (flags, fountains, doors), held still in each |
| camera-nudges | the camera moved by a hair and stopped again, 30 times (1-3 px drags, zoom steps, 40-400 ms apart): the switches between full, settling and partial frames |
| waterfall | Baxtorian Falls: about 2,700 triangles of the animated texture 17 a frame |
| animated-locs | Barbarian Village: about 80 animated locs in view |
| windmill | the mill north of Lumbridge: its sails (an animated loc), the farm's animals |
| fires | fires west of Lumbridge (animated locs), then one lit with a tinderbox (a loc added, animated, gone) |
| doors | doors opened and closed (a wall loc deleted and added) |
| ground-items | items dropped with tap-to-drop and taken again (ground objects appearing and disappearing, a stack changing) |
| woodcutting | a tree chopped to a stump (a loc change), the axe animation |
| fishing | net fishing at Draynor: the fishing spots' ripples (NPCs), the net animation |
| mining | rocks mined empty and back, the pickaxe animation |
| combat | cows fought: attack and block animations, hitsplats, health bars, deaths, drops |
| self-anims | the player animating in place: a teleport animation and spot animation, a hitsplat, armour and a weapon put on and off |
| roofs-levels | roofs hidden and shown (inside the castle's north wing and out), the staircase up a level, the top floor (its flags), and down |
| blends | translucent things moving by others: ghosts (alpha NPCs) by the fountain, spot animations beside it |
| chat-overhead | overhead chat with effects, NPCs added beside the player (`::npcadd`) |
| menus-labels | long-press menus (the host's and the drawn 2004 one), a tap that walks (the cross), the action label after an action on an NPC |
| hud-panels | every side tab's panel, the chatbox, Settings and the World map over the world |
| zoom | the minimap's zoom slider, a pinch on the world, the camera zoom held at 1.37, 0.73 and 1 |
| classic-layout | Settings › Layout › Classic (the 512x334 viewport) and back, a pointer sweeping it |
| resize | other screen sizes (667x375, 932x430) and back |
| fps30 | Settings › Frame rate 30 |
| brightness | the four brightness levels (a new colour table) |
| pause-resume | the app to the background and back (the host's lifecycle pause/resume), a visibilitychange |
| relog | logout to the title and login again |
| long-idle | twelve minutes untouched in the courtyard |

`bots` session (500 bots):

| Scenario | What |
|---|---|
| bots-title-to-world | the login into a world with 500 bots, a teleport into the crowd |
| varrock-west-500 | Varrock West bank: the crowd walking in and out of view and behind walls, chat, trades, drops; a pointer sweep half the time |
| edgeville-pk | Edgeville's PK fights from south of the ditch: hitsplats, projectiles, spot animations, teleports, deaths, drops |
| edgeville-wild | in the Wilderness among the PKers |
| bots-relog | logout and login with 500 bots |
| bots-long-idle | twelve minutes untouched at Varrock West |

`lowdetail` session (Settings › World › Detail: Low, a restart setting: the client's low-memory renderer, with other
ground, 64 px textures and no texture animation): title-to-world, lumbridge-npcs, camera-views, camera-nudges, waterfall,
animated-locs, fires, doors, woodcutting, combat, blends, menus-labels, zoom, classic-layout, relog.

Animated textures: rev 274's client animates only textures 17 (fountain, also the rivers at Baxtorian Falls) and 24
(water_animated); lava (31) does not animate. A tour of 21 places (Varrock, Falador, Seers', Baxtorian Falls, Karamja,
Catherby, Ardougne, the Duel Arena and others) found texture 24 drawn nowhere, so texture 17 stands for both.

## Results

`node web/test/render-verify/summary.mjs <out> [<out> ...]` prints the table of one or more result folders;
`--identity <main out> <patch out>` compares the upstream-identity hashes (exit 0 when every stable view matches).

`<out>/<engine>-<session>.json`: per scenario the frames, frames checked, partial frames checked, mismatching frames and
pixels, state mismatches and the scene's content; the whole session's report (every mismatch with its frame, loop cycle,
bounding box, samples, camera and scene; the build's own counters, e.g. patch 0029's full-frame reasons); the canvas
read-backs; page errors. `<out>/<engine>-<session>-<scene>-f<frame>.png`: crops of mismatching frames.

## Files

| File | What |
|---|---|
| `run.mjs` | the command line: sessions, scenarios, results |
| `summary.mjs` | the results as a table, and the cross-build identity comparison |
| `scenarios.mjs` | the sessions and scenarios, and the game helpers they use (finding an option on screen, NPCs, inventory slots) |
| `oracle.js` | the in-page check (above) and the pointer sweep |
| `native-hooks.js` | the adapter for patch 0029 (`World.incrBypass`, `World.incrLast`) |
| `prototype-incr.js` | the perf investigation's runtime prototype, unchanged |
| `shown.js` | the canvas read-back |
| `input.js` | touches as synthetic pointer events for the WebKit host |
| `lib.mjs` | the page script, the exposed bundle, game steps (login, logout, teleport, settings), PNG crops |
| `chrome.mjs` | the Chrome driver (CDP, an iPhone 13 mini in landscape with real touches) |
| `webkit.mjs`, `host/RVHost.swift` | the WebKit driver and its host: a macOS WKWebView, 812x375, the iPhone's user agent, `callAsyncJavaScript` for evaluation |
