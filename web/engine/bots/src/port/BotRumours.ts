// port (bots ideas, round 2, theme D: word that travels, D1): rumours that move some bots. Before, word of mouth was talk only: the director's 4 rumour lines an event came from
// any free bot 20-150 tiles off, which "knew" by magic, and nobody was sent anywhere. Now a rumour is a thing a set of bots
// know, that passes by hearing and by clique "PMs", fades and changes as it goes, and a share of its knowers act on it.
//
//   Seeds (real events only; in memory, session-only):
//     party   the director's drop party and Party Room, and theme C's 99 party, mini party and wedding (the bus's
//             set-piece, ninety-nine-near, own-party, wedding): the host (its subject: never told as hearsay by it), its
//             recruits, the bots within 20 tiles; to its end + 5 minutes. A 99 to come: the bot's clique mates within 300
//             tiles ("the PM") and the bots within 15
//     pk      a PK team raid (the director's pk_raid); a levelling bot killed in the Wilderness by a PKer bot (the bus's
//             kill: the victim, half the time); 20 minutes
//     rocks   a miner that gives up its wait at a full mine ("{ore} all taken at {mine}"), one alone at a mine ("{ore} free
//             at {mine}", now and then); 15 minutes
//     drop    a bot's rune or dragon drop (the bus's event: rune-drop, a dragon item's drop): the dropper and the bots within
//             15; 10 minutes, talk only (the dropper never tells it as hearsay)
//     scam, clan, duel  the director's other pieces: knowers only, so its tellings come from them; talk only, as today
//   No rumour is about the human: no kind has the human as its subject, no place comes from the human's position, and only
//   bots know them (a knower is a bot; the human hears the tellings).
//
//   Spread:
//     hearing  a telling (a line whose 'said' event carries the rumour's tag: the director's, a knower's own) teaches the
//              bots within 15 tiles on its floor, each with chance 0.6 + 0.3 x curiosity (port/BotPersona)
//     PM       a bot that learns it (not by PM) passes it to each online clique mate with chance 0.5: no line, no packet
//              (a client's invisible act with no game outcome); acquaintances do not (not on each other's friend lists)
//     telling  when a knower's own idle line is due (port/BotChatter.sayDue, its block), it says the rumour instead with
//              chance 0.5 x its freshness (1 at birth, 0 at its end) and the knower's interest (halving every 10 minutes):
//              LineKind 'rumour' (out of H7, in X2), the due line's place (sayArcLine 'slot'); at most 2 tellings a knower,
//              10 a rumour at 100 online (30 at 500), one telling a map square per 2 minutes, never within 20 tiles of a
//              party's venue, the registry's freshness (port/BotLines)
//     caps     25 knowers a rumour at 100 online, 80 at 500
//     distortion  a retelling takes another version with chance 0.15: a neighbouring place (fally park → fally west bank),
//              an exaggeration ("huge dp"), a time ("dp in 10 min"); 10 % of the knowers acting on a party with a wrong
//              place walk there, say "wheres the dp??" (budgeted) and resume their plans (WordWalkTask)
//     decay    after its end a rumour is gone, but for a late "missed the dp lol" now and then (own slot, 0.2, at most 3)
//   The director (its block in port/BotDirector): its 4 tellings come from knowers among the bots 20-150 tiles from the venue,
//   else from its own pick, made a knower ("heard it from a friend"); the near-human telling (50 % an event, unchanged)
//   prefers a knower. Their lines carry the rumour's tag, so the bots near learn it.
//
//   Acting:
//     party  free levelling and social knowers within 200 tiles that can be at the drop in time (PartyRun.latestFor) join
//            with chance 0.2 + 0.4 x sociability as word guests (PartyRun.addWordGuest: at most 10 a party, past its cap)
//     pk     a Wilderness trip within 30 tiles of the place is skipped for 30 minutes (port/BotWildTrips' block); a knower on
//            such a trip there turns back (its trip ends)
//     rocks  a miner of that ore avoids the full mine for 20 minutes, and goes to a free one half the time (tasks/MiningTask's
//            block, at its walk's start)
//   "where?", "when?", "real?" asked of a knower within 3 minutes of its telling: an answer from the rumour (port/BotAnswers'
//   block): "fally park", "like 5 min", "idk thats what i heard".
//
// Dice: theme D's own (port/BotWordHooks wordRoll: seeded from Math.random, so D's rolls never move the world's other
// draws; the tests set the chances: setRumoursForTest). No wall clock: world ticks. Per
// tick nothing; a telling's hearing is one zone scan of 15 tiles; the pass every 10 ticks walks the live rumours (a few).
import type Player from '#/engine/entity/Player.js';
import ObjType from '#/cache/config/ObjType.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { Locations, SkillProgression, type SkillStep } from '#/engine/bot/BotKnowledge.js';
import { BotTask, StuckDetector, walkTo, getBaseLevel, PlayerStat } from '#/engine/bot/tasks/BotTaskBase.js';
import { onArcs, provideArcs, registerArcsTick, type ArcTag } from '#/engine/bot/port/BotArcsEvents.js';
import { arcLines, fillArcSlots, sayArcLine } from '#/engine/bot/port/BotArcsSay.js';
import { cliqueOf } from '#/engine/bot/port/BotCliques.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { wordGuestFree } from '#/engine/bot/port/BotParty.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { eventRoleOf, type SetPieceRun } from '#/engine/bot/port/BotSetPieces.js';
import { itemSay, placeAt } from '#/engine/bot/port/BotSlots.js';
import { botPersona } from '#/engine/bot/port/BotTiming.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { wordHooks, wordRandInt, wordRoll } from '#/engine/bot/port/BotWordHooks.js';

// ── the defaults ───────────────────────────────────────────────────────────────────────────────────

/** a telling teaches a bot within this many tiles on its floor, with chance HEAR_BASE + HEAR_CURIOSITY x curiosity */
export const HEAR_TILES = 15;
export const HEAR_BASE = 0.6;
export const HEAR_CURIOSITY = 0.3;
/** a bot that learns a rumour passes it to each online clique mate with this chance (a PM: no line) */
export const PM_CHANCE = 0.5;
/** a knower's due idle line is the rumour with this chance x its freshness and interest */
export const TELL_CHANCE = 0.5;
/** at most this many tellings a knower, and a rumour's (10 at 100 online, 30 at 500), a map square's one per this long */
export const TELLS_A_KNOWER = 2;
export const TELLS_A_RUMOUR: readonly [number, number] = [10, 30];
export const SQUARE_GAP = 200;
/** at most this many knowers a rumour (25 at 100 online, 80 at 500) */
export const KNOWERS_A_RUMOUR: readonly [number, number] = [25, 80];
/** a retelling takes another version this often */
export const DISTORT_CHANCE = 0.15;
/** of the knowers acting on a party with a wrong place, this share walk there */
export const WRONG_PLACE_SHARE = 0.1;
/** a knower's interest halves every this many ticks (10 minutes) */
export const INTEREST_HALF = 1000;
/** party: knowers within this of the drop join with chance JOIN_BASE + JOIN_SOCIABLE x sociability */
export const JOIN_RANGE = 200;
export const JOIN_BASE = 0.2;
export const JOIN_SOCIABLE = 0.4;
/** pk: a Wilderness trip within this of the place is skipped (30 minutes from learning it) */
export const PK_AVOID_TILES = 30;
export const PK_AVOID_TICKS = 3000;
/** rocks: the full mine avoided this long (20 minutes from learning it); a free one preferred this often */
export const ROCKS_AVOID_TICKS = 2000;
export const ROCKS_FREE_CHANCE = 0.5;
/** a lone miner tells of its free rocks now and then (at its arrival at the mine) */
export const ROCKS_FREE_SEED = 0.05;
/** the rumours' lives (ticks): a party to its end + this, pk, rocks, drop */
export const LIFE = { partyAfter: 500, pk: 2000, rocks: 1500, drop: 1000, other: 200 } as const;
/** a late "missed the dp lol": this chance a knower that did not come, at most this many a party */
export const MISSED_CHANCE = 0.2;
export const MISSED_MOST = 3;
/** a party's knowers at its start: the bots within this of the venue */
const SEED_NEAR = 20;
/** a 99 to come: the clique mates within this get the PM, the bots within SEED_NEAR_99 hear it */
const MATES_99 = 300;
const SEED_NEAR_99 = 15;
/** a telling never this near its party's venue (they are there: no word needed) */
const TELL_AWAY = 20;
/** "where?" answered this long after the bot's telling */
const ANSWER_TICKS = 300;
/** the live rumours at most (the oldest go first) */
const RUMOURS_MOST = 200;
const LOG_MOST = 500;

