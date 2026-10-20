// port: high alchemy at the banks (the realism work, phase 5a, Track M; "yes" to alching: a bot with Magic
// 55+ alchs its own produce and loot at a trade bank, a common 2004 sight). The planner asks here between plans, as it
// asks port/BotHangout (its step 1f): a stint of alching (tasks/AlchTask) every 40-90 minutes of play for a bot that
// has the level, natures, fire (runes or its staff) and things to alch, at the trade bank nearest it.
//
// It also holds the spells' talk for port/BotTeleport (which loads nothing of the chatter's: BotAction imports it, and the
// chatter would load the tasks before BotAction is done): setTeleportTalk below, at load.
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import type { BotTask } from '#/engine/bot/tasks/Index.js';
import { countAsBudgetedLine, noteEvent } from '#/engine/bot/port/BotChatter.js';
import { isFresh, noteSaid } from '#/engine/bot/port/BotLines.js';
import { personaOf } from '#/engine/bot/port/BotPersona.js';
import type { PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { botSay } from '#/engine/bot/port/BotSay.js';
import { noteSpoke } from '#/engine/bot/port/BotSpoke.js';
import { styleLine } from '#/engine/bot/port/BotStyle.js';
import { setTeleportTalk } from '#/engine/bot/port/BotTeleport.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import { isLevelling } from '#/engine/bot/port/BotRoster.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { usableBanks, type TradeBank } from '#/engine/bot/port/BotTradeSpots.js';
import { ALCH_KIND, AlchTask, HIGH_ALCH_LEVEL, alchSupplies, alchableItems } from '#/engine/bot/tasks/AlchTask.js';
import { LAWS_BOUGHT, LawTripTask } from '#/engine/bot/tasks/LawTripTask.js';
// (for the humanlike runner and the tests: alching's and the law runs' counters, through this module the foundation made)
export { alchStats };
export { lawTripStats } from '#/engine/bot/tasks/LawTripTask.js';
import { LAWS_KEPT, isTeleporter, lawsOwned } from '#/engine/bot/port/BotTeleport.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { coinsOwned } from '#/engine/bot/BotNeeds.js';
import { setBankStopHook } from '#/engine/bot/tasks/BotTaskBase.js';
import { scheduleInTicks } from '#/engine/bot/port/BotSchedule.js';
import { alchStats } from '#/engine/bot/tasks/AlchTask.js';

/** play ticks between two stints (40-90 minutes), and a stint's length (3-9 minutes) */
export const ALCH_GAP_TICKS: [number, number] = [4000, 9000];
export const ALCH_STINT_TICKS: [number, number] = [300, 900];
/** a trade bank this far off at most (tiles, Chebyshev) */
export const ALCH_RANGE = 100;
/** what a stint needs at least: natures, fire runes (without a staff of fire), things to alch */
const MIN_NATURES = 5;
const MIN_FIRE = 25;
const MIN_ITEMS = 3;

const schedules = new WeakMap<Player, { due: number }>();

/** Tests only (test/teleport.test.mjs): stints this many times as often. Never set by the game. */
let testRate = 1;
export function setAlchRateForTest(rate: number): void {
    testRate = rate;
}

function gapTicks(): number {
    return Math.round((ALCH_GAP_TICKS[0] + Math.random() * (ALCH_GAP_TICKS[1] - ALCH_GAP_TICKS[0])) / testRate);
}

/**
 * a levelling bot on the overworld, out of the Wilderness, free (no errand, no trade): one that may take a magic errand.
 * (variety round 1, F) `hangout`: a bank hang-out it stands in counts as free (its alching takes the hang-out's place)
 */
function freeForErrand(player: Player, hangout = false): boolean {
    if (!isLevelling(player.botPlanner as PlannerKey) || isNewbie(player)) return false;
    if (player.level !== 0 || player.z >= 6400 || wildernessLevelAt(player.x, player.z) > 0) return false;
    if (player.botTradeTargetPid !== -1 || player.botComeHereReturnX !== -1) return false;
    const ai = (player as unknown as { _bot?: { hasSubTask?: () => boolean; subTask?: { name?: string } | null } })._bot;
    return !ai?.hasSubTask?.() || (hangout && ai?.subTask?.name === 'Hangout');
}

/** a levelling bot with Magic 55+ on the overworld, free (no errand, no trade), with natures, fire and things to alch */
export function mayAlch(player: Player, hangout = false): boolean {
    if (!freeForErrand(player, hangout) || player.levels[PlayerStat.MAGIC] < HIGH_ALCH_LEVEL) return false;
    const { natures, staff, fire } = alchSupplies(player);
    if (natures < MIN_NATURES || (!staff && fire < MIN_FIRE)) return false;
    return alchableItems(player).reduce((sum, [, n]) => sum + n, 0) >= MIN_ITEMS;
}

/**
 * The trade bank for a stint: of this world's within ALCH_RANGE, one drawn by the bots there (port, the variety work,
 * round 1, track F: ISS-9: weight 1 + the bots within CENSUS_TILES of it, the nearer the likelier); the bots' own census,
 * never where the human is. The nearest before: alchers stood at quiet banks, and the human never met one (AL1 0).
 */
function tradeBankNear(player: Player): TradeBank | null {
    const options: [TradeBank, number][] = [];
    for (const b of usableBanks()) {
        const d = Math.max(Math.abs(b.center[0] - player.x), Math.abs(b.center[1] - player.z));
        if (b.center[2] !== 0 || d > ALCH_RANGE) continue;
        options.push([b, (1 + botsAt(b.center[0], b.center[1])) / (1 + d / 50)]);
    }
    if (options.length === 0) return null;
    let roll = Math.random() * options.reduce((sum, o) => sum + o[1], 0);
    for (const [b, w] of options) {
        roll -= w;
        if (roll <= 0) return b;
    }
    return options[options.length - 1][0];
}

/** (variety round 1, F) the bank census's radius */
const CENSUS_TILES = 15;

/** (variety round 1, F) the bots (never a human) within CENSUS_TILES of (x, z) on the ground floor */
function botsAt(x: number, z: number): number {
    let n = 0;
    for (const p of World.playerLoop.all()) if (p.is_bot === true && p.level === 0 && Math.max(Math.abs(p.x - x), Math.abs(p.z - z)) <= CENSUS_TILES) n++;
    return n;
}

/** (variety round 1, F) the trade bank the bot stands at (within 10 tiles of its spot), or null */
function tradeBankAt(player: Player): TradeBank | null {
    for (const b of usableBanks()) if (b.center[2] === player.level && Math.max(Math.abs(b.center[0] - player.x), Math.abs(b.center[1] - player.z)) <= 10) return b;
    return null;
}

// ── alching at a bank stop (port: the variety work, round 1, track F; ISS-9) ───────────────────────────────────

/** at a bank stop of its task (or in a bank hang-out), the chance an alcher alchs a while there; the least gap between two (play ticks) */
export const ALCH_STOP_CHANCE = 0.5;
export const ALCH_STOP_GAP = 1000;
/** such a stint's length (1.5-4 minutes) */
export const ALCH_STOP_TICKS: [number, number] = [150, 400];
const stopDue = new WeakMap<Player, number>();
/** (variety round 1, F) stints begun at bank stops, of them in place of a hang-out (tests, the report) */
export const alchStopStats = { stops: 0, hangouts: 0 };

/**
 * port (variety round 1, F: ISS-9): a bot with Magic 55+, natures and things to alch at a bank stop of its task (the
 * booth reached: BotTaskBase's hook) alchs a short while there now and then, a moment after (the stop's own pause begun:
 * its hang-out, when one began there, gives way to it), as 2004's bank alchers did between loads. Its task's errand at
 * the bank goes on after. Alchers were only ever at the banks once in 40-90 minutes, between plans: none was ever seen.
 */
export function alchAtBankStop(player: Player): void {
    if (player.levels[PlayerStat.MAGIC] < HIGH_ALCH_LEVEL) return;
    const now = World.currentTick;
    if (now < (stopDue.get(player) ?? 0)) return;
    scheduleInTicks(1, () => {
        if (player.slot === -1) return;
        const ai = (player as unknown as { _bot?: { subTask?: { name?: string } | null; setSubTask(t: BotTask): void } })._bot;
        if (!ai || !mayAlch(player, true)) return;
        const hangout = ai.subTask?.name === 'Hangout';
        if (!hangout && Math.random() >= Math.min(1, ALCH_STOP_CHANCE * testRate)) return;
        const at = World.currentTick;
        stopDue.set(player, at + ALCH_STOP_GAP);
        const bank: TradeBank = tradeBankAt(player) ?? { key: 'bank-stop', center: [player.x, player.z, player.level], stalls: [], vendorStalls: 0, weight: 0 };
        alchStopStats.stops++;
        if (hangout) alchStopStats.hangouts++;
        ai.setSubTask(new AlchTask(bank, at + ALCH_STOP_TICKS[0] + Math.floor(Math.random() * (ALCH_STOP_TICKS[1] - ALCH_STOP_TICKS[0] + 1))));
    });
}

setBankStopHook(alchAtBankStop);

/**
 * The planner's alch step (BotGoalPlanner step 1f, between plans): a stint of high alchemy at the trade bank near the
 * bot when one is due (every 40-90 minutes of play) and it can (mayAlch), else null. `previous`: the task it ends (never
 * two in a row).
 */
export function alchTaskFor(player: Player, previous: string | null): BotTask | null {
    const trip = lawTripFor(player, previous);
    if (trip) return trip;
    if (previous === ALCH_KIND) return null;
    const now = World.currentTick;
    let s = schedules.get(player);
    if (!s) {
        // (the first comes anywhere in a gap: a login's chances are the hour's)
        s = { due: now + Math.round(gapTicks() * (0.05 + 0.95 * Math.random())) };
        schedules.set(player, s);
    }
    if (now < s.due || !mayAlch(player)) return null;
    const bank = tradeBankNear(player);
    if (!bank) {
        s.due = now + 600;
        return null;
    }
    s.due = now + gapTicks();
    return new AlchTask(bank, now + ALCH_STINT_TICKS[0] + Math.floor(Math.random() * (ALCH_STINT_TICKS[1] - ALCH_STINT_TICKS[0] + 1)));
}

// ── law runs (tasks/LawTripTask) ─────────────────────────────────────────────

/** a law run at most this often (play ticks: 3-6 hours), from this Magic level (the guild's doors), with these coins */
export const LAW_TRIP_GAP_TICKS: [number, number] = [18000, 36000];
export const LAW_TRIP_MAGIC = 66;
const LAW_TRIP_COINS = 6000;
const lawSchedules = new WeakMap<Player, { due: number }>();

/** Tests only: law runs this many times as often (and the first one due at once). Never set by the game. */
let lawRate = 1;
export function setLawTripRateForTest(rate: number): void {
    lawRate = rate;
}

/**
 * The magic step's law run: a teleporter of Magic 66+ on a members world, out of laws (fewer than LAWS_KEPT + 2 in
 * its pack and bank), with coins to spare, free for an errand; at most one every 3-6 hours of play. Else null.
 */
export function lawTripFor(player: Player, previous: string | null): BotTask | null {
    if (previous === 'LawTrip' || !isMembersWorld() || player.levels[PlayerStat.MAGIC] < LAW_TRIP_MAGIC) return null;
    if (!isTeleporter(player.username) || lawsOwned(player) >= LAWS_KEPT + 2 || coinsOwned(player) < LAW_TRIP_COINS || !freeForErrand(player)) return null;
    const now = World.currentTick;
    const gap = (): number => Math.round((LAW_TRIP_GAP_TICKS[0] + Math.random() * (LAW_TRIP_GAP_TICKS[1] - LAW_TRIP_GAP_TICKS[0])) / lawRate);
    let s = lawSchedules.get(player);
    if (!s) {
        s = { due: lawRate > 1 ? now : now + Math.round(gap() * Math.random() * 0.5) };
        lawSchedules.set(player, s);
    }
    if (now < s.due) return null;
    s.due = now + gap();
    return new LawTripTask(LAWS_BOUGHT[0] + Math.floor(Math.random() * (LAWS_BOUGHT[1] - LAWS_BOUGHT[0] + 1)));
}

// ── the spells' talk (port/BotTeleport loads nothing of the chatter's: it would load the tasks before BotAction) ─────

/** One of `pool` (not said lately), typed in its persona's style, counted as one of its persona's lines. */
export function sayMagicLine(player: Player, pool: readonly string[]): boolean {
    const now = World.currentTick;
    for (let attempt = 0; attempt < 3; attempt++) {
        const text = pool[Math.floor(Math.random() * pool.length)];
        if (!isFresh(player.username, text, player.x, player.z, player.level, now)) continue;
        const styled = styleLine(text, personaOf(player.username, (player.botPlanner as PlannerKey) ?? null)).line;
        countAsBudgetedLine(player);
        botSay(player, styled, undefined, 'event');
        noteSaid(player, styled, now);
        noteSpoke(player, 'event', now);
        return true;
    }
    return false;
}

setTeleportTalk({ event: (player, name) => noteEvent(player, name), say: sayMagicLine });
