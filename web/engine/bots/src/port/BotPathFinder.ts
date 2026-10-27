// port (perf, 2026-10-23): the bots' own route search, an exact copy of 274's PathFinder.findPath for what the bots ask
// (a 1-tile player, CollisionType.NORMAL): the same breadth-first search over the same 128×128 window, the same
// 4096-entry ring buffer, the same neighbour order and tests, the same ReachStrategy.reached calls, the same closest
// approach and the same waypoint list, so every route is the one the engine's search returns. Only the bookkeeping is
// cheaper; bot searches were 97 % of all route-search time, 13.6 % of the world tick at 1000 bots in JavaScriptCore and
// 19-21 % in V8:
//  - a collision flag is read through a per-search table of the window's zone arrays (at most 17×17, one Map lookup
//    per zone), not one CollisionEngine.get (a Map lookup) per neighbour test;
//  - canMove(NORMAL) is inlined: (flag & mask) === 0;
//  - a tile destination (shape -1, ReachStrategy's NO_STRATEGY) is reached only on the tile itself, tested inline;
//  - the arrays are cleared where the last search wrote, not all 16,384 + 16,384 cells.
// The engine's PathFinder (the human's and the NPCs' searches) is untouched. It reads CollisionEngine's private zones
// Map (zone index -> 64 flags; an absent zone reads CollisionFlag.NULL, as CollisionEngine.get answers); an engine
// without it gets the engine's own search. test/exact.test.mjs compares every bot search of a seeded world, and a
// sweep of sources and destination kinds on the map, with the engine's search.
import rsmod, { CollisionType } from '#/engine/routefinder/index.js';
import ReachStrategy from '#/engine/routefinder/ReachStrategy.js';

const SIZE = 128; // PathFinder.DEFAULT_SEARCH_MAP_SIZE
const HALF = SIZE / 2;
const RING_MASK = 4096 - 1; // DEFAULT_RING_BUFFER_SIZE
const LAST = SIZE - 1;
const DEFAULT_DISTANCE = 99_999_999;
const SRC_DIRECTION = 99;
const ALT_LOWEST_COST = 1000; // MAX_ALTERNATIVE_ROUTE_LOWEST_COST
const ALT_SEEK_RANGE = 100; // MAX_ALTERNATIVE_ROUTE_SEEK_RANGE
const ALT_RANGE = 10; // MAX_ALTERNATIVE_ROUTE_DISTANCE_FROM_DESTINATION

// CollisionFlag (routefinder/flags.ts)
const NULL_FLAG = 0x7fffffff;
const BLOCK_WEST = 0x240108;
const BLOCK_EAST = 0x240180;
const BLOCK_SOUTH = 0x240102;
const BLOCK_NORTH = 0x240120;
const BLOCK_SOUTH_WEST = 0x24010e;
const BLOCK_SOUTH_EAST = 0x240183;
const BLOCK_NORTH_WEST = 0x240138;
const BLOCK_NORTH_EAST = 0x2401e0;
// DirectionFlag
const D_NORTH = 0x1;
const D_EAST = 0x2;
const D_SOUTH = 0x4;
const D_WEST = 0x8;
const D_SOUTH_WEST = 0xc;
const D_NORTH_WEST = 0x9;
const D_SOUTH_EAST = 0x6;
const D_NORTH_EAST = 0x3;

const directions = new Int8Array(SIZE * SIZE);
const distances = new Int32Array(SIZE * SIZE).fill(DEFAULT_DISTANCE);
const ringX = new Int32Array(RING_MASK + 1);
const ringZ = new Int32Array(RING_MASK + 1);
/** the cells the last search wrote (each at most once: a written cell has a direction) */
const touched = new Int32Array(SIZE * SIZE);
let touchedCount = 0;

/** a 128-tile window spans at most 17 zones a side */
const TABLE = 17;
const NULL_ZONE = new Uint32Array(64).fill(NULL_FLAG);
const zoneTable: (Uint32Array | null)[] = new Array(TABLE * TABLE).fill(null);

/**
 * rsmod.findPath(level, srcX, srcZ, destX, destZ, 1, destWidth, destHeight, angle, shape, moveNear, blockAccessFlags,
 * maxWaypoints, CollisionType.NORMAL): the same waypoints.
 */
