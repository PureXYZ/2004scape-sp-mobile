// port: how long bots play and stay away (BOTS.md §4.4, the living world). Every duration is in play ticks: world
// ticks (600 ms) with a human in the world. The world only runs while the app is open, and a bot's evening should not
// pass while the player is on the title screen. By design, "2004-like": sessions of about 20 min
// to 2 h, away for 10 min to 1.5 h, a brand-new player about every 30 min, and 1-3 more right after the player makes
// a new character.
//
// port (the realism work, phase 3: "heavier-tailed sessions", 5-minute check-ins to 3-6-hour marathons,
// replacing 20 min-2 h): a session's length is heavy-tailed (sessionLength): median about 42 minutes, about a fifth under
// 10 minutes and a fifth over 2 hours, 5 minutes to 6 hours (WoW's measured sessions: median 43 min, 21 % under 10 min,
// 22 % over 2 h; the research's stateofart §4). A check-in (a short session) is followed by a shorter absence
// (awayAfter). Newcomers come by the level-3s about Lumbridge (newcomerPace: "Lumbridge newbies").

export interface SessionTiming {
    /** how long a bot stays online: the shortest and the longest (sessionLength: heavy-tailed, median their geometric mean) */
    session: [number, number];
    /** how long it stays away before it may come back, log-uniform (shorter after a check-in: awayAfter) */
    away: [number, number];
    /** between two newcomers, uniform (newcomerGap: sooner while few level-3s are about Lumbridge, none while many are) */
    newcomer: [number, number];
    /** how many newcomers follow a new character, and how soon after it enters the world */
    newCharacterCount: [number, number];
    newCharacterDelay: [number, number];
    /** between two returns while fewer than N bots are online (not when the world fills: then 5 a tick) */
    returnGap: [number, number];
    /** world ticks without a human before every bot logs out (the title screen; the world fills again at a login) */
    emptyWorld: number;
    /** a bot whose session is over but who is busy (a fight, a trade, a conversation) leaves anyway after this */
    busyGiveUp: number;
    /** a bot that was asked to leave but is still in the world after this goes back to playing for a bit */
    leaveGiveUp: number;
}

const MINUTE = 100; // ticks of 600 ms

export const DEFAULT_TIMING: Readonly<SessionTiming> = {
    // port (phase 3): 5 min-6 h, heavy-tailed (sessionLength); was log-uniform 20 min-2 h
    session: [5 * MINUTE, 360 * MINUTE],
    away: [10 * MINUTE, 90 * MINUTE],
    newcomer: [20 * MINUTE, 40 * MINUTE],
    newCharacterCount: [1, 3],
    newCharacterDelay: [MINUTE / 2, 4 * MINUTE],
    returnGap: [20, 150],
    emptyWorld: MINUTE,
    busyGiveUp: 10 * MINUTE,
    leaveGiveUp: 50
};

/** DEFAULT_TIMING with the given fields replaced (tests and world.json bots.timing); bad values are ignored. */
export function timing(overrides?: Partial<SessionTiming> | null): SessionTiming {
    const t: SessionTiming = { ...DEFAULT_TIMING } as SessionTiming;
    if (!overrides) return t;
    for (const key of Object.keys(DEFAULT_TIMING) as (keyof SessionTiming)[]) {
        const v = overrides[key];
        if (Array.isArray(DEFAULT_TIMING[key])) {
            if (Array.isArray(v) && v.length === 2 && v.every(n => Number.isFinite(n) && n >= 0) && v[0] <= v[1]) (t[key] as [number, number]) = [Math.round(v[0]), Math.round(v[1])];
        } else if (typeof v === 'number' && Number.isFinite(v) && v >= 1) {
            (t[key] as number) = Math.round(v);
        }
    }
    return t;
}

/** A whole number in [min, max], uniform. */
export function uniform([min, max]: [number, number], random: () => number): number {
    return Math.floor(min + random() * (max - min + 1));
}

/** A whole number in [min, max], log-uniform (as likely between 20 and 40 minutes as between 60 and 120). */
export function logUniform([min, max]: [number, number], random: () => number): number {
    if (min <= 0 || max <= min) return uniform([min, max], random);
    return Math.round(Math.exp(Math.log(min) + random() * (Math.log(max) - Math.log(min))));
}

