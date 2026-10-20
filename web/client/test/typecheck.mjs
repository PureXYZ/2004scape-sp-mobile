#!/usr/bin/env node
// Type-checks the patched client (patches + overrides) with `tsc --noEmit` and compares it with upstream:
// any diagnostic that upstream does not have fails. (esbuild does not type-check; this catches e.g. a new
// GameShell member colliding with a subclass field.) Needs a TypeScript compiler: by default the one in
// Server/engine/node_modules (used read-only), or --tsc <path to tsc>.
//   node web/client/test/typecheck.mjs [--tsc <tsc>] [--webclient <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { DEFAULT_ENGINE_DIR, DEFAULT_WEBCLIENT_DIR, OVERRIDES_DIR, TMP_DIR, WEB_DIR, applyPatches, copyUpstreamTree, listPatches } from '../lib/tree.mjs';

const argv = process.argv.slice(2);
const opt = (name, def) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : def;
};
const tsc = opt('--tsc', path.join(DEFAULT_ENGINE_DIR, 'node_modules/typescript/bin/tsc'));
const webclient = path.resolve(opt('--webclient', DEFAULT_WEBCLIENT_DIR));
if (!fs.existsSync(tsc)) {
    console.log(`typecheck: SKIPPED (no TypeScript compiler at ${tsc}; pass --tsc)`);
    process.exit(0);
}

const root = path.join(TMP_DIR, 'typecheck');
const upstream = path.join(root, 'upstream');
const patched = path.join(root, 'patched');
copyUpstreamTree(webclient, upstream);
copyUpstreamTree(webclient, patched);
applyPatches(patched, listPatches());
fs.cpSync(OVERRIDES_DIR, patched, { recursive: true }); // overrides/<path> replaces (or adds) <path>
for (const dir of [upstream, patched]) {
    fs.symlinkSync(path.join(WEB_DIR, 'node_modules'), path.join(dir, 'node_modules')); // fflate types
}

function diagnostics(dir) {
    const r = spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'], { cwd: dir, encoding: 'utf8' });
    // "src/x.ts(12,5): error TS1234: message" -> "src/x.ts: TS1234: message" (line numbers shift with patches)
    return (r.stdout + r.stderr)
        .split('\n')
        .filter(l => /error TS\d+/.test(l))
        .map(l => l.replace(/^(\S+?)\(\d+,\d+\): error (TS\d+):/, '$1: $2:').trim());
}

const before = diagnostics(upstream);
const after = diagnostics(patched);
const known = new Map();
for (const d of before) {
    known.set(d, (known.get(d) ?? 0) + 1);
}
const added = [];
for (const d of after) {
    const n = known.get(d) ?? 0;
    if (n > 0) {
        known.set(d, n - 1);
    } else {
        added.push(d);
    }
}
console.log(`typecheck: upstream ${before.length} diagnostic(s) (pre-existing, e.g. missing @types/node), patched ${after.length}`);
if (added.length) {
    console.log(`typecheck: FAIL, ${added.length} new diagnostic(s):\n  ${added.join('\n  ')}`);
    process.exit(1);
}
console.log('typecheck: PASS (no new diagnostics from the iOS patches/overrides)');
