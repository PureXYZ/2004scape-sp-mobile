#!/usr/bin/env node
// The walking graph long bot walks follow (port/BotWalkGraph.ts, data/walk_graph.json), in the real rev-274 world:
//   1. the data: it decodes to the counts the file states, and a sample of its edges (every 40th) is still a walk on
//      this map, as long as it says (doors and gates as the map has them): a map change makes it stale
//      (test/walk-graph-build.mjs makes it again)
//   2. routes: the towns of the mainland are joined (Lumbridge, Varrock, Falador, Draynor, Edgeville, Port Sarim, Al
//      Kharid by its north road); Lumbridge to Edgeville keeps out of the Wilderness; a free world's route keeps to
//      free areas, and Taverley (behind its gate) is not on the mainland's graph
//   3. walks: bots with no task, each sent along a walk that used to end against a wall or a fence (Falador's walls,
//      the farms south of Falador and west of Lumbridge, Varrock to the air ruins, north of Lumbridge castle where
//      upstream's 'Lumbridge' gateway sent bots to and fro ...), or across a gateway (the toll gate, the sheep pen,
//      Karamja's fence, Taverley's gate and White Wolf Mountain), walk there by walkTo alone: every one arrives, in
//      time, with no jump
//
//   node web/engine/bots/test/walkgraph.test.mjs [--debug]
//
// Exit code 1 if a check fails. Nothing is written outside build/tmp/bots.
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';

const DEBUG = process.argv.includes('--debug');
{
    let s = 1;
    Math.random = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const consoleErrors = [];
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    const real = console[level].bind(console);
    console[level] = (...a) => {
        const text = a.map(String).join(' ');
        if (level === 'error' && !text.includes('ExperimentalWarning')) consoleErrors.push(text.slice(0, 300));
        if (DEBUG) real(...a);
    };
}
const out = s => process.stdout.write(s + '\n');
const checks = [];
function check(name, ok, detail = '') {
    checks.push({ name, ok: !!ok, detail });
}
const cheb = (ax, az, bx, bz) => Math.max(Math.abs(ax - bx), Math.abs(az - bz));

const engineDir = prepareEngineClone('walkgraph', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/simworld.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, walkGraph: G, routefinder } = lib;
const graphJson = (await import(path.join(BOTS_DIR, 'data/walk_graph.json'), { with: { type: 'json' } })).default;

const ROUTES = [
    ['south of Falador to Draynor', [3013, 3297], [3092, 3242]],
    ['Barbarian Village to Falador East bank', [3069, 3410], [3013, 3355]],
    ['Falador park to Barbarian Village', [2983, 3377], [3082, 3420]],
    ['west of Lumbridge to the swamp', [3144, 3212], [3209, 3189]],
    ['north of Lumbridge castle to Varrock West mine', [3212, 3238], [3177, 3368]],
    ['Aubury to the air ruins', [3252, 3400], [2986, 3295]],
    ['Lumbridge castle to Port Sarim', [3200, 3238], [3028, 3222]],
    ['Lumbridge to Edgeville', [3222, 3218], [3093, 3491]],
    ['Draynor to Varrock West bank', [3092, 3245], [3185, 3436]],
    ['Port Sarim to Falador East bank', [3028, 3222], [3013, 3355]],
    // and two that need a gateway the graph has no edge for: the toll gate (not Al Kharid's north road, round
    // Varrock) and the sheep pen's gate
    ['Lumbridge to Al Kharid bank, through the toll gate', [3222, 3218], [3269, 3166]],
    ['Lumbridge to the sheep pen', [3222, 3218], [3202, 3266]],
    // and the members' long ways: Karamja's jungle and its fence, Taverley's gate and White Wolf Mountain
    ['Musa Point through the jungle to Brimhaven', [2952, 3147], [2772, 3228]],
    ['Falador over White Wolf Mountain to Catherby', [2965, 3380], [2809, 3436]]
];

const sim = await lib.Sim.create({ bots: ROUTES.length, members: true, debug: DEBUG, spawnPerTick: ROUTES.length });
// (the human far from every route: a jump would not be refused, so any jump counts)
sim.addHuman(2600, 3100, 0);

// ---- 1. the data ----
{
    const n = G.nodeCount();
    let adjacency = 0;
    for (let i = 0; i < n; i++) adjacency += G.neighbours(i).length;
    check(`data: ${n} nodes and ${adjacency / 2} edges, as the file says`, n === graphJson.nodeCount && adjacency === graphJson.edgeCount * 2, `file ${graphJson.nodeCount} nodes, ${graphJson.edgeCount} edges`);
    const stale = [];
    let sampled = 0;
    let e = 0;
    for (let i = 0; i < n; i++) {
        for (const [j, cost] of G.neighbours(i)) {
            if (j < i || e++ % 40 !== 0) continue;
            sampled++;
            const [ax, az] = G.nodePos(i);
            const [bx, bz] = G.nodePos(j);
            const route = routefinder.findPath(0, ax, az, bx, bz, 1, 1, 1, 0, -1, false, 0, 25, 0);
            let len = 0;
            let [px, pz] = [ax, az];
            for (const packed of route) {
                const wx = (packed >> 14) & 0x3fff;
                const wz = packed & 0x3fff;
                len += cheb(px, pz, wx, wz);
                [px, pz] = [wx, wz];
            }
            if (route.length === 0 || px !== bx || pz !== bz || len !== cost) stale.push(`${ax},${az} -> ${bx},${bz} (cost ${cost}, now ${route.length === 0 || px !== bx || pz !== bz ? 'no walk' : len})`);
        }
    }
    check(`data: ${sampled} of its edges are walks of the cost it says on this map`, stale.length === 0 && sampled > 300, stale.slice(0, 4).join('; '));
}

