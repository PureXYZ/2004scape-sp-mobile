/**
 * port (bots ideas, the KQ track: real, rare, honest KQ attempts)
 * Kalphite Queen attempts, on port/BotEndgameTeams' KBD machinery (the call, the recruits a friend's PM away, the role
 * 'bosser' that holds a logout and keeps the director off, the leader's end ending its team), outside the director
 * (port/BotDirector's hourly mix untouched):
 *   - who: a team of 4-6, each combat 100+, Prayer 43+, KQ_FOOD_GATE pieces of good food and KQ_COINS owned, on a members
 *     world; the leader an eligible bosser whose pick fell on the KQ (port/BotEndgame's offer) while at least 3 more of the
 *     bar are free online (none: no offer, no dice); at most one attempt per KQ_GAP of play world-wide (rare);
 *   - before: the leader banks (food, coins) and buys 2 ropes from Ned in Draynor (his own dialogue, area_draynor's
 *     ned.rs2: "Yes, I would like some rope.", "Okay, please sell me some rope.", 15 coins each; a leader with 2 ropes
 *     banked takes those); the call at Al Kharid bank ('setpiece' lines, out of H7, against each speaker's budget: "kq team
 *     need 4"), again every KQ_CALL_GAP while fewer than 3 of the bar are free, KQ_CALLS at most ("nvm no1 wants kq
 *     lol"); its recruits bank there and meet it ("who has rope", "i got 2 ropes");
 *   - the way in: each buys 2 waterskins and a Shantay pass from Shantay's shop and goes through the Shantay Pass the
 *     game's way (area_alkharid's shantay_pass.rs2: the gate's Go-through, the poster's "Yeah, that poster doesn't scare
 *     me!", the pass handed over, the queue's walk through; the desert heat's timer is 274's, its waterskins drunk by it);
 *     the members follow the leader across the desert to the burrow (3227,3108); the leader's rope on it (area_kalphite's
 *     kalphite_locs.rs2: the rope used up, the roped entrance there ^lootdrop_duration, 200 ticks) and each climbs down
 *     within them; through the tunnels (their workers, soldiers and guardians hunt everyone: walked through, eating) to
 *     the chamber's entrance (3509,9497), the second rope, down;
 *   - the fight (kalphite_queen.rs2): Protect from Magic pressed in the chamber (her lightning hits everyone within 10 for
 *     up to 31 with no accuracy roll unless they pray it; her spines and her melee are not stopped by it), each bot's own
 *     Attack on her, eating when hurt (a fight of its own, as port/BotVelrak's jailer: a CombatTask runs from a level-141
 *     guardian); a bot leaves under KQ_FLEE_HP of its Hitpoints with KQ_FLEE_FOOD or fewer pieces of food left, by the
 *     chamber's rope (3508,9494) and then the burrow's; the team runs ("nvm run") once half of those in the chamber are
 *     gone (fled or dead), or after CHAMBER_TICKS; form 1's fall said ("phase 2!!");
 *   - after: out through the gate (free from the south: its own script's jump north), home to Al Kharid bank; "we wiped
 *     lol", "kq is impossible".
 * Mostly failing, honestly: the research's probe teams of 4 and 6 at combat 110 dealt 400-440 of her 510 Hitpoints (255 a
 * form) before their food ran out. A kill's drop is the game's (its table, kalphite_queen.rs2: rune chainbody 14/128,
 * dragon chainbody 1/128), its finder's moment and later sale as every endgame drop's (port/BotEndgameFight's watcher,
 * port/BotDropSale). A bot's death is as today: its items kept (the death overlay, patch 0003), its trip over at
 * Lumbridge (port/BotEndgameFight's death check: it never walks back).
 */
