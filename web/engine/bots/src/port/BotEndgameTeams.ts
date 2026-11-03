/**
 * port (bots ideas, round 1, Track A: the period endgame) King Black Dragon teams: 2004's "kbd
 * team?" at Edgeville bank, outside the director (port/BotDirector's hourly mix untouched):
 *   - the leader: an eligible bosser (combat 100+, Prayer 43+, 15+ pieces of good food, a members world) whose pick fell
 *     on the KBD (port/BotEndgame's offer, by its taste for dragons), at most one team at a time world-wide, a bot at most
 *     once per KBD_GAP of play;
 *   - the call at Edgeville bank ('setpiece' lines, out of H7, against each speaker's budget: "kbd team? need 2"); its
 *     recruits: free bots of the same bar online anywhere (a friend's PM, not shown), its clique's first, then any the
 *     director would call free (BotDirector.isFreeForEvent); each gets the member's errand at once (its task replaced,
 *     as BotPlayer switches); none: "nvm no1 wants kbd lol", and the leader picks again (a solo spot);
 *   - the meeting: at most MEET_TICKS; the travel north to the west Lava Maze ladder (Wilderness 42) with the members
 *     following the leader (the game's Follow, a walk to it when far), eating on the way; one climb each, the lever each;
 *   - the lair (multi-combat): each a CombatTask held on the KBD with Protect from Melee (the prayer tab), the anti-dragon
 *     shield worn; a member leaves when its food is down to 2 with its Hitpoints under half or its prayer out; the team
 *     when two are out of food or after TEAM_TICKS; out by the lever and the ladder, home to Edgeville bank.
 * Every member carries the role 'bosser' (port/BotEndgameCore): its logout held, the director off it, Track B's lever
 * campers may pick it. A death ends that member's trip (it never walks back). The drops are the game's (its table: a
 * dragon med helm about 1 kill in 120).
 */
import type Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import World from '#/engine/World.js';
import { Locations } from '#/engine/bot/BotKnowledge.js';
import { findLocByName, getBaseLevel, interactLocOp, interactPlayerOp, noteMove, botScript, walkTo } from '#/engine/bot/BotAction.js';
import { eatBestFood } from '#/engine/bot/tasks/BotTaskBase.js';
import { CombatTask } from '#/engine/bot/tasks/CombatTask.js';
import { act, bank, climb, fight, obj, soft, walk, when, type At, type ErrandPlan, type Step } from '#/engine/bot/tasks/ErrandTask.js';
import { BosserErrand, clearEndgameStart, emitEndgameEvent, lastEndgameStart, onEndgameEvent } from '#/engine/bot/port/BotEndgameCore.js';
import { deathCheck, fightOver, fightWatcher, foodIds, foodWithdraw, goodFoodCarried, goodFoodOwned, protectionsOff, sayEndgame, whileAlive } from '#/engine/bot/port/BotEndgameFight.js';
import { bankDragonShield, twoHanderBest } from '#/engine/bot/port/BotWildTrips.js';
import { isFreeForEvent, LEAD_SESSION_LEFT } from '#/engine/bot/port/BotDirector.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import type { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';
import { cliqueOf } from '#/engine/bot/port/BotCliques.js';
import { worldPlayers } from '#/engine/bot/port/BotPlayers.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import type { SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import { Items } from '#/engine/bot/BotKnowledge.js';

const EDGE_BANK = Locations.EDGEVILLE_BANK as At;
/** the meeting tile, outside Edgeville bank's north door */
const MEET: At = [3094, 3498, 0];
const LADDER = Locations.KBD_LADDER as At;
const LEVER_IN: At = [3067, 10253, 0];
const LEVER_OUT: At = [2717, 9801, 0];
const LEVER_ROOM_LADDER: At = [3069, 10256, 0];
/** outside the members' gate west of the ladder (membergatel 3008,3849): the way home starts through it */
const GATE_OUT: At = [3005, 3849, 0];

