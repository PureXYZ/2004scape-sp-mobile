#!/usr/bin/env node
// The training situations' sampler (the realism work, phase 7, Track L's first step: the research):
// humanlike runs with the probe human (--probe=40 --talk=150, its lines from test/data/model-human-lines.json, with
// follow-ups) and --model-capture, over varied worlds: members and free, 1x and 10x XP, 100 and 250 bots, several
// seeds, aged worlds (2-hour runs: sessions turned over, longer online times, more events) and new-character runs
// (the newcomers about Lumbridge). Each run's capture lands in <out>/<config>.jsonl and its report's summary in
// <out>/<config>.log. At most --jobs runs at once (default 4: the Mac is shared).
//
//   node web/engine/bots/test/model-data/sample.mjs --out=DIR [--jobs=4] [--only=key,key] [--list] [--set=r1|r2] [--lines=FILE]
//
// --set=r2: the retrain's runs (round 2, after the first blind test: CONFIGS_R2, new seeds and worlds); --lines: the
// human's pool (default test/data/model-human-lines.json; round 2 uses human-lines.mjs --focus's weighted pool).
//
// Run it from the worktree's root (humanlike writes its scratch engine under build/tmp/bots).
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HUMANLIKE = path.resolve(here, '../humanlike.mjs');
const POOL = path.resolve(here, '../data/model-human-lines.json');

/** the sampling runs: key, humanlike's arguments (beyond the probe and the capture) */
export const CONFIGS = [
    { key: 'm100-x10-s11', args: { bots: 100, members: true, xprate: 10, seed: 11 } },
    { key: 'm100-x1-s12', args: { bots: 100, members: true, xprate: 1, seed: 12 } },
    { key: 'f100-x1-s13', args: { bots: 100, members: false, xprate: 1, seed: 13 } },
    { key: 'f100-x10-s14', args: { bots: 100, members: false, xprate: 10, seed: 14 } },
    { key: 'm250-x10-s15', args: { bots: 250, members: true, xprate: 10, seed: 15 } },
    { key: 'f250-x1-s16', args: { bots: 250, members: false, xprate: 1, seed: 16 } },
    { key: 'm100-x10-s17-new', args: { bots: 100, members: true, xprate: 10, seed: 17, newchar: true } },
    { key: 'f100-x1-s18-new', args: { bots: 100, members: false, xprate: 1, seed: 18, newchar: true } },
    { key: 'm100-x10-s19-aged', args: { bots: 100, members: true, xprate: 10, seed: 19, ticks: 12000 } },
    { key: 'f100-x10-s20-aged', args: { bots: 100, members: false, xprate: 10, seed: 20, ticks: 12000 } },
    { key: 'm250-x1-s21-new', args: { bots: 250, members: true, xprate: 1, seed: 21, newchar: true } },
    { key: 'm100-x1-s22-talk', args: { bots: 100, members: true, xprate: 1, seed: 22, talk: 50 } },
    { key: 'f100-x10-s23-talk', args: { bots: 100, members: false, xprate: 10, seed: 23, talk: 50 } },
    { key: 'm100-x10-s24-aged', args: { bots: 100, members: true, xprate: 10, seed: 24, ticks: 12000, talk: 80 } },
    { key: 'f250-x10-s25', args: { bots: 250, members: false, xprate: 10, seed: 25 } },
    { key: 'm100-x1-s26-aged-new', args: { bots: 100, members: true, xprate: 1, seed: 26, ticks: 12000, newchar: true } },
    // (more lines to nobody: the crowd's and the reply window's situations are the scarce ones)
    { key: 'f100-x1-s27-talk', args: { bots: 100, members: false, xprate: 1, seed: 27, talk: 30 } },
    { key: 'm100-x10-s28-talk', args: { bots: 100, members: true, xprate: 10, seed: 28, talk: 30 } },
    { key: 'm250-x10-s29-talk', args: { bots: 250, members: true, xprate: 10, seed: 29, talk: 30 } }
];