import type Player from '#/engine/entity/Player.js';
import type Npc from '#/engine/entity/Npc.js';
import type Obj from '#/engine/entity/Obj.js';
import NpcType from '#/cache/config/NpcType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import World from '#/engine/World.js';
import { Locations } from '#/engine/bot/BotKnowledge.js';
import { botAnswerDialogue, botScript, countItem, findLocByName, findNpcFiltered, getBaseLevel, interactLocOp, interactNpcOp, interactObjOp, interactPlayerOp, isInventoryFull, noteMove, walkTo } from '#/engine/bot/BotAction.js';
import { eatBestFood, humanDelay } from '#/engine/bot/tasks/BotTaskBase.js';
import { act, bank, clickLoc, obj, owned, shop, soft, talk, useOnLoc, walk, when, type At, type ErrandPlan, type Step } from '#/engine/bot/tasks/ErrandTask.js';
import type { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';
import { BosserErrand, clearEndgameStart, emitEndgameEvent, lastEndgameStart } from '#/engine/bot/port/BotEndgameCore.js';
import { deathCheck, fightWatcher, foodIds, foodWithdraw, goodFoodCarried, goodFoodOwned, protectPrayer, protectionsOff, whileAlive } from '#/engine/bot/port/BotEndgameFight.js';
import { call, eatWhenLow, eating, summon } from '#/engine/bot/port/BotEndgameTeams.js';
import { isFreeForEvent, LEAD_SESSION_LEFT } from '#/engine/bot/port/BotDirector.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { cliqueOf } from '#/engine/bot/port/BotCliques.js';
import { worldPlayers } from '#/engine/bot/port/BotPlayers.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';

// ── the places (274's map and its kalphite.constant) ────────────────────────────────────────────────────────────────

const DRAYNOR_BANK = Locations.DRAYNOR_BANK as At;
const AL_KHARID_BANK = Locations.AL_KHARID_BANK as At;
/** Ned, in his house in Draynor (his ropes) */
const NED: At = [3100, 3258, 0];
/** Lumbridge church's altar (Pray-at: the prayer recharged on the way to Al Kharid when it is down) */
const LUMBRIDGE_ALTAR: At = [3243, 3206, 0];
/** Shantay, by his pass (his shop: Trade) */
const SHANTAY: At = [3304, 3122, 0];
/** the Shantay Pass's gate (shantay_pass_henge_doorway, 4x1 at 3302-3305,3116), and a tile each side of it */
const GATE: At = [3303, 3116, 0];
const GATE_NORTH: At = [3303, 3118, 0];
const GATE_SOUTH: At = [3303, 3114, 0];
/** the burrow (kalphite_burrow_entrance, 2x2 at 3227,3108) and the tile beside it (^kalphite_burrow_exit_coord) */
const BURROW: At = [3227, 3108, 0];
const BURROW_STAND: At = [3226, 3108, 0];
/** the tunnels' landing (^kalphite_burrow_entrance_coord) and their rope up (kalphite_burrow_exit) */
const TUNNELS: At = [3483, 9510, 2];
const BURROW_EXIT: At = [3483, 9509, 2];
/** the chamber's entrance in the tunnels (kalphite_chamber_entrance, 2x2 at 3509,9497) and the tile beside it */
const CHAMBER_DOOR: At = [3509, 9497, 2];
const CHAMBER_DOOR_STAND: At = [3508, 9497, 2];
/** the chamber's landing (^kalphite_chamber_entrance_coord) and its rope up (kalphite_chamber_exit) */
const CHAMBER: At = [3508, 9493, 0];
const CHAMBER_EXIT: At = [3508, 9494, 0];
const QUEEN = Locations.KALPHITE_QUEEN as At;

/** in the Kalphite lair's tunnels (level 2) or its chamber (level 0, below them) */
const inLairBox = (p: Player): boolean => p.z >= 9460 && p.z < 9540 && p.x >= 3450 && p.x < 3530;
export const inTunnels = (p: Player): boolean => p.level === 2 && inLairBox(p);
export const inChamber = (p: Player): boolean => p.level === 0 && inLairBox(p);
/** south of the Shantay Pass, in the desert (the gate's south side to the burrow) */
export const southOfPass = (p: Player): boolean => p.level === 0 && p.z <= 3115 && p.z > 3000 && p.x > 3190 && p.x < 3330;
const cheb = (p: Player, at: At): number => Math.max(Math.abs(p.x - at[0]), Math.abs(p.z - at[1]));

// ── the rules ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** a team: 4-6 (the leader and 3-5 recruits) */
export const KQ_TEAM_SIZE: readonly [number, number] = [4, 6];
/** at most one attempt per this much play world-wide (ticks: 4 hours) */
export const KQ_GAP = 24000;
/** the bar: combat, Prayer (Protect from Magic is 37; the research's 43), good food owned, coins owned */
export const KQ_COMBAT = 100;
export const KQ_PRAYER = 43;
export const KQ_FOOD_GATE = 15;
export const KQ_COINS = 150;
/** food carried in (as many as it owns up to this) */
const KQ_FOOD = 20;
/** the leader calls this many times at most, this far apart (ticks: 3 minutes), till 3 more of the bar are free */
export const KQ_CALLS = 3;
export const KQ_CALL_GAP = 300;
/** the meeting waits this long at most (ticks: 6 minutes: its recruits come from anywhere) */
export const KQ_MEET_TICKS = 600;
const MEET_GRACE = 100;
/** a bot leaves the chamber under this share of its Hitpoints with this many pieces of food or fewer */
export const KQ_FLEE_HP = 0.4;
export const KQ_FLEE_FOOD = 2;
/** the chamber at most this long (ticks: 15 minutes; the probe's teams were out of food in 2.5-4.5) */
export const CHAMBER_TICKS = 1500;
let chamberTicks = CHAMBER_TICKS;
/** (tests) the chamber's time (null: CHAMBER_TICKS) */
export function setChamberTicksForTest(ticks: number | null): void {
    chamberTicks = ticks ?? CHAMBER_TICKS;
}
/** eat at this share of the Hitpoints in the fight (a bite every 3 ticks at most, 274's eat delay) */
const EAT_AT = 0.55;
/** after the kill, the team waits this long for her drop (npc_death's delays, then the table's obj_add) */
const KILL_WAIT = 15;
/** the roped entrances last this long (^lootdrop_duration) */
export const ROPE_TICKS = 200;
/** the leader waits this long at most for those behind: at the gate's south side, the burrow, the chamber's entrance */
const WAIT_SOUTH = 150;
const WAIT_BURROW = 60;
const WAIT_DOOR = 200;
/** a member this near the leader on the desert's leg is with it (KQ's EG11-style nearness) */
export const KQ_TRAVEL_NEAR = 5;

// ── the team ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type KqState = 'call' | 'meet' | 'travel' | 'tunnels' | 'chamber' | 'out' | 'done' | 'aborted';
/** how far a team got: the meeting, Shantay's, the desert, the tunnels, the chamber */
export type KqReach = 'meet' | 'shantay' | 'desert' | 'tunnels' | 'chamber';
const REACH_ORDER: readonly KqReach[] = ['meet', 'shantay', 'desert', 'tunnels', 'chamber'];

export interface KqLeave {
    name: string;
    why: 'flee' | 'team' | 'time' | 'kill';
    hp: number;
    food: number;
    tick: number;
}

export interface KqTeam {
    readonly leader: Player;
    readonly members: Player[];
    state: KqState;
    /** its recruits' call (the meeting's clock) */
    formed: number;
    reached: KqReach;
    /** at the meeting, banked: the leader waits for them */
    readonly ready: Set<Player>;
    /** a pass and waterskins bought; through the gate; down the burrow (when); in the chamber (when) */
    readonly shopped: Set<Player>;
    readonly south: Set<Player>;
    readonly downAt: Map<Player, number>;
    readonly chamberAt: Map<Player, number>;
    /** Protect from Magic seen on in the chamber */
    readonly prayed: Set<Player>;
    /** gone from the chamber or the way: fled (its own rule), died */
    readonly fled: Set<Player>;
    readonly died: Set<Player>;
    readonly leaves: KqLeave[];
    burrowRoped: number;
    chamberRoped: number;
    /** the queen as the team saw her: her form, her lowest Hitpoints in each, form 1's fall, the kill */
    form: 0 | 1 | 2;
    form1Low: number;
    form2Low: number;
    phase2: boolean;
    kill: boolean;
    killAt: number;
    flying: Npc | null;
    /** her tile when last seen alive (her drop falls there: kalphite_queen.rs2's obj_add at npc_coord) */
    queenX: number;
    queenZ: number;
    seenAt: number;
    queen: Npc | null;
    fightAt: number;
    leaderTask: BotTask | null;
    ended: boolean;
}

let team: KqTeam | null = null;
/** the team now (the tests, the report) */
export function kqTeam(): KqTeam | null {
    if (team && (team.state === 'done' || team.state === 'aborted' || team.leader.slot === -1)) team = null;
    return team;
}
/** the last attempt's call, world-wide (its tick) */
let lastCall = -Infinity;

/** the attempts (the report's EG13; the tests): calls, formed, their sizes, how far they got, the queen's forms, the ends */
export const kqStats = {
    calls: 0,
    recalls: 0,
    formed: 0,
    nobody: 0,
    aborted: 0,
    members: [] as number[],
    ropes: 0,
    passes: 0,
    gates: 0,
    burrows: 0,
    down: 0,
    chambers: 0,
    inChamber: 0,
    phase2: 0,
    kills: 0,
    deaths: 0,
    fled: 0,
    wipes: 0,
    travelSamples: 0,
    travelNear: 0
};
export const kqLog: { leader: string; members: string[]; size: number; formed: number; end: number; outcome: string; reached: KqReach; phase2: boolean; kill: boolean; form1Low: number; form2Low: number; deaths: number; fled: number }[] = [];

/** (tests) no team, the world-wide gap from empty, the stats and log zeroed */
export function resetKqForTest(): void {
    team = null;
    lastCall = -Infinity;
    kqLog.length = 0;
    for (const k of Object.keys(kqStats) as (keyof typeof kqStats)[]) {
        if (k === 'members') kqStats.members.length = 0;
        else kqStats[k] = 0;
    }
}
/** (tests) the world's last call at `tick` (the 4-hour cap) */
export function noteKqCallForTest(tick: number): void {
    lastCall = tick;
}

// ── who ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** fit for the KQ: combat 100+, Prayer 43+, 15+ pieces of good food and 150 coins owned, a members world (no dice) */
export function kqFit(p: Player): boolean {
    return p.combatLevel >= KQ_COMBAT && getBaseLevel(p, PlayerStat.PRAYER) >= KQ_PRAYER && isMembersWorld() && goodFoodOwned(p) >= KQ_FOOD_GATE && owned(p, obj('coins')) >= KQ_COINS;
}

/** a free bot of the bar for a team: a levelling bosser of the bar, free as the director's free, out of the Wilderness */
function mayJoin(p: Player, leader: Player, bosser: (p: Player) => boolean): boolean {
    if (p === leader || p.is_bot !== true || p.slot === -1 || team?.members.includes(p)) return false;
    if (!isLevelling(p.botPlanner as PlannerKey) || isNewbie(p) || !bosser(p) || !kqFit(p)) return false;
    if (World.currentTick - lastEndgameStart(p.username) < 600 || wildernessLevelAt(p.x, p.z) > 0) return false;
    return isFreeForEvent(p);
}
/** the free bots of the bar now, the leader's clique first (no dice) */
function freeFit(leader: Player, bosser: (p: Player) => boolean): Player[] {
    const pool: Player[] = [];
    for (const p of worldPlayers()) if (mayJoin(p, leader, bosser)) pool.push(p);
    return pool;
}

/**
 * may this bot lead a KQ attempt now (port/BotEndgame's offer, after its roll)? No team now, the world's last call
 * KQ_GAP of play ago, the bar, a leader's session left (the director's LEAD_SESSION_LEFT), and at least 3 more of the
 * bar free online, so a team can form. Draws no dice: an ineligible bosser's picks are as before.
 */
export function mayLeadKq(p: Player, bosser: (p: Player) => boolean): boolean {
    if (kqTeam() !== null || World.currentTick - lastCall < KQ_GAP || !kqFit(p)) return false;
    if (BotManager.sessionLeftOf(p.username) < LEAD_SESSION_LEFT) return false;
    return freeFit(p, bosser).length >= KQ_TEAM_SIZE[0] - 1;
}

/** the recruits: free bots of the bar not on the team yet, the leader's clique first, `max` at most */
function recruit(leader: Player, bosser: (p: Player) => boolean, max: number): Player[] {
    const mates = new Set((cliqueOf(leader.username) ?? []).map(n => n.toLowerCase()));
    const pool = freeFit(leader, bosser);
    pool.sort((a, b) => Number(mates.has(b.username.toLowerCase())) - Number(mates.has(a.username.toLowerCase())) || Math.random() - 0.5);
    return pool.slice(0, Math.max(0, max));
}

function reach(t: KqTeam, r: KqReach): void {
    if (REACH_ORDER.indexOf(r) > REACH_ORDER.indexOf(t.reached)) t.reached = r;
}
/** a team member still on the attempt (not dead, not given up, online) */
const onTeam = (t: KqTeam, m: Player): boolean => m.slot !== -1 && t.members.includes(m) && !t.died.has(m);

// ── the steps of its own ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The Shantay Pass's gate, the game's way (shantay_pass.rs2): from the north (`inbound`), a pass carried, its Go-through
 * clicked, the poster's choice answered "Yeah, that poster doesn't scare me!" and the pages continued; the queue's
 * p_teleport and p_telejump take the bot through, marked as the game's move. From the south a click, free (its script's
 * own jump north). Fails after a few clicks.
 */
