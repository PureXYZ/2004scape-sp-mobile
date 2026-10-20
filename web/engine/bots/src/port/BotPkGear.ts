// PKer gear on a free world (Settings › World › Members off). Upstream's PKer and Edgeville PKer profiles
// (generateProfiles in both tasks) are members' gear: 27 of the 47 ids in their item table are members-only in the 274
// packs (blue, red and black d'hide, the amulet of glory, the god and Legends capes, dragon weapons, the magic
// shortbow, rune arrows, sharks and every super potion), and so is every pures' hat but the coif (berets, cavaliers,
// headbands, the highwayman mask). On a free world 274 takes a members item's
// ops away (no Wear, Eat or Drink) and its bonuses with them, so a free player can neither wear nor use one; the PK
// tasks put them on anyway (worn.set, past the wear script) and carried the rest. On a free world they pick from the
// profiles below instead: upstream's 30 pures and 30 mains with the same levels, in what a free player can wear at
// those levels (each id is checked against the 274 packs by test/pk.test.mjs). Rune armour from 40 Defence and
// adamant below it, a rune 2h sword (no shield) or a rune scimitar, a coif or leather cowl with a leather body or
// monk's robe, green d'hide chaps and vambraces, an amulet of strength or power, a plain cape, swordfish or lobsters
// and a strength potion. No special attack, bow or arrows: every special weapon of 2004 is members-only, as are all
// arrows above steel and all bows above oak.
//
// The PK tasks' equip helpers live here too (equipItem, regear and tryEquipFromInventory, identical in both upstream
// task files, which import them under those names), with the port's fixes in one place.
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import ParamType from '#/cache/config/ParamType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import type Player from '#/engine/entity/Player.js';
import { _wornContains, addItem, hasItem, interactHeldOp, refreshWorn, setVarp } from '#/engine/bot/BotAction.js';
import { moveItems } from '#/engine/bot/port/BotInventoryCompat.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { seededRandom } from '#/engine/bot/port/BotSeed.js';

/** Free-to-play PK items: 274 obj ids (test/pk.test.mjs checks each one's debugname and that it is not members). */
export const F2P_PK_ITEMS = {
    RUNE_SCIMITAR: 1333,
    RUNE_2H_SWORD: 1319,
    RUNE_FULL_HELM: 1163,
    RUNE_PLATEBODY: 1127,
    RUNE_PLATELEGS: 1079,
    RUNE_KITESHIELD: 1201,
    ADAMANT_FULL_HELM: 1161,
    ADAMANT_PLATEBODY: 1123,
    ADAMANT_PLATELEGS: 1073,
    ADAMANT_KITESHIELD: 1199,
    COIF: 1169,
    LEATHER_COWL: 1167,
    LEATHER_BODY: 1129,
    MONK_ROBE_TOP: 544,
    GREEN_DHIDE_CHAPS: 1099,
    GREEN_DHIDE_VAMBRACES: 1065,
    AMULET_OF_STRENGTH: 1725,
    AMULET_OF_POWER: 1731,
    LEATHER_BOOTS: 1061,
    RED_CAPE: 1007,
    BLACK_CAPE: 1019,
    BLUE_CAPE: 1021,
    YELLOW_CAPE: 1023,
    GREEN_CAPE: 1027,
    PURPLE_CAPE: 1029,
    ORANGE_CAPE: 1031,
    SWORDFISH: 373,
    LOBSTER: 379,
    STRENGTH_POTION4: 113,
    // port: the bow a free-world PKer switches to for a target that runs (port/BotPkTactics), and its arrows: the best a
    // free player has in 274 (its maple and willow bows and its arrows past steel are members items)
    OAK_SHORTBOW: 843,
    STEEL_ARROW: 886
} as const;

