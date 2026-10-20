// port: a bot world that starts with a mix of levels (BOTS.md §4.4). When the bot store is new (no bots.sav), the
// bots created with it get an age: stats, kit and a start tile that fit it, so the world has newbies and veterans from
// the first minute instead of N level-3 accounts at the Lumbridge spawn. Bots that join later (newcomers) start fresh.
// The age is a pure function of the bot's name, so a bot that leaves before its first save comes back the same.
//
// How a bot is aged (applyAge, once, before its first tick):
//   tier      from its name: newcomer 25 %, novice 25 %, intermediate 25 %, experienced 18 %, veteran 7 % (AGE_TIERS)
//   XP        a total in the tier's range, split over the skills by its planner's weights (BotGoalPlanner
//             Personalities; 'random' gets weights from its name, social and vendor bots the balanced ones), each
//             weight shaken by ±50 %; Hitpoints 1,154 + a third of the combat XP; Herblore at least 3; on a free world
//             no members skill (they stay at 1, Herblore 3), so the total is lower there
//   kit       the scimitar its Attack allows and the armour its Defence allows, worn; the axe and pickaxe its levels
//             allow, in the pack (InitTask then skips the bronze ones); fishing gear, bow and arrows, staff and runes
//             for its levels and some cooked food in the bank; a few coins and one stack of what it gathers. InitTask
//             still runs on its first tick (200 coins, starter tools, the bank seed: not what it already has)
//   tile      a walkable tile by a bank that suits its tier (Draynor and Al Kharid for novices; Varrock, Falador and
//             Edgeville later; Catherby, Seers and Ardougne on a members world), reachable from that bank; on a free
//             world only free banks
// PKers set their own levels and gear (their tasks' profiles): they are not aged. Social and vendor bots never gain
// XP: they get the levels of their tier (cosmetic), no kit, and keep the Lumbridge spawn (their tasks walk them).
//
// port (the realism work, phase 4: looks; "patchwork gear" and "rares and veterans"): what an aged bot wears
// (agedLook) is no longer its level's whole matching set (52-54 % of the bots in one, 0 % with a cape, amulet, gloves,
// boots or hat): per piece the kind it likes (port/BotLooks gearTaste: a full or medium helm, a platebody or a
// chainbody, platelegs or a plateskirt, a kite or square shield, or none), the metal its Defence allows or one to three
// below it (bought piece by piece; about 3 in 10 wear a matching set), a piece missing now and then; a skiller (most
// skillers, some balanced and random bots) with its plate in its bank and a hat, an apron, a cape, boots or gloves on;
// from combat 20 the accessories it likes (a cape, gloves, boots; from 40 an amulet of strength or power, a members
// veteran's now and then a glory); the scimitar its Attack allows in hand (the starter weapon's place: it used to stay,
// and the scimitar was lost); the rare of the few who own one (port/BotLooks rareOf: about 1 bot in 60, experienced and
// veteran only) and a veteran's 2003 bunny ears or scythe (about 1 in 4) on top of it all; about 1 veteran in 4 at combat
// 100-120 (agedStats; not the skillers). Social and vendor bots get a look too (worn only: no kit in the pack or bank). New bots only: a
// saved bot keeps what it has.
//
// port (the realism work, phase 5a: teleport spells and alching): from Magic 25 laws and elemental runes, from Magic 55
// natures, a staff of fire and what it made to alch (magicKit; a seed of its own). New bots only: a
// saved bot gets no runes and keeps what it owns.
import type Player from '#/engine/entity/Player.js';
import { getExpByLevel, getLevelByExp } from '#/engine/entity/Player.js';
import { PlayerStat, PlayerStatMap } from '#/engine/entity/PlayerStat.js';
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import World from '#/engine/World.js';
import { isMapBlocked, isZoneAllocated } from '#/engine/GameMap.js';
import rsmod, { CollisionType } from '#/engine/routefinder/index.js';
import { Personalities } from '#/engine/bot/BotGoalPlanner.js';
import { Items, Locations, AxesByLevel, PickaxesByLevel, RangedBowsByLevel } from '#/engine/bot/BotKnowledge.js';
import { SCIMITAR_TIERS } from '#/engine/bot/tasks/CombatTask.js';
import { MEMBERS_SKILLS } from '#/engine/bot/port/BotWorldRules.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import type { PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { armourPieceOf, canWearPiece, clanColourOf, gearTaste, holidayOf, isSignatureHat, isTopVeteran, metalForDefence, pieceOf, rareOf, skillerLook, wardrobeItems, TOP_COMBAT, type ArmourPiece, type PieceKind } from '#/engine/bot/port/BotLooks.js';
// (the variety work, round 2, track W2: fashion) status gear, members fashion, novelty pieces, each on a seed of its own
import { battlestaffOf, membersFashionOf, noveltyOf, statusKitOf } from '#/engine/bot/port/BotFashion.js';
import {
    chefsHatAnywhere,
    combatStyleOf,
    dragonWeaponOf,
    magePieces,
    mainSkillOf,
    nameClassOf,
    outfitItems,
    pirateHatFor,
    prayerTrainer,
    rangerPieces,
    richRuneWeaponOf,
    skillClothesOf,
    toolWieldAttack,
    trainerWants,
    weaponKindOf,
    weaponMetalForAttack,
    weaponOf
} from '#/engine/bot/port/BotOutfits.js';

export type AgeTier = 'newcomer' | 'novice' | 'intermediate' | 'experienced' | 'veteran';

export interface AgeTierSpec {
    tier: AgeTier;
    /** share of the aged planners' bots */
    share: number;
    /** total XP (as players see it: no ×10), split over the skills; [0, 0] = fresh */
    xp: [number, number];
    /** coins in the bank */
    coins: [number, number];
    /** banks (Locations keys) a bot of this tier starts by */
    banks: (keyof typeof Locations)[];
}