function shantayGate(inbound: boolean): Step {
    let tries = 0;
    let wait = 0;
    let walking: Step | null = null;
    const end = (r: 'done' | 'fail'): 'done' | 'fail' => {
        tries = 0;
        wait = 0;
        walking = null;
        return r;
    };
    return {
        label: inbound ? 'through the pass' : 'out through the pass',
        dialog: true,
        tick(p) {
            const across = inbound ? southOfPass(p) : p.level === 0 && p.z >= 3117 && p.z < 3200;
            if (across && !botScript(p)) {
                if (inbound) kqStats.gates++;
                return end('done');
            }
            if (cheb(p, GATE) <= 3) noteMove(p, 'event');
            // (its pages and the poster's choice: the first option throughout)
            if (botAnswerDialogue(p, 1) !== null) {
                wait = humanDelay(p, 'page');
                return 'run';
            }
            if (p.delayed || botScript(p)) return 'run';
            if (wait > 0 && --wait > 0) return 'run';
            if (cheb(p, GATE) > 4) {
                walking ??= walk(inbound ? GATE_NORTH : GATE_SOUTH, 2, 600, 'to the pass');
                return walking.tick(p, null as never) === 'fail' ? end('fail') : 'run';
            }
            walking = null;
            if (inbound && countItem(p, obj('shantay_pass')) === 0) return end('fail');
            const gate = findLocByName(GATE[0], GATE[1], 0, 'shantay_pass_henge_doorway', 4);
            if (!gate || ++tries > 5) return end('fail');
            interactLocOp(p, gate, 1);
            wait = 10 + humanDelay(p, 'next');
            return 'run';
        }
    };
}

