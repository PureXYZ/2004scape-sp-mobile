// port (PK tactics: play-testing notes on the Edgeville PKers): how 2004's PKers fought, for both PK tasks
// (tasks/PKerTask, tasks/EdgevillePKerTask), on top of port/BotPkTactics (prayers, the kill line, the honour call-out).
// Play-testing showed: bots that ate all their food and died where people ran or teleported; a magic shortbow and a rune
// scimitar on one bot (a ranger keeps its bow and switches to a melee KO weapon); dragon battleaxe specials everywhere
// (people spec with a KO weapon: the dragon dagger); no use of the KO switch (hit with a fast weapon, then switch to the
// hard hitter: its hit comes on the fast weapon's tick); no potions to raise the max hit. What this module does, all
// through the game's own scripts (274's content), as a player's clicks:
//
//   - the kit (pkKitted): a fight style and a KO weapon from the bot's own seed, on top of its build and outfit. Melee:
//     its weapon (mostly a rune scimitar) and a dragon dagger (p), a dragon longsword, a dragon mace or a rune 2h sword
//     (pures, and on a free world) to switch to; no bow. Rangers (a share of the pures with the Ranged): the magic
//     shortbow on rapid, its own double special at a target out of melee reach (35 % a spec in 274, two in a row: the
//     2004 ranger's KO), and a dragon dagger (p) for one beside it; no scimitar. No dragon battleaxe special: its
//     Rampage only raises Strength.
//     Potions for the style (super strength and attack; ranging and super strength), and a way out: a charged amulet of
//     glory in the pack (members), or Varrock teleport's runes with Magic 25+, or nothing (it runs);
//   - eating (PkFight.eat): at its own share of its Hitpoints, and sooner when the target can hit that hard (the biggest
//     hit it took this fight; the target's KO weapon in hand: a dragon dagger's two hits). Never a bite that heals
//     mostly nothing. 274's food takes 3 ticks off the next attack (consume.rs2), so it eats only when it must;
//   - getting out (PkFight.flee): low on food and losing, or out of food and hurt, it runs out of the Wilderness or
//     teleports (the glory's Rub, Edgeville; the spell's button) where the level allows it (274: glory to 30, spells to
//     20, no Teleblock yet); a careless one pushes on longer; not with the target in its KO range (it goes for the kill);
//   - the KO (PkFight.ko): with the target in reach of its KO weapon's hit (a special's max, the 2h's max), right after
//     its own fast hit it switches to the KO weapon (and its special bar): 274 times the next attack from the last
//     weapon's speed (%action_delay, set at each attack; the wear script leaves it alone), so the KO weapon hits on the
//     fast weapon's tick. A dragon dagger specs again while the target is still in reach and the bar has the energy
//     (25 % a spec), then the main weapon goes back on;
//   - potions (PkFight.potions): a dose at a time at the start of a fight (the stat not boosted yet), again once it has
//     worn down to a point or two; the game's Drink (the next vial, the boost; 274 holds the drinker 2 ticks for its
//     messages). The lowest vial first.
//
// Round 2 (the second round of notes): 1-Attack rangers in the kit (the bow alone, its own special the KO),
// a prayer potion in the melee kits with 31+ Prayer, the melee boost prayers' habit (PkFight.offence; pressed by
// port/BotPkTactics), the prayer points back at a restock (pkRecharge), and the PJers' share (port/BotPkPj).
//
// Per bot and engage tick: a few varp reads, a pass over its pack; the max hits from the worn items' params.
import ObjType from '#/cache/config/ObjType.js';
import ParamType from '#/cache/config/ParamType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import InvType from '#/cache/config/InvType.js';
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import { botAnswerDialogue, interactHeldOp, interactIfButtonByName, interactPlayerOp, noteMove, setVarp, _wornContains } from '#/engine/bot/BotAction.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { personaOf } from '#/engine/bot/port/BotPersona.js';
import { botReactionTicks } from '#/engine/bot/port/BotTiming.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { pkTryEquipFromInventory, wieldsSpecialWeapon, type PkProfile } from '#/engine/bot/port/BotPkGear.js';

// ── the items (274 debugnames, resolved once) ───────────────────────────────────────────────────────────────────────

const NAMES = {
    dds: 'dragon_dagger_p',
    dlong: 'dragon_longsword',
    dmace: 'dragon_mace',
    dba: 'dragon_battleaxe',
    msb: 'magic_shortbow',
    runeArrow: 'rune_arrow',
    rune2h: 'rune_2h_sword',
    runeScim: 'rune_scimitar',
    superStr: '4dose2strength',
    superAtt: '4dose2attack',
    superDef: '4dose2defense',
    ranging: '4doserangerspotion',
    prayer: '4doseprayerrestore',
    strength: 'strength4',
    glory4: 'amulet_of_glory_4',
    law: 'lawrune',
    air: 'airrune',
    fire: 'firerune',
    coif: 'coif',
    strengthAmulet: 'amulet_of_strength',
    power: 'amulet_of_power'
} as const;
type ItemKey = keyof typeof NAMES;
let ids: Record<ItemKey, number> | null = null;
/** the kit's items by key (274 obj ids) */
export function pkKitItems(): Record<ItemKey, number> {
    if (!ids) ids = Object.fromEntries(Object.entries(NAMES).map(([k, n]) => [k, ObjType.getId(n)])) as Record<ItemKey, number>;
    return ids;
}

