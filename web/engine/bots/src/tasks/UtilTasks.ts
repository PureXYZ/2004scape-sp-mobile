/**
 * UtilTasks.ts — InitTask, WalkTask, BankTask, BuryBonesTask, IdleTask, SellTask
 */

import {
    BotTask, Player, InvType,
    walkTo, interactNpcOp, findNpcByPrefix, findNpcByName, isNear,
    hasItem, addItem, removeItem,
    Items, Locations, STARTING_COINS,
    teleportToSafety, teleportNear, randInt, bankInvId, StuckDetector,
    openNearbyGate, advanceBankWalk,
    PlayerStat, FOOD_IDS, addXp,
    countItem,
    carriedFood, withdrawFood, canUseTool, humanDelay,
} from '#/engine/bot/tasks/BotTaskBase.js';
import { GRIMY_HERB_MAP, AxesByLevel, PickaxesByLevel } from '#/engine/bot/BotKnowledge.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { moveItems, bankedId } from '#/engine/bot/port/BotInventoryCompat.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { TUTORIAL_COINS, TUTORIAL_KIT } from '#/engine/bot/port/BotNewbie.js';
import World from '#/engine/World.js';

/** port: has the bot this item anywhere: worn, in the pack or in the bank? */
export function owns(player: Player, itemId: number): boolean {
    for (const invId of [InvType.WORN, InvType.INV, bankInvId()]) {
        const inv = invId === -1 ? null : player.getInventory(invId);
        if (!inv) continue;
        for (let slot = 0; slot < inv.capacity; slot++) {
            if (inv.get(slot)?.id === itemId) return true;
        }
    }
    return false;
}

/**
 * port: Lost City's dramen staff, as the quest varp every bot gets says it has done the quest (BotManager.BOT_VARPS:
 * zanaris). 274's Zanaris door takes only a player who wears one (quest_zanaris.rs2), on a members world: a runecrafter
 * that can bind cosmic runes and has none anywhere (a save from before the staff, one that lost it) finds one in its
 * bank, as a player who has done the quest cuts another from the dramen tree (RunecraftingTask, which wears it to
 * Zanaris). Not at login: a bot comes back exactly as it left.
 */
export function keepQuestItems(player: Player): void {
    if (owns(player, Items.DRAMEN_STAFF)) return;
    const bid = bankInvId();
    if (bid !== -1) player.getInventory(bid)?.add(Items.DRAMEN_STAFF, 1);
}

// ── InitTask ──────────────────────────────────────────────────────────────────

export class InitTask extends BotTask {
    private done = false;
    private readonly starterItems: number[];
    private readonly kit: 'starter' | 'tutorial';

    /** port: `kit` 'tutorial': a newbie newcomer's, Tutorial Island's kit and 25 coins in the bank (port/BotNewbie) */
    constructor(starterItems: number[] = [], kit: 'starter' | 'tutorial' = 'starter') {
        super('Init');
        this.starterItems = starterItems;
        this.kit = kit;
    }

    shouldRun(_p: Player): boolean { return !this.done; }

    tick(player: Player): void {
        if (this.kit === 'tutorial') {
            for (const [id, count] of TUTORIAL_KIT) addItem(player, id, count);
            const bid = bankInvId();
            if (bid !== -1) player.getInventory(bid)?.add(Items.COINS, TUTORIAL_COINS);
            this.done = true;
            return;
        }
        addItem(player, Items.COINS, STARTING_COINS);
        for (const id of this.starterItems) {
            // port: not when the bot has it already (worn or banked too), or an axe or pickaxe its level allows (an
            // aged bot, port/BotAge, brings the tools of its levels)
            if (owns(player, id)) continue;
            const kind = AxesByLevel.some(t => t.itemId === id) ? AxesByLevel : PickaxesByLevel.some(t => t.itemId === id) ? PickaxesByLevel : null;
            if (kind && kind.some(t => hasItem(player, t.itemId) && canUseTool(player, t.itemId))) continue;
            addItem(player, id, 1);
        }

        // port: no bank seed (earned gear, port/BotGear). Upstream put every scimitar and armour set
        // from iron to rune in a new bot's bank, and 999,999,999 swordfish (sharks too on a members world): the bot
        // buys its gear as its levels and coins allow, and eats what it catches and cooks. A few cooked shrimps, as
        // Tutorial Island leaves a player with
        if (!owns(player, Items.SHRIMP)) addItem(player, Items.SHRIMP, 5);

        this.done = true;
    }

