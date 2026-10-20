// `worker_threads` replacement: the engine's helper "threads" run IN-PROCESS, inside the engine worker.
//
// The engine spawns them with `new Worker(new URL('<file>.ts', import.meta.url))`:
//   World.ts:112    ../server/login/LoginThread.ts   -> runtime/threads.ts (player saves via native storage)
//   World.ts:113    ../server/friend/FriendThread.ts -> sink (friend server disabled: upstream thread is a no-op too)
//   World.ts:114    ../server/logger/LoggerThread.ts -> sink (logger disabled: upstream thread is a no-op too)
//   World.ts:1762   ../cache/DevThread.ts            -> sink + warning (only if !production && build.liveReload)
//   OnDemand.ts:119 ./OnDemandThread.ts              -> sink: the client reads the cache itself (ARCHITECTURE.md §6)
// Implementations register by URL pattern (registerThread) before World.ts is evaluated - its Workers are field
// initialisers. Messages are passed by reference and delivered on a microtask, preserving the "reply arrives
// later" contract the engine relies on.

type Listener = (...args: any[]) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

class Emitter {
    private listeners = new Map<string, Listener[]>();
    on(ev: string, fn: Listener) {
        let l = this.listeners.get(ev);
        if (!l) this.listeners.set(ev, (l = []));
        l.push(fn);
        return this;
    }
    addListener(ev: string, fn: Listener) {
        return this.on(ev, fn);
    }
    once(ev: string, fn: Listener) {
        const w: Listener = (...a) => {
            this.off(ev, w);
            fn(...a);
        };
        return this.on(ev, w);
    }
    off(ev: string, fn: Listener) {
        const l = this.listeners.get(ev);
        if (l) this.listeners.set(ev, l.filter(x => x !== fn));
        return this;
    }
    removeListener(ev: string, fn: Listener) {
        return this.off(ev, fn);
    }
    removeAllListeners(ev?: string) {
        if (ev) this.listeners.delete(ev);
        else this.listeners.clear();
        return this;
    }
    emit(ev: string, ...args: unknown[]) {
        const l = this.listeners.get(ev);
        if (!l || l.length === 0) return false;
        for (const fn of [...l]) fn(...args);
        return true;
    }
    listenerCount(ev: string) {
        return this.listeners.get(ev)?.length ?? 0;
    }
}

function deliver(target: Emitter, msg: unknown) {
    queueMicrotask(() => {
        try {
            target.emit('message', msg);
        } catch (e) {
            console.error('[worker_threads shim] message handler failed', e);
        }
    });
}

/** Thread-side end of an in-process worker (what `parentPort` is inside a real worker thread). */
export class ThreadPort extends Emitter {
    constructor(private readonly worker: Worker) {
        super();
    }
    postMessage(msg: unknown, _transfer?: unknown) {
        deliver(this.worker, msg);
    }
    close() {}
    ref() {}
    unref() {}
    start() {}
}

export type ThreadFactory = (port: ThreadPort, worker: Worker) => void;
const registry: { match: RegExp; factory: ThreadFactory }[] = [];

/** Register the in-process implementation for worker scripts whose URL matches `match`. */
export function registerThread(match: RegExp, factory: ThreadFactory) {
    registry.unshift({ match, factory });
}

let nextThreadId = 1;

export class Worker extends Emitter {
    readonly threadId = nextThreadId++;
    readonly url: string;
    readonly port: ThreadPort;
    private exited = false;

    constructor(filename: string | URL, _options?: unknown) {
        super();
        this.url = typeof filename === 'string' ? filename : filename.href;
        this.port = new ThreadPort(this);
        const entry = registry.find(r => r.match.test(this.url));
        if (entry) {
            // synchronously, so the thread's listeners exist before the first postMessage
            entry.factory(this.port, this);
        } else {
            console.warn(`[worker_threads shim] no in-process implementation for ${this.url}; its messages are dropped`);
        }
        queueMicrotask(() => this.emit('online'));
    }

    postMessage(msg: unknown, _transfer?: unknown) {
        if (!this.exited) deliver(this.port, msg);
    }

    terminate() {
        if (!this.exited) {
            this.exited = true;
            queueMicrotask(() => this.emit('exit', 1));
        }
        return Promise.resolve(1);
    }

    ref() {}
    unref() {}
}

export const isMainThread = true;
export const parentPort = null;
export const workerData = null;
export const threadId = 0;
export const resourceLimits = {};
export const SHARE_ENV = Symbol('SHARE_ENV');
export function markAsUntransferable() {}
export function receiveMessageOnPort() {
    return undefined;
}

export default { Worker, isMainThread, parentPort, workerData, threadId, registerThread };
