// test/minigames.test.mjs's world (the variety work, round 2, Track M: members places and minigames): test/lib/simworld.ts
// with Track M's modules beside it, through one module graph: the outings' registry and budget (port/BotOutings), the
// planner's hook and catalogue (port/BotMinigames), the tasks (OutingTask, RangingGuildTask, TrawlerTask, AgilityArenaTask,
// TreasureTrailTask), the places (BotKnowledge MembersPlaces, OUTING_STEPS) and what the staged scenes need.
export * from './simworld.js';
export * as Outings from '#/engine/bot/port/BotOutings.js';
export * as Minigames from '#/engine/bot/port/BotMinigames.js';
export * as Spots from '#/engine/bot/port/BotSpots.js';
export { OutingTask, outingTaskStats } from '#/engine/bot/tasks/OutingTask.js';
export { RangingGuildTask, rangingStats, mayCompete, wieldsBow } from '#/engine/bot/tasks/RangingGuildTask.js';
export { SkillProgression, Items, Locations, MembersPlaces, OUTING_STEPS, inShilo } from '#/engine/bot/BotKnowledge.js';
export { CombatTask } from '#/engine/bot/tasks/CombatTask.js';
export { FishingTask } from '#/engine/bot/tasks/FishingTask.js';
export { ThievingTask } from '#/engine/bot/tasks/ThievingTask.js';
export { RangedMagicTask } from '#/engine/bot/tasks/RangedMagicTask.js';
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
export { sayListeners } from '#/engine/bot/port/BotSay.js';
export { pieceLines } from '#/engine/bot/port/BotPieceLines.js';
export { default as ObjType } from '#/cache/config/ObjType.js';
export { default as VarPlayerType } from '#/cache/config/VarPlayerType.js';
export { findLocByName, interactLoc, interactNpcOp, botAnswerDialogue } from '#/engine/bot/BotAction.js';
export { TrawlerTask, trawlerStats, crewMembers, crewForming, crewExists, resetTrawlerForTest, mayTrawl, crewSize } from '#/engine/bot/tasks/TrawlerTask.js';
export { TreasureTrailTask, trailStats, holdsEasyClue } from '#/engine/bot/tasks/TreasureTrailTask.js';
export * as Clues from '#/engine/bot/port/BotClues.js';
export { AgilityArenaTask, arenaStats, arenaPillarIndex, pillarCoord, inArena, mayRunArena } from '#/engine/bot/tasks/AgilityArenaTask.js';
export * as Upstairs from '#/engine/bot/port/BotUpstairs.js';
export { themeOf } from '#/engine/bot/port/BotFavourites.js';
// (the variety work, round 2, the fixes) the ways out of Shilo and the watchtower (port/BotExits), the planner's keep step
export * as Exits from '#/engine/bot/port/BotExits.js';
export { keptHookTask } from '#/engine/bot/port/BotSetPieces.js';
