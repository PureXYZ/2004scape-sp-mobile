// port (the realism work, phase 5b, Track P: scam callers, talk only, the
// defaults chosen): 2004's doubling and
// trimming callers at the trade banks. Never an item taken: a scammer's whole act is chat. A human who asks one to trade
// is turned down in words (port/BotTrade: tradeRefusal) and no trade window ever opens (274's trade.rs2 opens one only
// when both have asked, and a caller never asks).
//
//   ambient stints  about one every 2 hours of play world-wide (a log-normal gap, median 110 minutes, 60-200), at Varrock
//                   West (60 %), Falador East (25 %) or Edgeville's bank (15 %): drawn by those weights, never from the
//                   human's place. The caller is a rude bot there now (friendliness under 0): a social regular standing
//                   at that hub first, else a levelling bot of combat 40 or less at the bank; never a vendor, a newbie,
//                   the player-mod bot, nor one with a friend of its clique near; and a caller calls to a crowd: 3 bots
//                   or more in its earshot. None there: a look again every 5 minutes, a fresh gap after 30.
//   the spree       (a director's set piece, 'scam_spree', 15 of the hourly beat's 100) at the busiest of the three: two
//                   callers 1-2 minutes apart, 6-12 minutes; the player-mod bot (Track A) hears every call (BotSay's
//                   listeners, kind 'scam') and has its turn.
//   a stint         3-8 minutes standing where it is (a sub-task: ScamCallTask), a call every 15-45 s (log-normal) from
//                   two or three of its kind's lines (doubling, trimming, free stuff; upstream's own "Doubling gold trade
//                   me" and "Trimming armour, 25k gp" verbatim among them), 4 in 10 callers in a colour or with wave:.
//                   After a call, with chance 0.3 a bot in earshot (not its clique) warns ("its a scam", "lol nice try"),
//                   at most 4 a stint, and the caller answers half of them ("its legit!!"). A player-mod bot's line near
//                   it (kind 'mod') is answered 6 times in 10 ("lol wasnt me") and ends the stint at once. (The variety
//                   work, round 1, track F) its stint over, the caller goes quiet and logs out within 1-2 minutes.
// Every line is a set piece's (port/BotPieceLines): the calls and answers kind 'scam', the crowd's 'setpiece', each in
// place of the speaker's next line (the talk budget). The log (scamLog) is the humanlike report's K1-K3.
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { BotTask, randInt } from '#/engine/bot/tasks/BotTaskBase.js';
import { clearRole, eventRoleOf, nextSetPieceId, register, runningSetPieces, setRole, type SetPieceContext, type SetPieceDef, type SetPiecePhase, type SetPiecePlan, type SetPieceRun, type SetPieceVenue } from '#/engine/bot/port/BotSetPieces.js';
import { sayListeners, type ChatStyle, type LineKind } from '#/engine/bot/port/BotSay.js';
import { scheduleInTicks } from '#/engine/bot/port/BotSchedule.js';
import { anyPieceLine, freshPieceText, sayPieceLine, sayPieceText } from '#/engine/bot/port/BotPieceLines.js';
import { botPersona, logNormal, reactionTicks, typingTicks } from '#/engine/bot/port/BotTiming.js';
import { nameSeed } from '#/engine/bot/port/BotSeed.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { isAway } from '#/engine/bot/port/BotHabits.js';
import { cliqueMateNear, sameClique } from '#/engine/bot/port/BotCliques.js';
import { BotChat } from '#/engine/bot/port/BotChat.js';

// ── the defaults ─────────────────────────────────────────────────────────────────────────────────────────────────

