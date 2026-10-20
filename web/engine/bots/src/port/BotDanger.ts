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
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { CoordGrid } from '#/engine/CoordGrid.js';
import NpcType from '#/cache/config/NpcType.js';
import HuntType from '#/cache/config/HuntType.js';
import { HuntModeType } from '#/engine/entity/hunt/HuntModeType.js';
import { HuntCheckNotTooStrong } from '#/engine/entity/hunt/HuntCheckNotTooStrong.js';
import { NpcMode } from '#/engine/entity/NpcMode.js';
import { nearestNode, nearestNodes, nodeCount, nodePos } from '#/engine/bot/port/BotWalkGraph.js';

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

/** For the tests: forget the map (a new world). */
export function resetDangerMap(): void {
    map = null;
}
