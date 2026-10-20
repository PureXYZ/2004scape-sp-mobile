// What test/pk.test.mjs needs on top of the headless world (simworld.ts): the PK tasks, the free world's PK gear, the
// gate predicate and the combat task's NPC claims, with the 274 configs they are checked against.
export * from './simworld.js';
export { PKerTask, pkerProfileFor, generatePkerProfiles } from '#/engine/bot/tasks/PKerTask.js';
export { EdgevillePKerTask, edgevillePkerProfileFor, generateEdgevillePkerProfiles } from '#/engine/bot/tasks/EdgevillePKerTask.js';
export { CombatTask } from '#/engine/bot/tasks/CombatTask.js';
export { F2P_PK_ITEMS, freeWorldPkProfiles, pkDropStaleSpecial, pkEquipItem, pkTryEquipFromInventory, stripMembersItems, usableOnThisWorld, wieldsSpecialWeapon } from '#/engine/bot/port/BotPkGear.js';
export { _isClosedGate } from '#/engine/bot/BotAction.js';
export { SkillProgression } from '#/engine/bot/BotKnowledge.js';
export { default as ObjType } from '#/cache/config/ObjType.js';
export { default as LocType } from '#/cache/config/LocType.js';
export { default as CategoryType } from '#/cache/config/CategoryType.js';
export { default as Loc } from '#/engine/entity/Loc.js';
export { EntityLifeCycle } from '#/engine/entity/EntityLifeCycle.js';
export { LocShape } from '#/engine/routefinder/index.js';
import World from '#/engine/World.js';
import { CoordGrid } from '#/engine/CoordGrid.js';

/** Is (x, z, level) in a multi-combat zone? */
export function isMulti(x: number, z: number, level: number): boolean {
    return World.gameMap.isMulti(CoordGrid.packCoord(level, x, z));
}

/** Every loc in the zones the world has loaded. */
export function* allLocs(): Generator<import('#/engine/entity/Loc.js').default> {
    const zones = (World.gameMap as unknown as { zonemap: { zones: Map<number, { getAllLocsSafe(): Iterable<import('#/engine/entity/Loc.js').default> }> } }).zonemap.zones;
    for (const zone of zones.values()) yield* zone.getAllLocsSafe();
}
export { pkStyleOf, pkPrayers, pkPrayersOff, pkEngageTactics, newPkTactics, KILL_LINES, ESCAPE_LINES } from '#/engine/bot/port/BotPkTactics.js';
export { PK_LINES } from '#/engine/bot/port/BotLines.js';
export { default as VarPlayerType } from '#/cache/config/VarPlayerType.js';
