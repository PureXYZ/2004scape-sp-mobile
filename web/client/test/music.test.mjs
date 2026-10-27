#!/usr/bin/env node
// Client patch 0034 (music renders ahead only while it is needed): the patched src/3rdparty/tinymidipcm.js as shipped
// against the same module with its render-ahead limit off (renderAheadLow/High = Infinity: each song rendered whole as
// soon as it starts, as before the patch), each run in its own vm context on a deterministic clock (timers,
// AudioContext.currentTime in 128-frame quanta, sources ending at their end time and firing 'ended') with the real
// tinymidipcm.wasm and soundfont, through the same scripted and seeded random sequences of the client's calls (playMidi
// with and without fade, stopMidi, setMidiVolume: song changes, songs played to their end and looping, Music off and on,
// jingles, logout and login). Compared by what is audible, as the buffers' boundaries differ: every source's samples
// placed at its start frame and cut at its stop, merged into contiguous runs, each run's frames and both channels'
// sha256; and every call and gain automation call, in order. They must be identical, and the AudioBuffers the module
// holds (read every 10 s after a GC) must stay small with the limit (about 25 s of music) where without it they reach
// whole songs. Last, the fresh synth: a song started right after another one was stopped mid-way sounds as it does on
// its own.
//   node --expose-gc web/client/test/music.test.mjs [--seeds 2] [--minutes 15] [--no-build]
// (builds the release client into a temp folder first: its patched tree, build/tmp/client/work-release)
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { buildClient } from '../build.mjs';
import { UPSTREAM_DIR } from '../../../scripts/lib/upstream.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IOS = path.resolve(HERE, '../../..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const SEEDS = Number(opt('seeds', 2));
const MINUTES = Number(opt('minutes', 15));
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-music-test-'));
if (!argv.includes('--no-build')) await buildClient({ out: OUT_DIR, log: () => {} });
const TREE = path.join(IOS, 'build/tmp/client/work-release');
const GAME_CLIENT = argv.includes('--no-build') ? path.join(IOS, 'build/Game/client') : path.join(OUT_DIR, 'client');
const PATCHED = path.join(TREE, 'src/3rdparty/tinymidipcm.js');
const shipped = fs.readFileSync(PATCHED, 'utf8');
const unlimited = shipped.replace(/const renderAheadLow = \d+;/, 'const renderAheadLow = Infinity;').replace(/const renderAheadHigh = \d+;/, 'const renderAheadHigh = Infinity;');
if (unlimited === shipped || !/renderAheadHigh = Infinity/.test(unlimited)) throw new Error('tinymidipcm.js: no renderAheadLow / renderAheadHigh to turn off (patch 0034)');
const UNLIMITED = path.join(OUT_DIR, 'tinymidipcm-unlimited.js');
fs.writeFileSync(UNLIMITED, unlimited);
const WASM_LOADER = path.join(TREE, 'src/3rdparty/tinymidipcm/tinymidipcm.mjs');
const PACK = path.join(UPSTREAM_DIR, 'engine/data/pack');

const require = createRequire(path.join(IOS, 'web/package.json'));
const { gunzipSync } = require('fflate');
const dat = fs.readFileSync(path.join(PACK, 'main_file_cache.dat'));
const idx3 = fs.readFileSync(path.join(PACK, 'main_file_cache.idx3'));
function midi(file) {
    const p = file * 6;
    const size = (idx3[p] << 16) | (idx3[p + 1] << 8) | idx3[p + 2];
    let sector = (idx3[p + 3] << 16) | (idx3[p + 4] << 8) | idx3[p + 5];
    const out = new Uint8Array(size);
    let pos = 0;
    while (pos < size && sector) {
        const s = sector * 520;
        const n = Math.min(512, size - pos);
        out.set(dat.subarray(s + 8, s + 8 + n), pos);
        pos += n;
        sector = (dat[s + 4] << 16) | (dat[s + 5] << 8) | dat[s + 6];
    }
    return gunzipSync(out.subarray(0, out.length - 2));
}
const wasmBinary = fs.readFileSync(path.join(GAME_CLIENT, 'tinymidipcm.wasm'));
const sf2 = new Uint8Array(fs.readFileSync(path.join(GAME_CLIENT, 'SCC1_Florestan.sf2')));
const { default: loadTiny } = await import(WASM_LOADER);
const UPSTREAM = UNLIMITED;

const SONGS = Array.from({ length: 345 }, (_, i) => i).filter(i => {
    try {
        return midi(i).length > 0;
    } catch {
        return false;
    }
});

