// port (the bots ideas work, round 1, Track B: A7, safespot culture; handed to Track B by the
// spec): rangers and mages at the Edgeville dungeon's hill giants shoot from 2004's safespots, a tile each, and pick up
// their arrows and drops now and then (every 5 minutes at most), back on the tile after.
//
//   - the tiles (data/safespots.json): 3 in the giants' room (the research hoped for 8), each with the giant it is safe
//     from, found by a sweep in the real 274 world (of 1,821 tile-and-giant pairs, those where a ranger shot the giant
//     80 ticks from every start of its wander, the giant kept alive and chasing, never moving the ranger nor hitting it)
//     and checked by test/loot.test.mjs; a shot whose giant has left its sight is stopped (safespotGuard), or the game
//     would walk the ranger off its tile after it; from some of the giant's places the engine's approach steps a ranger
//     a tile or two toward it at its first shot, and the turn walks it back (the giant cannot follow);
//   - a ranger or mage of that spot (tasks/RangedMagicTask, its step's extra.safespots: BotKnowledge) claims a free tile
//     when it gets to the room, walks onto it and shoots only the giants of its tile in range from it (the task's own
//     attack, the game's rules); with every tile taken it asks one standing on one, half the time ("u using this
//     spot?"; the other answers 7 times in 10: "5 more mins", "find ur own lol"; an ask it could not say then is said
//     later in the wait), waits 1-3 minutes fighting as before and looks again (3 in 10 wait without a word), or goes
//     elsewhere (2 in 10: its task ends, the planner picks again);
//   - a tile is the claimer's until it leaves the room, its task changes or it logs out (a claim of one gone is freed
//     when the next looks).
// The lines (data/lines2004-loot.json's safespot-* groups) take their speakers' due slots (countAsOwnLine). The pair goes
// to port/BotLoot's onRivalry ('safespot') for theme D's ties. Every roll is Math.random; nothing reads the wall clock.
import type Npc from '#/engine/entity/Npc.js';
import Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import NpcType from '#/cache/config/NpcType.js';
import { walkTo } from '#/engine/bot/BotAction.js';
import { isApproached } from '#/engine/GameMap.js';
import type { SkillStep } from '#/engine/bot/BotKnowledge.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { noteRivalry, sayLootLine } from '#/engine/bot/port/BotLoot.js';
import { scheduleInTicks } from '#/engine/bot/port/BotSchedule.js';
import safespotsJson from '../../data/safespots.json';

interface SafeTile {
    at: [number, number];
    /** the spawns of the monsters it is safe from */
    giants: [number, number][];
}
export interface SafeSpot {
    key: string;
    level: number;
    centre: [number, number];
    tiles: SafeTile[];
}

const SPOTS: readonly SafeSpot[] = (safespotsJson as unknown as { spots: SafeSpot[] }).spots;

/** a giant of a tile's is shot from this near the tile (a shortbow's 7; a spell's 10) */
const SHOT_RANGE = 7;
/** a spawn and the giant of it: the giant within its wander of its spawn (3: where the probe found the tile safe) */
const SPAWN_SLACK = 3;
/** the room: within this of its centre (else the bot is on its way, or gone) */
const ROOM_RANGE = 40;
/** every tile taken: ask (half), wait silently (3 in 10), go elsewhere (2 in 10); after the first look, wait or go */
const ASK = 0.5;
const WAIT = 0.3;
const LATER_WAIT = 0.6;
/** the wait before it looks again: 1-3 minutes */
const WAIT_TICKS: [number, number] = [100, 300];
/** the one asked answers this often, a moment later */
const ANSWER = 0.7;
/**
 * (round 1's left-overs) an ask it could not say at its look (in a practice with another bot, typing a line, nobody on
 * a tile near: sayLootLine said nothing) is tried again this often while it waits, until it is said or the wait is over
 * (safespotAskDue); before, it never asked (loot.test's queue at seed 7: the newcomer was in a practice, port/BotStage)
 */
