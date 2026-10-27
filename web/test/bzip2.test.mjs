#!/usr/bin/env node
// libbzip2 for the client's jag archives and the World map's (web/host/bzip2.js, the client's override of
// src/io/BZip2.js): every bzip2 stream the client decodes (its 8 archives, whole or entry by entry: 141 streams) and
// worldmap.jag's 22 decode to the same bytes as with upstream's SheetJS decoder, but for title.dat's first byte (the
// title's JPEG: libbzip2 0xFF, SheetJS 0x00, which decodeJpeg sets to 0xFF before it reads the image, so the image is
// the same). Both of bzip2.js's ways in (WebKit's synchronous instance, Chrome's asynchronous one), and the override's
// fallback to the unchanged SheetJS code: no decoder (no WebAssembly: Lockdown Mode; a module that does not load), and
// a decoder that throws. Reads the upstream engine's pack and its bzip2.wasm (no build needed). Prints both decoders'
// time over the client's streams (V8).
//
//   node web/test/bzip2.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

import { ENGINE_DIR, REPO_DIR, WEBCLIENT_DIR } from '../../scripts/lib/upstream.mjs';
import { deriveClientFiles, readPack } from '../client/lib/cache.mjs';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
    if (ok) pass++;
    else fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const WASM = path.join(ENGINE_DIR, 'src/3rdparty/bzip2-wasm/bzip2-1.0.8/bzip2.wasm');
const SOURCE = fs.readFileSync(path.join(REPO_DIR, 'web/host/bzip2.js'), 'utf8');
const wasmBytes = fs.readFileSync(WASM);

// bzip2.js as a page runs it: a classic script on window, fetching its URL (here: the engine's bzip2.wasm, or nothing)
function loadBzip2({ webAssembly = WebAssembly, fetchOk = true } = {}) {
    const window = {};
    const context = vm.createContext({
        window,
        console: { warn: () => {} },
        fetch: async () => (fetchOk ? { ok: true, arrayBuffer: async () => wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.length) } : { ok: false, status: 404 })
    });
    // (a context has its own WebAssembly: replaced, or taken away)
    context.__wasm = webAssembly;
    vm.runInContext('if (__wasm) { globalThis.WebAssembly = __wasm; } else { delete globalThis.WebAssembly; } delete globalThis.__wasm;', context);
    vm.runInContext(SOURCE, context, { filename: 'bzip2.js' });
    return window.__lcBzip2.load('engine/bzip2.wasm');
}

// Chrome's main thread: no synchronous Module or Instance over 4 KB (RangeError), the asynchronous API works
const asyncCalls = { compile: 0, instantiate: 0 };
const chromeWasm = {
    Module: Object.assign(
        function () {
            throw new RangeError('WebAssembly.Module(): buffer size exceeds the main thread limit');
        },
        { imports: WebAssembly.Module.imports }
    ),
    Instance: function () {
        throw new RangeError('WebAssembly.Instance(): module size exceeds the main thread limit');
    },
    compile: bytes => (asyncCalls.compile++, WebAssembly.compile(bytes)),
    instantiate: (module, imports) => (asyncCalls.instantiate++, WebAssembly.instantiate(module, imports))
};

// ---- the streams: every jag archive the client loads (as the build derives them from the pack) and worldmap.jag
const g2 = (b, p) => (b[p] << 8) | b[p + 1];
const g3 = (b, p) => (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];
const g4 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) | 0;
const genHash = name => [...name.toUpperCase()].reduce((h, c) => (h * 61 + c.charCodeAt(0) - 32) | 0, 0);

const { bunzip2: sheetjs } = await import(pathToFileURL(path.join(WEBCLIENT_DIR, 'src/io/BZip2.js')).href);
const { bunzip2: override } = await import(pathToFileURL(path.join(REPO_DIR, 'web/client/overrides/src/io/BZip2.js')).href);

// JagFile's two ways: a whole archive (its header, then the bzip2 of all of it; the entries stored) or entry by entry
function streamsOf(archive, data) {
    const unpacked = g3(data, 0);
    const packed = g3(data, 3);
    if (unpacked !== packed) {
        return [{ archive, entry: '(whole)', hash: 0, stream: data.subarray(6), length: unpacked }];
    }
    const out = [];
    const count = g2(data, 6);
    let offset = 8 + count * 10;
    for (let i = 0, p = 8; i < count; i++, p += 10) {
        const size = g3(data, p + 7);
        out.push({ archive, entry: i, hash: g4(data, p), stream: data.subarray(offset, offset + size), length: g3(data, p + 4) });
        offset += size;
    }
    return out;
}

