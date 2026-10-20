// port: earned gear (Phase 3). Upstream's InitTask put every scimitar and armour set from iron to rune
// in a new bot's bank, with 999,999,999 swordfish (and sharks on a members world): a level-3 bot owned rune, wore it at
// 40 Defence, and never ran out of food. Here a bot owns what it buys, as a 2004 player did: the coins it loots, sells
// junk for and starts with go on the best piece its levels allow that a shop sells, one trip at a time, at the shop's
// own price (ShopTripTask buys through 274's shop interface). Aged bots (port/BotAge) bring the kit their levels earned.
//
// port (the realism work, phase 4: "patchwork gear"): what a bot buys follows its taste
// (port/BotLooks gearTaste): in each slot the kind of piece it likes, from 274's own shops and their stock (a full or
// medium helm from Peksa, a platebody or a chainbody from Horvik or Wayne, platelegs from Louie or a plateskirt from
// Ranael, a kiteshield or a square shield from Cassie), the best metal its Defence allows that it can pay for, above
// any piece of any kind it owns for the slot. The pieces come one at a time as coins allow, so their metals mix (and
// Cassie's shields stop at iron). Then the accessories it likes, from Thessalia's in Varrock (a red cape, leather gloves
// and boots: 2-6 coins), one at a time like the rest; a skiller's hat (Betty's wizard hats in Port Sarim) and apron
// (Thessalia's) on a wardrobe trip now and then (wardrobeTrip, between plans). At a skill a bot takes its plate off at
// the bank and puts on its hat, apron, cape, boots or gloves (dressForSkill: no plate at a skill),
// and its next fight's bank trip puts the armour back on (CombatTask). A signature hat (a rare, the bunny ears) stays on.
//
// port (the variety work, round 1, track W: what bots wear; "new outfits reach
// saved bots through play"): what a bot buys and puts on follows port/BotOutfits too, saved bots as well: the weapon of
// the kind it likes (a longsword at Varrock's sword shop, a battleaxe at Brian's or Bob's, a mace at Flynn's, a 2h sword
// at Gaius' on a members world), a ranger's leather and studded pieces and a mage's wizard hat and skirt; on a wardrobe
// trip a skill's clothes (a cook's white apron, a smith's brown one) and a Magic trainer's hat; the outfit follows the
// fight (dressForMode: no metal body at a ranged fight, no metal at a magic one; dressForFight: a style's hat and robe or
// leather where no metal went at a melee one); at a skill the chef's hat only at the range, the axe or pickaxe in hand
// for half the woodcutters and miners, a crafter's own leather; Agility and Firemaking dress too.
import type Player from '#/engine/entity/Player.js';
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import World from '#/engine/World.js';
import type { Inventory } from '#/engine/Inventory.js';
import { Items, Shops } from '#/engine/bot/BotKnowledge.js';
import { coinsOwned, tripFailedRecently } from '#/engine/bot/BotNeeds.js';
import { usableOnThisWorld } from '#/engine/bot/port/BotPkGear.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import {
    armourPieceOf,
    canWearPiece,
    gearTaste,
    isDragonShield,
    isSignatureHat,
    metalForDefence,
    pieceOf,
    skillerLook,
    SLOT_WEARPOS,
    wardrobeItems,
    wearsSignatureHat,
    type ArmourPiece,
    type ArmourSlot,
    type PieceKind
} from '#/engine/bot/port/BotLooks.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import {
    canWearOutfitPiece,
    chefsHatAnywhere,
    combatStyleOf,
    isGatheringTool,
    isMagePiece,
    isRangerPiece,
    magePieces,
    mainSkillOf,
    meleeWeaponOf,
    nameClassOf,
    outfitItems,
    prayerTrainer,
    rangerPieces,
    skillClothesOf,
    toolLadders,
    toolWieldAttack,
    trainerWants,
    WEAPON_ATTACK,
    weaponKindOf,
    weaponMetalForAttack,
    weaponOf,
    wieldsTools,
    type CombatStyle,
    type MeleeWeapon,
    type WeaponKind
} from '#/engine/bot/port/BotOutfits.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
// (the variety work, round 2, track W2: fashion) the status pieces, late 2004's members fashion, the trade hubs
import { isRich, membersFashionOf, membersItems, noveltyItems, statusPieceOf } from '#/engine/bot/port/BotFashion.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { TRADE_BANKS } from '#/engine/bot/port/BotTradeSpots.js';

/**
 * port (phase 4): shops of the wardrobe that BotKnowledge's table does not have (where the shopkeeper stands in 274,
 * and its debugname, ShopTripTask.NPC_NAMES): Thessalia's clothes (owned_shop clotheshop: red capes, leather gloves and
 * boots, the brown and white aprons), Betty's magic shop (the blue and black wizard hats) and Ranael's plateskirts
 * (BotKnowledge's AL_KHARID_SKIRTS is 46 tiles off her). port (the variety work, round 1, track W: what bots wear) and
 * the weapons and outfits of WEAR-1 and WEAR-2, where their keepers stand in 274 (the maps' NPC spawns): Varrock's sword
 * shop (swordshop: swords, longswords and daggers to adamant; BotKnowledge's VARROCK_SWORDS stands 23 tiles off it),
 * Brian's battleaxes (Port Sarim), Flynn's maces (Falador), the Varrock tailor's fancy dress (a blue wizard hat, the
 * skirts), Zaff's staffs, and on a members world Gaius' two-handed swords (Taverley). The Champions' Guild's runite and
 * Heroes' Guild's dragon shops are upstairs and Oziach sells only after a dialogue: none of them is a trip here.
 */
export const WARDROBE_SHOPS: Readonly<Record<string, { location: [number, number, number]; entrance?: [number, number] }>> = {
    THESSALIA_CLOTHES: { location: [3204, 3417, 0] },
    BETTY_MAGIC: { location: [3012, 3259, 0] },
    RANAEL_SKIRTS: { location: [3316, 3164, 0] },
    // (the variety work, round 1, track W)
    VARROCK_SWORDSHOP: { location: [3204, 3398, 0] },
    BRIAN_BATTLEAXES: { location: [3027, 3249, 0] },
    FLYNN_MACES: { location: [2950, 3387, 0] },
    // (round 2, W2: its back is to the city's east wall: from the road outside, a trip stood within 8 tiles and the
    // tailor's 40 ticks to be found ran out on the way round through the east gate: in by the street to its north-west)
    VARROCK_FANCY_DRESS: { location: [3281, 3399, 0], entrance: [3270, 3402] },
    ZAFF_STAFFS: { location: [3203, 3434, 0] },
    GAIUS_2H: { location: [2884, 3450, 0] },
    // (the variety work, round 2, track W2: fashion; members) Rellekka's clothes (Yrsa: Fremennik shirts, cloaks, boots) and
    // battle gear (Skulgrimen: the Fremennik helms, warhammers), Canifis' clothes (Barker: the wolfen robes), the keepers'
    // spawns in 274's maps; a trip only from within ACCESSORY_RANGE (nextOutfitPiece) or for a weapon nearby (nextWeapon)
    RELLEKKA_CLOTHES: { location: [2625, 3675, 0] },
    RELLEKKA_WEAPONS: { location: [2663, 3694, 0] },
    CANIFIS_CLOTHES: { location: [3499, 3506, 0] },
    // (round 2, W2: round 1's leftover "the shops bots cannot reach") upstairs in the Champions' Guild, Scavvo's runite
    // shop (rune legs, plateskirt, chainbody, longsword, mace, sword; the coif, green d'hide chaps and vambraces) and
    // Valaine's (black full helm and platelegs, adamant platebody, the blue cape), up the guild's stairs (BotAction's
    // ChampionsGuild1 gateway); Oziach's rune platebody and green d'hide body (Edgeville, after his dialogue: ShopTripTask
    // answers it); on a members world Helemos' dragon battleaxe and mace upstairs in the Heroes' Guild (HeroesGuild1)
    // (`entrance`: the ground tile outside the building's door, where a shop trip walks first: ShopTripTask)
    CHAMPIONS_SCAVVO: { location: [3191, 3351, 1], entrance: [3191, 3365] },
    CHAMPIONS_VALAINE: { location: [3193, 3361, 1], entrance: [3191, 3365] },
    OZIACH: { location: [3069, 3517, 0] },
    HEROES_HELEMOS: { location: [2894, 3510, 1], entrance: [2905, 3510] }
};

/**
 * Where the game sells each piece (274's stock, with some in it: an item a shop lists at 0 is not for sale): Zeke's
 * scimitars (Al Kharid), Peksa's full and medium helms (Barbarian Village), Horvik's platebodies and chainbodies
 * (Varrock), Wayne's chainbodies (Falador: the black and adamant ones Horvik has not), Louie's platelegs and Ranael's
 * plateskirts (Al Kharid), Cassie's shields (Falador: the bronze kiteshield and the bronze and iron square shields).
 * Adamant and rune scimitars, rune armour and better shields no free shop sells.
 */
