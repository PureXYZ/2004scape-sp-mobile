// port (the realism work, phase 3, "where bots are"; "2004 hotspots"): hang-outs. Now and then a
// levelling bot leaves off its training for a few minutes at a 2004 hang-out near it: Falador park, Varrock square or a
// bank. It walks there, stands on a tile of its own (port/BotTiles), talks as it always does (the chatter and the
// conversation run on: it is not away, it answers), moves a step or two, and seldom an emote; after 3-10
// minutes it goes back to its training. Before, Falador park was empty 78-84 % of the time and Varrock square 58-77 % at
// 100 bots (the humanlike report's H1): nobody ever stopped there.
//
// When: about every 1-2 hours of play (by its persona's sociability: the most sociable bots more often), started by the
// planner between plans (BotGoalPlanner._pickTaskInternal asks hangoutFor when it picks the next task: after a bank
// trip, a finished shop trip, a plan that ran out; the next plan after it), or by the habits at a bank stop
// (port/BotHabits.bankStop asks hangoutAtBank: a sub-task, after which its plan resumes). Never a newbie (it has its
// own place: the courtyard), never in the Wilderness, underground or upstairs, never hurt, never two in a row (the next
// is due an hour or more after the last).
// Where: the hang-outs within 80 tiles, the nearer the likelier, the park and the square three times as likely as a
// bank (the 2004 hang-outs; banks were where people stood to trade); not Varrock West, the trade hub, whose crowd is the
// vendors'; Draynor's bank only from combat 16 (its dark wizards), Al Kharid's only from inside its wall (the toll).
// No staging round the human: the choice knows nothing of where any human is.
//
// Per bot and tick: a WeakMap read in the planner's pick (rare) and the task's own few compares; the spot's choice is a
// loop over 13 places once per hang-out.
import type Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import LocType from '#/cache/config/LocType.js';
import World from '#/engine/World.js';
import { getWorld } from '#/engine/bot/BotWorld.js';
import { BotTask, StuckDetector, walkTo, teleportNear, randInt, isInventoryFull } from '#/engine/bot/tasks/BotTaskBase.js';
import { claimStandTile, releaseStandTile, stepToTile } from '#/engine/bot/port/BotTiles.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { botPersona } from '#/engine/bot/port/BotTiming.js';
import { everydayEmote, type Emote } from '#/engine/bot/port/BotEmote.js';
import { TRADE_BANKS } from '#/engine/bot/port/BotTradeSpots.js';
import { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';

/** play ticks between two hang-outs (1-2 hours), before the persona's sociability scales it */
export const HANGOUT_GAP_TICKS: [number, number] = [6000, 12000];
/** how long a hang-out's stand lasts (3-10 minutes) */
export const HANGOUT_STAND_TICKS: [number, number] = [300, 1000];
/** a hang-out this far off at most (tiles, Chebyshev) */
export const HANGOUT_RANGE = 80;
/** the walk there: given up after this long (it then goes back to its training) */
const WALK_LIMIT_TICKS = 300;
/** an emote or a step about now and then while it stands: this many ticks apart */
const FIDGET_TICKS: [number, number] = [90, 260];
/** how near a spot weighs half (tiles): weight 1 / (1 + (d / NEAR_TILES)²) */
const NEAR_TILES = 40;

export type HangoutKind = 'park' | 'square' | 'bank';

export interface HangoutSpot {
    key: string;
    kind: HangoutKind;
    x: number;
    z: number;
    /** the tiles it stands on: within this many of (x, z), reachable from it */
    radius: number;
    members?: boolean;
    /** only from this combat level (Draynor's dark wizards) */
    minCombat?: number;
    /** only for a bot standing in this box (Al Kharid: inside its wall, past the toll) */
    from?: [x0: number, z0: number, x1: number, z1: number];
}

/** the park and the square weigh this much more than a bank */
const KIND_WEIGHT: Readonly<Record<HangoutKind, number>> = { park: 3, square: 3, bank: 1 };

export const HANGOUT_SPOTS: readonly HangoutSpot[] = [
    // the park's lawns round the middle (2984-3010, 3364-3388); the square round Varrock's fountain
    { key: 'falador_park', kind: 'park', x: 2997, z: 3375, radius: 7 },
    { key: 'varrock_square', kind: 'square', x: 3212, z: 3428, radius: 6 },
    // the banks' halls (not Varrock West: the trade hub, its crowd is the vendors')
    { key: 'varrock_east_bank', kind: 'bank', x: 3253, z: 3420, radius: 4 },
    { key: 'falador_west_bank', kind: 'bank', x: 2946, z: 3368, radius: 4 },
    { key: 'falador_east_bank', kind: 'bank', x: 3013, z: 3355, radius: 4 },
    { key: 'draynor_bank', kind: 'bank', x: 3092, z: 3245, radius: 4, minCombat: 16 },
    { key: 'edgeville_bank', kind: 'bank', x: 3093, z: 3491, radius: 4 },
    { key: 'al_kharid_bank', kind: 'bank', x: 3269, z: 3165, radius: 4, from: [3269, 3140, 3330, 3330] },
    { key: 'catherby_bank', kind: 'bank', x: 2808, z: 3441, radius: 4, members: true },
    { key: 'seers_bank', kind: 'bank', x: 2725, z: 3493, radius: 4, members: true },
    { key: 'ardougne_south_bank', kind: 'bank', x: 2655, z: 3283, radius: 4, members: true },
    { key: 'ardougne_north_bank', kind: 'bank', x: 2615, z: 3332, radius: 4, members: true },
    { key: 'yanille_bank', kind: 'bank', x: 2613, z: 3093, radius: 4, members: true }
];

/** the trade banks' stalls (a vendor's place): never a hang-out's tile, nor one beside it */
const STALL_TILES = new Set<number>();
for (const bank of TRADE_BANKS) for (const [x, z] of bank.stalls) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) STALL_TILES.add(((x + dx) << 14) | (z + dz));