export const AGE_TIERS: readonly AgeTierSpec[] = [
    { tier: 'newcomer', share: 0.25, xp: [0, 0], coins: [0, 0], banks: [] },
    { tier: 'novice', share: 0.25, xp: [10_000, 60_000], coins: [100, 1_500], banks: ['DRAYNOR_BANK', 'AL_KHARID_BANK', 'VARROCK_EAST_BANK', 'FALADOR_EAST_BANK'] },
    { tier: 'intermediate', share: 0.25, xp: [60_000, 300_000], coins: [1_000, 15_000], banks: ['VARROCK_WEST_BANK', 'VARROCK_EAST_BANK', 'DRAYNOR_BANK', 'FALADOR_EAST_BANK', 'FALADOR_WEST_BANK', 'EDGEVILLE_BANK', 'AL_KHARID_BANK'] },
    { tier: 'experienced', share: 0.18, xp: [300_000, 1_200_000], coins: [10_000, 60_000], banks: ['VARROCK_WEST_BANK', 'FALADOR_WEST_BANK', 'FALADOR_EAST_BANK', 'EDGEVILLE_BANK', 'CATHERBY_BANK', 'SEERS_BANK', 'ARDOUGNE_SOUTH_BANK'] },
    { tier: 'veteran', share: 0.07, xp: [1_500_000, 5_000_000], coins: [40_000, 200_000], banks: ['EDGEVILLE_BANK', 'FALADOR_WEST_BANK', 'VARROCK_WEST_BANK', 'SEERS_BANK', 'CATHERBY_BANK', 'ARDOUGNE_SOUTH_BANK', 'YANILLE_BANK'] }
];

const PKERS: ReadonlySet<PlannerKey> = new Set<PlannerKey>(['extras_pker', 'extras_edgeville_pker']);
const COSMETIC: ReadonlySet<PlannerKey> = new Set<PlannerKey>(['extras_social', 'extras_vendor']);
const COMBAT_STATS = [PlayerStat.ATTACK, PlayerStat.STRENGTH, PlayerStat.DEFENCE, PlayerStat.RANGED, PlayerStat.MAGIC];
/** Hitpoints 10 (as players see it) */
const BASE_HP_XP = 1154;
const MAX_XP = 13_034_431;

/** The dice of this bot's age: the same for the same name, whatever else happens (Math.random is not used). */
function dice(name: string): () => number {
    return seededRandom(nameSeed(name, 'age'));
}

function between(rand: () => number, [lo, hi]: [number, number]): number {
    return Math.round(lo + (hi - lo) * rand());
}

/** Log-uniform in [lo, hi]: as many 15k-XP novices as 50k ones would be too many at the top of each tier. */
function logBetween(rand: () => number, [lo, hi]: [number, number]): number {
    return Math.round(Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * rand()));
}

/** The tier a bot of this name and planner gets (deterministic). PKers set their own levels: never aged. */
export function ageTierFor(name: string, planner: PlannerKey): AgeTier {
    if (PKERS.has(planner)) return 'newcomer';
    const roll = dice(name)();
    let acc = 0;
    for (const spec of AGE_TIERS) {
        acc += spec.share;
        if (roll < acc) return spec.tier;
    }
    return AGE_TIERS[AGE_TIERS.length - 1].tier;
}

function tierSpec(tier: AgeTier): AgeTierSpec {
    return AGE_TIERS.find(s => s.tier === tier)!;
}

/** The skill weights the bot's XP is split by: its planner's (the random planner's from its name). */
function ageWeights(planner: PlannerKey, rand: () => number): Partial<Record<string, number>> {
    if (planner === 'skiller') return Personalities.SKILLER.weights;
    if (planner === 'fighter') return Personalities.FIGHTER.weights;
    if (planner === 'random') {
        const weights: Record<string, number> = {};
        for (const skill of Object.keys(Personalities.BALANCED.weights)) weights[skill] = 1 + Math.floor(rand() * 20);
        return weights;
    }
    return Personalities.BALANCED.weights;
}

export interface AgedStats {
    tier: AgeTier;
    /** XP ×10 (the engine's unit) per stat */
    xp: number[];
}

/**
 * The stats a bot of this name and planner gets (deterministic): XP per stat in the engine's unit (×10), all 21; a
 * newcomer's (and a PKer's) are null.
 */
export function agedStats(name: string, planner: PlannerKey, members: boolean): AgedStats | null {
    const rand = dice(name);
    const tier = ageTierFor(name, planner); // (the first roll)
    rand();
    if (tier === 'newcomer') return null;
    const spec = tierSpec(tier);
    const total = logBetween(rand, spec.xp);
    const weights = ageWeights(planner, rand);
    const shaken: [number, number][] = [];
    let sum = 0;
    for (const [skill, weight] of Object.entries(weights)) {
        const stat = PlayerStatMap.get(skill);
        if (stat === undefined || !weight || weight <= 0) continue;
        const w = weight * (0.5 + rand());
        sum += w;
        // on a free world a members skill gets no XP: the others keep the share they have on a members world
        if (!members && MEMBERS_SKILLS.has(skill)) continue;
        shaken.push([stat, w]);
    }
    const xp = new Array<number>(21).fill(0);
    for (const [stat, w] of shaken) xp[stat] = Math.min(MAX_XP, Math.round((total * w) / sum));
    let combat = 0;
    for (const stat of COMBAT_STATS) combat += xp[stat];
    xp[PlayerStat.HITPOINTS] = Math.min(MAX_XP, BASE_HP_XP + Math.round(combat / 3));
    // engine units (×10), every stat at least level 1's 0 XP, Herblore at least 3 (Druidic Ritual)
    const out = xp.map(v => v * 10);
    out[PlayerStat.HERBLORE] = Math.max(out[PlayerStat.HERBLORE], getExpByLevel(3));
    // port (the realism work, phase 4: "rares and veterans"): the veteran tier's top, combat 100-120
    if (isTopVeteran(name, tier, planner)) topVeteranXp(name, out);
    return { tier, xp: out };
}

/**
 * port (phase 4): a top veteran's combat stats (about 1 veteran in 4, port/BotLooks TOP_SHARE: about 1 bot in 100), in
 * the engine's unit: Attack, Strength and Defence at the level (each within 4 of it, its own dice) that gives the
 * combat level drawn in TOP_COMBAT (100-120), Prayer 43-70 (the protection prayers), Hitpoints from the combat XP as
 * every aged bot's (1,154 + a third). Its other skills keep their veteran's XP.
 */
function topVeteranXp(name: string, xp: number[]): void {
    const rand = seededRandom(nameSeed(name, 'top-stats'));
    const target = TOP_COMBAT[0] + Math.floor(rand() * (TOP_COMBAT[1] - TOP_COMBAT[0] + 1));
    const jitter = [PlayerStat.ATTACK, PlayerStat.STRENGTH, PlayerStat.DEFENCE].map(stat => [stat, Math.floor(rand() * 9) - 4] as const);
    const prayer = 43 + Math.floor(rand() * 28);
    xp[PlayerStat.PRAYER] = Math.max(xp[PlayerStat.PRAYER], getExpByLevel(prayer));
    const levels = (): number[] => xp.map(v => getLevelByExp(v));
    for (let base = 60; base <= 99; base++) {
        for (const [stat, j] of jitter) xp[stat] = Math.max(xp[stat], getExpByLevel(Math.max(2, Math.min(99, base + j))));
        let combat = 0;
        for (const stat of COMBAT_STATS) combat += xp[stat];
        xp[PlayerStat.HITPOINTS] = Math.min(MAX_XP * 10, BASE_HP_XP * 10 + Math.round(combat / 3));
        if (combatLevelOf(levels()) >= target) return;
    }
}

