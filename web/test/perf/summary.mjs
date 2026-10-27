#!/usr/bin/env node
// One app-test --soak run as per-phase numbers (docs/BUILDING.md §4 "A/B on the phone"): what the page measured
// (soak.jsonl: the client's frames, the engine's ticks, the app's memory and heat), what was recorded from outside (the
// iPhone's xctrace recordings, a simulator's or Android's samples), and the launches' start-up marks (startup.jsonl).
// app-test runs it at the end of a soak; web/test/perf/compare.mjs puts runs side by side.
//
//   node web/test/perf/summary.mjs <run dir>       # writes <run dir>/summary.json and summary.txt, prints the text
//
// Per phase: the client's frame rate and frame intervals (p50/p95/p99/max, frames over 33/50/100 ms a minute), its draw
// time, the HUD's rAF; the engine's tick (the ticker's duration avg/p50/p95/p99/max, start to start, World's phases, the
// bots' share); the app's footprint and thermal state (native); per process the CPU in % of one core (iPhone: xctrace's
// Activity Monitor; simulator: ps; Android: /proc), the footprints, Core Animation's frame rate and the GPU's
// utilisation, and with Time Profiler the busiest threads. The iPhone's recordings are summarised once
// (traces/<name>.summary.json beside each, web/test/perf/xctrace.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarizeTrace } from './xctrace.mjs';

const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const readJsonl = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const readJson = file => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
const median = list => {
    const d = list.filter(Number.isFinite).sort((a, b) => a - b);
    return d.length ? (d.length % 2 ? d[d.length >> 1] : (d[d.length / 2 - 1] + d[d.length / 2]) / 2) : null;
};

// the iPhone's processes as the report groups them (Activity Monitor names); the instruments' own are left out of the total
const IOS_ROLES = [
    ['WebContent', /WebKit\.WebContent/],
    ['GPU process', /WebKit\.GPU/],
    ['Networking', /WebKit\.Networking/],
    ['app', /^LostCity$/],
    ['backboardd', /^backboardd$/],
    ['audiomxd', /^audiomxd$/],
    ['mediaserverd', /^mediaserverd$/],
    ['SpringBoard', /^SpringBoard$/],
    ['kernel', /^kernel$/],
    ['instruments', /^(sysmond|DTServiceHub|remotepairingdeviced|coresymbolicationd|perfpowermetricd|com\.apple\.dt\.instruments.*|ktrace|kperfd)$/]
];
const roleOf = name => IOS_ROLES.find(([, rx]) => rx.test(name ?? ''))?.[0] ?? null;

/** The page's numbers of one phase (a soak-summary line), flattened for the tables. */
function pagePhase(p) {
    if (p.kind === 'background') {
        return { back: p.back, ticksWhileAway: p.ticksWhileAway, events: p.events, appFootprintMB: p.native?.footprintMB ?? null, thermal: p.native?.thermal ?? null };
    }
    const fr = p.frames ?? {};
    const t = p.ticks ?? {};
    const perMin = n => (Number.isFinite(n) && p.sec > 0 ? round((n * 60) / p.sec) : null);
    const footprints = (p.native?.footprintMB ?? []).filter(Number.isFinite);
    return {
        sec: p.sec,
        bots: p.bots,
        crowdMax: p.crowdMax,
        clientFps: fr.perSec ?? null,
        clientFpsCounter: p.fps?.median ?? null,
        frameMs: fr.interval ? { p50: fr.interval.p50, p95: fr.interval.p95, p99: fr.interval.p99, max: fr.interval.max } : null,
        framesOver33PerMin: perMin(fr.over33),
        framesOver50PerMin: perMin(fr.over50),
        framesOver100PerMin: perMin(fr.over100),
        drawMs: fr.draw ? { avg: fr.draw.avg, p95: fr.draw.p95, max: fr.draw.max } : null,
        rafPerSec: p.raf?.perSec ?? null,
        rafCbMsAvg: p.raf?.cbMs?.avg ?? null,
        tickMs: t.tickMs ? { avg: t.tickMs.avg, p50: t.tickMs.p50, p95: t.tickMs.p95, p99: t.tickMs.p99, max: t.tickMs.max } : null,
        tickCallbackMsAvg: t.callbackMs?.avg ?? null,
        tickStartMs: t.startInterval ? { avg: t.startInterval.avg, p99: t.startInterval.p99, max: t.startInterval.max } : null,
        ticks: t.n ?? null,
        ticksOver100: t.over100 ?? null,
        tickPhasesMs: t.phasesAvgMs ?? null,
        botsMs: t.botsMs ? { avg: t.botsMs.avg, p95: t.botsMs.p95, max: t.botsMs.max } : null,
        botsActive: p.botsState?.active ?? null,
        players: t.players ?? null,
        clamps: t.clamps ?? null,
        appFootprintMB: footprints.length ? { min: Math.min(...footprints), max: Math.max(...footprints) } : null,
        availableMBMin: (p.native?.availableMB ?? []).some(Number.isFinite) ? Math.min(...p.native.availableMB.filter(Number.isFinite)) : null,
        thermal: [...new Set((p.native?.thermal ?? []).filter(Boolean))],
        audio: p.audio,
        music: p.music,
        lm: p.lm ? { gens: p.lm.gens, msMedian: p.lm.ms?.p50 ?? null, errors: p.lm.errors } : null,
        engineErrors: p.engineErrors
    };
}

