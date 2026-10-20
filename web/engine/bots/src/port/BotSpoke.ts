// port: what bots said lately without being spoken to (an idle line, a level-up line, a social bot's question), where,
// and to whom: a human's next line may be the answer (BotChat: the 30 s reply window after a bot spoke to that human;
// "gz" to a level-up line gets "ty"). No imports from the library: BotPlayer and SocialTask, which say the lines, and
// BotChat, which hears the human, all use it.
import type Player from '#/engine/entity/Player.js';

/**
 * port: 'newbie': a newbie newcomer's question to anyone (port/BotNewbie): the next line near it may answer it.
 * 'question': any other bot's question to anyone (the realism work: other bots, and the human, may answer it);
 * 'event': a line about something that just happened to the bot (a death, a drop, arriving somewhere).
 */
export type SpokeKind = 'idle' | 'levelup' | 'social' | 'newbie' | 'question' | 'event';

/**
 * (the variety work, round 1, Track S: SAY-6) what kind of line it was, for the responses that may follow it (port/BotLines
 * fits: a response line's `after` classes): a statement, a question, a greeting, a level-up, a mishap (a death, a near
 * death, a stolen tree), a brag (a drop, a level claim), a complaint, a meme, a laugh, a rude line, thanks, a response
 * (a response never answers a response), spam (the same bot's third line in a minute), a social bot's line, a newbie's
 * statement. Classed by the speaker's side (port/BotChatter heardClassOf); a line noted without one takes its kind's.
 */
export type HeardClass = 'statement' | 'question' | 'greeting' | 'levelup' | 'mishap' | 'brag' | 'complaint' | 'meme' | 'laugh' | 'rude' | 'thanks' | 'response' | 'spam' | 'social' | 'newbie';
/** a kind's class when the speaker gave none */
const KIND_CLASS: Readonly<Record<SpokeKind, HeardClass>> = { idle: 'statement', levelup: 'levelup', social: 'social', newbie: 'newbie', question: 'question', event: 'statement' };
/** (SAY-6) a bot's third line within this many ticks is spam ("Stop spamming") */
const SPAM_TICKS = 100;

export interface Spoke {
    bot: Player;
    kind: SpokeKind;
    tick: number;
    x: number;
    z: number;
    level: number;
    /** the player it was said to (its name in the line, a social bot's target), or null */
    to: Player | null;
    /** (variety round 1, SAY-6) what kind of line it was (HeardClass) */
    cls: HeardClass;
}

/** the last few lines, oldest first (a line older than a reply window is never asked for) */
const recent: Spoke[] = [];
const KEPT = 64;

export function noteSpoke(bot: Player, kind: SpokeKind, tick: number, to: Player | null = null, cls?: HeardClass): void {
    // (variety round 1, SAY-6: the same bot's third line within a minute is spam, whatever it said)
    let mine = 0;
    for (let i = recent.length - 1; i >= 0 && tick - recent[i].tick <= SPAM_TICKS; i--) if (recent[i].bot === bot) mine++;
    recent.push({ bot, kind, tick, x: bot.x, z: bot.z, level: bot.level, to, cls: mine >= 2 ? 'spam' : (cls ?? KIND_CLASS[kind]) });
    if (recent.length > KEPT) recent.shift();
}

/** The newest line of the last `ticks` said to `human`, or null. */
export function lastSpokenTo(human: Player, now: number, ticks: number): Spoke | null {
    for (let i = recent.length - 1; i >= 0; i--) {
        const s = recent[i];
        if (now - s.tick > ticks) break;
        if (s.to === human) return s;
    }
    return null;
}

/** The newest line of the last `ticks` (of `kind`, if given) said within `distance` of (x, z) on `level`, or null. */
export function lastHeard(x: number, z: number, level: number, now: number, ticks: number, distance: number, kind?: SpokeKind): Spoke | null {
    for (let i = recent.length - 1; i >= 0; i--) {
        const s = recent[i];
        if (now - s.tick > ticks) break;
        if (kind !== undefined && s.kind !== kind) continue;
        if (s.level === level && Math.max(Math.abs(s.x - x), Math.abs(s.z - z)) <= distance) return s;
    }
    return null;
}
