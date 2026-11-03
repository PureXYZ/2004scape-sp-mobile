#!/usr/bin/env node
// Movement (bots ideas round 3, theme H: port/BotMinimap's minimap hops, pauses, the typing rule, overshoots, lanes and
// route variants), in the
// real 274 world (members, a few aged bots; the director, the cliques' doings, habits, hang-outs, the arena, random
// events, trains, alching, scams, witnesses and teleport spells off), each scene on its own dice (test/lib/dice.mjs
// scene), every piece of theme H off but the scene's own (setMovementRatesForTest), the walking bot driven by a stand
// task whose tick walks (BotAction walkTo) with full run energy and Hitpoints:
//   variants  three bots' Varrock West → Barbarian Village trips with variants 0, 1 and 2 forced: at least two different
//             routes, each at most 1.15 × variant 0's cost + 16 tiles, no tile in the Wilderness, all there with no rescue
//             jump; the graph alone: variants 1 and 2 differ from 0 on the trip; the habit is the same every time; with
//             the variants off routeVariant draws no dice and gives variant 0 (the walked lines: MV5 in the runner;
//             legs 2 nodes ahead walk past some of a variant's nodes, so a trip's tiles may not differ)
//   hops      Varrock West → East bank with the human within 64 tiles: every queue's farthest waypoint within 18 tiles
//             of the bot (the minimap's reach), the hops counted (minimapStats), there and back with no rescue jump,
//             walking (no run energy) in at most 1.3 × the ticks of the same walks with hops off; with pauses forced,
//             stands of 1-15 ticks at the flags, the stuck checks waiting (isCrossing) meanwhile
//   far       the same walk with no human within 64 tiles: legs as before (a queue reaching past 18 tiles), no hop
//   lanes     (Lumbridge → Draynor's fields) near-human legs to intermediate nodes aim beside the node (minimapStats
//             .lanes), the walk still arrives
//   overshoot an overshoot forced at every corner: the flag past the corner (free steps), the bot back at the corner and
//             on, there with no rescue jump
//   exempt    no hop on a walk into or in the Wilderness, a PKer's walk, a hurt bot's (HP under half), a minimapExempt
//             hook's
//   typing    a bot typing a long line as it walks stands at its flag until the line is said, then walks on
//   border    (the fixes, moveH-2) by Edgeville's rows under the Wilderness (z 3510-3519; 274 has no ditch), with
//             overshoots forced and lanes on: no hop's flag, overshoot's flag, lane's tile or tile walked in the
//             Wilderness; overshoots cut at corners under the border stop short of it, lanes shifted towards it refuse
//   upstairs  (the fixes, moveH-3) a near-human walk to Lumbridge castle's first floor (the spinning wheel): its overworld
//             hops chain (the next one clicked before the flag), and it gets there with no rescue jump
//   errors    none
//
//   node --expose-gc web/engine/bots/test/movement.test.mjs [--seed=5] [--only=variants,hops,...,border,upstairs]
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';
import { mulberry, scene } from './lib/dice.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const SEED = Number(args.seed ?? 5);
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const want = name => !ONLY || ONLY.has(name);
const out = (s = '') => process.stdout.write(s + '\n');
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
const errors = [];
for (const level of ['log', 'info', 'debug', 'warn']) console[level] = () => {};
console.error = (...a) => {
    const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
    if (!text.includes('ExperimentalWarning') && !text.includes('--trace-warnings')) errors.push(text.slice(0, 400));
};
Math.random = mulberry(SEED);

const engineDir = prepareEngineClone('movement', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/movement.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, Minimap: M } = lib;

