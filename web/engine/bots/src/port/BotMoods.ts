// port (bots ideas, round 2, theme C: lives with arcs, C2):
// three moods a bot carries through a session, each 0-1, from what happens to it (the arcs' bus), that change which lines
// it says, never how many, and now and then what it does.
//
//   tilt      own death +0.5 (a PKer's +0.4); a kill-steal on it +0.25 meant, +0.1 not; a rock stolen +0.2; a duel lost
//             +0.15 (+0.2 x stake/50k, at most +0.2 more); the deed of a bot it has a grudge on (theme D) +0.15 more. Each
//             x its temper. Half-life 10 minutes.
//             0.35+: half of its own idle lines from the tilt pool ("this game", "so annoying"); a rude talker's rude
//                    replies x1.5 (0.5 to 0.75: port/BotChat, port/BotRude), a polite bot's answers as ever (never ignored);
//                    'tilt' on the bus (theme D: its KS war)
//             0.55+: a careless bot (carelessness 0.35+) makes its next pick a risky one: a second death's caution
//                    (port/BotFumble isShaken) ignored once, its careless roll doubled (port/BotGoalPlanner's danger check)
//             0.75+: a rage-quit (port/BotLeaving), 0.4 x temper, once a crossing, at most once a bot in 3 hours of play
//   elation   a milestone level +0.15, a 99 +1; a goal done +0.6; a rune drop +0.5, one worth 5k+ +0.3; a duel won +0.3; a
//             PK kill +0.25; 3+ piles taken at a party +0.15. Each x its excitability. Half-life 8 minutes.
//             0.3+:  40 % of its own idle lines from the happy pool ("best day ever"); the likelier gz responder (x1.5:
//                    port/BotChat, the same number of gz)
//             0.8+:  with 20k+ coins, friendliness over 0.2 and sociability over 0.5: a mini drop party (0.25; at most one a
//                    bot in 6 hours of play, one in the world in 20 minutes: port/BotNinetyNine startMiniParty)
//             a drop worth 50k+: bank it and leave, 0.3 (port/BotLeaving)
//   boredom   +0.01 a minute at one task kind x its impatience (2.2 - patience: 0.6-1.6), -0.15 a level-up in its skill,
//             0.1 after a change of task kind; a levelling bot's (its planner's picks)
//             0.6+:  its next pick avoids the last skill 70 % of the time (port/BotLivesIndex); 30 % of its own idle lines
//                    from the bored pool ("ugh willows again"). It never ends a plan early (the 15-60 minute plans).
// Sensitivities from the name (port/BotSeed salt 'moods'): temper 0.5-1.6 (a rude talker x1.3), patience 0.6-1.6,
// excitability 0.6-1.5 (a kid x1.2). Every meter is zero at a login and decays lazily (no pass a tick).
// moodOf is theme D's (provideArcs('moodOf'): its KS war, its bored clique followers). Bots only: nothing the human does
// moves a mood except as the other side of a bot's moment (its steal on a bot, its kill of a PKer), and no mood is about
// the human.
import ObjType from '#/cache/config/ObjType.js';
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { arcsMood, arcsPlay, arcsTie, emitArcs, onArcs, provideArcs } from '#/engine/bot/port/BotArcsEvents.js';
import { arcLines, sayArcLine, type ArcSlots } from '#/engine/bot/port/BotArcsSay.js';
import { onEndgameEvent } from '#/engine/bot/port/BotEndgameCore.js';
import { carelessnessOf } from '#/engine/bot/port/BotFumble.js';
import { contextOf } from '#/engine/bot/port/BotLines.js';
import { LIVES, LIVES_CTL, noteLivesLine } from '#/engine/bot/port/BotLives.js';
import { isRude, personaOf } from '#/engine/bot/port/BotPersona.js';
import { itemValue, streetPrice } from '#/engine/bot/port/BotPrices.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';

// ── the defaults ───────────────────────────────────────────────────────────────────────────────────

