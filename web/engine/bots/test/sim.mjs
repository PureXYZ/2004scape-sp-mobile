#!/usr/bin/env node
// The bot library in the real rev-274 world, headless (BOTS.md §7): a scratch clone of Server/engine whose
// src/engine/bot is this library (test/lib/clone.mjs), the runtime glue's two hooks, one "human" player, and N bots
// for T ticks as fast as they run. Reports spawning, what every planner and task kind did (tasks started, XP per
// skill), errors, path searches and tick times, PLAYER_INFO sizes, and checks the port's rules.
//
//   node --expose-gc web/engine/bots/test/sim.mjs [--bots=25] [--ticks=3000] [--members=true|false] [--seed=N]
//        [--scenario=world|coverage|crowd] [--only=TEXT] [--debug] [--trace] [--json[=FILE]]
//
//   world     N bots from the roster, as the app runs them, plus scripted checks: chat addressing, "come here",
//             PKers and the wilderness rule, visibility, spawning, errors, Tutorial Island, F2P on a free world
//   coverage  one bot per task kind (test/lib/coverage.ts) with the levels and items it needs; each must start its
//             task and gain its XP (or items) within --ticks (--only=TEXT picks cases by name)
//   crowd     all N bots standing around the human: PLAYER_INFO bytes, and every bot in its player list
//   aged      a new bot world whose bots get an age (port/BotAge): N bots for T ticks; the tiers spread, every aged
//             levelling bot gains XP within 3,000 ticks of logging in, no stall of 300+ ticks but vendors', PKers' and a
//             hang-out's stand (port/BotHangout: 3-10 minutes at the park, the square or a bank, by design)
//   --json    the full report on stdout; --json=FILE writes it (with every tick's sample) to FILE
//   --trace   coverage: every bot every tick; --trace=KIND (world): bots doing that task kind, every 10 ticks;
//             --trace=@name: that bot
//   --dump=NAME[@TICK]  that bot's levels, worn items, pack, bank and task fields at TICK (default: every 500 ticks)
//   --levels=N  world: the levelling bots (skiller, fighter, balanced, random) get every skill at N when they log in
//             (Hitpoints at least 10), to see what the planner does with higher levels
//   --xprate=N  the world's XP rate (Settings: 1, 2, 5, 10; the app's bots level at it too)
//
// The health report (world and aged): each task kind's XP in its own skill per 1,000 bot-ticks, teleports by task and
// reason (BotAction.teleportStats: done unseen, refused where a human could see), "I can't reach that!" clicks,
// chat lines and repeats, bots that stayed within a few tiles with nothing to show for 600+ ticks (loops), deaths (the
// task, who fought the bot, where: the world scenario fails on one at a skill or an errand), and a fingerprint of the
// world at the end (the same seed must give the same one: test/determinism.test.mjs).
//
// Exit code 1 if a check fails. Nothing is written outside build/tmp/bots.
import fs from 'fs';
import path from 'path';
import { BOTS_DIR } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';
import { importTs } from './lib/paths.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const SCENARIO = args.scenario ?? 'world';
let N = Number(args.bots ?? 25);
const TICKS = Number(args.ticks ?? 3000);
const MEMBERS = (args.members ?? 'true') !== 'false';
const DEBUG = args.debug === 'true';
const LEVELS = args.levels !== undefined ? Number(args.levels) : 0;
const XPRATE = args.xprate !== undefined ? Number(args.xprate) : 1;
const LEVELLING = new Set(['skiller', 'fighter', 'balanced', 'random']);
if (!Number.isInteger(N) || N < 0 || !Number.isInteger(TICKS) || TICKS < 1) {
    console.error(`sim: --bots and --ticks take whole numbers (got --bots=${args.bots ?? ''} --ticks=${args.ticks ?? ''})`);
    process.exit(2);
}
const SPAWN_AT = [3180, 3240, 0]; // BotKnowledge LUMBRIDGE_SPAWN: the human sees every bot arrive
const START_CWD = process.cwd();

// ---- a deterministic Math.random (the bots roll a lot of dice) ----
{
    let s = Number(args.seed ?? 1) >>> 0 || 1;
    Math.random = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---- --dump=NAME[@TICK]: a bot's state (levels, items, task fields) ----
function dumpBot() {
    const [name, at] = String(args.dump).split('@');
    if (at !== undefined ? World.currentTick !== Number(at) : World.currentTick % 500 !== 0) return;
    const p = sim.bots().find(b => b.username === name);
    if (!p) return out(`dump t${World.currentTick}: ${name} not online`);
    const items = inv => (inv ? [...inv.items].filter(Boolean).map(i => `${lib.objName?.(i.id) ?? i.id}x${i.count}`).join(', ') : '-');
    const t = sim.botPlayer(p)?.currentTask;
    const fields = t ? Object.entries(t).filter(([k, v]) => !/^_|watchdog|stuck/.test(k) && (typeof v !== 'object' || v === null || Array.isArray(v)) && typeof v !== 'function').map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : '-';
    out(`dump t${World.currentTick} ${name} ${p.x},${p.z},${p.level} planner=${p.botPlanner}`);
    out(`  levels ${[...p.baseLevels].join(' ')}`);
    out(`  worn: ${items(p.getInventory(lib.InvType.WORN))}`);
    out(`  pack: ${items(p.getInventory(lib.InvType.INV))}`);
    out(`  bank: ${items(p.getInventory(lib.InvType.getId('bank')))}`);
    out(`  task ${t?.name ?? '-'}: ${fields}`);
    const sub = sim.botPlayer(p)?.subTask;
    if (sub) out(`  subtask ${sub.name}: ${Object.entries(sub).filter(([k, v]) => !/^_|watchdog|stuck/.test(k) && (typeof v !== 'object' || v === null || Array.isArray(v)) && typeof v !== 'function').map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`);
    out(`  human ${human.x},${human.z},${human.level} wp=${human.hasWaypoints() ? human.waypointIndex + 1 : 0} target=${human.target?.username ?? human.target?.constructor?.name ?? '-'} op=${human.targetOp}`);
    // (what it is at, and the NPCs at it: an NPC's mode, place, Hitpoints)
    const npcAt = n => `${lib.NpcType.get(n.type)?.debugname ?? n.type}@${n.x},${n.z} mode=${n.targetOp} hp=${n.levels?.[3] ?? '?'}`;
    const tg = p.target;
    out(`  target ${tg ? (tg.username ?? npcAt(tg)) : '-'} op=${p.targetOp} wp=${p.hasWaypoints() ? p.waypointIndex + 1 : 0} delayed=${p.delayed} hp=${p.levels[3]}`);
    const on = [...World.npcs].filter(n => n && n.target === p).map(npcAt);
    out(`  npcs at it: ${on.join('; ') || '-'}`);
}

// ---- console: count, keep errors, print only ours ----
const out = (s = '') => process.stdout.write(s + '\n');
const logStats = { lines: 0, errors: [], warnings: [] };
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    const real = console[level].bind(console);
    console[level] = (...a) => {
        logStats.lines++;
        const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : typeof x === 'string' ? x : String(x))).join(' ');
        if (level === 'error' && !text.includes('ExperimentalWarning')) logStats.errors.push({ tick: currentTick(), text });
        if (level === 'warn') logStats.warnings.push({ tick: currentTick(), text });
        if (DEBUG) real(...a);
    };
}
let World = null;
const currentTick = () => (World ? World.currentTick : -1);

