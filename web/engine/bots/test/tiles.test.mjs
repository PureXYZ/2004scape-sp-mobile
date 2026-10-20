#!/usr/bin/env node
// The realism work, phase 3 ("where bots are"), on the real 274 map (test/lib/tiles.ts): a standing bot's own tile
// (port/BotTiles: free, walkable, reachable from its spot, never another's, a step apart where it can, given back,
// lost when its bot leaves the world), a tile at a loc it works at (the game's own reach), the hang-out spots
// (port/BotHangout: each has room to stand, and one is picked within its range), and the path searches' level of detail
// (port/BotPathing L1: the far bots' third of a tick's budget).
//
//   node web/engine/bots/test/tiles.test.mjs
import path from 'path';
import { BOTS_DIR } from './lib/paths.mjs';
import { importInEngine, simWorldConfig } from './lib/clone.mjs';

for (const level of ['log', 'info', 'debug', 'warn']) console[level] = () => {};
const out = s => process.stdout.write(`${s}\n`);
const failures = [];
let checks = 0;
function check(name, ok, detail = '') {
    checks++;
    if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

// seeded dice (the claims pick among the free tiles at random)
{
    let s = 7;
    Math.random = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const lib = await importInEngine(path.join(BOTS_DIR, 'test/lib/tiles.ts'), 'unit-tiles', simWorldConfig({ members: true }));
await lib.start();
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));

// ---- claims at Falador park ----
{
    const [px, pz] = [2997, 3375];
    const reach = lib.tilesInSquare(0, px, pz, 5);
    const bots = Array.from({ length: 8 }, (_, i) => lib.playerAt(`park ${i}`, px - 20, pz));
    const tiles = bots.map(b => lib.claimStandTile(b, px, pz, 0, 5));
    check('park: eight bots each get a tile', tiles.every(t => t !== null), JSON.stringify(tiles));
    const keys = new Set(tiles.filter(Boolean).map(([x, z]) => `${x},${z}`));
    check('park: eight different tiles', keys.size === 8, [...keys].join(' '));
    check('park: every tile within the radius, walkable and reachable from the spot', tiles.every(t => t && cheb(t, [px, pz]) <= 5 && !lib.BotCollisionMap.isCsvBlocked(0, t[0], t[1]) && reach.has((t[0] << 14) | t[1])));
    const adjacent = tiles.some((a, i) => tiles.some((b, j) => i !== j && cheb(a, b) <= 1));
    check('park: a step apart (no two claims side by side while there is room)', !adjacent, JSON.stringify(tiles));
    check('park: the same bot asking again keeps its tile', JSON.stringify(lib.claimStandTile(bots[0], px, pz, 0, 5)) === JSON.stringify(tiles[0]));
    check('park: standTileOf is the claim', JSON.stringify(lib.standTileOf(bots[1])) === JSON.stringify([...tiles[1], 0]));
    check('park: a claimed tile is claimed (for another, not for its own bot)', lib.isTileClaimed(tiles[2][0], tiles[2][1], 0) && !lib.isTileClaimed(tiles[2][0], tiles[2][1], 0, bots[2]));
    // released: free again
    lib.releaseStandTile(bots[3]);
    check('park: released, the tile is free', !lib.isTileClaimed(tiles[3][0], tiles[3][1], 0) && lib.standTileOf(bots[3]) === null);
    // a bot that left the world holds nothing
    lib.leave(bots[4]);
    check('park: a bot that left the world holds no tile', !lib.isTileClaimed(tiles[4][0], tiles[4][1], 0));
    // a player standing on a tile: never given
    const stander = lib.playerAt('stander', tiles[3][0], tiles[3][1], 0, false);
    lib.stand(stander);
    const late = Array.from({ length: 12 }, (_, i) => lib.playerAt(`late ${i}`, px, pz - 20));
    const lateTiles = late.map(b => lib.claimStandTile(b, px, pz, 0, 5));
    check('park: a tile a player stands on is never given', lateTiles.every(t => !t || t[0] !== tiles[3][0] || t[1] !== tiles[3][1]));
    const all = [...tiles.filter((_, i) => i !== 3 && i !== 4), ...lateTiles.filter(Boolean)].map(([x, z]) => `${x},${z}`);
    check('park: twenty bots, still a tile each', new Set(all).size === all.length && lateTiles.every(Boolean), `${new Set(all).size} of ${all.length}`);
    check('park: sharesTile sees the stander on its own tile', lib.sharesTile(lib.playerAt('on it', tiles[3][0], tiles[3][1])));
    for (const b of [...bots, ...late]) lib.releaseStandTile(b);
}