/** The engine's combat level for these base levels (Player.getCombatLevel). */
export function combatLevelOf(levels: ArrayLike<number>): number {
    const base = 0.25 * (levels[PlayerStat.DEFENCE] + levels[PlayerStat.HITPOINTS] + Math.floor(levels[PlayerStat.PRAYER] / 2));
    const melee = 0.325 * (levels[PlayerStat.ATTACK] + levels[PlayerStat.STRENGTH]);
    const range = 0.325 * (Math.floor(levels[PlayerStat.RANGED] / 2) + levels[PlayerStat.RANGED]);
    const magic = 0.325 * (Math.floor(levels[PlayerStat.MAGIC] / 2) + levels[PlayerStat.MAGIC]);
    return Math.floor(base + Math.max(melee, range, magic));
}

// ── kit ───────────────────────────────────────────────────────────────────────

export interface AgedKit {
    worn: number[];
    pack: [number, number][];
    bank: [number, number][];
}

/** The best entry of a level table the level allows (tables run worst to best), or null. */
function bestFor<T extends { itemId: number; levelReq: number }>(table: readonly T[], level: number, usable: (id: number) => boolean): number | null {
    let best: number | null = null;
    for (const t of table) if (level >= t.levelReq && usable(t.itemId)) best = t.itemId;
    return best;
}

/**
 * The kit a bot with these levels gets (deterministic): see the header. Never a members item on a free world. port
 * (phase 4): what it wears and keeps of its outfit is its look (agedLook; `planner`: a skiller's, the accessories),
 * which used to be its level's matching set and scimitar.
 */
export function agedKit(name: string, tier: AgeTier, levels: ArrayLike<number>, members: boolean, planner: PlannerKey = 'balanced'): AgedKit {
    const rand = seededRandom(nameSeed(name, 'kit'));
    const usable = (id: number): boolean => members || !ObjType.get(id).members;
    const kit: AgedKit = { worn: [], pack: [], bank: [] };
    const level = (stat: PlayerStat): number => levels[stat];
    const big = tier === 'experienced' || tier === 'veteran';

    // worn: its look (port, phase 4); the pieces it took off or keeps under a rare in the bank
    const look = agedLook(name, tier, levels, members, planner);
    kit.worn.push(...look.worn);
    for (const id of look.bank) kit.bank.push([id, 1]);
    // port (the variety work, round 1, track W: WEAR-1): a bot that trains Magic or Ranged and is no mage (no ranger)
    // keeps a wizard hat (a leather body) for those fights now and then (port/BotOutfits trainerWants: a seed of its own)
    const wants = trainerWants(name, level(PlayerStat.MAGIC), level(PlayerStat.RANGED), combatStyleOf(name));
    const has = (id: number): boolean => kit.worn.includes(id) || kit.bank.some(([b]) => b === id);
    const o = outfitItems();
    if (wants.hat && !has(o.blueWizardHat) && !has(o.blackWizardHat)) kit.bank.push([o.blueWizardHat, 1]);
    if (wants.body && ![o.leatherBody, o.hardleatherBody, o.studdedBody, ...o.dhideBodies].some(has)) kit.bank.push([o.leatherBody, 1]);

    // the pack: the axe and pickaxe its levels allow (port, the variety work: not when its hand holds it)
    const axe = bestFor(AxesByLevel, level(PlayerStat.WOODCUTTING), usable);
    if (axe !== null && axe !== Items.BRONZE_AXE && !kit.worn.includes(axe)) kit.pack.push([axe, 1]);
    const pickaxe = bestFor(PickaxesByLevel, level(PlayerStat.MINING), usable);
    if (pickaxe !== null && pickaxe !== Items.BRONZE_PICKAXE && !kit.worn.includes(pickaxe)) kit.pack.push([pickaxe, 1]);

    // the bank: fishing gear for its level (the tasks fetch it)
    const fishing = level(PlayerStat.FISHING);
    if (fishing >= 20) kit.bank.push([Items.FLY_FISHING_ROD, 1], [Items.FEATHER, between(rand, big ? [300, 1000] : [100, 300])]);
    if (fishing >= 35) kit.bank.push([Items.HARPOON, 1]);
    if (fishing >= 40) kit.bank.push([Items.LOBSTER_POT, 1]);

    // a bow and arrows, a staff and runes, when it has trained them
    const ranged = level(PlayerStat.RANGED);
    if (ranged >= 10) {
        const bow = bestFor(RangedBowsByLevel, ranged, usable);
        if (bow !== null && !kit.worn.includes(bow)) kit.bank.push([bow, 1]);
        kit.bank.push([ranged >= 30 ? Items.STEEL_ARROW : ranged >= 20 ? Items.IRON_ARROW : Items.BRONZE_ARROW, between(rand, big ? [300, 800] : [100, 300])]);
    }
    const magic = level(PlayerStat.MAGIC);
    if (magic >= 10) {
        if (!kit.worn.includes(Items.STAFF_OF_AIR)) kit.bank.push([Items.STAFF_OF_AIR, 1]);
        kit.bank.push([Items.MIND_RUNE, between(rand, big ? [300, 800] : [100, 300])]);
        if (magic >= 17) kit.bank.push([Items.CHAOS_RUNE, between(rand, big ? [100, 400] : [20, 100])]);
    }

    // food it has cooked
    const cooking = level(PlayerStat.COOKING);
    const food = cooking >= 45 ? Items.SWORDFISH : cooking >= 40 ? Items.LOBSTER : cooking >= 25 ? Items.SALMON : cooking >= 15 ? Items.TROUT : Items.SHRIMP;
    if (usable(food)) kit.bank.push([food, between(rand, [5, 30])]);

    // one stack of what it gathers most (a few: bankstanding bots sell what they bank)
    const gathering: [PlayerStat, number][] = [
        [PlayerStat.WOODCUTTING, level(PlayerStat.WOODCUTTING) >= 60 ? Items.YEW_LOGS : level(PlayerStat.WOODCUTTING) >= 30 ? Items.WILLOW_LOGS : level(PlayerStat.WOODCUTTING) >= 15 ? Items.OAK_LOGS : Items.LOGS],
        [PlayerStat.MINING, level(PlayerStat.MINING) >= 55 ? Items.MITHRIL_ORE : level(PlayerStat.MINING) >= 30 ? Items.COAL : level(PlayerStat.MINING) >= 15 ? Items.IRON_ORE : Items.COPPER_ORE]
    ];
    gathering.sort((a, b) => level(b[0]) - level(a[0]));
    const [, resource] = gathering[0];
    if (level(gathering[0][0]) >= 10 && usable(resource)) kit.bank.push([resource, between(rand, [10, 40])]);

    // coins
    const coins = between(rand, tierSpec(tier).coins);
    if (coins > 0) kit.bank.push([Items.COINS, coins]);

    // port (the realism work, phase 5a: teleport spells and alching): its runes, last and from a seed of their own, so
    // that nothing above changes for any name
    kit.bank.push(...magicKit(name, tier, levels, members));
    // (the variety work, round 1, Track D: DO-4) Rune Mysteries' air talisman, last and from a seed of its own
    kit.bank.push(...talismanKit(name, tier));
    return kit;
}

