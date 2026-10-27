// port (the variety work, round 2, Track M: members places and minigames; "members minigames" answer, the plan's
// "Brimhaven Agility Arena: pay Cap'n Izzy, tag the pillars, tickets"): 274's game_agilityarena played through the real
// clicks:
//   - Cap'n Izzy's fee (his Pay, op 3: 274's apnpc3 takes the 200 coins), the ladder down (the arena on level 3);
//   - the flashing pillar (274's shared %agilityarena_pillar_index, what the hint arrow shows a player; it moves on about
//     every minute): walked to and tagged (its Tag) when a walk reaches it; else the first obstacle of the shortest way
//     across the platforms to it is taken (the planks, logs, ropes, ledges, hand holds, monkey bars, pillars to jump, low
//     walls, rope swings: their op 1), and the next one from where it lands; the floor's traps (darts, spikes, blades,
//     pressure pads) walked over as they come, their hits taken;
//   - a fall into the pit below (274's teleport to level 0): its climbing rope back up;
//   - a ticket for each pillar tagged in a row after the first (274's own rule), Agility XP from every obstacle;
//   - out by the ladder after 10-20 minutes, or when hurt (under 45 % of its Hitpoints) or lost too long.
// The arena is a grid of platforms walled off from each other, the obstacles the ways between; a bot knows where each one
// puts a player (274's scripts' moves, as a player who has watched it knows), goes round an obstacle that dropped it
// (a broken plank's piece, a slip), and passes over one that took it nowhere for a while. Lines: setting
// out, a ticket, a trap's hit, done (port/BotOutings sayMembers, kind 'setpiece').
import {
    BotTask,
    Player,
    InvType,
    walkTo,
    findNpcByName,
    findLocByName,
    interactNpcOp,
    interactLoc,
    countItem,
    Items,
    StuckDetector,
    teleportNear,
    advanceBankWalk,
    bankInvId,
    humanDelay,
    randInt,
    Loc,
    TargetPause
} from '#/engine/bot/tasks/BotTaskBase.js';
import World from '#/engine/World.js';
import LocType from '#/cache/config/LocType.js';
import ObjType from '#/cache/config/ObjType.js';
import VarSharedType from '#/cache/config/VarSharedType.js';
import { botAnswerDialogue, botScript, getBaseLevel, noteMove, PlayerStat, tilesInSquare } from '#/engine/bot/BotAction.js';
import { botPathToLoc, botReachedLoc, botWalkPath } from '#/engine/bot/port/BotPathing.js';
import { BotCollisionMap } from '#/engine/bot/BotCollisionMap.js';
import { canTravel, CollisionType } from '#/engine/routefinder/index.js';
import { moveItems } from '#/engine/bot/port/BotInventoryCompat.js';
import { MembersPlaces } from '#/engine/bot/BotKnowledge.js';
import { countMinigame, noteOutingEnd, noteOutingStart, sayMembers } from '#/engine/bot/port/BotOutings.js';

/** Cap'n Izzy's fee */
export const ARENA_FEE = 200;
/** a session in the arena (world minutes) */
const SESSION_MINUTES: readonly [number, number] = [10, 20];
/** out when hurt below this share of its Hitpoints */
const HURT_BELOW = 0.45;
/** the arena: level 3, the 64x64 square 43,149 */
const ARENA_X0 = 2752;
const ARENA_Z0 = 9536;
/** the crossing ops of the arena's obstacles (lower case) */
const CROSSINGS: ReadonlySet<string> = new Set(['walk-on', 'walk-across', 'swing-on', 'climb-across', 'jump-on', 'swing-across', 'climb-over']);
/** an obstacle that left the bot where it was, or took it back, is passed over this long (ticks) */
const AVOID_TICKS = 300;
/** looks round with nothing leading nearer before it waits for the arrow to move on */
const LOST_LOOKS = 12;
/** ticks off the arena's floor before the visit ends ('stray') */
const STRAY_TICKS = 100;

/** a crossing's own time in a route (ticks, about: 274's obstacles take 7-18) */
const CROSS_COST = 12;
/** and for each time it dropped this bot into the pit this visit (the climb back, the hit taken: it goes round) */
const FALL_COST = 30;

