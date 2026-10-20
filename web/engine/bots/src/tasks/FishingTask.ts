/**
 * FishingTask.ts — Fish at spots, bank when full, progression-aware fishing loop.
 */

import {
    BotTask, Player, Npc, InvType,
    walkTo, interactNpc, interactNpcOp,
    findNpcBySuffix,
    hasItem, countItem, isInventoryFull, isNear,
    getBaseLevel, PlayerStat,
    Items, Locations, getProgressionStep,
    teleportToSafety, teleportNear, randInt, bankInvId, INTERACT_TIMEOUT,
    StuckDetector, ProgressWatchdog,
    openNearbyGate, botJitter, advanceBankWalk, hasStrayItems,
    canUseTool, bankCount, withdrawUsableTool, fareShort, withdrawFare, humanDelay, ResourceWait, noteGatherTick, FISH_PATIENCE, awayFromSpot,
} from '#/engine/bot/tasks/BotTaskBase.js';
import World from '#/engine/World.js';
import { bankStop } from '#/engine/bot/port/BotHabits.js';
import type { SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import { levelUpStep, getProgressionStepWhere } from '#/engine/bot/BotKnowledge.js';
import { getCombatLevel, crossingFare, isCrossing } from '#/engine/bot/BotAction.js';
import type { BotTaskDebugInfo } from '#/engine/bot/debug/BotDebugTypes.js';
import NpcType from '#/cache/config/NpcType.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { bankedId } from '#/engine/bot/port/BotInventoryCompat.js';
import { isEventHazard } from '#/engine/bot/port/BotRandomEvents.js';
// (the variety work, round 1, Track D: DO-12 power-dropping)
import { dropOne, dropsHere, dropStats } from '#/engine/bot/port/BotPowerDrop.js';

/** Draynor village fishing spots — aggressive Dark Wizards patrol here, minimum combat 16. */
// port: Draynor only (upstream listed Al Kharid too, which has no wizards: a bot under combat 16 could fish only at
// Karamja, and the planner kept handing it Al Kharid)
const DRAYNOR_FISH_LOCATIONS: Array<[number, number, number]> = [
    Locations.FISH_DRAYNOR
];

/** port: may a bot of this combat level fish at this step's spot? */
function spotAllowed(player: Player, step: SkillStep): boolean {
    const [sx, sz, sl] = step.location;
    const isDraynor = DRAYNOR_FISH_LOCATIONS.some(([lx, lz, ll]) => lx === sx && lz === sz && ll === sl);
    return !isDraynor || getCombatLevel(player) >= 16;
}

export class FishingTask extends BotTask {
    private step: SkillStep;
    /** port: the level the step was last checked against (BotKnowledge.levelUpStep runs when it rises) */
    private stepLevel = -1;

    private state: 'walk' | 'approach' | 'scan' | 'interact' | 'bank_walk' | 'bank_done' | 'drop' = 'walk';

    private interactTicks = 0;
    /** port: ticks in a row the bot's interaction with the spot has been gone */
    private targetGone = 0;
    private lastXp = 0;
    private scanFailTicks = 0;
    private approachTicks = 0;

    private currentSpot: Npc | null = null;

    private readonly stuck = new StuckDetector(30, 4, 2);
    private readonly watchdog = new ProgressWatchdog();
    /** port (the variety work, round 1, track F: DO-3): no free spot near: it waits on the shore (ResourceWait) */
    private readonly wait = new ResourceWait('Fish', FISH_PATIENCE);
    /** port (variety round 1, F): walking to a random tile with no spot (AM6), until this tick */
    private wanderUntil = -1;
    private lastPlayer: Player | null = null;

    constructor(step: SkillStep) {
        super('Fish');
        this.step = step;
        this.watchdog.follow(() => this.step.location);
    }

    override activityStep(): SkillStep | null {
        return this.step;
    }

    shouldRun(player: Player): boolean {
        // port: each tool carried or in the bank (fetched first): a combat trip banks the net, rod and feathers
        if (!this.step.toolItemIds.every(id => hasItem(player, id) || (canUseTool(player, id) && bankCount(player, id) > 0))) return false;

        // Draynor village has aggressive Dark Wizards — require combat level 16
        return spotAllowed(player, this.step);
    }

    tick(player: Player): void {
        if (this.interrupted) return;
        this.lastPlayer = player;
        noteGatherTick('Fish', World.currentTick < this.wanderUntil);
        if (this.wait.done) return;

        const banking = this.state === 'bank_walk' || this.state === 'bank_done';
        if (this.watchdog.check(player, banking)) {
            player.clearWaypoints();
            player.clearPendingAction();
            this.stuck.reset();
            this.state = 'approach';
            this.currentSpot = null;
            this.interactTicks = 0;
            this.scanFailTicks = 0;
            this.approachTicks = 0;
            this.cooldown = 3;
            return;
        }

        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }

        // port: a monster that attacks the bot is BotPlayer's to answer (port/BotDefence: it fights off a weak one and
        // runs from the rest, for every task but the fights). Upstream ran here only from a stronger one, to the middle
        // of the spot, where the bot mostly was already: Lumbridge's giant spiders bit woodcutters to death

        // ── Progression upgrade ─────────────────────────────────────────────
        // port: only when the level rose, and only off a step the level has outgrown (BotKnowledge.levelUpStep); upstream
        // drew a random step every tick and jumped to any with a higher minimum, tools or not
        const level = getBaseLevel(player, PlayerStat.FISHING);
        if (this.stepLevel === -1) this.stepLevel = level;
        const newStep = level > this.stepLevel ? levelUpStep('FISHING', this.step, level, s => s.toolItemIds.every(id => hasItem(player, id)), [player.x, player.z]) : null;
        this.stepLevel = level;

        if (newStep && newStep !== this.step) {
            this.step = newStep;
            this.state = 'walk';
            this.currentSpot = null;
        }

        // port: a tool is in the bank: fetch it first
        if (this.state !== 'bank_walk' && this.state !== 'bank_done' && !this.step.toolItemIds.every(id => hasItem(player, id))) {
            this.state = 'bank_walk';
        }

        // ── Bank flow ────────────────────────────────────────────────────────
        if (this.state === 'bank_walk') {
            const result = advanceBankWalk(player, this.stuck);
            if (result === 'walk') return;
            // port (the realism work): a person's stop at the booth, never the same twice (port/BotHabits.bankStop)
            this.cooldown = result === 'ready' ? bankStop(player) : 0;
            this.state = 'bank_done';
            return;
        }

        if (this.state === 'bank_done') {
            this._depositFish(player);
            // port: the tools (and feathers or bait) another task banked
            for (const id of this.step.toolItemIds) {
                if (!hasItem(player, id)) withdrawUsableTool(player, [id]);
            }
            if (!this.step.toolItemIds.every(id => hasItem(player, id))) {
                this.interrupt(); // port: gone from the bank too: let the planner buy or choose again
                return;
            }
            withdrawFare(player, ...this.step.location); // port: the Karamja boat's, there and back
            // port: short of it, bank and all: not this spot (the planner chooses again; it skips the spots it cannot pay for)
            if (countItem(player, Items.COINS) < crossingFare(player.x, player.z, player.level, ...this.step.location)) {
                this.interrupt();
                return;
            }
            // port: the spot holds for the plan (15-60 minute plans; a level-up still moves it on). Upstream
            // drew a random spot after every load, often across the map
            this.state = 'walk';
            this.cooldown = 3;
            return;
        }

        // ── A full pack (the variety work, round 1, Track D: its own branch) ─────
        // (DO-12) a power-trainer drops its shrimps one by one where it stands, at a person's pace, and fishes on
        if (this.state === 'drop') {
            const wait = dropOne(player, this.step);
            if (wait < 0) {
                this.state = 'approach';
                this.cooldown = humanDelay(player, 'retarget');
                return;
            }
            dropStats.items++;
            this.cooldown = wait - 1;
            return;
        }
        if (isInventoryFull(player)) {
            player.clearPendingAction();
            if (dropsHere(player, this.step)) {
                dropStats.loads++;
                this.state = 'drop';
                this.cooldown = humanDelay(player, 'retarget');
                return;
            }
            this.state = 'bank_walk';
            return;
        }

        // Carrying leftovers from a previous task — bank them before heading
        // out to the fishing spot so the trip starts with a clean slate.
        // (step.itemConsumed — bait/feathers — is kept; it's needed for this
        // very trip, not a stray item.)
        if (this.state === 'walk') {
            const keepIds = [...this.step.toolItemIds, Items.COINS];
            if (this.step.itemConsumed) keepIds.push(this.step.itemConsumed);
            // port: or the boat's fare is in the bank (Karamja: 30 coins each way). Port (the realism work, phase 5a): not
            // on the way across (the sailor paid, the sail, the deck): the fare there and back, counted from the near side
            // with the half just paid, was short, and the bot turned back at Karamja's dock for the bank, a lap of 60
            // coins and about 300 ticks over and over (17 laps by 5 fishers in a 2-hour free-world run: H17's Fish/loc,
            // the plank then the customs officer at once; found by tracks E and F both)
            if (!isCrossing(player) && !player.delayed && (hasStrayItems(player, keepIds) || fareShort(player, ...this.step.location))) {
                this.state = 'bank_walk';
                return;
            }
        }

        // ── Consumable check ────────────────────────────────────────────────
        if (this.step.itemConsumed && !hasItem(player, this.step.itemConsumed)) {
            this.state = 'bank_walk';
            return;
        }

        // ── Walk to fishing zone ─────────────────────────────────────────────
        if (this.state === 'walk') {
            const [lx, lz, ll] = this.step.location;

            if (!isNear(player, lx, lz, 15, ll)) {
                // Via waypoint: route through intermediate coord before destination.
                // Used to steer around obstacles (e.g. Draynor Mansion for Barbarian
                // Village fishing spots).  Only apply when the bot hasn't yet passed it.
                const via = this.step.via;
                if (via && player.level === via[2] && player.z < via[1] && !isNear(player, via[0], via[1], 5)) {
                    const [jx, jz] = botJitter(player, via[0], via[1], 3);
                    this._stuckWalk(player, jx, jz);
                    return;
                }
                const [jx, jz] = botJitter(player, lx, lz, 5);
                this._stuckWalk(player, jx, jz);
                return;
            }

            this.state = 'approach';
            return;
        }

        // ── Approach fishing spot ────────────────────────────────────────────
        if (this.state === 'approach') {
            // port (the variety work, round 1, track F: DO-3): waiting on the shore, it looks again a person's moment later
            if (this.wait.holding()) return;
            const spot = this._findFishSpot(player);

            if (!spot) {
                // port (variety round 1, F): no free spot near: it waits where it stands by the water (spots move on their
                // own) and after 2-4 minutes moves on; upstream walked to a random tile within 5 of the spot every 4 ticks
                // (only at its spot: away from it, a sub-task's errand over, a party's or a "come here", it walks back first;
                // a wait under way reaches a stump or rock up to 15 tiles off: within WAIT_SPOT_TILES it stays)
                if (awayFromSpot(player, this.step.location, this.wait)) {
                    this.state = 'walk';
                    return;
                }
                this.scanFailTicks++;
                this.wait.none(player, null, () => {});
                this.watchdog.notifyActivity();
                return;
            }

            this.wait.found(player);
            this.scanFailTicks = 0;
            this.currentSpot = spot;

            // move into range before interacting (important stability fix)
            if (!isNear(player, spot.x, spot.z, 2)) {
                this.approachTicks++;
                walkTo(player, spot.x, spot.z);

                if (this.approachTicks > 25) {
                    // Can't reach this spot — reposition near the activity center
                    // so the bot gets a better angle instead of retrying the same path.
                    this.currentSpot = null;
                    this.approachTicks = 0;
                    const [lx, lz] = this.step.location;
                    walkTo(player, lx + randInt(-5, 5), lz + randInt(-5, 5));
                    this.wanderUntil = World.currentTick + 6; // (AM6: a walk about with no spot)
                }
                return;
            }

            this.state = 'scan';
            this.approachTicks = 0;
            return;
        }

        // ── Scan / engage spot ───────────────────────────────────────────────
        if (this.state === 'scan') {
            if (!this.currentSpot) {
                this.state = 'approach';
                return;
            }
            // port (the realism work, phase 5a): the spot turned into a whirlpool the bot noticed (port/BotRandomEvents): another
            if (isEventHazard(player, this.currentSpot)) {
                this.currentSpot = null;
                this.state = 'approach';
                return;
            }

            this._interact(player, this.currentSpot);
            this.state = 'interact';
            this.interactTicks = 0;
            this.lastXp = player.stats[PlayerStat.FISHING];
            return;
        }

        // ── Fishing loop ─────────────────────────────────────────────────────
        if (this.state === 'interact') {
            this.interactTicks++;

            // port: the fishing goes on by itself while the interaction holds. Upstream clicked the spot again after
            // every catch and after any 8 ticks without one, and a click in the middle of a cast stops it (test/sim.mjs:
            // 75 clicks, 45 casts, 13 catches): it clicks again only once the interaction is gone (the spot moved,
            // or the catch ended it), or after 40 ticks with nothing
            if (player.stats[PlayerStat.FISHING] > this.lastXp) {
                this.lastXp = player.stats[PlayerStat.FISHING];
                this.interactTicks = 0;
                this.watchdog.notifyActivity();
                if (player.target !== null && player.target === this.currentSpot) return;
                // Re-validate the spot — if it moved or despawned, go to approach.
                // port (the realism work): the next click a moment later, as a person's (BotTiming 'retarget')
                const nextSpot = this._findFishSpot(player);
                if (nextSpot && isNear(player, nextSpot.x, nextSpot.z, 2)) {
                    this.currentSpot = nextSpot;
                    this.state = 'scan';
                } else {
                    this.currentSpot = null;
                    this.state = 'approach';
                }
                this.cooldown = humanDelay(player, 'retarget');
                return;
            }

            this.targetGone = player.target === null || player.target !== this.currentSpot ? this.targetGone + 1 : 0;
            if (this.targetGone >= 2 || this.interactTicks >= 40) {
                this.state = 'approach';
                this.currentSpot = null;
                this.interactTicks = 0;
                this.targetGone = 0;
                this.cooldown = humanDelay(player, 'retarget'); // port (the realism work): the spot moved
            }

            // mid-fish depletion
            if (this.step.itemConsumed && !hasItem(player, this.step.itemConsumed)) {
                this.state = 'bank_walk';
            }
        }
    }

    isComplete(_p: Player): boolean {
        // port (variety round 1, F): its wait for a free spot ran out (the planner picks again)
        return this.wait.done;
    }

    override reset(): void {
        super.reset();
        this.wait.reset(this.lastPlayer);
        this.wanderUntil = -1;
        this.stepLevel = -1;
        this.state = 'walk';
        this.interactTicks = 0;
        this.scanFailTicks = 0;
        this.approachTicks = 0;
        this.lastXp = 0;
        this.currentSpot = null;
        this.stuck.reset();
        this.watchdog.reset();
    }

    override getDebugInfo(_player: Player): BotTaskDebugInfo {
        const [lx, lz, ll] = this.step.location;
        return {
            task: this.name,
            state: this.state,
            target: this.currentSpot ? `${NpcType.get(this.currentSpot.type).debugname ?? 'spot'}@(${this.currentSpot.x},${this.currentSpot.z})` : undefined,
            destination: { x: lx, z: lz, level: ll },
            details: {
                itemGained: this.step.itemGained,
                interactTicks: this.interactTicks,
                scanFailTicks: this.scanFailTicks,
                approachTicks: this.approachTicks,
                stuck: this.stuck.getDebugSnapshot()
            }
        };
    }

    // ── Step re-roll ─────────────────────────────────────────────────────────

    /** Pick a fresh random step matching the bot's current level and owned tools. */
    private _rerollStep(player: Player): void {
        const level = getBaseLevel(player, PlayerStat.FISHING);
        // port: and a spot its combat level allows (upstream re-rolled onto Draynor at any level)
        const newStep = getProgressionStepWhere('FISHING', level, s => s.toolItemIds.every(id => hasItem(player, id)) && spotAllowed(player, s));
        if (newStep) this.step = newStep;
    }

    // ── Spot detection ───────────────────────────────────────────────────────

    private _findFishSpot(player: Player): Npc | null {
        // Cage/harpoon spots on Karamja use the _rarefish suffix.
        // Fly-rod fresh-water spots use _freshfish.
        // Net/bait salt-water spots use _saltfish.
        const isRarefish =
            this.step.itemGained === Items.RAW_LOBSTER ||
            this.step.itemGained === Items.RAW_SWORDFISH ||
            this.step.itemGained === Items.RAW_TUNA; // port: Catherby's tuna, the same spots' Harpoon

        const isFreshwater =
            this.step.itemGained === Items.RAW_TROUT ||
            this.step.itemGained === Items.RAW_SALMON;

        // port: sharks at the Fishing Guild's net-and-harpoon spots (_memberfish); upstream looked for _saltfish there,
        // which the guild has none of: Fishing 76+ bots circled the guild (test/knowledge.test.mjs)
        const isShark = this.step.itemGained === Items.RAW_SHARK;
        const suffix = isShark ? '_memberfish' : isRarefish ? '_rarefish' : isFreshwater ? '_freshfish' : '_saltfish';

        // (phase 5a: not a random event's hazard the bot noticed, a whirlpool, whose debugname ends in the same suffix:
        // port/BotRandomEvents)
        return findNpcBySuffix(player.x, player.z, player.level, suffix, 20, npc => !isEventHazard(player, npc));
    }

    private _interact(player: Player, spot: Npc): void {
        // op3 = harpoon (swordfish/tuna) or bait rod.
        // op1 = cage (lobster) or net — handled by default interactNpc().
        const useOp3 =
            this.step.itemConsumed === Items.FISHING_BAIT ||
            this.step.itemGained === Items.RAW_SWORDFISH ||
            this.step.itemGained === Items.RAW_TUNA ||
            this.step.itemGained === Items.RAW_SHARK; // port: Harpoon is the shark spot's op 3

        if (useOp3) interactNpcOp(player, spot, 3);
        else interactNpc(player, spot);
    }

    // ── Banking ──────────────────────────────────────────────────────────────

    private _depositFish(player: Player): void {
        const inv = player.getInventory(InvType.INV);
        const bid = bankInvId();

        if (!inv || bid === -1) return;

        const bank = player.getInventory(bid);
        if (!bank) return;

        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item) continue;

            if (this.step.toolItemIds.includes(item.id)) continue;
            if (item.id === Items.COINS) continue;

            const moved = inv.remove(item.id, item.count);
            if (moved > 0) {
                bank.add(bankedId(item.id), moved);
            }
             console.log(`[FSH:${player.username}] Deposited fish into the bank.`);
        }

    }

    // ── Stuck handling (WC-style upgrade) ────────────────────────────────────

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

        const dx = lx - player.x;
        const dz = lz - player.z;

        const escX =
            player.x +
            (Math.abs(dz) > Math.abs(dx)
                ? randInt(-10, 10)
                : dz > 0
                    ? 10
                    : -10);

        const escZ =
            player.z +
            (Math.abs(dx) > Math.abs(dz)
                ? randInt(-10, 10)
                : dx > 0
                    ? 10
                    : -10);

        // Clear existing (bad) waypoints so the hasWaypoints guard in
        // walkTo() doesn't block this escape recalculation.
        player.clearWaypoints();
        walkTo(player, escX, escZ);
    }
}
