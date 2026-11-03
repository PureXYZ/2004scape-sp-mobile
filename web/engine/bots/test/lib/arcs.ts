// The bots ideas work, round 2 (themes C and D): the arcs foundation for the tests:
// test/lib/simworld.ts with the saved arcs (port/BotArcsStore), the bus (port/BotArcsEvents: emitArcs for staging, the
// play clock held for a test: setPlayForTest), the line helper and its pools (port/BotArcsSay), and what a staged scene
// turns off, through one module graph. test/arcs-store.test.mjs uses it; theme C's test/arcs.test.mjs and theme D's
// test/word.test.mjs may import it and add their own modules in their blocks below.
export * from './simworld.js';
export * as ArcsStore from '#/engine/bot/port/BotArcsStore.js';
export * as ArcsEvents from '#/engine/bot/port/BotArcsEvents.js';
export * as ArcsSay from '#/engine/bot/port/BotArcsSay.js';
export { emitArcs, onArcs, registerArcsTick, arcsPlay, setArcsPlayForTest as setPlayForTest } from '#/engine/bot/port/BotArcsEvents.js';
export { sayArcLine, arcLines, fillArcSlots, pickArcLine } from '#/engine/bot/port/BotArcsSay.js';
export { mayLeaveAbruptly } from '#/engine/bot/BotManager.js';
export { CATCHPHRASE_LIST, catchphraseIndexOf, catchphrasesOf, NEW_LINES, resetLineRegistry } from '#/engine/bot/port/BotLines.js';
export * as SayChatter from '#/engine/bot/port/BotChatter.js';
export { noteDeath } from '#/engine/bot/port/BotFumble.js';
export { personaOf } from '#/engine/bot/port/BotPersona.js';
export { setRole, clearRole } from '#/engine/bot/port/BotSetPieces.js';
export { botFilter } from '#/engine/bot/port/BotFilter.js';
export { botErrorCount } from '#/engine/bot/port/BotLog.js';
export { noteSteal } from '#/engine/bot/port/BotRude.js';
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
// ---- C arcs: theme C's modules for its tests (port/BotGoals, BotMoods, BotLeaving, BotNinetyNine, BotWhims, BotWeddings) ----
export * as Goals from '#/engine/bot/port/BotGoals.js';
export * as Moods from '#/engine/bot/port/BotMoods.js';
export * as Leaving from '#/engine/bot/port/BotLeaving.js';
export * as Whims from '#/engine/bot/port/BotWhims.js';
export * as Ninety from '#/engine/bot/port/BotNinetyNine.js';
export { partyLog, setPartyDefaultsForTest } from '#/engine/bot/port/BotParty.js';
export { SkillProgression } from '#/engine/bot/BotKnowledge.js';
export { default as ObjType } from '#/cache/config/ObjType.js';
export { WoodcuttingTask } from '#/engine/bot/tasks/WoodcuttingTask.js';
export { setCliquesForTest } from '#/engine/bot/port/BotCliques.js';
export { BankTask } from '#/engine/bot/tasks/UtilTasks.js';
export { LIVES, livesLines } from '#/engine/bot/port/BotLives.js';
export * as Answers from '#/engine/bot/port/BotAnswers.js';
export { endgameOfferScale } from '#/engine/bot/port/BotEndgameCore.js';
export { getExpByLevel } from '#/engine/entity/Player.js';
export { Items } from '#/engine/bot/BotKnowledge.js';
export { setAwayForTest } from '#/engine/bot/port/BotHabits.js';
export { OWED_REPLY_MOST } from '#/engine/bot/port/BotChat.js';
// ---- end of C's exports ----
// ---- D word: theme D's modules for its tests (port/BotRumours, BotTies, BotSlang) ----
export * as Rumours from '#/engine/bot/port/BotRumours.js';
export * as Ties from '#/engine/bot/port/BotTies.js';
export * as Slang from '#/engine/bot/port/BotSlang.js';
export * as WordHooks from '#/engine/bot/port/BotWordHooks.js';
export * as Party from '#/engine/bot/port/BotParty.js';
export * as Cliques from '#/engine/bot/port/BotCliques.js';
export * as WildTrips from '#/engine/bot/port/BotWildTrips.js';
export * as Rude from '#/engine/bot/port/BotRude.js';
export * as Threads from '#/engine/bot/port/BotThreads.js';
export { standInContext, startPiece, tickPiece } from './party.js';
export { setD2OffersForTest } from '#/engine/bot/port/BotD2Picks.js';
export { setLingerForTest } from '#/engine/bot/port/BotLinger.js';
export { stateAnswer } from '#/engine/bot/port/BotAnswers.js';
export { botPersona as personaNow } from '#/engine/bot/port/BotTiming.js';
export { runEnded as setPieceRunEnded } from '#/engine/bot/port/BotSetPieces.js';
import type PlayerD from '#/engine/entity/Player.js';
import { botSay as botSayD } from '#/engine/bot/port/BotSay.js';
/** a bot says a catchphrase (its index on the 'said' event, as port/BotChatter's own pick says it) */
export function botSayForTest(bot: PlayerD, text: string, phrase: number): void {
    botSayD(bot, text, undefined, 'idle', null, { catchphrase: phrase });
}
// ---- end of D's exports ----
