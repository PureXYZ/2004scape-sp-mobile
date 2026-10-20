// port (the realism work, phase 3, "where bots are"): a standing bot's own tile near its spot (a hang-out, a linger, a
// thief or a smith between rounds, a social regular), so that bots do not stand on one another. The humanlike report's
// H4 counts the bots that stand idle on a tile another player stands on: 2.3-2.9 % at 100 bots and 7.4 % at 500 before
// (thieves round their mark, smiths at the anvil, social bots at their hub, all on the one tile their walk ended on).
//
// A claim is a tile the bot walks to and stands on: free (no other bot's claim, nobody standing there), walkable, and
// reachable from the spot without leaving its square (BotAction.tilesInSquare: never a tile behind the park's wall or
// across the bank counter). It holds until the bot gives it back (releaseStandTile: its stand ends, it walks off, its task
// is reset, it logs out). A claim whose bot left the world, or that bot's newer claim, is free again: no claim outlives
// its bot even if a caller forgets to give it back.
//
// The work is done once per stand, not per tick: a flood fill of the spot's square (radius 6: 169 tiles at most) and a
// look at the players in the zones it covers. A caller asks again when its bot left its tile, not every tick.
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import ZoneMap from '#/engine/zone/ZoneMap.js';
import LocType from '#/cache/config/LocType.js';
import { tilesInSquare, walkTo } from '#/engine/bot/BotAction.js';
import { BotCollisionMap } from '#/engine/bot/BotCollisionMap.js';
import { botReachedLoc, botWalkPath } from '#/engine/bot/port/BotPathing.js';

/** the largest radius a claim looks within (a bigger one is cut to this: the fill stays cheap) */
export const MAX_STAND_RADIUS = 8;

interface Claim {
    bot: Player;
    key: number;
    x: number;
    z: number;
    level: number;
}

/** tile key -> its claim; bot -> its claim */
const byTile = new Map<number, Claim>();
const byBot = new WeakMap<Player, Claim>();

const tileKey = (x: number, z: number, level: number): number => (level << 28) | (x << 14) | z;

/** A claim that still holds: its bot is in the world and holds this one (not a newer one). */
function live(claim: Claim | undefined): claim is Claim {
    if (!claim) return false;
    if (claim.bot.slot === -1 || byBot.get(claim.bot) !== claim) {
        byTile.delete(claim.key);
        return false;
    }
    return true;
}

/** Is someone else (a player, a bot) standing on the tile now? Reads the zone if it exists (never makes one). */
function occupied(x: number, z: number, level: number, bot: Player): boolean {
    const zones = (World.gameMap as unknown as { zonemap?: { zones?: Map<number, { getAllPlayersUnsafe(): IterableIterator<Player> }> } }).zonemap?.zones;
    const zone = zones instanceof Map ? zones.get(ZoneMap.zoneIndex(x, z, level)) : undefined;
    if (!zone) return false;
    for (const p of zone.getAllPlayersUnsafe()) if (p !== bot && p.x === x && p.z === z && p.level === level) return true;
    return false;
}

/** Is the tile claimed by another bot? (a live claim) */
export function isTileClaimed(x: number, z: number, level: number, except: Player | null = null): boolean {
    const claim = byTile.get(tileKey(x, z, level));
    return live(claim) && claim.bot !== except;
}

/** The tile the bot holds, or null. */
export function standTileOf(bot: Player): [number, number, number] | null {
    const claim = byBot.get(bot);
    return claim && claim.bot.slot !== -1 ? [claim.x, claim.z, claim.level] : null;
}

/** Another bot's live claim or someone standing there: the tile is not free for `bot`. */
function taken(x: number, z: number, level: number, bot: Player): boolean {
    return isTileClaimed(x, z, level, bot) || occupied(x, z, level, bot);
}

/**
 * A free walkable tile of the bot's own within `radius` of (x, z), held until released; null: none. The bot's current
 * claim is kept when it lies within `radius` of (x, z) (and passes `ok`); else it is given up for the new one. `ok`
 * (optional): a further test of a tile (a thief's: next to its mark; a smith's: one the anvil is used from). Of the
 * free tiles, one with no claimed neighbour is preferred (players stand a step apart), the nearer the likelier.
 */
