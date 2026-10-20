#!/usr/bin/env node
// The same seed gives the same world: two runs of test/sim.mjs (10 bots, 400 ticks, seed 7) must end with the same
// fingerprint (every bot's tile, XP and task). Anything the bots read besides their seeded dice and the world's ticks
// (upstream's wall-clock burying interval was one) makes a seeded run unrepeatable, and every A/B comparison and
// failure replay with it.
//
//   node web/engine/bots/test/determinism.test.mjs
import { spawnSync } from 'child_process';
import path from 'path';
import { BOTS_DIR } from './lib/paths.mjs';

const run = () => {
    const r = spawnSync(process.execPath, ['--expose-gc', path.join(BOTS_DIR, 'test/sim.mjs'), '--bots=10', '--ticks=400', '--seed=7', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const start = r.stdout.indexOf('{');
    const end = r.stdout.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error(`sim.mjs gave no report (exit ${r.status}): ${(r.stderr ?? '').slice(0, 400)}`);
    return JSON.parse(r.stdout.slice(start, end + 1));
};
const a = run();
const b = run();
const fa = a.health?.fingerprint;
const fb = b.health?.fingerprint;
console.log(`determinism: two runs of 10 bots × 400 ticks, seed 7: fingerprints ${fa} and ${fb}`);
const ok = !!fa && fa === fb;
console.log(`${ok ? 'ok  ' : 'FAIL'} the same seed gives the same world`);
process.exit(ok ? 0 : 1);
