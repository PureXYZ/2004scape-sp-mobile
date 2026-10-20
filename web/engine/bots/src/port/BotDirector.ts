// port (the realism work, phase 5b, Track D: the director): about one notable event an hour of play, where the bots are
// ("about hourly", round 3, "Round 5b"; research
// the research). It picks a registered set piece (port/BotSetPieces: Track D's clan walks and PK team
// raids, Track P's drop parties, Party Room, scam sprees and fake Wilderness parties, Track A's big stakes), runs it and
// ends it, and keeps its schedule across a restart (BotManager.exportWorld's `director`).
//
// The schedule runs on the play clock (BotManager's playTicks: it stops while no human is in the world, and so does
// this: BotManager ticks it only then). The first event is due 20-50 minutes of play after the first fill; the gap from
// one start to the next is log-normal, median 55 minutes, σ 0.35, kept to 30-110 minutes. When nothing can run, it looks
// again every 5 minutes, and after 30 minutes of that it draws a fresh gap (an hour may pass with no event). One event
// runs at a time.
//
// Where: a census of the bots (BotManager.activeBots: never a human, never the human's place: set pieces happen where the
// bots are, not "life follows you") by region, 60 tiles round each (the keys in CENSUS_REGIONS), and freeBots for recruits. Each
// registered piece plans its venue from that (plan(ctx) non-null: it can run now); the director draws among them by the
// kind's weight on this world (members, free) times the plan's score (a score of 1 or more counts as 1: the kinds keep
// the defaults table's mix, 25/20/15/15/15/10 on a members world), never the kind of the last event, never a venue of
// the last three.
//
// Recruits (freeBots): bots online and playing, not busy (a fight, a trade, a conversation, "come here", a break or on
// their way out, a random event, a script's delay), holding no sub-task and no part in a set piece, with 30 minutes of
// session left (a piece asks 45 of its host or leader itself: ctx.sessionLeft), not recruited in the last 2 hours of
// play; a newbie, a vendor and a PKer only when the piece's `ok` says so. Each piece gives its recruits their parts
// (sub-tasks, roles); the director notes every bot that has one (the cooldown, the log), tells the piece of one that
// left the world (left(p, 'logout')), ticks it every 5 ticks, aborts it 3 minutes past its endsBy, and once it is done
// checks its recruits 2 minutes later: back at their own doings (V3), or logged out mid-event (V4).
//
// Word of mouth (talk only: nobody is sent anywhere): while a piece announces, builds or peaks, at most 4 bots within
// 150 tiles of its venue (not at it, not in it) say its rumour (run.rumour(), in the speaker's style; LineKind 'rumour',
// out of H7, each counted against the speaker's talk budget), at times drawn at its start; and with chance 0.5 an event,
// one free bot within 15 tiles of the human says it once (port/BotReactions rumourNearHuman: a reaction to the human,
// as "who talks" allows), when the human is not at the venue already.
//
// Dice: directorDice (Math.random by default: seeded in the sims; the tests stub it). No wall clock. Per tick nothing;
// every 5 ticks O(roles); a census O(bots) once per pick (hourly, or 5-minutely while nothing can run).
import type Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { eventRoleOf, logSetPiece, registeredSetPieces, runEnded, runStarted, type SetPieceContext, type SetPieceDef, type SetPieceLogEntry, type SetPiecePlan, type SetPieceRun } from '#/engine/bot/port/BotSetPieces.js';
import { BotChat, botPersona, inFightQuick, sayTyped } from '#/engine/bot/port/BotChat.js';
import { calm, countAsBudgetedLine } from '#/engine/bot/port/BotChatter.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { habitOf, isAway } from '#/engine/bot/port/BotHabits.js';
import { isFresh, noteSaid } from '#/engine/bot/port/BotLines.js';
import { botConsole } from '#/engine/bot/port/BotLog.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { holdsLogout } from '#/engine/bot/port/BotRandomEvents.js';
import { rumourNearHuman } from '#/engine/bot/port/BotReactions.js';
import { styleLine } from '#/engine/bot/port/BotStyle.js';
import { logNormal, reactionTicks } from '#/engine/bot/port/BotTiming.js';
import { tradeScreen } from '#/engine/bot/port/BotTradeScreen.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';

// ── the schedule (play ticks: 100 a minute) ──────────────────────────────────────────────────────────────────────