export function claimStandTile(bot: Player, x: number, z: number, level: number, radius: number, ok?: (x: number, z: number) => boolean): [number, number] | null {
    const r = Math.max(0, Math.min(MAX_STAND_RADIUS, Math.floor(radius)));
    const held = byBot.get(bot);
    if (held && live(held) && held.level === level && Math.max(Math.abs(held.x - x), Math.abs(held.z - z)) <= r && (!ok || ok(held.x, held.z)) && !occupied(held.x, held.z, level, bot)) return [held.x, held.z];
    releaseStandTile(bot);
    // (the fill starts on the spot, or on the walkable tile nearest it that opens on a few others: Varrock square's spot
    // is its fountain, a furnace's its own tile)
    const reach = fillNear(level, x, z, r);
    // (in rings from the spot: the fill's order is by steps, near ones first)
    const free: [number, number, number][] = [];
    for (const packed of reach) {
        const tx = packed >> 14;
        const tz = packed & 0x3fff;
        // (the fill starts on the spot itself, which may be a counter or a wall: never stood on)
        if (Math.max(Math.abs(tx - x), Math.abs(tz - z)) > r || BotCollisionMap.isCsvBlocked(level, tx, tz) || taken(tx, tz, level, bot) || (ok && !ok(tx, tz))) continue;
        free.push([tx, tz, Math.max(Math.abs(tx - x), Math.abs(tz - z))]);
    }
    return take(bot, level, free);
}

/** One of the free tiles ([x, z, distance]) for the bot: a step apart from the others where it can, the nearer the likelier. */
function take(bot: Player, level: number, free: [number, number, number][]): [number, number] | null {
    if (free.length === 0) return null;
    // (a step apart from the others where it can: a tile with no claimed or occupied neighbour)
    const apart = free.filter(([tx, tz]) => !neighbourTaken(tx, tz, level, bot));
    const pool = apart.length > 0 ? apart : free;
    // the nearer the likelier: weight 1 / (1 + d)
    let roll = Math.random() * pool.reduce((sum, t) => sum + 1 / (1 + t[2]), 0);
    let pick = pool[pool.length - 1];
    for (const t of pool) {
        roll -= 1 / (1 + t[2]);
        if (roll <= 0) {
            pick = t;
            break;
        }
    }
    const claim: Claim = { bot, key: tileKey(pick[0], pick[1], level), x: pick[0], z: pick[1], level };
    byTile.set(claim.key, claim);
    byBot.set(bot, claim);
    return [claim.x, claim.z];
}

/**
 * The tiles a player reaches within the square of `r` round (x, z): from (x, z) when it is walkable and opens on others,
 * else from the nearest walkable tile within 4 that does (ring by ring: a tile walled in by a fountain's water does not
 * count). Empty when none does.
 */
function fillNear(level: number, x: number, z: number, r: number): Set<number> {
    const from = (sx: number, sz: number): Set<number> | null => {
        if (BotCollisionMap.isCsvBlocked(level, sx, sz)) return null;
        const fill = tilesInSquare(level, sx, sz, r + Math.max(Math.abs(sx - x), Math.abs(sz - z)));
        return fill.size >= 4 ? fill : null;
    };
    const here = from(x, z);
    if (here) return here;
    for (let d = 1; d <= Math.min(4, Math.max(1, r)); d++) {
        for (let dx = -d; dx <= d; dx++) {
            for (let dz = -d; dz <= d; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== d) continue;
                const fill = from(x + dx, z + dz);
                if (fill) return fill;
            }
        }
    }
    return new Set();
}

function neighbourTaken(x: number, z: number, level: number, bot: Player): boolean {
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            if ((dx !== 0 || dz !== 0) && taken(x + dx, z + dz, level, bot)) return true;
        }
    }
    return false;
}

