#!/usr/bin/env node
// The bots' faster internals (perf, 2026-10-23) give exactly the answers of the code they replace, in a seeded world of
// the real 274 map (members, 120 aged bots with real sessions, a human at Lumbridge, 400 ticks) and on sweeps of the map:
//   routes   every bot route search of the world (port/BotPathing's four, on port/BotPathFinder's copy of 274's
//            breadth-first search) against the engine's PathFinder with the same arguments: the same waypoints; and a
//            sweep of sources on every floor and in the dungeons, each with tile walks (moveNear or not, in and out of
//            the 128×128 window), the locs and NPCs about it, and every loc shape at every angle with its approach sides
//   scans    every nearest-NPC, loc and ground-item search of the world (BotAction over port/BotZoneScan's loops) against
//            the engine's generators: the same entity, the caller's predicate called on the same entities in the same
//            order; every "is my target still here" (npcWithin) and "who attacks me" (the aggressor index,
//            port/BotAggressors) against the search it stands for; staged ties (two attackers at the same distance, in
//            two zones and in one zone in both list orders): the search's pick
//   graph    the walking graph's A* (port/BotWalkGraph.route) against the original on random node pairs, with and
//            without a filter of allowed tiles: the same nodes; nearestNodes in the original sort's order
//   arrays   every use of the tick's array of the players (port/BotPlayers' worldPlayers) and of the active bots
//            (BotManager.activeBots) against a fresh pass of the generator it stands for: the same players in the same order
//   errors   none
// The world itself (the bots' state, the human's bytes, the random draws) against another copy of the library is
// test/identity.mjs's.
//
//   node --expose-gc web/engine/bots/test/exact.test.mjs [--bots=120] [--ticks=400] [--seed=3]
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const N = Number(args.bots ?? 120);
const TICKS = Number(args.ticks ?? 400);
const SEED = Number(args.seed ?? 3);
const out = (s = '') => process.stdout.write(s + '\n');
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
const errors = [];
for (const level of ['log', 'info', 'debug', 'warn']) console[level] = () => {};
console.error = (...a) => {
    const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
    if (!text.includes('ExperimentalWarning') && !text.includes('--trace-warnings')) errors.push(text.slice(0, 400));
};
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
const t0 = performance.now();

