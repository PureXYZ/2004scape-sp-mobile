// port: high alchemy at a trade bank (the realism work, phase 5a, Track M; "yes" to alching, 2026-10-16): the
// classic 2004 bank sight. A bot with Magic 55+ stands at a trade bank and alchs what it made and looted (strung
// longbows, steel platebodies, gold rings, a spare piece of loot), casting the real spell on each item (the client's
// spell-on-item: BotAction.interactSpellOnHeld, 274's [opheldt,magic:highlvl_alchemy]: the level and the runes checked,
// a nature and five fire runes taken (a worn staff of fire pays the fire), the XP given, 0.6 × the item's value in
// coins, the caster held 3 ticks), every 5-7 ticks with a person's jitter and a look away now and then.
//
// The stint: to the bank's booth (advanceBankWalk), its pack banked, its natures out (and fire runes, or its staff of
// fire wielded: its weapon back on at the end), a load of what it may alch; a tile of its own by the bank (port/BotTiles,
// no vendor's stall); a cast every few ticks; another load while the bank has more, at most MAX_LOADS, until its time is
// up (3-9 minutes); the rest banked. Started between plans by the planner (port/BotAlch.alchTaskFor), every 40-90
// minutes of play for a bot that can.
//
// No profit loop: it never buys anything (no shop, no trade: the natures are its seed's, a runecrafter's or loot's);
// it alchs only what it owns, keeps one of each piece of gear (a spare stays a spare) and never a tool, food, runes,
// a staff, arrows, accessories, rares or an untradeable item; and never an item a shop sells for less than its alch
// value (alchableItems: no 274 shop does at its base stock: they sell at the item's value or above).
//
// The task's name is 'Magic' (port/BotLines: upstream's Magic lines fit an alcher, "High alching", "Need more nature
// runes" with its 'alch' event).
import {
    BotTask,
    Player,
    InvType,
    Items,
    StuckDetector,
    advanceBankWalk,
    bankInvId,
    humanDelay,
    randInt,
    FOOD_IDS
} from '#/engine/bot/tasks/BotTaskBase.js';
import ObjType from '#/cache/config/ObjType.js';
import World from '#/engine/World.js';
import { AxesByLevel, FishingGearByMethod, PickaxesByLevel } from '#/engine/bot/BotKnowledge.js';
import { interactHeldOp, interactSpellOnHeld } from '#/engine/bot/BotAction.js';
import { moveItems, depositItems } from '#/engine/bot/port/BotInventoryCompat.js';
import { claimStandTile, releaseStandTile, stepToTile } from '#/engine/bot/port/BotTiles.js';
import { offStalls } from '#/engine/bot/port/BotHangout.js';
import { isWardrobeItem, rareItems } from '#/engine/bot/port/BotLooks.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { noteEvent } from '#/engine/bot/port/BotChatter.js';
import { wieldLater } from '#/engine/bot/port/BotTeleport.js';
import type { TradeBank } from '#/engine/bot/port/BotTradeSpots.js';

/** the task's name (port/BotLines: the Magic lines fit it) */
export const ALCH_KIND = 'Magic';
/** the spell's button (magic tab), its level and runes (magic_spells.dbrow: a nature, five fire) */
export const HIGH_ALCH = 'magic:highlvl_alchemy';
export const HIGH_ALCH_LEVEL = 55;
const FIRE_PER_CAST = 5;
/** an item worth alching: its value at least this (an alch of 30+ coins) */
const MIN_VALUE = 50;
/** casts this many ticks apart (the script's own hold is 3), now and then a longer look away */
const CAST_GAP: [number, number] = [5, 7];
const LAPSE_CHANCE = 0.06;
const LAPSE_TICKS: [number, number] = [10, 30];
/** loads of the pack a stint takes at most */
const MAX_LOADS = 3;
/** its own tile within this many tiles of the bank's spot */
const STAND_RADIUS = 4;

/** port (phase 5a): what alching did so far (the humanlike report's AL1 detail, the tests) */
export const alchStats = { stints: 0, casts: 0, refused: 0, coins: 0, items: {} as Record<string, number> };

// ── what it may alch ─────────────────────────────────────────────────────────