/**
 * A rope's climb (op 1 of `name`: the roped burrow, the roped chamber entrance, the two ropes up) until `there(p)`, walked
 * up to it first; the game's p_teleport marked as its move. A roped entrance not there yet is waited for, at most `waitFor`
 * ticks (the leader's rope a moment away); fails after a few clicks. In the lair a rope in sight is clicked from afar, as a
 * player clicks it (the game's own route to it: a walk's search in the tunnels' maze lost a bot in a side passage, seed 1),
 * a walk to it only if that does not get it there.
 */
function climbRope(name: string, at: At, stand: At, there: (p: Player) => boolean, waitFor = 0): Step {
    let tries = 0;
    let wait = 0;
    let missing = 0;
    let far = 0;
    let walking: Step | null = null;
    const end = (r: 'done' | 'fail'): 'done' | 'fail' => {
        tries = 0;
        wait = 0;
        missing = 0;
        far = 0;
        walking = null;
        return r;
    };
    return {
        label: `climb ${name}`,
        tick(p) {
            if (there(p)) return end('done');
            if (p.level === at[2] && cheb(p, at) <= 3) noteMove(p, 'event');
            if (p.delayed || botScript(p)) return 'run';
            if (wait > 0 && --wait > 0) return 'run';
            if (p.level === at[2] && inLairBox(p) && cheb(p, at) > 6 && cheb(p, at) <= 60 && far < 3) {
                const loc = findLocByName(at[0], at[1], at[2], name, 2);
                if (loc) {
                    far++;
                    interactLocOp(p, loc, 1);
                    wait = 12 + cheb(p, at);
                    return 'run';
                }
            }
            if (p.level !== at[2] || cheb(p, at) > 6) {
                walking ??= walk(stand, 1, 900, `to ${name}`);
                return walking.tick(p, null as never) === 'fail' ? end('fail') : 'run';
            }
            walking = null;
            const loc = findLocByName(at[0], at[1], at[2], name, 2);
            if (!loc) return ++missing > waitFor ? end('fail') : 'run';
            if (++tries > 6) return end('fail');
            interactLocOp(p, loc, 1);
            wait = 6 + cheb(p, at);
            return 'run';
        }
    };
}

/** the leader's walk to `at`, waiting up for a member far behind (WAIT_UP a stretch), the members' nearness sampled */
function leadWalk(get: () => KqTeam | null, at: At, near: number, maxTicks: number, label: string): Step {
    const w = walk(at, near, maxTicks, label);
    let n = 0;
    let waited = 0;
    return {
        label,
        tick(p, task) {
            eatWhenLow(p);
            const t = get();
            const behind = t?.members.some(m => m !== p && onTeam(t, m) && t.south.has(m) && southOfPass(m) && cheb(m, [p.x, p.z, p.level]) > 7) ?? false;
            if (behind && waited < 40) {
                waited++;
                if (p.hasWaypoints()) p.clearWaypoints();
                return 'run';
            }
            if (!behind) waited = 0;
            if (t && ++n % 10 === 0) {
                for (const m of t.members) {
                    if (m === p || !onTeam(t, m) || !t.south.has(m)) continue;
                    kqStats.travelSamples++;
                    if (m.level === p.level && cheb(m, [p.x, p.z, p.level]) <= KQ_TRAVEL_NEAR) kqStats.travelNear++;
                }
            }
            return w.tick(p, task);
        }
    };
}

/**
 * a member follows the leader across the desert (the game's Follow; a walk to it when far), until `there`; never across the
 * pass's gate (a walk to a leader on its other side was a jump through it: it waits on its own side)
 */
function followLeader(t: KqTeam, there: (p: Player) => boolean, maxTicks = 1500): Step {
    let stuck = 0;
    let lastPos = -1;
    let ticks = 0;
    return {
        label: 'follow the leader',
        tick(p) {
            eatWhenLow(p);
            if (there(p)) {
                ticks = 0;
                if (p.target === t.leader) p.clearInteraction();
                return 'done';
            }
            const l = t.leader;
            if (l.slot === -1 || t.state === 'aborted' || t.state === 'done' || ++ticks > maxTicks) return 'fail';
            if (southOfPass(l) !== southOfPass(p) || l.level !== p.level) {
                if (p.target === l) p.clearInteraction();
                if (p.hasWaypoints()) p.clearWaypoints();
                return 'run';
            }
            const d = cheb(l, [p.x, p.z, p.level]);
            if (l.run === 1 && p.runenergy >= 300) p.run = 1;
            else if (l.run === 0) p.run = 0;
            const pos = (p.x << 14) | p.z;
            stuck = pos === lastPos && d > 3 ? stuck + 1 : 0;
            lastPos = pos;
            if (d > 12 || stuck > 4) {
                if (p.target === l) p.clearInteraction();
                walkTo(p, l.x, l.z, l.level);
                return 'run';
            }
            if (p.target !== l) interactPlayerOp(p, l.slot, 3);
            return 'run';
        }
    };
}

/** a wait of its own until `ready(p)` or `max` ticks (then on all the same) */
function waitFor(label: string, ready: (p: Player) => boolean, max: number): Step {
    let ticks = 0;
    return {
        label,
        tick(p) {
            if (ready(p) || ++ticks > max) {
                ticks = 0;
                return 'done';
            }
            return 'run';
        }
    };
}

/**
 * The way in, step by step: a step that fails, or the attempt off for this bot (`live`), and the rest of the way in is
 * passed over (`gave`): the way home still runs from wherever the bot is (never a jump through the pass).
 */
function wayIn(gave: { up: boolean; at: string }, live: (p: Player) => boolean, ...steps: Step[]): Step[] {
    return steps.map(step => ({
        get label() {
            return step.label;
        },
        dialog: step.dialog,
        tick(p, task) {
            if (gave.up) return 'done';
            if (!live(p)) {
                gave.up = true;
                gave.at = `off:${step.label}`;
                if (p.hasWaypoints()) p.clearWaypoints();
                return 'done';
            }
            const r = step.tick(p, task);
            if (r === 'fail') {
                gave.up = true;
                gave.at = step.label;
                return 'done';
            }
            return r;
        }
    }));
}

// ── the queen ───────────────────────────────────────────────────────────────────────────────────────────────────────