/** The bot gives its tile back (it walks off, its stand ends, it logs out). */
export function releaseStandTile(bot: Player): void {
    const claim = byBot.get(bot);
    if (!claim) return;
    byBot.delete(bot);
    if (byTile.get(claim.key) === claim) byTile.delete(claim.key);
}

/** How far a step to its own tile is taken at once (tiles): a short search, as a click's */
const STEP_TILES = 4;

/**
 * The bot steps to its tile (x, z): within STEP_TILES its route is searched at once, as a click's is (counted, not held
 * for the path budget: a far bot's step to its own tile waited behind the far bots' walks, level of detail L1, and stood
 * on the shared tile meanwhile); further, a walk (walkTo). False when no route was found.
 */
export function stepToTile(bot: Player, x: number, z: number): boolean {
    if (bot.x === x && bot.z === z) return true;
    if (Math.max(Math.abs(bot.x - x), Math.abs(bot.z - z)) > STEP_TILES) {
        walkTo(bot, x, z, bot.level);
        return true;
    }
    const path = botWalkPath(bot.level, bot.x, bot.z, x, z);
    if (path.length === 0) return false;
    bot.queueWaypoints(path);
    return true;
}

/** Is another player standing on the bot's own tile? (a caller then claims one: the stand is shared) */
export function sharesTile(bot: Player): boolean {
    return occupied(bot.x, bot.z, bot.level, bot);
}

/** A loc a bot works at (a stall, a furnace, an anvil, a range): where it is, its size and how it is approached. */
export interface WorkLoc {
    x: number;
    z: number;
    level: number;
    width: number;
    length: number;
    angle: number;
    shape: number;
    type: number;
}

/** Can a player on (x, z) use the loc from there (the game's own reach test: no step needed)? */
export function usesLocFrom(loc: WorkLoc, x: number, z: number): boolean {
    return botReachedLoc(loc.level, x, z, loc.x, loc.z, loc.width, loc.length, loc.angle, loc.shape, LocType.get(loc.type).forceapproach);
}

/**
 * A free tile of the bot's own a step or two from the loc, from which it does NOT use it (it waits its turn there while
 * every tile it is used from is taken: a busy furnace, a stall with thieves on every side); null: none.
 */
export function claimWaitTile(bot: Player, loc: WorkLoc, radius = 3): [number, number] | null {
    return claimStandTile(bot, loc.x, loc.z, loc.level, radius + Math.max(loc.width, loc.length) - 1, (x, z) => !usesLocFrom(loc, x, z));
}

/**
 * A free tile of the bot's own from which it uses the loc (the game's reach: its approach sides, no wall between), within
 * `radius` of its sides, held as claimStandTile's; null: none. Its current claim is kept while it is one of them. The
 * tiles are the loc's own reach tiles (not a fill: a furnace's room has walls the fill would start on the wrong side of),
 * the nearer the bot the likelier.
 */
export function claimLocTile(bot: Player, loc: WorkLoc, radius = 1): [number, number] | null {
    const r = Math.max(1, Math.min(MAX_STAND_RADIUS, Math.floor(radius)));
    const held = byBot.get(bot);
    if (held && live(held) && held.level === loc.level && usesLocFrom(loc, held.x, held.z) && !occupied(held.x, held.z, held.level, bot)) return [held.x, held.z];
    releaseStandTile(bot);
    const free: [number, number, number][] = [];
    for (let tx = loc.x - r; tx < loc.x + loc.width + r; tx++) {
        for (let tz = loc.z - r; tz < loc.z + loc.length + r; tz++) {
            if (BotCollisionMap.isCsvBlocked(loc.level, tx, tz) || taken(tx, tz, loc.level, bot) || !usesLocFrom(loc, tx, tz)) continue;
            free.push([tx, tz, Math.max(Math.abs(tx - bot.x), Math.abs(tz - bot.z))]);
        }
    }
    return take(bot, loc.level, free);
}

/** Live claims (tests, the report). */
export function claimedTiles(): number {
    let n = 0;
    for (const claim of [...byTile.values()]) if (live(claim)) n++;
    return n;
}