export const TILT = { death: 0.5, pkerDeath: 0.4, ksMeant: 0.25, ksNot: 0.1, rock: 0.2, duelLost: 0.15, duelStake: 0.2, grudge: 0.15, halfLife: 1000 };
export const ELATION = { milestone: 0.15, ninetyNine: 1, goal: 0.6, runeDrop: 0.5, drop5k: 0.3, duelWon: 0.3, pkKill: 0.25, party: 0.15, halfLife: 800 };
export const BOREDOM = { perMinute: 0.01, levelUp: 0.15, change: 0.1 };
/** the thresholds */
export const MOOD_AT = { tiltLines: 0.35, risky: 0.55, rage: 0.75, elatedLines: 0.3, miniParty: 0.8, boredPick: 0.6 };
/** a mood's share of its own idle lines */
export const MOOD_LINES = { tilt: 0.5, elated: 0.4, bored: 0.3 };
const RAGE_CHANCE = 0.4;
const RAGE_GAP = 18_000;
const RISKY_CARELESS = 0.35;
const BIG_DROP = 50_000;
const DROP_5K = 5_000;

// ── the sensitivities (from the name) ────────────────────────────────────────────────────────────────────────────

export interface Sensitivity {
    temper: number;
    patience: number;
    excitability: number;
}
const sens = new Map<string, Sensitivity>();
/** a bot's sensitivities, from its name (salt 'moods'): the same every session */
export function sensitivityOf(p: Player): Sensitivity {
    const key = p.username;
    let s = sens.get(key);
    if (!s) {
        const r = seededRandom(nameSeed(key, 'moods'));
        const persona = personaOf(key, (p.botPlanner as PlannerKey | undefined) ?? null);
        s = { temper: (0.5 + 1.1 * r()) * (isRude(persona) ? 1.3 : 1), patience: 0.6 + r(), excitability: (0.6 + 0.9 * r()) * (persona.age < 13 ? 1.2 : 1) };
        sens.set(key, s);
    }
    return s;
}

// ── the meters ───────────────────────────────────────────────────────────────────────────────────────────────────

interface Mood {
    tilt: number;
    tiltAt: number;
    elation: number;
    elationAt: number;
    /** boredom: the task kind and since when, its skill's level-ups since */
    kind: string | null;
    kindSince: number;
    kindLevelUps: number;
    kindStat: number;
    /** a crossing once: back under the mark first */
    over: { lines: boolean; risky: boolean; rage: boolean; party: boolean };
    /** its next pick is a risky one (a careless bot tilted 0.55+) */
    risky: boolean;
    /** a tilt episode (0.35+) under way: its log entry */
    episode: TiltEpisode | null;
}
const moods = new WeakMap<Player, Mood>();
function moodState(p: Player): Mood {
    let m = moods.get(p);
    if (!m) moods.set(p, (m = { tilt: 0, tiltAt: 0, elation: 0, elationAt: 0, kind: null, kindSince: 0, kindLevelUps: 0, kindStat: -1, over: { lines: false, risky: false, rage: false, party: false }, risky: false, episode: null }));
    return m;
}
const decay = (v: number, at: number, now: number, halfLife: number): number => (v <= 0 ? 0 : v * Math.pow(0.5, Math.max(0, now - at) / halfLife));

/** the tilt and elation now (play ticks), each 0-1 */
function meters(m: Mood, play: number): { tilt: number; elation: number } {
    return { tilt: decay(m.tilt, m.tiltAt, play, TILT.halfLife), elation: decay(m.elation, m.elationAt, play, ELATION.halfLife) };
}

/** a levelling bot's boredom now (0-1) */
function boredomOf(p: Player, m: Mood, play: number): number {
    if (m.kind === null) return 0;
    const minutes = Math.max(0, play - m.kindSince) / 100;
    const impatience = 2.2 - sensitivityOf(p).patience;
    return Math.max(0, Math.min(1, BOREDOM.change + BOREDOM.perMinute * minutes * impatience - BOREDOM.levelUp * m.kindLevelUps));
}

/** The bot's moods now (each 0-1), or null for no bot. Theme D's moodOf (the foundation's arcsMood). */
export function moodOf(p: Player): { tilt: number; elation: number; boredom: number } | null {
    if (p.is_bot !== true || !LIVES_CTL.on) return null;
    const m = moods.get(p);
    if (!m) return { tilt: 0, elation: 0, boredom: 0 };
    const play = arcsPlay();
    const { tilt, elation } = meters(m, play);
    return { tilt, elation, boredom: boredomOf(p, m, play) };
}
provideArcs('moodOf', moodOf);