/**
 * (the flaky tests, 2026-10-27) the arena's floor as a player comes to know it: its platforms (level 3's walk regions in
 * the arena's square; the dark round them, open floor out to the square's edge, is none) and the crossings between them.
 * The bot took the obstacle whose far side looked nearest the arrow, and a platform walled off from the pillar's side
 * (most of them: the walkways end at walls, the way on is an obstacle back or round) gave it none: "lost" in a few
 * looks, tagging only the pillars next to it (no tag in a 10-20 minute visit at seeds 2 and 4). It now takes the first
 * obstacle of the shortest way across the platforms.
 */
interface Crossing {
    /** the obstacle (its op 1) */
    readonly loc: Loc;
    /** the platform it is taken from, and the tile there a click's walk ends on (x << 14 | z) */
    readonly from: number;
    readonly at: number;
    /** the platform and tile 274's script puts a player on */
    readonly to: number;
    readonly land: number;
    /** the loc's tile and the platform it is taken from */
    readonly id: number;
}
const FLOOR = 64;
let floorRegions: Int16Array | null = null;
let floorCrossings: Crossing[] = [];
/**
 * Where a crossing really took a bot when that was not where the script's moves put it (another platform): learned as
 * bots cross, the next bot's route by it: the arena's guide, as 2004's players learned it. (Not the planks that dropped
 * one: 274's broken piece is under the tile two steps on, so a plank drops a player or not by the tile its walk ended
 * beside; kept as broken for good, every plank to the ladder's platform was in a while and a bot there had no way out:
 * minigames.test seed 1. A plank's fall is any obstacle's, gone round for the visit.)
 */
const learned = new Map<number, number>();

/** the platform on (x, z) of the arena's floor, or -1 (a wall, the dark, off the square) */
function platformAt(x: number, z: number): number {
    const dx = x - ARENA_X0;
    const dz = z - ARENA_Z0;
    if (dx < 0 || dz < 0 || dx >= FLOOR || dz >= FLOOR) return -1;
    return arenaFloor()[dx * FLOOR + dz];
}

function locAt(x: number, z: number, name: string): boolean {
    const zone = World.gameMap.getZone(x, z, 3);
    if (!zone) return false;
    for (const loc of zone.getAllLocsSafe()) if (loc.x === x && loc.z === z && LocType.get(loc.type).debugname === name) return true;
    return false;
}

/** a rope swing's start tile and the way it swings (274's aploc1 agilityarena_ropeswing: by the loc's angle) */
function swingOf(loc: Loc): [number, number, number, number] {
    switch (loc.angle) {
        case 0:
            return [loc.x, loc.z + 2, 0, -1];
        case 1:
            return [loc.x + 2, loc.z, -1, 0];
        case 2:
            return [loc.x, loc.z - 2, 0, 1];
        default:
            return [loc.x - 2, loc.z, 1, 0];
    }
}

/** where 274's script for an obstacle (game_agilityarena's) puts a player who uses it from (sx, sz), or null */
function landingOf(name: string, loc: Loc, sx: number, sz: number): number | null {
    const ux = Math.sign(loc.x - sx);
    const uz = Math.sign(loc.z - sz);
    const tile = (x: number, z: number) => (x << 14) | z;
    switch (name) {
        case 'agilityarena_ropebalance':
            return tile(loc.x, loc.z + (loc.angle === 2 ? -7 : 7));
        case 'agilityarena_ropeswing': {
            const [x, z, dx, dz] = swingOf(loc);
            return tile(x + 5 * dx, z + 5 * dz);
        }
        case 'agilityarena_pillar_top':
            return Math.abs(loc.x - sx) + Math.abs(loc.z - sz) === 1 ? tile(loc.x + 6 * ux, loc.z + 6 * uz) : null;
        case 'agilityarena_lowwall':
            return (ux === 0) !== (uz === 0) ? tile(sx + 3 * ux, sz + 3 * uz) : null;
        case 'agilityarena_monkeybars_end': {
            const [x, z, dx, dz] = loc.angle === 0 ? [loc.x + 1, loc.z, 0, -1] : loc.angle === 2 ? [loc.x + 1, loc.z, 0, 1] : loc.angle === 1 ? [loc.x, loc.z + 1, -1, 0] : [loc.x, loc.z + 1, 1, 0];
            return tile(x + 8 * dx, z + 8 * dz);
        }
        case 'agilityarena_ledgebalance':
        case 'agilityarena_ledgebalance2':
        case 'agilityarena_plank':
        case 'agilityarena_plank2':
        case 'agilityarena_plank3':
            return tile(sx + (sx < loc.x ? 7 : -7), sz);
        case 'agilityarena_logbalance1':
        case 'agilityarena_logbalance2':
        case 'agilityarena_logbalance3':
            return uz !== 0 ? tile(sx, sz + 7 * uz) : ux !== 0 ? tile(sx + 7 * ux, sz) : null;
        case 'agilityarena_handholds':
            // (the way the middle hand holds go from where it stands)
            for (const [dx, dz] of [[0, 1], [0, -1], [-1, 0], [1, 0]]) if (locAt(sx + dx, sz + dz, 'agilityarena_handholds_middle')) return tile(loc.x + 7 * dx, loc.z + 7 * dz);
            return null;
    }
    return null;
}

