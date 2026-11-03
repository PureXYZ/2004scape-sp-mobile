// port (the realism work, phase 7: the language model): the model's seam in the bots' chat. With a model there (the
// player's choice in Settings › Bot chat, and the backend present: port/BotModelTypes), the words of a reply to a human
// come from it; the rules still decide whether a bot replies, when (its typing time) and what it does, and their line
// is the fallback (a timeout, an error, a line the guard refuses: port/BotModelGuard). With 'rules', and in every sim,
// nothing here asks anything and the chat is the rules' alone: a sim runs the same with this module loaded.
//
// The foundation (phase 7's shared contract) has the mode, the channel to the page, and the listeners a capture uses
// (humanlike's --model-capture: the training data's situations). Track E (the research,
// §5) built the rest:
//   - the scope (wantsModel): which replies a model writes: port/BotChat.composeReply's vias named, window,
//     conversation, crowd, second and private, unless the intent is one of RULES_ONLY_INTENTS (trades, PK, follow, team
//     up, the marketplace, the rude lines; a reply with an action stays the rules'), and never the player-mod bot's;
//   - the pending reply (askModel): the request goes out through the channel with the prompts port/BotChat rendered
//     from the situation; one per bot (a newer reply of the bot supersedes it: supersedeModelReply), at most
//     MAX_IN_FLIGHT in the world (more fall back at once, 'busy'; (bots ideas, round 4 fixes) a line of the bots' own
//     talk in flight not counted); its deadline (MODEL_DEADLINE_TICKS after the decision
//     and the reply's extra ticks: then the rules' line at once); the answer (onModelReply, handled in the next tick,
//     the world's time) through the guard, then the bot's own `use` (port/BotChat: the persona's style, typed from the
//     decision) or its `fallback` with the reason; (2026-10-26) a refused or empty line asked for once more first
//     (retry), and every settled reply told to the app's log (setModelOutcomeLog);
//   - the stats (modelStats: requests, used, fallbacks by reason, guard refusals by reason, latency in ticks, the lines
//     the rules left unanswered, a log of every reply's story), read by humanlike's MD1-MD6;
//   - a deterministic stub for tests and sims (setModelForTest: replies from the situation, a set latency in ticks, a
//     set failure rate, now and then a planted bad line the guard must catch).
// No dice here: the stub's choices are hashes of the request, so a sim with the stub repeats.
// (bots ideas, round 4: I model) The bots' own talk near the human (port/BotModelAmbient: a thread's turns after the
// opener, a bot's answer to a bot): Settings › Bot chat › Bots' own talk (the page's mode message, `ambient`), its asks
// (`ModelAsk.ambient`: the on-device model always, `mode: 'local'` even with Claude online, no retry, the guard's
// ambient checks), their numbers apart (modelStats.ambient: LM1-LM8; the replies' MD1-MD6 as they were), the log's
// "(ambient)" mark and the stub's ambient words. The replies to the human (wantsModel, MODEL_VIAS, the retry) are as
// they were. (Round 4 fixes) The replies' MAX_IN_FLIGHT counts no line of the bots' own talk (inFlightFor), and a line
// of the bot's to a human gives up its own talk's request first (supersedeAmbient: port/BotChat.sayTyped).
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { toDisplayName } from '#/util/JString.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { AMBIENT_COUNTER_RX, guardReply, substantialLine, withoutName } from '#/engine/bot/port/BotModelGuard.js';
import type { SituationRequest } from '#/engine/bot/port/BotModelPrompt.js';
import type { ChatModelMode, LocalPrompt, ModelFallback, ModelModeMessage, ModelReplyMessage, ModelRequestMessage, OnlinePrompt, ReplyVia, Situation } from '#/engine/bot/port/BotModelTypes.js';
import { MAX_LINE } from '#/engine/bot/port/BotSay.js';
import { scheduleInTicks } from '#/engine/bot/port/BotSchedule.js';
import { worldPlayers } from '#/engine/bot/port/BotPlayers.js';

let mode: ChatModelMode = 'rules';
const present = { local: false, online: false };
// ---- (bots ideas, round 4: I model) Settings › Bot chat › Bots' own talk, as the page tells it ----
let ambientSetting = false;
// ---- end of I model's block ----

/** The page's word (at start and on every change): the player's choice and what is there. Replies waiting on a model no longer there fall back at once. */
export function setModelMode(msg: Pick<ModelModeMessage, 'mode' | 'local' | 'online'> & { ambient?: boolean }): void {
    mode = msg.mode === 'local' || msg.mode === 'online' ? msg.mode : 'rules';
    present.local = msg.local === true;
    present.online = msg.online === true;
    ambientSetting = msg.ambient === true; // (bots ideas, round 4: I model)
    if (!modelAvailable()) for (const p of [...inFlight.values()]) settle(p, 'unavailable');
    // (bots ideas, round 4: I model: the bots' own talk waiting on the on-device model, gone: the rules' lines at once)
    else if (!present.local) for (const p of [...inFlight.values()]) if (p.ask.ambient) settle(p, 'unavailable');
}

