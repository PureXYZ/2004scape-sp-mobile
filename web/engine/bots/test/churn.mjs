#!/usr/bin/env node
// The living world in the real rev-274 world, headless (BOTS.md §4.4, §7): N bots online out of a pool of about 2N,
// with the session durations shortened, a login thread that acknowledges logouts and keeps the saves (as
// runtime/threads.ts does), a new character half-way and the human away for a while (the title screen).
// Checks: about N online once the world filled; sessions end with a logout through the normal path and bots come back
// from that save exactly as they left (position, stats, items, no second InitTask); newcomers join at the Lumbridge
// spawn and an old account quits when the pool is over its size (never one the human has as a friend); newcomers
// come with Tutorial Island's kit and play as newbies while they are ones (a wander round the courtyard, then chickens
// and cows, newbie questions; port/BotNewbie: until combat 10 or total level 60, also when they come back), then as
// their planner; nobody stays online while the world is empty and it fills again at once, the bots that left near the
// human first; a session drawn as a check-in gets a shorter absence; the planner groups keep their share; no errors.
// --old-mix: the store was saved under the first role mix (the first 2N names, an eighth each; no saves, so they
// start fresh): the levelling groups are topped up (port/BotRoster.initialPool), the extras past their cap are the
// first to quit (BotManager._quitOne), newcomers shed the top-up (a second quit each while the pool is past its size
// before it), and the role mix online is the new one from the start.
//
//   node --expose-gc web/engine/bots/test/churn.mjs [--bots=10] [--ticks=6000] [--members=true|false] [--old-mix] [--seed=N]
//        [--xprate=N] [--debug] [--json=FILE] [--refill-debug]
//   --xprate=N  the world's XP rate (Settings: 1, 2, 5, 10, 25, 50), as in sim.mjs
//   --refill-debug  print the refill's logins in order, with how far each left from the human
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const N = Number(args.bots ?? 10);
const TICKS = Number(args.ticks ?? 6000);
const MEMBERS = (args.members ?? 'true') !== 'false';
const OLD_MIX = args['old-mix'] === 'true';
const XPRATE = args.xprate !== undefined ? Number(args.xprate) : 1;
const DEBUG = args.debug === 'true';
const START_CWD = process.cwd();

// sessions of 1-36 minutes instead of 5 min - 6 h (heavy-tailed as the app's: port/BotSessions.sessionLength, median
// 6 minutes; check-ins under 3), away 1.5-6 minutes: many log-offs and returns in a short run
// (port, phase 3: it was 3-9 minutes, log-uniform: the app's sessions were 20 min-2 h)
// The newcomer clock looks every 1.5-3 minutes (port, phase 3: it was a newcomer every 5-9): it waits while there are
// plenty of level-3s about Lumbridge (this store's levelling bots are all fresh ones there at first) and lets one in
// every 6 looks (port/BotSessions.NEWCOMER_WAIT_LOOKS), so a newcomer comes about every 9-18 minutes here
const TIMING = { session: [100, 3600], away: [150, 600], newcomer: [150, 300], newCharacterCount: [2, 2], newCharacterDelay: [10, 60], returnGap: [5, 30], emptyWorld: 50, busyGiveUp: 600, leaveGiveUp: 50 };
// a session shorter than this is a check-in (port/BotSessions.checkInTicks: three times the shortest, under the median)
const CHECK_IN = Math.min(3 * TIMING.session[0], Math.sqrt(TIMING.session[0] * TIMING.session[1]));
const NEW_CHARACTER_AT = Math.floor(TICKS * 0.4);
// the human that made the character stays on Tutorial Island this long: its newcomers wait (then follow it off)
const ISLAND_TICKS = 200;
const AWAY_FROM = Math.floor(TICKS * 0.6);
const AWAY_TICKS = 150;