/** the first event: this many play ticks after the first fill (20-50 minutes) */
export const FIRST_EVENT: readonly [number, number] = [2000, 5000];
/** the gap between two starts: log-normal, its median and σ, kept to this range (30-110 minutes) */
export const GAP_MEDIAN = 5500;
export const GAP_SIGMA = 0.35;
export const GAP_RANGE: readonly [number, number] = [3000, 11000];
/** nothing can run: a look again this soon (5 minutes); after this long of looking, a fresh gap (30 minutes) */
export const RETRY_TICKS = 500;
export const RETRY_GIVE_UP = 3000;
/** no venue again within this many events */
export const RECENT_VENUES = 3;
/** the director's own cadence (ticks) */
const STEP_TICKS = 5;

// ── recruits ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** a recruit's session has at least this left (30 minutes; a host or leader 45: LEAD_SESSION_LEFT, asked by the piece) */
export const RECRUIT_SESSION_LEFT = 3000;
export const LEAD_SESSION_LEFT = 4500;
/** a bot at most once in this long (2 hours of play) */
export const RECRUIT_COOLDOWN = 12000;
/** a run this far past its endsBy is aborted (3 minutes) */
const OVERTIME = 300;
/** the recruits are looked at this long after the end (2 minutes: V3) */
export const CHECK_BACK_TICKS = 200;

// ── word of mouth ────────────────────────────────────────────────────────────────────────────────────────────────

/** at most this many rumour lines world-wide an event, by bots within RUMOUR_RANGE of its venue (not within RUMOUR_NEAR) */
export const RUMOURS_PER_EVENT = 4;
export const RUMOUR_RANGE = 150;
const RUMOUR_NEAR = 20;
/** an event's chance of one rumour near the human (port/BotReactions) */
export const NEAR_HUMAN_RUMOUR = 0.5;
/** the rumours come within this share of the event's planned time (its announce, build and peak) */
const RUMOUR_SPAN = 0.6;

// ── the census ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The census's regions: a centre and CENSUS_RADIUS round it (the research's: Lumbridge, Draynor, Port Sarim, Falador's
 * park and banks, Barbarian Village, Varrock's west, square and east, Edgeville, Al Kharid; on a members world the Duel
 * Arena, Seers' and Camelot, Catherby, Ardougne). A bot in two counts in both.
 */
export const CENSUS_REGIONS: readonly { key: string; x: number; z: number; members?: boolean }[] = [
    { key: 'lumbridge', x: 3222, z: 3218 },
    { key: 'draynor', x: 3093, z: 3250 },
    { key: 'port_sarim', x: 3030, z: 3220 },
    { key: 'falador', x: 2985, z: 3365 },
    { key: 'barbarian_village', x: 3082, z: 3420 },
    { key: 'varrock', x: 3212, z: 3428 },
    { key: 'edgeville', x: 3093, z: 3491 },
    { key: 'al_kharid', x: 3293, z: 3180 },
    { key: 'duel_arena', x: 3360, z: 3240, members: true },
    { key: 'seers', x: 2725, z: 3485, members: true },
    { key: 'catherby', x: 2808, z: 3436, members: true },
    { key: 'ardougne', x: 2662, z: 3305, members: true }
];
export const CENSUS_RADIUS = 60;

/** The director's dice (Math.random: seeded in the sims; the tests stub it). */
export const directorDice = { roll: (): number => Math.random() };

// ── the log (the humanlike runner, the tests) ────────────────────────────────────────────────────────────────────

/** a bot that had a part in an event: its role, its own task then, and what became of it */
export interface RecruitRecord {
    name: string;
    role: string;
    /** its main task when it got its part ('Woodcut:1511' ...), or null */
    task: string | null;
    at: number;
    /** it left mid-event: 'logout', or 'let go' (its piece let it go: lost, stuck, too late), or null */
    left: string | null;
    /** two minutes after the end: back at its own doings (true), not (false), out of the world then (null); undefined until looked at */
    back?: boolean | null;
}

export interface DirectorRecord {
    id: number;
    kind: string;
    venue: string;
    x: number;
    z: number;
    level: number;
    /** world ticks; play ticks at the start */
    start: number;
    startPlay: number;
    end: number;
    outcome: string;
    recruits: RecruitRecord[];
    rumours: { t: number; name: string; text: string; nearHuman: boolean }[];
}

const LOG_MAX = 500;
/** what the director ran, oldest first (a capped list) */
export const directorLog: DirectorRecord[] = [];

