// port (bots ideas, round 2: the arcs foundation): one
// bus for what happens to bots, for theme C (lives with arcs: goals, moods, leaving, 99 parties, whims, weddings) and
// theme D (word that travels: rumours, ties, slang, clique timing), so their modules hear the game's moments without
// editing the sites, or each other, again. The sites, each a marked block "(bots ideas, round 2: arcs foundation)":
//   levelup        port/BotChatter.chatterLevelUp (BotPlayer.onLevelUp): every base level a bot gains
//   event          port/BotChatter.noteEvent: every event noted (death, wild-death, close-call, drop, rune-drop, big-bones,
//                  rock-stolen, tree-taken, arrival, login ...), with its data
//   death          port/BotFumble.noteDeath (the respawn port/BotChatter sees): every bot's death, PKers' too, Wilderness or not
//   kill           tasks/PKerTask, tasks/EdgevillePKerTask: a PKer's kill (its victim a bot or the human)
//   steal          port/BotRude: a kill- or rock-steal incident as recorded (`again`: a noticed one that turned out meant)
//   duel           port/BotDuel: a duel's end, once (the winning bot's side, or the losing bot's when a human won)
//   said           port/BotSay.sayLine: every line a bot says, as shown (after the filter), with its kind; a catchphrase's
//                  index (port/BotLines CATCHPHRASE_LIST), and what sayArcLine's caller tagged it with (`arc`)
//   login, logout  BotManager._cameOnline (its session drawn) / _wentAway
//   set-piece      port/BotDirector: a run's begin, each phase it moves to, its finish ('done')
//   C's own kinds (D listens): goal-done, tilt, ninety-nine-near, ninety-nine, own-party, wedding (the
//   interfaces between C and D, through this bus only, no imports either way)
// A listener's throw is logged (port/BotLog: counted in the bots' errors) and never reaches the site. With no listener an
// emit is a map lookup: nothing changes (test/identity.mjs: the foundation is behaviour-neutral).
//
// Ticks: registerArcsTick(fn, every) runs fn(now, play) every `every` play ticks, from BotManager.tick with a human in the
// world, after the cliques (tickArcs). The play clock for the arcs: arcsPlay() (BotManager's play ticks; a test may hold
// it at a value: setArcsPlayForTest).
//
// What C and D ask of each other goes through here too: D provides tieOf and knowsRumour, C moodOf
// (provideArcs at their modules' load); the other asks arcsTie, arcsKnows, arcsMood, which answer null or false while the
// provider is not there (each theme builds and tests alone) and log a provider's throw.
//
// Bots only: an event is about a bot's own moment; the human appears only as the other side of one (a kill's victim, a
// steal's victim or stealer, a duel's partner: `is_bot` tells). Ties, grudges, goals and phrases stay bots only (never
// toward the human, never learned from the human's words: 'said' comes only from BotSay, whose speakers are bots).
// A leaf module: type imports, the log and the engine's stat names only (no import cycle).
import type Player from '#/engine/entity/Player.js';
import { PlayerStatNameMap } from '#/engine/entity/PlayerStat.js';
import type { GoalRecord } from '#/engine/bot/port/BotArcsStore.js';
import { botConsole } from '#/engine/bot/port/BotLog.js';
import type { Incident } from '#/engine/bot/port/BotRude.js';
import type { LineKind } from '#/engine/bot/port/BotSay.js';
import type { SetPiecePhase, SetPieceRun } from '#/engine/bot/port/BotSetPieces.js';

/** what a line said through sayArcLine is about (theme D: a rumour's kind and id, so a bot that hears it learns which) */
export interface ArcTag {
    kind: string;
    id?: number | string;
}

/** what the 'said' event carries besides the line (port/BotSay botSay's last argument) */
export interface SaidTags {
    /** its index in port/BotLines' CATCHPHRASE_LIST: a catchphrase (the bot's own, or one it borrowed) */
    catchphrase?: number;
    arc?: ArcTag;
}

