#!/usr/bin/env node
// render-verify: a table of one or more result folders (run.mjs --out): per scenario and engine, frames checked,
// partial frames checked, mismatching frames and pixels, state mismatches; then the totals.
//   node web/test/render-verify/summary.mjs <out dir> [<out dir> ...] [--md]
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const md = argv.includes('--md');
const dirs = argv.filter(a => !a.startsWith('--'));
const rows = [];
const totals = {};
for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).filter(n => /^(chrome|webkit)(-android)?-[a-z]+\.json$/.test(n)).sort()) {
        const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        // (the setup's frames: the title, the logins, the character made; the scene label '')
        const setup = r.report?.scenes?.[''];
        const list = [...(setup ? [{ name: 'setup', ...setup }] : []), ...(r.scenarios ?? [])];
        for (const s of list) {
            const state = Object.entries(s.state ?? {}).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ');
            const engine = r.platform === 'android' ? `${r.engine}-android` : r.engine;
            rows.push({ engine, session: r.session, scenario: s.name, seconds: s.seconds ?? '-', frames: s.frames ?? 0, checked: s.checked ?? 0, partial: s.checkedPartial ?? 0, bad: s.mismatchFrames ?? 0, px: s.mismatchPx ?? 0, state: state || '-', error: s.error ? s.error.split('\n')[0].slice(0, 80) : '' });
            const t = (totals[engine] ??= { checked: 0, partial: 0, bad: 0, px: 0, state: 0, scenarios: 0 });
            t.checked += s.checked ?? 0;
            t.partial += s.checkedPartial ?? 0;
            t.bad += s.mismatchFrames ?? 0;
            t.px += s.mismatchPx ?? 0;
            t.state += Object.values(s.state ?? {}).reduce((a, b) => a + b, 0);
            t.scenarios++;
        }
        const sh = r.shown;
        const eng = r.platform === 'android' ? `${r.engine}-android` : r.engine;
        if (sh && totals[eng]) {
            const t = totals[eng];
            t.canvasReads = (t.canvasReads ?? 0) + sh.reads;
            t.canvasDiffering = (t.canvasDiffering ?? 0) + sh.differing;
        }
        if (r.report?.errors && totals[eng]) totals[eng].oracleErrors = (totals[eng].oracleErrors ?? 0) + r.report.errors;
    }
}
// --identity: the upstream-identity scenario's hashes, view by view, across the folders and engines given (the first
// is the reference, e.g. main): a stable view must hash the same everywhere, and a patch's bypass the same as its frame
if (argv.includes('--identity')) {
    const sets = [];
    for (const dir of dirs) {
        for (const f of fs.readdirSync(dir).filter(n => /^(chrome|webkit)(-android)?-world\.json$/.test(n)).sort()) {
            const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const sc = (r.scenarios ?? []).find(x => x.name === 'upstream-identity');
            if (sc?.data) sets.push({ label: `${path.basename(dir)}/${r.engine}`, views: sc.data });
        }
    }
    const key = v => `${v.x},${v.z} yaw ${v.yaw} pitch ${v.pitch}`;
    const ref = new Map(sets[0]?.views.map(v => [key(v), v]) ?? []);
    let compared = 0, same = 0, unstable = 0, bypassBad = 0;
    for (const set of sets) {
        for (const v of set.views) {
            if (v.bypassHash !== null && v.bypassHash !== undefined && v.stable && v.bypassStable && v.bypassHash !== v.hash) {
                bypassBad++;
                console.log(`${set.label} ${key(v)}: World.incrBypass frame ${v.bypassHash} != the build's frame ${v.hash}`);
            }
            if (set === sets[0]) continue;
            const r = ref.get(key(v));
            if (!r || !r.stable || !v.stable) {
                unstable++;
                continue;
            }
            compared++;
            if (r.hash === v.hash) same++;
            else console.log(`${set.label} ${key(v)}: ${v.hash} != ${sets[0].label} ${r.hash} (lit ${v.lit} / ${r.lit})`);
        }
    }
    console.log(JSON.stringify({ reference: sets[0]?.label, sets: sets.map(x => x.label), compared, same, unstable, bypassDiffering: bypassBad }));
    process.exit(compared && same === compared && !bypassBad ? 0 : 1);
}

const cols = ['engine', 'session', 'scenario', 'seconds', 'checked', 'partial', 'bad', 'px', 'state', 'error'];
if (md) {
    console.log(`| ${cols.join(' | ')} |`);
    console.log(`|${cols.map(() => '---').join('|')}|`);
    for (const r of rows) console.log(`| ${cols.map(c => r[c]).join(' | ')} |`);
} else {
    const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c]).length)));
    console.log(cols.map((c, i) => c.padEnd(w[i])).join('  '));
    for (const r of rows) console.log(cols.map((c, i) => String(r[c]).padEnd(w[i])).join('  '));
}
console.log(JSON.stringify(totals));
