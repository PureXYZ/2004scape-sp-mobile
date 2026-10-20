/**
 * SmithingTask.ts — Withdraw ores/bars from bank, smelt on furnace or smith on anvil, deposit results, repeat.
 *
 * Two modes based on level:
 *   - Furnace (smelt): 100% until level 18, then 75% — ore → bar
 *   - Anvil (smith): Starts at level 18, 25% — 5 bars → platebody
 *
 * Anvil mode uses bars from bank (bank smelted bars first, then use them on anvil).
 */

import {
    BotTask,
    Player,
    Loc,
    InvType,
    walkTo,
    interactUseLocOp,
    findLocByName,
    findLocByPrefix,
    hasItem,
    countItem,
    isNear,
    getBaseLevel,
    PlayerStat,
    Items,
    getProgressionStep,
    teleportNear,
    randInt,
    bankInvId,
    StuckDetector,
    ProgressWatchdog,
    openNearbyGate,
    botJitter,
    advanceBankWalk,
    addXp,
    humanDelay
} from '#/engine/bot/tasks/BotTaskBase.js';
import { bankStop } from '#/engine/bot/port/BotHabits.js';
import type { SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { moveItems, bankedId } from '#/engine/bot/port/BotInventoryCompat.js';
import { pressInterfaceProduct } from '#/engine/bot/tasks/BotTaskBase.js';
import { botContinuePage, botScript } from '#/engine/bot/BotAction.js';
import { claimLocTile, claimWaitTile, releaseStandTile, sharesTile, stepToTile } from '#/engine/bot/port/BotTiles.js';
import World from '#/engine/World.js';

const MIN_MATERIALS = 1;

/**
 * port (the realism work, phase 2): a smelt's own ticks, then a person's use-ore-on-furnace, never a metronome (BotTiming
 * 'next'); upstream waited 6-10 ticks (20 % identical intervals)
 */
const SMELT_TICKS = 4;

const SMITH_FAIL_LIMIT = 6;

const ANVIL_MIN_LEVEL = 18;
const ANVIL_CHANCE = 0.25;

/**
 * port (the variety work, round 1, track F: DO-2): the bars an anvil step works, the mithril, adamant and rune ones with the
 * others (they were banked with every load and missing from the bars the bot "had": the task ended after one load)
 */
const SMITH_BARS: readonly number[] = [Items.BRONZE_BAR, Items.IRON_BAR, Items.STEEL_BAR, Items.GOLD_BAR, Items.MITHRIL_BAR, Items.ADAMANTITE_BAR, Items.RUNITE_BAR];

export class SmithingTask extends BotTask {
    private step: SkillStep;

    private state: 'bank_walk' | 'withdraw' | 'work_walk' | 'work' | 'bank_return' = 'bank_walk';

    private lastXp = 0;
    /** port: the step's ore in the pack at the last look (furnace) */
    private lastOre = 0;
    private workFailTicks = 0;
    private done = false;

    private useAnvil = false;
    private consecutiveAnvilFails = 0;
    private viaLocation?: [number, number, number];
    /** port (the realism work): it holds a tile of its own at the furnace or anvil (port/BotTiles), and whose */
    private ownTile = false;
    private lastPlayer: Player | null = null;
    /** port (the realism work): every tile the furnace or anvil is used from taken: it waits its turn a step away till then */
    private waitUntil = -1;

    private readonly stuck = new StuckDetector(30, 4, 2);
    private readonly watchdog = new ProgressWatchdog();

    constructor(step: SkillStep) {
        super('Smith');
        this.step = step;
        this.viaLocation = step.via;
        this.watchdog.follow(() => this.step.location);
    }

    private debug(player: Player, message: string): void {
        console.log(`[SmithingTask][${player.username}][${this.state}] ${message}`);
    }

    // ── Task lifecycle ────────────────────────────────────────────────────────

    override activityStep(): SkillStep | null {
        return this.step;
    }

    shouldRun(player: Player): boolean {
        const level = getBaseLevel(player, PlayerStat.SMITHING);

        const hasOres = this._hasOresInBankOrInv(player);
        const hasBars = this._hasBarsInBankOrInv(player);
        const hasHammer = hasItem(player, Items.HAMMER);

        this.debug(player, `shouldRun check: level=${level}, hasOres=${hasOres}, hasBars=${hasBars}, hasHammer=${hasHammer}, anvilLevel=${level >= ANVIL_MIN_LEVEL}`);

        // port: what the step works with: bars at the anvil, ores at the furnace (see _shouldUseAnvilMode)
        if (this.step.action === 'smith') return level >= ANVIL_MIN_LEVEL && (hasHammer || countItemInBank(player, Items.HAMMER) > 0) && hasBars;
        // port: a whole bar's worth of the step's own ores, pack and bank (any ore did: with copper and no tin the bot
        // went to the bank, withdrew nothing, ended, and was given the task again)
        const recipe = this._recipe();
        if (recipe) return recipe.every(([id, count]) => countItem(player, id) + countItemInBank(player, id) >= count);
        return hasOres;
    }

    isComplete(_player: Player): boolean {
        return this.done;
    }

    tick(player: Player): void {
        this.lastPlayer = player;
        if (this.interrupted) {
            this.debug(player, 'Tick skipped because task is interrupted');
            return;
        }

        const banking = this.state === 'bank_walk' || this.state === 'withdraw' || this.state === 'bank_return';
        // port (the realism work): its tile at the furnace or anvil goes back when it leaves for the bank
        if (banking && this.ownTile) {
            releaseStandTile(player);
            this.ownTile = false;
        }

        if (this.watchdog.check(player, banking)) {
            player.clearWaypoints();
            player.clearPendingAction();
            this.debug(player, 'Watchdog triggered; teleported to destination, resuming');
            this.stuck.reset();
            this.state = 'work_walk';
            this.workFailTicks = 0;
            return;
        }

        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }

        // ── Progression upgrade ─────────────────────────────────────────────
        // port: no step change mid-task: the planner picked this step for the materials the bot has (upstream drew a
        // random step every tick and took any with a higher minimum: a cook with raw shrimp was sent off to cook swordfish)

        // ── Determine mode ────────────────────────────────────────────────────
        if (this.state === 'bank_walk' || this.state === 'bank_return') {
            const shouldUseAnvil = this._shouldUseAnvilMode(player);

            if (shouldUseAnvil !== this.useAnvil) {
                this.debug(player, `Switching mode: anvil=${shouldUseAnvil}, was=${this.useAnvil}`);
                this.useAnvil = shouldUseAnvil;
            }
        }

        // ── Bank walk ────────────────────────────────────────────────────────────
        if (this.state === 'bank_walk' || this.state === 'bank_return') {
            const result = advanceBankWalk(player, this.stuck, this.step.location);

            if (result === 'walk') {
                return;
            }

            this.debug(player, `advanceBankWalk returned ${result}`);
            // port (the realism work): a person's stop at the booth, never the same twice (port/BotHabits.bankStop)
            this.cooldown = result === 'ready' ? bankStop(player) : 0;
            this.state = 'withdraw';

            return;
        }

        // ── Withdraw materials ────────────────────────────────────────────────
        if (this.state === 'withdraw') {
            this._depositResults(player);

            // Open bank exit door before walking to furnace/anvil — bots
            // teleported inside the bank find it closed and can't exit.
            openNearbyGate(player, 5);

            const hasMaterial = this.useAnvil ? this._withdrawBars(player) : this._withdrawOres(player);

            if (!hasMaterial) {
                this.debug(player, `No materials for mode: anvil=${this.useAnvil}; marking task complete`);
                this.done = true;
                this.interrupt();
                return;
            }

            this.state = 'work_walk';
            this.cooldown = 1;
            return;
        }

        // ── Walk to work location ─────────────────────────────────────────
        if (this.state === 'work_walk') {
            const [lx, lz, ll] = this.step.location;

            // Via waypoint handling - route through intermediate coord
            const via = this.viaLocation;
            if (via) {
                const viaX = via[0];
                const viaZ = via[1];
                if (!isNear(player, viaX, viaZ, 5)) {
                    const [jx, jz] = botJitter(player, viaX, viaZ, 3);
                    this._stuckWalk(player, jx, jz);
                    return;
                }
                // Reached via waypoint - clear it and proceed to location
                this.viaLocation = undefined;
            }

            if (!isNear(player, lx, lz, 1, ll)) {
                this._stuckWalk(player, lx, lz);
                return;
            }

            this.state = 'work';
            this.workFailTicks = 0;
            this.lastXp = player.stats[PlayerStat.SMITHING];
            this.lastOre = countItem(player, this.step.itemConsumed!);
            this.debug(player, `Reached work location; state changed to work, lastXp=${this.lastXp}`);
            return;
        }

        // ── Work (smelt or smith) ───────────────────────────────────────────────
        if (this.state === 'work') {
            // port: a whole bar's worth of the step's ores (with copper and no tin the bot stood at the furnace for good)
            // port: at the anvil, enough of the step's bars for one more of its product (a platebody takes 5)
            const hasMaterial = this.useAnvil ? countItem(player, this.step.itemConsumed!) >= this._barsPerItem() : this._recipe() ? this._canSmelt(player) : this._hasOresInInventory(player);

            if (!hasMaterial) {
                this.debug(player, `No materials left; switching to bank_return`);
                this.state = 'bank_return';
                return;
            }

            const workLoc = this._findWorkLocation(player);
            if (!workLoc) {
                const [lx, lz] = this.step.location;
                this.debug(player, `No work location found nearby; walking toward step location ${lx}, ${lz}`);
                this._stuckWalk(player, lx, lz);
                return;
            }
            // port (the realism work, phase 3: own tiles, port/BotTiles): another smith on its tile at the furnace or the
            // anvil (they all walked to the step's one spot): a step to a free tile it smiths from; on its way there, it
            // gets there first
            if (player.hasWaypoints() && this.ownTile) return;
            if (World.currentTick < this.waitUntil) return;
            if (!player.delayed && !botScript(player) && sharesTile(player)) {
                const tile = claimLocTile(player, workLoc, 1);
                if (tile && (tile[0] !== player.x || tile[1] !== player.z)) {
                    this.ownTile = true;
                    // (a tile it finds no way to: not again for a moment)
                    if (!stepToTile(player, tile[0], tile[1])) this.waitUntil = World.currentTick + 10;
                    return;
                }
                // (every one taken: its turn, a step away)
                const wait = tile ? null : claimWaitTile(player, workLoc, 2);
                if (wait) {
                    this.ownTile = true;
                    this.waitUntil = World.currentTick + randInt(6, 14);
                    if (!stepToTile(player, wait[0], wait[1])) this.waitUntil = World.currentTick + 10;
                    return;
                }
            }

            const itemId = this.step.itemConsumed!;
            const slot = this._getItemSlot(player, itemId);

            // port: the watchdog hears of a smelt when one happens (XP, or ore used up: iron fails half the time);
            // upstream told it of every click, so a bot clicking a furnace it never smelted at was never moved on
            if (!this.useAnvil) {
                const ore = countItem(player, itemId);
                if (player.stats[PlayerStat.SMITHING] > this.lastXp || ore < this.lastOre) this.watchdog.notifyActivity();
                this.lastXp = player.stats[PlayerStat.SMITHING];
                this.lastOre = ore;
            }

            if (slot === null) {
                this.debug(player, `Could not find material ${itemId} in inventory slot list; switching to bank_return`);
                this.state = 'bank_return';
                return;
            }

            // port: the anvil the way a player smiths: the bar used on it opens 274's smithing interface, and a click on
            // the step's product there (make 10, inv_button3) has the game hammer it: the bars go, the items come, the XP
            // with them, at the game's pace. Upstream credited the step's XP for every click on the anvil, made nothing
            // and used no bars: one bot gained 10 Smithing levels from the same 11 bars
            if (this.useAnvil) {
                if (player.stats[PlayerStat.SMITHING] > this.lastXp) {
                    this.lastXp = player.stats[PlayerStat.SMITHING];
                    this.watchdog.notifyActivity();
                }
                // (a level-up's page left open is clicked away first: it would hold the task for good)
                if (botContinuePage(player) || player.delayed || botScript(player)) return; // hammering
                if (this._pressAnvilProduct(player)) {
                    this.workFailTicks = 0;
                    this.consecutiveAnvilFails = 0;
                    this.cooldown = 2;
                    return;
                }
            }

            // (the variety work, round 2, Track D2: D2-7) at the furnace too, a page left open (a Smithing level-up's) is
            // clicked away first: while it was open every ore used on the furnace came to nothing, and the smelter stood
            // still until the watchdog moved it (330 ticks at Al Kharid's in f100 s7)
            if (!this.useAnvil && (botContinuePage(player) || player.delayed)) return;
            this.debug(player, `Attempting ${this.useAnvil ? 'smith' : 'smelt'} interaction on ${workLoc.type} at ${workLoc.x}, ${workLoc.z}, item=${itemId}, slot=${slot}`);
            const ok = interactUseLocOp(player, workLoc, itemId, slot);

            if (ok) {
                // Furnace smelting (smelting.rs2) grants Smithing XP via
                // stat_advance() server-side with no interface involved —
                // no manual credit needed there, it would double-count.

                this.workFailTicks = 0;

                if (this.useAnvil) {
                    this.consecutiveAnvilFails = 0;
                }

                this.cooldown = SMELT_TICKS + humanDelay(player, 'next');

                this.debug(player, `Work action sent successfully; cooldown=${this.cooldown}`);
            } else {
                this.workFailTicks++;
                this.debug(player, `Work interaction failed; workFailTicks=${this.workFailTicks}/${SMITH_FAIL_LIMIT}`);

                if (this.workFailTicks >= SMITH_FAIL_LIMIT) {
                    if (this.useAnvil) {
                        // port: a smithing step has no furnace mode to fall back to (its location is the anvil)
                        this.debug(player, `Too many anvil fails; done`);
                        this.done = true;
                        this.interrupt();
                        return;
                    }

                    if (!isNear(player, workLoc.x, workLoc.z, 5)) {
                        this.debug(player, `Failed too many times; opening nearby gate/curtain and walking to ${workLoc.x}, ${workLoc.z}`);
                        openNearbyGate(player, 8);
                        walkTo(player, workLoc.x, workLoc.z);
                    } else {
                        this.debug(player, `Already near work location, waiting and retrying`);
                    }
                    this.workFailTicks = 0;
                } else {
                    this.cooldown = 1;
                }
            }
            return;
        }
    }

    override reset(): void {
        super.reset();
        if (this.ownTile && this.lastPlayer) releaseStandTile(this.lastPlayer);
        this.ownTile = false;
        this.waitUntil = -1;
        this.state = 'bank_walk';
        this.lastXp = 0;
        this.lastOre = 0;
        this.workFailTicks = 0;
        this.done = false;
        this.useAnvil = false;
        this.consecutiveAnvilFails = 0;
        this.viaLocation = this.step.via;
        this.stuck.reset();
        this.watchdog.reset();
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private _shouldUseAnvilMode(player: Player): boolean {
        // port: the step says which: a smelting step (at a furnace, consuming ores) never works at an anvil, a
        // smithing step (at the anvil, consuming bars) always does. Upstream switched a smelting step to the anvil
        // a quarter of the time when the bot had bars: it went to the furnace's tile, found no anvil there and stood
        // until its watchdog moved it to the same tile (test/sim.mjs --scenario=aged)
        if (this.step.action !== 'smith') return false;
        const level = getBaseLevel(player, PlayerStat.SMITHING);

        if (level < ANVIL_MIN_LEVEL) {
            return false;
        }

        if (!hasItem(player, Items.HAMMER) && countItemInBank(player, Items.HAMMER) === 0) {
            this.debug(player, 'No hammer; using furnace mode');
            return false;
        }

        if (this.consecutiveAnvilFails >= 3) {
            this.debug(player, 'Too many anvil fails; using furnace mode');
            return false;
        }

        const hasBars = this._hasBarsInBankOrInv(player);
        if (!hasBars) {
            return false;
        }

        return true;
    }

    private _findWorkLocation(player: Player): Loc | null {
        if (this.useAnvil) {
            const anvil = findLocByName(player.x, player.z, player.level, 'anvil', 2);
            if (anvil) {
                this.debug(player, `Found anvil at ${anvil.x}, ${anvil.z}`);
                return anvil;
            }
            return null;
        }

        const furnace = findLocByPrefix(player.x, player.z, player.level, 'furnace', 15);
        if (furnace) {
            this.debug(player, `Found furnace at ${furnace.x}, ${furnace.z}`);
            return furnace;
        }

        return null;
    }

    private _getItemSlot(player: Player, itemId: number): number | null {
        const inv = player.getInventory(InvType.INV);
        if (!inv) {
            return null;
        }

        for (let i = 0; i < inv.capacity; i++) {
            if (inv.get(i)?.id === itemId) return i;
        }

        return null;
    }

    private _hasOresInBankOrInv(player: Player): boolean {
        const bid = bankInvId();
        if (bid !== -1) {
            const bank = player.getInventory(bid);
            if (bank) {
                for (let i = 0; i < bank.capacity; i++) {
                    const item = bank.get(i);
                    if (!item) continue;
                    if (item.id === Items.COPPER_ORE || item.id === Items.TIN_ORE || item.id === Items.IRON_ORE || item.id === Items.COAL || item.id === Items.GOLD_ORE) {
                        return true;
                    }
                }
            }
        }

        return countItem(player, Items.COPPER_ORE) > 0 || countItem(player, Items.TIN_ORE) > 0 || countItem(player, Items.IRON_ORE) > 0 || countItem(player, Items.COAL) > 0 || countItem(player, Items.GOLD_ORE) > 0;
    }

    private _hasBarsInBankOrInv(player: Player): boolean {
        const bid = bankInvId();
        if (bid !== -1) {
            const bank = player.getInventory(bid);
            if (bank) {
                for (let i = 0; i < bank.capacity; i++) {
                    const item = bank.get(i);
                    if (!item) continue;
                    if (SMITH_BARS.includes(item.id)) {
                        return true;
                    }
                }
            }
        }

        return SMITH_BARS.some(id => countItem(player, id) > 0);
    }

    private _hasOresInInventory(player: Player): boolean {
        return countItem(player, Items.COPPER_ORE) > 0 || countItem(player, Items.TIN_ORE) > 0 || countItem(player, Items.IRON_ORE) > 0 || countItem(player, Items.COAL) > 0 || countItem(player, Items.GOLD_ORE) > 0;
    }

    /** port: the bars one of the step's products takes (a platebody: 5) */
    private _barsPerItem(): number {
        return Number((this.step.extra as { barCount?: number } | undefined)?.barCount ?? 1);
    }

    /** port: clicks "make 10" on the step's product in the open smithing interface (its column's inventory); false when it is not open */
    private _pressAnvilProduct(player: Player): boolean {
        const product = this.step.itemGained;
        return product !== undefined && pressInterfaceProduct(player, product, 3);
    }

    private _hasBarsInInventory(player: Player): boolean {
        this.debug(player, `Checking bars in inventory: bronze=${countItem(player, Items.BRONZE_BAR)}, iron=${countItem(player, Items.IRON_BAR)}, steel=${countItem(player, Items.STEEL_BAR)}, gold=${countItem(player, Items.GOLD_BAR)}`);
        return countItem(player, Items.BRONZE_BAR) > 0 || countItem(player, Items.IRON_BAR) > 0 || countItem(player, Items.STEEL_BAR) > 0 || countItem(player, Items.GOLD_BAR) > 0;
    }

    /** port: the ores one bar of the current step takes ([ore, count]), or null when the step is not a smelt step. */
    private _recipe(): [number, number][] | null {
        if (this.step.action !== 'smelt' || this.step.itemConsumed === undefined) return null;
        const recipe: [number, number][] = [[this.step.itemConsumed, 1]];
        const also = this.step.extra?.alsoConsumes;
        if (typeof also === 'number') {
            const count = this.step.extra?.alsoConsumesCount;
            recipe.push([also, typeof count === 'number' ? count : 1]);
        }
        return recipe;
    }

    /** port: is there a whole bar's worth of the step's ores in the inventory? */
    private _canSmelt(player: Player): boolean {
        return (this._recipe() ?? []).every(([id, count]) => countItem(player, id) >= count);
    }

    private _withdrawOres(player: Player): boolean {
        const bid = bankInvId();
        if (bid === -1) return false;

        const bank = player.getInventory(bid);
        const inv = player.getInventory(InvType.INV);
        if (!bank || !inv) return false;

        // port: the step's ores in its proportions (copper and tin alike, iron and twice the coal), as many bars as
        // the bank and the free slots allow. Upstream took up to 28 of each ore in turn: copper filled the inventory,
        // tin found no room, and the bot smelted what pairs it had and then stood at the furnace with copper alone.
        const recipe = this._recipe();
        if (recipe) {
            const inBank = (id: number): number => {
                let n = 0;
                for (let i = 0; i < bank.capacity; i++) {
                    const it = bank.get(i);
                    if (it?.id === id) n += it.count;
                }
                return n;
            };
            const perBar = recipe.reduce((n, [, count]) => n + count, 0);
            const bars = Math.min(Math.floor(inv.freeSlotCount / perBar), ...recipe.map(([id, count]) => Math.floor(inBank(id) / count)));
            for (const [id, count] of recipe) {
                if (bars > 0) moveItems(bank, inv, id, bars * count);
            }
            this.debug(player, `Withdrew ores for ${bars} bars`);
            return this._canSmelt(player);
        }

        let withdrawn = false;

        const oreItemIds = [Items.COPPER_ORE, Items.TIN_ORE, Items.IRON_ORE, Items.COAL, Items.GOLD_ORE];
        for (const oreId of oreItemIds) {
            for (let i = 0; i < bank.capacity; i++) {
                const item = bank.get(i);
                if (!item || item.id !== oreId) continue;

                const toWithdraw = Math.min(item.count, 28);
                const moved = moveItems(bank, inv, oreId, toWithdraw);
                if (moved > 0) {
                    withdrawn = true;
                }
                break;
            }
        }

        const invOres = countItem(player, Items.COPPER_ORE) + countItem(player, Items.TIN_ORE) + countItem(player, Items.IRON_ORE) + countItem(player, Items.COAL);
        this.debug(player, `Withdrew ores: total=${invOres}`);
        return withdrawn || invOres > 0;
    }

    private _withdrawBars(player: Player): boolean {
        const bid = bankInvId();
        if (bid === -1) return false;

        const bank = player.getInventory(bid);
        const inv = player.getInventory(InvType.INV);
        if (!bank || !inv) return false;

        let withdrawn = false;

        const level = getBaseLevel(player, PlayerStat.SMITHING);
        let barIds: number[];

        if (level >= 48) {
            barIds = [Items.STEEL_BAR, Items.IRON_BAR, Items.BRONZE_BAR, Items.GOLD_BAR];
        } else if (level >= 40) {
            barIds = [Items.GOLD_BAR, Items.IRON_BAR, Items.BRONZE_BAR];
        } else if (level >= 33) {
            barIds = [Items.IRON_BAR, Items.BRONZE_BAR];
        } else {
            barIds = [Items.BRONZE_BAR];
        }

        // port: the step's own bars (the anvil step uses them): upstream took the best bars the level allowed, and
        // with steel or gold bars in the bank an iron-bar step found none of its bars in the pack and went back to
        // the bank, again and again
        if (this.step.action === 'smith' && this.step.itemConsumed) barIds = [this.step.itemConsumed];
        // and the hammer, if another task banked it
        if (!hasItem(player, Items.HAMMER)) moveItems(bank, inv, Items.HAMMER, 1);

        // port (the variety work, round 1, track F: DO-2): the bars one product takes (a platebody 5), counting the pack's
        // and the bank's together; the step needs one product's worth in the pack after, else it is done. It withdrew only
        // when the bank alone held 5 and went to the anvil with any bar at all: 1-4 leftover bars walked bank to anvil and
        // back for good (frodo_99 at Varrock West: 15 rounds, no XP)
        const barsNeeded = this._barsPerItem();

        for (const barId of barIds) {
            const bankCount = countItemInBank(player, barId);
            if (bankCount > 0 && bankCount + countItem(player, barId) >= barsNeeded) {
                const moved = moveItems(bank, inv, barId, Math.min(bankCount, 28));
                if (moved > 0) withdrawn = true;
                break;
            }
        }

        const invBars = barIds.reduce((n, id) => Math.max(n, countItem(player, id)), 0); // port: of the bars this step uses
        this.debug(player, `Withdrew bars: ${withdrawn ? 'some' : 'none'}, the most of one kind=${invBars}`);
        return invBars >= barsNeeded && hasItem(player, Items.HAMMER);
    }

    private _depositResults(player: Player): void {
        const bid = bankInvId();
        if (bid === -1) return;

        const bank = player.getInventory(bid);
        const inv = player.getInventory(InvType.INV);
        if (!bank || !inv) return;

        // port: at a furnace, the bars and every ore go to the bank too (_withdrawOres takes the step's ores again,
        // in proportion); bars kept in the inventory took the room the next load of ore needed
        const itemsToKeep: Set<number> = !this.useAnvil && this._recipe()
            ? new Set([Items.COINS, Items.HAMMER])
            : new Set([Items.COPPER_ORE, Items.TIN_ORE, Items.IRON_ORE, Items.COAL, Items.GOLD_ORE, ...SMITH_BARS, Items.COINS, Items.HAMMER]);

        let deposited = 0;

        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item) continue;
            if (itemsToKeep.has(item.id)) continue;

            const moved = inv.remove(item.id, item.count);
            if (moved > 0) {
                bank.add(bankedId(item.id), moved);
                deposited += moved;
            }
        }

        this.debug(player, `Deposit results complete; deposited=${deposited}`);
    }

    private _stuckWalk(player: Player, lx: number, lz: number): void {
        if (!this.stuck.check(player, lx, lz)) {
            this.debug(player, `Walking to target ${lx}, ${lz}`);
            walkTo(player, lx, lz);
            return;
        }

        if (this.stuck.desperatelyStuck) {
            this.debug(player, `Desperately stuck; teleporting near ${lx}, ${lz}`);
            teleportNear(player, lx, lz);
            this.stuck.reset();
            return;
        }

        if (openNearbyGate(player, 8)) {
            this.debug(player, 'Opened nearby gate/curtain while stuck');
            return;
        }

        const wx = player.x + randInt(-10, 10);
        const wz = player.z + randInt(-10, 10);
        this.debug(player, `Stuck fallback walk to ${wx}, ${wz}`);
        player.clearWaypoints();
        walkTo(player, wx, wz);
    }
}

function countItemInBank(player: Player, itemId: number): number {
    const bid = bankInvId();
    if (bid === -1) return 0;

    const bank = player.getInventory(bid);
    if (!bank) return 0;

    let count = 0;
    for (let i = 0; i < bank.capacity; i++) {
        const item = bank.get(i);
        if (item?.id === itemId) count += item.count;
    }
    return count;
}
