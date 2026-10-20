// port (the variety work, round 2, Track M: members places and minigames; "members minigames" answer, the plan's
// "Brimhaven Agility Arena: pay Cap'n Izzy, tag the pillars, tickets"): 274's game_agilityarena played through the real
// clicks:
//   - Cap'n Izzy's fee (his Pay, op 3: 274's apnpc3 takes the 200 coins), the ladder down (the arena on level 3);
//   - the flashing pillar (274's shared %agilityarena_pillar_index, what the hint arrow shows a player; it moves on about
//     every minute): walked to and tagged (its Tag) when a walk reaches it; else an obstacle on the bot's own platform
//     that leads toward it is taken (the planks, logs, ropes, ledges, hand holds, monkey bars, pillars to jump, low walls,
//     rope swings: their op 1), and the next one from where it lands; the floor's traps (darts, spikes, blades, pressure
//     pads) walked over as they come, their hits taken;
//   - a fall into the pit below (274's teleport to level 0): its climbing rope back up;
//   - a ticket for each pillar tagged in a row after the first (274's own rule), Agility XP from every obstacle;
//   - out by the ladder after 10-20 minutes, or when hurt (under 45 % of its Hitpoints) or lost too long.
// The arena is a grid of platforms; a bot finds its way by what is in front of it, as a player looking at the screen
// does, and remembers the obstacles that took it nowhere for a while. Lines: setting out, a ticket, a trap's hit, done
// (port/BotOutings sayMembers, kind 'setpiece').
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

/**
 * Where each obstacle took a bot (its tile -> the tile it landed on), learned as bots cross: the arena's guide, as 2004's
 * players learned it (the next bot weighs an obstacle by where it really leads)
 */
const landings = new Map<number, [number, number]>();

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
    /** obstacles that went nowhere lately: their tile and when */
    private readonly avoid = new Map<number, number>();
    /** the obstacle it last took and where it stood then */
    private crossing: { key: number; x: number; z: number; at: number } | null = null;
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
        // (the pit below the arena: a fall from an obstacle)
        if (this.state === 'arena' && player.level === 0 && player.z > 9000) {
            arenaStats.falls++;
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
                    } else if (player.level === 0 && player.z > 9000) this._set('pit');
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
        if (this.crossing && now - this.crossing.at > 6) {
            if (this.lastBusyAt < this.crossing.at || Math.max(Math.abs(player.x - this.crossing.x), Math.abs(player.z - this.crossing.z)) <= 2) this.avoid.set(this.crossing.key, now);
            else {
                arenaStats.crossings++;
                if (player.level === 3) landings.set(this.crossing.key, [player.x, player.z]);
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
        // (an obstacle a walk reaches, whose far side is nearest the target)
        let best: Loc | null = null;
        let bestScore = Infinity;
        for (let zx = (player.x - 14) & ~7; zx <= player.x + 14; zx += 8) {
            for (let zz = (player.z - 14) & ~7; zz <= player.z + 14; zz += 8) {
                const zone = World.gameMap.getZone(zx, zz, 3);
                if (!zone) continue;
                for (const loc of zone.getAllLocsSafe()) {
                    const type = LocType.get(loc.type);
                    const op = String(type.op?.[0] ?? '').toLowerCase();
                    if (!CROSSINGS.has(op)) continue;
                    const key = (loc.x << 14) | loc.z;
                    if (now - (this.avoid.get(key) ?? -AVOID_TICKS) < AVOID_TICKS) continue;
                    const near = Math.max(Math.abs(loc.x - player.x), Math.abs(loc.z - player.z));
                    if (near > 14) continue;
                    // (where it leads: learned, else its far side, past it away from the bot)
                    const known = landings.get(key);
                    const fx = known ? known[0] : loc.x + Math.sign(loc.x - player.x) * 4;
                    const fz = known ? known[1] : loc.z + Math.sign(loc.z - player.z) * 4;
                    const score = Math.hypot(fx - target.x, fz - target.z) + near * 0.3 + (known ? 0 : 2);
                    if (score >= Math.hypot(player.x - target.x, player.z - target.z) + 2) continue;
                    if (score >= bestScore) continue;
                    if (!walkReaches(player, loc)) continue;
                    best = loc;
                    bestScore = score;
                }
            }
        }
        if (!best) {
            this.lost++;
            // (nothing leads nearer: a few steps about its platform, and a look again)
            if (now - this.lastClick >= 10) {
                this.lastClick = now;
                stepAbout(player, 3);
            }
            return 'lost';
        }
        this.lastClick = now;
        this.nextClick = now + randInt(2, 7);
        this.crossing = { key: (best.x << 14) | best.z, x: player.x, z: player.z, at: now };
        interactLoc(player, best);
        return 'crossing';
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
