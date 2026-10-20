// port (the variety work, round 1, Track S: P3, state-filled slots): the
// slots a new 2004 line may hold, filled from the bot's state when the line is picked (port/BotLines contextOf, pickLine),
// so a line can be about what this bot does, where and why: "finally in fally", "2 lvls till willows", "these cows drop
// nothing", "omg rune med", "almost at varrock". A line whose slot cannot be filled now does not fit (port/BotLines fits).
//
//   {place}   where it is, as players named it (lumby, fally, varrock, draynor, edge, al kharid, karamja, catherby, seers,
//             ardy ...): on the ground, within the place's reach (inside the humanlike report's H8 reach: a line that names
//             a place is said in it)
//   {dest}    where a walker is going (its task's spot): in the last stretch only (within 1.6 reaches, not in it yet), so
//             "almost at fally" is true (and inside H8's reach)
//   {target}  what its step works on as players named it: willows, yews, iron, coal, ess, lobs, cows, goblins, men ...
//   {skill}   its task's skill's short name (wc, mining, fishing, att ...) and {n} its level in it
//   {next}    the next level that unlocks something in that skill, and {unlock} what (30 → willows, 40 → rune, 43 → protect)
//   {item}    a drop it just picked up (the drop's event), as players named it (rune med, nat, big bones)
//   {want}    the next tool or weapon it would buy (a rune axe, a mith scim): 2004's goals by level
//   {clan}    its clique's clan name (port/BotChatter fills it: a levelling clique's, from its names)
// No dice here: pure functions of the state passed in (the line's pick draws the dice).

/** the slots a line may hold (besides {name}, a player near it: port/BotLines NAME_SLOT) */
export const SLOTS = ['place', 'dest', 'target', 'skill', 'n', 'next', 'unlock', 'item', 'want', 'clan'] as const;
export type Slot = (typeof SLOTS)[number];
export type SlotValues = Partial<Record<Slot, string>>;

const SLOT_RX = /\{(place|dest|target|skill|n|next|unlock|item|want|clan)\}/g;

/** the slots in a line's text, in order, each once ([] for a line with none) */
export function slotsIn(text: string): Slot[] {
    const out: Slot[] = [];
    for (const m of text.matchAll(SLOT_RX)) if (!out.includes(m[1] as Slot)) out.push(m[1] as Slot);
    return out;
}

/** the line with its slots filled (a slot with no value stays as it is: fits() keeps such a line out) */
export function fillSlots(text: string, values: SlotValues): string {
    return text.replace(SLOT_RX, (all, slot: Slot) => values[slot] ?? all);
}

// ── places ───────────────────────────────────────────────────────────────────

interface SlotPlace {
    say: string;
    x: number;
    z: number;
    /** reach (Chebyshev tiles): inside it the bot is "in" the place; the humanlike report's H8 takes 1.5 of its own, larger */
    r: number;
    members?: boolean;
}

/**
 * The places a {place} or {dest} names, as players said them; centres and reaches within the humanlike report's (H8:
 * lib/humanlike-metrics.mjs PLACES, its reach × 1.5), so every place said is where H8 finds the bot.
 */
export const SLOT_PLACES: readonly SlotPlace[] = [
    { say: 'lumby', x: 3222, z: 3218, r: 30 },
    { say: 'varrock', x: 3213, z: 3428, r: 45 },
    { say: 'fally', x: 2985, z: 3365, r: 45 },
    { say: 'draynor', x: 3093, z: 3250, r: 25 },
    { say: 'edge', x: 3093, z: 3493, r: 22 },
    { say: 'al kharid', x: 3293, z: 3190, r: 35 },
    { say: 'karamja', x: 2900, z: 3160, r: 50 },
    { say: 'port sarim', x: 3030, z: 3220, r: 18 },
    { say: 'rimmington', x: 2957, z: 3215, r: 18 },
    { say: 'barb village', x: 3082, z: 3420, r: 15 },
    { say: 'catherby', x: 2809, z: 3436, r: 22, members: true },
    { say: 'seers', x: 2720, z: 3480, r: 22, members: true },
    { say: 'ardy', x: 2662, z: 3305, r: 40, members: true },
    { say: 'yanille', x: 2560, z: 3090, r: 25, members: true },
    { say: 'camelot', x: 2757, z: 3500, r: 18, members: true },
    { say: 'taverley', x: 2900, z: 3440, r: 18, members: true }
];
/** a {dest} is said within this many reaches of it (and not inside it) */
const DEST_REACH = 1.6;

