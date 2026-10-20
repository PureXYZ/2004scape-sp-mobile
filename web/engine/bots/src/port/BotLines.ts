// port: what a bot may say unprompted, and where it fits (the realism work, phase 2; "upstream first,
// gated" and "quiet majority"). Upstream picked any of its 1,081 idle lines at random, in any state, anywhere: 90 % of the
// lines that named a skill or a place did not fit the speaker, veterans asked "how do i bank?", "gtg" and "brb" came with
// no logout or break, and 12 % were about the bots or after 2004 ("I am sentient", discord, rizz).
//
// Now every line has a tag (data/line_tags.json for upstream's, keyed by the exact text and reviewed by hand; the
// groups of data/lines2004.json for the new 2004 lines) that says where and when it is true:
//   - its category: an idle line, a question, a newbie's question, a greeting, a reply to something just said, or a
//     line for a moment (a short break, coming back, leaving: port/BotChatter.sayOccasion) or an event (a death, a drop,
//     a full pack, a tree falling);
//   - what it names: the task kinds (a woodcutting line from a bot at a woodcutting task), what the task works on (oaks,
//     iron, cows), places (in Draynor; "wanna race to varrock?" near it; "how do i get to varrock?" anywhere else) and
//     kinds of place (a bank, a trade bank, the Wilderness, a crowd);
//   - who says it: combat and total bands, members worlds, newbies, the persona (meme personas carry the meta and
//     modern lines, rude ones the insults and the swearing, the young the school lines), the role (PKers, traders);
//   - a {name} line names a player near the bot, and a claim about them ("{name} hit 99 Cooking") only when true.
// The words of upstream's lines never change; only the new lines go through the persona's style (port/BotStyle).
//
// (The realism work, phase 5b, Track D: a set piece's moments, setPieceLine, and word of mouth about one, the category
// 'rumour' through rumourText: lines of data/lines2004-groups.json said only by the set pieces and the director.)
//
// Selection (pickLine): the fitting candidates of the moment; upstream's weigh about 70 % when both kinds fit, the new
// lines fill the gaps, and nothing fits: silence. A world-wide repetition registry re-rolls a line a human heard (within
// 15 tiles) in the last hour (45 minutes before the variety work) or another bot said in the same map square in the last 10, and a bot never repeats
// one of its own last 20. Everything is deterministic: the dice are Math.random (seeded in the sims) or the name.
//
// (The variety work, round 1, Track S)
//   - the registry keys a line by its meaning (meaningKey: lower case, no apostrophes, 2004's shorthand spelled out,
//     laughs, smileys and stretched letters gone), the same key noted and checked, so "I love wc" is "I love
//     woodcutting" and "big bones lol" is "Big bones!" (SAY-14);
//   - a response answers a line of a class it fits (`after`, the heard line's class: port/BotSpoke HeardClass), never
//     another response; upstream's specific ones ("He is in the cave") follow a class no bot produces (SAY-6);
//   - each bot says its own share of upstream's pools (its repertoire, from its name: two or three strangers, not ten,
//     say an odd line) and has two or three catchphrases of its own (P6); among upstream's lines it picks those in its
//     register (a fast abbreviator seldom the formal ones, a careful adult seldom the shorthand: P9; words verbatim);
//   - a new line may hold slots filled from the bot's state ({place} {dest} {target} {skill} {n} {next} {unlock} {item}
//     {want} {clan}: port/BotSlots): one whose slot cannot be filled does not fit; the registry keys the filled text for
//     the human and the template in the square (P3).
import InvType from '#/cache/config/InvType.js';
import NpcType from '#/cache/config/NpcType.js';
import ObjType from '#/cache/config/ObjType.js';
import Player, { getExpByLevel } from '#/engine/entity/Player.js';
import { PlayerStat, PlayerStatMap } from '#/engine/entity/PlayerStat.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { Locations, type SkillStep } from '#/engine/bot/BotKnowledge.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { isAway } from '#/engine/bot/port/BotHabits.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { personaOf, type Persona } from '#/engine/bot/port/BotPersona.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { lastHeard, type HeardClass } from '#/engine/bot/port/BotSpoke.js';
import { fillSlots, slotsIn, slotValues, type Slot, type SlotValues } from '#/engine/bot/port/BotSlots.js';
import { TRADE_BANKS } from '#/engine/bot/port/BotTradeSpots.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { sayable, styleLine } from '#/engine/bot/port/BotStyle.js';
// (the variety work, round 2, Track S2: a busy place's voices, port/BotVoice)
import { voiceFree } from '#/engine/bot/port/BotVoice.js';
import { lastChatAt } from '#/engine/bot/port/BotSay.js';
import botPhrases from '../../data/bot_phrases.json';
import lineTagsJson from '../../data/line_tags.json';
import lines2004Json from '../../data/lines2004.json';
// (the realism work's phase 5a: each track's new groups in a file of its own, the same shape: Track F's and M's, Track E's)
import lines2004TextureJson from '../../data/lines2004-texture.json';
import lines2004EventsJson from '../../data/lines2004-events.json';
// (phase 5b: each track's groups in a file of its own: Track D's (rumours, clan walks, PK teams, trains), Track P's
// (parties, scams, lures), Track A's (the Duel Arena, the mod bot))
import lines2004GroupsJson from '../../data/lines2004-groups.json';
import lines2004PartiesJson from '../../data/lines2004-parties.json';
import lines2004ArenaJson from '../../data/lines2004-arena.json';
// (the variety work, round 1: Track S's groups, and Track D's (with round 2's activities), in files of their own)
import lines2004VarietyJson from '../../data/lines2004-variety.json';
import lines2004ActivitiesJson from '../../data/lines2004-activities.json';
// (the variety work, round 2: Track M's groups in a file of its own; Track D2's in lines2004-activities.json, Track S2's
// in lines2004-variety.json)
import lines2004MembersJson from '../../data/lines2004-members.json';

// ── the lines ────────────────────────────────────────────────────────────────

export type Category =
    | 'ambient' // small talk that fits anywhere (still within its requirements)
    | 'question' // a question to anyone: other bots, and the human, may answer it (its topic)
    | 'newbie-question' // a newbie's question: newbies and low levels only
    | 'greeting' // hello to anyone or all: on arriving somewhere, after logging in, with players about
    | 'response' // a reaction to something just said near it ("lol", "me too", "?")
    | 'departure' // leaving the game: only right before a real logout (sayOccasion)
    | 'departure-soon' // leaving in a few minutes: only when its session ends about then
    | 'brb' // a short break: only right before a real one (sayOccasion)
    | 'back' // back from a short break (sayOccasion)
    | 'death' // after its own death
    | 'close-call' // after it nearly died
    | 'drop-claim' // after a drop it picked up
    | 'level-claim' // about its own level, when true
    | 'skill' // about what it does now
    | 'place' // about where it is
    | 'pk' // the Wilderness and PK talk
    | 'quest' // about a quest it would have done
    | 'name-claim' // a claim about the player it names, when true
    | 'trade' // buying and selling talk
    | 'meme' // the meta and modern lines: meme personas only
    | 'event' // about something that just happened to it (a full pack, a tree falling)
    // (the realism work, phase 5b, Track D: word of mouth about a set piece elsewhere, "drop party at fally park!!";
    // said only through rumourLine, never as idle talk: it fits a context that carries the rumour)
    | 'rumour';

export interface LineTag {
    c: Category;
    skills?: string[];
    targets?: string[];
    places?: string[];
    near?: 'in' | 'region' | 'away';
    at?: string[];
    cb?: [number, number];
    total?: [number, number];
    members?: boolean;
    who?: string[];
    newbie?: boolean;
    event?: string;
    within?: number;
    claim?: string;
    level?: string;
    mins?: number;
    topic?: string;
    heard?: 'any' | 'levelup' | 'answer';
    /**
     * (the variety work, round 1, SAY-6) a response's cue by the class of the line it follows (port/BotSpoke HeardClass:
     * statement, question, greeting, levelup, mishap, brag, complaint, meme, laugh, rude, thanks, spam, social, newbie;
     * 'never': no line is of it, a line kept but never said); a response with none follows the generic classes
     */
    after?: string[];
    /** (variety S6) an emote the bot does as it says the line (port/BotEmote: 'dance') */
    emote?: string;
    /** (variety S6) the line's weight among the fitting ones, times this (the romance lines' low weight) */
    weight?: number;
    /**
     * (the realism work's phase 5a) the event's kinds it fits: the kind the event was noted with (port/BotChatter.noteEvent's
     * `kind`), or a kind under one of them ('genie' fits 'appear-genie' events too: 'appear' fits every 'appear-...' one)
     */
    kinds?: string[];
    /**
     * (the realism work's phase 5b, Track D) a rumour's set piece kinds ('clan_walk', 'pk_raid'): word of mouth about one
     * of them (rumourText); a field of its own, `kinds` being the random events' (test/randomevents.test checks them)
     */
    pieces?: string[];
}

export interface Line {
    text: string;
    tag: LineTag;
    /** upstream's idle lines (bot_phrases.json, verbatim) or the new 2004 lines (lines2004.json, styled) */
    source: 'upstream' | '2004';
    /** it names a player near the bot ({name}) */
    named: boolean;
    /** (variety round 1) upstream's: its index in UPSTREAM_LINES (its repertoire bit) */
    id?: number;
    /** (variety round 1, P3) a new line's slots ({place}, {target} ...: port/BotSlots), when it has any */
    slots?: Slot[];
    /** (variety round 1, P6) a catchphrase of the bot's own (never in ALL_LINES: pickLine adds the bot's) */
    catchphrase?: boolean;
}

const tags = (lineTagsJson as unknown as { tags: Record<string, LineTag> }).tags;
interface Lines2004 {
    groups: { tag: LineTag; lines: string[] }[];
    /** (variety round 1, P6: lines2004-variety.json) the catchphrases each persona draws its own two or three from */
    catchphrases?: Record<string, string[]>;
    levelup: { skills: Record<string, string[]>; milestones: Record<string, number[]>; forms: [string, number][]; upExclaim: string[]; upSay: string[]; combat: string[] };
    pk: Record<PkLineKind, string[]>;
}
const data2004 = lines2004Json as unknown as Lines2004;
/** every group of 2004 lines: lines2004.json's, then phase 5a's files' (texture, events), then phase 5b's (groups, parties, arena), then the variety work's (variety, activities, members) */
const GROUPS_2004: Lines2004['groups'] = [
    ...data2004.groups,
    ...(lines2004TextureJson as unknown as Pick<Lines2004, 'groups'>).groups,
    ...(lines2004EventsJson as unknown as Pick<Lines2004, 'groups'>).groups,
    ...(lines2004GroupsJson as unknown as Pick<Lines2004, 'groups'>).groups,
    ...(lines2004PartiesJson as unknown as Pick<Lines2004, 'groups'>).groups,
    ...(lines2004ArenaJson as unknown as Pick<Lines2004, 'groups'>).groups,
    ...(lines2004VarietyJson as unknown as Pick<Lines2004, 'groups'>).groups,
    ...(lines2004ActivitiesJson as unknown as Pick<Lines2004, 'groups'>).groups,
    ...(lines2004MembersJson as unknown as Pick<Lines2004, 'groups'>).groups
];