/** a place an event is at (a 99's spot, a party's venue) */
export interface ArcsVenue {
    x: number;
    z: number;
    level: number;
    /** how a bot names it ("fally park", "the willows"), when known */
    say?: string;
}

export type ArcsEvent =
    | { k: 'levelup'; bot: Player; stat: number; skill: string; level: number; milestone: boolean } // skill: PlayerStatNameMap's ('WOODCUTTING')
    | { k: 'event'; bot: Player; name: string; item?: string; kind?: string; level?: number; stat?: string }
    | { k: 'death'; bot: Player; wild: boolean }
    | { k: 'kill'; killer: Player; victim: Player; edge: boolean }
    | { k: 'steal'; incident: Incident; stealer: Player; victim: Player; again?: boolean }
    | { k: 'duel'; winner: Player; loser: Player; stake: number }
    | { k: 'said'; bot: Player; text: string; kind?: LineKind; to?: Player | null; catchphrase?: number; arc?: ArcTag }
    | { k: 'login'; name: string; bot: Player | null }
    | { k: 'logout'; name: string; bot: Player | null }
    | { k: 'set-piece'; run: SetPieceRun; phase: SetPiecePhase }
    // ---- theme C's own (it emits them, D listens; `detail` for anything more, so neither edits this type) ----
    | { k: 'goal-done'; bot: Player; goal: GoalRecord; detail?: Record<string, unknown> }
    | { k: 'tilt'; bot: Player; tilt: number; detail?: Record<string, unknown> }
    | { k: 'ninety-nine-near'; bot: Player; stat: number; venue: ArcsVenue; detail?: Record<string, unknown> }
    | { k: 'ninety-nine'; bot: Player; stat: number; venue?: ArcsVenue; detail?: Record<string, unknown> }
    | { k: 'own-party'; run: SetPieceRun; host?: Player; detail?: Record<string, unknown> }
    | { k: 'wedding'; run: SetPieceRun; couple: readonly [Player, Player]; detail?: Record<string, unknown> };

export type ArcsKind = ArcsEvent['k'];
export type ArcsEventOf<K extends ArcsKind> = Extract<ArcsEvent, { k: K }>;
type Listener = (e: ArcsEvent) => void;

const listeners = new Map<ArcsKind, readonly Listener[]>();

/** Listens to events of kind `k` (in the order they listen). Returns the way to stop. */
export function onArcs<K extends ArcsKind>(k: K, fn: (e: ArcsEventOf<K>) => void): () => void {
    const wrapped = fn as Listener;
    listeners.set(k, [...(listeners.get(k) ?? []), wrapped]);
    return () => {
        const list = (listeners.get(k) ?? []).filter(f => f !== wrapped);
        if (list.length) listeners.set(k, list);
        else listeners.delete(k);
    };
}

/** Does anything listen to kind `k`? (a site may skip building an event nobody hears) */
export function arcsWanted(k: ArcsKind): boolean {
    return listeners.has(k);
}

/** An event to its listeners. Guarded: a listener's throw is logged, never reaches the caller (the site). */
export function emitArcs(e: ArcsEvent): void {
    const list = listeners.get(e.k);
    if (!list) return;
    for (const fn of list) {
        try {
            fn(e);
        } catch (err) {
            botConsole.error(`[BotArcs] a listener to '${e.k}' failed`, err);
        }
    }
}

/** the listeners of kind `k` (tests) */
export function arcsListenerCount(k: ArcsKind): number {
    return listeners.get(k)?.length ?? 0;
}

// ── the ticks ────────────────────────────────────────────────────────────────────────────────────────────────────

interface ArcsTick {
    fn: (now: number, play: number) => void;
    every: number;
}
let ticks: readonly ArcsTick[] = [];

