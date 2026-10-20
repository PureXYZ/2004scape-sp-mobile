#!/usr/bin/env node
// The bots tests (docs/BOTS.md §7, runtime): engine-bots.js over the real page protocol, against the stub bot library
// (test/fixtures/stub-bots) by default or the real one (web/engine/bots/src) with --real.
//
//   node --expose-gc --experimental-vm-modules web/engine/test/bots.test.mjs [--real] [--only=build|vm|jsc] [--nojit]
//        [--bots=N] [--no-build] [--verbose]
//
//  1. build: both bundles; engine.js, boot.js and the 37 vanilla files byte-identical with and without the bots build;
//     no bot code or marker in engine.js; scripts.bin made from the staged script.dat; no local folder named in the
//     output (the scripts' source paths are relative); the library guards (a Node built-in, process.env or the
//     database in the library fail the build, also with the library behind a symlink);
//     the same bundles from a symlinked Server and library.
//  2. the seven boots of lib/bots-session.mjs (main, restore, living, unreadable, bak, corrupt, off) on ONE Documents folder,
//     each in a fresh process: the Node vm sandbox (lib/vm-worker.mjs), then the JavaScriptCore shell with the JIT
//     (jsc-harness.mjs; --nojit adds --useJIT=false --useWasm=false, slow). Before 'bak' bots.sav is overwritten with
//     garbage, before 'corrupt' bots.sav.bak too. Then 'broken': a build whose bot library throws while it loads
//     (boot.js falls back to engine.js), and 'nobundle': bots asked of a build without them (the vanilla build).
// A child runs one boot: --child=<boot> --docs=<dir> (vm); --child=measure is test/measure.mjs --bots's vm run.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BOTS_LIB, buildEngine } from '../build.mjs';
import { decodeScriptsBin } from '../bots/content/compile.mjs';
import { BOOT_ORDER, DELETED_HUMAN, runBotsBoot, runBotsMeasure, withFriendLists } from './lib/bots-session.mjs';
import { makeFixture, IOS, SERVER } from './lib/fixture.mjs';
import { listSaveIndex } from './lib/storage.mjs';
import { createVmWorker } from './lib/vm-worker.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc';
const STUB = path.join(HERE, 'fixtures/stub-bots');
const args = process.argv.slice(2);
const arg = name => (args.find(a => a.startsWith(`--${name}=`)) ?? '').split('=').slice(1).join('=') || undefined;
const REAL = args.includes('--real');
const LIB = REAL ? BOTS_LIB : STUB;
const N = Number(arg('bots') ?? 10);
const PROFILE = 'botstest';
const TMP = path.join(IOS, 'build/tmp/engine');
const OUT = path.join(TMP, REAL ? 'out-bots-real' : 'out-bots-stub');
const OUT_BROKEN = path.join(TMP, 'out-bots-broken'); // the stub library throwing while it loads
const OUT_VANILLA = path.join(TMP, 'out-bots-vanilla'); // no bots bundle (boot 'nobundle')
const VERBOSE = args.includes('--verbose');
// ticks at 100 ms in the sessions: a name collision waits 30 ticks (3 s), repeated log lines are summarised per 20 ticks
const TEST_OPTIONS = { botsCollisionTicks: 30, botsLogWindowTicks: 20 };
const only = arg('only');

// The living world's sessions (bots/src/port/BotSessions.ts): none in the boots that count on a fixed set of bots (the
// real library would otherwise log bots out and bring newcomers in the middle of their checks); short ones in 'living'.
const STEADY = { session: [1e7, 1e7], away: [1e7, 1e7], newcomer: [1e7, 1e7], newCharacterCount: [0, 0] };
const LIVING = { session: [40, 80], away: [20, 60], newcomer: [60, 100], newCharacterCount: [1, 1], newCharacterDelay: [5, 10], returnGap: [3, 10], emptyWorld: 20, busyGiveUp: 200, leaveGiveUp: 30 };