let GEAR_SHOP: Map<number, string> | null = null;
function gearShops(): Map<number, string> {
    if (GEAR_SHOP) return GEAR_SHOP;
    const I = Items;
    GEAR_SHOP = new Map<number, string>([
        [I.BRONZE_SCIMITAR, 'AL_KHARID_SCIMITARS'],
        [I.IRON_SCIMITAR, 'AL_KHARID_SCIMITARS'],
        [I.STEEL_SCIMITAR, 'AL_KHARID_SCIMITARS'],
        [I.MITHRIL_SCIMITAR, 'AL_KHARID_SCIMITARS'],
        ...[I.BRONZE_FULL_HELM, I.IRON_FULL_HELM, I.STEEL_FULL_HELM, I.MITHRIL_FULL_HELM, I.ADAMANT_FULL_HELM].map(id => [id, 'BARBARIAN_HELMETS'] as [number, string]),
        ...[I.BRONZE_MED_HELM, I.IRON_MED_HELM, I.STEEL_MED_HELM, I.MITHRIL_MED_HELM, I.ADAMANT_MED_HELM].map(id => [id, 'BARBARIAN_HELMETS'] as [number, string]),
        ...[I.BRONZE_PLATEBODY, I.IRON_PLATEBODY, I.STEEL_PLATEBODY, I.BLACK_PLATEBODY, I.MITHRIL_PLATEBODY].map(id => [id, 'VARROCK_ARMOUR'] as [number, string]),
        ...[I.BRONZE_CHAINBODY, I.IRON_CHAINBODY, I.STEEL_CHAINBODY, I.MITHRIL_CHAINBODY].map(id => [id, 'VARROCK_ARMOUR'] as [number, string]),
        [I.BLACK_CHAINBODY, 'FALADOR_CHAINS'],
        [I.ADAMANT_CHAINBODY, 'FALADOR_CHAINS'],
        ...[I.BRONZE_PLATELEGS, I.IRON_PLATELEGS, I.STEEL_PLATELEGS, I.BLACK_PLATELEGS, I.MITHRIL_PLATELEGS, I.ADAMANT_PLATELEGS].map(id => [id, 'AL_KHARID_LEGS'] as [number, string]),
        ...[I.BRONZE_PLATESKIRT, I.IRON_PLATESKIRT, I.STEEL_PLATESKIRT, I.BLACK_PLATESKIRT, I.MITHRIL_PLATESKIRT, I.ADAMANT_PLATESKIRT].map(id => [id, 'RANAEL_SKIRTS'] as [number, string]),
        [I.BRONZE_KITESHIELD, 'FALADOR_SHIELDS'],
        [I.BRONZE_SQ_SHIELD, 'FALADOR_SHIELDS'],
        [I.IRON_SQ_SHIELD, 'FALADOR_SHIELDS']
    ]);
    const w = wardrobeItems();
    for (const id of [w.redCape, w.gloves, w.boots, w.brownApron, w.whiteApron]) GEAR_SHOP.set(id, 'THESSALIA_CLOTHES');
    for (const id of [w.wizardHat, w.blackWizardHat]) GEAR_SHOP.set(id, 'BETTY_MAGIC');
    // port (the variety work, round 1, track W): the outfits (WEAR-1) and the weapons of every kind (WEAR-2), from the
    // shops that stock them (274's .inv, with some in it); a piece two shops sell has the other in OTHER_SHOP
    const o = outfitItems();
    for (const id of [o.leatherBody, o.blueSkirt, o.blackSkirt]) GEAR_SHOP.set(id, 'THESSALIA_CLOTHES');
    for (const id of [o.studdedBody, o.studdedChaps]) GEAR_SHOP.set(id, 'VARROCK_ARMOUR');
    const weapon = (kind: WeaponKind, tier: number, shop: string): void => {
        const w = weaponOf(kind, tier);
        if (w) GEAR_SHOP!.set(w.id, shop);
    };
    for (let tier = 0; tier <= 5; tier++) {
        for (const kind of ['longsword', 'sword', 'dagger'] as const) weapon(kind, tier, 'VARROCK_SWORDSHOP');
        weapon('battleaxe', tier, 'BRIAN_BATTLEAXES');
        if (tier !== 3) weapon('mace', tier, 'FLYNN_MACES');
        weapon('2h', tier, 'GAIUS_2H');
    }
    OTHER_SHOP = new Map<number, string>();
    OTHER_SHOP.set(w.wizardHat, 'VARROCK_FANCY_DRESS');
    for (const id of [o.blueSkirt, o.blackSkirt]) OTHER_SHOP.set(id, 'VARROCK_FANCY_DRESS');
    for (const tier of [1, 2, 4]) {
        const axe = weaponOf('battleaxe', tier);
        if (axe) OTHER_SHOP.set(axe.id, 'BOB_AXES');
    }
    // (the variety work, round 2, track W2) the yellow cape at the Varrock tailor's (a cape-liker of the yellow), Zaff's
    // battlestaff on a members world (a mage's), Rellekka's warhammers (to adamant) and helms, Yrsa's clothes, Barker's robes
    const yellow = noveltyItems().yellowCape;
    if (yellow !== -1) GEAR_SHOP.set(yellow, 'VARROCK_FANCY_DRESS');
    if (o.battlestaff !== -1) GEAR_SHOP.set(o.battlestaff, 'ZAFF_STAFFS');
    for (let tier = 0; tier <= 5; tier++) weapon('warhammer', tier, 'RELLEKKA_WEAPONS');
    // (round 2, W2: the guilds' shops and Oziach's: see WARDROBE_SHOPS)
    for (const kind of ['longsword', 'mace', 'sword'] as const) weapon(kind, 6, 'CHAMPIONS_SCAVVO');
    weapon('battleaxe', 7, 'HEROES_HELEMOS');
    weapon('mace', 7, 'HEROES_HELEMOS');
    for (const id of [I.RUNE_PLATELEGS, I.RUNE_PLATESKIRT, I.RUNE_CHAINBODY, o.coif, o.dhideChaps[0], o.dhideVambraces[0]]) GEAR_SHOP.set(id, 'CHAMPIONS_SCAVVO');
    for (const id of [I.BLACK_FULL_HELM, I.ADAMANT_PLATEBODY, w.capes[2]]) GEAR_SHOP.set(id, 'CHAMPIONS_VALAINE');
    OTHER_SHOP.set(I.BLACK_PLATELEGS, 'CHAMPIONS_VALAINE');
    for (const id of [I.RUNE_PLATEBODY, o.dhideBodies[0]]) GEAR_SHOP.set(id, 'OZIACH');
    const m = membersItems();
    for (const helm of Object.values(m.fremennikHelms)) if (helm !== -1) GEAR_SHOP.set(helm, 'RELLEKKA_WEAPONS');
    for (const i of [...m.fremennikShirts, ...m.fremennikCloaks, m.fremennikBoots]) if (i !== -1) GEAR_SHOP.set(i, 'RELLEKKA_CLOTHES');
    for (const set of m.wolfenRobes) for (const i of set) if (i !== -1) GEAR_SHOP.set(i, 'CANIFIS_CLOTHES');
    return GEAR_SHOP;
}
/** (the variety work, round 1, track W) the second shop of a piece two sell (the nearer one is the trip's) */
let OTHER_SHOP: Map<number, string> | null = null;

/** the shop that sells this piece of gear, or undefined (for the tests) */
export function gearShopOf(itemId: number): string | undefined {
    return gearShops().get(itemId);
}

/** (the variety work, round 1, track W) every shop that sells this piece (for the tests) */
export function gearShopsOf(itemId: number): string[] {
    const first = gearShops().get(itemId);
    const other = OTHER_SHOP?.get(itemId);
    return [first, other].filter((s): s is string => s !== undefined);
}

/** where a shop of the gear stands (BotKnowledge's table, else the wardrobe's) */
function shopLocation(shopKey: string): [number, number, number] | undefined {
    return Shops[shopKey]?.location ?? WARDROBE_SHOPS[shopKey]?.location;
}

/**
 * (the variety work, round 2, track W2) can a bot walk into the shop on this world? Not Varrock's tailor on a free world:
 * his yard is behind the city's east gate (Guidor's, 274's `_varrock_gate`: "members only" on a free world) and its
 * fences, so a trip there from anywhere ended in a rescue jump (round 1's wizard hats and skirts, this round's yellow
 * capes: f100 s7). His wizard hats are Betty's there; his skirts and yellow cape no free trip's
 */
export function shopOpenHere(shopKey: string): boolean {
    return shopKey !== 'VARROCK_FANCY_DRESS' || isMembersWorld();
}

/** (the variety work, round 1, track W) the shop of a piece nearest the bot (of the one or two that sell it, open here) */
function nearestShopOf(player: Player, itemId: number): string | undefined {
    const shops = gearShopsOf(itemId).filter(shopOpenHere);
    if (shops.length < 2) return shops[0];
    const dist = (key: string): number => {
        const at = shopLocation(key);
        return at ? Math.max(Math.abs(at[0] - player.x), Math.abs(at[1] - player.z)) : Infinity;
    };
    return shops.reduce((a, b) => (dist(b) < dist(a) ? b : a));
}

/** coins a bot keeps after an upgrade (a boat's fare, a few runes) */
const RESERVE = 100;

/** port (phase 4): accessories from this combat level (a person spends on weapon and armour first) */
export const ACCESSORY_COMBAT = 15;
/** port (phase 4): an accessory trip only this near the shop (Thessalia's in Varrock: Lumbridge, Falador, Port Sarim, Edgeville) */
export const ACCESSORY_RANGE = 260;
/** port (phase 4): play ticks between a skiller's wardrobe trips (1-2 hours) */
const WARDROBE_GAP: [number, number] = [6000, 12000];

/** does the bot own this item: worn, carried or banked? */
function owns(player: Player, itemId: number): boolean {
    for (const invId of [InvType.WORN, InvType.INV, InvType.getId('bank')]) {
        const inv = invId === -1 ? null : player.getInventory(invId);
        if (!inv) continue;
        for (let slot = 0; slot < inv.capacity; slot++) if (inv.get(slot)?.id === itemId) return true;
    }
    return false;
}

/** what the shop will ask, about: the item's value and a margin (the price rises as a shop's stock falls) */
function estimate(itemId: number): number {
    return Math.ceil(ObjType.get(itemId).cost * 1.3);
}

/** port (phase 4): the best metal the bot owns per armour slot, of any kind (worn, carried, banked); -2: none */
function ownedArmour(player: Player): Record<ArmourSlot, number> {
    const best: Record<ArmourSlot, number> = { helm: -2, body: -2, legs: -2, shield: -2 };
    for (const invId of [InvType.WORN, InvType.INV, InvType.getId('bank')]) {
        const inv = invId === -1 ? null : player.getInventory(invId);
        if (!inv) continue;
        for (let slot = 0; slot < inv.capacity; slot++) {
            const it = inv.get(slot);
            const piece = it ? armourPieceOf(it.id) : undefined;
            if (piece && piece.tier > best[piece.slot]) best[piece.slot] = piece.tier;
        }
    }
    return best;
}

/** port (phase 4): the kind of piece the bot's taste wants in a slot, or null (none) */
function tasteKind(slot: ArmourSlot, taste: ReturnType<typeof gearTaste>): PieceKind | null {
    switch (slot) {
        case 'helm': return taste.helm === 'none' ? null : taste.helm;
        case 'body': return taste.body;
        case 'legs': return taste.legs;
        case 'shield': return taste.shield === 'none' ? null : taste.shield;
    }
}

export interface GearPurchase {
    shopKey: string;
    itemId: number;
    cost: number;
}

/**
 * The next piece of gear the bot buys: the weapon first (of the scimitars its level allows, best first, the best a
 * shop sells and it can pay for, keeping RESERVE, above every tier it owns), then the body, legs, helm and shield of
 * the kind its taste wants (port, phase 4: the best metal its Defence allows that a shop sells and it can pay for, above
 * any piece of the slot it owns; no helm over a signature hat), then (port, phase 4) an accessory it likes. Null when
 * there is none. `scimitars` is CombatTask's table (best first).
 */
