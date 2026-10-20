/**
 * BotPlayer.ts
 *
 * Wraps a real engine Player with bot AI.
 */

import Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import InvType from '#/cache/config/InvType.js';
import { BotTask } from '#/engine/bot/tasks/Index.js';
import { BotGoalPlanner } from '#/engine/bot/BotGoalPlanner.js';
import { getBaseLevel, PlayerStat, openNearbyGate, findAggressorNpc, refreshWorn } from '#/engine/bot/BotAction.js';
import { PlayerStatNameMap } from '#/engine/entity/PlayerStat.js';
import ScriptState from '#/engine/script/ScriptState.js';
import { BotMovementMonitor } from '#/engine/bot/BotNavigation.js';
import { BotDebugService } from '#/engine/bot/debug/BotDebugService.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { defend, OWN_DEFENCE_KINDS } from '#/engine/bot/port/BotDefence.js';
import { botEmote, everydayEmote } from '#/engine/bot/port/BotEmote.js';
import { newbiePlanEnds } from '#/engine/bot/port/BotNewbie.js';
import { botSay, type LineKind } from '#/engine/bot/port/BotSay.js';
import { nameIndex } from '#/engine/bot/port/BotSeed.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { noteSpoke, type SpokeKind } from '#/engine/bot/port/BotSpoke.js';
import { tickHabits } from '#/engine/bot/port/BotHabits.js';
import { chatterLevelUp, tickChatter } from '#/engine/bot/port/BotChatter.js';
import { isMilestone } from '#/engine/bot/port/BotLines.js';
import { isCastHeld } from '#/engine/bot/port/BotTeleport.js';
import { isArmed, randomEventTaskFor } from '#/engine/bot/port/BotRandomEvents.js';
import { noteTaskSwitch } from '#/engine/bot/port/BotSpots.js';

const RESCAN_TICKS = 600;
/**
 * port: how long a plan holds (a random 15-60 minutes, in ticks): the rescan switches activity only
 * when it is over. Upstream switched at every rescan whose pick differed (a new job about every 6 minutes, much of
 * the time spent walking between them). A plan ends early when its task fails, completes or cannot run, or when a
 * levelling bot gained no XP in PLAN_STALL_TICKS.
 */
const PLAN_TICKS: [number, number] = [1500, 6000];
/** port: 15 minutes without XP and a levelling bot's plan is over */
const PLAN_STALL_TICKS = 1500;
/** port: a milestone's cheer comes this many ticks after the level-up (its box first), and is tried for 10 more */
const CHEER_DELAY_TICKS = 3;

// port: and Bankstand, which ends on its own (30 minutes); upstream's rescan cut every stint at 6 minutes. (The realism
// work's phase 5b: and a set piece's own long tasks, a Duel Arena visit and a party's host, which end on their own.)
const NO_INTERRUPT_TASKS = new Set(['ShopTrip', 'Bank', 'Walk', 'Init', 'Idle', 'Prayer', 'Bankstand', 'DuelArena', 'PartyHost']);

// port: upstream's idle lines read like real chat with the players' names cut out (" hates attackishere", "Are you
// ignoring me, ?!"), and upstream said them so, half a sentence. The data marks each gap with {name}, and the bot fills
// in a player near it: a human (sometimes the one playing) or another bot, never itself (port/BotLines).
export const NAME_SLOT = '{name}';

export function fillName(phrase: string, name: string): string {
    return phrase.replaceAll(NAME_SLOT, name);
}

// port (the realism work, phase 2): what a bot says unprompted is port/BotChatter's (its persona's rate, in bursts,
// events first, never mid-fight or with an interface open) from port/BotLines (upstream's idle lines where they fit,
// the 2004 lines for the gaps). Upstream rolled IDLE_LINE_CHANCE (0.3 % a tick, a newbie 1.2 %) in any state and
// picked any of the 1,081 lines: about 24 lines an hour each, 90 % of the skill and place lines unfit.

function chance(p: number): boolean {
    return Math.random() < p;
}

/** a line's kind for the say listeners (port/BotSay), from what port/BotSpoke notes */
const LINE_KIND: Readonly<Record<SpokeKind, LineKind>> = { idle: 'idle', levelup: 'levelup', social: 'social', newbie: 'newbie', question: 'idle', event: 'event' };