/** The shape of a PK task's profile (PKerTask and EdgevillePKerTask declare the same one). -1 = none. */
export interface PkProfile {
    name: string;
    atk: number;
    str: number;
    def: number;
    hp: number;
    range: number;
    pray: number;
    weapon: number;
    specWeapon: number;
    rangeWeapon: number;
    ammo: number;
    helm: number;
    body: number;
    legs: number;
    shield: number;
    neck: number;
    cape: number;
    boots: number;
    gloves: number;
    food: number;
    pots: number[];
    /**
     * port (PK tactics, 2026-10-19: port/BotPkFight pkKitted, set on every profile a PK task uses): its fight style
     * (`specWeapon` is then its KO weapon: a special's, or a free world's rune 2h), the arrows it wears at a restock, the
     * Magic level of its teleport spell, and its way out of the Wilderness
     */
    style?: 'melee' | 'ranged';
    ammoCount?: number;
    magic?: number;
    tele?: 'glory' | 'spell' | null;
}

/** The free world's profiles, built like upstream's generateProfiles (same level tables, so the same combat levels). */
export function freeWorldPkProfiles(): PkProfile[] {
    // port: the same tables at every start (seeded), so a PKer's build, picked by its name, never changes
    const rand = seededRandom(0x504b0003);
    const pickP = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
    const F = F2P_PK_ITEMS;
    const capes = [F.RED_CAPE, F.BLACK_CAPE, F.BLUE_CAPE, F.YELLOW_CAPE, F.GREEN_CAPE, F.PURPLE_CAPE, F.ORANGE_CAPE];
    const profiles: PkProfile[] = [];

    // pures: 60 Attack and 1 Defence, so nothing that needs Defence (the d'hide body needs 40)
    const strOpts = [60, 65, 70, 75, 80, 85, 90, 95, 99];
    const rangeOpts = [61, 65, 70, 75, 80, 85, 90, 99];
    const prayOpts = [1, 15, 31, 44, 52, 70];
    for (let i = 0; i < 30; i++) {
        const str = strOpts[i % strOpts.length]!;
        const range = rangeOpts[Math.floor(i / 3) % rangeOpts.length]!;
        const pray = prayOpts[Math.floor(i / 7) % prayOpts.length]!;
        const hp = Math.max(40, Math.min(99, 25 + Math.floor(str * 0.65)));
        profiles.push({
            name: `f2p-pure-${i}`,
            atk: 60, str, def: 1, hp, range, pray,
            weapon: i % 2 === 0 ? F.RUNE_2H_SWORD : F.RUNE_SCIMITAR,
            specWeapon: -1,
            rangeWeapon: F.OAK_SHORTBOW,
            ammo: F.STEEL_ARROW,
            helm: pickP([F.COIF, F.LEATHER_COWL]),
            body: i % 3 === 0 ? F.MONK_ROBE_TOP : F.LEATHER_BODY,
            legs: F.GREEN_DHIDE_CHAPS,
            shield: -1,
            neck: pickP([F.AMULET_OF_STRENGTH, F.AMULET_OF_POWER]),
            cape: pickP(capes),
            boots: F.LEATHER_BOOTS,
            gloves: F.GREEN_DHIDE_VAMBRACES,
            food: pickP([F.SWORDFISH, F.LOBSTER]),
            pots: [F.STRENGTH_POTION4]
        });
    }

    // mains: rune from 40 Defence, adamant below; a 2h sword leaves the shield slot empty
    const mainStrOpts = [65, 70, 75, 80, 85, 90, 95, 99];
    const mainDefOpts = [30, 40, 45, 50, 60, 65, 70, 80];
    const mainAtkOpts = [60, 65, 70, 75, 80, 85, 90, 99];
    for (let i = 0; i < 30; i++) {
        const atk = mainAtkOpts[i % mainAtkOpts.length]!;
        const str = mainStrOpts[Math.floor(i / 2) % mainStrOpts.length]!;
        const def = mainDefOpts[Math.floor(i / 3) % mainDefOpts.length]!;
        const hp = Math.max(50, Math.min(99, 35 + Math.floor((str + def) * 0.4)));
        const range = Math.max(50, Math.min(99, 40 + Math.floor(str * 0.5)));
        const pray = pickP([31, 44, 52, 60, 70]);
        const rune = def >= 40;
        const twoHanded = i % 2 === 0;
        profiles.push({
            name: `f2p-main-${i}`,
            atk, str, def, hp, range, pray,
            weapon: twoHanded ? F.RUNE_2H_SWORD : F.RUNE_SCIMITAR,
            specWeapon: -1,
            rangeWeapon: F.OAK_SHORTBOW,
            ammo: F.STEEL_ARROW,
            helm: rune ? F.RUNE_FULL_HELM : F.ADAMANT_FULL_HELM,
            body: rune ? F.RUNE_PLATEBODY : F.ADAMANT_PLATEBODY,
            legs: rune ? F.RUNE_PLATELEGS : F.ADAMANT_PLATELEGS,
            shield: twoHanded ? -1 : rune ? F.RUNE_KITESHIELD : F.ADAMANT_KITESHIELD,
            neck: pickP([F.AMULET_OF_POWER, F.AMULET_OF_STRENGTH]),
            cape: pickP(capes),
            boots: F.LEATHER_BOOTS,
            gloves: F.GREEN_DHIDE_VAMBRACES,
            food: pickP([F.SWORDFISH, F.LOBSTER]),
            pots: [F.STRENGTH_POTION4]
        });
    }
    return profiles;
}

