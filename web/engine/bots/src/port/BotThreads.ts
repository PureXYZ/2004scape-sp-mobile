// port (the variety work, round 2, Track S2: P4, topic threads): two
// bots talk for 3-6 turns about one thing, as 2004's players did ("wc lvl?" / "41 u?" / "38 lol ur higher" / "how long
// did that take" / "like a week"), where bot-to-bot talk had stopped at a question and its answer (72 % of the
// investigation's 303 exchanges were 1-2 turns, and "Wyd?" / "Just skilling a bit, what about you?" / "Ah ok" never
// answered the counter-question).
//
// A thread is drawn whole when it starts (as port/BotStage's practices are), from both bots' state, then said turn by turn,
// each typed after the speaker reads the last (BotChat.sayTyped, LineKind 'practice': a turn of an exchange between bots),
// and it stops when either leaves, goes away, opens a trade or a window, walks off, or a human talks to it. Its rules:
//   - about 30 topics (data/threads.json): levels and the race to an unlock, combat, total, what u doing, goals, saving up,
//     members, how long u been playing, asl, where u from, drops, randoms, clans, the favourite skill, the bank, school,
//     Halo 2, World of Warcraft, Castle Wars next month, Zezima, the lag, food, music, films, being tired, a friend
//     hacked, a million gp, Dragon Slayer, the weather; each turn's line from the speaker's own state (its levels, task,
//     home, age, clique's clan, last drop, next unlock, next tool);
//   - a counter-question ("41 u?", "cutting willows, wbu") gets the asker's own answer from its state;
//   - each turn after the second may end it (a closer now and then, or silence), and it changes topic at most once (the
//     next speaker opens another: "btw u members?");
//   - pair memory for the session (both bots' logins: a new login is a new Player), bots only and nothing about a human:
//     a topic a pair talked of is followed up ("still 41?", "u get 50 yet?"), never asked again from scratch; asl and
//     "where u from" never twice;
//   - depth up to 6 turns for clique mates and hub regulars (social bots), 3 elsewhere (the plan's default);
//   - one thread at a time in an area (274's 64-tile map square), and an area's next starts a few minutes later.
// Who starts one: a bot whose unprompted line is due, now and then, with a free bot near it (port/BotChatter: the
// thread's opening is that line), the hub regulars' exchanges and the practices near a human (port/BotStage), clique mates
// together (port/BotCliques). Every other turn takes the place of its speaker's next line of its own (the talk budget,
// H7). A fight is no bar (2004's players typed between hits); a trade or a window is, as is a speaker over its share of a
// busy place's talk (port/BotVoice).
// Every roll is Math.random (seeded in the sims) or the names' seeds; nothing reads the wall clock. Per tick nothing: a
// thread is a few scheduled lines.
import WordEnc from '#/cache/wordenc/WordEnc.js';
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { CoordGrid } from '#/engine/CoordGrid.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { BotChat, answerFor, botPersona, sayTyped } from '#/engine/bot/port/BotChat.js';
import { isAway } from '#/engine/bot/port/BotHabits.js';
import { clanNameOf, countAsOwnLine, recentEventsOf } from '#/engine/bot/port/BotChatter.js';
import { contextOf, isFresh, noteSaid } from '#/engine/bot/port/BotLines.js';
import { sameClique } from '#/engine/bot/port/BotCliques.js';
import { styleLine } from '#/engine/bot/port/BotStyle.js';
import { reactionTicks } from '#/engine/bot/port/BotTiming.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { voiceFree, voiceRoom } from '#/engine/bot/port/BotVoice.js';
import { lastChatAt } from '#/engine/bot/port/BotSay.js';
import { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { activityFor } from '#/engine/bot/port/BotActivity.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { formatGp } from '#/engine/bot/port/BotPrices.js';
import type { Persona } from '#/engine/bot/port/BotPersona.js';
import type { SlotValues } from '#/engine/bot/port/BotSlots.js';
import threadsJson from '../../data/threads.json';

// ── the data ─────────────────────────────────────────────────────────────────

type Pool = string[];
type MorePair = [string, Pool];
interface TopicPools {
    ask: Pool;
    [key: string]: Pool | MorePair[] | undefined;
}
interface ThreadsData {
    counter: Pool;
    counterAsk: Pool;
    segue: Pool;
    closers: Pool;
    skills: Pool;
    topics: Record<string, TopicPools>;
}
const DATA = threadsJson as unknown as ThreadsData;

/** Every thread line as the data has it (slots unfilled), for test/chat-filter.test.mjs. */
export const THREAD_LINES = DATA;

// ── the rules' numbers ───────────────────────────────────────────────────────

/** the most turns: clique mates and hub regulars (social bots), anyone else (the plan's default) */
export const DEPTH_FRIENDS = 6;
export const DEPTH_OTHERS = 3;
/** a counter-question's chance on an answer ("41 u?") */
const COUNTER_CHANCE = 0.75;
/** each turn after the second ends the thread this often (a closer now and then: CLOSER_CHANCE) */
const END_CHANCE = 0.12;
const CLOSER_CHANCE = 0.4;
/** the thread changes topic once at this chance when it has two turns or more left (a friends' talk more) */
const CHANGE_CHANCE = 0.3;
const CHANGE_CHANCE_FRIENDS = 0.55;
/** a "more" question (a second question on the topic) at this chance when it has the depth */
const MORE_CHANCE = 0.6;
/** a partner within this of the opener; the two stop past APART */
const PARTNER_DISTANCE = 12;
const APART = 15;
/** the least sociability of a partner */
const SOCIABLE = 0.2;
/** an area's next thread a while after its last began (3-6 minutes) */
const AREA_GAP: [number, number] = [300, 600];
/** a thread still going this long is over (a speaker left before its turn) */
const STALE_TICKS = 400;
/** a thread's lines a speaker says, about (its voice's share of a busy place: port/BotVoice) */
const THREAD_SHARE_LINES = 2;
/** a partner that said something in the last 5 minutes (at its keyboard) weighs this much more */
const CHATTING_TICKS = 500;
const CHATTING_WEIGHT = 4;
/** a clique mate weighs this much more as a partner; a bot at the same task this much */
const MATE_WEIGHT = 4;
const SAME_TASK_WEIGHT = 1.5;

// ── the sides: what a bot would say of itself ───────────────────────────────

const SKILL_STAT: Readonly<Record<string, number>> = { att: 0, def: 1, str: 2, hp: 3, range: 4, prayer: 5, magic: 6, mage: 6, cooking: 7, wc: 8, fletching: 9, fishing: 10, fm: 11, crafting: 12, smithing: 13, mining: 14, herb: 15, agility: 16, thieving: 17, rc: 20 };
const REGION_SAID: Readonly<Record<string, readonly string[]>> = { usa: ['usa', 'us'], uk: ['uk', 'england'], canada: ['canada'], australia: ['aus', 'australia'], netherlands: ['netherlands'], sweden: ['sweden'], ireland: ['ireland'], 'new zealand': ['new zealand'], germany: ['germany'], norway: ['norway'] };

/** one bot of a thread: its persona and what it would say of itself (worked out once, when asked) */
class Side {
    readonly persona: Persona;
    private slotsMemo: SlotValues | null = null;
    constructor(readonly bot: Player) {
        this.persona = botPersona(bot);
    }
    get slots(): SlotValues {
        return (this.slotsMemo ??= contextOf(this.bot).slots ?? {});
    }
    level(skill: string): number {
        return this.bot.baseLevels[SKILL_STAT[skill] ?? 0] ?? 1;
    }
    get cb(): number {
        return this.bot.combatLevel;
    }
    get total(): number {
        return this.bot.baseLevels.reduce((sum, level, stat) => (stat === 18 || stat === 19 ? sum : sum + level), 0);
    }
    /** what it does, in a few words ("cutting willows"), or null */
    get doing(): string | null {
        const task = BotManager.botFor(this.bot)?.currentTask ?? null;
        if (!task) return null;
        let step = null;
        try {
            step = task.activityStep();
        } catch {
            step = null;
        }
        const what = activityFor(task.name.split(':')[0], step);
        return what ? what.toLowerCase().replace(/ lol$/, '') : null;
    }
    /** its next goal: the next unlock of its task's skill ("30 wc for willows"), else the next tool or weapon, else null */
    get goal(): string | null {
        const s = this.slots;
        if (s.next && s.skill) return s.unlock && Math.random() < 0.5 ? `${s.next} ${s.skill} for ${s.unlock}` : `${s.next} ${s.skill}`;
        return s.want ? `a ${s.want}` : null;
    }
    get want(): string | null {
        return this.slots.want ? `a ${this.slots.want}` : null;
    }
    get place(): string | null {
        return this.slots.place ?? null;
    }
    get region(): string {
        const words = REGION_SAID[this.persona.region] ?? [this.persona.region];
        return words[Math.floor(Math.random() * words.length)];
    }
    get g(): string {
        return this.bot.gender === 1 ? 'f' : 'm';
    }
    get clan(): string | null {
        return clanNameOf(this.bot.username);
    }
    /** a drop it picked up in the last 30 minutes, as players named it, or null */
    get drop(): string | null {
        const e = recentEventsOf(this.bot, World.currentTick, 3000).find(x => (x.name === 'rune-drop' || x.name === 'drop' || x.name === 'big-bones') && x.item);
        return e?.item ?? null;
    }
    /** its bank's worth as it would say it: from its total level and its name (the same every time) */
    get bank(): number {
        const r = seededRandom(nameSeed(this.bot.username, 'thread-bank'))();
        return Math.max(2, Math.round((this.total * (20 + 260 * r * r)) / 1000)) * 1000;
    }
    /** its highest skill but Hitpoints, by its short name */
    get best(): string {
        let best = 'wc';
        let level = 0;
        for (const skill of DATA.skills) {
            const l = this.level(skill);
            if (l > level) [best, level] = [skill, l];
        }
        return best;
    }
    /** its favourite skill: its task's, else its highest (its name decides now and then) */
    get fav(): string {
        const own = this.slots.skill;
        const r = seededRandom(nameSeed(this.bot.username, 'thread-fav'))();
        return own && r < 0.6 ? own : this.best;
    }
    /** a member on a free world now and then (its name), on a members world always */
    get member(): boolean {
        return isMembersWorld() || seededRandom(nameSeed(this.bot.username, 'thread-members'))() < 0.25;
    }
    /** has it the game (Halo 2), done Dragon Slayer, by its name (the same every time) */
    owns(what: string, share: number): boolean {
        return seededRandom(nameSeed(this.bot.username, `thread-${what}`))() < share;
    }
}

// ── pair memory (a session's, bots only) ─────────────────────────────────────

interface TopicMemory {
    tick: number;
    /** what was said: the skill and the levels, what each did */
    facts: Record<string, string | number>;
}
type PairMemory = Map<string, TopicMemory>;
const pairs = new WeakMap<Player, WeakMap<Player, PairMemory>>();

function memoryOf(a: Player, b: Player): PairMemory {
    let mine = pairs.get(a);
    if (!mine) pairs.set(a, (mine = new WeakMap()));
    let mem = mine.get(b);
    if (!mem) {
        mem = new Map();
        mine.set(b, mem);
        let theirs = pairs.get(b);
        if (!theirs) pairs.set(b, (theirs = new WeakMap()));
        theirs.set(a, mem);
    }
    return mem;
}

/** (port/BotStage) did this pair talk of `topic` this session (a thread's topic or a practice's id)? */
export function pairTalkedOf(a: Player, b: Player, topic: string): boolean {
    return pairs.get(a)?.get(b)?.has(topic) === true;
}

/** (port/BotStage) the pair talked of `topic` now (a practice) */
export function notePairTopic(a: Player, b: Player, topic: string, facts: Record<string, string | number> = {}): void {
    memoryOf(a, b).set(topic, { tick: World.currentTick, facts });
}

// ── drawing a thread ─────────────────────────────────────────────────────────

export interface ThreadLine {
    speaker: Player;
    to: Player;
    text: string;
}

interface Turn {
    by: 0 | 1;
    text: string;
    /** its line without the counter-question it ends with (a thread cut there ends on the plain answer) */
    plain?: string;
    /** a line said only when it opens the thread or a topic (its freshness is checked: the registry) */
    opener?: boolean;
}

interface Drawn {
    turns: Turn[];
    facts: Record<string, string | number>;
    followUp: boolean;
}

function pick<T>(list: readonly T[]): T {
    return list[Math.floor(Math.random() * list.length)];
}

function pool(topic: string, key: string): Pool {
    const p = DATA.topics[topic]?.[key];
    return Array.isArray(p) && typeof p[0] === 'string' ? (p as Pool) : [];
}

function morePairs(topic: string): MorePair[] {
    const p = DATA.topics[topic]?.more;
    return Array.isArray(p) ? (p as MorePair[]) : [];
}

/** a template with its slots filled ({v} {skill} {next} ...); null when one is left (no value for it) */
function fill(template: string, values: Record<string, string | number | null | undefined>): string | null {
    let ok = true;
    const text = template.replace(/\{([a-z_]+)\}/g, (all, key: string) => {
        const v = values[key];
        if (v === null || v === undefined || v === '') {
            ok = false;
            return all;
        }
        return String(v);
    });
    return ok && WordEnc.filter(text) === text ? text : null;
}

/** a line of `templates` filled (a few tries: one the filter reads across is drawn again), or null */
function line(templates: readonly string[], values: Record<string, string | number | null | undefined>): string | null {
    if (!templates.length) return null;
    for (let i = 0; i < 4; i++) {
        const text = fill(pick(templates), values);
        if (text !== null) return text;
    }
    return null;
}

/** an answer with a counter-question now and then ("41 u?"): the turn, its plain line kept */
function answer(by: 0 | 1, text: string, counter = COUNTER_CHANCE): Turn {
    if (Math.random() >= counter) return { by, text };
    const joined = fill(pick(DATA.counter), { x: text });
    return joined ? { by, text: joined, plain: text } : { by, text };
}

type Cmp = 'lower' | 'higher' | 'same';
const cmp = (mine: number, theirs: number): Cmp => (mine < theirs ? 'lower' : mine > theirs ? 'higher' : 'same');
const CMP_AFTER: Readonly<Record<Cmp, string>> = { lower: 'afterLower', higher: 'afterHigher', same: 'afterSame' };

/**
 * a topic: whether it suits these two (a opens it), and its turns from their state (`prev`: what this pair said of it
 * earlier this session: a follow-up then, or null when it is not to be raised again)
 */
interface Topic {
    weight: number;
    /** never twice for a pair in a session (asl, where u from: the follow-up would be odd) */
    once?: boolean;
    fits?: (a: Side, b: Side) => boolean;
    draw: (a: Side, b: Side, depth: number, prev: TopicMemory | null) => Drawn | null;
}

/**
 * a number compared: a level, combat, total (ask, b's answer with its counter, a's own by the comparison, b's word now
 * and then, a "more" question with the depth); a follow-up of what b said last time ("still 41?" / "43 now :)")
 */
function compareTopic(id: string, value: (s: Side, skill: string | null) => number, skillOf: (a: Side, b: Side) => string | null): Topic['draw'] {
    return (a, b, depth, prev) => {
        const skill = prev ? ((prev.facts.skill as string | undefined) ?? null) : skillOf(a, b);
        const va = value(a, skill);
        const vb = value(b, skill);
        const turns: Turn[] = [];
        // (what each said, by name: either may open the next one)
        const facts: Record<string, string | number> = { [a.bot.username]: va, [b.bot.username]: vb };
        if (skill) facts.skill = skill;
        if (prev) {
            // (a follow-up: what b said last time)
            const was = Number(prev.facts[b.bot.username] ?? vb);
            const next = was + 1 + Math.floor(Math.random() * 3);
            const ask = line(pool(id, 'follow'), { skill, was, next });
            const said = line(pool(id, vb > was ? 'followUp' : 'followSame'), { skill, v: vb });
            if (!ask || !said) return null;
            turns.push({ by: 0, text: ask, opener: true }, { by: 1, text: said });
            const after = line(pool(id, vb > was ? 'afterFollow' : 'afterFollowSame'), { skill });
            if (after && depth >= 3) turns.push({ by: 0, text: after });
            return { turns, facts, followUp: true };
        }
        const ask = line(pool(id, 'ask'), { skill });
        const ans = line(pool(id, 'answer'), { skill, v: vb });
        if (!ask || !ans) return null;
        turns.push({ by: 0, text: ask, opener: true }, answer(1, ans));
        const c = cmp(va, vb);
        const own = line(pool(id, c), { skill, v: va });
        if (own) turns.push({ by: 0, text: own });
        const after = line(pool(id, CMP_AFTER[c]), { skill, next: Math.min(99, Math.max(va, vb) + 1 + Math.floor(Math.random() * 4)) });
        if (after && Math.random() < 0.6) turns.push({ by: 1, text: after });
        moreTurns(id, turns, a, b, depth, id === 'level' ? [va, vb] : null);
        return { turns, facts, followUp: false };
    };
}

/** a "more" question on the topic and its answer, while it has the depth (whose turn it is asks) */
function moreTurns(id: string, turns: Turn[], a: Side, b: Side, depth: number, levels: [number, number] | null = null): void {
    const more = morePairs(id);
    if (!more.length || turns.length + 2 > depth || Math.random() >= MORE_CHANCE) return;
    const asker: 0 | 1 = turns[turns.length - 1].by === 0 ? 1 : 0;
    const other = asker === 0 ? b : a;
    const [q, answers] = pick(more);
    // (a question the human heard lately, or another bot said here, is not asked again: the registry)
    const by = asker === 0 ? a : b;
    if (!isFresh(by.bot.username, q, by.bot.x, by.bot.z, by.bot.level, World.currentTick)) return;
    const level = levels ? levels[asker === 0 ? 1 : 0] : null;
    // ("how long did that take" of a level 1 is no question; its answer by how high the level is)
    if (/^how long/.test(q) && level !== null && level < 5) return;
    const values = { skill: other.slots.skill ?? other.best, next: other.slots.next ?? null, unlock: other.slots.unlock ?? null, place: other.place, k: formatGp(other.bank) };
    const ans = line(/^how long/.test(q) && level !== null ? howLong(id, level) : answers, values);
    if (!ans) return;
    turns.push({ by: asker, text: q }, { by: asker === 0 ? 1 : 0, text: ans });
}

/** "how long did that take" answered by how high the level is ("not long" at 10, "ages lol" at 70) */
function howLong(id: string, level: number): Pool {
    const p = pool(id, level <= 20 ? 'howLongLow' : level <= 60 ? 'howLongMid' : 'howLongHigh');
    return p.length ? p : pool('level', level <= 20 ? 'howLongLow' : level <= 60 ? 'howLongMid' : 'howLongHigh');
}

/**
 * a thing of its own (what it does, its goal, where it lives ...): ask, b's answer with its counter, then a's own when
 * asked (a's line by `own`, the same value its 'same' pool), b's word now and then
 */
function ownTopic(id: string, value: (s: Side) => string | null, opts: { sameWord?: boolean } = {}): Topic['draw'] {
    return (a, b, depth, prev) => {
        const vb = value(b);
        if (vb === null) return null;
        const turns: Turn[] = [];
        const facts: Record<string, string | number> = { [b.bot.username]: vb };
        if (prev) {
            const was = String(prev.facts[b.bot.username] ?? '');
            if (!was) return null;
            const ask = line(pool(id, 'follow'), { was });
            const said = line(pool(id, was === vb ? 'followSame' : 'followUp'), { v: vb });
            if (!ask || !said) return null;
            turns.push({ by: 0, text: ask, opener: true }, { by: 1, text: said });
            const after = line(pool(id, 'afterFollow'), {});
            if (after && depth >= 3 && Math.random() < 0.6) turns.push({ by: 0, text: after });
            return { turns, facts, followUp: true };
        }
        const ask = line(pool(id, 'ask'), {});
        const ans = line(pool(id, 'answer'), { v: vb });
        if (!ask || !ans) return null;
        // (a question back only to one with an answer of its own: "just training mage, u?" to a bot doing nothing went
        // unanswered)
        const va = value(a);
        const first = answer(1, ans, va === null ? 0 : COUNTER_CHANCE);
        turns.push({ by: 0, text: ask, opener: true }, first);
        if (first.plain !== undefined && va !== null) {
            const same = opts.sameWord !== false && va === vb && pool(id, 'same').length > 0;
            const own = line(pool(id, same ? 'same' : 'own'), { v: va });
            if (own) turns.push({ by: 0, text: own });
            facts[a.bot.username] = va;
            const after = line(pool(id, same && pool(id, 'afterSame').length ? 'afterSame' : 'after'), { v: va });
            if (after && Math.random() < 0.55) turns.push({ by: 1, text: after });
        } else {
            const after = line(pool(id, 'after'), { v: vb });
            if (after) turns.push({ by: 0, text: after });
        }
        moreTurns(id, turns, a, b, depth);
        return { turns, facts, followUp: false };
    };
}

/** a yes or no of its own (members, Halo 2, Dragon Slayer, a clan): ask, b's yes/no with its counter, a's own, a word */
function yesNoTopic(id: string, yes: (s: Side) => boolean, after: (a: boolean, b: boolean) => string = () => 'after', values: (s: Side) => Record<string, string | number | null> = () => ({})): Topic['draw'] {
    return (a, b, depth) => {
        const ask = line(pool(id, 'ask'), {});
        const yb = yes(b);
        const ans = line(pool(id, yb ? 'yes' : 'no'), values(b));
        if (!ask || !ans) return null;
        const first = answer(1, ans);
        const turns: Turn[] = [{ by: 0, text: ask, opener: true }, first];
        const ya = yes(a);
        if (first.plain !== undefined) {
            const own = line(pool(id, ya ? 'yes' : 'no'), values(a));
            if (own) turns.push({ by: 0, text: own });
        }
        const word = line(pool(id, after(ya, yb)), values(a));
        if (word && turns.length < depth && Math.random() < 0.6) turns.push({ by: turns[turns.length - 1].by === 0 ? 1 : 0, text: word });
        return { turns, facts: {}, followUp: false };
    };
}

/** small talk (a's line, b's answer, a's own word, b's after): no state but the persona's */
function chatTopic(id: string): Topic['draw'] {
    return (_a, _b, depth) => {
        const ask = line(pool(id, 'ask'), {});
        const ans = line(pool(id, 'answer'), {});
        if (!ask || !ans) return null;
        const turns: Turn[] = [{ by: 0, text: ask, opener: true }];
        const hasOwn = pool(id, 'own').length > 0;
        if (hasOwn) {
            turns.push({ by: 1, text: ans });
            const own = line(pool(id, 'own'), {});
            if (own) turns.push({ by: 0, text: own });
        } else {
            turns.push(answer(1, ans, 0.5));
            if (turns[1].plain !== undefined) {
                const mine = line(pool(id, 'answer'), {});
                if (mine) turns.push({ by: 0, text: mine });
            }
        }
        const after = line(pool(id, 'after'), {});
        if (after && turns.length < depth && Math.random() < 0.55) turns.push({ by: turns[turns.length - 1].by === 0 ? 1 : 0, text: after });
        return { turns, facts: {}, followUp: false };
    };
}

/**
 * the skill a level compare is about: the opener's task's (most of the time), else one of the list that one of the two
 * trained (5+: two level 1s comparing their Magic is nobody's talk)
 */
function skillFor(a: Side, b: Side): string {
    const own = a.slots.skill;
    if (own && own in SKILL_STAT && Math.random() < 0.6) return own;
    let skill = pick(DATA.skills);
    for (let i = 0; i < 5 && Math.max(a.level(skill), b.level(skill)) < 5; i++) skill = pick(DATA.skills);
    return skill;
}

const young = (s: Side): boolean => s.persona.ageBand !== 'adult';

const TOPICS: Readonly<Record<string, Topic>> = {
    level: { weight: 4, draw: compareTopic('level', (s, skill) => s.level(skill ?? 'wc'), skillFor) },
    cb: { weight: 2, draw: compareTopic('cb', s => s.cb, () => null) },
    total: { weight: 1, draw: compareTopic('total', s => s.total, () => null), fits: a => a.total >= 100 },
    doing: { weight: 4, draw: ownTopic('doing', s => s.doing) },
    goal: { weight: 2, draw: ownTopic('goal', s => s.goal, { sameWord: false }) },
    saving: { weight: 1, draw: ownTopic('saving', s => s.want, { sameWord: false }) },
    members: {
        weight: 1,
        draw: (a, b, depth) => {
            const ask = line(pool('members', 'ask'), {});
            const free = !isMembersWorld();
            const kind = (s: Side): string => (!free ? 'yes' : s.member ? 'both' : 'no');
            const ans = line(pool('members', kind(b)), {});
            if (!ask || !ans) return null;
            const first = answer(1, ans);
            const turns: Turn[] = [{ by: 0, text: ask, opener: true }, first];
            if (first.plain !== undefined) {
                const own = line(pool('members', kind(a)), {});
                if (own) turns.push({ by: 0, text: own });
            }
            const word = line(pool('members', free ? 'afterNo' : 'afterYes'), {});
            if (word && turns.length < depth && Math.random() < 0.6) turns.push({ by: turns[turns.length - 1].by === 0 ? 1 : 0, text: word });
            return { turns, facts: {}, followUp: false };
        }
    },
    playtime: {
        weight: 2,
        once: true,
        draw: (a, b) => {
            const ask = line(pool('playtime', 'ask'), {});
            if (!ask) return null;
            // (the fixes, B1: the port's own answers only, port/BotAnswers' "like 2 years"; one of upstream's, "Hard to say,
            // time flies", keeps its words: no counter-question joined to it, nor cut from it, nor its style changed)
            const theirsI = answerFor(ask, b.bot, a.bot);
            const theirs = theirsI && !theirsI.upstream ? theirsI.text : null;
            if (!theirs || theirs.includes('{')) return null;
            const plainB = theirs.replace(/[, ]+(u|you|wbu)\??$/i, '');
            const first = answer(1, plainB);
            const turns: Turn[] = [{ by: 0, text: ask, opener: true }, first];
            if (first.plain !== undefined) {
                const mineI = answerFor(ask, a.bot, b.bot);
                const mine = mineI && !mineI.upstream ? mineI.text.replace(/[, ]+(u|you|wbu)\??$/i, '') : null;
                if (mine && !mine.includes('{')) turns.push({ by: 0, text: mine });
            }
            const after = line(pool('playtime', 'after'), {});
            if (after && Math.random() < 0.5) turns.push({ by: turns[turns.length - 1].by === 0 ? 1 : 0, text: after });
            return { turns, facts: {}, followUp: false };
        }
    },
    asl: {
        weight: 1,
        once: true,
        draw: (a, b) => {
            const ask = line(pool('asl', 'ask'), {});
            const ans = line(pool('asl', 'answer'), { age: b.persona.age, g: b.g, region: b.region });
            if (!ask || !ans) return null;
            const first = answer(1, ans, 0.7);
            const turns: Turn[] = [{ by: 0, text: ask, opener: true }, first];
            const own = line(pool('asl', 'own'), { age: a.persona.age, g: a.g, region: a.region });
            if (own) turns.push({ by: 0, text: own });
            const after = line(pool('asl', 'after'), {});
            if (after && Math.random() < 0.4 && (a.persona.age === b.persona.age || !after.includes('same'))) turns.push({ by: 1, text: after });
            return { turns, facts: {}, followUp: false };
        }
    },
    from: {
        weight: 1,
        once: true,
        draw: (a, b) => {
            const ask = line(pool('from', 'ask'), {});
            const ans = line(pool('from', 'answer'), { region: b.region });
            if (!ask || !ans) return null;
            const first = answer(1, ans);
            const turns: Turn[] = [{ by: 0, text: ask, opener: true }, first];
            const same = a.persona.region === b.persona.region;
            const own = line(pool('from', same ? 'same' : 'own'), { region: a.region });
            if (own && (first.plain !== undefined || same)) turns.push({ by: 0, text: own });
            const after = line(pool('from', 'after'), {});
            if (after && Math.random() < 0.4) turns.push({ by: turns[turns.length - 1].by === 0 ? 1 : 0, text: after });
            return { turns, facts: {}, followUp: false };
        }
    },
    drops: {
        weight: 1,
        fits: (_a, b) => b.cb >= 15,
        draw: (a, b) => {
            const ask = line(pool('drops', 'ask'), {});
            const db = b.drop;
            const ans = line(pool('drops', db ? 'got' : 'none'), { v: db });
            if (!ask || !ans) return null;
            const first = answer(1, ans, 0.6);
            const turns: Turn[] = [{ by: 0, text: ask, opener: true }, first];
            if (first.plain !== undefined) {
                const da = a.drop;
                const own = line(pool('drops', da ? 'got' : 'none'), { v: da });
                if (own) turns.push({ by: 0, text: own });
            }
            const after = line(pool('drops', 'after'), {});
            if (after && Math.random() < 0.5) turns.push({ by: turns[turns.length - 1].by === 0 ? 1 : 0, text: after });
            return { turns, facts: {}, followUp: false };
        }
    },
    randoms: { weight: 1, draw: chatTopic('randoms') },
    clan: {
        weight: 1,
        draw: yesNoTopic('clan', s => s.clan !== null, () => 'after', s => ({ clan: s.clan }))
    },
    favskill: { weight: 1, draw: ownTopic('favskill', s => s.fav) },
    bank: {
        weight: 1,
        fits: (_a, b) => b.cb >= 10,
        draw: (a, b) => {
            const ask = line(pool('bank', 'ask'), {});
            const ans = line(pool('bank', 'answer'), { v: formatGp(b.bank) });
            if (!ask || !ans) return null;
            const first = answer(1, ans, 0.65);
            const turns: Turn[] = [{ by: 0, text: ask, opener: true }, first];
            if (first.plain !== undefined) {
                const own = line(pool('bank', 'own'), { v: formatGp(a.bank) });
                if (own) turns.push({ by: 0, text: own });
                const after = line(pool('bank', a.bank > b.bank ? 'afterRich' : 'afterPoor'), {});
                if (after && Math.random() < 0.6) turns.push({ by: 1, text: after });
            }
            return { turns, facts: {}, followUp: false };
        }
    },
    school: {
        weight: 1,
        draw: (a, b) => {
            const ask = line(pool('school', 'ask'), {});
            const ans = line(pool('school', young(b) ? 'young' : 'adult'), { age: b.persona.age });
            if (!ask || !ans) return null;
            const first = answer(1, ans, young(b) ? 0.6 : 0);
            const turns: Turn[] = [{ by: 0, text: ask, opener: true }, first];
            if (first.plain !== undefined) {
                const own = line(pool('school', young(a) ? 'young' : 'adult'), { age: a.persona.age });
                if (own) turns.push({ by: 0, text: own });
            }
            const after = line(pool('school', 'after'), {});
            if (after && Math.random() < 0.5) turns.push({ by: turns[turns.length - 1].by === 0 ? 1 : 0, text: after });
            return { turns, facts: {}, followUp: false };
        },
        fits: a => young(a)
    },
    halo: { weight: 1, draw: yesNoTopic('halo', s => s.owns('halo', young(s) ? 0.45 : 0.3)) },
    wow: { weight: 1, draw: chatTopic('wow') },
    cw: { weight: 1, draw: chatTopic('cw') },
    zezima: { weight: 1, draw: chatTopic('zezima') },
    lag: { weight: 1, draw: chatTopic('lag') },
    food: { weight: 1, draw: chatTopic('food') },
    music: { weight: 1, draw: chatTopic('music') },
    movies: { weight: 1, draw: chatTopic('movies') },
    tired: { weight: 1, draw: chatTopic('tired') },
    hacked: { weight: 1, once: true, draw: chatTopic('hacked') },
    dream: { weight: 1, draw: chatTopic('dream') },
    quest: { weight: 1, fits: (_a, b) => b.cb >= 25, draw: yesNoTopic('quest', s => s.cb >= 32 || s.owns('dragon', 0.2)) },
    weather: { weight: 1, draw: chatTopic('weather') }
};

/** the topic ids (tests) */
export const THREAD_TOPICS: readonly string[] = Object.keys(TOPICS);

/** a topic for these two now: not one they talked of this session unless it follows up; `not`: the one just talked of */
function topicFor(a: Side, b: Side, mem: PairMemory, not: string | null): { id: string; prev: TopicMemory | null } | null {
    const list: { id: string; w: number; prev: TopicMemory | null }[] = [];
    for (const [id, t] of Object.entries(TOPICS)) {
        if (id === not) continue;
        if (t.fits && !t.fits(a, b)) continue;
        const prev = mem.get(id) ?? null;
        // (a topic talked of is followed up, once, a while later, if it can be; else never raised again this session)
        if (prev) {
            if (t.once || prev.facts.followed || World.currentTick - prev.tick < 1500) continue;
            if (!['level', 'cb', 'total', 'doing'].includes(id)) continue;
        }
        list.push({ id, w: t.weight * (prev ? 2 : 1), prev });
    }
    if (!list.length) return null;
    let x = Math.random() * list.reduce((s, e) => s + e.w, 0);
    for (const e of list) if ((x -= e.w) <= 0) return { id: e.id, prev: e.prev };
    return list[list.length - 1];
}

const stats = { started: 0, byTopic: {} as Record<string, number>, followUps: 0, changed: 0, repeats: 0, depths: [] as number[], counters: 0, countersAnswered: 0, bySource: {} as Record<string, number>, fails: {} as Record<string, number> };

/**
 * A thread for `a` (who opens) and `b`, of at most `depth` turns, drawn from their state and their talk this session; null
 * when nothing fits. Its topics are noted in the pair's memory.
 */
export function drawThread(a: Player, b: Player, depth: number): ThreadLine[] | null {
    const sa = new Side(a);
    const sb = new Side(b);
    const mem = memoryOf(a, b);
    const now = World.currentTick;
    const turns: Turn[] = [];
    const topics: string[] = [];
    let swapped = false;
    let not: string | null = null;
    for (let round = 0; round < 2 && turns.length < depth; round++) {
        // (a second topic: once, now and then, opened by the one who did not say the last line)
        if (round === 1) {
            const friends = depth >= DEPTH_FRIENDS;
            if (depth - turns.length < 2 || Math.random() >= (friends ? CHANGE_CHANCE_FRIENDS : CHANGE_CHANCE)) break;
            swapped = turns[turns.length - 1].by === 0;
        }
        const [first, second] = swapped ? [sb, sa] : [sa, sb];
        let drawn: Drawn | null = null;
        let id = '';
        for (let tries = 0; tries < 3 && !drawn; tries++) {
            const t = topicFor(first, second, mem, not);
            if (!t) break;
            id = t.id;
            drawn = TOPICS[id].draw(first, second, depth - turns.length, t.prev);
            // (an opener another bot said here lately, or the human heard, is drawn again: the registry)
            if (drawn && !isFresh(first.bot.username, drawn.turns[0].text, first.bot.x, first.bot.z, first.bot.level, now)) drawn = null;
        }
        if (!drawn || drawn.turns.length < 2) break;
        if (round === 1) {
            const segue = pick(DATA.segue);
            const opened = `${segue}${drawn.turns[0].text}`;
            if (segue && WordEnc.filter(opened) === opened && opened.length <= 60) drawn.turns[0] = { ...drawn.turns[0], text: opened };
            stats.changed++;
        }
        const prevMem = mem.get(id);
        if (prevMem && !drawn.followUp) stats.repeats++;
        if (drawn.followUp) {
            stats.followUps++;
            drawn.facts.followed = 1;
        }
        mem.set(id, { tick: now, facts: { ...(prevMem?.facts ?? {}), ...drawn.facts } });
        topics.push(id);
        for (const t of drawn.turns) turns.push(swapped ? { ...t, by: t.by === 0 ? 1 : 0 } : t);
        not = id;
    }
    if (turns.length < 2) return null;
    // (each turn after the second may end it: a closer now and then; never right after a counter-question)
    let end = Math.min(turns.length, depth);
    for (let i = 2; i < end; i++) {
        if (turns[i - 1].plain === undefined && Math.random() < END_CHANCE) {
            end = i;
            break;
        }
    }
    const kept = turns.slice(0, end);
    // (cut on a counter-question: its plain answer, a question nobody answers is no ending)
    const last = kept[kept.length - 1];
    if (last.plain !== undefined) kept[kept.length - 1] = { by: last.by, text: last.plain };
    if (end < turns.length && kept.length < depth && Math.random() < CLOSER_CHANCE) kept.push({ by: last.by === 0 ? 1 : 0, text: pick(DATA.closers) });
    for (let i = 0; i < kept.length; i++) {
        if (kept[i].plain === undefined) continue;
        stats.counters++;
        if (i + 1 < kept.length && kept[i + 1].by !== kept[i].by) stats.countersAnswered++;
    }
    stats.started++;
    lastTopics = topics;
    for (const id of topics) stats.byTopic[id] = (stats.byTopic[id] ?? 0) + 1;
    stats.depths.push(kept.length);
    if (stats.depths.length > 5000) stats.depths.shift();
    return kept.map(t => ({ speaker: t.by === 0 ? a : b, to: t.by === 0 ? b : a, text: t.text }));
}

/**
 * (port/BotChat: a bot said gz to `leveller`'s level-up) a question on it from the one who said gz and the leveller's
 * answer, from the level topic's second questions ("how long did that take" / "like a week", "whats ur goal" / "60 for
 * yews"); null when none fits. Noted in the pair's memory.
 */
export function levelUpMore(asker: Player, leveller: Player): [string, string] | null {
    const more = morePairs('level');
    if (!more.length) return null;
    const side = new Side(leveller);
    const values = { skill: side.slots.skill ?? side.best, next: side.slots.next ?? null, unlock: side.slots.unlock ?? null, place: side.place, k: formatGp(side.bank) };
    const level = recentEventsOf(leveller, World.currentTick, 200).find(e => e.name === 'levelup')?.level ?? null;
    for (let i = 0; i < 3; i++) {
        const [q, answers] = pick(more);
        if (/^how long/.test(q) && level !== null && level < 5) continue;
        const a = line(/^how long/.test(q) && level !== null ? howLong('level', level) : answers, values);
        if (a === null || !isFresh(asker.username, q, asker.x, asker.z, asker.level, World.currentTick)) continue;
        notePairTopic(asker, leveller, 'levelup-more');
        return [q, a];
    }
    return null;
}

/** the most turns for these two: friends (a clique) and hub regulars (social bots) talk longer */
export function depthFor(a: Player, b: Player): number {
    return sameClique(a.username, b.username) || a.botPlanner === 'extras_social' || b.botPlanner === 'extras_social' ? DEPTH_FRIENDS : DEPTH_OTHERS;
}

// ── running a thread ─────────────────────────────────────────────────────────

interface Running {
    a: Player;
    b: Player;
    lines: ThreadLine[];
    since: number;
    area: string;
    /** the opener whose first turn is its due line (port/BotChatter): that turn is no extra line */
    counted: Set<Player>;
}

const running = new Map<string, Running>();
const cast = new WeakMap<Player, Running>();
const areaNext = new Map<string, number>();

function areaOf(bot: Player): string {
    return `${bot.x >> 6}_${bot.z >> 6}_${bot.level}`;
}

/** Is the bot in a thread that is still going (port/BotChatter.calm: no line of its own in the middle of one)? */
export function inThread(bot: Player): boolean {
    const r = cast.get(bot);
    return r !== undefined && running.get(r.area) === r && World.currentTick - r.since < STALE_TICKS;
}

/** may a thread start in the bot's area now (none going, its gap over)? */
export function areaFreeForThread(bot: Player, now: number = World.currentTick): boolean {
    const area = areaOf(bot);
    const r = running.get(area);
    if (r && now - r.since < STALE_TICKS) return false;
    return now >= (areaNext.get(area) ?? 0);
}

/** in a trade or a window (a bank, a shop): no thread then (a fight is none: 2004's players typed between hits) */
function occupied(bot: Player): boolean {
    return bot.botTradeTargetPid !== -1 || bot.containsModalInterface();
}

/**
 * a bot free for a thread: playing, not away, trading or in a window, not talking with a human or typing, in no thread,
 * practice or set piece
 */
function free(bot: Player): boolean {
    return BotManager.botFor(bot) !== null && !isAway(bot) && !occupied(bot) && !BotChat.inConversation(bot) && !BotChat.midTalk(bot) && !inThread(bot) && eventRoleOf(bot) === null;
}

/** where a bot will stand at the end of the walk it is on (its route's last waypoint: 274 keeps it at index 0), else its tile */
function walkEnd(p: Player): { x: number; z: number } {
    if (!p.hasWaypoints()) return { x: p.x, z: p.z };
    const c = CoordGrid.unpackCoord(p.waypoints[0]);
    return { x: c.x, z: c.z };
}

/**
 * two bots whose walks end more than APART apart are passing each other: no thread between them (a talk run's "where u
 * from" to a bot on its way to the Duel Arena: its "im from uk u?" came 30 tiles off, and the thread ended there)
 */
function parting(a: Player, b: Player): boolean {
    if (!a.hasWaypoints() && !b.hasWaypoints()) return false;
    const ea = walkEnd(a);
    const eb = walkEnd(b);
    return Math.max(Math.abs(ea.x - eb.x), Math.abs(ea.z - eb.z)) > APART;
}

/**
 * a partner for `a`: a free, sociable bot within PARTNER_DISTANCE on its floor, not walking off away from it, under its
 * voice's share of the place (a clique mate, one at the same task, one standing: likelier); a fight is no bar
 */
function partnerFor(a: Player): Player | null {
    const kind = (BotManager.botFor(a)?.currentTask?.name ?? '').split(':')[0];
    const list: Player[] = [];
    for (const o of BotManager.activeBots()) {
        if (o === a || o.level !== a.level || Math.max(Math.abs(o.x - a.x), Math.abs(o.z - a.z)) > PARTNER_DISTANCE) continue;
        if (!free(o) || isNewbie(o) || botPersona(o).sociability < SOCIABLE || o.botPlanner === 'extras_vendor' || parting(a, o)) continue;
        list.push(o);
    }
    // (one at its keyboard lately, chatting, most of all: talkers talk to each other, and the quiet stay quiet: H6)
    const now = World.currentTick;
    const w = (o: Player): number => botPersona(o).sociability * (sameClique(a.username, o.username) ? MATE_WEIGHT : 1) * ((BotManager.botFor(o)?.currentTask?.name ?? '').split(':')[0] === kind ? SAME_TASK_WEIGHT : 1) * (o.hasWaypoints() ? 0.5 : 1) * (now - lastChatAt(o) <= CHATTING_TICKS ? CHATTING_WEIGHT : 1);
    // (the pick's voice checked last, a few picks at most: port/BotVoice's count is the costliest step at 500 bots; the
    // fixes, B4: uncounted, a partner passed over holds no line of its own)
    for (let tries = 0; tries < 3 && list.length; tries++) {
        let x = Math.random() * list.reduce((s, o) => s + w(o), 0);
        let picked = list[list.length - 1];
        for (const o of list) {
            if ((x -= w(o)) <= 0) {
                picked = o;
                break;
            }
        }
        if (voiceRoom(picked, now, THREAD_SHARE_LINES)) return picked;
        list.splice(list.indexOf(picked), 1);
    }
    return null;
}

/**
 * Starts a thread opened by `a` (its due line, a regular's exchange, a friend's word): with `partner`, or one near it;
 * false when none can (no partner, its area busy, its voice over its share, nothing to talk of). `source`: who started it
 * (the counts).
 */
export function startThread(a: Player, source: string, partner: Player | null = null, depth: number | null = null): boolean {
    const now = World.currentTick;
    const fail = (why: string): false => {
        stats.fails[why] = (stats.fails[why] ?? 0) + 1;
        return false;
    };
    if (!free(a)) return fail('busy');
    if (!areaFreeForThread(a, now)) return fail('area');
    const lines0 = depth === null ? THREAD_SHARE_LINES : Math.max(THREAD_SHARE_LINES, depth >> 1);
    if (!voiceFree(a, now, lines0)) return fail('voice');
    const b = partner ?? partnerFor(a);
    if (!b || b === a) return fail('nobody');
    if (!free(b) || b.level !== a.level || Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) > APART || parting(a, b)) return fail('partner');
    const lines = drawThread(a, b, depth ?? depthFor(a, b));
    if (!lines) return fail('topic');
    stats.bySource[source] = (stats.bySource[source] ?? 0) + 1;
    // (a thread in place of the opener's due line is that line; one begun elsewhere, a friend's, is one of its own lines too)
    begin(a, b, lines, now, source !== 'chatter');
    return true;
}

