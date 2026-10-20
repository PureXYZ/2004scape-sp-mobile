#!/usr/bin/env node
// port/BotInventoryCompat against rev 254's own Inventory class (test/ref/Inventory254.ts), on random inventories of
// every kind the bots touch (the 28-slot inventory, the bank, a shop with stock objs, a never-stacking one):
//   add     invAddAll(inv274, id, n) === inv254.add(id, n).hasSucceeded() (254 adds all or nothing), canAddAll
//           predicts it, and both inventories hold the same items afterwards;
//   remove  inv274.remove(id, n) === inv254.remove(id, n).completed (partial in both), same items afterwards;
//   room    roomFor(inv, id) is exactly what fits: 254 would add that many and refuse one more;
//   move    moveItems(from, to, id, n) moves min(n, held, room) and never loses or creates an item.
//
//   node web/engine/bots/test/inventory.test.mjs [--trials=40000] [--seed=1]
import path from 'path';
import { BOTS_DIR } from './lib/paths.mjs';
import { importInEngine } from './lib/clone.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const TRIALS = Number(args.trials ?? 40000);

let seed = Number(args.seed ?? 1) >>> 0 || 1;
function random() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
const pick = list => list[Math.floor(random() * list.length)];

const lib = await importInEngine(path.join(BOTS_DIR, 'test/lib/inventory.ts'), 'unit-inv');
lib.load('data/pack');
const { Inventory, Inventory254, InvType, ObjType } = lib;
const LIMIT = Inventory.STACK_LIMIT;

// ---- inventory kinds and items ----
const invId = name => {
    const id = InvType.getId(name);
    if (id === -1) throw new Error(`no inv ${name}`);
    return id;
};
let shop = -1;
for (let id = 0; id < InvType.count && shop === -1; id++) {
    const t = InvType.get(id);
    if (t.stockobj && t.stockobj.length >= 3) shop = id;
}
if (shop === -1) throw new Error('no shop inventory with stock objs');
const stackTypeOf = id => (InvType.get(id).stackall ? Inventory.ALWAYS_STACK : Inventory.NORMAL_STACK);
const KINDS = [
    { name: 'inv', type: invId('inv'), capacity: InvType.get(invId('inv')).size, stackType: stackTypeOf(invId('inv')) },
    { name: 'bank', type: invId('bank'), capacity: InvType.get(invId('bank')).size, stackType: stackTypeOf(invId('bank')) },
    { name: `shop (${InvType.get(shop).debugname})`, type: shop, capacity: InvType.get(shop).size, stackType: stackTypeOf(shop), stock: InvType.get(shop).stockobj },
    { name: 'never-stack', type: invId('inv'), capacity: 28, stackType: Inventory.NEVER_STACK }
];
const objId = name => {
    const id = ObjType.getId(name);
    if (id === -1) throw new Error(`no obj ${name}`);
    return id;
};
const POOL = [
    ...['coins', 'airrune', 'bronze_arrow', 'cert_logs', 'logs', 'bronze_axe', 'shrimp', 'bones', 'uncut_sapphire'].map(objId),
    ...new Set(KINDS.flatMap(k => [...(k.stock ?? [])])) // stockobj is a typed array
];
const stacks = (kind, id) => kind.stackType !== Inventory.NEVER_STACK && (ObjType.get(id).stackable || kind.stackType === Inventory.ALWAYS_STACK);

/** A random valid state: one stack per stacking id, non-stacking items one per slot, shop stock in its slots. */
function randomState(kind) {
    const slots = new Array(kind.capacity).fill(null);
    const fill = random();
    const seen = new Set();
    if (kind.stock) {
        kind.stock.forEach((id, i) => {
            slots[i] = { id, count: random() < 0.3 ? 0 : randInt(1, 50) };
            seen.add(id);
        });
    }
    for (let i = kind.stock?.length ?? 0; i < kind.capacity; i++) {
        if (random() > fill) continue;
        const id = pick(POOL);
        if (stacks(kind, id)) {
            if (seen.has(id)) continue;
            seen.add(id);
            const r = random();
            slots[i] = { id, count: r < 0.1 ? LIMIT - randInt(0, 40) : r < 0.2 ? randInt(1, LIMIT) : randInt(1, 500) };
        } else {
            slots[i] = { id, count: 1 };
        }
    }
    return slots;
}
function build(Class, kind, slots) {
    const inv = new Class(kind.type, kind.capacity, kind.stackType);
    slots.forEach((item, i) => {
        if (item) inv.items[i] = { id: item.id, count: item.count };
    });
    return inv;
}
const same = (a, b) => a.items.every((x, i) => (x === null ? b.items[i] === null : b.items[i] !== null && x.id === b.items[i].id && x.count === b.items[i].count));
const show = inv => JSON.stringify(inv.items.map((x, i) => (x ? `${i}:${x.id}x${x.count}` : null)).filter(Boolean));
const held = inv => inv.items.filter(Boolean).map(x => x.id);

function randomCount(kind, inv, id) {
    const r = random();
    if (r < 0.6) return randInt(1, 30);
    if (r < 0.7) return randInt(1, LIMIT);
    if (r < 0.85) return Math.max(1, LIMIT - inv.getItemCount(id) + randInt(-2, 2));
    return Math.max(1, inv.freeSlotCount + randInt(-1, 1));
}

