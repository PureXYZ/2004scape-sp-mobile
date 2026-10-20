// test/outfits.test.mjs's world (the variety work, round 1, track W: what bots wear): test/lib/looks.ts (the sim world,
// the looks, gear and ageing) with the outfits (port/BotOutfits) and the tasks whose dressing it checks, through one module
// graph.
export * from './looks.js';
export { RangedMagicTask } from '#/engine/bot/tasks/RangedMagicTask.js';
export { FiremakingTask } from '#/engine/bot/tasks/FiremakingTask.js';
export { AgilityTask } from '#/engine/bot/tasks/AgilityTask.js';
export { MiningTask } from '#/engine/bot/tasks/MiningTask.js';
export { CraftingTask } from '#/engine/bot/tasks/CraftingTask.js';
export { pkerProfileFor, generatePkerProfiles } from '#/engine/bot/tasks/PKerTask.js';
export { edgevillePkerProfileFor } from '#/engine/bot/tasks/EdgevillePKerTask.js';
export { freeWorldPkProfiles } from '#/engine/bot/port/BotPkGear.js';
export { setDirectorForTest, resetDirectorForTest } from '#/engine/bot/port/BotDirector.js';
export { setCliqueBehaviourForTest } from '#/engine/bot/port/BotCliques.js';
export { setEventRatesForTest } from '#/engine/bot/port/BotRandomEvents.js';
export { setArenaRatesForTest } from '#/engine/bot/port/BotArena.js';
export { AxesByLevel, PickaxesByLevel, RangedBowsByLevel } from '#/engine/bot/BotKnowledge.js';
export { ShopTripTask } from '#/engine/bot/tasks/ShopTripTask.js';
