// port (the realism work, phase 5b, Track P: drop parties and the Seers' Party Room; port/BotParty): a party's guest, a
// sub-task like a hang-out's (port/BotHangout): its own task waits and goes on after.
//
//   - to a tile of its own near the drop square (within 4 tiles), or in the Party Room (port/BotTiles), on foot (a walk of
//     at most 300 ticks, then it gives up); a wave or a dance while it waits, a word now and then ("wheres the party");
//   - F2P: 274 shows the piles 100 ticks after each was dropped. The guest's first grab comes a person's moment (2-6
//     ticks) after the first shows, then one every 2-4 ticks: the nearest pile within 6 tiles that no other guest is
//     after, with the item's own Take ([opobj3]: the engine walks it there and checks the item is everyone's now); 2-5
//     items, then a word ("lol 1 coin drop", "free runes lol", "ty!!"); 30 s with nothing left to take and it goes;
//   - the Party Room: once the balloons fall, the nearest within 8 tiles every 3-8 ticks (Burst: [oploc1,_party_balloon]),
//     5-20 of them; the item a pop drops (1 in 4) is its own (274 gives it to the popper for its whole life), picked up
//     at once.
// The human is never crowded out: a guest goes only for the party's own piles, after the reveal, at a person's pace.
import { BotTask, Player, walkTo, StuckDetector, teleportNear, randInt, InvType } from '#/engine/bot/tasks/BotTaskBase.js';
import Obj from '#/engine/entity/Obj.js';
import type Loc from '#/engine/entity/Loc.js';
import LocType from '#/cache/config/LocType.js';
import ObjType from '#/cache/config/ObjType.js';
import World from '#/engine/World.js';
import { findLocByPrefixWhere, interactLocOp, interactObjOp } from '#/engine/bot/BotAction.js';
import { botEmote } from '#/engine/bot/port/BotEmote.js';
import { claimStandTile, releaseStandTile, stepToTile } from '#/engine/bot/port/BotTiles.js';
import { botPersona, logNormal } from '#/engine/bot/port/BotTiming.js';
import { PARTY, isTool, type PartyRun } from '#/engine/bot/port/BotParty.js';
import { interactHeldOp } from '#/engine/bot/BotAction.js';
import { itemValue } from '#/engine/bot/port/BotPrices.js';

type Stage = 'walk' | 'wait' | 'grab' | 'pop' | 'linger' | 'done';

/** the walk to the venue is given up after this long (ticks): a Party Room guest may come from 250 tiles */
const WALK_LIMIT = 650;
/** a guest stands within this of the drop square's middle (F2P) */
const STAND_RADIUS = 4;
/** it takes piles within this of the square's middle, and balloons within this of itself */
const GRAB_RADIUS = 6;
const POP_RADIUS = 8;
/** with nothing left to take for this long after the last pile showed, it goes (30 s) */
const DONE_AFTER = 50;
/** a guest this far from the venue once there (or on another floor) was moved off: its part is over */
const MOVED_OFF = 30;
/** (the variety work, round 1, track F: ISS-3) a full pack drops at most this many pieces of junk worth this much or less */
const JUNK_DROPS = 2;
const JUNK_VALUE = 40;
/** (the fixes) what a gatherer's or a fighter's pack fills with, by 274 debugname: logs, ores, coal, clay, essence, raw fish and meat, bones, ashes, hides, flax, wool, burnt food, seaweed */
const GATHERED_LOAD = /^(raw_|burnt_|burntfish)|(^|_)logs$|_ore$|^(coal|clay|blankrune|bones|bat_bones|big_bones|ashes|cow_hide|flax|wool|seaweed)$/;

/**
 * (the fixes) a gathered load a guest may drop for a pile: its debugname one of GATHERED_LOAD's, tradeable, nothing worn
 * (a weapon in the pack is one a tool took the hand of) and no talisman
 */
export function isGatheredLoad(id: number): boolean {
    const type = ObjType.get(id);
    if (!type || !type.tradeable || type.wearpos !== -1) return false;
    const name = type.debugname ?? '';
    return !name.endsWith('talisman') && GATHERED_LOAD.test(name);
}
let coinsId = -2;
const COINS_ID = (): number => (coinsId === -2 ? (coinsId = ObjType.getId('coins')) : coinsId);

const cheb = (ax: number, az: number, bx: number, bz: number): number => Math.max(Math.abs(ax - bx), Math.abs(az - bz));