/** says a drawn thread: one at a time in the area; `countOpener`: the opener's first turn counts as one of its lines */
export function begin(a: Player, b: Player, lines: ThreadLine[], now: number = World.currentTick, countOpener = false): void {
    pruneRunning(now);
    const area = areaOf(a);
    const r: Running = { a, b, lines, since: now, area, counted: new Set(countOpener ? [] : [a]) };
    running.set(area, r);
    cast.set(a, r);
    cast.set(b, r);
    areaNext.set(area, now + AREA_GAP[0] + Math.floor(Math.random() * (AREA_GAP[1] - AREA_GAP[0])));
    if (areaNext.size > 4096) areaNext.clear();
    turn(r, 0);
}

/**
 * (the variety work, round 2, the fixes: B6) the threads over or stale, and those of a bot that logged out (its turn never
 * comes, so turn() never drops it), forgotten: each held its two Players until its map square's next thread
 */
function pruneRunning(now: number): void {
    for (const [area, r] of running) {
        if (now - r.since >= STALE_TICKS || BotManager.botFor(r.a) === null || BotManager.botFor(r.b) === null) running.delete(area);
    }
}

function turn(r: Running, i: number): void {
    const l = r.lines[i];
    if (!l || !going(r)) {
        if (running.get(r.area) === r) running.delete(r.area);
        return;
    }
    const persona = botPersona(l.speaker);
    // (each turn takes the place of the speaker's next line of its own (the talk budget, H7): the opener's first, its due
    // line, apart)
    if (i === 0 && r.counted.has(l.speaker)) r.counted.delete(l.speaker);
    else countAsOwnLine(l.speaker);
    noteSaid(l.speaker, l.text);
    const styled = styleLine(l.text, persona).line;
    sayTyped(l.speaker, styled, { to: l.to, kind: 'practice', then: () => turn(r, i + 1) }, i === 0 ? 0 : reactionTicks(persona, 'notice'));
}

