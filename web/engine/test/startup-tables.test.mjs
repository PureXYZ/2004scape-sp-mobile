#!/usr/bin/env node
// runtime/startup-tables.ts (Midi.load and AnimFrame.load from the build's table) against upstream's loaders: the
// table is made from the engine's cache by the build step (startup-tables.mjs), then two fresh bundles of the pinned
// sources load the same vfs (the cache, seq.dat, the client config), one with installStartupTables(). Every value the
// loaders leave behind must be identical: Midi.lengths, each AnimFrame's delay/base/length and which ids exist,
// AnimFrame.order, every field of every SeqType (frames, delays, duration...) and the lines they printed. The table
// must really be used (no transform arrays), the originals must run for a missing, unreadable or foreign table (the
// cache's file count or index CRC differ) or a song count that does not match, and a table with one wrong delay must
// be caught.
//
//   node web/engine/test/startup-tables.test.mjs
import fs from 'node:fs';
import path from 'node:path';

import { ENGINE_DIR } from '../../../scripts/lib/upstream.mjs';
import { STARTUP_TABLES, computeStartupTables } from '../startup-tables.mjs';
import { importBundled } from './lib/bundle.mjs';

const PACK = path.join(ENGINE_DIR, 'data/pack');
const VFS_FILES = [...['dat', 'idx0', 'idx1', 'idx2', 'idx3', 'idx4'].map(e => `main_file_cache.${e}`), 'server/seq.dat', 'client/config'];
const TABLE_PATH = STARTUP_TABLES[0];

