#!/usr/bin/env node
// Habits and human timing (the realism work, phase 2: port/BotHabits, port/BotTiming, the tasks' re-target and bank-stop
// sites, BotManager._endSession, PKerTask's lurk; the trade's accept delay is trade.test.mjs's):
//   timing     'next' (the next round of the same thing) is wide: over the levelling personas (and for 90 % of them)
//              under 10.5 % of two draws in a row are the same tick count, a mean of 4-9 ticks; 'page' quick; a bank
//              stop varies (CV ≥ 0.3)
//   a world    the real 274 world, 40 aged bots, the living world with short sessions, breaks 30 and lingers 25 times as
//              often as the personas say (port/BotHabits.setHabitRatesForTest), for 2,500 ticks:
//     breaks   they happen; none in the Wilderness, a fight, a trade, a conversation or on the human's errand; a bot on a
//              break (not AFK-skilling) neither walks nor jumps (the watchdog waits); 20-85 s each, its time up or cut
//              short by what may cut it (port/BotHabits.lastBreakOf); a linger 2-2.5 min; isAway says so (a linger is no
//              break)
//     brb      every "brb" comes with a break of 45 s or more (or the bot left, or something cut it short); "back" only
//              after a "brb"
//     ends     a fight (the combat logout lock) or the human's errand ends a break at once
//     a look   a dance draws a look from a free levelling bot near it: it stops, faces the dancer, plays on within
//              10 s; not again right after
//     targets  after a lost target the next comes later than a tick: at most 10 % within one per task kind with 50+
//              (as the humanlike report's H17 counts kinds with enough of them), at most 5 % of all (the game's
//              auto-retaliate left out, as the humanlike report does)
//     banks    bank stops vary: CV ≥ 0.3 over all of them
//     leaving  sessions end with logouts; at most 25 % mid-walk; each goodbye said is followed by that bot's logout
//              within 10 ticks (one hit meanwhile once the game's logout lock is over); some log out at a bank
//     lurk     deep PKers on patrol stand still part of the time (at least 30 % of their patrol ticks)
//     errors   none
//
//   node --expose-gc web/engine/bots/test/habits.test.mjs [--bots=40] [--ticks=2500] [--seed=3]
import path from 'path';
import { BOTS_DIR, BOTS_SRC, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const N = Number(args.bots ?? 40);
const TICKS = Number(args.ticks ?? 2500);
const SEED = Number(args.seed ?? 3);
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
const pct = (a, b) => (b ? (100 * a) / b : 0);
const median = xs => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const cv = xs => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) / m;
};

// ---- 1. timing (no engine) ----
{
    const P = await importTs(path.join(BOTS_SRC, 'port/BotPersona.ts'));
    const T = await importTs(path.join(BOTS_SRC, 'port/BotTiming.ts'));
    const R = await importTs(path.join(BOTS_SRC, 'port/BotRoster.ts'));
    const random = mulberry(11);
    const personas = R.BOT_NAMES.filter(n => R.isLevelling(R.plannerOf(n))).slice(0, 400).map(n => P.personaOf(n));
    let same = 0;
    let pairs = 0;
    const next = [];
    // (per persona: the chance two of its rounds in a row take the same ticks)
    const perPersona = [];
    for (const p of personas) {
        let prev = -1;
        const counts = new Map();
        for (let i = 0; i < 300; i++) {
            const d = T.reactionTicks(p, 'next', random);
            next.push(d);
            counts.set(d, (counts.get(d) ?? 0) + 1);
            if (prev >= 0) {
                pairs++;
                if (d === prev) same++;
            }
            prev = d;
        }
        perPersona.push([...counts.values()].reduce((a, n) => a + (n / 300) ** 2, 0));
    }
    perPersona.sort((a, b) => a - b);
    const p90 = 100 * perPersona[Math.floor(perPersona.length * 0.9)];
    const mean = next.reduce((a, b) => a + b, 0) / next.length;
    check("'next' (the next round): under 10.5 % of two draws in a row the same (also for 90 % of the personas), a mean of 4-9 ticks, at most 40", pct(same, pairs) < 10.5 && p90 < 10.5 && mean >= 4 && mean <= 9 && Math.max(...next) <= 40, `${pct(same, pairs).toFixed(1)} % the same (persona p90 ${p90.toFixed(1)} %), mean ${mean.toFixed(1)}, median ${median(next)}, max ${Math.max(...next)}`);
    const page = personas.flatMap(p => Array.from({ length: 50 }, () => T.reactionTicks(p, 'page', random)));
    check("'page' (a quick click): a median of 1-3 ticks, at most 8", median(page) >= 1 && median(page) <= 3 && Math.max(...page) <= 8, `median ${median(page)}, max ${Math.max(...page)}`);
    const typical = personas[0];
    const bank = Array.from({ length: 2000 }, () => T.reactionTicks(typical, 'bank', random));
    check('a bank stop varies: CV at least 0.3 for one persona (3-20 s mostly)', cv(bank) >= 0.3, `CV ${cv(bank).toFixed(2)}, median ${median(bank)} ticks`);
}

