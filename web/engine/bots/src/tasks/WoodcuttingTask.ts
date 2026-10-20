/**
 * WoodcuttingTask.ts
 *
 * Chops trees using real engine loc interactions (APLOC1 = Chop down).
 * Progression: normal trees (level 1) → oaks (15) → willows (30) → yews (60).
 * Sells logs at Lumbridge General Store for coins to fund axe upgrades.
 *
 * Key behaviours:
 *   - PRE-WALKS adjacent to the tree before calling interactLoc().
 *     The engine clears interaction silently if the bot is not operable distance,
 *     so we must be touching the tree face before triggering it.
 *   - Excludes stumps ('treestump'.startsWith('tree') = true — no op1 script).
 *   - StuckDetector catches oscillation as well as stationary stuck.
 *   - Opens nearby fence gates automatically when stuck.
 *   - Level-up upgrades step and re-walks to new area.
 */

import LocType from '#/cache/config/LocType.js';
import {
    BotTask, Player, Loc, InvType,
    walkTo, interactLoc,
    findLocByPrefix, findLocByPrefixWhere, findNpcByName,
    claimLoc, releaseLoc, isLocClaimed,
    hasItem, addItem, isInventoryFull, isNear,
    getBaseLevel, PlayerStat,
    Items, Locations, getProgressionStep,
    teleportToSafety, teleportNear, randInt, bankInvId, INTERACT_TIMEOUT, StuckDetector, ProgressWatchdog,
    isAdjacentToLoc, openNearbyGate, botJitter, advanceBankWalk, hasStrayItems,
    canUseTool, bankCount, withdrawUsableTool, humanDelay, ResourceWait, noteGatherTick, stumpToWaitBy, awayFromSpot,
    approachVerdict, APPROACH_TICKS, treeApproachTile,
} from '#/engine/bot/tasks/BotTaskBase.js';
import { noteEvent } from '#/engine/bot/port/BotChatter.js';
import { bankStop } from '#/engine/bot/port/BotHabits.js';
import type { SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import { levelUpStep } from '#/engine/bot/BotKnowledge.js';
import { getCombatLevel, _wornContains, interactHeldOp, inReachOfLoc } from '#/engine/bot/BotAction.js';
import { noteOutOfReach, outOfReachFor } from '#/engine/bot/tasks/BotTaskBase.js';
import { toolToWield } from '#/engine/bot/port/BotGear.js';
import type { BotTaskDebugInfo } from '#/engine/bot/debug/BotDebugTypes.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { isChoppableTree } from '#/engine/bot/port/BotContent.js';
import { moveItems, bankedId } from '#/engine/bot/port/BotInventoryCompat.js';
import { isEventHazard } from '#/engine/bot/port/BotRandomEvents.js';
// (the realism work's phase 5a, Track F: misclicks, port/BotFumble)
import World from '#/engine/World.js';
import { fumbleDue, fumbled } from '#/engine/bot/port/BotFumble.js';
import { humanAt } from '#/engine/bot/port/BotRude.js';
// (the variety work, round 1, Track D: DO-12 power-dropping, ISS-11 the full pack's re-click)
import { dropOne, dropsHere, dropStats } from '#/engine/bot/port/BotPowerDrop.js';

/** port (phase 5a, Track F: misclicks): a tree of another kind this near (tiles) takes the misclick */
const MISCLICK_TREE_TILES = 3;
/** port (phase 5a): the misclicked tree is let go at its first log or after this long (one swing, its walk there) */
const MISCLICK_TREE_TICKS = 6;

/** Draynor village woodcutting spots — aggressive Dark Wizards patrol here, minimum combat 15. */
const DRAYNOR_WC_LOCATIONS: Array<[number, number, number]> = [
    Locations.WILLOWS_DRAYNOR,
];

/**
 * Draynor's willows under combat 15 (its Dark Wizards): the task refuses the step. (the variety work, round 1, Track D)
 * The planner's pick leaves such a step out too: it drew Draynor's willows for a low-level skiller, the task refused, and
 * the pick went on to the next skill (a fight, a third of a themed woodcutter's picks by Varrock West)
 */
export function woodcutStepRefused(player: Player, step: SkillStep): boolean {
    const [sx, sz, sl] = step.location;
    return DRAYNOR_WC_LOCATIONS.some(([lx, lz, ll]) => lx === sx && lz === sz && ll === sl) && getCombatLevel(player) < 15;
}

export class WoodcuttingTask extends BotTask {
    private step: SkillStep;
    /** port: the level the step was last checked against (BotKnowledge.levelUpStep runs when it rises) */
    private stepLevel = -1;

    /**
     * State machine:
     *   walk      → walking to tree area
     *   approach  → found a tree, walking adjacent to it
     *   interact  → adjacent, interaction queued, waiting for XP
     *   bank_walk → walking to sell logs
     *   bank_done → logs sold, return to walk
     */
    private state: 'walk' | 'approach' | 'interact' | 'bank_walk' | 'bank_done' | 'misclick' | 'drop' = 'walk';
    /** port (phase 5a, Track F: misclicks): the tree of another kind it clicked by mistake, when, its XP then */
    private misclickTree: Loc | null = null;
    private misclickAt = 0;
    private misclickXp = 0;
    private interactTicks  = 0;
    private lastXp         = 0;
    private scanFailTicks  = 0;
    private approachTicks  = 0;   // ticks spent approaching a tree
    /** port (the variety work, round 2, the fixes): rounds of APPROACH_TICKS walked on to this tree, a route reaching it (approachVerdict) */
    private approachRounds = 0;
    private currentTree:  Loc | null = null;
    private readonly stuck    = new StuckDetector(30, 4, 2);
    private readonly watchdog = new ProgressWatchdog();
    /** port (the variety work, round 1, track F: DO-3): every tree of its kind felled: it waits beside a stump (ResourceWait) */
    private readonly wait = new ResourceWait('Woodcut');
    /** port (variety round 1, F): walking to a random tile with no tree (AM6), until this tick */
    private wanderUntil = -1;
    private lastPlayer: Player | null = null;
    /** port (the variety work, round 1, track W: WEAR-3): a wielder's axe was looked to at the task's start (20: done) */
    private toolWielded = 0;
    /** port (the variety work): the weapon the wield put in its pack (kept there, not banked as a stray item) */
    private stowedWeapon = -1;

    constructor(step: SkillStep) {
        // Include the log type so the rescan name-comparison in BotPlayer
        // can distinguish "cut trees for LOGS" from "cut willows for WILLOW_LOGS"
        // and force a task switch when the planner needs a different log type.
        super(`Woodcut:${step.itemGained}`);
        this.step = step;
        this.watchdog.follow(() => this.step.location);
    }

    override activityStep(): SkillStep | null {
        return this.step;
    }

    shouldRun(player: Player): boolean {
        // port: an axe its Woodcutting level allows (274 passes over the others)
        const hasHatchetInv  = this._hatchetCarried(player);
        const hasHatchetBank = !hasHatchetInv && this._hatchetInBank(player);
        if (!hasHatchetInv && !hasHatchetBank) return false;

        // Draynor village has aggressive Dark Wizards — require combat level 15
        if (woodcutStepRefused(player, this.step)) return false;

        return true;
    }

    private _hatchetInBank(player: Player): boolean {
        return this.step.toolItemIds.some(id => canUseTool(player, id) && bankCount(player, id) > 0);
    }

    private _hatchetCarried(player: Player): boolean {
        // port (the variety work, round 1, track W: WEAR-3): or in its hand (half the woodcutters wield theirs at the
        // trees: port/BotGear dressForSkill; 274's woodcut.rs2 takes a worn axe)
        return this.step.toolItemIds.some(id => (hasItem(player, id) || _wornContains(player, id)) && canUseTool(player, id));
    }

    tick(player: Player): void {
        if (this.interrupted) return;
        this.lastPlayer = player;
        noteGatherTick('Woodcut', World.currentTick < this.wanderUntil);
        // port (variety round 1, F): a wait at its felled trees that ran out ends the task (isComplete)
        if (this.wait.done) return;
        const banking = this.state === 'bank_walk' || this.state === 'bank_done';
        if (this.watchdog.check(player, banking)) {
            player.clearWaypoints();
            player.clearPendingAction();
            this.stuck.reset();
            this.state = 'approach';
            this._releaseTree();
            this.interactTicks = 0;
            this.scanFailTicks = 0;
            this.approachTicks = 0;
            this.cooldown = 3;
            return;
        }
        // (the variety work, round 1, Track D: ISS-11) the log that filled the pack during a pause (a retarget's moment
        // after a stump or a long wait, while the swing went on): the swing let go all the same, or the tree's next cycle
        // says "too full to hold any more logs"
        // (the variety work, round 2, the fixes: and the pause is over, the bank or the drop at once, as for the log in
        // 'interact': a chop's timeout paused a bot 7 ticks while its swing went on, the log filled the pack, and it stood
        // out the rest of the pause first)
        if (this.cooldown > 0 && (this.state === 'interact' || this.state === 'approach') && isInventoryFull(player)) {
            if (player.target !== null) player.clearPendingAction();
            this.cooldown = 0;
        }
        if (this.cooldown > 0) { this.cooldown--; return; }

        // port (the variety work, round 1, track W: WEAR-3): half the bots take their axe in hand at the task's start (the
        // real wear op: its weapon into the pack, banked at the next bank stop; port/BotGear toolToWield, dressForSkill)
        // (tried again while a delay holds the bot, 20 ticks at most; the weapon it put in its pack is no stray item to bank)
        if (this.toolWielded < 20) {
            const slot = toolToWield(player, 'axe');
            const inv = player.getInventory(InvType.INV);
            const tool = slot === null ? undefined : inv?.get(slot);
            const held = player.getInventory(InvType.WORN)?.get(3)?.id ?? -1;
            const wielded = !!inv && !!tool && slot !== null && interactHeldOp(player, inv, tool.id, slot, 2);
            if (wielded) this.stowedWeapon = held;
            this.toolWielded = !inv || !tool || slot === null || wielded ? 20 : this.toolWielded + 1;
        }

        // ── Hatchet recovery ─────────────────────────────────────────────────
        // If the hatchet was banked by another task, go retrieve it before chopping.
        // port: not once at the bank: this sent the bot from 'bank_done' (where the hatchet is withdrawn) back to
        // 'bank_walk' every tick, and it stood at the bank for good
        if (this.state !== 'bank_walk' && this.state !== 'bank_done' && !this._hatchetCarried(player) && this._hatchetInBank(player)) {
            this.state = 'bank_walk';
        }

        // port: a monster that attacks the bot is BotPlayer's to answer (port/BotDefence: it fights off a weak one and
        // runs from the rest, for every task but the fights). Upstream ran here only from a stronger one, to the middle
        // of the spot, where the bot mostly was already: Lumbridge's giant spiders bit woodcutters to death

        // Upgrade step when level-up unlocks a better tree tier.
        // Skip Draynor steps for low-combat bots — Dark Wizards are aggressive there.
        // port: only when the level rose, and only off a step the level has outgrown (BotKnowledge.levelUpStep); upstream
        // drew a random step every tick and jumped to any with a higher minimum, tools or not
        const level   = getBaseLevel(player, PlayerStat.WOODCUTTING);
        if (this.stepLevel === -1) this.stepLevel = level;
        const newStep = level > this.stepLevel ? levelUpStep('WOODCUTTING', this.step, level, s => s.toolItemIds.some(id => hasItem(player, id) || _wornContains(player, id)), [player.x, player.z]) : null;
        this.stepLevel = level;
        if (newStep && newStep !== this.step) {
            const [sx, sz, sl] = newStep.location;
            const isNewDraynor = DRAYNOR_WC_LOCATIONS.some(([lx, lz, ll]) => lx === sx && lz === sz && ll === sl);
            if (!isNewDraynor || getCombatLevel(player) >= 15) {
                this.step         = newStep;
                this.state        = 'walk';
                this._releaseTree();
            }
        }

        // ── Bank logs ─────────────────────────────────────────────────────────
        if (this.state === 'bank_walk') {
            const result = advanceBankWalk(player, this.stuck);
            if (result === 'walk') return;
            // 'ready' = interaction queued; 'direct' = deposit without UI
            // port (the realism work): a person's stop at the booth, never the same twice (port/BotHabits.bankStop)
            this.cooldown = result === 'ready' ? bankStop(player) : 0;
            this.state = 'bank_done';
            return;
        }

        if (this.state === 'bank_done') {
            this._depositLoot(player);
            // port: the spot holds for the plan (15-60 minute plans; a level-up still moves it on). Upstream
            // drew a random spot after every load, often across the map
            this.state = 'walk'; this.cooldown = 3; return;
        }

        // ── A full pack (the variety work, round 1, Track D: its own branch) ─────
        // (DO-12) a power-trainer drops its logs one by one where it stands, at a person's pace, and chops on
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
        if (isInventoryFull(player)) { this._packFull(player); return; }

        // Carrying leftovers from a previous task (e.g. ore, loot) — bank them
        // before heading out to the tree so the trip starts with a clean slate.
        if (this.state === 'walk' && hasStrayItems(player, [...this.step.toolItemIds, Items.COINS, Items.KNIFE, Items.TINDERBOX, this.stowedWeapon])) {
            this.state = 'bank_walk';
            return;
        }

        // ── Walk to tree area ─────────────────────────────────────────────────
        if (this.state === 'walk') {
            const [lx, lz, ll] = this.step.location;
            if (!isNear(player, lx, lz, 15, ll)) {
                // Via waypoint: route through intermediate coord before destination.
                // Used to steer around obstacles (e.g. Draynor Mansion for Barbarian
                // Village willows).  Only apply when the bot hasn't yet passed it —
                // check player.z so a bot already north of the waypoint skips it.
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
            this.state = 'approach'; // arrived — now find and approach a tree
            return;
        }

        // ── A misclick (port, the realism work, phase 5a, Track F) ────────────
        // port: the tree of another kind beside its own, clicked by mistake: one swing at most (its first log, or
        // MISCLICK_TREE_TICKS), then its own tree a person's moment later
        if (this.state === 'misclick') {
            const now = World.currentTick;
            const done = player.stats[PlayerStat.WOODCUTTING] > this.misclickXp || now - this.misclickAt >= MISCLICK_TREE_TICKS || (player.target !== this.misclickTree && now - this.misclickAt >= 2);
            if (!done) return;
            if (player.target === this.misclickTree) player.clearPendingAction();
            this.misclickTree = null;
            this.state = 'approach';
            this.cooldown = 1 + humanDelay(player, 'retarget');
            return;
        }

        // ── Find tree and walk adjacent ───────────────────────────────────────
        if (this.state === 'approach') {
            // If we just became full, bank first
            if (isInventoryFull(player)) { this._packFull(player); return; }

            // Drop stale reference if another player felled the tree
            if (this.currentTree && !this._isTreeStillValid(this.currentTree)) {
                this._releaseTree();
                this.approachTicks = 0;
            }

            // port (the variety work, round 1, track F: DO-3): waiting by a stump, it looks again a person's moment later
            if (!this.currentTree && this.wait.holding()) return;
            const tree = this.currentTree ?? this._findTree(player);
            if (!tree) {
                // (only at its spot: away from it, a sub-task's errand over, a party's or a "come here", it walks back first;
                // a wait under way reaches a stump or rock up to 15 tiles off: within WAIT_SPOT_TILES it stays)
                if (awayFromSpot(player, this.step.location, this.wait)) {
                    this.state = 'walk';
                    return;
                }
                this.scanFailTicks++;
                if (this.scanFailTicks === 1) {
                    console.log(`[WC:${player.username}] No '${this._treePrefix()}' tree near (${player.x},${player.z})`);
                }
                // port (variety round 1, F): every tree of its kind near is a stump: it waits beside the nearest (274 grows
                // them back), and after 2-4 minutes moves on (its task ends). Upstream wandered to a random tile within 5 of
                // the spot every 11 ticks
                this.wait.none(player, this._stumpNear(player), () => noteEvent(player, 'tree-taken'));
                this.watchdog.notifyActivity(); // (the wait decides when it moves on, with its word: not the watchdog)
                return;
            }
            this.wait.found(player);
            this.scanFailTicks = 0;
            this.currentTree   = tree;
            claimLoc(tree);

            // (the fixes) beside it but across a fence or wall: out of its reach, another tree
            if (isAdjacentToLoc(player, tree) && !inReachOfLoc(player, tree) && !player.hasWaypoints()) {
                noteOutOfReach(player, tree);
                this._releaseTree();
                return;
            }
            if (isAdjacentToLoc(player, tree)) {
                // port (phase 5a, Track F: misclicks): now and then the click lands on a tree of another kind beside it first
                // (harmless: no Woodcutting level in 274, a log of the wrong kind at most; port/BotFumble)
                if (fumbleDue(player)) {
                    const wrong = this._wrongTree(player, tree);
                    if (wrong) {
                        interactLoc(player, wrong);
                        fumbled(player, 'tree');
                        this.misclickTree = wrong;
                        this.misclickAt = World.currentTick;
                        this.misclickXp = player.stats[PlayerStat.WOODCUTTING];
                        this.state = 'misclick';
                        return;
                    }
                }
                // Already adjacent — interact immediately
                console.log(`[WC:${player.username}] Adjacent to '${this._treePrefix()}' at (${tree.x},${tree.z}), interacting`);
                interactLoc(player, tree);
                this.state         = 'interact';
                this.interactTicks = 0;
                this.lastXp        = player.stats[PlayerStat.WOODCUTTING];
                this.approachTicks = 0;
            } else {
                // Walk to the tile directly adjacent to the tree's nearest face
                const [tx, tz] = this._approachTile(player, tree);
                walkTo(player, tx, tz);
                this.approachTicks++;
                if (this.approachTicks > APPROACH_TICKS) {
                    // (the variety work, round 2, the fixes: a long way round is no fence: walked on while a route reaches it)
                    const way = approachVerdict(player, tree, this.approachRounds);
                    if (way === 'wait') return;
                    if (way === 'walk') {
                        this.approachRounds++;
                        this.approachTicks = 0;
                        return;
                    }
                    // Can't reach this tree — try another
                    console.log(`[WC:${player.username}] Can't reach tree at (${tree.x},${tree.z}), retrying`);
                    noteOutOfReach(player, tree); // (the fixes: and not this one again for a while)
                    this._releaseTree();
                    this.approachTicks = 0;
                    const [lx, lz] = this.step.location;
                    walkTo(player, lx + randInt(-5, 5), lz + randInt(-5, 5));
                    this.wanderUntil = World.currentTick + 6; // (AM6: a walk about with no tree)
                }
            }
            return;
        }

        // ── Chopping ──────────────────────────────────────────────────────────
        if (this.state === 'interact') {
            this.interactTicks++;

            // port: the log first: the one that fells a tree (every normal tree's only one) arrives with the stump,
            // and upstream looked at the stump first, so that log never fed the watchdog, which teleported a bot
            // chopping normal trees every 300 ticks. And the chopping goes on by itself while the interaction holds
            // (upstream clicked the tree again after every log, restarting the swing)
            if (player.stats[PlayerStat.WOODCUTTING] > this.lastXp) {
                console.log(`[WC:${player.username}] XP gained! total=${player.stats[PlayerStat.WOODCUTTING]}`);
                this.lastXp        = player.stats[PlayerStat.WOODCUTTING];
                this.interactTicks = 0;
                this.watchdog.notifyActivity();
                // (the variety work, round 1, Track D: ISS-11) the log that filled the pack: no click on the tree again
                // ("Your inventory is too full to hold any more logs", 45 an hour), the bank or the drop at once
                if (isInventoryFull(player)) { this._packFull(player); return; }
                if (this.currentTree && this._isTreeStillValid(this.currentTree) && player.target !== this.currentTree) interactLoc(player, this.currentTree);
                return;
            }

            // Tree was felled mid-chop by another player — rescan immediately
            // port (the realism work): a moment later, as a person notices the stump (BotTiming 'retarget'; upstream
            // and the port before clicked the next tree in the same tick)
            if (this.currentTree && !this._isTreeStillValid(this.currentTree)) {
                this.state        = 'approach';
                this._releaseTree();
                this.interactTicks = 0;
                this.cooldown = humanDelay(player, 'retarget');
                return;
            }

            if (this.interactTicks >= INTERACT_TIMEOUT) {
                // Tree depleted or interaction was cleared — find another
                console.log(`[WC:${player.username}] Interact timeout, rescanning`);
                this.state        = 'approach';
                this._releaseTree();
                this.interactTicks = 0;
                this.cooldown = humanDelay(player, 'retarget');
            }
        }
    }

    // port (variety round 1, F): its wait at the felled trees ran out (the planner picks again)
    isComplete(_p: Player): boolean { return this.wait.done; }

    /**
     * (the variety work, round 1, Track D: DO-12, ISS-11) the pack is full: the swing is let go (a player clicks away, so
     * the tree's next swing gives no "too full"), and a power-trainer drops its logs (port/BotPowerDrop), the rest bank
     */
    private _packFull(player: Player): void {
        player.clearPendingAction();
        this._releaseTree();
        if (dropsHere(player, this.step)) {
            dropStats.loads++;
            this.state = 'drop';
            this.cooldown = humanDelay(player, 'retarget');
            return;
        }
        this.state = 'bank_walk';
    }

    override getDebugInfo(_player: Player): BotTaskDebugInfo {
        const [lx, lz, ll] = this.step.location;
        return {
            task: this.name,
            state: this.state,
            target: this.currentTree ? `${LocType.get(this.currentTree.type).debugname ?? 'tree'}@(${this.currentTree.x},${this.currentTree.z})` : undefined,
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

    override reset(): void {
        super.reset();
        this.wait.reset(this.lastPlayer);
        this.wanderUntil   = -1;
        this.stepLevel     = -1;
        this.state         = 'walk';
        this.interactTicks = 0;
        this.scanFailTicks = 0;
        this.approachTicks = 0;
        this.lastXp        = 0;
        this._releaseTree();
        this.misclickTree  = null;
        this.stuck.reset();
        this.watchdog.reset();
    }

    // ── Tree search ───────────────────────────────────────────────────────────

    private _findTree(player: Player): Loc | null {
        // 'treestump'.startsWith('tree') = true — must exclude stumps.
        // Stumps have no [oploc1] script so the woodcutting script silently fails.
        // Prefer a tree nobody else is on, so nearby bots spread across the
        // grove instead of all converging on the single nearest tree
        // (findLocByPrefix alone always returns the exact same closest match
        // for bots standing in roughly the same spot). But if every tree in
        // range is already claimed, fall back to the closest one regardless —
        // better to share a tree than to sit scanning forever finding nothing.
        // port: and only a tree that can be chopped (274's 'tree' prefix also matches walls, doors and rope swings)
        // (phase 5a: and not a random event's hazard the bot noticed, an ent: port/BotRandomEvents)
        // (the fixes: and not one it found out of its reach, or in a members' area on a free world: outOfReachFor)
        const unclaimed = findLocByPrefixWhere(player.x, player.z, player.level, this._treePrefix(), 15, loc => !isLocClaimed(loc) && isChoppableTree(loc) && !isEventHazard(player, loc) && !outOfReachFor(player, loc), 'stump');
        if (unclaimed) return unclaimed;
        return findLocByPrefixWhere(player.x, player.z, player.level, this._treePrefix(), 15, loc => isChoppableTree(loc) && !isEventHazard(player, loc) && !outOfReachFor(player, loc), 'stump');
    }

    /**
     * port (phase 5a, Track F: misclicks): a choppable tree of another kind than its own, beside the bot, that no one else
     * chops (null: none). Another bot's or the human's normal tree fell at the misclick's first log (274's woodcut.rs2: a
     * normal tree's deplete chance is 0), a stump where they were chopping.
     */
    private _wrongTree(player: Player, own: Loc): Loc | null {
        const prefix = this._treePrefix();
        return findLocByPrefixWhere(player.x, player.z, player.level, '', MISCLICK_TREE_TILES, loc => {
            if (loc === own || !isChoppableTree(loc) || isEventHazard(player, loc) || isLocClaimed(loc) || humanAt(loc) !== null) return false;
            const name = LocType.get(loc.type).debugname ?? '';
            return !name.startsWith(prefix) && !name.includes('stump') && Math.max(Math.abs(loc.x - player.x), Math.abs(loc.z - player.z)) <= MISCLICK_TREE_TILES;
        });
    }

    /** port (the variety work, round 1, track F: DO-3): a stump to wait by: the one it waits by, at a look round another within 8 tiles, the first the nearest within 15; or null */
    private _stumpNear(player: Player): Loc | null {
        return stumpToWaitBy(player, this.wait);
    }

    /** Release the currently claimed tree (if any) so other bots can target it. */
    private _releaseTree(): void {
        releaseLoc(this.currentTree);
        this.currentTree = null;
        this.approachRounds = 0;
    }

    /**
     * Returns false if the stored tree reference has been replaced by a stump
     * (another player felled it while this bot was approaching or chopping).
     */
    private _isTreeStillValid(tree: Loc): boolean {
        const name = LocType.get(tree.type).debugname ?? '';
        return name.startsWith(this._treePrefix()) && !name.includes('stump');
    }

    private _treePrefix(): string {
        switch (this.step.itemGained) {
            case Items.OAK_LOGS:    return 'oaktree';
            case Items.WILLOW_LOGS: return 'willowtree';
            case Items.MAPLE_LOGS:  return 'mapletree';
            case Items.YEW_LOGS:    return 'yewtree';
            case Items.MAGIC_LOGS:  return 'magictree';
            default:                return 'tree';
        }
    }

    /**
     * Returns the tile the bot should walk to in order to be adjacent to the tree.
     * Picks the nearest face of the loc's bounding box, offset by 1 tile outward.
     */
    private _approachTile(player: Player, tree: Loc): [number, number] {
        // port (the variety work, round 2, the fixes): a tile it chops the tree from (BotTaskBase.treeApproachTile); the
        // nearest face's below only when none is
        const reach = treeApproachTile(player, tree);
        if (reach) return reach;
        // Tree occupies [tree.x .. tree.x+width-1] x [tree.z .. tree.z+length-1]
        const w = 2; const l = 2; // normal trees are always 2x2

        // Find closest point on the bounding box to the player
        const closestX = Math.max(tree.x, Math.min(player.x, tree.x + w - 1));
        const closestZ = Math.max(tree.z, Math.min(player.z, tree.z + l - 1));

        // Step 1 tile away from that point toward the player
        const dx = player.x - closestX;
        const dz = player.z - closestZ;

        if (Math.abs(dx) >= Math.abs(dz)) {
            return [closestX + Math.sign(dx), closestZ];
        } else {
            return [closestX, closestZ + Math.sign(dz)];
        }
    }

    // ── Step re-roll ─────────────────────────────────────────────────────────

    /** Pick a fresh random step matching the bot's current level and owned tools. */
    private _rerollStep(player: Player): void {
        const level = getBaseLevel(player, PlayerStat.WOODCUTTING);
        const combatLvl = getCombatLevel(player);
        const newStep = getProgressionStep(
            'WOODCUTTING', level,
            ids => ids.some(id => hasItem(player, id) || _wornContains(player, id)),
        );
        if (newStep) {
            const [sx, sz, sl] = newStep.location;
            const isDraynor = DRAYNOR_WC_LOCATIONS.some(([lx, lz, ll]) => lx === sx && lz === sz && ll === sl);
            if (!isDraynor || combatLvl >= 15) {
                this.step = newStep;
                this._releaseTree();
            }
        }
    }

        private _depositLoot(player: Player): void {
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
            if (item.id === Items.KNIFE) continue;
            if (item.id === Items.TINDERBOX) continue;
            const moved = inv.remove(item.id, item.count);
            if (moved > 0) bank.add(bankedId(item.id), moved);
        }
        // Withdraw hatchet if it was banked by another task (e.g. FletchingTask)
        // port: the best one its level allows (toolItemIds run best first)
        if (!this._hatchetCarried(player)) withdrawUsableTool(player, this.step.toolItemIds);
        console.log(`[WC:${player.username}] Deposited logs into the bank.`);
    }

    // ── Stuck walk with gate opener ───────────────────────────────────────────

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

        const dx   = lx - player.x;
        const dz   = lz - player.z;
        const escX = player.x + (Math.abs(dz) > Math.abs(dx) ? randInt(-10, 10) : (dz > 0 ? 10 : -10));
        const escZ = player.z + (Math.abs(dx) > Math.abs(dz) ? randInt(-10, 10) : (dx > 0 ? 10 : -10));
        walkTo(player, escX, escZ);
    }
}