/** a potion's four vials, from 4 doses to 1 (274's next_obj_stage): the bot drinks the lowest first */
const VIALS: Record<string, readonly string[]> = {
    '4dose2strength': ['4dose2strength', '3dose2strength', '2dose2strength', '1dose2strength'],
    '4dose2attack': ['4dose2attack', '3dose2attack', '2dose2attack', '1dose2attack'],
    '4dose2defense': ['4dose2defense', '3dose2defense', '2dose2defense', '1dose2defense'],
    '4doserangerspotion': ['4doserangerspotion', '3doserangerspotion', '2doserangerspotion', '1doserangerspotion'],
    '4doseprayerrestore': ['4doseprayerrestore', '3doseprayerrestore', '2doseprayerrestore', '1doseprayerrestore'],
    strength4: ['strength4', '3dose1strength', '2dose1strength', '1dose1strength']
};
/** what a potion boosts and by how much (274's consume_effects.dbrow: stat_change, a constant and a percentage) */
const BOOSTS: Record<string, { stat: PlayerStat; add: number; pct: number }> = {
    '4dose2strength': { stat: PlayerStat.STRENGTH, add: 5, pct: 15 },
    '4dose2attack': { stat: PlayerStat.ATTACK, add: 5, pct: 15 },
    '4dose2defense': { stat: PlayerStat.DEFENCE, add: 5, pct: 15 },
    '4doserangerspotion': { stat: PlayerStat.RANGED, add: 4, pct: 10 },
    strength4: { stat: PlayerStat.STRENGTH, add: 3, pct: 10 }
};
const vialIds = new Map<number, number[]>();
/** the vials of the potion whose 4-dose id this is, 1 dose first; [] for a potion this module does not know */
export function vialsOf(potion4: number): number[] {
    let list = vialIds.get(potion4);
    if (!list) {
        const name = ObjType.get(potion4)?.debugname ?? '';
        list = (VIALS[name] ?? []).map(n => ObjType.getId(n)).filter(id => id !== -1).reverse();
        vialIds.set(potion4, list);
    }
    return list;
}

/** the charged glories, the last charge first (a bot rubs the one with the fewest charges) */
let gloryIds: number[] | null = null;
function glories(): number[] {
    if (!gloryIds) gloryIds = ['amulet_of_glory_1', 'amulet_of_glory_2', 'amulet_of_glory_3', 'amulet_of_glory_4'].map(n => ObjType.getId(n)).filter(id => id !== -1);
    return gloryIds;
}

// ── the kit ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** how a kit gets out of the Wilderness: a glory in the pack, the Varrock teleport's runes, or on foot */
export type PkTele = 'glory' | 'spell' | null;

/** a share of the pures with this much Ranged fight with the magic shortbow (members) */
export const RANGER_RANGED = 70;
export const RANGER_SHARE = 0.5;
/** arrows a ranger wears at its restock (274's rapid shortbow: an arrow every 3 ticks) */
export const RANGER_ARROWS: [number, number] = [120, 250];
/**
 * (round 2, 2026-10-19: "1-attack rangers") a share of those pures that are not the hybrid rangers: 2004's
 * pure ranger, "1 Attack, 40 Defence, 1 Strength" in d'hide (the research: Sal's Realm, Dec 2004), the bow alone and
 * its own double special the KO; most with the 40 Defence for the d'hide body, the rest at 1 in the pures' body
 */
export const ARCHER_SHARE = 0.25;
const ARCHER_DEFENCE_SHARE = 0.6;
/** d'hide by tier (274's levelrequire: the body 40 Defence and the tier's Ranged; the chaps the Ranged only) */
const DHIDE: readonly { ranged: number; body: string; chaps: string }[] = [
    { ranged: 40, body: 'dragonhide_body', chaps: 'dragonhide_chaps' },
    { ranged: 50, body: 'blue_dragonhide_body', chaps: 'blue_dragonhide_chaps' },
    { ranged: 60, body: 'red_dragonhide_body', chaps: 'red_dragonhide_chaps' },
    { ranged: 70, body: 'black_dragonhide_body', chaps: 'black_dragonhide_chaps' }
];
/** the d'hide body that goes with these chaps (a full set), else the best for this Ranged */
function dhideBody(chaps: number, ranged: number): number {
    const name = ObjType.get(chaps)?.debugname ?? '';
    const tier = DHIDE.find(t => t.chaps === name) ?? [...DHIDE].reverse().find(t => ranged >= t.ranged) ?? DHIDE[0]!;
    return ObjType.getId(tier.body);
}
/** the ways out by task: [glory (members), spell (Magic 25+)] shares; the rest run */
export const TELE_SHARES = { edge: [0.3, 0.2], deep: [0.65, 0.25] } as const;
/** Varrock teleport (274's magic_spells.dbrow): Magic 25, a law, three airs, a fire; works up to level 20 */
export const SPELL_LEVEL = 25;
const SPELL_BUTTON = 'magic:varrock_teleport';
const SPELL_WILD = 20;
const GLORY_WILD = 30;

const KITTED = new WeakMap<object, Map<string, PkProfile>>();

/**
 * The fight's kit of a PK profile (after its build, class look and outfit variety): the style, the main weapon, the KO
 * weapon (`specWeapon`: a special's weapon, or a free world's rune 2h), no separate bow, potions for the style, the way
 * out. From the bot's own seed (`${salt}:pk-kit` of its name): the same at every login. The same object for the same
 * profile and name (the PK tasks and the tests compare them).
 */
export function pkKitted<T extends PkProfile>(name: string, profile: T, salt: string, members: boolean): T {
    let byName = KITTED.get(profile);
    if (!byName) KITTED.set(profile, (byName = new Map()));
    const key = `${salt}:${name}:${members}`;
    const known = byName.get(key) as T | undefined;
    if (known) return known;
    const out = kitOf(name, profile, salt, members);
    byName.set(key, out);
    return out;
}

