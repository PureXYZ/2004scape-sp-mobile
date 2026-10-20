// Synchronous XHR from the worker to the app's scheme handler (lostcity://game/...). Verified in WKWebView:
// sync XHR works in workers, including responseType 'arraybuffer', and PUT bodies arrive as httpBody as long as
// they are an ArrayBuffer/view - WebKit drops Blob bodies (ios-platform report §3.3). Used for player saves and
// for re-fetching evicted vfs files; both must be synchronous because the engine code calling them is.
//
// Android (docs/ANDROID.md §3.2): the app answers requests from WebView's shouldInterceptRequest, which never sees a
// request body. There a write sends no body: its bytes travel base64url (no padding) in the X-LC-Body request header,
// with their count in X-LC-Length, on the same synchronous PUT to the same route, and the app answers as on iOS.
// Measured on the emulator: 3-4 ms for a player save, 18-33 ms for bots.sav at 1,000 bots. iOS
// and desktop browsers keep the real body.

export type XhrResult = { status: number; data: Uint8Array | null; error?: string };

type XhrCtor = new () => {
    open(method: string, url: string, async: boolean): void;
    send(body?: unknown): void;
    setRequestHeader(name: string, value: string): void;
    responseType: string;
    status: number;
    response: unknown;
};

function ctor(): XhrCtor | null {
    return ((globalThis as unknown as { XMLHttpRequest?: XhrCtor }).XMLHttpRequest ?? null) as XhrCtor | null;
}

export function xhrAvailable(): boolean {
    return ctor() !== null;
}

export function xhrSync(method: 'GET' | 'PUT' | 'DELETE', url: string, body?: ArrayBuffer): XhrResult {
    const X = ctor();
    if (!X) return { status: 0, data: null, error: 'XMLHttpRequest is not available' };
    try {
        const x = new X();
        x.open(method, url, false);
        if (method === 'GET') x.responseType = 'arraybuffer';
        if (body && (globalThis as { __LC_PLATFORM__?: unknown }).__LC_PLATFORM__ === 'android') {
            const bytes = new Uint8Array(body);
            x.setRequestHeader('X-LC-Body', base64url(bytes));
            x.setRequestHeader('X-LC-Length', String(bytes.length));
            x.send(null);
        } else {
            if (body) x.setRequestHeader('Content-Type', 'application/octet-stream');
            x.send(body ?? null);
        }
        const r = x.response as ArrayBuffer | null;
        const ok = x.status >= 200 && x.status < 300;
        return { status: x.status, data: method === 'GET' && ok && r && typeof r.byteLength === 'number' ? new Uint8Array(r) : null };
    } catch (e) {
        // network error / scheme handler failure: sync XHR throws (DOMException NetworkError)
        return { status: 0, data: null, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    }
}

type ToBase64 = (this: Uint8Array, options: { alphabet: 'base64url'; omitPadding: boolean }) => string;

/**
 * The bytes as base64url without padding (RFC 4648 §5), for the X-LC-Body header. WebView 140+ has the native
 * Uint8Array.prototype.toBase64 (0.6 ms for 1.15 MB on the emulator); older ones take the btoa path, in chunks so that
 * String.fromCharCode never gets more arguments than the engine's stack allows.
 */
export function base64url(bytes: Uint8Array): string {
    const native = (Uint8Array.prototype as unknown as { toBase64?: ToBase64 }).toBase64;
    if (typeof native === 'function') {
        return native.call(bytes, { alphabet: 'base64url', omitPadding: true });
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
