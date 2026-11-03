/**
 * GnomeballTask.ts (port; bots ideas, round 3, theme G: period content): a game of Gnomeball at the Gnome Stronghold's pitch (274's
 * game_gnomeball), as a player plays it, through the real clicks:
 *   1. The walk to the Stronghold (by its agility course, then the pitch side west of the gate: a walk to the pitch from
 *      afar once went astray in the research's probe).
 *   2. The gate (gate_gnomeball_game: 274 unequips both hands into the pack, so it needs the room), the referee's
 *      Talk-to: the first time "Okay then, I'll have a go.", later "I just want to play." (option 2 of each), in a game
 *      with no ball "Have a new ball!"; the ball thrown into its hand.
 *   3. A rally: half the time a pass to a green winger (op 1; 274's winger passes back 2-11 ticks later), then a run up
 *      the middle to 5-9 tiles from the goal and "Shoot" (aploc1 on goal_gnomeball_game: 274's stat_random(ranged, 25,
 *      300 - 5 x distance), (score + 3) x 10 Ranged a goal, the fifth "You win!": 300 Ranged and 300 Agility, a ball
 *      owed). The referee again for each ball. The tacklers hunt the carrier only while the human watches (274's player
 *      hunt needs an observer): a ball lost to one is a real tackle ("got tackled lol" now and then), and the referee
 *      has no new ball while that one is in play, so the carrier is tackled back (its op 1: 274's stat_random(agility,
 *      30, 220)) until it gives the ball up (ten tries at most, then out by the gate); only the gnome with its own ball
 *      (its %npc_attacking_uid), never one with the human's.
 *   4. 1-3 wins in 10-20 minutes (or its time, its Hitpoints under half), then out by the gate (274 gives a won ball into
 *      the pack), its weapon and shield wielded again (their Wield: the gate unequipped them), the free gnomeball
 *      dropped outside the pitch (274's ~dropslot), as a player drops what they do not keep.
 * Who: a members world's levelling bot with Ranged 20+ or an agility theme, combat 20+, Hitpoints 25+, three slots free
 * (its hands, the won ball); port/BotMinigames' catalogue (key 'Gnomeball', weight 1; at most gnomeballCap: 2 at 100,
 * 3 at 500). A minigame visit (port/BotOutings) and a period visit of kind 'gnomeball' (port/BotPeriod: PC10).
 */
import {
    BotTask, Player, InvType,
    walkTo, interactLoc, interactLocOp, interactNpcOp, findLocByName, findNpcByName,
    StuckDetector, randInt, getBaseLevel, PlayerStat,
} from '#/engine/bot/tasks/BotTaskBase.js';
import World from '#/engine/World.js';
import ObjType from '#/cache/config/ObjType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import { botAnswerDialogue, botContinuePage, botScript, findNpcFiltered, interactHeldOp } from '#/engine/bot/BotAction.js';
import NpcType from '#/cache/config/NpcType.js';
import VarNpcType from '#/cache/config/VarNpcType.js';
import type Npc from '#/engine/entity/Npc.js';
import { Locations, PeriodPlaces } from '#/engine/bot/BotKnowledge.js';
import { countMinigame, noteOutingEnd, noteOutingStart, onlineN } from '#/engine/bot/port/BotOutings.js';
import { notePeriodEnd, notePeriodStart, periodOn } from '#/engine/bot/port/BotPeriod.js';
import { sayPeriodLine } from '#/engine/bot/port/BotPeriodPlan.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { themeOf } from '#/engine/bot/port/BotFavourites.js';

/** who may play: Ranged (or an agility theme), combat, Hitpoints, free slots */
export const GNOMEBALL_RANGED = 20;
export const GNOMEBALL_COMBAT = 20;
export const GNOMEBALL_HP = 25;
const FREE_SLOTS = 3;
/** at most this many per 100 online on the pitch at once, at least GNOMEBALL_MIN (2 at 100, 3 at 500) */
export const GNOMEBALL_PER_100 = 0.6;
export const GNOMEBALL_MIN = 2;
/** a visit: its length (ticks: 10-20 min), the wins it plays for */
export const VISIT_TICKS: readonly [number, number] = [1000, 2000];
export const WINS: readonly [number, number] = [1, 3];
/** a pass to a winger this often, a shot from this far (tiles from the goal) */
export const PASS_CHANCE = 0.5;
export const SHOT_TILES: readonly [number, number] = [5, 9];
/** the lines' odds */
const GO_LINE = 0.3;
const SCORE_LINE = 0.1;
const TACKLE_LINE = 0.35;
const WIN_LINE = 0.4;
const LEAVE_LINE = 0.2;

