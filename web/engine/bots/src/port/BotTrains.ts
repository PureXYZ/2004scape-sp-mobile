// port (the realism work, phase 5b, Track D: groups on the move; "newbie follow trains", round 3): now and then
// a newbie in Lumbridge asks a passer-by "can i follow u?"; if it says yes the newbie follows it with the game's Follow,
// a second and a third newbie may join behind, each following the one ahead (port/BotFollow ChainFollowTask), for 2-6
// minutes. Ambient, not a director's event: 2004's follow trains of newbies
// trailing a high level are widely remembered.
//
//   - The ask (every 25 ticks, one train at a time, one forming every 20 minutes of play at most): a newbie
//     (port/BotNewbie isNewbie) inside Lumbridge's area, free (no sub-task, no part, not fighting, calm), asks a passer-by
//     within 10 tiles with chance 0.3 (a slow-levelling alt half that): a player walking by, a bot of combat 15+ or a
//     social regular, not a newbie. A newbie asks again only after 12 minutes, any newbie only 3 minutes after the last.
//     ("More newbie trains": 6 tiles, 0.15, combat 20+ and 20 minutes made one in 2-4 hours of
//     play; it is the newbies online that set the rate now: 1-2.5 per 100 bots at 10x XP, fewer at 1x.)
//   - The newbie stands while it waits for the answer (a sub-task, TrainAsk). A bot answers after its typing: yes with
//     chance 0.3 + 0.5 x its friendliness (when friendly), "sure lol"; else "nah sorry". The human, if it happens to pass
//     and is asked (the same chance; a reaction to the human, as "who talks" allows): its next line within 30 s
//     says yes (ok, sure, k ...) or no (no, nah ...); silence is a no. A yes from one within 25 tiles (a passer-by walks on
//     while it reads and types) starts the train: the newbie runs after it.
//   - The train: the newbie follows (a part outside the director's runs, port/BotSetPieces setRole: no break, no logout
//     mid-train); every 30 s, with chance 0.3, a free newbie within 10 tiles of the last joins behind it ("wait for
//     me!!"), up to 3; a bot near it may say "lol follow train" (port/BotChatter: 'train-seen').
//   - It ends when the leader stands still a minute, goes 70 tiles from Lumbridge's centre, changes floor or is moved (a
//     gate, a boat, stairs), nears the toll gate or the Wilderness, or after its 2-6 minutes (6 with the human); a human
//     leader ends it with "stop" or "go away" too. The newbies say "ok bye ty" now and then and go back to their newbie
//     plan (still newbies).
// Every line is a set piece's (LineKind 'setpiece', out of H7), counted against its speaker's talk budget. Its log
// (trainsLog) is the humanlike report's G4.
import WordEnc from '#/cache/wordenc/WordEnc.js';
import Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { BotTask, randInt } from '#/engine/bot/tasks/BotTaskBase.js';
import { botPersona, humanLineListeners, inFightQuick, sayTyped } from '#/engine/bot/port/BotChat.js';
import { calm, countAsBudgetedLine, noteEvent } from '#/engine/bot/port/BotChatter.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { ChainFollowTask, type ChainEnd } from '#/engine/bot/port/BotFollow.js';
import { isAway } from '#/engine/bot/port/BotHabits.js';
import { setPieceLine } from '#/engine/bot/port/BotLines.js';
import { isNewbie, isSlowNewbie, lumbridgeLowLevel, LUMBRIDGE_AREA } from '#/engine/bot/port/BotNewbie.js';
import { scheduleInTicks } from '#/engine/bot/port/BotSchedule.js';
import { clearRole, eventRoleOf, setRole } from '#/engine/bot/port/BotSetPieces.js';
import { noteSpoke } from '#/engine/bot/port/BotSpoke.js';
import { reactionTicks, typingTicks } from '#/engine/bot/port/BotTiming.js';

/**
 * the ask's cadence (ticks), and its chance per passer-by within PASS_RANGE (a slow alt's half). ("More newbie
 * trains": at 0.15, 6 tiles and combat 20+ a train came once in 2-4 hours of play at 100 bots; about one an
 * hour now)
 */
