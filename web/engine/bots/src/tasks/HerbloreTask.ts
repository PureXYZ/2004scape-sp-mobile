/**
 * HerbloreTask.ts
 *
 * Makes attack potions from scratch in a four-phase supply run:
 *   1. Buy empty vials  — Jatix's herb shop, Taverley
 *   2. Buy eye of newt  — Jatix's too
 *   3. Fill vials       — Fountain near Falador west bank  (one at a time)
 *   4. Mix at bank      — withdraw guams → mix unf → mix attack potions
 *
 * port: walked, between Taverley and Falador (walking). Upstream jumped between Aemad's in East
 * Ardougne, the fountain and Betty's in Port Sarim (12 jumps in a 2,500-tick coverage run); 274's Jatix sells both
 * the vials and the eye of newt, a short walk from Falador.
 *
 * Brew mechanics
 * ──────────────
 * Unfinished guam:  [opheldu,vial_water] triggers attempt_brew_potion.
 *                   No XP awarded.
 * Attack potion:    [opheldu,guamvial]   triggers attempt_brew_potion.
 *                   25 XP (250 internal) per successful brew.
 *
 * Both mixing steps fall back to direct inventory simulation when the
 * server script doesn't run (map_members=false or similar).
 *
 * port: no fallbacks: the game's own scripts fill, clean and mix (they check the world and the Herblore level and give
 * the XP); what the bot can't do it banks and the task ends. Upstream filled, cleaned and mixed by itself when a script
 * didn't (an XP-giving potion at any level). The coins come from the bank first ('coins_walk'), as ShopTrip's do
 */

import {
    BotTask,
    Player,
    InvType,
    walkTo,
    interactNpcOp,
    findNpcByName,
    findNpcByPrefix,
    findLocByName,
    findLocByPrefix,
    countItem,
    addItem,
    removeItem,
    getBaseLevel,
    PlayerStat,
    Items,
    Locations,
    isNear,
    bankInvId,
    StuckDetector,
    ProgressWatchdog,
    advanceBankWalk,
    teleportNear,
    openNearbyGate,
    randInt,
    findLocByPrefixWhere,
} from '#/engine/bot/tasks/BotTaskBase.js';
import { bankStop } from '#/engine/bot/port/BotHabits.js';
import type { SkillStep } from '#/engine/bot/BotKnowledge.js';
import { GRIMY_HERB_MAP } from '#/engine/bot/BotKnowledge.js';
import { interactHeldOp, interactHeldOpU, interactUseLocOp } from '#/engine/bot/BotAction.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { isWaterSource } from '#/engine/bot/port/BotContent.js';
import { moveItems, bankedId } from '#/engine/bot/port/BotInventoryCompat.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum vials (and guams, and newts) processed per cycle. */
const BATCH_MAX = 9;

/** Minimum guams in bank + inventory to start the task. */
const MIN_GUAMS = 5;

/** Minimum coins needed for one full batch. */
const MIN_COINS = BATCH_MAX * (2 + 3); // 9 × (vial 2gp + newt 3gp) = 45

/** Ticks to wait after interacting with a shop NPC before buying. */
const SHOP_WAIT_TICKS = 3;

/** Ticks to wait after calling a brew/fill interaction before checking result. */
const BREW_WAIT_TICKS = 2;

/** After this many failed brew attempts per item, simulate manually. */
const BREW_FAIL_LIMIT = 3;

// Mappings based on the primary herb (step.itemConsumed)
const POTION_RECIPES: Record<number, { unf: number, secondary: number, finished: number, secondaryCost: number }> = {
    [Items.CLEAN_GUAM]:        { unf: Items.UNFINISHED_GUAM,        secondary: Items.EYE_OF_NEWT,       finished: Items.ATTACK_POTION_3,     secondaryCost: 3 },
    [Items.CLEAN_MARRENTILL]:  { unf: Items.UNFINISHED_MARRENTILL,  secondary: Items.UNICORN_HORN_DUST, finished: Items.ANTIPOISON_POTION_3, secondaryCost: 0 }, // no shop
    [Items.CLEAN_TARROMIN]:    { unf: Items.UNFINISHED_TARROMIN,    secondary: Items.LIMPWURT_ROOT,     finished: Items.STRENGTH_POTION_3,   secondaryCost: 0 }, // no shop
    [Items.CLEAN_HARRALANDER]: { unf: Items.UNFINISHED_HARRALANDER, secondary: Items.RED_SPIDERS_EGGS,  finished: Items.RESTORE_POTION_3,    secondaryCost: 0 }, // no shop
    [Items.CLEAN_RANARR]:      { unf: Items.UNFINISHED_RANARR,      secondary: Items.SNAPE_GRASS,       finished: Items.PRAYER_POTION_3,     secondaryCost: 0 }  // no shop
};

