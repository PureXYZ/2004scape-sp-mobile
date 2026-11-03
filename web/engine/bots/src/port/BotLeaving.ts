// port (bots ideas, round 2, theme C: lives with arcs, C3):
// a bot leaving the game for a reason a player had, through the logout button as any session's end (BotManager.leaveSoon).
//
//   rage-quit   tilt 0.75+ (port/BotMoods' roll): a rage line 80 % of the time ("im done", "rage quit lol"; kind
//               'departure'), then out within 10-40 s with no wrap-up and no goodbye (leaveSoon's `abrupt`); its normal
//               absence follows
//   hop         a levelling gatherer (woodcutting, mining, fishing) with 5+ other bots at its task kind within 4 tiles for
//               2+ minutes, waiting (no tree or rock in hand): 0.2 x (1.6 - patience) a minute, at most once a bot in 3 hours
//               of play: "w8 hopping" 70 % of the time, out within 5-15 s, away 5-20 minutes (a hop and back: the app runs
//               one world), and it logs in where it left
//   big drop    a pick-up worth 50k+ (port/BotMoods' roll, 0.3): "gtg bank this lol", the bank (its pack but its coins),
//               then its session ends within 1-3 minutes with an ordinary goodbye
// Never a newbie (P1), a friend of the human (it stays online for them), a bot in a trade, a "come here", a set piece, a
// random event or with the human's items to bank (BotManager.mayLeaveAbruptly). A line the bot owes the human
// (BotChat.owesHumanReply: one heard and not read yet, a reply it types, a model's words it waits for, a line kept for
// its return from a break) is said first: its logout waits for it, BotChat.OWED_REPLY_MOST from the reply's start at most
// (43 s: the model's deadline and the typing in it), a kept line till the bot is back; BotManager._endSession looks again
// before the abrupt goodbye goes (never ignored; the review's C-1). A bot away or owing a reply does not hop. The
// engine's combat lock holds as for any player (logout.rs2). The pool fills the place as for any logout.
// The log (leaveLog): each leave, its reason, its line, when it went (the humanlike runner's AR6, AR7; the tests).
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { BotManager, mayLeaveAbruptly } from '#/engine/bot/BotManager.js';
import { Items } from '#/engine/bot/BotKnowledge.js';
import { BankTask } from '#/engine/bot/tasks/UtilTasks.js';
import { arcsPlay, onArcs, registerArcsTick } from '#/engine/bot/port/BotArcsEvents.js';
import { arcLines, sayArcLine } from '#/engine/bot/port/BotArcsSay.js';
import { BotChat, OWED_REPLY_MOST } from '#/engine/bot/port/BotChat.js';
import { isAway } from '#/engine/bot/port/BotHabits.js';
import { taskKind } from '#/engine/bot/port/BotLines.js';
import { LIVES_CTL, noteLivesLine } from '#/engine/bot/port/BotLives.js';
import { moodActions, sensitivityOf } from '#/engine/bot/port/BotMoods.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';

// ── the defaults ───────────────────────────────────────────────────────────────────────────────────

export const LEAVE = {
    rageLine: 0.8,
    rageOut: [17, 67] as [number, number],
    hopLine: 0.7,
    hopOut: [9, 25] as [number, number],
    hopAway: [500, 2000] as [number, number],
    hopCrowd: 5,
    hopRange: 4,
    hopCrowdTicks: 200,
    hopRoll: 0.2,
    hopGap: 18_000,
    bigDrop: 0.3,
    bigDropOut: [60, 200] as [number, number]
};
const GATHERING = new Set(['Woodcut', 'Mine', 'Fish']);
const COINS = Items.COINS;

export type LeaveReason = 'rage' | 'hop' | 'bank-drop';

export interface LeaveEntry {
    t: number;
    name: string;
    planner: string;
    reason: LeaveReason;
    line: string | null;
    /** the world tick the leave was asked of BotManager (-1: not yet), the bot logged out (-1: not yet) */
    asked: number;
    logout: number;
    /** given up: a hold came up meanwhile (a trade, a set piece ...) */
    held?: boolean;
    x: number;
    z: number;
}
const LOG_MAX = 2000;
export const leaveLog: LeaveEntry[] = [];
export const leaveStats = { rage: 0, hop: 0, bankDrop: 0, waitedForReply: 0, held: 0, hopChecks: 0, crowded: 0 };

interface Pending {
    bot: Player;
    entry: LeaveEntry;
    leaveAt: number;
    away: [number, number] | null;
    bank: BankTask | null;
    issued: boolean;
    /** the pass that first saw it owe the human a reply (-1: it owes none) */
    owedSince: number;
}
const pending = new Map<Player, Pending>();
const lastHop = new Map<string, number>();
const crowdedSince = new WeakMap<Player, number>();
const rand = ([lo, hi]: readonly [number, number]): number => lo + Math.floor(Math.random() * (hi - lo + 1));

