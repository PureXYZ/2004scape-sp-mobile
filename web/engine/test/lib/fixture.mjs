// Node-side test fixture: protocol tables and constants the bot needs, derived from the read-only inputs so the
// tests follow the sources instead of hard-coding them. JSON-serialisable (the JSC and Chrome harnesses load it).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { UPSTREAM_DIR } from '../../../../scripts/lib/upstream.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const IOS = path.resolve(HERE, '../../../..');
/** The upstream checkouts (scripts/lib/upstream.mjs). */
export const SERVER = UPSTREAM_DIR;

function prots(file, classNames) {
    const src = fs.readFileSync(file, 'utf8');
    const re = new RegExp(`static readonly (\\w+) = new (?:${classNames.join('|')})\\((\\d+), (-?\\d+)\\)`, 'g');
    return [...src.matchAll(re)].map(m => ({ name: m[1], id: +m[2], length: +m[3] }));
}

// FileStream.read (engine/src/io/FileStream.ts) for archive 0
function readCacheFile(dat, idx, archive, file) {
    const o = file * 6;
    if (o + 6 > idx.length) return null;
    const size = (idx[o] << 16) | (idx[o + 1] << 8) | idx[o + 2];
    let sector = (idx[o + 3] << 16) | (idx[o + 4] << 8) | idx[o + 5];
    if (size > 2000000 || sector <= 0 || sector > dat.length / 520) return null;
    const out = Buffer.alloc(size);
    let pos = 0;
    for (let part = 0; pos < size; part++) {
        if (sector === 0) break;
        const base = sector * 520;
        const avail = Math.min(512, size - pos);
        if (dat.readUInt16BE(base) !== file || dat.readUInt16BE(base + 2) !== part || dat[base + 7] !== archive + 1) return null;
        dat.copy(out, pos, base + 8, base + 8 + avail);
        pos += avail;
        sector = (dat[base + 4] << 16) | (dat[base + 5] << 8) | dat[base + 6];
    }
    return out;
}

export function makeFixture({ engineDir = path.join(SERVER, 'engine'), contentDir = path.join(SERVER, 'content'), webclientDir = path.join(SERVER, 'webclient') } = {}) {
    const net = path.join(engineDir, 'src/network/game');
    const serverProt = {};
    for (const p of [...prots(path.join(net, 'server/ServerGameProt.ts'), ['ServerGameProt']), ...prots(path.join(net, 'server/ServerGameZoneProt.ts'), ['ServerGameZoneProt'])]) {
        serverProt[p.id] = { name: p.name, length: p.length };
    }
    const clientProt = {};
    for (const p of prots(path.join(net, 'client/ClientGameProt.ts'), ['ClientGameProt'])) clientProt[p.name] = { id: p.id, length: p.length };

    const iface = fs.readFileSync(path.join(contentDir, 'pack/interface.pack'), 'utf8');
    const logoutComponent = +/^(\d+)=logout:try_logout$/m.exec(iface)[1];

    // the client's built-in key (webclient/bundle.ts LOGIN_RSAN/LOGIN_RSAE) - must be private.pem's public half
    const bundle = fs.readFileSync(path.join(webclientDir, 'bundle.ts'), 'utf8');
    const e = /LOGIN_RSAE \?\? '(\d+)'/.exec(bundle)[1];
    const n = /LOGIN_RSAN \?\? '(\d+)'/.exec(bundle)[1];
    const jwk = crypto.createPrivateKey(fs.readFileSync(path.join(engineDir, 'data/config/private.pem'))).export({ format: 'jwk' });
    const big = b64 => BigInt('0x' + Buffer.from(b64, 'base64url').toString('hex')).toString();
    if (big(jwk.n) !== n || big(jwk.e) !== e) throw new Error('webclient default RSA key does not match engine data/config/private.pem');

    // the 9 archive CRCs the client sends at login (its /crc); World checks their CRC32 against CrcBuffer32
    const pack = path.join(engineDir, 'data/pack');
    const dat = fs.readFileSync(path.join(pack, 'main_file_cache.dat'));
    const idx0 = fs.readFileSync(path.join(pack, 'main_file_cache.idx0'));
    const archiveCrcs = [];
    for (let i = 0; i < 9; i++) {
        const f = readCacheFile(dat, idx0, 0, i);
        archiveCrcs.push(f ? zlib.crc32(f) | 0 : 0);
    }

    return { serverProt, clientProt, logoutComponent, rsa: { n, e }, archiveCrcs };
}

/** The game data the engine build stages, as staged (for differential tests and harnesses). */
export function engineDirs() {
    return { engineDir: path.join(SERVER, 'engine'), contentDir: path.join(SERVER, 'content'), webclientDir: path.join(SERVER, 'webclient') };
}
