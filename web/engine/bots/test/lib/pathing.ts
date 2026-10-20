// The 274 map and route finder with the bots' path helpers on top, for test/pathing.test.mjs (loaded in a scratch
// engine clone, test/lib/clone.mjs). Players here are plain bot-style players (PlayerLoading without a client) that
// are never added to the world: the path code only needs their position and their waypoint queue.
import World from '#/engine/World.js';
import type Player from '#/engine/entity/Player.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import Packet from '#/io/Packet.js';
import routefinder, { CollisionType } from '#/engine/routefinder/index.js';
import { walkTo } from '#/engine/bot/BotAction.js';
import { BotCollisionMap } from '#/engine/bot/BotCollisionMap.js';
import { setWorld } from '#/engine/bot/BotWorld.js';
import { BOT_MAX_WAYPOINTS, PATH_SEARCHES_PER_TICK, beginPathTick, botFindPath, botWalkPath, pathBudgetLeft, pathSearchBudget, pathSearchBudgetFor, pathSearchesThisTick, setPathSearchBudget } from '#/engine/bot/port/BotPathing.js';

export { walkTo, BotCollisionMap, BOT_MAX_WAYPOINTS, PATH_SEARCHES_PER_TICK, beginPathTick, botFindPath, botWalkPath, pathBudgetLeft, pathSearchBudget, pathSearchBudgetFor, pathSearchesThisTick, setPathSearchBudget };
// (the variety work, round 1, track F: a walk's waits for the budget; the castle stairs' climb)
export { waitedForBudgetSince } from '#/engine/bot/BotAction.js';
export { botPathToLoc, botReachedLoc } from '#/engine/bot/port/BotPathing.js';
import LocType from '#/cache/config/LocType.js';

/** (variety round 1, F) the loc with this op (lower case) nearest (x, z) within `radius` on `level`, as walkTo's climb finds it */
export function nearestLocWithOp(level: number, x: number, z: number, radius: number, op: string): { x: number; z: number; name: string; width: number; length: number; angle: number; shape: number; forceapproach: number } | null {
    let best: { x: number; z: number; name: string; width: number; length: number; angle: number; shape: number; forceapproach: number } | null = null;
    let bestD = Infinity;
    for (let zx = (x - radius) >> 3; zx <= (x + radius) >> 3; zx++) {
        for (let zz = (z - radius) >> 3; zz <= (z + radius) >> 3; zz++) {
            for (const loc of World.gameMap.getZone(zx << 3, zz << 3, level).getAllLocsSafe()) {
                const t = LocType.get(loc.type);
                if (!(t.op ?? []).some(o => typeof o === 'string' && o.toLowerCase() === op)) continue;
                const d = Math.max(Math.abs(loc.x - x), Math.abs(loc.z - z));
                if (d > radius || d >= bestD) continue;
                bestD = d;
                best = { x: loc.x, z: loc.z, name: t.debugname ?? '', width: loc.width, length: loc.length, angle: loc.angle, shape: loc.shape, forceapproach: t.forceapproach };
            }
        }
    }
    return best;
}

export interface Search {
    srcX: number;
    srcZ: number;
    destX: number;
    destZ: number;
    maxWaypoints: number;
}

/** Every route search since the last call (the bots' and any other). */
const searches: Search[] = [];
export function takeSearches(): Search[] {
    return searches.splice(0);
}

/** Searches from this tile find nothing (to walk a bot through its whole list of attempts); null to stop. */
let failFrom: string | null = null;
export function failSearchesFrom(x: number | null, z = 0): void {
    failFrom = x === null ? null : `${x},${z}`;
}

export async function start(): Promise<void> {
    await World.start(false, false);
    (World as unknown as { cycle: () => void }).cycle = () => {}; // nothing runs on its own
    setWorld(World); // what BotManager.start does first
    const findPath = routefinder.findPath.bind(routefinder);
    (routefinder as unknown as { findPath: typeof findPath }).findPath = (...args: Parameters<typeof findPath>) => {
        const [, srcX, srcZ, destX, destZ, , , , , , , , maxWaypoints] = args;
        searches.push({ srcX, srcZ, destX, destZ, maxWaypoints });
        if (failFrom === `${srcX},${srcZ}`) return new Uint32Array(0);
        return findPath(...args);
    };
}

/** 274's route finder as upstream called it: one search, `maxWaypoints` as given (upstream passed -1). */
export function rawPath(level: number, srcX: number, srcZ: number, destX: number, destZ: number, maxWaypoints: number, moveNear = true): number[] {
    return [...routefinder.findPath(level, srcX, srcZ, destX, destZ, 1, 1, 1, 0, -1, moveNear, 0, maxWaypoints, CollisionType.NORMAL)];
}

export function unpack(packed: number): [number, number, number] {
    return [(packed >> 14) & 0x3fff, packed & 0x3fff, (packed >> 28) & 0x3];
}

export function botAt(name: string, x: number, z: number, level = 0): Player {
    const player = PlayerLoading.load(name, new Packet(new Uint8Array(0)), null);
    player.x = x;
    player.z = z;
    player.level = level;
    return player;
}

/** The waypoints a player has queued, as [x, z]. */
export function waypoints(player: Player): [number, number][] {
    const out: [number, number][] = [];
    for (let i = player.waypointIndex; i >= 0; i--) {
        const [x, z] = unpack(player.waypoints[i]);
        out.push([x, z]);
    }
    return out;
}
