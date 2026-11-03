/**
 * port (bots ideas, round 1, Track A: the period endgame) the endgame's shared core, a leaf the other endgame modules
 * import (port/BotEndgame, port/BotEndgameTeams, port/BotVelrak, port/BotMageArena, port/BotDropSale, the Wilderness
 * trips' endgame spots in port/BotWildTrips), so none of them imports another's plans:
 *   - the trips under way (who is on one, where, since when: the spots' capacities, the report's EG metrics) and their
 *     log;
 *   - the set-piece role 'bosser' every bot on an endgame trip carries (port/BotSetPieces setRole: its logout held, the
 *     director's recruiting and other pieces off it; Track B's lever campers may pick one in three of them), set when the
 *     trip's errand begins and cleared when it ends, however it ends (BosserErrand);
 *   - the events later rounds subscribe to (onEndgameEvent: a boss killed, a bosser's death, a rare drop, a god cape
 *     earned, a dusty key got, a team wiped);
 *   - endgameOfferScale, the hook round 2's goals raise (1 today).
 * Nothing here is saved: the dusty key and the capes are items, the Mage Arena's progress the game's own varp, the teams
 * session-only.
 */
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { ErrandTask, type ErrandPlan } from '#/engine/bot/tasks/ErrandTask.js';
import { clearRole, eventRoleOf, setRole } from '#/engine/bot/port/BotSetPieces.js';
// ---- (bots ideas, round 2: C arcs) theme C's hooks (port/BotLives: a goal that points at the endgame) ----
import { LIVES } from '#/engine/bot/port/BotLives.js';
// ---- end of C's block ----

/** the set-piece role of a bot on an endgame trip (solo or team) */
export const BOSSER_ROLE = 'bosser';

// ── events (rounds 2-3: moods, goals, rumours, ties) ────────────────────────────────────────────────────────────────

export type EndgameEventKind = 'bossKill' | 'bossDeath' | 'rareDrop' | 'capeEarned' | 'dustyKey' | 'teamWipe';
export interface EndgameEvent {
    bot: Player;
    kind: EndgameEventKind;
    data: Readonly<Record<string, unknown>>;
}
type Listener = (event: EndgameEvent) => void;
const listeners: Listener[] = [];

/** told of every endgame event (a listener that throws is passed over); returns the unsubscribe */
export function onEndgameEvent(listener: Listener): () => void {
    listeners.push(listener);
    return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
    };
}

/** what the events were (the report, the tests): by kind */
export const endgameEventStats: Record<string, number> = {};

export function emitEndgameEvent(bot: Player, kind: EndgameEventKind, data: Readonly<Record<string, unknown>> = {}): void {
    endgameEventStats[kind] = (endgameEventStats[kind] ?? 0) + 1;
    const event: EndgameEvent = { bot, kind, data };
    for (const listener of [...listeners]) {
        try {
            listener(event);
        } catch {
            // (a listener's fault is its own)
        }
    }
}

/**
 * the goals' hook (round 2): how much more often this bot's picks become an endgame trip than ENDGAME_SHARE (a goal of
 * "kbd", "mage arena", "d med" or "blue drags" raises it; 1 today)
 */
export function endgameOfferScale(_p: Player): number {
    // ---- (bots ideas, round 2: C arcs) a bosser whose goal points at the endgame (combat 90+, a combat skill to 80+ or
    // 99, 250k+ coins: port/BotGoals) takes its trips 1.5 times as often; 1 for every other ----
    return LIVES.endgameScale?.(_p) ?? 1;
    // ---- end of C's block ----
}

// ── the trips under way ──────────────────────────────────────────────────────────────────────────────────────────────

/** what a trip is: a solo spot's, a Wilderness spot's (port/BotWildTrips), a team's, the Mage Arena, a prep errand, a sale */
export type TripKind = 'solo' | 'wild' | 'kbd' | 'kq' | 'arena' | 'velrak' | 'sale';

export interface Trip {
    readonly name: string;
    readonly spot: string;
    readonly kind: TripKind;
    readonly began: number;
}

/** a trip in the log (the report's EG metrics, the tests): its bot, spot, kind, start and end ticks, how it ended */
export interface TripRecord extends Trip {
    end: number;
    outcome: string;
    died: boolean;
}

const trips = new Map<Player, Trip>();
const MAX_LOG = 4000;
export const tripLog: TripRecord[] = [];

