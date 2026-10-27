// Build step: what Midi.load() and AnimFrame.load() work out from the cache at every World.start - each song's length
// and each animation frame's delay - worked out once, here, by the engine's own Midi.ts and AnimFrame.ts, and staged as
// vfs/data/derived/startup-tables.json. At run time src/runtime/startup-tables.ts takes them from the table instead
// of gunzipping 345 MIDI and 336 animation files (36 % of World.start in JavaScriptCore); without the table, or for a
// cache it was not made from, it runs the original loaders.
//
// The two loaders are bundled with the engine build's own resolution and shims (the same fflate gunzip and vfs fs as
// in the worker), over a vfs that holds only the staged cache; OnDemand is replaced by its `cache` FileStream (the real
// one starts a helper thread and imports the network layer) and the Logger records what the loaders print. The result
// is cached in build/tmp/startup-tables by this file's text, the bundle's and the cache's bytes (computing it takes
// ~1.2 s).
//
//   import { computeStartupTables, startupTablesJson } from './startup-tables.mjs';
//   const tables = await computeStartupTables({ engineDir, cacheDir });                  // the JSON object
//   const { json, reused } = await startupTablesJson({ engineDir, cacheDir });           // its text (cached)
//   node web/engine/startup-tables.mjs <cacheDir> [out.json]                             // (prints a summary)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as esbuild from 'esbuild';

import { ENGINE_DIR } from '../../scripts/lib/upstream.mjs';
import { bundleOptions } from './build.mjs';

/** [vfsPath, published path (relative to <out>/engine)] of the table, and its format version. */
export const STARTUP_TABLES = ['/engine/data/derived/startup-tables.json', 'vfs/data/derived/startup-tables.json'];
export const STARTUP_TABLES_VERSION = 1;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.resolve(HERE, '../../build/tmp/startup-tables');
const SELF = fs.readFileSync(fileURLToPath(import.meta.url)); // (the extraction below is part of the cache key)
const CACHE_FILES = ['main_file_cache.dat', ...[0, 1, 2, 3, 4].map(i => `main_file_cache.idx${i}`)];

const ENTRY = `export { default as Midi } from '#/cache/midi/Midi.js';
export { default as AnimFrame } from '#/cache/graphics/AnimFrame.js';
export { default as OnDemand } from '#/engine/OnDemand.js';
export { default as Packet } from '#/io/Packet.js';
export { printed } from '#/util/Logger.js';
`;
const ONDEMAND = `import FileStream from '#/io/FileStream.js';\nexport default { cache: new FileStream('data/pack', false, true) };\n`;
// every Logger function the bundled modules import; a fatal error fails the build (upstream exits)
const LOGGER = `export const printed = [];
export function printWarning(message) { printed.push(['printWarning', String(message)]); }
export function printInfo(message) { printed.push(['printInfo', String(message)]); }
export function printDebug(message) { printed.push(['printDebug', String(message)]); }
export function printError(message) { printed.push(['printError', String(message)]); }
export function printFatalError(message) { throw new Error('startup tables: the loaders failed: ' + message); }
`;

