#!/usr/bin/env node
// runtime/memory.ts installTypedScriptArrays (script bytecode in typed arrays) against upstream's ScriptFile.decode:
// every script of the pinned script.dat is decoded by two copies of the engine (bundled twice), one patched. Each
// script must hold the same values at every index - opcodes, int operands, the line table - and the same everything
// else (string operands, switch tables, counts, names); lineNumber() must answer the same for every pc; the only
// difference allowed is a hole in the int operands reading 0, and only at a PUSH_CONSTANT_STRING (whose handler reads
// the string operand). The arrays must really be typed, and a narrower int-operand array must be caught.
//
//   node web/engine/test/script-arrays.test.mjs
import fs from 'node:fs';
import path from 'node:path';

import { ENGINE_DIR } from '../../../scripts/lib/upstream.mjs';
import { importBundled } from './lib/bundle.mjs';

const ENTRY = `export { default as ScriptFile } from '#/engine/script/ScriptFile.js';
export { ScriptOpcode } from '#/engine/script/ScriptOpcode.js';
export { default as Packet } from '#/io/Packet.js';
export { installTypedScriptArrays } from './runtime/memory.js';`;
const A = await importBundled('script-arrays-upstream', ENTRY);
const B = await importBundled('script-arrays-patched', ENTRY);
B.installTypedScriptArrays(B.ScriptFile);
const PUSH_CONSTANT_STRING = A.ScriptOpcode.PUSH_CONSTANT_STRING;

const dat = fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.dat'));
const idx = fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.idx'));

/** Every script of the pack, as ScriptProvider.parse reads it (ScriptProvider.ts:40-70). */
function decodeAll(M) {
    const d = new M.Packet(new Uint8Array(dat));
    const x = new M.Packet(new Uint8Array(idx));
    const entries = d.g4s();
    x.pos += 4;
    d.g4s(); // the compiler version
    const scripts = [];
    for (let id = 0; id < entries; id++) {
        const size = x.g4s();
        if (size === 0) continue;
        const data = new Uint8Array(size);
        d.gdata(data, 0, data.length);
        scripts.push(M.ScriptFile.decode(id, new M.Packet(data)));
    }
    return scripts;
}

let failed = 0;
function report(name, ok, detail = '') {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** '' if script b holds what a holds (holes in a's int operands: 0 in b, at a PUSH_CONSTANT_STRING); else what differs. */
function compare(a, b) {
    const same = (x, y, name) => {
        if (x.length !== y.length) return `${name}.length ${x.length} / ${y.length}`;
        for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return `${name}[${i}] ${x[i]} / ${y[i]}`;
        return '';
    };
    const d = same(a.opcodes, b.opcodes, 'opcodes') || same(a.info.pcs, b.info.pcs, 'pcs') || same(a.info.lines, b.info.lines, 'lines');
    if (d) return d;
    if (a.intOperands.length !== b.intOperands.length) return `intOperands.length ${a.intOperands.length} / ${b.intOperands.length}`;
    for (let i = 0; i < a.intOperands.length; i++) {
        const x = a.intOperands[i];
        const y = b.intOperands[i];
        if (x === undefined ? y !== 0 || a.opcodes[i] !== PUSH_CONSTANT_STRING : x !== y) return `intOperands[${i}] ${x} / ${y} (opcode ${a.opcodes[i]})`;
    }
    for (let pc = -2; pc <= a.opcodes.length + 1; pc++) if (a.lineNumber(pc) !== b.lineNumber(pc)) return `lineNumber(${pc}) ${a.lineNumber(pc)} / ${b.lineNumber(pc)}`;
    // (switch tables and string operands are sparse: a switch key can be any int)
    const rest = s => JSON.stringify([s.id, s.intLocalCount, s.stringLocalCount, s.intArgCount, s.stringArgCount, s.switchTables.map(t => Object.entries(t)), Object.entries(s.stringOperands), { ...s.info, pcs: 0, lines: 0 }, Object.keys(s)]);
    return rest(a) === rest(b) ? '' : 'other fields';
}

const a = decodeAll(A);
const b = decodeAll(B);
let diff = a.length === b.length ? '' : `${a.length} / ${b.length} scripts`;
let holes = 0;
let elements = 0;
for (let i = 0; i < a.length && !diff; i++) {
    const d = compare(a[i], b[i]);
    if (d) diff = `${a[i].name}: ${d}`;
    for (let k = 0; k < a[i].intOperands.length; k++) if (a[i].intOperands[k] === undefined) holes++;
    elements += a[i].opcodes.length * 2 + a[i].info.pcs.length * 2;
}
report(`all ${a.length} scripts: the same values at every index, the same line numbers and other fields`, diff === '', diff || `${elements} elements, ${holes} holes read 0, all at PUSH_CONSTANT_STRING`);
const typed = b.every(s => s.opcodes instanceof Uint16Array && s.intOperands instanceof Int32Array && s.info.pcs instanceof Int32Array && s.info.lines instanceof Int32Array);
report('every script holds typed arrays', typed);

// the comparison sees a narrower array: int operands as Int16Array
const M = await importBundled('script-arrays-mutant', ENTRY);
M.installTypedScriptArrays(M.ScriptFile);
const decode = M.ScriptFile.decode;
M.ScriptFile.decode = function (id, stream) {
    const s = decode.call(this, id, stream);
    s.intOperands = Int16Array.from(s.intOperands);
    return s;
};
const m = decodeAll(M);
const mutantDiff = a.map((s, i) => compare(s, m[i])).find(d => d) ?? '';
report('int operands narrowed to 16 bits are caught', mutantDiff !== '', mutantDiff);

console.log(failed ? `\n${failed} check(s) failed` : '\nPASS  typed script arrays: the same values as upstream');
process.exit(failed ? 1 : 0);