function kitOf<T extends PkProfile>(name: string, profile: T, salt: string, members: boolean): T {
    const r = seededRandom(nameSeed(name, `${salt}:pk-kit`));
    // (round 2's draws after round 1's: a bot's round-1 kit stays as it was)
    const [rStyle, rKo, rTele, rMagic, rArrows, rDef, rHelm] = Array.from({ length: 7 }, () => r());
    const K = pkKitItems();
    const out: T = { ...profile, pots: [...profile.pots] };
    const pure = profile.def <= 1;
    const twoHanded = (id: number): boolean => id !== -1 && ObjType.get(id)?.wearpos2 === 5;
    if (members && pure && profile.range >= RANGER_RANGED && rStyle < RANGER_SHARE) {
        // a ranger: the bow on rapid all fight, a dragon dagger (p) for the KO; super strength for the dagger's hits
        out.style = 'ranged';
        out.weapon = K.msb;
        out.rangeWeapon = K.msb;
        out.ammo = K.runeArrow;
        out.ammoCount = Math.round(RANGER_ARROWS[0] + rArrows * (RANGER_ARROWS[1] - RANGER_ARROWS[0]));
        out.shield = -1;
        out.specWeapon = K.dds;
        out.pots = [K.ranging, K.superStr, ...profile.pots.filter(id => id === K.prayer)];
    } else if (members && pure && profile.range >= RANGER_RANGED && rStyle < RANGER_SHARE + ARCHER_SHARE) {
        // (round 2) a 1-Attack ranger: 1 Attack and Strength (its combat level from its Ranged), the bow on rapid all
        // fight and its own double special for the KO (in hand: no switch), a coif and d'hide; no melee weapon, no
        // strength potion, no melee prayer to boost it (274 has none for Ranged)
        out.style = 'ranged';
        out.atk = 1;
        out.str = 1;
        out.def = rDef < ARCHER_DEFENCE_SHARE ? 40 : 1;
        out.weapon = K.msb;
        out.rangeWeapon = K.msb;
        out.specWeapon = K.msb;
        out.ammo = K.runeArrow;
        out.ammoCount = Math.round(RANGER_ARROWS[0] + rArrows * (RANGER_ARROWS[1] - RANGER_ARROWS[0]));
        out.shield = -1;
        if (out.def >= 40) out.body = dhideBody(out.legs, out.range);
        if (rHelm < 0.6) out.helm = K.coif;
        if (out.neck === K.strengthAmulet) out.neck = K.power;
        out.pots = [K.ranging, ...profile.pots.filter(id => id === K.prayer)];
    } else {
        out.style = 'melee';
        out.rangeWeapon = -1;
        out.ammo = -1;
        out.ammoCount = 0;
        if (members) {
            // (the dragon battleaxe stays a weapon some carry, never the KO: Rampage only raises Strength)
            const main = out.weapon === K.msb ? K.runeScim : out.weapon;
            out.weapon = main;
            if (main === K.dlong) out.specWeapon = rKo < 0.6 ? K.dds : K.dlong;
            // (a pure's: also 2004's scimitar and rune 2h sword, its hit on the scimitar's tick)
            else if (pure) out.specWeapon = rKo < 0.5 ? K.dds : rKo < 0.7 ? K.dlong : rKo < 0.9 ? K.rune2h : K.dmace;
            else out.specWeapon = rKo < 0.6 ? K.dds : rKo < 0.85 ? K.dlong : K.dmace;
        } else {
            // a free world's KO: a rune 2h sword after the scimitar's hit (no special attack in F2P)
            out.specWeapon = out.weapon === K.runeScim && rKo < 0.6 ? K.rune2h : -1;
        }
        if (twoHanded(out.weapon)) out.shield = -1;
        // (round 2: the melee boost prayers drain the points) a prayer potion with Ultimate Strength's 31 Prayer
        if (members && profile.pray >= 31 && !out.pots.includes(K.prayer)) out.pots.push(K.prayer);
    }
    // the way out: a glory to rub (members), the Varrock teleport's runes (Magic 25+), else on foot
    const [gloryShare, spellShare] = salt === 'pker' ? TELE_SHARES.deep : TELE_SHARES.edge;
    out.tele = members && rTele < gloryShare ? 'glory' : rTele < gloryShare + spellShare ? 'spell' : null;
    out.magic = out.tele === 'spell' ? SPELL_LEVEL + Math.floor(rMagic * 26) : 0;
    return out;
}

/** the items of the kit's way out, for its restock: [id, count] */
export function pkTeleItems(profile: PkProfile): [number, number][] {
    const K = pkKitItems();
    if (profile.tele === 'glory') return [[K.glory4, 1]];
    if (profile.tele === 'spell') return [[K.law, 2], [K.air, 6], [K.fire, 2]];
    return [];
}

const BUILD_STATS = [
    [PlayerStat.ATTACK, 'atk'],
    [PlayerStat.STRENGTH, 'str'],
    [PlayerStat.DEFENCE, 'def'],
    [PlayerStat.HITPOINTS, 'hp'],
    [PlayerStat.RANGED, 'range'],
    [PlayerStat.PRAYER, 'pray']
] as const;

/**
 * The build's combat levels (the PK tasks' init), all six whenever any differs. (Play-testing: a level 3 in the
 * Wilderness in d'hide with a magic shortbow. The tasks set them only when Attack differed, and a 1-Attack ranger's
 * Attack 1 is a new bot's: it kept its 3 and wore the kit.) The engine's setLevel: the combat level shown too.
 */
export function pkSetLevels(player: Player, profile: PkProfile): void {
    for (const [stat, key] of BUILD_STATS) {
        if (player.baseLevels[stat] !== profile[key]) player.setLevel(stat, profile[key]);
    }
}

/**
 * The kit's Magic level (its teleport spell): raised to it when lower, never lowered. The PK builds' combat levels come
 * from Attack and Strength or Ranged (at least 83 of melee or 56 of Ranged times 1.5), so Magic 50 never changes one.
 */
export function pkSetMagic(player: Player, profile: PkProfile): void {
    const want = profile.magic ?? 0;
    if (want <= 0 || player.baseLevels[PlayerStat.MAGIC] >= want) return;
    const before = player.getCombatLevel();
    const had = player.baseLevels[PlayerStat.MAGIC];
    player.setLevel(PlayerStat.MAGIC, want);
    if (player.getCombatLevel() !== before) player.setLevel(PlayerStat.MAGIC, had);
}

// ── the bot's ways (its seed and its persona) ────────────────────────────────────────────────────────────────────────

