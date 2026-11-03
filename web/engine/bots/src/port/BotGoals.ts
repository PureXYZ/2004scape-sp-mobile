// port (bots ideas, round 2, theme C: lives with arcs, C1):
// a levelling bot's saved goal, drawn from its real state, that its planner leans toward, that it answers "whats ur goal"
// with, celebrates when it is done (in the place of its level-up line), and changes or drops as people did.
//
// Who: levelling bots (skiller, fighter, balanced, random) out of newbie time. No goal for PKers (their levels are their
// build's), vendors or social regulars (their slot answers stay, port/BotThreads Side.goal), newbies.
// What (at its first pick of a session with none, by kind; the mix by planner, skiller / fighter / balanced and random):
//   L a level   the next unlock 5-25 levels up in a skill it trains (port/BotSlots nextUnlock: "60 wc for yews", "40 att
//               for rune"), else the next tenth 5-25 up ("70 str"); any trained skill at 95+: 99 ("99 fishing")  60/35/45 %
//   G gear      the piece its gear upgrades would buy with unlimited coins (port/BotGear nextGearUpgrade: "rune legs",
//               "addy plate", "rune long"), only one that costs 1k+ and more than it has: what it saves for   15/40/25 %
//   M money     the least of 25k/50k/100k/250k/500k/1m above twice its coins, with 5k+ ("100k", "1m")         20/10/20 %
//   C combat    the next tenth of its combat level at least 3 up ("cb 70")                                     0/15/10 %
//   T total     the next of 500/750/1000/1250 within 60 levels ("1000 total")                                  5/0/0 %
//   A kind it cannot have now (no 5k for money, nothing to save for) is a level goal. No quest goal (bots have every
//   quest), no d long (Zanaris), no full rune (no shop sells the helm), no skillcape (none in 274).
// Done: L, C and T at the level-up that reaches it (the celebration below); G when it owns the piece (worn, pack or
// bank), M when its coins (pack and bank) reach it: both checked every 5 minutes or so (staggered) and at its picks. A G
// goal met another way (a better piece by a drop, or bought by the upgrade path first) changes. The next goal comes 5-30
// minutes of play later.
// Dropped: a goal held 4 hours of the bot's online play (its record's `flags`: the online minutes held) with under a
// tenth of the way made is dropped half the time at its next login; said only when asked ("gave up on that lol").
//
// The lean (the planner's "C arcs" block, port/BotLivesIndex): GOAL_LEAN of its picks the goal's skill first (0.6 for a
// 99); a combat goal its lowest melee stat; a fighter's gear or money goal combat first at 0.25; a skiller's gear or
// money goal its bankstand session 25 % sooner; a gear goal come into reach is bought by the upgrade path (a shop trip).
// The celebration: a goal done at a level-up takes the level-up line's place 80 % of the time with company within 15
// tiles, 30 % alone (port/BotChatter's pending line, the line in the place of the bot's next due line: H7 stays), and
// the bots near may gz it as a level-up; a G or M goal's line the next calm moment, at the same odds, in the place of
// its next due line; a cheer 30 % of the time (an everyday emote). 'goal-done' on the bus (moods: elation; theme D).
// The answer: a question about the bot's goal (port/BotAnswers' "C arcs" block) gets it with its progress ("3 lvls to go
// for 60 wc", "saving for rune legs", "20k to go for rune legs"); upstream's "What are you going for?" stays for the rest.
// The endgame (round 1's hook, port/BotEndgameCore endgameOfferScale): a bosser whose goal points at the endgame (combat
// 90+, a combat skill to 80+ or 99, 250k+ coins) takes an endgame trip 1.5 times as often.
//
// Bots only: a record is a pool bot's (port/BotArcsStore); a goal is never about the human. The dice are the library's
// (Math.random, seeded in the sims); no clock but the play ticks.
import ObjType from '#/cache/config/ObjType.js';
import type Player from '#/engine/entity/Player.js';
import { getExpByLevel } from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { coinsOwned } from '#/engine/bot/BotNeeds.js';
import { SCIMITAR_TIERS } from '#/engine/bot/tasks/CombatTask.js';
import { ShopTripTask } from '#/engine/bot/tasks/ShopTripTask.js';
import type { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';
import { arcsOf, peekArcs, type GoalKind, type GoalRecord } from '#/engine/bot/port/BotArcsStore.js';
import { arcsPlay, emitArcs, onArcs, registerArcsTick } from '#/engine/bot/port/BotArcsEvents.js';
import { arcLines, fillArcSlots, sayArcLine, type ArcSlots } from '#/engine/bot/port/BotArcsSay.js';
import { BotChat } from '#/engine/bot/port/BotChat.js';
import { calm, countAsOwnLine } from '#/engine/bot/port/BotChatter.js';
import { everydayEmote } from '#/engine/bot/port/BotEmote.js';
import { favouritesOf } from '#/engine/bot/port/BotFavourites.js';
import { nextGearUpgrade, whereOwned } from '#/engine/bot/port/BotGear.js';
import { LIVES, LIVES_CTL, noteLivesLine, type LivesPending } from '#/engine/bot/port/BotLives.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { worldPlayers } from '#/engine/bot/port/BotPlayers.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { hashString } from '#/engine/bot/port/BotSeed.js';
import { itemSay, nextUnlock } from '#/engine/bot/port/BotSlots.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';

// ── the defaults ───────────────────────────────────────────────────────────────────────────────────

/** the goal kinds' mix by planner: L, G, M, C, T */
const MIX: Readonly<Record<string, readonly [number, number, number, number, number]>> = {
    skiller: [0.6, 0.15, 0.2, 0, 0.05],
    fighter: [0.35, 0.4, 0.1, 0.15, 0],
    balanced: [0.45, 0.25, 0.2, 0.1, 0],
    random: [0.45, 0.25, 0.2, 0.1, 0]
};
const KINDS: readonly GoalKind[] = ['L', 'G', 'M', 'C', 'T'];
/** of the planner's picks, the goal's skill first */
export const GOAL_LEAN = 0.35;
export const GOAL_LEAN_99 = 0.6;
/** a fighter's gear or money goal: combat first */
export const GOAL_LEAN_EARN = 0.25;
/** the celebration's odds: with company within 15 tiles, alone */
export const CELEBRATE = { company: 0.8, alone: 0.3 };
export const CHEER_CHANCE = 0.3;
/** the next goal this long (play ticks) after one is done: 5-30 minutes */
const NEXT_GOAL_TICKS: readonly [number, number] = [500, 3000];
/** dropped: held this many minutes of its online play with under DROP_PROGRESS of the way made, half the time */
const DROP_MINUTES = 240;
const DROP_PROGRESS = 0.1;
const DROP_CHANCE = 0.5;
/** a gear goal's piece costs at least this (no "saving for a cape") */
const GEAR_MIN = 1000;
/** the money targets (thousands) */
const MONEY_STEPS = [25, 50, 100, 250, 500, 1000];
const MONEY_MIN = 5000;
const TOTAL_STEPS = [500, 750, 1000, 1250];
/** G and M checks: each bot about every CHECK_EVERY play ticks (staggered by name) */
const CHECK_EVERY = 500;
const CHECK_TICK = 25;
/** a G or M celebration waits for a calm moment this long at most */
const SAY_WAIT = 1200;

/** the skills a goal may be in: the planner's name, the stat, the short word players used, the unlock list's key */
const SKILLS: Readonly<Record<string, { stat: number; short: string; unlock: string | null; members?: boolean }>> = {
    ATTACK: { stat: PlayerStat.ATTACK, short: 'att', unlock: 'att' },
    STRENGTH: { stat: PlayerStat.STRENGTH, short: 'str', unlock: null },
    DEFENCE: { stat: PlayerStat.DEFENCE, short: 'def', unlock: 'def' },
    RANGED: { stat: PlayerStat.RANGED, short: 'range', unlock: 'range' },
    PRAYER: { stat: PlayerStat.PRAYER, short: 'pray', unlock: 'prayer' },
    MAGIC: { stat: PlayerStat.MAGIC, short: 'mage', unlock: 'mage' },
    COOKING: { stat: PlayerStat.COOKING, short: 'cooking', unlock: 'cooking' },
    WOODCUTTING: { stat: PlayerStat.WOODCUTTING, short: 'wc', unlock: 'wc' },
    FLETCHING: { stat: PlayerStat.FLETCHING, short: 'fletching', unlock: 'fletching', members: true },
    FISHING: { stat: PlayerStat.FISHING, short: 'fishing', unlock: 'fishing' },
    FIREMAKING: { stat: PlayerStat.FIREMAKING, short: 'fm', unlock: 'fm' },
    CRAFTING: { stat: PlayerStat.CRAFTING, short: 'crafting', unlock: 'crafting' },
    SMITHING: { stat: PlayerStat.SMITHING, short: 'smithing', unlock: 'smithing' },
    MINING: { stat: PlayerStat.MINING, short: 'mining', unlock: 'mining' },
    HERBLORE: { stat: PlayerStat.HERBLORE, short: 'herb', unlock: null, members: true },
    AGILITY: { stat: PlayerStat.AGILITY, short: 'agility', unlock: null, members: true },
    THIEVING: { stat: PlayerStat.THIEVING, short: 'thieving', unlock: 'thieving', members: true },
    RUNECRAFT: { stat: PlayerStat.RUNECRAFT, short: 'rc', unlock: 'rc' }
};
/**
 * how readily a skill is trained when the planner leans to it (a level goal's draw weighs the planner's weight by this):
 * the gathering skills and the fights at once; cooking, smithing, firemaking and fletching from what a feeder skill brings
 * (the lean puts the feeder second: GOAL_FEEDER); runecrafting (a talisman), prayer (bones), agility (a course far off) and
 * magic (a staff and runes, 5k) seldom. A 2004 player's goal was in a skill it could work on.
 */
const TRAINABLE: Readonly<Record<string, number>> = { COOKING: 0.5, SMITHING: 0.5, FIREMAKING: 0.4, FLETCHING: 0.7, CRAFTING: 0.6, RUNECRAFT: 0.15, PRAYER: 0.15, AGILITY: 0.2, MAGIC: 0.25, HERBLORE: 0.4 };
/** the skill that brings a goal skill its materials (the theme's feeder, port/BotGoalPlanner THEME_FEEDER, and the logs) */
const GOAL_FEEDER: Readonly<Record<string, string>> = { COOKING: 'FISHING', SMITHING: 'MINING', FIREMAKING: 'WOODCUTTING', FLETCHING: 'WOODCUTTING' };
const SKILL_OF_STAT = new Map<number, string>(Object.entries(SKILLS).map(([name, s]) => [s.stat, name]));
const MELEE = ['ATTACK', 'STRENGTH', 'DEFENCE'] as const;
const COMBAT_STATS: ReadonlySet<number> = new Set([PlayerStat.ATTACK, PlayerStat.STRENGTH, PlayerStat.DEFENCE, PlayerStat.HITPOINTS, PlayerStat.RANGED, PlayerStat.MAGIC, PlayerStat.PRAYER]);
const XP_99 = getExpByLevel(99);

// ── the log (the humanlike runner's AR metrics, the tests) ────────────────────────────────────────────────────────

export interface GoalLogEntry {
    t: number;
    name: string;
    planner: string;
    ev: 'set' | 'done' | 'dropped' | 'changed' | 'asked';
    kind: GoalKind;
    words: string;
    stat?: number;
    target: number;
    /** done: players within 15 tiles; the celebration said (its tick) */
    company?: number;
    said?: number;
    /** done: its celebration went to the bots near for a gz (the level-up's own line) */
    gz?: boolean;
    /** asked: the answer given */
    answer?: string;
}
const LOG_MAX = 4000;
export const goalLog: GoalLogEntry[] = [];
function log(e: GoalLogEntry): GoalLogEntry {
    goalLog.push(e);
    if (goalLog.length > LOG_MAX) goalLog.splice(0, goalLog.length - LOG_MAX);
    return e;
}
export const goalStats = { set: 0, done: 0, dropped: 0, changed: 0, celebrated: 0, bought: 0 };

// ── the session's memory (a Player is a session's) ────────────────────────────────────────────────────────────────

interface Mem {
    /** the play tick a new goal may be set (after one is done) */
    nextAt: number;
    /** the play tick of its login (the online minutes a goal holds) */
    loginPlay: number;
    /** a goal it dropped or changed this session: its words, for "gave up on that lol" when asked */
    dropped: string | null;
    /** a level-up's celebration for the chatter (BotChatter's pending line), its tick */
    done: { goal: GoalRecord; tick: number; entry: GoalLogEntry } | null;
    /** a G or M goal's line, said at a calm moment */
    sayDone: { goal: GoalRecord; until: number; entry: GoalLogEntry } | null;
}
const mems = new WeakMap<Player, Mem>();
function memOf(p: Player): Mem {
    let m = mems.get(p);
    if (!m) mems.set(p, (m = { nextAt: 0, loginPlay: arcsPlay(), dropped: null, done: null, sayDone: null }));
    return m;
}

// ── who, and what ────────────────────────────────────────────────────────────────────────────────────────────────

/** a bot that keeps a goal: a levelling bot out of newbie time */
export function keepsGoal(p: Player): boolean {
    return p.is_bot === true && isLevelling(p.botPlanner as PlannerKey) && !isNewbie(p);
}

/** its goal now (a levelling bot's), or null */
export function goalOf(p: Player): GoalRecord | null {
    if (!keepsGoal(p)) return null;
    return peekArcs(p.username)?.goal ?? null;
}

function weightsOf(p: Player): Readonly<Partial<Record<string, number>>> {
    return BotManager.botFor(p)?.planner.personality.weights ?? {};
}

function levelOf(p: Player, skill: string): number {
    return p.baseLevels[SKILLS[skill].stat] ?? 1;
}

function totalOf(p: Player): number {
    let sum = 0;
    for (let stat = 0; stat < p.baseLevels.length; stat++) if (stat !== 18 && stat !== 19) sum += p.baseLevels[stat];
    return sum;
}

function combatOf(p: Player): number {
    try {
        return Math.max(p.combatLevel, p.getCombatLevel());
    } catch {
        return p.combatLevel;
    }
}

/** the planner's skills this bot trains that a goal may be in (members' skills on a members world) */
function trainedSkills(p: Player, weights: Readonly<Partial<Record<string, number>>>): string[] {
    const members = isMembersWorld();
    return Object.keys(SKILLS).filter(s => (weights[s] ?? 0) > 0 && (members || !SKILLS[s].members));
}

/** a level target for a skill at `level`: the next unlocks 5-25 up and the tenths 5-25 up, the nearest likelier; 99 from 95 */
function levelTarget(skill: string, level: number, random: () => number): number | null {
    if (level >= 99) return null;
    if (level >= 95) return 99;
    const info = SKILLS[skill];
    const members = isMembersWorld();
    const opts = new Set<number>();
    if (info.unlock) {
        let u = nextUnlock(info.unlock, level, members);
        while (u && u.next <= level + 25) {
            if (u.next >= level + 5) opts.add(u.next);
            u = nextUnlock(info.unlock, u.next, members);
        }
    }
    for (let t = 10; t <= 90; t += 10) if (t >= level + 5 && t <= level + 25) opts.add(t);
    const list = [...opts].sort((a, b) => a - b);
    if (!list.length) return null;
    // (the nearest likelier: weights 3, 2, 1, 1 ...)
    const w = list.map((_, i) => Math.max(1, 3 - i));
    let x = random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < list.length; i++) if ((x -= w[i]) < 0) return list[i];
    return list[list.length - 1];
}