export const SCAMS = {
    /** an ambient stint about every 2 hours of play: a log-normal gap (play ticks), its median (110 minutes) and spread, clamped (60-200 minutes) */
    gapMedian: 11000,
    gapSigma: 0.35,
    gap: [6000, 20000] as [number, number],
    /** a look for a caller again after this long when none was there; a fresh gap after this many looks */
    retry: 300,
    retries: 6,
    /** (the variety work, round 1, track F) the caller logs out this long after its stint (play ticks: 1-2 minutes) */
    leaveAfter: [100, 200] as [number, number],
    /** an ambient stint's length, a spree's (ticks) */
    stint: [300, 800] as [number, number],
    spree: [600, 1200] as [number, number],
    /** a spree's second caller starts this long after the first */
    second: [60, 120] as [number, number],
    /** a call every 15-45 s: a log-normal gap (ticks) and its bounds */
    callMedian: 45,
    callSigma: 0.4,
    callGap: [25, 75] as [number, number],
    /** the crowd: one warning after a call with this chance, at most this many a stint; the caller answers this share */
    warnChance: 0.3,
    warnMax: 4,
    answerChance: 0.5,
    /** a player-mod bot's line within this many tiles is answered this often, and ends the stint */
    modRange: 15,
    modAnswer: 0.6,
    /** earshot: the crowd within this many tiles */
    earshot: 12,
    /** an ambient caller calls to a crowd: at least this many other bots in earshot (none: no stint there now) */
    audience: 3,
    /** a levelling caller: combat at most this */
    maxCombat: 40,
    /** a caller's session: this many play ticks left at least */
    sessionLeft: 1000,
    /** the crowd a spree wants at its venue */
    sprees: 5,
    /** a stint whose task has not run for this long (another sub-task took the bot: a "come here") is over */
    stale: 100
};

/** (tests: setScamRatesForTest) the ambient stints on */
const rates = { ambient: true, logout: true };

/** where they call: the trade banks' halls and roads (the social hubs of the same name stand there), and their shares */
export interface ScamVenue extends SetPieceVenue {
    radius: number;
    share: number;
    /** the social hub (tasks/SocialTask HUBS) whose regulars stand there */
    hub: string | null;
}

export const SCAM_VENUES: readonly ScamVenue[] = [
    { key: 'varrock_west', x: 3185, z: 3437, level: 0, say: 'varrock west', radius: 12, share: 0.6, hub: 'varrock_west' },
    { key: 'falador_east', x: 3013, z: 3357, level: 0, say: 'fally east', radius: 10, share: 0.25, hub: 'falador_east' },
    { key: 'edgeville', x: 3093, z: 3491, level: 0, say: 'edge', radius: 10, share: 0.15, hub: null }
];

/** upstream's own scam lines (data/bot_phrases.json: said verbatim, never styled) */
export const UPSTREAM_SCAM_LINES = { double: ['Doubling gold trade me'], trim: ['Trimming armour, 25k gp', 'Trimming armor for free!'] } as const;

type ScamKind = 'double' | 'trim' | 'free';

// ── the log ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ScamRecord {
    id: number;
    kind: 'ambient' | 'spree';
    venue: string;
    caller: string;
    start: number;
    end: number;
    calls: number;
    warnings: number;
    answers: number;
    /** a player-mod bot's line came near it (and ended it) */
    mod: boolean;
    /** trade requests from a human while it called: each turned down in words */
    tradeRequests: number;
    outcome: string;
}

const LOG_MAX = 500;
/** every stint since the world started (a capped ring): the humanlike report and the tests */
export const scamLog: ScamRecord[] = [];

// ── a stint ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface Stint {
    record: ScamRecord;
    caller: Player;
    venue: ScamVenue;
    kind: ScamKind;
    endsAt: number;
    style: ChatStyle | undefined;
    /** its lines (two or three of its kind's), said in turn without repeats */
    lines: { text: string; upstream: boolean }[];
    next: number;
    stopped: boolean;
    task: ScamCallTask;
    /** where it stands (x, z, level): moved off it, the stint is over */
    at: [number, number, number];
}

/** the stints under way, by caller */
const stints = new Map<Player, Stint>();
/** a caller's stint ended lately (a trade request a minute on still gets the scammer's answer), by caller: until when */
const lately = new WeakMap<Player, number>();

/** Is the bot calling scams now (or did it a minute ago)? */
export function isScamCaller(bot: Player): boolean {
    return stints.has(bot) || (lately.get(bot) ?? -1) > World.currentTick;
}

/** The stints under way (tests, the runner). */
export function activeStints(): { caller: Player; venue: string; record: ScamRecord }[] {
    return [...stints.values()].map(s => ({ caller: s.caller, venue: s.venue.key, record: s.record }));
}