/**
 * both still here, not away, together, and no human talking with either: a fight, a bank's or a trade's window is no bar
 * once it began (274's chatbox stays open under them; a thread at a bank stopped at its opener when the other opened the
 * booth)
 */
function going(r: Running): boolean {
    for (const bot of [r.a, r.b]) {
        // (nor one a set piece took meanwhile: a scam's caller, a party's guest, a duel's watcher has its own lines)
        if (BotManager.botFor(bot) === null || isAway(bot) || BotChat.inConversation(bot) || eventRoleOf(bot) !== null) return false;
    }
    return r.a.level === r.b.level && Math.max(Math.abs(r.a.x - r.b.x), Math.abs(r.a.z - r.b.z)) <= APART && World.currentTick - r.since < STALE_TICKS;
}

// ── the counter-question rule for any bot's answer (port/BotChat) ───────────

/** a counter-question at a line's end: "41 u?", "cutting willows, wbu", "what about you?" */
export const COUNTER_RX = /(?:^|[\s,])(?:u|you)\s*\?+\s*$|\b(?:wbu|hbu)\b\s*\??\s*$|\bwhat about (?:u|you)\b\s*\??\s*$|\band (?:u|you)\s*\??\s*$/i;

/** the line without the counter-question it ends with ("41 u?" → "41"), or null when it has none */
export function withoutCounter(text: string): string | null {
    if (!COUNTER_RX.test(text.trim())) return null;
    const plain = text
        .trim()
        .replace(/[,\s]*(?:what about|and)\s+(?:u|you)\s*\??\s*$/i, '')
        .replace(/[,\s]*\b(?:wbu|hbu)\b\s*\??\s*$/i, '')
        .replace(/[,\s]*\b(?:u|you)\s*\?+\s*$/i, '')
        .trim();
    return plain;
}

