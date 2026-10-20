/**
 * BotNeeds.ts
 *
 * Answers "what does this bot need before it can do X?" and
 * "can it afford what it needs?"
 *
 * Import chain: Player → BotAction → BotWorld (no cycle with World.ts)
 *
 * Key fixes vs original:
 *   - STARTING_COINS raised to 1000 (fighters need sword + scimitar upgrade)
 *     (port: 200 here, see STARTING_COINS)
 *   - getMissingPurchases now checks affordability per item
 *   - canAffordStep accounts for quantity × cost on bulk consumables
 *   - Added totalCostOfPurchases helper used by BotGoalPlanner
 */

import Player from '#/engine/entity/Player.js';
import InvType from '#/cache/config/InvType.js';
import { countItem, _wornContains, getBaseLevel, PlayerStat } from '#/engine/bot/BotAction.js';
import { Items, Shops, SkillStep, AxesByLevel, PickaxesByLevel } from '#/engine/bot/BotKnowledge.js';
import { usableOnThisWorld } from '#/engine/bot/port/BotPkGear.js';
import World from '#/engine/World.js';

// ── Starting coins ────────────────────────────────────────────────────────────

/**
 * Coins granted to a brand-new bot on their first tick.
 * Must cover the most expensive first-purchase across all personalities:
 *   Skiller:  bronze axe (16) + net (5)                           =   21gp
 *   Fighter:  bronze sword (32) + iron scimitar later (200)       =  232gp
 *   Ranged:   oak shortbow (200) + 100 bronze arrows (100 × 7gp)  =  900gp
 *   Magic:    staff of air (unknown) + 100 mind runes (100 × 4gp) =  400gp+
 * 1000gp covers all starting gear with a comfortable buffer.
 */
export const STARTING_COINS = 200;

// ── Inventory checks ──────────────────────────────────────────────────────────

function bankCountOf(player: Player, itemId: number): number {
    let bid = -1;
    try {
        bid = InvType.getId('bank');
    } catch {
        return 0;
    }
    const bank = bid === -1 ? null : player.getInventory(bid);
    if (!bank) return 0;
    let n = 0;
    for (let slot = 0; slot < bank.capacity; slot++) {
        const item = bank.get(slot);
        if (item?.id === itemId) n += item.count;
    }
    return n;
}

/**
 * port: does the bot have this tool: carried, worn or in its bank (its tasks fetch a banked one)? Upstream looked in
 * the pack only, so bots walked to Bob's, the general store and Port Sarim again for tinderboxes, shears and nets
 * another task had banked (40 of 40 shop trips in one sim).
 */
export function hasTool(player: Player, toolItemId: number): boolean {
    return countItem(player, toolItemId) > 0 || _wornContains(player, toolItemId) || bankCountOf(player, toolItemId) > 0;
}

/** port: a tool the bot may use here: no members item on a free world, a pickaxe its Mining level allows (274 sets no
 * Woodcutting level for axes: woodcut.rs2) */
function usableTool(player: Player, toolItemId: number): boolean {
    if (!usableOnThisWorld(toolItemId)) return false;
    const pickaxe = PickaxesByLevel.find(t => t.itemId === toolItemId);
    return !pickaxe || getBaseLevel(player, PlayerStat.MINING) >= pickaxe.levelReq;
}

const AXE_IDS = new Set(AxesByLevel.map(t => t.itemId));
const PICKAXE_IDS = new Set(PickaxesByLevel.map(t => t.itemId));

/**
 * port: what a step needs, as groups of which one tool each will do: the axes of a woodcutting step and the pickaxes
 * of a mining step are one group (any one of them), every other tool a group of its own (a fly rod and feathers).
 * Upstream required every tier of axe or pickaxe: with 56 to 255 coins (a new bot has 200) a bot could never afford
 * woodcutting or fletching, and with more it bought a steel axe, then an iron one.
 */
export function toolGroups(step: SkillStep): number[][] {
    const ids = step.toolItemIds;
    if (ids.length > 1 && (ids.every(id => AXE_IDS.has(id)) || ids.every(id => PICKAXE_IDS.has(id)))) return [ids];
    return ids.map(id => [id]);
}

/** Does the bot have every tool required for this skill step? (port: one of each group, usable here) */
export function hasAllTools(player: Player, step: SkillStep): boolean {
    return toolGroups(step).every(group => group.some(id => usableTool(player, id) && hasTool(player, id)));
}

/** port: the bot's coins, carried and banked (a shop trip fetches banked ones first) */
export function coinsOwned(player: Player): number {
    return countItem(player, Items.COINS) + bankCountOf(player, Items.COINS);
}

/** Does the bot have enough coins for the given amount? (port: carried and banked) */
export function hasCoins(player: Player, amount: number): boolean {
    return coinsOwned(player) >= amount;
}

