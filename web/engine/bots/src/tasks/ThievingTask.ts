/**
 * ThievingTask.ts — Pickpocket NPCs (Man/Woman/warrior/guard/knight/paladin/hero)
 * and steal from market stalls (baker/silk/fur/silver/spice/gem), bank loot,
 * handle stun/damage/retaliation.
 *
 * Two step actions, both driven by SkillProgression.THIEVING in BotKnowledge.ts:
 *   'thieve'       — pickpocket an NPC. op3 on the NPC (extra.npcName/npcType).
 *   'thieve_stall' — steal from a market stall. op2 on the stall LOC
 *                    (extra.locName — see content/scripts/skill_thieving/
 *                    configs/stalls/stealing.dbrow for the real debugnames).
 *
 * Failure: NPC/stall owner or a nearby guard retaliates, player takes damage.
 * Stop condition: HP too low → switch to other task or heal.
 */

import {
    BotTask,
    Player,
    Npc,
    Loc,
    InvType,
    walkTo,
    interactNpcOp,
    interactLocOp,
    findNpcByName,
    findNpcByPrefix,
    findLocByName,
    findLocByPrefix,
    hasItem,
    countItem,
    isNear,
    isAdjacentToLoc,
    isInventoryFull,
    getBaseLevel,
    PlayerStat,
    Items,
    getProgressionStep,
    teleportNear,
    randInt,
    bankInvId,
    INTERACT_TIMEOUT,
    StuckDetector,
    ProgressWatchdog,
    advanceBankWalk,
    hasStrayItems,
    currentHp,
    maxHp,
    hpBelow,
    carriedFood,
    bankedFood,
    withdrawFood,
    eatBestFood,
    edibleFoodIds,
    humanDelay,
    TargetPause,
    bankFoodAbove,
    npcReach,
    gateToward
} from '#/engine/bot/tasks/BotTaskBase.js';
import { openGateLoc } from '#/engine/bot/BotAction.js';
import { bankStop } from '#/engine/bot/port/BotHabits.js';
// (the variety work, round 2, Track M: the climb to a spot upstairs)
import { climbLeg } from '#/engine/bot/port/BotUpstairs.js';
import type { SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import { getNpcCombatLevel, findAggressorNpc, interactHeldOp } from '#/engine/bot/BotAction.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { bankedId } from '#/engine/bot/port/BotInventoryCompat.js';
import { findNpcFiltered } from '#/engine/bot/BotAction.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import NpcType from '#/cache/config/NpcType.js';
import World from '#/engine/World.js';
import { isLineOfSight } from '#/engine/GameMap.js';
import { claimLocTile, claimStandTile, claimWaitTile, releaseStandTile, sharesTile, standTileOf, stepToTile, usesLocFrom } from '#/engine/bot/port/BotTiles.js';

/**
 * port (the realism work, phase 3: own tiles, port/BotTiles): each pickpocket's mark, by the NPC's nid. A thief picks a
 * man (a knight, a guard) no other thief works when there is one, as players spread out; upstream's all took the
 * nearest, and stood about it on one tile between attempts (the humanlike report's H4: Thieve/pickpocket was the most
 * stacked state at 100 and at 500 bots).
 */
const MARKS = new Map<number, Player>();
function markedByAnother(npc: Npc, thief: Player): boolean {
    const by = npc.nid >= 0 ? MARKS.get(npc.nid) : undefined;
    if (!by || by === thief) return false;
    // (a thief that left, or works another mark now, holds none)
    if (by.slot === -1) {
        MARKS.delete(npc.nid);
        return false;
    }
    return true;
}

/** port: 274's %stunned (a failed pickpocket) and %lastcombat (no theft from a stall in a fight), found once */
let stunnedVarp: number | undefined;
let lastCombatVarp: number | undefined;
function stunnedVarpId(): number {
    return (stunnedVarp ??= VarPlayerType.getByName('stunned')?.id ?? -1);
}
function lastCombatVarpId(): number {
    return (lastCombatVarp ??= VarPlayerType.getByName('lastcombat')?.id ?? -1);
}

// port: a player clicks again as soon as the last attempt is over (upstream waited 8 to 12 ticks). port (the realism
// work, phase 2): the attempt's own 2 ticks (its outcome is judged after them), then a person's click, never a
// metronome (BotTiming 'next'); the port's first version clicked every 3-5 ticks (19-21 % identical intervals)
const THIEVE_ATTEMPT_TICKS = 2;
/** port: the wait after a failed attempt (274 stuns a caught thief for a few ticks) */
const THIEVE_STUN_WAIT_MIN = 5;
const THIEVE_STUN_WAIT_MAX = 8;
const THIEF_STUN_DAMAGE = 3;
// port: shares of the Hitpoints level, read from the current Hitpoints. Upstream compared player.stats[HITPOINTS] (the
// XP, at least 11,540) with 5, 15, 30 and 20: none ever held. As absolute levels a 10-Hitpoints bot could never
// start (15) and a 99 one would only stop at 5; these keep upstream's order and spacing at about 50 Hitpoints.
/** Absolute danger floor — interrupt immediately at or below this HP regardless of state or cooldown. */
const HP_DANGER_THRESHOLD = 0.15;
/** Soft threshold — stop pickpocketing and bank/heal when HP drops this low. */
const HP_SAFE_THRESHOLD = 0.35;
/** Pre-emptive heal threshold — eat BEFORE pickpocket if HP is below this */
const HP_PREEMPTIVE_THRESHOLD = 0.6;
const HEAL_IF_HP_BELOW = 0.45;
/** port: food taken from the bank for a thieving run */
const THIEVING_FOOD = 8;
const MAX_TICKETS = 5;

export class ThievingTask extends BotTask {
    private step: SkillStep;

    private state: string = 'walk';

    /** port: 1 while an attempt's outcome is to be judged */
    private lastXp = 0;
    /** port: the Thieving XP when the attempt was sent */
    private attemptXp = 0;
    private lastHp = 0;
    private interactTicks = 0;
    private stunTicks = 0;
    private currentNpc: Npc | null = null;
    private currentLoc: Loc | null = null;
    private done = false;
    /** port: ticks waited for a stall's guard or owner to look away */
    private watchWait = 0;
    /** port (the realism work): the NPC it marks (MARKS), and the player it ticks for (to give both back on a reset) */
    private markedNid = -1;
    private lastPlayer: Player | null = null;
    /** port (the realism work): attempts in a row on its mark that came to nothing (no XP, no stun), and marks it left */
    private fruitless = 0;
    private readonly unreachable = new Map<number, number>();
    /** port (the realism work): every side of its mark (every tile of its stall) taken: it waits its turn a step away */
    private waitUntil = -1;

    /** True for 'thieve_stall' steps — interact with a stall LOC (op2) instead of an NPC (op3). */
    private get isStall(): boolean {
        return this.step.action === 'thieve_stall';
    }

    private readonly stuck = new StuckDetector(30, 4, 2);
    private readonly watchdog = new ProgressWatchdog();
    /** port (the realism work, phase 2): a person's pause before the next attempt after its target is lost (BotTaskBase) */
    private readonly pause = new TargetPause();

    constructor(step: SkillStep) {
        super('Thieve');
        this.step = step;
        this.watchdog.follow(() => this.step.location);
    }

    private debug(player: Player, message: string): void {
        console.log(`[ThievingTask][${player.username}][${this.state}] ${message}`);
    }

    // ── Task lifecycle ───────────────────────────────────────────────────────

    override activityStep(): SkillStep | null {
        return this.step;
    }

    shouldRun(player: Player): boolean {
        const level = getBaseLevel(player, PlayerStat.THIEVING);

        // Must have level to start
        if (level < 1) return false;

        // Don't restart while HP is still in the danger zone or hasn't recovered
        // above the safe threshold — give the planner time to pick a healing task.
        const hp = currentHp(player);
        if (this._atDanger(player)) {
            this.debug(player, `not starting: HP critically low (${hp})`);
            return false;
        }
        // port: low, but food in the pack or the bank brings it back up
        if (hpBelow(player, HP_SAFE_THRESHOLD) && carriedFood(player) === 0 && bankedFood(player) === 0) {
            this.debug(player, `not starting: HP too low (${hp})`);
            return false;
        }

        return true;
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
        this.pause.observe(player); // port (the realism work)

        // ── DANGER HP CHECK — runs every tick, even during cooldown ──────────
        // If HP hits the absolute floor, interrupt immediately so the planner
        // can switch to a safer task before the bot takes one more hit and dies.
        {
            const hp = currentHp(player);
            if (this._atDanger(player)) {
                this.debug(player, `DANGER: HP critically low (${hp}/${maxHp(player)}); switching task`);
                this.interrupt();
                return;
            }
        }

        const banking = this.state === 'bank_walk' || this.state === 'bank_done' || this.state === 'eat';
        if (this.watchdog.check(player, banking)) {
            player.clearWaypoints();
            player.clearPendingAction();
            this.debug(player, 'Watchdog triggered; teleported to destination, resuming');
            this.stuck.reset();
            return;
        }

        // port (the variety work, round 1, track F: ISS-11): stunned (274's %stunned), the bot neither walks nor clicks
        // until it wears off and a person's moment after: a step then is the game's "You're stunned!" and a click on a mark
        // that moved off "I can't reach that!" (19 an hour for thieves). Fleeing a monster it cannot either (the walk is
        // refused); it waits the stun out as a player does. (Before the cooldown: a step to its own tile queued with the
        // attempt was walked into the stun)
        {
            const now = World.currentTick;
            const stunned = stunnedVarpId() === -1 ? 0 : (player.getVar(stunnedVarpId()) as number);
            if (now < stunned && this.state !== 'bank_done' && this.state !== 'eat') {
                if (player.hasWaypoints()) player.clearWaypoints();
                this.cooldown = Math.max(this.cooldown, stunned - now + humanDelay(player, 'retarget'));
                this.cooldown--;
                return;
            }
        }

        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }

        // ── Inventory full: bank the stolen loot before continuing ──────────
        // Stealing from a stall with a full inventory just silently fails
        // server-side (inv_freespace(inv) = 0 check in stealing.rs2) — without
        // this, a bot would keep retrying every cooldown forever, gaining no
        // XP and never banking anything it already stole.
        if (this.state !== 'flee' && this.state !== 'bank_walk' && this.state !== 'bank_done' && this.state !== 'eat') {
            if (isInventoryFull(player)) {
                this.debug(player, 'inventory full; banking loot');
                this.state = 'bank_walk';
                this.currentNpc = null;
                this.currentLoc = null;
                return;
            }
        }

        // Carrying leftovers from a previous task — bank them before heading
        // out so the trip starts with a clean slate.
        // port: food is not a leftover. The port withdraws food for the run at the bank, and its first version then
        // found that food "stray" and banked it again, for ever: no bot ever stole anything (test/sim.mjs: 15,279
        // thieving ticks, no Thieving XP)
        if (this.state === 'walk' && hasStrayItems(player, edibleFoodIds())) {
            this.debug(player, 'stray items from a previous task; banking first');
            this.state = 'bank_walk';
            return;
        }

        // ── Soft HP check: stop pickpocketing and bank/heal if HP is low ────
        if (this.state !== 'flee' && this.state !== 'bank_walk' && this.state !== 'bank_done' && this.state !== 'eat') {
            const hp = currentHp(player);
            if (hpBelow(player, HP_SAFE_THRESHOLD)) {
                // port (the variety work, round 1, track F: AM7): with food in the pack it eats (the bank had nothing more
                // to give: a thief at Al Kharid with 8 food went bank, back, bank with the same pack, for good)
                if (carriedFood(player) > 0) {
                    this.state = 'eat';
                    return;
                }
                this.debug(player, `HP low (${hp}); banking to recover`);
                this.state = 'bank_walk';
                this.currentNpc = null;
                this.currentLoc = null;
                return;
            }
        }

        // ── Aggressor detection (same flee pattern as CombatTask) ──────────
        if (this.state !== 'bank_walk' && this.state !== 'bank_done' && this.state !== 'flee' && this.state !== 'eat') {
            const aggressor = findAggressorNpc(player, 8);
            if (aggressor && aggressor !== this.currentNpc) {
                const npcLvl = getNpcCombatLevel(aggressor);
                if (npcLvl > player.combatLevel) {
                    this.debug(player, 'aggressor attacking; fleeing');
                    this.state = 'flee';
                    this.stunTicks = 0;
                    return;
                }
            }
        }

        // ── Flee state: move away from NPCs ────────────────────────────────
        if (this.state === 'flee') {
            const [lx, lz] = [player.x - 10, player.z];
            walkTo(player, lx, lz);
            this.stunTicks++;
            if (this.stunTicks > 10) {
                // port: back to the stall or NPC unless hurt (upstream: always to the bank, when the Hitpoints it read,
                // the XP, never fell; read right, every failed attempt cost a walk to the bank and back)
                this.state = hpBelow(player, HEAL_IF_HP_BELOW) ? 'bank_walk' : 'walk';
            }
            return;
        }

        // ── Eat state: heal with food ───────────────────────────────────
        if (this.state === 'eat') {
            this._eatFood(player);
            return;
        }

        // ── Bank walk ────────────────────────────────────────────────────
        if (this.state === 'bank_walk') {
            // ---- (the variety work, round 2, Track M) upstairs (Yanille's watchmen): down its ladder first (port/BotUpstairs) ----
            if (player.level > 0 && climbLeg(player, [player.x, player.z, 0])) return;
            // ---- end of Track M's block ----
            const result = advanceBankWalk(player, this.stuck);
            if (result === 'walk') return;
            this.debug(player, `advanceBankWalk returned ${result}`);
            // port (the realism work): a person's stop at the booth, never the same twice (port/BotHabits.bankStop)
            this.cooldown = result === 'ready' ? bankStop(player) : 0;
            this.state = 'bank_done';
            return;
        }

        // ── Bank deposit ─────────────────────────────────────────────
        if (this.state === 'bank_done') {
            this._depositLoot(player);
            // port (the variety work, round 1, track F: DO-1/ISS-2): food above the run's goes in too, stolen cakes and bread
            // first (a pack of the baker's stall's cakes was never banked: the thief stood at the booth 15-18 minutes)
            bankFoodAbove(player, THIEVING_FOOD);
            // port: food for the run (upstream withdrew none: a bot sent to the bank by low HP came back as hurt)
            withdrawFood(player, THIEVING_FOOD);
            // (and a pack still full after it all (a full bank): the task is done)
            if (isInventoryFull(player)) {
                this.debug(player, 'pack still full after the bank; done for now');
                this.done = true;
                return;
            }
            if (hpBelow(player, HP_SAFE_THRESHOLD) && carriedFood(player) === 0) {
                this.debug(player, 'HP low and no food in the bank; done for now');
                this.done = true;
                return;
            }
            this.state = 'walk';
            return;
        }

        // ── Walk to NPC ─────────────────────────────────────────────────
        if (this.state === 'walk') {
            const [lx, lz, ll] = this.step.location;
            // ---- (the variety work, round 2, Track M) a step upstairs (Yanille's watchmen, Thieving 65): the building's own
            // ladder, walked to and climbed (port/BotUpstairs); the walk below never reaches a floor above ----
            if (ll !== player.level && climbLeg(player, this.step.location)) return;
            // ---- end of Track M's block ----
            if (!isNear(player, lx, lz, 10, ll)) {
                this._stuckWalk(player, lx, lz);
                return;
            }
            this.state = 'approach';
            return;
        }

        // ── Approach and find NPC/stall ───────────────────────────────────
        if (this.state === 'approach') {
            if (this.isStall) {
                const stall = this._findStall(player);
                if (!stall) {
                    this.debug(player, `no stall found`);
                    this._stuckWalk(player, this.step.location[0], this.step.location[1]);
                    return;
                }
                this.currentLoc = stall;
                if (!isAdjacentToLoc(player, stall) || sharesTile(player)) {
                    this._toStallTile(player, stall);
                    return;
                }
                this.state = 'pickpocket';
                this.interactTicks = 0;
                return;
            }

            const npc = this._findNpc(player);
            if (!npc) {
                this.debug(player, `no npc found`);
                this._stuckWalk(player, this.step.location[0], this.step.location[1]);
                return;
            }
            this._mark(player, npc);
            this.currentNpc = npc;
            // (the variety work, round 2, Track M: on the mark's own floor: the watchmen are upstairs, and a walk to them on
            // the ground floor's terms chased them for good)
            if (!isNear(player, npc.x, npc.z, 1, npc.level)) {
                walkTo(player, npc.x, npc.z, npc.level);
                return;
            }
            this.state = 'pickpocket';
            this.interactTicks = 0;
            return;
        }

        // ── Pickpocket / steal-from-stall loop ────────────────────────────
        if (this.state === 'pickpocket') {
            // If no target, go find one
            if (this.isStall ? !this.currentLoc : !this.currentNpc) {
                this.state = 'approach';
                return;
            }

            // If not close enough, walk back to the target
            if (this.isStall) {
                // port (the realism work): to a tile of its own at the stall (another thief on its tile: a free one)
                if (!isAdjacentToLoc(player, this.currentLoc!) || (sharesTile(player) && !player.hasWaypoints())) {
                    this._toStallTile(player, this.currentLoc!);
                    return;
                }
            } else if (!isNear(player, this.currentNpc!.x, this.currentNpc!.z, 3, this.currentNpc!.level)) {
                walkTo(player, this.currentNpc!.x, this.currentNpc!.z, this.currentNpc!.level); // (Track M: its floor)
                return;
            } else if (sharesTile(player) && !player.hasWaypoints() && World.currentTick >= this.waitUntil && this._besideMark(player, this.currentNpc!)) {
                // port (the realism work): another player on its tile by the mark: a step to a free side of it (or, with
                // every side taken, a step away to wait its turn)
                return;
            }
            // port (the realism work): on its way to a tile of its own there, or waiting its turn: it gets there first
            if (player.hasWaypoints() && standTileOf(player) !== null) return;
            if (World.currentTick < this.waitUntil) return;

            // Solution A: Pre-emptive HP check - eat BEFORE pickpocket if HP is low
            // port: eat from the pack; to the bank only for food that is there, and only when HP is below the heal
            // line (upstream: to the bank whenever the pack had none, so with no food anywhere, between the heal and
            // the pre-emptive lines, the bot walked to the bank and back for ever)
            const hpBeforePickpocket = currentHp(player);
            if (hpBelow(player, HP_PREEMPTIVE_THRESHOLD) && carriedFood(player) > 0) {
                this.debug(player, `HP pre-emptively low (${hpBeforePickpocket}), eating first`);
                this.state = 'eat';
                return;
            }

            // Check if need to heal first (for lower HP)
            if (this._shouldHeal(player) && bankedFood(player) > 0) {
                // No food in the pack: fetch some
                this.debug(player, `HP low and no food, banking`);
                this.state = 'bank_walk';
                return;
            }

            // port: how the last attempt went, once its cooldown is over (upstream checked this after the state's
            // block had already returned, so never, and fed the watchdog for every attempt sent, so a thief that
            // never stole anything never stalled): XP is a success; lost Hitpoints without XP is a stun, waited out
            if (this.lastXp > 0) {
                const xp = player.stats[PlayerStat.THIEVING];
                const hpDrop = this.lastHp - currentHp(player);
                this.lastXp = 0;
                if (xp > this.attemptXp) {
                    this.watchdog.notifyActivity();
                    this.fruitless = 0;
                } else if (hpDrop > 0) {
                    this.debug(player, `caught (lost ${hpDrop} Hitpoints); waiting out the stun`);
                    this.cooldown = randInt(THIEVE_STUN_WAIT_MIN, THIEVE_STUN_WAIT_MAX);
                    this.fruitless = 0;
                    return;
                } else if (!this.isStall && this.currentNpc && ++this.fruitless >= 3) {
                    // port (the realism work): three attempts in a row on the mark came to nothing ("I can't reach that!": a
                    // mark behind a wall or a shut door): it is left for a while, and another found
                    this.debug(player, 'nothing came of the mark; another one');
                    if (this.currentNpc.nid >= 0) this.unreachable.set(this.currentNpc.nid, World.currentTick + 300);
                    this._unmark(player);
                    this.currentNpc = null;
                    this.fruitless = 0;
                    this.state = 'approach';
                    return;
                }
            }

            // port: still stunned (274's %stunned: a click now gets "You're stunned!" and "I can't reach that!"), or in
            // combat in the last 10 ticks (a stall says "You can't steal from the market stall during combat!")
            const now = World.currentTick;
            const stunned = stunnedVarpId() === -1 ? 0 : (player.getVar(stunnedVarpId()) as number);
            if (now < stunned) {
                // port (the realism work): and a moment after it wears off, as a person's (BotTiming 'retarget')
                this.cooldown = stunned - now + humanDelay(player, 'retarget');
                return;
            }
            if (this.isStall && lastCombatVarpId() !== -1 && (player.getVar(lastCombatVarpId()) as number) + 10 > now) {
                this.cooldown = 2;
                return;
            }
            // port: a stall's guard or owner looking on (stealing.rs2: within 5 tiles, in sight): wait for them to
            // walk off, as a player does (the guard attacks, the stall's owner shouts and nothing is stolen)
            // (for at most 30 ticks: then it steals anyway, and fights off a guard that comes: BotDefence)
            if (this.isStall && this.watchWait < 30 && this._watched(player)) {
                this.cooldown = randInt(2, 4);
                this.watchWait += this.cooldown + 1;
                return;
            }
            this.watchWait = 0;
            // port (the realism work): the stall or the mark it lost a moment ago, clicked again a person's moment later
            if (!this.pause.ready) return;

            // port (the variety work, round 1, track F: ISS-11): a mark it cannot get at (it walked behind a wall or a
            // door) is left for a while without a click; behind a closed door, the door first ("I can't reach that!")
            if (!this.isStall && this.currentNpc) {
                const reach = npcReach(player, this.currentNpc);
                if (reach === 'no') {
                    if (this.currentNpc.nid >= 0) this.unreachable.set(this.currentNpc.nid, World.currentTick + 300);
                    this._unmark(player);
                    this.currentNpc = null;
                    this.state = 'approach';
                    return;
                }
                if (reach === 'gate') {
                    const gate = gateToward(player, this.currentNpc.x, this.currentNpc.z);
                    if (gate && openGateLoc(player, gate) !== 'unreachable') {
                        this.cooldown = 3 + humanDelay(player, 'retarget');
                        return;
                    }
                    // (the variety work, round 2, Track D2: D2-7) a door between that it cannot get to (East Ardougne's
                    // houses): the mark is left for a while, as one out of reach, not clicked ("I can't reach that!")
                    if (this.currentNpc.nid >= 0) this.unreachable.set(this.currentNpc.nid, World.currentTick + 300);
                    this._unmark(player);
                    this.currentNpc = null;
                    this.state = 'approach';
                    return;
                }
                // (variety round 2, D2-7) no path search left this tick: the click waits for the next, not blind
                if (reach === 'unknown') {
                    this.cooldown = 1;
                    return;
                }
            }

            this.lastHp = currentHp(player);
            this.attemptXp = player.stats[PlayerStat.THIEVING];
            this.lastXp = 1;

            this.interactTicks++;
            if (this.isStall) {
                interactLocOp(player, this.currentLoc!, 2); // op 2 = steal-from-stall
            } else {
                interactNpcOp(player, this.currentNpc!, 3); // op 3 = pickpocket
            }
            this.pause.held(); // (an attempt is over before the next tick's look: the pause starts from it)

            this.cooldown = THIEVE_ATTEMPT_TICKS + humanDelay(player, 'next');
            this.debug(player, this.isStall ? `steal-from-stall sent` : `pickpocket sent`);
            return;
        }

        this.interactTicks = 0;
    }

    reset(): void {
        super.reset();
        if (this.lastPlayer) {
            this._unmark(this.lastPlayer);
            releaseStandTile(this.lastPlayer);
        }
        this.state = 'walk';
        this.lastXp = 0;
        this.lastHp = 0;
        this.interactTicks = 0;
        this.stunTicks = 0;
        this.currentNpc = null;
        this.currentLoc = null;
        this.done = false;
        this.stuck.reset();
        this.watchdog.reset();
        this.pause.reset();
        this.fruitless = 0;
        this.waitUntil = -1;
    }

    // ── Private helpers ───────────────────────────────────────────

    private _findNpc(player: Player): Npc | null {
        // Try to find the npc based on step's extra data
        const npcName = (this.step.extra?.npcName as string) ?? (this.step.extra?.npcType as string) ?? 'man';

        // port (the realism work): within a few tiles one no other thief marks first (MARKS), the nearest such; then the
        // nearest, as before; never one it found it cannot reach, for a while
        const now = World.currentTick;
        const reachable = (n: Npc): boolean => (this.unreachable.get(n.nid) ?? -1) <= now;
        const typeId = NpcType.getId(npcName);
        // (its kind: the type, or a debugname that starts with it as the prefix fallback below has it: man2, man3)
        const ofKind = (n: Npc): boolean => n.type === typeId || !!NpcType.get(n.type).debugname?.startsWith(npcName);
        const free = findNpcFiltered(player.x, player.z, player.level, n => ofKind(n) && reachable(n) && !markedByAnother(n, player) && Math.max(Math.abs(n.x - player.x), Math.abs(n.z - player.z)) <= 8, 8);
        if (free) return free;

        // First try exact name
        let npc = this.unreachable.size === 0 ? findNpcByName(player.x, player.z, player.level, npcName, 15) : typeId !== -1 ? findNpcFiltered(player.x, player.z, player.level, n => n.type === typeId && reachable(n), 15) : null;
        if (npc) return npc;

        // Try prefix (e.g., "man" as prefix for "man", "farmer", etc.)
        npc = this.unreachable.size === 0 ? findNpcByPrefix(player.x, player.z, player.level, npcName, 15) : findNpcFiltered(player.x, player.z, player.level, n => !!NpcType.get(n.type).debugname?.startsWith(npcName) && reachable(n), 15);
        return npc;
    }

    /** port (the realism work): the NPC is this thief's mark now (MARKS); its last one goes back */
    private _mark(player: Player, npc: Npc): void {
        if (npc.nid === this.markedNid) return;
        this._unmark(player);
        if (npc.nid < 0 || markedByAnother(npc, player)) return;
        this.markedNid = npc.nid;
        MARKS.set(npc.nid, player);
    }

    private _unmark(player: Player): void {
        if (this.markedNid !== -1 && MARKS.get(this.markedNid) === player) MARKS.delete(this.markedNid);
        this.markedNid = -1;
    }

    /**
     * port (the realism work): to a free tile of its own from which it steals from the stall (port/BotTiles); with every
     * one taken, a step away to wait its turn
     */
    private _toStallTile(player: Player, stall: Loc): void {
        if (World.currentTick < this.waitUntil) return;
        const held = standTileOf(player);
        // (its own tile when it is one the stall is used from and nobody else stands on it; not its waiting tile)
        const own = held && held[2] === player.level && usesLocFrom(stall, held[0], held[1]) && !(held[0] === player.x && held[1] === player.z && sharesTile(player)) ? [held[0], held[1]] : null;
        const tile = own ?? claimLocTile(player, stall, 1);
        if (tile) {
            // (a tile it finds no way to: not again for a moment)
            if (!stepToTile(player, tile[0], tile[1])) this.waitUntil = World.currentTick + 10;
            return;
        }
        const wait = claimWaitTile(player, stall, 2);
        if (wait) {
            this.waitUntil = World.currentTick + randInt(6, 14);
            if (!stepToTile(player, wait[0], wait[1])) this.waitUntil = World.currentTick + 10;
            return;
        }
        walkTo(player, stall.x, stall.z);
    }

    /**
     * port (the realism work): a step to a free tile beside the mark (north, south, east or west of it: a pickpocket's
     * reach), or with every side taken to a free tile 2-3 away to wait its turn; true when it steps, false with none free
     * (it stays)
     */
    private _besideMark(player: Player, npc: Npc): boolean {
        const tile = claimStandTile(player, npc.x, npc.z, npc.level, 1, (x, z) => Math.abs(x - npc.x) + Math.abs(z - npc.z) === 1);
        if (tile && tile[0] === player.x && tile[1] === player.z) return false;
        if (tile) {
            // (a tile it finds no way to: not again for a moment)
            if (!stepToTile(player, tile[0], tile[1])) this.waitUntil = World.currentTick + 10;
            return true;
        }
        const wait = claimStandTile(player, npc.x, npc.z, npc.level, 3, (x, z) => Math.max(Math.abs(x - npc.x), Math.abs(z - npc.z)) >= 2);
        if (!wait || (wait[0] === player.x && wait[1] === player.z)) return false;
        this.waitUntil = World.currentTick + randInt(6, 14);
        if (!stepToTile(player, wait[0], wait[1])) this.waitUntil = World.currentTick + 10;
        return true;
    }

    private _findStall(player: Player): Loc | null {
        const locName = this.step.extra?.locName as string | undefined;
        if (!locName) return null;

        // Exact debugname first (e.g. 'bakers_stall_stealing', 'tea_stall').
        let stall = findLocByName(player.x, player.z, player.level, locName, 15);
        if (stall) return stall;

        // Prefix fallback in case the debugname carries a numeric/variant suffix.
        stall = findLocByPrefix(player.x, player.z, player.level, locName, 15);
        return stall;
    }

    /** port: is one of the stall's guards (not fighting a player) or its owner within 5 tiles and in sight? */
    private _watched(player: Player): boolean {
        const extra = this.step.extra as { owner?: string; guards?: string[] } | undefined;
        const names = new Set([...(extra?.guards ?? []), ...(extra?.owner ? [extra.owner] : [])]);
        if (names.size === 0) return false;
        return findNpcFiltered(player.x, player.z, player.level, n => {
            if (Math.max(Math.abs(n.x - player.x), Math.abs(n.z - player.z)) > 5) return false;
            const name = NpcType.get(n.type).debugname ?? '';
            if (!names.has(name)) return false;
            if (name !== extra?.owner && n.target && (n.target as any).username !== undefined && n.target !== player) return false;
            return isLineOfSight(player.level, n.x, n.z, player.x, player.z);
        }, 6) !== null;
    }

    private _shouldHeal(player: Player): boolean {
        return hpBelow(player, HEAL_IF_HP_BELOW);
    }

    /** port: at or below the danger floor (at least 2 Hitpoints: a thief's stun hits for 1 to 3) */
    private _atDanger(player: Player): boolean {
        return currentHp(player) <= Math.max(2, Math.floor(maxHp(player) * HP_DANGER_THRESHOLD));
    }

    private _eatFood(player: Player): void {
        // port: the best food the bot can eat on this world (BotTaskBase.eatBestFood)
        if (eatBestFood(player)) {
            this.debug(player, 'ate to heal');
            this.cooldown = 3;
            this.state = 'pickpocket';
            return;
        }
        if (carriedFood(player) > 0) return; // busy: next tick

        // No food found — go to bank.
        this.debug(player, `no food to eat`);
        this.state = 'bank_walk';
    }

    private _depositLoot(player: Player): void {
        const bid = bankInvId();
        if (bid === -1) return;

        const bank = player.getInventory(bid);
        const inv = player.getInventory(InvType.INV);
        if (!bank || !inv) return;

        // coins stay, everything else goes to bank (port: and food: the run's food, topped up next)
        const lootableIds = [995, ...edibleFoodIds()];

        let deposited = 0;

        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item) continue;
            if (lootableIds.includes(item.id)) continue;

            const moved = inv.remove(item.id, item.count);
            if (moved > 0) {
                bank.add(bankedId(item.id), moved);
                deposited += moved;
            }
        }

        this.debug(player, `deposited ${deposited} items`);
    }

    private _stuckWalk(player: Player, lx: number, lz: number): void {
        if (!this.stuck.check(player, lx, lz)) {
            walkTo(player, lx, lz);
            return;
        }

        if (this.stuck.desperatelyStuck) {
            this.debug(player, `desperately stuck; teleporting`);
            teleportNear(player, lx, lz);
            this.stuck.reset();
            return;
        }

        const wx = player.x + randInt(-5, 5);
        const wz = player.z + randInt(-5, 5);
        this.debug(player, `stuck fallback to ${wx}, ${wz}`);
        walkTo(player, wx, wz);
    }
}