const ASK_EVERY = 25;
export const ASK_CHANCE = 0.3;
const PASS_RANGE = 10;
/** a passer-by bot's combat at least (or a social regular) */
const PASSER_COMBAT = 15;
/** one train forming every this many play ticks at most (20 minutes); a newbie's asks this far apart (12 minutes since
 * "more newbie trains": 20 left too few at 1-2 newbies online); any two asks */
export const FORM_GAP = 2000;
const NEWBIE_ASK_GAP = 1200;
const ASK_GAP = 300;
/** a train's time (2-6 minutes), with the human (6) */
export const TRAIN_TICKS: readonly [number, number] = [200, 600];
const HUMAN_TRAIN_TICKS = 600;
/** newbies in a train at most; a join's chance every JOIN_EVERY ticks, a free newbie within JOIN_RANGE of the last */
export const MAX_NEWBIES = 3;
const JOIN_CHANCE = 0.3;
const JOIN_EVERY = 50;
/** (the variety work, round 1, track F: ISS-6) a train of one: the join's chance times this; a joiner this far from the
 * last of the line runs over to it (the game's Follow reaches 25 tiles; within JOIN_RANGE the 1-2.4 newbies per 100
 * online were too few) */
const SHORT_TRAIN_JOIN = 3;
const JOIN_REACH = 25;
/** (variety round 1, F: ISS-6) a new train's first look for a joiner, this long after it formed (then every JOIN_EVERY):
 * the trains toward the toll gate's road ended within half a minute, before the first look at 50 ticks */
const FIRST_JOIN = 15;
const JOIN_RANGE = 10;
/** it ends this far from Lumbridge's centre, with the leader still this long */
export const LUMBRIDGE_CENTRE: readonly [number, number] = [3222, 3218];
export const TRAIN_RANGE = 70;
const LEADER_STILL = 60;
/** the toll gate to Al Kharid: a leader this near it crosses where its train cannot follow */
const TOLL_GATE: readonly [number, number] = [3268, 3227];
const NEAR_GATE = 5;
/** the human's time to answer (30 s, after the line is typed) */
const ANSWER_TICKS = 50;
/**
 * a yes from one this near the newbie starts the train: a passer-by walks on while it reads and types, 10-25 tiles, and
 * the newbie runs after it (ChainFollowTask: the game's Follow within 25 tiles)
 */
const START_RANGE = 25;
/** a bot's answer (its typing, the newbie's reading) is given up this long after the human's would be */
const LATE_ANSWER = 60;
/** a newbie's goodbye's chance (at most two), an onlooker's line's */
const BYE_CHANCE = 0.4;
const SEEN_CHANCE = 0.5;

const YES = /^\s*(ok|okay|okey|sure|k|kk|yes|ya|yea|yeah|yep|yup|fine|np|y|come on|follow me|lets go|ok come)\b/i;
const NO = /^\s*(no|nah|nope|n|go away|leave me alone|get lost|stop)\b/i;
const STOP = /\b(stop following|stop|go away|leave me alone|get lost|quit following|dont follow)\b/i;

export interface TrainRecord {
    start: number;
    startPlay: number;
    end: number;
    /** the newbies, in the line's order */
    members: string[];
    leader: string;
    human: boolean;
    reason: string;
}

/** the trains, oldest first (a capped list): the humanlike report's G4 */
export const trainsLog: TrainRecord[] = [];
const LOG_MAX = 300;

interface Train {
    leader: Player;
    human: boolean;
    members: Player[];
    tasks: Map<Player, ChainFollowTask>;
    start: number;
    until: number;
    lastX: number;
    lastZ: number;
    lastLevel: number;
    stillSince: number;
    nextJoin: number;
    seen: boolean;
    record: TrainRecord;
}

interface Ask {
    newbie: Player;
    stranger: Player;
    human: boolean;
    /** the human's answer by then (its line's typing done) */
    until: number;
    /** (the variety work, round 1, track F: ISS-6) a second newbie asking the leader of the train under way */
    join?: boolean;
}

