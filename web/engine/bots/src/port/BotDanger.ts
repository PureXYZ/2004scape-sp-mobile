// port: where monsters hunt players (the realism work, phase 5: "fallible bots", fallible, not suicidal). Built once,
// the first time a bot asks, from the world's NPC spawns: for every walk-graph node (16 tiles apart, overworld), the
// highest combat level of the monsters near it that attack players on sight, whether one of them hunts any level, and
// whether the node lies in a multi-combat area (where several pile on: White Wolf Mountain killed about 5 low-level
// bots an hour at 100 bots, crossing between Taverley and Catherby, in phase 1's runs).
//
// 274's rule (Npc.huntAll): a hunt of type 'player' finds a player within its huntrange; most hunts carry
// check_nottoostrong=outside_wilderness, so outside the Wilderness they leave a player of more than twice their combat
// level alone (Npc.ts: `player.combatLevel > type.vislevel * 2`). The danger check (BotGoalPlanner, port/BotDefence)
// and the teleports (port/BotTeleport) read this; nothing here runs per tick.
//
//   dangerAt(x, z)        the nearest node's danger (or NO_DANGER off the graph)
//   routeDanger(nodes)    the worst danger along a walk-graph route (for a bot: huntsMe)
//   huntsMe(player, d)    would those monsters attack this player?
//
// port (bots ideas, round 1's left-overs: the dark wizards' circle south of Varrock, whose bearded wizards, level 20,
// hunt players up to combat 40 and kill a level-3 in two spells): a bot keeps clear of monsters that hunt it and are
// far stronger than it (above twice its level: FEAR_RATIO), outside the Wilderness, as a weak player did. The 25-bot
// free world (sim, seed 1) lost a level-3 on a shop trip routed through the circle's node, another on a food trip that
// walked the same route back after each run from it, and a woodcutter that took the trees beside it one by one and ran
// from a young wizard into the bearded ones:
//   fearCost(player)      the walk graph's cost of each step for its route (port/BotWalkGraph route; BotAction's walks)
//   fearedAt(player, x, z) does such a monster start on a player at that tile, or beside it? (tasks/WoodcuttingTask's
//                         and tasks/FletchingTask's trees)
// A monster threatens a tile it can get at: from a tile it wanders to (walked to from its spawn, within its wanderrange)
// and within its huntrange of it, a line of walk (or, one that attacks from range, a line of sight), not only its
// reach. Draynor's jail guards (26) have a reach of 17 and stand behind the jail's walls: by reach alone every one of
// Draynor's 56 trees was a level-18's no-go and its oak step had nothing to do (knowledge.test). Lines from the spawn
// alone missed what a monster sees once it wanders round a tree: a woodcutter took the willow beside Draynor's young
// dark wizards (3088,3234) and died (humanlike m100 s6 10x).
//   lineFeared(player, x, z) does the line from the bot to there cross such a tile? (BotAction's legs two nodes ahead)
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { CoordGrid } from '#/engine/CoordGrid.js';
import { canTravel, isLineOfSight, isLineOfWalk } from '#/engine/GameMap.js';
import { CollisionType } from '#/engine/routefinder/index.js';
import NpcType from '#/cache/config/NpcType.js';
import HuntType from '#/cache/config/HuntType.js';
import { HuntModeType } from '#/engine/entity/hunt/HuntModeType.js';
import { HuntCheckNotTooStrong } from '#/engine/entity/hunt/HuntCheckNotTooStrong.js';
import { NpcMode } from '#/engine/entity/NpcMode.js';
import { nearestNode, nearestNodes, nodeCount, nodePos } from '#/engine/bot/port/BotWalkGraph.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';

export interface Danger {
    /** the highest combat level of the monsters near it that hunt players with the "not too strong" rule (0: none) */
    vis: number;
    /** the highest combat level of those that hunt any player, whatever its level (0: none) */
    anyLevel: number;
    /** the node lies in a multi-combat area */
    multi: boolean;
}

export const NO_DANGER: Readonly<Danger> = Object.freeze({ vis: 0, anyLevel: 0, multi: false });

/** a monster counts for the nodes within this many tiles of its spawn, plus its huntrange */
const NEAR_TILES = 10;

let map: Danger[] | null = null;

/** Does this hunt mode attack a player it finds? (type 'player', a new mode that is an op on the player) */
function attacksPlayers(huntMode: number): HuntType | null {
    if (huntMode < 0) return null;
    const hunt = HuntType.get(huntMode);
    if (!hunt || hunt.type !== HuntModeType.PLAYER) return null;
    return hunt.findNewMode >= NpcMode.OPPLAYER1 && hunt.findNewMode <= NpcMode.APPLAYER5 ? hunt : null;
}

