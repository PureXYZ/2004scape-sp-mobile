#!/usr/bin/env node
// Engine worker build: bundles Engine-TS 274 for a browser module worker and stages the files it reads at runtime.
//
//   node web/engine/build.mjs --out <Game dir> [--debug] [--engine-dir <dir>] [--content-dir <dir>]
//                             [--no-bots | --bots-lib <dir>] [--rebuild-bot-scripts]
//   import { buildEngine } from './web/engine/build.mjs'; await buildEngine({ out, debug, engineDir, contentDir, bots });
//
// Writes (ARCHITECTURE.md §2):
//   <out>/engine/boot.js              module-worker bootstrap (src/boot.js)
//   <out>/engine/engine.js[.map]      the bundle (src/entry.ts + engine sources + src/shims)
//   <out>/engine/bzip2.wasm           optional WASM bzip2 (the bundle falls back to a TS decoder)
//   <out>/engine/vfs-manifest.json    [[vfsPath, urlRelativeToEngineDir], ...]
//   <out>/engine/vfs/...              runtime data except the cache, incl. the generated world.json (script.dat
//                                     with relative source paths: 'content/scripts/...', relativiseScriptPack)
//   <out>/cache/main_file_cache.*     the cache, shared with the client
// and, unless bots: false (docs/BOTS.md §2):
//   <out>/engine/engine-bots.js[.map] the same engine + the bot library (bots/src, '#/engine/bot/*') + the glue
//                                     (src/entry-bots.ts, src/runtime/bots/*); boot.js loads it when bots are on
//   <out>/engine/vfs-manifest-bots.json  what boot.js preloads on top of vfs-manifest.json for it
//   <out>/engine/vfs/bots/scripts.bin    the content-script overlay (bots/content/compile.mjs), rewritten for the
//                                        staged script.dat
//
// No engine source is modified: Node built-ins and server-only modules are redirected to src/shims by an esbuild
// plugin (unknown built-ins and server-only packages fail the build), `Buffer` is injected only into engine (and
// bot library) files that use it as a value, and process.exit/memoryUsage/platform are rewritten with `define`.
// engine.js is the same with or without the bots build: nothing of the bots is reachable from src/entry.ts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { builtinModules } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CONTENT_DIR, ENGINE_DIR } from '../../scripts/lib/upstream.mjs';

import * as esbuild from 'esbuild';

import { compileBotScripts, decodeScriptsBin, encodeScriptsBin, readCommandNumbers, readScriptPack, relativiseScriptPack, splitHeader } from './bots/content/compile.mjs';

const HERE = realDir(path.dirname(fileURLToPath(import.meta.url))); // (real: compared with esbuild's paths)
const IOS = path.resolve(HERE, '../..');
const SRC = path.join(HERE, 'src');
const SHIMS = path.join(SRC, 'shims');
/** The bot library ('#/engine/bot/*'), ported to 274 (docs/BOTS.md §3). Tests point `bots.lib` at a stub. */
export const BOTS_LIB = path.join(HERE, 'bots/src');
// the glue: only src/entry-bots.ts reaches it
const BOTS_GLUE = [path.join(SRC, 'entry-bots.ts'), path.join(SRC, 'runtime/bots') + path.sep];
// strings only the bots bundle contains (the bot store's magic, the glue's log prefix, the script command it registers):
// engine.js must have none
const BOT_MARKERS = ['LCBOTS01', '[bots]', 'P_ISBOT'];
// what boot.js preloads for engine-bots.js on top of vfs-manifest.json
const BOTS_VFS = [['/engine/data/bot/scripts.bin', 'vfs/bots/scripts.bin']];

// ---- what the engine reads at runtime (verified by test/vm.test.mjs: every staged path is accessed) ----------

// World.reload() loaders (World.ts:206-291) + Component (interface.dat) + ScriptProvider (script.dat/.idx)
const SERVER_PACKS = ['varp', 'varbit', 'param', 'obj', 'loc', 'npc', 'idk', 'seq', 'spotanim', 'category', 'enum', 'struct', 'inv', 'mesanim', 'dbtable', 'dbrow', 'hunt', 'varn', 'vars', 'interface', 'script'];