// ── who may ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** a friend of the human stays online for them (BotManager's start option, as the quits read it) */
function friendOfHuman(name: string): boolean {
    const options = (BotManager as unknown as { options?: { isFriendOfHuman?(n: string): boolean } | null }).options;
    try {
        return options?.isFriendOfHuman?.(name) === true;
    } catch {
        return false;
    }
}

/** may the bot leave for a reason now (above) */
export function mayLeaveForReason(bot: Player): boolean {
    if (pending.has(bot) || !mayLeaveAbruptly(bot) || isNewbie(bot) || friendOfHuman(bot.username)) return false;
    return BotManager.isActiveBot(bot.username);
}

function begin(bot: Player, reason: LeaveReason, line: string | null, leaveAt: number, away: [number, number] | null, bank: BankTask | null): void {
    const entry: LeaveEntry = { t: World.currentTick, name: bot.username, planner: bot.botPlanner ?? '', reason, line, asked: -1, logout: -1, x: bot.x, z: bot.z };
    leaveLog.push(entry);
    if (leaveLog.length > LOG_MAX) leaveLog.splice(0, leaveLog.length - LOG_MAX);
    pending.set(bot, { bot, entry, leaveAt, away, bank, issued: false, owedSince: -1 });
}

function sayLeaveLine(bot: Player, kind: 'rage' | 'hop' | 'bank-drop', lineKind: 'departure' | 'event'): string | null {
    const said = sayArcLine(bot, arcLines('arcs-leave', kind), {}, { kind: lineKind, budget: 'own', spoke: 'idle', delay: 2, arc: { kind: `leave-${kind}` } });
    if (said) noteLivesLine(bot, 'arcs-leave', kind, said);
    return said;
}

// ── the three ────────────────────────────────────────────────────────────────────────────────────────────────────

/** a rage-quit (port/BotMoods at tilt 0.75+): true when it is under way */
export function rageQuit(bot: Player): boolean {
    if (!mayLeaveForReason(bot)) return false;
    const line = Math.random() < LEAVE.rageLine ? sayLeaveLine(bot, 'rage', 'departure') : null;
    leaveStats.rage++;
    begin(bot, 'rage', line, World.currentTick + rand(LEAVE.rageOut), null, null);
    return true;
}

/** a hop from a crowded spot: true when it is under way */
export function hop(bot: Player): boolean {
    if (!mayLeaveForReason(bot)) return false;
    const line = Math.random() < LEAVE.hopLine ? sayLeaveLine(bot, 'hop', 'departure') : null;
    leaveStats.hop++;
    lastHop.set(bot.username, arcsPlay());
    begin(bot, 'hop', line, World.currentTick + rand(LEAVE.hopOut), LEAVE.hopAway, null);
    return true;
}

/** a drop worth 50k+ (port/BotMoods): banked, then the session ends (0.3): true when it is under way */
export function bankBigDrop(bot: Player, _value: number): boolean {
    if (Math.random() >= LEAVE.bigDrop * bigDropScale || !mayLeaveForReason(bot)) return false;
    const ai = BotManager.botFor(bot);
    if (!ai || ai.hasSubTask()) return false;
    const line = sayLeaveLine(bot, 'bank-drop', 'event');
    const bank = new BankTask([COINS]);
    ai.setSubTask(bank);
    leaveStats.bankDrop++;
    begin(bot, 'bank-drop', line, World.currentTick, null, bank);
    return true;
}
moodActions.rage = rageQuit;
moodActions.bigDrop = bankBigDrop;

// ── the passes ───────────────────────────────────────────────────────────────────────────────────────────────────