/** Tests only (the humanlike runner's --rune-seed=false: a world as saved bots have it, no runes). Never set by the game. */
let runeSeed = true;
export function setRuneSeedForTest(on: boolean): void {
    runeSeed = on;
}

/**
 * port (the realism work, phase 5a, Track M; new bots only: "saved bots keep exactly what they own"):
 * what a new aged bot owns for its spells, in its bank, from its name's seed 'runes' (the rest of its kit is unchanged).
 * From Magic 25 (the Varrock teleport): 10-40 laws (a veteran 50-150; no free shop sells them: the Wizards' Guild is
 * members and Magic 66) and 20-80 each of fire, earth and water (Varrock, Lumbridge, Falador; Ardougne's water); no air:
 * the kit's staff of air pays it (port/BotTeleport wields it for a cast). From Magic 55 (high alchemy): 30-150 natures (a
 * veteran 100-300; none in a shop: runecrafting or a seed), a staff of fire, and what it made to alch: strung longbows
 * of its Fletching (members), else steel platebodies of its Smithing, else gold rings of its Crafting.
 */
export function magicKit(name: string, tier: AgeTier, levels: ArrayLike<number>, members: boolean): [number, number][] {
    const out: [number, number][] = [];
    const magic = levels[PlayerStat.MAGIC];
    if (magic < 25 || !runeSeed) return out;
    const rand = seededRandom(nameSeed(name, 'runes'));
    const vet = tier === 'veteran';
    out.push([Items.LAW_RUNE, between(rand, vet ? [50, 150] : [10, 40])]);
    for (const rune of [Items.FIRE_RUNE, Items.EARTH_RUNE, Items.WATER_RUNE]) out.push([rune, between(rand, [20, 80])]);
    if (magic < 55) return out;
    out.push([Items.NATURE_RUNE, between(rand, vet ? [100, 300] : [30, 150])], [Items.STAFF_OF_FIRE, 1]);
    const fletching = members ? levels[PlayerStat.FLETCHING] : 1;
    const bow = fletching >= 70 ? Items.YEW_LONGBOW : fletching >= 55 ? Items.MAPLE_LONGBOW : fletching >= 40 ? Items.WILLOW_LONGBOW : -1;
    if (bow !== -1) out.push([bow, between(rand, [10, 40])]);
    else if (levels[PlayerStat.SMITHING] >= 48) out.push([Items.STEEL_PLATEBODY, between(rand, [4, 12])]);
    else if (levels[PlayerStat.CRAFTING] >= 5) out.push([Items.GOLD_RING, between(rand, [8, 25])]);
    return out.filter(([id]) => members || !ObjType.get(id).members);
}

/** (the variety work, round 1, Track D) the share of new aged bots that kept Rune Mysteries' air talisman (the rest sold it, lost it) */
export const TALISMAN_KEPT = 0.75;

/**
 * (the variety work, round 1, Track D: DO-4; new bots only, like the law-rune rule above) the air
 * talisman Rune Mysteries gave (every bot has the quest done: BotManager.BOT_VARPS), in a new aged bot's bank
 * TALISMAN_KEPT of the time, from its name's seed 'talisman' (the rest of its kit is unchanged): the runecrafting task
 * runs for it (Air, from Runecrafting 1). A saved bot gets none (a drop may bring one); a newcomer has not done the quest.
 */
export function talismanKit(name: string, tier: AgeTier): [number, number][] {
    if (tier === 'newcomer') return [];
    return seededRandom(nameSeed(name, 'talisman'))() < TALISMAN_KEPT ? [[Items.AIR_TALISMAN, 1]] : [];
}

// ── the look (port, the realism work, phase 4) ────────────────────────────────

export interface AgedLook {
    /** worn: the weapon (in the starter weapon's place), armour, accessories, a rare or a holiday item */
    worn: number[];
    /** owned, in the bank: the plate a skiller took off, a helm under a signature hat, a scimitar under a scythe */
    bank: number[];
    /**
     * port (the variety work, round 1, track W: the wear track's BUG-c): a social or vendor bot of combat 20+ without a
     * weapon in its look holds nothing: its starter tool (a bronze pickaxe at combat 51) is not worn
     */
    bare?: boolean;
}

/** a patchwork piece's metal: 0, 1, 2 or 3 below what the bot's Defence allows, this often (bought piece by piece) */
const METAL_DROP: readonly number[] = [0.5, 0.3, 0.15, 0.05];
/** an armour slot left bare (a piece not bought yet), by tier: the newer the bot, the more often */
const PIECE_MISSING: Readonly<Record<AgeTier, number>> = { newcomer: 0, novice: 0.3, intermediate: 0.15, experienced: 0.06, veteran: 0.03 };
/** a social or vendor bot (never fights) in armour at all: the rest stand in their clothes */
const COSMETIC_ARMOUR = 0.4;
/** accessories from this combat level (the taste's cape, gloves and boots); below it a few */
const ACCESSORY_COMBAT = 20;
/** an amulet (strength or power; a members veteran's glory now and then) from this combat level, this often */
const AMULET_COMBAT = 40;
const AMULET_SHARE = 0.55;
/** a members top veteran's cape of legends (Legends' Quest, done by every bot) */
const LEGENDS_CAPE_SHARE = 0.2;

/** The kind of piece the taste wants in a slot, or null (none). */
function kindFor(slot: 'helm' | 'body' | 'legs' | 'shield', taste: ReturnType<typeof gearTaste>): PieceKind | null {
    switch (slot) {
        case 'helm': return taste.helm === 'none' ? null : taste.helm;
        case 'body': return taste.body;
        case 'legs': return taste.legs;
        case 'shield': return taste.shield === 'none' ? null : taste.shield;
    }
}