/** The player's choice. */
export function modelMode(): ChatModelMode {
    return mode;
}

/** A model can write replies now: the chosen backend is there, or Claude was chosen and the on-device model is there to fall back to. */
export function modelAvailable(): boolean {
    if (mode === 'local') return present.local;
    if (mode === 'online') return present.online || present.local;
    return false;
}

// ---- (bots ideas, round 4: I model) ----
/**
 * The bots' own talk may be the model's now (port/BotModelAmbient): Bots' own talk is Model, a model writes the replies
 * (modelAvailable) and the on-device model is there (ambient lines never go to Claude). No dice.
 */
export function ambientAvailable(): boolean {
    return ambientSetting && modelAvailable() && present.local;
}
// ---- end of I model's block ----

let channel: ((msg: ModelRequestMessage) => void) | null = null;

/** Where requests go: the page's post (runtime/bots/page.ts), or a test's stand-in; null: nowhere (the rules alone). */
export function setModelChannel(fn: ((msg: ModelRequestMessage) => void) | null): void {
    channel = fn;
}

/** the channel requests go through, if any */
export function modelChannel(): ((msg: ModelRequestMessage) => void) | null {
    return channel;
}

/**
 * A reply the rules composed (`kind` 'composed', with their text or null for nothing said) or a line the rules leave
 * unanswered that a model could answer ('candidate': a named line or a reply-window answer nothing understood, a
 * conversation's line no intent matches, a question to nobody). Listeners must not draw dice nor change anything.
 */
export type ComposedListener = (req: SituationRequest, ruleText: string | null, kind: 'composed' | 'candidate') => void;
export const composedListeners: ComposedListener[] = [];

function tell(req: SituationRequest, ruleText: string | null, kind: 'composed' | 'candidate'): void {
    for (const listener of composedListeners) {
        try {
            listener(req, ruleText, kind);
        } catch (err) {
            console.error('[BotModel] a listener failed', err);
        }
    }
}

/** port/BotChat.composeReply: the rules' reply to a human (null: nothing said). */
export function noteComposed(req: SituationRequest, ruleText: string | null): void {
    if (composedListeners.length) tell(req, ruleText, 'composed');
}

/** port/BotChat: a line the rules leave unanswered, that a model could answer. */
export function noteCandidate(req: SituationRequest): void {
    if (composedListeners.length) tell(req, null, 'candidate');
}

// ── The scope (spec §3) ──────────────────────────────────────────────────────────────────────────────────────────

/** 12 s after the decision (and the reply's extra ticks): no usable reply by then, the rules' line at once ('deadline') */
export const MODEL_DEADLINE_TICKS = 20;
/** native gives up after this long and answers null ('timeout'): before the engine's own deadline */
export const NATIVE_TIMEOUT_MS = 9000;
/** requests in flight in the world at most; more fall back at once ('busy'). (Bots ideas, round 4 fixes) Replies to the human: a line of the bots' own talk in flight is not counted */
export const MAX_IN_FLIGHT = 3;
/**
 * (2026-10-26) a line the guard refuses, or an empty one, is asked for once more when this many ticks are left before the
 * deadline (about 1 s a reply on the phone); then the fallback
 */
export const RETRY_MIN_TICKS = 4;

/** the replies a model may write: to a human's line by its name, in the reply window, in its conversation, said to nobody (the crowd, a second bot), a private message */
export const MODEL_VIAS: ReadonlySet<ReplyVia> = new Set<ReplyVia>(['named', 'window', 'conversation', 'crowd', 'second', 'private']);

/**
 * The rules' intents whose reply stays the rules' with a model (adverts, trades,
 * PK lines, "come here", every reply that comes with an action, the marketplace). Each id of port/BotAnswers'
 * stateAnswer, port/BotChat's processIntent and its crowd's and second bot's, and data/chat_responses.json's intents
 * was checked; those not here are the model's to word (their facts ride in the hint): greeting, goodbye, how, combat,
 * whereami, doing, help, asl, age, from, gender, playtime, presence, beg, brb, gear, attacked, whatsup, bank, spots,
 * directions, price, quest, quest_done, money, newbie, skill, mod_how, mod_you, mod_any (a bot that is no mod), second
 * (agreeing, laughing), and the JSON's oziach, guards, total, the skills' levels, knife, thanks, gratsorwelcome, bot,
 * mood, bad_mood, about, chilling, play_time, begging, bye, where, noob, goals, money, advice, combat, bored, joke,
 * who, area, area2, repeat, insult. Also rules-only: any intent with `follow` (a real Follow comes with it), phase
 * 5a's rude replies (port/BotChat tells: the crowd's and the second bot's rude lines and the rude roll in its RUDE_VIAS),
 * the player-mod bot's every reply (its proper sentences: no prompt says it wears a crown), and what is not
 * composeReply's (the conversation's ending, the level-up and newbie thanks, "come here", a friend's opener).
 */
