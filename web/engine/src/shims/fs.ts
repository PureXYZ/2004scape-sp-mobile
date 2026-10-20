// Node `fs` subset over the in-memory vfs. Covers every fs call on the engine runtime graph:
//   existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync    (loaders, GameMap, WorldConfig)
//   openSync/fstatSync/readSync/writeSync/ftruncateSync/closeSync                (util/RandomAccessFile.ts via io/FileStream.ts)
// Player saves do NOT go through here: the in-process login thread talks to native storage directly (runtime/saves.ts).
import { Buffer, decodeBytes, encodeString, type Encoding } from './buffer.js';
import { errno, getStore, toAbs, vfs } from './vfs.js';

type ReadOpts = Encoding | { encoding?: Encoding | null; flag?: string } | null | undefined;

function encOf(o: ReadOpts): Encoding | null {
    if (!o) return null;
    if (typeof o === 'string') return o;
    return o.encoding ?? null;
}

function toBytes(data: string | Uint8Array | ArrayBufferView, enc?: Encoding | null): Uint8Array {
    if (typeof data === 'string') return encodeString(data, enc ?? 'utf8');
    if (data instanceof Uint8Array) return data;
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

class Stats {
    readonly mode: number;
    constructor(
        private readonly dir: boolean,
        public readonly size: number
    ) {
        this.mode = dir ? 0o40755 : 0o100644;
    }
    mtimeMs = 0;
    mtime = new Date(0);
    ctimeMs = 0;
    ctime = new Date(0);
    isFile() {
        return !this.dir;
    }
    isDirectory() {
        return this.dir;
    }
    isSymbolicLink() {
        return false;
    }
}

class Dirent {
    constructor(
        public readonly name: string,
        private readonly dir: boolean,
        public readonly parentPath: string
    ) {}
    get path() {
        return this.parentPath;
    }
    isFile() {
        return !this.dir;
    }
    isDirectory() {
        return this.dir;
    }
    isSymbolicLink() {
        return false;
    }
}

export function existsSync(p: string | URL): boolean {
    try {
        return vfs.exists(toAbs(p));
    } catch {
        return false;
    }
}

// Deliberate deviation from Node: a binary read returns a zero-copy view of the vfs bytes instead of a fresh copy.
// Every binary reader on the runtime graph only reads the result (Packet.load copies it again, GameMap hands it to
// fflate.unzipSync, which copies each entry), and avoiding the copy keeps 15 MB (map zip) + 6 MB (scripts) of
// garbage out of the start-up peak - which is what decides whether iOS jetsams the WebContent process.
export function readFileSync(p: string | URL | number, opts?: ReadOpts): string | Buffer {
    const data = typeof p === 'number' ? fdData(fdEntry(p, 'read')) : vfs.read(p as string, 'open');
    const enc = encOf(opts);
    return enc ? decodeBytes(data, enc) : new Buffer(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
}

export function writeFileSync(p: string | URL, data: string | Uint8Array | ArrayBufferView, opts?: ReadOpts) {
    const bytes = toBytes(data, encOf(opts));
    vfs.write(p as string, bytes.slice());
}

export function appendFileSync(p: string | URL, data: string | Uint8Array, opts?: ReadOpts) {
    const add = toBytes(data, encOf(opts));
    const abs = toAbs(p);
    const old = vfs.lookup(abs) ?? new Uint8Array();
    const out = new Uint8Array(old.length + add.length);
    out.set(old);
    out.set(add, old.length);
    vfs.write(abs, out);
}

export function mkdirSync(p: string | URL, opts?: { recursive?: boolean } | number) {
    vfs.mkdir(p as string, typeof opts === 'object' && !!opts?.recursive);
    return undefined;
}

export function readdirSync(p: string | URL, opts?: { withFileTypes?: boolean } | string) {
    const abs = toAbs(p);
    const names = vfs.readdir(abs);
    if (typeof opts === 'object' && opts?.withFileTypes) {
        return names.map(n => new Dirent(n, vfs.isDir(abs === '/' ? '/' + n : abs + '/' + n), abs));
    }
    return names;
}

export function statSync(p: string | URL, opts?: { throwIfNoEntry?: boolean }) {
    const abs = toAbs(p);
    if (vfs.isDir(abs)) return new Stats(true, 0);
    const f = vfs.lookup(abs);
    if (f) return new Stats(false, f.length);
    if (opts && opts.throwIfNoEntry === false) return undefined;
    throw errno('ENOENT', 'stat', String(p));
}
export const lstatSync = statSync;

export function unlinkSync(p: string | URL) {
    vfs.unlink(p as string);
}

export function rmSync(p: string | URL, opts?: { force?: boolean; recursive?: boolean }) {
    const abs = toAbs(p);
    const store = getStore();
    if (store.files.has(abs) || store.urls.has(abs)) return vfs.unlink(abs);
    if (store.dirs.has(abs) && opts?.recursive) {
        for (const k of [...store.files.keys(), ...store.urls.keys()]) if (k.startsWith(abs + '/')) store.files.delete(k), store.urls.delete(k);
        for (const d of [...store.dirs]) if (d === abs || d.startsWith(abs + '/')) store.dirs.delete(d);
        return;
    }
    if (!opts?.force) throw errno('ENOENT', 'rm', String(p));
}

export function renameSync(from: string, to: string) {
    const data = vfs.read(from, 'rename');
    vfs.write(to, data);
    vfs.unlink(from);
}

export function copyFileSync(from: string, to: string) {
    vfs.write(to, vfs.read(from, 'copyfile').slice());
}

// ---- file descriptors (util/RandomAccessFile.ts) ----

type Fd = { abs: string; pos: number; writable: boolean };
const fds = new Map<number, Fd>();
let nextFd = 100;

function fdEntry(fd: number, syscall: string): Fd {
    const e = fds.get(fd);
    if (!e) throw errno('EBADF', syscall, String(fd));
    return e;
}

// resolved on every access: the file may have been evicted (it is then fetched again) or replaced
function fdData(e: Fd): Uint8Array {
    return vfs.lookup(e.abs) ?? new Uint8Array(0);
}

export function openSync(p: string | URL, flags: string | number = 'r') {
    const abs = toAbs(p);
    const f = String(flags);
    if (vfs.isDir(abs)) throw errno('EISDIR', 'open', String(p));
    if (!vfs.exists(abs)) {
        if (f.startsWith('r')) throw errno('ENOENT', 'open', String(p));
        vfs.write(abs, new Uint8Array(0));
    } else if (f.startsWith('w')) {
        vfs.write(abs, new Uint8Array(0));
    }
    const fd = nextFd++;
    fds.set(fd, { abs, pos: 0, writable: f !== 'r' });
    return fd;
}

export function closeSync(fd: number) {
    fdEntry(fd, 'close');
    fds.delete(fd);
}

export function fstatSync(fd: number) {
    return new Stats(false, fdData(fdEntry(fd, 'fstat')).length);
}

export function readSync(fd: number, buffer: Uint8Array, offset = 0, length = buffer.length - offset, position: number | bigint | null = null) {
    const e = fdEntry(fd, 'read');
    const data = fdData(e);
    const cursor = position === null || position === undefined || position === -1;
    const pos = cursor ? e.pos : Number(position);
    const n = Math.max(0, Math.min(length, data.length - pos));
    if (n > 0) buffer.set(data.subarray(pos, pos + n), offset);
    if (cursor) e.pos += n;
    return n;
}

export function writeSync(fd: number, buffer: Uint8Array | string, offset = 0, length?: number, position: number | null = null) {
    const e = fdEntry(fd, 'write');
    if (!e.writable) throw errno('EBADF', 'write', e.abs);
    const src = typeof buffer === 'string' ? encodeString(buffer) : buffer.subarray(offset, offset + (length ?? buffer.length - offset));
    const pos = position === null || position === undefined ? e.pos : position;
    const old = fdData(e);
    // copy-on-write: never mutate bytes that may be shared with a reader or backed by a bundled URL
    const data = new Uint8Array(Math.max(old.length, pos + src.length));
    data.set(old);
    data.set(src, pos);
    vfs.write(e.abs, data);
    if (position === null || position === undefined) e.pos = pos + src.length;
    return src.length;
}

export function ftruncateSync(fd: number, len = 0) {
    const e = fdEntry(fd, 'ftruncate');
    const data = fdData(e);
    if (len < data.length) vfs.write(e.abs, data.slice(0, len));
    else if (len > data.length) {
        const grown = new Uint8Array(len);
        grown.set(data);
        vfs.write(e.abs, grown);
    }
}

export function fsyncSync(_fd: number) {}

// ---- not supported in the worker runtime ----

function unsupported(name: string) {
    return () => {
        throw new Error(`fs.${name} is not supported in the engine worker`);
    };
}
export const createReadStream = unsupported('createReadStream');
export const createWriteStream = unsupported('createWriteStream');
export const watch = unsupported('watch');
export const watchFile = unsupported('watchFile');

// ---- promises (not used on the runtime graph; provided so stray imports fail at call time, not load time) ----

export const promises = {
    readFile: async (p: string, o?: ReadOpts) => readFileSync(p, o),
    writeFile: async (p: string, d: string | Uint8Array, o?: ReadOpts) => writeFileSync(p, d, o),
    appendFile: async (p: string, d: string | Uint8Array, o?: ReadOpts) => appendFileSync(p, d, o),
    mkdir: async (p: string, o?: { recursive?: boolean }) => mkdirSync(p, o),
    readdir: async (p: string, o?: { withFileTypes?: boolean }) => readdirSync(p, o),
    stat: async (p: string) => statSync(p),
    lstat: async (p: string) => statSync(p),
    unlink: async (p: string) => unlinkSync(p),
    rm: async (p: string, o?: { force?: boolean; recursive?: boolean }) => rmSync(p, o),
    rename: async (a: string, b: string) => renameSync(a, b),
    copyFile: async (a: string, b: string) => copyFileSync(a, b),
    access: async (p: string) => {
        if (!existsSync(p)) throw errno('ENOENT', 'access', p);
    }
};

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

const fs = {
    existsSync,
    readFileSync,
    writeFileSync,
    appendFileSync,
    mkdirSync,
    readdirSync,
    statSync,
    lstatSync,
    unlinkSync,
    rmSync,
    renameSync,
    copyFileSync,
    openSync,
    closeSync,
    fstatSync,
    readSync,
    writeSync,
    ftruncateSync,
    fsyncSync,
    createReadStream,
    createWriteStream,
    watch,
    watchFile,
    promises,
    constants
};

export default fs;