/** Not a trade bank's stall tile or one beside it (a vendor comes to stand there): for any stand (a social regular's too) */
export function offStalls(x: number, z: number): boolean {
    return !STALL_TILES.has((x << 14) | z);
}

/** each bank spot's tiles in front of a booth (where the others stand to bank): never a hang-out's tile (found once) */
const boothFronts = new Map<string, Set<number>>();
function boothFrontsOf(spot: HangoutSpot): Set<number> {
    let tiles = boothFronts.get(spot.key);
    if (tiles) return tiles;
    tiles = new Set();
    if (spot.kind === 'bank') {
        const booth = LocType.getId('bankbooth');
        const r = spot.radius + 3;
        for (let zx = (spot.x - r) >> 3; zx <= (spot.x + r) >> 3; zx++) {
            for (let zz = (spot.z - r) >> 3; zz <= (spot.z + r) >> 3; zz++) {
                for (const loc of getWorld().gameMap.getZone(zx << 3, zz << 3, 0).getAllLocsSafe()) {
                    if (loc.type !== booth) continue;
                    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) tiles.add(((loc.x + dx) << 14) | (loc.z + dz));
                }
            }
        }
    }
    boothFronts.set(spot.key, tiles);
    return tiles;
}

/** a tile a hang-out may stand on: no vendor's stall (nor beside one), no booth's front */
function standable(spot: HangoutSpot, x: number, z: number): boolean {
    const key = (x << 14) | z;
    return !STALL_TILES.has(key) && !boothFrontsOf(spot).has(key);
}

interface Schedule {
    /** the play tick the next hang-out is due (World ticks: the bot is online only while a human is) */
    due: number;
    /** hang-outs this login, and the last one's spot (tests, the report) */
    count: number;
    last: string | null;
    /** (the fixes, tests) the test rate its due was drawn at: a lower rate set later pushes it back (setHangoutRateForTest) */
    rate: number;
}
const schedules = new WeakMap<Player, Schedule>();

/** Tests only (test/hangout.test.mjs): hang-outs this many times as often. Never set by the game. */
let testRate = 1;
export function setHangoutRateForTest(rate: number): void {
    testRate = rate;
}

/** ticks to the next hang-out: 1-2 hours, shorter for a sociable bot (×0.7 at sociability 0.9, ×1.4 at 0.1) */
function gapTicks(bot: Player): number {
    const sociability = botPersona(bot).sociability;
    const gap = HANGOUT_GAP_TICKS[0] + Math.random() * (HANGOUT_GAP_TICKS[1] - HANGOUT_GAP_TICKS[0]);
    return Math.round(gap / (0.6 + 0.8 * sociability) / testRate);
}

