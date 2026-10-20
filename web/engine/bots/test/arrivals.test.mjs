#!/usr/bin/env node
// Arrivals and sessions (the realism work, phase 3, track A; docs/BOTS.md §4.4; "near you first",
// "heavier-tailed sessions", "Lumbridge newbies" and "bot friend cliques"):
//   sessions   the draw (port/BotSessions.sessionLength): median about 42 minutes, about a fifth under 10 minutes and a
//              fifth over 2 hours, 5 minutes to 6 hours with no pile-up at either end; a session under way (sessionLeft,
//              the first bots of a run) is drawn by its length; a check-in's absence is shorter (awayAfter); a test's
//              steady timing stays steady
//   cadence    the newcomer clock (newcomerPace, newcomerGap): soon below 7 level-3s about Lumbridge per 100 online,
//              none from 9, the soon gap by N; a test's "no newcomers" stays none
//   newbies    newbie by levels (port/BotNewbie): combat 10 or total level 60 ends it; about 2 newcomers in 3 are slow
//              levellers ("slower turnover"), the same for the same name
//   near first the real 274 world, a new aged world of N bots and the human at Varrock West: the bots that log in within
//              40 tiles of it (at most 25) are in within the first 3 ticks of logins, the rest at 5 a tick, nearest
//              first; the fill's ticks and its near ones in BotManager.stats(); the burst's ticks under --burst-ms
//              (1,000 by default: a cold start on a busy machine; 300 for the spec's measure at 500 bots)
//   a newbie   newcomers (a new character's): newbies with the tutorial's kit, on Newbie and Combat only, a slow
//              leveller's next task seldom a fight and a newbie's mostly (the planner's picks); given the levels a newbie
//              is one no more at once and plays as its planner from its next tick; the clock counts the level-3s about
//              Lumbridge, waits while there are plenty and lets one in every 6 looks anyway
//   cliques    BotManager._pickReturner with a fake clique (BotStartOptions.cliqueReturnBonus): a due clique-mate of an
//              online bot comes before a longer-away bot of its group; never past the role mix
//   restart    (a child process) a world started from the first one's saves and exportWorld: every bot logs in where it
//              left, the ones near the human first; the newbies are newbies still, the one given levels not
//   --burst=N  only the near-first part with N bots (500: the spec's measure; all.mjs --full runs it)
//   --cadence  and the clock at 1x and 10x XP (two child processes, 40 bots, 3,000 ticks each: newcomers at both rates,
//              never more than 15 level-3s about Lumbridge per 100 online; all.mjs --full runs it)
//
//   node --expose-gc web/engine/bots/test/arrivals.test.mjs [--bots=60] [--seed=5] [--cadence] [--burst=500 [--burst-ms=300]]
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { BOTS_DIR, BOTS_SRC, TMP_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';

/** (the variety work, round 2, Track D2) a newcomer's errands: a quest look-alike, the newbie chains (port/BotD2Picks) */
const D2_NEWBIE_KINDS = ['Quest', 'Feathers', 'Picking', 'Flour', 'Hides'];
const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const PHASE = args.phase ?? 'main';
const BURST = args.burst !== undefined ? Number(args.burst) : 0;
// the longest a tick of the burst may take: generous by default (a cold start on a busy machine; it catches an O(N²) step),
// 300 for the spec's measure on a quiet machine (--burst=500 --burst-ms=300)
const BURST_MS = Number(args['burst-ms'] ?? 1000);
const N = BURST || Number(args.bots ?? 60);
const SEED = Number(args.seed ?? 5);
const out = (s = '') => process.stdout.write(s + '\n');

function mulberry(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
Math.random = mulberry(SEED);

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
const median = xs => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const mean = xs => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const share = (xs, f) => (100 * xs.filter(f).length) / Math.max(1, xs.length);
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) + (a[2] === b[2] ? 0 : 64);

// ---- 1. the session draw and the newcomer clock (no engine) ----
if (PHASE === 'main' && !BURST) {
    const S = await importTs(path.join(BOTS_SRC, 'port/BotSessions.ts'));
    const T = S.timing();
    const random = mulberry(11);
    const draws = Array.from({ length: 100000 }, () => S.sessionLength(T.session, random));
    const minutes = draws.map(t => t / 100);
    check('sessions: median about 42 minutes (WoW: 43)', median(minutes) >= 38 && median(minutes) <= 48, `median ${median(minutes).toFixed(1)} min, mean ${mean(minutes).toFixed(1)}`);
    check('sessions: about a fifth under 10 minutes and a fifth over 2 hours (WoW: 21 %, 22 %)', share(minutes, m => m < 10) >= 17 && share(minutes, m => m < 10) <= 25 && share(minutes, m => m > 120) >= 16 && share(minutes, m => m > 120) <= 25, `${share(minutes, m => m < 10).toFixed(1)} % under 10 min, ${share(minutes, m => m < 15).toFixed(1)} % under 15, ${share(minutes, m => m > 120).toFixed(1)} % over 2 h`);
    check('sessions: 5 minutes to 6 hours, no pile-up at either end', Math.min(...draws) >= 500 && Math.max(...draws) <= 36000 && share(draws, t => t === 500) < 1 && share(draws, t => t >= 35900) < 1 && share(minutes, m => m > 180) >= 8, `${Math.min(...draws)}-${Math.max(...draws)} ticks; at 5 min ${share(draws, t => t === 500).toFixed(2)} %, at 6 h ${share(draws, t => t >= 35900).toFixed(2)} %; marathons over 3 h ${share(minutes, m => m > 180).toFixed(1)} %`);
    const left = Array.from({ length: 20000 }, () => S.sessionLeft(T.session, random));
    check('a session under way (the first bots of a run) is drawn by its length: what is left is longer than half a session', mean(left) > 1.5 * (mean(draws) / 2), `mean left ${(mean(left) / 100).toFixed(1)} min, half a mean session ${(mean(draws) / 200).toFixed(1)} min`);
    const checkIn = S.checkInTicks(T);
    const afterCheckIn = Array.from({ length: 2000 }, () => S.awayAfter(800, T, random));
    const afterLong = Array.from({ length: 2000 }, () => S.awayAfter(12000, T, random));
    check('a check-in (under 15 minutes) is followed by a shorter absence: 5-30 minutes, else 10-90', checkIn === 1500 && Math.min(...afterCheckIn) >= 500 && Math.max(...afterCheckIn) <= 3000 && Math.min(...afterLong) >= 1000 && Math.max(...afterLong) <= 9000 && median(afterCheckIn) < median(afterLong), `check-in under ${checkIn} ticks; medians ${median(afterCheckIn)} and ${median(afterLong)} ticks`);
    const steady = { session: [1e7, 1e7], away: [1e7, 1e7] };
    check("a test's steady timing stays steady (sessions and absences of 1e7)", S.sessionLength(steady.session, random) === 1e7 && S.awayAfter(100, steady, random) === 1e7 && S.awayAfter(-1, steady, random) === 1e7);
    // the clock
    const pace = [[0, 100], [5, 100], [6, 100], [8, 100], [9, 100], [30, 500], [45, 500], [2, 25], [3, 25], [1, 10], [2, 10]].map(([n, of]) => S.newcomerPace(n, of));
    // ("slower turnover": it waits from 7, was 9; regular is left for a small world's floor)
    check('the newcomer clock: soon below 7 level-3s per 100 online, waits from 7 (from 2 in a small world)', JSON.stringify(pace) === JSON.stringify(['soon', 'soon', 'soon', 'wait', 'wait', 'soon', 'wait', 'wait', 'wait', 'regular', 'wait']), pace.join(' '));
    const gaps = n => Array.from({ length: 200 }, () => S.newcomerGap('soon', n, T, random));
    const [g25, g100, g500, g10] = [25, 100, 500, 10].map(gaps);
    check('a newcomer soon: 2.5-5 minutes at 100 online, 30-60 s at 500, 10-20 minutes at 25, never later than the regular 20-40', Math.min(...g100) >= 250 && Math.max(...g100) <= 500 && Math.min(...g500) >= 50 && Math.max(...g500) <= 100 && Math.min(...g25) >= 1000 && Math.max(...g25) <= 2000 && Math.min(...g10) >= 2000 && Math.max(...g10) <= 4000 && S.newcomerGapMost('soon', 100, T) === 500, `100: ${Math.min(...g100)}-${Math.max(...g100)}, 500: ${Math.min(...g500)}-${Math.max(...g500)}, 25: ${Math.min(...g25)}-${Math.max(...g25)}, 10: ${Math.min(...g10)}-${Math.max(...g10)} ticks`);
    check('a test\'s "no newcomers" (1e7) stays none, also soon (longer than any run)', S.newcomerGap('soon', 500, { newcomer: [1e7, 1e7] }, random) >= 1e5 && S.newcomerGap('soon', 10, { newcomer: [1e7, 1e7] }, random) >= 1e6);
}

// ---- 2. the real 274 world ----
const logErrors = [];
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    console[level] = (...a) => {
        if (level !== 'error') return;
        const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
        if (!text.includes('ExperimentalWarning')) logErrors.push(text.slice(0, 300));
    };
}
const XPRATE = Number(args.xprate ?? 1);
const engineDir = prepareEngineClone(`arrivals-${PHASE}`, simWorldConfig({ members: true, xpRate: XPRATE }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/simworld.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, PlayerStat, Newbie } = lib;
const taskKind = p => (sim.botPlayer(p)?.currentTask?.name ?? 'none').split(':')[0];

// what the restart phase gets from the main one (a file under build/tmp/bots, the main process removes it)
const handoff = args.handoff ? JSON.parse(fs.readFileSync(args.handoff, 'utf8')) : null;
const saves = new Map(handoff ? Object.entries(handoff.saves).map(([k, v]) => [k, new Uint8Array(Buffer.from(v, 'base64'))]) : []);
// the fake clique of section 5 (BotStartOptions.cliqueReturnBonus): who is whose mate, and what the bonus was asked
const fake = { mates: new Map(), asked: 0 };
const STEADY = { session: [1e7, 1e7], away: [1e7, 1e7], newcomer: [1e7, 1e7], newCharacterCount: [2, 2], newCharacterDelay: [5, 10], returnGap: [5, 30], emptyWorld: 50, busyGiveUp: 600, leaveGiveUp: 50 };
const sim = await lib.Sim.create({
    bots: N,
    members: true,
    debug: false,
    ageNewBots: true,
    saves,
    ackLogouts: true,
    extra: {
        // (the cadence phase: the living world's own sessions, the clock looking every 2-4 minutes: one look in 6 lets a
        // newcomer in while it waits)
        timing: PHASE === 'cadence' ? { newcomer: [200, 400] } : STEADY,
        savedNames: () => [...saves.keys()],
        world: handoff?.world,
        cliqueReturnBonus: (name, isOnline) => {
            fake.asked++;
            const mate = fake.mates.get(name);
            return mate && isOnline(mate) ? 1 : 0;
        }
    }
});
// the human: at Varrock West (the trade hub, aged bots' banks) in the main phase, at the Lumbridge courtyard (where the
// newbies are) after the restart
const HUMAN = handoff ? [3222, 3218, 0] : [3183, 3428, 0];
sim.addHuman(...HUMAN);

// every login: its tick, name, where it came in and how far from the human
const logins = [];
const known = new Set();
let humanIn = -1;
const inView = {};
function observe() {
    const t = World.currentTick;
    if (humanIn < 0 && sim.human.slot !== -1) humanIn = t;
    for (const p of World.playerLoop.all()) {
        if (p.is_bot !== true || known.has(p.username)) continue;
        known.add(p.username);
        logins.push({ t, name: p.username, planner: p.botPlanner, at: [p.x, p.z, p.level], d: cheb([p.x, p.z, p.level], HUMAN), player: p });
    }
    if (humanIn >= 0 && [5, 100].includes(t - humanIn)) inView[t - humanIn] = sim.bots().filter(p => cheb([p.x, p.z, p.level], [sim.human.x, sim.human.z, sim.human.level]) <= 15).length;
}
function run(ticks, each = null) {
    for (let i = 0; i < ticks; i++) {
        const tick = World.currentTick;
        sim.tick();
        observe();
        each?.(tick);
    }
}

// ---- the cadence phase (a child of --cadence): a living world at --xprate, the level-3s about Lumbridge as the clock keeps them ----
if (PHASE === 'cadence') {
    const TICKS = Number(args.ticks ?? 3000);
    const samples = [];
    run(TICKS, tick => {
        if (tick % 50 !== 0 || tick < TICKS / 2) return;
        const bots = sim.bots();
        const low = bots.filter(p => p.combatLevel <= 5 && p.level === 0 && p.x >= 3140 && p.x <= 3270 && p.z >= 3140 && p.z <= 3300).length;
        samples.push([(100 * low) / Math.max(1, bots.length), (100 * bots.filter(p => lib.isNewbie(p)).length) / Math.max(1, bots.length)]);
    });
    const st = BotManager.stats();
    out(`cadence ${XPRATE}x: ${N} bots, ${TICKS} ticks; newcomers ${st.newcomers}; level-3s about Lumbridge ${mean(samples.map(s => s[0])).toFixed(1)} per 100 online, newbies ${mean(samples.map(s => s[1])).toFixed(1)} (the second half); errors ${st.errors + logErrors.length}`);
    process.exit(st.errors + logErrors.length === 0 ? 0 : 1);
}

// ---- 3. near you first ----
// (a new aged bot's place is told by its tier's bank, port/BotAge.agedStartBank, without agedStartTile's route searches)
if (!handoff && !BURST) {
    const names = lib.BOT_NAMES.filter(n => lib.isLevelling(lib.plannerOf(n))).slice(0, 400);
    const pairs = names.map(n => [n, lib.ageTierFor(n, lib.plannerOf(n))]).filter(([, tier]) => tier !== 'newcomer');
    const off = pairs.filter(([n, tier]) => {
        const tile = lib.Age.agedStartTile(n, tier, true);
        const bank = lib.Age.agedStartBank(n, tier, true);
        return !tile || !bank || cheb(tile, bank) > 4;
    });
    check("a new aged bot's place is told by its bank (agedStartBank): its start tile within 4 tiles of it", pairs.length > 100 && off.length <= pairs.length / 50, `${pairs.length - off.length} of ${pairs.length}${off.length ? `; off: ${off.slice(0, 3).map(([n]) => n).join(', ')}` : ''}`);
}
const fillTicks = Math.ceil(N / 5) + 12;
run(fillTicks);
{
    const stats = BotManager.stats();
    const first = Math.min(...logins.map(l => l.t));
    const near = logins.filter(l => l.d <= 40).sort((a, b) => a.t - b.t).slice(0, 25);
    const late = near.filter(l => l.t > first + 2);
    // the logins tick by tick go nearest first (a new bot's place is told within a few tiles: an aged bot's bank, a
    // vendor's post, the spawn; and a friend first, of which there are none here)
    const byTick = new Map();
    for (const l of logins) byTick.set(l.t, [...(byTick.get(l.t) ?? []), l.d]);
    const ticks = [...byTick.keys()].sort((a, b) => a - b);
    const inversions = ticks.slice(1).filter((t, i) => Math.min(...byTick.get(t)) + 10 < Math.max(...byTick.get(ticks[i]))).length;
    const burstMs = sim.samples.filter(s => s.tick >= first - 1 && s.tick <= first + 3).map(s => s.cycleMs);
    const laterMs = sim.samples.filter(s => s.tick > first + 3 && s.tick <= first + 12).map(s => s.cycleMs);
    const perTick = ticks.map(t => byTick.get(t).length);
    check(`near you first: the bots within 40 tiles of the human (${near.length}, at most 25) log in within the first 3 ticks of logins`, logins.length >= N && near.length >= 3 && late.length === 0, `${logins.length} logins over ${ticks.length} ticks (${perTick.slice(0, 6).join(', ')} ...); near: ${near.map(l => `t+${l.t - first} ${l.d}`).slice(0, 8).join(', ')}${late.length ? `; late: ${late.slice(0, 3).map(l => `${l.name} t+${l.t - first}`).join(', ')}` : ''}`);
    check('then 5 a tick, nearest first', perTick.slice(3, -1).every(n => n <= 5) && inversions <= 1, `${inversions} ticks out of order; logins a tick after the burst: ${perTick.slice(3, 10).join(', ')}`);
    check("BotManager.stats(): the fill's ticks and its near ones", stats.fillTicks >= 0 && stats.fillTicks <= Math.ceil((N - stats.fillNear) / 5) + 4 && Math.abs(stats.fillNear - near.length) <= Math.max(3, near.length / 5), `fillTicks ${stats.fillTicks}, fillNear ${stats.fillNear} (seen ${near.length})`);
    check(`the burst's ticks stay under ${BURST_MS} ms`, burstMs.length > 0 && Math.max(...burstMs) < BURST_MS, `world ticks over the burst ${burstMs.map(ms => ms.toFixed(0)).join(', ')} ms (the next ticks of logins ${laterMs.map(ms => ms.toFixed(0)).join(', ')}); the bots' share at most ${Math.max(...sim.samples.filter(s => s.tick >= first - 1 && s.tick <= first + 3).map(s => s.botMs)).toFixed(1)} ms`);
    if (!handoff) {
        out(`near first: ${N} bots, ${near.length} within 40 tiles of the human; ticks of logins ${perTick.slice(0, 8).join(', ')}; fill ${stats.fillTicks} ticks; burst ticks ${burstMs.map(ms => ms.toFixed(0)).join(', ')} ms (max ${Math.max(...burstMs).toFixed(0)} ms; the next ${laterMs.map(ms => ms.toFixed(0)).join(', ')} ms); the whole fill's ticks at most ${Math.max(...sim.samples.filter(s => s.tick >= first - 1 && s.tick <= first + perTick.length).map(s => s.cycleMs)).toFixed(0)} ms`);
    }
    if (handoff) {
        // after a restart: every bot logs in where it left (its save), the ones near the human first
        // (274 moves one who logs in inside the Duel Arena's fight zones to the square north of them, duel_arena_login:
        // a bot saved mid-duel, phase 5b)
        const arenaExit = (from, to) => from[2] === 0 && from[0] >= 3330 && from[0] <= 3390 && from[1] >= 3200 && from[1] <= 3260 && to[0] >= 3355 && to[0] <= 3379 && to[1] >= 3267 && to[1] <= 3279;
        const moved = logins.filter(l => handoff.world.at?.[l.name] && cheb(handoff.world.at[l.name], l.at) > 6 && !arenaExit(handoff.world.at[l.name], l.at)).map(l => `${l.name} ${handoff.world.at[l.name].join(',')} -> ${l.at.join(',')}`);
        check('after a restart every bot logs in where it left (its save; BotWorldState.at)', logins.length >= N && moved.length === 0, `${logins.length} logins; moved: ${moved.slice(0, 3).join(' | ') || 'none'}`);
    }
}

// ---- 4. newbies (newcomers after a new character: a fixed set of names, so slow and fast are known) ----
if (!BURST && !handoff) {
    const newcomers = [];
    // (2 a new character; until there is a slow leveller and two newbies that are not: since "slower turnover"
    // 2 newcomers in 3 are slow, so more rounds)
    for (let round = 0; round < 12; round++) {
        BotManager.newCharacter();
        run(40);
        for (const l of logins) if (lib.plannerOf(l.name) && !newcomers.includes(l.name) && l.player.botNewbie === true) newcomers.push(l.name);
        if (newcomers.some(n => Newbie.isSlowNewbie(n)) && newcomers.filter(n => !Newbie.isSlowNewbie(n)).length >= 2) break;
    }
    const players = newcomers.map(n => logins.find(l => l.name === n).player);
    const slow = players.find(p => Newbie.isSlowNewbie(p.username));
    const fast = players.filter(p => !Newbie.isSlowNewbie(p.username));
    const kit = p => (p.getInventory(lib.InvType.INV)?.items ?? []).filter(Boolean).map(i => i.id);
    const cameAt = p => logins.find(l => l.player === p).at;
    check('newcomers are newbies, at the courtyard, with the tutorial kit', players.length >= 3 && players.every(p => lib.isNewbie(p) && cheb(cameAt(p), [3222, 3222, 0]) <= 3 && lib.TUTORIAL_KIT.every(([id]) => kit(p).includes(id) || p.getInventory(lib.InvType.WORN)?.items.some(i => i?.id === id))), players.map(p => `${p.username}${Newbie.isSlowNewbie(p.username) ? ' (slow)' : ''} cb ${p.combatLevel} at ${cameAt(p).slice(0, 2).join(',')}`).join(', '));
    // the level test: one newbie gets the levels of a player past Lumbridge (Attack 40: combat 16, total 69)
    const levelled = fast.length > 1 ? fast[1] : null;
    const kinds = new Map(players.map(p => [p, new Map()]));
    let after = null;
    if (levelled) {
        levelled.setLevel(PlayerStat.ATTACK, 40);
        after = { task: sim.botPlayer(levelled)?.currentTask, newbieAt: World.currentTick, newbieKinds: [], changedAt: -1, isNewbie: lib.isNewbie(levelled) };
    }
    run(1300, () => {
        for (const p of players) {
            if (p.slot === -1 || p === levelled) continue;
            const k = taskKind(p);
            kinds.get(p).set(k, (kinds.get(p).get(k) ?? 0) + 1);
        }
        if (levelled && levelled.slot !== -1) {
            const task = sim.botPlayer(levelled)?.currentTask;
            if (task?.name === 'Newbie' && World.currentTick > after.newbieAt + 2) after.newbieKinds.push(World.currentTick);
            if (after.changedAt < 0 && task && task !== after.task) after.changedAt = World.currentTick - after.newbieAt;
        }
    });
    const mix = p => {
        const m = kinds.get(p);
        const total = [...m.values()].reduce((a, b) => a + b, 0);
        // (the variety work, round 2, Track D2: a newcomer's quest look-alike and newbie chains are its own too: port/BotD2Picks)
        return { newbie: (100 * (m.get('Newbie') ?? 0)) / Math.max(1, total), combat: (100 * (m.get('Combat') ?? 0)) / Math.max(1, total), other: [...m.keys()].filter(k => !['Newbie', 'Combat', 'Init', 'none', ...D2_NEWBIE_KINDS].includes(k)), total };
    };
    const stray = players.filter(p => p !== levelled && mix(p).other.length > 0).map(p => `${p.username}: ${mix(p).other.join(', ')}`);
    check('a newbie plays Newbie and Combat only (a wander, the store, Bob\'s axes, the chickens, cows and goblins), and since round 2 of the variety work a quest look-alike or a newbie chain', stray.length === 0, stray.join(' | ') || players.filter(p => p !== levelled).map(p => `${p.username} ${mix(p).newbie.toFixed(0)}/${mix(p).combat.toFixed(0)} %`).join(', '));
    const fighter = fast.find(p => p !== levelled);
    // (the planner's picks for each, 400 times: a few minutes each, so a share of picks is about a share of time; one
    // bot's 1,300 ticks may be one long fight or none)
    // (at full Hitpoints: the planner's preference, not the moment's fitness. A newbie hurt with no food takes no fight
    // until it is well again (fitToFight), and the run may end on such a tick: since phase 5a's foundation stopped bots
    // walking through scripts' delays, the fast newbie's run ended at 3 of 10 Hitpoints with only raw chicken, and none
    // of its 400 picks was a fight)
    const picks = p => {
        const planner = sim.botPlayer(p)?.planner;
        if (!planner || p.slot === -1) return null;
        const hp = p.levels[PlayerStat.HITPOINTS];
        p.levels[PlayerStat.HITPOINTS] = p.baseLevels[PlayerStat.HITPOINTS];
        // (the variety work, round 2, Track D2: a newcomer's errands, a quest look-alike or a newbie chain, about a fifth
        // of its picks, are counted apart: the fights' share is of its own picks)
        let fights = 0;
        let errands = 0;
        // (the variety work, round 2, the integrator's: the planner's fresh pick, not its keep: a newbie in the middle of an
        // errand gets that errand back at every ask, BotD2Picks.keptErrand, so a probe that came mid-errand counted 400 of
        // 400 as errands; the current task is set aside while it asks)
        const bp = sim.botPlayer(p);
        const current = bp.currentTask;
        bp.currentTask = null;
        for (let i = 0; i < 400; i++) {
            const name = planner._newbieTask(p)?.name ?? '';
            if (D2_NEWBIE_KINDS.includes(name.split(':')[0])) errands++;
            else if (name.startsWith('Combat')) fights++;
        }
        bp.currentTask = current;
        p.levels[PlayerStat.HITPOINTS] = hp;
        d2Errands.set(p, (100 * errands) / 400);
        return (100 * fights) / Math.max(1, 400 - errands);
    };
    const d2Errands = new Map();
    const [slowPicks, fastPicks] = [slow ? picks(slow) : null, fighter ? picks(fighter) : null];
    check("a slow leveller's next task is seldom a fight (under 8 % of picks), a newbie's mostly (75-95 %; its errands apart, at most 40 % of picks)", slowPicks !== null && fastPicks !== null && slowPicks < 8 && fastPicks >= 75 && fastPicks <= 95 && [...d2Errands.values()].every(v => v <= 40), `${slow?.username ?? '-'} (slow) ${slowPicks ?? '-'} % fights, ${fighter?.username ?? '-'} ${fastPicks ?? '-'} % (errands ${[...d2Errands.values()].map(v => v.toFixed(0)).join('/')} %); over 1,300 ticks Newbie/Combat ${slow ? `${mix(slow).newbie.toFixed(0)}/${mix(slow).combat.toFixed(0)}` : '-'} and ${fighter ? `${mix(fighter).newbie.toFixed(0)}/${mix(fighter).combat.toFixed(0)}` : '-'} %`);
    check('given the levels (combat 16, total 69) a newbie is one no more at once, and plays as its planner from its next tick', levelled && after.isNewbie === false && levelled.botNewbie === false && after.newbieKinds.length === 0 && after.changedAt >= 0 && after.changedAt <= 3, levelled ? `${levelled.username}: a new task after ${after.changedAt} ticks (${taskKind(levelled)}); Newbie after the levels: ${after.newbieKinds.length} ticks` : 'no second fast newbie');
    // the clock counts the level-3s about Lumbridge (as P1): BotManager's count against the world's
    BotManager._countLowLevels?.();
    const low = sim.bots().filter(p => p.combatLevel <= 5 && p.level === 0 && p.x >= 3140 && p.x <= 3270 && p.z >= 3140 && p.z <= 3300).length;
    check("the newcomer clock counts the bots of combat 5 or less about Lumbridge (the humanlike report's P1)", BotManager.stats().lowLevels === low && BotManager.stats().newbies === players.filter(p => lib.isNewbie(p)).length, `BotManager ${BotManager.stats().lowLevels} (${BotManager.stats().newbies} newbies), counted ${low} of ${sim.bots().length}`);

    // the clock waits while there are plenty of level-3s (a new aged world has its fresh accounts at the spawn), and one
    // look in 6 a newcomer comes anyway
    {
        const looks = [];
        for (let i = 0; i < 7; i++) {
            BotManager.nextNewcomer = BotManager.stats().playTicks + 1;
            const before = BotManager.stats().newcomers;
            run(1);
            looks.push(BotManager.stats().newcomers - before);
        }
        const low = BotManager.stats().lowLevels;
        check('while there are plenty of level-3s about Lumbridge the clock waits, and one look in 6 a newcomer comes anyway', low >= Math.max(2, (9 * N) / 100) && JSON.stringify(looks.slice(0, 6)) === JSON.stringify([0, 0, 0, 0, 0, 1]), `${low} level-3s of ${N}; newcomers at 7 looks: ${looks.join(' ')}`);
    }

    // ---- 5. a clique's mates come sooner, never past the role mix (BotManager._pickReturner, a fake clique) ----
    // (the groups' online counts handed in, so that the groups' shortness is exact: a levelling group's place at 60
    // online is 10.5)
    {
        const members = BotManager.members;
        const play = BotManager.stats().playTicks;
        const all = [...members.values()];
        const saved = all.map(m => [m, m.awayUntil]);
        const mate = all.find(m => m.state === 'online' && m.planner === 'skiller');
        const [b, c] = all.filter(m => m.state === 'offline' && m.planner === 'skiller' && !m.excluded);
        const f = all.find(m => m.state === 'offline' && m.planner === 'fighter' && !m.excluded);
        if (mate && b && c && f) {
            const groupsWith = short => {
                const g = BotManager._groupCounts();
                for (const p of lib.PLANNERS) g.online.set(p, lib.onlineShare(N, p) - (short[p] ?? -5));
                return g;
            };
            for (const m of all) if (m.state === 'offline') m.awayUntil = play + 1e6;
            fake.mates.set(b.name, mate.name);
            // B: a mate of an online skiller, away a short while; C: away longer; the skillers two places short
            b.awayUntil = play - 10;
            c.awayUntil = play - 1000;
            const first = BotManager._pickReturner(false, groupsWith({ skiller: 2 }))?.name ?? null;
            const asked = fake.asked;
            check("a clique: a due mate of an online bot comes before a longer-away bot of its group", first === b.name && asked > 0, `picked ${first}; the mate ${b.name}, away longer ${c.name}; the bonus asked ${asked} times`);
            // half a place short each (as the levelling groups' 10.5 makes them): a fighter away much longer comes, not the
            // mate, which a bonus would have put first and its group past its share
            c.awayUntil = play + 1e6;
            f.awayUntil = play - 100000;
            const second = BotManager._pickReturner(false, groupsWith({ skiller: 0.5, fighter: 0.5 }))?.name ?? null;
            check('never past the role mix: with half a place to fill, the mate does not come first', second === f.name, `picked ${second}; the fighter away longer ${f.name}, the mate ${b.name}`);
        } else check('a clique: a due mate comes first', false, 'no skillers or fighters to try');
        for (const [m, awayUntil] of saved) m.awayUntil = awayUntil;
        fake.mates.clear();
    }

    // ---- 6. after a restart (a child process): the saves and the living world as the runtime keeps them ----
    {
        const world = BotManager.exportWorld();
        const newbies = players.filter(p => lib.isNewbie(p)).map(p => p.username);
        check('exportWorld: every bot online has its place, and the newbies their names', sim.bots().every(p => Array.isArray(world.at?.[p.username]) && world.at[p.username][0] === p.x && world.at[p.username][1] === p.z) && newbies.length >= 1 && newbies.every(n => world.newbies?.includes(n)) && !(world.newbies ?? []).includes(levelled?.username), `${Object.keys(world.at ?? {}).length} places, newbies ${JSON.stringify(world.newbies)}`);
        const all = new Map([...saves, ...sim.saveAll()]);
        const file = path.join(TMP_DIR, `arrivals-handoff-${process.pid}.json`);
        fs.mkdirSync(TMP_DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ world, saves: Object.fromEntries([...all].map(([k, v]) => [k, Buffer.from(v).toString('base64')])), newbies, levelled: levelled?.username ?? null }));
        try {
            const r = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--phase=restart', `--handoff=${file}`, `--bots=${N}`, `--seed=${SEED + 1}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
            const lines = `${r.stdout ?? ''}`.split('\n').filter(l => /^(ok|FAIL) /.test(l));
            for (const l of lines) check(`after a restart: ${l.replace(/^(ok  |FAIL) /, '').split(' — ')[0]}`, l.startsWith('ok'), l.split(' — ')[1] ?? '');
            if (!lines.length) check('after a restart: the child ran', false, `exit ${r.status}: ${(r.stderr ?? '').slice(-400)}`);
        } finally {
            fs.rmSync(file, { force: true });
        }
    }
}

