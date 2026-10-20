// port (the variety work, round 1, Track D: DO-6, a favourite activity and a home spot; DO-12, power-dropping): what a
// bot likes to do and where it lives, from its name, the same at every login and never saved (as port/BotPersona and
// port/BotAge). The research: 20-23 of 26-30 bots named for an activity
// (yew_cutter, fish_fanatic, coal_digger, cake_thief ...) spent none of their time on it, and nothing a bot did carried
// over from one session to the next. A 2004 player was "the guy who's always at the Catherby lobsters".
//
//   theme       a name with an activity word takes it (themeOf: the word tables below, first match wins): yew_cutter
//               woodcutting at yew spots, lobster_lou fishing lobsters, cake_thief the baker's stall, coal_digger coal,
//               ess_miner essence. A bot under its theme's level trains toward it (the theme only weighs the steps its
//               level allows: willows first). The planner picks the theme first THEME_FIRST of the time, and weighs it
//               THEME_WEIGHT in its shuffle (BotGoalPlanner._buildCandidates); its spot preference weighs PREFER_WEIGHT.
//   favourites  every levelling bot's 1-2 favourite skills: the theme's, else drawn from its planner's weights; weighed
//               FAVOURITE_WEIGHT in the shuffle.
//   home        a town it lives about (HOMES, by 2004's crowds), whose spots (within HOME_TILES) weigh HOME_WEIGHT in
//               the planner's picks (BotKnowledge pickNear's `weigh`); on a free world a free town.
//   dropper     about 1 gatherer in 5 (DROPPER_SHARE) power-trains: it drops willows, oaks, iron and shrimp one by one
//               where it stands instead of banking them (the gathering tasks' full-pack branch, dropLoad).
//
// Each from a seed of its own (port/BotSeed nameSeed: 'favourites', 'home', 'powerdrop'), so no other trait of any name
// changes. Behaviour stays on Math.random (the planner's dice), never the time of day.
import type Player from '#/engine/entity/Player.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { normalizeBotName } from '#/engine/bot/port/BotRoster.js';
import { Items, type SkillStep } from '#/engine/bot/BotKnowledge.js';

/**
 * the share of themed bots' picks that go to the theme first (else it is one more candidate, weighed THEME_WEIGHT). A bot
 * makes a few picks an evening (15-60 minute plans): at 0.6 the median themed bot spent 11.5-95 % of its time on its
 * theme, run to run (AM4); at 0.75 most picks are its name's
 */
export const THEME_FIRST = 0.75;
/** a themed bot's theme skill, a favourite skill: their weight's factor in the planner's shuffle */
export const THEME_WEIGHT = 4;
export const FAVOURITE_WEIGHT = 3;
/** a theme's own spots (yews for yew_cutter), a bot's home town's: their factor in its picks */
export const PREFER_WEIGHT = 4;
export const HOME_WEIGHT = 3;
/** how near a step is to its home town to count as its home's (tiles) */
export const HOME_TILES = 100;
/** the share of gatherers that power-train (about 20 %, per persona) */
export const DROPPER_SHARE = 0.2;

/** what a theme says: its skills (the first is the theme), and the steps it prefers (by what they give, or their stall) */
export interface Theme {
    word: string;
    skills: string[];
    /** the items its steps give (yew logs, raw lobster); none: any of the skill's */
    gains?: number[];
    /** a stall's or a monster's name its steps use (the baker's stall) */
    target?: string;
}

