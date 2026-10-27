// The desktop double of the apps' native side for online mode (docs/ONLINE.md, docs/ARCHITECTURE.md §7.2), so that
// desktop Chrome runs the page's very same online code (NativeSocket, the accounts, the server box, the proxy routes):
//
//   - a document-start script in the page (served as /__lc-app/shim.js and put first into index.html's <head>):
//     window.LostCityNative ({platform, settings, savedPasswords, …}, as native injects it), window.webkit.messageHandlers
//     (iOS's shape; with platform 'android' LostCityNativeBridge and lcAndroid instead, calls through window.__lcCall).
//     It relays the page's messages to this file (POST /__lc-app/post, in order, one request at a time) and applies
//     native's calls from it (an EventSource on /__lc-app/events): LostCityHost.socket.events, accounts.login,
//     accounts.saved, servers.answer, and a reload for `server use`. It records every message for the tests
//     (window.__lcApp.posted, passwords blanked) and types real keys into LostCityHost.keyboard, so the page also plays by
//     hand in a desktop browser;
//   - the socket bridge: one WebSocket per page socket to the current server (wsclient.mjs), events batched per
//     event-loop turn, the error words and close codes native gives;
//   - the proxy routes while the page load is online (decided when index.html is served, from the stored
//     settings, as native does): /crc (10 s, 40 bytes with a good trailer; kept for the page load), the 8 jags (the
//     bundled file when the name matches, else a cached copy whose CRC32 matches, else the server's, checked and cached),
//     GET/PUT /ondemand/<archive>/<file> (a cache per server), and /server-probe (in every mode);
//   - settings (stored when the page sends them, their keys sorted as native's), remembered passwords (in memory only, never logged), the server box's
//     answers (queued by a test: `answers`), server use/delete (a reload; the cache folder and passwords removed).
//
// Never logs a socket's contents or a password: the log has socket opens, closes and errors with the host and the code.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import '../../host/serverurl.js';
import { headerBody } from '../serve.mjs';
import { openWebSocket } from './wsclient.mjs';

const { normalize, socketUrl } = globalThis.lcServerUrl;
const JAGS = ['title', 'config', 'interface', 'media', 'versionlist', 'textures', 'wordenc', 'sounds'];
const JAG_ROUTE = new RegExp(`^/(${JAGS.join('|')})(-?\\d+)$`);
const MAX_ONDEMAND = 4 * 1048576;

// The client's own check of /crc (Client.getJagChecksums): 9 CRCs and a trailer computed from them, 40 bytes.
export function crcTableOk(bytes) {
    if (bytes?.length !== 40) {
        return false;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, 40);
    let calculated = 1234;
    for (let i = 0; i < 9; i++) {
        calculated = ((calculated << 1) + view.getInt32(i * 4)) | 0;
    }
    return view.getInt32(36) === calculated;
}

const crc32 = bytes => zlib.crc32(bytes) | 0;

// Settings as native stores and gives them back: every object's keys sorted (iOS JSONSerialization .sortedKeys, Android
// JsonText.sorted), so the page never relies on the order it wrote them in.
const sortedKeys = value =>
    Array.isArray(value) ? value.map(sortedKeys) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])])) : value;

// A fetch with a time limit; the words of the 502 a failure gives.
async function fetchWithin(url, ms) {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'follow' });
        const body = new Uint8Array(await response.arrayBuffer());
        return { status: response.status, body };
    } catch (err) {
        return { error: err?.name === 'TimeoutError' ? 'timed out' : 'unreachable' };
    }
}

