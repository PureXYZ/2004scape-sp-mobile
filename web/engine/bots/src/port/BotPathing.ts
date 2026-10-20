// Bot path searches on 274's routefinder. Upstream added botFindPath/botWalkPath to its rev-254 GameMap.ts; here they
// live with the bots, so GameMap.ts stays untouched.
//
// Upstream passed maxWaypoints = -1, which the rev-254 rsmod WASM treated as "no limit". 274's TypeScript PathFinder
// pops a waypoint whenever `waypoints.length >= limit` (PathFinder.ts), so -1 keeps exactly ONE: every walk ended at
// the first turn and re-ran the 128×128 search. 25 is what PathingEntity.queueWaypoints can hold anyway (it keeps
// the last 25 of a longer path, i.e. upstream skipped the first turns of a path with more): identical for paths of up
// to 25 turns, and the bot re-paths after the 25th otherwise.
import rsmod, { CollisionType } from '#/engine/routefinder/index.js';
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';

export const BOT_MAX_WAYPOINTS = 25;

// Every search is counted (BotManager.stats().pathSearchesLastTick). Bot movement (BotAction._pathTowards) spends at
// most pathSearchBudget() of them per tick across all bots and carries on next tick when they run out, so one bot's
// fallback sweep can no longer cost 76 searches in a tick (BOTS.md §5). The budget grows with the bots online:
// PATH_SEARCHES_PER_TICK per 100 (12 up to 100 online, 60 at 500), so each bot waits about as long for its turn.
export const PATH_SEARCHES_PER_TICK = 12;

/** The budget for this many bots online: PATH_SEARCHES_PER_TICK per 100, never less than PATH_SEARCHES_PER_TICK. */
export function pathSearchBudgetFor(online: number): number {
    return Math.max(PATH_SEARCHES_PER_TICK, Math.ceil((Math.max(0, online) * PATH_SEARCHES_PER_TICK) / 100));
}

let budget = PATH_SEARCHES_PER_TICK;
let searchesThisTick = 0;

// port (the realism work, phase 3: level of detail L1): the searches go to the bots near a human first. A bot more than
// LOD_NEAR_TILES from every human (on its level: a dungeon is 6400 tiles off) may start at most a third of a tick's
// budget (farSearchBudget); the rest is the near bots'. Nobody sees a far bot start its walk a moment later, and the
// bots' share of the tick falls where most of them are far: at 500 bots 86 % of the AI's time went to bots more than 64
// tiles from the human, 46 % of it route searches. Counted by the search's start tile
// (the bot's own); with no human in the world every bot is near (the world empties then anyway).
export const LOD_NEAR_TILES = 64;
let humans: Player[] = [];
let farSearches = 0;

/** Is (x, z) more than LOD_NEAR_TILES from every human on `level`? (no human: false) */
export function farFromHumans(level: number, x: number, z: number): boolean {
    if (humans.length === 0) return false;
    for (const h of humans) {
        if (h.slot !== -1 && h.level === level && Math.abs(h.x - x) <= LOD_NEAR_TILES && Math.abs(h.z - z) <= LOD_NEAR_TILES) return false;
    }
    return true;
}

/**
 * port (the variety work, round 1, track F: the login fill, ISS-1): for FILL_BOOST_TICKS after a login fill's last bot
 * came, the tick's searches are FILL_BOOST times the budget, half of them the far bots' (a third otherwise): every bot
 * of a fill wants its first routes at once, and with 4 far searches a tick at 100 online the last far bots waited 100+
 * ticks for theirs. The phone pays a burst there anyway (the logins' own); the world tick's p95 is measured with it
 * (BOTS.md §7, variety round 1, track F).
 */
export const FILL_BOOST = 2;
export const FILL_BOOST_TICKS = 200;
let boostUntil = -1;

/** BotManager: a fill's bot logged in now; the boost lasts FILL_BOOST_TICKS from the last one */
export function boostPathSearches(untilTick: number): void {
    boostUntil = Math.max(boostUntil, untilTick);
}

/** (tests) no boost from here on */
export function endPathBoostForTest(): void {
    boostUntil = -1;
}

/** Is the fill's boost on this tick? */
export function pathBoostOn(): boolean {
    return World.currentTick <= boostUntil;
}

/** the searches all bots together may start this tick (the budget, boosted after a fill) */
function tickBudget(): number {
    return pathBoostOn() ? budget * FILL_BOOST : budget;
}

/** The searches the far bots together may start in a tick: a third of the budget (at least 1); half during a fill's boost. */
export function farSearchBudget(): number {
    return pathBoostOn() ? Math.max(1, Math.floor(tickBudget() / 2)) : Math.max(1, Math.floor(budget / 3));
}