export function nextGearUpgrade(player: Player, scimitars: readonly { minAtk: number; itemId: number }[]): GearPurchase | null {
    const coins = coinsOwned(player) - RESERVE;
    if (coins <= 0) return null;
    const affordable = (id: number): GearPurchase | null => {
        const shopKey = nearestShopOf(player, id);
        if (!shopKey || !usableOnThisWorld(id) || tripFailedRecently(player, id)) return null;
        const cost = estimate(id);
        return cost <= coins ? { shopKey, itemId: id, cost } : null;
    };
    // port (the variety work, round 1, track W: WEAR-2, weapon taste): the weapon of the kind it likes, the best metal
    // its Attack allows that a shop sells and it can pay for, above any weapon of that kind it owns and no worse than
    // any other it owns (a scimitar's owner moves to its liked kind at the same metal); a kind no shop of this world
    // sells (a free world's 2h swords, the warhammers) the scimitars as before. Upstream and phase 4 bought scimitars only
    const weapon = nextWeapon(player, affordable, scimitars);
    if (weapon) return weapon;
    // port (the variety work, round 1, track W: WEAR-1): a ranger's or mage's pieces first (Thessalia's leather body and
    // skirts, Horvik's studded body and chaps, Betty's or the tailor's wizard hats)
    // (and no metal: a ranger or mage fights in what it owns of its kit's metal, and walks in its style's outfit)
    const style = levellingStyle(player);
    if (style === 'ranger' || style === 'mage') return nextStylePiece(player, style, affordable) ?? nextAccessory(player, coins, 'fighter');
    // body, legs, helm, shield: by taste (port, phase 4)
    const taste = gearTaste(player.username);
    const defence = player.baseLevels[PlayerStat.DEFENCE];
    const owned = ownedArmour(player);
    for (const slot of ['body', 'legs', 'helm', 'shield'] as const) {
        const kind = tasteKind(slot, taste);
        if (!kind || (slot === 'helm' && wearsSignatureHat(player))) continue;
        // (the variety work: no helm for a ranger or mage that owns its style's hat; no shield for a two-hander)
        if (slot === 'helm' && keepsStyleHat(player)) continue;
        if (slot === 'shield' && weaponKindOf(player.username) === '2h') continue;
        for (let tier = metalForDefence(defence); tier > owned[slot]; tier--) {
            const piece = pieceOf(kind, tier);
            const buy = piece && canWearPiece(piece, defence) ? affordable(piece.id) : null;
            if (buy) return buy;
        }
    }
    return nextAccessory(player, coins, 'fighter');
}

// ── the variety work, round 1, track W: weapons of every kind, a ranger's and a mage's pieces ─────────────────────

/** the best melee weapon tier the bot owns (worn, carried, banked), of its liked kind and of any: -1 none */
function ownedWeaponTiers(player: Player, liked: WeaponKind): { liked: number; any: number } {
    const out = { liked: -1, any: -1 };
    for (const invId of [InvType.WORN, InvType.INV, InvType.getId('bank')]) {
        const inv = invId === -1 ? null : player.getInventory(invId);
        if (!inv) continue;
        for (let slot = 0; slot < inv.capacity; slot++) {
            const it = inv.get(slot);
            const w = it ? meleeWeaponOf(it.id) : undefined;
            if (!w) continue;
            if (w.tier > out.any) out.any = w.tier;
            if (w.kind === liked && w.tier > out.liked) out.liked = w.tier;
        }
    }
    return out;
}

/** has some shop of this world a weapon of this kind? (a free world's 2h swords: no; the warhammers: none in reach) */
function kindSoldHere(kind: WeaponKind): boolean {
    for (let tier = 0; tier <= 7; tier++) {
        const w = weaponOf(kind, tier);
        if (w && gearShopOf(w.id) && usableOnThisWorld(w.id) && (gearShopOf(w.id) !== 'RELLEKKA_WEAPONS' || isMembersWorld())) return true;
    }
    return false;
}

/**
 * (the variety work, round 2, track W2: round 1's leftover, "warhammer-likers buy scimitars") the kind a bot buys: its
 * liked kind; a warhammer-liker's warhammer only at Rellekka's Skulgrimen (members) from within ACCESSORY_RANGE, else
 * the mace, the crushing weapon a shop sells (Flynn's); any other kind no shop of this world sells, as before
 */
export function buyingKindOf(player: Player): WeaponKind {
    const liked = weaponKindOf(player.username);
    if (liked !== 'warhammer') return liked;
    const at = WARDROBE_SHOPS.RELLEKKA_WEAPONS.location;
    const near = isMembersWorld() && at[2] === player.level && Math.max(Math.abs(at[0] - player.x), Math.abs(at[1] - player.z)) <= ACCESSORY_RANGE;
    return near ? 'warhammer' : 'mace';
}

/** WEAR-2: the next weapon of its liked kind (see nextGearUpgrade), or the scimitars' ladder for a kind no shop sells */
function nextWeapon(player: Player, affordable: (id: number) => GearPurchase | null, scimitars: readonly { minAtk: number; itemId: number }[]): GearPurchase | null {
    const attack = player.baseLevels[PlayerStat.ATTACK];
    const liked = buyingKindOf(player);
    if (kindSoldHere(liked)) {
        const owned = ownedWeaponTiers(player, liked);
        for (let tier = weaponMetalForAttack(attack); tier > owned.liked && tier >= owned.any; tier--) {
            const w = weaponOf(liked, tier);
            const buy = w && attack >= WEAPON_ATTACK[tier] ? affordable(w.id) : null;
            if (buy) return buy;
        }
        return null;
    }
    for (const t of scimitars) {
        if (attack < t.minAtk) continue;
        if (owns(player, t.itemId)) break; // this tier (or a better one, before it) is the bot's already
        const buy = affordable(t.itemId);
        if (buy) return buy;
    }
    return null;
}

/** the style a levelling bot dresses for (port/BotOutfits combatStyleOf); null for any other bot */
function levellingStyle(player: Player): CombatStyle | null {
    return player.is_bot === true && isLevelling((player.botPlanner ?? '') as PlannerKey) ? combatStyleOf(player.username) : null;
}

/** a body's rank on the ranger's ladder (leather, hardleather, studded, d'hide green to black); -1 none */
function rangerBodyRank(id: number): number {
    const o = outfitItems();
    if (id === o.leatherBody) return 0;
    if (id === o.hardleatherBody) return 1;
    if (id === o.studdedBody) return 2;
    const d = o.dhideBodies.indexOf(id);
    return d >= 0 ? 3 + d : -1;
}
/** legs on the ranger's ladder (leather, studded, d'hide green to black); -1 none */
function rangerLegsRank(id: number): number {
    const o = outfitItems();
    if (id === o.leatherChaps) return 0;
    if (id === o.studdedChaps) return 1;
    const d = o.dhideChaps.indexOf(id);
    return d >= 0 ? 2 + d : -1;
}

/** the best rank of a ladder the bot owns (worn, carried, banked) */
function ownedRank(player: Player, rank: (id: number) => number): number {
    let best = -1;
    for (const invId of [InvType.WORN, InvType.INV, InvType.getId('bank')]) {
        const inv = invId === -1 ? null : player.getInventory(invId);
        if (!inv) continue;
        for (let slot = 0; slot < inv.capacity; slot++) {
            const it = inv.get(slot);
            if (it) best = Math.max(best, rank(it.id));
        }
    }
    return best;
}

function levelsOf(player: Player): { attack: number; defence: number; ranged: number; magic: number } {
    const b = player.baseLevels;
    return { attack: b[PlayerStat.ATTACK], defence: b[PlayerStat.DEFENCE], ranged: b[PlayerStat.RANGED], magic: b[PlayerStat.MAGIC] };
}

/**
 * WEAR-1: the next piece of a ranger's or mage's outfit it likes (port/BotOutfits rangerPieces, magePieces) that a shop
 * sells, its levels allow and it owns nothing as good of: a ranger's body (Thessalia's leather body; Horvik's studded
 * body at 20 Ranged and 20 Defence, its liking's d'hide too, which no shop in reach sells) and studded chaps; a mage's
 * wizard hat (Betty's, or the tailor's blue one) and skirt (Thessalia's). Its robe drops from wizards only: a new bot's
 * kit has it (port/BotAge).
 */
function nextStylePiece(player: Player, style: 'ranger' | 'mage', affordable: (id: number) => GearPurchase | null): GearPurchase | null {
    const o = outfitItems();
    const { attack, defence, ranged, magic } = levelsOf(player);
    const members = isMembersWorld();
    if (style === 'ranger') {
        const want = rangerPieces(player.username, ranged, defence, members);
        if (want.body !== -1) {
            // (round 2, W2: Oziach's green d'hide body for one that likes d'hide, at 40 Ranged and Defence)
            const target = want.body === o.dhideBodies[0] && ranged >= 40 && defence >= 40 ? o.dhideBodies[0] : ranged >= 20 && defence >= 20 ? o.studdedBody : o.leatherBody;
            if (ownedRank(player, rangerBodyRank) < rangerBodyRank(target) && canWearOutfitPiece(target, ranged, defence, magic, attack)) {
                const buy = affordable(target);
                if (buy) return buy;
            }
        }
        // (round 2, W2: Scavvo's green d'hide chaps at 40 Ranged for one that likes d'hide)
        const legs = want.legs === o.dhideChaps[0] && ranged >= 40 ? o.dhideChaps[0] : o.studdedChaps;
        if (want.legs !== -1 && ranged >= 20 && ownedRank(player, rangerLegsRank) < rangerLegsRank(legs)) {
            const buy = affordable(legs);
            if (buy) return buy;
        }
        // (round 2, W2: Scavvo's coif at 20 Ranged, its green d'hide vambraces at 40, for one that likes them)
        if (want.helm === o.coif && whereOwned(player, o.coif) === null && !wearsSignatureHat(player)) {
            const buy = affordable(o.coif);
            if (buy) return buy;
        }
        if (want.hands === o.dhideVambraces[0] && ranged >= 40 && ![...o.dhideVambraces].some(v => whereOwned(player, v) !== null)) {
            const buy = affordable(o.dhideVambraces[0]);
            if (buy) return buy;
        }
        return null;
    }
    const want = magePieces(player.username, magic, defence, attack, members, false);
    for (const id of [want.helm, want.legs]) {
        if (id === -1 || !gearShopOf(id) || whereOwned(player, id) !== null) continue;
        if (id === want.helm && (wearsSignatureHat(player) || whereOwned(player, o.blueWizardHat) !== null || whereOwned(player, o.blackWizardHat) !== null)) continue;
        if (id === want.legs && [o.blueSkirt, o.blackSkirt, o.monkRobeBottom, ...o.splitbark].some(s => whereOwned(player, s) !== null)) continue;
        const buy = affordable(id);
        if (buy) return buy;
    }
    return null;
}

/**
 * Does the bot keep its style's hat on in a melee fight, no metal helm over it (a mage's wizard hat, a ranger's coif or
 * cowl, a pirate's hat: the 2004 "wizard hat and plate")? A levelling ranger or mage that owns one (a ranger that keeps
 * a metal helm, port/BotOutfits keepMetal, does not), or anyone that owns a pirate's hat.
 */
export function keepsStyleHat(player: Player): boolean {
    const o = outfitItems();
    if (o.pirateHat !== -1 && whereOwned(player, o.pirateHat) !== null) return true;
    // (the variety work, round 2, track W2: WEAR-7) a members show hat: a clue hat, a Fremennik helm
    if (isMembersWorld() && showHats().some(id => whereOwned(player, id) !== null)) return true;
    const style = levellingStyle(player);
    if (style === 'mage') return [o.blueWizardHat, o.blackWizardHat].some(id => whereOwned(player, id) !== null);
    if (style === 'ranger') {
        const { ranged, defence } = levelsOf(player);
        if (rangerPieces(player.username, ranged, defence, isMembersWorld()).keepMetal === 'helm') return false;
        return whereOwned(player, o.leatherCowl) !== null || (ranged >= 20 && whereOwned(player, o.coif) !== null);
    }
    return false;
}

