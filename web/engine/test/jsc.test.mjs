#!/usr/bin/env node
// Test (b): the same session as test (a), inside the macOS JavaScriptCore shell - with the JIT, and again with
// --useJIT=false --useWasm=false (what iOS Lockdown Mode leaves: no JIT, no WebAssembly).
//
//   node web/engine/test/jsc.test.mjs [--only=jit|nojit] [--no-build] [--verbose]
//   node web/engine/test/jsc.test.mjs --measure [--only=jit|nojit] [--no-flat-strings] [--no-release]
//
// This launcher only prepares files (build, fixture.json, a Documents folder) and runs `jsc`; everything the
// engine sees comes from test/jsc-harness.mjs, which runs inside JSC with no Node APIs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEngine } from '../build.mjs';
import { makeFixture, IOS } from './lib/fixture.mjs';

const JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const TMP = path.join(IOS, 'build/tmp/engine');
const OUT = path.join(TMP, 'out-release');
const only = (args.find(a => a.startsWith('--only=')) ?? '').split('=')[1];
const MEASURE = args.includes('--measure');
const pass = args.filter(a => ['--verbose', '--no-flat-strings', '--no-release', '--no-wasm', '--measure'].includes(a));

if (!fs.existsSync(JSC)) {
    console.error(`no JavaScriptCore shell at ${JSC}`);
    process.exit(2);
}
if (!args.includes('--no-build')) {
    await buildEngine({ out: OUT, debug: false, bots: false }); // the vanilla engine.js (bots: test/bots.test.mjs)
    console.log(`[jsc] built release engine into ${path.relative(IOS, OUT)}`);
}

const modes = [
    { name: 'jit', flags: [], slow: 1 },
    { name: 'nojit', flags: ['--useJIT=false', '--useWasm=false'], slow: 10 }
].filter(m => !only || m.name === only);

let failed = 0;
const summary = [];
for (const mode of modes) {
    fs.mkdirSync(TMP, { recursive: true });
    const run = fs.mkdtempSync(path.join(TMP, `jsc-${mode.name}-`));
    fs.writeFileSync(path.join(run, 'fixture.json'), JSON.stringify(makeFixture()));
    fs.mkdirSync(path.join(run, 'Documents/players/enginetest'), { recursive: true }); // jsc's writeFile cannot mkdir
    console.log(`\n[jsc] ===== ${mode.name}${mode.flags.length ? ` (${mode.flags.join(' ')})` : ''} =====`);
    const t = Date.now();
    const r = spawnSync(JSC, [...mode.flags, '-m', path.join(HERE, 'jsc-harness.mjs'), '--', run, OUT, `--slow=${mode.slow}`, ...pass], {
        cwd: HERE,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        timeout: (MEASURE ? 15 : 40) * 60 * 1000
    });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    // jsc prints "Could not open file" on stderr for every readFile() of a missing file (404s): expected noise
    for (const line of out.split('\n')) {
        if (line.startsWith('[jsc] RESULT ') || line.startsWith('Could not open file')) continue;
        console.log(line);
    }
    const resultLine = out.split('\n').find(l => l.startsWith('[jsc] RESULT '));
    if (MEASURE) {
        const m = out.split('\n').find(l => l.startsWith('[jsc] MEASURE '));
        if (!m) failed++;
        else {
            const res = JSON.parse(m.slice('[jsc] MEASURE '.length));
            res.mode = mode.name;
            const tag = `${mode.name}${pass.includes('--no-flat-strings') ? '-noflat' : ''}${pass.includes('--no-release') ? '-norelease' : ''}`;
            fs.writeFileSync(path.join(TMP, `jsc-measure-${tag}.json`), JSON.stringify(res, null, 2));
        }
    } else if (!resultLine) {
        console.log(`[jsc] ${mode.name}: no result (exit ${r.status}${r.signal ? `, signal ${r.signal}` : ''}${r.error ? `, ${r.error.message}` : ''})`);
        failed++;
        summary.push({ mode: mode.name, ok: false });
    } else {
        const res = JSON.parse(resultLine.slice('[jsc] RESULT '.length));
        fs.writeFileSync(path.join(TMP, `jsc-result-${mode.name}.json`), JSON.stringify(res, null, 2));
        const bad = res.checks.filter(c => !c.ok);
        for (const c of bad) console.log(`  FAILED: [${c.phase}] ${c.name} ${c.detail !== undefined ? JSON.stringify(c.detail) : ''}`);
        const ok = res.ok && res.bodyKinds.every(k => k === 'ArrayBuffer');
        if (!ok) failed++;
        summary.push({ mode: mode.name, ok, passed: res.passed, failed: res.failed, seconds: res.seconds, startMs: res.metrics.startMs, gcHeapMB: res.gcHeapMB, ticks: res.metrics.ticks, webAssembly: res.webAssembly, bzip2AfterStart: res.metrics.bzip2AfterStart });
        console.log(`[jsc] ${mode.name}: ${ok ? 'PASS' : 'FAIL'} - ${res.passed} passed, ${res.failed} failed, ${((Date.now() - t) / 1000).toFixed(0)} s`);
    }
    fs.rmSync(run, { recursive: true, force: true });
}
if (!MEASURE) {
    console.log('\n[jsc] summary ' + JSON.stringify(summary, null, 1));
    console.log(`[jsc] ${failed ? 'FAIL' : 'PASS'}: ${summary.map(s => `${s.mode} ${s.passed ?? 0}/${(s.passed ?? 0) + (s.failed ?? 0)}`).join(', ')}`);
}
process.exit(failed ? 1 : 0);