// ── the kinds, places and words ──────────────────────────────────────────────────────────────────────────────────

export type RumourKind = 'party' | 'pk' | 'rocks' | 'drop' | 'scam' | 'clan' | 'duel';

/** the set pieces' kinds as rumours */
const PIECE_KIND: Readonly<Record<string, RumourKind>> = {
    drop_party: 'party',
    party_room: 'party',
    ninety_nine: 'party',
    mini_party: 'party',
    wedding: 'party',
    pk_raid: 'pk',
    clan_walk: 'clan',
    scam_spree: 'scam',
    fake_dp: 'scam',
    duel_stake: 'duel'
};

interface Place {
    say: string;
    x: number;
    z: number;
    r: number;
}

/** a party venue's neighbours: where a distorted telling puts it (the wrong-place walk goes there) */
const NEIGHBOURS: Readonly<Record<string, readonly Place[]>> = {
    falador_park: [
        { say: 'fally west bank', x: 2946, z: 3370, r: 4 },
        { say: 'fally east bank', x: 3013, z: 3358, r: 4 }
    ],
    varrock_square: [
        { say: 'varrock west bank', x: 3184, z: 3438, r: 4 },
        { say: 'varrock east bank', x: 3253, z: 3424, r: 4 }
    ],
    lumbridge_courtyard: [
        { say: 'draynor bank', x: 3093, z: 3246, r: 4 },
        { say: 'lumby swamp', x: 3227, z: 3180, r: 4 }
    ],
    party_room: [
        { say: 'seers bank', x: 2725, z: 3490, r: 4 },
        { say: 'camelot', x: 2757, z: 3480, r: 4 }
    ]
};

/** the Wilderness's places as players named them (a pk rumour's {place}); farther out by level */
const WILD_PLACES: readonly Place[] = [
    { say: 'greens', x: 3098, z: 3814, r: 25 },
    { say: 'hill giants', x: 3302, z: 3655, r: 25 },
    { say: 'hobgobs', x: 3088, z: 3761, r: 20 },
    { say: 'lesser demons', x: 3015, z: 3850, r: 20 },
    { say: 'the skeletons', x: 3016, z: 3592, r: 20 },
    { say: 'the graveyard', x: 3160, z: 3670, r: 25 },
    { say: 'the lava maze', x: 3070, z: 3855, r: 30 },
    { say: 'the ruins', x: 3290, z: 3882, r: 25 },
    { say: 'mage bank', x: 3095, z: 3955, r: 25 },
    { say: 'the chaos temple', x: 3239, z: 3610, r: 15 },
    { say: 'varrock wildy', x: 3240, z: 3560, r: 30 },
    { say: 'edge', x: 3093, z: 3530, r: 25 }
];
const WILD_DEPTH: readonly [number, string][] = [
    [10, 'low wildy'],
    [30, 'mid wildy'],
    [99, 'deep wildy']
];

/** the mines as players named them (a rocks rumour's {mine}) */
const MINES: readonly Place[] = [
    { say: 'lumby swamp', x: Locations.MINE_LUMBRIDGE_SWAMP[0], z: Locations.MINE_LUMBRIDGE_SWAMP[1], r: 15 },
    { say: 'al kharid mine', x: Locations.MINE_AL_KHARID[0], z: Locations.MINE_AL_KHARID[1], r: 25 },
    { say: 'varrock east mine', x: Locations.MINE_VARROCK_EAST[0], z: Locations.MINE_VARROCK_EAST[1], r: 15 },
    { say: 'varrock west mine', x: Locations.MINE_VARROCK_WEST[0], z: Locations.MINE_VARROCK_WEST[1], r: 15 },
    { say: 'barb mine', x: Locations.MINE_DWARVEN[0], z: Locations.MINE_DWARVEN[1], r: 15 },
    { say: 'karamja', x: Locations.MINE_KARAMJA[0], z: Locations.MINE_KARAMJA[1], r: 20 },
    { say: 'rimmington', x: Locations.MINE_RIMMINGTON[0], z: Locations.MINE_RIMMINGTON[1], r: 20 },
    { say: 'the dwarf mine', x: Locations.MINE_DWARVEN_SOUTH[0], z: Locations.MINE_DWARVEN_SOUTH[1], r: 30 },
    { say: 'the dwarf mine', x: Locations.MINE_DWARVEN_NORTH[0], z: Locations.MINE_DWARVEN_NORTH[1], r: 30 },
    { say: 'the mining guild', x: Locations.MINE_MINING_GUILD[0], z: Locations.MINE_MINING_GUILD[1], r: 20 }
];

/** an ore as players named it (a rocks rumour's {ore}), by the item a mining step gains */
function oreSay(item: number | undefined): string | null {
    if (item === undefined) return null;
    const name = (ObjType.get(item)?.debugname ?? '').toLowerCase();
    const map: Readonly<Record<string, string>> = { copper_ore: 'copper', tin_ore: 'tin', iron_ore: 'iron', coal: 'coal', silver_ore: 'silver', gold_ore: 'gold', mithril_ore: 'mith', adamantite_ore: 'addy', runite_ore: 'rune', clay: 'clay', blankrune: 'ess' };
    return map[name] ?? null;
}

const cheb = (ax: number, az: number, bx: number, bz: number): number => Math.max(Math.abs(ax - bx), Math.abs(az - bz));

function nearestPlace(list: readonly Place[], x: number, z: number): Place | null {
    let best: Place | null = null;
    let depth = Infinity;
    for (const p of list) {
        const d = cheb(x, z, p.x, p.z) / p.r;
        if (d <= 1 && d < depth) {
            best = p;
            depth = d;
        }
    }
    return best;
}

/** a Wilderness place's word ("greens", "low wildy"), or null outside it */
export function wildPlaceSay(x: number, z: number): string | null {
    const lvl = wildernessLevelAt(x, z);
    if (lvl <= 0) return null;
    return nearestPlace(WILD_PLACES, x, z)?.say ?? WILD_DEPTH.find(([max]) => lvl <= max)![1];
}

/** a mine's word ("barb mine"), or null */
export function mineSay(x: number, z: number): string | null {
    return nearestPlace(MINES, x, z)?.say ?? null;
}