// ---- the world ----
const engineDir = prepareEngineClone(`sim-${MEMBERS ? 'p2p' : 'f2p'}`, simWorldConfig({ members: MEMBERS, xpRate: XPRATE }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/simworld.ts'), path.join(engineDir, 'tsconfig.json'));
World = lib.World;
const { BotManager, BotChat, wildernessLevelAt, isAway, lastBreakOf } = lib;

// the XP the bots gain where the engine grants it (Player.addXp: the scripts' stat_advance), kept per bot until the next
// observe(); levels set directly (a PKer's build in its handleInit, the coverage cases' and --levels' setup, BotAge)
// are no gain
const pendingXp = new Map();
{
    const addXp = lib.Player.prototype.addXp;
    lib.Player.prototype.addXp = function (stat, xp, allowMulti) {
        const before = this.stats[stat];
        const r = addXp.call(this, stat, xp, allowMulti);
        const d = this.stats[stat] - before;
        if (d > 0 && this.is_bot) {
            let a = pendingXp.get(this.username);
            if (!a) pendingXp.set(this.username, (a = new Array(this.stats.length).fill(0)));
            a[stat] += d;
        }
        return r;
    };
}

// coverage: one bot per task kind (test/lib/coverage.ts), all spawned at once
// (--cliques=off: the friend cliques exist but do nothing together, port/BotCliques; to tell their part in a result.
// The coverage scenario runs without them unless --cliques=on: it checks each task on its own, and a case's friends
// (the cases' names fall in cliques) trained with it and bought out its shop: "earned gear: a fighter buys a platebody"
// found Horvik's stock gone to its friend. social.test and the humanlike report check the cliques.)
if (args.cliques === 'off' || (SCENARIO === 'coverage' && args.cliques !== 'on')) lib.BotCliques?.setCliqueBehaviourForTest?.(false);
// (and without the Duel Arena's visits, phase 5b: a case's fighter walked to the arena at its first pick, a visit due in a
// fresh world, instead of its cape at Thessalia's)
if (SCENARIO === 'coverage') lib.BotArena?.setArenaRatesForTest?.(0);
const coverage = SCENARIO === 'coverage' ? lib.coverageCases().filter(c => (MEMBERS || !c.members) && (!args.only || c.name.includes(args.only))) : null;
if (coverage) N = coverage.length;
// coverage: the bots whose task is forced (a case without a plan), by the case's kind. Once such a task has used up its
// materials it cannot run, and a new one is made every tick: the bot stays put by design. So they are left out of the
// loops (as out of the stalls), and out of 'no XP' when their kind gives none (OWN_SKILLS)
const forced = new Map();

const AGED = SCENARIO === 'aged';
const sim = await lib.Sim.create({ bots: N, members: MEMBERS, debug: DEBUG, spawnPerTick: coverage ? N : undefined, ageNewBots: AGED });
sim.addHuman(...(coverage ? [3222, 3218, 0] : SPAWN_AT));
const human = sim.human;

// the lines each watched bot says (a chat check's bot, a coverage case's)
const heard = new Map();
// the ticks of lines said at each trade bank's stalls
const stallLines = new Map();
// ---- health: what the bots say, and the clicks the game refuses ----
const health = { lines: 0, byLine: new Map(), byBot: new Map(), cantReach: new Map(), loops: [], deaths: [] };
{
    const proto = lib.Player.prototype;
    // (bots speak as typed lines, port/BotSay; its listeners hear each line as it is shown)
    lib.sayListeners.push((player, text) => {
        // the lines of bots at a trade bank's stall (vendors, bankstanders): the bank's talk budget
        const stall = lib.stallOf(player);
        if (stall) {
            if (!stallLines.has(stall.bank.key)) stallLines.set(stall.bank.key, []);
            stallLines.get(stall.bank.key).push({ tick: World.currentTick, line: `t${World.currentTick} ${player.username}: ${text}` });
        }
        health.lines++;
        health.byLine.set(text, (health.byLine.get(text) ?? 0) + 1);
        health.byBot.set(player.username, (health.byBot.get(player.username) ?? 0) + 1);
        heard.get(player)?.push(text);
    });
    const mes = proto.messageGame;
    proto.messageGame = function (text) {
        if (this.is_bot && typeof text === 'string' && text.startsWith("I can't reach that")) {
            const kind = taskKind(sim.botPlayer(this)?.currentTask?.name);
            health.cantReach.set(kind, (health.cantReach.get(kind) ?? 0) + 1);
        }
        // (274's death script says it where the bot fell, before it moves it to Lumbridge)
        if (this.is_bot && text === 'Oh dear you are dead!') {
            // (who was fighting it: an NPC or a player targeting it, nearest first)
            let by = lastAttacker.get(this) ?? '?';
            let best = Infinity;
            for (const list of [World.npcs, World.players]) {
                for (const e of list) {
                    if (!e || e.target !== this || e.level !== this.level || (e.username === undefined && !(e.targetOp >= lib.NpcMode.OPPLAYER1 && e.targetOp <= lib.NpcMode.APPLAYER5))) continue;
                    const d = Math.max(Math.abs(e.x - this.x), Math.abs(e.z - this.z));
                    if (d < best) {
                        best = d;
                        by = e.username ?? lib.NpcType.get(e.type)?.debugname ?? '?';
                    }
                }
            }
            // (a fight's foe that killed the bot soon after its fight's task gave up: the fight's death, its kind)
            let kind = taskKind(sim.botPlayer(this)?.currentTask?.name);
            const fight = lastFight.get(this);
            if (!FIGHTING_KINDS.has(kind) && fight && fight.foe === by && World.currentTick - fight.tick <= FIGHT_AFTERMATH_TICKS) kind = `${fight.kind} (then ${kind})`;
            health.deaths.push({ kind, fight: fight?.kind, bot: this.username, by, at: `${this.x},${this.z},${this.level}`, tick: World.currentTick });
        }
        return mes.call(this, text);
    };
}
/** [value, how many times] for each distinct value, most first */
function count(values) {
    const m = new Map();
    for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
}
/** the skills a task kind trains (its own XP); kinds not here give items, coins or nothing */
const OWN_SKILLS = {
    Woodcut: ['woodcutting'], Mine: ['mining'], Fish: ['fishing'], Thieve: ['thieving'], Crafting: ['crafting'], Cook: ['cooking'],
    Smith: ['smithing'], Firemaking: ['firemaking'], Combat: ['attack', 'strength', 'defence', 'hitpoints'], Agility: ['agility'],
    RangedMagic: ['ranged', 'magic', 'hitpoints'], Fletching: ['fletching'], BowStringing: ['fletching'], Herblore: ['herblore'],
    Runecrafting: ['runecraft'], Prayer: ['prayer']
};
/** task kinds that stand or wander in one place by design (no XP to show) */
const STATIONARY = new Set(['Vendor', 'Bankstand', 'Social', 'PKer', 'EdgevillePKer', 'Idle', 'Init', 'ComeHere', 'Hangout']);
const LOOP_RADIUS = 4;
const LOOP_TICKS = 600;

const STAT_NAMES = ['attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'magic', 'cooking', 'woodcutting', 'fletching', 'fishing', 'firemaking', 'crafting', 'smithing', 'mining', 'herblore', 'agility', 'thieving', 'stat18', 'stat19', 'runecraft'];

// per bot: last stats, last task; per task kind and planner: starts, ticks, xp by skill
const tracked = new Map();
const tasks = new Map();
const planners = new Map();
const violations = { tutorial: [], f2p: [] };
function taskKind(name) {
    return name ? name.split(':')[0] : 'none';
}
function entry(map, key) {
    let e = map.get(key);
    if (!e) map.set(key, (e = { bots: new Set(), starts: 0, ticks: 0, xp: {} }));
    return e;
}
function observe() {
    for (const player of sim.bots()) {
        const bot = sim.botPlayer(player);
        if (!bot) continue;
        // (a hang-out begun at a bank stop is the bot's sub-task: what it does, realism phase 3)
        const task = taskKind((lib.hangoutOf(player) ?? bot.currentTask)?.name);
        let t = tracked.get(player.username);
        if (!t) {
            if (LEVELS > 0 && LEVELLING.has(player.botPlanner)) {
                for (let stat = 0; stat < player.baseLevels.length; stat++) {
                    if (stat === 18 || stat === 19) continue; // no such skills in 2004
                    player.setLevel(stat, stat === 3 ? Math.max(10, LEVELS) : stat === 15 ? Math.max(3, LEVELS) : LEVELS);
                }
            }
            t = { stats: Int32Array.from(player.stats), startStats: Int32Array.from(player.stats), task: 'none', planner: player.botPlanner, ticks: 0, lumbridge: 0, firstXpTick: -1, spawnTick: World.currentTick, combat: player.combatLevel, tier: lib.ageTierFor(player.username, player.botPlanner) };
            tracked.set(player.username, t);
        }
        // where the levelling bots spend their time: Lumbridge (its castle, fields, swamp and cows), the beginners' area
        if (LEVELLING.has(t.planner)) {
            t.ticks++;
            if (player.level === 0 && player.x >= 3140 && player.x <= 3270 && player.z >= 3140 && player.z <= 3300) {
                t.lumbridge++;
                if (player.combatLevel >= 20) {
                    const loc = bot.currentTask?.step?.location;
                    const key = task === 'Combat' && loc ? `Combat at ${loc[0]},${loc[1]}` : task;
                    lumbridgeTasks20.set(key, (lumbridgeTasks20.get(key) ?? 0) + 1);
                }
            }
        }
        // XP gained since the last observation happened under the task the bot had then
        const pending = pendingXp.get(player.username);
        pendingXp.delete(player.username);
        for (let s = 0; s < player.stats.length; s++) {
            const gained = pending ? pending[s] : 0;
            if (gained > 0 && t.firstXpTick === -1) t.firstXpTick = World.currentTick;
            if (gained > 0) {
                const te = entry(tasks, t.task);
                te.xp[STAT_NAMES[s]] = (te.xp[STAT_NAMES[s]] ?? 0) + gained;
                const pe = entry(planners, t.planner);
                pe.xp[STAT_NAMES[s]] = (pe.xp[STAT_NAMES[s]] ?? 0) + gained;
            }
        }
        t.stats = Int32Array.from(player.stats);
        // (when a Duel Arena visit began: the aged check's below)
        if (task === 'DuelArena' && t.arenaTick === undefined) t.arenaTick = World.currentTick;
        if (task !== t.task) {
            entry(tasks, task).starts++;
            t.task = task;
        }
        const te = entry(tasks, task);
        te.ticks++;
        te.bots.add(player.username);
        entry(planners, t.planner).bots.add(player.username);

        const { x, z, level } = player;
        if (x >= 3053 && x <= 3156 && z >= 3056 && z <= 3136 && level === 0) violations.tutorial.push(`${player.username}@${x},${z} t${World.currentTick}`);
        if (!MEMBERS && !sim.isFreeToPlay(x, z)) violations.f2p.push(`${player.username}@${x},${z},${level} t${World.currentTick} (${t.task})`);

        // a stall: same tile, task and state, no XP and nothing gained or used up, for STALL_TICKS (standing vendors and
        // the like are expected; picking flax gives no XP)
        // (a hang-out begun at a bank stop is the bot's sub-task: realism phase 3, port/BotHangout)
        const doing = lib.hangoutOf(player) ?? bot.currentTask;
        const where = `${x},${z},${level} ${doing?.name ?? '-'}/${doing?.state ?? '-'}`;
        const gainedXp = t.lastStats ? player.stats.some((v, i) => v !== t.lastStats[i]) : true;
        t.lastStats = t.stats;
        const free = player.getInventory(lib.InvType.INV)?.freeSlotCount ?? -1;
        const packChanged = free !== t.lastFree;
        t.lastFree = free;
        if (where !== t.where || gainedXp || packChanged) {
            if (t.stillTicks >= STALL_TICKS) stalls.push({ bot: player.username, where: t.where, ticks: t.stillTicks, until: World.currentTick });
            t.where = where;
            t.stillTicks = 0;
        } else {
            t.stillTicks++;
        }
        // a loop: within LOOP_RADIUS of one tile, with no XP and no pack change, for LOOP_TICKS (moving about counts,
        // unlike a stall: a bot that walks to its bank and back, or flips between two states, makes no progress either)
        const anchored = t.anchor && t.anchor[2] === level && Math.max(Math.abs(x - t.anchor[0]), Math.abs(z - t.anchor[1])) <= LOOP_RADIUS;
        if (!anchored || gainedXp || packChanged || STATIONARY.has(task)) {
            if (t.anchor && World.currentTick - t.anchor[3] >= LOOP_TICKS && !STATIONARY.has(t.anchor[4]) && !forced.has(player.username)) health.loops.push(`${player.username} ${t.anchor[4]} at ${t.anchor[0]},${t.anchor[1]},${t.anchor[2]} for ${World.currentTick - t.anchor[3]} ticks`);
            t.anchor = [x, z, level, World.currentTick, task];
        }
    }
}
const STALL_TICKS = 300;
/** what levelling bots of combat 20+ do in Lumbridge (bot-ticks by task kind) */
const lumbridgeTasks20 = new Map();
const stalls = [];
function openStalls() {
    const out = [...stalls];
    for (const [name, t] of tracked) if (t.stillTicks >= STALL_TICKS) out.push({ bot: name, where: t.where, ticks: t.stillTicks, until: World.currentTick });
    return out;
}

// ---- checks ----
const checks = [];
function check(name, ok, detail) {
    checks.push({ name, ok: !!ok, detail });
}
const chebyshev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const spawnDone = Math.ceil(N / 5) + 3;
const SKILLING = new Set(['Woodcut', 'Mine', 'Fish', 'Thieve', 'Crafting', 'Cook', 'Smith', 'Firemaking', 'Combat', 'Pick Flax', 'Agility', 'RangedMagic', 'Vendor', 'Bankstand', 'Social']);
function pickBot(filter) {
    const all = sim.bots().filter(p => p.level === 0 && filter(p, sim.botPlayer(p)));
    return all.length ? all[Math.floor(Math.random() * all.length)] : null;
}
function taskOf(p) {
    return sim.botPlayer(p)?.currentTask ?? null;
}
const pkOutside = [];
const invisible = [];
const nearFor = new Map();
const attackingHuman = new Set();
let pkAttacksInside = 0;
let spawnView = { visibleMax: 0, playerInfoMax: 0 };

const scenario = [];
function at(tick, name, run) {
    scenario.push({ tick, name, run });
}
async function runTicks(n, each) {
    for (let i = 0; i < n; i++) {
        tickOnce();
        if (each && each()) return true;
    }
    return false;
}

// 1. chat: an unrelated sentence gets no reply, the bot's whole name does
/** port (the realism work): a reply's latest: a tick to read the line, at most 20 to think and type it (port/BotTiming), a few to spare */
const REPLY_TICKS = 26;
at(Math.max(spawnDone + 40, 120), 'chat', async () => {
    // (not one on a short break: port/BotHabits, an away bot answers nobody)
    const bot = pickBot((p, b) => SKILLING.has(taskKind(b?.currentTask?.name)) && !p.hasWaypoints() && !isAway(p)) ?? pickBot(p => !isAway(p));
    if (!bot) return check('chat: a bot to talk to', false, 'no bot');
    const said = [];
    heard.set(bot, said);
    // the human stands by the bot when it speaks (a bot that walks off more than 14 tiles before it hears the line
    // does not answer, as upstream)
    const besideBot = async () => {
        sim.teleportHuman(bot.x, bot.z, bot.level);
        await runTicks(1);
    };
    await besideBot();
    const before = BotChat.repliesBy(bot);
    BotChat.onPublicMessage(human, 'ask the fish trader');
    await runTicks(REPLY_TICKS);
    // (this bot's replies: another that spoke to the human just before may answer, the reply window)
    const unrelated = BotChat.repliesBy(bot) - before;
    check('chat: an unrelated sentence ("ask the fish trader") gets no reply', unrelated === 0, `${unrelated} replies${unrelated ? ` from ${bot.displayName} (${taskKind(taskOf(bot)?.name)}): ${said.slice(-unrelated).join(' | ')}` : ''}`);
    await besideBot();
    // (this bot's replies: its own adverts or idle lines are no answer)
    const before2 = BotChat.repliesBy(bot);
    const t0 = World.currentTick;
    BotChat.onPublicMessage(human, `hey ${bot.displayName}`);
    let answeredIn = -1;
    // port (the realism work): typed: the bot reads the line (a tick), thinks and types its answer at its persona's speed
    // (port/BotTiming: 2-20 ticks), so the answer comes 3-26 ticks on and no faster than 7.5 characters a second (the
    // quickest typist's 6.5, and its spread); it used to come within 8 ticks whatever its length
    await runTicks(REPLY_TICKS, () => {
        if (answeredIn === -1 && BotChat.repliesBy(bot) > before2) answeredIn = World.currentTick - t0;
        return answeredIn !== -1;
    });
    const reply = said.at(-1) ?? '';
    const cps = answeredIn > 0 ? reply.length / (answeredIn * 0.6) : Infinity;
    // (a bot that went on a short break meanwhile answers nobody: port/BotHabits, about one an hour, so now and then)
    const brk = lastBreakOf(bot);
    const wentAway = answeredIn === -1 && (isAway(bot) || (brk !== null && brk.kind !== 'linger' && brk.end >= t0));
    check(`chat: "hey ${bot.displayName}" gets a reply, typed: within ${REPLY_TICKS} ticks, no sooner than 3, at most 7.5 characters a second`, wentAway || (answeredIn !== -1 && answeredIn >= 3 && answeredIn <= REPLY_TICKS && cps <= 7.5), wentAway ? `no reply: ${bot.displayName} went on a short break (${brk?.kind ?? 'away'})` : answeredIn === -1 ? 'no reply' : `${bot.displayName} said "${reply}" after ${answeredIn} ticks (${cps.toFixed(1)} characters a second; distance ${chebyshev(bot, human)})`);
    heard.delete(bot);
});

// 2. "come here": a private message brings the bot next to the human
at(Math.max(spawnDone + 70, 150), 'come here', async () => {
    // a skilling bot with a tile 8-12 tiles away that it can walk to in at most 20 tiles (not behind a closed door or
    // a long fence; a bot inside a building may have none)
    const OFFSETS = [[10, 0], [-10, 0], [0, 10], [0, -10], [8, 8], [-8, -8], [12, 0], [0, 12], [-12, 0], [0, -12], [8, -8], [-8, 8]];
    const candidates = sim.bots().filter(p => {
        const kind = taskKind(taskOf(p)?.name);
        return p.level === 0 && SKILLING.has(kind) && !['PKer', 'EdgevillePKer'].includes(kind);
    });
    let bot = null;
    let spot = null;
    for (const p of candidates.sort(() => Math.random() - 0.5)) {
        const offset = OFFSETS.find(([dx, dz]) => {
            if (!sim.isWalkable(p.x + dx, p.z + dz, p.level)) return false;
            const walk = sim.walkDistance(p, p.x + dx, p.z + dz);
            return walk !== -1 && walk <= 20;
        });
        if (offset) {
            bot = p;
            spot = [p.x + offset[0], p.z + offset[1]];
            break;
        }
    }
    if (!bot) return check('come here: a bot to call, with open ground around it', false, `${candidates.length} candidates`);
    sim.teleportHuman(spot[0], spot[1], bot.level);
    await runTicks(2);
    const d0 = chebyshev(bot, human);
    const consumed = BotChat.onPrivateMessage(human, bot.username, 'come here');
    let best = d0;
    await runTicks(25, () => {
        best = Math.min(best, chebyshev(bot, human));
        return best <= 1;
    });
    check('come here: the private message is consumed and the bot comes next to the human', consumed && best <= 1, `${bot.displayName} (${taskKind(taskOf(bot)?.name)}): distance ${d0} -> ${best}, consumed=${consumed}`);
    const ignored = BotChat.onPrivateMessage(human, bot.username, 'hello there');
    check('come here: any other private message is not consumed', !ignored, '');
});

// 3. PKers: attack a human in the wilderness within combat range, never one outside it
at(Math.max(spawnDone + 100, 180), 'pk', async () => {
    let pker = null;
    const isPker = p => p.botPlanner === 'extras_pker' || p.botPlanner === 'extras_edgeville_pker';
    await runTicks(Math.max(20, TICKS - World.currentTick - 160), () => {
        pker = pickBot((p, b) => isPker(p) && wildernessLevelAt(p.x, p.z) >= 3 && !sim.attackTarget(p) && ['patrol', 'idle'].includes(b?.currentTask?.state));
        return pker !== null;
    });
    if (!pker) return check('pk: a PKer bot reaches the wilderness', false, 'none in time');
    const task = taskOf(pker);
    // outside: just south of the wilderness border, near the bot's x (only meaningful for a bot near the border)
    sim.copyLevels(pker);
    const wild = wildernessLevelAt(pker.x, pker.z);
    if (pker.z - 3520 <= 20) {
        sim.teleportHuman(pker.x, 3517, 0);
        let attacked = false;
        await runTicks(25, () => (attacked = sim.attackTarget(pker) === human || task?.target === human));
        check('pk: no attack on a human standing outside the wilderness', !attacked, `${pker.displayName} at wild ${wild}, human at ${human.x},${human.z}`);
    }
    // inside, a few tiles away, same combat level; the human keeps near the PKer (it patrols, and when it thinks it
    // is stuck it waits up to 40 ticks and moves to its next zone)
    const besidePker = () => {
        for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, -2]]) {
            const [x, z] = [pker.x + dx, pker.z + dz];
            if (sim.isWalkable(x, z, pker.level) && wildernessLevelAt(x, z) >= 1) {
                sim.teleportHuman(x, z, pker.level);
                return;
            }
        }
    };
    besidePker();
    let attackedIn = -1;
    const t0 = World.currentTick;
    await runTicks(150, () => {
        // (another PKer that went for the human first holds the claim on it: its attack counts too)
        if (sim.attackTarget(pker) === human || taskOf(pker)?.target === human || sim.bots().some(p => isPker(p) && sim.attackTarget(p) === human)) attackedIn = World.currentTick - t0;
        else if (chebyshev(pker, human) > 8 && wildernessLevelAt(pker.x, pker.z) >= 1) besidePker();
        return attackedIn !== -1;
    });
    const claimedBy = sim.bots().filter(p => p !== pker && taskOf(p)?.target === human).map(p => `${p.username}@${p.x},${p.z}`);
    const blacklisted = taskOf(pker)?.blacklist?.has?.(human.username) ?? false;
    check('pk: a PKer attacks a human in the wilderness within combat range', attackedIn !== -1, `${pker.displayName} (${pker.botPlanner}, cb ${pker.combatLevel}) vs human cb ${human.combatLevel} at wild ${wildernessLevelAt(human.x, human.z)}: ${attackedIn === -1 ? `no attack in 150 ticks (the human claimed by ${claimedBy.join(', ') || 'nobody'}${blacklisted ? ', blacklisted' : ''})` : `attack after ${attackedIn} ticks`}`);
    sim.teleportHuman(3222, 3218, 0); // back to Lumbridge
});

