#!/usr/bin/env node
// app-test --soak runs side by side (docs/BUILDING.md §4 "A/B on the phone"): A (e.g. main) against B (the branch), each
// one run or several interleaved ones (A B A B A B), phase by phase. A number is the median of the runs (a start-up mark:
// of all their clean launches) with its range; Δ is B against A; "apart" marks where the two ranges do not overlap.
//
//   node web/test/perf/compare.mjs <run A> <run B>
//   node web/test/perf/compare.mjs --a <run> <run> <run> --b <run> <run> <run> [--names main,branch] [--json <file>] [--md <file>]
//
// A run is an app-test output folder; its summary.json is made first if it has none (web/test/perf/summary.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarizeRun } from './summary.mjs';

const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const median = list => {
    const d = list.filter(Number.isFinite).sort((a, b) => a - b);
    return d.length ? (d.length % 2 ? d[d.length >> 1] : (d[d.length / 2 - 1] + d[d.length / 2]) / 2) : null;
};

function load(dir) {
    const file = path.join(dir, 'summary.json');
    if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    const s = summarizeRun(dir);
    fs.writeFileSync(file, `${JSON.stringify(s, null, 1)}\n`);
    return s;
}

// [label, unit, value of a phase summary, which way is better]
const PAGE_METRICS = [
    ['client frames', '/s', p => p.page.clientFps, 'higher'],
    ['frame interval p50', 'ms', p => p.page.frameMs?.p50, 'lower'],
    ['frame interval p95', 'ms', p => p.page.frameMs?.p95, 'lower'],
    ['frame interval p99', 'ms', p => p.page.frameMs?.p99, 'lower'],
    ['frames over 33 ms', '/min', p => p.page.framesOver33PerMin, 'lower'],
    ['frames over 50 ms', '/min', p => p.page.framesOver50PerMin, 'lower'],
    ['draw', 'ms', p => p.page.drawMs?.avg, 'lower'],
    ['draw p95', 'ms', p => p.page.drawMs?.p95, 'lower'],
    ['HUD rAF', '/s', p => p.page.rafPerSec, 'higher'],
    ['tick', 'ms', p => p.page.tickMs?.avg, 'lower'],
    ['tick p95', 'ms', p => p.page.tickMs?.p95, 'lower'],
    ['tick p99', 'ms', p => p.page.tickMs?.p99, 'lower'],
    ['tick max', 'ms', p => p.page.tickMs?.max, 'lower'],
    ['tick callback', 'ms', p => p.page.tickCallbackMsAvg, 'lower'],
    ['tick start to start', 'ms', p => p.page.tickStartMs?.avg, null],
    ['tick start to start max', 'ms', p => p.page.tickStartMs?.max, 'lower'],
    ['bots\' share', 'ms', p => p.page.botsMs?.avg, 'lower'],
    ['bots\' share p95', 'ms', p => p.page.botsMs?.p95, 'lower'],
    ['World npc', 'ms', p => p.page.tickPhasesMs?.npc, 'lower'],
    ['World player', 'ms', p => p.page.tickPhasesMs?.player, 'lower'],
    ['World zone', 'ms', p => p.page.tickPhasesMs?.zone, 'lower'],
    ['World client out', 'ms', p => p.page.tickPhasesMs?.clientOut, 'lower'],
    ['app footprint max', 'MB', p => p.page.appFootprintMB?.max, 'lower']
];

function recordingMetrics(phases) {
    const roles = new Set();
    const memRoles = new Set();
    for (const p of phases) {
        for (const k of Object.keys(p.recording?.cpuPct ?? {})) roles.add(k);
        for (const k of Object.keys(p.recording?.footprintMB ?? {})) memRoles.add(k);
    }
    const order = ['WebContent', 'GPU process', 'Networking', 'app', 'renderer', 'backboardd', 'audiomxd', 'mediaserverd', 'SpringBoard', 'kernel', 'instruments', 'total', 'totalWithoutInstruments', 'systemNonIdle'];
    const sorted = list => [...list].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
    return [
        ...sorted(roles).map(role => [`CPU ${role}`, '% core', p => p.recording?.cpuPct?.[role], 'lower']),
        ...sorted(memRoles).map(role => [`footprint ${role}`, 'MB', p => p.recording?.footprintMB?.[role]?.last, 'lower']),
        ...sorted(memRoles).filter(r => phases.some(p => p.recording?.compressedMB?.[r])).map(role => [`compressed ${role}`, 'MB', p => p.recording?.compressedMB?.[role], 'lower']),
        ['Core Animation', 'fps', p => p.recording?.caFps, null],
        ['GPU busy', '%', p => p.recording?.gpuUtilPct, 'lower']
    ];
}

const STARTUP_METRICS = [
    ['title ready', 'ms', r => r.titleReady],
    ['loader fades', 'ms', r => r.loaderFade],
    ['client at 100 %', 'ms', r => r.client100],
    ['engine ready', 'ms', r => r.engineReady],
    ['World.start', 'ms', r => (Number.isFinite(r.worldStarted) && Number.isFinite(r.worldStart) ? r.worldStarted - r.worldStart : null)],
    ['World.start begins', 'ms', r => r.worldStart],
    ['engine booted', 'ms', r => r.engineBooted],
    ['preload', 'ms', r => r.preloadMs],
    ['engine eval', 'ms', r => r.evalMs],
    ['client made', 'ms', r => r.clientCreated],
    ['app footprint', 'MB', r => r.native?.footprintMB]
];