// The probe: /crc, then rs2.cgi's `new Client(<nodeid>, <lowmem>, <members>)` and the login key in
// client/client.js. ok = a 40-byte table with a good trailer.
export async function probeServer(raw, { timeoutMs = 10000 } = {}) {
    const url = normalize(raw);
    const result = { ok: false, url, crc: false, nodeId: 10, members: true, rsa: null, notes: [] };
    if (!url) {
        return { ...result, error: 'invalid address' };
    }
    const crc = await fetchWithin(`${url}/crc`, timeoutMs);
    if (crc.error) {
        return { ...result, error: crc.error };
    }
    if (crc.status === 404 || (crc.status === 200 && !crcTableOk(crc.body))) {
        return { ...result, error: 'not a 2004scape server' };
    }
    if (crc.status !== 200) {
        return { ...result, error: `http ${crc.status}` };
    }
    result.ok = result.crc = true;
    const page = await fetchWithin(`${url}/rs2.cgi`, timeoutMs);
    const client = page.status === 200 ? /new\s+Client\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(true|false|1|0)\s*\)/.exec(Buffer.from(page.body).toString('utf8')) : null;
    if (client) {
        result.nodeId = Number(client[1]);
        result.members = client[3] === 'true' || client[3] === '1';
    } else {
        result.notes.push('No world settings found: world 10, members.');
    }
    const bundle = await fetchWithin(`${url}/client/client.js`, timeoutMs);
    const text = bundle.status === 200 ? Buffer.from(bundle.body).toString('utf8') : '';
    const named = /rsaenc\(\s*BigInt\(\s*["'](\d+)["']\s*\)\s*,\s*BigInt\(\s*["'](\d+)["']\s*\)\s*\)/.exec(text);
    const pairs = new Set([...text.matchAll(/BigInt\(\s*["'](\d{40,})["']\s*\)\s*,\s*BigInt\(\s*["'](\d+)["']\s*\)/g)].map(m => `${m[1]},${m[2]}`));
    if (named) {
        result.rsa = { n: named[1], e: named[2] };
    } else if (pairs.size === 1) {
        const [n, e] = [...pairs][0].split(',');
        result.rsa = { n, e };
    } else {
        result.notes.push('No login key found: the built-in key.');
    }
    return result;
}

export function nativeDouble({ root, cacheDir, platform = 'ios', settings = {}, savedPasswords = {}, log = false } = {}) {
    const state = {
        platform,
        settings: sortedKeys(settings),
        passwords: new Map(Object.entries(savedPasswords)), // '<server id>/<lower-case name>' -> password
        answers: [], // the server box's next answers ({address, name} or null), a test's
        log: [], // socket opens, closes and errors; proxy fetches (never contents)
        posted: [], // every page -> native message, passwords blanked
        pageId: 0,
        page: null, // { id, server: entry or null, crc: Buffer|null }
        sockets: new Map(), // '<page>:<id>' -> { socket, purpose, page }
        streams: new Map(), // page id -> { res, queue }
        pending: new Map() // page id -> events waiting for the next flush
    };
    const note = line => {
        state.log.push(line);
        if (log) {
            console.log(`[app] ${line}`);
        }
    };

    // The server entry the stored settings choose, or null (offline): the page's online rule.
    const chosen = () => {
        const servers = Array.isArray(state.settings.servers) ? state.settings.servers : [];
        const entry = servers.find(s => s?.id === state.settings.server && typeof s.id === 'string');
        return entry && normalize(entry.url) ? { ...entry, url: normalize(entry.url) } : null;
    };
    const savedNames = () => {
        const saved = {};
        for (const key of state.passwords.keys()) {
            const [id, name] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
            (saved[id] ??= []).push(name);
        }
        return saved;
    };
    const serverCache = id => path.join(cacheDir, 'online', id.replace(/[^A-Za-z0-9_-]/g, '_'));

    // ---------------------------------------------------------------- native -> page

    function call(pageId, message) {
        const stream = state.streams.get(pageId);
        if (stream) {
            stream.res.write(`data: ${JSON.stringify(message)}\n\n`);
        } else {
            (state.pending.get(pageId) ?? state.pending.set(pageId, []).get(pageId)).push(message);
        }
    }

    // socket events, everything of one event-loop turn in one call
    const batches = new Map(); // page id -> events
    function socketEvent(pageId, event) {
        if (!batches.has(pageId)) {
            batches.set(pageId, []);
            setImmediate(() => {
                const batch = batches.get(pageId);
                batches.delete(pageId);
                call(pageId, { path: 'socket.events', args: [batch] });
            });
        }
        batches.get(pageId).push(event);
    }

    // ---------------------------------------------------------------- page -> native

    function closePageSockets(pageId, why) {
        for (const [key, entry] of state.sockets) {
            if (pageId === null || entry.page === pageId) {
                entry.socket.close();
                state.sockets.delete(key);
                note(`socket ${key} closed (${why})`);
            }
        }
    }

    function onSocket(pageId, msg) {
        const id = Number(msg.id);
        const key = `${pageId}:${id}`;
        if (msg.action === 'open') {
            if (!Number.isInteger(id) || id < 1 || state.sockets.has(key)) {
                return;
            }
            const server = state.page?.id === pageId ? state.page.server : null;
            if (!server) {
                socketEvent(pageId, { id, event: 'error', reason: 'no server' });
                socketEvent(pageId, { id, event: 'close', code: 1006, reason: 'no server' });
                return;
            }
            const url = socketUrl(server.url);
            const purpose = msg.purpose === 'ondemand' ? 'ondemand' : 'game';
            const entry = { purpose, page: pageId, queue: [] };
            entry.socket = openWebSocket(url, {
                onOpen: () => {
                    note(`socket ${key} (${purpose}) open to ${new URL(url).host}`);
                    socketEvent(pageId, { id, event: 'open' });
                    for (const bytes of entry.queue) {
                        entry.socket.send(bytes);
                    }
                    entry.queue = [];
                },
                onMessage: bytes => {
                    entry.in = (entry.in ?? 0) + 1;
                    socketEvent(pageId, { id, event: 'message', data: Buffer.from(bytes).toString('base64') });
                },
                onError: words => {
                    note(`socket ${key} (${purpose}) to ${new URL(url).host} failed: ${words}`);
                    socketEvent(pageId, { id, event: 'error', reason: words });
                },
                onClose: (code, reason) => {
                    state.sockets.delete(key);
                    note(`socket ${key} (${purpose}) closed: ${code}${reason ? ` ${reason}` : ''} (${entry.in ?? 0} messages in, ${entry.out ?? 0} out)`);
                    socketEvent(pageId, { id, event: 'close', code, reason });
                }
            });
            state.sockets.set(key, entry);
        } else if (msg.action === 'send') {
            const entry = state.sockets.get(key);
            if (entry && typeof msg.data === 'string') {
                const bytes = Buffer.from(msg.data, 'base64');
                entry.out = (entry.out ?? 0) + 1;
                if (entry.socket.open) {
                    entry.socket.send(bytes);
                } else {
                    entry.queue.push(bytes);
                }
            }
        } else if (msg.action === 'close') {
            const entry = state.sockets.get(key);
            if (entry) {
                state.sockets.delete(key);
                entry.socket.close();
                note(`socket ${key} (${entry.purpose}) closed by the page (${entry.in ?? 0} messages in, ${entry.out ?? 0} out)`);
            }
        }
    }

    function onAccount(pageId, msg) {
        const servers = Array.isArray(state.settings.servers) ? state.settings.servers : [];
        const name = typeof msg.name === 'string' ? msg.name : '';
        const key = `${msg.server}/${name.toLowerCase()}`;
        if (msg.action === 'save-password') {
            if (!servers.some(s => s?.id === msg.server) || name.length < 1 || name.length > 12 || typeof msg.password !== 'string' || msg.password.length < 1 || msg.password.length > 20) {
                note(`save-password for ${msg.server}/${name}: refused`);
                return;
            }
            state.passwords.set(key, msg.password);
            note(`save-password ${key}`);
            call(pageId, { path: 'accounts.saved', args: [savedNames()] });
        } else if (msg.action === 'forget-password') {
            state.passwords.delete(key);
            note(`forget-password ${key}`);
            call(pageId, { path: 'accounts.saved', args: [savedNames()] });
        } else if (msg.action === 'login') {
            note(`login ${key}: ${state.passwords.has(key) ? 'a stored password' : 'none stored'}`);
            call(pageId, { path: 'accounts.login', args: [name, state.passwords.get(key) ?? null] });
        }
    }

    function onServer(pageId, msg) {
        if (msg.action === 'use') {
            const servers = Array.isArray(state.settings.servers) ? state.settings.servers : [];
            if (msg.id !== 'offline' && !servers.some(s => s?.id === msg.id)) {
                note(`server use ${msg.id}: no such server, ignored`);
                return;
            }
            state.settings = sortedKeys({ ...state.settings, server: msg.id });
            note(`server use ${msg.id}: reload`);
            closePageSockets(pageId, 'server use');
            call(pageId, { reload: true });
        } else if (msg.action === 'delete') {
            const id = String(msg.id ?? '');
            fs.rmSync(serverCache(id), { recursive: true, force: true });
            for (const key of [...state.passwords.keys()]) {
                if (key.startsWith(`${id}/`)) {
                    state.passwords.delete(key);
                }
            }
            note(`server delete ${id}`);
            call(pageId, { path: 'accounts.saved', args: [savedNames()] });
        } else if (msg.action === 'ask') {
            const answer = state.answers.length ? state.answers.shift() : null;
            note(`server ask "${msg.title ?? ''}": ${answer ? 'OK' : 'Cancel'}`);
            call(pageId, { path: 'servers.answer', args: [answer ? { address: String(answer.address ?? '').trim(), name: String(answer.name ?? '').trim() } : null] });
        }
    }

    function onMessage(pageId, msg) {
        state.posted.push(msg?.type === 'account' && 'password' in msg ? { ...msg, password: msg.password ? '(a password)' : '' } : msg);
        if (msg?.type === 'settings' && msg.values && typeof msg.values === 'object') {
            state.settings = sortedKeys(msg.values);
        } else if (msg?.type === 'socket') {
            onSocket(pageId, msg);
        } else if (msg?.type === 'account') {
            onAccount(pageId, msg);
        } else if (msg?.type === 'server') {
            onServer(pageId, msg);
        }
    }

    // ---------------------------------------------------------------- the page's document-start script

    function shim(pageId) {
        const native = {
            platform: state.platform,
            appVersion: 'desktop',
            build: '0',
            osVersion: 'desktop',
            deviceModel: 'desktop double',
            simulator: false,
            debug: true,
            settings: sortedKeys(state.settings), // (a test may have set them directly)
            savedPasswords: savedNames(),
            lm: { local: { available: false, loaded: false, think: 'never', reason: 'no-model' }, online: { keySet: false } }
        };
        return `(() => {
    if (window.top !== window) return;
    const page = ${pageId};
    const app = (window.__lcApp = { page, posted: [], calls: [] });
    window.LostCityNative = ${JSON.stringify(native)};
    const queue = [];
    let sending = false;
    const flush = () => {
        if (sending || !queue.length) return;
        sending = true;
        const batch = queue.splice(0);
        fetch('__lc-app/post?page=' + page, { method: 'POST', body: JSON.stringify(batch), headers: { 'Content-Type': 'application/json' } })
            .catch(() => {})
            .finally(() => { sending = false; flush(); });
    };
    const post = msg => {
        app.posted.push(msg && msg.type === 'account' && 'password' in msg ? { ...msg, password: msg.password ? '(a password)' : '' } : msg);
        queue.push(msg);
        flush();
    };
    const android = ${JSON.stringify(state.platform === 'android')};
    if (android) {
        window.lcAndroid = { postMessage(text) { const m = JSON.parse(text); if (m.ch === 'native') post(m.msg); else if (m.ch === 'reply') app.calls.push(m); } };
        window.LostCityNativeBridge = { native: { postMessage: m => window.lcAndroid.postMessage(JSON.stringify({ ch: 'native', msg: m })) }, log: { postMessage() {} } };
    } else {
        window.webkit = { messageHandlers: { native: { postMessage: post }, log: { postMessage() {} } } };
    }
    const apply = async message => {
        if (message.reload) {
            location.reload();
            return;
        }
        if (android) {
            await window.__lcCall?.(0, message.path, message.args);
            return;
        }
        const parts = message.path.split('.');
        const owner = parts.slice(0, -1).reduce((o, k) => o?.[k], window.LostCityHost);
        await owner?.[parts.at(-1)]?.apply(owner, message.args);
    };
    let chain = Promise.resolve();
    const events = new EventSource('__lc-app/events?page=' + page);
    events.onmessage = event => {
        const message = JSON.parse(event.data);
        app.calls.push(message.path ?? 'reload');
        chain = chain.then(() => apply(message)).catch(err => console.error('[app] ' + err));
    };
    // a desktop keyboard as the native one: typed keys to LostCityHost.keyboard while no input of the page has focus
    // (real keys only: the page's own are synthetic, and go on to the client)
    window.addEventListener('keydown', event => {
        const kb = window.LostCityHost?.keyboard;
        if (!event.isTrusted || !kb || event.metaKey || event.ctrlKey || event.target?.tagName === 'INPUT') return;
        if (event.key.length === 1) kb.insertText(event.key);
        else if (event.key === 'Backspace') kb.deleteBackward();
        else if (event.key === 'Enter') kb.submit();
        else kb.pressKey(event.key, true);
        event.preventDefault();
        event.stopPropagation();
    }, true);
})();`;
    }

    // ---------------------------------------------------------------- routes

    const send = (res, status, body = '', type = 'text/plain') => {
        res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
    };

    async function serveCrc(res) {
        const page = state.page;
        if (!page.crc) {
            const got = await fetchWithin(`${page.server.url}/crc`, 10000);
            const words = got.error ?? (got.status === 404 || (got.status === 200 && !crcTableOk(got.body)) ? 'not a 2004scape server' : got.status !== 200 ? `http ${got.status}` : null);
            note(`/crc from ${new URL(page.server.url).host}: ${words ?? 'ok'}`);
            if (words) {
                return send(res, 502, words);
            }
            page.crc = Buffer.from(got.body);
        }
        return send(res, 200, page.crc, 'application/octet-stream');
    }

    async function serveJag(res, name, crc) {
        const file = `${name}${crc}`;
        const bundled = path.join(root, file);
        if (fs.existsSync(bundled)) {
            return send(res, 200, fs.readFileSync(bundled), 'application/octet-stream');
        }
        const cached = path.join(serverCache(state.page.server.id), file);
        if (fs.existsSync(cached) && crc32(fs.readFileSync(cached)) === Number(crc)) {
            return send(res, 200, fs.readFileSync(cached), 'application/octet-stream');
        }
        const got = await fetchWithin(`${state.page.server.url}/${file}`, 30000);
        const words = got.error ?? (got.status === 404 ? 'not a 2004scape server' : got.status !== 200 ? `http ${got.status}` : crc32(got.body) !== Number(crc) ? 'checksum mismatch' : null);
        note(`/${file} from the server: ${words ?? `${got.body.length} bytes, cached`}`);
        if (words) {
            return send(res, 502, words);
        }
        fs.mkdirSync(path.dirname(cached), { recursive: true });
        const temp = `${cached}.${process.pid}.tmp`;
        fs.writeFileSync(temp, got.body);
        fs.renameSync(temp, cached);
        return send(res, 200, Buffer.from(got.body), 'application/octet-stream');
    }

    async function serveOnDemand(req, res, archive, file) {
        if (!/^[0-3]$/.test(archive) || !/^(0|[1-9]\d{0,4})$/.test(file) || Number(file) > 65535) {
            return send(res, 400, 'bad path');
        }
        const online = state.page?.server ?? null;
        if (!online) {
            return req.method === 'GET' ? send(res, 404) : send(res, 405);
        }
        const target = path.join(serverCache(online.id), 'od', archive, file);
        if (req.method === 'GET' || req.method === 'HEAD') {
            return fs.existsSync(target) ? send(res, 200, fs.readFileSync(target), 'application/octet-stream') : send(res, 404);
        }
        if (req.method !== 'PUT') {
            return send(res, 405);
        }
        const header = headerBody(req);
        if (header?.error) {
            return send(res, header.status, header.error);
        }
        const body = header ? header.data : await new Promise((resolve, reject) => {
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', reject);
        });
        if (body.length > MAX_ONDEMAND) {
            return send(res, 413, 'too large');
        }
        if (body.length === 0) {
            return send(res, 400, 'empty body');
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const temp = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(temp, body);
        fs.renameSync(temp, target);
        note(`/ondemand/${archive}/${file} stored (${body.length} bytes${header ? ', X-LC-Body' : ''})`);
        return send(res, 204);
    }

    // The page's index.html with the document-start script first in <head>; a new page load (the old page's sockets
    // closed, the online choice taken for this load).
    function indexHtml(html) {
        closePageSockets(null, 'the page went away');
        for (const stream of state.streams.values()) {
            stream.res.end();
        }
        state.streams.clear();
        state.pending.clear();
        const id = ++state.pageId;
        state.page = { id, server: chosen(), crc: null };
        note(`page ${id}: ${state.page.server ? `online, ${state.page.server.url}` : 'offline'}`);
        return html.replace('<head>', `<head>\n    <script src="__lc-app/shim.js?page=${id}"></script>`);
    }

    // true when the request was one of the double's (answered), false to leave it to serve.mjs
    async function handle(req, res, url, pathname) {
        if (pathname === '/__lc-app/shim.js') {
            send(res, 200, shim(Number(url.searchParams.get('page')) || state.pageId), 'text/javascript; charset=utf-8');
            return true;
        }
        if (pathname === '/__lc-app/events') {
            const pageId = Number(url.searchParams.get('page'));
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
            res.write(': hello\n\n');
            state.streams.set(pageId, { res });
            req.on('close', () => {
                if (state.streams.get(pageId)?.res === res) {
                    state.streams.delete(pageId);
                }
            });
            for (const message of state.pending.get(pageId) ?? []) {
                res.write(`data: ${JSON.stringify(message)}\n\n`);
            }
            state.pending.delete(pageId);
            return true;
        }
        if (pathname === '/__lc-app/post') {
            const pageId = Number(url.searchParams.get('page'));
            const chunks = [];
            for await (const chunk of req) {
                chunks.push(chunk);
            }
            for (const msg of JSON.parse(Buffer.concat(chunks).toString('utf8') || '[]')) {
                onMessage(pageId, msg);
            }
            send(res, 204);
            return true;
        }
        if (pathname === '/server-probe') {
            const target = url.searchParams.get('url');
            if (target === null) {
                send(res, 400, 'url missing');
                return true;
            }
            const result = await probeServer(target);
            note(`probe ${result.url ?? target}: ${result.ok ? 'ok' : result.error}`);
            send(res, 200, JSON.stringify(result), 'application/json');
            return true;
        }
        const ondemand = /^\/ondemand\/([^/]+)\/([^/]+)$/.exec(pathname);
        if (ondemand) {
            await serveOnDemand(req, res, ondemand[1], ondemand[2]);
            return true;
        }
        if (!state.page?.server || (req.method !== 'GET' && req.method !== 'HEAD')) {
            return false;
        }
        if (pathname.startsWith('/crc')) {
            await serveCrc(res);
            return true;
        }
        const jag = JAG_ROUTE.exec(pathname);
        if (jag) {
            await serveJag(res, jag[1], jag[2]);
            return true;
        }
        return false;
    }

    return {
        state,
        handle,
        indexHtml,
        // a test's "server-side" drop: every open game socket's connection lost (native reports error network, close 1006)
        dropGameSockets() {
            for (const entry of state.sockets.values()) {
                if (entry.purpose === 'game') {
                    entry.socket.drop();
                }
            }
        },
        close() {
            closePageSockets(null, 'the double stops');
            for (const stream of state.streams.values()) {
                stream.res.end();
            }
            state.streams.clear();
        }
    };
}
