// port (the variety work, round 2, track W2: fashion WEAR-4, -7, -8, -9, -10):
// status gear on about 1 rich bot in 5 with vendors at estimated prices, new outfits reach saved bots through
// play, a new bot's aged kit may hold anything from its own seed): what the rich and the members of late 2004 wore, beyond
// port/BotOutfits' styles and ladders. Pure functions of the name (port/BotSeed), each trait on a seed of its own
// ('status-gear', 'members-fashion', 'novelty', 'battlestaff-kind', 'pk-variety', 'woman-hair', 'clan-clothes'), so no
// name's helm, cape, metal, style, weapon kind, gender or colours of before change. Every item by its 274 debugname,
// looked up on first use (test/content-names checks each).
//   status    Treasure Trail trims ((t) and (g) black, adamant and rune), god rune armour (Saradomin, Zamorak, Guthix)
//             and gilded rune (members): the rich look of late 2004 Varrock. In the aged kits of the
//             intermediate (black 10 %), experienced (adamant 15 %) and veteran bots (rune 15 %, god 10 %, gilded 2 %),
//             the social and vendor bots half as often again (they stand at the hubs): usually one or two pieces, a full
//             set 1 in 5 (statusKitOf). A piece is armour of its metal, a little better than the plain one
//             (port/BotLooks armourPieces: its tier + STATUS_RANK), so a bot wears its best at a fight, banks it at a
//             skill, and buys no plain piece of that metal over it
//   members   on a members world: Fremennik helms (45 Defence, the Fremennik Trials), cloaks, shirts and boots, snelms,
//             a god book in a few prayer or magic veterans' shield hand, Canifis or gnome robes, clue hats (berets,
//             cavaliers, headbands, the pirate's and robin hood hats) on about 1 levelling bot in 20, the elemental
//             battlestaves (membersFashionOf, battlestaffOf)
//   novelty   the mime's outfit on about 1 veteran in 100, a holy symbol on prayer trainers and monks, an amulet of
//             accuracy on a few newbies (Imp Catcher), a gem amulet on crafters (noveltyOf)
//   PKers     the outfit varies from the profile's own seed: gloves, boots, amulet, helm, legs and weapon (pkVariedProfile;
//             a saved PKer keeps its profile as round 1's pkProfileAtLogin: pkVarietyAtLogin)
//   notable   what a bot wears that others remark on (notableGearOf: rares, holiday items, trims, god armour, dragon,
//             members show pieces), for the conversation's gear comments
//   wealth    a bot's bank value (wealthOf; rich from RICH_WEALTH), for the show-off visits and the humanlike report's L6
import ObjType from '#/cache/config/ObjType.js';
import InvType from '#/cache/config/InvType.js';
import type Player from '#/engine/entity/Player.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { streetPrice } from '#/engine/bot/port/BotPrices.js';
import type { AgeTier } from '#/engine/bot/port/BotAge.js';

const NONE = -1;
const id = (name: string): number => ObjType.getId(name);

// ── status pieces (WEAR-4) ────────────────────────────────────────────────────

export type StatusFamily = 'trim' | 'gold' | 'god' | 'gilded';
export type StatusSlot = 'helm' | 'body' | 'legs' | 'shield';
export type StatusKind = 'full' | 'plate' | 'platelegs' | 'skirt' | 'kite';
export type God = 'saradomin' | 'zamorak' | 'guthix';

export interface StatusPiece {
    id: number;
    slot: StatusSlot;
    kind: StatusKind;
    /** the metal (port/BotLooks METALS' index: black 3, adamant 5, rune 6) */
    metal: number;
    family: StatusFamily;
    god: God | null;
}

/** how much better than the plain piece of its metal a status piece ranks (its armour tier is the metal + this): the dearer, the higher */
export const STATUS_RANK: Readonly<Record<StatusFamily, number>> = { trim: 0.3, gold: 0.4, god: 0.5, gilded: 0.7 };
/** the Defence each metal's pieces need (274's tier10, tier30, tier40 scripts) */
const METAL_DEF: Readonly<Record<number, number>> = { 3: 10, 5: 30, 6: 40 };
const PIECES: ReadonlyArray<[StatusSlot, StatusKind, string]> = [
    ['helm', 'full', 'full_helm'],
    ['body', 'plate', 'platebody'],
    ['legs', 'platelegs', 'platelegs'],
    ['legs', 'skirt', 'plateskirt'],
    ['shield', 'kite', 'kiteshield']
];
const GODS: readonly God[] = ['saradomin', 'zamorak', 'guthix'];

/** every status piece of 274 by debugname (literal: test/content-names reads them): the (t) and (g) pieces of black, adamant and rune, the god pieces, the gilded ones */
const STATUS_NAMES: readonly string[] = [
    'black_full_helm_trim', 'black_platebody_trim', 'black_platelegs_trim', 'black_plateskirt_trim', 'black_kiteshield_trim',
    'black_full_helm_gold', 'black_platebody_gold', 'black_platelegs_gold', 'black_plateskirt_gold', 'black_kiteshield_gold',
    'adamant_full_helm_trim', 'adamant_platebody_trim', 'adamant_platelegs_trim', 'adamant_plateskirt_trim', 'adamant_kiteshield_trim',
    'adamant_full_helm_gold', 'adamant_platebody_gold', 'adamant_platelegs_gold', 'adamant_plateskirt_gold', 'adamant_kiteshield_gold',
    'rune_full_helm_trim', 'rune_platebody_trim', 'rune_platelegs_trim', 'rune_plateskirt_trim', 'rune_kiteshield_trim',
    'rune_full_helm_gold', 'rune_platebody_gold', 'rune_platelegs_gold', 'rune_plateskirt_gold', 'rune_kiteshield_gold',
    'rune_full_helm_saradomin', 'rune_platebody_saradomin', 'rune_platelegs_saradomin', 'rune_plateskirt_saradomin', 'rune_kiteshield_saradomin',
    'rune_full_helm_zamorak', 'rune_platebody_zamorak', 'rune_platelegs_zamorak', 'rune_plateskirt_zamorak', 'rune_kiteshield_zamorak',
    'rune_full_helm_guthix', 'rune_platebody_guthix', 'rune_platelegs_guthix', 'rune_plateskirt_guthix', 'rune_kiteshield_guthix',
    'rune_full_helm_goldplate', 'rune_platebody_goldplate', 'rune_platelegs_goldplate', 'rune_plateskirt_goldplate', 'rune_kiteshield_goldplate'
];
const STATUS_RE = /^(black|adamant|rune)_(full_helm|platebody|platelegs|plateskirt|kiteshield)_(trim|gold|goldplate|saradomin|zamorak|guthix)$/;