function build(): Danger[] {
    const nodes = nodeCount();
    const out: Danger[] = new Array(nodes);
    for (let i = 0; i < nodes; i++) {
        const [x, z] = nodePos(i);
        out[i] = { vis: 0, anyLevel: 0, multi: World.gameMap.isMulti(CoordGrid.packCoord(0, x, z)) };
    }
    for (const npc of World.npcs) {
        if (!npc || npc.startLevel !== 0) continue;
        const type = NpcType.get(npc.type);
        if (!type || type.vislevel <= 0) continue;
        const hunt = attacksPlayers(type.huntmode);
        if (!hunt) continue;
        const reach = NEAR_TILES + Math.max(0, type.huntrange);
        for (const i of nearestNodes(npc.startX, npc.startZ, 9)) {
            const [x, z] = nodePos(i);
            if (Math.max(Math.abs(x - npc.startX), Math.abs(z - npc.startZ)) > reach) continue;
            const d = out[i];
            if (hunt.checkNotTooStrong === HuntCheckNotTooStrong.OUTSIDE_WILDERNESS) d.vis = Math.max(d.vis, type.vislevel);
            else d.anyLevel = Math.max(d.anyLevel, type.vislevel);
        }
    }
    return out;
}

function load(): Danger[] {
    if (!map) map = build();
    return map;
}

/** The danger at the walk-graph node nearest (x, z) on the overworld, or NO_DANGER (off the graph, upstairs, underground). */
export function dangerAt(x: number, z: number, level = 0): Readonly<Danger> {
    if (level !== 0) return NO_DANGER;
    const i = nearestNode(x, z);
    return i < 0 ? NO_DANGER : load()[i];
}

/** The danger of one node (or NO_DANGER for -1). */
export function dangerOfNode(i: number): Readonly<Danger> {
    return i < 0 ? NO_DANGER : (load()[i] ?? NO_DANGER);
}

/** The worst danger along a walk-graph route: the highest levels met, and whether any of it is multi-combat. */
export function routeDanger(nodes: readonly number[]): Danger {
    const out: Danger = { vis: 0, anyLevel: 0, multi: false };
    const m = load();
    for (const i of nodes) {
        const d = m[i];
        if (!d || (d.vis === 0 && d.anyLevel === 0)) continue;
        out.vis = Math.max(out.vis, d.vis);
        out.anyLevel = Math.max(out.anyLevel, d.anyLevel);
        if (d.multi) out.multi = true;
    }
    return out;
}

/** Would the monsters of this danger attack the player? (274: outside the Wilderness, not above twice their level.) */
export function huntsMe(player: Player, d: Readonly<Danger>): boolean {
    if (d.anyLevel > 0) return true;
    if (d.vis <= 0) return false;
    return player.isInWilderness() || player.combatLevel <= d.vis * 2;
}

// ── Keeping clear (bots ideas, round 1's left-overs) ─────────────────────────────────────────────────────────────

/**
 * a step onto a node where stronger monsters hunt the bot, or along an edge whose line crosses where one starts on a
 * player, costs this much more on its route (as one through the Wilderness)
 */
const FEAR_COST = 4;
/**
 * a bot keeps clear of monsters above this many times its combat level (274's hunt leaves alone a player above twice
 * its level: the same line seen from the other side). Above its level alone, a level-18 woodcutter kept off every oak
 * of Draynor's step for the jail guards (26), who roam the village (6000 ticks: all of x 3098-3138, z 3226-3259, the
 * oaks' sides among it) and whom it fights off; a level-3 keeps clear of the young dark wizards (7) and the bearded (20)
 */
const FEAR_RATIO = 2;
/** the level above which a monster that hunts the bot is one it keeps clear of */
function fearLimit(player: Player): number {
    return player.combatLevel * FEAR_RATIO;
}
/** each node's level that a bot under it keeps clear of (its monsters' highest; 0: none, and none in the Wilderness), and the levels met */
let fearLevels: Int32Array | null = null;
let fearSteps: number[] = [];
const fearCosts = new Map<number, (from: number, to: number) => number>();
/** per level met: each edge's answer (from × 65536 + to), whether its line crosses a hunter's reach of that level or more */
const edgeFears = new Map<number, Map<number, boolean>>();
/** a line is looked at every this many tiles */
const LINE_STEP = 4;