/** a team: 2-4 (the leader and 1-3 recruits) */
export const TEAM_SIZE: readonly [number, number] = [2, 4];
/** the meeting waits this long at most (ticks: 5 minutes) */
export const MEET_TICKS = 500;
/** the lair at most this long (ticks: 30 minutes) */
export const TEAM_TICKS = 3000;
let teamTicks = TEAM_TICKS;
/** (tests) the lair's time (null: TEAM_TICKS) */
export function setTeamTicksForTest(ticks: number | null): void {
    teamTicks = ticks ?? TEAM_TICKS;
}
/** a bot on a KBD team at most once per this much play (ticks: 2 hours) */
export const KBD_GAP = 12000;
/** two members out of food: the team leaves */
const FOOD_OUT_LEAVE = 2;
/**
 * a member this near the leader on the way is with it (EG11): the game's Follow trails a running leader by 4-5 tiles (it
 * walks to where the leader was), a walking one by 1-2
 */
export const TRAVEL_NEAR = 5;
/** the leader waits up for a member farther behind than this (tiles), at most WAIT_UP ticks a stretch */
const WAIT_GAP = 7;
const WAIT_UP = 40;
/** food carried to the KBD */
const KBD_FOOD = 18;
/**
 * (round 1 fixes, A2) a member follows the leader north this long at most (ticks: the leader's walk to the ladder, 4000,
 * and its waits for those behind); and waits at the meeting at most MEET_TICKS and this
 */
const FOLLOW_TICKS = 4500;
const MEET_GRACE = 100;

export type TeamState = 'call' | 'meet' | 'travel' | 'lair' | 'out' | 'done' | 'aborted';
export interface KbdTeam {
    readonly leader: Player;
    readonly members: Player[];
    state: TeamState;
    readonly formed: number;
    travelAt: number;
    lairAt: number;
    readonly foodOut: Set<Player>;
    /** the members at the meeting, ready (banked, shield on): the leader waits for them */
    readonly ready: Set<Player>;
    kills: number;
    /** (round 1 fixes, A2) the leader's errand (a member follows only a leader still on it), and the team's end logged */
    leaderTask: BotTask | null;
    ended: boolean;
}

let team: KbdTeam | null = null;
/** the team now (the tests, the report) */
export function kbdTeam(): KbdTeam | null {
    if (team && (team.state === 'done' || team.state === 'aborted' || team.leader.slot === -1)) team = null;
    return team;
}

/** the teams (the report's EG11; the tests): calls, formed, aborted, members, the KBD kills */
export const teamStats = { calls: 0, formed: 0, aborted: 0, nobody: 0, members: [] as number[], kills: 0, travelSamples: 0, travelNear: 0 };
export const teamLog: { leader: string; members: string[]; formed: number; end: number; outcome: string; kills: number }[] = [];
const lastKbd = new Map<string, number>();

/** (tests) no team, the gaps from empty */
export function resetTeamsForTest(): void {
    team = null;
    lastKbd.clear();
    teamLog.length = 0;
    teamStats.calls = teamStats.formed = teamStats.aborted = teamStats.nobody = teamStats.kills = teamStats.travelSamples = teamStats.travelNear = 0;
    teamStats.members.length = 0;
}

/**
 * fit for the KBD: combat 100+, Prayer 43+, 15+ pieces of good food owned; (round 1 fixes, A5) not a bot whose best weapon
 * is a two-hander (no shield beside it: its fight's first walk went to a bank for it, and the anti-dragon shield came off)
 */
export function kbdFit(p: Player): boolean {
    return p.combatLevel >= 100 && getBaseLevel(p, PlayerStat.PRAYER) >= 43 && goodFoodOwned(p) >= 15 && isMembersWorld() && !twoHanderBest(p);
}
/** may lead or join a KBD team now (the bar, its gap) */
function kbdGapOk(p: Player): boolean {
    return World.currentTick - (lastKbd.get(p.username.toLowerCase()) ?? -Infinity) >= KBD_GAP;
}
/**
 * the leader's offer may be the KBD (port/BotEndgame): no team now, the bar, its gap; (round 1 fixes, A2) and a session
 * long enough for the trip (a leader's, the director's LEAD_SESSION_LEFT: its recruits must have theirs)
 */
export function mayLeadKbd(p: Player): boolean {
    return kbdTeam() === null && kbdFit(p) && kbdGapOk(p) && BotManager.sessionLeftOf(p.username) >= LEAD_SESSION_LEFT;
}

