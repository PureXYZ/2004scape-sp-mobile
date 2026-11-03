// port (bots ideas, round 2, theme D: word that travels, D3): phrases that spread, bots' own only. Before, each bot's two or three catchphrases were fixed from its name
// (port/BotLines catchphrasesOf, the 46 of data/lines2004-variety.json) and nothing spread: a hub's regulars never sounded
// like each other.
//
//   Carriers: only bots' catchphrases (port/BotLines CATCHPHRASE_LIST, filter-checked), never new text and never the
//   human's lines: the 'said' event (port/BotArcsEvents) comes only from port/BotSay, whose speakers are bots (phrases
//   spread only between bots).
//   Adoption: a bot hearing another bot's catchphrase within 15 tiles on its floor, one not its own, adopts it with chance
//   0.03 x (0.5 + sociability) x (2 for a clique mate or an acquaintance of 2+: port/BotTies). At most 2 borrowed a bot
//   (the strongest, then the latest, kept: port/BotArcsStore trimArcs). Strength 9 at adoption, +2 when heard again (at
//   most 9), -1 per 30 minutes of play unsaid and unheard (lazily), gone at 0. Saved with the arcs (`phrases`), so a hub
//   keeps its slang across restarts.
//   Use: port/BotLines catchphrasesOf returns its own and its borrowed (its block); a borrowed phrase weighs its
//   strength's share of a catchphrase's (x strength / 9). The same idle slot: no line is added.
//
// Dice: theme D's own (port/BotWordHooks wordRoll, seeded from Math.random). No wall clock: the arcs' play clock. Per
// tick nothing; a catchphrase said (about 80 an hour world-wide at 500 bots) is one zone scan of 15 tiles.
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { arcsPlay, arcsTie, onArcs, registerArcsTick } from '#/engine/bot/port/BotArcsEvents.js';
import { arcsEntries, arcsOf, peekArcs, trimArcs, type PhraseRecord } from '#/engine/bot/port/BotArcsStore.js';
import { sameClique } from '#/engine/bot/port/BotCliques.js';
import { CATCHPHRASE_LIST, catchphrasesOf } from '#/engine/bot/port/BotLines.js';
import { botPersona } from '#/engine/bot/port/BotTiming.js';
import { wordHooks, wordRandInt, wordRoll } from '#/engine/bot/port/BotWordHooks.js';

/** a catchphrase heard within this many tiles on its floor may be adopted */
export const HEAR_TILES = 15;
/** the adoption's chance: ADOPT x (0.5 + sociability) x FRIEND for a clique mate or an acquaintance of 2+ */
export const ADOPT = 0.03;
export const FRIEND = 2;
/** a borrowed phrase's strength at adoption (the most), its gain when heard again, its step's decay (30 minutes of play) */
export const STRENGTH = 9;
export const HEARD_AGAIN = 2;
export const DECAY_TICKS = 3000;

const DEFAULT_RATES = { on: true, adopt: ADOPT, friend: FRIEND };
/** the rates in use (tests change them: setSlangForTest) */
export const slangRates = { ...DEFAULT_RATES };
/** Tests only: other rates or slang off (null: the defaults). Never set by the game. */
export function setSlangForTest(rates: Partial<typeof DEFAULT_RATES> | null): void {
    Object.assign(slangRates, DEFAULT_RATES, rates ?? {});
}

/** what spread (the humanlike runner's WT7, the tests) */
export const slangStats = { heard: 0, adopted: 0, again: 0, said: 0, saidBorrowed: 0, faded: 0 };
/** the adoptions, newest last (capped): { t, name, phrase, from, x, z } */
export const slangLog: { t: number; name: string; phrase: number; from: string; x: number; z: number }[] = [];
/** Tests only: the counts and the log forgotten (the saved phrases are port/BotArcsStore's). */
export function resetSlangForTest(): void {
    slangLog.length = 0;
    for (const k of Object.keys(slangStats) as (keyof typeof slangStats)[]) slangStats[k] = 0;
}

/** a borrowed phrase's strength now (its stored one less a step for each 30 minutes since it was last said or heard) */
function effective(p: PhraseRecord, play: number): number {
    return Math.max(0, p.strength - Math.max(0, Math.floor((play - p.last) / DECAY_TICKS)));
}

