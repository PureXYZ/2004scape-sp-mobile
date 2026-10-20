// port (the variety work, round 2, Track S2: P5's cap on one voice):
// no bot is more than about a fifth of a place's talk in an hour. The investigation heard one social regular say 43 of the
// 106 lines a human heard at Draynor in 2 hours, and an Edgeville PKer 18 of 47 at the ditch in an hour: a voice that
// dominates a place reads as a script, however varied its words.
//
// Every non-trade line a bot says (port/BotSay notes it: not adverts or trade talk, not a set piece's own calls) goes into
// a ledger of the last hour, by 16-tile cell. Before an optional line (a social regular's greeting or small talk, an
// unprompted idle line, a thread's opening, a PK taunt, a witness's word, a clique's banter) the speaker asks voiceFree:
// the lines said within 15 tiles of it in the last hour (274's view), at a place of VOICE_SPEAKERS speakers or more (a
// hub's talk, not two woodcutters alone at their trees), its own lines with this one over VOICE_SHARE of the place's
// hour (taken as VOICE_EXPECT lines at least, a fair share of its speakers' at least): it says nothing this time. Answers (to a human or a bot), a thread's later turns, its own
// deaths and level-ups are never held: they are not its choice.
// (The round's fixes: B4, a crowd's answer, gz or witness is drawn first and the cap checked on the one drawn, voiceRoom
// uncounted for a pick another may take; B7, the players standing within 15 tiles now count among the place's voices
// with those who spoke in the hour; B2, an errand's word on the way is one of the optional lines.)
//
// No imports from the library (port/BotSay notes every line here, and BotSay is imported by most of it); no dice: a pure
// count. Per line said, a push; per check, a walk over nine cells' lists (an hour of a busy place at 500 bots: a few
// hundred entries).
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';

/** the share of a place's talk in an hour one bot may have (the plan: about 20 %) */
export const VOICE_SHARE = 0.2;
/**
 * the cap holds at a place of this many speakers in its hour (a hub's talk: two woodcutters alone at their trees talk as
 * they like), its hour taken as this many lines at least (a busy hub's at 100 online: 30-40)
 */
export const VOICE_SPEAKERS = 4;
export const VOICE_EXPECT = 25;
/** the ledger's window: an hour of play */
const VOICE_TICKS = 6000;
/** a cell's side (tiles) */
const CELL = 16;

interface Said {
    tick: number;
    name: string;
    x: number;
    z: number;
}
/** a place's talk: the lines said within this of the speaker (274's view: what a player standing there sees) */
const PLACE = 15;

const cells = new Map<string, Said[]>();
let lastPrune = 0;

function cellKey(cx: number, cz: number, level: number): string {
    return `${cx}_${cz}_${level}`;
}

/** (port/BotSay) a non-trade line `name` said at (x, z, level) now */
export function noteVoice(name: string, x: number, z: number, level: number, now: number = World.currentTick): void {
    const key = cellKey(x >> 4, z >> 4, level);
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push({ tick: now, name, x, z });
    if (now - lastPrune >= 600) {
        lastPrune = now;
        for (const [k, l] of cells) {
            let i = 0;
            while (i < l.length && now - l[i].tick >= VOICE_TICKS) i++;
            if (i === l.length) cells.delete(k);
            else if (i > 0) l.splice(0, i);
        }
    }
}

/** the lines said around (x, z, level) in the last hour, how many of them were `name`'s, and by how many speakers */
export function voiceAt(name: string, x: number, z: number, level: number, now: number = World.currentTick): { total: number; own: number; speakers: number } {
    const cx = x >> 4;
    const cz = z >> 4;
    let total = 0;
    let own = 0;
    // (the speakers: a few names, an array's linear search is cheaper than a Set's allocation)
    const who: string[] = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            const list = cells.get(cellKey(cx + dx, cz + dz, level));
            if (!list) continue;
            for (let i = list.length - 1; i >= 0; i--) {
                const s = list[i];
                if (now - s.tick >= VOICE_TICKS) break;
                if (Math.max(Math.abs(s.x - x), Math.abs(s.z - z)) > PLACE) continue;
                total++;
                if (s.name === name) own++;
                else if (who.length < VOICE_SPEAKERS + 1 && !who.includes(s.name)) who.push(s.name);
            }
        }
    }
    // (its own counted among them when it spoke; the count stops at VOICE_SPEAKERS + 1: only "enough" matters)
    return { total, own, speakers: who.length + (own > 0 ? 1 : 0) };
}

