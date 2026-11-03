// port (bots ideas, round 3, theme G: period content): the planner's hook for the update buzz (Rellekka, its rock crabs, the lighthouse), beside the far towns'
// and minigames' (port/BotMinigames), and the period lines' one way to be said.
//
//   - periodTaskFor (registered by port/BotPeriodIndex, after the members hook): off (periodOn), not a members world,
//     or nothing in port/BotPeriod's registry: null at once, no dice, nothing counted. Else a free bot (mayBuzz: a
//     levelling bot of combat 15+, no newbie, on the overworld out of the Wilderness, unhurt, on no errand, trade or set
//     piece, half an hour of its session left), while fewer than buzzBudget(N) are out and its last buzz ended
//     BUZZ_GAP play ticks ago or more, is offered a visit BUZZ_OFFER × (0.5 + curiosity) × its boost of the time (one
//     roll); the registry's weights pick among the entries that fit and are under their caps (one roll a pick; an entry
//     whose make() gives null is left out and the pick drawn again). Never two buzz visits in a row.
//   - keptPeriodTask (registered as a keep hook): a buzz task under way is kept at a plan's end (a rescan's pick of the
//     same task is no switch), as an outing is.
//   - sayPeriodLine: a set-piece line of the period's (data/lines2004-period.json, event 'period') or the buzz's
//     (lines2004-buzz.json, event 'buzz') of a kind, fresh, in the speaker's style, kind 'setpiece' (out of H7, counted
//     in X2), in the place of the speaker's next unprompted line; members' worlds only, and nothing while theme G is off.
// No task imports here (the builders' modules give the tasks through the registry): no cycle.
import type Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import type { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';
import { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { botPersona } from '#/engine/bot/port/BotTiming.js';
import { sayPieceLine } from '#/engine/bot/port/BotPieceLines.js';
import { notePick } from '#/engine/bot/port/BotOutings.js';
import {
    BUZZ_GAP,
    BUZZ_MARK,
    BUZZ_MIN_COMBAT,
    BUZZ_OFFER,
    PERIOD_SESSION_LEFT,
    buzzBoostOf,
    buzzBudget,
    forcedPeriodKey,
    periodBudgetN,
    periodCap,
    periodEntries,
    periodOn,
    periodOf,
    periodOut,
    periodOutOn,
    periodRate,
    periodStats,
    playSincePeriod,
    type PeriodEntry
} from '#/engine/bot/port/BotPeriod.js';

/** the bots online for the budget: a test's own N, else BotManager's configured N */
export function periodN(): number {
    const n = periodBudgetN();
    if (n !== null) return n;
    try {
        return BotManager.stats().configured;
    } catch {
        return 0;
    }
}

/**
 * a bot free for a buzz visit now: a levelling bot (the extras keep their roles) of combat BUZZ_MIN_COMBAT+, no newbie,
 * on the overworld out of the Wilderness, at half its Hitpoints or more, on no "come here", trade or set piece, with
 * PERIOD_SESSION_LEFT of its session left (the world's rule, members, is the hook's)
 */
export function mayBuzz(player: Player): boolean {
    if (!isLevelling(player.botPlanner as PlannerKey) || isNewbie(player) || player.combatLevel < BUZZ_MIN_COMBAT) return false;
    if (player.level !== 0 || player.z >= 6400 || wildernessLevelAt(player.x, player.z) > 0) return false;
    if (player.levels[PlayerStat.HITPOINTS] * 2 < player.baseLevels[PlayerStat.HITPOINTS] || player.botComeHereReturnX !== -1 || player.botTradeTargetPid !== -1 || eventRoleOf(player)) return false;
    return BotManager.sessionLeftOf(player.username) >= PERIOD_SESSION_LEFT;
}

/** The buzz visit under way, kept (null: none, or theme G off). */
export function keptPeriodTask(player: Player): BotTask | null {
    if (!periodOn() || periodOf(player)?.kind !== 'buzz') return null;
    const current = BotManager.botFor(player)?.currentTask ?? null;
    if (current && current.name.includes(BUZZ_MARK) && !current.isComplete(player) && !current.interrupted && current.shouldRun(player)) {
        periodStats.kept++;
        return current;
    }
    return null;
}

/** The planner's hook: a buzz visit for this bot now, or null. */
export function periodTaskFor(player: Player, previous: string | null): BotTask | null {
    // (off, or nothing registered: at once, no dice, nothing counted)
    const entries = periodEntries();
    if (!periodOn() || entries.length === 0 || !isMembersWorld()) return null;
    const kept = keptPeriodTask(player);
    if (kept) return kept;
    periodStats.asked++;
    if (previous !== null && previous.includes(BUZZ_MARK)) {
        periodStats.why.again++;
        return null;
    }
    if (!mayBuzz(player)) {
        periodStats.why.who++;
        return null;
    }
    const n = periodN();
    if (periodOut('buzz') >= buzzBudget(n)) {
        periodStats.why.budget++;
        return null;
    }
    if (playSincePeriod(player.username, 'buzz') < BUZZ_GAP) {
        periodStats.why.gap++;
        return null;
    }
    const boost = buzzBoostOf(player);
    if (Math.random() >= Math.min(1, BUZZ_OFFER * periodRate() * (0.5 + botPersona(player).curiosity) * boost.factor)) {
        periodStats.why.roll++;
        return null;
    }
    // (the entries it may do now, under their caps; a rumour's key leaned to)
    const forced = forcedPeriodKey();
    const options: PeriodEntry[] = [];
    for (const entry of entries) {
        if (entry.kind !== 'buzz' || (forced !== null && entry.key !== forced)) continue;
        if (periodOutOn(entry.key).length >= periodCap(entry, n)) continue;
        if (entry.fits(player)) options.push(entry);
    }
    const weightOf = (e: PeriodEntry): number => e.weight * (boost.key === e.key ? 2 : 1);
    while (options.length > 0) {
        let pick = options[options.length - 1];
        if (options.length > 1) {
            let roll = Math.random() * options.reduce((a, e) => a + weightOf(e), 0);
            for (const e of options) {
                roll -= weightOf(e);
                if (roll <= 0) {
                    pick = e;
                    break;
                }
            }
        }
        const task = pick.make(player);
        if (task) {
            periodStats.offered++;
            periodStats.byKey[pick.key] = (periodStats.byKey[pick.key] ?? 0) + 1;
            notePick('period', pick.key, previous);
            return task;
        }
        options.splice(options.indexOf(pick), 1);
    }
    periodStats.why.none++;
    return null;
}

/**
 * The bot says a fresh line of the moment `kind` of the period's lines (event 'period': data/lines2004-period.json) or
 * the buzz's (event 'buzz': lines2004-buzz.json) now: the text said, or null (theme G off, a free world, none fresh).
 * Kind 'setpiece' (out of H7, X2), in its style, in the place of its next unprompted line.
 */
export function sayPeriodLine(bot: Player, event: 'period' | 'buzz', kind: string, to: Player | null = null): string | null {
    if (!periodOn() || !isMembersWorld()) return null;
    return sayPieceLine(bot, event, kind, 'setpiece', { to });
}