let queenIds: [number, number] | null = null;
function queenTypes(): [number, number] {
    return (queenIds ??= [NpcType.getId('kalphite_queen'), NpcType.getId('kalphite_flyingqueen')]);
}
/** the queen in her chamber (either form, alive), as the team sees her this tick: her form 1's fall, the kill */
function watchQueen(t: KqTeam, p: Player): Npc | null {
    if (t.seenAt === World.currentTick) return t.queen;
    t.seenAt = World.currentTick;
    const [q1, q2] = queenTypes();
    const q = findNpcFiltered(QUEEN[0], QUEEN[1], 0, n => (n.type === q1 || n.type === q2) && n.isActive && n.levels[3] > 0, 30);
    t.queen = q;
    if (t.flying && !t.kill && (!t.flying.isActive || t.flying.levels[3] <= 0)) {
        // (her second form's death: kalphite_queen.rs2's [ai_queue3,kalphite_flyingqueen], the drop table's roll)
        t.kill = true;
        t.killAt = World.currentTick;
        kqStats.kills++;
        emitEndgameEvent(p, 'bossKill', { spot: 'kq' });
        call(p, 'kq-kill');
    }
    if (!q) return null;
    t.queenX = q.x;
    t.queenZ = q.z;
    const hp = q.levels[3];
    if (q.type === q2) {
        if (t.form === 1 && !t.phase2) {
            t.phase2 = true;
            // (the KQ fixes, KQ-2: form 1 fell, all of its 255 dealt: she is seen only alive, so its low stayed at her last
            // look in it, above 0, and EG13's "form 1 dealt" came short of 255)
            t.form1Low = 0;
            kqStats.phase2++;
            call(p, 'kq-phase2');
        }
        t.form = 2;
        t.flying = q;
        t.form2Low = Math.min(t.form2Low, hp);
    } else {
        t.form = 1;
        t.form1Low = Math.min(t.form1Low, hp);
    }
    return q;
}

/** half of those in the chamber gone (fled or dead): the team runs ("nvm run") */
function teamCheck(t: KqTeam, p: Player | null): void {
    if (t.state !== 'chamber') return;
    const went = [...t.chamberAt.keys()];
    const gone = went.filter(m => t.fled.has(m) || t.died.has(m) || m.slot === -1).length;
    if (went.length > 0 && gone * 2 >= went.length) {
        t.state = 'out';
        const caller = [t.leader, ...t.members].find(m => m.slot !== -1 && !t.fled.has(m) && !t.died.has(m) && inChamber(m)) ?? p;
        if (caller) call(caller, 'kq-run', 0.9);
    }
}

/**
 * The fight with the queen, a bot's own (its Attack, op 2, on her whichever form; Protect from Magic pressed; a bite of
 * food under EAT_AT, at most every 3 ticks): until its leave rule (under KQ_FLEE_HP with KQ_FLEE_FOOD or fewer pieces of
 * food), the team's run, the chamber's time, its death, or the kill (its own drop of the game's table picked up first)
 */
function queenFight(get: () => KqTeam | null, died: (p: Player) => boolean): Step[] {
    const watcher = fightWatcher(null, 'kq');
    let bite = -99;
    let wait = 0;
    let looted = 0;
    let left = false;
    const leave = (t: KqTeam, p: Player, why: KqLeave['why']): 'done' => {
        if (!left) {
            left = true;
            t.leaves.push({ name: p.username, why, hp: p.levels[PlayerStat.HITPOINTS] / Math.max(1, p.baseLevels[PlayerStat.HITPOINTS]), food: goodFoodCarried(p), tick: World.currentTick });
        }
        return 'done';
    };
    return [
        {
            label: 'the queen',
            tick(p) {
                const t = get();
                if (!t || !inChamber(p) || died(p)) return 'done';
                watcher.watch(p);
                if (!t.prayed.has(p) && prayer12() !== -1 && p.getVar(prayer12()) === 1) t.prayed.add(p);
                const queen = watchQueen(t, p);
                // (her lightning reaches the whole chamber's west end: the protection on at once, before she is near)
                protectPrayer(p, 'magic', true);
                if (t.kill) {
                    // (its own drop, if it was the hero: kalphite_queen.rs2's obj_add at her tile, its receiver the hero; the
                    // drop comes a few ticks after her last Hitpoint, npc_death's delays first: waited for)
                    const mine = ownDrop(p, t);
                    if (mine && looted < 60 && !isInventoryFull(p)) {
                        looted++;
                        if (!p.delayed && p.target !== mine) interactObjOp(p, mine, 3);
                        return 'run';
                    }
                    return World.currentTick - t.killAt < KILL_WAIT ? 'run' : leave(t, p, 'kill');
                }
                const hp = p.levels[PlayerStat.HITPOINTS] / Math.max(1, p.baseLevels[PlayerStat.HITPOINTS]);
                const food = goodFoodCarried(p);
                if (hp < KQ_FLEE_HP && food <= KQ_FLEE_FOOD) {
                    if (!t.fled.has(p)) {
                        t.fled.add(p);
                        kqStats.fled++;
                        call(p, 'kq-flee', 0.6);
                        teamCheck(t, p);
                    }
                    return leave(t, p, 'flee');
                }
                if (t.state === 'out' || t.state === 'done' || t.state === 'aborted') return leave(t, p, 'team');
                if (t.fightAt >= 0 && World.currentTick - t.fightAt >= chamberTicks) {
                    t.state = 'out';
                    return leave(t, p, 'time');
                }
                if (hp < EAT_AT && !p.delayed && World.currentTick - bite >= 3 && eatBestFood(p)) {
                    bite = World.currentTick;
                    wait = 2;
                    return 'run';
                }
                if (wait > 0 && --wait > 0) return 'run';
                if (!queen || p.delayed) return 'run';
                const target = p.target as unknown as { nid?: number } | null;
                if (target && target.nid === queen.nid) return 'run';
                interactNpcOp(p, queen, 2);
                wait = 3 + humanDelay(p, 'retarget');
                return 'run';
            }
        },
        act('fight over', p => {
            watcher.end(p);
            return 'done';
        })
    ];
}
/** Protect from Magic's varp (prayer12, as port/BotEndgameFight presses it) */
let prayer12Id = -2;
function prayer12(): number {
    if (prayer12Id === -2) prayer12Id = VarPlayerType.getByName('prayer12')?.id ?? -1;
    return prayer12Id;
}