const N = 8;
const sim = await lib.Sim.create({ bots: N, members: true, debug: false, ageNewBots: true });
sim.addHuman(3222, 3218, 0);
check('a staged world has every piece of theme H off (Sim.create without movement)', ['hops', 'pauses', 'overshoot', 'lanes', 'variants', 'walkUp', 'holds'].every(k => !M.movementOn(k)));
while (sim.bots().length < N && World.currentTick < 80) sim.tick();
lib.setHabitRatesForTest({ breaks: 0, lingers: 0, watch: 0, abrupt: 0 });
lib.setHangoutRateForTest(0.0001);
lib.setArenaRatesForTest(0);
lib.setDirectorForTest({ first: 1e9, gap: 1e9 });
lib.resetDirectorForTest();
lib.setCliqueBehaviourForTest(false);
lib.setEventRatesForTest({ odds: 0 });
lib.setTrainRatesForTest({ ask: 0, form: 0, yes: 0, join: 0 });
lib.setAlchRateForTest(0);
lib.setScamRatesForTest({ ambient: false });
lib.setWitnessRatesForTest({ death: 0, drop: 0, human: 0, show: 0, gear: 0, level: 0, respond: 0, fight: 0 });
lib.setD2OffersForTest(false);
lib.setLingerForTest(false);
lib.setTeleportRatesForTest({ teleporter: false });
for (let i = 0; i < 40; i++) sim.tick();
const bots = sim.bots();
check(`${N} bots in the world`, bots.length === N, bots.length);
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const at = p => [p.x, p.z];

const STAND = { name: 'Idle', reset() {}, interrupt() {}, interrupted: false, shouldRun: () => true, isComplete: () => false, tick() {}, activityStep: () => null };
/** the bot held with a stand task of this name whose tick does `drive` (its sub-task cleared), full HP and run energy */
function hold(p, name = 'Idle', drive = null) {
    const ai = sim.botPlayer(p);
    ai.currentTask = Object.assign(Object.create(STAND), { name, interrupted: false, tick: drive ? player => drive(player) : () => {} });
    ai.planEnds = World.currentTick + 1e6;
    if (ai.hasSubTask()) {
        ai._interruptSubTask?.();
        ai._dropSubTask?.();
    }
    p.levels[3] = p.baseLevels[3];
    p.runenergy = 10000;
    p.afkEventReady = false;
}
const place = (p, x, z) => {
    p.closeModal();
    p.clearWaypoints();
    p.clearInteraction();
    p.teleJump(x, z, 0);
};
for (const p of bots) hold(p);
/** the queues the bot makes (each one's farthest waypoint from the bot when queued) */
const queues = new Map();
/** (the fixes' scenes) each queue's waypoints and whether the bot still had waypoints then (a hop chained before its flag) */
const queueLog = new Map();
/** (the fixes' scenes) the bot's hop flag as the last tick left it (a queue then, within a few tiles of it: hopChain's) */
const hopSeen = new Map();
for (const p of bots) {
    const own = p.queueWaypoints.bind(p);
    p.queueWaypoints = path => {
        let far = 0;
        for (let i = 0; i < path.length; i++) far = Math.max(far, cheb([(path[i] >> 14) & 0x3fff, path[i] & 0x3fff], [p.x, p.z]));
        queues.get(p)?.push(far);
        // (a hop's queue: the hop record's flag is its last tile)
        const h = M.hopOf(p);
        const lastC = path.length ? path[path.length - 1] : -1;
        const seen = hopSeen.get(p);
        const nearFlag = !!seen && cheb([p.x, p.z], seen) <= 5;
        queueLog.get(p)?.push({ had: p.hasWaypoints(), nearFlag, level: p.level, hop: !!h && lastC === ((h.ex << 14) | h.ez), tiles: Array.from(path, c => [(c >> 14) & 0x3fff, c & 0x3fff]) });
        if (process.env.MV_DEBUG && queues.has(p)) out(`  queue t${World.currentTick} at ${p.x},${p.z} far ${far} n ${path.length} hop ${JSON.stringify(M.hopOf(p) ? [M.hopOf(p).ex, M.hopOf(p).ez, M.hopOf(p).rest.length] : null)} ${new Error().stack.split('\n').slice(2, 5).map(l => l.trim().replace(/\(.*\//, '(')).join(' < ')}`);
        return own(path);
    };
}

/**
 * `p` walks from `from` to `dest` with the rates given (the rest off), up to `max` ticks (`follow`: the human kept
 * within 64 tiles): its tiles each tick, its queues' reach, the ticks it stood still (and whether the stuck checks waited
 * then), arrival
 */