let neverIds: Set<number> | null = null;
/** tools, food, runes, staves, arrows (whatever a bot uses up or works with), accessories and rares: never alched */
function never(): Set<number> {
    if (neverIds) return neverIds;
    neverIds = new Set<number>([Items.COINS, Items.LAW_RUNE, Items.NATURE_RUNE, Items.FIRE_RUNE, Items.AIR_RUNE, Items.WATER_RUNE, Items.EARTH_RUNE, Items.STAFF_OF_AIR, Items.STAFF_OF_WATER, Items.STAFF_OF_EARTH, Items.STAFF_OF_FIRE, ...FOOD_IDS, ...rareItems()]);
    for (const t of [...AxesByLevel, ...PickaxesByLevel]) neverIds.add(t.itemId);
    for (const list of Object.values(FishingGearByMethod)) for (const t of list) neverIds.add(t.itemId);
    return neverIds;
}

let keptIds: Set<number> | null = null;
/** what stays in the pack through a stint: tools (axes, pickaxes, fishing gear, a hammer, knife, chisel, needle,
 * tinderbox), runes and staves, coins */
function keptInPack(): Set<number> {
    if (keptIds) return keptIds;
    const food = new Set(FOOD_IDS);
    keptIds = new Set([...never()].filter(id => !food.has(id)));
    for (const id of [Items.HAMMER, Items.KNIFE, Items.CHISEL, Items.NEEDLE, Items.TINDERBOX]) keptIds.add(id);
    return keptIds;
}

/** The alch value of an item (274's alchemy.rs2: max(0.6 × its value, 1)). */
export function alchValue(id: number): number {
    return Math.max(Math.floor((ObjType.get(id).cost * 6) / 10), 1);
}

/**
 * Is this item one a bot alchs (whatever it holds of it)? Gear it made or looted: wearable, tradeable, worth MIN_VALUE,
 * not a tool, food, a rune, a staff (any: battlestaves and mystic staves too), arrows, an accessory or a rare, usable on
 * this world. No profit loop: an alcher never buys (no shop opens in a stint), natures come from a new bot's seed,
 * runecrafting or loot (no shop the bots buy at sells them), and what bots do buy they pay at least its value for
 * (RangedMagic, the law runs: the shop's price), above its alch value (0.6 of it). Not every 274 shop sells at the value
 * or more: Irksol's ruby rings are about half (shop_sell_multiplier 500), but no bot buys there.
 */
export function isAlchable(id: number): boolean {
    if (id < 0 || never().has(id) || isWardrobeItem(id)) return false;
    const type = ObjType.get(id);
    if (!type || !type.tradeable || type.cost < MIN_VALUE || type.wearpos < 0 || type.wearpos === 13 || type.stackable) return false;
    if ((type.debugname ?? '').includes('staff')) return false;
    return !type.members || isMembersWorld();
}

function inventoryItems(inv: ReturnType<Player['getInventory']>): Map<number, number> {
    const out = new Map<number, number>();
    for (let slot = 0; inv && slot < inv.capacity; slot++) {
        const it = inv.get(slot);
        if (it) out.set(it.id, (out.get(it.id) ?? 0) + it.count);
    }
    return out;
}

/**
 * What it may alch of what it owns (bank and pack), one of each kept: [item, how many], the dearest first. `worn`: the
 * pieces it took off for its staff of fire (in its pack meanwhile; its own gear, never counted).
 */
export function alchableItems(player: Player, worn: readonly number[] = []): [number, number][] {
    const bid = bankInvId();
    const owned = inventoryItems(bid === -1 ? null : player.getInventory(bid));
    for (const [id, n] of inventoryItems(player.getInventory(InvType.INV))) owned.set(id, (owned.get(id) ?? 0) + n);
    for (const id of worn) owned.set(id, (owned.get(id) ?? 0) - 1);
    const out: [number, number][] = [];
    for (const [id, n] of owned) if (n > 1 && isAlchable(id)) out.push([id, n - 1]);
    return out.sort((a, b) => ObjType.get(b[0]).cost - ObjType.get(a[0]).cost);
}

/** natures it owns, and whether it can pay the fire (a staff of fire, worn or owned, or the runes) for `casts` casts */
export function alchSupplies(player: Player): { natures: number; staff: boolean; fire: number } {
    const bid = bankInvId();
    const bank = bid === -1 ? null : player.getInventory(bid);
    const inv = player.getInventory(InvType.INV);
    const worn = player.getInventory(InvType.WORN);
    const n = (id: number): number => (inventoryItems(bank).get(id) ?? 0) + (inventoryItems(inv).get(id) ?? 0);
    const staff = worn?.get(3)?.id === Items.STAFF_OF_FIRE || n(Items.STAFF_OF_FIRE) > 0;
    return { natures: n(Items.NATURE_RUNE), staff, fire: n(Items.FIRE_RUNE) };
}