// ---- run ----
const t0 = performance.now();
/** a hurt bot (a third of its Hitpoints or less) and who was fighting it last: the death line's "by" */
const lastAttacker = new WeakMap();
// (a fight may kill a bot, as it did players: a fighter's, a PKer's; a skill or an errand should not: BotTaskBase.answerAggressor)
// (the variety work, round 2, the integrator's: the errands that are fights, port/BotChains' and BotWildTrips' hides,
// feathers, bone run and Wilderness trips, the humanlike report's combat group; their fight is a sub-task, 'Combat:errand',
// under the errand's name)
const FIGHTING_KINDS = new Set(['Combat', 'RangedMagic', 'PKer', 'EdgevillePKer', 'ComeHere', 'Hides', 'Feathers', 'BoneRun', 'WildTrip']);
/**
 * (the variety work, round 1, its second fixer) the last fight each bot was in: its task's kind, the tick, and the foe that
 * hit it then. A fight's task can end with the foe still on the bot (CombatTask fitToFight: without food against weak foes
 * it stops under 30 % of the Hitpoints, before a careless bot's own leave at 25 %), and the next task's flee is the
 * bot's: stevo2004's Combat at Edgeville's men ended at 2 of its 10 Hitpoints, its woodcutting ran from the man, which
 * killed it 36 ticks on (the world sim, seed 1, after round 1's merge), counted at a skill
 */
