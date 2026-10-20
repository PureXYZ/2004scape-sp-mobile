// port (the variety work, round 1, track W: what bots wear WEAR-1, -2, -3, -6:
// "variety in what the bots ... wear"): what a bot's name says about the clothes it likes, beyond port/BotLooks'
// taste. Pure functions of the name (port/BotSeed), each trait on a seed of its own, so no name's helm, cape, metal,
// gender or colours (port/BotLooks) change. What a bot buys and puts on follows these (port/BotGear: saved bots too,
// through play); a new bot's kit (port/BotAge) wears them from the start.
//   names     about 1 name in 20 promises a class ("Wizard Tim", "Elf Archer", "Pickaxe Pat", "Chef Chloe", "Sir Loin"):
//             the class forces the style or the look (nameClassOf)
//   style     the combat style a levelling bot dresses for (combatStyleOf): ranger and mage by the name's dice (18.75 % and
//             12.5 %: of the 64 % of levelling bots that wear no skiller's look, port/BotLooks skillerLook, 12 % and 8 %
//             of them all; the skiller's look stays as it was, about 36 %), melee the rest. Whatever the style, the outfit
//             at a ranged or magic fight follows the fight (port/BotGear dressForMode)
//   ladders   274's ranger pieces (leather cowl and body, chaps, vambraces; coif at 20 Ranged; studded at 20 Ranged and
//             20 Defence; green d'hide at 40, its body at 40 Defence and Dragon Slayer; members blue, red and black at 50,
//             60, 70) and mage pieces (blue or black wizard hats, the wizard and black robes, the monk's robe, blue or black
//             skirts, staffs; members battlestaves, mystic staves, splitbark at 40/40, god capes): rangerPieces, magePieces
//   weapons   a liked kind of melee weapon (scimitar 55 %, longsword 14, battleaxe 8, 2h 7, mace 6, sword 5, dagger or
//             warhammer 5 %): weaponKindOf, its ladder by metal (weaponOf); members veterans of 60 Attack a dragon one
//             now and then (dragonWeaponOf)
//   clothes   the clothes of a bot's main skill (a cook's chef's hat and white apron, a smith's or crafter's brown apron and
//             gloves, a fisher's boots and cape, a prayer trainer's monk's robe: skillClothesOf); the chef's hat elsewhere
//             only as a joke (5 %)
//   tools     about half the woodcutters and miners hold their axe or pickaxe at the trees and rocks (wieldsTools, 6 in 10;
//             the default), the best their Attack allows (toolWieldAttack: bronze and iron 1, steel 5, black 10, mithril 20,
//             adamant 30, rune 40)
// Every item is looked up by its 274 debugname (test/content-names checks each), on first use.
import ObjType from '#/cache/config/ObjType.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';

// ── names that promise a class (WEAR-6) ───────────────────────────────────────

export type NameClass = 'knight' | 'mage' | 'ranger' | 'monk' | 'pirate' | 'chef' | 'smith' | 'miner' | 'woodcutter';

/** the words of each class, first match wins ("Holy Knight" is a knight, "Holy Moly" a monk) */
const CLASS_WORDS: ReadonlyArray<[NameClass, ReadonlySet<string>]> = [
    ['knight', new Set(['knight', 'paladin', 'sir'])],
    ['mage', new Set(['mage', 'wizard', 'sorcerer', 'sorceress', 'warlock', 'merlin', 'gandalf', 'spell', 'witch'])],
    ['ranger', new Set(['archer', 'arrow', 'bow', 'range', 'ranger', 'legolas', 'robin'])],
    ['monk', new Set(['monk', 'priest', 'holy'])],
    ['pirate', new Set(['pirate'])],
    ['chef', new Set(['chef', 'cook'])],
    ['smith', new Set(['smith', 'smithy', 'anvil'])],
    ['miner', new Set(['miner', 'mining', 'pickaxe', 'coal', 'ore'])],
    ['woodcutter', new Set(['woodcutter', 'lumberjack', 'logger', 'cutter', 'lumber'])]
];
/** a ranger's word in a fletcher's or a trader's name ("Arrow Maker", "Bow Stringer", "Arrow Shafts") */
const NOT_A_RANGER: ReadonlySet<string> = new Set(['maker', 'shafts', 'stringer', 'fletch', 'fletcher', 'fletching']);

