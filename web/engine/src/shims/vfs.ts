// In-memory virtual file system behind the fs/path shims.
//
// boot.js fills globalThis.__LC_VFS__ BEFORE the engine bundle is evaluated, because engine modules read
// files while they evaluate (World.ts:104 private.pem, WorldConfig.ts:295 world.json, OnDemand.ts:42 cache).
//
// Paths are POSIX, absolute and normalised. Relative paths resolve against `cwd` (/engine), so the engine's
// default content dir '../content' is /content.
//
// Every preloaded file remembers the URL it came from (`urls`). That lets the entry evict files after
// World.start() (the map zip alone is 15 MB) and still serve a later read - e.g. the `::reload` cheat - by
// fetching the file again with a synchronous XHR (`loadSync`). Evicted files keep existing for
// existsSync/readdirSync; only their bytes are dropped.

export interface VfsStore {
    cwd: string;
    files: Map<string, Uint8Array>;
    dirs: Set<string>;
    urls: Map<string, string>;
    loadSync: ((abs: string, url: string) => Uint8Array | null) | null;
}

const g = globalThis as unknown as { __LC_VFS__?: VfsStore };

export function getStore(): VfsStore {
    let s = g.__LC_VFS__;
    if (!s) {
        s = g.__LC_VFS__ = { cwd: '/engine', files: new Map(), dirs: new Set(['/']), urls: new Map(), loadSync: null };
    }
    // tolerate stores created by older bootstraps / test harnesses
    if (!s.urls) s.urls = new Map();
    if (s.loadSync === undefined) s.loadSync = null;
    return s;
}

export function normalize(p: string): string {
    const abs = p.startsWith('/');
    const out: string[] = [];
    for (const seg of p.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
            if (out.length && out[out.length - 1] !== '..') out.pop();
            else if (!abs) out.push('..');
            continue;
        }
        out.push(seg);
    }
    const s = (abs ? '/' : '') + out.join('/');
    return s || (abs ? '/' : '.');
}

export function toAbs(p: string | URL): string {
    let s = typeof p === 'string' ? p : p instanceof URL ? decodeURIComponent(p.pathname) : String(p);
    if (s.startsWith('file://')) s = decodeURIComponent(new URL(s).pathname);
    return s.startsWith('/') ? normalize(s) : normalize(getStore().cwd + '/' + s);
}

function addParents(abs: string, store: VfsStore) {
    let d = abs;
    for (;;) {
        const i = d.lastIndexOf('/');
        d = i <= 0 ? '/' : d.slice(0, i);
        if (store.dirs.has(d)) break;
        store.dirs.add(d);
        if (d === '/') break;
    }
}

export function errno(code: string, syscall: string, path: string): Error {
    const msgs: Record<string, string> = {
        ENOENT: 'no such file or directory',
        EISDIR: 'illegal operation on a directory',
        ENOTDIR: 'not a directory',
        EBADF: 'bad file descriptor',
        EEXIST: 'file already exists',
        EIO: 'i/o error'
    };
    const e = new Error(`${code}: ${msgs[code] ?? 'error'}, ${syscall} '${path}'`) as Error & { code: string; syscall: string; path: string; errno: number };
    e.code = code;
    e.syscall = syscall;
    e.path = path;
    e.errno = -2;
    return e;
}

// distinct paths the engine asked for (existence checks and reads); cheap, and lets the tests prove that the
// staged file set is exactly what the engine uses
const accessed = new Set<string>();
let refetches = 0;

