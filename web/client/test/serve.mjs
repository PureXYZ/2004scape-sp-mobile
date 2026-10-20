#!/usr/bin/env node
// Static test server for the client harness (127.0.0.1 only, client port range 47400-47449).
// Serves a Game dir like the Swift scheme handler does (ARCHITECTURE.md §3: same MIME types, no-store, 404s),
// plus the stub page at / and two mapped trees so nothing large has to be copied:
//   /cache/main_file_cache.*  -> <engineDir>/data/pack/       (what the engine build copies to Game/cache/)
//   /engine/**                -> <engineBundleDir>            (an engine worker build: build/Game/engine by default)
//   /stub/**                  -> web/client/test/stub/
//   POST /log                 -> appended to the request log
//   GET/PUT/POST/DELETE /save/<relpath>, GET /save-index -> an in-memory stand-in for the native save store
//                                (§3), so an engine build that saves through sync XHR works in the harness
// Every request is recorded (method, path, status) so tests can assert e.g. that no ondemandworker.js was loaded.
//   node web/client/test/serve.mjs --game <dir> [--port 47400] [--engine-bundle <dir>] [--engine <engineDir>]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_ENGINE_DIR } from '../lib/tree.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STUB_DIR = path.join(HERE, 'stub');
// the engine worker of the last web build (scripts/build-web.mjs); --engine-bundle <dir> serves another one
export const DEFAULT_ENGINE_BUNDLE_DIR = path.resolve(HERE, '../../../build/Game/engine');

const MIME = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
    '.css': 'text/css',
    '.png': 'image/png',
    '.map': 'application/json',
    '.ttf': 'font/ttf',
    '.woff2': 'font/woff2'
};

function inside(root, rel) {
    const p = path.resolve(root, `.${path.posix.normalize(`/${rel}`)}`);
    return p === root || p.startsWith(root + path.sep) ? p : null;
}

// index: 'stub' serves the test stub page at /, 'game' serves <gameDir>/index.html (e.g. the real web/host page).
export function startServer({ port = 47400, gameDir, engineDir = DEFAULT_ENGINE_DIR, engineBundleDir = DEFAULT_ENGINE_BUNDLE_DIR, stubDir = STUB_DIR, index = 'stub' } = {}) {
    if (port < 47400 || port > 47449) {
        throw new Error(`port ${port} is outside the client's range 47400-47449`);
    }
    const requests = [];
    const saves = new Map(); // relpath -> { data: Buffer, modified }
    const packDir = path.join(engineDir, 'data', 'pack');
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const p = decodeURIComponent(url.pathname);
        const done = (status, body = null, type = 'application/octet-stream') => {
            requests.push({ t: Date.now(), method: req.method, path: p, status, bytes: body ? body.length : 0 });
            res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...(body ? { 'Content-Length': body.length } : {}) });
            res.end(req.method === 'HEAD' ? undefined : body);
        };
        if (p.startsWith('/save/') || p === '/save-index') {
            const rel = path.posix.normalize(p.slice('/save/'.length));
            if (p === '/save-index') {
                const list = [...saves].map(([k, v]) => ({ path: k, size: v.data.length, modified: v.modified }));
                done(200, Buffer.from(JSON.stringify(list)), 'application/json');
            } else if (!rel || rel.startsWith('..') || rel.startsWith('/')) {
                done(400);
            } else if (req.method === 'GET' || req.method === 'HEAD') {
                const e = saves.get(rel);
                e ? done(200, e.data) : done(404);
            } else if (req.method === 'PUT' || req.method === 'POST') {
                const chunks = [];
                req.on('data', c => chunks.push(c));
                req.on('end', () => {
                    saves.set(rel, { data: Buffer.concat(chunks), modified: Date.now() });
                    done(204);
                });
            } else if (req.method === 'DELETE') {
                done(saves.delete(rel) ? 204 : 404);
            } else {
                done(405);
            }
            return;
        }
        if (req.method === 'POST' && p === '/log') {
            let text = '';
            req.on('data', c => (text += c));
            req.on('end', () => {
                requests.push({ t: Date.now(), method: 'POST', path: '/log', status: 204, text });
                res.writeHead(204).end();
            });
            return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            done(405);
            return;
        }
        let file = null;
        if (p === '/' || p === '/index.html') {
            file = path.join(index === 'game' ? gameDir : stubDir, 'index.html');
        } else if (p.startsWith('/stub/')) {
            file = inside(stubDir, p.slice('/stub/'.length));
        } else if (/^\/cache\/main_file_cache\.(dat|idx[0-4])$/.test(p)) {
            file = path.join(packDir, path.basename(p));
        } else if (p.startsWith('/engine/')) {
            file = inside(engineBundleDir, p.slice('/engine/'.length));
        } else {
            file = inside(gameDir, p.slice(1));
        }
        fs.readFile(file ?? '', (err, body) => {
            if (err || !file) {
                done(404);
                return;
            }
            done(200, body, MIME[path.extname(file)] ?? 'application/octet-stream');
        });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve({ server, requests, saves, url: `http://127.0.0.1:${port}`, close: () => new Promise(r => server.close(r)) }));
    });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const argv = process.argv.slice(2);
    const get = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
    const gameDir = get('--game');
    if (!gameDir) {
        console.error('usage: node web/client/test/serve.mjs --game <dir> [--port 47400] [--engine-bundle <dir>] [--engine <engineDir>]');
        process.exit(2);
    }
    const s = await startServer({ port: Number(get('--port', 47400)), gameDir: path.resolve(gameDir), engineDir: path.resolve(get('--engine', DEFAULT_ENGINE_DIR)), engineBundleDir: path.resolve(get('--engine-bundle', DEFAULT_ENGINE_BUNDLE_DIR)) });
    console.log(`serving ${gameDir} at ${s.url}/ (Ctrl-C to stop)`);
}
