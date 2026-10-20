// port: fallible bots (the realism work, phase 5a, Track F: fights, skills and manners; "fallible
// bots: misclicks, wrong turns, forgotten food, occasional deaths while skilling (items kept)"). Before, a bot never
// clicked the wrong thing, never left the bank without its food and never got careless: every pick was right first time.
//
//   - Carelessness (port/BotPersona, its own seed: log-normal, median 0.25, 0.05-1; about 1 bot in 8 above 0.6; kids a
//     little more) scales everything here; it counts half for the rest of a session after a death ("never going there
//     again lol"), for REPEAT_DEATH_TICKS the bot keeps off spots where monsters hunt it (BotGoalPlanner's step 1e), and
//     a second death within them ends the plan.
//   - Misclicks: now and then (about FUMBLES_PER_HOUR an hour at a task where it picks targets, times its carelessness
//     against the median's, never closer than FUMBLE_COOLDOWN) a real click that 274's scripts answer harmlessly, made
//     where the bot would click its next target anyway (inside its person's pause: the humanlike report's H17 and H18):
//     an empty rock ("There is no ore currently available in this rock."), a cow someone else is fighting ("Someone else
//     is fighting that.", single-way only), a tree of another kind beside its own (one swing at most). Then the right
//     one, a moment later. Never a drop, a fight with something else, a spell, anything that costs it.
//   - Forgotten food: a fighter's bank stop sometimes leaves without food (FORGET_FOOD times its carelessness, at most
//     FORGET_CAP; not again for half an hour after), or with only 2-4; a careless one pushes on to a quarter of its
//     Hitpoints before it leaves (CombatTask).
// The clocks are play ticks (World.currentTick); the dice Math.random (seeded in the sims); a bot's state lives while it
// is logged in (a WeakMap on its Player: a new login, a new session).
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { personaOf } from '#/engine/bot/port/BotPersona.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { noteEvent } from '#/engine/bot/port/BotChatter.js';
import { dangerAt, huntsMe } from '#/engine/bot/port/BotDanger.js';

/** carelessness at which the scales below are 1 (the persona's median) */
export const CARELESS_MEDIAN = 0.25;
/** from here a bot is careless: it pushes on at low Hitpoints, now and then skips the danger check (about 1 in 8) */
export const CARELESS_AT = 0.6;

/**
 * misclicks an hour at a task where the bot picks targets (mining, chopping, fighting), at the median carelessness; one
 * comes at the first pick with a harmless wrong target beside the bot after it is due (a levelling bot spends about a
 * quarter of its time at such picks: 2 gave 0.4-0.6 a levelling bot-hour in the humanlike runs, 4 0.5-1.1, 5 0.8-1.5 at
 * 1x XP and 0.45-0.65 at 10x, where it spends less of its time at them; F1's band 0.5-3, the spec's "about 1.5"). The
 * cooldown caps it: the median bot and every careless one make about 5.7 an hour at such a task, the careful ones fewer
 */
export const FUMBLES_PER_HOUR = 7;
/** never closer together than this (6-15 minutes, drawn each time) */
export const FUMBLE_COOLDOWN: readonly [number, number] = [600, 1500];
/** a pause in the bot's picking longer than this stops the misclick clock (it walks, banks, does something else) */
const FUMBLE_CLOCK_GAP = 100;

/** forgotten food: of a fighter's bank stops with food in the bank, this share leave without any (× carelessness/median) */
export const FORGET_FOOD = 0.06;
export const FORGET_CAP = 0.2;
/** and this share with only 2-4 pieces (× carelessness/median, at most FEW_CAP) */
export const FEW_FOOD = 0.1;
const FEW_CAP = 0.25;
/** after a trip without food a bot takes its food for this long ("forgot food lol": not again the next trip; 30 minutes) */
export const FORGOT_MEMORY_TICKS = 3000;

/** a second death this soon after the last ends the plan (30 minutes) */
export const REPEAT_DEATH_TICKS = 3000;

export type FumbleKind = 'rock' | 'npc' | 'tree';

interface FallState {
    /** the misclick clock: the tick the next one is due, and the last tick the bot picked a target */
    next: number;
    lastPick: number;
    /** deaths this session (ticks), carelessness halved since the first */
    deaths: number[];
    /** after a second death within REPEAT_DEATH_TICKS: no spot where monsters hunt it until then (the planner) */
    shakenUntil: number;
    /** the bot's current trip left without food (its bank stop), and whether it said so; the tick it last forgot */
    forgot: boolean;
    forgotSaid: boolean;
    forgotAt: number;
}

const states = new WeakMap<Player, FallState>();

function stateOf(bot: Player): FallState {
    let st = states.get(bot);
    if (!st) {
        st = { next: -1, lastPick: -1, deaths: [], shakenUntil: -1, forgot: false, forgotSaid: false, forgotAt: -Infinity };
        states.set(bot, st);
    }
    return st;
}

function persona(bot: Player) {
    return personaOf(bot.username, (bot.botPlanner as PlannerKey | undefined) ?? null);
}

