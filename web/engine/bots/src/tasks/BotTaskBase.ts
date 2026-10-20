/**
 * BotTaskBase.ts
 *
 * Shared imports, helpers, constants, and the abstract BotTask base class.
 * All task files import from here.
 */

import Player from '#/engine/entity/Player.js';
import Npc from '#/engine/entity/Npc.js';
import Loc from '#/engine/entity/Loc.js';
import InvType from '#/cache/config/InvType.js';
import { Inventory } from '#/engine/Inventory.js';
import {
    walkTo,
    interactNpc,
    interactNpcOp,
    interactLoc,
    interactLocOp,
    interactUseLocOp,
    interactUseObjNpcOp,
    botInteractUseObjNpc,
    findNpcByName,
    findNpcByNameExcluding,
    findNpcByPrefix,
    findNpcBySuffix,
    findLocByPrefix,
    findLocByPrefixWhere,
    findLocByName,
    findLocByNameWhere,
    hasItem,
    countItem,
    addItem,
    removeItem,
    isInventoryFull,
    getBaseLevel,
    PlayerStat,
    hasWaypoints,
    addXp,
    setCombatStyle,
    setAutocastWindStrike,
    setAutocastSpell,
    openNearbyGate,
    isAdjacentToLoc,
    botTeleport,
    interactHeldOp,
    interactIF_UseOp,
    isCrossing,
    crossingFare,
    walkLeft,
    waitedForBudgetSince,
    isOpeningDoor,
    closedGateBetween,
    tilesInSquare,
    carriesWebBlade,
    bankedWebBlade,
    locInRoute
} from '#/engine/bot/BotAction.js';
import { botPathToEntity, botReachedEntity, pathBudgetLeft } from '#/engine/bot/port/BotPathing.js';
import { isApproached } from '#/engine/GameMap.js';
import { Items, Shops, Locations, getProgressionStep, GRIMY_HERB_MAP, FOOD_IDS, PickaxesByLevel, dungeonRoute, Interfaces } from '#/engine/bot/BotKnowledge.js';
export { dungeonRoute };
import ObjType from '#/cache/config/ObjType.js';
import LocType from '#/cache/config/LocType.js';
import World from '#/engine/World.js';
import { usableOnThisWorld } from '#/engine/bot/port/BotPkGear.js';
import { isAllowedCoord, isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { moveItems, bankedId } from '#/engine/bot/port/BotInventoryCompat.js';
import { isMapBlocked, isZoneAllocated } from '#/engine/GameMap.js';
import type { SkillStep } from '#/engine/bot/BotKnowledge.js';
import { getMissingPurchases, STARTING_COINS } from '#/engine/bot/BotNeeds.js';
import type { Purchase } from '#/engine/bot/BotNeeds.js';
import type { BotTaskDebugInfo } from '#/engine/bot/debug/BotDebugTypes.js';
import { BotDebugService } from '#/engine/bot/debug/BotDebugService.js';
import { botReactionTicks, type ReactionKind } from '#/engine/bot/port/BotTiming.js';
import { dressForSkill } from '#/engine/bot/port/BotGear.js';
import { crossingFood, isElementalStaff, packFoodForTrip, packRunesFor } from '#/engine/bot/port/BotTeleport.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { claimLocTile, claimStandTile, claimWaitTile, releaseStandTile, stepToTile, usesLocFrom } from '#/engine/bot/port/BotTiles.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Ticks before assuming an interaction failed (no XP / no response). */
export const INTERACT_TIMEOUT = 20;

/** Teleport destination when a bot is hopelessly stuck. */
const SAFE_SPAWN: [number, number, number] = Locations.LUMBRIDGE_SPAWN;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function randInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * port (the realism work, phase 2): a person's pause, in ticks, before the bot acts again (port/BotTiming, its persona
 * times a draw): 'retarget' when what it worked ran out (a tree fell, a rock emptied, its NPC died: it clicks the next
 * one 1-3 s later, now and then much later), 'next' between two rounds of the same thing (the next fish on the range),
 * 'page' for a dialogue page. Upstream clicked again in the same tick, or on fixed 3-4-tick timers.
 */
export function humanDelay(player: Player, kind: ReactionKind): number {
    return botReactionTicks(player, kind);
}

/**
 * port (the realism work, phase 2): a person's pause after a target is lost, however it was lost (a kill, the game's own
 * retaliation, a stall emptied, a walk off it): observe() every tick, and no new click before `ready`. A task that clicks
 * the next target from several states (patrol, scan, a re-engage) holds them all to it.
 */
export class TargetPause {
    private had = false;
    private readyAt = 0;
    private readonly kind: ReactionKind;
    private readonly least: number;

    /**
     * `kind`: 'retarget' (a person's 1-3 s), or 'next' where the rounds would come in step (short fights), with `least`
     * ticks before it (the wide 'next' draws a tick or less a sixth of the time)
     */
    constructor(kind: ReactionKind = 'retarget', least = 0) {
        this.kind = kind;
        this.least = least;
    }

    observe(player: Player): void {
        if (this.had && player.target === null) this.readyAt = World.currentTick + this.least + humanDelay(player, this.kind);
        this.had = player.target !== null;
    }

    /** The task clicked something: a target the game is done with before the next observe() (a pickup, a pickpocket) */
    held(): void {
        this.had = true;
    }

    get ready(): boolean {
        return World.currentTick >= this.readyAt;
    }

    reset(): void {
        this.had = false;
        this.readyAt = 0;
    }
}

export function isNear(player: Player, x: number, z: number, dist: number, level = 0): boolean {
    return player.level === level && Math.abs(player.x - x) <= dist && Math.abs(player.z - z) <= dist;
}

/** Returns the bank inventory ID, or -1 if not loaded. */
export function bankInvId(): number {
    try {
        return InvType.getId('bank');
    } catch {
        return -1;
    }
}

/**
 * Teleport bot to Lumbridge spawn — used when stuck with no path forward.
 * Plays the magic teleport animation so other players see the cast effect.
 */
export function teleportToSafety(player: Player): boolean {
    const [x, z, level] = SAFE_SPAWN;
    return botTeleport(player, x, z, level, 'stuck');
}

/**
 * Teleport bot to (x, z, level). Defaults to level 0 (ground floor) because
 * all bot skill destinations and banks are on the ground floor — using
 * player.level caused bots on floor 2 to land inside roofs.
 */
export function teleportNear(player: Player, x: number, z: number, level = 0): boolean {
    return botTeleport(player, x, z, level, 'stuck');
}

/**
 * Return a stable per-bot jitter offset so different bots spread around a
 * shared destination instead of all walking to the exact same tile.
 *
 * Uses the player's slot number as a deterministic seed so the offset is
 * consistent for each bot across ticks (no per-tick re-randomisation).
 *
 * @param radius  Maximum tile offset in each axis (default 5).
 */
// ── Nearest-bank helper ───────────────────────────────────────────────────────

/**
 * All bot-accessible banks on the ground floor.
 * Lumbridge castle 2nd-floor bank is intentionally excluded — bots don't
 * climb stairs.  Al Kharid bank is included; the GATEWAY_REGIONS routing in
 * walkTo handles the gate automatically.
 */
const BOT_BANKS: ReadonlyArray<[number, number, number]> = [
    Locations.DRAYNOR_BANK,
    Locations.VARROCK_WEST_BANK,
    Locations.VARROCK_EAST_BANK,
    Locations.AL_KHARID_BANK,
    Locations.FALADOR_WEST_BANK,
    Locations.FALADOR_EAST_BANK,
    Locations.SEERS_BANK,
    Locations.EDGEVILLE_BANK,
    Locations.YANILLE_BANK,
    Locations.CATHERBY_BANK,
    Locations.ARDOUGNE_NORTH_BANK,
    Locations.ARDOUGNE_SOUTH_BANK,
    Locations.GNOME_NORTH_BANK,
    Locations.GNOME_SOUTH_BANK
];
/** (the variety work, round 2, the integrator's) the banks of members' land: never the nearest on a free world */
const MEMBERS_BANKS: ReadonlySet<readonly number[]> = new Set([Locations.SEERS_BANK, Locations.YANILLE_BANK, Locations.CATHERBY_BANK, Locations.ARDOUGNE_NORTH_BANK, Locations.ARDOUGNE_SOUTH_BANK, Locations.GNOME_NORTH_BANK, Locations.GNOME_SOUTH_BANK]);

/**
 * Returns the [x, z, level] tuple of the bank closest to the player's
 * current tile, using Chebyshev distance.  Tasks should call this once
 * per banking state entry rather than hard-coding a single bank.
 */
export function nearestBank(player: Player): [number, number, number] {
    return nearestBankTo(player.x, player.z);
}

/**
 * Returns the bank closest to an arbitrary coordinate — use this when the
 * relevant reference point is the skill activity location rather than where
 * the player currently stands (e.g. cooking range, furnace).
 */
