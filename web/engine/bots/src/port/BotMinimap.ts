// port (bots ideas, round 3, theme H: movement): a long walk the way a 2004 player clicked it. A player walked a long way in minimap clicks: 274's
// minimap reaches about 18 tiles (Client.ts: 146×151 px at 4 px a tile), and nothing in the client queues the 31-48 tile
// legs the bots' walking graph used to queue at once. BotAction calls in from its marked blocks (_pathTowards, walkTo,
// _graphTarget, _graphPlan, isCrossing):
//
//   - HOPS (H1). A graph walk (40+ tiles, the overworld) within 64 tiles of a human (BotPathing's level of detail) is cut
//     into hops of 8-18 tiles: a per-bot mean of 11-17 (seed salt `hop`), each hop the mean ± 3. The cut is made in the
//     path the leg's one search found (cutPath, by 274's step rule: diagonal while both offsets are non-zero, then
//     straight), so a hop costs no search; the rest is kept and the next hop is cut from it. A cut a tile from a turn of
//     the path goes on the turn: players clicked at corners. The next hop is clicked 3 tiles before the flag
//     (hopChain: no stop), unless a pause is due or the bot is typing.
//   - PAUSES (H1). At a hop's end the bot stands 1-3 ticks (70 %), 4-8 (25 %) or 9-15 (5 %), with a per-bot chance of
//     0.10-0.45 a hop (median 0.25, seed salt `hop`, × its persona's lapse rate against the median). The stuck checks
//     wait meanwhile (BotAction.isCrossing).
//   - TYPING (H1). A bot typing a line (minimapHooks.typing: port/BotChat midTalk, set by port/BotTalkMoves) clicks no
//     new hop until the line is said: it walks to its flag and stands there (at most TYPING_WAIT ticks).
//   - OVERSHOOT (H1). A cut on a corner may go 2-4 tiles straight past it (each step free in the collision map: never
//     through a door, a gate or a fence; never into the Wilderness or onto a tile a monster that hunts the bot can get
//     at: keptOff), then the bot walks back to the corner and on: 0.08 × carelessness ÷ 0.25 a corner (0.02-0.3). No
//     search.
//   - LANES (H1). At an intermediate graph node of a near-human walk, the leg aims at the node shifted sideways by the
//     bot's lane (−2..+2 tiles, seed salt `lane`) ± 1 a leg, when that tile is free with a free straight run to the
//     node and not kept off (the Wilderness: the z 3510-3519 rows by Edgeville run along its open border; hunters); else
//     the node. The leg's one search aims there, so different bots walk different lines along a road.
//   - ROUTE VARIANTS (H2). Every bot (no level-of-detail gate): a walk's graph route is variant 0 (today's), 1 or 2
//     (port/BotWalkGraph route's edge-cost noise), 65 % the bot's habit for that goal node (seed salt `route-pref`), 35 %
//     a roll; a variant is kept only at most 1.15 × variant 0's cost + 16 tiles, with no Wilderness node and no node of
//     monsters that hunt the bot that variant 0 does not have. A re-plan of the same walk keeps its variant (a group
//     leader's route never switches under its followers).
//
//   Who never hops, pauses or takes a lane (BotAction _mayHop, and minimapExempt): a walk in or into the Wilderness (and
//   a hop whose tiles cross into it: walked whole, as such a walk's legs; no overshoot or lane tile in it either), a
//   PK task, a flee (HP under half), an aggressor within 8, a sub-task (an errand, a follow: clique, chain and boss-team
//   follows, a random event), a trade, a "come here", a social bot's lead, a leader of a friend (port/BotTeleport
//   leadsAFriend), a set piece role (pushed by port/BotTalkMoves), another theme's walks (B's vulture and pile rushes,
//   A's boss trips, C's leaving walks: their hooks). A walk under 40 tiles is no graph walk and never hops.
//
//   - THE SWITCH: movementOn(kind), one rate per piece (hops, pauses, overshoot, lanes, variants: this module's; walkUp,
//     holds: port/BotTalkMoves'), each a multiplier (1 in the game, 0 off). A staged test world turns every one off
//     unless it asks for them (test/lib/simworld Sim.create({ movement: true })); the humanlike runner turns them on
//     (--movement=off for an A/B run of the same seed: MV9). EVERY theme H hook asks movementOn(kind) BEFORE any roll:
//     a piece that is off draws no dice (round 2's lesson), so a staged test not about movement walks as before H.
//   - minimapStats: what the hops did (the humanlike runner's MV3 and MV8).
//
// Nothing is saved: every trait is seeded from the name. Imports only modules BotAction itself imports (no new cycle).
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { canTravel, CollisionType } from '#/engine/routefinder/index.js';
import { isMapBlocked } from '#/engine/GameMap.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { personaOf } from '#/engine/bot/port/BotPersona.js';
import type { PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { farFromHumans } from '#/engine/bot/port/BotPathing.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { nodePos, routeCost } from '#/engine/bot/port/BotWalkGraph.js';
import { dangerOfNode, fearedAt, huntsMe } from '#/engine/bot/port/BotDanger.js';

/** the movement pieces' rates (multipliers: 1 the game's, 0 off) */
export interface MovementRates {
    /** H1: a graph walk near the human cut into minimap hops (10-18 tiles) */
    hops: number;
    /** H1: a pause at a hop's end (per bot 0.10-0.45 of the hops) */
    pauses: number;
    /** H1: an overshoot at a corner (2-4 tiles, then back) */
    overshoot: number;
    /** H1: a per-bot lane at the graph's intermediate nodes */
    lanes: number;
    /** H2: route variants from edge-cost noise */
    variants: number;
    /** H3: an opener walks up to its partner (port/BotTalkMoves) */
    walkUp: number;
    /** H4: both bots of a thread stop to talk (port/BotTalkMoves) */
    holds: number;
}
export type MovementKind = keyof MovementRates;

const DEFAULT_RATES: MovementRates = { hops: 1, pauses: 1, overshoot: 1, lanes: 1, variants: 1, walkUp: 1, holds: 1 };
/** the rates in use (the game's; tests change them: setMovementRatesForTest) */
export const movementRates: MovementRates = { ...DEFAULT_RATES };

/** (tests) the rates given (the rest the game's); null: the game's. Never called by the game. */
export function setMovementRatesForTest(rates: Partial<MovementRates> | null): void {
    Object.assign(movementRates, DEFAULT_RATES, rates ?? {});
}

/** every piece off (test/lib/simworld's staged worlds unless asked for) */
export const MOVEMENT_OFF: Readonly<MovementRates> = { hops: 0, pauses: 0, overshoot: 0, lanes: 0, variants: 0, walkUp: 0, holds: 0 };

/** Is this piece of theme H on? Every H hook asks this before any roll. */
export function movementOn(kind: MovementKind): boolean {
    return movementRates[kind] > 0;
}

/**
 * walks that are never cut into hops nor paused, nor given a lane: another theme's own (true: exempt), pushed at its
 * module's load (B's vultures and pile rushes, A's boss trips, C's leaving; and H's own that need the chat and set-piece
 * modules, port/BotTalkMoves). Order-independent: any one true exempts.
 */
export const minimapExempt: ((player: Player) => boolean)[] = [];

/** what this module asks of modules it does not import (set at their load: port/BotTalkMoves) */
export const minimapHooks: { typing: (player: Player) => boolean } = { typing: () => false };

/** HOP_HIST: the longest hop length minimapStats.hops counts on its own (longer ones count there) */
const HOP_HIST = 40;
/** what the hops did (the humanlike runner's MV3 hop lengths, MV8 overshoots per 100 walks) */
export const minimapStats = {
    /** near-human graph walks that were cut into hops (one per walk's destination) */
    walks: 0,
    /** queued hops by length: hops[n] is the number of hops queued n tiles (Chebyshev) from the bot (n capped at HOP_HIST) */
    hops: [] as number[],
    pauses: 0,
    /** pause ticks in all */
    pauseTicks: 0,
    overshoots: 0,
    /** legs aimed at a node shifted by the bot's lane */
    lanes: 0,
    /** hops not clicked because the bot was typing (stands at the flag) */
    typingStands: 0,
    /** walks cut, then given whole because the bot was no longer eligible (an aggressor, the human away) */
    released: 0,
    /** route variants: plans by the variant taken; kept variants; ones refused (too long, the Wilderness, hunters) */
    variants: { v0: 0, v1: 0, v2: 0, same: 0, long: 0, wild: 0, hunt: 0, none: 0 }
};

/** (tests) every stat back to zero */
export function resetMinimapStatsForTest(): void {
    minimapStats.walks = 0;
    minimapStats.hops = [];
    minimapStats.pauses = minimapStats.pauseTicks = minimapStats.overshoots = minimapStats.lanes = minimapStats.typingStands = minimapStats.released = 0;
    for (const k of Object.keys(minimapStats.variants) as (keyof typeof minimapStats.variants)[]) minimapStats.variants[k] = 0;
}

// ── per-bot traits (seeded from the name; nothing saved) ──────────────────────

/** a hop: the bot's mean is HOP_MEAN[0]..HOP_MEAN[1] tiles, each hop its mean ± HOP_SPREAD, within HOP_MIN..HOP_MAX */
export const HOP_MEAN: [number, number] = [11, 17];
export const HOP_SPREAD = 3;
export const HOP_MIN = 8;
/** the minimap's reach: no hop (or an overshoot's flag) farther than this from the bot when it is queued */
export const HOP_MAX = 18;
/** a pause's chance a hop: per bot in PAUSE_CHANCE (median PAUSE_MEDIAN), × the persona's lapse rate ÷ LAPSE_MEDIAN */
export const PAUSE_CHANCE: [number, number] = [0.1, 0.45];
const PAUSE_MEDIAN = 0.25;
const LAPSE_MEDIAN = 0.05;
/** an overshoot's chance at a corner: OVERSHOOT × carelessness ÷ CARELESS_MEDIAN, within OVERSHOOT_CLAMP; 2-4 tiles */
export const OVERSHOOT = 0.08;
const CARELESS_MEDIAN = 0.25;
const OVERSHOOT_CLAMP: [number, number] = [0.02, 0.3];
const OVERSHOOT_TILES: [number, number] = [2, 4];
/** a lane: per bot −LANE_MAX..+LANE_MAX tiles (seed salt `lane`), ± 1 a leg */
export const LANE_MAX = 2;

interface Traits {
    hopMean: number;
    pauseChance: number;
    overshoot: number;
    lane: number;
}
const traits = new WeakMap<Player, Traits>();

/** the bot's seeded movement traits (kept with its Player) */
export function movementTraits(player: Player): Readonly<Traits> {
    let t = traits.get(player);
    if (!t) {
        const r = seededRandom(nameSeed(player.username, 'hop'));
        const persona = personaOf(player.username, (player.botPlanner as PlannerKey) ?? null);
        const hopMean = HOP_MEAN[0] + Math.floor(r() * (HOP_MEAN[1] - HOP_MEAN[0] + 1));
        // (0.10-0.25 below the median, 0.25-0.45 above it, then the persona's lapses)
        const u = r();
        const base = u < 0.5 ? PAUSE_CHANCE[0] + (u / 0.5) * (PAUSE_MEDIAN - PAUSE_CHANCE[0]) : PAUSE_MEDIAN + ((u - 0.5) / 0.5) * (PAUSE_CHANCE[1] - PAUSE_MEDIAN);
        const pauseChance = clamp(base * (persona.lapseRate / LAPSE_MEDIAN), PAUSE_CHANCE[0], PAUSE_CHANCE[1]);
        const overshoot = clamp((OVERSHOOT * persona.carelessness) / CARELESS_MEDIAN, OVERSHOOT_CLAMP[0], OVERSHOOT_CLAMP[1]);
        const lane = (nameSeed(player.username, 'lane') % (2 * LANE_MAX + 1)) - LANE_MAX;
        traits.set(player, (t = { hopMean, pauseChance, overshoot, lane }));
    }
    return t;
}

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

// ── who hops ──────────────────────────────────────────────────────────────────

/**
 * Hops, pauses and lanes for this walk now (each caller asks its own piece's switch)? The overworld within 64 tiles of
 * a human, the bot and the destination out of the Wilderness, BotAction's own answer (`base`, _mayHop: no PK, flee,
 * aggressor, sub-task, trade or lead) and no minimapExempt hook. Draws no dice.
 */
export function hopsHere(player: Player, base: () => boolean, destX: number, destZ: number): boolean {
    if (player.level !== 0 || player.z >= 6400) return false;
    if (wildernessLevelAt(player.x, player.z) > 0 || wildernessLevelAt(destX, destZ) > 0) return false;
    if (farFromHumans(player.level, player.x, player.z)) return false;
    if (!base()) return false;
    for (const hook of minimapExempt) if (hook(player)) return false;
    return true;
}

/**
 * A tile an overshoot or a lane never puts the bot on (bots ideas, round 3, the fixes: moveH-2): in the Wilderness (274
 * has no ditch: the border at z 3520 is open, and walks by Edgeville run along the rows under it), or where a monster far
 * stronger than the bot that hunts it can get at it (BotDanger fearedAt). Route variants refuse the same at their nodes.
 * Draws no dice.
 */
function keptOff(player: Player, x: number, z: number): boolean {
    return wildernessLevelAt(x, z) > 0 || fearedAt(player, x, z, player.level);
}

// ── the cut ───────────────────────────────────────────────────────────────────

const unpackX = (c: number): number => (c >> 14) & 0x3fff;
const unpackZ = (c: number): number => c & 0x3fff;
const pack = (x: number, z: number): number => ((x & 0x3fff) << 14) | (z & 0x3fff);
const cheb = (ax: number, az: number, bx: number, bz: number): number => Math.max(Math.abs(ax - bx), Math.abs(az - bz));

/** a cut this near a turn of the path (tiles along it) goes on the turn (players clicked at corners) */
const CORNER_SNAP = [-1, 1];

interface Cut {
    /** the waypoints to queue (to the flag) */
    queue: number[];
    /** the route after the flag (waypoints) */
    rest: number[];
    /** the flag */
    x: number;
    z: number;
    /** the flag is a turn of the path */
    corner: boolean;
    /** the step into the flag (an overshoot goes on along it) */
    inX: number;
    inZ: number;
    /** a tile of the hop (the bot to the flag) is in the Wilderness: a route through it near Edgeville (the fixes: moveH-2) */
    wild: boolean;
}

/**
 * The path `path` (waypoints from (px, pz), in order) cut at the first tile `hop` or more tiles from (px, pz) (or a turn
 * of the path a tile from it, HOP_MIN..HOP_MAX from the start: CORNER_SNAP), walked by 274's step rule: null when the
 * whole path lies within `hop`.
 */
export function cutPath(px: number, pz: number, path: ArrayLike<number>, hop: number): Cut | null {
    // the tiles walked, each with the index of the waypoint it heads for (seg) and the step into it
    const tx: number[] = [px];
    const tz: number[] = [pz];
    const seg: number[] = [0];
    let x = px;
    let z = pz;
    let cutAt = -1;
    const limit = hop + 3;
    for (let s = 0; s < path.length; s++) {
        const wx = unpackX(path[s]);
        const wz = unpackZ(path[s]);
        while (x !== wx || z !== wz) {
            x += Math.sign(wx - x);
            z += Math.sign(wz - z);
            tx.push(x);
            tz.push(z);
            seg.push(s);
            if (cutAt < 0 && cheb(x, z, px, pz) >= hop) cutAt = tx.length - 1;
            if (cutAt >= 0 && tx.length - 1 >= cutAt + 3) break;
        }
        if (cutAt >= 0 && tx.length - 1 >= cutAt + 3) break;
        if (cheb(x, z, px, pz) > limit + 20) break;
    }
    if (cutAt < 0 || cutAt >= tx.length - 1) return null;
    const turn = (i: number): boolean => i > 0 && i < tx.length - 1 && (Math.sign(tx[i] - tx[i - 1]) !== Math.sign(tx[i + 1] - tx[i]) || Math.sign(tz[i] - tz[i - 1]) !== Math.sign(tz[i + 1] - tz[i]));
    let at = cutAt;
    let corner = turn(cutAt);
    if (!corner) {
        for (const d of CORNER_SNAP) {
            const i = cutAt + d;
            if (i <= 0 || i >= tx.length - 1) continue;
            const reach = cheb(tx[i], tz[i], px, pz);
            if (reach < HOP_MIN || reach > HOP_MAX || !turn(i)) continue;
            at = i;
            corner = true;
            break;
        }
    }
    const s = seg[at];
    const fx = tx[at];
    const fz = tz[at];
    const queue: number[] = [];
    for (let k = 0; k < s; k++) queue.push(path[k]);
    const onWaypoint = unpackX(path[s]) === fx && unpackZ(path[s]) === fz;
    queue.push(onWaypoint ? path[s] : pack(fx, fz));
    const rest: number[] = [];
    for (let k = onWaypoint ? s + 1 : s; k < path.length; k++) rest.push(path[k]);
    if (rest.length === 0) return null;
    let wild = false;
    for (let i = 1; i <= at && !wild; i++) wild = wildernessLevelAt(tx[i], tz[i]) > 0;
    return { queue, rest, x: fx, z: fz, corner, inX: fx - tx[at - 1], inZ: fz - tz[at - 1], wild };
}

// ── a hopped walk under way ───────────────────────────────────────────────────

interface Hop {
    /** the walk's destination (walkTo's) */
    dx: number;
    dz: number;
    /** the current hop's flag */
    ex: number;
    ez: number;
    /** the route after the flag (waypoints, in order) */
    rest: number[];
    /** queued (or reached) at */
    tick: number;
    /** ticks to stand at the flag (0: none), decided when the hop was queued; when the stand ends (-1: not begun) */
    pause: number;
    until: number;
    /** an overshoot's flag: no click before it (the bot reaches it, then walks back) */
    over: boolean;
    /** typing at the flag since (-1: not) */
    typingSince: number;
}
const hops = new WeakMap<Player, Hop>();
/** the walk the bot's hops were last counted for (minimapStats.walks: one a destination) */
const counted = new WeakMap<Player, { x: number; z: number; tick: number }>();
/** a hop record older than this (since its queue or the flag) is dropped: the walk was left */
export const HOP_FRESH_TICKS = 60;
/** a typing bot stands at its flag at most this long (a model's reply may keep it at its keyboard 20 ticks) */
export const TYPING_WAIT = 25;
/** the next hop is clicked when the bot has this many tiles or fewer left to its flag (no stop) */
export const CHAIN_TILES = 3;

/** the hopped walk the bot is on (tests, the runner), or null */
export function hopOf(player: Player): Readonly<Hop> | null {
    return hops.get(player) ?? null;
}

/** the hop record dropped (a blocked route cleared, another walk) */
export function dropHop(player: Player): void {
    hops.delete(player);
}

/** a pause's length: 1-3 ticks 70 %, 4-8 25 %, 9-15 5 % */
function pauseTicks(): number {
    const u = Math.random();
    const [lo, hi] = u < 0.7 ? [1, 3] : u < 0.95 ? [4, 8] : [9, 15];
    return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * The hop to queue from (player.x, player.z) along `path` (the waypoints to walk), for a walk to (destX, destZ): the cut,
 * its pause rolled, an overshoot at a corner; the record kept for the next hop. The path whole (and no record) when it
 * lies within one hop. Callers have asked hopsHere.
 */
function nextHop(player: Player, path: ArrayLike<number>, destX: number, destZ: number): ArrayLike<number> {
    const t = movementTraits(player);
    const len = Math.max(HOP_MIN, Math.min(HOP_MAX, t.hopMean - HOP_SPREAD + Math.floor(Math.random() * (2 * HOP_SPREAD + 1))));
    const cut = cutPath(player.x, player.z, path, len);
    // (a hop through the Wilderness (a route that dips over the open border by Edgeville, the bot and its destination out
    // of it): no hop there, the leg walked whole as a walk in the Wilderness is; the next leg out of it hops again)
    if (!cut || cut.wild) {
        hops.delete(player);
        return path;
    }
    let queue = cut.queue;
    let rest = cut.rest;
    let flagX = cut.x;
    let flagZ = cut.z;
    let over = false;
    // an overshoot: straight on past the corner while each step is free, kept off nothing (keptOff: the Wilderness,
    // hunters) and the flag within the minimap's reach
    if (cut.corner && movementOn('overshoot') && Math.random() < t.overshoot * movementRates.overshoot) {
        const want = OVERSHOOT_TILES[0] + Math.floor(Math.random() * (OVERSHOOT_TILES[1] - OVERSHOOT_TILES[0] + 1));
        let ox = cut.x;
        let oz = cut.z;
        let steps = 0;
        while (steps < want && cheb(ox + cut.inX, oz + cut.inZ, player.x, player.z) <= HOP_MAX && canTravel(player.level, ox, oz, cut.inX, cut.inZ, 1, 0, CollisionType.NORMAL) && !keptOff(player, ox + cut.inX, oz + cut.inZ)) {
            ox += cut.inX;
            oz += cut.inZ;
            steps++;
        }
        if (steps >= OVERSHOOT_TILES[0]) {
            queue = [...queue, pack(ox, oz)];
            rest = [pack(cut.x, cut.z), ...rest];
            flagX = ox;
            flagZ = oz;
            over = true;
            minimapStats.overshoots++;
        }
    }
    const pause = movementOn('pauses') && Math.random() < t.pauseChance * movementRates.pauses ? pauseTicks() : 0;
    hops.set(player, { dx: destX, dz: destZ, ex: flagX, ez: flagZ, rest, tick: World.currentTick, pause, until: -1, over, typingSince: -1 });
    const n = Math.min(HOP_HIST, cheb(flagX, flagZ, player.x, player.z));
    minimapStats.hops[n] = (minimapStats.hops[n] ?? 0) + 1;
    const c = counted.get(player);
    if (!c || c.x !== destX || c.z !== destZ || World.currentTick - c.tick > HOP_FRESH_TICKS * 4) minimapStats.walks++;
    counted.set(player, { x: destX, z: destZ, tick: World.currentTick });
    return queue;
}

/**
 * BotAction._pathTowards, before it queues a graph walk's leg: the first hop of it, near a human (`ok`: hopsHere), or
 * the path as found.
 */
export function cutHop(player: Player, path: ArrayLike<number>, destX: number, destZ: number, ok: boolean): ArrayLike<number> {
    if (!ok || !movementOn('hops')) {
        hops.delete(player);
        return path;
    }
    return nextHop(player, path, destX, destZ);
}

/** the waypoints the bot has queued, from where it stands (the next one first) */
function queuedPath(player: Player): number[] {
    const out: number[] = [];
    for (let i = player.waypointIndex; i >= 0; i--) out.push(player.waypoints[i]);
    return out;
}

/**
 * BotAction.walkTo with waypoints queued: the next hop clicked before the flag (CHAIN_TILES left, no pause due, no
 * overshoot, not typing), the route from here (the queued tiles and the rest) cut again; null when not now. `ok`
 * (hopsHere) false: the rest queued whole, the record dropped.
 */
export function hopChain(player: Player, destX: number, destZ: number, ok: () => boolean): ArrayLike<number> | null {
    const hop = hops.get(player);
    if (!hop || player.waypointIndex < 0) return null;
    // (another walk's waypoints, or this one's left: the flag is not the end of the queue)
    const last = player.waypoints[0];
    if (hop.dx !== destX || hop.dz !== destZ || unpackX(last) !== hop.ex || unpackZ(last) !== hop.ez || World.currentTick - hop.tick > HOP_FRESH_TICKS) {
        hops.delete(player);
        return null;
    }
    if (hop.pause > 0 || hop.over || cheb(player.x, player.z, hop.ex, hop.ez) > CHAIN_TILES) return null;
    let left = 0;
    let x = player.x;
    let z = player.z;
    const queued = queuedPath(player);
    for (const c of queued) {
        left += cheb(x, z, unpackX(c), unpackZ(c));
        x = unpackX(c);
        z = unpackZ(c);
    }
    if (left > CHAIN_TILES || minimapHooks.typing(player)) return null;
    const path = [...queued, ...hop.rest];
    if (!ok()) {
        hops.delete(player);
        minimapStats.released++;
        return path;
    }
    return nextHop(player, path, destX, destZ);
}

/**
 * BotAction.walkTo with no waypoints: at the flag of a hopped walk to (destX, destZ), 'stand' while a pause or a line
 * being typed holds the bot there, else the next hop to queue; null when the bot is on no hopped walk there (the walk
 * plans its next leg as before).
 */
export function hopAtFlag(player: Player, destX: number, destZ: number, ok: () => boolean): 'stand' | ArrayLike<number> | null {
    const hop = hops.get(player);
    if (!hop) return null;
    const now = World.currentTick;
    if (hop.dx !== destX || hop.dz !== destZ || cheb(player.x, player.z, hop.ex, hop.ez) > 1 || now - hop.tick > HOP_FRESH_TICKS) {
        hops.delete(player);
        return null;
    }
    // a line being typed: no new click until it is said
    if (minimapHooks.typing(player)) {
        if (hop.typingSince < 0) {
            hop.typingSince = now;
            hop.tick = now;
            minimapStats.typingStands++;
        }
        if (now - hop.typingSince < TYPING_WAIT) return 'stand';
    }
    if (hop.pause > 0) {
        if (hop.until < 0) {
            hop.until = now + hop.pause;
            hop.tick = now;
            minimapStats.pauses++;
            minimapStats.pauseTicks += hop.pause;
        }
        if (now < hop.until) return 'stand';
    }
    const path = hop.rest;
    if (!ok()) {
        hops.delete(player);
        minimapStats.released++;
        return path;
    }
    return nextHop(player, path, destX, destZ);
}

/** the bot stands at a hop's flag for a pause or its typing (BotAction.isCrossing: the stuck checks wait) */
export function hopStanding(player: Player): boolean {
    const hop = hops.get(player);
    if (!hop || player.hasWaypoints()) return false;
    const now = World.currentTick;
    if (now - hop.tick > HOP_FRESH_TICKS) return false;
    return (hop.until >= 0 && now < hop.until + 1) || (hop.typingSince >= 0 && now - hop.typingSince <= TYPING_WAIT);
}

// ── lanes ─────────────────────────────────────────────────────────────────────

/** a leg's lane, kept while it heads for the same node (a re-plan in a wait for the search budget keeps it) */
const laneLegs = new WeakMap<Player, { node: number; x: number; z: number; tick: number }>();
const LANE_KEEP_TICKS = 60;

/**
 * BotAction._graphTarget: the tile a near-human leg (`ok`) aims at for intermediate graph node `node` at (nx, nz): the
 * node shifted sideways by the bot's lane ± 1, when that tile is free, runs straight and free to the node and is kept
 * off nothing (keptOff: the Wilderness, hunters); else the node. Never for the walk's last node or a gateway's approach
 * (the caller's).
 */
export function laneTarget(player: Player, node: number, nx: number, nz: number, ok: boolean): [number, number] {
    if (!ok || !movementOn('lanes')) return [nx, nz];
    const now = World.currentTick;
    const kept = laneLegs.get(player);
    if (kept && kept.node === node && now - kept.tick <= LANE_KEEP_TICKS) return [kept.x, kept.z];
    const lx = nx - player.x;
    const lz = nz - player.z;
    // the leg's direction (one of 8) and its perpendicular
    const ax = Math.abs(lx);
    const az = Math.abs(lz);
    const dx = ax >= 2 * az ? Math.sign(lx) : az >= 2 * ax ? 0 : Math.sign(lx);
    const dz = az >= 2 * ax ? Math.sign(lz) : ax >= 2 * az ? 0 : Math.sign(lz);
    const px = -dz;
    const pz = dx;
    const shift = clamp(movementTraits(player).lane + (Math.floor(Math.random() * 3) - 1), -LANE_MAX - 1, LANE_MAX + 1) * movementRates.lanes;
    let tx = nx;
    let tz = nz;
    const s = Math.round(shift);
    if (s !== 0 && (px !== 0 || pz !== 0)) {
        const cx = nx + px * s;
        const cz = nz + pz * s;
        // a free straight run from the shifted tile to the node (each step: the collision map)
        let x = cx;
        let z = cz;
        let free = true;
        while (x !== nx || z !== nz) {
            const sx = Math.sign(nx - x);
            const sz = Math.sign(nz - z);
            if (!canTravel(player.level, x, z, sx, sz, 1, 0, CollisionType.NORMAL)) {
                free = false;
                break;
            }
            x += sx;
            z += sz;
        }
        if (free && !isMapBlocked(cx, cz, player.level) && !keptOff(player, cx, cz)) {
            tx = cx;
            tz = cz;
            minimapStats.lanes++;
        }
    }
    laneLegs.set(player, { node, x: tx, z: tz, tick: now });
    return [tx, tz];
}

// ── route variants (H2) ───────────────────────────────────────────────────────

/** a trip takes the bot's habit for its goal this often, else a variant at random */
export const VARIANT_HABIT = 0.65;
/** a variant is kept at most this times variant 0's cost plus VARIANT_EXTRA tiles */
export const VARIANT_RATIO = 1.15;
export const VARIANT_EXTRA = 16;
export const VARIANTS = 3;
/** a fresh plan to the same goal within this long is the same walk: it keeps its variant (BotAction's SAME_WALK_TICKS) */
const VARIANT_SAME_WALK = 200;
const variantWalks = new WeakMap<Player, { goal: number; tick: number; v: number }>();
let forcedVariant: number | null = null;

/** (tests) every walk's variant this one (null: the game's choice). Never called by the game. */
export function forceRouteVariantForTest(v: number | null): void {
    forcedVariant = v;
}

/** the bot's habitual variant for a walk to graph node `goal` (seed salt `route-pref`) */
export function routeHabit(player: Player, goal: number): number {
    return nameSeed(player.username, `route-pref:${goal}`) % VARIANTS;
}

/** the variant the bot's walk to `goal` took last (tests, the runner), or -1 */
export function variantOf(player: Player, goal: number): number {
    const rec = variantWalks.get(player);
    return rec && rec.goal === goal ? rec.v : -1;
}

/**
 * BotAction._graphPlan: the route the bot walks to graph node `goal`, `base` being variant 0's (today's) and
 * `routeOf(v)` the graph's route for variant v (same limits and fear costs): the walk's variant (kept for a re-plan of
 * the same walk; else the bot's habit 65 %, a roll 35 %), when it is sane (VARIANT_RATIO × base + VARIANT_EXTRA, no new
 * Wilderness node, no new node of monsters that hunt the bot), else base. Off: base, with no dice.
 */
export function routeVariant(player: Player, goal: number, base: number[], routeOf: (v: number) => number[] | null): number[] {
    if (!movementOn('variants') || base.length < 2) return base;
    const now = World.currentTick;
    const rec = variantWalks.get(player);
    let v: number;
    if (forcedVariant !== null) v = forcedVariant;
    else if (rec && rec.goal === goal && now - rec.tick <= VARIANT_SAME_WALK) v = rec.v;
    else v = Math.random() < VARIANT_HABIT ? routeHabit(player, goal) : Math.floor(Math.random() * VARIANTS);
    variantWalks.set(player, { goal, tick: now, v });
    const stats = minimapStats.variants;
    if (v === 0) {
        stats.v0++;
        return base;
    }
    const alt = routeOf(v);
    if (!alt || alt.length < 2) {
        stats.none++;
        return base;
    }
    if (alt.length === base.length && alt.every((n, i) => n === base[i])) {
        stats.same++;
        return base;
    }
    if (routeCost(alt) > VARIANT_RATIO * routeCost(base) + VARIANT_EXTRA) {
        stats.long++;
        return base;
    }
    const had = new Set(base);
    for (const n of alt) {
        if (had.has(n)) continue;
        const [x, z] = nodePos(n);
        if (wildernessLevelAt(x, z) > 0) {
            stats.wild++;
            return base;
        }
        if (huntsMe(player, dangerOfNode(n))) {
            stats.hunt++;
            return base;
        }
    }
    if (v === 1) stats.v1++;
    else stats.v2++;
    return alt;
}