type HerbloreState =
    | 'buy_vials'    // walk to Taverley + find Jatix + trade + buy empty vials
    | 'fill_vials'   // walk to Falador fountain + fill all empty vials
    | 'buy_newt'     // Jatix again: eye of newt (only for guam)
    | 'bank_walk'    // advance to nearest bank
    | 'withdraw'     // withdraw herbs and secondaries
    | 'clean_herbs'  // clean grimy herbs before mixing
    | 'mix_unf'      // mix vial_of_water + clean_herb → unfinished potion (loop)
    | 'mix_pot'      // mix unfinished_potion + secondary → finished potion (loop)
    | 'deposit'      // bank all potions, reset cycle
    | 'coins_walk'   // port: to the bank for the cycle's coins
    | 'coins_withdraw';

// ── Shop sub-phase index (buy_vials / buy_newt states) ────────────────────────
// 0 = walk to the shop, 1 = find NPC + open trade, 2 = wait for shop UI, 3 = buy items
type ShopPhase = 0 | 1 | 2 | 3;

export class HerbloreTask extends BotTask {
    private readonly step: SkillStep;

    private state: HerbloreState = 'buy_vials';
    private shopPhase: ShopPhase = 0;
    private shopWaitTicks = 0;
    private brewFailCount = 0;
    /** port: coins were fetched this cycle (if the bank had too few, the bot shops with what it has) */
    private coinsFetched = false;
    /** port: refused fills in a row (the bot was busy); the task ends after 10 */
    private fillFails = 0;

    private readonly stuck = new StuckDetector(30, 4, 2);
    private readonly watchdog = new ProgressWatchdog(400);

    constructor(step: SkillStep) {
        super('Herblore');
        this.step = step;
        this.watchdog.follow(() => this.step.location);
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override activityStep(): SkillStep | null {
        return this.step;
    }

    shouldRun(player: Player): boolean {
        const level = getBaseLevel(player, PlayerStat.HERBLORE);
        if (level < 1) return false;
        // port: the step's level (the game refuses the herb and the potion below it)
        if (level < this.step.minLevel) return false;
        // port: the herbs and coins below are for starting a cycle; one under way is finished (upstream's check ran
        // mid-batch: the herbs it mixed took it under MIN_GUAMS and the batch's last few were left in the pack)
        if (this.state !== 'buy_vials' || this.shopPhase !== 0) return true;

        // Need guams available (bank or inventory)
        const recipe = POTION_RECIPES[this.step.itemConsumed!];
        if (!recipe) return false;

        // Need herbs available (bank or inventory) - check both clean and grimy
        let herbCount = this._totalItem(player, this.step.itemConsumed!); // clean
        // We can find the grimy herb from GRIMY_HERB_MAP
        const grimyHerbId = Object.keys(GRIMY_HERB_MAP).find(
            key => GRIMY_HERB_MAP[Number(key)][0] === this.step.itemConsumed
        );
        if (grimyHerbId) {
            herbCount += this._totalItem(player, Number(grimyHerbId));
        }

        if (herbCount < MIN_GUAMS) return false;

        // Need coins for at least one batch
        const coins = this._totalCoins(player);
        const recipeCost = 2 + recipe.secondaryCost;
        if (recipeCost > 0 && coins < BATCH_MAX * recipeCost) return false;

        return true;
    }

    isComplete(_player: Player): boolean {
        return false;
    }

    reset(): void {
        super.reset();
        this.state = 'buy_vials';
        this.shopPhase = 0;
        this.shopWaitTicks = 0;
        this.brewFailCount = 0;
        this.coinsFetched = false;
        this.fillFails = 0;
        this.stuck.reset();
        this.watchdog.reset();
    }

    // ── Tick ──────────────────────────────────────────────────────────────────

    tick(player: Player): void {
        if (this.interrupted) return;

        const banking = this.state === 'bank_walk' || this.state === 'coins_walk';
        if (this.watchdog.check(player, banking)) {
            player.clearWaypoints();
            player.clearPendingAction();
            this.stuck.reset();
            return;
        }

        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }

        this._tick(player);
    }