const ASK_RETRY_TICKS = 10;
/** a claim of a bot not on its tile this long is free again */
const CLAIM_STALE = 300;
/** on its tile it goes for its arrows and drops at most this often (5 minutes): it holds the tile meanwhile */
const LOOT_EVERY = 300;
/**
 * with no giant of its tile to shoot this long (a respawn is 60 ticks; another's fight) it gives the tile up, before a
 * long idle stand (the humanlike report's H19 counts 2 minutes and more), and looks for one again IDLE_REQUEUE later
 * (round 1's left-overs: T3: it moves to a free tile whose giant it can shoot now, if one has; else in those IDLE_REQUEUE
 * ticks it takes a tile only when one has, looked for every IDLE_LOOK: port/BotSafespots' left-overs block)
 */
const HOLD_IDLE = 180;
const IDLE_REQUEUE = 600;

interface Claim {
    bot: Player;
    spot: SafeSpot;
    tile: SafeTile;
    /** the last tick it stood on the tile (or claimed it) */
    seen: number;
    /** the last tick it went off it for its arrows and drops */
    lootAt: number;
    /** the last tick it had its giant to shoot (or claimed the tile) */
    shotAt: number;
}
const claims = new Map<SafeTile, Claim>();
const byBot = new Map<Player, Claim>();
/** a bot's queue at a full room: until when it waits, its looks this visit, when it tries its unsaid ask again (null: none) */
interface Queue {
    until: number;
    looks: number;
    askAt: number | null;
}
const queues = new WeakMap<Player, Queue>();
/** when a bot last went elsewhere from a full room; not queued again for this long (30 minutes) */
const leftAt = new WeakMap<Player, number>();
const LEFT_TICKS = 3000;

/** the safespots of a step's spot (its extra.safespots), or null */
export function safespotOf(step: SkillStep | null | undefined): SafeSpot | null {
    const key = (step?.extra as { safespots?: string } | undefined)?.safespots;
    return key ? (SPOTS.find(s => s.key === key) ?? null) : null;
}

/** the tile a bot holds, or null (the humanlike report: time on a safespot) */
export function safespotHeld(bot: Player): [number, number] | null {
    return byBot.get(bot)?.tile.at ?? null;
}

/** every tile of every spot (the report, the tests) */
export function safespotTiles(): { key: string; level: number; at: [number, number] }[] {
    return SPOTS.flatMap(s => s.tiles.map(t => ({ key: s.key, level: s.level, at: t.at })));
}

/** the bot gives its tile back (its task reset, it left the room) */
export function releaseSafespot(bot: Player): void {
    const c = byBot.get(bot);
    if (!c) return;
    byBot.delete(bot);
    if (claims.get(c.tile) === c) claims.delete(c.tile);
}

function stale(c: Claim, now: number): boolean {
    if (c.bot.slot === -1 || !c.bot.is_bot || BotManager.botFor(c.bot) === null) return true;
    if (c.bot.x === c.tile.at[0] && c.bot.z === c.tile.at[1]) {
        c.seen = now;
        return false;
    }
    return now - c.seen > CLAIM_STALE;
}

/** a free tile of the spot (nobody's claim, nobody standing on it), the nearest the bot; null when all are taken */
function freeTile(spot: SafeSpot, bot: Player, now: number): SafeTile | null {
    let best: SafeTile | null = null;
    let bestD = Infinity;
    for (const tile of spot.tiles) {
        const c = claims.get(tile);
        if (c && c.bot !== bot && !stale(c, now)) continue;
        if (c && c.bot !== bot) releaseSafespot(c.bot);
        if (standingOn(tile, spot.level, bot)) continue;
        const d = Math.max(Math.abs(bot.x - tile.at[0]), Math.abs(bot.z - tile.at[1]));
        if (d < bestD) {
            best = tile;
            bestD = d;
        }
    }
    return best;
}

function standingOn(tile: SafeTile, level: number, except: Player): boolean {
    const zone = World.gameMap.getZone(tile.at[0], tile.at[1], level);
    if (!zone) return false;
    for (const p of zone.getAllPlayersSafe()) if (p !== except && p.x === tile.at[0] && p.z === tile.at[1]) return true;
    return false;
}

