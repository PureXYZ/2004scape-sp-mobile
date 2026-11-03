#!/usr/bin/env node
// The same world with another copy of the bot library: for a change that must not change what the bots do (a faster
// search, a cheaper loop), each world below runs once with this library and once with the other, from the same seed,
// and must end the same:
//   bots     every bot's name, tile, stats, task and inventory, and the human's tile (a fingerprint)
//   saves    every bot's save (Player.save: varps, bank, worn items, ...) and the living world's state (exportWorld)
//   bytes    every byte the human's client was sent (a sha256)
//   dice     the number of Math.random draws
// A world is the real 274 world (test/lib/simworld.ts) as the app runs it: members, 10× XP, a new store with ages, real
// sessions (logouts, returns, newcomers, quits), the spawn ramp, one human standing at the world's place. The clock reads
// a tick's worth of milliseconds per tick (Date.now: the engine's last-login time goes into every save).
//
//   node --expose-gc web/engine/bots/test/identity.mjs [--base=REF|DIR] [--worlds=all|quick|1000:300:1:3180,3240;...]
//
// --base: a git ref (default HEAD: the working tree against its last commit) or a library folder (src, with data beside
// it, as LC_BOTS_SRC takes). --worlds: all (default) is 1000 bots × 300 ticks at Lumbridge, 500 × 1000 at Varrock West,
// 250 × 600 at Edgeville and 500 × 300 at Lumbridge castle (most of an hour, a few GB of memory); quick is 100 × 300.
// --on=period,movement (the bots ideas work, round 3): test/lib/simworld's switches set true in both worlds (a staged
// world has themes C, D, G and H and the outings off unless asked for: lives, word, period, movement, outings), so a
// theme's foundation proves itself neutral with its theme on too (a library without the theme ignores its switch).
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, BOTS_SRC, PROJECT_DIR, TMP_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const out = (s = '') => process.stdout.write(s + '\n');

if (args.child) {
    await child(JSON.parse(args.child));
    process.exit(0);
}

const WORLDS = {
    all: '1000:300:1:3180,3240;500:1000:2:3185,3436;250:600:3:3093,3493;500:300:4:3222,3218',
    quick: '100:300:1:3222,3218'
};
const worlds = (WORLDS[args.worlds ?? 'all'] ?? args.worlds).split(';').map(w => {
    const [bots, ticks, seed, at] = w.split(':');
    return { bots: Number(bots), ticks: Number(ticks), seed: Number(seed), at: at.split(',').map(Number) };
});
const SWITCHES = ['lives', 'word', 'period', 'movement', 'outings'];
const on = args.on && args.on !== 'true' ? String(args.on).split(',').filter(Boolean) : [];
for (const k of on) {
    if (!SWITCHES.includes(k)) {
        out(`identity: --on takes ${SWITCHES.join(', ')} (got ${k})`);
        process.exit(2);
    }
}
for (const w of worlds) w.on = on;

// ---- the other library ----
let base = args.base ?? 'HEAD';
let extracted = null;
if (!fs.existsSync(base)) {
    // a git ref: its src and data, under a "type": "module" package as the library's own (web/package.json)
    extracted = path.join(TMP_DIR, `identity-${process.pid}`);
    fs.mkdirSync(extracted, { recursive: true });
    process.on('exit', () => fs.rmSync(extracted, { recursive: true, force: true }));
    const rel = path.relative(PROJECT_DIR, BOTS_DIR);
    const tar = spawnSync('sh', ['-c', `git -C "${PROJECT_DIR}" archive "${base}" "${rel}/src" "${rel}/data" | tar -x -C "${extracted}"`], { encoding: 'utf8' });
    if (tar.status !== 0 || !fs.existsSync(path.join(extracted, rel, 'src'))) throw new Error(`cannot extract the library at ${base}: ${tar.stderr}`);
    fs.writeFileSync(path.join(extracted, path.dirname(path.dirname(rel)), 'package.json'), JSON.stringify({ type: 'module' }));
    base = path.join(extracted, rel, 'src');
} else {
    base = path.resolve(base);
}
out(`identity: ${BOTS_SRC} against ${args.base ?? 'HEAD'}${extracted ? ` (${base})` : ''}${on.length ? `, with ${on.join(', ')} on` : ''}`);