function loadFear(): Int32Array {
    if (fearLevels) return fearLevels;
    const nodes = nodeCount();
    const levels = new Int32Array(nodes);
    const seen = new Set<number>();
    const byGrid = loadHunters();
    for (let i = 0; i < nodes; i++) {
        const [x, z] = nodePos(i);
        if (wildernessLevelAt(x, z) > 0) continue;
        for (const h of byGrid.get(((x >> 6) << 8) | (z >> 6)) ?? []) if (h.level > levels[i] && threatens(h, x, z)) levels[i] = h.level;
        if (levels[i] > 0) seen.add(levels[i]);
    }
    fearSteps = [...seen].sort((a, b) => a - b);
    fearLevels = levels;
    return levels;
}

/**
 * The walk graph's cost of each step for the bot's route: FEAR_COST onto a node whose monsters hunt it and are far
 * stronger than it (above twice its combat level, fearLimit: 274's hunt then always finds it; one under it the bot fights
 * off, port/BotDefence), or along an edge whose line crosses where such a monster starts on a player (the circle's edge from
 * 3240,3368 to 3208,3384 passes 2 tiles from a bearded wizard's spawn), so the route goes round where the graph has a
 * way and through where it has none. Null when no node is above it. `key` names what it keeps clear of (the levels
 * between two of the map's give the same), for the route cache.
 */
export function fearCost(player: Player): { cost: (from: number, to: number) => number; key: string } | null {
    const levels = loadFear();
    const step = fearSteps.find(l => l > fearLimit(player));
    if (step === undefined) return null;
    let cost = fearCosts.get(step);
    if (!cost) {
        let edges = edgeFears.get(step);
        if (!edges) edgeFears.set(step, (edges = new Map()));
        const known = edges;
        cost = (from: number, to: number): number => {
            if (levels[to] >= step) return FEAR_COST;
            const key = from * 65536 + to;
            let feared = known.get(key);
            if (feared === undefined) {
                const [x0, z0] = nodePos(from);
                const [x1, z1] = nodePos(to);
                feared = lineFearedAbove(step - 1, x0, z0, x1, z1);
                known.set(key, feared);
            }
            return feared ? FEAR_COST : 1;
        };
        fearCosts.set(step, cost);
    }
    return { cost, key: `fear${step}` };
}

/** a monster's spawn as the tile check reads it: its level, and how far from its spawn it starts on a player */
interface Hunter {
    x: number;
    z: number;
    level: number;
    reach: number;
    /** it attacks from range (a spell, an arrow): a line of sight is enough for it */
    ranged: boolean;
    /** how far it wanders from its spawn, and how far from where it stands it starts on a player */
    wander: number;
    hunt: number;
    /** the tiles it can stand on (x << 14 | z), when first asked: standTiles */
    stands: Int32Array | null;
}
/** a hunter starts on a player this far from its spawn: its wander, its huntrange and a tile (274's hunt looks from where it stands) */
const REACH_MARGIN = 1;
/** the hunters outside the Wilderness on the overworld, by 64-tile square (each in every square its reach touches) */
let hunters: Map<number, Hunter[]> | null = null;

function loadHunters(): Map<number, Hunter[]> {
    if (hunters) return hunters;
    const out = new Map<number, Hunter[]>();
    for (const npc of World.npcs) {
        if (!npc || npc.startLevel !== 0) continue;
        const type = NpcType.get(npc.type);
        if (!type || type.vislevel <= 0 || !attacksPlayers(type.huntmode) || wildernessLevelAt(npc.startX, npc.startZ) > 0) continue;
        const wander = Math.min(type.wanderrange, WANDER_MAX);
        const hunt = Math.max(0, type.huntrange);
        const h: Hunter = { x: npc.startX, z: npc.startZ, level: type.vislevel, reach: wander + hunt + REACH_MARGIN, ranged: type.attackrange > 1, wander, hunt, stands: null };
        for (let sx = (h.x - h.reach) >> 6; sx <= (h.x + h.reach) >> 6; sx++) {
            for (let sz = (h.z - h.reach) >> 6; sz <= (h.z + h.reach) >> 6; sz++) {
                const key = (sx << 8) | sz;
                const list = out.get(key);
                if (list) list.push(h);
                else out.set(key, [h]);
            }
        }
    }
    hunters = out;
    return out;
}

/**
 * Does a monster far stronger than the bot (fearLimit) that hunts it start on a player at (x, z), or beside it? (Within
 * its wander and huntrange of its spawn, and able to get at it from there: threatens; outside the Wilderness, on the
 * overworld.) For a level-3 the Champions' Guild oaks (3200-3215, 8 tiles and
 * more from the dark wizards' spawns) are clear; the trees in and round the circle (3217-3238, 3362-3378) are not.
 */
