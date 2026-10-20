/**
 * RangedMagicTask.ts
 *
 * Combined Ranged + Magic combat task.
 *
 * Initiation conditions (checked by shouldRun / BotGoalPlanner):
 *   • Has a bow (any tier in RangedBowsByLevel) + any arrows  →  ranged mode
 *   • Has staff_of_air + any wind-line catalyst rune          →  magic mode
 *   • Neither: task only starts once the bot has ≥ 3 000 coins to buy equipment.
 *
 * Gear/spell tier is fully dynamic, recomputed from the bot's live level AND
 * coin budget (inventory + bank) every time it banks — see _refreshGearAndSpell():
 *   Magic:  wind_strike(mind, lvl1) → wind_bolt(chaos, lvl17) →
 *           wind_blast(death, lvl41) → wind_wave(blood, lvl62, members-only,
 *           never shop-bought — only usable if the bot already owns blood runes).
 *           A staff_of_air supplies air runes for free, so only the catalyst
 *           rune needs buying. If the bot can't afford death runes it drops
 *           back to chaos, then mind — see BotKnowledge.pickBestWindSpell().
 *   Ranged: prefers the best bow the bot already owns (fletched — see
 *           FletchingTask/BowStringingTask for willow/maple/yew/magic tiers,
 *           none of which are shop-purchasable), else buys the best it can
 *           (shortbow/oak_shortbow, the only tiers Lowe's Archery stocks).
 *           Arrow tier (bronze/iron/steel) is chosen purely by coin budget —
 *           see BotKnowledge.bestRangedBow()/bestAffordableArrow().
 *
 * Shopping (dynamic, built fresh each time from the picked tiers):
 *   Varrock Archery  — bow (100-200gp) + arrows (10-20gp each × 500)
 *   Zaff's Staffs    — staff_of_air (1 000gp)
 *   Aubury's Runes   — mind/chaos/death runes (10/100/150gp each × 250)
 *
 * NPC progression location comes from BotKnowledge's RANGED/MAGIC
 * SkillProgression tables, same as before — this task only controls WHICH
 * spell/gear tier is used at whatever location the planner already picked.
 *
 * Dungeon navigation for chaos druids mirrors CombatTask:
 *   Walk to TAVERLY_DUNGEON_ENTRANCE → teleJump to TAVERLY_DUNGEON_FLOOR
 *   Exit: teleJump back to TAVERLY_DUNGEON_ENTRANCE before banking.
 */

