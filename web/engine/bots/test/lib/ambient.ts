// The bots ideas work, round 4 (theme I: the model for the bots' own talk; round 5: stage 2, the reactions to the human):
// test/lib/simworld.ts with port/BotModelAmbient, the model's seam (port/BotModel: the stub), its guard and prompt, the
// threads and the chat they hook into, (round 5) the reactions (port/BotReactions, port/BotWitness), and what a staged
// scene turns off, through one module graph. test/model-ambient.test.mjs uses it.
export * from './simworld.js';
export * as Ambient from '#/engine/bot/port/BotModelAmbient.js';
export * as BotModelNs from '#/engine/bot/port/BotModel.js';
export * as BotModelGuardNs from '#/engine/bot/port/BotModelGuard.js';
export * as BotModelPromptNs from '#/engine/bot/port/BotModelPrompt.js';
export * as Threads from '#/engine/bot/port/BotThreads.js';
export * as Minimap from '#/engine/bot/port/BotMinimap.js';
export { botPersona, chatDice, isBusy, sayTyped } from '#/engine/bot/port/BotChat.js';
// (round 4 fixes: the hold scene's typing time)
export { typingTicks } from '#/engine/bot/port/BotTiming.js';
export { personaOf } from '#/engine/bot/port/BotPersona.js';
export { botErrorCount } from '#/engine/bot/port/BotLog.js';
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
export { setTeleportRatesForTest } from '#/engine/bot/port/BotTeleport.js';
export { setRudeRatesForTest } from '#/engine/bot/port/BotRude.js';
export { quietForTest } from '#/engine/bot/port/BotChatter.js';
// ---- (bots ideas, round 5: I stage 2) the reactions to the human (port/BotReactions, port/BotWitness) ----
export * as Witness from '#/engine/bot/port/BotWitness.js';
export { REACTION_LINES } from '#/engine/bot/port/BotReactions.js';
export { default as SeqType } from '#/cache/config/SeqType.js';
export { setVoiceCapForTest } from '#/engine/bot/port/BotVoice.js';
// ---- end of I stage 2's block ----