// ── the log (the humanlike runner's AR10, AR11; the tests) ───────────────────────────────────────────────────────

export interface TiltEpisode {
    name: string;
    /** world ticks: tilt 0.35+ from, to (its decay's end as it stands; a later gain moves it) */
    from: number;
    to: number;
    peak: number;
    why: string[];
}
const EPISODES_MAX = 2000;
export const tiltEpisodes: TiltEpisode[] = [];
export const moodStats = { gains: { tilt: 0, elation: 0 }, risky: 0, rageRolls: 0, miniPartyRolls: 0, bigDrops: 0, boredAvoided: 0, lines: { tilt: 0, elated: 0, bored: 0 } };

// ── the gains ────────────────────────────────────────────────────────────────────────────────────────────────────

/** what the other C modules do at a crossing (port/BotLeaving: a rage-quit, a big drop's bank; port/BotNinetyNine: a mini party) */
export const moodActions: {
    rage?(p: Player): boolean;
    bigDrop?(p: Player, value: number): boolean;
    miniParty?(p: Player): boolean;
} = {};
const lastRage = new Map<string, number>();

function addTilt(p: Player, amount: number, why: string): void {
    if (p.is_bot !== true || p.slot === -1 || amount <= 0) return;
    const m = moodState(p);
    const play = arcsPlay();
    const was = meters(m, play).tilt;
    const now = Math.min(1, was + amount * sensitivityOf(p).temper);
    m.tilt = now;
    m.tiltAt = play;
    moodStats.gains.tilt++;
    const tick = World.currentTick;
    // (an episode of 0.35+: from now, to where its decay brings it under again)
    if (now >= MOOD_AT.tiltLines) {
        const to = tick + Math.ceil(TILT.halfLife * Math.log2(now / MOOD_AT.tiltLines));
        if (m.episode && m.episode.to >= tick) {
            m.episode.to = to;
            m.episode.peak = Math.max(m.episode.peak, now);
            if (m.episode.why.length < 6) m.episode.why.push(why);
        } else {
            m.episode = { name: p.username, from: tick, to, peak: now, why: [why] };
            tiltEpisodes.push(m.episode);
            if (tiltEpisodes.length > EPISODES_MAX) tiltEpisodes.splice(0, tiltEpisodes.length - EPISODES_MAX);
        }
    }
    if (was < MOOD_AT.tiltLines) m.over.lines = false;
    if (was < MOOD_AT.risky) m.over.risky = false;
    if (was < MOOD_AT.rage) m.over.rage = false;
    if (now >= MOOD_AT.tiltLines && !m.over.lines) {
        m.over.lines = true;
        emitArcs({ k: 'tilt', bot: p, tilt: now, detail: { why } });
    }
    if (now >= MOOD_AT.risky && !m.over.risky) {
        m.over.risky = true;
        if (isLevelling(p.botPlanner as PlannerKey) && carelessnessOf(p) >= RISKY_CARELESS) {
            m.risky = true;
            moodStats.risky++;
        }
    }
    if (now >= MOOD_AT.rage && !m.over.rage) {
        m.over.rage = true;
        const last = lastRage.get(p.username);
        if ((last === undefined || play - last >= RAGE_GAP) && Math.random() < RAGE_CHANCE * sensitivityOf(p).temper * rageScale) {
            moodStats.rageRolls++;
            if (moodActions.rage?.(p)) lastRage.set(p.username, play);
        }
    }
}

function addElation(p: Player, amount: number): void {
    if (p.is_bot !== true || p.slot === -1 || amount <= 0) return;
    const m = moodState(p);
    const play = arcsPlay();
    const was = meters(m, play).elation;
    const now = Math.min(1, was + amount * sensitivityOf(p).excitability);
    m.elation = now;
    m.elationAt = play;
    moodStats.gains.elation++;
    if (was < MOOD_AT.miniParty) m.over.party = false;
    if (now >= MOOD_AT.miniParty && !m.over.party) {
        m.over.party = true;
        if (moodActions.miniParty) {
            moodStats.miniPartyRolls++;
            moodActions.miniParty(p);
        }
    }
}