// ---- the clock at 1x and 10x (--cadence: two child processes, each a living world of N bots for 3,000 ticks) ----
if (PHASE === 'main' && args.cadence === 'true') {
    const child = xp => spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--phase=cadence', `--xprate=${xp}`, '--bots=40', `--seed=${SEED}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const parse = r => {
        const m = /newcomers (\d+); level-3s about Lumbridge ([\d.]+) per 100 online, newbies ([\d.]+)/.exec(r.stdout ?? '');
        return m ? { newcomers: Number(m[1]), low: Number(m[2]), newbies: Number(m[3]), line: (r.stdout ?? '').trim().split('\n').pop() } : { line: `exit ${r.status}: ${(r.stderr ?? '').slice(-300)}` };
    };
    const [x1, x10] = [parse(child(1)), parse(child(10))];
    // (a new store's fresh level-3 accounts start at the Lumbridge spawn: for its first half hour the clock mostly waits at
    // either rate, and lets one in now and then; at 10x the difference shows over hours, as those accounts level and leave:
    // a 6-hour run had 51 newcomers at 10x and 13 at 1x, docs/BOTS.md §7)
    check('the clock at 1x and 10x XP: newcomers come at both (it never stops for good)', x1.newcomers >= 1 && x10.newcomers >= 1, `${x1.line} | ${x10.line}`);
    check('and never overfills Lumbridge: at most 15 level-3s per 100 online in the second half at either rate', x1.low !== undefined && x10.low !== undefined && x1.low <= 15 && x10.low <= 15, `1x ${x1.low ?? '-'}, 10x ${x10.low ?? '-'} per 100 online`);
}