function levelGoal(p: Player, weights: Readonly<Partial<Record<string, number>>>, random: () => number): GoalRecord | null {
    const skills = trainedSkills(p, weights).filter(s => levelOf(p, s) < 99);
    if (!skills.length) return null;
    const make = (skill: string, target: number): GoalRecord => ({ kind: 'L', stat: SKILLS[skill].stat, target, since: arcsPlay(), base: Math.floor(p.stats[SKILLS[skill].stat] / 10) });
    // any trained skill at 95+: 99
    const high = skills.filter(s => levelOf(p, s) >= 95);
    if (high.length) {
        const s = high[Math.floor(random() * high.length)];
        return make(s, 99);
    }
    // its favourites first (most of the time), else by the planner's weights
    const favs = favouritesOf(p.username, weights).filter(s => skills.includes(s));
    const order: string[] = [];
    if (favs.length && random() < 0.6) order.push(favs[Math.floor(random() * favs.length)]);
    const pool = skills.filter(s => !order.includes(s));
    const w = (s: string): number => (weights[s] ?? 0) * (TRAINABLE[s] ?? 1);
    for (let i = 0; i < 4 && pool.length; i++) {
        let x = random() * pool.reduce((a, s) => a + w(s), 0);
        let k = pool.length - 1;
        for (let j = 0; j < pool.length; j++) if ((x -= w(pool[j])) < 0) {
            k = j;
            break;
        }
        order.push(...pool.splice(k, 1));
    }
    for (const s of order) {
        const target = levelTarget(s, levelOf(p, s), random);
        if (target !== null) return make(s, target);
    }
    return null;
}