export const RULES_ONLY_INTENTS: ReadonlyMap<string, string> = new Map([
    ['market', "the marketplace: a vendor's answer, or a bot that does not trade saying so"],
    ['market_none', 'the marketplace: "nobody sells that here"'],
    ['trade', 'a trade, yes or no: trades stay rules'],
    ['not_for_sale', '"how much for ur sword": a trade (what it wears is not for sale)'],
    ['pk', 'a PK invitation, yes or no'],
    ['fight', 'a fight or a duel, yes or no'],
    ['follow', '"follow me": a willing bot follows (an action)'],
    ['team', '"wanna team up": an arrangement, yes or no'],
    ['rude', "phase 5a's rude lines (the crowd's rude answer): their 2004 lines stay"],
    ['dance', 'the dance emote comes with it'],
    ['slayer', 'a skill 2004 did not have: a model line would name it (the guard refuses it), the rules answer'],
    ['stat19', 'no skill in 274: the rules answer']
]);

/** the parts of a reply the scope reads (port/BotChat's ReplyRequest has them) */
export interface ModelScopeRequest {
    bot: Player;
    via: ReplyVia;
    intent: { id: string; follow?: boolean } | null;
}

/** §3's scope alone (no mode): a reply a model would write. `rude`: the rules' reply is one of phase 5a's rude lines. */
export function inModelScope(req: ModelScopeRequest, rude = false): boolean {
    if (!MODEL_VIAS.has(req.via) || rude || req.bot.staffModLevel > 0) return false;
    const intent = req.intent;
    if (!intent) return true;
    return intent.follow !== true && !RULES_ONLY_INTENTS.has(intent.id);
}

/** The model writes this reply: a model is there, and the reply is in §3's scope. No dice. */
export function wantsModel(req: ModelScopeRequest, rude = false): boolean {
    return modelAvailable() && inModelScope(req, rude);
}

/**
 * §3: how often a line the rules left unanswered gets a model reply (with a model), by the way it came; the crowd's is its
 * own chance. (2026-10-26, the player never seems ignored: only a line that asks for no answer, an "ok" or a "lol"; any
 * other is always answered, port/BotChat wantsNoAnswer)
 */
export const CANDIDATE_CHANCE = { conversation: 0.75, window: 0.6 } as const;

/** a named line or a private message nothing understood that asks for no answer (2026-10-26; any line before): the persona's chance of a model reply, 0.55-0.9 from its helpfulness and friendliness */
export function unansweredChance(persona: { helpfulness: number; friendliness: number }): number {
    return Math.max(0.55, Math.min(0.9, 0.55 + 0.25 * persona.helpfulness + (0.1 * (persona.friendliness + 1)) / 2));
}

// ── The pending reply ────────────────────────────────────────────────────────────────────────────────────────────

/** One reply's story, for the stats (humanlike's MD1-MD6) and the tests. */
export interface ModelLogEntry {
    /** the request's id (0: none went out: busy, no channel, unavailable) */
    id: number;
    /** the decision's tick */
    t: number;
    bot: string;
    via: ReplyVia;
    intent: string | null;
    /** a line the rules left unanswered (MD6) */
    candidate: boolean;
    heard: string;
    ruleText: string | null;
    /** what the model wrote (null: nothing) */
    raw?: string | null;
    outcome: 'pending' | 'used' | ModelFallback;
    /** the guard's reason, or native's error */
    reason?: string;
    /** (2026-10-26) asked once more after this: the guard's reason, or 'empty' */
    retried?: string;
    /** the stub's planted bad line: the reason the guard should give */
    planted?: string;
    /** the line said (styled) and its tick */
    said?: string;
    saidAt?: number;
    /** the tick the answer was handled */
    replyAt?: number;
    // ---- (bots ideas, round 4: I model) a line of the bots' own talk (port/BotModelAmbient; LM1-LM8) ----
    /** a line of the bots' own talk: its numbers are modelStats.ambient's, not the replies' */
    ambient?: true;
    /** (ambient) the tick the rules' line was due (its rules' timing: LM8) */
    rulesDue?: number;
    /** (ambient) the rules' line ends with a counter-question (LM5) */
    counter?: boolean;
    /** (ambient) the tick it was settled: answered, or fallen back (LM4) */
    settledAt?: number;
    // ---- end of I model's block ----
}