function walk(p, from, dest, rates, max = 700, each = () => {}, follow = false, run = true) {
    M.setMovementRatesForTest({ ...M.MOVEMENT_OFF, ...rates });
    hold(p, 'Idle', player => lib.walkTo(player, dest[0], dest[1], 0));
    place(p, from[0], from[1]);
    if (follow) sim.teleportHuman(from[0] + 14, from[1] + 14, 0);
    sim.tick();
    hold(p, 'Idle', player => lib.walkTo(player, dest[0], dest[1], 0));
    queues.set(p, []);
    const jumps0 = lib.teleportStats.jumps;
    const tiles = [];
    const stills = [];
    let still = 0;
    let stillCrossing = true;
    let arrived = -1;
    let prev = at(p);
    let route = null;
    for (let t = 0; t < max && arrived < 0; t++) {
        // (`run` false: no energy, a walk: a pause's cost against a walking player's time, as the research reckons it)
        p.runenergy = run ? 10000 : 0;
        if (!run) p.run = 0;
        // (`follow`: the human 20 tiles off the bot, every 20 ticks: always within 64 tiles of it)
        if (follow && t % 20 === 0) sim.teleportHuman(p.x + 14, p.z + 14, 0);
        sim.tick();
        each(t);
        route = route ?? lib.graphRouteOfForTest(p);
        const now = at(p);
        tiles.push(now);
        if (process.env.MV_DEBUG && queues.has(p)) out(`   t${World.currentTick} ${now} wp ${p.hasWaypoints()} cross ${lib.isCrossing(p)} hop ${JSON.stringify(M.hopOf(p) ? [M.hopOf(p).ex, M.hopOf(p).ez, M.hopOf(p).pause, M.hopOf(p).until, M.hopOf(p).typingSince] : null)} run ${p.run}`);
        if (cheb(now, prev) === 0) {
            still++;
            // (a pause at a hop's flag: the stuck checks wait)
            const h = M.hopOf(p);
            if (h && h.until >= 0 && World.currentTick < h.until && !lib.isCrossing(p)) stillCrossing = false;
        } else {
            if (still > 0) stills.push(still);
            still = 0;
        }
        prev = now;
        if (cheb(now, dest) <= 2) arrived = t + 1;
    }
    const result = { tiles, stills, arrived, jumps: lib.teleportStats.jumps - jumps0, queues: queues.get(p), route, stillCrossing };
    queues.delete(p);
    hold(p);
    p.clearWaypoints();
    return result;
}
const walker = bots.find(p => !lib.isNewbie(p)) ?? bots[0];
/** combat 70 in the melee stats (nothing on the way attacks it: the walks' timing is the walk's) */
function strong(p) {
    for (const stat of [0, 1, 2, 3]) {
        p.stats[stat] = lib.getExpByLevel(70);
        p.baseLevels[stat] = 70;
        p.levels[stat] = 70;
    }
}
for (const p of bots) strong(p);
const human = sim.human;

// ---- variants (H2) ----
if (want('variants')) {
    scene(SEED, 'variants');
    sim.teleportHuman(3222, 3218, 0);
    const from = [3183, 3429];
    const dest = [3082, 3420];
    const trio = bots.filter(p => p !== walker).slice(0, 3);
    const runs = [];
    for (let v = 0; v < 3; v++) {
        M.forceRouteVariantForTest(v);
        runs.push(walk(trio[v] ?? walker, from, dest, { variants: 1 }));
    }
    M.forceRouteVariantForTest(null);
    const routes = runs.map(r => r.route?.join(',') ?? null);
    const costs = runs.map(r => (r.route ? lib.graphRouteCost(r.route) : Infinity));
    check('variants: three bots with variants 0, 1 and 2 forced plan two or more different routes Varrock West → Barbarian Village', new Set(routes.filter(Boolean)).size >= 2, { routes: runs.map(r => r.route?.length), costs });
    check('variants: each at most 1.15 × variant 0\'s cost + 16 tiles', costs.every(c => c <= 1.15 * costs[0] + 16), costs);
    check('variants: no tile walked in the Wilderness', runs.every(r => r.tiles.every(([x, z]) => lib.wildernessLevelAt(x, z) === 0)));
    check('variants: all three there, with no rescue jump', runs.every(r => r.arrived > 0 && r.jumps === 0), runs.map(r => [r.arrived, r.jumps]));
    // the graph alone, on the trip's own nodes
    const a = lib.nearestNode(from[0], from[1]);
    const b = lib.nearestNode(dest[0], dest[1]);
    const g0 = lib.graphRoute(a, b);
    const g1 = lib.graphRoute(a, b, undefined, '', undefined, 1);
    const g2 = lib.graphRoute(a, b, undefined, '', undefined, 2);
    check('variants: the graph\'s variants 1 and 2 of the trip are not both variant 0\'s route', g0 && g1 && g2 && !(g1.join() === g0.join() && g2.join() === g0.join()), [g0?.length, g1?.length, g2?.length]);
    check('variants: variant 0 is the route as before (the same cached entry)', lib.graphRoute(a, b, undefined, '', undefined, 0) === g0);
    check('variants: the bot\'s habit for a goal is the same every time (seeded)', M.routeHabit(walker, b) === M.routeHabit(walker, b) && M.routeHabit(walker, b) >= 0 && M.routeHabit(walker, b) < 3);
    // off: no dice
    M.setMovementRatesForTest(M.MOVEMENT_OFF);
    let draws = 0;
    const real = Math.random;
    Math.random = () => {
        draws++;
        return real();
    };
    const got = M.routeVariant(walker, b, g0, v => lib.graphRoute(a, b, undefined, '', undefined, v));
    Math.random = real;
    check('variants: off, routeVariant draws no dice and gives variant 0', draws === 0 && got === g0, draws);
}

