// port (the realism work, phase 5b, Track A: the Duel Arena; the set piece "the Duel Arena (members): bots stake
// and duel, spectators throw tomatoes, small-stake challenges to the human"
// "Round 5b"): the arena's life, always there on a members world.
//   - Visits: the planner offers a combat 20+ levelling bot with 5k+ coins within 900 tiles and 25+ minutes of its session
//     left a visit (tasks/DuelArenaTask) every 1-2 hours of its play (by name, over its sessions), for 20-45 minutes, 60 %
//     to stake (under 3.3k coins it watches: too few for a 1k stake at 30 %) and 40 % to watch, while the arena has room
//     (8 per 100 online, 24 in all). (The defaults said every 3-6 hours, for 4-8 bots at 100 online; only 12-17 of 100
//     online bots are combat 20+ with 5k+ coins within reach, and 3-6 hours made about 1: data/duel.json.)
//   - The registry: the bots on a visit, so a partner's search never scans the world; the duels under way (spectators
//     look for one; the log keeps each duel: its stake, rules, winner, spectators, tomatoes).
//   - Deals between bots: a staker's call is its offer ("fight 5k no rules": callOffer); two free stakers within 25 tiles
//     and 15 combat levels of each other agree one, the challenger toggles the rules and both stake through the real
//     screens (port/BotDuel). Stakes are zero-sum: a quarter none, the rest log-uniform 1k-100k, at most a tenth of the
//     poorer bot's coins.
//   - The human (2026-10-16): only while they stand in the challenge area, the first challenge 30-120
//     s after they come and the next at least 5 minutes on, from a free staker within 10 tiles at full Hitpoints whose
//     combat is at least theirs minus 3 (the defaults' rule, no more: a stronger bot may challenge them too, and they may
//     say no); coins only, mirrored, at most min(25k, 10 % of the bot's
//     coins, the purse); the purse keeps the human's net winnings from bots to 50k per hour of play; never again from a
//     bot the human refused, ignored or beat. Their own "stake?" or "box me" near a staker may get a "sure" and a
//     challenge, their "no" to a challenge a "k". Losing to bots is the human's own risk, as in 2004.
//   - The director's big stake (duel_stake, a SetPieceDef: port/BotSetPieces): two rich regulars agree 50k-1m (at most
//     half the poorer's coins), up to 12 bots within 80 tiles come and watch, the winner crows.
// Every line here is the set piece's own (kind 'setpiece': out of the humanlike report's H7, counted as X2), from
// data/lines2004-arena.json, in the speaker's style, and it takes the place of the persona's next line (the talk budget).
// No staging round the human: visits come from the bots' own plans, and the human is challenged only where they stand.
//
// Per tick: nothing of its own; a staker's task asks here a few times a minute (the registry is the bots on a visit, at
// most 24), the human's presence is looked up at most every 5 ticks.
import type Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { coinsOwned } from '#/engine/bot/BotNeeds.js';
import { botSay, type LineKind } from '#/engine/bot/port/BotSay.js';
import { humanLineListeners } from '#/engine/bot/port/BotChat.js';
import { countAsBudgetedLine } from '#/engine/bot/port/BotChatter.js';
import { styleLine } from '#/engine/bot/port/BotStyle.js';
import { botPersona, typingTicks } from '#/engine/bot/port/BotTiming.js';
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import { scheduleInTicks } from '#/engine/bot/port/BotSchedule.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { eventRoleOf, register, registerPlannerHook, nextSetPieceId, type SetPieceContext, type SetPieceDef, type SetPiecePhase, type SetPiecePlan, type SetPieceRun, type SetPieceVenue } from '#/engine/bot/port/BotSetPieces.js';
import { duelScreen, duelStatus, DuelStatus, inChallengeArea, inDuelArena, inFightZone, ruleBits, type DuelDeal, type DuelFacts, type DuelVoice } from '#/engine/bot/port/BotDuel.js';
import { tradeScreen } from '#/engine/bot/port/BotTradeScreen.js';
import { standTileOf } from '#/engine/bot/port/BotTiles.js';
import { DuelArenaTask, type ArenaRole } from '#/engine/bot/tasks/DuelArenaTask.js';
import duelJson from '../../data/duel.json';
import linesJson from '../../data/lines2004-arena.json';

// ── the numbers (data/duel.json) ─────────────────────────────────────────────────────────────────────────────────────

interface RuleSet {
    key: string;
    bits: number[];
    weight: number;
}
export const ARENA = duelJson as unknown as {
    places: { bank: [number, number]; approach: [number, number]; tollGate: [number, number]; fenceX: number; crate: [number, number]; hospital: [number, number, number, number]; stakeSpots: [number, number, number, number][]; idleSpot: [number, number, number] };
    rules: RuleSet[];
    stakes: { none: number; min: number; max: number; share: [number, number] };
    human: { cap: number; share: number; purse: number; purseTicks: number; first: [number, number]; gap: [number, number]; answerTicks: number; noTicks: number; below: number; reach: number; caps: number[] };
    visit: { gap: [number, number]; length: [number, number]; minCombat: number; minCoins: number; sessionLeft: number; stakers: number; perHundred: number; cap: number; range: number; carry: number; food: [number, number] };
    staker: { call: [number, number]; search: [number, number]; reach: number; combat: number; losses: [number, number] };
    watch: { tomatoShare: number; throws: [number, number]; gap: number; buy: [number, number]; reach: number; shout: number; emote: number };
    bigStake: { min: number; max: number; share: number; minCoins: number; minCombat: number; combat: number; crowd: number; radius: number; spectators: number; minutes: number };
};
const RULE_SETS = ARENA.rules.map(r => ({ ...r, options: ruleBits(r.bits) }));
/** the rules a call names ("melee only", "box", "no move", "no rules") */
const RULE_WORDS: readonly [RegExp, string][] = [
    [/\bno rules\b/, 'none'],
    [/\bmelee\b/, 'melee'],
    [/\bbox\b/, 'box'],
    [/\bno move\b/, 'nomove']
];
/** the middle of the complex: the venue of the director's big stake, and where a visit's walk ends (Fadli's chests) */
export const ARENA_CENTRE: readonly [number, number] = [3360, 3250];

