// port (bots ideas, round 2, theme D: word that travels):
// where the shared files ask theme D's modules (port/BotRumours, port/BotTies, port/BotSlang) without importing them. Each
// shared file's marked block "(bots ideas, round 2: D word)" calls a hook here; D's modules set them when they load
// (port/BotSetPieceIndex imports them). A hook not set answers as today (the shared file's own default), so a shared file
// behaves as before while D's modules are absent, and none of them changes the order the modules are evaluated in (an early
// import once crashed a world on a binding not yet initialised: this module imports nothing at run time).
//
// Bots only: every hook is about bots (a rumour a bot knows, a tie between two bots, a phrase a bot borrowed from another
// bot's line). Nothing here is about the human: no rumour has the human as its subject or its place, no tie or phrase names
// or comes from the human.
import type Player from '#/engine/entity/Player.js';
import type { SkillStep } from '#/engine/bot/BotKnowledge.js';
import type { ArcTag } from '#/engine/bot/port/BotArcsEvents.js';
import type { SetPieceRun } from '#/engine/bot/port/BotSetPieces.js';

export interface WordHooks {
    // ── D1 rumours (port/BotRumours) ──
    /** port/BotChatter.sayDue: the bot tells a rumour it knows instead of its due idle line (true: said, the due line's place) */
    dueLine?(bot: Player, now: number): boolean;
    /**
     * port/BotDirector.sayRumour: of the bots near a run's venue, who tells its rumour: a knower first, else `fallback` (the
     * director's own pick), made a knower ("heard it from a friend"); and the tag its line carries (the hearers learn it)
     */
    directorSpeaker?(run: SetPieceRun, near: readonly Player[], fallback: Player): { speaker: Player; tag?: ArcTag };
    /** port/BotDirector → port/BotReactions.rumourNearHuman: a knower of the run's rumour first (the 50 % roll is the director's) */
    knowsRun?(bot: Player, run: SetPieceRun): boolean;
    /** the bot said the run's rumour near the human: made a knower if it was not one; the line's tag */
    toldRun?(bot: Player, run: SetPieceRun): ArcTag | undefined;
    /** port/BotWildTrips.wildTripFor: a spot (x, z) the bot knows a pk rumour about (it skips the trip) */
    wildTripAvoid?(bot: Player, x: number, z: number): boolean;
    /** tasks/MiningTask at its walk's start: another step of its ore the rocks rumours it knows send it to, or null */
    rocksStep?(bot: Player, step: SkillStep): SkillStep | null;
    /** tasks/MiningTask: a mine full (its wait for a rock given up) or with rocks free for the taking (a rumour's seed) */
    rocksSeen?(bot: Player, step: SkillStep, what: 'full' | 'free'): void;
    /** port/BotAnswers.stateAnswer: the answer to "where?", "when?", "real?" after the bot told a rumour (null: none) */
    rumourAnswer?(bot: Player, msg: string, pick: (pool: readonly string[]) => string): { id: string; text: string } | null;

    // ── D2 ties (port/BotTies) ──
    /** tasks/CombatTask, tasks/MiningTask: the steal roll's factor against `victim` (the KS war: 3 against a grudge's bot) */
    stealFactor?(bot: Player, victim: Player): number;
    /** tasks/EdgevillePKerTask.findNearbyTarget: a rival of the bot's among the valid targets (`valid`), or null */
    rival?(bot: Player, radius: number, valid: (p: Player) => boolean): Player | null;

    // ── D3 slang (port/BotSlang) ──
    /** port/BotLines.catchphrasesOf: the catchphrases the bot borrowed from other bots (CATCHPHRASE_LIST indexes) and their weights (0-1) */
    borrowedPhrases?(name: string): readonly { phrase: number; weight: number }[];
}

/** theme D's hooks (set by its modules at load; unset: the shared files as before) */
export const wordHooks: WordHooks = {};

// ── theme D's dice ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Theme D's own dice: a stream of its own (mulberry32), seeded from Math.random (the library's dice: seeded in the sims)
 * at its first roll, so D's rolls (a hearing, a PM, a tie's forming, a greeting, an adoption ...) never move the rest
 * of the world's draws: a staged scene's dice, and an A/B run's course, change only by what D does. No wall clock.
 */
let diceState: number | null = null;
export function wordRoll(): number {
    if (diceState === null) diceState = Math.floor(Math.random() * 4294967296) | 0 || 1;
    diceState = (diceState + 0x6d2b79f5) | 0;
    let t = Math.imul(diceState ^ (diceState >>> 15), 1 | diceState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** a whole number in [lo, hi] on theme D's dice */
export function wordRandInt(lo: number, hi: number): number {
    return lo + Math.floor(wordRoll() * (hi - lo + 1));
}
/** Tests only: D's dice seeded again from Math.random at their next roll (a staged scene's own dice), or from `seed`. */
export function seedWordDiceForTest(seed: number | null = null): void {
    diceState = seed === null ? null : seed | 0 || 1;
}