// ── state ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Schedule {
    /** play tick the next event is due (-1: not drawn yet, at the first look) */
    next: number;
    /** play tick the director began to look again for one that can run (-1: not looking) */
    retrySince: number;
    /** the last RECENT_VENUES venues' keys, and the last event's kind */
    recent: string[];
    lastKind: string | null;
}

interface Current {
    run: SetPieceRun;
    entry: SetPieceLogEntry;
    record: DirectorRecord;
    recruits: Map<Player, RecruitRecord>;
    gone: Set<Player>;
    /** world ticks of its rumours to come, and of its one near the human (-1: none) */
    rumourAt: number[];
    nearHumanAt: number;
}

interface BackCheck {
    at: number;
    record: DirectorRecord;
    /** each recruit's place and XP at the end (whether it moved or worked since) */
    then: Map<string, { x: number; z: number; xp: number }>;
}

let schedule: Schedule = { next: -1, retrySince: -1, recent: [], lastKind: null };
let current: Current | null = null;
const backChecks: BackCheck[] = [];
/** name -> the play tick it last had a part */
const recruitedAt = new Map<string, number>();
let lastPlay = 0;
let firstStarted = false;

// ── tests and the humanlike runner ───────────────────────────────────────────────────────────────────────────────

export interface DirectorTestOptions {
    /** the first event due this many play ticks after the first look (instead of 20-50 minutes) */
    first?: number | null;
    /** the first event's kind, of these when one can run (the runner's --director-kind) */
    firstKinds?: readonly string[] | null;
    /** every event's kind, of these */
    kinds?: readonly string[] | null;
    /** every gap this many play ticks (instead of the log-normal draw) */
    gap?: number | null;
    /** the bots the census reads (instead of BotManager.activeBots) */
    bots?: (() => Iterable<Player>) | null;
    /** the world's kind (instead of the world's) */
    members?: boolean | null;
}
let testOptions: DirectorTestOptions = {};

/** Tests and the humanlike runner only: the schedule's knobs (null: the game's). Never set by the game. */
export function setDirectorForTest(options: DirectorTestOptions | null): void {
    testOptions = { ...(options ?? {}) };
}

/** Tests only: no event under way (aborted), no schedule, no cooldowns, an empty log. */
export function resetDirectorForTest(): void {
    if (current) {
        try {
            current.run.abort('reset');
        } catch {
            // (a test's)
        }
        runEnded(current.run);
    }
    current = null;
    schedule = { next: -1, retrySince: -1, recent: [], lastKind: null };
    backChecks.length = 0;
    recruitedAt.clear();
    directorLog.length = 0;
    firstStarted = false;
    lastPlay = 0;
}

/** Tests only: the director's step with a clock of the test's own (play ticks, world ticks). */
export function directorStepForTest(play: number, now: number): void {
    step(play, now);
}

/** Tests only: the context a piece would get now. */
export function directorContextForTest(play: number, now: number): SetPieceContext {
    return contextOf(play, now);
}

/** The schedule now (the runner, the tests): the next event's play tick, the recent venues, the last kind, the run under way. */
export function directorState(): { next: number; retrySince: number; recent: readonly string[]; lastKind: string | null; running: string | null; play: number } {
    return { next: schedule.next, retrySince: schedule.retrySince, recent: [...schedule.recent], lastKind: schedule.lastKind, running: current?.run.kind ?? null, play: lastPlay };
}

// ── the tick ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** BotManager.tick, every tick while a human is in the world: the director's step every STEP_TICKS. */
export function tickDirector(): void {
    const now = World.currentTick;
    if (now % STEP_TICKS !== 0) return;
    step(BotManager.stats().playTicks, now);
}

function step(play: number, now: number): void {
    lastPlay = play;
    if (schedule.next < 0) schedule.next = play + firstGap();
    if (backChecks.length > 0 && now >= backChecks[0].at) lookBack(now);
    if (current) {
        advance(current, now);
        if (current) return;
    }
    if (play < schedule.next) return;
    if (tryStart(play, now)) {
        schedule.next = play + gap();
        schedule.retrySince = -1;
        return;
    }
    if (schedule.retrySince < 0) schedule.retrySince = play;
    if (play - schedule.retrySince >= RETRY_GIVE_UP) {
        schedule.next = play + gap();
        schedule.retrySince = -1;
    } else schedule.next = play + RETRY_TICKS;
}