/** the catchphrases of its own (from its name), as CATCHPHRASE_LIST indexes */
function ownPhrases(bot: Player): number[] {
    return catchphrasesOf(bot.username, botPersona(bot))
        .filter(l => !l.borrowed && l.phrase !== undefined && l.phrase >= 0)
        .map(l => l.phrase!);
}

/** the bots within `r` tiles of (x, z) on `level` (the zones there), not `except` */
function botsWithin(x: number, z: number, level: number, r: number, except: Player): Player[] {
    const out: Player[] = [];
    for (let zx = (x - r) >> 3; zx <= (x + r) >> 3; zx++) {
        for (let zz = (z - r) >> 3; zz <= (z + r) >> 3; zz++) {
            for (const p of World.gameMap.getZone(zx << 3, zz << 3, level).getAllPlayersSafe()) {
                if (p !== except && p.is_bot === true && p.slot !== -1 && p.level === level && Math.max(Math.abs(p.x - x), Math.abs(p.z - z)) <= r) out.push(p);
            }
        }
    }
    return out;
}

/** a bot said a catchphrase: its own borrowed one stays fresh; the bots near hear it */
function said(speaker: Player, phrase: number): void {
    if (!slangRates.on || speaker.is_bot !== true || CATCHPHRASE_LIST[phrase] === undefined) return;
    const play = arcsPlay();
    slangStats.said++;
    const mine = peekArcs(speaker.username)?.phrases?.find(p => p.phrase === phrase);
    if (mine) {
        mine.strength = Math.max(1, effective(mine, play));
        mine.last = play;
        slangStats.saidBorrowed++;
    }
    for (const hearer of botsWithin(speaker.x, speaker.z, speaker.level, HEAR_TILES, speaker)) heard(hearer, speaker, phrase, play);
}

function heard(hearer: Player, speaker: Player, phrase: number, play: number): void {
    slangStats.heard++;
    const rec = peekArcs(hearer.username);
    const had = rec?.phrases?.find(p => p.phrase === phrase);
    if (had) {
        had.strength = Math.min(STRENGTH, effective(had, play) + HEARD_AGAIN);
        had.last = play;
        slangStats.again++;
        return;
    }
    if (ownPhrases(hearer).includes(phrase)) return;
    const friend = sameClique(hearer.username, speaker.username) || (arcsTie(hearer.username, speaker.username)?.acquaintance ?? 0) >= 2;
    const chance = slangRates.adopt * (0.5 + botPersona(hearer).sociability) * (friend ? slangRates.friend : 1);
    if (wordRoll() >= chance) return;
    const r = arcsOf(hearer.username);
    // (the faded ones first out: a new one replaces the weakest, then the oldest, past 2)
    if (r.phrases) r.phrases = r.phrases.filter(p => effective(p, play) > 0);
    (r.phrases ??= []).push({ phrase, strength: STRENGTH, last: play });
    trimArcs(r);
    slangStats.adopted++;
    slangLog.push({ t: World.currentTick, name: hearer.username, phrase, from: speaker.username, x: hearer.x, z: hearer.z });
    if (slangLog.length > 5000) slangLog.shift();
}

/** port/BotLines catchphrasesOf's block: the bot's borrowed phrases now and their weights (strength / 9) */
export function borrowedPhrases(name: string): readonly { phrase: number; weight: number }[] {
    if (!slangRates.on) return [];
    const list = peekArcs(name)?.phrases;
    if (!list || list.length === 0) return [];
    const play = arcsPlay();
    const out: { phrase: number; weight: number }[] = [];
    for (const p of list) {
        const s = effective(p, play);
        if (s > 0) out.push({ phrase: p.phrase, weight: s / STRENGTH });
    }
    return out;
}

/** the phrases faded to 0 dropped (every 10 minutes of play: the store keeps only live ones) */
function sweep(play: number): void {
    for (const [, rec] of arcsEntries()) {
        if (!rec.phrases) continue;
        const kept = rec.phrases.filter(p => effective(p, play) > 0);
        if (kept.length === rec.phrases.length) continue;
        slangStats.faded += rec.phrases.length - kept.length;
        if (kept.length) rec.phrases = kept;
        else delete rec.phrases;
    }
}

onArcs('said', e => {
    if (e.catchphrase !== undefined && e.catchphrase >= 0) said(e.bot, e.catchphrase);
});
registerArcsTick((_now, play) => sweep(play), 1000);
wordHooks.borrowedPhrases = borrowedPhrases;