// ---- a small spot fills up; the predicate holds ----
{
    const [x, z] = [3212, 3428]; // Varrock square
    const free = [...lib.tilesInSquare(0, x, z, 1)].filter(k => !lib.BotCollisionMap.isCsvBlocked(0, k >> 14, k & 0x3fff)).length;
    const bots = Array.from({ length: free + 3 }, (_, i) => lib.playerAt(`square ${i}`, x, z));
    const tiles = bots.map(b => lib.claimStandTile(b, x, z, 0, 1));
    check(`square: radius 1 has ${free} free tiles: that many claims, then none`, tiles.filter(Boolean).length === free && tiles.slice(free).every(t => t === null), `${tiles.filter(Boolean).length} claims`);
    for (const b of bots) lib.releaseStandTile(b);
    const even = lib.claimStandTile(bots[0], x, z, 0, 4, (tx, tz) => tx % 2 === 0 && tz % 2 === 0);
    check('square: the predicate holds', even !== null && even[0] % 2 === 0 && even[1] % 2 === 0, JSON.stringify(even));
    lib.releaseStandTile(bots[0]);
    check('claims: none left once all are given back', lib.claimedTiles() === 0, `${lib.claimedTiles()}`);
}

// ---- a tile at a loc it works at: the Falador furnace, the Varrock west anvil ----
for (const [what, name, x, z] of [['furnace', 'furnace1', 2975, 3369], ['anvil', 'anvil', 3188, 3422]]) {
    const loc = lib.findLocByName(x, z, 0, name, 8);
    check(`${what}: found on the map`, loc !== null);
    if (!loc) continue;
    const smiths = Array.from({ length: 3 }, (_, i) => lib.playerAt(`${what} ${i}`, x, z));
    const tiles = smiths.map(b => lib.claimLocTile(b, loc, 1));
    check(`${what}: three smiths, three tiles (or as many as it has sides)`, tiles.filter(Boolean).length >= 2, JSON.stringify(tiles));
    check(`${what}: each tile one the loc is used from`, tiles.every(t => !t || lib.usesLocFrom(loc, t[0], t[1])));
    check(`${what}: no two the same`, new Set(tiles.filter(Boolean).map(t => `${t[0]},${t[1]}`)).size === tiles.filter(Boolean).length);
    for (const b of smiths) lib.releaseStandTile(b);
}