function wordsOf(name: string): string[] {
    return name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

/** The class a name promises, or null (about 1 name in 20 of the 2,400). */
export function nameClassOf(name: string): NameClass | null {
    const words = wordsOf(name);
    for (const [cls, set] of CLASS_WORDS) {
        if (!words.some(w => set.has(w))) continue;
        if (cls === 'ranger' && words.some(w => NOT_A_RANGER.has(w))) continue;
        return cls;
    }
    return null;
}

// ── the combat style (WEAR-1) ─────────────────────────────────────────────────

export type CombatStyle = 'melee' | 'ranger' | 'mage';

/**
 * The name's dice for a ranger and a mage (the rest melee): of the levelling bots without a skiller's look (about 64 %),
 * these make 12 % and 8 % of them all rangers and mages (the wear track's 60/20/12/8 with the skiller's look as it was).
 */
export const STYLE_DICE: Readonly<{ ranger: number; mage: number }> = { ranger: 0.1875, mage: 0.125 };

/**
 * The combat style a bot of this name dresses for (the same every time): a mage's or a ranger's name forces it, a
 * knight's is melee, else the name's own dice (STYLE_DICE). For the integrator's planner bias too (the plan's default: a
 * style biases training modestly). Social, vendor and PK bots have one as well; only levelling bots dress by it.
 */
export function combatStyleOf(name: string): CombatStyle {
    const cls = nameClassOf(name);
    if (cls === 'mage') return 'mage';
    if (cls === 'ranger') return 'ranger';
    if (cls === 'knight') return 'melee';
    const roll = seededRandom(nameSeed(name, 'combat-style'))();
    return roll < STYLE_DICE.ranger ? 'ranger' : roll < STYLE_DICE.ranger + STYLE_DICE.mage ? 'mage' : 'melee';
}

// ── the pieces (274's debugnames, resolved on first use) ──────────────────────

export interface OutfitItems {
    leatherCowl: number;
    coif: number;
    leatherBody: number;
    hardleatherBody: number;
    studdedBody: number;
    /** green, blue, red, black (the Ranged level each needs: 40, 50, 60, 70; the body 40 Defence) */
    dhideBodies: number[];
    leatherChaps: number;
    studdedChaps: number;
    dhideChaps: number[];
    leatherVambraces: number;
    dhideVambraces: number[];
    rangerBoots: number;
    robinHoodHat: number;
    blueWizardHat: number;
    blackWizardHat: number;
    wizardRobe: number;
    blackRobe: number;
    monkRobeTop: number;
    monkRobeBottom: number;
    blueSkirt: number;
    blackSkirt: number;
    staffOfAir: number;
    /** water, earth, fire */
    elementalStaffs: number[];
    battlestaff: number;
    /** fire, water, air, earth */
    mysticStaffs: number[];
    splitbark: number[];
    godCapes: number[];
    godStaffs: number[];
    amuletOfMagic: number;
    blueCape: number;
    purpleCape: number;
    chefsHat: number;
    whiteApron: number;
    brownApron: number;
    leatherGloves: number;
    leatherBoots: number;
    pirateHat: number;
    shortbow: number;
    oakShortbow: number;
}

let OUTFIT: OutfitItems | null = null;

export function outfitItems(): OutfitItems {
    if (OUTFIT) return OUTFIT;
    const id = (name: string): number => ObjType.getId(name);
    OUTFIT = {
        leatherCowl: id('leather_cowl'),
        coif: id('coif'),
        leatherBody: id('leather_armour'),
        hardleatherBody: id('hardleather_body'),
        studdedBody: id('studded_body'),
        dhideBodies: [id('dragonhide_body'), id('blue_dragonhide_body'), id('red_dragonhide_body'), id('black_dragonhide_body')],
        leatherChaps: id('leather_chaps'),
        studdedChaps: id('studded_chaps'),
        dhideChaps: [id('dragonhide_chaps'), id('blue_dragonhide_chaps'), id('red_dragonhide_chaps'), id('black_dragonhide_chaps')],
        leatherVambraces: id('leather_vambraces'),
        dhideVambraces: [id('dragon_vambraces'), id('blue_dragon_vambraces'), id('red_dragon_vambraces'), id('black_dragon_vambraces')],
        rangerBoots: id('boots_ranger'),
        robinHoodHat: id('robinhoodhat'),
        blueWizardHat: id('bluewizhat'),
        blackWizardHat: id('blackwizhat'),
        wizardRobe: id('wizards_robe'),
        blackRobe: id('black_robe'),
        monkRobeTop: id('monkrobetop'),
        monkRobeBottom: id('monkrobebottom'),
        blueSkirt: id('blue_skirt'),
        blackSkirt: id('black_skirt'),
        staffOfAir: id('staff_of_air'),
        elementalStaffs: [id('staff_of_water'), id('staff_of_earth'), id('staff_of_fire')],
        battlestaff: id('battlestaff'),
        mysticStaffs: [id('mystic_fire_staff'), id('mystic_water_staff'), id('mystic_air_staff'), id('mystic_earth_staff')],
        splitbark: [id('splitbark_helm'), id('splitbark_body'), id('splitbark_legs'), id('splitbark_gauntlets'), id('splitbark_greaves')],
        godCapes: [id('saradomin_cape'), id('guthix_cape'), id('zamorak_cape')],
        godStaffs: [id('saradomin_staff'), id('guthix_staff'), id('zamorak_staff')],
        amuletOfMagic: id('amulet_of_magic'),
        blueCape: id('blue_cape'),
        purpleCape: id('purple_cape'),
        chefsHat: id('chefs_hat'),
        whiteApron: id('white_apron'),
        brownApron: id('brown_apron'),
        leatherGloves: id('leather_gloves'),
        leatherBoots: id('leather_boots'),
        pirateHat: id('piratehat'),
        shortbow: id('shortbow'),
        oakShortbow: id('oak_shortbow')
    };
    return OUTFIT;
}

let RANGER_IDS: Set<number> | null = null;
let MAGE_IDS: Set<number> | null = null;

/** a ranger's piece (a cowl, coif, leather, studded or d'hide body, chaps, vambraces, ranger boots, robin hood hat) */
export function isRangerPiece(id: number): boolean {
    if (!RANGER_IDS) {
        const o = outfitItems();
        RANGER_IDS = new Set([o.leatherCowl, o.coif, o.leatherBody, o.hardleatherBody, o.studdedBody, ...o.dhideBodies, o.leatherChaps, o.studdedChaps, ...o.dhideChaps, o.leatherVambraces, ...o.dhideVambraces, o.rangerBoots, o.robinHoodHat].filter(i => i !== -1));
    }
    return RANGER_IDS.has(id);
}

/** a mage's piece (a wizard hat, a robe, a skirt, a monk's robe, splitbark, a god cape) */
export function isMagePiece(id: number): boolean {
    if (!MAGE_IDS) {
        const o = outfitItems();
        MAGE_IDS = new Set([o.blueWizardHat, o.blackWizardHat, o.wizardRobe, o.blackRobe, o.monkRobeTop, o.monkRobeBottom, o.blueSkirt, o.blackSkirt, ...o.splitbark, ...o.godCapes].filter(i => i !== -1));
    }
    return MAGE_IDS.has(id);
}

/** every outfit piece of this module (never sold as junk, never alched, never worn by a metal name: port/BotLooks) */
export function outfitItemIds(): number[] {
    const o = outfitItems();
    return [
        o.leatherCowl, o.coif, o.leatherBody, o.hardleatherBody, o.studdedBody, ...o.dhideBodies, o.leatherChaps, o.studdedChaps, ...o.dhideChaps, o.leatherVambraces,
        ...o.dhideVambraces, o.rangerBoots, o.robinHoodHat, o.blueWizardHat, o.blackWizardHat, o.wizardRobe, o.blackRobe, o.monkRobeTop, o.monkRobeBottom, o.blueSkirt,
        o.blackSkirt, ...o.splitbark, ...o.godCapes, o.amuletOfMagic, o.pirateHat
    ].filter(i => i !== -1);
}

// ── what a piece needs (274's levelrequire scripts: tier1-tier70.rs2) ─────────

/** [Ranged, Defence, Magic, Attack] a piece needs to be worn; undefined: nothing */
function needsOf(id: number): [number, number, number, number] | undefined {
    const o = outfitItems();
    if (id === o.coif) return [20, 0, 0, 0];
    if (id === o.hardleatherBody) return [0, 10, 0, 0];
    if (id === o.studdedBody) return [20, 20, 0, 0];
    if (id === o.studdedChaps) return [20, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
        const ranged = 40 + 10 * c;
        if (id === o.dhideBodies[c]) return [ranged, 40, 0, 0];
        if (id === o.dhideChaps[c] || id === o.dhideVambraces[c]) return [ranged, 0, 0, 0];
    }
    if (o.splitbark.includes(id)) return [0, 40, 40, 0];
    if (id === o.battlestaff) return [0, 0, 30, 30];
    if (o.mysticStaffs.includes(id)) return [0, 0, 40, 40];
    return undefined;
}

/** May a bot with these levels (Ranged, Defence, Magic, Attack) wear the piece? */
export function canWearOutfitPiece(id: number, ranged: number, defence: number, magic: number, attack: number): boolean {
    const need = needsOf(id);
    return !need || (ranged >= need[0] && defence >= need[1] && magic >= need[2] && attack >= need[3]);
}

// ── a ranger's pieces (WEAR-1's ladder) ───────────────────────────────────────

export interface StylePieces {
    /** worn slot (274's wearpos) → item */
    helm: number;
    body: number;
    legs: number;
    hands: number;
    feet: number;
    /** a metal helm or metal platelegs it keeps on at a ranged fight (patchwork: 3 in 10) */
    keepMetal: 'helm' | 'legs' | null;
}

const NONE = -1;

/** the d'hide colour (0 green .. 3 black) a Ranged level allows on this world, one below it now and then */
function dhideColour(ranged: number, members: boolean, roll: number): number {
    if (!members) return 0;
    let best = Math.min(3, Math.floor((ranged - 40) / 10));
    if (best > 0 && roll < 0.35) best--;
    return best;
}

/**
 * The ranger's pieces a bot of this name wears for these levels (its own seed 'ranger-outfit'; 274's levels):
 *   Ranged 1-19   a leather cowl 40 %, a leather body 70 %, leather chaps 40 %, leather vambraces 50 %
 *   20-39         a coif 50 % (else the cowl 40 %), a studded body 60 % at 20 Defence (else leather; hardleather at 10
 *                 Defence 3 in 10 of those), studded chaps 50 % (else leather 40 %), vambraces 50 %
 *   40+           green d'hide: the body 50 % at 40 Defence (else studded), chaps 70 %, vambraces 70 %; on a members
 *                 world blue at 50, red at 60, black at 70 (a colour below now and then); a rich members ranger's clue
 *                 pieces now and then (ranger boots 1 in 10, a robin hood hat 1 in 20)
 * Patchwork: 3 in 10 keep a metal helm or platelegs on at a ranged fight (keepMetal).
 */
export function rangerPieces(name: string, ranged: number, defence: number, members: boolean, rich = false): StylePieces {
    const r = seededRandom(nameSeed(name, 'ranger-outfit'));
    const o = outfitItems();
    const [rHelm, rBody, rLegs, rHands, rPatch, rPatchSlot, rColour, rHard, rClue] = [r(), r(), r(), r(), r(), r(), r(), r(), r()];
    const colour = ranged >= 40 ? dhideColour(ranged, members, rColour) : 0;
    // (a ranger's name always wears a ranger's hat and never keeps metal: its class's look, WEAR-6)
    const named = nameClassOf(name) === 'ranger';
    const out: StylePieces = { helm: NONE, body: NONE, legs: NONE, hands: NONE, feet: NONE, keepMetal: !named && rPatch < 0.3 ? (rPatchSlot < 0.5 ? 'helm' : 'legs') : null };
    // helm
    if (ranged >= 20 && rHelm < 0.5) out.helm = o.coif;
    else if (named || rHelm < (ranged >= 20 ? 0.7 : 0.4)) out.helm = o.leatherCowl;
    // body
    if (ranged >= 40 && defence >= 40 && rBody < 0.5) out.body = o.dhideBodies[colour];
    else if (ranged >= 20 && defence >= 20 && rBody < (ranged >= 40 ? 1 : 0.6)) out.body = o.studdedBody;
    else if (ranged >= 20 || rBody < 0.7) out.body = defence >= 10 && rHard < 0.3 ? o.hardleatherBody : o.leatherBody;
    // legs
    if (ranged >= 40 && rLegs < 0.7) out.legs = o.dhideChaps[colour];
    else if (ranged >= 20 && rLegs < (ranged >= 40 ? 1 : 0.5)) out.legs = o.studdedChaps;
    else if (rLegs < (ranged >= 20 ? 0.7 : 0.4)) out.legs = o.leatherChaps;
    // hands
    if (ranged >= 40 && rHands < 0.7) out.hands = o.dhideVambraces[colour];
    else if (rHands < 0.5) out.hands = o.leatherVambraces;
    // (a rich members ranger's Treasure Trail pieces now and then: ranger boots 1 in 10, a robin hood hat 1 in 20)
    if (members && rich && ranged >= 40 && rClue < 0.1) out.feet = o.rangerBoots;
    if (members && rich && ranged >= 40 && rClue < 0.05) out.helm = o.robinHoodHat;
    if (out.keepMetal === 'helm') out.helm = NONE;
    if (out.keepMetal === 'legs') out.legs = NONE;
    return out;
}

// ── a mage's pieces (WEAR-1's ladder) ─────────────────────────────────────────

export interface MagePieces extends StylePieces {
    /** the staff it holds about (a fight's spells take the staff of air: RangedMagicTask) */
    staff: number;
    cape: number;
    neck: number;
}

/**
 * The mage's pieces a bot of this name wears for these levels (its own seed 'mage-outfit'):
 *   hat     blue wizard hat 60 %, black 25 %, none 15 %
 *   body    wizard robe 45 %, black robe 25 %, the monk's robe 10 % (its bottom too), clothes 20 %
 *   legs    a blue or black skirt 40 % (Thessalia's)
 *   staff   air; from 31 Magic an elemental staff; on a members world a battlestaff 3 in 10 of those (30 Attack), and a
 *           veteran's mystic staff 1 in 10 (40 Attack)
 *   cape    from 31 Magic a blue or purple one 4 in 10
 *   members splitbark (40 Magic and Defence) 15 %; a veteran of 60 Magic a god cape 3 in 10 (and its staff a third of
 *           those); an amulet of magic 2 in 10 of the experienced and veterans
 */
export function magePieces(name: string, magic: number, defence: number, attack: number, members: boolean, rich: boolean): MagePieces {
    const r = seededRandom(nameSeed(name, 'mage-outfit'));
    const o = outfitItems();
    const [rHat, rRobe, rSkirt, rSkirtColour, rStaff, rStaffKind, rCape, rCapeColour, rSplit, rGod, rGodKind, rAmulet] = [r(), r(), r(), r(), r(), r(), r(), r(), r(), r(), r(), r()];
    const out: MagePieces = { helm: NONE, body: NONE, legs: NONE, hands: NONE, feet: NONE, keepMetal: null, staff: o.staffOfAir, cape: NONE, neck: NONE };
    // (a mage's name always wears a wizard hat: its class's look, WEAR-6)
    out.helm = rHat < 0.6 ? o.blueWizardHat : rHat < 0.85 || nameClassOf(name) === 'mage' ? o.blackWizardHat : NONE;
    if (rRobe < 0.45) out.body = o.wizardRobe;
    else if (rRobe < 0.7) out.body = o.blackRobe;
    else if (rRobe < 0.8) {
        out.body = o.monkRobeTop;
        out.legs = o.monkRobeBottom;
    }
    if (out.legs === NONE && rSkirt < 0.4) out.legs = rSkirtColour < 0.5 ? o.blueSkirt : o.blackSkirt;
    if (magic >= 31) {
        out.staff = o.elementalStaffs[Math.floor(rStaffKind * o.elementalStaffs.length)];
        if (members && magic >= 40 && attack >= 40 && rich && rStaff < 0.1) out.staff = o.mysticStaffs[Math.floor(rStaffKind * o.mysticStaffs.length)];
        else if (members && attack >= 30 && rStaff < 0.3) out.staff = o.battlestaff;
        if (rCape < 0.4) out.cape = rCapeColour < 0.5 ? o.blueCape : o.purpleCape;
    }
    if (members && magic >= 40 && defence >= 40 && rSplit < 0.15) {
        const [helm, body, legs, gloves, boots] = o.splitbark;
        out.body = body;
        out.legs = legs;
        if (rSplit < 0.08) out.helm = helm;
        out.hands = gloves;
        out.feet = boots;
    }
    if (members && rich && magic >= 60 && rGod < 0.3) {
        const god = Math.floor(rGodKind * 3);
        out.cape = o.godCapes[god];
        if (rGod < 0.1) out.staff = o.godStaffs[god];
    }
    if (rich && rAmulet < 0.2) out.neck = o.amuletOfMagic;
    return out;
}

/** a bot that trains Magic or Ranged wears a wizard hat or a leather body at those fights, this often (its own seed) */
export const TRAINER_HAT = 0.85;
export const TRAINER_BODY = 0.5;

/**
 * (WEAR-1) does a bot that is no mage (no ranger) want a wizard hat (a leather body) for its Magic (Ranged) training,
 * from 10 Magic (Ranged: a new bot's kit has its staff and bow from there)? Its own seed 'trainer-outfit'. A mage or
 * ranger has its ladder's.
 */
export function trainerWants(name: string, magic: number, ranged: number, style: CombatStyle): { hat: boolean; body: boolean } {
    const r = seededRandom(nameSeed(name, 'trainer-outfit'));
    const [rHat, rBody] = [r(), r()];
    return { hat: style !== 'mage' && magic >= 10 && rHat < TRAINER_HAT, body: style !== 'ranger' && ranged >= 10 && rBody < TRAINER_BODY };
}

// ── weapon taste (WEAR-2) ─────────────────────────────────────────────────────

export type WeaponKind = 'scimitar' | 'longsword' | 'battleaxe' | '2h' | 'mace' | 'sword' | 'dagger' | 'warhammer';

/** the share of each liked kind (2004's F2P melee: the scimitar first, the longsword, then the rest) */
export const WEAPON_KIND_SHARES: ReadonlyArray<[WeaponKind, number]> = [
    ['scimitar', 0.55],
    ['longsword', 0.14],
    ['battleaxe', 0.08],
    ['2h', 0.07],
    ['mace', 0.06],
    ['sword', 0.05],
    ['dagger', 0.025],
    ['warhammer', 0.025]
];

/** The kind of melee weapon a bot of this name likes (its own seed 'weapon-kind'). */
export function weaponKindOf(name: string): WeaponKind {
    let roll = seededRandom(nameSeed(name, 'weapon-kind'))();
    for (const [kind, share] of WEAPON_KIND_SHARES) {
        if (roll < share) return kind;
        roll -= share;
    }
    return 'scimitar';
}

/** the Attack each metal (port/BotLooks METALS' order: bronze, iron, steel, black, mithril, adamant, rune, dragon) needs to wield */
export const WEAPON_ATTACK: readonly number[] = [1, 1, 5, 10, 20, 30, 40, 60];
/** every kind's weapons by metal, 274's debugnames (null: none in 2004; the adamant warhammer is 'adamnt_warhammer') */
const WEAPON_NAMES: Readonly<Record<WeaponKind, readonly (string | null)[]>> = {
    scimitar: ['bronze_scimitar', 'iron_scimitar', 'steel_scimitar', 'black_scimitar', 'mithril_scimitar', 'adamant_scimitar', 'rune_scimitar', null],
    longsword: ['bronze_longsword', 'iron_longsword', 'steel_longsword', 'black_longsword', 'mithril_longsword', 'adamant_longsword', 'rune_longsword', 'dragon_longsword'],
    battleaxe: ['bronze_battleaxe', 'iron_battleaxe', 'steel_battleaxe', 'black_battleaxe', 'mithril_battleaxe', 'adamant_battleaxe', 'rune_battleaxe', 'dragon_battleaxe'],
    '2h': ['bronze_2h_sword', 'iron_2h_sword', 'steel_2h_sword', 'black_2h_sword', 'mithril_2h_sword', 'adamant_2h_sword', 'rune_2h_sword', null],
    mace: ['bronze_mace', 'iron_mace', 'steel_mace', 'black_mace', 'mithril_mace', 'adamant_mace', 'rune_mace', 'dragon_mace'],
    sword: ['bronze_sword', 'iron_sword', 'steel_sword', 'black_sword', 'mithril_sword', 'adamant_sword', 'rune_sword', null],
    dagger: ['bronze_dagger', 'iron_dagger', 'steel_dagger', 'black_dagger', 'mithril_dagger', 'adamant_dagger', 'rune_dagger', 'dragon_dagger'],
    warhammer: ['bronze_warhammer', 'iron_warhammer', 'steel_warhammer', 'black_warhammer', 'mithril_warhammer', 'adamnt_warhammer', 'rune_warhammer', null]
};

export interface MeleeWeapon {
    id: number;
    kind: WeaponKind;
    /** the metal: WEAPON_ATTACK's index */
    tier: number;
}

let WEAPONS: MeleeWeapon[] | null = null;
let WEAPON_BY_ID: Map<number, MeleeWeapon> | null = null;
let DDS = -1;

/** Every melee weapon of the eight kinds by metal (WEAPON_NAMES), and a members veteran's poisoned dragon dagger. */
export function meleeWeapons(): readonly MeleeWeapon[] {
    if (WEAPONS) return WEAPONS;
    const out: MeleeWeapon[] = [];
    for (const [kind] of WEAPON_KIND_SHARES) {
        WEAPON_NAMES[kind].forEach((name, tier) => {
            const id = name === null ? -1 : ObjType.getId(name);
            if (id !== -1) out.push({ id, kind, tier });
        });
    }
    DDS = ObjType.getId('dragon_dagger_p');
    if (DDS !== -1) out.push({ id: DDS, kind: 'dagger', tier: 7 });
    WEAPONS = out;
    WEAPON_BY_ID = new Map(out.map(w => [w.id, w]));
    return out;
}

/** The melee weapon an item is (kind and metal), or undefined (a tool, a bow, a staff, the scythe). */
export function meleeWeaponOf(id: number): MeleeWeapon | undefined {
    if (!WEAPON_BY_ID) meleeWeapons();
    return WEAPON_BY_ID!.get(id);
}

/** The weapon of this kind and metal, or undefined (no dragon scimitar, sword, 2h or warhammer in 274's 2004). */
export function weaponOf(kind: WeaponKind, tier: number): MeleeWeapon | undefined {
    return meleeWeapons().find(w => w.kind === kind && w.tier === tier && w.id !== DDS);
}

/** The best metal an Attack level may wield (0 at least; no dragon below 60). */
export function weaponMetalForAttack(attack: number): number {
    let best = 0;
    for (let t = 0; t < WEAPON_ATTACK.length; t++) if (attack >= WEAPON_ATTACK[t]) best = t;
    return best;
}

/**
 * A members veteran's dragon weapon (60 Attack: the Lost City's longsword 25 %, the Heroes' Guild's battleaxe and mace 5 %
 * each, a poisoned dragon dagger 5 %), or null: its own seed 'weapon-dragon'.
 */
export function dragonWeaponOf(name: string): number | null {
    const roll = seededRandom(nameSeed(name, 'weapon-dragon'))();
    const pick = roll < 0.25 ? 'dragon_longsword' : roll < 0.3 ? 'dragon_battleaxe' : roll < 0.35 ? 'dragon_mace' : roll < 0.4 ? 'dragon_dagger_p' : null;
    if (!pick) return null;
    const id = ObjType.getId(pick);
    return id === -1 ? null : id;
}

/** A rich free-world bot of 40 Attack whose taste is the scimitar: 2004's rune 2h or rune longsword instead, 1 in 5. */
export function richRuneWeaponOf(name: string): number | null {
    const r = seededRandom(nameSeed(name, 'weapon-rich'));
    if (r() >= 0.2) return null;
    const id = ObjType.getId(r() < 0.5 ? 'rune_2h_sword' : 'rune_longsword');
    return id === -1 ? null : id;
}

// ── skill clothes (WEAR-3) ────────────────────────────────────────────────────

export type MainSkill = 'cooking' | 'smithing' | 'crafting' | 'fishing' | 'prayer' | 'mining' | 'woodcutting' | 'other';

/** the stats (274's PlayerStat indices) whose clothes there are */
const STAT_OF: ReadonlyArray<[MainSkill, number]> = [
    ['cooking', 7],
    ['woodcutting', 8],
    ['fishing', 10],
    ['crafting', 12],
    ['smithing', 13],
    ['mining', 14]
];
/** the skills a main skill is chosen among (no combat, no Hitpoints, no Prayer: Prayer goes by its own rule) */
const NON_COMBAT = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20];