/** the place (x, z) is in (the one it is deepest in), on the ground; null out in the open, upstairs or underground */
export function placeAt(x: number, z: number, level: number): SlotPlace | null {
    if (level !== 0 || z >= 6400) return null;
    let best: SlotPlace | null = null;
    let depth = Infinity;
    for (const p of SLOT_PLACES) {
        const d = Math.max(Math.abs(x - p.x), Math.abs(z - p.z)) / p.r;
        if (d <= 1 && d < depth) {
            best = p;
            depth = d;
        }
    }
    return best;
}

/** where a walker at (x, z) heading for (dx, dz) is going, said in the last stretch only; null otherwise */
export function destAt(x: number, z: number, level: number, dx: number, dz: number): SlotPlace | null {
    if (level !== 0 || z >= 6400 || dz >= 6400) return null;
    const there = placeAt(dx, dz, 0);
    if (!there || placeAt(x, z, level) === there) return null;
    const d = Math.max(Math.abs(x - there.x), Math.abs(z - there.z));
    return d > there.r && d <= there.r * DEST_REACH ? there : null;
}

// ── targets, skills, unlocks ─────────────────────────────────────────────────

/** a step's target (port/BotLines stepTargets) as players said it, plural where they said it so */
const TARGET_SAY: Readonly<Record<string, string>> = {
    oak: 'oaks', willow: 'willows', maple: 'maples', yew: 'yews', 'magic tree': 'magics', tree: 'trees',
    copper: 'copper', tin: 'tin', iron: 'iron', coal: 'coal', silver: 'silver', gold: 'gold', mith: 'mith', addy: 'addy', 'rune-ore': 'rune', clay: 'clay', ess: 'ess',
    shrimp: 'shrimps', anchovies: 'anchovies', sardine: 'sardines', herring: 'herring', trout: 'trout', salmon: 'salmon', pike: 'pike', tuna: 'tuna', lobster: 'lobs', swordfish: 'swordies', shark: 'sharks',
    man: 'men', woman: 'women', 'al kharid warrior': 'al kharid warriors', barbarian: 'barbs', dwarf: 'dwarves', wolf: 'wolves', 'white wolf': 'white wolves', 'giant rat': 'rats', 'giant spider': 'spiders',
    flax: 'flax', wool: 'wool', leather: 'leather', 'gold ring': 'gold rings', gems: 'gems'
};
/** the kinds whose targets are monsters or people (a name not in TARGET_SAY takes an "s") */
const NPC_KINDS = new Set(['Combat', 'Thieve', 'RangedMagic']);

/** what it works on, as said: "willows", "lobs", "al kharid warriors"; null when there is nothing to name */
export function targetSay(kind: string, targets: readonly string[]): string | null {
    const t = targets[0];
    if (!t || t === 'stall' || t === 'ranged' || t === 'magic') return null;
    const said = TARGET_SAY[t];
    if (said) return said;
    if (!NPC_KINDS.has(kind) || !/^[a-z ]+$/.test(t) || t.length > 20) return null;
    if (t.endsWith('y') && !/[aeiou]y$/.test(t)) return `${t.slice(0, -1)}ies`;
    if (/(s|x|ch|sh)$/.test(t)) return `${t}es`;
    return `${t}s`;
}

/** the stats a slot's {skill} and {n} may be about (the engine's PlayerStat numbers) */
const STAT = { attack: 0, defence: 1, strength: 2, hitpoints: 3, ranged: 4, prayer: 5, magic: 6, cooking: 7, woodcutting: 8, fletching: 9, fishing: 10, firemaking: 11, crafting: 12, smithing: 13, mining: 14, herblore: 15, agility: 16, thieving: 17, runecraft: 20 } as const;

/** a task kind's skill as players named it, and its stat */
const TASK_SKILL: Readonly<Record<string, [string, number]>> = {
    Woodcut: ['wc', STAT.woodcutting],
    Mine: ['mining', STAT.mining],
    Fish: ['fishing', STAT.fishing],
    Cook: ['cooking', STAT.cooking],
    Smith: ['smithing', STAT.smithing],
    Thieve: ['thieving', STAT.thieving],
    Agility: ['agility', STAT.agility],
    Firemaking: ['fm', STAT.firemaking],
    Fletching: ['fletching', STAT.fletching],
    BowStringing: ['fletching', STAT.fletching],
    Crafting: ['crafting', STAT.crafting],
    'Pick Flax': ['crafting', STAT.crafting],
    Runecrafting: ['rc', STAT.runecraft],
    Herblore: ['herb', STAT.herblore],
    Prayer: ['prayer', STAT.prayer]
};

/**
 * What levels unlock, as 2004's players counted down to them (each skill's: the level and what it opens, the words they
 * used). The F2P ones first; the members' where a members world has them.
 */