let STATUS: StatusPiece[] | null = null;
let STATUS_BY_ID: Map<number, StatusPiece> | null = null;

/** Every status piece of 274: STATUS_NAMES, each by its debugname's metal, piece and family (built once). */
export function statusPieces(): readonly StatusPiece[] {
    if (STATUS) return STATUS;
    const out: StatusPiece[] = [];
    for (const name of STATUS_NAMES) {
        const m = name.match(STATUS_RE);
        const i = id(name);
        const piece = m ? PIECES.find(([, , p]) => p === m[2]) : undefined;
        if (!m || !piece || i === NONE) continue;
        const metal = m[1] === 'black' ? 3 : m[1] === 'adamant' ? 5 : 6;
        const family: StatusFamily = m[3] === 'trim' ? 'trim' : m[3] === 'gold' ? 'gold' : m[3] === 'goldplate' ? 'gilded' : 'god';
        out.push({ id: i, slot: piece[0], kind: piece[1], metal, family, god: family === 'god' ? (m[3] as God) : null });
    }
    STATUS = out;
    STATUS_BY_ID = new Map(out.map(p => [p.id, p]));
    return out;
}

/** The status piece an item is, or undefined. */
export function statusPieceOf(itemId: number): StatusPiece | undefined {
    if (!STATUS_BY_ID) statusPieces();
    return STATUS_BY_ID!.get(itemId);
}

/** The Defence a status piece needs (its metal's). */
export function statusDefence(piece: StatusPiece): number {
    return METAL_DEF[piece.metal] ?? 1;
}

/** the piece of this family (and god), metal and kind, or undefined */
export function statusPieceFor(family: StatusFamily, metal: number, kind: StatusKind, god: God | null = null): StatusPiece | undefined {
    return statusPieces().find(p => p.family === family && p.metal === metal && p.kind === kind && p.god === god);
}

/**
 * Of the aged tiers, the share of bots in each kind of status gear (the wear track's table): an intermediate black (t) or
 * (g) 10 %; an experienced adamant (t) or (g) 15 %; a veteran rune (t) or (g) 15 %, god rune 10 %, gilded 2 % (members).
 * About 1 rich bot in 5: (0.18 × 15 + 0.07 × 27) / 25 = 18 % of the experienced and veterans, the
 * social and vendor bots STATUS_COSMETIC_FACTOR times as often (they stand at the hubs, where 2004's rich showed theirs).
 */
export const STATUS_SHARES: Readonly<Partial<Record<AgeTier, ReadonlyArray<[StatusCategory, number]>>>> = {
    intermediate: [['black', 0.1]],
    experienced: [['adamant', 0.15]],
    veteran: [
        ['rune', 0.15],
        ['god', 0.1],
        ['gilded', 0.02]
    ]
};
export type StatusCategory = 'black' | 'adamant' | 'rune' | 'god' | 'gilded';
export const STATUS_COSMETIC_FACTOR = 1.5;
/** a full set (helm, body, legs, kiteshield) this often; else one piece, two 4 times in 10 */
export const STATUS_SET_SHARE = 0.2;
const STATUS_SECOND = 0.4;
/** the slot of a lone piece: a platebody most often (the (g) platebody of the hubs) */
const STATUS_SLOT_WEIGHTS: ReadonlyArray<[StatusSlot, number]> = [
    ['body', 0.45],
    ['legs', 0.25],
    ['helm', 0.15],
    ['shield', 0.15]
];

/**
 * The status pieces a new aged bot of this name owns (its own seed 'status-gear'; nothing for a newcomer, a novice or a
 * PKer): see STATUS_SHARES. The Defence decides the metal it can wear (a veteran under 40 Defence gets adamant's at 30,
 * black's at 10, or none); gilded is members only (else rune (t) or (g)). `legs`: its taste's legs (a plateskirt for half
 * the women); `shield`: it carries a shield (no kiteshield for a two-hander, none for a taste without one).
 */
