// port (perf, 2026-10-23): the bots' nearest-NPC, loc and ground-item searches (BotAction._findNpc, _findLoc, _findObj)
// walk a zone's lists without the engine's generators. Zone.getAll*Safe() is a generator over a generator (Zone ->
// DoublyLinkList/LinkList.all) for every zone of a 25-121-zone square, and resuming them cost far more than the work
// in JavaScriptCore: the bots' NPC searches alone were 8 % of the world tick there at 1000 bots, a sixth of the bots'
// garbage. These loops walk the same lists in the same order with the same isValid() filter and the same rule for the
// next node (read before the node is handed out, as all() reads its cursor), and leave the list's cursor as a finished
// all() leaves it (null), so every search returns the same entity with its predicate called on the same entities in
// the same order. They read the engine's private list fields (Zone's npcs/locs/objs, a list's sentinel; a node's
// next2/next); test/exact.test.mjs compares every search of a seeded world with the engine's generators.
import type Loc from '#/engine/entity/Loc.js';
import type Npc from '#/engine/entity/Npc.js';
import type Obj from '#/engine/entity/Obj.js';
import type Zone from '#/engine/zone/Zone.js';

type DoublyNode = { next2: DoublyNode | null };
type Node = { next: Node | null };
type ZoneLists = { npcs: { sentinel: DoublyNode; cursor: unknown }; locs: { sentinel: Node; cursor: unknown }; objs: { sentinel: Node; cursor: unknown } };

export interface Nearest<T> {
    found: T | null;
    dist: number;
}

/** One zone of _findNpc: the nearest valid NPC (Manhattan) within `limit` that passes `predicate`, nearer than `best`. */
export function nearestNpcIn(zone: Zone, cx: number, cz: number, limit: number, best: Nearest<Npc>, predicate: (npc: Npc) => boolean): void {
    const list = (zone as unknown as ZoneLists).npcs;
    const sentinel = list.sentinel;
    let node = sentinel.next2;
    while (node !== null && node !== sentinel) {
        const next = node.next2;
        const npc = node as unknown as Npc;
        if (npc.isValid()) {
            const dist = Math.abs(npc.x - cx) + Math.abs(npc.z - cz);
            if (!(dist > limit || dist >= best.dist || !predicate(npc))) {
                best.dist = dist;
                best.found = npc;
            }
        }
        node = next;
    }
    list.cursor = null;
}

/** One zone of _findLoc: the distance first, the predicate only for a loc that would be the nearest so far. */
export function nearestLocIn(zone: Zone, cx: number, cz: number, limit: number, best: Nearest<Loc>, predicate: (loc: Loc) => boolean): void {
    const list = (zone as unknown as ZoneLists).locs;
    const sentinel = list.sentinel;
    let node = sentinel.next;
    while (node !== null && node !== sentinel) {
        const next = node.next;
        const loc = node as unknown as Loc;
        if (loc.isValid()) {
            const dist = Math.abs(loc.x - cx) + Math.abs(loc.z - cz);
            if (!(dist > limit || dist >= best.dist) && predicate(loc)) {
                best.dist = dist;
                best.found = loc;
            }
        }
        node = next;
    }
    list.cursor = null;
}

/** One zone of _findObj: the predicate first (every valid item), then whom the item shows to, then the distance. */
export function nearestObjIn(zone: Zone, cx: number, cz: number, limit: number, best: Nearest<Obj>, predicate: (obj: Obj) => boolean, visible: (obj: Obj) => boolean): void {
    const list = (zone as unknown as ZoneLists).objs;
    const sentinel = list.sentinel;
    let node = sentinel.next;
    while (node !== null && node !== sentinel) {
        const next = node.next;
        const obj = node as unknown as Obj;
        if (obj.isValid() && predicate(obj) && visible(obj)) {
            const dist = Math.abs(obj.x - cx) + Math.abs(obj.z - cz);
            if (dist <= limit && dist < best.dist) {
                best.dist = dist;
                best.found = obj;
            }
        }
        node = next;
    }
    list.cursor = null;
}

/** Is the NPC in some zone's list? (a node in none has no next2: Zone.leave unlinks it, World.removeNpc leaves) */
export function inSomeZone(npc: Npc): boolean {
    return (npc as unknown as DoublyNode).next2 !== null;
}

/** Is the NPC in this zone's list (valid or not)? */
export function zoneHasNpc(zone: Zone, npc: Npc): boolean {
    const sentinel = (zone as unknown as ZoneLists).npcs.sentinel;
    for (let node = sentinel.next2; node !== null && node !== sentinel; node = node.next2) if ((node as unknown) === npc) return true;
    return false;
}

/** Does `a` come before `b` in this zone's NPC list (both in it)? */
export function npcBefore(zone: Zone, a: Npc, b: Npc): boolean {
    const sentinel = (zone as unknown as ZoneLists).npcs.sentinel;
    for (let node = sentinel.next2; node !== null && node !== sentinel; node = node.next2) {
        if ((node as unknown) === a) return true;
        if ((node as unknown) === b) return false;
    }
    return false;
}