export function nearestBankTo(x: number, z: number): [number, number, number] {
    // port (the variety work, round 1, track F): underground, by the place above it (a dungeon is 6400 tiles of z off the
    // map above: from the Edgeville dungeon's hill giants the "nearest" bank was Seers', its z the least far)
    if (z >= 6400) z -= 6400;
    // (the variety work, round 2, the integrator's) the rune essence mine (an instance, far north of the map) by the bank
    // its portal leads to, Varrock East by Aubury; and a free world's bank never in members' land: from the mine the
    // nearest was Seers', and a free world's bot was jumped toward it and back, 14-61 times a run (f100)
    if (x >= 2870 && x <= 2950 && z >= 4790 && z <= 4870) return Locations.VARROCK_EAST_BANK;
    const free = !isMembersWorld();
    let best = BOT_BANKS[0];
    let bestDist = Number.MAX_SAFE_INTEGER;
    for (const bank of BOT_BANKS) {
        if (free && MEMBERS_BANKS.has(bank)) continue;
        const dist = Math.max(Math.abs(x - bank[0]), Math.abs(z - bank[1]));
        if (dist < bestDist) {
            bestDist = dist;
            best = bank;
        }
    }
    return best;
}

// ── Hitpoints and food (port) ─────────────────────────────────────────────────

/**
 * port: the bot's current Hitpoints. Upstream's combat, ranged/magic and thieving tasks read player.stats[HITPOINTS],
 * which is the Hitpoints XP (×10, at least 11,540): it was never below any threshold, so no bot ever ate, fled or
 * stopped thieving at low health.
 */
export function currentHp(player: Player): number {
    return player.levels[PlayerStat.HITPOINTS];
}

/** port: the bot's Hitpoints level (its maximum when unhurt). */
export function maxHp(player: Player): number {
    return Math.max(1, player.baseLevels[PlayerStat.HITPOINTS]);
}

/** port: true when current Hitpoints are below this share of the maximum. */
export function hpBelow(player: Player, fraction: number): boolean {
    return currentHp(player) < maxHp(player) * fraction;
}

/**
 * port: the food a bot can eat on this world, best first. On a free world 274 takes a members item's Eat op and its
 * category away (ObjType.load), so the eat script ([opheld1,_category_*]) never runs for a shark: a bot that "ate"
 * one kept it and tried again for ever. Free-world food is swordfish and below.
 */
export function edibleFoodIds(): number[] {
    return FOOD_IDS.filter(usableOnThisWorld);
}

function countIn(inv: Inventory | null, ids: readonly number[]): number {
    if (!inv) return 0;
    let n = 0;
    for (let slot = 0; slot < inv.capacity; slot++) {
        const item = inv.get(slot);
        if (item && ids.includes(item.id)) n += item.count;
    }
    return n;
}

/** port: edible food in the pack. */
export function carriedFood(player: Player): number {
    return countIn(player.getInventory(InvType.INV), edibleFoodIds());
}

/** port: edible food in the bank. */
export function bankedFood(player: Player): number {
    const bid = bankInvId();
    return bid === -1 ? 0 : countIn(player.getInventory(bid), edibleFoodIds());
}

/** port: eats the best edible food in the pack (the game's eat script); false if there is none or the bot is busy. */
export function eatBestFood(player: Player): boolean {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return false;
    for (const foodId of edibleFoodIds()) {
        for (let slot = 0; slot < inv.capacity; slot++) {
            if (inv.get(slot)?.id === foodId) return interactHeldOp(player, inv, foodId, slot, 1);
        }
    }
    return false;
}

/**
 * port: tops the pack's edible food up to `target` from the bank, best food first (upstream withdrew sharks, then
 * any FOOD_IDS food: members food on a free world too). Returns how many it took out.
 */
export function withdrawFood(player: Player, target: number): number {
    const bid = bankInvId();
    const inv = player.getInventory(InvType.INV);
    const bank = bid === -1 ? null : player.getInventory(bid);
    if (!inv || !bank) return 0;
    let need = target - carriedFood(player);
    let taken = 0;
    for (const foodId of edibleFoodIds()) {
        if (need <= 0) break;
        const inBank = countIn(bank, [foodId]);
        if (inBank <= 0) continue;
        const moved = moveItems(bank, inv, foodId, Math.min(need, inBank));
        need -= moved;
        taken += moved;
    }
    return taken;
}

/**
 * port (the realism work, phase 5a; Track M fills it): before a long walk through monsters that hunt the bot (White
 * Wolf Mountain, port/BotDanger), it takes `count` pieces of food along at its bank stop. True when it carries that
 * many. Foundation stub: what it carries already.
 */
export function packTravelFood(player: Player, count: number): boolean {
    // port (Track M): at its bank (the trip's start: the bank stop) the food comes out, best first; elsewhere it has what
    // it carries (port/BotTeleport.packFoodForTrip: walkTo's crossing of the mountain packs it the same way)
    return packFoodForTrip(player, count);
}

/**
 * port (the realism work, phase 5a, Track M): at a task's bank stop, the runes for one teleport into the pack for a later
 * leg of its trip, from (fromX, fromZ) (where it will be: a shop) to (destX, destZ), when that leg would be a spell
 * (port/BotTeleport: a teleporter with the level and the runes; the leg qualifies). RangedMagic packs them for the walk
 * from Varrock's shops to its spot (its unseen jump went). The spell, or null.
 */
export function packTeleportRunes(player: Player, fromX: number, fromZ: number, destX: number, destZ: number): string | null {
    return packRunesFor(player, fromX, fromZ, destX, destZ);
}

// ── Tools (port) ──────────────────────────────────────────────────────────────

/** port: how many of an item the bank holds. */
export function bankCount(player: Player, itemId: number): number {
    const bid = bankInvId();
    return bid === -1 ? 0 : countIn(player.getInventory(bid), [itemId]);
}

/**
 * port: can the bot use this tool here? A pickaxe needs its Mining level (274's scripts pass over one the bot is too
 * low for: "You do not have a pickaxe which you have the Mining level to use"), an axe none (woodcut.rs2: "no wc req
 * in 2004"; the port's first version asked for one), and no members item on a free world.
 */
export function canUseTool(player: Player, itemId: number): boolean {
    if (!usableOnThisWorld(itemId)) return false;
    const pickaxe = PickaxesByLevel.find(t => t.itemId === itemId);
    if (pickaxe) return getBaseLevel(player, PlayerStat.MINING) >= pickaxe.levelReq;
    return true;
}

/**
 * port: a trip from here to (x, z) needs a fare it does not carry (the Karamja boat: BotAction.crossingFare) and the
 * bank has the rest: a bank trip first.
 */
export function fareShort(player: Player, x: number, z: number, level = 0): boolean {
    const fare = crossingFare(player.x, player.z, player.level, x, z, level);
    const carried = countItem(player, Items.COINS);
    return carried < fare && carried + bankCount(player, Items.COINS) >= fare;
}

/** port: at the bank, the fare there and back (crossingFare) from the bank's coins, as far as they go. */
export function withdrawFare(player: Player, x: number, z: number, level = 0): void {
    const short = crossingFare(player.x, player.z, player.level, x, z, level) - countItem(player, Items.COINS);
    const bid = bankInvId();
    const inv = player.getInventory(InvType.INV);
    const bank = bid === -1 ? null : player.getInventory(bid);
    if (short > 0 && inv && bank) moveItems(bank, inv, Items.COINS, Math.min(short, bankCount(player, Items.COINS)));
}

/** port: the first of `ids` that the bank holds and the bot can use, moved into the pack (a stackable: all of it). */
export function withdrawUsableTool(player: Player, ids: readonly number[]): boolean {
    const bid = bankInvId();
    const inv = player.getInventory(InvType.INV);
    const bank = bid === -1 ? null : player.getInventory(bid);
    if (!inv || !bank) return false;
    for (const id of ids) {
        if (!canUseTool(player, id)) continue;
        const n = bankCount(player, id);
        if (n <= 0) continue;
        if (moveItems(bank, inv, id, ObjType.get(id).stackable ? n : 1) > 0) return true;
    }
    return false;
}

// ── botJitter ─────────────────────────────────────────────────────────────────

/**
 * port (the variety work, round 1, the fixes): a step beyond a sticky web (extra.web: the Varrock sewers' moss giants,
 * behind the web at 3210,9898) wants a blade to cut it on the way (BotAction's walks cut it as they open a door): a
 * slashing weapon in hand (a scimitar, a sword, a battleaxe), else a knife or one in the pack, as 2004's mages and rangers
 * brought one. 'carried', 'banked' (its bank stop takes it: takeWebBlade), or 'none' (another spot). Any other step 'carried'.
 */
export function webBladeFor(player: Player, step: SkillStep): 'carried' | 'banked' | 'none' {
    if (!(step.extra as { web?: boolean } | undefined)?.web || carriesWebBlade(player)) return 'carried';
    const bid = bankInvId();
    return bankedWebBlade(player, bid === -1 ? null : player.getInventory(bid)) !== -1 ? 'banked' : 'none';
}

/** (the fixes) at the booth, for a step beyond a web: a blade from the bank into the pack (a knife first) when it carries none */
export function takeWebBlade(player: Player, step: SkillStep): void {
    if (webBladeFor(player, step) !== 'banked') return;
    const bid = bankInvId();
    const bank = bid === -1 ? null : player.getInventory(bid);
    const inv = player.getInventory(InvType.INV);
    const blade = bankedWebBlade(player, bank);
    if (bank && inv && blade !== -1) moveItems(bank, inv, blade, 1);
}