export function statusKitOf(name: string, tier: AgeTier, defence: number, members: boolean, opts: { cosmetic: boolean; legs: 'platelegs' | 'skirt'; shield: boolean }): number[] {
    const shares = STATUS_SHARES[tier];
    if (!shares) return [];
    const r = seededRandom(nameSeed(name, 'status-gear'));
    const [rWho, rTrim, rGod, rSet, rFirst, rSecond, rSecondSlot] = [r(), r(), r(), r(), r(), r(), r()];
    let roll = rWho / (opts.cosmetic ? STATUS_COSMETIC_FACTOR : 1);
    let category: StatusCategory | null = null;
    for (const [c, share] of shares) {
        if (roll < share) {
            category = c;
            break;
        }
        roll -= share;
    }
    if (category === null) return [];
    if (category === 'gilded' && !members) category = 'rune';
    // the metal its Defence wears (rune's pieces 40, adamant's 30, black's 10)
    let c: StatusCategory = category;
    if (defence < 40 && (c === 'rune' || c === 'god' || c === 'gilded')) c = 'adamant';
    if (defence < 30 && c === 'adamant') c = 'black';
    if (defence < 10) return [];
    const metal = c === 'black' ? 3 : c === 'adamant' ? 5 : 6;
    const family: StatusFamily = c === 'god' ? 'god' : c === 'gilded' ? 'gilded' : rTrim < 0.5 ? 'trim' : 'gold';
    const god = family === 'god' ? GODS[Math.floor(rGod * GODS.length)] : null;
    const kindOf = (slot: StatusSlot): StatusKind => (slot === 'helm' ? 'full' : slot === 'body' ? 'plate' : slot === 'legs' ? opts.legs : 'kite');
    let slots: StatusSlot[];
    if (rSet < STATUS_SET_SHARE) slots = opts.shield ? ['helm', 'body', 'legs', 'shield'] : ['helm', 'body', 'legs'];
    else {
        const pool = STATUS_SLOT_WEIGHTS.filter(([s]) => s !== 'shield' || opts.shield);
        const pick = (x: number, from: ReadonlyArray<[StatusSlot, number]>): StatusSlot => {
            const total = from.reduce((a, [, w]) => a + w, 0);
            let y = x * total;
            for (const [s, w] of from) {
                if (y < w) return s;
                y -= w;
            }
            return from[from.length - 1][0];
        };
        const first = pick(rFirst, pool);
        slots = [first];
        if (rSecond < STATUS_SECOND) slots.push(pick(rSecondSlot, pool.filter(([s]) => s !== first)));
    }
    const out: number[] = [];
    for (const slot of slots) {
        const piece = statusPieceFor(family, metal, kindOf(slot), god);
        if (piece && (members || !ObjType.get(piece.id).members)) out.push(piece.id);
    }
    return out;
}

// ── members fashion of late 2004 (WEAR-7) ─────────────────────────────────────

export interface MembersItems {
    /** berserker, warrior, archer, farseer */
    fremennikHelms: { berserker: number; warrior: number; archer: number; farseer: number };
    fremennikShirts: number[];
    fremennikCloaks: number[];
    fremennikBoots: number;
    snelms: number[];
    /** Saradomin, Zamorak, Guthix */
    godBooks: number[];
    clueHats: { berets: number[]; cavaliers: number[]; headbands: number[]; pirate: number; robinHood: number };
    /** air, fire, water, earth */
    battlestaves: number[];
    /** Canifis' robes by colour: [top, bottom, hat, boots] */
    wolfenRobes: number[][];
    /** the Gnome Stronghold's robes by colour: [top, bottom, hat, boots] */
    gnomeRobes: number[][];
}

/** Canifis' and the Gnome Stronghold's robes by colour, [top, bottoms, hat, boots] (literal: test/content-names reads them) */
const ROBE_NAMES: Readonly<{ wolfen: readonly string[][]; gnome: readonly string[][] }> = {
    wolfen: [
        ['wolfenrobetop_grey', 'wolfenrobebottom_grey', 'wolfenhat_grey', 'wolfenboots_grey'],
        ['wolfenrobetop_crimson', 'wolfenrobebottom_crimson', 'wolfenhat_crimson', 'wolfenboots_crimson'],
        ['wolfenrobetop_tangerine', 'wolfenrobebottom_tangerine', 'wolfenhat_tangerine', 'wolfenboots_tangerine'],
        ['wolfenrobetop_ocean', 'wolfenrobebottom_ocean', 'wolfenhat_ocean', 'wolfenboots_ocean'],
        ['wolfenrobetop_purple', 'wolfenrobebottom_purple', 'wolfenhat_purple', 'wolfenboots_purple']
    ],
    gnome: [
        ['gnome_robetop_pink', 'gnome_robebottoms_pink', 'gnome_hat_pink', 'gnome_boots_pink'],
        ['gnome_robetop_green', 'gnome_robebottoms_green', 'gnome_hat_green', 'gnome_boots_green'],
        ['gnome_robetop_blue', 'gnome_robebottoms_blue', 'gnome_hat_blue', 'gnome_boots_blue'],
        ['gnome_robetop_cream', 'gnome_robebottoms_cream', 'gnome_hat_cream', 'gnome_boots_cream'],
        ['gnome_robetop_turquoise', 'gnome_robebottoms_turquoise', 'gnome_hat_turquoise', 'gnome_boots_turquoise']
    ]
};

let MEMBERS: MembersItems | null = null;

export function membersItems(): MembersItems {
    if (MEMBERS) return MEMBERS;
    const real = (names: string[]): number[] => names.map(id).filter(i => i !== NONE);
    MEMBERS = {
        fremennikHelms: { berserker: id('viking_helmet_crush'), warrior: id('viking_helmet_slash'), archer: id('viking_helmet_range'), farseer: id('viking_helmet_magic') },
        fremennikShirts: real(['viking_top_blue', 'viking_top_red', 'viking_top_darkbrown', 'viking_top_green', 'viking_top_beige']),
        fremennikCloaks: real(['viking_cloak_brown', 'viking_cloak_lightbrown', 'viking_cloak_darkbrown', 'viking_cloak_green', 'viking_cloak_red', 'viking_cloak_grey', 'viking_cloak_tangerine', 'viking_cloak_ocean', 'viking_cloak_purple', 'viking_cloak_pink', 'viking_cloak_black']),
        fremennikBoots: id('vikingboots'),
        snelms: real(['snelm_round_swamp', 'snelm_round_red+black', 'snelm_round_yellow', 'snelm_round_blue', 'snelm_round_orange', 'snelm_point_swamp', 'snelm_point_red+black', 'snelm_point_yellow', 'snelm_point_blue']),
        godBooks: real(['saradominbook_complete', 'zamorakbook_complete', 'guthixbook_complete']),
        clueHats: {
            berets: real(['berret_blue', 'berret_black', 'berret_white']),
            cavaliers: real(['cavalier_brown', 'cavalier_dark', 'cavalier_black']),
            headbands: real(['headband_red', 'headband_black', 'headband_brown']),
            pirate: id('piratehat'),
            robinHood: id('robinhoodhat')
        },
        battlestaves: real(['air_battlestaff', 'fire_battlestaff', 'water_battlestaff', 'earth_battlestaff']),
        wolfenRobes: ROBE_NAMES.wolfen.map(set => set.map(id)),
        gnomeRobes: ROBE_NAMES.gnome.map(set => set.map(id))
    };
    return MEMBERS;
}