/**
 * (the variety work, round 2, track W2: WEAR-7) a members show hat a bot keeps on in a melee fight (no metal helm over it,
 * keepsStyleHat) and puts back on after a skill: the clue hats (berets, cavaliers, headbands, the robin hood hat) and the
 * Fremennik helms
 */
export function showHats(): number[] {
    if (SHOW_HATS) return SHOW_HATS;
    const m = membersItems();
    SHOW_HATS = [...m.clueHats.berets, ...m.clueHats.cavaliers, ...m.clueHats.headbands, m.clueHats.robinHood, ...Object.values(m.fremennikHelms)].filter(i => i !== -1);
    return SHOW_HATS;
}
let SHOW_HATS: number[] | null = null;

/** (round 2, W2: WEAR-7) the members clothes a skill's bank stop puts on, by worn slot: hats (and the show hats), shirts and robe tops, robe bottoms, cloaks, boots */
function fashionWardrobe(): Record<number, number[]> {
    if (FASHION_WARDROBE) return FASHION_WARDROBE;
    const m = membersItems();
    const robes = [...m.wolfenRobes, ...m.gnomeRobes];
    const real = (ids: number[]): number[] => ids.filter(i => i !== -1);
    FASHION_WARDROBE = {
        0: real([...showHats(), ...m.snelms, ...robes.map(r => r[2])]),
        4: real([...m.fremennikShirts, ...robes.map(r => r[0])]),
        7: real(robes.map(r => r[1])),
        1: real(m.fremennikCloaks),
        10: real([m.fremennikBoots, ...robes.map(r => r[3])])
    };
    return FASHION_WARDROBE;
}
let FASHION_WARDROBE: Record<number, number[]> | null = null;

/** port (phase 4): a slot of the wardrobe it fills (a cape, gloves, boots, a hat, an apron) */
type WardrobeSlot = 'cape' | 'gloves' | 'boots' | 'hat' | 'apron';
const WARDROBE_WEARPOS: Readonly<Record<WardrobeSlot, number>> = { cape: 1, gloves: 9, boots: 10, hat: 0, apron: 4 };

/** port (phase 4): does the bot have something of this wardrobe slot: worn there, or an item of it owned anywhere */
function hasWardrobe(player: Player, slot: WardrobeSlot): boolean {
    const w = wardrobeItems();
    const worn = player.getInventory(InvType.WORN)?.get(WARDROBE_WEARPOS[slot]);
    const items: number[] =
        slot === 'cape' ? [...w.capes, w.legendsCape] : slot === 'gloves' ? [w.gloves] : slot === 'boots' ? [w.boots] : slot === 'hat' ? [w.wizardHat, w.blackWizardHat, w.chefsHat] : [w.brownApron, w.whiteApron];
    if (worn && items.includes(worn.id)) return true;
    if (slot !== 'hat' && slot !== 'apron' && worn) return true; // (any cape, gloves or boots it wears)
    return items.some(id => owns(player, id));
}

/**
 * port (phase 4): the next accessory the bot buys, or null: of the ones its taste likes and it has none of, the first a
 * shop within ACCESSORY_RANGE sells (a fighter: a cape, boots, gloves from combat ACCESSORY_COMBAT; a skiller also its
 * hat and apron), keeping RESERVE (they cost 2-6 coins)
 */
export function nextAccessory(player: Player, coins: number, who: 'fighter' | 'skiller'): GearPurchase | null {
    if (who === 'fighter' && player.combatLevel < ACCESSORY_COMBAT) return null;
    const taste = gearTaste(player.username);
    const w = wardrobeItems();
    const wants: [WardrobeSlot, boolean, number][] = [
        // (port, phase 5b: its own liking: a clan's cape is its kit's, or one bought for a walk, port/BotClanWalk)
        // (round 2, W2: WEAR-9) a yellow-liker's cape is yellow, the Varrock tailor's (Thessalia sells red only)
        ['cape', taste.ownCape, likedCape(player)],
        ['boots', taste.boots, w.boots],
        ['gloves', taste.gloves, w.gloves]
    ];
    if (who === 'skiller') {
        // (Betty's wizard hats; the chef's hat no shop of 274 has in stock)
        if (taste.hat === 'wizard') wants.unshift(['hat', true, taste.blackHat ? w.blackWizardHat : w.wizardHat]);
        wants.unshift(['apron', taste.apron, taste.whiteApron ? w.whiteApron : w.brownApron]);
    }
    for (const [slot, liked, id] of wants) {
        if (!liked || id === -1 || hasWardrobe(player, slot)) continue;
        if (slot === 'hat' && wearsSignatureHat(player)) continue;
        const shopKey = gearShops().get(id);
        const shop = shopKey && shopOpenHere(shopKey) ? WARDROBE_SHOPS[shopKey] : undefined;
        if (!shop || shop.location[2] !== player.level || Math.max(Math.abs(shop.location[0] - player.x), Math.abs(shop.location[1] - player.z)) > ACCESSORY_RANGE) continue;
        if (tripFailedRecently(player, id)) continue;
        const cost = estimate(id);
        if (cost <= coins) return { shopKey: shopKey!, itemId: id, cost };
    }
    return null;
}

/** (the variety work, round 2, track W2: WEAR-9) the cape a bot buys: the yellow one for a yellow-liker (port/BotLooks capes' index 3), else Thessalia's red */
function likedCape(player: Player): number {
    const w = wardrobeItems();
    const yellow = noveltyItems().yellowCape;
    return yellow !== -1 && w.capes[gearTaste(player.username).capeColour % w.capes.length] === yellow ? yellow : w.redCape;
}

const nextWardrobeTrip = new WeakMap<Player, number>();

/**
 * port (phase 4): a skiller's wardrobe trip, between plans (BotGoalPlanner), or null: a levelling bot that likes a
 * skiller's outfit (port/BotLooks skillerLook: most skillers, some balanced and random bots), once in 1-2 hours of play
 * at most, the next piece of its outfit it has none of (an apron, a wizard hat, a cape, boots, gloves) from a shop near
 * it, with the coins for it. port (the variety work, round 1, track W) and any levelling bot's: the clothes of its main
 * skill (a cook's white apron, a smith's or crafter's brown apron and gloves, a fisher's boots: WEAR-3), a ranger's or
 * mage's pieces (WEAR-1), a wizard hat for a bot that trains Magic and a leather body for one that trains Ranged (the
 * outfit at those fights follows the fight: dressForMode), at the same pace.
 */
export function wardrobeTrip(player: Player, planner: PlannerKey): GearPurchase | null {
    if (!isLevelling(planner)) return null;
    const skiller = skillerLook(player.username, planner);
    if (!skiller && !wantsOutfit(player)) return null;
    const now = World.currentTick;
    const due = nextWardrobeTrip.get(player);
    // (the variety work: a draw of its own, from the name and the tick, not the world's Math.random: the trips of any
    // levelling bot now, and a draw from the shared stream at each moved every other bot's dice after it)
    const draw = seededRandom(nameSeed(player.username, 'wardrobe-trip') ^ now);
    if (due === undefined) {
        // (a first look 6-36 minutes into its session: not at its first pick, and within most sessions)
        nextWardrobeTrip.set(player, now + 600 + Math.floor(draw() * 3000));
        return null;
    }
    if (now < due) return null;
    nextWardrobeTrip.set(player, now + WARDROBE_GAP[0] + Math.floor(draw() * (WARDROBE_GAP[1] - WARDROBE_GAP[0])));
    const coins = coinsOwned(player) - RESERVE;
    if (coins <= 0) return null;
    // (the variety work: a skill's clothes, a class's or style's pieces first, then a skiller's accessories)
    return nextOutfitPiece(player, coins) ?? (skiller ? nextAccessory(player, coins, 'skiller') : null);
}

/** (the variety work, round 1, track W) the clothes of the bot's main skill now (port/BotOutfits skillClothesOf) */
function skillClothesFor(player: Player): ReturnType<typeof skillClothesOf> {
    return skillClothesOf(player.username, mainSkillOf(player.baseLevels), prayerTrainer(player.baseLevels));
}

/** (the variety work) has the bot, by its name and levels, any piece to buy on a wardrobe trip (no inventory scan)? */
function wantsOutfit(player: Player): boolean {
    const style = levellingStyle(player);
    if (style === 'ranger' || style === 'mage') return true;
    const c = skillClothesFor(player);
    if (c.whiteApron || c.brownApron || c.gloves || c.boots) return true;
    const t = trainerWants(player.username, player.baseLevels[PlayerStat.MAGIC], player.baseLevels[PlayerStat.RANGED], style ?? 'melee');
    if (t.hat || t.body) return true;
    // (the variety work, round 2, track W2: WEAR-7) a piece of the members fashion it likes that a shop sells
    if (!isMembersWorld()) return false;
    const mf = membersFashionOf(player.username, 'experienced', { defence: player.baseLevels[PlayerStat.DEFENCE], ranged: player.baseLevels[PlayerStat.RANGED] }, style ?? 'melee', { prayer: false, robes: true });
    const m = membersItems();
    return Object.values(m.fremennikHelms).includes(mf.hat) || mf.cape !== -1 || m.wolfenRobes.some(r => r[0] === mf.body);
}

/**
 * (the variety work, round 1, track W) the next piece of its skill's clothes, its style's outfit or its training's (see
 * wardrobeTrip) that a shop within ACCESSORY_RANGE sells and it owns none of, keeping RESERVE; null when there is none
 */
export function nextOutfitPiece(player: Player, coins: number): GearPurchase | null {
    const near = (id: number): GearPurchase | null => {
        if (id === -1 || !usableOnThisWorld(id) || tripFailedRecently(player, id)) return null;
        const shopKey = nearestShopOf(player, id);
        const at = shopKey ? shopLocation(shopKey) : undefined;
        if (!shopKey || !at || at[2] !== player.level || Math.max(Math.abs(at[0] - player.x), Math.abs(at[1] - player.z)) > ACCESSORY_RANGE) return null;
        const cost = estimate(id);
        return cost <= coins ? { shopKey, itemId: id, cost } : null;
    };
    const w = wardrobeItems();
    const o = outfitItems();
    const clothes = skillClothesFor(player);
    const wants: [boolean, number][] = [
        [clothes.whiteApron && whereOwned(player, w.whiteApron) === null, w.whiteApron],
        [clothes.brownApron && whereOwned(player, w.brownApron) === null, w.brownApron],
        [clothes.gloves && !hasWardrobe(player, 'gloves'), w.gloves],
        [clothes.boots && !hasWardrobe(player, 'boots'), w.boots],
        [clothes.cape && !hasWardrobe(player, 'cape'), likedCape(player)]
    ];
    for (const [want, id] of wants) {
        const buy = want ? near(id) : null;
        if (buy) return buy;
    }
    const style = levellingStyle(player) ?? 'melee';
    if (style === 'ranger' || style === 'mage') {
        const piece = nextStylePiece(player, style, near);
        if (piece) return piece;
    }
    const { ranged, magic } = levelsOf(player);
    const t = trainerWants(player.username, magic, ranged, style);
    if (t.hat && ![w.wizardHat, w.blackWizardHat].some(id => whereOwned(player, id) !== null) && !wearsSignatureHat(player)) {
        const buy = near(w.wizardHat);
        if (buy) return buy;
    }
    if (t.body && ownedRank(player, rangerBodyRank) < 0) {
        const buy = near(o.leatherBody);
        if (buy) return buy;
    }
    // (the variety work, round 2, track W2: WEAR-7) on a members world, the members fashion it likes from a shop near it
    return isMembersWorld() ? nextMembersPiece(player, near) : null;
}