/** every word a rumour's slots can take, by slot (test/chat-filter.test.mjs checks every form of every line with them) */
export function wordSlotValues(): Record<string, string[]> {
    const place = new Set<string>();
    for (const list of Object.values(NEIGHBOURS)) for (const p of list) place.add(p.say);
    for (const p of WILD_PLACES) place.add(p.say);
    for (const [, say] of WILD_DEPTH) place.add(say);
    for (const say of ['fally park', 'varrock square', 'lumby castle', 'the seers party room', 'varrock church', 'lumby church']) place.add(say);
    for (const say of ['lumby', 'varrock', 'fally', 'draynor', 'edge', 'al kharid', 'karamja', 'port sarim', 'rimmington', 'barb village', 'catherby', 'seers', 'ardy', 'yanille', 'camelot', 'taverley']) place.add(say);
    return {
        place: [...place],
        mine: [...new Set(MINES.map(m => m.say))],
        ore: ['copper', 'tin', 'iron', 'coal', 'silver', 'gold', 'mith', 'addy', 'rune', 'clay', 'ess'],
        mins: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
        item: dropItemSays(),
        skill: SKILL_SAYS.filter((s): s is string => s !== null)
    };
}

/** a skill's word for a 99, by its stat (PlayerStat order) */
const SKILL_SAYS: readonly (string | null)[] = ['att', 'def', 'str', 'hp', 'range', 'pray', 'mage', 'cooking', 'wc', 'fletching', 'fishing', 'fm', 'crafting', 'smithing', 'mining', 'herblore', 'agility', 'thieving', null, null, 'rc'];

/** every rune and dragon item's word a drop rumour's {item} may take (port/BotSlots itemSay of the tradeable ones) */
export function dropItemSays(): string[] {
    const out = new Set<string>();
    for (let id = 0; id < ObjType.count; id++) {
        const t = ObjType.get(id);
        const name = t?.debugname ?? '';
        if (!t || !t.tradeable || t.certtemplate !== -1 || !/^(rune|dragon)_/.test(name) || t.wearpos === -1) continue;
        const say = itemSay(t.name ?? '');
        if (say && /^(rune|dragon) /.test(say)) out.add(say);
    }
    return [...out];
}

// ── the records ──────────────────────────────────────────────────────────────────────────────────────────────────

interface Version {
    /** its {place} and where that is */
    place: string;
    x: number;
    z: number;
    /** its pool (port/BotArcsSay arcLines('word-rumour', pool)) */
    pool: string;
    distorted: boolean;
}

type Via = 'seed' | 'heard' | 'pm' | 'friend';
type Act = 'guest' | 'wrong' | 'turned' | null;

interface Knowledge {
    at: number;
    version: number;
    told: number;
    via: Via;
    acted: Act;
}

/** what a rumour did (the humanlike runner's WT metrics, the tests) */
export interface RumourRecord {
    id: number;
    kind: RumourKind;
    sub: string;
    place: string;
    x: number;
    z: number;
    born: number;
    until: number;
    source: string;
    /** online at its birth */
    online: number;
    knowers: number;
    via: Record<Via, number>;
    tellings: number;
    distorted: number;
    versions: number;
    /** party: knowers free and in range when they learnt it, and those who acted (came as word guests, or went wrong) */
    eligible: number;
    acted: number;
    wordGuests: { name: string; from: number; at: number; came: boolean }[];
    wrong: { name: string; place: string; at: number; arrived: boolean; line: boolean; end: number }[];
    fake: number;
    missed: number;
    /** a party: all its guests who came (asked, walk-ins, word guests: its PartyRecord's), at the last look */
    guestsCame: number;
    /** pk: trips skipped and turned back; rocks: miners sent elsewhere */
    avoided: number;
    turned: number;
    moved: number;
    /** the names of the knowers (bots only: WT10 checks that no human is one) */
    names: string[];
}

export interface Rumour {
    id: number;
    kind: RumourKind;
    sub: string;
    x: number;
    z: number;
    level: number;
    born: number;
    until: number;
    /** a party's run (word guests), the director's piece */
    run: SetPieceRun | null;
    /** the bot it is about (a dropper, a 99er, a party's host): it never tells it as hearsay */
    subject: string | null;
    /** the others in it from the start (a run's parts but its guests and crowd: a raid's team, a scam's callers, a
     *  wedding's couple): they never tell it as hearsay either, nor miss it */
    insiders: ReadonlySet<string>;
    slots: Record<string, string>;
    versions: Version[];
    tellings: number;
    knowers: Map<Player, Knowledge>;
    record: RumourRecord;
    /** the ore and mine of a rocks rumour ('full' or 'free') */
    ore?: number;
}

let nextId = 1;
const rumours = new Map<number, Rumour>();
/** each bot's rumours (the ones it knows) */
let known = new WeakMap<Player, Set<Rumour>>();
/** a run's rumour */
const byRun = new WeakMap<SetPieceRun, Rumour>();
/** the map square's last telling (world tick) */
const squareTold = new Map<number, number>();
/** a bot's last telling: which rumour and version, when (its "where?" answer) */
let lastTold = new WeakMap<Player, { r: Rumour; version: number; at: number }>();
/** a bot's pk places to avoid (until a world tick), and its full mines */
let avoid = new WeakMap<Player, { x: number; z: number; until: number; kind: 'pk' | 'full'; ore?: number }[]>();

/** what the rumours did (the humanlike runner, the tests): the records, newest last (capped), and the counts */
export const rumourLog: RumourRecord[] = [];
export const rumourStats = { seeded: 0, learnt: 0, heard: 0, pm: 0, friend: 0, tellings: 0, directorTellings: 0, nearHuman: 0, answers: 0, wordGuests: 0, wrongWalks: 0 };

// ── tests ────────────────────────────────────────────────────────────────────────────────────────────────────────

const DEFAULT_RATES = { on: true, knowers: 0, hear: HEAR_BASE, curiosity: HEAR_CURIOSITY, pm: PM_CHANCE, tell: TELL_CHANCE, distort: DISTORT_CHANCE, wrong: WRONG_PLACE_SHARE, join: JOIN_BASE, joinSociable: JOIN_SOCIABLE, missed: MISSED_CHANCE, freeSeed: ROCKS_FREE_SEED, freePick: ROCKS_FREE_CHANCE, pkSeed: 0.5 };
/** the rates in use (the defaults; tests change them: setRumoursForTest) */
export const rumourRates = { ...DEFAULT_RATES };

/** Tests only: other rates or rumours off (null: the defaults). Never set by the game. */
export function setRumoursForTest(rates: Partial<typeof DEFAULT_RATES> | null): void {
    Object.assign(rumourRates, DEFAULT_RATES, rates ?? {});
}

/** Tests only: every rumour forgotten. */
export function resetRumoursForTest(): void {
    rumours.clear();
    known = new WeakMap();
    lastTold = new WeakMap();
    avoid = new WeakMap();
    squareTold.clear();
    rumourLog.length = 0;
    for (const k of Object.keys(rumourStats) as (keyof typeof rumourStats)[]) rumourStats[k] = 0;
}

// ── the bots ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** the bots within `r` tiles of (x, z) on `level` (the zones there), not `except` */
function botsWithin(x: number, z: number, level: number, r: number, except: Player | null = null): Player[] {
    const out: Player[] = [];
    for (let zx = (x - r) >> 3; zx <= (x + r) >> 3; zx++) {
        for (let zz = (z - r) >> 3; zz <= (z + r) >> 3; zz++) {
            for (const p of World.gameMap.getZone(zx << 3, zz << 3, level).getAllPlayersSafe()) {
                if (p !== except && p.is_bot === true && p.slot !== -1 && p.level === level && cheb(p.x, p.z, x, z) <= r) out.push(p);
            }
        }
    }
    return out;
}