/** (port/BotChat) a counter-question asked and answered, for the counts */
export function noteCounter(answered: boolean): void {
    stats.counters++;
    if (answered) stats.countersAnswered++;
}

// ── counts (the humanlike runner, tests) ─────────────────────────────────────

/** the threads' counts so far (a copy) */
export function threadStats(): { started: number; byTopic: Record<string, number>; bySource: Record<string, number>; fails: Record<string, number>; followUps: number; changed: number; repeats: number; depthMedian: number | null; depthMax: number | null; counters: number; countersAnswered: number } {
    const d = [...stats.depths].sort((x, y) => x - y);
    return {
        started: stats.started,
        byTopic: { ...stats.byTopic },
        bySource: { ...stats.bySource },
        fails: { ...stats.fails },
        followUps: stats.followUps,
        changed: stats.changed,
        repeats: stats.repeats,
        depthMedian: d.length ? d[Math.floor(d.length / 2)] : null,
        depthMax: d.length ? d[d.length - 1] : null,
        counters: stats.counters,
        countersAnswered: stats.countersAnswered
    };
}

/** (tests) the topics of the last thread drawn */
let lastTopics: string[] = [];
export function lastThreadTopicsForTest(): string[] {
    return [...lastTopics];
}

/** Tests only: forget the running threads and the areas' gaps (the pair memory stays: it is the bots' own). Never called by the game. */
export function resetThreadsForTest(): void {
    running.clear();
    areaNext.clear();
}

/** (tests) the stat a skill's short name reads */
export function threadSkillStat(skill: string): number | null {
    return SKILL_STAT[skill] ?? null;
}