/** [vfsPath, source (relative to engineDir or contentDir), published path (relative to <out>/engine)] */
function runtimeFiles() {
    const e = rel => ['engine', rel];
    const files = [
        ['/engine/data/config/private.pem', e('data/config/private.pem'), 'vfs/data/config/private.pem'], // World.ts:104
        ['/engine/data/raw/wordenc', e('data/raw/wordenc'), 'vfs/data/raw/wordenc'], // WordEnc.ts:36 (ignores its dir)
        ...['config', 'interface', 'title'].map(n => [`/engine/data/pack/client/${n}`, e(`data/pack/client/${n}`), `vfs/data/pack/client/${n}`]),
        ...SERVER_PACKS.map(n => [`/engine/data/pack/server/${n}.dat`, e(`data/pack/server/${n}.dat`), `vfs/data/pack/server/${n}.dat`]),
        ['/engine/data/pack/server/script.idx', e('data/pack/server/script.idx'), 'vfs/data/pack/server/script.idx'],
        // GameMap.ts:66 reads the packer's build cache; no dot-directory in the app bundle
        ['/engine/data/pack/.cache/maps-server.zip', e('data/pack/.cache/maps-server.zip'), 'vfs/data/pack/maps-server.zip'],
        // GameMap.ts:52-64: content *source* files; without <srcDir>/maps the world silently loads no map at all
        ['/content/maps/multiway.csv', ['content', 'maps/multiway.csv'], 'vfs/content/maps/multiway.csv'],
        ['/content/maps/free2play.csv', ['content', 'maps/free2play.csv'], 'vfs/content/maps/free2play.csv']
    ];
    // the cache lives at <out>/cache/ so the client (OnDemand from the local cache) and the engine share one copy
    for (const f of ['main_file_cache.dat', ...[0, 1, 2, 3, 4].map(i => `main_file_cache.idx${i}`)]) {
        files.push([`/engine/data/pack/${f}`, e(`data/pack/${f}`), `../cache/${f}`]);
    }
    return files;
}

// data/config/world.json (ARCHITECTURE.md §8). The page can deep-merge overrides at boot ({type:'init', config}).
export const WORLD_CONFIG = {
    node: {
        id: 10, // must match the client's Client(10, 0, true)
        members: true,
        production: false, // staffmodlevel 4: ::cheats and ::~debugprocs; no login rate limits
        // debug=true (engine default): the server ignores the client's IDLE_TIMER (no forced logout after 90 s
        // without input - right for a phone put down mid-session) and random events keep working for staff
        // (PlayerOps.ts:1115). Cost: "No trigger for [...]" messages for unscripted interactions and a
        // "Loaded N scripts" broadcast on ::reload. See README.md "Configuration".
        debug: true,
        debugProfile: false,
        xpRate: 1,
        profile: 'main', // saves: Documents/players/main/<name>.sav
        clientRoutefinder: true
    },
    login: { enabled: false },
    friend: { enabled: false },
    logger: { enabled: false },
    build: {
        liveReload: false, // no DevThread (packer / file watcher)
        verbose: true // printError(Error) includes the stack (Logger.ts:24)
    }
};

// ---- esbuild resolution -----------------------------------------------------------------------------------

const BUILTIN_SHIMS = {
    fs: 'fs.ts',
    'fs/promises': 'fs-promises.ts',
    path: 'path.ts',
    'path/posix': 'path.ts',
    zlib: 'zlib.ts',
    crypto: 'crypto.ts',
    worker_threads: 'worker_threads.ts',
    v8: 'v8.ts',
    module: 'module.ts',
    buffer: 'buffer.ts'
};

const PACKAGE_SHIMS = {
    'prom-client': 'prom-client.ts', // server/Metrics.ts builds metrics at import (needs cluster, v8, http...)
    ws: 'ws.ts', // FriendServer/InternalClient: only used with login/friend/logger servers
    'node-forge': 'forge-lite.ts' // PEM parse + jsbn BigInteger on native BigInt; byte-identical (test/forge-lite.test.mjs)
};

// whole engine modules replaced (see the shim headers for why)
const ENGINE_ALIASES = {
    '#/db/query.js': 'db-query.ts', // opens node:sqlite at import, pulled in by World.ts:71 -> FriendServer.ts
    '#/io/BZip2.js': 'bzip2.ts' // WASM at start-up with a TS fallback, released after start
};

// npm packages allowed in the bundle (browser-safe, verified); anything else fails the build - e.g. an engine
// update that starts importing a server-only package (kysely, mysql2, fastify, ejs, jimp, runescript, bcrypt...)
const ALLOWED_PACKAGES = ['kleur', 'fflate', '@isaacs/ttlcache'];
const packageName = spec => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');