let namesTick = -1;
const byName = new Map<string, Player>();
/** an online bot by its name (the world's bots, read once a tick when asked) */
function botNamed(name: string): Player | null {
    const now = World.currentTick;
    if (namesTick !== now) {
        namesTick = now;
        byName.clear();
        for (const p of BotManager.activeBots()) byName.set(p.username, p);
    }
    const p = byName.get(name);
    return p && p.slot !== -1 ? p : null;
}

function onlineCount(): number {
    let n = 0;
    for (const _ of BotManager.activeBots()) n++;
    return n;
}

/** a cap scaled with the bots online: lo at 100 or fewer, hi at 500 or more */
function scaled([lo, hi]: readonly [number, number], online: number): number {
    return Math.round(lo + (hi - lo) * Math.max(0, Math.min(1, (online - 100) / 400)));
}

// ── a rumour's life ──────────────────────────────────────────────────────────────────────────────────────────────

function newRumour(kind: RumourKind, sub: string, at: { x: number; z: number; level: number; say: string }, life: number, source: string, opts: { run?: SetPieceRun | null; subject?: string | null; insiders?: Iterable<string>; slots?: Record<string, string>; pool?: string; ore?: number } = {}): Rumour {
    const now = World.currentTick;
    // (the oldest live one goes when there are too many)
    if (rumours.size >= RUMOURS_MOST) {
        const oldest = rumours.values().next().value as Rumour | undefined;
        if (oldest) release(oldest);
    }
    const online = onlineCount();
    const id = nextId++;
    const record: RumourRecord = { id, kind, sub, place: at.say, x: at.x, z: at.z, born: now, until: now + life, source, online, knowers: 0, via: { seed: 0, heard: 0, pm: 0, friend: 0 }, tellings: 0, distorted: 0, versions: 1, eligible: 0, acted: 0, wordGuests: [], wrong: [], fake: 0, missed: 0, guestsCame: 0, avoided: 0, turned: 0, moved: 0, names: [] };
    const r: Rumour = { id, kind, sub, x: at.x, z: at.z, level: at.level, born: now, until: now + life, run: opts.run ?? null, subject: opts.subject ?? null, insiders: new Set(opts.insiders ?? []), slots: opts.slots ?? {}, versions: [{ place: at.say, x: at.x, z: at.z, pool: opts.pool ?? kind, distorted: false }], tellings: 0, knowers: new Map(), record, ore: opts.ore };
    rumours.set(id, r);
    if (opts.run) byRun.set(opts.run, r);
    rumourLog.push(record);
    if (rumourLog.length > LOG_MOST) rumourLog.shift();
    rumourStats.seeded++;
    return r;
}

function live(r: Rumour, now: number = World.currentTick): boolean {
    return now < r.until && rumours.has(r.id);
}

/**
 * A rumour is gone (its end, or the oldest of too many): out of the live ones and its knowers' sets, its knowers and its
 * run let go. A teller's last telling ("where?") or a run's entry (byRun, weak) may still hold the record a while: it then
 * holds no Player and no run (1000 bots: a long session's teller pinned every knower's Player, logged out or not)
 */
function release(r: Rumour): void {
    rumours.delete(r.id);
    for (const p of r.knowers.keys()) known.get(p)?.delete(r);
    r.knowers.clear();
    r.run = null;
}

/** 1 at its birth, 0 at its end */
function freshness(r: Rumour, now: number): number {
    return Math.max(0, Math.min(1, (r.until - now) / Math.max(1, r.until - r.born)));
}

/** The bot learns the rumour (the version it heard), by `via`; its clique mates by PM (not after a PM); then it may act. */
function learn(p: Player, r: Rumour, version: number, via: Via): boolean {
    if (!rumourRates.on || p.is_bot !== true || p.slot === -1 || r.knowers.has(p) || !live(r)) return false;
    if (r.knowers.size >= (rumourRates.knowers || scaled(KNOWERS_A_RUMOUR, r.record.online))) return false;
    const now = World.currentTick;
    const k: Knowledge = { at: now, version, told: 0, via, acted: null };
    r.knowers.set(p, k);
    let set = known.get(p);
    if (!set) known.set(p, (set = new Set()));
    set.add(r);
    r.record.knowers++;
    r.record.via[via]++;
    if (r.record.names.length < 200) r.record.names.push(p.username);
    rumourStats.learnt++;
    if (via === 'heard') rumourStats.heard++;
    else if (via === 'pm') rumourStats.pm++;
    else if (via === 'friend') rumourStats.friend++;
    if (via !== 'pm') {
        for (const name of cliqueOf(p.username) ?? []) {
            if (name === p.username) continue;
            const mate = botNamed(name);
            if (mate && wordRoll() < rumourRates.pm) learn(mate, r, version, 'pm');
        }
    }
    act(p, r, k);
    return true;
}

/** the bot's live rumours (its set pruned) */
function knownBy(p: Player, now: number): Rumour[] {
    const set = known.get(p);
    if (!set) return [];
    const out: Rumour[] = [];
    for (const r of set) {
        if (live(r, now)) out.push(r);
        else if (now >= r.until + 6000 || !rumours.has(r.id)) set.delete(r);
    }
    return out;
}

/**
 * (theme C asks: port/BotArcsEvents arcsKnows) does the bot know a live rumour of this kind ('party', 'pk', 'rocks',
 * 'drop', or a party's sub-kind: 'ninety_nine', 'wedding' ...)? A kind with a bot's name, 'ninety_nine:<name>': that
 * bot's rumour of the kind only (its subject: the 99er, the host), so a 99's guest list finds the knowers of this 99
 * and not of another bot's
 */
export function knowsRumour(bot: Player, kind: string): boolean {
    const now = World.currentTick;
    const at = kind.indexOf(':');
    if (at < 0) return knownBy(bot, now).some(r => r.kind === kind || r.sub === kind);
    const what = kind.slice(0, at);
    const who = kind.slice(at + 1);
    return knownBy(bot, now).some(r => (r.kind === what || r.sub === what) && r.subject === who);
}

// ── seeds ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** a director's run (or a theme C piece's) begins: its rumour, known by its roles and the bots near its venue */
function seedRun(run: SetPieceRun, source: string, opts: { subject?: string | null; insiders?: Iterable<string>; slots?: Record<string, string>; pool?: string } = {}): Rumour | null {
    const kind = PIECE_KIND[run.kind];
    if (!kind || byRun.has(run)) return byRun.get(run) ?? null;
    const v = run.venue;
    const now = World.currentTick;
    const life = kind === 'party' ? Math.max(300, run.endsBy - now) + LIFE.partyAfter : kind === 'pk' ? LIFE.pk : Math.max(300, run.endsBy - now) + LIFE.other;
    const pool = opts.pool ?? (kind === 'party' ? (run.kind === 'wedding' ? 'wedding' : 'party') : kind);
    // (its host is its subject, the director's parties too; its other parts at the start are insiders: none of them tells
    // it as hearsay, "heard theres a dp at fally park" from the bot banking for its kit)
    const host = (run as { host?: Player }).host ?? null;
    const insiders = new Set(opts.insiders ?? []);
    for (const [p, role] of run.roles) if (role !== 'guest' && role !== 'crowd') insiders.add(p.username);
    const r = newRumour(kind, run.kind, { x: v.x, z: v.z, level: v.level, say: v.say }, life, source, { run, subject: opts.subject ?? host?.username ?? null, insiders, slots: opts.slots, pool });
    for (const p of run.roles.keys()) learn(p, r, 0, 'seed');
    for (const p of botsWithin(v.x, v.z, v.level, SEED_NEAR)) learn(p, r, 0, 'seed');
    return r;
}