/** A standard normal number (Box-Muller, two draws of `random`). */
function normal(random: () => number): number {
    const u = Math.max(1e-12, random());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/**
 * port (phase 3): the spread of ln(session length) below and above its median: a two-sided log-normal, so that about a
 * fifth of the sessions are under 10 minutes (σ 1.8) and a fifth over 2 hours (σ 1.27) with the default 5 min-6 h
 * (median 42 min). One σ cannot give both: WoW's short sessions are commoner than a log-normal's.
 */
export const SESSION_SIGMA: readonly [number, number] = [1.8, 1.27];

/**
 * port (phase 3, "heavier-tailed sessions"): how long a session lasts, in [min, max]: two-sided log-normal
 * around the geometric mean of min and max (SESSION_SIGMA). A draw under min is a check-in of min to 2 × min (5-10
 * minutes), one over max a marathon of max / 2 to max (3-6 hours): no pile-up at either end.
 */
export function sessionLength([min, max]: [number, number], random: () => number): number {
    if (min <= 0 || max <= min) return uniform([min, max], random);
    const median = Math.sqrt(min * max);
    const u = normal(random);
    let x = median * Math.exp(u * (u < 0 ? SESSION_SIGMA[0] : SESSION_SIGMA[1]));
    if (x < min) x = min * (1 + random());
    else if (x > max) x = max * (0.5 + 0.5 * random());
    return Math.round(Math.min(max, Math.max(min, x)));
}

/**
 * port (phase 3): what is left of the session of a bot that is online at a random moment (the first bots of a run are
 * somewhere in their sessions already): a session drawn by its length (a marathon is more likely to be under way than a
 * check-in, the length-biased draw: accepted with the chance length / max), then a point in it. With heavy tails the
 * plain draw would end most first sessions early, a wave of logouts after every launch.
 */
export function sessionLeft([min, max]: [number, number], random: () => number): number {
    let length = sessionLength([min, max], random);
    if (max > min && min > 0) for (let i = 0; i < 20 && random() * max > length; i++) length = sessionLength([min, max], random);
    return Math.floor(random() * length);
}

/** port (phase 3): a session shorter than this is a check-in (15 minutes by default: three times the shortest, and under the median) */
export function checkInTicks(t: Pick<SessionTiming, 'session'>): number {
    const [min, max] = t.session;
    return Math.round(Math.min(3 * min, Math.sqrt(min * max)));
}

/**
 * port (phase 3): how long a bot stays away after a session of `played` ticks: log-uniform over `away`, but after a
 * check-in (checkInTicks) half the shortest to three times the shortest (5-30 minutes by default): check-ins come back.
 */
export function awayAfter(played: number, t: Pick<SessionTiming, 'session' | 'away'>, random: () => number): number {
    const [min, max] = t.away;
    if (played >= 0 && played < checkInTicks(t) && max > min) return logUniform([Math.max(1, Math.round(min / 2)), Math.min(max, 3 * min)], random);
    return logUniform(t.away, random);
}

/**
 * port (phase 3: "Lumbridge newbies", about 5-10 level-3s per 100 online around Lumbridge, through more
 * newcomers or slow-levelling alts; newbie time measured in levels, port/BotNewbie): the newcomer clock keeps the bots of
 * combat 5 or less around Lumbridge (port/BotNewbie.lumbridgeLowLevel: newbies, slow levellers and any other level-3
 * there; the humanlike report's P1) at LOW_LEVELS_SOON to LOW_LEVELS_MOST per 100 online: fewer, a newcomer comes soon;
 * more, it waits (looked at again a regular gap later; one in NEWCOMER_WAIT_LOOKS looks a newcomer comes anyway). At 1x
 * a new world's level-3 accounts fill much of it and few newcomers come; at 10x a newbie is past combat 5 in minutes
 * and the slow levellers carry it.
 */
export const LOW_LEVELS_SOON = 7;
/**
 * "slower turnover" (2026-10-15): 7, was 9. The slow-levelling alts (2 newcomers in 3) stay level-3s about
 * Lumbridge for their sessions, so at 7 or more the clock waits (a newcomer one look in NEWCOMER_WAIT_LOOKS); between
 * 7 and 9 it brought one every 20-40 minutes, each retiring an old bot (29 newcomers in 6 hours at 10x XP, 100 online)
 */
export const LOW_LEVELS_MOST = 7;
/** a small world waits only from this many level-3s (at 10 online one is 10 per 100) */
export const LOW_LEVELS_WAIT_FLOOR = 2;
/**
 * while it waits, every this many looks a newcomer comes anyway (at 100 online about one in 2-4 hours of play): a world
 * full of a new store's level-3 accounts (1x) still has a newbie now and then, and its pool still turns over
 */
export const NEWCOMER_WAIT_LOOKS = 6;
/** how much sooner a newcomer comes while few level-3s are about, for 100 online (in proportion for more or fewer, never later than the regular gap) */
export const NEWCOMER_SOON = 8;

export type NewcomerPace = 'soon' | 'regular' | 'wait';

/** port (phase 3): the newcomer clock's pace with `lowLevels` level-3s around Lumbridge of `online` online (see LOW_LEVELS_SOON) */
export function newcomerPace(lowLevels: number, online: number): NewcomerPace {
    const per100 = online > 0 ? (100 * lowLevels) / online : 0;
    if (per100 < LOW_LEVELS_SOON) return 'soon';
    return lowLevels >= Math.max(LOW_LEVELS_WAIT_FLOOR, (LOW_LEVELS_MOST * online) / 100) ? 'wait' : 'regular';
}

/**
 * port (phase 3): the gap to the next newcomer (or to the next look at the level-3s, 'wait'): the regular gap
 * (timing.newcomer), or soon: that divided by NEWCOMER_SOON × online / 100 (at 100 online 2.5-5 minutes, at 500 30-60 s,
 * at 25 10-20 minutes; never longer than the regular gap). A test's "no newcomers" ([1e7, 1e7]) stays none.
 */
export function newcomerGap(pace: NewcomerPace, online: number, t: Pick<SessionTiming, 'newcomer'>, random: () => number): number {
    const gap = uniform(t.newcomer, random);
    return pace === 'soon' ? Math.max(1, Math.round(gap / soonDivisor(online))) : gap;
}

/** port (phase 3): the longest gap newcomerGap gives at this pace (BotManager pulls a far newcomer in when few level-3s are about) */
export function newcomerGapMost(pace: NewcomerPace, online: number, t: Pick<SessionTiming, 'newcomer'>): number {
    return pace === 'soon' ? Math.max(1, Math.round(t.newcomer[1] / soonDivisor(online))) : t.newcomer[1];
}

function soonDivisor(online: number): number {
    return Math.max(1, (NEWCOMER_SOON * online) / 100);
}