export class BotPlayer {
    readonly player: Player;
    readonly planner: BotGoalPlanner;
    readonly name: string;

    currentTask: BotTask | null = null;
    taskHistory: string[] = [];

    private ticksAlive = 0;
    /** port: starts at a point of its own (from the name): all at 0, a world's bots rescanned in the same tick */
    private rescanTimer: number;
    /** port: the tick the current plan is over (PLAN_TICKS), and the XP and tick it last moved (PLAN_STALL_TICKS) */
    private planEnds = 0;
    private planXp = -1;
    private planXpTick = 0;
    private planFailCount = 0;
    /** Counts ticks between universal gate sweeps (fires every 5 ticks). */
    private gateCheckTimer = 0;

    // ── Movement monitoring ───────────────────────────────────────────────────
    readonly movementMonitor = new BotMovementMonitor();
    /** Position at the end of the previous tick (set by engine movement before bot.tick). */
    private lastX = -1;
    private lastZ = -1;
    private lastLevel = -1;
    /** Whether the bot had waypoints queued at the end of the previous tick. */
    private lastHadWaypoints = false;

    // ── Sub-task system (for bury bones, eating, etc.) ───────────────────────
    private subTask: BotTask | null = null;

    // ── Level-ups (port) ──────────────────────────────────────────────────────
    // The base levels last tick: 274 levels a player up in its content scripts, so nothing called onLevelUp (upstream
    // called it from its patched Player.ts, which the port leaves alone), and no bot ever said a level-up line.
    private levelCache: Int32Array | null = null;
    /** port: the tick of a milestone's cheer (port/BotEmote), or -1; a 99's whatever the bot did last (no everyday rest) */
    private cheerAt = -1;
    private cheer99 = false;

    // ── Appearance (port) ─────────────────────────────────────────────────────
    // What the last appearance showed: the combat level, then the worn item ids (-2 = never built here).
    private appearanceKey: Int32Array | null = null;

    constructor(player: Player, planner: BotGoalPlanner) {
        this.player = player;
        this.planner = planner;
        this.name = player.username;
        this.rescanTimer = nameIndex(player.username, 'rescan-phase', RESCAN_TICKS);

        // link player → bot (so tasks/BotAction can access this)
        (player as any)._bot = this;

        BotDebugService.registerBot(this);
    }

    // ── Bot debugger accessors (see engine/bot/debug/) ────────────────────────
    // Structural shape consumed by BotDebugService.DebuggableBot. Read-only,
    // no gameplay effect — purely so the debugger can build snapshots without
    // reaching into private fields via reflection.
    get ticksAliveValue(): number {
        return this.ticksAlive;
    }
    get plannerRescanCountdown(): number {
        return Math.max(0, RESCAN_TICKS - this.rescanTimer);
    }
    get plannerFailCount(): number {
        return this.planFailCount;
    }
    movementMonitorInfo(): { isStuck: boolean; isOscillating: boolean; stuckTicks: number } {
        return {
            isStuck: this.movementMonitor.isStuck(),
            isOscillating: this.movementMonitor.isOscillating(),
            stuckTicks: this.movementMonitor.getStuckTicks()
        };
    }

    // ── Debug-only per-tick observation state ─────────────────────────────────
    private _debugPrevStats: Int32Array | null = null;
    private _debugPrevInvTotal = -1;