/**
 * port (the variety work, round 1, the fixes): underground, a jittered tile is one the place's own room reaches (a walk
 * from it that stays in the jitter's square). A dungeon's walls are thin, and past them lie other rooms and the map's
 * unused floor (around the Varrock sewers a walkable void of 51,000 tiles): of the tiles within 6 of the sewers' zombies,
 * skeletons and moss giants, a third to a half were across a wall. A walk to one went nowhere, a rescue jump landed on it,
 * and a bot shut in the void walked under the manhole's ladder and clicked it through the wall for good ("I can't reach
 * that!" 657 times in 2 hours, f100 s7). Kept a while by place (the jitter asks every tick of a walk).
 */
const jitterRooms = new Map<string, Set<number>>();
function _jitterRoom(level: number, x: number, z: number, radius: number): Set<number> {
    const key = `${level},${x},${z},${radius}`;
    let room = jitterRooms.get(key);
    if (!room) {
        room = tilesInSquare(level, x, z, radius);
        jitterRooms.set(key, room);
        if (jitterRooms.size > 256) jitterRooms.delete(jitterRooms.keys().next().value!);
    }
    return room;
}

/**
 * Prime-pair seeds used by botJitter's fallback sequence.
 * Each entry produces a different (jx, jz) spread for the same slot number.
 * Keeping them here as a constant avoids re-allocating the array every tick.
 */
const JITTER_SEEDS: ReadonlyArray<[mx: number, mz: number, bx: number, bz: number]> = [
    [7, 13, 3, 7],
    [11, 17, 5, 11],
    [19, 23, 7, 13],
    [29, 31, 11, 17],
    [37, 41, 13, 19]
];

export function botJitter(player: Player, x: number, z: number, radius = 5): [number, number] {
    const slot = (player as any).slot ?? 0;
    const level = player.level;
    const span = radius * 2 + 1;
    const room = z > 6400 ? _jitterRoom(level, x, z, radius) : null;

    // Try each deterministic seed in order until we land on a walkable tile.
    // Using the slot as the hash input keeps the result stable across ticks
    // (same bot always gets the same jittered destination for a given area).
    for (const [mx, mz, bx, bz] of JITTER_SEEDS) {
        const tx = x + ((slot * mx + bx) % span) - radius;
        const tz = z + ((slot * mz + bz) % span) - radius;
        if (isZoneAllocated(level, tx, tz) && !isMapBlocked(tx, tz, level) && (!room || room.has((tx << 14) | tz))) {
            return [tx, tz];
        }
    }

    // All offsets are blocked — return the base tile unchanged
    return [x, z];
}

// ── Abstract base ─────────────────────────────────────────────────────────────

export abstract class BotTask {
    readonly name: string;
    interrupted = false;
    protected cooldown = 0;
    protected rescanTimer = 0;

    protected constructor(name: string) {
        this.name = name;
    }

    abstract shouldRun(player: Player): boolean;
    abstract tick(player: Player): void;
    abstract isComplete(player: Player): boolean;

    /**
     * Optional structured diagnostics for the bot debugger. Tasks are not
     * required to implement this — BotDebugService falls back to reading a
     * `.state` field off the instance when it's absent. Override this on
     * tasks where richer diagnostics (target, destination, extra details)
     * are worth exposing. Never called from gameplay code, only from the
     * debug snapshot builder, and always wrapped in try/catch by the caller.
     */
    getDebugInfo?(player: Player): BotTaskDebugInfo;

    /**
     * port: the step the task works at, for what the bot says it is doing (port/BotActivity: "Cutting willows in
     * Draynor"); null for a task without one (an errand, a chat at the bank).
     */
    activityStep(): SkillStep | null {
        return null;
    }

    interrupt(): void {
        this.interrupted = true;
    }
    reset(): void {
        this.interrupted = false;
        this.cooldown = 0;
        this.rescanTimer = 0;
    }
}

// Re-export everything tasks need so they only import from this one file
export type { SkillStep } from '#/engine/bot/BotKnowledge.js';
export {
    Player,
    Npc,
    Loc,
    InvType,
    Inventory,
    walkTo,
    interactNpc,
    interactNpcOp,
    interactLoc,
    interactLocOp,
    interactUseLocOp,
    findNpcByName,
    findNpcByPrefix,
    findNpcBySuffix,
    findLocByPrefix,
    findLocByPrefixWhere,
    findLocByName,
    findLocByNameWhere,
    hasItem,
    countItem,
    addItem,
    removeItem,
    isInventoryFull,
    getBaseLevel,
    PlayerStat,
    hasWaypoints,
    addXp,
    setCombatStyle,
    setAutocastWindStrike,
    setAutocastSpell,
    Items,
    Shops,
    Locations,
    getProgressionStep,
    FOOD_IDS,
    getMissingPurchases,
    STARTING_COINS,
    openNearbyGate,
    isAdjacentToLoc,
    interactUseObjNpcOp,
    botInteractUseObjNpc,
    findNpcByNameExcluding,
    botTeleport
};
export type { WindSpellTier, ToolRequirement } from '#/engine/bot/BotKnowledge.js';
export { WIND_SPELLS, pickBestWindSpell, RangedBowsByLevel, bestRangedBow, RangedArrowsByCost, bestAffordableArrow } from '#/engine/bot/BotKnowledge.js';

// ── Shared banking helper ─────────────────────────────────────────────────────

/**
 * Drives the 'bank_walk' state for any gathering task.
 *
 * Priority order:
 *   1. Bank booth (bankbooth loc, op2 = Use-quickly → @openbank immediately, no dialog).
 *      Works at ALL banks.  Avoids NPC name ambiguity entirely.
 *   2. Banker NPC by prefix 'banker' (Lumbridge 2nd floor, Draynor, Varrock…).
 *   3. Banker NPC by prefix 'kharidbanker' (Al Kharid — debug name starts with 'kharid').
 *   4. Direct fallback: no interactive entity found but bot is already at the bank
 *      tile — proceed to deposit anyway (deposit functions work directly on
 *      inventory objects and do NOT require the bank UI to be open).
 *
 * Returns:
 *   'walk'   — still navigating, caller should return for this tick
 *   'ready'  — interaction queued (or fallback triggered), set cooldown + state
 *   'direct' — fallback: skip interaction, deposit immediately
 */
export function advanceBankWalk(
    player: Player,
    stuckDetector: StuckDetector,
    activityCoord?: [number, number, number],
): 'walk' | 'ready' | 'direct' {
    const [bx, bz, bl] = activityCoord
        ? nearestBankTo(activityCoord[0], activityCoord[1])
        : nearestBank(player);

    if (!isNear(player, bx, bz, 3, bl)) {
        // Still walking — drive bot all the way to the bank coord (which should be
        // inside the building) before the booth search activates.



        if (!stuckDetector.check(player, bx, bz)) {
            walkTo(player, bx, bz, bl);
        } else if (stuckDetector.desperatelyStuck) {
            teleportNear(player, bx, bz, bl);
            stuckDetector.reset();
            try {
                const bot = (player as any)._bot;
                if (bot?.name) BotDebugService.noteRecovery(bot.name, 'teleport');
            } catch {
                /* debug hook must never affect gameplay */
            }
        } else {
            // Clear existing (bad) waypoints so the hasWaypoints guard in
            // walkTo() doesn't block the detour recalculation.
            player.clearWaypoints();
            walkTo(player, bx + randInt(-4, 4), bz + randInt(-4, 4), bl);
        }
        return 'walk';
    }

    // ── At bank (inside): try booth first ────────────────────────────────────
    // Search radius 6 — large enough to find booths across the floor but small
    // enough not to reach through the walls of the building from outside.
    // The bot is already at the interior coord so no wall-pierce is possible.
    const booth = findLocByName(player.x, player.z, player.level, 'bankbooth', 6);
    if (booth) {
        if (!isNear(player, booth.x, booth.z, 1, booth.level)) {
            walkTo(player, booth.x, booth.z, booth.level);
            return 'walk';
        }
        interactLocOp(player, booth, 2); // op2 = Use-quickly → @openbank, no dialog
        dressForSkill(player); // port (the realism work, phase 4): no plate at a skill (port/BotGear)
        if (!noteBankVisit(player)) bankStopHook?.(player); // port (the variety work, round 1, track F): a second arrival in a row with nothing changed ends the task; else an alcher may alch (port/BotAlch)
        return 'ready';
    }

    // ── Fallback: banker NPC ──────────────────────────────────────────────────
    // Al Kharid bankers have debug names starting with 'kharidbanker', not 'banker'.
    const banker = findNpcByPrefix(player.x, player.z, player.level, 'banker', 10) ?? findNpcByPrefix(player.x, player.z, player.level, 'kharidbanker', 10);
    if (banker) {
        if (!isNear(player, banker.x, banker.z, 3, banker.level)) {
            walkTo(player, banker.x, banker.z, banker.level);
            return 'walk';
        }
        interactNpcOp(player, banker, 3); // op3 = Bank on standard bankers
        dressForSkill(player); // port (phase 4)
        if (!noteBankVisit(player)) bankStopHook?.(player); // port (variety round 1, F)
        return 'ready';
    }

    // ── Ultimate fallback: deposit without UI interaction ─────────────────────
    // Deposit functions use player.getInventory(bankInvId()) directly — no open
    // bank UI required.  Only reached if no booth or NPC is visible.
    dressForSkill(player); // port (phase 4)
    if (!noteBankVisit(player)) bankStopHook?.(player); // port (variety round 1, F)
    return 'direct';
}

