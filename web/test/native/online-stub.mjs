// A stand-in game server for the native online tests (drive.mjs --online): the HTTP files a server serves (/crc, the
// archives, /rs2.cgi, /client/client.js) with the cases the proxy has to handle, and a WebSocket endpoint that echoes
// binary messages and obeys a few commands, so the page can check the app's socket bridge end to end. Plain Node (no
// packages): the handshake and the frames are written here (RFC 6455, server side).
//
// HTTP (any path may start with one of the prefixes below; without one it is the normal world):
//   /crc                 the stub's table: title = the test bundle's own title410306098 (served from the bundle), config
//                        and interface = files served here, media = a file whose bytes do not have its CRC, textures =
//                        404, wordenc = 500, sounds = served after 2 s
//   /rs2.cgi             new Client(7, 0, false)
//   /client/client.js    rsaenc(BigInt('<n>'), BigInt('65537')) (single quotes)
//   /slow/…              everything after 12 s       /norsa/…  /crc only (no rs2.cgi, no client.js)
//   /short/crc           39 bytes                    /badtrailer/crc  40 bytes, wrong trailer
//   /http500/crc         500
// WebSocket (an upgrade on any path): /refuse/… answers 403, as does the next upgrade after a `refuse-next` command.
// A binary message that starts with 0xFF is a command (ASCII after it): `headers` (this connection's upgrade request as
// JSON), `log` (the HTTP requests and every connection's state as JSON), `burst <n>` (n 4-byte messages [0xB0, i >> 8,
// i, 0] in one write), `then-close` (3 messages, then close 4000 "bye", in one write), `text` (a text frame), `close
// <code> <reason>`, `drop` (the TCP connection destroyed), `refuse-next`. Any other binary message is echoed.
import crypto from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';

const crc32 = (buffer) => zlib.crc32(buffer) | 0;

/** The client's /crc: 9 big-endian CRCs (index 0 unused) and the trailer (1234, then (c << 1) + crc[i]). */
export function crcTable(crcs) {
    const out = Buffer.alloc(40);
    let check = 1234;
    for (let i = 0; i < 9; i++) {
        out.writeInt32BE(crcs[i] | 0, i * 4);
        check = ((check << 1) + (crcs[i] | 0)) | 0;
    }
    out.writeInt32BE(check, 36);
    return out;
}

export const STUB_KEY = { n: '9'.repeat(40) + '1234567', e: '65537' };