export function fearedAt(player: Player, x: number, z: number, level = 0): boolean {
    if (level !== 0) return false;
    const cb = fearLimit(player);
    // (beside it too: a tree's own tile is blocked, a line of walk never ends on it; the bot stands on one of these)
    return fearedAbove(cb, x, z) || fearedAbove(cb, x + 1, z) || fearedAbove(cb, x - 1, z) || fearedAbove(cb, x, z + 1) || fearedAbove(cb, x, z - 1);
}

/** a wander past this is taken as this (the tiles a monster stands on are searched in its wander's square) */
const WANDER_MAX = 16;

/** the tiles the hunter can stand on: walked to from its spawn (274's collision), within its wanderrange */
function standTiles(h: Hunter): Int32Array {
    if (h.stands) return h.stands;
    const side = h.wander * 2 + 1;
    const seen = new Uint8Array(side * side);
    const out: number[] = [];
    const queue: number[] = [h.x, h.z];
    seen[h.wander * side + h.wander] = 1;
    for (let q = 0; q < queue.length; q += 2) {
        const x = queue[q];
        const z = queue[q + 1];
        out.push((x << 14) | z);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                const lx = x + dx - h.x + h.wander;
                const lz = z + dz - h.z + h.wander;
                if ((dx === 0 && dz === 0) || lx < 0 || lz < 0 || lx >= side || lz >= side || seen[lz * side + lx]) continue;
                if (!canTravel(0, x, z, dx, dz, 1, 0, CollisionType.NORMAL)) continue;
                seen[lz * side + lx] = 1;
                queue.push(x + dx, z + dz);
            }
        }
    }
    h.stands = Int32Array.from(out);
    return h.stands;
}

/**
 * can the hunter get at (x, z): from a tile it stands on within its huntrange (and a tile) of it, a line of walk (one
 * that attacks from range: or of sight)
 */
function threatens(h: Hunter, x: number, z: number): boolean {
    if (Math.max(Math.abs(h.x - x), Math.abs(h.z - z)) > h.reach) return false;
    const near = h.hunt + REACH_MARGIN;
    for (const at of standTiles(h)) {
        const sx = at >> 14;
        const sz = at & 0x3fff;
        if (Math.max(Math.abs(sx - x), Math.abs(sz - z)) > near) continue;
        if (isLineOfWalk(0, sx, sz, x, z) || (h.ranged && isLineOfSight(0, sx, sz, x, z))) return true;
    }
    return false;
}

/** the tiles' answers by (fear limit, tile), forgotten whole past FEARED_KEEP (the lines are the cost) */
const fearedTiles = new Map<number, boolean>();
const FEARED_KEEP = 50_000;

/** a hunter above level `cb` (a fear limit: fearLimit) can get at (x, z) (overworld, outside the Wilderness) */
function fearedAbove(cb: number, x: number, z: number): boolean {
    if (wildernessLevelAt(x, z) > 0) return false;
    const list = loadHunters().get(((x >> 6) << 8) | (z >> 6));
    if (!list) return false;
    const key = cb * 67_108_864 + ((x << 14) | z);
    const known = fearedTiles.get(key);
    if (known !== undefined) return known;
    let feared = false;
    for (const h of list) {
        if (h.level > cb && threatens(h, x, z)) {
            feared = true;
            break;
        }
    }
    if (fearedTiles.size >= FEARED_KEEP) fearedTiles.clear();
    fearedTiles.set(key, feared);
    return feared;
}

/** some tile of the line from (x0, z0) to (x1, z1), looked at every LINE_STEP tiles and at its end, is feared by a bot of combat `cb` */
function lineFearedAbove(cb: number, x0: number, z0: number, x1: number, z1: number): boolean {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0)) / LINE_STEP));
    for (let i = 0; i <= n; i++) if (fearedAbove(cb, Math.round(x0 + ((x1 - x0) * i) / n), Math.round(z0 + ((z1 - z0) * i) / n))) return true;
    return false;
}

/**
 * Does the straight line from the bot to (x, z) cross where a monster far stronger than it that hunts it starts on a player?
 * (BotAction's graph walk aims two nodes ahead only when not: on the way round the circle's south, the line from 3240,3368
 * to 3206,3352, two nodes on, runs over a young wizard's spawn, 3230,3363.)
 */
export function lineFeared(player: Player, x: number, z: number): boolean {
    return player.level === 0 && lineFearedAbove(fearLimit(player), player.x, player.z, x, z);
}

/** For the tests: forget the map (a new world). */
export function resetDangerMap(): void {
    map = null;
    fearLevels = null;
    fearSteps = [];
    fearCosts.clear();
    edgeFears.clear();
    fearedTiles.clear();
    hunters = null;
}