/**
 * A bot's main skill: its highest non-combat skill (ties by the stat's order), at 10 or more; 'other' when that is a skill
 * without clothes; null below 10 (a newcomer). 'prayer' is separate (prayerTrainer).
 */
export function mainSkillOf(levels: ArrayLike<number>): MainSkill | null {
    let best = -1;
    let bestLevel = 9;
    for (const stat of NON_COMBAT) {
        if ((levels[stat] ?? 0) > bestLevel) {
            best = stat;
            bestLevel = levels[stat];
        }
    }
    if (best === -1) return null;
    return STAT_OF.find(([, stat]) => stat === best)?.[0] ?? 'other';
}

/** Is Prayer among the bot's three highest skills (Hitpoints aside), at 20 or more? */
export function prayerTrainer(levels: ArrayLike<number>): boolean {
    const prayer = levels[5] ?? 1;
    if (prayer < 20) return false;
    let higher = 0;
    for (let stat = 0; stat < 21; stat++) if (stat !== 3 && stat !== 5 && stat !== 18 && stat !== 19 && (levels[stat] ?? 0) > prayer) higher++;
    return higher < 3;
}

export interface SkillClothes {
    chefsHat: boolean;
    whiteApron: boolean;
    brownApron: boolean;
    gloves: boolean;
    boots: boolean;
    cape: boolean;
    monkRobe: boolean;
}