function randIn([lo, hi]: readonly [number, number]): number {
    return randInt(lo, hi);
}

/** how many of the item the pack holds */
function carried(player: Player, id: number): number {
    const inv = player.getInventory(InvType.INV);
    let n = 0;
    for (let s = 0; inv && s < inv.capacity; s++) if (inv.get(s)?.id === id) n += inv.get(s)!.count;
    return n;
}

/** the pack has room for it (a stack it holds, or a free slot) */
function roomFor(player: Player, obj: Obj): boolean {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return false;
    if (ObjType.get(obj.type).stackable && carried(player, obj.type) > 0) return true;
    return inv.freeSlotCount > 0;
}

// ── balloons (the Party Room: the host's pops and the guests') ──────────────────────────────────────────────────

export interface PopState {
    target: Loc | null;
    since: number;
    pops: number;
    max: number;
    /** pops end by then */
    until: number;
    /** no balloon near since then (-1: there was one) */
    emptySince: number;
    nextAt: number;
    /** an item a pop dropped for it, being picked up */
    item?: Obj | null;
    itemBefore?: number;
}

const isBalloon = (loc: Loc): boolean => {
    const name = LocType.get(loc.type).debugname ?? '';
    return name.startsWith('balloon') && !name.endsWith('_pop');
};

/** an item on or beside the bot's tile that is its own (a pop's drop: 274 gives it to the popper) */
function ownDropNear(player: Player): Obj | null {
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            const zone = World.gameMap.getZone(player.x + dx * 8, player.z + dz * 8, player.level);
            for (const obj of zone.getAllObjsSafe()) {
                if (obj.receiver64 === player.hash64 && cheb(obj.x, obj.z, player.x, player.z) <= 1) return obj;
            }
        }
    }
    return null;
}

/**
 * One step of popping balloons in the Party Room: pick up its own drop first, else burst the nearest balloon within 8
 * tiles no one else is after (a person's 3-8 ticks apart). 'popped': a balloon it went for burst under it; 'over': its
 * pops are done, the time is up, or no balloon has been near for 20 ticks.
 */
export function popStep(player: Player, run: PartyRun, st: PopState, now: number): 'popped' | 'busy' | 'over' {
    if (player.delayed) return 'busy';
    // its own item first (it lives 100 ticks: 274's inv_dropitem)
    if (st.item) {
        if (!st.item.isActive) {
            const got = carried(player, st.item.type) - (st.itemBefore ?? 0);
            if (got > 0) {
                run.record.pops.items++;
                if (player === run.host) run.record.hostGot.push({ item: ObjType.get(st.item.type).debugname ?? String(st.item.type), count: got });
            }
            st.item = null;
        } else if (player.target === null && !player.hasWaypoints() && now - st.since > 10) st.item = null;
        else return 'busy';
    }
    const mine = ownDropNear(player);
    if (mine && roomFor(player, mine)) {
        st.item = mine;
        st.itemBefore = carried(player, mine.type);
        st.since = now;
        interactObjOp(player, mine, 3);
        return 'busy';
    }
    let result: 'popped' | 'busy' = 'busy';
    if (st.target) {
        const burst = !st.target.isActive || !isBalloon(st.target);
        if (burst) {
            if (cheb(player.x, player.z, st.target.x, st.target.z) === 0) {
                st.pops++;
                result = 'popped';
            }
            st.target = null;
            st.nextAt = now + randIn(PARTY.popGap);
        } else if (now - st.since > 15) st.target = null;
        else return 'busy';
    }
    if (st.pops >= st.max || now >= st.until) return 'over';
    if (now < st.nextAt || player.hasWaypoints()) return result;
    const balloon = findLocByPrefixWhere(player.x, player.z, player.level, 'balloon', POP_RADIUS, loc => !run.isClaimed(loc, player) && isBalloon(loc), '_pop');
    if (!balloon) {
        if (st.emptySince < 0) st.emptySince = now;
        return now - st.emptySince > 20 && run.balloonsAt >= 0 && now - run.balloonsAt > 60 ? 'over' : result;
    }
    st.emptySince = -1;
    run.claim(balloon, player);
    st.target = balloon;
    st.since = now;
    interactLocOp(player, balloon, 1);
    return result;
}