function firstGap(): number {
    if (testOptions.first !== undefined && testOptions.first !== null) return Math.max(0, testOptions.first);
    return FIRST_EVENT[0] + Math.floor(directorDice.roll() * (FIRST_EVENT[1] - FIRST_EVENT[0] + 1));
}

/** the gap to the next start: log-normal round GAP_MEDIAN (σ GAP_SIGMA), within GAP_RANGE */
function gap(): number {
    if (testOptions.gap !== undefined && testOptions.gap !== null) return Math.max(1, testOptions.gap);
    const g = Math.round(logNormal(GAP_MEDIAN, GAP_SIGMA, () => directorDice.roll()));
    return Math.max(GAP_RANGE[0], Math.min(GAP_RANGE[1], g));
}

// ── the context ──────────────────────────────────────────────────────────────────────────────────────────────────

function bots(): Iterable<Player> {
    return testOptions.bots ? testOptions.bots() : BotManager.activeBots();
}

/** The bots online the director's census reads (BotManager.activeBots: bots only), for Track D's own pieces. */
export function directorBots(): Iterable<Player> {
    return bots();
}

function membersWorld(): boolean {
    return testOptions.members ?? isMembersWorld();
}

function cheb(ax: number, az: number, bx: number, bz: number): number {
    return Math.max(Math.abs(ax - bx), Math.abs(az - bz));
}

/** The context a piece plans and starts in: bots only (the census, freeBots), never a human. */
function contextOf(play: number, now: number): SetPieceContext {
    const members = membersWorld();
    const census = new Map<string, Player[]>();
    const regions = CENSUS_REGIONS.filter(r => members || !r.members);
    for (const r of regions) census.set(r.key, []);
    let online = 0;
    for (const p of bots()) {
        // (the bots' own census: a human is never counted, wherever it is)
        if (p.is_bot !== true) continue;
        online++;
        if (p.z >= 6400) continue;
        for (const r of regions) if (cheb(p.x, p.z, r.x, r.z) <= CENSUS_RADIUS) census.get(r.key)!.push(p);
    }
    return {
        now,
        play,
        members,
        online,
        census,
        freeBots: (x, z, level, radius, ok, max) => freeBots(x, z, level, radius, play, ok, max),
        sessionLeft: p => BotManager.sessionLeftOf(p.username),
        dice: () => directorDice.roll()
    };
}

/**
 * Is this bot free to be given a part now? Playing, alive, not in a script's delay; no sub-task (a "come here", a follow,
 * a bank trip: the research's trap, a replaced sub-task keeps its claims) and no part in a set piece; not fighting,
 * trading, talking with a human, on an errand, on a break or leaving, in a random event; out of the Wilderness; with
 * RECRUIT_SESSION_LEFT of its session left; not recruited in the last RECRUIT_COOLDOWN.
 */
export function isFreeForEvent(p: Player, play: number = lastPlay): boolean {
    if (p.is_bot !== true || p.slot === -1) return false;
    const ai = BotManager.botFor(p);
    if (!ai || ai.hasSubTask()) return false;
    if (p.levels[PlayerStat.HITPOINTS] <= 0 || p.delayed) return false;
    if (eventRoleOf(p)) return false;
    if (inFightQuick(p) || p.botTradeTargetPid !== -1 || tradeScreen(p) !== null || p.botComeHereReturnX !== -1) return false;
    if (BotChat.inConversation(p) || isAway(p) || habitOf(p) === 'leaving' || holdsLogout(p)) return false;
    if (wildernessLevelAt(p.x, p.z) > 0) return false;
    if (BotManager.sessionLeftOf(p.username) < RECRUIT_SESSION_LEFT) return false;
    return !recruitedLately(p.username, play);
}

/** Was this bot given a part in the last RECRUIT_COOLDOWN of play? */
export function recruitedLately(name: string, play: number = lastPlay): boolean {
    const at = recruitedAt.get(name);
    return at !== undefined && play - at < RECRUIT_COOLDOWN;
}

/** a newbie, a vendor, a PKer: never recruited unless the piece's `ok` says so */
function setApart(p: Player): boolean {
    const planner = p.botPlanner;
    return planner === 'extras_vendor' || planner === 'extras_pker' || planner === 'extras_edgeville_pker' || isNewbie(p);
}