// ── the stint ────────────────────────────────────────────────────────────────

export class AlchTask extends BotTask {
    readonly bank: TradeBank;
    private readonly until: number;
    private state: 'walk' | 'withdraw' | 'stand' | 'cast' | 'reload' | 'deposit' | 'done' = 'walk';
    private readonly stuck = new StuckDetector(30, 4, 2);
    private tile: [number, number] | null = null;
    private loads = 0;
    private nextCast = 0;
    /** the cast it is checking: the item, its count and the natures before it */
    private check: { id: number; count: number; natures: number; at: number } | null = null;
    /** the weapon (and a two-handed staff's shield) it took off for its staff of fire: back on at the end */
    private restore: number[] = [];
    /** how many more of each item it may alch (all it owns of it but one, its gear aside: alchableItems at each load) */
    private allowance = new Map<number, number>();
    private standTicks = 0;
    private noted = false;
    private clickFails = 0;
    private began = false;
    private lastPlayer: Player | null = null;

    constructor(bank: TradeBank, until: number) {
        super(ALCH_KIND);
        this.bank = bank;
        this.until = until;
    }

    shouldRun(player: Player): boolean {
        return this.state !== 'done' && player.botTradeTargetPid === -1;
    }

    isComplete(_player: Player): boolean {
        return this.state === 'done';
    }

    tick(player: Player): void {
        this.lastPlayer = player;
        if (this.interrupted || this.state === 'done') return;
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        const now = World.currentTick;
        if (!this.began) {
            this.began = true;
            alchStats.stints++;
        }
        if (this.state === 'walk' || this.state === 'reload' || this.state === 'deposit') {
            const result = advanceBankWalk(player, this.stuck, this.bank.center);
            if (result === 'walk') return;
            this.cooldown = result === 'ready' ? humanDelay(player, 'bank') : 0;
            if (this.state === 'deposit') {
                this._finish(player);
                return;
            }
            this.state = 'withdraw';
            return;
        }
        if (this.state === 'withdraw') {
            if (!this._load(player)) {
                this.state = 'deposit';
                return;
            }
            this.loads++;
            this.state = 'stand';
            this.standTicks = 0;
            return;
        }
        if (this.state === 'stand') {
            if (!this.tile) this.tile = claimStandTile(player, this.bank.center[0], this.bank.center[1], 0, STAND_RADIUS, offStalls);
            // (no tile free: it alchs where it stands, by the booth)
            if (!this.tile || (player.x === this.tile[0] && player.z === this.tile[1]) || ++this.standTicks > 30) {
                this.state = 'cast';
                this.nextCast = now + randInt(1, 3);
                return;
            }
            if (!player.hasWaypoints() && !stepToTile(player, this.tile[0], this.tile[1])) this.standTicks += 10;
            return;
        }
        // 'cast': check the last one, then the next when its moment comes
        if (this.check && now > this.check.at) {
            const c = this.check;
            this.check = null;
            const inv = player.getInventory(InvType.INV);
            const items = inventoryItems(inv);
            if ((items.get(c.id) ?? 0) < c.count && (items.get(Items.NATURE_RUNE) ?? 0) < c.natures) {
                this.allowance.set(c.id, (this.allowance.get(c.id) ?? 0) - 1);
                alchStats.casts++;
                alchStats.coins += alchValue(c.id);
                const name = ObjType.get(c.id).debugname ?? String(c.id);
                alchStats.items[name] = (alchStats.items[name] ?? 0) + 1;
                // (its first of the stint: port/BotChatter's 'alch' event, its lines true a while, now and then one at once)
                if (!this.noted) {
                    this.noted = true;
                    noteEvent(player, 'alch');
                }
            } else {
                // (refused: the script said why; that item is done with for this stint)
                alchStats.refused++;
                this._bankItem(player, c.id);
            }
        }
        if (now < this.nextCast || player.delayed || this.check) return;
        const next = this._nextItem(player);
        const supplies = this._carriedSupplies(player);
        if (next === null || supplies === 0) {
            // the load is done: another while the bank has more and its time lasts; out of natures or fire, or done: the
            // rest to the bank
            const more = next === null && supplies > 0 && this.loads < MAX_LOADS && now < this.until && alchableItems(player, this.restore).length > 0;
            this.state = more ? 'reload' : 'deposit';
            return;
        }
        const [id, slot] = next;
        const inv = player.getInventory(InvType.INV);
        const before = inventoryItems(inv);
        if (!interactSpellOnHeld(player, HIGH_ALCH, id, slot)) {
            // (the spell's button not to be clicked, the magic tab gone: a few tries, then the stint ends)
            this.nextCast = now + 2;
            if (++this.clickFails >= 5) this.state = 'deposit';
            return;
        }
        this.clickFails = 0;
        this.check = { id, count: before.get(id) ?? 0, natures: before.get(Items.NATURE_RUNE) ?? 0, at: now };
        this.nextCast = now + randInt(CAST_GAP[0], CAST_GAP[1]) + (Math.random() < LAPSE_CHANCE ? randInt(LAPSE_TICKS[0], LAPSE_TICKS[1]) : 0);
    }