/** An iPhone recording's summary, made once and kept beside it. */
function traceSummary(file) {
    const cached = `${file.replace(/\.trace$/, '')}.summary.json`;
    if (fs.existsSync(cached) && fs.statSync(cached).mtimeMs >= fs.statSync(file).mtimeMs) {
        return JSON.parse(fs.readFileSync(cached, 'utf8'));
    }
    const s = summarizeTrace(file);
    fs.writeFileSync(cached, `${JSON.stringify(s, null, 1)}\n`);
    return s;
}

/** A phase's recordings on the iPhone (traces/<phase>.<set>.trace): per process role, the Core Animation and GPU numbers. */
function iosRecording(dir, phase) {
    const log = readJsonl(path.join(dir, 'traces', 'traces.jsonl'));
    const sets = log.filter(e => e.name.startsWith(`${phase}.`));
    if (!sets.length) {
        return null;
    }
    const rec = { source: 'xctrace', windows: [], cpuPct: null, footprintMB: null, compressedMB: null, caFps: null, gpuUtilPct: null, thermal: null, threads: null, gpuBusyMsPerSec: null };
    for (const e of sets) {
        const file = path.join(dir, 'traces', `${e.name}.trace`);
        if (e.skipped || !fs.existsSync(file)) {
            rec.windows.push({ name: e.name, set: e.set, problem: e.skipped ? 'skipped' : `no recording (xctrace ${e.code}${e.hung ? `, ${e.hung}` : ''})` });
            continue;
        }
        let s;
        try {
            s = traceSummary(file);
        } catch (error) {
            rec.windows.push({ name: e.name, set: e.set, problem: `unreadable: ${error.message.split('\n')[0]}` });
            continue;
        }
        rec.windows.push({ name: e.name, set: e.set, sec: s.activitySpanSec ?? s.timeProfile?.spanSec ?? s.durationSec, hung: e.hung ?? null });
        if (s.processes && (!rec.cpuPct || e.set === 'am')) {
            const cpu = {};
            const foot = {};
            const comp = {};
            for (const p of s.processes) {
                const role = roleOf(p.name);
                if (!role) {
                    continue;
                }
                cpu[role] = round((cpu[role] ?? 0) + (p.cpuPct ?? 0), 2);
                if (p.footprintMB && role !== 'instruments') {
                    foot[role] = { last: round((foot[role]?.last ?? 0) + p.footprintMB.last), max: round((foot[role]?.max ?? 0) + p.footprintMB.max) };
                    comp[role] = round((comp[role] ?? 0) + (p.compressedMB?.last ?? 0));
                }
            }
            cpu.total = s.totalCpuPct;
            cpu.totalWithoutInstruments = round(s.totalCpuPct - (cpu.instruments ?? 0));
            rec.cpuPct = cpu;
            rec.footprintMB = foot;
            rec.compressedMB = comp;
            rec.thermal = s.thermal;
        }
        if (s.coreAnimation?.samples && (rec.caFps === null || e.set === 'am')) {
            rec.caFps = s.coreAnimation.fpsMedian;
            rec.gpuUtilPct = s.coreAnimation.gpuUtilPctAvg;
        }
        if (s.timeProfile) {
            rec.threads = s.timeProfile.threads.filter(t => roleOf(t.process) && roleOf(t.process) !== 'instruments').slice(0, 16);
            rec.timeProfileMsPerSec = Object.fromEntries(IOS_ROLES.map(([role]) => [role, round(s.timeProfile.processes.filter(p => roleOf(p.name) === role).reduce((sum, p) => sum + p.msPerSec, 0))]).filter(([, v]) => v));
        }
        if (s.gpu) {
            rec.gpuBusyMsPerSec = Object.fromEntries(s.gpu.processes.slice(0, 8).map(p => [`${p.name}[${p.pid}]`, p.busyMsPerSec]));
        }
    }
    return rec;
}