/**
 * port (the variety work, round 1, track F: alchers at the banks, ISS-9): what a bot may do at a bank stop of its task
 * besides the task's own errand (advanceBankWalk's arrival at the booth): port/BotAlch registers its alchers' short stint
 * (a hook: BotAlch loads the tasks, which load this module).
 */
let bankStopHook: ((player: Player) => void) | null = null;
export function setBankStopHook(hook: ((player: Player) => void) | null): void {
    bankStopHook = hook;
}

// ── StuckDetector ─────────────────────────────────────────────────────────────

/**
 * Detects both stationary AND oscillating bots.
 *
 * Every WINDOW ticks, compares current distance-to-destination against the
 * snapshot taken WINDOW ticks ago. If the bot hasn't closed the gap by at
 * least MIN_PROGRESS tiles, it's considered stuck — regardless of whether it
 * was stationary or bouncing back and forth.
 */
export class StuckDetector {
    private readonly window: number;
    private readonly minProgress: number;
    private readonly freezeRadius: number;

    private ticks = 0;
    private snapshotDist = -1;
    private snapshotX = -1;
    private snapshotZ = -1;
    /** port: the destination the snapshot was taken for */
    private snapshotDestX = -1;
    private snapshotDestZ = -1;
    private escapeCount = 0;
    /** port: the walk's leg at the snapshot and what it had left (BotAction.walkLeft) */
    private snapshotLeg = '';
    private snapshotLeft = -1;
    /** port: the tick of the last check (a walk after a pause starts a new window) */
    private lastCheckTick = -1;

    private readonly escapeLimit: number;

    /**
     * @param windowTicks       How many ticks between progress checks
     * @param minProgressTiles  Minimum tiles of progress required per window
     * @param escapeLimit       Consecutive failed escape attempts before desperatelyStuck (default 3)
     * @param freezeRadius      If the bot hasn't moved more than this many tiles from its
     *                          snapshot position, skip straight to desperatelyStuck (default 3)
     */
    constructor(windowTicks = 40, minProgressTiles = 5, escapeLimit = 3, freezeRadius = 3) {
        this.window = windowTicks;
        this.minProgress = minProgressTiles;
        this.escapeLimit = escapeLimit;
        this.freezeRadius = freezeRadius;
    }

    /**
     * Call once per walk tick. Returns true when the bot is stuck.
     * If the bot hasn't moved more than freezeRadius tiles from its snapshot
     * position (oscillating or stationary), desperatelyStuck is set immediately
     * so the caller teleports without wasting ticks on detour attempts.
     */
    check(player: { x: number; z: number }, destX: number, destZ: number): boolean {
        // port: a toll gate's or a boat's crossing under way (the bot stands in its dialogue, then sails) is no stall
        if (isCrossing(player as Player)) {
            this.snapshotDist = -1;
            this.ticks = 0;
            return false;
        }
        // port: a new destination starts a new window. Upstream compared the distance to whatever destination it was
        // given now with a snapshot taken for an earlier one: a PKer on patrol, which picks its next point on arrival,
        // was "desperately stuck" (and teleported) while walking fine (test/sim.mjs, 71 of 89 such verdicts)
        if (this.snapshotDist >= 0 && Math.max(Math.abs(destX - this.snapshotDestX), Math.abs(destZ - this.snapshotDestZ)) > 3) {
            this.snapshotDist = -1;
            this.ticks = 0;
        }
        // port: and so does a walk after a pause (the bot picked flax, fletched): the snapshot was taken on its last
        // walk to the same bank, and a short trip back was "stuck" against it (Seers' willows and fletchers). A pause is
        // longer than half a window: a walk checked every third tick (a social bot's) is one walk
        const now = World.currentTick;
        // port (the variety work, round 1, track F: the login fill's jumps, ISS-1; the castle stairs, ISS-10): a walk that
        // stood still for the tick's path searches since the last check (BotAction.waitedForBudgetSince), or that is
        // getting a door open on its way, is no stall: the window waits for it (a stuck bot is still caught once it has
        // its searches: its own failed sweeps step it, they are not waits)
        const waited = this.lastCheckTick >= 0 && (waitedForBudgetSince(player as Player, this.lastCheckTick) || isOpeningDoor(player as Player));
        if (this.snapshotDist >= 0 && now - this.lastCheckTick > Math.max(5, this.window >> 1)) {
            this.snapshotDist = -1;
            this.ticks = 0;
        }
        this.lastCheckTick = now;
        if (this.snapshotDist < 0) {
            // Seed snapshot on very first call so the window starts immediately.
            const leg0 = walkLeft(player as Player, destX, destZ);
            this.snapshotLeg = leg0?.key ?? '';
            this.snapshotLeft = leg0?.left ?? -1;
            this.snapshotDist = Math.abs(player.x - destX) + Math.abs(player.z - destZ);
            this.snapshotX = player.x;
            this.snapshotZ = player.z;
            this.snapshotDestX = destX;
            this.snapshotDestZ = destZ;
        }
        if (waited) {
            stuckWaitStats.stuckChecks++;
            return false;
        }

        if (++this.ticks < this.window) return false;
        this.ticks = 0;

        const dist = Math.abs(player.x - destX) + Math.abs(player.z - destZ);
        let progress = this.snapshotDist - dist;
        const moved = Math.max(Math.abs(player.x - this.snapshotX), Math.abs(player.z - this.snapshotZ));
        // port: or along the walk's route: its leg's distance left fell, or the bot is on to the next leg (across a
        // gateway). Measured only to the destination, a climb over White Wolf Mountain was "desperately stuck"
        const leg = walkLeft(player as Player, destX, destZ);
        if (leg && this.snapshotLeft >= 0) {
            const along = leg.key === this.snapshotLeg ? this.snapshotLeft - leg.left : this.minProgress;
            progress = Math.max(progress, along);
        }
        if (leg) {
            this.snapshotLeg = leg.key;
            this.snapshotLeft = leg.left;
        }

        this.snapshotDist = dist;
        this.snapshotX = player.x;
        this.snapshotZ = player.z;

        // Bot hasn't left a 3-tile area — oscillating or frozen. Skip detours.
        if (moved <= this.freezeRadius) {
            this.escapeCount = this.escapeLimit;
            return true;
        }

        if (progress < this.minProgress) {
            this.escapeCount++;
            return true;
        }
        this.escapeCount = 0;
        return false;
    }

    /** True after escapeLimit+ failed escapes — teleport rather than detour. */
    get desperatelyStuck(): boolean {
        return this.escapeCount >= this.escapeLimit;
    }

    /** Read-only diagnostic snapshot for the bot debugger — never used by gameplay logic. */
    getDebugSnapshot(): { ticks: number; window: number; minProgress: number; snapshotDist: number; escapeCount: number; escapeLimit: number; desperatelyStuck: boolean } {
        return {
            ticks: this.ticks,
            window: this.window,
            minProgress: this.minProgress,
            snapshotDist: this.snapshotDist,
            escapeCount: this.escapeCount,
            escapeLimit: this.escapeLimit,
            desperatelyStuck: this.desperatelyStuck
        };
    }

    reset(): void {
        this.ticks = 0;
        this.snapshotLeg = '';
        this.snapshotLeft = -1;
        this.snapshotDist = -1;
        this.snapshotX = -1;
        this.snapshotZ = -1;
        this.escapeCount = 0;
    }
}

// ── ProgressWatchdog ──────────────────────────────────────────────────────────

/** port (the variety work, round 1, track F): the checks the budget waits and door openings held (tests, the report) */
export const stuckWaitStats = { stuckChecks: 0, watchdogChecks: 0 };
/** port (variety round 1, F: ISS-7): watchdogs that fired near the spot and ended the task instead of a jump */
export const watchdogStats = { endedNear: 0 };

/**
 * port (variety round 1, F: ISS-7): a levelling bot's main task (no sub-task runs: the watchdog is its task's) is
 * interrupted (BotPlayer picks another); true when it was. A vendor, a PKer or a sub-task keeps the jump as before.
 */
function endsNearSpot(player: Player): boolean {
    if (!isLevelling(player.botPlanner as PlannerKey)) return false;
    const ai = (player as unknown as { _bot?: { subTask?: BotTask | null; currentTask?: BotTask | null } })._bot;
    // (the variety work, round 2, Track D2: an errand's fight, tasks/ErrandTask's sub-task 'Combat:errand', ends as a task
    // does: the errand goes on with what it has. It was jumped onto the spot it stood at: a crowded farm's chickens, the
    // hill giants at 500 bots, 25 and 23 jumps a run)
    if (ai?.subTask && ai.currentTask && ai.subTask.name.endsWith(':errand')) {
        ai.subTask.interrupt();
        return true;
    }
    if (!ai || ai.subTask || !ai.currentTask) return false;
    // (a skill's task, one with a step: a bankstand or a chat at a hub earns no XP by design, and ended at its bank it was
    // picked again at once: one bot stood eleven stands of 2-10 minutes in a row)
    let step: SkillStep | null = null;
    try {
        step = ai.currentTask.activityStep();
    } catch {
        step = null;
    }
    if (!step) return false;
    ai.currentTask.interrupt();
    return true;
}

