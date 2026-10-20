// Page side of test (c): boots <Game>/engine/boot.js as a REAL module Web Worker and runs test/lib/session.mjs over
// worker.postMessage - protocol-level checks only (no engine internals, no clock control). The test server
// (test/chrome.test.mjs) implements the scheme handler's routes; storage inspection and failure injection go
// through its /__test/storage endpoint with synchronous XHR so the session's synchronous `storage` API holds.
import { runSession } from '../lib/session.mjs';

const fixture = await (await fetch('/fixture.json')).json();

function syncJson(method, url, body) {
    const x = new XMLHttpRequest();
    x.open(method, url, false);
    x.send(body ? JSON.stringify(body) : null);
    return JSON.parse(x.responseText);
}
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const storage = {
    get puts() {
        return syncJson('GET', '/__test/storage').puts.map(p => ({ rel: p.rel, bodyKind: p.bodyKind, bytes: b64(p.bytes) }));
    },
    get gets() {
        return syncJson('GET', '/__test/storage').gets;
    },
    get deletes() {
        return syncJson('GET', '/__test/storage').deletes;
    },
    set failDelete(v) {
        syncJson('POST', '/__test/storage', { failDelete: !!v });
    },
    set failPut(v) {
        syncJson('POST', '/__test/storage', { failPut: !!v });
    },
    set failGet(v) {
        syncJson('POST', '/__test/storage', { failGet: !!v });
    },
    read(rel) {
        const x = new XMLHttpRequest();
        x.open('GET', '/__test/read/' + rel, false);
        x.send();
        return x.status === 200 ? b64(x.responseText) : null;
    }
};

const worker = new Worker('/engine/boot.js', { type: 'module' });
const listeners = [];
worker.onmessage = e => listeners.forEach(fn => fn(e.data));
worker.onerror = e => console.error('worker error event: ' + (e.message || e));

const env = {
    post: (msg, transfer) => worker.postMessage(msg, transfer || []),
    onMessage: fn => listeners.push(fn),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: () => performance.now(),
    log: line => console.log(line),
    verbose: false,
    storage,
    fixture,
    hooks: null,
    clock: null,
    slow: 1,
    config: { node: { profile: 'enginetest' } }
};

const result = await runSession(env);
result.userAgent = navigator.userAgent;
window.__result = result;