/**
 * port/BotTrade: a human asks a scam caller to trade. Its answer in words ("lol jk", "u actually fell for it"), or null when
 * it is no caller; the request opens no window (the caller never asks back).
 */
export function tradeRefusal(bot: Player, _human: Player): string | null {
    if (!isScamCaller(bot)) return null;
    const stint = stints.get(bot);
    if (stint) stint.record.tradeRequests++;
    else for (let i = scamLog.length - 1; i >= 0; i--) {
        if (scamLog[i].caller === bot.username) {
            scamLog[i].tradeRequests++;
            break;
        }
    }
    return freshPieceText(bot, 'scam', 'refuse') ?? anyPieceLine('scam', 'refuse');
}

/** the caller's calls: two or three of its kind's lines (upstream's own among them, unstyled), in a shuffled order */
function repertoire(kind: ScamKind): { text: string; upstream: boolean }[] {
    const own = kind === 'double' ? 'call-double' : kind === 'trim' ? 'call-trim' : 'call-free';
    const pool: { text: string; upstream: boolean }[] = [];
    const lines = [...(kind === 'free' ? [] : UPSTREAM_SCAM_LINES[kind])].map(text => ({ text, upstream: true }));
    for (let i = 0; i < 6; i++) {
        const t = anyPieceLine('scam', own);
        if (t && !pool.some(p => p.text === t)) pool.push({ text: t, upstream: false });
    }
    const all = [...lines, ...pool].map(x => ({ x, k: Math.random() })).sort((a, b) => a.k - b.k).map(e => e.x);
    return all.slice(0, randInt(2, 3));
}

/** 4 in 10 callers in a colour and/or wave (from the name: the same at every stint) */
function callerStyle(bot: Player): ChatStyle | undefined {
    const seed = nameSeed(bot.username, 'scam-calls') % 100;
    if (seed >= 40) return undefined;
    return { colour: seed % 3 === 0 ? 0 : 1 + (seed % 11), effect: seed % 2 === 0 ? 1 : 0 };
}

function begin(caller: Player, venue: ScamVenue, kind: 'ambient' | 'spree', ticks: number): Stint | null {
    const ai = BotManager.botFor(caller);
    if (!ai || ai.hasSubTask() || stints.has(caller)) return null;
    const now = World.currentTick;
    const kinds: ScamKind[] = ['double', 'double', 'trim', 'free'];
    const scam = kinds[Math.floor(Math.random() * kinds.length)];
    const record: ScamRecord = { id: nextSetPieceId(), kind, venue: venue.key, caller: caller.username, start: now, end: -1, calls: 0, warnings: 0, answers: 0, mod: false, tradeRequests: 0, outcome: 'running' };
    // (it stops where it is: a walk its own task began goes no further; it calls from here)
    caller.clearWaypoints();
    // (and so does the click its task was on: the engine walked a ranger on to its next monster, and the stint ended as
    // "moved" 10 ticks in: scams.test after round 1's merge, its second fixer)
    caller.clearInteraction();
    const task = new ScamCallTask();
    const stint: Stint = { record, caller, venue, kind: scam, endsAt: now + ticks, style: callerStyle(caller), lines: repertoire(scam), next: now + randInt(2, 10), stopped: false, task, at: [caller.x, caller.z, caller.level] };
    task.stint = stint;
    stints.set(caller, stint);
    // (a part in a set piece while it calls: no break, no logout mid-stint, no other piece's recruit: port/BotSetPieces)
    setRole(caller, 'scam-caller');
    scamLog.push(record);
    if (scamLog.length > LOG_MAX) scamLog.shift();
    ai.setSubTask(task);
    return stint;
}