/** a pick-up's worth: elation for a rune or 5k+ drop; 50k+: the big-drop leave's roll (port/BotLeaving) */
function noteDrop(p: Player, id: number): void {
    let value = 0;
    let rune = false;
    try {
        const type = ObjType.get(id);
        rune = (type?.debugname ?? '').toLowerCase().startsWith('rune_');
        value = streetPrice(id) ?? itemValue(id);
    } catch {
        return;
    }
    if (rune) addElation(p, ELATION.runeDrop);
    else if (value >= DROP_5K) addElation(p, ELATION.drop5k);
    if (value >= BIG_DROP) {
        moodStats.bigDrops++;
        moodActions.bigDrop?.(p, value);
    }
}

// ── the bus ──────────────────────────────────────────────────────────────────────────────────────────────────────

const isPker = (p: Player): boolean => p.botPlanner === 'extras_pker' || p.botPlanner === 'extras_edgeville_pker';

onArcs('login', e => {
    if (!LIVES_CTL.on) return;
    if (e.bot) moods.delete(e.bot);
});
onArcs('death', e => {
    if (LIVES_CTL.on) addTilt(e.bot, isPker(e.bot) ? TILT.pkerDeath : TILT.death, e.wild ? 'wild-death' : 'death');
});
onArcs('kill', e => {
    if (!LIVES_CTL.on) return;
    if (e.killer.is_bot) addElation(e.killer, ELATION.pkKill);
});
onArcs('steal', e => {
    if (!LIVES_CTL.on) return;
    const v = e.victim;
    if (v.is_bot !== true) return;
    const inc = e.incident;
    let gain = inc.kind === 'rock' ? TILT.rock : inc.deliberate ? TILT.ksMeant : TILT.ksNot;
    // (a noticed take that turned out meant: the difference)
    if (e.again) gain = TILT.ksMeant - TILT.ksNot;
    const tie = e.stealer.is_bot ? arcsTie(v.username, e.stealer.username) : null;
    if (tie && tie.grudge >= 1 && !e.again) gain += TILT.grudge;
    addTilt(v, gain, inc.kind === 'rock' ? 'rock' : 'ks');
});
onArcs('duel', e => {
    if (!LIVES_CTL.on) return;
    if (e.winner.is_bot) addElation(e.winner, ELATION.duelWon);
    if (e.loser.is_bot) addTilt(e.loser, TILT.duelLost + Math.min(TILT.duelStake, (TILT.duelStake * Math.max(0, e.stake)) / 50_000), 'duel');
});
onArcs('levelup', e => {
    if (!LIVES_CTL.on) return;
    if (e.level >= 99) addElation(e.bot, ELATION.ninetyNine);
    else if (e.milestone) addElation(e.bot, ELATION.milestone);
    const m = moods.get(e.bot);
    if (m && m.kindStat === e.stat) m.kindLevelUps++;
});
onArcs('goal-done', e => {
    if (LIVES_CTL.on) addElation(e.bot, ELATION.goal);
});
// (3+ piles taken at a party: its record's drops by name)
onArcs('set-piece', e => {
    if (!LIVES_CTL.on) return;
    if (e.phase !== 'done') return;
    const record = (e.run as unknown as { record?: { drops?: { name: string | null }[] }; guests?: Map<Player, unknown> }).record;
    const guests = (e.run as unknown as { guests?: Map<Player, unknown> }).guests;
    if (!record?.drops || !guests) return;
    for (const g of guests.keys()) if (record.drops.filter(d => d.name === g.username).length >= 3) addElation(g, ELATION.party);
});
onEndgameEvent(ev => {
    if (!LIVES_CTL.on) return;
    if (ev.kind !== 'rareDrop') return;
    const id = typeof ev.data.id === 'number' ? ev.data.id : -1;
    if (id >= 0) noteDrop(ev.bot, id);
});

// ── the hooks ────────────────────────────────────────────────────────────────────────────────────────────────────

