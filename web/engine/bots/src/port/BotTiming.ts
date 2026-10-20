// port: human timing (the realism work, 2026-10-14). A bot answered 1.2-2.4 s after a line whatever its length (about
// 16 characters a second; a 2004 player typed about 3-6), re-clicked the next rock in the same tick it ran out, and
// every bank visit took the same 4.8 s. Each delay here is the bot's persona (port/BotPersona) times a draw from
// Math.random, so a seeded sim repeats.
import type Player from '#/engine/entity/Player.js';
import { personaOf, type Persona } from '#/engine/bot/port/BotPersona.js';
import type { PlannerKey } from '#/engine/bot/port/BotRoster.js';

/** One world tick in ms. */
const TICK_MS = 600;
/** The longest a single typed line takes (a slow typist's long answer): 12 s. */
const MAX_TYPING_TICKS = 20;

/** A log-normal draw around `median` (σ in log space). */
export function logNormal(median: number, sigma: number, random: () => number = Math.random): number {
    const u = 1 - random();
    const v = random();
    return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
}

export interface TypingOptions {
    /** the bot is fighting, skilling hard or in a menu: it notices and answers later */
    busy?: boolean;
    random?: () => number;
}

/**
 * Ticks from hearing a line to saying `text`: thinking (a log-normal around the persona's median, longer when busy) and
 * typing (its length at the persona's speed), at least 2 ticks and at most 12 s.
 */
export function typingTicks(persona: Persona, text: string, opts: TypingOptions = {}): number {
    const random = opts.random ?? Math.random;
    const think = logNormal(persona.thinkMs * (opts.busy ? 2 : 1), 0.45, random);
    const type = (text.length / persona.typingCps) * 1000 * (0.85 + random() * 0.3);
    return Math.max(2, Math.min(MAX_TYPING_TICKS, Math.round((think + type) / TICK_MS)));
}

/** What a bot reacts to, and how long that takes a person (in ticks, before the persona's speed). */
export type ReactionKind =
    /** the rock, tree or fish spot it worked ran out, or its target died: it clicks the next one */
    | 'retarget'
    /** it is done at the bank booth: it stands a moment before it walks off */
    | 'bank'
    /** a trade screen settled (both offers in, or the confirm screen): it reads it before accepting */
    | 'trade'
    /** something happened near it (a fight, a level-up): it looks up */
    | 'notice'
    /**
     * the next round of a task done over and over (the next fish on the range, the next pickpocket, the next bar): the
     * click or two it takes, now and then a longer look away. Wide on purpose: a person's rhythm is never a metronome
     * (the humanlike report's H18 counts identical intervals in whole ticks: under about 10 % takes a spread of about
     * ten tick values; median 4 ticks, a mean of about 8 over the personas, 7.4 % of two in a row the same; the
     * action's own time comes on top)
     */
    | 'next'
    /** a quick click: a dialogue page (an NPC's line, a choice) read and clicked on, the next log lit, a bone buried */
    | 'page';

const REACTION_MEDIAN: Record<ReactionKind, number> = { retarget: 3, bank: 9, trade: 4, notice: 2, next: 4, page: 2 };
const REACTION_SIGMA: Record<ReactionKind, number> = { retarget: 0.5, bank: 0.6, trade: 0.4, notice: 0.5, next: 1, page: 0.6 };
const REACTION_MAX: Record<ReactionKind, number> = { retarget: 12, bank: 40, trade: 12, notice: 8, next: 20, page: 8 };
/**
 * 'next' counts the persona's reaction from here up: per persona at most about 9 % of two rounds in a row alike (from
 * 0.85 up the quickest had 10.4 %, and kinds of 50-300 rounds came near H18's 10 %)
 */
const NEXT_REACTION_FLOOR = 1;
/** the kinds where the bot may look away a while (its persona's lapse rate): a re-click, the next round */
const LAPSES: ReadonlySet<ReactionKind> = new Set<ReactionKind>(['retarget', 'next']);

/**
 * Ticks before the bot acts on `kind`: a log-normal around a person's median times the persona's reaction, now and
 * then (its lapse rate) much longer for a re-click or the next round (it looked away), never below 0 or above a cap.
 */
export function reactionTicks(persona: Persona, kind: ReactionKind, random: () => number = Math.random): number {
    // (a round of the same thing takes its clicks however quick the person: for 'next' the reaction counts from 1 up, so
    // a quick persona's rounds are not squeezed into a few tick values, a metronome again)
    const reaction = kind === 'next' ? Math.max(NEXT_REACTION_FLOOR, persona.reaction) : persona.reaction;
    let ticks = logNormal(REACTION_MEDIAN[kind] * reaction, REACTION_SIGMA[kind], random);
    const lapses = LAPSES.has(kind);
    if (lapses && random() < persona.lapseRate) ticks += 5 + random() * 15;
    return Math.max(0, Math.min(REACTION_MAX[kind] + (lapses ? 20 : 0), Math.round(ticks)));
}

/** The persona of a bot in the world: its name's, with the planner it plays (port/BotPersona). */
export function botPersona(bot: Player): Persona {
    return personaOf(bot.username, (bot.botPlanner as PlannerKey | undefined) ?? null);
}

/** reactionTicks with the bot's own persona: how long this bot takes to act on `kind`, in ticks. */
export function botReactionTicks(bot: Player, kind: ReactionKind): number {
    return reactionTicks(botPersona(bot), kind);
}