/** the chef's hat away from the range: of the cooks that own one, this many keep it on (a joke hat) */
export const JOKE_CHEFS_HAT = 0.05;

/**
 * The clothes of the bot's main skill (its own seed 'skill-clothes'): a cook's chef's hat 50 % and white apron 50 %; a
 * smith's or crafter's brown apron 60 % and leather gloves 40 %; a fisher's boots 60 % and a cape 50 %; a prayer
 * trainer's monk's robe 10 %. A chef's or smith's name gives its class's. Only a cook owns a chef's hat (no shop of 274
 * stocks one); 1 in 20 of them keeps it on away from the range (chefsHatAnywhere).
 */
export function skillClothesOf(name: string, main: MainSkill | null, prayer = false): SkillClothes {
    const r = seededRandom(nameSeed(name, 'skill-clothes'));
    const [rHat, rApron, rBrown, rGloves, rBoots, rCape, rMonk, rJoke] = [r(), r(), r(), r(), r(), r(), r(), r()];
    const cls = nameClassOf(name);
    const cook = main === 'cooking';
    const smith = main === 'smithing' || main === 'crafting';
    return {
        chefsHat: cls === 'chef' || (cook && rHat < 0.5),
        whiteApron: cls === 'chef' || (cook && rApron < 0.5),
        brownApron: cls === 'smith' || (smith && rBrown < 0.6),
        gloves: smith && rGloves < 0.4,
        boots: main === 'fishing' && rBoots < 0.6,
        cape: main === 'fishing' && rCape < 0.5,
        monkRobe: cls === 'monk' || (prayer && rMonk < 0.1)
    };
}

