// port: real teleport spells on long trips (the realism work, phase 5a, Track M; "real teleport
// spells for bots with the Magic level and runes on long trips"; others still walk). It changes the old rule "bots
// walk": a bot with the level and the runes, on a long trip whose destination lies near a spell's landing, casts the
// real spell through the magic tab's button (274's teleport.rs2: the runes go, the XP comes, the cast's animation, two
// delayed ticks, the jump within 2 tiles of the landing), seen like a player's. The unseen rescue jump stays for truly
// stuck bots (BotAction.botTeleport).
//
// The rule (teleportPlan), decided once per trip (a destination, until the bot stops walking to it for a while):
//   - both ends on the overworld, out of the Wilderness; a levelling bot, not newbie, not on an errand (a sub-task:
//     "come here", a follow, a random event), not trading, not leading a friend who follows it;
//   - the trip: the walking graph's route from the bot to the destination (port/BotWalkGraph; Chebyshev × 1.3 where the
//     graph does not join them), at least TRIP_MIN tiles, and a landing whose walk to the destination is at most
//     LANDING_SHARE of it and saves SAVE_MIN; where the route crosses monsters that hunt the bot (port/BotDanger: White
//     Wolf Mountain's wolves), TRIP_MIN_DANGER and LANDING_SHARE_DANGER, a landing whose own walk is safe;
//   - the spells: Varrock, Lumbridge, Falador; Camelot and Ardougne on a members world (Watchtower and Trollheim land on
//     a tower top and a mountain top: never); the Magic level, and the runes for one cast in the pack, or in the bank
//     when the trip starts at one (the bot's bank stop: every trip of a task starts there). A worn staff pays its rune
//     as 274's ~staff_runes does; a bot with no air runes wields its staff of air for the cast (the aged kits have no
//     air runes beside a staff: phase 5a's rune seed) and its weapon again after;
//   - who: a seeded 70 % of the bots ("law savers" walk), on 85 % of their qualifying trips; under 3 laws (pack and
//     bank) they walk unless the route is dangerous.
// The cast (castTeleport): the runes for one cast from the bank to the pack, the staff wielded if need be, the button;
// the next tick checks it (the runes gone, the bot delayed by the spell's script): a refused cast (the script's own
// checks only say why, an armed random event spawns instead: teleport.rs2:42-45) walks, and is counted. While it casts
// the bot does nothing else (BotPlayer's cast hold); the move is marked real (BotAction.noteMove) for the humanlike
// runner. Runes left from a cast that did not happen stay in the pack: BotTaskBase.hasStrayItems leaves them alone.
//
// White Wolf Mountain (port/BotDanger: a multi-combat route whose monsters hunt the bot, the strongest level 30+ and at
// least three quarters of its own): a spell when it qualifies (Camelot west, Falador east); else, at the trip's start
// (its bank), food packed (BotTaskBase.packTravelFood, 3-5) and the bot waits to
// cross with 80 % Hitpoints (eating what it packed) and 40 % run energy, at most CROSS_WAIT_TICKS; it runs across. A
// careless bot skips that now and then (its persona's carelessness: the deaths of Track F's metrics).
//
// Saved bots keep what they own (2026-10-16): the rune seed is a new bot's (port/BotAge); saved
// bots get laws only through play (the Wizards' Guild at Magic 66+ on members: tasks/LawTripTask).
//
// Per bot and tick: a WeakMap read (the cast hold); per walkTo call a WeakMap read and a compare; a trip's decision
// (graph routes, cached) once per trip.
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import ScriptState from '#/engine/script/ScriptState.js';
// (only modules that load nothing of the tasks': BotAction imports this one, and a task module evaluated before BotAction
// is done reads its exports too early. Its talk comes through setTeleportTalk, which port/BotAlch fills at load)
import { botContinuePage, botScript, interactHeldOp, interactIfButtonByName, noteMove } from '#/engine/bot/BotAction.js';
import { FOOD_IDS, Items, Locations } from '#/engine/bot/BotKnowledge.js';
import { nearestNode, nodePos, route as graphRoute, routeCost as graphRouteCost } from '#/engine/bot/port/BotWalkGraph.js';
import { huntsMe, routeDanger } from '#/engine/bot/port/BotDanger.js';
import { isAllowedCoord, isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { personaOf } from '#/engine/bot/port/BotPersona.js';
import { moveItems } from '#/engine/bot/port/BotInventoryCompat.js';
import texture from '../../data/lines2004-texture.json';

// ── the rule's numbers (the spec's defaults) ─────────────────────────────────

/** a trip this long by the walking graph's route at least (tiles: about 1.5 min of running) */
export const TRIP_MIN = 150;
/** a landing's walk to the destination at most this share of the trip, and saving this much */
export const LANDING_SHARE = 0.4;
export const SAVE_MIN = 100;
/** where the route crosses monsters that hunt the bot (White Wolf Mountain) */
export const TRIP_MIN_DANGER = 80;
export const LANDING_SHARE_DANGER = 0.6;
/** a seeded share of the bots teleport at all (the rest save their laws), on this share of their qualifying trips */
export const TELEPORTER_SHARE = 0.7;
export const TRIP_SHARE = 0.85;
/** under this many laws (pack and bank) a bot walks unless the route is dangerous */
export const LAWS_KEPT = 3;
/** a walk to the same destination within this many tiles, with no gap longer than TRIP_GAP_TICKS, is one trip */
const TRIP_SAME_TILES = 8;
const TRIP_GAP_TICKS = 100;
/** walks shorter than this (Chebyshev) are never a trip worth a decision */
const QUICK_MIN = 50;
/** the trip starts at a bank: the bot within this many tiles of its bank's spot */
const AT_BANK_TILES = 6;
/** the cast: at most this many ticks for the staff to go on, and for the landing after the check */
const WIELD_TICKS = 2;
const LAND_TICKS = 6;
/** White Wolf Mountain: Hitpoints and run energy (×100) to cross with, food to pack, the longest wait for them */
export const CROSS_HP = 0.8;
export const CROSS_RUN = 4000;
export const CROSS_FOOD: [number, number] = [3, 5];
export const CROSS_WAIT_TICKS = 600;

// ── the spells ────────────────────────────────────────────────────────────────

export type SpellKey = 'varrock' | 'lumbridge' | 'falador' | 'camelot' | 'ardougne';

export interface Spell {
    key: SpellKey;
    /** the magic tab's button (274's [if_button,magic:<spell>_teleport]) */
    com: string;
    level: number;
    members: boolean;
    /** runes for one cast before a staff's discount (magic_spells.dbrow) */
    runes: readonly (readonly [number, number])[];
    /** tele_coord: the script lands the caster within 2 tiles of it, in line of walk */
    landing: readonly [number, number];
}

/** the five spells bots use (skill_magic/configs/magic_spells.dbrow:62-106) */
export const SPELLS: readonly Spell[] = [
    { key: 'varrock', com: 'magic:varrock_teleport', level: 25, members: false, runes: [[Items.FIRE_RUNE, 1], [Items.AIR_RUNE, 3], [Items.LAW_RUNE, 1]], landing: [3213, 3424] },
    { key: 'lumbridge', com: 'magic:lumbridge_teleport', level: 31, members: false, runes: [[Items.EARTH_RUNE, 1], [Items.AIR_RUNE, 3], [Items.LAW_RUNE, 1]], landing: [3221, 3218] },
    { key: 'falador', com: 'magic:falador_teleport', level: 37, members: false, runes: [[Items.WATER_RUNE, 1], [Items.AIR_RUNE, 3], [Items.LAW_RUNE, 1]], landing: [2965, 3378] },
    { key: 'camelot', com: 'magic:camelot_teleport', level: 45, members: true, runes: [[Items.AIR_RUNE, 5], [Items.LAW_RUNE, 1]], landing: [2757, 3478] },
    { key: 'ardougne', com: 'magic:ardougne_teleport', level: 51, members: true, runes: [[Items.WATER_RUNE, 2], [Items.LAW_RUNE, 2]], landing: [2661, 3301] }
];

/** the staves that pay an element (274's magic_staff_table; a members staff pays nothing on a free world): id -> runes */
let staffTable: Map<number, number[]> | null = null;
function staves(): Map<number, number[]> {
    if (staffTable) return staffTable;
    staffTable = new Map();
    const add = (name: string, ...runes: number[]): void => {
        const id = ObjType.getId(name);
        if (id !== -1) staffTable!.set(id, runes);
    };
    for (const n of ['staff_of_air', 'air_battlestaff', 'mystic_air_staff']) add(n, Items.AIR_RUNE);
    for (const n of ['staff_of_water', 'water_battlestaff', 'mystic_water_staff']) add(n, Items.WATER_RUNE);
    for (const n of ['staff_of_earth', 'earth_battlestaff', 'mystic_earth_staff']) add(n, Items.EARTH_RUNE);
    for (const n of ['staff_of_fire', 'fire_battlestaff', 'mystic_fire_staff']) add(n, Items.FIRE_RUNE);
    for (const n of ['lava_battlestaff', 'mystic_lava_staff']) add(n, Items.EARTH_RUNE, Items.FIRE_RUNE);
    return staffTable;
}

/** Is this item a staff that pays an element (any of them)? (BotTaskBase.hasStrayItems leaves a carried one alone.) */
export function isElementalStaff(id: number): boolean {
    return staves().has(id);
}

/** the runes the bot's worn staff pays (274's ~staff_runes: none for a members staff on a free world) */
export function staffRunes(player: Player): number[] {
    const id = player.getInventory(InvType.WORN)?.get(3)?.id ?? -1;
    if (id === -1) return [];
    if (!isMembersWorld() && ObjType.get(id).members) return [];
    return staves().get(id) ?? [];
}

function bankOf(player: Player) {
    const bid = InvType.getId('bank');
    return bid === -1 ? null : player.getInventory(bid);
}

function count(inv: ReturnType<Player['getInventory']>, id: number): number {
    if (!inv) return 0;
    let n = 0;
    for (let slot = 0; slot < inv.capacity; slot++) {
        const it = inv.get(slot);
        if (it && it.id === id) n += it.count;
    }
    return n;
}

/** runes (or any item) in the pack */
export function carried(player: Player, id: number): number {
    return count(player.getInventory(InvType.INV), id);
}

/** in the bank */
export function banked(player: Player, id: number): number {
    return count(bankOf(player), id);
}

/** law runes the bot owns: its pack and its bank */
export function lawsOwned(player: Player): number {
    return carried(player, Items.LAW_RUNE) + banked(player, Items.LAW_RUNE);
}

/** the banks' spots (BotKnowledge Locations: every key ending _BANK) */
let bankSpots: [number, number, number][] | null = null;
function banks(): [number, number, number][] {
    if (!bankSpots) bankSpots = Object.entries(Locations).filter(([k, v]) => k.endsWith('_BANK') && Array.isArray(v)).map(([, v]) => v as [number, number, number]);
    return bankSpots;
}

/** at a bank's spot (where every task's trip starts after its bank stop), on its floor */
export function atBank(player: Player): boolean {
    return banks().some(([bx, bz, bl]) => bl === player.level && Math.max(Math.abs(player.x - bx), Math.abs(player.z - bz)) <= AT_BANK_TILES);
}

/** food the bot can eat on this world, best first (BotTaskBase.edibleFoodIds: a free world takes a members food's Eat op away) */
function edible(): number[] {
    const members = isMembersWorld();
    return FOOD_IDS.filter(id => members || !ObjType.get(id).members);
}

/** edible food in the pack */
export function foodCarried(player: Player): number {
    const ids = edible();
    const inv = player.getInventory(InvType.INV);
    let n = 0;
    for (let slot = 0; inv && slot < inv.capacity; slot++) {
        const it = inv.get(slot);
        if (it && ids.includes(it.id)) n += it.count;
    }
    return n;
}

/**
 * Before a walk across White Wolf Mountain (BotTaskBase.packTravelFood, Track F's planner rule too): at its bank, the
 * pack's food topped up to `count` from the bank, best food first (BotTaskBase.withdrawFood's way). True when it carries
 * that many.
 */
export function packFoodForTrip(player: Player, want: number): boolean {
    if (foodCarried(player) < want && atBank(player)) {
        const bank = bankOf(player);
        const inv = player.getInventory(InvType.INV);
        if (bank && inv) {
            for (const id of edible()) {
                const need = want - foodCarried(player);
                if (need <= 0) break;
                const have = count(bank, id);
                if (have > 0) moveItems(bank, inv, id, Math.min(need, have));
            }
        }
    }
    return foodCarried(player) >= want;
}

/** eats the best food it carries (the game's eat script, as BotTaskBase.eatBestFood); false if none, or busy */
function eatBest(player: Player): boolean {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return false;
    for (const id of edible()) {
        const slot = slotOf(player, id);
        if (slot !== -1) return interactHeldOp(player, inv, id, slot, 1);
    }
    return false;
}

/**
 * How a bot pays for one cast: what to take out of the bank (at a bank only), the staff of air it wields for the air,
 * and the runes the cast takes from its pack. Null when it cannot (the runes are neither carried nor, at a bank, banked).
 */
export interface CastPlan {
    spell: Spell;
    /** runes (or the staff) to move from the bank to the pack first */
    take: [number, number][];
    /** a staff of air to wield for the cast (its id: in the pack once `take` is done), or -1 */
    staff: number;
}

export function castPlanFor(player: Player, spell: Spell, bank: boolean): CastPlan | null {
    const paid = staffRunes(player);
    const take: [number, number][] = [];
    let staff = -1;
    for (const [rune, n] of spell.runes) {
        if (paid.includes(rune)) continue;
        const have = carried(player, rune);
        if (have >= n) continue;
        if (rune === Items.AIR_RUNE) {
            // no air runes: its staff of air (in the pack, or the bank's), wielded for the cast
            const air = Items.STAFF_OF_AIR;
            if (carried(player, air) > 0) {
                staff = air;
                continue;
            }
            if (bank && banked(player, air) > 0) {
                take.push([air, 1]);
                staff = air;
                continue;
            }
        }
        if (bank && banked(player, rune) >= n - have) {
            take.push([rune, n - have]);
            continue;
        }
        return null;
    }
    // (room in the pack for what comes out of the bank: a rune not carried yet takes a slot, the staff one, and under a
    // two-handed staff the shield one more; a full pack walks, as a player's would)
    const inv = player.getInventory(InvType.INV);
    let slots = take.filter(([id]) => carried(player, id) === 0 || !ObjType.get(id).stackable).length;
    if (staff !== -1 && ObjType.get(staff).wearpos2 === 5 && (player.getInventory(InvType.WORN)?.get(5)?.id ?? -1) !== -1) slots++;
    if (!inv || inv.freeSlotCount < slots) return null;
    return { spell, take, staff };
}

/** The spells this bot could cast now (level, world), whatever its runes. */
export function spellsFor(player: Player): Spell[] {
    const level = player.levels[PlayerStat.MAGIC];
    const members = isMembersWorld();
    return SPELLS.filter(s => level >= s.level && (members || !s.members));
}

// ── who ───────────────────────────────────────────────────────────────────────

/** Tests only: force the persona and trip dice (null: the real ones). Never set by the game. */
let forced: { teleporter?: boolean; trip?: number } | null = null;
export function setTeleportRatesForTest(rates: { teleporter?: boolean; trip?: number } | null): void {
    forced = rates;
}

/** Does this bot teleport at all? A seeded 70 % (from its name: the same at every login); the rest save their laws. */
export function isTeleporter(name: string): boolean {
    if (forced?.teleporter !== undefined) return forced.teleporter;
    return seededRandom(nameSeed(name, 'teleporter'))() < TELEPORTER_SHARE;
}

/** a levelling bot free to cast: no newbie, not on an errand (a sub-task), not trading, not leading a friend */
function freeToCast(player: Player): boolean {
    if (!isLevelling(player.botPlanner as PlannerKey) || isNewbie(player)) return false;
    if (player.botTradeTargetPid !== -1 || player.botComeHereReturnX !== -1) return false;
    const ai = (player as unknown as { _bot?: { hasSubTask?: () => boolean } })._bot;
    if (ai?.hasSubTask?.()) return false;
    // (a bot follows it, a friend of its clique on the way with it: it would leave the friend behind; port/BotFollow)
    return !leadsAFriend(player);
}

/**
 * Does a bot follow this one now (a friend of its clique on the way with it, port/BotFollow)? Then it neither casts
 * nor takes a wrong turn (BotAction's walk): either left the friend behind, out of run energy, its follow ended.
 */
export function leadsAFriend(player: Player): boolean {
    for (const p of World.playerLoop.all()) {
        if (p === player || !p.is_bot || p.level !== player.level || Math.max(Math.abs(p.x - player.x), Math.abs(p.z - player.z)) > 20) continue;
        const sub = (p as unknown as { _bot?: { subTask?: { leaderPlayer?: Player; target?: Player } | null } })._bot?.subTask;
        if (sub && (sub.leaderPlayer === player || sub.target === player)) return true;
    }
    return false;
}

// ── the trip ──────────────────────────────────────────────────────────────────

/** the route's limits on this world (as BotAction's walks: a free world keeps to free areas) */
function graphAllowed(): { allowed: ((x: number, z: number) => boolean) | undefined; key: string } {
    return isMembersWorld() ? { allowed: undefined, key: '' } : { allowed: isAllowedCoord, key: 'f2p' };
}

export interface Leg {
    /** tiles to walk */
    tiles: number;
    /** the graph route (null: the graph does not join the ends, Chebyshev × 1.3 instead) */
    nodes: number[] | null;
    /** monsters along it hunt the bot (port/BotDanger), and some of it is multi-combat */
    danger: boolean;
    multi: boolean;
    /** the strongest of them (combat level) */
    level: number;
}

/** a crossing worth getting ready for: multi-combat, monsters this strong at least and three quarters of the bot's level
 * (White Wolf Mountain: its pack leader is 73, its wolves 38; not a village's guards) */
export const CROSS_THREAT = 30;
function seriousCrossing(player: Player, leg: Leg): boolean {
    return leg.multi && leg.level >= Math.max(CROSS_THREAT, 0.75 * player.combatLevel);
}

/** A walk from (x, z) to (destX, destZ) by the walking graph: its length and its danger for this bot. */
export function legOf(player: Player, x: number, z: number, destX: number, destZ: number): Leg {
    const { allowed, key } = graphAllowed();
    const s = nearestNode(x, z, allowed);
    const g = nearestNode(destX, destZ, allowed);
    const cheb = Math.max(Math.abs(destX - x), Math.abs(destZ - z));
    const nodes = s >= 0 && g >= 0 ? graphRoute(s, g, allowed, key) : null;
    if (!nodes) return { tiles: Math.round(cheb * 1.3), nodes: null, danger: false, multi: false, level: 0 };
    const [sx, sz] = nodePos(s);
    const [gx, gz] = nodePos(g);
    const tiles = graphRouteCost(nodes) + Math.max(Math.abs(sx - x), Math.abs(sz - z)) + Math.max(Math.abs(gx - destX), Math.abs(gz - destZ));
    const d = routeDanger(nodes);
    const danger = huntsMe(player, d);
    return { tiles, nodes, danger, multi: danger && d.multi, level: danger ? Math.max(d.vis, d.anyLevel) : 0 };
}

export type Verdict = 'cast' | 'walk';

export interface Plan {
    verdict: Verdict;
    /** why it walks (for the counters and the report), or the spell it casts */
    reason: string;
    trip: Leg;
    /** the spell that qualified (a landing that helps, castable with the runes at hand), whether or not it casts */
    cast: CastPlan | null;
    /** the landing's walk to the destination */
    rest: number;
    /** a qualifying trip by a bot with the level and the runes (the humanlike report's TP1) */
    opportunity: boolean;
}

/**
 * The decision for a trip from where the bot stands to (destX, destZ, level): a spell, or the walk and why. Draws the
 * trip's dice (Math.random). Pure but for the dice; nothing is moved.
 */
export function teleportPlan(player: Player, destX: number, destZ: number, level = 0): Plan {
    const none = (reason: string, trip: Leg = { tiles: 0, nodes: null, danger: false, multi: false, level: 0 }): Plan => ({ verdict: 'walk', reason, trip, cast: null, rest: 0, opportunity: false });
    if (player.level !== 0 || level !== 0 || player.z >= 6400 || destZ >= 6400) return none('off the overworld');
    if (wildernessLevelAt(player.x, player.z) > 0 || wildernessLevelAt(destX, destZ) > 0) return none('wilderness');
    const trip = legOf(player, player.x, player.z, destX, destZ);
    const minTrip = trip.danger ? TRIP_MIN_DANGER : TRIP_MIN;
    if (trip.tiles < minTrip) return none('short', trip);
    const spells = spellsFor(player);
    if (spells.length === 0) return none('level', trip);
    const bank = atBank(player);
    let best: { plan: CastPlan; rest: number } | null = null;
    let landingHelps = false;
    for (const spell of spells) {
        const [lx, lz] = spell.landing;
        const leg = legOf(player, lx, lz, destX, destZ);
        if (leg.danger) continue;
        const ok = trip.danger ? leg.tiles <= LANDING_SHARE_DANGER * trip.tiles : leg.tiles <= LANDING_SHARE * trip.tiles && trip.tiles - leg.tiles >= SAVE_MIN;
        if (!ok) continue;
        landingHelps = true;
        const plan = castPlanFor(player, spell, bank);
        if (plan && (!best || leg.tiles < best.rest)) best = { plan, rest: leg.tiles };
    }
    if (!landingHelps) return none('no landing near', trip);
    if (!best) {
        // (the runes are banked away from it, or it has none)
        const owns = spells.some(s => castPlanFor(player, s, true) !== null && (bank || banked(player, Items.LAW_RUNE) > 0));
        return { ...none(owns && !bank ? 'runes in the bank' : 'no runes', trip) };
    }
    const base = { trip, cast: best.plan, rest: best.rest, opportunity: true };
    if (!isTeleporter(player.username)) return { ...base, verdict: 'walk', reason: 'saves its laws' };
    if (Math.random() >= (forced?.trip ?? TRIP_SHARE)) return { ...base, verdict: 'walk', reason: 'walks this time' };
    if (lawsOwned(player) < LAWS_KEPT && !trip.danger) return { ...base, verdict: 'walk', reason: 'few laws left' };
    return { ...base, verdict: 'cast', reason: best.plan.spell.key };
}

// ── the counters (the humanlike report: TP1, TP2; the tests) ──────────────────

export const teleportSpellStats = {
    /** trips decided (a walk of QUICK_MIN+ tiles by a levelling bot), and those of TRIP_MIN+ tiles */
    trips: 0,
    longTrips: 0,
    /** qualifying trips by bots with the level and the runes (TP1's whole) */
    opportunities: 0,
    /** casts begun (the button clicked), checked and landed */
    casts: 0,
    landed: 0,
    /** casts that failed (TP2): the reason -> count */
    failed: 0,
    failReasons: {} as Record<string, number>,
    /** why a trip walked: reason -> count */
    walked: {} as Record<string, number>,
    bySpell: {} as Record<string, number>,
    /** White Wolf Mountain (a multi-combat route that hunts the bot) walked: trips, prepared (food, HP, run), careless */
    crossings: { trips: 0, prepared: 0, careless: 0, fed: 0 },
    /** the last casts (tests): bot, spell, tick, from, landed at */
    recent: [] as { name: string; spell: SpellKey; tick: number; from: [number, number]; to: [number, number] | null }[]
};

function bump(map: Record<string, number>, key: string): void {
    map[key] = (map[key] ?? 0) + 1;
}

// ── the trip under way ───────────────────────────────────────────────────────

interface Trip {
    x: number;
    z: number;
    level: number;
    /** the last tick walkTo asked for it */
    last: number;
    verdict: Verdict | 'done' | 'prep';
    plan: Plan | null;
    /** White Wolf Mountain's preparation: until when it may wait, its food */
    prepUntil: number;
    food: number;
    careless: boolean;
}

/** each bot's trips under way, the newest last (a few: a task that asks for one destination, then another, each tick
 * keeps a decision for each, as FletchingTask's walk to its trees does) */
const trips = new WeakMap<Player, Trip[]>();
const TRIPS_KEPT = 4;

/** the trip to (destX, destZ, level) under way, or null */
function tripTo(player: Player, destX: number, destZ: number, level: number, now: number): Trip | null {
    for (const t of trips.get(player) ?? []) {
        if (t.level === level && Math.max(Math.abs(t.x - destX), Math.abs(t.z - destZ)) <= TRIP_SAME_TILES && now - t.last <= TRIP_GAP_TICKS) return t;
    }
    return null;
}

/** the trip the bot walked last (its crossing's preparation, its run) */
function currentTrip(player: Player): Trip | null {
    const list = trips.get(player);
    let best: Trip | null = null;
    for (const t of list ?? []) if (!best || t.last > best.last) best = t;
    return best;
}

interface Cast {
    trip: Trip;
    plan: CastPlan;
    phase: 'wield' | 'verify' | 'land' | 'rewield';
    since: number;
    /** worn items it took off for the staff (weapon, shield): put back on after the landing */
    restore: number[];
    laws: number;
    from: [number, number];
}

const casts = new WeakMap<Player, Cast>();
const lastCasts = new WeakMap<Player, number>();

/** The tick of the bot's last successful cast, or -1 (tests, the report). */
export function lastCastAt(player: Player): number {
    return lastCasts.get(player) ?? -1;
}

/** A teleport cast holds the bot, or it prepares a crossing: the stuck checks wait (BotAction.isCrossing). */
export function travelPaused(player: Player): boolean {
    if (casts.has(player)) return true;
    const t = currentTrip(player);
    return t !== null && t.verdict === 'prep' && World.currentTick - t.last <= 2;
}

/** White Wolf Mountain's crossing under way on foot: it runs (BotAction's run toggle). */
export function runsAcross(player: Player): boolean {
    const t = currentTrip(player);
    return t !== null && t.verdict === 'done' && t.plan !== null && seriousCrossing(player, t.plan.trip) && World.currentTick - t.last <= 5;
}

/**
 * walkTo's hook (BotAction.walkTo, after its crossings and the way out of a dungeon): true when the trip's teleport
 * or its crossing's preparation took this tick over (the bot casts, or stands at its bank to get ready).
 */
export function teleportLeg(player: Player, destX: number, destZ: number, level: number): boolean {
    if (casts.has(player)) return true;
    const now = World.currentTick;
    const known = tripTo(player, destX, destZ, level, now);
    if (known) {
        known.last = now;
        if (known.verdict === 'prep') return prepare(player, known, now);
        return false;
    }
    // a new trip: worth a decision only when long, by a bot free to cast (a short walk meanwhile, a stuck check's detour or
    // a door, leaves the trip under way as it is: its gap ends it)
    if (Math.max(Math.abs(destX - player.x), Math.abs(destZ - player.z)) < QUICK_MIN || player.level !== 0 || level !== 0) return false;
    const trip: Trip = { x: destX, z: destZ, level, last: now, verdict: 'walk', plan: null, prepUntil: 0, food: 0, careless: false };
    const list = (trips.get(player) ?? []).filter(t => now - t.last <= TRIP_GAP_TICKS);
    list.push(trip);
    if (list.length > TRIPS_KEPT) list.shift();
    trips.set(player, list);
    if (!freeToCast(player)) return false;
    const plan = teleportPlan(player, destX, destZ, level);
    trip.plan = plan;
    teleportSpellStats.trips++;
    if (tripLog) tripLog.push({ name: player.username, tick: now, from: [player.x, player.z], dest: [destX, destZ], tiles: plan.trip.tiles, verdict: plan.verdict, reason: plan.reason, task: (player as unknown as { _bot?: { currentTask?: { name?: string } | null } })._bot?.currentTask?.name ?? '-' });
    if (plan.trip.tiles >= TRIP_MIN) teleportSpellStats.longTrips++;
    if (plan.opportunity) teleportSpellStats.opportunities++;
    if (plan.verdict === 'cast' && plan.cast && busy(player)) {
        // (in a script that is not a chat page: an obstacle, a dialogue, another spell: it walks this time)
        bump(teleportSpellStats.walked, 'busy');
    } else if (plan.verdict === 'cast' && plan.cast) {
        trip.verdict = 'cast';
        if (castTeleport(player, trip, plan.cast)) return true;
        trip.verdict = 'walk';
    } else if (plan.opportunity || plan.reason === 'runes in the bank') bump(teleportSpellStats.walked, plan.reason);
    // White Wolf Mountain on foot: get ready for it first (food, Hitpoints, run energy), at the bank the trip starts from
    if (seriousCrossing(player, plan.trip)) teleportSpellStats.crossings.trips++;
    if (seriousCrossing(player, plan.trip) && atBank(player)) {
        const care = personaOf(player.username, (player.botPlanner as PlannerKey) ?? null).carelessness;
        if (Math.random() < care * 0.5) {
            trip.careless = true;
            teleportSpellStats.crossings.careless++;
            trip.verdict = 'done';
            return false;
        }
        trip.verdict = 'prep';
        trip.prepUntil = now + CROSS_WAIT_TICKS;
        trip.food = CROSS_FOOD[0] + Math.floor(Math.random() * (CROSS_FOOD[1] - CROSS_FOOD[0] + 1));
        teleportSpellStats.crossings.prepared++;
        return prepare(player, trip, now);
    }
    trip.verdict = 'done';
    return false;
}

/**
 * The food packed for White Wolf Mountain stays in the pack while its trip is under way (BotTaskBase.hasStrayItems): a
 * gatherer's walk state took it for a stray item and banked it again, at once or after the wait, and the bot crossed the
 * wolves without it.
 */
export function crossingFood(player: Player): boolean {
    const now = World.currentTick;
    for (const t of trips.get(player) ?? []) if (t.food > 0 && !t.careless && now - t.last <= TRIP_GAP_TICKS) return true;
    return false;
}

/** White Wolf Mountain's preparation, a tick of it: food packed at its bank, eat to 80 %, rest for 40 % run energy. */
function prepare(player: Player, trip: Trip, now: number): boolean {
    if (now >= trip.prepUntil) {
        trip.verdict = 'done';
        return false;
    }
    if (atBank(player) && foodCarried(player) < trip.food) {
        const had = foodCarried(player);
        packFoodForTrip(player, trip.food);
        if (foodCarried(player) > had && had === 0) teleportSpellStats.crossings.fed++;
    }
    const hp = player.levels[PlayerStat.HITPOINTS];
    const max = Math.max(1, player.baseLevels[PlayerStat.HITPOINTS]);
    if (hp < max * CROSS_HP) {
        // (eats what it packed; with none it waits at the bank, its Hitpoints coming back, until its time is up)
        if (foodCarried(player) > 0 && !player.delayed && (now & 1) === 0) eatBest(player);
        player.clearWaypoints();
        return true;
    }
    if (player.runenergy < CROSS_RUN) {
        player.clearWaypoints();
        return true;
    }
    trip.verdict = 'done';
    return false;
}

// ── the cast ─────────────────────────────────────────────────────────────────

/** the worn items a staff takes the place of (its hand; a two-handed one, the shield too) */
function wornIn(player: Player, slots: number[]): number[] {
    const worn = player.getInventory(InvType.WORN);
    const out: number[] = [];
    for (const s of slots) {
        const id = worn?.get(s)?.id ?? -1;
        if (id !== -1) out.push(id);
    }
    return out;
}

function slotOf(player: Player, id: number): number {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return -1;
    for (let slot = 0; slot < inv.capacity; slot++) if (inv.get(slot)?.id === id) return slot;
    return -1;
}

function wield(player: Player, id: number): boolean {
    const inv = player.getInventory(InvType.INV);
    const slot = slotOf(player, id);
    return inv !== null && slot !== -1 && interactHeldOp(player, inv, id, slot, 2);
}

/**
 * Starts the cast: the runes (and a staff) from the bank, the staff wielded if need be, the button. True while it is
 * under way (BotPlayer holds the bot); false when it could not begin (the bank had less than it seemed, the pack no
 * room): the bot walks.
 */
function castTeleport(player: Player, trip: Trip, plan: CastPlan): boolean {
    const now = World.currentTick;
    const bank = bankOf(player);
    const inv = player.getInventory(InvType.INV);
    if (!inv) return false;
    for (const [id, n] of plan.take) {
        if (!bank) return fail(player, null, 'bank');
        const moved = moveFromBank(bank, inv, id, n);
        if (moved < n) return fail(player, null, 'pack full');
    }
    player.clearWaypoints();
    player.clearPendingAction();
    const cast: Cast = { trip, plan, phase: 'verify', since: now, restore: [], laws: carried(player, Items.LAW_RUNE), from: [player.x, player.z] };
    if (plan.staff !== -1 && !staffRunes(player).includes(Items.AIR_RUNE)) {
        // its staff of air first (its weapon and, under a two-handed staff, its shield come off: on again after)
        const type = ObjType.get(plan.staff);
        cast.restore = wornIn(player, type.wearpos2 === 5 ? [3, 5] : [3]);
        if (!wield(player, plan.staff)) return fail(player, null, 'wield');
        cast.phase = 'wield';
        casts.set(player, cast);
        return true;
    }
    casts.set(player, cast);
    if (!click(player, cast)) return false;
    return true;
}

/** a bank withdrawal as the tasks make them (port/BotInventoryCompat.moveItems: clamped to the room there is) */
function moveFromBank(bank: NonNullable<ReturnType<Player['getInventory']>>, inv: NonNullable<ReturnType<Player['getInventory']>>, id: number, n: number): number {
    return moveItems(bank, inv, id, n);
}

/** held by a script that is not a chat page left open (an obstacle, a dialogue, another spell): not free to cast */
function busy(player: Player): boolean {
    const script = botScript(player);
    return player.delayed || (script !== null && script.execution !== ScriptState.PAUSEBUTTON) || (player.protect && script === null);
}

/** the button (274's [if_button,magic:<spell>_teleport]); the check comes next tick */
function click(player: Player, cast: Cast): boolean {
    teleportSpellStats.casts++;
    cast.laws = carried(player, Items.LAW_RUNE);
    cast.from = [player.x, player.z];
    // (a chat page left open, a level-up's box at 10x XP, holds the player's protected access: the spell's script would
    // not run. A player clicks it away first; another script under way is busy)
    if (botScript(player)) botContinuePage(player);
    if (player.delayed || player.protect || botScript(player)) return fail(player, cast, 'busy');
    if (!interactIfButtonByName(player, cast.plan.spell.com)) return fail(player, cast, 'button');
    cast.phase = 'verify';
    cast.since = World.currentTick;
    return true;
}

/** a cast that did not happen: counted, and this trip walks (never a second try for it) */
function fail(player: Player, cast: Cast | null, reason: string): false {
    teleportSpellStats.failed++;
    bump(teleportSpellStats.failReasons, reason);
    casts.delete(player);
    const trip = cast?.trip ?? currentTrip(player);
    if (trip) trip.verdict = 'done';
    // (a staff it put on for the cast comes off again: its weapon back)
    if (cast?.restore.length) for (const id of cast.restore) wield(player, id);
    return false;
}

/**
 * BotPlayer.tick's hold: true while the bot casts (it does nothing else, as on a break). The cast's steps run here: the
 * staff on, the button, the check (the runes gone, the bot delayed by the script), the landing, its weapon back on.
 */
export function isCastHeld(player: Player): boolean {
    // (a weapon or shield a stint took off, put on again once the bot is free: wieldLater)
    if (laterWields.has(player) && !player.delayed && !casts.has(player)) {
        for (const id of laterWields.get(player)!) wield(player, id);
        laterWields.delete(player);
    }
    const cast = casts.get(player);
    if (!cast) return false;
    const now = World.currentTick;
    switch (cast.phase) {
        case 'wield': {
            if (staffRunes(player).includes(Items.AIR_RUNE)) {
                if (!click(player, cast)) return false;
                return true;
            }
            if (now - cast.since > WIELD_TICKS) return fail(player, cast, 'wield');
            return true;
        }
        case 'verify': {
            if (now <= cast.since) return true;
            if (!(player.delayed && carried(player, Items.LAW_RUNE) < cast.laws)) return fail(player, cast, player.delayed || botScript(player) ? 'busy' : 'refused');
            noteMove(player, 'spell');
            lastCasts.set(player, now);
            const spell = cast.plan.spell.key;
            bump(teleportSpellStats.bySpell, spell);
            teleportSpellStats.recent.push({ name: player.username, spell, tick: now, from: cast.from, to: null });
            if (teleportSpellStats.recent.length > 200) teleportSpellStats.recent.shift();
            cast.phase = 'land';
            cast.since = now;
            return true;
        }
        case 'land': {
            const moved = player.level !== 0 || Math.max(Math.abs(player.x - cast.from[0]), Math.abs(player.z - cast.from[1])) > 10;
            if (moved) {
                landed(player, cast);
                if (cast.restore.length === 0) {
                    casts.delete(player);
                    return false;
                }
                cast.phase = 'rewield';
                cast.since = now + 1 + Math.floor(Math.random() * 3);
                return true;
            }
            if (now - cast.since > LAND_TICKS) {
                // (no jump: its Hitpoints ran out under it, p_telejump_safe)
                casts.delete(player);
                return false;
            }
            return true;
        }
        case 'rewield': {
            if (now < cast.since || player.delayed) return true;
            for (const id of cast.restore) wield(player, id);
            casts.delete(player);
            return true;
        }
    }
    return false;
}

/** the weapons and shields to put on again once the bot is free (wieldLater) */
const laterWields = new WeakMap<Player, number[]>();

/**
 * Put these back on once the bot is free (out of a script's delay): a task that ended while a script held the bot (an
 * alching stint stopped in alchemy's delay: its weapon stayed in the pack, the staff of fire on, and the next
 * gatherer banked it). BotPlayer.tick runs it before anything else (isCastHeld).
 */
export function wieldLater(player: Player, ids: readonly number[]): void {
    if (ids.length === 0) return;
    const list = laterWields.get(player) ?? [];
    for (const id of ids) if (!list.includes(id)) list.push(id);
    laterWields.set(player, list);
}

/** the landing: counted, and the bot may say so (port/BotChatter's 'teleport' event; its last law, its own line) */
function landed(player: Player, cast: Cast): void {
    teleportSpellStats.landed++;
    const rec = [...teleportSpellStats.recent].reverse().find(r => r.name === player.username && r.to === null);
    if (rec) rec.to = [player.x, player.z];
    // (its last law: half the time a line of its own, scaled by its persona's chattiness as port/BotChatter's events are)
    const chatty = Math.max(0.3, Math.min(2, personaOf(player.username, (player.botPlanner as PlannerKey) ?? null).chattiness / 7));
    if (lawsOwned(player) === 0 && Math.random() < Math.min(0.95, 0.5 * chatty) && talk?.say(player, MAGIC_LINES.lastLaw)) return;
    talk?.event(player, 'teleport');
}

// ── its talk (port/BotAlch fills it at load: port/BotChatter's events, a line of its own) ─────────────────────

/** "magic" in data/lines2004-texture.json: lines said only at their moment (never picked as idle talk) */
export const MAGIC_LINES = (texture as unknown as { magic: { lastLaw: string[] } }).magic;

export interface TeleportTalk {
    /** port/BotChatter.noteEvent: the event's lines are true a while, and it may speak of it now */
    event(player: Player, name: string): void;
    /** a line of `pool` said now in its style (not one said lately), counted as one of its persona's lines */
    say(player: Player, pool: readonly string[]): boolean;
}
let talk: TeleportTalk | null = null;
export function setTeleportTalk(t: TeleportTalk): void {
    talk = t;
}

/**
 * The elemental runes a teleporter is short of for its spells (fire for Varrock, earth for Lumbridge, water for Falador
 * and Ardougne; air its staff pays), for about ELEMENTAL_STOCK casts: [rune, how many to buy]. Aubury sells them
 * (RangedMagic buys them with its own runes there; the Wizards' Guild too). None for a law saver or under 3 laws.
 */
export function elementalsWanted(player: Player): [number, number][] {
    if (!isTeleporter(player.username) || lawsOwned(player) < LAWS_KEPT) return [];
    const want = new Map<number, number>();
    for (const spell of spellsFor(player)) {
        for (const [rune, n] of spell.runes) {
            if (rune === Items.LAW_RUNE || rune === Items.AIR_RUNE) continue;
            want.set(rune, Math.max(want.get(rune) ?? 0, n * ELEMENTAL_STOCK));
        }
    }
    const out: [number, number][] = [];
    for (const [rune, n] of want) {
        const owned = carried(player, rune) + banked(player, rune);
        if (owned < n / 2) out.push([rune, n - owned]);
    }
    return out;
}
const ELEMENTAL_STOCK = 30;

/** BotAction's wrong turns: the bot saw it went the wrong way (port/BotChatter's 'lost' event: now and then a line). */
export function noteWrongTurn(player: Player): void {
    talk?.event(player, 'lost');
}

/** Tests only: every trip decided, logged (null: not kept). */
export let tripLog: { name: string; tick: number; from: [number, number]; dest: [number, number]; tiles: number; verdict: string; reason: string; task: string }[] | null = null;
export function keepTripLogForTest(on: boolean): void {
    tripLog = on ? [] : null;
}

/** For the tests: forget every trip and cast (a new world). */
export function resetTeleportsForTest(): void {
    teleportSpellStats.trips = teleportSpellStats.longTrips = teleportSpellStats.opportunities = 0;
    teleportSpellStats.casts = teleportSpellStats.landed = teleportSpellStats.failed = 0;
    teleportSpellStats.failReasons = {};
    teleportSpellStats.walked = {};
    teleportSpellStats.bySpell = {};
    teleportSpellStats.crossings = { trips: 0, prepared: 0, careless: 0, fed: 0 };
    teleportSpellStats.recent = [];
}

/**
 * At a task's bank stop, for a later leg of its trip (from (fromX, fromZ), where it will be, to (destX, destZ)): the
 * runes for one cast into the pack when that leg would be a spell (BotTaskBase.packTeleportRunes; RangedMagic packs them
 * for the walk from Varrock's shops to its spot). The spell, or null.
 */
export function packRunesFor(player: Player, fromX: number, fromZ: number, destX: number, destZ: number): SpellKey | null {
    if (!freeToCast(player) || !isTeleporter(player.username) || !atBank(player)) return null;
    if (lawsOwned(player) < LAWS_KEPT) return null;
    const trip = legOf(player, fromX, fromZ, destX, destZ);
    if (trip.tiles < (trip.danger ? TRIP_MIN_DANGER : TRIP_MIN) || wildernessLevelAt(destX, destZ) > 0) return null;
    let best: { spell: Spell; rest: number } | null = null;
    for (const spell of spellsFor(player)) {
        const [lx, lz] = spell.landing;
        const leg = legOf(player, lx, lz, destX, destZ);
        if (leg.danger) continue;
        const ok = trip.danger ? leg.tiles <= LANDING_SHARE_DANGER * trip.tiles : leg.tiles <= LANDING_SHARE * trip.tiles && trip.tiles - leg.tiles >= SAVE_MIN;
        if (ok && castPlanFor(player, spell, true) && (!best || leg.tiles < best.rest)) best = { spell, rest: leg.tiles };
    }
    if (!best) return null;
    const plan = castPlanFor(player, best.spell, true)!;
    const bank = bankOf(player);
    const inv = player.getInventory(InvType.INV);
    if (!bank || !inv) return null;
    for (const [id, n] of plan.take) if (moveFromBank(bank, inv, id, n) < n) return null;
    return best.spell.key;
}