/** a free bot of the bar for the team (a levelling bosser of the bar, free as the director's free) */
function mayJoin(p: Player, bosser: (p: Player) => boolean): boolean {
    if (p.is_bot !== true || p.slot === -1 || team?.members.includes(p)) return false;
    if (!isLevelling(p.botPlanner as PlannerKey) || isNewbie(p) || !bosser(p) || !kbdFit(p) || !kbdGapOk(p)) return false;
    if (World.currentTick - lastEndgameStart(p.username) < 600) return false;
    return isFreeForEvent(p);
}

/** the KBD's fight step */
let kbdStepMemo: SkillStep | null = null;
function kbdStep(): SkillStep {
    return (kbdStepMemo ??= { minLevel: 1, maxLevel: 99, action: 'combat', location: [Locations.KBD[0], Locations.KBD[1], 0], toolItemIds: [Items.ADAMANT_SCIMITAR ?? Items.MITHRIL_SCIMITAR], xpPerAction: 400, ticksPerAction: 4, successRate: 1, itemGained: Items.BONES, extra: { npcTypes: ['king_dragon'], hitsToKill: 40, dungeon: true } });
}

/** a team call ('setpiece': out of H7, against the speaker's budget), said whether anyone is near (a meeting's word); (the KQ
 * track: port/BotKqTeams' calls too) */
export function call(p: Player, kind: string, chance = 1): boolean {
    return sayEndgame(p, kind, chance, 'setpiece', false);
}

/** eat when hurt on the way (the travel's: a camper at the ladder; the KQ track: the desert, the Kalphite tunnels) */
export function eatWhenLow(p: Player): void {
    if (p.levels[PlayerStat.HITPOINTS] * 2 < p.baseLevels[PlayerStat.HITPOINTS] && !p.delayed) eatBestFood(p);
}

/** the step, eating when hurt on the way (a walk home: poisoned by the KBD, a camper at the ladder; the KQ's tunnels) */
export function eating(step: Step): Step {
    return {
        label: step.label,
        // (round 1 fixes: a climb answers its own dialogue)
        dialog: step.dialog,
        tick(p, t) {
            eatWhenLow(p);
            return step.tick(p, t);
        }
    };
}

/**
 * a lever pulled (op Pull) until `there(p)`: the engine walks the bot to it; its p_teleport marked as the game's move (each
 * tick by it: the pull's script moves it a few ticks later). A lever another just pulled is down for 7 ticks (274's
 * loc_change to hauntedleverdown): waited for. A few tries.
 */
function pullLever(name: string, at: At, there: (p: Player) => boolean): Step {
    let tries = 0;
    let wait = 0;
    let missing = 0;
    return {
        label: `pull ${name}`,
        tick(p) {
            if (there(p)) {
                tries = 0;
                wait = 0;
                missing = 0;
                return 'done';
            }
            if (Math.max(Math.abs(p.x - at[0]), Math.abs(p.z - at[1])) <= 2) noteMove(p, 'event');
            if (wait > 0 && (--wait > 0 || p.delayed || botScript(p))) return 'run';
            if (Math.max(Math.abs(p.x - at[0]), Math.abs(p.z - at[1])) > 40) return 'fail';
            const lever = findLocByName(at[0], at[1], 0, name, 3);
            if (!lever) {
                // (pulled by another a moment ago: down for a few ticks)
                if (++missing > 30) return 'fail';
                return 'run';
            }
            if (++tries > 5) {
                tries = 0;
                return 'fail';
            }
            interactLocOp(p, lever, 1);
            wait = 10 + Math.max(Math.abs(p.x - at[0]), Math.abs(p.z - at[1]));
            return 'run';
        }
    };
}

/** the lair's way in: down the west Lava Maze ladder, the lever (each its own clicks) */
function inSteps(): Step[] {
    return [
        eating(climb(['wildymirrorladdertop1'], 'climb-down', LADDER, 0, q => q.z > 6400)),
        pullLever('dragonkinginlever', LEVER_IN, q => q.z > 6400 && q.x < 2800)
    ];
}
/** the lair's way out: the lever, then the lever room's ladder up */
function outSteps(): Step[] {
    return [
        when(q => q.z > 6400 && q.x < 2800, pullLever('dragonkingoutlever', LEVER_OUT, q => q.x > 3000)),
        when(q => q.z > 6400, climb(['loc_1766'], 'climb-up', LEVER_ROOM_LADDER, 0, q => q.z < 6400))
    ];
}