/** the shares of the members fashion (each 3-10 %, the plan's): see membersFashionOf */
export const MEMBERS_SHARES = { clueHat: 0.065, fremennikHelm: 0.08, fremennik: 0.06, snelm: 0.04, godBook: 0.25, robes: 0.05 } as const;

export interface MembersFashion {
    /** a hat: a Fremennik helm, a clue hat or a snelm (one of them) */
    hat: number;
    /** whether the hat goes on over a metal helm (a Fremennik helm, a clue hat: show pieces) or only into an empty slot or over a hat (a snelm) */
    hatOverHelm: boolean;
    cape: number;
    /** a Fremennik shirt, or a Canifis or gnome robe top: clothes, only where no armour body is worn */
    body: number;
    legs: number;
    feet: number;
    /** a god book (the shield hand) */
    shield: number;
}

/**
 * What a bot of this name wears of late 2004's members fashion on a members world (its own seed 'members-fashion'):
 *   clue hats      novices and up, MEMBERS_SHARES.clueHat (about 1 levelling bot in 20 of all: no newcomer has one): a
 *                  beret or a cavalier 3 in 10 each, a headband 1 in 4, the pirate's hat 1 in 10, the robin hood hat 1 in
 *                  20 (40 Ranged); over a metal helm, as 2004's show pieces were
 *   Fremennik      the experienced and veterans: a helm by style (a melee bot's berserker or warrior, a ranger's archer, a
 *                  mage's farseer) at 45 Defence, MEMBERS_SHARES.fremennikHelm; the clothes (a cloak, a shirt 6 in 10,
 *                  the boots half the time), MEMBERS_SHARES.fremennik
 *   snelms         intermediate and up, MEMBERS_SHARES.snelm (Mort'ton, October 2004): into an empty hat slot or over a hat
 *   god books      a veteran prayer trainer or mage, MEMBERS_SHARES.godBook (Horror from the Deep): the shield hand
 *   robes          an experienced or veteran mage, skiller or cosmetic bot, MEMBERS_SHARES.robes: Canifis' or the gnomes'
 *                  robe top and bottoms (the hat half the time, the boots 3 in 10)
 * NONE (-1) for a piece it has not. The caller wears them where they fit (port/BotAge).
 */
export function membersFashionOf(name: string, tier: AgeTier, levels: { defence: number; ranged: number }, style: 'melee' | 'ranger' | 'mage', opts: { prayer: boolean; robes: boolean }): MembersFashion {
    const r = seededRandom(nameSeed(name, 'members-fashion'));
    const [rClue, rClueKind, rClueColour, rHelm, rHelmKind, rFrem, rShirt, rBoots, rColour, rSnelm, rSnelmKind, rBook, rBookKind, rRobe, rRobeKind, rRobeColour, rRobeHat, rRobeBoots] = Array.from({ length: 18 }, () => r());
    const m = membersItems();
    const out: MembersFashion = { hat: NONE, hatOverHelm: false, cape: NONE, body: NONE, legs: NONE, feet: NONE, shield: NONE };
    if (tier === 'newcomer') return out;
    const rich = tier === 'experienced' || tier === 'veteran';
    const pick = (list: readonly number[], x: number): number => (list.length ? list[Math.floor(x * list.length)] : NONE);
    // the hat: a Fremennik helm first, then a clue hat, then a snelm
    if (rich && levels.defence >= 45 && rHelm < MEMBERS_SHARES.fremennikHelm) {
        const h = m.fremennikHelms;
        out.hat = style === 'ranger' ? h.archer : style === 'mage' ? h.farseer : rHelmKind < 0.5 ? h.berserker : h.warrior;
        out.hatOverHelm = true;
    } else if (rClue < MEMBERS_SHARES.clueHat) {
        const c = m.clueHats;
        out.hat = rClueKind < 0.3 ? pick(c.berets, rClueColour) : rClueKind < 0.6 ? pick(c.cavaliers, rClueColour) : rClueKind < 0.85 ? pick(c.headbands, rClueColour) : rClueKind < 0.95 || levels.ranged < 40 ? c.pirate : c.robinHood;
        out.hatOverHelm = true;
    } else if (tier !== 'novice' && rSnelm < MEMBERS_SHARES.snelm) out.hat = pick(m.snelms, rSnelmKind);
    if (rich && rFrem < MEMBERS_SHARES.fremennik) {
        out.cape = pick(m.fremennikCloaks, rColour);
        if (rShirt < 0.6) out.body = pick(m.fremennikShirts, rColour);
        if (rBoots < 0.5) out.feet = m.fremennikBoots;
    }
    if (tier === 'veteran' && (opts.prayer || style === 'mage') && rBook < MEMBERS_SHARES.godBook) out.shield = pick(m.godBooks, rBookKind);
    if (rich && opts.robes && rRobe < MEMBERS_SHARES.robes) {
        const set = rRobeKind < 0.5 ? m.wolfenRobes : m.gnomeRobes;
        const [top, bottom, hat, boots] = set[Math.floor(rRobeColour * set.length)] ?? [NONE, NONE, NONE, NONE];
        out.body = top;
        out.legs = bottom;
        if (rRobeHat < 0.5 && out.hat === NONE) out.hat = hat;
        if (rRobeBoots < 0.3) out.feet = boots;
    }
    return out;
}