/** the arena's platforms (built the first time a bot looks: the floor and its obstacles are the map's, fixed) */
function arenaFloor(): Int16Array {
    if (floorRegions) return floorRegions;
    const region = new Int16Array(FLOOR * FLOOR).fill(-1);
    floorRegions = region;
    let n = 0;
    for (let i = 0; i < FLOOR * FLOOR; i++) {
        const x = ARENA_X0 + Math.floor(i / FLOOR);
        const z = ARENA_Z0 + (i % FLOOR);
        if (region[i] !== -1 || BotCollisionMap.isCsvBlocked(3, x, z)) continue;
        const queue = [i];
        region[i] = n;
        let dark = false;
        for (let q = 0; q < queue.length; q++) {
            const cx = ARENA_X0 + Math.floor(queue[q] / FLOOR);
            const cz = ARENA_Z0 + (queue[q] % FLOOR);
            if (cx === ARENA_X0 || cz === ARENA_Z0 || cx === ARENA_X0 + FLOOR - 1 || cz === ARENA_Z0 + FLOOR - 1) dark = true;
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const ox = cx + dx - ARENA_X0;
                const oz = cz + dz - ARENA_Z0;
                if (ox < 0 || oz < 0 || ox >= FLOOR || oz >= FLOOR) continue;
                const j = ox * FLOOR + oz;
                if (region[j] !== -1 || BotCollisionMap.isCsvBlocked(3, cx + dx, cz + dz) || !canTravel(3, cx, cz, dx, dz, 1, 0, CollisionType.NORMAL)) continue;
                region[j] = n;
                queue.push(j);
            }
        }
        // (open floor out to the square's edge: the dark round the platforms)
        if (dark) for (const j of queue) region[j] = -2;
        else n++;
    }
    for (let i = 0; i < region.length; i++) if (region[i] === -2) region[i] = -1;
    // each obstacle from each platform beside it: from a tile 274's reach test passes on (a rope swing: its start tile)
    const crossings: Crossing[] = [];
    for (let zx = ARENA_X0; zx < ARENA_X0 + FLOOR; zx += 8) {
        for (let zz = ARENA_Z0; zz < ARENA_Z0 + FLOOR; zz += 8) {
            const zone = World.gameMap.getZone(zx, zz, 3);
            if (!zone) continue;
            for (const loc of zone.getAllLocsSafe()) {
                const type = LocType.get(loc.type);
                if (!CROSSINGS.has(String(type.op?.[0] ?? '').toLowerCase())) continue;
                const swing = type.debugname === 'agilityarena_ropeswing' ? swingOf(loc) : null;
                const done = new Set<number>();
                for (let dx = -2; dx < loc.width + 2; dx++) {
                    for (let dz = -2; dz < loc.length + 2; dz++) {
                        const sx = loc.x + dx;
                        const sz = loc.z + dz;
                        const from = platformAt(sx, sz);
                        if (from < 0 || done.has(from)) continue;
                        if (swing ? sx !== swing[0] || sz !== swing[1] : !botReachedLoc(3, sx, sz, loc.x, loc.z, loc.width, loc.length, loc.angle, loc.shape, type.forceapproach)) continue;
                        const land = landingOf(type.debugname ?? '', loc, sx, sz);
                        if (land === null) continue;
                        const to = platformAt(land >> 14, land & 0x3fff);
                        if (to < 0 || to === from) continue;
                        done.add(from);
                        crossings.push({ loc, from, at: (sx << 14) | sz, to, land, id: ((loc.x << 14) | loc.z) * 64 + from });
                    }
                }
            }
        }
    }
    floorCrossings = crossings;
    return region;
}

/** (tests) the arena's platforms and crossings, and what bots learned of them */
export function arenaFloorForTest(): { platformAt: (x: number, z: number) => number; crossings: readonly Crossing[]; learned: ReadonlyMap<number, number> } {
    arenaFloor();
    return { platformAt, crossings: floorCrossings, learned };
}