const derived = deriveClientFiles(readPack(path.join(ENGINE_DIR, 'data/pack')), ENGINE_DIR);
const clientStreams = derived.jags.flatMap(j => streamsOf(j.name, j.data));
const worldmapStreams = streamsOf('worldmap', new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/mapview/worldmap.jag'))));
check('the client decodes 141 bzip2 streams at start, worldmap.jag has 22', clientStreams.length === 141 && worldmapStreams.length === 22, `${clientStreams.length}, ${worldmapStreams.length}`);

const TITLE_DAT = genHash('title.dat');
const isTitleDat = s => s.archive === 'title' && s.hash === TITLE_DAT;
check('title.dat is one entry of the title archive', clientStreams.filter(isTitleDat).length === 1);

const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0;
const reference = new Map([...clientStreams, ...worldmapStreams].map(s => [s, sheetjs(s.stream)]));
check('SheetJS: every stream decodes to the length its archive gives', [...reference].every(([s, out]) => out.length === s.length));

// with libbzip2, as the client and the World map run it (globalThis.__LC_BZIP2__ set by the host page)
function compareWith(decoder, label) {
    globalThis.__LC_BZIP2__ = decoder;
    let calls = 0;
    const counting = { decompress: stream => (calls++, decoder.decompress(stream)) };
    globalThis.__LC_BZIP2__ = counting;
    const differ = [];
    let titleOk = false;
    for (const s of [...clientStreams, ...worldmapStreams]) {
        const ref = reference.get(s);
        const out = override(s.stream);
        if (same(out, ref)) {
            continue;
        }
        if (isTitleDat(s)) {
            const firstByteOnly = out.length === ref.length && ref[0] === 0x00 && out[0] === 0xff && same(out.subarray(1), ref.subarray(1));
            // decodeJpeg (src/graphics/Jpeg.ts): `if (data[0] !== 0xff) data[0] = 0xff` before the image is read
            const jpeg = Uint8Array.from(ref);
            jpeg[0] = 0xff;
            titleOk = firstByteOnly && same(out, jpeg);
            continue;
        }
        differ.push(`${s.archive}#${s.entry}`);
    }
    delete globalThis.__LC_BZIP2__;
    check(`${label}: all 163 streams through libbzip2 (no fallback)`, calls === 163, `${calls} calls`);
    check(`${label}: the same bytes as SheetJS for the 140 other client streams and the 22 of worldmap.jag`, differ.length === 0, differ.join(', '));
    check(`${label}: title.dat differs only at byte 0 (SheetJS 0x00, libbzip2 0xFF), the same once decodeJpeg sets it`, titleOk);
}

const webkit = await loadBzip2();
check('bzip2.js: a decoder from the synchronous instance (WebKit)', typeof webkit?.decompress === 'function');
compareWith(webkit, 'synchronous');
const chrome = await loadBzip2({ webAssembly: chromeWasm });
check('bzip2.js: a decoder from the asynchronous instance (Chrome\'s main-thread limit)', typeof chrome?.decompress === 'function' && asyncCalls.compile === 1 && asyncCalls.instantiate === 1, JSON.stringify(asyncCalls));
compareWith(chrome, 'asynchronous');

// no decoder: no WebAssembly (Lockdown Mode), or the module missing
check('bzip2.js: no WebAssembly → null (the client decodes with SheetJS)', (await loadBzip2({ webAssembly: null })) === null);
check('bzip2.js: engine/bzip2.wasm missing → null', (await loadBzip2({ fetchOk: false })) === null);

// the override's fallback is upstream's code, unchanged: the same output as upstream's own module
delete globalThis.__LC_BZIP2__;
check('override without __LC_BZIP2__: byte-identical to upstream for all 163', [...reference].every(([s, ref]) => same(override(s.stream), ref)));
globalThis.__LC_BZIP2__ = {
    decompress() {
        throw new Error('refused');
    }
};
check('override with a decoder that throws: falls back, byte-identical to upstream for all 163', [...reference].every(([s, ref]) => same(override(s.stream), ref)));
delete globalThis.__LC_BZIP2__;
let upstreamError = null;
let overrideError = null;
const broken = Uint8Array.from(clientStreams[0].stream);
broken.fill(0x55, 8, 64);
try {
    sheetjs(broken);
} catch (err) {
    upstreamError = String(err);
}
globalThis.__LC_BZIP2__ = webkit;
try {
    override(broken);
} catch (err) {
    overrideError = String(err);
}
delete globalThis.__LC_BZIP2__;
check('a damaged stream: libbzip2 refuses it and the SheetJS code decides, as upstream does', overrideError === upstreamError, `${upstreamError} / ${overrideError}`);
check('checkMagic/checkCRC calls (none in the client) go to the SheetJS code', (() => {
    globalThis.__LC_BZIP2__ = { decompress: () => new Uint8Array(1) };
    const s = clientStreams[0];
    let ok;
    try {
        ok = override(s.stream, false, true).length === s.length;
    } catch {
        ok = false;
    }
    delete globalThis.__LC_BZIP2__;
    return ok;
})());

// the time over the client's start-up streams (V8, best of 3)
const time = fn => {
    let best = Infinity;
    for (let r = 0; r < 3; r++) {
        const t = performance.now();
        for (const s of clientStreams) fn(s.stream);
        best = Math.min(best, performance.now() - t);
    }
    return Math.round(best);
};
console.log(`\nthe client's 141 streams (${(clientStreams.reduce((n, s) => n + s.length, 0) / 1048576).toFixed(1)} MB decoded), V8: SheetJS ${time(sheetjs)} ms, libbzip2 ${time(s => webkit.decompress(s))} ms`);
console.log(`bzip2: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
