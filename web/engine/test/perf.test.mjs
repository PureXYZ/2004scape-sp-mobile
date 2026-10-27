#!/usr/bin/env node
// The test build's measurements (src/autotest: app-test --soak, docs/BUILDING.md §4) in the Node vm sandbox, through the
// real page protocol.
//
//   node --expose-gc --experimental-vm-modules web/engine/test/perf.test.mjs [--no-build] [--verbose]
//
//  1. build: a test build (autotest) of both bundles, with the stub bot library; each answers 'lctest-perf', and a
//     normal build of the same sources never names it (build.mjs checks both ways; checked again here).
//  2. engine.js (no bots), each in a fresh process: the start-up's marks in order (the engine evaluated, World.start
//     begun and done, the first tick, 'ready' sent); every tick from 0 with its start, the ticker's duration, the whole
//     callback and the 12 World phases; the ticks 600 ms apart (here 100 ms: World.tickRate) from start to start;
//     `since` returns only the ticks after it; a paused world adds no tick, and they go on after the resume.
//  3. engine-bots.js with 5 stub bots and a human logged in: the bots' share of each tick, and their numbers.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PERF_MARKER, buildEngine } from '../build.mjs';
import { makeFixture, IOS } from './lib/fixture.mjs';
import { Bot, Page, createRunner, waitFor } from './lib/session.mjs';
import { createVmWorker } from './lib/vm-worker.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(HERE, 'fixtures/stub-bots');
const args = process.argv.slice(2);
const arg = name => (args.find(a => a.startsWith(`--${name}=`)) ?? '').split('=').slice(1).join('=') || undefined;
const VERBOSE = args.includes('--verbose');
const TMP = path.join(IOS, 'build/tmp/engine');
const OUT = path.join(TMP, 'out-autotest');
const OUT_NORMAL = path.join(TMP, 'out-autotest-normal');
const RATE = 100; // ms a tick (World.tickRate), so that the run takes seconds