const lastFight = new WeakMap();
/** a death this soon after the fight, by that fight's foe, is the fight's */
const FIGHT_AFTERMATH_TICKS = 100;
function noteAttackers() {
    for (const p of sim.bots()) {
        if (p.levels[3] * 3 > p.baseLevels[3]) continue;
        for (const list of [World.npcs, World.players]) {
            for (const e of list) {
                // (an NPC acting on it: its ai_opplayer/ai_applayer modes; one running from it, following or facing it targets it too)
                if (e && e.target === p && e.level === p.level && Math.max(Math.abs(e.x - p.x), Math.abs(e.z - p.z)) <= 10 && (e.username !== undefined || (e.targetOp >= lib.NpcMode.OPPLAYER1 && e.targetOp <= lib.NpcMode.APPLAYER5))) {
                    lastAttacker.set(p, e.username ?? lib.NpcType.get(e.type)?.debugname ?? '?');
                    const kind = taskKind(sim.botPlayer(p)?.currentTask?.name);
                    if (FIGHTING_KINDS.has(kind)) lastFight.set(p, { kind, tick: World.currentTick, foe: lastAttacker.get(p) });
                }
            }
        }
    }
}
function tickOnce() {
    sim.tick();
    noteAttackers();
    observe();
    if (args.dump) dumpBot();
    // --trace=KIND (world): every 10 ticks, where each bot doing that kind of task is and what it is doing
    if (args.trace && args.trace !== 'true' && !coverage && World.currentTick % 10 === 0) {
        for (const p of sim.bots()) {
            const t = taskOf(p);
            if (taskKind(t?.name) === args.trace || args.trace === `@${p.username}`) out(`t${World.currentTick} ${p.username} ${p.x},${p.z},${p.level} ${t?.name ?? '-'}/${t?.state ?? '-'} wp=${p.hasWaypoints() ? p.waypointIndex + 1 : 0} target=${p.target?.username ?? p.target?.constructor?.name ?? '-'} op=${p.targetOp} task.target=${t?.target?.username ?? '-'}@${t?.target ? `${t.target.x},${t.target.z}` : '-'} hp=${p.levels[3]} delayed=${p.delayed ? `until t${p.delayedUntil}` : 'no'} free=${p.getInventory(lib.InvType.INV)?.freeSlotCount ?? '-'}${p.activeScript ? ` script=${p.activeScript.script?.name ?? '?'}/${p.activeScript.execution} buttons=${p.resumeButtons?.length ?? 0}` : ''}`);
        }
    }
    // an attack the bot starts on the human while either of them is outside the wilderness
    for (const p of sim.bots()) {
        const attacking = sim.attackTarget(p) === human;
        if (attacking && !attackingHuman.has(p)) {
            if (wildernessLevelAt(human.x, human.z) === 0 || wildernessLevelAt(p.x, p.z) === 0) pkOutside.push(`${p.username}@${p.x},${p.z} -> human@${human.x},${human.z} t${World.currentTick}`);
            else pkAttacksInside++;
        }
        if (attacking) attackingHuman.add(p);
        else attackingHuman.delete(p);
    }
    if (World.currentTick <= spawnDone + 20) {
        spawnView.visibleMax = Math.max(spawnView.visibleMax, sim.visibleBots());
        spawnView.playerInfoMax = Math.max(spawnView.playerInfoMax, sim.samples.at(-1).playerInfo);
    }
    // a bot within 12 tiles of the human for 3 ticks running must be in its player list (an appearance first built
    // on tick 0, or a saturated PLAYER_INFO, would leave it out)
    for (const p of sim.bots()) {
        const near = p.level === human.level && chebyshev(p, human) <= 12;
        const n = near ? (nearFor.get(p) ?? 0) + 1 : 0;
        nearFor.set(p, n);
        if (n >= 3 && !sim.sees(p)) invisible.push(`${p.username}@${p.x},${p.z} t${World.currentTick}`);
    }
}
const coverageResults = [];
async function runCoverage() {
    // spawned in tick 1, in the world after its processLogins; the AI first runs in tick 2
    while (sim.bots().length < N && World.currentTick < 20) tickOnce();
    const assigned = [];
    // (the variety work, round 1: a case that needs a kind of bot, by its name, swaps bots with a forced case: the
    // planner's cases are the ones a name moves, and a forced task keeps its own whatever the name)
    const bots = sim.bots().slice();
    coverage.forEach((c, i) => {
        if (!c.bot || !bots[i] || c.bot(bots[i].username)) return;
        const j = bots.findIndex((p, k) => coverage[k].make && !coverage[k].bot && c.bot(p.username));
        if (j >= 0) [bots[i], bots[j]] = [bots[j], bots[i]];
    });
    bots.forEach((player, i) => {
        const c = coverage[i];
        const bot = sim.botPlayer(player);
        for (const [stat, level] of Object.entries(c.levels ?? {})) player.setLevel(lib.PlayerStat[stat], level);
        lib.giveItems(player, c.inv, false);
        lib.giveItems(player, c.bank, true);
        lib.wearItems(player, c.worn);
        c.setup?.(player);
        const said = [];
        heard.set(player, said);
        if (c.plan) {
            const planner = lib.casePlanner(c.plan);
            bot.planner.pickTask = p => planner.pickTask(p);
        } else {
            bot.planner.pickTask = () => c.make();
            forced.set(player.username, c.kind);
        }
        if (args.trace) {
            const mes = player.messageGame;
            player.messageGame = function (text) {
                out(`t${World.currentTick} ${player.username} mes: ${text}`);
                return mes.call(this, text);
            };
        }
        assigned.push({ c, player, bot, start: lib.snapshot(player, said), kinds: new Set() });
    });
    while (World.currentTick < TICKS) {
        tickOnce();
        for (const a of assigned) a.kinds.add(taskKind(a.bot.currentTask?.name));
        for (const a of assigned) if (a.c.kind === '*' && a.bot.currentTask && !['Init', 'Idle'].includes(taskKind(a.bot.currentTask.name))) a.kinds.add('*');
        // a case's own progress check counts once it held (a PKer's watchdog sends it home now and then: "in the
        // Wilderness" at the last tick alone depended on where the other bots' dice left that cycle)
        if (World.currentTick % 10 === 0) for (const a of assigned) a.progressed ||= !!a.c.progress?.(a.player, a.start);
        if (args.trace) {
            for (const a of assigned) {
                const t = a.bot.currentTask;
                out(`t${World.currentTick} ${a.player.username} ${a.player.x},${a.player.z},${a.player.level} ${t?.name ?? '-'}/${t?.state ?? '-'} wp=${a.player.hasWaypoints() ? a.player.waypointIndex + 1 : 0} target=${a.player.target?.constructor?.name ?? '-'} hp=${a.player.levels[3]} delayed=${a.player.delayed}${a.player.activeScript ? ` script=${a.player.activeScript.script?.name ?? '?'}/${a.player.activeScript.execution} buttons=${a.player.resumeButtons?.length ?? 0}` : ''}`);
            }
        }
    }
    for (const a of assigned) {
        const xp = {};
        for (let s = 0; s < a.player.stats.length; s++) {
            const d = a.player.stats[s] - a.start.stats[s];
            if (d > 0) xp[STAT_NAMES[s]] = d / 10;
        }
        const skills = (a.c.skills ?? []).map(s => s.toLowerCase());
        const skillXp = skills.reduce((sum, s) => sum + (xp[s] ?? 0), 0);
        const ok = a.c.progress ? a.progressed || a.c.progress(a.player, a.start) : skillXp > 0;
        coverageResults.push({ case: a.c.name, kind: a.c.kind, started: a.kinds.has(a.c.kind), ok: a.kinds.has(a.c.kind) && ok, xp, at: `${a.player.x},${a.player.z},${a.player.level}`, state: a.bot.currentTask?.state ?? '', said: a.start.said.length });
        check(`coverage: ${a.c.name}`, a.kinds.has(a.c.kind) && ok, `${JSON.stringify(xp)} at ${a.player.x},${a.player.z} state=${a.bot.currentTask?.state ?? '-'}`);
    }
}