/** where a line names a player near the bot (upstream's lines had players' names cut out; port: BotPlayer filled them) */
export const NAME_SLOT = '{name}';
/** upstream's idle lines with their tags (a line with no tag is never said: the tests check that every one has one) */
export const UPSTREAM_LINES: readonly Line[] = (botPhrases as { idle: string[] }).idle
    .filter(text => tags[text] !== undefined)
    .map((text, id) => ({ text, tag: tags[text], source: 'upstream' as const, named: text.includes(NAME_SLOT), id }));
/** the 2004 lines with their group's tag (variety round 1: and their slots) */
export const NEW_LINES: readonly Line[] = GROUPS_2004.flatMap(g =>
    g.lines.map(text => {
        const slots = slotsIn(text);
        return { text, tag: g.tag, source: '2004' as const, named: text.includes(NAME_SLOT), ...(slots.length ? { slots } : {}) };
    })
);
export const ALL_LINES: readonly Line[] = [...UPSTREAM_LINES, ...NEW_LINES];

/** The tag of one of upstream's idle lines or a new line (exact text), or null. For the conversation (BotChat). */
export function tagOf(text: string): LineTag | null {
    return byText.get(text)?.tag ?? null;
}
/** A bot's question's topic ("directions-varrock", "level-woodcutting", "money", ...), or null. */
export function questionTopic(text: string): string | null {
    return byText.get(text)?.tag.topic ?? null;
}
const byText = new Map<string, Line>(ALL_LINES.map(l => [l.text, l]));

/** Categories that are never idle talk: a moment's lines, said only by sayOccasion */
const OCCASION_CATEGORIES = new Set<Category>(['brb', 'back', 'departure']);
/** Categories whose lines are about an event: said only while it is fresh */
const EVENT_CATEGORIES: Partial<Record<Category, string>> = { death: 'death', 'close-call': 'close-call', 'drop-claim': 'drop' };
/**
 * (the variety work, round 1, SAY-5) the event a line is about: its tag's, else its category's (a death line's 'death'):
 * port/BotChatter uses it up when the line is said (a death gave two death lines: the category's event stayed fresh)
 */
export function lineEventOf(tag: LineTag): string | undefined {
    return tag.event ?? EVENT_CATEGORIES[tag.c];
}

// ── places ───────────────────────────────────────────────────────────────────

interface Area {
    x: number;
    z: number;
    /** reach in tiles (Chebyshev) */
    r: number;
    /** underground: a box instead (x0, x1, z0, z1) */
    box?: [number, number, number, number];
}
/**
 * The places the lines name (their reach within port/BotPlaces's, which is within the humanlike report's: what fits here
 * fits there). Upstairs counts as the ground below; the dungeons are boxes underground.
 */
export const PLACE_AREAS: Readonly<Record<string, Area>> = {
    lumbridge: { x: 3222, z: 3218, r: 30 },
    lumbridge_castle: { x: 3208, z: 3220, r: 10 },
    lumbridge_swamp: { x: 3200, z: 3170, r: 20 },
    lumbridge_cows: { x: 3255, z: 3276, r: 18 },
    lumbridge_chickens: { x: 3237, z: 3295, r: 12 },
    varrock: { x: 3213, z: 3428, r: 45 },
    varrock_square: { x: 3212, z: 3428, r: 12 },
    varrock_sewers: { x: 3230, z: 9880, r: 0, box: [3150, 3300, 9840, 9920] },
    falador: { x: 2985, z: 3365, r: 50 },
    falador_park: { x: 2997, z: 3375, r: 15 },
    draynor: { x: 3093, z: 3250, r: 30 },
    draynor_manor: { x: 3109, z: 3350, r: 15 },
    edgeville: { x: 3093, z: 3493, r: 22 },
    edgeville_dungeon: { x: 3110, z: 9920, r: 0, box: [3088, 3150, 9860, 9990] },
    al_kharid: { x: 3293, z: 3190, r: 35 },
    al_kharid_mine: { x: 3299, z: 3300, r: 15 },
    port_sarim: { x: 3030, z: 3220, r: 22 },
    karamja: { x: 2900, z: 3160, r: 60 },
    rimmington: { x: 2957, z: 3215, r: 22 },
    barbarian_village: { x: 3082, z: 3420, r: 18 },
    goblin_village: { x: 2956, z: 3505, r: 15 },
    ice_dungeon: { x: 3030, z: 9570, r: 0, box: [2990, 3070, 9530, 9600] },
    catherby: { x: 2809, z: 3436, r: 25 },
    seers: { x: 2720, z: 3480, r: 25 },
    ardougne: { x: 2662, z: 3305, r: 45 },
    yanille: { x: 2560, z: 3090, r: 25 },
    camelot: { x: 2757, z: 3500, r: 15 },
    taverley: { x: 2900, z: 3440, r: 22 },
    gnome_stronghold: { x: 2460, z: 3430, r: 60 },
    fishing_guild: { x: 2603, z: 3415, r: 12 },
    duel_arena: { x: 3360, z: 3240, r: 30 },
    brimhaven: { x: 2772, z: 3200, r: 30 }
};

/** where a bot is from (x, z, level): Chebyshev distance to an area, 0 inside a dungeon box, Infinity elsewhere underground */
function areaDistance(area: Area, x: number, z: number): number {
    if (area.box) {
        const [x0, x1, z0, z1] = area.box;
        return x >= x0 && x <= x1 && z >= z0 && z <= z1 ? 0 : Infinity;
    }
    if (z >= 6400) return Infinity;
    return Math.max(Math.abs(x - area.x), Math.abs(z - area.z));
}

const BANKS: [number, number, number][] = Object.entries(Locations)
    .filter(([k, v]) => k.endsWith('_BANK') && Array.isArray(v))
    .map(([, v]) => v as [number, number, number]);
const TOWNS = ['lumbridge', 'varrock', 'falador', 'draynor', 'edgeville', 'al_kharid', 'port_sarim', 'rimmington', 'catherby', 'seers', 'ardougne', 'yanille', 'taverley', 'camelot'];

// ── the context ──────────────────────────────────────────────────────────────

/** A player near the bot, as a {name} line sees them. */
export interface Neighbour {
    player: Player | null;
    display: string;
    isBot: boolean;
    /** tiles away (Chebyshev) */
    dist: number;
    cb: number;
    total: number;
    newbie: boolean;
    pker: boolean;
    /** a bot at a gathering or production task (an "autoer" to a 2004 player) */
    gathering: boolean;
    away: boolean;
    /** its skills at 99 (the engine's names: COOKING, WOODCUTTING ...) */
    at99: string[];
    worn: { cape: boolean; hat: boolean; fullrune: boolean; phat: boolean; santa: boolean };
}

/** What a line is judged against: the bot, where it is, what it does, what happened to it. */
export interface LineContext {
    name: string;
    display: string;
    persona: Persona;
    planner: PlannerKey | null;
    /** the task kind (Woodcut, Mine, Combat ... 'none') and its state and step's action */
    task: string;
    state: string | null;
    action: string | null;
    /** what its step works on (oak, iron, cow, lobster ...) */
    targets: string[];
    x: number;
    z: number;
    level: number;
    wild: number;
    cb: number;
    total: number;
    newbie: boolean;
    members: boolean;
    moving: boolean;
    hpShare: number;
    /** its task's skill is within a tenth of a level of the next */
    nearLevel: boolean;
    /** wears a partyhat, full rune */
    wears: { phat: boolean; fullrune: boolean };
    /** the players within 15 tiles on its level */
    near: Neighbour[];
    /** events: name → the tick it happened (and its data: a level reached, a skill; variety round 1: a drop's item) */
    events: ReadonlyMap<string, { tick: number; level?: number; stat?: string; kind?: string; item?: string }>;
    /**
     * a line said by another bot near it lately (lastHeard): any, a level-up, after its own question; (variety round 1,
     * SAY-6) the class of the newest one (port/BotSpoke HeardClass), null when none
     */
    heard: { any: boolean; levelup: boolean; answer: boolean; cls?: HeardClass | null };
    /** play ticks left in its session, if known */
    sessionLeft: number | null;
    now: number;
    /**
     * (the realism work, phase 5b, Track D) a set piece the line is word of mouth about (its kind: 'clan_walk', 'pk_raid'
     * ...), and x/z are then where it is (a rumour line's places name it): only rumourLine sets it
     */
    rumour?: { kind: string } | null;
    /** (variety round 1, P3) the slots that can be filled now and their values (port/BotSlots); none when absent */
    slots?: SlotValues;
}

const GATHERING = new Set(['Woodcut', 'Mine', 'Fish', 'Cook', 'Smith', 'Firemaking', 'Fletching', 'BowStringing', 'Crafting', 'Pick Flax', 'Runecrafting', 'Herblore', 'Thieve', 'Agility', 'WaterFilling']);
const SKILLING = new Set([...GATHERING, 'Combat', 'RangedMagic', 'Prayer']);
/** the task kind whose talk may name another skill's and still fit (as the humanlike report judges: a firemaker's logs) */
const ALSO_FITS: Readonly<Record<string, readonly string[]>> = {
    Fletching: ['Woodcut'],
    BowStringing: ['Fletching', 'Crafting'],
    Firemaking: ['Woodcut'],
    Cook: ['Fish'],
    Smith: ['Mine'],
    Runecrafting: ['Mine'],
    RangedMagic: ['Combat'],
    PKer: ['Combat'],
    EdgevillePKer: ['Combat'],
    Newbie: ['Combat'],
    'Pick Flax': ['Crafting']
};
/** a task kind's skill (the "near a level" claim) */
const TASK_STAT: Readonly<Record<string, number>> = {
    Woodcut: PlayerStat.WOODCUTTING,
    Mine: PlayerStat.MINING,
    Fish: PlayerStat.FISHING,
    Cook: PlayerStat.COOKING,
    Smith: PlayerStat.SMITHING,
    Thieve: PlayerStat.THIEVING,
    Agility: PlayerStat.AGILITY,
    Firemaking: PlayerStat.FIREMAKING,
    Fletching: PlayerStat.FLETCHING,
    BowStringing: PlayerStat.FLETCHING,
    Crafting: PlayerStat.CRAFTING,
    'Pick Flax': PlayerStat.CRAFTING,
    Runecrafting: PlayerStat.RUNECRAFT,
    Herblore: PlayerStat.HERBLORE,
    Prayer: PlayerStat.PRAYER,
    Combat: PlayerStat.ATTACK
};
const TOTAL_STATS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20];

/** A task kind from its name ("Woodcut:1511" → "Woodcut"). */
export function taskKind(name: string | null | undefined): string {
    if (!name) return 'none';
    const i = name.indexOf(':');
    return i === -1 ? name : name.slice(0, i);
}

