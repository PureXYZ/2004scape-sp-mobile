// Test (b), the in-JSC half: runs INSIDE the macOS JavaScriptCore shell (same WebKit generation as iOS WKWebView).
// Launched by test/jsc.test.mjs:  jsc [--useJIT=false --useWasm=false] -m jsc-harness.mjs -- <runDir> <gameDir> [--measure]
// and by test/bots.test.mjs with --bots-boot=<boot> (one boot of lib/bots-session.mjs; <runDir>/bots.json has its
// settings, <runDir>/save-index.json the Documents listing for /save-index: the shell cannot list directories).
//
// The shell has no web APIs and no Node APIs. This file supplies minimal stand-ins for what a dedicated module
// worker has (console, clearTimeout, queueMicrotask, TextEncoder/Decoder, URL, crypto.getRandomValues, fetch,
// synchronous XMLHttpRequest, postMessage/addEventListener) and nothing else, then boots <gameDir>/engine/boot.js
// and runs test/lib/session.mjs against it. Engine and "page" share this realm; messages are copied and transferred
// buffers detached (ArrayBuffer.prototype.transfer) like worker.postMessage.
/* global print, readFile, writeFile, preciseTime, gcHeapSize, fullGC, quit */
import { runBotsBoot, runBotsMeasure } from './lib/bots-session.mjs';
import { runSession } from './lib/session.mjs';

const args = typeof arguments !== 'undefined' ? [...arguments] : []; // eslint-disable-line prefer-rest-params
const [RUN, OUT] = args.filter(a => !a.startsWith('--'));
const MEASURE = args.includes('--measure');
const VERBOSE = args.includes('--verbose');
const SLOW = Number((args.find(a => a.startsWith('--slow=')) ?? '--slow=1').split('=')[1]);
const BOTS_BOOT = (args.find(a => a.startsWith('--bots-boot=')) ?? '').split('=')[1]; // a boot, or 'measure'
const DOCS = `${RUN}/Documents`;
const t0 = preciseTime();
const now = () => (preciseTime() - t0) * 1000;
const mb = n => +(n / 1048576).toFixed(1);