export class PartyGuestTask extends BotTask {
    readonly run: PartyRun;
    stage: Stage = 'walk';
    lastTick = World.currentTick;
    private player: Player | null = null;
    private tile: [number, number] | null = null;
    private walkTicks = 0;
    private blocked = 0;
    private reclaims = 0;
    private readonly stuck = new StuckDetector(30, 4, 2);
    private nextFidget = -1;
    private grabAt = -1;
    private takes = 0;
    private readonly maxTakes = randIn(PARTY.takes);
    private target: Obj | null = null;
    private targetSince = -1;
    private targetBefore = 0;
    private lastGot: Obj | null = null;
    private nextGrab = -1;
    /** when it notices each pile (its reveal and a person's moment: the first quickest, the rest as its eyes find them) */
    private readonly noticeAt = new Map<Obj, number>();
    private readonly pop: PopState = { target: null, since: -1, pops: 0, max: randIn(PARTY.pops), until: -1, emptySince: -1, nextAt: -1 };
    private leaveAt = -1;
    private saidWait = false;

    /** (the variety work, round 1, track F: ISS-3) a passer-by who joined, not asked (its arrival is counted apart) */
    readonly walkIn: boolean;
    /** (variety round 1, F) junk it dropped to make room for a pile (at most JUNK_DROPS) */
    private junkDropped = 0;

    constructor(run: PartyRun, walkIn = false) {
        super('PartyGuest');
        this.run = run;
        this.walkIn = walkIn;
    }

    shouldRun(_p: Player): boolean {
        return this.stage !== 'done';
    }

    isComplete(_p: Player): boolean {
        return this.stage === 'done';
    }

    /** the party is over, or the guest leaves it: its tile back */
    finish(): void {
        if (this.stage === 'done') return;
        this.stage = 'done';
        if (this.player) releaseStandTile(this.player);
    }

    override reset(): void {
        super.reset();
        if (this.player) releaseStandTile(this.player);
        this.tile = null;
    }

    tick(player: Player): void {
        const now = World.currentTick;
        this.player = player;
        this.lastTick = now;
        if (this.run.phase === 'done') return this.finish();
        // (moved off the venue once there: a random event's teleport, a death; it does not walk back, as a person rarely
        // would)
        if ((this.stage === 'wait' || this.stage === 'grab' || this.stage === 'pop') && this.movedOff(player)) return this.finish();
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        switch (this.stage) {
            case 'walk':
                return this.walkThere(player, now);
            case 'wait':
                return this.wait(player, now);
            case 'grab':
                return this.grab(player, now);
            case 'pop':
                return this.popBalloons(player, now);
            case 'linger':
                if (now >= this.leaveAt) this.finish();
                return;
        }
    }

    private room(): boolean {
        return this.run.kind === 'party_room';
    }

    private movedOff(player: Player): boolean {
        const v = this.run.venue;
        return player.level !== v.level || cheb(player.x, player.z, v.drop[0], v.drop[1]) > MOVED_OFF;
    }

    /** a tile of its own near the drop square, or in the room */
    private claim(player: Player): [number, number] | null {
        const v = this.run.venue;
        const [x, z] = v.drop;
        if (v.room) {
            const [x0, z0, x1, z1] = v.room;
            return claimStandTile(player, x, z, v.level, 8, (tx, tz) => tx >= x0 && tx <= x1 && tz >= z0 && tz <= z1);
        }
        return claimStandTile(player, x, z, v.level, STAND_RADIUS);
    }

    private walkThere(player: Player, now: number): void {
        if (!this.tile) this.tile = this.claim(player);
        if (!this.tile) return this.giveUp();
        const [tx, tz] = this.tile;
        const d = player.level === this.run.venue.level ? cheb(player.x, player.z, tx, tz) : 99;
        if (d === 0) {
            player.clearWaypoints();
            this.stage = 'wait';
            this.run.noteArrived(this.walkIn);
            this.nextFidget = now + randInt(10, 80);
            return;
        }
        if (++this.walkTicks > WALK_LIMIT) return this.giveUp();
        if (d === 1 && !player.hasWaypoints()) this.blocked++;
        if (this.blocked >= 8) {
            this.blocked = 0;
            releaseStandTile(player);
            this.tile = ++this.reclaims <= 2 ? this.claim(player) : claimStandTile(player, player.x, player.z, player.level, 0);
            return;
        }
        // (near its tile: the last steps straight to it; further: the walk, with the stuck checks of every task)
        if (d <= 12) {
            if (!player.hasWaypoints() && !stepToTile(player, tx, tz)) this.blocked += 4;
            return;
        }
        if (!this.stuck.check(player, tx, tz)) walkTo(player, tx, tz);
        else if (this.stuck.desperatelyStuck) {
            teleportNear(player, tx, tz);
            this.stuck.reset();
        } else walkTo(player, player.x + randInt(-6, 6), player.z + randInt(-6, 6));
    }