export function rand(lo: number, hi: number): number {
    return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** log-uniform in [lo, hi] */
function logUniform(lo: number, hi: number): number {
    if (hi <= lo) return lo;
    return Math.round(Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * Math.random()));
}

// ── the lines (data/lines2004-arena.json) ───────────────────────────────────────────────────────────────────────────

interface Group {
    tag: { event?: string; kinds?: string[] };
    lines: string[];
}
const GROUPS = (linesJson as unknown as { groups: Group[] }).groups;
const poolCache = new Map<string, readonly string[]>();

/**
 * The lines of a moment of data/lines2004-arena.json: 'duel-won' and its variant 'close' are the event duel's kind
 * won-close, 'mod-scam' the event mod's kind scam (the file has two events: no idle pick ever fits them).
 */
export function arenaLines(moment: string, variant = ''): readonly string[] {
    const key = `${moment}|${variant}`;
    let pool = poolCache.get(key);
    if (!pool) {
        const cut = moment.indexOf('-');
        const event = moment.slice(0, cut);
        const kind = moment.slice(cut + 1) + (variant ? `-${variant}` : '');
        pool = GROUPS.filter(g => g.tag.event === event && g.tag.kinds?.includes(kind) === true).flatMap(g => g.lines);
        poolCache.set(key, pool);
    }
    return pool;
}

/** a bot's last line here (not the same twice in a row) */
const lastSaid = new WeakMap<Player, string>();

function pickFrom(bot: Player, pool: readonly string[]): string | null {
    if (pool.length === 0) return null;
    const last = lastSaid.get(bot);
    const fresh = pool.length > 1 ? pool.filter(l => l !== last) : pool;
    return fresh[Math.floor(Math.random() * fresh.length)];
}

export interface SayOptions {
    /** whom it is to (the human, a bot) */
    to?: Player | null;
    /** typed: said after the bot's typing time (an answer); else at once (a call it typed already) */
    typed?: boolean;
    /** the line as written (the mod's proper sentences): no style layer */
    plain?: boolean;
    kind?: LineKind;
    /** extra ticks before typing starts */
    delay?: number;
}

/**
 * The bot says `text` (a set piece's own line: kind 'setpiece' unless told), in its persona's style, at once or after its
 * typing time; it takes the place of its persona's next line (port/BotChatter.countAsBudgetedLine). The text of what
 * was said, or null when the bot is gone.
 */
export function sayArenaText(bot: Player, text: string, opts: SayOptions = {}): void {
    if (bot.slot === -1 || !bot.is_bot) return;
    const persona = botPersona(bot);
    const styled = opts.plain ? { line: text, correction: null } : styleLine(text, persona);
    const kind = opts.kind ?? 'setpiece';
    const speak = (): void => {
        if (bot.slot === -1 || !bot.is_bot || BotManager.botFor(bot) === null) return;
        botSay(bot, styled.line, undefined, kind, opts.to ?? null);
        countAsBudgetedLine(bot);
        if (styled.correction !== null) {
            const correction = styled.correction;
            scheduleInTicks(2 + Math.floor(Math.random() * 3), () => {
                if (bot.slot !== -1 && BotManager.botFor(bot) !== null) botSay(bot, correction, undefined, kind, opts.to ?? null);
            });
        }
    };
    lastSaid.set(bot, text);
    const wait = (opts.delay ?? 0) + (opts.typed ? typingTicks(persona, styled.line) : 0);
    if (wait <= 0) speak();
    else scheduleInTicks(wait, speak);
}

/** A line of the event's pool (data/lines2004-arena.json), said as sayArenaText says it; the text, or null (no line). */
export function sayArena(bot: Player, event: string, variant = '', opts: SayOptions = {}): string | null {
    const text = pickFrom(bot, arenaLines(event, variant));
    if (text === null) return null;
    sayArenaText(bot, text, opts);
    return text;
}

/** The screens' voice of a duel with the human (port/BotDuel's DuelVoice): typed, as a person answers on the screen. */
export function duelVoice(to: Player | null): DuelVoice {
    return {
        say(bot, pool, cap) {
            if (pool === 'max') {
                // (the line naming its cap: "max 20k"; its cap is one of the lines' sums, humanCap)
                const text = arenaLines('duel-screen', 'max').find(l => callOffer(l).stake === cap);
                if (text) sayArenaText(bot, text, { to, typed: true });
                return;
            }
            // (a hello, the accept: now and then only; the refusals always)
            if ((pool === 'hello' || pool === 'accept') && Math.random() < 0.5) return;
            sayArena(bot, 'duel-screen', pool, { to, typed: true });
        }
    };
}

/** What a call offers: its stake ("10k stake": 10,000; none named: undefined) and rules ("melee only": the melee set). */
export function callOffer(text: string): { stake?: number; rules?: string } {
    const lower = text.toLowerCase();
    const m = lower.match(/\b(\d+)k\b/);
    const rules = RULE_WORDS.find(([rx]) => rx.test(lower))?.[1];
    return { stake: m ? Number(m[1]) * 1000 : undefined, rules };
}

/** a rule set's options by key */
export function rulesOf(key: string): number {
    return RULE_SETS.find(r => r.key === key)?.options ?? 0;
}

/** a rule set drawn by the weights (none 40, melee only 35, box 15, no movement 10) */
export function drawRules(): number {
    const total = RULE_SETS.reduce((s, r) => s + r.weight, 0);
    let roll = Math.random() * total;
    for (const r of RULE_SETS) {
        roll -= r.weight;
        if (roll <= 0) return r.options;
    }
    return RULE_SETS[0].options;
}

/**
 * The most a bot stakes against another bot: its share of its coins (in the bank and the pack), within what it carries.
 * port (the variety work, round 1, track F: ISS-8): 30-50 % (`share`, drawn each deal: data/duel.json); a tenth before,
 * which with the log-uniform draw below made a median stake of 1.2-1.7k (A3b's band 2k-50k): the visitors' carry (30 %
 * of their coins) is the bound now. The human's caps are apart (humanCap).
 */
export function stakeRoom(bot: Player, carried: number, share = stakeShare()): number {
    return Math.min(carried, Math.floor(coinsOwned(bot) * share), ARENA.stakes.max);
}

