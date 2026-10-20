import {
    BotTask,
    Player,
    walkTo,
    removeItem,
    addItem,
    countItem,
    hasItem,
    isNear,
    getBaseLevel,
    getProgressionStep,
    PlayerStat,
    Items,
    Locations,
    randInt,
    StuckDetector,
    ProgressWatchdog,
    InvType,
    bankInvId,
    openNearbyGate,
    teleportNear,
    nearestBank,
    findNpcByName,
    interactNpcOp,
    botJitter,
    humanDelay,
} from '#/engine/bot/tasks/BotTaskBase.js';
import { bankStop } from '#/engine/bot/port/BotHabits.js';
import { isMapBlocked } from '#/engine/GameMap.js';

import type { SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import Loc from '#/engine/entity/Loc.js';
import World from '#/engine/World.js';
import { EntityLifeCycle } from '#/engine/entity/EntityLifeCycle.js';
import { interactHeldOpU, hasLocAt } from '#/engine/bot/BotAction.js';
import LocType from '#/cache/config/LocType.js';
import { LocAngle, LocLayer } from '#/engine/routefinder/index.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { moveItems, bankedId } from '#/engine/bot/port/BotInventoryCompat.js';
import { dressForSkill, needsSkillDress } from '#/engine/bot/port/BotGear.js';

/** Tinderbox price + shopkeeper at Lumbridge General Store (BotKnowledge.Shops.LUMBRIDGE_GENERAL). */
const TINDERBOX_COST = 13;
const GENERAL_STORE_NPC = 'generalshopkeeper1';

/**
 * port (the variety work, round 1, track F: ISS-11): 274's bank zones (skill_firemaking/configs/bank_zones.dbrow, as
 * level-from, level-to, x0, x1, z0, z1): no fire is lit in one
 */
const BANK_ZONES: readonly [number, number, number, number, number, number][] = [
    [0, 0, 3253, 3253, 3425, 3427], [0, 1, 3250, 3257, 3416, 3424], [0, 1, 3180, 3190, 3433, 3447], [0, 0, 3265, 3272, 3161, 3173],
    [0, 0, 3088, 3097, 3240, 3246], [0, 0, 3011, 3014, 3357, 3358], [0, 0, 3009, 3021, 3353, 3356], [0, 0, 2945, 2947, 3366, 3373],
    [0, 0, 2948, 2949, 3366, 3369], [0, 0, 2946, 2948, 3362, 3365], [0, 0, 2945, 2948, 3359, 3361], [1, 1, 2945, 2949, 3362, 3369],
    [0, 0, 3091, 3098, 3488, 3499], [0, 1, 2721, 2730, 3490, 3497], [0, 0, 2724, 2727, 3487, 3489], [0, 0, 2806, 2812, 3438, 3445],
    [0, 0, 2609, 2616, 3088, 3097], [0, 0, 2612, 2614, 3335, 3335], [0, 0, 2619, 2621, 3335, 3335], [0, 0, 2612, 2621, 3330, 3334],
    [0, 2, 2649, 2658, 3280, 3287], [0, 0, 2843, 2845, 2952, 2955], [0, 0, 2846, 2858, 2953, 2955], [0, 0, 2859, 2861, 2952, 2955],
    [0, 0, 2850, 2854, 2951, 2957], [1, 1, 2843, 2861, 2951, 2957], [1, 1, 2443, 2448, 3415, 3434], [1, 1, 2440, 2453, 3416, 3496],
    [0, 0, 2529, 2546, 4711, 4723], [0, 0, 3308, 3309, 3119, 3121], [0, 0, 2586, 2587, 3418, 3422], [0, 0, 3148, 3155, 9573, 9582],
    [0, 0, 3380, 3384, 3267, 3271]
];

/**
 * port (the variety work, round 1, track F: ISS-11): may a fire be lit on (x, z)? 274's ~area_allow_loc_add
 * (firemaking.rs2): no active loc covering the tile (map_locaddunsafe: a fire, a stall, a door frame, a bank booth's
 * reach, a big loc bleeding over from the zones south and west), not blocked (map_blocked), not in a bank zone. The bot
 * checks before it lights and picks the next lane tile instead: "You can't light a fire here." came 81 times an hour
 * (Varrock West's lane: the task stepped aside only after each refusal).
 */
export function fireAllowedAt(x: number, z: number, level: number): boolean {
    if (isMapBlocked(x, z, level)) return false;
    for (const [l0, l1, x0, x1, z0, z1] of BANK_ZONES) if (level >= l0 && level <= l1 && x >= x0 && x <= x1 && z >= z0 && z <= z1) return false;
    for (let dx = -8; dx <= 0; dx += 8) {
        for (let dz = -8; dz <= 0; dz += 8) {
            const zone = World.gameMap.getZone(x + dx, z + dz, level);
            for (const loc of zone.getAllLocsUnsafe()) {
                if (LocType.get(loc.type).active !== 1) continue;
                if (!loc.isActive && loc.layer === LocLayer.WALL) continue;
                const turned = loc.angle === LocAngle.NORTH || loc.angle === LocAngle.SOUTH;
                const width = turned ? loc.length : loc.width;
                const length = turned ? loc.width : loc.length;
                if (x >= loc.x && x < loc.x + width && z >= loc.z && z < loc.z + length) return false;
            }
        }
    }
    return true;
}

/** port (variety round 1, F): lightings refused by the game that the check missed, and lane steps it took first (tests, the report) */
export const fireStats = { refused: 0, stepped: 0 };

export class FiremakingTask extends BotTask {
    private step: SkillStep;

    private state: 'walk' | 'burn' | 'wait_burn' | 'move' | 'bank_walk' | 'bank' | 'shop_walk' | 'shop_buy' = 'walk';

    private lastXp = 0;
    private bankLocked = false;
    private shopWaitTicks = 0;
    private xpBeforeBurn = 0;
    /** port: the logs in the pack when the last one was lit (one gone: it is on the ground, being lit) */
    private logsBeforeBurn = 0;
    private burnWaitTicks = 0;
    /**
     * port (the variety work, round 1, track W: WEAR-5, plate off for firemaking): its outfit was looked to (a bot in
     * plate carrying its logs goes to its bank first, once a task: its bank state takes the plate off, port/BotGear)
     */
    private dressChecked = false;

    private readonly stuck = new StuckDetector(30, 4, 2);
    private readonly watchdog = new ProgressWatchdog();

    constructor(step: SkillStep) {
        super('Firemaking');
        this.step = step;
        this.watchdog.follow(() => this.step.location);
    }

    override activityStep(): SkillStep | null {
        return this.step;
    }

    shouldRun(player: Player): boolean {
        const logId = this.step.itemConsumed;
        if (!logId || logId === -1) return false;
        if (!hasItem(player, logId) && !this._inBank(player, logId)) return false;
        // No tinderbox in hand or bank — still fine as long as there's enough
        // coin (inv + bank) to buy one; the 'bank' state routes to 'shop_walk'
        // for that. Only block if the bot genuinely can't get one at all.
        if (!hasItem(player, Items.TINDERBOX) && !this._inBank(player, Items.TINDERBOX)) {
            const coins = countItem(player, Items.COINS) + this._bankCount(player, Items.COINS);
            if (coins < TINDERBOX_COST) return false;
        }
        return true;
    }

    // ───────────────── LOG HELPERS ─────────────────

    private getItemSlot(player: Player, itemId: number): number | null {
        const inv = player.getInventory(InvType.INV);
        if (!inv) return null;
        for (let i = 0; i < inv.capacity; i++) {
            const item = inv.get(i);
            if (item && item.id === itemId) return i;
        }
        return null;
    }

    /** Returns the step's required log ID if the bot has one in inventory, else null. */
    private getFirstLog(player: Player): number | null {
        const logId = this.step.itemConsumed;
        if (!logId || logId === -1) return null;
        return this.getItemSlot(player, logId) !== null ? logId : null;
    }

    private hasLogs(player: Player): boolean {
        return this.getFirstLog(player) !== null;
    }

    private _inBank(player: Player, itemId: number): boolean {
        const bid = bankInvId();
        if (bid === -1) return false;
        const bank = player.getInventory(bid);
        if (!bank) return false;
        for (let i = 0; i < bank.capacity; i++) {
            if (bank.get(i)?.id === itemId) return true;
        }
        return false;
    }

    private _bankCount(player: Player, itemId: number): number {
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

    private static FIRE_ID = 2732;
    private static FIRE_DURATION = 100; // ticks

private spawnFire(player: Player): void {
    try {
        const fire = new Loc(
            player.level,                      // level
            player.x,                          // x
            player.z,                          // z
            1,                                 // width
            1,                                 // length
            EntityLifeCycle.DESPAWN,           // lifecycle
            FiremakingTask.FIRE_ID,            // type (2732)
            10,                                // shape
            0                                  // angle
        );

        World.addLoc(fire, FiremakingTask.FIRE_DURATION);

        console.log(`[Firemaking] 🔥 spawned REAL fire at ${player.x},${player.z}`);
    } catch (err) {
        console.log('[Firemaking] ❌ failed to spawn fire', err);
    }
}

    // ───────────────── MAIN LOOP ─────────────────

    tick(player: Player): void {
        if (this.interrupted) return;

        const banking = this.state === 'bank_walk' || this.state === 'bank' || this.state === 'shop_walk' || this.state === 'shop_buy';

        if (this.watchdog.check(player, banking)) {
            player.clearWaypoints();
            player.clearPendingAction();
            this.stuck.reset();
            this.state = 'walk';
            return;
        }

        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }

        // port: no step change mid-task: the planner picked this step for the materials the bot has (upstream drew a
        // random step every tick and took any with a higher minimum: a cook with raw shrimp was sent off to cook swordfish)

        // port (the variety work, round 1, track W: WEAR-5): a firemaker in plate (from a fight, with its logs) takes it off
        // at its bank before it lights a log: 9-52 % of the firemakers burned logs in plate (the wear track's census)
        if (!this.dressChecked && !banking) {
            this.dressChecked = true;
            if (needsSkillDress(player)) this.state = 'bank_walk';
        }

        // ───────────────── FORCE BANK FIX ─────────────────
        // Also checks for a tinderbox in hand — without this, a bot that has
        // logs but only has its tinderbox in the bank (or nowhere at all)
        // would walk straight out to 'burn' and silently stall forever there
        // (see the o_slot === null guard below).
        if ((!this.hasLogs(player) || !hasItem(player, Items.TINDERBOX)) && !banking) {
            console.log(`[Firemaking] 📦 No logs or no tinderbox → bank`);
            this.state = 'bank_walk';
        }

        // ───────────────── BANK WALK ─────────────────

        if (this.state === 'bank_walk') {
            const [bx, bz] = nearestBank(player);

            if (!isNear(player, bx, bz, 8)) {
                this._stuckWalk(player, bx, bz);
                return;
            }

            console.log(`[Firemaking] 🏦 Arrived bank`);
            this.state = 'bank';
            // port (the realism work): a person's stop at the bank, never the same twice (port/BotHabits.bankStop)
            this.cooldown = bankStop(player);
            return;
        }

        // ───────────────── BANK ─────────────────

        if (this.state === 'bank') {
            const bid = bankInvId();
            const bank = bid !== -1 ? player.getInventory(bid) : null;
            const inv = player.getInventory(InvType.INV);
            if (!bank || !inv) return;

            const logId = this.step.itemConsumed;
            if (!logId || logId === -1) { this.interrupt(); return; }

            // port (the variety work, round 1, track W: WEAR-5): this bank state moves items directly and never dressed
            // the bot: its plate to the bank, its outfit on, as every skill's bank stop does (port/BotGear)
            dressForSkill(player);

            // 1. Deposit everything that isn't the correct log or tinderbox.
            for (let i = 0; i < inv.capacity; i++) {
                const item = inv.get(i);
                if (!item) continue;
                if (item.id === logId || item.id === Items.TINDERBOX) continue;
                const moved = inv.remove(item.id, item.count);
                if (moved > 0) bank.add(bankedId(item.id), moved);
            }

            // 2. Ensure tinderbox is in inventory; withdraw from bank if needed.
            if (!hasItem(player, Items.TINDERBOX)) {
                for (let i = 0; i < bank.capacity; i++) {
                    const it = bank.get(i);
                    if (it?.id !== Items.TINDERBOX) continue;
                    const removed = moveItems(bank, inv, Items.TINDERBOX, 1);
                    break;
                }
                if (!hasItem(player, Items.TINDERBOX)) {
                    console.log(`[Firemaking] 🛒 No tinderbox in bank → shop trip to Lumbridge General`);
                    this.state = 'shop_walk';
                    this.shopWaitTicks = 0;
                    return;
                }
            }

            // 3. Withdraw correct logs (fill remaining inventory space).
            if (!hasItem(player, logId)) {
                let withdrew = false;
                for (let i = 0; i < bank.capacity; i++) {
                    const item = bank.get(i);
                    if (!item || item.id !== logId) continue;
                    const moved = moveItems(bank, inv, logId, item.count);
                    if (moved > 0) {
                        withdrew = true;
                    }
                    break;
                }
                if (!withdrew) {
                    console.log(`[Firemaking] ❌ No correct logs in bank → STOP`);
                    this.interrupt();
                    return;
                }
            }

            this.bankLocked = false;
            this.state = 'walk';
            return;
        }

        // ───────────────── SHOP: buy a tinderbox from Lumbridge General ─────────────────

        if (this.state === 'shop_walk') {
            const [sx, sz, sl] = Locations.LUMBRIDGE_GENERAL;

            if (!isNear(player, sx, sz, 8, sl)) {
                this._stuckWalk(player, sx, sz);
                return;
            }

            const shopNpc = findNpcByName(player.x, player.z, player.level, GENERAL_STORE_NPC, 10);
            if (!shopNpc) return;

            interactNpcOp(player, shopNpc, 3); // op3 = Trade
            this.state = 'shop_buy';
            this.shopWaitTicks = 0;
            this.cooldown = 2;
            return;
        }

        if (this.state === 'shop_buy') {
            // Give the shop interface a couple of ticks to open before buying.
            if (this.shopWaitTicks < 2) {
                this.shopWaitTicks++;
                return;
            }

            if (countItem(player, Items.COINS) < TINDERBOX_COST) {
                console.log(`[Firemaking] ❌ Can't afford a tinderbox (need ${TINDERBOX_COST}gp) → STOP`);
                this.interrupt();
                return;
            }

            removeItem(player, Items.COINS, TINDERBOX_COST);
            if (!addItem(player, Items.TINDERBOX, 1)) {
                // Inventory full — refund and let the FORCE BANK FIX route us
                // back through a normal bank trip to free space.
                addItem(player, Items.COINS, TINDERBOX_COST);
                this.state = 'bank_walk';
                return;
            }

            console.log(`[Firemaking] 🛒 Bought a tinderbox`);
            // Route back through 'bank_walk' (not straight to 'bank') — the
            // bot is standing at Lumbridge General here, not at a bank, and
            // 'bank_walk' is what actually walks it to the nearest one before
            // 'bank' re-verifies everything (deposits stray items, tops up logs).
            this.state = 'bank_walk';
            return;
        }

        // ───────────────── WALK TO FIRE AREA ─────────────────

        // port: to the step's own place (upstream always walked to the Lumbridge road, while its watchdog sent the
        // bot back to the step's town every 300 ticks: a firemaker with a Seers or Edgeville step blinked between
        // the two for up to 50 minutes), a few tiles apart from the other firemakers there
        if (this.state === 'walk') {
            const [lx, lz] = botJitter(player, this.step.location[0], this.step.location[1], 3);

            if (!isNear(player, lx, lz, 4)) {
                this._stuckWalk(player, lx, lz);
                return;
            }

            console.log(`[Firemaking] 🔥 Arrived fire area`);
            this.state = 'burn';
            return;
        }

             // ───────────────── BURN ─────────────────

        if (this.state === 'burn') {
            const logId = this.getFirstLog(player);
            const inv = player.getInventory(InvType.INV);
            if (!logId) {
                console.log('[Firemaking] 📦 out of logs');
                this.state = 'bank_walk';
                return;
            }
            if (!inv) {
                return;
            }
            const slot = this.getItemSlot(player, logId);
            if (slot === null) return;
            const o_slot = this.getItemSlot(player, Items.TINDERBOX);
            if (o_slot === null) {
                // Defense in depth — the FORCE BANK FIX above should already
                // catch a missing tinderbox before we ever get here, but if a
                // tinderbox is somehow lost mid-task, don't silently stall
                // forever: go get another instead.
                console.log('[Firemaking] 🔥❌ no tinderbox in hand → bank');
                this.state = 'bank_walk';
                return;
            }

            // port (the variety work, round 1, track F: ISS-11): not on a tile 274 refuses (a fire, a loc, a bank zone): the
            // next lane tile first (the move below picks one it allows)
            if (!fireAllowedAt(player.x, player.z, player.level)) {
                fireStats.stepped++;
                this.state = 'move';
                return;
            }
            // firemaking.rs2's [opheldu,tinderbox] -> light_logs_inv already
            // grants XP itself via stat_advance(firemaking, ...) inside
            // firemaking_success() once the ignite roll succeeds — do not
            // also credit it here (see wait_burn below).
            interactHeldOpU(player, inv, logId, slot, Items.TINDERBOX, o_slot);
            this.xpBeforeBurn = player.stats[PlayerStat.FIREMAKING];
            this.logsBeforeBurn = countItem(player, logId);
            this.burnWaitTicks = 0;
            this.state = 'wait_burn';
            return;
        }

        // ───────────────── WAIT FOR BURN RESULT ─────────────────
        // The real script rolls for success on a delay (~3-4 ticks) and keeps
        // retrying itself automatically (p_opobj(4)) if it misses, so this
        // polls for real XP instead of crediting immediately.
        // port: 274 drops the log on the bot's tile and lights it from the ground (the bot's interaction is with that
        // log) until a roll succeeds; then it pushes the bot a tile aside, ready for the next log, as a player stands
        // in a firemaking line. Upstream gave up after 8 ticks and stepped away, which cancelled the lighting and left
        // the log on the ground (16 of 108 at level 1), and waited 2 to 12 ticks more after every fire.
        if (this.state === 'wait_burn') {
            if (player.stats[PlayerStat.FIREMAKING] > this.xpBeforeBurn) {
                this.lastXp = player.stats[PlayerStat.FIREMAKING];
                this.watchdog.notifyActivity();
                console.log(`[Firemaking] 🔥 log burned (real XP confirmed, total=${this.lastXp})`);
                // port (the realism work): the next log when a person clicks it, never a metronome (BotTiming 'next'), and
                // not before the game's own pause after a lighting is over (%action_delay, 3-4 ticks: a click inside it
                // waits for its end, and quick clicks came in step)
                this.cooldown = 3 + humanDelay(player, 'next');
                this.state = 'burn';
                return;
            }

            this.burnWaitTicks++;
            const logId = this.step.itemConsumed ?? -1;
            // the log still in the pack and nothing going on: "You can't light a fire here." (a fire or another loc on
            // the tile, or a bank): a step to the next tile along
            if (this.burnWaitTicks >= 2 && player.target === null && countItem(player, logId) >= this.logsBeforeBurn) {
                fireStats.refused++;
                this.state = 'move';
                return;
            }
            // still lighting the dropped log: wait for it
            if (player.target !== null && this.burnWaitTicks < 30) return;
            if (this.burnWaitTicks > 3) {
                console.log('[Firemaking] 🔥 no XP confirmed in time — moving on');
                this.state = 'move';
            }
            return;
        }

        // ───────────────── MOVE ─────────────────
        // port: to a free tile next to the bot (west or east first, along the line)
        if (this.state === 'move') {
            // port (variety round 1, F): a tile 274 lets a fire be lit on (fireAllowedAt), along the line first
            let moved = false;
            for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-2, 0], [2, 0], [0, -2], [0, 2], [-3, 0], [3, 0]]) {
                const [tx, tz] = [player.x + dx, player.z + dz];
                if (isMapBlocked(tx, tz, player.level) || hasLocAt(tx, tz, player.level) || !fireAllowedAt(tx, tz, player.level)) continue;
                walkTo(player, tx, tz, player.level);
                moved = true;
                break;
            }
            // (none near: back to the lane's start, a few tiles off)
            if (!moved) {
                const [lx, lz] = botJitter(player, this.step.location[0], this.step.location[1], 4);
                walkTo(player, lx, lz, player.level);
                this.cooldown = 3;
                this.state = 'burn';
                return;
            }
            this.cooldown = 1;
            this.state = 'burn';
            return;
        }
    }

    // ───────────────── RESET ─────────────────

    private resetLoop(): void {
        this.state = 'walk';
        this.dressChecked = false;
        this.cooldown = 0;
        this.lastXp = 0;
        this.bankLocked = false;
        this.shopWaitTicks = 0;
        this.xpBeforeBurn = 0;
        this.burnWaitTicks = 0;

        this.stuck.reset();
        this.watchdog.reset();
    }

    override reset(): void {
        super.reset();
        this.resetLoop();
    }

    // ───────────────── STUCK HANDLER ─────────────────

    private _stuckWalk(player: Player, x: number, z: number): void {
        if (!this.stuck.check(player, x, z)) {
            walkTo(player, x, z);
            return;
        }

        if (this.stuck.desperatelyStuck) {
            console.log(`[Firemaking] 🌀 teleport escape`);
            teleportNear(player, x, z);
            this.stuck.reset();
            return;
        }

        if (openNearbyGate(player, 5)) return;

        walkTo(
            player,
            player.x + randInt(-10, 10),
            player.z + randInt(-10, 10)
        );
    }

    isComplete(): boolean {
        return false;
    }
}