/** (tests, the runner) visits, fees paid, tags, tickets, crossings, falls, the ends */
export const arenaStats = { visits: 0, paid: 0, tags: 0, tickets: 0, crossings: 0, falls: 0, ended: {} as Record<string, number> };

let pillarVar = -2;
/** the pillar the arrow is over now (274's shared var: what a player's hint arrow shows), or -1 */
export function arenaPillarIndex(): number {
    if (pillarVar === -2) pillarVar = VarSharedType.getId('agilityarena_pillar_index');
    if (pillarVar === -1) return -1;
    return World.vars[pillarVar] ?? -1;
}

/** the pillar `index`'s tile (274's agilityarena_pillar_coords: a 5x5 grid 11 tiles apart from 9,10) */
export function pillarCoord(index: number): [number, number] {
    return [ARENA_X0 + 9 + 11 * (index % 5), ARENA_Z0 + 10 + 11 * Math.floor(index / 5)];
}

export function inArena(player: Player): boolean {
    return player.x >= ARENA_X0 && player.x < ARENA_X0 + 64 && player.z >= ARENA_Z0 && player.z < ARENA_Z0 + 64;
}

let ticketId = -1;
function ticket(): number {
    if (ticketId === -1) ticketId = ObjType.getId('agilityarena_ticket');
    return ticketId;
}

/** May the bot visit: Agility 20 (the hand holds and ledges want it), the fee with some to spare, a members world */
export function mayRunArena(player: Player): boolean {
    const bid = bankInvId();
    const bank = bid === -1 ? null : player.getInventory(bid);
    return getBaseLevel(player, PlayerStat.AGILITY) >= 20 && countItem(player, Items.COINS) + (bank?.getItemCount(Items.COINS) ?? 0) >= ARENA_FEE + 300;
}

/**
 * a few steps about the bot's platform: a tile it walks to within `radius` (walls count; a random tile off the platform
 * was no walk at all, and a bot waiting for the arrow stood minutes on one tile, H19)
 */
function stepAbout(player: Player, radius: number): void {
    const tiles = [...tilesInSquare(player.level, player.x, player.z, radius)].filter(t => t !== ((player.x << 14) | player.z));
    if (tiles.length === 0) return;
    const t = tiles[randInt(0, tiles.length - 1)];
    // (a move click: the walk's own route finding is for the overworld, the arena is a floor of its own below it)
    const path = botWalkPath(player.level, player.x, player.z, t >> 14, t & 0x3fff);
    if (path.length > 0) player.queueWaypoints(path);
    else player.queueWaypoint(t >> 14, t & 0x3fff);
}

/**
 * (the variety work, round 2, the fixes) does a click on the loc reach it: 274's reach test from where the bot stands, or
 * where the route a client sends with the click ends. A route found (it may end short of the loc) or a loc a tile off
 * (across a wall, a gap between platforms) was taken for a reach: "I can't reach that!" 6-25 times a run at the pillars
 */
function walkReaches(player: Player, loc: Loc): boolean {
    const t = LocType.get(loc.type);
    if (botReachedLoc(player.level, player.x, player.z, loc.x, loc.z, loc.width, loc.length, loc.angle, loc.shape, t.forceapproach)) return true;
    const path = botPathToLoc(player.level, player.x, player.z, loc.x, loc.z, loc.width, loc.length, loc.angle, loc.shape, t.forceapproach, false);
    if (path.length === 0) return false;
    const last = path[path.length - 1];
    return botReachedLoc(player.level, (last >> 14) & 0x3fff, last & 0x3fff, loc.x, loc.z, loc.width, loc.length, loc.angle, loc.shape, t.forceapproach);
}

