// test/groups.test.mjs's world (the realism work, phase 5b, Track D: clan walks, PK team raids, newbie trains):
// test/lib/simworld.ts with the director (port/BotDirector), the pieces (port/BotClanWalk, port/BotPkTeam), the trains
// (port/BotTrains), the chain follow (port/BotFollow), the cliques and the PK tasks, through one module graph.
export * from './simworld.js';
export * as SetPieces from '#/engine/bot/port/BotSetPieces.js';
export * as Director from '#/engine/bot/port/BotDirector.js';
export * as ClanWalk from '#/engine/bot/port/BotClanWalk.js';
export * as PkTeam from '#/engine/bot/port/BotPkTeam.js';
export * as Trains from '#/engine/bot/port/BotTrains.js';
export * as Cliques from '#/engine/bot/port/BotCliques.js';
export * as WalkGraph from '#/engine/bot/port/BotWalkGraph.js';
export { ChainFollowTask } from '#/engine/bot/port/BotFollow.js';
export { EdgevillePKerTask } from '#/engine/bot/tasks/EdgevillePKerTask.js';
export { PKerTask } from '#/engine/bot/tasks/PKerTask.js';
export { NewbieTask } from '#/engine/bot/tasks/NewbieTask.js';
export { isMultiCombat, wildernessLevelAt as wildLevel } from '#/engine/bot/port/BotContent.js';
export { wardrobeItems, gearTaste } from '#/engine/bot/port/BotLooks.js';
export { whereOwned, CAPE_SHOP } from '#/engine/bot/port/BotGear.js';
export { personaOf } from '#/engine/bot/port/BotPersona.js';
export { bankInvId } from '#/engine/bot/tasks/BotTaskBase.js';
export { standTileOf } from '#/engine/bot/port/BotTiles.js';
export { default as ServerTriggerType } from '#/engine/script/ServerTriggerType.js';
export { default as ObjType } from '#/cache/config/ObjType.js';
export { NEW_LINES } from '#/engine/bot/port/BotLines.js';
export { humanLineListeners } from '#/engine/bot/port/BotChat.js';
export { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';
export { walkTo } from '#/engine/bot/BotAction.js';
// (the variety work, round 1, track F: the bots' random events off, as chat.test and duel.test have them)
export { setEventRatesForTest } from '#/engine/bot/port/BotRandomEvents.js';
// (the variety work, round 2, the integrator's: the clan walks', raids' and trains' scenes staged with the round's errands
// off, as party.test has them: a hosted errand holds a levelling bot or a newbie in a sub-task, which no set piece asks;
// loaded on demand, so an older library (an A/B run, LC_BOTS_SRC) loads and goes on without)
export async function setD2Offers(on: boolean): Promise<boolean> {
    const d2 = await import('#/engine/bot/port/BotD2Picks.js').catch(() => null);
    d2?.setD2OffersForTest(on);
    return d2 !== null;
}