let failed = 0;
function report(name, ok, detail = '') {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// the Logger records what the loaders print (upstream's prints with colours and exits on a fatal error)
const LOGGER = `export const printed = [];
export function printWarning(m) { printed.push(['printWarning', String(m)]); }
export function printInfo(m) { printed.push(['printInfo', String(m)]); }
export function printDebug(m) { printed.push(['printDebug', String(m)]); }
export function printError(m) { printed.push(['printError', String(m)]); }
export function printFatalError(m) { printed.push(['printFatalError', String(m)]); throw new Error(String(m)); }
`;
const loggerStub = {
    name: 'logger-stub',
    setup(build) {
        build.onResolve({ filter: /^#\/util\/Logger\.js$/ }, a => ({ path: a.path, namespace: 'logger-stub' }));
        build.onLoad({ filter: /.*/, namespace: 'logger-stub' }, () => ({ contents: LOGGER, loader: 'js' }));
    }
};
const ENTRY = `export { default as Midi } from '#/cache/midi/Midi.js';
export { default as AnimFrame } from '#/cache/graphics/AnimFrame.js';
export { default as SeqType } from '#/cache/config/SeqType.js';
export { printed } from '#/util/Logger.js';
export { installStartupTables } from './runtime/startup-tables.js';
`;

const files = new Map(VFS_FILES.map(f => [`/engine/data/pack/${f}`, new Uint8Array(fs.readFileSync(path.join(PACK, f)))]));
const tables = await computeStartupTables({ cacheDir: PACK });

/** A fresh bundle over a fresh vfs (holding `table` as the build's table, unless undefined); what the loaders leave. */
async function load(name, { install, table }) {
    const store = { cwd: '/engine', files: new Map(files), dirs: new Set(), urls: new Map(), loadSync: null };
    if (table !== undefined) store.files.set(TABLE_PATH, typeof table === 'string' ? new TextEncoder().encode(table) : new TextEncoder().encode(JSON.stringify(table)));
    for (const f of store.files.keys()) for (let d = path.posix.dirname(f); ; d = path.posix.dirname(d)) {
        store.dirs.add(d);
        if (d === '/') break;
    }
    globalThis.__LC_VFS__ = store;
    const warned = [];
    const warn = console.warn;
    console.warn = (...a) => {
        const line = a.map(String).join(' ');
        if (!line.startsWith('[bzip2]')) warned.push(line); // (the shim's notice when it imports outside a worker)
    };
    try {
        const M = await importBundled(`startup-tables-${name}`, ENTRY, undefined, [loggerStub]);
        if (install) M.installStartupTables();
        M.Midi.load();
        M.SeqType.load('data/pack'); // runs AnimFrame.load (SeqType.ts:18)
        const frames = [];
        let transforms = 0;
        M.AnimFrame.instances.forEach((f, id) => {
            frames.push([id, f.delay, f.base, f.length]);
            transforms += f.groups.length + f.x.length + f.y.length + f.z.length;
        });
        const seqs = [];
        for (let id = 0; id < M.SeqType.count; id++) {
            const s = M.SeqType.get(id);
            seqs.push(JSON.stringify(Object.entries(s).map(([k, v]) => [k, ArrayBuffer.isView(v) ? Array.from(v) : v])));
        }
        return {
            midi: JSON.stringify(M.Midi.lengths),
            frames: JSON.stringify(frames),
            instancesLength: M.AnimFrame.instances.length,
            order: JSON.stringify(M.AnimFrame.order),
            seqs,
            printed: JSON.stringify(M.printed),
            transforms,
            warned
        };
    } finally {
        console.warn = warn;
        delete globalThis.__LC_VFS__;
    }
}

function same(a, b) {
    const diff = ['midi', 'frames', 'instancesLength', 'order', 'printed'].filter(k => a[k] !== b[k]);
    const seqDiff = a.seqs.length !== b.seqs.length ? -2 : a.seqs.findIndex((s, i) => s !== b.seqs[i]);
    if (seqDiff !== -1) diff.push(`seq ${seqDiff}`);
    return diff;
}

const original = await load('original', { install: false, table: tables });
const lengths = JSON.parse(original.midi);
report(
    'the build step: the table holds every song and frame of the cache',
    tables.midi.lengths.length === lengths.length && tables.anim.ids.length === JSON.parse(original.frames).length && tables.cache[2].count > 0,
    `${lengths.length} songs (${lengths.filter(n => n > 0).length} with a length), ${tables.anim.ids.length} frames, ${original.seqs.length} seqs, ${(JSON.stringify(tables).length / 1024).toFixed(0)} KB`
);

const patched = await load('patched', { install: true, table: tables });
let d = same(original, patched);
report('with the table: Midi, AnimFrame, AnimFrame.order, every SeqType and the printed lines identical', d.length === 0, d.join(', ') || `${original.transforms} transform values not kept`);
report('with the table: it is used (no transform arrays), nothing else printed', patched.transforms === 0 && original.transforms > 0 && patched.warned.length === 0, `${patched.transforms} transform values`);

const fallbacks = [
    ['no table', undefined, 0],
    ['an unreadable table', '{"version": 1, "cache":', 1],
    ['a table of another version', { ...tables, version: 2 }, 1],
    ['a table for another cache (index CRC)', { ...tables, cache: { ...tables.cache, 2: { ...tables.cache[2], crc: tables.cache[2].crc ^ 1 }, 3: { ...tables.cache[3], crc: tables.cache[3].crc ^ 1 } } }, 0],
    ['a table for another cache (file count)', { ...tables, cache: { ...tables.cache, 2: { ...tables.cache[2], count: tables.cache[2].count + 1 }, 3: { ...tables.cache[3], count: tables.cache[3].count - 1 } } }, 0],
    ['a table with another song count', { ...tables, midi: { ...tables.midi, lengths: tables.midi.lengths.slice(1) } }, 0]
];
for (const [name, table, warnings] of fallbacks) {
    const r = await load(name.replace(/\W+/g, '-'), { install: true, table });
    d = same(original, r);
    const songsOnly = name.includes('song count'); // the animation part of that table still fits
    report(`${name}: the original loaders run, identical`, d.length === 0 && (songsOnly ? r.transforms === 0 : r.transforms === original.transforms) && r.warned.length === warnings, d.join(', ') || `${r.warned.length} console warnings`);
}

// what a loader printed for its cache is printed again, by the same Logger function and in order
const lines = [['printWarning', 'Failed to parse midi id=3'], ['printWarning', 'Missing midi id=7']];
const reprinted = await load('reprint', { install: true, table: { ...tables, midi: { ...tables.midi, printed: lines } } });
report('the lines a loader printed for the cache are printed again', reprinted.printed === JSON.stringify(lines), reprinted.printed);

// the comparison sees a wrong value: one frame delay changed in the table (the first frame a SeqType takes it from)
const fromFrames = new Set(JSON.parse(original.frames).filter(([, delay]) => delay > 0).map(([id]) => id));
const used = original.seqs.map(s => Object.fromEntries(JSON.parse(s))).find(s => s.frames?.some((id, i) => fromFrames.has(id) && s.delay[i] === tables.anim.delays[tables.anim.ids.indexOf(id)]));
const k = tables.anim.ids.indexOf(used.frames.find(id => fromFrames.has(id)));
const wrong = { ...tables, anim: { ...tables.anim, delays: tables.anim.delays.map((v, i) => (i === k ? v + 1 : v)) } };
d = same(original, await load('mutant', { install: true, table: wrong }));
report('a table with one wrong frame delay is caught', d.includes('frames') && d.some(x => x.startsWith('seq')), `frame ${tables.anim.ids[k]}: ${d.join(', ')}`);

console.log(failed ? `\n${failed} check(s) failed` : '\nPASS  start-up tables: identical to the loaders, fall back when they must');
process.exit(failed ? 1 : 0);