let train: Train | null = null;
let pending: Ask | null = null;
/** play ticks: the last train formed, the last ask; a newbie's last ask (by name) */
let lastFormed = -Infinity;
let lastAsk = -Infinity;
const askedAt = new Map<string, number>();
let play = 0;

/** Tests only: the ask's chance, the gap between trains, a bot's yes and a join's chance (null: the game's). Never set by the game. */
let rates: { ask: number; form: number; yes: number | null; join: number } = { ask: ASK_CHANCE, form: FORM_GAP, yes: null, join: JOIN_CHANCE };
export function setTrainRatesForTest(r: Partial<{ ask: number; form: number; yes: number; join: number }> | null): void {
    rates = { ask: r?.ask ?? ASK_CHANCE, form: r?.form ?? FORM_GAP, yes: r?.yes ?? null, join: r?.join ?? JOIN_CHANCE };
}
export function resetTrainsForTest(): void {
    if (train) end(train, 'reset', World.currentTick);
    train = null;
    pending = null;
    lastFormed = -Infinity;
    lastAsk = -Infinity;
    askedAt.clear();
    trainsLog.length = 0;
}

/** The train under way (the tests, the humanlike runner): its leader and newbies, or null. */
export function currentTrain(): { leader: Player; human: boolean; members: readonly Player[] } | null {
    return train ? { leader: train.leader, human: train.human, members: train.members } : null;
}

function cheb(ax: number, az: number, bx: number, bz: number): number {
    return Math.max(Math.abs(ax - bx), Math.abs(az - bz));
}

function inLumbridge(p: Player): boolean {
    const a = LUMBRIDGE_AREA;
    return p.level === 0 && p.x >= a.x0 && p.x <= a.x1 && p.z >= a.z0 && p.z <= a.z1;
}

/** a newbie free to ask or join: playing, no sub-task, no part, not fighting, trading or away, calm, not hurt */
function freeNewbie(p: Player, now: number): boolean {
    if (p.is_bot !== true || p.slot === -1 || !isNewbie(p) || !inLumbridge(p)) return false;
    const ai = BotManager.botFor(p);
    if (!ai || ai.hasSubTask() || eventRoleOf(p) || inFightQuick(p) || isAway(p) || p.botTradeTargetPid !== -1) return false;
    if (p.levels[PlayerStat.HITPOINTS] * 2 < p.baseLevels[PlayerStat.HITPOINTS]) return false;
    return calm(p, now);
}

/**
 * port (the variety work, round 1, track F: ISS-6): a bot free to join a train behind its last: a newbie, or any other
 * free low-level about Lumbridge (combat 5 or less: port/BotNewbie.lumbridgeLowLevel, the slow levellers and level-3s the
 * newcomer clock keeps there). Joiners had to be newbies, 1-2.4 per 100 online: every train had one.
 */
function freeJoiner(p: Player, now: number): boolean {
    if (freeNewbie(p, now)) return true;
    if (p.is_bot !== true || p.slot === -1 || !inLumbridge(p) || !(lumbridgeLowLevel(p) || (isSlowNewbie(p.username) && p.combatLevel <= 10))) return false;
    if (p.botPlanner === 'extras_vendor' || p.botPlanner === 'extras_pker' || p.botPlanner === 'extras_edgeville_pker') return false;
    const ai = BotManager.botFor(p);
    if (!ai || ai.hasSubTask() || eventRoleOf(p) || inFightQuick(p) || isAway(p) || p.botTradeTargetPid !== -1) return false;
    if (p.levels[PlayerStat.HITPOINTS] * 2 < p.baseLevels[PlayerStat.HITPOINTS]) return false;
    return calm(p, now);
}

/** a passer-by a newbie asks: walking by on the ground floor; a bot of combat 20+ or a social regular, free; or a human */
function passer(p: Player): boolean {
    if (p.slot === -1 || p.level !== 0 || !p.hasWaypoints()) return false;
    if (p.is_bot !== true) return true;
    if (isNewbie(p) || eventRoleOf(p) || inFightQuick(p) || !BotManager.botFor(p)) return false;
    return p.combatLevel >= PASSER_COMBAT || p.botPlanner === 'extras_social';
}