// ---- 7. the restart phase's own checks: the newbies are newbies still ----
if (handoff) {
    run(60);
    const back = handoff.newbies.map(n => logins.find(l => l.name === n)?.player).filter(Boolean);
    const levelled = handoff.levelled ? logins.find(l => l.name === handoff.levelled)?.player : null;
    // (those back within the 60 ticks, at least 3 of them: since "slower turnover" the newbie phase admits more
    // newcomers to find two quick ones, and a restarted world of N bots brings them back in its own order)
    check('the newbies are newbies still (below combat 10 and total level 60)', back.length >= Math.min(3, handoff.newbies.length) && back.every(p => lib.isNewbie(p)), `${back.length} of ${handoff.newbies.length} back: ${back.map(p => `${p.username} cb ${p.combatLevel}`).join(', ')}`);
    check('the one given levels is not', !handoff.levelled || (levelled && !lib.isNewbie(levelled)), handoff.levelled ? `${handoff.levelled}: ${levelled ? `cb ${levelled.combatLevel}` : 'not online'}` : 'none');
}

const stats = BotManager.stats();
check('no bot errors, no console errors', stats.errors === 0 && logErrors.length === 0, logErrors.slice(0, 2).join(' | '));
out(`arrivals${PHASE === 'main' ? '' : ` (${PHASE})`}: ${N} bots, seed ${SEED}; ${stats.spawned} logins, ${stats.newcomers} newcomers; pop-in t5 ${inView[5] ?? '-'}, t100 ${inView[100] ?? '-'}`);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
const failed = checks.filter(c => !c.ok).length;
out(failed ? `arrivals: ${failed} of ${checks.length} failed` : `arrivals: all ${checks.length} passed`);
process.exit(failed ? 1 : 0);
