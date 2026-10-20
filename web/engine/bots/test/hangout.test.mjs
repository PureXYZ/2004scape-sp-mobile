#!/usr/bin/env node
// Hang-outs (the realism work, phase 3, "where bots are": port/BotHangout, "2004 hotspots") in the real 274
// world: 40 aged bots, the living world with short sessions, hang-outs 20 times as often as by default
// (setHangoutRateForTest), for 3,000 ticks:
//   happen     levelling bots take hang-outs, at Falador park, Varrock square and the banks (not Varrock West, the trade hub),
//              between plans and at bank stops (a sub-task: the plan resumes after it)
//   where      a hanging-out bot stands within its spot's radius, on a tile of its own (port/BotTiles): no two of them on
//              one tile, never another's claim
//   who        never a newbie, never in the Wilderness, never a vendor, PKer or social bot
//   how        not away while it stands (it answers: port/BotHabits.isAway false, a break at the spot aside); no linger
//              during one; a stand of 3-10 minutes when nothing cuts it short; never two hang-outs in a row (the next
//              one a gap after the last)
//   after      its tile goes back when it ends; the bot takes up a plan again
//   errors     none
//
//   node --expose-gc web/engine/bots/test/hangout.test.mjs [--bots=40] [--ticks=3000] [--seed=5]
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const N = Number(args.bots ?? 40);
const TICKS = Number(args.ticks ?? 3000);
const SEED = Number(args.seed ?? 5);
const out = (s = '') => process.stdout.write(s + '\n');
{
    let s = SEED >>> 0 || 1;
    Math.random = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });

const logErrors = [];
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    console[level] = (...a) => {
        if (level !== 'error') return;
        const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
        if (!text.includes('ExperimentalWarning')) logErrors.push(text.slice(0, 300));
    };
}
const engineDir = prepareEngineClone('hangout', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/hangout.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, wildernessLevelAt } = lib;
lib.setHangoutRateForTest(20);
const saves = new Map();
// sessions of 12-25 minutes (hang-outs are between plans: logins give the planner turns), no newcomers
const TIMING = { session: [1200, 2500], away: [200, 500], newcomer: [1e7, 1e7], newCharacterCount: [0, 0], returnGap: [5, 30], emptyWorld: 50, busyGiveUp: 600, leaveGiveUp: 50 };
const sim = await lib.Sim.create({ bots: N, members: true, debug: false, ageNewBots: true, saves, ackLogouts: true, extra: { timing: TIMING, savedNames: () => [...saves.keys()] } });
sim.addHuman(3222, 3218, 0);

const LEVELLING = new Set(['skiller', 'fighter', 'balanced', 'random']);
const MIN_GAP = Math.floor(6000 / 20 / 1.32) - 5;
const spotOf = new Map(lib.HANGOUT_SPOTS.map(s => [s.key, s]));
const recs = new Map();
const hangouts = [];
const faults = { where: [], shared: [], who: [], away: [], linger: [], twice: [] };
// (a hang-out begun at a bank stop is the bot's sub-task)
const kindOf = p => (lib.hangoutOf(p)?.name ?? sim.botPlayer(p)?.currentTask?.name ?? 'none').split(':')[0];
for (let t = 0; t < TICKS; t++) {
    sim.tick();
    await null;
    const now = World.currentTick;
    const standing = new Map();
    for (const p of sim.bots()) {
        const task = lib.hangoutOf(p) ?? sim.botPlayer(p)?.currentTask ?? null;
        const kind = kindOf(p);
        let r = recs.get(p);
        if (!r) recs.set(p, (r = { kind: 'none', h: null, prev: 'none', lastEnd: -1e9 }));
        if (kind !== r.kind) {
            if (r.kind === 'Hangout' && r.h) {
                r.h.end = now;
                hangouts.push(r.h);
                r.h = null;
                r.lastEnd = now;
            }
            if (kind === 'Hangout') {
                // (the next one is due a gap after the last ends: at ×20, 1-2 hours ÷ 20 ÷ the sociability's 1.32 at most)
                if (now - r.lastEnd < MIN_GAP) faults.twice.push(`${p.username} t${now}, ${now - r.lastEnd} ticks after its last`);
                r.h = { p, spot: task.spot.key, start: now, standStart: -1, end: -1 };
                if (!LEVELLING.has(p.botPlanner) || lib.isNewbie(p)) faults.who.push(`${p.username} ${p.botPlanner} t${now}`);
            }
            r.prev = r.kind;
            r.kind = kind;
        }
        if (kind !== 'Hangout') continue;
        if (wildernessLevelAt(p.x, p.z) > 0) faults.who.push(`${p.username} in the Wilderness t${now}`);
        if (!task.standing) continue;
        if (r.h && r.h.standStart < 0) r.h.standStart = now;
        const spot = spotOf.get(task.spot.key);
        if (Math.max(Math.abs(p.x - spot.x), Math.abs(p.z - spot.z)) > spot.radius) faults.where.push(`${p.username} at ${p.x},${p.z} for ${spot.key} t${now}`);
        const key = `${p.x},${p.z},${p.level}`;
        if (standing.has(key)) faults.shared.push(`${p.username} and ${standing.get(key).username} on ${key} t${now}`);
        standing.set(key, p);
        const habit = lib.habitOf(p);
        if (habit === 'linger') faults.linger.push(`${p.username} t${now}`);
        if (lib.isAway(p) && habit !== 'idle') faults.away.push(`${p.username} (${habit}) t${now}`);
    }
}
for (const [, r] of recs) if (r.h) hangouts.push({ ...r.h, open: true });

