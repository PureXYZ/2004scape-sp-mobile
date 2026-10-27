// A game server that takes the game's connection and then says nothing, for the online e2e (e2e-online.mjs, group
// silent): its web routes are a real local Engine-TS's (proxied: /crc, the archives, rs2.cgi, client.js), so the page
// loads to the title and the probe finds a 2004Scape server, but a WebSocket upgrade is accepted (101, subprotocol
// binary) and never answered: what an Engine-TS whose login worker is not running, or a proxy whose backend is down,
// looks like to the client. Never an outside server.
//
//   const silent = await silentServer({ port: 47627, upstream: 'http://127.0.0.1:47620' });  // → { url, upgrades, close() }
import crypto from 'node:crypto';
import http from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export async function silentServer({ port, upstream }) {
    const sockets = new Set();
    let upgrades = 0;
    const server = http.createServer(async (req, res) => {
        try {
            const got = await fetch(new URL(req.url, upstream), { method: req.method === 'HEAD' ? 'HEAD' : 'GET', signal: AbortSignal.timeout(30000) });
            const body = Buffer.from(await got.arrayBuffer());
            res.writeHead(got.status, { 'Content-Type': got.headers.get('content-type') ?? 'application/octet-stream', 'Content-Length': body.length });
            res.end(body);
        } catch {
            res.writeHead(502);
            res.end();
        }
    });
    server.on('upgrade', (req, socket) => {
        upgrades++;
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        socket.on('data', () => {}); // (what the client sends is read and dropped: nothing ever comes back)
        const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}${GUID}`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: binary\r\n\r\n`);
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
    return {
        url: `http://127.0.0.1:${port}`,
        get upgrades() {
            return upgrades;
        },
        async close() {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise(resolve => server.close(resolve));
        }
    };
}
