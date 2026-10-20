// Rev-254 inventory semantics on top of the rev-274 Inventory, for the places where the bots rely on them.
//
// 254's `add(id, count)` was all-or-nothing (assureFullInsertion = true) and returned a transaction whose
// `hasSucceeded()` the bots used as "I got all of it"; 274's add inserts what fits and returns the count, so the
// bots' `add(...) > 0` would count a partial insert as success (a shop trip paying for 5 items and receiving 2).
// `remove` was partial in both revisions: only `.completed` went away. test/inventory.test.mjs checks canAddAll /
// invAddAll against the real 254 class on random inventories.
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import { Inventory } from '#/engine/Inventory.js';

function stacks(inv: Inventory, id: number): boolean {
    return inv.stackType !== Inventory.NEVER_STACK && (ObjType.get(id).stackable || inv.stackType === Inventory.ALWAYS_STACK);
}

/** Would 254's `add(id, count)` (assureFullInsertion) insert everything? A line-for-line port of its pre-checks. */
export function canAddAll(inv: Inventory, id: number, count: number): boolean {
    const stack = stacks(inv, id);
    const stockObj = InvType.get(inv.type).stockobj?.includes(id) === true;
    const previousCount = stack ? inv.getItemCount(id) : 0;
    if (previousCount === Inventory.STACK_LIMIT) return false;
    const free = inv.freeSlotCount;
    if (free === 0 && (!stack || (previousCount === 0 && !stockObj))) return false;
    if (stack && previousCount > Inventory.STACK_LIMIT - count) return false;
    if (!stack && count > free) return false;
    return true;
}

/** 254's `inv.add(id, count).hasSucceeded()`: adds everything or nothing. */
export function invAddAll(inv: Inventory, id: number, count: number): boolean {
    if (!canAddAll(inv, id, count)) return false;
    return inv.add(id, count) === count;
}

/** How many of `id` the inventory can take right now (274 add: one free slot per unstacked item, stacks capped). */
export function roomFor(inv: Inventory, id: number): number {
    if (!stacks(inv, id)) return inv.freeSlotCount;
    const slot = inv.getItemIndex(id);
    if (slot === -1) return inv.freeSlotCount > 0 ? Inventory.STACK_LIMIT : 0;
    return Inventory.STACK_LIMIT - (inv.get(slot)?.count ?? 0);
}

/**
 * Moves up to `count` of `id` between inventories (a bank withdrawal, unequipping), clamped to what the target can
 * take, so nothing is lost: 254 deleted the whole removal when the target was short of room, and a plain 274 add
 * drops the excess. Returns the number moved.
 */
export function moveItems(from: Inventory, to: Inventory, id: number, count: number): number {
    const n = Math.min(count, roomFor(to, id));
    if (n <= 0) return 0;
    const removed = from.remove(id, n);
    if (removed <= 0) return 0;
    const added = to.add(id, removed);
    if (added < removed) from.add(id, removed - added);
    return added;
}

/**
 * port (the variety work, round 2, the fixes): a deposit of up to `count` of `id` from the pack into the bank, as its banked
 * form (bankedId: a note as its item), clamped to what the bank can take; what it could not take stays in the pack.
 * Returns the number moved. A remove from the pack and an add to a full bank lost the rest (274's add drops it): a status
 * piece's note worth 40k-700k (port/BotShowOff), an errand's deposit
 */
export function depositItems(inv: Inventory, bank: Inventory, id: number, count: number): number {
    const into = bankedId(id);
    const n = Math.min(count, roomFor(bank, into));
    if (n <= 0) return 0;
    const removed = inv.remove(id, n);
    if (removed <= 0) return 0;
    const added = bank.add(into, removed);
    if (added < removed) inv.add(id, removed - added);
    return added;
}

/**
 * port: the item a bank keeps for this one: a note goes in as its item, as 274's bank does (inv_moveitem_uncert).
 * Upstream's deposits added notes as notes: a bankstander's noted stock stayed noted in the bank, where no skilling
 * task counts it (100 raw shrimps a cook never saw again).
 */
export function bankedId(id: number): number {
    const type = ObjType.get(id);
    return type.certtemplate !== -1 && type.certlink !== -1 ? type.certlink : id;
}
