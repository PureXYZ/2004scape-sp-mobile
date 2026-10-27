#!/usr/bin/env node
// runtime/iterators.ts (the engine's collection loops without generators) against upstream's own generators: the
// pinned EntityList, LinkList, DoublyLinkList, HashTable and Zone sources are bundled (Zone's other imports stubbed:
// its generators only touch its lists, isValid() and CoordGrid), every seeded program runs once on the originals and
// once after installPlainIterators(), and the traces must be identical: what each step hands out, the list's cursor at
// every step (nested walks of the same list save and restore it), the final order, and the next()/return() results
// when a program drives an iterator by hand (before the first step, after the end, twice). The programs unlink the
// current node and others, add nodes, walk the same list inside the walk, break out, walk in reverse, set and remove
// npcs (also above the highest id so far) and reset the list, flip validity and throw from isValid().
// Then deliberately wrong iterators must be caught, so the programs can see what they claim to check.
//
//   node web/engine/test/iterators.test.mjs [--cases=3000]
import path from 'node:path';

import { importBundled } from './lib/bundle.mjs';

const CASES = Number((process.argv.find(a => a.startsWith('--cases=')) ?? '--cases=3000').split('=')[1]);

const ZONE_IMPORTS_KEPT = new Set(['#/engine/CoordGrid.js', '#/datastruct/LinkList.js', '#/datastruct/DoublyLinkList.js']);
const zoneImportsStub = {
    name: 'zone-imports-stub',
    setup(build) {
        const zoneTs = path.join('engine', 'zone', 'Zone.ts');
        build.onResolve({ filter: /^#\// }, a => (a.importer.endsWith(zoneTs) && !ZONE_IMPORTS_KEPT.has(a.path) ? { path: a.path, namespace: 'zone-stub' } : undefined));
        build.onLoad({ filter: /.*/, namespace: 'zone-stub' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
    }
};

const M = await importBundled(
    'iterators-test',
    `export { default as LinkList } from '#/datastruct/LinkList.js';
export { default as DoublyLinkList } from '#/datastruct/DoublyLinkList.js';
export { default as HashTable } from '#/datastruct/HashTable.js';
export { NpcList } from '#/engine/entity/EntityList.js';
export { default as Zone } from '#/engine/zone/Zone.js';
export { CoordGrid } from '#/engine/CoordGrid.js';
export { installPlainIterators } from './runtime/iterators.js';`,
    undefined,
    [zoneImportsStub]
);
const { LinkList, DoublyLinkList, HashTable, NpcList, Zone, CoordGrid, installPlainIterators } = M;
const EntityList = Object.getPrototypeOf(NpcList.prototype);
const ZONE_METHODS = ['getAllPlayersSafe', 'getAllNpcsSafe', 'getAllObjsSafe', 'getObjsSafe', 'getObjsUnsafe', 'getAllObjsUnsafe', 'getAllLocsSafe', 'getLocsSafe', 'getLocsUnsafe', 'getAllLocsUnsafe', 'getAllNpcsUnsafe', 'getAllPlayersUnsafe'];
const ZONE_LIST = m => (/Players/.test(m) ? 'players' : /Npcs/.test(m) ? 'npcs' : /Objs/.test(m) ? 'objs' : 'locs');

// ---- seeded programs ---------------------------------------------------------------------------------------------

let seed = 1;
const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const ri = n => Math.floor(rnd() * n);
const tag = (x, sentinel) => (x === null ? 'null' : x === undefined ? 'undef' : x === sentinel ? 'S' : (x.id ?? '?'));
const res = (r, sentinel) => `${r.done ? 'D' : 'v'}${tag(r.value, sentinel)}`;

function linkProgram(doubly) {
    const list = doubly ? new DoublyLinkList() : new LinkList();
    const sentinel = list.sentinel;
    const Node = sentinel.constructor;
    const unlink = doubly ? 'unlink2' : 'unlink';
    const nodes = [];
    const add = () => {
        const n = new Node();
        n.id = nodes.length;
        nodes.push(n);
        if (doubly || ri(2)) list.addTail(n);
        else list.addHead(n);
    };
    for (let i = ri(8); i > 0; i--) add();
    const trace = [];
    const walk = depth => {
        const reverse = ri(4) === 0;
        let steps = 0;
        for (const node of list.all(reverse)) {
            trace.push(`${depth}:${node.id}@${tag(list.cursor, sentinel)}`);
            if (++steps > 40) break;
            const r = ri(12);
            if (r === 0) node[unlink]();
            else if (r === 1 && nodes.length) nodes[ri(nodes.length)][unlink]();
            else if (r === 2) add();
            else if (r === 3 && depth < 2) walk(depth + 1);
            else if (r === 4) break;
        }
        trace.push(`${depth}:end@${tag(list.cursor, sentinel)}`);
    };
    walk(0);
    if (ri(2)) {
        // by hand: next/return in any order, also before the start and after the end
        const it = list.all(ri(3) === 0);
        for (let k = ri(10); k > 0; k--) {
            const r = ri(5);
            if (r === 0) trace.push(`ret:${res(it.return(k), sentinel)}`);
            else if (r === 1 && nodes.length) nodes[ri(nodes.length)][unlink]();
            else trace.push(`next:${res(it.next(), sentinel)}@${tag(list.cursor, sentinel)}`);
        }
    }
    const order = [];
    for (let n = sentinel[doubly ? 'next2' : 'next'], g = 0; n !== sentinel && n && g < 1000; n = n[doubly ? 'next2' : 'next'], g++) order.push(n.id);
    trace.push(`order:${order}`, `cursor:${tag(list.cursor, sentinel)}`);
    return trace.join(' ');
}

function hashProgram() {
    const table = new HashTable(1 << ri(4));
    const Node = table.buckets[0].constructor;
    const nodes = [];
    const add = () => {
        const n = new Node();
        n.id = nodes.length;
        nodes.push(n);
        table.add(BigInt(ri(16)), n);
    };
    for (let i = ri(10); i > 0; i--) add();
    const trace = [];
    const walk = depth => {
        let steps = 0;
        for (const node of table.all()) {
            trace.push(`${depth}:${node.id}`);
            if (++steps > 40) break;
            const r = ri(9);
            if (r === 0) node.unlink();
            else if (r === 1 && nodes.length) nodes[ri(nodes.length)].unlink();
            else if (r === 2) add();
            else if (r === 3 && depth < 2) walk(depth + 1);
            else if (r === 4) break;
        }
        trace.push(`${depth}:end`);
    };
    walk(0);
    if (ri(2)) {
        const it = table.all();
        for (let k = ri(10); k > 0; k--) {
            const r = ri(5);
            if (r === 0) trace.push(`ret:${res(it.return(k))}`);
            else if (r === 1 && nodes.length) nodes[ri(nodes.length)].unlink();
            else if (r === 2) add();
            else trace.push(`next:${res(it.next())}`);
        }
    }
    trace.push(`buckets:${table.buckets.map(s => [...(function* () { for (let n = s.next; n !== s; n = n.next) yield n.id; })()].join('.')).join('|')}`);
    return trace.join(' ');
}

function entityProgram() {
    const size = 4 + ri(60);
    const list = new NpcList(size);
    const trace = [];
    let made = 0;
    const set = (id = ri(size)) => {
        try {
            list.set(id, { id: made++ });
        } catch (e) {
            trace.push(`x${id}`);
        }
    };
    for (let i = ri(size); i > 0; i--) set(ri(ri(2) ? size : Math.max(1, size >> 2))); // often only low ids: the walk's end matters
    if (ri(8) === 0) list.reset();
    const walk = depth => {
        let steps = 0;
        for (const e of list) {
            trace.push(`${depth}:${e.id}`);
            if (++steps > 100) break;
            const r = ri(14);
            if (r === 0) list.remove(ri(size));
            else if (r === 1) set();
            else if (r === 2) set(size - 1 - ri(4)); // above the highest id so far
            else if (r === 3 && depth < 2) walk(depth + 1);
            else if (r === 4) break;
            else if (r === 5 && ri(8) === 0) list.reset();
        }
        trace.push(`${depth}:end`);
    };
    walk(0);
    if (ri(2)) {
        const it = list[Symbol.iterator]();
        for (let k = ri(12); k > 0; k--) {
            const r = ri(6);
            if (r === 0) trace.push(`ret:${res(it.return(k))}`);
            else if (r === 1) set();
            else if (r === 2) list.remove(ri(size));
            else trace.push(`next:${res(it.next())}`);
        }
    }
    trace.push(`all:${[...list].map(e => e.id)}`, `count:${list.count}`);
    return trace.join(' ');
}

class Thrown extends Error {}

function zoneProgram(method) {
    const zone = Object.create(Zone.prototype); // (Zone's constructor needs ZoneMap; its generators only read the lists)
    zone.players = new DoublyLinkList();
    zone.npcs = new DoublyLinkList();
    zone.locs = new LinkList();
    zone.objs = new LinkList();
    const name = ZONE_LIST(method);
    const list = zone[name];
    const sentinel = list.sentinel;
    const doubly = name === 'players' || name === 'npcs';
    const unlink = doubly ? 'unlink2' : 'unlink';
    const Node = sentinel.constructor;
    const coords = [CoordGrid.packZoneCoord(3200, 3200), CoordGrid.packZoneCoord(3201, 3203), CoordGrid.packZoneCoord(3207, 3201)];
    const nodes = [];
    let throwing = false;
    const make = () => {
        const n = new Node();
        n.id = nodes.length;
        n.valid = ri(3) !== 0;
        n.x = 3200 + [0, 1, 7][ri(3)];
        n.z = 3200 + [0, 3, 1][ri(3)];
        n.isValid = function () {
            if (throwing && ri(3) === 0) throw new Thrown(`isValid ${this.id}`);
            return this.valid;
        };
        nodes.push(n);
        list.addTail(n);
    };
    const flip = () => {
        const n = nodes[ri(nodes.length)];
        n.valid = !n.valid;
    };
    for (let i = ri(8); i > 0; i--) make();
    const call = () => (/^get(Objs|Locs)(Safe|Unsafe)$/.test(method) ? zone[method](coords[ri(3)]) : zone[method](ri(3) === 0));
    const trace = [];
    const walk = depth => {
        let steps = 0;
        const it = call();
        try {
            for (const n of it) {
                trace.push(`${depth}:${n.id}@${tag(list.cursor, sentinel)}`);
                if (++steps > 40) break;
                const r = ri(9);
                if (r === 0 && nodes.length) flip();
                else if (r === 1) n[unlink]();
                else if (r === 2) make();
                else if (r === 3 && depth < 2) walk(depth + 1);
                else if (r === 4) break;
            }
        } catch (e) {
            if (!(e instanceof Thrown)) throw e;
            trace.push(`${depth}:threw ${e.message}`, `after:${res(it.next(), sentinel)}`);
        }
        trace.push(`${depth}:end@${tag(list.cursor, sentinel)}`);
    };
    throwing = ri(4) === 0;
    walk(0);
    throwing = false;
    if (ri(2)) {
        const it = call();
        for (let k = ri(10); k > 0; k--) {
            const r = ri(5);
            if (r === 0) trace.push(`ret:${res(it.return(k), sentinel)}`);
            else if (r === 1 && nodes.length) flip();
            else trace.push(`next:${res(it.next(), sentinel)}@${tag(list.cursor, sentinel)}`);
        }
    }
    trace.push(`cursor:${tag(list.cursor, sentinel)}`);
    return trace.join(' ');
}

const PROGRAMS = {
    link: () => linkProgram(false),
    doubly: () => linkProgram(true),
    hash: hashProgram,
    entity: entityProgram,
    ...Object.fromEntries(ZONE_METHODS.map(m => [`zone.${m}`, () => zoneProgram(m)]))
};

function runAll(kinds = Object.keys(PROGRAMS)) {
    const out = {};
    for (const kind of kinds) {
        out[kind] = [];
        const k = Object.keys(PROGRAMS).indexOf(kind);
        for (let c = 0; c < CASES; c++) {
            seed = 1000 + c * 7919 + k * 104729;
            out[kind].push(PROGRAMS[kind]());
        }
    }
    return out;
}

function compare(a, b) {
    const diff = {};
    for (const kind of Object.keys(a)) {
        const d = a[kind].filter((t, i) => t !== b[kind][i]).length;
        if (d) diff[kind] = d;
    }
    return diff;
}

// ---- upstream, then the plain iterators ----------------------------------------------------------------------------

const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
const upstream = { link: LinkList.prototype.all, doubly: DoublyLinkList.prototype.all, hash: HashTable.prototype.all, entity: EntityList[Symbol.iterator], ...Object.fromEntries(ZONE_METHODS.map(m => [m, Zone.prototype[m]])) };
const notGenerators = Object.entries(upstream).filter(([, f]) => !(f instanceof GeneratorFunction)).map(([k]) => k);
if (notGenerators.length) {
    console.log(`iterators: FAIL - upstream's ${notGenerators.join(', ')} are no longer generator methods: re-check runtime/iterators.ts against them`);
    process.exit(1);
}

let failed = false;
const reference = runAll();
installPlainIterators({ entityList: EntityList, linkList: LinkList, doublyLinkList: DoublyLinkList, hashTable: HashTable, zone: Zone, coordGrid: CoordGrid });
if (LinkList.prototype.all instanceof GeneratorFunction || EntityList[Symbol.iterator] instanceof GeneratorFunction) {
    console.log('iterators: FAIL - installPlainIterators did not replace the generators');
    process.exit(1);
}
const plain = runAll();
const diff = compare(reference, plain);
const programs = Object.values(plain).reduce((n, a) => n + a.length, 0);
if (Object.keys(diff).length) {
    failed = true;
    console.log(`different traces: ${JSON.stringify(diff)}`);
    for (const kind of Object.keys(diff)) {
        const i = reference[kind].findIndex((t, k) => t !== plain[kind][k]);
        console.log(`  ${kind} case ${i}\n    upstream: ${reference[kind][i].slice(0, 400)}\n    plain:    ${plain[kind][i].slice(0, 400)}`);
    }
}

// ---- the programs must catch plausible mistakes ----------------------------------------------------------------

const plainAll = { link: LinkList.prototype.all, entity: EntityList[Symbol.iterator], hash: HashTable.prototype.all, zone: Zone.prototype.getAllNpcsSafe };
const iter = next => ({ next, return: v => ({ value: v, done: true }), [Symbol.iterator]() { return this; } });
const mutants = {
    // the cursor not put back after a step (a nested walk of the same list derails the outer one)
    'link: no cursor restore': [['link'], () => {
        LinkList.prototype.all = function (reverse = false) {
            let started = false;
            return iter(() => {
                const link = started ? (reverse ? this.prev() : this.next()) : reverse ? this.tail() : this.head();
                started = true;
                return link === null ? { value: undefined, done: true } : { value: link, done: false };
            });
        };
    }],
    // the walk ends one slot early (the highest id set is missed)
    'entity: stops before the highest id': [['entity'], () => {
        EntityList[Symbol.iterator] = function () {
            let i = 0;
            return iter(() => {
                let top = -1;
                for (let k = 0; k < this.ids.length; k++) if (this.ids[k] !== -1) top = k;
                while (i < top) {
                    const index = this.ids[i++];
                    if (index !== -1 && this[index] !== undefined) return { value: this[index], done: false };
                }
                return { value: undefined, done: true };
            });
        };
    }],
    // the next node read after the current one is handed out (a removal during the walk ends or derails it)
    'hash: next node read late': [['hash'], () => {
        HashTable.prototype.all = function* () {
            for (let bucket = 0; bucket < this.bucketCount; bucket++) {
                const sentinel = this.buckets[bucket];
                for (let node = sentinel.next; node !== null && node !== sentinel; node = node.next) yield node;
            }
        };
    }],
    // the filter applied to the list's iterator up front (isValid() read too early)
    'zone: filter read ahead': [['zone.getAllNpcsSafe'], () => {
        Zone.prototype.getAllNpcsSafe = function (reverse = false) {
            let valid = null;
            let i = 0;
            return iter(() => {
                if (valid === null) {
                    valid = [];
                    valid = [...this.npcs.all(reverse)].filter(n => n.isValid());
                }
                return i < valid.length ? { value: valid[i++], done: false } : { value: undefined, done: true };
            });
        };
    }]
};
const caught = {};
for (const [name, [kinds, install]] of Object.entries(mutants)) {
    install();
    const d = compare(Object.fromEntries(kinds.map(k => [k, reference[k]])), runAll(kinds));
    caught[name] = Object.values(d).reduce((n, x) => n + x, 0);
    LinkList.prototype.all = DoublyLinkList.prototype.all = plainAll.link;
    EntityList[Symbol.iterator] = plainAll.entity;
    HashTable.prototype.all = plainAll.hash;
    Zone.prototype.getAllNpcsSafe = plainAll.zone;
    if (!caught[name]) {
        failed = true;
        console.log(`mutant not caught: ${name}`);
    }
}

console.log(
    failed
        ? 'iterators: FAIL'
        : `iterators: PASS - ${programs} programs identical to upstream's generators (${Object.keys(PROGRAMS).length} kinds x ${CASES}); wrong iterators caught: ${Object.entries(caught).map(([k, n]) => `${k} (${n})`).join(', ')}`
);
process.exit(failed ? 1 : 0);
