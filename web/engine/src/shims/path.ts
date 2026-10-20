// POSIX `path` subset. cwd comes from the vfs store so path.resolve() agrees with fs paths.
// Used on the runtime graph by: util/WorldConfig.ts:72-73 (resolve at module load), :282 (dirname),
// engine/script/ScriptFile.ts:138 (basename), io/Packet.ts:183,192 (dirname - packer only).
import { getStore, normalize as norm } from './vfs.js';

export const sep = '/';
export const delimiter = ':';

export function normalize(p: string): string {
    if (p === '') return '.';
    const trailing = p.endsWith('/') && p.length > 1;
    const n = norm(p);
    return trailing && n !== '/' ? n + '/' : n;
}

export function isAbsolute(p: string): boolean {
    return p.startsWith('/');
}

export function join(...parts: string[]): string {
    const s = parts.filter(x => x !== '').join('/');
    return s === '' ? '.' : normalize(s);
}

export function resolve(...parts: string[]): string {
    let r = '';
    for (let i = parts.length - 1; i >= 0 && !r.startsWith('/'); i--) {
        if (parts[i]) r = parts[i] + (r ? '/' + r : '');
    }
    if (!r.startsWith('/')) r = getStore().cwd + (r ? '/' + r : '');
    return norm(r);
}

export function dirname(p: string): string {
    if (p === '') return '.';
    const s = p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
    const i = s.lastIndexOf('/');
    if (i === -1) return '.';
    if (i === 0) return '/';
    return s.slice(0, i);
}

export function basename(p: string, ext?: string): string {
    const s = p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
    let b = s.slice(s.lastIndexOf('/') + 1);
    if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
    return b;
}

export function extname(p: string): string {
    const b = basename(p);
    const i = b.lastIndexOf('.');
    return i <= 0 ? '' : b.slice(i);
}

export function relative(from: string, to: string): string {
    const a = resolve(from).split('/').filter(Boolean);
    const b = resolve(to).split('/').filter(Boolean);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/');
}

export function parse(p: string) {
    const base = basename(p);
    const ext = extname(p);
    return { root: p.startsWith('/') ? '/' : '', dir: dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base };
}

export function format(o: { dir?: string; root?: string; base?: string; name?: string; ext?: string }): string {
    const base = o.base ?? (o.name ?? '') + (o.ext ?? '');
    const dir = o.dir ?? o.root ?? '';
    return dir ? (dir.endsWith('/') ? dir + base : dir + '/' + base) : base;
}

export function toNamespacedPath(p: string) {
    return p;
}

const path = { sep, delimiter, normalize, isAbsolute, join, resolve, dirname, basename, extname, relative, parse, format, toNamespacedPath } as Record<string, unknown>;
path.posix = path;
export const posix = path;
export default path;