// ---- a deterministic page: timers, an AudioContext, fetch
function makePage(label) {
    let now = 0; // ms
    let seq = 0;
    const queue = []; // {at, seq, fn, id, interval}
    const cancelled = new Set();
    const log = [];
    const RATE = 22050;
    const QUANTUM = 128 / RATE;
    const currentTime = () => Math.floor(now / 1000 / QUANTUM) * QUANTUM;
    const schedule = (at, fn, id, interval) => {
        queue.push({ at, seq: seq++, fn, id, interval });
    };
    let timerId = 0;
    const setTimeoutF = (fn, ms = 0) => {
        const id = ++timerId;
        schedule(now + Math.max(0, Number(ms) || 0), fn, id, 0);
        return id;
    };
    const setIntervalF = (fn, ms = 0) => {
        const id = ++timerId;
        schedule(now + Math.max(1, Number(ms) || 0), fn, id, Math.max(1, Number(ms) || 0));
        return id;
    };
    const clearF = id => {
        if (id !== undefined && id !== null) {
            cancelled.add(id);
        }
    };
    // gain: automation events, value = the last event at or before now
    function param(initial) {
        const events = [];
        let base = initial;
        return {
            setValueAtTime(v, t) {
                log.push(['gain.set', v, +t.toFixed(9)]);
                events.push({ v, t, seq: seq++ });
            },
            cancelScheduledValues(t) {
                log.push(['gain.cancel', +t.toFixed(9)]);
                for (let i = events.length - 1; i >= 0; i--) {
                    if (events[i].t >= t) {
                        events.splice(i, 1);
                    }
                }
            },
            get value() {
                const t = currentTime();
                let v = base;
                let best = -Infinity;
                for (const e of events) {
                    if (e.t <= t && e.t >= best) {
                        best = e.t;
                        v = e.v;
                    }
                }
                log.push(['gain.value', v]);
                return v;
            },
            set value(v) {
                base = v;
                log.push(['gain.value=', v]);
            }
        };
    }
    let sourceId = 0;
    const live = new Set(); // sources started and not ended
    const sources = []; // mem-cuts: {s, n, data, cut} per started source
    // memory: bytes of new Float32Array(n) / Uint8Array(n) the module makes (garbage), and the AudioBuffers still
    // reachable (WeakRefs, read after a forced GC: the harness drops a source once it has ended, so only the module can
    // keep one)
    const mem = { allocated: 0, buffers: [] };
    class CountingF32 extends Float32Array {
        constructor(a, b, c) {
            super(a, b, c);
            if (typeof a === 'number') {
                mem.allocated += a * 4;
            }
        }
    }
    class CountingU8 extends Uint8Array {
        constructor(a, b, c) {
            super(a, b, c);
            if (typeof a === 'number') {
                mem.allocated += a;
            }
        }
    }
    const audioContext = {
        sampleRate: RATE,
        get currentTime() {
            return currentTime();
        },
        destination: { connect() {} },
        createGain() {
            return { gain: param(1), connect() {} };
        },
        createBuffer(channels, length, sampleRate) {
            const data = Array.from({ length: channels }, () => new Float32Array(length));
            const buffer = { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: c => data[c], __data: data };
            mem.buffers.push({ ref: new WeakRef(buffer), bytes: channels * length * 4 });
            return buffer;
        },
        createBufferSource() {
            const src = {
                id: ++sourceId,
                buffer: null,
                onended: null,
                ended: false,
                endAt: Infinity,
                connect() {},
                start(when = 0) {
                    log.push(['start', this.id, this.buffer.length]);
                    const t0 = Math.max(when, currentTime());
                    this.seg = { s: Math.round(t0 * RATE), n: this.buffer.length, data: this.buffer.__data, cut: Infinity };
                    sources.push(this.seg);
                    this.endAt = t0 + this.buffer.duration;
                    live.add(this);
                    schedule(this.endAt * 1000, () => end(this), null, 0);
                },
                stop(when = 0) {
                    log.push(['stop', this.id, +when.toFixed(9), this.ended ? 'ended' : 'playing']);
                    if (!this.ended) {
                        const t = Math.max(when, currentTime());
                        this.seg.cut = Math.min(this.seg.cut, Math.round(t * RATE));
                        if (t < this.endAt) {
                            this.endAt = t;
                            schedule(t * 1000, () => end(this), null, 0);
                        }
                    }
                }
            };
            return src;
        }
    };
    function end(src) {
        if (src.ended) {
            return; // (the first end event of a source stopped before its end)
        }
        src.ended = true;
        live.delete(src);
        if (typeof src.onended === 'function') {
            src.onended({ target: src });
        }
    }
    const context = {
        console,
        Math,
        Float32Array: CountingF32,
        Uint8Array: CountingU8,
        Int32Array,
        URL,
        Promise,
        setTimeout: setTimeoutF,
        setInterval: setIntervalF,
        clearTimeout: clearF,
        clearInterval: clearF,
        fetch: async () => ({ arrayBuffer: async () => sf2.slice().buffer }),
        audioContext,
        __loadTiny: () => loadTiny({ wasmBinary })
    };
    context.window = context;
    vm.createContext(context);
    // run due timers up to `until` (ms), in time order
    function advance(until) {
        for (;;) {
            let best = -1;
            for (let i = 0; i < queue.length; i++) {
                const q = queue[i];
                if (q.at <= until && (best < 0 || q.at < queue[best].at || (q.at === queue[best].at && q.seq < queue[best].seq))) {
                    best = i;
                }
            }
            if (best < 0) {
                break;
            }
            const q = queue.splice(best, 1)[0];
            if (q.id !== null && cancelled.has(q.id)) {
                continue;
            }
            now = Math.max(now, q.at);
            if (q.interval) {
                schedule(q.at + q.interval, q.fn, q.id, q.interval);
            }
            q.fn();
        }
        now = Math.max(now, until);
    }
    // the bytes of AudioBuffers still reachable (after the job, as a WeakRef keeps its target until then)
    async function held() {
        await new Promise(resolve => setImmediate(resolve));
        globalThis.gc();
        let bytes = 0;
        mem.buffers = mem.buffers.filter(b => b.ref.deref());
        for (const b of mem.buffers) {
            bytes += b.bytes;
        }
        return bytes;
    }
    return { label, context, log, advance, get now() { return now; }, live, mem, held, sources };
}

