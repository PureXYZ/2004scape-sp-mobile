// port: short exchanges between two bots near a human (the realism work, phase 2; "bots talk to each
// other: gz/ty, answers, short exchanges near the human, capped"). Now and then two free, sociable bots within about 30
// tiles of a human have a scripted exchange of 2-4 turns (data/practices.json): a level compare ("wc lvl?" / "54 u?" /
// "47 :("), a price check ("pc on rune scim?" / "like 33k"), a newbie's question and a veteran's answer (from its state:
// port/BotAnswers), a PK invite, asl and "where u from", a friends' bit of banter. At most one per area (274's map
// square) every 3-6 minutes, one at a time per human; a practice used lately is passed over, and a line the human heard
// in the last 45 minutes is drawn again (the repetition registry). Each turn is typed (BotChat.sayTyped: the speaker's
// thinking and typing time) and said `to` the other bot; it stops when either leaves, goes away, starts a fight or a
// trade, walks off, or a human talks to it. Ticked by BotChat.tickTalk (every 20 ticks a human is in the world).
//
// port (the variety work, round 2, Track S2: P4): an exchange is a topic thread (port/BotThreads: 3-6 turns, the
// counter-question answered, a topic change, the pair's memory of the session) most of the time, a practice the rest; a
// pair never does a practice again in a session whose topic it talked of ("asl" twice, "where u from" twice: the
// investigation's vendors at Varrock West), and a regular over its share of its hub's talk opens none (port/BotVoice).
//
// port (the realism work, phase 3: population; "social bots as regulars ... chatting with each other
// and with passers-by"): and at the hubs, wherever the human is: a social regular standing at its hub (tasks/SocialTask)
// now and then has such an exchange with another regular there (most likely) or a free bot standing near it (a vendor at
// its stall, a bot hanging out), at a low rate: each hub about every 50 minutes, its area's gap shared with the
// exchanges near a human (one map square, one exchange at a time); the regular's opening line is one of its persona's
// (port/BotChatter.countAsChatter: its talk to nobody waits a quiet after it).
import WordEnc from '#/cache/wordenc/WordEnc.js';
import { isClientConnected } from '#/engine/entity/NetworkPlayer.js';
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { answerFor, BotChat, botPersona, botsFreeNear, chatDice, isBusy, sayTyped } from '#/engine/bot/port/BotChat.js';
import { itemFromWords, priceOf } from '#/engine/bot/port/BotAnswers.js';
import { isAway } from '#/engine/bot/port/BotHabits.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import type { Persona } from '#/engine/bot/port/BotPersona.js';
import { logNormal, reactionTicks } from '#/engine/bot/port/BotTiming.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { countAsChatter, countAsOwnLine } from '#/engine/bot/port/BotChatter.js';
import { meaningKey } from '#/engine/bot/port/BotLines.js';
import { SocialTask } from '#/engine/bot/tasks/SocialTask.js';
import practicesJson from '../../data/practices.json';
// (the variety work, round 2, Track S2: P4's topic threads and the pairs' memory; P5's cap on one voice)
import { depthFor, drawThread, inThread, notePairTopic, pairTalkedOf } from '#/engine/bot/port/BotThreads.js';
import { voiceFree, voiceRoom } from '#/engine/bot/port/BotVoice.js';

interface Turn {
    by: 'a' | 'b';
    lines?: string[];
    /** a level compare's last turn: a's level lower, higher or the same as b's */
    lower?: string[];
    higher?: string[];
    same?: string[];
    /** a PK invite: b's answer, and a's to it; "from": where they live, the same or not (same/other) */
    yes?: string[];
    no?: string[];
    other?: string[];
    /** the chance the turn is said at all (default 1) */
    optional?: number;
    /**
     * (the variety work, round 1, SAY-15) its lines that say the speaker leaves soon ("my mom says i gotta get off soon"):
     * said only when its session has 5-15 minutes left (BotManager.sessionLeftOf), else another of the turn's
     */
    soon?: string[];
}

interface Practice {
    id: string;
    weight: number;
    needs?: 'newbie';
    turns: Turn[];
}

interface PracticeData {
    skills: string[];
    items: { free: string[]; members: string[] };
    newbieQuestions: string[];
    practices: Practice[];
}

const DATA = practicesJson as unknown as PracticeData;

/** Every practice line as the data has it (slots unfilled), and the slots' words, for test/chat-filter.test.mjs. */
export const PRACTICES = DATA;