// ---------------------------------------------------------------------------------------------- web API stand-ins
const fmt = a => a.map(x => (typeof x === 'string' ? x : x instanceof Error ? x.stack || String(x) : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ');
globalThis.console = { log: (...a) => print(fmt(a)), info: (...a) => print(fmt(a)), debug: (...a) => print(fmt(a)), warn: (...a) => print('WARN ' + fmt(a)), error: (...a) => print('ERROR ' + fmt(a)) };

const nativeSetTimeout = globalThis.setTimeout;
const cancelled = new Set();
let nextTimer = 1;
globalThis.setTimeout = (fn, ms = 0, ...a) => {
    const id = nextTimer++;
    nativeSetTimeout(() => {
        if (!cancelled.delete(id)) fn(...a);
    }, ms);
    return id;
};
globalThis.clearTimeout = id => void cancelled.add(id);
globalThis.setInterval = (fn, ms = 0) => {
    const id = nextTimer++;
    const tick = () => {
        if (cancelled.has(id)) return;
        nativeSetTimeout(tick, ms);
        fn();
    };
    nativeSetTimeout(tick, ms);
    return id;
};
globalThis.clearInterval = globalThis.clearTimeout;
globalThis.queueMicrotask = fn =>
    void Promise.resolve()
        .then(fn)
        .catch(e => print('ERROR uncaught in microtask: ' + (e && e.stack)));

globalThis.TextEncoder = class TextEncoder {
    get encoding() {
        return 'utf-8';
    }
    encode(s = '') {
        const out = [];
        for (const ch of String(s)) {
            const c = ch.codePointAt(0);
            if (c < 0x80) out.push(c);
            else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
            else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
            else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        }
        return Uint8Array.from(out);
    }
};
globalThis.TextDecoder = class TextDecoder {
    constructor(enc = 'utf-8') {
        this.encoding = enc;
    }
    decode(u = new Uint8Array()) {
        u = u instanceof Uint8Array ? u : ArrayBuffer.isView(u) ? new Uint8Array(u.buffer, u.byteOffset, u.byteLength) : new Uint8Array(u);
        let s = '';
        for (let i = 0; i < u.length; ) {
            const b = u[i++];
            if (b < 0x80) s += String.fromCharCode(b);
            else if (b < 0xe0) s += String.fromCharCode(((b & 31) << 6) | (u[i++] & 63));
            else if (b < 0xf0) s += String.fromCharCode(((b & 15) << 12) | ((u[i++] & 63) << 6) | (u[i++] & 63));
            else s += String.fromCodePoint(((b & 7) << 18) | ((u[i++] & 63) << 12) | ((u[i++] & 63) << 6) | (u[i++] & 63));
        }
        return s;
    }
};

// hierarchical URLs only (file:, lostcity:, http:) - enough for new URL(rel, base) and .href/.pathname
globalThis.URL = class URL {
    constructor(url, base) {
        url = String(url);
        let m = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(url);
        if (!m) {
            if (base === undefined) throw new TypeError('Invalid URL: ' + url);
            const b = new URL(base);
            const [p, q = '', h = ''] = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url).slice(1);
            const joined = p.startsWith('/') ? p : b.pathname.replace(/[^/]*$/, '') + p;
            const segs = [];
            for (const s of joined.split('/').slice(1)) {
                if (s === '..') segs.pop();
                else if (s !== '.') segs.push(s);
            }
            m = [null, b.protocol, b.host, '/' + segs.join('/'), q, h];
        }
        this.protocol = m[1];
        this.host = this.hostname = m[2];
        this.pathname = m[3] || '/';
        this.search = m[4] || '';
        this.hash = m[5] || '';
        this.origin = this.protocol + '//' + this.host;
        this.href = this.origin + this.pathname + this.search + this.hash;
    }
    toString() {
        return this.href;
    }
};

globalThis.crypto = {
    getRandomValues(a) {
        const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        for (let i = 0; i < u8.length; i++) u8[i] = (Math.random() * 256) | 0;
        return a;
    }
};

// engine clock control (simulated freezes); the session and this harness use preciseTime
let clockOffset = 0;
const realNow = Date.now;
Date.now = () => realNow() + clockOffset;

// ---------------------------------------------------------------------------------------------- "scheme handler"
// (the jsc shell cannot remove a file: a deleted one is remembered as gone, and written again by the next PUT)
const deleted = new Set();
const storage = {
    puts: [],
    gets: [],
    deletes: [],
    indexGets: 0,
    failPut: false,
    failGet: false,
    failDelete: false,
    read(rel) {
        if (deleted.has(rel)) return null;
        try {
            return new Uint8Array(readFile(`${DOCS}/${rel}`, 'binary'));
        } catch {
            return null;
        }
    }
};
const staticGets = [];
const bodyKinds = new Set();

function fileOf(url) {
    const u = new URL(url);
    if (u.protocol !== 'file:') return null;
    return decodeURIComponent(u.pathname);
}

// /save-index: the launcher's listing of Documents, plus what was written since
function saveIndex() {
    let files = [];
    try {
        files = JSON.parse(new TextDecoder().decode(new Uint8Array(readFile(`${RUN}/save-index.json`, 'binary'))));
    } catch {
        // no listing: an empty Documents folder
    }
    files = files.filter(f => !deleted.has(f.path));
    const known = new Set(files.map(f => f.path));
    for (const rel of [...storage.deletes.filter(d => d.status === 204).map(d => `${d.rel}.bak`)]) {
        if (!known.has(rel) && storage.read(rel)) {
            known.add(rel);
            files.push({ path: rel, size: storage.read(rel).length, modified: Date.now() });
        }
    }
    for (const p of storage.puts) {
        if (deleted.has(p.rel)) continue;
        for (const rel of [p.rel, ...(storage.read(`${p.rel}.bak`) ? [`${p.rel}.bak`] : [])]) {
            if (!known.has(rel)) {
                known.add(rel);
                files.push({ path: rel, size: p.bytes.length, modified: Date.now() });
            }
        }
    }
    return files;
}

function handle(method, url, body, bodyKind) {
    const file = fileOf(url);
    if (!file) return { status: 0 };
    if (file === `${OUT}/save-index` && method === 'GET') {
        storage.indexGets++;
        return { status: 200, body: new TextEncoder().encode(JSON.stringify(saveIndex())) };
    }
    const savePrefix = `${OUT}/save/`;
    if (file.startsWith(savePrefix)) {
        const rel = file.slice(savePrefix.length);
        if (rel.split('/').some(s => s === '..' || s === '')) return { status: 400 };
        if (method === 'GET') {
            if (typeof storage.failGet === 'function' ? storage.failGet(rel) : storage.failGet) {
                storage.gets.push({ rel, status: 500 });
                return { status: 500 };
            }
            const data = storage.read(rel);
            storage.gets.push({ rel, status: data ? 200 : 404 });
            return data ? { status: 200, body: data } : { status: 404 };
        }
        if (method === 'PUT') {
            bodyKinds.add(bodyKind);
            if (typeof storage.failPut === 'function' ? storage.failPut(rel) : storage.failPut) return { status: 500 };
            const bytes = body ?? new Uint8Array(0);
            const old = storage.read(rel);
            if (old) writeFile(`${DOCS}/${rel}.bak`, old);
            writeFile(`${DOCS}/${rel}`, bytes); // the launcher pre-creates players/<profile>/
            deleted.delete(rel);
            storage.puts.push({ rel, bytes: bytes.slice(), bodyKind });
            return { status: 204 };
        }
        if (method === 'DELETE') {
            // like SaveStore: a deleted file is kept as <file>.bak (replacing the older one)
            const data = storage.read(rel);
            const status = storage.failDelete ? 500 : data ? 204 : 404;
            storage.deletes.push({ rel, status });
            if (status === 204) {
                if (!rel.endsWith('.bak')) {
                    writeFile(`${DOCS}/${rel}.bak`, data);
                    deleted.delete(`${rel}.bak`);
                }
                deleted.add(rel);
            }
            return { status };
        }
        return { status: 405 };
    }
    if (method !== 'GET') return { status: 405 };
    try {
        const data = new Uint8Array(readFile(file, 'binary'));
        staticGets.push(file);
        return { status: 200, body: data };
    } catch {
        return { status: 404 };
    }
}

class Response {
    constructor(r) {
        this.status = r.status;
        this.ok = r.status >= 200 && r.status < 300;
        this._b = r.body ?? new Uint8Array();
    }
    async arrayBuffer() {
        return this._b.buffer.slice(this._b.byteOffset, this._b.byteOffset + this._b.byteLength);
    }
    async json() {
        return JSON.parse(new TextDecoder().decode(this._b));
    }
}
globalThis.fetch = async url => {
    const r = handle('GET', String(url));
    if (!r.status) throw new TypeError('Load failed');
    return new Response(r);
};
globalThis.XMLHttpRequest = class XMLHttpRequest {
    constructor() {
        this.status = 0;
        this.response = null;
        this.responseType = '';
    }
    open(method, url, async) {
        if (async !== false) throw new Error('only synchronous XHR is implemented');
        this.m = method;
        this.u = String(url);
    }
    setRequestHeader() {}
    send(body) {
        let bytes = null;
        let kind = 'none';
        if (body instanceof ArrayBuffer) {
            bytes = new Uint8Array(body);
            kind = 'ArrayBuffer';
        } else if (ArrayBuffer.isView(body)) {
            bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
            kind = 'ArrayBufferView';
        } else if (body != null) kind = typeof body;
        const r = handle(this.m, this.u, bytes, kind);
        if (!r.status) throw new Error('NetworkError');
        this.status = r.status;
        this.response = r.body && this.responseType === 'arraybuffer' ? r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.byteLength) : null;
    }
};