/** the bot's own drop in the chamber now (the game's: its receiver the bot), by where the queen fell, the nearest */
function ownDrop(p: Player, t: KqTeam): Obj | null {
    let best: Obj | null = null;
    let bestD = Infinity;
    for (let zx = (t.queenX - 10) & ~7; zx <= t.queenX + 14; zx += 8) {
        for (let zz = (t.queenZ - 10) & ~7; zz <= t.queenZ + 14; zz += 8) {
            const zone = World.gameMap.getZone(zx, zz, 0);
            if (!zone) continue;
            for (const o of zone.getAllObjsSafe()) {
                if (o.receiver64 !== p.hash64) continue;
                const d = Math.max(Math.abs(o.x - p.x), Math.abs(o.z - p.z));
                if (d < bestD) {
                    bestD = d;
                    best = o;
                }
            }
        }
    }
    return best;
}

// ── the plans ───────────────────────────────────────────────────────────────────────────────────────────────────────

const taskOf = new WeakMap<ErrandPlan, BosserErrand>();

/** the bot's death on the attempt: its task's flag, the event, the team's count (and the team's run if half are gone) */
function deathOf(plan: ErrandPlan, get: () => KqTeam | null, leader?: (t: KqTeam) => void): (p: Player) => boolean {
    const death = deathCheck();
    return q => {
        const d = death.died(q);
        const task = taskOf.get(plan);
        if (d && task && !task.died) {
            task.died = true;
            emitEndgameEvent(q, 'bossDeath', { spot: 'kq' });
            const t = get();
            if (t && !t.died.has(q)) {
                t.died.add(q);
                kqStats.deaths++;
                teamCheck(t, null);
                leader?.(t);
            }
        }
        return d;
    };
}

/** the bank stop before: food (KQ_FOOD of the best), coins (and the leader's ropes, if it has them banked) */
function prepSteps(near: At, ropes: boolean): Step[] {
    const rope = obj('rope');
    return [
        bank({ near, keep: () => [...foodIds(), ...(ropes ? [rope] : [])], withdraw: q => [...foodWithdraw(KQ_FOOD)(q), ...(ropes ? [[rope, 2] as [number, number]] : [])], coins: KQ_COINS }),
        act('food', q => (goodFoodCarried(q) >= 12 && countItem(q, obj('coins')) >= 70 ? 'done' : 'fail'))
    ];
}

/** Pray-at Lumbridge church's altar on the way, when its prayer is down (the points it fights on: port/BotEndgame's altar) */
function altarStep(): Step {
    return when(q => q.levels[PlayerStat.PRAYER] < q.baseLevels[PlayerStat.PRAYER], soft(clickLoc(['altar'], 'Pray-at', LUMBRIDGE_ALTAR, { radius: 4, max: 2, wait: 6 })));
}

/** the way in from the meeting to the chamber, the leader's or a member's (`lead`) */
function wayInSteps(t: KqTeam, lead: boolean): Step[] {
    const rope = obj('rope');
    const pass = obj('shantay_pass');
    const skin = obj('water_skin4');
    const steps: Step[] = [
        // Shantay's shop: 2 waterskins and a pass each
        shop('shantay', SHANTAY, { buy: [[skin, 2], [pass, 1]] }),
        act('bought', q => {
            if (countItem(q, pass) < 1 || countItem(q, skin) < 1) return 'fail';
            t.shopped.add(q);
            kqStats.passes++;
            reach(t, 'shantay');
            return 'done';
        }),
        shantayGate(true),
        act('south', q => {
            t.south.add(q);
            reach(t, 'desert');
            return 'done';
        })
    ];
    if (lead) {
        steps.push(
            // (those still coming through the gate: waited for a while)
            waitFor('wait at the pass', () => t.members.every(m => !onTeam(t, m) || t.south.has(m) || !t.ready.has(m)), WAIT_SOUTH),
            leadWalk(() => t, BURROW_STAND, 2, 1500, 'to the burrow'),
            waitFor('wait at the burrow', q => t.members.every(m => m === q || !onTeam(t, m) || !t.south.has(m) || (m.level === 0 && cheb(m, BURROW) <= 6)), WAIT_BURROW),
            useOnLoc(rope, ['kalphite_burrow_entrance'], BURROW, { radius: 2, max: 3 }),
            act('roped', q => {
                if (!findLocByName(BURROW[0], BURROW[1], 0, 'kalphite_burrow_entrance_withrope', 2)) return 'fail';
                t.burrowRoped = World.currentTick;
                t.state = 'tunnels';
                kqStats.burrows++;
                call(q, 'kq-rope-on', 0.7);
                return 'done';
            })
        );
    } else {
        // (the leader still north of the pass, shopping: waited for on this side)
        steps.push(waitFor('wait for the leader', () => t.south.has(t.leader) || t.leader.slot === -1, WAIT_SOUTH + 300), followLeader(t, q => t.burrowRoped >= 0 || (q.level === 0 && cheb(q, BURROW) <= 4)));
    }
    steps.push(
        climbRope('kalphite_burrow_entrance_withrope', BURROW, BURROW_STAND, inTunnels, lead ? 0 : 300),
        act('down', q => {
            t.downAt.set(q, World.currentTick);
            kqStats.down++;
            reach(t, 'tunnels');
            return 'done';
        }),
        eating(walk(CHAMBER_DOOR_STAND, 2, 1500, 'through the tunnels'))
    );
    if (lead) {
        steps.push(
            waitFor('wait at the chamber', q => t.members.every(m => m === q || !onTeam(t, m) || !t.downAt.has(m) || (inTunnels(m) && cheb(m, CHAMBER_DOOR) <= 6)), WAIT_DOOR),
            useOnLoc(rope, ['kalphite_chamber_entrance'], CHAMBER_DOOR, { radius: 2, max: 3 }),
            act('roped', q => {
                if (!findLocByName(CHAMBER_DOOR[0], CHAMBER_DOOR[1], 2, 'kalphite_chamber_entrance_withrope', 2)) return 'fail';
                t.chamberRoped = World.currentTick;
                kqStats.chambers++;
                call(q, 'kq-in', 0.8);
                return 'done';
            })
        );
    }
    steps.push(
        climbRope('kalphite_chamber_entrance_withrope', CHAMBER_DOOR, CHAMBER_DOOR_STAND, inChamber, lead ? 0 : 400),
        act('in', q => {
            t.chamberAt.set(q, World.currentTick);
            kqStats.inChamber++;
            if (t.state === 'tunnels' || t.state === 'travel') t.state = 'chamber';
            if (t.fightAt < 0) t.fightAt = World.currentTick;
            reach(t, 'chamber');
            return 'done';
        })
    );
    return steps;
}