/**
 * a member leaves the lair with food to eat on the way home (the KBD poisons; 335 steps of the deep Wilderness): its good
 * food down to 4 with its Hitpoints under 60 %, or to 2 (port/BotEndgameFight's trip end), its pack full, its prayer out
 */
function kbdLeave(p: Player): boolean {
    const hp = p.levels[PlayerStat.HITPOINTS] / Math.max(1, p.baseLevels[PlayerStat.HITPOINTS]);
    return (goodFoodCarried(p) <= 4 && hp < 0.6) || fightOver(p, true);
}

/** in the lair now? */
const inLair = (p: Player): boolean => p.z > 6400 && p.x < 2800;

/** the lair's fight for a member (or the leader): until its own end or the team's */
function lairFight(t: KbdTeam, died: (p: Player) => boolean): Step[] {
    const watcher = fightWatcher('melee', 'kbd');
    let ended = false;
    const teamOver = (): boolean => t.state === 'out' || t.state === 'done' || t.state === 'aborted' || (t.lairAt >= 0 && World.currentTick - t.lairAt >= teamTicks);
    return [
        act('lair', q => {
            if (t.lairAt < 0) t.lairAt = World.currentTick;
            if (t.state === 'travel') t.state = 'lair';
            return 'done';
        }),
        soft(
            fight(
                () => {
                    const task = new CombatTask(kbdStep(), PlayerStat.STRENGTH);
                    task.holdStep = true;
                    task.shareNpc = true;
                    return task;
                },
                q => {
                    if (died(q) || teamOver()) return true;
                    if (kbdLeave(q)) {
                        if (!t.foodOut.has(q)) {
                            t.foodOut.add(q);
                            call(q, 'kbd-food-out', 0.5);
                            if (t.foodOut.size >= FOOD_OUT_LEAVE || t.foodOut.size >= t.members.length) t.state = 'out';
                        }
                        return true;
                    }
                    return false;
                },
                teamTicks + 600,
                q => {
                    if (!died(q)) watcher.watch(q);
                }
            )
        ),
        act('lair over', q => {
            if (!ended) {
                ended = true;
                watcher.end(q);
            }
            return protectionsOff(q) ? 'run' : 'done';
        })
    ];
}

/**
 * the trip home from the lair: out, Edgeville bank, the shield off; (round 1 fixes, A1) each step passed over once the bot
 * died (`whileAlive`: the one look at its start let a bot killed by a camper by the ladder walk from Lumbridge back to the
 * members' gate)
 */
function homeSteps(died: (p: Player) => boolean): Step[] {
    const shield = obj('antidragonbreathshield');
    // (round 1 fixes: and eating at the lair's lever and the ladder: a member queued at the out-lever under the KBD went
    // from 50 Hitpoints to 0 in 20 ticks without eating, a death A1 now logs)
    return whileAlive(died, ...outSteps().map(eating), soft(eating(walk(GATE_OUT, 2, 300, 'through the gate'))), soft(eating(walk(EDGE_BANK, 4, 4000, 'home'))), bank({ near: EDGE_BANK }), bankDragonShield(shield));
}

/** the bank stop before: food (KBD_FOOD of the best), the shield; (a bot without a shield gets the Duke's first) */
function prepSteps(): Step[] {
    const shield = obj('antidragonbreathshield');
    return [
        bank({ near: EDGE_BANK, keep: () => [shield, ...foodIds()], withdraw: q => [...foodWithdraw(KBD_FOOD)(q), [shield, 1]] }),
        act('food', q => (goodFoodCarried(q) >= 12 ? 'done' : 'fail'))
    ];
}

