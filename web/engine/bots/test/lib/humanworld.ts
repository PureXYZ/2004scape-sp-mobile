// The real rev-274 world for test/humanlike.mjs: everything test/lib/simworld.ts gives, plus what the humanlike report
// reads besides (worn items' names, the private messages the human gets, the banks the bots know, the zones' index for
// who attacks a bot, how BotSay splits a long line, the bots' error log) and the bots' content overlay, as the app has
// it. One import, so one engine and one bot library.
export * from './simworld.js';
export { default as ObjType } from '#/cache/config/ObjType.js';
export { default as MessagePrivate } from '#/network/game/server/model/MessagePrivate.js';
export { Locations } from '#/engine/bot/BotKnowledge.js';
export { default as ZoneMap } from '#/engine/zone/ZoneMap.js';
export { splitLine } from '#/engine/bot/port/BotSay.js';
export { botConsole, botErrorCount } from '#/engine/bot/port/BotLog.js';
export { installBotsContent } from './botscontent.js';
// phase 3, track C (social life): the cliques (cliqueOf for G1; the module whole, for what an older library may lack:
// the A/B runs' LC_BOTS_SRC), and what the stand-ins for the other tracks' hooks call (--fake-clique-steps,
// --fake-clique-returns: the planner's step checks)
export * as BotCliques from '#/engine/bot/port/BotCliques.js';
export { BotGoalPlanner } from '#/engine/bot/BotGoalPlanner.js';
export { combatWeaponFor, fitToFight } from '#/engine/bot/tasks/CombatTask.js';
export { knownFare } from '#/engine/bot/BotAction.js';
export { coinsOwned } from '#/engine/bot/BotNeeds.js';
// (realism phase 4, track B: economy) the vendors' module whole, for E1's stock-by-trade-bank count (bankTradeWeight:
// an older library lacks it)
export * as Vendors from '#/engine/bot/tasks/VendorTask.js';
// (realism phase 5a, Track M: movement and magic) the spells' and alching's counters (TP1-TP4, F2, AL1): namespaces of
// modules the foundation already had, so an A/B run against an older library loads (it shows none)
export * as Teleport from '#/engine/bot/port/BotTeleport.js';
export * as BotAlchNs from '#/engine/bot/port/BotAlch.js';
export * as BotActionNs from '#/engine/bot/BotAction.js';
// ---- (realism phase 5a, track F: fights, skills and manners) ----
// the misclicks, forgotten food, deaths' carelessness (port/BotFumble), the incidents of kill- and rock-stealing, the
// courtesy and the rude replies (port/BotRude), read once at the end of a run; and what the probe human (--work) needs:
// it clicks cows and rocks as the bots do. Loaded on demand: an older library (an A/B run, LC_BOTS_SRC) has no such
// modules, and the measures read n/a.
export { interactLoc, findLocByPrefixWhere, findNpcFiltered } from '#/engine/bot/BotAction.js';
export async function textureModules(): Promise<{ fumble: typeof import('#/engine/bot/port/BotFumble.js') | null; rude: typeof import('#/engine/bot/port/BotRude.js') | null }> {
    const [fumble, rude] = await Promise.all([import('#/engine/bot/port/BotFumble.js').catch(() => null), import('#/engine/bot/port/BotRude.js').catch(() => null)]);
    return { fumble, rude };
}
// ---- end of track F's block ----
// (realism phase 5a, track E: random events) the module whole: its listeners for RE1-RE7 (a library before phase 5a's
// foundation has no such module: the runner then needs one from 9be3e80 on)
export * as RandomEvents from '#/engine/bot/port/BotRandomEvents.js';
// ---- (realism phase 5b, Track D: the director and groups) the director's and the trains' logs, the set pieces under way
// (port/BotSetPieces), a clan walk's capes, the map's multi-combat (port/BotContent isMultiCombat): loaded on demand, so a
// library without them (an A/B run, LC_BOTS_SRC) loads and the V and G metrics read n/a ----
export async function setPieceModules(): Promise<{ director: typeof import('#/engine/bot/port/BotDirector.js') | null; setPieces: typeof import('#/engine/bot/port/BotSetPieces.js') | null; trains: typeof import('#/engine/bot/port/BotTrains.js') | null; content: typeof import('#/engine/bot/port/BotContent.js') | null }> {
    const [director, setPieces, trains, content] = await Promise.all([
        import('#/engine/bot/port/BotDirector.js').catch(() => null),
        import('#/engine/bot/port/BotSetPieces.js').catch(() => null),
        import('#/engine/bot/port/BotTrains.js').catch(() => null),
        import('#/engine/bot/port/BotContent.js').catch(() => null)
    ]);
    return { director, setPieces, trains, content };
}
// ---- end of Track D's (phase 5b) block ----
// ---- (realism phase 5b, track P: parties, scams and lures) ----
// the parties', the scam callers' and the lures' logs (DP1-DP5, K1-K4), the set pieces' registry (a party or a stint forced
// near the touring human's route: --party, --scam), loaded on demand: an older library (an A/B run, LC_BOTS_SRC) has no
// such modules, and the measures read n/a
export { interactObjOp } from '#/engine/bot/BotAction.js';
export async function partyModules(): Promise<{
    party: typeof import('#/engine/bot/port/BotParty.js');
    scams: typeof import('#/engine/bot/port/BotScams.js');
    social: typeof import('#/engine/bot/tasks/SocialTask.js');
    pieces: typeof import('#/engine/bot/port/BotSetPieces.js');
} | null> {
    try {
        const [party, scams, social, pieces] = await Promise.all([import('#/engine/bot/port/BotParty.js'), import('#/engine/bot/port/BotScams.js'), import('#/engine/bot/tasks/SocialTask.js'), import('#/engine/bot/port/BotSetPieces.js')]);
        return party.partyLog && scams.scamLog && social.lureLog ? { party, scams, social, pieces } : null;
    } catch {
        return null;
    }
}
// ---- end of track P's block ----
// ---- (realism phase 5b, track A: the Duel Arena and the player-mod bot) the arena's logs and its places (A1-A6), the mod's
// duty and its pick (Q1-Q3). Loaded on demand: an older library (an A/B run, LC_BOTS_SRC) has no such modules, and the
// measures read n/a ----
export async function arenaModules(): Promise<{ arena: typeof import('#/engine/bot/port/BotArena.js') | null; duel: typeof import('#/engine/bot/port/BotDuel.js') | null; mod: typeof import('#/engine/bot/port/BotModBot.js') | null }> {
    const [arena, duel, mod] = await Promise.all([
        import('#/engine/bot/port/BotArena.js').catch(() => null),
        import('#/engine/bot/port/BotDuel.js').catch(() => null),
        import('#/engine/bot/port/BotModBot.js').catch(() => null)
    ]);
    return { arena, duel, mod };
}
// ---- end of track A's (phase 5b) block ----
// (realism phase 7, the language model) the seam (its listeners: --model-capture) and the situation of a reply
export * as BotModelNs from '#/engine/bot/port/BotModel.js';
export * as BotModelPromptNs from '#/engine/bot/port/BotModelPrompt.js';