/** what its gear upgrades would buy with unlimited coins, when that costs 1k+ and more than it has: its id and cost */
export function gearWanted(p: Player): { itemId: number; cost: number } | null {
    let want = null;
    try {
        want = nextGearUpgrade(p, SCIMITAR_TIERS, Infinity);
    } catch {
        return null;
    }
    if (!want || want.cost < GEAR_MIN) return null;
    return { itemId: want.itemId, cost: want.cost };
}

function gearGoal(p: Player): GoalRecord | null {
    const want = gearWanted(p);
    const coins = coinsOwned(p);
    if (!want || want.cost + 100 <= coins) return null;
    if (itemWords(want.itemId) === null) return null;
    return { kind: 'G', target: want.itemId, since: arcsPlay(), base: coins };
}

function moneyGoal(p: Player): GoalRecord | null {
    const coins = coinsOwned(p);
    if (coins < MONEY_MIN) return null;
    const k = MONEY_STEPS.find(t => t * 1000 > coins * 2);
    return k === undefined ? null : { kind: 'M', target: k, since: arcsPlay(), base: coins };
}

function combatGoal(p: Player): GoalRecord | null {
    const cb = combatOf(p);
    const target = Math.ceil((cb + 3) / 10) * 10;
    return target > 126 ? null : { kind: 'C', target: Math.min(target, 126), since: arcsPlay(), base: cb };
}

