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
  game would not give a player. Fighters loot their kills; rangers and mages pick up their arrows and the drops worth
  carrying (stacks such as coins, runes and feathers, and items worth 20 gp or more), leaving bones and junk.
- **Getting about.** They walk, using a walking graph of the overworld, and cross the toll gate, the boats and the
  stairs the game's way. A bot with the Magic level and the runes casts a real teleport spell on a long trip; members
  bots also ride the spirit trees and the gnome glider. A truly stuck bot may be moved by a rescue jump, but only where
  no player can see either end. Near you (within 64 tiles) a long walk goes in minimap-sized clicks of 8-18 tiles, the
  next one clicked just before the flag, now and then a pause of a few ticks at one, a stop at the flag while the bot
  types a line, a few tiles past a corner and back, and each bot keeps a little to its own side of the road; anywhere,
  bots take one of a few sensible routes (a usual one most of the time), so not every bot walks the same tiles. Never in
  the Wilderness, a PK fight, a flee, a follow or a trade. A bot that starts a chat with another a few tiles off walks
  over first, and both stop walking while they talk (a bot at its tree or its fight keeps working); a line you say to a
  held bot is answered as ever.
- **More activities.** Quest look-alikes of the free quests (the walking and talking, without changing quest state),
  low-level economy chains (cowhides, feathers, pottery, flour, shrimps), alching stints at the banks, law-rune runs to
  the Wizards' Guild, bone runs, Wilderness trips for bold bots, and on members worlds the far towns and the minigames
  (the Fishing Trawler, the Brimhaven Agility Arena, the Ranging Guild, Treasure Trails), scaled with N.
- **The endgame** (members worlds). The few veterans with the bosser trait (combat 85+) take trips to 274's endgame
  spots now and then, about a quarter of their time: Taverley's blue dragons, hellhounds, black demons and black dragons
  (behind the dusty-key door: the key comes from Velrak in the jail, after the jailer's key opens his cell), the Heroes'
  Guild's blue dragon, the Edgeville dungeon's black demons, and in the deep Wilderness the Demonic Ruins' greater demons,
  the fire giants and the red dragons. A trip needs 12 pieces of good food (lobsters, swordfish, sharks), the Duke's
  anti-dragon shield for dragons, and prayer recharged at an altar for demons (Protect from Melee while they fight).
  Bots of combat 100+ call "kbd team?" at Edgeville bank, follow their leader north to the west Lava Maze ladder and
  the lever, and fight the King Black Dragon together. Rarely (at most once per 4 hours of play world-wide, and only
  when 4 of combat 100+ with Prayer 43+ are free online) a team of 4-6 tries the Kalphite Queen: the leader buys 2 ropes
  from Ned in Draynor and calls at Al Kharid bank till 3 answer (3 calls at most, then "nvm no1 wants kq lol"), they
  meet there ("kq team need 4", "who has rope"), each buys 2 waterskins and a pass
  from Shantay and goes through the Shantay Pass's gate the game's way, the leader's rope goes on the burrow and the
  others climb down while it holds (200 ticks), then through the tunnels to the second rope and the chamber. They pray
  Protect from Magic and fight; a bot under 40 % of its Hitpoints with 2 or fewer pieces of food left leaves by the
  chamber's rope and the burrow's, and the team runs once half of it is gone ("nvm run"). It mostly fails, as it did for
  the research's probe teams: form 1 sometimes falls ("phase 2!!"), then they run or die ("we wiped lol", "kq is
  impossible"). A real kill rolls 274's own table. A rune or dragon drop is said out loud ("rune chain!!"), bots
  near say gz, and the finder later sells its drops at a trade bank ("selling rune med 17k"). Every drop is the game's:
  a dragon med helm is about one KBD kill in 120.
- **Trade.** Vendors and bank-standers sell at the 2004 trade banks, about half of them at Varrock West, with adverts
  in the period's forms ("selling lobs 150 ea", "wts rune scim 33k"); about half run an auto typer. Prices follow
  December 2004 street prices for about 45 items and the item's value for the rest, never below high alch and never
  bought back for more than the value, so there is no profit loop; an unsold item's price drop stops at the item's
  lowest ask, above high alch and above what any vendor pays back. Rares sell one at a time at 2004 prices, only from
  rich, high-level vendors. A request in chat ("buying lobsters", "wtb coal") gets a vendor's private message with its
  price and bank. Trades follow the real trade screens.
- **PvP.** PKers attack only where the game's own PvP rules allow (inside the Wilderness, within the combat-level
  range). Deep-Wilderness PKers hunt human players; Edgeville PKers fight anyone at the edge, other bots included. They
  eat, drink potions, use prayers (Edgeville PKers no protection prayers, by 2004 honour), switch to a special-attack
  weapon for the KO, PJ fights, and run or teleport out when losing. Bots keep their items when they die, and a player
  who kills one in the Wilderness gets 1 to 50,000 coins. A bot's arrows in PvP are used up, never dropped (its kit is
  given at every restock, so they would be free rune arrows on the ground).
- **Your death pile.** Bots loot as 2004's players did, by 274's own rules: your tradeables drop 7 ticks after you die,
  seen only by your killer for a minute, then by everyone, gone after two. A bot that killed you takes the most
  valuable stacks first with the real Take (eating its own food for room, never dropping anything; hurt, it eats a bite
  and loots all the same, and only a player's attack on it ends its loot), says "ty for the rune scim" or "no loot?
  lol", and banks your items at the Edgeville booth: they never vanish at its restock (a loot ledger, kept with the
  saved world until banked; it is held from logging out meanwhile). Bots that were already near
  your death and have the habit (a seeded share of PKers and rude players; a few polite ones) wait out the minute on a
  tile of their own ("w8 for it") and rush what is left the moment their client shows it; a death to a monster's pile is
  public at once (the polite ones wait a minute, and not with you standing by it). Nobody is called over for it, and a
  bot that is not a PKer never goes into or deeper into the Wilderness for a pile. Deep PKers also patrol the Chaos
  Temple's yard and camp the KBD's Lava Maze ladder and the Demonic Ruins, where they go for 1 in 3 of the bots passing
  on an endgame trip. Bots' own deaths still drop nothing.