/**
 * A members mage's battlestaff of its own kind (its own seed 'battlestaff-kind'): the air one 4 in 10, fire 3 in 10, water
 * and earth 15 % each (Zaff's plain battlestaff was the one a crafter powered; 2004's mages held the powered ones).
 */
export function battlestaffOf(name: string): number {
    const roll = seededRandom(nameSeed(name, 'battlestaff-kind'))();
    const [air, fire, water, earth] = membersItems().battlestaves;
    return (roll < 0.4 ? air : roll < 0.7 ? fire : roll < 0.85 ? water : earth) ?? NONE;
}

// ── novelty pieces (WEAR-9) ───────────────────────────────────────────────────

export interface NoveltyItems {
    mime: number[];
    holySymbol: number;
    accuracy: number;
    /** gold, sapphire, emerald, ruby, diamond (strung), with the Crafting level each needs */
    gemAmulets: [number, number][];
    yellowCape: number;
}

let NOVELTY: NoveltyItems | null = null;

export function noveltyItems(): NoveltyItems {
    if (NOVELTY) return NOVELTY;
    NOVELTY = {
        mime: ['macro_mime_mask', 'macro_mime_top', 'macro_mime_legs', 'macro_mime_gloves', 'macro_mime_boots'].map(id).filter(i => i !== NONE),
        holySymbol: id('blessedstar'),
        accuracy: id('amulet_of_accuracy'),
        gemAmulets: (
            [
                ['strung_gold_amulet', 8],
                ['strung_sapphire_amulet', 24],
                ['strung_emerald_amulet', 31],
                ['strung_ruby_amulet', 50],
                ['strung_diamond_amulet', 70]
            ] as const
        )
            .map(([n, level]) => [id(n), level] as [number, number])
            .filter(([i]) => i !== NONE),
        yellowCape: id('yellow_cape')
    };
    return NOVELTY;
}

/** the novelty shares (WEAR-9): the mime's outfit, a holy symbol, the amulet of accuracy, a gem amulet */
export const NOVELTY_SHARES = { mime: 0.01, holyPrayer: 0.4, holyMonk: 0.8, accuracy: 0.08, gem: 0.4 } as const;

export interface Novelty {
    /** the whole outfit, on over everything (the mime random event's reward, untradeable) */
    mime: number[];
    /** an amulet into an empty neck slot (a holy symbol, the amulet of accuracy, a gem amulet) */
    neck: number;
}

/**
 * A bot's novelty pieces (its own seed 'novelty'): the mime's outfit on NOVELTY_SHARES.mime of the veterans (274's mime
 * event); a holy symbol on 4 prayer trainers in 10 and 8 monks' names in 10; the amulet of accuracy on 8 novices in 100
 * (Imp Catcher, one of the first quests); a gem amulet on 4 crafters in 10 (the best its Crafting makes: gold 8, sapphire
 * 24, emerald 31, ruby 50, diamond 70).
 */
export function noveltyOf(name: string, tier: AgeTier, crafting: number, opts: { prayer: boolean; monk: boolean; crafter: boolean }): Novelty {
    const r = seededRandom(nameSeed(name, 'novelty'));
    const [rMime, rHoly, rAccuracy, rGem] = [r(), r(), r(), r()];
    const n = noveltyItems();
    const out: Novelty = { mime: [], neck: NONE };
    if (tier === 'veteran' && rMime < NOVELTY_SHARES.mime) out.mime = n.mime;
    if ((opts.monk && rHoly < NOVELTY_SHARES.holyMonk) || (opts.prayer && rHoly < NOVELTY_SHARES.holyPrayer)) out.neck = n.holySymbol;
    else if (tier === 'novice' && rAccuracy < NOVELTY_SHARES.accuracy) out.neck = n.accuracy;
    else if (opts.crafter && rGem < NOVELTY_SHARES.gem) {
        let best = NONE;
        for (const [i, level] of n.gemAmulets) if (crafting >= level) best = i;
        out.neck = best;
    }
    return out;
}

/** a newbie newcomer's amulet of accuracy (Imp Catcher done in its first sessions), this often (its own seed 'novelty') */
export const NEWBIE_ACCURACY = 0.03;

/** Does a newbie newcomer of this name wear the amulet of accuracy (port/BotAppearance: new bodies only)? */
export function newbieAccuracyOf(name: string): boolean {
    const r = seededRandom(nameSeed(name, 'novelty'));
    r();
    r();
    return r() < NEWBIE_ACCURACY;
}

/**
 * Every members fashion and novelty item of this module (not the status pieces: those are armour, port/BotLooks): a
 * wardrobe item (port/BotLooks isWardrobeItem: never sold as junk, never alched, never put on by a metal in its name)
 */
export function fashionItemIds(): number[] {
    const m = membersItems();
    const n = noveltyItems();
    return [
        ...Object.values(m.fremennikHelms), ...m.fremennikShirts, ...m.fremennikCloaks, m.fremennikBoots, ...m.snelms, ...m.godBooks,
        ...m.clueHats.berets, ...m.clueHats.cavaliers, ...m.clueHats.headbands, m.clueHats.pirate, m.clueHats.robinHood, ...m.battlestaves,
        ...m.wolfenRobes.flat(), ...m.gnomeRobes.flat(), ...n.mime, n.holySymbol, n.accuracy, ...n.gemAmulets.map(([i]) => i), n.yellowCape
    ].filter(i => i !== NONE);
}

// ── PK outfit variety (WEAR-8) ────────────────────────────────────────────────

