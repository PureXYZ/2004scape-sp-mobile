// port (the variety work, round 2, Track M: members places and minigames, research
// the research): the far towns' outings and the members minigames, their registry and logs.
//
//   - Who is out: a bot on an outing to a far town (Yanille's ogres or watchmen, Karamja's jogres, Burthorpe's guards,
//     Rellekka's lobsters, Shilo's river) or at a minigame (the Fishing Trawler, the Brimhaven Agility
//     Arena, the Ranging Guild's competition, a Treasure Trail): registered while it is, so the planner's hook
//     (port/BotMinigames) keeps the number out to the far budget and the humanlike runner sees who is where.
//   - The far budget scales with N ("at 100 bots about 3 at a time in far towns and
//     minigames, a real presence at 250/500"): FAR_PER_100 x (N / 100)^FAR_EXP bots out at once (4 at 100, 13 at 250, 30
//     at 500). Out counts from the plan's start, the walk there too: 4 out at 100 is about 2-3 in the far towns and
//     minigames at a time (FT1). A Treasure Trail is mostly walked in the towns near the hubs: it has a cap of its own
//     (TRAIL_PER_100).
//   - The lines: data/lines2004-members.json's groups (event 'members', a kind per moment: 'outing-go-yanille',
//     'trawler-call', 'arena-tag' ...), said through port/BotPieceLines (fresh, in the speaker's style, kind 'setpiece':
//     out of H7, counted as X2, and in the place of the speaker's next unprompted line). No bot is ever noted with the
//     event 'members', so the chatter never picks them as idle talk.
//   - The logs: each outing and minigame visit (its key, start, end, how it ended), the minigames' counts (visits, crews,
//     rounds, tickets, caskets): the tests and the runner's FT2, MG2.
//
// No task imports here (the tasks import this module; port/BotMinigames has the catalogue and the hook): no cycle.
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { sayPieceLine } from '#/engine/bot/port/BotPieceLines.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';

/** the minigames' task kinds (their tasks' names): MG1's time, FT1's "on a minigame wherever it is" */
export const MINIGAME_KINDS: readonly string[] = ['Trawler', 'AgilityArena', 'RangingGuild', 'TreasureTrail'];

/** the far budget: FAR_PER_100 bots out at 100 online, growing as (N / 100)^FAR_EXP */
export const FAR_PER_100 = 4;
export const FAR_EXP = 1.25;
/** Treasure Trails under way at once, per 100 online (at least 1) */
export const TRAIL_PER_100 = 1;

export type OutingKind = 'outing' | 'minigame' | 'trail';

export interface OutingEntry {
    key: string;
    town: string;
    kind: OutingKind;
    name: string;
    start: number;
    /** -1 while it lasts */
    end: number;
    /** 'done', 'time', 'bank', 'interrupted', 'logout' ... */
    outcome: string;
}

interface Out {
    entry: OutingEntry;
    player: Player;
}

/** the bots out now */
const out = new Map<Player, Out>();

const LOG_MAX = 3000;
/** every outing and visit begun, oldest first (a capped ring): the tests and the runner */
export const outingLog: OutingEntry[] = [];

/** the minigames' counts (the runner's MG2): visits begun, and what each has besides (crews, rounds, tickets, caskets) */
const stats = new Map<string, Record<string, number>>();

/** (tests) the budget's own N, or null: BotManager's */
let budgetN: number | null = null;
/** (tests) the planner's offers this many times as often (0: none); never set by the game */
let testRate = 1;
export function setOutingRatesForTest(rate: number, n: number | null = null): void {
    testRate = rate;
    budgetN = n;
}
export function outingRate(): number {
    return testRate;
}

/** the bots online now (BotManager's configured N; the tests' own) */
export function onlineN(): number {
    if (budgetN !== null) return budgetN;
    try {
        return BotManager.stats().configured;
    } catch {
        return 0;
    }
}

/** how many bots may be out at once in far towns and minigames for `n` online (4 at 100: about 3 there at a time) */
export function farBudget(n: number = onlineN()): number {
    if (n <= 0) return 0;
    return Math.max(1, Math.round(FAR_PER_100 * (n / 100) ** FAR_EXP));
}

/** how many Treasure Trails may be under way at once */
export function trailBudget(n: number = onlineN()): number {
    return Math.max(1, Math.round((TRAIL_PER_100 * n) / 100));
}

function gone(p: Player): boolean {
    return p.slot === -1 || BotManager.botFor(p) === null;
}

/** forget the bots that left without their task ending (a logout mid-outing) */
function sweep(): void {
    for (const [p, o] of out) {
        if (!gone(p)) continue;
        o.entry.end = World.currentTick;
        o.entry.outcome = 'logout';
        out.delete(p);
    }
}

