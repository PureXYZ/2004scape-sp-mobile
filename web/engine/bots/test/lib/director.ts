// test/director.test.mjs's world (the realism work, phase 5b, Track D: the director): test/lib/simworld.ts with the set
// pieces' registry (port/BotSetPieces), the director (port/BotDirector) and what a stub piece gives its recruits, through
// one module graph.
export * from './simworld.js';
export * as SetPieces from '#/engine/bot/port/BotSetPieces.js';
export * as Director from '#/engine/bot/port/BotDirector.js';
export { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';
export { claimStandTile, releaseStandTile, stepToTile } from '#/engine/bot/port/BotTiles.js';
export { walkTo } from '#/engine/bot/BotAction.js';
export { NEW_LINES, rumourText } from '#/engine/bot/port/BotLines.js';
