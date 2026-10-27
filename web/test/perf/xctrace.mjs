// What app-test --soak's xctrace recordings say (traces/<phase>.<set>.trace from the iPhone), for web/test/perf/summary.mjs:
// per process the CPU (% of one core), footprint and compressed memory, disk writes and wakeups (Activity Monitor), the
// Core Animation frame rate and GPU utilisation, the thermal state, and with Time Profiler the CPU per process and thread
// (ms of CPU a second), with the GPU instrument each process's GPU time.
//
//   import { summarizeTrace } from './xctrace.mjs'; const s = summarizeTrace('<x>.trace');
//   node web/test/perf/xctrace.mjs <x>.trace     # the summary as JSON
//
// `xctrace export` writes each table as XML whose repeated values are written once with id="N" and then as ref="N";
// readTable() streams the file and resolves those, row by row. The tables are written to a temporary folder first (a
// Time Profiler table of 30 s is ~100 MB).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = s => (s.includes('&') ? s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m))) : s);

function attributes(text) {
    const attrs = {};
    for (const m of text.matchAll(/([\w:-]+)=(?:"([^"]*)"|'([^']*)')/g)) {
        attrs[m[1]] = decode(m[2] ?? m[3]);
    }
    return attrs;
}

/**
 * Every row of one exported table: onRow({mnemonic: node}) with each cell's element tree (ref= resolved): a node is
 * {tag, attrs, text, children}. Returns the column mnemonics.
 */
export function readTable(file, onRow) {
    const columns = [];
    const store = new Map();
    const stack = []; // open elements
    let inSchema = false;
    let inRow = false;
    let pending = '';
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(1 << 20);
    const open = (tag, attrs, selfClosing) => {
        if (tag === 'schema') {
            inSchema = true;
        } else if (tag === 'row') {
            inRow = true;
            stack.length = 0;
            stack.push({ tag, attrs, text: '', children: [] });
            if (selfClosing) {
                close('row');
            }
            return;
        }
        if (!inRow) {
            if (inSchema && tag === 'mnemonic') {
                stack.push({ tag, attrs, text: '', children: [] });
            }
            return;
        }
        let node;
        if (attrs.ref !== undefined) {
            node = store.get(attrs.ref) ?? { tag, attrs, text: '', children: [] };
        } else {
            node = { tag, attrs, text: '', children: [] };
        }
        stack.at(-1)?.children.push(node);
        if (attrs.ref === undefined) {
            stack.push(node);
            if (selfClosing) {
                close(tag);
            }
        } else if (!selfClosing) {
            stack.push({ tag, attrs, text: '', children: [], ignored: true }); // (a ref has no content of its own)
        }
    };
    const close = tag => {
        if (tag === 'schema') {
            inSchema = false;
            return;
        }
        if (!inRow) {
            if (inSchema && tag === 'mnemonic') {
                const node = stack.pop();
                columns.push(node.text.trim());
            }
            return;
        }
        const node = stack.pop();
        if (!node) {
            return;
        }
        if (!node.ignored && node.attrs.id !== undefined) {
            store.set(node.attrs.id, node);
        }
        if (tag === 'row') {
            inRow = false;
            const cells = {};
            node.children.forEach((child, i) => {
                if (i < columns.length) {
                    cells[columns[i]] = child.tag === 'sentinel' ? null : child;
                }
            });
            onRow(cells);
        }
    };
    for (;;) {
        const n = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (n === 0) {
            break;
        }
        pending += buffer.toString('utf8', 0, n);
        let at = 0;
        for (;;) {
            const lt = pending.indexOf('<', at);
            if (lt < 0) {
                break;
            }
            if (lt > at && stack.length) {
                stack.at(-1).text += decode(pending.slice(at, lt));
            }
            const gt = pending.indexOf('>', lt);
            if (gt < 0) {
                at = lt;
                break;
            }
            const inner = pending.slice(lt + 1, gt);
            at = gt + 1;
            if (inner[0] === '?' || inner[0] === '!') {
                continue;
            }
            if (inner[0] === '/') {
                close(inner.slice(1).trim());
                continue;
            }
            const selfClosing = inner.endsWith('/');
            const body = selfClosing ? inner.slice(0, -1) : inner;
            const space = body.search(/\s/);
            const tag = space < 0 ? body : body.slice(0, space);
            open(tag, space < 0 ? {} : attributes(body.slice(space)), selfClosing);
        }
        pending = pending.slice(at);
    }
    fs.closeSync(fd);
    return columns;
}

const number = node => {
    if (!node) {
        return null;
    }
    const v = Number(node.text.trim());
    return node.text.trim() !== '' && Number.isFinite(v) ? v : null;
};
const fmt = node => node?.attrs.fmt ?? null;

