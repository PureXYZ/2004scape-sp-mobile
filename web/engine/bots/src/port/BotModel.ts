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
//     MAX_IN_FLIGHT in the world (more fall back at once, 'busy'); its deadline (MODEL_DEADLINE_TICKS after the decision
//     and the reply's extra ticks: then the rules' line at once); the answer (onModelReply, handled in the next tick,
//     the world's time) through the guard, then the bot's own `use` (port/BotChat: the persona's style, typed from the
//     decision) or its `fallback` with the reason;
//   - the stats (modelStats: requests, used, fallbacks by reason, guard refusals by reason, latency in ticks, the lines
//     the rules left unanswered, a log of every reply's story), read by humanlike's MD1-MD6;
//   - a deterministic stub for tests and sims (setModelForTest: replies from the situation, a set latency in ticks, a
//     set failure rate, now and then a planted bad line the guard must catch).
// No dice here: the stub's choices are hashes of the request, so a sim with the stub repeats.
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { toDisplayName } from '#/util/JString.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { guardReply, substantialLine, withoutName } from '#/engine/bot/port/BotModelGuard.js';
import type { SituationRequest } from '#/engine/bot/port/BotModelPrompt.js';
import type { ChatModelMode, LocalPrompt, ModelFallback, ModelModeMessage, ModelReplyMessage, ModelRequestMessage, OnlinePrompt, ReplyVia, Situation } from '#/engine/bot/port/BotModelTypes.js';
import { MAX_LINE } from '#/engine/bot/port/BotSay.js';
import { scheduleInTicks } from '#/engine/bot/port/BotSchedule.js';

let mode: ChatModelMode = 'rules';
const present = { local: false, online: false };

/** The page's word (at start and on every change): the player's choice and what is there. Replies waiting on a model no longer there fall back at once. */
export function setModelMode(msg: Pick<ModelModeMessage, 'mode' | 'local' | 'online'>): void {
    mode = msg.mode === 'local' || msg.mode === 'online' ? msg.mode : 'rules';
    present.local = msg.local === true;
    present.online = msg.online === true;
    if (!modelAvailable()) for (const p of [...inFlight.values()]) settle(p, 'unavailable');
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
/** requests in flight in the world at most; more fall back at once ('busy') */
export const MAX_IN_FLIGHT = 3;

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

/** §3: how often a line the rules left unanswered gets a model reply (with a model), by the way it came; the crowd's is its own chance */
export const CANDIDATE_CHANCE = { conversation: 0.75, window: 0.6 } as const;

/** a named line or a private message nothing understood: the persona's chance of a model reply, 0.55-0.9 from its helpfulness and friendliness */
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
    /** the stub's planted bad line: the reason the guard should give */
    planted?: string;
    /** the line said (styled) and its tick */
    said?: string;
    saidAt?: number;
    /** the tick the answer was handled */
    replyAt?: number;
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
    /** no model line: say the rules' line, or nothing */
    fallback(reason: ModelFallback, entry: ModelLogEntry): void;
}

interface Pending {
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
    /** ticks from each request to its answer */
    latency: [] as number[],
    /** lines the rules left unanswered: sent to the model, said in its words, by the way they came */
    candidates: { eligible: 0, requests: 0, used: 0, byVia: {} as Record<string, number> },
    /** every reply's story, oldest first (the first LOG_MAX) */
    log: [] as ModelLogEntry[]
};
/** the log and the latencies keep this many (a sim's run has a few hundred; the app's log stops growing there) */
const LOG_MAX = 5000;

