#!/usr/bin/env node
// Runs every engine-worker test in sequence (about 10 minutes): unit/differential tests, the Node vm sandbox
// (release and debug builds), JavaScriptCore with and without JIT/WebAssembly, the bots (vm + JSC), and headless Chrome.
//
//   node web/engine/test/all.mjs [--skip-chrome] [--port 47310]   (--port: chrome.test.mjs's server; Chrome gets the next)
//
// The bots glue is type-checked and tested twice: against the real bot library (web/engine/bots/src: `tsc -p
// web/engine`, bots.test.mjs --real) and against the stub (test/fixtures/stub-bots), whose scripted behaviour lets the
// glue's own checks be exact (who answers which chat line, which name a backfill takes). The bot library's own tests
// are web/engine/bots/test/all.mjs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_DIR, derivedTsconfig } from '../../../scripts/lib/upstream.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const node = (...a) => [process.execPath, a];
const tsc = path.join(ENGINE_DIR, 'node_modules/typescript/bin/tsc');
// (the committed tsconfigs name the sibling ../Server: derivedTsconfig points them at the resolved upstream folder)
const tests = [
    ['upstream pins (upstream.json, BASE files, resolver)', ...node(path.resolve(HERE, '../../test/upstream.test.mjs'))],
    ['typecheck (real bot library)', process.execPath, [tsc, '-p', derivedTsconfig(path.resolve(HERE, '../tsconfig.json'))]],
    ['typecheck (stub bot library)', process.execPath, [tsc, '-p', derivedTsconfig(path.join(HERE, 'fixtures/stub-bots/tsconfig.json'))]],
    ['bzip2 decoders', ...node(path.join(HERE, 'bzip2.test.mjs'))],
    ['forge-lite', ...node(path.join(HERE, 'forge-lite.test.mjs'))],
    ['Packet.gjstr', ...node(path.join(HERE, 'gjstr.test.mjs'))],
    ['vm sandbox (release)', ...node('--expose-gc', '--experimental-vm-modules', path.join(HERE, 'vm.test.mjs'))],
    ['vm sandbox (debug)', ...node('--expose-gc', '--experimental-vm-modules', path.join(HERE, 'vm.test.mjs'), '--debug')],
    ['vm sandbox (a normal player: Jmod Off)', ...node('--expose-gc', '--experimental-vm-modules', path.join(HERE, 'vm.test.mjs'), '--player', '--no-build')],
    ['JavaScriptCore (JIT; no JIT + no WASM)', ...node(path.join(HERE, 'jsc.test.mjs'), '--no-build')],
    ['bots (real library; vm + JSC)', ...node('--expose-gc', '--experimental-vm-modules', path.join(HERE, 'bots.test.mjs'), '--real')],
    ['bots (stub library; vm + JSC)', ...node('--expose-gc', '--experimental-vm-modules', path.join(HERE, 'bots.test.mjs'))],
    ['headless Chrome module worker', ...node(path.join(HERE, 'chrome.test.mjs'), '--no-build', ...(process.argv.includes('--port') ? ['--port', process.argv[process.argv.indexOf('--port') + 1]] : []))]
].filter(([name]) => !(name.startsWith('headless') && (process.argv.includes('--skip-chrome') || !fs.existsSync('/Applications/Google Chrome.app'))));

let failed = 0;
for (const [name, cmd, args] of tests) {
    const t = Date.now();
    const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    const last = out.trim().split('\n').filter(l => /PASS|FAIL|error/i.test(l)).slice(-1)[0] ?? out.trim().split('\n').slice(-1)[0] ?? '';
    const ok = r.status === 0;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(40)} ${String(Math.round((Date.now() - t) / 1000)).padStart(4)} s  ${ok ? last.slice(0, 120) : ''}`);
    if (!ok) console.log(out.split('\n').slice(-40).join('\n'));
}
console.log(failed ? `\n${failed} test group(s) failed` : '\nall engine tests passed');
process.exit(failed ? 1 : 0);
