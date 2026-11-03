// port (bots ideas, round 2, theme C: lives with arcs): theme C's modules, imported for their listeners and their entries
// in port/BotLives (port/BotSetPieceIndex imports this once, after BotManager's own imports), and the planner's entries
// that more than one of them shares, in their order:
//   beginPick    the goal (port/BotGoals ensureGoal: the first pick of a session with none); a tilted careless bot's
//                risky pick (port/BotMoods, held for the pick: port/BotFumble)
//   endPick      boredom's clock: the task kind picked (port/BotMoods)
//   plannerTask  a gear goal's piece come into reach (its shop trip)
//   candidates   the goal's lean (its skill first, GOAL_LEAN of the picks), then boredom's avoidance (the last skill to the
//                end, 70 % of picks at 0.6+)
//   (whims: port/BotWhims, a skiller's Wilderness trip before the candidates, the whim's skill first in them, its task
//   timed at the pick's end; an extra's at the top of ExtrasGoalPlanner.pickTask)
import type Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import type { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';
import { LIVES } from '#/engine/bot/port/BotLives.js';
import { ensureGoal, goalLean, goalPlannerTask } from '#/engine/bot/port/BotGoals.js';
import { beginMoodPick, boredSkillToAvoid, endMoodPick } from '#/engine/bot/port/BotMoods.js';
import '#/engine/bot/port/BotLeaving.js';
import '#/engine/bot/port/BotNinetyNine.js';
import { whimCandidates, whimPicked, whimPlannerTask } from '#/engine/bot/port/BotWhims.js';
import { taskKind } from '#/engine/bot/port/BotLines.js';

/** the task kinds' skills (boredom's clock and its avoidance: the planner's candidate names) */
const KIND_STAT: Readonly<Record<string, number>> = {
    Woodcut: PlayerStat.WOODCUTTING,
    Mine: PlayerStat.MINING,
    Fish: PlayerStat.FISHING,
    Cook: PlayerStat.COOKING,
    Smith: PlayerStat.SMITHING,
    Thieve: PlayerStat.THIEVING,
    Agility: PlayerStat.AGILITY,
    Firemaking: PlayerStat.FIREMAKING,
    Fletching: PlayerStat.FLETCHING,
    BowStringing: PlayerStat.FLETCHING,
    Crafting: PlayerStat.CRAFTING,
    'Pick Flax': PlayerStat.CRAFTING,
    Runecrafting: PlayerStat.RUNECRAFT,
    Herblore: PlayerStat.HERBLORE,
    Prayer: PlayerStat.PRAYER,
    Combat: PlayerStat.ATTACK
};
const STAT_SKILL: Readonly<Record<number, readonly string[]>> = {
    [PlayerStat.WOODCUTTING]: ['WOODCUTTING'],
    [PlayerStat.MINING]: ['MINING'],
    [PlayerStat.FISHING]: ['FISHING'],
    [PlayerStat.COOKING]: ['COOKING'],
    [PlayerStat.SMITHING]: ['SMITHING'],
    [PlayerStat.THIEVING]: ['THIEVING'],
    [PlayerStat.AGILITY]: ['AGILITY'],
    [PlayerStat.FIREMAKING]: ['FIREMAKING'],
    [PlayerStat.FLETCHING]: ['FLETCHING'],
    [PlayerStat.CRAFTING]: ['CRAFTING'],
    [PlayerStat.RUNECRAFT]: ['RUNECRAFT'],
    [PlayerStat.HERBLORE]: ['HERBLORE'],
    [PlayerStat.PRAYER]: ['PRAYER'],
    [PlayerStat.ATTACK]: ['ATTACK', 'STRENGTH', 'DEFENCE']
};

LIVES.beginPick = (player: Player): void => {
    ensureGoal(player);
    beginMoodPick(player);
};

LIVES.endPick = (player: Player, task: BotTask | null): BotTask | null => {
    const kind = task ? taskKind(task.name) : null;
    // (a walk, a bank or a shop trip, a hang-out: no change of what it does)
    const stat = kind !== null ? KIND_STAT[kind] : undefined;
    endMoodPick(player, stat === undefined ? null : kind, stat ?? -1);
    // (a whim's task: timed to the whim's end)
    return whimPicked(player, task);
};

LIVES.plannerTask = (player: Player): BotTask | null => {
    return whimPlannerTask(player) ?? goalPlannerTask(player);
};

LIVES.candidates = (player: Player, candidates: string[]): void => {
    // (a whim's skill first, once; else the goal's lean)
    if (!whimCandidates(player, candidates)) goalLean(player, candidates);
    // (boredom: its last skill to the end, 70 % of picks at 0.6+; never a plan cut short: only the next pick)
    const bored = boredSkillToAvoid(player);
    if (bored !== null) {
        for (const skill of STAT_SKILL[bored] ?? []) {
            const i = candidates.indexOf(skill);
            if (i >= 0 && candidates.length > 1) candidates.push(...candidates.splice(i, 1));
        }
    }
};

export {};