function freeBots(x: number, z: number, level: number, radius: number, play: number, ok?: (p: Player) => boolean, max = Infinity): Player[] {
    const found: { p: Player; d: number }[] = [];
    for (const p of bots()) {
        if (p.level !== level) continue;
        const d = cheb(p.x, p.z, x, z);
        if (d > radius) continue;
        if (setApart(p) ? !(ok && ok(p)) : ok && !ok(p)) continue;
        if (!isFreeForEvent(p, play)) continue;
        found.push({ p, d });
    }
    return found
        .sort((a, b) => a.d - b.d)
        .slice(0, max)
        .map(f => f.p);
}

// ── a start ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** a plan's weight in the draw: the kind's weight on this world times its score (1 or more counts as 1) */
function weightOf(def: SetPieceDef, plan: SetPiecePlan, members: boolean): number {
    const w = members ? def.weight.members : def.weight.free;
    return w * Math.max(0, Math.min(1, plan.score));
}

function tryStart(play: number, now: number): boolean {
    const ctx = contextOf(play, now);
    const only = !firstStarted && testOptions.firstKinds ? testOptions.firstKinds : testOptions.kinds;
    const options: { def: SetPieceDef; plan: SetPiecePlan; w: number }[] = [];
    for (const def of registeredSetPieces()) {
        if (def.members && !ctx.members) continue;
        if ((ctx.members ? def.weight.members : def.weight.free) <= 0) continue;
        if (def.kind === schedule.lastKind) continue;
        if (only && !only.includes(def.kind)) continue;
        let plan: SetPiecePlan | null = null;
        try {
            plan = def.plan(ctx);
        } catch (err) {
            botConsole.error(`[BotDirector] ${def.kind}: its plan failed`, err);
            continue;
        }
        if (!plan || schedule.recent.includes(plan.venue.key)) continue;
        const w = weightOf(def, plan, ctx.members);
        if (w > 0) options.push({ def, plan, w });
    }
    while (options.length > 0) {
        let x = directorDice.roll() * options.reduce((sum, o) => sum + o.w, 0);
        let i = 0;
        for (; i < options.length - 1; i++) {
            x -= options[i].w;
            if (x < 0) break;
        }
        const { def, plan } = options[i];
        options.splice(i, 1);
        let run: SetPieceRun | null = null;
        try {
            run = def.start(plan, ctx);
        } catch (err) {
            botConsole.error(`[BotDirector] ${def.kind}: its start failed`, err);
            run = null;
        }
        if (!run) continue;
        begin(run, play, now);
        return true;
    }
    return false;
}

function begin(run: SetPieceRun, play: number, now: number): void {
    firstStarted = true;
    runStarted(run);
    schedule.lastKind = run.kind;
    schedule.recent.push(run.venue.key);
    while (schedule.recent.length > RECENT_VENUES) schedule.recent.shift();
    const v = run.venue;
    const record: DirectorRecord = { id: run.id, kind: run.kind, venue: v.key, x: v.x, z: v.z, level: v.level, start: now, startPlay: play, end: -1, outcome: 'running', recruits: [], rumours: [] };
    directorLog.push(record);
    if (directorLog.length > LOG_MAX) directorLog.shift();
    const entry = logSetPiece({ id: run.id, kind: run.kind, venue: v.key, x: v.x, z: v.z, level: v.level, start: now, end: -1, outcome: 'running', roles: run.roles.size, detail: { director: true } });
    // (word of mouth: its rumours' times, within its announce, build and peak; one near the human half the time)
    const span = Math.max(300, Math.min(1500, Math.round((run.endsBy - now) * RUMOUR_SPAN)));
    const rumourAt: number[] = [];
    for (let i = 0; i < RUMOURS_PER_EVENT; i++) rumourAt.push(now + 40 + Math.floor(directorDice.roll() * span));
    rumourAt.sort((a, b) => a - b);
    const nearHumanAt = directorDice.roll() < NEAR_HUMAN_RUMOUR ? now + 60 + Math.floor(directorDice.roll() * span) : -1;
    current = { run, entry, record, recruits: new Map(), gone: new Set(), rumourAt, nearHumanAt };
    noteRoles(current, play, now);
}

// ── a run under way ──────────────────────────────────────────────────────────────────────────────────────────────

