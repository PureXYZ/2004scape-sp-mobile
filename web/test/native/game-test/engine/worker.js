// Engine-like module worker: lives at engine/ like the real engine/boot.js, so '../save/…'
// resolves exactly as the engine's save path does. Uses SYNCHRONOUS XHR like the engine.
//
// On Android (the page says so with every command: workers have no LostCityNative) a write's bytes go base64url in
// X-LC-Body with their count in X-LC-Length and no body, as the engine's runtime/xhr.ts sends them there: the app's router
// never sees a request body (docs/ANDROID.md §3.2).
let android = false;
const bytesOf = (body) => body instanceof ArrayBuffer ? new Uint8Array(body)
    : ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    : new TextEncoder().encode(String(body));
function base64url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const xhr = (method, url, body, responseType) => {
    const x = new XMLHttpRequest();
    x.open(method, url, false);
    if (responseType) x.responseType = responseType;
    if (android && body != null) {
        const bytes = bytesOf(body);
        x.setRequestHeader('X-LC-Body', base64url(bytes));
        x.setRequestHeader('X-LC-Length', String(bytes.length));
        x.send(null);
    } else {
        x.send(body ?? null);
    }
    return x;
};

function pattern(n, seed) {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = (i * 7 + seed) & 255;
    return a;
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function runTests() {
    const results = [];
    const ok = (name, cond, detail = '') => results.push([name, !!cond, detail]);
    const base = '../save/players/main/workertest.sav';

    if (android) {
        ok('worker.location', self.location.href === 'https://appassets.androidplatform.net/engine/worker.js', self.location.href);
        ok('worker.noWebkit', typeof self.webkit === 'undefined' && typeof self.lcAndroid === 'undefined' && typeof self.LostCityNativeBridge === 'undefined', 'workers have no lcAndroid or LostCityNativeBridge');
    } else {
        ok('worker.location', self.location.href === 'lostcity://game/engine/worker.js', self.location.href);
        ok('worker.noWebkit', typeof self.webkit === 'undefined', 'workers have no webkit.messageHandlers');
    }

    xhr('DELETE', base);
    xhr('DELETE', base + '.bak');
    let x = xhr('GET', base, null, 'arraybuffer');
    ok('worker.syncGET.missing404', x.status === 404, `status ${x.status}`);

    const v1 = pattern(822, 3);
    x = xhr('PUT', base, v1.buffer);
    ok('worker.syncPUT.arraybuffer', x.status === 204, `status ${x.status}`);
    x = xhr('GET', base, null, 'arraybuffer');
    ok('worker.syncGET.readback', x.status === 200 && same(new Uint8Array(x.response), v1),
        `status ${x.status} len ${x.response?.byteLength} type ${x.getResponseHeader('content-type')}`);

    const v2 = pattern(900, 99);
    x = xhr('PUT', base, v2);  // Uint8Array view (not .buffer)
    ok('worker.syncPUT.uint8array', x.status === 204, `status ${x.status}`);
    x = xhr('GET', base + '.bak', null, 'arraybuffer');
    ok('worker.syncGET.bakIsPrevious', x.status === 200 && same(new Uint8Array(x.response), v1), `status ${x.status}`);
    x = xhr('GET', base, null, 'arraybuffer');
    ok('worker.syncGET.current', x.status === 200 && same(new Uint8Array(x.response), v2), `status ${x.status}`);

    // Latency of the engine's save path (sequential sync PUTs).
    const t0 = performance.now();
    let good = 0;
    for (let i = 0; i < 50; i++) {
        v2[0] = i;
        if (xhr('PUT', base, v2.buffer).status === 204) good++;
    }
    const avg = (performance.now() - t0) / 50;
    ok('worker.syncPUT.x50', good === 50, `avg ${avg.toFixed(2)} ms per sync PUT`);

    // Big sync GET (bundle file, chunked by the native handler).
    const t1 = performance.now();
    x = xhr('GET', '../t/big.bin', null, 'arraybuffer');
    const big = new Uint8Array(x.response ?? new ArrayBuffer(0));
    let bigOk = x.status === 200 && big.length === 8 * 1024 * 1024 + 123;
    for (let i = 0; bigOk && i < big.length; i += 4093) bigOk = big[i] === ((i * 31 + (i >> 11)) & 255);
    ok('worker.syncGET.big8MB', bigOk, `status ${x.status} len ${big.length} in ${(performance.now() - t1).toFixed(1)} ms`);

    x = xhr('POST', '../log?src=engine&level=warn', 'worker log line A\nworker log line B\n');
    ok('worker.log.syncPOST', x.status === 204, `status ${x.status}`);
    return results;
}

self.onmessage = async (e) => {
    const { id, cmd } = e.data;
    android = e.data.android === true;
    try {
        if (cmd === 'tests') {
            const results = runTests();
            const line = 'worker async log line C';
            const bytes = bytesOf(line);
            const r = await fetch('../log?src=engine', android
                ? { method: 'POST', headers: { 'X-LC-Body': base64url(bytes), 'X-LC-Length': String(bytes.length) } }
                : { method: 'POST', body: line });
            results.push(['worker.log.asyncPOST', r.status === 204, `status ${r.status}`]);
            postMessage({ id, results });
        } else if (cmd === 'save') {
            const data = pattern(e.data.size, Date.now() & 255);
            const t0 = performance.now();
            const x = xhr('PUT', '../save/' + e.data.name, data.buffer);
            postMessage({ id, status: x.status, ms: performance.now() - t0 });
        } else {
            postMessage({ id, error: 'unknown cmd ' + cmd });
        }
    } catch (err) {
        postMessage({ id, error: String(err?.stack ?? err) });
    }
};
postMessage({ ready: true });