export interface PkLook {
    name: string;
    atk: number;
    def: number;
    range: number;
    weapon: number;
    specWeapon: number;
    helm: number;
    body: number;
    legs: number;
    shield: number;
    neck: number;
    boots: number;
    gloves: number;
}

/** the PK items the variety picks from, by debugname (looked up once) */
let PK_ITEMS: Record<string, number> | null = null;
function pkItems(): Record<string, number> {
    if (PK_ITEMS) return PK_ITEMS;
    const names = [
        'rune_scimitar', 'rune_2h_sword', 'rune_longsword', 'rune_battleaxe', 'dragon_longsword', 'dragon_battleaxe', 'dragon_dagger_p',
        'rune_full_helm', 'rune_med_helm', 'adamant_full_helm', 'adamant_med_helm', 'dragon_med_helm', 'viking_helmet_crush',
        'rune_platelegs', 'rune_plateskirt', 'adamant_platelegs', 'adamant_plateskirt', 'leather_chaps',
        'dragonhide_chaps', 'blue_dragonhide_chaps', 'red_dragonhide_chaps', 'black_dragonhide_chaps',
        'dragon_vambraces', 'blue_dragon_vambraces', 'red_dragon_vambraces', 'black_dragon_vambraces', 'leather_gloves',
        'leather_boots', 'death_climbingboots', 'boots_ranger',
        'amulet_of_glory', 'amulet_of_power', 'amulet_of_strength',
        'rune_kiteshield', 'adamant_kiteshield'
    ];
    PK_ITEMS = Object.fromEntries(names.map(n => [n, id(n)]));
    return PK_ITEMS;
}

/** the fields the variety may change, in the order the save is checked for them (pkVarietyAtLogin) */
const VARIED: ReadonlyArray<keyof PkLook> = ['gloves', 'boots', 'neck', 'helm', 'legs', 'weapon', 'shield'];

/**
 * (WEAR-8) a PKer's outfit varied from its profile's own seed (`${salt}:pk-variety` of its name): its build (levels,
 * spec weapon, bow, food, potions) as before, its gloves, boots, amulet, helm, legs and weapon its own, within what its
 * levels wear and its world allows. Members mains: vambraces of a colour their Ranged allows 45 %, leather gloves 2 in 10,
 * none the rest; leather boots 55 %, climbing boots 15 %, none; a glory 55 %, power 30 %, strength; a dragon med helm 3 in
 * 10 at 60 Defence, a berserker helm 2 in 10 at 45; platelegs 6 in 10, a plateskirt 15 %, d'hide chaps; a rune scimitar,
 * dragon longsword, rune 2h or dragon battleaxe (no shield with the 2h). Pures: vambraces of their colour or one below, or
 * none; leather boots, ranger boots or none; a glory, strength or power amulet; chaps of their colour or one below; a rune
 * scimitar or dragon longsword. A free world's: the same within F2P (green vambraces, leather; a rune or adamant full or
 * medium helm, platelegs or a plateskirt; a rune scimitar, 2h, longsword or battleaxe). `keepHelm`: a class-named PKer's
 * hat stays (port/BotOutfits classPkProfile).
 */
export function pkVariedProfile<T extends PkLook>(name: string, profile: T, salt: string, members: boolean, keepHelm = false): T {
    // (the same object at every call, as the tables' profiles are: a PK task's profile is its name's, PKerTask compares them)
    let byName = PK_VARIED.get(profile);
    if (!byName) PK_VARIED.set(profile, (byName = new Map()));
    const key = `${salt}:${name}:${members}:${keepHelm}`;
    const known = byName.get(key) as T | undefined;
    if (known) return known;
    const out = variedOf(name, profile, salt, members, keepHelm);
    byName.set(key, out);
    return out;
}
const PK_VARIED = new WeakMap<object, Map<string, unknown>>();