scenario.sort((a, b) => a.tick - b.tick);
const crowd = { arrivedIn: -1, afterStormIn: -1, arrivalMax: 0, stormMax: 0, steady: [] };
async function runCrowd() {
    // every bot stands around the human (as in a busy bank), its AI off: all of them must get into the human's
    // player list within a few ticks, and stay there when all their appearances change in the same tick
    while (sim.bots().length < N && World.currentTick < 200) tickOnce();
    // in Varrock West bank: by the spawn, the area's NPCs could kill a frozen low-level bot, which then came back to
    // life in Lumbridge, out of view
    sim.teleportHuman(3185, 3440, 0);
    tickOnce();
    const bots = sim.bots();
    const tiles = [];
    for (let r = 1; r <= 10 && tiles.length < bots.length; r++) {
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) === r && sim.isWalkable(human.x + dx, human.z + dz, human.level)) tiles.push([human.x + dx, human.z + dz]);
            }
        }
    }
    sim.freezeBots();
    bots.forEach((p, i) => p.teleJump(...tiles[i % tiles.length], human.level));
    const seenAll = () => bots.every(p => sim.sees(p));
    let t0 = World.currentTick;
    for (let i = 0; i < 20; i++) {
        tickOnce();
        crowd.arrivalMax = Math.max(crowd.arrivalMax, sim.samples.at(-1).playerInfo);
        if (crowd.arrivedIn === -1 && seenAll()) crowd.arrivedIn = World.currentTick - t0;
    }
    for (let i = 0; i < 20; i++) {
        tickOnce();
        crowd.steady.push(sim.samples.at(-1).playerInfo);
    }
    sim.rebuildAppearances();
    t0 = World.currentTick;
    for (let i = 0; i < 20; i++) {
        tickOnce();
        crowd.stormMax = Math.max(crowd.stormMax, sim.samples.at(-1).playerInfo);
        if (crowd.afterStormIn === -1 && seenAll()) crowd.afterStormIn = World.currentTick - t0;
    }
    const steadyAvg = crowd.steady.reduce((a, b) => a + b, 0) / Math.max(1, crowd.steady.length);
    check(`crowd: all ${bots.length} bots around the human are in its player list within 5 ticks`, crowd.arrivedIn !== -1 && crowd.arrivedIn <= 5, `after ${crowd.arrivedIn} ticks; PLAYER_INFO max ${crowd.arrivalMax} B (budget 4,997), then ${steadyAvg.toFixed(0)} B a tick standing still`);
    // (never in play: an appearance changes with worn items or the combat level. Past 100 the 4,997-byte budget cannot
    // carry every changed appearance at once, so the engine drops some from the list and adds them back over a few
    // ticks: 250 took 8)
    const stormTicks = bots.length <= 100 ? 5 : 10;
    check(`crowd: and still all there ${stormTicks} ticks after every appearance changed in one tick`, crowd.afterStormIn !== -1 && crowd.afterStormIn <= stormTicks, `after ${crowd.afterStormIn} ticks; PLAYER_INFO max ${crowd.stormMax} B`);
}

