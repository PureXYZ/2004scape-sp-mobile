// Test stand-in for the iOS host page (web/host/host.js), used by web/client/test/run.mjs.
// Implements the page -> client contract of docs/ARCHITECTURE.md §6 before client.js is imported:
//   1. window.WebSocket = a fake socket: bytes go to the engine Web Worker (mode=engine) or to a canned
//      login handshake that answers "invalid username or password" (mode=stub, no engine needed);
//   2. (stub-boot.js) globalThis.__LC_CACHE__ from cache/main_file_cache.*;
//   3. globalThis.lcHost with keyboard/haptic/takeSecondaryClick/settings/onClientEvent that only RECORD
//      what the client asks for, so the harness can assert on it (window.__lcTest).
// Spies: indexedDB.open and Worker construction are recorded (the patched client must use neither).
(() => {
    const params = new URLSearchParams(location.search);
    const mode = params.get('mode') ?? 'engine';
    const T0 = performance.now();
    const log = [];
    const rec = (type, extra = {}) => {
        const e = { t: Math.round(performance.now() - T0), type, ...extra };
        log.push(e);
        return e;
    };

    // ---- lcHost -------------------------------------------------------------------------------------
    const settings = { stayLoggedIn: false, longPressMs: 450, cameraSensitivity: 1 };
    let kbShown = false;
    let secondaryArmed = false;
    const clientState = () => {
        const c = window.__client;
        if (!c) {
            return null;
        }
        return {
            ingame: c.ingame, loginscreen: c.loginscreen, loginSelect: c.loginSelect, chatModalId: c.chatModalId,
            mainModalId: c.mainModalId, reportAbuseComId: c.reportAbuseComId, dialogInputOpen: c.dialogInputOpen,
            socialInputOpen: c.socialInputOpen, socialInputHeader: c.socialInputHeader
        };
    };
    // What a host derives from the client at show() time ("the host inspects __client to decide the context").
    const kindOf = s => {
        if (!s) {
            return null;
        }
        if (!s.ingame) {
            return s.loginscreen === 2 ? (s.loginSelect === 0 ? 'login-user' : 'login-pass') : null;
        }
        if (s.mainModalId !== -1 && s.mainModalId === s.reportAbuseComId) {
            return 'report';
        }
        return s.socialInputOpen ? 'social' : s.dialogInputOpen ? 'dialog' : 'chat';
    };
    // host=none: no lcHost at all (desktop testing path: MobileKeyboard falls back to a hidden DOM input)
    const lcHost = {
        keyboard: {
            show() {
                kbShown = true;
                const state = clientState();
                rec('kb-show', { kind: kindOf(state), state });
            },
            hide() {
                kbShown = false;
                rec('kb-hide', { state: clientState() });
            },
            isShown() {
                return kbShown;
            }
        },
        haptic(style) {
            rec('haptic', { style });
        },
        takeSecondaryClick() {
            const armed = secondaryArmed;
            secondaryArmed = false;
            if (armed) {
                rec('secondary-taken');
            }
            return armed;
        },
        settings,
        onClientEvent(name, detail) {
            rec('event', { name, detail });
        }
    };
    if (params.get('host') !== 'none') {
        window.lcHost = lcHost;
    }

    // ---- spies --------------------------------------------------------------------------------------
    let idbOpens = 0;
    if (window.indexedDB) {
        const open = indexedDB.open.bind(indexedDB);
        indexedDB.open = (...a) => {
            idbOpens++;
            rec('indexeddb-open', { name: a[0] });
            return open(...a);
        };
    }
    const workers = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
        constructor(url, opts) {
            super(url, opts);
            workers.push(String(url));
            rec('worker', { url: String(url) });
        }
    };

    // ---- fake WebSocket (ARCHITECTURE.md §6.1) ------------------------------------------------------
    let engine = null; // set by stub-boot.js: { worker, ready: Promise }
    const sockets = new Map();
    let nextId = 0;

    class EngineSocket extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        constructor(url, protocols) {
            super();
            this.url = url;
            this.protocol = 'binary';
            this.extensions = '';
            this.binaryType = 'blob';
            this.bufferedAmount = 0;
            this.readyState = 0;
            this.onopen = this.onmessage = this.onerror = this.onclose = null;
            this.id = ++nextId;
            this.sent = 0;
            this.received = 0;
            rec('ws-new', { id: this.id, url, protocols });
            if (mode === 'engine') {
                const go = () => {
                    if (this.readyState !== 0) {
                        return;
                    }
                    sockets.set(this.id, this);
                    engine.worker.postMessage({ type: 'connect', id: this.id });
                    this.readyState = 1;
                    this._fire('open', new Event('open'));
                };
                const fail = () => this._fail();
                (engine ? engine.ready : Promise.reject(new Error('no engine'))).then(go, fail);
            } else {
                this.inbuf = [];
                setTimeout(() => {
                    this.readyState = 1;
                    this._fire('open', new Event('open'));
                }, 0);
            }
        }

        _fire(type, ev) {
            this.dispatchEvent(ev);
            const h = this['on' + type];
            if (typeof h === 'function') {
                h.call(this, ev);
            }
        }

        _fail() {
            this.readyState = 3; // before the events: the client checks `e.readyState === 3`
            this._fire('error', new Event('error'));
            this._fire('close', new CloseEvent('close', { code: 1006 }));
        }

        send(data) {
            if (this.readyState !== 1) {
                throw new DOMException('not open', 'InvalidStateError');
            }
            const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
            this.sent += u8.length;
            if (mode === 'engine') {
                const copy = u8.slice(); // a fresh buffer we may transfer
                engine.worker.postMessage({ type: 'data', id: this.id, data: copy.buffer }, [copy.buffer]);
            } else {
                this._stubReply(u8);
            }
        }

        close() {
            if (this.readyState >= 2) {
                return;
            }
            this.readyState = 3;
            if (mode === 'engine') {
                engine.worker.postMessage({ type: 'close', id: this.id });
                sockets.delete(this.id);
            }
            rec('ws-close', { id: this.id, by: 'client' });
            queueMicrotask(() => this._fire('close', new CloseEvent('close', { code: 1000, wasClean: true })));
        }

        _data(buf) {
            if (this.readyState !== 1) {
                return;
            }
            this.received += buf.byteLength;
            this._fire('message', new MessageEvent('message', { data: buf }));
        }

        _remoteClose() {
            if (this.readyState === 3) {
                return;
            }
            this.readyState = 3;
            sockets.delete(this.id);
            rec('ws-close', { id: this.id, by: 'engine' });
            this._fire('close', new CloseEvent('close', { code: 1006 }));
        }

        // mode=stub: just enough of the engine's login handshake (World.ts) to answer "invalid login" (3)
        _stubReply(b) {
            const reply = bytes => setTimeout(() => this._data(Uint8Array.from(bytes).buffer), 0);
            if (b[0] === 14) {
                reply([0, 0, 0, 0, 0, 0, 0, 0]);
                reply([0]);
                reply([0x00, 0x12, 0x34, 0x56, 0x89, 0xab, 0xcd, 0xef]);
            } else if (b[0] === 16 || b[0] === 18) {
                rec('stub-login', { bytes: b.length });
                reply([3]);
            }
        }
    }
    window.WebSocket = EngineSocket;

    // ---- engine messages (old engine-compat protocol; the new one is a superset) -------------------
    function attachEngine(worker, ready) {
        engine = { worker, ready };
        worker.addEventListener('message', ({ data: m }) => {
            if (!m || typeof m !== 'object') {
                return;
            }
            if (m.type === 'data') {
                const s = sockets.get(m.id);
                if (s) {
                    const d = m.data instanceof ArrayBuffer ? m.data : m.data.buffer.slice(m.data.byteOffset, m.data.byteOffset + m.data.byteLength);
                    s._data(d);
                }
            } else if (m.type === 'close') {
                sockets.get(m.id)?._remoteClose();
            } else if (m.type === 'exit') {
                rec('engine-exit', { code: m.code });
            } else if (m.type === 'log') {
                rec('engine-log', { level: m.level, text: String(m.text).slice(0, 300) });
            }
        });
    }

    // ---- helpers for the harness (what the native keyboard bridge does via LostCityHost.keyboard) -----
    const key = (k, extra = {}) => {
        const canvas = document.getElementById('canvas');
        for (const type of ['keydown', 'keyup']) {
            canvas.dispatchEvent(new KeyboardEvent(type, { key: k, code: k, ...extra })); // GameShell needs `code`
        }
    };
    window.__lcTest = {
        mode,
        log,
        rec,
        settings,
        workers,
        attachEngine,
        idbOpens: () => idbOpens,
        keyboardShown: () => kbShown,
        armSecondary() {
            secondaryArmed = true;
        },
        dismissKeyboard() {
            kbShown = false;
            rec('kb-dismissed');
        },
        insertText(text) {
            for (const ch of text) {
                key(ch === '\n' ? 'Enter' : ch);
            }
        },
        key
    };
})();