/** How many are out now, of a kind (or every outing and minigame: the far budget's count; trails apart). */
export function outCount(kind?: OutingKind | 'far'): number {
    sweep();
    let n = 0;
    for (const o of out.values()) {
        if (kind === undefined || o.entry.kind === kind || (kind === 'far' && o.entry.kind !== 'trail')) n++;
    }
    return n;
}

/** the bots out on `key` now */
export function outOn(key: string): Player[] {
    sweep();
    const list: Player[] = [];
    for (const [p, o] of out) if (o.entry.key === key) list.push(p);
    return list;
}

/** The key of the outing or minigame the bot is on (null: none): the runner's FT2. */
export function outingOf(p: Player): string | null {
    return out.get(p)?.entry.key ?? null;
}

/** The bot sets out (its task's start). */
export function noteOutingStart(p: Player, key: string, town: string, kind: OutingKind): void {
    const prev = out.get(p);
    if (prev && prev.entry.key === key && prev.entry.end === -1) return;
    if (prev) noteOutingEnd(p, 'replaced');
    const entry: OutingEntry = { key, town, kind, name: p.username, start: World.currentTick, end: -1, outcome: '' };
    out.set(p, { entry, player: p });
    outingLog.push(entry);
    if (outingLog.length > LOG_MAX) outingLog.shift();
    if (kind !== 'outing') countMinigame(key.split(':')[0], 'visits');
}

/** The bot's outing or visit is over (its task ended, or was interrupted). */
export function noteOutingEnd(p: Player, outcome: string): void {
    const o = out.get(p);
    if (!o) return;
    o.entry.end = World.currentTick;
    o.entry.outcome = outcome;
    out.delete(p);
    lastOuting.set(p.username, World.currentTick);
}

/** world ticks since the bot's last outing ended (Infinity: none this process): the planner's gap */
const lastOuting = new Map<string, number>();
export function ticksSinceOuting(name: string): number {
    const t = lastOuting.get(name);
    return t === undefined ? Infinity : World.currentTick - t;
}

/** A minigame's count goes up (its visits, crews, rounds, tickets, caskets ...). */
export function countMinigame(game: string, what: string, n = 1): void {
    let s = stats.get(game);
    if (!s) stats.set(game, (s = { visits: 0 }));
    s[what] = (s[what] ?? 0) + n;
}

/** The minigames' counts so far (a copy). */
export function minigameStats(): Record<string, Record<string, number>> {
    const res: Record<string, Record<string, number>> = {};
    for (const [k, v] of stats) res[k] = { ...v };
    return res;
}

/** the planner hooks' picks (port/BotMinigames: outings, minigames, Kandarin's signatures) by what the bot did before */
const picks = new Map<string, Record<string, number>>();

/** A hook gave a bot `key` in place of what it was doing (`previous`, its last task's kind): the runner's FT2, whom they take. */
export function notePick(hook: string, key: string, previous: string | null): void {
    let s = picks.get(hook);
    if (!s) picks.set(hook, (s = {}));
    const from = `${key}<${(previous ?? 'none').split(':')[0]}`;
    s[from] = (s[from] ?? 0) + 1;
}

/** The hooks' picks so far (a copy): hook → 'key<previous kind' → count. */
export function pickStats(): Record<string, Record<string, number>> {
    const res: Record<string, Record<string, number>> = {};
    for (const [k, v] of picks) res[k] = { ...v };
    return res;
}

/** (tests) forget everything */
export function resetOutingsForTest(): void {
    out.clear();
    outingLog.length = 0;
    stats.clear();
    lastOuting.clear();
    picks.clear();
}

/**
 * The bot says a line of the moment `kind` (data/lines2004-members.json, event 'members': 'outing-go-yanille',
 * 'trawler-board' ...) now, if one is fresh: the text, or null. Kind 'setpiece' (out of H7, X2), in its style, in the
 * place of its next unprompted line; members' lines only on a members world.
 */
export function sayMembers(bot: Player, kind: string, to: Player | null = null): string | null {
    if (!isMembersWorld()) return null;
    return sayPieceLine(bot, 'members', kind, 'setpiece', { to });
}

/** A bot within `radius` tiles of (x, z) on that floor, that is not `but` (a crew's company, someone to talk to). */
export function botsNear(x: number, z: number, level: number, radius: number, but: Player | null = null): Player[] {
    const list: Player[] = [];
    for (const p of World.playerLoop.all()) {
        if (p === but || p.is_bot !== true || p.level !== level) continue;
        if (Math.max(Math.abs(p.x - x), Math.abs(p.z - z)) <= radius) list.push(p);
    }
    return list;
}