/** the bot's trip under way, or null (a bot logged out is off the registry) */
export function tripOf(p: Player): Trip | null {
    const t = trips.get(p);
    if (!t) return null;
    if (p.slot === -1) {
        trips.delete(p);
        return null;
    }
    return t;
}

/** the bots on a trip at this spot now (a capacity) */
export function tripsAt(spot: string): number {
    let n = 0;
    for (const [p, t] of trips) {
        if (p.slot === -1) trips.delete(p);
        else if (t.spot === spot) n++;
    }
    return n;
}

/** every trip under way (the report) */
export function tripsUnderWay(): readonly [Player, Trip][] {
    return [...trips].filter(([p]) => p.slot !== -1);
}

/** the tick of the bot's last endgame start (by name: a relog keeps its gap) */
const lastStart = new Map<string, number>();
export function lastEndgameStart(name: string): number {
    return lastStart.get(name.toLowerCase()) ?? -Infinity;
}

/** a start that came to nothing (a KBD call nobody answered): its gap gone, the bot may pick a trip again */
export function clearEndgameStart(name: string): void {
    lastStart.delete(name.toLowerCase());
}

/** (tests) the registry and the log from empty */
export function resetEndgameTripsForTest(): void {
    trips.clear();
    tripLog.length = 0;
    lastStart.clear();
    for (const k of Object.keys(endgameEventStats)) delete endgameEventStats[k];
}

function noteBegin(p: Player, spot: string, kind: TripKind): Trip {
    const t: Trip = { name: p.username, spot, kind, began: World.currentTick };
    trips.set(p, t);
    if (kind !== 'sale') lastStart.set(p.username.toLowerCase(), World.currentTick);
    return t;
}

function noteEnd(p: Player, trip: Trip, outcome: string, died: boolean): void {
    if (trips.get(p) === trip) trips.delete(p);
    tripLog.push({ ...trip, end: World.currentTick, outcome, died });
    if (tripLog.length > MAX_LOG) tripLog.splice(0, tripLog.length - MAX_LOG);
}

/**
 * An endgame errand: an ErrandTask that puts its bot on the registry and gives it the role 'bosser' (`role`) when it
 * begins, and takes both off when it ends: done, failed, interrupted (a session's end, a "come here", a random event:
 * every way BotPlayer drops a task). `died` (set by the plan's own death check) goes into the log.
 */
export class BosserErrand extends ErrandTask {
    private self: Player | null = null;
    private trip: Trip | null = null;
    /** set by the plan when its bot died on the trip (the log's, EG3) */
    died = false;
    /** (round 1 fixes, A2) told when the trip is over, its outcome (a KBD leader's team ends with it) */
    onOver: ((outcome: string) => void) | null = null;

    constructor(
        plan: ErrandPlan,
        readonly tripKind: TripKind,
        readonly role: boolean = true
    ) {
        super(plan);
    }

    override tick(player: Player): void {
        if (!this.trip && !this.interrupted && !this.isComplete(player)) {
            this.self = player;
            this.trip = noteBegin(player, this.plan.key, this.tripKind);
            if (this.role && !eventRoleOf(player)) setRole(player, BOSSER_ROLE);
        }
        super.tick(player);
        if (this.trip && super.isComplete(player)) this.over(player);
    }

    override isComplete(player: Player): boolean {
        const done = super.isComplete(player);
        if (done && this.trip) this.over(player);
        return done;
    }

    override interrupt(): void {
        super.interrupt();
        if (this.self && this.trip) this.over(this.self);
    }

    /** (BotPlayer resets a task it switches away from: the trip is over then; one that runs on begins its round again) */
    override reset(): void {
        if (this.self && this.trip) this.over(this.self);
        super.reset();
    }

    private over(p: Player): void {
        const trip = this.trip;
        if (!trip) return;
        this.trip = null;
        const role = eventRoleOf(p);
        if (this.role && role && role.run === null && role.role === BOSSER_ROLE) clearRole(p);
        const outcome = this.interrupted ? 'interrupted' : this.outcome || 'done';
        noteEnd(p, trip, outcome, this.died);
        this.onOver?.(outcome);
    }
}

/** is this bot on an endgame trip now (its role)? (Track B's lever campers, the cliques' follow) */
export function isBosser(p: Player): boolean {
    return eventRoleOf(p)?.role === BOSSER_ROLE;
}