/** What a model is asked for: port/BotChat's reply, decided, with what to do with the answer. */
export interface ModelAsk {
    bot: Player;
    to: Player;
    via: ReplyVia;
    intent: string | null;
    candidate: boolean;
    heard: string;
    situation: Situation;
    local: LocalPrompt;
    online: OnlinePrompt;
    /** the rules' line, said on a fallback (null: nothing) */
    ruleText: string | null;
    /** the tick the reply is too late at (the rules' line at once then) */
    deadline: number;
    /** the persona's echo roll: false drops the human's name from the line (the guard's (d)) */
    keepName: boolean;
    /** the guard passed: say `text` */
    use(text: string, entry: ModelLogEntry): void;
    /** no model line: say the rules' line, or nothing; what it says (null: nothing) */
    fallback(reason: ModelFallback, entry: ModelLogEntry): string | null;
    // ---- (bots ideas, round 4: I model) ----
    /**
     * a line of the bots' own talk (port/BotModelAmbient): the on-device model ('local', whatever the mode), native's
     * timeout `timeoutMs`, no retry, the guard's ambient checks; `rulesDue` and `counter` for the log
     */
    ambient?: { rulesDue: number; counter: boolean; timeoutMs: number };
    // ---- end of I model's block ----
}

interface Pending {
    /** the request's id: a retry's is a new one */
    id: number;
    ask: ModelAsk;
    entry: ModelLogEntry;
    sentAt: number;
}

const inFlight = new Map<number, Pending>();
let byBot = new WeakMap<Player, Pending>();
let nextId = 0;

/** the replies' numbers since the last reset (humanlike's MD1-MD6) */
export const modelStats = {
    /** replies the model was to write (in its scope, decided) */
    eligible: 0,
    /** requests sent */
    requests: 0,
    /** replies said in the model's words */
    used: 0,
    /** fallbacks by reason (port/BotModelTypes ModelFallback) */
    fallbacks: {} as Record<string, number>,
    /** native's errors as they came ('unavailable', 'refused', 'failed: ...') */
    errors: {} as Record<string, number>,
    /** the guard's refusals by reason */
    guard: {} as Record<string, number>,
    /** answers that came after their deadline or supersede (dropped) */
    late: 0,
    /** (2026-10-26) requests asked once more (a refused or empty line) */
    retries: 0,
    /** ticks from each request to its answer */
    latency: [] as number[],
    /** lines the rules left unanswered: sent to the model, said in its words, by the way they came */
    candidates: { eligible: 0, requests: 0, used: 0, byVia: {} as Record<string, number> },
    /** every reply's story, oldest first (the first LOG_MAX) */
    log: [] as ModelLogEntry[],
    // ---- (bots ideas, round 4: I model) the bots' own talk's numbers, apart (LM1-LM8): their stories are in `log`, marked ----
    ambient: emptyAmbientStats()
    // ---- end of I model's block ----
};

// ---- (bots ideas, round 4: I model) ----
/** the bots' own talk's numbers (port/BotModelAmbient): as the replies' (eligible ... latency), and the lines that stayed the rules' by why */
export interface AmbientStats {
    eligible: number;
    requests: number;
    used: number;
    fallbacks: Record<string, number>;
    errors: Record<string, number>;
    guard: Record<string, number>;
    latency: number[];
    /** lines the model could have worded but did not ask for (near no human, a request in flight, the 20 s pace), by why */
    skipped: Record<string, number>;
}

function emptyAmbientStats(): AmbientStats {
    return { eligible: 0, requests: 0, used: 0, fallbacks: {}, errors: {}, guard: {}, latency: [], skipped: {} };
}

/** the numbers an ask counts in: the bots' own talk's, or the replies' */
function statsOf(ask: ModelAsk): AmbientStats | typeof modelStats {
    return ask.ambient ? modelStats.ambient : modelStats;
}
// ---- end of I model's block ----
/** the log and the latencies keep this many (a sim's run has a few hundred; the app's log stops growing there) */
const LOG_MAX = 5000;

function bump(counts: Record<string, number>, key: string): void {
    counts[key] = (counts[key] ?? 0) + 1;
}

// ── (2026-10-26) what happened to each reply, for the app's log ──────────────────────────────────────────────────

/** Where a line about each settled reply goes (the runtime: the app's log); null in tests and sims. */
let outcomeLog: ((line: string) => void) | null = null;

/** The runtime (runtime/bots/page.ts): one line per reply the model was to write, once it is settled. */
export function setModelOutcomeLog(fn: ((line: string) => void) | null): void {
    outcomeLog = fn;
}

/**
 * e.g. `[bots] model #12 Lumby Larry named: said in 3 ticks`, `[bots] model #13 Zezima private: timeout → the rules' line`.
 * (2026-10-27) No words: neither the human's line nor the bot's reply goes to the log (privacy).
 */