// ---- 2. routes ----
const routeBetween = (a, b, allowed, key = '') => G.route(G.nearestNode(a[0], a[1], allowed), G.nearestNode(b[0], b[1], allowed), allowed, key);
{
    const TOWNS = { Lumbridge: [3222, 3218], Varrock: [3212, 3424], Falador: [2965, 3380], Draynor: [3092, 3245], Edgeville: [3093, 3491], 'Port Sarim': [3028, 3222], 'Al Kharid': [3290, 3180] };
    const missing = [];
    for (const [a, pa] of Object.entries(TOWNS)) for (const [b, pb] of Object.entries(TOWNS)) if (a < b && !routeBetween(pa, pb)) missing.push(`${a} - ${b}`);
    check('routes: the mainland towns are joined (Lumbridge, Varrock, Falador, Draynor, Edgeville, Port Sarim, Al Kharid)', missing.length === 0, missing.join(', '));
    const edge = routeBetween([3222, 3218], [3093, 3491]);
    const wild = (edge ?? []).filter(i => G.nodePos(i)[1] >= 3520);
    check('routes: Lumbridge to Edgeville keeps out of the Wilderness', edge && wild.length === 0, edge ? `${edge.length} nodes, ${wild.length} in the Wilderness` : 'no route');
    const free = (x, z) => sim.isFreeToPlay(x, z);
    const f2p = routeBetween([3222, 3218], [2965, 3380], free, 'f2p');
    const outside = (f2p ?? []).filter(i => !free(...G.nodePos(i)));
    check('routes: a free world\'s route (Lumbridge to Falador) keeps to free areas', f2p && outside.length === 0, f2p ? `${f2p.length} nodes, ${outside.length} outside` : 'no route');
    check('routes: Taverley, behind its gate, is not on the mainland\'s graph (BotAction\'s gateway crosses there)', routeBetween([2965, 3380], [2893, 3448]) === null);
    let worst = 0;
    for (const [, from, to] of ROUTES) {
        const t0 = performance.now();
        routeBetween(from, to, undefined, `timing${worst}`);
        worst = Math.max(worst, performance.now() - t0);
    }
    check('routes: a route search is quick (at most 20 ms)', worst <= 20, `slowest ${worst.toFixed(2)} ms`);
}

// ---- 3. walks ----
while (sim.bots().length < ROUTES.length && World.currentTick < 20) sim.tick();
sim.tick();
sim.freezeBots();
const bots = sim.bots().slice(0, ROUTES.length);
const walkers = ROUTES.map(([name, from, to], i) => {
    const bot = bots[i];
    bot.teleJump(from[0], from[1], 0);
    // (the toll gate's guard: a few pages, as players read them)
    return { name, bot, from, to, arrived: -1, limit: Math.max(300, cheb(from[0], from[1], to[0], to[1]) * 4) };
});
sim.tick();
const jumps0 = lib.teleportStats.jumps;
const start = World.currentTick;
const LIMIT = Math.max(...walkers.map(w => w.limit));
while (World.currentTick - start < LIMIT && walkers.some(w => w.arrived < 0)) {
    for (const w of walkers) {
        if (w.arrived >= 0) continue;
        if (cheb(w.bot.x, w.bot.z, w.to[0], w.to[1]) <= 3) {
            w.arrived = World.currentTick - start;
            continue;
        }
        // (as a task walks: again once the last route is walked)
        if (!w.bot.hasWaypoints()) lib.walkTo(w.bot, w.to[0], w.to[1]);
    }
    sim.tick();
}
const late = walkers.filter(w => w.arrived < 0 || w.arrived > w.limit);
check(`walks: ${walkers.length} bots sent where walls and fences used to stop them all arrive in time`, late.length === 0, late.map(w => `${w.name}: ${w.arrived < 0 ? `not there after ${LIMIT} ticks (at ${w.bot.x},${w.bot.z})` : `${w.arrived} ticks`}`).join('; '));
check('walks: and no jump on the way', lib.teleportStats.jumps === jumps0, `${lib.teleportStats.jumps - jumps0} jumps`);
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
out(`walk graph: ${G.nodeCount()} nodes; ${walkers.length} walks: ${walkers.map(w => `${w.name} ${w.arrived < 0 ? '-' : w.arrived}`).join(', ')}`);
process.exit(failed ? 1 : 0);