// ---- hops (H1) ----
// (Varrock West bank to Varrock East bank through the town: a walk of 70+ tiles with turns, where nothing attacks; the
// Lumbridge-Draynor road passes Draynor Manor, whose trees fought even a combat-70 walker at some seeds, and a walk
// taken up again within 40 tiles of its end after a fight is no long walk: no hops, as the research has it)
const HOP_FROM = [3183, 3429];
const HOP_DEST = [3253, 3420];
if (want('hops')) {
    scene(SEED, 'hops');
    sim.teleportHuman(3157, 3232, 0);
    // (there and back, with hops off and then on: the timing over both)
    const off = walk(walker, HOP_FROM, HOP_DEST, {}, 700, () => {}, true, false);
    const offBack = walk(walker, HOP_DEST, HOP_FROM, {}, 700, () => {}, true, false);
    scene(SEED, 'hops-on');
    const s0 = { ...M.minimapStats, hops: [...M.minimapStats.hops] };
    const on = walk(walker, HOP_FROM, HOP_DEST, { hops: 1, pauses: 1 }, 700, () => {}, true, false);
    const onBack = walk(walker, HOP_DEST, HOP_FROM, { hops: 1, pauses: 1 }, 700, () => {}, true, false);
    on.queues.push(...onBack.queues);
    const far = Math.max(...on.queues);
    check('hops: with the human within 64 tiles, no queue reaches past 18 tiles from the bot (Varrock West → East)', on.queues.length >= 4 && far <= 18, { queues: on.queues.length, far, offFar: Math.max(...off.queues) });
    check('hops: the walk is counted cut into hops (minimapStats)', M.minimapStats.walks > s0.walks && M.minimapStats.hops.reduce((a, n) => a + (n ?? 0), 0) > s0.hops.reduce((a, n) => a + (n ?? 0), 0), { walks: M.minimapStats.walks - s0.walks });
    check('hops: there and back, with no rescue jump', on.arrived > 0 && onBack.arrived > 0 && on.jumps + onBack.jumps === 0, [on.arrived, onBack.arrived, on.jumps, onBack.jumps]);
    check('hops: in at most 1.3 × the ticks of the walks with hops off', off.arrived > 0 && offBack.arrived > 0 && on.arrived + onBack.arrived <= 1.3 * (off.arrived + offBack.arrived), { on: [on.arrived, onBack.arrived, on.stills], off: [off.arrived, offBack.arrived, off.stills] });
    // pauses forced at every flag
    scene(SEED, 'hops-pauses');
    const p0 = M.minimapStats.pauses;
    const paused = walk(walker, HOP_FROM, HOP_DEST, { hops: 1, pauses: 100 }, 700, () => {}, true);
    const stands = paused.stills.filter(n => n >= 1 && n <= 16);
    check('hops: with pauses forced, the bot stands 1-15 ticks at its flags', M.minimapStats.pauses - p0 >= 3 && stands.length >= 3, { pauses: M.minimapStats.pauses - p0, stills: paused.stills });
    check('hops: the stuck checks wait while it stands (isCrossing)', paused.stillCrossing && paused.arrived > 0 && paused.jumps === 0, { arrived: paused.arrived, jumps: paused.jumps });
}