function end(stint: Stint, outcome: string): void {
    if (stint.record.end >= 0) return;
    stint.stopped = true;
    stint.record.end = World.currentTick;
    stint.record.outcome = outcome;
    stints.delete(stint.caller);
    clearRole(stint.caller);
    lately.set(stint.caller, World.currentTick + 100);
    // port (the variety work, round 1, track F: the 5b spec's item, never built): the caller goes quiet and logs out
    // within 1-2 minutes (its session ends: BotManager.leaveSoon, its goodbye and wrap-up as any session's). A 2004 scammer
    // was a throwaway account; a levelling bot went back to training after calling doubling scams for 8 minutes
    if (rates.logout && outcome !== 'logout' && outcome !== 'test' && stint.caller.slot !== -1) {
        scamLogouts.asked++;
        BotManager.leaveSoon(stint.caller.username, randInt(SCAMS.leaveAfter[0], SCAMS.leaveAfter[1]));
    }
}

/** (variety round 1, F) the callers sent off after their stint (tests, the report) */
export const scamLogouts = { asked: 0 };

/** the gap to the next call: 15-45 s */
function callGap(): number {
    return Math.max(SCAMS.callGap[0], Math.min(SCAMS.callGap[1], Math.round(logNormal(SCAMS.callMedian, SCAMS.callSigma))));
}

/** the bots near (x, z) on `level` within r (the zones there) */
function botsNear(x: number, z: number, level: number, r: number): Player[] {
    const out: Player[] = [];
    for (let zx = (x - r) >> 3; zx <= (x + r) >> 3; zx++) {
        for (let zz = (z - r) >> 3; zz <= (z + r) >> 3; zz++) {
            for (const p of World.gameMap.getZone(zx << 3, zz << 3, level).getAllPlayersSafe()) {
                if (p.is_bot && p.level === level && Math.max(Math.abs(p.x - x), Math.abs(p.z - z)) <= r) out.push(p);
            }
        }
    }
    return out;
}

/** free to say a word now: not fighting, trading, talking with a human, away or in a window */
function canSpeak(bot: Player): boolean {
    if (bot.slot === -1 || bot.modalMain !== -1 || bot.botTradeTargetPid !== -1) return false;
    if (isAway(bot) || BotChat.inConversation(bot) || BotChat.midTalk(bot)) return false;
    const t = bot.target as { nid?: number; username?: string } | null;
    return !(t && (t.nid !== undefined || t.username !== undefined));
}

/** the stints whose caller left or whose task stopped running (another sub-task took the bot) end */
function sweep(now: number): void {
    for (const s of [...stints.values()]) {
        if (s.caller.slot === -1) end(s, 'logout');
        else if (now - s.task.lastTick > SCAMS.stale) end(s, 'dropped');
    }
}

/** the crowd after a call: one warning now and then (not the caller's clique), the caller's answer half the time */
function crowd(stint: Stint): void {
    const r = stint.record;
    if (r.warnings >= SCAMS.warnMax || Math.random() >= SCAMS.warnChance) return;
    const c = stint.caller;
    const near = botsNear(c.x, c.z, c.level, SCAMS.earshot).filter(p => p !== c && !stints.has(p) && !sameClique(p.username, c.username) && p.staffModLevel === 0 && canSpeak(p));
    if (!near.length) return;
    const who = near[Math.floor(Math.random() * near.length)];
    const text = freshPieceText(who, 'scam', 'warn');
    if (text === null) return;
    r.warnings++;
    const persona = botPersona(who);
    scheduleInTicks(reactionTicks(persona, 'notice') + typingTicks(persona, text), () => {
        if (!canSpeak(who)) return;
        sayPieceText(who, text, 'setpiece', { to: c });
        if (stint.stopped || Math.random() >= SCAMS.answerChance) return;
        const answer = freshPieceText(c, 'scam', 'answer');
        if (answer === null) return;
        const mine = botPersona(c);
        scheduleInTicks(typingTicks(mine, answer), () => {
            if (stint.stopped || c.slot === -1) return;
            sayPieceText(c, answer, 'scam', { to: who });
            r.answers++;
        });
    });
}

/**
 * A scam caller's stint (a sub-task: its own task waits, and goes on after). It stands where it is and calls every 15-45
 * s while it is free to talk; the stint ends at its time, when a player-mod bot spoke near it, or when the bot is gone.
 */
/** a caller this far from where its stint began (or on another floor) was moved off: its stint is over */
const MOVED_OFF = 10;