/** Does this bot, if it owns a chef's hat, wear it away from the range too (a chef's name, or the joke: 1 in 20)? */
export function chefsHatAnywhere(name: string): boolean {
    if (nameClassOf(name) === 'chef') return true;
    const r = seededRandom(nameSeed(name, 'skill-clothes'));
    for (let i = 0; i < 7; i++) r();
    return r() < JOKE_CHEFS_HAT;
}

// ── tools in hand (WEAR-3) ────────────────────────────────────────────────────

/**
 * the share of bots that wield their axe or pickaxe at the trees and rocks: the default is half the woodcutters and
 * miners seen with it in hand, and a wielder holds it about 3 in 4 of its gathering time (not before its first try, nor
 * when it owns no tool its Attack lets it wield: a steel pickaxe needs 5, a rune axe 40), so 6 in 10 wield (at 5 in 10, 31-46 %
 * of the samples showed a tool and 29-37 % a scimitar over seven runs)
 */
export const TOOL_WIELDERS = 0.6;

/** Does a bot of this name wield its axe or pickaxe at the trees and rocks? (its own seed; a miner's or woodcutter's name always) */
export function wieldsTools(name: string): boolean {
    const cls = nameClassOf(name);
    if (cls === 'miner' || cls === 'woodcutter') return true;
    return seededRandom(nameSeed(name, 'tools-in-hand'))() < TOOL_WIELDERS;
}