// ── the tick ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** BotManager.tick, every tick while a human is in the world: the train under way, the ask every ASK_EVERY ticks. */
export function tickTrains(): void {
    listen();
    const now = World.currentTick;
    if (train && now % 5 === 0) advance(train, now);
    if (pending?.human && now > pending.until) silence(pending, now);
    else if (pending && !pending.human && now > pending.until + LATE_ANSWER) pending = null;
    // port (the variety work, round 1, track F: ISS-6): a train of a bot under way: another newbie near its leader may
    // ask to come along too ("can i come too?"); a yes puts it behind the last
    if (train && !train.human && !pending && now % ASK_EVERY === 0 && train.members.length < MAX_NEWBIES) {
        tryAskLeader(train, now);
        return;
    }
    if (now % ASK_EVERY !== 0 || train || pending) return;
    play = BotManager.stats().playTicks;
    if (play - lastFormed < rates.form || (play - lastAsk < ASK_GAP && rates.form > 0)) return;
    tryAsk(now);
}

function tryAsk(now: number): void {
    const newbies: Player[] = [];
    const passers: Player[] = [];
    const a = LUMBRIDGE_AREA;
    for (const p of World.playerLoop.all()) {
        if (p.level !== 0 || p.x < a.x0 - PASS_RANGE || p.x > a.x1 + PASS_RANGE || p.z < a.z0 - PASS_RANGE || p.z > a.z1 + PASS_RANGE) continue;
        if (freeNewbie(p, now) && play - (askedAt.get(p.username) ?? -Infinity) >= NEWBIE_ASK_GAP) newbies.push(p);
        else if (passer(p)) passers.push(p);
    }
    if (newbies.length === 0 || passers.length === 0) return;
    // (in a shuffled order: the dice, not the world's player order, picks who asks)
    for (let i = newbies.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newbies[i], newbies[j]] = [newbies[j], newbies[i]];
    }
    for (const newbie of newbies) {
        for (const stranger of passers) {
            if (cheb(newbie.x, newbie.z, stranger.x, stranger.z) > PASS_RANGE) continue;
            const chance = rates.ask * (isSlowNewbie(newbie.username) ? 0.5 : 1);
            if (Math.random() >= chance) continue;
            askFor(newbie, stranger, now);
            return;
        }
    }
}

/** (variety round 1, F: ISS-6) a free newbie within PASS_RANGE of the leader, not in the train, asks it with the ask's chance */
function tryAskLeader(t: Train, now: number): void {
    const l = t.leader;
    for (const p of World.playerLoop.all()) {
        if (p === l || t.members.includes(p) || p.level !== l.level || cheb(p.x, p.z, l.x, l.z) > PASS_RANGE) continue;
        if (!freeNewbie(p, now) || play - (askedAt.get(p.username) ?? -Infinity) < NEWBIE_ASK_GAP) continue;
        if (Math.random() >= rates.ask * (isSlowNewbie(p.username) ? 0.5 : 1)) continue;
        play = BotManager.stats().playTicks;
        askFor(p, l, now, true);
        return;
    }
}

/** a line to `to`, now and then with its name first ("Kevin can i follow u?") where the filter leaves it whole */
function addressed(text: string, to: Player): string {
    if (Math.random() >= 0.5) return text;
    const name = to.displayName;
    const line = `${name} ${text}`;
    return name && WordEnc.filter(line) === line ? line : text;
}

function askFor(newbie: Player, stranger: Player, now: number, join = false): void {
    const line = setPieceLine(newbie, 'train-ask');
    if (line === null) return;
    const text = addressed(line, stranger);
    if (!join) lastAsk = play;
    askedAt.set(newbie.username, play);
    const persona = botPersona(newbie);
    const delay = reactionTicks(persona, 'notice');
    const typed = delay + typingTicks(persona, text);
    const human = stranger.is_bot !== true;
    pending = { newbie, stranger, human, until: now + typed + ANSWER_TICKS, join };
    sayTyped(newbie, text, { to: stranger, kind: 'setpiece', then: human ? () => noteSpoke(newbie, 'question', World.currentTick, stranger) : undefined }, delay);
    countAsBudgetedLine(newbie);
    const answerIn = human ? typed + ANSWER_TICKS : typed + reactionTicks(botPersona(stranger), 'notice');
    // (it stops and waits for the answer: one that asked and walked on was 20 tiles off by the time it came)
    BotManager.botFor(newbie)?.setSubTask(new AskWaitTask(newbie, now + answerIn + (human ? 5 : LATE_ANSWER)));
    if (!human) {
        const ask = pending;
        scheduleInTicks(answerIn, () => botAnswer(ask));
    }
}