function logOutcome(entry: ModelLogEntry, said: string | null): void {
    if (entry.ambient) entry.settledAt = World.currentTick; // (bots ideas, round 4: I model: LM4)
    if (!outcomeLog) return;
    const how = entry.outcome === 'used' ? `said in ${(entry.replyAt ?? World.currentTick) - entry.t} ticks` : `${entry.outcome}${entry.reason ? ` (${entry.reason})` : ''}`;
    const retried = entry.retried ? `, asked again after ${entry.retried}` : '';
    const instead = entry.outcome === 'used' ? '' : said === null ? ' → nothing' : " → the rules' line";
    // (bots ideas, round 4: I model: the bots' own talk marked "(ambient)", for the phone log's counts; no words either)
    try {
        outcomeLog(`[bots] model #${entry.id} ${toDisplayName(entry.bot)} ${entry.via}${entry.ambient ? ' (ambient)' : ''}${entry.candidate ? ' (not understood)' : ''}: ${how}${retried}${instead}`);
    } catch {
        // (a log line never stops a reply)
    }
}

/** The bot's model reply still being written, if any. */
export function pendingModelReply(bot: Player): ModelLogEntry | null {
    return byBot.get(bot)?.entry ?? null;
}

/** requests in flight in the world */
export function modelRequestsInFlight(): number {
    return inFlight.size;
}

/**
 * Ask a model for a reply's words (port/BotChat, a reply in the scope, decided): it supersedes the bot's reply still
 * waiting; with no channel, no model or MAX_IN_FLIGHT already out it falls back at once ('channel', 'unavailable',
 * 'busy'); else the request goes out, and the answer or the deadline settles it.
 */
export function askModel(ask: ModelAsk): void {
    const entry: ModelLogEntry = { id: 0, t: World.currentTick, bot: ask.bot.username, via: ask.via, intent: ask.intent, candidate: ask.candidate, heard: ask.heard, ruleText: ask.ruleText, outcome: 'pending' };
    // (bots ideas, round 4: I model: a line of the bots' own talk, marked, counted apart)
    if (ask.ambient) Object.assign(entry, { ambient: true, rulesDue: ask.ambient.rulesDue, counter: ask.ambient.counter });
    const counts = statsOf(ask);
    if (modelStats.log.length < LOG_MAX) modelStats.log.push(entry);
    counts.eligible++;
    if (ask.candidate) {
        modelStats.candidates.eligible++;
        bump(modelStats.candidates.byVia, ask.via);
    }
    supersedeModelReply(ask.bot);
    if (!(ask.ambient ? ambientAvailable() : modelAvailable())) return fallBack(ask, entry, 'unavailable');
    if (!channel) return fallBack(ask, entry, 'channel');
    // (bots ideas, round 4 fixes, M3: the replies' cap counts the replies; a line of the bots' own talk in flight never
    // makes one 'busy')
    if (inFlightFor(ask) >= MAX_IN_FLIGHT) return fallBack(ask, entry, 'busy');
    const id = ++nextId;
    entry.id = id;
    const p: Pending = { id, ask, entry, sentAt: World.currentTick };
    inFlight.set(id, p);
    byBot.set(ask.bot, p);
    counts.requests++;
    if (ask.candidate) modelStats.candidates.requests++;
    // (bots ideas, round 4: I model: the bots' own talk always to the on-device model, marked; the page sends think false)
    const msg: ModelRequestMessage = ask.ambient
        ? { type: 'bots-lm', id, mode: 'local', ambient: true, local: ask.local, online: ask.online, maxChars: MAX_LINE, timeoutMs: ask.ambient.timeoutMs }
        : { type: 'bots-lm', id, mode: mode === 'online' && present.online ? 'online' : 'local', local: ask.local, online: ask.online, maxChars: MAX_LINE, timeoutMs: NATIVE_TIMEOUT_MS };
    try {
        channel(msg);
    } catch (err) {
        console.error('[BotModel] the request could not be sent', err);
        settle(p, 'channel');
        return;
    }
    scheduleInTicks(ask.deadline - World.currentTick, () => {
        // (p.id: a retry's own)
        if (inFlight.get(p.id) === p) settle(p, 'deadline');
    });
}

/** A newer reply of the bot's: the one it is still waiting for falls back (port/BotChat: its rules' line, or nothing if the conversation moved on). */
export function supersedeModelReply(bot: Player): void {
    const p = byBot.get(bot);
    if (p) settle(p, 'superseded');
}

// ---- (bots ideas, round 4 fixes) ----
/**
 * (M5) A line of the bot's to a human (port/BotChat.sayTyped: the vendor's answer, "sry was afk", ...): a line of its own
 * talk it still waits for falls back (superseded: the rules' line at its rules' time, the keyboard given back), so the
 * line to the human starts from the rules' time, not the model's deadline. Nothing else: no reply to the human is given
 * up, and with no line of its own talk waiting nothing is done (no dice).
 */