/** a run is over: its rumour ends soon after (a party 5 minutes on) */
function runDone(run: SetPieceRun): void {
    const r = byRun.get(run);
    if (!r) return;
    const now = World.currentTick;
    r.until = Math.min(r.until, now + (r.kind === 'party' ? LIFE.partyAfter : LIFE.other));
    r.record.until = r.until;
}

/** a levelling bot killed in the Wilderness by a PKer bot: a pk rumour (the victim knows it), or the one there already */
function seedKill(killer: Player, victim: Player): void {
    if (killer.is_bot !== true || victim.is_bot !== true || !isLevelling(victim.botPlanner as PlannerKey)) return;
    const x = killer.x;
    const z = killer.z;
    const say = wildPlaceSay(x, z);
    if (say === null || wordRoll() >= rumourRates.pkSeed) return;
    const now = World.currentTick;
    const there = [...rumours.values()].find(r => r.kind === 'pk' && live(r, now) && cheb(r.x, r.z, x, z) <= PK_AVOID_TILES);
    const r = there ?? newRumour('pk', 'kill', { x, z, level: killer.level, say }, LIFE.pk, 'kill', { pool: 'pk' });
    learn(victim, r, 0, 'seed');
}

/** a rune or dragon drop: a drop rumour (the dropper and the bots near know it; the dropper never tells it as hearsay) */
function seedDrop(bot: Player, item: string): void {
    const at = placeAt(bot.x, bot.z, bot.level) ?? null;
    const say = at?.say ?? wildPlaceSay(bot.x, bot.z);
    if (!say) return;
    const r = newRumour('drop', 'drop', { x: bot.x, z: bot.z, level: bot.level, say }, LIFE.drop, 'drop', { subject: bot.username, slots: { item }, pool: 'drop' });
    learn(bot, r, 0, 'seed');
    for (const p of botsWithin(bot.x, bot.z, bot.level, HEAR_TILES, bot)) learn(p, r, 0, 'seed');
}

/** theme C's 99 to come: a party rumour of its own (no run yet), the bot's clique mates (PM) and the bots near it know */
function seedNinetyNine(bot: Player, skill: string, venue: { x: number; z: number; level: number; say?: string }): void {
    const say = venue.say ?? placeAt(venue.x, venue.z, venue.level)?.say ?? mineSay(venue.x, venue.z);
    if (!say) return;
    const r = newRumour('party', 'ninety_nine', { x: venue.x, z: venue.z, level: venue.level, say }, 3000, 'ninety-nine-near', { subject: bot.username, slots: { skill }, pool: 'ninety-nine' });
    learn(bot, r, 0, 'seed');
    for (const name of cliqueOf(bot.username) ?? []) {
        const mate = name === bot.username ? null : botNamed(name);
        if (mate && cheb(mate.x, mate.z, venue.x, venue.z) <= MATES_99) learn(mate, r, 0, 'pm');
    }
    for (const p of botsWithin(venue.x, venue.z, venue.level, SEED_NEAR_99, bot)) learn(p, r, 0, 'seed');
}

/** a rocks rumour (a miner's word): its mine full, or free rocks there */
function seedRocks(bot: Player, step: SkillStep, what: 'full' | 'free'): void {
    if (!rumourRates.on) return;
    const [x, z, level] = step.location;
    const ore = oreSay(step.itemGained);
    const mine = mineSay(x, z);
    if (!ore || !mine || level !== 0 || wildernessLevelAt(x, z) > 0) return;
    const now = World.currentTick;
    // (one a mine and ore at a time: the miner learns the one there)
    const there = [...rumours.values()].find(r => r.kind === 'rocks' && r.sub === what && r.ore === step.itemGained && live(r, now) && cheb(r.x, r.z, x, z) <= 20);
    const r = there ?? newRumour('rocks', what, { x, z, level, say: mine }, LIFE.rocks, `rocks-${what}`, { slots: { ore, mine }, pool: what === 'full' ? 'rocks-full' : 'rocks-free', ore: step.itemGained });
    learn(bot, r, 0, 'seed');
}

// ── acting ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** a run that takes word guests (port/BotParty PartyRun's block) */
interface WordGuestRun extends SetPieceRun {
    addWordGuest(bot: Player, at?: number): boolean;
    latestFor(bot: Player): number;
    readonly venue: SetPieceRun['venue'] & { drop?: readonly [number, number] };
    readonly host?: Player;
}
function takesWordGuests(run: SetPieceRun | null): run is WordGuestRun {
    const r = run as Partial<WordGuestRun> | null;
    return !!r && typeof r.addWordGuest === 'function' && typeof r.latestFor === 'function';
}

/** a bot that may come to a party by word: a levelling bot (not a newbie) or a social regular, free now */
function mayCome(p: Player): boolean {
    const planner = p.botPlanner as PlannerKey;
    if (!((isLevelling(planner) && !isNewbie(p)) || planner === 'extras_social')) return false;
    if (p.level !== 0 || wildernessLevelAt(p.x, p.z) > 0 || eventRoleOf(p) !== null) return false;
    return p.botTradeTargetPid === -1 && p.botComeHereReturnX === -1;
}

function act(p: Player, r: Rumour, k: Knowledge): void {
    if (r.kind === 'party') actOnParty(p, r, k);
    else if (r.kind === 'pk') turnBack(p, r, k);
}

function actOnParty(p: Player, r: Rumour, k: Knowledge): void {
    const run = r.run;
    if (!takesWordGuests(run) || run.roles.has(p) || run.host === p || insider(p, r)) return;
    if (run.phase !== 'announce' && run.phase !== 'build') return;
    const [dx, dz] = run.venue.drop ?? [run.venue.x, run.venue.z];
    const now = World.currentTick;
    const d = cheb(p.x, p.z, dx, dz);
    // (at the venue already: a walk-in's, not a word guest's; out of range or too late: no)
    if (d <= 15 || d > JOIN_RANGE || !mayCome(p) || run.latestFor(p) < now + 5) return;
    r.record.eligible++;
    if (wordRoll() >= rumourRates.join + rumourRates.joinSociable * botPersona(p).sociability) return;
    const v = r.versions[k.version];
    // (a wrong place heard: now and then it goes there, finds nobody and says so)
    if (v && v.distorted && (v.x !== r.x || v.z !== r.z) && wordRoll() < rumourRates.wrong && wrongWalk(p, r, v)) {
        k.acted = 'wrong';
        r.record.acted++;
        return;
    }
    if (!run.addWordGuest(p, now + wordRandInt(3, 15))) return;
    k.acted = 'guest';
    r.record.acted++;
    r.record.wordGuests.push({ name: p.username, from: d, at: now, came: false });
    rumourStats.wordGuests++;
}