/** how often the stage looks around a human, and the chance it starts one then (once an area's gap is over) */
const STAGE_EVERY = 20;
const START_CHANCE = 0.2;
/** an area's gap between two practices: 3-6 minutes */
const AREA_GAP: [number, number] = [300, 600];
/** bots within this of the human take part; the two within this of each other; they stop past this apart */
const NEAR_HUMAN = 30;
const PAIR_DISTANCE = 10;
const APART = 15;
/** the least sociability of a bot that starts one or joins in */
const SOCIABLE = 0.35;
/** a practice used this lately is passed over when another fits; a line the human heard this lately is drawn again */
// (the variety work, round 1: 36 minutes and an hour, by meaning; 18 and 45 minutes by the exact line let a human at a
// hub hear "where u from" and "homework lol" twice within the hour, the humanlike report's W4)
const PRACTICE_REPEAT_TICKS = 3600;
const LINE_REPEAT_TICKS = 6000;

/**
 * port (phase 3): a hub's gap between two of its regulars' exchanges (54-108 minutes: log-normal around their geometric
 * mean, clamped to 13.5 minutes - 5.4 hours; 36-72 took the 10-minute windows with no line to 44-49 % once the
 * hang-outs and the cliques talked too), and the chance one starts at a look once it is over
 */
const HUB_GAP: [number, number] = [5400, 10800];
const HUB_START_CHANCE = 0.3;
/** a regular's partner: within this of it, standing, and at least this sociable; another regular there weighs this much more */
const HUB_PAIR_DISTANCE = 8;
const HUB_SOCIABLE = 0.2;
const HUB_REGULAR_WEIGHT = 3;

/** the skills' stats for a level compare ("cb" and "total" are worked out) */
const SKILL_STAT: Record<string, number> = { att: 0, def: 1, str: 2, range: 4, prayer: 5, magic: 6, cooking: 7, wc: 8, fishing: 10, fm: 11, crafting: 12, smithing: 13, mining: 14 };

interface Staged {
    /** whose exchange it is: the human it is near, or (port, phase 3) the regular at its hub */
    owner: Player;
    a: Player;
    b: Player;
    lines: { speaker: Player; to: Player; text: string }[];
    /** the tick it started (a turn a bot never said, it left meanwhile, ends it after STALE_TICKS) */
    since: number;
}

/** a practice still going this long is over (a speaker left or went away before its turn: no turn follows) */
const STALE_TICKS = 300;

/** the practice going on near each human (or at each regular's hub), and the one each bot is in (inPractice) */
const running = new WeakMap<Player, Staged>();
const cast = new WeakMap<Player, Staged>();
/** each area's next practice (its 64-tile square), each hub's (port, phase 3), each practice's last use, each line's last time heard */
const areaNext = new Map<string, number>();
const hubNext = new Map<string, number>();
const practiceUsed = new Map<string, number>();
const lineHeard = new Map<string, number>();

/** BotChat.tickTalk: every STAGE_EVERY ticks, near each human with no practice going and its area's gap over, now and then one starts */
export function tickStage(): void {
    const now = World.currentTick;
    if (now % STAGE_EVERY !== 0) return;
    for (const human of World.playerLoop.all()) {
        if (human.is_bot || human.slot === -1 || !isClientConnected(human)) continue;
        const current = running.get(human);
        if (current && now - current.since < STALE_TICKS) continue;
        running.delete(human);
        const area = `${human.x >> 6}_${human.z >> 6}_${human.level}`;
        if (now < (areaNext.get(area) ?? 0) || chatDice.roll() >= START_CHANCE) continue;
        const staged = stage(human, now);
        if (!staged) continue;
        areaNext.set(area, now + AREA_GAP[0] + Math.floor(Math.random() * (AREA_GAP[1] - AREA_GAP[0])));
        if (areaNext.size > 4096) areaNext.clear();
        begin(staged);
    }
    tickHubs(now);
}

function begin(staged: Staged): void {
    running.set(staged.owner, staged);
    cast.set(staged.a, staged);
    cast.set(staged.b, staged);
    turn(staged, 0);
}

/**
 * port (phase 3): the regulars at their hubs (tasks/SocialTask), wherever the human is: a hub whose gap is over (and its
 * area's), now and then an exchange between a regular there and another regular or a free bot standing near it
 */