/** every bot with a part noted: the cooldown, the log (a guest that joins later too) */
function noteRoles(cur: Current, play: number, now: number): void {
    for (const [p, role] of cur.run.roles) {
        if (cur.recruits.has(p)) continue;
        recruitedAt.set(p.username, play);
        const rec: RecruitRecord = { name: p.username, role, task: BotManager.botFor(p)?.currentTask?.name ?? null, at: now, left: null };
        cur.recruits.set(p, rec);
        cur.record.recruits.push(rec);
    }
}

function advance(cur: Current, now: number): void {
    const run = cur.run;
    noteRoles(cur, lastPlay, now);
    // (a bot that left the world: its piece is told, once; one its piece let go before the end: noted)
    for (const [p, rec] of cur.recruits) {
        if (cur.gone.has(p)) continue;
        if (!run.roles.has(p)) {
            if (rec.left === null && run.phase !== 'done') rec.left = p.slot === -1 || BotManager.botFor(p) === null ? 'logout' : 'let go';
            continue;
        }
        if (p.slot !== -1 && BotManager.botFor(p) !== null) continue;
        cur.gone.add(p);
        if (run.phase !== 'done' && rec.left === null) rec.left = 'logout';
        try {
            run.left(p, 'logout');
        } catch (err) {
            botConsole.error(`[BotDirector] ${run.kind}: left failed`, err);
        }
    }
    if (run.phase !== 'done') {
        try {
            run.tick(now);
        } catch (err) {
            botConsole.error(`[BotDirector] ${run.kind}: its tick failed`, err);
            abortRun(run, 'error');
        }
    }
    if (run.phase !== 'done' && now > run.endsBy + OVERTIME) abortRun(run, 'overtime');
    if (run.phase === 'announce' || run.phase === 'build' || run.phase === 'peak') rumours(cur, now);
    if (run.phase === 'done') finish(cur, now);
}

function abortRun(run: SetPieceRun, why: string): void {
    try {
        run.abort(why);
    } catch (err) {
        botConsole.error(`[BotDirector] ${run.kind}: abort failed`, err);
    }
    (run as { outcome?: string }).outcome ??= why;
    run.phase = 'done';
}

function finish(cur: Current, now: number): void {
    const run = cur.run;
    runEnded(run);
    const outcome = (run as { outcome?: string }).outcome ?? 'done';
    cur.record.end = now;
    cur.record.outcome = outcome;
    cur.entry.end = now;
    cur.entry.outcome = outcome;
    cur.entry.roles = cur.recruits.size;
    cur.entry.detail = { ...(cur.entry.detail ?? {}), recruits: cur.recruits.size, rumours: cur.record.rumours.length };
    const then = new Map<string, { x: number; z: number; xp: number }>();
    for (const [p, rec] of cur.recruits) if (p.slot !== -1) then.set(rec.name, { x: p.x, z: p.z, xp: totalXp(p) });
    backChecks.push({ at: now + CHECK_BACK_TICKS, record: cur.record, then });
    current = null;
}

function totalXp(p: Player): number {
    let xp = 0;
    for (let s = 0; s < p.stats.length; s++) xp += p.stats[s];
    return xp;
}

/** V3: two minutes after an event, each recruit's doings (its own task again, moving or working, no part) */
function lookBack(now: number): void {
    while (backChecks.length > 0 && now >= backChecks[0].at) {
        const check = backChecks.shift()!;
        const byName = new Map<string, Player>();
        for (const p of bots()) byName.set(p.username, p);
        for (const rec of check.record.recruits) {
            if (rec.left === 'logout') continue;
            const p = byName.get(rec.name);
            const ai = p ? BotManager.botFor(p) : null;
            if (!p || !ai) {
                rec.back = null;
                continue;
            }
            const was = check.then.get(rec.name);
            // (the variety work, round 2, Track D2: a social bot's doing is its stand at its hub, still as it is: its Social
            // task again counts. A staged run whose world's draws moved recruited one, and V3 read it as not back)
            const social = ai.currentTask?.name === 'Social';
            const busy = social || p.target !== null || p.hasWaypoints() || (was !== undefined && (was.x !== p.x || was.z !== p.z || totalXp(p) > was.xp));
            rec.back = eventRoleOf(p) === null && ai.currentTask !== null && busy;
        }
    }
}

// ── word of mouth ────────────────────────────────────────────────────────────────────────────────────────────────