export const vfs = {
    get store() {
        return getStore();
    },

    /** Add or replace a file without marking it as engine-written (bootstrap / tests). */
    put(path: string, data: Uint8Array, url?: string) {
        const store = getStore();
        const abs = toAbs(path);
        store.files.set(abs, data);
        if (url) store.urls.set(abs, url);
        addParents(abs, store);
    },

    exists(abs: string): boolean {
        accessed.add(abs);
        const s = getStore();
        return s.files.has(abs) || s.dirs.has(abs) || s.urls.has(abs);
    },

    /** Resident bytes of a file, re-fetching an evicted file synchronously. null = no such file. */
    lookup(abs: string): Uint8Array | null {
        accessed.add(abs);
        const store = getStore();
        const f = store.files.get(abs);
        if (f) return f;
        const url = store.urls.get(abs);
        if (url !== undefined && store.loadSync) {
            const data = store.loadSync(abs, url);
            if (data) {
                refetches++;
                store.files.set(abs, data);
                return data;
            }
            throw errno('EIO', 'read', abs);
        }
        return null;
    },

    isDir(abs: string): boolean {
        return getStore().dirs.has(abs);
    },

    read(path: string, syscall = 'open'): Uint8Array {
        const abs = toAbs(path);
        const f = this.lookup(abs);
        if (f) return f;
        if (getStore().dirs.has(abs)) throw errno('EISDIR', syscall, path);
        throw errno('ENOENT', syscall, path);
    },

    write(path: string, data: Uint8Array) {
        const store = getStore();
        const abs = toAbs(path);
        if (store.dirs.has(abs)) throw errno('EISDIR', 'open', path);
        const parent = abs.slice(0, abs.lastIndexOf('/')) || '/';
        if (!store.dirs.has(parent)) throw errno('ENOENT', 'open', path);
        store.files.set(abs, data);
        // the bytes no longer match the bundled URL: never evict (and never re-fetch) this file
        store.urls.delete(abs);
    },

    mkdir(path: string, recursive: boolean) {
        const store = getStore();
        const abs = toAbs(path);
        if (store.dirs.has(abs)) return;
        if (store.files.has(abs) || store.urls.has(abs)) throw errno('EEXIST', 'mkdir', path);
        const parent = abs.slice(0, abs.lastIndexOf('/')) || '/';
        if (!recursive && !store.dirs.has(parent)) throw errno('ENOENT', 'mkdir', path);
        store.dirs.add(abs);
        addParents(abs, store);
    },

    unlink(path: string) {
        const store = getStore();
        const abs = toAbs(path);
        const had = store.files.delete(abs);
        if (!store.urls.delete(abs) && !had) throw errno('ENOENT', 'unlink', path);
    },

    readdir(path: string): string[] {
        const store = getStore();
        const abs = toAbs(path);
        if (!store.dirs.has(abs)) {
            if (store.files.has(abs) || store.urls.has(abs)) throw errno('ENOTDIR', 'scandir', path);
            throw errno('ENOENT', 'scandir', path);
        }
        const prefix = abs === '/' ? '/' : abs + '/';
        const names = new Set<string>();
        const scan = (k: string) => {
            if (k.startsWith(prefix) && k.length > prefix.length) names.add(k.slice(prefix.length).split('/')[0]);
        };
        for (const k of store.files.keys()) scan(k);
        for (const k of store.urls.keys()) scan(k);
        for (const k of store.dirs) scan(k);
        return [...names].sort();
    },

    /** Drop the bytes of every file that can be fetched again from its URL. Returns {files, bytes} freed. */
    evictReloadable(): { files: number; bytes: number } {
        const store = getStore();
        let files = 0;
        let bytes = 0;
        for (const abs of store.urls.keys()) {
            const f = store.files.get(abs);
            if (f) {
                store.files.delete(abs);
                files++;
                bytes += f.byteLength;
            }
        }
        return { files, bytes };
    },

    stats() {
        const store = getStore();
        let residentBytes = 0;
        for (const f of store.files.values()) residentBytes += f.byteLength;
        return { resident: store.files.size, residentBytes, known: new Set([...store.files.keys(), ...store.urls.keys()]).size, refetches };
    },

    accessedPaths(): string[] {
        return [...accessed].sort();
    }
};

export default vfs;