    isComplete(_p: Player): boolean { return this.done; }
    override reset(): void { super.reset(); this.done = false; }
}

// ── WalkTask ──────────────────────────────────────────────────────────────────

export class WalkTask extends BotTask {
    private readonly destX: number;
    private readonly destZ: number;
    private readonly level: number;
    private readonly arrivalDist: number;
    private readonly stuck = new StuckDetector(30, 4, 2);

    constructor(x: number, z: number, level = 0, arrivalDist = 3) {
        super('Walk');
        this.destX = x;
        this.destZ = z;
        this.level = level;
        this.arrivalDist = arrivalDist;
    }

    shouldRun(player: Player): boolean {
        return !isNear(player, this.destX, this.destZ, this.arrivalDist, this.level);
    }

    tick(player: Player): void {
        if (this.interrupted) return;

        if (this.stuck.check(player, this.destX, this.destZ)) {
            if (this.stuck.desperatelyStuck) {
                teleportNear(player, this.destX, this.destZ);
                this.stuck.reset();
                return;
            }
            if (openNearbyGate(player, 5)) return;
            const dx = this.destX - player.x, dz = this.destZ - player.z;
            // Clear existing (bad) waypoints so the hasWaypoints guard in
            // walkTo() doesn't block the detour recalculation.
            player.clearWaypoints();
            walkTo(
                player,
                player.x + (Math.abs(dz) > Math.abs(dx) ? randInt(-10, 10) : (dz > 0 ? 10 : -10)),
                player.z + (Math.abs(dx) > Math.abs(dz) ? randInt(-10, 10) : (dx > 0 ? 10 : -10)),
            );
            return;
        }

        walkTo(player, this.destX, this.destZ);
    }

    isComplete(player: Player): boolean {
        return isNear(player, this.destX, this.destZ, this.arrivalDist, this.level);
    }

    override reset(): void { super.reset(); this.stuck.reset(); }
}

// ── BankTask ──────────────────────────────────────────────────────────────────

export class BankTask extends BotTask {
    private state: 'walk' | 'deposit' | 'done' = 'walk';
    private readonly stuck = new StuckDetector(30, 4, 2);
    private readonly keepItems: number[];

    constructor(keepItems: number[] = []) {
        super('Bank');
        this.keepItems = keepItems;
    }

    shouldRun(_p: Player): boolean { return this.state !== 'done'; }

    tick(player: Player): void {
        if (this.interrupted) return;
        if (this.cooldown > 0) { this.cooldown--; return; }

        if (this.state === 'walk') {
            const result = advanceBankWalk(player, this.stuck);
            if (result === 'walk') return;
            // 'ready' = interaction queued (booth op2 or banker op3); wait 3 ticks
            // 'direct' = no entity found — deposit directly (inventory APIs work without open UI)
            // port (the realism work): a person's stop at the booth, never the same twice (BotTiming 'bank')
            this.cooldown = result === 'ready' ? humanDelay(player, 'bank') : 0;
            this.state = 'deposit';
            return;
        }

        if (this.state === 'deposit') {
            this._deposit(player);
            this.state = 'done';
            this.cooldown = 2;
        }
    }

    isComplete(_p: Player): boolean { return this.state === 'done'; }

    override reset(): void {
        super.reset();
        this.state = 'walk';
        this.stuck.reset();
    }

    private _deposit(player: Player): void {
        const inv = player.getInventory(InvType.INV);
        const bid = bankInvId();
        if (!inv || bid === -1) return;
        const bank = player.getInventory(bid);
        if (!bank) return;
        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item) continue;
            if (this.keepItems.includes(item.id)) continue;
            const moved = inv.remove(item.id, item.count);
            if (moved > 0) bank.add(bankedId(item.id), moved);
        }
        this._withdrawFood(player);
    }

    /** port: up to 8 of the best food the bot can eat on this world when it carries fewer than 5 (BotTaskBase) */
    private _withdrawFood(player: Player): void {
        if (carriedFood(player) >= 5) return;
        withdrawFood(player, 8);
    }
}

// ── LeaveBankTask (port) ──────────────────────────────────────────────────────

