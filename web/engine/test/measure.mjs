#!/usr/bin/env node
// Memory and timing numbers for the README: boots the release build in fresh processes (Node vm sandbox: V8
// heapUsed; JavaScriptCore shell: gcHeapSize after fullGC), with and without the flat-string Packet.gjstr patch and
// the post-start release of vfs data + the WASM bzip2 instance, then 6 s of idle ticking. Best of N runs for
// times (the build machine is shared), the heap is taken from the same run.
//
//   node web/engine/test/measure.mjs [--runs=3] [--no-build]
//
// --bots: the bots matrix instead (docs/BOTS.md §6): for each count, a fresh worker with init.config.bots.count = N
// (0 = engine.js), a human at Lumbridge, the spawn ramp, then --ticks ticks at --rate ms: start, heap after start and
// after the run, tick avg/p50/p95/max (all, and BotManager.tick's share), the ramp's worst tick, a lifecycle save
// (ms, PUTs, bytes), and the bots' store writes during the run (per world minute of 100 ticks, with the bots that logged
// off meanwhile: docs/BOTS.md §4.5). Against the stub library, or the real one with --real.
//
//   node web/engine/test/measure.mjs --bots [--real] [--counts=0,25,50,100,250,500,750,1000] [--ticks=100] [--rate=300]
//        [--runtimes=vm,jsc,jsc-nojit] [--searches=N (the bots' path searches per tick; default: the library's)] [--no-build]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BOTS_LIB, buildEngine } from '../build.mjs';
import { makeFixture, IOS } from './lib/fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, def) => (args.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${def}`).split('=').slice(1).join('=');
const RUNS = Number(arg('runs', 3));
const TMP = path.join(IOS, 'build/tmp/engine');

if (args.includes('--bots')) {
    await measureBots();
    process.exit(0);
}

if (!args.includes('--no-build')) await buildEngine({ out: path.join(TMP, 'out-release'), bots: false });

const variants = [
    { label: 'V8 vm, default', cmd: ['--expose-gc', '--experimental-vm-modules', path.join(HERE, 'vm.test.mjs'), '--no-build', '--measure'] },
    { label: 'V8 vm, no flat strings', cmd: ['--expose-gc', '--experimental-vm-modules', path.join(HERE, 'vm.test.mjs'), '--no-build', '--measure', '--no-flat-strings'] },
    { label: 'V8 vm, no release', cmd: ['--expose-gc', '--experimental-vm-modules', path.join(HERE, 'vm.test.mjs'), '--no-build', '--measure', '--no-release'] },
    { label: 'JSC JIT, default', cmd: [path.join(HERE, 'jsc.test.mjs'), '--no-build', '--measure', '--only=jit'] },
    { label: 'JSC JIT, no flat strings', cmd: [path.join(HERE, 'jsc.test.mjs'), '--no-build', '--measure', '--only=jit', '--no-flat-strings'] },
    { label: 'JSC JIT, no release', cmd: [path.join(HERE, 'jsc.test.mjs'), '--no-build', '--measure', '--only=jit', '--no-release'] },
    { label: 'JSC JIT, JS bzip2 only', cmd: [path.join(HERE, 'jsc.test.mjs'), '--no-build', '--measure', '--only=jit', '--no-wasm'] },
    { label: 'JSC no-JIT no-WASM, default', cmd: [path.join(HERE, 'jsc.test.mjs'), '--no-build', '--measure', '--only=nojit'] }
];