const builtins = new Set(builtinModules);

// The bot library must stay worker-safe (docs/BOTS.md §5): from its files, no Node built-in (not even the shimmed fs,
// path, ...), no `ws`, no database and no packer. The engine itself keeps its shims; this only applies to the library.
const BOTS_DENIED_PACKAGES = ['ws'];
const BOTS_DENIED_ALIASES = ['#/db/', '#tools/'];

// A directory as esbuild sees its files: through symlinks (a symlinked Server or bot library). Every path the plugin
// compares with esbuild's importers and inputs - which are real paths - must be real too, or a library file reached
// by a relative import is not recognised as one (its guards skipped, its modules miscounted) and an engine file can be
// bundled twice under two names. A path that does not exist stays as given (the caller reports it).
export function realDir(dir) {
    const resolved = path.resolve(dir);
    try {
        return fs.realpathSync(resolved);
    } catch {
        return resolved;
    }
}

// exact-case lookup: APFS is case-insensitive, esbuild module identity and the device's file system are not
function existsExactCase(file, root) {
    let dir = root;
    for (const part of path.relative(root, file).split(path.sep)) {
        let names;
        try {
            names = fs.readdirSync(dir);
        } catch {
            return false;
        }
        if (!names.includes(part)) return false;
        dir = path.join(dir, part);
    }
    return true;
}