// what every boot gets (the session's env additions, docs/BOTS.md §7)
function bootSettings(boot) {
    const profile = boot === 'off' ? 'enginetest' : PROFILE;
    const bots = boot === 'off' ? { count: 0 } : { count: N, timing: boot === 'living' ? LIVING : STEADY };
    return { botCount: N, profile, spawnPerTick: 5, stub: !REAL, config: { node: { profile }, bots } };
}

// ---- child: one boot in the vm sandbox --------------------------------------------------------------------------
if (arg('child') === 'measure') {
    const worker = createVmWorker({ gameDir: arg('out'), documentsDir: arg('docs') });
    Object.assign(worker.env, {
        fixture: makeFixture(),
        config: { node: { profile: 'measure' }, bots: { count: N, ...(Number(arg('searches')) > 0 ? { pathSearchesPerTick: Number(arg('searches')) } : {}) } },
        heap: () => {
            globalThis.gc?.();
            globalThis.gc?.();
            return +(process.memoryUsage().heapUsed / 1048576).toFixed(1);
        }
    });
    await worker.boot();
    const row = await runBotsMeasure(worker.env, { ticks: Number(arg('ticks') ?? 100), rate: Number(arg('rate') ?? 300) });
    console.log('[bots] MEASURE ' + JSON.stringify({ js: `V8 ${process.versions.v8} (Node vm; heap = heapUsed)`, ...row }));
    process.exit(0);
}
if (arg('child')) {
    const boot = arg('child');
    const worker = createVmWorker({ gameDir: arg('out'), documentsDir: arg('docs'), testOptions: TEST_OPTIONS });
    Object.assign(worker.env, { verbose: VERBOSE, fixture: makeFixture() }, bootSettings(boot));
    await worker.boot();
    const result = await runBotsBoot(worker.env, boot);
    result.bodyKinds = [...worker.native.bodyKinds];
    console.log('[bots] RESULT ' + JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
}

// ---- launcher ---------------------------------------------------------------------------------------------------
const summary = [];
let failed = 0;
const report = (group, ok, detail) => {
    summary.push({ group, ok, ...detail });
    if (!ok) failed++;
    console.log(`[bots] ${ok ? 'PASS' : 'FAIL'}  ${group}${detail ? `  ${JSON.stringify(detail)}` : ''}`);
};
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function filesUnder(dir) {
    const out = [];
    const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else out.push(path.relative(dir, p));
        }
    };
    walk(dir);
    return out.sort();
}