export class ScamCallTask extends BotTask {
    stint: Stint | null = null;
    /** the world tick BotPlayer last ran it (a stint whose task stopped running is over: sweep) */
    lastTick = World.currentTick;
    private done = false;

    constructor() {
        super('ScamCall');
    }

    shouldRun(_p: Player): boolean {
        return !this.done;
    }

    isComplete(_p: Player): boolean {
        return this.done;
    }

    tick(player: Player): void {
        const stint = this.stint;
        const now = World.currentTick;
        this.lastTick = now;
        if (!stint || stint.stopped || now >= stint.endsAt || player.slot === -1) {
            if (stint) end(stint, stint.stopped ? stint.record.outcome : 'done');
            this.done = true;
            return;
        }
        // (moved off its spot: a random event's teleport, a death; a scammer calls where the crowd is, not elsewhere)
        const [ax, az, alevel] = stint.at;
        if (player.level !== alevel || Math.max(Math.abs(player.x - ax), Math.abs(player.z - az)) > MOVED_OFF) {
            end(stint, 'moved');
            this.done = true;
            return;
        }
        if (now < stint.next || player.hasWaypoints() || !canSpeak(player)) return;
        const line = stint.lines[stint.record.calls % stint.lines.length];
        if (!line) return;
        stint.next = now + callGap();
        sayPieceText(player, line.text, 'scam', { style: stint.style, styled: !line.upstream });
        stint.record.calls++;
        crowd(stint);
    }

    override reset(): void {
        // (BotPlayer resets a sub-task as it takes it on: the stint goes on; at a logout the bot is gone and it ends)
        super.reset();
        if (this.stint && this.stint.caller.slot === -1) end(this.stint, 'logout');
    }
}

// ── the player-mod bot's word (Track A's port/BotModBot speaks with kind 'mod': heard here, never imported) ─────────

sayListeners.push((player: Player, _line: string, kind?: LineKind) => {
    if (kind !== 'mod' || stints.size === 0) return;
    for (const stint of [...stints.values()]) {
        const c = stint.caller;
        if (c.level !== player.level || Math.max(Math.abs(c.x - player.x), Math.abs(c.z - player.z)) > SCAMS.modRange) continue;
        stint.record.mod = true;
        end(stint, 'mod');
        if (Math.random() < SCAMS.modAnswer) {
            const text = freshPieceText(c, 'scam', 'mod-answer');
            if (text !== null) {
                scheduleInTicks(typingTicks(botPersona(c), text), () => {
                    if (c.slot !== -1) sayPieceText(c, text, 'scam', { to: player });
                });
            }
        }
    }
});

// ── who calls ────────────────────────────────────────────────────────────────────────────────────────────────────

/** a rude talker free to call here: a social regular, or a levelling bot of combat 40 or less (see the header) */
export function mayCall(bot: Player): boolean {
    // (armed for a random event: its answer would wait behind the stint)
    if (bot.slot === -1 || !bot.is_bot || bot.staffModLevel > 0 || bot.afkEventReady) return false;
    if (botPersona(bot).friendliness >= 0) return false;
    const planner = bot.botPlanner as PlannerKey;
    const social = planner === 'extras_social';
    if (!social && (!isLevelling(planner) || bot.combatLevel > SCAMS.maxCombat)) return false;
    if (isNewbie(bot) || eventRoleOf(bot) !== null || stints.has(bot)) return false;
    const ai = BotManager.botFor(bot);
    if (!ai || ai.hasSubTask()) return false;
    if (bot.botTradeTargetPid !== -1 || bot.botComeHereReturnX !== -1 || !canSpeak(bot)) return false;
    if (BotManager.sessionLeftOf(bot.username) < SCAMS.sessionLeft) return false;
    return cliqueMateNear(bot, 15) === null;
}

/** the bots in the caller's earshot now (itself and other callers aside): its audience */
export function audienceOf(bot: Player): number {
    return botsNear(bot.x, bot.z, bot.level, SCAMS.earshot).filter(p => p !== bot && !stints.has(p)).length;
}