function tickHubs(now: number): void {
    for (const { bot, hub } of SocialTask.regularsAtHubs()) {
        if (now < (hubNext.get(hub) ?? 0) || inPractice(bot)) continue;
        const area = `${bot.x >> 6}_${bot.z >> 6}_${bot.level}`;
        if (now < (areaNext.get(area) ?? 0) || chatDice.roll() >= HUB_START_CHANCE) continue;
        if (BotManager.botFor(bot) === null || isAway(bot) || isBusy(bot) || BotChat.inConversation(bot) || BotChat.midTalk(bot) || inThread(bot)) continue;
        const partners = botsFreeNear(bot, HUB_PAIR_DISTANCE).filter(o => !o.hasWaypoints() && !inPractice(o) && !inThread(o) && botPersona(o).sociability >= HUB_SOCIABLE && !BotChat.inConversation(o));
        if (partners.length === 0) continue;
        const staged = pairUp(bot, weighted(partners, o => botPersona(o).sociability * (o.botPlanner === 'extras_social' ? HUB_REGULAR_WEIGHT : 1)), bot, now);
        if (!staged) continue;
        // (a heavy-tailed gap, about HUB_GAP: the regulars' talk comes in bursts, as people's)
        hubNext.set(hub, now + Math.round(Math.min(3 * HUB_GAP[1], Math.max(HUB_GAP[0] / 4, logNormal(Math.sqrt(HUB_GAP[0] * HUB_GAP[1]), 0.8)))));
        areaNext.set(area, now + AREA_GAP[0] + Math.floor(Math.random() * (AREA_GAP[1] - AREA_GAP[0])));
        countAsChatter(staged.a);
        begin(staged);
    }
}

/** Is the bot in a practice that is still going (port/BotHabits: no break in the middle of one)? */
export function inPractice(bot: Player): boolean {
    const staged = cast.get(bot);
    return staged !== undefined && running.get(staged.owner) === staged && World.currentTick - staged.since < STALE_TICKS;
}

/** two bots near the human and a practice that fits them, its lines drawn; null when there is none */
function stage(human: Player, now: number): Staged | null {
    const free = botsFreeNear(human, NEAR_HUMAN).filter(bot => botPersona(bot).sociability >= SOCIABLE && !BotChat.inConversation(bot) && !inPractice(bot) && !inThread(bot));
    if (free.length < 2) return null;
    const a = weighted(free, bot => botPersona(bot).sociability);
    const partners = free.filter(bot => bot !== a && Math.max(Math.abs(bot.x - a.x), Math.abs(bot.z - a.z)) <= PAIR_DISTANCE);
    if (partners.length === 0) return null;
    return pairUp(a, partners[0], human, now);
}

/**
 * (variety round 2, S2-1) the share of exchanges that are a topic thread (port/BotThreads), near a human and at a hub
 * between regulars (whose threads run to 6 turns); a practice the rest
 */
const THREAD_SHARE_NEAR = 0.65;
const THREAD_SHARE_HUB = 0.75;
/** (variety round 2, S2-1) a practice's topic in the pairs' memory (the thread topic it is, else its own id) */
const PRACTICE_TOPIC: Readonly<Record<string, string>> = { level: 'level', asl: 'asl', from: 'from', halo: 'halo', castlewars: 'cw', zezima: 'zezima', lag: 'lag', school: 'school', drops: 'drops' };
const topicOf = (id: string): string => PRACTICE_TOPIC[id] ?? `practice-${id}`;
/** (variety round 2) what a level compare said (the pair's memory: a thread follows it up, "still 41?") */
let drawnFacts: Record<string, string | number> = {};