export function supersedeAmbient(bot: Player): void {
    const p = byBot.get(bot);
    if (p?.ask.ambient) settle(p, 'superseded');
}

/**
 * (M3) The requests in flight that count toward an ask's MAX_IN_FLIGHT: for a reply, the replies' (a line of the bots' own
 * talk, one at most, apart); for a line of the bots' own talk, all (it is asked only with none in flight).
 */
function inFlightFor(ask: ModelAsk): number {
    if (ask.ambient) return inFlight.size;
    let n = 0;
    for (const p of inFlight.values()) if (!p.ask.ambient) n++;
    return n;
}
// ---- end of round 4 fixes' block ----

function remove(p: Pending): void {
    inFlight.delete(p.id);
    if (byBot.get(p.ask.bot) === p) byBot.delete(p.ask.bot);
}

function settle(p: Pending, reason: ModelFallback): void {
    if (inFlight.get(p.id) !== p) return;
    remove(p);
    fallBack(p.ask, p.entry, reason);
}

function fallBack(ask: ModelAsk, entry: ModelLogEntry, reason: ModelFallback): void {
    bump(statsOf(ask).fallbacks, reason);
    entry.outcome = reason;
    let said: string | null = null;
    try {
        said = ask.fallback(reason, entry);
    } catch (err) {
        console.error('[BotModel] a fallback failed', err);
    }
    logOutcome(entry, said);
}

/**
 * (2026-10-26) a line the guard refused, or an empty one: asked for once more, under a new id, when the deadline leaves
 * time for it (RETRY_MIN_TICKS) and a model and the channel are still there. False: the fallback, as before.
 */
function retry(p: Pending, why: string): boolean {
    const left = p.ask.deadline - World.currentTick;
    // (bots ideas, round 4: I model: none for the bots' own talk: its fallback is the rules' own line, at its time)
    if (p.ask.ambient || p.entry.retried !== undefined || left < RETRY_MIN_TICKS || !channel || !modelAvailable()) return false;
    p.entry.retried = why;
    modelStats.retries++;
    inFlight.delete(p.id);
    p.id = ++nextId;
    p.entry.id = p.id;
    inFlight.set(p.id, p);
    // (native's own timeout before the engine's deadline, as the first request's)
    const timeoutMs = Math.max(1000, Math.min(NATIVE_TIMEOUT_MS, (left - 1) * 600));
    const msg: ModelRequestMessage = { type: 'bots-lm', id: p.id, mode: mode === 'online' && present.online ? 'online' : 'local', local: p.ask.local, online: p.ask.online, maxChars: MAX_LINE, timeoutMs };
    try {
        channel(msg);
    } catch (err) {
        console.error('[BotModel] the request could not be sent again', err);
        settle(p, 'channel');
    }
    return true;
}

/** The page's answer to a request (runtime/bots/page.ts): handled in the next tick (it came between ticks: the world's time, as everything a bot does). */
export function onModelReply(msg: ModelReplyMessage): void {
    if (!msg || typeof msg.id !== 'number') return;
    scheduleInTicks(1, () => handleReply(msg));
}

function handleReply(msg: ModelReplyMessage): void {
    const p = inFlight.get(msg.id);
    if (!p) {
        modelStats.late++;
        return;
    }
    const now = World.currentTick;
    const counts = statsOf(p.ask); // (bots ideas, round 4: I model: the bots' own talk's apart)
    if (counts.latency.length < LOG_MAX) counts.latency.push(now - p.sentAt);
    p.entry.replyAt = now;
    p.entry.raw = typeof msg.text === 'string' ? msg.text : null;
    // (2026-10-26: an empty line, as native words it or as it came, is asked for once more)
    const empty = msg.error === 'failed: empty' || (typeof msg.text === 'string' && msg.text.trim() === '');
    if (empty && retry(p, 'empty')) return;
    if (typeof msg.text !== 'string' || msg.text.trim() === '') {
        remove(p);
        const error = typeof msg.error === 'string' && msg.error ? msg.error : 'failed';
        bump(counts.errors, error);
        p.entry.reason = error;
        // (native's own words: its timeout, its queue full, no backend; anything else, 'refused' and 'failed: ...', an error.
        // Native's 'timeout' (9 s) comes before the engine's deadline: its rules' line is typed, not said at once)
        return fallBack(p.ask, p.entry, error === 'timeout' || error === 'busy' || error === 'unavailable' ? error : 'error');
    }
    const g = guardReply(msg.text, p.ask.situation, { keepName: p.ask.keepName, names: onlineNames(), ...(p.ask.ambient ? { ambient: true } : {}) });
    if (!g.ok) {
        bump(counts.guard, g.reason ?? 'unknown');
        p.entry.reason = g.reason;
        // (2026-10-26: a refused line is asked for once more; a second sample usually passes)
        if (retry(p, g.reason ?? 'guard')) return;
        remove(p);
        return fallBack(p.ask, p.entry, 'guard');
    }
    remove(p);
    counts.used++;
    if (p.ask.candidate) modelStats.candidates.used++;
    p.entry.outcome = 'used';
    try {
        p.ask.use(g.text, p.entry);
    } catch (err) {
        console.error('[BotModel] saying a model reply failed', err);
    }
    logOutcome(p.entry, g.text);
}

