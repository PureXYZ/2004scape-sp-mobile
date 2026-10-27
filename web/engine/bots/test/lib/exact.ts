// For test/exact.test.mjs: the real 274 world (test/lib/simworld.ts) with the bot library's faster internals and what
// they replace, in one module graph: port/BotPathFinder's search and the engine's PathFinder (routefinder.findPath);
// BotAction's zone searches (port/BotZoneScan's loops, npcWithin, the aggressor index) and the engine's generators;
// the tick's arrays of the players (port/BotPlayers) and the active bots and the generators they stand for; the walking
// graph's A* (port/BotWalkGraph.route) and the original one.
import World from '#/engine/World.js';
import type Npc from '#/engine/entity/Npc.js';
import type Loc from '#/engine/entity/Loc.js';
import Obj from '#/engine/entity/Obj.js';
import type Player from '#/engine/entity/Player.js';
import { setScanCheckForTest, type ScanCheck } from '#/engine/bot/BotAction.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { setPlayersCheckForTest } from '#/engine/bot/port/BotPlayers.js';

export { findAggressorNpc, findOtherAggressorNpc } from '#/engine/bot/BotAction.js';

export * from './simworld.js';
export { botRoute } from '#/engine/bot/port/BotPathFinder.js';
export { wrapBotRouteForTest } from '#/engine/bot/port/BotPathing.js';
export { CollisionType } from '#/engine/routefinder/index.js';
export { isMapBlocked, isZoneAllocated } from '#/engine/GameMap.js';
export { route as graphRoute, componentOf, nearestNodes, nodeCount, nodePos } from '#/engine/bot/port/BotWalkGraph.js';
import { neighbours, nodeCount, nodePos } from '#/engine/bot/port/BotWalkGraph.js';

// ---- the zone searches as they were (Zone.getAll*Safe, the engine's generators) ----

function* zonesOf(cx: number, cz: number, level: number, radius: number) {
    const zoneRadius = Math.ceil(radius / 8) + 1;
    for (let dz = -zoneRadius; dz <= zoneRadius; dz++) {
        for (let dx = -zoneRadius; dx <= zoneRadius; dx++) yield World.gameMap.getZone(cx + dx * 8, cz + dz * 8, level);
    }
}

export function genNpc(cx: number, cz: number, level: number, radius: number, predicate: (npc: Npc) => boolean): Npc | null {
    let best: Npc | null = null;
    let bestDist = Infinity;
    for (const zone of zonesOf(cx, cz, level, radius)) {
        for (const npc of zone.getAllNpcsSafe()) {
            const dist = Math.abs(npc.x - cx) + Math.abs(npc.z - cz);
            if (dist > radius * 2 || dist >= bestDist || !predicate(npc)) continue;
            bestDist = dist;
            best = npc;
        }
    }
    return best;
}

export function genLoc(cx: number, cz: number, level: number, radius: number, predicate: (loc: Loc) => boolean): Loc | null {
    let best: Loc | null = null;
    let bestDist = Infinity;
    for (const zone of zonesOf(cx, cz, level, radius)) {
        for (const loc of zone.getAllLocsSafe()) {
            const dist = Math.abs(loc.x - cx) + Math.abs(loc.z - cz);
            if (dist > radius * 2 || dist >= bestDist) continue;
            if (!predicate(loc)) continue;
            bestDist = dist;
            best = loc;
        }
    }
    return best;
}

export function genObj(player: Player, cx: number, cz: number, level: number, radius: number, predicate: (obj: Obj) => boolean): Obj | null {
    let best: Obj | null = null;
    let bestDist = Infinity;
    for (const zone of zonesOf(cx, cz, level, radius)) {
        for (const obj of zone.getAllObjsSafe()) {
            if (!predicate(obj)) continue;
            if (obj.receiver64 === Obj.NO_RECEIVER || obj.receiver64 === player.hash64) {
                const dist = Math.abs(obj.x - cx) + Math.abs(obj.z - cz);
                if (dist <= radius * 2 && dist < bestDist) {
                    bestDist = dist;
                    best = obj;
                }
            }
        }
    }
    return best;
}

export interface ScanStats {
    npc: number;
    loc: number;
    obj: number;
    within: number;
    acting: number;
    actingFound: number;
    predicateCalls: number;
    mismatches: string[];
}

/**
 * Every zone search of the library beside the generators': the library's runs first with a predicate that records
 * each call and its answer, then the generators' with one that replays them, checking it is called on the same
 * entities in the same order (so the caller's predicate runs once, as without the check). npcWithin and the aggressor
 * lookup (pure predicates) against the search they stand for.
 */