/** one of the tile's giants it may shoot from the tile: alive, near its spawn, within SHOT_RANGE, free (`ok`) */
function safeTarget(bot: Player, spot: SafeSpot, tile: SafeTile, ok: (npc: Npc) => boolean): Npc | null {
    for (const [sx, sz] of tile.giants) {
        const npc = giantOf(sx, sz, spot.level);
        if (!npc || Math.max(Math.abs(npc.x - sx), Math.abs(npc.z - sz)) > SPAWN_SLACK) continue;
        if (!inShot(bot, npc) || !ok(npc)) continue;
        return npc;
    }
    return null;
}

/** can the bot shoot it from where it stands: within SHOT_RANGE, the engine's own approach test (274's isApproached: line of sight, its size) */
export function inShot(bot: Player, npc: Npc): boolean {
    if (npc.level !== bot.level || Math.max(Math.abs(npc.x - bot.x), Math.abs(npc.z - bot.z)) > SHOT_RANGE) return false;
    return isApproached(bot.level, bot.x, bot.z, npc.x, npc.z, 1, 1, npc.width ?? 1, npc.length ?? 1);
}

/** the giant of a spawn (the zones round it: it wanders), or null (dead, gone) */
export function giantOf(sx: number, sz: number, level: number): Npc | null {
    const seen = new Set<unknown>();
    for (let dx = -SPAWN_SLACK - 2; dx <= SPAWN_SLACK + 2; dx += SPAWN_SLACK + 2) {
        for (let dz = -SPAWN_SLACK - 2; dz <= SPAWN_SLACK + 2; dz += SPAWN_SLACK + 2) {
            const zone = World.gameMap.getZone(sx + dx, sz + dz, level);
            if (!zone || seen.has(zone)) continue;
            seen.add(zone);
            for (const npc of zone.getAllNpcsSafe()) if (npc.startX === sx && npc.startZ === sz && NpcType.get(npc.type).debugname === 'giant') return npc;
        }
    }
    return null;
}

/** what the task does this turn at a safespot room: 'hold' (to its tile, or standing on it), a giant to shoot, 'leave' (go elsewhere), null (as before: on its way, or waiting its turn) */
export type SafeTurn = 'hold' | 'leave' | Npc | null;

/**
 * (tasks/RangedMagicTask's patrol and scan) the bot's turn at its step's safespot room: a claimed tile walked to and held,
 * the giants of its tile shot from it; a full room's queue. `ok`: the task's own test of a target (not claimed, not one
 * it could not hit). `shootOnly` (its scan): with no claim, null (as before); with one, its giant, or its tile, or null
 * when its arrows and drops are due (LOOT_EVERY).
 */
export function safespotTurn(bot: Player, step: SkillStep, ok: (npc: Npc) => boolean, shootOnly = false): SafeTurn {
    const spot = safespotOf(step);
    if (!spot || bot.level !== spot.level || Math.max(Math.abs(bot.x - spot.centre[0]), Math.abs(bot.z - spot.centre[1])) > ROOM_RANGE) {
        releaseSafespot(bot);
        queues.delete(bot);
        return null;
    }
    const now = World.currentTick;
    let mine = byBot.get(bot);
    if (mine && mine.spot !== spot) {
        releaseSafespot(bot);
        mine = undefined;
    }
    if (!mine && shootOnly) return null;
    if (!mine) {
        const q = queues.get(bot);
        // (its ask not said at its look is tried again from its task's every tick: safespotAskDue)
        if (q && now < q.until) return null;
        // (it went elsewhere a while ago, and its planner sent it back: it fights as before, no second queue)
        if (now - (leftAt.get(bot) ?? -Infinity) < LEFT_TICKS) return null;
        // (round 1's left-overs: T3) a free tile whose giant it can shoot now before the nearest free one; after a tile
        // given up idle only such a one, looked for now and then (it fights as before meanwhile: usableTileFor)
        const pick = usableTileFor(spot, bot, now, ok);
        if (pick === 'wait') return null;
        const tile = pick ?? freeTile(spot, bot, now);
        if (!tile) return queue(bot, spot, now);
        queues.delete(bot);
        mine = { bot, spot, tile, seen: now, lootAt: now, shotAt: now };
        claims.set(tile, mine);
        byBot.set(bot, mine);
    }
    const [tx, tz] = mine.tile.at;
    if (bot.x !== tx || bot.z !== tz) {
        if (!bot.hasWaypoints()) walkTo(bot, tx, tz, spot.level);
        return 'hold';
    }
    mine.seen = now;
    const target = safeTarget(bot, spot, mine.tile, ok);
    if (target) mine.shotAt = now;
    // (its giant gone this long, dead and not back, or another's: the tile given up, it fights as before; no queue again
    // for a while: a person moves on after a minute or two)
    else if (now - mine.shotAt > HOLD_IDLE) {
        releaseSafespot(bot);
        idleAt.set(bot, now);
        safespotStats.idle++;
        // (round 1's left-overs: T3) to another free tile whose giant it can shoot now, as a person whose giant others
        // keep killing moves to the next safespot; none: it fights as before and looks again now and then
        // (usableTileFor). It fought off the tiles 600 ticks, whatever the others: m100 seed 7 at 10x, 145 of the rangers'
        // 256 samples there off a tile, 58 of them after a give-up
        const other = usableTile(spot, bot, now, ok, mine.tile);
        if (!other) return null;
        lookAt.delete(bot);
        safespotMoves.moved++;
        claimTileFor(bot, spot, other, now);
        return 'hold';
    }
    if (target || !shootOnly) return target ?? 'hold';
    // (nothing to shoot: its arrows and drops now and then, LOOT_EVERY, else it holds its tile)
    if (now - mine.lootAt < LOOT_EVERY) return 'hold';
    mine.lootAt = now;
    return null;
}