/** a knower on a Wilderness trip near the pk place turns back (its trip ends); the trips there skipped a while */
function turnBack(p: Player, r: Rumour, k: Knowledge): void {
    const now = World.currentTick;
    let list = avoid.get(p);
    if (!list) avoid.set(p, (list = []));
    list.push({ x: r.x, z: r.z, until: now + PK_AVOID_TICKS, kind: 'pk' });
    if (list.length > 8) list.shift();
    if (wildernessLevelAt(p.x, p.z) <= 0 || cheb(p.x, p.z, r.x, r.z) > PK_AVOID_TILES || p.username === r.subject) return;
    const task = BotManager.botFor(p)?.currentTask ?? null;
    if (!task || !/^Wild(Trip|Mine):/.test(task.name)) return;
    task.interrupt();
    k.acted = 'turned';
    r.record.turned++;
}

/** a pk place the bot knows of near (x, z): its Wilderness trip there is skipped */
function avoidsWild(p: Player, x: number, z: number): boolean {
    if (!rumourRates.on) return false;
    const now = World.currentTick;
    const list = avoid.get(p);
    const hit = list?.find(a => a.kind === 'pk' && a.until > now && cheb(a.x, a.z, x, z) <= PK_AVOID_TILES);
    if (!hit) return false;
    const r = knownBy(p, now).find(x2 => x2.kind === 'pk' && x2.x === hit.x && x2.z === hit.z);
    if (r) r.record.avoided++;
    return true;
}

/** a miner's step at its walk's start: away from a full mine it heard of, to a free one now and then */
function rocksStep(p: Player, step: SkillStep): SkillStep | null {
    if (!rumourRates.on || step.itemGained === undefined) return null;
    const now = World.currentTick;
    const mine = knownBy(p, now).filter(r => r.kind === 'rocks' && r.ore === step.itemGained);
    if (mine.length === 0) return null;
    const level = getBaseLevel(p, PlayerStat.MINING);
    const members = isMembersWorld();
    const steps = (SkillProgression.MINING ?? []).filter(s => s.itemGained === step.itemGained && level >= s.minLevel && level <= s.maxLevel && s.location[2] === 0 && wildernessLevelAt(s.location[0], s.location[1]) <= 0 && (members || !(s as { members?: boolean }).members));
    const full = mine.filter(r => r.sub === 'full' && now - (r.knowers.get(p)?.at ?? now) < ROCKS_AVOID_TICKS);
    const atFull = (s: SkillStep): boolean => full.some(r => cheb(r.x, r.z, s.location[0], s.location[1]) <= 20);
    const free = mine.find(r => r.sub === 'free');
    if (free && wordRoll() < rumourRates.freePick) {
        const there = steps.find(s => cheb(free.x, free.z, s.location[0], s.location[1]) <= 20 && !atFull(s));
        if (there && there !== step) {
            free.record.moved++;
            return there;
        }
    }
    if (!atFull(step)) return null;
    const other = steps.filter(s => !atFull(s) && s !== step);
    if (other.length === 0) return null;
    const pick = other[Math.floor(wordRoll() * other.length)];
    full[0].record.moved++;
    return pick;
}

/** a lone miner at its mine (nobody else within 10 tiles): now and then a "free" rumour */
function rocksSeen(p: Player, step: SkillStep, what: 'full' | 'free'): void {
    // (off: no roll either: D's dice take their seed from the world's at their first roll, port/BotWordHooks)
    if (!rumourRates.on) return;
    if (what === 'free') {
        if (wordRoll() >= rumourRates.freeSeed) return;
        const [x, z, level] = step.location;
        if (botsWithin(x, z, level, 10, p).length > 0) return;
    }
    seedRocks(p, step, what);
}

// ── a wrong place (a distorted party's) ──────────────────────────────────────────────────────────────────────────

/** the walk to a wrong place: a look round, a word ("wheres the dp??"), back to its own doings (a sub-task) */
export class WordWalkTask extends BotTask {
    private stage: 'walk' | 'look' | 'done' = 'walk';
    private ticks = 0;
    private lookUntil = -1;
    private readonly stuck = new StuckDetector(30, 4, 2);
    readonly note: RumourRecord['wrong'][number];

    constructor(
        private readonly x: number,
        private readonly z: number,
        note: RumourRecord['wrong'][number],
        private readonly record: RumourRecord
    ) {
        super('WordWalk');
        this.note = note;
    }

    shouldRun(): boolean {
        return this.stage !== 'done';
    }

    isComplete(): boolean {
        return this.stage === 'done';
    }

    private finish(): void {
        if (this.stage === 'done') return;
        this.stage = 'done';
        this.note.end = World.currentTick;
    }

    tick(player: Player): void {
        if (this.stage === 'done') return;
        const now = World.currentTick;
        // (a long way or stuck: it gives up, as a player would; no jump)
        if (++this.ticks > 500 || player.level !== 0) return this.finish();
        if (this.stage === 'walk') {
            if (cheb(player.x, player.z, this.x, this.z) <= 4) {
                player.clearWaypoints();
                this.stage = 'look';
                this.note.arrived = true;
                this.lookUntil = now + wordRandInt(15, 40);
                return;
            }
            if (this.stuck.check(player, this.x, this.z)) {
                if (this.stuck.desperatelyStuck) return this.finish();
                walkTo(player, player.x + wordRandInt(-5, 5), player.z + wordRandInt(-5, 5));
                return;
            }
            if (!player.hasWaypoints() || this.ticks % 20 === 0) walkTo(player, this.x + wordRandInt(-2, 2), this.z + wordRandInt(-2, 2));
            return;
        }
        if (now < this.lookUntil) return;
        // ("wheres the dp??": budgeted, a line of its own in the place of its next)
        const said = sayArcLine(player, arcLines('word-fake'), {}, { kind: 'event', budget: 'budgeted', random: wordRoll });
        if (said !== null) {
            this.note.line = true;
            this.record.fake++;
        }
        this.finish();
    }
}

function wrongWalk(p: Player, r: Rumour, v: Version): boolean {
    const ai = BotManager.botFor(p);
    // (free as a word guest at its set-off is, port/BotParty wordGuestFree: unhurt, out of a fight with an NPC, not armed
    // for a random event, not delayed; else it comes as a word guest, if at all, under the party's own checks)
    if (!ai || ai.hasSubTask() || p.level !== 0 || !wordGuestFree(p)) return false;
    const note = { name: p.username, place: v.place, at: World.currentTick, arrived: false, line: false, end: -1 };
    ai.setSubTask(new WordWalkTask(v.x, v.z, note, r.record));
    r.record.wrong.push(note);
    rumourStats.wrongWalks++;
    return true;
}

// ── telling ──────────────────────────────────────────────────────────────────────────────────────────────────────

const squareOf = (x: number, z: number, level: number): number => ((level & 3) << 28) | ((x >> 6) << 14) | (z >> 6);

/** a distorted version for this telling: a neighbouring place, an exaggeration or a time (a new one, or one told before) */
function distort(r: Rumour, from: number): number {
    const base = r.versions[from] ?? r.versions[0];
    const options: Version[] = [];
    if (r.kind === 'party' && r.sub !== 'ninety_nine' && r.sub !== 'wedding') {
        const key = r.run?.venue.key ?? '';
        for (const n of NEIGHBOURS[key] ?? []) options.push({ place: n.say, x: n.x, z: n.z, pool: base.pool, distorted: true });
        options.push({ ...base, pool: 'party-big', distorted: true });
        options.push({ ...base, pool: 'party-soon', distorted: true });
    } else if (r.kind === 'pk') {
        options.push({ ...base, pool: 'pk-team', distorted: true });
    } else if (r.kind === 'drop') {
        options.push({ ...base, pool: 'drop-big', distorted: true });
    } else return from;
    const pick = options[Math.floor(wordRoll() * options.length)];
    const i = r.versions.findIndex(v => v.place === pick.place && v.pool === pick.pool);
    if (i >= 0) return i;
    r.versions.push(pick);
    r.record.versions = r.versions.length;
    return r.versions.length - 1;
}