- **Period crowds.** Telegrabbers gather in Asgarnia's Chaos Temple for the wine of Zamorak (1 at 100 online, 4 at 500,
  5 at 1000), each on its own tile in sight of the table, racing for each wine as 274 decides ("stop stealing my wine",
  "gotta be quick"): each grab a person's moment after the wine is back, now and then a hesitation or a slip, never a
  metronome. They open the temple's door to leave (it shuts behind them). One with an air staff and no air runes wields
  the staff for its stint and its own weapon again after.
  Rangers and mages at the Edgeville dungeon's hill giants shoot from its safespots (3 verified tiles, one each), ask
  the one standing there when all are taken ("u using this spot?"), wait their turn or go elsewhere. One whose giant
  others keep killing moves to a free safespot whose giant it can shoot, and takes one again after a fight off them.
- **Social life.** Social bots are regulars of one hub each. Levelling bots hang out at Falador park, Varrock square or a
  bank now and then. Friend cliques log in, train, travel and leave together, and walk the map in matching capes. About
  once an hour of play a notable event happens where the bots are: a drop party (with cheap real items you can pick
  up), a Party Room party, a clan walk, a PK team raid, a big stake at the Duel Arena, a scam spree; bots nearby talk
  about it. Newbies ask to follow players, scam callers work the trade banks, lurers try to lead you into the
  Wilderness, and one bot per world (two from 500) is a player moderator with a silver crown who tells off spammers.
- **Word that travels** (bots only, never about you). News of a real event (a drop party, a 99 to come, a PK raid, a
  bot killed by PKers in the Wilderness, a rune drop, a full or empty mine) is something a few bots know: the bots near
  it, and their clique friends by "PM". It spreads by being said (a knower's idle line now and then: "dp at fally park",
  "pkers at greens", "iron all taken at barb mine") to the bots that hear it, changes a little as it goes ("huge dp",
  "dp at fally west bank"), and fades. Some act on it: knowers from up to 200 tiles come to a party (a few find the
  wrong place and say "wheres the dp??"), Wilderness trips skip a place with pkers, miners avoid a full mine. Ask a bot
  "where?" after it told you something and it answers. Bots that stand together for ten minutes in two sessions (at
  the same rocks, regulars at a hub, vendors side by side, PKers at the edge) get to know each other and greet each
  other next time ("hey again", "sup kev"); a meant kill-steal, a stolen rock or a PK kill leaves a grudge ("u again",
  "stay off my rocks"), a rude bot steals more from its enemy (within the usual limits), and Edgeville PKers have
  rivals. Bots pick up each other's catchphrases, so a hub's regulars come to share a few (never yours). These ties and
  phrases are saved with the world. Clique friends now log in staggered (minutes apart, and not every friend every
  time) and leave a few minutes after one another.
- **The Duel Arena** (members worlds): bots visit to stake and duel each other through the real duel screens, watch
  and throw rotten tomatoes, and now and then challenge you to a small stake.
- **The update buzz** (members worlds; the bots ideas work, round 3). The world is always 23 Nov 2004, three weeks after
  the Fremennik Trials and a week after Horror from the Deep, so Rellekka is where people go to look: about 2 bots at
  100 online and 15 at 500 are out on a visit at once. Fighters of combat 15-60 rock-hop among Rellekka's rock crabs,
  which wake and fight them when you are there to see it (274 wakes a crab only for a player's client, so unseen nothing
  is fought or gained); sightseers stand about the square, the market, the longhall and the piers, now and then buying
  a beer at the longhall; bots of Agility 35+ jump the basalt causeway to the lighthouse (slipping into the tide now and
  then, giving up after three), climb to its top and come back (never talking to Jossik). Bots talk of it: "done hftd
  yet?", "did ur fremennik trials?", "rock crabs r the best xp now" (more of it near Rellekka), and a bot that hears
  another speak of the crabs is likelier to go. What a bot says of the two quests, in its talk and in a thread, matches
  its answer when you ask whether it did them (done from combat 45, still to do below it). Castle Wars stays talk, in
  the future tense. About 3 lines in 100 of the bots' talk on a members world are of the period (the update, the crabs,
  the Games Room, Gnomeball, kittens, Castle Wars to come): its topics come up between bots, and now and then a bot's
  idle remark is one ("crabs r so good", "love the new games room") in the place of another, so there is no more talk
  than before.
- **Lives with arcs** (the bots ideas work, round 2). Each levelling bot keeps a goal from its real state, saved with the
  world: a level 5-25 up in a skill it trains ("60 wc for yews"; 99 from 95), the piece its gear upgrades would buy
  ("rune legs"), a sum ("100k"), a combat or total level. Its plans lean to it (a third of its picks; more for a 99), it
  answers "whats ur goal" with it and its progress ("3 lvls to go for 60 wc"), celebrates it in place of its level-up
  line ("finally 60 wc!!"), and now and then gives up on one it makes no headway with. Moods last a session: deaths,
  kill-steals and lost duels tilt a bot ("this game", "so annoying"; a rude one gets ruder, now and then a rage-quit:
  "im done"), level milestones, drops and wins elate it ("best day ever"; a mini drop party now and then), and a long
  stint at one thing bores it (its next plan is something else). A bot also hops off a crowded mine ("w8 hopping") and
  banks a big drop, then logs out. In about one session in seven a bot does something off its role for a while: a skiller
  fights, a fighter fishes, a PKer takes a break from pking to fish at Draynor. A bot nearing 99 says so; its friends
  come, it waits at its last log for them, the game's fireworks go off, they say gz, and a rich, friendly one throws a 99
  drop party at the nearest bank. None of it is about you, and you are never the cause or the subject.