// ---- far: no human within 64 ----
if (want('far')) {
    scene(SEED, 'far');
    sim.teleportHuman(2965, 3380, 0);
    const w0 = M.minimapStats.walks;
    const r = walk(walker, HOP_FROM, HOP_DEST, { hops: 1, pauses: 1, overshoot: 1, lanes: 1 });
    check('far: with no human within 64 tiles, legs as before (a queue reaching past 18 tiles), no hop', Math.max(...r.queues) > 18 && M.minimapStats.walks === w0, { far: Math.max(...r.queues), walks: M.minimapStats.walks - w0 });
    check('far: there, with no rescue jump', r.arrived > 0 && r.jumps === 0, [r.arrived, r.jumps]);
}

// ---- lanes ----
if (want('lanes')) {
    scene(SEED, 'lanes');
    sim.teleportHuman(3157, 3232, 0);
    const l0 = M.minimapStats.lanes;
    // (a bot whose lane is off the line: ±1 a leg on top)
    const laner = bots.find(p => p !== walker && Math.abs(M.movementTraits(p).lane) === 2) ?? bots.find(p => M.movementTraits(p).lane !== 0) ?? walker;
    // (the fields from Lumbridge to Draynor: lanes on open roads; in town the walls refuse most)
    const r = walk(laner, [3215, 3225], [3100, 3250], { lanes: 1 }, 700, () => {}, true);
    check('lanes: near-human legs aim beside their intermediate nodes (the bot\'s lane, collision-checked)', M.minimapStats.lanes > l0, { lanes: M.minimapStats.lanes - l0, lane: M.movementTraits(laner).lane });
    check('lanes: the walk still arrives, with no rescue jump', r.arrived > 0 && r.jumps === 0, [r.arrived, r.jumps]);
}

// ---- overshoot ----
if (want('overshoot')) {
    scene(SEED, 'overshoot');
    const o0 = M.minimapStats.overshoots;
    const backs = [];
    let arrivals = 0;
    let jumps = 0;
    // (there and back, until two overshoots were seen: corners come where the dice cut)
    for (let k = 0; k < 6 && backs.length < 2; k++) {
        const [from, dest] = k % 2 === 0 ? [HOP_FROM, HOP_DEST] : [HOP_DEST, HOP_FROM];
        const seen = [];
        const r = walk(walker, from, dest, { hops: 1, overshoot: 1000 }, 700, () => {
            const h = M.hopOf(walker);
            if (h?.over && !seen.some(s => s.flag[0] === h.ex && s.flag[1] === h.ez)) seen.push({ flag: [h.ex, h.ez], corner: [(h.rest[0] >> 14) & 0x3fff, h.rest[0] & 0x3fff], tick: World.currentTick });
        }, true);
        if (r.arrived > 0) arrivals++;
        jumps += r.jumps;
        if (process.env.MV_DEBUG) out(`  overshoots ${JSON.stringify(seen)}`);
        for (const s of seen) {
            const i = r.tiles.findIndex(t => t[0] === s.flag[0] && t[1] === s.flag[1]);
            // (back at the corner: a run's 2 tiles a tick may pass it between two samples, so within a tile of it; one the
            // walk's arrival, within 2 tiles of the destination, came before or just after)
            const j = i < 0 ? -1 : r.tiles.findIndex((t, n) => n > i && cheb(t, s.corner) <= 1);
            backs.push({ reached: i >= 0, back: j >= 0, past: cheb(s.flag, s.corner), ended: cheb(s.flag, dest) <= 6 && (i < 0 || r.tiles.length - i <= 6) });
        }
        if (r.arrived < 0) break;
    }
    check('overshoot: forced at the corners, the bot goes 2-4 tiles past a corner (free steps)', M.minimapStats.overshoots > o0 && backs.length > 0 && backs.every(b => b.past >= 2 && b.past <= 4), { overshoots: M.minimapStats.overshoots - o0, backs });
    // (an overshoot's flag not reached: its step was blocked, the route dropped and planned again from there: the walk
    // still arrives, checked below)
    check('overshoot: it reaches the overshoot\'s flag, comes back to the corner and walks on', backs.some(b => b.reached) && backs.every(b => (b.reached && b.back) || b.ended || !b.reached), backs);
    check('overshoot: there, with no rescue jump', arrivals > 0 && jumps === 0, { arrivals, jumps });
}