    /** casts its pack pays for: its natures, and the fire (a worn staff of fire, or five runes a cast) */
    private _carriedSupplies(player: Player): number {
        const items = inventoryItems(player.getInventory(InvType.INV));
        const natures = items.get(Items.NATURE_RUNE) ?? 0;
        const staff = player.getInventory(InvType.WORN)?.get(3)?.id === Items.STAFF_OF_FIRE;
        return staff ? natures : Math.min(natures, Math.floor((items.get(Items.FIRE_RUNE) ?? 0) / FIRE_PER_CAST));
    }

    /**
     * the next thing in its pack to alch (the first slot of one), or null: one it may alch more of (its allowance), and
     * never the weapon or shield it took off for its staff of fire (in its pack until the stint ends: it goes back on)
     */
    private _nextItem(player: Player): [number, number] | null {
        const inv = player.getInventory(InvType.INV);
        const items = inventoryItems(inv);
        for (let slot = 0; inv && slot < inv.capacity; slot++) {
            const it = inv.get(slot);
            if (!it || !isAlchable(it.id) || (this.allowance.get(it.id) ?? 0) <= 0) continue;
            if ((items.get(it.id) ?? 0) <= this.restore.filter(id => id === it.id).length) continue;
            return [it.id, slot];
        }
        return null;
    }

    /**
     * At the booth: its pack banked (all but the staff and weapons it works with), natures and fire out (or its staff of
     * fire on), a load of what it may alch. False when there is nothing to alch or nothing to pay with.
     */
    private _load(player: Player): boolean {
        const bid = bankInvId();
        const bank = bid === -1 ? null : player.getInventory(bid);
        const inv = player.getInventory(InvType.INV);
        if (!bank || !inv) return false;
        // the pack to the bank, but its tools (its task needs them after: a woodcutter without its axe went to buy one) and
        // the weapon under its staff (to go back on)
        for (let slot = 0; slot < inv.capacity; slot++) {
            const it = inv.get(slot);
            if (!it || this.restore.includes(it.id) || it.id === Items.NATURE_RUNE || it.id === Items.FIRE_RUNE || keptInPack().has(it.id)) continue;
            depositItems(inv, bank, it.id, it.count); // (the variety work, round 2, the fixes: room first)
        }
        const wantItems = alchableItems(player, this.restore);
        if (wantItems.length === 0) return false;
        this.allowance = new Map(wantItems);
        // its staff of fire on (once a stint: out of the bank, or from its pack), else fire runes
        const worn = player.getInventory(InvType.WORN);
        if (worn?.get(3)?.id !== Items.STAFF_OF_FIRE && this.restore.length === 0) {
            if (this._slotOf(player, Items.STAFF_OF_FIRE) === -1 && (inventoryItems(bank).get(Items.STAFF_OF_FIRE) ?? 0) > 0) moveItems(bank, inv, Items.STAFF_OF_FIRE, 1);
        }
        if (worn?.get(3)?.id !== Items.STAFF_OF_FIRE && this.restore.length === 0 && this._slotOf(player, Items.STAFF_OF_FIRE) !== -1) {
            const type = ObjType.get(Items.STAFF_OF_FIRE);
            for (const s of type.wearpos2 === 5 ? [3, 5] : [3]) {
                const id = worn?.get(s)?.id ?? -1;
                if (id !== -1) this.restore.push(id);
            }
            const slot = this._slotOf(player, Items.STAFF_OF_FIRE);
            if (slot !== -1) interactHeldOp(player, inv, Items.STAFF_OF_FIRE, slot, 2);
        }
        const natures = inventoryItems(bank).get(Items.NATURE_RUNE) ?? 0;
        if (natures > 0) moveItems(bank, inv, Items.NATURE_RUNE, natures);
        const staffOn = player.getInventory(InvType.WORN)?.get(3)?.id === Items.STAFF_OF_FIRE;
        let casts = inventoryItems(inv).get(Items.NATURE_RUNE) ?? 0;
        if (!staffOn) {
            const fire = inventoryItems(bank).get(Items.FIRE_RUNE) ?? 0;
            const take = Math.min(fire, casts * FIRE_PER_CAST - (inventoryItems(inv).get(Items.FIRE_RUNE) ?? 0));
            if (take > 0) moveItems(bank, inv, Items.FIRE_RUNE, take);
            casts = Math.min(casts, Math.floor((inventoryItems(inv).get(Items.FIRE_RUNE) ?? 0) / FIRE_PER_CAST));
        }
        if (casts <= 0) return false;
        // a load: as many as the pack has room and the natures pay for
        let room = Math.min(casts, inv.freeSlotCount);
        for (const [id, n] of wantItems) {
            if (room <= 0) break;
            const inPack = (inventoryItems(inv).get(id) ?? 0) - this.restore.filter(r => r === id).length;
            const fromBank = Math.min(n - inPack, room);
            if (fromBank > 0) room -= moveItems(bank, inv, id, fromBank);
        }
        return this._nextItem(player) !== null;
    }