/** (variety round 1, F) a bot's share of its coins for a deal: uniform within data/duel.json's stakes.share */
export function stakeShare(): number {
    const [lo, hi] = ARENA.stakes.share;
    return lo + Math.random() * (hi - lo);
}

/**
 * The stake two bots agree (zero-sum) when no call named one: none `stakes.none` of the time (0.35: with the named
 * stakes, about a quarter of all duels), else log-uniform 1k-100k within both bots' room (the poorer's: 30-50 % of its
 * coins since the variety work's round 1, track F), a round sum; 0 when no stake fits.
 */
export function drawStake(roomA: number, roomB: number): number {
    if (Math.random() < ARENA.stakes.none) return 0;
    const room = Math.min(roomA, roomB);
    if (room < ARENA.stakes.min) return 0;
    const stake = logUniform(ARENA.stakes.min, Math.min(ARENA.stakes.max, room));
    // (people stake round sums: 1k, 2.5k, 10k ...)
    const round = stake >= 10000 ? 1000 : stake >= 2000 ? 500 : 100;
    return Math.max(ARENA.stakes.min, Math.min(room, Math.round(stake / round) * round));
}

// ── the registry ─────────────────────────────────────────────────────────────────────────────────────────────────────

const visitors = new Map<Player, DuelArenaTask>();

/**
 * A bot's visit begins (DuelArenaTask's first tick), or goes on: a visit's task calls it every tick, so a visitor that a
 * big stake took for its part (a sub-task, its own entry here while it lasts, gone with it) is found again after.
 */
export function joinArena(bot: Player, task: DuelArenaTask): void {
    if (visitors.get(bot) !== task) visitors.set(bot, task);
    ensureListeners();
}

/** A bot's visit is over (its task done, reset or replaced, the bot gone). */
export function leaveArena(bot: Player, task?: DuelArenaTask): void {
    if (!task || visitors.get(bot) === task) visitors.delete(bot);
}

/** The bots on a visit now (a bot that left the world, or whose task this no longer is, drops out). */
export function arenaVisitors(): [Player, DuelArenaTask][] {
    const out: [Player, DuelArenaTask][] = [];
    for (const [bot, task] of visitors) {
        const ai = BotManager.botFor(bot) as unknown as { currentTask?: unknown; subTask?: unknown } | null;
        if (bot.slot === -1 || !ai || (ai.currentTask !== task && ai.subTask !== task)) visitors.delete(bot);
        else out.push([bot, task]);
    }
    return out;
}

export function arenaCount(): number {
    return arenaVisitors().length;
}

/**
 * Where a staker stands: a stake spot (x, z, radius) drawn by its weight times 1 + 2 a visitor there or bound for it, so
 * the stakers gather in a crowd (2004's), the walkway between the arenas first
 */
export function pickStakeSpot(bot: Player): [number, number, number] {
    const spots = ARENA.places.stakeSpots;
    // (the others where they stand, or where they are bound: the tile each holds)
    const others = arenaVisitors()
        .filter(([p]) => p !== bot)
        .map(([p]) => standTileOf(p) ?? [p.x, p.z, p.level]);
    const weights = spots.map(([x, z, r, w]) => w * (1 + 2 * others.filter(([ox, oz, ol]) => ol === 0 && Math.max(Math.abs(ox - x), Math.abs(oz - z)) <= r + 4).length));
    let roll = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < spots.length; i++) {
        roll -= weights[i];
        if (roll <= 0) return [spots[i][0], spots[i][1], spots[i][2]];
    }
    return [spots[0][0], spots[0][1], spots[0][2]];
}

/** How many may visit at once: 8 per 100 online, at most 24 (and 2 at the least) */
export function arenaCap(): number {
    const online = BotManager.stats().configured;
    return Math.min(ARENA.visit.cap, Math.max(2, Math.round((ARENA.visit.perHundred * online) / 100)));
}

// ── the duels (their log, the ones under way) ───────────────────────────────────────────────────────────────────────

export interface DuelRecord {
    id: number;
    a: string;
    b: string;
    /** which side is the human (null: two bots) */
    human: 'a' | 'b' | null;
    stake: number;
    rules: number;
    /** the tick the fight began, ended (-1 while it runs) */
    start: number;
    end: number;
    winner: string | null;
    outcome: string;
    forfeit: boolean;
    /** the most players watching within 10 tiles (outside the arenas), during the fight */
    spectators: number;
    tomatoes: number;
    x: number;
    z: number;
    big: boolean;
}

const LOG_MAX = 2000;
/** every duel that came to a fight, oldest first (a capped ring): the humanlike report's A2-A5, the tests */
export const duelLog: DuelRecord[] = [];
let nextDuel = 1;

interface LiveDuel {
    record: DuelRecord;
    a: Player;
    b: Player;
    lastSample: number;
}
const live = new Map<number, LiveDuel>();

/** The duels whose fight is on now (a spectator's pick), oldest first. */
export function liveDuels(): readonly LiveDuel[] {
    for (const [id, d] of live) if (d.record.end >= 0 || World.currentTick - d.record.start > 6200) live.delete(id);
    return [...live.values()];
}

/** The fight of a duel began (each side's session says so; the first makes the record). */
export function noteDuelStart(bot: Player, partner: Player, facts: DuelFacts, big = false): DuelRecord {
    for (const d of live.values()) if ((d.a === bot && d.b === partner) || (d.a === partner && d.b === bot)) return d.record;
    const record: DuelRecord = {
        id: nextDuel++,
        a: bot.username,
        b: partner.username,
        human: partner.is_bot === true ? null : 'b',
        stake: facts.stake,
        rules: facts.rules,
        start: facts.fightAt,
        end: -1,
        winner: null,
        outcome: '',
        forfeit: false,
        spectators: 0,
        tomatoes: 0,
        x: bot.x,
        z: bot.z,
        big
    };
    duelLog.push(record);
    if (duelLog.length > LOG_MAX) duelLog.shift();
    live.set(record.id, { record, a: bot, b: partner, lastSample: -1 });
    return record;
}

/** The duel `bot` is fighting now, or null. */
export function liveDuelOf(bot: Player): LiveDuel | null {
    for (const d of live.values()) if (d.a === bot || d.b === bot) return d;
    return null;
}