export function botRoute(level: number, srcX: number, srcZ: number, destX: number, destZ: number, destWidth: number, destHeight: number, angle: number, shape: number, moveNear: boolean, blockAccessFlags: number, maxWaypoints: number): Uint32Array {
    const flags = rsmod.collisionFlags;
    const zones = (flags as unknown as { zones?: unknown }).zones;
    if (!(zones instanceof Map)) return rsmod.findPath(level, srcX, srcZ, destX, destZ, 1, destWidth, destHeight, angle, shape, moveNear, blockAccessFlags, maxWaypoints, CollisionType.NORMAL);
    const dirs = directions;
    const dist = distances;
    const rx = ringX;
    const rz = ringZ;
    const tch = touched;
    const table = zoneTable;

    // reset: only what the last search wrote
    let tn = touchedCount;
    for (let i = 0; i < tn; i++) {
        const k = tch[i];
        dirs[k] = 0;
        dist[k] = DEFAULT_DISTANCE;
    }
    tn = 0;
    table.fill(null);

    const baseX = srcX - HALF;
    const baseZ = srcZ - HALF;
    const localSrcX = srcX - baseX;
    const localSrcZ = srcZ - baseZ;
    const localDestX = destX - baseX;
    const localDestZ = destZ - baseZ;
    const tileDest = shape === -1;
    // the zone table's slot of window-local (lx, lz) is ((lx + ox) >> 3, (lz + oz) >> 3)
    const ox = baseX & 7;
    const oz = baseZ & 7;

    let reader = 0;
    let writer = 0;
    {
        const index = localSrcX * SIZE + localSrcZ;
        dirs[index] = SRC_DIRECTION;
        dist[index] = 0;
        tch[tn++] = index;
        rx[writer] = localSrcX;
        rz[writer] = localSrcZ;
        writer = (writer + 1) & RING_MASK;
    }

    let cx = 0;
    let cz = 0;
    let found = false;
    while (writer !== reader) {
        cx = rx[reader];
        cz = rz[reader];
        reader = (reader + 1) & RING_MASK;

        if (tileDest ? cx === localDestX && cz === localDestZ : ReachStrategy.reached(flags, level, cx + baseX, cz + baseZ, destX, destZ, destWidth, destHeight, 1, angle, shape, blockAccessFlags)) {
            found = true;
            break;
        }

        const nd = dist[cx * SIZE + cz] + 1;
        let x: number;
        let z: number;
        let i: number;

        x = cx - 1;
        z = cz;
        if (cx > 0 && dirs[(i = x * SIZE + z)] === 0 && (flag(table, zones, level, baseX, baseZ, ox, oz, x, z) & BLOCK_WEST) === 0) {
            dirs[i] = D_EAST;
            dist[i] = nd;
            tch[tn++] = i;
            rx[writer] = x;
            rz[writer] = z;
            writer = (writer + 1) & RING_MASK;
        }

        x = cx + 1;
        z = cz;
        if (cx < LAST && dirs[(i = x * SIZE + z)] === 0 && (flag(table, zones, level, baseX, baseZ, ox, oz, x, z) & BLOCK_EAST) === 0) {
            dirs[i] = D_WEST;
            dist[i] = nd;
            tch[tn++] = i;
            rx[writer] = x;
            rz[writer] = z;
            writer = (writer + 1) & RING_MASK;
        }

        x = cx;
        z = cz - 1;
        if (cz > 0 && dirs[(i = x * SIZE + z)] === 0 && (flag(table, zones, level, baseX, baseZ, ox, oz, x, z) & BLOCK_SOUTH) === 0) {
            dirs[i] = D_NORTH;
            dist[i] = nd;
            tch[tn++] = i;
            rx[writer] = x;
            rz[writer] = z;
            writer = (writer + 1) & RING_MASK;
        }

        x = cx;
        z = cz + 1;
        if (cz < LAST && dirs[(i = x * SIZE + z)] === 0 && (flag(table, zones, level, baseX, baseZ, ox, oz, x, z) & BLOCK_NORTH) === 0) {
            dirs[i] = D_SOUTH;
            dist[i] = nd;
            tch[tn++] = i;
            rx[writer] = x;
            rz[writer] = z;
            writer = (writer + 1) & RING_MASK;
        }

        x = cx - 1;
        z = cz - 1;
        if (
            cx > 0 &&
            cz > 0 &&
            dirs[(i = x * SIZE + z)] === 0 &&
            (flag(table, zones, level, baseX, baseZ, ox, oz, x, z) & BLOCK_SOUTH_WEST) === 0 &&
            (flag(table, zones, level, baseX, baseZ, ox, oz, x, cz) & BLOCK_WEST) === 0 &&
            (flag(table, zones, level, baseX, baseZ, ox, oz, cx, z) & BLOCK_SOUTH) === 0
        ) {
            dirs[i] = D_NORTH_EAST;
            dist[i] = nd;
            tch[tn++] = i;
            rx[writer] = x;
            rz[writer] = z;
            writer = (writer + 1) & RING_MASK;
        }

        x = cx + 1;
        z = cz - 1;
        if (
            cx < LAST &&
            cz > 0 &&
            dirs[(i = x * SIZE + z)] === 0 &&
            (flag(table, zones, level, baseX, baseZ, ox, oz, x, z) & BLOCK_SOUTH_EAST) === 0 &&
            (flag(table, zones, level, baseX, baseZ, ox, oz, x, cz) & BLOCK_EAST) === 0 &&
            (flag(table, zones, level, baseX, baseZ, ox, oz, cx, z) & BLOCK_SOUTH) === 0
        ) {
            dirs[i] = D_NORTH_WEST;
            dist[i] = nd;
            tch[tn++] = i;
            rx[writer] = x;
            rz[writer] = z;
            writer = (writer + 1) & RING_MASK;
        }

        x = cx - 1;
        z = cz + 1;
        if (
            cx > 0 &&
            cz < LAST &&
            dirs[(i = x * SIZE + z)] === 0 &&
            (flag(table, zones, level, baseX, baseZ, ox, oz, x, z) & BLOCK_NORTH_WEST) === 0 &&
            (flag(table, zones, level, baseX, baseZ, ox, oz, x, cz) & BLOCK_WEST) === 0 &&
            (flag(table, zones, level, baseX, baseZ, ox, oz, cx, z) & BLOCK_NORTH) === 0
        ) {
            dirs[i] = D_SOUTH_EAST;
            dist[i] = nd;
            tch[tn++] = i;
            rx[writer] = x;
            rz[writer] = z;
            writer = (writer + 1) & RING_MASK;
        }

        x = cx + 1;
        z = cz + 1;
        if (
            cx < LAST &&
            cz < LAST &&
            dirs[(i = x * SIZE + z)] === 0 &&
            (flag(table, zones, level, baseX, baseZ, ox, oz, x, z) & BLOCK_NORTH_EAST) === 0 &&
            (flag(table, zones, level, baseX, baseZ, ox, oz, x, cz) & BLOCK_EAST) === 0 &&
            (flag(table, zones, level, baseX, baseZ, ox, oz, cx, z) & BLOCK_NORTH) === 0
        ) {
            dirs[i] = D_SOUTH_WEST;
            dist[i] = nd;
            tch[tn++] = i;
            rx[writer] = x;
            rz[writer] = z;
            writer = (writer + 1) & RING_MASK;
        }
    }
    touchedCount = tn;

    if (!found) {
        if (!moveNear) return new Uint32Array();
        // PathFinder.findClosestApproachPoint, with the destination's size rotated by its angle
        const width = (angle & 0x1) !== 0 ? destHeight : destWidth;
        const height = (angle & 0x1) !== 0 ? destWidth : destHeight;
        let lowestCost = ALT_LOWEST_COST;
        let maxAlternativePath = ALT_SEEK_RANGE;
        for (let x = localDestX - ALT_RANGE; x <= localDestX + ALT_RANGE; x++) {
            for (let z = localDestZ - ALT_RANGE; z <= localDestZ + ALT_RANGE; z++) {
                if (!(x >= 0 && x < SIZE) || !(z >= 0 && z < SIZE) || dist[x * SIZE + z] >= ALT_SEEK_RANGE) continue;
                let dx = 0;
                if (x < localDestX) dx = localDestX - x;
                else if (x > localDestX + width - 1) dx = x - (width + localDestX - 1);
                let dz = 0;
                if (z < localDestZ) dz = localDestZ - z;
                else if (z > localDestZ + height - 1) dz = z - (height + localDestZ - 1);
                const cost = dx * dx + dz * dz;
                if (cost < lowestCost || (cost === lowestCost && maxAlternativePath > dist[x * SIZE + z])) {
                    cx = x;
                    cz = z;
                    lowestCost = cost;
                    maxAlternativePath = dist[x * SIZE + z];
                }
            }
        }
        if (lowestCost === ALT_LOWEST_COST) return new Uint32Array();
    }

    // the waypoints, from the end back to the source: one at every change of direction (PackedCoord's packing)
    const waypoints: number[] = [];
    const levelBits = (level & 0x3) << 28;
    let next = dirs[cx * SIZE + cz];
    let curr = -1;
    for (let index = 0; index < SIZE * SIZE; index++) {
        if (cx === localSrcX && cz === localSrcZ) break;
        if (curr !== next) {
            curr = next;
            if (waypoints.length >= maxWaypoints) waypoints.pop();
            waypoints.unshift((((baseZ + cz) & 0x3fff) | (((baseX + cx) & 0x3fff) << 14) | levelBits) >>> 0);
        }
        if ((curr & D_EAST) !== 0) cx += 1;
        else if ((curr & D_WEST) !== 0) cx -= 1;
        if ((curr & D_NORTH) !== 0) cz += 1;
        else if ((curr & D_SOUTH) !== 0) cz -= 1;
        next = dirs[cx * SIZE + cz];
    }
    return Uint32Array.from(waypoints);
}

/** CollisionEngine.get(baseX + lx, baseZ + lz, level), through the search's zone table (each zone looked up once) */
function flag(table: (Uint32Array | null)[], zones: Map<number, Uint32Array>, level: number, baseX: number, baseZ: number, ox: number, oz: number, lx: number, lz: number): number {
    const slot = ((lx + ox) >> 3) + ((lz + oz) >> 3) * TABLE;
    let zone = table[slot];
    if (zone === null) {
        const x = baseX + lx;
        const z = baseZ + lz;
        // CollisionEngine.zoneIndex
        zone = zones.get(((x >> 3) & 0x7ff) | (((z >> 3) & 0x7ff) << 11) | ((level & 0x3) << 22)) ?? NULL_ZONE;
        table[slot] = zone;
    }
    // CollisionEngine.tileIndex: (x & 7) | ((z & 7) << 3), and (lx + ox) & 7 === (baseX + lx) & 7
    return zone[((lx + ox) & 0x7) | (((lz + oz) & 0x7) << 3)];
}
