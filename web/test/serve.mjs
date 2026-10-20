#!/usr/bin/env node
// Desktop stand-in for the app's AssetSchemeHandler: serves build/Game over HTTP with the same routes
// (static files, /save/*, /save-index, /log) so the whole game can be run and tested in a desktop browser.
//
// It also takes writes the way the Android app's router does (docs/ANDROID.md §3.2): WebView's request interception
// never sees a body, so on Android a PUT/POST carries its bytes base64url (no padding) in the X-LC-Body header with
// their count in X-LC-Length, and sends no body. Both kinds are accepted here, so one server serves both apps' pages
// (e2e.mjs --platform android); a header write is logged as such (`log` / `logHeaderBodies`). With `android: true`
// (--android) it is the Android router alone: a write that brings its bytes in a body (which the app could never read)
// is refused 400, so a run proves nothing in the page or the engine still writes that way on Android; /log then takes
// only X-LC-Body or ?text=.
//
//   node web/test/serve.mjs [--port 47500] [--root build/Game] [--saves <dir>] [--android]
//   then open http://127.0.0.1:47500/
//   node web/test/serve.mjs --check [--port 47500]   the save routes against a scratch folder (exit code 0 = pass;
//                                                    the Android-only refusals too)
//
// Also importable: `const server = await serve({ port, root, saves })` → `{ url, close() }`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IOS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.map': 'application/json',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.woff2': 'font/woff2'
};

function resolveInside(root, relative) {
    const file = path.resolve(root, relative);
    return file === root || file.startsWith(root + path.sep) ? file : null;
}

// A save path as SaveStore.swift takes it (`components(of:)`): relative, at most 1024 bytes, no backslash or NUL, and
// every component non-empty, at most 255 bytes and not hidden (no `.`, `..` or dot-names, which are the store's own
// temp files). null: refused (400).
function saveParts(relative) {
    if (!relative || Buffer.byteLength(relative) > 1024 || relative.startsWith('/') || relative.includes('\\') || relative.includes('\0')) {
        return null;
    }
    const parts = relative.split('/');
    return parts.every(part => part !== '' && !part.startsWith('.') && Buffer.byteLength(part) <= 255) ? parts : null;
}

// The largest write the Android router takes (docs/ANDROID.md §3.2: 413 above it); bots.sav is about 1.2 MB at most.
export const MAX_HEADER_BODY = 32 * 1048576;

// A write's bytes from the X-LC-Body / X-LC-Length headers, checked as the Android router checks them: null when the
// request has no X-LC-Body (the bytes are in the body, as on iOS); otherwise { data } or { status, error }. X-LC-Length
// is read first: missing or not a decimal count → 400, above MAX_HEADER_BODY → 413 (nothing decoded). Then X-LC-Body
// must be base64url without padding, and decode to exactly X-LC-Length bytes, else 400.
export function headerBody(req) {
    const encoded = req.headers['x-lc-body'];
    if (encoded === undefined) {
        return null;
    }
    const lengthHeader = req.headers['x-lc-length'];
    if (typeof lengthHeader !== 'string' || !/^\d{1,15}$/.test(lengthHeader)) {
        return { status: 400, error: 'X-LC-Body without a valid X-LC-Length' };
    }
    const length = Number(lengthHeader);
    if (length > MAX_HEADER_BODY) {
        return { status: 413, error: `too large (${length} bytes, at most ${MAX_HEADER_BODY})` };
    }
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]*$/.test(encoded) || encoded.length % 4 === 1) {
        return { status: 400, error: 'X-LC-Body is not base64url without padding' };
    }
    const data = Buffer.from(encoded, 'base64url');
    if (data.length !== length) {
        return { status: 400, error: `X-LC-Length ${length} does not match the ${data.length} bytes of X-LC-Body` };
    }
    return { data };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function listFiles(root) {
    const out = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.name.startsWith('.')) {
                continue; // like SaveStore: hidden files and folders (temp files) are not listed
            }
            if (entry.isDirectory()) {
                walk(p);
            } else {
                const stat = fs.statSync(p);
                out.push({ path: path.relative(root, p).split(path.sep).join('/'), size: stat.size, modified: Math.round(stat.mtimeMs) }); // ms, like SaveStore
            }
        }
    };
    if (fs.existsSync(root)) {
        walk(root);
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
}