    private _tick(player: Player): void {
        switch (this.state) {

            // ── 1. Buy vials from Aemad (East Ardougne) ─────────────────────
            case 'buy_vials': {
                // Skip if we already have enough vials (or water) for a full batch
                const haveVials = countItem(player, Items.VIAL_EMPTY) + countItem(player, Items.VIAL_OF_WATER);
                if (haveVials >= BATCH_MAX) {
                    this._log(player, 'already have vials, skipping buy');
                    this.state = 'buy_newt';
                    this.shopPhase = 0;
                    return;
                }

                // port: the cycle's coins from the bank first (upstream counted banked coins in shouldRun, then shopped
                // with the pack's, bought nothing and went round again)
                if (!this.coinsFetched && this.shopPhase === 0 && countItem(player, Items.COINS) < this._cycleCost()) {
                    this.coinsFetched = true;
                    this.state = 'coins_walk';
                    return;
                }

                this._runShopPhase(
                    player,
                    Locations.TAVERLEY_HERBS,
                    'jatix',
                    Items.VIAL_EMPTY,
                    2, // cost per vial
                    'buy_newt'
                );
                return;
            }

            // ── 2. Fill vials at Falador fountain ────────────────────────────
            case 'fill_vials': {
                // Done if no empty vials remain
                const emptyCount = countItem(player, Items.VIAL_EMPTY);
                if (emptyCount === 0) {
                    this._log(player, 'all vials filled → bank');
                    this.state = 'bank_walk';
                    this.shopPhase = 0;
                    return;
                }

                this._doFillVials(player);
                return;
            }

            // ── 2. Buy eye of newt from Jatix (Taverley) ─────────────────────
            case 'buy_newt': {
                const recipe = POTION_RECIPES[this.step.itemConsumed!];
                if (recipe.secondaryCost === 0) {
                    this._log(player, 'secondary not bought from shop, skipping buy');
                    this.state = 'fill_vials';
                    this.shopPhase = 0;
                    return;
                }

                // Skip if we already have enough secondaries
                if (countItem(player, recipe.secondary) >= BATCH_MAX) {
                    this._log(player, 'already have secondaries, skipping buy');
                    this.state = 'fill_vials';
                    this.shopPhase = 0;
                    return;
                }

                // One newt per vial (empty or filled)
                const newtNeeded = countItem(player, Items.VIAL_EMPTY) + countItem(player, Items.VIAL_OF_WATER);
                if (newtNeeded === 0) {
                    // No vials — something went wrong, restart cycle
                    this._log(player, 'no vials → restart cycle');
                    this.state = 'buy_vials';
                    this.shopPhase = 0;
                    return;
                }

                this._runShopPhase(
                    player,
                    Locations.TAVERLEY_HERBS,
                    'jatix',
                    recipe.secondary,
                    recipe.secondaryCost, // cost per secondary
                    'fill_vials'
                );
                return;
            }

            case 'bank_walk': {
                const result = advanceBankWalk(player, this.stuck);
                if (result === 'walk') return;
                this.cooldown = result === 'ready' ? bankStop(player) : 0; // port (the realism work): a person's stop (port/BotHabits)
                this.state = 'withdraw';
                return;
            }

            case 'coins_walk': {
                const result = advanceBankWalk(player, this.stuck);
                if (result === 'walk') return;
                this.cooldown = result === 'ready' ? bankStop(player) : 0; // port (the realism work): a person's stop (port/BotHabits)
                this.state = 'coins_withdraw';
                return;
            }

            case 'coins_withdraw': {
                const bid = bankInvId();
                const bank = bid === -1 ? null : player.getInventory(bid);
                const inv = player.getInventory(InvType.INV);
                const short = this._cycleCost() - countItem(player, Items.COINS);
                if (bank && inv && short > 0) moveItems(bank, inv, Items.COINS, short);
                this.stuck.reset();
                this.state = 'buy_vials';
                return;
            }

            // ── 5. Withdraw guams equal to number of vials of water ───────────
            case 'withdraw': {
                const recipe = POTION_RECIPES[this.step.itemConsumed!];
                const vialWater = countItem(player, Items.VIAL_OF_WATER);

                // If secondary is not shop-bought, we need to withdraw it
                if (recipe.secondaryCost === 0) {
                    const secondaryInBank = this._totalItem(player, recipe.secondary) - countItem(player, recipe.secondary);
                    const toWithdrawSecondary = Math.min(vialWater - countItem(player, recipe.secondary), secondaryInBank);
                    if (toWithdrawSecondary > 0) {
                        this._withdrawItems(player, recipe.secondary, toWithdrawSecondary);
                    }
                }

                const secondaryCount = countItem(player, recipe.secondary);
                // How many complete potions can we make?
                const pairs = Math.min(vialWater, secondaryCount);
                if (pairs === 0) {
                    // Nothing to mix — restart supply run
                    this._log(player, 'no mixing pairs available → restart');
                    this._depositAll(player);
                    this.state = 'buy_vials';
                    this.shopPhase = 0;
                    return;
                }

                // Withdraw clean or grimy herbs
                let withdrawn = this._withdrawItems(player, this.step.itemConsumed!, pairs);
                if (!withdrawn) {
                    const grimyHerbId = Object.keys(GRIMY_HERB_MAP).find(
                        key => GRIMY_HERB_MAP[Number(key)][0] === this.step.itemConsumed
                    );
                    if (grimyHerbId) {
                        withdrawn = this._withdrawItems(player, Number(grimyHerbId), pairs);
                    }
                }

                if (!withdrawn) {
                    this._log(player, 'no herbs in bank → interrupt');
                    this.interrupt();
                    return;
                }
                this.brewFailCount = 0;
                this.state = 'clean_herbs';
                this.cooldown = 1;
                return;
            }

            case 'clean_herbs': {
                const inv = player.getInventory(InvType.INV);
                if (!inv) return;

                // Find a grimy herb in inventory
                let grimySlot = -1;
                let grimyId = -1;
                for (let i = 0; i < inv.capacity; i++) {
                    const item = inv.get(i);
                    if (item && GRIMY_HERB_MAP[item.id]) {
                        grimySlot = i;
                        grimyId = item.id;
                        break;
                    }
                }

                if (grimySlot === -1) {
                    // All herbs clean → proceed
                    this.state = 'mix_unf';
                    return;
                }

                const prevClean = countItem(player, GRIMY_HERB_MAP[grimyId][0]);
                // Send op1 (clean)
                const ok = interactHeldOp(player, inv, grimyId, grimySlot, 1);
                const newClean = countItem(player, GRIMY_HERB_MAP[grimyId][0]);

                if (ok && newClean > prevClean) {
                    this.watchdog.notifyActivity();
                    this.brewFailCount = 0;
                    this.cooldown = 1;
                } else {
                    this.brewFailCount++;
                    if (this.brewFailCount >= BREW_FAIL_LIMIT) {
                        // port: the game won't clean them here (no manual cleaning): banked, and the potions made of
                        // the clean ones
                        this._log(player, 'clean failed, banking the grimy herbs');
                        this._depositId(player, grimyId);
                        this.brewFailCount = 0;
                    }
                    this.cooldown = 1;
                }
                return;
            }

            // ── 6. Mix unfinished guam potions ───────────────────────────────
            // interactHeldOpU fires [opheldu,vial_water] which calls executeScript
            // synchronously, so the inventory update happens on the same tick.
            // We check the result immediately and only fall back manually on repeated
            // failures (e.g. map_members=false blocks the server script).
            case 'mix_unf': {
                const vialSlot = this._findSlot(player, Items.VIAL_OF_WATER);
                const herbSlot = this._findSlot(player, this.step.itemConsumed!);

                if (vialSlot === -1 || herbSlot === -1) {
                    // All unfinished potions mixed → proceed to add secondaries
                    this._log(player, 'unf mix done → mix_pot');
                    this.brewFailCount = 0;
                    this.state = 'mix_pot';
                    return;
                }

                const inv = player.getInventory(InvType.INV);
                if (!inv) return;

                const recipe = POTION_RECIPES[this.step.itemConsumed!];
                const prevUnf = countItem(player, recipe.unf);
                const ok = interactHeldOpU(player, inv,
                    Items.VIAL_OF_WATER, vialSlot,
                    this.step.itemConsumed!,    herbSlot
                );
                const newUnf = countItem(player, recipe.unf);

                if (ok && newUnf > prevUnf) {
                    // Brew succeeded
                    this.watchdog.notifyActivity();
                    this.brewFailCount = 0;
                    this.cooldown = 1; // brief delay between successive brews
                } else {
                    // Script blocked (members check / delayed / wrong items)
                    this.brewFailCount++;
                    if (this.brewFailCount >= BREW_FAIL_LIMIT) {
                        this._log(player, 'unf brew failed, giving up');
                        this._giveUp(player, true);
                    }
                    this.cooldown = 1;
                }
                return;
            }

            // ── 7. Mix attack potions ────────────────────────────────────────
            // interactHeldOpU fires [opheldu,guamvial] → synchronous execute.
            // ── 7. Mix finished potions ────────────────────────────────────────
            case 'mix_pot': {
                const recipe = POTION_RECIPES[this.step.itemConsumed!];
                const unfSlot  = this._findSlot(player, recipe.unf);
                const newtSlot = this._findSlot(player, recipe.secondary);

                if (unfSlot === -1 || newtSlot === -1) {
                    // All potions mixed → deposit and start next cycle
                    this._log(player, 'potion mix done → deposit');
                    this.state = 'deposit';
                    return;
                }

                const inv = player.getInventory(InvType.INV);
                if (!inv) return;

                const prevPot = countItem(player, recipe.finished);
                const ok = interactHeldOpU(player, inv,
                    recipe.unf, unfSlot,
                    recipe.secondary,     newtSlot
                );
                const newPot = countItem(player, recipe.finished);

                if (ok && newPot > prevPot) {
                    this.watchdog.notifyActivity();
                    this.brewFailCount = 0;
                    this.cooldown = 1;
                } else {
                    this.brewFailCount++;
                    if (this.brewFailCount >= BREW_FAIL_LIMIT) {
                        this._log(player, 'potion brew failed, giving up');
                        this._giveUp(player, true);
                    }
                    this.cooldown = 1;
                }
                return;
            }

            // ── 8. Deposit attack potions and any leftover vials ─────────────
            case 'deposit': {
                this._depositAll(player);
                this._log(player, 'cycle complete → buy_vials');
                this.state = 'buy_vials';
                this.shopPhase = 0;
                this.coinsFetched = false;
                this.cooldown = 2;
                return;
            }
        }
    }