export class AgilityArenaTask extends BotTask {
    private state: 'coins' | 'walk' | 'pay' | 'down' | 'arena' | 'pit' | 'out' | 'done' = 'walk';
    private readonly stuck = new StuckDetector(40, 4, 3);
    private started = false;
    private startedAt = 0;
    private stateAt = 0;
    private endsAt = 0;
    private lastClick = 0;
    private outcome = 'done';
    private tickets0 = 0;
    private tagged = -1;
    private lastPillar = -1;
    /** crossings that went nowhere lately (their id), targets a click did not reach (their tile): when */
    private readonly avoid = new Map<number, number>();
    /** crossings that dropped it into the pit this visit: how often */
    private readonly fellFrom = new Map<number, number>();
    /** the crossing it last took, where it stood then */
    private crossing: { id: number; from: number; to: number; x: number; z: number; at: number } | null = null;
    /** (the variety work, round 2, the fixes) the target it last clicked (a pillar, the ladder up) and when */
    private clicked: { key: number; at: number } | null = null;
    private lost = 0;
    /** ticks off the arena's floor (not in the pit) while in the arena */
    private stray = 0;
    private readonly pause = new TargetPause('retarget');
    private _player: Player | null = null;
    private lastX = -1;
    private lastZ = -1;
    private lastLevel = -1;
    /** its next click no sooner than this (a person's uneven pace between obstacles: H18) */
    private nextClick = 0;
    /** a script held it last tick (an obstacle, a climb) */
    private busy = false;
    /** (the variety work, round 2, the fixes) the last tick a script held it (an obstacle's own forcemoves) */
    private lastBusyAt = -1;
    /** its next step about its platform while it waits for the arrow (no stand of minutes: H19) */
    private millAt = 0;

    constructor() {
        super('AgilityArena');
    }

    shouldRun(_player: Player): boolean {
        return this.state !== 'done' && !this.interrupted;
    }

    isComplete(_player: Player): boolean {
        return this.state === 'done';
    }

    override interrupt(): void {
        super.interrupt();
        this._end(null, 'interrupted');
    }

    override reset(): void {
        super.reset();
        if (this.started && this.state !== 'done') this._end(null, 'reset');
    }