// ---- exempt ----
if (want('exempt')) {
    scene(SEED, 'exempt');
    const rates = { hops: 1, pauses: 1, overshoot: 1, lanes: 1 };
    sim.teleportHuman(3110, 3550, 0);
    let w0 = M.minimapStats.walks;
    const inWild = walk(walker, [3080, 3540], [3150, 3560], rates, 300);
    check('exempt: no hop on a walk in the Wilderness (legs as before)', M.minimapStats.walks === w0 && Math.max(...inWild.queues) > 18, { walks: M.minimapStats.walks - w0, far: Math.max(...inWild.queues) });
    sim.teleportHuman(3094, 3490, 0);
    place(walker, 3094, 3480);
    sim.tick();
    check('exempt: none on a walk into the Wilderness (the destination past the ditch), out of it the same walk would hop', !M.hopsHere(walker, () => true, 3105, 3565) && M.hopsHere(walker, () => true, 3094, 3420));
    sim.teleportHuman(3157, 3232, 0);
    // a PKer's walk (its task's kind), a hurt bot's, a hook's
    w0 = M.minimapStats.walks;
    M.setMovementRatesForTest({ ...M.MOVEMENT_OFF, ...rates });
    hold(walker, 'PKer', player => lib.walkTo(player, HOP_DEST[0], HOP_DEST[1], 0));
    place(walker, HOP_FROM[0], HOP_FROM[1]);
    for (let t = 0; t < 120; t++) sim.tick();
    check("exempt: no hop on a PKer's walk", M.minimapStats.walks === w0, M.minimapStats.walks - w0);
    w0 = M.minimapStats.walks;
    hold(walker, 'Idle', player => {
        player.levels[3] = Math.max(1, Math.floor(player.baseLevels[3] * 0.4));
        lib.walkTo(player, HOP_DEST[0], HOP_DEST[1], 0);
    });
    place(walker, HOP_FROM[0], HOP_FROM[1]);
    for (let t = 0; t < 120; t++) sim.tick();
    check('exempt: no hop on a hurt bot\'s walk (HP under half: a flee)', M.minimapStats.walks === w0, M.minimapStats.walks - w0);
    w0 = M.minimapStats.walks;
    const hook = p => p === walker;
    M.minimapExempt.push(hook);
    const r = walk(walker, HOP_FROM, HOP_DEST, rates);
    M.minimapExempt.splice(M.minimapExempt.indexOf(hook), 1);
    check('exempt: no hop on a walk a minimapExempt hook names', M.minimapStats.walks === w0 && r.arrived > 0, { walks: M.minimapStats.walks - w0, arrived: r.arrived });
    hold(walker);
}

// ---- typing ----
if (want('typing')) {
    scene(SEED, 'typing');
    sim.teleportHuman(3157, 3232, 0);
    let said = -1;
    let typedAt = -1;
    let flag = null;
    const line = 'ya i was going to draynor to get some willows for my fletching then maybe back to lumby later on';
    const moves = [];
    const t0 = World.currentTick;
    const r = walk(walker, HOP_FROM, HOP_DEST, { hops: 1 }, 700, () => {
        const t = World.currentTick - t0;
        const h = M.hopOf(walker);
        moves.push({ t, at: at(walker), wp: walker.hasWaypoints() });
        // the line begun once the second hop is under way, 4+ tiles from its flag
        if (typedAt < 0 && h && t > 10 && walker.hasWaypoints() && cheb(at(walker), [h.ex, h.ez]) >= 4) {
            typedAt = t;
            flag = [h.ex, h.ez];
            lib.sayTyped(walker, line, { to: null, kind: 'practice', then: () => (said = World.currentTick - t0) });
        }
    }, true);
    const reached = flag ? moves.findIndex(m => m.t > typedAt && m.at[0] === flag[0] && m.at[1] === flag[1]) : -1;
    const stood = reached >= 0 && said > 0 ? moves.filter(m => m.t > moves[reached].t && m.t <= said).every(m => m.at[0] === flag[0] && m.at[1] === flag[1]) : false;
    const after = reached >= 0 && said > 0 ? moves.find(m => m.t > said + 3) : null;
    check('typing: a bot typing a long line walks to its flag and stands there until the line is said', typedAt > 0 && reached >= 0 && said > moves[reached].t && stood, { typedAt, flag, reached: reached >= 0 ? moves[reached].t : -1, said });
    check('typing: then it walks on, and gets there with no rescue jump', after && cheb(after.at, flag) > 0 && r.arrived > 0 && r.jumps === 0, { after: after?.at, arrived: r.arrived, jumps: r.jumps });
}

