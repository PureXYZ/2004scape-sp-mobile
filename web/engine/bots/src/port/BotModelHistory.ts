// port (the realism work, phase 7: the language model): the lines said lately, so that a model-written reply knows
// what was just said around the bot and between it and the human (port/BotModelPrompt's history). Public lines in a
// ring (every bot's line through port/BotSay's listeners, a human's from port/BotChat.onPublicMessage), private
// messages per bot (both ways), and each bot's own lines of the last 10 minutes (Track E: the guard refuses a model line
// that repeats one, port/BotModelGuard). Pure bookkeeping: no dice, no game effect, so a sim runs the same with it.
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { toDisplayName } from '#/util/JString.js';
import { sayListeners } from '#/engine/bot/port/BotSay.js';
import type { SituationLine } from '#/engine/bot/port/BotModelTypes.js';

/** the public lines kept (the whole world's; a few minutes of a busy one) */
const RING = 512;
/** the private messages kept per bot */
const PM_KEEP = 8;
/** how far back a line still counts (3 minutes) */
const KEEP_TICKS = 300;
/** a line heard within this many tiles (274's chat reaches about as far as the client draws: the bots' earshot is 14) */
const NEAR = 15;
/** the most lines a situation carries */
export const HISTORY_MAX = 8;

interface PublicLine {
    tick: number;
    x: number;
    z: number;
    level: number;
    speaker: Player;
    name: string;
    text: string;
}

interface PrivateLine {
    tick: number;
    human: Player;
    /** the bot wrote it (else the human) */
    fromBot: boolean;
    text: string;
}

const ring: PublicLine[] = [];
let head = 0;
const pms = new WeakMap<Player, PrivateLine[]>();

/** (Track E) a bot's own lines kept for the guard's repeat check: 10 minutes, at most OWN_KEEP */
const OWN_TICKS = 1000;
const OWN_KEEP = 16;
let own = new WeakMap<Player, { tick: number; text: string }[]>();

function noteOwn(bot: Player, text: string): void {
    let list = own.get(bot);
    if (!list) own.set(bot, (list = []));
    list.push({ tick: World.currentTick, text });
    if (list.length > OWN_KEEP) list.splice(0, list.length - OWN_KEEP);
}

/** (Track E) what the bot itself said, public or private, within `ticks` before `now` (default 10 minutes), oldest first */
export function ownLinesOf(bot: Player, now: number = World.currentTick, ticks = OWN_TICKS): string[] {
    const list = own.get(bot);
    if (!list) return [];
    return list.filter(l => now - l.tick <= ticks && l.tick <= now).map(l => l.text);
}

function nameOf(player: Player): string {
    return player.displayName || toDisplayName(player.username);
}

/** A public line someone said (a bot through botSay, a human through BotChat.onPublicMessage). */
export function notePublicLine(speaker: Player, text: string): void {
    const line: PublicLine = { tick: World.currentTick, x: speaker.x, z: speaker.z, level: speaker.level, speaker, name: nameOf(speaker), text };
    if (ring.length < RING) ring.push(line);
    else {
        ring[head] = line;
        head = (head + 1) % RING;
    }
    if (speaker.is_bot === true) noteOwn(speaker, text);
}

/** A private message between a bot and a human, either way. */
export function notePrivateLine(bot: Player, human: Player, text: string, fromBot: boolean): void {
    let list = pms.get(bot);
    if (!list) pms.set(bot, (list = []));
    list.push({ tick: World.currentTick, human, fromBot, text });
    if (list.length > PM_KEEP) list.splice(0, list.length - PM_KEEP);
    if (fromBot) noteOwn(bot, text);
}

/**
 * What the bot heard and said lately, as a situation carries it (oldest first, at most HISTORY_MAX): the public lines
 * near it (the human's line being answered left out: it is the situation's `heard`), or for a private message the
 * thread with that human. `now` is the tick the human's line came.
 */
export function historyFor(bot: Player, human: Player, channel: 'public' | 'private', heard: string, now: number = World.currentTick): SituationLine[] {
    const out: (SituationLine & { tick: number })[] = [];
    if (channel === 'private') {
        for (const line of pms.get(bot) ?? []) {
            if (line.human !== human || now - line.tick > KEEP_TICKS) continue;
            out.push({ tick: line.tick, who: line.fromBot ? 'you' : 'them', name: line.fromBot ? nameOf(bot) : nameOf(human), text: line.text, ago: 0, pm: true });
        }
    } else {
        const ordered = ring.length < RING ? ring : [...ring.slice(head), ...ring.slice(0, head)];
        for (const line of ordered) {
            if (now - line.tick > KEEP_TICKS || line.level !== bot.level) continue;
            if (Math.max(Math.abs(line.x - bot.x), Math.abs(line.z - bot.z)) > NEAR) continue;
            out.push({ tick: line.tick, who: line.speaker === bot ? 'you' : line.speaker === human ? 'them' : 'other', name: line.name, text: line.text, ago: 0 });
        }
    }
    // (the line being answered is the situation's own: the newest of the human's with that text)
    for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].who === 'them' && out[i].text === heard && now - out[i].tick <= 2) {
            out.splice(i, 1);
            break;
        }
    }
    return out.slice(-HISTORY_MAX).map(({ tick, ...line }) => ({ ...line, ago: Math.max(0, Math.round(((now - tick) * 600) / 1000)) }));
}

/** (tests) forget every line */
export function resetModelHistoryForTest(): void {
    ring.length = 0;
    head = 0;
    own = new WeakMap();
}

// every bot's public line (adverts, idle lines, replies, set pieces' calls), as the chat shows it
sayListeners.push((player, line) => notePublicLine(player, line));
