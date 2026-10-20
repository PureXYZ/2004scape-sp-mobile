// Optional drop-in for 'node-forge' (build flag --forge=lite), covering exactly what the engine runtime uses:
//   World.ts:104   forge.pki.privateKeyFromPem(pem)            (PKCS#8 "PRIVATE KEY" or PKCS#1 "RSA PRIVATE KEY")
//   Packet.ts:11   forge.jsbn.BigInteger                      (new BigInteger(byteArray), modPow, multiply,
//                                                              subtract, mod, add, toByteArray) - rsadec/rsaenc
// Backed by native BigInt. Saves ~580 KB raw / ~200 KB minified versus bundling all of node-forge.

function bytesToBig(bytes: ArrayLike<number>): bigint {
    let x = 0n;
    for (let i = 0; i < bytes.length; i++) x = (x << 8n) | BigInt(bytes[i] & 0xff);
    // Java/jsbn semantics: big-endian two's complement
    if (bytes.length > 0 && bytes[0] & 0x80) x -= 1n << BigInt(bytes.length * 8);
    return x;
}

function mod(a: bigint, m: bigint): bigint {
    const r = a % m;
    return r < 0n ? r + m : r;
}

export class BigInteger {
    readonly v: bigint;

    constructor(src: ArrayLike<number> | bigint | string, radix?: number) {
        if (typeof src === 'bigint') this.v = src;
        else if (typeof src === 'string') this.v = radix === 16 ? BigInt('0x' + src) : BigInt(src);
        else this.v = bytesToBig(src);
    }

    static of(v: bigint) {
        return new BigInteger(v);
    }

    add(o: BigInteger) {
        return BigInteger.of(this.v + o.v);
    }
    subtract(o: BigInteger) {
        return BigInteger.of(this.v - o.v);
    }
    multiply(o: BigInteger) {
        return BigInteger.of(this.v * o.v);
    }
    mod(m: BigInteger) {
        return BigInteger.of(mod(this.v, m.v));
    }
    modPow(e: BigInteger, m: BigInteger) {
        let base = mod(this.v, m.v);
        let exp = e.v;
        let r = 1n % m.v;
        while (exp > 0n) {
            if (exp & 1n) r = (r * base) % m.v;
            base = (base * base) % m.v;
            exp >>= 1n;
        }
        return BigInteger.of(r);
    }
    compareTo(o: BigInteger) {
        return this.v < o.v ? -1 : this.v > o.v ? 1 : 0;
    }
    signum() {
        return this.v < 0n ? -1 : this.v > 0n ? 1 : 0;
    }
    bitLength() {
        return (this.v < 0n ? -this.v : this.v).toString(2).length;
    }
    toString(radix = 10) {
        return this.v.toString(radix);
    }
    // minimal big-endian two's complement (like Java BigInteger.toByteArray / jsbn), unsigned byte values
    toByteArray(): number[] {
        let x = this.v;
        if (x === 0n) return [0];
        const out: number[] = [];
        if (x > 0n) {
            while (x > 0n) {
                out.unshift(Number(x & 0xffn));
                x >>= 8n;
            }
            if (out[0] & 0x80) out.unshift(0);
            return out;
        }
        let n = 1;
        while (-(1n << BigInt(n * 8 - 1)) > x) n++;
        x += 1n << BigInt(n * 8);
        for (let i = 0; i < n; i++) {
            out.unshift(Number(x & 0xffn));
            x >>= 8n;
        }
        return out;
    }
}

// ---- minimal DER / PEM ----

function b64decode(s: string): Uint8Array {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
    const out: number[] = [];
    let buf = 0;
    let bits = 0;
    for (const c of clean) {
        buf = (buf << 6) | A.indexOf(c);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((buf >> bits) & 0xff);
        }
    }
    return Uint8Array.from(out);
}

type Der = { tag: number; start: number; end: number };
function readTlv(d: Uint8Array, pos: number): Der {
    const tag = d[pos++];
    let len = d[pos++];
    if (len & 0x80) {
        const n = len & 0x7f;
        len = 0;
        for (let i = 0; i < n; i++) len = len * 256 + d[pos++];
    }
    return { tag, start: pos, end: pos + len };
}
function children(d: Uint8Array, node: Der): Der[] {
    const out: Der[] = [];
    for (let p = node.start; p < node.end; ) {
        const c = readTlv(d, p);
        out.push(c);
        p = c.end;
    }
    return out;
}

function parseRsaPrivateKey(der: Uint8Array) {
    const top = readTlv(der, 0);
    const seq = children(der, top);
    // PKCS#8: SEQ { INTEGER 0, SEQ { OID, NULL }, OCTET STRING { RSAPrivateKey } }
    if (seq.length === 3 && seq[1].tag === 0x30 && seq[2].tag === 0x04) {
        const inner = der.subarray(seq[2].start, seq[2].end);
        return parseRsaPrivateKey(inner);
    }
    if (top.tag !== 0x30 || seq.length < 9) throw new Error('forge-lite: not an RSA private key');
    const int = (i: number) => new BigInteger(der.subarray(seq[i].start, seq[i].end));
    return { n: int(1), e: int(2), d: int(3), p: int(4), q: int(5), dP: int(6), dQ: int(7), qInv: int(8) };
}

function privateKeyFromPem(pem: string) {
    const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]*?)-----END (RSA )?PRIVATE KEY-----/.exec(pem);
    if (!m) throw new Error('forge-lite: no PEM private key found');
    return parseRsaPrivateKey(b64decode(m[2]));
}

const forge = {
    pki: { privateKeyFromPem, rsa: {} },
    jsbn: { BigInteger }
};

export default forge;
