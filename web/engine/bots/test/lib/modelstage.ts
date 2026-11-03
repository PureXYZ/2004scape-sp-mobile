// The bots ideas work, round 5 (theme I stage 2: the r3 retrain's data): test/lib/simworld.ts with what the staged world
// of test/model-data/stage-r3.mjs needs, through one module graph: the bots' own talk and the reactions' listeners and
// switch (port/BotModelAmbient), the threads and a bot's questions (port/BotThreads, port/BotChat, port/BotLines), the
// reactions' chances (port/BotReactions, port/BotWitness), the human's emotes, follows, kills and kits.
export * from './simworld.js';
export * as Ambient from '#/engine/bot/port/BotModelAmbient.js';
export * as Threads from '#/engine/bot/port/BotThreads.js';
export { setReactionRatesForTest, forgetHumanForTest as forgetReactionsForTest } from '#/engine/bot/port/BotReactions.js';
export { setWitnessRatesForTest, forgetHumanForTest as forgetWitnessForTest, readyForTest as witnessReadyForTest } from '#/engine/bot/port/BotWitness.js';
export { nearBank } from '#/engine/bot/port/BotLines.js';
export { botPersona, chatDice, sayTyped } from '#/engine/bot/port/BotChat.js';
export { ALL_LINES, contextOf, pickLine } from '#/engine/bot/port/BotLines.js';
export { styleLine } from '#/engine/bot/port/BotStyle.js';
export { personaOf } from '#/engine/bot/port/BotPersona.js';
export { botErrorCount } from '#/engine/bot/port/BotLog.js';
export { default as SeqType } from '#/cache/config/SeqType.js';
export { default as ObjType } from '#/cache/config/ObjType.js';
export { NpcStat } from '#/engine/entity/NpcStat.js';
export { Interaction } from '#/engine/entity/Interaction.js';
export { default as ServerTriggerType } from '#/engine/script/ServerTriggerType.js';
export { wearItems } from './coverage.js';