/**
 * What a new aged bot wears and keeps of its outfit (deterministic; the dice of its name's 'look', its taste from
 * port/BotLooks): see the header. Never a members item on a free world, never a piece its Defence cannot wear. A
 * newcomer's (and a PKer's: never aged) is nothing.
 */
export function agedLook(name: string, tier: AgeTier, levels: ArrayLike<number>, members: boolean, planner: PlannerKey): AgedLook {
    const look: AgedLook = { worn: [], bank: [] };
    if (tier === 'newcomer' || PKERS.has(planner)) return look;
    const rand = seededRandom(nameSeed(name, 'look'));
    const taste = gearTaste(name);
    const w = wardrobeItems();
    const usable = (id: number): boolean => id !== -1 && (members || !ObjType.get(id).members);
    const cosmetic = COSMETIC.has(planner);
    const skiller = !cosmetic && skillerLook(name, planner);
    const defence = levels[PlayerStat.DEFENCE];
    const combat = combatLevelOf(levels);
    const top = isTopVeteran(name, tier, planner);

    // the armour: per slot the kind it likes, the metal its Defence allows (a set wearer's) or 0-3 below it
    const armour: ArmourPiece[] = [];
    const armoured = !cosmetic || rand() < COSMETIC_ARMOUR;
    const best = metalForDefence(defence);
    for (const slot of ['helm', 'body', 'legs', 'shield'] as const) {
        const kind = kindFor(slot, taste);
        const missing = rand() < PIECE_MISSING[tier];
        let metal = best;
        if (!taste.set) {
            let roll = rand();
            for (const share of METAL_DROP) {
                if (roll < share) break;
                roll -= share;
                metal--;
            }
        }
        if (!armoured || !kind || (missing && !taste.set)) continue;
        // the dragon square shield only for the top (7m in 2004), else rune; no dragon full helm or plate in 2004
        if (kind === 'sq' && metal === 7 && !(top && rand() < 0.25)) metal = 6;
        let piece: ArmourPiece | undefined;
        for (let m = Math.max(0, metal); m >= 0 && !piece; m--) {
            const p = pieceOf(kind, m);
            if (p && usable(p.id) && canWearPiece(p, defence)) piece = p;
        }
        if (piece) armour.push(piece);
    }
    // a novice's shield is the tutorial's wooden one now and then
    if (tier === 'novice' && armoured && taste.shield !== 'none' && !armour.some(p => p.slot === 'shield') && rand() < 0.5) armour.push({ id: Items.WOODEN_SHIELD, slot: 'shield', kind: 'wooden', tier: -1 });

    // the weapon: the scimitar its Attack allows (a social or vendor bot's half the time: else its starter weapon). port
    // (the variety work, round 1, track W: WEAR-2): the kind it likes (port/BotOutfits weaponKindOf), at the metal its
    // Attack allows; a members veteran of 60 Attack a dragon one now and then, a rich scimitar-liker of 40 a rune 2h or
    // longsword 1 in 5 (no new draw from this look's dice)
    const scimitar = likedWeaponFor(name, tier, levels, members, usable) ?? SCIMITAR_TIERS.find(t => levels[PlayerStat.ATTACK] >= t.minAtk && usable(t.itemId))?.itemId ?? null;
    const holiday = cosmetic ? null : holidayOf(name, tier, skiller);
    const rare = rareOf(name, tier, planner);

    if (skiller) {
        // a skiller: its plate in the bank, a skiller's outfit on (the hat, apron and the accessories it likes)
        for (const p of armour) look.bank.push(p.id);
        if (scimitar !== null) look.bank.push(scimitar);
        // port (the variety work, round 1, track W: WEAR-3): the chef's hat is a cook's (half of those whose main skill is
        // Cooking), in its bank for the range (1 in 20 of them wear it anywhere), not 1 skiller in 5's whatever it did (6 %
        // of the chef's hats were seen at cooking); a cook's white apron, a smith's or crafter's brown one, before the taste's
        const clothes = skillClothesOf(name, mainSkillOf(levels), prayerTrainer(levels));
        if (clothes.chefsHat && chefsHatAnywhere(name)) look.worn.push(w.chefsHat);
        else if (taste.hat === 'wizard') look.worn.push(taste.blackHat ? w.blackWizardHat : w.wizardHat);
        // (a cook's chef's hat waits in the bank for the range: port/BotGear dressForSkill)
        if (clothes.chefsHat && !chefsHatAnywhere(name)) look.bank.push(w.chefsHat);
        if (clothes.whiteApron) look.worn.push(w.whiteApron);
        else if (clothes.brownApron) look.worn.push(w.brownApron);
        else if (taste.apron) look.worn.push(taste.whiteApron ? w.whiteApron : w.brownApron);
    } else {
        for (const p of armour) look.worn.push(p.id);
        // (a social or vendor bot's: half the time, most of them from combat 40; else the starter weapon stays)
        if (scimitar !== null && (!cosmetic || rand() < (combat >= 40 ? 0.85 : 0.5))) look.worn.push(scimitar);
    }

    // accessories: from combat 20 the ones it likes (below it a few), from 40 an amulet now and then
    const accessories = combat >= ACCESSORY_COMBAT || (combat >= 10 && rand() < 0.4);
    if (accessories) {
        if (taste.cape) look.worn.push(top && members && rand() < LEGENDS_CAPE_SHARE ? w.legendsCape : w.capes[taste.capeColour % w.capes.length]);
        if (taste.gloves) look.worn.push(w.gloves);
        if (taste.boots) look.worn.push(w.boots);
    }
    if (!skiller && (top || (combat >= AMULET_COMBAT && rand() < AMULET_SHARE))) {
        const glory = members && (tier === 'veteran' || top) && rand() < 0.3;
        look.worn.push(glory ? w.amuletGlory : rand() < 0.55 ? w.amuletStrength : w.amuletPower);
    }

    // a rare or a holiday item on top of it all: the hat or weapon it replaces goes to the bank (a social or vendor
    // bot keeps nothing in its bank: what it replaces is simply not worn)
    const replace = (slot: number, id: number): void => {
        look.worn = look.worn.filter(worn => {
            const type = ObjType.get(worn);
            const taken = type.wearpos === slot || (slot === 3 && type.wearpos === 5 && ObjType.get(id).wearpos2 === 5);
            if (taken && !cosmetic) look.bank.push(worn);
            return !taken;
        });
        look.worn.push(id);
    };
    if (rare !== null && usable(rare)) replace(0, rare);
    else if (holiday !== null && holiday === w.bunnyEars) replace(0, holiday);
    if (holiday !== null && holiday === w.scythe) {
        replace(3, holiday);
        // (a scythe takes both hands: a skiller's banked scimitar stays in the bank)
    }
    if (rare !== null && holiday === w.bunnyEars) look.bank.push(holiday);
    look.worn = look.worn.filter(usable);
    look.bank = look.bank.filter(usable);
    // port (the variety work, round 1, track W): its style, its skill's clothes and its name's class, from seeds of their
    // own, on top of it all
    dressAged(look, name, tier, levels, members, planner, cosmetic, skiller, combat, usable);
    return look;
}