export interface PkWays {
    /** it eats at this share of its Hitpoints (sooner when the target hits harder) */
    eatAt: number;
    /** it thinks of leaving with this much food left or less (most 2-5), and under this share of its Hitpoints */
    fleeFood: number;
    fleeBelow: number;
    /** out of food, it leaves under this share */
    fleeEmpty: number;
    /** it goes for the KO with the target at this many times its KO hit or less */
    koReach: number;
    /** it teleports (when it can) rather than run, this often */
    teleShare: number;
    /** after a fight, it goes to the bank with this much food or less */
    restockAt: number;
    /** with both in each other's KO reach, it stays for the kill (else it leaves) */
    bold: boolean;
    /**
     * (round 2) its melee boost prayers (Strength, Attack): on all fight long, only with the KO near (the points saved
     * for the kill), or never
     */
    pray: 'fight' | 'ko' | 'never';
    /** (round 2) it PJs: watches a fight near it and jumps the one left of it (port/BotPkPj) */
    pj: boolean;
}

/** (round 2) the shares of the melee boost habits: all fight long, for the KO; the rest never */
export const PRAY_SHARES = { fight: 0.55, ko: 0.35 } as const;
/** (round 2) about 1 PKer in 5 PJs (the research's estimate) */
export const PJ_SHARE = 0.2;

const ways = new Map<string, PkWays>();

/** A PKer's own ways in a fight: from its name (the same at every login), a careless persona pushing on longer. */
export function pkWaysOf(name: string): PkWays {
    let w = ways.get(name);
    if (w) return w;
    const r = seededRandom(nameSeed(name, 'pk-ways'));
    const careless = Math.min(1, personaOf(name).carelessness);
    const rFood = r();
    // (about 1 in 4 "safe": it eats near full whenever it can)
    const safe = careless <= 0.5 && r() < 0.25;
    const first = {
        eatAt: safe ? 0.7 + r() * 0.1 : 0.42 + r() * 0.16 - careless * 0.12,
        // (2004's PKers left with a few sharks to eat on the way out; a careless one fought to its last)
        fleeFood: careless > 0.6 ? (rFood < 0.5 ? 0 : 1) : rFood < 0.1 ? 1 : rFood < 0.3 ? 2 : rFood < 0.6 ? 3 : rFood < 0.85 ? 4 : 5,
        fleeBelow: 0.5 + r() * 0.15 - careless * 0.2,
        fleeEmpty: 0.55 + r() * 0.2 - careless * 0.3,
        koReach: 0.8 + r() * 0.45,
        teleShare: 0.4 + r() * 0.4,
        restockAt: 3 + Math.floor(r() * 5),
        bold: careless > 0.5 || r() < 0.3
    };
    // (round 2's draws after round 1's: its round-1 ways stay as they were; a careless one keeps its prayers on)
    const rPray = r() - careless * 0.2;
    w = {
        ...first,
        pray: rPray < PRAY_SHARES.fight ? 'fight' : rPray < PRAY_SHARES.fight + PRAY_SHARES.ko ? 'ko' : 'never',
        pj: r() < PJ_SHARE
    };
    ways.set(name, w);
    return w;
}

// ── the numbers a player knows: max hits, food, energy ──────────────────────────────────────────────────────────────

const PARAMS: Record<string, number> = {};
function param(name: string): number {
    return (PARAMS[name] ??= ParamType.getId(name));
}
function objParam(id: number, name: string, fallback = 0): number {
    if (id === -1) return fallback;
    const p = param(name);
    const v = p === -1 ? undefined : ObjType.get(id)?.params?.get(p);
    return typeof v === 'number' ? v : fallback;
}

function varp(player: Player, name: string): number {
    const v = VarPlayerType.getByName(name);
    return v ? (player.getVar(v.id) as number) : 0;
}

/** the strength prayer's multiple (274's check_strength_prayer: prayer1, 4, 10) */
function strengthPrayer(player: Player): number {
    if (varp(player, 'prayer10') === 1) return 115;
    if (varp(player, 'prayer4') === 1) return 110;
    if (varp(player, 'prayer1') === 1) return 105;
    return 100;
}

/** the worn strength bonus with `weapon` in hand (a two-handed one with no shield) */
function strengthBonus(player: Player, weapon: number): number {
    const worn = player.getInventory(InvType.WORN);
    let sum = objParam(weapon, 'strengthbonus');
    const twoHanded = weapon !== -1 && ObjType.get(weapon)?.wearpos2 === 5;
    for (let slot = 0; slot < (worn?.capacity ?? 0); slot++) {
        if (slot === 3 || (slot === 5 && twoHanded)) continue;
        const it = worn!.get(slot);
        if (it) sum += objParam(it.id, 'strengthbonus');
    }
    return sum;
}

/** 274's melee max hit (player_combat_stat.rs2) with `weapon` in hand, on an aggressive style (+3) */
export function meleeMaxHit(player: Player, weapon: number): number {
    const eff = Math.floor((player.levels[PlayerStat.STRENGTH] * strengthPrayer(player)) / 100) + 8 + 3;
    return Math.floor((eff * (strengthBonus(player, weapon) + 64) + 320) / 640);
}

/** 274's ranged max hit with these arrows (rapid: no style bonus); `plus` Ranged levels (the shortbow's special: 10) */
export function rangedMaxHit(player: Player, ammo: number, plus = 0): number {
    const eff = player.levels[PlayerStat.RANGED] + plus + 8;
    return Math.floor((eff * (objParam(ammo, 'rangebonus') + 64) + 320) / 640);
}

/** is this weapon one with a special attack (274's specwep)? */
export function isSpecWeapon(id: number): boolean {
    return objParam(id, 'specwep') === 1;
}

/** the special energy one spec of this weapon takes (of 1000), or 0 */
export function specCost(id: number): number {
    return objParam(id, 'sa_energy');
}

/**
 * The most the KO weapon's attack can do (what a player knows of its weapon): a dragon dagger's two hits at +15 %, a
 * longsword's +25 %, a mace's +50 %, the shortbow's two arrows at +10 Ranged; a plain weapon (a 2h sword) its max.
 */
