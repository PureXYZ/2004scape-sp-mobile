// Build-time view of the engine's packed cache (Server/engine/data/pack/main_file_cache.*): derives the files the
// client downloads over HTTP (/crc and the 8 jag archives) byte-for-byte as the engine would serve them, and
// cross-checks the pack so a stale or inconsistent pack fails the build instead of the login
// ("RuneScape has been updated!") or the loading screen.
import fs from 'node:fs';
import path from 'node:path';

// Archive 0 file i -> URL name (engine src/web.ts:164-250; client Client.ts getJagFile calls).
export const JAG_NAMES = [null, 'title', 'config', 'interface', 'media', 'versionlist', 'textures', 'wordenc', 'sounds'];
export const JAG_FILE_RE = /^(title|config|interface|media|versionlist|textures|wordenc|sounds)-?\d+$/;

export function readPack(packDir) {
    const dat = fs.readFileSync(path.join(packDir, 'main_file_cache.dat'));
    const idx = [0, 1, 2, 3, 4].map(i => fs.readFileSync(path.join(packDir, `main_file_cache.idx${i}`)));
    return { dat, idx };
}

// Port of engine FileStream.read(archive, file) without decompression (Server/engine/src/io/FileStream.ts:73-150).
export function readFile({ dat, idx: idxs }, archive, file) {
    const idx = idxs[archive];
    if (!idx || file < 0 || file >= Math.floor(idx.length / 6)) {
        return null;
    }
    const o = file * 6;
    const size = (idx[o] << 16) | (idx[o + 1] << 8) | idx[o + 2];
    let sector = (idx[o + 3] << 16) | (idx[o + 4] << 8) | idx[o + 5];
    const sectors = Math.floor(dat.length / 520);
    if (size > 2000000 || sector <= 0 || sector > sectors) {
        return null;
    }
    const out = new Uint8Array(size);
    let pos = 0;
    for (let part = 0; pos < size; part++) {
        if (sector === 0) {
            break;
        }
        const s = sector * 520;
        const available = Math.min(512, size - pos);
        if (s + 8 + available > dat.length) {
            return null;
        }
        const sf = (dat[s] << 8) | dat[s + 1];
        const sp = (dat[s + 2] << 8) | dat[s + 3];
        const next = (dat[s + 4] << 16) | (dat[s + 5] << 8) | dat[s + 6];
        const si = dat[s + 7];
        if (sf !== file || sp !== part || si - 1 !== archive || next > sectors) {
            return null;
        }
        out.set(dat.subarray(s + 8, s + 8 + available), pos);
        pos += available;
        sector = next;
    }
    return pos === size ? out : null;
}

const CRC_TABLE = new Int32Array(256);
for (let i = 0; i < 256; i++) {
    let r = i;
    for (let b = 0; b < 8; b++) {
        r = r & 1 ? (r >>> 1) ^ 0xedb88320 : r >>> 1;
    }
    CRC_TABLE[i] = r;
}

// Signed CRC32, identical to Packet.getcrc in both the engine and the client.
export function getcrc(src, offset, length) {
    let crc = 0xffffffff;
    for (let i = offset; i < length; i++) {
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ src[i]) & 0xff];
    }
    return ~crc;
}

function fail(msg) {
    throw new Error(`client cache: ${msg}`);
}