/** a practice that fits `a` and `b`, its lines drawn (`owner`: whose exchange it is); null when there is none */
function pairUp(a: Player, b: Player, owner: Player, now: number): Staged | null {
    // (variety round 2, S2: not from a bot over its share of the place's talk; a topic thread most of the time)
    if (!voiceFree(a, now)) return null;
    if (Math.random() < (owner === a ? THREAD_SHARE_HUB : THREAD_SHARE_NEAR)) {
        // (its share of a thread's turns under the voice's cap, the other's too)
        const depth = depthFor(a, b);
        // (the fixes, B4: uncounted, a thread passed over for a practice holds no line)
        const lines = voiceRoom(a, now, depth >> 1) && voiceRoom(b, now, depth >> 1) ? drawThread(a, b, depth) : null;
        if (lines) return { owner, a, b, lines, since: now };
    }
    // a newbie asks, a veteran answers (either way round)
    const newbiePair = newbieOf(a) && b.combatLevel >= 30 ? [a, b] : newbieOf(b) && a.combatLevel >= 30 ? [b, a] : null;
    // (variety round 2, S2-1: not a topic the pair talked of this session)
    const fits = DATA.practices.filter(p => (p.needs === 'newbie' ? newbiePair !== null : true) && !pairTalkedOf(a, b, topicOf(p.id)));
    if (fits.length === 0) return null;
    const fresh = fits.filter(p => now - (practiceUsed.get(p.id) ?? -Infinity) >= PRACTICE_REPEAT_TICKS);
    const practice = weighted(fresh.length ? fresh : fits, p => p.weight);
    const [first, second] = practice.needs === 'newbie' && newbiePair ? newbiePair : [a, b];
    drawnFacts = {};
    const lines = draw(practice, first, second, now);
    if (!lines) return null;
    notePairTopic(first, second, topicOf(practice.id), drawnFacts);
    practiceUsed.set(practice.id, now);
    for (const l of lines) lineHeard.set(meaningKey(l.text), now);
    if (lineHeard.size > 4096) lineHeard.clear();
    return { owner, a: first, b: second, lines, since: now };
}

/** a newbie (port/BotNewbie) or a level-3ish newcomer */
function newbieOf(bot: Player): boolean {
    return isNewbie(bot) || bot.combatLevel <= 10;
}

/** the practice's lines for these two, its slots filled from them (null: a slot it cannot fill) */
function draw(practice: Practice, a: Player, b: Player, now: number): { speaker: Player; to: Player; text: string }[] | null {
    const pa = botPersona(a);
    const pb = botPersona(b);
    const slots: Record<string, string> = {
        a_age: String(pa.age), a_g: a.gender === 1 ? 'f' : 'm', a_region: regionSaid(pa),
        b_age: String(pb.age), b_g: b.gender === 1 ? 'f' : 'm', b_region: regionSaid(pb)
    };
    let compare: 'lower' | 'higher' | 'same' = 'same';
    let pkYes = false;
    const sameHome = pa.region === pb.region;
    if (practice.id === 'level' || practice.id === 'race') {
        const skill = pick(DATA.skills);
        const [la, lb] = [levelIn(a, skill), levelIn(b, skill)];
        slots.skill = skill;
        slots.a = String(la);
        slots.b = String(lb);
        slots.next = String(Math.min(99, Math.max(la, lb) + 1 + Math.floor(Math.random() * 5)));
        compare = la < lb ? 'lower' : la > lb ? 'higher' : 'same';
        if (practice.id === 'race' && (skill === 'cb' || skill === 'total' || la >= 99)) return null;
        // (variety round 2: what the pair said, for a later "still 41?"; a level compare of combat or total is no skill's)
        if (practice.id === 'level' && skill !== 'cb' && skill !== 'total') drawnFacts = { skill, [a.username]: la, [b.username]: lb };
    } else if (practice.id === 'price') {
        const pool = [...DATA.items.free, ...(isMembersWorld() ? DATA.items.members : [])];
        const said = pick(pool);
        const item = itemFromWords(said.split(' '));
        if (!item) return null;
        slots.item = said;
        slots.price = priceOf(item.id, b);
    } else if (practice.id === 'newbie') {
        const question = pick(DATA.newbieQuestions);
        const answer = answerFor(question, b, a);
        if (!answer || answer.text.includes('{')) return null;
        slots.question = question;
        slots.answer = answer.text;
    } else if (practice.id === 'pk') {
        const pker = b.botPlanner === 'extras_pker' || b.botPlanner === 'extras_edgeville_pker';
        pkYes = pker || (b.combatLevel >= 40 && pb.sociability > 0.6 && Math.random() < 0.5);
    }
    const out: { speaker: Player; to: Player; text: string }[] = [];
    for (const t of practice.turns) {
        if (t.optional !== undefined && Math.random() >= t.optional) break;
        const speaker = t.by === 'a' ? a : b;
        const all = t.lines ?? (practice.id === 'level' ? t[compare] : practice.id === 'from' ? (sameHome ? t.same : t.other) : pkYes ? t.yes : t.no);
        // (variety round 1, SAY-15: "gotta get off soon" only from a bot whose session ends soon)
        const pool = all ? turnLines(t, all, BotManager.sessionLeftOf(speaker.username)) : all;
        if (!pool || pool.length === 0) return null;
        const to = t.by === 'a' ? b : a;
        // (a line the human heard lately is drawn again, a few times; so is one whose slots met in a way the word filter
        // reads across, "14 f uk", and the practice is off if it stays so)
        let text = '';
        for (let i = 0; i < 4; i++) {
            text = fill(pick(pool), slots);
            if (now - (lineHeard.get(meaningKey(text)) ?? -Infinity) >= LINE_REPEAT_TICKS && WordEnc.filter(text) === text) break;
        }
        if (text.includes('{') || WordEnc.filter(text) !== text) return null;
        out.push({ speaker, to, text });
    }
    return out.length >= 2 ? out : null;
}

