// test/fashion.test.mjs's world (the variety work, round 2, track W2: fashion): test/lib/outfits.ts (the sim world, looks,
// gear, ageing, outfits and the dressing tasks) with the fashion (port/BotFashion), the show-off visits (port/BotShowOff),
// the vendors' stock and the PK profiles, through one module graph.
export * from './outfits.js';
export * as Fashion from '#/engine/bot/port/BotFashion.js';
export * as ShowOff from '#/engine/bot/port/BotShowOff.js';
export { STATUS_STOCK, vendorAskOf } from '#/engine/bot/tasks/VendorTask.js';
export { VendorTask } from '#/engine/bot/tasks/VendorTask.js';
export { streetPrice, streetRows } from '#/engine/bot/port/BotPrices.js';
export { setFashionPassForTest } from '#/engine/bot/port/BotAge.js';
export { PKerTask } from '#/engine/bot/tasks/PKerTask.js';
export { EdgevillePKerTask } from '#/engine/bot/tasks/EdgevillePKerTask.js';
export { generateEdgevillePkerProfiles } from '#/engine/bot/tasks/EdgevillePKerTask.js';
export { cliqueColourOf } from '#/engine/bot/port/BotCliques.js';
export { tradeScreen } from '#/engine/bot/port/BotTradeScreen.js';
export { HangoutTask } from '#/engine/bot/port/BotHangout.js';
export { CLAN_CLOTHES_SHARE, WOMAN_BALD_KEPT } from '#/engine/bot/BotAppearance.js';
export { installBotsContent } from './botscontent.js';
export { default as VarPlayerType } from '#/cache/config/VarPlayerType.js';