function variedOf<T extends PkLook>(name: string, profile: T, salt: string, members: boolean, keepHelm: boolean): T {
    const r = seededRandom(nameSeed(name, `${salt}:pk-variety`));
    const [rGloves, rGlovesColour, rBoots, rNeck, rHelm, rLegs, rLegsColour, rWeapon] = Array.from({ length: 8 }, () => r());
    const P = pkItems();
    const pure = profile.def <= 1;
    const out: T = { ...profile };
    const colours = members ? Math.max(0, Math.min(3, Math.floor((profile.range - 40) / 10))) : 0;
    const colour = (x: number): number => (colours === 0 ? 0 : x < 0.6 ? colours : Math.max(0, colours - 1));
    const vambs = [P.dragon_vambraces, P.blue_dragon_vambraces, P.red_dragon_vambraces, P.black_dragon_vambraces];
    const chaps = [P.dragonhide_chaps, P.blue_dragonhide_chaps, P.red_dragonhide_chaps, P.black_dragonhide_chaps];
    const rune = profile.def >= 40;
    if (pure) {
        out.gloves = rGloves < 0.65 ? vambs[colour(rGlovesColour)] : rGloves < 0.75 ? P.leather_gloves : NONE;
        out.boots = rBoots < 0.6 ? P.leather_boots : members && profile.range >= 40 && rBoots < 0.75 ? P.boots_ranger : NONE;
        out.neck = members ? (rNeck < 0.45 ? P.amulet_of_glory : rNeck < 0.8 ? P.amulet_of_strength : P.amulet_of_power) : rNeck < 0.6 ? P.amulet_of_strength : P.amulet_of_power;
        out.legs = members ? chaps[colour(rLegsColour)] : rLegs < 0.8 ? P.dragonhide_chaps : P.leather_chaps;
        if (members && profile.atk >= 60 && rWeapon < 0.2) out.weapon = P.dragon_longsword;
    } else {
        out.gloves = rGloves < 0.45 ? vambs[colour(rGlovesColour)] : rGloves < 0.65 ? P.leather_gloves : NONE;
        out.boots = rBoots < 0.55 ? P.leather_boots : members && rBoots < 0.7 ? P.death_climbingboots : NONE;
        out.neck = members ? (rNeck < 0.55 ? P.amulet_of_glory : rNeck < 0.85 ? P.amulet_of_power : P.amulet_of_strength) : rNeck < 0.55 ? P.amulet_of_power : P.amulet_of_strength;
        if (!keepHelm) {
            if (members && profile.def >= 60 && rHelm < 0.3) out.helm = P.dragon_med_helm;
            else if (members && profile.def >= 45 && rHelm < 0.5) out.helm = P.viking_helmet_crush;
            else if (!members && rHelm < 0.3) out.helm = rune ? P.rune_med_helm : P.adamant_med_helm;
            else out.helm = rune ? P.rune_full_helm : P.adamant_full_helm;
        }
        if (rLegs < 0.6) out.legs = rune ? P.rune_platelegs : P.adamant_platelegs;
        else if (rLegs < 0.75 || !members) out.legs = rune ? P.rune_plateskirt : P.adamant_plateskirt;
        else out.legs = chaps[colour(rLegsColour)];
        const twoHanded = (weapon: number): boolean => ObjType.get(weapon)?.wearpos2 === 5;
        if (members && profile.atk >= 60) out.weapon = rWeapon < 0.4 ? P.rune_scimitar : rWeapon < 0.7 ? P.dragon_longsword : rWeapon < 0.85 ? P.rune_2h_sword : P.dragon_battleaxe;
        else if (!members) out.weapon = rWeapon < 0.45 ? P.rune_scimitar : rWeapon < 0.75 ? P.rune_2h_sword : rWeapon < 0.9 ? P.rune_longsword : P.rune_battleaxe;
        out.shield = twoHanded(out.weapon) ? NONE : profile.shield !== NONE ? profile.shield : rune ? P.rune_kiteshield : P.adamant_kiteshield;
    }
    // (nothing the profile's world or levels cannot wear: none rather than a members item on a free world)
    for (const f of VARIED) {
        const v = out[f] as number;
        if (v === undefined || v === NONE) continue;
        if (!members && ObjType.get(v)?.members) (out[f] as number) = profile[f] as number;
    }
    return out;
}

/**
 * (WEAR-8, round 1's rule for saved PKers: port/BotOutfits pkProfileAtLogin) a PKer's profile at its login: the varied
 * outfit for a bot new since this rule (no save: `saved` false), or a saved one whose save shows it (it owns a piece the
 * variety gives it that its profile of before has not); else the profile as before. A PK task re-issues its profile's
 * gear every session, so a PKer saved before round 2 would come back in other gloves, boots and legs: saved bots keep
 * their looks. No mark in the save: the look is the mark.
 */
export function pkVarietyAtLogin<T extends PkLook>(name: string, profile: T, salt: string, members: boolean, saved: boolean, owns: (itemId: number) => boolean, keepHelm = false): T {
    const varied = pkVariedProfile(name, profile, salt, members, keepHelm);
    if (!saved) return varied;
    const shows = VARIED.some(f => {
        const v = varied[f] as number;
        return v !== NONE && v !== (profile[f] as number) && owns(v);
    });
    return shows ? varied : profile;
}

// ── what others remark on (for the conversation's gear comments) ──────────────

export type NotableKind = 'rare' | 'holiday' | 'status' | 'dragon' | 'members' | 'novelty' | 'rune';

export interface NotableGear {
    itemId: number;
    /** the worn slot */
    slot: number;
    kind: NotableKind;
    /** the game's name ("Rune platebody (g)") */
    name: string;
    /** what 2004 called it ("rune (g) plate", "zammy plate", "phat", "d med", "berserker helm") */
    nick: string;
}

const RARE_NICKS: ReadonlyArray<[RegExp, string]> = [
    [/_partyhat$/, 'phat'],
    [/^santa_hat$/, 'santa'],
    [/halloweenmask|halloween_mask/, 'hween mask'],
    [/^bunny_ears$/, 'bunny ears'],
    [/^scythe$/, 'scythe']
];
const GOD_NICK: Readonly<Record<God, string>> = { saradomin: 'sara', zamorak: 'zammy', guthix: 'guthix' };
const KIND_NICK: Readonly<Record<StatusKind, string>> = { full: 'full helm', plate: 'plate', platelegs: 'legs', skirt: 'skirt', kite: 'kite' };
const METAL_NICK: Readonly<Record<number, string>> = { 3: 'black', 5: 'addy', 6: 'rune' };

/** the nickname of a status piece: "rune (g) plate", "addy (t) kite", "zammy plate", "gilded plate" */
export function statusNick(piece: StatusPiece): string {
    const kind = KIND_NICK[piece.kind];
    if (piece.family === 'god') return `${GOD_NICK[piece.god!]} ${kind}`;
    if (piece.family === 'gilded') return `gilded ${kind}`;
    return `${METAL_NICK[piece.metal]} (${piece.family === 'trim' ? 't' : 'g'}) ${kind}`;
}

/**
 * What a player wears that others remark on, the most notable first: a rare (partyhat, santa hat, mask), a holiday item
 * (bunny ears, scythe), a status piece (trims, god, gilded), dragon (med helm, square shield, a dragon weapon), members show
 * pieces (a Fremennik helm, a glory, a god cape or book, a mystic or battlestaff, a clue hat, a snelm), a novelty (the
 * mime's outfit, a holy symbol), full rune (a rune platebody). For the conversation's gear comments (track S2: "nice
 * (g)", "nice zammy plate", "omg bunny ears"): its name and the nickname of 2004. Empty when nothing stands out.
 */