/** [name pattern on the engine's form of the name (lower case, words by _), the theme]; the first that matches wins */
const THEMES: readonly [RegExp, Theme | null][] = [
    // (not themes: a food, a toy, a weapon)
    [/(^|_)(fish_n_chips|fish_fingers?|shark_eater|shark_muncha|goldfish|jellyfish|war_hammer|spinning_top)(_|$)/, null],
    // thieving (members in 274): a cake thief at the baker's stall, a silk stealer at the silk stall
    [/(^|_)cake_thief(_|$)/, { word: 'cake', skills: ['THIEVING'], target: 'bakers_stall_stealing' }],
    [/(^|_)silk_stealer(_|$)/, { word: 'silk', skills: ['THIEVING'], target: 'silk_stall_stealing' }],
    [/(^|_)(thief|thieve|thiever|steal|stealer|pickpocket|pick_pocket|lock_picker|burglar|robber)(_|$)/, { word: 'thief', skills: ['THIEVING'] }],
    // runecrafting and essence
    [/(^|_)(ess|ess_miner|ess_runner|pure_ess|rune_crafter|runecraft|runecrafter|talisman)(_|$)/, { word: 'essence', skills: ['RUNECRAFT'] }],
    // fletching (before the trees: yew_longbow is a fletcher's)
    [/(^|_)(fletch|fletcher|fletch_dude|bow_maker|bow_stringer|arrow_maker|arrow_shafts|longbow|longbow_lad)(_|$)/, { word: 'fletch', skills: ['FLETCHING'] }],
    // firemaking (before the trees: log_burner burns them)
    [/(^|_)(log_burner|fire_starter|firestarter|bonfire|pyro|firemaker)(_|$)/, { word: 'fire', skills: ['FIREMAKING'] }],
    // cooking (before the fish: burnt_shrimp and cooked_trout cook them)
    [/(^|_)(cook|cooker|chef|baker|pie_maker|burnt|cooked|lvl_99_cook)(_|$)/, { word: 'cook', skills: ['COOKING'] }],
    // crafting (before the trees: gem_cutter cuts gems)
    [/(^|_)(gem_cutter|gem_finder|uncut|craft|crafter|crafty|wool|wool_spinner|spinner|spinning|flax|flax_picker|flax_spinner)(_|$)/, { word: 'craft', skills: ['CRAFTING'] }],
    // woodcutting, by the tree it names
    [/(^|_)yew(_|$)|(^|_)yews(_|$)/, { word: 'yew', skills: ['WOODCUTTING'], gains: [Items.YEW_LOGS] }],
    [/(^|_)willow(_|$)/, { word: 'willow', skills: ['WOODCUTTING'], gains: [Items.WILLOW_LOGS] }],
    [/(^|_)maple(_|$)/, { word: 'maple', skills: ['WOODCUTTING'], gains: [Items.MAPLE_LOGS] }],
    [/(^|_)oak(_|$)|(^|_)oak_log(_|$)/, { word: 'oak', skills: ['WOODCUTTING'], gains: [Items.OAK_LOGS] }],
    [/(^|_)magic_log(s|ger)?(_|$)/, { word: 'magic logs', skills: ['WOODCUTTING'], gains: [Items.MAGIC_LOGS] }],
    [/(^|_)(woodcut|woodcutter|woodcut_wiz|lumberjack|lumber|logger|chop|chopper|chop_chop|powerchop|tree_hugger|tree_feller|log_lady|axeman|woody\d*)(_|$)/, { word: 'wood', skills: ['WOODCUTTING'] }],
    // fishing, by the fish it names
    [/(^|_)(lobster|lobby)(_|$)/, { word: 'lobster', skills: ['FISHING'], gains: [Items.RAW_LOBSTER] }],
    [/(^|_)shark(_|$)/, { word: 'shark', skills: ['FISHING'], gains: [Items.RAW_SHARK, Items.RAW_SWORDFISH, Items.RAW_TUNA] }],
    [/(^|_)(swordfish|harpoon|tuna)(_|$)/, { word: 'harpoon', skills: ['FISHING'], gains: [Items.RAW_SWORDFISH, Items.RAW_TUNA] }],
    [/(^|_)(trout|salmon|fly_fisher|barb_fisher)(_|$)/, { word: 'fly', skills: ['FISHING'], gains: [Items.RAW_TROUT, Items.RAW_SALMON] }],
    [/(^|_)(shrimp|shrimps|shrimps_4u|net_fisher|big_net|shrimp_net)(_|$)/, { word: 'shrimp', skills: ['FISHING'], gains: [Items.RAW_SHRIMP] }],
    [/(^|_)(fish|fisher|fishing|fishin|fishy|fish_master|fish_fanatic|angler|born_2_fish|afk_fisher|bait|bait_bucket|bait_shop|bait_barry)(_|$)/, { word: 'fish', skills: ['FISHING'] }],
    // mining, by the ore it names
    [/(^|_)coal(_|$)/, { word: 'coal', skills: ['MINING'], gains: [Items.COAL] }],
    [/(^|_)(mith|mithril)_miner(_|$)|(^|_)mith_miner(_|$)/, { word: 'mithril', skills: ['MINING'], gains: [Items.MITHRIL_ORE] }],
    [/(^|_)(addy_ore|ore_hoarder)(_|$)/, { word: 'ore', skills: ['MINING'], gains: [Items.ADAMANTITE_ORE, Items.MITHRIL_ORE] }],
    [/(^|_)(gold_miner|gold_ore|gold_ore_gus|gold_digger)(_|$)/, { word: 'gold', skills: ['MINING'], gains: [Items.GOLD_ORE] }],
    [/(^|_)iron_ore(_|$)/, { word: 'iron', skills: ['MINING'], gains: [Items.IRON_ORE] }],
    [/(^|_)(copper|tin_ore)(_|$)/, { word: 'copper', skills: ['MINING'], gains: [Items.COPPER_ORE, Items.TIN_ORE] }],
    [/(^|_)(miner|mining|digger|power_miner|rock_crusher|pickaxe|pick_axe|rune_miner)(_|$)/, { word: 'mine', skills: ['MINING'] }],
    // smithing
    [/(^|_)(smith|smithy|smithing|blacksmith|goldsmith|mith_smith|anvil|hammer_time|hammer_holly|iron_bars|silver_bars)(_|$)/, { word: 'smith', skills: ['SMITHING'] }],
    // agility
    [/(^|_)(agility|agile|gnome_runner)(_|$)/, { word: 'agility', skills: ['AGILITY'] }],
    // ranged and magic (a fighter's names: they train the style)
    [/(^|_)(ranger|range|archer|bowman)(_|$)/, { word: 'range', skills: ['RANGED'] }],
    [/(^|_)(mage|wizard|sorcerer|sorceress|warlock|witch|spell_caster|spell_binder)(_|$)/, { word: 'mage', skills: ['MAGIC'] }]
];