function totalGoal(p: Player): GoalRecord | null {
    const total = totalOf(p);
    const t = TOTAL_STEPS.find(x => x > total && x - total <= 60);
    return t === undefined ? null : { kind: 'T', target: t, since: arcsPlay(), base: total };
}

/** A new goal for the bot (its kind by its planner's mix; a kind it cannot have now: a level goal), or null. */
export function drawGoal(p: Player, random: () => number = Math.random): GoalRecord | null {
    const mix = MIX[p.botPlanner ?? ''] ?? MIX.balanced;
    let x = random();
    let kind: GoalKind = 'L';
    for (let i = 0; i < KINDS.length; i++) if ((x -= mix[i]) < 0) {
        kind = KINDS[i];
        break;
    }
    const weights = weightsOf(p);
    const goal = kind === 'G' ? gearGoal(p) : kind === 'M' ? moneyGoal(p) : kind === 'C' ? combatGoal(p) : kind === 'T' ? totalGoal(p) : null;
    return goal ?? levelGoal(p, weights, random);
}

// ── words, progress ──────────────────────────────────────────────────────────────────────────────────────────────

function itemWords(id: number): string | null {
    const name = ObjType.get(id)?.name ?? '';
    // (a "2h" before the next word reads as a word the 274 filter stars: "rune 2h at last"; "rune 2h sword" is whole)
    return itemSay(name)?.replace(/\b2h$/, '2h sword') ?? null;
}