/** A duellist's side is over: who won (the bot's view), whether it forfeited. */
export function noteDuelEnd(bot: Player, outcome: string, facts: DuelFacts): void {
    const d = liveDuelOf(bot);
    if (!d) return;
    const r = d.record;
    if (facts.forfeit) r.forfeit = true;
    if (r.end < 0 || r.winner === null) {
        if (outcome === 'won') r.winner = bot.username;
        else if (outcome === 'lost') r.winner = d.a === bot ? d.b.username : d.a.username;
        if (r.outcome === '' || outcome === 'won' || outcome === 'lost') r.outcome = outcome === 'won' || outcome === 'lost' ? 'done' : outcome;
        r.end = facts.endedAt >= 0 ? facts.endedAt : World.currentTick;
    }
    // (the other side's session ends too: the record stays live until both are done, or the human's side, which has none)
    const other = d.a === bot ? d.b : d.a;
    if (!other.is_bot || !liveSession(other)) live.delete(r.id);
}

function liveSession(p: Player): boolean {
    const task = visitors.get(p) ?? null;
    return task !== null && task.inDuel();
}

/** Every 10 ticks of a fight: the players watching it (within 10 tiles of either duellist, not in an arena). */
export function sampleSpectators(bot: Player): void {
    const d = liveDuelOf(bot);
    if (!d || d.record.end >= 0 || World.currentTick - d.lastSample < 10) return;
    d.lastSample = World.currentTick;
    let n = 0;
    for (const p of World.playerLoop.all()) {
        if (p === d.a || p === d.b || p.level !== 0 || inFightZone(p.x, p.z, p.level)) continue;
        if (Math.max(Math.abs(p.x - d.a.x), Math.abs(p.z - d.a.z)) <= 10 || Math.max(Math.abs(p.x - d.b.x), Math.abs(p.z - d.b.z)) <= 10) n++;
    }
    if (n > d.record.spectators) d.record.spectators = n;
}

// ── the human (small stakes, nothing to farm) ────────────────────────────────────────────────────

interface HumanAtArena {
    name: string;
    /** play-ish world ticks: when they came into the challenge area (-1: not there), when last seen there */
    enteredAt: number;
    seenAt: number;
    /** the next challenge from a bot is not before this */
    nextAt: number;
    /** bots that challenged them and were refused or ignored, and bots they beat: never again (this run) */
    refused: Set<string>;
    beaten: Set<string>;
    /** a bot's challenge waiting for their click (or their "no") */
    pending: { bot: Player; at: number } | null;
}
const humans = new Map<string, HumanAtArena>();

export interface ChallengeRecord {
    t: number;
    bot: string;
    human: string;
    /** 'accepted' (the screens opened), 'refused' (their "no"), 'ignored' (no answer in 60 s), '' while it waits */
    answer: string;
    /** 'bot' (the bot's own challenge) or 'call' (the human's "stake?" answered), 'human' (the human challenged the bot) */
    from: 'bot' | 'call' | 'human';
}
/** every challenge between a bot and the human (A6), oldest first */
export const challengeLog: ChallengeRecord[] = [];

/** the human's net coins from duels with bots (+ they won a stake, - they lost one), by play tick */
const purse: { t: number; human: string; net: number }[] = [];

let playAt = -1;
let playNow = 0;
/** the play clock (BotManager.stats: a loop over the pool), read once a tick at most */
function playTicks(): number {
    if (World.currentTick !== playAt) {
        playAt = World.currentTick;
        playNow = BotManager.stats().playTicks;
    }
    return playNow;
}

/** What the human may still win from bots in the purse's window (50k per hour of play, net). */
export function purseLeft(human: string): number {
    const since = playTicks() - ARENA.human.purseTicks;
    let net = 0;
    for (const e of purse) if (e.human === human && e.t >= since) net += e.net;
    return Math.max(0, ARENA.human.purse - Math.max(0, net));
}

/**
 * The most a bot stakes against this human (0: none): min(25k, a tenth of its coins, the purse left, what it carries),
 * down to the nearest of 1k, 2k, 3k, 5k, 10k, 15k, 20k, 25k (its "max 10k" says it)
 */
export function humanCap(bot: Player, human: Player, carried: number): number {
    const top = Math.min(ARENA.human.cap, Math.floor(coinsOwned(bot) * ARENA.human.share), purseLeft(human.username), carried);
    let cap = 0;
    for (const c of ARENA.human.caps) if (c <= top) cap = c;
    return cap;
}

// ── across a restart (BotManager's world state: "small stakes, nothing to farm") ──────────────────────────

interface SavedArena {
    v: 1;
    /** the purse's entries still in its window: play ticks ago, the human, the net */
    purse: { ago: number; human: string; net: number }[];
    /** the bots each human beat (never again; a refusal is this run's only: a bot may ask again another day) */
    beaten: { human: string; bots: string[] }[];
}

/** What a restart must not forget (`play`: BotManager's play clock now): the purse's window, the bots the human beat. */
export function exportArena(play: number): unknown {
    const since = play - ARENA.human.purseTicks;
    const kept = purse.filter(e => e.t >= since);
    const beaten = [...humans.values()].filter(h => h.beaten.size > 0).map(h => ({ human: h.name, bots: [...h.beaten] }));
    if (kept.length === 0 && beaten.length === 0) return null;
    const saved: SavedArena = { v: 1, purse: kept.map(e => ({ ago: Math.max(0, play - e.t), human: e.human, net: e.net })), beaten };
    return saved;
}

/** The last run's purse and beaten bots, if the store had them (`play`: BotManager's play clock at the restore). */
export function restoreArena(state: unknown, play: number): void {
    const s = state as Partial<SavedArena> | null | undefined;
    if (!s || typeof s !== 'object' || s.v !== 1) return;
    for (const e of Array.isArray(s.purse) ? s.purse.slice(-500) : []) {
        if (!e || typeof e.human !== 'string' || typeof e.ago !== 'number' || typeof e.net !== 'number' || !Number.isFinite(e.ago) || !Number.isFinite(e.net)) continue;
        purse.push({ t: play - Math.max(0, Math.min(ARENA.human.purseTicks, Math.floor(e.ago))), human: e.human, net: e.net });
    }
    for (const b of Array.isArray(s.beaten) ? s.beaten : []) {
        if (!b || typeof b.human !== 'string' || !Array.isArray(b.bots)) continue;
        const h = humanOf(b.human);
        for (const name of b.bots) if (typeof name === 'string') h.beaten.add(name);
    }
}

