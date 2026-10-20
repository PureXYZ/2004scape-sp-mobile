# Bots

The bots are other players in your offline world: up to 1,000 at a time, each a real player character driven by an AI
inside the game server. They come from [2004sp-progressive](https://github.com/2004sp/2004sp-progressive) ("Lost City
Singleplayer Progressive", a mod of Lost City **revision 254** by attackishere, _mrsam, K-andy and callum), ported to
revision 274 and extended to behave like the players of late 2004. They are optional: with Settings › World › Bots at
Off the game is exactly Lost City, and none of the bots' code is loaded.

This file describes what the bots do, how they are built into the engine, their contracts with the rest of the app,
their performance, their tests and how to maintain them. What a player sees is summarised in the
[README](../README.md#bots). The bot library's own guide, with the full list of changes from upstream and why, is
[web/engine/bots/README.md](../web/engine/bots/README.md).

Contents: [what they do](#1-what-the-bots-do) and [the design rules](#design-rules), [how it fits](#2-how-it-fits),
[where things are](#3-where-things-are) and [the library](#the-bot-library), [contracts](#4-contracts) and
[chat](#49-chat-and-the-chat-model), [changes from upstream](#5-changes-from-upstream-2004sp-progressive),
[performance](#6-performance), [tests](#7-tests), [maintenance](#8-maintenance), [credits](#9-credits).

## 1. What the bots do

### Who is online

- **About N online, out of a pool of about 2N.** Settings › World › Bots (Off, 25, 50, 100, 250, 500, 750 or 1000;
  default 500) sets N. The pool takes turns: each bot plays a session, logs out and comes back later exactly as it left.
  Sessions are heavy-tailed, from 5 minutes to 6 hours with a median of about 42 minutes (measured 2004-era MMO
  sessions have a similar shape); absences run 10 minutes to 1.5 hours, shorter after a short check-in.
- **Time is play time.** The bots' clocks run only while you are in the world. On the title screen they all log out
  after a minute and return when you log in, the ones near you first.
- **Roles.** 70 % of the places go to levelling bots (skillers, fighters, balanced and random, 17.5 % each) and 30 % to
  the extras (vendors, social regulars, Edgeville PKers and deep-Wilderness PKers, 7.5 % each), at every size.
- **Newcomers.** Brand-new level-3 players arrive at the Lumbridge courtyard over time, paced so that Lumbridge keeps
  7-9 low-level players per 100 online, and 1-3 follow you out of Tutorial Island when you make a new character. A
  newcomer has Tutorial Island's kit, plays as a newbie (chickens, cows, goblins, newbie questions, begging) until
  combat 10 or total level 60, and two in three are slow levellers who wander and chat. When newcomers push the pool
  over its size, an old account that is away quits for good, never one on your friend list.
- **A world with history.** A new bot world starts with a mix of ages drawn from each bot's name: a quarter fresh,
  then novices, intermediates, experienced players and veterans (combat levels up to about 120), with the skills, gear,
  bank and starting bank their tier suggests. Raising the count later brings more bots with the same mix.

### What they do

- **Skills and gear.** Levelling bots plan an activity for 15-60 minutes at a spot near them, chosen by their
  personality's skill weights, a 2004-style mix (more combat, the period's crowd spots), their favourite skills and
  their home town. They start with tools, an iron scimitar, 5 shrimps and 200 coins, and buy their gear through the
  game's own shops as their levels and coins allow. Everything goes through the game's own interfaces and scripts:
  smithing, cooking, crafting, fletching, runecrafting, herblore, tanning and the bank. Nothing gives XP or items the
  game would not give a player.
- **Getting about.** They walk, using a walking graph of the overworld, and cross the toll gate, the boats and the
  stairs the game's way. A bot with the Magic level and the runes casts a real teleport spell on a long trip; members
  bots also ride the spirit trees and the gnome glider. A truly stuck bot may be moved by a rescue jump, but only where
  no player can see either end.
- **More activities.** Quest look-alikes of the free quests (the walking and talking, without changing quest state),
  low-level economy chains (cowhides, feathers, pottery, flour, shrimps), alching stints at the banks, law-rune runs to
  the Wizards' Guild, bone runs, Wilderness trips for bold bots, and on members worlds the far towns and the minigames
  (the Fishing Trawler, the Brimhaven Agility Arena, the Ranging Guild, Treasure Trails), scaled with N.
- **Trade.** Vendors and bank-standers sell at the 2004 trade banks, about half of them at Varrock West, with adverts
  in the period's forms ("selling lobs 150 ea", "wts rune scim 33k"); about half run an auto typer. Prices follow
  December 2004 street prices for about 45 items and the item's value for the rest, never below high alch and never
  bought back for more than the value, so there is no profit loop. Rares sell one at a time at 2004 prices, only from
  rich, high-level vendors. A request in chat ("buying lobsters", "wtb coal") gets a vendor's private message with its
  price and bank. Trades follow the real trade screens.
- **PvP.** PKers attack only where the game's own PvP rules allow (inside the Wilderness, within the combat-level
  range). Deep-Wilderness PKers hunt human players; Edgeville PKers fight anyone at the edge, other bots included. They
  eat, drink potions, use prayers (Edgeville PKers no protection prayers, by 2004 honour), switch to a special-attack
  weapon for the KO, PJ fights, and run or teleport out when losing. Bots keep their items when they die, and a player
  who kills one in the Wilderness gets 1 to 50,000 coins.
- **Social life.** Social bots are regulars of one hub each. Levelling bots hang out at Falador park, Varrock square or a
  bank now and then. Friend cliques log in, train, travel and leave together, and walk the map in matching capes. About
  once an hour of play a notable event happens where the bots are: a drop party (with cheap real items you can pick
  up), a Party Room party, a clan walk, a PK team raid, a big stake at the Duel Arena, a scam spree; bots nearby talk
  about it. Newbies ask to follow players, scam callers work the trade banks, lurers try to lead you into the
  Wilderness, and one bot per world (two from 500) is a player moderator with a silver crown who tells off spammers.
- **The Duel Arena** (members worlds): bots visit to stake and duel each other through the real duel screens, watch
  and throw rotten tomatoes, and now and then challenge you to a small stake.
- **Being human.** Reaction times, typing time, short breaks ("brb"), lingering, stopping to watch a fight, misclicks,
  forgotten food, wrong turns, kill-stealing and rock-stealing by the rude ones, random events answered through the
  game's own scripts, and leaving the game the way a player does (banking first, saying goodbye).
- **Looks.** Bodies and colours from the name (a woman's name gets a woman's body), patchwork gear in the metals their
  levels allow, outfits for their style (rangers in leather and d'hide, mages in robes), tools in hand, status gear and
  rares on a few rich bots, members fashion on members worlds.

### Talking to them

- A bot answers when its whole name, its name without spaces, or a first name no other bot nearby has is in your line,
  and for half a minute after that it answers what it understands without the name. Questions said to nobody get one
  bot's answer from the crowd. Private messages are answered; friend bots sometimes message first.
- Every line a bot says goes through the game's word filter like a player's, is typed at a person's speed, and is
  hidden by your ignore list.
- Unprompted, bots talk at their persona's rate in bursts with long quiet spells: lines that fit what they are doing
  and where, level-up lines, talk with each other in short topic threads, gz to level-ups, reactions to what you do.
  Upstream's own chat lines are kept word for word (memes and modern lines only from about 1 persona in 8), with about
  several thousand lines written for the port in a late-2004 voice.
- With a chat model (Settings › Bot chat), the words of a bot's replies to you come from the model (§4.9).
- A bot never says it is a bot.

### Design rules

These hold throughout the library; a change that breaks one needs a good reason.

- **Bots off is the vanilla game.** Off loads `engine.js`, which has no bot code at all (the build checks it).
- **No engine source patches.** The upstream engine is a read-only input; every hook is installed at run time (§2).
- **A bot is a player.** It acts only through what a client could send: clicks on NPCs, locs, items and interface
  buttons, the trade, duel, shop and bank screens, dialogue pages. The game's own scripts decide what happens.
- **No XP or items from nothing.** No upstream bonus XP, no simulated crafting, no item made by the bot itself; the
  economy has no loop that makes coins.
- **Walk, don't teleport.** Bots walk, use the real gates and boats, or cast real spells. The rescue jump is a last
  resort, unseen.
- **The game's rules decide PvP.** Every attack is the engine's own attack, so a bot can only do what a player could.
- **Deterministic per name.** A bot's age, persona, looks, tastes, PK build, cliques and favourite skills are seeded
  from its name (`port/BotSeed`), never from `Math.random`, so a bot is the same at every login without saving any of
  it, and a seeded simulation repeats exactly.
- **Worker-safe.** The library runs in a Web Worker on the phone: no `fs`, `process`, timers, database or network
  (checked by `test/worker-safety.test.mjs`). Delays are counted in ticks.
- **Saved bots keep what they have.** New rules for looks or kits apply to new bots and to what any bot buys from then
  on; a saved bot's body and kit are never re-styled.
- **Upstream's flavour stays.** Upstream's chat lines are kept as written; only lines the filter would star without
  swearing, or that the 274 chat codec cannot carry, were minimally reworded.

## 2. How it fits

```
host.js  init {node:{…}, bots:{count:N}} ─► boot.js ── N = 0 ──► engine.js        (the bundle without bots)
                                                   └─ N > 0 ──► engine-bots.js   (the same engine + the bot library + the glue,
                                                                                   + vfs-manifest-bots.json: scripts.bin)
```

- **Two engine bundles.** `engine/engine.js` is the vanilla build, byte for byte what a build without the bots
  produces. `engine/engine-bots.js` is built from `web/engine/src/entry-bots.ts`: the same engine entry plus the bot
  library (`web/engine/bots/src`, imported as `#/engine/bot/*`) and the runtime glue (`web/engine/src/runtime/bots/`).
  boot.js picks one by `init.config.bots.count`. A build whose overlay could not be compiled has no bots bundle; asked
  for bots, it starts without them and says so.
- **Run-time hooks.** Every hook the mod made in World.ts, Player.ts, GameMap.ts and the packet handlers is installed by
  the glue when the bots are on: own-property wrappers on the `World` singleton, wrappers on handler prototypes and
  `ScriptRunner.HANDLERS` entries (§4.3). The engine's script opcodes are never edited or renumbered.
- **A content-script overlay.** Progressive changes three scripts: `trade.rs2` (a trade request to a bot reaches the
  bot), `death.rs2` (bots keep their items; a human killer gets coins) and `engine.rs2` (declares the two commands). Only
  those hunks are kept, as patches in `web/engine/bots/content/` against the Content commit in its `BASE`, compiled at
  build time with the engine's own script compiler, with the two commands at **explicit opcodes `P_ISBOT = 10100` and
  `P_BOT_INTERACT_TRADE = 10101`** (`port/BotScriptCommands.ts`). Only the scripts that differ from the vanilla
  `script.dat` ship (`engine/vfs/bots/scripts.bin`, 24 scripts, about 15 KB); they replace their vanilla entries after
  every `ScriptProvider.load` (also `::reload`), each after a name and CRC check.
- **Saves** go to one store per profile (§4.5); the Characters list (`players/<profile>/*.sav`) never sees a bot.

## 3. Where things are

| Path | What |
|---|---|
| `web/engine/bots/src/` | The bot library: upstream's files under their own names, ported to 274, and the port's modules in `src/port/` |
| `web/engine/bots/src/tasks/` | The tasks a bot runs (one per activity: woodcutting, combat, vendor, PK, party guest, …) |
| `web/engine/bots/data/` | Upstream's `chat_responses.json` and `bot_phrases.json`, and the port's data: `names.json`, the walking graph, line tags, the 2004 lines, prices, threads, set pieces' data. Bundled as JSON imports |
| `web/engine/bots/content/` | The three script patches, `BASE`, and the overlay compiler (`compile.mjs`, `compile.mts`) |
| `web/engine/bots/test/` | The library's tests, the world simulator and the humanlike report; `model-data/` holds the chat model's training tools |
| `web/engine/bots/README.md`, `UPSTREAM` | The library's guide (every change from upstream with its reason) and its provenance |
| `web/engine/src/entry-bots.ts`, `web/engine/src/runtime/bots/` | The glue: hooks, script commands, overlay, bot store, save routing, names, friends, the chat model's channel |
| `web/engine/build.mjs`, `scripts/build-web.mjs` | Both bundles and the overlay step (`--no-bots`, `--rebuild-bot-scripts`, `--require-bots`, `--bots-lib`) |
| `web/engine/test/bots.test.mjs`, `test/lib/bots-session.mjs`, `test/fixtures/stub-bots/` | The glue's tests, against the real library and a scripted stub |
| `web/host/` | The Settings rows (World › Bots, Bot chat), the init config, the notice when the bots cannot run, the chat model's relay |
| `models/bots-2004.json` | The published chat model's pin |

### The bot library

The structure is upstream's; the port added modules beside it rather than rewriting it.

- **`BotManager`** owns the bots: the pool and the sessions (who logs in, who leaves, newcomers, quits), staggered
  spawning, the keep-alive, the per-tick AI and the director's set pieces. The glue calls `start` and `tick` (§4.2).
- **`BotPlayer`** wraps one engine `Player` with its AI: it runs the current task, asks the planner for a new one when
  the plan is over (or a levelling bot has gained no XP for 15 minutes), and hosts sub-tasks (a "come here", a random
  event, a party, a rest, a ride).
- **The planners** (`BotGoalPlanner`, by planner group: skiller, fighter, balanced, random, and the extras' fixed
  tasks) pick the next task from the bot's skill weights, levels, needs (`BotNeeds`: tools, coins, food) and the spots
  in `BotKnowledge`, the table of every skill's steps by level with their spots, shops and banks. The port's planner
  hooks (`port/BotSetPieces.registerPlannerHook`) offer the newer activities: hang-outs, the Duel Arena, outings and
  minigames, show-off visits, errands.
- **The tasks** (`src/tasks/`) are state machines over `BotAction`, the primitives that drive a player through the real
  engine APIs: walking (`walkTo`, over the walking graph and the gateways), interactions, interface buttons, the bank.
  `BotTaskBase` holds what the tasks share (bank walks, food, the watchdog and stuck detector, human delays).
- **The port's modules** (`src/port/`), by area:

| Area | Modules |
|---|---|
| Running in the engine | `BotPathing` (route searches with a per-tick budget), `BotWalkGraph`, `BotInventoryCompat` (254's all-or-nothing adds), `BotContent` (274's names), `BotWorldRules` (free worlds), `BotSchedule` (delays in ticks), `BotLog`, `BotScriptCommands`, `PlayerBotFields`, `BotSeed` |
| The living world | `BotRoster` (names, planners, the pool), `BotSessions`, `BotNewbie`, `BotAge` (a new world's ages), `BotCliques`, `BotLinger` |
| Who they are | `BotPersona` (talkativeness, typing, reactions, friendliness, carefulness, age, home), `BotLooks`, `BotOutfits`, `BotFashion`, `BotFavourites`, `BotGear` (what they buy and wear) |
| Behaving like a person | `BotTiming`, `BotHabits` (breaks, lingering, a look, leaving), `BotFumble` (misclicks, forgotten food), `BotRude`, `BotDanger`, `BotDefence`, `BotTiles` (a tile of its own), `BotHangout`, `BotRandomEvents` with `RandomEventTask` |
| Activities | `BotTeleport`, `BotTravel`, `BotExits`, `BotUpstairs`, `BotDungeons`, `BotSpots`, `BotPowerDrop`, `BotChains`, `BotErrands`, `BotMagicRuns`, `BotHerbRuns`, `BotWildTrips`, `BotAlch`, `BotOutings`, `BotMinigames`, `BotClues`, `BotD2Picks` |
| Trade | `BotTrade`, `BotTradeScreen` (trades through the screens), `BotTradeSpots`, `BotPrices`, `BotShowOff` |
| PvP | `BotPkGear`, `BotPkTactics`, `BotPkFight`, `BotPkPj`, `BotPkTeam` |
| Set pieces | `BotSetPieces` (the interface), `BotSetPieceIndex`, `BotDirector` (about one event an hour), `BotClanWalk`, `BotTrains`, `BotParty`, `BotScams`, `BotDuel`, `BotArena`, `BotModBot`, `BotScreens`, `BotPieceLines` |
| Chat | `BotChat` (addressing, replies, the marketplace, "come here"), `BotAnswers`, `BotChatter` (unprompted lines), `BotLines` (what fits where; the repetition registry), `BotStyle`, `BotSlots`, `BotThreads`, `BotStage`, `BotWitness`, `BotReactions`, `BotVoice` (one voice's share of a place), `BotSay` (everything said goes through the word filter), `BotSpoke`, `BotEmote`, `BotActivity`, `BotPlaces`, `BotFollow`, `ComeHereTask` |
| The chat model | `BotModel` (which replies a model words, the pending reply and its fallbacks), `BotModelPrompt`, `BotModelGuard`, `BotModelHistory`, `BotModelTypes` |

## 4. Contracts

### 4.1 Page ↔ engine (additions to [ARCHITECTURE.md](ARCHITECTURE.md) §4)

- `{type:'init', config}`: `config.bots = {count: N}` (an integer; 0 or absent = off; boot.js clamps it to 0..1000 and
  writes the clamped value back). It is deep-merged into `world.json` like the rest; `WorldConfig` drops keys it does
  not know, so the glue reads the merged `world.json`. Optional, for tests and debugging: `bots.debug` (verbose bot
  logging), `bots.spawnPerTick` (default 5), `bots.pathSearchesPerTick` (default 12 per 100 online) and `bots.timing`
  (the session durations, in ticks).
- `{type:'booted', …}` gains `bundle: 'engine.js' | 'engine-bots.js'` and `bots: N` (0 when the bots bundle is missing
  or failed to load: boot.js then imports `engine.js` and logs why).
- `{type:'lifecycle-done', …}`: `ok` is about the human saves only. With bots running it also carries
  `bots: {ok, error?}` for the bot store (a failed `bots.sav` write is kept in memory and retried; Settings › Restart
  treats it like a failed save).
- `{type:'bots', active: false, reason, detail}` (engine → page), at most once, when the bots were asked for but do not
  run this session: `no-bundle`, `load-failed` (from boot.js, right after `booted`), `store-unreadable`,
  `store-corrupt`, `mismatch` (the overlay does not fit the packed scripts) or `failed` (from the glue). The page shows
  it once in plain words. Nothing is sent with the bots off.
- `{type:'lifecycle', event:'resume'|'foreground'}`: with bots running, a bot store that could not be written is written
  first.
- `{type:'delete', reqId, name}` (Settings › Saved data deleting a character): the character's friend and ignore lists
  leave the store, which is written at once (§4.8).
- The chat model's messages (only `engine-bots.js` hears them, `runtime/bots/page.ts`; shapes in
  `port/BotModelTypes.ts`; the page ↔ native half is [ARCHITECTURE.md](ARCHITECTURE.md) §7.1):
  - `{type:'bots-lm', id, mode, local, online, maxChars, timeoutMs}` (engine → page): a reply for a model to write, with
    both prompts (`local` {system, user} for the on-device model, `online` {system, context, user} for Claude). Ids
    count from 1 per page load; native gives up after `timeoutMs` (9,000).
  - `{type:'bots-lm-reply', id, text, source, error?, ms}` (page → engine): the model's line as it came (the engine
    guards and styles it), or null and why: `timeout`, `busy`, `unavailable`, `refused`, `failed: …`. The page answers
    null `unavailable` at once with no native side or with Rules chosen.
  - `{type:'bots-lm-mode', mode, local, online}` (page → engine), after `booted` and before `start`, and on every change:
    the player's choice and what is there. Until it comes, and with `rules`, the engine asks nothing.

### 4.2 Bot library API (`#/engine/bot/*`, called by the glue)

```ts
// BotManager.ts
export interface BotStartOptions {
    count: number;                           // N: about this many online, out of a pool of about 2N
    members: boolean;                        // a free world keeps the bots in F2P
    debug: boolean;                          // verbose logging; errors are always logged, rate-limited
    humanInWorld(): boolean;                 // spawning waits for a human; play time only passes while one is in the world
    isReservedName(name: string): boolean;   // a human character has this name: no bot uses it
    loadSave(name: string): BotLoadResult;   // { status: 'ok', data } | { status: 'missing' } | { status: 'error', error }
    spawnPerTick?: number;                   // default 5
    pathSearchesPerTick?: number;            // default 12 per 100 online, at least 12
    ageNewBots?: boolean;                    // pool bots without a save get an age (every store sets it)
    savedNames?(): Iterable<string>;         // the bots with a record in the store: the pool starts with them
    isQuit?(name): boolean;                  // a bot that quit for good: its name is never used again
    onQuit?(name): void;                     // a bot quits: the store drops its record and keeps the name
    isFriendOfHuman?(name): boolean;         // such a bot never quits
    timing?: Partial<SessionTiming>;         // tests: shorter sessions (port/BotSessions.ts)
}
export const BotManager: {
    start(world, opts): void;    // after World.start, before the first tick; spawns nothing yet
    tick(): void;                // every tick after World.processPlayers: keep-alive, sessions, spawning, the AI;
                                 // each bot's errors are isolated (never throws)
    clearAfkEvents(): void;      // after World.processClientsIn: the engine's own random-event roll is cleared for bots
    isBotPlayer(p): boolean;
    newCharacter(): void;        // a human logged in with no save: newcomers follow it out of Tutorial Island
    ownsName(name): boolean;     // in the world this session and not released: its saves go to the bot store
    isActiveBot(name): boolean;  // in the world and playing (not on its way out)
    retire(name): boolean;       // a human wants this name: the bot logs out through the normal path
    release(name): void;         // the retired bot's final save is stored: the name is free
    activeBots(): Iterable<Player>;
    botFor(p): BotPlayer | null; // the AI driving an active bot
    exportWorld(): unknown;      // the living world's state, saved in the store's _meta.world
    stats(): BotStats;           // counts and timings for the tests and the measurements
};
// port/BotChat.ts
export const BotChat: {
    onPublicMessage(player, text): void;                  // a human's public line (WordEnc-filtered)
    onPrivateMessage(player, targetName, text): boolean;  // every human PM; true = consumed ("come here")
};
// port/BotTrade.ts
export const BotTrade: { onTradeRequest(human, bot): void };  // a trading bot that is free takes it; others decline
```

Names passed in are the engine's normalised usernames (lower case, `_` for a space); the name functions normalise what
they get. The fields the mod added to `Player` are declared in `port/PlayerBotFields.ts` and set on bots only. The
library does no I/O: a save comes in through `loadSave` and leaves through the engine's own logout and autosave path,
which the glue routes to the bot store.

Script commands (`runtime/bots/scripts.ts`): `p_isbot` pushes 1 if the active player (with int operand 1: the secondary
one) is a bot; `p_bot_interact_trade(player_uid, stage)`: stage 0 = a human asks this bot to trade
(`BotTrade.onTradeRequest`), stage −1 = the trade closed (the bot's trade target is cleared).

### 4.3 Glue hooks

Installed only when the bots are on; every target is checked first, and every hook body is guarded so that an
exception from bot code never reaches the engine's own error handling.

| Upstream patch | Here |
|---|---|
| `World.start`: `BotManager.init(this)` | wrapper on `World.start`: then the bot store is read, one `GET /save-index`, `BotManager.start` |
| `World.cycle`: `BotManager.tick()` after `processPlayers()` | own-property wrapper on `World.processPlayers` (the bots' share of each tick is measured) |
| `World.processLogouts` rewritten (keep-alive) | keep-alive inside `BotManager.tick` |
| `BotPlayer` clears `afkEventReady` | wrapper on `World.processClientsIn` → `BotManager.clearAfkEvents()` |
| `MessagePublicHandler` → nearby bots, marketplace | post-wrapper on the handler prototype |
| `MessagePrivateHandler` "come here" | wrapper on `World.sendPrivateMessage` → `BotChat.onPrivateMessage` |
| `World.addFriend`: a bot shows online | wrapper on `World.friendThread.postMessage`: the friend lists (§4.8) |
| `OpPlayerHandler` op 4 on a bot | the overlay's `[opplayer4,_]` → `p_bot_interact_trade` → `BotTrade.onTradeRequest` |
| `GameMap.botFindPath`/`botWalkPath` | `port/BotPathing.ts` over the engine's route finder |
| `ScriptOpcode` `P_ISBOT`/`P_BOT_INTERACT_TRADE` | `ScriptRunner.HANDLERS[10100/10101]` (asserted free) |
| (new) saves | `saves.write`/`saves.retryPending`: bot saves to the bot store (§4.5) |
| (new) names | `World.onLoginMessage`: a human taking a bot's name (§4.6); a login with no save → `BotManager.newCharacter()` |
| (new) self-check | `World.cycle`: after the first ticks, the hooks ran and the keep-alive holds |

The bots are switched off for the session when a hook target is missing, the overlay does not match the packed scripts,
the store is unreadable or corrupt, `BotManager.start` fails, `BotManager.tick` fails 10 ticks in a row, or the
self-check fails: one logged error and the page notice (§4.1); the bots leave through the normal logout path, their
saves still go to the store, and every hook passes through. Repeated engine error lines from a bot are rate-limited.

### 4.4 Spawning and sessions

- Nothing spawns before a human is in the world, never on tick 0 (an appearance built on tick 0 is never sent to a later
  observer), and at most `spawnPerTick` a tick, except a short burst for the bots near the human.
- **The pool** (`port/BotRoster`): every bot with a record in the store, then the first unused names in `names.json` up
  to 2N. A group short of its share gets fresh names of its own; newcomers shed what that added.
- **Filling** a world at login: the human's friends first, then by distance from the human (each bot's last place, kept
  in the store's living-world state); the friends and the bots within 40 tiles (at most 25) in the first 3 ticks, the
  rest at `spawnPerTick`. The planner group most short of its online share goes first.
- **Sessions** end with a logout once nothing holds the bot (a fight's logout lock, a trade, a "come here", a set
  piece), at most 10 minutes later. Before leaving it wraps up as a player would (banks a gatherer's load, finishes its
  click, sometimes says goodbye), then presses the logout button. Its claims on trees, rocks, NPCs and partners are
  released.
- **The empty world**: after 100 ticks with no human every bot logs out, keeping the rest of its session.
- **Continue after a restart**: every write of the store carries the living world (`BotManager.exportWorld()` →
  `_meta.world`: who is online with the rest of their sessions, the absences, the newcomer clock, each bot's last
  place, the newbies, the director's schedule), and `BotManager.start` reads it back.
- **A new bot without a save**: Tutorial Island done, a walkable tile by the Lumbridge spawn (an aged bot: by a bank of
  its tier), every quest complete as upstream had it plus the ones 274 added, a body from its name. Appearance is
  rebuilt only when worn items or the combat level change (upstream rebuilt it every tick, which overflowed the player
  update packet). 100 bots in view stay under the engine's PLAYER_INFO budget; past that the engine adds players as the
  budget allows.

### 4.5 Bot store (`runtime/bots/store.ts`)

- One file per profile: **`Documents/bots/<profile>/bots.sav`** (native keeps `bots.sav.bak`), through the player
  saves' routes (`GET/PUT ../save/bots/<profile>/bots.sav`). Big endian:

  ```
  "LCBOTS01"                     8 bytes magic
  u16 count
  count × { u8 nameLength, name (ASCII, the normalised username), u32 saveLength, save (a standard player .sav) }
  ```

  One record is not a bot: **`_meta`** (no username starts with `_`) holds the store's own state as JSON:
  `{"v": 1, "ageing": true, "quit": [names], "friends": {"<human>": {"friends": [...], "ignores": [...]}},
  "world": {…}}`. One that cannot be read is kept as `_meta_bad` and a new one started.
- Read once when the bots start: 404 → no records; a read that fails (retried once) → **bots off for the session**, and
  nothing is ever written; corrupt → `bots.sav.bak`; both corrupt → bots off. A record that fails the engine's save
  check keeps that bot out for the session (its record is written back unchanged).
- Every save the engine makes for a name the bots own (logout, the 15-minute autosave, `lifecycle pause|save`, exit)
  updates that bot's record instead of a `players/` PUT. The file is written whole, after the human saves:
  - **at every save occasion, at once**: `lifecycle pause|background|terminate|save` (the app leaving the foreground,
    Settings › Save now, the page's 2-minute autosave, Saved data's Reset world and Delete everything), the engine's
    autosave, a human's logout, the exit, and a bot leaving for a human who takes its name;
  - **for the bots' own logouts, at most once every 30 s of world time** (`STORE_WRITE_TICKS` = 50 ticks): the first
    logout after a write writes at once, later ones update their records in memory until the next write is due.
  A failed write is logged, kept and retried (15 s, the next occasion, a resume) and reported in
  `lifecycle-done.bots`, never in `lifecycle-done.ok`.

### 4.6 Names

- `data/names.json` holds 4,800 believable 2004-style names: valid 274 usernames, not an NPC's name, unchanged by the
  game's word filter (also inside a typical line), no famous players. **It is append-only**: a bot's identity is its
  name, and a name is never used for a second bot. `names[i]` has the planner `PLANNERS[i % 8]`, so every prefix of
  the list has the role mix. `test/names.test.mjs` fails when a locked name is changed, removed or moved.
- A name is reserved, and skipped by the pool, when a human save has it (read once from `/save-index`), or a human used
  it this session or is online with it. A bot never takes your character's name.
- A human logging in with the name of a bot in the world: the login is held, the bot retires, its final save reaches the
  store, the name is released and the login answered (a fresh character). If the bot cannot leave within about 10 s
  (17 ticks), the login is refused like an account that is already online. A human taking the name of a bot that is
  away gets it at once, and the bot leaves the pool.

### 4.7 Settings (host)

`bots` (number, default 500): Settings › World › **Bots** `Off | 25 | 50 | 100 | 250 | 500 | 750 | 1000`, applied by
the World category's Restart, sent as `init.config.bots.count`. A stored value the sheet does not offer snaps to the
nearest one (a count that was on never snaps to Off). Bot chat: `botChat` (`rules`, `local`, `online`; default `local`
when the app has a model) and `botThink` (Think first, default on), applied at once ([ARCHITECTURE.md](ARCHITECTURE.md)
§7.1).

### 4.8 Friends (`runtime/bots/friends.ts`)

Offline, the engine's friend server is a sink: without the bots a friend list lasts one login. With the bots,
`friends.ts` stands in for the friend server of the one world there is, by wrapping `World.friendThread.postMessage`:

- a human's login gets its saved friend list (a bot in the world shows as online, as world 10) and ignore list;
- a bot's login or logout updates every human who has it as a friend ("Kevin1991 has logged in.");
- the human's adds and removes change its lists (at most 200 friends, 100 ignores).

The lists are kept per human character in the store's `_meta`, written with the bots. Deleting a character in Settings
› Saved data drops its lists (the store written at once), and when the bots start, the lists of characters with no save
are dropped too. Reset world deletes the store: a new bot world, the characters kept with empty friend lists.

### 4.9 Chat and the chat model

Three sources write what a bot says to you, chosen in Settings › Bot chat. In every case the rules decide **whether**
a bot replies, **when** (after reading and typing at its persona's speed) and **what it does**; a model only words the
reply, and the rules' own line is the fallback.

- **Rules**: `composeReply` (in `port/BotChat`) builds every reply from the matched intent, the bot's state (its task
  and place, `port/BotActivity` and `port/BotPlaces`; its levels, prices, directions from where the asker stands, quests
  for the asker's level, …) and its persona. Upstream's replies are used where they fit.
- **On-device**: the fine-tuned Qwen3.5-0.8B (Q4_K_M GGUF, about 530 MB) run by llama.cpp in the app (Metal on iOS,
  the CPU on Android). How it was made: [web/engine/bots/test/model-data/README.md](../web/engine/bots/test/model-data/README.md).
- **Claude online**: Claude Haiku through the Messages API with the player's own key. Each request carries a static
  2004 guide (cached) and the bot's facts and the chat near it.

**Scope** (`port/BotModel.wantsModel`): a model words replies to the human by name, in the reply window, in an ongoing
conversation, said to nobody (the crowd's answer) or by private message. Always rules (`RULES_ONLY_INTENTS`): the
marketplace and trades, PK and fights, follow and team-up, the rude lines, emotes, every line of the player-mod bot,
"come here" and the conversation's openers and endings.

**The pending reply** (`askModel`): the request carries the bot's situation (`port/BotModelPrompt.situationOf`: its
levels, Hitpoints, place, activity, gear and pack, recent events, the lines heard near it and the PM thread, the
human's line and the rules' own answer as a hint) and its two prompts. The bot stays at its keyboard until a deadline
20 ticks after the decision plus its typing time. No usable answer by then: the rules' line. At most 3 requests are in
flight; a newer reply of the same bot supersedes a waiting one.

**The guard** (`port/BotModelGuard.guardReply`) refuses a model's line unless it is one line of the chat's characters
within 80, passes the word filter, has no assistant talk, nothing after 2004 (slang included), never owns up to being a
bot, makes no promise the rules did not make, states only facts true to the bot (levels, places, prices), echoes
neither the human nor the bot's own recent lines, uses the human's name at the persona's rate, names no player it
cannot know, says no "brb"/"afk"/"gtg", and has no markup. Every reason has a unit check in `test/model.test.mjs`.
The accepted line then gets the persona's style (`port/BotStyle`).

With no model chosen nothing in this path draws a random number, so a simulation without a model is the same world as
before the model existed.

## 5. Changes from upstream (2004sp-progressive)

The vendored files are upstream's `engine/src/engine/bot/**` and its bot data at the commit in
`web/engine/bots/UPSTREAM` (aeadbc43, its default branch in late September 2026), under their own names. The mod also
changed the engine (World.ts, Player.ts's chat AI, GameMap.ts, packet handlers, script opcodes and three content
scripts); those changes are re-implemented here as run-time hooks, `src/port/` modules and the small script overlay,
because the engine stays unpatched. The mod's other features (its custom content, Grand Exchange, clans, hiscores and
quality-of-life changes) are not part of this port.

What changed, in short (every change, with its reason, is in the library's README and marked `port:` in the source):

- **Revision 274**: the engine's API and names (`Inventory.add` inserts partially in 274, so an `invAddAll` helper
  restores 254's all-or-nothing adds), 274's content names and item ids, its quests, its PvP and trade scripts.
- **Worker-safe**: no `fs`, `path`, `process`, timers, database or debug server in anything the bundle reaches (the
  build and `test/worker-safety.test.mjs` refuse them); replies and cooldowns are scheduled in ticks; bot logging only
  with `debug`, errors rate-limited.
- **Route searches**: 25 waypoints (`-1` means one in 274), at most 12 searches a tick per 100 bots online (12 up to
  100, 60 at 500, 120 at 1000), a bot cut short resuming where it stopped; no targets beyond 60 tiles (274 searches a
  128×128 window); collision from the engine instead of revision 254's 20 MB `unwalkable_tiles.csv`; long walks over
  a walking graph of the overworld made from the 274 map (`data/walk_graph.json`).
- **Bugs fixed**: bots now eat and flee by their real Hitpoints, never get stuck in the crafting, smithing or ranged
  loops, train where their levels belong, are never left on Tutorial Island, never sell their gear for 1 coin, and
  trade correctly with a player who takes more than 3 seconds; PKers follow the real Wilderness rules.
- **A living world**: sessions, a pool, newcomers, quitting, mixed ages and persistence, where upstream's bots were all
  online from start to shutdown and redrawn at every launch.
- **Earned gear**: no starting bank of every armour set and 999,999,999 sharks.
- **2004 realism**: human timing and habits, chat that fits the moment, a 2004 economy and adverts, looks, social life,
  set pieces, random events, fallibility and rudeness, the Duel Arena, the player-mod bot, the chat model.

Kept as upstream, on purpose: bots keep their items when they die and their killer gets coins; Edgeville PKers fight
other bots at the edge; upstream's chat lines, with their names, jokes and swearing (the filter stars the swearing as
it does a player's).

## 6. Performance

The bots run inside the engine's 600 ms tick. Their cost grows with N but stays a small part of the tick.

**iPhone 13 mini** (iOS 27, the release build in the app, `web/test/app-test.mjs --device --bots N`): 50 fps at 25,
50, 100, 250 and 500 bots, with up to 76 bots drawn at once at Varrock West at 500; the world's ticks on time (at 500,
late by 19-38 ms at the p95 of the 600 ms period); a save with every bot in 11-26 ms. With 500 bots and the on-device
model writing a reply every 5 s, the frame rate and the tick held; a reply takes about 1.1-1.3 s, and replies that
often for 15 minutes or more make the phone thermally "serious" (normal chat is far less frequent, and the model rests
while the phone is hot).

**Mac** (Apple M2, the release `engine-bots.js` in the JavaScriptCore shell with the JIT,
`node web/engine/test/measure.mjs --bots --real --runtimes=jsc --counts=500,750,1000 --ticks=300`):

| Bots | Whole tick (avg / p95 / max) | Bots' share (avg / p95) | Spawn ramp (ticks, worst tick) | Route searches a tick (avg / max / budget) | Heap start → after | Save | `bots.sav` |
|---|---|---|---|---|---|---|---|
| 500 | 24.0 / 33.3 / 52.3 ms | 14.0 / 22.5 ms | 108, 53.5 ms | 22.5 / 46 / 60 | 159.7 → 210.8 MB | 15 ms | 573 KB |
| 750 | 29.9 / 38.5 / 52.7 ms | 18.4 / 27.2 ms | 158, 70.4 ms | 33.0 / 67 / 90 | 160.1 → 227.1 MB | 23 ms | 859 KB |
| 1000 | 37.1 / 46.9 / 55.5 ms | 24.4 / 33.4 ms | 208, 72.6 ms | 46.6 / 96 / 120 | 159.9 → 242.5 MB | 28 ms | 1,154 KB |

750 and 1000 have been measured on the Mac and in the iPhone simulator only (1000 in the simulator: 50 fps at Varrock
West, ticks late 38-70 ms at the p95), not on a phone; their memory (about 90 MB more heap than no bots) and heat over
a long session on a phone are unknown. A fresh world of 1000 takes about 200 ticks (2 minutes) to fill.

What keeps it cheap: route searches are budgeted (12 a tick per 100 online, a bot resuming where it stopped; bots more
than 64 tiles from every human get at most a third of the budget), appearances are rebuilt only on change, each bot's
rescan timer starts at its own point, and the bots' own logouts write the store at most every 30 s (at 1000 bots that
is at most about 140 MB of writes an hour, plus the save occasions).

## 7. Tests

```sh
node web/engine/bots/test/all.mjs            # the library: type-check, worker safety, names, inventory vs 254, pathing,
                                             # the walking graph, content names, determinism, chat, lines, trade, the
                                             # economy, PK, habits, social life, looks, set pieces, the living world, …
node web/engine/bots/test/all.mjs --full     # + task coverage on both world types, long simulations, the living world
                                             # at 25 to 1000 online, a crowd of 250, the humanlike report
node web/engine/test/all.mjs                 # the engine worker, incl. bots.test.mjs: the glue against the real library and the stub
node web/test/e2e.mjs --bots 25              # the page with 25 bots (--bots 0: explicitly off)
node web/test/app-test.mjs --bots 25         # in the app (simulator; --device for the iPhone): the setting, fps, ticks, saves
node web/engine/test/measure.mjs --bots --real   # the performance tables
```

The tests read the upstream sources (see [BUILDING.md](BUILDING.md)) and never write to them: each test that needs
the engine works in a scratch copy under `build/tmp/bots/`, with the library linked in. Every test file's header says
what it checks; `web/engine/bots/README.md` has the full table. `LC_BOTS_SRC=<dir>/src` runs any test against another
copy of the library (with its `data` beside it).

**The world simulator**, `test/sim.mjs`, runs the real 274 world headless with the runtime's hooks and a human player,
and prints a health report: each task kind's XP per 1,000 bot-ticks, rescue jumps by task and reason, "I can't reach
that!" clicks, chat lines and repeats, bots stuck in one place, deaths at a skill, tick times, route searches, the
largest PLAYER_INFO packet and a fingerprint (the same arguments give the same numbers).

```sh
node --expose-gc web/engine/bots/test/sim.mjs --bots=25 --ticks=3000 [--members=false] [--seed=N] [--xprate=N]
node --expose-gc web/engine/bots/test/sim.mjs --scenario=coverage --ticks=2500 [--only=agility]   # every task kind progresses
node --expose-gc web/engine/bots/test/sim.mjs --scenario=aged --bots=50 --ticks=3000               # a new world with ages
node --expose-gc web/engine/bots/test/sim.mjs --scenario=crowd --bots=100 --ticks=120              # everyone around the player
```

**The humanlike report**, `test/humanlike.mjs`, measures how human the bots look and sound to a player: the real
world as the app runs it (an aged store, real sessions), one human touring 15 hubs of 2004 (or standing at one,
probing bots by name and by PM, or talking to nobody), recorded at 34 vantage points with the client's 15-tile view.
It prints about 180 metrics, each with its value, a target band, ✓ or ✗ and the band's basis (a measured human
reference, a design decision, a proposal, or report-only): where the crowds are, how much and what the bots say,
their answers, timing and movement (instant re-targets, metronome-regular clicks, idle stands), looks, prices and
adverts, sessions, random events, set pieces, the Duel Arena. It only warns: it exits 1 on a crash or an error, or on
any ✗ with `--strict`.

```sh
node --expose-gc web/engine/bots/test/humanlike.mjs --bots=100 --ticks=6000 [--members=false] [--seed=N] [--xprate=10]
     [--tour=still --at=falador_park | --probe=60] [--talk=100] [--newchar] [--hubs] [--json=FILE] [--lines=FILE]
```

## 8. Maintenance

- **Upstream content changed and a script patch no longer applies.** The build then warns and builds without the bots
  (`--require-bots` makes it an error). To remake a patch: copy the new content's `scripts/` into an empty folder,
  `git init` and commit it there, `git apply --3way` the old patch (or apply its few lines by hand), replace the
  patch's diff with `git diff` (keep its description), put the Content commit in `web/engine/bots/content/BASE`, then
  run `node scripts/build-web.mjs --skip-pack --rebuild-bot-scripts --require-bots` and
  `node --expose-gc --experimental-vm-modules web/engine/test/bots.test.mjs --real`.
- **Updating the bot library from upstream**: "Re-vendoring" in
  [web/engine/bots/README.md](../web/engine/bots/README.md#re-vendoring). The library must stay worker-safe.
- **Names** are append-only. Newcomers use them up, about two an hour of play; when they run out no more newcomers come,
  and appending names brings them back. After appending, `node web/engine/bots/test/names.test.mjs --update-lock`
  records them.
- **Generated data**: the walking graph (`data/walk_graph.json`, from the 274 map) and the line tags
  (`data/line_tags.json`, from upstream's idle lines) have their own builders; see the library's README.
- **The chat model** is trained on the output of `renderLocal` (`port/BotModelPrompt`): a change to that text needs a
  retrain ([model-data/README.md](../web/engine/bots/test/model-data/README.md)).

## 9. Credits

The bot AI is the work of 2004sp-progressive's authors: **attackishere, _mrsam, K-andy and callum**, building on Lost
City. Upstream has no licence file; its README says it is "available under the same license as Lost City", which is
MIT; the vendored code keeps that licence (`web/engine/bots/LICENSE`; full texts in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)). The port's new lines in a 2004 voice, and the replies the chat
model was trained on, were written with Claude (Anthropic).