function scheduleOf(bot: Player): Schedule {
    let s = schedules.get(bot);
    if (!s) {
        // (the first comes anywhere in a gap, so a login's chances are the hour's, whatever its session's length; not
        // all of the bots together)
        s = { due: World.currentTick + Math.round(gapTicks(bot) * (0.05 + 0.95 * Math.random())), count: 0, last: null, rate: testRate };
        schedules.set(bot, s);
    } else if (s.rate !== testRate && s.due !== Infinity) {
        // (the variety work, round 1, the fixes: a test's lower rate applies to the bots whose first was drawn before it
        // was set, at the fill: a stand-in fighter's bank stop became a hang-out of 380 ticks in the middle of its
        // staging. No dice: the tests' other stagings draw as before)
        if (testRate < s.rate) s.due = Math.max(s.due, World.currentTick + Math.round(HANGOUT_GAP_TICKS[0] / testRate));
        s.rate = testRate;
    } else if (s.due === Infinity && hangoutOf(bot) === null) {
        // (a hang-out dropped unfinished: a sub-task another replaced, "come here"; the next is due as after one)
        releaseStandTile(bot);
        s.due = World.currentTick + gapTicks(bot);
    }
    return s;
}

/** The hang-outs this bot could go to from where it stands (world type, combat, a box it must be in). */
function spotsFor(bot: Player): HangoutSpot[] {
    const members = isMembersWorld();
    return HANGOUT_SPOTS.filter(s => (members || !s.members) && bot.combatLevel >= (s.minCombat ?? 0) && (!s.from || (bot.x >= s.from[0] && bot.x <= s.from[2] && bot.z >= s.from[1] && bot.z <= s.from[3])));
}

/** One of the hang-outs within HANGOUT_RANGE, the nearer the likelier, the park and the square three times a bank; null: none. */
export function pickHangout(bot: Player): HangoutSpot | null {
    if (bot.level !== 0) return null;
    const near: [HangoutSpot, number][] = [];
    for (const s of spotsFor(bot)) {
        const d = Math.max(Math.abs(bot.x - s.x), Math.abs(bot.z - s.z));
        if (d <= HANGOUT_RANGE) near.push([s, KIND_WEIGHT[s.kind] / (1 + (d / NEAR_TILES) ** 2)]);
    }
    if (near.length === 0) return null;
    let roll = Math.random() * near.reduce((sum, [, w]) => sum + w, 0);
    for (const [s, w] of near) {
        roll -= w;
        if (roll <= 0) return s;
    }
    return near[near.length - 1][0];
}

/** Free for a hang-out: a levelling bot, not a newbie, on the overworld out of the Wilderness, not hurt, its pack not full. */
function mayHangOut(bot: Player): boolean {
    if (!isLevelling(bot.botPlanner as PlannerKey) || isNewbie(bot)) return false;
    if (bot.level !== 0 || bot.z >= 6400 || wildernessLevelAt(bot.x, bot.z) > 0) return false;
    if (bot.botComeHereReturnX !== -1 || bot.botTradeTargetPid !== -1) return false;
    // (port, phase 5b: nor in a set piece, port/BotSetPieces)
    if (eventRoleOf(bot)) return false;
    if (bot.levels[PlayerStat.HITPOINTS] * 2 < bot.baseLevels[PlayerStat.HITPOINTS]) return false;
    return !isInventoryFull(bot);
}

/**
 * The planner, picking a bot's next task: a hang-out when one is due and the bot is free for it (else null, and the
 * planner goes on). `previous`: the task that just ended (never two hang-outs in a row).
 */
export function hangoutFor(bot: Player, previous: string | null = null): HangoutTask | null {
    const s = scheduleOf(bot);
    if (World.currentTick < s.due || previous === 'Hangout' || !mayHangOut(bot)) return null;
    const spot = pickHangout(bot);
    // (no hang-out near: it looks again in a while, not at every pick)
    if (!spot) {
        s.due = World.currentTick + 600;
        return null;
    }
    // (Infinity once it begins, and drawn again when it ends; a pick the bot never takes up is due again in a while)
    s.due = World.currentTick + 1500;
    return new HangoutTask(spot);
}

/** The hang-out began (its first tick): none is due until it ends. */
function hangoutBegan(bot: Player): void {
    scheduleOf(bot).due = Infinity;
}