if (coverage) await runCoverage();
if (SCENARIO === 'crowd') await runCrowd();
for (const step of SCENARIO === 'world' && !coverage && N > 0 ? scenario : []) { // --bots=0: the baseline (heap, tick)
    if (step.tick >= TICKS) {
        check(`${step.name}: (not run: needs --ticks > ${step.tick})`, true, 'skipped');
        continue;
    }
    while (World.currentTick < step.tick) tickOnce();
    await step.run();
}
while (World.currentTick < TICKS) tickOnce();
const runMs = performance.now() - t0;

const finalStats = BotManager.stats();
check(`spawning: ${finalStats.spawned} of ${N} bots spawned, all active`, finalStats.spawned === N && finalStats.active === N, `spawned ${finalStats.spawned}, active ${finalStats.active}, skipped ${finalStats.skipped.join(',')}`);
check('errors: none (bot errors, console errors)', finalStats.errors === 0 && logStats.errors.length === 0, `${finalStats.errors} bot errors, ${logStats.errors.length} console errors`);
check('no bot on Tutorial Island', violations.tutorial.length === 0, violations.tutorial.slice(0, 3).join(' '));
if (!MEMBERS) check('free world: no bot outside F2P', violations.f2p.length === 0, `${violations.f2p.length} bot-ticks outside: ${violations.f2p.slice(0, 3).join(' ')}`);
check('pk: never an attack on a human outside the wilderness', pkOutside.length === 0, pkOutside.slice(0, 3).join(' '));
if (AGED) {
    // the tiers the roster's bots got, and their combat levels when they logged in
    const byTier = new Map();
    for (const [, t] of tracked) {
        if (!LEVELLING.has(t.planner)) continue;
        const list = byTier.get(t.tier) ?? [];
        list.push(t.combat);
        byTier.set(t.tier, list);
    }
    const tiers = [...byTier].map(([tier, list]) => `${tier} ${list.length} (cb ${Math.min(...list)}–${Math.max(...list)})`).join(', ');
    const combats = [...tracked.values()].filter(t => LEVELLING.has(t.planner)).map(t => t.combat);
    check('aged: the levelling bots\' levels spread over the tiers', byTier.size >= 3 && Math.max(...combats) - Math.min(...combats) >= 30, tiers);
    const late = [];
    for (const [name, t] of tracked) {
        if (!LEVELLING.has(t.planner) || t.tier === 'newcomer') continue;
        // (or begins a Duel Arena visit: 20-45 minutes with no XP by design, the realism work's phase 5b, as the stalls'
        // check below leaves it out. A world just started is a world in its middle: a bot first seen is mid-visit as
        // often as its hours make it, about a quarter of those with the combat and the coins: port/BotArena scheduleOf;
        // 1-3 such bots failed this at the variety work's foundation at seeds 2-4, 1-4 at round 1's merge)
        const first = Math.min(t.firstXpTick === -1 ? Infinity : t.firstXpTick, t.arenaTick ?? Infinity);
        const within = first - t.spawnTick;
        if (within > 3000) late.push(`${name} (${t.planner}, ${t.tier}, ${t.task}${t.firstXpTick === -1 ? ', none' : `, after ${within} ticks`})`);
    }
    const aged = [...tracked.values()].filter(t => LEVELLING.has(t.planner) && t.tier !== 'newcomer').length;
    check('aged: every aged levelling bot gains XP within 3,000 ticks of logging in', late.length === 0 && aged > 0, late.length ? late.join('; ') : `${aged} aged levelling bots`);
    // (and a hang-out's stand: 3-10 minutes on a tile of its own at the park, the square or a bank, by design: the
    // realism work's 2004 hotspots, port/BotHangout)
    // (and since phase 3 a social regular standing at its hub, a step about every 9-30 minutes: port/SocialTask)
    // (and since phase 5b a set piece's own stands: a staker waiting for a partner and a watcher at the Duel Arena, a
    // party's guest waiting for the drop, a scam caller at its spot; each piece ends on its own clock)
    const stalled = openStalls().filter(st => !['extras_vendor', 'extras_pker', 'extras_edgeville_pker', 'extras_social'].includes(tracked.get(st.bot)?.planner) && !/ Hangout\/stand$/.test(st.where) && !/ (DuelArena|PartyGuest|PartyHost|ScamCall|Callout)\/\w+$/.test(st.where));
    check(`aged: no stall of ${STALL_TICKS}+ ticks but vendors', PKers' and a hang-out's stand`, stalled.length === 0, stalled.slice(0, 4).map(st => `${st.bot} ${st.where} for ${st.ticks} ticks`).join('; '));
}
if (!coverage && SCENARIO !== 'crowd') {
    // vendors (port/BotTradeSpots): the most at Varrock West, the trade hub (with 6 or more placed: with
    // fewer, two whose home is a members town can by chance share one, as a free-town one is the hub's second; the
    // trade test places 60); and no bank above its talk budget (about 15 lines a minute, 34 at Varrock West)
    const vendors = sim.bots().filter(p => p.botPlanner === 'extras_vendor');
    const at = new Map();
    for (const p of vendors) {
        const key = lib.stallOf(p)?.bank.key;
        if (key) at.set(key, (at.get(key) ?? 0) + 1);
    }
    const hub = at.get('varrock_west') ?? 0;
    const placed = [...at.values()].reduce((a, b) => a + b, 0);
    if (placed >= 6) check(`vendors: the most at Varrock West, the trade hub (${placed} vendors placed)`, hub > 0 && [...at.values()].every(n => n <= hub), [...at].map(([k, n]) => `${k} ${n}`).join(', '));
    const loud = [];
    let report = '';
    for (const [bank, said] of stallLines) {
        const budget = lib.advertsPerMinute(lib.TRADE_BANKS.find(b => b.key === bank));
        let busiest = 0;
        let window = [];
        for (let i = 0, j = 0; i < said.length; i++) {
            while (said[i].tick - said[j].tick >= 100) j++;
            if (i - j + 1 > busiest) [busiest, window] = [i - j + 1, said.slice(j, i + 1)];
        }
        report += `${report ? ', ' : ''}${bank} ${busiest}/${budget}`;
        if (busiest > budget) loud.push(`${bank} ${busiest}: ${window.map(w => w.line).join(' | ')}`);
    }
    check('vendors: no bank above its talk budget (about 15 lines a minute, 34 at Varrock West)', loud.length === 0, loud.length ? loud.join('; ') : report || '-');
}
if (!coverage && SCENARIO === 'world') {
    const lost = health.deaths.filter(d => !FIGHTING_KINDS.has(d.kind.split(' ')[0]));
    check('deaths: no bot dies at a skill or on an errand (only fights kill)', lost.length === 0, `${lost.length} of ${health.deaths.length}: ${lost.slice(0, 4).map(d => `t${d.tick} ${d.bot} (${d.kind}) by ${d.by} at ${d.at}`).join('; ')}`);
}
if (!coverage && SCENARIO !== 'crowd') check('visibility: every bot that stays near the human is in its player list', invisible.length === 0, `${invisible.length} bot-ticks missing: ${invisible.slice(0, 3).join(' ')}; at most ${spawnView.visibleMax} bots in view during the spawn, PLAYER_INFO max ${spawnView.playerInfoMax} B`);