// ---------------------------------------------------------------------------------------------- worker scope
const BOOT = `file://${OUT}/engine/boot.js`;
const ENGINE_DIR = `file://${OUT}/engine/`;
globalThis.self = globalThis;
globalThis.location = { href: BOOT, protocol: 'file:', host: '', pathname: `${OUT}/engine/boot.js` };
globalThis.importScripts = () => {
    throw new TypeError('Module scripts do not support importScripts().');
};

// worker.postMessage semantics: a copy for the receiver, transferred buffers detached in the sender
function cloneMessage(msg, transfer) {
    const copy = { ...msg };
    for (const [k, v] of Object.entries(copy)) {
        if (v instanceof ArrayBuffer) copy[k] = transfer && transfer.includes(v) ? v.transfer() : v.slice(0);
        else if (ArrayBuffer.isView(v)) copy[k] = v.slice();
        else if (v && typeof v === 'object') copy[k] = JSON.parse(JSON.stringify(v));
    }
    return copy;
}
const workerListeners = new Map();
globalThis.addEventListener = (type, fn) => {
    if (!workerListeners.has(type)) workerListeners.set(type, []);
    workerListeners.get(type).push(fn);
};
globalThis.removeEventListener = (type, fn) => {
    const l = workerListeners.get(type) || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
};
const pageListeners = [];
let engineNs = null;
globalThis.postMessage = (msg, transfer) => {
    const copy = cloneMessage(msg, transfer);
    setTimeout(async () => {
        // the same module instance boot.js loaded: engine.js, or engine-bots.js with bots
        if (copy.type === 'booted' && !engineNs) engineNs = await import(ENGINE_DIR + (copy.bundle || 'engine.js'));
        for (const fn of pageListeners) fn(copy);
    }, 0);
};