- **The late-2004 world** (members worlds; the bots ideas work, round 3, theme G). About 5 bots in 100 are cat people:
  they buy a kitten from Gertrude west of Varrock (her door, her dialogue, 100 coins, with pet food first: their own
  fish from the bank or sardines from Port Sarim), stroke and feed it at their own pace (a careless one now and then lets
  it run away, as 274 decides) and buy another a while after losing one; it follows them everywhere, says "Meow!" and
  grows into a cat over hours of play. Bots go down to the Games Room under Burthorpe (the newest update in a world that
  is always 23 Nov 2004) and play Runelink with each other through the game's own challenge screens and board, at a
  person's pace; challenge one waiting there and it plays you within a few seconds (they never challenge you first). A
  few play Gnomeball at the Gnome Stronghold, where the tacklers chase them while you watch. Castle Wars is only talk,
  always "next month": its lobby is sealed in 274. They talk of it all now and then ("u tried the games room?", "is that
  ur kitten?") and answer questions about it ("gertrude west of varrock 100gp", "under burthorpe").
- **Being human.** Reaction times, typing time, short breaks ("brb"), lingering, stopping to watch a fight, misclicks,
  forgotten food, wrong turns, kill-stealing and rock-stealing by the rude ones, random events answered through the
  game's own scripts, and leaving the game the way a player does (banking first, saying goodbye).
- **Looks.** Bodies and colours from the name (a woman's name gets a woman's body), patchwork gear in the metals their
  levels allow, outfits for their style (rangers in leather and d'hide, mages in robes), tools in hand, status gear and
  rares on a few rich bots, members fashion on members worlds.

### Talking to them

- A bot answers when its whole name, its name without spaces, or a first name no other bot nearby has is in your line,
  and for half a minute after that it answers without the name. A line said to a bot is never left unanswered: what
  nothing understands gets the model's words, or the bot's own "sry what?", "idk tbh" or "wat" to a question and "ya",
  "k" or "oh ok" to anything else (an "ok", a "lol" or a "ty" needs no answer; talking with two bots at once, the one
  you talked with last answers). A bot on a short break answers when it is back, sometimes with "sry was afk". Questions said
  to nobody get one bot's answer from the crowd most of the time. Private messages are answered; friend bots sometimes
  message first.
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
  those hunks are kept, with two of the port's own (`pvp_ranged.rs2`: a bot's arrows in PvP are used up, not dropped;
  `poison.rs2`: death cures a poison still on its way),
  as patches in `web/engine/bots/content/` against the Content commit in its `BASE`, compiled at build time with the
  engine's own script compiler, with the two commands at **explicit opcodes `P_ISBOT = 10100` and
  `P_BOT_INTERACT_TRADE = 10101`** (`port/BotScriptCommands.ts`). Only the scripts that differ from the vanilla
  `script.dat` ship (`engine/vfs/bots/scripts.bin`, 29 scripts, about 16 KB); they replace their vanilla entries after
  every `ScriptProvider.load` (also `::reload`), each after a name and CRC check.
- **Saves** go to one store per profile (§4.5); the Characters list (`players/<profile>/*.sav`) never sees a bot.

## 3. Where things are

| Path | What |
|---|---|
| `web/engine/bots/src/` | The bot library: upstream's files under their own names, ported to 274, and the port's modules in `src/port/` |
| `web/engine/bots/src/tasks/` | The tasks a bot runs (one per activity: woodcutting, combat, vendor, PK, party guest, …) |
| `web/engine/bots/data/` | Upstream's `chat_responses.json` and `bot_phrases.json`, and the port's data: `names.json`, the walking graph, line tags, the 2004 lines, prices, threads, set pieces' data. Bundled as JSON imports |
| `web/engine/bots/content/` | The five script patches (Progressive's three for the bots, the port's two: a bot's PvP arrows, the poison fix), `BASE`, and the overlay compiler (`compile.mjs`, `compile.mts`) |
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
| Running in the engine | `BotPathing` (route searches with a per-tick budget), `BotPathFinder` (274's route search, copied with cheaper reads), `BotZoneScan` (zone searches without generators), `BotAggressors` (who targets whom), `BotPlayers` (the tick's players), `BotWalkGraph`, `BotInventoryCompat` (254's all-or-nothing adds), `BotContent` (274's names), `BotWorldRules` (free worlds), `BotSchedule` (delays in ticks), `BotLog`, `BotScriptCommands`, `PlayerBotFields`, `BotSeed` |
| The living world | `BotRoster` (names, planners, the pool), `BotSessions`, `BotNewbie`, `BotAge` (a new world's ages), `BotCliques`, `BotLinger` |
| Who they are | `BotPersona` (talkativeness, typing, reactions, friendliness, carefulness, age, home), `BotLooks`, `BotOutfits`, `BotFashion`, `BotFavourites`, `BotGear` (what they buy and wear) |
| Behaving like a person | `BotTiming`, `BotHabits` (breaks, lingering, a look, leaving), `BotFumble` (misclicks, forgotten food), `BotRude`, `BotDanger`, `BotDefence`, `BotTiles` (a tile of its own), `BotHangout`, `BotRandomEvents` with `RandomEventTask` |
| Activities | `BotTeleport`, `BotTravel`, `BotExits`, `BotUpstairs`, `BotDungeons`, `BotSpots`, `BotPowerDrop`, `BotChains`, `BotErrands`, `BotMagicRuns`, `BotHerbRuns`, `BotWildTrips`, `BotAlch`, `BotOutings`, `BotMinigames`, `BotClues`, `BotD2Picks` |
| Trade | `BotTrade`, `BotTradeScreen` (trades through the screens), `BotTradeSpots`, `BotPrices`, `BotShowOff` |
| PvP | `BotPkGear`, `BotPkTactics`, `BotPkFight`, `BotPkPj`, `BotPkTeam` |
| Set pieces | `BotSetPieces` (the interface), `BotSetPieceIndex`, `BotDirector` (about one event an hour), `BotClanWalk`, `BotTrains`, `BotParty`, `BotScams`, `BotDuel`, `BotArena`, `BotModBot`, `BotScreens`, `BotPieceLines` |
| Chat | `BotChat` (addressing, replies, the marketplace, "come here"), `BotAnswers`, `BotChatter` (unprompted lines), `BotLines` (what fits where; the repetition registry), `BotStyle`, `BotSlots`, `BotThreads`, `BotStage`, `BotWitness`, `BotReactions`, `BotVoice` (one voice's share of a place), `BotSay` (everything said goes through the word filter), `BotFilter` (the filter, remembered), `BotSpoke`, `BotEmote`, `BotActivity`, `BotPlaces`, `BotFollow`, `ComeHereTask` |
| The chat model | `BotModel` (which replies a model words, the pending reply and its fallbacks), `BotModelPrompt`, `BotModelGuard`, `BotModelHistory`, `BotModelTypes`, `BotModelAmbient` (the bots' own talk near the human: bots ideas, round 4; round 5: the reactions to the human, on with the r3 model) |

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
    count from 1 per page load; native gives up after `timeoutMs` (9,000). (Bots ideas, round 4) With `ambient: true`:
    a line of the bots' own talk (§4.9), always `mode: 'local'`, Claude's prompt empty, `timeoutMs` a tick short of its
    deadline; the page sends it with `think: false`.
  - `{type:'bots-lm-reply', id, text, source, error?, ms}` (page → engine): the model's line as it came (the engine
    guards and styles it), or null and why: `timeout`, `busy`, `unavailable`, `refused`, `failed: …`. The page answers
    null `unavailable` at once with no native side or with Rules chosen.
  - `{type:'bots-lm-mode', mode, local, online, ambient}` (page → engine), after `booted` and before `start`, and on
    every change: the player's choice and what is there. Until it comes, and with `rules`, the engine asks nothing.
    (`local` is false while the model in the app rests for memory.) (Bots ideas, round 4) `ambient`: Settings › Bot
    chat › Bots' own talk is Model and can be used (a model in the app, a chat model other than Rules); absent or false,
    the bots' own talk is the rules' alone and draws no random number of the model's.
  - `{type:'bots-lm-notice', lines}` (page → engine): game messages for every human in the world, cut at 80 characters
    (`runtime/bots/page.ts`): the page's word that the model in the app rests for memory, and that it is back.

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
| `GameMap.botFindPath`/`botWalkPath` | `port/BotPathing.ts` over `port/BotPathFinder.ts`, an exact copy of the engine's route search |
| `ScriptOpcode` `P_ISBOT`/`P_BOT_INTERACT_TRADE` | `ScriptRunner.HANDLERS[10100/10101]` (asserted free) |
| (new) saves | `saves.write`/`saves.retryPending`: bot saves to the bot store (§4.5) |
| (new) names | `World.onLoginMessage`: a human taking a bot's name (§4.6); a login with no save → `BotManager.newCharacter()` |
| (new) self-check | `World.cycle`: after the first ticks, the hooks ran and the keep-alive holds |
| (new) who attacks whom | the library itself: `BotManager.start` wraps `PathingEntity.setInteraction`/`clearInteraction` (`port/BotAggressors`); a failure there only sends the bots back to searching |

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
- **The bots' arcs** (the bots ideas work, round 2; `port/BotArcsStore`): each levelling bot's goal, its ties to other
  bots (at most 6 acquaintances and 2 grudges) and up to 2 catchphrases it borrowed from other bots ride in the same
  living world as `_meta.world.arcs` (`{"v": 1, "t": <play tick>, "b": {"<names.json index, base 36>": "<goal>|<ties>|<phrases>"}}`,
  times as ages before `t`), at most 160 KB (the weakest ties go first). Bots only: a tie names a bot of `names.json`,
  and a name that leaves the pool (a quit, a human taking it) is forgotten with every tie to it. No arcs, no field (the
  state as before); an older store, another `v` or a corrupt section restores none. A session can end at once
  (`leaveSoon(name, ticks, { abrupt, away })`: a rage-quit or a hop skips the wrap-up and the goodbye, never the engine's
  combat lock; `mayLeaveAbruptly(p)` refuses a bot in a trade, "come here", a set piece or a random event). What happens
  to bots goes on one bus (`port/BotArcsEvents`: level-ups, events, deaths, kills, steals, duels, every line said,
  logins, the director's runs), and every line the themes add is said through `port/BotArcsSay.sayArcLine` with its
  place in the speaker's talk budget.
- **Period visits** (the bots ideas work, round 3; `port/BotPeriod`, `port/BotPeriodPlan`): theme G's update buzz
  (Rellekka, its rock crabs, the lighthouse) has a budget of its own beside the far towns' and minigames' one:
  2 × (N / 100)^1.25 bots out at once (2 at 100 online, 15 at 500, 36 at 1000). A free members-world levelling bot of
  combat 15+ (no newbie; vendors, socials and PKers keep their roles) asked for its next plan is offered a visit
  0.25 × (0.5 + curiosity) of the time while the budget has room, at most once in 9,000 play ticks; the builders' entries
  (`registerPeriodEntry`) pick which. It is steady: the world is always 23 Nov 2004, so nothing decays and no clock is
  read. Nothing new is saved: the gaps are in-process, and the game's own perm varps keep a bot's pet, Runelink rank and
  chompy kills. Theme G's switch is `periodOn()` and theme H's `movementOn(kind)` (`port/BotMinimap`): on in the game,
  off in a staged test world unless asked for (§7), and asked before any roll. The other period visits draw on other
  budgets: a cat person's kitten or food trip is a sub-task of its pet habit (`port/BotPets`), the Games Room
  (`tasks/GamesRoomTask`) and Gnomeball (`tasks/GnomeballTask`) are entries of the members catalogue on the far budget
  (a lone waiter's partner joins past it). A bot in a Runelink game holds the end of its session (its role `runelink`,
  as a set piece's), so it never logs out mid-game, and never lets the game's sand timer run out.
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
  "world": {…}}`. One that cannot be read is kept as `_meta_bad` and a new one started. `world` (§4.4) carries the
  bots' arcs too (`world.arcs`, bots only, at most 160 KB of a store of about 2 MB at 1,000 bots: each write a few per
  cent bigger, no new writes); Saved data's Reset world deletes them with the store, Delete character touches none.
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
when the app has a model), `botThink` (Think first, default on) and (bots ideas, round 4) `botAmbient` (Bots' own talk,
`rules` or `model`, default `rules`: Model is not the default; greyed out unless the app has a model and a chat model other than Rules is chosen), applied at once
([ARCHITECTURE.md](ARCHITECTURE.md) §7.1).

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
  the CPU on Android); since 2026-11 the round 3 model (r3: `models/bots-2004.json`, `bots-2004-r3-q4km.gguf`, its
  release `model-v2`, since 1.2.0), trained on the replies and on the bots' own talk and reactions. How it was made: [web/engine/bots/test/model-data/README.md](../web/engine/bots/test/model-data/README.md).
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
flight; a newer reply of the same bot supersedes a waiting one. A line the guard refuses, or an empty one, is asked for
once more while the deadline leaves 4 ticks.

**Never ignored** (2026-10-26, every mode): for a line said to the bot that nothing understands, the rules' line is the
persona's way of having no answer (`NO_ANSWER` in `port/BotChat`: to a question a rude bot's "wat", a friendly one's
"sry what?", a helpful one's "idk tbh", anyone else's "lol dunno"; to anything else its nod, "k", "oh ok", "ya"; a shrug
for a question to nobody; "ya?" to its name alone), so a model that fails never leaves the human unanswered. In two
conversations at once, a line nothing understands is answered by the bot the human talked with last. A line that asks for no answer (`wantsNoAnswer`: "ok", "lol", "ty",
a smiley) gets none, and a model's now and then. Each settled reply is one line in the app's log
(`setModelOutcomeLog`: said, or which fallback and why, and whether the rules' line was said; since 2026-10-27 no
words, neither the human's line nor the reply).

**The guard** (`port/BotModelGuard.guardReply`) refuses a model's line unless it is one line of the chat's characters
within 80, passes the word filter, has no assistant talk, nothing after 2004 (slang included), never owns up to being a
bot, makes no promise the rules did not make, states only facts true to the bot (levels, places, prices), echoes
neither the human nor the bot's own recent lines, uses the human's name at the persona's rate, names no player it
cannot know, says no "brb"/"afk"/"gtg", and has no markup. Every reason has a unit check in `test/model.test.mjs`.
The accepted line then gets the persona's style (`port/BotStyle`). "Nothing after 2004" covers about 45 later terms
as players wrote them (the whip, the d scim, Barrows, the Abyss, Pest Control, the fire cape, godswords, defenders,
clan chat, ...; each item checked absent from 274's objects), and Castle Wars as played (as coming, "castle wars next
month", it passes: its portals stood closed in 274). Players' names are taken out first ("ask Whip Lad" names a
player), and 2004's own terms pass (kq, kbd, d chain, d med, mage arena, god cape, dusty key, telegrab, rock crabs, ...).

With no model chosen nothing in the model's path draws a random number (the never-ignored replies and the crowd's
shrug are the rules' own).

**The bots' own talk** (bots ideas, round 4, theme I stage 1: `port/BotModelAmbient`; Settings › Bot chat › **Bots' own
talk**, Rules by default). With Model the on-device model also words some of the bots' talk between themselves that the
human can see, as it words their replies; the rules still decide who talks, when, about what and what the line says
(their line is the hint and the fallback):
- **What**: a topic thread's turns after its opener (`port/BotThreads.turn`, via `'thread'`: the speaker's situation
  with its partner in the human's place, the partner's last line as heard, the rules' turn as the hint) and a bot's
  answer to another bot's question or named line (`port/BotChat.botAnswer`, via `'botanswer'`). The openers, the
  closer, the "ty" acks, the question back and the counter turn that answers it stay the rules'; so do the player-mod
  bot's lines and everything else (PK talk, trades and adverts, set pieces, rude lines, clique banter's own lines).
- **Stage 2, reactions to the human** (bots ideas, round 5; **on since the round 3 model ships**: `AMBIENT_REACTIONS`
  in `port/BotModelAmbient` is true, and like the rest of the bots' own talk they go to the model only with Bots' own
  talk on Model: with Rules, the default, nothing is asked and no die is drawn; set false, no reaction reaches the
  module). The reactions of `port/BotReactions` (gz on a level-up, a wave's hello, "u following me?",
  a word to one standing next to it; (round 5 ship) a bot's hello and its "u following me?" once while it and the human
  stay within 15 tiles, again only after 10 minutes out of sight or 90 minutes on) and `port/BotWitness`'s to the human (its death, its kill, a dance or another emote,
  the Wilderness, its gear, its level passing) go through the same gates as the bots' own talk (via `'reaction'`), each
  with its event in plain words (`Situation.event`: "levelled woodcutting to 60", "got killed by a pker in the
  wilderness", "is wearing a dragon med helm", "walked past you, combat 95"), the rules' line the hint and the fallback,
  at the rules' timing. Their prompt is renderLocal's reaction branch ("Say one short chat line to {name}." and the chat
  ending "({name} {event})" before the answer idea; every other prompt is as before, byte for byte). A reaction decided
  in the tick a line of the bots' own talk was asked goes first (that line falls back to the rules', at its rules'
  time). The guard keeps a reaction's role (`'role'`: no "ty", "thx", "np", no "wat u want" or "who is u", unless the
  rules' line has it); the counter and numbers checks are the turns'. (Round 5 ship) A reaction may name the human's
  own combat level although its event does not ("lol lvl 14 in the wildy" to a combat-14 player at the ditch: the bot
  sees it; any other number is a claim as before), and a question about following ("why u follow me", "u following
  me?") is no promise anywhere ("follow me", "ill follow u", "come with me" still are; the checker,
  `test/model-data/checks.mjs`, agrees). The round 2 model read only 35-48 % of reactions
  right; r3 (round 3's data: `web/engine/bots/test/model-data/README.md` "Round 3") passes the guard on all 80
  held-out reactions (r2 83.8 %) and 91.3 % of 80 bot turns (r2 75 %), a blind judge scored its new lines 3.02 of 5
  for 2004 feel (r2 2.27, the rules 3.51) with 92 % of facts right, about even with the rules (52-62, 46 ties), and
  its replies to the player are as r2's (99.7 % guard). `humanlike --model=... --ambient` measures them
  (`--reactions=false`: without).
- **When** (every check before anything is drawn: with Rules, or near no human, nothing of it draws a die): the
  speaker within 15 tiles of a human on its floor; the on-device model there (`ambientAvailable`: never Claude, even
  with Claude online, and never Think first); no request in flight (a reply to the human never waits behind one; (round
  4 fixes) nor is it 'busy' for one: the replies' `MAX_IN_FLIGHT` does not count it, and native stops one running at
  its next token when a reply comes); 34 ticks (20 s) since the last ambient request, world-wide (at most 180 an hour).
- **Timing**: the rules' own (`port/BotChat.ambientKeyboard`: their line's typing time, the same dice as before), the
  bot at its keyboard to a deadline 4 ticks past it. The model's line, through the guard and the persona's style, is
  said at its own typing time after the answer, never past the deadline; any fallback (the deadline, an error, the
  guard, the human's line to that bot superseding it; (round 4 fixes) any line of that bot's to a human through
  `sayTyped`, the vendor's answer or "sry was afk", supersedes it too, `supersedeAmbient`, so that line is typed from the
  rules' time, not the deadline) says the rules' line at its rules time, or at once when that has passed. No retry. So a
  thread is 4 ticks late at most, and only when the model is slow.
- **The guard** adds two checks for these lines (`opts.ambient`): the rules' counter-question kept ("41 u?": the next
  turn answers it; `AMBIENT_COUNTER_RX`, the threads' `COUNTER_RX`) and every number of the rules' line kept (the next
  turn compares it); else `'counter'` or `'numbers'`. (Round 4 fixes) A counter-question the rules did not ask ("ps2 i
  think, u?") is refused too (`'counter'`): the partner's next turn is drawn already and would leave it hanging.
- **Numbers apart**: `modelStats.ambient` (and the log's entries marked `ambient`, with the rules' due tick): the
  humanlike runner's LM1-LM8 (`--model=... --ambient`); the replies' MD1-MD6 are as before. The app's log marks each
  settled one `(ambient)`, with no words; native refuses them when the phone is warm (thermal fair), while the model
  rests, and behind a reply to the human ([ARCHITECTURE.md](ARCHITECTURE.md) §7.1).
- **Measured** (2026-11-01, the stub and the shipped r2 model on llama-server on the Mac,
  measured with a stub and the shipped model): few lines qualify. With the human standing at Varrock West bank among 500 bots
  (10×) about 10 ambient requests an hour (12 lines near the human; the rest of the bots' talk there is openers, acks,
  stage practices and the like, or far away), 1-20 an hour on the runner's tours; the 20 s pace held back 0-4 an hour.
  With every request failing (the rules' lines at their own time) the world is the same, fingerprint for fingerprint,
  as without the setting; with the model's words H7 moved 0 to -0.1 in three runs (-0.4 in one with a single line:
  its later timing moves the world). The real model: 2 of 27 answers refused (both dropped the counter-question),
  lines said at most 4 ticks after the rules' time (the deadline caps them), and 16 of the 25 said read right in 2004
  style (most of those the hint with a word or two added; the rest off-meaning, "no i think so" to "is rs down?"). The phone heat test (`web/test/perf/lm-ambient-500.json`,
  `lm-ambient-1000.json`) on an iPhone 13 mini: thermal state nominal throughout at 500 and 1000 bots, 51 fps, replies about 1 s.

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
  online from start to shutdown and redrawn at every launch; (the bots ideas work) rumours that move some bots, saved
  ties and grudges between bots, catchphrases that spread between bots, staggered clique logins.
- **Earned gear**: no starting bank of every armour set and 999,999,999 sharks.
- **2004 realism**: human timing and habits, chat that fits the moment, a 2004 economy and adverts, looks, social life,
  set pieces, random events, fallibility and rudeness, the Duel Arena, the player-mod bot, the chat model.
- **Period content and movement** (the bots ideas work, round 3): the 23 Nov 2004 update's buzz at Rellekka (the rock
  crabs, sightseeing, the lighthouse: `tasks/BuzzTask`, `CrabTask`, `LighthouseTask`) on a budget of its own, kittens
  (cat people, Gertrude's dialogue, the care), the Games Room's Runelink (real games, the human's challenge answered)
  and Gnomeball (theme G; chompies were cut, the first of the round's cuts), and walking in minimap-sized clicks with
  pauses, route variants and talk that stops a walk (theme H: `port/BotMinimap`, `port/BotTalkMoves`). Castle Wars
  stays talk, in the future tense: its lobby is sealed in 274. Upstream's bots touched none of it.
- **The human's death pile looted** (the bots ideas work): upstream's PKers walked away from a kill and restocked by
  emptying their pack; the port's killer and vultures take the pile by 274's visibility rules, and a loot ledger keeps
  the human's items through the restock to the bank.

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

The cheaper searches, scans and arrays of 2026-10-23 (below), measured with the same command against the code before
them on the same day (a busier machine: before, the whole tick averaged 43.7, 53.2 and 60.6 ms): the whole tick 15, 14
and 16 % shorter at 500, 750 and 1000 bots, the bots' share 34, 29 and 31 % shorter, the heap the same. Counted in
instructions in JavaScriptCore (the same seeded world before and after, which ended the same), a tick takes 18 % fewer
at 500 and 21 % fewer at 1000.

Theme H's walking (hops, pauses, lanes and route variants: no extra route search; a walk-up's one short search) and
the update buzz cost little: back to back on 2026-11-01 (`measure.mjs --bots --real --runtimes=jsc --counts=500,1000
--ticks=300`, the round 3 H library against round 2's, a busy machine), the whole tick 36.3-37.5 against 36.2 ms at 500
bots and 50.2-50.4 against 50.3 ms at 1000, the bots' share 16.2-16.8 against 15.3 ms and 25.2-25.4 against 25.1 ms,
the route searches 21.7-23.6 against 22.4 a tick (budget 60) and 41.4-41.8 against 41.0 (120).

750 and 1000 have been measured on the Mac and in the iPhone simulator only (1000 in the simulator: 50 fps at Varrock
West, ticks late 38-70 ms at the p95), not on a phone; their memory (about 90 MB more heap than no bots) and heat over
a long session on a phone are unknown. A fresh world of 1000 takes about 200 ticks (2 minutes) to fill.

What keeps it cheap: route searches are budgeted (12 a tick per 100 online, a bot resuming where it stopped; bots more
than 64 tiles from every human get at most a third of the budget) and run the bots' own copy of 274's search, which
returns the same routes with cheaper collision reads (1.9× faster in JavaScriptCore, 2.5-3× in V8); the nearest-NPC, loc
and item searches walk the zones' lists without the engine's generators, a fight's "is my target still here" looks in
the target's own zone, and "who attacks me" reads an index of who targets whom instead of searching 25-49 zones; the
bots' scans of every player and of the active bots read arrays taken once a tick, not the generators; the word filter's
answers for the last 4,096 distinct texts are kept for every check and line; the walking graph's A* reuses its arrays
between searches; appearances are rebuilt only on change, each bot's rescan timer starts at its own point, and the bots'
own logouts write the store at most every 30 s (at 1000 bots that is at most about 140 MB of writes an hour, plus the
save occasions).

## 7. Tests

```sh
node web/engine/bots/test/all.mjs            # the library: type-check, worker safety, names, inventory vs 254, pathing,
                                             # the walking graph, content names, determinism, chat, lines, trade, the
                                             # economy, PK, habits, social life, looks, set pieces, the living world, …
node web/engine/bots/test/all.mjs --full     # + task coverage on both world types, long simulations, the living world
                                             # at 25 to 1000 online, a crowd of 250, the humanlike report
node --expose-gc web/engine/bots/test/endgame.test.mjs [--only=kbd]   # the endgame staged in the real world (seeds.mjs at many seeds;
                                             # --only=kq: the KQ attempts' scenes)
node --expose-gc web/engine/bots/test/identity.mjs --base=main   # a change that must not change what the bots do: four
                                             # seeded worlds end the same as with the library before it
node web/engine/test/all.mjs                 # the engine worker, incl. bots.test.mjs: the glue against the real library and the stub
node web/test/e2e.mjs --bots 25              # the page with 25 bots (--bots 0: explicitly off)
node web/test/app-test.mjs --bots 25         # in the app (simulator; --device for the iPhone): the setting, fps, ticks, saves
node web/engine/test/measure.mjs --bots --real   # the performance tables
```

The tests read the upstream sources (see [BUILDING.md](BUILDING.md)) and never write to them: each test that needs
the engine works in a scratch copy under `build/tmp/bots/`, with the library linked in. Every test file's header says
what it checks; `web/engine/bots/README.md` has the full table. `LC_BOTS_SRC=<dir>/src` runs any test against another
copy of the library (with its `data` beside it).

`test/loot.test.mjs` (the bots ideas work, round 1) stages the human's death pile (a real Edgeville PKer's kill and
its loot before the reveal, a vulture after it, a full pack, an NPC's death, a multi-combat kill, a looted PKer's own
death and the saved ledger, the Duel Arena), the Chaos Temple's zone, the lever camps, the wine crowd and the
safespots, and the round's review findings (a hurt killer, a PJer's jump the tick after a Take, a bot's own drop by the
death, a wine stint cut short, a ledger restored newer than its bot's save, a bot that quits with a ledger), and its
left-overs (the grab's human moment, the way out by the temple's door, a grab's tile in sight of the table, a ranger
moving to a free safespot). `humanlike.mjs --die=pk:3000` (or `npc:3000`) lets the touring human die every 3,000 ticks for the loot
metrics (LV1-LV11); LV12-LV16 (the wine crowd, safespots, camps, the temple) need no flag.

`test/arcs-store.test.mjs` (the bots ideas work, round 2: the arcs foundation) checks the saved arcs (the encoding,
every goal kind, the caps, 2,000 bots at the caps within 160 KB, an old, corrupt or foreign section, quits, ties to no
pool bot), the bus and its sites, `sayArcLine`'s four budget modes, and an abrupt leave; `test/arcs.test.mjs` (theme C)
and `test/word.test.mjs` (theme D) stage the themes. The humanlike runner fills `record.arcs` for their AR and WT
metrics (WT1 is the levelling bots in the Wilderness, older). `word.test` (theme D: word that travels) stages a
rumour's telling heard by the bots near and passed to a clique mate by PM (never the human a knower), the "where?"
answer, a word guest at a drop party from 130 tiles, the director's telling from a knower, a wrong place's walk and
its "wheres the dp??", a pk rumour (a trip skipped, a knower turned back), a full mine avoided and a free one
preferred, a tie over two sessions and its greeting at the next, the store and decay, a meant KS's grudge and "u
again", the KS war within the steal caps, Edgeville rivals, a catchphrase adopted, saved and faded (never the
human's), and the clique stagger. Its WT metrics: WT2 word guests' share of a party (500 bots), WT3 knowers who acted,
WT4 wrong-place trips, WT5 acquaintances and greetings, WT6 grudge lines and KS between a grudge pair, WT7 borrowed
catchphrases, WT8 clique logins within 2 minutes of a mate's (at most 25 %), WT9 rumours the human heard, WT10 the
human's name in no tie, rumour or phrase.

`test/arcs.test.mjs` (theme C, lives with arcs; `--only=goals,done,lean,answers,moods,rage,hop,whims,ninety,drop,endgame`)
stages goals drawn from the real state and their save, a level goal's celebration in the level-up line's place (the gz
only as the level-up's own line), a money goal's line, the lean (200 picks), "whats ur goal" against a statement, the
moods from a death, a kill-steal and a duel (the tilt lines, the rude-reply and gz weights, boredom's next pick and a plan
left whole), a rage-quit with a line from you answered first, a hop off a crowded mine, a big drop banked, a whim's timed
task and a PKer's fishing break banked before its restock, a 99's gathering (its clique's PM, the hold, the gz, its drop
party at the nearest bank), a mini party and round 1's endgame hook. The runner's `--probe` asks "whats ur goal" too
(AR2); AR1-AR11 read the goals, the moods' tilt episodes, the leaves, the whims, the 99s and theme C's lines. A staged
world of `test/lib/simworld` has theme C off unless the test asks for it (`Sim.create({ lives: true })`, as the far-town
outings are): another theme's scenes run as before it; the humanlike runner and `arcs.test` turn it on. Theme D is
the same (`Sim.create({ word: true })`: its rumours, ties and slang off by their rates, the clique timing as before
it); the humanlike runner and `word.test` turn it on. Round 3's themes are too: theme G, period content
(`Sim.create({ period: true })`, `port/BotPeriod` setPeriodForTest: the buzz's hook and budget, the pet habit, the
Games Room, Gnomeball, the Rellekka buzz, chompies), and theme H, movement (`Sim.create({ movement: true })`,
`port/BotMinimap` setMovementRatesForTest: hops, pauses, overshoots, lanes, route variants, walk-ups, talk holds). Every
G and H hook asks its switch (`periodOn()`, `movementOn(kind)`) before any roll, so a theme that is off draws no dice;
the humanlike runner turns both on from the first login (`--period=off`, `--movement=off` for an A/B run of the same
seed), and `identity.mjs --on=period,movement` checks a foundation with them on.

`test/period.test.mjs` (the bots ideas work, round 3, theme G: `--only=kitten,runelink,gnomeball,talk,cw,lines`)
stages a cat person's kitten (the trip from the habit, Gertrude's door and dialogue, 100 coins, the follow, a feed, a
stroke and its page, a jump, 40 minutes with no pet page left open, a food trip taking its own fish from the bank, a
logout and a login that keep it, a death that loses it), two bots' whole Runelink game (no move forced by the sand
timer, out by the stairs, no rescue jump, no engine error), the human's challenge answered and its resign, bots that
never challenge the human, a Gnomeball visit (the gate, the referee, a win's XP, the weapon wielded again, the free
ball dropped, tackles only with the human in view), the topics pet and gamesroom and the answers (none while theme G is
off), the period's idle talk in the place of a due idle line (none and no dice while theme G is off; about its share,
spread over its kinds, when on), Castle Wars as talk only (no task's spot near its sealed lobby, no line that says it is
open), and every period moment's lines said as set pieces. Its PC metrics: PC3 pets out per 100 online (members 1-4), PC4 pets lost to
neglect per 10 pet-hours (at most 0.5) and pages left open (0), PC5 Gnomeball (report), PC6 Runelink games an hour (3+
at 500, at most 10 % of moves forced); H19 leaves the Games Room's seated waits out.

`test/period-budget.test.mjs` (the bots ideas work, round 3: the period foundation) checks theme G's switch and the
buzz's budget, registry and planner hook (no dice while theme G is off or nothing is registered: the builders' entries
taken out for it; offers, caps, the gap, the keep; visits and their rescue jumps by kind; a rumour's boost);
`test/period.test.mjs` (the G builder: kittens, Runelink, Gnomeball) and `test/buzz.test.mjs` (the H builder's theme G
parts: the buzz's offer, the crabs unobserved and in the human's view, the lighthouse both ways and a give-up,
sightseeing, the lines and a heard line's boost) stage theme G; `test/movement.test.mjs` (route variants, hops near the
human and legs as before far from it, lanes, overshoots, the exemptions, the typing stand) and `test/talkmoves.test.mjs`
(a walk-up, a held walking partner, the never-held cases, a hit and the human's line ending a hold) stage theme H;
`test/model-ambient.test.mjs` (the bots ideas work, round 4: the model for the bots' own talk with the stub: the
guard's ambient checks, a thread far from the human asks nothing, near it one request per turn after the opener, a
bot's answer, the 20 s pace and a request in flight, a reply to the human going first, (round 4 fixes) the replies'
cap without the ambient request and a line to the human giving it up, a dropped counter, a silent model, Claude online
(still local), and no dice when off; round 5: the golden check of round 2's reply prompts, a reaction's prompt with its
event, the reactions' switch off with no request or die, a reaction's role, a reaction going first) stages theme I's
stages 1 and 2, whose LM metrics (LM1-LM8: requests
an hour, the share in the model's words, guard refusals, replies to the human asked while one was in flight, counters
kept, fallbacks, H7 against the same run without the model: `--lm7-base`, lateness against the rules' time) the
runner prints apart with MD1-MD6 under `--model=... --ambient`. The
runner's MV metrics (MV1-MV9: short stops, trips with a stop, hop lengths, repeated and shared routes, turns typed
walking, openings far apart, overshoots, travel time against `--movement=off`: pass its `--json` as `--move-base`) read
its own trips and lines (an older library gives MV1, MV2, MV4-MV7 a "before") and `port/BotMinimap`'s stats; PC2 needs
`--tour=still --at=rellekka_crabs`. The humanlike runner fills
`record.period`, `record.buzz` and `record.move` for their PC and MV metrics; PC1 (bots at Rellekka and the
lighthouse per 100 online), PC8 (period talk's share), PC9 (Castle Wars said to be open: 0) and PC10 (rescue jumps per
100 period visits) need no flag, and PC1, PC8 and PC9 read the runner's own samples, so an older library gives them a
"before".

The staged tests (fixes, scams, parties, groups, the Duel Arena, …) take bots of a seeded world, so a check that held
only on some dice failed when anything else moved them (a new draw in a planner, a bot that walked a tick longer).
Each scene draws from its own dice (`test/lib/dice.mjs`), stages what its checks ask (a fighter ready to fight with
its bank empty, a bot held on its tile, the world's own player-mod bot and random events off where a check is not
about them), and should pass at every seed: `node web/engine/bots/test/seeds.mjs fixes.test.mjs --seeds=1-20` runs a
test at many seeds, one at a time, and lists which checks failed at which.

Seeded worlds repeat exactly in V8 (Node). In JavaScriptCore they do only with `Array.prototype.sort` replaced by a
deterministic one: some of upstream's tasks shuffle with `sort(() => Math.random() - 0.5)`, and JavaScriptCore's native
sort calls such a comparator a varying number of times once its optimizing JIT tiers run, so the random draws shift
(harmless in play, where the world is not seeded; the spec leaves that order to the engine).

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
- **An engine update** (a new Engine-TS commit): the bots' copy of the route search (`port/BotPathFinder`) reads
  `CollisionEngine`'s zones, the zone searches (`port/BotZoneScan`) read the zones' private lists (`npcs`, `locs`,
  `objs`, a list's `sentinel`, a node's `next`/`next2`), and the index of who attacks whom (`port/BotAggressors`) wraps
  `PathingEntity.setInteraction`/`clearInteraction`, the only places an NPC's target changes; the tick's array of the
  players (`port/BotPlayers`) holds while only `World.processLogins` adds a player and `World.removePlayer` removes one.
  `node --expose-gc web/engine/bots/test/exact.test.mjs` compares each with what it replaces on every call of a seeded
  world (and the route search on a sweep of the map), and fails on any difference.
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