// (variety round 1: each track's exports for the runner in a block of its own)
// ---- Track F (fixes and movement) ----
// the fixes' counters (TP4f, AM6, AM7, the reach checks, the fire lane, alching at bank stops, the linger at a login):
// loaded on demand, so an older library (an A/B run, LC_BOTS_SRC: the foundation's has neither the counters nor
// port/BotLinger) loads and the measures read n/a
export async function fixesModules(): Promise<{
    base: typeof import('#/engine/bot/tasks/BotTaskBase.js') | null;
    action: typeof import('#/engine/bot/BotAction.js') | null;
    fire: typeof import('#/engine/bot/tasks/FiremakingTask.js') | null;
    alch: typeof import('#/engine/bot/port/BotAlch.js') | null;
    linger: typeof import('#/engine/bot/port/BotLinger.js') | null;
}> {
    const [base, action, fire, alch, linger] = await Promise.all([
        import('#/engine/bot/tasks/BotTaskBase.js').catch(() => null),
        import('#/engine/bot/BotAction.js').catch(() => null),
        import('#/engine/bot/tasks/FiremakingTask.js').catch(() => null),
        import('#/engine/bot/port/BotAlch.js').catch(() => null),
        import('#/engine/bot/port/BotLinger.js').catch(() => null)
    ]);
    return { base, action, fire, alch, linger };
}
// ---- end of Track F's exports ----
// ---- Track D (what and where) ----
// the spots' keys, capacities and the task a step comes from (port/BotSpots), the names' themes (port/BotFavourites), the
// dungeons' ways in (BotKnowledge dungeonRoute), the power-droppers' counts (port/BotPowerDrop): loaded on demand, so a
// library without them (an A/B run, LC_BOTS_SRC) loads and AM2's capacities and AM4 read n/a
export async function varietyDModules(): Promise<{ spots: typeof import('#/engine/bot/port/BotSpots.js') | null; favourites: typeof import('#/engine/bot/port/BotFavourites.js') | null; knowledge: typeof import('#/engine/bot/BotKnowledge.js') | null; powerDrop: typeof import('#/engine/bot/port/BotPowerDrop.js') | null }> {
    const [spots, favourites, knowledge, powerDrop] = await Promise.all([
        import('#/engine/bot/port/BotSpots.js').catch(() => null),
        import('#/engine/bot/port/BotFavourites.js').catch(() => null),
        import('#/engine/bot/BotKnowledge.js').catch(() => null),
        import('#/engine/bot/port/BotPowerDrop.js').catch(() => null)
    ]);
    return { spots, favourites, knowledge, powerDrop };
}
// ---- end of Track D's exports ----
// ---- Track S (what they say) ----
// (the chatter's counts, W3/W5/W6; the registry's meaning key and the lines, W1/W4/W9/W11)
// (namespaces, not names: an A/B run against an older library, without them, must still load: n/a then)
export * as SayChatter from '#/engine/bot/port/BotChatter.js';
export * as SayLines from '#/engine/bot/port/BotLines.js';
// ---- end of Track S's exports ----
// ---- Track W (what they wear) ----
// port/BotOutfits (styles, a name's class and its look): loaded on demand, so a library without it (an A/B run against
// the round's "before", LC_BOTS_SRC) loads and the L metrics of the census still read (L7's class look n/a)
export async function wearModules(): Promise<{ outfits: typeof import('#/engine/bot/port/BotOutfits.js') | null }> {
    const outfits = await import('#/engine/bot/port/BotOutfits.js').catch(() => null);
    return { outfits };
}
// ---- end of Track W's exports ----
// ---- (variety round 2) Track D2 (new activities) exports ----
// the errands' and the offers' counts (tasks/ErrandTask, port/BotD2Picks, port/BotErrandLines), the trips' and the rides'
// (port/BotWildTrips, port/BotTravel): loaded on demand, so an older library (an A/B run, LC_BOTS_SRC) loads and the
// measures that need them read n/a
export async function activities2Modules(): Promise<{
    errand: typeof import('#/engine/bot/tasks/ErrandTask.js') | null;
    picks: typeof import('#/engine/bot/port/BotD2Picks.js') | null;
    lines: typeof import('#/engine/bot/port/BotErrandLines.js') | null;
    wild: typeof import('#/engine/bot/port/BotWildTrips.js') | null;
    travel: typeof import('#/engine/bot/port/BotTravel.js') | null;
    magic: typeof import('#/engine/bot/port/BotMagicRuns.js') | null;
}> {
    const [errand, picks, lines, wild, travel, magic] = await Promise.all([
        import('#/engine/bot/tasks/ErrandTask.js').catch(() => null),
        import('#/engine/bot/port/BotD2Picks.js').catch(() => null),
        import('#/engine/bot/port/BotErrandLines.js').catch(() => null),
        import('#/engine/bot/port/BotWildTrips.js').catch(() => null),
        import('#/engine/bot/port/BotTravel.js').catch(() => null),
        import('#/engine/bot/port/BotMagicRuns.js').catch(() => null)
    ]);
    return { errand, picks, lines, wild, travel, magic };
}
// ---- end of Track D2's exports ----
// ---- (variety round 2) Track M (members places and minigames) exports ----
// port/BotOutings (the far towns' outings, the minigames' registry and logs: FT1, MG1, MG2): loaded on demand, so a
// library without it (an A/B run against the round's "before", LC_BOTS_SRC) loads and the M metrics read what the places
// show (the outings' and minigames' logs n/a)
export async function membersModules(): Promise<{ outings: typeof import('#/engine/bot/port/BotOutings.js') | null }> {
    const outings = await import('#/engine/bot/port/BotOutings.js').catch(() => null);
    return { outings };
}
// ---- end of Track M's exports ----
// ---- (variety round 2) Track S2 (conversation) exports ----
// port/BotThreads (the threads' counts, W7c), port/BotWitness (the reactions said and what about, W10, W14, W15) and
// port/BotVoice (the lines its cap held, W8): loaded
// on demand, so a library without them (an A/B run, LC_BOTS_SRC) loads and those measures read n/a
export async function talk2Modules(): Promise<{ threads: typeof import('#/engine/bot/port/BotThreads.js') | null; witness: typeof import('#/engine/bot/port/BotWitness.js') | null; voice: typeof import('#/engine/bot/port/BotVoice.js') | null }> {
    const [threads, witness, voice] = await Promise.all([import('#/engine/bot/port/BotThreads.js').catch(() => null), import('#/engine/bot/port/BotWitness.js').catch(() => null), import('#/engine/bot/port/BotVoice.js').catch(() => null)]);
    return { threads, witness, voice };
}
// ---- end of Track S2's exports ----
// ---- (variety round 2) Track W2 (fashion) exports ----
// port/BotFashion (status pieces, wealth, the members fashion), port/BotShowOff (the show-off visits' counts), the age tiers and
// the bald kit (a woman's design-screen default): on demand, so an older library loads (L6-L11 n/a then)
export async function fashionModules(): Promise<{ fashion: typeof import('#/engine/bot/port/BotFashion.js') | null; showOff: Record<string, unknown> | null; ageTierFor: ((name: string, planner: string) => string) | null; baldKit: number | null; vendorAsk: ((bot: unknown, itemId: number) => number | null) | null }> {
    const fashion = await import('#/engine/bot/port/BotFashion.js').catch(() => null);
    const showOff = (await import('#/engine/bot/port/BotShowOff.js' as string).catch(() => null)) as Record<string, unknown> | null;
    const age = await import('#/engine/bot/port/BotAge.js').catch(() => null);
    const appearance = await import('#/engine/bot/BotAppearance.js').catch(() => null);
    let baldKit: number | null = null;
    try {
        baldKit = appearance?.designDefaults?.(1)?.[0] ?? null;
    } catch {
        baldKit = null;
    }
    const vendor = await import('#/engine/bot/tasks/VendorTask.js').catch(() => null);
    const vendorAsk = vendor && typeof (vendor as { vendorAskOf?: unknown }).vendorAskOf === 'function' ? (vendor as { vendorAskOf: (bot: unknown, itemId: number) => number | null }).vendorAskOf : null;
    return { fashion, showOff, ageTierFor: age ? (name: string, planner: string) => age.ageTierFor(name, planner as never) : null, baldKit, vendorAsk };
}
// ---- end of Track W2's exports ----