function rumours(cur: Current, now: number): void {
    while (cur.rumourAt.length > 0 && now >= cur.rumourAt[0]) {
        cur.rumourAt.shift();
        sayRumour(cur, now);
    }
    if (cur.nearHumanAt >= 0 && now >= cur.nearHumanAt) {
        cur.nearHumanAt = -1;
        const text = rumourOf(cur.run);
        if (text === null) return;
        const v = cur.run.venue;
        const speaker = rumourNearHuman(text, p => cur.run.roles.has(p) || !rumourFree(p, now), v.x, v.z, v.level);
        if (speaker) {
            cur.record.rumours.push({ t: now, name: speaker.username, text, nearHuman: true });
            countAsBudgetedLine(speaker);
        }
    }
}

/** the run's rumour, guarded (a piece's own code) */
function rumourOf(run: SetPieceRun): string | null {
    try {
        const text = run.rumour();
        return typeof text === 'string' && text.trim().length > 0 ? text.trim() : null;
    } catch (err) {
        botConsole.error(`[BotDirector] ${run.kind}: its rumour failed`, err);
        return null;
    }
}

/** a bot that may pass a rumour on: playing, calm (not fighting, in a window, trading, away, talking), no part, no vendor or PKer, out of the Wilderness */
function rumourFree(p: Player, now: number): boolean {
    if (p.is_bot !== true || p.slot === -1 || !BotManager.botFor(p) || eventRoleOf(p)) return false;
    const planner = p.botPlanner;
    if (planner === 'extras_vendor' || planner === 'extras_pker' || planner === 'extras_edgeville_pker') return false;
    if (p.botTradeTargetPid !== -1 || inFightQuick(p) || wildernessLevelAt(p.x, p.z) > 0) return false;
    return calm(p, now);
}

/** one bot within RUMOUR_RANGE of the venue (not at it) says the rumour, in its style, typed; counted against its budget */
function sayRumour(cur: Current, now: number): void {
    const run = cur.run;
    const v = run.venue;
    const near: Player[] = [];
    for (const p of bots()) {
        if (p.level !== v.level || run.roles.has(p)) continue;
        const d = cheb(p.x, p.z, v.x, v.z);
        if (d > RUMOUR_RANGE || d < RUMOUR_NEAR) continue;
        if (rumourFree(p, now)) near.push(p);
    }
    if (near.length === 0) return;
    const speaker = near[Math.floor(directorDice.roll() * near.length)];
    let text = rumourOf(run);
    // (a variant another bot said in this square lately, or the human heard: one more try)
    if (text !== null && !isFresh(speaker.username, text, speaker.x, speaker.z, speaker.level, now)) text = rumourOf(run);
    if (text === null || !isFresh(speaker.username, text, speaker.x, speaker.z, speaker.level, now)) return;
    noteSaid(speaker, text, now);
    const persona = botPersona(speaker);
    const shown = styleLine(text, persona).line;
    sayTyped(speaker, shown, { to: null, kind: 'rumour' }, reactionTicks(persona, 'notice'));
    countAsBudgetedLine(speaker);
    cur.record.rumours.push({ t: now, name: speaker.username, text: shown, nearHuman: false });
}

// ── persistence (BotManager.exportWorld's `director`) ────────────────────────────────────────────────────────────

interface Saved {
    v: 1;
    /** play ticks to the next event */
    next: number;
    recent: string[];
    last: string | null;
}

/** The schedule for the store: the play ticks to the next event, the last venues and kind; null before it has one. */
export function exportDirector(): unknown {
    if (schedule.next < 0) return null;
    const saved: Saved = { v: 1, next: Math.max(0, schedule.next - lastPlay), recent: [...schedule.recent], last: schedule.lastKind };
    return saved;
}

/**
 * The last run's schedule, if the store had one: the next event as many play ticks away as it was (at most a whole
 * gap), the last venues and kind (no venue again soon, no kind twice in a row across a restart). An event under way when
 * the app closed is lost (nothing per event is kept); anything else in the store is ignored.
 */
export function restoreDirector(state: unknown): void {
    const s = state as Partial<Saved> | null | undefined;
    if (!s || typeof s !== 'object' || s.v !== 1 || typeof s.next !== 'number' || !Number.isFinite(s.next)) return;
    schedule.next = lastPlay + Math.max(0, Math.min(GAP_RANGE[1], Math.floor(s.next)));
    schedule.retrySince = -1;
    schedule.recent = Array.isArray(s.recent) ? s.recent.filter((k): k is string => typeof k === 'string').slice(-RECENT_VENUES) : [];
    schedule.lastKind = typeof s.last === 'string' ? s.last : null;
}