/** the leader's errand, and (round 1 fixes, A2) its end's hook: the team ended with it, however it ended */
function leaderPlan(shieldSteps: (back: At) => Step[], bosser: (p: Player) => boolean): { plan: ErrandPlan; over: (outcome: string) => void } {
    let t: KbdTeam | null = null;
    // (round 1 fixes, A2: a leader's errand failed or cut short after the call left the team set world-wide, no KBD team
    // for anyone for the rest of its session, and its members waiting or following: the team ends with the errand, aborted
    // unless it was in the lair or on its way out, whose members leave it)
    const over = (outcome: string): void => {
        if (!t || t.ended) return;
        if (t.state !== 'lair' && t.state !== 'out') t.state = 'aborted';
        finish(t, outcome);
    };
    const plan: ErrandPlan = {
        kind: 'KbdTeam',
        key: 'kbd',
        at: MEET,
        members: true,
        ok: p => kbdFit(p),
        build(p) {
            const death = deathCheck();
            const died = (q: Player): boolean => {
                const d = death.died(q);
                const task = taskOf.get(plan);
                if (d && task && !task.died) {
                    task.died = true;
                    emitEndgameEvent(q, 'bossDeath', { spot: 'kbd' });
                    // (round 1 fixes, A1, A2: the leader dead on the way, the team is off; dead in the lair, it leaves)
                    if (t && !t.ended) {
                        if (t.lairAt < 0) over('died');
                        else if (t.state === 'lair') t.state = 'out';
                    }
                }
                return d;
            };
            return [
                // (round 1 fixes, A1: each step to the lair passed over once it died: the lair's fight and the team's
                // bookkeeping look for themselves)
                ...whileAlive(
                    died,
                    ...prepSteps(),
                    ...shieldSteps(EDGE_BANK),
                    walk(MEET, 3, 3000, 'to the meeting'),
                    act('call', (q, task) => {
                        if (kbdTeam() !== null) return 'fail';
                        teamStats.calls++;
                        lastKbd.set(q.username.toLowerCase(), World.currentTick);
                        t = { leader: q, members: [q], state: 'call', formed: World.currentTick, travelAt: -1, lairAt: -1, foodOut: new Set(), ready: new Set([q]), kills: 0, leaderTask: task, ended: false };
                        team = t;
                        call(q, Math.random() < 0.5 ? 'kbd-call' : 'kbd-call-any');
                        const recruits = recruit(q, bosser);
                        if (recruits.length === 0) {
                            teamStats.nobody++;
                            call(q, 'kbd-nvm');
                            t.state = 'aborted';
                            finish(t, 'nobody');
                            // (the leader picks again: a solo spot may come at once)
                            clearEndgameStart(q.username);
                            return 'fail';
                        }
                        for (const r of recruits) summon(r, memberTask(t, shieldSteps));
                        t.members.push(...recruits);
                        t.state = 'meet';
                        for (const r of recruits) lastKbd.set(r.username.toLowerCase(), World.currentTick);
                        call(q, 'kbd-meet', 0.6);
                        return 'done';
                    }),
                    act('meet', q => {
                        if (!t) return 'fail';
                        const here = t.members.filter(m => t!.ready.has(m) && m.slot !== -1 && m.level === q.level && Math.max(Math.abs(m.x - q.x), Math.abs(m.z - q.z)) <= 8);
                        const waited = World.currentTick - t.formed;
                        if (waited === 30) call(q, 'kbd-shield', 0.5);
                        if (here.length < t.members.length && waited < MEET_TICKS) return 'run';
                        // (the late ones left behind; fewer than two here: no team)
                        for (const m of [...t.members]) if (!here.includes(m)) t.members.splice(t.members.indexOf(m), 1);
                        if (t.members.length < TEAM_SIZE[0]) {
                            call(q, 'kbd-nvm');
                            t.state = 'aborted';
                            finish(t, 'meeting');
                            return 'fail';
                        }
                        teamStats.formed++;
                        teamStats.members.push(t.members.length);
                        t.state = 'travel';
                        t.travelAt = World.currentTick;
                        call(q, 'kbd-go', 0.8);
                        return 'done';
                    }),
                    travelWalk(() => t),
                    ...inSteps(),
                    act('in', () => {
                        if (t) call(p, 'kbd-lever', 0.3);
                        return 'done';
                    })
                ),
                ...lairFightFor(() => t, died),
                act('team out', () => {
                    if (t && t.state !== 'done' && t.state !== 'aborted') t.state = 'out';
                    return 'done';
                }),
                ...homeSteps(died),
                act('done', q => {
                    if (t) {
                        if (!died(q)) {
                            call(q, 'kbd-done', 0.5);
                            // (the KQ, talked of: its rare attempts are port/BotKqTeams', the KQ track's)
                            call(q, 'kbd-kq', 0.2);
                        }
                        finish(t, 'done');
                    }
                    return 'done';
                })
            ];
        }
    };
    return { plan, over };
}