function bump(counts: Record<string, number>, key: string): void {
    counts[key] = (counts[key] ?? 0) + 1;
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
    if (modelStats.log.length < LOG_MAX) modelStats.log.push(entry);
    modelStats.eligible++;
    if (ask.candidate) {
        modelStats.candidates.eligible++;
        bump(modelStats.candidates.byVia, ask.via);
    }
    supersedeModelReply(ask.bot);
    if (!modelAvailable()) return fallBack(ask, entry, 'unavailable');
    if (!channel) return fallBack(ask, entry, 'channel');
    if (inFlight.size >= MAX_IN_FLIGHT) return fallBack(ask, entry, 'busy');
    const id = ++nextId;
    entry.id = id;
    const p: Pending = { id, ask, entry, sentAt: World.currentTick };
    inFlight.set(id, p);
    byBot.set(ask.bot, p);
    modelStats.requests++;
    if (ask.candidate) modelStats.candidates.requests++;
    const msg: ModelRequestMessage = { type: 'bots-lm', id, mode: mode === 'online' && present.online ? 'online' : 'local', local: ask.local, online: ask.online, maxChars: MAX_LINE, timeoutMs: NATIVE_TIMEOUT_MS };
    try {
        channel(msg);
    } catch (err) {
        console.error('[BotModel] the request could not be sent', err);
        settle(p, 'channel');
        return;
    }
    scheduleInTicks(ask.deadline - World.currentTick, () => {
        if (inFlight.get(id) === p) settle(p, 'deadline');
    });
}

/** A newer reply of the bot's: the one it is still waiting for falls back (port/BotChat: its rules' line, or nothing if the conversation moved on). */
export function supersedeModelReply(bot: Player): void {
    const p = byBot.get(bot);
    if (p) settle(p, 'superseded');
}

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
    bump(modelStats.fallbacks, reason);
    entry.outcome = reason;
    try {
        ask.fallback(reason, entry);
    } catch (err) {
        console.error('[BotModel] a fallback failed', err);
    }
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
    remove(p);
    const now = World.currentTick;
    if (modelStats.latency.length < LOG_MAX) modelStats.latency.push(now - p.sentAt);
    p.entry.replyAt = now;
    p.entry.raw = typeof msg.text === 'string' ? msg.text : null;
    if (typeof msg.text !== 'string' || msg.text.trim() === '') {
        const error = typeof msg.error === 'string' && msg.error ? msg.error : 'failed';
        bump(modelStats.errors, error);
        p.entry.reason = error;
        // (native's own words: its timeout, its queue full, no backend; anything else, 'refused' and 'failed: ...', an error.
        // Native's 'timeout' (9 s) comes before the engine's deadline: its rules' line is typed, not said at once)
        return fallBack(p.ask, p.entry, error === 'timeout' || error === 'busy' || error === 'unavailable' ? error : 'error');
    }
    const g = guardReply(msg.text, p.ask.situation, { keepName: p.ask.keepName, names: onlineNames() });
    if (!g.ok) {
        bump(modelStats.guard, g.reason ?? 'unknown');
        p.entry.reason = g.reason;
        return fallBack(p.ask, p.entry, 'guard');
    }
    modelStats.used++;
    if (p.ask.candidate) modelStats.candidates.used++;
    p.entry.outcome = 'used';
    try {
        p.ask.use(g.text, p.entry);
    } catch (err) {
        console.error('[BotModel] saying a model reply failed', err);
    }
}

/** the display names of everyone in the world (the guard's (e)) */
function onlineNames(): string[] {
    const out: string[] = [];
    for (const p of World.playerLoop.all()) out.push(p.displayName || toDisplayName(p.username));
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
}

let stub: { model: StubModel; latency: number; failRate: number; plantRate: number; planted: number } | null = null;

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
        planted: 0
    };
    setModelMode({ mode: 'local', local: true, online: false });
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

/** places a planted line may claim (one the bot is not at) */
const ELSEWHERE = ['yanille', 'entrana', 'shilo village', 'burthorpe'];

/** the next planted bad line that fits the situation: [the reason the guard should give, the line], or null */
function plantedLine(s: Situation, st: { planted: number }): [string, string] | null {
    const numbers = new Set<number>((`${s.hint?.text ?? ''} ${s.heard.text}`.match(/\d+/g) ?? []).map(Number));
    const kinds: [string, () => string | null][] = [
        ['assistant', () => "Certainly! I'd be happy to help you with that."],
        ['anachronism', () => 'just check the wiki lol'],
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
                const other = onlineNames().find(n => n.length >= 4 && !known.has(n.toLowerCase()) && !/\d/.test(n) && !s.heard.text.toLowerCase().includes(n.toLowerCase()));
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
    modelStats.latency = [];
    modelStats.candidates = { eligible: 0, requests: 0, used: 0, byVia: {} };
    modelStats.log = [];
}
