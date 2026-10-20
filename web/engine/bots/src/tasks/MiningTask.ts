/**
 * MiningTask.ts — Mine rocks, bank ore, progress through tiers.
 */

import {
    BotTask,
    Player,
    Loc,
    InvType,
    walkTo,
    interactLoc,
    interactLocOp,
    findLocByPrefix,
    findLocByPrefixWhere,
    hasItem,
    isInventoryFull,
    isNear,
    isAdjacentToLoc,
    getBaseLevel,
    PlayerStat,
    Items,
    Locations,
    getProgressionStep,
    teleportToSafety,
    teleportNear,
    randInt,
    bankInvId,
    INTERACT_TIMEOUT,
    StuckDetector,
    ProgressWatchdog,
    openNearbyGate,
    botJitter,
    advanceBankWalk,
    hasStrayItems,
    fareShort,
    withdrawFare,
    canUseTool,
    bankCount,
    withdrawUsableTool,
    claimLoc,
    releaseLoc,
    isLocClaimed,
    humanDelay,
    ResourceWait,
    noteGatherTick,
    awayFromSpot,
} from '#/engine/bot/tasks/BotTaskBase.js';
import { bankStop } from '#/engine/bot/port/BotHabits.js';
import type { SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import { levelUpStep } from '#/engine/bot/BotKnowledge.js';
import type { BotTaskDebugInfo } from '#/engine/bot/debug/BotDebugTypes.js';
import LocType from '#/cache/config/LocType.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { bankedId } from '#/engine/bot/port/BotInventoryCompat.js';
import { isEventHazard } from '#/engine/bot/port/BotRandomEvents.js';
// (the realism work's phase 5a, Track F: misclicks, port/BotFumble; the human's rock and rock-stealing, port/BotRude)
import World from '#/engine/World.js';
import { fumbleDue, fumbled } from '#/engine/bot/port/BotFumble.js';
import { isCrossing, _wornContains, interactHeldOp } from '#/engine/bot/BotAction.js';
import { toolToWield } from '#/engine/bot/port/BotGear.js';
import { claimArgument, courtesy, humansNow, maySteal, noteSteal, rollFor, rudeActs, rudeRates, ROCK_LAZY_TILES, ROCK_ROLL_TICKS, ROCK_WAIT_TICKS } from '#/engine/bot/port/BotRude.js';
import { argue, noteEvent } from '#/engine/bot/port/BotChatter.js';
// (the variety work, round 1, Track D: DO-12 power-dropping; the dwarven mine and the Mining Guild's way down)
import { dropOne, dropsHere, dropStats } from '#/engine/bot/port/BotPowerDrop.js';
import { dungeonLeg } from '#/engine/bot/port/BotDungeons.js';

/**
 * port: the rocks (274 debugnames, without the 1/2 variant) of each ore a mining step gains. Upstream chose rocks by
 * Mining level alone (30-54: coal and iron): a bot sent to the Karamja gold mine looked for coal there and stood at the
 * rocks for good.
 */
const ORE_ROCKS: Record<number, string> = {
    [Items.COPPER_ORE]: 'copperrock',
    [Items.TIN_ORE]: 'tinrock',
    [Items.IRON_ORE]: 'ironrock',
    [Items.COAL]: 'coalrock',
    [Items.GOLD_ORE]: 'goldrock',
    [Items.MITHRIL_ORE]: 'mithrilrock',
    [Items.ADAMANTITE_ORE]: 'adamantiterock',
    [Items.RUNITE_ORE]: 'runiterock',
    [Items.CLAY]: 'clayrock'
};

/** port: how long a rock the bot could not get at twice is passed over (task ticks) */
const ROCK_BAN_TICKS = 500;
/** port: how long the bot waits on a rock while it is still mining it (the interaction holds) before clicking again */
const MINE_HOLD_TICKS = 60;
/** port (the realism work, phase 5a, Track F: misclicks): an empty rock this near (tiles) takes the misclick */
const MISCLICK_ROCK_TILES = 4;
/** port (phase 5a): an empty rock's names in 274 (the one a mined rock becomes: next_loc_stage_mining) */
const EMPTY_ROCK = /^rocks[0-9]$/;
/** port (phase 5a, Track F): a rude miner that took the human's rock says something to the human after its ore this often */
const STEALER_GLOAT = 0.3;
/**
 * port (phase 5a, Track F: the courtesy): the rocks humans mine, and when each was last their target: a human's mining
 * lets go of the rock between two swings now and then (a tick), and a polite bot took it in that moment. A rock the human
 * stands beside and mined within HUMAN_ROCK_TICKS is theirs.
 */
const HUMAN_ROCKS = new Map<Loc, { tick: number; human: Player }>();
const HUMAN_ROCK_TICKS = 10;

export class MiningTask extends BotTask {
    private step: SkillStep;
    /** port: the level the step was last checked against (BotKnowledge.levelUpStep runs when it rises) */
    private stepLevel = -1;
    /** port: rocks (x,z) the bot could not get at: how often, and the task tick of the last time */
    private readonly rockMisses = new Map<string, [number, number]>();
    /** port: the current rock's type when it was chosen (274 changes a mined-out rock's type in place) */
    private rockType = -1;
    private taskTicks = 0;
    /** port: ticks in a row the bot's interaction has been gone while mining */
    private targetGone = 0;

    private state: 'walk' | 'approach' | 'scan' | 'interact' | 'bank_walk' | 'bank_done' | 'drop' = 'walk';

    private interactTicks = 0;
    private lastXp = 0;
    private scanFailTicks = 0;
    private approachTicks = 0;

    private currentRock: Loc | null = null;
    private viaLocation?: [number, number, number];
    /** port (phase 5a, Track F: misclicks): the empty rock it clicked by mistake, and when */
    private misclickRock: Loc | null = null;
    private misclickAt = 0;
    /** port (phase 5a, Track F: rock-stealing): the rock it took from someone (no claim of its own: theirs stays) and from whom */
    private stolen: { rock: Loc; victim: Player } | null = null;
    /** port (phase 5a): since when (task ticks) it has found no free rock of its ore (-1: it has one), and its steal's roll */
    private noFreeSince = -1;
    private readonly stealRoll = {};

    private readonly stuck = new StuckDetector(30, 4, 2);
    private readonly watchdog = new ProgressWatchdog();
    /** port (the variety work, round 1, track F: DO-3): every rock of its ore taken: it waits beside one (ResourceWait) */
    // (it prospects the rock it waits by now and then: one another miner works, "This rock contains tin.", never an empty
    // one: a mined-out rock let go is BotChatter's sign of a rock lost; by a mined-out one it moves round to another)
    private readonly wait = new ResourceWait('Mine', undefined, (player, rock) => {
        if (EMPTY_ROCK.test(LocType.get(rock.type).debugname ?? '')) return false;
        interactLocOp(player, rock, 2);
        return true;
    });
    /** port (variety round 1, F): walking to a random tile with no rock (AM6), until this tick */
    private wanderUntil = -1;
    private lastPlayer: Player | null = null;
    /** port (the variety work, round 1, track W: WEAR-3): a wielder's pickaxe was looked to at the task's start (20: done) */
    private toolWielded = 0;
    /** port (the variety work): the weapon the wield put in its pack (kept there, not banked as a stray item) */
    private stowedWeapon = -1;
    /**
     * (the variety work, round 2, the fixes) a Wilderness trip's mine (port/BotWildTrips): its rocks hold for the trip, no
     * level-up moves it on (the step outgrown at the first level-up took the miner out of the Wilderness for the rest of
     * the trip)
     */
    holdStep = false;

    constructor(step: SkillStep) {
        super('Mine');
        this.step = step;
        this.viaLocation = step.via;
        this.watchdog.follow(() => this.step.location);
    }

    override activityStep(): SkillStep | null {
        return this.step;
    }

    shouldRun(player: Player): boolean {
        // port: a pickaxe its Mining level allows, carried or in the bank (another task's bank trip may have put it
        // there: upstream then bought a bronze pickaxe and mined with it, or with none never mined)
        return this._pickaxeCarried(player) || this.step.toolItemIds.some(id => canUseTool(player, id) && bankCount(player, id) > 0);
    }

    private _pickaxeCarried(player: Player): boolean {
        // port (the variety work, round 1, track W: WEAR-3): or in its hand (half the miners wield theirs at the rocks:
        // port/BotGear dressForSkill; 274's pickaxe_checker.rs2 takes a worn pickaxe)
        return this.step.toolItemIds.some(id => (hasItem(player, id) || _wornContains(player, id)) && canUseTool(player, id));
    }

    tick(player: Player): void {
        if (this.interrupted) return;
        this.taskTicks++;
        this.lastPlayer = player;
        noteGatherTick('Mine', World.currentTick < this.wanderUntil);
        // port (variety round 1, F): a wait at a taken rock that ran out ends the task (isComplete); nothing more to do
        if (this.wait.done) return;

        const banking = this.state === 'bank_walk' || this.state === 'bank_done';
        if (this.watchdog.check(player, banking)) {
            player.clearWaypoints();
            player.clearPendingAction();
            this.stuck.reset();
            this.state = 'approach';
            this._setRock(null);
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

        // port (the variety work, round 1, track W: WEAR-3): half the bots take their pickaxe in hand at the task's start (the
        // real wear op: its weapon into the pack, banked at the next bank stop; port/BotGear toolToWield, dressForSkill)
        // (tried again while a delay holds the bot, 20 ticks at most; the weapon it put in its pack is no stray item to bank)
        if (this.toolWielded < 20) {
            const slot = toolToWield(player, 'pickaxe');
            const inv = player.getInventory(InvType.INV);
            const tool = slot === null ? undefined : inv?.get(slot);
            const held = player.getInventory(InvType.WORN)?.get(3)?.id ?? -1;
            const wielded = !!inv && !!tool && slot !== null && interactHeldOp(player, inv, tool.id, slot, 2);
            if (wielded) this.stowedWeapon = held;
            this.toolWielded = !inv || !tool || slot === null || wielded ? 20 : this.toolWielded + 1;
        }

                // port: a monster that attacks the bot is BotPlayer's to answer (port/BotDefence: it fights off a weak one and
        // runs from the rest, for every task but the fights). Upstream ran here only from a stronger one, to the middle
        // of the spot, where the bot mostly was already: Lumbridge's giant spiders bit woodcutters to death

        // ── Progression upgrade ─────────────────────────────────────────────
        // port: only when the level rose, and only off a step the level has outgrown (BotKnowledge.levelUpStep); upstream
        // drew a random step every tick and jumped to any with a higher minimum, tools or not
        const level = getBaseLevel(player, PlayerStat.MINING);
        if (this.stepLevel === -1) this.stepLevel = level;
        const newStep = level > this.stepLevel && !this.holdStep ? levelUpStep('MINING', this.step, level, undefined, [player.x, player.z]) : null;
        this.stepLevel = level;

        if (newStep && newStep !== this.step) {
            this.step = newStep;
            this.state = 'walk';
            this._setRock(null);
        }

        // port: the pickaxe is in the bank: fetch it first
        if (this.state !== 'bank_walk' && this.state !== 'bank_done' && !this._pickaxeCarried(player)) {
            this.state = 'bank_walk';
            this._setRock(null);
        }

        // ── Banking ──────────────────────────────────────────────────────────
        if (this.state === 'bank_walk') {
            const result = advanceBankWalk(player, this.stuck);
            if (result === 'walk') return;
            // port (the realism work): a person's stop at the booth, never the same twice (port/BotHabits.bankStop)
            this.cooldown = result === 'ready' ? bankStop(player) : 0;
            this.state = 'bank_done';
            return;
        }

        if (this.state === 'bank_done') {
            this._depositOre(player);
            if (!this._pickaxeCarried(player)) withdrawUsableTool(player, this.step.toolItemIds); // port
            withdrawFare(player, ...this.step.location); // port: the Karamja boat's, there and back
            // port: the spot holds for the plan (15-60 minute plans; a level-up still moves it on). Upstream
            // drew a random spot after every load, often across the map
            this.state = 'walk';
            this.cooldown = 3;
            return;
        }

        // ── A full pack (the variety work, round 1, Track D: its own branch) ─────
        // (DO-12) a power-trainer drops its iron one by one where it stands, at a person's pace, and mines on
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
            this._setRock(null);
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
        // out to the rock so the trip starts with a clean slate.
        // port: or the boat's fare is in the bank (Karamja: 30 coins each way). port (the realism work, phase 5a): not on the
        // boat (the fare paid, its tile still the quay's: "short", it went back the moment it landed; FishingTask's too)
        if (this.state === 'walk' && (hasStrayItems(player, [...this.step.toolItemIds, Items.COINS, this.stowedWeapon]) || (!player.delayed && !isCrossing(player) && fareShort(player, ...this.step.location)))) {
            this.state = 'bank_walk';
            return;
        }

        // ── Walk to mining area ─────────────────────────────────────────────
        if (this.state === 'walk') {
            const [lx, lz, ll] = this.step.location;

            if (!isNear(player, lx, lz, 15, ll)) {
                // (the variety work, round 1, Track D) a mine underground (the dwarven mine, the Mining Guild): its way
                // down as a player takes it (port/BotDungeons: the Falador stairs, the Ice Mountain trapdoor, the guild's
                // ladder), then the walk below
                if (dungeonLeg(player, lx, lz, (x, z) => this._stuckWalk(player, x, z))) return;
                // Via waypoint: route through intermediate coord before destination.
                // Used to steer around obstacles (e.g. Draynor Mansion for Barbarian
                // Village mine). Only apply when the bot hasn't reached the via yet.
                const via = this.viaLocation;
                if (via) {
                    const viaX = via[0];
                    const viaZ = via[1];
                    if (!isNear(player, viaX, viaZ, 5)) {
                        const [jx, jz] = botJitter(player, viaX, viaZ, 3);
                        this._stuckWalk(player, jx, jz);
                        return;
                    }
                    // Reached via waypoint - clear it and proceed to rock
                    this.viaLocation = undefined;
                }

                const [jx, jz] = botJitter(player, lx, lz, 5);
                this._stuckWalk(player, jx, jz);
                return;
            }

            // Reached mining area - clear via if not already cleared
            this.viaLocation = undefined;
            this.state = 'approach';
            return;
        }

        // ── Approach rock ────────────────────────────────────────────────────
        if (this.state === 'approach') {
            // port (the variety work, round 1, track F: DO-3): waiting at a taken rock, it looks again a person's moment later
            if (this.wait.holding()) return;
            const rock = this._findRock(player);

            if (!rock) {
                // port (variety round 1, F): no rock of its ore free: it waits beside the nearest taken or mined-out one,
                // facing it (274 respawns them), and after 2-4 minutes moves on (its task ends). Upstream walked to a random
                // tile within 5 of the spot every 4 ticks: 23.5-34 % of a miner's ticks at a busy mine were that
                // (only at its spot: away from it, a sub-task's errand over, a party's or a "come here", it walks back first;
                // a wait under way reaches a stump or rock up to 15 tiles off: within WAIT_SPOT_TILES it stays)
                if (awayFromSpot(player, this.step.location, this.wait)) {
                    this.state = 'walk';
                    return;
                }
                this.scanFailTicks++;
                this.wait.none(player, this._takenRock(player), () => noteEvent(player, 'rock-stolen'));
                this.watchdog.notifyActivity(); // (the wait decides when it moves on, with its word: not the watchdog)
                return;
            }

            this.wait.found(player);
            this.scanFailTicks = 0;
            if (rock !== this.currentRock) this._setRock(rock);

            if (!isAdjacentToLoc(player, rock)) {
                this.approachTicks++;
                walkTo(player, rock.x, rock.z);

                if (this.approachTicks > 25) {
                    // Can't reach this rock — reposition near the activity center.
                    this._miss(rock);
                    this._setRock(null);
                    this.approachTicks = 0;
                    const [lx, lz] = this.step.location;
                    walkTo(player, lx + randInt(-5, 5), lz + randInt(-5, 5));
                    this.wanderUntil = World.currentTick + 6; // (AM6: a walk about with no rock)
                }
                return;
            }

            this.state = 'scan';
            this.approachTicks = 0;
            return;
        }

        // ── Start mining ─────────────────────────────────────────────────────
        if (this.state === 'scan') {
            if (!this.currentRock) {
                this.state = 'approach';
                return;
            }

            // port (the realism work, phase 5a, Track F: misclicks): the misclicked empty rock is answered first ("There is
            // no ore currently available in this rock."), then its own, a person's moment later
            if (this.misclickRock) {
                if (player.target === this.misclickRock && this.taskTicks - this.misclickAt < 8) return;
                this.misclickRock = null;
                this.cooldown = 1 + humanDelay(player, 'retarget');
                return;
            }
            // (now and then the click lands on an empty rock beside it: harmless, port/BotFumble)
            if (fumbleDue(player)) {
                const own = this.currentRock;
                const empty = findLocByPrefixWhere(player.x, player.z, player.level, 'rocks', MISCLICK_ROCK_TILES, loc => loc !== own && EMPTY_ROCK.test(LocType.get(loc.type).debugname ?? ''));
                if (empty) {
                    interactLoc(player, empty);
                    fumbled(player, 'rock');
                    this.misclickRock = empty;
                    this.misclickAt = this.taskTicks;
                    return;
                }
            }

            interactLoc(player, this.currentRock);

            this.state = 'interact';
            this.interactTicks = 0;
            this.targetGone = 0;
            this.lastXp = player.stats[PlayerStat.MINING];
            return;
        }

        // ── Mining loop ──────────────────────────────────────────────────────
        if (this.state === 'interact') {
            this.interactTicks++;

            if (player.stats[PlayerStat.MINING] > this.lastXp) {
                this.lastXp = player.stats[PlayerStat.MINING];
                this.interactTicks = 0;
                this.watchdog.notifyActivity();
                // port (phase 5a, Track F): the ore of the rock it took from the human: now and then a word to them ("ty for
                // the rock lol"); a bot victim speaks first (port/BotChatter.argue) and the thief answers that
                if (this.stolen && this.stolen.rock === this.currentRock && !this.stolen.victim.is_bot) {
                    const incident = noteSteal('rock', player, this.stolen.victim, this.stolen.rock);
                    if (claimArgument(incident)) argue(player, incident, 'stealer', this.stolen.victim, STEALER_GLOAT);
                }
                // port (the realism work): a swing that goes on by itself (essence, a gem found) is left alone
                if (player.target !== null && player.target === this.currentRock) return;
                // Find next valid (non-empty) rock — may be the same one or a
                // closer one that just spawned. Avoids re-queueing on depleted rock.
                // port: clicked only when the bot stands at it (upstream clicked one up to 2 tiles away, which a bot is
                // not walked to: "I can't reach that!", and a miss against a good rock); else walked to. port (the
                // realism work): a moment after the ore, as a person sees the rock empty and clicks the next (BotTiming
                // 'retarget'); upstream and the port before clicked in the same tick
                const nextRock = this._findRock(player);
                if (nextRock && isAdjacentToLoc(player, nextRock)) {
                    if (nextRock !== this.currentRock) this._setRock(nextRock);
                    this.state = 'scan';
                } else {
                    this._setRock(null);
                    this.state = 'approach';
                }
                this.cooldown = humanDelay(player, 'retarget');
                return;
            }

            // port: the bot is still at it while its interaction holds (a slow rock takes many swings); the
            // interaction ends a tick before the ore arrives, so only one gone for 2 ticks with no ore ends the try.
            // A rock that is still full then could not be got at (Barbarian Village's coal from the wrong side of
            // the fence): a miss, and a rock missed twice is passed over for ROCK_BAN_TICKS. A rock that changed
            // was mined out (by the bot or another player), which is no miss. Upstream gave up on the rock after 8
            // ticks of any of this, counted every one of them as a miss and passed over a rock missed twice for the
            // rest of the task: miners ran out of rocks in 15 to 30 minutes.
            this.targetGone = player.target === null ? this.targetGone + 1 : 0;
            if (this.targetGone >= 2 || this.interactTicks >= MINE_HOLD_TICKS) {
                const rock = this.currentRock;
                if (rock && this.targetGone >= 2 && rock.type === this.rockType) this._miss(rock);
                this.state = 'approach';
                this._setRock(rock && rock.type === this.rockType && this.targetGone < 2 ? rock : null);
                this.interactTicks = 0;
                this.cooldown = humanDelay(player, 'retarget'); // port (the realism work)
            }
        }
    }

    /**
     * port: the rock the bot works now (claimed, so other bots pick another; the last one released). port (the realism
     * work, phase 5a, Track F): a rock it took from someone it neither claims nor releases (their claim stays: both mine)
     */
    private _setRock(rock: Loc | null): void {
        const stolen = this.stolen?.rock ?? null;
        if (this.currentRock && this.currentRock !== rock && this.currentRock !== stolen) releaseLoc(this.currentRock);
        if (this.stolen && rock !== stolen) this.stolen = null;
        this.currentRock = rock;
        if (rock) {
            if (rock !== this.stolen?.rock) claimLoc(rock);
            this.rockType = rock.type;
        }
    }

    private _miss(rock: Loc): void {
        const key = `${rock.x},${rock.z}`;
        const [misses, at] = this.rockMisses.get(key) ?? [0, 0];
        // an old miss is forgotten (the ban expired)
        this.rockMisses.set(key, [this.taskTicks - at < ROCK_BAN_TICKS ? misses + 1 : 1, this.taskTicks]);
    }

    isComplete(_p: Player): boolean {
        // port (variety round 1, F): its wait at a taken rock ran out (the planner picks again)
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
        this._setRock(null);
        this.stolen = null;
        this.misclickRock = null;
        this.noFreeSince = -1;
        this.rockMisses.clear();
        this.targetGone = 0;
        this.viaLocation = this.step.via;
        this.stuck.reset();
        this.watchdog.reset();
    }

    override getDebugInfo(_player: Player): BotTaskDebugInfo {
        const [lx, lz, ll] = this.step.location;
        return {
            task: this.name,
            state: this.state,
            target: this.currentRock ? `${LocType.get(this.currentRock.type).debugname ?? 'rock'}@(${this.currentRock.x},${this.currentRock.z})` : undefined,
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

    // ── Step re-roll ────────────────────────────────────────────────────────

    /** Pick a fresh random step matching the bot's current level and owned tools. */
    private _rerollStep(player: Player): void {
        const level = getBaseLevel(player, PlayerStat.MINING);
        // port: any one pickaxe (upstream asked for every pickaxe at once: no step ever matched, so it never re-rolled)
        const newStep = getProgressionStep('MINING', level, ids => ids.some(id => (hasItem(player, id) || _wornContains(player, id)) && canUseTool(player, id)));
        if (newStep) this.step = newStep;
    }

    // ── Rock search ────────────────────────────────────────────────────────

    private _findRock(player: Player): Loc | null {
        // port: the step's own ore first; where the mine has none of it (Varrock west has tin and iron but no copper)
        // the rocks the Mining level allows, as upstream; not a rock that gave nothing twice
        const own = this.step.itemGained !== undefined ? ORE_ROCKS[this.step.itemGained] : undefined;
        // port (the realism work, phase 5a, Track F): the rocks a human near is mining (their target lately, beside it)
        const now = World.currentTick;
        for (const h of humansNow()) if (h.target instanceof Loc) HUMAN_ROCKS.set(h.target, { tick: now, human: h });
        const humanRocks: Loc[] = [];
        for (const [loc, seen] of HUMAN_ROCKS) {
            if (now - seen.tick > HUMAN_ROCK_TICKS * 2 || seen.human.slot === -1) {
                HUMAN_ROCKS.delete(loc);
                continue;
            }
            const near = seen.human.level === loc.level && Math.max(Math.abs(seen.human.x - loc.x), Math.abs(seen.human.z - loc.z)) <= 2;
            if (now - seen.tick <= HUMAN_ROCK_TICKS && near && loc.level === player.level && Math.max(Math.abs(loc.x - player.x), Math.abs(loc.z - player.z)) <= 15) humanRocks.push(loc);
        }
        // port: not a rock the bot missed twice lately, nor one another bot works (as trees: claimLoc); (phase 5a) nor the
        // human's while another is free (`human`), and one another works only for a rude miner's steal (`claimed`)
        const usable = (loc: Loc, human: boolean, claimed: boolean): boolean => {
            const miss = this.rockMisses.get(`${loc.x},${loc.z}`);
            if (miss && miss[0] >= 2 && this.taskTicks - miss[1] < ROCK_BAN_TICKS) return false;
            // (phase 5a: a random event's hazard, a gas rock, is left alone once the bot notices it: port/BotRandomEvents)
            if (isEventHazard(player, loc)) return false;
            if (loc === this.currentRock) return true;
            if (!human && humanRocks.includes(loc)) return false;
            return claimed || !isLocClaimed(loc);
        };
        const pick = (ok: (loc: Loc) => boolean): Loc | null => {
            const allRocks: Loc[] = [];
            for (const prefixes of own ? [[own], this._getAvailableOrePrefixes(player)] : [this._getAvailableOrePrefixes(player)]) {
                for (const prefix of prefixes) {
                    const rock = findLocByPrefixWhere(player.x, player.z, player.level, prefix, 15, ok, 'empty');
                    if (rock) allRocks.push(rock);
                }
                if (allRocks.length > 0) break;
            }
            return allRocks.length === 0 ? null : allRocks[Math.floor(Math.random() * allRocks.length)];
        };

        // the polite majority: a free rock, not the human's while another is free (the courtesy)
        const free = pick(loc => usable(loc, false, false));
        // a rude miner (port/BotRude): with no free rock near, a rock another works (or the human's) now and then; even
        // with a free one, if that is farther than ROCK_LAZY_TILES and a worked one nearer (it does not walk)
        const steal = this._rockSteal(player, free, humanRocks, loc => usable(loc, true, true));
        if (steal) return steal;
        if (free) {
            if (humanRocks.length > 0) courtesy.passedOver++;
            return free;
        }
        // none free: the human's rock is shared after all (both mine; the first ore empties it)
        const shared = pick(loc => usable(loc, true, false));
        if (shared && humanRocks.includes(shared)) courtesy.shared++;
        return shared;
    }

    /**
     * port (the variety work, round 1, track F: DO-3): the rock it waits by: the nearest of its ores that another player
     * works (for the next free one beside the miners, prospecting it now and then), else the nearest mined-out one (274's
     * rocks1/rocks2... until it respawns), within 15 tiles; null: none
     */
    private _takenRock(player: Player): Loc | null {
        const d = (loc: Loc): number => Math.max(Math.abs(loc.x - player.x), Math.abs(loc.z - player.z));
        // (the one it waits by while still taken: a person stays put between looks; at a look round, another)
        const current = this.wait.current;
        const away = this.wait.movingOn ? current : null;
        let best: Loc | null = null;
        for (const prefix of this._stealPrefixes(player)) {
            const rock = findLocByPrefixWhere(player.x, player.z, player.level, prefix, 15, loc => loc !== away && isLocClaimed(loc), 'empty');
            if (rock && (!best || d(rock) < d(best))) best = rock;
        }
        const isEmpty = (loc: Loc): boolean => EMPTY_ROCK.test(LocType.get(loc.type).debugname ?? '');
        if (current && !away && current.isActive && (isLocClaimed(current) || isEmpty(current))) return current;
        if (best) return best;
        return findLocByPrefixWhere(player.x, player.z, player.level, 'rocks', 15, loc => loc !== away && isEmpty(loc)) ?? (away && away.isActive ? away : null);
    }

    /**
     * port (the realism work, phase 5a, Track F: rock-stealing): a rude miner's (port/BotPersona rudeActs) take of the rock
     * another player mines now (a bot's or the human's), the nearest such: ROCK_STEAL a pick of it when no free rock is
     * near (`free` null), ROCK_LAZY when the free one is farther than ROCK_LAZY_TILES and this one nearer; within the caps
     * (port/BotRude). Null: none.
     */
    private _rockSteal(player: Player, free: Loc | null, humanRocks: Loc[], ok: (loc: Loc) => boolean): Loc | null {
        // (no free rock: only once it has waited a while for one, as the polite ones wait: they come back in seconds)
        if (free) this.noFreeSince = -1;
        else if (this.noFreeSince < 0) this.noFreeSince = this.taskTicks;
        if (!rudeActs(player) || !maySteal(player, false, 'rock')) return null;
        const d = (loc: Loc): number => Math.max(Math.abs(loc.x - player.x), Math.abs(loc.z - player.z));
        if (!free && this.taskTicks - this.noFreeSince < ROCK_WAIT_TICKS) return null;
        const freeDist = free ? d(free) : Infinity;
        if (free && freeDist <= ROCK_LAZY_TILES) return null;
        let taken: Loc | null = null;
        for (const prefix of this._stealPrefixes(player)) {
            const rock = findLocByPrefixWhere(player.x, player.z, player.level, prefix, 15, loc => loc !== this.currentRock && (isLocClaimed(loc) || humanRocks.includes(loc)) && ok(loc), 'empty');
            if (rock && (!taken || d(rock) < d(taken))) taken = rock;
        }
        if (!taken || d(taken) >= freeDist) return null;
        const victim = this._minerOf(taken, humanRocks.includes(taken));
        if (!victim || victim === player || !maySteal(player, !victim.is_bot, 'rock')) return null;
        // (a full mine's roll once per ROCK_ROLL_TICKS whatever the rock; a lazy one's per rock, as a pick's)
        if (!(free ? rollFor(player, taken, rudeRates.lazy) : rollFor(player, this.stealRoll, rudeRates.rock, ROCK_ROLL_TICKS))) return null;
        noteSteal('rock', player, victim, taken, false, free ? 'lazy' : 'none-free');
        if (!victim.is_bot) courtesy.stolen++;
        this.stolen = { rock: taken, victim };
        return taken;
    }

    /** port (phase 5a): the ores a steal looks at: the step's own, else the level's (as the pick) */
    private _stealPrefixes(player: Player): string[] {
        const own = this.step.itemGained !== undefined ? ORE_ROCKS[this.step.itemGained] : undefined;
        return own ? [own] : this._getAvailableOrePrefixes(player);
    }

    /** port (phase 5a): the player mining this rock now (its target, beside it): the human's, or a bot's; null: nobody yet */
    private _minerOf(rock: Loc, human: boolean): Player | null {
        if (human) for (const h of humansNow()) if (h.target === rock) return h;
        for (const p of World.playerLoop.all()) {
            if (p.target === rock && p.level === rock.level && Math.max(Math.abs(p.x - rock.x), Math.abs(p.z - rock.z)) <= 3) return p;
        }
        return null;
    }

    private _getAvailableOrePrefixes(player: Player): string[] {
        const prefixes: string[] = [];

        // Special case: if we are at Rimmington mine, always prioritize clay if that's what we are there for
        if (this.step.location === Locations.MINE_RIMMINGTON) {
            prefixes.push('clayrock');
            return prefixes;
        }

        // Get player's actual mining level using base level
        const miningLevel = getBaseLevel(player, PlayerStat.MINING);

        // Level 1-14: copper and tin available
        if (miningLevel <= 14) {
            prefixes.push('copperrock', 'tinrock');
        }
        // Level 15-29: iron available
        else if (miningLevel <= 29) {
            prefixes.push('ironrock');
        }
        // Level 30+: coal (and iron for some mines)
        else if (miningLevel <= 54) {
            prefixes.push('coalrock', 'ironrock');
        }
        // Level 55+: Mithril
        else if (miningLevel <= 69) {
            prefixes.push('mithrilrock', 'coalrock');
        }
        // Level 70+: Adamant
        else if (miningLevel <= 84) {
            prefixes.push('adamantiterock', 'mithrilrock'); // port: the rocks are adamantiterock1/2 ('adamantrock' matched nothing)
        }
        // Level 85+: Runite
        else {
            prefixes.push('runiterock', 'adamantiterock');
        }

        return prefixes;
    }

    // ── Banking ─────────────────────────────────────────────────────────────

    private _depositOre(player: Player): void {
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
            if (moved > 0) bank.add(bankedId(item.id), moved);
        }
        console.log(`[MG:${player.username}] Deposited ORES into the bank.`);
    }

    // ── Stuck handling (WC-style upgrade) ──────────────────────────────────

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

        const escX = player.x + (Math.abs(dz) > Math.abs(dx) ? randInt(-10, 10) : dz > 0 ? 10 : -10);

        const escZ = player.z + (Math.abs(dx) > Math.abs(dz) ? randInt(-10, 10) : dx > 0 ? 10 : -10);

        walkTo(player, escX, escZ);
    }
}