/** a newbie that asked "can i follow u?": it stands until the answer (or the human's silence), then its own task or the train */
class AskWaitTask extends BotTask {
    private readonly newbie: Player;
    private readonly until: number;

    constructor(newbie: Player, until: number) {
        super('TrainAsk');
        this.newbie = newbie;
        this.until = until;
    }

    shouldRun(): boolean {
        return true;
    }

    isComplete(): boolean {
        return World.currentTick >= this.until || pending?.newbie !== this.newbie;
    }

    tick(player: Player): void {
        if (player.hasWaypoints()) player.clearWaypoints();
    }
}

/** the newbie may set off behind the one it asked: a bot, with no sub-task but its wait for the answer */
function mayFollow(newbie: Player): boolean {
    const ai = BotManager.botFor(newbie) as unknown as { hasSubTask(): boolean; subTask?: unknown } | null;
    return ai !== null && (!ai.hasSubTask() || ai.subTask instanceof AskWaitTask);
}

/** a bot asked: yes now and then (a friendly one more often), after its typing; on yes the newbie follows it */
function botAnswer(ask: Ask): void {
    if (pending !== ask) return;
    const { newbie, stranger } = ask;
    if (stranger.slot === -1 || !BotManager.botFor(stranger) || newbie.slot === -1 || !BotManager.botFor(newbie)) {
        pending = null;
        return;
    }
    const friendly = Math.max(0, botPersona(stranger).friendliness);
    const yes = Math.random() < (rates.yes ?? 0.3 + 0.5 * friendly);
    const text = setPieceLine(stranger, yes ? 'train-yes' : 'train-no');
    if (text === null) {
        // (the variety work, round 1, track F: a yes with no fresh line left, a second newbie's ask a moment after the
        // first's: it just lets them come, the newbie follows; a no with none is no answer)
        if (yes && ask.join) {
            pending = null;
            const t = train;
            if (t && t.leader === stranger && t.members.length < MAX_NEWBIES && !t.members.includes(newbie) && newbie.slot !== -1 && cheb(newbie.x, newbie.z, stranger.x, stranger.z) <= START_RANGE && mayFollow(newbie)) join(t, newbie, t.members[t.members.length - 1] ?? stranger, World.currentTick);
            return;
        }
        pending = null;
        return;
    }
    // (the newbie waits for the line, reads it, then sets off on a yes: the ask stays open till then; tickTrains closes
    // one whose answer never came, its speaker gone)
    const read = (): void => {
        if (pending !== ask) return;
        pending = null;
        if (!yes || newbie.slot === -1 || stranger.slot === -1 || cheb(newbie.x, newbie.z, stranger.x, stranger.z) > START_RANGE || newbie.level !== stranger.level || !mayFollow(newbie)) return;
        // (variety round 1, F: ISS-6) a second newbie's yes: behind the train's last; a first one's: a train
        if (ask.join) {
            const t = train;
            if (t && t.leader === stranger && t.members.length < MAX_NEWBIES && !t.members.includes(newbie)) join(t, newbie, t.members[t.members.length - 1] ?? stranger, World.currentTick);
            return;
        }
        if (!train) begin(newbie, stranger, false, World.currentTick);
    };
    sayTyped(stranger, text, { to: newbie, kind: 'setpiece', then: () => scheduleInTicks(reactionTicks(botPersona(newbie), 'notice'), read) }, reactionTicks(botPersona(stranger), 'notice'));
    countAsBudgetedLine(stranger);
}

