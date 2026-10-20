// port (the realism work, phase 5b, Track P: parties, scams and lures): a set
// piece's own lines, said at their moment by the piece (a party's countdown, a guest's "woo", a scam caller's call, the
// crowd's "its a scam"). They are 2004 lines of data/lines2004-parties.json (port/BotLines NEW_LINES), found by their
// group's event and kind ("party" / "call-first-falador_park"); the chatter never picks them as idle talk, since no bot
// is ever noted with those events (port/BotLines fits: an event line only while its event is fresh).
//
// A line said here:
//   - is fresh (port/BotLines' repetition registry: not one of the bot's own last 20, nor one another bot said in this map
//     square in the last 10 minutes or a human heard in the last 45; a pool spent so is silence);
//   - is typed in the speaker's style (port/BotStyle: its abbreviations and typos; a styled line the 274 filter would
//     change falls back to the line as written), with no "*correction" after it;
//   - carries the piece's LineKind ('setpiece', 'scam': the humanlike report keeps them out of H7 and reports them as X2);
//   - takes the place of the speaker's next unprompted line (port/BotChatter.countAsBudgetedLine: the talk budget, H7 at
//     10x XP must not rise).
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { NEW_LINES, isFresh, noteSaid, type Line } from '#/engine/bot/port/BotLines.js';
import { botSay, type ChatStyle, type LineKind } from '#/engine/bot/port/BotSay.js';
import { styleLine } from '#/engine/bot/port/BotStyle.js';
import { countAsBudgetedLine } from '#/engine/bot/port/BotChatter.js';
import { botPersona } from '#/engine/bot/port/BotTiming.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';

const pools = new Map<string, readonly Line[]>();

/** The lines of `event` and `kind` (their groups' tags), members' lines only on a members world. */
export function pieceLines(event: string, kind: string): readonly Line[] {
    const members = isMembersWorld();
    const key = `${event}|${kind}|${members}`;
    let pool = pools.get(key);
    if (!pool) {
        pool = NEW_LINES.filter(l => l.tag.event === event && (l.tag.kinds ?? []).includes(kind) && (members || !l.tag.members));
        pools.set(key, pool);
    }
    return pool;
}

/** Any line of `event` and `kind` as written (a rumour for the director to say), or null when there is none. */
export function anyPieceLine(event: string, kind: string, random: () => number = Math.random): string | null {
    const pool = pieceLines(event, kind);
    return pool.length ? pool[Math.floor(random() * pool.length)].text : null;
}

/** A fresh line of `event` and `kind` for the bot here (the registry), as written; null: the pool is spent here. */
export function freshPieceText(bot: Player, event: string, kind: string, random: () => number = Math.random): string | null {
    const pool = pieceLines(event, kind);
    if (!pool.length) return null;
    const now = World.currentTick;
    const start = Math.floor(random() * pool.length);
    for (let i = 0; i < pool.length; i++) {
        const text = pool[(start + i) % pool.length].text;
        if (isFresh(bot.username, text, bot.x, bot.z, bot.level, now)) return text;
    }
    return null;
}

export interface PieceLineOptions {
    /** whom it is said to (the say listeners: a human or a bot) */
    to?: Player | null;
    /** a colour and an effect (a host's call before its party, a scam caller's red: adverts; talk is plain) */
    style?: ChatStyle;
    /** the speaker's style layer (default on) */
    styled?: boolean;
    /** it takes the place of the speaker's next unprompted line (default on) */
    budget?: boolean;
}

/**
 * The bot says a fresh line of `event` and `kind` now, as `lineKind`: the text said, or null (none fresh, or the bot is
 * not in the world).
 */
export function sayPieceLine(bot: Player, event: string, kind: string, lineKind: LineKind, opts: PieceLineOptions = {}): string | null {
    if (bot.slot === -1) return null;
    const text = freshPieceText(bot, event, kind);
    if (text === null) return null;
    return sayPieceText(bot, text, lineKind, opts);
}

/** The bot says this line (one of the pools, or upstream's words) now, as `lineKind`, noted in the registry. */
export function sayPieceText(bot: Player, text: string, lineKind: LineKind, opts: PieceLineOptions = {}): string | null {
    if (bot.slot === -1) return null;
    const said = opts.styled === false ? text : styleLine(text, botPersona(bot)).line;
    botSay(bot, said, opts.style, lineKind, opts.to ?? null);
    // (the variety work, round 1, SAY-14: the line as written, the key freshPieceText checks; the styled one escaped it)
    noteSaid(bot, text);
    if (opts.budget !== false) countAsBudgetedLine(bot);
    return said;
}