    // ── Shop helper (shared by buy_vials and buy_newt) ────────────────────────

    /**
     * Drives a four-phase shop visit:
     *   Phase 0 — walk to the shop (port: upstream teleJumped)
     *   Phase 1 — find NPC by name, then call interactNpcOp op3 (Trade)
     *   Phase 2 — wait SHOP_WAIT_TICKS for shop UI to open
     *   Phase 3 — buy items via direct inventory simulation
     */
    private _runShopPhase(
        player: Player,
        location: [number, number, number],
        npcName: string,
        itemId: number,
        costEach: number,
        nextState: HerbloreState
    ): void {
        const [sx, sz, sl] = location;

        switch (this.shopPhase) {
            case 0: {
                // port: walked there (upstream jumped)
                if (isNear(player, sx, sz, 10, sl)) {
                    this.shopPhase = 1;
                    this.cooldown = 2;
                    return;
                }
                this._walk(player, sx, sz, sl);
                return;
            }
            case 1: {
                // Find shop NPC
                const npc = findNpcByName(player.x, player.z, player.level, npcName, 15)
                    ?? findNpcByPrefix(player.x, player.z, player.level, npcName, 15);
                if (!npc) {
                    // NPC not found yet — wait a tick (might still be loading after teleport)
                    this.shopWaitTicks++;
                    if (this.shopWaitTicks >= 10) {
                        // Give up and walk again
                        this._log(player, `NPC '${npcName}' not found after 10 ticks; walking again`);
                        this.shopPhase = 0;
                        this.shopWaitTicks = 0;
                    }
                    return;
                }
                // NPC found — reset tick counter so phase 2 wait starts fresh
                this.shopWaitTicks = 0;
                interactNpcOp(player, npc, 3); // op3 = Trade on all shops
                this.shopPhase = 2;
                this.cooldown = 1;
                return;
            }
            case 2: {
                // Waiting for shop UI to open
                this.shopWaitTicks++;
                if (this.shopWaitTicks >= SHOP_WAIT_TICKS) {
                    this.shopPhase = 3;
                    this.shopWaitTicks = 0;
                }
                return;
            }
            case 3: {
                // Buy items (direct inventory simulation, same as ShopTripTask)
                const qty = this._buyFromShop(player, itemId, costEach);
                this._log(player, `bought ${qty}× item #${itemId}`);
                if (qty === 0 && countItem(player, itemId) === 0) {
                    // port: no coins for any (upstream went round the cycle again, buying nothing)
                    this._giveUp(player);
                    return;
                }
                this.shopPhase = 0;
                this.state = nextState as HerbloreState;
                this.cooldown = 1;
                return;
            }
        }
    }

