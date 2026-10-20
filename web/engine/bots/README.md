# Bots: the library

The AI players of [2004sp-progressive](https://github.com/2004sp/2004sp-progressive) ("Lost City Singleplayer
Progressive", a mod of Lost City **revision 254**), ported to the **revision 274** engine that both apps run. They
start in Lumbridge and train every skill, bank, buy their tools and gear, fight, PK in the Wilderness, sell to and
trade with the player, take part in the world's events and chat.

This folder is the bot library. What loads it into the engine worker (the hooks, the bot saves, the content-script
overlay) is the runtime's (`web/engine/src/runtime/bots`, `web/engine/bots/content`), the Settings rows are the host's
(`web/host`), and the contracts between them, what the bots do and how they perform are in
[docs/BOTS.md](../../../docs/BOTS.md). This guide is for working on the library: its layout, every change from
upstream with its reason, its tests and how to take in newer upstream code.

## Credits and licence

The bots are the work of 2004sp-progressive's authors: **attackishere, _mrsam, K-andy and callum**. Both the mod and
this app run on [Lost City](https://github.com/LostCityRS).

Upstream has no LICENSE file; its README says it is "available under the same license as Lost City", which is MIT.
The vendored code keeps that licence: [LICENSE](LICENSE) here, and the full texts in
[THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md). `test/ref/Inventory254.ts` is Lost City's revision 254
`Inventory.ts` (MIT, Copyright (c) 2025-2026 Lost City), unmodified, used as a test reference.

## Layout

| Path | What |
|---|---|
| `src/` | Upstream's `engine/src/engine/bot/**`, file names and structure kept, ported to the 274 API. Imported as `#/engine/bot/*` |
| `src/tasks/` | The tasks: upstream's (one per activity) and the port's new ones (newbie, party, duel, outing, errand, minigames, …) |
| `src/port/` | New modules: what the mod patched into the engine, and everything the port added (below) |
| `data/` | Bundled as JSON imports: upstream's `chat_responses.json` and `bot_phrases.json` (the player names cut out of its lines marked `{name}`), and the port's `names.json`, `walk_graph.json` (made by `test/walk-graph-build.mjs`), `line_tags.json` (where each idle line fits, made by `test/line-tags-build.mjs`), the `lines2004*.json` files (lines in a late-2004 voice by moment), `threads.json`, `practices.json`, `social.json`, `party.json`, `duel.json` and `street_prices.json` (December 2004 street prices, each with its source) |
| `content/` | The three script patches for the bots, their `BASE` commit, and the overlay compiler |
| `test/` | Unit tests, the content-name check, the world simulator, the humanlike report ([Tests](#tests)); `model-data/` makes the chat model |
| `tsconfig.json` | `tsc -p web/engine/bots`: the library against the upstream engine's sources |
| `UPSTREAM` | Where the vendored files came from |

The core files are upstream's: `BotManager` (spawning, sessions, the per-tick AI), `BotPlayer` (one bot: its task, its
plan, its sub-tasks), `BotGoalPlanner` (the next task, by personality and state), `BotKnowledge` (every skill's steps
with their spots, shops and banks), `BotNeeds` (tools and coins a step needs), `BotAction` (the primitives that drive a
player through the engine: walking, interactions, interface buttons, the bank), `BotNavigation`, `BotAppearance` and
`tasks/BotTaskBase`. `BotDatabase`, `BotTask.ts` (upstream's legacy task file), `BotCollisionMap` and
`debug/BotDebugServer` are kept but nothing the bundle reaches imports them (`test/worker-safety.test.mjs` checks it).

| `src/port/` | What |
|---|---|
| `PlayerBotFields.ts` | The fields the mod added to `Player` (module augmentation; only bots get them) |
| `BotScriptCommands.ts` | `P_ISBOT` = 10100, `P_BOT_INTERACT_TRADE` = 10101 |
| `BotPathing.ts` | `botFindPath` / `botWalkPath` (upstream's GameMap patches) over `#/engine/routefinder`, with the per-tick search budget and the level of detail (far bots get a third of it) |
| `BotWalkGraph.ts` | Long walks over the walking graph of the overworld (`data/walk_graph.json`), A* and cached; free areas only on a free world |
| `BotInventoryCompat.ts` | Revision 254's all-or-nothing `add`, moves clamped to the room in the target, deposits that keep what a full bank refuses |
| `BotContent.ts` | Content lookups whose names or meaning changed in 274 (cooking locs, trees, water, `sa_energy`, Wilderness levels, multi-combat, toll gates) |
| `BotWorldRules.ts` | Free worlds: members-only skills and steps dropped, bots kept in F2P |
| `BotSchedule.ts` | Delays counted in world ticks (upstream used `setTimeout`) |
| `BotLog.ts` | The console the bot modules log through: info only with `debug`, errors rate-limited and counted |
| `BotSeed.ts` | Dice that come out the same for the same bot, from its name |
| `BotRoster.ts` | Names and planners (upstream's `bots.config.json` and database accounts), the pool of about 2N for N online, the role mix, the names newcomers take |
| `BotSessions.ts` | The living world's durations in play ticks: sessions, absences, the newcomer clock, the empty world |
| `BotNewbie.ts` | Newbie newcomers: the tutorial's kit, newbie by levels (combat 10, total level 60), the slow levellers, their lines |
| `BotAge.ts` | A new bot world's ages: tier, stats, kit, look and start tile from the name ([below](#a-new-bot-worlds-ages)) |
| `BotPersona.ts` | Who a bot is beyond its skills, from its name: how much it talks and how it types, how quick, careful, friendly and sociable it is, its age and home |
| `BotLooks.ts` | Gender and body from the name, its taste in gear, the armour pieces by kind and metal, the wardrobe, rares and holiday items |
| `BotOutfits.ts` | What a name says about its clothes: class names (mage, ranger, chef, …), the combat style it dresses for, weapon kinds, skill clothes, tools in hand |
| `BotFashion.ts` | Status gear ((t), (g), god and gilded pieces), late-2004 members fashion, novelty pieces, PK outfit variety, wealth |
| `BotGear.ts` | Earned gear: the next piece a bot buys, wardrobe trips, what a bank stop takes off and puts on for a skill, a fight or a hub |
| `BotFavourites.ts` | A name's theme ("Yew Cutter"), favourite skills, home town, and whether it power-trains |
| `BotTiming.ts` | Human timing: typing time and how long a bot takes to act again, by kind, from its persona |
| `BotHabits.ts` | Short breaks ("brb"), lingers, a look at a fight or a dance, leaving the game like a player |
| `BotLinger.ts` | A bot that logs in near a human looks about for 10-40 s first |
| `BotTiles.ts` | A standing bot's own tile near its spot, held until given back |
| `BotHangout.ts` | Hang-outs at Falador park, Varrock square and the banks |
| `BotFumble.ts` | Misclicks, forgotten food, and the carelessness that drives them |
| `BotRude.ts` | Kill- and rock-stealing by rude bots, with their caps, and rude replies |
| `BotDanger.ts`, `BotDefence.ts` | Where monsters hunt a bot; fighting off or running from an attacker; resting before a hunted spot |
| `BotRandomEvents.ts`, `RandomEventTask.ts` | Random events armed on bots near a human and answered through the game's own scripts |
| `BotTeleport.ts` | Real teleport spells on long trips, for bots with the level and the runes |
| `BotTravel.ts`, `BotExits.ts`, `BotUpstairs.ts`, `BotDungeons.ts` | Spirit trees and the gnome glider; ways out of Shilo and upper floors; climbs; dungeons' ways in and out |
| `BotSpots.ts` | A spot's capacity from the map and the bots on it, so a busy spot sends a bot to the next |
| `BotPowerDrop.ts` | A power-trainer's full pack dropped one item at a time |
| `BotChains.ts`, `BotErrands.ts`, `BotErrandLines.ts`, `BotD2Picks.ts` | The low-level economy chains and the free quests' look-alikes, run as errands (`tasks/ErrandTask`), their lines and the planner's offers |
| `BotMagicRuns.ts`, `BotHerbRuns.ts`, `BotAlch.ts` | Bone runs, superheat, enchanting, telegrab; herb runs; alching stints |
| `BotWildTrips.ts` | Wilderness levelling trips for bold bots |
| `BotOutings.ts`, `BotMinigames.ts`, `BotClues.ts` | Far-town outings and members minigames under a budget scaled with N; Treasure Trails |
| `BotTrade.ts`, `BotTradeScreen.ts` | A human's trade request (taken by a free trading bot, else declined); trades driven by the real trade screens |
| `BotTradeSpots.ts`, `BotPrices.ts` | Vendors' stalls at the trade banks; prices (value rules, street prices, rares), stock and how 2004 wrote a price |
| `BotShowOff.ts` | A rich bot's visit to a trade hub in its best gear |
| `BotPkGear.ts`, `BotPkTactics.ts`, `BotPkFight.ts`, `BotPkPj.ts`, `BotPkTeam.ts` | PK gear profiles; prayers, the bow, escapes and the PK lines; a fight's kit, eating, potions, the KO switch, teleports; PJing; PK team raids |
| `BotSetPieces.ts`, `BotSetPieceIndex.ts`, `BotDirector.ts` | The set pieces' interface and registry; the director (about one event an hour, where the bots are) |
| `BotClanWalk.ts`, `BotTrains.ts`, `BotParty.ts`, `BotScams.ts` | Clan walks; newbie follow trains; drop parties and the Party Room; scam callers |
| `BotDuel.ts`, `BotArena.ts`, `BotModBot.ts` | Duels through 274's screens; the Duel Arena's life and the human's challenges; the player-mod bot |
| `BotScreens.ts`, `BotPieceLines.ts` | Screens clicked as a player does (Offer-X, dialogues, an item used on a player); the set pieces' lines |
| `BotChat.ts` | Upstream's chat AI (addressing, intents, greetings), the marketplace and "come here", typed replies, `composeReply`, the crowd's answers, bots answering bots |
| `BotAnswers.ts`, `BotActivity.ts`, `BotPlaces.ts` | Answers from a bot's state: directions, prices, asl, quests, spots; what it is doing; places as players named them |
| `BotChatter.ts`, `BotLines.ts`, `BotStyle.ts`, `BotSlots.ts` | When a bot talks unprompted; which line fits (the tags, the repetition registry, repertoires); how its persona types; slots filled from its state |
| `BotThreads.ts`, `BotStage.ts`, `BotWitness.ts`, `BotReactions.ts`, `BotVoice.ts`, `BotSpoke.ts` | Topic threads between bots; exchanges near the human; witnesses; reactions to the human; one voice's share of a place's talk; who spoke to whom |
| `BotSay.ts`, `BotEmote.ts`, `BotFollow.ts`, `ComeHereTask.ts` | Everything said, through the word filter; emotes; Follow (a clique's travel, a line of followers); "come here" |
| `BotModel.ts`, `BotModelPrompt.ts`, `BotModelGuard.ts`, `BotModelHistory.ts`, `BotModelTypes.ts` | The chat model's seam: scope and fallbacks, the situation and prompts, the guard, the history, the messages ([docs/BOTS.md](../../../docs/BOTS.md#49-chat-and-the-chat-model)) |

## API

As [docs/BOTS.md](../../../docs/BOTS.md#42-bot-library-api-enginebot-called-by-the-glue) §4.2: `BotManager` (`start`,
`tick`, `clearAfkEvents`, `isBotPlayer`, `newCharacter`, `ownsName`, `isActiveBot`, `retire`, `release`, `activeBots`,
`botFor`, `exportWorld`, `stats`), `BotChat` (`onPublicMessage`, `onPrivateMessage`) and `BotTrade.onTradeRequest`. The
library does no I/O: a bot's save comes in through `options.loadSave` and leaves through the engine's own logout and
autosave path, which the runtime sends to the bot store. Nothing runs before `start` or between ticks.

## Port notes: what behaves differently from upstream, and why

Each of these is marked `port:` in the source. The tables cover the port proper (making upstream's bots work on 274
and fixing what kept them from playing); what the port added beyond upstream (the living world, habits, chat, looks,
the economy, set pieces, activities) is described feature by feature in [docs/BOTS.md](../../../docs/BOTS.md#1-what-the-bots-do),
with the modules above.

**Running inside the engine**

| Upstream (rev 254) | Here (rev 274) | Why |
|---|---|---|
| `BotManager.init(World)` from `World.start`; accounts from its database and `bots.config.json` | `BotManager.start(world, options)` from the runtime after `World.start`; the roster from `data/names.json`; saves through `options.loadSave` | The engine runs in a worker with no database or files |
| `World.processLogouts` rewritten to keep bots logged in | `BotManager.tick` refreshes every bot's `lastResponse`/`lastConnected`, also during a shutdown | No engine patches (docs/BOTS.md §2) |
| A throw in a bot's tick went up into `World.cycle` | Caught per bot, counted in `stats().errors`, logged | A throw in `World.cycle` stops the world |
| `console.log` throughout; a status dump every 100 ticks | `port/BotLog`: log/info/debug only with `debug`, warn/error at most 10 per 100 ticks (then a summary); the dump is debug-only | Log volume and cost on the phone |
| Chat replies and cooldowns with `setTimeout` | Counted in ticks (`port/BotSchedule`, run by `BotManager.tick`) | A timer fires while the world is paused and after it stopped |
| `bot_phrases.json` read with `fs`; `unwalkable_tiles.csv`; `BotDatabase`; the `BotDebugServer` dashboard (http/ws); `BOT_DEBUG_*` settings | JSON imports; the engine's own collision; not in the bundle; the debugger stays off (274 has no such settings) | No files, network or database in the worker |

**The living world** (new: upstream's bots were all online from start to shutdown)

| Upstream | Here | Why |
|---|---|---|
| The configured bots online for good | About N online out of a pool of about 2N (`BotRoster.initialPool`); each plays a heavy-tailed session of 5 min–6 h of play time (median about 42 min), logs out through the normal logout path once nothing holds it (a fight, a trade, "come here"; a goodbye in a conversation) and comes back from its save 10 min–1.5 h later (sooner after a short check-in); the planner group most short of its share comes first (`BotManager`, `BotSessions`) | A world where people come and go, and a new character finds players of its own level (docs/BOTS.md §1) |
| — | A newcomer (the next unused name, a levelling planner, fresh at the Lumbridge spawn) paced to keep 7-9 low-level bots per 100 online about Lumbridge (`BotSessions.newcomerPace`), and 1–3 after a new character; then an away bot no human has as a friend quits for good: a vendor, PKer or social bot while its group is past its cap (a store saved under the first role mix), else one of the levelling group most over its place, as a rule the newcomer's (`BotRoster.NameSource`, `BotManager._quitOne`) | Newbies keep coming; the pool keeps its size; a name is never used twice |
| Bots kept the world busy with nobody in it | After 100 ticks without a human every bot logs out, keeping the rest of its session; the next login fills the world | The title screen cost a tick's worth of AI for nothing |
| InitTask (200 coins, starter tools, the bank seed) at every spawn | Only for a bot without a save | Every launch, and now every return, gave every bot another 200 coins |
| A bot that left the world kept its claims on trees, rocks, NPCs and social partners (also when retired for a human) | `BotPlayer.windDown` resets its tasks (releasing them) and cancels a teleport it was casting before it logs out | Other bots skipped those for good |
| Replies checked by the bot's name | By its Player object (`BotManager.botFor`): a bot that left drops what it had scheduled | A reply scheduled before a quick out-and-back was said by the removed Player, so nobody saw it |
| "come here" while a bot cast a teleport | The teleport is cancelled and the bot comes | A deep-Wilderness PKer called near Edgeville teleported back to its zone |

**Spawning**

| Upstream | Here | Why |
|---|---|---|
| Every bot at start | Once a human is in the world, never on tick 0, at most 5 a tick | An appearance first built on tick 0 is never sent to a later player (the bot stays invisible); no login burst |
| A fresh bot scattered round Lumbridge by code that 274 never reaches (new players start on Tutorial Island) | A walkable tile within 5 of the Lumbridge spawn, tutorial done (`%tutorial` = 1000) | Bots were left on Tutorial Island |
| All quests complete (upstream's varps) | The same varps (names, ids and values checked against 274) plus the quests 274 added (Regicide, Tai Bwo Wannai Trio, Eadgar's Ruse, Shades of Mort'ton, The Fremennik Trials, Horror from the Deep) | Regicide 0 with Underground Pass done sends the King's messenger after every bot |
| A members world assumed | The world's flag; on a free world members-only skills and steps are dropped and a bot outside F2P is moved to Lumbridge (as the engine does for humans); no Agility XP for switching tasks | 274 stops non-members at the F2P border |
| Appearance re-rolled at every start and rebuilt every tick | Kept from the save; rebuilt when the worn items or the combat level change (a new bot's from its name: `port/BotLooks`) | Every tick it cost ~60 bytes per bot in view (27× PLAYER_INFO); with ~75 in view some bots never appeared |
| An unreadable save replaced by a fresh bot | That bot skipped for the session | Never overwrite progress |

**Movement**

| Upstream | Here | Why |
|---|---|---|
| `maxWaypoints = -1` (254's pathfinder: the whole route) | 25 (the waypoint queue's size) | -1 keeps one waypoint in 274: bots stopped at the first corner and searched again |
| Unlimited searches (one bot's fallback sweep: up to 76 in a tick) | 12 per tick per 100 bots online (at least 12), shared by all bots; a bot cut short resumes at the same attempt next tick; a different bot goes first each tick | Tick time |
| Direct attempts at any distance, 90-tile midpoints | Targets at most 60 tiles away | 274 searches 128×128 tiles around the bot: a target 64+ tiles away is never found |
| A failed `botWalkPath` retried as `botFindPath` | One search per attempt | Same search, stricter acceptance: it cannot succeed |
| `unwalkable_tiles.csv` (8.85 MB) and `trimPathAtCsvBlock` | `isMapBlocked \|\| !isZoneAllocated`; no trim | The CSV is 254's map (stale for 218 map squares, 20 MB of heap); the trim read the route from the wrong end, and an engine route never crosses a blocked tile |
| A closed gate within 8 tiles ended the route search, reachable or not | The search goes on when the bot has no route to the gate | A bot shut in near a door searched the same two routes every tick |
| A teleport (stuck recovery, watchdogs) landed on the exact tile given | The nearest tile within 8 from which 12 tiles are reachable | Bots landed in pockets between stalls and stood there |
| Picking up a ground item set the interaction only | It also walks the bot to the item | With `clientRoutefinder` the server walks a player only along the client's route, and computes none for an item: "I can't reach that!" |

**Items, content and tasks**

| Upstream | Here | Why |
|---|---|---|
| `inv.add(...).hasSucceeded()` (all or nothing) | `invAddAll` / `canAddAll` where the result matters | 274's `add` inserts what fits |
| Bank withdrawals and unequipping: remove, then add | `moveItems`, clamped to the room in the target (37 sites) | 254 lost the whole amount when the inventory was short of room, a plain 274 add the excess |
| Burying bones wrote the XP into `stats` | `addXp` | The Prayer level never rose |
| Ranged and Magic counted the inventory only | Worn gear counts | The wear script moves the bow, arrows and staff out of the inventory: the task found no gear, or banked for arrows it wore |
| The knife pickup went back to its via point every time | Passes it once | It looped between the via point and the castle gateway |
| Woodcutting and fletching with the hatchet in the bank: the recovery check ran in the deposit state too | Not once the bot is at the bank | It sent the bot back to `bank_walk` every tick: it stood at the bank for good |
| Smelting withdrew up to 28 of each ore in turn and kept the bars | The step's ores in proportion (copper and tin alike, twice the coal), as many bars as bank and slots allow; bars banked between loads | Copper filled the inventory, tin found no room (254 lost it), and the bot stood at the furnace with copper alone |
| Content names of rev 254 | 274's: 9 agility obstacles, `flax`, `spinningwheel`, `furnace1`, cooking ranges and fires by category, fletching dialogs `skill_multi3`/`skill_multi2` (and no `process.env` make-x switch), param `sa_energy` (110 is `prayerbonus`), no rune-essence exit portal, trees only with "Chop down" | A missing name never errors: the task just wandered |
| Names and ids that never matched | Ellis is `tanner`; dark wizards `bearded_`/`young_dark_wizard`; `adamantiterock`; any water source (no `pump`); toll gates by name (the list held ferns and a chest); silver and gem stall ids swapped back; `willowtree`… in BotTask.ts | Checked by test/content-names.test.mjs |
| Item ids naming the wrong object | Herring (was burnt fish), raw beef (a banknote of burnt bread), iron med helm (steel), the four cut gems (one gem off; 1609 is a members-only opal), short/long bows from willow to magic (swapped), five maces (banknotes) | A maple shortbow fletcher saw no progress and conjured the wrong bow; free worlds dropped gem cutting |
| Aemad's shop and the Falador fountain where 274 has neither | 2614,3293 and 2949,3380 | The herblore supply run and bucket filling never finished |

**PK, chat and names**

| Upstream | Here | Why |
|---|---|---|
| PKers attacked when the combat difference was within the *bot's* wilderness level (wilderness by z only) | The game's rule (pvp_combat.rs2): within the lower of both players' levels, with 274's bounds (x too) | They attacked players standing outside the Wilderness |
| Edgeville PKers took the nearest player and gave up if that one was out of range | The nearest player they may attack | Another bot nearby kept them from ever attacking |
| PKers stayed engaged while the target was within 40/55 tiles and in combat range | They also give up when nobody lands a hit for 30 engage ticks (about 35 s) | A target behind a wall or the ditch kept them engaged for good: re-clicking the attack also fed their watchdog |
| A bot answered fragments of its name with digits stripped ("ask", "fish", "trade" set off `sk1`, `fi1`…) | Only its whole name, on word boundaries, any case; once addressed it keeps answering that player for 30 s, but only lines an intent matches, and not lines that name another bot (neither keeps the conversation open) | Bots answered ordinary chat; upstream's 30 s answered every line with fillers ("Can you say that another way?"), and two bots greeted in turn both answered everything |
| Bots spoke with `Player.say` (the SAY mask), which the client shows unfiltered | Every line through the server's word filter (`port/BotSay`), as a human's chat; swearing shows as `****` | Bots were the only players whose swearing showed, and the ignore list cannot hide them |
| Idle lines with a player's name cut out (" hates attackishere", "Are you ignoring me, ?!"), said as they were | The gap is `{name}` in the data; the bot fills in a player near it (a human, sometimes the one playing, or another bot), or says another line; upstream's lines are otherwise kept, with the port's own lines after them | Half sentences; upstream's lines read like real chat with the names cut out |
| A reply joined to its greeting with a comma ("Yes Casey?, …"), ":D"/"lol" added at random | Joined, or decorated, only where the word filter leaves the whole line alone | 274's filter reads across words ("Hey Casey, Gl!" looks like a web address) |
| Level-up: "<phrase> (<stat> <level>)" | "<phrase> - <stat> <level>" | The filter masked "(hit" in every Hitpoints line |
| The marketplace took any line with need/buy/lf/sell/wts and words, matched item names by substring, and the line went no further | A request starts with buying/selling/wtb/wts and an item, or buy/sell and nothing but an item; the item is an object's whole name (singular or plural), never a members item on a free world; "No vendor is currently available for X" only for a real item; the line still reaches the bots | "I need help" got "No vendor is currently available for help.", and a line naming a bot got no answer |
| A bot that ended a conversation never listened again | Again after 30 s | — |
| `{total}` in replies was the Attack level | The total level; `{name}` the display name | — |
| "come here" queued a run, which the bot's task usually undid the next tick | The bot runs to a free tile next to the player and waits there 30 s (a sub-task); a trade request ends the wait; when it gets no closer it opens the closed door or gate nearest to the player; only PKers come into the Wilderness (the others answer "Not going in there!" by private message, and stop following when the player walks in); a bot in a trade says it is busy | It came only part of the way, stopped at the wall of a house, and a player could call bots over the ditch and kill them for the death overlay's coins again and again |
| Bots named `sk1`…`soc12` from `bots.config.json` | 170 2004-style names (`data/names.json`); slot i is `names[i]` with planner `PLANNERS[i % 8]`; a name a human character has goes to the next unused name from the end; none the word filter changes (before release, slots 106, 107, 132 and 147 were renamed from Dazza, Wazza 22, Noob Ollie and Cheese Puff); append-only from here | docs/BOTS.md §4.6; the bots hear a human's line after the filter, so a masked name could never be addressed |
| PKers wore upstream's members gear on a free world through `worn.set` | 60 free-world profiles (`port/BotPkGear`) with upstream's levels; members items brought from a members world go to the bank; no equip path puts a members item on there; an item that cannot be worn is never put on; the wear script's conflicts (no 2h over a shield); a weapon taken off ends a pending special | 274 takes a members item's ops and bonuses away on a free world; 274's wearpos is -1 (not null), so upstream put an unwearable hat into worn slot -1 |
| PKer target claims read `bot.task` (BotPlayer has `currentTask`): never matched | Claimed per PK kind, checked only for a player nearer than the best so far | Several PKers piled onto one target in multi-combat; each scan was O(players²) |
| Idle Edgeville PKers and patrolling PKers never fed their 300-tick watchdog | Waiting at the post and each patrol point reached count as progress | In an empty Wilderness they were teleported home about every 5 minutes |
| Combat bots swept for "gates" on timers, and any loc with Open and no Close was one | A gate or door is a loc in a wall (or a centrepiece named door/gate), never furniture or ground decoration; the verdict is cached per loc type; a combat bot opens one only when its walk toward its NPC stalls, an attack times out out of reach, or it is stuck | They walked to and opened drawers, cupboards, wardrobes and trapdoors again and again; the sweep was ~25% of the bots' CPU (now ~7%) |
| Combat NPC claims keyed by `npc.index` (274's Npc has none) | By `npc.nid` | Claims stopped matching once the NPC took a step |

**Trading**

| Upstream | Here | Why |
|---|---|---|
| The overlay's `[opplayer4,_]` made every bot say "One moment please" and take the request; only the trading tasks ever cleared it | `port/BotTrade.onTradeRequest`: a bot whose task trades (vendor, bankstand) and is free takes it (the first request wins); any other declines in a word and keeps no target; `p_bot_interact_trade(null, -1)` from `[if_close,trademain]` always clears the target; a target nothing took up is dropped after 120 ticks | An asked woodcutter, fighter or PKer stayed "trading" for good: deaf to its name, refusing "come here", saying "One moment please" to every later request |
| Trade buttons clicked on timers | `port/BotTradeScreen.TradeSession`: offers and the first accept only while the trade screen is open, the confirm accept only on the confirm screen; offers exact; every accept re-checks the deal; 60 s per screen, renewed by each change the player makes, then the bot closes the trade with a line; no walking or restock mid-trade; a task switch closes it | A player slower than ~3 s (a phone) was left at "Waiting for other player..." |
| Vendors and bankstand bots accepted with whatever was in their offer, and kept the change | Only with exactly the promised items in their own offer; change below one item's price goes back in their offer; an overpayment of one item's price or more is refused with a message | A refused members item left the bot's side empty and the player paid for nothing; up to 149,999 coins were kept |
| Vendors stocked members items on a free world | Free items only there | 28 of the 79 are members-only, and the trade screen refuses them |
| Bankstand bots priced "everything" from an empty stock list and offered their whole pack | Their stock is the sellable items they banked for; no trade before banking or when sold out ("brb, banking"); only the stock goes up; "all" is priced from what is actually offered, never 0; "no" only as a word; they bank with the bank window open and close it | Before its first bank visit and after every sale a bot sold everything, coins and gear included, for 1 coin; "noted logs" ended a trade |
| The social reward put its coins up at once | Only after the player opens the trade window (60 s, a nudge halfway); now no reward at all (a social bot is a regular of one hub: no tour, no tips) | Putting coins up cancels the player's pending request: it could be collected only within ~3 s |
| `interactIfButton` clicked any component | Only one the bot has open (the engine's own check) | — |

**Planner and tasks**

What kept bots from training, or kept them where their levels no longer belonged. Most of it never showed with level-3
bots; `sim.mjs --levels=N` (every skill at N) and `--scenario=aged` find it.

| Upstream | Here | Why |
|---|---|---|
| Combat, ranged/magic and thieving read `player.stats[HITPOINTS]` (the XP ×10, at least 11,540) as the current Hitpoints | `levels[HITPOINTS]` against `baseLevels` (`BotTaskBase.currentHp`/`hpBelow`): eat below 40 %, on to 80 %; with no food in the pack, off to the bank for some; with none there either and below 50 %, the task ends and the planner leaves combat alone until the Hitpoints are back (`CombatTask.fitToFight`); thieving's thresholds (5/15/20/30 Hitpoints) are shares of the maximum (15/35/45/60 %), its bank trip takes food | No bot ever ate, fled or stopped; as absolute levels a 10-Hitpoints thief could never start |
| Food: any of `FOOD_IDS`, best first; 15 sharks taken out at each bank trip, then 8 of anything | Only food the bot can eat here (`edibleFoodIds`: no members food on a free world), best first, up to 15; members food in the pack goes to the bank on a free world | 274 takes a members item's Eat op and category away on a free world: the eat script never ran, and the bot "ate" the same shark for ever |
| InitTask's bank seed: every scimitar and armour set from iron to rune, 999,999,999 sharks | No seed (earned gear): a new bot gets its starter tools, an iron scimitar (as upstream: the combat steps past the chickens ask for one), 5 shrimps and 200 coins (starter items skipped when it has them anywhere, and the bronze axe and pickaxe when it carries one its level allows). It buys its gear (`port/BotGear`): before a combat task, the next piece its levels allow that a shop sells, above what it owns in that slot, when it can pay (keeping 100 coins): Zeke's scimitars, Horvik's platebodies, Louie's platelegs, Peksa's full helms, Cassie's kiteshield, and more shops for the kind of piece its taste likes, then an accessory. It wears the best piece it owns in each slot | A level-3 bot owned rune and never ran out of food; aged bots (`BotAge`) bring the kit their levels earned |
| Shop trips: the coins from the table's price, the item made, sold out or not; a shopkeeper behind a shut door never reached; a failed trip tried again at once | Bought through 274's shop interface (buy 1, 5 or 10 a click: the shop's own price and stock), walked up next to the shopkeeper by `walkTo` (which opens the door on the way: a route that stops short of its destination tries the door first), a trip that bought nothing not tried again for an hour of play; a bought piece of gear goes on | Upstream made items from coins; Peksa's shop (behind a door and a counter) was never reached |
| Combat sold everything but its tools, coins, grimy herbs and the air talisman at Lumbridge's general store, its food too; the raw beef and chicken its kills drop had no cooking step | Food and raw meat go to the bank; cooking steps for raw beef and chicken at the four ranges (274's `cooking_generic`: level 1, 30 XP), so the cooking priority cooks a fighter's meat once there is half a load; a fighter with no food buys kebabs from Karim in Al Kharid (his dialogue, a coin each) when within 250 tiles of him (`FoodTripTask`); without food, a step's weak monsters (at most half its combat level, at least 3) are fought down to 30 % of its Hitpoints (`CombatTask.fitToFight`) | Earned food: no bank of swordfish any more |
| A ranged or magic task's bow or staff stayed in hand, and combat steps that need no weapon (chickens, cows, goblins) were fought with it | The combat task swaps a weapon that is not a melee one for the best melee weapon the bot can wield: one it carries at once, one in its bank at the bank, else it fights bare-handed | An aged bot fought chickens with an oak shortbow and no arrows for 3,000 ticks: no hit, no XP |
| A newcomer got InitTask's starter tools and 200 coins and played as its planner from its first tick | Tutorial Island's kit (274's tutorial.rs2) and 25 coins in the bank; until combat 10 or total level 60 a newbie (`port/BotNewbie`): it wields the bronze sword and wooden shield, wanders the courtyard (`NewbieTask`), kills chickens and cows, asks newbie questions and begs players near it (3-8 lines an hour; a slow leveller 1.5-4), and now and then thanks the line after its question; its plans end with its newbie time | Newcomers who look and play like new players |
| PKers fought on with no food to their death, never prayed, used a bow only as some members builds' special weapon, and said nothing after a kill | Smarter PKers (`port/BotPkTactics`, both PK tasks): Protect Item and the protection against the target's style (from its weapon), pressed on the prayer tab as a player does (the game checks the level and the points), switched with the target's, off after the fight; a bow for a target that keeps 3+ tiles off for 3 ticks (a free world's build: the oak shortbow and steel arrows, the best free ones in 274), the weapon again when it is close; below 30 % of its Hitpoints with no food left it runs for the bank, out of the Wilderness, fighting no one on the way; "sit", "gf" or "ez" to the player it killed. With `port/BotPkFight`: no bow on a melee PKer (a ranger fights with its shortbow), and when to eat and to get out (a run or a teleport), the potions and the KO switch are `BotPkFight`'s; the melee boost prayers (the best Strength and Attack ones its Prayer has, all fight long or for the KO; none for rangers), and PJing (`port/BotPkPj`) | PKers that fight like 2004's; 274 has no Wilderness ditch to run for |
| Only woodcutting, fletching's logs, mining and fishing answered an attacker: they ran from a monster above the bot's combat level, to the middle of their spot; every other task walked or worked on; `findAggressorNpc` took any NPC that targeted the bot | Every task but the fights and thieving: BotPlayer asks `port/BotDefence` first. A monster of at most the bot's level is fought off while the bot is above 40 % of its Hitpoints; a fight where no blow lands either way for 24 ticks is a stalemate (two warriors at a bot in a single-combat area: it hit neither); any other, or once hurt, is run from, running: of the routes 12 tiles straight away from it and a quarter turn either side, the one that ends farthest from it (out of a fenced field by its gate; searches never refused for the budget), on again while it chases (at most 40 ticks); the third run in 10 minutes ends the task. Only an NPC acting on the bot counts (its op/ap player modes), not one running from, following or facing it | 274 lets a busy player (at a tree, on a walk) take hits without hitting back, and an idle one auto-retaliates, at a bear too: Lumbridge's giant spiders (aggressive to combat 4 and below) and its bear killed level-3 woodcutters, fishers and a bot on a shop trip, 3 or 4 in a 50-bot hour, and a goblin a hurt fighter walking off for kebabs; none since (`sim.mjs` fails on a death at a skill or an errand) |
| Social bots of any level kept the Draynor hub (the bank's road) and toured the riverside, both by the young dark wizards (aggressive up to combat 14, from a distance) | Below combat 16 a social bot neither keeps nor tours them (`SocialTask.DARK_WIZARDS_COMBAT`), upstream's own rule for woodcutting and fishing at Draynor | Two level-3 social bots died there in a 25-bot sim |
| A combat step wanted its scimitar (iron from 15, steel from 35) in the pack | Any melee weapon of that metal or better that the bot can wield, worn, carried or banked (`combatWeaponFor`); a banked one is fetched first; the planner, the level-up and the bank trip's re-roll all use it | Each bank trip equips the best scimitar from the seed, so from Attack 35 fighters started Combat, could not run it and earned nothing, and the re-roll found only chickens, goblins, cows, rats and spiders |
| `getProgressionStep` picked any step the level allowed; tasks drew one every tick and jumped to any with a higher minimum | Mostly a step that suits the level: within 10 levels of the best one it allows (`suitedSteps`), any 15 % of the time; a task changes step only when the level rises and the current one is outgrown (`levelUpStep`), to one it has the tools for; cooking, smithing and firemaking keep the step the planner chose for the bot's materials | A level-40 fighter drew Lumbridge's monsters 9 times in 21; within ticks of starting a task jumped to the highest step, tools or not (a cook with raw shrimp sent to cook swordfish) |
| With Mining and Smithing 40 a crafting priority took every pick, and its first answer was flax | The priority only with 5+ gold bars to ring (as cooking and smithing claim the bot only with materials); a ring mould in the bank counts; wool is no longer closed from 40/40 | All 16 bots of a sim picked and spun flax for 5,000 ticks; on a free world they bought ring moulds, banked them and bought more, and the wool they were sent to could not run |
| Shops the planner uses: not Gerrant's; net fishing to level 40 | Gerrant's (Port Sarim) too; net fishing to 99, as the step of last resort | From Fishing 41 a bot without a pot, harpoon or fly rod never fished again |
| Mining, fishing: tools only from the pack; mining rocks chosen by Mining level | Tools from the bank too (fetched first; an axe or pickaxe the bot's level allows); the rocks of the step's own ore first (the level's where the mine has none); a rock the bot could not get at twice is passed over | A combat trip banks every other skill's tools; a bot sent to the Karamja gold mine looked for coal there; Barbarian Village's coal, from the wrong side of the fence, was tried for good ("I can't reach that!") |
| Thieving: after fleeing a failed attempt, always to the bank | Back to the stall or NPC unless hurt | Read right, the Hitpoints made every failed attempt a walk to the bank and back |
| Ranged/magic: the low-ammunition check ran in every state | Only while fighting; the task's watchdog is told of XP; the mode's own skill is watched; the planner asks the task whether it can run | A bot already on its way to the bank for arrows was sent there again before it took a step, for good (the watchdog is paused while banking); a bot that trained fine was teleported back every 150 ticks |
| Smithing: a smelting step switched to the anvil a quarter of the time; bars by level | The step decides (furnace: ores; anvil: bars, hammer from the bank too); the step's own bars; the priority only hands out a task that can run | It walked to the furnace's tile looking for an anvil; with steel bars banked an iron-bar step found none of its bars, again and again |
| Combat: the style moved on only when a hit and the kill fell in the same tick | When the NPC it hit leaves the world | Fighters trained Attack and nothing else |
| Combat: the nearest NPC, reachable or not; the watchdog sent the bot back to the same spot | An NPC it found no way to is skipped for 200 ticks; a spot where nothing came of 150 ticks is not picked again by that task | Hobgoblins across water: the bot stood still until teleported to the same spot |
| Every dungeon step went through the Taverley trapdoor; a bot leaving to bank came up there | The dungeon's own way in and out (`dungeonRoute`: Taverley's trapdoor, or the surface above the spot); a bot under attack teleports at once; `walkTo` climbs out of a dungeon first | Hill giants are in Edgeville's dungeon (Taverley is members-only on a free world); a hurt bot's teleport waited for a moment without a hit and it stood in the fight until it died; a task that began underground wandered there |
| The Crafting Guild coast's hobgoblins at 2885,3284 | 2908,3287 | In the sea, and no hobgoblin can be reached from around it |
| A PKer drew its build at every start | From its name (`BotSeed`), from tables that come out the same at every start | With log-in sessions its levels and combat level changed every time it came back |

**Movement, tasks, chat and trade: the second pass**

| Upstream (or the port's first version) | Here | Why |
|---|---|---|
| `botTeleport`: the spellbook cast, then the jump, for every stuck walk, watchdog, gate, boat and hub hop | A silent jump only where no human can see either end (`humanCanSee`, `HUMAN_SIGHT` 17), else refused (`false`): the caller walks or waits; the walk queue and the interaction dropped; a dead bot does not jump; counted in `teleportStats` | Players in 2004 walked (the teleport policy, docs/BOTS.md §1); bots slid while casting and walked back after landing |
| `ProgressWatchdog` counted every tick but bank trips; its destination set once | A walk away from the destination counts one tick in four, a pause past 600 ticks counts again, `follow()` tracks the task's current step; CombatTask counts only a stall at the spot against it | Fighters were teleported mid-walk every ~150 ticks, gave up on the spot and walked to another; a thief that never left its bank states never stalled |
| `StuckDetector` compared distances to different destinations | A new destination starts a new window | PKers on patrol were "desperately stuck" (and teleported) while walking fine |
| Loc clicks with no route; NAIVE movement | A client's route to the loc with the click (`BotPathing.botPathToLoc`), SMART movement for NPCs; the door on the way opened first (`_openDoorToward`, door walks that stick, doors found shut skipped 500 ticks); stairs and ladders crossed from their approach tile | 274 routes no player to a loc: "I can't reach that!" at ranges, rocks, booths and stairs; upstream opened the nearest door, locked ones too |
| Lumbridge castle's wheel and Seers' flax by teleport | The castle's south-west stairs and Seers' spinning-house ladder are gateways; flax goes to the nearer wheel | The teleport policy |
| `BotNeeds`: every axe or pickaxe tier required, pack only | One need per group of alternatives, owned carried, worn or banked; bank coins count (a shop trip fetches them); a bulk item needs 50 to start | 56 to 255 coins could not "afford" woodcutting; bots re-bought banked tools (a fifth of levelling time in shop trips) |
| Thieving: the food it withdrew was a "stray item" | Food is kept; an attempt is judged after its cooldown (XP feeds the watchdog, a stun is waited out); 3 to 5 ticks between attempts; stalls from combat 20 | A port regression: members thieving never stole |
| Mining: two "misses" banned a rock for the task | A miss only when the rock is still full after the interaction ended; misses expire after 500 ticks; rock claims; a held interaction is waited on | Miners ran out of rocks within half an hour |
| Woodcutting: the stump checked before the log; a click after every log | The log first; no click while chopping; no Woodcutting level for axes (woodcut.rs2) | A teleport every 300 ticks at normal trees |
| Fishing: a click after every catch and every 8 ticks | A click only when the interaction is gone; Al Kharid has no wizards; Draynor's shrimp step | A click mid-cast stops it (13 catches of 45 casts) |
| Firemaking: always the Lumbridge road; a step away 8 ticks after lighting | The step's own place; waiting while 274 lights the dropped log; a step aside only where a fire cannot be lit | Bots blinked between the road and their step's town; logs left on the ground |
| Anvil smithing: XP per click on the anvil | The smithing interface's make 10 on the step's product (`interactIF_UseOp`) | XP from nothing: 10 levels from the same 11 bars |
| Fletching: chopped even with logs banked; stringing 27 + 27 | Banked logs withdrawn and fletched at the bank; 14 + 14 | Fletchers were mostly seen chopping |
| Cooking: a random range, a fish per 6 to 10 ticks, from 5 fish | The nearest range (Lumbridge castle's too), the game's pace, from 14 fish, burnt fish dropped | Half of cooking time was bank walks |
| Combat: re-engaged an NPC it could not hit for good; armour off at every switch | Two re-engages without a hit and it is skipped 200 ticks; the attacker fought first; flee away from the chaser; gear stays on; warriors from 15; the ice dungeon from 45 | Fighters stood re-clicking; they came back from logout in plain clothes |
| PKers kept the engine's attack after dropping a target | The attack is cleared; only a real attacker is engaged | A frozen PKer, up to a whole session |
| Chat: greetings and intents as substrings; the filtered line | Whole words, shorthand spelled out, the bot's name taken out; the line as typed | "this" and "fishing" made questions greetings; "noob" was masked before a bot heard it |
| `onLevelUp` never called | Called from the levels each tick (direct writes skipped), one line per 300 ticks at most, milestones always | No level-up lines at all |
| Deposits added notes as notes; bankstanding ended only by the rescan | Notes bank as items (`bankedId`); a stint ends on its own; no switch in a trade | Noted stock was lost to the planners; trades closed at the confirm screen |
| Runecrafting: a jump onto the essence rock's corner, essence and Mining XP added by hand; an altar looked for as `altar` | The rock clicked from where the bot is (its route to the rock's side) and the `<name>_altar`: 274 mines, binds the runes and gives the XP; free altars only on a free world | Mining XP twice; no altar ever found, so the bot made the runes itself |
| Herblore: banked coins counted but the pack's spent; filling, cleaning and mixing done by hand whenever a script refused | Coins from the bank first; only the game's scripts (they check the world and the level: attack potions from 3), a refusal ends the task; a batch under way is finished | Bots went round buying nothing; potions at any level |
| Crafting: the tanner, the leather and the ring interfaces never pressed (items and XP swapped after 3 ticks); no hard leather; chaps at 14, the body at 18 | Trade with the tanner and its "tan all" (soft, or hard for the hard leather body); the leather interface's make 10; the jewellery interface's ring; gems only as the game cuts them; 274's levels and XP; a chisel in the bank counts | Every leather item and ring was made by the bot itself; nobody reached the hard leather body |
| Smelting: the watchdog was told of every click; any ore counted | Told of a smelt only (XP, or ore used up); a bar's worth of the step's own ores | A bot clicking a furnace it never used was never moved on |
| `interactHeldOp` and `interactIF_UseOp` skipped the engine's checks | The item's option must exist and the interface be open; an item click ends the pending action, as a player's does | Eating did not stop an attack |
| 1.0 Agility XP for every change of task; 2.0 XP to a random melee stat for every hit that landed | None: only the game's XP | Bots level at the world's rate, as the player does |
| Every planner an eighth of the bots at any N (62 vendors at 500 online) | 70 % of the places to the levelling groups (17.5 % each), 30 % to the extras (7.5 % each: vendors, social bots, both kinds of PKers), at every size (`onlineShare`, in whole percents: 15 vendors in a pool for 100, not 16); a new pool takes no more extras than twice their share; a group short of its place gets fresh names of its own up to one short of it (a store saved under the first mix: up to 100 online its levelling groups, above it its extras), newcomers shed what that added (`poolKeep`, in `_meta.world`), and extras past their cap quit first | The role mix: most players level; an eighth each made 62 vendors at 500 online |
| Newcomers at the road by the castle, 30 s–4 min after a new character | Where 274 puts a player off Tutorial Island (the courtyard), once no human is on the island | They meet the new character as it arrives |
| Bots spoke with `Player.say` (the SAY mask) | A typed line, the CHAT mask (`port/BotSay`: packed and filtered as a human's; adverts sometimes in colour) | Ignore hides a bot, as it does a player |
| Addressed only by the whole name; private messages but "come here" dropped | Also the name without its spaces or with its digits apart, a first name unique in earshot (not a word a line about something else may end with: "ask the fish trader" is not for Trader Ted), the answer within 30 s of the bot speaking to the human first (`port/BotSpoke`); "gz" to a level-up line gets "ty", a "hi" for nobody now and then "hi"; private messages answered; friend bots message first about every 20–40 minutes | Conversations that feel like a player's |
| "what are you doing" got "Just chilling, you?" or "Doing some skills atm", whatever the bot did; "whats ur cb" got "Training combat gets boring fast lol"; no emotes | Answers from the bot's own state: what its task does and where (`port/BotActivity`, from the task's step: "Cutting willows in Draynor, you?"; the place from `port/BotPlaces`, which names 35 places of 2004 and "in the wild"), its combat level, where it stands ("In Varrock atm"); a line naming a skill keeps the skill's answer. Emotes through the controls tab's buttons (`port/BotEmote`): a wave with 30 % of greetings and half the goodbyes, a laugh with 40 % of jokes, a dance when asked, a cheer at 99 and half the other milestones; none while the bot is in a script, a trade or at something | Livelier chat; every new line passes the word filter (test/chat-filter.test.mjs, with every step's activity and place) |
| Lines the filter starred without swearing ("**ned!", "A**ing a skill", "*****orlds") | Reworded minimally ("Owned!" and "Priorities, you know?" dropped: upstream had the clean twins) | Minimal changes to upstream's lines; "noob", "sucks" and the swearing stay starred |
| Every vendor at Varrock West, any item, upstream's prices, buy-back at 0.7 of them with 500M coins refilled | Stalls at the 2004 trade banks (`port/BotTradeSpots`), a talk budget per bank, value-based prices and stock sizes (`port/BotPrices`), a line of trade from the name, the game's item names (aliases where ambiguous), 2004 prices, no "12x" or "@" | No profit loop, no advert flood; "Selling 7744x noted Green Partyhat" read as a joke |
| A vendor past every bank's vendor stalls stood on one of 4 tiles at Varrock West, with every other such vendor; Varrock West took vendors as often as 3 other banks | About half the vendors at Varrock West, the 2004 trade hub: its home bank for half the names, and every vendor whose home bank is full; its stalls, then a crowd in the bank hall and on the road in front, a tile each (the nearest free tile of two patches, reachable from the bank, never a stall nor beside one, where a stall's bots step about), which its vendor walks onto and keeps to; one or two at every other bank (a members town's vendor tries the other members towns first); 25-50 adverts a minute at Varrock West, 12-20 elsewhere (about half the vendors on an auto typer) | A crowd at the trade hub is right; with the role mix at every size 500 online has about 38 vendors |
| Every bot rescanned in the same tick; variety picks went back to the first steps | Each bot's rescan timer starts at a point from its name; a variety pick stays within 20 levels of the best step | Route-search spikes every 600 ticks; fighters of 40 at chickens |
| A new activity at every rescan whose pick differed (about every 6 minutes); a random spot over the map after every load (fishing, mining, woodcutting, combat) | A plan of 15–60 minutes (`BotPlayer` `PLAN_TICKS`): the rescan switches only when it is over, or when a levelling bot has had no XP for 15 minutes; a step's spot weighted by its distance from the bot (`BotKnowledge.pickStep`, 1 / (1 + (d/200)²)); the spot kept after a load | Activities that last, near the bot; much of a session was spent walking between jobs |
| Social bots teleported to a random hub at the start and every 10 minutes; approached anyone in reach, every few seconds | The nearest hub, a stay of 30–90 scans, then a walk to one of the two nearest; an approach every 15–30 s at most (never to a player in a dialogue or a fight), no line twice in a row; now a regular of one hub (`tasks/SocialTask`) | The teleport policy; a crowd of social bots pestered a human without pause |
| PKers teleported to their zone at the start, to a far zone, and to the bank; Edgeville PKers to Edgeville after every death; a step of ±4 tiles every 150–300 ticks | They walk: to the nearest zone, then a neighbouring one; Edgeville PKers patrol the ditch (a spot every 20–60 ticks) and bank every 1,000–2,000 idle turns; the "far from Edgeville" death check waits while they walk back | The teleport policy; a row of motionless PKers at the ditch |
| The toll gate and the Karamja and Brimhaven–Ardougne boats by teleport (30–40 casts in 10 minutes at the gate) | Crossed the game's way (`BotAction` `SCRIPTED_CROSSINGS`): the border guard (free: Prince Ali Rescue done), a Port Sarim sailor, a customs officer or Captain Barnaby (30 coins each way: fishing and mining fetch the fare from the bank, `crossingFare`), the gangplank off the deck; chat pages continued as the client's "Click here to continue" does, choices only when their buttons are on screen; an unseen jump only if a crossing fails (3 tries or 200 ticks); the stuck checks wait while one is under way (`isCrossing`) | The real gate and boats |
| Runecrafting: a jump into the essence mine and onto the altar from anywhere; essence and runes made "manually" when 274's scripts were slow | Aubury's Teleport (op4) in Varrock, the mine's portal back, the talisman on the altar's ruins, the temple's portal out, all walked; only the game mines and binds (a mine or altar that does not answer ends the task); Cosmic through Zanaris (the dramen staff worn through the swamp shed's door, `UtilTasks.keepQuestItems` puts one in the bank of a runecrafter that can bind cosmic runes and owns none: Lost City is done; not at login, so a bot comes back exactly as it left); no Law or Chaos (Entrana, the Wilderness maze) | Walking; upstream's fallbacks made XP from nothing; Cosmic is reachable in 274 on foot |
| Herblore: jumps between Aemad's in East Ardougne, the Falador fountain and Betty's in Port Sarim | Jatix in Taverley for the vials and the eye of newt (274 stocks both), the Falador fountain, Falador West bank, on foot | Walking |
| A task waiting on any open script (`player.activeScript`) | A chat page left open (a level-up, the mine's "too full") is clicked away (`botContinuePage`); a walk is never held by one (walkTo answers a crossing's dialogue); a script that is over is none (`botScript`: the engine leaves firemaking's in `activeScript`, ended in the world queue) | Runecrafters stood at the toll gate and in the mine for good; a bot that had lit a fire never emoted, waited at the anvil and the furnace until a watchdog moved it, and could not cross a boat it had no fare for (a Seers skiller stood at the Ardougne docks for 1,000+ ticks) |
| Long walks aimed at a point up to 60 tiles along the straight line (angle sweeps when it failed), routed between regions by hand-drawn gateways | A walking graph (`port/BotWalkGraph`, `data/walk_graph.json`: a node every 16 tiles, an edge where 274's path search walks from one to the next in at most 1.5× their distance + 6 tiles, doors and gates closed; A*, cached; free areas only on a free world, the Wilderness avoided unless it is the destination). A walk of 40+ tiles heads two nodes ahead; when the graph joins the bot and its destination with no long detour and an open last leg, the gateways are skipped (upstream's 'Lumbridge' gateway sent bots north of the castle to and fro for good). The graph keeps off tiles that NPCs which block players stand on (Draynor Manor's nasty trees: the path search does not see them, a player's step does), and a route the bot has not stepped along for 5 ticks is dropped and walked again in shorter legs | Falador's walls, the farms south of Falador and west of Lumbridge, Karamja's jungle and the nasty trees stopped bots until a rescue jump; `test/walkgraph.test.mjs` walks 14 such routes with no jump |
| The tick's path-search budget went to whoever asked first | Its last search is kept for a bot that has had none for 20 ticks (`STARVED_SEARCH_TICKS`) | A bot that walks now and then (a social bot's stroll) asked only on ticks whose budget was gone and stood on one tile for 300+ ticks |
| A rescue jump at any moment | Not while a script moves the bot (an agility obstacle, a sail): `botTeleport` waits | 274's `agility_walk` steps toward the end it worked out: a bot jumped away mid-obstacle overflowed its stack every tick |
| Ranged: arrows picked by the coins, whether or not the bot had them | Picked gear the bot never had is bought (Lowe, Zaff, Aubury); three bank trips that do not put it in hand end the task | An aged bot with 107 bronze arrows and coins for steel went between its bank and its gear check for 1,500 ticks |
| A fresh bot on any unblocked tile within 5 of its post (a vendor's bank, the PKers' Edgeville bank) | A tile walkable from the post (`BotAction.tilesInReach`); a bot saved within 6 of a bank's middle but outside its walkable square logs in on the hall side (`BotManager._behindCounter`); a vendor is at its stall within 2 tiles only on the same side of the counter | A vendor stood behind Varrock West's counter: a third of its spawn tiles were there, 19 % of Edgeville's (two PKers paced behind it all session) |
| The gateway picker scored each gateway by distance alone; the nearest graph node only; a gateway's script cut short by the next walk | A gateway whose far end is not in the walking graph's region of the next leg is passed over; the chain's gateways the graph walks past are skipped; the other reachable nodes are tried when the nearest does not route; walkTo waits 8 ticks for a gate script the bot set off; a boat without the fare only as a last resort; `crossingFare` from the graph's regions, and the planner skips steps whose fare the bot cannot pay | Seers to Draynor over both boats and Karamja; White Wolf Mountain climbed and descended for good; bots pacing by the Brimhaven fence; the Gnome Stronghold's gate; broke fishers jumped across the Karamja boat |
| Stuck checks: progress as the straight-line distance to the destination; the watchdog counted one walking tick in four | Also progress along the walk's leg (`BotAction.walkLeft`: the graph route left); a walk nearer along it than ever is no stall for the watchdog; a stuck check after a pause starts a new window | Correct walks that lead away for a while (over a hill, round a wall) were jumped; short trips back to the same bank were "stuck" against an old snapshot |
| Fighters opened the closed gate nearest themselves and never clicked their target again; loot they could not pick up drew them back every tick; archers and mages re-clicked monsters behind walls; thieves stole in front of guards; a hurt bot with no food walked to the bank with the monster on it; a fight through a wall went on for good | The gate on the way to the target (`closedGateBetween`, `openGateLoc`), then the target again (2 tries, then skipped); goblin mail and loot not picked up in 10 ticks left; an unreachable map for archers and mages; a thief waits up to 30 ticks for the stall's guard or owner to look away and for its stun, and answers a guard through `port/BotDefence`; a hurt fighter or archer runs (`runFromAttackers`), also from two or more attackers; a stalemate of 24 ticks ignores the attacker until the bot is hurt | The biggest share of rescue jumps (gate tours); thieves fought guards for hours; a bot stood in the goblin hut east of Lumbridge for 42 minutes swinging at a spider outside |
| Crafting: 14 wool, spun one ball a click, banked at Al Kharid; shears used on the nearest sheep; flax pickers jumped to the field | A full pack, spun at once (the wheel's Spin and Make X); about half the crafters (by name) leave the wool at the Lumbridge general store (274 pays 0 gp a ball), the rest bank; the wool task within 250 tiles of Lumbridge; sheep sheared from inside the pen; flax pickers walk and pick their way out of plants | Crafting levelled at about 300 XP an hour; sheep across the fence; a mix of selling and banking |
| Smithing on any tin at all, at a furnace drawn at random | 14 bars' worth (bronze: copper and tin both), at the nearest furnace or anvil | Miners walked across the map for a bar or two |
| Willows only at Draynor and Port Sarim; Catherby's fishing spot unused; ice giants at 2814,3509; no tuna | Willows at Seers and Catherby; tuna, lobster and swordfish at Catherby, Catherby's range (tuna from Cooking 30); the ice giants in the Asgarnian ice dungeon | More of 2004's spots; 2814,3509 is a cliff pocket on White Wolf Mountain no walk reaches |
| Every launch drew the online bots afresh (about half changed at each restart) | The living world is kept in the store (`BotManager.exportWorld` → `_meta.world`): the same bots come back first with the rest of their sessions, and the away bots' absences and the newcomer clock carry on, each capped at the run's own timing | The world continues after a restart |

**A fighter's junk sale**

| Before | Here | Why |
|---|---|---|
| A full pack sold everything at the general store but the fight's tools, coins, food, raw meat, herbs, the air talisman and the wardrobe items | Also banked, never sold (`CombatTask._keepFromShop`): what the pack held when the fight began (`_notePack`: a Treasure Trail's reward, the piece a gear trip took off, another task's leftovers), any rune, any skill's tool (`port/BotParty.isTool`), the status pieces (`port/BotFashion.statusPieceOf`) | A trail's casket (274's easy table: black (t) and (g), runes, studded, bows) went to the shop at the next full pack: a black platebody (g) turned up in Lumbridge's store; a 250-bot aged hour also sold law, nature and death runes, rune pickaxes and axes, adamant armour |
| Every fighter walked to Lumbridge's general store to sell, from anywhere | The store nearest its spot (`port/BotChains.nearestGeneral`: Lumbridge, Varrock, Al Kharid, Falador, Edgeville, Rimmington) within `JUNK_STORE_RANGE` (80 tiles), else the bank only | Upstream's one store: fighters at Varrock, Falador or Edgeville crossed the map with a full pack, and Lumbridge's store filled with the whole world's loot |
| The sale clicked every junk item each tick until the pack was no longer full or held no junk | After `IDLE_SELLS` (3) clicks in a row that changed nothing (the shop refused) it goes to the bank | 274 refuses a sale when the store's slots are full ("The shop has run out of space.") or a stack's coins have no room in a full pack: fighters clicked a cowhide 200-360 times, the aged sim's stall check caught one at Lumbridge's store |

`test/fixes.test.mjs` ("junk sale") checks the first two; the aged sim's stall check the third.

**Kept as upstream, on purpose:** bots keep their items when they die and a human who kills one gets 1 to 50,000 coins
(the runtime's `death.rs2` overlay); the deep-Wilderness PKers hunt humans only and the Edgeville PKers anyone, bots
included, neither outside the Wilderness or combat range; social bots may lure a player into the Wilderness; each PKer
task picks a combat build (its own, from its name) and sets its levels; the fletching fallback still makes
items and XP itself when its dialog does not open (it never did in the coverage runs); some log throttles use the wall
clock (logging only).

## A new bot world's ages

`port/BotAge.ts`. A bot store that is new (no `bots.sav`) gives the bots created with it an age
(`BotStartOptions.ageNewBots`; `BotManager._spawnBot` calls `applyAge` for a bot without a save that is not a newcomer,
after the Lumbridge tile, the appearance and Herblore 3, before the varps, the free-world coordinate rule and
`buildAppearance`), so a new world has newbies and veterans from the first minute. Bots that join later start fresh.
Everything comes from the bot's name (`BotSeed`, never `Math.random`): a bot that leaves before its first save comes
back the same.

| Tier | Share | Total XP | Combat level (10th / 50th / 90th percentile, levelling planners) | Coins in the bank | Starts by |
|---|---|---|---|---|---|
| newcomer | 25 % | fresh | 3 | — | the Lumbridge spawn |
| novice | 25 % | 10k–60k | 6 / 15 / 26 | 100–1,500 | Draynor, Al Kharid, Varrock east, Falador east |
| intermediate | 25 % | 60k–300k | 15 / 32 / 45 | 1k–15k | Varrock, Draynor, Falador, Edgeville, Al Kharid |
| experienced | 18 % | 300k–1.2M | 29 / 50 / 64 | 10k–60k | Varrock west, Falador, Edgeville; Catherby, Seers, Ardougne |
| veteran | 7 % | 1.5M–5M (the top: about 20M) | 51 / 72 / 107 (the top veterans 100-120) | 40k–200k | Edgeville, Falador west, Varrock west; Seers, Catherby, Ardougne, Yanille |

* **Stats.** The total (log-uniform in the tier's range) is split over the skills by the planner's weights
  (`Personalities`; the random planner's from its name; social and vendor bots the balanced ones), each weight shaken
  by ±50 %. Hitpoints 1,154 + a third of the combat XP; Herblore at least 3; levels from the XP; the engine's combat
  level. On a free world the members skills get nothing (they stay at 1, Herblore 3) and the others keep the share they
  have on a members world, so the total is lower there. The veterans' range was raised from the 1.2M–4M first tried:
  their median combat level came out at 65.
* **Top veterans**: about 1 veteran in 4 that is no skiller (about 1
  bot in 100; `port/BotLooks.isTopVeteran`) has Attack, Strength and Defence at the level (each within 4 of it) that
  gives a combat level drawn in 100-120, Prayer 43-70 and the Hitpoints of that combat XP; its other skills keep a
  veteran's XP.
* **Look** (`agedLook`, the name's dice 'look' and
  its taste, `port/BotLooks.gearTaste`). Armour per slot of the kind it likes (a full or medium helm or none, a
  platebody or a chainbody, platelegs or a plateskirt for half the women, a kiteshield, a square shield or none) and the
  metal its Defence allows or 1-3 below it (50/30/15/5 %), about 3 in 10 in a matching set of one metal; a slot bare now
  and then (30 % of a novice's, 3 % of a veteran's); a novice's shield the wooden one now and then; never above its
  Defence, never a members item on a free world. A skiller's look (85 % of the skillers, 30 % of the balanced and random
  bots; `skillerLook`): its plate and scimitar in the bank, its hat (a blue or black wizard hat or a chef's hat) and
  apron on. From combat 20 (a few from 10) the cape (of seven colours: red, Thessalia's, and the dyed ones), gloves and
  boots it likes; from combat 40 an amulet of strength or power more often than not (a members veteran's a glory now and
  then; a top veteran always; a members top veteran's cape of legends now and then). The scimitar its Attack allows in
  its hand: the starter weapon's place (before, the starter weapon kept the slot and the kit's scimitar was lost). The
  rare of about 1 bot online in 60 (experienced and veteran only, `rareOf`: 35 % of the rich vendors, 30 % of the rich
  social regulars, 2.5 % of the rich levelling bots: they stand at the hubs, where 2004's rich players showed theirs
  off) on its head, its helm in the bank; a veteran's bunny ears (or a skiller's scythe in both hands, its weapon in the
  bank: about 1 veteran in 4, `holidayOf`).
* **Kit.** Worn: its look. In the pack:
  the axe and pickaxe its levels allow (InitTask then leaves out the bronze ones). In the bank (the tasks fetch from
  it): fishing gear for its level (fly rod and feathers, harpoon, lobster pot), a bow and arrows and a staff of air with
  mind (and chaos) runes when it has trained Ranged or Magic to 10, 5–30 cooked fish of its Cooking level, 10–40 of what
  it gathers most (logs or ore: bankstanding bots sell what they bank, so only a few) and the tier's coins. Never a
  members item on a free world. InitTask still runs on the bot's first tick (200 coins, the starter tools), and leaves
  out what the bot already has.
* **Start tile.** A walkable tile within 3 of one of the tier's banks with a route to the bank tile (the customer side of
  the counters), allowed on the world (free banks on a free world). Newcomers, social and vendor bots keep the Lumbridge
  spawn (the latter two walk to their posts).
* **PKers** are never aged: their tasks set their builds. **Social and vendor bots** never gain XP: they get the levels of
  their tier and a look, worn only: armour 4 times in 10, the scimitar half the time (most of them from
  combat 40; else the starter weapon stays), the accessories they like, the rare of the few; nothing in the pack or bank.

`test/age.test.mjs` checks all of this on both worlds; `sim.mjs --scenario=aged` runs such a world: the tiers spread,
every aged levelling bot gains XP within 3,000 ticks of logging in, and no bot but a vendor or PKer stalls for 300.

## Task coverage on 274

`test/sim.mjs --scenario=coverage` gives one bot each task kind with what it needs and checks that it starts the task
and gains its XP (or its items) within 2,500 ticks. Every task kind the upstream planners can pick progresses. The cases
from "combat (Al Kharid warriors, rune scimitar worn)" on are the [planner and task fixes](#port-notes-what-behaves-differently-from-upstream-and-why)
(each fails on the library before them); in the "planner:" ones a planner with those skills picks the tasks. The cases
from "combat (goblins, Lumbridge)" on are 2004's crowd spots (each fights where the planner sends its level band) and
the Al Kharid mine's iron:

| Task | Case | Members world | Free world |
|---|---|---|---|
| Woodcut | woodcutting (trees, Lumbridge) | Woodcutting +2075 XP | Woodcutting +2425 XP |
| Woodcut | woodcutting (axe in the bank) | Woodcutting +2425 XP | Woodcutting +2700 XP |
| Mine | mining (copper, Varrock west) | Mining +420 XP | Mining +980 XP |
| Fish | fishing (shrimp, Al Kharid) | Fishing +480 XP | Fishing +460 XP |
| Combat | combat (chickens, Lumbridge) | Defence +116, Strength +96 XP | Attack +118, Defence +68 XP |
| Combat | combat (dark wizards, level 20+) | Attack +152, Hitpoints +62.9 XP | Attack +412, Hitpoints +196.4 XP |
| Prayer | prayer (bury bones) | Prayer +45 XP | Prayer +45 XP |
| Firemaking | firemaking (logs) | Firemaking +1120 XP | Firemaking +1360 XP |
| Cook | cooking (shrimp on a range) | Cooking +570 XP | Cooking +600 XP |
| Smith | smithing (smelt bronze) | Smithing +74.4 XP | Smithing +74.4 XP |
| Smith | smithing (anvil, bronze bars) | Smithing +8442 XP | Smithing +8599.5 XP |
| Crafting | crafting (shear sheep, spin wool) | Crafting +280 XP | Crafting +280 XP |
| Crafting | crafting (spin flax) | Crafting +600 XP | — (members) |
| Crafting | crafting (leather gloves) | Crafting +138 XP | Crafting +138 XP |
| Crafting | crafting (cut sapphires) | Crafting +1000 XP | Crafting +1000 XP |
| Crafting | crafting (gold rings) | Crafting +300 XP | Crafting +300 XP |
| Thieve | thieving (pickpocket men) | Thieving +416 XP | — (members) |
| Thieve | thieving (Ardougne baker's stall) | Thieving +32 XP | — (members) |
| Pick Flax | pick flax (Seers) | flax picked | — (members) |
| WaterFilling | fill buckets with water | buckets filled | buckets filled |
| Runecrafting | runecrafting (air runes) | Mining +1630, Runecraft +1505 XP | Mining +1630, Runecraft +1505 XP |
| Fletching | fletching (shortbows from logs) | Woodcutting +1300, Fletching +260 XP | — (members) |
| BowStringing | fletching (string shortbows) | Fletching +100 XP | — (members) |
| Herblore | herblore (attack potions) | Herblore +225 XP | — (members) |
| Agility | agility (gnome course) | Agility +2162.5 XP | — (members) |
| Agility | agility (barbarian course) | Agility +970 XP | — (members) |
| Agility | agility (wilderness course) | Agility +2555.6 XP | — (members) |
| RangedMagic | ranged (shortbow) | Ranged +132, Hitpoints +42.9 XP | Ranged +736, Hitpoints +239.2 XP |
| RangedMagic | magic (wind strike) | Magic +2118, Hitpoints +305.5 XP | Magic +1184, Hitpoints +183.3 XP |
| ShopTrip | shop trip (iron axe at Bob's) | axe bought | axe bought |
| PickupSpawn | pick up the Lumbridge knife | knife picked up | knife picked up |
| Bank | bank a full inventory | logs banked | logs banked |
| Bankstand | bankstand (sell at Varrock West) | advertising at the bank | advertising at the bank |
| Vendor | vendor (stall and adverts) | stall stocked, advertising | stall stocked, advertising |
| Social | social | talking to players | talking to players |
| Combat | combat (Al Kharid warriors, rune scimitar worn) | Strength +296, Attack +274 XP | Defence +628, Strength +532 XP |
| Combat | combat (hurt: eats its swordfish) | ate swordfish, fought on | ate swordfish, fought on |
| Combat | combat (hurt, no food: banks for some) | took food from its bank, ate | took food from its bank, ate |
| RangedMagic | ranged (bow worn, arrows in the bank) | Ranged +256, Hitpoints +83.2 XP | Ranged +20, Hitpoints +6.5 XP |
| Mine | mining (pickaxe in the bank) | Mining +80 XP | Mining +910 XP |
| Fish | fishing (net in the bank) | Fishing +430 XP | Fishing +480 XP |
| ShopTrip | planner: fisher of 45 buys a lobster pot | bought fishing gear at Gerrant's, Fishing +810 XP | bought fishing gear at Gerrant's, Fishing +810 XP |
| any | planner: Mining and Smithing 40 keep their variety | Mining +715, Smithing +247.5 XP | Mining +1365, Smithing +237.5 XP |
| Combat | planner: a level-40 fighter with a worn scimitar fights | Strength +230, Hitpoints +108.1 XP | Attack +432, Strength +376 XP |
| PKer | PKer (deep wilderness) | hunting at wilderness 10+ | hunting at wilderness 10+ |
| EdgevillePKer | Edgeville PKer | hunting in the wilderness | hunting in the wilderness |
| Woodcut | woodcutting (willows, Seers) | Woodcutting +3577.5 XP | — (members) |
| Woodcut | woodcutting (willows, Catherby) | Woodcutting +4387.5 XP | — (members) |
| Fish | fishing (tuna, Catherby) | Fishing +4480 XP | — (members) |
| Fish | fishing (lobsters, Catherby, from Lumbridge) | Fishing +3960 XP | — (members) |
| Fish | fishing (swordfish, Catherby) | Fishing +7460 XP | — (members) |
| Combat | combat (ice giants, ice dungeon) | Attack +836, Defence +628 XP | Strength +496, Defence +412 XP |
| RangedMagic | ranged (ice giants, ice dungeon) | Ranged +1828, Hitpoints +601.9 XP | Ranged +1612, Hitpoints +530.5 XP |
| RangedMagic | magic (ice giants, ice dungeon) | Magic +1593.5, Hitpoints +260 XP | Magic +1103, Hitpoints +166.4 XP |
| Runecrafting | runecrafting (cosmic runes, Zanaris) | Mining +245, Runecraft +392 XP | — (members) |
| Combat | combat (goblins, Lumbridge) | Attack +316, Hitpoints +254.8 XP | Attack +240, Strength +236 XP |
| Combat | combat (cows, Lumbridge) | Attack +316, Defence +316 XP | Defence +340, Attack +312 XP |
| Combat | combat (barbarians, Barbarian Village) | Attack +612, Strength +584 XP | Attack +264, Strength +168 XP |
| Combat | combat (Varrock guards) | Strength +512, Attack +496 XP | Defence +508, Hitpoints +407.9 XP |
| Combat | combat (hill giants, Edgeville dungeon) | Strength +1084, Attack +820 XP | Strength +1576, Attack +1468 XP |
| Combat | combat (moss giants, Kandarin) | Attack +724, Defence +604 XP | — (members) |
| Mine | mining (iron, Al Kharid mine) | Mining +2800 XP | Mining +2835 XP |
| Combat | planner: a level-12 fighter fights at a 2004 crowd spot | Defence +348, Hitpoints +317.2 XP | Defence +460, Hitpoints +382.2 XP |

The earned gear cases ("earned gear: a fighter buys ...", progress: it owns the piece) buy what the case's bot likes (`port/BotLooks.setTasteForTest`): Zeke's scimitar, Horvik's platebody and Peksa's full
helm as before, and Wayne's black chainbody, Cassie's iron square shield, Ranael's plateskirt (where she stands) and
Thessalia's red cape: all bought on both worlds. The social case counts a regular standing at its hub as well as one
that talks (a regular at a quiet hub may say nothing in 25 minutes).

Not covered: `WalkTask` and `SellTask` (UtilTasks.ts) and `AgilityTestGoalPlanner` are never created by any planner
upstream; `IdleTask` is the planner's fallback; `BotTask.ts` (the legacy task file) and the debug dashboard are not in
the bundle.

## Tests

The tests read the upstream sources (found by `scripts/lib/upstream.mjs`: `LC_UPSTREAM_DIR`, `upstream/`, or a
`../Server` checkout beside the repo) and never write to them: each test that needs the engine runs in a scratch clone
under `build/tmp/bots/` (removed when it exits), with this library linked in as `src/engine/bot`.

```sh
node web/engine/bots/test/all.mjs          # everything below except the long runs (most of an hour)
node web/engine/bots/test/all.mjs --full   # plus the coverage runs, the long simulations and the humanlike report
```

Every test file's header says exactly what it checks. In short:

| Test | What it checks |
|---|---|
| `tsc -p web/engine/bots` | The library and its tests type-check against the upstream engine |
| `test/worker-safety.test.mjs` | Nothing the bundle reaches uses Node built-ins, files, network, the database, `process`, `Buffer`, `import.meta` or timers; imports resolve with their exact case |
| `test/names.test.mjs` | `names.json`: shown in game as written, unique, no NPC's name, nothing offensive, append-only (`test/ref/names.lock`; `--update-lock` after appending); the pool and the newcomers' names |
| `test/inventory.test.mjs` | The inventory helpers against revision 254's own `Inventory` on 40,000 random inventories |
| `test/pathing.test.mjs`, `test/walkgraph.test.mjs` | Waypoints, the search window and budget; the walking graph re-walked on the map |
| `test/content-names.test.mjs`, `test/knowledge.test.mjs` | Every content name and item id the bundle can reach resolves in 274; every step has something to do in reach |
| `test/determinism.test.mjs` | Two seeded runs end the same |
| `test/churn.mjs`, `test/arrivals.test.mjs` | The living world: sessions, returns restored exactly, newcomers, quits, the empty world; the session draw, near-you-first, newbies by levels, a restart |
| `test/age.test.mjs`, `test/looks.test.mjs`, `test/outfits.test.mjs`, `test/fashion.test.mjs`, `test/persona.test.mjs` | A new world's ages; bodies, gear taste, rares; outfits and weapons; status gear and fashion; personas |
| `test/chat.test.mjs`, `test/chat-filter.test.mjs`, `test/lines.test.mjs`, `test/talk.test.mjs`, `test/threads.test.mjs` | Addressing, intents, the marketplace, "come here", typed replies; every line through the real 274 word filter and chat codec; what bots say unprompted; threads, witnesses, the voice cap |
| `test/trade.test.mjs`, `test/economy.test.mjs` | Trades through the screens (sales with change, overpayment, buy-backs, timeouts); prices, rares, stock by trade bank, adverts |
| `test/pk.test.mjs`, `test/pkfight.test.mjs` | PK gear on free worlds, target claims, prayers, the bow; fights between PKers: eating, potions, the KO, escapes |
| `test/habits.test.mjs`, `test/texture.test.mjs`, `test/fixes.test.mjs` | Breaks, lingers, leaving, human timing; misclicks, danger, rudeness; stuck walks, futile loops, dungeons, the junk sale |
| `test/social.test.mjs`, `test/tiles.test.mjs`, `test/hangout.test.mjs` | Regulars, lures, cliques; own tiles and the level of detail; hang-outs |
| `test/teleport.test.mjs`, `test/randomevents.test.mjs` | Teleport spells, wrong turns, White Wolf Mountain, alching, law runs; every random event's answer |
| `test/setpieces.test.mjs`, `test/director.test.mjs`, `test/groups.test.mjs`, `test/party.test.mjs`, `test/scams.test.mjs`, `test/duel.test.mjs` | The set pieces: the interface, the director's schedule, clan walks, PK raids and trains, drop parties, scams and lures, the Duel Arena and the mod bot |
| `test/activities.test.mjs`, `test/errands.test.mjs`, `test/minigames.test.mjs` | Spots and their capacity, favourites, power-dropping; the chains, quest look-alikes, magic and herb runs, travel; outings, minigames, Treasure Trails |
| `test/model.test.mjs` | The chat model's seam: the situation, the prompts, the scope, the timing and fallbacks, every guard reason |
| `test/humanlike-metrics.test.mjs` | The humanlike report's measures on synthetic records |
| `test/sim.mjs` | The real 274 world, headless, with the runtime's hooks and a human: `--scenario=world` (default), `coverage` (the table above), `crowd`, `aged`; a health report (below) |
| `test/humanlike.mjs` | How human the bots look and sound ([docs/BOTS.md](../../../docs/BOTS.md#7-tests)) |

```sh
node --expose-gc web/engine/bots/test/sim.mjs --bots=25 --ticks=3000 [--members=false] [--seed=N] [--json=FILE]
node --expose-gc web/engine/bots/test/sim.mjs --scenario=coverage --ticks=2500 [--only=agility] [--trace]
node --expose-gc web/engine/bots/test/sim.mjs --scenario=crowd --bots=100 --ticks=120
node --expose-gc web/engine/bots/test/sim.mjs --scenario=aged --bots=50 --ticks=3000 [--members=false]
node --expose-gc web/engine/bots/test/sim.mjs --bots=16 --ticks=5000 --levels=40 [--trace=@bot_name]
node --expose-gc web/engine/bots/test/churn.mjs --bots=25 --ticks=6000 [--members=false] [--seed=N]
node --expose-gc web/engine/bots/test/humanlike.mjs --bots=100 --ticks=6000 [--members=false] [--seed=N] [--xprate=10]
```

`sim.mjs` reports tick times, route searches, the largest PLAYER_INFO packet, heap, where the levelling bots spend
their time, bots without XP, stalls (same tile, task and state, nothing gained), deaths (one at a skill or an errand
fails the run), rescue jumps by task and reason, and a fingerprint (the same arguments give the same numbers).
`--levels=N` gives the levelling bots every skill at N, which finds planner bugs that never show at level 3.
`LC_BOTS_SRC=DIR` runs any test against another copy of the library, for an A/B comparison.

## Re-vendoring

`UPSTREAM` names the upstream commit the vendored files came from, and every change the port made to them is marked
`port:`. To see upstream's code beside the port's, diff a file against the same file in an upstream clone at that
commit.

1. Clone upstream and diff its bot folder between the vendored commit and the new one:
   `git -C <clone> diff <old>..<new> -- bundled/progressive/engine/src/engine/bot bundled/progressive/engine/data/bot`.
2. Apply it here, from the repository root:
   ```sh
   git -C <clone> diff <old>..<new> -- bundled/progressive/engine/src/engine/bot | git apply -3 -p7 --directory=web/engine/bots/src
   git -C <clone> diff <old>..<new> -- bundled/progressive/engine/data/bot | git apply -3 -p6 --directory=web/engine/bots/data
   ```
   Conflicts are where the port changed upstream code: keep both intents, and keep new modules in `src/port/`.
3. Check new upstream files against the port notes above: no `fs`, `path`, `process` or timers (`setTimeout` becomes
   `port/BotSchedule`), `console` through `port/BotLog`, `.hasSucceeded()` becomes `invAddAll`, withdrawals go through
   `moveItems`, `maxWaypoints` through `port/BotPathing`.
4. Run `node web/engine/bots/test/all.mjs --full`. The content-name test fails on any new name 274 does not have, and
   asks for a declaration for any new computed lookup.
5. Update `UPSTREAM` (commit, date) and this README.

## Generated data

- **The walking graph** (`data/walk_graph.json`) is made from the 274 map, not from upstream: build it again only if
  the map changes (another revision): `node web/engine/bots/test/walk-graph-build.mjs` (about 20 s; `--check` compares
  with the committed file). `test/walkgraph.test.mjs` re-walks a sample of its edges and fails when it is stale.
- **The line tags** (`data/line_tags.json`) are made from `data/bot_phrases.json`'s idle lines: after changing those,
  run `node web/engine/bots/test/line-tags-build.mjs` (`--unsure` lists the lines its keyword rules cannot settle: give
  each its tag by hand in `test/ref/line-tags-review.mjs`; `--print` shows every tag; `--check` compares with the
  committed file, as `test/lines.test.mjs` does).
- **The chat model** is made by `test/model-data/` ([its README](test/model-data/README.md)).