const spots = {};
for (const h of hangouts) spots[h.spot] = (spots[h.spot] ?? 0) + 1;
check('hang-outs happen (20 times as often as by default)', hangouts.length >= 5, `${hangouts.length} hang-outs: ${JSON.stringify(spots)}`);
check('never at Varrock West (the trade hub)', !hangouts.some(h => h.spot.startsWith('varrock_west')));
const stood = hangouts.filter(h => h.standStart >= 0);
check('most get there and stand', stood.length >= hangouts.length * 0.6, `${stood.length} of ${hangouts.length}`);
check('a hanging-out bot stands within its spot', faults.where.length === 0, faults.where.slice(0, 3).join(' | '));
check('no two hanging-out bots on one tile (a tile of its own)', faults.shared.length === 0, faults.shared.slice(0, 3).join(' | '));
check('never a newbie, an extra, or in the Wilderness', faults.who.length === 0, faults.who.slice(0, 3).join(' | '));
check('not away while it stands (a short break at the spot aside)', faults.away.length === 0, faults.away.slice(0, 3).join(' | '));
check('no linger during a hang-out', faults.linger.length === 0, faults.linger.slice(0, 3).join(' | '));
check('never two hang-outs in a row (the next a gap after the last)', faults.twice.length === 0, faults.twice.slice(0, 3).join(' | '));
const whole = stood.filter(h => !h.open && h.end > 0);
const lens = whole.map(h => h.end - h.standStart);
const [lo, hi] = lib.HANGOUT_STAND_TICKS;
check('a stand of 3-10 minutes (a break or a step about within it)', lens.length > 0 && lens.every(n => n <= hi + 5) && lens.filter(n => n >= lo - 5).length >= lens.length * 0.7, `stands ${[...lens].sort((a, b) => a - b).join(', ')} ticks`);
// (a thief, a smith, a cook, a lingering bot and, since the social track, a social regular at its hub hold a tile of their own too;
// since the variety work's round 1 track F a PKer at its patrol tile, a gatherer waiting by a taken rock or tree, and a
// login's linger by the human)
const holding = sim.bots().filter(p => kindOf(p) !== 'Hangout' && lib.standTileOf(p) !== null && !['Thieve', 'Smith', 'Cook', 'Social', 'PKer', 'Mine', 'Woodcut', 'Fletching', 'Fish', 'Linger'].includes(kindOf(p)) && lib.habitOf(p) !== 'linger');
check('its tile goes back when it ends', holding.length === 0, holding.slice(0, 3).map(p => `${p.username} (${kindOf(p)})`).join(', '));
const errors = BotManager.stats().errors;
check('no errors', errors === 0 && logErrors.length === 0, `${errors} bot errors; ${logErrors.slice(0, 2).join(' | ')}`);

out(`hangout: ${N} bots, ${TICKS} ticks, hang-outs ×20: ${hangouts.length} hang-outs (${stood.length} stood), ${JSON.stringify(spots)}`);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
const failed = checks.filter(c => !c.ok);
out(failed.length ? `${failed.length} failed` : 'ok');
process.exit(failed.length ? 1 : 0);