/** Far bots' searches this tick (tests, the report). */
export function farSearchesThisTick(): number {
    return farSearches;
}

function count(level: number, x: number, z: number): void {
    searchesThisTick++;
    if (farFromHumans(level, x, z)) farSearches++;
}

/** BotManager.start: the searches all bots together may start per tick. */
export function setPathSearchBudget(searches: number): void {
    budget = Math.max(1, Math.floor(searches) || PATH_SEARCHES_PER_TICK);
}

export function pathSearchBudget(): number {
    return budget;
}

/** BotManager.tick, before any bot moves (and the humans' list for the level of detail, a pass over the players). */
export function beginPathTick(): void {
    searchesThisTick = 0;
    farSearches = 0;
    humans = [];
    for (const p of World.playerLoop.all()) if (p.is_bot !== true && p.slot !== -1) humans.push(p);
}

export function pathSearchesThisTick(): number {
    return searchesThisTick;
}

/**
 * Searches the movement code may still start this tick; for a bot (`from`: its position) far from every human, at most
 * what is left of the far bots' third (level of detail L1).
 */
export function pathBudgetLeft(from?: { x: number; z: number; level: number }): number {
    const left = Math.max(0, tickBudget() - searchesThisTick);
    if (!from || !farFromHumans(from.level, from.x, from.z)) return left;
    return Math.min(left, Math.max(0, farSearchBudget() - farSearches));
}

/** Exact path to (destX, destZ), or empty if the destination itself cannot be reached. */
export function botFindPath(level: number, srcX: number, srcZ: number, destX: number, destZ: number): Uint32Array {
    count(level, srcX, srcZ);
    return rsmod.findPath(level, srcX, srcZ, destX, destZ, 1, 1, 1, 0, -1, false, 0, BOT_MAX_WAYPOINTS, CollisionType.NORMAL);
}

/** Path to (destX, destZ), or to the closest reachable tile near it (moveNear), like a player's walk click. */
export function botWalkPath(level: number, srcX: number, srcZ: number, destX: number, destZ: number): Uint32Array {
    count(level, srcX, srcZ);
    return rsmod.findPath(level, srcX, srcZ, destX, destZ, 1, 1, 1, 0, -1, true, 0, BOT_MAX_WAYPOINTS, CollisionType.NORMAL);
}

/**
 * port: a route to where a player can use a loc (its size, angle, shape and approach sides), as the client sends with
 * a loc click. 274 routes no player to a loc itself: its server walks the route that came with the click
 * (Player.pathToPathingTarget routes only to NPCs and players). Counted, and never refused for the budget: a click is
 * one short search, and a bot whose click went without a route got "I can't reach that!".
 */
export function botPathToLoc(level: number, srcX: number, srcZ: number, destX: number, destZ: number, width: number, length: number, angle: number, shape: number, forceapproach: number, moveNear: boolean): Uint32Array {
    count(level, srcX, srcZ);
    return rsmod.findPath(level, srcX, srcZ, destX, destZ, 1, width, length, angle, shape, moveNear, forceapproach, BOT_MAX_WAYPOINTS, CollisionType.NORMAL);
}

/**
 * port (the variety work, round 1, track F: ISS-11): a route to where a player attacks or talks to an NPC of this size
 * (274's findPathToEntity: shape -2, the closest tile when none reaches), counted, within the caller's check of the budget
 */
export function botPathToEntity(level: number, srcX: number, srcZ: number, destX: number, destZ: number, width: number, length: number): Uint32Array {
    count(level, srcX, srcZ);
    return rsmod.findPath(level, srcX, srcZ, destX, destZ, 1, width, length, 0, -2, true, 0, BOT_MAX_WAYPOINTS, CollisionType.NORMAL);
}

/** port (variety round 1, F): does a player on (srcX, srcZ) reach the NPC there from where it stands (274's reachedEntity: no wall between, no corner)? */
export function botReachedEntity(level: number, srcX: number, srcZ: number, destX: number, destZ: number, width: number, length: number): boolean {
    return rsmod.reached(level, srcX, srcZ, destX, destZ, width, length, 1, 0, -2, 0);
}

/** port: can a player on (srcX, srcZ) use the loc from where it stands (no search)? */
export function botReachedLoc(level: number, srcX: number, srcZ: number, destX: number, destZ: number, width: number, length: number, angle: number, shape: number, forceapproach: number): boolean {
    return rsmod.reached(level, srcX, srcZ, destX, destZ, width, length, 1, angle, shape, forceapproach);
}
