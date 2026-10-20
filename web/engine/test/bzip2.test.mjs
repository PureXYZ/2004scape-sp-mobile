#!/usr/bin/env node
// Differential test of the engine worker's two bzip2 decoders against the engine's own decoder:
//   reference  engine/src/3rdparty/bzip2-wasm (emscripten glue + bzip2.wasm, exactly what the server runs)
//   wasm       src/shims/bzip2-wasm.ts (same bzip2.wasm, glue-free, synchronous instantiation)
//   ts         src/shims/bunzip2.ts (pure TypeScript: Lockdown Mode and everything after start-up)
// Inputs: every bzip2 entry of the 8 jag archives in data/pack (+ raw/wordenc), and synthetic data compressed by
// /usr/bin/bzip2 at levels 1 and 9 (multi-block, long runs for RLE1, random, text), in the three framings the
// engine API supports (with header, headerless, 4-byte length prefix). Corrupted streams must fail the same way.
//
//   node web/engine/test/bzip2.test.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { importBundled } from './lib/bundle.mjs';
import { SERVER } from './lib/fixture.mjs';

const ENGINE = path.join(SERVER, 'engine');
const { decompressJs, createWasmBzip2 } = await importBundled('bzip2-test', `export { decompress as decompressJs } from './shims/bunzip2.js';\nexport { createWasmBzip2 } from './shims/bzip2-wasm.js';`);
const { default: BZ2Wasm } = await import(pathToFileURL(path.join(ENGINE, 'src/3rdparty/bzip2-wasm/bzip2-wasm.js')).href);
const reference = new BZ2Wasm();
await reference.init();
const wasm = createWasmBzip2(new Uint8Array(fs.readFileSync(path.join(ENGINE, 'src/3rdparty/bzip2-wasm/bzip2-1.0.8/bzip2.wasm'))));

let checks = 0;
const failures = [];
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0;
const time = { reference: 0, wasm: 0, ts: 0 };

function run(label, fn) {
    const t = performance.now();
    try {
        return { out: fn() };
    } catch (e) {
        return { err: e.message };
    } finally {
        time[label] += performance.now() - t;
    }
}

function compare(name, input, len, prependHeader, containsLen, expected) {
    checks++;
    const pristine = input.slice();
    // upstream mutates its input when containsLen is set: give it a copy
    const ref = run('reference', () => reference.decompress(input.slice(), len, prependHeader, containsLen));
    const w = run('wasm', () => wasm.decompress(input, len, prependHeader, containsLen));
    const t = run('ts', () => decompressJs(input, len, prependHeader, containsLen));
    const problems = [];
    if (!same(input, pristine)) problems.push('input was modified');
    if (expected && (!ref.out || !same(ref.out, expected))) problems.push('reference did not reproduce the original data');
    for (const [label, r] of [['wasm', w], ['ts', t]]) {
        if (ref.err) {
            if (!r.err) problems.push(`${label} accepted data the reference rejects (${ref.err})`);
        } else if (r.err) problems.push(`${label} failed: ${r.err}`);
        else if (!same(r.out, ref.out)) problems.push(`${label} output differs (${r.out.length} vs ${ref.out.length} bytes)`);
    }
    if (problems.length) failures.push(`${name}: ${problems.join('; ')}`);
}

// ---- 1. the engine's data --------------------------------------------------------------------------------
const g3 = (d, p) => (d[p] << 16) | (d[p + 1] << 8) | d[p + 2];
let entries = 0;
let entryBytes = 0;
for (const f of ['data/pack/client/config', 'data/pack/client/interface', 'data/pack/client/title', 'data/pack/client/media', 'data/pack/client/textures', 'data/pack/client/sounds', 'data/pack/client/versionlist', 'data/raw/wordenc']) {
    const src = new Uint8Array(fs.readFileSync(path.join(ENGINE, f)));
    const unpacked = g3(src, 0);
    const packed = g3(src, 3);
    let data = src.subarray(6);
    const whole = unpacked !== packed;
    if (whole) {
        compare(`${f} (whole archive)`, src.subarray(6), unpacked, true, false);
        data = reference.decompress(src.slice(6), unpacked, true);
        entryBytes += unpacked;
    }
    const count = (data[0] << 8) | data[1];
    let pos = 2 + count * 10;
    for (let i = 0; i < count; i++) {
        const o = 2 + i * 10;
        const usize = g3(data, o + 4);
        const psize = g3(data, o + 7);
        if (!whole) {
            compare(`${f} #${i}`, data.subarray(pos, pos + psize), usize, true, false);
            entryBytes += usize;
        }
        pos += psize;
        entries++;
    }
}
console.log(`engine data: ${entries} jag entries (${(entryBytes / 1048576).toFixed(2)} MB decompressed)`);
const engineTime = { ...time };