/** The bot's carelessness now: its persona's, half of it for the rest of a session after a death. */
export function carelessnessOf(bot: Player): number {
    const c = persona(bot).carelessness;
    return (states.get(bot)?.deaths.length ?? 0) > 0 ? c / 2 : c;
}

/** Its carelessness against the median's (0.2-4): the scale of its misclicks, forgotten food and wrong turns. */
export function carelessFactor(bot: Player): number {
    return carelessnessOf(bot) / CARELESS_MEDIAN;
}

/** A careless bot (carelessness CARELESS_AT or more: about 1 in 8): it pushes on at low Hitpoints. */
export function isCareless(bot: Player): boolean {
    return carelessnessOf(bot) >= CARELESS_AT;
}

/**
 * A careless moment: true with the chance `carelessness × scale` (the danger check's skip: carelessness × 0.5, so a
 * median bot skips it one time in 8 and a reckless one half the time).
 */
export function carelessRoll(bot: Player, scale: number): boolean {
    return Math.random() < carelessChance(bot, scale);
}

/**
 * The chance of a careless moment (`carelessness × scale`, carelessRoll's), for a draw held a while: the planner's "go
 * anyway" over White Wolf Mountain (the variety work, round 2, the fixes: its draw is held, its chance read when asked).
 */
export function carelessChance(bot: Player, scale: number): number {
    return carelessnessOf(bot) * scale * carelessForTest;
}

/** Tests only (test/texture.test.mjs): careless moments at this many times their chance (0: none). Never set by the game. */
let carelessForTest = 1;
export function setCarelessRollsForTest(times: number): void {
    carelessForTest = times;
}

// ── misclicks ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** every misclick (bot name lower case, tick, kind): the humanlike runner's F1 and the tests (capped) */
export const fumbleLog: { name: string; tick: number; kind: FumbleKind }[] = [];
const MAX_FUMBLES = 5000;
export const fumbleStats = { rock: 0, npc: 0, tree: 0 };

/** ticks to the next misclick: the cooldown, then an exponential wait around the hour's rate over its carelessness */
function fumbleGap(bot: Player): number {
    const [lo, hi] = FUMBLE_COOLDOWN;
    const cooldown = lo + Math.random() * (hi - lo);
    const mean = Math.max(0, 6000 / (FUMBLES_PER_HOUR * Math.max(0.2, carelessFactor(bot))) - (lo + hi) / 2);
    return Math.round(cooldown - mean * Math.log(1 - Math.random()));
}

/**
 * Is a misclick due for this bot now, at a target pick (a levelling bot, its clock run out)? The clock runs only while
 * the bot picks targets: a walk, a bank trip, another kind of task stops it (else a bot back at its rocks after a while
 * away would misclick at once, every time).
 */
export function fumbleDue(bot: Player): boolean {
    if (!isLevelling(bot.botPlanner as PlannerKey)) return false;
    const st = stateOf(bot);
    const now = World.currentTick;
    if (st.next < 0) st.next = now + Math.round(fumbleGap(bot) * Math.random());
    else if (st.lastPick >= 0 && now - st.lastPick > FUMBLE_CLOCK_GAP) st.next += now - st.lastPick - FUMBLE_CLOCK_GAP;
    st.lastPick = now;
    return now >= st.next;
}

/** The bot misclicked (`kind`): counted, its next one drawn, and now and then it says so ("oops", "misclick lol"). */
export function fumbled(bot: Player, kind: FumbleKind): void {
    const st = stateOf(bot);
    const now = World.currentTick;
    st.next = now + fumbleGap(bot);
    fumbleStats[kind]++;
    fumbleLog.push({ name: bot.username.toLowerCase(), tick: now, kind });
    if (fumbleLog.length > MAX_FUMBLES) fumbleLog.splice(0, fumbleLog.length - MAX_FUMBLES);
    noteEvent(bot, 'misclick');
}

/** (tests) a misclick due at once for this bot */
export function fumbleNowForTest(bot: Player): void {
    const st = stateOf(bot);
    st.next = World.currentTick;
    st.lastPick = World.currentTick;
}

/** (tests) no misclick for this bot for `ticks` (a staging that needs its pick to be its own) */
export function fumbleLaterForTest(bot: Player, ticks: number): void {
    const st = stateOf(bot);
    st.next = World.currentTick + ticks;
    st.lastPick = World.currentTick;
}

// ── the danger check's count ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * the danger check's decisions (port/BotDefence, the planner's step 1e): a rest that eats, one that fetches food from a
 * bank, a bot that left its spot to heal elsewhere (no food anywhere), a careless one that went on: the humanlike runner's
 * D1 detail
 */
export const dangerStats = { eat: 0, fetch: 0, leave: 0, goOn: 0 };

// ── forgotten food ───────────────────────────────────────────────────────────────────────────────────────────────────

/** the fighters' bank stops with food in the bank: how many, how many left without any, how many with only a few */
export const foodStats = { trips: 0, forgot: 0, few: 0 };
/** every such stop (bot name, tick, what it took, the food it carried already): the humanlike runner's F3 (capped) */
export const foodLog: { name: string; tick: number; took: 'full' | 'few' | 'none'; carried: number }[] = [];
const MAX_FOOD_LOG = 5000;