export function notableGearOf(player: Player): NotableGear[] {
    const worn = player.getInventory(InvType.WORN);
    if (!worn) return [];
    const out: NotableGear[] = [];
    const m = membersItems();
    const n = noveltyItems();
    const members = new Set<number>([...Object.values(m.fremennikHelms), m.fremennikBoots, ...m.fremennikCloaks, ...m.fremennikShirts, ...m.snelms, ...m.godBooks, ...m.battlestaves, ...m.clueHats.berets, ...m.clueHats.cavaliers, ...m.clueHats.headbands, m.clueHats.pirate, m.clueHats.robinHood]);
    for (let slot = 0; slot < worn.capacity; slot++) {
        const it = worn.get(slot);
        if (!it) continue;
        const type = ObjType.get(it.id);
        const debug = type?.debugname ?? '';
        const name = type?.name ?? debug;
        const rare = RARE_NICKS.find(([re]) => re.test(debug));
        const status = statusPieceOf(it.id);
        let kind: NotableKind | null = null;
        let nick = name.toLowerCase();
        if (rare) {
            kind = rare[1] === 'bunny ears' || rare[1] === 'scythe' ? 'holiday' : 'rare';
            nick = rare[1];
        } else if (status) {
            kind = 'status';
            nick = statusNick(status);
        } else if (/^dragon_(med_helm|sq_shield|longsword|battleaxe|mace|dagger|dagger_p|spear|spear_p)$/.test(debug)) {
            kind = 'dragon';
            nick = `d ${debug.replace(/^dragon_/, '').replace(/_p$/, '(p)').replace('sq_shield', 'sq').replace('med_helm', 'med').replace('longsword', 'long').replace('battleaxe', 'baxe')}`;
        } else if (members.has(it.id) || (/^amulet_of_glory|_cape$/.test(debug) && /saradomin|zamorak|guthix|legends|glory/.test(debug)) || /^mystic_.*staff$/.test(debug)) {
            kind = 'members';
            nick = /glory/.test(debug) ? 'glory' : /viking_helmet_crush/.test(debug) ? 'berserker helm' : /viking_helmet_slash/.test(debug) ? 'warrior helm' : /viking_helmet_range/.test(debug) ? 'archer helm' : /viking_helmet_magic/.test(debug) ? 'farseer helm' : /snelm/.test(debug) ? 'snelm' : /book_complete/.test(debug) ? name.toLowerCase() : nick;
        } else if (n.mime.includes(it.id) || it.id === n.holySymbol) {
            kind = 'novelty';
            nick = it.id === n.holySymbol ? 'holy symbol' : 'mime outfit';
        } else if (debug === 'rune_platebody') {
            kind = 'rune';
            nick = 'rune plate';
        }
        if (kind) out.push({ itemId: it.id, slot, kind, name, nick });
    }
    const rank: Readonly<Record<NotableKind, number>> = { rare: 0, holiday: 1, status: 2, dragon: 3, members: 4, novelty: 5, rune: 6 };
    return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

// ── wealth (who is rich) ──────────────────────────────────────────────────────

/**
 * A bot is rich from this bank value (coins and items, worn, carried and banked, at their December 2004 street price
 * where the table has one, else their value; its status pieces, rares and holiday items left out, so what it shows off
 * does not make it rich). The aged tiers (port/BotAge): the experienced hold 10-60k coins and the veterans 40-200k beside
 * their kits; an intermediate's 1-15k and mithril or black kit stay well under it.
 */
export const RICH_WEALTH = 75_000;

/** the items left out of a bot's wealth: status pieces, rares, holiday items (debugnames) */
const SHOW_RE = /_partyhat$|^santa_hat$|halloween|^bunny_ears$|^scythe$/;

/** A player's bank value (see RICH_WEALTH): coins and items in its bank, pack and worn slots, a vendor's stock left out. */
export function wealthOf(player: Player): number {
    let total = 0;
    const bankId = InvType.getId('bank');
    for (const invId of [InvType.WORN, InvType.INV, bankId]) {
        const inv = invId === -1 ? null : player.getInventory(invId);
        if (!inv) continue;
        for (let slot = 0; slot < inv.capacity; slot++) {
            const it = inv.get(slot);
            if (!it) continue;
            if (it.id === COINS()) {
                total += it.count;
                continue;
            }
            if (statusPieceOf(it.id)) continue;
            const type = ObjType.get(it.id);
            if (!type || SHOW_RE.test(type.debugname ?? '')) continue;
            total += it.count * (streetPrice(it.id) ?? Math.max(0, type.cost));
        }
    }
    return total;
}
let COINS_ID = -2;
function COINS(): number {
    if (COINS_ID === -2) COINS_ID = id('coins');
    return COINS_ID;
}

/** Is the bot rich (wealthOf at least RICH_WEALTH)? A vendor's purse is its stock's (500M), not wealth: never. */
export function isRich(player: Player): boolean {
    if (player.botPlanner === 'extras_vendor') return false;
    return wealthOf(player) >= RICH_WEALTH;
}

// ── a bot buying from a bot vendor (port/BotShowOff; port/BotTrade lets the vendor take its request) ───────────────

const buyingFrom = new WeakMap<Player, number>();

/** The buyer bot is (or is no longer: null) asking the vendor bot `vendorUid` to trade, to buy from it. */
export function setBuyingFrom(buyer: Player, vendorUid: number | null): void {
    if (vendorUid === null) buyingFrom.delete(buyer);
    else buyingFrom.set(buyer, vendorUid);
}

/** Is `requester` a bot that asks the vendor bot `vendor` to trade, to buy from it (port/BotShowOff)? */
export function isBuyingFrom(requester: Player, vendor: Player): boolean {
    return requester.is_bot === true && buyingFrom.get(requester) === vendor.uid;
}