/** the way home from wherever the bot is: the chamber's rope up, the burrow's, the pass from the south, Al Kharid bank */
function homeSteps(died: (p: Player) => boolean): Step[] {
    return whileAlive(
        died,
        // (Protect from Magic kept on up the chamber's rope: her lightning reaches 10 tiles)
        when(inChamber, eating(climbRope('kalphite_chamber_exit', CHAMBER_EXIT, CHAMBER, inTunnels))),
        act('prayers off', q => (protectionsOff(q) ? 'run' : 'done')),
        when(inTunnels, eating(climbRope('kalphite_burrow_exit', BURROW_EXIT, TUNNELS, q => q.z < 6400))),
        when(southOfPass, soft(eating(walk(GATE_SOUTH, 2, 900, 'to the pass'))), shantayGate(false)),
        soft(eating(walk(AL_KHARID_BANK, 4, 3000, 'home'))),
        bank({ near: AL_KHARID_BANK })
    );
}

/** the end's word (the leader always, a member now and then): the kill, a wipe, or "kq is impossible" */
function endLine(t: KqTeam | null, p: Player, chance: number): void {
    if (!t || t.reached !== 'chamber' || t.kill) return;
    const went = t.chamberAt.size;
    call(p, went > 0 && t.died.size * 2 >= went ? 'kq-wipe' : 'kq-impossible', chance);
}

/** the leader's errand, and its end's hook: the team ended with it, however it ended */
function leaderPlan(bosser: (p: Player) => boolean): { plan: ErrandPlan; over: (outcome: string) => void } {
    let t: KqTeam | null = null;
    const over = (outcome: string): void => {
        if (!t || t.ended) return;
        if (t.state !== 'chamber' && t.state !== 'out') t.state = 'aborted';
        finish(t, outcome);
    };
    const plan: ErrandPlan = {
        kind: 'KqTeam',
        key: 'kq',
        at: AL_KHARID_BANK,
        members: true,
        ok: p => kqFit(p),
        build(p) {
            // (the leader dead on the way, the attempt is off; dead in the chamber, the team runs: "nvm run")
            const died = deathOf(plan, () => t, tt => {
                if (tt.ended) return;
                if (tt.state === 'chamber') {
                    tt.state = 'out';
                    const caller = tt.members.find(m => m !== tt.leader && m.slot !== -1 && !tt.died.has(m) && inChamber(m));
                    if (caller) call(caller, 'kq-run', 0.9);
                } else if (tt.state !== 'out') over('leader died');
            });
            const gave = { up: false, at: '' };
            const rope = obj('rope');
            let calls = 0;
            let nextCall = -1;
            let want = 0;
            return [
                ...whileAlive(
                    died,
                    // (its bank stop by Ned's, Draynor's; a leader with 2 ropes banked takes them at Al Kharid's, the meeting's)
                    ...prepSteps(owned(p, rope) >= 2 ? AL_KHARID_BANK : DRAYNOR_BANK, true),
                    // (Ned's ropes, one a talk, 15 coins each: his dialogue's "Yes, I would like some rope." then "Okay, please sell me some rope.")
                    when(q => countItem(q, rope) < 2, talk('ned', NED, { answers: [1, 1] })),
                    when(q => countItem(q, rope) < 2, talk('ned', NED, { answers: [1, 1] })),
                    act('ropes', q => (countItem(q, rope) >= 2 ? ((kqStats.ropes += 2), 'done') : 'fail')),
                    altarStep(),
                    walk(AL_KHARID_BANK, 3, 3000, 'to the meeting'),
                    act('call', (q, task) => {
                        if (!t) {
                            // (another's team, or another's attempt since this one's offer: the world's gap is at the call too)
                            if (kqTeam() !== null || World.currentTick - lastCall < KQ_GAP) return 'fail';
                            kqStats.calls++;
                            t = { leader: q, members: [q], state: 'call', formed: World.currentTick, reached: 'meet', ready: new Set([q]), shopped: new Set(), south: new Set(), downAt: new Map(), chamberAt: new Map(), prayed: new Set(), fled: new Set(), died: new Set(), leaves: [], burrowRoped: -1, chamberRoped: -1, form: 0, form1Low: 255, form2Low: 255, phase2: false, kill: false, killAt: -1, flying: null, queenX: QUEEN[0], queenZ: QUEEN[1], seenAt: -1, queen: null, fightAt: -1, leaderTask: task, ended: false };
                            team = t;
                        }
                        // (the call again a while later, as a player at the bank calls till a team comes, KQ_CALLS at most: each
                        // time the newly free answer and set off, "need 2 more", till 3 have)
                        if (World.currentTick < nextCall) return 'run';
                        if (++calls > 1) kqStats.recalls++;
                        if (calls === 1) want = KQ_TEAM_SIZE[0] - 1 + Math.floor(Math.random() * (KQ_TEAM_SIZE[1] - KQ_TEAM_SIZE[0] + 1));
                        call(q, 'kq-call');
                        for (const r of recruit(q, bosser, want - (t.members.length - 1))) {
                            summon(r, memberTask(t));
                            t.members.push(r);
                        }
                        if (t.members.length < KQ_TEAM_SIZE[0] && calls < KQ_CALLS) {
                            nextCall = World.currentTick + KQ_CALL_GAP;
                            return 'run';
                        }
                        if (t.members.length < KQ_TEAM_SIZE[0]) {
                            // (fewer than 3 free each time: no attempt, nothing counted against the world's gap, those on their
                            // way sent home by the team's end; the leader picks again)
                            kqStats.nobody++;
                            call(q, 'kq-nvm');
                            t.state = 'aborted';
                            finish(t, 'nobody');
                            clearEndgameStart(q.username);
                            return 'fail';
                        }
                        lastCall = World.currentTick;
                        t.formed = World.currentTick;
                        t.state = 'meet';
                        call(q, 'kq-meet', 0.6);
                        return 'done';
                    }),
                    act('meet', q => {
                        if (!t) return 'fail';
                        const here = t.members.filter(m => t!.ready.has(m) && m.slot !== -1 && m.level === q.level && cheb(m, [q.x, q.z, q.level]) <= 8);
                        const waited = World.currentTick - t.formed;
                        if (here.length < t.members.length && waited < KQ_MEET_TICKS) return 'run';
                        for (const m of [...t.members]) if (!here.includes(m)) t.members.splice(t.members.indexOf(m), 1);
                        if (t.members.length < KQ_TEAM_SIZE[0]) {
                            call(q, 'kq-nvm');
                            t.state = 'aborted';
                            finish(t, 'meeting');
                            return 'fail';
                        }
                        kqStats.formed++;
                        kqStats.members.push(t.members.length);
                        t.state = 'travel';
                        call(q, 'kq-go', 0.8);
                        return 'done';
                    }),
                    // (the way in: a step that fails ends the team's attempt here, and every one of it walks home)
                    ...wayIn(gave, () => t !== null && t.state !== 'aborted' && t.state !== 'done', ...wayInStepsFor(() => t, true))
                ),
                act('gave up', () => {
                    if (gave.up && t && t.state !== 'chamber' && t.state !== 'out') {
                        t.state = 'aborted';
                        finish(t, `gave up:${gave.at}`);
                    }
                    return 'done';
                }),
                ...whileAlive(died, ...queenFightFor(() => t, died)),
                act('team out', () => {
                    if (t && t.state === 'chamber') t.state = 'out';
                    return 'done';
                }),
                ...homeSteps(died),
                act('done', q => {
                    if (t) {
                        const dead = died(q);
                        if (!dead) endLine(t, q, 1);
                        finish(t, t.kill ? 'kill' : dead ? 'leader died' : 'done');
                    }
                    return 'done';
                })
            ];
        }
    };
    return { plan, over };
}

