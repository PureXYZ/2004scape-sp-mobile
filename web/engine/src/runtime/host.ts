// Engine -> page messages (ARCHITECTURE.md §4). boot.js hands the entry a `post` bound to the worker scope.
export type EngineMessage =
    | { type: 'progress'; stage: string; detail?: string; fraction?: number }
    | { type: 'ready'; ms: number }
    | { type: 'data'; id: number; data: ArrayBuffer }
    | { type: 'close'; id: number }
    | { type: 'lifecycle-done'; reqId: unknown; ok: boolean; error?: string }
    | { type: 'delete-done'; reqId: unknown; ok: boolean; error?: string }
    | { type: 'exit'; code: number };

export type Post = (msg: EngineMessage, transfer?: Transferable[]) => void;

let post: Post = () => {};

export function setPost(fn: Post) {
    post = fn;
}

export function send(msg: EngineMessage, transfer?: Transferable[]) {
    try {
        post(msg, transfer);
    } catch (e) {
        console.error('[engine] postMessage failed', e);
    }
}

export function progress(stage: string, detail?: string, fraction?: number) {
    send(fraction === undefined ? { type: 'progress', stage, detail } : { type: 'progress', stage, detail, fraction });
}
