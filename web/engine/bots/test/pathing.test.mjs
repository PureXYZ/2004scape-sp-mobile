#!/usr/bin/env node
// The bots' route searches on the 274 map (port/BotPathing, BotAction's _pathTowards):
//   waypoints  274's PathFinder keeps ONE waypoint for maxWaypoints -1, the value upstream passed (254's kept the
//              whole route): a route with turns comes back as its first corner. botWalkPath asks for 25, the size of
//              the waypoint queue, and gets the route;
//   reach      the search covers 128×128 tiles around the bot, so a target 64 or more tiles away is never found; no
//              bot search aims further than 60 tiles;
//   budget     at most PATH_SEARCHES_PER_TICK searches per tick between all bots (12 per 100 online: 12 up to 100, 30
//              at 250, 60 at 500). A bot cut short carries on with its next attempt the following tick (no search is
//              repeated), and 40 bots sent across the map in the same tick all have a route a few ticks later.
//
//   node web/engine/bots/test/pathing.test.mjs
import path from 'path';
import { BOTS_DIR } from './lib/paths.mjs';
import { importInEngine } from './lib/clone.mjs';

const lib = await importInEngine(path.join(BOTS_DIR, 'test/lib/pathing.ts'), 'unit-path');
await lib.start();
const failures = [];
const check = (what, ok, detail = '') => {
    if (!ok) failures.push(`${what}${detail ? `: ${detail}` : ''}`);
};
const cheb = (ax, az, bx, bz) => Math.max(Math.abs(ax - bx), Math.abs(az - bz));
const walkable = (x, z) => !lib.BotCollisionMap.isCsvBlocked(0, x, z);

// ---- waypoints ----
// places around Lumbridge, each moved to the nearest walkable tile; pairs that are not connected (a closed door)
// are skipped
const nearestWalkable = (x, z) => {
    for (let r = 0; r <= 4; r++) {
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (cheb(0, 0, dx, dz) === r && walkable(x + dx, z + dz)) return [x + dx, z + dz];
    }
    throw new Error(`nothing walkable near ${x},${z}`);
};
const PLACES = Object.entries({
    'Lumbridge spawn': [3222, 3218],
    "Bob's axes": [3230, 3203],
    'church': [3243, 3209],
    'general store': [3212, 3247],
    'cow field': [3253, 3270],
    'castle courtyard north': [3221, 3236],
    'river bank': [3240, 3240],
    'swamp path': [3215, 3185]
}).map(([name, [x, z]]) => [name, ...nearestWalkable(x, z)]);
let multiTurn = 0;
const routeLines = [];
for (const [fromName, fx, fz] of PLACES) {
    for (const [toName, tx, tz] of PLACES) {
        if (fromName === toName || cheb(fx, fz, tx, tz) > 60) continue;
        lib.beginPathTick();
        const full = [...lib.botFindPath(0, fx, fz, tx, tz)];
        if (full.length === 0) continue;
        const one = lib.rawPath(0, fx, fz, tx, tz, -1, false);
        check(`${fromName} -> ${toName}: at most ${lib.BOT_MAX_WAYPOINTS} waypoints`, full.length <= lib.BOT_MAX_WAYPOINTS, `${full.length}`);
        const [lx, lz] = lib.unpack(full[full.length - 1]);
        check(`${fromName} -> ${toName}: the route ends at the destination`, lx === tx && lz === tz, `${lx},${lz}`);
        if (full.length > 1) {
            multiTurn++;
            check(`${fromName} -> ${toName}: maxWaypoints -1 keeps only the first corner`, one.length === 1 && one[0] === full[0], `${one.length} waypoint(s)`);
            if (routeLines.length < 4) routeLines.push(`${fromName} -> ${toName}: ${full.length} waypoints (maxWaypoints -1: ${one.length})`);
        }
    }
}
check('some routes have turns', multiTurn >= 5, `${multiTurn}`);

// ---- reach ----
{
    const [, sx, sz] = PLACES[0]; // Lumbridge spawn
    let near = 0;
    let far = 0;
    for (let i = 0; i < 64 && (near < 5 || far < 5); i++) {
        const angle = (i / 64) * 2 * Math.PI;
        for (const [dist, kind] of [[58, 'near'], [70, 'far']]) {
            const x = Math.round(sx + Math.cos(angle) * dist);
            const z = Math.round(sz + Math.sin(angle) * dist);
            if (!walkable(x, z)) continue;
            const found = lib.rawPath(0, sx, sz, x, z, 25).length > 0;
            if (kind === 'far') {
                far++;
                check(`a target ${cheb(sx, sz, x, z)} tiles away (${x},${z}) is out of the search window`, !found);
            } else if (found) near++;
        }
    }
    check('targets 58 tiles away are found', near >= 5, `${near}`);
    check('targets 70 tiles away were tried', far >= 5, `${far}`);
}

