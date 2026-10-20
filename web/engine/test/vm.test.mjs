#!/usr/bin/env node
// Test (a): the engine worker in a Node `vm` context that has only web-platform globals (no process, Buffer,
// require, setImmediate...), driven through the real page protocol by test/lib/session.mjs.
//
//   node --expose-gc --experimental-vm-modules web/engine/test/vm.test.mjs [--debug] [--no-build] [--verbose]
//        [--measure [--no-flat-strings] [--no-release]]     boot + start only, report heap and tick timings
//        [--soak=N]                                          one player online for N ticks at 20 ms: heap growth
//        [--player]                                          a normal player (staffModLevel 0, Settings › World ›
//                                                            Jmod Off): staff byte 0, :: commands do nothing
//
// Plays the roles of the WKWebView pieces: boot.js is loaded as a module "worker" from lostcity://game/engine/,
// its fetch() and synchronous XMLHttpRequest are served from the build output and a temp Documents folder (the
// scheme handler), and messages cross a structuredClone+transfer boundary like worker.postMessage.
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';

import { buildEngine } from '../build.mjs';
import { makeFixture, IOS } from './lib/fixture.mjs';
import { runPlayerSession, runSession, runSoak } from './lib/session.mjs';
import { createVmWorker } from './lib/vm-worker.mjs';

const args = process.argv.slice(2);
const DEBUG = args.includes('--debug');
const MEASURE = args.includes('--measure');
const VERBOSE = args.includes('--verbose');
const PLAYER = args.includes('--player');
const TMP = path.join(IOS, 'build/tmp/engine');
const OUT = path.join(TMP, DEBUG ? 'out-debug' : 'out-release');

if (!vm.SourceTextModule) {
    console.error('run with: node --expose-gc --experimental-vm-modules web/engine/test/vm.test.mjs');
    process.exit(2);
}
const gc = () => {
    globalThis.gc?.();
    globalThis.gc?.();
};
const mb = n => +(n / 1048576).toFixed(1);

if (!args.includes('--no-build')) {
    // the vanilla engine.js (the bots bundle has its own test, test/bots.test.mjs)
    const info = await buildEngine({ out: OUT, debug: DEBUG, bots: false });
    console.log(`[vm] built ${DEBUG ? 'debug' : 'release'} engine into ${path.relative(IOS, OUT)} (${(info.bundle.bytes / 1024).toFixed(0)} KB bundle, ${info.data.files} data files)`);
}

fs.mkdirSync(TMP, { recursive: true });
const runDir = fs.mkdtempSync(path.join(TMP, 'vm-run-'));
const fixture = makeFixture();
const testOptions =
    args.includes('--no-flat-strings') || args.includes('--no-release') || args.includes('--no-wasm')
        ? { flatStrings: !args.includes('--no-flat-strings'), release: !args.includes('--no-release'), wasmBzip2: !args.includes('--no-wasm') }
        : null;
const worker = createVmWorker({ gameDir: OUT, documentsDir: path.join(runDir, 'Documents'), testOptions });
const native = worker.native;

gc();
const heap0 = process.memoryUsage().heapUsed;
const pageEnv = Object.assign(worker.env, {
    verbose: VERBOSE,
    fixture,
    // (--player: Settings › World › Jmod Off)
    config: { node: { profile: 'enginetest' }, ...(PLAYER ? { staffModLevel: 0 } : {}) },
    earlyStart: DEBUG // the debug run also covers 'start' sent before 'booted' (queued by boot.js)
});

await worker.boot();

const SOAK = Number((args.find(a => a.startsWith('--soak=')) ?? '--soak=0').split('=')[1]);
if (SOAK) {
    const res = await runSoak(pageEnv, SOAK, () => {
        gc();
        return mb(process.memoryUsage().heapUsed);
    });
    console.log('[vm] SOAK ' + JSON.stringify(res));
    fs.rmSync(runDir, { recursive: true, force: true });
    const first = res.samples[1] ?? res.samples[0];
    const last = res.samples[res.samples.length - 1];
    const ok = last.connected && !res.desync && last.heapMB - first.heapMB < 10;
    console.log(`[vm] soak ${ok ? 'PASS' : 'FAIL'}: heap ${first.heapMB} -> ${last.heapMB} MB over ${last.tick} ticks`);
    process.exit(ok ? 0 : 1);
}