function lostcityPlugin(engineDir, report, botsLib = null) {
    engineDir = realDir(engineDir);
    botsLib = botsLib ? realDir(botsLib) : null;
    const importMap = [
        ['#3rdparty/', path.join(engineDir, 'src/3rdparty/')],
        ['#tools/', null],
        // the bot library: only in the bots build (engine-bots.js); never reachable from the vanilla entry
        ['#/engine/bot/', botsLib ? botsLib + path.sep : null],
        ['#/', path.join(engineDir, 'src/')]
    ];
    const resolveFile = p => {
        for (const c of [p, p.endsWith('.js') ? p.slice(0, -3) + '.ts' : null]) {
            if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
        }
        return null;
    };
    const rel = p => path.relative(engineDir, p);
    const note = (key, importer) => {
        let s = report.redirects.get(key);
        if (!s) report.redirects.set(key, (s = new Set()));
        s.add(importer.startsWith(engineDir) ? rel(importer) : path.relative(HERE, importer));
    };
    const engineSrc = path.join(engineDir, 'src') + path.sep;
    const inBotsLib = p => !!botsLib && p.startsWith(botsLib + path.sep);
    const fromBotsLib = (a, what) => ({ errors: [{ text: `the bot library must not import ${what} (${path.relative(HERE, a.importer)} imports '${a.path}'; docs/BOTS.md §5: worker-safe)` }] });

    return {
        name: 'lostcity-engine-worker',
        setup(build) {
            // the injected Buffer import (below) names the shim by this bare id, not by its absolute path, so a
            // --debug sourcemap's sourcesContent never carries the builder's folder
            build.onResolve({ filter: /^lc-shim:buffer$/ }, () => ({ path: path.join(SHIMS, 'buffer.ts') }));

            // package.json "imports" (#/, #3rdparty/; #tools/ is the packer) + whole-module aliases
            build.onResolve({ filter: /^#/ }, a => {
                if (inBotsLib(a.importer) && BOTS_DENIED_ALIASES.some(p => a.path.startsWith(p))) return fromBotsLib(a, 'the database or the packer');
                if (ENGINE_ALIASES[a.path]) {
                    note(`${a.path} -> shims/${ENGINE_ALIASES[a.path]}`, a.importer);
                    return { path: path.join(SHIMS, ENGINE_ALIASES[a.path]) };
                }
                for (const [prefix, dir] of importMap) {
                    if (!a.path.startsWith(prefix)) continue;
                    if (!dir && prefix === '#/engine/bot/') {
                        return { errors: [{ text: `bot library module ${a.path} reached from ${rel(a.importer)}: the vanilla engine.js must not contain the bots (only engine-bots.js, from src/entry-bots.ts)` }] };
                    }
                    if (!dir) return { errors: [{ text: `packer module ${a.path} reached from ${rel(a.importer)}: not allowed in the runtime bundle` }] };
                    const f = resolveFile(dir + a.path.slice(prefix.length));
                    if (f && prefix === '#/engine/bot/' && !existsExactCase(f, botsLib)) {
                        return { errors: [{ text: `${a.path} (from ${path.relative(HERE, a.importer)}) differs in case from the file on disk` }] };
                    }
                    return f ? { path: f } : { errors: [{ text: `cannot resolve ${a.path} from ${rel(a.importer)}` }] };
                }
                return { errors: [{ text: `unknown import map entry ${a.path}` }] };
            });

            // Node built-ins and packages
            build.onResolve({ filter: /^[^./#]/ }, async a => {
                const spec = a.path.startsWith('node:') ? a.path.slice(5) : a.path;
                if (inBotsLib(a.importer)) {
                    if (a.path.startsWith('node:') || builtins.has(spec) || builtins.has(spec.split('/')[0])) return fromBotsLib(a, 'Node built-ins');
                    if (BOTS_DENIED_PACKAGES.includes(packageName(a.path))) return fromBotsLib(a, `the '${a.path}' package`);
                }
                if (BUILTIN_SHIMS[spec]) {
                    note(`${a.path} -> shims/${BUILTIN_SHIMS[spec]}`, a.importer);
                    return { path: path.join(SHIMS, BUILTIN_SHIMS[spec]) };
                }
                if (a.path.startsWith('node:') || builtins.has(spec) || builtins.has(spec.split('/')[0])) {
                    return { errors: [{ text: `Node built-in '${a.path}' imported by ${rel(a.importer)} has no worker shim (add one to BUILTIN_SHIMS deliberately)` }] };
                }
                if (PACKAGE_SHIMS[a.path]) {
                    note(`${a.path} -> shims/${PACKAGE_SHIMS[a.path]}`, a.importer);
                    return { path: path.join(SHIMS, PACKAGE_SHIMS[a.path]) };
                }
                if (!ALLOWED_PACKAGES.includes(packageName(a.path))) {
                    return { errors: [{ text: `package '${a.path}' (reached from ${rel(a.importer)}) is not allowed in the worker bundle; shim it or add it to ALLOWED_PACKAGES after checking it is browser-safe` }] };
                }
                // Packages imported by our own sources resolve from the engine's node_modules too, so the bundle
                // holds one copy (web/node_modules has its own fflate).
                if (!a.importer.startsWith(engineDir) && !a.pluginData?.fromEngine) {
                    const r = await build.resolve(a.path, { kind: a.kind, resolveDir: engineDir, pluginData: { fromEngine: true } });
                    if (r.errors.length) return { errors: r.errors };
                    return { path: r.path, external: r.external, sideEffects: r.sideEffects };
                }
                return undefined;
            });

            // scoped Buffer: only engine (and bot library) sources that use Buffer as a value get the shim (World.ts,
            // RandomAccessFile.ts); a global Buffer would flip third-party `typeof Buffer` checks to their Node paths
            build.onLoad({ filter: /\.ts$/ }, async a => {
                if (!a.path.startsWith(engineSrc) && !inBotsLib(a.path)) return undefined;
                const src = await fs.promises.readFile(a.path, 'utf8');
                const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
                if (/\bBuffer\s*\.\s*(alloc|allocUnsafe|from|concat|isBuffer|byteLength)\b/.test(code)) {
                    report.injectedBuffer.push(inBotsLib(a.path) ? `#/engine/bot/${path.relative(botsLib, a.path)}` : rel(a.path));
                    return { contents: `import { Buffer } from 'lc-shim:buffer';\n${src}`, loader: 'ts' };
                }
                return undefined;
            });
        }
    };
}

// ---- helpers ------------------------------------------------------------------------------------------------

const STAGED_SCRIPTS = ['vfs/data/pack/server/script.dat', 'vfs/data/pack/server/script.idx'];

/** Rewrites the staged script.dat/.idx with relative source paths (relativiseScriptPack); returns its result. */
function stageScriptPack(engineOut, engineDir, contentDir) {
    const [datFile, idxFile] = STAGED_SCRIPTS.map(f => path.join(engineOut, f));
    // the packer compiles <engineDir>/../content (its srcDir), which is contentDir in every layout upstream.mjs finds
    const r = relativiseScriptPack(fs.readFileSync(datFile), fs.readFileSync(idxFile), [contentDir, path.resolve(engineDir, '../content')]);
    fs.writeFileSync(datFile, r.dat);
    fs.writeFileSync(idxFile, r.idx);
    return r;
}

function copy(src, dst) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    // APFS clone when possible: 30 MB per build costs nothing
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE);
}

