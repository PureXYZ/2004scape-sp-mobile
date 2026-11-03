#!/usr/bin/env node
// The soak tooling without a device (docs/BUILDING.md §4 "A/B on the phone"): every soak in web/test/perf/ loads and a
// wrong one is refused; the page's soak lines become the run's files (parts joined, other runs' left out); a run's
// summary from made-up output of each kind (an iPhone's xctrace summaries, a simulator's samples, Android's windows);
// the A/B table; and the xctrace export reader's id/ref resolution on a small table.
//
//   node web/test/perf/perf.test.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compare, markdown } from './compare.mjs';
import { SoakLines, launchTestArg, listSoaks, loadSoak, procStatScript, soakBuildProblem } from './soak.mjs';
import { summarizeRun, summaryText } from './summary.mjs';
import { readTable } from './xctrace.mjs';

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
    if (ok) {
        passed++;
    } else {
        failed++;
    }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}
const throws = fn => {
    try {
        fn();
        return null;
    } catch (error) {
        return error.message;
    }
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-perf-test-'));
const write = (dir, file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
};
const jsonl = list => `${list.map(v => JSON.stringify(v)).join('\n')}\n`;

// ---- the soaks
const soaks = listSoaks();
check(`every soak in web/test/perf/ loads (${soaks.length})`, soaks.length >= 10 && soaks.every(s => !throws(() => loadSoak(s.name))), soaks.map(s => [s.name, throws(() => loadSoak(s.name))]).filter(([, e]) => e));
check('--bots takes the soak\'s place', loadSoak('smoke', { bots: 25 }).bots === 25 && loadSoak('smoke').bots === 0);
const bad = path.join(tmp, 'bad.json');
fs.writeFileSync(bad, JSON.stringify({ bots: 0, phases: [{ name: 'a', sec: 5 }, { name: 'b', where: 'title', sec: 5 }, { name: 'a', sec: 0, tele: 'x', bogus: 1, traces: [{ set: 'zz', at: 0, sec: 1 }] }] }));
const why = throws(() => loadSoak(bad)) ?? '';
check('a wrong soak is refused with every reason', ['a title phase after a phase in the world', 'a name of its own', 'unknown bogus', 'sec, the', 'tele is', 'a trace is'].every(s => why.includes(s)), why);
// (bots ideas, round 4: I model) a phase's Settings › Bot chat: the sheet's own values only, and in the world
fs.writeFileSync(path.join(tmp, 'chat.json'), JSON.stringify({ bots: 0, phases: [{ name: 'a', sec: 5, settings: { botChat: 'local', botThink: true, botAmbient: 'model' } }] }));
fs.writeFileSync(path.join(tmp, 'badchat.json'), JSON.stringify({ bots: 0, phases: [{ name: 't', where: 'title', sec: 5, settings: { botAmbient: 'model' } }, { name: 'a', sec: 5, settings: { botAmbient: 'on', botChat: 'local' } }, { name: 'b', sec: 5, settings: {} }] }));
const chatWhy = throws(() => loadSoak(path.join(tmp, 'badchat.json'))) ?? '';
check("a phase's settings (bots ideas, round 4): Bot chat's own values pass; another value, an empty one, or one at the title is refused", !throws(() => loadSoak(path.join(tmp, 'chat.json'))) && chatWhy.includes('phases[1] (a): settings is') && chatWhy.includes('phases[2] (b): settings is') && chatWhy.includes("phases[0] (t): Bot chat's settings are set in the world"), chatWhy);
check("the heat test's soaks (bots ideas, round 4): lm-ambient-500 (runs 1 and 2) and lm-ambient-1000 (run 3), Bots' own talk on Model in the hub's phases, its baseline on Rules", ['lm-ambient-500', 'lm-ambient-1000'].every(n => { const s = loadSoak(n); return s.phases.some(p => p.name === 'hub-baseline' && p.settings?.botAmbient === 'rules') && s.phases.filter(p => p.name.startsWith('hub-') && p.name !== 'hub-baseline').every(p => p.settings?.botAmbient === 'model' && p.lm?.everySec === 30) && Array.isArray(s.notes); }) && loadSoak('lm-ambient-500').bots === 500 && loadSoak('lm-ambient-1000').bots === 1000 && loadSoak('lm-ambient-500').phases.some(p => p.name === 'cap-30min' && p.lm?.everySec === 12 && p.lm.think === false));
fs.writeFileSync(path.join(tmp, 'nobots.json'), '{"phases":[{"name":"a","sec":1}]}');
check('a soak without bots is refused', /bots: a count of bots/.test(throws(() => loadSoak(path.join(tmp, 'nobots.json'))) ?? ''));
const arg = launchTestArg({ soak: { name: 'x', bots: 0 }, launch: 2, clean: 1, run: 'r1' });
check('the launch argument is base64 JSON', JSON.parse(Buffer.from(arg, 'base64').toString()).launch === 2 && /^[A-Za-z0-9+/=]+$/.test(arg));
const profileTag = '<script>window.__lcTestProfile = "bench";</script>';
check('a build for another profile or without the prompts cannot run a soak (--no-build)', soakBuildProblem({ index: '<html>', autotest: null }, loadSoak('title'), 'bench')?.includes('profile bench') && soakBuildProblem({ index: profileTag, autotest: '{}' }, { phases: [{ lm: {} }] }, 'bench')?.includes('prompts') && soakBuildProblem({ index: profileTag, autotest: '{}' }, loadSoak('title'), 'bench') === null);

// ---- the page's lines
const linesDir = path.join(tmp, 'lines');
fs.mkdirSync(linesDir);
const lines = new SoakLines(linesDir, { run: 'r1' });
const big = JSON.stringify({ run: 'r1', name: 'p1', filler: 'x'.repeat(40000) });
const parts = [big.slice(0, 15000), big.slice(15000, 30000), big.slice(30000)];
lines.line(`12:00:00.000 [js:log] LCTEST INFO soak-raw-part soak-raw-r1-1-1 2/3 ${parts[1]}`);
lines.line(`12:00:00.000 [js:log] LCTEST INFO soak-startup {"run":"r1","launch":1,"clean":false}`);
lines.line(`12:00:00.000 [js:log] LCTEST INFO soak-startup {"run":"r0","launch":1,"clean":true}`);
lines.line(`12:00:00.000 [js:log] LCTEST INFO soak-raw-part soak-raw-r1-1-1 1/3 ${parts[0]}`);
lines.line(`12:00:00.000 [js:log] LCTEST INFO soak-startup {"run":"r1","launch":2,"clean":true}`);
lines.line(`LCTEST INFO soak-raw-part soak-raw-r1-1-1 3/3 ${parts[2]}`);
const raw = fs.readFileSync(path.join(linesDir, 'soak-raw.jsonl'), 'utf8').trim().split('\n');
const startup = fs.readFileSync(path.join(linesDir, 'startup.jsonl'), 'utf8').trim().split('\n');
check('a value in parts is joined once all have come, in any order', raw.length === 1 && JSON.parse(raw[0]).filler.length === 40000);
check('only this run\'s values; the clean launches counted', startup.length === 2 && lines.cleanLaunches === 1);

// ---- a run's summary: an iPhone run (xctrace summaries made up), a simulator run, an Android run
function pagePhase(name, kind, { fps = 50, draw = 5, tick = 8, bots = null, footprint = 150 } = {}) {
    const d = (avg, p50, p95, p99, max) => ({ n: 100, avg, p50, p90: p95, p95, p99, max, sum: avg * 100 });
    return {
        run: 'r1',
        name,
        kind,
        sec: 60,
        window: { start: 1000, end: 61000 },
        bots: 0,
        crowdMax: 3,
        fps: { median: fps, min: fps - 2, samples: 60 },
        frames: { perSec: fps, interval: d(20, 20, 21, 22, 40), over25: 3, over33: 2, over50: 1, over100: 0, draw: d(draw, draw, draw + 1, draw + 2, draw + 10), loopPerSec: fps, loop: d(1, 1, 2, 3, 5) },
        raf: { perSec: 60, interval: d(16.7, 16.7, 17, 18, 30), over20: 1, over34: 0, over50: 0, cbMs: d(0.5, 0.5, 1, 1, 2) },
        ticks: { n: 100, tickMs: d(tick, tick, tick * 1.3, tick * 1.6, tick * 3), callbackMs: d(tick + 0.1, tick, tick * 1.3, tick * 1.6, tick * 3), startInterval: d(600, 600, 601, 605, 609), phasesAvgMs: { cycle: tick, world: 1.4, npc: 4, player: 0.5, zone: 0.3, clientOut: 0.2, cleanup: 0.7 }, botsMs: bots ? d(bots, bots, bots * 2, bots * 3, bots * 4) : null, clamps: 0, state: 'running', players: 1, npcs: 7322 },
        native: { footprintMB: [footprint, footprint + 2], availableMB: [1500, 1490], thermal: ['nominal', 'nominal'] },
        audio: 'running',
        music: { active: true, wave: true },
        lm: null,
        engineErrors: 0
    };
}
const startupRecord = (launch, clean, title) => ({ run: 'r1', launch, clean, workerCreated: 120, engineBooted: 500, preloadMs: 140, evalMs: 150, worldStart: 520, worldStarted: 1400, firstTickEnd: 1410, engineReady: 1420, readyMs: 890, clientCreated: 400, client100: title - 10, titleReady: title, loaderFade: title + 120, native: { footprintMB: 15 } });

function iosRun(dir, { gpu = 31.7, wc = 33.2, fps = 50, title = 1500 } = {}) {
    write(dir, 'result.json', JSON.stringify({ target: 'device', summary: 'pass=5 fail=0', soak: 'render', bots: 0, port: 'abc123' }));
    write(dir, 'soak.jsonl', jsonl([pagePhase('title', 'title', { fps }), pagePhase('lumbridge-idle', 'ingame', { fps })]));
    write(dir, 'startup.jsonl', jsonl([startupRecord(1, false, title + 300), startupRecord(2, true, title), startupRecord(3, true, title + 20)]));
    const traces = [];
    for (const phase of ['title', 'lumbridge-idle']) {
        const name = `${phase}.am`;
        traces.push({ name, set: 'am', seconds: 60, code: 0 });
        fs.mkdirSync(path.join(dir, 'traces', `${name}.trace`), { recursive: true });
        // (made after the trace folder: summary.mjs keeps a summary newer than its trace)
        write(dir, `traces/${name}.summary.json`, JSON.stringify({ trace: `${name}.trace`, activitySpanSec: 60, totalCpuPct: 130, thermal: ['Nominal'], coreAnimation: { samples: 60, fpsMedian: 50, gpuUtilPctAvg: 33 }, processes: [{ name: 'com.apple.WebKit.GPU', pid: 2, cpuPct: gpu, footprintMB: { min: 20, max: 37, last: 21 }, compressedMB: { last: 5 } }, { name: 'com.apple.WebKit.WebContent', pid: 3, cpuPct: wc, footprintMB: { min: 600, max: 710, last: 700 }, compressedMB: { last: 40 } }, { name: 'backboardd', pid: 75, cpuPct: 17 }, { name: 'sysmond', pid: 9, cpuPct: 9 }, { name: 'LostCity', pid: 4, cpuPct: 2.7, footprintMB: { min: 14, max: 15, last: 15 } }] }));
    }
    write(dir, 'traces/traces.jsonl', jsonl(traces));
}
const runA = path.join(tmp, 'device-A');
iosRun(runA);
const s = summarizeRun(runA);
const idle = s.phases.find(p => p.name === 'lumbridge-idle');
check('an iPhone run: the page\'s numbers per phase', idle?.page.clientFps === 50 && idle.page.tickMs.avg === 8 && idle.page.framesOver33PerMin === 2 && idle.page.tickPhasesMs.npc === 4 && idle.page.appFootprintMB.max === 152, idle?.page);
check('an iPhone run: xctrace per process role, instruments left out of the total', idle?.recording?.source === 'xctrace' && idle.recording.cpuPct['GPU process'] === 31.7 && idle.recording.cpuPct.instruments === 9 && idle.recording.cpuPct.totalWithoutInstruments === 121 && idle.recording.footprintMB.WebContent.last === 700 && idle.recording.compressedMB.WebContent === 40 && idle.recording.gpuUtilPct === 33, idle?.recording);
check('the start-up: clean launches only, medians and ranges', s.startup.clean === 2 && s.startup.stats.titleReady.median === 1510 && s.startup.stats.titleReady.min === 1500 && s.startup.stats.worldStartMs.median === 880, s.startup.stats);
check('the summary as text names every phase', /title \(title, 60 s/.test(summaryText(s)) && /lumbridge-idle \(ingame/.test(summaryText(s)) && /xctrace: CPU % of a core: .*GPU process 31.7/.test(summaryText(s)));

const sim = path.join(tmp, 'sim-run');
write(sim, 'result.json', JSON.stringify({ target: 'simulator', summary: 'pass=3 fail=0', soak: 'smoke', bots: 25 }));
write(sim, 'soak.jsonl', jsonl([pagePhase('lumbridge-idle', 'ingame', { bots: 2.5 }), { run: 'r1', name: 'background', kind: 'background', sec: 15, back: true, events: ['background', 'pause', 'foreground', 'resume'], ticksWhileAway: 0, native: { footprintMB: [150, 150], thermal: ['nominal', 'nominal'] } }]));
write(sim, 'samples/lumbridge-idle.am.json', JSON.stringify({ name: 'lumbridge-idle.am', startedAt: 0, endedAt: 15000, host: "the Mac's CPU: relative only", processes: [{ role: 'app', pid: 1, cpuPct: 4 }, { role: 'WebContent', pid: 2, cpuPct: 60, footprintMB: 400 }, { role: 'GPU', pid: 3, cpuPct: 20, rssMB: 90 }] }));
const ss = summarizeRun(sim);
check('a simulator run: ps samples per role, the bots\' share, the background phase', ss.phases[0].recording?.source === 'simulator' && ss.phases[0].recording.cpuPct.WebContent === 60 && ss.phases[0].recording.cpuPct['GPU process'] === 20 && ss.phases[0].recording.cpuPct.total === 84 && ss.phases[0].page.botsMs.avg === 2.5 && ss.phases[1].page.back === true && ss.phases[1].page.ticksWhileAway === 0, ss.phases.map(p => [p.page, p.recording]));

const android = path.join(tmp, 'emulator-run');
write(android, 'result.json', JSON.stringify({ target: 'emulator', summary: 'pass=3 fail=0', soak: 'lumbridge-idle', bots: 0 }));
write(android, 'soak.jsonl', jsonl([pagePhase('lumbridge-idle', 'ingame')]));
write(android, 'soak/windows.jsonl', jsonl([{ name: 'lumbridge-idle.am', seconds: 10, startedAt: 0, endedAt: 10000, app: 100, renderers: [200], names: { 300: 'surfaceflinger' } }]));
// (a task's stat: pid (comm) state, 10 fields, utime, stime, …; /proc/stat's cpu line: user nice system idle iowait irq softirq steal)
const stat = (ticks, user, idle) => `100 100 (lostcity.main) S ${'0 '.repeat(10)}${ticks.app} 0 0\n200 201 (CrRendererMain) S ${'0 '.repeat(10)}${ticks.renderer} 0 0\n300 300 (surfaceflinger) S ${'0 '.repeat(10)}${ticks.sf} 0 0\ncpu  ${user} 0 0 ${idle} 0 0 0 0 0 0\n`;
write(android, 'soak/lumbridge-idle.am.stat0.txt', stat({ app: 100, renderer: 1000, sf: 50 }, 10000, 50000));
write(android, 'soak/lumbridge-idle.am.stat1.txt', stat({ app: 200, renderer: 1500, sf: 150 }, 10700, 53300));
write(android, 'soak/lumbridge-idle.am.gfxinfo.txt', 'Total frames rendered: 600\nJanky frames: 12 (2.00%)\n50th percentile: 9ms\n99th percentile: 30ms\n');
write(android, 'soak/lumbridge-idle.am.latency.txt', `SurfaceView[io.github.purexyz.scape2004]\n16666666\n${Array.from({ length: 61 }, (_, i) => `0 ${1e9 + i * 16666666} 0`).join('\n')}\n`);
write(android, 'soak/lumbridge-idle.am.mem.txt', 'app 100: pss 110 MB, rss 200 MB\nrenderer 200: pss 420 MB, rss 500 MB\n');
const sa = summarizeRun(android);
const ar = sa.phases[0].recording;
check('an Android run: /proc CPU per process and thread (and the whole system\'s, idle left out), gfxinfo, SurfaceFlinger, PSS', ar?.source === 'android' && ar.cpuPct.app === 10 && ar.cpuPct.renderer === 50 && ar.cpuPct.surfaceflinger === 10 && ar.cpuPct.systemNonIdle === 70 && ar.threads[0].thread === 'CrRendererMain' && ar.gfxinfo.frames === 600 && ar.surfaceFlinger.presentFps === 60 && ar.footprintMB.renderer.last === 420, ar);

// The /proc sampler's shell line as android/test/app-test.mjs gives it to adb (one argument; adb joins its arguments
// with spaces and the device's sh parses that), run by this Mac's sh over a made-up /proc: the same stat files and CPU
// as above. The three-word form it replaced ('sh', '-c', line) is a syntax error once joined: what made every
// Android summary's CPU 0.
const proc = path.join(tmp, 'proc');
const fakeProc = (ticks, user, idle) => {
    fs.rmSync(proc, { recursive: true, force: true });
    for (const [pid, tid, comm, t] of [[100, 100, 'lostcity.main', ticks.app], [200, 201, 'CrRendererMain', ticks.renderer], [300, 300, 'surfaceflinger', ticks.sf]]) {
        write(proc, `${pid}/task/${tid}/stat`, `${tid} (${comm}) S ${'0 '.repeat(10)}${t} 0 0\n`);
    }
    write(proc, 'stat', `cpu  ${user} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0 0 0\n`);
};
const adbShell = (...words) => spawnSync('/bin/sh', ['-c', words.join(' ')], { encoding: 'utf8' });
const sampled = path.join(tmp, 'emulator-run-sampled');
fs.cpSync(android, sampled, { recursive: true });
fakeProc({ app: 100, renderer: 1000, sf: 50 }, 10000, 50000);
const line = procStatScript([100, 200, 300], proc);
const before = adbShell(line);
write(sampled, 'soak/lumbridge-idle.am.stat0.txt', before.stdout);
fakeProc({ app: 200, renderer: 1500, sf: 150 }, 10700, 53300);
write(sampled, 'soak/lumbridge-idle.am.stat1.txt', adbShell(line).stdout);
const old = adbShell('sh', '-c', line);
const sr = summarizeRun(sampled).phases[0].recording;
check('Android\'s /proc sampler: its one shell line (as adb runs it) gives the stat lines the summary reads; the three-word form was a syntax error', before.status === 0 && before.stdout.split('\n').filter(Boolean).length === 4 && sr?.cpuPct.app === 10 && sr.cpuPct.renderer === 50 && sr.cpuPct.surfaceflinger === 10 && sr.cpuPct.systemNonIdle === 70 && old.status !== 0 && /syntax error/.test(old.stderr), { before: before.stdout, cpu: sr?.cpuPct, old: [old.status, old.stderr] });

// ---- A/B
const runB = path.join(tmp, 'device-B');
iosRun(runB, { gpu: 20.5, title: 1300 });
const runA2 = path.join(tmp, 'device-A2');
iosRun(runA2, { gpu: 33.1, title: 1520 });
const runB2 = path.join(tmp, 'device-B2');
iosRun(runB2, { gpu: 21.5, title: 1310 });
const c = compare([runA, runA2], [runB, runB2]);
const gpuRow = c.phases.find(p => p.name === 'lumbridge-idle')?.rows.find(r => r.label === 'CPU GPU process');
check('A/B: medians, ranges, Δ, which way is better, ranges apart', gpuRow?.a.median === 32.4 && gpuRow.b.median === 21 && gpuRow.delta === -11.4 && gpuRow.verdict === 'better' && gpuRow.apart === true, gpuRow);
const titleRow = c.startup?.rows.find(r => r.label === 'title ready');
check('A/B: start-up over every clean launch of the runs', titleRow?.a.n === 4 && titleRow.b.n === 4 && titleRow.a.median === 1520 && titleRow.b.median === 1315 && titleRow.verdict === 'better', titleRow);
const md = markdown(c, ['main', 'branch']);
check('A/B: the markdown table', md.includes('| CPU GPU process (% core) | 32.4 (31.7–33.1) | 21 (20.5–21.5) | -11.4 | -35.2 | better, apart |') && md.includes('### Start-up'), md.split('\n').filter(l => l.includes('GPU process')));

// ---- the xctrace export reader
const xml = path.join(tmp, 'table.xml');
fs.writeFileSync(
    xml,
    `<?xml version="1.0"?>
<trace-query-result>
<node xpath='//trace-toc[1]/run[1]/data[1]/table[8]'><schema name="t"><col><mnemonic>start</mnemonic></col><col><mnemonic>process</mnemonic></col><col><mnemonic>cpu-percent</mnemonic></col><col><mnemonic>stack</mnemonic></col></schema><row><start-time id="1" fmt="00:00.000">0</start-time><process id="2" fmt="com.apple.WebKit.WebContent (22326)"><pid id="3" fmt="22326">22326</pid></process><system-cpu-percent id="4" fmt="16.7%">16.7</system-cpu-percent><backtrace id="5"><frame id="6" name="a &amp; b" addr="0x1"><binary id="7" name="JavaScriptCore"/></frame><frame ref="6"/></backtrace></row>
<row><start-time ref="1"/><process ref="2"/><sentinel/><backtrace ref="5"/></row>
</node></trace-query-result>
`
);
const rows = [];
const columns = readTable(xml, r => rows.push(r));
check('xctrace: columns, values, ref= resolved, entities, sentinels', columns.join() === 'start,process,cpu-percent,stack' && rows.length === 2 && rows[1].process.attrs.fmt === 'com.apple.WebKit.WebContent (22326)' && rows[0]['cpu-percent'].text === '16.7' && rows[1]['cpu-percent'] === null && rows[1].stack.children.length === 2 && rows[1].stack.children[1].attrs.name === 'a & b' && rows[1].stack.children[0].children[0].attrs.name === 'JavaScriptCore', rows);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} of ${passed + failed} checks failed` : `\nall ${passed} checks passed`);
process.exit(failed ? 1 : 0);