/** the callers at a venue now (each with an audience of 3 or more), the social regulars standing there first */
function callersAt(venue: ScamVenue): Player[] {
    const here = botsNear(venue.x, venue.z, venue.level, venue.radius).filter(p => mayCall(p) && audienceOf(p) >= SCAMS.audience);
    return here.sort((a, b) => Number(b.botPlanner === 'extras_social') - Number(a.botPlanner === 'extras_social'));
}

// ── ambient stints ───────────────────────────────────────────────────────────────────────────────────────────────

const CHECK_TICKS = 50;
const ambient = { play: 0, next: -1, retries: 0, checks: 0, started: 0, lastCheck: -1 };
/** (tests) the ambient stints' clock and counts */
export function ambientState(): Readonly<typeof ambient> {
    return ambient;
}

function gap(): number {
    return Math.max(SCAMS.gap[0], Math.min(SCAMS.gap[1], Math.round(logNormal(SCAMS.gapMedian, SCAMS.gapSigma))));
}

/** (tests) an ambient stint's gap as drawn (play ticks) */
export function drawAmbientGap(): number {
    return gap();
}

/** a venue by the shares (60 / 25 / 15) */
export function drawScamVenue(random: () => number = Math.random): ScamVenue {
    let x = random();
    for (const v of SCAM_VENUES) {
        x -= v.share;
        if (x < 0) return v;
    }
    return SCAM_VENUES[0];
}

function humanInWorld(): boolean {
    for (const p of World.playerLoop.all()) if (!p.is_bot) return true;
    return false;
}

/**
 * Every 50 ticks (BotSchedule, inside BotManager.tick): the play clock runs while a human is in the world; when an
 * ambient stint is due, a venue is drawn and a caller there begins (none: a look again in 5 minutes).
 */
function ambientCheck(): void {
    try {
        const now = World.currentTick;
        // (a world started again from tick 0: the clock goes on from there)
        if (now < ambient.lastCheck) ambient.lastCheck = now;
        ambient.lastCheck = now;
        sweep(now);
        if (!rates.ambient || !humanInWorld()) return;
        ambient.play += CHECK_TICKS;
        ambient.checks++;
        // (the first at a point within a gap: a session's chances are the hour's whenever it starts)
        if (ambient.next < 0) ambient.next = ambient.play + Math.round(gap() * (0.1 + 0.9 * Math.random()));
        if (ambient.play < ambient.next || stints.size > 0 || runningSetPieces().some(r => r.kind === 'scam_spree')) return;
        const venue = drawScamVenue();
        const caller = callersAt(venue)[0];
        if (caller && begin(caller, venue, 'ambient', randInt(SCAMS.stint[0], SCAMS.stint[1]))) {
            ambient.started++;
            ambient.retries = 0;
            ambient.next = ambient.play + gap();
            return;
        }
        ambient.next = ++ambient.retries > SCAMS.retries ? ambient.play + gap() : ambient.play + SCAMS.retry;
        if (ambient.retries > SCAMS.retries) ambient.retries = 0;
    } finally {
        scheduleInTicks(CHECK_TICKS, ambientCheck);
    }
}
scheduleInTicks(CHECK_TICKS, ambientCheck);

// ── the spree (a director's set piece) ───────────────────────────────────────────────────────────────────────────

export class ScamRun implements SetPieceRun {
    readonly id: number;
    readonly kind = 'scam_spree' as const;
    readonly venue: ScamVenue;
    phase: SetPiecePhase = 'peak';
    readonly startedAt: number;
    endsBy: number;
    readonly roles = new Map<Player, string>();
    private readonly stints: Stint[] = [];
    private secondAt: number;
    private second: Player | null;
    private finished = false;

    constructor(venue: ScamVenue, first: Player, second: Player | null, ticks: number) {
        const now = World.currentTick;
        this.id = nextSetPieceId();
        this.venue = venue;
        this.startedAt = now;
        this.endsBy = now + ticks;
        this.second = second;
        this.secondAt = now + randInt(SCAMS.second[0], SCAMS.second[1]);
        const stint = begin(first, venue, 'spree', ticks);
        if (stint) {
            this.stints.push(stint);
            this.roles.set(first, 'caller');
        }
    }