/** a bot in the rumour's doings (its subject, an insider, a part in its run but a guest's or the crowd's): no hearsay */
function insider(bot: Player, r: Rumour): boolean {
    if (bot.username === r.subject || r.insiders.has(bot.username)) return true;
    const role = r.run?.roles.get(bot);
    return role !== undefined && role !== 'guest' && role !== 'crowd';
}

/** the pool a version's telling draws from (a pk rumour's victim tells its own: "got pked at {place}") */
function poolOf(r: Rumour, v: Version, k: Knowledge): readonly string[] {
    if (r.kind === 'pk' && r.sub === 'kill' && k.via === 'seed') return arcLines('word-rumour', 'pk-victim');
    return arcLines('word-rumour', v.pool);
}

/** The knower's due idle line: a rumour it knows, told instead (port/BotChatter's block). True: said. */
function tellDue(bot: Player, now: number): boolean {
    if (!rumourRates.on) return false;
    const rs = knownBy(bot, now);
    if (rs.length === 0) return false;
    const sq = squareOf(bot.x, bot.z, bot.level);
    if (now - (squareTold.get(sq) ?? -Infinity) < SQUARE_GAP) return false;
    let best: Rumour | null = null;
    let bestW = 0;
    for (const r of rs) {
        const k = r.knowers.get(bot);
        if (!k || k.told >= TELLS_A_KNOWER || r.tellings >= scaled(TELLS_A_RUMOUR, r.record.online)) continue;
        // (talk only as today: the director's scam, clan and duel pieces; the subject and the insiders never tell their own
        // as hearsay)
        if (r.kind === 'scam' || r.kind === 'clan' || r.kind === 'duel' || insider(bot, r)) continue;
        // (a PKer never warns of pkers: a raid's team, its clique mates by PM, the edge's)
        if (r.kind === 'pk' && (bot.botPlanner === 'extras_pker' || bot.botPlanner === 'extras_edgeville_pker')) continue;
        if (r.level === bot.level && cheb(bot.x, bot.z, r.x, r.z) < TELL_AWAY) continue;
        const w = Math.min(freshness(r, now), Math.pow(0.5, (now - k.at) / INTEREST_HALF));
        if (w > bestW) {
            best = r;
            bestW = w;
        }
    }
    if (!best || wordRoll() >= rumourRates.tell * bestW) return false;
    const k = best.knowers.get(bot)!;
    let vi = k.version;
    if (wordRoll() < rumourRates.distort) vi = distort(best, vi);
    const v = best.versions[vi] ?? best.versions[0];
    const slots = { ...best.slots, place: v.place };
    const said = sayArcLine(bot, poolOf(best, v, k), slots, { kind: 'rumour', budget: 'slot', arc: { kind: best.kind, id: `${best.id}.${vi}` }, spoke: 'idle', random: wordRoll });
    if (said === null) return false;
    k.told++;
    best.tellings++;
    best.record.tellings++;
    if (v.distorted) best.record.distorted++;
    squareTold.set(sq, now);
    lastTold.set(bot, { r: best, version: vi, at: now });
    rumourStats.tellings++;
    return true;
}

/** a telling heard: the bots near the speaker learn it (the version told) */
function heard(speaker: Player, tag: ArcTag): void {
    if (!rumourRates.on || speaker.is_bot !== true || typeof tag.id !== 'string') return;
    const [idText, vText] = tag.id.split('.');
    const r = rumours.get(Number(idText));
    if (!r || !live(r)) return;
    const version = Math.max(0, Math.min(r.versions.length - 1, Number(vText) || 0));
    for (const p of botsWithin(speaker.x, speaker.z, speaker.level, HEAR_TILES, speaker)) {
        if (r.knowers.has(p)) continue;
        if (wordRoll() < rumourRates.hear + rumourRates.curiosity * botPersona(p).curiosity) learn(p, r, version, 'heard');
    }
}

// ── the director's tellings (port/BotDirector's block) ───────────────────────────────────────────────────────────

/** of the bots near a run's venue, a knower tells its rumour; else the director's pick, made one ("heard it from a friend") */
function directorSpeaker(run: SetPieceRun, near: readonly Player[], fallback: Player): { speaker: Player; tag?: ArcTag } {
    const r = byRun.get(run) ?? (rumourRates.on ? seedRun(run, 'director') : null);
    if (!r || !rumourRates.on) return { speaker: fallback };
    const knowers = near.filter(p => r.knowers.has(p));
    const speaker = knowers.length > 0 ? knowers[Math.floor(wordRoll() * knowers.length)] : fallback;
    if (!r.knowers.has(speaker)) learn(speaker, r, 0, 'friend');
    const k = r.knowers.get(speaker);
    if (k) k.told++;
    r.tellings++;
    r.record.tellings++;
    rumourStats.directorTellings++;
    lastTold.set(speaker, { r, version: k?.version ?? 0, at: World.currentTick });
    return { speaker, tag: { kind: r.kind, id: `${r.id}.${k?.version ?? 0}` } };
}

function knowsRun(bot: Player, run: SetPieceRun): boolean {
    return byRun.get(run)?.knowers.has(bot) === true;
}

function toldRun(bot: Player, run: SetPieceRun): ArcTag | undefined {
    const r = byRun.get(run);
    if (!r || !rumourRates.on) return undefined;
    if (!r.knowers.has(bot)) learn(bot, r, 0, 'friend');
    const k = r.knowers.get(bot);
    if (k) k.told++;
    r.tellings++;
    r.record.tellings++;
    rumourStats.nearHuman++;
    lastTold.set(bot, { r, version: k?.version ?? 0, at: World.currentTick });
    return { kind: r.kind, id: `${r.id}.${k?.version ?? 0}` };
}

// ── "where?" ─────────────────────────────────────────────────────────────────────────────────────────────────────

const ASK_WHERE = /^(where|wheres|where is (it|that|the (dp|drop party|party|pkers|pk team|rocks))|where at|where exactly|which (place|bank|one))$/;
const ASK_WHEN = /^(when|what time|how long|how soon|when is it|when is the (dp|drop party|party))$/;
const ASK_REAL = /^(real|for real|really|rly|is it real|is that real|legit|u sure|you sure|no way|fake|lol fake|true)$/;