/** the display names of everyone in the world (the guard's (e)) */
function onlineNames(): string[] {
    const out: string[] = [];
    for (const p of worldPlayers()) out.push(p.displayName || toDisplayName(p.username));
    return out;
}

// ── The stub (tests and sims) ────────────────────────────────────────────────────────────────────────────────────

/** A test's model: the words for a situation (null: nothing). */
export type StubModel = (s: Situation, msg: ModelRequestMessage) => string | null;

export interface StubOptions {
    /** ticks from the request to the answer (default 2) */
    latencyTicks?: number;
    /** the share of requests that fail: half answer null ('failed: stub'), half never ('timeout') */
    failRate?: number;
    /** the share of answers that are a planted bad line the guard must catch (the default stub's: 0.04) */
    plantRate?: number;
    // ---- (bots ideas, round 4: I model) ----
    /** Settings › Bot chat › Bots' own talk as Model (default false: the bots' own talk stays the rules') */
    ambient?: boolean;
    // ---- end of I model's block ----
}

let stub: { model: StubModel; latency: number; failRate: number; plantRate: number; planted: number; late: number } | null = null;

/**
 * (tests and sims) A deterministic model: `'stub'` (replies from the situation: the hint's facts in a 2004 way, or a
 * shrug, its place or its activity), a function, or null (back to the rules alone). It sets the mode to the on-device
 * model and the channel to itself; its choices are hashes of the request, so a sim with it repeats.
 */
export function setModelForTest(model: StubModel | 'stub' | null, opts: StubOptions = {}): void {
    if (model === null) {
        resetModelForTest();
        return;
    }
    stub = {
        model: model === 'stub' ? stubReply : model,
        latency: Math.max(1, Math.round(opts.latencyTicks ?? 2)),
        failRate: Math.max(0, Math.min(1, opts.failRate ?? 0)),
        plantRate: Math.max(0, Math.min(1, opts.plantRate ?? (model === 'stub' ? 0.04 : 0))),
        planted: 0,
        late: 0
    };
    setModelMode({ mode: 'local', local: true, online: false, ambient: opts.ambient === true });
    setModelChannel(msg => {
        const st = stub;
        const p = inFlight.get(msg.id);
        if (!st || !p) return;
        const s = p.ask.situation;
        const h = hash(`${msg.id}|${s.bot.name}|${s.heard.text}`);
        const fail = (h % 10007) / 10007;
        // (half the failures never answer: the deadline falls back)
        if (fail < st.failRate / 2) return;
        let text: string | null = null;
        if (fail >= st.failRate) {
            const plant = ((h >>> 11) % 10009) / 10009 < st.plantRate ? plantedLine(s, st) : null;
            if (plant) {
                p.entry.planted = plant[0];
                text = plant[1];
            } else text = st.model(s, msg);
        }
        const reply: ModelReplyMessage = { type: 'bots-lm-reply', id: msg.id, text, source: text === null ? null : 'local', ms: st.latency * 600 };
        if (text === null) reply.error = 'failed: stub';
        scheduleInTicks(st.latency, () => handleReply(reply));
    });
}

/** FNV-1a with murmur3's finish (its low bits mixed): the stub's dice */
function hash(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
}

/** the default stub's words: the hint's facts in a 2004 way, or a shrug, its place or its activity; the human's name now and then */
function stubReply(s: Situation, msg: ModelRequestMessage): string {
    if (msg.ambient) return stubAmbient(s, msg); // (bots ideas, round 4: I model)
    const h = hash(`${msg.id}|${s.heard.text}|${s.bot.name}`);
    let line: string;
    if (s.hint && s.hint.text) {
        const base = s.hint.text.toLowerCase();
        const forms = [base, `${base} lol`, `ya ${base}`, `${base} :)`, base, `lol ${base}`];
        line = forms[h % forms.length];
    } else {
        const f = s.facts;
        const forms = ['idk', 'no idea lol', 'lol what', 'huh', 'not sure', 'dunno tbh', f.activity ? `${f.activity} atm` : 'just chilling', f.place ? `im ${f.place.toLowerCase()}` : 'somewhere lol', 'lol', 'maybe'];
        line = forms[h % forms.length];
    }
    // (the human's name now and then: the guard keeps it at the persona's rate)
    if ((h >>> 9) % 6 === 0 && line.length + s.human.name.length < MAX_LINE - 2) line = `${line} ${s.human.name}`;
    return line;
}