const engineDir = prepareEngineClone('exact', simWorldConfig({ members: true, xpRate: 10 }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/exact.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, routefinder, CollisionType } = lib;

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const engineRoute = (level, srcX, srcZ, destX, destZ, w, h, angle, shape, moveNear, access, max) => routefinder.findPath(level, srcX, srcZ, destX, destZ, 1, w, h, angle, shape, moveNear, access, max, CollisionType.NORMAL);

// ---- routes: every bot search of the world, compared as it happens ----
const routes = { calls: 0, found: 0, mismatches: [] };
lib.wrapBotRouteForTest(search => (...a) => {
    const got = search(...a);
    const want = engineRoute(...a);
    routes.calls++;
    if (got.length) routes.found++;
    if (!same(got, want) && routes.mismatches.length < 5) routes.mismatches.push({ args: a, got: [...got], want: [...want] });
    else if (!same(got, want)) routes.mismatches.length++;
    return got;
});

// ---- scans: every zone search of the world, compared as it happens ----
const scans = lib.checkScans();

// ---- arrays: every use of the tick's players and active bots, compared as it happens ----
const arrays = lib.checkArrays();

const sim = await lib.Sim.create({ bots: N, members: true, debug: false, ageNewBots: true, ackLogouts: true, extra: { timing: {} } });
sim.addHuman(3222, 3218, 0);
for (let i = 0; i < TICKS; i++) sim.tick();
check(`routes: every bot search of the world is the engine's (${routes.calls} searches, ${routes.found} with a route)`, routes.calls > 1000 && routes.mismatches.length === 0, routes.mismatches.length ? routes.mismatches : `${routes.calls}`);
check(`scans: every zone search is the generators' (${scans.npc} NPC, ${scans.loc} loc, ${scans.obj} item searches, ${scans.predicateCalls} predicate calls)`, scans.npc > 300 && scans.loc > 300 && scans.obj > 50 && scans.mismatches.filter(m => !m.startsWith('within') && !m.startsWith('acting')).length === 0, scans.mismatches);
check(`arrays: every use of the tick's players and active bots is the generator's (${arrays.players} and ${arrays.active} uses)`, arrays.players > 1000 && arrays.active > 100 && arrays.mismatches.length === 0, arrays.mismatches);
check(`scans: npcWithin and the aggressor lookup are the search's (${scans.within} and ${scans.acting}, ${scans.actingFound} with an attacker)`, scans.within > 100 && scans.acting > 1000 && scans.actingFound > 10 && scans.mismatches.length === 0, scans.mismatches);

// ---- scans: staged ties between two attackers (the search's zone order, then its list order) ----
{
    const { NpcMode } = lib;
    const bot = sim.bots().find(b => b.level === 0 && b.z < 4000 && (b.x & 7) >= 2 && (b.x & 7) <= 5 && (b.z & 7) >= 2 && (b.z & 7) <= 5);
    const free = [...World.npcs].filter(n => n && n.isActive && !n.delayed && n.width === 1 && n.level === 0 && n.z < 4000 && Math.abs(n.x - (bot?.x ?? 0)) > 40);
    const ties = { cases: 0, picks: new Set() };
    const stage = (placements, label) => {
        const npcs = free.splice(0, placements.length);
        npcs.forEach((n, i) => {
            n.teleport(bot.x + placements[i][0], bot.z + placements[i][1], 0);
            n.setInteraction(0, bot, NpcMode.OPPLAYER2);
        });
        for (const radius of [6, 8, 9]) {
            const picked = radius === 8 ? lib.findOtherAggressorNpc(bot, null, radius) : lib.findAggressorNpc(bot, radius);
            ties.cases++;
            if (picked) ties.picks.add(`${label}:${npcs.indexOf(picked)}`);
        }
        for (const n of npcs) n.clearInteraction();
    };
    if (bot && free.length >= 8) {
        const within = scans.acting;
        // two zones (west and east of the bot's zone, 6 tiles off each way), in both orders; one zone, both list orders
        stage([[-6, 0], [6, 0]], 'zones');
        stage([[6, 0], [-6, 0]], 'zones-swapped');
        stage([[1, 1], [2, 0]], 'list');
        stage([[2, 0], [1, 1]], 'list-swapped');
        check(`scans: staged ties between two attackers are the search's pick (${ties.cases} lookups: ${[...ties.picks].sort().join(', ')})`, scans.acting - within === ties.cases && ties.picks.size >= 4 && scans.mismatches.length === 0, scans.mismatches);
    } else check('scans: staged ties (a bot and free NPCs)', false, `bot ${!!bot}, ${free.length} NPCs`);
}

// ---- routes: a sweep of the map ----
const sweep = { calls: 0, found: 0, mismatches: [] };
const compare = (...a) => {
    const got = lib.botRoute(...a);
    const want = engineRoute(...a);
    sweep.calls++;
    if (got.length) sweep.found++;
    if (!same(got, want)) {
        if (sweep.mismatches.length < 5) sweep.mismatches.push({ args: a, got: [...got], want: [...want] });
        else sweep.mismatches.length++;
    }
};
const rnd = mulberry(SEED * 7919);
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const walkable = (x, z, level) => lib.isZoneAllocated(level, x, z) && !lib.isMapBlocked(x, z, level);
const sources = [];
// the overworld and its upper floors, the dungeons (z + 6400), the map's west and south edges
const AREAS = [
    [2400, 2900, 3400, 3600, [0, 1, 2]],
    [2900, 3400, 3100, 3550, [0, 1, 2, 3]],
    [2500, 3400, 9300, 10000, [0]],
    [2840, 2900, 2930, 3000, [0]]
];
for (let tries = 0; sources.length < 360 && tries < 200000; tries++) {
    const [x0, x1, z0, z1, levels] = AREAS[tries % AREAS.length];
    const x = ri(x0, x1);
    const z = ri(z0, z1);
    const level = levels[ri(0, levels.length - 1)];
    if (walkable(x, z, level)) sources.push([x, z, level]);
}
for (const [sx, sz, level] of sources) {
    // tile walks, in the window and out of it (64 or more away: never found), moveNear or not
    for (let k = 0; k < 4; k++) {
        const r = k < 3 ? 40 : 75;
        const dx = ri(-r, r);
        const dz = ri(-r, r);
        compare(level, sx, sz, sx + dx, sz + dz, 1, 1, 0, -1, k % 2 === 0, 0, 25);
    }
    // the locs and NPCs within 12 tiles (their zones' lists), as the bots' clicks route to them
    let locs = 0;
    let npcs = 0;
    for (let zx = (sx - 12) >> 3; zx <= (sx + 12) >> 3 && (locs < 6 || npcs < 3); zx++) {
        for (let zz = (sz - 12) >> 3; zz <= (sz + 12) >> 3; zz++) {
            const zone = World.gameMap.getZone(zx << 3, zz << 3, level);
            for (const loc of zone.getAllLocsSafe()) {
                if (locs >= 6) break;
                locs++;
                const t = lib.LocType.get(loc.type);
                compare(level, sx, sz, loc.x, loc.z, loc.width, loc.length, loc.angle, loc.shape, locs % 2 === 0, t.forceapproach, 25);
            }
            for (const npc of zone.getAllNpcsSafe()) {
                if (npcs >= 3) break;
                npcs++;
                compare(level, sx, sz, npc.x, npc.z, npc.width, npc.length, 0, -2, true, 0, 25);
            }
        }
    }
    // a random shape (walls, wall decoration, rectangles, the rest) at a random angle, size and set of approach sides
    const shape = ri(-2, 22);
    compare(level, sx, sz, sx + ri(-20, 20), sz + ri(-20, 20), ri(1, 3), ri(1, 3), ri(0, 3), shape, rnd() < 0.5, ri(0, 15), ri(1, 25));
}
check(`routes: a sweep of ${sources.length} sources on every floor and in the dungeons (${sweep.calls} searches, ${sweep.found} with a route)`, sweep.calls > 2500 && sweep.found > 1000 && sweep.mismatches.length === 0, sweep.mismatches.length ? sweep.mismatches : `${sweep.calls}`);

// ---- the walking graph: A* and the nearest nodes against the original ----
{
    const graph = { routes: 0, found: 0, mismatches: [], near: 0, nearBad: [] };
    const nodes = lib.nodeCount();
    const allowedSome = (x, z) => ((x >> 3) + (z >> 3)) % 5 !== 0;
    const byComponent = new Map();
    for (let i = 0; i < nodes; i++) {
        const c = lib.componentOf(i);
        if (!byComponent.has(c)) byComponent.set(c, []);
        byComponent.get(c).push(i);
    }
    for (let k = 0; k < 3000; k++) {
        const a = ri(0, nodes - 1);
        // (most within a's component: a route exists unless the filter cuts it; every fourth anywhere)
        const mates = byComponent.get(lib.componentOf(a));
        const b = k % 4 === 0 ? ri(0, nodes - 1) : mates[ri(0, mates.length - 1)];
        const allowed = k % 3 === 0 ? allowedSome : undefined;
        const got = lib.graphRoute(a, b, allowed, `exact-${k}`); // (a key of its own: no cached answer)
        const want = lib.refGraphRoute(a, b, allowed);
        graph.routes++;
        if (got) graph.found++;
        if (JSON.stringify(got) !== JSON.stringify(want) && graph.mismatches.length < 5) graph.mismatches.push({ a, b, allowed: !!allowed, got, want });
    }
    // nearestNodes(x, z, 25) is every candidate (at most 25, the same as before): it must be in the order of the
    // original sort, scores then node numbers
    for (let k = 0; k < 3000; k++) {
        const [nx, nz] = lib.nodePos(ri(0, nodes - 1));
        const x = nx + ri(-20, 20);
        const z = nz + ri(-20, 20);
        const all = lib.nearestNodes(x, z, 25, k % 3 === 0 ? allowedSome : undefined);
        const score = i => {
            const [px, pz] = lib.nodePos(i);
            return Math.max(Math.abs(px - x), Math.abs(pz - z)) * 4 + Math.abs(px - x) + Math.abs(pz - z);
        };
        const sorted = [...all].sort((p, q) => score(p) - score(q) || p - q);
        const four = lib.nearestNodes(x, z, 4, k % 3 === 0 ? allowedSome : undefined);
        graph.near++;
        if ((JSON.stringify(all) !== JSON.stringify(sorted) || JSON.stringify(four) !== JSON.stringify(sorted.slice(0, 4))) && graph.nearBad.length < 5) graph.nearBad.push({ x, z, all, sorted });
    }
    check(`graph: the walking graph's A* is the original's (${graph.routes} searches, ${graph.found} with a route)`, graph.found > 1000 && graph.mismatches.length === 0, graph.mismatches);
    check(`graph: nearestNodes in the original sort's order (${graph.near} points)`, graph.nearBad.length === 0, graph.nearBad);
}

check('no errors', errors.length === 0, errors.slice(0, 3).join(' | '));

out(`exact: ${N} bots × ${TICKS} ticks, seed ${SEED}, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${!c.ok && c.detail ? `: ${c.detail.slice(0, 600)}` : ''}`);
}
process.exit(failed ? 1 : 0);