    /**
     * Observes real evidence of progress (XP gains, inventory changes) once per
     * tick and feeds it to BotDebugService so the dashboard can tell "an
     * interaction was clicked" apart from "the interaction actually worked" —
     * without every task needing to report this itself. Also closes out
     * stale in-flight actions via a tick-based timeout. No-op when the
     * debugger is disabled; any failure here must never affect the bot.
     */
    private _debugTick(): void {
        if (!BotDebugService.enabled) return;

        const p = this.player;

        BotDebugService.noteTaskChange(this.name, this.currentTask?.name ?? null);
        if (this.currentTask) {
            const state = (this.currentTask as unknown as Record<string, unknown>).state;
            BotDebugService.noteStateChange(this.name, typeof state === 'string' ? state : null);
        } else {
            BotDebugService.noteStateChange(this.name, null);
        }

        if (!this._debugPrevStats || this._debugPrevStats.length !== p.stats.length) {
            this._debugPrevStats = Int32Array.from(p.stats);
        } else {
            for (let stat = 0; stat < p.stats.length; stat++) {
                const cur = p.stats[stat];
                const prev = this._debugPrevStats[stat];
                if (cur > prev) {
                    const gained = (cur - prev) / 10;
                    BotDebugService.noteXpGain(this.name, stat, cur);
                    const statName = PlayerStatNameMap.get(stat) ?? `stat${stat}`;
                    BotDebugService.event(this.name, 'xp', `+${gained} ${statName}`, { stat, gained });
                    BotDebugService.resolveActionSuccess(this.name, `+${gained} ${statName}`);
                    this._debugPrevStats[stat] = cur;
                }
            }
        }

        const inv = p.getInventory(InvType.INV);
        if (inv) {
            let total = 0;
            for (let i = 0; i < inv.capacity; i++) {
                const item = inv.get(i);
                if (item) total += item.count;
            }
            if (this._debugPrevInvTotal === -1) {
                this._debugPrevInvTotal = total;
            } else if (total !== this._debugPrevInvTotal) {
                BotDebugService.event(this.name, 'inventory', `inventory count ${this._debugPrevInvTotal} -> ${total}`);
                BotDebugService.resolveActionSuccess(this.name, 'inventory changed');
                this._debugPrevInvTotal = total;
            }
        }

        BotDebugService.resolveStaleAction(this.name);
    }

    /** True (once) when the worn items or the combat level differ from what the last appearance showed. */
    private _appearanceChanged(): 'worn' | 'level' | null {
        const worn = this.player.getInventory(InvType.WORN);
        const slots = worn?.capacity ?? 0;
        const key = this.appearanceKey && this.appearanceKey.length === slots + 1 ? this.appearanceKey : (this.appearanceKey = new Int32Array(slots + 1).fill(-2));
        let changed: 'worn' | 'level' | null = null;
        if (key[0] !== this.player.combatLevel) {
            key[0] = this.player.combatLevel;
            changed = 'level';
        }
        for (let slot = 0; slot < slots; slot++) {
            const id = worn?.get(slot)?.id ?? -1;
            if (key[slot + 1] !== id) {
                key[slot + 1] = id;
                changed = 'worn';
            }
        }
        return changed;
    }

    /**
     * port: the bot stops what it is doing before it logs out (its session is over, or a human takes its name): the
     * tasks are reset, which releases their claims on trees, rocks, NPCs and social partners (BotTaskBase, CombatTask,
     * RangedMagicTask, SocialTask), so no other bot keeps skipping them after it left.
     */
    windDown(): void {
        try {
            this.subTask?.reset();
        } catch (err) {
            console.error(`[Bot:${this.name}] winding down its subtask failed`, err);
        }
        this._dropSubTask();
        const task = this.currentTask;
        if (task) {
            try {
                task.interrupt();
                task.reset();
            } catch (err) {
                console.error(`[Bot:${this.name}] winding down its task failed`, err);
            }
        }
        this.player.clearPendingAction();
        this.player.clearWaypoints();
    }

    /**
     * port: the bot's answer to a monster that attacks it (port/BotDefence), unless its task answers its own (a fight,
     * thieving). True while it fights or runs: the task waits. The third run in a few minutes ends the task.
     */
    private _selfDefence(): boolean {
        const task = this.subTask ?? this.currentTask;
        if (!task || this.player.delayed) return false;
        // port: a fight that is over (interrupted) or cannot go on (hurt with no food: its shouldRun) answers no
        // attacker, and the planner can hand the bot the same kind again that cannot run either: it is defended here.
        // An archer at under half its Hitpoints stood still while a monk or a giant rat killed it (the coverage run)
        if (OWN_DEFENCE_KINDS.has(task.name.split(':')[0]) && !task.interrupted && (!findAggressorNpc(this.player, 8) || task.shouldRun(this.player))) return false;
        const answer = defend(this.player);
        if (answer === 'give-up' && this.currentTask) {
            this.log(`${this.currentTask.name}: attacked and on the run a third time, done here`);
            this.currentTask.interrupt();
        }
        return answer !== null;
    }