// `routes` (tests): { '/path': () => ({ body, type }) } served instead of the file at that path. `onRequest(method,
// path)` (tests): called for every request, with the decoded path. `onWrite({ method, path, via, bytes })` (tests): called
// for every write the save and log routes take, `via` 'X-LC-Body' (Android's header) or 'body'. `logHeaderBodies`: a
// console line for every write that came in X-LC-Body (default: as `log`). `android`: the Android router's view, which
// never sees a body: a save write without X-LC-Body is refused (400), and /log needs X-LC-Body or ?text=.
export async function serve({ port = 47500, root = path.join(IOS, 'build', 'Game'), saves = path.join(IOS, 'build', 'tmp', 'saves'), log = true, logHeaderBodies = log, onLog = null, onRequest = null, onWrite = null, routes = {}, android = false } = {}) {
    root = path.resolve(root);
    saves = path.resolve(saves);
    fs.mkdirSync(saves, { recursive: true });

    // A write's bytes: from X-LC-Body when the request has it (Android), else its body. { data, via } or { status, error }.
    const writeBody = async (req, pathname) => {
        const fromHeader = headerBody(req);
        if (fromHeader?.error) {
            return fromHeader;
        }
        if (!fromHeader && android) {
            // (the Android router reads X-LC-Length first: docs/ANDROID.md §3.2; the body itself never reaches it)
            await readBody(req);
            return { status: 400, error: 'X-LC-Body and X-LC-Length missing (the Android app never sees a request body)' };
        }
        const data = fromHeader ? fromHeader.data : await readBody(req);
        const via = fromHeader ? 'X-LC-Body' : 'body';
        onWrite?.({ method: req.method, path: pathname, via, bytes: data.length });
        if (fromHeader && logHeaderBodies) {
            console.log(`[serve] ${req.method} ${pathname}: ${data.length} bytes in X-LC-Body`);
        }
        return { data, via };
    };

    // (maxHeaderSize: an Android write of bots.sav is a header of about 1.6 MB, Node's default allows 16 KB)
    const server = http.createServer({ maxHeaderSize: 48 * 1048576 }, async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const pathname = decodeURIComponent(url.pathname);
        const send = (status, body = '', type = 'text/plain') => {
            res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
            res.end(req.method === 'HEAD' ? undefined : body);
        };
        try {
            onRequest?.(req.method, pathname);
            if (Object.hasOwn(routes, pathname)) {
                const { body, type = 'application/octet-stream' } = await routes[pathname](req);
                return send(200, body, type);
            }
            if (pathname === '/save-index') {
                if (req.method !== 'GET' && req.method !== 'HEAD') {
                    return send(405, 'method not allowed');
                }
                return send(200, JSON.stringify(listFiles(saves)), 'application/json');
            }
            if (pathname === '/log') {
                if (req.method !== 'POST' && req.method !== 'PUT') {
                    return send(405, 'method not allowed');
                }
                // (Android: the text in X-LC-Body, or in ?text=: docs/ANDROID.md §3.2)
                const query = url.searchParams.get('text');
                const body = query !== null && req.headers['x-lc-body'] === undefined ? { data: Buffer.from(query, 'utf8') } : await writeBody(req, pathname);
                if (body.error) {
                    return send(body.status, body.error);
                }
                const text = body.data.toString('utf8');
                if (onLog) {
                    onLog(text);
                } else if (log) {
                    console.log(`[worker] ${text}`);
                }
                return send(204);
            }
            if (pathname.startsWith('/save/')) {
                const relative = pathname.slice('/save/'.length);
                const parts = saveParts(relative);
                const file = parts ? resolveInside(saves, parts.join(path.sep)) : null;
                if (!file || file === saves) {
                    return send(400, 'bad path');
                }
                if (req.method === 'GET' || req.method === 'HEAD') {
                    return fs.existsSync(file) && fs.statSync(file).isFile() ? send(200, fs.readFileSync(file), 'application/octet-stream') : send(404);
                }
                if (req.method === 'PUT' || req.method === 'POST') {
                    const written = await writeBody(req, pathname);
                    if (written.error) {
                        return send(written.status, written.error);
                    }
                    const body = written.data;
                    // Like SaveStore: an empty body is never a save (it is what WebKit sends for a Blob body on a custom
                    // scheme), and rewriting identical bytes is skipped so the .bak keeps the previous version.
                    if (body.length === 0) {
                        return send(400, 'empty body (send an ArrayBuffer or Uint8Array, not a Blob)');
                    }
                    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
                        return send(400, 'bad path');
                    }
                    if (fs.existsSync(file) && fs.readFileSync(file).equals(body)) {
                        return send(204);
                    }
                    fs.mkdirSync(path.dirname(file), { recursive: true });
                    if (fs.existsSync(file)) {
                        fs.copyFileSync(file, `${file}.bak`);
                    }
                    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`); // hidden, like SaveStore's
                    fs.writeFileSync(temp, body);
                    fs.renameSync(temp, file);
                    if (log) {
                        console.log(`[serve] saved ${relative} (${body.length} bytes${written.via === 'body' ? '' : `, ${written.via}`})`);
                    }
                    return send(204);
                }
                if (req.method === 'DELETE') {
                    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
                        return send(404);
                    }
                    // Like SaveStore: a deleted save is kept as <name>.bak; deleting a .bak removes it.
                    if (file.endsWith('.bak')) {
                        fs.rmSync(file);
                    } else {
                        fs.renameSync(file, `${file}.bak`);
                    }
                    return send(204);
                }
                return send(405);
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                return send(405, 'method not allowed');
            }
            let relative = pathname.replace(/^\/+/, '');
            if (relative === '') {
                relative = 'index.html';
            }
            const file = resolveInside(root, relative);
            if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
                return send(404, 'not found');
            }
            const body = fs.readFileSync(file);
            return send(200, body, MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
        } catch (err) {
            console.error('[serve]', err);
            return send(500, String(err));
        }
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
    const address = `http://127.0.0.1:${server.address().port}/`;
    if (log) {
        console.log(`[serve] ${address} → ${root} (saves: ${saves})`);
    }
    return {
        url: address,
        close: () => new Promise(resolve => server.close(resolve))
    };
}

// --check: the save routes as the engine uses them, on a nested folder that does not exist yet (the bots' store,
// bots/<profile>/bots.sav: docs/BOTS.md §4.5), and the cases native/game-test checks against the Swift handler; then
// the same writes as the Android app's page sends them (X-LC-Body, docs/ANDROID.md §3.2) and its refusals.
async function check(port) {
    const saves = path.join(IOS, 'build', 'tmp', `serve-check-${port}`);
    fs.rmSync(saves, { recursive: true, force: true });
    const writes = [];
    const server = await serve({ port, root: path.join(IOS, 'web', 'host'), saves, log: false, onLog: text => writes.push(`log ${text}`), onWrite: w => writes.push(`${w.method} ${w.path} ${w.via} ${w.bytes}`) });
    let failed = 0;
    const result = (name, ok, detail = '') => {
        failed += ok ? 0 : 1;
        console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    };
    const request = async (method, p, body, headers = {}) => {
        const r = await fetch(new URL(p, server.url), { method, body, headers });
        return { status: r.status, type: r.headers.get('content-type'), data: Buffer.from(await r.arrayBuffer()) };
    };
    // a write as the Android page sends it: no body, the bytes base64url in X-LC-Body, their count in X-LC-Length
    const viaHeader = (method, p, bytes, length = bytes.length, encoded = bytes.toString('base64url')) => request(method, p, undefined, { 'X-LC-Body': encoded, 'X-LC-Length': String(length) });
    const STORE = '/save/bots/main/bots.sav';
    const v1 = Buffer.from('LCBOTS01\0\0', 'latin1'); // an empty store
    const v2 = Buffer.concat([Buffer.from('LCBOTS01\0\x01\x05alice\0\0\0\x02', 'latin1'), Buffer.from([0x20, 0x04])]);
    try {
        result('GET of a store not written yet → 404', (await request('GET', STORE)).status === 404);
        const first = await request('PUT', STORE, v1);
        result('PUT bots/main/bots.sav → 204, creating its folders', first.status === 204 && fs.existsSync(path.join(saves, 'bots', 'main', 'bots.sav')), `status ${first.status}`);
        let r = await request('GET', STORE);
        result('GET returns the bytes as application/octet-stream', r.status === 200 && r.data.equals(v1) && r.type === 'application/octet-stream', `${r.status} ${r.type}`);
        result('no .bak after the first write', (await request('GET', `${STORE}.bak`)).status === 404);
        const second = await request('PUT', STORE, v2);
        r = await request('GET', STORE);
        const bak = await request('GET', `${STORE}.bak`);
        result('a new version → 204, the previous one kept as .bak', second.status === 204 && r.data.equals(v2) && bak.status === 200 && bak.data.equals(v1));
        await request('PUT', STORE, v2);
        result('the same bytes again keep the .bak', (await request('GET', `${STORE}.bak`)).data.equals(v1));
        r = await request('GET', '/save-index');
        const index = JSON.parse(r.data.toString('utf8'));
        const entry = index.find(e => e.path === 'bots/main/bots.sav');
        result(
            '/save-index lists the store (size, ms modified) and its .bak, nothing hidden',
            r.type === 'application/json' && entry?.size === v2.length && Math.abs(Date.now() - entry.modified) < 120000 && index.some(e => e.path === 'bots/main/bots.sav.bak') && !index.some(e => e.path.split('/').some(part => part.startsWith('.'))),
            JSON.stringify(index)
        );
        const refused = [
            ['GET', '/save/', 400], ['GET', '/save/..%2Fescape.sav', 400], ['GET', '/save/a//b.sav', 400], ['GET', '/save/.hidden', 400],
            ['GET', '/save/x%00y', 400], ['GET', '/save/a%5Cb', 400], ['PUT', '/save/players/%2E%2E%2Fx', 400], ['PUT', '/save/bots/main', 400],
            ['PUT', `/save/bots/main/${'x'.repeat(256)}.sav`, 400], ['POST', '/save-index', 405], ['GET', '/log', 405], ['PUT', '/index.html', 405]
        ];
        const statuses = [];
        for (const [method, p, want] of refused) {
            const got = (await request(method, p, method === 'GET' ? undefined : v1)).status;
            statuses.push(`${method} ${p.length > 40 ? `${p.slice(0, 37)}...` : p} ${got}${got === want ? '' : ` (want ${want})`}`);
        }
        result('paths and methods refused like the Swift handler (400 / 405)', statuses.every(s => !s.includes('want')), statuses.join(', '));
        result('an empty body → 400 (what WebKit sends for a Blob)', (await request('PUT', STORE, Buffer.alloc(0))).status === 400);
        const deleted = await request('DELETE', STORE);
        const kept = await request('GET', `${STORE}.bak`);
        result('DELETE → 204, then 404; the deleted store kept as .bak', deleted.status === 204 && (await request('GET', STORE)).status === 404 && kept.data.equals(v2));

        // Android (docs/ANDROID.md §3.2): the bytes in X-LC-Body, no body
        const PLAYER = '/save/players/main/android.sav';
        const p1 = Buffer.from([0x20, 0x04, ...crypto.randomBytes(509)]); // (a length that needs base64 padding: 511 % 3 = 1)
        writes.length = 0;
        let put = await viaHeader('PUT', PLAYER, p1);
        r = await request('GET', PLAYER);
        result('Android: PUT with X-LC-Body + X-LC-Length (no body) → 204, the decoded bytes on disk', put.status === 204 && r.status === 200 && r.data.equals(p1) && writes.join() === `PUT ${PLAYER} X-LC-Body 511`, `status ${put.status}, ${writes.join()}`);
        const big = crypto.randomBytes(1200000); // (bots.sav at 1,000 bots: about 1.2 MB, a 1.6 MB header)
        put = await viaHeader('PUT', STORE, big);
        r = await request('GET', STORE);
        result('Android: a 1.2 MB write in one header → 204, intact', put.status === 204 && r.data.equals(big), `status ${put.status}`);
        const p2 = Buffer.from([0x20, 0x04, 1, 2, 3]);
        await viaHeader('POST', PLAYER, p2);
        r = await request('GET', PLAYER);
        const playerBak = await request('GET', `${PLAYER}.bak`);
        result('Android: POST works as PUT; the previous version kept as .bak', r.data.equals(p2) && playerBak.data.equals(p1));
        const header = [
            ['X-LC-Length one short', viaHeader('PUT', PLAYER, p1, p1.length - 1), 400],
            ['X-LC-Length one long', viaHeader('PUT', PLAYER, p1, p1.length + 1), 400],
            ['X-LC-Length missing', request('PUT', PLAYER, undefined, { 'X-LC-Body': p1.toString('base64url') }), 400],
            ['X-LC-Length not a number', viaHeader('PUT', PLAYER, p1, '12x'), 400],
            ['standard base64 (+ / =)', viaHeader('PUT', PLAYER, Buffer.from([0xfb, 0xff]), 2, '+/8='), 400],
            ['an impossible base64 length', viaHeader('PUT', PLAYER, p1, 1, 'AAAAA'), 400],
            ['above 32 MiB → 413', viaHeader('PUT', PLAYER, p2, MAX_HEADER_BODY + 1), 413],
            ['empty (X-LC-Length 0)', viaHeader('PUT', PLAYER, Buffer.alloc(0)), 400]
        ];
        const got = [];
        for (const [name, pending, want] of header) {
            const status = (await pending).status;
            got.push(`${name} ${status}${status === want ? '' : ` (want ${want})`}`);
        }
        r = await request('GET', PLAYER);
        result('Android: bad X-LC-Body / X-LC-Length refused like the Android router (400, 413), the save untouched', got.every(g => !g.includes('want')) && r.data.equals(p2), got.join(', '));
        writes.length = 0;
        const logged = [await viaHeader('POST', '/log', Buffer.from('from the header')), await request('POST', '/log?text=from%20the%20query'), await request('POST', '/log', 'from the body')];
        result('/log takes its text from X-LC-Body, ?text= or the body → 204', logged.every(l => l.status === 204) && writes.filter(w => w.startsWith('log ')).join('|') === 'log from the header|log from the query|log from the body', writes.join('|'));
    } finally {
        await server.close();
        fs.rmSync(saves, { recursive: true, force: true });
    }

    // the Android router alone (android: true): a write with its bytes in a body is refused, as the app would (it never
    // sees them); the header write works as above
    const androidSaves = `${saves}-android`;
    fs.rmSync(androidSaves, { recursive: true, force: true });
    // (on a port of its own: the client's pooled connections to the first server are gone)
    const androidServer = await serve({ port: 0, root: path.join(IOS, 'web', 'host'), saves: androidSaves, log: false, onLog: () => {}, android: true });
    try {
        const at = p => new URL(p, androidServer.url);
        const bytes = Buffer.from([0x20, 0x04, 9, 8, 7]);
        const viaBody = await fetch(at('/save/players/main/a.sav'), { method: 'PUT', body: bytes });
        const missing = (await fetch(at('/save/players/main/a.sav'))).status;
        const viaHeader = await fetch(at('/save/players/main/a.sav'), { method: 'PUT', headers: { 'X-LC-Body': bytes.toString('base64url'), 'X-LC-Length': String(bytes.length) } });
        const stored = Buffer.from(await (await fetch(at('/save/players/main/a.sav'))).arrayBuffer());
        const logBody = (await fetch(at('/log'), { method: 'POST', body: 'from the body' })).status;
        const logQuery = (await fetch(at('/log?text=q'), { method: 'POST' })).status;
        result('Android router (--android): a PUT with a body and no X-LC-Body → 400, nothing written; X-LC-Body → 204; /log only from X-LC-Body or ?text=', viaBody.status === 400 && missing === 404 && viaHeader.status === 204 && stored.equals(bytes) && logBody === 400 && logQuery === 204, JSON.stringify({ viaBody: viaBody.status, missing, viaHeader: viaHeader.status, logBody, logQuery }));
    } finally {
        await androidServer.close();
        fs.rmSync(androidSaves, { recursive: true, force: true });
    }
    return failed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const argv = process.argv.slice(2);
    const option = (name, fallback) => {
        const i = argv.indexOf(`--${name}`);
        return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
    };
    if (argv.includes('--check')) {
        process.exit((await check(Number(option('port', 47500)))) === 0 ? 0 : 1);
    }
    await serve({ port: Number(option('port', 47500)), root: option('root', undefined), saves: option('saves', undefined), android: argv.includes('--android') });
}