/**
 * XP-stall watchdog — measures real progress by XP gain, not by position.
 *
 * Counts ticks without a `notifyActivity()` call. If the stall exceeds the
 * limit the bot is teleported to safety. Banking states can be paused so a
 * legitimate bank trip doesn't trigger a false rescue.
 *
 * Usage in a task's tick():
 *   const banking = this.state === 'bank_walk' || this.state === 'bank_done';
 *   if (this.watchdog.check(player, banking)) { this.stuck.reset(); return; }
 *
 * When XP is gained:
 *   this.watchdog.notifyActivity();
 *
 * Why position-based detection doesn't work:
 *   A bot oscillating between (3210,3198) and (3230,3194) moves ~24 tiles
 *   every window, always appearing to make progress.
 */
export class ProgressWatchdog {
    private readonly limit: number;
    private stallTicks = 0;
    /** port: ticks in a row the caller paused it (a bank trip) */
    private pausedTicks = 0;
    /** port: where the bot was last tick, and ticks spent walking far from the destination */
    private lastX = -1;
    private lastZ = -1;
    private walkTicks = 0;
    /** port: the least distance left on each leg of the walk to the destination so far (BotAction.walkLeft) */
    private legBest = new Map<string, number>();

    /**
     * When set, the watchdog teleports here instead of Lumbridge on stall.
     * Set to the task's activity location so a rescued bot lands near its target.
     */
    get destination(): [number, number, number] | undefined {
        return this._follow?.() ?? this._destination;
    }
    set destination(where: [number, number, number] | undefined) {
        this._destination = where;
        this._follow = undefined;
    }
    private _destination?: [number, number, number];
    private _follow?: () => [number, number, number] | undefined;

    /**
     * port: the destination is wherever this says, now (the task's current step). Upstream set it once in the
     * constructor: after a re-roll or a level-up step a rescued bot went back to the first spot (a miner sent from
     * Rimmington to Varrock West every 302 ticks).
     */
    follow(where: () => [number, number, number] | undefined): void {
        this._follow = where;
    }

    /** port: true when the last check fired (a stall), whether or not the rescue jump could happen */
    fired = false;

    /**
     * @param stallTickLimit  Ticks without XP before teleport (default 100 ≈ 1 min).
     *                        Short enough to rescue stuck bots quickly, but long enough
     *                        to cover legitimate bank trips and mid-walk delays.
     */
    constructor(stallTickLimit = 300) {
        this.limit = stallTickLimit;
    }

    /** Call when XP was gained. Resets the stall counter. */
    notifyActivity(): void {
        this.stallTicks = 0;
    }

    /**
     * Call every tick. Pass `paused=true` when the task is in a banking state
     * to avoid triggering during legitimate bank trips.
     *
     * Returns true if the bot stalled (task should call reset() and return); it was moved to its destination if no
     * human could see (botTeleport).
     *
     * port: a walk that gets somewhere is not a stall. Upstream counted every tick but the bank trips, so a walk of
     * more than the limit to a far spot always fired: a fighter teleported to its spot mid-walk, about every 150 ticks
     * (test/sim.mjs). Ticks moving away from the destination count one in four (a walk that loops for ever still
     * fires, later), ticks standing still or at the spot count fully, and a pause (a bank trip) longer than
     * MAX_PAUSE counts again: a task that never left its bank states never fired (members thieving).
     */
    check(player: Player, paused = false): boolean {
        this.fired = false;
        this.endedNear = false;
        // port: nor for the watchdog (see StuckDetector.check)
        if (isCrossing(player)) paused = true;
        const moved = this.lastX !== -1 && (player.x !== this.lastX || player.z !== this.lastZ);
        this.lastX = player.x;
        this.lastZ = player.z;
        // port (the variety work, round 1, track F: ISS-1): a walk that stood still for the path budget since the last
        // check is no stall
        const now = World.currentTick;
        const waited = this.lastCheck >= 0 && waitedForBudgetSince(player, this.lastCheck);
        this.lastCheck = now;
        if (waited) {
            stuckWaitStats.watchdogChecks++;
            return false;
        }
        if (paused && ++this.pausedTicks < ProgressWatchdog.MAX_PAUSE) return false;
        if (!paused) this.pausedTicks = 0;
        if (moved && this._farFromDestination(player)) {
            // port: nearer along its route than ever on this leg (over a hill, round a wall) is no stall at all: a
            // fighter walking 200 tiles to its spot was jumped there once earlier idle ticks added up. A walk that
            // loops sets no new best, and counts one tick in four
            const dest = this.destination;
            const leg = dest && player.level === dest[2] ? walkLeft(player, dest[0], dest[1], 16) : null;
            if (leg && leg.left < (this.legBest.get(leg.key) ?? Infinity)) {
                this.legBest.set(leg.key, leg.left);
                if (this.legBest.size > 16) this.legBest.delete(this.legBest.keys().next().value!);
                return false;
            }
            if (++this.walkTicks % 4 !== 0) return false;
        }
        if (++this.stallTicks < this.limit) return false;
        // port (the variety work, round 1, track F: ISS-7): a levelling bot within 15 tiles of its spot with nothing coming
        // of it (a crowded spawn, a full mine) moves on as a player there does: its task ends and the planner picks again.
        // It was jumped 3-10 tiles to "its spot", where it already was (unseen, pointless, its task reset)
        if (this.destination && !this._farFromDestination(player) && endsNearSpot(player)) {
            watchdogStats.endedNear++;
            this.reset();
            this.fired = true;
            this.endedNear = true;
            return true;
        }
        if (this.destination) {
            const [x, z, level] = this.destination;
            botTeleport(player, x, z, level, 'watchdog');
        } else {
            teleportToSafety(player);
        }
        this.reset();
        this.fired = true;
        return true;
    }

    /** port (variety round 1, F): true when the last check fired near the spot and ended the task (no jump) */
    endedNear = false;
    /** port (variety round 1, F): the tick of the last check (the budget waits since are left out) */
    private lastCheck = -1;

    /** port: a pause (bank trip) longer than this counts as a stall again */
    static readonly MAX_PAUSE = 600;

    private _farFromDestination(player: Player): boolean {
        if (!this.destination) return true;
        const [x, z, level] = this.destination;
        return player.level !== level || Math.max(Math.abs(player.x - x), Math.abs(player.z - z)) > 15;
    }

    reset(): void {
        this.stallTicks = 0;
        this.pausedTicks = 0;
        this.walkTicks = 0;
        this.legBest.clear();
    }
}

/**
 * Cleans any grimy herbs in the player's inventory and awards Herblore XP.
 * Call this just before banking so cleaned herbs are banked instead of grimy ones.
 * port: through each herb's own op (274's Identify), which checks the world and the Herblore level and gives the XP;
 * upstream swapped them itself, at any level and on free worlds. A herb above the bot's level is banked as it is
 */
export function cleanGrimyHerbs(player: Player): void {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return;
    const level = getBaseLevel(player, PlayerStat.HERBLORE);
    for (let slot = 0; slot < inv.capacity; slot++) {
        const item = inv.get(slot);
        if (!item) continue;
        const entry = GRIMY_HERB_MAP[item.id];
        if (!entry || level < entry[2]) continue;
        interactHeldOp(player, inv, item.id, slot, 1);
    }
}

/** port: the stock of the shop the bot has open (the inventory its main interface shows), or null */
export function openShopStock(player: Player): Inventory | null {
    const listener = player.invListeners.find(l => l.com === Interfaces.SHOP_INV);
    return listener ? player.getInventoryFromListener(listener) : null;
}

/**
 * port: buys 1, 5 or 10 (the most up to `count`: 274's shop_template buttons 2-4) of `itemId` from the shop the bot
 * has open, through its interface: the game takes the coins at its own price and the item from its stock (upstream
 * took the coins its table said and made the item, sold out or not). False when the shop has none of it now.
 */
export function buyFromOpenShop(player: Player, itemId: number, count: number): boolean {
    const stock = openShopStock(player);
    if (!stock) return false;
    for (let slot = 0; slot < stock.capacity; slot++) {
        const it = stock.get(slot);
        if (!it || it.id !== itemId || it.count <= 0) continue;
        return interactIF_UseOp(player, Interfaces.SHOP_INV, itemId, slot, count >= 10 ? 4 : count >= 5 ? 3 : 2);
    }
    return false;
}

/**
 * port: sells 10 (274's shop_template_side button 4) of `itemId` from the pack to the shop the bot has open, through
 * its interface: the game pays its own price and refuses what the shop will not take. False when the pack has none or
 * no shop is open.
 */