import {
    BotTask,
    Player,
    Npc,
    InvType,
    Inventory,
    walkTo,
    interactNpcOp,
    findNpcByName,
    hasItem,
    countItem,
    addItem,
    removeItem,
    isInventoryFull,
    isNear,
    getBaseLevel,
    PlayerStat,
    Items,
    Shops,
    Locations,
    getProgressionStep,
    teleportNear,
    randInt,
    bankInvId,
    INTERACT_TIMEOUT,
    StuckDetector,
    ProgressWatchdog,
    setCombatStyle,
    setAutocastSpell,
    openNearbyGate,
    botJitter,
    advanceBankWalk,
    cleanGrimyHerbs,
    botTeleport,
    currentHp,
    maxHp,
    hpBelow,
    carriedFood,
    bankedFood,
    eatBestFood,
    withdrawFood,
    bankFoodAbove,
    webBladeFor,
    takeWebBlade,
    npcReachable,
    UNREACHABLE_NPC_TICKS,
    edibleFoodIds,
    WIND_SPELLS,
    pickBestWindSpell,
    RangedBowsByLevel,
    bestRangedBow,
    RangedArrowsByCost,
    bestAffordableArrow,
    dungeonRoute,
    CLAIMED_NPCS,
    TargetPause,
    humanDelay,
    openShopStock,
    buyFromOpenShop,
    packTeleportRunes,
} from '#/engine/bot/tasks/BotTaskBase.js';
import { canTravel, CollisionType } from '#/engine/routefinder/index.js';
import { elementalsWanted } from '#/engine/bot/port/BotTeleport.js';
import type { SkillStep, WindSpellTier } from '#/engine/bot/tasks/BotTaskBase.js';
import { findNpcFiltered, npcMatchesName, interactHeldOp, _wornContains, _equipLoot, climbDownNear, tryOpenGateNear } from '#/engine/bot/BotAction.js';
import { bankStop } from '#/engine/bot/port/BotHabits.js';
import NpcType from '#/cache/config/NpcType.js';
import ObjType from '#/cache/config/ObjType.js';
import Environment from '#/util/Environment.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { moveItems, bankedId } from '#/engine/bot/port/BotInventoryCompat.js';
import { dressForMode, needsModeDress } from '#/engine/bot/port/BotGear.js';
import { usableOnThisWorld } from '#/engine/bot/port/BotPkGear.js';
import { levelUpStep, getProgressionStepWhere, SkillProgression } from '#/engine/bot/BotKnowledge.js';
import { runFromAttackers } from '#/engine/bot/port/BotDefence.js';
// (the variety work, round 1, Track D: the dungeons' clicks on the way in)
import { enterDungeon } from '#/engine/bot/port/BotDungeons.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** port (phase 5a): Varrock's shops (Aubury's, Zaff's, Lowe's), where a teleport to the spot after the shopping starts */
const VARROCK_SHOPS: [number, number] = [3225, 3420];

/**
 * port (phase 5a): what a shop asks for an item, at least: the table's figure or the item's value (274's shops sell at
 * its value times their multiplier, dearer as their stock runs down). The table under-asked for some (Zaff's staff of air
 * 1,000 against 1,500): with the shop's real window a bot that carried the table's coins was told "You don't have enough
 * coins." and came back for good.
 */
function priceOf(itemId: number, tableCost: number): number {
    return Math.max(tableCost, ObjType.get(itemId)?.cost ?? 0);
}

/**
 * port (the variety work, round 2, track W2: WEAR-7) the air staves a magic fight takes, worst to best (the staff of air,
 * an air battlestaff, a mystic air staff: 274's magic_staff.dbrow gives each the air runes), and the Magic and Attack each
 * needs to wield (tier30, tier40 scripts); looked up once
 */
let AIR_STAVES: number[] | null = null;
const AIR_STAFF_LEVEL: readonly number[] = [1, 30, 40];
function airStaves(): number[] {
    AIR_STAVES ??= [Items.STAFF_OF_AIR, ObjType.getId('air_battlestaff'), ObjType.getId('mystic_air_staff')];
    return AIR_STAVES;
}

/** port (phase 5a): shop visits in a row that bought nothing end the task (the planner picks another) */
const NO_BUY_VISITS = 3;

/** Minimum coins needed to go buy ranged/magic equipment from Varrock. */
export const MIN_COINS_TO_SHOP = 3000;

/** Arrows to buy per trip. */
const ARROW_BUY_QTY = 500;

/** Mind runes to buy per trip. */
const RUNE_BUY_QTY = 500;

/** Arrows to restock when supply drops below this level. */
const ARROW_LOW_THRESHOLD = 1;

/** Runes to restock when supply drops below this level. */
const RUNE_LOW_THRESHOLD = 1;

/** Food to carry into combat (upstream: 15 sharks). port: the best the bot can eat on this world (BotTaskBase). */
const COMBAT_FOOD = 15;
/** port: as CombatTask: eat below EAT_BELOW of the Hitpoints, on up to EAT_UNTIL; without food, no fighting below FIGHT_WITHOUT_FOOD_ABOVE */
const EAT_BELOW = 0.4;
const EAT_UNTIL = 0.8;
const FIGHT_WITHOUT_FOOD_ABOVE = 0.5;
/** port: and a fight without food starts only from this share (as CombatTask: well above where it leaves one) */
const FIGHT_START_WITHOUT_FOOD = 0.6;

// ── NPC claim registry (shared with CombatTask) ───────────────────────────────

// port: the NPC's nid, in the claim registry every fighting task shares (BotTaskBase.CLAIMED_NPCS); upstream's own set,
// keyed by the NPC's position, stopped matching once it moved
function _npcKey(npc: Npc): number {
    return npc.nid;
}

type RangedMagicExtra = {
    npcType?: string;
    npcTypes?: string[];
    spell?: string;
    dungeon?: boolean;
};

/** Which combat mode is active for this fight session. */
type Mode = 'ranged' | 'magic';

// ── Shop step descriptor ──────────────────────────────────────────────────────
interface ShopBuy {
    shopKey: keyof typeof Locations;
    npcName: string;
    itemId: number;
    qty: number;
    cost: number;
    op: 1 | 2 | 3 | 4 | 5; // NPC interact op (3 = Trade for most shops)
}

export class RangedMagicTask extends BotTask {
    private mode: Mode | null = null;
    private step: SkillStep;
    private primaryStat: PlayerStat; // RANGED or MAGIC

    private state: 'check_equip' | 'shop_walk' | 'shop_open' | 'shop_buy' | 'equip' | 'walk' | 'patrol' | 'scan' | 'interact' | 'flee' | 'eat' | 'bank_walk' | 'bank_deposit' = 'check_equip';

    private shopQueue: ShopBuy[] = [];
    /** port: bank trips in a row that did not put the picked gear in hand (three end the task) */
    private equipFails = 0;
    /**
     * port (the review of phase 4): a ranger's armour is looked for in the bank once a task (a skill's bank stop put it
     * there: port/BotGear dressForSkill), as CombatTask's first walk does; a mage keeps its skill look (a hat, no plate:
     * 274's metal armour spoils a spell's aim). port (the variety work, round 1, track W: WEAR-1): now the fight's outfit
     * is looked to once a task: a bot in a metal body at a ranged fight, or in metal at a magic one, goes to its bank first
     * (port/BotGear needsModeDress, dressForMode)
     */
    private armourChecked = false;
    private currentShop: ShopBuy | null = null;
    private shopNpc: Npc | null = null;
    /** port (phase 5a): ticks on the way to the shopkeeper or waiting for its window, approaches, the count at the last click */
    private shopWait = 0;
    private shopTries = 0;
    private buyLast = -1;
    /** its count of the item when the shop opened, and visits in a row that bought nothing (NO_BUY_VISITS) */
    private buyStart = 0;
    private noBuys = 0;

    // ── Dynamic gear/spell tier — recomputed by _refreshGearAndSpell() whenever
    // the bot banks, so it always reflects the current level + coin budget. ──
    private currentSpell: WindSpellTier = WIND_SPELLS[0];
    /** port (the variety work, round 2, track W2: AM7) the tiers it owns only: no shop trip could buy the one its coins picked */
    private ownedOnly = false;
    private currentBowId: number = Items.SHORTBOW;
    private currentArrowId: number = Items.BRONZE_ARROW;
    private currentArrowCost: number = RangedArrowsByCost[0].cost;

    private currentNpc: Npc | null = null;
    private claimedNpcKey = -1;

    private interactTicks = 0;
    private approachTicks = 0;
    private lastXp = 0;
    private scanFail = 0;
    /**
     * port (the realism work, phase 2): a person's pause before the next NPC after a target is lost (BotTaskBase), wide
     * ('next'): a ranged fight with a weak monster is a few shots of the same length, and with a narrow pause the kills
     * came in step (13.7 % identical intervals at 500 bots)
     */
    private readonly pause = new TargetPause('next', 1);
    private fleeTicks = 0;

    private patrolTarget: [number, number] | null = null;
    private patrolTicks = 0;

    private hasFoughtInArea = false;

    /** Cooldown ticks before the next gate-open attempt (avoids spamming). */
    private intentCooldown = 0;
    /** port: NPCs it could not hit (nid -> task tick until which they are skipped), re-clicks without XP, task ticks */
    private readonly unreachable = new Map<number, number>();
    private noXpClicks = 0;
    private gateTried = false;
    private taskTicks = 0;

    private readonly stuck = new StuckDetector(30, 4, 2);
    private readonly watchdog = new ProgressWatchdog(150);

    private lastLogKey = '';
    private lastLogTime = 0;

    /** port: the level the step was last checked against (levelUpStep runs when it rises) */
    private stepLevel = -1;
    /** port: ticks the eat state could not eat (a delay) */
    private eatTries = 0;
    /** port: spots where nothing came of the watchdog's ticks (as CombatTask's): this task does not pick them again */
    private readonly failedSteps = new Set<SkillStep>();
    /** (the fixes) a bank trip for a blade for the web made (once a task: a pack too full to take it picks another spot) */
    private bladeTrip = false;
    /** port: coins to take out of the bank for the shopping a bank trip is for (_goShopping), and such trips since the
     * last purchase */
    private shopCoins = 0;
    private shopCoinTrips = 0;

    constructor(step: SkillStep, stat: PlayerStat) {
        super('RangedMagic');
        this.step = step;
        this.primaryStat = stat;
        this.watchdog.follow(() => this.step.location);
    }

    // ── Logging ───────────────────────────────────────────────────────────────

    private _log(player: Player | null, msg: string, key?: string): void {
        const now = Date.now();
        const logKey = key ?? msg;
        if (this.lastLogKey === logKey && now - this.lastLogTime < 750) return;
        this.lastLogKey = logKey;
        this.lastLogTime = now;
        const prefix = player ? `[P:${player.x},${player.z}]` : '[BOT]';
        console.log(`${prefix} [RangedMagicTask] ${msg}`);
    }

    // ── shouldRun ─────────────────────────────────────────────────────────────

    override activityStep(): SkillStep | null {
        return this.step;
    }

    shouldRun(player: Player): boolean {
        // port: no fighting at low health without food (as CombatTask)
        if (hpBelow(player, this.taskTicks === 0 ? FIGHT_START_WITHOUT_FOOD : FIGHT_WITHOUT_FOOD_ABOVE) && carriedFood(player) === 0 && bankedFood(player) === 0) return false;
        // Can run if mode is already determined, or equipment exists, or has coins to shop
        if (this._pickMode(player, this.mode) !== null) return true;
        return this._totalCoins(player) >= MIN_COINS_TO_SHOP;
    }

    // ── Main tick ─────────────────────────────────────────────────────────────

    tick(player: Player): void {
        if (this.interrupted) return;
        this.taskTicks++;
        // port (the realism work): a target lost, by a kill or the game's own retaliation: the next click a moment later
        // (upstream clicked the next in the tick after: 47-66 % of its re-targets within a tick, the most of any task)
        this.pause.observe(player);

        // port: and its shopping (runes at Aubury's, arrows at Lowe's): from a spot by Ardougne the walk to Varrock
        // outlasted the watchdog, which jumped the bot back to its spot before it got there, every ~570 ticks (aged sim)
        const banking = this.state === 'bank_walk' || this.state === 'bank_deposit' || this.state === 'shop_walk' || this.state === 'shop_open' || this.state === 'shop_buy';
        // (where the bot stood before the check: the watchdog jumps it onto the spot)
        const [sx, sz, sl] = this.step.location;
        const atSpot = player.level === sl && Math.max(Math.abs(player.x - sx), Math.abs(player.z - sz)) <= 15;
        if (this.watchdog.check(player, banking)) {
            player.clearWaypoints();
            player.clearPendingAction();
            // port: nothing came of the spot itself (as CombatTask): check_equip takes another, near the bot; a spot
            // the bot was still walking to is kept
            if (atSpot) this.failedSteps.add(this.step);
            this._log(player, `watchdog reset (${atSpot ? 'at the spot: another one' : 'on the way'}) → check_equip`, 'watchdog');
            this.state = 'check_equip';
            this._releaseNpc();
        }

        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }

        if (this.intentCooldown > 0) this.intentCooldown--;

        // ── Dungeon exit gate ──────────────────────────────────────────────────
        // If bot is underground and needs to bank/shop, surface first.
        if ((this.state === 'bank_walk' || this.state === 'shop_walk') && player.z > 6000) {
            const [ex, ez, el] = dungeonRoute(player.x, player.z).entrance; // port: this dungeon's way out
            walkTo(player, ex, ez, el); // port: walkTo climbs out by the dungeon's ladder where it has one, else jumps
            return;
        }

        // ── HP CHECK & HEALING ───────────────────────────────────────────────────
        // Mirrors CombatTask — this task previously had no food/HP handling at
        // all, so bots would keep fighting (and dying) at any HP.
        // port: current Hitpoints (upstream compared the XP: never low); without food, off to the bank (as CombatTask)
        const hp = currentHp(player);
        const hpMax = maxHp(player);
        const hpSafeStates = ['bank_walk', 'bank_deposit', 'shop_walk', 'shop_open', 'shop_buy', 'check_equip', 'eat', 'flee'];
        if (hpBelow(player, EAT_BELOW) && !hpSafeStates.includes(this.state)) {
            if (this._hasFood(player)) {
                this._log(player, `HP low (${hp}/${hpMax}), eating...`, 'heal_trigger');
                this.state = 'eat';
                this.eatTries = 0;
                return;
            }
            this._log(player, `HP low (${hp}/${hpMax}) and NO FOOD, leaving for the bank`, 'flee_low_hp');
            this._releaseNpc();
            this.currentNpc = null;
            player.clearPendingAction();
            // port: running from its attacker first ('flee'), then the bank walk; upstream walked to the bank with the
            // NPC hitting it all the way (archers killed by monks and men in the coverage run)
            this.state = 'flee';
            this.fleeTicks = 0;
            return;
        }

        // ── CHECK / EQUIP ─────────────────────────────────────────────────────
        if (this.state === 'check_equip') {
            const mode = this._pickMode(player, this.mode);
            if (mode !== null) {
                this.mode = mode;
                // Pick the best sustainable spell/gear tier, then equip it, before walking to combat
                this._refreshGearAndSpell(player);
                this._equipWeapons(player);

                // _pickMode()/_refreshGearAndSpell() only check ownership across
                // inventory + bank — the gear may still be sitting in the bank,
                // in which case _equipWeapons() (inventory-only) silently does
                // nothing. Without this check the bot would walk off to combat
                // and swing bare-handed while carrying arrows it can't use.
                if (!this._isFullyEquipped(player)) {
                    // port: gear the tier picked but the bot never had (_refreshGearAndSpell picks arrows by the coins:
                    // an aged bot with 107 bronze arrows and coins for steel) is bought; upstream sent it to the bank
                    // for them, back to this check and to the bank again, for good (1,500 ticks at Edgeville bank)
                    if (!this._ownsPickedGear(player)) {
                        const picked = this.mode === 'ranged' ? [this.currentBowId, this.currentArrowId] : [Items.STAFF_OF_AIR, this.currentSpell.catalystRune];
                        this.shopQueue = this._buildShopQueue(player).filter(b => picked.includes(b.itemId));
                        if (this.shopQueue.length > 0) {
                            this._log(player, 'picked gear not owned → buy it', 'need_buy');
                            this._goShopping(player);
                            return;
                        }
                        // port (the variety work, round 2, track W2: round 1's AM7 leftover, a bank loop "gear owned but not
                        // in hand"): the tier its coins picked is nowhere and no trip buys it (a mage out of mind runes with
                        // its coins short of Aubury's 300), so its bank holds none either: the best tier it does own, else the
                        // task ends (it went to the bank for it twice, and the guard ended the task at the second arrival)
                        this.ownedOnly = true;
                        if (!this._ownedTier(player)) {
                            this._log(player, 'picked gear neither owned nor bought → task done', 'no_gear');
                            this.interrupt();
                            return;
                        }
                    }
                    // and a bank trip that does not put it in hand three times over ends the task
                    if (++this.equipFails >= 3) {
                        this._log(player, 'cannot equip the picked gear → task done', 'equip_fail');
                        this.interrupt();
                        return;
                    }
                    this._log(player, 'gear owned but not in hand → bank_walk to withdraw', 'need_withdraw');
                    this.state = 'bank_walk';
                    return;
                }
                this.equipFails = 0;
                if (!this.armourChecked) {
                    this.armourChecked = true;
                    if (needsModeDress(player, this.mode)) {
                        this._log(player, "the fight's outfit in the bank → bank_walk", 'armour_banked');
                        this.state = 'bank_walk';
                        return;
                    }
                }

                this._refreshStep(player);
                // port (the variety work, round 1, the fixes): a spot beyond the sewers' web wants a blade to cut it (a bow
                // or a staff does not): a knife from the bank (bank_deposit takes it), else another spot
                const blade = webBladeFor(player, this.step);
                if (blade === 'banked' && !this.bladeTrip) {
                    this.bladeTrip = true;
                    this._log(player, 'a blade for the web in the bank → bank_walk', 'web_blade');
                    this.state = 'bank_walk';
                    return;
                }
                if (blade !== 'carried') {
                    this.failedSteps.add(this.step);
                    this._refreshStep(player);
                }
                this.state = 'walk';
                this._log(player, `mode=${mode}, step=${this.step.location}`, 'equip_ok');
                return;
            }

            // No equipment — build a shopping list and go buy
            const coins = this._totalCoins(player);
            if (coins < MIN_COINS_TO_SHOP) {
                this._log(player, `need ${MIN_COINS_TO_SHOP} coins, have ${coins} → idle`, 'no_coins');
                this.interrupted = true; // give up; planner will re-evaluate
                return;
            }

            this.shopQueue = this._buildShopQueue(player);
            if (this.shopQueue.length === 0) {
                // Somehow have enough but nothing to buy (edge case)
                this.state = 'check_equip';
                return;
            }
            this._goShopping(player);
            return;
        }

        // ── SHOP ──────────────────────────────────────────────────────────────
        if (this.state === 'shop_walk') {
            if (!this.currentShop) {
                this.state = 'check_equip';
                return;
            }
            const [sx, sz] = Locations[this.currentShop.shopKey as keyof typeof Locations] as [number, number, number];
            if (!isNear(player, sx, sz, 8)) {
                this._stuckWalk(player, sx, sz);
                return;
            }
            // Find the shopkeeper NPC
            const npc = findNpcByName(player.x, player.z, player.level, this.currentShop.npcName, 10);
            if (!npc) return;
            // port (the realism work, phase 5a): next to the shopkeeper first, by walkTo, which opens the doors on the
            // way (the engine routes a player to an NPC through no door: ShopTripTask's 'find'), then its Trade option
            const dx = Math.sign(npc.x - player.x);
            const dz = Math.sign(npc.z - player.z);
            const beside = Math.max(Math.abs(npc.x - player.x), Math.abs(npc.z - player.z)) <= 1 && ((dx === 0 && dz === 0) || canTravel(player.level, player.x, player.z, dx, dz, 1, 0, CollisionType.NORMAL));
            if (!beside && ++this.shopWait < 60) {
                if (!player.hasWaypoints()) this._stuckWalk(player, npc.x, npc.z);
                return;
            }
            interactNpcOp(player, npc, this.currentShop.op);
            this.shopNpc = npc;
            this.shopWait = 0;
            this.state = 'shop_open';
            return;
        }

        // port (the realism work, phase 5a: "the real game only"): the shop's own window, its own prices and stock, a click
        // of buy 1, 5 or 10 a tick (BotTaskBase.buyFromOpenShop, as ShopTripTask buys). Upstream took the coins its table
        // said and made the items without the shop
        if (this.state === 'shop_open') {
            if (openShopStock(player)) {
                this.state = 'shop_buy';
                this.buyLast = -1;
                this.buyStart = this.currentShop ? countItem(player, this.currentShop.itemId) : 0;
                return;
            }
            if (++this.shopWait >= 15) {
                // (not open: the walk to the shopkeeper again, three times at most, then the next shop: a visit that
                // bought nothing)
                this.shopWait = 0;
                if (++this.shopTries < 3) this.state = 'shop_walk';
                else if (!this._noBuy(player)) this._afterShop(player);
            }
            return;
        }

        if (this.state === 'shop_buy') {
            const buy = this.currentShop;
            if (!buy || !openShopStock(player)) {
                this._afterShop(player);
                return;
            }
            // `qty` more than it carried at the counter, while the coins last and each click buys something (upstream's
            // `qty` is what to buy: the arrows topped up to ARROW_BUY_QTY, not to `qty`)
            const have = countItem(player, buy.itemId);
            const want = this.buyStart + buy.qty;
            // (a full pack takes nothing new: to the bank first, as upstream's refund did, and the shopping again after)
            if (isInventoryFull(player) && !(have > 0 && ObjType.get(buy.itemId).stackable)) {
                if (openShopStock(player)) player.closeModal();
                this.currentShop = null;
                this.shopQueue = [];
                this.state = 'bank_walk';
                return;
            }
            const stuck = this.buyLast === have;
            if (have >= want || stuck || countItem(player, Items.COINS) < buy.cost) {
                if (have > this.buyStart) {
                    this.shopCoinTrips = 0;
                    this.noBuys = 0;
                } else if (have < want && this._noBuy(player)) return;
                this._log(player, `bought ${buy.itemId}: ${have} carried`, 'shop_bought');
                this._afterShop(player);
                return;
            }
            // (a click that buys nothing, or none to click: sold out, not stocked: the next tick finds it stuck and
            // counts the visit)
            this.buyLast = have;
            buyFromOpenShop(player, buy.itemId, want - have);
            return;
        }

        // ── EQUIP ─────────────────────────────────────────────────────────────
        if (this.state === 'equip') {
            this._refreshGearAndSpell(player);
            this._equipWeapons(player);
            this._refreshStep(player);
            this.state = 'walk';
            return;
        }

        // ── LEVEL PROGRESSION UPDATE ──────────────────────────────────────────
        // port: only when the level rose and the spot is outgrown or out of range (BotKnowledge.levelUpStep)
        const skillName = this._trainedStat() === PlayerStat.RANGED ? 'RANGED' : 'MAGIC';
        const level = getBaseLevel(player, this._trainedStat());
        if (this.stepLevel === -1) this.stepLevel = level;
        const newStep = level > this.stepLevel ? levelUpStep(skillName, this.step, level, st => !this.failedSteps.has(st), [player.x, player.z]) : null;
        this.stepLevel = level;
        if (newStep && newStep !== this.step) {
            this._releaseNpc();
            this._log(player, `LEVEL UP → ${this.step.minLevel} → ${newStep.minLevel}`, 'level_up');
            this.step = newStep;
            this.state = 'walk';
            this.currentNpc = null;
            this.scanFail = 0;
            this.patrolTarget = null;
            this.patrolTicks = 0;
        }

        // ── INVENTORY FULL ────────────────────────────────────────────────────
        if (isInventoryFull(player) && !['bank_walk', 'bank_deposit', 'shop_walk', 'shop_open', 'shop_buy'].includes(this.state)) {
            this._log(player, 'INVENTORY FULL → bank_walk', 'inv_full');
            this.state = 'bank_walk';
            this.currentNpc = null;
            return;
        }

        // ── LOW AMMO / RUNES → bank to restock ───────────────────────────────
        // Uses the currently-picked tier (this.currentArrowId / this.currentSpell),
        // not a fixed item — so restocking always chases whatever tier the bot
        // has actually settled into.
        // port: only while fighting. Upstream ran this in every state, so a bot already on its way to the bank for
        // ammunition was sent to 'bank_walk' again, and returned, before the bank_walk handler below ever ran: it
        // stood where it was for good (and the watchdog is paused in bank_walk)
        // port: (not while it runs from an attacker: 'flee' goes to the bank after)
        const fighting = ['walk', 'patrol', 'scan', 'interact', 'eat'].includes(this.state);
        if (fighting && this.mode === 'ranged') {
            if (this._carried(player, this.currentArrowId) < ARROW_LOW_THRESHOLD) {
                const bankCount = this._countAll(player, this.currentArrowId) - this._carried(player, this.currentArrowId);
                if (bankCount > 0) {
                    this._log(player, 'low arrows → bank_walk', 'low_ammo');
                    this.state = 'bank_walk';
                    this.currentNpc = null;
                    return;
                }
                // None in bank either — buy more of whatever tier is currently affordable.
                if (this._totalCoins(player) >= ARROW_BUY_QTY * this.currentArrowCost) {
                    this.shopQueue = [{ shopKey: 'VARROCK_ARCHERY', npcName: 'lowe', itemId: this.currentArrowId, qty: ARROW_BUY_QTY, cost: priceOf(this.currentArrowId, this.currentArrowCost), op: 3 }];
                    this._goShopping(player);
                    return;
                }
            }
        }
        if (fighting && this.mode === 'magic') {
            const catalyst = this.currentSpell.catalystRune;
            if (this._carried(player, catalyst) < RUNE_LOW_THRESHOLD) {
                const bankCount = this._countAll(player, catalyst) - this._carried(player, catalyst);
                if (bankCount > 0) {
                    this._log(player, 'low runes → bank_walk', 'low_runes');
                    this.state = 'bank_walk';
                    this.currentNpc = null;
                    return;
                }
                if (this.currentSpell.catalystCost >= 0 && this._totalCoins(player) >= RUNE_BUY_QTY * this.currentSpell.catalystCost) {
                    this.shopQueue = [{ shopKey: 'VARROCK_RUNES', npcName: 'aubury', itemId: catalyst, qty: RUNE_BUY_QTY, cost: priceOf(catalyst, this.currentSpell.catalystCost), op: 3 }];
                    this._goShopping(player);
                    return;
                }
                // Out of runes, can't shop-buy this tier (e.g. blood runes) or
                // can't afford it — drop back down to a sustainable tier now
                // rather than standing idle waiting for runes that won't come.
                this.state = 'check_equip';
                return;
            }
        }

        // ── BANK ──────────────────────────────────────────────────────────────
        if (this.state === 'bank_walk') {
            // port: hurt and attacked on the way: it runs first (as CombatTask)
            if (hpBelow(player, EAT_BELOW) && runFromAttackers(player)) return;
            const result = advanceBankWalk(player, this.stuck);
            if (result === 'walk') return;
            // port (the realism work): a person's stop at the booth, never the same twice (port/BotHabits.bankStop)
            this.cooldown = result === 'ready' ? bankStop(player) : 0;
            this.state = 'bank_deposit';
            return;
        }

        if (this.state === 'bank_deposit') {
            // _equipLoot() is a generic "wear anything better than what's worn"
            // sweep meant for armor/jewellery drops. Its tier heuristic only
            // recognizes melee weapon material names (bronze/iron/.../rune) —
            // a bow resolves to tier -1 (unrecognized), so ANY tiered melee
            // weapon sitting in inventory (e.g. a leftover woodcutting axe)
            // always looks like an "upgrade" and gets auto-equipped over the
            // bow. Left uncorrected this fights _equipWeapons() every single
            // bank visit — check_equip immediately fails _isFullyEquipped()
            // again and loops straight back to bank_walk forever.
            // port (the variety work, round 1, track W: WEAR-1): the review of phase 4 put a ranger's plate back on here;
            // now the outfit follows the fight, after the weapons below (port/BotGear dressForMode)
            _equipLoot(player);
            cleanGrimyHerbs(player);
            // Re-pick the best sustainable tier from the coin balance right
            // after depositing loot (most accurate coin count), then deposit
            // any stale lower-tier gear and withdraw the new tier.
            this._refreshGearAndSpell(player);
            this._depositLoot(player);
            this._withdrawAmmo(player);
            // Re-assert the correct weapon now that it's guaranteed to be in
            // hand (undoes whatever _equipLoot() wrongly equipped above), then
            // deposit again so the displaced item (the axe) actually leaves
            // the inventory instead of sitting there to be re-grabbed next trip.
            this._equipWeapons(player);
            this._depositLoot(player);
            bankFoodAbove(player, COMBAT_FOOD); // port (variety round 1, track F): spare food above the trip's goes in too
            // port (the variety work, round 1, track W: WEAR-1): the fight's outfit: a ranged fight's without a metal body
            // (the ranger's pieces it owns on), a magic fight's without metal (its wizard hat, robe and skirt on)
            if (this.mode) dressForMode(player, this.mode);
            withdrawFood(player, COMBAT_FOOD); // port: the best food the bot can eat here (was: sharks, then any)
            takeWebBlade(player, this.step); // port (the variety work, round 1, the fixes): a knife for the sewers' web
            // port: the coins a shopping trip needs (_goShopping), now that the pack is sorted
            if (this.shopCoins > 0) {
                const bid = bankInvId();
                const bank = bid === -1 ? null : player.getInventory(bid);
                const inv = player.getInventory(InvType.INV);
                const short = this.shopCoins - countItem(player, Items.COINS);
                if (bank && inv && short > 0) moveItems(bank, inv, Items.COINS, short);
                this.shopCoins = 0;
                // port (the realism work, phase 5a): and the runes for a teleport from Varrock's shops to its spot, when
                // that walk would be one (port/BotTeleport: a teleporter with the level and the runes). Its unseen jump
                // after the shopping went
                const [lx, lz] = this.step.location;
                packTeleportRunes(player, VARROCK_SHOPS[0], VARROCK_SHOPS[1], lx, lz);
            }
            // port: no food anywhere and still hurt: done for now (as CombatTask)
            if (hpBelow(player, FIGHT_START_WITHOUT_FOOD) && carriedFood(player) === 0) {
                this._log(player, 'no food and low HP → task done', 'no_food');
                this.interrupt();
                return;
            }
            this.state = 'check_equip';
            this.cooldown = 3;
            return;
        }

        // ── WALK ──────────────────────────────────────────────────────────────
        if (this.state === 'walk') {
            const [lx, lz, ll] = this.step.location;

            if (!isNear(player, lx, lz, 15, ll)) {
                // Dungeon entrance handling
                const extra = this.step.extra as RangedMagicExtra | undefined;
                if (extra?.dungeon && lz > 6000 && player.z < 6000) {
                    const { entrance: [ex, ez], floor: [fx, fz, fl] } = dungeonRoute(lx, lz); // port: this dungeon's way in
                    if (!isNear(player, ex, ez, 6)) {
                        this._stuckWalk(player, ex, ez);
                        return;
                    }
                    // (the variety work, round 1, Track D: a manhole or a trapdoor opened, then climbed down: port/BotDungeons)
                    if (enterDungeon(player, dungeonRoute(lx, lz))) return;
                    if (!climbDownNear(player, 6)) botTeleport(player, fx, fz, fl, 'dungeon'); // port: its ladder, where it has one (variety round 1, F: or its trapdoor, opened first)
                    return;
                }

                // Via waypoint
                const via = this.step.via;
                if (via && player.level === via[2] && player.z < via[1] && !isNear(player, via[0], via[1], 5)) {
                    const [jx, jz] = botJitter(player, via[0], via[1], 3);
                    this._stuckWalk(player, jx, jz);
                    return;
                }

                const [jx, jz] = botJitter(player, lx, lz, 6);
                this._stuckWalk(player, jx, jz);
                return;
            }

            this.state = 'patrol';
            this.patrolTicks = 0;
            this.patrolTarget = null;
            return;
        }

        // ── FLEE ──────────────────────────────────────────────────────────────
        // port: away from the chaser by port/BotDefence's run (the farthest of three routes, on while it chases), then
        // to the bank: only a hurt bot with no food flees. Upstream ran to the step's spot, toward what it fled, and
        // went back to scanning there
        if (this.state === 'flee') {
            this.fleeTicks++;
            if (runFromAttackers(player)) return;
            this.state = 'bank_walk';
            this.fleeTicks = 0;
            return;
        }

        // ── EAT ───────────────────────────────────────────────────────────────
        if (this.state === 'eat') {
            this._eatFood(player);
            return;
        }

        // ── PATROL ────────────────────────────────────────────────────────────
        if (this.state === 'patrol') {
            const [cx, cz] = this.step.location;
            const [jcx, jcz] = botJitter(player, cx, cz, 8);

            // port: no gate sweep (a gate is opened for an NPC it cannot get to: interact)

            if (!this.patrolTarget || this.patrolTicks % randInt(3, 6) === 0) {
                this.patrolTarget = [jcx + randInt(-8, 8), jcz + randInt(-8, 8)];
            }

            this.patrolTicks++;
            const [tx, tz] = this.patrolTarget;
            walkTo(player, tx, tz);

            if (this.patrolTicks % 2 === 0 && this.pause.ready) {
                let npc = this._findTarget(player);
                if (!npc) npc = this._findTargetWider(player);

                if (npc) {
                    this._log(player, `found NPC → ${NpcType.get(npc.type).name ?? npc.type}`, 'patrol_found');
                    if (!isNear(player, npc.x, npc.z, 5)) {
                        walkTo(player, npc.x, npc.z);
                        return;
                    }
                    // port (the variety work, round 1, track F: ISS-11): not one out of reach and out of sight
                    if (this._outOfReach(player, npc)) return;
                    this._claimNpc(npc);
                    this.currentNpc = npc;
                    this.noXpClicks = 0;
                    this.gateTried = false;
                    this._setAttackStyle(player);
                    interactNpcOp(player, npc, 2);
                    this.state = 'interact';
                    this.interactTicks = 0;
                    this.approachTicks = 0;
                    this.lastXp = player.stats[this._trainedStat()];
                    this.scanFail = 0;
                    this.hasFoughtInArea = true;
                    return;
                }

                if (this.patrolTicks > randInt(6, 12)) {
                    this.state = 'scan';
                    this.patrolTicks = 0;
                    this.patrolTarget = null;
                }
            }
            return;
        }

        // ── SCAN ──────────────────────────────────────────────────────────────
        if (this.state === 'scan') {
            // port: no gate sweep (see patrol)

            // port (the realism work): after a kill the next NPC a moment later, as a person looks round for one
            // (TargetPause; one that attacks meanwhile gets the game's own retaliation, and the HP checks above still run)
            if (!this.pause.ready) return;

            let npc = this._findTarget(player);
            if (!npc) npc = this._findTargetWider(player);
            // port (variety round 1, F: ISS-11): not one out of reach and out of sight (the next scan finds another)
            if (npc && this._outOfReach(player, npc)) return;

            if (npc) {
                this._claimNpc(npc);
                this.currentNpc = npc;
                this.noXpClicks = 0;
                this.gateTried = false;
                this._setAttackStyle(player);
                interactNpcOp(player, npc, 2);
                this.state = 'interact';
                this.interactTicks = 0;
                this.approachTicks = 0;
                this.lastXp = player.stats[this._trainedStat()];
                this.scanFail = 0;
                this.hasFoughtInArea = true;
                return;
            }

            this.scanFail++;
            if (this.scanFail >= 10) {
                this.scanFail = 0;
                this.state = 'walk';
            } else {
                const [lx, lz] = this.step.location;
                const [jx, jz] = botJitter(player, lx, lz, 6);
                walkTo(player, jx, jz);
            }
            return;
        }

        // ── INTERACT ──────────────────────────────────────────────────────────
        if (this.state === 'interact') {
            if (!this.currentNpc) {
                this.state = 'scan';
                return;
            }

            this.interactTicks++;
            this.approachTicks++;

            const xpNow = player.stats[this._trainedStat()];
            const xpGained = xpNow - this.lastXp;
            if (xpGained > 0) {
                this.lastXp = xpNow;
                this.approachTicks = 0;
                this.interactTicks = 0; // port: a fight that goes on is no timeout
                this.noXpClicks = 0;
                // port: upstream never told its watchdog, which teleported a bot that was training fine back to its
                // spot (and to check_equip) every 150 ticks
                this.watchdog.notifyActivity();
            }

            // NPC dead — scan for next target
            if (!this._isNpcAlive(player, this.currentNpc)) {
                this._releaseNpc();
                this.currentNpc = null;
                this.state = 'scan';
                this.interactTicks = 0;
                return;
            }

            // Approach timeout — re-engage
            // port (the realism work): not in the tick it lost its target (TargetPause)
            if (this.approachTicks >= INTERACT_TIMEOUT && this.pause.ready) {
                this.approachTicks = 0;
                // port: a gate by the NPC once; after two re-clicks with no XP it is one the bot cannot hit (behind a
                // wall, out of sight): skipped for 200 ticks (upstream re-clicked it every 20 ticks until the watchdog)
                if (!this.gateTried && tryOpenGateNear(player, this.currentNpc.x, this.currentNpc.z, 6)) {
                    this.gateTried = true;
                    return;
                }
                if (++this.noXpClicks > 2) {
                    if (this.currentNpc.nid >= 0) this.unreachable.set(this.currentNpc.nid, this.taskTicks + 200);
                    this._releaseNpc();
                    this.currentNpc = null;
                    this.state = 'scan';
                    this.interactTicks = 0;
                    this.noXpClicks = 0;
                    return;
                }
                interactNpcOp(player, this.currentNpc, 2);
                return;
            }

            // Overall interact timeout — give up
            if (this.interactTicks >= INTERACT_TIMEOUT * 3) {
                this._log(player, 'interact timeout → scan', 'timeout');
                this._releaseNpc();
                this.currentNpc = null;
                this.state = 'scan';
                this.interactTicks = 0;
                return;
            }
        }
    }

    // ── Mode detection ─────────────────────────────────────────────────────────

    /**
     * port: what the bot has on it, carried or worn. Upstream counted the inventory only, but the wear script moves
     * the bow, the arrows and the staff out of it at once: the next tick the task found no gear and could not run,
     * or (arrows) went to the bank for ammunition it was wearing. In test/sim.mjs no bot trained Ranged or Magic.
     */
    private _carried(player: Player, id: number): number {
        let n = countItem(player, id);
        const worn = player.getInventory(InvType.WORN);
        if (worn) {
            for (let i = 0; i < worn.capacity; i++) {
                const it = worn.get(i);
                if (it?.id === id) n += it.count;
            }
        }
        return n;
    }

    /** Count an item across inventory, worn equipment (port) + bank. */
    private _countAll(player: Player, id: number): number {
        let n = this._carried(player, id);
        const bid = bankInvId();
        if (bid !== -1) {
            const bank = player.getInventory(bid);
            if (bank) {
                for (let i = 0; i < bank.capacity; i++) {
                    const it = bank.get(i);
                    if (it?.id === id) n += it.count;
                }
            }
        }
        return n;
    }

    /** `keep`: the task's mode so far, kept while its gear lasts */
    private _pickMode(player: Player, keep: Mode | null = null): Mode | null {
        const hasBow = RangedBowsByLevel.some(t => this._countAll(player, t.itemId) > 0);
        const hasArrows = RangedArrowsByCost.some(a => this._countAll(player, a.itemId) > 0);
        // port (the variety work, round 2, track W2: WEAR-7) any air staff it can wield: the staff of air, an air
        // battlestaff (30 Magic and Attack), a mystic air staff (40): a members mage keeps its own staff in hand
        const hasStaff = this._airStaff(player, 'all') !== null;
        // Any wind-line catalyst rune is enough to start — pickBestWindSpell()
        // will settle on the tier the bot can actually sustain.
        const hasCatalyst = WIND_SPELLS.some(t => this._countAll(player, t.catalystRune) > 0);

        const canDoMagic = hasStaff && hasCatalyst;
        const canDoRanged = hasBow && hasArrows;

        // port: with both, the skill the planner picked (upstream: 50/50, drawn again at every bank trip, so a bot went
        // from bow to staff and back, and from one skill's spot to the other's), then the task's mode while it lasts
        if (canDoMagic && canDoRanged) {
            if (keep) return keep;
            return this.primaryStat === PlayerStat.MAGIC ? 'magic' : 'ranged';
        }
        if (canDoMagic) return 'magic';
        if (canDoRanged) return 'ranged';
        return null;
    }

    // ── Dynamic tier selection ────────────────────────────────────────────────

    /**
     * Recomputes the best sustainable spell (magic) or bow+arrow (ranged) tier
     * from the bot's current level and coin budget (inventory + bank). Called
     * whenever the bot banks/re-equips, so upgrades — or graceful downgrades,
     * e.g. running out of death runes and dropping back to chaos — happen
     * naturally over time instead of the tier being fixed forever.
     */
    private _refreshGearAndSpell(player: Player): void {
        // port (the variety work, round 2, track W2: AM7) once no trip could buy the tier its coins pick, the best it owns
        // for the rest of the task (else each bank stop picked the unbought tier again)
        if (this.ownedOnly && this._ownedTier(player)) return;
        const coins = this._totalCoins(player);

        if (this.mode === 'magic') {
            const magicLevel = getBaseLevel(player, PlayerStat.MAGIC);
            this.currentSpell = pickBestWindSpell(magicLevel, coins, runeId => this._countAll(player, runeId), Environment.node.members);
        } else if (this.mode === 'ranged') {
            const rangedLevel = getBaseLevel(player, PlayerStat.RANGED);
            const bowTier = bestRangedBow(rangedLevel, id => this._countAll(player, id) > 0);
            this.currentBowId = bowTier.itemId;
            const arrowTier = bestAffordableArrow(coins, id => this._countAll(player, id));
            this.currentArrowId = arrowTier.itemId;
            this.currentArrowCost = arrowTier.cost;
        }
    }

    // ── Equipment helpers ─────────────────────────────────────────────────────

    private _equipWeapons(player: Player): void {
        const inv = player.getInventory(InvType.INV);
        if (!inv) return;

        if (this.mode === 'magic') {
            // Equip staff_of_air if in inventory and not already worn
            // (round 2, W2: or another air staff it can wield, the best it carries)
            const carried = this._airStaff(player, 'pack');
            if (this._airStaff(player, 'worn') === null && carried !== null) {
                for (let slot = 0; slot < inv.capacity; slot++) {
                    const it = inv.get(slot);
                    if (it?.id === carried) {
                        interactHeldOp(player, inv, it.id, slot, 2);
                        break;
                    }
                }
            }
        } else if (this.mode === 'ranged') {
            // Equip the bow/arrow tier _refreshGearAndSpell() picked.
            if (!_wornContains(player, this.currentBowId) && hasItem(player, this.currentBowId)) {
                for (let slot = 0; slot < inv.capacity; slot++) {
                    const it = inv.get(slot);
                    if (it?.id === this.currentBowId) {
                        interactHeldOp(player, inv, it.id, slot, 2);
                        break;
                    }
                }
            }
            if (!_wornContains(player, this.currentArrowId) && hasItem(player, this.currentArrowId)) {
                for (let slot = 0; slot < inv.capacity; slot++) {
                    const it = inv.get(slot);
                    if (it?.id === this.currentArrowId) {
                        interactHeldOp(player, inv, it.id, slot, 2);
                        break;
                    }
                }
            }
        }
    }

    /**
     * port (the variety work, round 2, track W2: AM7) the best tier the bot owns (worn, carried, banked) for its mode, in
     * place of one it neither owns nor can buy: a ranger's best arrows and bow of its level, a mage's best wind spell of its
     * level whose catalyst runes it has. True when it owns the picked gear now.
     */
    private _ownedTier(player: Player): boolean {
        if (this.mode === 'ranged') {
            const level = getBaseLevel(player, PlayerStat.RANGED);
            const bow = [...RangedBowsByLevel].reverse().find(t => level >= t.levelReq && this._countAll(player, t.itemId) > 0);
            const arrow = [...RangedArrowsByCost].reverse().find(a => this._countAll(player, a.itemId) > 0);
            if (bow) this.currentBowId = bow.itemId;
            if (arrow) {
                this.currentArrowId = arrow.itemId;
                this.currentArrowCost = arrow.cost;
            }
        } else if (this.mode === 'magic') {
            const level = getBaseLevel(player, PlayerStat.MAGIC);
            const spell = [...WIND_SPELLS].reverse().find(t => (!t.members || Environment.node.members) && level >= t.levelRequired && this._countAll(player, t.catalystRune) > 0);
            if (spell) this.currentSpell = spell;
        }
        return this._ownsPickedGear(player);
    }

    /**
     * port (the variety work, round 2, track W2: WEAR-7) the best air staff the bot can wield (274's levels: an air
     * battlestaff 30 Magic and Attack, a mystic air staff 40) that it has `where`: worn, in its pack, in its bank, or
     * anywhere; null: none
     */
    private _airStaff(player: Player, where: 'worn' | 'pack' | 'bank' | 'all'): number | null {
        const magic = getBaseLevel(player, PlayerStat.MAGIC);
        const attack = getBaseLevel(player, PlayerStat.ATTACK);
        const bid = bankInvId();
        const invs = where === 'worn' ? [InvType.WORN] : where === 'pack' ? [InvType.INV] : where === 'bank' ? [bid] : [InvType.WORN, InvType.INV, bid];
        let best: number | null = null;
        for (const [i, id] of airStaves().entries()) {
            const need = AIR_STAFF_LEVEL[i] ?? 1;
            if (magic < need || attack < need || !usableOnThisWorld(id)) continue;
            if (invs.some(inv => inv !== -1 && (player.getInventory(inv)?.getItemCount(id) ?? 0) > 0)) best = id;
        }
        return best;
    }

    private _setAttackStyle(player: Player): void {
        if (this.mode === 'magic') {
            // Autocast whichever wind-line spell _refreshGearAndSpell() picked.
            setAutocastSpell(player, this.currentSpell.autocastVarp);
        } else {
            // Ranged: style 0 (accurate) → ranged XP
            setCombatStyle(player, 0);
        }
    }

    /**
     * True only if the weapon (and ammo/runes) needed for the current mode is
     * actually in hand, not just owned somewhere across inventory + bank.
     * _pickMode()/_refreshGearAndSpell() are ownership checks (inv+bank) — this
     * is the "can the bot swing right now" check that gates leaving check_equip.
     */
    /** port: the bot has the gear the picked tier needs, somewhere (carried, worn or banked) */
    private _ownsPickedGear(player: Player): boolean {
        if (this.mode === 'magic') return this._airStaff(player, 'all') !== null && this._countAll(player, this.currentSpell.catalystRune) > 0;
        if (this.mode === 'ranged') return this._countAll(player, this.currentBowId) > 0 && this._countAll(player, this.currentArrowId) > 0;
        return false;
    }

    private _isFullyEquipped(player: Player): boolean {
        if (this.mode === 'magic') {
            return this._airStaff(player, 'worn') !== null && countItem(player, this.currentSpell.catalystRune) > 0;
        }
        if (this.mode === 'ranged') {
            // port: worn arrows (the ammo slot) count too
            return _wornContains(player, this.currentBowId) && this._carried(player, this.currentArrowId) > 0;
        }
        return false;
    }

    // ── Step selection ────────────────────────────────────────────────────────

    private _refreshStep(player: Player): void {
        if (!this.mode) return;
        const skillName = this.mode === 'ranged' ? 'RANGED' : 'MAGIC';
        // port: the level of the skill the mode trains (upstream: the planner's pick, which can be the other one)
        const level = getBaseLevel(player, this._trainedStat());
        // port: the spot is kept while it is one of the mode's own, in its level's range, and the watchdog found
        // nothing wrong there (the planner picked it near the bot; an activity's spot is kept after
        // each load). Upstream drew one anywhere in the world after every bank trip and watchdog: a combat-70 archer
        // at Ardougne walked to Al Kharid's warriors and back, over two boats each way (the aged sim, seed 3)
        const usable = (st: SkillStep): boolean => level >= st.minLevel && level <= st.maxLevel && !this.failedSteps.has(st);
        if (SkillProgression[skillName]?.includes(this.step) && usable(this.step)) {
            this.stepLevel = level;
            return;
        }
        // port: the other skill's step (the bot had only the other gear): the same spot in this skill's table, else
        // another, the nearer the likelier (BotKnowledge.pickStep), not one that failed
        const [x, z, l] = this.step.location;
        const from: [number, number] = [player.x, player.z];
        const s =
            SkillProgression[skillName]?.find(st => st.location[0] === x && st.location[1] === z && st.location[2] === l && usable(st)) ??
            getProgressionStepWhere(skillName, level, st => !this.failedSteps.has(st), from) ??
            getProgressionStep(skillName, level, undefined, from);
        if (s) {
            this.step = s;
            this.stepLevel = level;
        }
    }

    /**
     * port: the skill the bot is training: the mode's, once picked. The planner asks for Ranged or Magic, but the mode
     * goes by the gear the bot has (a bow for a Magic pick): upstream then watched the planner's skill for XP, saw
     * none, gave up on every target after 60 ticks and never fed its watchdog.
     */
    private _trainedStat(): PlayerStat {
        if (this.mode === 'ranged') return PlayerStat.RANGED;
        if (this.mode === 'magic') return PlayerStat.MAGIC;
        return this.primaryStat;
    }

    // ── Shopping helpers ──────────────────────────────────────────────────────

    private _totalCoins(player: Player): number {
        return this._countAll(player, Items.COINS);
    }

    private _buildShopQueue(player: Player): ShopBuy[] {
        const queue: ShopBuy[] = [];
        const coins = this._totalCoins(player);

        // Staff of air (1 000gp) — always needed to unlock magic mode at all,
        // regardless of which wind spell tier ends up affordable.
        const staffPrice = priceOf(Items.STAFF_OF_AIR, 1000);
        if (this._airStaff(player, 'all') === null && coins >= staffPrice) {
            queue.push({ shopKey: 'VARROCK_STAFFS', npcName: 'zaff', itemId: Items.STAFF_OF_AIR, qty: 1, cost: staffPrice, op: 3 });
        }

        // Bow — buy the tier bestRangedBow() picked, but only if it's actually
        // shop-sold (willow+ come from Fletching, never purchased here) and not
        // already owned.
        const rangedLevel = getBaseLevel(player, PlayerStat.RANGED);
        const bowTier = bestRangedBow(rangedLevel, id => this._countAll(player, id) > 0);
        const bowConfig = RangedBowsByLevel.find(t => t.itemId === bowTier.itemId);
        const tableBowCost = bowConfig?.shopKey ? Shops[bowConfig.shopKey]?.stock.find(s => s.itemId === bowTier.itemId)?.cost : undefined;
        const bowCost = tableBowCost === undefined ? undefined : priceOf(bowTier.itemId, tableBowCost);
        if (bowConfig && bowConfig.shopKey && bowCost !== undefined && this._countAll(player, bowTier.itemId) === 0 && coins >= bowCost) {
            queue.push({ shopKey: bowConfig.shopKey as keyof typeof Locations, npcName: 'lowe', itemId: bowTier.itemId, qty: 1, cost: bowCost, op: 3 });
        }

        // Arrows — buy the coin-affordable tier bestAffordableArrow() picked.
        const arrowTier = bestAffordableArrow(coins, id => this._countAll(player, id));
        const arrowCount = this._carried(player, arrowTier.itemId);
        const arrowPrice = priceOf(arrowTier.itemId, arrowTier.cost);
        if (arrowCount < ARROW_BUY_QTY && coins >= arrowPrice * (ARROW_BUY_QTY - arrowCount)) {
            queue.push({ shopKey: 'VARROCK_ARCHERY', npcName: 'lowe', itemId: arrowTier.itemId, qty: ARROW_BUY_QTY - arrowCount, cost: arrowPrice, op: 3 });
        }

        // port (the realism work, phase 5a): a teleporter's elementals for its spells (fire, earth, water) at Aubury's
        // too, when it is buying runes there anyway (port/BotTeleport.elementalsWanted; air: its staff)
        const elementals = (): void => {
            if (!queue.some(b => b.shopKey === 'VARROCK_RUNES')) return;
            for (const [rune, qty] of elementalsWanted(player)) {
                const table = Shops.VARROCK_RUNES?.stock.find(st => st.itemId === rune)?.cost;
                const cost = table === undefined ? undefined : priceOf(rune, table);
                if (cost !== undefined && coins >= cost * qty * 2) queue.push({ shopKey: 'VARROCK_RUNES', npcName: 'aubury', itemId: rune, qty, cost, op: 3 });
            }
        };

        // Catalyst rune — buy the tier pickBestWindSpell() picked (mind/chaos/
        // death — never blood, that spell only activates if already owned).
        const magicLevel = getBaseLevel(player, PlayerStat.MAGIC);
        const spellTier = pickBestWindSpell(magicLevel, coins, runeId => this._countAll(player, runeId), Environment.node.members);
        if (spellTier.catalystCost >= 0) {
            const runeCount = this._carried(player, spellTier.catalystRune);
            const runePrice = priceOf(spellTier.catalystRune, spellTier.catalystCost);
            if (runeCount < RUNE_BUY_QTY && coins >= runePrice * (RUNE_BUY_QTY - runeCount)) {
                queue.push({ shopKey: 'VARROCK_RUNES', npcName: 'aubury', itemId: spellTier.catalystRune, qty: RUNE_BUY_QTY - runeCount, cost: runePrice, op: 3 });
            }
        }

        elementals();
        return queue;
    }

    /**
     * port (phase 5a): a shop visit that bought nothing (dearer than its coins, sold out, the window never opened). The
     * NO_BUY_VISITS-th in a row ends the task (true): its gear check sent it back to the same shop for good.
     */
    private _noBuy(player: Player): boolean {
        if (++this.noBuys < NO_BUY_VISITS) return false;
        if (openShopStock(player)) player.closeModal();
        this._log(player, `nothing bought at ${NO_BUY_VISITS} shops in a row → task done`, 'shop_none');
        this.interrupt();
        return true;
    }

    private _nextShop(): void {
        this.currentShop = this.shopQueue.shift() ?? null;
        this.shopNpc = null;
        this.shopWait = 0;
        this.shopTries = 0;
    }

    /**
     * port (phase 5a): this shop is done (bought, sold out, the coins gone, never opened): its window shut, the next
     * shop or the gear check. The walk to the spot after it is a walk: its unseen jump went (a teleport spell where the
     * bot packed the runes for it at its bank stop: port/BotTeleport)
     */
    private _afterShop(player: Player): void {
        if (openShopStock(player)) player.closeModal();
        this._nextShop();
        this.state = this.currentShop ? 'shop_walk' : 'check_equip';
    }

    /**
     * port: off to the shops in the queue, with the coins for them: what the pack lacks is fetched from the bank first.
     * The tier is picked by the coins in the pack and the bank, but a shop takes only what the bot carries: a mage with
     * its coins in the bank walked to Aubury's for death runes, could not pay, worked its tier out again and asked
     * again, every 8 ticks, for good (and its watchdog jumped it to its spot and back every 230 ticks: the aged sim).
     * Two bank trips that do not put the coins in the pack, or none for even one of anything: the task is over.
     */
    private _goShopping(player: Player): void {
        this._nextShop();
        const buys = [this.currentShop, ...this.shopQueue].filter((b): b is ShopBuy => b !== null);
        const carried = countItem(player, Items.COINS);
        const need = buys.reduce((sum, b) => sum + b.qty * b.cost, 0);
        if (carried < need && this.shopCoinTrips < 2 && this._totalCoins(player) > carried) {
            this.shopCoins = need;
            this.shopCoinTrips++;
            this.currentShop = null;
            this.shopQueue = [];
            this.state = 'bank_walk';
            return;
        }
        if (buys.length === 0 || buys.every(b => carried < b.cost)) {
            this._log(player, `cannot pay for any of it (${carried} coins carried) → task done`, 'shop_broke');
            this.interrupt();
            return;
        }
        this.state = 'shop_walk';
    }

    // ── Banking helpers ───────────────────────────────────────────────────────

    /**
     * port (the variety work, round 1, track F: ISS-11): neither a way to the NPC nor a line of sight to it
     * (BotTaskBase.npcReachable): passed over for UNREACHABLE_NPC_TICKS. Unknown (no searches left this tick) is no.
     */
    private _outOfReach(player: Player, npc: Npc): boolean {
        if (npcReachable(player, npc, true) !== false) return false;
        if (npc.nid >= 0) this.unreachable.set(npc.nid, this.taskTicks + UNREACHABLE_NPC_TICKS);
        this.state = 'scan';
        return true;
    }

    private _depositLoot(player: Player): void {
        const bid = bankInvId();
        if (bid === -1) return;
        const inv = player.getInventory(InvType.INV);
        const bank = player.getInventory(bid);
        if (!inv || !bank) return;

        // Only the CURRENT tier's gear is protected from being banked — any
        // stale lower tier left over from before a level-up/coin windfall
        // (e.g. old bronze arrows once on iron, or mind runes once on chaos)
        // gets deposited normally instead of cluttering the inventory forever.
        // It isn't lost: still sitting in the bank if the bot ever needs to
        // drop back down a tier.
        const keep = new Set<number>([Items.COINS, ...airStaves(), this.currentBowId, this.currentArrowId, this.currentSpell.catalystRune]);

        for (let slot = 0; slot < inv.capacity; slot++) {
            const it = inv.get(slot);
            if (!it || keep.has(it.id) || edibleFoodIds().includes(it.id)) continue; // port: members food on a free world is banked
            const moved = inv.remove(it.id, it.count);
            if (moved > 0) bank.add(bankedId(it.id), moved);
        }
    }

    /** port: food the bot can eat on this world (a shark on a free world cannot be eaten) */
    private _hasFood(player: Player): boolean {
        return carriedFood(player) > 0;
    }

    private _eatFood(player: Player): void {
        if (!this._hasFood(player)) {
            // Out of food
            this.state = 'walk';
            return;
        }
        if (eatBestFood(player)) {
            this._log(player, 'ate to heal', 'ate_food');
            // port (the realism work): the next bite at a person's pace (BotTiming 'page'), not every 4th tick
            this.cooldown = 2 + humanDelay(player, 'page');
            this.eatTries = 0;
            this.state = hpBelow(player, EAT_UNTIL) && this._hasFood(player) ? 'eat' : 'walk';
            return;
        }
        // port: busy (a delay): try again, but not for ever
        if (++this.eatTries > 5) this.state = 'walk';
    }

    /** Withdraws a single non-stackable item (bow, staff) from the bank into inventory, if not already held. */
    private _withdrawSingle(player: Player, bank: Inventory, inv: Inventory, itemId: number): void {
        if (hasItem(player, itemId)) return;
        for (let i = 0; i < bank.capacity; i++) {
            if (bank.get(i)?.id === itemId) {
                const moved = moveItems(bank, inv, itemId, 1);
                break;
            }
        }
    }

    private _withdrawAmmo(player: Player): void {
        if (!this.mode) return;
        const bid = bankInvId();
        if (bid === -1) return;
        const inv = player.getInventory(InvType.INV);
        const bank = player.getInventory(bid);
        if (!inv || !bank) return;

        // The weapon itself is checked independent of ammo/rune supply — a bot
        // that already has 500 arrows but no bow (e.g. after a fresh tier
        // upgrade banked the old bow) must still get the bow withdrawn here,
        // not skipped because "ammo is fine".
        if (this.mode === 'ranged') {
            this._withdrawSingle(player, bank, inv, this.currentBowId);
        } else {
            // (round 2, W2: its best air staff, when it carries and wears none)
            const banked = this._airStaff(player, 'bank');
            if (this._airStaff(player, 'worn') === null && this._airStaff(player, 'pack') === null && banked !== null) this._withdrawSingle(player, bank, inv, banked);
        }

        // Withdraw the current tier's arrows or catalyst runes from the bank.
        const target = this.mode === 'ranged' ? this.currentArrowId : this.currentSpell.catalystRune;
        const inInv = this._carried(player, target);
        if (inInv >= ARROW_BUY_QTY) return; // already have plenty

        for (let i = 0; i < bank.capacity; i++) {
            const it = bank.get(i);
            if (!it || it.id !== target) continue;
            const need = Math.min(it.count, ARROW_BUY_QTY - inInv);
            if (need <= 0) break;
            const moved = moveItems(bank, inv, target, need);
            break;
        }
    }

    // ── NPC targeting ─────────────────────────────────────────────────────────

    private _findTarget(player: Player): Npc | null {
        const extra = this.step.extra as RangedMagicExtra | undefined;
        if (!extra) return null;
        const names: string[] = [];
        if (extra.npcTypes?.length) names.push(...extra.npcTypes);
        if (extra.npcType) names.push(extra.npcType);
        for (const name of names.sort(() => Math.random() - 0.5)) {
            const npc = findNpcFiltered(player.x, player.z, player.level, n => npcMatchesName(n, name) && this._isAvailable(n), 22);
            if (npc) return npc;
        }
        return null;
    }

    private _findTargetWider(player: Player): Npc | null {
        const extra = this.step.extra as RangedMagicExtra | undefined;
        if (!extra) return null;
        const names: string[] = [];
        if (extra.npcTypes?.length) names.push(...extra.npcTypes);
        if (extra.npcType) names.push(extra.npcType);
        for (const name of names.sort(() => Math.random() - 0.5)) {
            const npc = findNpcFiltered(player.x, player.z, player.level, n => npcMatchesName(n, name) && this._isAvailable(n), 35);
            if (npc) return npc;
        }
        return null;
    }

    private _isAvailable(npc: Npc): boolean {
        // port: and not one someone is already fighting (upstream checked only its own claims)
        if ((npc as any).target !== null && (npc as any).target !== undefined) return false;
        if ((this.unreachable.get(npc.nid) ?? -1) > this.taskTicks) return false; // port: one it could not hit
        return !CLAIMED_NPCS.has(_npcKey(npc));
    }

    private _isNpcAlive(player: Player, npc: Npc): boolean {
        return findNpcFiltered(player.x, player.z, player.level, n => n === npc, 30) !== null;
    }

    // ── NPC claim ─────────────────────────────────────────────────────────────

    private _claimNpc(npc: Npc): void {
        this._releaseNpc();
        const key = _npcKey(npc);
        if (key < 0) return; // an NPC that has left the world is no one's
        this.claimedNpcKey = key;
        CLAIMED_NPCS.add(this.claimedNpcKey);
    }

    private _releaseNpc(): void {
        if (this.claimedNpcKey !== -1) {
            CLAIMED_NPCS.delete(this.claimedNpcKey);
            this.claimedNpcKey = -1;
        }
    }

    // ── Stuck walk ────────────────────────────────────────────────────────────

    private _stuckWalk(player: Player, lx: number, lz: number): void {
        if (!this.stuck.check(player, lx, lz)) {
            walkTo(player, lx, lz);
            return;
        }
        if (this.stuck.desperatelyStuck) {
            teleportNear(player, lx, lz);
            this.stuck.reset();
            return;
        }
        // Try to open a gate/door blocking the path before giving up (port: a door by the bot only)
        if (openNearbyGate(player, 8)) {
            this.intentCooldown = 3;
            return;
        }
        walkTo(player, player.x + randInt(-10, 10), player.z + randInt(-10, 10));
    }

    // ── Task lifecycle ────────────────────────────────────────────────────────

    isComplete(): boolean {
        return false; // runs until planner re-evaluates (rescans on timer)
    }

    override reset(): void {
        super.reset();
        this._releaseNpc();
        this.state = 'check_equip';
        this.equipFails = 0;
        this.armourChecked = false;
        this.currentNpc = null;
        this.patrolTarget = null;
        this.patrolTicks = 0;
        this.scanFail = 0;
        this.pause.reset();
        this.intentCooldown = 0;
        this.stepLevel = -1;
        this.eatTries = 0;
        this.stuck.reset();
        this.watchdog.reset();
    }
}