// ---- border: Edgeville's rows under the Wilderness (the fixes, moveH-2) ----
if (want('border')) {
    scene(SEED, 'border');
    const wild = ([x, z]) => lib.wildernessLevelAt(x, z) > 0;
    // (walks along the rows: Edgeville to Ice Mountain and back by the Monastery's road, the Goblin Village to the Black
    // Knights' Fortress and back; bots of every lane, overshoots forced at each corner)
    const trips = [
        [[3093, 3491], [3007, 3480]],
        [[3007, 3480], [3093, 3491]],
        [[2956, 3505], [3016, 3514]],
        [[3016, 3514], [2956, 3505]]
    ];
    const flags = [];
    const walked = [];
    const laned = [];
    let arrivals = 0;
    let jumps = 0;
    const o0 = M.minimapStats.overshoots;
    const l0 = M.minimapStats.lanes;
    const walkers = bots.filter(p => !lib.isNewbie(p)).slice(0, 4);
    for (let k = 0; k < trips.length; k++) {
        const p = walkers[k % walkers.length] ?? walker;
        queueLog.set(p, []);
        const r = walk(p, trips[k][0], trips[k][1], { hops: 1, overshoot: 1000, lanes: 1 }, 700, () => {
            const h = M.hopOf(p);
            if (h) {
                flags.push([h.ex, h.ez]);
                walked.push([p.x, p.z]);
            }
        }, true);
        // (a hop's queue; a leg walked whole (a route that dips into the Wilderness: no hop there) is the walk's as before)
        for (const q of queueLog.get(p)) if (q.hop) laned.push(...q.tiles);
        queueLog.delete(p);
        if (r.arrived > 0) arrivals++;
        jumps += r.jumps;
    }
    check('border: no hop\'s or overshoot\'s flag, hop\'s queued tile or tile walked on a hop in the Wilderness (Edgeville\'s rows, overshoots forced, lanes on)', flags.length > 0 && !flags.some(wild) && !laned.some(wild) && !walked.some(wild), { flags: flags.length, wildFlags: flags.filter(wild).slice(0, 4), wildQueued: laned.filter(wild).slice(0, 4), wildWalked: walked.filter(wild).slice(0, 4), overshoots: M.minimapStats.overshoots - o0, lanes: M.minimapStats.lanes - l0 });
    check('border: the walks get there, with no rescue jump', arrivals >= 3 && jumps === 0, { arrivals, jumps });
    // overshoots on their own: a corner at z 3516 whose step in heads north (2-4 tiles on would reach z 3520), from
    // several starts so the cut falls on the corner; every flag stays under z 3520 and some overshoots are still made
    M.setMovementRatesForTest({ ...M.MOVEMENT_OFF, hops: 1, overshoot: 1000 });
    const pack = (x, z) => (x << 14) | z;
    const overs = [];
    const p = walker;
    hold(p);
    for (const x of [3060, 3080, 3100, 3120, 3140]) {
        for (let d = 8; d <= 18; d++) {
            place(p, x, 3516 - d);
            sim.tick();
            M.cutHop(p, [pack(x, 3516), pack(x + 20, 3516)], x + 20, 3516, true);
            const h = M.hopOf(p);
            if (h?.over) overs.push([h.ex, h.ez]);
            M.dropHop(p);
        }
    }
    check('border: overshoots past a corner under the border (forced) stop short of the Wilderness', overs.length > 0 && !overs.some(wild), { overs: overs.length, wild: overs.filter(wild).slice(0, 4), maxZ: Math.max(...overs.map(o => o[1])) });
    // lanes on their own: a leg to the node at (2985, 3517) (the Goblin Village's road) by a bot whose lane is 2 off the
    // line, from the side its lane shifts north (+2: eastbound; −2: westbound), ± 1 a leg: 3 north (z 3520) refused,
    // 1 and 2 (z 3518-3519, the same free run) still taken
    M.setMovementRatesForTest({ ...M.MOVEMENT_OFF, lanes: 1 });
    const north = bots.find(q => Math.abs(M.movementTraits(q).lane) === 2) ?? null;
    const lanes = [];
    if (north) {
        place(north, M.movementTraits(north).lane > 0 ? 2965 : 3005, 3517);
        sim.tick();
        for (let i = 0; i < 30; i++) lanes.push(M.laneTarget(north, 1_000_000 + i, 2985, 3517, true));
        hold(north);
    }
    check('border: a lane by the border never shifts its tile into the Wilderness; short of it the lane still shifts', !north || (!lanes.some(wild) && lanes.some(([, z]) => z > 3517)), { north: north?.username ?? null, tiles: [...new Set(lanes.map(t => t.join(',')))] });
    M.setMovementRatesForTest(M.MOVEMENT_OFF);
    p.clearWaypoints();
}