// ---- 2. synthetic data through /usr/bin/bzip2 ------------------------------------------------------------
let seed = 1234567;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 0xff;
function sample(kind, n) {
    const u = new Uint8Array(n);
    if (kind === 'random') for (let i = 0; i < n; i++) u[i] = rnd();
    else if (kind === 'runs') {
        // runs of 1..300 equal bytes: exercises RLE1 (4 + count) and the RUNA/RUNB stage
        for (let i = 0; i < n; ) {
            const len = 1 + ((rnd() << 8) | rnd()) % 300;
            u.fill(rnd() & 7, i, Math.min(n, i + len));
            i += len;
        }
    } else if (kind === 'text') {
        const words = ['lumbridge', 'goblin', 'rune', 'scimitar', 'fishing', 'the', 'a', 'of', '\n', 'cooking', 'varrock'];
        let s = '';
        while (s.length < n) s += words[rnd() % words.length] + ' ';
        u.set(new TextEncoder().encode(s.slice(0, n)));
    } else if (kind === 'zeros') u.fill(0);
    return u;
}
for (const level of [1, 9]) {
    for (const [kind, n] of [
        ['random', 1],
        ['zeros', 1],
        ['zeros', 1000000],
        ['random', 4096],
        ['random', 250000],
        ['runs', 50000],
        ['runs', 450000],
        ['text', 120000],
        ['text', 1200000]
    ]) {
        const input = sample(kind, n);
        const r = spawnSync('/usr/bin/bzip2', ['-c', `-${level}`], { input, maxBuffer: 64 * 1024 * 1024 });
        const bz = new Uint8Array(r.stdout);
        const name = `bzip2 -${level} ${kind} ${n} B`;
        compare(`${name} (header)`, bz, n, false, false, input);
        // headerless and length-prefixed input is decoded as "BZh1" (100k blocks), so level-9 streams with bigger
        // blocks must be rejected by all three; only level 1 has to round-trip
        const expect = level === 1 || n < 100000 ? input : undefined;
        compare(`${name} (headerless)`, bz.subarray(4), n, true, false, expect);
        const withLen = bz.slice();
        withLen.set([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
        compare(`${name} (length prefix)`, withLen, n, false, true, expect);
    }
}

// ---- 3. corrupted streams -------------------------------------------------------------------------------
const base = new Uint8Array(spawnSync('/usr/bin/bzip2', ['-c', '-1'], { input: sample('text', 60000) }).stdout);
for (let i = 0; i < 40; i++) {
    const bad = base.slice();
    const at = 10 + (((rnd() << 8) | rnd()) % (bad.length - 20));
    bad[at] ^= 1 << (rnd() & 7);
    compare(`corrupt #${i} (bit flip at ${at})`, bad, 60000, false, false);
}
const truncated = base.subarray(0, base.length >> 1);
compare('truncated stream', truncated, 60000, false, false);

console.log(`${checks} comparisons; decode time on the engine's data (Node, JIT): reference ${engineTime.reference.toFixed(0)} ms, wasm ${engineTime.wasm.toFixed(0)} ms, ts ${engineTime.ts.toFixed(0)} ms`);
if (failures.length) {
    for (const f of failures.slice(0, 30)) console.log('FAIL ' + f);
    console.log(`bzip2: FAIL (${failures.length} of ${checks})`);
    process.exit(1);
}
console.log('bzip2: PASS - wasm and ts decoders match the engine decoder byte for byte, never modify their input, and reject what it rejects');