    private _slotOf(player: Player, id: number): number {
        const inv = player.getInventory(InvType.INV);
        for (let slot = 0; inv && slot < inv.capacity; slot++) if (inv.get(slot)?.id === id) return slot;
        return -1;
    }

    /** an item it could not alch goes back to the bank (it stands by it) */
    private _bankItem(player: Player, id: number): void {
        const bid = bankInvId();
        const bank = bid === -1 ? null : player.getInventory(bid);
        const inv = player.getInventory(InvType.INV);
        if (!bank || !inv) return;
        const n = inventoryItems(inv).get(id) ?? 0;
        if (n > 0) depositItems(inv, bank, id, n); // (the variety work, round 2, the fixes: room first)
    }

    /** the stint's end at the booth: its weapon back on, the staff, the natures, the fire and the rest banked */
    private _finish(player: Player): void {
        this._restoreWeapon(player);
        const bid = bankInvId();
        const bank = bid === -1 ? null : player.getInventory(bid);
        const inv = player.getInventory(InvType.INV);
        if (bank && inv) {
            for (let slot = 0; slot < inv.capacity; slot++) {
                const it = inv.get(slot);
                if (!it || this.restore.includes(it.id)) continue;
                if (it.id !== Items.NATURE_RUNE && it.id !== Items.FIRE_RUNE && it.id !== Items.STAFF_OF_FIRE && it.id !== Items.COINS && !isAlchable(it.id)) continue;
                depositItems(inv, bank, it.id, it.count); // (the variety work, round 2, the fixes: room first)
            }
        }
        this._end(player);
    }

    /**
     * the weapon (and shield) it wore before its staff of fire, on again; in a script's delay (alchemy's: a trade or a fight
     * ended the stint mid-cast) once the bot is free (port/BotTeleport.wieldLater: the click did nothing then, and the
     * weapon stayed in the pack for the next gatherer to bank)
     */
    private _restoreWeapon(player: Player): void {
        const inv = player.getInventory(InvType.INV);
        if (!inv || this.restore.length === 0) return;
        const later: number[] = [];
        for (const id of this.restore) {
            const slot = this._slotOf(player, id);
            if (slot !== -1 && !interactHeldOp(player, inv, id, slot, 2)) later.push(id);
        }
        wieldLater(player, later);
        this.restore = [];
    }

    private _end(player: Player | null): void {
        this.state = 'done';
        if (player) {
            this._restoreWeapon(player);
            releaseStandTile(player);
        }
    }

    override interrupt(): void {
        super.interrupt();
        this._end(this.lastPlayer);
    }

    override reset(): void {
        super.reset();
        if (this.began) this._end(this.lastPlayer);
    }
}