async function load(page, file) {
    let src = fs.readFileSync(file, 'utf8');
    src = src.replace(/^import loadTinyMidiPCM from '#3rdparty\/tinymidipcm\/tinymidipcm\.mjs';$/m, 'const loadTinyMidiPCM = __loadTiny;');
    src = src.replaceAll('import.meta.url', "'http://local/client/tinymidipcm.js'");
    src = src.replace(/^export function /gm, 'function ');
    src += '\nwindow.__api = { playMidi, setMidiVolume, stopMidi };\n';
    vm.runInContext(src, page.context, { filename: path.basename(file) });
    for (let i = 0; i < 400 && !page.context._tinyMidiPlay; i++) {
        await new Promise(r => setTimeout(r, 10));
    }
    if (!page.context._tinyMidiPlay) {
        throw new Error(`${file}: not initialised`);
    }
}

function scripted() {
    // [delay ms before, call, args]
    const ops = [];
    const at = (ms, call, ...args) => ops.push([ms, call, args]);
    at(0, 'play', 0, 0, true); // the title song
    at(260000, 'play', 1, 0, true); // after it has ended
    at(20000, 'play', 2, -4, true); // a song change, fading
    at(3000, 'volume', -8);
    at(5000, 'stop'); // Music off, the render loop still going
    at(4000, 'play', 2, -8, true); // Music on
    at(2000, 'play', 3, -8, false); // a jingle
    at(9000, 'play', 2, -8, true); // the song again after the jingle
    at(30000, 'stop'); // logout
    at(1000, 'play', 0, 0, true); // title
    at(15000, 'play', 4, 0, true); // login, the area's song
    at(200000, 'volume', -12);
    at(100000, 'play', 5, -12, true);
    at(1500, 'play', 6, -12, true); // a quick second change during the fade
    at(400000, 'stop');
    return ops;
}

function random(seed, minutes) {
    let s = seed >>> 0;
    const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296;
    const ops = [];
    let t = 0;
    const end = minutes * 60000;
    ops.push([0, 'play', SONGS[Math.floor(rnd() * SONGS.length)], 0, true]);
    while (t < end) {
        const r = rnd();
        const gap = r < 0.3 ? Math.floor(rnd() * 3000) : r < 0.7 ? Math.floor(rnd() * 30000) : Math.floor(rnd() * 240000);
        t += gap;
        const k = rnd();
        const song = SONGS[Math.floor(rnd() * SONGS.length)];
        const vol = [0, -4, -8, -12][Math.floor(rnd() * 4)];
        if (k < 0.45) {
            ops.push([gap, 'play', song, vol, true]);
        } else if (k < 0.6) {
            ops.push([gap, 'play', song, vol, false]);
        } else if (k < 0.75) {
            ops.push([gap, 'stop']);
        } else if (k < 0.85) {
            ops.push([gap, 'volume', vol]);
        } else {
            ops.push([gap, 'play', song, vol, true]);
            ops.push([Math.floor(rnd() * 800), 'stop']);
        }
    }
    ops.push([300000, 'stop']);
    return ops;
}