// ---- the hang-out spots: room to stand at each, and the pick within range ----
for (const spot of lib.HANGOUT_SPOTS) {
    const bots = Array.from({ length: 6 }, (_, i) => lib.playerAt(`${spot.key} ${i}`, spot.x, spot.z));
    const tiles = bots.map(b => lib.claimStandTile(b, spot.x, spot.z, 0, spot.radius));
    check(`hang-out ${spot.key}: six bots stand there, a tile each within ${spot.radius}`, tiles.every(t => t && Math.max(Math.abs(t[0] - spot.x), Math.abs(t[1] - spot.z)) <= spot.radius), JSON.stringify(tiles));
    for (const b of bots) lib.releaseStandTile(b);
}
// ---- (the integration of phase 4) every social hub and hang-out spot opens on the world: its stand tiles in no
// closed-off pocket (the Varrock banks' social spots gave the bankers' side of the counter: regulars stood with the
// bankers, and BotManager moved them into the hall at their next login)
for (const spot of [...lib.SOCIAL_HUBS.map(h => ({ ...h, what: 'social hub' })), ...lib.HANGOUT_SPOTS.map(h => ({ ...h, what: 'hang-out' }))]) {
    const bots = Array.from({ length: 8 }, (_, i) => lib.playerAt(`${spot.key} open ${i}`, spot.x, spot.z));
    const tiles = bots.map(b => lib.claimStandTile(b, spot.x, spot.z, 0, spot.radius)).filter(Boolean);
    const pockets = tiles.filter(([x, z]) => lib.tilesInSquare(0, x, z, 24).size < 200);
    check(`${spot.what} ${spot.key}: its stand tiles open on the world (none in a pocket of under 200 tiles: behind a counter)`, tiles.length >= 4 && pockets.length === 0, `${tiles.length} tiles; in a pocket: ${pockets.map(t => t.join(',')).join(' ')}`);
    for (const b of bots) lib.releaseStandTile(b);
}
{
    const bot = lib.playerAt('picker', 3000, 3360);
    const picks = new Map();
    for (let i = 0; i < 300; i++) {
        const s = lib.pickHangout(bot);
        if (s) picks.set(s.key, (picks.get(s.key) ?? 0) + 1);
    }
    const far = [...picks.keys()].filter(k => {
        const s = lib.HANGOUT_SPOTS.find(h => h.key === k);
        return Math.max(Math.abs(s.x - bot.x), Math.abs(s.z - bot.z)) > lib.HANGOUT_RANGE;
    });
    check('hang-out pick: from Falador, only spots within range', far.length === 0, far.join(', '));
    check('hang-out pick: from Falador the park most often', [...picks].sort((a, b) => b[1] - a[1])[0]?.[0] === 'falador_park', JSON.stringify([...picks]));
    const lost = lib.playerAt('far off', 2400, 3000);
    check('hang-out pick: none in range, none picked', lib.pickHangout(lost) === null);
    const low = lib.playerAt('low', 3092, 3260);
    let draynor = 0;
    for (let i = 0; i < 100; i++) if (lib.pickHangout(low)?.key === 'draynor_bank') draynor++;
    check('hang-out pick: no Draynor bank under combat 16 (its dark wizards)', draynor === 0, `${draynor}`);
}

// ---- the level of detail (L1): the far bots' third ----
{
    lib.setPathSearchBudget(12);
    lib.beginPathTick();
    check('L1: with no human, a bot anywhere has the whole budget', lib.pathBudgetLeft({ x: 3000, z: 3000, level: 0 }) === 12);
    lib.humanAt(3222, 3218);
    lib.beginPathTick();
    check('L1: the far bots get a third (4 of 12)', lib.farSearchBudget() === 4);
    check('L1: near a human: the whole budget', lib.pathBudgetLeft({ x: 3222 + lib.LOD_NEAR_TILES, z: 3218, level: 0 }) === 12);
    check('L1: far from it: its third', lib.pathBudgetLeft({ x: 3222 + lib.LOD_NEAR_TILES + 1, z: 3218, level: 0 }) === 4);
    check('L1: underground below it is far', lib.farFromHumans(0, 3222, 3218 + 6400));
    for (let i = 0; i < 4; i++) lib.botWalkPath(0, 3100, 3300, 3110, 3305);
    check('L1: four far searches use up the far third, not the near bots\' share', lib.pathBudgetLeft({ x: 3100, z: 3300, level: 0 }) === 0 && lib.pathBudgetLeft({ x: 3220, z: 3220, level: 0 }) === 8 && lib.farSearchesThisTick() === 4);
    for (let i = 0; i < 8; i++) lib.botWalkPath(0, 3220, 3220, 3225, 3225);
    check('L1: the near bots may use the rest', lib.pathBudgetLeft({ x: 3220, z: 3220, level: 0 }) === 0 && lib.pathSearchesThisTick() === 12);
    lib.setPathSearchBudget(60);
    lib.beginPathTick();
    check('L1: at 500 bots (60 a tick) the far bots get 20', lib.farSearchBudget() === 20 && lib.pathBudgetLeft({ x: 3000, z: 3000, level: 0 }) === 20);
}

out(`tiles: ${checks} checks: own tiles at Falador park, Varrock square, the Falador furnace and the Varrock anvil, ${lib.HANGOUT_SPOTS.length} hang-out spots, the level of detail`);
for (const f of failures) out(`FAIL ${f}`);
out(failures.length ? `${failures.length} failed` : 'ok');
process.exit(failures.length ? 1 : 0);