/** (tests) a fresh start for the humans' state: no purse, no names (as a restart without the store) */
export function forgetHumansForTest(): void {
    humans.clear();
    purse.length = 0;
}

/** a duel with the human ended: the purse, and a bot the human beat never stakes them again */
export function noteHumanDuel(human: string, bot: string, outcome: string, stake: number): void {
    const t = playTicks();
    if (outcome === 'lost') {
        purse.push({ t, human, net: stake });
        humanOf(human).beaten.add(bot);
    } else if (outcome === 'won') purse.push({ t, human, net: -stake });
    while (purse.length > 500) purse.shift();
}

function humanOf(name: string): HumanAtArena {
    let h = humans.get(name);
    if (!h) {
        h = { name, enteredAt: -1, seenAt: -1, nextAt: 0, refused: new Set(), beaten: new Set(), pending: null };
        humans.set(name, h);
    }
    return h;
}

let humansSeenAt = -1;
let humansThere: Player[] = [];
/** The humans in the challenge area now (looked up at most every 5 ticks); each one's arrival noted. */
export function humansInArea(): readonly Player[] {
    const now = World.currentTick;
    if (now - humansSeenAt < 5 && humansSeenAt >= 0) return humansThere;
    humansSeenAt = now;
    humansThere = [];
    for (const p of World.playerLoop.all()) {
        if (p.is_bot === true || !inChallengeArea(p.x, p.z, p.level)) continue;
        humansThere.push(p);
        const h = humanOf(p.username);
        // (back after a while away: the first challenge 30-120 s after they come, never before the gap since the last)
        if (h.enteredAt < 0 || now - h.seenAt > 100) {
            h.enteredAt = now;
            h.nextAt = Math.max(h.nextAt, now + rand(ARENA.human.first[0], ARENA.human.first[1]));
        }
        h.seenAt = now;
    }
    for (const h of humans.values()) if (now - h.seenAt > 100) h.enteredAt = -1;
    return humansThere;
}

/** the human is free for a duel: no screen, no dialogue or delay, not in a duel or a trade */
export function humanFree(human: Player): boolean {
    if (human.slot === -1 || human.delayed || human.modalMain !== -1 || human.activeScript !== null) return false;
    if (tradeScreen(human) !== null) return false;
    const status = duelStatus(human);
    return status === DuelStatus.RESET || status === DuelStatus.RECEIVED;
}

export function fullHp(p: Player): boolean {
    return p.levels[PlayerStat.HITPOINTS] >= p.baseLevels[PlayerStat.HITPOINTS];
}

/** a challenge to the human older than its answer's 60 s by this much is over, whatever its bot did (ticks) */
const PENDING_GRACE = 100;

/**
 * A free staker asks: may it challenge a human now? The human within 10 tiles in the challenge area, the challenge due
 * (30-120 s after they came, 5+ minutes after the last), free, the bot's combat at least theirs minus 3 and it unhurt,
 * never refused, ignored or beaten by them, the purse not spent. The human (the challenge is noted: the next one 5-7
 * minutes on) or null.
 */
export function challengeHumanNow(bot: Player, carried: number): { human: Player; cap: number } | null {
    const now = World.currentTick;
    const why = challengeStats.why;
    for (const human of humansInArea()) {
        challengeStats.asked++;
        if (human.level !== bot.level || Math.max(Math.abs(human.x - bot.x), Math.abs(human.z - bot.z)) > ARENA.human.reach) {
            why.far++;
            continue;
        }
        const h = humanOf(human.username);
        // (a challenge whose bot left, or that outlived the 60 s answer by a margin, never reached its end: unreached)
        if (h.pending !== null && (h.pending.bot.slot === -1 || now - h.pending.at > ARENA.human.answerTicks + PENDING_GRACE)) challengeAnswered(h.pending.bot, human, 'unreached');
        if (now < h.nextAt || h.pending !== null) {
            why.notDue++;
            continue;
        }
        if (h.refused.has(bot.username) || h.beaten.has(bot.username)) {
            why.refused++;
            continue;
        }
        if (!humanFree(human)) {
            why.humanBusy++;
            continue;
        }
        if (bot.combatLevel < human.combatLevel - ARENA.human.below) {
            why.lower++;
            continue;
        }
        if (!fullHp(bot)) {
            why.hurt++;
            continue;
        }
        const cap = humanCap(bot, human, carried);
        if (cap <= 0) {
            why.noCap++;
            continue;
        }
        challengeStats.made++;
        h.nextAt = now + rand(ARENA.human.gap[0], ARENA.human.gap[1]);
        h.pending = { bot, at: now };
        challengeLog.push({ t: now, bot: bot.username, human: human.username, answer: '', from: 'bot' });
        return { human, cap };
    }
    return null;
}

/**
 * Why free stakers near a human in the challenge area did not challenge them (a staker and a human a count; the
 * humanlike report's A6 detail): too far, not due (30-120 s after they came, 5+ minutes after the last, one at a time),
 * refused or beaten by them, the human busy, the bot more than 3 levels under them, hurt, no stake allowed.
 */
export const challengeStats = { asked: 0, made: 0, why: { far: 0, notDue: 0, refused: 0, humanBusy: 0, lower: 0, hurt: 0, noCap: 0 } };

/**
 * The bot's challenge to the human is over: their answer ('accepted', 'refused', 'ignored'), or 'unreached' (274 never
 * sent it: a fence between them; no refusal, and the next may come 30-120 s on).
 */
export function challengeAnswered(bot: Player, human: Player, answer: 'accepted' | 'refused' | 'ignored' | 'unreached'): void {
    const h = humanOf(human.username);
    if (h.pending?.bot === bot) h.pending = null;
    if (answer === 'unreached') h.nextAt = World.currentTick + rand(ARENA.human.first[0], ARENA.human.first[1]);
    else if (answer !== 'accepted') h.refused.add(bot.username);
    for (let i = challengeLog.length - 1; i >= 0; i--) {
        const c = challengeLog[i];
        if (c.bot === bot.username && c.human === human.username && c.answer === '') {
            c.answer = answer;
            break;
        }
    }
}

