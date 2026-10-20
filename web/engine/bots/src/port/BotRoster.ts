// Which bots exist (BOTS.md §4.6). Upstream spawned the 100 accounts of its bots.config.json (sk1…sk13, fi1…,
// soc12), whose names also made its chat AI answer ordinary words ("ask", "fish", "trade"). Here a bot is a name
// from data/names.json (believable 2004 player names, append only: a bot's save is keyed by its name), and its planner
// follows from the name's place in the list: names[i] is PLANNERS[i % 8], upstream's groups interleaved, so every
// prefix of the list keeps the mix.
//
// The living world (BOTS.md §4.4): the Settings' N is how many bots are online at a time, out of a pool of about 2N
// known bots (initialPool) that take turns. Over time newcomers join (NameSource: the first name nobody has used, a
// levelling planner) and old accounts quit; a name is never used for a second bot.
import { fromBase37, toBase37 } from '#/util/JString.js';
import namesJson from '../../data/names.json';

/** Upstream's planner groups, in their bots.config.json order. */
export const PLANNERS = ['skiller', 'fighter', 'balanced', 'random', 'extras_edgeville_pker', 'extras_vendor', 'extras_pker', 'extras_social'] as const;
export type PlannerKey = (typeof PLANNERS)[number];

/** The most bots online at once (Settings › World › Bots offers 25/50/100/250/500/750/1000; upstream ran 100). */
export const ROSTER_SLOTS = 1000;

/** The pool is this many times the online count (Settings: "about N online, out of about 2N"). */
export const POOL_FACTOR = 2;

/** A name as the engine stores it (base37: lower case, '_' for a space, at most 12 characters). */
export function normalizeBotName(name: string): string {
    return fromBase37(toBase37(name));
}

export const BOT_NAMES: readonly string[] = namesJson.names.map(normalizeBotName);

/** a name in the engine's own form already (a username, a roster name): no base37 round trip needed */
const NORMALIZED = /^[a-z0-9](?:[a-z0-9_]{0,10}[a-z0-9])?$/;
/**
 * port (phase 3): normalizeBotName, skipped for a name in its form already (a Player's username, a roster name): the
 * round trip was most of a login fill's cost at 500 bots once the clique bonus asked about every due bot's friends
 */
export function botNameKey(name: string): string {
    return NORMALIZED.test(name) ? name : normalizeBotName(name);
}

const NAME_INDEX = new Map<string, number>(BOT_NAMES.map((name, i) => [name, i]));

/** The planner of a bot name (its place in names.json), or null for a name that is not a bot's. */
export function plannerOf(name: string): PlannerKey | null {
    const i = NAME_INDEX.get(normalizeBotName(name));
    return i === undefined ? null : PLANNERS[i % PLANNERS.length];
}

/** Bots that train and level up (newcomers are always one of these: the point of a newcomer is a new player). */
export function isLevelling(planner: PlannerKey): boolean {
    return planner === 'skiller' || planner === 'fighter' || planner === 'balanced' || planner === 'random';
}

/**
 * port: the role mix (2026-10-14): 70 % of the places online go to the levelling planners (a
 * quarter of that each: 17.5 %), 30 % to the extras (vendors, social bots, Edgeville and deep-Wilderness PKers: 7.5 %
 * each), at every size: 25 online is about 17-18 levelling bots and 2 of each extra, 500 online 87-88 of each levelling
 * planner and 37-38 of each extra. Upstream gave each of the 8 an eighth; the port first kept that up to 100 online
 * and gave every place above it to the levelling planners.
 */
export const LEVELLING_SHARE = 0.7;

/** How many of `online` bots a planner group should have online (a share, not rounded). */
export function onlineShare(online: number, planner: PlannerKey): number {
    const levelling = isLevelling(planner);
    const groups = PLANNERS.filter(p => isLevelling(p) === levelling).length;
    // (in whole percents: at 100 online an extra's share is 7.5, not 7.500000000000001, which a pool's cap rounded up)
    const percent = Math.round(100 * (levelling ? LEVELLING_SHARE : 1 - LEVELLING_SHARE));
    return (online * percent) / (100 * groups);
}

/** port: a planner group's place in a pool of about 2N: POOL_FACTOR times its online share (not rounded) */
export function poolShare(online: number, planner: PlannerKey): number {
    return POOL_FACTOR * onlineShare(online, planner);
}

/**
 * port: the most fresh names of a group a new pool takes: its place in the pool, rounded up (levelling: no limit; the
 * names alternate the 8 planners, so the extras would otherwise fill a quarter of a pool each). An extras group past
 * it (a store saved under the first mix, or when N went down) is the first to lose a bot when one quits
 * (BotManager._quitOne).
 */