    // ── Fill vials at fountain ────────────────────────────────────────────────

    private _doFillVials(player: Player): void {
        // port: walked to the Falador fountain (upstream jumped)
        const [fx, fz, fl] = Locations.FALADOR_FOUNTAIN;
        if (!isNear(player, fx, fz, 25, fl)) {
            this._walk(player, fx, fz, fl);
            return;
        }

        // Find a watersource loc nearby
        const fountain =
            findLocByName(player.x, player.z, player.level, 'fountain', 30)
            ?? findLocByPrefix(player.x, player.z, player.level, 'fountain', 30)
            ?? findLocByPrefixWhere(player.x, player.z, player.level, '', 30, isWaterSource); // port: no 'pump' in 274: any water source

        if (!fountain) {
            this._log(player, 'no watersource found near Falador, giving up');
            this._giveUp(player);
            return;
        }

        // Walk adjacent to the fountain if needed
        if (!isNear(player, fountain.x, fountain.z, 1)) {
            walkTo(player, fountain.x, fountain.z);
            return;
        }

        // Use one vial_empty on the fountain
        const vialSlot = this._findSlot(player, Items.VIAL_EMPTY);
        if (vialSlot === -1) {
            // All filled
            this.state = 'buy_newt';
            this.shopPhase = 0;
            return;
        }

        const prevWater = countItem(player, Items.VIAL_OF_WATER);
        const ok = interactUseLocOp(player, fountain, Items.VIAL_EMPTY, vialSlot);

        if (ok) {
            this.fillFails = 0;
            // (the variety work, round 2, Track D2: a person's varied moment between vials, now and then a look about; a
            // fixed 2 ticks came round like a metronome once herblore ran: H18 Herblore 18-51 %)
            this.cooldown = BREW_WAIT_TICKS + randInt(0, 3) + (Math.random() < 0.15 ? randInt(3, 8) : 0);
            // Check immediately in case server processes synchronously
            if (countItem(player, Items.VIAL_OF_WATER) > prevWater) {
                this.watchdog.notifyActivity();
            }
        } else if (++this.fillFails >= 10) {
            // Interaction blocked (delayed, wrong item, etc.) — simulate manually
            // port: tried again next tick (it is refused while the last fill's delay runs); the task ends after 10
            this._log(player, 'fill interaction failed, giving up');
            this._giveUp(player);
        }
    }