/** the human did not answer within 30 s: a no (the newbie now and then says so) */
function silence(ask: Ask, now: number): void {
    if (pending !== ask) return;
    pending = null;
    if (Math.random() < 0.3 && BotManager.botFor(ask.newbie)) say(ask.newbie, 'train-sad', ask.stranger);
    void now;
}

// ── the train ────────────────────────────────────────────────────────────────────────────────────────────────────

function begin(newbie: Player, leader: Player, human: boolean, now: number): void {
    lastFormed = play;
    const until = now + (human ? HUMAN_TRAIN_TICKS : randInt(TRAIN_TICKS[0], TRAIN_TICKS[1]));
    const record: TrainRecord = { start: now, startPlay: play, end: -1, members: [], leader: leader.username, human, reason: '' };
    const t: Train = { leader, human, members: [], tasks: new Map(), start: now, until, lastX: leader.x, lastZ: leader.z, lastLevel: leader.level, stillSince: now, nextJoin: now + FIRST_JOIN, seen: false, record };
    train = t;
    if (!join(t, newbie, leader, now)) {
        train = null;
        return;
    }
}

/** a newbie joins the line behind `ahead` (its part: no break, no logout mid-train) */
function join(t: Train, newbie: Player, ahead: Player, now: number): boolean {
    const ai = BotManager.botFor(newbie);
    if (!ai || !mayFollow(newbie)) return false;
    const task = new ChainFollowTask(ahead, Math.max(20, t.until - now + 100), (why: ChainEnd) => void why);
    setRole(newbie, 'train');
    ai.setSubTask(task);
    t.members.push(newbie);
    t.tasks.set(newbie, task);
    t.record.members.push(newbie.username);
    return true;
}

/** a newbie out of the line (its follow ended, it logged out): the one behind it follows the one ahead */
function drop(t: Train, m: Player): void {
    const i = t.members.indexOf(m);
    if (i < 0) return;
    t.members.splice(i, 1);
    t.tasks.get(m)?.finish(m);
    t.tasks.delete(m);
    clearRole(m);
    const next = t.members[i];
    if (next) t.tasks.get(next)?.setLead(next, i === 0 ? t.leader : t.members[i - 1]);
}

function advance(t: Train, now: number): void {
    const l = t.leader;
    let why: string | null = null;
    if (l.slot === -1 || (l.is_bot === true && !BotManager.botFor(l))) why = 'leader gone';
    else if (l.level !== t.lastLevel || cheb(l.x, l.z, t.lastX, t.lastZ) > 12) why = 'crossing';
    else if (l.level !== 0 || wildernessLevelAt(l.x, l.z) > 0 || l.z >= 3500) why = 'wilderness';
    else if (cheb(l.x, l.z, TOLL_GATE[0], TOLL_GATE[1]) <= NEAR_GATE) why = 'toll gate';
    else if (cheb(l.x, l.z, LUMBRIDGE_CENTRE[0], LUMBRIDGE_CENTRE[1]) > TRAIN_RANGE) why = 'far';
    else if (now >= t.until) why = 'time';
    if (l.x !== t.lastX || l.z !== t.lastZ) t.stillSince = now;
    else if (!why && now - t.stillSince >= LEADER_STILL) why = 'still';
    t.lastX = l.x;
    t.lastZ = l.z;
    t.lastLevel = l.level;
    // (its newbies: one whose follow ended, or that left, or another sub-task took, is out of the line)
    for (const m of [...t.members]) {
        const task = t.tasks.get(m);
        const ai = BotManager.botFor(m) as unknown as { subTask?: unknown } | null;
        if (m.slot === -1 || !ai || !task || task.over || (task.lastTickAt >= 0 && now - task.lastTickAt > 15 && ai.subTask !== task)) drop(t, m);
    }
    if (!why && t.members.length === 0) why = 'lost';
    if (why) {
        end(t, why, now);
        return;
    }
    // (another newbie joins behind the last now and then)
    // port (the variety work, round 1, track F: ISS-6): or any free low-level about Lumbridge (freeJoiner: a newbie within
    // JOIN_RANGE of the last, another within JOIN_REACH, which runs over), three times as likely while the train is one long
    if (t.members.length < MAX_NEWBIES && now >= t.nextJoin) {
        t.nextJoin = now + JOIN_EVERY;
        const chance = t.members.length <= 1 ? Math.min(0.9, rates.join * SHORT_TRAIN_JOIN) : rates.join;
        if (Math.random() < chance) {
            const last = t.members[t.members.length - 1];
            for (const p of World.playerLoop.all()) {
                if (p === last || p === t.leader || t.members.includes(p) || p.level !== last.level || cheb(p.x, p.z, last.x, last.z) > (isNewbie(p) ? JOIN_RANGE : JOIN_REACH) || !freeJoiner(p, now)) continue;
                if (join(t, p, last, now)) say(p, 'train-join', last);
                break;
            }
        }
    }
    // (a bot near it may say something of it, once a train)
    if (!t.seen && t.members.length >= 2) {
        t.seen = true;
        if (Math.random() < SEEN_CHANCE) {
            for (const p of World.playerLoop.all()) {
                if (p.is_bot !== true || p === l || t.members.includes(p) || p.level !== l.level || cheb(p.x, p.z, l.x, l.z) > 10 || !BotManager.botFor(p)) continue;
                noteEvent(p, 'train-seen');
                break;
            }
        }
    }
}