/** "WebContent (1234)" → {name, pid}; a process cell's pid child when the name is not known yet ("Process (1234)"). */
function processOf(node) {
    if (!node) {
        return null;
    }
    const text = fmt(node) ?? '';
    const m = /^(.*) \((\d+)\)$/.exec(text);
    const pid = m ? Number(m[2]) : number(node.children.find(c => c.tag === 'pid'));
    const name = m ? m[1] : text;
    return { name: /^Process$/.test(name) ? null : name, pid };
}

function exportTables(trace, schemas, dir) {
    const toc = execFileSync('xcrun', ['xctrace', 'export', '--input', trace, '--toc'], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    const present = new Set([...toc.matchAll(/schema="([^"]+)"/g)].map(m => m[1]));
    const files = {};
    for (const schema of schemas.filter(s => present.has(s))) {
        const file = path.join(dir, `${schema}.xml`);
        const fd = fs.openSync(file, 'w');
        spawnSync('xcrun', ['xctrace', 'export', '--input', trace, '--xpath', `/trace-toc/run[@number="1"]/data/table[@schema="${schema}"]`], { stdio: ['ignore', fd, 'ignore'] });
        fs.closeSync(fd);
        files[schema] = file;
    }
    const start = /<start-date>([^<]+)<\/start-date>/.exec(toc)?.[1] ?? null;
    const duration = Number(/<duration>([^<]+)<\/duration>/.exec(toc)?.[1]);
    const template = /<template-name>([^<]+)<\/template-name>/.exec(toc)?.[1] ?? null;
    const device = /<device [^>]*model="([^"]*)"[^>]*os-version="([^"]*)"/.exec(toc);
    return { files, start: start ? Date.parse(start) : null, duration: Number.isFinite(duration) ? duration : null, template, device: device ? `${device[1]}, iOS ${device[2]}` : null };
}

const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const MB = 1048576;

/** One recording's summary (see the header). */
export function summarizeTrace(trace) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-xctrace-'));
    try {
        const t = exportTables(trace, ['activity-monitor-process-live', 'core-animation-fps-estimate', 'device-thermal-state-intervals', 'time-profile', 'metal-gpu-intervals'], dir);
        const out = { trace: path.basename(trace), template: t.template, device: t.device, startEpochMs: t.start, durationSec: round(t.duration), processes: null, totalCpuPct: null, coreAnimation: null, thermal: null, timeProfile: null, gpu: null };
        const names = new Map(); // pid → the best name seen
        const nameOf = pid => names.get(pid) ?? `pid ${pid}`;
        const learn = p => {
            if (p?.pid != null && p.name && !names.has(p.pid)) {
                names.set(p.pid, p.name);
            }
        };

        if (t.files['activity-monitor-process-live']) {
            const procs = new Map();
            let first = null;
            let last = null;
            readTable(t.files['activity-monitor-process-live'], r => {
                const p = processOf(r.process);
                if (p?.pid == null) {
                    return;
                }
                learn(p);
                const start = number(r.start);
                const dur = number(r.duration) ?? 0;
                if (start !== null) {
                    first = first === null ? start : Math.min(first, start);
                    last = last === null ? start + dur : Math.max(last, start + dur);
                }
                let e = procs.get(p.pid);
                if (!e) {
                    procs.set(p.pid, (e = { cpuWeighted: 0, dur: 0, cpuTotal: [], foot: [], compressed: [], written: [], wakeups: [], threads: 0 }));
                }
                const cpu = number(r['cpu-percent']);
                if (cpu !== null) {
                    e.cpuWeighted += cpu * dur;
                    e.dur += dur;
                }
                for (const [key, col] of [['cpuTotal', 'cpu-total'], ['foot', 'memory-physical-footprint'], ['compressed', 'memory-compressed'], ['written', 'disk-bytes-written'], ['wakeups', 'idle-wakeups']]) {
                    const v = number(r[col]);
                    if (v !== null) {
                        e[key].push(v);
                    }
                }
                e.threads = Math.max(e.threads, number(r['thread-count']) ?? 0);
            });
            const span = (last - first) / 1e9;
            const range = list => (list.length > 1 ? Math.max(...list) - Math.min(...list) : null);
            const processes = [...procs]
                .map(([pid, e]) => ({
                    name: nameOf(pid),
                    pid,
                    cpuPct: e.dur ? round(e.cpuWeighted / e.dur, 2) : null,
                    cpuSec: e.cpuTotal.length > 1 ? round(range(e.cpuTotal) / 1e9, 3) : null,
                    footprintMB: e.foot.length ? { min: round(Math.min(...e.foot) / MB), max: round(Math.max(...e.foot) / MB), last: round(e.foot.at(-1) / MB) } : null,
                    compressedMB: e.compressed.length ? { max: round(Math.max(...e.compressed) / MB), last: round(e.compressed.at(-1) / MB) } : null,
                    diskWrittenKB: e.written.length > 1 ? round(range(e.written) / 1024) : null,
                    idleWakeups: range(e.wakeups),
                    threads: e.threads
                }))
                .sort((a, b) => (b.cpuPct ?? 0) - (a.cpuPct ?? 0));
            out.activitySpanSec = round(span);
            out.processes = processes;
            out.totalCpuPct = round(processes.reduce((sum, p) => sum + (p.cpuPct ?? 0), 0));
        }

        if (t.files['core-animation-fps-estimate']) {
            const fps = [];
            const util = [];
            readTable(t.files['core-animation-fps-estimate'], r => {
                const f = number(r.fps);
                const u = number(r['device-utilization']);
                // (the first row is the recording's start: a sliver of an interval)
                if ((number(r.period) ?? 0) >= 0.5e9) {
                    if (f !== null) fps.push(f);
                    if (u !== null) util.push(u);
                }
            });
            const sorted = list => [...list].sort((a, b) => a - b);
            out.coreAnimation = { samples: fps.length, fpsMedian: fps.length ? sorted(fps)[fps.length >> 1] : null, fpsMin: fps.length ? Math.min(...fps) : null, gpuUtilPctAvg: util.length ? round(util.reduce((a, b) => a + b, 0) / util.length) : null, gpuUtilPctMedian: util.length ? sorted(util)[util.length >> 1] : null };
        }

        if (t.files['device-thermal-state-intervals']) {
            const states = [];
            readTable(t.files['device-thermal-state-intervals'], r => states.push(fmt(r['thermal-state'])));
            out.thermal = [...new Set(states.filter(Boolean))];
        }

        if (t.files['time-profile']) {
            const byProcess = new Map();
            const byThread = new Map();
            let first = null;
            let last = null;
            readTable(t.files['time-profile'], r => {
                const time = number(r.time);
                if (time !== null) {
                    first = first === null ? time : Math.min(first, time);
                    last = last === null ? time : Math.max(last, time);
                }
                const thread = r.thread;
                const p = processOf(r.process ?? thread?.children.find(c => c.tag === 'process'));
                learn(p);
                const ms = (number(r.weight) ?? 1e6) / 1e6;
                const pid = p?.pid ?? -1;
                byProcess.set(pid, (byProcess.get(pid) ?? 0) + ms);
                const threadName = (fmt(thread) ?? '?').replace(/ \(0x[0-9a-f]+\)| \(pid: \d+\)|, pid: \d+/gi, '').replace(/\s+\(.*\)$/, '');
                const tid = number(thread?.children.find(c => c.tag === 'tid')) ?? /0x[0-9a-f]+/i.exec(fmt(thread) ?? '')?.[0] ?? '';
                const key = `${pid}\u0000${threadName}\u0000${tid}`;
                byThread.set(key, (byThread.get(key) ?? 0) + ms);
            });
            const span = (last - first) / 1e9;
            if (span > 0) {
                out.timeProfile = {
                    spanSec: round(span),
                    processes: [...byProcess].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([pid, ms]) => ({ name: nameOf(pid), pid, msPerSec: round(ms / span) })),
                    threads: [...byThread]
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 40)
                        .map(([key, ms]) => {
                            const [pid, thread, tid] = key.split('\u0000');
                            return { process: nameOf(Number(pid)), pid: Number(pid), thread, tid, msPerSec: round(ms / span) };
                        })
                };
            }
        }

        if (t.files['metal-gpu-intervals']) {
            const busy = new Map();
            let first = null;
            let last = null;
            readTable(t.files['metal-gpu-intervals'], r => {
                if ((number(r['event-depth']) ?? 0) !== 0) {
                    return;
                }
                const p = processOf(r.process);
                learn(p);
                const start = number(r.start);
                const dur = number(r.duration) ?? 0;
                if (start !== null) {
                    first = first === null ? start : Math.min(first, start);
                    last = last === null ? start + dur : Math.max(last, start + dur);
                }
                const key = p?.pid ?? -1;
                const e = busy.get(key) ?? { ns: 0, n: 0 };
                e.ns += dur;
                e.n++;
                busy.set(key, e);
            });
            const span = (last - first) / 1e9;
            if (span > 0) {
                out.gpu = { spanSec: round(span), processes: [...busy].sort((a, b) => b[1].ns - a[1].ns).map(([pid, e]) => ({ name: nameOf(pid), pid, busyMsPerSec: round(e.ns / 1e6 / span, 2), intervalsPerSec: round(e.n / span) })) };
            }
        }
        // (names learnt from a later table, for rows that came before them)
        for (const list of [out.processes, out.timeProfile?.processes, out.gpu?.processes]) {
            for (const p of list ?? []) {
                p.name = nameOf(p.pid);
            }
        }
        for (const th of out.timeProfile?.threads ?? []) {
            th.process = nameOf(th.pid);
        }
        return out;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (!process.argv[2]) {
        console.error('usage: node web/test/perf/xctrace.mjs <recording.trace>');
        process.exit(2);
    }
    console.log(JSON.stringify(summarizeTrace(process.argv[2]), null, 1));
}
