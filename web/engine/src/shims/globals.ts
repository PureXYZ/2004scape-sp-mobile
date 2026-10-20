// Injected into the bundle (esbuild `inject`) as the targets of the `define` replacements in build.mjs:
//   process.exit(code)     -> __lc_exit         World.ts:525 (tick crash), World.ts:1230 (shutdown complete),
//                                               Logger.ts:45 (printFatalError: missing cache, bad script compiler, bad npc)
//   process.memoryUsage()  -> __lc_memoryUsage  World.ts:496 (only with node.debugProfile)

/** Thrown by the process.exit shim to unwind the engine's stack; callers of engine code swallow it. */
export class EngineExit extends Error {
    constructor(public readonly code: number) {
        super(`engine requested process.exit(${code})`);
        this.name = 'EngineExit';
    }
}

type ExitHandler = (code: number) => void;
let exitHandler: ExitHandler | null = null;
let exitCode: number | null = null;

/** The entry installs the handler that saves players and tells the page (runtime/lifecycle.ts). */
export function setExitHandler(fn: ExitHandler) {
    exitHandler = fn;
}

export function hasExited(): boolean {
    return exitCode !== null;
}

// process.exit() semantics, as far as a worker allows: run the exit handler exactly once (first code wins -
// World.cycle's catch block calls process.exit(1) from inside its own error handling), then unwind by throwing.
export function __lc_exit(code: number = 0): never {
    if (exitCode === null) {
        exitCode = code;
        try {
            exitHandler?.(code);
        } catch (e) {
            console.error('[engine] exit handler failed', e);
        }
    }
    throw new EngineExit(exitCode);
}

export function __lc_memoryUsage() {
    const pm = (globalThis as unknown as { performance?: { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } } }).performance?.memory;
    return { rss: 0, heapTotal: pm?.totalJSHeapSize ?? 0, heapUsed: pm?.usedJSHeapSize ?? 0, external: 0, arrayBuffers: 0 };
}
