#!/usr/bin/env node
// The start-up files the engine lets go of (entry.ts releaseStartupData -> vfs.evictReloadable) are freed at once and
// nothing still holds them: the release engine.js in the Node vm sandbox (lib/vm-worker.mjs), every file boot.js
// preloads watched through a WeakRef. At 'ready', each evicted file's buffer is detached (ArrayBuffer.prototype.transfer(0):
// its bytes are gone without waiting for a collection) and, after two full GCs, none of them can be reached: so no
// reader can ever see a detached buffer. The same after ::reload, which fetches 26 of them again and lets them go again.
// Only the files the vfs keeps (not reloadable: world.json with the page's overrides) stay.
// --bots=N: the same with engine-bots.js and N bots of the real library playing (their own files, scripts.bin, are let
// go too). --no-transfer: a runtime without ArrayBuffer.prototype.transfer (an Android WebView before Chrome 114): the
// buffers are not detached, today's behaviour, and are still unreachable after a full GC; the world as before.
//
//   node --expose-gc --experimental-vm-modules web/engine/test/vfs-release.test.mjs [--no-build] [--bots=N] [--no-transfer]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { BOTS_LIB, buildEngine } from '../build.mjs';
import { makeFixture, IOS } from './lib/fixture.mjs';
import { Bot, Page, createRunner, waitFor } from './lib/session.mjs';
import { createVmWorker } from './lib/vm-worker.mjs';

if (!vm.SourceTextModule || !globalThis.gc) {
    console.error('run with: node --expose-gc --experimental-vm-modules web/engine/test/vfs-release.test.mjs');
    process.exit(2);
}
const args = process.argv.slice(2);
const BOTS = Number((args.find(a => a.startsWith('--bots=')) ?? '--bots=0').split('=')[1]);
const NO_TRANSFER = args.includes('--no-transfer');
const TMP = path.join(IOS, 'build/tmp/engine');
const OUT = path.join(TMP, BOTS ? 'out-vfs-release-bots' : 'out-release');
if (!args.includes('--no-build')) await buildEngine({ out: OUT, debug: false, bots: BOTS ? { lib: BOTS_LIB } : false });

fs.mkdirSync(TMP, { recursive: true });
const runDir = fs.mkdtempSync(path.join(TMP, 'vfs-release-'));
const worker = createVmWorker({ gameDir: OUT, documentsDir: path.join(runDir, 'Documents') });
const env = Object.assign(worker.env, { fixture: makeFixture(), config: { node: { profile: BOTS ? 'vfsrelease' : 'enginetest' }, ...(BOTS ? { bots: { count: BOTS, spawnPerTick: 5 } } : {}) }, log: line => console.log(line) });
if (NO_TRANSFER) vm.runInContext('delete ArrayBuffer.prototype.transfer', worker.ctx);

// every file boot.js (and a later re-fetch) puts in the vfs: its path and a WeakRef to its buffer; and, when the release
// takes it out, whether its buffer is detached right after the release's loop (a microtask later: the collector may take
// a buffer the release let go of before the checks below look, so this is the record that does not depend on it)
const files = [];
let store = null;
Object.defineProperty(worker.ctx, '__LC_VFS__', {
    configurable: true,
    get: () => store,
    set: value => {
        store = value;
        const set = value.files.set.bind(value.files);
        const del = value.files.delete.bind(value.files);
        value.files.set = (abs, data) => {
            files.push({ abs, bytes: data.byteLength, ref: new WeakRef(data.buffer), detachedAtRelease: null });
            return set(abs, data);
        };
        value.files.delete = abs => {
            const data = value.files.get(abs);
            const file = files.findLast(f => f.abs === abs);
            if (data && file) queueMicrotask(() => (file.detachedAtRelease = data.buffer.detached));
            return del(abs);
        };
    }
});
const collect = async () => {
    globalThis.gc();
    globalThis.gc();
    await new Promise(resolve => setTimeout(resolve, 50));
    globalThis.gc();
};

