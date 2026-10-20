// port: who a bot is, beyond its skills (the realism work, 2026-10-14): how much it talks and how it types, how quick
// and how attentive it is, how friendly, helpful and sociable, its age and where it lives. A pure function of its name
// (and its planner), like its age (port/BotAge) and a PKer's build: the same at every login, never saved. Upstream's
// only notion of a personality was a table of skill weights (BotGoalPlanner.Personalities).
//
// The numbers follow the research: most players talk little and some a lot; typing at
// about 4 characters a second on average (Dhakal et al. 2018: 51.6 WPM), slower for the young; 2004's players were
// mostly 13-18 (Jagex: 8-18, an average of 16), mostly from the US and the UK; about 1 bot in 8 carries upstream's
// meta and modern jokes ("a few meme personas").
import { nameIndex, nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { normalizeBotName, plannerOf, type PlannerKey } from '#/engine/bot/port/BotRoster.js';

export type AgeBand = 'kid' | 'teen' | 'adult';

/** Where a bot says it lives (asked "where u from"): 2004's worlds were mostly American and British. */
export const REGIONS = ['usa', 'uk', 'canada', 'australia', 'netherlands', 'sweden', 'ireland', 'new zealand', 'germany', 'norway'] as const;
export type Region = (typeof REGIONS)[number];
const REGION_WEIGHTS: Record<Region, number> = { usa: 45, uk: 25, canada: 10, australia: 6, netherlands: 4, sweden: 3, ireland: 2, 'new zealand': 2, germany: 2, norway: 1 };

export interface TypingStyle {
    /** how often a word it can shorten is shortened ("you" → "u", "please" → "plz"): 0-1 */
    abbreviate: number;
    /** typos per character typed (most people 0.3-1 %, before correcting) */
    typoRate: number;
    /** how often a typo is followed by a "*word" correction */
    correctRate: number;
    /** its laughs ("lol", "lmao" ...) and smileys (":)", ":P" ...): only characters 274's chat can carry */
    laughs: readonly string[];
    smileys: readonly string[];
    /** how often a line gets "!!" or "?!" for emphasis, and how often one ends with a full stop: 0-1 */
    exclaim: number;
    endStop: number;
}

export interface Persona {
    /** idle and event lines an hour it aims at (not adverts, answers or trade talk): most 1-10, a few 20-30 */
    chattiness: number;
    /** 0 spread out, 1 in bursts (a few lines in a minute, then nothing for a long while) */
    burstiness: number;
    /** characters a second it types, and how long it thinks before it starts (ms, the median) */
    typingCps: number;
    thinkMs: number;
    /** how slow it is to act again (re-click a rock, leave the bank): 1 typical, 0.6 quick, 2 slow */
    reaction: number;
    /** the chance a re-click comes much later than usual (it looked away) */
    lapseRate: number;
    /** short breaks ("brb") an hour */
    afkPerHour: number;
    /** -1 rude, 1 friendly */
    friendliness: number;
    /** 0-1: how likely it answers a question nobody asked it, helps a newbie */
    helpfulness: number;
    /** 0-1: how much it talks with the other bots, joins in, hangs out */
    sociability: number;
    /** 0-1: how likely it stops to watch a fight, a level-up, a dance */
    curiosity: number;
    /** carries upstream's meta and modern jokes ("I am sentient", discord, rizz): about 1 bot in 8 */
    meme: boolean;
    /**
     * 0.05-1, how careless it plays (the realism work's phase 5, "fallible bots"): its misclicks, wrong turns and
     * forgotten food scale with it, and a careless bot pushes on at low HP. Log-normal around 0.25: most careful, about
     * 1 in 10 above 0.6; kids a little more. (Its own seed: the traits above are unchanged.)
     */
    carelessness: number;
    /**
     * it does rude things (phase 5, "2004 rudeness"): kill-stealing, taking a rock someone else is mining. The rude
     * talkers (`isRude`) and about 1 bot in 12 more, since a polite talker can still steal a kill. (Its own seed.)
     */
    rudeActs: boolean;
    /** its age in late 2004, and the band */
    age: number;
    ageBand: AgeBand;
    region: Region;
    style: TypingStyle;
    // (no chat colour or effect of its own: the variety work's P10 signature went, 2026-10-18: 2004's players dressed up their adverts, not their talk; a seller's adverts have theirs:
    // tasks/VendorTask vendorStyle)
}

const memo = new Map<string, Persona>();

/** Friendliness below this is a rude talker (phase 5's rude replies and arguments; about 17 % of levelling bots). */
export const RUDE_BELOW = -0.1;

/** A rude talker: its replies may be rude, and it answers back in an argument. (Deeds: `Persona.rudeActs`.) */
export function isRude(persona: Persona): boolean {
    return persona.friendliness < RUDE_BELOW;
}

/** The bot's persona: the same for the same name (and planner) every time. `planner` defaults to the roster's. */
export function personaOf(name: string, planner?: PlannerKey | null): Persona {
    const key = normalizeBotName(name);
    const role = planner ?? plannerOf(key);
    const memoKey = `${key}|${role ?? ''}`;
    let persona = memo.get(memoKey);
    if (!persona) {
        persona = makePersona(key, role);
        memo.set(memoKey, persona);
    }
    return persona;
}

/** A year of birth in the name ("Kevin1991", "aaron 1986") gives its age in 2004; else null. */
export function ageFromName(name: string): number | null {
    const m = name.match(/(?:^|[^0-9])(19[789][0-9])(?![0-9])/);
    if (!m) return null;
    const age = 2004 - Number(m[1]);
    return age >= 8 && age <= 45 ? age : null;
}

function makePersona(name: string, role: PlannerKey | null): Persona {
    const r = seededRandom(nameSeed(name, 'persona'));
    const between = (lo: number, hi: number): number => lo + r() * (hi - lo);
    // log-normal around a median: e^(σ·z) with z from two uniforms (Box-Muller)
    const logNormal = (median: number, sigma: number): number => median * Math.exp(sigma * Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()));
    const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

    const named = ageFromName(name);
    const band = r();
    const age = named ?? (band < 0.15 ? Math.floor(between(10, 13)) : band < 0.7 ? Math.floor(between(13, 18)) : Math.floor(between(18, 36)));
    const ageBand: AgeBand = age < 13 ? 'kid' : age < 18 ? 'teen' : 'adult';
    const region = weightedPick(REGION_WEIGHTS, r());

    const pker = role === 'extras_pker' || role === 'extras_edgeville_pker';
    const social = role === 'extras_social';
    const vendor = role === 'extras_vendor';

    // most players say little; a few talk a lot (median about 5 lines an hour, mean about 7)
    let chattiness = clamp(logNormal(5, 0.8), 0.5, 30);
    // (port, the realism work's phase 3: a social regular greets passers-by and has exchanges at its hub now, part of
    // its talk that was idle lines before: 1.75 times a levelling bot's, from 2.5)
    if (social) chattiness = clamp(chattiness * 1.75, 5, 30);
    if (vendor) chattiness *= 0.5; // (their adverts are their talk)
    if (pker) chattiness *= 1.2;

    const typingCps = ageBand === 'kid' ? between(2.2, 4) : ageBand === 'teen' ? between(3.2, 6) : between(2.8, 6.5);
    const youth = ageBand === 'adult' ? 0 : ageBand === 'teen' ? 0.5 : 1;

    const friendliness = clamp((pker ? -0.35 : 0.3) + (r() - 0.5) * 1.2, -1, 1);
    const helpfulness = clamp(between(0.15, 0.9) - (ageBand === 'kid' ? 0.15 : 0) + (social ? 0.2 : 0), 0, 1);
    const sociability = clamp(between(0.1, 0.9) + (social ? 0.3 : 0) - (vendor ? 0.1 : 0), 0, 1);

    // phase 5's traits from their own seed, so the ones above stay what they were for every name
    const t = seededRandom(nameSeed(name, 'texture'));
    const z = Math.sqrt(-2 * Math.log(1 - t())) * Math.cos(2 * Math.PI * t());
    const carelessness = clamp(0.25 * Math.exp(0.75 * z) + (ageBand === 'kid' ? 0.1 : 0), 0.05, 1);
    const rudeActs = friendliness < RUDE_BELOW || t() < 1 / 12;


    const laughPool = ['lol', 'lol', 'lol', 'lmao', 'haha', 'rofl', 'xd', 'hehe'];
    const smileyPool = [':)', ':)', ':P', ':D', ';)', ':('];
    const laughs = pickSome(laughPool, 1 + Math.floor(r() * 2), r);
    const smileys = pickSome(smileyPool, Math.floor(r() * 3), r);

    return {
        chattiness,
        burstiness: between(0.3, 0.9),
        typingCps,
        thinkMs: between(1000, 2600),
        reaction: clamp(logNormal(1, 0.3), 0.6, 2),
        lapseRate: between(0.02, 0.08),
        afkPerHour: clamp(logNormal(1, 0.6), 0, 3),
        friendliness,
        helpfulness,
        sociability,
        curiosity: between(0.1, 0.9),
        meme: nameIndex(name, 'meme', 8) === 0,
        carelessness,
        rudeActs,
        age,
        ageBand,
        region,
        style: {
            abbreviate: clamp(between(0.2, 0.8) + youth * 0.2, 0, 1),
            typoRate: clamp(logNormal(0.006, 0.6), 0, 0.025),
            correctRate: between(0.1, 0.3),
            laughs,
            smileys,
            exclaim: between(0, 0.3) + youth * 0.1,
            endStop: between(0, 0.15)
        }
    };
}

function weightedPick<K extends string>(weights: Record<K, number>, roll: number): K {
    const entries = Object.entries(weights) as [K, number][];
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let x = roll * total;
    for (const [k, w] of entries) {
        x -= w;
        if (x < 0) return k;
    }
    return entries[entries.length - 1][0];
}

function pickSome(pool: readonly string[], count: number, r: () => number): string[] {
    const out: string[] = [];
    for (let i = 0; i < count * 4 && out.length < count; i++) {
        const v = pool[Math.floor(r() * pool.length)];
        if (!out.includes(v)) out.push(v);
    }
    return out;
}