/**
 * (round 2, W2: WEAR-7) the next piece of late 2004's members fashion the bot likes (port/BotFashion membersFashionOf, the
 * rich as the experienced) and owns none of its kind, that a shop near it sells (`near`: within ACCESSORY_RANGE): a
 * Fremennik helm (45 Defence) at Skulgrimen's, a Fremennik cloak, shirt or boots at Yrsa's (Rellekka), a wolfen robe at
 * Barker's (Canifis), a mage's battlestaff at Zaff's (30 Magic and Attack). Clue hats, snelms and god books come from no shop.
 */
function nextMembersPiece(player: Player, near: (id: number) => GearPurchase | null): GearPurchase | null {
    const { attack, defence, ranged, magic } = levelsOf(player);
    const style = levellingStyle(player) ?? 'melee';
    const tier = isRich(player) ? 'experienced' : 'intermediate';
    const mf = membersFashionOf(player.username, tier, { defence, ranged }, style, { prayer: prayerTrainer(player.baseLevels), robes: style === 'mage' || skillerLook(player.username, (player.botPlanner ?? 'balanced') as PlannerKey) });
    const m = membersItems();
    const ownsAny = (ids: readonly number[]): boolean => ids.some(id => id !== -1 && whereOwned(player, id) !== null);
    const wants: [boolean, number][] = [
        [mf.hat !== -1 && Object.values(m.fremennikHelms).includes(mf.hat) && !ownsAny(Object.values(m.fremennikHelms)), mf.hat],
        [mf.cape !== -1 && !ownsAny(m.fremennikCloaks), mf.cape],
        [mf.body !== -1 && m.fremennikShirts.includes(mf.body) && !ownsAny(m.fremennikShirts), mf.body],
        [mf.feet !== -1 && mf.feet === m.fremennikBoots && !ownsAny([m.fremennikBoots]), mf.feet],
        [mf.body !== -1 && m.wolfenRobes.some(r => r[0] === mf.body) && !ownsAny(m.wolfenRobes.map(r => r[0])), mf.body],
        [mf.legs !== -1 && m.wolfenRobes.some(r => r[1] === mf.legs) && !ownsAny(m.wolfenRobes.map(r => r[1])), mf.legs]
    ];
    for (const [want, id] of wants) {
        const buy = want ? near(id) : null;
        if (buy) return buy;
    }
    // a members mage's battlestaff (Zaff's plain one: what a crafter powered; the kits hold powered ones)
    const o = outfitItems();
    if (style === 'mage' && magic >= 30 && attack >= 30 && magePieces(player.username, magic, defence, attack, true, false).staff === o.battlestaff && !ownsAny([o.battlestaff, ...m.battlestaves])) return near(o.battlestaff);
    return null;
}

// ── wearing: what a bought accessory and a skill put on ───────────────────────

/** port (phase 4): the bank inventory, or null */
function bankOf(player: Player): Inventory | null {
    const id = InvType.getId('bank');
    return id === -1 ? null : player.getInventory(id);
}

/**
 * port (phase 4): a wardrobe item it carries goes on (a bought cape, gloves, boots, hat or apron: the shop trip's end),
 * into an empty slot (or over another accessory of its slot); true if it did. Directly, as the bots' other bank and
 * gear moves (a wear script clears the bot's pending click, and nothing about these needs one). port (the variety work,
 * round 1, track W) and a piece of its own style's outfit (a ranger's leather or studded body and chaps, a mage's hat and
 * skirt) over the metal of its slot: the metal into the pack (its next fight's bank trip banks or wears it)
 */
export function wearCarried(player: Player, itemId: number): boolean {
    const worn = player.getInventory(InvType.WORN);
    const inv = player.getInventory(InvType.INV);
    const type = ObjType.get(itemId);
    if (!worn || !inv || type.wearpos < 0 || !usableOnThisWorld(itemId)) return false;
    const current = worn.get(type.wearpos);
    const style = levellingStyle(player);
    // (the variety work, round 2, track W2: WEAR-7) a members show hat (a Fremennik helm, a clue hat) goes on over a metal helm too
    const own = (style === 'ranger' && isRangerPiece(itemId)) || (style === 'mage' && isMagePiece(itemId)) || (isMembersWorld() && showHats().includes(itemId));
    if (own) {
        const { attack, defence, ranged, magic } = levelsOf(player);
        if (!canWearOutfitPiece(itemId, ranged, defence, magic, attack)) return false;
    }
    if (current && (isSignatureHat(current.id) || (armourPieceOf(current.id) && !own))) return false; // (armour or a signature hat stays)
    if (inv.remove(itemId, 1) !== 1) return false;
    if (current) {
        worn.delete(type.wearpos);
        if (inv.add(current.id, current.count) < current.count) {
            worn.set(type.wearpos, current);
            inv.add(itemId, 1);
            return false;
        }
    }
    worn.set(type.wearpos, { id: itemId, count: 1 });
    return true;
}

/**
 * port (phase 4): the task kinds that are a skill (no plate there: dressForSkill). port (the variety work, round 1, track
 * W: WEAR-5) and Agility (its course's bank stop: AgilityTask); Thieving keeps its armour (a 2004 choice)
 */
const SKILL_TASKS: ReadonlySet<string> = new Set(['Woodcut', 'Mine', 'Fish', 'Cook', 'Smith', 'Crafting', 'Firemaking', 'Fletching', 'Herblore', 'Runecrafting', 'Pick Flax', 'BowStringing', 'WaterFilling', 'Agility']);

/** the kind of the bot's current task ('Woodcut', 'Combat', ...), '' with none */
function taskKindOf(player: Player): string {
    const task = (player as unknown as { _bot?: { currentTask?: { name?: string } | null } })._bot?.currentTask;
    return task?.name?.split(':')[0] ?? '';
}

/** port (phase 4): is the bot's task a skill? (its AI's current task, by kind) */
export function atASkill(player: Player): boolean {
    return SKILL_TASKS.has(taskKindOf(player));
}

/** (the variety work) moves one of an item from the bank or the pack into a worn slot (directly, at the booth); true if it did */
function putOn(worn: Inventory, pos: number, id: number, bank: Inventory | null, inv: Inventory | null): boolean {
    if (id === -1 || !usableOnThisWorld(id)) return false;
    for (const from of [bank, inv]) {
        if (!from || from.getItemCount(id) <= 0 || from.remove(id, 1) !== 1) continue;
        worn.set(pos, { id, count: 1 });
        return true;
    }
    return false;
}

/** (the variety work) the worn item in a slot to the bank (directly, at the booth); true if the slot is empty after */
function toBank(worn: Inventory, pos: number, bank: Inventory): boolean {
    const it = worn.get(pos);
    if (!it) return true;
    if (bank.add(it.id, it.count) !== it.count) return false;
    worn.delete(pos);
    return true;
}

/** (the variety work) the ranger's pieces the bot owns (bank, pack) that its levels allow, best first, per worn slot */
function rangerWardrobe(player: Player): Record<number, number[]> {
    const o = outfitItems();
    const { attack, defence, ranged, magic } = levelsOf(player);
    const ok = (id: number): boolean => id !== -1 && canWearOutfitPiece(id, ranged, defence, magic, attack);
    return {
        0: [o.coif, o.leatherCowl, o.robinHoodHat].filter(ok),
        4: [...[...o.dhideBodies].reverse(), o.studdedBody, o.hardleatherBody, o.leatherBody].filter(ok),
        7: [...[...o.dhideChaps].reverse(), o.studdedChaps, o.leatherChaps].filter(ok),
        9: [...[...o.dhideVambraces].reverse(), o.leatherVambraces].filter(ok),
        10: [o.rangerBoots].filter(ok)
    };
}

/** (the variety work) the mage's pieces the bot owns that its levels allow, its liking first, per worn slot */
function mageWardrobe(player: Player): Record<number, number[]> {
    const o = outfitItems();
    const { attack, defence, ranged, magic } = levelsOf(player);
    const like = magePieces(player.username, magic, defence, attack, isMembersWorld(), false);
    const ok = (id: number): boolean => id !== -1 && canWearOutfitPiece(id, ranged, defence, magic, attack);
    const first = (liked: number, all: number[]): number[] => [liked, ...all.filter(id => id !== liked)].filter(ok);
    const [sHelm, sBody, sLegs, sGloves, sBoots] = o.splitbark;
    return {
        0: first(like.helm, [sHelm, o.blueWizardHat, o.blackWizardHat]),
        4: first(like.body, [sBody, o.wizardRobe, o.blackRobe, o.monkRobeTop]),
        7: first(like.legs, [sLegs, o.monkRobeBottom, o.blueSkirt, o.blackSkirt]),
        9: [sGloves].filter(ok),
        10: [sBoots].filter(ok),
        1: o.godCapes.filter(ok)
    };
}

/**
 * port (phase 4: "patchwork gear", "no plate at a skill"): at a bank stop of a skill (BotTaskBase's
 * advanceBankWalk, as the bot reaches the booth): its plate goes into the bank (a metal helm, body, legs and shield; a
 * signature hat stays on), and what it keeps of a skiller's outfit comes out on: a rare or the bunny ears into an empty
 * hat slot, a veteran's scythe into its hands (its weapon to the bank), a hat (a chef's hat at the range), an apron, a
 * cape, boots, gloves into empty slots. Directly (the booth's click is pending: a wear script would clear it), as the
 * bots' other bank moves. Its next fight's bank trip puts the armour back on (CombatTask).
 * port (the variety work, round 1, track W: WEAR-3, -5, -6): the clothes of the skill (the chef's hat only at the range,
 * unless a chef's name or the joke; a white apron there, a brown one at the anvil and the crafting; a crafter's leather it
 * made, worn before the rest is banked); a ranger's or mage's pieces and a monk's robe into the slots the plate left; at
 * the trees and rocks the axe or pickaxe in hand for half the woodcutters and miners (wieldsTools: the best its Attack
 * allows, the weapon to the bank), and away from them the tool back in the pack (where the skills' tasks look) and the
 * best weapon back in hand; Agility too (its course's bank stop).
 */
