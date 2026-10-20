// test/model.test.mjs's world (the realism work, phase 7: the language model): test/lib/simworld.ts with the model's
// seam (port/BotModel), the situation and its prompts (port/BotModelPrompt), the guard (port/BotModelGuard), the history
// (port/BotModelHistory) and the chat it hooks into, through one module graph. Track E: what the model's own checks need
// (the private messages the human is sent, a frozen bot's page, the reply window, the personas' typing).
export * from './simworld.js';
export * as BotModelNs from '#/engine/bot/port/BotModel.js';
export * as BotModelPromptNs from '#/engine/bot/port/BotModelPrompt.js';
export * as BotModelGuardNs from '#/engine/bot/port/BotModelGuard.js';
export * as BotModelHistoryNs from '#/engine/bot/port/BotModelHistory.js';
export { botPersona, chatDice, composeReply } from '#/engine/bot/port/BotChat.js';
export { botSay } from '#/engine/bot/port/BotSay.js';
export { setHabitRatesForTest } from '#/engine/bot/port/BotHabits.js';
export { setEventRatesForTest } from '#/engine/bot/port/BotRandomEvents.js';
export { noteSpoke } from '#/engine/bot/port/BotSpoke.js';
export { default as ObjType } from '#/cache/config/ObjType.js';
export { default as InvType } from '#/cache/config/InvType.js';
export { default as MessagePrivate } from '#/network/game/server/model/MessagePrivate.js';
export { default as ScriptState } from '#/engine/script/ScriptState.js';
export { fromBase37 } from '#/util/JString.js';
