// serve.mjs --check, online part: the desktop double of native (native-double.mjs) against stub game servers in this
// process, no engine and no browser: the proxy routes (docs/ONLINE.md, How it works: the /crc check and its words, the CRC rule for the
// jags: bundled, cached, fetched and checked, refused; /ondemand GET and PUT with their refusals; offline as before), the
// probe's JSON, the socket bridge's "no server" for an offline page, and the Node WebSocket client's error words.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';

import { openWebSocket } from './wsclient.mjs';

const crc32 = bytes => zlib.crc32(bytes) | 0;

// A 40-byte /crc table: 9 signed CRCs (index 0 unused) and the client's trailer.
function crcTable(crcs) {
    const table = Buffer.alloc(40);
    let trailer = 1234;
    for (let i = 0; i < 9; i++) {
        table.writeInt32BE(crcs[i] ?? 0, i * 4);
        trailer = ((trailer << 1) + (crcs[i] ?? 0)) | 0;
    }
    table.writeInt32BE(trailer, 36);
    return table;
}

async function listen(handler) {
    const counts = new Map();
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://x').pathname;
        counts.set(pathname, (counts.get(pathname) ?? 0) + 1);
        handler(pathname, req, res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, port: server.address().port, counts, close: () => new Promise(resolve => server.close(resolve)) };
}

