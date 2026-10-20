// Runtime monkey-patches applied before any engine data is loaded (imported by the entry ahead of World).
import kleur from 'kleur';

import Packet from '#/io/Packet.js';

import { testOptions } from './options.js';

// No ANSI colour codes: logs end up in the page / native log, not a terminal.
kleur.enabled = false;

// ---- Packet.gjstr: flat strings ---------------------------------------------------------------------------
// Upstream (Packet.ts:267-276) builds every string with `str += String.fromCharCode(b)`, one byte at a time.
// V8 and JavaScriptCore both represent such results as ropes (a node per appended char) until something flattens
// them, and most of these strings (script names, source paths, string operands, config text) are never touched
// again: ~86 MB of the V8 heap after start were rope nodes (engine-runtime report §2.4).
// This version decodes the same bytes in one go. Semantics are exactly the original's:
//   - ISO-8859-1: char code = byte value (String.fromCharCode, not TextDecoder('latin1') = windows-1252)
//   - stops at the first `terminator` byte and consumes it
//   - no terminator before the end: returns all bytes but the LAST one and leaves pos at the end (upstream quirk:
//     the loop checks `pos < length` after advancing past the final byte)
//   - pos outside the buffer: defer to the original, which throws the same RangeError after advancing pos
// test/gjstr.test.mjs fuzzes this against the original.
const CHUNK = 4096; // keeps Function.prototype.apply far below engine argument limits

export function latin1(data: Uint8Array, start: number, end: number): string {
    const n = end - start;
    if (n <= 0) return '';
    if (n <= CHUNK) return String.fromCharCode.apply(null, data.subarray(start, end) as unknown as number[]);
    let s = '';
    for (let i = start; i < end; i += CHUNK) {
        s += String.fromCharCode.apply(null, data.subarray(i, Math.min(end, i + CHUNK)) as unknown as number[]);
    }
    return s;
}

export const originalGjstr = Packet.prototype.gjstr;

export function flatGjstr(this: Packet, terminator: number = 10): string {
    const data = this.data;
    const length = data.length;
    const start = this.pos;
    if (!(start >= 0 && start < length)) {
        return originalGjstr.call(this, terminator);
    }
    const end = data.indexOf(terminator, start);
    if (end === -1) {
        this.pos = length;
        return latin1(data, start, length - 1);
    }
    this.pos = end + 1;
    return latin1(data, start, end);
}

if (testOptions.flatStrings !== false) {
    Packet.prototype.gjstr = flatGjstr;
}
