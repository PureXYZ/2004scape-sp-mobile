// Native-layer test page for the LostCity iOS app (ARCHITECTURE.md §3 routes, §7 page↔native).
// Runs in phases across reloads (state in localStorage); prints PASS/FAIL lines to the console
// (forwarded to the native log) and SHOT/ACTION/DONE markers that drive.mjs reacts to.
//
// The Android app runs the same page (android/test/drive.mjs; docs/ANDROID.md §3, §4; the map of every check to its
// Android twin: android/test/PARITY.md). Where the platforms differ by contract the Android branch checks Android's
// meaning, and the iOS path is unchanged: the handlers come from LostCityNativeBridge (WebMessageListener) instead of
// window.webkit, native calls the page through window.__lcCall, a write's bytes travel base64url in X-LC-Body (the
// router never sees a request body), the origin is https://appassets.androidplatform.net, the keyboard's traits are
// EditorInfo values, and the build without the chat model stands in for the simulator, which has none.
const ANDROID = window.LostCityNative?.platform === 'android';
const handlers = window.webkit?.messageHandlers ?? window.LostCityNativeBridge;
const native = (msg) => handlers.native.postMessage(msg);
const logEl = document.getElementById('log');
const chatEl = document.getElementById('chat');
const shown = [];
const totals = JSON.parse(localStorage.lcTotals || '{"pass":0,"fail":0,"failed":[]}');