export function koDamage(player: Player, ko: number, ammo = -1): number {
    if (ko === -1) return 0;
    const K = pkKitItems();
    if (ko === K.msb) return 2 * rangedMaxHit(player, ammo, 10);
    const max = meleeMaxHit(player, ko);
    if (!isSpecWeapon(ko)) return max;
    if (ko === K.dds || ObjType.get(ko)?.debugname === 'dragon_dagger') return 2 * Math.floor((max * 115) / 100);
    if (ko === K.dlong) return Math.floor((max * 125) / 100);
    if (ko === K.dmace) return Math.floor((max * 150) / 100);
    return max;
}

/** what a player reads of its target: the most its weapon in hand can hit, a special's two hits for a dragon dagger */
export function threatOf(target: Player): number {
    const weapon = target.getInventory(InvType.WORN)?.get(3)?.id ?? -1;
    const name = weapon === -1 ? '' : (ObjType.get(weapon)?.debugname ?? '');
    if (/bow$/.test(name)) return rangedMaxHit(target, target.getInventory(InvType.WORN)?.get(13)?.id ?? -1, /^magic_shortbow/.test(name) ? 10 : 0) * (/^magic_shortbow/.test(name) ? 2 : 1);
    if (/staff|wand/.test(name)) return 16;
    return /^dragon_dagger/.test(name) ? koDamage(target, weapon) : meleeMaxHit(target, weapon);
}

/** the food a PKer eats, best first */
let foodIds: number[] | null = null;
export function pkFoods(profile: PkProfile): number[] {
    if (!foodIds) foodIds = ['shark', 'swordfish', 'lobster', 'tuna', 'salmon', 'trout'].map(n => ObjType.getId(n)).filter(id => id !== -1);
    return [profile.food, ...foodIds.filter(id => id !== profile.food)].filter(id => id !== -1);
}

/** how many pieces of food it has */
export function pkFoodLeft(player: Player, profile: PkProfile): number {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return 0;
    const foods = new Set(pkFoods(profile));
    let n = 0;
    for (let slot = 0; slot < inv.capacity; slot++) {
        const it = inv.get(slot);
        if (it && foods.has(it.id)) n++;
    }
    return n;
}

/** what a bite of its best food heals (274's consume table: a shark 20, a swordfish 14, a lobster 12) */
const HEALS: Record<string, number> = { shark: 20, swordfish: 14, lobster: 12, tuna: 10, salmon: 9, trout: 7 };
function healOf(id: number): number {
    return HEALS[ObjType.get(id)?.debugname ?? ''] ?? 10;
}

function slotOf(player: Player, ids: readonly number[]): [number, number] | null {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return null;
    for (const id of ids) {
        for (let slot = 0; slot < inv.capacity; slot++) {
            if (inv.get(slot)?.id === id) return [id, slot];
        }
    }
    return null;
}

/**
 * A bite of its best food through the game's Eat; the ticks until the next bite may come, or 0 when it had none. 274
 * lets the next bite come 3 ticks on (consume.rs2's %eat_delay); in danger a PKer clicks it as soon as it may (2004's
 * PKers ate as fast as the game let them at low Hitpoints), else at a person's pace on top.
 */
export function pkEat(player: Player, profile: PkProfile, urgent = false): number {
    const found = slotOf(player, pkFoods(profile));
    const inv = player.getInventory(InvType.INV);
    if (!found || !inv) return 0;
    if (!interactHeldOp(player, inv, found[0], found[1], 1)) return 0;
    return 3 + (urgent ? 0 : botReactionTicks(player, 'page'));
}

const nextBite = new WeakMap<Player, number>();

/**
 * Out of a fight (at its post, on the way there or out, at the bank's door): a bite when a whole one would not be
 * wasted, at a person's pace (as soon as the game allows under a third of its Hitpoints). 2004's PKers ate up after a
 * fight; upstream's stood at the edge with what the last one left them.
 */
export function pkTopUp(player: Player, profile: PkProfile): boolean {
    const now = World.currentTick;
    if (now < (nextBite.get(player) ?? 0) || player.delayed) return false;
    const found = slotOf(player, pkFoods(profile));
    const hp = player.levels[PlayerStat.HITPOINTS];
    const max = player.baseLevels[PlayerStat.HITPOINTS];
    if (!found || hp > max - healOf(found[0])) return false;
    const wait = pkEat(player, profile, hp < max * 0.35);
    if (wait <= 0) return false;
    nextBite.set(player, now + wait);
    return true;
}

/**
 * (round 2) its prayer points back at its restock, as its food, potions and arrows come back there (the PK tasks'
 * restock is the bank trip's whole round; Edgeville has no altar a PKer may use, the monastery's being its order's,
 * upstairs). Upstream's PKers never got them back but by a death.
 */
export function pkRecharge(player: Player): void {
    const base = player.baseLevels[PlayerStat.PRAYER];
    if (player.levels[PlayerStat.PRAYER] < base) player.levels[PlayerStat.PRAYER] = base;
}

/** a player with an attack on this one (any: also one it may not hit back, a third player's fight in single combat) */
export function pkHitBy(player: Player): Player | null {
    for (const p of World.playerLoop.all() as Iterable<Player>) {
        if (p === player || p.slot === -1 || p.target !== player) continue;
        if (p.targetOp === ServerTriggerType.APPLAYER2 || p.targetOp === ServerTriggerType.OPPLAYER2) return p;
    }
    return null;
}

function energy(player: Player): number {
    return varp(player, 'sa_energy');
}

function wielded(player: Player): number {
    return player.getInventory(InvType.WORN)?.get(3)?.id ?? -1;
}

/**
 * a weapon's speed in ticks (274's attackrate, 4 by default; a bow on rapid one less; a special at the weapon's own:
 * pvp_special_attack.rs2)
 */
function attackRate(weapon: number, special = false): number {
    const rate = objParam(weapon, 'attackrate', 4);
    return !special && /bow$/.test(ObjType.get(weapon)?.debugname ?? '') ? rate - 1 : rate;
}

function chebyshev(a: Player, b: Player): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