    tick(player: Player): void {
        if (this.interrupted || this.state === 'done') return;
        this._player = player;
        const now = World.currentTick;
        this.pause.observe(player);
        // (an obstacle's own moves: a jump between pillars, a swing, a fall into the pit and the rope back; 274's
        // forcemoves of 3+ tiles in a tick, marked as the game's for the humanlike runner, as Agility's are)
        if (this.lastX !== -1 && (player.level !== this.lastLevel || Math.max(Math.abs(player.x - this.lastX), Math.abs(player.z - this.lastZ)) > 2) && (inArena(player) || player.z > 9000)) noteMove(player, 'event');
        this.lastX = player.x;
        this.lastZ = player.z;
        this.lastLevel = player.level;
        if (!this.started) {
            this.started = true;
            this.startedAt = now;
            arenaStats.visits++;
            noteOutingStart(player, 'AgilityArena', 'brimhaven', 'minigame');
            this.tickets0 = countItem(player, ticket());
            this._set(countItem(player, Items.COINS) < ARENA_FEE + 50 ? 'coins' : 'walk');
            if (Math.random() < 0.4) sayMembers(player, 'arena-go');
        }
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        if (botAnswerDialogue(player, 1) !== null) return;
        // (an obstacle's own script holds the bot; when it lets go, a person's moment before the next click: the
        // obstacles' fixed lengths otherwise set the clicks' rhythm, H18)
        if (player.delayed || botScript(player)) {
            this.busy = true;
            this.lastBusyAt = now;
            return;
        }
        if (this.busy) {
            this.busy = false;
            this.nextClick = Math.max(this.nextClick, now + humanDelay(player, 'retarget') + randInt(0, 4));
        }
        // (the pit below the arena: a fall from an obstacle, a slip or a plank's broken piece)
        if ((this.state === 'arena' || this.state === 'out') && player.level === 0 && player.z > 9000) {
            arenaStats.falls++;
            if (this.crossing) this.fellFrom.set(this.crossing.id, (this.fellFrom.get(this.crossing.id) ?? 0) + 1);
            this.crossing = null;
            this._set('pit');
        }

        switch (this.state) {
            case 'coins': {
                const result = advanceBankWalk(player, this.stuck);
                if (result === 'walk') return;
                const bid = bankInvId();
                const bank = bid === -1 ? null : player.getInventory(bid);
                const inv = player.getInventory(InvType.INV);
                const short = ARENA_FEE + 100 - countItem(player, Items.COINS);
                if (bank && inv && short > 0) moveItems(bank, inv, Items.COINS, short);
                this.cooldown = result === 'ready' ? humanDelay(player, 'bank') : 0;
                this.stuck.reset();
                if (countItem(player, Items.COINS) >= ARENA_FEE) this._set('walk');
                else this._end(player, 'coins');
                return;
            }
            case 'walk': {
                const [ix, iz] = MembersPlaces.ARENA_IZZY;
                if (player.level === 0 && Math.max(Math.abs(player.x - ix), Math.abs(player.z - iz)) <= 3) {
                    this._set('pay');
                    return;
                }
                this._walk(player, ix, iz);
                return;
            }
            case 'pay': {
                // (his Pay: 274 takes the fee, or says it is paid already; then the ladder)
                if (this.lastClick === 0) {
                    const izzy = findNpcByName(player.x, player.z, player.level, 'agilityarena_clerk', 10);
                    if (!izzy) {
                        this._end(player, 'no-izzy');
                        return;
                    }
                    this.lastClick = now;
                    this.coinsBefore = countItem(player, Items.COINS);
                    interactNpcOp(player, izzy, 3);
                    return;
                }
                if (this.coinsBefore - countItem(player, Items.COINS) >= ARENA_FEE) {
                    arenaStats.paid++;
                    countMinigame('AgilityArena', 'paid');
                    this._set('down');
                    return;
                }
                if (now - this.lastClick > 15) this._set('down');
                return;
            }
            case 'down': {
                if (inArena(player) && player.level === 3) {
                    this.endsAt = now + randInt(SESSION_MINUTES[0], SESSION_MINUTES[1]) * 100;
                    this._set('arena');
                    return;
                }
                const [lx, lz] = MembersPlaces.ARENA_LADDER;
                const ladder = findLocByName(lx, lz, 0, 'agilityarena_ladderdown', 3);
                if (!ladder || now - this.stateAt > 100) {
                    this._end(player, 'no-ladder');
                    return;
                }
                if (now - this.lastClick >= 10) {
                    this.lastClick = now;
                    interactLoc(player, ladder);
                }
                return;
            }
            case 'pit': {
                // (fallen into the pit: its climbing rope back up)
                if (player.level === 3) {
                    this._set('arena');
                    return;
                }
                if (now - this.stateAt > 200) {
                    this._end(player, 'pit');
                    return;
                }
                const rope = findLocByName(player.x, player.z, player.level, 'agilityarena_climbingrope', 30);
                if (now - this.lastClick >= 8) {
                    this.lastClick = now;
                    // (the rope when it sees one; else a few steps about the pit, looking)
                    if (rope) interactLoc(player, rope);
                    else stepAbout(player, 3);
                }
                return;
            }
            case 'arena': {
                // (back on the surface some other way: the visit is over)
                if (player.level === 0 && player.z < 6400) {
                    this._end(player, 'left');
                    return;
                }
                if (player.level !== 3 || !inArena(player)) {
                    // (off the arena's floor and not in the pit: a while, then the visit ends rather than a stand)
                    if (++this.stray > STRAY_TICKS) this._end(player, 'stray');
                    return;
                }
                this.stray = 0;
                if (now >= this.endsAt || player.levels[PlayerStat.HITPOINTS] < player.baseLevels[PlayerStat.HITPOINTS] * HURT_BELOW) {
                    this.outcome = now >= this.endsAt ? 'done' : 'hurt';
                    this._set('out');
                    return;
                }
                this._arena(player, now);
                return;
            }
            case 'out': {
                // (the ladder up, found as the pillars are)
                if (!inArena(player) || player.level !== 3) {
                    if (player.level === 0 && player.z < 6400) {
                        const won = countItem(player, ticket()) - this.tickets0;
                        if (won > 0) {
                            arenaStats.tickets += won;
                            countMinigame('AgilityArena', 'tickets', won);
                        }
                        if (Math.random() < 0.5) sayMembers(player, 'arena-done');
                        this._end(player, this.outcome);
                    }
                    return;
                }
                if (now - this.stateAt > 1500) {
                    this._end(player, 'stuck-out');
                    return;
                }
                const up = findLocByName(2805, 9590, 3, 'agilityarena_ladderup', 2);
                if (up) this._goTo(player, now, up);
                return;
            }
        }
    }

    private coinsBefore = 0;