const UNLOCKS: Readonly<Record<string, readonly [number, string, boolean?][]>> = {
    wc: [[15, 'oaks'], [30, 'willows'], [45, 'maples', true], [60, 'yews'], [75, 'magics', true]],
    fm: [[15, 'oaks'], [30, 'willows'], [45, 'maples', true], [60, 'yews'], [75, 'magics', true]],
    mining: [[15, 'iron'], [20, 'silver'], [30, 'coal'], [40, 'gold'], [55, 'mith'], [70, 'addy'], [85, 'rune']],
    fishing: [[5, 'sardines'], [20, 'trout'], [30, 'salmon'], [35, 'tuna'], [40, 'lobs'], [50, 'swordies'], [76, 'sharks', true]],
    cooking: [[15, 'trout'], [25, 'salmon'], [30, 'tuna'], [40, 'lobs'], [45, 'swordies'], [80, 'sharks', true]],
    smithing: [[15, 'iron'], [30, 'steel'], [40, 'gold'], [50, 'mith'], [70, 'addy'], [85, 'rune']],
    thieving: [[5, 'cake stalls', true], [10, 'farmers', true], [25, 'warrior women', true], [38, 'master farmers', true], [40, 'guards', true], [55, 'knights', true]],
    fletching: [[5, 'longbows', true], [20, 'oak shortbows', true], [35, 'willow shortbows', true], [50, 'maple shortbows', true], [65, 'yew shortbows', true]],
    crafting: [[5, 'gold rings'], [20, 'sapphires'], [27, 'emeralds'], [34, 'rubies'], [43, 'diamonds']],
    rc: [[2, 'mind runes'], [5, 'water runes'], [9, 'earth runes'], [14, 'fire runes'], [35, 'chaos runes', true], [44, 'nats', true], [54, 'laws', true]],
    prayer: [[25, 'protect item'], [37, 'protect from mage'], [40, 'protect from missiles'], [43, 'protect from melee']],
    att: [[5, 'steel'], [10, 'black'], [20, 'mith'], [30, 'addy'], [40, 'rune'], [60, 'dragon', true]],
    def: [[5, 'steel'], [10, 'black'], [20, 'mith'], [30, 'addy'], [40, 'rune'], [60, 'dragon', true]],
    // (no "bows", "fire" or a town's name: the humanlike report's H8 would read them as another skill's or a place's)
    range: [[20, 'studded'], [40, 'green dhide'], [50, 'blue dhide', true], [60, 'red dhide', true], [70, 'black dhide', true]],
    mage: [[17, 'wind bolt'], [21, 'low alch'], [33, 'tele grab'], [43, 'superheat'], [55, 'high alch']]
};

/** the next unlock above `level` in a skill (as said), or null at the top of its list */
export function nextUnlock(skill: string, level: number, members: boolean): { next: number; unlock: string } | null {
    for (const [at, what, mem] of UNLOCKS[skill] ?? []) {
        if (at > level && (members || !mem)) return { next: at, unlock: what };
    }
    return null;
}

/** every unlock's words (the word filter's test) */
export function allUnlocks(): string[] {
    return [...new Set(Object.values(UNLOCKS).flatMap(list => list.map(([, what]) => what)))];
}

/** the next axe or pickaxe for a level (2004's: steel 6, mith 21, addy 31, rune 41), or null at rune */
function nextTool(level: number, tool: 'axe' | 'pick'): string | null {
    for (const [at, metal] of [[6, 'steel'], [21, 'mith'], [31, 'addy'], [41, 'rune']] as const) if (level < at) return `${metal} ${tool}`;
    return null;
}
/** the next scimitar for an attack level (2004's ladder), or a goal past it */
function nextWeapon(attack: number, members: boolean): string {
    for (const [at, metal] of [[5, 'steel'], [10, 'black'], [20, 'mith'], [30, 'addy'], [40, 'rune']] as const) if (attack < at) return `${metal} scim`;
    return members && attack < 60 ? 'dragon long' : members ? 'dragon med' : 'full rune';
}

/** a drop's item as players named it ("Rune med helm" → "rune med", "Nature rune" → "nat"), or null when it is no word */
export function itemSay(name: string): string | null {
    let s = name.toLowerCase().trim();
    const exact: Record<string, string> = { 'nature rune': 'nat', 'law rune': 'law', 'big bones': 'big bones', 'uncut sapphire': 'sapphire', 'uncut emerald': 'emerald', 'uncut ruby': 'ruby', 'uncut diamond': 'diamond', 'clue scroll': 'clue' };
    if (exact[s]) return exact[s];
    s = s
        .replace(/^adamant(ite)?\b/, 'addy')
        .replace(/^mithril\b/, 'mith')
        .replace(/\bmed helm\b|\bmedium helm\b/, 'med')
        .replace(/\bkiteshield\b/, 'kite')
        .replace(/\bsq shield\b|\bsquare shield\b/, 'sq')
        .replace(/\bscimitar\b/, 'scim')
        .replace(/\blongsword\b/, 'long')
        .replace(/\bbattleaxe\b/, 'baxe')
        .replace(/\b2h sword\b/, '2h')
        .replace(/\bplatebody\b/, 'plate')
        .replace(/\bplatelegs\b/, 'legs');
    return /^[a-z0-9 ]{3,18}$/.test(s) ? s : null;
}