// ── a fight ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** the fight's log for the tests and the sims */
export const pkFightStats = {
    fights: 0,
    eats: 0,
    doses: 0,
    flees: { run: 0, tele: 0 },
    /** each flee: who, how, when (the tests look at what came of it) */
    fleeLog: [] as { name: string; how: 'run' | 'tele'; tick: number }[],
    koSwitches: 0,
    /** KO hits that came on the main weapon's tick (the switch's point) */
    koOnFastTick: 0,
    specs: 0,
    specsByWeapon: {} as Record<string, number>,
    /** (round 2) fights with its boost prayers wanted, the PJers' fights watched and players jumped (port/BotPkPj) */
    boostedFights: 0,
    pj: { watches: 0, jumps: 0 },
    reset(): void {
        this.fights = this.eats = this.doses = this.koSwitches = this.koOnFastTick = this.specs = this.boostedFights = 0;
        this.pj = { watches: 0, jumps: 0 };
        this.flees = { run: 0, tele: 0 };
        this.fleeLog = [];
        this.specsByWeapon = {};
    }
};

/** one engagement's memory: what it saw, its potions, its KO */
export class PkFight {
    readonly target: Player;
    private readonly profile: PkProfile;
    private readonly ways: PkWays;
    private readonly deep: boolean;
    /** the biggest hit it took this fight */
    biggestHit = 0;
    private lastHp: number;
    /** its attacks this fight: %action_delay moves on at each */
    attacks = 0;
    private lastDelay: number;
    /** the attack that came last: its tick and its weapon's speed */
    private lastAttackAt = -1;
    private lastRate = 0;
    /** the KO: armed (the KO weapon on, for the next attack) at a tick, the attacks before it, the main weapon's speed */
    ko: { weapon: number; armedAt: number; attacksBefore: number; fastRate: number } | null = null;
    koHits = 0;
    private eatAt = 0;
    /** the most it has seen the target able to hit this fight (a dragon dagger once seen in its hand is remembered) */
    private seenThreat = 0;
    /** (round 2) its boost prayers on for the KO (offence) */
    private boosting = false;
    private boosted = false;

    constructor(player: Player, target: Player, profile: PkProfile, deep: boolean) {
        this.target = target;
        this.profile = profile;
        this.ways = pkWaysOf(player.username);
        this.deep = deep;
        this.lastHp = player.levels[PlayerStat.HITPOINTS];
        this.lastDelay = varp(player, 'action_delay');
        pkFightStats.fights++;
    }

    /** what it saw since its last tick: a hit taken, an attack of its own, the target's weapon */
    observe(player: Player): void {
        this.seenThreat = Math.max(this.seenThreat, threatOf(this.target));
        const hp = player.levels[PlayerStat.HITPOINTS];
        if (hp < this.lastHp) this.biggestHit = Math.max(this.biggestHit, this.lastHp - hp);
        this.lastHp = hp;
        const delay = varp(player, 'action_delay');
        if (delay !== this.lastDelay && delay > World.currentTick) {
            // (the attack's tick: %action_delay less the speed of the weapon that made it)
            const weapon = wielded(player);
            const rate = attackRate(weapon, this.ko !== null && weapon === this.ko.weapon && isSpecWeapon(weapon));
            const at = delay - rate;
            this.attacks++;
            if (this.ko && weapon === this.ko.weapon) {
                // a KO hit: on the main weapon's tick when it came as soon after the last hit as the main weapon allowed
                if (this.lastAttackAt >= 0 && at - this.lastAttackAt <= this.ko.fastRate) pkFightStats.koOnFastTick++;
                this.koHits++;
            }
            this.lastAttackAt = at;
            this.lastRate = rate;
        }
        this.lastDelay = delay;
    }

    /** the most it thinks the target can hit it for next: the biggest hit it took, the worst weapon it saw in its hand */
    threat(): number {
        return Math.max(this.biggestHit, this.seenThreat, threatOf(this.target));
    }

    /**
     * the most its next attack can do: its KO weapon's (a special with the energy for it, or a plain hard hitter), else
     * its main weapon's
     */
    private reachNow(player: Player): number {
        const p = this.profile;
        const ko = this.koFor(player);
        if (ko !== -1 && (!isSpecWeapon(ko) || energy(player) >= specCost(ko))) return this.reachWith(player, ko);
        return p.style === 'ranged' ? rangedMaxHit(player, this.arrows()) : meleeMaxHit(player, p.weapon);
    }

    private arrows(): number {
        return this.profile.ammo === -1 ? pkKitItems().runeArrow : this.profile.ammo;
    }

    /** the most an attack with this KO weapon can do */
    private reachWith(player: Player, ko: number): number {
        return koDamage(player, ko, this.arrows());
    }

    /**
     * the KO weapon for now: a ranger's own shortbow at a target out of melee reach (its double special, with the energy
     * for it), else the kit's
     */
    private koFor(player: Player): number {
        const p = this.profile;
        if (p.style === 'ranged' && !pkAdjacent(player, this.target) && isSpecWeapon(p.weapon) && energy(player) >= specCost(p.weapon)) return p.weapon;
        return p.specWeapon;
    }

    /** the target is in reach of its KO (its own share of the most its next attack can do) */
    private targetInReach(player: Player): boolean {
        const reach = this.reachNow(player);
        return reach > 0 && this.target.levels[PlayerStat.HITPOINTS] <= reach * this.ways.koReach;
    }