const targetMemo = new WeakMap<object, string[]>();
/** What a step works on, as the lines name it: oak, willow, iron, coal, ess, lobster, cow, goblin, al kharid warrior ... */
export function stepTargets(kind: string, step: SkillStep | null, action: string | null): string[] {
    if (!step) return kind === 'RangedMagic' && action ? [action === 'ranged' ? 'ranged' : 'magic'] : [];
    const memo = targetMemo.get(step);
    if (memo) return memo;
    const out: string[] = [];
    const itemName = (id: number | undefined): string => (id === undefined || id < 0 ? '' : (ObjType.get(id)?.name ?? '').toLowerCase());
    const gained = itemName(step.itemGained);
    const consumed = itemName(step.itemConsumed);
    const words = `${gained} ${consumed}`;
    const add = (t: string): void => {
        if (!out.includes(t)) out.push(t);
    };
    if (kind === 'Woodcut' || kind === 'Fletching' || kind === 'Firemaking') {
        for (const t of ['oak', 'willow', 'maple', 'yew', 'magic']) if (words.includes(t)) add(t === 'magic' ? 'magic tree' : t);
        if (kind === 'Woodcut' && out.length === 0) add('tree');
    }
    if (kind === 'Mine' || kind === 'Smith') {
        for (const [t, w] of [['copper', 'copper'], ['tin', 'tin'], ['iron', 'iron'], ['coal', 'coal'], ['silver', 'silver'], ['gold', 'gold'], ['mith', 'mithril'], ['addy', 'adamant'], ['rune-ore', 'runite'], ['clay', 'clay'], ['ess', 'essence'], ['steel', 'steel'], ['bronze', 'bronze']] as const) {
            if (words.includes(w)) add(t);
        }
        if (kind === 'Smith' && gained) add(gained.replace(/^(\w+) /, '$1 ').trim());
    }
    if (kind === 'Fish' || kind === 'Cook') {
        for (const t of ['shrimp', 'anchovies', 'sardine', 'herring', 'trout', 'salmon', 'pike', 'tuna', 'lobster', 'swordfish', 'shark']) if (words.includes(t)) add(t);
    }
    if (kind === 'Crafting') {
        if (action === 'spin_flax' || words.includes('flax')) add('flax');
        if (action === 'craft_wool' || words.includes('wool')) add('wool');
        if (action === 'craft_ring' || words.includes('ring')) add('gold ring');
        if (words.includes('leather')) add('leather');
        if (action?.startsWith('cut_')) add('gems');
    }
    if (kind === 'Combat' || kind === 'Thieve' || kind === 'RangedMagic') {
        const extra = step.extra as { npcType?: unknown; npcTypes?: unknown } | undefined;
        const names = typeof extra?.npcType === 'string' ? [extra.npcType] : Array.isArray(extra?.npcTypes) ? (extra.npcTypes as unknown[]).filter((n): n is string => typeof n === 'string') : [];
        for (const n of names) {
            const id = NpcType.getId(n);
            const shown = (id === -1 ? n : (NpcType.get(id).name ?? n)).toLowerCase().replace(/-/g, ' ');
            add(shown === 'woman' ? 'man' : shown);
        }
        if (kind === 'Thieve' && action === 'thieve_stall') add('stall');
        if (kind === 'RangedMagic') add(action === 'ranged' ? 'ranged' : 'magic');
    }
    targetMemo.set(step, out);
    return out;
}

/**
 * play ticks left in this bot's session, or null. (The variety work, round 1, SAY-15: BotManager.sessionLeftOf, now, to
 * its goodbye if it said one: it was the store's snapshot, BotManager.exportWorld, refreshed every 200 ticks, and a
 * "gtg in 30 minutes" came with the speaker still talking an hour later.)
 */
function sessionLeftOf(name: string): number | null {
    const left = BotManager.sessionLeftOf(name);
    return Number.isFinite(left) && left > 0 ? left : null;
}

/** (variety round 1, P3) a drop it picked up lately, as its {item} names it: the newest fresh drop event's item */
function dropOf(events: LineContext['events'], now: number): string | null {
    let best: { tick: number; item: string } | null = null;
    for (const name of ['rune-drop', 'drop', 'big-bones']) {
        const e = events.get(name);
        if (e?.item && now - e.tick <= (EVENT_WINDOW[name] ?? 300) && (!best || e.tick > best.tick)) best = { tick: e.tick, item: e.item };
    }
    return best?.item ?? null;
}

function wornFlags(p: Player): Neighbour['worn'] {
    const worn = p.getInventory(InvType.WORN);
    const nameAt = (slot: number): string => {
        const id = worn?.get(slot)?.id ?? -1;
        return id === -1 ? '' : (ObjType.get(id)?.debugname ?? ObjType.get(id)?.name ?? '').toLowerCase();
    };
    const head = nameAt(0);
    const body = nameAt(4);
    return { cape: nameAt(1) !== '', hat: head !== '' && !/helm|coif|med|full/.test(head), fullrune: body.startsWith('rune_platebody') || body === 'rune platebody', phat: head.includes('partyhat'), santa: head.includes('santa') };
}

/**
 * The context of `bot` now: its task, place, levels, the players near it. `events` and `heard` come from the chatter
 * (port/BotChatter keeps them per bot). One loop over the players (a line said: fine).
 */
export function contextOf(bot: Player, events: LineContext['events'] = new Map(), lastQuestion = -1): LineContext {
    const now = World.currentTick;
    const ai = BotManager.botFor(bot);
    const task = ai?.currentTask ?? null;
    const kind = taskKind(task?.name);
    let step: SkillStep | null = null;
    try {
        step = task?.activityStep() ?? null;
    } catch {
        step = null;
    }
    const action = step?.action ?? null;
    const state = task ? (((task as unknown as Record<string, unknown>).state as string | undefined) ?? null) : null;
    const near: Neighbour[] = [];
    for (const p of World.playerLoop.all()) {
        if (p === bot || p.level !== bot.level) continue;
        const dist = Math.max(Math.abs(p.x - bot.x), Math.abs(p.z - bot.z));
        if (dist > 15) continue;
        const pAi = p.is_bot ? BotManager.botFor(p) : null;
        const pKind = taskKind(pAi?.currentTask?.name);
        const at99: string[] = [];
        for (const [statName, stat] of PlayerStatMap) if (p.baseLevels[stat] >= 99) at99.push(statName);
        near.push({
            player: p,
            display: p.displayName,
            isBot: p.is_bot === true,
            dist,
            cb: p.combatLevel,
            total: totalLevel(p),
            newbie: isNewbie(p) || p.combatLevel <= 5,
            pker: p.botPlanner === 'extras_pker' || p.botPlanner === 'extras_edgeville_pker',
            gathering: p.is_bot === true && GATHERING.has(pKind),
            away: p.is_bot === true && isAway(p),
            at99,
            worn: wornFlags(p)
        });
    }
    const stat = kind === 'RangedMagic' ? (action === 'ranged' ? PlayerStat.RANGED : PlayerStat.MAGIC) : TASK_STAT[kind];
    const self = wornFlags(bot);
    const hpBase = bot.baseLevels[PlayerStat.HITPOINTS] || 10;
    const targets = stepTargets(kind, step, action);
    const moving = bot.hasWaypoints();
    const members = isMembersWorld();
    return {
        name: bot.username,
        display: bot.displayName,
        persona: personaOf(bot.username, (bot.botPlanner as PlannerKey) ?? null),
        planner: (bot.botPlanner as PlannerKey) ?? null,
        task: kind,
        state,
        action,
        targets,
        x: bot.x,
        z: bot.z,
        level: bot.level,
        wild: wildernessLevelAt(bot.x, bot.z),
        cb: bot.combatLevel,
        total: totalLevel(bot),
        newbie: isNewbie(bot),
        members,
        moving,
        hpShare: bot.levels[PlayerStat.HITPOINTS] / hpBase,
        nearLevel: stat !== undefined && nearNextLevel(bot, stat),
        wears: { phat: self.phat, fullrune: self.fullrune },
        near,
        events,
        heard: heardNear(bot, now, lastQuestion),
        sessionLeft: sessionLeftOf(bot.username),
        now,
        // (variety round 1, P3: the slots a line may hold, from its state now)
        slots: slotValues({ kind, action, targets, x: bot.x, z: bot.z, level: bot.level, members, moving, levels: bot.baseLevels, stepAt: step ? [step.location[0], step.location[1]] : null, drop: dropOf(events, now) })
    };
}

/**
 * What the bot heard near it lately (port/BotSpoke's unprompted lines, within 15 tiles): another's line in the last 20
 * ticks, a level-up line in the last 50, a line after its own question (in the last 100). The newest line counts (the
 * bot's own newest one hides an older one: a response is then not due).
 */
function heardNear(bot: Player, now: number, lastQuestion: number): LineContext['heard'] {
    const other = (s: { bot: Player } | null): boolean => s !== null && s.bot !== bot;
    const sinceQuestion = lastQuestion >= 0 && now - lastQuestion <= 100 ? lastHeard(bot.x, bot.z, bot.level, now, now - lastQuestion - 1, 15) : null;
    const last = lastHeard(bot.x, bot.z, bot.level, now, 20, 15);
    return {
        any: other(last),
        levelup: other(lastHeard(bot.x, bot.z, bot.level, now, 50, 15, 'levelup')),
        answer: other(sinceQuestion) && sinceQuestion!.tick > lastQuestion,
        // (variety round 1, SAY-6: what the newest line was, for the responses that fit it)
        cls: other(last) ? last!.cls : null
    };
}

function totalLevel(p: Player): number {
    let total = 0;
    for (const stat of TOTAL_STATS) total += p.baseLevels[stat] ?? 1;
    return total;
}

/** its XP in `stat` is within the last tenth of the way to its next level */
function nearNextLevel(p: Player, stat: number): boolean {
    const level = p.baseLevels[stat];
    if (level >= 99 || level < 1) return false;
    const from = level <= 1 ? 0 : getExpByLevel(level);
    const to = getExpByLevel(level + 1);
    return to > from && (p.stats[stat] - from) / (to - from) >= 0.9;
}

// ── the fit ──────────────────────────────────────────────────────────────────

const ROLES = new Set(['pker', 'social', 'vendor', 'trader', 'levelling']);
const REGIONS = new Set(['usa', 'uk', 'canada', 'australia', 'netherlands', 'sweden', 'ireland', 'new zealand', 'germany', 'norway']);

