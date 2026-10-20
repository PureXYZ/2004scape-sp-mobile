// lostcity://game/engine/boot.js - module-worker bootstrap for the engine (ARCHITECTURE.md §2, §4).
//
//   page: const engine = new Worker('engine/boot.js', { type: 'module' });
//         engine.postMessage({ type: 'init', platform: 'ios', config: { node: { xpRate: 1 } } }); // world.json overrides
//   boot: set globalThis.__LC_PLATFORM__ from `platform` (docs/ANDROID.md §3.2), preload every file in
//         vfs-manifest.json into globalThis.__LC_VFS__, deep-merge `config` into world.json, import engine.js,
//         post {type:'booted'}, then hand all further messages to the engine.
//
// Bots (docs/BOTS.md §2): with config.bots.count > 0 (clamped to 0..1000) boot.js also preloads vfs-manifest-bots.json
// and imports engine-bots.js instead; with 0 (or no bots in config) it does exactly the above. A build without the
// bots bundle, or one whose bots bundle fails while it loads, starts with engine.js and without bots (logged), and
// says so after 'booted': {type:'bots', active:false, reason:'no-bundle'|'load-failed', detail} (docs/BOTS.md §4.1;
// engine-bots.js posts the same message when it switches the bots off later).
//
// The engine reads files synchronously while its modules evaluate, so the vfs must be complete BEFORE
// engine.js is imported - hence a separate, tiny bootstrap instead of a static import.
// It also forwards the worker's console to the page as {type:'log', level, text}: workers cannot reach
// webkit.messageHandlers, and the page relays these lines to the native log.

const DEBUG = __LC_DEBUG__; // replaced by build.mjs: debug builds also keep the worker's own console output
const scope = globalThis;

const post = (msg, transfer) => scope.postMessage(msg, transfer || []);

// ---- console forwarding ----------------------------------------------------------------------------------
const MAX_LOG = 8192;

function formatArg(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack && a.stack.includes(a.message) ? a.stack : `${a.name}: ${a.message}${a.stack ? '\n' + a.stack : ''}`;
    if (a === null || typeof a !== 'object') return String(a);
    try {
        const s = JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
        return s === undefined ? String(a) : s.length > 2000 ? s.slice(0, 2000) + '…' : s;
    } catch {
        return Object.prototype.toString.call(a);
    }
}

for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const native = typeof console[level] === 'function' ? console[level].bind(console) : null;
    console[level] = (...args) => {
        let text;
        try {
            text = args.map(formatArg).join(' ');
            if (text.length > MAX_LOG) text = text.slice(0, MAX_LOG) + '…';
        } catch {
            text = '[unformattable log message]';
        }
        try {
            post({ type: 'log', level, text });
        } catch {
            // nothing sensible left to do
        }
        if (DEBUG && native) native(...args);
    };
}

scope.addEventListener('error', e => console.error(`[engine] uncaught: ${e.message || e}${e.filename ? ` (${e.filename}:${e.lineno})` : ''}`));
scope.addEventListener('unhandledrejection', e => console.error('[engine] unhandled rejection:', e.reason));

// ---- messages: everything but 'init' waits until the engine is loaded --------------------------------------
let handler = null;
let booting = false;
const queue = [];

scope.addEventListener('message', ev => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init') {
        if (booting) {
            console.warn('[engine] duplicate init ignored');
            return;
        }
        booting = true;
        // Which app the engine runs in ('ios', 'android', or 'web' without one), set before the engine is imported:
        // on Android runtime/xhr.ts sends a save's bytes in a request header, because the app's request interception
        // never sees a body (docs/ANDROID.md §3.2). The worker cannot see the page's window.LostCityNative.
        scope.__LC_PLATFORM__ = typeof msg.platform === 'string' ? msg.platform : 'web';
        boot(msg.config).catch(fatal);
        return;
    }
    if (handler) handler(msg);
    else queue.push(msg);
});

function progress(stage, detail, fraction) {
    post(fraction === undefined ? { type: 'progress', stage, detail } : { type: 'progress', stage, detail, fraction });
}

function fatal(err) {
    console.error('[engine] boot failed:', err);
    post({ type: 'exit', code: 1 });
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target, source) {
    for (const [k, v] of Object.entries(source)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        if (isPlainObject(v) && isPlainObject(target[k])) deepMerge(target[k], v);
        else target[k] = v;
    }
    return target;
}

const WORLD_JSON = '/engine/data/config/world.json';
const MAX_BOTS = 1000; // the bots' roster (docs/BOTS.md §4.6)

/** init.config.bots.count as an integer in 0..MAX_BOTS: absent, 0 or junk = off. */
function botCount(config) {
    const n = Math.trunc(Number(isPlainObject(config) && isPlainObject(config.bots) ? config.bots.count : 0));
    return Number.isFinite(n) ? Math.min(MAX_BOTS, Math.max(0, n)) : 0;
}