/** May the bot take up the human's own challenge (their click on it, or their "stake?")? Why not, else null. */
export function refuseHuman(bot: Player, human: Player, carried: number): 'higher' | 'purse' | 'beaten' | 'busy' | null {
    const h = humanOf(human.username);
    if (h.beaten.has(bot.username)) return 'beaten';
    if (bot.combatLevel < human.combatLevel - ARENA.human.below) return 'higher';
    if (!fullHp(bot)) return 'busy';
    if (humanCap(bot, human, carried) <= 0) return purseLeft(human.username) < ARENA.human.caps[0] ? 'purse' : 'busy';
    return null;
}

/**
 * A bot takes up the human's own call ("stake?"): its challenge waits for their click as a bot's own does (one at a
 * time: no other staker's challenge meanwhile, the next one 5-7 minutes on).
 */
export function callTakenUp(bot: Player, human: Player): void {
    const h = humanOf(human.username);
    const now = World.currentTick;
    h.pending = { bot, at: now };
    h.nextAt = Math.max(h.nextAt, now + rand(ARENA.human.gap[0], ARENA.human.gap[1]));
}

/** The human challenged a bot (or answered a call): noted for A6's record. */
export function noteHumanChallenge(bot: Player, human: Player, from: 'call' | 'human', answer: string): void {
    challengeLog.push({ t: World.currentTick, bot: bot.username, human: human.username, answer, from });
    while (challengeLog.length > 2000) challengeLog.shift();
}

// ── the human's lines (BotChat.humanLineListeners) ──────────────────────────────────────────────────────────────────

/** "no", "nah", "no ty", "no thanks", "not now", "nope" */
const NO_WORDS = /^(no+|nah+|nope|no ty|no thanks|no thx|not now|nty|n)\b/;
/**
 * "stake?", "stake 10k", "anyone stake", "box me", "fight?", "duel?", "1v1?", "u wanna stake"; a bare "fight" is no call
 * ("good fight", "nice fight" after a duel), "fight?", "wanna fight", "anyone fight", "fight me" are
 */