console.log(`[bots] library: ${path.relative(IOS, LIB)} (${REAL ? 'real' : 'stub'}), ${N} bots`);
if (!args.includes('--no-build') && (!only || only === 'build')) {
    // 1a. both bundles, and engine.js etc. exactly as a build without the bots
    const info = await buildEngine({ out: OUT, bots: { lib: LIB } });
    const vanillaOut = OUT_VANILLA;
    await buildEngine({ out: vanillaOut, bots: false });
    const withBots = filesUnder(OUT);
    const without = filesUnder(vanillaOut);
    const added = withBots.filter(f => !without.includes(f));
    const differing = without.filter(f => !withBots.includes(f) || sha(path.join(OUT, f)) !== sha(path.join(vanillaOut, f)));
    report('build: every vanilla file identical with and without the bots build', differing.length === 0, { vanillaFiles: without.length, differing });
    report('build: the bots build adds only engine-bots.js, vfs-manifest-bots.json, vfs/bots/scripts.bin', added.join() === ['engine/engine-bots.js', 'engine/vfs-manifest-bots.json', 'engine/vfs/bots/scripts.bin'].join(), { added });
    const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'engine/vfs-manifest.json'), 'utf8'));
    const engineJs = fs.readFileSync(path.join(OUT, 'engine/engine.js'), 'utf8');
    const botsJs = fs.readFileSync(path.join(OUT, 'engine/engine-bots.js'), 'utf8');
    const markers = ['LCBOTS01', '[bots]', 'P_ISBOT'];
    report('build: engine.js has the 37 vanilla files and no bot marker; engine-bots.js has all', manifest.length === 37 && markers.every(m => !engineJs.includes(m) && botsJs.includes(m)), { files: manifest.length });
    const header = decodeScriptsBin(fs.readFileSync(path.join(OUT, 'engine/vfs/bots/scripts.bin')));
    report('build: scripts.bin was diffed against the staged script.dat', header.datSha256 === sha(path.join(OUT, 'engine/vfs/data/pack/server/script.dat')) && header.scripts.length > 0, { scripts: header.scripts.length, commands: header.commands });
    // the script compiler writes absolute source paths; build.mjs ships them relative (scripts.bin's too)
    const local = [...new Set([IOS, fs.realpathSync(IOS), SERVER, fs.realpathSync(SERVER), os.homedir()])].filter(p => p.length > 1);
    const naming = filesUnder(OUT).filter(f => {
        const buf = fs.readFileSync(path.join(OUT, f));
        return local.some(p => buf.includes(p));
    });
    report('build: no file names a local folder (the repo, the upstream checkouts, the home folder)', naming.length === 0, { naming });
    report('build: sizes', true, { engineJs: info.bundle.bytes, engineBotsJs: info.bots.bundle.bytes, gzip: info.bots.bundle.gzip, libModules: info.bots.bundle.libModules, overlayBytes: info.bots.overlay.bytes, ms: info.ms });

    // 1a'. the same bundles when the upstream folder and the library are reached through symlinks (esbuild sees real paths)
    const links = path.join(TMP, 'bots-links');
    fs.rmSync(links, { recursive: true, force: true });
    fs.mkdirSync(links, { recursive: true });
    fs.symlinkSync(fs.realpathSync(SERVER), path.join(links, 'Server'));
    fs.symlinkSync(fs.realpathSync(LIB), path.join(links, 'lib'));
    const linkedOut = path.join(TMP, 'out-bots-linked');
    const linked = await buildEngine({ out: linkedOut, engineDir: path.join(links, 'Server/engine'), contentDir: path.join(links, 'Server/content'), bots: { lib: path.join(links, 'lib') } });
    const same = f => sha(path.join(OUT, f)) === sha(path.join(linkedOut, f));
    report('build: through a symlinked Server and library, the same engine.js and engine-bots.js (modules counted alike)', same('engine/engine.js') && same('engine/engine-bots.js') && linked.bundle.inputs === info.bundle.inputs && linked.bots.bundle.libModules === info.bots.bundle.libModules, { inputs: [info.bundle.inputs, linked.bundle.inputs], libModules: [info.bots.bundle.libModules, linked.bots.bundle.libModules] });
    fs.rmSync(linkedOut, { recursive: true, force: true });

    // 1b. the library guards: each of these must fail the bots build
    // (each a top-level side effect, so that nothing is tree-shaken away)
    const guards = [
        ['a Node built-in', `import fs from 'fs';\n(globalThis as any).__guard = fs;\n`, /must not import Node built-ins/],
        ['a Node built-in (the library behind a symlink)', `import fs from 'fs';\n(globalThis as any).__guard = fs;\n`, /must not import Node built-ins/, true],
        ['process.env', `(globalThis as any).__guard = process.env.BOTS_GUARD;\n`, /references process\.env\.BOTS_GUARD/],
        ['the database', `import { db } from '#/db/query.js';\n(globalThis as any).__guard = db;\n`, /must not import the database/],
        ['a wrong-case import', `import { BotManager as M } from '#/engine/bot/botmanager.js';\n(globalThis as any).__guard = M;\n`, /differs in case|cannot resolve/],
        ['a wrong-case relative import', `import { BotChat as C } from './port/botchat.js';\n(globalThis as any).__guard = C;\n`, /differ in case/]
    ];
    for (const [what, code, expect, viaLink] of guards) {
        const lib = path.join(TMP, 'bots-guard-lib');
        fs.rmSync(lib, { recursive: true, force: true });
        fs.cpSync(STUB, lib, { recursive: true });
        fs.rmSync(path.join(lib, 'tsconfig.json'));
        fs.writeFileSync(path.join(lib, 'Bad.ts'), code);
        fs.appendFileSync(path.join(lib, 'BotManager.ts'), `\nimport './Bad.js';\n`);
        if (viaLink) {
            fs.rmSync(path.join(links, 'guard-lib'), { force: true });
            fs.symlinkSync(lib, path.join(links, 'guard-lib'));
        }
        let error = '';
        try {
            await buildEngine({ out: path.join(TMP, 'out-bots-guard'), bots: { lib: viaLink ? path.join(links, 'guard-lib') : lib } });
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
        report(`build guard: ${what} in the library fails the build`, expect.test(error), { error: error.split('\n')[0].slice(0, 200) });
    }
    fs.rmSync(path.join(TMP, 'bots-guard-lib'), { recursive: true, force: true });
    fs.rmSync(path.join(TMP, 'out-bots-guard'), { recursive: true, force: true });
    fs.rmSync(links, { recursive: true, force: true });

    // 1c. a library that throws while it loads: built fine; boot.js must fall back to engine.js (boot 'broken')
    const broken = path.join(TMP, 'bots-broken-lib');
    fs.rmSync(broken, { recursive: true, force: true });
    fs.cpSync(STUB, broken, { recursive: true });
    fs.rmSync(path.join(broken, 'tsconfig.json'));
    fs.appendFileSync(path.join(broken, 'BotManager.ts'), `\nthrow new Error('the bot library failed to load (test)');\n`);
    await buildEngine({ out: OUT_BROKEN, bots: { lib: broken } });
    fs.rmSync(broken, { recursive: true, force: true });
} else if (!fs.existsSync(path.join(OUT, 'engine/engine-bots.js')) || !fs.existsSync(path.join(OUT_BROKEN, 'engine/engine-bots.js')) || !fs.existsSync(path.join(OUT_VANILLA, 'engine/engine.js'))) {
    console.error(`[bots] ${path.relative(IOS, OUT)}, ${path.relative(IOS, OUT_BROKEN)} or ${path.relative(IOS, OUT_VANILLA)} has no build (${args.includes('--no-build') ? 'drop --no-build' : `--only=${only} does not build: run with --only=build first`})`);
    process.exit(2);
}