/**
 * port (the realism work, phase 2: leaving like a player): a gatherer whose session is over banks its load before it
 * logs out (port/BotHabits.readyToLeave sets this as its subtask). To the nearest bank, the booth, everything but `keep`
 * into the bank (no food taken out: BankTask's run is for a trip out), then it stands there: never complete, so the task
 * it left does not walk it off again before it is gone.
 */
export class LeaveBankTask extends BotTask {
    private state: 'walk' | 'deposit' | 'done' = 'walk';
    private readonly stuck = new StuckDetector(30, 4, 2);
    private readonly keep: readonly number[];
    /** the world tick BotPlayer last ran it (it stops when the bot is fighting, or the subtask was dropped) */
    lastTick: number;

    constructor(keep: readonly number[]) {
        super('Bank');
        this.keep = keep;
        this.lastTick = World.currentTick;
    }

    /** the load is in the bank */
    get banked(): boolean {
        return this.state === 'done';
    }

    shouldRun(_p: Player): boolean { return true; }
    isComplete(_p: Player): boolean { return false; }

    tick(player: Player): void {
        this.lastTick = World.currentTick;
        if (this.cooldown > 0) { this.cooldown--; return; }
        if (this.state === 'walk') {
            const result = advanceBankWalk(player, this.stuck);
            if (result === 'walk') return;
            this.cooldown = result === 'ready' ? 2 : 0;
            this.state = 'deposit';
            return;
        }
        if (this.state === 'deposit') {
            const inv = player.getInventory(InvType.INV);
            const bid = bankInvId();
            const bank = bid === -1 ? null : player.getInventory(bid);
            if (inv && bank) {
                for (let slot = 0; slot < inv.capacity; slot++) {
                    const item = inv.get(slot);
                    if (!item || this.keep.includes(item.id)) continue;
                    const moved = inv.remove(item.id, item.count);
                    if (moved > 0) bank.add(bankedId(item.id), moved);
                }
            }
            this.state = 'done';
        }
    }

    override reset(): void {
        super.reset();
        this.state = 'walk';
        this.stuck.reset();
        this.lastTick = World.currentTick;
    }
}

// ── BuryBonesTask ─────────────────────────────────────────────────────────────

export class BuryBonesTask extends BotTask {
    private buryCount = 0;

    private state: 'bury' | 'done' = 'bury';

    constructor() {
        super('Prayer');
    }

    shouldRun(player: Player): boolean {
        return hasItem(player, Items.BONES) ||
               hasItem(player, Items.BIG_BONES);
    }

    tick(player: Player): void {
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }

        // ───────────────── BURY ─────────────────
        if (this.state === 'bury') {

            // ── BIG BONES FIRST ─────────────────
            if (hasItem(player, Items.BIG_BONES)) {
                const removed = removeItem(player, Items.BIG_BONES, 1);

                if (!removed) {
                    console.log(`[Prayer] ❌ failed to remove BIG_BONES`);
                    return;
                }

                // port: through addXp (upstream wrote stats directly, so the Prayer level never went up)
                addXp(player, PlayerStat.PRAYER, 150);
                this.buryCount++;

                console.log(
                    `[Prayer] 🦴 buried BIG BONES +150 XP (total=${player.stats[PlayerStat.PRAYER]})`
                );

                this.cooldown = randInt(2, 4);
                return;
            }

            // ── NORMAL BONES ─────────────────
            if (hasItem(player, Items.BONES)) {
                const removed = removeItem(player, Items.BONES, 1);

                if (!removed) {
                    console.log(`[Prayer] ❌ failed to remove BONES`);
                    return;
                }

                addXp(player, PlayerStat.PRAYER, 45);
                this.buryCount++;

                console.log(
                    `[Prayer] 🦴 buried bones +45 XP (total=${player.stats[PlayerStat.PRAYER]})`
                );

                this.cooldown = randInt(2, 4);
                return;
            }

            // ── DONE ─────────────────
            console.log(`[Prayer] ✅ finished burying (${this.buryCount} bones)`);
            this.state = 'done';
            return;
        }
    }

    isComplete(_player: Player): boolean {
        return this.state === 'done';
    }

    override reset(): void {
        super.reset();
        this.buryCount = 0;
        this.state = 'bury';
    }
}

// ── IdleTask ──────────────────────────────────────────────────────────────────

export class IdleTask extends BotTask {
    private readonly ticks: number;
    private elapsed = 0;

    constructor(ticks = 10) {
        super('Idle');
        this.ticks = ticks;
    }

