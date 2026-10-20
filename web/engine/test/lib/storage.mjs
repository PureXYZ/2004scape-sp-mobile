// Node-side stand-in for the app's scheme handler (ARCHITECTURE.md §3): static files from the Game dir plus the
// /save/<relpath> routes over a temp "Documents" folder (atomic write + .bak, like the Swift SaveStore) and
// /save-index. Used by the vm harness (through a fake synchronous XMLHttpRequest) and by the Chrome harness's HTTP server.
import fs from 'node:fs';
import path from 'node:path';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' };

export function mimeOf(p) {
    return MIME[path.extname(p)] ?? 'application/octet-stream';
}

/** /save-index: [{path, size, modified}] of every file under Documents, hidden files excluded (SaveStore.index). */
export function listSaveIndex(root) {
    const out = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(p);
            else out.push({ path: path.relative(root, p).split(path.sep).join('/'), size: fs.statSync(p).size, modified: Math.round(fs.statSync(p).mtimeMs) });
        }
    };
    if (fs.existsSync(root)) walk(root);
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export class FakeNative {
    constructor({ gameDir, documentsDir }) {
        this.gameDir = path.resolve(gameDir);
        this.documentsDir = path.resolve(documentsDir);
        fs.mkdirSync(this.documentsDir, { recursive: true });
        // what the session inspects
        this.storage = {
            puts: [],
            gets: [],
            indexGets: 0,
            deletes: [],
            failPut: false,
            failGet: false,
            failDelete: false,
            read: rel => {
                const f = this.docPath(rel);
                return f && fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null;
            }
        };
        this.staticGets = [];
        this.bodyKinds = new Set();
    }

    docPath(rel) {
        if (!rel || rel.startsWith('/') || rel.split('/').some(s => s === '..' || s === '')) return null;
        return path.join(this.documentsDir, rel);
    }

    /** One request; `pathname` is the URL path (e.g. /save/players/main/x.sav). body: Uint8Array|null. */
    handle(method, pathname, body, bodyKind = 'none') {
        if (pathname === '/save-index' && (method === 'GET' || method === 'HEAD')) {
            this.storage.indexGets++;
            return { status: 200, body: new TextEncoder().encode(JSON.stringify(listSaveIndex(this.documentsDir))), type: 'application/json' };
        }
        if (pathname.startsWith('/save/')) {
            const rel = decodeURIComponent(pathname.slice('/save/'.length));
            const file = this.docPath(rel);
            if (!file) return { status: 400 };
            if (method === 'GET' || method === 'HEAD') {
                // failGet: true, or a predicate on the relpath (e.g. only bots/: the bots' store unreadable)
                if (typeof this.storage.failGet === 'function' ? this.storage.failGet(rel) : this.storage.failGet) {
                    this.storage.gets.push({ rel, status: 500 });
                    return { status: 500 };
                }
                const exists = fs.existsSync(file);
                this.storage.gets.push({ rel, status: exists ? 200 : 404 });
                return exists ? { status: 200, body: new Uint8Array(fs.readFileSync(file)), type: 'application/octet-stream' } : { status: 404 };
            }
            if (method === 'PUT' || method === 'POST') {
                this.bodyKinds.add(bodyKind);
                // failPut: true, or a predicate on the relpath (e.g. only bots/: the bots' store)
                if (typeof this.storage.failPut === 'function' ? this.storage.failPut(rel) : this.storage.failPut) return { status: 500 };
                const bytes = body ?? new Uint8Array(0); // WebKit drops Blob bodies: they arrive empty
                fs.mkdirSync(path.dirname(file), { recursive: true });
                if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
                fs.writeFileSync(file + '.tmp', bytes);
                fs.renameSync(file + '.tmp', file);
                this.storage.puts.push({ rel, bytes: new Uint8Array(bytes), bodyKind });
                return { status: 204 };
            }
            if (method === 'DELETE') {
                // like SaveStore: a deleted file is kept as <file>.bak (replacing the older one); a .bak is removed
                const status = this.storage.failDelete ? 500 : fs.existsSync(file) ? 204 : 404;
                this.storage.deletes.push({ rel, status });
                if (status !== 204) return { status };
                if (file.endsWith('.bak')) fs.rmSync(file);
                else fs.renameSync(file, file + '.bak');
                return { status };
            }
            return { status: 405 };
        }
        if (method !== 'GET' && method !== 'HEAD') return { status: 405 };
        const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname).slice(1);
        const file = path.resolve(this.gameDir, rel);
        if (!file.startsWith(this.gameDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return { status: 404 };
        this.staticGets.push(rel);
        return { status: 200, body: new Uint8Array(fs.readFileSync(file)), type: mimeOf(file) };
    }
}