    private giveUp(): void {
        this.finish();
    }

    /** until the piles show (F2P) or the balloons fall (the Party Room): a wave or a dance, a word now and then */
    private wait(player: Player, now: number): void {
        const run = this.run;
        if (run.phase === 'end') return this.leave(now, null);
        if (!this.room()) {
            const reveal = run.firstRevealAt;
            if (reveal >= 0 && now >= reveal) {
                if (this.grabAt < 0) this.grabAt = reveal + randIn(PARTY.firstGrab);
                if (now >= this.grabAt) {
                    this.stage = 'grab';
                    if (Math.random() < 0.3) botEmote(player, 'cheer');
                    if (Math.random() < 0.2 * (0.5 + botPersona(player).sociability)) run.guestLine(player, 'guest-reveal');
                    return this.grab(player, now);
                }
                return;
            }
        } else if (run.balloonsAt >= 0) {
            if (this.grabAt < 0) this.grabAt = run.balloonsAt + randIn([4, 12]);
            if (now >= this.grabAt) {
                this.stage = 'pop';
                this.pop.until = now + 360;
                // (5-20 pops; a small party's few guests pop more of the 200: the chest's items are in them)
                const few = Math.max(0, 5 - run.guests.size);
                this.pop.max = randIn([Math.min(PARTY.pops[1], PARTY.pops[0] + 4 * few), PARTY.pops[1]]);
                return;
            }
        }
        if (now < this.nextFidget || player.hasWaypoints() || player.delayed) return;
        this.nextFidget = now + randInt(50, 180);
        const sociable = botPersona(player).sociability;
        if (!this.saidWait && Math.random() < 0.15 + 0.2 * sociable) {
            this.saidWait = true;
            if (run.guestLine(player, 'guest-wait')) return;
        }
        // (a dance or a wave a fidget in three: every fidget before 2026-10-19, "emotes rare and special")
        if (Math.random() < 0.35) botEmote(player, Math.random() < 0.55 ? 'dance' : 'wave');
    }

    /** F2P: the scramble (one pile every 2-4 ticks, the nearest within 6 tiles no other guest is after) */
    private grab(player: Player, now: number): void {
        const run = this.run;
        if (player.delayed) return;
        if (this.target) {
            const t = this.target;
            if (!t.isActive) {
                if (carried(player, t.type) > this.targetBefore) {
                    this.takes++;
                    this.lastGot = t;
                    run.noteTake(t, player);
                }
                this.target = null;
                this.nextGrab = now + randIn(PARTY.grabGap) - 1;
            } else if (now - this.targetSince > 12 && player.target === null && !player.hasWaypoints()) this.target = null;
            else return;
        }
        if (this.takes >= this.maxTakes) return this.leave(now, this.lastGot);
        if (now < this.nextGrab || player.hasWaypoints()) return;
        // (the variety work, round 1, track F: ISS-3) a full pack: a piece of junk dropped for the piles now and then (as
        // players did), else it watches the scramble
        const inv = player.getInventory(InvType.INV);
        if (inv && inv.freeSlotCount === 0 && run.drops.some(d => d.obj.isActive && d.obj.receiver64 === Obj.NO_RECEIVER) && this.dropJunk(player)) {
            this.nextGrab = now + randIn(PARTY.grabGap);
            return;
        }
        const [cx, cz] = run.venue.drop;
        let best: Obj | null = null;
        let bestD = Infinity;
        for (const { obj, note } of run.drops) {
            if (!obj.isActive || obj.receiver64 !== Obj.NO_RECEIVER || obj.level !== player.level) continue;
            if (cheb(obj.x, obj.z, cx, cz) > GRAB_RADIUS || run.isClaimed(obj, player) || !roomFor(player, obj)) continue;
            // (a pile it has not noticed yet: a person's eyes find a new one a moment after it shows, among many)
            let seen = this.noticeAt.get(obj);
            if (seen === undefined) this.noticeAt.set(obj, (seen = Math.max(0, note.revealAt) + this.noticeDelay(player, cheb(obj.x, obj.z, player.x, player.z), obj === run.drops[0].obj)));
            if (now < seen) continue;
            const d = cheb(obj.x, obj.z, player.x, player.z);
            if (d < bestD) {
                bestD = d;
                best = obj;
            }
        }
        if (!best) {
            const last = run.lastRevealAt;
            if (run.dropsDone && last >= 0 && now > last + DONE_AFTER) return this.leave(now, this.lastGot);
            return;
        }
        run.claim(best, player);
        this.target = best;
        this.targetSince = now;
        this.targetBefore = carried(player, best.type);
        interactObjOp(player, best, 3);
    }