/** The plugin that swaps OnDemand and the Logger; the engine build's plugin does everything else. */
function stubs(engineDir) {
    return {
        name: 'startup-tables-stubs',
        setup(build) {
            build.onResolve({ filter: /^#\/(engine\/OnDemand|util\/Logger)\.js$/ }, a => ({ path: a.path, namespace: 'startup-tables' }));
            build.onLoad({ filter: /.*/, namespace: 'startup-tables' }, a => ({ contents: a.path.includes('OnDemand') ? ONDEMAND : LOGGER, loader: 'js', resolveDir: path.join(engineDir, 'src') }));
        }
    };
}

/** The loaders' bundle (an ES module's text). */
async function bundleLoaders(engineDir) {
    const options = bundleOptions(engineDir);
    const result = await esbuild.build({
        ...options,
        plugins: [stubs(engineDir), ...options.plugins],
        stdin: { contents: ENTRY, resolveDir: HERE, loader: 'ts', sourcefile: 'startup-tables-entry.ts' },
        write: false,
        minify: false
    });
    return result.outputFiles[0].text;
}

/** Runs the bundle over the cache in `cacheDir` (a fresh module each time: the loaders' static state starts empty). */
async function runLoaders(code, cacheDir) {
    // a vfs with only the cache, installed while the loaders run: the fs shim looks the store up on every call
    // (FileStream's constructor opens the files while the bundle evaluates, its reads come later)
    const store = { cwd: '/engine', files: new Map(), dirs: new Set(['/', '/engine', '/engine/data', '/engine/data/pack']), urls: new Map(), loadSync: null };
    for (const f of CACHE_FILES) store.files.set(`/engine/data/pack/${f}`, new Uint8Array(fs.readFileSync(path.join(cacheDir, f))));
    const file = path.join(os.tmpdir(), `lc-startup-tables-${process.pid}-${Date.now()}.mjs`);
    fs.writeFileSync(file, code);
    const g = globalThis;
    const previous = g.__LC_VFS__;
    g.__LC_VFS__ = store;
    try {
        const { Midi, AnimFrame, OnDemand, Packet, printed } = await import(pathToFileURL(file).href);
        const guard = archive => {
            const idx = fs.readFileSync(path.join(cacheDir, `main_file_cache.idx${archive}`));
            return { count: OnDemand.cache.count(archive), crc: Packet.getcrc(idx, 0, idx.length) };
        };
        const cache = { 2: guard(2), 3: guard(3) };
        if (!cache[2].count || !cache[3].count) throw new Error(`startup tables: ${cacheDir} has no animations or no songs`);

        Midi.load();
        const midi = { lengths: Array.from(Midi.lengths), printed: printed.splice(0) };
        AnimFrame.load();
        const anim = { ids: [], delays: [], bases: [], lengths: [], order: Array.from(AnimFrame.order), printed: printed.splice(0) };
        AnimFrame.instances.forEach((frame, id) => {
            anim.ids.push(id);
            anim.delays.push(frame.delay);
            anim.bases.push(frame.base);
            anim.lengths.push(frame.length);
        });
        return { version: STARTUP_TABLES_VERSION, cache, midi, anim };
    } finally {
        if (previous === undefined) delete g.__LC_VFS__;
        else g.__LC_VFS__ = previous;
        fs.rmSync(file, { force: true });
    }
}

/**
 * Runs Midi.load() and AnimFrame.load() over the cache in `cacheDir` and returns what they leave behind:
 *   { version, cache: { 2|3: { count, crc } }   - the guard: files in archive 2/3, CRC-32 of main_file_cache.idx2/3
 *     midi: { lengths, printed }                 - Midi.lengths; what Midi.load printed ([function, message], in order)
 *     anim: { ids, delays, bases, lengths, order, printed } - per frame id AnimFrame.instances[id].delay/base/length,
 *                                                  AnimFrame.order }
 */
export async function computeStartupTables({ engineDir = ENGINE_DIR, cacheDir }) {
    return runLoaders(await bundleLoaders(engineDir), cacheDir);
}

/** computeStartupTables as JSON text, cached by this file, the loaders' bundle and the cache's bytes: { json, key, reused, ms }. */
export async function startupTablesJson({ engineDir = ENGINE_DIR, cacheDir }) {
    const t0 = Date.now();
    const code = await bundleLoaders(engineDir);
    const hash = crypto.createHash('sha256').update(SELF).update('\0').update(code);
    for (const f of CACHE_FILES) hash.update(fs.readFileSync(path.join(cacheDir, f)));
    const key = hash.digest('hex');
    const file = path.join(TMP, `${key}.json`);
    if (fs.existsSync(file)) {
        return { json: fs.readFileSync(file, 'utf8'), key, reused: true, ms: Date.now() - t0 };
    }
    const json = JSON.stringify(await runLoaders(code, cacheDir));
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(`${file}.${process.pid}`, json);
    fs.renameSync(`${file}.${process.pid}`, file);
    for (const f of fs.readdirSync(TMP)) if (f.endsWith('.json') && f !== path.basename(file)) fs.rmSync(path.join(TMP, f), { force: true }); // only the latest is kept
    return { json, key, reused: false, ms: Date.now() - t0 };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const [cacheDir, out] = process.argv.slice(2);
    if (!cacheDir) {
        console.error('usage: node web/engine/startup-tables.mjs <cacheDir> [out.json]');
        process.exit(2);
    }
    const t0 = Date.now();
    const tables = await computeStartupTables({ cacheDir: path.resolve(cacheDir) });
    const json = JSON.stringify(tables);
    if (out) fs.writeFileSync(out, json);
    console.log(`startup tables: ${tables.midi.lengths.length} songs, ${tables.anim.ids.length} frames, ${(json.length / 1024).toFixed(1)} KB, ${Date.now() - t0} ms`);
}
