#!/usr/bin/env node
// The flat-string Packet.gjstr (src/runtime/patches.ts) against the original (Packet.ts:267-276) on 200k fuzzed
// cases: same string (code units compared exactly, all 256 byte values), same pos afterwards, same exception
// (type and message) when reading past the end. Covers terminators 10 and 0 (both used by the engine), a missing
// terminator (the original drops the last byte), a terminator as the last byte, empty strings, pos at/after the
// end, strings longer than one apply() chunk, and sub-array Packets (non-zero byteOffset).
//
//   node web/engine/test/gjstr.test.mjs
import { importBundled } from './lib/bundle.mjs';

const { Packet, flat, original } = await importBundled('gjstr-test', `export { default as Packet } from '#/io/Packet.js';\nexport { flatGjstr as flat, originalGjstr as original } from './runtime/patches.js';`);

let seed = 42;
const rnd = n => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) % n;

function attempt(fn, pkt, term) {
    try {
        return { s: fn.call(pkt, term), pos: pkt.pos };
    } catch (e) {
        return { err: `${e.constructor.name}: ${e.message}`, pos: pkt.pos };
    }
}

let cases = 0;
let failures = 0;
const kinds = { terminated: 0, unterminated: 0, threw: 0, long: 0 };
for (let i = 0; i < 200000; i++) {
    const len = i % 1000 === 0 ? 5000 + rnd(20000) : rnd(40);
    const pad = rnd(3) === 0 ? rnd(16) : 0;
    const backing = new Uint8Array(len + pad * 2);
    for (let k = 0; k < backing.length; k++) backing[k] = rnd(4) === 0 ? rnd(256) : 32 + rnd(95);
    const data = backing.subarray(pad, pad + len);
    const term = rnd(2) ? 10 : 0;
    // sometimes no terminator at all, sometimes exactly at the end
    if (rnd(4) === 0) for (let k = 0; k < len; k++) if (data[k] === term) data[k] = term + 1;
    if (len && rnd(8) === 0) data[len - 1] = term;
    const start = len === 0 ? 0 : rnd(5) === 0 ? len - rnd(Math.min(len, 3) + 2) + 1 : rnd(len);

    const a = new Packet(data);
    const b = new Packet(data);
    a.pos = b.pos = start;
    const ra = attempt(original, a, term);
    const rb = attempt(flat, b, term);
    cases++;
    if (ra.err) kinds.threw++;
    else if (data.indexOf(term, start) === -1) kinds.unterminated++;
    else kinds.terminated++;
    if (len > 4096) kinds.long++;
    if (ra.err !== rb.err || ra.pos !== rb.pos || ra.s !== rb.s) {
        failures++;
        if (failures < 10) console.log('FAIL', { len, start, term, ra: { ...ra, s: ra.s?.slice(0, 40) }, rb: { ...rb, s: rb.s?.slice(0, 40) } });
    }
}
console.log(failures ? `gjstr: FAIL (${failures}/${cases})` : `gjstr: PASS - ${cases} cases identical (${JSON.stringify(kinds)})`);
process.exit(failures ? 1 : 0);
