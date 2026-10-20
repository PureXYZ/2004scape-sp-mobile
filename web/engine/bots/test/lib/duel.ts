// test/duel.test.mjs's world (the realism work, phase 5b, Track A: the Duel Arena and the player-mod bot): test/lib/trade.ts
// (the real 274 world, the content overlay as the runtime installs it, the human's own packet handlers: their duel
// clicks go through the engine's checks) with the arena's modules (port/BotArena, port/BotDuel, tasks/DuelArenaTask), the
// player-mod bot (port/BotModBot), the set pieces' registry and the answers, through one module graph.
export * from './trade.js';
export * as Arena from '#/engine/bot/port/BotArena.js';
export * as Duel from '#/engine/bot/port/BotDuel.js';
export * as ModBot from '#/engine/bot/port/BotModBot.js';
export * as SetPieces from '#/engine/bot/port/BotSetPieces.js';
export { DuelArenaTask } from '#/engine/bot/tasks/DuelArenaTask.js';
export { botSay } from '#/engine/bot/port/BotSay.js';
export { humanLineListeners } from '#/engine/bot/port/BotChat.js';
export { stateAnswer, ANSWER_LINES } from '#/engine/bot/port/BotAnswers.js';
export { personaOf } from '#/engine/bot/port/BotPersona.js';
export { ageTierFor } from '#/engine/bot/port/BotAge.js';
export { nameSeed } from '#/engine/bot/port/BotSeed.js';
export { coinsOwned } from '#/engine/bot/BotNeeds.js';
export { bankInvId, edibleFoodIds } from '#/engine/bot/tasks/BotTaskBase.js';
export { default as NpcType } from '#/cache/config/NpcType.js';
export { default as ScriptState } from '#/engine/script/ScriptState.js';
export { teleportStats } from '#/engine/bot/BotAction.js';
export { setHabitRatesForTest } from '#/engine/bot/port/BotHabits.js';
export { setEventRatesForTest } from '#/engine/bot/port/BotRandomEvents.js';
// (the variety work, round 1, track F: the mod's checks without an ambient scam stint beside them)
export { setScamRatesForTest, resetScamsForTest } from '#/engine/bot/port/BotScams.js';