/** every tile taken: ask one standing on one (half the first time), or wait without a word, or go elsewhere */
function queue(bot: Player, spot: SafeSpot, now: number): SafeTurn {
    const q = queues.get(bot) ?? { until: now, looks: 0, askAt: null };
    q.looks++;
    q.askAt = null;
    const roll = testRates.choice === 'ask' ? 0 : testRates.choice === 'wait' ? ASK : testRates.choice === 'leave' ? 0.999 : Math.random();
    const first = q.looks === 1;
    if (first ? roll >= ASK + WAIT : roll >= LATER_WAIT) {
        queues.delete(bot);
        leftAt.set(bot, now);
        safespotStats.left++;
        return 'leave';
    }
    q.until = now + WAIT_TICKS[0] + Math.floor(Math.random() * (WAIT_TICKS[1] - WAIT_TICKS[0] + 1));
    queues.set(bot, q);
    safespotStats.waits++;
    if (first && roll < ASK) ask(bot, spot, q, now);
    return null;
}

/**
 * (tasks/RangedMagicTask's every tick) a full room's queue whose ask was not said at its look: tried again, its
 * ASK_RETRY_TICKS over, whatever the bot does meanwhile. It waits its turn fighting as before (its fight, its loot, its
 * scan), and the retry in safespotTurn was reached only from its patrol, which such a bot is seldom in (its scan's turn
 * returns before the queue): loot.test seed 18, the newcomer in a practice at its look, free 5 ticks later, fought 120
 * ticks and never asked
 */
export function safespotAskDue(bot: Player, step: SkillStep): void {
    const q = queues.get(bot);
    if (!q || q.askAt === null) return;
    const now = World.currentTick;
    if (now < q.askAt || now >= q.until || byBot.has(bot)) return;
    const spot = safespotOf(step);
    if (!spot || bot.level !== spot.level || Math.max(Math.abs(bot.x - spot.centre[0]), Math.abs(bot.z - spot.centre[1])) > ROOM_RANGE) return;
    ask(bot, spot, q, now);
}

/** it asks the nearest one on a tile ("u using this spot?"), who answers a moment later; not said, again ASK_RETRY_TICKS on while it waits */
function ask(bot: Player, spot: SafeSpot, q: Queue, now: number): void {
    q.askAt = now + ASK_RETRY_TICKS;
    // the nearest one on a tile
    let other: Player | null = null;
    let d = Infinity;
    for (const c of claims.values()) {
        if (c.spot !== spot || c.bot === bot || c.bot.x !== c.tile.at[0] || c.bot.z !== c.tile.at[1]) continue;
        const dd = Math.max(Math.abs(c.bot.x - bot.x), Math.abs(c.bot.z - bot.z));
        if (dd < d) {
            other = c.bot;
            d = dd;
        }
    }
    if (other && d <= 15 && sayLootLine(bot, 'safespot-ask', { to: other })) {
        q.askAt = null;
        safespotStats.asks++;
        noteRivalry(other, bot, 'safespot');
        if (Math.random() < (testRates.answer ?? ANSWER)) {
            const o = other;
            scheduleInTicks(5 + Math.floor(Math.random() * 8), () => {
                if (o.slot !== -1 && sayLootLine(o, 'safespot-answer', { to: bot, kind: 'botreply' })) safespotStats.answers++;
            });
        }
    }
}