let AXES: number[] | null = null;
let PICKAXES: number[] | null = null;

/** the axes and pickaxes, worst to best by the metal (274: bronze, iron, steel, black (axe), mithril, adamant, rune) */
export function toolLadders(): { axes: number[]; pickaxes: number[] } {
    if (!AXES || !PICKAXES) {
        AXES = ['bronze_axe', 'iron_axe', 'steel_axe', 'black_axe', 'mithril_axe', 'adamant_axe', 'rune_axe'].map(n => ObjType.getId(n)).filter(i => i !== -1);
        PICKAXES = ['bronze_pickaxe', 'iron_pickaxe', 'steel_pickaxe', 'mithril_pickaxe', 'adamant_pickaxe', 'rune_pickaxe'].map(n => ObjType.getId(n)).filter(i => i !== -1);
    }
    return { axes: AXES, pickaxes: PICKAXES };
}

/** Is the item an axe or a pickaxe? */
export function isGatheringTool(id: number): boolean {
    const { axes, pickaxes } = toolLadders();
    return axes.includes(id) || pickaxes.includes(id);
}

const TOOL_METALS = ['bronze', 'iron', 'steel', 'black', 'mithril', 'adamant', 'rune'] as const;

/** The Attack level 274 asks to wield an axe or pickaxe (tier1-tier40.rs2: bronze and iron 1, steel 5, black 10, mithril 20, adamant 30, rune 40). */
export function toolWieldAttack(id: number): number {
    const name = ObjType.get(id)?.debugname ?? '';
    const metal = TOOL_METALS.findIndex(m => name.startsWith(`${m}_`));
    return metal < 0 ? 1 : WEAPON_ATTACK[metal];
}