/** Does the bot have the raw material this step consumes (bait, feathers, logs, etc.)? */
export function hasRawMaterial(player: Player, step: SkillStep): boolean {
    if (!step.itemConsumed || step.itemConsumed === -1) return true;
    return countItem(player, step.itemConsumed) > 0;
}

// ── Purchase planning ─────────────────────────────────────────────────────────

// ── Shop trips that failed (port) ─────────────────────────────────────────────

/** port: an item whose shop trip bought nothing is not sought again for this long (play ticks: an hour) */
const TRIP_RETRY_TICKS = 6000;
const failedTrips = new WeakMap<Player, Map<number, number>>();

/**
 * port: ShopTripTask bought none of this (the shop has none now, or the bot could not pay the shop's own price):
 * neither a tool nor gear trip goes for it again soon (upstream's trips made the item whatever the shop had)
 */
export function noteTripFailed(player: Player, itemId: number): void {
    let tried = failedTrips.get(player);
    if (!tried) failedTrips.set(player, (tried = new Map()));
    tried.set(itemId, World.currentTick + TRIP_RETRY_TICKS);
}

export function tripFailedRecently(player: Player, itemId: number): boolean {
    return (failedTrips.get(player)?.get(itemId) ?? -Infinity) > World.currentTick;
}

export interface Purchase {
    shopKey:  string;
    itemId:   number;
    quantity: number;  // how many to buy
    cost:     number;  // cost per item (base shop price, sell_multiplier=1000)
    total:    number;  // quantity × cost — pre-computed for convenience
}

/**
 * Returns the list of items this bot still needs to buy before
 * it can perform the given skill step, filtered to only items
 * the bot can currently afford.
 *
 * Items the bot can't afford are omitted — the planner should
 * notice the bot keeps failing shouldRun() and eventually try
 * a different skill that earns coins (combat drops, etc.)
 *
 * Empty list means: bot has all tools and can start the skill now.
 */
function isBulk(toolId: number): boolean {
    return toolId === Items.FISHING_BAIT || toolId === Items.FEATHER || toolId === Items.BRONZE_ARROW;
}

/** port: a bulk item's amount a bot needs to start with (it buys up to 200 when it can pay for them) */
const BULK_TO_START = 50;

/** The first shop (and its price) that sells this item, or null. */
function shopFor(itemId: number): { shopKey: string; cost: number } | null {
    for (const shopKey in Shops) {
        const item = Shops[shopKey].stock.find(s => s.itemId === itemId);
        if (item) return { shopKey, cost: item.cost };
    }
    return null;
}

/** port: a group the bot has a usable tool of */
function groupMet(player: Player, group: number[]): boolean {
    return group.some(id => usableTool(player, id) && hasTool(player, id));
}

export function getMissingPurchases(player: Player, step: SkillStep): Purchase[] {
    const missing: Purchase[] = [];
    let coinsRemaining = coinsOwned(player);

    // port: per group (toolGroups): nothing when the bot has a tool of it; else the best tool of it (the groups list
    // best first) that a shop sells, the bot can use and afford
    for (const group of toolGroups(step)) {
        if (groupMet(player, group)) continue;
        for (const toolId of group) {
            if (!usableTool(player, toolId) || tripFailedRecently(player, toolId)) continue;
            const shop = shopFor(toolId);
            if (!shop || coinsRemaining < shop.cost) continue;
            // Bulk consumables: buy 200 at a time (feathers, bait, arrows); as many as affordable
            const affordable = Math.min(isBulk(toolId) ? 200 : 1, Math.floor(coinsRemaining / shop.cost));
            coinsRemaining -= affordable * shop.cost;
            missing.push({ shopKey: shop.shopKey, itemId: toolId, quantity: affordable, cost: shop.cost, total: affordable * shop.cost });
            break;
        }
    }

    return missing;
}

/**
 * Total coins needed to buy all missing tools for this step.
 * Used by BotGoalPlanner to decide if the bot should try a
 * cheaper skill first and earn more coins via combat.
 * (port: per group, its cheapest usable tool a shop sells; a group no shop sells adds nothing, as upstream)
 */
export function totalCostOfMissing(player: Player, step: SkillStep): number {
    let total = 0;
    for (const group of toolGroups(step)) {
        if (groupMet(player, group)) continue;
        let cheapest = Infinity;
        for (const toolId of group) {
            if (!usableTool(player, toolId)) continue;
            const shop = shopFor(toolId);
            // port: enough of a bulk item to start (upstream wanted 200: 300 coins could not pay for a fly rod and 200
            // feathers, and a fisher of 45 with them never fished)
            if (shop) cheapest = Math.min(cheapest, shop.cost * (isBulk(toolId) ? BULK_TO_START : 1));
        }
        if (cheapest !== Infinity) total += cheapest;
    }
    return total;
}

/**
 * True if the bot can afford everything it needs for this step right now. (port: with its banked coins too)
 */
export function canAffordStep(player: Player, step: SkillStep): boolean {
    return totalCostOfMissing(player, step) <= coinsOwned(player);
}
