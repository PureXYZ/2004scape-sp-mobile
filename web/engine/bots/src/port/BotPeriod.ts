// port (bots ideas, round 3, theme G: period content no bot touches): the period visits' shared ground, a leaf (types, World and the arcs' play clock only), so
// that any module may import it for periodOn() without an import cycle biting (an early import once crashed on a TDZ).
// port/BotPeriodPlan has the planner's hook (it reads this module's registry and budget), port/BotPeriodIndex registers
// it and loads the builders' modules.
//
//   - THE SWITCH: periodOn(). Theme G is on in the game. A staged test world turns it off unless it asks for it
//     (test/lib/simworld Sim.create({ period: true })); the humanlike runner turns it on (--period=off for an A/B run of
//     the same seed). EVERY theme G hook (the buzz's hook and budget here, the pet habit, the Games Room, Gnomeball, the
//     Rellekka buzz, chompies) asks periodOn() BEFORE any roll: a feature that is off draws no dice (round 2's lesson:
//     one roll of theme D's dice before its "on" check moved every staged scene's dice).
//   - The update buzz (§4.1): a budget of its own beside the far one (port/BotOutings farBudget): BUZZ_PER_100 ×
//     (N / 100)^BUZZ_EXP bots out at once (2 at 100 online, 15 at 500, 36 at 1000; about 70 % of them there at a time).
//     A free members-world levelling bot (combat BUZZ_MIN_COMBAT+, no newbie; the extras keep their roles) asked for its
//     next plan is offered a visit BUZZ_OFFER × (0.5 + curiosity) of the time while the budget has room, at most once in
//     BUZZ_GAP play ticks (in-process, like ticksSinceOuting). Steady: no decay, no clock (the world is always
//     23 Nov 2004; December never comes).
//   - The registry the builders fill (registerPeriodEntry): a visit's key, its kind (the budget it draws on: 'buzz'),
//     its weight, fits(player) (the whole "may it go now" check, no dice), make(player) (its task, or null) and an
//     optional cap per 100 online. The H builder's buzz kinds: crabs 3 : sightseeing 2 : lighthouse 1. With nothing
//     registered the hook returns at once and draws nothing.
//   - Who is out (notePeriodStart / notePeriodEnd: a period task's start and end, of any kind: the buzz's own and the
//     Games Room, Gnomeball, chompies and the pet trip, which other hooks give), the log, and periodStats (the humanlike
//     runner's PC1 and PC10: visits by kind, the rescue jumps of bots out, by kind and reason).
//   - A buzz task's name: `<its task kind>:buzz:<key>` (buzzTaskName), as an outing's is `<kind>:outing:<key>`: the
//     planner, the chatter and the runner see a crab fight as a fight.
//   - The lines: data/lines2004-period.json (the G builder's: pet, games, gnomeball, cw; event PERIOD_EVENT) and
//     data/lines2004-buzz.json (the H builder's: buzz, crabs, lighthouse, chompy; event BUZZ_EVENT), set-piece lines said
//     through port/BotPeriodPlan sayPeriodLine (kind 'setpiece': out of H7, counted in X2, in the place of the speaker's
//     next unprompted line) or round 2's sayArcLine with a budget mode.
//
// Nothing new in bots.sav: the game's own perm varps keep each bot's pet, Runelink rank and chompy kills; the buzz gap
// and the boosts are in-process. Never staged round the human: every visit comes from the bots' own plans.
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import type { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';
import type { TeleportReason } from '#/engine/bot/BotAction.js';
import { arcsPlay } from '#/engine/bot/port/BotArcsEvents.js';
import type { BotPlayer } from '#/engine/bot/BotPlayer.js';

// ---- (bots ideas, round 3: G period) theme G's habits, ticked by BotPlayer after the bot's own self-defence (port/BotPets'
// pet care, pushed by port/BotPeriodIndex): true holds the bot this tick, as a break does (its task, the rescan and their
// clocks wait). Each asks periodOn() first: off, it is false at once and draws nothing. Here, in the leaf, so that the
// list exists before any import cycle reaches it (BotPlayer's own const was in its TDZ when an early import loaded
// port/BotPeriodIndex) ----
export const periodHabits: ((bot: BotPlayer) => boolean)[] = [];
/**
 * theme G's talk for the modules that cannot import its own (port/BotThreads, port/BotAnswers load early): filled by
 * port/BotPeriodIndex from port/BotPeriodTalk; each asks periodOn() itself
 */
export const periodTalk: {
    /** (port/BotThreads' topic pet) the bot has a pet out now */
    hasPetOut?: (p: Player) => boolean;
    /** (port/BotAnswers) a question about theme G's content (a kitten, the Games Room, Runelink, Gnomeball, Castle Wars) */
    answer?: (msg: string, bot: Player, pick: (pool: readonly string[]) => string) => { id: string; text: string } | null;
    /** (bots ideas, round 3 tune: port/BotChatter's due idle line) now and then the period's talk said in its place: true */
    idleLine?: (bot: Player) => boolean;
} = {};
// ---- end of G period's block ----

// ── the switch ────────────────────────────────────────────────────────────────────────────────────────────────────

/** theme G on or off (the game: on), the offer's scale and the budget's own N (the tests'; null: BotManager's) */
const DEFAULT_CTL = { on: true, rate: 1, n: null as number | null };
const PERIOD_CTL = { ...DEFAULT_CTL };

/** Is theme G on? Every G hook asks this before any roll (a staged test world has it off unless it asks for it). */
export function periodOn(): boolean {
    return PERIOD_CTL.on;
}

/**
 * (tests) theme G on or off, the buzz offer this many times as often (rate) and the budget's N (n); null: the game's
 * (on, 1, BotManager's N). test/lib/simworld's Sim.create sets { on: false } unless asked for (period: true). Never
 * called by the game.
 */
export function setPeriodForTest(opts: { on: boolean; rate?: number; n?: number | null } | null): void {
    Object.assign(PERIOD_CTL, DEFAULT_CTL, opts ?? {});
}

/** (the plan) the buzz offer's test scale (1 in the game) */
export function periodRate(): number {
    return PERIOD_CTL.rate;
}

/** (the plan) the budget's own N for a test, or null (BotManager's) */
export function periodBudgetN(): number | null {
    return PERIOD_CTL.n;
}

// ── the buzz's budget (G-content §4.1, §5: approved defaults) ──────────────────────────────────────────────────────

/** bots out on the buzz at once at 100 online, growing as (N / 100)^BUZZ_EXP: 2 at 100, 15 at 500, 36 at 1000 */
export const BUZZ_PER_100 = 2;
export const BUZZ_EXP = 1.25;
/** a bot's next buzz visit at least this many play ticks after its last one ended (1.5 h of play; in-process) */
export const BUZZ_GAP = 9000;
/** a free bot asked for its next plan while the budget has room is offered a visit this often, × (0.5 + curiosity) */
export const BUZZ_OFFER = 0.25;
/** who: a members-world levelling bot of at least this combat level (no newbies; the extras keep their roles) */
export const BUZZ_MIN_COMBAT = 15;
/** no visit with less than this left of the bot's session (half an hour, as an outing) */
export const PERIOD_SESSION_LEFT = 3000;
/** a rumour heard ("crabs r good xp", theme D): the bot's buzz offer this many times as often for its session */
export const BUZZ_BOOST = 2;

/** How many bots may be out on the buzz at once with `n` online (0 with none). */
export function buzzBudget(n: number): number {
    if (n <= 0) return 0;
    return Math.max(1, Math.round(BUZZ_PER_100 * (n / 100) ** BUZZ_EXP));
}

// ── the registry the builders fill ─────────────────────────────────────────────────────────────────────────────────

/** what a period visit is: the buzz (Rellekka, the crabs, the lighthouse), and the kinds other hooks give */
export type PeriodKind = 'buzz' | 'pet' | 'games' | 'gnomeball' | 'chompy';

/** a buzz task's name marks it: `<its task kind>:buzz:<key>` */
export const BUZZ_MARK = ':buzz:';
export function buzzTaskName(taskKind: string, key: string): string {
    return `${taskKind}${BUZZ_MARK}${key}`;
}

/** the lines' events: data/lines2004-period.json's groups (the G builder's), data/lines2004-buzz.json's (the H builder's) */
export const PERIOD_EVENT = 'period';
export const BUZZ_EVENT = 'buzz';

export interface PeriodEntry {
    /** the visit's key ('crabs', 'rellekka', 'lighthouse'); its task's name `<kind>:buzz:<key>` */
    key: string;
    /** the budget it draws on (the planner's hook offers the buzz's: BUZZ_PER_100, BUZZ_GAP, BUZZ_OFFER) */
    kind: 'buzz';
    /** its share among what the bot may do now (crabs 3 : sightseeing 2 : lighthouse 1) */
    weight: number;
    /** at most this many bots per 100 online on this key at once (crabs 1.2: 6 at 500; the lighthouse 0.4); none: no cap */
    capPer100?: number;
    /** the cap's least (default 1) */
    capMin?: number;
    /** may the bot go now (levels, kit, food, curiosity's threshold ...): no dice, no state */
    fits(player: Player): boolean;
    /** its task, or null (it may not after all: the hook picks again among the rest) */
    make(player: Player): BotTask | null;
}

const ENTRIES: PeriodEntry[] = [];

/** A builder's entry (at its module's load; an entry of the same key is replaced). */
export function registerPeriodEntry(entry: PeriodEntry): void {
    const i = ENTRIES.findIndex(e => e.key === entry.key);
    if (i >= 0) ENTRIES[i] = entry;
    else ENTRIES.push(entry);
}

/** the entries, in their order of registration */
export function periodEntries(): readonly PeriodEntry[] {
    return ENTRIES;
}

/** How many bots may be out on `entry`'s key at once with `n` online (Infinity: no cap). */
export function periodCap(entry: PeriodEntry, n: number): number {
    if (entry.capPer100 === undefined) return Infinity;
    return Math.max(entry.capMin ?? 1, Math.round((entry.capPer100 * n) / 100));
}

// ── who is out, the log, the stats ─────────────────────────────────────────────────────────────────────────────────

export interface PeriodVisit {
    key: string;
    kind: PeriodKind;
    name: string;
    start: number;
    /** -1 while it lasts */
    end: number;
    /** 'done', 'time', 'food', 'hp', 'interrupted', 'logout', 'replaced' ... */
    outcome: string;
}

const out = new Map<Player, PeriodVisit>();

const LOG_MAX = 3000;
/** every visit begun, oldest first (a capped ring): the tests and the runner */
export const periodLog: PeriodVisit[] = [];

/**
 * the planner's asks and offers (port/BotPeriodPlan), the visits begun by kind and by `<kind>:<key>`, how they ended,
 * and the rescue jumps (BotAction botTeleport's, done) of bots out on a visit by kind and reason: the runner's PC1, PC10
 */
export const periodStats = {
    asked: 0,
    kept: 0,
    offered: 0,
    byKey: {} as Record<string, number>,
    why: { again: 0, who: 0, budget: 0, gap: 0, roll: 0, none: 0 },
    visits: {} as Record<string, number>,
    visitsByKey: {} as Record<string, number>,
    ended: {} as Record<string, number>,
    moves: {} as Record<string, Record<string, number>>,
    refused: {} as Record<string, number>
};

/** a copy of periodStats (the runner's record.period.lib) */
export function periodStatsCopy(): typeof periodStats {
    return JSON.parse(JSON.stringify(periodStats)) as typeof periodStats;
}

function gone(p: Player): boolean {
    return p.slot === -1;
}

/** forget the bots that left without their visit ending (a logout mid-visit) */
function sweep(): void {
    for (const [p, v] of out) {
        if (!gone(p)) continue;
        endVisit(p, v, 'logout');
    }
}

function endVisit(p: Player, v: PeriodVisit, outcome: string): void {
    v.end = World.currentTick;
    v.outcome = outcome;
    out.delete(p);
    periodStats.ended[outcome] = (periodStats.ended[outcome] ?? 0) + 1;
    last.set(`${v.kind}|${p.username}`, arcsPlay());
}

/** The bot sets out on a period visit (its task's start). */
export function notePeriodStart(p: Player, key: string, kind: PeriodKind): void {
    const prev = out.get(p);
    if (prev && prev.key === key && prev.kind === kind && prev.end === -1) return;
    if (prev) endVisit(p, prev, 'replaced');
    const v: PeriodVisit = { key, kind, name: p.username, start: World.currentTick, end: -1, outcome: '' };
    out.set(p, v);
    periodLog.push(v);
    if (periodLog.length > LOG_MAX) periodLog.shift();
    periodStats.visits[kind] = (periodStats.visits[kind] ?? 0) + 1;
    periodStats.visitsByKey[`${kind}:${key}`] = (periodStats.visitsByKey[`${kind}:${key}`] ?? 0) + 1;
}

/** The bot's visit is over (its task ended, or was cut short). */
export function notePeriodEnd(p: Player, outcome: string): void {
    const v = out.get(p);
    if (v) endVisit(p, v, outcome);
}

/** The visit the bot is on now, or null (the runner's PC1 "by kind"). */
export function periodOf(p: Player): PeriodVisit | null {
    return out.get(p) ?? null;
}

/** How many bots are out now (of a kind; every kind without one). */
export function periodOut(kind?: PeriodKind): number {
    if (out.size === 0) return 0;
    sweep();
    let n = 0;
    for (const v of out.values()) if (kind === undefined || v.kind === kind) n++;
    return n;
}

/** The bots out on `key` now. */
export function periodOutOn(key: string): Player[] {
    if (out.size === 0) return [];
    sweep();
    const list: Player[] = [];
    for (const [p, v] of out) if (v.key === key) list.push(p);
    return list;
}

/** play ticks (port/BotArcsEvents arcsPlay) when each bot's last visit of each kind ended: `<kind>|<name>` */
const last = new Map<string, number>();

/** Play ticks since the bot's last visit of `kind` ended (Infinity: none in this process). */
export function playSincePeriod(name: string, kind: PeriodKind): number {
    const t = last.get(`${kind}|${name}`);
    return t === undefined ? Infinity : arcsPlay() - t;
}

/**
 * A counted jump (BotAction's teleportListeners, port/BotPeriodIndex): a bot out on a visit has it noted by its visit's
 * kind and the jump's reason (PC10). A map lookup for any other bot.
 */
export function notePeriodJump(p: Player, reason: TeleportReason, done: boolean): void {
    if (out.size === 0) return;
    const v = out.get(p);
    if (!v) return;
    if (!done) {
        periodStats.refused[v.kind] = (periodStats.refused[v.kind] ?? 0) + 1;
        return;
    }
    const by = periodStats.moves[v.kind] ?? (periodStats.moves[v.kind] = {});
    by[reason] = (by[reason] ?? 0) + 1;
}

// ── a rumour heard (theme D: G-content §4.1 "With the other themes") ────────────────────────────────────────────────

/** the bots whose buzz offer is raised for their session (their Player: a new login is a new one), and the key heard of */
let boosts = new WeakMap<Player, { factor: number; key: string | null }>();

/** A rumour about the buzz heard ("crabs r good xp"): the bot's buzz offer BUZZ_BOOST × for its session, `key` leaned to. */
export function buzzBoost(p: Player, key: string | null = null): void {
    boosts.set(p, { factor: BUZZ_BOOST, key });
}

/** The bot's boost (factor 1 and no key without one). */
export function buzzBoostOf(p: Player): { factor: number; key: string | null } {
    return boosts.get(p) ?? { factor: 1, key: null };
}

// ── tests ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** (tests) one key only (null: the registry's pick) */
let forcedKey: string | null = null;
export function forcePeriodKeyForTest(key: string | null): void {
    forcedKey = key;
}
export function forcedPeriodKey(): string | null {
    return forcedKey;
}

/** (tests) forget who is out, the log, the gaps, the boosts and the counts (the registry and the switch stay) */
export function resetPeriodForTest(): void {
    out.clear();
    periodLog.length = 0;
    last.clear();
    boosts = new WeakMap();
    forcedKey = null;
    periodStats.asked = 0;
    periodStats.kept = 0;
    periodStats.offered = 0;
    periodStats.byKey = {};
    periodStats.why = { again: 0, who: 0, budget: 0, gap: 0, roll: 0, none: 0 };
    periodStats.visits = {};
    periodStats.visitsByKey = {};
    periodStats.ended = {};
    periodStats.moves = {};
    periodStats.refused = {};
}