// ---- child: one boot in the vm sandbox --------------------------------------------------------------------------
if (arg('child')) {
    const kind = arg('child');
    const docs = arg('docs');
    const worker = createVmWorker({ gameDir: OUT, documentsDir: docs });
    const env = Object.assign(worker.env, { verbose: VERBOSE, fixture: makeFixture() });
    const T = createRunner(env);
    const page = new Page(env, T);
    const replies = new Map();
    env.onMessage(m => {
        if (m.type === 'lctest-perf') replies.get(m.reqId)?.(m);
    });
    let reqId = 0;
    const perf = since =>
        new Promise((resolve, reject) => {
            const id = `perf-${++reqId}`;
            replies.set(id, resolve);
            page.post({ type: 'lctest-perf', reqId: id, since });
            setTimeout(() => reject(new Error(`no lctest-perf reply to ${id}`)), 10000);
        });
    const bots = kind === 'bots' ? 5 : 0;
    try {
        await worker.boot();
        page.post({ type: 'init', config: { node: { profile: 'perftest' }, bots: { count: bots } } });
        await waitFor(env, () => page.booted || page.exits.length, 120000, 'booted');
        T.check(`the test build's ${bots ? 'engine-bots.js' : 'engine.js'} boots`, page.booted?.bundle === (bots ? 'engine-bots.js' : 'engine.js'), page.booted);
        page.post({ type: 'start' });
        await waitFor(env, () => page.ready || page.exits.length, 300000, 'ready');
        const H = env.hooks;
        H.World.tickRate = RATE;
        if (kind === 'vanilla') {
            const ready = await perf(0);
            const m = ready.marks;
            const order = [m.evaluated, m.worldStart, m.worldStarted, m.firstTickStart, m.firstTickEnd, m.ready];
            T.check('the start-up marks come in order: evaluated <= World.start <= done <= first tick <= its end <= ready', order.every(Number.isFinite) && order.every((t, i) => i === 0 || t >= order[i - 1]), m);
            T.check('the first tick is tick 0, its start the first mark', ready.ticks >= 1 && ready.from === 0 && ready.start[0] === m.firstTickStart, { ticks: ready.ticks, start0: ready.start[0], firstTickStart: m.firstTickStart });
            T.check('World.start as the marks say ~ the ready message\'s ms (World.start + the first tick)', Math.abs(m.firstTickEnd - m.worldStart - page.ready.ms) < 50, { marks: Math.round(m.firstTickEnd - m.worldStart), ready: Math.round(page.ready.ms) });
            await waitFor(env, () => H.ticker.tickStats.ticks >= 25, 30000, '25 ticks');
            const all = await perf(0);
            const n = all.ticks - all.from;
            const intervals = all.start.slice(2).map((t, i) => t - all.start[i + 1]); // (from tick 1: the rate was set after tick 0)
            const sorted = [...intervals].sort((a, b) => a - b);
            const median = sorted[sorted.length >> 1];
            T.check(`every tick's start, durations and 12 phases (${n} ticks)`, n === all.ticks && all.start.length === n && all.tickMs.length === n && all.callbackMs.length === n && all.phases.length === n * 12 && all.extraMs === null, { n, start: all.start.length, phases: all.phases.length });
            T.check('the ticker\'s duration, and the whole callback at least that', all.tickMs.every(ms => ms > 0) && all.tickMs.every((ms, i) => all.callbackMs[i] >= ms - 0.01), { tick: all.tickMs.slice(0, 5), callback: all.callbackMs.slice(0, 5) });
            T.check(`the ticks start ${RATE} ms apart (median start-to-start)`, Math.abs(median - RATE) < 15, { median: +median.toFixed(2), min: +sorted[0].toFixed(2), max: +sorted.at(-1).toFixed(2) });
            T.check('the world\'s counts', all.players === 0 && all.npcs > 1000 && all.state === 'running' && all.clamps === 0, { players: all.players, npcs: all.npcs, state: all.state, clamps: all.clamps });
            const since = all.ticks - 3;
            const tail = await perf(since);
            T.check('`since` returns the ticks after it', tail.from === since && tail.start.length === tail.ticks - since && tail.start[0] === all.start[since - all.from], { from: tail.from, n: tail.start.length, ticks: tail.ticks });
            // a paused world: no tick counted; the first after the resume a tick after it
            await page.sendLifecycle('pause', 10000);
            const paused = await perf(0);
            await env.sleep(RATE * 5);
            const still = await perf(0);
            T.check('a paused world adds no tick', still.ticks === paused.ticks && still.state === 'paused', { paused: paused.ticks, after: still.ticks, state: still.state });
            const resumedAt = performance.timeOrigin + performance.now();
            await page.sendLifecycle('resume', 10000);
            await waitFor(env, () => H.ticker.tickStats.ticks >= paused.ticks + 3, 10000, '3 ticks after the resume');
            const after = await perf(paused.ticks);
            // (the ticker schedules the first one a tick after the last before the pause: at once, after a longer pause)
            T.check('after the resume the ticks go on, none before it', after.from === paused.ticks && after.start.length >= 3 && after.start[0] >= resumedAt - 1, { firstAfterResumeMs: +(after.start[0] - resumedAt).toFixed(1) });
        } else {
            const human = new Bot(env, page, 'perfhuman');
            const response = await human.login();
            T.check('a human logs in (the bots join a world with a human in it)', response === 2, response);
            human.startKeepalive(500);
            const B = env.bots;
            await waitFor(env, () => B.BotManager.stats().active >= bots, 60000, `${bots} bots`);
            const t0 = H.ticker.tickStats.ticks;
            await waitFor(env, () => H.ticker.tickStats.ticks >= t0 + 10, 30000, '10 ticks');
            const r = await perf(t0);
            const share = r.extraMs ?? [];
            T.check('the bots\' share of every tick (BotManager.tick), within the tick', share.length === r.ticks - t0 && share.every(ms => ms > 0) && share.every((ms, i) => ms <= r.tickMs[i] + 0.01), { share: share.slice(0, 5), tick: r.tickMs.slice(0, 5) });
            T.check('the bots\' numbers', r.extra?.active >= bots && r.extra?.phase === 'started' && r.extra.botTicks > 0 && typeof r.extra.store?.lastTick === 'number' && r.players === bots + 1, { extra: r.extra, players: r.players });
            human.stopKeepalive();
        }
    } catch (e) {
        T.fail('session aborted', e?.stack ?? String(e));
    }
    const result = T.result(page);
    console.log('[perf] RESULT ' + JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
}

// ---- parent ------------------------------------------------------------------------------------------------------
let failed = 0;
const report = (name, ok, detail) => {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};

if (!args.includes('--no-build')) {
    const info = await buildEngine({ out: OUT, bots: { lib: STUB }, autotest: true });
    await buildEngine({ out: OUT_NORMAL, bots: { lib: STUB } });
    console.log(`[perf] built the test build (${(info.bundle.bytes / 1024).toFixed(0)} KB engine.js) and a normal build into ${path.relative(IOS, TMP)}`);
}
for (const bundle of ['engine.js', 'engine-bots.js']) {
    const test = fs.readFileSync(path.join(OUT, 'engine', bundle), 'utf8');
    const normal = fs.readFileSync(path.join(OUT_NORMAL, 'engine', bundle), 'utf8');
    report(`${bundle}: the test build answers '${PERF_MARKER}', a normal build never names it`, test.includes(PERF_MARKER) && !normal.includes(PERF_MARKER));
}

for (const kind of ['vanilla', 'bots']) {
    const docs = fs.mkdtempSync(path.join(TMP, 'perf-docs-'));
    const r = spawnSync(process.execPath, ['--expose-gc', '--experimental-vm-modules', fileURLToPath(import.meta.url), `--child=${kind}`, `--docs=${docs}`, ...(VERBOSE ? ['--verbose'] : [])], { encoding: 'utf8', maxBuffer: 64 << 20 });
    fs.rmSync(docs, { recursive: true, force: true });
    const line = (r.stdout ?? '').split('\n').find(l => l.startsWith('[perf] RESULT '));
    const result = line ? JSON.parse(line.slice('[perf] RESULT '.length)) : null;
    if (!result) {
        report(`${kind}: the child ran`, false, `${(r.stdout ?? '').slice(-1500)}\n${(r.stderr ?? '').slice(-1500)}`);
        continue;
    }
    for (const c of result.checks) report(`${kind}: ${c.name}`, c.ok, c.ok && !VERBOSE ? undefined : c.detail);
    if (result.logs.errors.length) report(`${kind}: no engine error lines`, false, result.logs.errors.slice(0, 3));
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall perf checks passed');
process.exit(failed ? 1 : 0);