/** how long an event's lines stay true (ticks), unless the tag says */
export const EVENT_WINDOW: Readonly<Record<string, number>> = {
    death: 3000,
    'wild-death': 3000,
    'close-call': 300,
    'big-bones': 300,
    'rune-drop': 1000,
    drop: 600,
    'full-pack': 150,
    'tree-fell': 30,
    'tree-taken': 60,
    'rock-stolen': 100,
    arrival: 300,
    login: 500,
    levelup: 3000,
    hurt: 60,
    'out-of-arrows': 300,
    'out-of-runes': 300,
    unanswered: 300,
    // the realism work's phase 5a (texture): each track tunes its own (Track F: the fallible and the rude; Track M:
    // the spells; Track E: random events)
    ks: 100,
    'ks-taken': 100,
    'rock-reply': 60,
    misclick: 30,
    lost: 100,
    'forgot-food': 600,
    wolves: 300,
    teleport: 100,
    alch: 300,
    'random-event': 300,
    'fail-teleported': 600,
    'axe-head': 100,
    lamp: 300,
    'clue-scroll': 600,
    // (Track E: a neighbour's line about another's random event, said at once: port/BotRandomEvents)
    'random-near': 60,
    // the realism work's phase 5b (set pieces): each track's events, in its own block
    // (Track D: the director and groups: a set piece's own calls, said at their moment through setPieceLine (a clan
    // walk's leader and members, a PK team's leader, a newbie train's ask and answers), and what a bot near one says of it
    // through the chatter (port/BotChatter EVENT_CHANCE: a clan walking past, a follow train, a PK team at the edge))
    'clan-call': 60,
    'clan-go': 60,
    'clan-wait': 60,
    'clan-next': 60,
    'clan-member': 60,
    'clan-end': 60,
    'clan-join-red': 60,
    'clan-join-black': 60,
    'clan-join-blue': 60,
    'clan-join-yellow': 60,
    'clan-join-green': 60,
    'clan-join-purple': 60,
    'clan-join-orange': 60,
    'clan-cape': 60,
    'clan-cape-on': 60,
    'clan-cape-on-red': 60,
    'clan-seen': 200,
    'pk-team-call': 60,
    'pk-team-answer': 60,
    'pk-team-go': 60,
    'pk-team-pile': 60,
    'pk-team-retreat': 60,
    'pk-team-after': 60,
    'pk-team-seen': 300,
    'train-ask': 60,
    'train-yes': 60,
    'train-no': 60,
    'train-join': 60,
    'train-bye': 60,
    'train-sad': 60,
    'train-seen': 200,
    // (Track P: parties, scams and lures: a set piece's own lines, said at their moment by the piece (port/BotPieceLines),
    // never noted on a bot as an event: its windows are only the tags' validity)
    party: 300,
    'party-rumour': 300,
    scam: 300,
    fakedp: 300,
    // (Track A: the Duel Arena and the mod bot: its lines are its set piece's own, said at their moment by port/BotArena and
    // port/BotModBot; data/lines2004-arena.json's two events are never noted, so no idle pick fits them: named here only)
    duel: 60,
    mod: 60,
    // (the variety work, round 2, Track D2: an errand's moment, said by the errand itself near others (port/BotErrandLines:
    // setPieceLine, the moment in the event's kind: 'q-cook-egg', 'chain-hides-go', 'wild-close'); never noted on a bot)
    errand: 60,
    // (the variety work, round 2, Track M: the far towns' outings and the minigames: data/lines2004-members.json's one event,
    // said at its moments by port/BotOutings sayMembers, never noted on a bot: named here only)
    members: 60,
    // (the variety work, round 1, SAY-5: an event no bot is ever noted with: a line kept, its words untouched, and never
    // said, as "Dying to Elvargs fiery breath sums up my life", which followed any death of a bot of combat 32+)
    unsaid: 1,
    // (the variety work, round 2, Track S2: witnesses and reactions, port/BotWitness: noted on the speaker at the moment
    // it speaks, its group's lines only)
    'witness-death': 60,
    'witness-pk': 60,
    // (2026-10-19) a PK fight seen at the ditch or in the Wilderness (BotWitness fightsSeen)
    'witness-fight': 60,
    'witness-rare': 60,
    'witness-gear': 60,
    'witness-level': 60,
    'drops-reply': 60,
    'drops-ask': 60,
    'drops-answer': 60,
    'show-off': 60,
    'react-death': 60,
    'react-dance': 60,
    'react-emote': 60,
    'react-wild': 60,
    'react-kill': 60
};

function role(ctx: LineContext, r: string): boolean {
    const p = ctx.planner;
    switch (r) {
        case 'pker':
            return p === 'extras_pker' || p === 'extras_edgeville_pker';
        case 'social':
            return p === 'extras_social';
        case 'vendor':
            return p === 'extras_vendor';
        case 'trader':
            return p === 'extras_vendor' || ctx.task === 'Vendor' || ctx.task === 'Bankstand';
        case 'levelling':
            return p !== null && isLevelling(p);
        default:
            return false;
    }
}

function trait(ctx: LineContext, t: string): boolean {
    const p = ctx.persona;
    switch (t) {
        case 'meme':
            return p.meme;
        case 'rude':
            return p.friendliness < 0;
        case 'friendly':
            return p.friendliness > 0.4;
        case 'young':
            return p.ageBand !== 'adult';
        case 'kid':
            return p.ageBand === 'kid';
        case 'teen':
            return p.ageBand === 'teen';
        case 'adult':
            return p.ageBand === 'adult';
        case 'esl':
            return p.region === 'netherlands' || p.region === 'sweden' || p.region === 'germany' || p.region === 'norway';
        case 'helpful':
            return p.helpfulness > 0.5;
        case 'sociable':
            return p.sociability > 0.5;
        case 'f2p':
            return !ctx.members;
        case 'phat':
            return ctx.wears.phat;
        case 'fullrune':
            return ctx.wears.fullrune;
        // (variety round 1, S6: a teen or an adult: the romance lines)
        case 'notkid':
            return p.ageBand !== 'kid';
        // (variety round 1, S6: in a levelling clique, whose clan it may recruit for: its {clan} is known)
        case 'clan':
            return ctx.slots?.clan !== undefined;
        default:
            if (t.startsWith('name-')) return firstNameOf(ctx.display) === t.slice(5);
            return false;
    }
}

/** the first word of a display name, its digits dropped, lower case ("Paul 1990" → paul) */
function firstNameOf(display: string): string {
    return (display.trim().split(/[\s_]+/)[0] ?? '').toLowerCase().replace(/[0-9]+$/, '');
}

/** who: roles any of, regions any of, traits all of (port: "who:pker,rude" a rude PKer; "who:usa,canada" either) */
function whoFits(who: string[], ctx: LineContext): boolean {
    const roles = who.filter(w => ROLES.has(w));
    const regions = who.filter(w => REGIONS.has(w));
    const traits = who.filter(w => !ROLES.has(w) && !REGIONS.has(w));
    if (roles.length && !roles.some(r => role(ctx, r))) return false;
    if (regions.length && !regions.includes(ctx.persona.region)) return false;
    return traits.every(t => trait(ctx, t));
}

function skillFits(skills: string[], ctx: LineContext): boolean {
    const task = ctx.task;
    const also = ALSO_FITS[task] ?? [];
    return skills.some(s => {
        if (s === task || also.includes(s)) return true;
        if (s === 'Ranged') return task === 'RangedMagic' && ctx.action === 'ranged';
        if (s === 'Magic') return task === 'RangedMagic' && ctx.action !== 'ranged';
        if (s === 'Prayer') return task === 'Prayer' || (task === 'Combat' && ctx.state === 'bury');
        if (s === 'Combat') return task === 'Combat' || task === 'RangedMagic' || task === 'PKer' || task === 'EdgevillePKer' || task === 'Newbie';
        if (s === 'Crafting') return task === 'Pick Flax' || task === 'BowStringing';
        return false;
    });
}

function placeFits(tag: LineTag, ctx: LineContext): boolean {
    const near = tag.near ?? 'in';
    const dists = (tag.places ?? []).map(k => (PLACE_AREAS[k] ? { d: areaDistance(PLACE_AREAS[k], ctx.x, ctx.z), r: PLACE_AREAS[k].r } : null)).filter((x): x is { d: number; r: number } => x !== null);
    if (!dists.length) return false;
    if (near === 'away') return dists.every(({ d, r }) => d > r);
    if (near === 'region') return dists.some(({ d, r }) => d > r && d <= Math.max(3 * r, 120));
    return dists.some(({ d, r }) => d <= r);
}

/** Is (x, z) within `dist` tiles of a bank booth's spot (BotKnowledge Locations), on its level or upstairs? */
export function nearBank(x: number, z: number, level: number, dist = 8): boolean {
    return BANKS.some(([bx, bz, bl]) => (level === bl || level > 0) && Math.max(Math.abs(x - bx), Math.abs(z - bz)) <= dist);
}

/** within `dist` tiles of a point on the same level (banks: Locations; upstairs counts as the ground) */
function nearPoint(ctx: LineContext, [px, pz, pl]: [number, number, number], dist: number): boolean {
    return (ctx.level === pl || ctx.level > 0) && Math.max(Math.abs(ctx.x - px), Math.abs(ctx.z - pz)) <= dist;
}

function atFits(a: string, ctx: LineContext): boolean {
    switch (a) {
        case 'bank':
            return nearBank(ctx.x, ctx.z, ctx.level);
        case 'trade-bank':
            return TRADE_BANKS.some(b => (ctx.members || !b.members) && nearPoint(ctx, b.center, 10));
        case 'wild':
            return ctx.wild > 0;
        case 'edge':
            return ctx.level === 0 && ctx.x >= 3060 && ctx.x <= 3140 && ctx.z >= 3470 && ctx.z <= 3560;
        case 'town':
            return TOWNS.some(k => areaDistance(PLACE_AREAS[k], ctx.x, ctx.z) <= PLACE_AREAS[k].r);
        case 'hub':
            return atFits('bank', ctx) || ['varrock_square', 'falador_park', 'lumbridge_castle'].some(k => areaDistance(PLACE_AREAS[k], ctx.x, ctx.z) <= PLACE_AREAS[k].r);
        case 'dungeon':
            return ctx.z >= 6400;
        case 'skilling':
            return SKILLING.has(ctx.task) && !ctx.moving;
        case 'moving':
            return ctx.moving;
        case 'still':
            return !ctx.moving;
        case 'near':
            return ctx.near.length > 0;
        case 'close':
            return ctx.near.some(n => n.dist <= 2);
        case 'crowd':
            return ctx.near.length >= 4;
        case 'quiet':
            return ctx.near.length <= 1;
        case 'lowhp':
            return ctx.hpShare < 0.4;
        case 'seen-cape':
            return ctx.near.some(n => n.dist <= 10 && n.worn.cape);
        case 'seen-hat':
            return ctx.near.some(n => n.dist <= 10 && n.worn.hat);
        case 'seen-fullrune':
            return ctx.near.some(n => n.dist <= 10 && n.worn.fullrune);
        case 'seen-phat':
            return ctx.near.some(n => n.dist <= 10 && n.worn.phat);
        case 'seen-santa':
            return ctx.near.some(n => n.dist <= 10 && n.worn.santa);
        // (variety round 1, S6: a newbie within 10 tiles: a veteran's unasked tip)
        case 'newbie-near':
            return ctx.near.some(n => n.dist <= 10 && n.newbie);
        default:
            return false;
    }
}

/**
 * (the realism work's phase 5a) an event's kind fits a line's kinds: the same, or one under it ('appear' takes
 * 'appear-genie', 'oldman' takes 'oldman-kebab')
 */
export function kindFits(kinds: readonly string[], kind: string | undefined): boolean {
    return kind !== undefined && kinds.some(k => kind === k || kind.startsWith(`${k}-`));
}

/** the event `name` happened within its window (an event the bots never have yet, as an axe head flying off, never) */
export function eventFresh(ctx: LineContext, name: string, within?: number): boolean {
    const e = ctx.events.get(name);
    return e !== undefined && ctx.now - e.tick <= (within ?? EVENT_WINDOW[name] ?? 300);
}

function levelFits(level: string, ctx: LineContext): boolean {
    if (level === 'near') return ctx.nearLevel;
    // just-N: a level-up to N within the window; just-99-Cook: to 99 in cooking
    const m = level.match(/^just-(\d+)(?:-(\w+))?$/);
    if (!m) return false;
    const e = ctx.events.get('levelup');
    if (!e || ctx.now - e.tick > EVENT_WINDOW.levelup || e.level !== Number(m[1])) return false;
    if (!m[2]) return true;
    const want = ({ Cook: 'COOKING', Woodcut: 'WOODCUTTING' } as Record<string, string>)[m[2]] ?? m[2].toUpperCase();
    return e.stat === want;
}