    // ── Sub-task API ─────────────────────────────────────────────────────────
    setSubTask(task: BotTask): void {
        if (this.subTask && this.subTask !== task) {
            // port (the realism work, phase 5b): the one replaced is over, not paused (a sub-task is never resumed): its
            // interrupt releases what it held (a duel's screens and its set-piece role, a hang-out's spot), which a
            // "come here" or a follow taking its place left held for good
            this._interruptSubTask();
            this._dropSubTask();
        }
        task.reset();
        this.subTask = task;
    }

    private _interruptSubTask(): void {
        const task = this.subTask;
        if (!task || task.isComplete(this.player)) return;
        try {
            task.interrupt();
        } catch (err) {
            console.error(`[Bot:${this.name}] interrupting its subtask failed`, err);
        }
    }

    /** port (the realism work, phase 3): a sub-task holds the bot (a "come here", a follow, a bank trip before a logout) */
    hasSubTask(): boolean {
        return this.subTask !== null;
    }

    /**
     * port: the sub-task is over (done, cannot run, failed, replaced). A "come here" takes its errand with it
     * (botComeHereReturnX/Z: set by BotChat, it stayed set for the whole login, so the bot never took a break or wrapped
     * up before a logout again); a vendor called over keeps it for the trade that ended the wait (VendorTask walks it
     * back there and clears it).
     */
    private _dropSubTask(): void {
        const task = this.subTask;
        this.subTask = null;
        if (task?.name === 'ComeHere' && !(this.player.botPlanner === 'extras_vendor' && this.player.botTradeTargetPid !== -1)) {
            this.player.botComeHereReturnX = -1;
            this.player.botComeHereReturnZ = -1;
        }
    }