// (serve: serve.mjs's, passed in: this module is loaded from serve.mjs's own check, inside its top-level await)
export async function checkNativeDouble({ result, tmp, serve }) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const root = path.join(tmp, 'game');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<!DOCTYPE html>\n<html>\n<head>\n<title>check</title>\n</head>\n<body></body>\n</html>\n');

    // the app's bundle has title; the server has config too, an interface whose bytes are not its CRC, no media
    const title = Buffer.from('a bundled title archive');
    const config = Buffer.from('the server\'s own config archive');
    const crcs = [0, crc32(title), crc32(config), 12345, 67890];
    const table = crcTable(crcs);
    fs.writeFileSync(path.join(root, `title${crcs[1]}`), title);
    const N = '71629005252297980327618167912305272963293132912323242902378492635012082079728940539290656365223631636210007288';
    const game = await listen((pathname, req, res) => {
        const body = pathname === '/crc' ? table : pathname === `/config${crcs[2]}` ? config : pathname === `/interface${crcs[3]}` ? Buffer.from('not the right bytes') : pathname === '/rs2.cgi' ? Buffer.from('<script>new Client(11, 0, false);</script>') : pathname === '/client/client.js' ? Buffer.from(`this.zq.Ka(BigInt('${N}'),BigInt("65537"))`) : null;
        res.writeHead(body ? 200 : 404, { 'Content-Length': body?.length ?? 0 });
        res.end(body ?? undefined);
    });
    const notOurs = await listen((pathname, req, res) => {
        const body = pathname === '/crc' ? Buffer.alloc(20) : null;
        res.writeHead(body ? 200 : 404);
        res.end(body ?? undefined);
    });
    const bare = await listen((pathname, req, res) => {
        res.writeHead(pathname === '/crc' ? 200 : 404);
        res.end(pathname === '/crc' ? table : undefined);
    });
    const closed = await listen(() => {});
    await closed.close(); // (nothing listens on its port now)

    const id = 's-check001';
    const cache = path.join(tmp, 'app-cache');
    const server = await serve({
        port: 0,
        root,
        saves: path.join(tmp, 'saves'),
        log: false,
        onLog: () => {},
        app: { cacheDir: cache, settings: { server: id, servers: [{ id, name: 'Stub', url: game.url, nodeId: 10, members: true, rsa: null, added: 1 }] } }
    });
    const at = p => new URL(p, server.url);
    const get = async (p, init) => {
        const r = await fetch(at(p), init);
        return { status: r.status, cache: r.headers.get('cache-control'), body: Buffer.from(await r.arrayBuffer()) };
    };
    try {
        // a page load online (native decides when index.html is asked for)
        const index = await get('/');
        const shimTag = /<head>\n {4}<script src="__lc-app\/shim\.js\?page=1"><\/script>/.test(index.body.toString());
        const shim = (await get('/__lc-app/shim.js?page=1')).body.toString();
        result('double: index.html gets the document-start script first in <head>; it gives the page LostCityNative (the stored settings, savedPasswords) and webkit.messageHandlers', shimTag && shim.includes('"server":"s-check001"') && shim.includes('savedPasswords') && shim.includes('window.webkit = { messageHandlers'), index.body.toString().slice(0, 120));

        let r = await get('/crc');
        const again = await get('/crc?x=1');
        result('double online: /crc… from the server (10 s, 40 bytes, a good trailer), no-store, kept for the page load (asked once)', r.status === 200 && r.body.equals(table) && r.cache === 'no-store' && again.body.equals(table) && game.counts.get('/crc') === 1, `status ${r.status}, server asked ${game.counts.get('/crc')}`);
        r = await get(`/title${crcs[1]}`);
        result('double online: a jag whose name (CRC) the bundle has: the bundled file, the server not asked', r.status === 200 && r.body.equals(title) && !game.counts.has(`/title${crcs[1]}`));
        r = await get(`/config${crcs[2]}`);
        const cached = path.join(cache, 'online', id, `config${crcs[2]}`);
        const second = await get(`/config${crcs[2]}`);
        result('double online: a jag the bundle lacks: fetched, its CRC32 checked, stored in <cache>/online/<id>/ and served from there next time', r.status === 200 && r.body.equals(config) && fs.existsSync(cached) && fs.readFileSync(cached).equals(config) && second.body.equals(config) && game.counts.get(`/config${crcs[2]}`) === 1, `server asked ${game.counts.get(`/config${crcs[2]}`)}`);
        fs.writeFileSync(cached, 'tampered');
        r = await get(`/config${crcs[2]}`);
        result('double online: a cached jag whose CRC32 is not its name is not served: fetched again', r.status === 200 && r.body.equals(config) && game.counts.get(`/config${crcs[2]}`) === 2 && fs.readFileSync(cached).equals(config));
        r = await get(`/interface${crcs[3]}`);
        const media = await get(`/media${crcs[4]}`);
        result('double online: a jag whose bytes are not its CRC → 502 "checksum mismatch" (not stored); one the server has not → 502 "not a 2004scape server"', r.status === 502 && r.body.toString() === 'checksum mismatch' && !fs.existsSync(path.join(cache, 'online', id, `interface${crcs[3]}`)) && media.status === 502 && media.body.toString() === 'not a 2004scape server', `${r.status} ${r.body} / ${media.status} ${media.body}`);

        // /ondemand
        const od = '/ondemand/1/7';
        const bytes = Buffer.from([1, 2, 3, 4, 0, 2]);
        const before = await get(od);
        const put = await get(od, { method: 'PUT', body: bytes });
        const after = await get(od);
        const headerPut = await get('/ondemand/3/608', { method: 'PUT', headers: { 'X-LC-Body': bytes.toString('base64url'), 'X-LC-Length': String(bytes.length) } });
        const headerGot = await get('/ondemand/3/608');
        result('double online: GET /ondemand/<archive>/<file> 404 until a PUT stores it (204; the body, or X-LC-Body as Android sends it), then 200 with its bytes', before.status === 404 && put.status === 204 && after.status === 200 && after.body.equals(bytes) && headerPut.status === 204 && headerGot.body.equals(bytes) && fs.existsSync(path.join(cache, 'online', id, 'od', '1', '7')));
        const refusals = [];
        for (const [p, init, want] of [
            ['/ondemand/4/1', {}, 400],
            ['/ondemand/0/01', {}, 400],
            ['/ondemand/0/70000', {}, 400],
            ['/ondemand/0/-1', {}, 400],
            ['/ondemand/0/1', { method: 'PUT', body: Buffer.alloc(0) }, 400],
            ['/ondemand/0/1', { method: 'PUT', body: Buffer.alloc(4 * 1048576 + 1) }, 413],
            ['/ondemand/0/1', { method: 'DELETE' }, 405]
        ]) {
            const got = (await get(p, init)).status;
            refusals.push(`${init.method ?? 'GET'} ${p} ${got}${got === want ? '' : ` (want ${want})`}`);
        }
        result('double online: /ondemand refuses another archive or file (400), an empty body (400), more than 4 MiB (413), other methods (405)', refusals.every(s => !s.includes('want')), refusals.join(', '));

        // the probe, in every mode
        const probe = async url => (await get(`/server-probe?url=${encodeURIComponent(url)}`)).body.toString();
        const ready = JSON.parse(await probe(`ws://127.0.0.1:${game.port}/`));
        result('probe: /crc, rs2.cgi\'s new Client(11, 0, false) and the key pair in a minified client.js (single or double quotes) → {ok, crc, nodeId 11, members false, rsa, notes []}', ready.ok === true && ready.crc === true && ready.url === game.url && ready.nodeId === 11 && ready.members === false && ready.rsa?.n === N && ready.rsa?.e === '65537' && ready.notes.length === 0, JSON.stringify(ready));
        const words = {
            notOurs: JSON.parse(await probe(notOurs.url)),
            closed: JSON.parse(await probe(`127.0.0.1:${closed.port}`)),
            invalid: JSON.parse(await probe('ftp://h')),
            missing: (await get('/server-probe')).status
        };
        result('probe: 20 bytes at /crc → "not a 2004scape server"; nothing listening → "unreachable"; ftp:// → "invalid address" (url null); no url → 400; never "official"', words.notOurs.ok === false && words.notOurs.error === 'not a 2004scape server' && words.closed.error === 'unreachable' && words.invalid.error === 'invalid address' && words.invalid.url === null && words.missing === 400, JSON.stringify(words));
        const plain = JSON.parse(await probe(bare.url));
        result('probe: a server with /crc but neither rs2.cgi nor client.js: ok, world 10, members, the built-in key, and both notes in plain words', plain.ok === true && plain.nodeId === 10 && plain.members === true && plain.rsa === null && plain.notes.join(' | ') === 'No world settings found: world 10, members. | No login key found: the built-in key.', JSON.stringify(plain));

        // offline: a page load with the server 'offline' routes as before
        server.app.state.settings = { ...server.app.state.settings, server: 'offline' };
        await get('/');
        const offline = { crc: (await get('/crc')).status, od: (await get(od)).status, put: (await get(od, { method: 'PUT', body: bytes })).status };
        result('double offline: /crc and the jags are the bundle\'s files again (none here: 404), /ondemand GET 404 and PUT 405', offline.crc === 404 && offline.od === 404 && offline.put === 405, JSON.stringify(offline));

        // the bridge: an offline page's socket gets "no server"
        const events = await fetch(at('/__lc-app/events?page=2'));
        const reader = events.body.getReader();
        await fetch(at('/__lc-app/post?page=2'), { method: 'POST', body: JSON.stringify([{ type: 'socket', action: 'open', id: 1, purpose: 'game' }]) });
        let text = '';
        for (const started = Date.now(); !text.includes('socket.events') && Date.now() - started < 3000; ) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            text += Buffer.from(value).toString('utf8');
        }
        await reader.cancel();
        const call = JSON.parse(text.split('\n').find(line => line.startsWith('data: {'))?.slice(6) ?? 'null');
        result('bridge: an offline page\'s socket: one batch, error "no server" then close 1006 "no server"', call?.path === 'socket.events' && JSON.stringify(call.args[0]) === JSON.stringify([{ id: 1, event: 'error', reason: 'no server' }, { id: 1, event: 'close', code: 1006, reason: 'no server' }]), text.slice(0, 200));

        // the Node WebSocket client's words (as native's): refused, and a server that answers the upgrade with a 404
        const wsWords = url => new Promise(resolve => {
            const seen = [];
            openWebSocket(url, { onError: w => seen.push(`error ${w}`), onClose: (code, reason) => resolve([...seen, `close ${code} ${reason}`]) });
        });
        const refused = await wsWords(`ws://127.0.0.1:${closed.port}/`);
        const status = await wsWords(`ws://127.0.0.1:${game.port}/`);
        result('socket client: nothing listening → error "refused", close 1006 "refused"; an HTTP server that does not upgrade → "http 404"', refused.join() === 'error refused,close 1006 refused' && status.join() === 'error http 404,close 1006 http 404', JSON.stringify({ refused, status }));
    } finally {
        await server.close();
        await game.close();
        await notOurs.close();
        await bare.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}