// ---- 2. a world ----
const logErrors = [];
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    console[level] = (...a) => {
        if (level !== 'error') return;
        const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
        if (!text.includes('ExperimentalWarning')) logErrors.push(text.slice(0, 300));
    };
}
const engineDir = prepareEngineClone('habits', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/habits.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, BotChat, wildernessLevelAt } = lib;
lib.setHabitRatesForTest({ breaks: 30, lingers: 25 });
const saves = new Map();
// sessions of 5-11 minutes (many endings), no newcomers
const TIMING = { session: [500, 1100], away: [200, 500], newcomer: [1e7, 1e7], newCharacterCount: [0, 0], returnGap: [5, 30], emptyWorld: 50, busyGiveUp: 600, leaveGiveUp: 50 };
const sim = await lib.Sim.create({ bots: N, members: true, debug: false, ageNewBots: true, saves, ackLogouts: true, extra: { timing: TIMING, savedNames: () => [...saves.keys()] } });
sim.addHuman(3222, 3218, 0);

const BREAKS = new Set(['bank', 'skill', 'idle']);
const BANK_STATES = new Set(['bank', 'banking', 'bank_done', 'bank_deposit', 'deposit', 'withdraw', 'coins_withdraw']);
const taskKind = p => (sim.botPlayer(p)?.currentTask?.name ?? 'none').split(':')[0];
const state = p => sim.botPlayer(p)?.currentTask?.state ?? null;
const recs = new Map();
const breaks = [];
const startFaults = [];
const lines = { brb: [], back: [], departure: [] };
const gaps = new Map();
const bankStops = [];
const logouts = [];
const lurk = { still: 0, moving: 0 };
let interrupts = { fight: null, errand: null };
let look = null;

lib.sayListeners.push((p, text, kind) => {
    const t = World.currentTick;
    if (kind === 'brb') (lib.isAway(p) ? lines.brb : lines.back).push({ p, t, text });
    if (kind === 'departure') lines.departure.push({ p, t, text, lock: -1 });
});