/** Does the named player make the claim true? */
export function claimHolds(claim: string, n: Neighbour): boolean {
    switch (claim) {
        case 'newbie':
            return n.newbie;
        case 'autoer':
            return n.isBot && n.gathering;
        case 'pker':
            return n.isBot && n.pker;
        case 'away':
            return n.away;
        case 'close':
            return n.dist <= 2;
        case 'high-total':
            return n.total >= 1300;
        default: {
            const m = claim.match(/^99-(\w+)$/);
            if (m) {
                const stat = ({ Cook: 'COOKING', Woodcut: 'WOODCUTTING' } as Record<string, string>)[m[1]] ?? m[1].toUpperCase();
                return n.at99.includes(stat);
            }
            return false;
        }
    }
}

/**
 * Does the line fit the bot now? (Not its {name}: a named line also needs a player near it whom it fits, which the pick
 * finds; namedFor.)
 */
export function fits(line: Line, ctx: LineContext): boolean {
    const t = line.tag;
    if (t.c === 'meme' && !ctx.persona.meme) return false;
    // (variety round 1, P3: a slot it cannot fill now)
    if (line.slots && !line.slots.every(slot => ctx.slots?.[slot] !== undefined)) return false;
    if (t.members && !ctx.members) return false;
    if (t.newbie && !ctx.newbie) return false;
    if (t.c === 'newbie-question' && !t.cb && !t.newbie && !ctx.newbie && ctx.cb > 20) return false;
    if (t.cb && (ctx.cb < t.cb[0] || ctx.cb > t.cb[1])) return false;
    if (t.total && (ctx.total < t.total[0] || ctx.total > t.total[1])) return false;
    if (t.who && !whoFits(t.who, ctx)) return false;
    if (t.skills && !skillFits(t.skills, ctx)) return false;
    if (t.targets && !t.targets.some(x => ctx.targets.includes(x))) return false;
    if (t.places && !placeFits(t, ctx)) return false;
    if (t.at && !t.at.every(a => atFits(a, ctx))) return false;
    if (t.level && !levelFits(t.level, ctx)) return false;
    const ev = t.event ?? EVENT_CATEGORIES[t.c];
    if (ev && !eventFresh(ctx, ev, t.within)) return false;
    // (phase 5b: a rumour fits only a context that carries one, of its set piece's kinds)
    if (t.c === 'rumour') {
        if (!ctx.rumour || (t.pieces && !kindFits(t.pieces, ctx.rumour.kind))) return false;
    } else if (t.kinds && !(ev && kindFits(t.kinds, ctx.events.get(ev)?.kind))) return false;
    if (t.c === 'response' && !ctx.heard[t.heard ?? 'any']) return false;
    // (variety round 1, SAY-6: a response to any line fits the class of the line it follows, and never another response)
    if (t.c === 'response' && (t.heard ?? 'any') === 'any' && !responseFits(t, ctx.heard.cls ?? 'statement')) return false;
    if (t.heard && !ctx.heard[t.heard]) return false;
    if (t.c === 'departure-soon') {
        const want = (t.mins ?? 10) * 100;
        if (ctx.sessionLeft === null || ctx.sessionLeft < want * 0.7 || ctx.sessionLeft > want * 1.3) return false;
    }
    if (t.c === 'greeting' && ctx.near.length === 0) return false;
    if (line.named && ctx.near.length === 0) return false;
    return true;
}

/**
 * (variety round 1, SAY-6) the classes a response with no `after` of its own may follow: a laugh, "true", "?" fit a
 * statement, a meme, a complaint, a brag, a mishap or a laugh; not a question, a greeting, a level-up, thanks or spam
 */
const GENERIC_AFTER: ReadonlySet<string> = new Set(['statement', 'meme', 'complaint', 'brag', 'mishap', 'laugh']);

/** (variety round 1, SAY-6) may a response with this tag follow a line of class `cls`? Never another response. */
export function responseFits(tag: LineTag, cls: HeardClass): boolean {
    if (cls === 'response') return false;
    return tag.after ? tag.after.includes(cls) : GENERIC_AFTER.has(cls);
}

/** (variety round 1, SAY-6) a line that is only a laugh or a smiley */
const LAUGH_ONLY = /^(?:(?:lo+l+|lol(?:ol)+|lmf?a+o+|rofl(?:mao)?|ha(?:ha)+h?|he(?:he)+|xd|jaja(?:ja)*|ja|[:;=]-?[()dpo3])[\s!.?]*)+$/i;
const THANKS_LINE = /^(ty|thx|thanks|thank you|k ty|ok ty|kk ty|oh ok ty|ty!+|tyvm)\b/i;
const COMPLAINT_WORDS = /\b(so slow|slow|boring|bored|hate|annoying|lag+y?|sucks|ugh|argh|burnt|burning|failed|failing|stunned|so poor|expensive|ripoff|forever|again lol|stupid|nothing)\b/i;
/** the events of a mishap (a stolen tree, a misclick, a stun, no arrows left): what a "lol" or "Noooooo" may follow */
const MISHAP_EVENTS = new Set(['tree-taken', 'rock-stolen', 'ks', 'misclick', 'lost', 'forgot-food', 'wolves', 'hurt', 'out-of-arrows', 'out-of-runes', 'fail-teleported', 'axe-head']);
/** a question to anyone, as port/BotChat reads one */
const QUESTION_LIKE = /\?|^(how|where|what|whats|who|why|when|which|anyone|any1|anybody|does anyone|is there|can (i|you|u|some|any)|wanna|want to|do you|do u)\b/i;

/**
 * (the variety work, round 1, SAY-6) the class of a line a bot said (port/BotSpoke HeardClass), from its tag (null: none,
 * a line of another pool) and its words: what the responses near it may follow.
 */
export function heardClassOf(tag: LineTag | null, text: string): HeardClass {
    const t = text.trim();
    if (tag?.c === 'response') return 'response';
    if (LAUGH_ONLY.test(t)) return 'laugh';
    if (tag?.c === 'question' || tag?.c === 'newbie-question') return 'question';
    if (tag?.c === 'greeting') return 'greeting';
    if (tag?.c === 'meme') return 'meme';
    if (tag?.who?.includes('rude')) return 'rude';
    if (tag && (tag.c === 'death' || tag.c === 'close-call' || MISHAP_EVENTS.has(tag.event ?? ''))) return 'mishap';
    if (tag && (tag.c === 'drop-claim' || tag.c === 'level-claim' || tag.event === 'rune-drop' || tag.event === 'big-bones' || tag.event === 'drop')) return 'brag';
    if (THANKS_LINE.test(t)) return 'thanks';
    if (QUESTION_LIKE.test(t)) return 'question';
    if (COMPLAINT_WORDS.test(t)) return 'complaint';
    return 'statement';
}

/** the players a named line may name: near it, the claim true of them; null when the line names nobody */
export function namedFor(line: Line, ctx: LineContext): Neighbour[] | null {
    if (!line.named) return null;
    const claim = line.tag.claim;
    return ctx.near.filter(n => (claim ? claimHolds(claim, n) : true));
}

// ── selection ────────────────────────────────────────────────────────────────

/** what a line is picked for: idle talk, a moment (sayOccasion), or an event's line */
export type Purpose = 'idle' | 'brb' | 'back' | 'departure' | { event: string };

/**
 * upstream's share of a pick when both kinds of line fit (upstream first); with fewer than
 * UPSTREAM_FULL upstream lines fitting, its share shrinks with their count (a single fitting line of upstream's, as
 * the only full-pack line a low level may say, would otherwise be 70 % of every such moment)
 */
export const UPSTREAM_SHARE = 0.7;
const UPSTREAM_FULL = 3;

function forPurpose(line: Line, purpose: Purpose): boolean {
    const c = line.tag.c;
    if (purpose === 'brb' || purpose === 'back' || purpose === 'departure') return c === purpose;
    if (OCCASION_CATEGORIES.has(c)) return false;
    if (typeof purpose === 'object') {
        const ev = line.tag.event ?? EVENT_CATEGORIES[c];
        if (purpose.event === 'death' || purpose.event === 'wild-death') return c === 'death' && (ev === 'death' || ev === purpose.event);
        if (purpose.event === 'arrival' || purpose.event === 'login') return ev === purpose.event || (c === 'greeting' && !line.tag.event);
        if (purpose.event === 'levelup') return c === 'level-claim' && line.tag.level?.startsWith('just') === true;
        return ev === purpose.event;
    }
    return true;
}

/**
 * a line's weight among the fitting ones: the ones that name the moment (an event, its task, its place) first; fewer
 * questions (upstream's pool is a fifth questions, and a question nobody answers was a tell of the research's); fewer
 * long lines (2004's chat ran to about 3 words a line, upstream's lines to 5)
 */
function weightOf(line: Line, purpose: Purpose, ctx: LineContext, short = false): number {
    const t = line.tag;
    if (typeof purpose === 'object') return 1;
    const veteran = ctx.cb >= 40;
    let w = t.weight ?? 1;
    if (t.event || EVENT_CATEGORIES[t.c] || t.level) w *= 6;
    // (variety round 1, P3: a line whose slots name its task, target, level or goal weighs as a skill line; one that names
    // its place or destination as a place line)
    if (t.skills || t.targets || line.slots?.some(slot => TASK_SLOTS.has(slot))) w *= 6;
    if (t.places || t.at?.some(a => PLACE_KINDS.has(a)) || line.slots?.some(slot => slot === 'place' || slot === 'dest')) w *= 3;
    // (variety round 1, P9: upstream's lines in the bot's own register, their words unchanged)
    if (line.source === 'upstream') w *= registerWeight(line, ctx.persona);
    // (variety round 1, P6: a catchphrase of its own, now and then)
    if (line.catchphrase) w *= CATCHPHRASE_WEIGHT;
    if (t.c === 'response') w *= 1.5;
    if (t.c === 'greeting') w *= 0.5;
    if (t.c === 'question' || t.c === 'newbie-question') w *= 0.6;
    // (a veteran knows where things are: "where is she", "what is your main world ?" from combat 40+ now and then only)
    if (veteran && NEWBIE_OPENING.test(line.text)) w *= 0.25;
    // (people typed short lines: a long one now and then)
    const words = wordCount(line);
    if (words > 12) w *= 0.3;
    else if (words > 8) w *= 0.5;
    // (a line that follows another in a burst: mostly a short one)
    if (short) w *= words <= 3 ? 3 : words > 6 ? 0.4 : 1;
    return w;
}

const wordCounts = new WeakMap<Line, number>();
function wordCount(line: Line): number {
    let n = wordCounts.get(line);
    if (n === undefined) wordCounts.set(line, (n = line.text.split(/\s+/).filter(w => /[a-z0-9]/i.test(w)).length));
    return n;
}

/** the kinds of place (not the company: "near", "crowd") that make a line about where the bot is */
const PLACE_KINDS = new Set(['bank', 'trade-bank', 'wild', 'edge', 'town', 'hub', 'dungeon']);
/** (variety round 1, P3) the slots that name what it does (its task, target, level, goal, a drop) */
const TASK_SLOTS: ReadonlySet<Slot> = new Set(['target', 'skill', 'n', 'next', 'unlock', 'item', 'want']);

/**
 * (variety round 1, W6) a line about the bot's own moment: its task or target (skills, targets), its place (places, a kind
 * of place), or a slot that names them, where it goes or what it got ({place} {dest} {target} {skill} {n} {next}
 * {unlock} {item} {want})
 */