function stat(values) {
    const v = values.filter(Number.isFinite);
    return v.length ? { median: median(v), min: Math.min(...v), max: Math.max(...v), n: v.length } : null;
}

function row(label, unit, a, b, better) {
    const delta = a && b ? b.median - a.median : null;
    const pct = a && b && a.median ? (100 * delta) / Math.abs(a.median) : null;
    const apart = a && b && a.n > 1 && b.n > 1 ? b.min > a.max || b.max < a.min : null;
    const verdict = delta === null || !better || delta === 0 ? '' : (delta < 0) === (better === 'lower') ? 'better' : 'worse';
    return { label, unit, a, b, delta: round(delta, 2), pct: round(pct), apart, verdict };
}

export function compare(groupA, groupB) {
    const a = groupA.map(load);
    const b = groupB.map(load);
    const phases = [];
    const names = [...new Set([...a, ...b].flatMap(s => s.phases.map(p => p.name)))];
    for (const name of names) {
        const pa = a.map(s => s.phases.find(p => p.name === name)).filter(Boolean);
        const pb = b.map(s => s.phases.find(p => p.name === name)).filter(Boolean);
        if (!pa.length || !pb.length || pa[0].kind === 'background') {
            continue;
        }
        const rows = [...PAGE_METRICS, ...recordingMetrics([...pa, ...pb])]
            .map(([label, unit, get, better]) => row(label, unit, stat(pa.map(get)), stat(pb.map(get)), better))
            .filter(r => r.a || r.b);
        phases.push({ name, runs: [pa.length, pb.length], rows });
    }
    const launches = list => list.flatMap(s => s.startup?.records?.filter(r => r.clean) ?? []);
    const la = launches(a);
    const lb = launches(b);
    const startup = la.length && lb.length ? { launches: [la.length, lb.length], rows: STARTUP_METRICS.map(([label, unit, get]) => row(label, unit, stat(la.map(get)), stat(lb.map(get)), 'lower')).filter(r => r.a || r.b) } : null;
    const runInfo = s => ({ dir: s.run.dir, target: s.run.target, soak: s.run.soak, bots: s.run.bots, port: s.run.port, result: s.run.result });
    return { a: a.map(runInfo), b: b.map(runInfo), startup, phases };
}

const cell = s => (s ? `${round(s.median, 2)}${s.n > 1 ? ` (${round(s.min, 2)}–${round(s.max, 2)})` : ''}` : '-');

export function markdown(c, names = ['A', 'B']) {
    const out = [];
    const ports = list => [...new Set(list.map(r => r.port ?? '?'))].join(', ');
    out.push(`**${names[0]}**: ${c.a.length} run(s), port ${ports(c.a)}; **${names[1]}**: ${c.b.length} run(s), port ${ports(c.b)}; ${c.a[0]?.soak ?? '?'} on ${c.a[0]?.target ?? '?'}, ${c.a[0]?.bots ?? '?'} bots.`, '');
    out.push('Each value is the median of the runs (start-up: of every clean launch), with the range; Δ is B − A; "apart": the ranges do not overlap.', '');
    const table = (title, rows) => {
        out.push(`### ${title}`, '', `| | ${names[0]} | ${names[1]} | Δ | Δ % | |`, '|---|---|---|---|---|---|');
        for (const r of rows) {
            out.push(`| ${r.label} (${r.unit}) | ${cell(r.a)} | ${cell(r.b)} | ${r.delta ?? '-'} | ${r.pct ?? '-'} | ${[r.verdict, r.apart ? 'apart' : ''].filter(Boolean).join(', ')} |`);
        }
        out.push('');
    };
    if (c.startup) {
        table(`Start-up (${c.startup.launches[0]} and ${c.startup.launches[1]} clean launches; ms after the page's navigation)`, c.startup.rows);
    }
    for (const p of c.phases) {
        table(`${p.name} (${p.runs[0]} and ${p.runs[1]} runs)`, p.rows);
    }
    return `${out.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
    const group = name => {
        const i = args.indexOf(name);
        if (i < 0) {
            return null;
        }
        const list = [];
        for (let k = i + 1; k < args.length && !args[k].startsWith('--'); k++) list.push(args[k]);
        return list;
    };
    const plain = args.filter((x, i) => !x.startsWith('--') && !['--json', '--md', '--names'].includes(args[i - 1]));
    const groupA = group('--a') ?? (plain.length === 2 ? [plain[0]] : null);
    const groupB = group('--b') ?? (plain.length === 2 ? [plain[1]] : null);
    if (!groupA?.length || !groupB?.length) {
        console.error('usage: node web/test/perf/compare.mjs <run A> <run B> | --a <runs…> --b <runs…> [--names A,B] [--json <file>] [--md <file>]');
        process.exit(2);
    }
    const c = compare(groupA, groupB);
    const names = option('--names')?.split(',') ?? ['A', 'B'];
    const text = markdown(c, names);
    if (option('--json')) {
        fs.writeFileSync(option('--json'), `${JSON.stringify(c, null, 1)}\n`);
    }
    if (option('--md')) {
        fs.writeFileSync(option('--md'), text);
    }
    process.stdout.write(text);
}
