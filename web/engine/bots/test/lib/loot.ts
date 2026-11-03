// What test/loot.test.mjs needs on top of the headless world (simworld.ts) and the PK fight's (pkfight.ts): the content
// overlay as the runtime installs it (a bot keeps its items when it dies), the human's death pile and its takers
// (port/BotLoot, tasks/LootPileTask), the witnesses (port/BotWitness), the switches a staged scene turns off, the
// wine crowd, the safespots and the lever camps (bots ideas round 1, track B).
export * from './pkfight.js';
export { installBotsContent } from './botscontent.js';
export { refreshWorn, interactObjOp } from '#/engine/bot/BotAction.js';
export * as Loot from '#/engine/bot/port/BotLoot.js';
export { LootPileTask, LootBooth } from '#/engine/bot/tasks/LootPileTask.js';
export * as Witness from '#/engine/bot/port/BotWitness.js';
export { default as Obj } from '#/engine/entity/Obj.js';
export { default as ScriptProvider } from '#/engine/script/ScriptProvider.js';
export { PlayerQueueType } from '#/engine/entity/PlayerQueueRequest.js';
export { bankInvId } from '#/engine/bot/tasks/BotTaskBase.js';
export { setHabitRatesForTest } from '#/engine/bot/port/BotHabits.js';
export { setHangoutRateForTest } from '#/engine/bot/port/BotHangout.js';
export { setArenaRatesForTest } from '#/engine/bot/port/BotArena.js';
export { setDirectorForTest, resetDirectorForTest } from '#/engine/bot/port/BotDirector.js';
export { setCliqueBehaviourForTest, setCliquesForTest } from '#/engine/bot/port/BotCliques.js';
export { setEventRatesForTest } from '#/engine/bot/port/BotRandomEvents.js';
export { setTrainRatesForTest } from '#/engine/bot/port/BotTrains.js';
export { setAlchRateForTest } from '#/engine/bot/port/BotAlch.js';
export { setScamRatesForTest } from '#/engine/bot/port/BotScams.js';
export { setWitnessRatesForTest } from '#/engine/bot/port/BotWitness.js';
export { setRole, clearRole } from '#/engine/bot/port/BotSetPieces.js';
export { isMultiCombat } from '#/engine/bot/port/BotContent.js';
export { personaOf } from '#/engine/bot/port/BotPersona.js';
export { streetPrice } from '#/engine/bot/port/BotPrices.js';
export { botFilter } from '#/engine/bot/port/BotFilter.js';
export { sayListeners } from '#/engine/bot/port/BotSay.js';
export { botErrorCount } from '#/engine/bot/port/BotLog.js';
export { campMayAttack, setCampRateForTest } from '#/engine/bot/tasks/PKerTask.js';
export * as MagicRuns from '#/engine/bot/port/BotMagicRuns.js';
export { Items, Locations, SkillProgression } from '#/engine/bot/BotKnowledge.js';
export * as Safespots from '#/engine/bot/port/BotSafespots.js';
export { RangedMagicTask } from '#/engine/bot/tasks/RangedMagicTask.js';
export { interactNpcOp } from '#/engine/bot/BotAction.js';
// (bots ideas, round 1, the fixes: a grabber's temple tile; a bot's own drop staged by the human's death)
export { standTileOf } from '#/engine/bot/port/BotTiles.js';
// (round 1's left-overs: T2) a grab's tile claimed by hand, the engine's sight test
export { claimStandTile } from '#/engine/bot/port/BotTiles.js';
export { isApproached } from '#/engine/GameMap.js';
export { EntityLifeCycle } from '#/engine/entity/EntityLifeCycle.js';
