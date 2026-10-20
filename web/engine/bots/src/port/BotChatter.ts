// port: what a bot says unprompted and when (the realism work, phase 2: "upstream first, gated" and
// "quiet majority"). Upstream gave every bot the same 0.3 % a tick for an idle line, in any state (BotPlayer's
// IDLE_LINE_CHANCE: about 18 lines an hour each, mid-fight, at the bank, running away), and a newbie 1.2 %.
//
// Now each bot talks at its persona's rate (port/BotPersona chattiness: most a few lines an hour, a few chatterboxes),
// in bursts (one to three lines, then a heavy-tailed quiet: its burstiness), and:
//   - events first: a death, a near death, a drop, a full pack, a tree it felled or one taken from it, a rock stolen,
//     arriving at a hub, logging in, its level-ups (port/BotPlayer.onLevelUp): the bot speaks of them now and then
//     (its persona), and a line due soon after is about them;
//   - then lines that fit where it is and what it does (port/BotLines: upstream's first, the 2004 lines to fill the
//     gaps; a repetition registry);
//   - nothing mid-fight (the combat lock), with an interface open (a bank, a shop, a trade), trading, running from an
//     attacker, on a short break (port/BotHabits.isAway) or talking with a human: a line due then waits a while;
//   - a newbie newcomer (port/BotNewbie) half the time its own questions and begs, at a newbie's rate (15-36 an hour);
//   - after a question, a level-up line or a greeting with other players near, BotChat.onBotLine (the bots near may
//     answer it), and port/BotSpoke notes it ('question', 'event', 'levelup': a human's answer finds it);
//   - the moments of port/BotHabits (a short break, back, leaving) through sayOccasion.
// Per bot and tick: a counter and a comparison; every 8 ticks a look at its pack and Hitpoints; the line picking (a loop
// over the players and the lines) only when a line is due.
//
// (The variety work, round 1, Track S)
//   - a line about an event uses the event up, its category's too (a death line the death: one death line a death; a
//     Wilderness death's line the plain death as well: SAY-5);
//   - the registry notes the line as picked, before the style (the key it checks: SAY-14), a slot line's template too;
//   - talk with company (P2): alone (nobody within 15 tiles) a bot talks at a fifth of its rate (LONE_RATE: people mutter
//     alone, now and then), a line due when its company left waits a while for company and is dropped; with company the
//     persona's rate rises a little (1 + 0.15 a player near, up to 4); a milestone level-up alone is said half as often
//     (99 always); event lines as before;
//   - a clan's recruiting call in its capes' colour (P10; the persona's signature, the 99's flash and wave and a clan's
//     other calls went, 2026-10-18: 2004's players dressed up their adverts, not their talk);
//   - a line with an emote does it (a "dance!" dances).
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import type Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { BotChat } from '#/engine/bot/port/BotChat.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { isFleeing } from '#/engine/bot/port/BotDefence.js';
import { isAway } from '#/engine/bot/port/BotHabits.js';
import { contextOf, EVENT_WINDOW, isFresh, levelUpLine, nearBank, noteSaid, pickLine, stepTargets, taskKind, type LineContext, type Picked } from '#/engine/bot/port/BotLines.js';
import { isNewbie, NEWBIE_BEG_SHARE, NEWBIE_BEGS, NEWBIE_OWN_SHARE, NEWBIE_QUESTIONS, newbieLinesPerHour } from '#/engine/bot/port/BotNewbie.js';
import { personaOf, type Persona } from '#/engine/bot/port/BotPersona.js';
import type { PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { botSay, lastChatAt, type LineKind } from '#/engine/bot/port/BotSay.js';
import { isQuestionText } from '#/engine/bot/port/BotChat.js';
import { scheduleInTicks } from '#/engine/bot/port/BotSchedule.js';
import { lastHeard, noteSpoke, type SpokeKind } from '#/engine/bot/port/BotSpoke.js';
import { styleLine } from '#/engine/bot/port/BotStyle.js';
import { logNormal, typingTicks } from '#/engine/bot/port/BotTiming.js';
// (the variety work, round 1, Track S: the line's event and class, the clan's name and colour, the emote, the look)
import { heardClassOf, isSpecificLine, lineEventOf } from '#/engine/bot/port/BotLines.js';
import { cliqueColourOf, cliqueInfoOf } from '#/engine/bot/port/BotCliques.js';
import { everydayEmote, EMOTES, type Emote } from '#/engine/bot/port/BotEmote.js';
import { hashString } from '#/engine/bot/port/BotSeed.js';
import type { ChatStyle } from '#/engine/bot/port/BotSay.js';
import type { HeardClass } from '#/engine/bot/port/BotSpoke.js';
import { itemSay } from '#/engine/bot/port/BotSlots.js';
import lines2004VarietyJson from '../../data/lines2004-variety.json';
import { stallOf, takeAdvertTurn } from '#/engine/bot/port/BotTradeSpots.js';
import { tradeScreen } from '#/engine/bot/port/BotTradeScreen.js';
import { cliqueDeparture, saidGoodbyeLately } from '#/engine/bot/port/BotCliques.js';
// (the realism work's phase 5a, Track F: the arguments' lines and the incidents they are about; a death's carelessness)
import { NEW_LINES, type Line } from '#/engine/bot/port/BotLines.js';
import { claimArgument, incidentPlayers, rudeTalker, stoleIt, type Incident } from '#/engine/bot/port/BotRude.js';
import { noteDeath } from '#/engine/bot/port/BotFumble.js';
// (the realism work's phase 5b, Track A: a duellist's part in a duel, port/BotSetPieces)
import { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';
// (the variety work, round 2, Track S2: a thread instead of the due line now and then, a busy place's voices, a drop answered)
import { inThread, startThread } from '#/engine/bot/port/BotThreads.js';
import { voiceFree } from '#/engine/bot/port/BotVoice.js';
import { dropBrag, respondTo } from '#/engine/bot/port/BotWitness.js';

/** A moment that comes with a line: going away for a moment, coming back, leaving the game. */
export type Occasion = 'brb' | 'back' | 'departure';
const OCCASION_KIND: Record<Occasion, LineKind> = { brb: 'brb', back: 'brb', departure: 'departure' };

/**
 * the persona's lines an hour times this (the "quiet majority" band: 4-10 non-trade lines an hour, all kinds counted;
 * 0.45 alone gave 6.2-7.2, and with the bots' answers to each other, their gz and the habits' brb and goodbyes 7.8-9.1
 * with only 39-50 % of 10-minute windows quiet: H6's band is 50-80 %; 0.35 gave 7.4-8.8 and 45-53 %). (The variety work,
 * round 2, Track S2: 0.3 to 0.26: the threads, the witnesses' words and the responses are talk too, and talk with
 * somebody takes the place of talk to nobody (countAsOwnLine); at 0.3 with a leaky budget they took H7 at 10x XP from
 * 7.9-8.3 to 9.0-9.3; at 0.28 H7 at 500 bots was 9.6-10.3 in three runs, 8.9 before, and H6 36-48 % in most runs.)
 * (The round's fixes, B3: back to 0.3. 0.26 trimmed every persona's lines of its own, upstream's among them, by about
 * 13 % for talk the debt did not charge: an exchange's turns but the hub regular's opening (port/BotStage) and the
 * conversation's new chains (an answer back, a gz's question on, "in what?"'s answer, a drop's answer). Those now take the
 * place of a line of their speaker's own too (countAsOwnLine), and at 0.3 H7 is 9.4 at 500 bots, 7.0 and 7.4 at 10x XP.)
 */
export const CHATTER_SCALE = 0.3;
/** a line due while the bot is busy waits at most this long (ticks), then the next one is drawn */
const HOLD_TICKS = 600;
/** a burst's lines come this many ticks apart (after the typing) */
const BURST_GAP: [number, number] = [8, 30];
/**
 * the spread of the quiet between bursts (log-normal σ: its gaps' CV about 1.8, where an exponential's is 1; σ 1, CV
 * 1.3, left the bots' lines all told at a CV of 1.24-1.31 once the answers, gz and events came between: C2 wants 1.3)
 */
const QUIET_SIGMA = 1.45;
/** the most lines a burst holds */
const BURST_MAX = 3;
/** an event line waits at most this long for a calm moment */
const EVENT_HOLD_TICKS = 120;
/** a level-up line at most this often (a milestone always may), and how long a level-up keeps the next one rare */
const LEVELUP_LINE_TICKS = 300;
const LEVELUP_DAMP_TICKS = 3000;
/**
 * a milestone this soon after its last level-up line is said less often (99 always may): at 10× XP a bot hit
 * one every few minutes, and level-up lines (2.5 a bot-hour), the gz they drew and the lines after them took the
 * bots to 12.4 lines an hour with a third of 10-minute windows quiet (the band: 4-10, 50-80 %)
 */
const MILESTONE_GAP_TICKS = 3000;
/**
 * a level-up line, an event's line, opens a burst of its own (a line or two after it) this often: every one did, and at
 * 10× XP, with events and level-ups every few minutes, the lines after them were a quarter more idle lines
 */
const LEVELUP_BURST_CHANCE = 0.25;
const EVENT_BURST_CHANCE = 0.5;
/** a newbie's first line comes this many ticks after it logs in (1-4 minutes) */
const NEWBIE_FIRST_LINE: [number, number] = [60, 240];
/** the same kind of event is talked about at most this often (a death, a rune drop: every time) */
const EVENT_REPEAT_TICKS = 2400;
const EVENT_ALWAYS = new Set(['death', 'wild-death', 'rune-drop']);
/** Lumbridge's respawn (274's death.rs2: 0_50_50_21_18, within 2) */
const RESPAWN: [number, number] = [3221, 3218];

/**
 * How likely an event makes the bot speak at once (times its chattiness, about 7 an hour is 1×); later lines due while
 * it is fresh are about it in any case. Frequent ones (a full pack, a normal tree) rarely.
 */
const EVENT_CHANCE: Readonly<Record<string, number>> = {
    death: 0.45,
    'wild-death': 0.55,
    'close-call': 0.3,
    'rune-drop': 0.8,
    'big-bones': 0.12,
    drop: 0.25,
    'full-pack': 0.03,
    'tree-fell': 0.03,
    'tree-taken': 0.15,
    'rock-stolen': 0.08,
    arrival: 0.06,
    login: 0.06,
    'out-of-arrows': 0.3,
    'out-of-runes': 0.3,
    unanswered: 0.05,
    // the realism work's phase 5a (texture): 0 until the track that fires the event sets its chance (Track F: ks,
    // ks-taken, rock-reply, misclick, lost, forgot-food, wolves; Track M: teleport, alch; Track E: random-event,
    // fail-teleported, axe-head, lamp, clue-scroll)
    // (Track F: the arguments' (argue below: a victim's "ks!", a rude victim's at 0.7; a stealer's answer to it, a
    // polite stealer's at 0.3 of that: about a quarter of the lines get one, R4's 10-40 %); a misclick's "oops" a quiet
    // majority; a careless fighter's "forgot my food lol" a quarter of the time it notices; the wolves on White Wolf
    // Mountain)
    ks: 0.4,
    'ks-taken': 0.35,
    'rock-reply': 0.35,
    misclick: 0.15,
    // (Track M: a wrong turn's look round, BotAction; 'lost' lines in data/lines2004-texture.json)
    lost: 0.1,
    'forgot-food': 0.25,
    wolves: 0.3,
    // (Track M: a real teleport spell's landing, port/BotTeleport; an alching stint's first cast, tasks/AlchTask)
    teleport: 0.12,
    alch: 0.15,
    // (Track E, random events: port/BotRandomEvents; the research's immediate chances: the fail teleport
    // most, said after it landed)
    'random-event': 0.35,
    'fail-teleported': 0.7,
    'axe-head': 0.5,
    lamp: 0.3,
    'clue-scroll': 0.5,
    // the realism work's phase 5b (set pieces): each track's events, in its own block (their lines count against the talk
    // budget: any event not in BURST_EVENTS)
    // (Track D: the director and groups: a bot near a clan walk's stop, a PK team's meeting, a newbie follow train, picked
    // by the piece (a few, now and then: port/BotClanWalk, port/BotPkTeam, port/BotTrains), says something of it at this
    // chance; budgeted, as every event's line but phases 2-4's)
    'clan-seen': 0.5,
    'pk-team-seen': 0.5,
    'train-seen': 0.6,
    // (Track P: parties, scams and lures: none; a party's calls, a scam caller's and the crowd's words are said by the
    // pieces themselves at their moment, each in place of the speaker's next line: port/BotPieceLines)
    // (Track A: the Duel Arena and the mod bot: none; the arena's lines and the mod's are their own, said at their moment
    // with kinds setpiece and mod, port/BotArena and port/BotModBot)
};
/**
 * the events whose lines come first when a line is due, most telling first (a login, an arrival, a full pack, a felled
 * tree and an unanswered question only get their line at once, now and then: they are too common to be the next thing
 * said)
 */
const EVENT_ORDER = ['wild-death', 'death', 'rune-drop', 'close-call', 'drop', 'big-bones', 'tree-taken', 'rock-stolen', 'out-of-arrows', 'out-of-runes'];

/** the 2004 hubs a bot "arrives" at (after 15 minutes or more away) */
const HUBS: readonly [string, number, number, number][] = [
    ['varrock_west', 3185, 3441, 10], ['varrock_square', 3212, 3428, 10], ['varrock_east', 3253, 3420, 8], ['falador_park', 2997, 3375, 12],
    ['falador_east', 3013, 3355, 8], ['falador_west', 2946, 3368, 8], ['lumbridge_courtyard', 3222, 3218, 8], ['draynor_bank', 3092, 3245, 8],
    ['edgeville_bank', 3093, 3491, 8], ['al_kharid_bank', 3269, 3167, 8], ['seers_bank', 2725, 3493, 8], ['catherby_bank', 2808, 3441, 8],
    ['ardougne_market', 2662, 3305, 12]
];
const ARRIVE_AWAY_TICKS = 1500;

const GATHERING = new Set(['Woodcut', 'Mine', 'Fish', 'Pick Flax', 'Thieve']);
const FIGHTING = new Set(['Combat', 'RangedMagic']);

interface EventNote {
    tick: number;
    level?: number;
    stat?: string;
    /** (phase 5a) what kind of it: a random event's ('genie', 'oldman-kebab' ...; port/BotLines' `kinds`) */
    kind?: string;
    /** (variety round 1, P3) a drop's item, as a line's {item} names it */
    item?: string;
    /** a line was said about this one */
    said?: boolean;
}

/**
 * (the realism work's phase 5a, Track F) a line of an argument due: the victim's about a steal ("ks!", "that was my
 * rock"), or the stealer's answer to it; its pool, whom it is about, the incident (its line's tick goes there)
 */
interface Argument {
    at: number;
    until: number;
    event: string;
    lines: readonly Line[];
    other: Player | null;
    incident: Incident;
    role: 'victim' | 'stealer';
}

interface Pending {
    at: number;
    until: number;
    what: 'event' | 'levelup';
    event?: string;
    stat?: string;
    level?: number;
    cb?: number | null;
}

interface ChatState {
    persona: Persona;
    /** the tick the next unprompted line is due, the lines left in this burst, since when a due line waits */
    due: number;
    burst: number;
    /** the due line follows another in its burst (it prefers a short one: "lol", "jk") */
    followUp: boolean;
    heldSince: number;
    pending: Pending | null;
    events: Map<string, EventNote>;
    /** the last tick each kind of event was talked about */
    eventSaid: Map<string, number>;
    lastLevelUpLine: number;
    lastLevelUp: number;
    lastQuestion: number;
    /** its last question still waits for an answer (with players near it when it asked) */
    unansweredDone: boolean;
    /** a newbie said one of its own lines (its first words are one: "how do i get to varrock", "can i have some gp") */
    newbieAsked: boolean;
    // what it saw last
    lastSeen: number;
    x: number;
    z: number;
    hp: number;
    lowSince: number;
    full: boolean;
    hub: string | null;
    hubLeft: Map<string, number>;
    inv: Set<number> | null;
    invTask: string;
    /** a ranger out of arrows, a mage out of runes (noted when it begins) */
    outOfAmmo: boolean;
    target: unknown;
    targetXp: number;
    phase: number;
    /** (phase 5a, Track F) an argument's line due (argue) */
    argue?: Argument | null;
    /** (variety round 1, P2) since when a due idle line waits for company (-1: none waits) */
    loneSince: number;
    /** (P2) its quiet was drawn alone, at the lone rate: the line due after it is said alone */
    quietAlone: boolean;
    /** (P2) a burst begun alone: the rest of it is said alone too */
    loneBurst: boolean;
    /**
     * (variety round 2, S2) its lines said elsewhere of its own accord (a thread's turn, a witness's word, a response,
     * banter: countAsOwnLine) not yet taken from its own: each due line skips one, until none is owed
     */
    debt: number;
}

const states = new WeakMap<Player, ChatState>();

function stateOf(bot: Player, now: number): ChatState {
    let st = states.get(bot);
    if (!st) {
        st = {
            persona: personaOf(bot.username, (bot.botPlanner as PlannerKey) ?? null),
            due: -1,
            burst: 0,
            followUp: false,
            heldSince: -1,
            pending: null,
            events: new Map(),
            eventSaid: new Map(),
            lastLevelUpLine: -MILESTONE_GAP_TICKS,
            lastLevelUp: -LEVELUP_DAMP_TICKS,
            lastQuestion: -1,
            unansweredDone: true,
            newbieAsked: false,
            lastSeen: -1,
            x: bot.x,
            z: bot.z,
            hp: bot.levels[PlayerStat.HITPOINTS],
            lowSince: -1,
            full: false,
            hub: null,
            hubLeft: new Map(),
            inv: null,
            invTask: '',
            outOfAmmo: false,
            target: null,
            targetXp: 0,
            phase: bot.slot & 7,
            loneSince: -1,
            quietAlone: false,
            loneBurst: false,
            debt: 0
        };
        states.set(bot, st);
        noteEvent(bot, 'login');
    }
    return st;
}

/**
 * the lines an hour this bot aims at (a newbie talks more: its persona's rate times four, within NEWBIE_LINES_PER_HOUR;
 * port, the realism work's phase 3: a slow leveller half that, port/BotNewbie.newbieLinesPerHour)
 */
function ratePerHour(bot: Player, st: ChatState): number {
    if (isNewbie(bot)) return newbieLinesPerHour(bot, st.persona.chattiness);
    return Math.max(0.2, st.persona.chattiness * CHATTER_SCALE);
}

/**
 * After a line: the next of its burst soon, or (the burst over) the next burst's size and a quiet, heavy-tailed around
 * a burst's share of the hour, so the lines an hour stay the persona's. A burst holds 1-3 lines: a bot with four lines
 * in a stretch has had two bursts and a quiet between (the humanlike report's C2).
 */
function afterLine(bot: Player, st: ChatState, now: number, startsBurst = false): void {
    st.heldSince = -1;
    const size = 1 + 4 * st.persona.burstiness;
    // (an event or a level-up line opens a burst of its own: a line or two may follow it)
    if (startsBurst) st.burst = burstSize(size) - 1;
    if (st.burst > 0) {
        st.burst--;
        st.followUp = true;
        st.due = now + BURST_GAP[0] + Math.floor(Math.random() * (BURST_GAP[1] - BURST_GAP[0]));
        return;
    }
    st.followUp = false;
    st.burst = burstSize(size) - 1;
    // (the quiet between bursts: heavy-tailed, as people's pauses are (Barabási 2005), a log-normal with the mean that
    // keeps the persona's lines an hour: a burst's lines are k(1 - q^max) on average, k its size before the cap)
    const lines = size * (1 - Math.pow(1 - 1 / size, BURST_MAX));
    // (variety round 1, P2: with company it talks a little more; alone, a fifth as much (LONE_RATE): one quiet drawn at
    // that rate, a heavy-tailed gap as any, where holding each due line and dropping most of them summed several quiets
    // into one gap and evened the bots' talk out, C2)
    const company = companyNear(bot);
    st.quietAlone = company === 0;
    const meanGap = (6000 * lines) / (ratePerHour(bot, st) * (company === 0 ? LONE_RATE : 1 + COMPANY_RATE * Math.min(company, COMPANY_MAX)));
    st.due = now + Math.max(30, Math.round(logNormal(meanGap * Math.exp(-QUIET_SIGMA * QUIET_SIGMA / 2), QUIET_SIGMA)));
}

// ── (the variety work, round 2, S2-6) quiet spells ───────────────────────────────────────────────────────────────

/**
 * a bot that has said nothing (but trade) for this long is in a quiet spell, grinding in silence: its level-up lines and
 * its everyday events' lines come less often then (QUIET_SPELL_LEVELUP, QUIET_SPELL_EVENT). Talk comes from the bots at
 * their keyboards: the quiet stay quiet (H6: the humanlike report's 10-minute windows without a line; C2: bursts)
 */
const QUIET_SPELL = 1000;
const QUIET_SPELL_LEVELUP = 0.5;
const QUIET_SPELL_EVENT = 0.6;
export function inQuietSpell(bot: Player, now: number = World.currentTick): boolean {
    return now - lastChatAt(bot) > QUIET_SPELL;
}

// ── (the variety work, round 1, P2) talk with company ────────────────────────────────────────────────────────────

/** alone (nobody within 15 tiles) a bot talks at this share of its rate ("ugh", "lol" to oneself) */
export const LONE_RATE = 0.2;
/**
 * a line due alone after a quiet drawn with company (its company left) waits this long for company (re-checked every
 * LONE_RECHECK ticks), then is dropped and a quiet drawn alone
 */
const LONE_HOLD = 300;
const LONE_RECHECK = 50;
/** with company, the persona's rate times 1 + COMPANY_RATE a player within 15 tiles, up to COMPANY_MAX of them */
export const COMPANY_RATE = 0.15;
const COMPANY_MAX = 4;
/**
 * a level-up line with nobody near is said this much as often (99 always): the spec's milestones, and the others too
 * (left at their chance, a lone bot's lines were its level-ups, as regular as its XP at 10x: C2 1.24-1.28)
 */
const LONE_LEVELUP = 0.35;
/** company: the players within this of it */
const COMPANY_DISTANCE = 15;

/** the other players within 15 tiles of the bot on its level (one loop over the players) */
function companyNear(bot: Player): number {
    let n = 0;
    for (const p of World.playerLoop.all()) {
        if (p !== bot && p.level === bot.level && Math.abs(p.x - bot.x) <= COMPANY_DISTANCE && Math.abs(p.z - bot.z) <= COMPANY_DISTANCE) n++;
    }
    return n;
}

/** an event's line would come next (sayDue's order): a death, a drop ... fresh and not said */
function eventDue(st: ChatState, now: number): boolean {
    for (const name of EVENT_ORDER) {
        const e = st.events.get(name);
        if (!e || e.said || now - e.tick > (EVENT_WINDOW[name] ?? 300)) continue;
        const said = st.eventSaid.get(name);
        if (!EVENT_ALWAYS.has(name) && said !== undefined && now - said < EVENT_REPEAT_TICKS) continue;
        return true;
    }
    return false;
}

/** a burst's lines: geometric, `mean` on average, at most BURST_MAX */
function burstSize(mean: number): number {
    const q = 1 - 1 / mean;
    let n = 1;
    while (n < BURST_MAX && Math.random() < q) n++;
    return n;
}

/** May it talk now? Not mid-fight, not with an interface open (bank, shop, trade), not trading, running, away or talking with a human. */
export function calm(bot: Player, now: number = World.currentTick): boolean {
    // (a newbie at the chickens talks on: 2004's newbies asked while they hit, and a newbie that fought on without a
    // gap said nothing for its whole newbie time; not when hurt)
    if (now < bot.preventLogoutUntil && !(isNewbie(bot) && bot.levels[PlayerStat.HITPOINTS] * 2 >= bot.baseLevels[PlayerStat.HITPOINTS])) return false;
    if (bot.modalMain !== -1 || tradeScreen(bot) !== null) return false;
    if (bot.botTradeTargetPid !== -1) return false;
    if (isFleeing(bot) || isAway(bot)) return false;
    // (nor while it types a reply or is in a practice with a bot: port/BotChat; variety round 2: or a topic thread,
    // port/BotThreads, which stays out of midTalk: a set piece may still recruit a bot from one)
    return !BotChat.inConversation(bot) && !BotChat.midTalk(bot) && !inThread(bot);
}

// ── events ───────────────────────────────────────────────────────────────────

/**
 * Something happened to the bot (a death, a drop, a full pack ...): its lines are true for a while (BotLines
 * EVENT_WINDOW), and the bot may speak of it at once (its persona). Exported for the other modules (the habits).
 */
export function noteEvent(bot: Player, name: string, data: { level?: number; stat?: string; kind?: string; item?: string } = {}): void {
    const now = World.currentTick;
    const st = states.get(bot);
    if (!st) return;
    st.events.set(name, { tick: now, ...data });
    if (name === 'levelup') return;
    const said = st.eventSaid.get(name);
    if (!EVENT_ALWAYS.has(name) && said !== undefined && now - said < EVENT_REPEAT_TICKS) return;
    // (variety round 2, S2-6: in a quiet spell, an everyday event's line less often; a death or a rune drop as ever)
    const spell = !EVENT_ALWAYS.has(name) && inQuietSpell(bot, now) ? QUIET_SPELL_EVENT : 1;
    const chance = Math.min(0.95, (EVENT_CHANCE[name] ?? 0) * Math.max(0.3, Math.min(2, st.persona.chattiness / 7)) * spell);
    if (Math.random() >= chance) return;
    if (st.pending && st.pending.what === 'levelup') return;
    // (variety round 2, S2-2: an everyday event's word waits when the bot is over its share of a busy place's talk, a
    // death or a rune drop as ever: port/BotVoice)
    if (!EVENT_ALWAYS.has(name) && !voiceFree(bot, now)) return;
    st.pending = { at: now + reactionDelay(st), until: now + EVENT_HOLD_TICKS, what: 'event', event: name };
}

/** a person's moment before typing about it (1-3 s) */
function reactionDelay(st: ChatState): number {
    return 2 + Math.floor(Math.random() * 4 * st.persona.reaction);
}

/** O(1) a tick: a death (its turn was skipped while dead, and it is back at the respawn), a tree or rock it lost */
function observe(bot: Player, st: ChatState, now: number): void {
    if (st.lastSeen >= 0 && now - st.lastSeen > 3 && bot.level === 0 && Math.abs(bot.x - RESPAWN[0]) <= 3 && Math.abs(bot.z - RESPAWN[1]) <= 3 && Math.max(Math.abs(st.x - RESPAWN[0]), Math.abs(st.z - RESPAWN[1])) > 6) {
        const wild = wildernessLevelAt(st.x, st.z) > 0;
        noteEvent(bot, wild ? 'wild-death' : 'death');
        if (wild) st.events.set('death', { tick: now });
        st.lowSince = -1;
        // (the realism work's phase 5a, Track F: its carelessness halves for the session, a second death within 30
        // minutes ends its plan: port/BotFumble; one on White Wolf Mountain is the wolves' doing: "stupid wolves")
        noteDeath(bot);
        if (onWhiteWolfMountain(st.x, st.z)) noteEvent(bot, 'wolves');
    }
    st.lastSeen = now;
    st.x = bot.x;
    st.z = bot.z;
    const target = bot.target;
    if (target !== st.target) targetChanged(bot, st, target);
    if (((now + st.phase) & 7) === 0) poll(bot, st, now);
}

/** its interaction target changed: a tree or rock it worked on is gone (felled or mined out: by it, or by another) */
function targetChanged(bot: Player, st: ChatState, target: unknown): void {
    const prev = st.target as { isChanged?: () => boolean } | null;
    const task = BotManager.botFor(bot)?.currentTask ?? null;
    const kind = taskKind(task?.name);
    const stat = kind === 'Woodcut' ? PlayerStat.WOODCUTTING : kind === 'Mine' ? PlayerStat.MINING : -1;
    if (stat !== -1 && prev && typeof prev.isChanged === 'function' && prev.isChanged()) {
        const itsOwn = bot.stats[stat] > st.targetXp;
        if (kind === 'Woodcut') {
            if (!itsOwn) noteEvent(bot, 'tree-taken');
            else {
                let step = null;
                try {
                    step = task?.activityStep() ?? null;
                } catch {
                    step = null;
                }
                // (a normal tree falls at every log: only the bigger ones are an event)
                if (!stepTargets('Woodcut', step, null).includes('tree')) noteEvent(bot, 'tree-fell');
            }
        } else if (!itsOwn) rockLost(bot, prev);
    }
    st.target = target;
    st.targetXp = stat === -1 ? 0 : bot.stats[stat];
}

/**
 * (the realism work's phase 5a, Track F) a rock it worked was mined out by someone else: the 'rock-stolen' event, or,
 * when a rude miner took it from the bot on purpose (port/BotRude), the victim's side of the argument (named, half the
 * time); nothing from the thief itself, whose rock the victim emptied first
 */
function rockLost(bot: Player, rock: object): void {
    if (stoleIt(bot, rock)) return;
    const open = incidentPlayers(rock);
    if (open && open.victim === bot && open.incident.deliberate && open.incident.kind === 'rock') {
        if (open.incident.noticed < 0) open.incident.noticed = World.currentTick;
        if (claimArgument(open.incident)) argue(bot, open.incident, 'victim', open.stealer, ROCK_VICTIM_CHANCE);
    } else noteEvent(bot, 'rock-stolen');
}

// ── the arguments (the realism work's phase 5a, Track F: kill- and rock-stealing) ────────────────────────────────

/** a rock steal's victim speaks of it this often (the 'rock-stolen' event's own 0.08 for one nobody meant) */
const ROCK_VICTIM_CHANCE = 0.5;
/** a victim's line waits at most this long for a calm moment (24 s: the humanlike report's R4 counts those within 15) */
const VICTIM_HOLD_TICKS = 40;
/** the stealer's answer waits this long (it is mid-fight, its kill first: 2 minutes) */
const STEALER_HOLD_TICKS = 200;
/** a polite stealer answers at this share of a rude one's chance ("sry", "my bad") */
const POLITE_ANSWER = 0.3;
/** a rude victim says "ks!" at this chance (the event's own for the rest) */
const RUDE_VICTIM_CHANCE = 0.7;

/** the 2004 lines of an event (the texture file's groups and lines2004's), by the answer's manner when it has one */
const argueLines = new Map<string, readonly Line[]>();
function linesFor(event: string, manner: 'rude' | 'polite' | 'any'): readonly Line[] {
    const key = `${event}|${manner}`;
    let lines = argueLines.get(key);
    if (!lines) {
        lines = NEW_LINES.filter(l => l.tag.event === event && (manner === 'any' || (manner === 'rude') === (l.tag.who?.includes('rude') ?? false)));
        argueLines.set(key, lines);
    }
    return lines;
}

/** the event of each side of an argument, by the steal's kind */
const ARGUE_EVENT: Readonly<Record<'ks' | 'rock', { victim: string; stealer: string }>> = { ks: { victim: 'ks', stealer: 'ks-taken' }, rock: { victim: 'rock-stolen', stealer: 'rock-reply' } };

/**
 * One side of an argument about `incident` (port/BotRude): the victim's line ("ks!", "nub stole my cow", "that was my
 * rock"), or the stealer's answer to it (a rude one's "first come first serve", a polite one's "sry"), now and then by
 * the persona (`chance` overrides the event's). Said when the bot is calm (never mid-fight), within its hold; it counts
 * as one of the bot's lines (its next idle line after a quiet: the talk budget). An argument is two lines: the victim's,
 * then the stealer's answer (never another). A {name} line names the other side only.
 */
export function argue(bot: Player, incident: Incident, role: 'victim' | 'stealer', other: Player | null, chance?: number): void {
    const st = states.get(bot);
    if (!st || bot.slot === -1) return;
    const now = World.currentTick;
    const event = ARGUE_EVENT[incident.kind][role];
    const rude = rudeTalker(bot);
    let p: number;
    if (chance !== undefined) p = chance;
    else if (role === 'victim') p = rude ? RUDE_VICTIM_CHANCE : (EVENT_CHANCE[event] ?? 0) * Math.max(0.3, Math.min(2, st.persona.chattiness / 7));
    else p = (EVENT_CHANCE[event] ?? 0) * (rude ? 1 : POLITE_ANSWER);
    if (argueChanceForTest !== null) p = argueChanceForTest;
    if (Math.random() >= Math.min(argueChanceForTest ?? 0.95, p)) return;
    const lines = role === 'stealer' ? linesFor(event, rude ? 'rude' : 'polite') : linesFor(event, 'any');
    if (lines.length === 0) return;
    st.argue = { at: now + reactionDelay(st) + (role === 'stealer' ? 2 : 0), until: now + (role === 'victim' ? VICTIM_HOLD_TICKS : STEALER_HOLD_TICKS), event, lines, other, incident, role };
}

/** Tests only (test/texture.test.mjs): every argument's line at this chance (null: the personas'). Never set by the game. */
let argueChanceForTest: number | null = null;
export function setArgueChanceForTest(chance: number | null): void {
    argueChanceForTest = chance;
}

/** the argument's line, if it is due and the bot calm: true when it took the tick (said or dropped) */
function tickArgument(bot: Player, st: ChatState, now: number): boolean {
    const a = st.argue;
    if (!a) return false;
    if (now > a.until) {
        st.argue = null;
        return false;
    }
    if (now < a.at || !betweenFights(bot, now)) return false;
    st.argue = null;
    const ctx = contextOf(bot, new Map([[a.event, { tick: now }]]), st.lastQuestion);
    // (a {name} line names the other side, when it is near: never a bystander)
    const near = a.other ? ctx.near.filter(n => n.player === a.other) : [];
    const picked = pickLine({ ...ctx, near }, { event: a.event }, Math.random, a.lines);
    if (!picked) return false;
    const styled = styleLine(picked.text, st.persona);
    speak(bot, styled.line, 'event', 'event', a.other, styled.correction, now);
    if (a.role === 'victim') a.incident.victimLine = now;
    else a.incident.stealerLine = now;
    budgetLine(bot, st, now);
    // the stealer's answer, now and then (a bot only)
    if (a.role === 'victim' && a.other && a.other.is_bot && a.other.slot !== -1) argue(a.other, a.incident, 'stealer', bot);
    return true;
}

/**
 * (phase 5a) between fights: not attacking anyone (no NPC or player its target), not hit in the last 4 ticks, and as
 * calm otherwise (no interface, no trade, not running or away, not talking with a human). An argument's line comes then
 * ("lol first come first serve" after its kill): calm's combat lock (16 ticks after the last hit) holds a fighter's every
 * line while it fights on, and a stealer at a crowd fights on for minutes
 */
function betweenFights(bot: Player, now: number): boolean {
    const t = bot.target as { nid?: number; username?: string } | null;
    if (t && (t.nid !== undefined || t.username !== undefined)) return false;
    if (now < bot.preventLogoutUntil - 12) return false;
    if (bot.modalMain !== -1 || tradeScreen(bot) !== null || bot.botTradeTargetPid !== -1) return false;
    if (isFleeing(bot) || isAway(bot)) return false;
    return !BotChat.inConversation(bot) && !BotChat.midTalk(bot) && !inThread(bot);
}

/**
 * (phase 5a) a line said about one of the new events takes the place of the persona's next line: no burst after it, and
 * the line due next comes a quiet after it would have come (the talk budget: its lines an hour stay its persona's; H7 at
 * 10x XP must not rise). At first the next line kept its time when that was the later: the event's line came on top of
 * the persona's (at 1x XP H7 rose about a line a bot-hour and the quiet windows, H6, fell under their band).
 */
function budgetLine(bot: Player, st: ChatState, now: number): void {
    st.burst = 0;
    afterLine(bot, st, Math.max(now, st.due));
}

/** (variety round 2, S2) the most own lines a bot may owe (a long thread's turns cancel at most this many of its own) */
const DEBT_MAX = 6;
/**
 * (variety round 2, Track S2) a line of its own accord said elsewhere (a thread's turn, a witness's word, a response, a
 * clique's banter): it takes the place of the bot's next due line, exactly (that one is skipped: `debt`), so its lines an
 * hour stay its persona's however much of them is conversation (H7). budgetLine's push of the next due line from its time
 * leaked: a line held while the bot fought or stood alone was drawn again from the moment it gave up.
 */
export function countAsOwnLine(bot: Player): void {
    const st = states.get(bot);
    if (st) st.debt = Math.min(DEBT_MAX, st.debt + 1);
}

/**
 * (phase 5a) a line of the new texture said elsewhere (a spell's own line, port/BotAlch; a neighbour's word about a random
 * event, port/BotRandomEvents): budgetLine's rule, the place of the persona's next line
 */
export function countAsBudgetedLine(bot: Player): void {
    const st = states.get(bot);
    if (st) budgetLine(bot, st, World.currentTick);
}

/**
 * (phases 2-4) the events whose lines may open a burst of their own (a death, a drop, a full pack, a login). Every other
 * event's line counts against the talk budget (budgetLine), whatever its name: phase 5a's (Track F's misclicks and
 * the rest, Track M's landings and alching, Track E's random events) and 5b's set pieces (the spec: H7 at 10x XP must
 * not rise). It was a list of the budgeted ones, which every new track had to edit.
 */
const BURST_EVENTS = new Set(['death', 'wild-death', 'close-call', 'rune-drop', 'big-bones', 'drop', 'full-pack', 'tree-fell', 'tree-taken', 'rock-stolen', 'arrival', 'login', 'out-of-arrows', 'out-of-runes', 'unanswered', 'hurt']);

/** White Wolf Mountain (the multi-combat mapsquare 0_44_54 and the paths up its sides: the wolves' ground) */
export function onWhiteWolfMountain(x: number, z: number): boolean {
    return x >= 2816 && x <= 2879 && z >= 3436 && z <= 3522;
}

/** every 8 ticks: Hitpoints (a near death, a thief's stun), a full pack, a drop, a hub reached, out of ammo, an unanswered question */
function poll(bot: Player, st: ChatState, now: number): void {
    const task = BotManager.botFor(bot)?.currentTask ?? null;
    const kind = taskKind(task?.name);
    const hp = bot.levels[PlayerStat.HITPOINTS];
    const base = bot.baseLevels[PlayerStat.HITPOINTS] || 10;
    // (a thief's stun: once a drop in Hitpoints, not at every poll while it lasts)
    if (hp < st.hp && kind === 'Thieve') noteEvent(bot, 'hurt');
    if (hp > 0 && hp <= base * 0.25) {
        if (st.lowSince < 0) st.lowSince = now;
    } else if (st.lowSince >= 0 && hp >= base * 0.6) {
        // (port, the realism work's phase 5b, Track A: not a duellist's: 274's duel end heals both, the loser too; a duel's
        // lines are its own, port/BotArena: "omg 2 hp lol" after a close win)
        if (now - st.lowSince < 600 && eventRoleOf(bot)?.role !== 'duellist') noteEvent(bot, 'close-call');
        st.lowSince = -1;
    }
    st.hp = hp;

    const inv = bot.getInventory(InvType.INV);
    const full = inv !== null && inv.freeSlotCount === 0;
    if (full && !st.full && GATHERING.has(kind)) noteEvent(bot, 'full-pack');
    st.full = full;

    // a fighter's pack gains an item away from a bank: a drop it picked up
    if (inv && FIGHTING.has(kind) && !nearBank(bot.x, bot.z, bot.level, 10)) {
        const ids = new Set<number>();
        for (let i = 0; i < inv.capacity; i++) {
            const item = inv.get(i);
            if (item) ids.add(item.id);
        }
        if (st.inv && st.invTask === kind) {
            for (const id of ids) {
                if (st.inv.has(id)) continue;
                const obj = ObjType.get(id);
                const name = (obj?.debugname ?? '').toLowerCase();
                // (variety round 1, P3: the item, as a line's {item} names it: "omg rune med")
                const item = itemSay(obj?.name ?? '') ?? undefined;
                if (name === 'big_bones') noteEvent(bot, 'big-bones', { item });
                else if (name.startsWith('rune_')) noteEvent(bot, 'rune-drop', { item });
                // (phase 5a, Track E: a clue scroll, its line at pickup; members' drops: trail_clue_drop.rs2)
                else if (name.startsWith('trail_clue_') && !name.endsWith('_casket') && !name.includes('puzzlebox')) noteEvent(bot, 'clue-scroll', { kind: 'got' });
                else if (name !== 'coins' && (obj?.cost ?? 0) >= 300) noteEvent(bot, 'drop', { item });
            }
        }
        st.inv = ids;
        st.invTask = kind;
    } else {
        st.inv = null;
    }

    // a hub it reached after a while away
    let hub: string | null = null;
    if (bot.level === 0) {
        for (const [key, x, z, r] of HUBS) {
            if (Math.max(Math.abs(bot.x - x), Math.abs(bot.z - z)) <= r) {
                hub = key;
                break;
            }
        }
    }
    if (hub !== st.hub) {
        if (st.hub !== null) st.hubLeft.set(st.hub, now);
        if (hub !== null && st.lastSeen > 0 && now - (st.hubLeft.get(hub) ?? -ARRIVE_AWAY_TICKS) >= ARRIVE_AWAY_TICKS && now - (st.events.get('login')?.tick ?? -1e9) > 100) noteEvent(bot, 'arrival');
        st.hub = hub;
    }

    // ranging without arrows, casting without runes (noted when it begins)
    let out: 'out-of-arrows' | 'out-of-runes' | null = null;
    if (kind === 'RangedMagic') {
        const worn = bot.getInventory(InvType.WORN);
        const weapon = (ObjType.get(worn?.get(3)?.id ?? -1)?.debugname ?? '').toLowerCase();
        if (weapon.includes('bow') && !worn?.get(13)) out = 'out-of-arrows';
        else if (weapon.includes('staff')) {
            let runes = false;
            for (let i = 0; inv && i < inv.capacity && !runes; i++) {
                const item = inv.get(i);
                if (item && (ObjType.get(item.id)?.debugname ?? '').endsWith('rune')) runes = true;
            }
            if (!runes) out = 'out-of-runes';
        }
    }
    if (out !== null && !st.outOfAmmo) noteEvent(bot, out);
    st.outOfAmmo = out !== null;

    // its question went unanswered (nobody near said anything since)
    if (!st.unansweredDone && st.lastQuestion >= 0 && now - st.lastQuestion >= 100) {
        st.unansweredDone = true;
        if (!heardSince(bot, st.lastQuestion, now)) noteEvent(bot, 'unanswered');
    }
}

/** another bot said something near it since `tick` (port/BotSpoke: the newest line near it, not its own) */
function heardSince(bot: Player, tick: number, now: number): boolean {
    const s = lastHeard(bot.x, bot.z, bot.level, now, now - tick - 1, 15);
    return s !== null && s.bot !== bot && s.tick > tick;
}

// ── the tick ─────────────────────────────────────────────────────────────────

/**
 * A bot's chatter, every tick of its turn (BotPlayer.tick, where upstream rolled IDLE_LINE_CHANCE): it notices what
 * happens to it, says a waiting event or level-up line when it is calm, and an unprompted line when one is due.
 */
export function tickChatter(bot: Player): void {
    const now = World.currentTick;
    const st = stateOf(bot, now);
    observe(bot, st, now);
    if (st.due < 0) {
        afterLine(bot, st, now);
        // (a newbie, the chattiest of 2004's players, starts asking within its first few minutes)
        if (isNewbie(bot)) st.due = Math.min(st.due, now + NEWBIE_FIRST_LINE[0] + Math.floor(Math.random() * (NEWBIE_FIRST_LINE[1] - NEWBIE_FIRST_LINE[0])));
    }

    // (the realism work's phase 5a, Track F: an argument's line first: "ks!", the stealer's answer)
    if (tickArgument(bot, st, now)) return;

    if (st.pending) {
        if (now > st.pending.until) st.pending = null;
        else if (now >= st.pending.at && calm(bot, now)) {
            const p = st.pending;
            st.pending = null;
            if (p.what === 'levelup') sayLevelUp(bot, st, p, now);
            else sayEvent(bot, st, p.event!, now);
        }
        return;
    }

    if (now < st.due) return;
    if (!calm(bot, now)) {
        if (st.heldSince < 0) st.heldSince = now;
        else if (now - st.heldSince > HOLD_TICKS) {
            st.burst = 0;
            afterLine(bot, st, now);
        }
        return;
    }
    // (variety round 1, P2: alone, the line its lone quiet led to is said (the lone rate, afterLine) and its burst with it;
    // a line due alone after a quiet drawn with company (its company left) waits for company and is dropped; an event's is
    // said)
    if (!st.followUp) st.loneBurst = false;
    if (!eventDue(st, now) && !st.loneBurst && companyNear(bot) === 0) {
        if (!st.quietAlone) {
            if (st.loneSince < 0) st.loneSince = now;
            if (now - st.loneSince >= LONE_HOLD) {
                st.loneSince = -1;
                talk.loneDropped++;
                st.burst = 0;
                afterLine(bot, st, now);
            } else st.due = now + LONE_RECHECK;
            return;
        }
        st.loneBurst = true;
    }
    st.loneSince = -1;
    // (variety round 2, S2: a line it said elsewhere of its own accord, a thread's turn, a witness's word, takes this
    // one's place: silence, and the next quiet)
    if (st.debt > 0 && !eventDue(st, now)) {
        st.debt--;
        talk.owedSkipped++;
        st.burst = 0;
        afterLine(bot, st, now);
        return;
    }
    // at a trade bank's stall a line waits for the bank's turn, as an advert does (its talk budget, port/BotTradeSpots)
    const stall = stallOf(bot);
    if (stall && !takeAdvertTurn(stall.bank, now)) {
        st.due = now + 5;
        return;
    }
    if (!sayDue(bot, st, now)) st.burst = 0;
    afterLine(bot, st, now);
}

/** the due line: about a fresh event first, a newbie's own, else one that fits (or nothing: silence) */
function sayDue(bot: Player, st: ChatState, now: number): boolean {
    const ctx = contextFor(bot, st);
    for (const name of EVENT_ORDER) {
        const e = st.events.get(name);
        if (!e || e.said || now - e.tick > (EVENT_WINDOW[name] ?? 300)) continue;
        const said = st.eventSaid.get(name);
        if (!EVENT_ALWAYS.has(name) && said !== undefined && now - said < EVENT_REPEAT_TICKS) continue;
        // (variety round 2, S2-2: over its share of a busy place's talk, an everyday event's line waits: port/BotVoice)
        if (!EVENT_ALWAYS.has(name) && !voiceFree(bot, now)) continue;
        const picked = pickLine(ctx, { event: name });
        if (picked) {
            e.said = true;
            st.eventSaid.set(name, now);
            return say(bot, st, ctx, picked, now);
        }
    }
    // (variety round 2, S2-2: at a busy place, a bot over its share of the talk in the last hour says nothing this time,
    // a newbie's questions too once it asked its first: port/BotVoice)
    if (st.newbieAsked && !voiceFree(bot, now)) return false;
    // (a newbie's first words are its own question or beg, then 60 % of its lines: with the share alone a newcomer of a
    // few minutes could say only an idle line, "Ra ra rasputin", and never ask)
    if (ctx.newbie && (!st.newbieAsked || Math.random() < NEWBIE_OWN_SHARE) && sayNewbieLine(bot, st, ctx, now)) {
        st.newbieAsked = true;
        return true;
    }
    if (!voiceFree(bot, now)) return false;
    // (variety round 2, S2-1: now and then the line due opens a thread with a bot near it: port/BotThreads)
    // (in a crowd less often: a bank of 30 at 500 online is no more talk with each than a spot of 4)
    const crowdShare = Math.min(1, THREAD_CROWD / Math.max(1, ctx.near.length));
    if (!ctx.newbie && !st.followUp && Math.random() < THREAD_SHARE * (0.5 + st.persona.sociability) * crowdShare && startThread(bot, 'chatter')) {
        talk.threads++;
        return true;
    }
    const picked = pickLine(ctx, 'idle', Math.random, undefined, st.followUp);
    return picked !== null && say(bot, st, ctx, picked, now);
}

/**
 * (variety round 2, S2-1) the share of a bot's due lines (a burst's first) that open a thread when a free bot is near:
 * this times 0.5 + its sociability (half to all of them; most then find no partner free within 12 tiles)
 */
export const THREAD_SHARE = 1;
/** (variety round 2, S2-1) with more players than this within 15 tiles, a due line opens a thread the fewer, by their number */
export const THREAD_CROWD = 3;

function sayEvent(bot: Player, st: ChatState, name: string, now: number): void {
    const e = st.events.get(name);
    if (!e || e.said) return;
    const ctx = contextFor(bot, st);
    const picked = pickLine(ctx, { event: name });
    if (!picked) return;
    e.said = true;
    st.eventSaid.set(name, now);
    say(bot, st, ctx, picked, now);
    // (phase 5a: a misclick's "oops", a lost way, forgotten food, the wolves, a landing, a random event: one of its lines,
    // no burst)
    if (!BURST_EVENTS.has(name)) budgetLine(bot, st, now);
    else afterLine(bot, st, now, Math.random() < EVENT_BURST_CHANCE);
}

const EVENT_CATEGORIES = new Set(['death', 'close-call', 'drop-claim', 'level-claim', 'event', 'greeting']);

/** says a picked line (a new line in the persona's style), notes it, and lets the bots near answer a question or a greeting */
function say(bot: Player, st: ChatState, ctx: LineContext, picked: Picked, now: number): boolean {
    const tag = picked.line.tag;
    let text = picked.text;
    let correction: string | null = null;
    if (picked.line.source === '2004') ({ line: text, correction } = styleLine(text, st.persona));
    const question = tag.c === 'question' || tag.c === 'newbie-question';
    const kind: LineKind = ctx.newbie && question ? 'newbie' : tag.c === 'trade' ? 'trade' : EVENT_CATEGORIES.has(tag.c) || tag.event ? 'event' : 'idle';
    const spoke: SpokeKind = kind === 'newbie' ? 'newbie' : question ? 'question' : kind === 'event' ? 'event' : 'idle';
    // (variety round 1: the line as picked for the registry (SAY-14), its class for the responses near it (SAY-6), its look (P10))
    const cls = heardClassOf(tag, picked.text);
    speak(bot, text, kind, spoke, picked.to?.player ?? null, correction, now, { raw: picked.text, template: picked.template, cls, style: lineStyle(bot, picked) });
    noteTalk(bot, picked, kind, cls, ctx, now);
    // (variety round 1, S6: a "dance!" comes with a dance; an everyday one since 2026-10-19, port/BotEmote)
    if (tag.emote && (EMOTES as readonly string[]).includes(tag.emote)) everydayEmote(bot, tag.emote as Emote, true);
    // (a line about an event, however it was picked, uses the event up: an idle pick of a fresh arrival's line left the
    // event to be said again, "Omg so many ppl" then "Wow its busy" 36 s later, as hang-outs bring bots to the hubs)
    // (variety round 1, SAY-5: its category's event too, a death line's 'death', which stayed fresh for 30 minutes and gave
    // a second death line ("Pked again" then "I died lol"); a death's line, plain or the Wilderness', uses up both)
    const ev = lineEventOf(tag);
    if (ev && ev !== 'levelup') {
        st.eventSaid.set(ev, now);
        st.events.delete(ev);
        if (ev === 'death' || ev === 'wild-death') {
            for (const d of ['death', 'wild-death']) {
                st.eventSaid.set(d, now);
                st.events.delete(d);
            }
        }
    }
    if (question) {
        st.lastQuestion = now;
        st.unansweredDone = !ctx.near.some(n => n.isBot);
    }
    // (not a line to a human it names: a bot near answered "Greetings, sim human! Looking for a quest?" with "Hey!")
    const toHuman = picked.to !== null && !picked.to.isBot;
    if ((question || tag.c === 'greeting') && !toHuman && ctx.near.some(n => n.isBot)) BotChat.onBotLine(bot, text, kind);
    // (variety round 2, S2-3: a drop announced: a bot near may answer it, "lucky", "what did u get"; S2-6: a statement, a
    // complaint, a mishap now and then a response: port/BotWitness)
    if (cls === 'brag' && kind === 'event' && ctx.near.some(n => n.isBot)) dropBrag(bot, picked.text, ctx.slots?.item ?? null);
    else if ((kind === 'idle' || kind === 'event') && ctx.near.some(n => n.isBot)) respondTo(bot, cls);
    return true;
}

/** a newbie's own line (port/BotNewbie): a question to anyone, or now and then a beg to a player near it */
function sayNewbieLine(bot: Player, st: ChatState, ctx: LineContext, now: number): boolean {
    const beg = ctx.near.length > 0 && Math.random() < NEWBIE_BEG_SHARE;
    const pool = beg ? NEWBIE_BEGS : NEWBIE_QUESTIONS;
    for (let attempt = 0; attempt < 4; attempt++) {
        let text = pool[Math.floor(Math.random() * pool.length)];
        let to: Player | null = null;
        if (text.includes('{name}')) {
            const n = ctx.near[Math.floor(Math.random() * ctx.near.length)];
            to = n.player;
            text = text.replaceAll('{name}', n.display);
        }
        if (!isFresh(bot.username, text, bot.x, bot.z, bot.level, now)) continue;
        const styled = styleLine(text, st.persona);
        // (variety round 1, SAY-7: a newbie's statement, "im new lol", is no question: nobody answers it as one, though a
        // bot near may welcome it: BotChat.onBotLine)
        const asks = !beg && isQuestionText(text);
        speak(bot, styled.line, 'newbie', 'newbie', to, styled.correction, now, { raw: text, cls: asks ? 'question' : beg ? 'newbie' : heardClassOf(null, text) === 'laugh' ? 'laugh' : 'newbie' });
        if (!beg) {
            if (asks) {
                st.lastQuestion = now;
                st.unansweredDone = !ctx.near.some(n => n.isBot);
            }
            if (ctx.near.some(n => n.isBot) && (to === null || to.is_bot)) BotChat.onBotLine(bot, styled.line, 'newbie');
        }
        return true;
    }
    return false;
}

/**
 * botSay with its kind, the registry, port/BotSpoke; a corrected typo's "*word" a moment later. (Variety round 1: `raw`
 * the line as picked, before its style, and a slot line's `template`: the registry's keys (SAY-14, P3); `cls` its class
 * for the responses near it (SAY-6); `style` its colour and effect (P10).)
 */
function speak(bot: Player, text: string, kind: LineKind, spoke: SpokeKind, to: Player | null, correction: string | null, now: number, opts: { raw?: string; template?: string; cls?: HeardClass; style?: ChatStyle } = {}): void {
    botSay(bot, text, opts.style, kind, to);
    noteSaid(bot, opts.raw ?? text, now, opts.template);
    noteSpoke(bot, spoke, now, to, opts.cls);
    if (correction !== null) {
        const delay = 2 + Math.floor(Math.random() * 3);
        scheduleInTicks(delay, () => {
            if (bot.slot !== -1 && bot.is_bot && !isAway(bot)) botSay(bot, correction, undefined, kind, to);
        });
    }
}

// ── (the variety work, round 1) the context's clan, a line's look, the talk's counts ─────────────────────────────

/** the clan names a levelling clique recruits by (lines2004-variety.json "clans": 2004's, from the clique's names) */
const CLAN_NAMES: readonly string[] = (lines2004VarietyJson as unknown as { clans?: string[] }).clans ?? [];
/** a clique's cape colour (port/BotLooks' capes: red, black, blue, yellow, green, purple, orange) as a chat colour */
const CLAN_CHAT_COLOUR = [1, 5, 3, 0, 2, 4, 6];

/** (P3) its clique's clan name, or null (no levelling clique) */
export function clanNameOf(name: string): string | null {
    const clique = cliqueInfoOf(name);
    if (!clique || clique.kind !== 'levelling' || CLAN_NAMES.length === 0) return null;
    return CLAN_NAMES[hashString(`clan-name#${clique.names.join(',')}`) % CLAN_NAMES.length];
}

/** the line context of the chatter (port/BotLines contextOf) with its clan's name for a {clan} line */
function contextFor(bot: Player, st: ChatState): LineContext {
    const ctx = contextOf(bot, st.events, st.lastQuestion);
    const clan = clanNameOf(bot.username);
    if (clan !== null) ctx.slots = { ...(ctx.slots ?? {}), clan };
    return ctx;
}

/** (P10) a clan's recruiting call ("{clan} recruiting lvl 40+ pm me", "join {clan}"): an advert, not talk */
const RECRUITING = /recruit|\bjoin\b|members|needs|pm me|add me/;

/**
 * (P10) a line's look: a clan's recruiting call in its capes' colour; undefined (plain yellow) for the rest, the clan's
 * other calls too (2004's players dressed up their adverts, not their talk)
 */
function lineStyle(bot: Player, picked: Picked): ChatStyle | undefined {
    const tag = picked.line.tag;
    if (!(picked.line.slots?.includes('clan') || tag.who?.includes('clan')) || !RECRUITING.test(picked.template ?? picked.text)) return undefined;
    const colour = cliqueColourOf(bot.username);
    return colour === null ? undefined : { colour: CLAN_CHAT_COLOUR[colour % CLAN_CHAT_COLOUR.length], effect: hashString(`clan-effect#${cliqueInfoOf(bot.username)?.names.join(',') ?? ''}`) % 2 };
}

/** (the humanlike runner: W3, W6) the chatter's counts: idle and event lines said, those about the task, target, place or destination; the responses said and what they followed */
const talk = {
    /** (variety round 2, S2-1) due lines that opened a thread; due lines skipped for lines said elsewhere (countAsOwnLine) */
    threads: 0,
    owedSkipped: 0,
    said: { idle: 0, event: 0 },
    specific: { idle: 0, event: 0 },
    slots: 0,
    loneDropped: 0,
    responses: [] as { t: number; name: string; text: string; cls: HeardClass | null; after: string[] | null }[]
};
const RESPONSES_KEPT = 4000;

function noteTalk(bot: Player, picked: Picked, kind: LineKind, _cls: HeardClass, ctx: LineContext, now: number): void {
    if (kind !== 'idle' && kind !== 'event') return;
    talk.said[kind]++;
    if (isSpecificLine(picked.line)) talk.specific[kind]++;
    if (picked.line.slots) talk.slots++;
    if (picked.line.tag.c === 'response' && talk.responses.length < RESPONSES_KEPT) talk.responses.push({ t: now, name: bot.username, text: picked.text, cls: ctx.heard.cls ?? null, after: picked.line.tag.after ?? null });
}

/** (variety round 2, S2-6: port/BotWitness's responses to a line near) a response said, for W3's count of what it followed */
export function noteResponse(bot: Player, text: string, cls: HeardClass | null, after: string[] | null): void {
    if (talk.responses.length < RESPONSES_KEPT) talk.responses.push({ t: World.currentTick, name: bot.username, text, cls, after });
}

/** (the humanlike runner) the chatter's counts so far (a copy) */
export function talkStats(): { said: { idle: number; event: number }; specific: { idle: number; event: number }; slots: number; loneDropped: number; threads: number; owedSkipped: number; responses: { t: number; name: string; text: string; cls: HeardClass | null; after: string[] | null }[] } {
    return { said: { ...talk.said }, specific: { ...talk.specific }, slots: talk.slots, loneDropped: talk.loneDropped, threads: talk.threads, owedSkipped: talk.owedSkipped, responses: [...talk.responses] };
}

// ── level-ups ────────────────────────────────────────────────────────────────

/**
 * Its base level in `stat` rose to `level` (BotPlayer.onLevelUp). A 2004 player announced the milestones ("40 att!",
 * 43 prayer, 60 wc) and now and then another level; one levelling every minute or two (a high XP rate) mostly the
 * milestones. The line comes after a moment's typing, when the bot is calm (not mid-fight), in a 2004 form
 * (BotLines.levelUpLine) and the persona's style; the bots near may "gz" it (BotChat.onBotLine).
 */
export function chatterLevelUp(bot: Player, stat: string, level: number, milestone: boolean, cb: number | null): void {
    const now = World.currentTick;
    const st = stateOf(bot, now);
    const since = now - st.lastLevelUp;
    st.lastLevelUp = now;
    st.events.set('levelup', { tick: now, level, stat });
    const chatty = Math.min(1, st.persona.chattiness / 15);
    let chance: number;
    // (variety round 1, P2: alone, a level-up line half as often, 99 always)
    const alone = level < 99 && companyNear(bot) === 0 ? LONE_LEVELUP : 1;
    // (variety round 2, S2-6: a bot quiet for 10 minutes or more, in a spell of grinding in silence, says one less often:
    // a level-up at 10x XP was the commonest line alone in a 10-minute window, H6)
    const spell = level < 99 && inQuietSpell(bot, now) ? QUIET_SPELL_LEVELUP : 1;
    if (milestone) chance = (0.55 + 0.4 * chatty) * (level >= 99 ? 1 : Math.min(1, (now - st.lastLevelUpLine) / MILESTONE_GAP_TICKS)) * alone * spell;
    else {
        if (level < 5 || now - st.lastLevelUpLine < LEVELUP_LINE_TICKS) return;
        chance = (0.1 + 0.3 * chatty) * Math.min(1, since / LEVELUP_DAMP_TICKS) * alone * spell;
    }
    if (Math.random() >= chance) return;
    const typing = typingTicks(st.persona, '40 wc!!');
    st.pending = { at: now + typing, until: now + typing + EVENT_HOLD_TICKS, what: 'levelup', stat, level, cb };
}

function sayLevelUp(bot: Player, st: ChatState, p: Pending, now: number): void {
    const raw = levelUpLine(p.stat!, p.level!, Math.random, p.cb ?? null);
    const { line, correction } = styleLine(raw, st.persona);
    st.lastLevelUpLine = now;
    speak(bot, line, 'levelup', 'levelup', null, correction, now, { raw });
    for (const q of World.playerLoop.all()) {
        if (q !== bot && q.is_bot && q.level === bot.level && Math.max(Math.abs(q.x - bot.x), Math.abs(q.z - bot.z)) <= 15) {
            BotChat.onBotLine(bot, line, 'levelup');
            break;
        }
    }
    afterLine(bot, st, now, Math.random() < LEVELUP_BURST_CHANCE);
}

// ── moments (port/BotHabits) ─────────────────────────────────────────────────

/**
 * Says a line for `occasion` (a short break, back from one, leaving the game) and returns it, or null (none fits).
 * Upstream's first ("brb", "Brb phone", "banking brb" at a bank, "Low hp, brb" when hurt; "Gtg srry", "Gn all"), then
 * the 2004 lines. The caller (port/BotHabits, BotManager) says it only right before the break or the logout.
 */
export function sayOccasion(bot: Player, occasion: Occasion): string | null {
    if (bot.slot === -1 || bot.levels[PlayerStat.HITPOINTS] <= 0) return null;
    const now = World.currentTick;
    // port (the realism work, phase 3: "bot friend cliques ... leave together"): a goodbye naming a friend
    // of its clique near it ("cya kev": port/BotCliques, which has the friend answer and now and then leave too), and no
    // second goodbye from a friend that said "me too" already
    if (occasion === 'departure') {
        if (saidGoodbyeLately(bot)) return null;
        const named = cliqueDeparture(bot);
        if (named !== null) {
            speak(bot, named, 'departure', 'idle', null, null, now);
            return named;
        }
    }
    const st = stateOf(bot, now);
    // (variety round 2, S2-2: a "brb" or "back" from a bot over its share of a busy place's talk: none, the break as ever)
    if (occasion !== 'departure' && !voiceFree(bot, now)) return null;
    const ctx = contextFor(bot, st);
    const picked = pickLine(ctx, occasion);
    if (!picked) return null;
    const text = picked.line.source === '2004' ? styleLine(picked.text, st.persona).line : picked.text;
    speak(bot, text, OCCASION_KIND[occasion], 'idle', null, null, now, { raw: picked.text, template: picked.template });
    return text;
}

/**
 * port (the realism work, phase 3): the bot said a line of its own accord elsewhere (a social regular's greeting to a
 * passer-by, an exchange it opened at its hub, a greeting to a friend of its clique): it counts as one of its persona's
 * lines, a burst of its own, so its next unprompted line here comes after a quiet (its lines an hour stay its persona's:
 * the talk with others takes the place of talk to nobody). Replies (the other side of those) are not counted, as the
 * conversation's answers are not.
 */
export function countAsChatter(bot: Player): void {
    const st = states.get(bot);
    if (!st) return;
    const now = World.currentTick;
    // (its next line only ever later: a quiet drawn afresh from now could come before the rest of a long one)
    const due = st.due;
    st.burst = 0;
    afterLine(bot, st, now);
    st.due = Math.max(st.due, due);
}

/**
 * (phase 7, the language model's situation: port/BotModelPrompt) what happened to the bot within `ticks` before `now`,
 * newest first: its events as noted (a death, a level-up with its skill and level, a drop, a random event's kind ...).
 * Read only: no dice.
 */
export function recentEventsOf(bot: Player, now: number, ticks: number): { name: string; tick: number; level?: number; stat?: string; kind?: string; item?: string }[] {
    const st = states.get(bot);
    if (!st) return [];
    const out: { name: string; tick: number; level?: number; stat?: string; kind?: string; item?: string }[] = [];
    // (variety round 2, S2: and a drop's item, for a thread's "get any good drops?" / "ya rune med lol": port/BotThreads)
    for (const [name, e] of st.events) {
        if (name !== 'login' && now - e.tick <= ticks) out.push({ name, tick: e.tick, level: e.level, stat: e.stat, kind: e.kind, item: e.item });
    }
    return out.sort((a, b) => b.tick - a.tick);
}

/** (phase 7) the tick this bot logged in (its 'login' event), or null before the chatter saw it */
export function loginTickOf(bot: Player): number | null {
    return states.get(bot)?.events.get('login')?.tick ?? null;
}

/** (variety round 1, tests: test/talk.test.mjs) the bot died, in the Wilderness or not, as observe() notes it. Never called by the game. */
export function noteDeathForTest(bot: Player, wild: boolean): void {
    const st = stateOf(bot, World.currentTick);
    noteEvent(bot, wild ? 'wild-death' : 'death');
    st.pending = null;
    if (wild) st.events.set('death', { tick: World.currentTick });
}

/** (variety round 1, tests) its due line now, whatever its timing (sayDue): true when it said one. Never called by the game. */
export function sayDueForTest(bot: Player): boolean {
    const now = World.currentTick;
    return sayDue(bot, stateOf(bot, now), now);
}

/**
 * (variety round 1, tests) its next unprompted line is due now (no burst, nothing pending), after a quiet drawn alone or
 * with company. Never called by the game.
 */
export function dueNowForTest(bot: Player, quietAlone = false): void {
    const st = stateOf(bot, World.currentTick);
    st.due = World.currentTick;
    st.burst = 0;
    st.followUp = false;
    st.pending = null;
    st.loneSince = -1;
    st.quietAlone = quietAlone;
    // (variety round 2: and nothing owed, a word it said elsewhere before, countAsOwnLine)
    st.debt = 0;
}

/** (variety round 1, tests) the quiet it would draw now, in ticks (the end of a burst). Never called by the game. */
export function quietForTest(bot: Player): number {
    const now = World.currentTick;
    const st = stateOf(bot, now);
    st.burst = 0;
    afterLine(bot, st, now);
    return st.due - now;
}

/** (tests) the chatter's view of a bot: when its next line is due, its events; (the fixes, B3) its own lines owed (debt) */
export function chatterStateOf(bot: Player): { due: number; burst: number; pending: boolean; events: string[]; debt: number } | null {
    const st = states.get(bot);
    return st ? { due: st.due, burst: st.burst, pending: st.pending !== null, events: [...st.events.keys()], debt: st.debt } : null;
}