export function dressForSkill(player: Player): void {
    if (player.is_bot !== true || !isLevelling((player.botPlanner ?? '') as PlannerKey)) return;
    const worn = player.getInventory(InvType.WORN);
    const bank = bankOf(player);
    if (!worn || !bank) return;
    // (the variety work: at any bank stop a cook's chef's hat away from the range goes to the bank, a thief's too)
    if (strayChefsHat(player)) toBank(worn, 0, bank);
    // (the variety work, round 2, track W2: WEAR-4, the wear track's R2) not at a skill: at a trade hub's bank a rich bot
    // puts its best on (dressForHub)
    if (!atASkill(player)) {
        dressForHub(player);
        return;
    }
    // the plate off
    for (const slot of ['helm', 'body', 'legs', 'shield'] as const) {
        const pos = SLOT_WEARPOS[slot];
        const it = worn.get(pos);
        if (!it) continue;
        const piece: ArmourPiece | undefined = armourPieceOf(it.id);
        if (!piece || piece.tier < 0) continue;
        if (bank.add(it.id, 1) === 1) worn.delete(pos);
    }
    // the outfit on: from the bank (or the pack: one just bought) into empty slots
    const w = wardrobeItems();
    const o = outfitItems();
    const inv = player.getInventory(InvType.INV);
    const kind = taskKindOf(player);
    const name = player.username;
    const cook = kind === 'Cook';
    const anywhere = chefsHatAnywhere(name);
    // (the variety work: the chef's hat is the range's, away from it to the bank; a chef's name or the joke keeps it)
    if (!cook && !anywhere && worn.get(0)?.id === w.chefsHat) toBank(worn, 0, bank);
    // (at the range the chef's hat over another hat it owns: a wizard hat or a coif to the bank; a signature hat stays)
    const hat = worn.get(0);
    if (cook && hat && hat.id !== w.chefsHat && !isSignatureHat(hat.id) && (bank.getItemCount(w.chefsHat) > 0 || (inv?.getItemCount(w.chefsHat) ?? 0) > 0)) toBank(worn, 0, bank);
    const takeOut = (pos: number, ids: readonly number[]): void => {
        if (worn.get(pos)) return;
        for (const id of ids) if (putOn(worn, pos, id, bank, inv)) return;
    };
    const style = levellingStyle(player);
    const clothes = skillClothesFor(player);
    const ranger = style === 'ranger' ? rangerWardrobe(player) : null;
    const mage = style === 'mage' ? mageWardrobe(player) : null;
    const crafting = kind === 'Crafting';
    // (a crafter's leather it made: from the pack only)
    const made = (ids: number[]): void => {
        if (!crafting || !inv) return;
        for (const id of ids) {
            const pos = ObjType.get(id).wearpos;
            if (pos >= 0 && !worn.get(pos)) putOn(worn, pos, id, null, inv);
        }
    };
    made([o.leatherBody, o.hardleatherBody, o.leatherChaps, o.leatherVambraces, w.gloves, w.boots, o.leatherCowl]);
    const rareHats = [...w.partyhats, w.santaHat, ...w.masks, w.bunnyEars];
    // (the variety work, round 2, track W2: WEAR-7) and on a members world its show hats, snelm, Fremennik clothes and robes
    const fashion = isMembersWorld() ? fashionWardrobe() : {};
    takeOut(0, [...rareHats, ...(cook ? [w.chefsHat] : []), ...(fashion[0] ?? []), ...(mage?.[0] ?? []), w.wizardHat, w.blackWizardHat, ...(anywhere ? [w.chefsHat] : []), ...(ranger?.[0] ?? []), o.pirateHat]);
    takeOut(4, cook ? [w.whiteApron, w.brownApron] : [w.brownApron, w.whiteApron]);
    if (clothes.monkRobe) takeOut(4, [o.monkRobeTop]);
    takeOut(4, [...(ranger?.[4] ?? []), ...(mage?.[4] ?? []), ...(fashion[4] ?? [])]);
    if (clothes.monkRobe) takeOut(7, [o.monkRobeBottom]);
    takeOut(7, [...(ranger?.[7] ?? []), ...(mage?.[7] ?? []), ...(fashion[7] ?? [])]);
    takeOut(1, [...w.capes, w.legendsCape, ...(fashion[1] ?? []), ...(mage?.[1] ?? [])]);
    takeOut(9, [w.gloves, ...(ranger?.[9] ?? []), ...(mage?.[9] ?? [])]);
    takeOut(10, [w.boots, ...(fashion[10] ?? []), ...(ranger?.[10] ?? []), ...(mage?.[10] ?? [])]);
    // the tool in hand at the trees and rocks (half the woodcutters and miners), back in the pack elsewhere
    const toolInHand = (kind === 'Woodcut' || kind === 'Mine') && wieldsTools(name) && wieldTool(player, worn, bank, inv, kind === 'Woodcut' ? 'axe' : 'pickaxe');
    // (a miner's or woodcutter's name keeps its pickaxe or axe in hand at any skill: its class's look, WEAR-6)
    const cls = nameClassOf(name);
    if (!toolInHand && cls !== 'miner' && cls !== 'woodcutter') stowTool(player, worn, bank, inv);
    // a veteran's scythe into its hands (both: the shield slot is empty at a skill), its weapon to the bank
    if (!toolInHand && w.scythe !== -1 && bank.getItemCount(w.scythe) > 0 && !worn.get(5)) {
        const held = worn.get(3);
        if (!held || bank.add(held.id, held.count) === held.count) {
            if (held) worn.delete(3);
            if (bank.remove(w.scythe, 1) === 1) worn.set(3, { id: w.scythe, count: 1 });
            else if (held && bank.remove(held.id, held.count) === held.count) worn.set(3, held);
        }
    }
}

/**
 * (WEAR-3) at the start of a woodcutting or mining task, a wielder's tool in its pack that it would hold at the trees or
 * rocks (the best its Attack and Mining allow, of those in the pack): its slot, for the task's own wear op (BotAction
 * interactHeldOp: the weapon goes into the pack, and the task's next bank stop banks it, as a player swaps); null when
 * it is no wielder, holds the tool already or carries none it may wield
 */
export function toolToWield(player: Player, which: 'axe' | 'pickaxe'): number | null {
    if (player.is_bot !== true || !isLevelling((player.botPlanner ?? '') as PlannerKey) || !wieldsTools(player.username)) return null;
    const inv = player.getInventory(InvType.INV);
    const worn = player.getInventory(InvType.WORN);
    if (!inv || !worn) return null;
    const { axes, pickaxes } = toolLadders();
    const ladder = which === 'axe' ? axes : pickaxes;
    const attack = player.baseLevels[PlayerStat.ATTACK];
    const mining = player.baseLevels[PlayerStat.MINING];
    const held = worn.get(3);
    if (held && ladder.includes(held.id)) return null;
    if (held && ObjType.get(held.id).wearpos2 === 5 && worn.get(5)) return null;
    let best = -1;
    let bestSlot = -1;
    for (let slot = 0; slot < inv.capacity; slot++) {
        const it = inv.get(slot);
        if (!it || !ladder.includes(it.id) || !usableOnThisWorld(it.id) || attack < toolWieldAttack(it.id)) continue;
        if (which === 'pickaxe' && mining < PICKAXE_MINING[pickaxes.indexOf(it.id)]) continue;
        if (ladder.indexOf(it.id) > ladder.indexOf(best)) {
            best = it.id;
            bestSlot = slot;
        }
    }
    return bestSlot === -1 ? null : bestSlot;
}

/**
 * (WEAR-3, WEAR-5) does the bot, before a skill without a bank stop of its own on the way (Agility, Firemaking), need its
 * bank to dress for it: metal armour, or a cook's chef's hat away from the range (the joke's aside)?
 */
export function needsSkillDress(player: Player): boolean {
    return wearsMetal(player) || strayChefsHat(player);
}

/**
 * (WEAR-3) the best axe or pickaxe the bot owns (worn, pack, bank) that its Attack lets it wield (274's levelrequire:
 * bronze and iron 1, steel 5, black 10, mithril 20, adamant 30, rune 40) and its Mining level lets it use, into its hand;
 * the weapon or other tool it held to the bank. True when that tool is in its hand.
 */
function wieldTool(player: Player, worn: Inventory, bank: Inventory, inv: Inventory | null, which: 'axe' | 'pickaxe'): boolean {
    const { axes, pickaxes } = toolLadders();
    const ladder = which === 'axe' ? axes : pickaxes;
    const attack = player.baseLevels[PlayerStat.ATTACK];
    const mining = player.baseLevels[PlayerStat.MINING];
    const usable = (id: number): boolean => usableOnThisWorld(id) && attack >= toolWieldAttack(id) && (which === 'axe' || mining >= PICKAXE_MINING[pickaxes.indexOf(id)]);
    let best = -1;
    for (const id of ladder) if (usable(id) && whereOwned(player, id) !== null) best = id;
    if (best === -1) return false;
    const held = worn.get(3);
    if (held?.id === best) return true;
    if (worn.get(5) && ObjType.get(best).wearpos2 === 5) return false;
    if (!toBank(worn, 3, bank)) return false;
    if (putOn(worn, 3, best, bank, inv)) return true;
    if (held) putOn(worn, 3, held.id, bank, null);
    return false;
}
/** the Mining level each pickaxe of the ladder needs (bronze, iron 1, steel 6, mithril 21, adamant 31, rune 41) */
const PICKAXE_MINING: readonly number[] = [1, 1, 6, 21, 31, 41];

/** (WEAR-3) an axe or pickaxe in hand away from its trees and rocks: into the pack, and the best weapon it owns back in hand */
function stowTool(player: Player, worn: Inventory, bank: Inventory, inv: Inventory | null): void {
    const held = worn.get(3);
    if (!held || !isGatheringTool(held.id) || !inv) return;
    if (inv.add(held.id, held.count) !== held.count) return;
    worn.delete(3);
    const best = bestMeleeWeapon(player, [bank]);
    if (!best) return;
    // (the fixes, the reviewer's: a two-hander's shield to the bank first, as CombatTask's bank does: a 2h went on over a
    // worn wooden shield, which a skill's "plate off" leaves on: it banks metal only)
    if (ObjType.get(best.id).wearpos2 === 5 && !toBank(worn, 5, bank)) return;
    putOn(worn, 3, best.id, bank, null);
}

/**
 * (WEAR-2) the best melee weapon the bot owns in these inventories that its Attack lets it wield, by metal, its liked kind
 * first at a metal; undefined: none
 */
export function bestMeleeWeapon(player: Player, invs: readonly (Inventory | null)[]): MeleeWeapon | undefined {
    const attack = player.baseLevels[PlayerStat.ATTACK];
    const liked = weaponKindOf(player.username);
    let best: MeleeWeapon | undefined;
    let bestScore = -1;
    for (const inv of invs) {
        for (let slot = 0; inv && slot < inv.capacity; slot++) {
            const it = inv.get(slot);
            const w = it ? meleeWeaponOf(it.id) : undefined;
            if (!w || attack < WEAPON_ATTACK[w.tier] || !usableOnThisWorld(w.id)) continue;
            const score = weaponScore(w, liked);
            if (score > bestScore) {
                best = w;
                bestScore = score;
            }
        }
    }
    return best;
}

/** (WEAR-2) a weapon's worth to its owner: its metal, then its liked kind */
export function weaponScore(w: MeleeWeapon, liked: WeaponKind): number {
    return w.tier * 2 + (w.kind === liked ? 1 : 0);
}

