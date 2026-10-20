// Everything a bot says, overhead and in the chatbox. port: as a typed line, the CHAT mask: the
// client shows it as a player's line, in sentence case and through its own word filter, and not at all from a player
// on the human's ignore list; adverts can have a colour and an effect. Upstream used Player.say (the SAY mask), which
// the client shows as it is and ignore cannot hide. A human's line is filtered on the server too
// (MessagePublicHandler: WordEnc.filter, then WordPack), so every bot line goes through the same two steps here.
import WordEnc from '#/cache/wordenc/WordEnc.js';
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import Packet from '#/io/Packet.js';
import { PlayerInfoProt } from '#/network/rsbuf/index.js';
import WordPack from '#/wordenc/WordPack.js';
import { scheduleInTicks } from '#/engine/bot/port/BotSchedule.js';
// (the variety work, round 2, Track S2: P5's cap on one voice: every non-trade line goes into the place's ledger)
import { noteVoice } from '#/engine/bot/port/BotVoice.js';

/**
 * port: the most a line holds: 274's client sends at most 80 characters (WordPack) and its chatbox shows about that
 * many; a longer line (a vendor's trade instructions ran to 150) is said in parts, a couple of ticks apart.
 */
export const MAX_LINE = 80;

/** port: a typed line's look: colour 0-11 (yellow, red, green, cyan, purple, white, flash1-3, glow1-3), effect 0-2 (none, wave, scroll) */
export interface ChatStyle {
    colour?: number;
    effect?: number;
}

/**
 * port: what kind of line it is (the realism work): who says it and why, for the humanlike report and the chat's own
 * bookkeeping. Optional: a line without one is told to the listeners without one.
 */
export type LineKind =
    | 'idle' // something said unprompted (upstream's idle lines, the 2004 lines)
    | 'event' // about something that just happened to it (a death, a drop, a full pack, arriving somewhere)
    | 'levelup' // its own level-up
    | 'newbie' // a newbie newcomer's question or beg
    | 'reply' // an answer to a human
    | 'botreply' // an answer to another bot, or a gz/ty between bots
    | 'practice' // a turn of a short exchange between bots (a price check, a level compare)
    | 'reaction' // unprompted, to a human near it (gz on their level-up, "u following me?")
    | 'brb' // going away for a moment, or back
    | 'departure' // leaving the game
    | 'social' // a social bot's own lines
    | 'trade' // adverts, trade talk, the marketplace
    | 'pk' // PK taunts, gl, kill lines
    // (the variety work, round 2, the fixes: B2; the humanlike runner counts it as chatter, in H7)
    | 'errand' // an errand's word on the way ("where do i get an egg", port/BotErrandLines): routine talk, not a set piece
    // (the realism work's phase 5b: set pieces; the humanlike runner keeps these out of H7, as trade, and reports them)
    | 'setpiece' // a set piece's own calls: a stake, a party's countdown, a spectator's shout, a clan walk's word
    | 'rumour' // word of mouth about a set piece elsewhere ("drop party at fally park!!")
    | 'scam' // a scam caller's call (talk only)
    | 'mod'; // the player-mod bot's duty lines

/**
 * port: told of every line a bot says, as it is shown (after the filter), with its kind and whom it answers (a human or
 * a bot) when the caller gave them; for the tests (the humanlike report)
 */
/** (variety round 2, S2) the kinds that are no part of a place's talk (port/BotVoice): trade, and the set pieces' own lines */
const ASIDE_KINDS: ReadonlySet<LineKind> = new Set<LineKind>(['trade', 'setpiece', 'rumour', 'scam', 'mod']);

export const sayListeners: ((player: Player, line: string, kind?: LineKind, to?: Player | null) => void)[] = [];

/** port: a line in parts of at most MAX_LINE characters, cut after a sentence where one ends late enough, else at a space */
export function splitLine(text: string): string[] {
    const parts: string[] = [];
    let rest = text.trim();
    while (rest.length > MAX_LINE) {
        let cut = -1;
        for (const m of rest.slice(0, MAX_LINE + 1).matchAll(/[.!?](?=\s)/g)) cut = m.index! + 1;
        if (cut < 20) cut = rest.lastIndexOf(' ', MAX_LINE);
        if (cut <= 0) cut = MAX_LINE;
        parts.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) parts.push(rest);
    return parts;
}

/**
 * port (the realism work): the tick each bot last said a line of chat (any kind but trade talk): who is at the keyboard
 * (port/BotChat: a bot chatting lately answers sooner than one grinding in silence)
 */
const lastChat = new WeakMap<Player, number>();
export function lastChatAt(player: Player): number {
    return lastChat.get(player) ?? -Infinity;
}

// Bots repeat themselves (a vendor's advert every few ticks) and the filter is the costliest part of a bot's turn, so
// the filtered text of recent distinct lines is kept (the oldest goes first). port: 4,096 (256 thrashed with 100 bots
// and more: the filter was 7 to 17% of the bots' time, and a 4,096-line cache cut a sim's run by 63%)
const MAX_REMEMBERED = 4096;
const filtered = new Map<string, string>();

export function botSay(player: Player, text: string, style?: ChatStyle, kind?: LineKind, to?: Player | null): void {
    const [first, ...more] = splitLine(text);
    if (first === undefined) return;
    sayLine(player, first, style, kind, to);
    more.forEach((part, i) =>
        scheduleInTicks(2 * (i + 1), () => {
            // (still in the world: a bot that logged out, or out and back in, is another Player)
            if (player.slot !== -1 && player.is_bot) sayLine(player, part, style, kind, to);
        })
    );
}

function sayLine(player: Player, text: string, style?: ChatStyle, kind?: LineKind, to?: Player | null): void {
    // port (the realism work): one line a tick shows (a player update carries one chat message: the second would hide
    // the first, which the listeners still counted); a typed reply, the chatter and a "brb" can meet: the later waits
    if ((player.masks & PlayerInfoProt.CHAT) !== 0) {
        scheduleInTicks(1, () => {
            if (player.slot !== -1 && player.is_bot) sayLine(player, text, style, kind, to);
        });
        return;
    }
    let line = filtered.get(text);
    if (line === undefined) {
        line = WordEnc.filter(text);
        if (filtered.size >= MAX_REMEMBERED) filtered.delete(filtered.keys().next().value!);
        filtered.set(text, line);
    }
    // as MessagePublicHandler does for a human's line (but no logMessage: that is the human's chat log)
    const out = Packet.alloc(0);
    WordPack.pack(out, line);
    const packed = new Uint8Array(out.pos);
    out.pos = 0;
    out.gdata(packed, 0, packed.length);
    out.release();
    player.chatColour = style?.colour ?? 0;
    player.chatEffect = style?.effect ?? 0;
    // (the engine's rule, MessagePublicHandler: a staff member's crown; 0 for every bot but the player-mod bot of phase 5b,
    // whose staffModLevel 1 shows the silver crown)
    player.chatRights = Math.min(player.staffModLevel, 2);
    player.chatMessage = packed;
    player.masks |= PlayerInfoProt.CHAT;
    if (kind !== undefined && kind !== 'trade') lastChat.set(player, World.currentTick);
    // (variety round 2, S2: a place's talk, for its voices' shares: port/BotVoice; trade and the set pieces' own calls apart)
    if (kind === undefined || !ASIDE_KINDS.has(kind)) noteVoice(player.username, player.x, player.z, player.level);
    for (const listener of sayListeners) listener(player, line, kind, to);
}