const rows = [];
for (const v of variants) {
    let best = null;
    for (let i = 0; i < RUNS; i++) {
        const r = spawnSync(process.execPath, v.cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
        const line = (r.stdout + r.stderr).split('\n').find(l => / MEASURE /.test(l));
        if (!line) {
            console.log(`${v.label}: no result\n${(r.stdout + r.stderr).slice(-2000)}`);
            continue;
        }
        const m = JSON.parse(line.slice(line.indexOf('MEASURE ') + 8));
        if (!best || m.startMs < best.startMs) best = m;
    }
    if (!best) continue;
    const heap = best.gcHeapMB ? best.gcHeapMB.afterStart : best.heapUsedMB.afterStartGC;
    const row = { variant: v.label, startMs: best.startMs, heapAfterStartMB: heap, ...(best.arrayBuffersMB !== undefined ? { v8ArrayBuffersMB: best.arrayBuffersMB, v8ExternalMB: best.externalMB } : {}), idleTick: best.ticks, bzip2AfterStart: best.bzip2, vfsResidentMB: +(best.vfs.residentBytes / 1048576).toFixed(1) };
    rows.push(row);
    console.log(JSON.stringify(row));
}
fs.writeFileSync(path.join(TMP, 'measure.json'), JSON.stringify(rows, null, 2));
console.log(`\n${'variant'.padEnd(30)} ${'start ms'.padStart(9)} ${'heap MB'.padStart(8)} ${'idle tick avg/p95 ms'.padStart(21)}`);
for (const r of rows) console.log(`${r.variant.padEnd(30)} ${String(r.startMs).padStart(9)} ${String(r.heapAfterStartMB).padStart(8)} ${`${r.idleTick.avgMs} / ${r.idleTick.p95Ms}`.padStart(21)}`);

// ---- the bots matrix -------------------------------------------------------------------------------------------

async function measureBots() {
    const JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc';
    const real = args.includes('--real');
    const lib = real ? BOTS_LIB : path.join(HERE, 'fixtures/stub-bots');
    const out = path.join(TMP, real ? 'out-bots-real' : 'out-bots-stub');
    const counts = arg('counts', '0,25,50,100,250,500,750,1000').split(',').map(Number);
    const searches = Number(arg('searches', 0)) || undefined;
    const ticks = Number(arg('ticks', 100));
    const rate = Number(arg('rate', 300));
    const runtimes = arg('runtimes', 'vm,jsc').split(',');
    if (!args.includes('--no-build')) await buildEngine({ out, bots: { lib } });
    console.log(`bots matrix: ${real ? 'real' : 'stub'} library, ${ticks} ticks at ${rate} ms after the spawn ramp, counts ${counts.join('/')}, ${runtimes.join(', ')}${searches ? `, ${searches} path searches a tick` : ''}`);

    const rows = [];
    for (const runtime of runtimes) {
        for (const count of counts) {
            const run = fs.mkdtempSync(path.join(TMP, `measure-bots-${runtime}-`));
            for (const d of ['players/measure', 'bots/measure']) fs.mkdirSync(path.join(run, 'Documents', d), { recursive: true });
            let r;
            if (runtime === 'vm') {
                r = spawnSync(process.execPath, ['--expose-gc', '--experimental-vm-modules', path.join(HERE, 'bots.test.mjs'), '--child=measure', `--docs=${path.join(run, 'Documents')}`, `--out=${out}`, `--bots=${count}`, `--ticks=${ticks}`, `--rate=${rate}`, ...(searches ? [`--searches=${searches}`] : [])], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 });
            } else {
                fs.writeFileSync(path.join(run, 'fixture.json'), JSON.stringify(makeFixture()));
                fs.writeFileSync(path.join(run, 'save-index.json'), '[]');
                fs.writeFileSync(path.join(run, 'bots.json'), JSON.stringify({ config: { node: { profile: 'measure' }, bots: { count, ...(searches ? { pathSearchesPerTick: searches } : {}) } }, measure: { ticks, rate } }));
                const nojit = runtime === 'jsc-nojit';
                r = spawnSync(JSC, [...(nojit ? ['--useJIT=false', '--useWasm=false'] : []), '-m', path.join(HERE, 'jsc-harness.mjs'), '--', run, out, `--slow=${nojit ? 10 : 1}`, '--bots-boot=measure'], { cwd: HERE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60 * 1000 });
            }
            fs.rmSync(run, { recursive: true, force: true });
            const all = (r.stdout ?? '') + (r.stderr ?? '');
            const line = all.split('\n').find(l => / MEASURE /.test(l));
            if (!line) {
                console.log(`${runtime} ${count}: no result (exit ${r.status})\n${all.split('\n').filter(l => !l.startsWith('Could not open file')).slice(-15).join('\n')}`);
                continue;
            }
            const row = { runtime, ...JSON.parse(line.slice(line.indexOf('MEASURE ') + 8)) };
            rows.push(row);
            console.log(JSON.stringify(row));
        }
    }
    fs.writeFileSync(path.join(TMP, `measure-bots-${real ? 'real' : 'stub'}.json`), JSON.stringify(rows, null, 2));
    const pad = (s, n) => String(s).padStart(n);
    console.log(`\n${'runtime'.padEnd(10)} ${pad('bots', 4)} ${pad('start ms', 8)} ${pad('heap MB start/run', 17)} ${pad('tick avg/p50/p95/max ms', 25)} ${pad('bots avg/p95 ms', 15)} ${pad('ramp max', 8)} ${pad('save ms/PUTs/KB', 15)} ${pad('paths avg/max/budget/full', 25)} ${pad('store writes/min (logoffs)', 26)} errors`);
    for (const x of rows) {
        console.log(
            `${x.runtime.padEnd(10)} ${pad(x.bots, 4)} ${pad(x.startMs, 8)} ${pad(`${x.heapMB.afterStart} / ${x.heapMB.afterRun}`, 17)} ${pad(`${x.tick.avgMs}/${x.tick.p50Ms}/${x.tick.p95Ms}/${x.tick.maxMs}`, 25)} ` +
                `${pad(x.botTick ? `${x.botTick.avgMs}/${x.botTick.p95Ms}` : '-', 15)} ${pad(x.ramp.maxMs, 8)} ${pad(`${x.save.ms}/${x.save.puts}/${(x.save.bytes / 1024).toFixed(1)}`, 15)} ` +
                `${pad(x.pathSearches ? `${x.pathSearches.avg}/${x.pathSearches.max}/${x.pathSearches.budget}/${x.pathSearches.fullTicks}` : '-', 25)} ` +
                `${pad(x.store ? `${x.store.perWorldMinute} (${x.store.writes} in ${x.store.ticks} ticks, ${x.store.logoffs})` : '-', 26)} ${x.errors}`
        );
    }
}