// ── a class's look (WEAR-6) ───────────────────────────────────────────────────

/** The members world's pirate's hat (a clue reward), for a pirate's name. */
export function pirateHatFor(name: string, members: boolean): number {
    return members && nameClassOf(name) === 'pirate' ? outfitItems().pirateHat : NONE;
}

/**
 * (WEAR-6) a PKer whose name promises a mage or a ranger: its build as before (its levels, weapons, behaviour), in its
 * class's look: a mage's name a wizard hat (blue or black) and, a pure's (Defence under 40), the monk's robe (the hybrid
 * pure's); an archer's name a coif and, a pure's, a leather body (a main of 40 Defence the green d'hide body). Null for
 * any other name. (Its own seed; the profile's other fields are kept.)
 */
export function classPkProfile<T extends { def: number; helm: number; body: number }>(name: string, profile: T, salt: string): T | null {
    const cls = nameClassOf(name);
    if (cls !== 'mage' && cls !== 'ranger') return null;
    // (the same object at every call, as the tables' profiles are: a PK task's profile is its name's)
    let byName = PK_LOOKS.get(profile);
    if (!byName) PK_LOOKS.set(profile, (byName = new Map()));
    const key = `${salt}:${name}`;
    const known = byName.get(key) as T | undefined;
    if (known) return known;
    const r = seededRandom(nameSeed(name, `${salt}-class`));
    const o = outfitItems();
    const out = cls === 'mage' ? { ...profile, helm: r() < 0.6 ? o.blueWizardHat : o.blackWizardHat, body: profile.def < 40 ? o.monkRobeTop : profile.body } : { ...profile, helm: o.coif, body: profile.def < 40 ? o.leatherBody : o.dhideBodies[0] };
    byName.set(key, out);
    return out;
}
const PK_LOOKS = new WeakMap<object, Map<string, unknown>>();