/** fn(now, play) every `every` play ticks (a co-presence pass, a mood's look ...), with a human in the world. Returns the way to stop. */
export function registerArcsTick(fn: (now: number, play: number) => void, every: number): () => void {
    const t: ArcsTick = { fn, every: Math.max(1, Math.floor(every)) };
    ticks = [...ticks, t];
    return () => {
        ticks = ticks.filter(x => x !== t);
    };
}

/** BotManager.tick, with a human in the world, after the cliques: the registered passes that are due (each guarded). */
export function tickArcs(now: number, play: number): void {
    for (const t of ticks) {
        if (play % t.every !== 0) continue;
        try {
            t.fn(now, arcsPlay());
        } catch (err) {
            botConsole.error('[BotArcs] a tick failed', err);
        }
    }
}

// ── the play clock ───────────────────────────────────────────────────────────────────────────────────────────────

let playSource: () => number = () => 0;
let heldPlay: number | null = null;

/** the play clock the arcs keep their times in: BotManager's play ticks (world ticks with a human in the world) */
export function arcsPlay(): number {
    return heldPlay ?? playSource();
}

/** BotManager.start: where the play clock is read */
export function setArcsPlaySource(fn: () => number): void {
    playSource = fn;
}

/** Tests only: the arcs' play clock held at `play` (null: BotManager's again). Never called by the game. */
export function setArcsPlayForTest(play: number | null): void {
    heldPlay = play;
}

// ── what C and D ask of each other (through the foundation only, no imports either way) ──────────────

/** the themes' answers to each other: each provides its own (provideArcs) when its module loads; absent until it merges */
export interface ArcsServices {
    /** theme D (port/BotTies): bot a's tie to bot b by name, its acquaintance strength (0-9, known from 2) and grudge (0-5) */
    tieOf?(a: string, b: string): { acquaintance: number; grudge: number } | null;
    /** theme D (port/BotRumours): does the bot know a rumour of this kind now ('party', 'pk', 'rocks', 'drop' ...)? */
    knowsRumour?(bot: Player, kind: string): boolean;
    /** theme C (port/BotMoods): the bot's moods now, each 0-1 */
    moodOf?(bot: Player): { tilt: number; elation: number; boredom: number } | null;
}
const services: ArcsServices = {};

/** A theme provides its answer (the last one provided counts). */
export function provideArcs<K extends keyof ArcsServices>(name: K, fn: NonNullable<ArcsServices[K]> | null): void {
    if (fn === null) delete services[name];
    else services[name] = fn as ArcsServices[K];
}

function asked<T>(what: string, fn: (() => T) | null, none: T): T {
    if (fn === null) return none;
    try {
        return fn();
    } catch (err) {
        botConsole.error(`[BotArcs] ${what} failed`, err);
        return none;
    }
}

/** theme D's tie between two bots (null: none known, or D is not there) */
export function arcsTie(a: string, b: string): { acquaintance: number; grudge: number } | null {
    const fn = services.tieOf;
    return asked('tieOf', fn ? () => fn(a, b) ?? null : null, null);
}

/** theme D's word: does the bot know a rumour of `kind` (false: no, or D is not there) */
export function arcsKnows(bot: Player, kind: string): boolean {
    const fn = services.knowsRumour;
    return asked('knowsRumour', fn ? () => fn(bot, kind) === true : null, false);
}

/** theme C's moods of the bot (null: none, or C is not there) */
export function arcsMood(bot: Player): { tilt: number; elation: number; boredom: number } | null {
    const fn = services.moodOf;
    return asked('moodOf', fn ? () => fn(bot) ?? null : null, null);
}

// ── helpers for the sites ────────────────────────────────────────────────────────────────────────────────────────

let statIndex: Map<string, number> | null = null;
/** a stat's number (PlayerStat) from the name port/BotPlayer.onLevelUp gives (PlayerStatNameMap), -1 for none */
export function statIndexOf(name: string): number {
    if (statIndex === null) {
        statIndex = new Map();
        for (const [i, n] of PlayerStatNameMap) statIndex.set(n, i);
    }
    return statIndex.get(name) ?? -1;
}