/** the game's ids (looked up once) */
interface GbIds {
    ball: number;
    score: number;
    owed: number;
    /** the varn 274's tackle sets on the gnome that took a player's ball (npc_gnomeball_tackle_success: that uid) */
    taker: number;
}
let ids: GbIds | null = null;
function gbIds(): GbIds {
    ids ??= { ball: ObjType.getId('ball_gnomeball_game'), score: VarPlayerType.getId('score_gnomeball_game'), owed: VarPlayerType.getId('gnomeball_owedball'), taker: VarNpcType.getId('npc_attacking_uid') };
    return ids;
}

/** the visits and what happened (the runner's PC5, the tests) */
export const gnomeballStats = { visits: 0, balls: 0, passes: 0, passedBack: 0, shots: 0, goals: 0, wins: 0, tackles: 0, retakes: 0, rewielded: 0, ended: {} as Record<string, number> };

/** the tacklers holding a ball they took (274's gnome_hasball types) */
let carriers: ReadonlySet<number> | null = null;
function tacklerWithBall(): ReadonlySet<number> {
    carriers ??= new Set(['gnomeballer_red_withball', 'gnomeballer_orange_withball', 'gnomeballer_yellow_withball'].map(n => NpcType.getId(n)).filter(id => id !== -1));
    return carriers;
}

/** a carrier with the player's own ball: the gnome that tackled it (its %npc_attacking_uid the player's uid) */
export function carriesBallOf(n: Npc, p: Player): boolean {
    if (!tacklerWithBall().has(n.type)) return false;
    const id = gbIds().taker;
    if (id === -1 || p.uid === -1) return false;
    const v = n.getVar(id);
    return typeof v === 'number' && (v | 0) === (p.uid | 0);
}

/** bots on a Gnomeball visit now */
const playing = new Set<GnomeballTask>();

export function gnomeballCap(n: number = onlineN()): number {
    return Math.max(GNOMEBALL_MIN, Math.round((GNOMEBALL_PER_100 * n) / 100));
}

function playingNow(): number {
    for (const t of playing) if (t.isDone) playing.delete(t);
    return playing.size;
}

/** May the bot play now (theme G's switch is the caller's): see the header's "Who" */
export function mayPlayGnomeball(p: Player): boolean {
    if (!isMembersWorld() || isNewbie(p) || p.combatLevel < GNOMEBALL_COMBAT || getBaseLevel(p, PlayerStat.HITPOINTS) < GNOMEBALL_HP) return false;
    const agility = themeOf(p.username)?.skills[0] === 'AGILITY';
    if (getBaseLevel(p, PlayerStat.RANGED) < GNOMEBALL_RANGED && !agility) return false;
    return (p.getInventory(InvType.INV)?.freeSlotCount ?? 0) >= FREE_SLOTS;
}

/** The catalogue's entry: a game while the pitch has room. Theme G off: null, no dice. */
export function gnomeballTaskFor(p: Player): BotTask | null {
    if (!periodOn() || !mayPlayGnomeball(p) || playingNow() >= gnomeballCap()) return null;
    return new GnomeballTask();
}

/** on the pitch (274's gnomeball zones: within the pitch's box) */
export function onPitch(p: Player): boolean {
    const [x0, z0, x1, z1] = PeriodPlaces.GNOMEBALL_PITCH_BOX;
    return p.level === 0 && p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1;
}

type Phase = 'travel' | 'side' | 'gate_in' | 'ref' | 'pass' | 'run' | 'shoot' | 'gate_out' | 'rewield' | 'done';

export class GnomeballTask extends BotTask {
    phase: Phase = 'travel';
    private readonly stuck = new StuckDetector(40, 4, 3);
    private started = -1;
    private endsAt = -1;
    private readonly winsWanted: number;
    private wins = 0;
    private outcome = 'done';
    private ended = false;
    private _player: Player | null = null;
    /** what its hands held before the gate (wielded again after) */
    private rhand = -1;
    private lhand = -1;
    private stepAt = -1;
    private tries = 0;
    /** the run's tile, the shot's click, the score before it, the ball in hand last tick */
    private target: [number, number] | null = null;
    private shotAt = -1;
    private score0 = 0;
    private hadBall = false;
    private passedAt = -1;
    /** a tackle of its ball noted (until it has a ball again), its tackles of the carrier */
    private tackled = false;
    private retakes = 0;
    /** a person's moment before its next click (drawn at each: never the same twice, H18) */
    private gap = 6;
    /** the Wield clicks after the gate, the free ball's Drop clicks (each a few at most) */
    private wields = 0;
    private drops = 0;