    /** a moment in the arena: the flashing pillar tagged when a walk reaches it, else an obstacle toward it */
    private _arena(player: Player, now: number): void {
        const index = arenaPillarIndex();
        if (index < 0) {
            // (no pillar flashing yet: a step about its platform now and then)
            if (now >= this.millAt && !player.hasWaypoints() && player.target === null) {
                this.millAt = now + randInt(25, 70);
                stepAbout(player, 2);
            }
            return;
        }
        if (index !== this.lastPillar) {
            this.lastPillar = index;
            this.lost = 0;
        }
        if (this.tagged === index || this.lost > LOST_LOOKS) {
            // (tagged, or no way to it found: a moment on its platform, a step about it now and then; the next arrow
            // comes in about a minute)
            if (now >= this.millAt && !player.hasWaypoints() && player.target === null) {
                this.millAt = now + randInt(25, 70);
                stepAbout(player, 2);
            }
            return;
        }
        const [px, pz] = pillarCoord(index);
        const pillar = findLocByName(px, pz, 3, 'agility_ticketpillar', 0) ?? findLocByName(px, pz, 3, 'agilityarena_poisondarts', 0);
        if (!pillar) {
            // (no pillar to see there: a step about its platform until the arrow moves on)
            if (now >= this.millAt && !player.hasWaypoints() && player.target === null) {
                this.millAt = now + randInt(25, 70);
                stepAbout(player, 2);
            }
            return;
        }
        // (its tag clicked and done, beside the pillar: one tag an arrow, as the game allows)
        if (this.pendingTag === index && player.target === null && !player.hasWaypoints() && now - this.lastClick >= 2 && Math.max(Math.abs(player.x - px), Math.abs(player.z - pz)) <= 1) {
            this.tagged = index;
            this.pendingTag = -1;
            arenaStats.tags++;
            countMinigame('AgilityArena', 'tags');
            if (countItem(player, ticket()) > this.ticketsAtTag && Math.random() < 0.3) sayMembers(player, 'arena-tag');
            this.ticketsAtTag = countItem(player, ticket());
            return;
        }
        if (this._goTo(player, now, pillar) === 'clicked') this.pendingTag = index;
    }

    /** the pillar it clicked to tag (-1: none), and its tickets then */
    private pendingTag = -1;
    private ticketsAtTag = 0;

    /**
     * Toward a loc in the arena: clicked when a walk reaches it ('clicked'); else the obstacle on its platform that leads
     * nearest to it is taken ('crossing'); 'waiting' between clicks, 'lost' with nothing to take.
     */
    private _goTo(player: Player, now: number, target: Loc): 'clicked' | 'crossing' | 'waiting' | 'lost' {
        if (player.hasWaypoints() || player.target !== null || botScript(player) || !this.pause.ready || now < this.nextClick) return 'waiting';
        // (the last obstacle left it where it was: passed over a while; one that took it on: where it leads, learned)
        // (the variety work, round 2, the fixes: and one whose own script never ran: the engine's walk to it stopped short,
        // "I can't reach that!" (a balancing rope over the pit, its route through tiles 274 does not step on); it was taken
        // for a crossing, its "landing" learned where the walk stopped, and clicked again and again: 6-25 times a run)
        // (and one that left it on the platform it was taken from: a low wall's stumble back, a walk to it and no crossing;
        // learned as where it leads, both ways off a platform led back onto it, and a bot there had no way anywhere)
        if (this.crossing && now - this.crossing.at > 6) {
            const on = player.level === 3 ? platformAt(player.x, player.z) : -1;
            if (this.lastBusyAt < this.crossing.at || on === this.crossing.from || Math.max(Math.abs(player.x - this.crossing.x), Math.abs(player.z - this.crossing.z)) <= 2) this.avoid.set(this.crossing.id, now);
            else {
                arenaStats.crossings++;
                if (on >= 0 && on !== this.crossing.to) learned.set(this.crossing.id, on);
            }
            this.crossing = null;
        }
        // (the variety work, round 2, the fixes: a target clicked and not reached, no script run since: the engine's walk to
        // it stopped short ("I can't reach that!"): passed over a while, as an obstacle that went nowhere; the way to it by
        // the obstacles)
        const targetKey = (target.x << 14) | target.z;
        if (this.clicked && this.clicked.key === targetKey && now - this.clicked.at > 2 && this.lastBusyAt < this.clicked.at && Math.max(Math.abs(player.x - target.x), Math.abs(player.z - target.z)) > 1) this.avoid.set(targetKey, now);
        this.clicked = null;
        if (now - (this.avoid.get(targetKey) ?? -AVOID_TICKS) >= AVOID_TICKS && walkReaches(player, target)) {
            this.clicked = { key: targetKey, at: now };
            this.lastClick = now;
            this.nextClick = now + randInt(2, 7);
            interactLoc(player, target);
            return 'clicked';
        }
        // (the first obstacle of the shortest way there)
        const step = this._route(player, now, target);
        if (!step) {
            this.lost++;
            // (no way it knows: a few steps about its platform, and a look again)
            if (now - this.lastClick >= 10) {
                this.lastClick = now;
                stepAbout(player, 3);
            }
            return 'lost';
        }
        // (a click whose walk reaches it from here; else a walk to the tile it is taken from first, a rope swing's start:
        // its aploc1 swings only from there)
        const sx = step.at >> 14;
        const sz = step.at & 0x3fff;
        const swing = LocType.get(step.loc.type).debugname === 'agilityarena_ropeswing';
        if (swing ? player.x !== sx || player.z !== sz : !walkReaches(player, step.loc)) {
            const path = player.x === sx && player.z === sz ? null : botWalkPath(3, player.x, player.z, sx, sz);
            if (path && path.length > 0) player.queueWaypoints(path);
            else this.avoid.set(step.id, now);
            this.nextClick = now + randInt(1, 3);
            return 'waiting';
        }
        this.lastClick = now;
        this.nextClick = now + randInt(2, 7);
        this.crossing = { id: step.id, from: step.from, to: step.to, x: player.x, z: player.z, at: now };
        interactLoc(player, step.loc);
        return 'crossing';
    }

