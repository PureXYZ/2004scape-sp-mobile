// The engine worker in a Node `vm` context that has only web-platform globals (no process, Buffer, require,
// setImmediate... - asserted), for test/vm.test.mjs and test/bots.test.mjs.
//
// Plays the roles of the WKWebView pieces: boot.js is loaded as a module "worker" from lostcity://game/engine/, its
// fetch() and synchronous XMLHttpRequest are served from the build output and a temp Documents folder (the scheme
// handler, lib/storage.mjs), and messages cross a structuredClone+transfer boundary like worker.postMessage.
// Returns { native, env, boot() }: `env` is the harness half of lib/session.mjs's contract (post, onMessage, sleep,
// now, storage, clock, slow, staticGets, hooks = the engine module's __test, bots = its __bots); boot() loads boot.js.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { FakeNative } from './storage.mjs';

const ORIGIN = 'lostcity://game';
const BUNDLES = ['engine.js', 'engine-bots.js'];

export function createVmWorker({ gameDir, documentsDir, testOptions = null }) {
    if (!vm.SourceTextModule) throw new Error('run with: node --experimental-vm-modules');
    const native = new FakeNative({ gameDir, documentsDir });
    let clockOffset = 0;
    const pageListeners = [];
    const hostEnc = new TextEncoder();
    const hostDec = new TextDecoder();

    function deliverToPage(msg, transfer) {
        // worker.postMessage semantics: structured clone, transferred buffers are detached in the worker
        const copy = structuredClone(msg, { transfer: transfer ?? [] });
        setTimeout(() => {
            for (const fn of pageListeners) fn(copy);
        }, 0);
    }

    const sandbox = {
        console: {},
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        queueMicrotask,
        performance,
        URL,
        URLSearchParams,
        atob,
        btoa,
        structuredClone,
        __host: {
            clock: () => clockOffset,
            getRandomValues: a => crypto.getRandomValues(a),
            encode: s => hostEnc.encode(s),
            decode: (u, o) => hostDec.decode(u, o),
            post: deliverToPage,
            // fetch(): async static GET through the fake scheme handler
            fetch: url => {
                const u = new URL(url);
                if (`${u.protocol}//${u.host}` !== ORIGIN) return { status: 0 };
                return native.handle('GET', u.pathname, null);
            },
            // synchronous XHR through the fake scheme handler
            xhr: (method, url, body, bodyKind) => {
                const u = new URL(url);
                if (`${u.protocol}//${u.host}` !== ORIGIN) throw new Error(`NetworkError: ${url}`);
                return native.handle(method, u.pathname, body, bodyKind);
            },
            log: (...a) => console.log(...a)
        }
    };
    const ctx = vm.createContext(sandbox, { name: 'engine-worker', codeGeneration: { strings: true, wasm: true } });
    vm.runInContext(
        `
    'use strict';
    const H = globalThis.__host;
    delete globalThis.__host;
    globalThis.self = globalThis;
    globalThis.location = { href: '${ORIGIN}/engine/boot.js', origin: '${ORIGIN}', protocol: 'lostcity:', host: 'game', hostname: 'game', pathname: '/engine/boot.js' };
    globalThis.importScripts = function () { throw new TypeError('Module scripts do not support importScripts().'); };
    globalThis.crypto = { getRandomValues: a => H.getRandomValues(a) };
    // context-realm Uint8Arrays (the engine does instanceof checks)
    const toCtx = u => { const c = new Uint8Array(u.length); c.set(u); return c; };
    globalThis.TextEncoder = class TextEncoder { get encoding() { return 'utf-8'; } encode(s = '') { return toCtx(H.encode(String(s))); } };
    globalThis.TextDecoder = class TextDecoder { constructor(l = 'utf-8') { this.encoding = l; } decode(u, o) { return H.decode(u === undefined ? new Uint8Array() : u, o); } };
    // engine clock control (simulated freezes): Date.now() only - that is what World.cycle schedules with
    const realNow = Date.now;
    Date.now = () => realNow() + H.clock();
    const listeners = new Map();
    globalThis.addEventListener = (type, fn) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); };
    globalThis.removeEventListener = (type, fn) => { const l = listeners.get(type) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
    globalThis.postMessage = (msg, transfer) => H.post(msg, transfer);
    globalThis.__dispatch = data => { for (const fn of listeners.get('message') || []) fn({ data }); };
    class Response {
        constructor(r) { this.status = r.status; this.ok = r.status >= 200 && r.status < 300; this._b = r.body ? toCtx(r.body) : new Uint8Array(); }
        async arrayBuffer() { return this._b.buffer; }
        async json() { return JSON.parse(new TextDecoder().decode(this._b)); }
        async text() { return new TextDecoder().decode(this._b); }
    }
    globalThis.fetch = async url => { const r = H.fetch(String(url)); if (!r.status) throw new TypeError('Load failed'); return new Response(r); };
    globalThis.XMLHttpRequest = class XMLHttpRequest {
        constructor() { this.readyState = 0; this.status = 0; this.response = null; this.responseType = ''; this._headers = {}; }
        open(method, url, async) { if (async !== false) throw new Error('test harness: only synchronous XHR is implemented'); this._m = method; this._u = String(url); this.readyState = 1; }
        setRequestHeader(k, v) { this._headers[k] = v; }
        send(body) {
            let bytes = null, kind = 'none';
            if (body instanceof ArrayBuffer) { bytes = new Uint8Array(body); kind = 'ArrayBuffer'; }
            else if (ArrayBuffer.isView(body)) { bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength); kind = 'ArrayBufferView'; }
            else if (body != null) { kind = typeof body; }
            const r = H.xhr(this._m, this._u, bytes, kind);
            this.status = r.status;
            this.readyState = 4;
            this.response = r.body && this.responseType === 'arraybuffer' ? toCtx(r.body).buffer : null;
        }
    };
    `,
        ctx
    );
    const leaked = vm.runInContext(`['process','Buffer','require','module','global','setImmediate','__dirname','__filename','WebSocket'].filter(k => typeof globalThis[k] !== 'undefined')`, ctx);
    if (leaked.length) throw new Error('Node globals leaked into the sandbox: ' + leaked.join(', '));
    if (vm.runInContext(`typeof WebAssembly`, ctx) !== 'object') throw new Error('sandbox has no WebAssembly');
    if (testOptions) vm.runInContext(`globalThis.__LC_ENGINE_TEST__ = ${JSON.stringify(testOptions)}`, ctx);

    let engineModule = null;
    async function loadModule(url) {
        const file = path.join(gameDir, new URL(url).pathname);
        const mod = new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), {
            context: ctx,
            identifier: url,
            initializeImportMeta(meta) {
                meta.url = url;
            },
            importModuleDynamically: async specifier => {
                const target = new URL(specifier, url).href;
                if (!BUNDLES.some(b => target === `${ORIGIN}/engine/${b}`)) throw new Error(`unexpected dynamic import ${target}`);
                engineModule = await loadModule(target);
                return engineModule;
            }
        });
        await mod.link(spec => {
            throw new Error(`${url} must not import '${spec}' statically`);
        });
        await mod.evaluate();
        return mod;
    }

    const env = {
        post: (msg, transfer) => {
            const copy = structuredClone(msg, { transfer: transfer ?? [] });
            setTimeout(() => ctx.__dispatch(copy), 0);
        },
        onMessage: fn => pageListeners.push(fn),
        sleep: ms => new Promise(r => setTimeout(r, ms)),
        now: () => performance.now(),
        log: line => console.log(line),
        storage: native.storage,
        clock: { advance: ms => (clockOffset += ms) },
        slow: 1,
        staticGets: () => native.staticGets
    };
    Object.defineProperty(env, 'hooks', { get: () => engineModule?.namespace.__test ?? null });
    Object.defineProperty(env, 'bots', { get: () => engineModule?.namespace.__bots ?? null });
    Object.defineProperty(env, 'bundle', { get: () => (engineModule ? path.basename(new URL(engineModule.identifier).pathname) : null) });

    return { native, ctx, env, boot: () => loadModule(`${ORIGIN}/engine/boot.js`) };
}