const T = createRunner(env);
await worker.boot();
const page = new Page(env, T);
page.post({ type: 'init', config: env.config });
await waitFor(env, () => page.booted || page.exits.length, 120000, 'booted');
T.check(`booted ${BOTS ? `engine-bots.js with ${BOTS} bots` : 'engine.js'}${NO_TRANSFER ? ', no ArrayBuffer.prototype.transfer' : ''}`, page.booted?.bundle === (BOTS ? 'engine-bots.js' : 'engine.js') && (page.booted?.bots ?? 0) === BOTS && vm.runInContext("typeof ArrayBuffer.prototype.transfer", worker.ctx) === (NO_TRANSFER ? 'undefined' : 'function'), page.booted && { bundle: page.booted.bundle, bots: page.booted.bots });
page.post({ type: 'start' });
await waitFor(env, () => page.ready || page.exits.length, 300000, 'ready');

// what the release let go of, and what it kept
function check(when, list) {
    const evicted = list.filter(f => !store.files.has(f.abs));
    const live = evicted.map(f => ({ f, buffer: f.ref.deref() })).filter(x => x.buffer);
    // (without transfer: none detached, as before; they wait for the collector, which may already have taken them all by
    // now, as V8 sometimes does between the release and 'ready': judged by the state right after the release, and by the
    // buffers still alive)
    const want = !NO_TRANSFER;
    const wrong = [...new Set([...evicted.filter(f => f.detachedAtRelease !== want).map(f => f.abs), ...live.filter(x => x.buffer.detached !== want).map(x => x.f.abs)])];
    T.check(`${when}: the evicted files' buffers are ${want ? 'detached' : 'not detached (no transfer)'}`, evicted.length > 0 && wrong.length === 0, {
        evicted: evicted.length,
        alive: live.length,
        MB: +(evicted.reduce((s, f) => s + f.bytes, 0) / 1048576).toFixed(1),
        wrong
    });
    return evicted;
}
const atStart = check('start', files);
await collect();
T.check('start: none of them is reachable after a full GC', atStart.every(f => !f.ref.deref()), atStart.filter(f => f.ref.deref()).map(f => f.abs));
T.check('only the files the vfs keeps stay', [...store.files.keys()].every(abs => !store.urls.has(abs)), [...store.files.keys()]);

const bot = new Bot(env, page, 'vfsrelease');
T.check('login', (await bot.login()) === 2);
bot.startKeepalive(500);
if (BOTS) {
    // the bots come in (once a human is online) and play a while on the released files
    await waitFor(env, () => env.bots.BotManager.stats().spawned >= BOTS, 20000 + BOTS * 1000, `${BOTS} bots`);
    await bot.ticks(20);
    const active = [...env.bots.BotManager.activeBots()].length;
    T.check(`the ${BOTS} bots are in and play for 20 ticks`, active === BOTS && !bot.desync, { active, stats: env.bots.BotManager.stats() });
}
const before = files.length;
bot.cheat('reload');
T.check('::reload works on the released files', !!(await bot.message(/^Loaded \d+ scripts\.$/, 120000)));
await bot.ticks(2); // (the reload's release follows its last load)
const again = check('::reload', files.slice(before));
await bot.ticks(3);
await collect();
T.check('::reload: none of them is reachable after a full GC', again.every(f => !f.ref.deref()), again.filter(f => f.ref.deref()).map(f => f.abs));
T.check('the world still ticks and talks', !bot.desync && bot.count('PLAYER_INFO') > 0, { desync: bot.desync });

const result = T.result(page);
fs.rmSync(runDir, { recursive: true, force: true });
console.log(`[vfs-release] ${result.ok ? 'PASS' : 'FAIL'}: ${result.passed} checks passed, ${result.failed} failed (${result.seconds} s)`);
process.exit(result.ok ? 0 : 1);