/** the answer to "where?", "when?", "real?" asked of a bot that told a rumour lately; null otherwise */
function rumourAnswer(bot: Player, msg: string, pick: (pool: readonly string[]) => string): { id: string; text: string } | null {
    const told = lastTold.get(bot);
    const now = World.currentTick;
    if (!told) return null;
    if (now - told.at > ANSWER_TICKS) {
        // (too long ago to be asked of: let it go, so a long session's teller holds no rumour)
        lastTold.delete(bot);
        return null;
    }
    const m = msg.replace(/[?!.]+$/g, '').trim();
    const kind = ASK_WHERE.test(m) ? 'where' : ASK_WHEN.test(m) ? 'when' : ASK_REAL.test(m) ? 'real' : null;
    if (!kind) return null;
    const r = told.r;
    const v = r.versions[told.version] ?? r.versions[0];
    // (a version it got wrong, or one heard from far: unsure now and then)
    const unsure = v.distorted ? wordRoll() < 0.5 : wordRoll() < 0.15;
    let answerKind = unsure ? 'unsure' : kind;
    const slots: Record<string, string> = { ...r.slots, place: v.place };
    if (kind === 'when') {
        const run = r.run as { dropAt?: number } | null;
        const left = run?.dropAt !== undefined ? Math.ceil((run.dropAt - now) / 100) : -1;
        if (r.kind !== 'party' || left < 1 || left > 9) answerKind = unsure ? 'unsure' : 'when-soon';
        else slots.mins = String(left);
    }
    const pool = arcLines('word-answer', answerKind).filter(t => fillArcSlots(t, slots) !== null);
    if (pool.length === 0) return null;
    const text = fillArcSlots(pick(pool), slots);
    if (text === null) return null;
    rumourStats.answers++;
    return { id: 'rumour', text };
}

// ── the pass: word guests' arrivals, late lines ──────────────────────────────────────────────────────────────────

function pass(now: number): void {
    for (const r of [...rumours.values()]) {
        // (a knower logged out: its knowledge goes with its session, every session a Player of its own)
        for (const p of r.knowers.keys()) if (p.slot === -1) r.knowers.delete(p);
        // (its guests who came, all told: the party's own record)
        const pr = (r.run as { record?: { came?: number; walkInsCame?: number } } | null)?.record;
        if (r.kind === 'party' && pr && typeof pr.came === 'number') r.record.guestsCame = pr.came + (pr.walkInsCame ?? 0);
        // (word guests that reached the drop)
        if (r.kind === 'party' && takesWordGuests(r.run) && r.record.wordGuests.length > 0) {
            const [dx, dz] = r.run.venue.drop ?? [r.run.venue.x, r.run.venue.z];
            for (const g of r.record.wordGuests) {
                if (g.came) continue;
                const p = botNamed(g.name);
                if (p && r.run.roles.get(p) === 'guest' && p.level === r.run.venue.level && cheb(p.x, p.z, dx, dz) <= 6) g.came = true;
            }
        }
        if (now < r.until) continue;
        rumours.delete(r.id);
        // (a late "missed the dp lol", now and then, from a knower that did not come)
        if (r.kind === 'party' && r.sub !== 'ninety_nine') missed(r);
        release(r);
    }
    if (squareTold.size > 4096) for (const [sq, t] of squareTold) if (now - t > SQUARE_GAP) squareTold.delete(sq);
}

function missed(r: Rumour): void {
    const run = r.run;
    let n = 0;
    for (const [p, k] of r.knowers) {
        if (n >= MISSED_MOST) return;
        if (k.acted !== null || p.slot === -1 || run?.roles.has(p) || insider(p, r)) continue;
        // (one that could have gone: a levelling bot or a social regular, out of the Wilderness)
        if (!mayCome(p) || wordRoll() >= rumourRates.missed) continue;
        const said = sayArcLine(p, arcLines('word-missed'), {}, { kind: 'event', budget: 'own', delay: wordRandInt(50, 400), random: wordRoll });
        if (said !== null) {
            n++;
            r.record.missed++;
        }
    }
}

// ── the bus ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** the rumours' kinds (a line's tag of another kind is not one) */
const PIECE_KINDS: ReadonlySet<string> = new Set(['party', 'pk', 'rocks', 'drop', 'scam', 'clan', 'duel']);

onArcs('set-piece', e => {
    if (!rumourRates.on) return;
    if (e.phase === 'done') runDone(e.run);
    else if (!byRun.has(e.run)) seedRun(e.run, 'director');
});
onArcs('kill', e => {
    if (rumourRates.on) seedKill(e.killer, e.victim);
});
onArcs('event', e => {
    if (!rumourRates.on || e.bot.is_bot !== true || !e.item) return;
    if (e.name === 'rune-drop' || (e.name === 'drop' && /^(dragon|d) /.test(e.item))) seedDrop(e.bot, e.item);
});
onArcs('said', e => {
    if (e.arc && PIECE_KINDS.has(e.arc.kind)) heard(e.bot, e.arc);
});
// (theme C's: a 99 to come, its own parties and weddings; through the bus only)
onArcs('ninety-nine-near', e => {
    if (!rumourRates.on || e.bot.is_bot !== true) return;
    const skill = (e.detail?.skill as string | undefined) ?? skillSay(e.stat);
    if (skill) seedNinetyNine(e.bot, skill, e.venue);
});
onArcs('own-party', e => {
    if (!rumourRates.on) return;
    // (a 99's party: the rumour of its 99 to come takes the run, so its knowers may come as word guests)
    const host = e.host ?? null;
    const now = World.currentTick;
    const ninety = host ? [...rumours.values()].find(r => r.sub === 'ninety_nine' && r.subject === host.username && live(r, now) && r.run === null) : undefined;
    if (ninety) {
        ninety.run = e.run;
        byRun.set(e.run, ninety);
        ninety.until = Math.max(ninety.until, now + Math.max(300, e.run.endsBy - now) + LIFE.partyAfter);
        ninety.record.until = ninety.until;
        for (const p of e.run.roles.keys()) learn(p, ninety, 0, 'seed');
        for (const [p, k] of ninety.knowers) if (k.acted === null) act(p, ninety, k);
        return;
    }
    seedRun(e.run, 'own-party', { subject: host?.username ?? null });
});
onArcs('wedding', e => {
    if (rumourRates.on) seedRun(e.run, 'wedding', { pool: 'wedding', insiders: e.couple.map(p => p.username) });
});

/** a skill's word for a 99 ("woodcutting" → "wc") */
function skillSay(stat: number): string | null {
    return SKILL_SAYS[stat] ?? null;
}

registerArcsTick(now => pass(now), 10);
provideArcs('knowsRumour', knowsRumour);
wordHooks.dueLine = tellDue;
wordHooks.directorSpeaker = directorSpeaker;
wordHooks.knowsRun = knowsRun;
wordHooks.toldRun = toldRun;
wordHooks.wildTripAvoid = avoidsWild;
wordHooks.rocksStep = rocksStep;
wordHooks.rocksSeen = rocksSeen;
wordHooks.rumourAnswer = rumourAnswer;

/** (tests) the rumours live now, and a bot's knowledge of one */
export function liveRumours(): readonly Rumour[] {
    return [...rumours.values()].filter(r => live(r));
}
export function knowledgeOf(bot: Player, r: Rumour): Readonly<Knowledge> | null {
    return r.knowers.get(bot) ?? null;
}
export function rumourOfRun(run: SetPieceRun): Rumour | null {
    return byRun.get(run) ?? null;
}
/** (tests) the rumours in a bot's set (pruned or not), and its last telling's */
export function knownSetForTest(bot: Player): readonly Rumour[] {
    return [...(known.get(bot) ?? [])];
}
export function lastToldForTest(bot: Player): Rumour | null {
    return lastTold.get(bot)?.r ?? null;
}
/** (tests) seed a rumour as the game would (the director's run, a kill, a drop, a rocks word, a 99 to come) */
export const seedForTest = { run: seedRun, kill: seedKill, drop: seedDrop, rocks: seedRocks, ninetyNine: seedNinetyNine, custom: newRumour, learn: (p: Player, r: Rumour, via: Via = 'heard', version = 0) => learn(p, r, version, via), tell: tellDue, distort };