// ── the slots of a moment ────────────────────────────────────────────────────

export interface SlotState {
    kind: string;
    action: string | null;
    targets: readonly string[];
    x: number;
    z: number;
    level: number;
    members: boolean;
    moving: boolean;
    /** its base levels (the engine's PlayerStat order) */
    levels: ArrayLike<number>;
    /** where its task's step is (a walker's destination), or null */
    stepAt: readonly [number, number] | null;
    /** a drop it picked up lately (the 'drop', 'rune-drop' or 'big-bones' event's item), as named, or null */
    drop: string | null;
}

/** The slots that can be filled now, and their values (port/BotLines contextOf). */
export function slotValues(s: SlotState): SlotValues {
    const out: SlotValues = {};
    const here = placeAt(s.x, s.z, s.level);
    if (here && (s.members || !here.members)) out.place = here.say;
    if (s.moving && s.stepAt) {
        const there = destAt(s.x, s.z, s.level, s.stepAt[0], s.stepAt[1]);
        if (there && (s.members || !there.members)) out.dest = there.say;
    }
    const target = targetSay(s.kind, s.targets);
    if (target) out.target = target;
    let skill: string | null = null;
    let level = 0;
    if (TASK_SKILL[s.kind]) {
        [skill] = TASK_SKILL[s.kind];
        level = s.levels[TASK_SKILL[s.kind][1]] ?? 0;
    } else if (s.kind === 'Combat') {
        // (a fighter trains the lowest of its melee stats, as most did)
        const att = s.levels[STAT.attack] ?? 1;
        const str = s.levels[STAT.strength] ?? 1;
        const def = s.levels[STAT.defence] ?? 1;
        if (att <= str && att <= def) [skill, level] = ['att', att];
        else if (str <= def) [skill, level] = ['str', str];
        else [skill, level] = ['def', def];
    } else if (s.kind === 'RangedMagic') {
        [skill, level] = s.action === 'ranged' ? ['range', s.levels[STAT.ranged] ?? 1] : ['mage', s.levels[STAT.magic] ?? 1];
    }
    if (skill && level >= 1 && level < 99) {
        out.skill = skill;
        out.n = String(level);
        const unlock = nextUnlock(skill, level, s.members);
        if (unlock && unlock.next - level <= 15) {
            out.next = String(unlock.next);
            out.unlock = unlock.unlock;
        }
    }
    if (s.drop) out.item = s.drop;
    const want = s.kind === 'Woodcut' ? nextTool(s.levels[STAT.woodcutting] ?? 1, 'axe') : s.kind === 'Mine' ? nextTool(s.levels[STAT.mining] ?? 1, 'pick') : s.kind === 'Combat' ? nextWeapon(s.levels[STAT.attack] ?? 1, s.members) : null;
    if (want) out.want = want;
    return out;
}

/** every value a slot can take (the word filter's test: each line with each value) */
export function slotSamples(): Record<Slot, string[]> {
    return {
        place: SLOT_PLACES.map(p => p.say),
        dest: SLOT_PLACES.map(p => p.say),
        target: [...new Set(Object.values(TARGET_SAY))].concat(['cows', 'chickens', 'goblins', 'guards', 'hill giants', 'moss giants', 'skeletons', 'zombies', 'scorpions', 'dark wizards', 'black knights', 'lesser demons', 'farmers', 'ice warriors', 'ice giants', 'druids', 'monks', 'imps', 'bears', 'unicorns']),
        skill: [...new Set(Object.values(TASK_SKILL).map(([s]) => s)), 'att', 'str', 'def', 'range', 'mage'],
        n: ['1', '5', '13', '29', '40', '43', '58', '71', '98'],
        next: [...new Set(Object.values(UNLOCKS).flatMap(list => list.map(([at]) => String(at))))],
        unlock: allUnlocks(),
        item: ['rune med', 'nat', 'law', 'big bones', 'addy kite', 'mith sq', 'rune 2h', 'sapphire', 'ruby', 'diamond', 'rune baxe', 'addy long', 'clue', 'coal', 'iron ore', 'death rune', 'rune scim', 'dragon med'],
        want: ['steel axe', 'mith axe', 'addy axe', 'rune axe', 'steel pick', 'mith pick', 'addy pick', 'rune pick', 'steel scim', 'black scim', 'mith scim', 'addy scim', 'rune scim', 'dragon long', 'dragon med', 'full rune'],
        clan: []
    };
}
