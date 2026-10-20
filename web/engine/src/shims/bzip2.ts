// Replacement for engine/src/io/BZip2.ts ('#/io/BZip2.js'), bzip2 "auto" mode.
//
// Start-up decompresses the jag archives (client/config, client/interface, client/title, raw/wordenc); the engine's
// WASM libbzip2 does that fastest. WebAssembly can be missing (iOS Lockdown Mode, jsc --useWasm=false) or
// bzip2.wasm can fail to load: then the pure-TS decoder (bunzip2.ts, byte-exact) is used.
// After World.start() the entry calls release(): the WASM instance and its 16 MB linear memory become garbage and
// any later decompression (the ::reload cheat) uses the TS decoder.
//
// The wasm bytes are fetched next to the bundle (lostcity://game/engine/bzip2.wasm); a missing file is not fatal.
import { decompress as decompressJs } from './bunzip2.js';
import { createWasmBzip2, type WasmDecoder } from './bzip2-wasm.js';
import { testOptions } from '../runtime/options.js';

let wasm: WasmDecoder | null = null;

if (typeof WebAssembly === 'object' && WebAssembly !== null && testOptions.wasmBzip2 !== false) {
    try {
        const res = await fetch(new URL('bzip2.wasm', import.meta.url).href);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        wasm = createWasmBzip2(new Uint8Array(await res.arrayBuffer()));
    } catch (e) {
        console.warn(`[bzip2] WebAssembly decoder unavailable (${e instanceof Error ? e.message : e}); using the JavaScript decoder`);
    }
}

const bzip2 = {
    get kind(): 'wasm' | 'js' {
        return wasm ? 'wasm' : 'js';
    },
    async init() {},
    decompress(compressed: Uint8Array, decompressedLength: number, prependHeader = false, containsDecompressedLength = false): Uint8Array {
        if (wasm) return wasm.decompress(compressed, decompressedLength, prependHeader, containsDecompressedLength);
        return decompressJs(compressed, decompressedLength, prependHeader, containsDecompressedLength);
    },
    compress(): Uint8Array {
        throw new Error('bzip2 compression is only used by the packer');
    },
    /** Drop the WASM decoder so its memory can be collected; later calls use the TS decoder. */
    release() {
        wasm = null;
    }
};

export default bzip2;
