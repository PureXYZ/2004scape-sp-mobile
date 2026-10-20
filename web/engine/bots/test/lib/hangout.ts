// test/hangout.test.mjs's world: test/lib/simworld.ts with the hang-outs (port/BotHangout), the own tiles (port/BotTiles)
// and the habits (port/BotHabits) beside it, loaded through one module graph (the same BotManager, the same claims).
export * from './simworld.js';
export { HANGOUT_SPOTS, HANGOUT_STAND_TICKS, hangoutsOf, setHangoutRateForTest, HangoutTask } from '#/engine/bot/port/BotHangout.js';
// (hangoutOf: simworld's, by name)
export { standTileOf, claimedTiles } from '#/engine/bot/port/BotTiles.js';
export { habitOf, setHabitRatesForTest } from '#/engine/bot/port/BotHabits.js';
export { isNewbie } from '#/engine/bot/port/BotNewbie.js';