async function run(name, ops) {
    const pages = [makePage('upstream'), makePage('patched')];
    await load(pages[0], UPSTREAM);
    await load(pages[1], PATCHED);
    for (const [delay, call, ...args] of ops.map(o => [o[0], o[1], ...(Array.isArray(o[2]) ? o[2] : o.slice(2))])) {
        for (let k = 0; k < 2; k++) {
            const p = pages[k];
            // advance in 1 s steps, sampling what each holds
            const until = p.now + delay;
            while (p.now < until) {
                p.advance(Math.min(until, p.now + 1000));
                if (p.now >= (p.nextHeld ??= 10000)) {
                    p.nextHeld += 10000;
                    (p.heldSamples ??= []).push(await p.held());
                }
            }
            p.log.push(['call', call, ...args]);
            if (call === 'play') {
                p.context.__api.playMidi(midi(args[0]), args[1], args[2]);
            } else if (call === 'stop') {
                p.context.__api.stopMidi(false);
            } else {
                p.context.__api.setMidiVolume(args[0]);
            }
            p.advance(p.now);
        }
    }
    // compare what is audible: segments [s, min(s + n, cut)) merged into contiguous runs, each hashed
    function runs(p) {
        const segs = p.sources.map(x => ({ ...x, e: Math.min(x.s + x.n, x.cut) })).filter(x => x.e > x.s).sort((a, b) => a.s - b.s);
        const out = [];
        let cur = null;
        let overlaps = 0;
        for (const g of segs) {
            if (cur && g.s < cur.e) overlaps++;
            if (!cur || g.s !== cur.e) {
                if (cur) out.push([cur.s, cur.e, ...cur.h.map(h => h.digest('hex').slice(0, 16))]);
                cur = { s: g.s, e: g.s, h: g.data.map(() => crypto.createHash('sha256')) };
            }
            const len = g.e - g.s;
            g.data.forEach((ch, c) => cur.h[c].update(new Uint8Array(ch.buffer, ch.byteOffset, len * 4)));
            cur.e = g.e;
        }
        if (cur) out.push([cur.s, cur.e, ...cur.h.map(h => h.digest('hex').slice(0, 16))]);
        return { out, overlaps };
    }
    const A = runs(pages[0]);
    const B = runs(pages[1]);
    // where runs differ: the audible frames of both, compared sample by sample (--diff)
    function frames(p, s0, e0) {
        const out = [new Float32Array(e0 - s0), new Float32Array(e0 - s0)];
        for (const x of p.sources) {
            const e = Math.min(x.s + x.n, x.cut);
            const a = Math.max(x.s, s0), b = Math.min(e, e0);
            if (b <= a) continue;
            x.data.forEach((ch, c) => out[c].set(ch.subarray(a - x.s, b - x.s), a - s0));
        }
        return out;
    }
    const diffs = [];
    if (argv.includes('--diff')) {
        for (let i = 0; i < Math.min(A.out.length, B.out.length); i++) {
            const [s0, e0] = A.out[i];
            if (JSON.stringify(A.out[i]) === JSON.stringify(B.out[i]) || B.out[i][0] !== s0 || B.out[i][1] !== e0) continue;
            const fa = frames(pages[0], s0, e0), fb = frames(pages[1], s0, e0);
            let first = -1, last = -1, maxd = 0, n = 0, peak = 0;
            for (let c = 0; c < 2; c++) for (let k = 0; k < e0 - s0; k++) {
                peak = Math.max(peak, Math.abs(fa[c][k]));
                const d = Math.abs(fa[c][k] - fb[c][k]);
                if (d > 0) { n++; if (first < 0 || k < first) first = k; if (k > last) last = k; if (d > maxd) maxd = d; }
            }
            diffs.push({ run: i, startSec: +(s0 / 22050).toFixed(2), lenSec: +((e0 - s0) / 22050).toFixed(2), differingSamples: n, firstMs: +(first / 22.05).toFixed(1), lastMs: +(last / 22.05).toFixed(1), maxAbsDiff: +maxd.toExponential(2), maxDiffDb: maxd > 0 && peak > 0 ? +(20 * Math.log10(maxd / peak)).toFixed(1) : null, runPeak: +peak.toFixed(3) });
        }
    }
    // the calls and the gain automation, in order (sources' start/stop differ in number: boundaries)
    const ctl = log => log.filter(e => e[0] === 'call' || e[0].startsWith('gain')).map(e => JSON.stringify(e));
    const ca = ctl(pages[0].log);
    const cb = ctl(pages[1].log);
    let ctlDiff = -1;
    for (let i = 0; i < Math.max(ca.length, cb.length); i++) if (ca[i] !== cb[i]) { ctlDiff = i; break; }
    let runDiff = -1;
    for (let i = 0; i < Math.max(A.out.length, B.out.length); i++) if (JSON.stringify(A.out[i]) !== JSON.stringify(B.out[i])) { runDiff = i; break; }
    const count = (log, k) => log.filter(e => e[0] === k).length;
    const r = {
        name,
        ops: ops.length,
        simulatedMinutes: +(pages[0].now / 60000).toFixed(1),
        buffersStarted: [count(pages[0].log, 'start'), count(pages[1].log, 'start')],
        audibleRuns: A.out.length,
        audibleSeconds: +(A.out.reduce((x, q) => x + q[1] - q[0], 0) / 22050).toFixed(1),
        overlaps: [A.overlaps, B.overlaps],
        controlCalls: ca.length,
        identical: runDiff < 0 && ctlDiff < 0,
        allocatedMB: pages.map(q => +(q.mem.allocated / 1e6).toFixed(1)),
        heldMeanMB: pages.map(q => +((q.heldSamples ?? [0]).reduce((x, y) => x + y, 0) / (q.heldSamples ?? [0]).length / 1e6).toFixed(1)),
        heldPeakMB: pages.map(q => +(Math.max(0, ...(q.heldSamples ?? [0])) / 1e6).toFixed(1)),
        diffs,
        firstRunDiff: runDiff < 0 ? null : { at: runDiff, before: A.out[runDiff], after: B.out[runDiff] },
        firstControlDiff: ctlDiff < 0 ? null : { at: ctlDiff, before: ca[ctlDiff], after: cb[ctlDiff] }
    };
    return r;
}