function show(text, cls = '') {
    shown.push([text, cls]);
    if (shown.length > 24) shown.shift();
    logEl.replaceChildren(...shown.map(([t, c]) => Object.assign(document.createElement('div'), { className: c, textContent: t })));
}
function check(name, ok, detail = '') {
    if (ok) totals.pass++; else { totals.fail++; totals.failed.push(name); }
    localStorage.lcTotals = JSON.stringify(totals);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    show(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`, ok ? 'pass' : 'fail');
    return ok;
}
const info = (t) => { console.log(`INFO ${t}`); show(t, 'info'); };
const marker = (t) => console.log(t);  // read by drive.mjs
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms, step = 100) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (cond()) return true; await sleep(step); }
    return cond();
}
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Android: native → page calls come as window.__lcCall(id, "keyboard.insertText", [text]) (host.js defines it in the game;
// docs/ANDROID.md §3.1): the dotted path on window.LostCityHost, awaited, the outcome posted back for an id above 0.
if (ANDROID) {
    window.__lcCall = async (id, path, args) => {
        let reply;
        try {
            const parts = String(path).split('.');
            const owner = parts.slice(0, -1).reduce((object, key) => object?.[key], window.LostCityHost);
            const fn = owner?.[parts.at(-1)];
            if (typeof fn !== 'function') reply = { ch: 'reply', id, ok: false, error: 'missing' };
            else {
                const value = await fn.apply(owner, Array.isArray(args) ? args : []);
                reply = { ch: 'reply', id, ok: true, value: value === undefined ? null : value };
            }
        } catch (err) {
            reply = { ch: 'reply', id, ok: false, error: String(err?.message ?? err) };
        }
        if (id > 0) window.lcAndroid?.postMessage(JSON.stringify(reply));
    };
}

// A write's request as native takes it: on Android the bytes base64url (no padding) in X-LC-Body with their count in
// X-LC-Length and no body (shouldInterceptRequest never sees one: docs/ANDROID.md §3.2), on iOS the body itself.
async function writeInit(body) {
    if (!ANDROID) return { body };
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { headers: { 'X-LC-Body': btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'X-LC-Length': String(bytes.length) } };
}

// keyboard-state's traits: iOS's UIKeyboardType / UIReturnKeyType raw values and inputView; on Android the editor's
// inputType (TYPE_CLASS_TEXT | VISIBLE_PASSWORD | NO_SUGGESTIONS, or TYPE_CLASS_NUMBER) and IME action (Send 4, Go 2),
// and "none (hardware only)" with no keyboard asked for (docs/ANDROID.md §4.1)
const KBD = ANDROID ? { text: 0x80091, number: 2, send: 4, go: 2, idle: 'none' } : { text: 1, number: 11, send: 7, go: 1, idle: 'empty' };
// The bots' chat model: none runs on the simulator; the Android test build leaves it out (-Plc.model=none) to match
const LM_NONE = ANDROID ? { reason: 'no-model', where: 'in a build without the model' } : { reason: 'simulator', where: 'on the simulator' };

// host.js layout()'s zoom (ARCHITECTURE.md §6.1), which the native loading cover draws the page's loader at: the
// largest of 2 and 1.5 that the height allows and that leaves 667 px between the safe areas, otherwise 1
function pageZoom() {
    const probe = document.body.appendChild(document.createElement('div'));
    probe.style.cssText = 'position:fixed;visibility:hidden;padding:0 env(safe-area-inset-right,0px) 0 env(safe-area-inset-left,0px)';
    const style = getComputedStyle(probe);
    const usable = innerWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    probe.remove();
    const heightZoom = innerHeight >= 720 ? 2 : innerHeight >= 540 ? 1.5 : 1;
    const zoom = [2, 1.5].find((z) => z <= heightZoom && usable / z >= 667) ?? 1;
    if (!ANDROID || Number.isInteger(devicePixelRatio)) return zoom;
    // Android: host.js snapZoom, the crisp pixel snap at a fractional ratio (8/7 at 2.625; docs/ANDROID.md §1 Pixels)
    const snap = Math.round(devicePixelRatio * zoom) / devicePixelRatio;
    return usable / snap >= (zoom > 1 ? 667 : 568) && innerHeight / snap >= 320 ? snap : zoom;
}

// ---- debug channel (DEBUG builds only): {type:'debug', id, action} → window.__lcDebugReply(id, value)
let debugSeq = 0;
const debugWaiters = new Map();
window.__lcDebugReply = (id, value) => { debugWaiters.get(id)?.(value); debugWaiters.delete(id); };
function debug(action, extra = {}, timeoutMs = 4000) {
    const id = ++debugSeq;
    return new Promise((resolve) => {
        debugWaiters.set(id, resolve);
        native({ type: 'debug', id, action, ...extra });
        setTimeout(() => { if (debugWaiters.delete(id)) resolve('__timeout__'); }, timeoutMs);
    });
}

// ---- a fake LostCityHost (what web/host/host.js implements for real)
const events = [];
const lifecycleEvents = [];
let lastSave = null;
// latency: how long the "polling" takes to report a change (host.js polls every 200 ms); ignoreSubmit: a Return the
// game ignores (the line stays, so there is nothing to report)
const kbd = { prompt: '', text: '', submitted: [], latency: 30, ignoreSubmit: false };
function postUpdate() {
    const text = kbd.text;
    chatEl.textContent = text ? `You: ${text}*` : '';
    setTimeout(() => native({ type: 'keyboard', action: 'update', prompt: kbd.prompt, text }), kbd.latency);
}
let worker;
let workerReady;
function startWorker() {
    workerReady ??= new Promise((resolve) => {
        worker = new Worker('engine/worker.js', { type: 'module' });
        worker.addEventListener('message', (e) => { if (e.data?.ready) resolve(); });
        worker.addEventListener('error', (e) => { check('worker.load', false, e.message); resolve(); });
    });
    return workerReady;
}
async function workerCall(cmd, args = {}) {
    await startWorker();
    const id = Math.random();
    return new Promise((resolve) => {
        const h = (e) => { if (e.data?.id === id) { worker.removeEventListener('message', h); resolve(e.data); } };
        worker.addEventListener('message', h);
        worker.postMessage({ id, cmd, ...args });
    });
}
window.LostCityHost = {
    keyboard: {
        insertText(text) { events.push(['insertText', text]); kbd.text += text; postUpdate(); },
        deleteBackward() { events.push(['deleteBackward']); kbd.text = kbd.text.slice(0, -1); postUpdate(); },
        submit() {
            events.push(['submit', kbd.text]);
            if (kbd.ignoreSubmit) return;
            kbd.submitted.push(kbd.text); kbd.text = ''; postUpdate();
        },
        dismissed() { events.push(['dismissed']); },
        pressKey(key, down) { events.push(['pressKey', key, down]); },
    },
    async lifecycle(event) {
        const t0 = performance.now();
        lifecycleEvents.push(event);
        console.log(`LIFECYCLE ${event} received (visibility ${document.visibilityState})`);
        if (event === 'pause' || event === 'background' || event === 'terminate') {
            if (localStorage.lcHangNext === '1') {
                console.log(`LIFECYCLE ${event}: deliberately never resolving (timeout test)`);
                return new Promise(() => {});
            }
            lastSave = await workerCall('save', { name: 'players/main/lifecycle.sav', size: 900, android: ANDROID });
            console.log(`LIFECYCLE ${event}: engine-like save status ${lastSave.status} (sync PUT ${lastSave.ms.toFixed(1)} ms), total ${(performance.now() - t0).toFixed(1)} ms`);
            return { saved: lastSave.status === 204 };
        }
        return { resumed: true };
    },
    memoryWarning() { events.push(['memoryWarning']); },
};

// ---------------------------------------------------------------------------------------------
async function phaseRoutes() {
    const n = window.LostCityNative;
    check('native.injected', n?.platform === (ANDROID ? 'android' : 'ios') && typeof n.appVersion === 'string' && typeof n.settings === 'object', JSON.stringify(n));
    info(`origin ${location.origin} secure=${isSecureContext} COI=${self.crossOriginIsolated} vv=${visualViewport.width}x${visualViewport.height}`);

    // MIME table, status, Cache-Control, Content-Length
    const mime = [
        ['/', 'text/html'], ['/index.html', 'text/html'], ['/index.html?x=1', 'text/html'],
        ['/t/a.js', 'text/javascript'], ['/t/a.mjs', 'text/javascript'], ['/t/mod.js', 'text/javascript'],
        ['/t/UPPER.JS', 'text/javascript'], ['/engine/worker.js', 'text/javascript'],
        ['/t/a.wasm', 'application/wasm'], ['/t/a.json', 'application/json'], ['/t/a.map', 'application/json'],
        ['/t/a.css', 'text/css'], ['/t/a.png', 'image/png'], ['/t/a.html', 'text/html'], ['/t/a.txt', 'text/plain'],
        ['/t/with%20space.txt', 'text/plain'],
        ['/crc', 'application/octet-stream'], ['/title410306098', 'application/octet-stream'],
        ['/t/a.dat', 'application/octet-stream'], ['/t/a.sf2', 'application/octet-stream'],
        ['/t/main_file_cache.idx0', 'application/octet-stream'],
    ];
    for (const [path, type] of mime) {
        const r = await fetch(path);
        const body = await r.arrayBuffer();
        const ct = r.headers.get('content-type') ?? '';
        const cc = r.headers.get('cache-control');
        const cl = r.headers.get('content-length');
        check(`mime ${path} → ${type}`, r.status === 200 && ct.split(';')[0].trim() === type && cc === 'no-store' && Number(cl) === body.byteLength,
            `status ${r.status} type "${ct}" cache-control "${cc}" length ${cl}/${body.byteLength}`);
    }

    // HEAD
    let r = await fetch('/t/big.bin', { method: 'HEAD' });
    let b = await r.arrayBuffer();
    check('head bundle file', r.status === 200 && b.byteLength === 0 && r.headers.get('content-length') === String(8 * 1024 * 1024 + 123),
        `status ${r.status} body ${b.byteLength} length ${r.headers.get('content-length')}`);
    r = await fetch('/missing.bin', { method: 'HEAD' });
    check('head missing → 404', r.status === 404, `status ${r.status}`);

    // Error statuses
    const statuses = [
        ['GET', '/missing.js', 404], ['GET', '/t/', 404], ['GET', '/t', 404], ['GET', '/save', 404],
        ['GET', '/save/', 400], ['GET', '/save/..%2Fescape.sav', 400], ['GET', '/save/%2Fetc%2Fpasswd', 400],
        ['GET', '/save/a//b.sav', 400], ['GET', '/save/.hidden', 400], ['GET', '/save/x%00y', 400],
        ['GET', '/save/a%5Cb', 400], ['PUT', '/save/..%2F..%2Fescape.sav', 400], ['PUT', '/save/players/%2E%2E%2Fx', 400],
        ['PUT', '/t/a.js', 405], ['GET', '/log', 405], ['POST', '/save-index', 405],
        ['GET', '/save/players/none/nobody.sav', 404], ['DELETE', '/save/players/none/nobody.sav', 404],
    ];
    for (const [method, path, want] of statuses) {
        const res = await fetch(path, { method, body: method === 'PUT' || method === 'POST' ? new Uint8Array([1, 2]) : undefined });
        await res.arrayBuffer();
        check(`${method} ${path} → ${want}`, res.status === want, `status ${res.status} cache-control ${res.headers.get('cache-control')}`);
    }

    // Scripts, modules, wasm (strict MIME checks)
    await new Promise((resolve) => { const s = document.createElement('script'); s.src = 't/a.js'; s.onload = s.onerror = resolve; document.head.append(s); });
    await new Promise((resolve) => { const s = document.createElement('script'); s.src = 't/UPPER.JS'; s.onload = s.onerror = resolve; document.head.append(s); });
    check('classic scripts', globalThis.__aJsLoaded === true && globalThis.__upperLoaded === true);
    try { check('module import .mjs', (await import('./t/a.mjs')).fromMjs === 42); } catch (e) { check('module import .mjs', false, String(e)); }
    try { check('module import .js', (await import('./t/mod.js')).fromJs === 7); } catch (e) { check('module import .js', false, String(e)); }
    try {
        const { instance } = await WebAssembly.instantiateStreaming(fetch('/t/a.wasm'));
        check('wasm instantiateStreaming', Object.keys(instance.exports).length > 0, Object.keys(instance.exports).join(','));
    } catch (e) { check('wasm instantiateStreaming', false, String(e)); }

    // Saves from the page (async fetch)
    const P = '/save/players/test/hero.sav';
    const put = async (body, method = 'PUT', path = P) => fetch(path, { method, ...(await writeInit(body)) }).then(async (x) => { await x.arrayBuffer(); return x.status; });
    const get = async (path) => { const x = await fetch(path); return [x.status, new Uint8Array(await x.arrayBuffer()), x.headers.get('content-type')]; };
    await fetch(P, { method: 'DELETE' }); await fetch(P + '.bak', { method: 'DELETE' });
    const v1 = new Uint8Array([1, 2, 3]), v2 = new Uint8Array([4, 5, 6, 7]), v3 = new Uint8Array([8, 9]);
    check('save PUT v1 → 204', await put(v1) === 204);
    let [st, data, ct] = await get(P);
    check('save GET v1', st === 200 && eq(data, v1) && ct === 'application/octet-stream', `status ${st} type ${ct}`);
    check('save no .bak after first write', (await get(P + '.bak'))[0] === 404);
    check('save PUT v2 (ArrayBuffer) → 204', await put(v2.buffer) === 204);
    [st, data] = await get(P); check('save GET v2', st === 200 && eq(data, v2));
    [st, data] = await get(P + '.bak'); check('save .bak = v1', st === 200 && eq(data, v1), `status ${st} ${data}`);
    check('save PUT v2 again → 204', await put(v2) === 204);
    [st, data] = await get(P + '.bak'); check('save identical write keeps .bak = v1', st === 200 && eq(data, v1), `${data}`);
    check('save POST v3 → 204', await put(v3, 'POST') === 204);
    [st, data] = await get(P + '.bak'); check('save .bak = v2 after v3', st === 200 && eq(data, v2), `${data}`);
    r = await fetch(P, { method: 'HEAD' }); b = await r.arrayBuffer();
    check('save HEAD', r.status === 200 && r.headers.get('content-length') === '2' && b.byteLength === 0, `${r.status} ${r.headers.get('content-length')}`);
    r = await fetch('/save-index');
    const index = await r.json();
    const entry = index.find((e) => e.path === 'players/test/hero.sav');
    check('save-index entry', r.headers.get('content-type') === 'application/json' && entry?.size === 2 && Math.abs(Date.now() - entry.modified) < 120000,
        JSON.stringify(entry));
    check('save-index lists .bak', index.some((e) => e.path === 'players/test/hero.sav.bak'));
    check('save-index has no hidden/temp files', !index.some((e) => e.path.split('/').some((c) => c.startsWith('.'))), JSON.stringify(index.map((e) => e.path)));
    check('save DELETE → 204', (await fetch(P, { method: 'DELETE' })).status === 204);
    check('save GET after delete → 404', (await get(P))[0] === 404);
    [st, data] = await get(P + '.bak'); check('save deleted file kept as .bak', st === 200 && eq(data, v3));
    check('save DELETE again → 404', (await fetch(P, { method: 'DELETE' })).status === 404);
    check('save PUT onto a directory → 400', await put(v1, 'PUT', '/save/players/test') === 400);
    if (ANDROID) {
        // (the router never sees a body: a write without the header transport is a write of nothing)
        const raw = await fetch(P, { method: 'PUT', body: new Blob([v1]) }).then(async (x) => { await x.arrayBuffer(); return x.status; });
        check('save a body without X-LC-Body (the router never sees bodies) → 400', raw === 400, `status ${raw}`);
    } else {
        check('save Blob body → 400 (WebKit drops Blob bodies)', await put(new Blob([v1])) === 400);
    }
    check('save empty body → 400', await put(new ArrayBuffer(0)) === 400);
    if (ANDROID) {
        // the header transport's own refusals, in the router's order (docs/ANDROID.md §3.2); none touches the save
        const send = (headers) => fetch(P, { method: 'PUT', headers }).then(async (x) => { await x.arrayBuffer(); return x.status; });
        const body = (await writeInit(v1)).headers['X-LC-Body'];
        const refused = [
            ['X-LC-Length missing', { 'X-LC-Body': body }, 400],
            ['X-LC-Length not a count', { 'X-LC-Body': body, 'X-LC-Length': '3x' }, 400],
            ['above 32 MiB', { 'X-LC-Body': body, 'X-LC-Length': String(32 * 1024 * 1024 + 1) }, 413],
            ['X-LC-Body padded (not base64url without padding)', { 'X-LC-Body': 'AQID=', 'X-LC-Length': '3' }, 400],
            ['X-LC-Body with + and / (base64, not base64url)', { 'X-LC-Body': '+/+/', 'X-LC-Length': '3' }, 400],
            ['decoded size not X-LC-Length', { 'X-LC-Body': body, 'X-LC-Length': '4' }, 400],
        ];
        for (const [what, headers, want] of refused) {
            const status = await send(headers);
            check(`save header transport: ${what} → ${want}`, status === want, `status ${status}`);
        }
        // (the save was deleted above: still none, and its .bak still v3)
        const after = (await get(P))[0];
        [st, data] = await get(P + '.bak');
        check('save header transport: the refused writes left the save and its .bak alone', after === 404 && st === 200 && eq(data, v3), `save ${after}, .bak ${st} ${data}`);
    }
    check('save string body → 204', await put('text body') === 204);
    [st, data] = await get(P); check('save string readback', st === 200 && new TextDecoder().decode(data) === 'text body');
    const mb = new Uint8Array(1024 * 1024).map((_, i) => (i * 13) & 255);
    let t0 = performance.now();
    check('save 1 MB PUT', await put(mb) === 204, `${(performance.now() - t0).toFixed(1)} ms`);
    [st, data] = await get(P); check('save 1 MB readback', st === 200 && eq(data, mb));
    await fetch(P, { method: 'DELETE' });

    // The engine-like worker: sync XHR saves + /log
    await startWorker();
    const w = await workerCall('tests', { android: ANDROID });
    if (w.error) check('worker tests', false, w.error);
    for (const [name, ok, detail] of w.results ?? []) check(name, ok, detail);
    r = await fetch('/log?src=page&level=error', { method: 'POST', ...(await writeInit('page log line 1\npage log line 2')) });
    check('page POST /log → 204', r.status === 204, `status ${r.status}`);

    // Large file (chunked), aborts (stop path), parallel requests
    t0 = performance.now();
    const big = new Uint8Array(await (await fetch('/t/big.bin')).arrayBuffer());
    let bigOk = big.length === 8 * 1024 * 1024 + 123;
    for (let i = 0; bigOk && i < big.length; i++) if (big[i] !== ((i * 31 + (i >> 11)) & 255)) bigOk = false;
    check('big file 8 MB, every byte', bigOk, `${big.length} bytes in ${(performance.now() - t0).toFixed(1)} ms`);
    const aborted = [];
    for (let i = 0; i < 6; i++) {
        const ctl = new AbortController();
        const p = fetch('/t/big.bin', { signal: ctl.signal }).then((x) => x.arrayBuffer()).then(() => 'completed', (e) => e.name);
        setTimeout(() => ctl.abort(), i * 3);
        aborted.push(await p);
    }
    check('aborted requests (WKURLSchemeTask stop)', aborted.every((x) => x === 'AbortError' || x === 'completed'), aborted.join(','));
    const statusesPar = await Promise.all(Array.from({ length: 60 }, (_, i) => fetch(i % 3 ? '/t/a.js' : '/t/big.bin').then((x) => x.arrayBuffer().then(() => x.status))));
    check('60 parallel requests after aborts', statusesPar.every((s) => s === 200), statusesPar.join(''));

    // A main-frame navigation off the origin is cancelled by native policy (WebKit then reports a
    // provisional failure); the running page must be unaffected and no error cover shown.
    location.href = 'https://example.com/blocked-by-native-policy';
    await sleep(1000);
    const ui = await debug('ui-state');
    check('blocked external navigation leaves the page running', ui !== '__timeout__' && ui.overlayShowing === false && (ANDROID ? location.origin === 'https://appassets.androidplatform.net' : location.protocol === 'lostcity:'),
        `${JSON.stringify(ui)} ${location.href}`);

    // Haptics (no-ops in the simulator; must not crash)
    for (const style of ['light', 'medium', 'heavy', 'selection', 'soft', 'rigid', 'success', 'warning', 'error', 'bogus']) native({ type: 'haptic', style });
    native({ type: 'haptic', style: 'light', intensity: 0.5 });
    check('haptics survived', (await debug('idle-timer')) !== '__timeout__');

    // Status → keep-awake
    native({ type: 'status', phase: 'engine-ready' });
    native({ type: 'status', phase: 'ingame' });
    check('status ingame → idle timer disabled', (await debug('idle-timer')) === true);
    native({ type: 'status', phase: 'title', detail: 'logged out' });
    check('status title → idle timer enabled', (await debug('idle-timer')) === false);

    // Memory warning → LostCityHost.memoryWarning()
    await debug('memory-warning');
    check('memory warning reaches the page', await until(() => events.some((e) => e[0] === 'memoryWarning'), 2000));

    // Settings (verified after the reload)
    native({ type: 'settings', values: { testCounter: 41, nested: { a: [1, 2] }, removeMe: 1 } });
    native({ type: 'settings', values: { testCounter: 42, removeMe: null } });
    const stored = await debug('settings');
    check('settings stored natively', stored?.testCounter === 42 && !('removeMe' in stored) && stored?.nested?.a?.[1] === 2, JSON.stringify(stored));
    native({ type: 'settings', values: 'not an object' });

    localStorage.lcSettingsSet = '1';
    localStorage.lcPhase = 'keyboard';
    info('reloading to verify settings injection…');
    await sleep(500);
    location.reload();
}

// ---------------------------------------------------------------------------------------------
async function phaseKeyboard() {
    const s0 = window.LostCityNative?.settings;
    if (localStorage.lcSettingsSet === '1') {
        check('settings injected after reload', s0?.testCounter === 42 && !('removeMe' in s0) && s0?.nested?.a?.join() === '1,2', JSON.stringify(s0));
    }
    const state = () => debug('keyboard-state');
    const vv = () => `visualViewport ${visualViewport.width}x${visualViewport.height} offsetTop ${visualViewport.offsetTop} inner ${innerWidth}x${innerHeight} scrollY ${scrollY}`;

    let s = await state();
    check('kbd idle: first responder, no software keyboard', s.isFirstResponder === true && s.requested === false && s.inputView.startsWith(KBD.idle), JSON.stringify(s));
    info(vv());

    // 1. chat
    events.length = 0;
    kbd.prompt = 'Public chat'; kbd.text = '';
    native({ type: 'keyboard', action: 'show', kind: 'chat', prompt: 'Public chat', text: '', secure: false, numeric: false });
    await sleep(1200);
    s = await state();
    check('kbd show chat: system keyboard requested', s.isFirstResponder && s.requested && s.inputView === 'system keyboard' && s.softwareKeyboardVisible, JSON.stringify(s));
    check('kbd chat traits: asciiCapable, Send, not secure', s.keyboardType === KBD.text && s.returnKeyType === KBD.send && s.isSecureTextEntry === false, JSON.stringify(s));
    info(vv());
    await debug('type', { text: 'Hello world' });
    await sleep(500);
    check('kbd insertText reaches page in order', events.filter((e) => e[0] === 'insertText').map((e) => e[1]).join('') === 'Hello world', JSON.stringify(events));
    s = await state();
    check('kbd bar shows typed text', s.displayText === 'Hello world', s.displayText);
    marker('SHOT kbd-chat'); await sleep(1500);
    await debug('type', { text: '\b\b\b\b\bthere\n' });
    await sleep(500);
    check('kbd deleteBackward + insertText + submit', kbd.submitted.at(-1) === 'Hello there', JSON.stringify(kbd.submitted));
    const tail = events.slice(-11).map((e) => e[0]).join(',');
    check('kbd event sequence', tail === 'deleteBackward,'.repeat(5) + 'insertText,'.repeat(5) + 'submit', tail);
    s = await state();
    check('kbd bar cleared after submit (host update)', s.displayText === '', JSON.stringify(s.displayText));

    // 2. switch to login-user while shown (traits reload)
    kbd.prompt = 'Username:'; kbd.text = 'casey';
    native({ type: 'keyboard', action: 'show', kind: 'login-user', prompt: 'Username:', text: 'casey', secure: false, numeric: false });
    await sleep(900);
    s = await state();
    // (Go / "Log in" on the username too: offline a name is enough, the page fills a password in)
    check('kbd login-user: Go key, "Log in"', s.returnKeyType === KBD.go && s.submitTitle === 'Log in' && s.keyboardType === KBD.text && s.displayText === 'casey', JSON.stringify(s));
    marker('SHOT kbd-login-user'); await sleep(1500);

    // 3. password: masked in the bar, never isSecureTextEntry (no Passwords AutoFill bar)
    kbd.prompt = 'Password:'; kbd.text = 'hunter2';
    native({ type: 'keyboard', action: 'show', kind: 'login-pass', prompt: 'Password:', text: 'hunter2', secure: true, numeric: false });
    await sleep(900);
    s = await state();
    check('kbd login-pass: masked, not secure entry, Go key', s.displayText === '*******' && s.isSecureTextEntry === false && s.returnKeyType === KBD.go, JSON.stringify(s));
    await debug('type', { text: 'x' }); await sleep(300);
    s = await state();
    check('kbd login-pass: echo stays masked', s.displayText === '********', s.displayText);
    marker('SHOT kbd-login-pass'); await sleep(1500);

    // 4. numeric amount dialog: number pad + bar submit button
    kbd.prompt = 'Enter amount:'; kbd.text = '';
    native({ type: 'keyboard', action: 'show', kind: 'dialog', prompt: 'Enter amount:', text: '', secure: false, numeric: true });
    await sleep(900);
    await debug('type', { text: '1234' }); await sleep(400);
    s = await state();
    check('kbd numeric: asciiCapableNumberPad', s.keyboardType === KBD.number && s.displayText === '1234', JSON.stringify(s));
    marker('SHOT kbd-numeric'); await sleep(1500);
    await debug('bar', { button: 'submit' }); await sleep(300);
    check('kbd bar submit button → submit()', kbd.submitted.at(-1) === '1234', JSON.stringify(kbd.submitted));

    // 5. page hide → idle (still first responder for hardware keys), no dismissed() callback
    native({ type: 'keyboard', action: 'hide' });
    await sleep(1000);
    s = await state();
    check('kbd hide: idle, still first responder, keyboard gone', s.isFirstResponder && !s.requested && s.inputView.startsWith(KBD.idle) && !s.softwareKeyboardVisible, JSON.stringify(s));
    check('kbd hide by page: no dismissed()', !events.some((e) => e[0] === 'dismissed'));
    info(vv());
    marker('SHOT kbd-hidden'); await sleep(1200);

    // 6. user dismissal (bar hide button) → dismissed() exactly once
    kbd.prompt = 'Enter name of friend to add to list'; kbd.text = '';
    native({ type: 'keyboard', action: 'show', kind: 'social', prompt: kbd.prompt, text: '', secure: false, numeric: false });
    await sleep(900);
    await debug('type', { text: 'Zezima' }); await sleep(300);
    marker('SHOT kbd-social'); await sleep(1500);
    await debug('bar', { button: 'hide' }); await sleep(900);
    check('kbd user dismissal → dismissed() once', events.filter((e) => e[0] === 'dismissed').length === 1, JSON.stringify(events.filter((e) => e[0] === 'dismissed')));
    s = await state();
    check('kbd after user dismissal: idle', !s.requested && s.isFirstResponder && !s.softwareKeyboardVisible, JSON.stringify(s));
    native({ type: 'keyboard', action: 'hide' });  // a late hide from the page is harmless

    // 7. hardware key path (debug hook; UIPress itself cannot be synthesized)
    const before = events.length;
    await debug('key', { key: 'ArrowLeft', down: true }); await sleep(80);
    await debug('key', { key: 'ArrowLeft', down: false }); await sleep(80);
    await debug('key', { key: 'Backspace', down: true }); await sleep(750);
    await debug('key', { key: 'Backspace', down: false }); await sleep(120);
    await debug('key', { key: 'F5', down: true }); await debug('key', { key: 'F5', down: false }); await sleep(120);
    const pk = events.slice(before).filter((e) => e[0] === 'pressKey');
    check('hw ArrowLeft down/up', pk[0]?.[1] === 'ArrowLeft' && pk[0][2] === true && pk[1]?.[1] === 'ArrowLeft' && pk[1][2] === false, JSON.stringify(pk.slice(0, 2)));
    const bs = pk.filter((e) => e[1] === 'Backspace');
    check('hw Backspace auto-repeat then up', bs.filter((e) => e[2]).length >= 5 && bs.at(-1)[2] === false, `${bs.filter((e) => e[2]).length} keydowns`);
    check('hw F5', pk.some((e) => e[1] === 'F5' && e[2]) && pk.some((e) => e[1] === 'F5' && !e[2]));

    // 8. input rules: each charset takes what the client's own input code keeps (Client.ts) and refuses the rest
    const typed = () => events.filter((e) => e[0] === 'insertText').map((e) => e[1]).join('');
    const showKeyboard = (context) => {
        kbd.prompt = context.prompt; kbd.text = context.text ?? '';
        native({ type: 'keyboard', action: 'show', text: '', secure: false, numeric: false, ...context });
    };
    async function typeInto(context, text) {
        showKeyboard(context);
        await sleep(500);
        const before = (await state()).rejections;
        events.length = 0;
        await debug('type', { text });
        await sleep(300);
        return { sent: typed(), refused: (await state()).rejections - before };
    }
    const chat = { kind: 'chat', prompt: 'Chat', maxLength: 80, charset: 'chat' };
    let r = await typeInto(chat, 'a{b|c}d~e');
    check('charset chat: { | } ~ refused outside a :: command', r.sent === 'abcde' && r.refused === 4, JSON.stringify(r));
    r = await typeInto(chat, '::give{x}|~');
    check('charset chat: { | } ~ taken in a :: command', r.sent === '::give{x}|~' && r.refused === 0, JSON.stringify(r));
    r = await typeInto({ ...chat, text: '::' }, '~bank');
    check('charset chat: the line the page reported counts', r.sent === '~bank' && r.refused === 0, JSON.stringify(r));
    r = await typeInto({ kind: 'social', prompt: 'Enter message to send to Zezima', cancellable: true, maxLength: 80, charset: 'text' }, '::hi{~}é');
    check('charset text (private message): ASCII up to z, even after ::', r.sent === '::hi' && r.refused === 4, JSON.stringify(r));
    r = await typeInto({ kind: 'report', prompt: 'Player to report', cancellable: true, maxLength: 12, charset: 'alnum' }, 'Bob-Smith_x 9!');
    check('charset alnum (report): letters, digits and space', r.sent === 'BobSmithx 9' && r.refused === 3, JSON.stringify(r));
    r = await typeInto({ kind: 'login-pass', prompt: 'Password', secure: true, maxLength: 20, charset: 'game' }, 'p£s!"\\|~{é€');
    check('charset game (password): the client\'s CHARSET, £ included', r.sent === 'p£s!"\\|~{' && r.refused === 2, JSON.stringify(r));
    r = await typeInto({ kind: 'login-user', prompt: 'Username', maxLength: 12, charset: 'name' }, 'Zezima_9-x!@');
    check('charset name: letters, digits, space, - and _', r.sent === 'Zezima_9-x' && r.refused === 2, JSON.stringify(r));
    r = await typeInto({ ...chat, charset: 'emoji' }, 'é{~');
    s = await state();
    check('unknown charset: takes anything', r.sent === 'é{~' && r.refused === 0 && s.charset === 'any', `${JSON.stringify(r)} ${s.charset}`);
    // a chip clears the line before it types, so its '::~bank' keeps the ~
    showKeyboard({ ...chat, text: 'hi', chips: [{ label: '::', text: '::', whenEmpty: true }, { label: '::~bank', text: '::~bank' }] });
    await sleep(500);
    events.length = 0;
    const label = await debug('chip', { index: 0 });  // ('::' only shows while the line is empty)
    await sleep(300);
    check('chip ::~bank on a chat line: replaces the line, keeps the ~', label === '::~bank' && typed() === '::~bank' && kbd.text === '::~bank',
        `${label} "${kbd.text}" ${JSON.stringify(events)}`);

    // 9. paste: one line, cut to the longest input (80); with no keyboard requested (⌘V on a hardware keyboard in game)
    // it takes what the chat line takes
    async function pasteInto(context, text) {
        if (context) showKeyboard(context); else native({ type: 'keyboard', action: 'hide' });
        await sleep(context ? 500 : 900);
        const before = (await state()).rejections;
        events.length = 0;
        await debug('paste', { text });
        await sleep(300);
        return { sent: typed(), refused: (await state()).rejections - before, submitted: events.some((e) => e[0] === 'submit') };
    }
    r = await pasteInto(chat, 'one\ntwo\r\nthree ’four’ {five}');
    check('paste: line breaks become spaces, filtered, never submitted', r.sent === "one two three 'four' five" && r.refused === 1 && !r.submitted, JSON.stringify(r));
    r = await pasteInto({ kind: 'chat', prompt: 'Chat' }, 'x'.repeat(200));
    check('paste: cut to 80 characters with no maxLength, the rest refused', r.sent === 'x'.repeat(80) && r.refused === 1, `${r.sent.length} chars, refused ${r.refused}`);
    r = await pasteInto(null, 'a{b}\n' + 'c'.repeat(100));
    s = await state();
    check('paste with no keyboard requested: cut to 80, filtered as chat', !s.requested && r.sent === 'ab ' + 'c'.repeat(75) && r.refused === 1,
        `requested ${s.requested}: ${r.sent.length} chars "${r.sent.slice(0, 6)}…", refused ${r.refused}`);
    r = await pasteInto(null, '::~bank');
    check('paste with no keyboard requested: a :: command keeps its ~', r.sent === '::~bank' && r.refused === 0, JSON.stringify(r));

    // 10. Send on the chat line empties the bar at once, so the next message's first letters fit although the page
    // reports the cleared line only on its next poll; the other inputs leave the line to the page; and when Return did
    // nothing the page's line comes back
    kbd.latency = 400;
    showKeyboard(chat);
    await sleep(500);
    await debug('type', { text: 'a'.repeat(80) });
    await sleep(900);
    const r0 = (await state()).rejections;
    events.length = 0;
    await debug('bar', { button: 'submit' });
    const emptied = (await state()).displayText === '';
    await debug('type', { text: 'ne' });
    s = await state();
    check('chat Send: the bar empties at once and the next letters fit', emptied && s.displayText === 'ne' && typed() === 'ne' && s.rejections === r0,
        `emptied ${emptied}, bar "${s.displayText}", sent "${typed()}", refused ${s.rejections - r0}`);
    await sleep(1000);
    s = await state();
    check('chat Send: the page\'s reports agree', kbd.submitted.at(-1) === 'a'.repeat(80) && kbd.text === 'ne' && s.displayText === 'ne', `"${kbd.text}" "${s.displayText}"`);
    showKeyboard({ kind: 'login-user', prompt: 'Username', text: 'casey', maxLength: 12, charset: 'name' });
    await sleep(600);
    await debug('bar', { button: 'submit' });
    s = await state();
    check('login Send: the line stays until the page reports it', s.displayText === 'casey', s.displayText);
    await sleep(700);
    kbd.ignoreSubmit = true;
    showKeyboard({ ...chat, text: 'hey' });
    await sleep(500);
    await debug('bar', { button: 'submit' });
    const emptiedIgnored = (await state()).displayText === '';
    await sleep(800);
    s = await state();
    check('chat Send that the game ignores: the line comes back', emptiedIgnored && s.displayText === 'hey', `emptied ${emptiedIgnored}, bar "${s.displayText}"`);
    await debug('key', { key: 'Enter', down: true });
    const emptiedByKey = (await state()).displayText === '';
    await debug('key', { key: 'Enter', down: false });
    await sleep(800);
    s = await state();
    check('hardware Enter on the chat line: the same', emptiedByKey && s.displayText === 'hey', `emptied ${emptiedByKey}, bar "${s.displayText}"`);
    kbd.ignoreSubmit = false;
    kbd.latency = 30;

    // 11. Settings › Vibration: Off (the page's `haptics` setting) silences the haptics native plays itself, a refused
    // key and a fatal error; the bar still flashes
    showKeyboard(chat);
    native({ type: 'settings', values: { haptics: false } });
    await sleep(600);  // (also more than the 0.3 s that holds back the haptic of a second refusal)
    await debug('haptics');  // forgets the earlier ones
    await debug('type', { text: 'é' });
    const flashed = (await state()).flashing;
    native({ type: 'fatal', message: 'Test fatal error with Vibration off.' });
    await sleep(300);
    let played = await debug('haptics');
    check('Vibration off: no native haptics (refused key, fatal), the bar still flashes', Array.isArray(played) && played.length === 0 && flashed === true,
        `played ${JSON.stringify(played)}, flashing ${flashed}`);
    native({ type: 'settings', values: { haptics: null } });  // the default again: on
    showKeyboard(chat);  // (the fatal error hid it)
    await sleep(600);
    await debug('type', { text: 'é' });
    native({ type: 'fatal', message: 'Test fatal error with Vibration on.' });
    await sleep(300);
    played = await debug('haptics');
    check('Vibration on (the default): warning for a refused key, error for a fatal error', JSON.stringify(played) === '["warning","error"]', JSON.stringify(played));
    native({ type: 'keyboard', action: 'hide' });
    await sleep(600);

    localStorage.lcPhase = 'lm';
    await phaseLm();
}

// ---- the bots' chat model, native side (ARCHITECTURE.md §7.1): its status at document start, the Claude key's native
// secure box (Save, Cancel, not a key, Remove; the page never sees the key), requests answered through
// LostCityHost.bots.lmReply (Claude: drive.mjs's local mock of the Messages API, never a real call; on the simulator no
// on-device model: llama.cpp's release has no simulator slice), the status after a refused key, 'busy' past 3 at once,
// and the status in window.LostCityNative.lm after a reload. Think first (the on-device model's note before a reply):
// the status's note support (never here: no model runs on the simulator), requests that carry think (the relay: no model
// here, and Claude online ignores it: drive.mjs fails the run on a request the mock API would refuse) and the setting
// botThink kept across a reload (native's settings, as the Bot chat page stores it).
const lmReplies = [];
const lmStatuses = [];
window.LostCityHost.bots = {
    lmReply(reply) { lmReplies.push(reply); },
    lmStatus(status) { lmStatuses.push(status); },
};
const LM_PROMPT = { local: { system: 'You are Kevin1991.', user: 'Dark Lord 91: hi' }, online: { system: 'A 2004 chat guide.', context: 'You are Kevin1991.', user: 'Dark Lord 91: hi kevin' } };
const lmAsk = (id, mode, extra = {}) => native({ type: 'lm', id, mode, ...LM_PROMPT, maxChars: 80, timeoutMs: 9000, ...extra });
async function lmReply(id, ms = 12000) {
    await until(() => lmReplies.some((r) => r.id === id), ms);
    return lmReplies.find((r) => r.id === id) ?? null;
}
async function lmKey(text, button = 'save') {
    native({ type: 'lm-key', action: 'set' });
    await sleep(1200);  // (the alert's animation)
    const alert = await debug('lm-key-alert', { text, button });
    await sleep(600);
    return alert;
}
const lmLast = () => lmStatuses.at(-1) ?? null;

async function phaseLm() {
    const start = window.LostCityNative?.lm;
    check(`lm: LostCityNative.lm at document start: no on-device model ${LM_NONE.where}, no key`, start?.local?.available === false && start.local.reason === LM_NONE.reason && start.online?.keySet === false, JSON.stringify(start));
    check(`lm: the status says whether the on-device model writes its note: never here (no model runs ${LM_NONE.where}; Bot chat shows no Think first)`, start?.local?.think === 'never' && (await debug('lm-status'))?.status?.local?.think === 'never', JSON.stringify(start?.local));
    const mock = await fetch('lm-mock.txt').then((r) => (r.ok ? r.text() : '')).then((t) => t.trim()).catch(() => '');
    check('lm: drive.mjs runs the mock Messages API', /^http:\/\/127\.0\.0\.1:\d+\/v1\/messages$/.test(mock), mock);
    await debug('lm-endpoint', { url: mock });

    // the secure box: Save
    native({ type: 'lm-key', action: 'set' });
    await sleep(1200);
    marker('SHOT lm-key-alert');
    await sleep(1500);
    const alert = await debug('lm-key-alert', { text: 'sk-ant-test-ok-abcd', button: 'save' });
    check('lm: {type:lm-key, action:set} opens a native alert ("Claude API key") with a secure field holding the keyboard', alert?.shown === true && alert.secure === true && alert.firstResponder === true && alert.title === 'Claude API key', JSON.stringify(alert));
    await until(() => lmLast()?.online?.keySet === true, 5000);
    check('lm: Save keeps the key: the status says set, ends in …abcd, and never carries the key', lmLast()?.online?.keySet === true && lmLast().online.hint === '\u2026abcd' && !JSON.stringify(lmStatuses).includes('sk-ant'), JSON.stringify(lmLast()));
    const kb = await debug('keyboard-state');
    check('lm: after the alert the keyboard bridge is first responder again', kb?.isFirstResponder === true, JSON.stringify({ isFirstResponder: kb?.isFirstResponder }));

    // requests
    lmAsk(1, 'online');
    let reply = await lmReply(1);
    check('lm: online: Claude\'s line through LostCityHost.bots.lmReply ({id, text, source, ms})', reply?.text === 'hey whats up' && reply.source === 'online' && typeof reply.ms === 'number', JSON.stringify(reply));
    lmAsk(2, 'local');
    reply = await lmReply(2);
    check(`lm: local ${LM_NONE.where}: null, unavailable, at once`, reply?.text === null && reply.error === 'unavailable' && reply.ms < 100, JSON.stringify(reply));
    native({ type: 'lm-warm' });  // (nothing to warm here: no crash, no answer)
    // think (Settings › Bot chat › Think first) with every request: Claude online ignores it (the mock gets the request as
    // without it); the on-device model, not here, answers unavailable as without it
    lmAsk(20, 'online', { think: true });
    reply = await lmReply(20);
    check('lm: online with think: Claude\'s line, as without it', reply?.source === 'online' && typeof reply.text === 'string' && !('timings' in reply), JSON.stringify(reply));
    lmAsk(21, 'local', { think: true });
    reply = await lmReply(21);
    check(`lm: local with think ${LM_NONE.where}: null, unavailable, at once`, reply?.text === null && reply.error === 'unavailable' && reply.ms < 100, JSON.stringify(reply));
    lmAsk(3, 'online', { fallback: false });
    reply = await lmReply(3);
    check('lm: the Test (no fallback) with a good key: Claude\'s line', reply?.source === 'online' && typeof reply.text === 'string', JSON.stringify(reply));

    // Cancel keeps the key; a refused key; something that cannot be a key
    const cancelled = await lmKey('sk-ant-test-other-9999', 'cancel');
    const kept = (await debug('lm-status'))?.status;
    check('lm: Cancel keeps the key as it was (…abcd)', cancelled?.shown === true && kept?.online?.hint === '\u2026abcd', JSON.stringify({ cancelled, kept }));
    await lmKey('sk-ant-test-bad-0000');
    lmAsk(4, 'online');
    reply = await lmReply(4);
    await sleep(300);
    check('lm: a refused key (401): null, refused (no on-device fallback here); the status says key refused', reply?.text === null && reply.error === 'refused' && lmLast()?.online?.valid === false && lmLast().online.problem === 'key refused' && lmLast().online.hint === '\u20260000', JSON.stringify({ reply, status: lmLast() }));
    await lmKey('x');
    check('lm: what cannot be a key is refused: the key stays, the status says "not a key"', lmLast()?.online?.problem === 'not a key' && lmLast().online.hint === '\u20260000', JSON.stringify(lmLast()));

    // more than 3 at once: busy
    await lmKey('sk-ant-test-slow-1111');
    for (const id of [10, 11, 12, 13]) lmAsk(id, 'online', { fallback: false, timeoutMs: 3000 });
    const errors = [];
    for (const id of [10, 11, 12, 13]) errors.push((await lmReply(id, 8000))?.error ?? 'none');
    check('lm: 4 requests at once: the fourth is busy at once, the others time out (a slow API)', JSON.stringify(errors) === '["timeout","timeout","timeout","busy"]', JSON.stringify(errors));

    // the status in LostCityNative.lm after a reload (continues in phaseLmReload); Think first On, as the Bot chat page
    // keeps it (native's settings)
    await lmKey('sk-ant-test-ok-zzzz');
    native({ type: 'settings', values: { botThink: true } });
    await sleep(300);
    check('lm: Think first kept by native ({type:settings} botThink: true)', (await debug('settings'))?.botThink === true);
    localStorage.lcPhase = 'lm-reload';
    location.reload();
}

async function phaseLmReload() {
    const start = window.LostCityNative?.lm;
    check('lm: after a reload LostCityNative.lm has the key\'s status (…zzzz)', start?.online?.keySet === true && start.online.hint === '\u2026zzzz', JSON.stringify(start));
    check('lm: after a reload Think first is still On (LostCityNative.settings.botThink)', window.LostCityNative?.settings?.botThink === true, JSON.stringify(window.LostCityNative?.settings ?? null));
    native({ type: 'settings', values: { botThink: null } });  // (the default again)
    await sleep(300);
    const cleared = await debug('settings');
    check('lm: and back to the default (null removes it)', cleared !== null && typeof cleared === 'object' && !('botThink' in cleared), JSON.stringify(cleared));
    native({ type: 'lm-key', action: 'remove' });
    await until(() => lmLast()?.online?.keySet === false, 5000);
    check('lm: {type:lm-key, action:remove} deletes the key: the status says not set', lmLast()?.online?.keySet === false, JSON.stringify(lmLast()));
    await debug('lm-endpoint', {});
    localStorage.lcPhase = 'lifecycle';
    await phaseLifecycle();
}

// ---------------------------------------------------------------------------------------------
async function phaseLifecycle() {
    await startWorker();
    // willTerminate: native spins the main run loop until the engine-like save is written.
    lifecycleEvents.length = 0;
    lastSave = null;
    const term = await debug('terminate', {}, 10000);
    await sleep(500);
    check('terminate flush completes inside the nested run loop', term?.ms < 3000 && lastSave?.status === 204,
        `${JSON.stringify(term)} save ${JSON.stringify(lastSave)}`);
    check('terminate then resume', JSON.stringify(lifecycleEvents) === '["terminate","resume"]', JSON.stringify(lifecycleEvents));

    // Normal background/foreground: one flush (pause), no duplicate background, one resume.
    lifecycleEvents.length = 0;
    lastSave = null;
    marker('ACTION background-cycle');
    check('lifecycle: came back to foreground', await until(() => lifecycleEvents.includes('foreground') || lifecycleEvents.includes('resume'), 90000));
    await sleep(2000);
    check('lifecycle cycle: exactly pause then foreground', JSON.stringify(lifecycleEvents) === '["pause","foreground"]', JSON.stringify(lifecycleEvents));
    check('lifecycle cycle: save written via sync XHR', lastSave?.status === 204, JSON.stringify(lastSave));

    // Page never answers: native must time out and still end the background task.
    lifecycleEvents.length = 0;
    localStorage.lcHangNext = '1';
    marker('ACTION background-hang');
    check('lifecycle hang: came back to foreground', await until(() => lifecycleEvents.includes('foreground') || lifecycleEvents.includes('resume'), 120000));
    await sleep(2000);
    delete localStorage.lcHangNext;
    check('lifecycle hang: pause sent once, foreground after timeout', JSON.stringify(lifecycleEvents) === '["pause","foreground"]', JSON.stringify(lifecycleEvents));

    // WebContent killed while the app is in the background → native restarts it on return
    // (continues in phaseCrashBackground).
    localStorage.lcPhase = 'crash-bg';
    localStorage.lcCrashArmed = '1';
    await sleep(800);
    marker('ACTION background-kill');
    await sleep(60000);
    check('crash-bg: WebContent was killed', false, 'still alive 60 s after the request');
}

async function phaseCrashBackground() {
    check('crash-bg: page restarted after WebContent died in the background', localStorage.lcCrashArmed === '1');
    check('crash-bg: restarted while visible', document.visibilityState === 'visible', document.visibilityState);
    // Foreground WebContent crash → native reloads the page at once (continues in phaseCrash).
    localStorage.lcPhase = 'crash';
    await sleep(1500);
    marker('ACTION kill-webcontent');
    await sleep(30000);
    check('crash: WebContent was killed', false, 'still alive 30 s after the request');
}

async function phaseCrash() {
    check('crash: page reloaded by native after WebContent termination', localStorage.lcCrashArmed === '1');
    delete localStorage.lcCrashArmed;
    if (localStorage.lcSettingsSet === '1') check('crash: settings still injected', window.LostCityNative?.settings?.testCounter === 42);
    const s = await debug('keyboard-state');
    check('crash: keyboard state reset', s.requested === false && s.isFirstResponder === true, JSON.stringify(s));
    localStorage.lcPhase = 'done';
    native({ type: 'fatal', message: 'Test fatal error: the engine exited with code 1. (This is a test of the native fatal alert.)' });
    await sleep(1500);
    marker('SHOT fatal');
    await sleep(1500);
    // Third WebContent death within 2 minutes: native must stop auto-restarting and show
    // "tap to try again" (the fatal alert above belongs to this page and must go away with it).
    finish(false);
    await sleep(300);
    marker('ACTION kill-webcontent-loop');
}

// Real hardware keys, typed into the Simulator window by drive-hw.mjs (System Events keystrokes).
async function phaseHardwareKeys() {
    const seen = () => events.map((e) => e.join(':')).join(' ');
    const pressed = (k) => events.some((e) => e[0] === 'pressKey' && e[1] === k && e[2] === true) &&
        events.some((e) => e[0] === 'pressKey' && e[1] === k && e[2] === false);
    events.length = 0;
    let s = await debug('keyboard-state');
    info(`hwkeys: idle state ${JSON.stringify(s)}`);
    marker('HWKEYS idle');  // drive-hw types: a b ← Esc F1 ⌫ ↩ ⇥
    await until(() => events.some((e) => e[0] === 'pressKey' && e[1] === 'Tab' && e[2] === false), 30000);
    await sleep(600);
    info(`idle events: ${seen()}`);
    check('hw idle: characters arrive via insertText', events.filter((e) => e[0] === 'insertText').map((e) => e[1]).join('') === 'ab', seen());
    check('hw idle: ← Esc F1 ⌫ ↩ ⇥ arrive via pressKey down+up', ['ArrowLeft', 'Escape', 'F1', 'Backspace', 'Enter', 'Tab'].every(pressed), seen());
    check('hw idle: no duplicate deleteBackward/submit', !events.some((e) => e[0] === 'deleteBackward' || e[0] === 'submit'), seen());

    events.length = 0;
    kbd.prompt = 'Public chat'; kbd.text = '';
    native({ type: 'keyboard', action: 'show', kind: 'chat', prompt: 'Public chat', text: '', secure: false, numeric: false });
    await sleep(1500);
    s = await debug('keyboard-state');
    info(`hwkeys: shown state ${JSON.stringify(s)}`);
    marker('HWKEYS shown');  // drive-hw types: c d ⌫ ↩
    await until(() => events.some((e) => e[0] === 'pressKey' && e[1] === 'Enter' && e[2] === false), 30000);
    await sleep(400);
    marker('SHOT hw-bar');
    await sleep(1200);
    info(`shown events: ${seen()}`);
    check('hw shown: characters via insertText', events.filter((e) => e[0] === 'insertText').map((e) => e[1]).join('') === 'cd', seen());
    check('hw shown: ⌫ ↩ via pressKey', ['Backspace', 'Enter'].every(pressed) && !events.some((e) => e[0] === 'deleteBackward' || e[0] === 'submit'), seen());
    native({ type: 'keyboard', action: 'hide' });
    localStorage.lcPhase = 'done';
    finish();
}

function finish(done = true) {
    info(`TOTAL pass=${totals.pass} fail=${totals.fail}${totals.failed.length ? ' failed: ' + totals.failed.join(' | ') : ''}`);
    if (done) marker(`DONE pass=${totals.pass} fail=${totals.fail}`);
}

// ---------------------------------------------------------------------------------------------
(async () => {
    if (!localStorage.lcPhase) {
        // drive.mjs START_PHASE=… writes start-phase.txt into the test bundle.
        const r = await fetch('start-phase.txt');
        if (r.ok) localStorage.lcPhase = (await r.text()).trim();
    }
    const phase = localStorage.lcPhase || 'routes';
    if (phase === 'routes') {
        // First launch: keep the native loading cover up for a moment so it can be photographed.
        marker('SHOT loading-overlay');
        await sleep(2500);
        // The cover is the page's loader at the page's zoom (1 on an iPhone): the same sizes, centred the same way.
        // (Without the game's fonts in Game/ui the native views fall back to 12 pt system fonts.)
        const cover = (await debug('ui-state'))?.overlayLayout;
        const z = pageZoom();
        const font = (await fetch('ui/fonts/b12.ttf', { method: 'HEAD' })).ok ? 16 : 12;
        // (frames are rounded to device pixels; on Android the cover follows Chromium's layout of the page's loader, box
        // edges rounded to whole layout px (CSS px × the ratio) before the zoom: docs/ANDROID.md §4.2, so a size is off by
        // up to two of them after the zoom, under a device px or so)
        const near = (a, b) => Math.abs(a - b) < (ANDROID ? (2 * z) / devicePixelRatio : 0.01);
        const centred = (rect) => Math.abs(rect[0] + rect[2] / 2 - innerWidth / 2) < 0.5;
        check(`loading cover at the page's zoom (${z}): 444×142 logo, 304×34 bar, ${font} pt text, centred`,
            cover?.zoom === z && cover.font === font * z && near(cover.logo[2], 444 * z) && near(cover.logo[3], 142 * z) &&
            near(cover.bar[2], 304 * z) && near(cover.bar[3], 34 * z) && centred(cover.logo) && centred(cover.bar),
            `${innerWidth}x${innerHeight} ${JSON.stringify(cover)}`);
    }
    native({ type: 'ready' });
    native({ type: 'status', phase: 'booting', detail: `test phase ${phase}` });
    info(`phase ${phase}`);
    try {
        if (phase === 'routes') await phaseRoutes();
        else if (phase === 'keyboard') await phaseKeyboard();
        else if (phase === 'lm') await phaseLm();
        else if (phase === 'lm-reload') await phaseLmReload();
        else if (phase === 'lifecycle') await phaseLifecycle();
        else if (phase === 'crash-bg') await phaseCrashBackground();
        else if (phase === 'crash') await phaseCrash();
        else if (phase === 'hwkeys') await phaseHardwareKeys();
        else { localStorage.lcPhase = 'hwkeys'; location.reload(); }  // 'done': next run is drive-hw.mjs
    } catch (e) {
        check(`phase ${phase} threw`, false, e?.stack ?? String(e));
        finish();
    }
})();