    /**
     * Out of the Wilderness, or on with the fight? Low on food (its own 1-5) and under its line or losing (its share of
     * Hitpoints under the target's, or in the target's reach), two more food than that in the target's reach and losing,
     * out of food and hurt or in the target's reach; not with the target in its own KO reach unless it is in the target's
     * too and not bold. The way: a teleport where the level allows it and it has
     * one (rather than a run, its share of the time; a deep PKer always), else a run.
     */
    flee(player: Player): 'run' | 'tele' | null {
        const hp = player.levels[PlayerStat.HITPOINTS];
        const max = player.baseLevels[PlayerStat.HITPOINTS];
        if (this.target.levels[PlayerStat.HITPOINTS] <= 0) return null;
        const food = pkFoodLeft(player, this.profile);
        const mine = hp / max;
        const theirs = this.target.levels[PlayerStat.HITPOINTS] / Math.max(1, this.target.baseLevels[PlayerStat.HITPOINTS]);
        const threatened = this.threat() >= hp;
        if (this.targetInReach(player) && (!threatened || this.ways.bold)) return null;
        const losing = mine < theirs || threatened;
        // (the research's rule: low on food and under 60 %, or a little more food in the target's burst; out of food, hurt)
        const leave =
            (food === 0 && (mine < this.ways.fleeEmpty || threatened)) ||
            (food <= this.ways.fleeFood && (mine < this.ways.fleeBelow || losing)) ||
            (food <= this.ways.fleeFood + 2 && threatened && losing);
        if (!leave) return null;
        const how = pkCanTele(player, this.profile) && (this.deep || Math.random() < this.ways.teleShare) ? 'tele' : 'run';
        pkFightStats.flees[how]++;
        if (pkFightStats.fleeLog.length < 500) pkFightStats.fleeLog.push({ name: player.username, how, tick: World.currentTick });
        return how;
    }

    /**
     * A bite when it must: under its own line, or within the target's reach, and when the bite would not be wasted.
     * `urgentOnly`: only in the target's reach (the off-turn tick's check: the first tick the game allows a bite)
     */
    eat(player: Player, urgentOnly = false): boolean {
        if (World.currentTick < this.eatAt) return false;
        const hp = player.levels[PlayerStat.HITPOINTS];
        const max = player.baseLevels[PlayerStat.HITPOINTS];
        const food = slotOf(player, pkFoods(this.profile));
        if (!food) return false;
        const threat = this.threat();
        if (urgentOnly && hp > threat) return false;
        const line = Math.max(max * this.ways.eatAt, Math.min(threat + 3, max * 0.8));
        if (hp > line || hp > max - healOf(food[0]) * 0.6) return false;
        const wait = pkEat(player, this.profile, hp <= threat);
        if (wait <= 0) return false;
        pkFightStats.eats++;
        this.eatAt = World.currentTick + wait;
        // (274's bite adds 3 ticks to %action_delay: no attack of its own, so not one for observe)
        this.lastDelay = varp(player, 'action_delay');
        // (and the target clicked again, as a player eats and clicks back: the bite cleared the attack)
        interactPlayerOp(player, this.target.slot, 2);
        return true;
    }

    /**
     * A dose of its potions: a stat not boosted (or worn down to a point or two above its level), the lowest vial first;
     * a prayer potion with the points under a third. Through the game's Drink, which holds the drinker 2 ticks (274's
     * consume_effects.rs2: "You drink ...", then the doses left), so a sip every 3 ticks at most.
     */
    potions(player: Player): boolean {
        const inv = player.getInventory(InvType.INV);
        if (!inv || player.delayed) return false;
        for (const pot of this.profile.pots) {
            const vials = vialsOf(pot);
            if (vials.length === 0) continue;
            const name = ObjType.get(pot)?.debugname ?? '';
            const boost = BOOSTS[name];
            if (boost) {
                const base = player.baseLevels[boost.stat];
                const full = boost.add + Math.floor((base * boost.pct) / 100);
                if (player.levels[boost.stat] - base > Math.max(2, Math.floor(full / 3))) continue;
            } else if (name === '4doseprayerrestore') {
                // (round 2) a sip with the points under a third (8 at least) and down by a sip's worth (274's
                // stat_heal: 7 and a quarter of the level), for the boost prayers and Protect Item
                const base = player.baseLevels[PlayerStat.PRAYER];
                const points = player.levels[PlayerStat.PRAYER];
                if (base < 13 || points > Math.max(base / 3, 8) || points > base - (7 + Math.floor(base / 4))) continue;
            } else continue;
            const found = slotOf(player, vials);
            if (!found) continue;
            if (!interactHeldOp(player, inv, found[0], found[1], 1)) return false;
            pkFightStats.doses++;
            return true;
        }
        return false;
    }

    /**
     * (round 2, "offensive prayers") its melee boost prayers wanted now (port/BotPkTactics pkPrayers presses
     * them: the best Strength and Attack ones its Prayer has): all fight long, or with the KO near (its KO armed, or the
     * target within a third more than its reach; off again once the target ate well clear of it). Never a ranger's (274
     * has no Ranged or Magic one), nor with no points.
     */
    offence(player: Player): boolean {
        // (Burst of Strength's 4 the least: below it there is none to press)
        if (this.profile.style === 'ranged' || this.ways.pray === 'never' || player.levels[PlayerStat.PRAYER] <= 0 || player.baseLevels[PlayerStat.PRAYER] < 4) return false;
        if (this.ways.pray === 'fight' || this.ko) {
            this.boosting = true;
        } else {
            const reach = this.reachNow(player) * this.ways.koReach;
            const hp = this.target.levels[PlayerStat.HITPOINTS];
            if (reach > 0 && hp <= reach * 1.3) this.boosting = true;
            else if (hp > reach * 1.7) this.boosting = false;
        }
        if (this.boosting && !this.boosted) {
            this.boosted = true;
            pkFightStats.boostedFights++;
        }
        return this.boosting;
    }

