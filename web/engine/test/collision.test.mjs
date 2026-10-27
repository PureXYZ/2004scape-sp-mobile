#!/usr/bin/env node
// runtime/memory.ts installSharedZeroZones (collision zones share one all-zero array until their first non-zero
// write) against upstream's CollisionEngine: seeded programs run on two copies of the pinned engine (bundled twice),
// one patched - allocations and deallocations, set/add/remove with masks that are 0, negative or above 2^31, every
// change* helper (floors, roofs, npcs, blocks, players, locs and walls of every shape and angle), over a few zones on
// all four levels. Every read (get, isFlagged, isZoneAllocated, zoneCount) must answer the same, and after every step
// both Maps must hold the same keys in the same order with the same 64 values each; the shared array must stay zero
// and must really be shared. A patch that writes into the shared array must be caught.
//
//   node web/engine/test/collision.test.mjs [--cases=2000]
import { importBundled } from './lib/bundle.mjs';

const CASES = Number((process.argv.find(a => a.startsWith('--cases=')) ?? '--cases=2000').split('=')[1]);
const ENTRY = `export { default as CollisionEngine } from '#/engine/routefinder/CollisionEngine.js';
export { installSharedZeroZones } from './runtime/memory.js';`;
const upstream = (await importBundled('collision-upstream', ENTRY)).CollisionEngine;
const patchedModule = await importBundled('collision-patched', ENTRY);
const patched = patchedModule.CollisionEngine;
const ZERO = patchedModule.installSharedZeroZones(patched);
// the same patch with one mistake: add() writes into the shared array instead of copying it
const mutantModule = await importBundled('collision-mutant', ENTRY);
const mutant = mutantModule.CollisionEngine;
const MUTANT_ZERO = mutantModule.installSharedZeroZones(mutant);
const mutantAdd = mutant.prototype.add;
mutant.prototype.add = function (x, z, y, mask) {
    const zone = this.zones.get(mutant.zoneIndex(x, z, y));
    if (zone === MUTANT_ZERO && mask >>> 0 !== 0) {
        zone[(x & 7) | ((z & 7) << 3)] |= mask;
        return;
    }
    return mutantAdd.call(this, x, z, y, mask);
};

let seed = 1;
const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const ri = n => Math.floor(rnd() * n);
const pick = a => a[ri(a.length)];

const MASKS = [0, 1, 0x100, 0x200000, 0x20000, 0x40000, 0x80000, 0x1000000, 0x8000000, 0x40000000, 0x80000000, -1, -0x80000000, 0xffffffff, 0x1ffffffff, 0x280100];
const mask = () => (rnd() < 0.15 ? ri(0x100000000) - 0x80000000 : pick(MASKS));
// a 24x24 area across 9 zones (and its edge), on all four levels
const coord = () => [3200 + ri(26) - 1, 3200 + ri(26) - 1, ri(4)];

/** One operation: [name, args] (a write or a read). */
function op() {
    const [x, z, y] = coord();
    const r = rnd();
    if (r < 0.1) return ['allocateIfAbsent', [x, z, y]];
    if (r < 0.13) return ['deallocateIfPresent', [x, z, y]];
    if (r < 0.25) return ['set', [x, z, y, mask()]];
    if (r < 0.37) return ['add', [x, z, y, mask()]];
    if (r < 0.49) return ['remove', [x, z, y, mask()]];
    if (r < 0.53) return [pick(['changeFloor', 'changeRoof']), [x, z, y, rnd() < 0.6]];
    if (r < 0.58) return [pick(['changeNpc', 'changeBlock', 'changePlayerOcc']), [x, z, y, 1 + ri(3), rnd() < 0.6]];
    if (r < 0.62) return ['changeLoc', [x, z, y, 1 + ri(3), 1 + ri(3), rnd() < 0.5, rnd() < 0.6]];
    if (r < 0.67) return ['changeWall', [x, z, y, ri(4), ri(4), rnd() < 0.5, rnd() < 0.6]];
    if (r < 0.8) return ['get', [x, z, y]];
    if (r < 0.92) return ['isFlagged', [x, z, y, mask()]];
    if (r < 0.97) return ['isZoneAllocated', [x, z, y]];
    return ['zoneCount', []];
}

/** The two Maps: the same keys in the same order, the same 64 values each ('' if equal). */
function compareZones(a, b) {
    if (a.zones.size !== b.zones.size) return `size ${a.zones.size} / ${b.zones.size}`;
    const ka = [...a.zones.keys()];
    const kb = [...b.zones.keys()];
    for (let i = 0; i < ka.length; i++) {
        if (ka[i] !== kb[i]) return `key ${i}: ${ka[i]} / ${kb[i]}`;
        const za = a.zones.get(ka[i]);
        const zb = b.zones.get(kb[i]);
        if (za.length !== zb.length) return `zone ${ka[i]} length`;
        for (let t = 0; t < za.length; t++) if (za[t] !== zb[t]) return `zone ${ka[i]} tile ${t}: ${za[t]} / ${zb[t]}`;
    }
    return '';
}

let failed = 0;
function report(name, ok, detail = '') {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** Runs CASES programs on upstream and on `Engine`: { ops, reads, shared, owned, first difference }. */
function run(Engine, zero) {
    let ops = 0;
    let reads = 0;
    let shared = 0;
    let owned = 0;
    seed = 1;
    for (let c = 0; c < CASES; c++) {
        const a = new upstream();
        const b = new Engine();
        const steps = 50 + ri(400);
        for (let s = 0; s < steps; s++) {
            const [name, args] = op();
            const ra = a[name](...args);
            const rb = b[name](...args);
            ops++;
            if (ra !== undefined || rb !== undefined) reads++;
            if (ra !== rb) return { ops, reads, shared, owned, diff: `case ${c} step ${s}: ${name}(${args.join(', ')}) = ${ra} / ${rb}` };
            const d = compareZones(a, b);
            if (d) return { ops, reads, shared, owned, diff: `case ${c} step ${s} after ${name}(${args.join(', ')}): ${d}` };
        }
        for (const zone of b.zones.values()) zone === zero ? shared++ : owned++;
        if (zero.some(v => v !== 0)) return { ops, reads, shared, owned, diff: `case ${c}: the shared zone was written` };
    }
    return { ops, reads, shared, owned, diff: '' };
}

const r = run(patched, ZERO);
report(`${CASES} programs: every read and every zone identical to upstream's`, r.diff === '', r.diff || `${r.ops} operations, ${r.reads} reads`);
report('zones that stay zero share one array, the others have their own', r.shared > 0 && r.owned > 0 && ZERO.every(v => v === 0), `${r.shared} shared, ${r.owned} own at the ends of the programs`);
const m = run(mutant, MUTANT_ZERO);
report('a patch that writes into the shared array is caught', m.diff !== '', m.diff);

console.log(failed ? `\n${failed} check(s) failed` : '\nPASS  shared zero collision zones: identical to upstream');
process.exit(failed ? 1 : 0);