export function sellToOpenShop(player: Player, itemId: number, op: 2 | 3 | 4 = 4): boolean {
    if (!openShopStock(player)) return false;
    const inv = player.getInventory(InvType.INV);
    if (!inv) return false;
    // (the variety work, round 2, the fixes: `op`, the side inventory's button: 274's shop.rs2 sells 1, 5 or 10 (ops 2-4))
    for (let slot = 0; slot < inv.capacity; slot++) {
        if (inv.get(slot)?.id === itemId) return interactIF_UseOp(player, Interfaces.SHOP_SIDE_INV, itemId, slot, op);
    }
    return false;
}

/**
 * port: clicks option `op` (3 = make 10 in 274's making interfaces) on `product` in an interface the bot has open:
 * an anvil's smithing interface, the furnace's jewellery one. False when none of its open inventories shows it.
 */
export function pressInterfaceProduct(player: Player, product: number, op = 3): boolean {
    for (const listener of player.invListeners) {
        const inv = player.getInventoryFromListener(listener);
        if (!inv) continue;
        for (let slot = 0; slot < inv.capacity; slot++) {
            if (inv.get(slot)?.id === product) return interactIF_UseOp(player, listener.com, product, slot, op);
        }
    }
    return false;
}

/**
 * True if the inventory holds anything other than coins or an item in
 * keepIds (tools, an in-flight consumable). Used by gathering tasks to spot
 * leftover junk from a previous task — a leftover pickaxe, ore, loot, etc. —
 * before heading out to a fresh location, so the bot banks it first instead
 * of carrying dead weight around for an entire trip.
 */
export function hasStrayItems(player: Player, keepIds: number[]): boolean {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return false;
    for (let slot = 0; slot < inv.capacity; slot++) {
        const item = inv.get(slot);
        if (!item) continue;
        if (item.id === Items.COINS) continue;
        // port (the realism work, phase 5a, Track M): a teleport's runes and staff, an alcher's natures (as coins: a
        // cast that did not happen left them; the leg of a trip they were packed for comes later). As stray items they
        // sent a task back to its bank from its walk, for good (MiningTask's walk state)
        if (MAGIC_KEPT.has(item.id) || isElementalStaff(item.id)) continue;
        // port (phase 5a): a random event's lamp or strange box until the bot uses it (port/RandomEventTask: it does so
        // before a bank; 274 will not bank the lamp), and the food packed for White Wolf Mountain while that trip is under
        // way (port/BotTeleport.crossingFood: banked again, the bot crossed the wolves without it)
        if (eventItems().has(item.id)) continue;
        if (FOOD_IDS.includes(item.id) && crossingFood(player)) continue;
        if (keepIds.includes(item.id)) continue;
        return true;
    }
    return false;
}

let eventItemIds: Set<number> | null = null;
/** port (phase 5a): a random event's items a bot carries until it uses them: the genie's lamp, the strange box */
function eventItems(): Set<number> {
    if (!eventItemIds) eventItemIds = new Set([ObjType.getId('macro_genilamp'), ObjType.getId('macro_cube')].filter(id => id !== -1));
    return eventItemIds;
}

/** port (phase 5a): what a bot carries for its spells, never stray (hasStrayItems) */
const MAGIC_KEPT: ReadonlySet<number> = new Set([Items.LAW_RUNE, Items.AIR_RUNE, Items.WATER_RUNE, Items.EARTH_RUNE, Items.FIRE_RUNE, Items.NATURE_RUNE]);

// ── NPC claim registry (port) ────────────────────────────────────────────────
//
// One for every fighting task, melee (CombatTask) and ranged or magic (RangedMagicTask), keyed by the NPC's nid (its
// slot in World.npcs, the same while it is in the world). Upstream's RangedMagicTask kept a set of its own, keyed by
// the NPC's position, which no longer matched once the NPC moved: a ranger and a fighter, or two rangers, took the
// same NPC.
export const CLAIMED_NPCS = new Set<number>();

/** port: is the NPC claimed by a fighting bot? */
export function isNpcClaimed(npc: Npc): boolean {
    return npc.nid >= 0 && CLAIMED_NPCS.has(npc.nid);
}

// ── Loc claim registry ───────────────────────────────────────────────────────
//
// Trees/rocks have no per-bot "target" field the way NPCs do (CombatTask uses
// npc.target to detect an NPC already being fought), so without this, every
// bot searching from roughly the same spot deterministically finds the exact
// same nearest tree/rock — findLocByPrefix always returns the single closest
// match. Multiple bots then converge on one resource, block each other from
// the one reachable adjacent tile, and cycle approach-timeout/retry forever,
// which from the outside looks like bots "stuck" standing next to a tree.
//
// Mirrors CombatTask's CLAIMED_NPCS pattern, but for Locs.
const CLAIMED_LOCS = new Set<string>();

function _locKey(loc: Loc): string {
    return `${loc.level}:${loc.x}:${loc.z}`;
}

/** Register a Loc as claimed so other bots' searches skip it. */
export function claimLoc(loc: Loc): void {
    CLAIMED_LOCS.add(_locKey(loc));
}

/** Release a previously-claimed Loc (felled/depleted, task reset, moved on). */
export function releaseLoc(loc: Loc | null): void {
    if (loc) CLAIMED_LOCS.delete(_locKey(loc));
}

export function isLocClaimed(loc: Loc): boolean {
    return CLAIMED_LOCS.has(_locKey(loc));
}

/**
 * port (the variety work, round 1, the fixes): a tree (or rock) the bot found it cannot get to (across a wall or fence
 * from it, no route there): passed over by its picks for OUT_OF_REACH_TICKS. A bot by the members' fence east of Varrock
 * picked the trees past it, the nearest, again and again
 */
const outOfReach = new WeakMap<Player, Map<string, number>>();
const OUT_OF_REACH_TICKS = 1000;
export function noteOutOfReach(player: Player, loc: Loc): void {
    let m = outOfReach.get(player);
    if (!m) outOfReach.set(player, (m = new Map()));
    m.set(_locKey(loc), World.currentTick + OUT_OF_REACH_TICKS);
    if (m.size > 32) m.delete(m.keys().next().value!);
}
/** (the fixes) is this loc one the bot found out of its reach lately (noteOutOfReach), or in a members' area on a free world? */
export function outOfReachFor(player: Player, loc: Loc): boolean {
    if (!isAllowedCoord(loc.x, loc.z)) return true;
    const until = outOfReach.get(player)?.get(_locKey(loc));
    return until !== undefined && until > World.currentTick;
}

/** port (the variety work, round 2, the fixes): the ticks of an approach to a tree before its route is asked (approachVerdict) */
export const APPROACH_TICKS = 30;
/** port (the variety work, round 2, the fixes): the most rounds of APPROACH_TICKS a tree a route reaches is walked to */
const APPROACH_ROUNDS = 4;

/**
 * port (the variety work, round 2, the fixes): an approach to a tree ran APPROACH_TICKS (its `rounds` before, the rounds
 * already walked on): 'walk' on for another round, 'wait' (no path search left this tick: asked again next tick) or 'out'
 * (out of its reach: noteOutOfReach, another tree). Out only when no route reaches it now (BotAction.locInRoute: the
 * game's reach, doors as they are), or after APPROACH_ROUNDS rounds all the same. Round 1's rule marked every tree out of
 * reach after 30 ticks whatever the way: Draynor's west willows from its bank are a walk north round a fence and back,
 * 30-odd tiles, and a willow cutter had all six marked for 1000 ticks and stood by them, all standing, for 334 ticks (the
 * aged free world, seed 1).
 */
export function approachVerdict(player: Player, loc: Loc, rounds: number): 'walk' | 'wait' | 'out' {
    if (rounds + 1 >= APPROACH_ROUNDS) return 'out';
    const way = locInRoute(player, loc);
    return way === 'yes' ? 'walk' : way === 'wait' ? 'wait' : 'out';
}

/**
 * port (the variety work, round 2, the fixes): the tile a woodcutter walks to for `tree`: of the tiles it chops it from
 * (the game's reach: BotTiles.usesLocFrom) and can stand on, the nearest; null: none. The tasks worked the nearest face's
 * tile out from the bot's side alone, a 2×2 tree assumed, and it was often a tile of the tree beside it (Draynor's west
 * willows stand side by side): a walk to a blocked tile, which the walking graph took round Draynor and back, 120 ticks a
 * tree (the aged free world, seed 1).
 */
export function treeApproachTile(player: Player, tree: Loc): [number, number] | null {
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (let tx = tree.x - 1; tx <= tree.x + tree.width; tx++) {
        for (let tz = tree.z - 1; tz <= tree.z + tree.length; tz++) {
            if (!isZoneAllocated(tree.level, tx, tz) || isMapBlocked(tx, tz, tree.level) || !usesLocFrom(tree, tx, tz)) continue;
            const d = Math.max(Math.abs(tx - player.x), Math.abs(tz - player.z));
            if (d < bestD) {
                bestD = d;
                best = [tx, tz];
            }
        }
    }
    return best;
}

// ── Waiting at a taken resource (port: the variety work, round 1, track F; DO-3) ─────────────────────────────────

/**
 * port (variety round 1, F): what the gatherers did with nothing free, by task kind: ticks of the task, ticks waiting
 * beside a taken rock or tree (ResourceWait), ticks walking about with no target (the old random walk: the humanlike
 * report's AM6, 23.5-34 % of miners' ticks before), waits given up (the task ended)
 */