/**
 * May `bot` say an optional line here now (`lines`: or its share of a thread's)? Not at a place of VOICE_SPEAKERS
 * speakers or more in the last hour where its lines would be over VOICE_SHARE of the hour's (VOICE_EXPECT at least).
 * A line the cap holds is counted (voiceHeldCount); voiceRoom is the same rule uncounted.
 */
export function voiceFree(bot: Player, now: number = World.currentTick, lines = 1): boolean {
    if (voiceRoom(bot, now, lines)) return true;
    voiceHeld++;
    return false;
}

/**
 * (the variety work, round 2, the fixes: B4) voiceFree's rule without counting a held line: for a pick that another bot
 * may take instead (a thread's partner, one of a crowd drawn again: port/BotChat, port/BotWitness), whose line is held
 * only when none is left (noteVoiceHeld).
 * (B7: the players standing here now count among the place's voices, not only those who spoke in the hour: a regular
 * among a dozen quiet players, three of whom spoke, had a third of the hour's talk as its "fair share" and four in ten
 * of it was no cap at all; W8's top voice at the quiet places, 32-34 lines an hour, was 27.5-29.3 %. Counted only past a
 * fifth of the hour, so the common case is the ledger's walk alone.)
 */
export function voiceRoom(bot: Player, now: number = World.currentTick, lines = 1): boolean {
    if (voiceCapOff) return true;
    const { total, own, speakers } = voiceAt(bot.username, bot.x, bot.z, bot.level, now);
    // (`lines`: what it is about to say, a thread's share of its turns too. Its room: a fifth of the place's hour, the hour
    // taken as VOICE_EXPECT lines at least (a regular's greetings in the hour's first minutes, before the place's talk
    // filled it, were a third of it by its end), a fair share of its voices' at least)
    if (own + lines <= VOICE_SHARE * Math.max(total + lines, VOICE_EXPECT)) return true;
    // (five voices or more: a fair share is a fifth or less)
    if (speakers > VOICE_SPEAKERS) return false;
    const voices = Math.max(speakers, playersNear(bot, VOICE_SPEAKERS + 1));
    if (voices < VOICE_SPEAKERS) return true;
    return own + lines <= (total + lines) / voices;
}

/** (B7) the players within PLACE of `bot` on its floor now, itself among them, counted up to `limit` */
function playersNear(bot: Player, limit: number): number {
    let n = 0;
    for (const p of World.playerLoop.all()) {
        if (p.level !== bot.level || Math.max(Math.abs(p.x - bot.x), Math.abs(p.z - bot.z)) > PLACE) continue;
        if (++n >= limit) break;
    }
    return n;
}

/** (the humanlike runner, tests) the optional lines the cap held so far */
let voiceHeld = 0;
export function voiceHeldCount(): number {
    return voiceHeld;
}
/** (B4) a line the cap held after its picks (voiceRoom) found nobody under it */
export function noteVoiceHeld(): void {
    voiceHeld++;
}

/** Tests only: the cap off (true) or on; and the ledger forgotten. Never called by the game. */
let voiceCapOff = false;
export function setVoiceCapForTest(off: boolean): void {
    voiceCapOff = off;
}
export function resetVoiceForTest(): void {
    cells.clear();
    lastPrune = 0;
}

/** CELL is the shift's side (x >> 4): kept for the docs' sake */
export const VOICE_CELL = CELL;