/**
 * (tasks/RangedMagicTask's fight) with a tile of its own: a target out of its shot (the giant stepped out of sight), or
 * the bot off its tile (the game's approach stepped it a tile or two toward the giant at its shot): the attack is stopped,
 * and its turn walks it back. True when it stopped one.
 */
export function safespotGuard(bot: Player, target: Npc | null): boolean {
    const mine = byBot.get(bot);
    if (!mine || !target) return false;
    // (stepped off its tile by the game's approach at its shot: the fight stopped, the turn walks it back; the giant,
    // which could not reach the tile, could reach it there)
    const off = bot.x !== mine.tile.at[0] || bot.z !== mine.tile.at[1];
    if (!off && inShot(bot, target)) return false;
    bot.clearPendingAction();
    bot.clearWaypoints();
    return true;
}

/** (the tests, the report) the queue's outcomes */
export const safespotStats = { waits: 0, asks: 0, answers: 0, left: 0, idle: 0 };

// ---- (bots ideas, round 1 left-overs: LV14's detail) where a ranger of a safespot room is, when not on a tile ----
/** when a bot last gave its tile up idle (safespotTurn), for the report's breakdown */
const idleAt = new WeakMap<Player, number>();
/**
 * (the humanlike report, LV14's detail; reads only) a bot's safespot state: 'tile' (on the tile it holds), 'claim' (holds
 * one, off it: walking to it, its arrows and drops), 'queue' (every tile taken, waiting its turn), 'idle' (gave its tile up
 * idle, not back yet), 'left' (went elsewhere from a full room a while ago), 'none' (no claim: on its way, or another
 * state of its task)
 */
export function safespotStateOf(bot: Player): 'tile' | 'claim' | 'queue' | 'idle' | 'left' | 'none' {
    const now = World.currentTick;
    const mine = byBot.get(bot);
    if (mine) return bot.x === mine.tile.at[0] && bot.z === mine.tile.at[1] ? 'tile' : 'claim';
    const q = queues.get(bot);
    if (q && now < q.until) return 'queue';
    const idle = idleAt.get(bot);
    if (idle !== undefined && now - idle < IDLE_REQUEUE) return 'idle';
    if (now - (leftAt.get(bot) ?? -Infinity) < LEFT_TICKS) return 'left';
    return 'none';
}
// ---- (round 1's left-overs: T3) a tile whose giant it can shoot now ----
/**
 * after a tile given up idle (IDLE_REQUEUE): a tile claimed only when one has its giant to shoot; looked for every
 * IDLE_LOOK ticks (a person glancing round the room as it fights)
 */
const IDLE_LOOK = 25;
const lookAt = new WeakMap<Player, number>();
/**
 * (the report, the tests) tiles changed for one whose giant was free; looks after an idle give-up that found none; tiles
 * taken again from its scan (safespotRejoin)
 */
export const safespotMoves = { moved: 0, waits: 0, rejoined: 0 };

/** a giant of the tile alive by its spawn, free (`ok`), within SHOT_RANGE of the tile and in sight of it */
function tileHasGiant(spot: SafeSpot, tile: SafeTile, ok: (npc: Npc) => boolean): boolean {
    for (const [sx, sz] of tile.giants) {
        const npc = giantOf(sx, sz, spot.level);
        if (!npc || Math.max(Math.abs(npc.x - sx), Math.abs(npc.z - sz)) > SPAWN_SLACK || !ok(npc)) continue;
        if (Math.max(Math.abs(npc.x - tile.at[0]), Math.abs(npc.z - tile.at[1])) > SHOT_RANGE) continue;
        if (isApproached(spot.level, tile.at[0], tile.at[1], npc.x, npc.z, 1, 1, npc.width ?? 1, npc.length ?? 1)) return true;
    }
    return false;
}