/** (the way in's steps built at their turn, for the team of then) */
function wayInStepsFor(get: () => KqTeam | null, lead: boolean): Step[] {
    let steps: Step[] | null = null;
    let i = 0;
    return [
        {
            // (its step now: a give-up's log names it)
            get label() {
                return steps?.[i]?.label ?? 'the way in';
            },
            dialog: true,
            tick(p, task) {
                const t = get();
                if (!t) return 'fail';
                steps ??= wayInSteps(t, lead);
                if (i >= steps.length) return 'done';
                const r = steps[i].tick(p, task);
                if (r === 'run') return 'run';
                if (r === 'fail') return 'fail';
                i++;
                return i >= steps.length ? 'done' : 'run';
            }
        }
    ];
}

/** (the fight's steps for the team of then; nothing for a bot not in the chamber) */
function queenFightFor(get: () => KqTeam | null, died: (p: Player) => boolean): Step[] {
    let steps: Step[] | null = null;
    let i = 0;
    return [
        {
            label: 'the chamber',
            tick(p, task) {
                if (!get() || (i === 0 && !inChamber(p))) return 'done';
                steps ??= queenFight(get, died);
                if (i >= steps.length) return 'done';
                const r = steps[i].tick(p, task);
                if (r === 'run') return 'run';
                i++;
                return i >= steps.length || r === 'fail' ? 'done' : 'run';
            }
        }
    ];
}

/** a member's errand */
function memberPlan(t: KqTeam): ErrandPlan {
    const plan: ErrandPlan = {
        kind: 'KqTeam',
        key: 'kq-member',
        at: AL_KHARID_BANK,
        members: true,
        build() {
            const died = deathOf(plan, () => t);
            const gave = { up: false, at: '' };
            const live = (p: Player): boolean => t.state !== 'aborted' && t.state !== 'done' && t.members.includes(p) && t.leader.slot !== -1;
            return [
                ...whileAlive(
                    died,
                    act('omw', q => {
                        call(q, 'kq-omw', 0.6);
                        return 'done';
                    }),
                    altarStep(),
                    ...prepSteps(AL_KHARID_BANK, false),
                    act('still on', q => (live(q) ? 'done' : 'fail')),
                    walk(AL_KHARID_BANK, 3, KQ_MEET_TICKS + 200, 'to the meeting'),
                    act('here', q => {
                        t.ready.add(q);
                        call(q, 'kq-here', 0.5);
                        // ("who has rope": the leader's answer a moment later, "i got 2 ropes")
                        if (call(q, 'kq-who-rope', 0.3) && t.leader.slot !== -1) call(t.leader, 'kq-rope', 1);
                        return 'done';
                    }),
                    act('wait', q => (!live(q) || World.currentTick - t.formed > KQ_MEET_TICKS + MEET_GRACE ? 'fail' : t.state === 'meet' || t.state === 'call' ? 'run' : 'done')),
                    ...wayIn(gave, live, ...wayInStepsFor(() => t, false))
                ),
                ...whileAlive(died, ...queenFightFor(() => t, died)),
                ...homeSteps(died),
                act('done', q => {
                    if (!died(q)) endLine(t, q, 0.3);
                    return 'done';
                })
            ];
        }
    };
    return plan;
}

function memberTask(t: KqTeam): BosserErrand {
    const plan = memberPlan(t);
    const task = new BosserErrand(plan, 'kq');
    taskOf.set(plan, task);
    return task;
}

/** the leader's KQ errand (port/BotEndgame's offer; the tests'): `bosser` its trait's test for the recruits */
export function kqLeaderTask(bosser: (p: Player) => boolean): BosserErrand {
    const { plan, over } = leaderPlan(bosser);
    const task = new BosserErrand(plan, 'kq');
    task.onOver = over;
    taskOf.set(plan, task);
    return task;
}

function finish(t: KqTeam, outcome: string): void {
    if (t.ended) return;
    t.ended = true;
    if (t.state !== 'aborted') t.state = 'done';
    else kqStats.aborted++;
    const went = t.chamberAt.size;
    if (went > 0 && t.died.size * 2 >= went) {
        kqStats.wipes++;
        emitEndgameEvent(t.leader, 'teamWipe', { kind: 'kq' });
    }
    kqLog.push({ leader: t.leader.username, members: t.members.map(m => m.username), size: t.members.length, formed: t.formed, end: World.currentTick, outcome, reached: t.reached, phase2: t.phase2, kill: t.kill, form1Low: t.form1Low, form2Low: t.form2Low, deaths: t.died.size, fled: t.fled.size });
    if (kqLog.length > 200) kqLog.splice(0, kqLog.length - 200);
    if (team === t) team = null;
}