/** the chatter's due idle line from a mood's pool, said (in its place: H7 stays), or false */
LIVES.idleLine = bot => {
    const mood = moodOf(bot);
    if (!mood) return false;
    let kind: 'tilt' | 'elated' | 'bored' | null = null;
    if (mood.tilt >= MOOD_AT.tiltLines && Math.random() < MOOD_LINES.tilt) kind = 'tilt';
    else if (mood.elation >= MOOD_AT.elatedLines && Math.random() < MOOD_LINES.elated) kind = 'elated';
    else if (mood.boredom >= MOOD_AT.boredPick && Math.random() < MOOD_LINES.bored) kind = 'bored';
    if (kind === null) return false;
    let slots: ArcSlots = {};
    if (kind === 'bored') {
        const s = contextOf(bot).slots ?? {};
        slots = { ...(s.target ? { target: s.target } : {}), ...(s.skill ? { skill: s.skill } : {}) };
    }
    const said = sayArcLine(bot, arcLines('arcs-mood', kind), slots, { kind: 'idle', budget: 'slot', spoke: 'idle' });
    if (!said) return false;
    moodStats.lines[kind]++;
    noteLivesLine(bot, 'arcs-mood', kind, said);
    return true;
};

LIVES.dropValue = (bot, id) => noteDrop(bot, id);

LIVES.rudeReplyScale = bot => ((arcsMood(bot)?.tilt ?? 0) >= MOOD_AT.tiltLines ? 1.5 : 1);
LIVES.gzWeight = bot => ((arcsMood(bot)?.elation ?? 0) >= MOOD_AT.elatedLines ? 1.5 : 1);

/** the planner: a pick begins: a risky one for a careless bot tilted 0.55+ (once), held for the pick (port/BotFumble) */
let riskyBot: Player | null = null;
export function beginMoodPick(p: Player): void {
    const m = moods.get(p);
    riskyBot = m?.risky ? p : null;
    if (m) m.risky = false;
}
LIVES.riskyNow = bot => riskyBot === bot;

/** the planner: the task picked (boredom's clock: a change of task kind starts it again) */
export function endMoodPick(p: Player, kind: string | null, stat: number): void {
    riskyBot = null;
    if (kind === null || !isLevelling(p.botPlanner as PlannerKey)) return;
    const m = moodState(p);
    if (m.kind === kind) return;
    m.kind = kind;
    m.kindSince = arcsPlay();
    m.kindLevelUps = 0;
    m.kindStat = stat;
}

/** the planner: the skill boredom avoids now (70 % of picks at 0.6+), or null */
export function boredSkillToAvoid(p: Player): number | null {
    const m = moods.get(p);
    if (!m || m.kindStat < 0) return null;
    if (boredomOf(p, m, arcsPlay()) < MOOD_AT.boredPick || Math.random() >= 0.7) return null;
    moodStats.boredAvoided++;
    return m.kindStat;
}

// ── the runner and the tests ─────────────────────────────────────────────────────────────────────────────────────

let rageScale = 1;
/** (tests) the meters set now (play ticks), its crossings acted on as a gain's (null: forget the bot's moods) */
export function setMoodForTest(p: Player, mood: { tilt?: number; elation?: number } | null): void {
    if (mood === null) {
        moods.delete(p);
        return;
    }
    const m = moodState(p);
    const play = arcsPlay();
    if (mood.tilt !== undefined) {
        m.tilt = 0;
        m.tiltAt = play;
        m.over = { ...m.over, lines: false, risky: false, rage: false };
        addTilt(p, mood.tilt / sensitivityOf(p).temper, 'test');
    }
    if (mood.elation !== undefined) {
        m.elation = 0;
        m.elationAt = play;
        m.over.party = false;
        addElation(p, mood.elation / sensitivityOf(p).excitability);
    }
}
/** (tests) the rage-quit's roll x this (0: none; null: as the game) */
export function setRageScaleForTest(scale: number | null): void {
    rageScale = scale ?? 1;
}
/** (tests) a bot's boredom at this task kind since `minutesAgo` minutes of play */
export function setBoredForTest(p: Player, kind: string, stat: number, minutesAgo: number): void {
    const m = moodState(p);
    m.kind = kind;
    m.kindStat = stat;
    m.kindSince = arcsPlay() - minutesAgo * 100;
    m.kindLevelUps = 0;
}
/** (tests) forget the 3-hour rage gap */
export function resetMoodsForTest(): void {
    lastRage.clear();
    tiltEpisodes.length = 0;
}
