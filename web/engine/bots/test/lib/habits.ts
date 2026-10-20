// test/habits.test.mjs's world: test/lib/simworld.ts with the habits (port/BotHabits) and human timing (port/BotTiming)
// beside it, loaded through one module graph (the same BotManager, the same habits).
export * from './simworld.js';
export { habitOf, isAway, lastBreakOf, noteSpectacle, setHabitRatesForTest } from '#/engine/bot/port/BotHabits.js';
export { botPersona, reactionTicks } from '#/engine/bot/port/BotTiming.js';
export { tradeScreen } from '#/engine/bot/port/BotTradeScreen.js';
export { nearestBank } from '#/engine/bot/tasks/BotTaskBase.js';
export { findAggressorNpc } from '#/engine/bot/BotAction.js';