export function isSpecificLine(line: Line): boolean {
    const t = line.tag;
    return !!(t.skills || t.targets || t.places || t.at?.some(a => PLACE_KINDS.has(a)) || line.slots?.some(slot => slot !== 'clan'));
}

// ── (variety round 1, P9) register: upstream's lines as the bot would type them ─────────────────────────────────

/** formal words and shapes: "you", "are", "please", "I am", "do not", a " ?" */
const FORMAL = /(you|your|are|please|i am|do not|cannot|thank you|very|would|could|should|shall)| \?/i;
/** 2004's shorthand */
const SHORTHAND_RX = /(lol|u|ur|r|plz|pls|k|kk|gz|ty|thx|np|brb|afk|noob|n00b|lvl|wc|rofl|lmao|omg|ppl|sry|cya|gtg|g2g|m8|wanna|gonna|ftw|im|dont|cant|idk|ya|yea|nvm|sup|w00t|pwn|pwned|ownage)/i;
const registers = new WeakMap<Line, number>();
/** a line's register, worked out once: 1 formal ("Where did you level range ?"), -1 shorthand ("lol u nub"), 0 neither */
export function registerOf(line: Line): number {
    let r = registers.get(line);
    if (r === undefined) {
        r = FORMAL.test(line.text) ? 1 : SHORTHAND_RX.test(line.text) ? -1 : 0;
        registers.set(line, r);
    }
    return r;
}
/**
 * the weight of an upstream line in a persona's register: a fast abbreviator (the young: abbreviate 0.6 and up) weighs the
 * formal ones down to x0.3, a careful adult (abbreviate under 0.35) the shorthand ones x0.5; the words stay upstream's
 */
function registerWeight(line: Line, persona: Persona): number {
    const r = registerOf(line);
    const abbreviate = persona.style.abbreviate;
    if (r > 0 && abbreviate >= 0.6) return 1 - 0.7 * Math.min(1, (abbreviate - 0.6) / 0.2);
    if (r < 0 && persona.ageBand === 'adult' && abbreviate < 0.35) return 0.5;
    return 1;
}

// ── (variety round 1, P6) repertoires and catchphrases ──────────────────────────────────────────────────────────

/**
 * the share of each of upstream's pools a bot says (its repertoire, from its name: the same at every login): the ambient,
 * response and break lines a quarter each, the narrower pools more; the skill and place lines all (they are said only at
 * their task and place, few for each: W6, the lines about the bot's moment). An odd line from two or three strangers,
 * not ten: the speakers' cap below (SPEAKER_CAP)
 */
const REPERTOIRE_SHARE: Readonly<Partial<Record<Category, number>>> = { ambient: 0.25, response: 0.25, brb: 0.25, meme: 0.3, question: 0.25, 'newbie-question': 0.4, quest: 0.25, greeting: 0.5, pk: 0.5 };
const repertoires = new Map<string, Uint32Array>();
/** Is upstream's `line` in this bot's repertoire? (Lines of other pools always are.) */
export function inRepertoire(name: string, line: Line): boolean {
    if (line.source !== 'upstream' || line.id === undefined || REPERTOIRE_SHARE[line.tag.c] === undefined) return true;
    let bits = repertoires.get(name);
    if (!bits) {
        bits = new Uint32Array(Math.ceil(UPSTREAM_LINES.length / 32));
        const r = seededRandom(nameSeed(name, 'repertoire'));
        for (const l of UPSTREAM_LINES) if (r() < (REPERTOIRE_SHARE[l.tag.c] ?? 1)) bits[l.id! >> 5] |= 1 << (l.id! & 31);
        if (repertoires.size >= 4096) repertoires.clear();
        repertoires.set(name, bits);
    }
    return (bits[line.id >> 5] & (1 << (line.id & 31))) !== 0;
}

/** a catchphrase's weight among the fitting lines (a few in a hundred of a bot's lines) */
const CATCHPHRASE_WEIGHT = 8;
/** the persona pools catchphrases come from (lines2004-variety.json "catchphrases") */
const CATCHPHRASE_POOLS: Readonly<Record<string, readonly string[]>> = (lines2004VarietyJson as unknown as Pick<Lines2004, 'catchphrases'>).catchphrases ?? {};
const catchphrases = new Map<string, readonly Line[]>();
/** the pools whose catchphrases fit this persona: anyone's, its age's, a meme's, a rude or a friendly one's */
function catchphrasePools(p: Persona): string[] {
    const pools = ['any', p.ageBand];
    if (p.meme) pools.push('meme');
    if (p.friendliness < 0) pools.push('rude');
    else if (p.friendliness > 0.4) pools.push('friendly');
    return pools.filter(k => CATCHPHRASE_POOLS[k]?.length);
}
/** This bot's two or three catchphrases (from its name: the same at every login), as lines (ambient, styled as its own). */
export function catchphrasesOf(name: string, persona: Persona): readonly Line[] {
    let lines = catchphrases.get(name);
    if (!lines) {
        const r = seededRandom(nameSeed(name, 'catchphrases'));
        const pool = [...new Set(catchphrasePools(persona).flatMap(k => CATCHPHRASE_POOLS[k]))];
        const count = Math.min(pool.length, 2 + Math.floor(r() * 2));
        const chosen: string[] = [];
        while (chosen.length < count) {
            const text = pool[Math.floor(r() * pool.length)];
            if (!chosen.includes(text)) chosen.push(text);
        }
        lines = chosen.map(text => ({ text, tag: { c: 'ambient' as const }, source: '2004' as const, named: false, catchphrase: true }));
        if (catchphrases.size >= 4096) catchphrases.clear();
        catchphrases.set(name, lines);
    }
    return lines;
}

/** the opening of a newbie's question ("how do i", "where is", "what is" ...: the humanlike report's H8b) */
const NEWBIE_OPENING = /^(\{name\}[ ,]*)?(how do i|how do you|where do i|where can i|where is|where are|how can|what is|whats the best|should i|is there|is this game free|how do i get)\b/i;

export interface Picked {
    line: Line;
    /** as said ({name} filled in; variety round 1: and its slots) */
    text: string;
    /** the player it names, or null */
    to: Neighbour | null;
    /** (variety round 1, P3) a slot line's text before its slots were filled (the registry's key in the square) */
    template?: string;
}

function weightedPick<T>(items: readonly T[], weight: (t: T) => number, random: () => number): T | null {
    let total = 0;
    for (const it of items) total += weight(it);
    if (total <= 0) return null;
    let x = random() * total;
    for (const it of items) {
        x -= weight(it);
        if (x < 0) return it;
    }
    return items[items.length - 1] ?? null;
}

/**
 * A line for `purpose` that fits the bot now and is fresh (the repetition registry), or null: silence. Upstream's lines
 * weigh UPSTREAM_SHARE when both kinds fit; `short`: the line follows another in a burst, a short one mostly. Pure
 * apart from the registry and the dice.
 */
export function pickLine(ctx: LineContext, purpose: Purpose, random: () => number = Math.random, pool: readonly Line[] = ALL_LINES, short = false): Picked | null {
    const upstream: Line[] = [];
    const fresh: Line[] = [];
    for (const line of pool) {
        if (!forPurpose(line, purpose) || !fits(line, ctx)) continue;
        if (line.named && (namedFor(line, ctx)?.length ?? 0) === 0) continue;
        // (variety round 1, P6: upstream's lines of its own repertoire)
        if (!inRepertoire(ctx.name, line)) continue;
        // (variety round 1: a line of fixed words that is stale, by the registry or the speakers' cap, is no candidate: the
        // dice below had six tries, and a burst's next line that found none ended the burst, C2)
        if (!line.named && !line.slots && (!isFresh(ctx.name, line.text, ctx.x, ctx.z, ctx.level, ctx.now) || (purpose === 'idle' && !speakerFree(ctx.name, line.text, ctx.now)))) continue;
        (line.source === 'upstream' ? upstream : fresh).push(line);
    }
    // (variety round 1, P6: and its own catchphrases, as idle talk)
    if (purpose === 'idle' && pool === ALL_LINES) for (const line of catchphrasesOf(ctx.name, ctx.persona)) if (fits(line, ctx)) fresh.push(line);
    for (let attempt = 0; attempt < 6 && (upstream.length || fresh.length); attempt++) {
        const share = UPSTREAM_SHARE * Math.min(1, upstream.length / UPSTREAM_FULL);
        const list = upstream.length && fresh.length ? (random() < share ? upstream : fresh) : upstream.length ? upstream : fresh;
        const line = weightedPick(list, l => weightOf(l, purpose, ctx, short), random);
        if (!line) return null;
        let to: Neighbour | null = null;
        let text = line.text;
        if (line.named) {
            const who = namedFor(line, ctx)!;
            to = who[Math.floor(random() * who.length)];
            text = text.replaceAll(NAME_SLOT, to.display);
        }
        // (variety round 1, P3: its slots from its state; the registry keys the filled text for the human, the template in
        // the square and among its own: "40 wc" and "41 wc" are one line there)
        const template = line.slots ? text : undefined;
        if (line.slots) text = fillSlots(text, ctx.slots ?? {});
        if (isFresh(ctx.name, text, ctx.x, ctx.z, ctx.level, ctx.now, true, template) && (purpose !== 'idle' || speakerFree(ctx.name, text, ctx.now))) return { line, text, to, template };
        // (a stale line is dropped from this pick's candidates)
        list.splice(list.indexOf(line), 1);
    }
    return null;
}

// ── the repetition registry ──────────────────────────────────────────────────

/**
 * a line a human heard within this many tiles in the last HEARD_TICKS is not said again (an hour; the variety work, round
 * 1: it was 45 minutes, and the humanlike report's W4 counts the repeats a human hears within an hour)
 */
const HEARD_DISTANCE = 15;
const HEARD_TICKS = 6000;
/** a line another bot said in the same map square in the last AREA_TICKS (10 minutes) is not said */
const AREA_TICKS = 1000;
/** a bot never repeats one of its own last OWN_KEPT lines */
const OWN_KEPT = 20;
/**
 * lines anybody says alike ("lol", "hi", "gz"): only the bot's own last ones keep it from saying them (the research's
 * list, as the humanlike report's C6 has it)
 */
const REFLEX = new Set(['gz', 'gratz', 'grats', 'gj', 'ty', 'thx', 'thanks', 'np', 'lol', 'lmao', 'haha', 'hah', 'hi', 'hey', 'hello', 'yo', 'sup', 'bye', 'cya', 'gl', 'gf', 'ok', 'k', 'kk', 'yes', 'no', 'ya', 'yeah', 'nice', 'brb', 'afk', 'wow']);

const heardAt = new Map<string, number>();
const areaAt = new Map<string, number>();
const ownLines = new Map<string, string[]>();
/**
 * (the variety work, round 1, P6: W9) who said a line lately, world-wide (its meaning, not a reflex line): an idle line
 * SPEAKER_CAP other bots said in the last SPEAKER_TICKS (2 hours of play) is not picked as idle talk: an odd line from
 * two or three strangers, not ten ("Darkness overpowering." came from 10 bots in 2 h; with the repertoires alone a short
 * line its holders said often still came from 9)
 */
const speakers = new Map<string, { name: string; tick: number }[]>();
const SPEAKER_CAP = 3;
const SPEAKER_TICKS = 12000;
const SPEAKERS_KEPT = 8;