function scanBundle(text) {
    // anything left here would fail at runtime in the worker (or silently take a Node code path)
    return {
        staticImports: (text.match(/^\s*import\s[^(]/gm) ?? []).length,
        dynamicImports: [...text.matchAll(/\bimport\(\s*(['"`][^'"`]*['"`])/g)].map(m => m[1]),
        requireCalls: [...new Set([...text.matchAll(/\b__require\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]))],
        processRefs: [...new Set([...text.matchAll(/\bprocess\.[a-zA-Z_]+/g)].map(m => m[0]))].sort()
    };
}

/**
 * process.* property paths (two levels: process.env.X) with how often each occurs, in the code only: esbuild reprints
 * the bundle without comments first (a debug build keeps them, and a doc comment that names process.env.X is no use of it).
 */
async function processPaths(text) {
    const code = (await esbuild.transform(text, { minifyWhitespace: true, legalComments: 'none', logLevel: 'silent' })).code;
    const counts = new Map();
    for (const [m] of code.matchAll(/\bprocess\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?/g)) counts.set(m, (counts.get(m) ?? 0) + 1);
    return counts;
}

/** Every bundle input that is bots code (the library, the glue). The vanilla engine.js must have none. */
function botInputs(metafile, engineDir, botsLib) {
    const dirs = [...BOTS_GLUE, ...[BOTS_LIB, botsLib].filter(Boolean).map(d => d + path.sep)];
    return Object.keys(metafile.inputs)
        .map(i => path.resolve(engineDir, i)) // inputs are relative to absWorkingDir
        .filter(abs => dirs.some(d => (d.endsWith(path.sep) ? abs.startsWith(d) : abs === d)));
}

/** The engine's ScriptOpcodeMap (Server/engine/src/engine/script/ScriptOpcode.ts), bundled and evaluated here. */
async function scriptOpcodeMap(engineDir) {
    const r = await esbuild.build({
        ...bundleOptions(engineDir),
        entryPoints: [path.join(engineDir, 'src/engine/script/ScriptOpcode.ts')],
        platform: 'neutral',
        inject: [],
        write: false,
        minify: false
    });
    const mod = await import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));
    if (!(mod.ScriptOpcodeMap instanceof Map)) throw new Error('ScriptOpcode.ts no longer exports ScriptOpcodeMap');
    return mod.ScriptOpcodeMap;
}

/** esbuild options shared by the engine bundle and the tests that bundle engine modules (test/lib/bundle.mjs). */
export function bundleOptions(engineDir, report = { redirects: new Map(), injectedBuffer: [] }, { botsLib = null } = {}) {
    engineDir = realDir(engineDir);
    return {
        absWorkingDir: engineDir,
        bundle: true,
        platform: 'browser',
        format: 'esm', // top-level await (bzip2 init) -> module worker
        target: 'es2022',
        mainFields: ['browser', 'module', 'main'],
        conditions: ['browser', 'import', 'default'],
        nodePaths: [path.join(engineDir, 'node_modules')],
        define: {
            'process.platform': '"browser"',
            'process.exit': '__lc_exit',
            'process.memoryUsage': '__lc_memoryUsage',
            'process.env.NODE_ENV': '"production"'
        },
        inject: [path.join(SHIMS, 'globals.ts')],
        logLevel: 'silent',
        plugins: [lostcityPlugin(engineDir, report, botsLib)]
    };
}

// ---- build --------------------------------------------------------------------------------------------------

export async function buildEngine({ out, debug = false, engineDir, contentDir, bots = {} } = {}) {
    if (!out) throw new Error('buildEngine: `out` (the Game directory) is required');
    out = path.resolve(out);
    engineDir = realDir(engineDir ?? ENGINE_DIR);
    contentDir = realDir(contentDir ?? CONTENT_DIR);
    if (bots === true) bots = {};
    const t0 = Date.now();

    const files = runtimeFiles();
    const sourceOf = ([, [root, rel]]) => path.join(root === 'engine' ? engineDir : contentDir, rel);
    const missing = files.filter(f => !fs.existsSync(sourceOf(f))).map(sourceOf);
    if (missing.length) {
        throw new Error(`engine runtime data is missing (run \`npm run build\` in ${engineDir}):\n  ${missing.join('\n  ')}`);
    }
    const wasmSrc = path.join(engineDir, 'src/3rdparty/bzip2-wasm/bzip2-1.0.8/bzip2.wasm');

    const engineOut = path.join(out, 'engine');
    const cacheOut = path.join(out, 'cache');
    fs.rmSync(engineOut, { recursive: true, force: true });
    fs.rmSync(cacheOut, { recursive: true, force: true });
    fs.mkdirSync(engineOut, { recursive: true });

    // -- bundle
    const report = { redirects: new Map(), injectedBuffer: [] };
    const result = await esbuild.build({
        ...bundleOptions(engineDir, report),
        entryPoints: [path.join(SRC, 'entry.ts')],
        outfile: path.join(engineOut, 'engine.js'),
        minify: !debug,
        sourcemap: debug ? 'linked' : false,
        sourcesContent: true,
        // (keeps a /*! */ or @license comment if a source has one; none does today: the notices are in
        // build/Game/licenses.txt, scripts/lib/notices.mjs)
        legalComments: debug ? 'inline' : 'eof',
        metafile: true
    });
    for (const w of result.warnings) console.warn(`[engine build] warning: ${w.text}${w.location ? ` (${w.location.file}:${w.location.line})` : ''}`);

    const bundlePath = path.join(engineOut, 'engine.js');
    const bundleText = fs.readFileSync(bundlePath, 'utf8');
    const scan = scanBundle(bundleText);
    if (scan.staticImports || scan.dynamicImports.length || scan.requireCalls.length) {
        throw new Error(`engine bundle has unresolved module references: ${JSON.stringify(scan)}`);
    }
    // bots-off is today's engine by construction: no bot module and no bot marker may reach engine.js
    const leaked = [...botInputs(result.metafile, engineDir, bots ? realDir(bots.lib ?? BOTS_LIB) : null).map(f => path.relative(HERE, f)), ...BOT_MARKERS.filter(m => bundleText.includes(m))];
    if (leaked.length) throw new Error(`engine.js must not contain bot code (it comes only with engine-bots.js): ${leaked.join(', ')}`);

    // -- bootstrap: debug keeps the commented source, release is minified; import('./engine.js') stays as written
    const bootSrc = fs.readFileSync(path.join(SRC, 'boot.js'), 'utf8');
    if (!bootSrc.includes('__LC_DEBUG__')) throw new Error('src/boot.js lost its __LC_DEBUG__ marker');
    const bootCode = debug
        ? bootSrc.replaceAll('__LC_DEBUG__', 'true')
        : (await esbuild.transform(bootSrc, { loader: 'js', format: 'esm', target: 'es2022', minify: true, define: { __LC_DEBUG__: 'false' }, legalComments: 'none' })).code;
    fs.writeFileSync(path.join(engineOut, 'boot.js'), bootCode);

    copy(wasmSrc, path.join(engineOut, 'bzip2.wasm'));

    // -- runtime data + manifest
    const manifest = [];
    for (const f of files) {
        const [vfsPath, , published] = f;
        copy(sourceOf(f), path.resolve(engineOut, published));
        manifest.push([vfsPath, published]);
    }
    // the compiler embeds each script's absolute source path (the builder's folder): ship them relative to the content
    stageScriptPack(engineOut, engineDir, contentDir);
    let dataBytes = manifest.reduce((n, [, published]) => n + fs.statSync(path.resolve(engineOut, published)).size, 0);
    const worldJson = JSON.stringify(WORLD_CONFIG, null, 4) + '\n';
    fs.mkdirSync(path.join(engineOut, 'vfs/data/config'), { recursive: true });
    fs.writeFileSync(path.join(engineOut, 'vfs/data/config/world.json'), worldJson);
    manifest.push(['/engine/data/config/world.json', 'vfs/data/config/world.json']);
    dataBytes += worldJson.length;
    fs.writeFileSync(path.join(engineOut, 'vfs-manifest.json'), JSON.stringify(manifest, null, debug ? 1 : 0) + '\n');

    // -- the bots build (docs/BOTS.md §2), beside the files above and never changing them
    const botsInfo = bots ? await buildBots({ engineOut, debug, engineDir, contentDir, bots, vanillaText: bundleText }) : null;

    const size = f => fs.statSync(path.join(engineOut, f)).size;
    const bundleBytes = size('engine.js');
    const info = {
        debug,
        ms: Date.now() - t0,
        bundle: { bytes: bundleBytes, gzip: zlib.gzipSync(bundleText).length, inputs: Object.keys(result.metafile.inputs).length },
        boot: { bytes: size('boot.js') },
        data: { files: manifest.length, bytes: dataBytes },
        redirects: Object.fromEntries([...report.redirects].map(([k, v]) => [k, [...v].sort()])),
        injectedBuffer: report.injectedBuffer.sort(),
        processRefs: scan.processRefs,
        bots: botsInfo
    };
    return info;
}

async function buildBots({ engineOut, debug, engineDir, contentDir, bots, vanillaText }) {
    const t0 = Date.now();
    const lib = realDir(bots.lib ?? BOTS_LIB);
    if (!fs.existsSync(path.join(lib, 'BotManager.ts'))) throw new Error(`bots: ${lib} is not a bot library (no BotManager.ts)`);

    // the script command numbers (bots/src/port/BotScriptCommands.ts) must be free: never shadow or move a stock opcode
    const numbers = readCommandNumbers();
    const opcodes = await scriptOpcodeMap(engineDir);
    const taken = new Map([...opcodes].map(([name, opcode]) => [opcode, name]));
    for (const [name, opcode] of Object.entries(numbers)) {
        if (opcodes.has(name) || taken.has(opcode)) {
            throw new Error(`bots: script command ${name} = ${opcode} collides with the engine's ScriptOpcodeMap (${opcodes.has(name) ? `${name} exists` : `${opcode} is ${taken.get(opcode)}`})`);
        }
    }

    // the content-script overlay (cached; compiled against exactly the engine's script.dat, staged above)
    const overlay = bots.overlay ?? (await compileBotScripts({ engineDir, contentDir, force: !!bots.rebuildScripts }));
    const header = decodeScriptsBin(fs.readFileSync(overlay.file));
    const sha256 = buf => crypto.createHash('sha256').update(buf).digest();
    const vanillaDat = sha256(fs.readFileSync(path.join(engineDir, 'data/pack/server/script.dat'))).toString('hex');
    if (header.datSha256 !== vanillaDat) {
        throw new Error(`bots: scripts.bin was diffed against script.dat ${header.datSha256.slice(0, 12)}, but the engine's is ${vanillaDat.slice(0, 12)} (rebuild it: --rebuild-bot-scripts)`);
    }
    const binCommands = Object.fromEntries(header.commands.map(c => [c.name, c.opcode]));
    if (binCommands.p_isbot !== numbers.P_ISBOT || binCommands.p_bot_interact_trade !== numbers.P_BOT_INTERACT_TRADE) {
        throw new Error(`bots: scripts.bin uses command numbers ${JSON.stringify(binCommands)}, BotScriptCommands.ts has ${JSON.stringify(numbers)}`);
    }
    // shipped against the staged (relativised) pack: each script takes its vanilla script's relative source path, its
    // vanillaCrc that script's (overlay.ts checks it against the pack it loads) and the header the staged files' sha256
    const [stagedDat, stagedIdx] = STAGED_SCRIPTS.map(f => fs.readFileSync(path.join(engineOut, f)));
    const staged = readScriptPack(stagedDat, stagedIdx).scripts;
    const scripts = header.scripts.map(s => {
        const vanilla = staged.get(s.id);
        if (!vanilla) throw new Error(`bots: scripts.bin replaces script ${s.id} (${s.name}), which the staged script.dat lacks`);
        const own = splitHeader(s.bytes);
        const bytes = Buffer.concat([Buffer.from(own.name + '\0' + splitHeader(vanilla).source + '\0', 'latin1'), own.rest]);
        return { ...s, bytes, vanillaCrc: zlib.crc32(vanilla) | 0 };
    });
    const bin = encodeScriptsBin({ datSha256: sha256(stagedDat), idxSha256: sha256(stagedIdx), entries: header.entries, commands: header.commands, scripts });
    for (const [, published] of BOTS_VFS) {
        fs.mkdirSync(path.dirname(path.join(engineOut, published)), { recursive: true });
        fs.writeFileSync(path.join(engineOut, published), bin);
    }
    fs.writeFileSync(path.join(engineOut, 'vfs-manifest-bots.json'), JSON.stringify(BOTS_VFS, null, debug ? 1 : 0) + '\n');

    const report = { redirects: new Map(), injectedBuffer: [] };
    const result = await esbuild.build({
        ...bundleOptions(engineDir, report, { botsLib: lib }),
        entryPoints: [path.join(SRC, 'entry-bots.ts')],
        outfile: path.join(engineOut, 'engine-bots.js'),
        minify: !debug,
        sourcemap: debug ? 'linked' : false,
        sourcesContent: true,
        legalComments: debug ? 'inline' : 'eof',
        metafile: true
    });
    for (const w of result.warnings) console.warn(`[engine build] bots warning: ${w.text}${w.location ? ` (${w.location.file}:${w.location.line})` : ''}`);
    // a relative import in another case than the file's works on APFS only (esbuild just warns)
    const wrongCase = result.warnings.filter(w => w.id === 'different-path-case');
    if (wrongCase.length) throw new Error(`engine-bots.js: imports that differ in case from the file on disk:\n  ${wrongCase.map(w => `${w.location?.file}:${w.location?.line}: ${w.text}`).join('\n  ')}`);
    const text = fs.readFileSync(path.join(engineOut, 'engine-bots.js'), 'utf8');
    const scan = scanBundle(text);
    if (scan.staticImports || scan.dynamicImports.length || scan.requireCalls.length) {
        throw new Error(`engine-bots.js has unresolved module references: ${JSON.stringify(scan)}`);
    }
    // the worker has no `process`: the engine's own references are guarded or rewritten (`define`); the bots add none
    // (compared as process.a.b paths with counts: engine.js has a guarded process.env, which must not hide process.env.X)
    const vanillaPaths = await processPaths(vanillaText);
    const extraProcess = [...(await processPaths(text))].filter(([p, n]) => n > (vanillaPaths.get(p) ?? 0)).map(([p]) => p);
    if (extraProcess.length) throw new Error(`engine-bots.js references ${extraProcess.join(', ')} beyond engine.js's (no process in the worker; docs/BOTS.md §5)`);
    const absent = BOT_MARKERS.filter(m => !text.includes(m));
    if (absent.length) throw new Error(`engine-bots.js lacks the bots glue (no ${absent.join(', ')})`);

    const inputs = Object.keys(result.metafile.inputs).map(i => path.resolve(engineDir, i));
    return {
        ms: Date.now() - t0,
        lib: path.relative(IOS, lib),
        bundle: { bytes: Buffer.byteLength(text), gzip: zlib.gzipSync(text).length, inputs: inputs.length, libModules: inputs.filter(f => f.startsWith(lib + path.sep)).length },
        data: { files: BOTS_VFS.length, bytes: BOTS_VFS.reduce((n, [, p]) => n + fs.statSync(path.join(engineOut, p)).size, 0) },
        overlay: { key: overlay.key, reused: overlay.reused, scripts: header.scripts.length, bytes: bin.length, base: overlay.base, patches: overlay.patches, vanillaScriptDat: sha256(stagedDat).toString('hex') },
        commands: numbers,
        injectedBuffer: report.injectedBuffer.filter(f => f.startsWith('#/engine/bot/')).sort(),
        processRefs: scan.processRefs
    };
}

// ---- CLI ----------------------------------------------------------------------------------------------------

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const args = process.argv.slice(2);
    const opt = name => {
        const i = args.indexOf(name);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const out = opt('--out');
    if (!out) {
        console.error('usage: node web/engine/build.mjs --out <Game dir> [--debug] [--engine-dir <dir>] [--content-dir <dir>] [--no-bots | --bots-lib <dir>] [--rebuild-bot-scripts]');
        process.exit(2);
    }
    try {
        const bots = args.includes('--no-bots') ? false : { lib: opt('--bots-lib'), rebuildScripts: args.includes('--rebuild-bot-scripts') };
        const info = await buildEngine({ out, debug: args.includes('--debug'), engineDir: opt('--engine-dir'), contentDir: opt('--content-dir'), bots });
        console.log(
            `engine: ${(info.bundle.bytes / 1024).toFixed(0)} KB bundle (${(info.bundle.gzip / 1024).toFixed(0)} KB gzip, ${info.bundle.inputs} modules), ` +
                `${info.data.files} data files (${(info.data.bytes / 1048576).toFixed(1)} MB), ${info.debug ? 'debug' : 'release'}, ${info.ms} ms`
        );
        if (info.bots) {
            const b = info.bots;
            console.log(
                `engine-bots: ${(b.bundle.bytes / 1024).toFixed(0)} KB bundle (${(b.bundle.gzip / 1024).toFixed(0)} KB gzip, ${b.bundle.libModules} bot modules from ${b.lib}), ` +
                    `script overlay ${b.overlay.scripts} scripts / ${b.overlay.bytes} bytes (${b.overlay.reused ? 'cached' : 'compiled'}), ${b.ms} ms`
            );
        }
        if (args.includes('--verbose')) console.log(JSON.stringify(info, null, 2));
    } catch (e) {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    }
}