{
    let s = Number(args.seed ?? 1) >>> 0 || 1;
    Math.random = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const out = (s = '') => process.stdout.write(s + '\n');
const logStats = { errors: [], warnings: [] };
let World = null;
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    const real = console[level].bind(console);
    console[level] = (...a) => {
        const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
        if (level === 'error' && !text.includes('ExperimentalWarning')) logStats.errors.push(`t${World?.currentTick}: ${text}`);
        if (level === 'warn') logStats.warnings.push(`t${World?.currentTick}: ${text}`);
        if (DEBUG) real(...a);
    };
}

const engineDir = prepareEngineClone(`churn-${MEMBERS ? 'p2p' : 'f2p'}`, simWorldConfig({ members: MEMBERS, xpRate: XPRATE }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/simworld.ts'), path.join(engineDir, 'tsconfig.json'));
World = lib.World;
const { BotManager, BotPlayer, PlayerLoading, Packet } = lib;
// a fresh store: the pool is the first names (without the vendors, PKers and social bots past twice their share), so
// a name not in it is a newcomer's; an old-mix store: the first 2N names, and fresh levelling names up to one short of
// each group's place
const oldMix = OLD_MIX ? lib.BOT_NAMES.slice(0, Math.min(2 * N, lib.BOT_NAMES.length)) : [];
const firstPool = new Set(lib.initialPool(N, oldMix, () => true, () => false).entries.map(e => e.name));
const newcomerNames = { has: name => !firstPool.has(name), size: 0 };

// the bot store: saves by name, the names that quit, the bots the human has as friends
const saves = new Map();
const quit = new Set();
const quitOrder = []; // [name, planner], in order
const friends = new Set();
let humanHere = true;
const sim = await lib.Sim.create({
    bots: N,
    members: MEMBERS,
    debug: DEBUG,
    saves,
    ackLogouts: true,
    humanPresent: () => humanHere && sim.human.slot !== -1,
    extra: {
        timing: TIMING,
        savedNames: () => [...oldMix, ...saves.keys()],
        isQuit: name => quit.has(name),
        onQuit: name => {
            saves.delete(name);
            quit.add(name);
            quitOrder.push([name, lib.plannerOf(name)]);
        },
        isFriendOfHuman: name => friends.has(name)
    }
});
sim.addHuman(3180, 3240, 0);
// the pool BotManager built, before any newcomer (an old-mix store's: topped up)
const startPool = BotManager.stats().pool;

// ---- observation ----
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
const COURTYARD = [3222, 3222]; // where 274 puts a player off Tutorial Island
const seen = new Map(); // name -> { player, logins, restoreMismatches, initAgain }
const restores = { exact: 0, mismatches: [] };
const leaveTicks = [];
const leavingSince = new Map();
const onlineSamples = []; // [tick, active] while a human is here and after the first fill
const plannerGaps = { ticks: 0, missing: 0 };
const roleMix = new Map(); // planner -> bot-ticks online
const newcomerSpawns = [];
// newcomers (port/BotNewbie): name -> { player, kit, during: task kinds while a newbie, after: task kinds once it is
// none (port, phase 3: newbie time measured in levels, it was its first 5-15 minutes), lines while a newbie, logins }
const newbies = new Map();
// (port, the realism work's phase 2: a newbie's questions and begs are said with the 'newbie' kind, its own lines of
// port/BotNewbie 60 % of the time and upstream's newbie questions the rest, styled; 3-8 lines an hour since phase 3, a slow leveller 1.5-4)
lib.sayListeners.push((player, text, kind) => {
    const n = newbies.get(player.username);
    if (n && n.player === player && lib.isNewbie(player)) n.lines.push({ text, kind });
});
// (port, phase 3) a newcomer back in the world below a newbie's levels: a newbie again? [name, newbie]
const newbieReturns = [];
// (port, phase 3) sessions and the absences after them: name -> { in, out } of its current or last session; [length, absence]
const sessionTimes = new Map();
const absences = [];
const awaysSet = []; // [the session's drawn length (-1: not drawn), the absence set at the logout]
// (port, phase 3: near you first) every bot's place when it left, and the logins of the refill after the empty world
const leftAt = new Map();
const refillLogins = [];
const emptyLeavers = new Set();
let firstFilledAt = -1;
let refilledAt = -1;
let emptyAt = -1;

function snapshotOf(player) {
    const inv = id => {
        const inventory = player.getInventory(id);
        const items = [];
        for (let i = 0; i < (inventory?.capacity ?? 0); i++) {
            const it = inventory.get(i);
            if (it) items.push(`${it.id}x${it.count}`);
        }
        return items.join(',');
    };
    return { x: player.x, z: player.z, level: player.level, stats: Array.from(player.stats).join(','), inv: inv(93), worn: inv(94), bank: inv(95) };
}

const leftLastTick = [];
function observe(tick) {
    const stats = BotManager.stats();
    // the absence BotManager set for the bots that left last tick: after a session drawn as a check-in, a shorter one
    // (not after a resumed session, or a run's first, whose length was not drawn: drawn -1)
    for (const name of leftLastTick.splice(0)) {
        const m = BotManager.members?.get(name);
        if (m && m.state === 'offline' && m.resume === 0 && !m.retiring) awaysSet.push([m.drawn, m.awayUntil - stats.playTicks]);
    }
    const present = humanHere && sim.human.slot !== -1;
    // every bot in the world, from the tick processLogins took it (before its first AI tick)
    for (const player of World.playerLoop.all()) {
        if (player.is_bot !== true) continue;
        let s = seen.get(player.username);
        if (!s) seen.set(player.username, (s = { player: null, logins: 0 }));
        if (s.player !== player) {
            // a new login of this name: compare with the save it came back from
            if (s.logins > 0 && s.lastSave) {
                const now = snapshotOf(player);
                const saved = snapshotOf(PlayerLoading.load(player.username, new Packet(s.lastSave), null));
                const diff = Object.keys(now).filter(k => now[k] !== saved[k]);
                if (diff.length === 0) restores.exact++;
                else restores.mismatches.push(`${player.username} t${tick}: ${diff.join(', ')}${diff.includes('x') || diff.includes('z') ? ` (saved at ${saved.x},${saved.z}, in at ${now.x},${now.z})` : ''}`);
                const planner = player._bot?.planner;
                if (!planner || planner.initialised !== true) restores.mismatches.push(`${player.username} t${tick}: InitTask would run again`);
            }
            if (s.logins === 0 && newcomerNames.has(player.username)) newcomerNames.size++;
            if (s.logins === 0 && newcomerNames.has(player.username) && Math.max(Math.abs(player.x - COURTYARD[0]), Math.abs(player.z - COURTYARD[1])) <= 3) newcomerSpawns.push(player.username);
            if (s.logins === 0 && newcomerNames.has(player.username)) newbies.set(player.username, { player, kit: null, during: new Set(), after: new Set(), lines: [] });
            else if (newbies.has(player.username)) {
                // a newcomer back: a newbie again while below combat 10 and total level 60
                const n = newbies.get(player.username);
                n.player = player;
                const total = player.baseLevels.reduce((sum, level, stat) => (stat === 18 || stat === 19 ? sum : sum + level), 0);
                if (player.combatLevel < 10 && total < 60) newbieReturns.push([player.username, lib.isNewbie(player)]);
            }
            const st = sessionTimes.get(player.username);
            if (st && st.out >= 0 && present && emptyAt < 0) absences.push([st.out - st.in, tick - st.out]);
            sessionTimes.set(player.username, { in: tick, out: -1 });
            if (present && emptyAt >= 0 && refilledAt < 0) {
                // (how far from the human it was when it left: its place now, as the refill began)
                const at = leftAt.get(player.username);
                const h = sim.human;
                refillLogins.push({ t: tick, name: player.username, friend: friends.has(player.username), d: at ? Math.max(Math.abs(at[0] - h.x), Math.abs(at[1] - h.z)) + (at[2] === h.level ? 0 : 64) : Infinity });
            }
            s.player = player;
            s.logins++;
        }
    }
    for (const [name, s] of seen) {
        if (s.player && s.player.slot === -1) {
            s.lastSave = saves.get(name);
            leftAt.set(name, [s.player.x, s.player.z, s.player.level]);
            // (the bots the empty world sent out: the refill brings them back first, nearest first)
            if (!present && emptyAt < 0) emptyLeavers.add(name);
            const st = sessionTimes.get(name);
            if (st) st.out = tick;
            // (the absence BotManager sets: read next tick, once its tick has seen the bot gone)
            leftLastTick.push(name);
            s.player = null;
            if (leavingSince.has(name)) leaveTicks.push(tick - leavingSince.get(name));
            leavingSince.delete(name);
        }
    }
    // a newcomer: its kit once its first task after InitTask starts, what it does while a newbie and after
    for (const [, n] of newbies) {
        if (n.player.slot === -1) continue;
        const kind = (n.player._bot ?? sim.botPlayer(n.player))?.currentTask?.name?.split(':')[0];
        if (!kind || kind === 'Init') continue;
        if (n.kit === null) n.kit = snapshotOf(n.player);
        // (port, phase 3: newbie time ends with its levels; a task begun as a newbie may run a moment past them: the
        // rescan or the task's end asks the planner again. The newbie wander ends at once (NewbieTask.shouldRun): the
        // tick after the levels came, as a level-up after the bots' turn shows only then)
        if (lib.isNewbie(n.player)) {
            n.during.add(kind);
            n.newbieTicks = (n.newbieTicks ?? 0) + 1;
            n.notSince = -1;
        } else if (n.notSince === undefined || n.notSince < 0) n.notSince = tick;
        else if (tick > n.notSince + 1) n.after.add(kind);
    }
    if (firstFilledAt < 0 && stats.active >= N) firstFilledAt = tick;
    if (present && firstFilledAt >= 0 && (emptyAt < 0 || refilledAt >= 0)) onlineSamples.push(stats.active);
    if (!present && emptyAt < 0 && stats.active === 0 && stats.leaving === 0) emptyAt = tick;
    if (present && emptyAt >= 0 && refilledAt < 0 && stats.active >= N - 1) refilledAt = tick;
    // the planner groups: with 16+ online every group has a bot online (vendors, PKers, social bots keep their places);
    // like the online count, not while the world fills again (the bots near the human come first: at 1000 online the
    // refill takes 200+ ticks, and a group far from the human comes last)
    if (present && firstFilledAt >= 0 && (emptyAt < 0 || refilledAt >= 0) && N >= 16) {
        plannerGaps.ticks++;
        const groups = new Set([...BotManager.activeBots()].map(p => p.botPlanner));
        if (groups.size < 8) plannerGaps.missing++;
        // the role mix: how many of each group are online (averaged at the end)
        for (const p of BotManager.activeBots()) roleMix.set(p.botPlanner, (roleMix.get(p.botPlanner) ?? 0) + 1);
    }
    return stats;
}

// the bots that log out: from when they start leaving (stats.leaving) to when they are gone
const leaving = BotPlayer.prototype.windDown;
BotPlayer.prototype.windDown = function () {
    leavingSince.set(this.player.username, World.currentTick);
    return leaving.call(this);
};

// two bots become friends of the human early on: they never quit
let befriended = false;
const island = { before: 0, during: -1 };
const t0 = performance.now();
let stats = null;
for (let i = 0; i < TICKS; i++) {
    const tick = World.currentTick;
    if (i === NEW_CHARACTER_AT) {
        sim.teleportHuman(3094, 3107, 0); // Tutorial Island
        BotManager.newCharacter();
        island.before = BotManager.stats().newcomers;
    }
    if (i === NEW_CHARACTER_AT + ISLAND_TICKS) {
        island.during = BotManager.stats().newcomers - island.before;
        sim.teleportHuman(3180, 3240, 0);
    }
    if (i === AWAY_FROM) humanHere = false;
    if (i === AWAY_FROM + AWAY_TICKS) humanHere = true;
    sim.tick();
    await null; // the login thread's replies (logout acknowledgements) arrive on a microtask, as in the worker
    stats = observe(tick);
    if (!befriended && stats.active >= 2) {
        for (const p of [...BotManager.activeBots()].filter(p => ['skiller', 'fighter', 'balanced', 'random'].includes(p.botPlanner)).slice(0, 2)) friends.add(p.username);
        befriended = friends.size === 2;
    }
}
const runMs = performance.now() - t0;

// ---- checks ----
const near = onlineSamples.filter(n => Math.abs(n - N) <= Math.max(2, Math.ceil(N * 0.2))).length;
const sorted = [...leaveTicks].sort((a, b) => a - b);
const pct = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
// (an old-mix store's pool stays as big as it started: one bot quits per newcomer)
const pool = OLD_MIX ? firstPool.size : Math.min(2 * N, lib.BOT_NAMES.length);
// (5 logins a tick; as when it fills again below, the last few may come a few ticks late: N / 50 of them)
check(`the world filled to ${N} online`, firstFilledAt >= 0 && firstFilledAt <= Math.ceil(N / 5) + 10 + Math.ceil(N / 50), `at tick ${firstFilledAt}`);
check('about N online while a human is here (within 20%, 90% of the time)', onlineSamples.length > 0 && near / onlineSamples.length >= 0.9, `${((100 * near) / Math.max(1, onlineSamples.length)).toFixed(1)}% of ${onlineSamples.length} ticks; min ${Math.min(...onlineSamples)}, max ${Math.max(...onlineSamples)}`);
// (port, phase 3: sessions are heavy-tailed now, as the app's: a share of them outlast a short run, so a run has fewer
// log-offs and returns than with 3-9 minute sessions: at least N/2 log-offs and N/4 returns, was N and N/2)
check('sessions end with a logout', stats.logoffs >= N / 2, `${stats.logoffs} log-offs`);
check('bots come back', stats.returns >= N / 4 && restores.exact >= N / 4, `${stats.returns} returns, ${restores.exact} checked`);
// (port, phase 3) a check-in (a session drawn under CHECK_IN) is followed by a shorter absence: BotManager set half the
// shortest to three times the shortest after one, the usual range after any other (port/BotSessions.awayAfter). How long
// they stayed away is mostly the queue for a place (the group most short, the longest overdue first; at first the bots
// never online yet): the medians are told, not judged
{
    const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const [lo, hi] = TIMING.away;
    const checkIns = awaysSet.filter(([drawn]) => drawn >= 0 && drawn < CHECK_IN);
    const others = awaysSet.filter(([drawn]) => drawn < 0 || drawn >= CHECK_IN);
    const wrong = [...checkIns.filter(([, away]) => away > Math.min(hi, 3 * lo) + 1 || away < Math.round(lo / 2) - 1), ...others.filter(([, away]) => away > hi + 1 || away < lo - 1)];
    const after = absences.filter(([len]) => len < CHECK_IN).map(([, away]) => away);
    const longer = absences.filter(([len]) => len >= CHECK_IN).map(([, away]) => away);
    check(`a check-in (a session drawn under ${CHECK_IN} ticks) gets a shorter absence (${Math.round(lo / 2)}-${Math.min(hi, 3 * lo)} ticks, else ${lo}-${hi})`, checkIns.length >= 1 && others.length >= 1 && wrong.length === 0, `${checkIns.length} check-ins (median set ${checkIns.length ? median(checkIns.map(a => a[1])) : '-'}), ${others.length} others (${others.length ? median(others.map(a => a[1])) : '-'}); out of range: ${wrong.length}; the absences seen: median ${after.length ? median(after) : '-'} ticks after ${after.length} short sessions, ${longer.length ? median(longer) : '-'} after ${longer.length} longer`);
}
check('a bot comes back exactly as it left (position, stats, items, bank; no second InitTask)', restores.mismatches.length === 0, restores.mismatches.slice(0, 4).join(' | '));
check('bots leave quickly (p95 within the give-up time)', sorted.length > 0 && pct(0.95) <= TIMING.leaveGiveUp, `p50 ${pct(0.5)}, p95 ${pct(0.95)}, max ${sorted[sorted.length - 1] ?? '-'} ticks over ${sorted.length} log-offs`);
// (the slower turnover: the clock waits while plenty of level-3s are about Lumbridge, as in a world of
// fresh bots at 500 online: a new character's two may be all; at 25 online the timer brings more)
check('newcomers joined (a new character\'s two, and the timer\'s while few level-3s are about)', stats.newcomers >= TIMING.newCharacterCount[0], `${stats.newcomers} newcomers`);
if (N >= 50) {
    // 17.5 % of the places each levelling group, 7.5 % each extra (vendors, social bots, both kinds of PKers)
    const avg = p => (roleMix.get(p) ?? 0) / Math.max(1, plannerGaps.ticks);
    const off = lib.PLANNERS.filter(p => Math.abs(avg(p) - lib.onlineShare(N, p)) > Math.max(2, 0.25 * lib.onlineShare(N, p)));
    check('the role mix: each group about its share of the places online', off.length === 0, lib.PLANNERS.map(p => `${p} ${avg(p).toFixed(1)}/${lib.onlineShare(N, p).toFixed(1)}`).join(', '));
}
// newbie newcomers (port/BotNewbie)
{
    const list = [...newbies.entries()];
    const has = (snap, id, count) => [snap.inv, snap.worn].some(items => items.split(',').some(it => it === `${id}x${count}`));
    const badKit = list.filter(([, n]) => n.kit !== null && (!lib.TUTORIAL_KIT.every(([id, count]) => has(n.kit, id, count)) || n.kit.bank !== `995x${lib.TUTORIAL_COINS}` || n.kit.inv.split(',').some(it => it.startsWith('995x')))).map(([name, n]) => `${name}: pack ${n.kit.inv}; worn ${n.kit.worn}; bank ${n.kit.bank}`);
    check("newcomers come with Tutorial Island's kit and 25 coins in the bank (no starter coins)", list.length >= TIMING.newCharacterCount[0] && list.every(([, n]) => n.kit !== null) && badKit.length === 0, `${list.length} newcomers; ${badKit.slice(0, 2).join(' | ')}`);
    // (the variety work, round 2, Track D2: a newcomer's quest look-alike now and then, and a newbie chain: the farm's
    // feathers, picking, flour, cowhides; port/BotD2Picks d2NewbiePick, the quest look-alikes)
    const NEWBIE_KINDS = new Set(['Newbie', 'Combat', 'Quest', 'Feathers', 'Picking', 'Flour', 'Hides']);
    const strays = list.filter(([, n]) => [...n.during].some(k => !NEWBIE_KINDS.has(k))).map(([name, n]) => `${name}: ${[...n.during].join(', ')}`);
    // (port, phase 3: a slow leveller mostly wanders. The "slower turnover": 2 newcomers in 3 are slow
    // and fight one plan in 200, so a run's newcomers may all only wander (five did at 25 online): a fast one that was a
    // newbie for 15 minutes of the run fights, at 85 % a plan of a few minutes)
    const tried = list.filter(([name, n]) => !lib.Newbie.isSlowNewbie(name) && (n.newbieTicks ?? 0) >= 1500);
    check("a newbie: a wander round the courtyard, then chickens and cows (Newbie, Combat), a quest look-alike or a newbie chain, and nothing else; a fast one with 15 minutes as a newbie fights", list.every(([, n]) => n.during.has('Newbie')) && tried.every(([, n]) => n.during.has('Combat')) && strays.length === 0, `${list.map(([name, n]) => `${name} (${lib.Newbie.isSlowNewbie(name) ? 'slow' : 'fast'}, ${n.newbieTicks ?? 0} ticks): ${[...n.during].join('+')}`).join('; ')}`);
    // (port, phase 2: at a newbie's rate, 3-8 lines an hour since phase 3, the first within 1-4 minutes, most newcomers ask or beg; upstream
    // said one every 80 ticks and this asked for a line per newcomer)
    const askers = list.filter(([, n]) => n.lines.some(l => l.kind === 'newbie'));
    const asked = list.reduce((sum, [, n]) => sum + n.lines.filter(l => l.kind === 'newbie').length, 0);
    check('newbies ask newbie questions and beg', askers.length >= Math.ceil(list.length / 2), `${askers.length} of ${list.length} newcomers, ${asked} newbie lines`);
    const lingering = list.filter(([, n]) => n.after.has('Newbie')).map(([name]) => name);
    check('once past a newbie\'s levels, a newcomer plays as its planner (no newbie wander)', lingering.length === 0, `${lingering.join(', ') || `${list.filter(([, n]) => n.after.size > 0).length} of ${list.length} outgrew it in the run`}`);
    // (port, phase 3: newbie time measured in levels) a newcomer that comes back below combat 10 and total level 60 is a newbie still
    const lapsed = newbieReturns.filter(([, newbie]) => !newbie).map(([name]) => name);
    // (arrivals.test's restart checks it every run; here only when a run has such a return: said so when it has none)
    check('a newcomer back in the world below a newbie\'s levels is a newbie still', lapsed.length === 0, newbieReturns.length === 0 ? 'not exercised: no such return in this run' : `${newbieReturns.length} such returns${lapsed.length ? `; not a newbie: ${lapsed.join(', ')}` : ''}`);
}
check('newcomers start at the Lumbridge courtyard', newcomerNames.size === stats.newcomers && newcomerSpawns.length === stats.newcomers, `${newcomerSpawns.length} of ${stats.newcomers} seen there`);
check(`a new character's newcomers wait while it is on Tutorial Island, then follow it`, island.during === 0 && stats.newcomers - island.before >= 2, `${island.during} came in ${ISLAND_TICKS} ticks on the island, ${stats.newcomers - island.before} after it`);
check(`old accounts quit when the pool is over ${pool}`, stats.quits >= 1 && stats.pool <= pool + 1, `${stats.quits} quits, pool ${stats.pool}`);
if (OLD_MIX) {
    // the extras past their cap (an eighth of the store each; now 15 % of N, 7.5 % of the pool) quit first
    const extras = lib.PLANNERS.filter(p => !lib.isLevelling(p));
    const excess = extras.reduce((sum, p) => sum + Math.max(0, oldMix.filter(n => lib.plannerOf(n) === p).length - lib.groupCap(N, p)), 0);
    const first = quitOrder.slice(0, excess);
    check(`an old-mix store: the extras past their cap quit first (${excess} over)`, quitOrder.length >= 1 && first.every(([, p]) => !lib.isLevelling(p)), quitOrder.map(([n, p]) => `${n} (${p})`).join(', '));
    check(`an old-mix store: the levelling groups topped up (${startPool} in the pool)`, startPool === firstPool.size && startPool > oldMix.length && lib.PLANNERS.filter(lib.isLevelling).every(p => [...firstPool].filter(n => lib.plannerOf(n) === p).length >= Math.floor(lib.poolShare(N, p)) - 1), `BotManager's pool ${startPool}, initialPool's ${firstPool.size}, the store's ${oldMix.length}`);
    // newcomers shed what the top-up added: a second bot quits per newcomer while the pool is past its size before it
    const shed = Math.max(oldMix.length, firstPool.size - stats.newcomers);
    check(`an old-mix store: newcomers shed the top-up (${firstPool.size} -> ${stats.pool} after ${stats.newcomers} newcomers)`, stats.newcomers >= 1 && stats.pool <= shed + 1, `${stats.quits} quits; at most ${shed + 1} expected`);
}
check('a bot the human has as a friend never quits', [...friends].every(n => !quit.has(n)), [...friends].join(', '));
check('a name that quit is never used again', [...quit].every(n => !BotManager.ownsName(n)));
check('nobody stays online while the world is empty', emptyAt >= 0 && emptyAt - AWAY_FROM <= TIMING.emptyWorld + 30, `empty at tick ${emptyAt} (the human left at ${AWAY_FROM})`);
// (at 500 online about one session ends a tick, so the last bot or two may take a few ticks more: N / 50 of them)
check('the world fills again when the human is back', refilledAt >= 0 && refilledAt - (AWAY_FROM + AWAY_TICKS) <= Math.ceil(N / 5) + 15 + Math.ceil(N / 50), `refilled at ${refilledAt} (the human back at ${AWAY_FROM + AWAY_TICKS})`);
// (port, phase 3: "near you first") the bots that left within 40 tiles of the human (at most 25, after its
// friends) are back within the refill's first few ticks; the logins go nearest first
{
    const back = AWAY_FROM + AWAY_TICKS;
    // (the bots the empty world sent out, back once each: a bot whose session ran out during the refill is replaced by
    // a pick that joins the order then, wherever it is)
    const seenBack = new Set();
    const logins = refillLogins.filter(l => !l.friend && emptyLeavers.has(l.name) && !seenBack.has(l.name) && seenBack.add(l.name));
    const near = logins.filter(l => l.d <= 40).slice(0, 25);
    const late = near.filter(l => l.t > back + 5).map(l => `${l.name} t+${l.t - back}`);
    // (by tick: the bots of a later tick are not much nearer than those of the tick before; only those whose place the
    // run saw, as they left: a pool bot that never was online logs in where a new bot does)
    const byTick = new Map();
    for (const l of logins) if (l.d < Infinity) byTick.set(l.t, [...(byTick.get(l.t) ?? []), l.d]);
    const ticks = [...byTick.keys()].sort((a, b) => a - b);
    let inversions = 0;
    for (let i = 1; i < ticks.length; i++) if (Math.min(...byTick.get(ticks[i])) + 8 < Math.max(...byTick.get(ticks[i - 1]))) inversions++;
    if (DEBUG || args['refill-debug'] === 'true') process.stdout.write(`refill logins: ${refillLogins.map(l => `t+${l.t - back} ${l.name}${l.friend ? ' (friend)' : ''} ${l.d}`).join(', ')}\n`);
    check('the refill: the bots that left near the human come first (within 5 ticks), then the nearest first', logins.length > 0 && late.length === 0 && inversions <= Math.max(1, Math.ceil(ticks.length / 10)), `${logins.length} logins, ${near.length} near in ticks ${near.length ? `${near[0].t - back}-${near[near.length - 1].t - back}` : '-'}${late.length ? `; late: ${late.slice(0, 4).join(', ')}` : ''}; ${inversions} out of order; fill ${stats.fillTicks} ticks, ${stats.fillNear} near`);
}
if (N >= 16) check('every planner group stays online (vendors, PKers, social bots)', plannerGaps.missing / Math.max(1, plannerGaps.ticks) <= 0.1, `${plannerGaps.missing} of ${plannerGaps.ticks} ticks with a group missing`);
check('no bot errors, no console errors', stats.errors === 0 && logStats.errors.length === 0, logStats.errors.slice(0, 3).join(' | '));
check('no warnings', logStats.warnings.length === 0, logStats.warnings.slice(0, 3).join(' | '));

const report = { bots: N, ticks: TICKS, members: MEMBERS, xpRate: XPRATE, seconds: +(runMs / 1000).toFixed(1), stats, restores: { exact: restores.exact, mismatches: restores.mismatches.length }, leaveTicks: { p50: pct(0.5), p95: pct(0.95), max: sorted[sorted.length - 1] ?? 0 }, checks };
if (args.json) fs.writeFileSync(path.resolve(START_CWD, args.json), JSON.stringify(report, null, 1));
out(`churn: ${N} online, pool ${stats.pool}, ${TICKS} ticks, ${MEMBERS ? 'members' : 'free'} world, seed ${args.seed ?? 1}${XPRATE !== 1 ? `, XP ×${XPRATE}` : ''}: ${report.seconds} s; ${stats.logoffs} log-offs, ${stats.returns} returns, ${stats.newcomers} newcomers, ${stats.quits} quits, ${stats.spawned} logins`);
out('');
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
process.exit(checks.every(c => c.ok) ? 0 : 1);
