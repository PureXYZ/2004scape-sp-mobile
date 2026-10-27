#!/usr/bin/env node
// A test at many seeds, one run at a time: which checks fail at which seeds. Not in all.mjs (a sweep takes a test's time
// once a seed). The staged tests take bots of a seeded world, and a check that holds only on some dice fails when
// anything else moves them (a new draw in a planner, a bot that walks a tick longer): 2026-10-27, fixes.test passed at
// one seed of 7-38 and scams.test at three of 1-17 before their scenes were made to hold at every seed. Run a test here
// before changing its default seed, and after a change to the scenes it stages.
//
//   node web/engine/bots/test/seeds.mjs <test file> [--seeds=1-10 | --seeds=3,7,12] [-- extra args for the test]
//   e.g. node web/engine/bots/test/seeds.mjs fixes.test.mjs --seeds=1-20
import { spawnSync } from 'child_process';
import path from 'path';
import { BOTS_DIR } from './lib/paths.mjs';

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const own = dash === -1 ? argv : argv.slice(0, dash);
const extra = dash === -1 ? [] : argv.slice(dash + 1);
const file = own.find(a => !a.startsWith('--'));
if (!file) {
    console.error('usage: seeds.mjs <test file> [--seeds=1-10] [-- args]');
    process.exit(2);
}
const spec = own.find(a => a.startsWith('--seeds='))?.slice(8) ?? '1-10';
const seeds = spec.split(',').flatMap(part => {
    const [a, b] = part.split('-').map(Number);
    return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, i) => a + i);
});
const script = path.isAbsolute(file) ? file : path.join(BOTS_DIR, 'test', file);

/** the check's name: a FAIL line's text up to its detail */
const nameOf = line => line.replace(/^\s*FAIL\s+/, '').split(' — ')[0].trim();
const failures = new Map();
let failedRuns = 0;
for (const seed of seeds) {
    const t0 = performance.now();
    const r = spawnSync(process.execPath, ['--expose-gc', script, `--seed=${seed}`, ...extra], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const seconds = ((performance.now() - t0) / 1000).toFixed(0);
    const lines = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n');
    const failed = lines.filter(l => /^\s*FAIL\b/.test(l));
    if (r.status !== 0 && failed.length === 0) failed.push(`FAIL exit ${r.status}: ${lines.filter(l => /Error/.test(l))[0] ?? ''}`);
    if (failed.length) failedRuns++;
    for (const l of failed) {
        const name = nameOf(l);
        if (!failures.has(name)) failures.set(name, []);
        failures.get(name).push(seed);
    }
    console.log(`seed ${seed}: ${failed.length ? `${failed.length} failed` : 'ok'} (${seconds} s)${failed.length ? `  ${failed.map(nameOf).map(n => n.slice(0, 80)).join(' | ')}` : ''}`);
}
console.log(`${path.basename(script)}: ${seeds.length - failedRuns} of ${seeds.length} seeds passed`);
for (const [name, at] of failures) console.log(`  ${at.length}× ${name} (seeds ${at.join(', ')})`);
process.exit(failedRuns ? 1 : 0);