let failed = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok) failed++;
};
const results = [await run('scripted', scripted())];
for (let seed = 1; seed <= SEEDS; seed++) {
    results.push(await run(`random-${seed}`, random(seed * 7919, MINUTES)));
}
for (const r of results) {
    check(`music ${r.name}: the same audible samples with and without the render-ahead limit (${r.audibleRuns} runs, ${r.audibleSeconds} s; ${r.controlCalls} calls and gain changes)`, r.identical, r.identical ? '' : JSON.stringify(r.firstRunDiff ?? r.firstControlDiff));
    check(`music ${r.name}: the AudioBuffers held stay under 12 MB with the limit (peak ${r.heldPeakMB[1]}, mean ${r.heldMeanMB[1]}), a third or less of what whole songs take without it (peak ${r.heldPeakMB[0]}, mean ${r.heldMeanMB[0]})`, r.heldPeakMB[1] < 12 && r.heldPeakMB[0] > 3 * r.heldPeakMB[1], '');
}
// the fresh synth: SONGS[1] on its own, and right after SONGS[0] was stopped 5 s in (its render mid-way)
async function alone(ops) {
    const p = makePage('fresh');
    await load(p, PATCHED);
    let first = 0;
    for (const [delay, call, ...args] of ops) {
        p.advance(p.now + delay);
        first = p.sources.length; // (the last call's song: the sources started from here on)
        if (call === 'play') p.context.__api.playMidi(midi(args[0]), args[1], args[2]);
        else p.context.__api.stopMidi(false);
        p.advance(p.now);
    }
    p.advance(p.now + 15000);
    const h = [crypto.createHash('sha256'), crypto.createHash('sha256')];
    let n = 0;
    for (const x of p.sources.slice(first)) {
        const len = Math.min(Math.min(x.n, x.cut - x.s), 220500 - n);
        if (len <= 0) break;
        x.data.forEach((ch, c) => h[c].update(new Uint8Array(ch.buffer, ch.byteOffset, len * 4)));
        n += len;
    }
    return { frames: n, hash: h.map(x => x.digest('hex').slice(0, 16)).join('/') };
}
const a = await alone([[0, 'play', SONGS[1], 0, false]]);
const b = await alone([[0, 'play', SONGS[0], 0, false], [5000, 'stop'], [0, 'play', SONGS[1], 0, false]]);
check('music: a song started right after another was stopped mid-way sounds as it does on its own (its first 10 s; a fresh synth)', a.frames === 220500 && a.hash === b.hash, JSON.stringify({ alone: a, after: b }));
fs.rmSync(OUT_DIR, { recursive: true, force: true });
console.log(failed ? `${failed} FAILED` : 'music: all passed');
process.exit(failed ? 1 : 0);