/** May `name` say `text` as idle talk? Fewer than SPEAKER_CAP others said it in the last SPEAKER_TICKS (a reflex line always may). */
export function speakerFree(name: string, text: string, now: number): boolean {
    if (REFLEX.has(normalizedLine(text))) return true;
    const list = speakers.get(meaningKey(text));
    if (!list) return true;
    // (the fixes, the reviewer's: a count, no Set a candidate line: a list holds a name once, noteSpeaker; pickLine asks
    // for every fitting fixed line)
    let others = 0;
    for (const s of list) if (s.name !== name && now - s.tick < SPEAKER_TICKS && ++others >= SPEAKER_CAP) return false;
    return true;
}

function noteSpeaker(name: string, key: string, now: number): void {
    const list = speakers.get(key) ?? [];
    const i = list.findIndex(s => s.name === name);
    if (i >= 0) list.splice(i, 1);
    list.push({ name, tick: now });
    if (list.length > SPEAKERS_KEPT) list.shift();
    speakers.set(key, list);
}
let lastPrune = 0;

function normalizedLine(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9*]+/g, ' ').trim();
}

/** (variety round 1, SAY-14) 2004's shorthand spelled out again (port/BotStyle's abbreviations, the other way) */
const MEANING_WORDS: readonly [RegExp, string][] = [
    [/\bu r\b/g, 'you are'],
    [/\bu\b/g, 'you'],
    [/\bur\b/g, 'your'],
    [/\br\b/g, 'are'],
    [/\b(plz|pls|plox)\b/g, 'please'],
    [/\b(ty|thx|thanx|thank you)\b/g, 'thanks'],
    [/\blvls\b/g, 'levels'],
    [/\blvl\b/g, 'level'],
    [/\bwc\b/g, 'woodcutting'],
    [/\bfm\b/g, 'firemaking'],
    [/\brc\b/g, 'runecrafting'],
    [/\bcb\b/g, 'combat'],
    [/\b(xp|exp)\b/g, 'experience'],
    [/\b(cuz|coz)\b/g, 'because'],
    [/\bppl\b/g, 'people'],
    [/\bany1\b/g, 'anyone'],
    [/\bsome1\b/g, 'someone'],
    [/\b(k|ok)\b/g, 'okay'],
    [/\bcya\b/g, 'see you'],
    [/\bidk\b/g, 'i dont know'],
    [/\bnvm\b/g, 'never mind'],
    [/\bwanna\b/g, 'want to'],
    [/\bm8\b/g, 'mate'],
    [/\bgr8\b/g, 'great'],
    [/\bl8r\b/g, 'later'],
    [/\b(tmrw|2moro)\b/g, 'tomorrow'],
    [/\b2nite\b/g, 'tonight'],
    [/\bb4\b/g, 'before'],
    [/\by\b/g, 'why'],
    [/\bdose\b/g, 'does'],
    [/\b(wat|wut)\b/g, 'what'],
    [/\bda\b/g, 'the'],
    [/\bwid\b/g, 'with'],
    [/\benuff\b/g, 'enough'],
    [/\bim\b/g, 'i am']
];
/** laughs and smileys: they change no line's meaning */
const MEANING_LAUGH = /\b(lo+l+|lol(ol)+|lmf?a+o+|rofl(mao)?|ha(ha)+h?|he(he)+|xd)\b/g;
const MEANING_SMILEY = /[:;=]-?[()dpo3]/gi;

/**
 * (the variety work, round 1, SAY-14) what a line means, as the registry keys it: lower case, apostrophes dropped, laughs
 * and smileys gone, stretched letters and words collapsed ("sooo", "nooo", "yesss"), 2004's shorthand spelled out
 * ("u" you, "wc" woodcutting, "lvl" level): "I love wc" is "I love woodcutting", "big bones lol" is "Big bones!", and a
 * styled line keys as its unstyled one (style changed the key of a fifth of the 2004 lines, which the registry never
 * saw). A line of nothing but a laugh or a smiley keys as itself.
 */