// ---- upstairs: a walk to another floor (the fixes, moveH-3) ----
if (want('upstairs')) {
    scene(SEED, 'upstairs');
    const p = walker;
    // (Lumbridge castle's spinning wheel, its first floor: the castle's gateways, the stairs' room's doors; from the
    // fields towards Draynor, 100+ tiles)
    const [bx, bz, bl] = [3209, 3212, 1];
    const go = rates => {
        M.setMovementRatesForTest({ ...M.MOVEMENT_OFF, ...rates });
        const j0 = lib.teleportStats.jumps;
        const w0 = M.minimapStats.walks;
        const drive = player => lib.walkTo(player, bx, bz, bl);
        hold(p, 'Idle', drive);
        place(p, 3105, 3250);
        sim.teleportHuman(3119, 3264, 0);
        queueLog.set(p, []);
        sim.tick();
        hold(p, 'Idle', drive);
        let arrived = -1;
        for (let t = 0; t < 900 && arrived < 0; t++) {
            p.runenergy = 10000;
            if (t % 20 === 0 && p.level === 0) sim.teleportHuman(p.x + 14, p.z + 14, 0);
            sim.tick();
            const h = M.hopOf(p);
            hopSeen.set(p, h ? [h.ex, h.ez] : null);
            if (process.env.MV_DEBUG) out(`   up t${t} ${p.x},${p.z},${p.level} wp ${p.hasWaypoints()} hop ${JSON.stringify(M.hopOf(p) ? [M.hopOf(p).ex, M.hopOf(p).ez] : null)}`);
            if (p.level === bl && cheb(at(p), [bx, bz]) <= 3) arrived = t + 1;
        }
        const log = queueLog.get(p);
        queueLog.delete(p);
        hopSeen.delete(p);
        const r = { arrived, at: [p.x, p.z, p.level], jumps: lib.teleportStats.jumps - j0, walks: M.minimapStats.walks - w0, hops: log.filter(q => q.hop && q.level === 0).length, chained: log.filter(q => q.had && q.nearFlag && q.level === 0).length, queues: log.length };
        hold(p);
        p.clearWaypoints();
        return r;
    };
    const off = go({});
    const on = go({ hops: 1 });
    // (`chained`: queues made a few tiles from the last hop's flag, its waypoints not yet walked: hopChain's next hop, or
    // the leg's rest given whole when it lies within one hop; with hops off, none)
    check('upstairs: a near-human walk to Lumbridge castle\'s first floor hops on the overworld, the next hop clicked before the flag (the bot\'s floor, not the destination\'s)', on.walks >= 1 && on.hops >= 2 && on.chained >= 1 && off.chained === 0, { on, off });
    check('upstairs: it gets there, with no rescue jump, in at most 1.3 × the ticks of the walk with hops off', on.arrived > 0 && off.arrived > 0 && on.jumps === 0 && on.arrived <= 1.3 * off.arrived, { on, off });
    M.setMovementRatesForTest(M.MOVEMENT_OFF);
}

M.setMovementRatesForTest(M.MOVEMENT_OFF);
check('no errors', errors.length === 0 && lib.botErrorCount() === 0, errors.slice(0, 3).join(' | '));
const failed = checks.filter(c => !c.ok);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : `: ${c.detail}`}`);
out(failed.length ? `movement: ${failed.length} of ${checks.length} failed` : `movement: all ${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