    /**
     * The first crossing of the shortest way (the tiles walked and the crossings' time) from its platform to one the target
     * is used from; null when it stands on one, or knows no way (the avoided obstacles left out)
     */
    private _route(player: Player, now: number, target: Loc): Crossing | null {
        const here = player.level === 3 ? platformAt(player.x, player.z) : -1;
        if (here < 0) return null;
        const type = LocType.get(target.type);
        const goal = new Set<number>();
        for (let dx = -1; dx <= target.width; dx++) {
            for (let dz = -1; dz <= target.length; dz++) {
                const x = target.x + dx;
                const z = target.z + dz;
                const on = platformAt(x, z);
                if (on >= 0 && botReachedLoc(3, x, z, target.x, target.z, target.width, target.length, target.angle, target.shape, type.forceapproach)) goal.add(on);
            }
        }
        if (goal.size === 0 || goal.has(here)) return null;
        const ways = floorCrossings.filter(c => now - (this.avoid.get(c.id) ?? -AVOID_TICKS) >= AVOID_TICKS);
        const dist = (a: number, x: number, z: number) => Math.max(Math.abs((a >> 14) - x), Math.abs((a & 0x3fff) - z));
        const cost = new Array<number>(ways.length).fill(Infinity);
        const first = new Array<number>(ways.length).fill(-1);
        const done = new Array<boolean>(ways.length).fill(false);
        for (let i = 0; i < ways.length; i++) {
            if (ways[i].from !== here) continue;
            cost[i] = dist(ways[i].at, player.x, player.z) + CROSS_COST + FALL_COST * (this.fellFrom.get(ways[i].id) ?? 0);
            first[i] = i;
        }
        let best = -1;
        let bestCost = Infinity;
        for (;;) {
            let i = -1;
            for (let j = 0; j < ways.length; j++) if (!done[j] && cost[j] < Infinity && (i === -1 || cost[j] < cost[i])) i = j;
            if (i === -1 || cost[i] >= bestCost) break;
            done[i] = true;
            const c = ways[i];
            const to = learned.get(c.id) ?? c.to;
            if (goal.has(to)) {
                const total = cost[i] + dist(c.land, target.x, target.z);
                if (total < bestCost) {
                    bestCost = total;
                    best = first[i];
                }
                continue;
            }
            for (let j = 0; j < ways.length; j++) {
                if (done[j] || ways[j].from !== to) continue;
                const next = cost[i] + dist(ways[j].at, c.land >> 14, c.land & 0x3fff) + CROSS_COST + FALL_COST * (this.fellFrom.get(ways[j].id) ?? 0);
                if (next < cost[j]) {
                    cost[j] = next;
                    first[j] = first[i];
                }
            }
        }
        return best === -1 ? null : ways[best];
    }

    private _set(state: AgilityArenaTask['state']): void {
        this.state = state;
        this.stateAt = World.currentTick;
        this.lastClick = 0;
        this.stuck.reset();
    }

    private _end(player: Player | null, outcome: string): void {
        if (this.state === 'done') return;
        this.state = 'done';
        arenaStats.ended[outcome] = (arenaStats.ended[outcome] ?? 0) + 1;
        const p = player ?? this._player;
        if (p && this.started) noteOutingEnd(p, outcome);
    }

    private _walk(player: Player, x: number, z: number): void {
        if (!this.stuck.check(player, x, z)) {
            walkTo(player, x, z, 0);
            return;
        }
        if (this.stuck.desperatelyStuck) {
            teleportNear(player, x, z, 0);
            this.stuck.reset();
            return;
        }
        player.clearWaypoints();
        walkTo(player, x, z, 0);
    }
}