/**
 * (the variety work, round 1, track W: WEAR-1) at a ranged or magic fight's bank stop (RangedMagicTask, the bot at the
 * booth): the outfit follows the fight, whatever the bot's style. Ranged: the metal body and helm to the bank (3 in 10
 * keep a metal helm or platelegs: port/BotOutfits keepMetal), metal platelegs too when it owns chaps, and the ranger's
 * pieces it owns on (coif or cowl, leather to d'hide, chaps, vambraces). Magic: all metal to the bank (274's metal spoils
 * a spell's aim), its wizard hat, robe and skirt on. A signature hat stays on. Directly, as dressForSkill.
 */
export function dressForMode(player: Player, mode: 'ranged' | 'magic'): void {
    if (player.is_bot !== true || !isLevelling((player.botPlanner ?? '') as PlannerKey)) return;
    const worn = player.getInventory(InvType.WORN);
    const bank = bankOf(player);
    const inv = player.getInventory(InvType.INV);
    if (!worn || !bank) return;
    const metal = (pos: number): boolean => {
        const it = worn.get(pos);
        const piece = it ? armourPieceOf(it.id) : undefined;
        return !!piece && piece.tier >= 0;
    };
    const signature = wearsSignatureHat(player);
    // (a cook's chef's hat goes to the bank at a fight; the other style's hat, body and legs for this fight's, when it owns
    // this fight's: a ranger at a magic fight its wizard hat and robe, a mage at a ranged fight its coif and leather)
    if (strayChefsHat(player)) toBank(worn, 0, bank);
    // (the variety work, round 2, track W2: WEAR-4) a Wilderness fight: its rares and status pieces to the bank first
    if (wildernessTask(player)) stripForWilderness(player);
    const ownsAny = (ids: readonly number[]): boolean => ids.some(id => bank.getItemCount(id) > 0 || (inv?.getItemCount(id) ?? 0) > 0);
    const other = mode === 'ranged' ? isMagePiece : isRangerPiece;
    const these = mode === 'ranged' ? rangerWardrobe(player) : { ...mageWardrobe(player), 0: [...(mageWardrobe(player)[0] ?? []), wardrobeItems().wizardHat, wardrobeItems().blackWizardHat] };
    for (const pos of [0, 4, 7]) {
        const it = worn.get(pos);
        if (it && other(it.id) && !(pos === 0 && signature) && ownsAny(these[pos] ?? [])) toBank(worn, pos, bank);
    }
    if (mode === 'ranged') {
        const { ranged, defence } = levelsOf(player);
        const keep = rangerPieces(player.username, ranged, defence, isMembersWorld()).keepMetal;
        const wardrobe = rangerWardrobe(player);
        const owned = (pos: number): boolean => (wardrobe[pos] ?? []).some(id => bank.getItemCount(id) > 0 || (inv?.getItemCount(id) ?? 0) > 0);
        if (metal(4)) toBank(worn, 4, bank);
        if (metal(0) && keep !== 'helm' && !signature) toBank(worn, 0, bank);
        if (metal(7) && keep !== 'legs' && owned(7)) toBank(worn, 7, bank);
        if (metal(5)) toBank(worn, 5, bank);
        for (const pos of [0, 4, 7, 9, 10]) {
            if (pos === 0 && signature) continue;
            const current = worn.get(pos);
            // (vambraces over leather gloves at a ranged fight: the gloves to the bank)
            if (pos === 9 && current && current.id === wardrobeItems().gloves && owned(9)) toBank(worn, 9, bank);
            if (worn.get(pos)) continue;
            for (const id of wardrobe[pos] ?? []) if (putOn(worn, pos, id, bank, inv)) break;
        }
        return;
    }
    for (const pos of [0, 4, 7, 5]) if (metal(pos) && !(pos === 0 && signature)) toBank(worn, pos, bank);
    const w = wardrobeItems();
    const wardrobe = mageWardrobe(player);
    // (any bot: its wizard hat; a mage its own liking first)
    const hats = [...(wardrobe[0] ?? []), w.wizardHat, w.blackWizardHat];
    for (const [pos, ids] of [[0, hats], [4, wardrobe[4] ?? []], [7, wardrobe[7] ?? []]] as const) {
        if (pos === 0 && signature) continue;
        if (worn.get(pos)) continue;
        for (const id of ids) if (putOn(worn, pos, id, bank, inv)) break;
    }
}

/** (WEAR-5) does the bot wear metal armour (a helm, body, legs or shield of a metal)? */
export function wearsMetal(player: Player): boolean {
    const worn = player.getInventory(InvType.WORN);
    if (!worn) return false;
    for (const pos of [0, 4, 7, 5]) {
        const it = worn.get(pos);
        const piece = it ? armourPieceOf(it.id) : undefined;
        if (piece && piece.tier >= 0) return true;
    }
    return false;
}

/** (WEAR-3) a cook's chef's hat on, away from the range (not a chef's name or the joke's) */
function strayChefsHat(player: Player): boolean {
    const hat = player.getInventory(InvType.WORN)?.get(0);
    return !!hat && hat.id === wardrobeItems().chefsHat && !chefsHatAnywhere(player.username) && taskKindOf(player) !== 'Cook';
}

/**
 * (WEAR-1, WEAR-3) does a melee fight need its bank first for the outfit (CombatTask's first walk)? Better armour in the
 * bank (bankedArmourToWear), or a cook's chef's hat on.
 */
export function needsFightDress(player: Player): boolean {
    return bankedArmourToWear(player).length > 0 || (player.is_bot === true && (strayChefsHat(player) || needsWildernessStrip(player)));
}

/**
 * (WEAR-1) does the bot, before a ranged or magic fight, need its bank for the fight's outfit? Ranged: it wears a metal
 * body. Magic: it wears metal, or its hat slot is empty and a wizard hat is in its bank. Either: a cook's chef's hat.
 */
export function needsModeDress(player: Player, mode: 'ranged' | 'magic'): boolean {
    const worn = player.getInventory(InvType.WORN);
    if (!worn || player.is_bot !== true || !isLevelling((player.botPlanner ?? '') as PlannerKey)) return false;
    if (strayChefsHat(player) || needsWildernessStrip(player)) return true;
    const metal = (pos: number): boolean => {
        const it = worn.get(pos);
        const piece = it ? armourPieceOf(it.id) : undefined;
        return !!piece && piece.tier >= 0;
    };
    if (mode === 'ranged') return metal(4);
    if ([4, 7, 5].some(metal) || (metal(0) && !wearsSignatureHat(player))) return true;
    const w = wardrobeItems();
    return !worn.get(0) && [w.wizardHat, w.blackWizardHat].some(id => whereOwned(player, id) === 'bank');
}

/**
 * (WEAR-1, WEAR-6) at a melee fight's bank stop (CombatTask, after its armour and weapon): a slot of the helm, body or
 * legs that no metal it owns filled gets its style's piece (a mage's wizard hat, robe or skirt; a ranger's coif,
 * leather or chaps; a pirate's hat), not bare: the 2004 "wizard hat and plate". Directly, at the booth.
 */
export function dressForFight(player: Player): void {
    if (player.is_bot !== true || !isLevelling((player.botPlanner ?? '') as PlannerKey)) return;
    const worn = player.getInventory(InvType.WORN);
    const bank = bankOf(player);
    const inv = player.getInventory(InvType.INV);
    if (!worn || !bank) return;
    // (the variety work, round 2, track W2: WEAR-4, the wear track's R2) a Wilderness fight: its rares and status pieces to
    // the bank, the plain pieces it owns on (stripForWilderness)
    const wild = wildernessTask(player);
    if (wild) stripForWilderness(player);
    const style = levellingStyle(player);
    const o = outfitItems();
    const ranger = style === 'ranger' ? rangerWardrobe(player) : null;
    const mage = style === 'mage' ? mageWardrobe(player) : null;
    // (round 2, W2: WEAR-7) a members show hat (a clue hat, a Fremennik helm) where no helm went
    const shows = isMembersWorld() && !wild ? showHats() : [];
    for (const pos of [0, 4, 7]) {
        if (worn.get(pos)) continue;
        const ids = [...(mage?.[pos] ?? []), ...(ranger?.[pos] ?? []), ...(pos === 0 ? [...shows, o.pirateHat] : [])];
        for (const id of ids) if (putOn(worn, pos, id, bank, inv)) break;
    }
}

// ── the variety work, round 2, track W2: the rich at the hubs and before the Wilderness (the wear track's R2) ─────────

/** (WEAR-4) a piece a rich bot keeps out of the Wilderness: a rare, a holiday item, a status piece (trims, god, gilded) */
export function isShowPiece(itemId: number): boolean {
    if (itemId === -1) return false;
    return isSignatureHat(itemId) || itemId === wardrobeItems().scythe || statusPieceOf(itemId) !== undefined;
}

/** the location of the bot's task's activity (its fight's or skill's spot), or null */
function taskSpot(player: Player): readonly number[] | null {
    const task = (player as unknown as { _bot?: { currentTask?: { activityStep?: () => { location?: readonly number[] } | null } | null } })._bot?.currentTask;
    const loc = typeof task?.activityStep === 'function' ? task.activityStep()?.location : undefined;
    return loc && loc.length >= 2 ? loc : null;
}

/** (WEAR-4) is the bot's task's spot in the Wilderness? */
function wildernessTask(player: Player): boolean {
    const loc = taskSpot(player);
    return loc !== null && wildernessLevelAt(loc[0], loc[1]) > 0;
}

/**
 * (WEAR-4, the wear track's R2: "bank their rares before any Wilderness trip") does the bot wear a show piece (a rare, a
 * holiday item, a status piece) and go to the Wilderness: its task's spot there, or (`x`, `z`) given (a Wilderness trip's
 * destination: the activities track's)? Its bank first, as 2004's rich did.
 */
export function needsWildernessStrip(player: Player, x?: number, z?: number): boolean {
    const worn = player.getInventory(InvType.WORN);
    if (!worn || player.is_bot !== true) return false;
    const wild = x !== undefined && z !== undefined ? wildernessLevelAt(x, z) > 0 : wildernessTask(player);
    if (!wild) return false;
    for (let slot = 0; slot < worn.capacity; slot++) {
        const it = worn.get(slot);
        if (it && isShowPiece(it.id)) return true;
    }
    return false;
}

/**
 * (WEAR-4, R2) at the bank's booth before the Wilderness: every show piece it wears (a rare, the bunny ears, the scythe,
 * a status piece) to the bank, and in each slot the best plain piece it owns there that its Defence allows (a helm, a
 * body, legs, a shield; for the scythe its best melee weapon). Directly, as dressForSkill. Exported for a Wilderness
 * trip's bank stop (the activities track's).
 */