/**
 * port (the variety work, round 1, track W: WEAR-2) the weapon of the kind the bot likes at the metal its Attack allows
 * (rune at most: no dragon scimitar, sword, 2h or warhammer in 2004), else none of that kind on this world: null. A
 * members veteran of 60 Attack: a dragon one now and then (port/BotOutfits dragonWeaponOf); an experienced or veteran
 * scimitar-liker of 40: a rune 2h or rune longsword 1 in 5 (richRuneWeaponOf).
 */
function likedWeaponFor(name: string, tier: AgeTier, levels: ArrayLike<number>, members: boolean, usable: (id: number) => boolean): number | null {
    const attack = levels[PlayerStat.ATTACK];
    if (members && attack >= 60 && tier === 'veteran') {
        const dragon = dragonWeaponOf(name);
        if (dragon !== null && usable(dragon)) return dragon;
    }
    const kind = weaponKindOf(name);
    if (kind === 'scimitar' && attack >= 40 && (tier === 'experienced' || tier === 'veteran')) {
        const rune = richRuneWeaponOf(name);
        if (rune !== null && usable(rune)) return rune;
    }
    for (let t = Math.min(6, weaponMetalForAttack(attack)); t >= 0; t--) {
        const w = weaponOf(kind, t);
        if (w && usable(w.id)) return w.id;
    }
    return null;
}

/**
 * port (the variety work, round 1, track W: WEAR-1, -3, -6, BUG-c) a new bot's look, on top of phase 4's (its own seeds:
 * none of phase 4's dice change):
 *   style   a levelling ranger or mage without a skiller's look (port/BotOutfits combatStyleOf), and any bot whose name
 *           promises one, wears its ladder's pieces for its levels (rangerPieces, magePieces): a ranger its leather to
 *           d'hide (an archer's name its bow in hand), its metal body, helm and shield in the bank (3 in 10 keep a metal helm or platelegs); a
 *           mage its wizard hat, robe, skirt and staff, all metal banked
 *   clothes a levelling bot without a skiller's look keeps its main skill's clothes in the bank (a cook's chef's hat and
 *           white apron, a smith's brown apron and gloves, a fisher's boots: port/BotGear dressForSkill puts them on
 *           there); a prayer trainer's or monk's monk's robe (a monk's worn)
 *   names   a chef's chef's hat and white apron, a smith's brown apron, a monk's robe, a members pirate's hat, a miner's
 *           pickaxe and a woodcutter's axe in hand (the best its levels allow), worn
 *   BUG-c   a social or vendor bot of combat 20+ without a weapon holds none (its starter tool is not worn: `bare`)
 * Pieces it takes off go to the bank (a social or vendor bot's are simply not worn).
 */
function dressAged(look: AgedLook, name: string, tier: AgeTier, levels: ArrayLike<number>, members: boolean, planner: PlannerKey, cosmetic: boolean, skiller: boolean, combat: number, usable: (id: number) => boolean): void {
    const o = outfitItems();
    const w = wardrobeItems();
    const cls = nameClassOf(name);
    const signature = look.worn.some(id => isSignatureHat(id));
    const scythe = look.worn.includes(w.scythe);
    const at = (id: number): [number, number] => {
        const t = ObjType.get(id);
        return [t.wearpos, t.wearpos2];
    };
    const store = (id: number): void => {
        if (!cosmetic && id !== -1 && usable(id) && !look.bank.includes(id)) look.bank.push(id);
    };
    const takeOff = (pos: number): void => {
        look.worn = look.worn.filter(id => {
            const [p1, p2] = at(id);
            const hit = p1 === pos || (p2 === pos && p2 >= 0);
            if (hit) store(id);
            return !hit;
        });
    };
    const put = (id: number): void => {
        if (id === -1 || !usable(id)) return;
        const [p1, p2] = at(id);
        if (p1 < 0) return;
        if ((p1 === 0 && signature) || (p1 === 3 && scythe)) {
            store(id);
            return;
        }
        takeOff(p1);
        if (p2 >= 0 && p2 !== p1) takeOff(p2);
        look.worn.push(id);
    };
    const ranged = levels[PlayerStat.RANGED];
    const magic = levels[PlayerStat.MAGIC];
    const defence = levels[PlayerStat.DEFENCE];
    const attack = levels[PlayerStat.ATTACK];
    const rich = tier === 'experienced' || tier === 'veteran';

    // the style: a class's name, else a levelling bot's own (no skiller's look: a skiller's keeps its style's pieces in
    // the bank, for its ranged or magic fights: port/BotGear dressForMode)
    const dice = cosmetic ? 'melee' : combatStyleOf(name);
    const style = cls === 'mage' || cls === 'ranger' ? cls : !skiller ? dice : 'melee';
    if (style === 'melee' && skiller && dice === 'ranger') {
        const p = rangerPieces(name, ranged, defence, members);
        for (const id of [p.helm, p.body, p.legs, p.hands]) store(id);
    } else if (style === 'melee' && skiller && dice === 'mage') {
        const p = magePieces(name, magic, defence, attack, members, rich);
        for (const id of [p.helm, p.body, p.legs]) store(id);
    }
    if (style === 'ranger') {
        const p = rangerPieces(name, ranged, defence, members, rich);
        takeOff(4);
        if (p.keepMetal !== 'helm' && !signature) takeOff(0);
        if (p.legs !== -1) takeOff(7);
        takeOff(5);
        for (const id of [p.helm, p.body, p.legs, p.hands, p.feet]) put(id);
        // (an archer's name holds its bow; a ranger by the dice its weapon, the bow for its ranged fights: a bow in hand
        // makes a Duel Arena visitor a watcher, port/BotArena wieldsRanged, and the duels went from 20 to 1-6 in two hours)
        const bow = cls === 'ranger' ? bestFor(RangedBowsByLevel, Math.max(1, ranged), usable) : null;
        if (bow !== null) put(bow);
    } else if (style === 'mage') {
        const p = magePieces(name, magic, defence, attack, members, rich);
        for (const pos of [4, 7, 5]) takeOff(pos);
        if (!signature) takeOff(0);
        for (const id of [p.helm, p.body, p.legs, p.hands, p.feet, p.cape, p.neck]) put(id);
        // (a mage of 55 Magic gets its alching staff of fire in its bank, magicKit: it holds a staff of water then)
        // (round 2, W2: WEAR-7) a members mage's battlestaff is a powered one, of its own kind (port/BotFashion battlestaffOf)
        const staff = p.staff === o.battlestaff && members ? battlestaffOf(name) : p.staff;
        put(staff === Items.STAFF_OF_FIRE && magic >= 55 && runeSeed ? Items.STAFF_OF_WATER : staff);
    }

    // a skill's clothes: in the bank for its skill (a skiller's look wears them already)
    const levelling = !cosmetic;
    const clothes = skillClothesOf(name, mainSkillOf(levels), prayerTrainer(levels));
    if (levelling && !skiller) {
        if (clothes.chefsHat) store(w.chefsHat);
        if (clothes.whiteApron) store(w.whiteApron);
        if (clothes.brownApron) store(w.brownApron);
    }
    if (levelling) {
        if (clothes.gloves && !look.worn.some(id => at(id)[0] === 9)) (skiller ? put : store)(w.gloves);
        if (clothes.boots && !look.worn.some(id => at(id)[0] === 10)) (skiller ? put : store)(w.boots);
        // (a fisher's cape: its taste's colour)
        if (clothes.cape && !look.worn.some(id => at(id)[0] === 1)) (skiller ? put : store)(w.capes[gearTaste(name).capeColour % w.capes.length]);
        if (clothes.monkRobe && cls !== 'monk') {
            store(o.monkRobeTop);
            store(o.monkRobeBottom);
        }
    }

    // the name's class
    if (cls === 'chef') {
        put(w.chefsHat);
        put(w.whiteApron);
    } else if (cls === 'smith') put(w.brownApron);
    else if (cls === 'monk') {
        put(o.monkRobeTop);
        put(o.monkRobeBottom);
    } else if (cls === 'pirate') put(pirateHatFor(name, members));
    else if (cls === 'miner' || cls === 'woodcutter') {
        const table = cls === 'miner' ? PickaxesByLevel : AxesByLevel;
        const skill = levels[cls === 'miner' ? PlayerStat.MINING : PlayerStat.WOODCUTTING];
        let tool: number | null = null;
        for (const t of table) if (skill >= t.levelReq && attack >= toolWieldAttack(t.itemId) && usable(t.itemId)) tool = t.itemId;
        if (tool !== null) put(tool);
    }

    // port (the variety work, round 2, track W2: WEAR-4, -7, -9) status gear, late 2004's members fashion and the novelty
    // pieces, each from a seed of its own (port/BotFashion), on top of it all
    if (fashionPass) dressFashion(look, name, tier, levels, members, cosmetic, skiller, style, { put, store, at });

    // BUG-c: a social or vendor bot of combat 20+ without a weapon holds none (no starter tool)
    if (cosmetic && combat >= 20 && !look.worn.some(id => at(id)[0] === 3)) look.bare = true;
}