    /** port: a walk with the stuck detector (as the gathering tasks walk): a gate opened, a step aside, an unseen rescue */
    private _walk(player: Player, x: number, z: number, level = 0): void {
        if (!this.stuck.check(player, x, z)) {
            walkTo(player, x, z, level);
            return;
        }
        if (this.stuck.desperatelyStuck) {
            teleportNear(player, x, z, level);
            this.stuck.reset();
            return;
        }
        if (openNearbyGate(player, 5)) return;
        walkTo(player, player.x + randInt(-8, 8), player.z + randInt(-8, 8), level);
    }

    // ── Bank helpers ──────────────────────────────────────────────────────────

    private _withdrawItems(player: Player, itemId: number, count: number): boolean {
        const bid = bankInvId();
        if (bid === -1) return false;

        const bank = player.getInventory(bid);
        const inv  = player.getInventory(InvType.INV);
        if (!bank || !inv) return false;

        for (let i = 0; i < bank.capacity; i++) {
            const item = bank.get(i);
            if (!item || item.id !== itemId) continue;

            // Free slots in inventory
            let freeSlots = 0;
            for (let j = 0; j < inv.capacity; j++) {
                if (inv.get(j) === null) freeSlots++;
            }

            const toTake = Math.min(count, item.count, freeSlots);
            if (toTake <= 0) break;

            const removed = moveItems(bank, inv, itemId, toTake);
            if (removed > 0) {
                return true;
            }
        }
        return false;
    }

