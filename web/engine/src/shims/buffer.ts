// Minimal Node `Buffer`: a Uint8Array subclass with the few APIs the engine runtime touches
// (RandomAccessFile.ts:22 Buffer.alloc, World.ts:2361 Buffer.from(..).toString('base64'), and fs results).
// build.mjs injects it ONLY into engine sources that use `Buffer` as a value - never as a global - so that
// third-party `typeof Buffer` feature checks keep taking their browser paths.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(u8: Uint8Array): string {
    let out = '';
    let i = 0;
    for (; i + 2 < u8.length; i += 3) {
        const n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
        out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    if (i < u8.length) {
        const n = (u8[i] << 16) | ((i + 1 < u8.length ? u8[i + 1] : 0) << 8);
        out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < u8.length ? B64[(n >> 6) & 63] : '=') + '=';
    }
    return out;
}

function fromBase64(s: string): Uint8Array {
    const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let o = 0;
    for (let i = 0; i < clean.length; i += 4) {
        const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2] ?? 'A') & 63) << 6) | (B64.indexOf(clean[i + 3] ?? 'A') & 63);
        out[o++] = (n >> 16) & 255;
        if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
        if (i + 3 < clean.length) out[o++] = n & 255;
    }
    return out.subarray(0, o);
}

export type Encoding = 'utf8' | 'utf-8' | 'ascii' | 'latin1' | 'binary' | 'base64' | 'hex' | undefined;

export function encodeString(s: string, enc: Encoding = 'utf8'): Uint8Array {
    switch (enc) {
        case 'base64':
            return fromBase64(s);
        case 'hex': {
            const out = new Uint8Array(s.length >> 1);
            for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
            return out;
        }
        case 'ascii':
        case 'latin1':
        case 'binary': {
            const out = new Uint8Array(s.length);
            for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
            return out;
        }
        default:
            return new TextEncoder().encode(s);
    }
}

// one flat string per call (fromCharCode.apply in chunks), not a char-by-char rope
function bytesToString(v: Uint8Array, mask: number): string {
    const CHUNK = 8192;
    let s = '';
    for (let i = 0; i < v.length; i += CHUNK) {
        const part = v.subarray(i, Math.min(v.length, i + CHUNK));
        s += String.fromCharCode.apply(null, mask === 255 ? (part as unknown as number[]) : Array.from(part, b => b & mask));
    }
    return s;
}

export function decodeBytes(u8: Uint8Array, enc: Encoding = 'utf8', start = 0, end = u8.length): string {
    const v = u8.subarray(start, end);
    switch (enc) {
        case 'base64':
            return toBase64(v);
        case 'hex':
            return Array.from(v, b => b.toString(16).padStart(2, '0')).join('');
        case 'ascii':
            return bytesToString(v, 127);
        case 'latin1':
        case 'binary':
            return bytesToString(v, 255);
        default:
            return new TextDecoder().decode(v);
    }
}

// @ts-expect-error the static side differs from Uint8Array's on purpose (Buffer.from has Node's signature)
export class Buffer extends Uint8Array {
    static alloc(size: number, fill?: number): Buffer {
        const b = new Buffer(size);
        if (fill) b.fill(fill);
        return b;
    }

    static allocUnsafe(size: number): Buffer {
        return new Buffer(size);
    }

    // Node's Buffer.from(string, encoding) / (arrayBuffer, offset, length) overloads, not Uint8Array.from's mapfn
    static from(src: ArrayLike<number> | ArrayBuffer | string | Iterable<number>, encOrOffset?: Encoding | number, length?: number): Buffer {
        if (typeof src === 'string') {
            const bytes = encodeString(src, encOrOffset as Encoding);
            const b = new Buffer(bytes.length);
            b.set(bytes);
            return b;
        }
        if (src instanceof ArrayBuffer) {
            const off = (encOrOffset as number) ?? 0;
            return new Buffer(src, off, length ?? src.byteLength - off);
        }
        const arr = ArrayBuffer.isView(src) ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength) : Uint8Array.from(src as ArrayLike<number>);
        const b = new Buffer(arr.length);
        b.set(arr);
        return b;
    }

    static isBuffer(x: unknown): x is Buffer {
        return x instanceof Buffer;
    }

    static byteLength(s: string, enc?: Encoding): number {
        return encodeString(s, enc).length;
    }

    static concat(list: Uint8Array[], total?: number): Buffer {
        const len = total ?? list.reduce((a, b) => a + b.length, 0);
        const out = new Buffer(len);
        let o = 0;
        for (const l of list) {
            out.set(l.subarray(0, Math.min(l.length, len - o)), o);
            o += l.length;
            if (o >= len) break;
        }
        return out;
    }

    // Node's Buffer#toString(encoding, start, end)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    override toString(enc?: any, start?: number, end?: number): string {
        return decodeBytes(this, enc as Encoding, start ?? 0, end ?? this.length);
    }

    equals(other: Uint8Array): boolean {
        if (other.length !== this.length) return false;
        for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
        return true;
    }
}

export default { Buffer };