const CALL_WORDS = /\b(stake|staking|stakes|box|duel|1v1)\b|\bfight\s*\?|\b(wanna|want to|lets|let's|anyone|any1|ne1) fight\b|\bfight (me|anyone|any1)\b/;

let listening = false;
/** (once, lazily: a listener pushed at load could meet BotChat mid-evaluation in an import cycle) */
export function ensureListeners(): void {
    if (listening) return;
    listening = true;
    humanLineListeners.push(onHumanLine);
}

/**
 * A human's line, before the bots near answer: their "no" to a bot's challenge (the bot says "k" and drops it), or
 * their own stake call in the challenge area (a free staker near may say "sure" and challenge them). True when the
 * arena answered it (the other bots keep quiet).
 */
export function onHumanLine(human: Player, text: string): boolean {
    if (!isMembersWorld() || human.is_bot === true) return false;
    const lower = text.toLowerCase().trim();
    const h = humans.get(human.username);
    const now = World.currentTick;
    // a "no" to a challenge just made
    if (h?.pending && now - h.pending.at <= ARENA.human.answerTicks && NO_WORDS.test(lower)) {
        const task = visitors.get(h.pending.bot);
        if (task && task.humanSaidNo(human)) return true;
    }
    // their own call, in the challenge area
    if (!inChallengeArea(human.x, human.z, human.level) || !CALL_WORDS.test(lower)) return false;
    let best: [Player, DuelArenaTask] | null = null;
    let bestD = Infinity;
    for (const [bot, task] of arenaVisitors()) {
        if (!task.canAnswerCall(human)) continue;
        const d = Math.max(Math.abs(bot.x - human.x), Math.abs(bot.z - human.z));
        if (bot.level === human.level && d <= ARENA.human.reach && d < bestD) {
            best = [bot, task];
            bestD = d;
        }
    }
    if (!best) return false;
    return best[1].answerCall(human, callOffer(lower));
}

// ── visits (the planner's hook) ──────────────────────────────────────────────────────────────────────────────────────

interface VisitSchedule {
    /** the bot's play (ticks online) still to come before its next visit is due */
    left: number;
    /** the session that asked last (play is counted within a session: the time away is none) and when */
    session: number;
    at: number;
}
/** a key per session (one Player a session), held weakly: a schedule keeps no Player of a bot that left */
const sessionKeys = new WeakMap<Player, number>();
let nextSessionKey = 1;
function sessionKeyOf(bot: Player): number {
    let key = sessionKeys.get(bot);
    if (key === undefined) sessionKeys.set(bot, (key = nextSessionKey++));
    return key;
}
/**
 * By name, for the process's life: "every 1-2 hours of play" counts a bot's play over its sessions (one Player a
 * session). A schedule by session drew the first visit anew at each login, and most sessions ended before it.
 */
let schedules = new Map<string, VisitSchedule>();
/** (tests) visits this many times as often (every bot's next one drawn again; 0: none); never set by the game */
let testRate = 1;
export function setArenaRatesForTest(rate: number): void {
    testRate = rate;
    schedules = new Map();
}

function gapTicks(): number {
    return Math.round(rand(ARENA.visit.gap[0], ARENA.visit.gap[1]) / testRate);
}

function scheduleOf(bot: Player): VisitSchedule {
    const now = World.currentTick;
    let s = schedules.get(bot.username);
    if (!s) {
        // (a world just started is a world in its middle: a bot first seen is mid-visit as often as its hours make it,
        // the visit's length over the gap and the visit, and its next visit is due now; else it is somewhere in its gap)
        const gap = gapTicks();
        const length = (ARENA.visit.length[0] + ARENA.visit.length[1]) / 2;
        const left = Math.random() < length / (gap + length) ? 0 : Math.round(gap * Math.random());
        s = { left, session: sessionKeyOf(bot), at: now };
        schedules.set(bot.username, s);
    } else if (s.session !== sessionKeyOf(bot)) {
        s.session = sessionKeyOf(bot);
        s.at = now;
    } else {
        s.left -= now - s.at;
        s.at = now;
    }
    return s;
}

/** The visit ended (or never began): the next one 1-2 hours of play on. */
export function visitEnded(bot: Player): void {
    const s = scheduleOf(bot);
    s.left = gapTicks();
}

/** a bow, crossbow or thrown weapon in its hands: no melee (it watches) */
export function wieldsRanged(bot: Player): boolean {
    const id = bot.getInventory(InvType.WORN)?.get(3)?.id;
    return id !== undefined && /bow|dart|knife|thrownaxe|javelin/.test(ObjType.get(id)?.debugname ?? '');
}

/** Free for a visit: a members world, combat 20+, 5k+ coins, not a newbie, on the overworld near enough, unhurt. */
export function mayVisit(bot: Player): boolean {
    return visitBlock(bot) === null;
}

/** why a bot may not visit now (null: it may) */
function visitBlock(bot: Player): keyof typeof visitStats.why | null {
    if (!isMembersWorld() || !isLevelling(bot.botPlanner as PlannerKey) || isNewbie(bot) || bot.combatLevel < ARENA.visit.minCombat) return 'who';
    if (bot.level !== 0 || bot.z >= 6400 || wildernessLevelAt(bot.x, bot.z) > 0 || Math.max(Math.abs(bot.x - ARENA_CENTRE[0]), Math.abs(bot.z - ARENA_CENTRE[1])) > ARENA.visit.range) return 'where';
    if (bot.levels[PlayerStat.HITPOINTS] * 2 < bot.baseLevels[PlayerStat.HITPOINTS] || bot.botComeHereReturnX !== -1 || bot.botTradeTargetPid !== -1 || eventRoleOf(bot)) return 'busy';
    if (coinsOwned(bot) < ARENA.visit.minCoins) return 'coins';
    // (no trek there with minutes of its session left: the visit would end at a logout on the way or at once)
    return BotManager.sessionLeftOf(bot.username) < ARENA.visit.sessionLeft ? 'session' : null;
}

/**
 * The planner's asks (the humanlike report's A1 detail): offered a visit, or why not: not due, the visit just ended
 * (never two in a row), not a levelling bot of combat 20+ (who), off the overworld or beyond 900 tiles (where), hurt or
 * on an errand (busy), under 5k coins, under 25 minutes of its session left, the arena full.
 */
export const visitStats = { asked: 0, offered: 0, why: { notDue: 0, previous: 0, who: 0, where: 0, busy: 0, coins: 0, session: 0, full: 0 } };

/**
 * The planner (port/BotSetPieces' hook, beside the hang-outs): a Duel Arena visit when one is due, the bot is free for
 * it and the arena has room; else null. `previous`: the task that just ended (never two visits in a row).
 */
export function arenaVisitFor(bot: Player, previous: string | null): DuelArenaTask | null {
    // (a free world has no arena: no schedule either; the tests' 0: no visits)
    if (!isMembersWorld() || testRate === 0) return null;
    const s = scheduleOf(bot);
    visitStats.asked++;
    if (s.left > 0 || previous === 'DuelArena') {
        visitStats.why[s.left > 0 ? 'notDue' : 'previous']++;
        return null;
    }
    const block = visitBlock(bot) ?? (arenaCount() >= arenaCap() ? 'full' : null);
    if (block) {
        // (not now: it looks again in a quarter of an hour of play)
        visitStats.why[block]++;
        s.left = 1500;
        return null;
    }
    visitStats.offered++;
    // (the visit sets the next when it ends: visitEnded)
    s.left = 1500;
    // (a ranged weapon in its hands, or too few coins for the least stake at a tenth of them: it watches)
    const role: ArenaRole = wieldsRanged(bot) || coinsOwned(bot) * ARENA.stakes.share[0] < ARENA.stakes.min || Math.random() >= ARENA.visit.stakers ? 'watcher' : 'staker';
    return new DuelArenaTask(role);
}

registerPlannerHook((player, previous) => arenaVisitFor(player, previous));

// ── the director's big stake (duel_stake) ───────────────────────────────────────────────────────────────────────────

const VENUE: SetPieceVenue = { key: 'duel_arena', x: ARENA_CENTRE[0], z: ARENA_CENTRE[1], level: 0, say: 'the duel arena' };

/** a bot that may stake big: a levelling bot of combat 40+ with 100k+ coins, free, not a newbie, unhurt */
function bigStaker(p: Player): boolean {
    return isLevelling(p.botPlanner as PlannerKey) && !isNewbie(p) && p.combatLevel >= ARENA.bigStake.minCombat && coinsOwned(p) >= ARENA.bigStake.minCoins && !wieldsRanged(p) && p.levels[PlayerStat.HITPOINTS] * 2 >= p.baseLevels[PlayerStat.HITPOINTS];
}

interface BigStakeData {
    a: Player;
    b: Player;
    stake: number;
    rules: number;
    crowd: Player[];
}

/** the run of a big stake: two duellists and a crowd, the duel itself the duellists' (DuelArenaTask 'bigstake') */
export class BigStakeRun implements SetPieceRun {
    readonly id = nextSetPieceId();
    readonly kind = 'duel_stake' as const;
    readonly venue = VENUE;
    phase: SetPiecePhase = 'announce';
    readonly startedAt = World.currentTick;
    endsBy = World.currentTick + ARENA.bigStake.minutes * 100;
    readonly roles = new Map<Player, string>();
    readonly stake: number;
    readonly rules: number;
    /** the duel's outcome (the challenger's view), once over */
    result: string | null = null;
    winner: Player | null = null;
    private endAt = -1;
    private rumours = 0;
    readonly a: Player;
    readonly b: Player;

    constructor(data: BigStakeData) {
        this.a = data.a;
        this.b = data.b;
        this.stake = data.stake;
        this.rules = data.rules;
        this.roles.set(data.a, 'duellist');
        this.roles.set(data.b, 'duellist');
        for (const p of data.crowd) this.roles.set(p, 'crowd');
    }

    /** a duellist's task: the duel is over (its outcome, its side) */
    duelOver(bot: Player, outcome: string): void {
        if (this.result !== null) return;
        this.result = outcome;
        if (outcome === 'won') this.winner = bot;
        else if (outcome === 'lost') this.winner = bot === this.a ? this.b : this.a;
        this.phase = 'end';
        this.endAt = World.currentTick + rand(100, 250);
    }

    tick(now: number): void {
        if (this.phase === 'done') return;
        if (now >= this.endsBy) return this.abort('time');
        for (const p of [this.a, this.b]) if (p.slot === -1 || BotManager.botFor(p) === null) return this.abort('a duellist left');
        if (this.phase === 'announce' && now - this.startedAt > 150) this.phase = 'build';
        if (this.phase === 'build' && liveDuelOf(this.a)) this.phase = 'peak';
        if (this.phase === 'end' && now >= this.endAt) this.phase = 'done';
    }

    left(p: Player, _why: 'logout' | 'death' | 'fight' | 'stuck'): void {
        if (p === this.a || p === this.b) this.abort('a duellist left');
        else this.roles.delete(p);
    }

    rumour(): string | null {
        if (this.phase === 'end' || this.phase === 'done' || this.rumours >= 4) return null;
        const pool = arenaLines('duel-big');
        if (pool.length === 0) return null;
        this.rumours++;
        return pool[Math.floor(Math.random() * pool.length)];
    }

    abort(_why: string): void {
        this.phase = 'done';
    }

    /** the run is over (its roles' tasks end with it) */
    get over(): boolean {
        return this.phase === 'done';
    }
}

export const BIG_STAKE: SetPieceDef = {
    kind: 'duel_stake',
    members: true,
    weight: { members: 15, free: 0 },
    plan(ctx: SetPieceContext): SetPiecePlan | null {
        if (!ctx.members) return null;
        const B = ARENA.bigStake;
        // two rich duellists near the arena (its regulars or bots within 120 tiles), of about one combat level
        const rich = ctx.freeBots(VENUE.x, VENUE.z, 0, 120, p => bigStaker(p) && ctx.sessionLeft(p) >= 2700, 12);
        let pair: [Player, Player] | null = null;
        for (let i = 0; i < rich.length && !pair; i++) {
            for (let j = i + 1; j < rich.length; j++) {
                if (Math.abs(rich[i].combatLevel - rich[j].combatLevel) <= B.combat) {
                    pair = [rich[i], rich[j]];
                    break;
                }
            }
        }
        if (!pair) return null;
        // a crowd: the arena's own visitors or 4+ bots within 60 tiles
        const near = ctx.freeBots(VENUE.x, VENUE.z, 0, 60, p => !pair!.includes(p), 20).length + arenaCount();
        if (near < B.spectators) return null;
        const poorer = Math.min(coinsOwned(pair[0]), coinsOwned(pair[1]));
        const top = Math.min(B.max, Math.floor(poorer * B.share));
        if (top < B.min) return null;
        const raw = logUniform(B.min, top);
        const stake = Math.max(B.min, Math.min(top, Math.round(raw / 10000) * 10000));
        return { kind: 'duel_stake', venue: VENUE, score: near, data: { a: pair[0], b: pair[1], stake, rules: drawRules() } };
    },
    start(plan: SetPiecePlan, ctx: SetPieceContext): SetPieceRun | null {
        const d = plan.data as { a: Player; b: Player; stake: number; rules: number } | undefined;
        if (!d) return null;
        const aBot = BotManager.botFor(d.a);
        const bBot = BotManager.botFor(d.b);
        if (!aBot || !bBot || aBot.hasSubTask() || bBot.hasSubTask()) return null;
        const crowd = ctx.freeBots(VENUE.x, VENUE.z, 0, ARENA.bigStake.radius, p => p !== d.a && p !== d.b && isLevelling(p.botPlanner as PlannerKey) && ctx.sessionLeft(p) >= 1800, ARENA.bigStake.crowd);
        const run = new BigStakeRun({ a: d.a, b: d.b, stake: d.stake, rules: d.rules, crowd: [] });
        const deal: DuelDeal = { stake: d.stake, rules: d.rules };
        aBot.setSubTask(new DuelArenaTask('bigstake', { run, partner: d.b, deal, challenger: true }));
        bBot.setSubTask(new DuelArenaTask('bigstake', { run, partner: d.a, deal, challenger: false }));
        for (const p of crowd) {
            const bot = BotManager.botFor(p);
            if (!bot || bot.hasSubTask()) continue;
            // (staggered: each comes a moment after it hears of it)
            bot.setSubTask(new DuelArenaTask('crowd', { run, delay: rand(20, 400) }));
            run.roles.set(p, 'crowd');
        }
        return run;
    }
};

register(BIG_STAKE);

// ── tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** (tests) every bot-against-bot deal this one (null: drawn as the game draws them); never set by the game */
export let testDeal: DuelDeal | null = null;
export function setDuelDealForTest(deal: DuelDeal | null): void {
    testDeal = deal;
}

/** (tests) forget the arena's state: the registry, the duels, the humans, the purse */
export function resetArenaForTest(): void {
    visitors.clear();
    live.clear();
    duelLog.length = 0;
    challengeLog.length = 0;
    humans.clear();
    purse.length = 0;
    humansSeenAt = -1;
    testRate = 1;
    testDeal = null;
    schedules = new Map();
    challengeStats.asked = challengeStats.made = 0;
    for (const k of Object.keys(challengeStats.why) as (keyof typeof challengeStats.why)[]) challengeStats.why[k] = 0;
    visitStats.asked = visitStats.offered = 0;
    for (const k of Object.keys(visitStats.why) as (keyof typeof visitStats.why)[]) visitStats.why[k] = 0;
}

/** (tests) the human's record at the arena */
export function humanArenaState(name: string): { enteredAt: number; nextAt: number; refused: string[]; beaten: string[]; pending: string | null } | null {
    const h = humans.get(name);
    return h ? { enteredAt: h.enteredAt, nextAt: h.nextAt, refused: [...h.refused], beaten: [...h.beaten], pending: h.pending?.bot.username ?? null } : null;
}

/** (tests) a duel screen of the bot's: closed if it was the win screen (the payout), for the safety net */
export { duelScreen, inDuelArena };