/**
 * port/BotHabits.bankStop, at a bank booth: a hang-out when one is due (else null), picked as the planner's is (the
 * nearer the likelier within HANGOUT_RANGE, the park and the square three times a bank: from Falador's banks the park
 * about half the time, from Varrock East the square; from Al Kharid or Edgeville that bank itself). The habits make it
 * the bot's sub-task: its plan resumes after it (the rest of the bank stop, then on with its load). Gatherers stop at a
 * bank every few minutes: the planner alone (between plans of 15-60 minutes) gave a hang-out about every 6-9 hours of
 * play, not every 1-2.
 */
export function hangoutAtBank(bot: Player): HangoutTask | null {
    const s = scheduleOf(bot);
    if (World.currentTick < s.due || !mayHangOut(bot)) return null;
    const spot = pickHangout(bot);
    if (!spot) {
        s.due = World.currentTick + 600;
        return null;
    }
    s.due = World.currentTick + 1500;
    return new HangoutTask(spot);
}

/** The hang-out ended (its stand done, cut short or given up): the next is due 1-2 hours on. */
function hangoutEnded(bot: Player, spot: HangoutSpot): void {
    const s = scheduleOf(bot);
    s.count++;
    s.last = spot.key;
    s.due = World.currentTick + gapTicks(bot);
}

/** The bot's hang-outs this login and the last one's place (tests, the report). */
export function hangoutsOf(bot: Player): { count: number; last: string | null; due: number } | null {
    const s = schedules.get(bot);
    return s ? { count: s.count, last: s.last, due: s.due } : null;
}

/** The hang-out the bot is on: its task's, or its sub-task's (one begun at a bank stop); null: none. (port/BotHabits: a
 * break may come at one, a linger never; the reports) */
export function hangoutOf(bot: Player): HangoutTask | null {
    const ai = (bot as unknown as { _bot?: { currentTask?: BotTask | null; subTask?: BotTask | null } })._bot;
    const sub = ai?.subTask ?? null;
    if (sub instanceof HangoutTask) return sub;
    const task = ai?.currentTask ?? null;
    return task instanceof HangoutTask ? task : null;
}

const FIDGET_EMOTES: readonly Emote[] = ['wave', 'dance', 'wave'];
/** a fidget that is not a step is an emote this seldom (else a look about), and an everyday one (port/BotEmote:
 * "rare and special": a hang-out's emote every 1-4 minutes was 180 an hour among 500 bots) */
const FIDGET_EMOTE_CHANCE = 0.1;

/**
 * A hang-out: to the spot's tile of its own, a stand of 3-10 minutes there (an emote or a step now and then), done.
 * Its tile goes back when it ends, is cut short or the bot logs out (reset).
 */
export class HangoutTask extends BotTask {
    readonly spot: HangoutSpot;
    private state: 'walk' | 'stand' | 'done' = 'walk';
    private tile: [number, number] | null = null;
    private walkTicks = 0;
    /** ticks it has stood still beside its tile (something stands on it: an NPC), and the tiles it gave up on */
    private blocked = 0;
    private reclaims = 0;
    private standUntil = -1;
    private nextFidget = -1;
    private began = false;
    private ended = false;
    private lastPlayer: Player | null = null;
    private readonly stuck = new StuckDetector(30, 4, 2);

    constructor(spot: HangoutSpot) {
        super('Hangout');
        this.spot = spot;
    }

    /** standing on its tile at the spot */
    get standing(): boolean {
        return this.state === 'stand';
    }

    shouldRun(player: Player): boolean {
        return this.state !== 'done' && wildernessLevelAt(player.x, player.z) === 0;
    }

    isComplete(_player: Player): boolean {
        return this.state === 'done';
    }