/** A phase's samples on a simulator (samples/<phase>.<set>.json: ps and footprint, Mac CPU). */
function simRecording(dir, phase) {
    const sampleDir = path.join(dir, 'samples');
    if (!fs.existsSync(sampleDir)) {
        return null;
    }
    const files = fs.readdirSync(sampleDir).filter(f => f.startsWith(`${phase}.`) && f.endsWith('.json'));
    if (!files.length) {
        return null;
    }
    const s = readJson(path.join(sampleDir, files.sort()[0]));
    const cpu = {};
    const foot = {};
    for (const p of s.processes) {
        const role = p.role === 'GPU' ? 'GPU process' : p.role;
        cpu[role] = round((cpu[role] ?? 0) + (p.cpuPct ?? 0));
        foot[role] = { last: round((foot[role]?.last ?? 0) + (p.footprintMB ?? p.rssMB ?? 0)) };
    }
    cpu.total = round(Object.values(cpu).reduce((a, b) => a + b, 0));
    return { source: 'simulator', windows: files.map(f => ({ name: f.replace(/\.json$/, ''), sec: round((s.endedAt - s.startedAt) / 1000) })), note: s.host, cpuPct: cpu, footprintMB: foot };
}

// ---- Android (soak/<window>.*: top -H, /proc stat before and after, gfxinfo, SurfaceFlinger --latency, meminfo)
const HZ = 100;

function procStat(text) {
    const threads = new Map();
    let total = null;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('cpu ')) {
            // (user nice system idle iowait irq softirq steal: all but idle and iowait, every core)
            const [user, nice, system, , , irq, softirq, steal] = line.split(/\s+/).slice(1).map(Number);
            total = user + nice + system + irq + softirq + (steal || 0);
            continue;
        }
        const m = /^(\d+) (\d+) \((.*)\) (\S) (.*)$/.exec(line);
        if (m) {
            const rest = m[5].split(' ');
            threads.set(`${m[1]} ${m[2]}`, { pid: Number(m[1]), comm: m[3], ticks: Number(rest[10]) + Number(rest[11]) });
        }
    }
    return { threads, total };
}

function gfxinfo(text) {
    const out = {};
    for (const [key, rx] of [['frames', /Total frames rendered: (\d+)/], ['janky', /Janky frames: (\d+)/], ['p50', /50th percentile: (\d+)ms/], ['p90', /90th percentile: (\d+)ms/], ['p95', /95th percentile: (\d+)ms/], ['p99', /99th percentile: (\d+)ms/], ['gpuP50', /50th gpu percentile: (\d+)ms/], ['gpuP99', /99th gpu percentile: (\d+)ms/]]) {
        const m = rx.exec(text);
        if (m) {
            out[key] = Number(m[1]);
        }
    }
    return out;
}

