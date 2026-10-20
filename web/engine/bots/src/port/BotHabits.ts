// port: a bot's habits beyond its task (the realism work, phase 2): short breaks, a look at something, leaving the game
// like a player. A pure layer over the task: BotPlayer.tick asks tickHabits first, and while it holds the bot nothing
// else runs (no task, no rescan); the tasks call bankStop where they stand at a bank booth; BotManager._endSession asks
// readyToLeave once a session is over.
//
// Short breaks ("quiet majority": nobody is on all the time, and 2004's players went AFK):
//   - persona.afkPerHour of them (0-3 an hour, about 1), each 20-85 s: 274's client logs a player out after 90 s
//     without input (Client.ts IDLE_TIMER), so a 2004 "brb" meant back within about a minute and a half;
//   - at a bank stop, or at its spot between two rounds (the cook at the range), or AFK-skilling: its tree, rock or
//     fishing spot keeps going without it (the engine chops on) and it stands when that ends;
//   - about half say "brb" first (sayOccasion; a break said aloud lasts 45 s or more, so the line is never a fake), some
//     of those "back" after;
//   - never in a fight, a trade, a conversation, in the Wilderness or on the human's errand ("come here"), and a hit,
//     a trade or the errand ends one at once. The task is not ticked meanwhile, so its watchdog and stuck detector
//     wait too, and BotPlayer stops its no-XP clock.
//   - Rarer, a linger at a bank stop or at its spot between two rounds: 2-2.5 min standing there, silent and not away
//     (sorting the bank, chatting by PM, a look at its stats: a player with input, whom 274 does not log out): the
//     humanlike report's H19 counts stands of 2-10 min, which a break under 90 s never is. LINGERS_PER_HOUR sets it
//     (0: none).
// A stand of its own (the realism work, phase 3: port/BotTiles): a linger on a tile another player stands on (a bank
// booth's, a range's) steps first to a free tile within 2 of it, held until the linger ends (the humanlike report's H4:
// idle bots stacked on one tile); a short break is taken where the bot stands.
// A hang-out (port/BotHangout: a few minutes at Falador park, Varrock square or a bank) is a stand of its own: no linger
// comes during one (the next is drawn when it ends), and a break may (an AFK at the park, a "brb" first, as anywhere).
// A look: within 8 tiles of a fight between players (its start, the kill and its drop), a level-up cheer or a dance
// (noteSpectacle; 274's revealed drops have no hook a library can see), a free levelling bot may stop for 3-10 s and
// face it, turning with it (persona.curiosity; it looks up after reactionTicks 'notice'; it plays on when that walks
// off), at most once in 3-9 minutes.
// Leaving: when its session is over and nothing keeps it (BotManager._busy), a gatherer with a load and a bank within
// about 25 tiles banks it first; any other bot finishes what it is doing (its interaction, the step of its walk); then
// it stands a moment and, with players near, now and then says goodbye (sayOccasion 'departure'), and logs out. A few
// leave at once (the line dropped, mum called). A break that runs past the session ends it there (274's idle logout).
//
// Every roll is Math.random (seeded in the sims) or the persona; no wall clock. Per bot and tick the work is a WeakMap
// read and a few compares (while a break or a linger is due, every 5th tick a look round for a moment to take it: an
// attacker within 8 tiles, BotAction's cached search); the loops over players (who is near, who sees a spectacle) run
// only at the rare moments they serve.
import InvType from '#/cache/config/InvType.js';
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import type { BotPlayer } from '#/engine/bot/BotPlayer.js';
import { findAggressorNpc } from '#/engine/bot/BotAction.js';
import { BotChat } from '#/engine/bot/port/BotChat.js';
import { sayOccasion } from '#/engine/bot/port/BotChatter.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import type { Persona } from '#/engine/bot/port/BotPersona.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { botPersona, reactionTicks } from '#/engine/bot/port/BotTiming.js';
import { tradeScreen } from '#/engine/bot/port/BotTradeScreen.js';
import { FOOD_IDS, Items, nearestBank } from '#/engine/bot/tasks/BotTaskBase.js';
import { LeaveBankTask } from '#/engine/bot/tasks/UtilTasks.js';
import { claimStandTile, releaseStandTile, sharesTile, stepToTile } from '#/engine/bot/port/BotTiles.js';
import { hangoutAtBank, hangoutOf } from '#/engine/bot/port/BotHangout.js';
import { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';

const TICKS_PER_HOUR = 6000;

/** A short break's length, in ticks: 20-85 s (under 274's 90 s idle logout); one said aloud ("brb") 45-85 s. */
const BREAK_TICKS: [number, number] = [33, 142];
const BRB_BREAK_TICKS: [number, number] = [75, 142];
/** A break due but with no chance to take it (a long walk, a fight) for this long is put off to the next one. */
const BREAK_PATIENCE = 3000;
/**
 * A linger: 2-2.5 min (sim.mjs's aged run calls a stand of 300+ ticks on one tile in one task state, gaining and using up
 * nothing, a stall: with the booth's own stop after it, at most 40 ticks, or at its spot the task's wait for its next
 * round, it stays under)
 */
const LINGER_TICKS: [number, number] = [200, 250];
/**
 * Lingers an hour: the most sociable bots about 0.23, the least 0.05 (0: none), for the humanlike report's H19 (stands of
 * 2-10 min per 100 levelling bot-hours, 5-15) about 10.
 */
const LINGERS_PER_HOUR = 0.23;
/** "back" after a "brb": this share */
const BACK_CHANCE = 0.4;

/** How near a spectacle a bot must be to look (tiles), how long it looks (ticks), how often at most. */
const WATCH_RANGE = 8;
const WATCH_TICKS: [number, number] = [5, 17];
const WATCH_COOLDOWN: [number, number] = [300, 900];
/** The chance a bot that could look does (times its persona's curiosity). */
const WATCH_CHANCE = 0.6;

/** Players within this many tiles hear a goodbye (else the bot says none). */
const NEAR = 15;
/** The longest a wrap-up before a logout takes (then it goes anyway); its goodbye is seen this long before it goes. */
const WRAP_UP_MAX = 150;
const BYE_TICKS: [number, number] = [3, 6];
/** It finishes its interaction (a tree, a fight it was in) for at most this long, and the step of its walk. */
const FINISH_TICKS: [number, number] = [8, 30];
const FINISH_WALK_TICKS: [number, number] = [2, 8];
/** A bank this near (tiles, Chebyshev) and a gatherer banks its load before it logs out. */
const BANK_FIRST_RANGE = 25;
/** The share of logouts that come at once, whatever it was doing (a dropped line, a call from downstairs). */
const ABRUPT_SHARE = 0.08;

/** Task kinds a bot may take a short break in: its spot between two rounds, or the engine working on without it. */
const BREAK_KINDS = new Set(['Woodcut', 'Mine', 'Fish', 'Cook', 'Smith', 'Thieve', 'Crafting', 'Fletching', 'BowStringing', 'Herblore', 'Firemaking', 'Pick Flax', 'Combat', 'RangedMagic']);
/** Of those, where the engine keeps going on its own (the tree, the rock, the fishing spot): AFK-skilling. */
const AFK_SKILL_KINDS = new Set(['Woodcut', 'Mine', 'Fish']);
/** Gatherers: they bank their load before they log out, when a bank is near. */
const GATHERING_KINDS = new Set(['Woodcut', 'Mine', 'Fish', 'Pick Flax']);

type SpellKind = 'bank' | 'skill' | 'idle' | 'linger';
/** how a break ended: its time was up, or something cut it short, or the session's end */
export type BreakEnd = 'done' | 'errand' | 'trade' | 'fight' | 'hit' | 'attacker' | 'leaving';
interface Spell {
    kind: SpellKind;
    start: number;
    until: number;
    /** it said "brb" */
    brb: boolean;
    /** its Hitpoints last tick (a hit ends the break) */
    hp: number;
    /** it stepped to a tile of its own for it (port/BotTiles: a linger on a shared tile), given back when it ends */
    claimed?: boolean;
}
interface Watch {
    start: number;
    until: number;
    subject: Player;
    x: number;
    z: number;
    /** it has looked up (a bot that started work before then never does: the look is off) */
    begun: boolean;
}
interface Leaving {
    phase: 'bank' | 'finish' | 'stand' | 'bye';
    since: number;
    /** the world tick BotManager last asked (it holds the bot only while BotManager drives it) */
    asked: number;
    until: number;
    walkUntil: number;
    bank: LeaveBankTask | null;
}
interface Habits {
    persona: Persona;
    levelling: boolean;
    /** world ticks: the next short break and the next linger are due */
    nextBreak: number;
    nextLinger: number;
    spell: Spell | null;
    watch: Watch | null;
    nextWatch: number;
    leaving: Leaving | null;
    /** a phase from its slot: bots check a due break on different ticks */
    phase: number;
    /** the last break or linger that ended, and how (tests) */
    lastBreak: { kind: SpellKind; start: number; end: number; reason: BreakEnd } | null;
    /** (tests) the test rates' version its draws were made with */
    ratesVersion: number;
}

const habits = new WeakMap<Player, Habits>();

/** Tests only (test/habits.test.mjs): many breaks, lingers and looks in a short run. Never set by the game. */
const testRates = { breaks: 1, lingers: 1, watch: 1, abrupt: 1 };
/**
 * (the variety work, round 1, track W: a test's rates raised from 0 reach the bots already online; at 0 a bot's next
 * break was drawn as never, and only a bot that logged in after the raise took one: test/randomevents' break scenario
 * waited on a login the world's course may not give). Never changed by the game.
 */
let ratesVersion = 0;
export function setHabitRatesForTest(rates: Partial<typeof testRates>): void {
    Object.assign(testRates, rates);
    ratesVersion++;
}

function uniform([lo, hi]: [number, number]): number {
    return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function breaksPerHour(persona: Persona): number {
    return persona.afkPerHour * testRates.breaks;
}
function lingersPerHour(persona: Persona): number {
    return LINGERS_PER_HOUR * (0.2 + 0.8 * persona.sociability) * testRates.lingers;
}

/** Ticks to the next of something that comes `perHour` times an hour, at random (exponential); Infinity for none. */
function gap(perHour: number): number {
    if (!(perHour > 0)) return Infinity;
    return Math.round((-Math.log(1 - Math.random()) * TICKS_PER_HOUR) / perHour);
}

function habitsOf(bot: Player): Habits {
    let h = habits.get(bot);
    if (!h) {
        const persona = botPersona(bot);
        const now = World.currentTick;
        h = {
            persona,
            levelling: isLevelling(bot.botPlanner as PlannerKey),
            nextBreak: now + gap(breaksPerHour(persona)),
            nextLinger: now + gap(lingersPerHour(persona)),
            spell: null,
            watch: null,
            nextWatch: now,
            leaving: null,
            phase: (bot.slot >>> 0) % 5,
            lastBreak: null,
            ratesVersion
        };
        habits.set(bot, h);
    }
    return h;
}

/** Is the bot on a short break (AFK)? It says nothing and answers nobody until it is back. (A linger is no break.) */
export function isAway(bot: Player): boolean {
    const spell = habits.get(bot)?.spell;
    return spell !== undefined && spell !== null && spell.kind !== 'linger';
}

/** The last break or linger the bot had, and how it ended (tests). */
export function lastBreakOf(bot: Player): { kind: SpellKind; start: number; end: number; reason: BreakEnd } | null {
    return habits.get(bot)?.lastBreak ?? null;
}

/** Is the bot standing about for a while (a linger), or looking at something, or on a break? (tests, the report) */
export function habitOf(bot: Player): SpellKind | 'watch' | 'leaving' | null {
    const h = habits.get(bot);
    if (!h) return null;
    if (h.leaving) return 'leaving';
    if (h.spell) return h.spell.kind;
    if (h.watch?.begun) return 'watch';
    return null;
}

// ── the habit tick ─────────────────────────────────────────────────────────────

/**
 * BotPlayer.tick, after its line and before anything else it does: true while a habit holds the bot (a break, a look,
 * leaving), and then the bot does nothing else this tick. Starts a break or a linger that is due when the bot is at a
 * moment for one.
 */
export function tickHabits(bot: BotPlayer): boolean {
    const p = bot.player;
    const h = habitsOf(p);
    const now = World.currentTick;
    if (h.leaving && now - h.leaving.asked <= 1) return holdLeaving(p, h);
    // (tests: a never drawn at rate 0 is drawn again once a test raises the rate)
    if (h.ratesVersion !== ratesVersion) {
        h.ratesVersion = ratesVersion;
        if (!h.spell && h.nextBreak === Infinity) h.nextBreak = now + gap(breaksPerHour(h.persona));
        if (!h.spell && h.nextLinger === Infinity) h.nextLinger = now + gap(lingersPerHour(h.persona));
        // (and a rate set to 0 stops the one drawn before it: a break drawn at login still came in a test that turned
        // them off, a woodcutter's AFK break over the full pack's fill (activities.test), a miner's stand in the middle of
        // the rock-stealing's staging (texture.test), once round 1's merge moved the world's dice. No draw: the tests'
        // streams stay as they were)
        if (!(breaksPerHour(h.persona) > 0)) h.nextBreak = Infinity;
        if (!(lingersPerHour(h.persona) > 0)) h.nextLinger = Infinity;
    }
    if (h.spell) return tickSpell(p, h, now);
    if (h.watch) return tickWatch(p, h, now);
    // (port, the realism work's phase 5b: no break or linger in a set piece: a host, a duellist, a clan walk's member)
    if (h.levelling && (now >= h.nextBreak || now >= h.nextLinger) && (now + h.phase) % 5 === 0 && !eventRoleOf(p)) return tryBreak(bot, h, now);
    return false;
}

/** What ends a break or a look at once (null: nothing): the human's errand, a trade, a fight, a hit, an attacker near. */
function interrupted(p: Player, hp: number): BreakEnd | null {
    if (p.botComeHereReturnX !== -1) return 'errand';
    if (p.botTradeTargetPid !== -1 || tradeScreen(p) !== null) return 'trade';
    if (World.currentTick < p.preventLogoutUntil) return 'fight';
    if (p.levels[PlayerStat.HITPOINTS] < hp) return 'hit';
    return findAggressorNpc(p, 8) !== null ? 'attacker' : null;
}

/**
 * Free for a break or a look: not fighting, trading, talking (with a human, or typing a line, or in a practice with a
 * bot: port/BotChat.midTalk), on an errand, in the Wilderness, in a script, hurt.
 */
function free(p: Player): boolean {
    if (p.botComeHereReturnX !== -1 || p.botTradeTargetPid !== -1 || tradeScreen(p) !== null) return false;
    if (World.currentTick < p.preventLogoutUntil || p.delayed || p.activeScript !== null) return false;
    if (p.levels[PlayerStat.HITPOINTS] * 2 < p.baseLevels[PlayerStat.HITPOINTS]) return false;
    if (isNewbie(p) || wildernessLevelAt(p.x, p.z) > 0) return false;
    if (BotChat.inConversation(p) || BotChat.midTalk(p)) return false;
    return findAggressorNpc(p, 8) === null;
}

/** A human or another bot within NEAR tiles, on the bot's floor (a line said with nobody to read it is not said). */
function playersNear(p: Player): boolean {
    for (const other of World.playerLoop.all()) {
        if (other !== p && other.level === p.level && Math.max(Math.abs(other.x - p.x), Math.abs(other.z - p.z)) <= NEAR) return true;
    }
    return false;
}

/** A break or a linger that is due, at a moment for one (its spot between two rounds; a break also AFK-skilling). */
function tryBreak(bot: BotPlayer, h: Habits, now: number): boolean {
    const p = bot.player;
    if (now >= h.nextBreak && now - h.nextBreak > BREAK_PATIENCE) h.nextBreak = now + gap(breaksPerHour(h.persona));
    const linger = now >= h.nextLinger;
    if (!linger && now < h.nextBreak) return false;
    const kind = bot.currentTask?.name.split(':')[0] ?? '';
    // (at a hang-out, its task's or a bank stop's sub-task: a break, standing on its tile there; a linger, never: a
    // hang-out is a stand already)
    const hangout = hangoutOf(p);
    if (hangout) {
        if (linger) h.nextLinger = now + gap(lingersPerHour(h.persona));
        if (now < h.nextBreak || !hangout.standing || !free(p) || p.hasWaypoints()) return false;
        startSpell(p, h, 'idle', now);
        return true;
    }
    if (!BREAK_KINDS.has(kind) || !free(p)) return false;
    const target = p.target;
    if (target !== null) {
        // AFK-skilling, a break: its tree, rock or fishing spot goes on without it (never a fight's target: a player has
        // a name). Only at the resource, standing: its task works it ('interact'); a ladder, door, gate or booth clicked
        // on a bank walk is no resource (a miner's break began on the Dwarven Mine ladder: it climbed, then stood "away")
        if (now < h.nextBreak || !AFK_SKILL_KINDS.has(kind) || (target as { username?: string }).username !== undefined) return false;
        if (taskState(bot) !== 'interact' || p.hasWaypoints()) return false;
        startSpell(p, h, 'skill', now);
        return true;
    }
    // a stand at its spot (not halfway down a road): within 15 tiles of where its task works
    const at = bot.currentTask?.activityStep()?.location;
    if (p.hasWaypoints() || !at || p.level !== at[2] || Math.max(Math.abs(p.x - at[0]), Math.abs(p.z - at[1])) > 15) return false;
    startSpell(p, h, linger ? 'linger' : 'idle', now);
    return true;
}

/** its task's state ('interact' at its resource, 'bank_walk' ...), or null */
function taskState(bot: BotPlayer): string | null {
    const task = bot.currentTask;
    return task ? (((task as unknown as Record<string, unknown>).state as string | undefined) ?? null) : null;
}

function startSpell(p: Player, h: Habits, kind: SpellKind, now: number): void {
    if (kind === 'linger') {
        h.spell = { kind, start: now, until: now + uniform(LINGER_TICKS), brb: false, hp: p.levels[PlayerStat.HITPOINTS] };
        h.nextLinger = Infinity; // (the next is drawn when this one ends)
    } else {
        // "brb" before a stand, most times (the persona's sociability); not while the engine works on (that one is
        // silent): about half of all breaks
        const brb = kind !== 'skill' && Math.random() < 0.5 + 0.4 * h.persona.sociability;
        h.spell = { kind, start: now, until: now + uniform(brb ? BRB_BREAK_TICKS : BREAK_TICKS), brb, hp: p.levels[PlayerStat.HITPOINTS] };
        h.nextBreak = Infinity;
        if (brb) sayOccasion(p, 'brb');
    }
    h.watch = null;
    if (kind !== 'skill') {
        p.clearWaypoints();
        // (a linger on a tile another player stands on, a booth's or a range's: a step to a free one of its own first; a
        // short break is taken where the bot stands, as a player goes AFK where it is)
        if (kind === 'linger' && sharesTile(p)) {
            const tile = claimStandTile(p, p.x, p.z, p.level, 2);
            if (tile) {
                h.spell!.claimed = true;
                stepToTile(p, tile[0], tile[1]);
            }
        }
    }
}

function endSpell(p: Player, h: Habits, now: number, reason: BreakEnd): void {
    const spell = h.spell!;
    const done = reason === 'done';
    h.spell = null;
    // (the tile it stepped to for a linger, back)
    if (spell.claimed) releaseStandTile(p);
    h.lastBreak = { kind: spell.kind, start: spell.start, end: now, reason };
    if (spell.kind === 'linger') h.nextLinger = now + gap(lingersPerHour(h.persona));
    else h.nextBreak = now + gap(breaksPerHour(h.persona));
    if (done && spell.brb && Math.random() < BACK_CHANCE) sayOccasion(p, 'back');
}

function tickSpell(p: Player, h: Habits, now: number): boolean {
    const spell = h.spell!;
    const cut = interrupted(p, spell.hp);
    if (cut) {
        endSpell(p, h, now, cut);
        return false;
    }
    spell.hp = p.levels[PlayerStat.HITPOINTS];
    if (now >= spell.until) {
        endSpell(p, h, now, 'done');
        return false;
    }
    return true;
}

/**
 * A task's stop at a bank booth (its 'ready' wait before the deposit): how long the bot stands there (a person's 3-20 s,
 * BotTiming 'bank'). A break that is due may begin here (an AFK at the bank), or a linger.
 */
export function bankStop(bot: Player): number {
    const h = habitsOf(bot);
    const ticks = reactionTicks(h.persona, 'bank');
    const now = World.currentTick;
    // (the realism work, phase 3: a hang-out at this bank when one is due, port/BotHangout: its sub-task, its plan after)
    // (the variety work, round 2, the fixes: and no sub-task holding the bot: a hosted errand's bank step (a quest
    // look-alike, picking, flour) is the sub-task, and the hang-out put in its place ended it, a look-alike done for the
    // session; a rest's food fetch, a fight for an errand likewise)
    const ai = (bot as unknown as { _bot?: BotPlayer })._bot;
    if (h.levelling && !h.spell && !h.leaving && free(bot) && !ai?.hasSubTask()) {
        const hangout = ai ? hangoutAtBank(bot) : null;
        if (hangout) {
            ai!.setSubTask(hangout);
            h.nextLinger = Math.max(h.nextLinger, now + gap(lingersPerHour(h.persona)));
            return ticks;
        }
    }
    if (h.levelling && !h.spell && !h.leaving && (now >= h.nextLinger || now >= h.nextBreak) && free(bot)) startSpell(bot, h, now >= h.nextLinger ? 'linger' : 'bank', now);
    return ticks;
}

// ── a look at something ────────────────────────────────────────────────────────

/** What draws a look: a fight between players (a PK: its start, and the kill with its drop), a level-up cheer, a dance. */
export type Spectacle = 'pk' | 'cheer' | 'dance';

/**
 * `subject` did something worth a look (port/BotEmote's cheer and dance, a PKer's attack or kill): free levelling bots
 * within WATCH_RANGE may stop and face it for a few seconds. A loop over the players, for a rare event.
 */
export function noteSpectacle(subject: Player, _what: Spectacle): void {
    const now = World.currentTick;
    for (const p of World.playerLoop.all()) {
        if (p === subject || p.is_bot !== true || p.level !== subject.level) continue;
        if (Math.max(Math.abs(p.x - subject.x), Math.abs(p.z - subject.z)) > WATCH_RANGE) continue;
        const h = habits.get(p);
        if (!h || !h.levelling || h.spell || h.watch || h.leaving || now < h.nextWatch) continue;
        if (Math.random() >= WATCH_CHANCE * h.persona.curiosity * testRates.watch) continue;
        // (not one at work: a skiller keeps chopping and looks without stopping)
        if (p.target !== null || !free(p)) continue;
        const start = now + 1 + reactionTicks(h.persona, 'notice');
        h.watch = { start, until: start + uniform(WATCH_TICKS), subject, x: subject.x, z: subject.z, begun: false };
        h.nextWatch = now + uniform(WATCH_COOLDOWN);
    }
}

function tickWatch(p: Player, h: Habits, now: number): boolean {
    const w = h.watch!;
    if (now < w.start) return false; // (it has not looked up yet: it plays on)
    if (now >= w.until || p.target !== null || interrupted(p, p.levels[PlayerStat.HITPOINTS]) !== null) {
        h.watch = null;
        return false;
    }
    const first = !w.begun;
    if (first) {
        w.begun = true;
        p.clearWaypoints();
    }
    const s = w.subject;
    // (it turns with what it watches while that is near; gone off, the look ends: as it looks up it still turns to
    // where the stir was)
    if (s.slot !== -1 && s.level === p.level && Math.max(Math.abs(s.x - p.x), Math.abs(s.z - p.z)) <= WATCH_RANGE + 4) {
        w.x = s.x;
        w.z = s.z;
    } else if (!first) {
        h.watch = null;
        return false;
    }
    if (first || (now - w.start) % 2 === 0) p.faceSquare(w.x, w.z);
    return true;
}

// ── leaving like a player ──────────────────────────────────────────────────────

/** What a gatherer keeps in its pack at the bank before it logs out: its tools, coins, bait, food. */
function keepIds(bot: BotPlayer): number[] {
    const step = bot.currentTask?.activityStep() ?? null;
    const keep = [Items.COINS, Items.KNIFE, Items.TINDERBOX, ...FOOD_IDS, ...(step?.toolItemIds ?? [])];
    if (step?.itemConsumed) keep.push(step.itemConsumed);
    return keep;
}

/** Does the pack hold something to bank (anything but `keep`)? */
function hasLoad(p: Player, keep: readonly number[]): boolean {
    const inv = p.getInventory(InvType.INV);
    if (!inv) return false;
    for (let slot = 0; slot < inv.capacity; slot++) {
        const item = inv.get(slot);
        if (item && !keep.includes(item.id)) return true;
    }
    return false;
}

function startLeaving(bot: BotPlayer, now: number): Leaving {
    const p = bot.player;
    const kind = bot.currentTask?.name.split(':')[0] ?? '';
    const leaving: Leaving = { phase: 'finish', since: now, asked: now, until: now + uniform(FINISH_TICKS), walkUntil: now + uniform(FINISH_WALK_TICKS), bank: null };
    if (GATHERING_KINDS.has(kind) && p.level === 0) {
        const keep = keepIds(bot);
        const [bx, bz, bl] = nearestBank(p);
        if (bl === p.level && Math.max(Math.abs(p.x - bx), Math.abs(p.z - bz)) <= BANK_FIRST_RANGE && hasLoad(p, keep)) {
            leaving.phase = 'bank';
            leaving.bank = new LeaveBankTask(keep);
            bot.setSubTask(leaving.bank);
        }
    }
    return leaving;
}

/**
 * BotManager._endSession, every tick once the bot's session is over and nothing keeps it: true when it logs out now.
 * Meanwhile it wraps up as a player does (banks a load, finishes what it does, stands, now and then says goodbye), for
 * at most WRAP_UP_MAX ticks.
 */
export function readyToLeave(bot: BotPlayer): boolean {
    const p = bot.player;
    const h = habitsOf(p);
    const now = World.currentTick;
    let w = h.leaving;
    // (a wrap-up left off long ago: the session was put off since, a fight kept the bot here)
    if (w && now - w.asked > 50) w = h.leaving = null;
    if (!w) {
        h.watch = null;
        // on a break past its session: 274's idle timer logs it out where it stands
        if (h.spell) {
            const away = h.spell.kind !== 'linger';
            h.lastBreak = { kind: h.spell.kind, start: h.spell.start, end: now, reason: 'leaving' };
            h.spell = null;
            if (away) return true;
        }
        if (Math.random() < ABRUPT_SHARE * testRates.abrupt) return true;
        w = h.leaving = startLeaving(bot, now);
    }
    w.asked = now;
    if (now - w.since >= WRAP_UP_MAX) return left(h);
    switch (w.phase) {
        case 'bank':
            // banked (its stop at the booth next), or its bank trip came to nothing (BotPlayer no longer runs it)
            if (w.bank!.banked || now - w.bank!.lastTick > 5) {
                w.phase = 'stand';
                w.until = now + reactionTicks(h.persona, 'bank');
            }
            return false;
        case 'finish':
            if (now >= w.until || (p.target === null && !p.delayed && (!p.hasWaypoints() || now >= w.walkUntil))) {
                // it stops: its interaction and its walk
                p.clearInteraction();
                p.clearWaypoints();
                w.phase = 'stand';
                w.until = now + 1 + reactionTicks(h.persona, 'notice');
            }
            return false;
        case 'stand':
            if (now < w.until) return false;
            if (Math.random() < 0.15 + 0.4 * h.persona.sociability && playersNear(p)) {
                sayOccasion(p, 'departure');
                w.phase = 'bye';
                w.until = now + uniform(BYE_TICKS);
                return false;
            }
            return left(h);
        case 'bye':
            return now >= w.until ? left(h) : false;
    }
}

function left(h: Habits): boolean {
    h.leaving = null;
    return true;
}

/** While BotManager wraps the bot up: it holds still (but defends itself: a hit lets its tick go on), or banks. */
function holdLeaving(p: Player, h: Habits): boolean {
    const w = h.leaving!;
    if (w.phase === 'bank') return false; // (its bank trip is a subtask: BotPlayer runs it, self-defence first)
    if (World.currentTick < p.preventLogoutUntil || findAggressorNpc(p, 8) !== null) return false;
    return true;
}
