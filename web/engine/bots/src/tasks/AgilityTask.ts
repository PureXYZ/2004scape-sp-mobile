/**
 * AgilityTask.ts — Walk agility courses (Gnome, Barbarian, Wilderness).
 *
 * XP flows entirely through the server RuneScript:
 *   interactLocOp → queues the obstacle interaction → next tick the script
 *   fires stat_advance(agility, X) → Player.addXp() applies the progressive
 *   multiplier.  No manual addXp() is needed here.
 *
 * Failure handling (Barbarian / Wilderness obstacles have fail rates):
 *   On a failed obstacle the RuneScript teleports the player back to the
 *   course start.  We detect completion via position change (≥3 tile movement),
 *   since most obstacles give no XP individually — the lap bonus fires at the
 *   end.  If no movement is detected within MAX_WAIT ticks, assume failure,
 *   reset the obstacle index and walk back to the course.
 */

import {
    BotTask, Player,
    walkTo, interactLocOp, findLocByName,
    findLocByNameWhere,
    isNear, getBaseLevel, getProgressionStep,
    PlayerStat, Locations, randInt,
    StuckDetector, ProgressWatchdog,
    teleportNear, openNearbyGate, humanDelay,
    advanceBankWalk,
} from '#/engine/bot/tasks/BotTaskBase.js';
import { bankStop } from '#/engine/bot/port/BotHabits.js';
import { needsSkillDress } from '#/engine/bot/port/BotGear.js';
import type { SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import { AgilityCourses, levelUpStep } from '#/engine/bot/BotKnowledge.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';

export class AgilityTask extends BotTask {
    private static readonly BARBARIAN_ENTRY_PIPE_X = 2552;
    private static readonly BARBARIAN_ENTRY_PIPE_Z = 3560;
    private static readonly BARBARIAN_ENTRY_STAND_Z = 3561;

    private step: SkillStep;
    /** port: the level the step was last checked against (BotKnowledge.levelUpStep runs when it rises) */
    private stepLevel = -1;

    private state: 'walk' | 'entry_pipe' | 'entry_wait' | 'obstacle' | 'wait' | 'bank_walk' = 'walk';
    /**
     * port (the variety work, round 1, track W: WEAR-5, plate off for agility): its outfit was looked to, once a task: a
     * bot in metal armour stops at the bank nearest it on the way to the course (advanceBankWalk takes the plate off,
     * port/BotGear dressForSkill: Agility is a skill there), never on the course in sight (48-70 % ran it in plate)
     */
    private dressChecked = false;

    private obstacleIndex = 0;
    private waitTicks     = 0;
    private lastX         = 0;
    private lastZ         = 0;
    private lastLevel     = 0;
    private complete      = false;
    private lapsCompleted = 0;
    private static readonly LAPS_PER_TASK = 10;

    /** Ticks to wait for movement before assuming the obstacle failed. */
    private static readonly MAX_WAIT = 25;

    /**
     * Ticks to ignore after queueing an interaction.
     * p_arrivedelay walks the player up to ~3 tiles to reach the obstacle,
     * which would otherwise trigger false completion. Skipping 5 ticks lets
     * p_arrivedelay + p_delay(0) finish so only the actual teleport is detected.
     */
    private static readonly MIN_WAIT = 5;

    /**
     * Minimum tile movement to consider an obstacle completed.
     * Must be 2: both gnome nets only displace the player by 2 tiles
     * (net_1: dz=-2 + level change; net_2: dz=+2 same level).
     */
    private static readonly MOVE_THRESHOLD = 2;

    private readonly stuck    = new StuckDetector(30, 4, 2);
    private readonly watchdog = new ProgressWatchdog();

    constructor(step: SkillStep) {
        super('Agility');
        this.step = step;
        this.watchdog.follow(() => this.step.location);
    }

    override activityStep(): SkillStep | null {
        return this.step;
    }

    shouldRun(_p: Player): boolean {
        return true; // no tools or consumables required
    }

    tick(player: Player): void {
        if (this.interrupted) return;

        // Watchdog resets the state to walk if the bot goes idle too long
        if (this.watchdog.check(player, this.state === 'bank_walk')) {
            player.clearWaypoints();
            player.clearPendingAction();
            this.stuck.reset();
            this.obstacleIndex = 0;
            this.state = 'walk';
            return;
        }

        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }

        // ── Progression upgrade ─────────────────────────────────────────────
        // port: only when the level rose, and only off a step the level has outgrown (BotKnowledge.levelUpStep); upstream
        // drew a random step every tick and jumped to any with a higher minimum, tools or not
        const level   = getBaseLevel(player, PlayerStat.AGILITY);
        if (this.stepLevel === -1) this.stepLevel = level;
        const newStep = level > this.stepLevel ? levelUpStep('AGILITY', this.step, level, undefined, [player.x, player.z]) : null;
        this.stepLevel = level;

        if (newStep && newStep !== this.step) {
            console.log(`[Agility] 📈 Upgrading course (now level ${level})`);
            this.step          = newStep;
            this.obstacleIndex = 0;
            this.state         = 'walk';
            this.stuck.reset();
            this.watchdog.reset();
        }

        // ── port (the variety work, round 1, track W): plate off at a bank first ─
        if (!this.dressChecked && this.state === 'walk') {
            this.dressChecked = true;
            const [lx, lz, ll] = this.step.location;
            if (needsSkillDress(player) && !isNear(player, lx, lz, 30, ll)) this.state = 'bank_walk';
        }
        if (this.state === 'bank_walk') {
            const result = advanceBankWalk(player, this.stuck);
            if (result === 'walk') return;
            this.cooldown = result === 'ready' ? bankStop(player) : 0;
            this.stuck.reset();
            this.state = 'walk';
            return;
        }

        // ── Walk to course start ─────────────────────────────────────────────
        if (this.state === 'walk') {
            const [lx, lz, ll] = this.step.location;
            // port: the Barbarian course is entered through its pipe, walked to (upstream teleported to the pipe from
            // more than 40 tiles away, and on a bot's way into the course)
            if (this._isBarbarianCourse() && (this._needsBarbarianEntryPipe(player) || !isNear(player, lx, lz, 25, ll))) {
                if (!isNear(player, AgilityTask.BARBARIAN_ENTRY_PIPE_X, AgilityTask.BARBARIAN_ENTRY_STAND_Z, 1, 0)) {
                    this._stuckWalk(player, AgilityTask.BARBARIAN_ENTRY_PIPE_X, AgilityTask.BARBARIAN_ENTRY_STAND_Z);
                    return;
                }
                this.state = 'entry_pipe';
                return;
            }

            if (!isNear(player, lx, lz, 15, ll)) {
                this._stuckWalk(player, lx, lz);
                return;
            }

            console.log(`[Agility] 🏃 Arrived at course`);
            this.obstacleIndex = 0;
            this.state         = this._needsBarbarianEntryPipe(player) ? 'entry_pipe' : 'obstacle';
            return;
        }

        if (this.state === 'entry_pipe') {
            const loc = this._findBarbarianEntryPipe(player, 20);
            if (!loc) {
                this._stuckWalk(player, AgilityTask.BARBARIAN_ENTRY_PIPE_X, AgilityTask.BARBARIAN_ENTRY_STAND_Z);
                return;
            }

            if (!isNear(player, loc.x, loc.z, 3, loc.level)) {
                this._stuckWalk(player, loc.x, loc.z + 2);
                return;
            }

            this.lastX     = player.x;
            this.lastZ     = player.z;
            this.lastLevel = player.level;
            interactLocOp(player, loc, 1);

            this.state     = 'entry_wait';
            this.waitTicks = 0;
            this.cooldown  = 1;
            return;
        }

        // ── Find and click the next obstacle ─────────────────────────────────
        if (this.state === 'obstacle') {
            const courseKey = (this.step.extra?.course as string | undefined) ?? 'GNOME';
            const obstacles = AgilityCourses[courseKey];

            if (!obstacles || obstacles.length === 0) {
                console.log(`[Agility] ❌ No obstacles defined for course: ${courseKey}`);
                this.interrupt();
                return;
            }

            if (this.obstacleIndex >= obstacles.length) {
                // Completed a full lap — restart from the first obstacle
                this.obstacleIndex = 0;
                console.log(`[Agility] 🏁 Lap complete, restarting`);
            }

            const obstacle = obstacles[this.obstacleIndex];

            // Search in a generous radius — obstacle locs can be spread out.
            // Also try adjacent levels: some course transitions (e.g. net → level 1,
            // then tree branch at level 0) leave the player on a different level than
            // the next obstacle loc.
            let loc = this._findObstacleLoc(player, obstacle.name, 25);
            if (!loc) {
                const altLevel = player.level === 0 ? 1 : 0;
                loc = this._findObstacleLoc(player, obstacle.name, 25, altLevel);
            }

            if (!loc) {
                // Obstacle not visible yet — wander toward the course centre and retry
                const [lx, lz] = this.step.location;
                walkTo(player, lx + randInt(-4, 4), lz + randInt(-4, 4));
                this.cooldown = 2;
                return;
            }

            // Walk into range before interacting. Some obstacles have a directional
            // guard, so approach offsets target the correct side of the loc.
            const targetX = loc.x + (obstacle.approachDx ?? 0);
            const targetZ = loc.z + (obstacle.approachDz ?? 0);
            const approachDistance = obstacle.approachDx !== undefined || obstacle.approachDz !== undefined ? 0 : 1;
            if (!isNear(player, targetX, targetZ, approachDistance, loc.level)) {
                walkTo(player, targetX, targetZ);
                return;
            }

            // Queue the obstacle interaction (RuneScript fires on next tick)
            this.lastX     = player.x;
            this.lastZ     = player.z;
            this.lastLevel = player.level;
            interactLocOp(player, loc, obstacle.op);

            this.state     = 'wait';
            this.waitTicks = 0;
            this.cooldown  = 1;
            return;
        }

        // ── Wait for player movement to confirm obstacle completion ───────────
        if (this.state === 'wait' || this.state === 'entry_wait') {
            this.waitTicks++;

            // Skip the first MIN_WAIT ticks so that p_arrivedelay (which walks the
            // player up to 3 tiles toward the obstacle) does not trigger a false
            // completion before the actual p_telejump fires.
            if (this.waitTicks < AgilityTask.MIN_WAIT) return;

            const moved        = Math.abs(player.x - this.lastX) + Math.abs(player.z - this.lastZ);
            const levelChanged = player.level !== this.lastLevel;
            if (moved >= AgilityTask.MOVE_THRESHOLD || levelChanged) {
                if (this.state === 'entry_wait') {
                    this.lastX = player.x;
                    this.lastZ = player.z;
                    this.watchdog.notifyActivity();
                    this.state    = 'obstacle';
                    this.cooldown = humanDelay(player, 'retarget'); // port (the realism work): a person's next click
                    return;
                }

                // Player moved — obstacle completed successfully
                this.lastX = player.x;
                this.lastZ = player.z;
                this.watchdog.notifyActivity();

                const courseKey = (this.step.extra?.course as string | undefined) ?? 'GNOME';
                const obstacles = AgilityCourses[courseKey];
                const obstacle = obstacles[this.obstacleIndex];

                if (courseKey === 'BARBARIAN' && obstacle?.name === 'balancing_ledge1' && levelChanged && player.level === 0) {
                    console.log('[Agility] Barbarian ledge failed; continuing from crumbling walls');
                    this.obstacleIndex = 5;
                    this.state = 'obstacle';
                    this.cooldown = humanDelay(player, 'retarget'); // port (the realism work): a person's next click
                    return;
                }

                this.obstacleIndex++;

                const lapDone = this.obstacleIndex >= obstacles.length;
                console.log(
                    `[Agility] ⚡ Obstacle ${this.obstacleIndex}/${obstacles.length} done` +
                    (lapDone ? ' — lap complete!' : '')
                );

                if (lapDone) {
                    this.lapsCompleted++;
                    console.log(`[Agility] 🏁 Lap ${this.lapsCompleted}/${AgilityTask.LAPS_PER_TASK} complete`);
                    if (this.lapsCompleted >= AgilityTask.LAPS_PER_TASK) {
                        this.complete = true;
                        return;
                    }
                    // port: and walks back to the first obstacle (upstream teleported there after every Barbarian lap)
                    this.obstacleIndex = 0;
                }

                this.state    = 'obstacle';
                this.cooldown = humanDelay(player, 'retarget'); // port (the realism work): a person's next click
                return;
            }

            if (this.waitTicks >= AgilityTask.MAX_WAIT) {
                // Timed out — obstacle likely failed; reset and re-navigate to course
                console.log(`[Agility] ⚠️ Obstacle timeout — resetting lap`);
                this.obstacleIndex = 0;
                this.waitTicks     = 0;
                this.state         = 'walk';
                this.stuck.reset();
            }
        }
    }

    isComplete(_p: Player): boolean {
        return this.complete;
    }

    override reset(): void {
        super.reset();
        this.stepLevel     = -1;
        this.state         = 'walk';
        this.dressChecked  = false;
        this.obstacleIndex = 0;
        this.waitTicks     = 0;
        this.lastX         = 0;
        this.lastZ         = 0;
        this.lastLevel     = 0;
        this.stuck.reset();
        this.watchdog.reset();
        this.complete      = false;
        this.lapsCompleted = 0;
    }

    // ── Stuck-walk helper ────────────────────────────────────────────────────

    private _stuckWalk(player: Player, x: number, z: number): void {
        if (!this.stuck.check(player, x, z)) {
            walkTo(player, x, z);
            return;
        }

        if (this.stuck.desperatelyStuck) {
            console.log(`[Agility] 🌀 Teleport escape`);
            teleportNear(player, x, z);
            this.stuck.reset();
            return;
        }

        if (openNearbyGate(player, 5)) return;

        walkTo(
            player,
            player.x + randInt(-10, 10),
            player.z + randInt(-10, 10),
        );
    }

    private _findObstacleLoc(player: Player, name: string, radius: number, level = player.level) {
        if (name === 'castlecrumbly1') {
            return findLocByNameWhere(player.x, player.z, level, name, radius, loc => player.x <= loc.x);
        }

        return findLocByName(player.x, player.z, level, name, radius);
    }

    private _needsBarbarianEntryPipe(player: Player): boolean {
        return this._isBarbarianCourse() && player.level === 0 && player.z > 3558;
    }

    private _isBarbarianCourse(): boolean {
        return ((this.step.extra?.course as string | undefined) ?? 'GNOME') === 'BARBARIAN';
    }

    private _findBarbarianEntryPipe(player: Player, radius: number) {
        return findLocByNameWhere(player.x, player.z, player.level, 'barbarian_obstacle_pipe', radius, loc => {
            return loc.x === AgilityTask.BARBARIAN_ENTRY_PIPE_X &&
                loc.z >= AgilityTask.BARBARIAN_ENTRY_PIPE_Z - 2 &&
                loc.z <= AgilityTask.BARBARIAN_ENTRY_PIPE_Z;
        });
    }
}
