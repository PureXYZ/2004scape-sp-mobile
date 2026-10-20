// Rev-274 client protocol pieces for the test bot. Pure JavaScript (no Node APIs): the same code runs in the Node
// vm harness, inside the JavaScriptCore shell and in a Chrome page.
//   Isaac         - port of engine/src/io/Isaac.ts (and the client's)
//   rsaEncrypt    - webclient Packet.rsaenc (bigIntModPow + bigIntToBytes, util/JsUtil.ts)
//   Writer        - the few Packet.p* methods the login needs

export class Isaac {
    constructor(seed) {
        this.count = 0;
        this.rsl = new Int32Array(256);
        this.mem = new Int32Array(256);
        this.a = 0;
        this.b = 0;
        this.c = 0;
        for (let i = 0; i < seed.length; i++) this.rsl[i] = seed[i];
        this.init();
    }

    init() {
        let a = 0x9e3779b9, b = 0x9e3779b9, c = 0x9e3779b9, d = 0x9e3779b9, e = 0x9e3779b9, f = 0x9e3779b9, g = 0x9e3779b9, h = 0x9e3779b9;
        const mix = () => {
            a ^= b << 11; d += a; b += c;
            b ^= c >>> 2; e += b; c += d;
            c ^= d << 8; f += c; d += e;
            d ^= e >>> 16; g += d; e += f;
            e ^= f << 10; h += e; f += g;
            f ^= g >>> 4; a += f; g += h;
            g ^= h << 8; b += g; h += a;
            h ^= a >>> 9; c += h; a += b;
        };
        for (let i = 0; i < 4; i++) mix();
        for (const src of [this.rsl, this.mem]) {
            for (let i = 0; i < 256; i += 8) {
                a += src[i]; b += src[i + 1]; c += src[i + 2]; d += src[i + 3];
                e += src[i + 4]; f += src[i + 5]; g += src[i + 6]; h += src[i + 7];
                mix();
                this.mem[i] = a; this.mem[i + 1] = b; this.mem[i + 2] = c; this.mem[i + 3] = d;
                this.mem[i + 4] = e; this.mem[i + 5] = f; this.mem[i + 6] = g; this.mem[i + 7] = h;
            }
        }
        this.isaac();
        this.count = 256;
    }

    isaac() {
        this.c++;
        this.b += this.c;
        for (let i = 0; i < 256; i++) {
            const x = this.mem[i];
            switch (i & 3) {
                case 0: this.a ^= this.a << 13; break;
                case 1: this.a ^= this.a >>> 6; break;
                case 2: this.a ^= this.a << 2; break;
                case 3: this.a ^= this.a >>> 16; break;
            }
            this.a += this.mem[(i + 128) & 0xff];
            let y;
            this.mem[i] = y = this.mem[(x >>> 2) & 0xff] + this.a + this.b;
            this.rsl[i] = this.b = this.mem[((y >>> 8) >>> 2) & 0xff] + x;
        }
    }

    nextInt() {
        if (this.count-- === 0) {
            this.isaac();
            this.count = 255;
        }
        return this.rsl[this.count];
    }
}

function modPow(base, exponent, modulus) {
    let result = 1n;
    while (exponent > 0n) {
        if (exponent % 2n === 1n) result = (result * base) % modulus;
        base = (base * base) % modulus;
        exponent >>= 1n;
    }
    return result;
}

export function rsaEncrypt(bytes, n, e) {
    let x = 0n;
    for (const b of bytes) x = (x << 8n) | BigInt(b);
    let y = modPow(x, e, n);
    const out = [];
    while (y > 0n) {
        out.unshift(Number(y & 0xffn));
        y >>= 8n;
    }
    if (out[0] & 0x80) out.unshift(0);
    return Uint8Array.from(out);
}

export class Writer {
    constructor() {
        this.b = [];
    }
    p1(v) {
        this.b.push(v & 0xff);
        return this;
    }
    p2(v) {
        return this.p1(v >> 8).p1(v);
    }
    p4(v) {
        return this.p1(v >> 24).p1(v >> 16).p1(v >> 8).p1(v);
    }
    pjstr(s) {
        for (let i = 0; i < s.length; i++) this.p1(s.charCodeAt(i));
        return this.p1(10);
    }
    pdata(bytes) {
        for (const x of bytes) this.p1(x);
        return this;
    }
    get length() {
        return this.b.length;
    }
    bytes() {
        return Uint8Array.from(this.b);
    }
}

export function toUserhash(username) {
    username = username.toLowerCase().trim();
    let hash = 0n;
    for (let i = 0; i < username.length && i < 12; i++) {
        const c = username.charCodeAt(i);
        hash *= 37n;
        if (c >= 97 && c <= 122) hash += BigInt(1 + c - 97);
        else if (c >= 48 && c <= 57) hash += BigInt(27 + c - 48);
    }
    return hash;
}

/** Parse a v7 player save (Player.ts:189-274) far enough for the tests. */
export function parseSave(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const g2 = o => (u8[o] << 8) | u8[o + 1];
    const g4 = o => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) | 0;
    const stats = [];
    for (let i = 0; i < 21; i++) stats.push({ xp: g4(28 + i * 5), level: u8[32 + i * 5] });
    // CRC32 (Packet.getcrc) over everything before the trailing 4 bytes
    let crc = -1;
    for (let i = 0; i < u8.length - 4; i++) {
        crc ^= u8[i];
        for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return { magic: g2(0), version: g2(2), x: g2(4), z: g2(6), level: u8[8], playtime: g4(24), stats, crcOk: (~crc | 0) === g4(u8.length - 4), length: u8.length };
}

export function equalBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

export function hex(u8, max = 32) {
    return Array.from(u8.subarray(0, max), b => b.toString(16).padStart(2, '0')).join('') + (u8.length > max ? '…' : '');
}

// WordPack.pack (engine/src/wordenc/WordPack.ts, the client's too): chat text as 4-bit nibbles, rarer characters as
// two nibbles (index + 195). The engine unpacks it to sentence case.
const WORDPACK = [' ', 'e', 't', 'a', 'o', 'i', 'h', 'n', 's', 'r', 'd', 'l', 'u', 'm', 'w', 'c', 'y', 'f', 'g', 'p', 'b', 'v', 'k', 'x', 'j', 'q', 'z', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ' ', '!', '?', '.', ',', ':', ';', '(', ')', '-', '&', '*', '\\', "'", '@', '#', '+', '=', '£', '$', '%', '"', '[', ']'];

export function wordPack(text) {
    const out = [];
    let carry = -1;
    for (const ch of text.slice(0, 80).toLowerCase()) {
        let index = Math.max(0, WORDPACK.indexOf(ch));
        if (index > 12) index += 195;
        if (carry === -1) {
            if (index < 13) carry = index;
            else out.push(index & 0xff);
        } else if (index < 13) {
            out.push(((carry << 4) + index) & 0xff);
            carry = -1;
        } else {
            out.push(((carry << 4) + (index >> 4)) & 0xff);
            carry = index & 0xf;
        }
    }
    if (carry !== -1) out.push((carry << 4) & 0xff);
    return out;
}

/** p8 of a username's base37 (toUserhash), as the client sends it in MESSAGE_PRIVATE / FRIENDLIST_ADD. */
export function name37Bytes(username) {
    let h = toUserhash(username);
    const out = new Array(8);
    for (let i = 7; i >= 0; i--) {
        out[i] = Number(h & 0xffn);
        h >>= 8n;
    }
    return out;
}
