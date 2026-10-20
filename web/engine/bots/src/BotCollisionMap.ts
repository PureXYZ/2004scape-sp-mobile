/**
 * BotCollisionMap.ts
 *
 * Loads data/bot/unwalkable_tiles.csv once at startup and exposes an O(1)
 * lookup so bot pathfinding can reject known-bad tile destinations.
 *
 * The CSV is NOT a complete collision map — it is supplementary safety data.
 * The engine's rsmod collision (via canTravel / botWalkPath) remains the
 * primary authority.  The CSV rejects tiles that may appear walkable to rsmod
 * but are known problematic for bots (deep water, special terrain, etc.).
 *
 * port: no CSV. Upstream's unwalkable_tiles.csv (8.85 MB, 736,479 tiles) is exactly rev 254's WALK_BLOCKED set
 * (0 mismatches in the 265 map squares 254 and 274 share), is stale for 218 of 274's map squares and costs ~20 MB of
 * heap as a Set. The same question is asked of the 274 engine's own collision instead: a tile is blocked when the
 * map blocks walking there or its zone has no collision data at all (isFlagged answers false for an unallocated zone,
 * which would make water outside the map look walkable). The names stay upstream's, so call sites do not change.
 */

import { isMapBlocked, isZoneAllocated } from '#/engine/GameMap.js';

class BotCollisionMapClass {
    /** Kept for upstream's call site; there is nothing to load. */
    init(_csvPath?: string): void {}

    /** O(1): is this tile blocked for walking (engine collision), or outside the loaded map? */
    isCsvBlocked(level: number, x: number, z: number): boolean {
        return isMapBlocked(x, z, level) || !isZoneAllocated(level, x, z);
    }

    /** Upstream's trimPathAtCsvBlock tested this; the engine's collision is always there. */
    get isLoaded(): boolean {
        return true;
    }
}

export const BotCollisionMap = new BotCollisionMapClass();