// ---- budget ----
lib.takeSearches();
lib.beginPathTick();
for (let i = 0; i < lib.PATH_SEARCHES_PER_TICK + 3; i++) lib.botWalkPath(0, 3222, 3218, 3230, 3203);
check('every search is counted', lib.pathSearchesThisTick() === lib.PATH_SEARCHES_PER_TICK + 3 && lib.pathBudgetLeft() === 0, `${lib.pathSearchesThisTick()} counted, ${lib.pathBudgetLeft()} left`);
{
    const budgets = [0, 25, 50, 100, 101, 250, 500, 750, 1000].map(n => lib.pathSearchBudgetFor(n));
    check('the budget grows with the bots online: 12 per 100, at least 12', budgets.join() === '12,12,12,12,13,30,60,90,120', budgets.join());
    lib.setPathSearchBudget(60);
    lib.beginPathTick();
    const left = lib.pathBudgetLeft();
    for (let i = 0; i < 61; i++) lib.botWalkPath(0, 3222, 3218, 3230, 3203);
    check('a budget of 60 (500 online) lets 60 searches start in a tick', left === 60 && lib.pathBudgetLeft() === 0 && lib.pathSearchBudget() === 60, `${left} at the start, ${lib.pathBudgetLeft()} left`);
    lib.setPathSearchBudget(lib.PATH_SEARCHES_PER_TICK); // the rest of the test: the budget for up to 100 online
    lib.beginPathTick();
}

const DESTINATIONS = [
    ['Varrock west bank', 3185, 3436],
    ['Falador east bank', 3013, 3355],
    ['Draynor bank', 3093, 3244],
    ['Al Kharid bank', 3269, 3167],
    ['Edgeville', 3094, 3491],
    ['Port Sarim', 3013, 3215],
    ['Barbarian Village', 3082, 3420],
    ['Lumbridge swamp', 3230, 3150]
];
const STARTS = [[3222, 3218], [3105, 3250], [3212, 3428], [2990, 3375], [3253, 3260]]; // Lumbridge, Draynor, Varrock, Falador, cows
const bots = [];
for (let i = 0; bots.length < 40; i++) {
    const [sx, sz] = STARTS[i % STARTS.length];
    const [x, z] = nearestWalkable(sx + ((i * 3) % 5) - 2, sz + ((i * 7) % 5) - 2);
    const [name, dx, dz] = DESTINATIONS[i % DESTINATIONS.length];
    if (cheb(x, z, dx, dz) < 30) continue;
    bots.push({ player: lib.botAt(`path test ${bots.length}`, x, z), name, dx, dz, routedAt: -1, searches: new Set(), repeats: 0 });
}
lib.takeSearches();
let maxPerTick = 0;
let maxReach = 0;
let total = 0;
let tick = 0;
for (; tick < 40 && bots.some(b => b.routedAt === -1); tick++) {
    lib.beginPathTick();
    const first = tick % bots.length; // BotManager's rotation
    for (let i = 0; i < bots.length; i++) {
        const b = bots[(first + i) % bots.length];
        if (b.routedAt !== -1) continue;
        const before = lib.takeSearches();
        if (before.length) throw new Error('a search outside a bot');
        lib.walkTo(b.player, b.dx, b.dz);
        for (const s of lib.takeSearches()) {
            const key = `${s.srcX},${s.srcZ}>${s.destX},${s.destZ}`;
            if (b.searches.has(key)) b.repeats++;
            b.searches.add(key);
            maxReach = Math.max(maxReach, cheb(s.srcX, s.srcZ, s.destX, s.destZ));
            total++;
        }
        if (b.player.hasWaypoints()) b.routedAt = tick;
    }
    maxPerTick = Math.max(maxPerTick, lib.pathSearchesThisTick());
}
const unrouted = bots.filter(b => b.routedAt === -1);
const naive = bots.filter(b => {
    const wp = lib.waypoints(b.player);
    return wp.length === 1 && cheb(b.player.x, b.player.z, wp[0][0], wp[0][1]) <= 1;
});
check(`at most ${lib.PATH_SEARCHES_PER_TICK} searches in a tick`, maxPerTick <= lib.PATH_SEARCHES_PER_TICK, `${maxPerTick}`);
check('no search aims more than 60 tiles away', maxReach <= 60, `${maxReach}`);
check('no bot repeats a search (it resumes where the budget stopped it)', bots.every(b => b.repeats === 0), bots.filter(b => b.repeats).map(b => `${b.player.username} ${b.repeats}`).join(', '));
check('every bot has a route', unrouted.length === 0, unrouted.map(b => `${b.player.username} -> ${b.name}`).join(', '));
check('no bot fell back to a one-tile step', naive.length === 0, naive.map(b => `${b.player.username} -> ${b.name}`).join(', '));