    tick(): void {
        this.ticksAlive++;
        // (274's random events: a bot keeps the flag only when port/BotRandomEvents armed it, near a human; phase 5a)
        if (!isArmed(this.player)) this.player.afkEventReady = false;
        this._checkLevelUps();
        if (this.cheerAt !== -1 && this.ticksAlive >= this.cheerAt && ((this.cheer99 ? botEmote : everydayEmote)(this.player, 'cheer', true) || this.ticksAlive - this.cheerAt >= 10)) this.cheerAt = -1;

        try {
            this._debugTick();
        } catch {
            // debugger failure must never affect bot ticking
        }

        // ── MOVEMENT MONITORING ──────────────────────────────────────────────
        // Compare current position (already updated by engine movement this tick)
        // against the position saved at the end of the previous tick to determine
        // if the bot actually moved.  Only evaluate when the bot was trying to walk
        // (had waypoints at the end of last tick) — avoid false stuck alerts while
        // skilling, banking, or waiting on scripts.
        const curX = this.player.x;
        const curZ = this.player.z;
        const curLevel = this.player.level;

        if (this.lastX !== -1) {
            const moved = curX !== this.lastX || curZ !== this.lastZ || curLevel !== this.lastLevel;
            this.movementMonitor.update(curX, curZ, this.lastHadWaypoints, moved);

            if (this.lastHadWaypoints && this.movementMonitor.isStuck()) {
                this.log(
                    `[Navigation] stuck at (${curX},${curZ},${curLevel}) — clearing waypoints for repath`
                );
                this.player.clearWaypoints();
                this.movementMonitor.resetStuck();
            } else if (this.movementMonitor.isOscillating()) {
                this.log(
                    `[Navigation] oscillating at (${curX},${curZ},${curLevel}) — clearing waypoints`
                );
                this.player.clearWaypoints();
                this.movementMonitor.resetOscillation();
            }
        }

        this.lastX = curX;
        this.lastZ = curZ;
        this.lastLevel = curLevel;

        // port: upstream rebuilt the appearance here every tick, which re-sends ~60 bytes per bot in view in every
        // PLAYER_INFO (27× the bytes; with ~75 bots in view the 5,000-byte budget runs out and some never appear).
        // Rebuild it when what it shows changes: the worn items or the combat level. Gear put on by hand (worn.set) gets
        // what the wear script would have set: its animations, bonuses and combat varps (refreshWorn). The weapon in hand
        // as the one before: a change the wear script made had its autocast reset there, not again a tick later.
        const changed = this._appearanceChanged();
        if (changed === 'worn') refreshWorn(this.player, this.player.getInventory(InvType.WORN)?.get(3)?.id ?? -1);
        else if (changed === 'level') this.player.buildAppearance(InvType.WORN);

        if (this.ticksAlive === 1) {
            this.log(`Online at (${this.player.x}, ${this.player.z}, ${this.player.level}) slot=${this.player.slot}`);
        }

        // port: a dead bot (its death script runs; Hitpoints 0 until it is back in Lumbridge) does nothing. Its task
        // gave up on the fight (it could not run hurt) and the next one walked the body off along the road, and the
        // sims counted the death against that next task (a fighter's death "at a skill or on an errand")
        if (this.player.levels[PlayerStat.HITPOINTS] <= 0) return;

        // Auto-respond to p_countdialog: bots have no client to send resume_p_countdialog,
        // so the script hangs forever. Reply with 99 so the full inventory is processed.
        if (this.player.activeScript?.execution === ScriptState.COUNTDIALOG) {
            this.player.activeScript.lastInt = 99;
            this.player.executeScript(this.player.activeScript, true, true);
            return;
        }

        // port: what it says unprompted (port/BotChatter: its persona's rate, events first, nothing mid-fight; at a trade
        // bank's stall a line waits for the bank's turn, as an advert does)
        tickChatter(this.player);

        // ── A TELEPORT CAST (port/BotTeleport, the realism work's phase 5a) ──
        // port: while the spell's script holds the bot it does nothing else (its clocks wait, as on a break)
        if (isCastHeld(this.player)) {
            this.planXpTick++;
            this.lastHadWaypoints = this.player.hasWaypoints();
            return;
        }

        // ── HABITS (port/BotHabits, the realism work) ────────────
        // port: a short break, a look at something, leaving like a player: while one holds the bot it does nothing else
        // (its task, the rescan and their clocks wait, the no-XP clock with them; it still answers an attacker: a hit
        // ends a break)
        if (tickHabits(this)) {
            this.planXpTick++;
            this.lastHadWaypoints = this.player.hasWaypoints();
            return;
        }

        // ── SELF-DEFENCE (port/BotDefence) ───────────────────────
        // port: a monster attacks a bot that is not out to fight: it fights off a weak one and runs from the rest,
        // and its task waits meanwhile
        if (this._selfDefence()) return;

        // ── A RANDOM EVENT (port/BotRandomEvents, the realism work's phase 5a) ──
        // port: the bot's answer to an event that came to it (the genie, a lamp, a strange box, the way back from a fail
        // teleport) runs as a sub-task
        {
            const eventTask = randomEventTaskFor(this.player, this.subTask);
            if (eventTask && eventTask !== this.subTask) this.setSubTask(eventTask);
        }

        // ── SUB TASK (HIGH PRIORITY) ─────────────────────────────
        if (this.subTask) {
            if (this.subTask.isComplete(this.player) || !this.subTask.shouldRun(this.player)) {
                this._dropSubTask();
            } else {
                try {
                    this.subTask.tick(this.player);
                } catch (err) {
                    console.error(`[Bot:${this.name}] SubTask error:`, err);
                    this._interruptSubTask();
                    this._dropSubTask();
                }
                return; // ⛔ block main task while subtask runs
            }
        }

        // ── RESCAN ───────────────────────────────────────────────
        this._watchPlan();
        this.rescanTimer++;
        if (this.rescanTimer >= RESCAN_TICKS) {
            this.rescanTimer = 0;

            // port: and never in a trade (a switch closes the trade window: "Other player declined trade.")
            // port: and only when the plan is over (PLAN_TICKS); then a new one starts, whatever the pick
            if (this.currentTask && !NO_INTERRUPT_TASKS.has(this.currentTask.name) && this.player.botTradeTargetPid === -1 && World.currentTick >= this.planEnds) {
                this._newPlan();
                const candidate = this.planner.pickTask(this.player);

                if (candidate && candidate.name !== this.currentTask.name) {
                    this.log(`Rescan: ${this.currentTask.name} → ${candidate.name}`);
                    this.currentTask.interrupt();
                    this._switchTask(candidate);
                    this.currentTask.reset();
                    this.planFailCount = 0;
                    return;
                }
            }
        }

        // ── NORMAL TASK LOOP ─────────────────────────────────────

        if (!this.currentTask) {
            const next = this._pickTask();
            if (!next) return;
            this._switchTask(next);
        }

        if (this.currentTask!.isComplete(this.player)) {
            this._recordComplete();
            const next = this._pickTask();
            if (!next) return;
            this._switchTask(next);
        }

        if (this.currentTask!.interrupted) {
            const next = this._pickTask();
            if (!next) return;
            this._switchTask(next);
        }

        if (!this.currentTask!.shouldRun(this.player)) {
            this.planFailCount++;
            this.log(`${this.currentTask!.name} can't run (fail #${this.planFailCount})`);

            if (this.planFailCount >= 5) {
                this.planFailCount = 0;
                this.rescanTimer = RESCAN_TICKS;
                this.planEnds = 0; // port: and the plan with it
            }

            const next = this._pickTask();
            if (!next) return;
            this._switchTask(next);
            return;
        }

        this.planFailCount = 0;

        const activeTask = this.currentTask;
        if (!activeTask) return;

        // ── UNIVERSAL GATE SWEEP ─────────────────────────────────────────────
        // Every 5 ticks, open any closed door or gate within 10 tiles regardless
        // of which task is running or which state it is in.  This covers the
        // "targeting an NPC behind a fence" case where walkTo is not being called
        // (e.g. a combat bot re-engaging its target every 12 ticks while a gate
        // sits between them unopened).  Skip if the player is already mid-script
        // (delayed) or already has a pending interaction (e.g. attacking an NPC).
        //if (++this.gateCheckTimer >= 5) {
            //this.gateCheckTimer = 0;
            //if (!this.player.delayed && !this.player.hasInteraction()) {
            //    openNearbyGate(this.player, 5);
          //  }
        //}

        try {
            activeTask.tick(this.player);
        } catch (err) {
            console.error(`[Bot:${this.name}] Task error in ${activeTask.name}:`, err);
            this.currentTask = null;
        }

        // Record waypoint state at end of this tick so next tick can detect stuck/oscillation
        this.lastHadWaypoints = this.player.hasWaypoints();
    }