function observe(now) {
    const seen = new Set();
    for (const p of sim.bots()) {
        seen.add(p);
        let r = recs.get(p);
        if (!r) recs.set(p, (r = { x: p.x, z: p.z, level: p.level, m: 0, habit: null, brk: null, t: p.target, lostAt: -1, lostKind: '', still: -1, stillKey: null, planner: p.botPlanner }));
        const d = p.level !== r.level ? 99 : Math.max(Math.abs(p.x - r.x), Math.abs(p.z - r.z));
        r.m = d;
        // breaks: when they start (and under what), how they go, how long they last
        const h = lib.habitOf(p);
        if (r.brk && h !== r.brk.kind) {
            const b = r.brk;
            b.len = now - b.start;
            // (cut short, as port/BotHabits tells it: a trade, the human's errand, a fight, a hit, an attacker near, or
            // its session over)
            const last = lib.lastBreakOf(p);
            // (port/BotHabits stamps a break with the tick's own number, the observer one later)
            b.reason = last && Math.abs(last.start - b.start) <= 1 ? last.reason : h === 'leaving' ? 'leaving' : '?';
            b.cut = b.reason !== 'done';
            breaks.push(b);
            r.brk = null;
        }
        if ((BREAKS.has(h) || h === 'linger') && !r.brk) {
            r.brk = { p, kind: h, start: now, moved: false, jumped: false, task: taskKind(p) };
            const why = [];
            if (wildernessLevelAt(p.x, p.z) > 0) why.push('wilderness');
            if (p.botTradeTargetPid !== -1 || lib.tradeScreen(p) !== null) why.push('trade');
            if (now < p.preventLogoutUntil) why.push('fight');
            if (BotChat.inConversation(p)) why.push('conversation');
            if (p.botComeHereReturnX !== -1) why.push('come here');
            if (why.length) startFaults.push(`${p.username} ${h} t${now}: ${why.join(', ')}`);
        } else if (r.brk && d > 0) {
            r.brk.moved = true;
            if (d > 2) r.brk.jumped = true;
        }
        if (r.brk && (r.brk.kind === 'linger') === lib.isAway(p)) r.brk.awayWrong = true;

        r.habit = h;
        // targets: lost to the next one, per task kind (a new target attacking the bot already is the game's
        // auto-retaliate, not the bot's click: left out, as the humanlike report does)
        const t = p.target;
        if (r.t && !t) {
            r.lostAt = now;
            r.lostKind = taskKind(p);
        }
        const retaliates = t && t.target === p && (t.username !== undefined ? t.targetOp === 88 || t.targetOp === 95 : t.targetOp === 8 || t.targetOp === 13);
        if (t && t !== r.t && retaliates) r.lostAt = -1;
        else if (t && t !== r.t && r.lostAt >= 0) {
            const list = gaps.get(r.lostKind) ?? [];
            list.push(now - r.lostAt);
            gaps.set(r.lostKind, list);
            r.lostAt = -1;
        }
        if (r.lostAt >= 0 && now - r.lostAt > 60) r.lostAt = -1;
        r.t = t;
        // bank stops: a still streak that stood in a bank state
        if (d === 0) {
            if (r.still < 0) {
                r.still = now;
                r.stillKey = null;
            }
            if (r.stillKey === null && BANK_STATES.has(state(p))) r.stillKey = `${taskKind(p)}/${state(p)}`;
        } else if (r.still >= 0) {
            if (r.stillKey) bankStops.push(now - r.still);
            r.still = -1;
        }
        // deep PKers on patrol
        if (p.botPlanner === 'extras_pker' && state(p) === 'patrol') d === 0 ? lurk.still++ : lurk.moving++;
        r.x = p.x;
        r.z = p.z;
        r.level = p.level;
    }
    // a goodbye's bot hit meanwhile (a PKer) cannot log out till the game's logout lock is over (10 s after a hit)
    for (const d of lines.departure) if (now - d.t <= 40 && d.p.slot !== -1) d.lock = Math.max(d.lock, d.p.preventLogoutUntil);
    // logouts: in the AI's list last tick, not now
    for (const [p, r] of recs) {
        if (seen.has(p)) continue;
        const [bx, bz, bl] = lib.nearestBank({ x: r.x, z: r.z });
        logouts.push({ p, t: now, moving: r.m > 0, atBank: bl === r.level && Math.max(Math.abs(r.x - bx), Math.abs(r.z - bz)) <= 8, planner: r.planner });
        if (r.brk) {
            r.brk.len = now - r.brk.start;
            r.brk.gone = true;
            breaks.push(r.brk);
        }
        recs.delete(p);
    }
}