/** the retrain's runs (round 2): new seeds 31-46, the same spread of worlds */
export const CONFIGS_R2 = [
    { key: 'r2-m100-x10-s31', args: { bots: 100, members: true, xprate: 10, seed: 31 } },
    { key: 'r2-f100-x1-s32', args: { bots: 100, members: false, xprate: 1, seed: 32 } },
    { key: 'r2-m250-x1-s33', args: { bots: 250, members: true, xprate: 1, seed: 33 } },
    { key: 'r2-f250-x10-s34', args: { bots: 250, members: false, xprate: 10, seed: 34 } },
    { key: 'r2-m100-x1-s35-new', args: { bots: 100, members: true, xprate: 1, seed: 35, newchar: true } },
    { key: 'r2-f100-x10-s36-new', args: { bots: 100, members: false, xprate: 10, seed: 36, newchar: true } },
    { key: 'r2-m100-x10-s37-aged', args: { bots: 100, members: true, xprate: 10, seed: 37, ticks: 12000 } },
    { key: 'r2-f100-x1-s38-aged', args: { bots: 100, members: false, xprate: 1, seed: 38, ticks: 12000 } },
    { key: 'r2-m250-x10-s39-talk', args: { bots: 250, members: true, xprate: 10, seed: 39, talk: 30 } },
    { key: 'r2-f100-x10-s40-talk', args: { bots: 100, members: false, xprate: 10, seed: 40, talk: 30 } },
    { key: 'r2-m100-x1-s41-talk', args: { bots: 100, members: true, xprate: 1, seed: 41, talk: 50 } },
    { key: 'r2-f250-x1-s42', args: { bots: 250, members: false, xprate: 1, seed: 42 } },
    { key: 'r2-m100-x10-s43-aged-new', args: { bots: 100, members: true, xprate: 10, seed: 43, ticks: 12000, newchar: true } },
    { key: 'r2-f100-x1-s44', args: { bots: 100, members: false, xprate: 1, seed: 44 } },
    { key: 'r2-m100-x1-s45-aged', args: { bots: 100, members: true, xprate: 1, seed: 45, ticks: 12000, talk: 80 } },
    { key: 'r2-f250-x10-s46-talk', args: { bots: 250, members: false, xprate: 10, seed: 46, talk: 30 } }
];

const args = Object.fromEntries(process.argv.slice(2).map(a => ((m => (m ? [m[1], m[2] ?? 'true'] : [a, 'true']))(a.match(/^--([^=]+)(?:=(.*))?$/)))));
const SET = args.set === 'r2' ? CONFIGS_R2 : CONFIGS;
const LINES = args.lines ? path.resolve(args.lines) : POOL;
if (args.list === 'true') {
    for (const c of SET) console.log(c.key, JSON.stringify(c.args));
    process.exit(0);
}
if (!args.out) {
    console.error('sample: --out=DIR is needed');
    process.exit(2);
}
const OUT = path.resolve(args.out);
const JOBS = Math.max(1, Math.min(4, Number(args.jobs ?? 4)));
const only = args.only ? new Set(args.only.split(',')) : null;
fs.mkdirSync(OUT, { recursive: true });

function argv(c) {
    const a = { ticks: 6000, probe: 40, talk: 150, ...c.args };
    const list = [`--bots=${a.bots}`, `--ticks=${a.ticks}`, `--seed=${a.seed}`, `--members=${a.members}`, `--xprate=${a.xprate}`, `--probe=${a.probe}`, `--talk=${a.talk}`];
    if (a.newchar) list.push('--newchar');
    list.push(`--probe-lines=${LINES}`, `--model-capture=${path.join(OUT, `${c.key}.jsonl`)}`, '--no-details', '--max-errors=50');
    return ['--expose-gc', HUMANLIKE, ...list];
}

const queue = SET.filter(c => !only || only.has(c.key)).filter(c => args.force === 'true' || !fs.existsSync(path.join(OUT, `${c.key}.done`)));
let running = 0;
let failed = 0;
const started = Date.now();
function next() {
    while (running < JOBS && queue.length) {
        const c = queue.shift();
        running++;
        const log = fs.createWriteStream(path.join(OUT, `${c.key}.log`));
        const t0 = Date.now();
        const child = spawn(process.execPath, argv(c), { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.pipe(log);
        child.stderr.pipe(log);
        console.log(`start ${c.key}`);
        child.on('exit', code => {
            running--;
            const lines = fs.existsSync(path.join(OUT, `${c.key}.jsonl`)) ? fs.readFileSync(path.join(OUT, `${c.key}.jsonl`), 'utf8').split('\n').filter(Boolean).length : 0;
            if (code === 0) fs.writeFileSync(path.join(OUT, `${c.key}.done`), `${lines}\n`);
            else failed++;
            console.log(`${code === 0 ? 'done ' : 'FAIL '} ${c.key}: ${lines} situations, ${Math.round((Date.now() - t0) / 1000)} s${code === 0 ? '' : ` (exit ${code}, see ${c.key}.log)`}`);
            if (queue.length) next();
            else if (running === 0) {
                console.log(`all done in ${Math.round((Date.now() - started) / 1000)} s, ${failed} failed`);
                process.exit(failed ? 1 : 0);
            }
        });
    }
}
if (!queue.length) console.log('nothing to run');
else next();