/**
 * the next turn, typed (the speaker reads the last line first); the practice ends when a bot cannot go on. (The variety
 * work, round 2, the fixes: B3: each turn in the place of a line of its speaker's own, as a thread's turns are
 * (port/BotThreads), the talk budget, H7; only a regular's opening at its hub was, countAsChatter in tickHubs. Before,
 * an exchange's turns came on top of both bots' own lines and CHATTER_SCALE was lowered for them.)
 */
function turn(staged: Staged, i: number): void {
    const line = staged.lines[i];
    if (!line || !going(staged)) {
        if (running.get(staged.owner) === staged) running.delete(staged.owner);
        return;
    }
    if (i > 0 || !staged.owner.is_bot) countAsOwnLine(line.speaker);
    sayTyped(line.speaker, line.text, { to: line.to, kind: 'practice', then: () => turn(staged, i + 1) }, i === 0 ? 0 : reactionTicks(botPersona(line.speaker), 'notice'));
}

/**
 * both still here, not away, together, and no human talking with either. (Variety round 2, S2-1: a fight, a bank's or a
 * trade's window is no bar once it began, players typed between hits and at the booth: an exchange stopped at its opener
 * when the other hit its next cow or opened the bank.)
 */
function going(staged: Staged): boolean {
    const { a, b } = staged;
    for (const bot of [a, b]) {
        if (BotManager.botFor(bot) === null || isAway(bot) || BotChat.inConversation(bot)) return false;
    }
    return a.level === b.level && Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) <= APART && staged.owner.slot !== -1;
}

/** (variety round 1, SAY-15) a session left of 5-15 minutes: "my mom says i gotta get off soon" is true */
const SOON: [number, number] = [500, 1500];
/** (variety round 1, SAY-15) a turn's lines a speaker with `sessionLeft` play ticks left may say (its "soon" ones only near its end) */
export function turnLines(turn: { soon?: string[] }, lines: readonly string[], sessionLeft: number): readonly string[] {
    if (!turn.soon?.length || (sessionLeft >= SOON[0] && sessionLeft <= SOON[1])) return lines;
    return lines.filter(l => !turn.soon!.includes(l));
}

function levelIn(bot: Player, skill: string): number {
    if (skill === 'cb') return bot.combatLevel;
    if (skill === 'total') return bot.baseLevels.reduce((sum, level, stat) => (stat === 18 || stat === 19 ? sum : sum + level), 0);
    return bot.baseLevels[SKILL_STAT[skill] ?? 0];
}

const REGION_SAID: Record<string, string[]> = { usa: ['usa', 'us'], uk: ['uk', 'england'], canada: ['canada'], australia: ['aus', 'australia'], netherlands: ['netherlands'], sweden: ['sweden'], ireland: ['ireland'], 'new zealand': ['new zealand'], germany: ['germany'], norway: ['norway'] };
function regionSaid(persona: Persona): string {
    return pick(REGION_SAID[persona.region] ?? [persona.region]);
}

function fill(template: string, slots: Record<string, string>): string {
    return template.replace(/\{([a-z_]+)\}/g, (all, key: string) => slots[key] ?? all);
}

function pick<T>(list: readonly T[]): T {
    return list[Math.floor(Math.random() * list.length)];
}

function weighted<T>(list: readonly T[], weight: (item: T) => number): T {
    const total = list.reduce((sum, item) => sum + weight(item), 0);
    let x = Math.random() * total;
    for (const item of list) {
        x -= weight(item);
        if (x <= 0) return item;
    }
    return list[list.length - 1];
}
