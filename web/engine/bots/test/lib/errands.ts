// test/errands.test.mjs's world (the variety work, round 2, Track D2: new activities): test/lib/simworld.ts with Track
// D2's modules beside it, through one module graph: the errand engine (tasks/ErrandTask), the economy chains
// (port/BotChains), the quest look-alikes (port/BotErrands), the prayer and magic runs (port/BotMagicRuns), the
// Wilderness trips (port/BotWildTrips), the travel legs (port/BotTravel), the planner's offers (port/BotD2Picks), and
// what the staged scenes need.
import World from '#/engine/World.js';
import LocType from '#/cache/config/LocType.js';
import NpcType from '#/cache/config/NpcType.js';

export * from './simworld.js';
export * as Errand from '#/engine/bot/tasks/ErrandTask.js';
export * as Chains from '#/engine/bot/port/BotChains.js';
export * as Quests from '#/engine/bot/port/BotErrands.js';
export * as MagicRuns from '#/engine/bot/port/BotMagicRuns.js';
export * as HerbRuns from '#/engine/bot/port/BotHerbRuns.js';
export * as WildTrips from '#/engine/bot/port/BotWildTrips.js';
export * as Travel from '#/engine/bot/port/BotTravel.js';
export { AgilityTask } from '#/engine/bot/tasks/AgilityTask.js';
export { CombatTask } from '#/engine/bot/tasks/CombatTask.js';
export { SmithingTask } from '#/engine/bot/tasks/SmithingTask.js';
export * as Picks from '#/engine/bot/port/BotD2Picks.js';
export * as ErrandLines from '#/engine/bot/port/BotErrandLines.js';
export { NEW_LINES } from '#/engine/bot/port/BotLines.js';
export { getExpByLevel } from '#/engine/entity/Player.js';
export { BOT_VARPS } from '#/engine/bot/BotManager.js';
export { SkillProgression, Items, Locations } from '#/engine/bot/BotKnowledge.js';
export { bankInvId } from '#/engine/bot/tasks/BotTaskBase.js';
export { setHabitRatesForTest } from '#/engine/bot/port/BotHabits.js';
export { setHangoutRateForTest } from '#/engine/bot/port/BotHangout.js';
export { setArenaRatesForTest } from '#/engine/bot/port/BotArena.js';
export { setDirectorForTest } from '#/engine/bot/port/BotDirector.js';
export { setCliqueBehaviourForTest } from '#/engine/bot/port/BotCliques.js';
export { setEventRatesForTest } from '#/engine/bot/port/BotRandomEvents.js';
export { setTrainRatesForTest } from '#/engine/bot/port/BotTrains.js';
export { setAlchRateForTest } from '#/engine/bot/port/BotAlch.js';
export { botErrorCount } from '#/engine/bot/port/BotLog.js';
export { teleportStats } from '#/engine/bot/BotAction.js';
export { default as ObjType } from '#/cache/config/ObjType.js';

/** the locs of this debugname within `radius` of (x, z) */
export function locsNear(x: number, z: number, level: number, name: string, radius: number): { x: number; z: number }[] {
    const id = LocType.getId(name);
    const out: { x: number; z: number }[] = [];
    if (id === -1) return out;
    for (let zx = (x - radius) & ~7; zx <= x + radius; zx += 8) {
        for (let zz = (z - radius) & ~7; zz <= z + radius; zz += 8) {
            const zone = World.gameMap.getZone(zx, zz, level);
            if (!zone) continue;
            for (const loc of zone.getAllLocsSafe()) if (loc.type === id && Math.max(Math.abs(loc.x - x), Math.abs(loc.z - z)) <= radius) out.push({ x: loc.x, z: loc.z });
        }
    }
    return out;
}

/** is an NPC of this debugname within `radius`? */
export function npcNear(x: number, z: number, level: number, name: string, radius: number): boolean {
    const id = NpcType.getId(name);
    for (const npc of World.npcs) if (npc && npc.type === id && npc.level === level && Math.max(Math.abs(npc.x - x), Math.abs(npc.z - z)) <= radius) return true;
    return false;
}
// (the variety work, round 2, the fixes) the bank stop's hang-out under a hosted errand, the bank's room for a deposit
export { bankStop } from '#/engine/bot/port/BotHabits.js';
export { hangoutsOf } from '#/engine/bot/port/BotHangout.js';
export { depositItems } from '#/engine/bot/port/BotInventoryCompat.js';