// ---- the trials ----
const failures = [];
const fail = (what, detail) => {
    if (failures.length < 20) failures.push(`${what}: ${detail}`);
    else failures.length++;
};
const stats = { add: 0, addAll: 0, addRefused: 0, remove: 0, room: 0, move: 0, moveClamped: 0 };

for (let trial = 0; trial < TRIALS; trial++) {
    const kind = pick(KINDS);
    const slots = randomState(kind);
    const a = build(Inventory, kind, slots);
    const b = build(Inventory254, kind, slots);
    const id = random() < 0.5 && held(a).length ? pick(held(a)) : pick(POOL);
    const op = pick(['add', 'add', 'remove', 'room', 'move']);
    const where = `trial ${trial} ${kind.name} id ${id}`;

    if (op === 'add') {
        const n = randomCount(kind, a, id);
        const predicted = lib.canAddAll(a, id, n);
        const got = lib.invAddAll(a, id, n);
        const want = b.add(id, n).hasSucceeded();
        stats.add++;
        if (want) stats.addAll++;
        else stats.addRefused++;
        if (got !== want || predicted !== want) fail('add', `${where} n ${n}: invAddAll ${got}, canAddAll ${predicted}, 254 ${want}`);
        else if (!same(a, b)) fail('add', `${where} n ${n}: contents differ\n  274 ${show(a)}\n  254 ${show(b)}`);
    } else if (op === 'remove') {
        const n = randomCount(kind, a, id);
        const got = a.remove(id, n);
        const want = b.remove(id, n).completed;
        stats.remove++;
        if (got !== want) fail('remove', `${where} n ${n}: 274 removed ${got}, 254 ${want}`);
        else if (!same(a, b)) fail('remove', `${where} n ${n}: contents differ`);
    } else if (op === 'room') {
        const room = lib.roomFor(a, id);
        stats.room++;
        const fits = n => b.add(id, n, -1, true, false, true).hasSucceeded();
        if (room > 0 && !fits(room)) fail('room', `${where}: roomFor ${room}, but 254 would not add that many`);
        if (room < LIMIT && fits(room + 1)) fail('room', `${where}: roomFor ${room}, but 254 would add ${room + 1}`);
        if (room > 0 && !lib.canAddAll(a, id, room)) fail('room', `${where}: roomFor ${room}, but canAddAll refuses it`);
    } else {
        const toKind = pick(KINDS.filter(k => k.name !== kind.name));
        const to = build(Inventory, toKind, randomState(toKind));
        const n = randomCount(toKind, to, id);
        const before = { from: a.getItemCount(id), to: to.getItemCount(id), room: lib.roomFor(to, id) };
        const others = inv => inv.items.map(x => (x && x.id !== id ? `${x.id}x${x.count}` : '-')).join(); // every other slot as it was
        const othersBefore = [others(a), others(to)];
        const moved = lib.moveItems(a, to, id, n);
        const expected = Math.min(n, before.from, before.room);
        stats.move++;
        if (expected < Math.min(n, before.from)) stats.moveClamped++;
        if (moved !== expected) fail('move', `${where} -> ${toKind.name} n ${n}: moved ${moved}, expected min(${n}, held ${before.from}, room ${before.room})`);
        if (a.getItemCount(id) !== before.from - moved || to.getItemCount(id) !== before.to + moved) fail('move', `${where} -> ${toKind.name} n ${n}: items lost or created`);
        if (others(a) !== othersBefore[0] || others(to) !== othersBefore[1]) fail('move', `${where} -> ${toKind.name}: other items changed`);
    }
}

// ---- edges, spelled out ----
{
    const inv = KINDS[0];
    const coins = objId('coins');
    const logs = objId('logs');
    const check = (what, ok) => {
        if (!ok) fail('edge', what);
    };
    let a = build(Inventory, inv, [{ id: coins, count: LIMIT - 5 }]);
    check('a stack 5 short of the limit takes 5', lib.canAddAll(a, coins, 5) && !lib.canAddAll(a, coins, 6));
    a = build(Inventory, inv, new Array(28).fill({ id: logs, count: 1 }));
    check('a full inventory refuses coins it has no stack of', !lib.canAddAll(a, coins, 1) && lib.roomFor(a, coins) === 0);
    a = build(Inventory, inv, [{ id: coins, count: 10 }, ...new Array(27).fill({ id: logs, count: 1 })]);
    check('a full inventory takes coins onto its stack', lib.invAddAll(a, coins, 100) && a.getItemCount(coins) === 110);
    const bank = build(Inventory, KINDS[1], [{ id: logs, count: 500 }]);
    a = build(Inventory, inv, new Array(25).fill({ id: logs, count: 1 }));
    check('a withdrawal of 28 logs into 3 free slots moves 3 and keeps 497 in the bank', lib.moveItems(bank, a, logs, 28) === 3 && bank.getItemCount(logs) === 497);
}

const total = TRIALS + 4;
console.log(`inventory: ${TRIALS} random trials (${stats.add} add: ${stats.addAll} all-in, ${stats.addRefused} refused; ${stats.remove} remove; ${stats.room} roomFor; ${stats.move} moveItems, ${stats.moveClamped} clamped by room) + 4 edges, against rev 254's Inventory`);
if (failures.length) {
    for (const f of failures.filter(Boolean)) console.log(`FAIL ${f}`);
    console.log(`${failures.length} failure(s) in ${total} checks`);
    process.exit(1);
}
console.log('identical');