    /**
     * The KO: with the target in its reach, right after its own hit (the main weapon's timer just started), the KO weapon
     * on and its special bar set; the next attack is the KO weapon's on the main weapon's tick. After a KO hit, a dragon
     * dagger specs again while the target is still in reach and the bar has the energy; else the main weapon goes back on.
     */
    koStep(player: Player): boolean {
        const p = this.profile;
        const now = World.currentTick;
        const hand = wielded(player);
        if (this.ko) {
            const ko = this.ko.weapon;
            const hit = this.attacks > this.ko.attacksBefore;
            if (hand !== ko) {
                this.ko = null; // (the swap did not happen: a full pack, the wear script's refusal)
                return false;
            }
            if (!hit) {
                // (no attack 12 ticks after the switch: the target ran, the bot ate: its weapon again)
                if (now - this.ko.armedAt <= 12) return false;
            } else if (isSpecWeapon(ko) && energy(player) >= specCost(ko) && this.target.levels[PlayerStat.HITPOINTS] > 0 && this.target.levels[PlayerStat.HITPOINTS] <= this.reachWith(player, ko) * this.ways.koReach) {
                this.ko.attacksBefore = this.attacks;
                this.ko.armedAt = now;
                return this.armSpec(player, ko);
            }
            this.ko = null;
            if (ko === p.weapon) return false;
            pkTryEquipFromInventory(player, p.weapon);
            if (p.shield !== -1 && _wornContains(player, p.weapon)) pkTryEquipFromInventory(player, p.shield);
            interactPlayerOp(player, this.target.slot, 2);
            return true;
        }
        const ko = this.koFor(player);
        if (ko === -1) return false;
        const spec = isSpecWeapon(ko);
        if (spec && energy(player) < specCost(ko)) return false;
        if (this.target.levels[PlayerStat.HITPOINTS] > this.reachWith(player, ko) * this.ways.koReach) return false;
        // right after its own hit (its timer running, a tick at least to go), not at the start of the fight
        const delay = varp(player, 'action_delay');
        if (this.attacks === 0 || delay - now < 1) return false;
        if (hand !== ko) {
            if (!pkTryEquipFromInventory(player, ko) || wielded(player) !== ko) return false;
            pkFightStats.koSwitches++;
        }
        this.ko = { weapon: ko, armedAt: now, attacksBefore: this.attacks, fastRate: Math.max(this.lastRate, 1) };
        if (spec) return this.armSpec(player, ko);
        interactPlayerOp(player, this.target.slot, 2);
        return true;
    }

    private armSpec(player: Player, ko: number): boolean {
        if (wieldsSpecialWeapon(player)) {
            setVarp(player, 'sa_attack', 301, 1);
            pkFightStats.specs++;
            const name = ObjType.get(ko)?.debugname ?? `${ko}`;
            pkFightStats.specsByWeapon[name] = (pkFightStats.specsByWeapon[name] ?? 0) + 1;
        }
        interactPlayerOp(player, this.target.slot, 2);
        return true;
    }

    /** the main weapon back on after the fight (a KO weapon left in hand) */
    disarm(player: Player): void {
        const p = this.profile;
        if (p.specWeapon === -1 || p.specWeapon === p.weapon || wielded(player) !== p.specWeapon) return;
        pkTryEquipFromInventory(player, p.weapon);
        if (p.shield !== -1 && _wornContains(player, p.weapon)) pkTryEquipFromInventory(player, p.shield);
    }
}

// ── getting out ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** can it teleport here and now: its glory (to level 30) or its spell (Magic, the runes; to level 20) */
export function pkCanTele(player: Player, profile: PkProfile): boolean {
    const wild = wildernessLevelAt(player.x, player.z);
    if (profile.tele === 'glory') return wild <= GLORY_WILD && slotOf(player, glories()) !== null;
    if (profile.tele === 'spell') return wild <= SPELL_WILD && spellReady(player);
    return false;
}

function spellReady(player: Player): boolean {
    const K = pkKitItems();
    const count = (id: number): number => {
        const inv = player.getInventory(InvType.INV);
        let n = 0;
        for (let slot = 0; slot < (inv?.capacity ?? 0); slot++) if (inv!.get(slot)?.id === id) n += inv!.get(slot)!.count;
        return n;
    };
    return player.levels[PlayerStat.MAGIC] >= SPELL_LEVEL && count(K.law) >= 1 && count(K.air) >= 3 && count(K.fire) >= 1;
}

/**
 * A teleport out, a step a tick: the glory's Rub and its "Edgeville." (274's amulet_of_glory.rs2: the choice, then the
 * cast), or the spell's button (teleport.rs2); then the landing. 'casting' while under way, 'out' once it moved far,
 * 'failed' when nothing came of it (the bot then runs).
 */
export class PkTeleport {
    private readonly from: [number, number];
    private step: 'start' | 'choice' | 'landing' = 'start';
    private at = 0;
    private tries = 0;
    private readonly profile: PkProfile;

    constructor(player: Player, profile: PkProfile) {
        this.from = [player.x, player.z];
        this.profile = profile;
    }

    tick(player: Player): 'casting' | 'out' | 'failed' {
        const now = World.currentTick;
        if (Math.max(Math.abs(player.x - this.from[0]), Math.abs(player.z - this.from[1])) > 20) return 'out';
        if (this.step === 'start') {
            if (player.delayed) return 'casting';
            player.clearPendingAction();
            if (this.profile.tele === 'glory') {
                const found = slotOf(player, glories());
                const inv = player.getInventory(InvType.INV);
                if (++this.tries > 3 || !found || !inv || !interactHeldOp(player, inv, found[0], found[1], 4)) return 'failed';
                this.step = 'choice';
            } else {
                if (!spellReady(player) || !interactIfButtonByName(player, SPELL_BUTTON)) return 'failed';
                // (a real cast: its jump is the game's, as port/BotTeleport's are, for the humanlike runner)
                noteMove(player, 'spell');
                this.step = 'landing';
            }
            this.at = now;
            return 'casting';
        }
        if (this.step === 'choice') {
            if (botAnswerDialogue(player, 1) !== null) {
                noteMove(player, 'spell');
                this.step = 'landing';
                this.at = now;
                return 'casting';
            }
            // (a hit closes the choice, 274's strong queue: it rubs again, as a player did between the hits)
            if (now - this.at > 1) this.step = 'start';
            return 'casting';
        }
        return now - this.at > 8 ? 'failed' : 'casting';
    }
}

/** the wilderness level it may teleport at with its kit (a run until then): 30 with a glory, 20 with the spell, else 0 */
export function pkTeleLevel(profile: PkProfile): number {
    return profile.tele === 'glory' ? GLORY_WILD : profile.tele === 'spell' ? SPELL_WILD : 0;
}

/** near its target? (a ranger stays off; a melee KO weapon walks in) */
export function pkAdjacent(a: Player, b: Player): boolean {
    return chebyshev(a, b) <= 1;
}
