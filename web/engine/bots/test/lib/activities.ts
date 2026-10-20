// test/activities.test.mjs's world (the variety work, round 1, Track D: what bots do and where): test/lib/simworld.ts
// with Track D's modules beside it, through one module graph: the spots' capacity and occupancy (port/BotSpots), the
// names' favourites and the power-droppers (port/BotFavourites, port/BotPowerDrop), the dungeons' ways in
// (BotKnowledge.dungeonRoute, port/BotDungeons), the essence runs (tasks/EssenceTask), the talisman of the new bots
// (port/BotAge), and what the staged scenes need.
import routefinder, { CollisionType } from '#/engine/routefinder/index.js';
import World from '#/engine/World.js';
import LocType from '#/cache/config/LocType.js';

export * from './simworld.js';
export * as Spots from '#/engine/bot/port/BotSpots.js';
export * as Favourites from '#/engine/bot/port/BotFavourites.js';
export * as PowerDrop from '#/engine/bot/port/BotPowerDrop.js';
export { dungeonLeg } from '#/engine/bot/port/BotDungeons.js';
export { SkillProgression, Items, Locations, DUNGEON_ENTRIES, dungeonRoute, getProgressionStep, getProgressionStepWhere, getWoodcuttingStepForLog, stepDistance, setSpotWeight } from '#/engine/bot/BotKnowledge.js';
export { EssenceTask } from '#/engine/bot/tasks/EssenceTask.js';
export { RunecraftingTask, ESSENCE_STEP } from '#/engine/bot/tasks/RunecraftingTask.js';
export { WoodcuttingTask } from '#/engine/bot/tasks/WoodcuttingTask.js';
export { MiningTask } from '#/engine/bot/tasks/MiningTask.js';
export { FishingTask } from '#/engine/bot/tasks/FishingTask.js';
export { FletchingTask } from '#/engine/bot/tasks/FletchingTask.js';
export { CookingTask } from '#/engine/bot/tasks/CookingTask.js';
export { FiremakingTask } from '#/engine/bot/tasks/FiremakingTask.js';
export { CombatTask } from '#/engine/bot/tasks/CombatTask.js';
export { ThievingTask } from '#/engine/bot/tasks/ThievingTask.js';
export { BotGoalPlanner, Personalities, MIX_2004, FIRE_LANE_TILES, CARRY_ON_CHANCE, makeSkiller, makeBalanced, makeFighter } from '#/engine/bot/BotGoalPlanner.js';
export { talismanKit, agedKit, magicKit, TALISMAN_KEPT } from '#/engine/bot/port/BotAge.js';
export { bankInvId, nearestBankTo } from '#/engine/bot/tasks/BotTaskBase.js';
export { setHabitRatesForTest } from '#/engine/bot/port/BotHabits.js';
export { setHangoutRateForTest } from '#/engine/bot/port/BotHangout.js';
export { setArenaRatesForTest } from '#/engine/bot/port/BotArena.js';
export { personaOf } from '#/engine/bot/port/BotPersona.js';
export { setDirectorForTest } from '#/engine/bot/port/BotDirector.js';
export { setCliqueBehaviourForTest } from '#/engine/bot/port/BotCliques.js';
export { setEventRatesForTest } from '#/engine/bot/port/BotRandomEvents.js';
export { setTrainRatesForTest } from '#/engine/bot/port/BotTrains.js';
export { setAlchRateForTest } from '#/engine/bot/port/BotAlch.js';
export { crossingFare } from '#/engine/bot/BotAction.js';
export { botErrorCount } from '#/engine/bot/port/BotLog.js';
export { default as ObjType } from '#/cache/config/ObjType.js';

/** is there a loc of this debugname within `radius` of (x, z)? */
export function locNear(x: number, z: number, level: number, name: string, radius: number): boolean {
    const id = LocType.getId(name);
    if (id === -1) return false;
    for (let zx = (x - radius) & ~7; zx <= x + radius; zx += 8) {
        for (let zz = (z - radius) & ~7; zz <= z + radius; zz += 8) {
            const zone = World.gameMap.getZone(zx, zz, level);
            if (!zone) continue;
            for (const loc of zone.getAllLocsSafe()) if (loc.type === id && Math.max(Math.abs(loc.x - x), Math.abs(loc.z - z)) <= radius) return true;
        }
    }
    return false;
}

/** a door, gate or curtain on the tile (a walk opens it: BotAction's gates) */
const doorCache = new Map<number, boolean>();
function doorAt(level: number, x: number, z: number): boolean {
    const k = (level << 28) | (x << 14) | z;
    let v = doorCache.get(k);
    if (v !== undefined) return v;
    v = false;
    const zone = World.gameMap.getZone(x, z, level);
    if (zone) {
        for (const loc of zone.getAllLocsSafe()) {
            if (loc.x !== x || loc.z !== z) continue;
            const ops = (LocType.get(loc.type).op ?? []).map(o => String(o ?? '').toLowerCase());
            if (ops.some(o => o === 'open' || o.startsWith('pay') || o === 'walk-through' || o === 'pass-through' || o === 'enter')) v = true;
        }
    }
    doorCache.set(k, v);
    return v;
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
/**
 * Walk steps (a flood fill on the 274 collision map, its doors and gates opened as a walk opens them) from (x, z) to
 * within `near` of (tx, tz); -1 when there is no way within `maxTiles` tiles searched.
 */
export function walkSteps(level: number, x: number, z: number, tx: number, tz: number, near = 2, maxTiles = 200000): number {
    const seen = new Set<number>();
    const key = (a: number, b: number): number => (a << 14) | b;
    let frontier: [number, number][] = [[x, z]];
    seen.add(key(x, z));
    for (let d = 0; frontier.length && seen.size < maxTiles; d++) {
        const next: [number, number][] = [];
        for (const [a, b] of frontier) {
            if (Math.max(Math.abs(a - tx), Math.abs(b - tz)) <= near) return d;
            for (const [dx, dz] of DIRS) {
                const na = a + dx;
                const nb = b + dz;
                const k = key(na, nb);
                if (seen.has(k)) continue;
                if (!routefinder.canTravel(level, a, b, dx, dz, 1, 0, CollisionType.NORMAL) && !(dx * dz === 0 && (doorAt(level, a, b) || doorAt(level, na, nb)))) continue;
                seen.add(k);
                next.push([na, nb]);
            }
        }
        frontier = next;
    }
    return -1;
}
