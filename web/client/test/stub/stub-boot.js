// Boot sequence of the test stub page (mirrors ARCHITECTURE.md §4/§6): start the engine worker (mode=engine),
// load the shared cache into globalThis.__LC_CACHE__, then import client/client.js and create the client.
const params = new URLSearchParams(location.search);
const T = window.__lcTest;
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);

function bootEngine() {
    // engineLayout=old: the engine-compat bundle (engine/engine-boot.js, bundle chosen by the worker name);
    // engineLayout=new: ARCHITECTURE.md §2 (engine/boot.js). Both take {type:'init'} -> booted, {type:'start'} -> ready.
    const layout = params.get('engineLayout') ?? 'old';
    const worker =
        layout === 'new'
            ? new Worker('engine/boot.js', { type: 'module' })
            : new Worker('engine/engine-boot.js', { type: 'module', name: params.get('engineBundle') ?? 'engine-auto.min.js' });
    const ready = new Promise((resolve, reject) => {
        worker.addEventListener('message', ({ data: m }) => {
            if (m?.type === 'booted') {
                T.rec('engine-booted', { ms: ms(), preloadMs: Math.round(m.preloadMs ?? 0), evalMs: Math.round(m.evalMs ?? 0) });
                worker.postMessage({ type: 'start' });
            } else if (m?.type === 'ready') {
                T.rec('engine-ready', { ms: ms(), startMs: Math.round(m.ms ?? 0) });
                resolve();
            } else if (m?.type === 'exit') {
                reject(new Error(`engine exited (${m.code})`));
            }
        });
        worker.addEventListener('error', e => {
            T.rec('engine-error', { message: e.message });
            reject(new Error(e.message || 'engine worker error'));
        });
    });
    ready.catch(() => {}); // surfaced through the socket / the harness timeline
    T.attachEngine(worker, ready);
    worker.postMessage({ type: 'init', saves: [], config: {} });
}

async function loadCache() {
    const names = ['main_file_cache.dat', 'main_file_cache.idx0', 'main_file_cache.idx1', 'main_file_cache.idx2', 'main_file_cache.idx3', 'main_file_cache.idx4'];
    const bufs = await Promise.all(
        names.map(async n => {
            const r = await fetch(`cache/${n}`);
            if (!r.ok) {
                throw new Error(`cache/${n}: HTTP ${r.status}`);
            }
            return r.arrayBuffer();
        })
    );
    globalThis.__LC_CACHE__ = { dat: new Uint8Array(bufs[0]), idx: bufs.slice(1).map(b => new Uint8Array(b)) };
    T.rec('cache-loaded', { ms: ms(), bytes: bufs.reduce((n, b) => n + b.byteLength, 0) });
}

// Records every click the client registers: each tap/long-press/drag start assigns nextMouseClickButton (1 or 2)
// after nextMouseClickX/Y. Property names survive esbuild, so this works on release builds too.
function spyClicks(client) {
    let value = client.nextMouseClickButton;
    Object.defineProperty(client, 'nextMouseClickButton', {
        configurable: true,
        enumerable: true,
        get: () => value,
        set: v => {
            value = v;
            if (v) {
                T.rec('click', { button: v, x: client.nextMouseClickX, y: client.nextMouseClickY });
            }
        }
    });
}

if ((params.get('mode') ?? 'engine') === 'engine') {
    bootEngine();
}
await loadCache();
const { Client } = await import('../client/client.js');
T.rec('client-imported', { ms: ms() });
const client = new Client(10, 0, true);
window.__client = client;
spyClicks(client);