async function boot(config) {
    const t0 = performance.now();
    const base = new URL('./', import.meta.url);
    let bots = botCount(config);
    let botsOff = null; // bots asked for but not loaded: { reason, detail } for the page
    const botsFiles = new Set(); // vfs paths only the bots bundle reads: their failure is the bots', not the game's

    // vfs store shared with the engine's fs shims (src/shims/vfs.ts)
    const store = (scope.__LC_VFS__ = { cwd: '/engine', files: new Map(), dirs: new Set(['/']), urls: new Map(), loadSync: null });
    const put = (path, data, url) => {
        store.files.set(path, data);
        if (url) store.urls.set(path, url);
        for (let d = path; ; ) {
            const i = d.lastIndexOf('/');
            d = i <= 0 ? '/' : d.slice(0, i);
            if (store.dirs.has(d)) break;
            store.dirs.add(d);
            if (d === '/') break;
        }
    };

    progress('preload', 'Loading game data', 0);
    const res = await fetch(new URL('vfs-manifest.json', base).href);
    if (!res.ok) throw new Error(`vfs-manifest.json: HTTP ${res.status}`);
    let manifest = await res.json(); // [[vfsPath, urlRelativeToEngineDir], ...]
    if (bots > 0) {
        let extra = null;
        let problem;
        try {
            const r = await fetch(new URL('vfs-manifest-bots.json', base).href);
            if (r.ok) extra = await r.json();
            else problem = `HTTP ${r.status}`;
        } catch (e) {
            problem = String(e?.message ?? e);
        }
        if (Array.isArray(extra)) {
            for (const [vfsPath] of extra) botsFiles.add(vfsPath);
            manifest = manifest.concat(extra);
        } else {
            console.warn(`[engine] bots were asked for, but this build has none (vfs-manifest-bots.json: ${problem ?? 'not a file list'}); starting without them`);
            botsOff = { reason: 'no-bundle', detail: `vfs-manifest-bots.json: ${problem ?? 'not a file list'}` };
            bots = 0;
        }
    }

    let loaded = 0;
    let bytes = 0;
    let lastReport = 0;
    await Promise.all(
        manifest.map(async ([vfsPath, rel]) => {
            const url = new URL(rel, base).href;
            let r;
            try {
                r = await fetch(url);
                if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`);
            } catch (e) {
                if (!botsFiles.has(vfsPath)) throw e;
                botsOff ??= { reason: 'load-failed', detail: String(e?.message ?? e) }; // the game starts without them
                return;
            }
            const data = new Uint8Array(await r.arrayBuffer());
            bytes += data.length;
            loaded++;
            // world.json gets the page's overrides: never re-fetch it from the bundle (no url)
            put(vfsPath, data, vfsPath === WORLD_JSON ? null : url);
            if (loaded === manifest.length || performance.now() - lastReport > 50) {
                lastReport = performance.now();
                progress('preload', `Loading game data (${loaded}/${manifest.length})`, loaded / manifest.length);
            }
        })
    );

    if (botsOff && bots > 0) {
        console.error(`[engine] the bots' data could not be loaded (${botsOff.detail}); starting without them`);
        for (const f of botsFiles) store.files.delete(f);
        bots = 0;
    }

    if (config && isPlainObject(config) && Object.keys(config).length) {
        const raw = store.files.get(WORLD_JSON);
        const world = raw ? JSON.parse(new TextDecoder().decode(raw)) : {};
        deepMerge(world, config);
        // the bots glue reads the count from here: the one boot.js decided on
        if (isPlainObject(world.bots)) world.bots.count = bots;
        put(WORLD_JSON, new TextEncoder().encode(JSON.stringify(world, null, 4) + '\n'), null);
        console.info(`[engine] world.json overrides: ${JSON.stringify(config)}`);
    }
    const preloadMs = performance.now() - t0;

    progress('import', 'Starting the game engine');
    const t1 = performance.now();
    let engine = null;
    if (bots > 0) {
        try {
            engine = await import('./engine-bots.js');
        } catch (e) {
            // bot code that fails while it loads must not keep the game from starting
            console.error('[engine] engine-bots.js failed to load; starting without bots:', e);
            botsOff = { reason: 'load-failed', detail: `engine-bots.js: ${String(e?.message ?? e)}` };
            bots = 0;
        }
    }
    engine ??= await import('./engine.js');
    const bundle = bots > 0 ? 'engine-bots.js' : 'engine.js';
    handler = engine.attach({ post });
    const evalMs = performance.now() - t1;

    post({ type: 'booted', preloadMs, evalMs, files: loaded, bytes, bundle, bots });
    if (botsOff) post({ type: 'bots', active: false, ...botsOff });
    for (const msg of queue.splice(0)) handler(msg);
}