/** a goal as players said it: "60 wc", "99 fishing", "rune legs", "100k", "cb 70", "1000 total" (`unlock`: "60 wc for yews") */
export function goalWords(goal: GoalRecord, unlock = false): string {
    switch (goal.kind) {
        case 'L': {
            const skill = SKILL_OF_STAT.get(goal.stat ?? -1);
            const info = skill ? SKILLS[skill] : null;
            if (!info) return `${goal.target}`;
            if (goal.target >= 99) return `99 ${info.short}`;
            if (unlock && info.unlock) {
                const u = nextUnlock(info.unlock, goal.target - 1, isMembersWorld());
                if (u && u.next === goal.target) return `${goal.target} ${info.short} for ${u.unlock}`;
            }
            return `${goal.target} ${info.short}`;
        }
        case 'G':
            return itemWords(goal.target) ?? 'new gear';
        case 'M':
            return goal.target >= 1000 ? `${goal.target / 1000}m` : `${goal.target}k`;
        case 'C':
            return `cb ${goal.target}`;
        case 'T':
            return `${goal.target} total`;
    }
}

/** how much a sum of coins is, as said: "500", "20k", "1.2m" */
function coinsSaid(n: number): string {
    if (n < 1000) return `${Math.max(1, Math.round(n))}`;
    if (n < 1_000_000) return `${Math.max(1, Math.round(n / 1000))}k`;
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
}

/** the goal's measure now (XP, coins, a level) and its target's */
function measure(p: Player, goal: GoalRecord): { now: number; target: number } {
    switch (goal.kind) {
        case 'L':
            return { now: Math.floor((p.stats[goal.stat ?? 0] ?? 0) / 10), target: Math.floor(getExpByLevel(goal.target) / 10) };
        case 'G':
            return { now: coinsOwned(p), target: Math.max(1, ObjType.get(goal.target)?.cost ?? 1) };
        case 'M':
            return { now: coinsOwned(p), target: goal.target * 1000 };
        case 'C':
            return { now: combatOf(p), target: goal.target };
        case 'T':
            return { now: totalOf(p), target: goal.target };
    }
}

/** what is left, as said ("3 lvls", "1 lvl", "200k xp", "20k"), or null when nothing sayable is left */
export function goalLeft(p: Player, goal: GoalRecord): string | null {
    if (goal.kind === 'L') {
        const level = p.baseLevels[goal.stat ?? 0] ?? 1;
        if (goal.target >= 99) {
            const xp = Math.ceil((XP_99 - (p.stats[goal.stat ?? 0] ?? 0)) / 10);
            return xp > 0 ? `${coinsSaid(xp)} xp` : null;
        }
        const n = goal.target - level;
        return n <= 0 ? null : n === 1 ? '1 lvl' : `${n} lvls`;
    }
    if (goal.kind === 'C' || goal.kind === 'T') {
        const n = goal.target - (goal.kind === 'C' ? combatOf(p) : totalOf(p));
        return n <= 0 ? null : n === 1 ? '1 lvl' : `${n} lvls`;
    }
    const m = measure(p, goal);
    const left = m.target - m.now;
    return left > 0 ? coinsSaid(left) : null;
}

/** the share of the way made since the goal was set (0-1) */
function progress(p: Player, goal: GoalRecord): number {
    const m = measure(p, goal);
    const span = m.target - goal.base;
    return span <= 0 ? 1 : Math.max(0, Math.min(1, (m.now - goal.base) / span));
}

function isDone(p: Player, goal: GoalRecord): boolean {
    switch (goal.kind) {
        case 'L':
            return (p.baseLevels[goal.stat ?? 0] ?? 1) >= goal.target;
        case 'G':
            return whereOwned(p, goal.target) !== null;
        case 'M':
            return coinsOwned(p) >= goal.target * 1000;
        case 'C':
            return combatOf(p) >= goal.target;
        case 'T':
            return totalOf(p) >= goal.target;
    }
}

// ── set, done, dropped ───────────────────────────────────────────────────────────────────────────────────────────

function setGoal(p: Player, goal: GoalRecord): void {
    arcsOf(p.username).goal = goal;
    goalStats.set++;
    log({ t: World.currentTick, name: p.username, planner: p.botPlanner ?? '', ev: 'set', kind: goal.kind, words: goalWords(goal), stat: goal.stat, target: goal.target });
}

function clearGoal(p: Player): void {
    const rec = peekArcs(p.username);
    if (rec) delete rec.goal;
}

/** At a pick: a goal for a bot that keeps one and has none (its first pick of a session, or 5-30 minutes after one is done). */
export function ensureGoal(p: Player, random: () => number = Math.random): GoalRecord | null {
    if (!keepsGoal(p)) return null;
    const have = peekArcs(p.username)?.goal;
    if (have) return have;
    const m = memOf(p);
    if (arcsPlay() < m.nextAt) return null;
    const goal = drawGoal(p, random);
    if (goal) setGoal(p, goal);
    return goal;
}