/** a bot with free levelling bots 2-6 tiles from it (for the look): [the watchers, the subject] */
function lookPair() {
    const bots = sim.bots();
    const freeBot = w => ['skiller', 'fighter', 'balanced', 'random'].includes(w.botPlanner) && w.target === null && lib.habitOf(w) === null && !BotChat.inConversation(w) && !w.delayed && !w.activeScript && wildernessLevelAt(w.x, w.z) === 0 && w.levels[3] * 2 >= w.baseLevels[3];
    let best = null;
    for (const s of bots) {
        const near = bots.filter(w => w !== s && w.level === s.level && Math.max(Math.abs(s.x - w.x), Math.abs(s.z - w.z)) <= 6 && Math.max(Math.abs(s.x - w.x), Math.abs(s.z - w.z)) >= 2 && freeBot(w));
        if (near.length && (!best || near.length > best[0].length)) best = [near, s];
    }
    return best;
}

const t0 = performance.now();
for (let i = 0; i < TICKS; i++) {
    sim.tick();
    await null; // (the login thread's logout acknowledgements, as in the worker)
    const now = World.currentTick;
    observe(now);
    // a fight ends a break at once (the combat logout lock, as the combat scripts set it on a hit)
    if (!interrupts.fight && i > 300) {
        const p = sim.bots().find(b => lib.isAway(b) && lib.habitOf(b) !== 'skill');
        if (p) {
            p.preventLogoutUntil = now + 16;
            sim.tick();
            await null;
            interrupts.fight = { name: p.username, away: lib.isAway(p) };
            observe(World.currentTick);
        }
    }
    // so does the human's errand ("come here")
    if (!interrupts.errand && i > 300) {
        const p = sim.bots().find(b => lib.isAway(b) && lib.habitOf(b) !== 'skill' && b.username !== interrupts.fight?.name);
        if (p) {
            p.botComeHereReturnX = p.x;
            p.botComeHereReturnZ = p.z;
            sim.tick();
            await null;
            interrupts.errand = { name: p.username, away: lib.isAway(p) };
            p.botComeHereReturnX = -1;
            p.botComeHereReturnZ = -1;
            observe(World.currentTick);
        }
    }
    // a look at a dance
    if (!look && i > 400 && i % 50 === 0) {
        const pair = lookPair();
        // (one free bot near the dancer is enough: another pair is tried 50 ticks later if it does not look up. Two were
        // asked for before phase 3 of the realism work: its social life makes the 40-bot world at seed 3 another one (other
        // dice), and none of its 42 tries had two free levelling bots near one bot, where the one before had once)
        if (pair && pair[0].length >= 1) {
            const [watchers, s] = pair;
            lib.setHabitRatesForTest({ watch: 1000 });
            lib.noteSpectacle(s, 'dance');
            // (the first of them to look up; one may have looked at something a few minutes ago)
            let w = null;
            let started = -1;
            let ended = -1;
            let faced = false;
            // (where the dancer stood when it danced and the last few ticks: the watcher turns to it every other tick,
            // or, if it has walked off by then, to where it danced)
            const seen = [[s.x, s.z]];
            for (let k = 0; k < 40 && ended < 0; k++) {
                sim.tick();
                await null;
                observe(World.currentTick);
                seen.push([s.x, s.z]);
                if (seen.length > 5) seen.splice(1, 1);
                w ??= watchers.find(b => lib.habitOf(b) === 'watch') ?? null;
                if (!w) continue;
                const h = lib.habitOf(w);
                if (h === 'watch' && started < 0) started = k;
                // (faced: the bot's facing within a tile of the dancer: CoordGrid.fine, half tiles)
                if (h === 'watch') faced ||= seen.some(([x, z]) => Math.abs(w.faceAngleX - (2 * x + 1)) <= 2 && Math.abs(w.faceAngleZ - (2 * z + 1)) <= 2);
                if (started >= 0 && h !== 'watch') ended = k;
            }
            lib.noteSpectacle(s, 'dance');
            let again = false;
            for (let k = 0; k < 12 && w; k++) {
                sim.tick();
                await null;
                observe(World.currentTick);
                again ||= lib.habitOf(w) === 'watch';
            }
            lib.setHabitRatesForTest({ watch: 1 });
            // (no look: each of them had gone back to work before it looked up; another pair in 50 ticks)
            if (w) look = { watchers: watchers.length, watcher: w.username, subject: s.username, started, ended, faced, again };
        }
    }
}
const seconds = ((performance.now() - t0) / 1000).toFixed(1);
// (the breaks still going at the end)
for (const [, r] of recs) {
    if (!r.brk) continue;
    r.brk.len = World.currentTick - r.brk.start;
    r.brk.open = true;
    breaks.push(r.brk);
}