// ---- report ----
/** The levelling bots: share of their time in Lumbridge (all, and those of combat 20+), and who gained no XP. */
function levellingReport() {
    let ticks = 0, lumby = 0, ticks20 = 0, lumby20 = 0;
    const noXp = [];
    for (const p of sim.bots()) {
        const t = tracked.get(p.username);
        if (!t || !LEVELLING.has(t.planner)) continue;
        ticks += t.ticks;
        lumby += t.lumbridge;
        if (p.combatLevel >= 20) {
            ticks20 += t.ticks;
            lumby20 += t.lumbridge;
        }
        if (t.firstXpTick === -1 && !(forced.has(p.username) && !OWN_SKILLS[forced.get(p.username)])) noXp.push(`${p.username} (${t.planner}, cb ${p.combatLevel}, ${taskKind(sim.botPlayer(p)?.currentTask?.name)})`);
    }
    const pct = (a, b) => (b ? +((100 * a) / b).toFixed(1) : 0);
    const tasks20 = [...lumbridgeTasks20].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v, ticks20)}%`).join(', ');
    return { lumbridgePct: pct(lumby, ticks), lumbridgePctCombat20: pct(lumby20, ticks20), lumbridgeTasksCombat20: tasks20, noXp };
}

function dist(xs) {
    const a = [...xs].sort((p, q) => p - q);
    const avg = a.reduce((p, q) => p + q, 0) / Math.max(1, a.length);
    const pct = p => a[Math.min(a.length - 1, Math.floor(p * a.length))] ?? 0;
    return { avg: +avg.toFixed(2), p95: +pct(0.95).toFixed(2), max: +(a[a.length - 1] ?? 0).toFixed(2) };
}
const samples = sim.samples;
const afterSpawn = samples.slice(Math.ceil(N / 5) + 5);

/** The health report (see the header). */
function healthReport() {
    for (const [name, t] of tracked) {
        if (t.anchor && World.currentTick - t.anchor[3] >= LOOP_TICKS && !STATIONARY.has(t.anchor[4]) && !forced.has(name)) health.loops.push(`${name} ${t.anchor[4]} at ${t.anchor[0]},${t.anchor[1]},${t.anchor[2]} for ${World.currentTick - t.anchor[3]} ticks (to the end)`);
    }
    const own = {};
    for (const [kind, e] of tasks) {
        const skills = OWN_SKILLS[kind];
        if (!skills) continue;
        const xp = skills.reduce((sum, s) => sum + (e.xp[s] ?? 0), 0) / 10;
        own[kind] = { botTicks: e.ticks, ownXp: +xp.toFixed(1), perKiloTick: e.ticks ? +((1000 * xp) / e.ticks).toFixed(1) : 0 };
    }
    const botHours = [...tasks.values()].reduce((sum, e) => sum + e.ticks, 0) / 6000;
    const stats = lib.teleportStats;
    const byCause = Object.fromEntries([...stats.byCause].sort((a, b) => b[1][0] + b[1][1] - (a[1][0] + a[1][1])).map(([k, v]) => [k, { jumps: v[0], refused: v[1] }]));
    const repeated = [...health.byLine].filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]);
    let fp = 0x811c9dc5;
    const state = sim.bots().map(p => `${p.username}:${p.x},${p.z},${p.level}:${p.stats.reduce((a, b) => a + b, 0)}:${sim.botPlayer(p)?.currentTask?.name ?? '-'}`).sort().join('|');
    for (let i = 0; i < state.length; i++) fp = Math.imul(fp ^ state.charCodeAt(i), 16777619) >>> 0;
    return {
        botHours: +botHours.toFixed(2),
        ownSkillXp: own,
        teleports: { jumps: stats.jumps, refused: stats.refused, jumpsPerBotHour: botHours ? +(stats.jumps / botHours).toFixed(1) : 0, byCause },
        cantReach: Object.fromEntries([...health.cantReach].sort((a, b) => b[1] - a[1])),
        chat: { lines: health.lines, linesPerBotHour: botHours ? +(health.lines / botHours).toFixed(1) : 0, distinct: health.byLine.size, repeated5: repeated.length, top: repeated.slice(0, 5).map(([l, n]) => `${n}× ${l}`) },
        loops: health.loops,
        deaths: { count: health.deaths.length, byKind: Object.fromEntries(count(health.deaths.map(d => d.kind))), list: [...health.deaths.filter(d => !d.kind.endsWith('PKer')), ...health.deaths.filter(d => d.kind.endsWith('PKer'))].slice(0, 20).map(d => `t${d.tick} ${d.bot} (${d.kind}) by ${d.by} at ${d.at}`) },
        fingerprint: fp.toString(16).padStart(8, '0')
    };
}
if (globalThis.gc) globalThis.gc();
const stats = BotManager.stats();
const report = {
    bots: N,
    ticks: TICKS,
    members: MEMBERS,
    runSeconds: +(runMs / 1000).toFixed(1),
    worldStartMs: Math.round(sim.startMs),
    spawned: stats.spawned,
    active: stats.active,
    skipped: stats.skipped,
    errors: stats.errors,
    consoleErrors: logStats.errors.length,
    consoleWarnings: logStats.warnings.length,
    logLinesPerTick: +(logStats.lines / TICKS).toFixed(2),
    tickMs: dist(afterSpawn.map(s => s.cycleMs)),
    botTickMs: dist(afterSpawn.map(s => s.botMs)),
    botPathSearchesPerTick: dist(afterSpawn.map(s => s.botSearches)),
    allPathSearchesPerTick: dist(afterSpawn.map(s => s.allSearches)),
    playerInfoBytes: dist(samples.map(s => s.playerInfo)),
    heapUsedMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1),
    spawnView,
    pkAttackTicksInside: pkAttacksInside,
    stalls: openStalls().map(st => `${st.bot} ${st.where} for ${st.ticks} ticks (to t${st.until})`),
    levelling: levellingReport(),
    health: SCENARIO === 'crowd' ? undefined : healthReport(),
    checks,
    violations: { tutorial: violations.tutorial.length, f2p: violations.f2p.length, f2pSamples: violations.f2p.slice(0, 10), tutorialSamples: violations.tutorial.slice(0, 5) },
    planners: Object.fromEntries([...planners].map(([k, v]) => [k, { bots: v.bots.size, xp: v.xp }])),
    coverage: coverageResults.length ? coverageResults : undefined,
    tasks: Object.fromEntries([...tasks].sort((a, b) => b[1].ticks - a[1].ticks).map(([k, v]) => [k, { bots: v.bots.size, starts: v.starts, ticks: v.ticks, xp: v.xp }])),
    errorSamples: logStats.errors.slice(0, 12).map(e => `t${e.tick}: ${e.text.slice(0, 600)}`),
    warningSamples: logStats.warnings.slice(0, 8).map(e => `t${e.tick}: ${e.text.slice(0, 300)}`)
};
if (args.json === 'true') {
    out(JSON.stringify(report, null, 1));
} else {
    if (args.json) fs.writeFileSync(path.resolve(START_CWD, args.json), JSON.stringify({ ...report, samples }, null, 1));
    const d = (x, unit = '') => `avg ${x.avg}${unit}  p95 ${x.p95}${unit}  max ${x.max}${unit}`;
    const xp = o => Object.entries(o).map(([k, v]) => `${k} ${+(v / 10).toFixed(1)}`).join(', ') || '-';
    out(`sim: ${N} bots, ${TICKS} ticks, ${MEMBERS ? 'members' : 'free'} world, ${SCENARIO} scenario, seed ${args.seed ?? 1}${XPRATE !== 1 ? `, XP ×${XPRATE}` : ''}: ${report.runSeconds} s`);
    out(`  spawned ${stats.spawned}, active ${stats.active}, bot errors ${stats.errors}, console errors ${logStats.errors.length}, warnings ${logStats.warnings.length}, log lines/tick ${report.logLinesPerTick}`);
    out(`  world tick   ${d(report.tickMs, ' ms')}  (after the spawn ramp)`);
    out(`  bots' share  ${d(report.botTickMs, ' ms')}  (BotManager.tick)`);
    out(`  bot searches ${d(report.botPathSearchesPerTick)} per tick (all searches: ${d(report.allPathSearchesPerTick)})`);
    out(`  PLAYER_INFO  ${d(report.playerInfoBytes, ' B')}; during the spawn up to ${spawnView.visibleMax} bots in view, ${spawnView.playerInfoMax} B`);
    out(`  heap used    ${report.heapUsedMB} MB after gc${globalThis.gc ? '' : ' (run node with --expose-gc for a steady number)'}`);
    out(`  levelling bots: ${report.levelling.lumbridgePct}% of their time in Lumbridge (combat 20+: ${report.levelling.lumbridgePctCombat20}%: ${report.levelling.lumbridgeTasksCombat20 || '-'}); no XP: ${report.levelling.noXp.length ? report.levelling.noXp.join(', ') : 'none'}`);
    out('  planners:');
    for (const [k, v] of Object.entries(report.planners)) out(`    ${k.padEnd(22)} ${String(v.bots).padStart(3)} bots  xp: ${xp(v.xp)}`);
    out('  tasks (bots, starts, bot-ticks, xp):');
    for (const [k, v] of Object.entries(report.tasks)) out(`    ${k.padEnd(22)} ${String(v.bots).padStart(3)} ${String(v.starts).padStart(5)} ${String(v.ticks).padStart(7)}  ${xp(v.xp)}`);
    if (report.health) {
        const h = report.health;
        out(`  health (${h.botHours} bot-hours): XP in the task's own skill per 1,000 bot-ticks:`);
        out(`    ${Object.entries(h.ownSkillXp).sort((a, b) => b[1].botTicks - a[1].botTicks).map(([k, v]) => `${k} ${v.perKiloTick}${v.botTicks >= 2000 && v.ownXp === 0 ? ' (NONE)' : ''}`).join(', ') || '-'}`);
        out(`    teleports: ${h.teleports.jumps} unseen jumps (${h.teleports.jumpsPerBotHour} per bot-hour), ${h.teleports.refused} refused in sight; ${Object.entries(h.teleports.byCause).slice(0, 8).map(([k, v]) => `${k} ${v.jumps}/${v.refused}`).join(', ') || '-'}`);
        out(`    "I can't reach that!": ${Object.entries(h.cantReach).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
        out(`    chat: ${h.chat.lines} lines (${h.chat.linesPerBotHour} per bot-hour), ${h.chat.distinct} distinct, ${h.chat.repeated5} said 5+ times${h.chat.top.length ? `: ${h.chat.top.slice(0, 3).join('; ')}` : ''}`);
        out(`    loops (within ${LOOP_RADIUS} tiles, nothing gained, ${LOOP_TICKS}+ ticks${coverage ? '; the forced cases left out' : ''}): ${h.loops.length}${h.loops.length ? `: ${h.loops.slice(0, 4).join('; ')}` : ''}`);
        out(`    deaths: ${h.deaths.count}${h.deaths.count ? ` (${Object.entries(h.deaths.byKind).map(([k, v]) => `${k} ${v}`).join(', ')}): ${h.deaths.list.slice(0, 6).join('; ')}` : ''}`);
        out(`    fingerprint ${h.fingerprint}`);
    }
    // (in the coverage scenario a bot that used up its materials stays put by design: its task is forced)
    if (!coverage) {
        out(`  stalls (same tile, task and state, no XP or pack change, ${STALL_TICKS}+ ticks): ${report.stalls.length}`);
        for (const st of report.stalls.slice(0, 12)) out(`    ${st}`);
    }
    for (const e of report.errorSamples.slice(0, 3)) out(`  error: ${e.split('\n')[0]}`);
}
out('');
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
process.exit(checks.every(c => c.ok) ? 0 : 1);