    shouldRun(_p: Player): boolean { return this.elapsed < this.ticks; }
    tick(_p: Player): void { this.elapsed++; }
    isComplete(_p: Player): boolean { return this.elapsed >= this.ticks; }
    override reset(): void { super.reset(); this.elapsed = 0; }
}

// ── SellTask — sell resources at Lumbridge General Store ──────────────────────

// Items never sold at shops — always banked.
const BANK_ONLY_IDS: ReadonlySet<number> = new Set([
    ...Object.keys(GRIMY_HERB_MAP).map(Number),          // grimy herbs
    ...Object.values(GRIMY_HERB_MAP).map(([id]) => id),  // clean herbs
    Items.AIR_TALISMAN,                                   // talismans
]);

const SELL_PRICES: Record<number, number> = {
    [Items.LOGS]:        3,
    [Items.OAK_LOGS]:    6,
    [Items.WILLOW_LOGS]: 14,
    [Items.COPPER_ORE]:  4,
    [Items.TIN_ORE]:     4,
    [Items.IRON_ORE]:    9,
    [Items.COAL]:        22,
    [Items.RAW_SHRIMP]:  3,
    [Items.RAW_SARDINE]: 4,
    [Items.RAW_TROUT]:   9,
    [Items.RAW_SALMON]:  14,
    [Items.BONES]:       2,
    [Items.BIG_BONES]:   5,
};

export class SellTask extends BotTask {
    private state: 'walk' | 'find' | 'sell' | 'done' = 'walk';
    private findFailTicks = 0;
    private readonly keepItems: number[];
    private readonly stuck = new StuckDetector(30, 4, 2);

    constructor(keepItems: number[] = []) {
        super('Sell');
        this.keepItems = keepItems;
    }

    shouldRun(_p: Player): boolean { return this.state !== 'done'; }

    tick(player: Player): void {
        if (this.interrupted) return;
        if (this.cooldown > 0) { this.cooldown--; return; }

        const [sx, sz, sl] = Locations.LUMBRIDGE_GENERAL;

        if (this.state === 'walk') {
            if (!isNear(player, sx, sz, 8, sl)) {
                if (this.stuck.check(player, sx, sz)) {
                    if (this.stuck.desperatelyStuck) {
                        teleportNear(player, sx, sz);
                        this.stuck.reset();
                        return;
                    }
                    if (openNearbyGate(player, 5)) return;
                    const dx = sx - player.x, dz = sz - player.z;
                    walkTo(
                        player,
                        player.x + (Math.abs(dz) > Math.abs(dx) ? randInt(-10, 10) : (dz > 0 ? 10 : -10)),
                        player.z + (Math.abs(dx) > Math.abs(dz) ? randInt(-10, 10) : (dx > 0 ? 10 : -10)),
                    );
                    return;
                }
                walkTo(player, sx, sz);
                return;
            }
            this.state = 'find';
            return;
        }

        if (this.state === 'find') {
            const npc = findNpcByName(player.x, player.z, player.level, 'generalshopkeeper1', 10);
            if (!npc) {
                this.findFailTicks++;
                if (this.findFailTicks > 6) {
                    this.state = 'walk';
                    this.findFailTicks = 0;
                }
                walkTo(player, sx + randInt(-4, 4), sz + randInt(-4, 4));
                return;
            }
            this.findFailTicks = 0;
            interactNpcOp(player, npc, 3);
            this.cooldown = 3;
            this.state = 'sell';
            return;
        }

        if (this.state === 'sell') {
            this._sell(player);
            this.state = 'done';
            this.cooldown = 2;
        }
    }

    isComplete(_p: Player): boolean { return this.state === 'done'; }

    override reset(): void {
        super.reset();
        this.state = 'walk';
        this.findFailTicks = 0;
        this.stuck.reset();
    }

    private _sell(player: Player): void {
        const inv = player.getInventory(InvType.INV);
        if (!inv) return;
        let coins = 0;
        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item) continue;
            if (this.keepItems.includes(item.id)) continue;
            if (item.id === Items.COINS) continue;
            if (BANK_ONLY_IDS.has(item.id)) continue;
            coins += item.count * (SELL_PRICES[item.id] ?? 1);
            inv.remove(item.id, item.count);
        }
        if (coins > 0) addItem(player, Items.COINS, coins);
    }
}