/** (a step list built at the lair's turn, for the team of then) */
function lairFightFor(get: () => KbdTeam | null, died: (p: Player) => boolean): Step[] {
    let steps: Step[] | null = null;
    let i = 0;
    return [
        {
            label: 'the lair',
            tick(p, task) {
                const t = get();
                if (!t || !inLair(p)) return 'done';
                steps ??= lairFight(t, died);
                while (i < steps.length) {
                    const r = steps[i].tick(p, task);
                    if (r === 'run') return 'run';
                    if (r === 'fail') break;
                    i++;
                    return i >= steps.length ? 'done' : 'run';
                }
                return 'done';
            }
        }
    ];
}

/** the leader's walk to the ladder, its members' nearness sampled (EG11) */
function travelWalk(get: () => KbdTeam | null): Step {
    const w = walk(LADDER, 2, 4000, 'to the ladder');
    let n = 0;
    let waited = 0;
    return {
        label: 'to the ladder',
        tick(p, task) {
            eatWhenLow(p);
            const t = get();
            // (a member far behind: the leader waits up a moment, as a team does; WAIT_UP ticks at most a stretch)
            const behind = t?.members.some(m => m !== p && m.slot !== -1 && t.ready.has(m) && m.z < 6400 && (m.level !== p.level || Math.max(Math.abs(m.x - p.x), Math.abs(m.z - p.z)) > WAIT_GAP)) ?? false;
            if (behind && waited < WAIT_UP) {
                waited++;
                if (p.hasWaypoints()) p.clearWaypoints();
                return 'run';
            }
            if (!behind) waited = 0;
            if (t && ++n % 10 === 0) {
                for (const m of t.members) {
                    if (m === p || m.slot === -1) continue;
                    teamStats.travelSamples++;
                    if (m.level === p.level && Math.max(Math.abs(m.x - p.x), Math.abs(m.z - p.z)) <= TRAVEL_NEAR) teamStats.travelNear++;
                }
            }
            return w.tick(p, task);
        }
    };
}

/**
 * a member follows the leader north (the game's Follow; a walk to it when far or stopped), until the leader is down;
 * (round 1 fixes, A2) no longer than FOLLOW_TICKS, and only a leader still on its KBD errand
 */