/** May a bot wear, carry or use this item here? Anything on a members world; no members item on a free one. */
export function usableOnThisWorld(id: number): boolean {
    return id !== -1 && (isMembersWorld() || !ObjType.get(id).members);
}

/**
 * On a free world, takes every members item off the bot and out of its pack (gear a PKer was given on a members
 * world, kept in its save): into its bank, as a bot keeps its items, or gone if the bank has no room for it. Returns
 * the number of items moved or removed (0 on a members world).
 */
export function stripMembersItems(player: Player): number {
    if (isMembersWorld()) return 0;
    const bankId = InvType.getId('bank');
    const bank = bankId === -1 ? null : player.getInventory(bankId);
    let n = 0;
    for (const invId of [InvType.WORN, InvType.INV]) {
        const inv = player.getInventory(invId);
        if (!inv) continue;
        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item || !ObjType.get(item.id).members) continue;
            if (bank) moveItems(inv, bank, item.id, item.count);
            if (inv.get(slot)) inv.set(slot, null);
            n++;
        }
    }
    return n;
}

// ── The PK tasks' equip helpers (upstream's equipItem, regear and tryEquipFromInventory) ─────────────────────────────

function findSlot(inv: { get: (s: number) => { id: number } | null; capacity: number }, itemId: number): number {
    for (let s = 0; s < inv.capacity; s++) {
        const it = inv.get(s);
        if (it && it.id === itemId) return s;
    }
    return -1;
}

/** port: the wear script's [proc,wearpos_conflicts]: the two items share a worn position (a 2h weapon and a shield) */
function wearposConflict(a: ObjType, b: ObjType): boolean {
    const taken = [b.wearpos, b.wearpos2, b.wearpos3];
    return [a.wearpos, a.wearpos2, a.wearpos3].some(pos => pos !== -1 && taken.includes(pos));
}