/**
 * (the variety work, round 1, the fixes: the integrator's rule) a PKer's profile at its login: its class's look
 * (classPkProfile) for a bot new since this rule (no save at this login: `saved` false), or a saved one whose save shows
 * that look (it owns, worn, packed or banked, the class profile's helm or body: it was new since round 1 when it came);
 * else the profile as before. A PK task re-issues its profile's gear every session (replenish), so a mage's or archer's
 * name saved before round 1 came back in a wizard hat and monk's top, or a coif and leather: saved bots keep their looks.
 * No mark in the save format: the look itself is the mark (one lost at a death and logged out before the next replenish
 * gives the profile as before from then on).
 */
export function pkProfileAtLogin<T extends { def: number; helm: number; body: number }>(name: string, profile: T, salt: string, saved: boolean, owns: (id: number) => boolean): T {
    const cls = classPkProfile(name, profile, salt);
    if (!cls) return profile;
    if (!saved) return cls;
    const shows = (id: number, before: number): boolean => id !== NONE && id !== before && owns(id);
    return shows(cls.helm, profile.helm) || shows(cls.body, profile.body) ? cls : profile;
}

/**
 * Is a worn outfit (worn slot → item, -1 for none) the look of the class the name promises? A mage's: a wizard hat, a
 * robe, a skirt or a staff; a ranger's: a ranger's piece or a bow; a miner's a pickaxe in hand, a woodcutter's an axe; a
 * chef's the chef's hat or white apron; a smith's the brown apron; a monk's the monk's robe; a pirate's the pirate's hat
 * (a free world: any look); a knight's a full helm or a kiteshield. Null: no class.
 */
export function inClassLook(name: string, worn: readonly number[], members: boolean): boolean | null {
    const cls = nameClassOf(name);
    if (!cls) return null;
    const o = outfitItems();
    const at = (slot: number): number => worn[slot] ?? NONE;
    const debug = (slot: number): string => (at(slot) === NONE ? '' : ObjType.get(at(slot))?.debugname ?? '');
    switch (cls) {
        case 'mage':
            return [0, 4, 7].some(s => isMagePiece(at(s))) || /staff/.test(debug(3));
        case 'ranger':
            return [0, 4, 7, 9, 10].some(s => isRangerPiece(at(s))) || /bow$/.test(debug(3));
        case 'miner':
            return /pickaxe$/.test(debug(3));
        case 'woodcutter':
            return /_axe$/.test(debug(3));
        case 'chef':
            return at(0) === o.chefsHat || at(4) === o.whiteApron;
        case 'smith':
            return at(4) === o.brownApron;
        case 'monk':
            return at(4) === o.monkRobeTop || at(7) === o.monkRobeBottom;
        case 'pirate':
            return !members || at(0) === o.pirateHat;
        case 'knight':
            return /_full_helm$/.test(debug(0)) || /_kiteshield$/.test(debug(5));
    }
}
