/**
 * CraftingTask.ts
 *
 * Two-phase crafting task driven by BotGoalPlanner._findCraftingTask().
 *
 * ── Phase 1  (step.action === 'craft_wool')  ─────────────────────────────────
 *   Runs while Mining < 40 OR Smithing < 40.
 *   shear_walk → shear → climb → spin → descend → bank_walk → bank → repeat
 *                                            └→ sell → shear_walk (port: half the crafters, by name)
 *
 *   Sheep field  → Lumbridge sheep NE of castle
 *   Spinning     → teleJump to Lumbridge castle 2nd floor, use ball_wool on wheel
 *                  (port: walked up; the wheel's Spin and Make X spin the whole pack)
 *   Banking      → teleJump back to ground floor, nearest ground-floor bank
 *                  (port: walked; or the balls sold at the Lumbridge general store)
 *
 * ── Phase 2  (step.action === 'craft_ring')  ─────────────────────────────────
 *   Unlocks once Mining >= 40 AND Smithing >= 40 (gold ore pipeline active).
 *   bank_walk → withdraw → furnace_walk → craft → bank_return → repeat
 *
 *   Materials    → gold bars from bank + ring_mould in inventory
 *   Output       → gold rings deposited each banking cycle
 */

import { botContinuePage, botScript, interactHeldOpU, interactIfButtonByName, findNpcFiltered, tilesInSquare } from '#/engine/bot/BotAction.js';
import {
    BotTask,
    Player,
    InvType,
    walkTo,
    interactUseLocOp,
    botInteractUseObjNpc,
    findNpcByName,
    findLocByName,
    findLocByPrefix,
    hasItem,
    countItem,
    isNear,
    getBaseLevel,
    PlayerStat,
    Items,
    Locations,
    randInt,
    humanDelay,
    bankInvId,
    StuckDetector,
    ProgressWatchdog,
    openNearbyGate,
    teleportNear,
    advanceBankWalk,
    
    interactLocOp,
    interactNpcOp,
    pressInterfaceProduct,
    openShopStock,
    sellToOpenShop,
    hasStrayItems
} from '#/engine/bot/tasks/BotTaskBase.js';
import { bankStop } from '#/engine/bot/port/BotHabits.js';
import type { Loc } from '#/engine/bot/tasks/BotTaskBase.js';
import NpcType from '#/cache/config/NpcType.js';
import ScriptState from '#/engine/script/ScriptState.js';
import { nameIndex } from '#/engine/bot/port/BotSeed.js';
import { coinsOwned } from '#/engine/bot/BotNeeds.js';
import type { SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { moveItems, bankedId } from '#/engine/bot/port/BotInventoryCompat.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Collect this many ball_wool before heading to the spinning wheel. */
const SHEAR_BATCH = 28; // port: until the pack is full (14 spun half a pack a trip)

/** Consecutive failed interaction attempts before giving up on a state. */
const FAIL_LIMIT = 6;

/** port: ticks a Spin may go with nothing spun before the wheel is clicked again (the first takes 3 ticks, then 2 each) */
const SPIN_WAIT_TICKS = 6;

/** port: who buys the wool at the Lumbridge general store (274's debugnames: the shopkeeper and his assistant) */
const WOOL_BUYERS = ['generalshopkeeper1', 'generalassistant1'];

/** port: outside Lumbridge castle's east gate, the wool sellers' first stop from the wheel (see 'sell') */
const CASTLE_EAST_GATE: [number, number] = [3232, 3221];

/** port: the sheep pen's reach is looked at this far round the bot (the pen is 20 tiles across) */
const PEN_REACH = 20;

// ── CraftingTask ──────────────────────────────────────────────────────────────

type Phase1State = 'shear_walk' | 'shear' | 'climb' | 'spin' | 'spin_flax' | 'descend' | 'sell' | 'bank_walk' | 'bank';
type Phase2State = 'bank_walk' | 'withdraw' | 'furnace_walk' | 'craft' | 'bank_return' | 'tanning_walk' | 'tanning' | 'wait_gem' | 'wait_leather' | 'wait_ring';
/** States for the standalone flax→bow string action (BotGoalPlanner routes here once enough flax is banked). */
type SpinFlaxState = 'bank_walk' | 'withdraw' | 'spin';

/** Withdraw/spin this many flax per bank trip (leaves room to also bank the resulting bow strings). */
const FLAX_WITHDRAW_BATCH = 27;

export class CraftingTask extends BotTask {
    private readonly step: SkillStep;
    private readonly phase: 1 | 2;

    private p1State: Phase1State = 'shear_walk';
    private p2State: Phase2State = 'bank_walk';
    private spinFlaxState: SpinFlaxState = 'bank_walk';
    /** port: the wheel this batch of flax goes to (_flaxWheel) */
    private flaxWheel: [number, number, number] | null = null;

    private failTicks = 0;
    private done = false;
    private lastBallWool = 0;
    /** port: the product's count at the last look, and whether its interface's button was pressed (leather, rings) */
    private lastMade = 0;
    private pressed = false;
    /** port: interactions that opened nothing in a row; the task ends after 3 */
    private noInterface = 0;
    /** port: the item being spun, its count at the last look, and ticks since the last one spun or the click (_spinAll) */
    private spinItem = -1;
    private spinLeft = -1;
    private spinWait = 0;
    /** port: the shop trip of a crafter that sells its wool: Trade clicks, ticks since the last, the balls at the last sale */
    private sellTries = 0;
    private sellWait = 0;
    private lastSold = -1;
    private sellOut = false;
    /** port: the tiles a walk reaches from where the bot stood (packed x << 14 | z), for the sheep it shears */
    private reach: Set<number> | null = null;
    private reachAt = -1;

    private readonly stuck = new StuckDetector(30, 4, 2);
    private readonly watchdog = new ProgressWatchdog();

    constructor(step: SkillStep) {
        super('Crafting');
        this.step = step;
        this.phase = step.action === 'craft_wool' ? 1 : 2;
        this.watchdog.follow(() => this.step.location);
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override activityStep(): SkillStep | null {
        return this.step;
    }

    shouldRun(player: Player): boolean {
        const mineLevel = getBaseLevel(player, PlayerStat.MINING);
        const smithLevel = getBaseLevel(player, PlayerStat.SMITHING);
        const phase2Unlocked = mineLevel >= 40 && smithLevel >= 40;

        if (this.step.action === 'spin_flax') {
            return hasItem(player, Items.FLAX) || this._hasItemInBank(player, Items.FLAX);
        }

        if (this.phase === 1) {
            // port: no longer closed from Mining and Smithing 40: the planner sends a bot to ring crafting only when
            // it has gold bars, and with none, wool was the only crafting left to it: the planner picked it, it
            // could not run, and the bot asked again every tick (0 XP)
            // port: shears in the bank do (fetched first, 'shear_walk'), as the planner counts them (BotNeeds)
            return hasItem(player, Items.SHEARS) || this._hasItemInBank(player, Items.SHEARS);
        }

        // Phase 2 — leather and gems have their own material sources (hides from
        // combat, gems from thieving/drops) and don't depend on the gold pipeline,
        // so they're not gated behind phase2Unlocked.
        if (this.step.action.startsWith('craft_leather_')) {
            // Needle/thread may be sitting in the bank rather than inventory —
            // the 'withdraw' state pulls them out — so accept either. Requiring
            // them in-hand here would block the task from ever reaching that
            // withdraw logic (and would falsely fail shouldRun() mid-batch if
            // thread runs out between bank trips).
            const hasNeedle = hasItem(player, Items.NEEDLE) || this._hasItemInBank(player, Items.NEEDLE);
            const hasThread = hasItem(player, Items.THREAD) || this._hasItemInBank(player, Items.THREAD);
            return hasNeedle && hasThread && (hasItem(player, Items.LEATHER) || this._hasLeatherAnywhere(player) || hasItem(player, Items.COW_HIDE) || this._hasCowHideInBank(player));
        }
        if (this.step.action === 'craft_hard_leather_body') {
            const hasNeedle = hasItem(player, Items.NEEDLE) || this._hasItemInBank(player, Items.NEEDLE);
            const hasThread = hasItem(player, Items.THREAD) || this._hasItemInBank(player, Items.THREAD);
            // port: or cowhides, which the tanner makes hard leather of (3 gp each); with none, no bot ever had any
            return hasNeedle && hasThread && (hasItem(player, Items.HARD_LEATHER) || this._hasItemInBank(player, Items.HARD_LEATHER) || ((hasItem(player, Items.COW_HIDE) || this._hasCowHideInBank(player)) && coinsOwned(player) >= 3));
        }
        if (this.step.action.startsWith('cut_')) {
            // port: a chisel in the bank counts ('withdraw' takes it out), as the planner counts it (BotNeeds)
            return (hasItem(player, Items.CHISEL) || this._hasItemInBank(player, Items.CHISEL)) && (hasItem(player, this.step.itemConsumed!) || this._hasItemInBank(player, this.step.itemConsumed!));
        }

        // Gold ring crafting is the only step still tied to the gold ore pipeline.
        if (!phase2Unlocked) return false;
        // port: a mould in the bank counts ('withdraw' takes it out)
        if (!hasItem(player, Items.RING_MOULD) && !this._hasItemInBank(player, Items.RING_MOULD)) return false;
        return this._hasGoldBarsAnywhere(player);
    }

    isComplete(_player: Player): boolean {
        return this.done;
    }

    override reset(): void {
        super.reset();
        this.p1State = 'shear_walk';
        this.p2State = 'bank_walk';
        this.spinFlaxState = 'bank_walk';
        this.flaxWheel = null;
        this.failTicks = 0;
        this.done = false;
        this.lastBallWool = 0;
        this.lastMade = 0;
        this.pressed = false;
        this.noInterface = 0;
        this.spinItem = -1;
        this.spinLeft = -1;
        this.spinWait = 0;
        this.sellTries = 0;
        this.sellWait = 0;
        this.lastSold = -1;
        this.sellOut = false;
        this.reach = null;
        this.reachAt = -1;
        this.stuck.reset();
        this.watchdog.reset();
    }

    tick(player: Player): void {
        if (this.interrupted) return;

        const banking = this.step.action === 'spin_flax'
            ? this.spinFlaxState === 'bank_walk' || this.spinFlaxState === 'withdraw'
            : this.phase === 1 ? this.p1State === 'bank_walk' || this.p1State === 'bank' || this.p1State === 'sell' : this.p2State === 'bank_walk' || this.p2State === 'withdraw' || this.p2State === 'bank_return';

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

        if (this.step.action === 'spin_flax') {
            this._tickSpinFlax(player);
        } else if (this.phase === 1) {
            this._tickPhase1(player);
        } else if (this.step.action.startsWith('craft_leather_') || this.step.action === 'craft_hard_leather_body') {
            this._tickLeather(player);
        } else if (this.step.action.startsWith('cut_')) {
            this._tickGems(player);
        } else {
            // port: upstream's pottery branch (soften_clay, craft_pot) is gone: no step ever led to it, and it made
            // pots itself, with the XP, when the wheel did not

            this._tickPhase2(player);
        }
    }

    // ── Standalone flax spinning (flax → bow string) ─────────────────────────
    // Routed here directly by BotGoalPlanner._findCraftingTask once enough flax
    // is banked. Distinct from the phase-1 'spin_flax' state below, which only
    // mops up incidental flax a wool-spinning bot happens to be carrying.

    private _tickSpinFlax(player: Player): void {
        switch (this.spinFlaxState) {
            case 'bank_walk': {
                const result = advanceBankWalk(player, this.stuck);
                if (result === 'walk') return;
                this.cooldown = result === 'ready' ? bankStop(player) : 0; // port (the realism work): a person's stop (port/BotHabits)
                this.spinFlaxState = 'withdraw';
                return;
            }

            case 'withdraw': {
                const bid = bankInvId();
                const inv = player.getInventory(InvType.INV);
                const bank = bid !== -1 ? player.getInventory(bid) : null;

                if (inv && bank) {
                    // Bank bow strings spun on a previous cycle before withdrawing more flax.
                    for (let i = 0; i < inv.capacity; i++) {
                        const item = inv.get(i);
                        if (item?.id === Items.BOW_STRING) {
                            const moved = inv.remove(item.id, item.count);
                            if (moved > 0) bank.add(bankedId(item.id), moved);
                        }
                    }

                    if (!hasItem(player, Items.FLAX)) {
                        for (let i = 0; i < bank.capacity; i++) {
                            if (bank.get(i)?.id === Items.FLAX) {
                                const moved = moveItems(bank, inv, Items.FLAX, FLAX_WITHDRAW_BATCH);
                                break;
                            }
                        }
                    }
                }

                if (!hasItem(player, Items.FLAX)) {
                    // Out of flax — stop so the planner can send the bot back to
                    // FlaxPickingTask instead of looping here with nothing to spin.
                    this.done = true;
                    this.interrupt();
                    return;
                }

                this.spinFlaxState = 'spin';
                return;
            }

            case 'spin': {
                // port: the nearer wheel, Seers' (up its house's ladder: BotAction's SeersSpinning1 gateway) or Lumbridge
                // castle's (up its stairs), walked to and back down; upstream teleported from wherever the flax was
                // banked to Lumbridge castle's wheel
                const [wx, wz, wl] = this._flaxWheel(player);

                const flaxCount = countItem(player, Items.FLAX);
                if (flaxCount === 0) {
                    // Batch spun — head back down to bank the bow strings.
                    this.spinFlaxState = 'bank_walk';
                    this.flaxWheel = null;
                    return;
                }

                if (player.level !== wl || !isNear(player, wx, wz, 1, wl)) {
                    this._stuckWalk(player, wx, wz, wl);
                    return;
                }

                const wheel = findLocByName(player.x, player.z, player.level, 'spinningwheel', 20) ?? findLocByPrefix(player.x, player.z, player.level, 'spinning', 25);
                if (!wheel) {
                    this.failTicks++;
                    if (this.failTicks >= FAIL_LIMIT) {
                        this.spinFlaxState = 'bank_walk';
                        this.failTicks = 0;
                    }
                    return;
                }

                // spinning.rs2 grants the Crafting XP (stat_advance) server-side — do not also credit it here.
                if (!this._spinAll(player, wheel, Items.FLAX)) {
                    this.spinFlaxState = 'bank_walk';
                    this.failTicks = 0;
                }
                return;
            }
        }
    }

    /** port: the spinning wheel nearer the bot (chosen when a batch starts, kept until it is spun) */
    private _flaxWheel(player: Player): [number, number, number] {
        if (!this.flaxWheel) {
            const wheels = [Locations.SEERS_SPINNING_WHEEL, Locations.LUMBRIDGE_POTTERS_WHEEL];
            const dist = (w: [number, number, number]): number => Math.max(Math.abs(player.x - w[0]), Math.abs(player.z - w[1]));
            this.flaxWheel = wheels.reduce((a, b) => (dist(b) < dist(a) ? b : a));
        }
        return this.flaxWheel;
    }

    // ── Phase 1: wool spinning ────────────────────────────────────────────────

    private _tickPhase1(player: Player): void {
        switch (this.p1State) {
            // ── Walk to sheep field ───────────────────────────────────────────
            case 'shear_walk': {
                // port: the shears are in the bank: the bank trip fetches them
                if (!hasItem(player, Items.SHEARS)) {
                    this.p1State = 'bank_walk';
                    return;
                }
                const [sx, sz] = this.step.extra!['sheepLocation'] as [number, number, number];
                // port: walked (upstream teleported to the sheep from more than 7 tiles away), into the pen: near its
                // middle on the fence's other side is not there (crafters sheared through the fence: _inPen)
                if (!isNear(player, sx, sz, 7) || !this._inPen(player)) {
                    this._stuckWalk(player, sx, sz);
                    return;
                }
                this.p1State = 'shear';
                this.lastBallWool = countItem(player, Items.WOOL);
                return;
            }

            // ── Shear sheep until we have a full batch ────────────────────────
            case 'shear': {
                // Wait for cooldown between shearing attempts
                if (this.cooldown > 0) {
                    this.cooldown--;
                    return;
                }

                // Shearing gives raw wool (Items.WOOL).  Track that, not ball_of_wool.
                const woolCount = countItem(player, Items.WOOL);

                // Notify watchdog whenever we gain a wool
                if (woolCount > this.lastBallWool) {
                    this.watchdog.notifyActivity();
                    this.failTicks = 0;
                }
                this.lastBallWool = woolCount;

                if (woolCount >= SHEAR_BATCH) {
                    this.p1State = 'climb';
                    return;
                }

                // Check available inventory space before shearing
                const inv = player.getInventory(InvType.INV);
                if (!inv) return;
                let freeSlots = 0;
                for (let i = 0; i < inv.capacity; i++) {
                    if (inv.get(i) === null) freeSlots++;
                }
                if (freeSlots === 0) {
                    this.p1State = 'climb';
                    return;
                }

                // Locate shears in inventory — required for use-item-on-npc
                let shearsSlot = -1;
                for (let i = 0; i < inv.capacity; i++) {
                    if (inv.get(i)?.id === Items.SHEARS) {
                        shearsSlot = i;
                        break;
                    }
                }
                if (shearsSlot === -1) {
                    // Lost shears somehow — abort so planner can re-buy them
                    this.interrupt();
                    return;
                }

                // Cycle to a different sheep each attempt so multiple bots don't all
                // pile on the same target.  Falls back to any sheep if only one exists.
                // NPC debugname is 'sheepunsheered' — sheared sheep become 'sheepsheered'.
                const [sx, sz] = this.step.extra!['sheepLocation'] as [number, number, number];
                // port: out of the pen (walked off after a sheep, or a step aside), back in first
                if (!this._inPen(player)) {
                    this.p1State = 'shear_walk';
                    return;
                }
                console.log(`[CraftingTask][${player.username}] Looking for sheep at ${player.x},${player.z} radius 10`);
                // port: only a sheep a walk reaches, none across the fence (upstream took the nearest: "I can't reach
                // that!" at the pen's south fence)
                const unsheared = NpcType.getId('sheepunsheered');
                const reach = this._reachFrom(player);
                const sheep = findNpcFiltered(player.x, player.z, player.level, npc => npc.type === unsheared && reach.has((npc.x << 14) | npc.z), 20);

                if (!sheep) {
                    console.log(`[CraftingTask][${player.username}] No sheep found! failTicks=${this.failTicks}`);
                    this.failTicks++;
                    if (this.failTicks >= FAIL_LIMIT) {
                        // Walk back to sheep location center - no jitter
                        walkTo(player, sx, sz);
                        this.failTicks = 0;
                    }
                    return;
                }

                // Use shears on sheep (APNPCU trigger) — server drives the shearing
                // animation and grants the ball_wool on completion (~3 ticks).
                // Cooldown covers the full shearing action so the bot doesn't
                // spam the interaction before the server has finished.
                console.log(`[CraftingTask][${player.username}] Found sheep @ ${sheep.x},${sheep.z}, attempting shear`);
                const ok = botInteractUseObjNpc(player, sheep, Items.SHEARS, shearsSlot);
                if (ok) {
                    console.log(`[CraftingTask][${player.username}] Shear interaction sent! woolCount=${woolCount}`);
                    this.failTicks = 0;
                    // 3 ticks animation, then a person's next sheep: port (the realism work) a moment after the last
                    // one is shorn (BotTiming 'next', never a metronome; upstream 4-6 ticks: 16-18 % identical intervals)
                    this.cooldown = 4 + humanDelay(player, 'next');
                } else {
                    console.log(`[CraftingTask][${player.username}] Shear FAILED! failTicks=${this.failTicks}`);
                    this.failTicks++;
                    if (this.failTicks >= FAIL_LIMIT) {
                        walkTo(player, sx, sz);
                        this.failTicks = 0;
                    }
                }
                return;
            }

            // ── Up the castle's stairs to the spinning wheel ──────────────────
            // port: walked, by the south-west stairs (BotAction's LumbridgeCastle1 gateway); upstream walked to outside
            // the castle and teleported up
            case 'climb': {
                const [wx, wz, wl] = Locations.LUMBRIDGE_POTTERS_WHEEL;
                if (player.level !== wl || !isNear(player, wx, wz, 1, wl)) {
                    this._stuckWalk(player, wx, wz, wl);
                    return;
                }
                this.p1State = 'spin';
                this.failTicks = 0;
                return;
            }

            // ── Spin raw wool into ball of wool on the spinning wheel ────────────
            case 'spin': {
                // Raw wool (Items.WOOL) was obtained by shearing.
                // The spinning wheel script consumes Items.WOOL and produces Items.BALL_WOOL.
                const woolCount = countItem(player, Items.WOOL);
                if (woolCount === 0) {
                    this.p1State = 'spin_flax';
                    return;
                }

                // Must be cardinally adjacent to the wheel before interacting.
                // reachedLoc requires cardinal adjacency — diagonal doesn't satisfy it.
                // LUMBRIDGE_POTTERS_WHEEL is already the adjacent tile, so this walk
                // normally completes in 0 ticks, but guards against any position drift.
                const [wx, wz, wl] = Locations.LUMBRIDGE_POTTERS_WHEEL;
                if (!isNear(player, wx, wz, 1, wl)) {
                    walkTo(player, wx, wz, wl);
                    return;
                }

                const wheel = findLocByName(player.x, player.z, player.level, 'spinningwheel', 20) ?? findLocByPrefix(player.x, player.z, player.level, 'spinning', 25);

                if (!wheel) {
                    console.log(`[CraftingTask][${player.username}] No spinning wheel found — descending`);
                    this.failTicks++;
                    if (this.failTicks >= FAIL_LIMIT) {
                        this.p1State = 'descend';
                        this.failTicks = 0;
                    }
                    return;
                }

                // spinning.rs2 grants the Crafting XP (stat_advance) server-side — do not also credit it here.
                if (!this._spinAll(player, wheel, Items.WOOL)) {
                    this.p1State = 'descend';
                    this.failTicks = 0;
                }
                return;
            }

            case 'spin_flax': {
                const flaxCount = countItem(player, Items.FLAX);
                if (flaxCount === 0) {
                    this.p1State = 'descend';
                    return;
                }

                const [wx, wz, wl] = Locations.LUMBRIDGE_POTTERS_WHEEL;
                if (!isNear(player, wx, wz, 1, wl)) {
                    walkTo(player, wx, wz);
                    return;
                }

                const wheel = findLocByName(player.x, player.z, player.level, 'spinningwheel', 20) ?? findLocByPrefix(player.x, player.z, player.level, 'spinning', 25);

                if (!wheel) {
                    this.failTicks++;
                    if (this.failTicks >= FAIL_LIMIT) {
                        this.p1State = 'descend';
                        this.failTicks = 0;
                    }
                    return;
                }

                if (!this._spinAll(player, wheel, Items.FLAX)) {
                    this.p1State = 'descend';
                    this.failTicks = 0;
                }
                return;
            }

            // ── Back down to the ground floor ─────────────────────────────────
            // port: the bank walk takes the stairs down (upstream teleported to outside the castle)
            case 'descend': {
                // port: half the crafters (by name) sell their balls at the Lumbridge general store, on the way back to
                // the sheep, and the rest bank them (a 2004 player did either)
                this.p1State = this._sellsWool(player) && hasItem(player, Items.BALL_WOOL) ? 'sell' : 'bank_walk';
                this.sellTries = 0;
                this.sellWait = 0;
                this.lastSold = -1;
                this.sellOut = false;
                return;
            }

            // ── Sell the balls at the Lumbridge general store ─────────────────
            // port: through 274's shop interface (sell 10 a click, at the game's price), keeping the shears and the
            // coins; anything else in the pack is banked after, and a shop that does not open or buys no more sends
            // the bot to the bank with the rest, as the other half go
            case 'sell': {
                const balls = countItem(player, Items.BALL_WOOL);
                if (openShopStock(player)) {
                    if (balls > 0 && balls !== this.lastSold && sellToOpenShop(player, Items.BALL_WOOL)) {
                        this.lastSold = balls;
                        this.watchdog.notifyActivity();
                        return;
                    }
                    player.closeModal();
                    this.p1State = balls > 0 || hasStrayItems(player, [Items.SHEARS, Items.WOOL, Items.FLAX]) ? 'bank_walk' : 'shear_walk';
                    return;
                }
                if (balls === 0) {
                    this.p1State = hasStrayItems(player, [Items.SHEARS, Items.WOOL, Items.FLAX]) ? 'bank_walk' : 'shear_walk';
                    return;
                }
                // out of the castle by its east gate first: from the stairs the store is a walk that bends away (north
                // through the castle, back, out by the gate and round), which the stuck check took for a stall
                if (!this.sellOut) {
                    const [ex, ez] = CASTLE_EAST_GATE;
                    if (player.level !== 0 || !isNear(player, ex, ez, 3)) {
                        this._stuckWalk(player, ex, ez);
                        return;
                    }
                    this.sellOut = true;
                }
                const [gx, gz, gl] = Locations.LUMBRIDGE_GENERAL;
                if (player.level !== gl || !isNear(player, gx, gz, 6, gl)) {
                    this._stuckWalk(player, gx, gz, gl);
                    return;
                }
                // the Trade click: the shop opens once the bot is at the counter
                if (this.sellWait > 0 && ++this.sellWait <= 15) return;
                const buyer = findNpcFiltered(player.x, player.z, player.level, npc => WOOL_BUYERS.includes(NpcType.get(npc.type).debugname ?? ''), 10);
                if (!buyer || ++this.sellTries > 3) {
                    this.p1State = 'bank_walk';
                    return;
                }
                interactNpcOp(player, buyer, 3); // Trade
                this.sellWait = 1;
                return;
            }

            // ── Walk to nearest ground-floor bank ─────────────────────────────
            case 'bank_walk': {
                const result = advanceBankWalk(player, this.stuck);
                if (result === 'walk') return;
                this.cooldown = result === 'ready' ? bankStop(player) : 0; // port (the realism work): a person's stop (port/BotHabits)
                this.p1State = 'bank';
                return;
            }

            // ── Deposit wool, loop back ───────────────────────────────────────
            case 'bank': {
                this._depositWool(player);
                this.p1State = 'shear_walk';
                return;
            }
        }
    }

    // ── Leatherworking ────────────────────────────────────────────────────────

    private _tickLeather(player: Player): void {
        switch (this.p2State) {
            case 'bank_walk': {
                const result = advanceBankWalk(player, this.stuck);
                if (result === 'walk') return;
                this.cooldown = result === 'ready' ? bankStop(player) : 0; // port (the realism work): a person's stop (port/BotHabits)
                this.p2State = 'withdraw';
                return;
            }

            case 'withdraw': {
                const bid = bankInvId();
                const inv = player.getInventory(InvType.INV);
                const bank = bid !== -1 ? player.getInventory(bid) : null;

                // Tanning logic only for soft leather items
                // port: and hard leather for the hard leather body (the tanner's other button), when the bot can pay
                if ((countItem(player, Items.COW_HIDE) > 0 || this._hasCowHideInBank(player)) && coinsOwned(player) >= this._tanCost()) {
                    // We have hides to tan
                    const inv = player.getInventory(InvType.INV);
                    const bid = bankInvId();
                    const bank = bid !== -1 ? player.getInventory(bid) : null;

                    if (inv && bank && !hasItem(player, Items.COW_HIDE)) {
                        for (let i = 0; i < bank.capacity; i++) {
                            if (bank.get(i)?.id === Items.COW_HIDE) {
                                const moved = moveItems(bank, inv, Items.COW_HIDE, 27);
                                break;
                            }
                        }
                    }

                    if (hasItem(player, Items.COW_HIDE)) {
                        // Also ensure we have some coins for tanning
                        // port: the hides' price (1 gp each for soft leather, 3 for hard)
                        const fee = countItem(player, Items.COW_HIDE) * this._tanCost();
                        if (inv && bank && countItem(player, Items.COINS) < fee) moveItems(bank, inv, Items.COINS, fee - countItem(player, Items.COINS));

                        this.p2State = 'tanning_walk';
                        this.failTicks = 0;
                        return;
                    }
                }

                // Deposit crafted items
                if (inv && bank) {
                    const products: number[] = [Items.LEATHER_GLOVES, Items.LEATHER_BOOTS, Items.LEATHER_VAMBRACES, Items.LEATHER_CHAPS, Items.LEATHER_BODY, Items.HARD_LEATHER_BODY];
                    for (let i = 0; i < inv.capacity; i++) {
                        const item = inv.get(i);
                        if (item && products.includes(item.id)) {
                            const moved = inv.remove(item.id, item.count);
                            bank.add(bankedId(item.id), moved);
                        }
                    }
                }

                if (!hasItem(player, Items.NEEDLE) || !hasItem(player, Items.THREAD)) {
                    // Try to withdraw from bank
                    if (bank) {
                        if (!hasItem(player, Items.NEEDLE)) {
                            for (let i = 0; i < bank.capacity; i++) {
                                if (bank.get(i)?.id === Items.NEEDLE) {
                                    if (inv) moveItems(bank, inv, Items.NEEDLE, 1);
                                    break;
                                }
                            }
                        }
                        if (!hasItem(player, Items.THREAD)) {
                            for (let i = 0; i < bank.capacity; i++) {
                                if (bank.get(i)?.id === Items.THREAD) {
                                    const moved = inv ? moveItems(bank, inv, Items.THREAD, 5) : 0;
                                    break;
                                }
                            }
                        }
                    }
                }

                if (!hasItem(player, Items.NEEDLE) || !hasItem(player, Items.THREAD)) {
                    this.done = true;
                    this.interrupt();
                    return;
                }

                // Withdraw leather
                const leatherId = this.step.itemConsumed!;
                if (bank && !hasItem(player, leatherId)) {
                    for (let i = 0; i < bank.capacity; i++) {
                        const item = bank.get(i);
                        if (item?.id === leatherId) {
                            const moved = inv ? moveItems(bank, inv, leatherId, 25) : 0;
                            break;
                        }
                    }
                }

                if (!hasItem(player, leatherId)) {
                    this.done = true;
                    this.interrupt();
                    return;
                }

                this.p2State = 'craft';
                return;
            }

            case 'tanning_walk': {
                const [tx, tz, tl] = Locations.TANNER_AL_KHARID;
                if (!isNear(player, tx, tz, 3, tl)) {
                    this._stuckWalk(player, tx, tz);
                    return;
                }
                this.p2State = 'tanning';
                return;
            }

            case 'tanning': {
                const hideCount = countItem(player, Items.COW_HIDE);
                if (hideCount === 0) {
                    this.p2State = 'bank_walk';
                    return;
                }

                // port: Trade with the tanner opens 274's tanning interface, and its "tan all" button has the game charge
                // and tan (upstream swapped the hides for soft leather itself, 1 coin each)
                const button = this._tannerButton();
                if (interactIfButtonByName(player, button)) {
                    console.log(`[CraftingTask][${player.username}] Tanned ${hideCount - countItem(player, Items.COW_HIDE)} hides`);
                    player.closeModal();
                    this.watchdog.notifyActivity();
                    this.p2State = 'bank_walk';
                    this.cooldown = 2;
                    return;
                }
                if (this.failTicks++ % 10 === 0) {
                    const tanner = findNpcByName(player.x, player.z, player.level, 'tanner', 10); // port: Ellis's debugname is 'tanner' ('ellis' matched no npc)
                    if (!tanner || this.failTicks > 30) {
                        this.p2State = 'bank_walk';
                        this.done = this.failTicks > 30;
                        if (this.done) this.interrupt();
                        return;
                    }
                    interactNpcOp(player, tanner, 3); // Trade
                }
                return;
            }

            case 'craft': {
                const leatherId = this.step.itemConsumed!;
                if (!hasItem(player, leatherId)) {
                    this.p2State = 'bank_walk';
                    return;
                }

                const inv = player.getInventory(InvType.INV);
                if (!inv) return;

                // Use needle on leather interaction
                // port: soft leather opens 274's leather_crafting interface, whose button for the step's product has the
                // game make up to 10 (one every 2 ticks); hard leather makes a body at once. Upstream waited 3 ticks for
                // XP that never came (nothing pressed) and swapped the items itself
                const needleSlot = this._findSlot(player, Items.NEEDLE);
                const leatherSlot = this._findSlot(player, leatherId);
                if (needleSlot !== -1 && leatherSlot !== -1) {
                    interactHeldOpU(player, inv, Items.NEEDLE, needleSlot, leatherId, leatherSlot);
                }

                this.p2State = 'wait_leather';
                this.lastMade = countItem(player, this.step.itemGained!);
                this.pressed = this._leatherButton() === null;
                this.failTicks = 0;
                this.cooldown = 1;
                return;
            }

            case 'wait_leather': {
                const made = countItem(player, this.step.itemGained!);
                if (made > this.lastMade) {
                    this.lastMade = made;
                    this.noInterface = 0;
                    this.failTicks = 0;
                    this.watchdog.notifyActivity();
                }
                const button = this._leatherButton();
                if (!this.pressed && button !== null && interactIfButtonByName(player, button)) {
                    this.pressed = true;
                    this.failTicks = 0;
                    return;
                }
                // making: one every 2 ticks; 4 with nothing new and the batch is over (or nothing opened)
                if (++this.failTicks < 4) return;
                if (!this.pressed && ++this.noInterface >= 3) {
                    player.closeModal();
                    this.done = true;
                    this.interrupt();
                    return;
                }
                this.p2State = 'craft';
                this.failTicks = 0;
                return;
            }
        }
    }

    // ── Phase 2: gold ring crafting ───────────────────────────────────────────

    private _tickPhase2(player: Player): void {
        switch (this.p2State) {
            // ── Walk to nearest bank ──────────────────────────────────────────
            case 'bank_walk': {
                const result = advanceBankWalk(player, this.stuck);
                if (result === 'walk') return;
                this.cooldown = result === 'ready' ? bankStop(player) : 0; // port (the realism work): a person's stop (port/BotHabits)
                this.p2State = 'withdraw';
                return;
            }

            // ── Deposit rings, withdraw gold bars ─────────────────────────────
            case 'withdraw': {
                this._depositRings(player);

                // port: the mould may be in the bank (another task's bank trip put it there)
                if (!hasItem(player, Items.RING_MOULD)) {
                    const bid = bankInvId();
                    const bank = bid === -1 ? null : player.getInventory(bid);
                    const inv = player.getInventory(InvType.INV);
                    if (bank && inv) moveItems(bank, inv, Items.RING_MOULD, 1);
                }

                if (!hasItem(player, Items.RING_MOULD)) {
                    console.log(`[CraftingTask][${player.username}] No ring mould — done`);
                    this.done = true;
                    this.interrupt();
                    return;
                }

                const withdrew = this._withdrawGoldBars(player);
                if (!withdrew) {
                    console.log(`[CraftingTask][${player.username}] No gold bars — done`);
                    this.done = true;
                    this.interrupt();
                    return;
                }

                this.p2State = 'furnace_walk';
                this.cooldown = 1;
                return;
            }

            // ── Walk to furnace ───────────────────────────────────────────────
            case 'furnace_walk': {
                const [lx, lz, ll] = this.step.location;
                if (!isNear(player, lx, lz, 3, ll)) {
                    this._stuckWalk(player, lx, lz);
                    return;
                }
                this.p2State = 'craft';
                this.failTicks = 0;
                return;
            }

            // ── Use gold bar on furnace ───────────────────────────────────────
            case 'craft': {
                if (!this._hasGoldBarsInInventory(player)) {
                    this.p2State = 'bank_return';
                    return;
                }

                const [lx, lz] = this.step.location;
                const furnace = findLocByPrefix(player.x, player.z, player.level, 'furnace', 15) ?? findLocByName(player.x, player.z, player.level, 'furnace1', 15); // port: 274's furnaces are furnace1/furnace2 ('furnace' matched nothing)

                if (!furnace) {
                    this._stuckWalk(player, lx, lz);
                    return;
                }

                // Find gold bar slot
                const inv = player.getInventory(InvType.INV);
                if (!inv) return;
                let barSlot = -1;
                for (let i = 0; i < inv.capacity; i++) {
                    if (inv.get(i)?.id === Items.GOLD_BAR) {
                        barSlot = i;
                        break;
                    }
                }
                if (barSlot === -1) {
                    this.p2State = 'bank_return';
                    return;
                }

                // jewellery.rs2's [oplocu,_smithing_furnace] gold_bar case only opens
                // the ring-making interface (craft_gold_interface) — the actual
                // inv_del/inv_add/stat_advance happens inside the inv_button click
                // handler, which a headless bot cannot press. Fire the real
                // interaction for animation/visual parity, then fall back to a
                // manual transformation via 'wait_ring' if no XP shows up (same
                // pattern as wait_leather/wait_gem for their own UI-gated crafts).
                // port: ...and the bot presses it: "make 10" on the step's ring in the jewellery interface (rings_inv,
                // inv_button3), and the game makes them (2 ticks each)
                interactUseLocOp(player, furnace, Items.GOLD_BAR, barSlot);
                this.p2State = 'wait_ring';
                this.lastMade = countItem(player, this.step.itemGained!);
                this.pressed = false;
                this.failTicks = 0;
                this.cooldown = 1;
                return;
            }

            case 'wait_ring': {
                const made = countItem(player, this.step.itemGained!);
                if (made > this.lastMade) {
                    this.lastMade = made;
                    this.noInterface = 0;
                    this.watchdog.notifyActivity();
                }
                // (a level-up's page left open is clicked away first: it would hold the task for good)
                if (botContinuePage(player) || player.delayed || botScript(player)) return; // walking up to the furnace, or making rings
                if (!this.pressed && pressInterfaceProduct(player, this.step.itemGained!, 3)) {
                    this.pressed = true;
                    return;
                }
                if (this.pressed) {
                    // the batch is over: the next bar on the furnace (or the bank, with none)
                    this.p2State = 'craft';
                    this.failTicks = 0;
                    return;
                }
                if (++this.failTicks < 10) return;
                if (++this.noInterface >= 3) {
                    player.closeModal();
                    this.done = true;
                    this.interrupt();
                    return;
                }
                this.p2State = 'craft';
                this.failTicks = 0;
                return;
            }

            // ── Return to bank and loop ───────────────────────────────────────
            case 'bank_return': {
                const result = advanceBankWalk(player, this.stuck);
                if (result === 'walk') return;
                this.cooldown = result === 'ready' ? bankStop(player) : 0; // port (the realism work): a person's stop (port/BotHabits)
                this.p2State = 'withdraw';
                return;
            }
        }
    }

    // ── Interfaces (port) ─────────────────────────────────────────────────────

    /** port: "make 10" of the step's product in 274's leather_crafting interface (leather.rs2); null: hard leather (none) */
    private _leatherButton(): string | null {
        switch (this.step.itemGained) {
            case Items.LEATHER_BODY: return 'leather_crafting:com_111';
            case Items.LEATHER_GLOVES: return 'leather_crafting:com_114';
            case Items.LEATHER_BOOTS: return 'leather_crafting:com_117';
            case Items.LEATHER_VAMBRACES: return 'leather_crafting:com_120';
            case Items.LEATHER_CHAPS: return 'leather_crafting:com_123';
            default: return null;
        }
    }

    /** port: the tanner's "tan all" (tanner.rs2): hard leather for the hard leather body, soft for the rest */
    private _tannerButton(): string {
        return this.step.itemConsumed === Items.HARD_LEATHER ? 'tanner:com_98' : 'tanner:com_93';
    }

    /** port: what the tanner charges a hide (1 gp soft, 3 gp hard) */
    private _tanCost(): number {
        return this.step.itemConsumed === Items.HARD_LEATHER ? 3 : 1;
    }

    // ── Inventory helpers ─────────────────────────────────────────────────────

    private _hasGoldBarsAnywhere(player: Player): boolean {
        if (countItem(player, Items.GOLD_BAR) > 0) return true;
        const bid = bankInvId();
        if (bid === -1) return false;
        const bank = player.getInventory(bid);
        if (!bank) return false;
        for (let i = 0; i < bank.capacity; i++) {
            if (bank.get(i)?.id === Items.GOLD_BAR) return true;
        }
        return false;
    }

    private _hasCowHideInBank(player: Player): boolean {
        const bid = bankInvId();
        if (bid === -1) return false;
        const bank = player.getInventory(bid);
        if (!bank) return false;
        for (let i = 0; i < bank.capacity; i++) {
            if (bank.get(i)?.id === Items.COW_HIDE) return true;
        }
        return false;
    }

    private _hasItemInBank(player: Player, itemId: number): boolean {
        const bid = bankInvId();
        if (bid === -1) return false;
        const bank = player.getInventory(bid);
        if (!bank) return false;
        for (let i = 0; i < bank.capacity; i++) {
            if (bank.get(i)?.id === itemId) return true;
        }
        return false;
    }

    private _hasLeatherAnywhere(player: Player): boolean {
        if (countItem(player, Items.LEATHER) > 0) return true;
        const bid = bankInvId();
        if (bid === -1) return false;
        const bank = player.getInventory(bid);
        if (!bank) return false;
        for (let i = 0; i < bank.capacity; i++) {
            if (bank.get(i)?.id === Items.LEATHER) return true;
        }
        return false;
    }

    private _hasGoldBarsInInventory(player: Player): boolean {
        return countItem(player, Items.GOLD_BAR) > 0;
    }

    /** Withdraw up to 27 gold bars (leave 1 slot free for the ring_mould). */
    private _withdrawGoldBars(player: Player): boolean {
        const bid = bankInvId();
        if (bid === -1) return false;
        const bank = player.getInventory(bid);
        const inv = player.getInventory(InvType.INV);
        if (!bank || !inv) return false;

        for (let i = 0; i < bank.capacity; i++) {
            const item = bank.get(i);
            if (!item || item.id !== Items.GOLD_BAR) continue;
            const toWithdraw = Math.min(item.count, 27); // 1 slot reserved for ring_mould
            const moved = moveItems(bank, inv, Items.GOLD_BAR, toWithdraw);
            if (moved > 0) {
                return true;
            }
        }
        // Already has bars in inventory
        return countItem(player, Items.GOLD_BAR) > 0;
    }

    /** Deposit ball_of_wool (and any leftover raw wool/flax/bowstrings); keep shears and coins. */
    private _depositWool(player: Player): void {
        const bid = bankInvId();
        if (bid === -1) return;
        const bank = player.getInventory(bid);
        const inv = player.getInventory(InvType.INV);
        if (!bank || !inv) return;

        const keepIds = new Set<number>([Items.SHEARS, Items.COINS, Items.FLAX]);
        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item || keepIds.has(item.id)) continue;
            const moved = inv.remove(item.id, item.count);
            if (moved > 0) bank.add(bankedId(item.id), moved);
        }
        // port: and the shears out of the bank, if that is where they were
        if (!hasItem(player, Items.SHEARS) && this._hasItemInBank(player, Items.SHEARS)) moveItems(bank, inv, Items.SHEARS, 1);
    }

    /** Deposit gold rings (and anything else not needed); keep ring_mould, gold bars, coins. */
    private _depositRings(player: Player): void {
        const bid = bankInvId();
        if (bid === -1) return;
        const bank = player.getInventory(bid);
        const inv = player.getInventory(InvType.INV);
        if (!bank || !inv) return;

        const keepIds = new Set<number>([Items.COINS, Items.RING_MOULD, Items.GOLD_BAR]);
        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item || keepIds.has(item.id)) continue;
            const moved = inv.remove(item.id, item.count);
            if (moved > 0) bank.add(bankedId(item.id), moved);
        }
    }

    // ── Gem Cutting ───────────────────────────────────────────────────────────

    private _tickGems(player: Player): void {
        switch (this.p2State) {
            case 'bank_walk': {
                const result = advanceBankWalk(player, this.stuck);
                if (result === 'walk') return;
                this.cooldown = result === 'ready' ? bankStop(player) : 0; // port (the realism work): a person's stop (port/BotHabits)
                this.p2State = 'withdraw';
                return;
            }

            case 'withdraw': {
                const bid = bankInvId();
                const inv = player.getInventory(InvType.INV);
                const bank = bid !== -1 ? player.getInventory(bid) : null;

                // Deposit cut gems
                if (inv && bank) {
                    const gems: number[] = [Items.SAPPHIRE, Items.EMERALD, Items.RUBY, Items.DIAMOND];
                    for (let i = 0; i < inv.capacity; i++) {
                        const item = inv.get(i);
                        if (item && gems.includes(item.id)) {
                            const moved = inv.remove(item.id, item.count);
                            bank.add(bankedId(item.id), moved);
                        }
                    }
                }

                if (!hasItem(player, Items.CHISEL)) {
                    if (bank) {
                        for (let i = 0; i < bank.capacity; i++) {
                            if (bank.get(i)?.id === Items.CHISEL) {
                                if (inv) moveItems(bank, inv, Items.CHISEL, 1);
                                break;
                            }
                        }
                    }
                }

                if (!hasItem(player, Items.CHISEL)) {
                    this.done = true;
                    this.interrupt();
                    return;
                }

                const uncutId = this.step.itemConsumed!;
                if (!hasItem(player, uncutId)) {
                    if (bank) {
                        for (let i = 0; i < bank.capacity; i++) {
                            const it = bank.get(i);
                            if (it?.id === uncutId) {
                                const moved = inv ? moveItems(bank, inv, uncutId, 27) : 0;
                                break;
                            }
                        }
                    }
                }

                if (!hasItem(player, uncutId)) {
                    this.done = true;
                    this.interrupt();
                    return;
                }

                this.p2State = 'craft';
                return;
            }

            case 'craft': {
                const uncutId = this.step.itemConsumed!;
                if (!hasItem(player, uncutId)) {
                    this.p2State = 'bank_walk';
                    return;
                }

                const inv = player.getInventory(InvType.INV);
                if (!inv) return;

                const prevXp = player.stats[PlayerStat.CRAFTING];

                // Use chisel on uncut gem interaction
                const chiselSlot = this._findSlot(player, Items.CHISEL);
                const uncutSlot = this._findSlot(player, uncutId);
                if (chiselSlot !== -1 && uncutSlot !== -1) {
                    interactHeldOpU(player, inv, Items.CHISEL, chiselSlot, uncutId, uncutSlot);
                }

                this.p2State = 'wait_gem';
                this.lastBallWool = prevXp;
                this.cooldown = 1;
                return;
            }

            case 'wait_gem': {
                if (player.stats[PlayerStat.CRAFTING] > this.lastBallWool) {
                    this.watchdog.notifyActivity();
                    this.p2State = 'craft';
                    this.failTicks = 0;
                    return;
                }
                this.failTicks++;
                if (this.failTicks > 3) {
                    // port: the game did not cut it (the level, a members gem on a free world): the task ends.
                    // Upstream cut it itself, with the XP
                    player.closeModal();
                    this.done = true;
                    this.interrupt();
                }
                return;
            }
        }
    }

    private _findSlot(player: Player, itemId: number): number {
        const inv = player.getInventory(InvType.INV);
        if (!inv) return -1;
        for (let i = 0; i < inv.capacity; i++) {
            const item = inv.get(i);
            if (item && item.id === itemId) return i;
        }
        return -1;
    }

    // ── Movement helper ───────────────────────────────────────────────────────

    /** port: does this bot sell its wool (half the crafters, by name, at every login) rather than bank it? */
    private _sellsWool(player: Player): boolean {
        return nameIndex(player.username, 'wool-seller', 2) === 0;
    }

    /**
     * port: spins all of `item` in the pack as a player did: the wheel's Spin (op2) opens 274's skill_multi2 (wool a,
     * flax b: spinning.rs2), and its Make X, answered with the count in the pack, spins them all, one every 2 ticks.
     * Upstream used each wool on the wheel, a ball a click (5-7 ticks each with its cooldown). Call it every tick at
     * the wheel; false when FAIL_LIMIT clicks in a row spun nothing (the caller moves on).
     */
    private _spinAll(player: Player, wheel: Loc, item: number): boolean {
        const left = countItem(player, item);
        // (a new batch: another item, or more of it than at the last look)
        if (item !== this.spinItem || left > this.spinLeft) {
            this.spinItem = item;
            this.spinLeft = left;
            this.spinWait = 0;
            this.failTicks = 0;
        }
        if (left < this.spinLeft) {
            this.watchdog.notifyActivity();
            this.failTicks = 0;
            this.spinWait = 1;
        }
        this.spinLeft = left;
        if (botScript(player)?.execution === ScriptState.PAUSEBUTTON) {
            if (interactIfButtonByName(player, item === Items.FLAX ? 'skill_multi2:makex_b' : 'skill_multi2:makex_a')) {
                // the count box (p_countdialog), answered at once, as BotTradeScreen's Offer-X
                const box = player.activeScript;
                if (box && box.execution === ScriptState.COUNTDIALOG) {
                    box.lastInt = left;
                    player.executeScript(box, true, true);
                }
                this.spinWait = 1;
                return true;
            }
            botContinuePage(player); // (another page: a level-up, "You need level 10 Crafting")
        }
        // the batch goes on (or the click's choice is on its way): wait
        if (this.spinWait > 0 && ++this.spinWait <= SPIN_WAIT_TICKS) return true;
        if (++this.failTicks > FAIL_LIMIT) return false;
        interactLocOp(player, wheel, 2); // Spin
        this.spinWait = 1;
        return true;
    }

    /** port: is the bot in the sheep pen (its middle a walk away, not across the fence)? */
    private _inPen(player: Player): boolean {
        const [sx, sz] = this.step.extra!['sheepLocation'] as [number, number, number];
        return player.level === 0 && this._reachFrom(player).has((sx << 14) | sz);
    }

    /** port: the tiles a walk reaches from the bot's tile within PEN_REACH (kept while it stands there) */
    private _reachFrom(player: Player): Set<number> {
        const at = (player.level << 28) | (player.x << 14) | player.z;
        if (!this.reach || this.reachAt !== at) {
            this.reach = tilesInSquare(player.level, player.x, player.z, PEN_REACH);
            this.reachAt = at;
        }
        return this.reach;
    }

    private _stuckWalk(player: Player, lx: number, lz: number, level = 0): void {
        if (!this.stuck.check(player, lx, lz)) {
            walkTo(player, lx, lz, level);
            return;
        }
        if (this.stuck.desperatelyStuck) {
            teleportNear(player, lx, lz, level);
            this.stuck.reset();
            return;
        }
        if (openNearbyGate(player, 8)) return;
        walkTo(player, player.x + randInt(-10, 10), player.z + randInt(-10, 10));
    }
}