const fixture = JSON.parse(new TextDecoder().decode(new Uint8Array(readFile(`${RUN}/fixture.json`, 'binary'))));
const env = {
    post: (msg, transfer) => {
        const copy = cloneMessage(msg, transfer);
        setTimeout(() => {
            for (const fn of workerListeners.get('message') || []) fn({ data: copy });
        }, 0);
    },
    onMessage: fn => pageListeners.push(fn),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now,
    log: line => print(line),
    verbose: VERBOSE,
    storage,
    fixture,
    get hooks() {
        return engineNs ? engineNs.__test : null;
    },
    get bots() {
        return engineNs ? (engineNs.__bots ?? null) : null;
    },
    staticGets: () => staticGets.map(f => (f.startsWith(`${OUT}/`) ? f.slice(OUT.length + 1) : f)),
    clock: { advance: ms => (clockOffset += ms) },
    slow: SLOW,
    config: { node: { profile: 'enginetest' } }
};

function heap() {
    fullGC();
    return gcHeapSize();
}

async function main() {
    const heap0 = heap();
    await import(BOOT);

    if (MEASURE) {
        const msgs = [];
        env.onMessage(m => {
            msgs.push(m);
            if (m.type === 'log' && (VERBOSE || m.level !== 'info')) print(`  [worker ${m.level}] ${m.text.split('\n')[0]}`);
        });
        const until = async (type, ms) => {
            const end = now() + ms;
            while (!msgs.some(m => m.type === type)) {
                if (now() > end || msgs.some(m => m.type === 'exit')) throw new Error('no ' + type);
                await env.sleep(10);
            }
            return msgs.find(m => m.type === type);
        };
        env.post({ type: 'init', config: {} });
        const booted = await until('booted', 120000 * SLOW);
        const heapBooted = heap();
        env.post({ type: 'start' });
        const ready = await until('ready', 300000 * SLOW);
        const H = env.hooks;
        await env.sleep(6000);
        const res = {
            runtime: 'JavaScriptCore (macOS jsc shell)',
            options: { flatStrings: H.testOptions.flatStrings !== false, release: H.testOptions.release !== false, wasmBzip2: H.testOptions.wasmBzip2 !== false, webAssembly: typeof WebAssembly },
            bootedMs: { preload: Math.round(booted.preloadMs), eval: Math.round(booted.evalMs) },
            startMs: Math.round(ready.ms),
            gcHeapMB: { baseline: mb(heap0), afterBoot: mb(heapBooted), afterStart: mb(heap()) },
            vfs: H.vfs.stats(),
            bzip2: H.bzip2.kind,
            ticks: H.ticker.tickSummary()
        };
        print('[jsc] MEASURE ' + JSON.stringify(res));
        quit(0);
    }

    if (BOTS_BOOT === 'measure') {
        env.heap = () => mb(heap());
        const row = await runBotsMeasure(env, env.measure);
        print('[jsc] MEASURE ' + JSON.stringify({ js: `JavaScriptCore${typeof WebAssembly === 'object' ? '' : ' without JIT and WASM'} (heap = gcHeapSize)`, ...row }));
        quit(0);
    }
    if (BOTS_BOOT) {
        const result = await runBotsBoot(env, BOTS_BOOT);
        result.gcHeapMB = mb(heap());
        result.bodyKinds = [...bodyKinds];
        print('[jsc] RESULT ' + JSON.stringify(result));
        quit(result.ok ? 0 : 1);
    }

    const result = await runSession(env);
    result.gcHeapMB = mb(heap());
    result.webAssembly = typeof WebAssembly;
    result.bodyKinds = [...bodyKinds];
    result.staticGets = staticGets.length;
    print('[jsc] RESULT ' + JSON.stringify(result));
    quit(result.ok ? 0 : 1);
}

if (typeof globalThis.__LC_ENGINE_TEST_JSON__ === 'string') globalThis.__LC_ENGINE_TEST__ = JSON.parse(globalThis.__LC_ENGINE_TEST_JSON__);
if (BOTS_BOOT) {
    // bots.json: the boot's settings (bots.test.mjs bootSettings) and test options
    const settings = JSON.parse(new TextDecoder().decode(new Uint8Array(readFile(`${RUN}/bots.json`, 'binary'))));
    Object.assign(env, { botCount: settings.botCount, profile: settings.profile, spawnPerTick: settings.spawnPerTick, stub: settings.stub, config: settings.config, measure: settings.measure });
    globalThis.__LC_ENGINE_TEST__ = { ...(globalThis.__LC_ENGINE_TEST__ ?? {}), ...(settings.testOptions ?? {}) };
}
for (const a of args) {
    if (a === '--no-flat-strings') (globalThis.__LC_ENGINE_TEST__ ??= {}).flatStrings = false;
    if (a === '--no-release') (globalThis.__LC_ENGINE_TEST__ ??= {}).release = false;
    if (a === '--no-wasm') (globalThis.__LC_ENGINE_TEST__ ??= {}).wasmBzip2 = false;
}
main().catch(e => {
    print('[jsc] FATAL ' + (e && e.stack ? e.stack : e));
    quit(2);
});
