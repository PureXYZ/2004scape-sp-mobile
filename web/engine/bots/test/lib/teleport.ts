// test/teleport.test.mjs's world (the realism work, phase 5a, Track M: movement and magic): test/lib/simworld.ts with the
// teleport spells (port/BotTeleport), the wrong turns (BotAction), alching and the law runs (tasks/AlchTask,
// tasks/LawTripTask, port/BotAlch) and the new bots' rune seed (port/BotAge) beside it, through one module graph.
export * from './simworld.js';
export * as Teleport from '#/engine/bot/port/BotTeleport.js';
export * as Alch from '#/engine/bot/tasks/AlchTask.js';
export * as BotAlch from '#/engine/bot/port/BotAlch.js';
export * as Law from '#/engine/bot/tasks/LawTripTask.js';
export { wrongTurnStats, setWrongTurnRateForTest, WRONG_TURN_MIN } from '#/engine/bot/BotAction.js';
export { Items, Shops, Locations } from '#/engine/bot/BotKnowledge.js';
export { default as ObjType } from '#/cache/config/ObjType.js';
export { getExpByLevel } from '#/engine/entity/Player.js';
export { personaOf } from '#/engine/bot/port/BotPersona.js';
export { magicKit } from '#/engine/bot/port/BotAge.js';
export { nearestNode, nodePos, route as graphRoute, routeCost as graphRouteCost } from '#/engine/bot/port/BotWalkGraph.js';