/** tests only (test/fashion: round 2's pass off gives round 1's looks): never set by the game */
let fashionPass = true;
export function setFashionPassForTest(on: boolean): void {
    fashionPass = on;
}

/**
 * port (the variety work, round 2, track W2: fashion WEAR-4, -7, -9) a new bot's status
 * gear, members fashion and novelty pieces (port/BotFashion, each on a seed of its own; none of the dice before change):
 *   status   the trims, god or gilded pieces of its tier (statusKitOf): a melee bot and a social or vendor bot wear them
 *            (the plain piece of the slot to the bank), a skiller, ranger or mage keeps them in the bank for its fights
 *   members  a Fremennik helm or a clue hat over a metal helm, a snelm only into an empty hat slot or over a hat; a
 *            Fremennik cloak over its cape; a Fremennik shirt or a robe only where no metal body or legs are worn (else
 *            in the bank); boots; a god book in the shield hand (not with a two-hander)
 *   novelty  the mime's whole outfit; a holy symbol, the amulet of accuracy or a gem amulet into an empty neck slot
 */
function dressFashion(
    look: AgedLook,
    name: string,
    tier: AgeTier,
    levels: ArrayLike<number>,
    members: boolean,
    cosmetic: boolean,
    skiller: boolean,
    style: 'melee' | 'ranger' | 'mage',
    h: { put: (id: number) => void; store: (id: number) => void; at: (id: number) => [number, number] }
): void {
    const { put, store, at } = h;
    const defence = levels[PlayerStat.DEFENCE];
    const taste = gearTaste(name);
    const twoHanded = (): boolean => look.worn.some(id => at(id)[0] === 3 && at(id)[1] === 5);
    const metalAt = (pos: number): boolean => look.worn.some(id => at(id)[0] === pos && (armourPieceOf(id)?.tier ?? -1) >= 0);
    const wornAt = (pos: number): boolean => look.worn.some(id => at(id)[0] === pos);
    // status gear (WEAR-4)
    const status = statusKitOf(name, tier, defence, members, { cosmetic, legs: taste.legs, shield: taste.shield !== 'none' && !twoHanded() });
    for (const id of status) (cosmetic || (!skiller && style === 'melee') ? put : store)(id);
    // late 2004's members fashion (WEAR-7)
    if (members) {
        const mf = membersFashionOf(name, tier, { defence, ranged: levels[PlayerStat.RANGED] }, cosmetic ? combatStyleOf(name) : style, { prayer: prayerTrainer(levels), robes: cosmetic || skiller || style === 'mage' });
        if (mf.hat !== -1) (mf.hatOverHelm || !metalAt(0) ? put : store)(mf.hat);
        // (a clique member keeps its clan's cape: port/BotLooks gearTaste)
        if (mf.cape !== -1) (clanColourOf(name) === null ? put : store)(mf.cape);
        if (mf.body !== -1) (metalAt(4) ? store : put)(mf.body);
        if (mf.legs !== -1) (metalAt(7) ? store : put)(mf.legs);
        if (mf.feet !== -1) put(mf.feet);
        if (mf.shield !== -1 && !twoHanded()) put(mf.shield);
    }
    // novelty pieces (WEAR-9)
    const nov = noveltyOf(name, tier, levels[PlayerStat.CRAFTING], { prayer: prayerTrainer(levels), monk: nameClassOf(name) === 'monk', crafter: mainSkillOf(levels) === 'crafting' });
    for (const id of nov.mime) put(id);
    if (nov.neck !== -1 && !wornAt(2)) put(nov.neck);
}