    /**
     * (variety round 1, F: ISS-3) drops the cheapest piece of junk in its pack (worth JUNK_VALUE or less: bones, ashes, ore,
     * logs; never a tool, coins, food or runes) with its own Drop, at most JUNK_DROPS a party; false when it has none.
     * (The fixes, the reviewer's: only a gathered load, isGatheredLoad. "Junk" was any cheap item that was no tool or food:
     * the bronze scimitar a gatherer with its axe in hand carries, armour, a hat, the air talisman (4 coins), a clue scroll
     * (1, untradeable): a bot keeps its items)
     */
    private dropJunk(player: Player): boolean {
        if (this.junkDropped >= JUNK_DROPS || player.delayed) return false;
        const inv = player.getInventory(InvType.INV);
        if (!inv) return false;
        let best = -1;
        let bestValue = Infinity;
        for (let slot = 0; slot < inv.capacity; slot++) {
            const it = inv.get(slot);
            if (!it || it.id === COINS_ID() || isTool(it.id) || !isGatheredLoad(it.id)) continue;
            const type = ObjType.get(it.id);
            if (type.stackable || (type.iop?.[0] ?? '').toLowerCase() === 'eat') continue;
            const v = itemValue(it.id);
            if (v <= JUNK_VALUE && v < bestValue) {
                best = slot;
                bestValue = v;
            }
        }
        if (best < 0) return false;
        const it = inv.get(best)!;
        if (!interactHeldOp(player, inv, it.id, best, 5)) return false;
        this.junkDropped++;
        return true;
    }

    /**
     * how long after a pile showed it notices it: the party's first pile at once (its grab began a person's reaction, 2-6
     * ticks, after it showed: everyone goes for it), the rest a log-normal moment (median 12 ticks, by its persona's
     * speed) and 2 a tile away: piles
     * show one by one among a crowd, each player watching round itself, and a human there gets the ones it is quicker to
     * (the humanlike report's DP3b: at most 60 % taken by bots within 10 ticks of showing; a test of 6-15 guests 25-55 %)
     */
    private noticeDelay(player: Player, dist: number, first: boolean): number {
        // (the first pile: its grab began a person's reaction after it showed, wait())
        if (first) return 0;
        const reaction = botPersona(player).reaction;
        return Math.max(3, Math.min(40, Math.round(logNormal(12 * reaction, 0.6)))) + 2 * dist;
    }

    /** the Party Room: balloons until its pops are done or none are near */
    private popBalloons(player: Player, now: number): void {
        const r = popStep(player, this.run, this.pop, now);
        if (r === 'popped') {
            this.run.record.pops.guests++;
            if (this.pop.pops === 2 && Math.random() < 0.15) this.run.guestLine(player, 'call-pop');
        }
        if (r === 'over') this.leave(now, null);
    }

    /** it is done here: a word now and then ("ty!!", "lol 1 coin drop", "nothing in mine lol"), then off */
    private leave(now: number, got: Obj | null): void {
        const player = this.player;
        this.stage = 'linger';
        this.leaveAt = now + randInt(5, 25);
        if (!player) return;
        const run = this.run;
        const p = 0.3 * (0.5 + botPersona(player).sociability);
        if (Math.random() >= p) return;
        if (got) {
            const name = ObjType.get(got.type).debugname ?? '';
            const kind = name === 'coins' && got.count <= 10 ? 'guest-got-coin' : name.endsWith('rune') ? (name === 'naturerune' ? 'guest-got-nat' : 'guest-got-runes') : ['shrimp', 'trout', 'salmon', 'tuna', 'lobster', 'swordfish', 'sardine', 'herring', 'pike', 'bass', 'anchovies'].includes(name) ? 'guest-got-food' : 'guest-got';
            if (!run.guestLine(player, kind)) run.guestLine(player, Math.random() < 0.5 ? 'guest-end' : 'guest-more');
        } else if (this.room() ? this.pop.pops > 0 && run.record.pops.items === 0 : this.takes === 0 && run.firstRevealAt >= 0) run.guestLine(player, 'guest-nothing');
        else run.guestLine(player, 'guest-end');
    }
}
