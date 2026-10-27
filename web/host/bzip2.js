// LostCity iOS host page: libbzip2 for the client's jag archives and the World map's.
//
// The client bzip2-decodes its 8 jag archives at every launch (141 streams, 0.7 MB in and 3 MB out) on the page's main
// thread, with upstream's JavaScript decoder (SheetJS's, src/io/BZip2.js): about 10x slower than libbzip2 and a lot of
// garbage, most of the page's start-up work in V8. The engine ships libbzip2 1.0.8 as WebAssembly (engine/bzip2.wasm),
// which decodes its own copies of the same archives (web/engine/src/shims/bzip2-wasm.ts); this drives that module the
// same way, without emscripten's glue, for the page.
//
// window.__lcBzip2.load(url) resolves to { decompress(stream) } (a jag stream, the "BZh1" header dropped: what the
// client's bunzip2 takes), or to null where there is no WebAssembly (Lockdown Mode) or the module does not load. The
// client's override of src/io/BZip2.js (web/client/overrides) uses it while globalThis.__LC_BZIP2__ holds it and
// otherwise decodes as upstream: host.js offers it until the client has loaded, mapview.html until the World map has
// (worldmap.js). The decoder object holds the only reference to the instance and its memory, which go with it.
//
// The same bytes, every stream: web/test/bzip2.test.mjs (all 141 of the client's and the World map's 22). The one
// difference is the first byte of title.dat, the title's JPEG: libbzip2 gives the JPEG's 0xFF where the JavaScript
// decoder gives 0x00, and the client's decodeJpeg sets that byte to 0xFF before it reads the image anyway.
//
// WebKit compiles and instantiates the module synchronously, so JavaScriptCore can collect it once dropped (it kept
// instances made with the asynchronous API: web/engine/README.md, bzip2). Chrome (Android's WebView) allows that on the
// main thread only for modules under 4 KB (87 KB here), so there it is compiled and instantiated asynchronously.
(() => {
    'use strict';

    const HEADER = [0x42, 0x5a, 0x68, 0x31]; // "BZh1": the jag format's streams are bzip2 with 100k blocks, header dropped
    const MIN_OUT = 65536;
    const MAX_OUT = 64 << 20; // (the largest stream decodes to 2.7 MB: a guard against a runaway, not a limit in use)
    const MAX_HEAP = 2147483648;
    const BZ_OK = 0;
    const BZ_OUTBUFF_FULL = -8;

    async function load(url) {
        if (typeof WebAssembly !== 'object' || WebAssembly === null) {
            return null;
        }
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return await instantiate(new Uint8Array(await response.arrayBuffer()));
        } catch (err) {
            console.warn(`[bzip2] ${url} did not load; the JavaScript decoder is used`, err);
            return null;
        }
    }

    async function instantiate(bytes) {
        let module;
        try {
            module = new WebAssembly.Module(bytes); // (WebKit)
        } catch {
            module = await WebAssembly.compile(bytes); // (Chrome's main-thread limit)
        }
        let memory = null;
        const heap = () => new Uint8Array(memory.buffer);
        // the emscripten runtime imports this build uses (as web/engine/src/shims/bzip2-wasm.ts provides them)
        const known = {
            _emscripten_memcpy_js: (dest, src, num) => void heap().copyWithin(dest, src, src + num),
            // emscripten's geometric growth (+20 %, at most +96 MB over the request)
            emscripten_resize_heap: requested => {
                requested >>>= 0;
                const old = memory.buffer.byteLength;
                if (requested > MAX_HEAP) {
                    return 0;
                }
                for (let cutDown = 1; cutDown <= 4; cutDown *= 2) {
                    const overGrown = Math.min(old * (1 + 0.2 / cutDown), requested + 100663296);
                    const size = Math.min(MAX_HEAP, Math.ceil(Math.max(requested, overGrown) / 65536) * 65536);
                    try {
                        memory.grow((size - old + 65535) >>> 16);
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
            // libbzip2 prints only with verbosity > 0; the bytes are counted so a stray fprintf cannot loop
            fd_write: (_fd, iov, iovcnt, pnum) => {
                const view = new DataView(memory.buffer);
                let n = 0;
                for (let i = 0; i < iovcnt; i++) {
                    n += view.getUint32(iov + i * 8 + 4, true);
                }
                view.setUint32(pnum, n, true);
                return 0;
            }
        };
        const imports = {};
        for (const imp of WebAssembly.Module.imports(module)) {
            if (imp.kind !== 'function') {
                throw new Error(`bzip2.wasm imports a ${imp.kind} (${imp.module}.${imp.name})`);
            }
            (imports[imp.module] ??= {})[imp.name] =
                known[imp.name] ??
                (() => {
                    throw new Error(`bzip2.wasm called unexpected import ${imp.module}.${imp.name}`);
                });
        }
        let instance;
        try {
            instance = new WebAssembly.Instance(module, imports); // (WebKit)
        } catch {
            instance = await WebAssembly.instantiate(module, imports); // (Chrome)
        }
        const ex = instance.exports;
        memory = ex.memory;
        ex.emscripten_stack_init?.();
        ex.__wasm_call_ctors?.();

        // BZ2_bzBuffToBuffDecompress (small 0, verbosity 0), as the engine decodes. A jag stream does not say how long it
        // is decoded, so the output starts at 8 times the input and doubles while it is full (8 of the 163 streams).
        function decompress(stream) {
            const length = stream.length + HEADER.length;
            const src = ex.malloc(length);
            const lengthPtr = ex.malloc(4);
            try {
                if (!src || !lengthPtr) {
                    throw new Error('bzip2.wasm: out of memory');
                }
                heap().set(HEADER, src);
                heap().set(stream, src + HEADER.length);
                for (let size = Math.max(MIN_OUT, stream.length * 8); size <= MAX_OUT; size *= 2) {
                    const dest = ex.malloc(size);
                    try {
                        if (!dest) {
                            throw new Error('bzip2.wasm: out of memory');
                        }
                        new DataView(memory.buffer).setInt32(lengthPtr, size, true);
                        const ret = ex.BZ2_bzBuffToBuffDecompress(dest, lengthPtr, src, length, 0, 0);
                        if (ret === BZ_OK) {
                            const decoded = new DataView(memory.buffer).getInt32(lengthPtr, true);
                            return heap().slice(dest, dest + decoded);
                        }
                        if (ret !== BZ_OUTBUFF_FULL) {
                            throw new Error(`bzip2 error ${ret}`);
                        }
                    } finally {
                        ex.free(dest);
                    }
                }
                throw new Error(`bzip2: a stream of ${stream.length} bytes decodes to more than ${MAX_OUT}`);
            } finally {
                ex.free(src);
                ex.free(lengthPtr);
            }
        }

        return { decompress };
    }

    window.__lcBzip2 = { load };
})();