    constructor(wins = randInt(WINS[0], WINS[1])) {
        super('Gnomeball');
        this.winsWanted = wins;
    }

    get isDone(): boolean {
        return this.phase === 'done';
    }

    shouldRun(_player: Player): boolean {
        return this.phase !== 'done' && !this.interrupted;
    }

    isComplete(_player: Player): boolean {
        return this.phase === 'done';
    }

    override interrupt(): void {
        super.interrupt();
        this._end(this._player, 'interrupted');
    }

    private ball(p: Player): boolean {
        return p.getInventory(InvType.WORN)?.get(3)?.id === gbIds().ball;
    }

    private score(p: Player): number {
        const id = gbIds().score;
        const v = id === -1 ? 0 : p.getVar(id);
        return typeof v === 'number' ? v : 0;
    }

    tick(player: Player): void {
        if (this.interrupted || this.phase === 'done') return;
        this._player = player;
        const now = World.currentTick;
        if (this.started === -1) {
            this.started = now;
            this.endsAt = now + randInt(VISIT_TICKS[0], VISIT_TICKS[1]);
            playing.add(this);
            gnomeballStats.visits++;
            noteOutingStart(player, 'Gnomeball', 'stronghold', 'minigame');
            notePeriodStart(player, 'Gnomeball', 'gnomeball');
            if (Math.random() < GO_LINE) sayPeriodLine(player, 'period', 'gnomeball-go');
        }
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        // (its time, a win count reached, its Hitpoints under half: out by the gate)
        const inside = onPitch(player);
        if (inside && (now >= this.endsAt || this.wins >= this.winsWanted || player.levels[PlayerStat.HITPOINTS] * 2 < player.baseLevels[PlayerStat.HITPOINTS]) && (!['gate_out', 'rewield', 'shoot'].includes(this.phase) || (this.phase === 'shoot' && now - this.shotAt > 40))) {
            this.phase = 'gate_out';
            this.tries = 0;
            this.stepAt = -1;
        }
        if (!inside && now >= this.endsAt && ['travel', 'side'].includes(this.phase)) {
            this._end(player, 'time');
            return;
        }
        // (a level-up's box from the game's XP (a goal's Ranged, a win's Agility: often at 10x), clicked away as a player
        // does, outside the referee's own dialogue: a box left open held the throw's wait for good, a visit of two hours)
        if (this.phase !== 'ref' && this.phase !== 'gate_out' && player.modalChat !== -1 && botContinuePage(player)) return;
        // (a ball gone from its hand on a run: the referee's, or a tackler's to win back)
        const ball = this.ball(player);
        if (this.hadBall && !ball && inside && this.phase === 'run') {
            this.phase = 'ref';
            this.tries = 0;
            this.stepAt = -1;
        }
        if (ball) this.tackled = false;
        this.hadBall = ball;
        switch (this.phase) {
            case 'travel': {
                // (to the Stronghold first, by its agility course; then the pitch side)
                const [ax, az] = Locations.GNOME_AGILITY;
                const [sx, sz] = PeriodPlaces.GNOMEBALL_SIDE;
                if (player.level === 0 && (Math.max(Math.abs(player.x - ax), Math.abs(player.z - az)) <= 30 || Math.max(Math.abs(player.x - sx), Math.abs(player.z - sz)) <= 40)) {
                    this.phase = 'side';
                    this.stuck.reset();
                    return;
                }
                this._walk(player, ax, az);
                return;
            }
            case 'side': {
                const [sx, sz] = PeriodPlaces.GNOMEBALL_SIDE;
                if (player.level === 0 && Math.max(Math.abs(player.x - sx), Math.abs(player.z - sz)) <= 1) {
                    this.phase = 'gate_in';
                    this.tries = 0;
                    return;
                }
                this._walk(player, sx, sz);
                return;
            }
            case 'gate_in': {
                if (inside) {
                    this.phase = 'ref';
                    this.tries = 0;
                    return;
                }
                if (player.delayed || now - this.stepAt < this.gap) return;
                const [gx, gz] = PeriodPlaces.GNOMEBALL_GATE;
                const gate = findLocByName(gx, gz, 0, 'gate_gnomeball_game', 4);
                if (!gate || ++this.tries > 4 || (player.getInventory(InvType.INV)?.freeSlotCount ?? 0) < 2) {
                    this._end(player, 'gate');
                    return;
                }
                const worn = player.getInventory(InvType.WORN);
                this.rhand = worn?.get(3)?.id ?? -1;
                this.lhand = worn?.get(5)?.id ?? -1;
                interactLoc(player, gate);
                this.stepAt = now;
                this.gap = randInt(5, 11);
                return;
            }
            case 'ref': {
                if (ball) {
                    gnomeballStats.balls++;
                    this._rally(player, now);
                    return;
                }
                // (the referee's pages continued, option 2: "Okay then, I'll have a go." / "I just want to play.")
                if (botAnswerDialogue(player, 2) !== null) {
                    this.cooldown = 1;
                    return;
                }
                if (player.delayed || botScript(player)) return;
                if (this.stepAt !== -1 && now - this.stepAt < this.gap) return;
                // (a tackler ran off with its ball (274: only in the human's view): the referee has none while that ball
                // is in play, so the carrier is tackled back, its op 1, stat_random(agility, 30, 220), until it gives.
                // Only the gnome with its own ball: 274's tackle takes any carrier's, the human's too (the review's G-3);
                // another's carrier is left alone, and the referee asked)
                const carrier = findNpcFiltered(player.x, player.z, 0, n => carriesBallOf(n, player), 16);
                if (carrier) {
                    if (!this.tackled) {
                        this.tackled = true;
                        gnomeballStats.tackles++;
                        countMinigame('Gnomeball', 'tackles');
                        if (Math.random() < TACKLE_LINE) sayPeriodLine(player, 'period', 'gnomeball-tackled');
                    }
                    if (++this.retakes > 10) {
                        this.phase = 'gate_out';
                        this.tries = 0;
                        this.stepAt = -1;
                        this.outcome = 'tackled';
                        return;
                    }
                    interactNpcOp(player, carrier, 1);
                    gnomeballStats.retakes++;
                    this.stepAt = now;
                    this.gap = randInt(4, 9);
                    return;
                }
                const [rx, rz] = PeriodPlaces.GNOMEBALL_REFEREE;
                const ref = findNpcByName(rx, rz, 0, 'gnomereferee', 20);
                if (!ref || ++this.tries > 6) {
                    this.phase = 'gate_out';
                    this.tries = 0;
                    this.stepAt = -1;
                    this.outcome = 'ref';
                    return;
                }
                interactNpcOp(player, ref, 1);
                this.stepAt = now;
                this.gap = randInt(9, 16);
                return;
            }
            case 'pass': {
                // (the winger's pass back: 274's 2-11 ticks)
                if (ball && now - this.passedAt > 1) {
                    gnomeballStats.passedBack++;
                    this._run(player);
                    return;
                }
                if (now - this.passedAt > 30) {
                    // (none came: a new ball from the referee)
                    this.phase = 'ref';
                    this.tries = 0;
                    this.stepAt = -1;
                }
                return;
            }
            case 'run': {
                if (!ball) {
                    this.phase = 'ref';
                    this.tries = 0;
                    this.stepAt = -1;
                    return;
                }
                const [tx, tz] = this.target!;
                if (Math.max(Math.abs(player.x - tx), Math.abs(player.z - tz)) <= 1 || this.stuck.check(player, tx, tz)) {
                    this.stuck.reset();
                    const [gx, gz] = PeriodPlaces.GNOMEBALL_GOAL;
                    const goal = findLocByName(gx, gz, 0, 'goal_gnomeball_game', 4);
                    if (!goal) {
                        this.phase = 'gate_out';
                        this.outcome = 'goal';
                        return;
                    }
                    this.score0 = this.score(player);
                    interactLocOp(player, goal, 1);
                    this.shotAt = now;
                    this.phase = 'shoot';
                    gnomeballStats.shots++;
                    return;
                }
                if (!player.hasWaypoints()) walkTo(player, tx, tz, 0);
                return;
            }
            case 'shoot': {
                // (the throw, its flight, the result: 274's p_delays, about 10 ticks)
                if (player.delayed || botScript(player) || now - this.shotAt < 8) return;
                if (ball && now - this.shotAt < 20) return;
                const score = this.score(player);
                if (score > this.score0) {
                    gnomeballStats.goals++;
                    countMinigame('Gnomeball', 'goals');
                    if (Math.random() < SCORE_LINE) sayPeriodLine(player, 'period', 'gnomeball-score');
                } else if (score === 0 && this.score0 === 4) {
                    gnomeballStats.goals++;
                    gnomeballStats.wins++;
                    this.wins++;
                    countMinigame('Gnomeball', 'wins');
                    if (Math.random() < WIN_LINE) sayPeriodLine(player, 'period', 'gnomeball-win');
                }
                this.phase = ball ? 'run' : 'ref';
                if (ball) this._run(player);
                this.tries = 0;
                this.stepAt = -1;
                this.cooldown = randInt(2, 6);
                return;
            }
            case 'gate_out': {
                if (!inside) {
                    this.phase = 'rewield';
                    this.stepAt = -1;
                    if (Math.random() < LEAVE_LINE) sayPeriodLine(player, 'period', 'gnomeball-leave');
                    return;
                }
                if (botAnswerDialogue(player, 2) !== null || player.delayed || botScript(player)) return;
                if (now - this.stepAt < this.gap) return;
                const [gx, gz] = PeriodPlaces.GNOMEBALL_GATE;
                const gate = findLocByName(gx, gz, 0, 'gate_gnomeball_game', 4);
                if (!gate || ++this.tries > 5) {
                    this._end(player, 'stuck');
                    return;
                }
                interactLoc(player, gate);
                this.stepAt = now;
                this.gap = randInt(6, 12);
                return;
            }
            case 'rewield': {
                if (player.delayed || botScript(player) || now - this.stepAt < this.gap) return;
                this.stepAt = now;
                this.gap = randInt(2, 5);
                // (its own weapon and shield back on, one Wield a click; then the free ball dropped)
                const inv = player.getInventory(InvType.INV);
                const worn = player.getInventory(InvType.WORN);
                if (inv && worn && this.wields < 6) {
                    for (const [id, slot] of [
                        [this.rhand, 3],
                        [this.lhand, 5]
                    ] as const) {
                        if (id === -1 || id === gbIds().ball || worn.get(slot)?.id === id) continue;
                        for (let s = 0; s < inv.capacity; s++) {
                            if (inv.get(s)?.id !== id) continue;
                            interactHeldOp(player, inv, id, s, 2);
                            gnomeballStats.rewielded++;
                            this.wields++;
                            return;
                        }
                    }
                }
                if (inv && this.drops < 3) {
                    for (let s = 0; s < inv.capacity; s++) {
                        if (inv.get(s)?.id !== gbIds().ball) continue;
                        interactHeldOp(player, inv, gbIds().ball, s, 5);
                        this.drops++;
                        return;
                    }
                }
                this._end(player, this.outcome === 'done' ? (this.wins > 0 ? 'won' : 'done') : this.outcome);
                return;
            }
        }
    }

