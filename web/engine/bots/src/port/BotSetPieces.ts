// port (the realism work, phase 5b: set pieces, "Foundation (5b)"): one
// interface for every set piece (the research,
// merged), so the director (Track D, port/BotDirector) schedules the other tracks' pieces without importing them.
//
// - A set piece registers a SetPieceDef at load (port/BotSetPieceIndex imports every piece's module): its kind, its
//   weights on members and free worlds, plan(ctx) (where it could run now, from the census of bots: never the human's
//   place) and start(plan, ctx) (the run, or null).
// - The director keeps one run at a time: runStarted(run), a tick(now) every 5 ticks, runEnded(run) once its phase is
//   'done' (or after abort(why)). A run's roles (bot -> role) say who is in it.
// - A bot's role (eventRoleOf): a running piece's, or one set outside the director (setRole: a duellist at the Duel
//   Arena on its own visit). BotManager holds the bot's logout while it has one; its breaks, a clique's travel and a
//   hang-out leave it alone.
// - The planner asks setPieceTaskFor(player, previous) beside its hang-outs: a piece's own visits (the Duel Arena's).
// - setPieceLog: what ran, for the humanlike runner and the tests (a capped ring).
//
// A leaf module: types only from elsewhere (the tasks import it; it imports none of them at run time).
import type Player from '#/engine/entity/Player.js';
import type { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';

export type SetPieceKind = 'drop_party' | 'party_room' | 'clan_walk' | 'pk_raid' | 'duel_stake' | 'scam_spree' | 'fake_dp';
export type SetPiecePhase = 'announce' | 'build' | 'peak' | 'end' | 'done';

/** where a piece runs: a key (for "no venue again within 3 events"), the tile, and how a bot names it ("fally park") */
export interface SetPieceVenue {
    key: string;
    x: number;
    z: number;
    level: number;
    say: string;
}

/** what the director hands a piece when it plans and starts (Track D builds it; bots only, never a human) */
export interface SetPieceContext {
    now: number;
    /** play ticks (BotManager.stats().playTicks) */
    play: number;
    members: boolean;
    online: number;
    /** region key -> the bots there (no humans) */
    census: ReadonlyMap<string, readonly Player[]>;
    /** free bots near a place (online, not busy, not a newbie or vendor at its stall unless `ok` says so), nearest first */
    freeBots(x: number, z: number, level: number, radius: number, ok?: (p: Player) => boolean, max?: number): Player[];
    /** play ticks left in a bot's session (BotManager.sessionLeft; Infinity when unknown) */
    sessionLeft(p: Player): number;
    dice(): number;
}

export interface SetPiecePlan {
    kind: SetPieceKind;
    venue: SetPieceVenue;
    /** how good a pick it is now (mostly the bots near the venue): the director draws by weight x score */
    score: number;
    data?: unknown;
}

/** a set piece under way */
export interface SetPieceRun {
    readonly id: number;
    readonly kind: SetPieceKind;
    readonly venue: SetPieceVenue;
    phase: SetPiecePhase;
    readonly startedAt: number;
    /** the tick it ends by, whatever (its roles' sub-tasks end then too) */
    endsBy: number;
    /** bot -> role ('host', 'guest', 'leader', 'member', 'crowd', 'staker', ...) */
    readonly roles: Map<Player, string>;
    /** every 5 ticks, by the director: the piece's own course (its phase 'done' when it is over) */
    tick(now: number): void;
    /** a role's bot is gone (logged out, died, in a fight, stuck) */
    left(p: Player, why: 'logout' | 'death' | 'fight' | 'stuck'): void;
    /** a word-of-mouth line about it ("drop party at fally park!!"), or null */
    rumour(): string | null;
    /** stop now (the host left, the world emptied): every role's sub-task completes, phase 'done' */
    abort(why: string): void;
}

export interface SetPieceDef {
    kind: SetPieceKind;
    /** members' worlds only */
    members?: boolean;
    weight: { members: number; free: number };
    /** where and whether it could run now (null: it cannot) */
    plan(ctx: SetPieceContext): SetPiecePlan | null;
    start(plan: SetPiecePlan, ctx: SetPieceContext): SetPieceRun | null;
}

// ── the registry ─────────────────────────────────────────────────────────────────────────────────────────────────

const defs = new Map<SetPieceKind, SetPieceDef>();

/** A set piece makes itself known (at its module's load). A second def of a kind replaces the first (the tests). */
export function register(def: SetPieceDef): void {
    defs.set(def.kind, def);
}

/** Every registered set piece, in registration order. */
export function registeredSetPieces(): readonly SetPieceDef[] {
    return [...defs.values()];
}

// ── what runs, and who is in it ───────────────────────────────────────────────────────────────────────────────────

const running = new Set<SetPieceRun>();
/** roles set outside a director's run (a duellist on its own arena visit): bot -> role */
const ownRoles = new WeakMap<Player, string>();

/** The director: a run began. */
export function runStarted(run: SetPieceRun): void {
    running.add(run);
}

/** The director: a run is over (its phase 'done', or aborted). */
export function runEnded(run: SetPieceRun): void {
    running.delete(run);
}

/** The runs under way now. */
export function runningSetPieces(): readonly SetPieceRun[] {
    return [...running];
}

/** A bot's part in a set piece now ({ run, role }; run null for a role set outside a run), or null. */
export function eventRoleOf(p: Player): { run: SetPieceRun | null; role: string } | null {
    for (const run of running) {
        const role = run.roles.get(p);
        if (role !== undefined && run.phase !== 'done') return { run, role };
    }
    const own = ownRoles.get(p);
    return own !== undefined ? { run: null, role: own } : null;
}

/** A role outside a director's run (a duel on its own arena visit); clearRole when it is over. */
export function setRole(p: Player, role: string): void {
    ownRoles.set(p, role);
}

export function clearRole(p: Player): void {
    ownRoles.delete(p);
}

// ── the planner's hook ───────────────────────────────────────────────────────────────────────────────────────────

type PlannerHook = (player: Player, previous: string | null) => BotTask | null;
const plannerHooks: PlannerHook[] = [];

/** A piece's own visits, offered to the planner (the Duel Arena's every 3-6 hours of play). */
export function registerPlannerHook(hook: PlannerHook): void {
    plannerHooks.push(hook);
}

/**
 * (the variety work, round 2, the fixes) a hook's own task under way, kept (port/BotMinigames: an outing, a minigame):
 * asked by the planner first (BotGoalPlanner's keep step), before its hang-outs, alch stints and set pieces. A hook keeps
 * its task only when it is asked, and the members hook was asked after the arena's.
 */
type KeepHook = (player: Player) => BotTask | null;
const keepHooks: KeepHook[] = [];

export function registerKeepHook(hook: KeepHook): void {
    keepHooks.push(hook);
}

export function keptHookTask(player: Player): BotTask | null {
    for (const hook of keepHooks) {
        const task = hook(player);
        if (task) return task;
    }
    return null;
}

/** The planner (BotGoalPlanner, beside its hang-outs): a set piece's task for this bot now, or null. */
export function setPieceTaskFor(player: Player, previous: string | null): BotTask | null {
    if (eventRoleOf(player)) return null;
    for (const hook of plannerHooks) {
        const task = hook(player, previous);
        if (task) return task;
    }
    return null;
}

// ── the log ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SetPieceLogEntry {
    id: number;
    kind: SetPieceKind | string;
    venue: string;
    x: number;
    z: number;
    level: number;
    start: number;
    /** -1 while it runs */
    end: number;
    /** 'done', or why it was aborted */
    outcome: string;
    /** bots that had a role in it */
    roles: number;
    /** anything else the piece notes (a stake's size, a party's drops) */
    detail?: Record<string, unknown>;
}

const LOG_MAX = 2000;
/** what ran, oldest first (a capped ring): the humanlike runner and the tests */
export const setPieceLog: SetPieceLogEntry[] = [];

/** Note a set piece's record (the director at its start, then its end; a piece's own visits too). */
export function logSetPiece(entry: SetPieceLogEntry): SetPieceLogEntry {
    setPieceLog.push(entry);
    if (setPieceLog.length > LOG_MAX) setPieceLog.shift();
    return entry;
}

let nextId = 1;
/** A new run's id. */
export function nextSetPieceId(): number {
    return nextId++;
}

/** (tests) forget everything (the registry stays: the modules registered at load) */
export function resetSetPiecesForTest(): void {
    running.clear();
    setPieceLog.length = 0;
}