/** every 5 ticks: the leaves under way go when it is time (an owed reply first: OWED_REPLY_MOST from its start at most) */
registerArcsTick(() => {
    if (!LIVES_CTL.on) return;
    const now = World.currentTick;
    for (const p of [...pending.values()]) {
        const bot = p.bot;
        if (p.issued) continue;
        if (bot.slot === -1 || !BotManager.isActiveBot(bot.username)) {
            pending.delete(bot);
            continue;
        }
        if (p.bank) {
            const ai = BotManager.botFor(bot);
            const done = p.bank.isComplete(bot) || !ai?.hasSubTask();
            if (!done && now - p.entry.t < 1500) continue;
            p.issued = true;
            p.entry.asked = now;
            BotManager.leaveSoon(bot.username, rand(LEAVE.bigDropOut));
            continue;
        }
        // (a reply it owes the human: said first, OWED_REPLY_MOST from its start at most (watched before the leave's time
        // too, so a reply begun earlier counts from then); a line kept for its break's end: till it is back, its reply
        // counted from then)
        const owes = BotChat.owesHumanReply(bot);
        const away = owes && isAway(bot);
        if (!owes || away) p.owedSince = -1;
        else if (p.owedSince < 0) p.owedSince = now;
        if (now < p.leaveAt) continue;
        if (away || (owes && now - p.owedSince < OWED_REPLY_MOST)) {
            leaveStats.waitedForReply++;
            continue;
        }
        // (a line it is typing said first: its leave line ("w8 hopping", typed slower than hopOut at times) or a word it
        // began to a bot; OWED_REPLY_MOST past its time at most: owesHumanReply counts only the human's replies)
        if (BotChat.midTalk(bot) && now - p.leaveAt < OWED_REPLY_MOST) continue;
        if (!mayLeaveAbruptly(bot)) {
            p.entry.held = true;
            leaveStats.held++;
            pending.delete(bot);
            continue;
        }
        p.issued = true;
        p.entry.asked = now;
        BotManager.leaveSoon(bot.username, 1, { abrupt: true, ...(p.away ? { away: p.away } : {}) });
    }
}, 5);

onArcs('logout', e => {
    if (!LIVES_CTL.on) return;
    if (!e.bot) return;
    const p = pending.get(e.bot);
    if (!p) return;
    p.entry.logout = World.currentTick;
    pending.delete(e.bot);
});

/** every minute: the crowded gatherers (5+ other bots at their task kind within 4 tiles for 2 minutes, waiting) may hop */
registerArcsTick(() => {
    if (!LIVES_CTL.on) return;
    const now = World.currentTick;
    const play = arcsPlay();
    const gatherers: Player[] = [];
    const kinds = new Map<Player, string>();
    for (const p of BotManager.activeBots()) {
        const kind = taskKind(BotManager.botFor(p)?.currentTask?.name);
        if (!GATHERING.has(kind)) continue;
        gatherers.push(p);
        kinds.set(p, kind);
    }
    // (by 8-tile buckets: the others within 4 tiles are in a bucket next to it)
    const buckets = new Map<string, Player[]>();
    const keyOf = (x: number, z: number, level: number): string => `${x >> 3}_${z >> 3}_${level}`;
    for (const p of gatherers) {
        const k = keyOf(p.x, p.z, p.level);
        let b = buckets.get(k);
        if (!b) buckets.set(k, (b = []));
        b.push(p);
    }
    for (const p of gatherers) {
        if (!isLevelling(p.botPlanner as PlannerKey) || pending.has(p)) continue;
        // (a bot on its break, or owing the human a reply (a line kept for its return among them), does not hop)
        if (isAway(p) || BotChat.owesHumanReply(p)) continue;
        leaveStats.hopChecks++;
        const kind = kinds.get(p)!;
        let others = 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                for (const q of buckets.get(`${(p.x >> 3) + dx}_${(p.z >> 3) + dz}_${p.level}`) ?? []) {
                    if (q !== p && kinds.get(q) === kind && Math.abs(q.x - p.x) <= LEAVE.hopRange && Math.abs(q.z - p.z) <= LEAVE.hopRange) others++;
                }
            }
        }
        if (others < LEAVE.hopCrowd) {
            crowdedSince.delete(p);
            continue;
        }
        leaveStats.crowded++;
        const since = crowdedSince.get(p);
        if (since === undefined) {
            crowdedSince.set(p, now);
            continue;
        }
        if (now - since < LEAVE.hopCrowdTicks) continue;
        // (waiting: no tree or rock in hand)
        if (p.target !== null) continue;
        const last = lastHop.get(p.username);
        if (last !== undefined && play - last < LEAVE.hopGap) continue;
        if (Math.random() >= LEAVE.hopRoll * hopScale * Math.max(0, 1.6 - sensitivityOf(p).patience)) continue;
        hop(p);
    }
}, 100);

// ── the runner and the tests ─────────────────────────────────────────────────────────────────────────────────────

/** the leaves under way (the tests) */
export function leavingNow(bot: Player): LeaveEntry | null {
    return pending.get(bot)?.entry ?? null;
}
let hopScale = 1;
let bigDropScale = 1;
/** (tests) the hop's roll and the big drop's x these (0: none; null: as the game) */
export function setLeaveRatesForTest(rates: { hop?: number | null; bigDrop?: number | null }): void {
    if (rates.hop !== undefined) hopScale = rates.hop ?? 1;
    if (rates.bigDrop !== undefined) bigDropScale = rates.bigDrop ?? 1;
}
/** (tests) forget the leaves under way and the 3-hour hop gap */
export function resetLeavingForTest(): void {
    pending.clear();
    lastHop.clear();
    leaveLog.length = 0;
}