export const gatherStats = { ticks: {} as Record<string, number>, wait: {} as Record<string, number>, wander: {} as Record<string, number>, waits: 0, gaveUp: 0, said: 0, pokes: 0, moves: 0 };

/** a gatherer task's tick (gatherStats), and whether it walks about with no target this tick (AM6) */
export function noteGatherTick(kind: string, wandering: boolean): void {
    gatherStats.ticks[kind] = (gatherStats.ticks[kind] ?? 0) + 1;
    if (wandering) gatherStats.wander[kind] = (gatherStats.wander[kind] ?? 0) + 1;
}

/** how long a bot waits for a taken resource before it moves on (2-4 minutes) */
export const RESOURCE_PATIENCE: readonly [number, number] = [200, 400];
/** the chance it says so ('rock-stolen', 'tree-taken' through BotChatter.noteEvent, which rolls its persona's chance too) */
const GIVE_UP_LINE = 0.5;
/** a waiting miner prospects the rock it waits by every this many ticks (the first sooner) */
const POKE_TICKS: readonly [number, number] = [40, 90];
/** port (variety round 1, F): a fisher waits for a spot this long (spots move on their own: it looks along the shore soon) */
export const FISH_PATIENCE: readonly [number, number] = [100, 200];

/**
 * port (the variety work, round 1, track F: no pacing at a taken resource, DO-3): with nothing free (every rock of its
 * ore mined out or worked, every tree felled or chopped) a gatherer waits as a player does: on a tile of its own beside
 * the nearest taken one (BotTiles: one it would work it from, else a step off), facing it, and looks again a person's
 * moment later (BotTiming 'retarget': 274 respawns rocks and trees in seconds to a minute). After 2-4 minutes still
 * crowded it gives up now and then with a word ('rock-stolen', 'tree-taken') and its task ends: the planner picks again.
 * Upstream walked to a random tile within 5 of the spot every 4 ticks (miners 11 ticks for trees): 23.5-34 % of a
 * miner's ticks at a busy mine were pacing.
 */
export class ResourceWait {
    private since = -1;
    private patience = 0;
    private nextCheck = 0;
    private tile: [number, number] | null = null;
    private beside: { x: number; z: number } | null = null;
    private besideLoc: Loc | null = null;
    /** a look round asked (the poke found nothing to do): the caller's pick goes to another, not `besideLoc` */
    private moveOn = false;
    private lastFace = -1;
    private nextPoke = -1;
    /** the wait ran out: the task ends (the caller's isComplete) */
    done = false;
    private readonly kind: string;
    private readonly patienceTicks: readonly [number, number];
    private readonly poke: ((player: Player, loc: Loc) => boolean) | null;

    /**
     * `patience`: how long it waits (ticks); `poke`: what it does with the one it waits by now and then (a miner prospects
     * the rock another miner works: "This rock contains tin.", as players did while they waited); false: nothing to do
     * with it (a mined-out rock): it moves round to another, as with no poke
     */
    constructor(kind: string, patience: readonly [number, number] = RESOURCE_PATIENCE, poke: ((player: Player, loc: Loc) => boolean) | null = null) {
        this.kind = kind;
        this.patienceTicks = patience;
        this.poke = poke;
    }

    /** waiting now (nothing free since `since`) */
    get waiting(): boolean {
        return this.since >= 0;
    }

    /** the loc it waits by now (the caller keeps it between looks: a person stays put), or null */
    get current(): Loc | null {
        return this.besideLoc;
    }

    /** a look round asked: the caller picks another than `current` (a few steps to the next taken one) */
    get movingOn(): boolean {
        return this.moveOn;
    }

    /** between two looks: the caller does not scan yet */
    holding(): boolean {
        return this.since >= 0 && World.currentTick < this.nextCheck;
    }

    /**
     * Nothing free this look: stand beside `taken` (the nearest rock or tree that is empty or worked; null: where it is,
     * near the spot) facing it, the next look a person's moment from now. `say`: its word when it gives up.
     */
    none(player: Player, taken: Loc | null, say: () => void): void {
        const now = World.currentTick;
        if (this.since < 0) {
            this.since = now;
            this.patience = randInt(this.patienceTicks[0], this.patienceTicks[1]);
            this.tile = null;
            this.beside = null;
            this.nextPoke = now + randInt(POKE_TICKS[0] >> 1, POKE_TICKS[1] >> 1);
            gatherStats.waits++;
        }
        gatherStats.wait[this.kind] = (gatherStats.wait[this.kind] ?? 0) + 1;
        if (now - this.since >= this.patience) {
            this.done = true;
            gatherStats.gaveUp++;
            if (Math.random() < GIVE_UP_LINE) {
                gatherStats.said++;
                say();
            }
            this.release(player);
            return;
        }
        this.nextCheck = now + 1 + humanDelay(player, 'retarget');
        if (taken && (!this.beside || this.beside.x !== taken.x || this.beside.z !== taken.z)) {
            // (the fixes: after a look round, the next a while after this one, counted from now: a pick that came late
            // left the old time passed, and the bot went on from the new stump the moment it got there, 13 ticks on)
            if (this.moveOn) this.nextPoke = Math.max(this.nextPoke, now + randInt(POKE_TICKS[0] >> 1, POKE_TICKS[1] >> 1));
            this.beside = { x: taken.x, z: taken.z };
            this.besideLoc = taken;
            this.moveOn = false;
            this.tile = claimLocTile(player, taken, 1) ?? claimWaitTile(player, taken, 2);
        } else if (!taken && !this.tile) this.tile = claimStandTile(player, player.x, player.z, player.level, 2);
        if (this.tile && (player.x !== this.tile[0] || player.z !== this.tile[1])) {
            if (!player.hasWaypoints() && !stepToTile(player, this.tile[0], this.tile[1])) this.tile = [player.x, player.z];
            return;
        }
        // (at its tile: now and then a look at what it waits for, the miner's prospect: a person waiting does; with nothing
        // to look at, a stump or a mined-out rock, a few steps round to another: people went to whichever would come back
        // first. The caller's next pick leaves `current` out: the wait's beside and tile go, `besideLoc` stays for it)
        if (this.besideLoc && now >= this.nextPoke && !player.delayed) {
            this.nextPoke = now + randInt(POKE_TICKS[0], POKE_TICKS[1]);
            gatherStats.pokes++;
            if (!this.poke || !this.poke(player, this.besideLoc)) {
                gatherStats.moves++;
                this.moveOn = true;
                this.beside = null;
                this.tile = null;
            }
            return;
        }
        // (it faces what it waits for, once and now and then again)
        if (this.beside && (this.lastFace < 0 || now - this.lastFace > 20)) {
            this.lastFace = now;
            player.faceSquare(this.beside.x, this.beside.z);
        }
    }

    /** a resource was found (or the task moves on): the wait is over, its tile given back */
    found(player: Player | null): void {
        if (this.since < 0) return;
        this.since = -1;
        this.release(player);
    }

    private release(player: Player | null): void {
        this.tile = null;
        this.beside = null;
        this.besideLoc = null;
        this.moveOn = false;
        this.lastFace = -1;
        if (player) releaseStandTile(player);
    }

    reset(player: Player | null): void {
        this.found(player);
        this.done = false;
        this.nextCheck = 0;
    }
}

/**
 * port (variety round 1, F: DO-3): a stump for a woodcutter to wait by (`wait`: its ResourceWait): the one it waits by
 * while still a stump (274 changes the loc in place when the tree grows back); at a look round (`wait.movingOn`) another
 * of those within 8 tiles at random; the first: the nearest within 15. Null: none
 */
export function stumpToWaitBy(player: Player, wait: ResourceWait): Loc | null {
    const isStump = (loc: Loc): boolean => loc.isActive && (LocType.get(loc.type).debugname ?? '').includes('stump');
    const current = wait.current;
    if (current && isStump(current) && !wait.movingOn) return current;
    if (current && wait.movingOn) {
        const near: Loc[] = [];
        for (let zx = (player.x - 8) >> 3; zx <= (player.x + 8) >> 3; zx++) {
            for (let zz = (player.z - 8) >> 3; zz <= (player.z + 8) >> 3; zz++) {
                for (const loc of World.gameMap.getZone(zx << 3, zz << 3, player.level).getAllLocsSafe()) {
                    if (loc !== current && Math.max(Math.abs(loc.x - player.x), Math.abs(loc.z - player.z)) <= 8 && isStump(loc)) near.push(loc);
                }
            }
        }
        if (near.length > 0) return near[Math.floor(Math.random() * near.length)];
        if (isStump(current)) return current;
    }
    return findLocByPrefixWhere(player.x, player.z, player.level, '', 15, isStump);
}

/** a gatherer's wait under way stays within this many tiles of its spot (a stump or a rock 15 tiles off a bot 15 off it) */
export const WAIT_SPOT_TILES = 32;

/**
 * port (the variety work, round 1, track F: DO-3): a gatherer with nothing free is away from its spot (`location`):
 * more than 15 tiles off it, or WAIT_SPOT_TILES with a wait under way; then the wait is given up (its tile goes back)
 * and the task walks back. A party's guest, a "come here" or a random event's move left a woodcutter or a miner at
 * the party's venue with its task back at 'approach': it stood there for its 2-4 minutes on a tile of its own.
 */
