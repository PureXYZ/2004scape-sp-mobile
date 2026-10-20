// The engine's libbzip2 WebAssembly build (src/3rdparty/bzip2-wasm/bzip2-1.0.8/bzip2.wasm, emscripten) driven
// directly, without emscripten's JS glue (bzip2.mjs) or the BZ2Wasm wrapper class.
//
// Why: measured in JavaScriptCore (test/README numbers), the glue keeps its instance and 16 MB linear memory
// (~33 MB of gcHeapSize) alive for the life of the worker even after every reference is dropped - an ASSERTIONS
// build that also defines ~180 accessor properties on globalThis - and JSC never collected instances created with
// the async WebAssembly.instantiate() either. A synchronously compiled/instantiated module with the few imports
// below is collected as soon as the decoder object is dropped, which is what lets the entry release it after start.
//
// Same results as BZ2Wasm.decompress (bzip2-wasm.js:93-133): BZ2_bzBuffToBuffDecompress with small=0, verbosity=0.
// Unlike upstream it never writes into the caller's buffer (upstream overwrites the 4-byte length prefix in place).

type Exports = {
    memory: WebAssembly.Memory;
    malloc(n: number): number;
    free(p: number): void;
    BZ2_bzBuffToBuffDecompress(dest: number, destLenPtr: number, src: number, srcLen: number, small: number, verbosity: number): number;
    emscripten_stack_init?: () => void;
    __wasm_call_ctors?: () => void;
};

const ERRORS: Record<string, string> = {
    '-2': 'BZ_PARAM_ERROR: incorrect parameters',
    '-3': "BZ_MEM_ERROR: couldn't allocate enough memory",
    '-4': 'BZ_DATA_ERROR: data integrity error when decompressing',
    '-5': 'BZ_DATA_ERROR_MAGIC: compressed data has incorrect header',
    '-7': 'BZ_UNEXPECTED_EOF: compressed data ends too early',
    '-8': 'BZ_OUTBUFF_FULL: destination buffer is full'
};

const MAX_HEAP = 2147483648;

export type WasmDecoder = { decompress(c: Uint8Array, len: number, prependHeader?: boolean, containsLen?: boolean): Uint8Array };

export function createWasmBzip2(wasmBytes: Uint8Array): WasmDecoder {
    const module = new WebAssembly.Module(wasmBytes);
    let memory: WebAssembly.Memory | null = null;
    const heap = () => new Uint8Array(memory!.buffer);

    // emscripten runtime imports used by this build (bzip2.mjs:1261-1274)
    const known: Record<string, (...a: number[]) => number | void> = {
        _emscripten_memcpy_js: (dest, src, num) => void heap().copyWithin(dest, src, src + num),
        // bzip2.mjs:1038-1093 _emscripten_resize_heap: geometric growth (+20%, at most +96 MB over the request)
        emscripten_resize_heap: requested => {
            requested >>>= 0;
            const old = memory!.buffer.byteLength;
            if (requested > MAX_HEAP) return 0;
            for (let cutDown = 1; cutDown <= 4; cutDown *= 2) {
                const overGrown = Math.min(old * (1 + 0.2 / cutDown), requested + 100663296);
                const size = Math.min(MAX_HEAP, Math.ceil(Math.max(requested, overGrown) / 65536) * 65536);
                try {
                    memory!.grow((size - old + 65535) >>> 16);
                    return 1;
                } catch {
                    // try a smaller step
                }
            }
            return 0;
        },
        exit: code => {
            throw new Error(`bzip2.wasm called exit(${code})`);
        },
        fd_close: () => 0,
        fd_seek: () => 70, // ESPIPE: no files here
        // libbzip2 only prints with verbosity > 0; count the bytes so a stray fprintf cannot loop
        fd_write: (_fd, iov, iovcnt, pnum) => {
            const dv = new DataView(memory!.buffer);
            let n = 0;
            for (let i = 0; i < iovcnt; i++) n += dv.getUint32(iov + i * 8 + 4, true);
            dv.setUint32(pnum, n, true);
            return 0;
        }
    };
    const imports: Record<string, Record<string, unknown>> = {};
    for (const imp of WebAssembly.Module.imports(module)) {
        if (imp.kind !== 'function') throw new Error(`bzip2.wasm imports a ${imp.kind} (${imp.module}.${imp.name})`);
        (imports[imp.module] ??= {})[imp.name] =
            known[imp.name] ??
            (() => {
                throw new Error(`bzip2.wasm called unexpected import ${imp.module}.${imp.name}`);
            });
    }

    // synchronous on purpose (see the header); fine in a worker for an 87 kB module
    const instance = new WebAssembly.Instance(module, imports as WebAssembly.Imports);
    const ex = instance.exports as unknown as Exports;
    memory = ex.memory;
    ex.emscripten_stack_init?.();
    ex.__wasm_call_ctors?.();

    return {
        decompress(compressed: Uint8Array, decompressedLength: number, prependHeader = false, containsDecompressedLength = false): Uint8Array {
            let src = compressed;
            if (containsDecompressedLength) {
                decompressedLength = ((compressed[0] << 24) | (compressed[1] << 16) | (compressed[2] << 8) | compressed[3]) >>> 0;
                src = new Uint8Array(compressed.length);
                src.set(compressed.subarray(4), 4);
                prependHeader = false;
            } else if (prependHeader) {
                src = new Uint8Array(compressed.length + 4);
                src.set(compressed, 4);
            }
            if (src !== compressed) src.set([0x42, 0x5a, 0x68, 0x31]); // "BZh1"

            const srcPtr = ex.malloc(src.length);
            const destPtr = ex.malloc(Math.max(1, decompressedLength));
            const lenPtr = ex.malloc(4);
            if (!srcPtr || !destPtr || !lenPtr) throw new Error('bzip2.wasm: out of memory');
            heap().set(src, srcPtr);
            new DataView(memory!.buffer).setInt32(lenPtr, decompressedLength, true);
            const ret = ex.BZ2_bzBuffToBuffDecompress(destPtr, lenPtr, srcPtr, src.length, 0, 0);
            ex.free(srcPtr);
            try {
                if (ret !== 0) throw new Error(ERRORS[String(ret)] ?? `bzip2 error code ${ret}`);
                const outLen = new DataView(memory!.buffer).getInt32(lenPtr, true);
                return heap().slice(destPtr, destPtr + outLen);
            } finally {
                ex.free(destPtr);
                ex.free(lenPtr);
            }
        }
    };
}