let failed = 0;
for (const w of worlds) {
    const results = {};
    for (const [name, lib] of [
        ['this', BOTS_SRC],
        ['base', base]
    ]) {
        const r = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=4096', process.argv[1], `--child=${JSON.stringify(w)}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_BOTS_SRC: lib } });
        const line = (r.stdout ?? '').split('\n').find(l => l.startsWith('IDENTITY '));
        if (!line) throw new Error(`${name}: no result (exit ${r.status}): ${(r.stderr ?? '').slice(-1500)}`);
        results[name] = JSON.parse(line.slice(9));
    }
    const a = results.this;
    const b = results.base;
    const keys = ['bots', 'fingerprint', 'saves', 'world', 'humanBytes', 'humanBytesHash', 'rngCalls'];
    const differ = keys.filter(k => a[k] !== b[k]);
    const ok = differ.length === 0 && a.errors === 0 && b.errors === 0;
    if (!ok) failed++;
    out(`${ok ? 'ok  ' : 'FAIL'} ${w.bots} bots × ${w.ticks} ticks, seed ${w.seed}, at ${w.at.join(',')}: ${a.bots} bots, fingerprint ${a.fingerprint}, saves ${a.saves}, world ${a.world}, ${a.humanBytes} bytes ${a.humanBytesHash}, ${a.rngCalls} draws; tick ${a.tickMs} ms (base ${b.tickMs} ms)`);
    if (differ.length) out(`     differ: ${differ.map(k => `${k} ${a[k]} / ${b[k]}`).join(', ')}`);
    if (a.errors || b.errors) out(`     errors: ${a.errors} / ${b.errors} ${JSON.stringify(a.firstErrors.concat(b.firstErrors)).slice(0, 600)}`);
}
process.exit(failed ? 1 : 0);

// ---- one world with the library in LC_BOTS_SRC ----
async function child({ bots: N, ticks: TICKS, seed, at, on = [] }) {
    let draws = 0;
    {
        let s = seed >>> 0 || 1;
        Math.random = () => {
            draws++;
            s = (s + 0x6d2b79f5) | 0;
            let t = Math.imul(s ^ (s >>> 15), 1 | s);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    const logs = { errors: 0, firstErrors: [] };
    for (const level of ['log', 'info', 'debug', 'warn']) console[level] = () => {};
    console.error = (...a) => {
        const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
        if (text.includes('ExperimentalWarning') || text.includes('--trace-warnings')) return;
        logs.errors++;
        if (logs.firstErrors.length < 3) logs.firstErrors.push(text.slice(0, 300));
    };
    const engineDir = prepareEngineClone(`identity-${seed}`, simWorldConfig({ members: true, xpRate: 10 }));
    process.chdir(engineDir);
    await stubWorkerThreads();
    const lib = await importTs(path.join(BOTS_DIR, 'test/lib/simworld.ts'), path.join(engineDir, 'tsconfig.json'));
    const { World, BotManager, InvType } = lib;
    const epoch = 1_760_000_000_000;
    Date.now = () => epoch + World.currentTick * 600;

    const sim = await lib.Sim.create({ bots: N, members: true, debug: false, ageNewBots: true, ackLogouts: true, extra: { timing: {} }, ...Object.fromEntries(on.map(k => [k, true])) });
    const bytes = crypto.createHash('sha256');
    let humanBytes = 0;
    const send = sim.socket.send.bind(sim.socket);
    sim.socket.send = src => {
        bytes.update(src);
        humanBytes += src.length;
        return send(src);
    };
    sim.addHuman(at[0], at[1], 0);
    // the spawn ramp (at most 400 ticks), then the run
    let ramp = 0;
    while (ramp < 400) {
        sim.tick();
        ramp++;
        const st = BotManager.stats();
        if (st.spawned + st.skipped.length >= N && ramp > 5) break;
    }
    const t0 = performance.now();
    for (let i = 0; i < TICKS; i++) sim.tick();
    const tickMs = +((performance.now() - t0) / TICKS).toFixed(1);

    const fp = crypto.createHash('sha256');
    const saves = crypto.createHash('sha256');
    const list = [...BotManager.activeBots()].sort((a, b) => (a.username < b.username ? -1 : 1));
    for (const p of list) {
        const b = BotManager.botFor(p);
        fp.update(`${p.username}|${p.x},${p.z},${p.level}|${[...p.stats].join(',')}|${b?.currentTask?.name ?? '-'}|${p.getInventory(InvType.INV)?.items.map(i => (i ? `${i.id}x${i.count}` : '')).join(',')}\n`);
        saves.update(p.username);
        saves.update(p.save());
    }
    fp.update(`human ${sim.human.x},${sim.human.z},${sim.human.level}`);
    const world = crypto.createHash('sha256').update(JSON.stringify(BotManager.exportWorld())).digest('hex').slice(0, 16);
    const result = {
        bots: list.length,
        fingerprint: fp.digest('hex').slice(0, 16),
        saves: saves.digest('hex').slice(0, 16),
        world,
        humanBytes,
        humanBytesHash: bytes.digest('hex').slice(0, 16),
        rngCalls: draws,
        ramp,
        tickMs,
        errors: logs.errors,
        firstErrors: logs.firstErrors
    };
    out(`IDENTITY ${JSON.stringify(result)}`);
}
