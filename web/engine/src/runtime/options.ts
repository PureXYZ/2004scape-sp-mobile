// Switches for measurements and tests, read once from globalThis.__LC_ENGINE_TEST__ (set by a test harness before
// boot.js runs; never set in the app). Not part of the page protocol.
export interface TestOptions {
    /** Packet.gjstr flat-string patch (default on). */
    flatStrings?: boolean;
    /** Drop re-fetchable vfs files + the WASM bzip2 instance after start (default on). */
    release?: boolean;
    /** Use the WASM bzip2 decoder at start-up when WebAssembly exists (default on). */
    wasmBzip2?: boolean;
}

export const testOptions: TestOptions = { ...((globalThis as unknown as { __LC_ENGINE_TEST__?: TestOptions }).__LC_ENGINE_TEST__ ?? {}) };
