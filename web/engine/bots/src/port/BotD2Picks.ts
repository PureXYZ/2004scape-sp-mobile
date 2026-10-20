/**
 * port (the variety work, round 2, Track D2: new activities) the planner's offers of the round's activities, from its
 * marked block (BotGoalPlanner: the newcomers' path and the levelling picks, after the claims and the carry-on, before
 * the weighted skills): the economy chains (port/BotChains), the quest look-alikes (port/BotErrands), the prayer and
 * magic runs (port/BotMagicRuns), herblore (port/BotHerbRuns) and the Wilderness trips (port/BotWildTrips). Each has its own
 * share of the picks of the bots it suits; one at a time.
 *
 * An errand under way is kept: a rescan of a plan that is over (a newcomer's every few minutes) hands back a task of the
 * same name, which BotPlayer keeps running (its rescan switches only to another name). A quest look-alike, and picking
 * (no XP for long), run as the bot's sub-task (tasks/ErrandTask ErrandHost): no plan clock cuts them half done.
 */
import type Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import type { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';
import { ErrandHost, ErrandTask } from '#/engine/bot/tasks/ErrandTask.js';
import { chainFor, CHAINS, chainTask } from '#/engine/bot/port/BotChains.js';
import { questFor } from '#/engine/bot/port/BotErrands.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { magicRunFor } from '#/engine/bot/port/BotMagicRuns.js';
import { herbRunFor } from '#/engine/bot/port/BotHerbRuns.js';
import { wildTripFor } from '#/engine/bot/port/BotWildTrips.js';
// (the errands' lines: the module sets its hook on the errand engine at load)
import '#/engine/bot/port/BotErrandLines.js';

/** the kinds run as a sub-task (no XP for long stretches) */
const HOSTED = new Set(['Quest', 'Picking', 'Flour']);

/** a chain newcomers take (no tools beyond Tutorial Island's, no long trips) */
const NEWBIE_CHAINS = ['feathers', 'picking', 'flour', 'hides'];
/**
 * a newcomer's pick goes to a chain this often: a chain lasts several of its few-minute newbie plans, so 18 % of picks
 * was a third of newcomers' time (seven9, m100 s6: Flour 17.5, Feathers 8.4, Picking 1.6 % against Newbie 30 %)
 */
export const NEWBIE_CHAIN_SHARE = 0.06;

/** the bots whose relog has had its first pick (a WeakSet: a login is a new Player) */
const settled = new WeakSet<Player>();

/** the offers on (a staged test of another feature turns them off: its scenes' bots as before the errands) */
let offersOn = true;
/** (tests) the round's offers on or off */
export function setD2OffersForTest(on: boolean): void {
    offersOn = on;
}

/** what the offers gave (the report, the tests) */
export const d2PickStats = { asked: 0, kept: 0, given: {} as Record<string, number> };

function host(task: ErrandTask): BotTask {
    return HOSTED.has(task.plan.kind) ? new ErrandHost(task) : task;
}

function note(task: BotTask | null): BotTask | null {
    if (task) d2PickStats.given[task.name.split(':')[0]] = (d2PickStats.given[task.name.split(':')[0]] ?? 0) + 1;
    return task;
}

/**
 * the bot's own errand still under way: a twin of its name (BotPlayer keeps the running one), else null. (The variety work,
 * round 2, the fixes: one that can run: an errand that never began, whose ok() fails now, was handed back every tick, and a
 * newcomer stood until it passed; and asked first by the planner, BotGoalPlanner's keep step, before its claims and visits)
 */
export function keptErrand(player: Player): BotTask | null {
    if (!offersOn) return null;
    const ai = (player as unknown as { _bot?: { currentTask?: BotTask | null } })._bot;
    const cur = ai?.currentTask ?? null;
    if (!cur || cur.interrupted || cur.isComplete(player) || !cur.shouldRun(player)) return null;
    if (cur instanceof ErrandTask) {
        d2PickStats.kept++;
        return new ErrandTask(cur.plan);
    }
    if (cur instanceof ErrandHost) {
        d2PickStats.kept++;
        return new ErrandHost(new ErrandTask(cur.errand.plan));
    }
    return null;
}

/**
 * A newcomer's pick (BotGoalPlanner._newbieTask, after its first wander): a quest look-alike now and then, a newbie
 * chain (feathers, picking, flour, hides) NEWBIE_CHAIN_SHARE of the time; null: its own newbie stint.
 */
export function d2NewbiePick(player: Player): BotTask | null {
    if (!offersOn) return null;
    d2PickStats.asked++;
    const kept = keptErrand(player);
    if (kept) return kept;
    // (a hurt newcomer mills about Lumbridge until it is well again, as its planner has it: no errand then)
    if (player.levels[PlayerStat.HITPOINTS] * 2 < player.baseLevels[PlayerStat.HITPOINTS]) return null;
    const quest = questFor(player);
    if (quest) return note(host(quest));
    if (Math.random() >= NEWBIE_CHAIN_SHARE || player.combatLevel < 3) return null;
    const open = NEWBIE_CHAINS.filter(k => {
        const plan = CHAINS[k]();
        return !plan.ok || plan.ok(player);
    });
    if (open.length === 0) return null;
    const task = chainTask(open[Math.floor(Math.random() * open.length)]);
    return task ? note(host(task)) : null;
}

/**
 * A levelling bot's pick (BotGoalPlanner._pickBestTask's Track D2 block): its errand under way kept; else a quest
 * look-alike (combat 3-25), an economy chain (combat 3-20, a skiller with low crafts); null: the weighted skills.
 */
export function d2Pick(player: Player, personality: string, relog = false): BotTask | null {
    if (!offersOn) return null;
    d2PickStats.asked++;
    const kept = keptErrand(player);
    if (kept) return kept;
    if (isNewbie(player)) return null;
    // (a relog's first pick is the planner's own: a player back carries on with what it was doing, or picks as before;
    // an errand comes later in its session. Before: 22-34 % of relogs started what they left, against 42-56 %: AM5.
    // Every login's first pick cost the errands half their picks: sessions are short, a plan long)
    if (relog && !settled.has(player)) {
        settled.add(player);
        return null;
    }
    const quest = questFor(player);
    if (quest) return note(host(quest));
    const chain = chainFor(player, personality === 'Skiller', Math.random(), personality === 'Fighter');
    if (chain) return note(host(chain));
    // (members: herblore for a bot that has the herbs; any world: a Wilderness trip for a bold one, a prayer or magic run)
    const herbs = herbRunFor(player, Math.random(), personality === 'Fighter');
    if (herbs) return note(herbs);
    const wild = wildTripFor(player);
    if (wild) return note(wild);
    const run = magicRunFor(player);
    if (run) return note(run);
    return null;
}