function presentFps(text) {
    const lines = text.trim().split('\n');
    if (lines.length < 3) {
        return null;
    }
    const period = Number(lines[1].trim());
    const presents = lines
        .slice(2)
        .map(l => l.trim().split(/\s+/))
        .filter(p => p.length === 3 && p[1] !== '0' && Number(p[1]) < 9e18)
        .map(p => Number(p[1]))
        .sort((a, b) => a - b);
    if (presents.length < 3) {
        return { refreshHz: period ? round(1e9 / period) : null, frames: presents.length };
    }
    const span = (presents.at(-1) - presents[0]) / 1e9;
    return { refreshHz: period ? round(1e9 / period) : null, frames: presents.length, presentFps: span ? round((presents.length - 1) / span) : null };
}

function androidRecording(dir, phase) {
    const soakDir = path.join(dir, 'soak');
    const windows = readJsonl(path.join(soakDir, 'windows.jsonl')).filter(w => w.name.startsWith(`${phase}.`));
    if (!windows.length) {
        return null;
    }
    const w = windows[0];
    const read = suffix => {
        const f = path.join(soakDir, `${w.name}.${suffix}`);
        return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    };
    const s0 = procStat(read('stat0.txt'));
    const s1 = procStat(read('stat1.txt'));
    const secs = (w.endedAt - w.startedAt) / 1000;
    const label = pid => (pid === w.app ? 'app' : w.renderers?.includes(pid) ? 'renderer' : (w.names?.[pid] ?? `pid ${pid}`));
    const byProcess = {};
    const threads = [];
    for (const [key, t] of s1.threads) {
        const before = s0.threads.get(key);
        if (!before || t.ticks <= before.ticks) {
            continue;
        }
        const pct = (100 * (t.ticks - before.ticks)) / HZ / secs;
        const role = label(t.pid);
        byProcess[role] = round((byProcess[role] ?? 0) + pct);
        threads.push({ process: role, thread: t.comm, pct: round(pct) });
    }
    threads.sort((a, b) => b.pct - a.pct);
    const mem = read('mem.txt')
        .split('\n')
        .filter(Boolean)
        .map(l => /^(\w+) (\d+): pss (\d+) MB/.exec(l))
        .filter(Boolean)
        .map(m => [m[1], Number(m[3])]);
    const footprint = {};
    for (const [role, pss] of mem) {
        footprint[role] = { last: round((footprint[role]?.last ?? 0) + pss) };
    }
    return {
        source: 'android',
        windows: windows.map(x => ({ name: x.name, sec: round((x.endedAt - x.startedAt) / 1000) })),
        cpuPct: { ...byProcess, total: round(Object.values(byProcess).reduce((a, b) => a + b, 0)), systemNonIdle: s0.total !== null && s1.total !== null ? round((100 * (s1.total - s0.total)) / HZ / secs) : null },
        footprintMB: footprint,
        threads: threads.slice(0, 16),
        gfxinfo: gfxinfo(read('gfxinfo.txt')),
        surfaceFlinger: presentFps(read('latency.txt'))
    };
}

/** The launches' start-up marks: each clean launch, and their medians and ranges. */
function startupSummary(records) {
    if (!records.length) {
        return null;
    }
    const clean = records.filter(r => r.clean);
    const keys = ['workerCreated', 'engineBooted', 'preloadMs', 'evalMs', 'engineEvaluated', 'worldStart', 'worldStarted', 'firstTickEnd', 'engineReady', 'readyMs', 'clientCreated', 'client100', 'titleReady', 'loaderFade'];
    const stats = {};
    for (const key of keys) {
        const values = clean.map(r => r[key]).filter(Number.isFinite);
        if (values.length) {
            stats[key] = { median: round(median(values)), min: round(Math.min(...values)), max: round(Math.max(...values)) };
        }
    }
    const worldStartMs = clean.map(r => (Number.isFinite(r.worldStarted) && Number.isFinite(r.worldStart) ? r.worldStarted - r.worldStart : null)).filter(Number.isFinite);
    if (worldStartMs.length) {
        stats.worldStartMs = { median: round(median(worldStartMs)), min: round(Math.min(...worldStartMs)), max: round(Math.max(...worldStartMs)) };
    }
    const foot = clean.map(r => r.native?.footprintMB).filter(Number.isFinite);
    if (foot.length) {
        stats.appFootprintMB = { median: round(median(foot)), min: Math.min(...foot), max: Math.max(...foot) };
    }
    return { launches: records.length, clean: clean.length, stats, records };
}

