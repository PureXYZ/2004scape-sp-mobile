// Content lookups whose names or semantics changed between rev 254 (upstream) and rev 274. Each was checked against
// the packed 274 data and the 274 script that handles it; test/content-names.test.mjs resolves every content name the
// bot library uses and fails on one that does not exist.
import CategoryType from '#/cache/config/CategoryType.js';
import LocType from '#/cache/config/LocType.js';
import ParamType from '#/cache/config/ParamType.js';
import type Loc from '#/engine/entity/Loc.js';
import { CoordGrid } from '#/engine/CoordGrid.js';
import World from '#/engine/World.js';

/**
 * A cooking range or fire ([oplocu,_cooking_oven] / [oplocu,_cooking_fire] in 274). Upstream matched the prefix
 * 'loc_272' (254's unnamed loc_2724-2731); 274 names them (2728 is `range`, the one all three bot cooking spots
 * use), so the prefix matched nothing and cooking never started. The categories are what the scripts trigger on.
 */
export function isCookingLoc(loc: Loc): boolean {
    const category = LocType.get(loc.type).category;
    return category !== -1 && (category === CategoryType.getId('cooking_oven') || category === CategoryType.getId('cooking_fire'));
}

/**
 * A tree a woodcutter can chop. Upstream found trees by debugname prefix ('tree', 'oaktree'…) minus stumps; in 274
 * the 'tree' prefix also matches the Gnome Stronghold's treewall/treedoor locs and the rope swings
 * (tree_ropeswing1-4, tree_forropeswing1), none of which can be chopped. Every 274 tree has "Chop down" as op 1.
 */
export function isChoppableTree(loc: Loc): boolean {
    return LocType.get(loc.type).op?.[0]?.toLowerCase() === 'chop down';
}

/** A sink, fountain or other water source (water_sources.loc, category watersource); 274 has no 'pump' loc. */
export function isWaterSource(loc: Loc): boolean {
    const category = LocType.get(loc.type).category;
    return category !== -1 && category === CategoryType.getId('watersource');
}

/** The obj param with a weapon's special attack energy: 110 in 254's packs, `sa_energy` (137) in 274's. */
export function specialEnergyParam(): number {
    return ParamType.getId('sa_energy');
}

/**
 * The 274 wilderness level at (x, z): wilderness_zones.dbrow (the surface from 0_46_55 to 3_52_99 and the Edgeville
 * dungeon's from 0_46_155 to 0_52_199), a level per 8 tiles. Upstream's PKers counted every z >= 3520 at any x.
 */
export function wildernessLevelAt(x: number, z: number): number {
    if (x < 2944 || x > 3391) return 0;
    if (z >= 3520 && z <= 6399) return Math.floor((z - 3520) / 8) + 1;
    if (z >= 9920 && z <= 12799) return Math.floor((z - 9920) / 8) + 1;
    return 0;
}

/**
 * The wilderness level two players may fight at (pvp_combat.rs2 [proc,pvp_level_check]): the lower of theirs, so
 * both must be in the wilderness. Upstream's PKers used only their own level and went for players outside it.
 */
export function pvpWildernessLevel(a: { x: number; z: number }, b: { x: number; z: number }): number {
    return Math.min(wildernessLevelAt(a.x, a.z), wildernessLevelAt(b.x, b.z));
}

/**
 * port (the realism work, phase 5b: PK teams): is (x, z) in a multi-combat area? 274's `map_multiway` (GameMap.isMulti:
 * the zone's flag from content/maps/multiway.csv, which the app ships). The game's pvp_in_combat_check skips its
 * "already under attack" rules when the target (`.coord`) stands in one: there, and only there, a team piles on a player
 * (pvp_combat.rs2 [proc,pvp_in_combat_check]). North of Varrock the Wilderness is multi-combat from level 1 (x 3136-3327);
 * the edge north of Edgeville is single-combat.
 */
export function isMultiCombat(x: number, z: number, level: number): boolean {
    return World.gameMap.isMulti(CoordGrid.packCoord(level, x, z));
}

/** The Al Kharid toll gate (the bots cross it by the AlKharid gateway's teleport, never by its dialogue). */
export function tollGateIds(): Set<number> {
    return new Set(['border_gate_toll_left', 'border_gate_toll_right'].map(name => LocType.getId(name)).filter(id => id !== -1));
}