function companyOf(p: Player, r = 15): number {
    let n = 0;
    for (const q of worldPlayers()) if (q !== p && q.level === p.level && Math.abs(q.x - p.x) <= r && Math.abs(q.z - p.z) <= r) n++;
    return n;
}

function goalDone(p: Player, goal: GoalRecord, how: 'levelup' | 'check'): void {
    clearGoal(p);
    const m = memOf(p);
    m.nextAt = arcsPlay() + NEXT_GOAL_TICKS[0] + Math.floor(Math.random() * (NEXT_GOAL_TICKS[1] - NEXT_GOAL_TICKS[0]));
    goalStats.done++;
    const company = companyOf(p);
    const entry = log({ t: World.currentTick, name: p.username, planner: p.botPlanner ?? '', ev: 'done', kind: goal.kind, words: goalWords(goal), stat: goal.stat, target: goal.target, company });
    if (how === 'levelup') m.done = { goal, tick: World.currentTick, entry };
    else m.sayDone = { goal, until: World.currentTick + SAY_WAIT, entry };
    if (Math.random() < CHEER_CHANCE) everydayEmote(p, 'cheer', true);
    emitArcs({ k: 'goal-done', bot: p, goal, detail: { words: goalWords(goal), company } });
}

function goalDropped(p: Player, goal: GoalRecord, ev: 'dropped' | 'changed'): void {
    clearGoal(p);
    memOf(p).dropped = goalWords(goal);
    goalStats[ev]++;
    log({ t: World.currentTick, name: p.username, planner: p.botPlanner ?? '', ev, kind: goal.kind, words: goalWords(goal), stat: goal.stat, target: goal.target });
}

/** a G or M goal's look (every CHECK_EVERY or so, and at its picks): done, or a G goal met another way (it changes) */
function checkGoal(p: Player): void {
    const goal = goalOf(p);
    if (!goal || (goal.kind !== 'G' && goal.kind !== 'M')) return;
    if (isDone(p, goal)) return goalDone(p, goal, 'check');
    if (goal.kind === 'G') {
        const want = gearWanted(p);
        if (!want || want.itemId !== goal.target) goalDropped(p, goal, 'changed');
    }
}

// ── the bus ──────────────────────────────────────────────────────────────────────────────────────────────────────

onArcs('levelup', e => {
    if (!LIVES_CTL.on) return;
    const p = e.bot;
    const goal = goalOf(p);
    if (!goal || goal.kind === 'G' || goal.kind === 'M') return;
    if (goal.kind === 'L' && goal.stat !== e.stat) return;
    if (goal.kind === 'C' && !COMBAT_STATS.has(e.stat)) return;
    if (isDone(p, goal)) goalDone(p, goal, 'levelup');
});

onArcs('login', e => {
    if (!LIVES_CTL.on) return;
    const p = e.bot;
    if (!p) return;
    const m = memOf(p);
    m.loginPlay = arcsPlay();
    // (dropped: 4 hours of its online play with under a tenth of the way made, half the time)
    const goal = peekArcs(p.username)?.goal;
    if (!goal || !keepsGoal(p)) return;
    if ((goal.flags ?? 0) >= DROP_MINUTES && progress(p, goal) < DROP_PROGRESS && Math.random() < DROP_CHANCE) goalDropped(p, goal, 'dropped');
});

onArcs('logout', e => {
    if (!LIVES_CTL.on) return;
    const p = e.bot;
    if (!p) return;
    const goal = peekArcs(e.name)?.goal;
    if (!goal) return;
    const minutes = Math.max(0, Math.floor((arcsPlay() - memOf(p).loginPlay) / 100));
    goal.flags = Math.min(1_000_000, (goal.flags ?? 0) + minutes);
});

// the G and M goals' looks (staggered: each bot about every CHECK_EVERY play ticks), and their lines at a calm moment
registerArcsTick((now, play) => {
    if (!LIVES_CTL.on) return;
    const slot = Math.floor(play / CHECK_TICK) % (CHECK_EVERY / CHECK_TICK);
    for (const p of BotManager.activeBots()) {
        const m = mems.get(p);
        if (m?.sayDone) sayDoneLater(p, m);
        if ((hashString(p.username) % (CHECK_EVERY / CHECK_TICK)) !== slot) continue;
        try {
            checkGoal(p);
        } catch {
            // (a look that fails is tried next time)
        }
    }
    void now;
}, CHECK_TICK);

function sayDoneLater(p: Player, m: Mem): void {
    const s = m.sayDone!;
    if (World.currentTick > s.until) {
        m.sayDone = null;
        return;
    }
    if (!calm(p)) return;
    m.sayDone = null;
    const chance = s.entry.company && s.entry.company > 0 ? CELEBRATE.company : CELEBRATE.alone;
    if (Math.random() >= chance) return;
    const goal = s.goal;
    const pool = goal.kind === 'G' ? arcLines('arcs-goal', 'done-item') : arcLines('arcs-goal', 'done');
    const said = sayArcLine(p, pool, { done: goalWords(goal), gear: goalWords(goal) }, { kind: 'event', budget: 'own', spoke: 'event' });
    if (said) {
        s.entry.said = World.currentTick;
        goalStats.celebrated++;
        noteLivesLine(p, 'arcs-goal', 'done', said);
    }
}