export function stripForWilderness(player: Player): void {
    const worn = player.getInventory(InvType.WORN);
    const bank = bankOf(player);
    const inv = player.getInventory(InvType.INV);
    if (!worn || !bank) return;
    const defence = player.baseLevels[PlayerStat.DEFENCE];
    const freed: number[] = [];
    for (let slot = 0; slot < worn.capacity; slot++) {
        const it = worn.get(slot);
        if (it && isShowPiece(it.id) && toBank(worn, slot, bank)) freed.push(slot);
    }
    for (const pos of freed) {
        if (pos === 3) {
            const best = bestMeleeWeapon(player, [bank]);
            if (best && (ObjType.get(best.id).wearpos2 !== 5 || !worn.get(5))) putOn(worn, 3, best.id, bank, null);
            continue;
        }
        let best: ArmourPiece | undefined;
        for (let slot = 0; slot < bank.capacity; slot++) {
            const it = bank.get(slot);
            const piece = it ? armourPieceOf(it.id) : undefined;
            if (!piece || piece.status || piece.tier < 0 || SLOT_WEARPOS[piece.slot] !== pos || !canWearPiece(piece, defence) || !usableOnThisWorld(piece.id)) continue;
            if (pos === 5 && twoHanded(player)) continue;
            if (!best || piece.tier > best.tier) best = piece;
        }
        if (best) putOn(worn, pos, best.id, bank, inv);
    }
}

/** (WEAR-4, R2) the trade hubs' banks within this many tiles of the booth a rich bot dresses up at */
const HUB_RANGE = 12;

/** (WEAR-4, R2) is the bot at the bank of a trade hub (port/BotTradeSpots TRADE_BANKS: Varrock West and East, Falador, Edgeville, Draynor, Al Kharid; members: Catherby, Seers, Ardougne)? */
export function atTradeHub(player: Player): boolean {
    return TRADE_BANKS.some(b => b.center[2] === player.level && Math.max(Math.abs(b.center[0] - player.x), Math.abs(b.center[1] - player.z)) <= HUB_RANGE);
}

/**
 * (WEAR-4, the wear track's R2: "rich bots put their best on at the trade hubs and the park") at a trade hub's bank stop
 * of a task that is no skill (a fight's, a shop trip's, a hang-out's, a show-off's: port/BotShowOff), a rich levelling bot
 * (port/BotFashion isRich) that dresses as a melee bot or a skiller (any, on a show-off visit: `showingOff`) puts on the status pieces it owns in the bank, each
 * over a plain piece of its slot (to the bank) or into an empty slot (on a show-off visit over a hat, an apron or a robe
 * too, not over a rare); never one its Defence cannot wear, never a helm over
 * a signature or show hat, never a shield with a two-hander, never on the way to the Wilderness. Directly, at the booth.
 */
export function dressForHub(player: Player, showingOff = false, arena = false): void {
    if (player.is_bot !== true || !isLevelling((player.botPlanner ?? '') as PlannerKey)) return;
    // (a show-off visit: any style puts its best on, the visit's purpose; at another bank stop a ranger or mage keeps its own)
    const style = levellingStyle(player);
    // (the fixes, B7: `arena`, at Fadli's bank on a Duel Arena visit: dressForArena)
    if ((!showingOff && (style === 'ranger' || style === 'mage')) || wildernessTask(player) || (!arena && !atTradeHub(player))) return;
    const worn = player.getInventory(InvType.WORN);
    const bank = bankOf(player);
    if (!worn || !bank || !isRich(player)) return;
    const defence = player.baseLevels[PlayerStat.DEFENCE];
    const best = new Map<number, ArmourPiece>();
    for (let slot = 0; slot < bank.capacity; slot++) {
        const it = bank.get(slot);
        const piece = it ? armourPieceOf(it.id) : undefined;
        if (!piece?.status || !canWearPiece(piece, defence) || !usableOnThisWorld(piece.id)) continue;
        const pos = SLOT_WEARPOS[piece.slot];
        const current = best.get(pos);
        if (!current || piece.tier > current.tier) best.set(pos, piece);
    }
    for (const [pos, piece] of best) {
        const on = worn.get(pos);
        if (pos === 0 && (wearsSignatureHat(player) || (on && showHats().includes(on.id)))) continue;
        if (pos === 5 && twoHanded(player)) continue;
        const onPiece = on ? armourPieceOf(on.id) : undefined;
        // (a hat, an apron, a robe: its own look stays at another bank stop; on a show-off visit its best goes on over it,
        // the skill's look back at its next skill's bank stop: dressForSkill. Not over a rare: that it shows already)
        if (on && !onPiece && (!showingOff || isShowPiece(on.id))) continue;
        if (onPiece && onPiece.tier >= piece.tier) continue;
        if (on && !toBank(worn, pos, bank)) continue;
        putOn(worn, pos, piece.id, bank, null);
    }
}

// ── the variety work, round 2, the fixes: B7 (the humanlike report's L6): the Duel Arena's bank ─────────────────────

/**
 * Does a rich levelling bot (port/BotFashion isRich) have a status piece in its bank that its Defence wears (one it owns:
 * a saved bot keeps its kit)? Its Duel Arena visit stops at Fadli's bank to put it on (tasks/DuelArenaTask: a watcher
 * banked only for its tomatoes' coins, so the rich watched the duels in their skilling clothes).
 */
export function hasStatusToWear(player: Player): boolean {
    if (player.is_bot !== true || !isLevelling((player.botPlanner ?? '') as PlannerKey) || wildernessTask(player)) return false;
    const bank = bankOf(player);
    if (!bank) return false;
    const defence = player.baseLevels[PlayerStat.DEFENCE];
    let found = false;
    for (let slot = 0; slot < bank.capacity && !found; slot++) {
        const it = bank.get(slot);
        const piece = it ? armourPieceOf(it.id) : undefined;
        found = piece?.status !== undefined && canWearPiece(piece, defence) && usableOnThisWorld(piece.id);
    }
    return found && isRich(player);
}

/**
 * At Fadli's bank on a Duel Arena visit (members): a rich bot puts its best on, any style, as on a show-off visit
 * (dressForHub's rules: only what it owns, never what its Defence cannot wear, never over a rare). The Duel Arena was where
 * late 2004's rich showed their trims and god armour; in the merged runs three of the six rich owners never seen in one
 * spent most of their time there.
 */
export function dressForArena(player: Player): void {
    dressForHub(player, true, true);
}

/**
 * port (phase 4): the armour pieces the bot owns in its bank that are better (by metal) than what it wears in their slot
 * and that its Defence allows, one per slot (the best): what a fight's bank trip takes out and puts on (CombatTask). No
 * helm when it wears a signature hat. port (the variety work, round 1, track W) and none when a ranger or mage keeps its
 * style's hat (keepsStyleHat), no shield for a bot that likes the two-handed sword and holds one
 */
export function bankedArmourToWear(player: Player): number[] {
    const worn = player.getInventory(InvType.WORN);
    const bank = bankOf(player);
    if (!worn || !bank) return [];
    const defence = player.baseLevels[PlayerStat.DEFENCE];
    const best = new Map<ArmourSlot, ArmourPiece>();
    // (the variety work, round 2, track W2) no status piece for a Wilderness fight (stripForWilderness)
    const wild = player.is_bot === true && wildernessTask(player);
    for (let slot = 0; slot < bank.capacity; slot++) {
        const it = bank.get(slot);
        const piece = it ? armourPieceOf(it.id) : undefined;
        if (!piece || piece.tier < 0 || (wild && piece.status) || !canWearPiece(piece, defence) || !usableOnThisWorld(piece.id)) continue;
        const current = best.get(piece.slot);
        if (!current || piece.tier > current.tier) best.set(piece.slot, piece);
    }
    const out: number[] = [];
    for (const [slot, piece] of best) {
        if (slot === 'helm' && (wearsSignatureHat(player) || keepsStyleHat(player))) continue;
        if (slot === 'shield' && twoHanded(player)) continue;
        const on = worn.get(SLOT_WEARPOS[slot]);
        // (the variety work, round 2, the fixes: a Wilderness trip's anti-dragon shield stays on: port/BotWildTrips)
        if (slot === 'shield' && on && isDragonShield(on.id)) continue;
        const onPiece = on ? armourPieceOf(on.id) : undefined;
        if (onPiece && onPiece.tier >= piece.tier) continue;
        out.push(piece.id);
    }
    return out;
}

/** (WEAR-2) a bot that likes the two-handed sword and owns one it can wield (no shield with it) */
function twoHanded(player: Player): boolean {
    if (weaponKindOf(player.username) !== '2h') return false;
    const best = bestMeleeWeapon(player, [player.getInventory(InvType.WORN), player.getInventory(InvType.INV), bankOf(player)]);
    return best?.kind === '2h';
}

// ── a clan's cape (the realism work, phase 5b, Track D: "clan walks in matching capes", port/BotClanWalk) ─────────

/** where the bot has this item: on, in its pack, in its bank; null: nowhere */
export function whereOwned(player: Player, itemId: number): 'worn' | 'pack' | 'bank' | null {
    if (itemId === -1) return null;
    const worn = player.getInventory(InvType.WORN);
    if (worn) for (let slot = 0; slot < worn.capacity; slot++) if (worn.get(slot)?.id === itemId) return 'worn';
    const inv = player.getInventory(InvType.INV);
    if (inv && inv.getItemCount(itemId) > 0) return 'pack';
    const bank = bankOf(player);
    return bank && bank.getItemCount(itemId) > 0 ? 'bank' : null;
}

/** Thessalia's (Varrock), where a clan's member without a cape buys a red one (274's clothes shop: 4 gp) */
export const CAPE_SHOP = WARDROBE_SHOPS.THESSALIA_CLOTHES.location;

/**
 * A red cape from Thessalia's for a clan walk (saved bots buy a red cape, 4 gp; they keep their looks
 * otherwise): its purchase, or null when the bot cannot pay for it (its pack and bank) or tried lately and failed.
 */
export function clanCapePurchase(player: Player): GearPurchase | null {
    const id = wardrobeItems().redCape;
    if (id === -1 || tripFailedRecently(player, id)) return null;
    const cost = estimate(id);
    return coinsOwned(player) >= cost ? { shopKey: 'THESSALIA_CLOTHES', itemId: id, cost } : null;
}

/**
 * The clan's cape on (a walk's start): from the pack, or (`fromBank`, the bot at its bank's booth) out of the bank, a
 * direct move as the bots' other bank moves (dressForSkill); the cape it wore goes where the new one was. True when it
 * wears it.
 */
export function wearClanCape(player: Player, itemId: number, fromBank = false): boolean {
    const worn = player.getInventory(InvType.WORN);
    if (!worn || itemId === -1 || !usableOnThisWorld(itemId)) return false;
    if (worn.get(1)?.id === itemId) return true;
    const from = fromBank ? bankOf(player) : player.getInventory(InvType.INV);
    if (!from || from.getItemCount(itemId) <= 0) return false;
    const current = worn.get(1);
    if (current) {
        if (from.add(current.id, current.count) < current.count) return false;
        worn.delete(1);
    }
    if (from.remove(itemId, 1) !== 1) {
        if (current) {
            from.remove(current.id, current.count);
            worn.set(1, current);
        }
        return false;
    }
    worn.set(1, { id: itemId, count: 1 });
    return true;
}