function end(t: Train, why: string, now: number): void {
    let byes = 0;
    for (const m of [...t.members]) {
        t.tasks.get(m)?.finish(m);
        clearRole(m);
        if (byes < 2 && m.slot !== -1 && BotManager.botFor(m) && why !== 'reset' && Math.random() < BYE_CHANCE) {
            byes++;
            say(m, 'train-bye', t.leader.slot !== -1 ? t.leader : null);
        }
    }
    t.members.length = 0;
    t.tasks.clear();
    t.record.end = now;
    t.record.reason = why;
    trainsLog.push(t.record);
    if (trainsLog.length > LOG_MAX) trainsLog.shift();
    if (train === t) train = null;
}

/** a set piece's line, typed (LineKind 'setpiece'), counted against the bot's talk budget */
function say(bot: Player, moment: string, to: Player | null): void {
    if (bot.slot === -1 || !BotManager.botFor(bot)) return;
    const text = setPieceLine(bot, moment);
    if (text === null) return;
    sayTyped(bot, text, { to, kind: 'setpiece' }, reactionTicks(botPersona(bot), 'notice'));
    countAsBudgetedLine(bot);
}

// ── the human: asked as a passer-by, or the leader of a train ─────────────────────────────────────────────────────

/**
 * The trains' ears, from the first tick on (not at this module's load: an import cycle through port/BotChat can run this
 * module before BotChat's own body, its listeners' list not made yet: "Cannot access 'humanLineListeners' before
 * initialization", test/knowledge.test's import order)
 */
let listening = false;
function listen(): void {
    if (listening) return;
    listening = true;
    humanLineListeners.push(onHumanLine);
}

function onHumanLine(human: Player, text: string): boolean | void {
    const now = World.currentTick;
    // (asked "can i follow u?": its next line within 30 s answers it; one no other bot answers)
    if (pending?.human && pending.stranger === human) {
        const ask = pending;
        if (YES.test(text)) {
            pending = null;
            // (the newbie reads it, then sets off)
            scheduleInTicks(reactionTicks(botPersona(ask.newbie), 'notice'), () => {
                if (train || human.slot === -1 || ask.newbie.slot === -1) return;
                if (mayFollow(ask.newbie) && cheb(ask.newbie.x, ask.newbie.z, human.x, human.z) <= START_RANGE && ask.newbie.level === human.level) {
                    play = BotManager.stats().playTicks;
                    begin(ask.newbie, human, true, World.currentTick);
                }
            });
            return true;
        }
        if (NO.test(text)) {
            pending = null;
            if (Math.random() < 0.5) say(ask.newbie, 'train-sad', human);
            return true;
        }
    }
    // (leading a train: "stop", "go away" ends it)
    if (train?.human && train.leader === human && STOP.test(text)) {
        end(train, 'told off', now);
        return true;
    }
    return;
}