    private _depositAll(player: Player): void {
        const bid = bankInvId();
        if (bid === -1) return;

        const bank = player.getInventory(bid);
        const inv  = player.getInventory(InvType.INV);
        if (!bank || !inv) return;

        // Keep coins; deposit everything else
        const keepIds = new Set<number>([Items.COINS]);

        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item || keepIds.has(item.id)) continue;
            const moved = inv.remove(item.id, item.count);
            if (moved > 0) bank.add(bankedId(item.id), moved);
        }
    }

    // ── Shop buying ───────────────────────────────────────────────────────────

    /** Direct inventory simulation: spend coins, add items. Returns qty bought. */
    private _buyFromShop(player: Player, itemId: number, costEach: number): number {
        const coins = countItem(player, Items.COINS);
        const inv   = player.getInventory(InvType.INV);
        if (!inv || costEach <= 0) return 0;

        // Count free slots
        let freeSlots = 0;
        for (let j = 0; j < inv.capacity; j++) {
            if (inv.get(j) === null) freeSlots++;
        }

        const canAfford = Math.floor(coins / costEach);
        const qty = Math.min(BATCH_MAX, canAfford, freeSlots);
        if (qty <= 0) return 0;

        removeItem(player, Items.COINS, qty * costEach);
        addItem(player, itemId, qty);
        return qty;
    }

    // ── Giving up ─────────────────────────────────────────────────────────────

    /**
     * port: replaces upstream's manual fallbacks (filling, cleaning and mixing done by the bot, with the XP): any dialog
     * closed, the pack banked when the bot is at the bank (mixing), and the task ends for the planner to pick another
     */
    private _giveUp(player: Player, atBank = false): void {
        player.closeModal();
        if (atBank) this._depositAll(player);
        this.brewFailCount = 0;
        this.interrupt();
    }

    private _depositId(player: Player, itemId: number): void {
        const bid = bankInvId();
        const bank = bid === -1 ? null : player.getInventory(bid);
        const inv = player.getInventory(InvType.INV);
        if (!bank || !inv) return;
        const moved = inv.remove(itemId, countItem(player, itemId));
        if (moved > 0) bank.add(bankedId(itemId), moved);
    }

    /** port: the coins a cycle's shopping takes (vials at 2, the secondary at its price) */
    private _cycleCost(): number {
        return BATCH_MAX * (2 + POTION_RECIPES[this.step.itemConsumed!].secondaryCost);
    }

    // ── Inventory helpers ─────────────────────────────────────────────────────

    private _findSlot(player: Player, itemId: number): number {
        const inv = player.getInventory(InvType.INV);
        if (!inv) return -1;
        for (let i = 0; i < inv.capacity; i++) {
            const item = inv.get(i);
            if (item && item.id === itemId) return i;
        }
        return -1;
    }

    private _totalItem(player: Player, itemId: number): number {
        let total = countItem(player, itemId);
        const bid = bankInvId();
        if (bid === -1) return total;
        const bank = player.getInventory(bid);
        if (!bank) return total;
        for (let i = 0; i < bank.capacity; i++) {
            const it = bank.get(i);
            if (it?.id === itemId) total += it.count;
        }
        return total;
    }

    private _totalCoins(player: Player): number {
        let total = countItem(player, Items.COINS);
        const bid = bankInvId();
        if (bid === -1) return total;
        const bank = player.getInventory(bid);
        if (!bank) return total;
        for (let i = 0; i < bank.capacity; i++) {
            const it = bank.get(i);
            if (it?.id === Items.COINS) total += it.count;
        }
        return total;
    }

    private _log(player: Player, msg: string): void {
        console.log(`[HerbloreTask][${player.username}][${this.state}] ${msg}`);
    }
}