// ---- resume: a bot whose every search fails goes through its list once, the budget at a time, then steps ----
let resumeLine = '';
{
    const [x, z] = nearestWalkable(3240, 3240);
    const p = lib.botAt('path test resume', x, z);
    lib.failSearchesFrom(x, z);
    lib.takeSearches();
    const seen = new Set();
    let repeats = 0;
    let searched = 0;
    let perTick = 0;
    let ticks = 0;
    for (; ticks < 20 && !p.hasWaypoints(); ticks++) {
        lib.beginPathTick();
        lib.walkTo(p, 3093, 3244); // Draynor bank
        const done = lib.takeSearches();
        perTick = Math.max(perTick, done.length);
        for (const s of done) {
            const key = `${s.srcX},${s.srcZ}>${s.destX},${s.destZ}`;
            if (seen.has(key)) repeats++;
            seen.add(key);
            searched++;
        }
    }
    lib.failSearchesFrom(null);
    const wp = lib.waypoints(p);
    check('a bot whose searches all fail tries each attempt once', repeats === 0, `${repeats} repeated`);
    check('... at most the budget in a tick', perTick <= lib.PATH_SEARCHES_PER_TICK, `${perTick}`);
    check('... over more than one tick', ticks >= 2, `${ticks}`);
    check('... and then takes a one-tile step', wp.length === 1 && cheb(x, z, wp[0][0], wp[0][1]) === 1, JSON.stringify(wp));
    resumeLine = `a bot whose searches all fail: ${searched} attempts over ${ticks} ticks (at most ${perTick} a tick), each once, then a one-tile step`;
}

// ---- (the variety work, round 1, track F) a walk's waits for the budget; Lumbridge castle's stairs (ISS-1, ISS-10) ----
// A walk that finds the tick's searches spent stands and is recorded as waiting (BotAction.waitedForBudgetSince: the stuck
// checks leave such ticks out), its place kept for the next tick; the castle's stairs: the gateway's approach tile is in
// the stairs' room, and the climb there clicks the south-west spiral staircase, used from a route the approach reaches
// (the walk through the hall's three doors to it, with the searches spent most ticks: test/fixes.test.mjs)
let budgetLine = '';
{
    const [x, z] = nearestWalkable(3222, 3218);
    const p = lib.botAt('path test wait', x, z);
    lib.beginPathTick();
    while (lib.pathBudgetLeft() > 0) lib.botWalkPath(0, 3222, 3218, 3230, 3203);
    lib.walkTo(p, 3093, 3244);
    check('a walk with the tick\'s searches spent stands, recorded as a wait for the budget', !p.hasWaypoints() && lib.waitedForBudgetSince(p, 0), `${lib.waypoints(p).length} waypoints`);
    lib.beginPathTick();
    lib.walkTo(p, 3093, 3244);
    check('... and with searches the next tick it has its route', p.hasWaypoints());
    const stairs = lib.nearestLocWithOp(0, 3206, 3210, 8, 'climb-up');
    const used = stairs && lib.botPathToLoc(0, 3206, 3210, stairs.x, stairs.z, stairs.width, stairs.length, stairs.angle, stairs.shape, stairs.forceapproach, false).length > 0;
    check('Lumbridge castle: from the stairs\' approach (3206,3210) the climb clicks the south-west spiral staircase (3204,3207), a route reaches it', stairs && stairs.x === 3204 && stairs.z === 3207 && /stairs/.test(stairs.name) && used, JSON.stringify(stairs));
    budgetLine = `a walk with the searches spent waits (recorded), routed the next tick; the castle's stairs: ${stairs?.name} at ${stairs?.x},${stairs?.z} from the approach`;
}

console.log(`pathing: ${multiTurn} routes with turns around Lumbridge, e.g.`);
for (const l of routeLines) console.log(`  ${l}`);
console.log(`  40 bots sent to ${DESTINATIONS.length} places in one tick: all routed after ${tick} ticks, ${total} searches, at most ${maxPerTick} per tick (budget ${lib.PATH_SEARCHES_PER_TICK}), furthest target ${maxReach} tiles`);
console.log(`  ${resumeLine}`);
console.log(`  ${budgetLine}`);
if (failures.length) {
    for (const f of failures) console.log(`FAIL ${f}`);
    console.log(`${failures.length} failure(s)`);
    process.exit(1);
}
console.log('ok');
