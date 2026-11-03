// test/endgame.test.mjs's world (bots ideas round 1, Track A: the period endgame): test/lib/simworld.ts with the endgame's
// modules beside it, through one module graph: the trips and the offer (port/BotEndgame), the core (registry, role,
// events), the fights' shared parts (port/BotEndgameFight), the dusty key (port/BotVelrak), the sales (port/BotDropSale),
// the KBD and KQ teams (port/BotEndgameTeams), the Mage Arena (port/BotMageArena), the Wilderness's endgame spots
// (port/BotWildTrips), the places and the staged scenes' switches.
export * from './simworld.js';
export * as Endgame from '#/engine/bot/port/BotEndgame.js';
export * as Core from '#/engine/bot/port/BotEndgameCore.js';
export * as Fight from '#/engine/bot/port/BotEndgameFight.js';
export * as Velrak from '#/engine/bot/port/BotVelrak.js';
export * as DropSale from '#/engine/bot/port/BotDropSale.js';
export * as WildTrips from '#/engine/bot/port/BotWildTrips.js';
export * as Teams from '#/engine/bot/port/BotEndgameTeams.js';
// (bots ideas, the KQ track: the Kalphite Queen's attempts; the queen found by her NPC types)
export * as Kq from '#/engine/bot/port/BotKqTeams.js';
// (the KQ fixes, KQ-1: a member's own teleport spell on its way, staged: port/BotTeleport's rates and counters)
export * as Teleport from '#/engine/bot/port/BotTeleport.js';
export { findNpcFiltered } from '#/engine/bot/BotAction.js';
export { installBotsContent } from './botscontent.js';
export { SkillProgression, Items, Locations, DUNGEON_ENTRIES, KEY_DOORS, dungeonRoute } from '#/engine/bot/BotKnowledge.js';
export { CombatTask } from '#/engine/bot/tasks/CombatTask.js';
export { ErrandTask, errandStats, resetErrandStatsForTest } from '#/engine/bot/tasks/ErrandTask.js';
export { bankInvId } from '#/engine/bot/tasks/BotTaskBase.js';
export { setHabitRatesForTest } from '#/engine/bot/port/BotHabits.js';
export { setHangoutRateForTest } from '#/engine/bot/port/BotHangout.js';
export { setArenaRatesForTest } from '#/engine/bot/port/BotArena.js';
export { setDirectorForTest, resetDirectorForTest, isFreeForEvent, recruitedLately } from '#/engine/bot/port/BotDirector.js';
export { habitOf } from '#/engine/bot/port/BotHabits.js';
export { holdsLogout } from '#/engine/bot/port/BotRandomEvents.js';
export { setCliqueBehaviourForTest } from '#/engine/bot/port/BotCliques.js';
export { setEventRatesForTest } from '#/engine/bot/port/BotRandomEvents.js';
export { setTrainRatesForTest } from '#/engine/bot/port/BotTrains.js';
export { setAlchRateForTest } from '#/engine/bot/port/BotAlch.js';
export { setD2OffersForTest } from '#/engine/bot/port/BotD2Picks.js';
export { setOutingRatesForTest } from '#/engine/bot/port/BotOutings.js';
export { botErrorCount } from '#/engine/bot/port/BotLog.js';
export { pieceLines } from '#/engine/bot/port/BotPieceLines.js';
export { eventRoleOf, clearRole } from '#/engine/bot/port/BotSetPieces.js';
export { default as ObjType } from '#/cache/config/ObjType.js';
export { default as VarPlayerType } from '#/cache/config/VarPlayerType.js';
export { findLocByName, findObjNear, botScript } from '#/engine/bot/BotAction.js';
export { BankstandTask } from '#/engine/bot/tasks/BankstandTask.js';
// (round 1 fixes: a staged death, as 274's own: its death queued, the respawn at Lumbridge)
export { default as ScriptProvider } from '#/engine/script/ScriptProvider.js';
export { PlayerQueueType } from '#/engine/entity/PlayerQueueRequest.js';