function followLeader(t: KbdTeam): Step {
    let stuck = 0;
    let lastPos = -1;
    let ticks = 0;
    return {
        label: 'follow the leader',
        tick(p) {
            eatWhenLow(p);
            const l = t.leader;
            if (l.slot === -1 || t.state === 'aborted' || t.state === 'done') return 'fail';
            const lead = (l as unknown as { _bot?: { currentTask?: unknown } })._bot;
            if (++ticks > FOLLOW_TICKS || (t.leaderTask !== null && lead !== undefined && lead.currentTask !== t.leaderTask)) return 'fail';
            // (the leader is down the ladder, or this one is at the ladder: its own climb next)
            if (l.z > 6400 || Math.max(Math.abs(p.x - LADDER[0]), Math.abs(p.z - LADDER[1])) <= 3) return 'done';
            const d = l.level === p.level ? Math.max(Math.abs(l.x - p.x), Math.abs(l.z - p.z)) : 99;
            // (the leader's pace: running when it runs, as a group keeps together)
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

/** a member's errand */
function memberPlan(t: KbdTeam, shieldSteps: (back: At) => Step[]): ErrandPlan {
    const plan: ErrandPlan = {
        kind: 'KbdTeam',
        key: 'kbd-member',
        at: MEET,
        members: true,
        build(p) {
            const death = deathCheck();
            const died = (q: Player): boolean => {
                const d = death.died(q);
                const task = taskOf.get(plan);
                if (d && task && !task.died) {
                    task.died = true;
                    emitEndgameEvent(q, 'bossDeath', { spot: 'kbd' });
                }
                return d;
            };
            // (round 1 fixes, A2: and its leader online: a leader logged out at the meeting left it waiting for good)
            const live = (): boolean => t.state !== 'aborted' && t.state !== 'done' && t.members.includes(p) && t.leader.slot !== -1;
            return [
                // (round 1 fixes, A1: each step to the lair passed over once it died; the lair's fight looks for itself)
                ...whileAlive(
                    died,
                    act('omw', q => {
                        call(q, 'kbd-omw', 0.6);
                        return 'done';
                    }),
                    ...prepSteps(),
                    ...shieldSteps(EDGE_BANK),
                    act('still on', () => (live() ? 'done' : 'fail')),
                    walk(MEET, 3, MEET_TICKS + 200, 'to the meeting'),
                    act('here', q => {
                        t.ready.add(q);
                        call(q, 'kbd-here', 0.5);
                        return 'done';
                    }),
                    // (round 1 fixes, A2: no longer than the leader's meeting)
                    act('wait', () => (!live() || World.currentTick - t.formed > MEET_TICKS + MEET_GRACE ? 'fail' : t.state === 'meet' || t.state === 'call' ? 'run' : 'done')),
                    followLeader(t),
                    walk(LADDER, 2, 1500, 'to the ladder'),
                    ...inSteps()
                ),
                ...lairFightFor(() => t, died),
                ...homeSteps(died)
            ];
        }
    };
    return plan;
}

const taskOf = new WeakMap<ErrandPlan, BosserErrand>();
function memberTask(t: KbdTeam, shieldSteps: (back: At) => Step[]): BosserErrand {
    const plan = memberPlan(t, shieldSteps);
    const task = new BosserErrand(plan, 'kbd');
    taskOf.set(plan, task);
    return task;
}

/** the leader's KBD errand (port/BotEndgame's offer; the tests'): `bosser` its trait's test for the recruits */
export function kbdLeaderTask(shieldSteps: (back: At) => Step[], bosser: (p: Player) => boolean): BosserErrand {
    const { plan, over } = leaderPlan(shieldSteps, bosser);
    const task = new BosserErrand(plan, 'kbd');
    task.onOver = over;
    taskOf.set(plan, task);
    return task;
}

/** the recruits: free bots of the bar, the leader's clique first, 1-3 */
function recruit(leader: Player, bosser: (p: Player) => boolean): Player[] {
    const mates = new Set((cliqueOf(leader.username) ?? []).map(n => n.toLowerCase()));
    const pool: Player[] = [];
    for (const p of worldPlayers()) {
        if (p === leader || !mayJoin(p, bosser) || wildernessLevelAt(p.x, p.z) > 0) continue;
        pool.push(p);
    }
    pool.sort((a, b) => Number(mates.has(b.username.toLowerCase())) - Number(mates.has(a.username.toLowerCase())) || Math.random() - 0.5);
    const want = TEAM_SIZE[0] - 1 + Math.floor(Math.random() * (TEAM_SIZE[1] - TEAM_SIZE[0] + 1));
    return pool.slice(0, want);
}

/** the recruit's task replaced by the member's errand (as BotPlayer switches: the one it leaves is over); (the KQ track's too) */
export function summon(p: Player, task: BosserErrand): void {
    const ai = (p as unknown as { _bot?: { currentTask: { interrupt(): void; reset(): void } | null } })._bot;
    if (!ai) return;
    const cur = ai.currentTask;
    if (cur) {
        cur.interrupt();
        cur.reset();
    }
    task.reset();
    ai.currentTask = task as unknown as { interrupt(): void; reset(): void };
}

function finish(t: KbdTeam, outcome: string): void {
    // (round 1 fixes, A2: once: its leader's errand's end may come after the team's own)
    if (t.ended) return;
    t.ended = true;
    if (t.state !== 'aborted') t.state = 'done';
    else teamStats.aborted++;
    if (outcome === 'done' && t.foodOut.size >= t.members.length && t.kills === 0) emitEndgameEvent(t.leader, 'teamWipe', { kind: 'kbd' });
    teamLog.push({ leader: t.leader.username, members: t.members.map(m => m.username), formed: t.formed, end: World.currentTick, outcome, kills: t.kills });
    if (teamLog.length > 500) teamLog.splice(0, teamLog.length - 500);
    if (team === t) team = null;
}

/** a KBD kill (the fight watcher's: the bones of the top damager's drop): the team's count and its word */
onEndgameEvent(e => {
    if (e.kind !== 'bossKill' || e.data.spot !== 'kbd' || !team) return;
    team.kills++;
    teamStats.kills++;
    call(e.bot, 'kbd-kill', 0.7);
});
