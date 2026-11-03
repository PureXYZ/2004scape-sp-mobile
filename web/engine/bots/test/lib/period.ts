// The bots ideas work, round 3 (theme G: period content): the period foundation for the tests:
// test/lib/simworld.ts with theme G's switch, the buzz's budget and registry (port/BotPeriod), the planner's hook
// (port/BotPeriodPlan), the places (BotKnowledge PeriodPlaces), the arcs' play clock held for a test, and what a staged
// scene turns off, through one module graph. test/period-budget.test.mjs uses it; the G builder's test/period.test.mjs
// and the H builder's test/buzz.test.mjs may import it and add their own modules in their blocks below.
export * from './simworld.js';
export * as Period from '#/engine/bot/port/BotPeriod.js';
export * as PeriodPlan from '#/engine/bot/port/BotPeriodPlan.js';
export { PeriodPlaces, MembersPlaces, OUTING_STEPS, Items, Locations } from '#/engine/bot/BotKnowledge.js';
export { teleportListeners, botTeleport, isCrossing as isCrossingNow } from '#/engine/bot/BotAction.js';
export { arcsPlay, setArcsPlayForTest as setPlayForTest } from '#/engine/bot/port/BotArcsEvents.js';
export { pieceLines } from '#/engine/bot/port/BotPieceLines.js';
export { NEW_LINES, resetLineRegistry } from '#/engine/bot/port/BotLines.js';
export { personaOf } from '#/engine/bot/port/BotPersona.js';
export { setRole, clearRole } from '#/engine/bot/port/BotSetPieces.js';
export { botErrorCount } from '#/engine/bot/port/BotLog.js';
export { setOutingRatesForTest, outingLog, pickStats } from '#/engine/bot/port/BotOutings.js';
export * as Minimap from '#/engine/bot/port/BotMinimap.js';
// (what a staged scene turns off)
export { setHabitRatesForTest } from '#/engine/bot/port/BotHabits.js';
export { setHangoutRateForTest } from '#/engine/bot/port/BotHangout.js';
export { setArenaRatesForTest } from '#/engine/bot/port/BotArena.js';
export { setDirectorForTest, resetDirectorForTest } from '#/engine/bot/port/BotDirector.js';
export { setCliqueBehaviourForTest } from '#/engine/bot/port/BotCliques.js';
export { setEventRatesForTest } from '#/engine/bot/port/BotRandomEvents.js';
export { setTrainRatesForTest } from '#/engine/bot/port/BotTrains.js';
export { setAlchRateForTest } from '#/engine/bot/port/BotAlch.js';
export { setScamRatesForTest } from '#/engine/bot/port/BotScams.js';
export { setWitnessRatesForTest } from '#/engine/bot/port/BotWitness.js';
export { setD2OffersForTest } from '#/engine/bot/port/BotD2Picks.js';
export { setLingerForTest } from '#/engine/bot/port/BotLinger.js';
// ---- G period: the G builder's modules for its tests (kittens, Runelink, Gnomeball, their talk) ----
export * as Pets from '#/engine/bot/port/BotPets.js';
export { PetTripTask, petTripStats, bankedPetFood } from '#/engine/bot/tasks/PetTripTask.js';
export { periodHabits } from '#/engine/bot/port/BotPeriod.js';
export { default as ObjType } from '#/cache/config/ObjType.js';
export { default as VarPlayerType } from '#/cache/config/VarPlayerType.js';
export { default as VarBitType } from '#/cache/config/VarBitType.js';
export { default as VarNpcType } from '#/cache/config/VarNpcType.js';
export { default as Component } from '#/cache/config/Component.js';
export { default as ScriptProvider } from '#/engine/script/ScriptProvider.js';
export { PlayerQueueType } from '#/engine/entity/PlayerQueueRequest.js';
export { interactLoc, interactLocOp, interactPlayerOp, interactIfButtonByName, findLocByName, botAnswerDialogue, botScript, noteMove } from '#/engine/bot/BotAction.js';
export { setOutingRatesForTest as setMembersOutingsForTest, outingOf, minigameStats } from '#/engine/bot/port/BotOutings.js';
export { forceOutingForTest, membersTaskFor } from '#/engine/bot/port/BotMinigames.js';
export { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';
export * as Runelink from '#/engine/bot/port/BotRunelink.js';
export * as GamesRoom from '#/engine/bot/tasks/GamesRoomTask.js';
export { gamesRoomOut, inGamesRoomBox, exitStats } from '#/engine/bot/port/BotExits.js';
export { MINIGAME_KINDS } from '#/engine/bot/port/BotOutings.js';
export * as Gnomeball from '#/engine/bot/tasks/GnomeballTask.js';
export * as PeriodTalk from '#/engine/bot/port/BotPeriodTalk.js';
export { drawThread, THREAD_TOPICS, THREAD_LINES, lastThreadTopicsForTest } from '#/engine/bot/port/BotThreads.js';
export { placePhrase } from '#/engine/bot/port/BotPlaces.js';
export { activityFor } from '#/engine/bot/port/BotActivity.js';
export { SkillProgression } from '#/engine/bot/BotKnowledge.js';
// ---- end of G period's exports ----
// ---- G buzz: the H builder's theme G modules for its tests (the Rellekka buzz, the crabs, the lighthouse, chompies) ----
export * as Buzz from '#/engine/bot/tasks/BuzzTask.js';
export * as Crab from '#/engine/bot/tasks/CrabTask.js';
export * as Lighthouse from '#/engine/bot/tasks/LighthouseTask.js';
export { BuzzPlaces } from '#/engine/bot/BotKnowledge.js';
export { getExpByLevel } from '#/engine/entity/Player.js';
export { findNpcFiltered } from '#/engine/bot/BotAction.js'; // (findLocByName and eventRoleOf: G period's exports above)
export { default as NpcTypeConfig } from '#/cache/config/NpcType.js';
export { catalogueWeightForTest } from '#/engine/bot/port/BotMinigames.js'; // (the fixes: theme G off, as before it)
export { townIn } from '#/engine/bot/port/BotAnswers.js';
// ---- end of G buzz's exports ----
// ---- (the KQ fixes, T-3) the quests' talk against the bot's own answer to "did you do X" ----
export { stateAnswer, saysQuestDone, ANSWER_LINES } from '#/engine/bot/port/BotAnswers.js';
export { drawTopicForTest } from '#/engine/bot/port/BotThreads.js';
// ---- end of T-3's exports ----