// ── the hooks ────────────────────────────────────────────────────────────────────────────────────────────────────

/** the chatter: a level-up that completed a goal: its celebration in the level-up line's place, or null */
LIVES.levelUp = (bot, _stat, _level) => {
    const m = mems.get(bot);
    const d = m?.done;
    if (!m || !d || d.tick !== World.currentTick) return null;
    m.done = null;
    const chance = d.entry.company && d.entry.company > 0 ? CELEBRATE.company : CELEBRATE.alone;
    if (Math.random() >= chance) return null;
    const words = goalWords(d.goal);
    const pending: LivesPending = { pool: arcLines('arcs-goal', 'done'), slots: { done: words }, gz: true, event: 'done', entry: d.entry };
    return pending;
};

/** the chatter: the celebration said now (its pending line was due): in the place of its next due line */
LIVES.sayPending = (bot, pending) => {
    // (the level-up's own line: kind 'levelup', the bots near may gz it; else a line about the goal, kind 'event': C8 counts
    // level-up lines, and this one goes to nobody for a gz)
    const own = pending.budget === 'slot';
    const said = sayArcLine(bot, pending.pool, pending.slots, { kind: own ? 'levelup' : 'event', budget: 'slot', spoke: own ? 'levelup' : 'event' });
    if (!said) return false;
    // (the level-up's own line, its roll passed: nothing more; else in the place of the bot's next due line)
    if (pending.budget !== 'slot') countAsOwnLine(bot);
    if (pending.entry) {
        pending.entry.said = World.currentTick;
        (pending.entry as GoalLogEntry).gz = pending.gz;
    }
    goalStats.celebrated++;
    noteLivesLine(bot, 'arcs-goal', pending.event, said);
    if (pending.gz) {
        for (const q of worldPlayers()) {
            if (q !== bot && q.is_bot && q.level === bot.level && Math.max(Math.abs(q.x - bot.x), Math.abs(q.z - bot.z)) <= 15) {
                BotChat.onBotLine(bot, said, 'levelup');
                break;
            }
        }
    }
    return true;
};

const GOAL_QUESTION = /\b(what|wat|whats|wuts)\b.*\b(goal|goals|going for|training for|saving for|saving up)\b|^goals?$/;

/** the answers: a question about the bot's own goal ("whats ur goal", "what u saving for", "goals?"): its goal and progress, or null */
LIVES.goalAnswer = (bot, msg) => {
    if (!GOAL_QUESTION.test(msg)) return null;
    if (!keepsGoal(bot)) {
        // (a newbie: upstream's replies; noted for the runner's AR2, which asks only bots that keep a goal)
        if (bot.is_bot === true && isLevelling(bot.botPlanner as PlannerKey)) log({ t: World.currentTick, name: bot.username, planner: bot.botPlanner ?? '', ev: 'asked', kind: 'L', words: '', target: 0 });
        return null;
    }
    const goal = ensureGoal(bot);
    const m = memOf(bot);
    const pick = (pool: readonly string[], slots: ArcSlots): string | null => {
        const start = Math.floor(Math.random() * Math.max(1, pool.length));
        for (let i = 0; i < pool.length; i++) {
            const text = fillArcSlots(pool[(start + i) % pool.length], slots);
            if (text !== null) return text;
        }
        return null;
    };
    let answer: string | null = null;
    // (a goal it dropped or changed this session: said when asked, once)
    if (m.dropped && Math.random() < 0.7) {
        answer = goal ? pick(arcLines('arcs-goal', 'dropped'), { goal: goalWords(goal) }) : pick(arcLines('arcs-goal', 'dropped').filter(t => !t.includes('{')), {});
        m.dropped = null;
    }
    if (answer === null && goal) {
        const left = goalLeft(bot, goal);
        const words = goalWords(goal, Math.random() < 0.6);
        const slots: ArcSlots = left ? { goal: words, gear: words, left } : { goal: words, gear: words };
        // (a progress line now and then: "3 lvls to go for 60 wc", "need 20k more for rune legs")
        const pool = goal.kind === 'G' || goal.kind === 'M' ? arcLines('arcs-goal', 'saving') : arcLines('arcs-goal', 'answer');
        const withLeft = pool.filter(t => t.includes('{left}'));
        const plain = pool.filter(t => !t.includes('{left}'));
        answer = left && withLeft.length && Math.random() < 0.4 ? pick(withLeft, slots) : pick(plain, slots);
        if (goal.kind === 'M' && answer) answer = answer.replace(/^saving for /, 'saving up ');
    }
    if (answer === null) return null;
    log({ t: World.currentTick, name: bot.username, planner: bot.botPlanner ?? '', ev: 'asked', kind: goal?.kind ?? 'L', words: goal ? goalWords(goal) : '', stat: goal?.stat, target: goal?.target ?? 0, answer });
    return answer;
};