    /** port: a skill's base level rose by a few since last tick (a level-up); a jump of many is a direct write (an age, a
     * PKer's build) and says nothing */
    private _checkLevelUps(): void {
        const levels = this.player.baseLevels;
        const cache = this.levelCache;
        if (!cache || cache.length !== levels.length) {
            this.levelCache = Int32Array.from(levels);
            return;
        }
        for (let stat = 0; stat < levels.length; stat++) {
            const was = cache[stat];
            const now = levels[stat];
            if (now === was) continue;
            cache[stat] = now;
            if (now > was && now - was <= 3 && this.ticksAlive > 1) this.onLevelUp(stat as PlayerStat, now);
        }
    }

    onLevelUp(stat: PlayerStat, newLevel: number): void {
        const statName = PlayerStatNameMap.get(stat) ?? `stat${stat}`;
        this.log(`LEVEL UP: ${statName} → ${newLevel}`);

        // port (the realism work, phase 2): a 2004 player's line ("40 wc!!", "woot 41 mining", "finally! 40 wc"), mostly
        // at the milestones (every 10th, 99, 40 attack, 43 prayer ...), after a moment's typing and never mid-fight
        // (port/BotChatter, port/BotLines). Upstream's "<phrase> - <stat> <level>" was every level-up line's shape.
        const milestone = isMilestone(statName, newLevel);
        const cb = this.player.getCombatLevel();
        chatterLevelUp(this.player, statName, newLevel, milestone, cb > this.player.combatLevel ? cb : null);
        // port: and a cheer at a milestone (port/BotEmote), once the game's level-up box is out of the way: always at 99,
        // now and then at 70, 80, 90 (since 2026-10-19, "rare and special": a cheer every other 10th level was
        // 300 an hour among 500 bots at 10x XP)
        if (newLevel === 99 || (newLevel >= 70 && newLevel % 10 === 0 && chance(0.15))) {
            this.cheerAt = this.ticksAlive + CHEER_DELAY_TICKS;
            this.cheer99 = newLevel === 99;
        }
        // port: no forced re-plan (upstream's rescan here): the tasks move to a new step on a level-up themselves
    }

