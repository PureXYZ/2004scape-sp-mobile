// port (perf, 2026-10-23): who targets a player, kept as it changes, for BotAction.findAggressorNpc and
// findOtherAggressorNpc: every bot not out to fight asks (BotPlayer's self-defence, port/BotDefence) at most every 3
// ticks, a search of 25-49 zones for the NPC, usually none, that attacks it: 4.7 % of the world tick in JavaScriptCore
// at 1000 bots. An NPC's target changes only in PathingEntity.setInteraction and clearInteraction (Npc.clearInteraction
// calls it; nothing else writes an NPC's target), so wrapping those two keeps, for every player, the NPCs whose target
// it is now; an NPC that attacks it (BotAction.actsOn: its target is the player) is always among them. The lookup
// then picks among those few exactly as the zone search does: only an NPC in a searched zone's list, valid and within
// the limit; the nearest (Manhattan), a tie to the earlier zone in the search's order (rows of zones south to north,
// each west to east), then to the earlier in the zone's list. An NPC in a list other than its tile's zone's (never
// seen: the engine moves it between lists with its tile) hands the question back to the search. The wrappers run
// for every entity; if one ever failed, the index would stop answering and every lookup would search again.
import Npc from '#/engine/entity/Npc.js';
import PathingEntity from '#/engine/entity/PathingEntity.js';
import Player from '#/engine/entity/Player.js';
import type Zone from '#/engine/zone/Zone.js';
import { inSomeZone, npcBefore, zoneHasNpc } from '#/engine/bot/port/BotZoneScan.js';

const targetOf = new WeakMap<Npc, Player>();
const targetedBy = new WeakMap<Player, Set<Npc>>();
let installed = false;
let broken = false;

function note(npc: Npc): void {
    const was = targetOf.get(npc);
    const now = npc.target instanceof Player ? npc.target : undefined;
    if (was === now) return;
    if (was !== undefined) targetedBy.get(was)?.delete(npc);
    if (now === undefined) {
        targetOf.delete(npc);
        return;
    }
    let set = targetedBy.get(now);
    if (!set) targetedBy.set(now, (set = new Set()));
    set.add(npc);
    targetOf.set(npc, now);
}

function noteSafely(entity: PathingEntity): void {
    if (broken || !(entity instanceof Npc)) return;
    try {
        note(entity);
    } catch {
        broken = true;
    }
}

/** BotManager.start: the world's NPCs now (one targeting a player already is noted), then every change. */
export function installAggressorIndex(npcs: Iterable<Npc | null | undefined>): void {
    if (installed) return;
    installed = true;
    try {
        for (const npc of npcs) if (npc) note(npc);
    } catch {
        broken = true;
    }
    const proto = PathingEntity.prototype as unknown as { setInteraction: (...a: unknown[]) => boolean; clearInteraction: (...a: unknown[]) => void };
    const setInteraction = proto.setInteraction;
    const clearInteraction = proto.clearInteraction;
    proto.setInteraction = function (this: PathingEntity, ...a: unknown[]): boolean {
        const set = setInteraction.apply(this, a);
        noteSafely(this);
        return set;
    };
    proto.clearInteraction = function (this: PathingEntity, ...a: unknown[]): void {
        clearInteraction.apply(this, a);
        noteSafely(this);
    };
}

/** Can the index answer (installed, nothing went wrong)? */
export function aggressorIndexReady(): boolean {
    return installed && !broken;
}

/**
 * BotAction._findNpc(cx, cz, level, radius, acts), for a predicate true only of NPCs whose target is `player`: the
 * same NPC. `getZone` is GameMap.getZone; `search` is that _findNpc call (the answer for anything unusual).
 */
export function findTargeting(player: Player, cx: number, cz: number, level: number, radius: number, acts: (npc: Npc) => boolean, getZone: (x: number, z: number, level: number) => Zone, search: () => Npc | null): Npc | null {
    const set = targetedBy.get(player);
    if (set === undefined || set.size === 0) return null;
    const zr = Math.ceil(radius / 8) + 1;
    const side = 2 * zr + 1;
    const limit = radius * 2;
    const zx0 = cx >> 3;
    const zz0 = cz >> 3;
    let best: Npc | null = null;
    let bestDist = Infinity;
    let bestOrder = Infinity;
    for (const npc of set) {
        if (!inSomeZone(npc)) continue; // (no search finds it)
        const zone = getZone(npc.x, npc.z, npc.level);
        if (!zoneHasNpc(zone, npc)) return search();
        if (npc.level !== level) continue;
        const zdx = (npc.x >> 3) - zx0;
        const zdz = (npc.z >> 3) - zz0;
        if (zdx < -zr || zdx > zr || zdz < -zr || zdz > zr) continue;
        if (!npc.isValid()) continue;
        const dist = Math.abs(npc.x - cx) + Math.abs(npc.z - cz);
        if (dist > limit || dist > bestDist) continue;
        const order = (zdz + zr) * side + (zdx + zr);
        if (dist === bestDist && (order > bestOrder || (order === bestOrder && !npcBefore(zone, npc, best!)))) continue;
        if (!acts(npc)) continue;
        best = npc;
        bestDist = dist;
        bestOrder = order;
    }
    return best;
}