/** the threads: a thread's {goal} from the saved goal ("60 wc for yews", "rune legs", "100k") */
LIVES.sideGoal = bot => {
    const goal = goalOf(bot);
    return goal ? goalWords(goal, Math.random() < 0.5) : null;
};

/** the threads: a thread's {want} (what it saves for) from a saved gear goal */
LIVES.sideWant = bot => {
    const goal = goalOf(bot);
    return goal && goal.kind === 'G' ? goalWords(goal) : null;
};

/** round 1's endgame hook: a bosser whose goal points at the endgame takes its trips 1.5 times as often */
LIVES.endgameScale = p => {
    const goal = goalOf(p);
    if (!goal) return 1;
    if (goal.kind === 'C' && goal.target >= 90) return 1.5;
    if (goal.kind === 'L' && COMBAT_STATS.has(goal.stat ?? -1) && goal.target >= 80) return 1.5;
    if (goal.kind === 'M' && goal.target >= 250) return 1.5;
    return 1;
};

/** a skiller's gear or money goal: its bankstand session 25 % sooner (an extra count down one pick in three) */
LIVES.bankstandSooner = p => {
    const goal = goalOf(p);
    return goal !== null && (goal.kind === 'G' || goal.kind === 'M') && p.botPlanner === 'skiller' && Math.random() < 1 / 3;
};

// ── the planner (port/BotLivesIndex composes the hooks) ─────────────────────────────────────────────────────────

/** before the candidates: a gear goal's piece come into reach, bought by the upgrade path (its shop trip), or null */
export function goalPlannerTask(p: Player): BotTask | null {
    const goal = goalOf(p);
    if (!goal || goal.kind !== 'G') return null;
    checkGoal(p);
    const now = goalOf(p);
    if (!now || now.kind !== 'G') return null;
    const up = nextGearUpgrade(p, SCIMITAR_TIERS);
    if (!up || up.itemId !== now.target) return null;
    const trip = new ShopTripTask(up.shopKey, up.itemId, 1, up.cost);
    if (!trip.shouldRun(p)) return null;
    goalStats.bought++;
    return trip;
}

/** the goal's skill (the planner's name) its lean puts first now, with its chance, or null */
export function goalLeanSkill(p: Player, candidates: readonly string[]): { skill: string; chance: number } | null {
    const goal = goalOf(p);
    if (!goal) return null;
    if (goal.kind === 'L') {
        const skill = SKILL_OF_STAT.get(goal.stat ?? -1);
        return skill ? { skill, chance: goal.target >= 99 ? GOAL_LEAN_99 : GOAL_LEAN } : null;
    }
    if (goal.kind === 'C') {
        let low: string = MELEE[0];
        for (const s of MELEE) if (levelOf(p, s) < levelOf(p, low)) low = s;
        return { skill: low, chance: GOAL_LEAN };
    }
    if ((goal.kind === 'G' || goal.kind === 'M') && p.botPlanner === 'fighter') {
        const skill = candidates.find(s => (MELEE as readonly string[]).includes(s));
        return skill ? { skill, chance: GOAL_LEAN_EARN } : null;
    }
    return null;
}

/** the lean: the goal's skill first, its chance of the picks; true when it leaned */
export function goalLean(p: Player, candidates: string[], random: () => number = Math.random): boolean {
    const lean = goalLeanSkill(p, candidates);
    if (!lean || random() >= lean.chance) return false;
    const i = candidates.indexOf(lean.skill);
    if (i < 0) return false;
    if (i > 0) candidates.unshift(...candidates.splice(i, 1));
    // (a skill fed by another: the feeder next, as a cook fished its own: the theme's rule)
    const feeder = GOAL_FEEDER[lean.skill];
    const j = feeder ? candidates.indexOf(feeder) : -1;
    if (j > 1) candidates.splice(1, 0, ...candidates.splice(j, 1));
    return true;
}

// ── the runner and the tests ─────────────────────────────────────────────────────────────────────────────────────

/** (the runner) a levelling bot's goal now, as the samples read it: kind, skill (stat), words */
export function goalSample(p: Player): { kind: GoalKind; stat?: number; words: string } | null {
    const goal = goalOf(p);
    return goal ? { kind: goal.kind, stat: goal.stat, words: goalWords(goal) } : null;
}

/** (tests) a goal set now (null: none), its log noted */
export function setGoalForTest(p: Player, goal: Omit<GoalRecord, 'since' | 'base'> & Partial<Pick<GoalRecord, 'since' | 'base'>> | null): void {
    if (goal === null) {
        clearGoal(p);
        return;
    }
    const full: GoalRecord = { since: arcsPlay(), base: 0, ...goal };
    if (goal.base === undefined) full.base = measure(p, full).now;
    setGoal(p, full);
    memOf(p).nextAt = 0;
}

/** (tests) the session's memory forgotten for a bot (its next goal at once) */
export function resetGoalMemoryForTest(p: Player): void {
    mems.delete(p);
}

/** (tests) a G or M goal's look now */
export function checkGoalForTest(p: Player): void {
    checkGoal(p);
}