// /crc and the jag archives, as engine CrcTable.makeCrcs() + web.ts serve them.
export function deriveClientFiles(cache, engineDir) {
    const count = Math.floor(cache.idx[0].length / 6);
    if (count !== 9) {
        fail(`archive 0 has ${count} files; rev 274 has exactly 9 (CrcBuffer is 9*4+4 bytes)`);
    }
    const crcs = [];
    const jags = [];
    for (let i = 0; i < count; i++) {
        const jag = cache.idx[0] && readFile(cache, 0, i);
        if (i === 0) {
            crcs.push(jag ? getcrc(jag, 0, jag.length) : 0);
            continue;
        }
        if (!jag) {
            fail(`archive 0 file ${i} (${JAG_NAMES[i]}) cannot be read from the cache (broken sector chain?)`);
        }
        crcs.push(getcrc(jag, 0, jag.length));
        jags.push({ index: i, name: JAG_NAMES[i], file: `${JAG_NAMES[i]}${crcs[i]}`, data: jag });
    }
    // CrcBuffer: 9 signed p4 CRCs + p4(hash), hash = 1234; hash = (hash << 1) + crc (engine CrcTable.ts:13-28).
    const crcBuffer = Buffer.alloc(4 * 9 + 4);
    let hash = 1234;
    for (let i = 0; i < 9; i++) {
        crcBuffer.writeInt32BE(crcs[i], i * 4);
        hash = ((hash << 1) + crcs[i]) | 0;
    }
    crcBuffer.writeInt32BE(hash, 36);

    // The client's own acceptance test (Client.getJagChecksums): the trailer must equal its recomputation.
    let check = 1234;
    for (let i = 0; i < 9; i++) {
        check = ((check << 1) + crcBuffer.readInt32BE(i * 4)) | 0;
    }
    if (check !== crcBuffer.readInt32BE(36)) {
        fail('internal error: /crc trailer does not verify');
    }
    // ...and Client.getJagFile's: every archive's CRC must equal its table entry.
    for (const j of jags) {
        if (getcrc(j.data, 0, j.data.length) !== crcs[j.index]) {
            fail(`internal error: ${j.file} CRC mismatch`);
        }
    }

    // Cross-check against the loose copies the packer writes next to the cache. If they differ the pack is
    // inconsistent (half-updated); the engine would still serve the cache copies, but the server-side data in
    // data/pack/server may no longer match what the client gets.
    const loose = { 1: 'data/pack/client/title', 2: 'data/pack/client/config', 3: 'data/pack/client/interface', 4: 'data/pack/client/media', 5: 'data/pack/client/versionlist', 6: 'data/pack/client/textures', 7: 'data/raw/wordenc', 8: 'data/pack/client/sounds' };
    const crossChecked = [];
    for (const j of jags) {
        const f = path.join(engineDir, loose[j.index]);
        if (!fs.existsSync(f)) {
            continue;
        }
        const other = fs.readFileSync(f);
        if (Buffer.compare(other, Buffer.from(j.data)) !== 0) {
            fail(`${loose[j.index]} differs from cache archive 0 file ${j.index}: the engine pack is inconsistent; rebuild it (npm run build in Server/engine)`);
        }
        crossChecked.push(loose[j.index]);
    }
    const crc32OfTable = getcrc(crcBuffer, 0, 36); // = engine CrcBuffer32, checked against every login packet
    return { crcs, hash, crcBuffer, crc32OfTable, jags, crossChecked };
}

// Minimal JagFile reader (webclient src/io/JagFile.ts) for the versionlist; `bunzip2` comes from the client's own
// src/io/BZip2.js so the build exercises the exact decoder the client runs.
export function readJag(src, bunzip2) {
    const g3 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
    const unpacked = g3(src, 0);
    const packed = g3(src, 3);
    let data = src;
    let pos = 6;
    const whole = unpacked !== packed;
    if (whole) {
        data = bunzip2(src.subarray(6));
        pos = 0;
    }
    const count = (data[pos] << 8) | data[pos + 1];
    pos += 2;
    const entries = new Map();
    let offset = pos + count * 10;
    for (let i = 0; i < count; i++) {
        const hash = (data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3];
        const packedSize = g3(data, pos + 7);
        entries.set(hash, { offset, packedSize });
        offset += packedSize;
        pos += 10;
    }
    const genHash = name => {
        let h = 0;
        for (const c of name.toUpperCase()) {
            h = (h * 61 + c.charCodeAt(0) - 32) | 0;
        }
        return h;
    };
    return {
        read(name) {
            const e = entries.get(genHash(name));
            if (!e) {
                return null;
            }
            const s = data.subarray(e.offset, e.offset + e.packedSize);
            return whole ? s : bunzip2(s);
        }
    };
}

// Every OnDemand file the client may request (version != 0 in the versionlist) must read from the cache and pass
// OnDemandWorker.validate() (2-byte version trailer + CRC32), because LocalOnDemand serves them from this cache.
export function validateOnDemand(cache, versionlist) {
    const names = ['model', 'anim', 'midi', 'map'];
    const res = { ok: 0, zeroVersion: 0, bad: [] };
    for (let a = 0; a < 4; a++) {
        const v = versionlist.read(`${names[a]}_version`);
        const c = versionlist.read(`${names[a]}_crc`);
        if (!v || !c) {
            fail(`versionlist has no ${names[a]}_version/${names[a]}_crc`);
        }
        const n = v.length / 2;
        for (let f = 0; f < n; f++) {
            const ver = (v[f * 2] << 8) | v[f * 2 + 1];
            if (ver === 0) {
                res.zeroVersion++;
                continue;
            }
            const crc = (c[f * 4] << 24) | (c[f * 4 + 1] << 16) | (c[f * 4 + 2] << 8) | c[f * 4 + 3];
            const d = readFile(cache, a + 1, f);
            if (!d || d.length < 2) {
                res.bad.push(`${a}/${f}: missing`);
                continue;
            }
            const trailer = (d[d.length - 2] << 8) | d[d.length - 1];
            if (trailer !== ver || getcrc(d, 0, d.length - 2) !== crc) {
                res.bad.push(`${a}/${f}: version/crc mismatch`);
                continue;
            }
            res.ok++;
        }
    }
    return res;
}