/** The start-up recordings (iPhone, startup.trace): each launch's peak footprint per process role. */
function startupRecordings(dir) {
    const log = readJsonl(path.join(dir, 'traces', 'traces.jsonl')).filter(e => e.name.startsWith('startup-') && !e.skipped);
    const out = [];
    for (const e of log) {
        const file = path.join(dir, 'traces', `${e.name}.trace`);
        if (!fs.existsSync(file)) {
            continue;
        }
        try {
            const s = traceSummary(file);
            const peak = {};
            for (const p of s.processes ?? []) {
                const role = roleOf(p.name);
                if (role && role !== 'instruments' && p.footprintMB) {
                    peak[role] = round(Math.max(peak[role] ?? 0, p.footprintMB.max));
                }
            }
            out.push({ name: e.name, peakFootprintMB: peak });
        } catch {
            out.push({ name: e.name, problem: 'unreadable' });
        }
    }
    return out.length ? out : null;
}

export function summarizeRun(dir) {
    const result = readJson(path.join(dir, 'result.json')) ?? {};
    const phases = readJsonl(path.join(dir, 'soak.jsonl')).map(p => {
        const recording = iosRecording(dir, p.name) ?? simRecording(dir, p.name) ?? androidRecording(dir, p.name);
        return { name: p.name, kind: p.kind, page: pagePhase(p), recording };
    });
    const startup = startupSummary(readJsonl(path.join(dir, 'startup.jsonl')));
    if (startup) {
        startup.recordings = startupRecordings(dir);
    }
    return { run: { dir: path.resolve(dir), target: result.target ?? result.serial ?? null, soak: result.soak ?? null, bots: result.bots ?? null, port: result.port ?? null, result: result.summary ?? null, terminations: result.terminations ?? null }, startup, phases };
}

const f = (v, d = 1) => (v === null || v === undefined ? '-' : typeof v === 'number' ? String(round(v, d)) : String(v));