export function awayFromSpot(player: Player, location: readonly [number, number, number], wait: ResourceWait): boolean {
    const [lx, lz, ll] = location;
    const d = player.level !== ll ? Infinity : Math.max(Math.abs(player.x - lx), Math.abs(player.z - lz));
    if (d <= (wait.waiting ? WAIT_SPOT_TILES : 15)) return false;
    wait.found(player);
    return true;
}

// ── Bank visits that change nothing (port: the variety work, round 1, track F; DO-1/ISS-2) ───────────────────────

/** arrivals in a row with the same pack and no XP between that end the task (the second: the trip between was futile) */
export const FUTILE_BANK_VISITS = 2;
/** port (variety round 1, F): tasks ended by the guard (tests, the report) */
export const bankLoopStats = { ended: 0, byTask: {} as Record<string, number> };
const bankVisits = new WeakMap<Player, { task: BotTask; pack: string; xp: number; same: number }>();

/** the pack's items and counts, in slot order */
function packKey(player: Player): string {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return '';
    let key = '';
    for (let slot = 0; slot < inv.capacity; slot++) {
        const it = inv.get(slot);
        if (it) key += `${it.id}x${it.count},`;
    }
    return key;
}

function totalXp(player: Player): number {
    let xp = 0;
    for (let i = 0; i < player.stats.length; i++) xp += player.stats[i];
    return xp;
}

/**
 * port (variety round 1, F: the general guard against futile bank loops): the bot is at a bank booth for its skill's task
 * (advanceBankWalk's arrival; a task with a step: not a bankstand's). FUTILE_BANK_VISITS arrivals in a row with the same pack and no XP between (a trip from
 * the bank and back that came to nothing) are the start of a loop a passer-by sees (a thief with a pack full of stolen cakes it would not bank stood at Ardougne's booth for 15-18 minutes;
 * a smith with leftover bars walked bank to anvil and back): the task ends and the planner picks again. True when it ended.
 */
export function noteBankVisit(player: Player): boolean {
    const ai = (player as unknown as { _bot?: { subTask?: BotTask | null; currentTask?: BotTask | null } })._bot;
    const task = ai?.subTask ?? ai?.currentTask ?? null;
    if (!task) return false;
    // (a skill's task, one with a step: a bankstander's or a hang-out's trips to the bank bring no XP by design)
    let step: SkillStep | null = null;
    try {
        step = task.activityStep();
    } catch {
        step = null;
    }
    if (!step) return false;
    const pack = packKey(player);
    const xp = totalXp(player);
    const last = bankVisits.get(player);
    const same = last && last.task === task && last.pack === pack && last.xp === xp ? last.same + 1 : 1;
    bankVisits.set(player, { task, pack, xp, same });
    if (same < FUTILE_BANK_VISITS) return false;
    bankVisits.delete(player);
    bankLoopStats.ended++;
    const kind = task.name.split(':')[0];
    bankLoopStats.byTask[kind] = (bankLoopStats.byTask[kind] ?? 0) + 1;
    futileEnds.set(player, { kind, tick: World.currentTick });
    task.interrupt();
    return true;
}

/** port (variety round 1, F): the task kind the guard ended last for each bot, and when */
const futileEnds = new WeakMap<Player, { kind: string; tick: number }>();

/**
 * port (variety round 1, F): did the bank guard end a task of this kind (its name before ':') for the bot within the
 * last `ticks`? For the planner (a kind it cannot do now, picked again at once, loops across task instances: a ranger
 * that cannot put its picked gear in hand)
 */
export function endedFutileLately(player: Player, kind: string, ticks = 3000): boolean {
    const e = futileEnds.get(player);
    return !!e && e.kind === kind && World.currentTick - e.tick < ticks;
}

/**
 * port (variety round 1, F: DO-1/ISS-2): at the bank, the edible food in the pack above `keep` goes in, the least good
 * first (stolen cakes and bread, a fighter's spare fish): a thief kept every edible item, so a pack full of the baker's
 * stall's cakes was never banked. The number banked.
 */
export function bankFoodAbove(player: Player, keep: number): number {
    const bid = bankInvId();
    const inv = player.getInventory(InvType.INV);
    const bank = bid === -1 ? null : player.getInventory(bid);
    if (!inv || !bank) return 0;
    let over = carriedFood(player) - keep;
    if (over <= 0) return 0;
    let banked = 0;
    // (edibleFoodIds is best first: the worst go first)
    for (const foodId of [...edibleFoodIds()].reverse()) {
        if (over <= 0) break;
        for (let slot = 0; slot < inv.capacity && over > 0; slot++) {
            const it = inv.get(slot);
            if (!it || it.id !== foodId) continue;
            const n = Math.min(it.count, over);
            const moved = inv.remove(foodId, n);
            if (moved > 0) {
                bank.add(bankedId(foodId), moved);
                over -= moved;
                banked += moved;
            }
        }
    }
    return banked;
}

// ── NPCs out of reach (port: the variety work, round 1, track F; ISS-11) ────────────────────────────────────────

/** port (variety round 1, F): an NPC a fighter found out of reach is passed over this long (task ticks: 10 minutes) */
export const UNREACHABLE_NPC_TICKS = 1000;
/** port (variety round 1, F): the reach checks (tests, the report) */
export const reachStats = { checks: 0, unreachable: 0, unknown: 0, gate: 0 };

/**
 * port (the variety work, round 1, track F: "I can't reach that!" for NPCs behind doors, ISS-11): can the bot get at
 * the NPC it is about to click (274's reach from where it stands, else its route to the NPC and the reach from where that
 * ends: one search, within the tick's budget; for a ranged or magic attack a line of sight does too)? A closed gate or door between counts as a way (the fighters open it). Null when the
 * tick's searches are spent (the click goes as before). Fighters clicked Al Kharid's palace guards, the Barbarian
 * longhall's and Taverley dungeon's behind walls and doors: "I can't reach that!" 64 times an hour, then twice more.
 */
export function npcReachable(player: Player, npc: Npc, ranged = false): boolean | null {
    const r = npcReach(player, npc, ranged);
    return r === 'unknown' ? null : r !== 'no';
}

/**
 * port (variety round 1, F: ISS-11): how the bot gets at the NPC: 'yes' (a route to beside it, or in sight for a ranged or
 * magic attack), 'gate' (a closed gate or door between: open it first, then click: a click first was "I can't reach
 * that!" at every pen and coop), 'no', or 'unknown' (no searches left this tick). The gate itself: gateToward.
 */
export function npcReach(player: Player, npc: Npc, ranged = false): 'yes' | 'gate' | 'no' | 'unknown' {
    if (player.level !== npc.level) return 'no';
    const w = npc.width ?? 1;
    const l = npc.length ?? 1;
    // (from where it stands: beside it with no wall between, 274's own reach test; a wall between an NPC and the bot
    // beside it was "I can't reach that!" every 12 ticks at the Al Kharid palace)
    if (botReachedEntity(player.level, player.x, player.z, npc.x, npc.z, w, l)) return 'yes';
    const dx = Math.max(npc.x - player.x, 0, player.x - (npc.x + w - 1));
    const dz = Math.max(npc.z - player.z, 0, player.z - (npc.z + l - 1));
    // (the variety work, round 2, Track D2: D2-7) the engine's own approach test for a ranged or magic attack: 274's
    // isApproached, whose line of sight other NPCs and players block (BLOCK_NPC_AND_PLAYERS) and which counts the NPC's
    // size; the plain line of sight passed the Al Kharid palace's archers through its crowd of warriors, and the engine
    // refused ("I can't reach that!" 11-20 an hour)
    if (ranged && Math.max(dx, dz) <= 10 && isApproached(player.level, player.x, player.z, npc.x, npc.z, 1, 1, w, l)) return 'yes';
    if (pathBudgetLeft(player) <= 0) {
        reachStats.unknown++;
        return 'unknown';
    }
    reachStats.checks++;
    // (274's own route to an NPC, findPathToEntity: where it ends, the reach test again)
    const path = botPathToEntity(player.level, player.x, player.z, npc.x, npc.z, w, l);
    if (path.length > 0) {
        const last = path[path.length - 1];
        const lx = (last >> 14) & 0x3fff;
        const lz = last & 0x3fff;
        if (botReachedEntity(player.level, lx, lz, npc.x, npc.z, w, l)) return 'yes';
        const ex = Math.max(npc.x - lx, 0, lx - (npc.x + w - 1));
        const ez = Math.max(npc.z - lz, 0, lz - (npc.z + l - 1));
        if (ranged && Math.max(ex, ez) <= 10 && isApproached(player.level, lx, lz, npc.x, npc.z, 1, 1, w, l)) return 'yes';
    }
    if (closedGateBetween(player, npc.x, npc.z, 8)) {
        reachStats.gate++;
        return 'gate';
    }
    reachStats.unreachable++;
    return 'no';
}

/** port (variety round 1, F): the closed gate or door between the bot and (x, z) (npcReach's 'gate'), or null */
export function gateToward(player: Player, x: number, z: number): Loc | null {
    return closedGateBetween(player, x, z, 8);
}
