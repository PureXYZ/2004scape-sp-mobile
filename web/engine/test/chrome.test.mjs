#!/usr/bin/env node
// Test (c), optional: the engine as a REAL module Web Worker in headless Google Chrome. A static server on
// 127.0.0.1:47310 (--port: another one; Chrome's debugging port is the next) serves the Game dir with the scheme
// handler's routes (GET files with the right MIME types, GET/PUT /save/...); the page (test/chrome/page.js) runs the
// session.
// Exercises what the other harnesses emulate: module worker + top-level await, worker fetch() of the vfs,
// WebAssembly from a fetched .wasm, synchronous XHR from the worker with an ArrayBuffer PUT body, transfers.
//
//   node web/engine/test/chrome.test.mjs [--no-build] [--debug] [--port 47310]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEngine } from '../build.mjs';
import { makeFixture, IOS } from './lib/fixture.mjs';
import { FakeNative, mimeOf } from './lib/storage.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const HTTP_PORT = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 47310;
const CDP_PORT = HTTP_PORT + 1;
if (!Number.isInteger(HTTP_PORT) || HTTP_PORT <= 0 || HTTP_PORT >= 65535) {
    console.error('--port takes a TCP port (Chrome gets the next one)');
    process.exit(2);
}
const DEBUG = args.includes('--debug');
const TMP = path.join(IOS, 'build/tmp/engine');
const OUT = path.join(TMP, DEBUG ? 'out-debug' : 'out-release');

if (!args.includes('--no-build')) await buildEngine({ out: OUT, debug: DEBUG, bots: false }); // the vanilla engine.js (bots: test/bots.test.mjs)
fs.mkdirSync(TMP, { recursive: true });
const run = fs.mkdtempSync(path.join(TMP, 'chrome-'));
const native = new FakeNative({ gameDir: OUT, documentsDir: path.join(run, 'Documents') });
const fixture = JSON.stringify(makeFixture());
const b64 = u8 => Buffer.from(u8).toString('base64');

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
        const body = chunks.length ? new Uint8Array(Buffer.concat(chunks)) : null;
        const send = (status, data, type = 'application/octet-stream') => {
            res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
            res.end(data ?? undefined);
        };
        const p = url.pathname;
        if (p === '/') return send(200, '<!doctype html><meta charset="utf-8"><title>engine worker test</title><script type="module" src="/test/chrome/page.js"></script>', 'text/html');
        if (p === '/fixture.json') return send(200, fixture, 'application/json');
        if (p.startsWith('/test/')) {
            const f = path.resolve(HERE, '.' + p.slice('/test'.length));
            if (!f.startsWith(HERE) || !fs.existsSync(f)) return send(404);
            return send(200, fs.readFileSync(f), mimeOf(f));
        }
        if (p === '/__test/storage') {
            if (req.method === 'POST') Object.assign(native.storage, JSON.parse(Buffer.from(body).toString()));
            const s = native.storage;
            return send(200, JSON.stringify({ puts: s.puts.map(x => ({ rel: x.rel, bodyKind: x.bodyKind, bytes: b64(x.bytes) })), gets: s.gets, deletes: s.deletes }), 'application/json');
        }
        if (p.startsWith('/__test/read/')) {
            const data = native.storage.read(decodeURIComponent(p.slice('/__test/read/'.length)));
            return data ? send(200, b64(data), 'text/plain') : send(404);
        }
        // the app's routes; WebKit hands the scheme handler ArrayBuffer bodies (Blobs arrive empty)
        const r = native.handle(req.method, p, body, body ? 'ArrayBuffer' : 'none');
        return send(r.status, req.method === 'HEAD' ? null : r.body, r.type);
    });
});
await new Promise(r => server.listen(HTTP_PORT, '127.0.0.1', r));

const profile = path.join(run, 'chrome-profile');
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-background-timer-throttling', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let result = null;
let exitCode = 1;
try {
    let targets = null;
    for (let i = 0; i < 100 && !targets; i++) {
        try {
            targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        } catch {
            await sleep(200);
        }
    }
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r, { once: true }));
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m);
            pending.delete(m.id);
        } else if (m.method === 'Runtime.consoleAPICalled') {
            console.log(m.params.args.map(a => a.value ?? a.description).join(' '));
        } else if (m.method === 'Runtime.exceptionThrown') {
            console.log('[page exception]', m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
        }
    });
    const cdp = (method, params = {}) =>
        new Promise(r => {
            const i = ++id;
            pending.set(i, r);
            ws.send(JSON.stringify({ id: i, method, params }));
        });
    await cdp('Runtime.enable');
    await cdp('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/` });
    const end = Date.now() + 10 * 60 * 1000;
    while (!result && Date.now() < end) {
        await sleep(500);
        const r = await cdp('Runtime.evaluate', { expression: 'JSON.stringify(window.__result ?? null)', returnByValue: true });
        const v = r.result?.result?.value;
        if (v && v !== 'null') result = JSON.parse(v);
    }
    ws.close();
} finally {
    chrome.kill('SIGTERM');
    server.close();
}
await sleep(500);
fs.rmSync(run, { recursive: true, force: true });
if (!result) {
    console.log('[chrome] no result');
} else {
    fs.writeFileSync(path.join(TMP, `chrome-result-${DEBUG ? 'debug' : 'release'}.json`), JSON.stringify(result, null, 2));
    for (const c of result.checks.filter(c => !c.ok)) console.log(`  FAILED: [${c.phase}] ${c.name} ${c.detail !== undefined ? JSON.stringify(c.detail) : ''}`);
    const kinds = [...native.bodyKinds];
    const ok = result.ok && kinds.every(k => k === 'ArrayBuffer');
    console.log(`[chrome] ${result.userAgent}`);
    console.log(`[chrome] ${ok ? 'PASS' : 'FAIL'}: ${result.passed} checks passed, ${result.failed} failed (${result.seconds} s); PUT bodies: ${kinds.join(', ')}`);
    exitCode = ok ? 0 : 1;
}
process.exit(exitCode);