export function groupCap(online: number, planner: PlannerKey): number {
    return isLevelling(planner) ? Infinity : Math.ceil(poolShare(online, planner));
}

export interface RosterEntry {
    /** the name's place in names.json */
    slot: number;
    name: string;
    planner: PlannerKey;
    /** joined the world after the store was made: starts fresh even when the store's first bots were aged */
    newcomer?: boolean;
}

/** How big the pool is for N online: about 2N, at most the names there are. */
export function poolSize(online: number): number {
    const n = Math.max(0, Math.min(Math.floor(online) || 0, ROSTER_SLOTS));
    return Math.min(n * POOL_FACTOR, BOT_NAMES.length);
}

/**
 * The pool when the bots start: every saved bot (`saved`: its name is in the store) that is still available, then, up
 * to poolSize(online), the first names in the list that nobody has used. `available(name)` is false for a name a human
 * character has (it goes to `reserved`); `used(name)` is true for a name some bot already had (one that quit).
 * port: an extras group past twice its online share (groupCap: 15 % of N, 7.5 % of the pool each) takes no more fresh
 * names: the pool goes on with levelling names, in list order. And a group still short of its place (poolShare,
 * rounded down) by more than one takes the first unused names of its own past poolSize, up to one short (`topUp`
 * counts them): a store saved under the first mix had an eighth each up to 100 online (too few levelling bots for 70 %
 * of the places: the extras filled the gaps) and 12.5 % each of the extras above it (too few extras). BotManager sheds
 * what a top-up added, a bot a newcomer. (One short: a new pool's levelling groups can be, the extras' caps being
 * rounded up; a new pool is never topped up.)
 */
export function initialPool(online: number, saved: Iterable<string>, available: (name: string) => boolean, used: (name: string) => boolean): { entries: RosterEntry[]; reserved: string[]; topUp: number } {
    const entries: RosterEntry[] = [];
    const reserved: string[] = [];
    const taken = new Set<string>();
    for (const raw of saved) {
        const name = normalizeBotName(raw);
        const slot = NAME_INDEX.get(name);
        if (slot === undefined || taken.has(name) || used(name)) continue; // not a bot (any more): its record is carried over
        taken.add(name);
        if (!available(name)) {
            reserved.push(name);
            continue;
        }
        entries.push({ slot, name, planner: PLANNERS[slot % PLANNERS.length] });
    }
    const size = poolSize(online);
    const groups = new Map<PlannerKey, number>();
    for (const e of entries) groups.set(e.planner, (groups.get(e.planner) ?? 0) + 1);
    for (let slot = 0; slot < BOT_NAMES.length && entries.length < size; slot++) {
        const name = BOT_NAMES[slot];
        if (taken.has(name) || used(name)) continue;
        const planner = PLANNERS[slot % PLANNERS.length];
        if ((groups.get(planner) ?? 0) >= groupCap(online, planner)) continue;
        taken.add(name);
        if (!available(name)) {
            reserved.push(name);
            continue;
        }
        entries.push({ slot, name, planner });
        groups.set(planner, (groups.get(planner) ?? 0) + 1);
    }
    let topUp = 0;
    if (size > 0) {
        for (let first = 0; first < PLANNERS.length; first++) {
            const planner = PLANNERS[first];
            const place = Math.floor(poolShare(online, planner)) - 1;
            for (let slot = first; slot < BOT_NAMES.length && (groups.get(planner) ?? 0) < place; slot += PLANNERS.length) {
                const name = BOT_NAMES[slot];
                if (taken.has(name) || used(name)) continue;
                taken.add(name);
                if (!available(name)) {
                    reserved.push(name);
                    continue;
                }
                entries.push({ slot, name, planner });
                groups.set(planner, (groups.get(planner) ?? 0) + 1);
                topUp++;
            }
        }
    }
    entries.sort((a, b) => a.slot - b.slot);
    return { entries, reserved, topUp };
}

/** Names for newcomers: the first name in the list that no bot has had and no human has, with a levelling planner. */
export class NameSource {
    private next = 0;
    constructor(private readonly unusable: (name: string) => boolean) {}

    take(): RosterEntry | null {
        for (; this.next < BOT_NAMES.length; this.next++) {
            const slot = this.next;
            const name = BOT_NAMES[slot];
            const planner = PLANNERS[slot % PLANNERS.length];
            if (!isLevelling(planner) || this.unusable(name)) continue;
            this.next++;
            return { slot, name, planner, newcomer: true };
        }
        return null;
    }

    /** Names left for newcomers (for the status line and the tests). */
    remaining(): number {
        let n = 0;
        for (let slot = this.next; slot < BOT_NAMES.length; slot++) {
            if (isLevelling(PLANNERS[slot % PLANNERS.length]) && !this.unusable(BOT_NAMES[slot])) n++;
        }
        return n;
    }
}