    get started(): boolean {
        return this.stints.length > 0;
    }

    tick(now: number): void {
        if (this.phase === 'done') return;
        if (this.second && now >= this.secondAt) {
            const b = this.second;
            this.second = null;
            if (mayCall(b)) {
                const stint = begin(b, this.venue, 'spree', Math.max(200, this.endsBy - now));
                if (stint) {
                    this.stints.push(stint);
                    this.roles.set(b, 'caller');
                }
            }
        }
        sweep(now);
        for (const s of this.stints) if (s.stopped || s.caller.slot === -1) this.roles.delete(s.caller);
        if (now >= this.endsBy || (this.second === null && this.roles.size === 0)) this.finish('done');
    }

    left(p: Player, _why: 'logout' | 'death' | 'fight' | 'stuck'): void {
        const s = this.stints.find(x => x.caller === p);
        if (s) end(s, 'left');
        this.roles.delete(p);
    }

    rumour(): string | null {
        return this.phase === 'done' ? null : anyPieceLine('scam', `rumour-${this.venue.key}`);
    }

    abort(why: string): void {
        this.finish(why);
    }

    private finish(why: string): void {
        if (this.finished) return;
        this.finished = true;
        for (const s of this.stints) end(s, why);
        this.phase = 'done';
        this.roles.clear();
    }
}

/** A spree's plan: the trade bank with the biggest crowd (5+ bots in view), where a rude caller (and a second) stands. */
export function planScamSpree(ctx: SetPieceContext): SetPiecePlan | null {
    let best: { venue: ScamVenue; callers: Player[]; crowd: number } | null = null;
    for (const venue of SCAM_VENUES) {
        const crowd = botsNear(venue.x, venue.z, venue.level, 15).length;
        if (crowd < SCAMS.sprees) continue;
        const callers = callersAt(venue).filter(p => ctx.sessionLeft(p) >= SCAMS.spree[1]);
        if (!callers.length) continue;
        if (!best || crowd > best.crowd || (crowd === best.crowd && ctx.dice() < 0.5)) best = { venue, callers, crowd };
    }
    if (!best) return null;
    return { kind: 'scam_spree', venue: best.venue, score: Math.min(1, best.crowd / 12), data: { callers: best.callers.slice(0, 2) } };
}

export function startScamSpree(plan: SetPiecePlan, ctx: SetPieceContext): ScamRun | null {
    const venue = SCAM_VENUES.find(v => v.key === plan.venue.key);
    const callers = ((plan.data as { callers?: Player[] } | undefined)?.callers ?? []).filter(mayCall);
    if (!venue || !callers.length) return null;
    const ticks = SCAMS.spree[0] + Math.floor(ctx.dice() * (SCAMS.spree[1] - SCAMS.spree[0]));
    const run = new ScamRun(venue, callers[0], callers[1] ?? null, ticks);
    return run.started ? run : null;
}

export const SCAM_SPREE: SetPieceDef = {
    kind: 'scam_spree',
    weight: { members: 15, free: 15 },
    plan: ctx => planScamSpree(ctx),
    start: (plan, ctx) => startScamSpree(plan, ctx)
};
register(SCAM_SPREE);

// ── tests ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** (tests) the ambient stints on or off; the caller's logout after its stint (variety round 1, F) on or off */
export function setScamRatesForTest(over: { ambient?: boolean; logout?: boolean }): void {
    Object.assign(rates, over);
}

/** (tests) a stint begun at once with this caller (null: it could not) */
export function startStintForTest(caller: Player, venueKey = 'varrock_west', ticks = 600): ScamRecord | null {
    const venue = SCAM_VENUES.find(v => v.key === venueKey) ?? SCAM_VENUES[0];
    return begin(caller, venue, 'ambient', ticks)?.record ?? null;
}

/** (tests) every stint ended, the clock back to the start */
export function resetScamsForTest(): void {
    for (const s of [...stints.values()]) end(s, 'test');
    scamLog.length = 0;
    Object.assign(ambient, { play: 0, next: -1, retries: 0, checks: 0, started: 0, lastCheck: -1 });
}

