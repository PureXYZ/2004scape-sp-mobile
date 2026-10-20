/**
 * FlaxPickingTask.ts
 *
 * Picks flax in the Seers' Village flax field.
 * Banking: Seers' Village bank.
 */

import {
    BotTask,
    Player,
    InvType,
    walkTo,
    interactLocOp,
    findLocByName,
    findLocByNameWhere,
    countItem,
    isInventoryFull,
    isNear,
    Items,
    bankInvId,
    StuckDetector,
    ProgressWatchdog,
    openNearbyGate,
    teleportNear,
    advanceBankWalk,
    nearestBank,
    randInt,
    hasStrayItems,
    humanDelay
} from '#/engine/bot/tasks/BotTaskBase.js';
import { bankStop } from '#/engine/bot/port/BotHabits.js';
import type { SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import { bankedId } from '#/engine/bot/port/BotInventoryCompat.js';
import { interactHeldOp } from '#/engine/bot/BotAction.js';
import { botWalkPath } from '#/engine/bot/port/BotPathing.js';

/** port: ticks without a step on the bank walk before a bot beside a flax plant picks its way out */
const BOXED_IN_TICKS = 5;

export class FlaxPickingTask extends BotTask {
    private readonly step: SkillStep;

    /**
     * State machine:
     *   walk      → walking to flax field
     *   pick      → at field, interacting with flax
     *   bank_walk → walking to bank
     *   bank_done → banking finished
     */
    private state: 'walk' | 'pick' | 'bank_walk' | 'bank_done' = 'walk';
    private lastFlaxCount = 0;
    private readonly stuck = new StuckDetector(30, 4, 2);
    private readonly watchdog = new ProgressWatchdog();
    /** port: where the bot stood on the bank walk, and for how many ticks (see _pickWayOut) */
    private stillX = -1;
    private stillZ = -1;
    private stillTicks = 0;
    /** port: a plant was picked to open the way (the route out is taken next) */
    private cleared = false;

    /**
     * Completes after a single gather-and-bank cycle so the planner is
     * re-consulted rather than gathering flax forever. Without this, the
     * planner would keep re-selecting FlaxPickingTask indefinitely (same
     * task name never changes candidate.name at rescan), starving
     * CraftingTask of the chance to spin the flax that's already banked.
     * See _findCraftingTask() in BotGoalPlanner for the producer/consumer
     * threshold that decides whether to gather more or switch to spinning.
     */
    private bankedOnce = false;

    constructor(step: SkillStep) {
        super('Pick Flax');
        this.step = step;
        this.watchdog.follow(() => this.step.location);
    }

    override activityStep(): SkillStep | null {
        return this.step;
    }

    shouldRun(_player: Player): boolean {
        return !this.bankedOnce;
    }

    tick(player: Player): void {
        if (this.interrupted) return;

        const banking = this.state === 'bank_walk' || this.state === 'bank_done';
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

        if (isInventoryFull(player) && this.state !== 'bank_walk' && this.state !== 'bank_done') {
            this.state = 'bank_walk';
        }

        // Carrying leftovers from a previous task — bank them before heading
        // out to the flax field so the trip starts with a clean slate.
        if (this.state === 'walk' && hasStrayItems(player, [...this.step.toolItemIds, Items.COINS])) {
            this.state = 'bank_walk';
        }

        switch (this.state) {
            case 'walk': {
                const [lx, lz, ll] = this.step.location;
                if (!isNear(player, lx, lz, 10, ll)) {
                    this._stuckWalk(player, lx, lz); // port: walked (upstream jumped wherever no human could see)
                    return;
                }
                this.state = 'pick';
                this.lastFlaxCount = countItem(player, Items.FLAX);
                return;
            }

            case 'pick': {
                const flaxCount = countItem(player, Items.FLAX);
                if (flaxCount > this.lastFlaxCount) {
                    this.watchdog.notifyActivity();
                }
                this.lastFlaxCount = flaxCount;

                if (isInventoryFull(player)) {
                    this.state = 'bank_walk';
                    return;
                }

                const flax = findLocByName(player.x, player.z, player.level, 'flax', 15);
                if (!flax) {
                    // Wander slightly if no flax found
                    const [lx, lz] = this.step.location;
                    walkTo(player, lx + randInt(-5, 5), lz + randInt(-5, 5));
                    return;
                }

                if (!isNear(player, flax.x, flax.z, 1)) {
                    walkTo(player, flax.x, flax.z);
                    return;
                }

                interactLocOp(player, flax, 2);
                // port (the realism work): the pick's tick, then a person's next click, never a metronome (BotTiming
                // 'next'); upstream picked every 2-4 ticks (28 % identical intervals)
                this.cooldown = 1 + humanDelay(player, 'next');
                return;
            }

            case 'bank_walk': {
                if (this._pickWayOut(player)) return;
                const result = advanceBankWalk(player, this.stuck);
                if (result === 'walk') return;
                // port (the realism work): a person's stop at the booth, never the same twice (port/BotHabits.bankStop)
                this.cooldown = result === 'ready' ? bankStop(player) : 0;
                this.state = 'bank_done';
                return;
            }

            case 'bank_done': {
                this._depositFlax(player);
                this.bankedOnce = true;
                this.state = 'walk';
                this.cooldown = 2;
                return;
            }
        }
    }

    isComplete(_player: Player): boolean {
        return this.bankedOnce;
    }

    override reset(): void {
        super.reset();
        this.state = 'walk';
        this.lastFlaxCount = 0;
        this.bankedOnce = false;
        this.stillX = -1;
        this.stillZ = -1;
        this.stillTicks = 0;
        this.cleared = false;
        this.stuck.reset();
        this.watchdog.reset();
    }

    /**
     * port: flax plants block the way, and they grow back round a picker: a bot with a full pack could stand shut in
     * among them (2742,3447) until a rescue jump. Stood still on the bank walk for BOXED_IN_TICKS beside a plant, it
     * picks the plant to open a way, as a player would, dropping a flax first when the pack is full (the game will not
     * pick into a full pack). True when it did either this tick.
     */
    private _pickWayOut(player: Player): boolean {
        const [bx, bz] = nearestBank(player);
        // the way the plant left open, searched for here: the walk remembers the bot as shut in where it stood (its
        // searches are kept per tile), and stood on until a rescue
        if (this.cleared) {
            this.cleared = false;
            const path = botWalkPath(player.level, player.x, player.z, bx, bz);
            if (path.length > 0) {
                player.clearWaypoints();
                player.queueWaypoints(path);
                return true;
            }
        }
        if (player.x !== this.stillX || player.z !== this.stillZ) {
            this.stillX = player.x;
            this.stillZ = player.z;
            this.stillTicks = 0;
            return false;
        }
        if (++this.stillTicks < BOXED_IN_TICKS) return false;
        // (the one toward the bank)
        const plants = [[1, 0], [-1, 0], [0, 1], [0, -1]]
            .map(([dx, dz]) => findLocByNameWhere(player.x + dx, player.z + dz, player.level, 'flax', 1, loc => loc.x === player.x + dx && loc.z === player.z + dz))
            .filter(loc => loc !== null)
            .sort((a, b) => Math.hypot(a.x - bx, a.z - bz) - Math.hypot(b.x - bx, b.z - bz));
        const plant = plants[0];
        if (!plant) return false;
        const inv = player.getInventory(InvType.INV);
        if (!inv) return false;
        if (isInventoryFull(player)) {
            for (let slot = 0; slot < inv.capacity; slot++) {
                if (inv.get(slot)?.id !== Items.FLAX) continue;
                if (!interactHeldOp(player, inv, Items.FLAX, slot, 5)) return false; // Drop
                this.cooldown = 1;
                return true;
            }
            return false;
        }
        interactLocOp(player, plant, 2); // Pick
        this.cleared = true;
        this.stillTicks = 0;
        this.cooldown = 2;
        return true;
    }

    private _depositFlax(player: Player): void {
        const inv = player.getInventory(InvType.INV);
        const bid = bankInvId();
        if (!inv || bid === -1) return;
        const bank = player.getInventory(bid);
        if (!bank) return;

        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item) continue;
            if (item.id === Items.COINS) continue;
            // Keep any tool items (though flax picking has none)
            if (this.step.toolItemIds.includes(item.id)) continue;

            const moved = inv.remove(item.id, item.count);
            if (moved > 0) bank.add(bankedId(item.id), moved);
        }
    }

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
        if (openNearbyGate(player, 5)) return;
        walkTo(player, lx + randInt(-5, 5), lz + randInt(-5, 5));
    }
}