    tick(player: Player): void {
        this.lastPlayer = player;
        if (this.interrupted || this.state === 'done') return;
        if (!this.began) {
            this.began = true;
            hangoutBegan(player);
            // (begun at a bank stop: the bank's window shut first, as a player does to stand and talk)
            if (player.modalMain !== -1) player.closeModal();
            // (the variety work, round 1, the fixes: and its click on the booth let go: kept, the engine walked the bot back
            // to the booth from its tile, or across the wall from it: "I can't reach that!" at Al Kharid's and Draynor's)
            player.clearPendingAction();
        }
        const now = World.currentTick;
        if (this.state === 'walk') {
            if (!this.tile) this.tile = claimStandTile(player, this.spot.x, this.spot.z, 0, this.spot.radius, (x, z) => standable(this.spot, x, z));
            if (!this.tile) return this._end(player);
            const [tx, tz] = this.tile;
            const d = player.level === 0 ? Math.max(Math.abs(player.x - tx), Math.abs(player.z - tz)) : 99;
            if (d === 0) {
                player.clearWaypoints();
                if (this.standUntil < 0) this.standUntil = now + randInt(HANGOUT_STAND_TICKS[0], HANGOUT_STAND_TICKS[1]);
                this.state = 'stand';
                this.nextFidget = now + randInt(FIDGET_TICKS[0], FIDGET_TICKS[1]);
                this.blocked = 0;
                return;
            }
            if (++this.walkTicks > WALK_LIMIT_TICKS) return this._end(player);
            // (beside its tile and not getting on: something stands there, an NPC; or no way found to it: another tile,
            // twice, then where it is)
            if (d === 1 && !player.hasWaypoints()) this.blocked++;
            if (this.blocked >= 8) {
                this.blocked = 0;
                releaseStandTile(player);
                this.tile = ++this.reclaims <= 2 ? claimStandTile(player, this.spot.x, this.spot.z, 0, this.spot.radius, (x, z) => (x !== tx || z !== tz) && standable(this.spot, x, z)) : claimStandTile(player, player.x, player.z, 0, 0);
                return;
            }
            // (near its tile: the last steps straight to it; further: the walk, with the stuck checks of every task)
            if (d <= 12) {
                // (no way found to it: counted as blocked, another tile soon)
                if (!player.hasWaypoints() && !stepToTile(player, tx, tz)) this.blocked += 4;
                return;
            }
            if (!this.stuck.check(player, tx, tz)) walkTo(player, tx, tz);
            else if (this.stuck.desperatelyStuck) {
                teleportNear(player, tx, tz);
                this.stuck.reset();
            } else walkTo(player, player.x + randInt(-6, 6), player.z + randInt(-6, 6));
            return;
        }
        // standing: done when its time is up; off its tile (a fight, a push), back to it; now and then an emote, or a
        // step to another free tile of the spot
        if (now >= this.standUntil) return this._end(player);
        if (this.tile && (player.x !== this.tile[0] || player.z !== this.tile[1]) && !player.hasWaypoints()) {
            this.state = 'walk';
            return;
        }
        if (now < this.nextFidget || player.hasWaypoints() || player.delayed) return;
        this.nextFidget = now + randInt(FIDGET_TICKS[0], FIDGET_TICKS[1]);
        if (Math.random() < 0.3) {
            // (a person shifting about: a step or two)
            const here: [number, number] = [player.x, player.z];
            const tile = claimStandTile(player, here[0], here[1], 0, 2, (x, z) => (x !== here[0] || z !== here[1]) && standable(this.spot, x, z) && Math.max(Math.abs(x - this.spot.x), Math.abs(z - this.spot.z)) <= this.spot.radius);
            if (tile) {
                this.tile = tile;
                this.state = 'walk';
            } else this.tile = claimStandTile(player, here[0], here[1], 0, 0);
            return;
        }
        if (Math.random() < FIDGET_EMOTE_CHANCE) everydayEmote(player, FIDGET_EMOTES[Math.floor(Math.random() * FIDGET_EMOTES.length)]);
    }

    private _end(player: Player): void {
        this.state = 'done';
        this._release(player);
    }

    /** its tile back; the next hang-out due (once, when one that began ends) */
    private _release(player: Player | null): void {
        if (!player) return;
        releaseStandTile(player);
        if (this.began && !this.ended) {
            this.ended = true;
            hangoutEnded(player, this.spot);
        }
    }

    override interrupt(): void {
        super.interrupt();
        this.state = 'done';
        this._release(this.lastPlayer);
    }

    override reset(): void {
        super.reset();
        this._release(this.lastPlayer);
        if (this.ended) this.state = 'done';
        else {
            this.state = 'walk';
            this.tile = null;
            this.walkTicks = 0;
            this.blocked = 0;
            this.reclaims = 0;
            this.stuck.reset();
        }
    }
}