if (MEASURE) {
    // boot + start only; heap after GC, tick timings
    const msgs = [];
    pageEnv.onMessage(m => msgs.push(m));
    pageEnv.onMessage(m => m.type === 'log' && (VERBOSE || m.level === 'error' || m.level === 'warn') && console.log(`  [worker ${m.level}] ${m.text.split('\n')[0]}`));
    const until = async (type, ms) => {
        const end = Date.now() + ms;
        while (!msgs.some(m => m.type === type)) {
            if (Date.now() > end || msgs.some(m => m.type === 'exit')) throw new Error(`no ${type}`);
            await pageEnv.sleep(10);
        }
        return msgs.find(m => m.type === type);
    };
    pageEnv.post({ type: 'init', config: {} });
    const booted = await until('booted', 60000);
    gc();
    const heapBooted = process.memoryUsage().heapUsed;
    pageEnv.post({ type: 'start' });
    const ready = await until('ready', 120000);
    const H = pageEnv.hooks;
    // let it tick for a while with nobody online
    H.World.tickRate = 600;
    await pageEnv.sleep(6000);
    gc();
    const mem = process.memoryUsage();
    const hs = v8.getHeapStatistics();
    const res = {
        runtime: `Node ${process.version} vm (V8 ${process.versions.v8})`,
        build: DEBUG ? 'debug' : 'release',
        options: { flatStrings: H.testOptions.flatStrings !== false, release: H.testOptions.release !== false, wasmBzip2: H.testOptions.wasmBzip2 !== false },
        bootedMs: { preload: Math.round(booted.preloadMs), eval: Math.round(booted.evalMs) },
        startMs: Math.round(ready.ms),
        heapUsedMB: { baseline: mb(heap0), afterBoot: mb(heapBooted), afterStartGC: mb(mem.heapUsed), engine: mb(mem.heapUsed - heap0) },
        externalMB: mb(mem.external),
        arrayBuffersMB: mb(mem.arrayBuffers),
        totalHeapMB: mb(hs.total_heap_size),
        vfs: H.vfs.stats(),
        bzip2: H.bzip2.kind,
        ticks: H.ticker.tickSummary()
    };
    console.log('[vm] MEASURE ' + JSON.stringify(res));
    fs.writeFileSync(path.join(TMP, `vm-measure${H.testOptions.flatStrings === false ? '-noflat' : ''}${H.testOptions.release === false ? '-norelease' : ''}.json`), JSON.stringify(res, null, 2));
    fs.rmSync(runDir, { recursive: true, force: true });
    process.exit(0);
}

const result = PLAYER ? await runPlayerSession(pageEnv) : await runSession(pageEnv);

// the staged file set must be exactly what the engine read (the full session, which covers ::reload)
if (!PLAYER) {
    const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'engine/vfs-manifest.json'), 'utf8')).map(([p]) => p);
    const accessed = new Set(result.metrics.vfsAccessed ?? []);
    const unused = manifest.filter(p => !accessed.has(p));
    console.log(`\n[vm] staged files: ${manifest.length}, accessed by the engine: ${manifest.length - unused.length}${unused.length ? `, never read: ${unused.join(', ')}` : ''}`);
    if (unused.length) {
        result.ok = false;
        result.failed++;
    }
}
console.log(`[vm] PUT body kinds seen by the fake scheme handler: ${[...native.bodyKinds].join(', ')}`);
if ([...native.bodyKinds].some(k => k !== 'ArrayBuffer')) {
    result.ok = false;
    result.failed++;
}
gc();
result.heapUsedMB = mb(process.memoryUsage().heapUsed);
fs.writeFileSync(path.join(TMP, `vm-result-${PLAYER ? 'player' : DEBUG ? 'debug' : 'release'}.json`), JSON.stringify(result, null, 2));
console.log(`\n[vm] ${result.ok ? 'PASS' : 'FAIL'}: ${result.passed} checks passed, ${result.failed} failed (${result.seconds} s)`);
fs.rmSync(runDir, { recursive: true, force: true });
process.exit(result.ok ? 0 : 1);