/** the nearest free tile (no live claim, nobody on it) with its giant to shoot now, but `except`; null when none */
function usableTile(spot: SafeSpot, bot: Player, now: number, ok: (npc: Npc) => boolean, except?: SafeTile): SafeTile | null {
    let best: SafeTile | null = null;
    let bestD = Infinity;
    for (const tile of spot.tiles) {
        if (tile === except) continue;
        const c = claims.get(tile);
        if (c && c.bot !== bot && !stale(c, now)) continue;
        if (standingOn(tile, spot.level, bot) || !tileHasGiant(spot, tile, ok)) continue;
        const d = Math.max(Math.abs(bot.x - tile.at[0]), Math.abs(bot.z - tile.at[1]));
        if (d < bestD) {
            best = tile;
            bestD = d;
        }
    }
    if (best) {
        const c = claims.get(best);
        if (c && c.bot !== bot) releaseSafespot(c.bot);
    }
    return best;
}

/**
 * (safespotTurn, no claim) a free tile with its giant to shoot now; null: none (the nearest free one then, as before);
 * 'wait' in the IDLE_REQUEUE after it gave a tile up idle while none has (and between its looks)
 */
function usableTileFor(spot: SafeSpot, bot: Player, now: number, ok: (npc: Npc) => boolean): SafeTile | null | 'wait' {
    const idle = idleAt.get(bot);
    const afterIdle = idle !== undefined && now - idle < IDLE_REQUEUE;
    if (afterIdle && now - (lookAt.get(bot) ?? idle) < IDLE_LOOK) return 'wait';
    const tile = usableTile(spot, bot, now, ok);
    if (tile || !afterIdle) return tile;
    lookAt.set(bot, now);
    safespotMoves.waits++;
    return 'wait';
}

/**
 * (tasks/RangedMagicTask's scan) a ranger of the room with no tile: a free one whose giant it can shoot now is taken (its
 * turn then walks it there), looked for every IDLE_LOOK ticks. Its scan (after a kill, its loot, a meal) never went back
 * to the patrol where a tile is claimed: one without a tile (given up idle, or a fight begun on its way in) fought off the
 * tiles until its task ended (m100 seed 7 at 10x with the move alone: 220 of 620 samples off a tile, 79 of them such
 * fights). Not while it waits its turn at a full room (its queue).
 */
export function safespotRejoin(bot: Player, step: SkillStep, ok: (npc: Npc) => boolean): void {
    const spot = safespotOf(step);
    if (!spot || byBot.has(bot) || bot.level !== spot.level || Math.max(Math.abs(bot.x - spot.centre[0]), Math.abs(bot.z - spot.centre[1])) > ROOM_RANGE) return;
    const now = World.currentTick;
    const q = queues.get(bot);
    if (q && now < q.until) return;
    if (now - (lookAt.get(bot) ?? -Infinity) < IDLE_LOOK) return;
    lookAt.set(bot, now);
    const tile = usableTile(spot, bot, now, ok);
    if (!tile) return;
    safespotMoves.rejoined++;
    claimTileFor(bot, spot, tile, now);
}

/** the bot's claim of the tile (as safespotTurn makes one) */
function claimTileFor(bot: Player, spot: SafeSpot, tile: SafeTile, now: number): void {
    queues.delete(bot);
    const mine: Claim = { bot, spot, tile, seen: now, lootAt: now, shotAt: now };
    claims.set(tile, mine);
    byBot.set(bot, mine);
}
// ---- end of the left-overs' T3 block ----

/** (the report) the tiles of a spot claimed now (a claim of one gone included until the next look frees it) */
export function safespotClaimed(key: string): number {
    let n = 0;
    for (const c of claims.values()) if (c.spot.key === key) n++;
    return n;
}
// ---- end of the left-overs' block ----

/** Tests only: the answer's chance (null: the game's). */
const testRates: { answer?: number; choice?: 'ask' | 'wait' | 'leave' } = {};
export function setSafespotRatesForTest(rates: typeof testRates | null): void {
    delete testRates.answer;
    delete testRates.choice;
    Object.assign(testRates, rates ?? {});
}

/** Tests only: no claims or queues. */
export function resetSafespotsForTest(): void {
    claims.clear();
    byBot.clear();
}