    snapshot() {
        const p = this.player;

        return {
            name: this.name,
            x: p.x,
            z: p.z,
            level: p.level,
            task: this.currentTask?.name ?? 'idle',
            wc: getBaseLevel(p, PlayerStat.WOODCUTTING),
            fishing: getBaseLevel(p, PlayerStat.FISHING),
            mining: getBaseLevel(p, PlayerStat.MINING),
            attack: getBaseLevel(p, PlayerStat.ATTACK),
            strength: getBaseLevel(p, PlayerStat.STRENGTH),
            defence: getBaseLevel(p, PlayerStat.DEFENCE),
            hitpoints: getBaseLevel(p, PlayerStat.HITPOINTS),
            prayer: getBaseLevel(p, PlayerStat.PRAYER),
            ticksAlive: this.ticksAlive
        };
    }

    log(msg: string): void {
        console.log(`[Bot:${this.name}][t${this.ticksAlive}] ${msg}`);
    }

    private _pickTask(): BotTask | null {
        const task = this.planner.pickTask(this.player);

        if (task) {
            task.reset();
            this.log(`→ ${task.name}`);
        }

        return task;
    }

    /**
     * Switches to a new task. Awards 5 Agility XP whenever the task name
     * actually changes (i.e. a different skill/activity was picked).
     *
     * XP is passed as tenths (the engine's internal format): 50 = 5.0 displayed XP.
     * (Level 2 threshold is 830 internally = 83.0 displayed XP.)
     */
    private _switchTask(next: BotTask): void {
        // port: a new task, a new plan (PLAN_TICKS)
        this._newPlan();
        if (this.currentTask) {
            // port: no Agility XP for a switch (bots get only the XP the game gives). Upstream gave
            // 1.0 for every change of task, a few levels over a session for bots that never trained the skill
            this.currentTask.reset(); // allow outgoing task to clean up (e.g. CombatTask unequips armor)
        }
        this.currentTask = next;
        noteTaskSwitch(this.player, next); // (variety round 1, the fixes: the spots' count of this tick follows: port/BotSpots)
        this.movementMonitor.reset(); // clear stuck/oscillation state between tasks
    }

    /**
     * port: a plan of 15-60 minutes from now (PLAN_TICKS), its XP clock started; a newbie's a few minutes (port/BotNewbie
     * newbiePlanEnds: its rescan asks the planner again, so it leaves the chickens soon after it outgrew them)
     */
    private _newPlan(): void {
        const now = World.currentTick;
        this.planEnds = now + PLAN_TICKS[0] + Math.floor(Math.random() * (PLAN_TICKS[1] - PLAN_TICKS[0] + 1));
        this.planEnds = Math.min(this.planEnds, newbiePlanEnds(this.player, now));
        this.planXp = -1;
        this.planXpTick = now;
    }

    /** port: a levelling bot that gained no XP in PLAN_STALL_TICKS is done with its plan (checked every 100 ticks) */
    private _watchPlan(): void {
        const now = World.currentTick;
        if (now % 100 !== 0 || !isLevelling(this.player.botPlanner as PlannerKey)) return;
        let xp = 0;
        for (let i = 0; i < this.player.stats.length; i++) xp += this.player.stats[i];
        if (xp !== this.planXp) {
            this.planXp = xp;
            this.planXpTick = now;
        } else if (now - this.planXpTick >= PLAN_STALL_TICKS && now < this.planEnds) {
            this.log(`no XP for ${now - this.planXpTick} ticks: the plan is over`);
            this.planEnds = now;
            this.rescanTimer = RESCAN_TICKS - 1; // (the rescan is next)
        }
    }

    private _recordComplete(): void {
        if (!this.currentTask) return;

        this.log(`✓ ${this.currentTask.name}`);
        this.taskHistory.push(this.currentTask.name);

        if (this.taskHistory.length > 10) {
            this.taskHistory.shift();
        }
    }

    /** port: and noted (port/BotSpoke): a human's answer to the line finds this bot (BotChat); its kind to the listeners */
    private _say(message: string, kind: SpokeKind, to: Player | null = null): void {
        botSay(this.player, message, undefined, LINE_KIND[kind], to);
        noteSpoke(this.player, kind, World.currentTick, to);
    }
}