const runtimes = [
    { name: 'vm', run: (boot, run, out) => spawnSync(process.execPath, ['--expose-gc', '--experimental-vm-modules', fileURLToPath(import.meta.url), `--child=${boot}`, `--docs=${path.join(run, 'Documents')}`, `--out=${out}`, ...(REAL ? ['--real'] : []), `--bots=${N}`, ...(VERBOSE ? ['--verbose'] : [])], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 20 * 60 * 1000 }) },
    { name: 'jsc', flags: [], slow: 1 },
    ...(args.includes('--nojit') ? [{ name: 'jsc-nojit', flags: ['--useJIT=false', '--useWasm=false'], slow: 10 }] : [])
]
    .filter(r => !only || only === r.name || (only === 'jsc' && r.name.startsWith('jsc')))
    .filter(r => r.name === 'vm' || fs.existsSync(JSC));

for (const rt of runtimes) {
    fs.mkdirSync(TMP, { recursive: true });
    const run = fs.mkdtempSync(path.join(TMP, `bots-${rt.name}-`));
    const docs = path.join(run, 'Documents');
    // jsc's writeFile cannot create directories
    for (const d of [`players/${PROFILE}`, `bots/${PROFILE}`, 'players/enginetest']) fs.mkdirSync(path.join(docs, d), { recursive: true });
    fs.writeFileSync(path.join(run, 'fixture.json'), JSON.stringify(makeFixture()));
    console.log(`\n[bots] ===== ${rt.name} =====`);
    for (const boot of [...BOOT_ORDER, 'broken', 'nobundle']) {
        const gameDir = boot === 'broken' ? OUT_BROKEN : boot === 'nobundle' ? OUT_VANILLA : OUT;
        const botsSav = path.join(docs, `bots/${PROFILE}/bots.sav`);
        if (boot === 'bak' || boot === 'corrupt') fs.writeFileSync(botsSav, crypto.randomBytes(200));
        if (boot === 'corrupt') fs.writeFileSync(`${botsSav}.bak`, Buffer.from('LCBOTS01\x00\x05garbage'));
        if (boot === 'living') fs.writeFileSync(botsSav, withFriendLists(fs.readFileSync(botsSav), DELETED_HUMAN, { friends: ['somebody'], ignores: [] }));
        const t = Date.now();
        let r;
        if (rt.run) {
            r = rt.run(boot, run, gameDir);
        } else {
            fs.writeFileSync(path.join(run, 'save-index.json'), JSON.stringify(listSaveIndex(docs)));
            fs.writeFileSync(path.join(run, 'bots.json'), JSON.stringify({ ...bootSettings(boot), testOptions: TEST_OPTIONS }));
            r = spawnSync(JSC, [...rt.flags, '-m', path.join(HERE, 'jsc-harness.mjs'), '--', run, gameDir, `--slow=${rt.slow}`, `--bots-boot=${boot}`, ...(VERBOSE ? ['--verbose'] : [])], { cwd: HERE, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 40 * 60 * 1000 });
        }
        const out = (r.stdout ?? '') + (r.stderr ?? '');
        const line = out.split('\n').find(l => / RESULT /.test(l) && l.startsWith('['));
        if (VERBOSE) console.log(out.split('\n').filter(l => !/ RESULT /.test(l) && !l.startsWith('Could not open file')).join('\n'));
        if (!line) {
            report(`${rt.name} ${boot}`, false, { exit: r.status, signal: r.signal, tail: out.trim().split('\n').slice(-25).join('\n') });
            continue;
        }
        const res = JSON.parse(line.slice(line.indexOf('RESULT ') + 7));
        for (const c of res.checks.filter(c => !c.ok)) console.log(`  FAILED: [${c.phase}] ${c.name} ${c.detail !== undefined ? JSON.stringify(c.detail).slice(0, 600) : ''}`);
        if (res.logs?.errors?.length && !res.ok) console.log(`  worker errors: ${res.logs.errors.slice(0, 5).map(e => e.split('\n')[0]).join(' | ')}`);
        const bodies = (res.bodyKinds ?? ['ArrayBuffer']).every(k => k === 'ArrayBuffer');
        report(`${rt.name} ${boot}`, res.ok && bodies, { passed: res.passed, failed: res.failed, seconds: Math.round((Date.now() - t) / 1000), ...(res.metrics?.botTicks ? { botTick: res.metrics.botTicks } : {}), ...(res.vanillaSession ? { vanillaSession: res.vanillaSession } : {}) });
    }
    fs.rmSync(run, { recursive: true, force: true });
}

fs.writeFileSync(path.join(TMP, `bots-result-${REAL ? 'real' : 'stub'}.json`), JSON.stringify(summary, null, 2));
const checks = summary.reduce((n, s) => n + (s.passed ?? (s.ok ? 1 : 0)), 0);
console.log(`\n[bots] ${failed ? 'FAIL' : 'PASS'}: ${summary.length - failed}/${summary.length} groups (${checks} checks), ${REAL ? 'real library' : 'stub library'}`);
process.exit(failed ? 1 : 0);