    /** a rally with the ball: a pass to a free green winger now and then, else the run */
    private _rally(player: Player, now: number): void {
        if (Math.random() < PASS_CHANCE) {
            const winger = findNpcByName(player.x, player.z, 0, 'gnomeballer_green', 14);
            if (winger) {
                interactNpcOp(player, winger, 1);
                this.passedAt = now;
                this.phase = 'pass';
                gnomeballStats.passes++;
                return;
            }
        }
        this._run(player);
    }

    /** up the middle to 5-9 tiles in front of the goal */
    private _run(player: Player): void {
        const [gx, gz] = PeriodPlaces.GNOMEBALL_GOAL;
        this.target = [gx - randInt(SHOT_TILES[0], SHOT_TILES[1]), gz + randInt(-1, 1)];
        this.phase = 'run';
        this.stuck.reset();
        walkTo(player, this.target[0], this.target[1], 0);
    }

    private _walk(player: Player, x: number, z: number): void {
        if (!this.stuck.check(player, x, z)) {
            if (!player.hasWaypoints() || World.currentTick % 10 === 0) walkTo(player, x, z, 0);
            return;
        }
        // (no jump for a visit: a walk that cannot get there ends it, and the bot's next task goes on from here)
        if (this.stuck.desperatelyStuck) {
            this._end(player, 'stuck');
            return;
        }
        player.clearWaypoints();
        walkTo(player, x, z, 0);
    }

    private _end(player: Player | null, outcome: string): void {
        this.phase = 'done';
        playing.delete(this);
        if (this.ended) return;
        this.ended = true;
        gnomeballStats.ended[outcome] = (gnomeballStats.ended[outcome] ?? 0) + 1;
        if (player) {
            noteOutingEnd(player, outcome);
            notePeriodEnd(player, outcome);
        }
    }

    /** (the debugger, the runner) its phase */
    get state(): string {
        return this.phase;
    }
}

/** (tests) the counts at 0 */
export function resetGnomeballStatsForTest(): void {
    for (const k of Object.keys(gnomeballStats) as (keyof typeof gnomeballStats)[]) {
        if (k === 'ended') gnomeballStats.ended = {};
        else (gnomeballStats as Record<string, unknown>)[k] = 0;
    }
    playing.clear();
}
