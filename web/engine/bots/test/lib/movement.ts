// The bots ideas work, round 3 (theme H: movement): test/lib/simworld.ts with theme H's modules (port/BotMinimap: hops,
// pauses, the typing rule, overshoots, lanes, route variants; port/BotTalkMoves: walk up to talk, stop to talk), the
// walking graph, the threads and what a staged scene turns off, through one module graph. test/movement.test.mjs and
// test/talkmoves.test.mjs use it.
export * from './simworld.js';
export * as Minimap from '#/engine/bot/port/BotMinimap.js';
export * as TalkMoves from '#/engine/bot/port/BotTalkMoves.js';
export * as Threads from '#/engine/bot/port/BotThreads.js';
export * as Habits from '#/engine/bot/port/BotHabits.js';
export { graphRouteOfForTest, wrongTurnStats, setWrongTurnRateForTest, botTeleport, noteMove } from '#/engine/bot/BotAction.js';
export { nearestNode, nearestNodes, nodePos, route as graphRoute, routeCost as graphRouteCost } from '#/engine/bot/port/BotWalkGraph.js';
export { dangerOfNode, huntsMe } from '#/engine/bot/port/BotDanger.js';
export { personaOf } from '#/engine/bot/port/BotPersona.js';
export { setRole, clearRole, eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';
export { botErrorCount } from '#/engine/bot/port/BotLog.js';
export { sayTyped } from '#/engine/bot/port/BotChat.js';
export { claimVendorStall } from '#/engine/bot/port/BotTradeSpots.js';
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
export { getExpByLevel } from '#/engine/entity/Player.js';
export { standTileOf } from '#/engine/bot/port/BotTiles.js';