/**
 * port (the variety work, round 1, track W: WEAR-6) what a newcomer (a fresh account, no kit) whose name promises a class
 * wears of it, the cheapest pieces (a few coins at the shops of 2004, or free): a mage's wizard hat, a ranger's cowl and
 * leather body (its ladder's liking at Ranged 1), a chef's chef's hat and white apron, a smith's brown apron, a monk's
 * robe (the monastery's, free), a miner's bronze pickaxe and a woodcutter's bronze axe in hand; nothing for a knight's
 * or a pirate's (metal and clue rewards are earned). Other names: nothing.
 */
export function newcomerClassLook(name: string, members: boolean): number[] {
    const o = outfitItems();
    const w = wardrobeItems();
    const cls = nameClassOf(name);
    const out: number[] =
        cls === 'mage' ? [magePieces(name, 1, 1, 1, members, false).helm]
        : cls === 'ranger' ? (() => {
              const p = rangerPieces(name, 1, 1, members);
              return [p.helm, p.body];
          })()
        : cls === 'chef' ? [w.chefsHat, w.whiteApron]
        : cls === 'smith' ? [w.brownApron]
        : cls === 'monk' ? [o.monkRobeTop, o.monkRobeBottom]
        : cls === 'miner' ? [Items.BRONZE_PICKAXE]
        : cls === 'woodcutter' ? [Items.BRONZE_AXE]
        : [];
    return out.filter(id => id !== -1 && (members || !ObjType.get(id).members));
}

// ── start tile ────────────────────────────────────────────────────────────────

/** The tier's banks a bot may start by on this world (level 0, free ones on a free world). */
function startBanks(tier: AgeTier, members: boolean): [number, number, number][] {
    return tierSpec(tier).banks.map(key => Locations[key]).filter(([x, z, level]) => level === 0 && (members || World.gameMap.isFreeToPlay(x, z)));
}

/**
 * port (the realism work, phase 3: "near you first"): the bank agedStartTile starts this bot by, as a rule (its first
 * pick; the next bank only when no tile of 8 tries by the first one is open): where a new bot logs in, without its
 * route searches (BotManager orders a login's bots by it). Null: none.
 */
export function agedStartBank(name: string, tier: AgeTier, members: boolean): [number, number, number] | null {
    const banks = startBanks(tier, members);
    return banks.length === 0 ? null : banks[Math.floor(seededRandom(nameSeed(name, 'tile'))() * banks.length)];
}

/** A walkable tile near one of the tier's banks, reachable from it, allowed on this world; or null. */
export function agedStartTile(name: string, tier: AgeTier, members: boolean): [number, number, number] | null {
    const rand = seededRandom(nameSeed(name, 'tile'));
    const allowed = (x: number, z: number): boolean => members || World.gameMap.isFreeToPlay(x, z);
    const banks = startBanks(tier, members);
    if (banks.length === 0) return null;
    const first = Math.floor(rand() * banks.length);
    for (let b = 0; b < banks.length; b++) {
        const [bx, bz, level] = banks[(first + b) % banks.length];
        for (let attempt = 0; attempt < 8; attempt++) {
            const x = bx + Math.floor(rand() * 7) - 3;
            const z = bz + Math.floor(rand() * 7) - 3;
            if (!isZoneAllocated(level, x, z) || isMapBlocked(x, z, level) || !allowed(x, z)) continue;
            // on the bank's side of its counters and walls: a short route to the bank tile (a bot at the booths
            // walks there to bank)
            if (x === bx && z === bz) return [x, z, level];
            const path = rsmod.findPath(level, x, z, bx, bz, 1, 1, 1, 0, -1, false, 0, 25, CollisionType.NORMAL);
            const last = path.length > 0 ? path[path.length - 1] : -1;
            if (last !== -1 && ((last >> 14) & 0x3fff) === bx && (last & 0x3fff) === bz) return [x, z, level];
        }
    }
    return null;
}

// ── applying it ───────────────────────────────────────────────────────────────

/**
 * port (phase 4): the look's items on, each in its slot: the weapon in the starter weapon's place (a scythe in both
 * hands); before, the starter weapon kept the slot and the kit's scimitar was lost
 */
function wear(worn: NonNullable<ReturnType<Player['getInventory']>>, ids: readonly number[]): void {
    for (const id of ids) {
        const type = ObjType.get(id);
        if (type.wearpos < 0) continue;
        if (type.wearpos2 >= 0 && type.wearpos2 !== type.wearpos) worn.delete(type.wearpos2);
        worn.set(type.wearpos, { id, count: 1 });
    }
}

function put(player: Player, invId: number, items: [number, number][]): void {
    const inv = player.getInventory(invId);
    if (!inv) return;
    for (const [id, count] of items) inv.add(id, count);
}

/**
 * Ages a bot that has no save yet (BotManager._spawnBot, before the world's varps, the free-world coordinate rule and
 * buildAppearance): stats, inventory, bank, worn items and position. Its InitTask still runs on its first tick.
 */
export function applyAge(player: Player, name: string, planner: PlannerKey, members: boolean): AgeTier {
    const stats = agedStats(name, planner, members);
    if (!stats) {
        // port (the variety work, round 1, track W: WEAR-6): a newcomer whose name promises a class wears its cheapest piece
        const worn = PKERS.has(planner) ? null : player.getInventory(InvType.WORN);
        if (worn) wear(worn, newcomerClassLook(name, members));
        return 'newcomer';
    }
    for (let stat = 0; stat < stats.xp.length && stat < player.stats.length; stat++) {
        if (stat === PlayerStat.STAT18 || stat === PlayerStat.STAT19) continue;
        const xp = Math.max(player.stats[stat], stats.xp[stat]);
        player.stats[stat] = xp;
        player.baseLevels[stat] = getLevelByExp(xp);
        player.levels[stat] = player.baseLevels[stat];
    }
    player.combatLevel = player.getCombatLevel();
    const worn = player.getInventory(InvType.WORN);
    // social and vendor bots: the levels and (port, phase 4) a look, worn only
    if (COSMETIC.has(planner)) {
        const look = agedLook(name, stats.tier, player.baseLevels, members, planner);
        // (port, the variety work: BUG-c, no starter tool at combat 20+)
        if (worn && look.bare) worn.delete(3);
        if (worn) wear(worn, look.worn);
        return stats.tier;
    }

    const kit = agedKit(name, stats.tier, player.baseLevels, members, planner);
    if (worn) wear(worn, kit.worn);
    put(player, InvType.INV, kit.pack);
    const bankId = InvType.getId('bank');
    if (bankId !== -1) put(player, bankId, kit.bank);

    const tile = agedStartTile(name, stats.tier, members);
    if (tile) [player.x, player.z, player.level] = tile;
    return stats.tier;
}