/** Puts an item from the pack on: a weapon through the wear script when it can run, anything else directly. */
export function pkEquipItem(player: Player, itemId: number): void {
    // port: never a members item on a free world. 274 takes its Wear op away there, which only stops a client: the
    // wear script still puts it on, and the worn.set path below never checked anything
    if (!usableOnThisWorld(itemId)) return;
    if (_wornContains(player, itemId)) return;
    const inv = player.getInventory(InvType.INV);
    if (!inv) return;
    const slot = findSlot(inv, itemId);
    if (slot === -1) return;
    const oType = ObjType.get(itemId);
    // port: 274's wearpos is -1, not null, for an item that cannot be worn: upstream's `wearpos ?? wearpos2 ??
    // wearpos3` always gave wearpos, and its null check never held (such an item went into worn slot -1)
    const wearSlot = oType.wearpos;
    if (wearSlot === -1) return;
    if (wearSlot === 3) {
        // port (PK tactics, 2026-10-19): the second style, aggressive for a melee weapon (Strength: the max hit a PKer
        // wants) and rapid for a bow (274's rapid shortbow: a shot every 3 ticks); upstream's accurate (0) shot the
        // magic shortbow every 4 ticks
        setVarp(player, 'com_mode', 43, 1);
        // port: the wear script runs only with protected access (Player.runScript); without it interactHeldOp still
        // said yes and nothing was worn
        if (!player.delayed && !player.protect && interactHeldOp(player, inv, itemId, slot, 2)) {
            return;
        }
    }
    const worn = player.getInventory(InvType.WORN);
    if (!worn) return;
    const count = inv.get(slot)?.count ?? 1;
    const previous = worn.get(3)?.id ?? -1;
    inv.set(slot, null);
    // port: everything that shares a position with it comes off, as the wear script's ~unequip_conflicts does
    // (upstream took off only what was in its slot, so a 2h sword could go on over a shield)
    for (let s = 0; s < worn.capacity; s++) {
        const existing = worn.get(s);
        if (existing && wearposConflict(oType, ObjType.get(existing.id))) {
            // and a weapon taken off ends the special attack the bot had set (the wear script does so for a special
            // weapon): with the weapon slot left empty, 274's [proc,sa_enabled] reads the param of obj -1, a script
            // error on every attack
            if (s === 3) setVarp(player, 'sa_attack', 301, 0);
            worn.set(s, null);
            inv.add(existing.id, existing.count);
        }
    }
    worn.set(wearSlot, { id: itemId, count });
    // (the attack animation, max hit and style of the new weapon for its next hit, as the wear script sets them)
    refreshWorn(player, previous);
}

/** Puts on every piece of the profile's gear the bot does not wear yet (conjured if it is not in the pack). */
export function pkRegear(player: Player, p: PkProfile): void {
    for (const id of [p.weapon, p.helm, p.body, p.legs, p.shield, p.neck, p.cape, p.boots, p.gloves, p.ammo]) {
        if (!usableOnThisWorld(id)) continue; // port: none (-1), or a members item on a free world
        if (_wornContains(player, id)) continue;
        if (hasItem(player, id)) {
            pkEquipItem(player, id);
        } else {
            addItem(player, id, 1);
            pkEquipItem(player, id);
        }
    }
}

// ── The special attack (274's %sa_attack) ────────────────────────────────────────────────────────────────────────

/** port: is the weapon in hand one with a special attack (274's obj param specwep: the dragon dagger, the magic shortbow…)? */
export function wieldsSpecialWeapon(player: Player): boolean {
    const weapon = player.getInventory(InvType.WORN)?.get(3);
    const param = ParamType.getId('specwep');
    return !!weapon && param !== -1 && ObjType.get(weapon.id).params?.get(param) === 1;
}

/**
 * port: a special attack the bot set stays set only with a special weapon in hand. The PK tasks set %sa_attack
 * themselves (as a weapon's special bar does) and swap weapons through the wear script, whose swap leaves it set when
 * the special weapon goes back into the pack (only a weapon taken off, or one the wear script moves out of another
 * slot, clears it). With the weapon slot empty later (a death in the sims, where bots lose their items) every attack
 * ran 274's [proc,sa_enabled] on obj -1, a script error ("oc_param … Input was -1": 192 lines in a 2-hour aged run).
 * Called on every PK tick, before the engine's next attack.
 */
export function pkDropStaleSpecial(player: Player): void {
    const varp = VarPlayerType.getByName('sa_attack');
    if (!varp || player.getVar(varp.id) !== 1 || wieldsSpecialWeapon(player)) return;
    setVarp(player, 'sa_attack', 301, 0);
}

/** Puts the item on if it is in the pack; true if it is worn or was in the pack. */
export function pkTryEquipFromInventory(player: Player, weaponId: number): boolean {
    if (_wornContains(player, weaponId)) return true;
    const inv = player.getInventory(InvType.INV);
    if (!inv) return false;
    const slot = findSlot(inv, weaponId);
    if (slot === -1) return false;
    pkEquipItem(player, weaponId);
    return true;
}