// ---- checks ----
const stats = BotManager.stats();
const brk = breaks.filter(b => BREAKS.has(b.kind));
const lingers = breaks.filter(b => b.kind === 'linger');
check('breaks happen (30 times as often as the personas say)', brk.length >= 10, `${brk.length} breaks (${['bank', 'skill', 'idle'].map(k => `${k} ${brk.filter(b => b.kind === k).length}`).join(', ')}), ${lingers.length} lingers`);
check('no break in the Wilderness, a fight, a trade, a conversation or on the human\'s errand', startFaults.length === 0, startFaults.slice(0, 4).join(' | '));
const walked = brk.filter(b => b.moved);
check('a bot on a break stands (AFK-skilling aside): no walk', walked.length === 0, walked.slice(0, 4).map(b => `${b.p.username} ${b.kind} t${b.start}`).join(' | '));
const jumped = breaks.filter(b => b.jumped);
check('nobody is jumped (watchdog, stuck rescue) while on a break', jumped.length === 0, jumped.slice(0, 4).map(b => `${b.p.username} ${b.kind} ${b.task} t${b.start}`).join(' | '));
const done = brk.filter(b => !b.cut && !b.gone && !b.open);
const tooLong = done.filter(b => b.len > 143);
const ends = {};
for (const b of brk) ends[b.reason ?? (b.gone ? 'gone' : 'open')] = (ends[b.reason ?? (b.gone ? 'gone' : 'open')] ?? 0) + 1;
check('a break lasts 20-85 s (at most 143 ticks), its time up or cut short by what may cut it', done.length > 0 && tooLong.length === 0 && !brk.some(b => b.reason === '?'), `lengths p10/p50/p90 ${[0.1, 0.5, 0.9].map(q => [...done.map(b => b.len)].sort((a, b) => a - b)[Math.floor(q * done.length)]).join('/')} ticks; ends ${JSON.stringify(ends)}; too long: ${tooLong.slice(0, 3).map(b => `${b.p.username} ${b.len}`).join(', ')}`);
const lingerOk = lingers.filter(b => !b.cut && !b.gone && !b.open);
check('a linger (at a bank or its spot) lasts 2-2.5 min (200-251 ticks), and the bot is not away meanwhile', lingers.length > 0 && lingerOk.every(b => b.len >= 200 && b.len <= 251) && !lingers.some(b => b.awayWrong), `${lingers.length} lingers: ${lingerOk.map(b => b.len).join(', ')}`);
check('isAway: true on a break, false on a linger', !brk.some(b => b.awayWrong), brk.filter(b => b.awayWrong).slice(0, 3).map(b => `${b.p.username} ${b.kind}`).join(', '));
// a "brb": the break that came with it lasted 45 s or more, unless cut short or the bot left (a line is told in the
// tick's own number, the break seen after the tick: one later)
const brbBreaks = lines.brb.map(l => breaks.find(b => b.p === l.p && b.start >= l.t && b.start <= l.t + 1) ?? null);
const shortBrb = lines.brb.filter((l, i) => !brbBreaks[i] || (!brbBreaks[i].cut && !brbBreaks[i].gone && !brbBreaks[i].open && brbBreaks[i].len < 74));
check('every "brb" comes with a break of 45 s or more (or one cut short, or the bot left)', lines.brb.length > 0 && shortBrb.length === 0, `${lines.brb.length} brb lines ("${lines.brb[0]?.text ?? '-'}"); short: ${shortBrb.slice(0, 3).map(l => `${l.p.username} t${l.t}`).join(', ')}`);
const lonelyBack = lines.back.filter(l => !lines.brb.some(b => b.p === l.p && b.t < l.t && l.t - b.t <= 150));
check('"back" only after a "brb"', lonelyBack.length === 0, `${lines.back.length} back lines; without a brb: ${lonelyBack.length}`);
check('a fight ends a break at once', interrupts.fight && interrupts.fight.away === false, interrupts.fight ?? 'no bot on a break found');
check('the human\'s errand ("come here") ends a break at once', interrupts.errand && interrupts.errand.away === false, interrupts.errand ?? 'no bot on a break found');
check('a dance draws a look: the bot stops, faces the dancer, plays on within 10 s; not again right after', look && look.started >= 0 && look.started <= 10 && look.ended >= 0 && look.ended - look.started <= 18 && look.faced && !look.again, look ?? 'no free pair found');
// targets
// (a kind of 20-50 is listed, not judged: one more instant re-target in 25 is 4 %)
const gapRows = [...gaps].filter(([, g]) => g.length >= 20).map(([k, g]) => [k, pct(g.filter(x => x <= 1).length, g.length), g.length]);
const instant = gapRows.filter(([, share, n]) => n >= 50 && share > 10);
const allGaps = [...gaps.values()].flat();
const allInstant = pct(allGaps.filter(x => x <= 1).length, allGaps.length);
check('the next target comes later than a tick: at most 10 % within one per task kind (50+ samples), 5 % of all', gapRows.some(([, , n]) => n >= 50) && instant.length === 0 && allInstant <= 5, `all ${allInstant.toFixed(1)} % (${allGaps.length}); ${gapRows.map(([k, s, n]) => `${k} ${s.toFixed(1)} % (${n})`).join(', ')}`);
check('bank stops vary: CV at least 0.3', bankStops.length >= 10 && cv(bankStops) >= 0.3, `${bankStops.length} stops, CV ${bankStops.length ? cv(bankStops).toFixed(2) : '-'}, median ${median(bankStops)} ticks`);
// leaving
const walking = logouts.filter(l => l.moving);
check('sessions end with logouts, at most 25 % of them mid-walk', logouts.length >= N / 2 && pct(walking.length, logouts.length) <= 25, `${logouts.length} logouts, ${walking.length} mid-walk, ${logouts.filter(l => l.atBank).length} at a bank`);
const fake = lines.departure.filter(d => !logouts.some(l => l.p === d.p && l.t >= d.t && l.t - d.t <= Math.max(10, d.lock - d.t + 2)) && d.t < World.currentTick - 10);
check('each goodbye said is followed by that bot\'s logout within 10 ticks (a bot hit meanwhile: once the logout lock is over)', lines.departure.length > 0 && fake.length === 0, `${lines.departure.length} goodbyes ("${lines.departure[0]?.text ?? '-'}"); not followed: ${fake.slice(0, 3).map(d => `${d.p.username} t${d.t}`).join(', ')}`);
check('some log out at a bank', logouts.some(l => l.atBank), `${logouts.filter(l => l.atBank).length} of ${logouts.length}`);
check('deep PKers on patrol lurk: still at least 30 % of their patrol ticks', lurk.still + lurk.moving >= 100 && pct(lurk.still, lurk.still + lurk.moving) >= 30, `${pct(lurk.still, lurk.still + lurk.moving).toFixed(1)} % of ${lurk.still + lurk.moving} patrol ticks`);
check('no bot errors, no console errors', stats.errors === 0 && logErrors.length === 0, logErrors.slice(0, 2).join(' | '));

out(`habits: ${N} bots, ${TICKS} ticks, seed ${SEED}: ${seconds} s; ${brk.length} breaks, ${lingers.length} lingers, ${lines.brb.length} brb, ${lines.departure.length} goodbyes, ${logouts.length} logouts`);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
const failed = checks.filter(c => !c.ok).length;
out(failed ? `habits: ${failed} of ${checks.length} failed` : `habits: all ${checks.length} passed`);
process.exit(failed ? 1 : 0);