const themeMemo = new Map<string, Theme | null>();

/** The theme a bot's name gives (null: none): the same for the same name every time. */
export function themeOf(name: string): Theme | null {
    const key = normalizeBotName(name);
    let theme = themeMemo.get(key);
    if (theme === undefined) {
        theme = null;
        for (const [re, t] of THEMES) {
            if (re.test(key)) {
                theme = t;
                break;
            }
        }
        themeMemo.set(key, theme);
    }
    return theme;
}

/** Does this step suit the theme's own spots (its fish, its tree, its ore, its stall)? A theme without one: every step. */
export function themeStep(theme: Theme, step: SkillStep): boolean {
    if (theme.gains && !(step.itemGained !== undefined && theme.gains.includes(step.itemGained))) return false;
    if (theme.target) {
        const extra = step.extra as { locName?: string; npcName?: string } | undefined;
        if (extra?.locName !== theme.target && extra?.npcName !== theme.target) return false;
    }
    return true;
}

// ── favourites ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A levelling bot's favourite skills (1-2): its theme's first, else drawn from the weights it is given (its planner's). */
export function favouritesOf(name: string, weights: Readonly<Partial<Record<string, number>>>): string[] {
    const key = normalizeBotName(name);
    const r = seededRandom(nameSeed(key, 'favourites'));
    const theme = themeOf(key);
    const out: string[] = theme ? [theme.skills[0]] : [];
    const want = theme ? (r() < 0.4 ? 2 : 1) : r() < 0.5 ? 2 : 1;
    const entries = Object.entries(weights).filter(([skill, w]) => (w ?? 0) > 0 && !out.includes(skill)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    while (out.length < want && entries.length > 0) {
        const total = entries.reduce((s, [, w]) => s + (w ?? 0), 0);
        let roll = r() * total;
        let i = entries.length - 1;
        for (let j = 0; j < entries.length; j++) {
            roll -= entries[j][1] ?? 0;
            if (roll <= 0) {
                i = j;
                break;
            }
        }
        out.push(entries[i][0]);
        entries.splice(i, 1);
    }
    return out;
}

// ── home ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The towns a bot lives about, their middles and how many of 2004's players did (members: members-only towns) */
export const HOMES: readonly { key: string; x: number; z: number; weight: number; members: boolean }[] = [
    { key: 'lumbridge', x: 3222, z: 3240, weight: 14, members: false },
    { key: 'draynor', x: 3093, z: 3250, weight: 12, members: false },
    { key: 'varrock', x: 3212, z: 3428, weight: 18, members: false },
    { key: 'falador', x: 2990, z: 3370, weight: 14, members: false },
    { key: 'barbarian_village', x: 3082, z: 3435, weight: 8, members: false },
    { key: 'edgeville', x: 3094, z: 3491, weight: 7, members: false },
    { key: 'al_kharid', x: 3290, z: 3200, weight: 10, members: false },
    { key: 'port_sarim', x: 3015, z: 3215, weight: 6, members: false },
    { key: 'catherby', x: 2810, z: 3436, weight: 13, members: true },
    { key: 'seers', x: 2720, z: 3480, weight: 12, members: true },
    { key: 'ardougne', x: 2650, z: 3300, weight: 10, members: true },
    { key: 'taverley', x: 2895, z: 3445, weight: 3, members: true }
];

function drawHome(r: () => number, members: boolean): (typeof HOMES)[number] {
    const pool = HOMES.filter(h => members || !h.members);
    const total = pool.reduce((s, h) => s + h.weight, 0);
    let roll = r() * total;
    for (const h of pool) {
        roll -= h.weight;
        if (roll < 0) return h;
    }
    return pool[pool.length - 1];
}

/** The bot's home town (deterministic): its first draw on a members world, a free town on a free world. */
export function homeOf(name: string, members: boolean): (typeof HOMES)[number] {
    const r = seededRandom(nameSeed(normalizeBotName(name), 'home'));
    const first = drawHome(r, true);
    return members || !first.members ? first : drawHome(r, false);
}

/** Is a step's spot (on the surface: a dungeon's by its way in) within HOME_TILES of the town? */
export function nearHome(home: { x: number; z: number }, surface: [number, number]): boolean {
    return Math.max(Math.abs(surface[0] - home.x), Math.abs(surface[1] - home.z)) <= HOME_TILES;
}

// ── power-dropping ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Does this bot power-train (drop its load where it stands instead of banking it)? About 1 in 5 (DROPPER_SHARE). */
export function isDropper(name: string): boolean {
    return seededRandom(nameSeed(normalizeBotName(name), 'powerdrop'))() < DROPPER_SHARE;
}

/**
 * What a power-trainer drops (2004's power-training: Tip.it's "drop the willows"; iron for Mining; shrimps and anchovies
 * for Fishing): the cheap loads a player did not bother to bank. Never anything else.
 */
export const DROPPED_LOADS: ReadonlySet<number> = new Set([Items.WILLOW_LOGS, Items.OAK_LOGS, Items.LOGS, Items.IRON_ORE, Items.RAW_SHRIMP, Items.RAW_ANCHOVIES]);

/** Does this bot drop this step's load now (a power-trainer, and a load it drops)? */
export function dropsLoad(player: Player, step: SkillStep): boolean {
    return step.itemGained !== undefined && DROPPED_LOADS.has(step.itemGained) && player.is_bot === true && isDropper(player.username);
}