export function checkScans(): ScanStats {
    const stats: ScanStats = { npc: 0, loc: 0, obj: 0, within: 0, acting: 0, actingFound: 0, predicateCalls: 0, mismatches: [] };
    const fail = (what: string) => {
        if (stats.mismatches.length < 8) stats.mismatches.push(what);
    };
    function compare<T>(kind: 'npc' | 'loc' | 'obj', where: string, predicate: (e: T) => boolean, run: (p: (e: T) => boolean) => T | null, reference: (p: (e: T) => boolean) => T | null): T | null {
        const seen: T[] = [];
        const answers: boolean[] = [];
        const got = run(e => {
            const a = predicate(e);
            seen.push(e);
            answers.push(a);
            return a;
        });
        let k = 0;
        let order = true;
        const want = reference(e => {
            if (seen[k] !== e) order = false;
            return k < answers.length ? answers[k++] : false;
        });
        stats[kind]++;
        stats.predicateCalls += seen.length;
        if (got !== want || !order || k !== seen.length) fail(`${kind} ${where}: ${got === want ? 'same answer' : 'another answer'}, predicate calls ${order && k === seen.length ? 'the same' : `differ (${seen.length} / ${k})`}`);
        return got;
    }
    const check: ScanCheck = {
        npc: (cx, cz, level, radius, predicate, run) => compare('npc', `${cx},${cz},${level} r${radius}`, predicate, run, p => genNpc(cx, cz, level, radius, p)),
        loc: (cx, cz, level, radius, predicate, run) => compare('loc', `${cx},${cz},${level} r${radius}`, predicate, run, p => genLoc(cx, cz, level, radius, p)),
        obj: (player, cx, cz, level, radius, predicate, run) => compare('obj', `${cx},${cz},${level} r${radius}`, predicate, run, p => genObj(player, cx, cz, level, radius, p)),
        within(npc, cx, cz, level, radius, answer) {
            stats.within++;
            if (answer !== (genNpc(cx, cz, level, radius, n => n === npc) !== null)) fail(`within ${npc.nid} from ${cx},${cz},${level} r${radius}: ${answer}`);
        },
        acting(player, radius, acts, answer) {
            stats.acting++;
            if (answer) stats.actingFound++;
            if (answer !== genNpc(player.x, player.z, player.level, radius, acts)) fail(`acting on ${player.username} r${radius}: ${answer?.nid ?? null}`);
        }
    };
    setScanCheckForTest(check);
    return stats;
}

export interface ArrayStats {
    players: number;
    active: number;
    mismatches: string[];
}

/** Every use of the tick's players array (port/BotPlayers) and active-bots array against a fresh pass of the generator. */
export function checkArrays(): ArrayStats {
    const stats: ArrayStats = { players: 0, active: 0, mismatches: [] };
    const same = (array: readonly Player[], fresh: Iterable<Player>): boolean => {
        let i = 0;
        for (const p of fresh) if (array[i++] !== p) return false;
        return i === array.length;
    };
    setPlayersCheckForTest(players => {
        stats.players++;
        if (!same(players, World.playerLoop.all()) && stats.mismatches.length < 8) stats.mismatches.push(`players at tick ${World.currentTick}`);
    });
    BotManager.setActiveCheckForTest((bots, fresh) => {
        stats.active++;
        if (!same(bots, fresh()) && stats.mismatches.length < 8) stats.mismatches.push(`active bots at tick ${World.currentTick}`);
    });
    return stats;
}

// ---- the walking graph's A* as it was (fresh arrays per search, destructuring swaps) ----

/** port/BotWalkGraph.route before the perf work (no cache): the same nodes, or null */
export function refGraphRoute(start: number, goal: number, allowed?: (x: number, z: number) => boolean): number[] | null {
    if (start < 0 || goal < 0) return null;
    if (start === goal) return [start];
    const inWilderness = (x: number, z: number): boolean => z >= 3520 && z < 4000 && x >= 2944 && x < 3392;
    const [tx, tz] = nodePos(goal);
    const toWild = inWilderness(tx, tz);
    const n = nodeCount();
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    const heapF: number[] = [];
    const heapN: number[] = [];
    const push = (f: number, node: number): void => {
        heapF.push(f);
        heapN.push(node);
        let i = heapF.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (heapF[parent] <= heapF[i]) break;
            [heapF[parent], heapF[i]] = [heapF[i], heapF[parent]];
            [heapN[parent], heapN[i]] = [heapN[i], heapN[parent]];
            i = parent;
        }
    };
    const pop = (): number => {
        const top = heapN[0];
        const lastF = heapF.pop()!;
        const lastN = heapN.pop()!;
        if (heapF.length > 0) {
            heapF[0] = lastF;
            heapN[0] = lastN;
            let i = 0;
            for (;;) {
                const l = i * 2 + 1;
                const r = l + 1;
                let m = i;
                if (l < heapF.length && heapF[l] < heapF[m]) m = l;
                if (r < heapF.length && heapF[r] < heapF[m]) m = r;
                if (m === i) break;
                [heapF[m], heapF[i]] = [heapF[i], heapF[m]];
                [heapN[m], heapN[i]] = [heapN[i], heapN[m]];
                i = m;
            }
        }
        return top;
    };
    const h = (i: number): number => {
        const [x, z] = nodePos(i);
        return Math.max(Math.abs(x - tx), Math.abs(z - tz));
    };
    dist[start] = 0;
    push(h(start), start);
    while (heapF.length > 0) {
        const u = pop();
        if (done[u]) continue;
        done[u] = 1;
        if (u === goal) break;
        for (const [v, cost] of neighbours(u)) {
            if (done[v]) continue;
            const [vx, vz] = nodePos(v);
            if (v !== goal && allowed && !allowed(vx, vz)) continue;
            const c = cost * (!toWild && inWilderness(vx, vz) ? 4 : 1);
            const nd = dist[u] + c;
            if (nd < dist[v]) {
                dist[v] = nd;
                prev[v] = u;
                push(nd + h(v), v);
            }
        }
    }
    if (!(dist[goal] < Infinity)) return null;
    const result = [goal];
    while (result[result.length - 1] !== start) result.push(prev[result[result.length - 1]]);
    return result.reverse();
}