export function summaryText(s) {
    const lines = [`${s.run.soak ?? '?'} on ${s.run.target ?? '?'} (${s.run.bots ?? '?'} bots, port ${s.run.port ?? '?'}): ${s.run.result ?? 'no result'} — ${s.run.dir}`];
    if (s.startup) {
        const st = s.startup.stats;
        const m = key => (st[key] ? `${f(st[key].median, 0)} (${f(st[key].min, 0)}-${f(st[key].max, 0)})` : '-');
        lines.push('', `start-up, ${s.startup.clean} clean of ${s.startup.launches} launches (ms after the page's navigation; median (range)):`);
        lines.push(`  engine booted ${m('engineBooted')} [preload ${m('preloadMs')}, eval ${m('evalMs')}]  World.start ${m('worldStart')} → ${m('worldStarted')} (${m('worldStartMs')} ms)  ready ${m('engineReady')}`);
        lines.push(`  client made ${m('clientCreated')}, at 100 % ${m('client100')}  title ready ${m('titleReady')}  loader fades ${m('loaderFade')}  app footprint ${m('appFootprintMB')} MB`);
        for (const r of s.startup.recordings ?? []) {
            lines.push(`  ${r.name}: peak footprint ${Object.entries(r.peakFootprintMB ?? {}).map(([k, v]) => `${k} ${v} MB`).join(', ') || r.problem}`);
        }
    }
    for (const p of s.phases) {
        const pg = p.page;
        lines.push('', `${p.name} (${p.kind}${pg.sec ? `, ${pg.sec} s` : ''}${pg.crowdMax ? `, ${pg.crowdMax} player${pg.crowdMax === 1 ? '' : 's'} in view at most` : ''})`);
        if (p.kind === 'background') {
            lines.push(`  back ${pg.back}, ticks while away ${f(pg.ticksWhileAway)}, events ${(pg.events ?? []).join(' ')}`);
        } else {
            lines.push(`  client ${f(pg.clientFps)} fps; frame p50/p95/p99/max ${f(pg.frameMs?.p50)}/${f(pg.frameMs?.p95)}/${f(pg.frameMs?.p99)}/${f(pg.frameMs?.max)} ms; over 33/50/100 ms ${f(pg.framesOver33PerMin)}/${f(pg.framesOver50PerMin)}/${f(pg.framesOver100PerMin)} a minute; draw ${f(pg.drawMs?.avg, 2)} ms (p95 ${f(pg.drawMs?.p95)}); rAF ${f(pg.rafPerSec)}/s`);
            lines.push(`  tick ${f(pg.tickMs?.avg, 2)} ms (p50 ${f(pg.tickMs?.p50)}, p95 ${f(pg.tickMs?.p95)}, p99 ${f(pg.tickMs?.p99)}, max ${f(pg.tickMs?.max)}), callback ${f(pg.tickCallbackMsAvg, 2)}; start to start ${f(pg.tickStartMs?.avg)} (p99 ${f(pg.tickStartMs?.p99)}, max ${f(pg.tickStartMs?.max)}); bots ${f(pg.botsMs?.avg, 2)} ms (p95 ${f(pg.botsMs?.p95)}), ${f(pg.botsActive)} active`);
            if (pg.tickPhasesMs) {
                lines.push(`  World's phases (avg ms): ${Object.entries(pg.tickPhasesMs).filter(([k, v]) => k !== 'cycle' && v > 0).map(([k, v]) => `${k} ${v}`).join(', ')}`);
            }
            lines.push(`  app footprint ${f(pg.appFootprintMB?.min)}-${f(pg.appFootprintMB?.max)} MB, thermal ${pg.thermal?.join('/') || '-'}, audio ${pg.audio ?? '-'}, music ${pg.music?.active ?? '-'} sound ${pg.music?.wave ?? '-'}${pg.lm ? `, chat model ${pg.lm.gens} replies (median ${pg.lm.msMedian} ms, ${pg.lm.errors} errors)` : ''}`);
        }
        const r = p.recording;
        if (r) {
            const cpu = Object.entries(r.cpuPct ?? {}).map(([k, v]) => `${k} ${f(v)}`).join(', ');
            lines.push(`  ${r.source}${r.note ? ` (${r.note})` : ''}: CPU % of a core: ${cpu || '-'}`);
            if (r.footprintMB && Object.keys(r.footprintMB).length) {
                lines.push(`    footprint MB: ${Object.entries(r.footprintMB).map(([k, v]) => `${k} ${f(v.last, 0)}${v.max !== undefined ? ` (max ${f(v.max, 0)})` : ''}${r.compressedMB?.[k] ? `, ${f(r.compressedMB[k], 0)} compressed` : ''}`).join('; ')}`);
            }
            if (r.caFps !== null && r.caFps !== undefined) {
                lines.push(`    Core Animation ${f(r.caFps)} fps, GPU ${f(r.gpuUtilPct)} % busy, thermal ${r.thermal?.join('/') || '-'}`);
            }
            if (r.gfxinfo || r.surfaceFlinger) {
                lines.push(`    gfxinfo ${JSON.stringify(r.gfxinfo)}, SurfaceFlinger ${JSON.stringify(r.surfaceFlinger)}`);
            }
            for (const t of (r.threads ?? []).slice(0, 8)) {
                lines.push(`    ${f(t.msPerSec ?? t.pct)}${t.msPerSec !== undefined ? ' ms/s' : ' %'}  ${t.process} / ${t.thread}`);
            }
            for (const w of r.windows.filter(x => x.problem)) {
                lines.push(`    ${w.name}: ${w.problem}`);
            }
        }
    }
    return `${lines.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const dir = process.argv[2];
    if (!dir || !fs.existsSync(dir)) {
        console.error('usage: node web/test/perf/summary.mjs <app-test run dir>');
        process.exit(2);
    }
    const s = summarizeRun(dir);
    fs.writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(s, null, 1)}\n`);
    const text = summaryText(s);
    fs.writeFileSync(path.join(dir, 'summary.txt'), text);
    process.stdout.write(text);
}