export async function startOnlineStub({ port = 47631, host = '127.0.0.1', titleCrc = 410306098 } = {}) {
    const files = {
        config: Buffer.from('config archive served by the online stub '.repeat(20)),
        interface: Buffer.from('interface archive served by the online stub '.repeat(10)),
        media: Buffer.from('media bytes that do not match their name'),
        sounds: Buffer.from('sounds archive served after a delay'),
    };
    const crcs = {
        title: titleCrc,
        config: crc32(files.config),
        interface: crc32(files.interface),
        media: crc32(Buffer.from('what the name promises')),
        versionlist: 123456789,
        textures: 222222222,
        wordenc: 333333333,
        sounds: crc32(files.sounds),
    };
    const order = ['title', 'config', 'interface', 'media', 'versionlist', 'textures', 'wordenc', 'sounds'];
    const table = crcTable([0, ...order.map((name) => crcs[name])]);
    const requests = [];
    const connections = [];
    let refuseNext = false;

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://stub');
        requests.push({ method: req.method, path: url.pathname, ua: req.headers['user-agent'] ?? null, origin: req.headers.origin ?? null, cookie: req.headers.cookie ?? null });
        let path = url.pathname;
        const prefix = path.match(/^\/(slow|norsa|short|badtrailer|http500)(?=\/)/)?.[1] ?? '';
        if (prefix) path = path.slice(prefix.length + 1);
        const send = (status, body, type = 'application/octet-stream') => {
            res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
            res.end(body);
        };
        if (prefix === 'slow') await new Promise((r) => setTimeout(r, 12000));
        if (path === '/crc') {
            if (prefix === 'short') return send(200, table.subarray(0, 39));
            if (prefix === 'badtrailer') {
                const bad = Buffer.from(table);
                bad.writeInt32BE(bad.readInt32BE(36) + 1, 36);
                return send(200, bad);
            }
            if (prefix === 'http500') return send(500, 'oops', 'text/plain');
            return send(200, table);
        }
        if (prefix !== 'norsa') {
            if (path === '/rs2.cgi') return send(200, '<html><script>\n  const client = new Client(7, 0, false);\n</script></html>', 'text/html');
            if (path === '/client/client.js') return send(200, `var a=1;function login(){this.out.rsaenc(BigInt('${STUB_KEY.n}'), BigInt('${STUB_KEY.e}'));}`, 'text/javascript');
        }
        const archive = path.match(/^\/([a-z]+)(-?\d+)$/);
        if (archive && archive[1] in crcs && Number(archive[2]) === crcs[archive[1]]) {
            const name = archive[1];
            if (name === 'textures') return send(404, 'not found', 'text/plain');
            if (name === 'wordenc') return send(500, 'oops', 'text/plain');
            if (name === 'sounds') await new Promise((r) => setTimeout(r, 2000));
            if (files[name]) return send(200, files[name]);
        }
        send(404, 'not found', 'text/plain');
    });

    server.on('upgrade', (req, socket) => {
        const url = new URL(req.url, 'http://stub');
        const connection = { id: connections.length + 1, path: url.pathname, headers: { ...req.headers }, open: false, closeCode: null, ended: false, received: 0 };
        connections.push(connection);
        if (url.pathname.startsWith('/refuse') || refuseNext) {
            refuseNext = false;
            connection.refused = true;
            socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
            return;
        }
        const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        const protocol = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim()).find(Boolean);
        socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`,
            ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []), '', ''].join('\r\n'));
        connection.open = true;
        let buffer = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
                const frame = readFrame(buffer);
                if (!frame) break;
                buffer = buffer.subarray(frame.length);
                onFrame(frame);
            }
        });
        socket.on('close', () => { connection.ended = true; });
        socket.on('error', () => {});
        const write = (...frames) => { if (!socket.destroyed) socket.write(Buffer.concat(frames)); };
        function onFrame({ opcode, payload }) {
            if (opcode === 0x8) {
                connection.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
                write(frameOf(0x8, payload.subarray(0, 2)));
                socket.end();
                return;
            }
            if (opcode === 0x9) return write(frameOf(0xA, payload));
            if (opcode !== 0x2) return;
            connection.received++;
            if (payload[0] !== 0xff) return write(frameOf(0x2, payload));
            const [command, ...args] = payload.subarray(1).toString('latin1').split(' ');
            if (command === 'headers') write(frameOf(0x2, Buffer.from(JSON.stringify(connection.headers))));
            else if (command === 'log') write(frameOf(0x2, Buffer.from(JSON.stringify({ requests, connections }))));
            else if (command === 'burst') write(...Array.from({ length: Number(args[0]) }, (_, i) => frameOf(0x2, Buffer.from([0xb0, i >> 8, i & 255, 0]))));
            else if (command === 'then-close') write(frameOf(0x2, Buffer.from([1])), frameOf(0x2, Buffer.from([2])), frameOf(0x2, Buffer.from([3])), closeFrame(4000, 'bye'));
            else if (command === 'text') write(frameOf(0x1, Buffer.from('hello')));
            else if (command === 'close') write(closeFrame(Number(args[0]), args.slice(1).join(' ')));
            else if (command === 'drop') socket.destroy();
            else if (command === 'refuse-next') { refuseNext = true; write(frameOf(0x2, Buffer.from('ok'))); }
        }
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
    });
    return {
        url: `http://${host}:${port}`,
        crcs, files, table, requests, connections,
        close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
    };
}

/** One frame from the start of `buffer` ({opcode, payload, length}), or null until it is all there. */
function readFrame(buffer) {
    if (buffer.length < 2) return null;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
        if (buffer.length < 4) return null;
        length = buffer.readUInt16BE(2);
        offset = 4;
    } else if (length === 127) {
        if (buffer.length < 10) return null;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
    }
    const mask = masked ? buffer.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (buffer.length < offset + length) return null;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    return { opcode, payload, length: offset + length };
}

function frameOf(opcode, payload) {
    const head = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length])
        : payload.length < 65536 ? Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 255])
            : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(payload.length)); return b; })()]);
    return Buffer.concat([head, payload]);
}

function closeFrame(code, reason) {
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    return frameOf(0x8, payload);
}