export function meaningKey(text: string): string {
    let key = meaningKeys.get(text);
    if (key === undefined) {
        key = meaningKeyOf(text);
        if (meaningKeys.size >= 20000) meaningKeys.clear();
        meaningKeys.set(text, key);
    }
    return key;
}
/** (the keys worked out: a line's key is asked for at every pick of it) */
const meaningKeys = new Map<string, string>();
function meaningKeyOf(text: string): string {
    let t = text.toLowerCase().replace(/'/g, '').replace(MEANING_SMILEY, ' ').replace(/[^a-z0-9*]+/g, ' ');
    t = t.replace(/([a-z])\1{2,}/g, '$1').replace(MEANING_LAUGH, ' ');
    t = t.replace(/\bs(o{2,})\b/g, 'so').replace(/\bn(o{2,})\b/g, 'no').replace(/\bye+s+\b/g, 'yes').replace(/\bomg+\b/g, 'omg').replace(/\bplz+\b/g, 'please');
    for (const [rx, word] of MEANING_WORDS) t = t.replace(rx, word);
    t = t.replace(/\s+/g, ' ').trim();
    return t || normalizedLine(text);
}
function areaKey(x: number, z: number, level: number): string {
    return `${x >> 6}_${z >> 6}_${level}`;
}

/**
 * May `name` say `text` at (x, z) now? Not one of its last 20 (`own`: a PKer's few lines repeat by nature), not heard
 * by a human lately, not said in this square lately.
 */
export function isFresh(name: string, text: string, x: number, z: number, level: number, now: number, own = true, template?: string): boolean {
    // (variety round 1: by meaning (SAY-14); a slot line by its template in the square and among its own (P3))
    const key = meaningKey(text);
    const shape = template === undefined ? key : meaningKey(template);
    if (own && ownLines.get(name)?.includes(shape)) return false;
    if (REFLEX.has(normalizedLine(text))) return true;
    const heard = heardAt.get(key);
    if (heard !== undefined && now - heard < HEARD_TICKS) return false;
    const area = areaAt.get(`${areaKey(x, z, level)}|${shape}`);
    return area === undefined || now - area >= AREA_TICKS;
}

/** `bot` said `text`: the registry remembers it (one loop over the players: a human within 15 tiles heard it). */
export function noteSaid(bot: Player, text: string, now: number = World.currentTick, template?: string): void {
    // (variety round 1: the key isFresh checks: the meaning, a slot line's template in the square and among its own)
    const key = meaningKey(text);
    const shape = template === undefined ? key : meaningKey(template);
    const own = ownLines.get(bot.username) ?? [];
    own.push(shape);
    if (own.length > OWN_KEPT) own.shift();
    ownLines.set(bot.username, own);
    if (REFLEX.has(normalizedLine(text))) return;
    noteSpeaker(bot.username, key, now);
    areaAt.set(`${areaKey(bot.x, bot.z, bot.level)}|${shape}`, now);
    for (const p of World.playerLoop.all()) {
        if (p.is_bot || p.level !== bot.level) continue;
        if (Math.max(Math.abs(p.x - bot.x), Math.abs(p.z - bot.z)) <= HEARD_DISTANCE) {
            heardAt.set(key, now);
            break;
        }
    }
    if (now - lastPrune >= AREA_TICKS) {
        lastPrune = now;
        for (const [k, t] of areaAt) if (now - t >= AREA_TICKS) areaAt.delete(k);
        for (const [k, t] of heardAt) if (now - t >= HEARD_TICKS) heardAt.delete(k);
        for (const [k, list] of speakers) if (now - list[list.length - 1].tick >= SPEAKER_TICKS) speakers.delete(k);
    }
}

/** The registry for a test: say a line as `name` at (x, z), heard by a human or not. */
export function noteSaidAt(name: string, text: string, x: number, z: number, level: number, now: number, humanHeard: boolean, template?: string): void {
    const key = meaningKey(text);
    const shape = template === undefined ? key : meaningKey(template);
    const own = ownLines.get(name) ?? [];
    own.push(shape);
    if (own.length > OWN_KEPT) own.shift();
    ownLines.set(name, own);
    if (REFLEX.has(normalizedLine(text))) return;
    noteSpeaker(name, key, now);
    areaAt.set(`${areaKey(x, z, level)}|${shape}`, now);
    if (humanHeard) heardAt.set(key, now);
}

/** (tests) forget every line said */
export function resetLineRegistry(): void {
    heardAt.clear();
    areaAt.clear();
    ownLines.clear();
    speakers.clear();
    lastPrune = 0;
}

// ── level-ups ────────────────────────────────────────────────────────────────

const LEVELUP = data2004.levelup;
/** upstream's level-up phrases (bot_phrases.json levelup): the forms fold them in, as exclamations or sayings */
export const UPSTREAM_LEVELUP: readonly string[] = (botPhrases as { levelup?: string[] }).levelup ?? [];

/**
 * A 2004 milestone: every 10th level and 99, and the levels players waited for (40 attack and defence for rune, 60 for
 * dragon, 43 prayer, 55 magic for high alchemy...).
 */
export function isMilestone(stat: string, level: number): boolean {
    return level % 10 === 0 || level === 99 || (LEVELUP.milestones[stat.toLowerCase()] ?? []).includes(level);
}

/** (variety round 1, S9) a skill's 2004 short name as the level-up lines say it first ("wc", "att", "fishing") */
export function skillShort(stat: string): string {
    return (LEVELUP.skills[stat.toLowerCase()] ?? [stat.toLowerCase()])[0];
}

/** the forms of a level-up line and their weights (the data's, with upstream's phrases folded in) */
function levelupForms(): [string, number][] {
    return LEVELUP.forms;
}

/**
 * Every level-up line the forms can make for `stat` at `level` (and a combat level `cb`), whether the 274 filter
 * leaves it alone or not (it reads across words: "level up! 40 wc" has a "pw" in it). levelUpLine says only those it
 * leaves alone (allLevelUpLines).
 */
export function levelUpCandidates(stat: string, level: number, cb = 50): string[] {
    const shorts = LEVELUP.skills[stat.toLowerCase()] ?? [stat.toLowerCase()];
    const out = new Set<string>();
    for (const [form] of levelupForms()) {
        for (const s of shorts) {
            for (const up of form.includes('{up}') ? LEVELUP.upExclaim : form.includes('{upsay}') ? LEVELUP.upSay : form.includes('{upalone}') ? LEVELUP.upExclaim : ['']) {
                out.add(fillLevelForm(form, s, level, up));
            }
        }
    }
    for (const form of LEVELUP.combat) out.add(form.replaceAll('{cb}', String(cb)));
    return [...out];
}

/** The level-up lines a bot may say for `stat` at `level`: the candidates the 274 filter and the chat codec leave whole. */
export function allLevelUpLines(stat: string, level: number, cb = 50): string[] {
    return levelUpCandidates(stat, level, cb).filter(sayable);
}

function fillLevelForm(form: string, short: string, level: number, up: string): string {
    return form.replace('{upalone}', up).replace('{upsay}', up).replace('{up}', up).replaceAll('{s}', short).replaceAll('{n}', String(level));
}

/**
 * A level-up line in a 2004 form ("40 wc!!", "woot 41 mining", "finally 60 att", "lvl!", "finally! 40 wc"): the form and
 * the skill's short name by the dice; `cb`: the combat level it reached with this level, if it rose (now and then said
 * instead).
 */
export function levelUpLine(stat: string, level: number, random: () => number = Math.random, cb: number | null = null): string {
    const shorts = LEVELUP.skills[stat.toLowerCase()] ?? [stat.toLowerCase()];
    if (cb !== null && random() < 0.25) {
        const line = LEVELUP.combat[Math.floor(random() * LEVELUP.combat.length)].replaceAll('{cb}', String(cb));
        if (sayable(line)) return line;
    }
    // (a form the filter would mask, read across its words, is drawn again)
    for (let attempt = 0; attempt < 6; attempt++) {
        const short = shorts[Math.floor(random() * shorts.length)];
        const form = weightedPick(levelupForms(), f => f[1], random)![0];
        // (upstream's phrases, bot_phrases.json levelup, their words kept: the exclamations and the sayings)
        const pool = form.includes('{upsay}') ? LEVELUP.upSay : LEVELUP.upExclaim;
        const line = fillLevelForm(form, short, level, pool[Math.floor(random() * pool.length)]);
        if (sayable(line)) return line;
    }
    return `${level} ${shorts[0]}`;
}

// ── PK lines ─────────────────────────────────────────────────────────────────

// ('honour', 2026-10-18: an Edgeville PKer's call-out to a target with a protection prayer on, "no honour")
// ('pjed', PK tactics round 2, 2026-10-19: a line at a PJer, attacked again just after its own fight)
// (play-testing: the ditch "a little too quiet", "like trash talk": the fight's banter, port/BotPkTactics pkBanter:
// 'taunt' now and then, 'hit' after a big hit, 'lucky' after taking one, 'ate' when the target eats, 'low' at the
// target's last Hitpoints, 'lag' at its own, 'back' an answer to the target's taunt)
export type PkLineKind = 'patrol' | 'fight' | 'kill' | 'gl' | 'escape' | 'honour' | 'ran' | 'pjed' | 'taunt' | 'hit' | 'lucky' | 'ate' | 'low' | 'lag' | 'back';
/** the 2004 PK lines (the upstream pools stay in their tasks: PKerTask, EdgevillePKerTask, port/BotPkTactics) */
export const PK_LINES: Readonly<Record<PkLineKind, readonly string[]>> = {
    patrol: data2004.pk.patrol, fight: data2004.pk.fight, kill: data2004.pk.kill, gl: data2004.pk.gl, escape: data2004.pk.escape, honour: data2004.pk.honour, ran: data2004.pk.ran, pjed: data2004.pk.pjed,
    taunt: data2004.pk.taunt, hit: data2004.pk.hit, lucky: data2004.pk.lucky, ate: data2004.pk.ate, low: data2004.pk.low, lag: data2004.pk.lag, back: data2004.pk.back
};
/** a PKer uses this many lines of each pool (from its name): two PKers seldom share their few lines */
const PK_SUBSET = 4;
const pkSubsets = new Map<string, string[]>();

/** This PKer's own few lines of a pool (`kind`): upstream's and the 2004 lines, chosen by its name, the same at every login. */
export function pkSubset(name: string, kind: PkLineKind, upstream: readonly string[]): string[] {
    const key = `${name}|${kind}|${upstream.length}`;
    let subset = pkSubsets.get(key);
    if (!subset) {
        const seen = new Set<string>();
        const pool = [...upstream, ...PK_LINES[kind]].filter(l => !seen.has(l.toLowerCase()) && (seen.add(l.toLowerCase()), true));
        const r = seededRandom(nameSeed(name, `pk-${kind}`));
        const shuffled = pool.map(l => ({ l, k: r() })).sort((a, b) => a.k - b.k).map(x => x.l);
        subset = shuffled.slice(0, Math.min(PK_SUBSET, shuffled.length));
        pkSubsets.set(key, subset);
    }
    return subset;
}

/**
 * A PK line of `kind` for this PKer, from its own subset (pkSubset), or null: each line of it another bot said in this
 * map square in the last 10 minutes, or a human heard in the last 45 (the repetition registry; at the Edgeville ditch
 * "Gl ****" was the line most often said by two bots in one place).
 */
export function pkLine(player: Player, kind: PkLineKind, upstream: readonly string[], random: () => number = Math.random): string | null {
    const subset = pkSubset(player.username, kind, upstream);
    const now = World.currentTick;
    // (the variety work, round 2, S2-2: one PK line at a time, a few seconds apart ("Gf" four times in 6 ticks at the
    // ditch); a taunt or a "gl" not over the PKer's share of a busy place's talk: port/BotVoice)
    if (now - (pkSaidAt.get(player) ?? -Infinity) < PK_LINE_GAP) return null;
    if ((kind === 'patrol' || kind === 'gl' || kind === 'fight') && !voiceFree(player, now)) return null;
    // (variety round 2, S2-6: a PKer quiet for 10 minutes taunts half as often: its talk in spells, as people's, not a
    // patrol's even beat: the PKers' gaps between lines had a CV under 1, C2)
    if ((kind === 'patrol' || kind === 'gl') && now - lastChatAt(player) > PK_QUIET_SPELL && random() < 0.5) return null;
    const start = Math.floor(random() * subset.length);
    for (let i = 0; i < subset.length; i++) {
        const line = subset[(start + i) % subset.length];
        if (!isFresh(player.username, line, player.x, player.z, player.level, now, false)) continue;
        // (play-testing: "the same lines like cya a lot") a reflex line ("cya", "gf", "gl") is always fresh, so
        // once a PKer's other lines were said here it was the one left: not again in this square for a while
        const reflex = REFLEX.has(normalizedLine(line)) ? `${areaKey(player.x, player.z, player.level)}|${normalizedLine(line)}` : null;
        if (reflex !== null && now - (pkReflexAt.get(reflex) ?? -Infinity) < PK_REFLEX_TICKS) continue;
        if (reflex !== null) {
            if (pkReflexAt.size > 4096) pkReflexAt.clear();
            pkReflexAt.set(reflex, now);
        }
        noteSaid(player, line, now);
        pkSaidAt.set(player, now);
        return line;
    }
    return null;
}
/** a reflex PK line said in a square (its key: the square and the line), when; not again there for as long as any line (AREA_TICKS) */
const pkReflexAt = new Map<string, number>();
const PK_REFLEX_TICKS = AREA_TICKS;
/** (variety round 2) a PKer's lines this many ticks apart at least; its last one's tick */
const PK_LINE_GAP = 12;
const PK_QUIET_SPELL = 1000;
const pkSaidAt = new WeakMap<Player, number>();

/**
 * A fixed PK line (upstream's "Oops, sorry!" to a target already in a fight), when another bot did not say it in this
 * map square in the last 10 minutes (at 500 bots the Edgeville PKers said it 30 times in half an hour at the ditch).
 */
export function pkFixedLine(player: Player, line: string): string | null {
    const now = World.currentTick;
    if (!isFresh(player.username, line, player.x, player.z, player.level, now, false)) return null;
    noteSaid(player, line, now);
    return line;
}

/**
 * A line of `pool` that is fresh for `bot` here (the repetition registry: not one of its own last 20, nor one another bot
 * said in this map square in the last 10 minutes or a human heard in the last 45; "gz" and the like always are),
 * noted as said; null when none is. For the bots' set lines to each other (port/BotChat: a gz, a ty): at 500 bots
 * "Gz man" came from three bots in one square.
 */
export function freshLine(bot: Player, pool: readonly string[], random: () => number = Math.random): string | null {
    const now = World.currentTick;
    const start = Math.floor(random() * pool.length);
    for (let i = 0; i < pool.length; i++) {
        const line = pool[(start + i) % pool.length];
        if (!isFresh(bot.username, line, bot.x, bot.z, bot.level, now)) continue;
        noteSaid(bot, line, now);
        return line;
    }
    return null;
}

/** (tests) this bot's PK subset of `kind` */
export function pkSubsetOf(name: string, kind: PkLineKind, upstream: readonly string[]): string[] {
    return pkSubset(name, kind, upstream);
}

/** (for its persona) the line's persona: the bot's, from its name and planner */
export function personaFor(bot: Player): Persona {
    return personaOf(bot.username, (bot.botPlanner as PlannerKey) ?? null);
}

// ── set pieces' lines (the realism work, phase 5b, Track D: the director and groups) ─────────────────────────────

const setPiecePools = new Map<string, readonly Line[]>();
/** the 2004 lines of a set piece's moment (`key`: their group's event), or 'rumour': every rumour line */
function setPiecePool(key: string): readonly Line[] {
    let pool = setPiecePools.get(key);
    if (!pool) {
        pool = NEW_LINES.filter(l => (key === 'rumour' ? l.tag.c === 'rumour' : l.tag.c !== 'rumour' && l.tag.event === key));
        setPiecePools.set(key, pool);
    }
    return pool;
}

export interface SetPieceLineOptions {
    /** where the line's places are judged: the place it names (the walk's next stop, a venue); else the bot's own */
    at?: readonly [number, number];
    /** the moment's kind, for a group with kinds (Track D's moments carry theirs in the name: 'clan-join-red') */
    kind?: string;
}

/**
 * (the realism work, phase 5b, Track D) a line for a set piece's moment (`key`: the event its group of
 * data/lines2004-groups.json is tagged with: 'clan-go', 'pk-team-call', 'train-ask' ...) that fits the bot and is fresh
 * (the repetition registry), in its persona's style, noted as said; null when none is. The caller says it (LineKind
 * 'setpiece', out of H7) and counts it against the bot's talk budget (port/BotChatter countAsBudgetedLine).
 */
export function setPieceLine(bot: Player, key: string, opts: SetPieceLineOptions = {}, random: () => number = Math.random): string | null {
    const pool = setPiecePool(key);
    if (pool.length === 0) return null;
    const now = World.currentTick;
    const base = contextOf(bot, new Map([[key, { tick: now, kind: opts.kind }]]));
    const ctx: LineContext = opts.at ? { ...base, x: opts.at[0], z: opts.at[1] } : base;
    const picked = pickLine(ctx, { event: key }, random, pool);
    return picked ? said(bot, picked.text, now) : null;
}

/**
 * (the realism work, phase 5b, Track D: word of mouth) a rumour line (category 'rumour') about a set piece of `kind`
 * ('clan_walk', 'pk_raid') at `at`: one whose places hold that spot ("clan walking thru draynor lol") two times in three
 * where there is one, else one that names no place; as written (port/BotDirector says it in its speaker's style and checks
 * it is fresh); null when none fits.
 */
export function rumourText(kind: string, at: readonly [number, number], random: () => number = Math.random): string | null {
    const members = isMembersWorld();
    const spot = { x: at[0], z: at[1] } as LineContext;
    const fitting = setPiecePool('rumour').filter(l => (!l.tag.pieces || kindFits(l.tag.pieces, kind)) && (!l.tag.members || members) && (!l.tag.places || placeFits(l.tag, spot)));
    const placed = fitting.filter(l => l.tag.places);
    const plain = fitting.filter(l => !l.tag.places);
    const list = placed.length > 0 && (plain.length === 0 || random() < 2 / 3) ? placed : plain;
    return list.length > 0 ? list[Math.floor(random() * list.length)].text : null;
}

function said(bot: Player, text: string, now: number): string {
    noteSaid(bot, text, now);
    return styleLine(text, personaFor(bot)).line;
}