/**
 * At a fighter's bank stop with food in the bank (`carried`: the food in its pack already): does it take its food
 * ('full'), only a few ('few': 2-4), or forget it ('none')? Not forgotten again within FORGOT_MEMORY_TICKS of the last
 * time. Counted (F3), and the trip remembers it (forgotFood).
 */
export function packFoodRoll(bot: Player, carried = 0): 'full' | 'few' | 'none' {
    const st = stateOf(bot);
    const now = World.currentTick;
    const f = carelessFactor(bot);
    const forget = now - st.forgotAt < FORGOT_MEMORY_TICKS ? 0 : Math.min(FORGET_CAP, FORGET_FOOD * f);
    const few = Math.min(FEW_CAP, FEW_FOOD * f);
    const r = Math.random();
    const took = r < forget ? 'none' : r < forget + few ? 'few' : 'full';
    foodStats.trips++;
    if (took === 'none' && carried === 0) foodStats.forgot++;
    if (took === 'few') foodStats.few++;
    foodLog.push({ name: bot.username.toLowerCase(), tick: now, took, carried });
    if (foodLog.length > MAX_FOOD_LOG) foodLog.splice(0, foodLog.length - MAX_FOOD_LOG);
    st.forgot = took === 'none' && carried === 0;
    st.forgotSaid = false;
    if (took === 'none') st.forgotAt = now;
    return took;
}

/** This trip of the bot's left the bank without food (packFoodRoll). */
export function forgotFood(bot: Player): boolean {
    return states.get(bot)?.forgot ?? false;
}

/** It noticed (hurt, no food): a line now and then ("forgot my food lol"), once a trip. */
export function noticeNoFood(bot: Player): void {
    const st = stateOf(bot);
    if (!st.forgot || st.forgotSaid) return;
    st.forgotSaid = true;
    noteEvent(bot, 'forgot-food');
}

// ── deaths ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** every death a bot noticed (bot name, tick, a second within 30 minutes): the tests */
export const deathLog: { name: string; tick: number; repeat: boolean }[] = [];

/**
 * The bot died (port/BotChatter notices the respawn): its carelessness counts half from now on this session, and for
 * REPEAT_DEATH_TICKS no spot where monsters hunt it (isShaken: its task ends if its spot is one); a second death within
 * them ends its plan. Only a levelling bot's (a PKer dies by the PK rules).
 */
export function noteDeath(bot: Player): void {
    if (!isLevelling(bot.botPlanner as PlannerKey)) return;
    const st = stateOf(bot);
    const now = World.currentTick;
    const repeat = st.deaths.length > 0 && now - st.deaths[st.deaths.length - 1] <= REPEAT_DEATH_TICKS;
    st.deaths.push(now);
    if (st.deaths.length > 8) st.deaths.shift();
    st.forgot = false;
    deathLog.push({ name: bot.username.toLowerCase(), tick: now, repeat });
    if (deathLog.length > 1000) deathLog.shift();
    // (any death: no spot where monsters hunt it for REPEAT_DEATH_TICKS, its task ends if its spot is one: a fletcher
    // walked back from Lumbridge to Draynor's wizards and died there again within 15 minutes, the humanlike report's D4;
    // a second death within them ends its plan whatever the task)
    st.shakenUntil = now + REPEAT_DEATH_TICKS;
    const task = (bot as unknown as { _bot?: { currentTask?: { interrupt(): void; activityStep(): { location: [number, number, number] } | null } | null } })._bot?.currentTask;
    if (!task) return;
    let spot: [number, number, number] | null = null;
    try {
        spot = task.activityStep()?.location ?? null;
    } catch {
        spot = null;
    }
    if (repeat || (spot && huntsMe(bot, dangerAt(spot[0], spot[1], spot[2])))) task.interrupt();
}

/**
 * For `ticks` the planner keeps the bot off spots where monsters hunt it, as after a death (isShaken), with no death: a
 * second food trip for the same hunted spot (port/BotDefence's danger check)
 */
export function keepOffHunted(bot: Player, ticks: number): void {
    const st = stateOf(bot);
    st.shakenUntil = Math.max(st.shakenUntil, World.currentTick + ticks);
}

/** For 30 minutes after a death: the planner keeps the bot off spots where monsters hunt it (a second death: its plan ends too). */
export function isShaken(bot: Player): boolean {
    return World.currentTick < (states.get(bot)?.shakenUntil ?? -1);
}

/** Deaths this session. */
export function deathsOf(bot: Player): number {
    return states.get(bot)?.deaths.length ?? 0;
}

/** (tests) forget every count and log */
export function resetFumblesForTest(): void {
    fumbleLog.length = 0;
    foodLog.length = 0;
    deathLog.length = 0;
    fumbleStats.rock = 0;
    fumbleStats.npc = 0;
    fumbleStats.tree = 0;
    foodStats.trips = 0;
    foodStats.forgot = 0;
    foodStats.few = 0;
    dangerStats.eat = 0;
    dangerStats.fetch = 0;
    dangerStats.leave = 0;
    dangerStats.goOn = 0;
}