// ---- (bots ideas, round 4: I model) ----
/**
 * the default stub's words for a line of the bots' own talk: the rules' line in a 2004 way, its counter-question kept at
 * the end ("ya 41 u?", "lol 41 u?"; a line without one may get a "lol" or a smiley after it), no name
 */
function stubAmbient(s: Situation, msg: ModelRequestMessage): string {
    const h = hash(`${msg.id}|${s.heard.text}|${s.bot.name}|ambient`);
    const base = (s.hint?.text ?? 'lol').toLowerCase();
    const forms = AMBIENT_COUNTER_RX.test(base) ? [base, `ya ${base}`, `lol ${base}`, base] : [base, `ya ${base}`, `${base} lol`, `lol ${base}`, `${base} :)`, base];
    return forms[h % forms.length];
}
// ---- end of I model's block ----

/** (bots ideas, Track B) the planted anachronisms, in turn: two of the late terms and the old one */
const PLANTED_LATE = ['nice whip lol', 'just check the wiki lol', 'doing pest control'];

/** places a planted line may claim (one the bot is not at) */
const ELSEWHERE = ['yanille', 'entrana', 'shilo village', 'burthorpe'];

/** the next planted bad line that fits the situation: [the reason the guard should give, the line], or null */
function plantedLine(s: Situation, st: { planted: number; late: number }): [string, string] | null {
    const numbers = new Set<number>((`${s.hint?.text ?? ''} ${s.heard.text}`.match(/\d+/g) ?? []).map(Number));
    const kinds: [string, () => string | null][] = [
        ['assistant', () => "Certainly! I'd be happy to help you with that."],
        // (bots ideas, Track B: the late terms in turn with the old one, so MD3 sees them caught)
        ['anachronism', () => PLANTED_LATE[st.late++ % PLANTED_LATE.length]],
        ['confession', () => 'lol im a bot'],
        ['promise', () => 'sure ill give u 5k'],
        ['effect', () => 'brb'],
        [
            'level',
            () => {
                let n = s.facts.combat + 7;
                while (numbers.has(n)) n += 3;
                return `im ${n} cb`;
            }
        ],
        [
            'place',
            () => {
                const here = `${s.facts.place ?? ''} ${s.facts.activity ?? ''}`.toLowerCase();
                const there = ELSEWHERE.find(p => !here.includes(p.split(' ')[0]));
                return there && s.facts.wilderness === 0 ? `im in ${there}` : null;
            }
        ],
        [
            'price',
            () => {
                if (s.hint?.intent !== 'price') return null;
                const known = s.hint.text.match(/\d+/);
                return known ? `like ${Number(known[0]) * 3 + 7} ea` : null;
            }
        ],
        [
            'echo',
            () => {
                const heard = withoutName(s.heard.text, s.bot.name);
                return substantialLine(heard) ? heard : null;
            }
        ],
        ['repeat', () => (s.said ?? []).find(l => substantialLine(l) && !/\d/.test(l)) ?? null],
        [
            'name',
            () => {
                const known = new Set([s.human.name, s.bot.name, ...s.facts.friendsNear, ...s.history.map(l => l.name)].map(n => n.toLowerCase()));
                // (a name with a digit: the only kind the guard counts, port/BotModelGuard otherName)
                const other = onlineNames().find(n => n.length >= 4 && !known.has(n.toLowerCase()) && /\d/.test(n) && !s.heard.text.toLowerCase().includes(n.toLowerCase()));
                return other ? `ask ${other} lol` : null;
            }
        ],
        ['long', () => 'x'.repeat(MAX_LINE + 10)],
        ['charset', () => 'ok \u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}'],
        ['filter', () => 'lol fuck off']
    ];
    for (let i = 0; i < kinds.length; i++) {
        const [reason, make] = kinds[(st.planted + i) % kinds.length];
        const line = make();
        if (line) {
            st.planted += i + 1;
            return [reason, line];
        }
    }
    return null;
}

/** (tests) back to the rules alone: no mode, no channel, no stub, no replies waiting, the stats from zero */
export function resetModelForTest(): void {
    mode = 'rules';
    present.local = false;
    present.online = false;
    ambientSetting = false; // (bots ideas, round 4: I model)
    channel = null;
    stub = null;
    inFlight.clear();
    byBot = new WeakMap();
    nextId = 0;
    modelStats.eligible = 0;
    modelStats.requests = 0;
    modelStats.used = 0;
    modelStats.fallbacks = {};
    modelStats.errors = {};
    modelStats.guard = {};
    modelStats.late = 0;
    modelStats.retries = 0;
    modelStats.latency = [];
    modelStats.candidates = { eligible: 0, requests: 0, used: 0, byVia: {} };
    modelStats.log = [];
    modelStats.ambient = emptyAmbientStats(); // (bots ideas, round 4: I model)
}
