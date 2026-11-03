// LostCity iOS host page.
//
// Boots the game engine (a module Web Worker running the Engine-TS world) and the web client (Client-TS 274),
// connects them through an in-process WebSocket replacement, and bridges the client to the native app:
// lifecycle (save + pause), the native keyboard, haptics, settings, and the screen layout: the mobile HUD in game
// (hud.js) or the classic 765x503 canvas with side rails (the title screen, and the "classic" layout setting).
// Contracts: docs/ARCHITECTURE.md §4 (engine protocol), §6 (client), §7 (native).
//
// This is a classic script loaded from <head> on purpose: window.WebSocket must be replaced before client.js is
// evaluated, because the client classifies I/O errors with `e instanceof WebSocket`.
(() => {
    'use strict';

    const NODE_ID = 10; // the engine's node.id (world.json); the client compares world ids against it

    // The native app's message handlers: WKWebView's on iOS, or on Android the same shape defined by the app's
    // document-start script over its WebMessageListener object (docs/ANDROID.md §3.1). Nothing fakes window.webkit on
    // Android, so iOS keeps exactly what it had; without an app (desktop tests) there is neither.
    const nativeHandlers = window.webkit?.messageHandlers ?? window.LostCityNativeBridge ?? null;
    const nativeHandler = nativeHandlers?.native ?? null;
    const isNative = nativeHandler !== null;

    function postNative(msg) {
        if (!nativeHandler) {
            return;
        }
        try {
            nativeHandler.postMessage(msg);
        } catch (err) {
            console.warn('[host] native message failed', err);
        }
    }

    // Which app the page runs in, from the app's document-start object (docs/ANDROID.md §3.1): 'android', or 'ios' for
    // everything else, so that without an app (desktop tests: 'web') the page keeps the iPhone app's wording and its
    // behaviour exactly as it was before Android.
    const ANDROID = window.LostCityNative?.platform === 'android';

    // The words that name the phone, its Files app, its secure storage and its simulator (docs/ANDROID.md §3.3).
    // Android's saves are in Files > 2004Scape (the app's DocumentsProvider), its Claude key in a file wrapped by the
    // AndroidKeyStore (native code: the page never sees the key).
    const STRINGS = {
        ios: {
            charactersWhere: 'Saved on this iPhone: Files > On My iPhone > 2004Scape > players',
            savedataWhere: 'A deleted save stays in Files > On My iPhone > 2004Scape as a .bak file until it is saved over.',
            whereShort: 'in Files',
            storageFull: 'Is the iPhone storage full?',
            onlyInApp: 'Only in the iPhone app',
            keyRemove: 'It is deleted from this iPhone\'s Keychain. Claude online then answers with the on-device model, or with the rules.',
            passwordsWhere: 'Only the names are kept on this iPhone. A password is kept only when you tick Remember, in the Keychain.',
            localNetwork: 'this iPhone did not reach your local network. Is it on the Wi-Fi, and is 2004Scape allowed in Settings > Privacy & Security > Local Network?',
            tooOld: () => 'This iPhone\'s iOS is too old for the game (iOS 18.4 or later is needed). Update it in Settings > General > Software Update, then open the game again.'
        },
        android: {
            charactersWhere: 'Saved on this phone: Files > 2004Scape > players',
            savedataWhere: 'A deleted save stays in Files > 2004Scape as a .bak file until it is saved over.',
            whereShort: 'in Files',
            storageFull: 'Is the phone\'s storage full?',
            onlyInApp: 'Only in the app',
            keyRemove: 'It is deleted from this phone. Claude online then answers with the on-device model, or with the rules.',
            passwordsWhere: 'Only the names are kept on this phone. A password is kept only when you tick Remember, encrypted on this phone.',
            localNetwork: 'this phone did not reach your local network. Is it on the Wi-Fi, and may 2004Scape connect to devices on it (Settings > Apps > 2004Scape > Permissions)?',
            tooOld: version => `This phone's Android System WebView is too old for the game (Chrome ${version ?? 'unknown'}; ${MIN_WEBVIEW} or later is needed). Update "Android System WebView" in Google Play, then open the game again.`
        }
    };
    const T = ANDROID ? STRINGS.android : STRINGS.ios;
    // The oldest Android System WebView that runs the game: Chrome 122 brought the iterator helpers the engine's scripts
    // use (docs/INSTALL-ANDROID.md, Troubleshooting); native refuses an older one before it loads the page, the page checks again (boot).
    const MIN_WEBVIEW = 122;
    // Why the model in the app does not run here (native's status local.reason, docs/ARCHITECTURE.md §7.1): llama.cpp has
    // no iOS simulator slice; the Android build may say the same of its emulator.
    const LM_REASONS = { simulator: 'Not on the simulator', emulator: 'Not on the emulator' };

    // ------------------------------------------------------------------------------------------------ settings

    // Settings › Bot chat › Think first, before the player chooses: whether the on-device model writes its short note
    // before each reply (docs/ARCHITECTURE.md §7.1). The one place its default is set: On.
    // A blind test found little difference either way, and the note costs time and heat (with the note, a reply every
    // 5 s made the phone thermally serious after 15 minutes; without it, fair: web/engine/bots/test/model-data/README.md).
    const BOT_THINK_DEFAULT = true;

    const DEFAULT_SETTINGS = Object.freeze({
        layout: 'mobile', // 'mobile': the full-screen HUD in game (hud.js); 'classic': the 2004 screen with side rails
        fps: 50,
        smoothScaling: false, // Pixel: the world drawn with crisp 2004 pixels
        cameraButtons: false, // mobile layout: rotate / tilt buttons (dragging the world turns the camera too)
        xpDrops: true, // mobile layout: the total XP under the orbs and each gain rising into it (hud.js updateXp)
        xpDropSpeed: 40, // how fast a drop rises, HUD px a second: Slow 25, Normal 40, Fast 60 (hud.js xpDrop)
        xpDropStyle: 'separate', // gains of one tick: 'separate' (a row per skill) or 'combined' (their icons, one sum)
        showControls: true, // classic layout: the side rails
        largeMenus: true, // the options menu for fingers (menu.js) instead of the drawn 2004 one
        // Settings › Display › Screen margins: Side, Top and Bottom (CSS px, readSafeArea): -1 None (the HUD up to
        // the glass edge, over a notch or camera hole), 0 Auto (the phone's safe area), 16 or 32 more than Auto
        safeSides: 0,
        safeTop: 0,
        safeBottom: 0,
        longPressMs: 400,
        cameraSensitivity: 0.6, // Settings › Controls › Camera drag: Slow 0.35, Normal 0.6, Fast 1 (times patch 0004's turn per px)
        // Settings › Tap options (Client.setAttackOptions, patch 0025): what a tap does with an NPC's and a player's Attack:
        // 'tap' (always attacks), 'level' (2004: only when their level is not above yours), 'hold' (only in the long-press
        // menu), 'hidden' (no Attack option)
        npcAttack: 'level',
        playerAttack: 'level',
        cameraZoom: 1, // pinch zoom, kept between sessions
        minimapZoom: 1, // the minimap's zoom (the HUD's slider), kept between sessions
        haptics: true, // vibration feedback
        seenHowToPlay: false, // the touch controls card was shown once
        stayLoggedIn: true, // fixed: the offline world never logs an idle player out (engine node.debug), and a locked
        // phone pauses the world anyway
        soundMode: 'playback', // 'playback' ignores the silent switch, 'ambient' respects it
        members: true, // the rest apply after a restart
        xpRate: 10,
        lowMemory: false,
        bots: 500, // other players the world runs (2004sp-progressive's AI, docs/BOTS.md): 0 = off, else about how many are
        //          online at a time (a pool of about twice as many takes turns, docs/BOTS.md §4.4)
        jmod: false, // true: the character logs in as staff (level 4: the :: commands, a crown in chat); false = a normal player
        // who writes the bots' replies to you (Settings › Bot chat, docs/ARCHITECTURE.md §7.1): 'rules' (theirs alone),
        // 'local' (the chat model in the app: the default when the app has one), 'online' (Claude, the player's own key)
        botChat: window.LostCityNative?.lm?.local?.available === true ? 'local' : 'rules',
        // Settings › Bot chat › Think first: the model in the app plans each reply in a short note first (offered only for
        // a model trained both ways: native's status local.think 'option'); applied at once, with every request
        botThink: BOT_THINK_DEFAULT,
        // (bots ideas, round 4: I model) Settings › Bot chat › Bots' own talk: 'rules' (the default until the phone heat
        // test passes and the player's word), or 'model': the model in the app words the bots' talk between themselves
        // near you (the engine's port/BotModelAmbient), never Claude and never with Think first; used only with the
        // on-device model in the app and a chat model chosen (lm.ambientUsable), applied at once (lm.sendMode)
        botAmbient: 'rules',
        // Online (docs/ONLINE.md): where the world is, 'offline' (this phone) or the id of one of `servers`, the game
        // servers the player added ({id, name, url, nodeId, members, rsa, added}: checkServerSettings); `accounts` the
        // names played on each (usernames only: a password the player asked to keep stays in the Keychain or the
        // Keystore), `rememberDefault` the Remember box's last state on each. A change of server reloads the page.
        server: 'offline',
        servers: [],
        accounts: {},
        rememberDefault: {}
    });

    function loadSettings() {
        let stored = window.LostCityNative?.settings ?? null;
        if (!stored) {
            try {
                stored = JSON.parse(localStorage.getItem('lostcity.settings') ?? 'null');
            } catch {
                stored = null;
            }
        }
        const merged = { ...DEFAULT_SETTINGS };
        if (stored && typeof stored === 'object') {
            for (const key of Object.keys(DEFAULT_SETTINGS)) {
                if (typeof stored[key] === typeof DEFAULT_SETTINGS[key]) {
                    merged[key] = stored[key];
                }
            }
        }
        merged.stayLoggedIn = true;
        checkServerSettings(merged, stored);
        return merged; // (checked against the Settings sheet at boot: checkStoredSettings)
    }

    // The servers, their accounts and the server chosen, checked when the page loads (before it chooses its WebSocket),
    // like the other stored settings: an entry without a usable id or an address that is not one (web/host/serverurl.js)
    // is dropped, its address stored normalized, a missing or malformed field set to its default (world 10, members,
    // the built-in key); accounts and Remember states only for servers there are; 'offline' when the server chosen is
    // not one of them. A correction is saved once, at boot (checkStoredSettings).
    const MAX_SERVERS = 50;
    const MAX_ACCOUNTS = 20;
    let serverSettingsCorrected = false;

    function checkServerSettings(merged, stored) {
        const servers = [];
        for (const entry of Array.isArray(merged.servers) ? merged.servers : []) {
            const server = serverEntry(entry);
            if (server && servers.length < MAX_SERVERS && !servers.some(s => s.id === server.id)) {
                servers.push(server);
            }
        }
        const accounts = {};
        const rememberDefault = {};
        for (const { id } of servers) {
            const names = new Set();
            const list = (Array.isArray(merged.accounts?.[id]) ? merged.accounts[id] : [])
                .map(account => ({ name: typeof account?.name === 'string' ? account.name.trim() : '', lastPlayed: Number(account?.lastPlayed) > 0 ? Number(account.lastPlayed) : 0 }))
                .filter(account => /^[A-Za-z0-9 _-]{1,12}$/.test(account.name) && !names.has(account.name.toLowerCase()) && names.add(account.name.toLowerCase()))
                .slice(0, MAX_ACCOUNTS);
            if (list.length) {
                accounts[id] = list;
            }
            if (typeof merged.rememberDefault?.[id] === 'boolean') {
                rememberDefault[id] = merged.rememberDefault[id];
            }
        }
        const server = servers.some(s => s.id === merged.server) ? merged.server : 'offline';
        const checked = { server, servers, accounts, rememberDefault };
        for (const [key, value] of Object.entries(checked)) {
            if (stored && typeof stored === 'object' && key in stored && sortedJson(stored[key]) !== sortedJson(value)) {
                serverSettingsCorrected = true;
            }
            merged[key] = value;
        }
    }

    // JSON with every object's keys sorted: native stores and gives back the settings with sorted keys (iOS
    // JSONSerialization .sortedKeys, Android JsonText.sorted), so the order is not a change.
    function sortedJson(value) {
        return JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
    }

    // A stored server entry as the page uses it, or null when it cannot be one.
    function serverEntry(entry) {
        const url = entry && typeof entry === 'object' ? window.lcServerUrl?.normalize(entry.url) ?? null : null;
        if (!url || typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(entry.id)) {
            return null;
        }
        const rsa = entry.rsa;
        return {
            id: entry.id,
            name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 40) : window.lcServerUrl.hostOf(url),
            url,
            nodeId: Number.isInteger(entry.nodeId) && entry.nodeId >= 1 && entry.nodeId <= 65535 ? entry.nodeId : 10,
            members: typeof entry.members === 'boolean' ? entry.members : true,
            rsa: rsa && typeof rsa === 'object' && /^\d{40,2000}$/.test(rsa.n) && /^\d{1,2000}$/.test(rsa.e) ? { n: rsa.n, e: rsa.e } : null,
            added: Number(entry.added) > 0 ? Number(entry.added) : 0
        };
    }

    const settings = loadSettings();
    // The game server this page plays on, or null: the world on this phone (docs/ONLINE.md). Fixed for the page's life: a
    // change of server reloads the page (servers.use). Native routes /crc, the archives and the sockets by the same rule.
    const SERVER = settings.servers.find(server => server.id === settings.server) ?? null;
    const ONLINE = SERVER !== null;
    // World settings are fixed for the lifetime of the page; edits to them apply on restart. Taken at boot, once the
    // stored settings have been checked.
    let bootSettings = null;

    // Stored settings can hold a value the Settings sheet no longer offers (an earlier version held for the menu 450 or
    // 650 ms; the sheet now offers 300, 400 and 600; Bots 10 went when 250 and 500 came). A number snaps to the nearest
    // value the sheet offers, but one that was on never snaps to 0 (Bots Off: 10 bots become 25, not none); anything
    // else goes back to the default, and the corrected settings are saved once. (At boot: host.js runs before the
    // sheet is in the page.)
    function checkStoredSettings() {
        let corrected = false;
        for (const group of document.querySelectorAll('.seg[data-setting]')) {
            const key = group.dataset.setting;
            const value = settings[key];
            const snapped = snapSetting(key, value);
            if (snapped !== value) {
                settings[key] = snapped;
                corrected = true;
            }
        }
        if (corrected || serverSettingsCorrected) {
            persistSettings();
        }
    }

    /** What a stored value of a sheet setting loads as (itself when the sheet offers it). */
    function snapSetting(key, value) {
        const group = document.querySelector(`.seg[data-setting="${key}"]`);
        const offered = group ? [...group.querySelectorAll('button')].map(button => parseSettingValue(button.dataset.value)) : [];
        if (!(key in DEFAULT_SETTINGS) || !group || offered.includes(value)) {
            return value;
        }
        const finite = offered.filter(Number.isFinite);
        const numbers = value !== 0 && finite.some(n => n !== 0) ? finite.filter(n => n !== 0) : finite;
        return Number.isFinite(value) && numbers.length > 0 ? numbers.reduce((best, n) => (Math.abs(n - value) < Math.abs(best - value) ? n : best)) : DEFAULT_SETTINGS[key];
    }

    function persistSettings() {
        if (isNative) {
            postNative({ type: 'settings', values: { ...settings } });
        } else {
            try {
                localStorage.setItem('lostcity.settings', JSON.stringify(settings));
            } catch {
                // storage unavailable (private browsing); settings last for this session only
            }
        }
    }

    // ------------------------------------------------------------------------------------------------ engine worker

    let engine = null;
    // 'booting' | 'ready' | 'dead' | 'stopped' (Saved data's restarts: stopEngine); online 'remote': the world is the game
    // server's, and no engine runs on the page
    let engineState = ONLINE ? 'remote' : 'booting';
    let botsOff = false; // the bots asked for are off this session (the engine said so)
    let resolveEngineReady;
    let rejectEngineReady;
    const engineReady = new Promise((resolve, reject) => {
        resolveEngineReady = resolve;
        rejectEngineReady = reject;
    });
    engineReady.catch(() => {}); // failures are reported through showError

    const sockets = new Map();
    let nextSocketId = 1;
    const pendingRequests = new Map();
    let nextRequestId = 1;

    function startEngine() {
        engine = new Worker('engine/boot.js', { type: 'module' });
        engine.onmessage = event => onEngineMessage(event.data);
        engine.onerror = event => {
            console.error('[engine] worker error:', event.message, `${event.filename}:${event.lineno}`);
            engineFailed(`The game engine failed to start.\n${event.message ?? ''}`);
        };
        engine.postMessage({
            type: 'init',
            // which app the engine runs in: on Android its saves carry their bytes in a request header, because the app
            // cannot read request bodies (boot.js sets __LC_PLATFORM__ from it; docs/ANDROID.md §3.2). 'web' = no app.
            platform: window.LostCityNative?.platform ?? 'web',
            // (with a count above 0 boot.js loads the engine that has the bots: docs/BOTS.md §4.1)
            // (staffModLevel: what every login gets, runtime/threads.ts)
            config: { node: { id: NODE_ID, ...(PROFILE === 'main' ? {} : { profile: PROFILE }), members: bootSettings.members, xpRate: bootSettings.xpRate }, bots: { count: bootSettings.bots }, staffModLevel: bootSettings.jmod ? 4 : 0 }
        });
    }

    function onEngineMessage(msg) {
        switch (msg?.type) {
            case 'progress':
                // the world's share of the loading bar: its data preload, then evaluating the engine
                loaderProgress.engine = Math.max(loaderProgress.engine, msg.stage === 'preload' ? 0.6 * (Number(msg.fraction) || 0) : 0.7);
                showLoaderProgress();
                break;
            case 'booted': {
                // (an engine that has the bots bundle also says which bundle it loaded and how many bots it runs)
                const bundle = typeof msg.bundle === 'string' ? `, ${msg.bundle}${Number(msg.bots) > 0 ? ` with ${msg.bots} bots` : ''}` : '';
                console.log(`[host] engine booted: ${msg.files} files, ${(msg.bytes / 1048576).toFixed(1)} MB in ${Math.round(msg.preloadMs)} ms, eval ${Math.round(msg.evalMs)} ms${bundle}`);
                // (only the bots' engine knows the chat model's messages: it hears the player's choice before the world starts)
                lm.engineBots = msg.bundle === 'engine-bots.js' && Number(msg.bots) > 0;
                lm.sendMode();
                engine.postMessage({ type: 'start' });
                break;
            }
            case 'bots-lm':
                lm.request(msg);
                break;
            case 'ready':
                engineState = 'ready';
                console.log(`[host] world ready in ${Math.round(msg.ms)} ms`);
                loaderProgress.engine = 1;
                showLoaderProgress();
                setStatusPill(null); // ("The world is still starting…", if the loader gave way first)
                resolveEngineReady();
                postNative({ type: 'status', phase: 'engine-ready' });
                break;
            case 'data':
                sockets.get(msg.id)?._receive(msg.data);
                break;
            case 'close':
                sockets.get(msg.id)?._remoteClose(false);
                break;
            case 'lifecycle-done':
            case 'delete-done': {
                const pending = pendingRequests.get(msg.reqId);
                if (pending) {
                    pendingRequests.delete(msg.reqId);
                    pending.resolve(msg);
                }
                break;
            }
            case 'bots':
                // the bots asked for (Settings › World › Bots) are off this session: the engine could not load them or
                // switched them off (docs/BOTS.md §4.1). Said once, in plain words, once the title or the world shows.
                if (msg.active === false && bootSettings.bots > 0) {
                    botsOff = true;
                    console.warn(`[host] the bots are off this session (${msg.reason}): ${msg.detail ?? ''}`);
                    if (!botsNoticeShown) {
                        botsNotice ??= BOTS_OFF[msg.reason] ?? BOTS_OFF.failed;
                    }
                }
                break;
            case 'log':
                (console[msg.level] ?? console.log).call(console, '[engine]', msg.text);
                break;
            case 'exit':
                engineFailed(`The game engine stopped (code ${msg.code}).\nYour progress up to the last save is safe.`);
                break;
            default:
                break;
        }
    }

    function engineFailed(message) {
        if (engineState === 'dead' || engineState === 'stopped') {
            return;
        }
        engineState = 'dead';
        rejectEngineReady(new Error(message));
        for (const socket of [...sockets.values()]) {
            socket._remoteClose(true);
        }
        for (const pending of pendingRequests.values()) {
            pending.resolve({ ok: false, error: message });
        }
        pendingRequests.clear();
        setStatusPill(null);
        showError(message);
        postNative({ type: 'status', phase: 'error', detail: message });
    }

    // Lifecycle requests resolve with the engine's reply, or { ok: false } on timeout/failure; never reject.
    function engineRequest(event, timeoutMs) {
        return engineCall({ type: 'lifecycle', event }, timeoutMs);
    }

    // A request the engine answers with its reqId (lifecycle-done, delete-done): the reply, or { ok: false } on
    // timeout/failure; never rejects. With no world running, { ok: true, skipped }.
    function engineCall(message, timeoutMs) {
        if (!engine || engineState !== 'ready') {
            return Promise.resolve({ ok: true, skipped: engineState });
        }
        const reqId = nextRequestId++;
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                pendingRequests.delete(reqId);
                resolve({ ok: false, error: 'timeout' });
            }, timeoutMs);
            pendingRequests.set(reqId, {
                resolve: reply => {
                    clearTimeout(timer);
                    resolve(reply);
                }
            });
            engine.postMessage({ ...message, reqId });
        });
    }

    // Settings › Saved data, before a reload that deletes saves: the world was paused and saved; from now on nothing
    // may write a save again (no autosave, no bot leaving, no retry). Lifecycle requests are skipped from here on.
    function stopEngine() {
        engineState = 'stopped';
        for (const pending of pendingRequests.values()) {
            pending.resolve({ ok: false, error: 'the engine was stopped' });
        }
        pendingRequests.clear();
        engine?.terminate();
    }

    // ------------------------------------------------------------------------------------------------ WebSocket

    // In-process replacement for the browser WebSocket: the client's connection goes to the engine worker. Mirrors
    // the parts of the WebSocket API that ClientStream uses, including the global identity (instanceof) and
    // readyState === CLOSED before error/close events fire.
    class EngineSocket extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        constructor(url, protocols) {
            super();
            this.url = String(url);
            this.protocol = Array.isArray(protocols) ? (protocols[0] ?? '') : (protocols ?? '');
            this.extensions = '';
            this.binaryType = 'blob';
            this.bufferedAmount = 0;
            this.readyState = EngineSocket.CONNECTING;
            this.onopen = null;
            this.onmessage = null;
            this.onerror = null;
            this.onclose = null;
            this.id = nextSocketId++;
            sockets.set(this.id, this);

            engineReady.then(
                () => {
                    if (this.readyState !== EngineSocket.CONNECTING) {
                        return;
                    }
                    engine.postMessage({ type: 'connect', id: this.id });
                    this.readyState = EngineSocket.OPEN;
                    this._fire('open', new Event('open'));
                },
                () => this._remoteClose(true)
            );
        }

        get CONNECTING() {
            return 0;
        }
        get OPEN() {
            return 1;
        }
        get CLOSING() {
            return 2;
        }
        get CLOSED() {
            return 3;
        }

        send(data) {
            if (this.readyState === EngineSocket.CONNECTING) {
                throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
            }
            if (this.readyState !== EngineSocket.OPEN) {
                return; // a real WebSocket silently discards data once closing/closed
            }
            let buffer;
            if (data instanceof ArrayBuffer) {
                buffer = data.slice(0);
            } else if (ArrayBuffer.isView(data)) {
                buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            } else if (typeof data === 'string') {
                buffer = new TextEncoder().encode(data).buffer;
            } else {
                throw new TypeError('EngineSocket.send: unsupported data type');
            }
            engine.postMessage({ type: 'data', id: this.id, data: buffer }, [buffer]);
        }

        close(code = 1000, reason = '') {
            if (this.readyState === EngineSocket.CLOSING || this.readyState === EngineSocket.CLOSED) {
                return;
            }
            const wasOpen = this.readyState === EngineSocket.OPEN;
            this.readyState = EngineSocket.CLOSED;
            sockets.delete(this.id);
            if (wasOpen && engineState !== 'dead') {
                engine.postMessage({ type: 'close', id: this.id });
            }
            queueMicrotask(() => this._fire('close', new CloseEvent('close', { code, reason, wasClean: true })));
        }

        _receive(buffer) {
            if (this.readyState !== EngineSocket.OPEN) {
                return;
            }
            const data = this.binaryType === 'arraybuffer' ? buffer : new Blob([buffer]);
            this._fire('message', new MessageEvent('message', { data }));
        }

        _remoteClose(error) {
            if (this.readyState === EngineSocket.CLOSED) {
                return;
            }
            const failed = error || this.readyState === EngineSocket.CONNECTING;
            this.readyState = EngineSocket.CLOSED;
            sockets.delete(this.id);
            if (failed) {
                this._fire('error', new Event('error'));
            }
            this._fire('close', new CloseEvent('close', { code: failed ? 1006 : 1000, wasClean: !failed }));
        }

        _fire(type, event) {
            this.dispatchEvent(event);
            const handler = this[`on${type}`];
            if (typeof handler === 'function') {
                try {
                    handler.call(this, event);
                } catch (err) {
                    // Like a real event handler: report, but never let it break the transport.
                    setTimeout(() => {
                        throw err;
                    });
                }
            }
        }
    }

    // ------------------------------------------------------------------------------------------------ NativeSocket

    // Online (docs/ONLINE.md) the client's sockets, the game's and OnDemand's, go to the game server through native code,
    // the socket bridge (docs/ARCHITECTURE.md §7.2): the page posts {type:'socket', action:'open'|'send'|'close', id, …}
    // and native answers with LostCityHost.socket.events([{id, event, data?, code?, reason?}]), everything that arrived in
    // one of its run-loop turns in one call. The page never touches the network itself. The same surface as EngineSocket
    // (the global identity for the client's instanceof, readyState CLOSED before error and close fire); the URL the
    // client passes is ignored: native opens the server's own socket URL. Messages are base64 both ways.
    const nativeSockets = new Map();
    let nextNativeSocketId = 1;
    let lastSocketError = null; // { reason, at } of the last game socket that failed (the unreachable box)

    class NativeSocket extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        // (purpose: 'game', or 'ondemand' for LocalOnDemand's remote files, lcHost.openSocket; native only logs it)
        constructor(url, protocols, purpose = 'game') {
            super();
            this.url = String(url ?? '');
            this.protocol = Array.isArray(protocols) ? (protocols[0] ?? '') : (protocols ?? '');
            this.extensions = '';
            this.binaryType = 'blob';
            this.bufferedAmount = 0; // (as EngineSocket: the client's 4,900-byte guard is per message)
            this.readyState = NativeSocket.CONNECTING;
            this.onopen = null;
            this.onmessage = null;
            this.onerror = null;
            this.onclose = null;
            this.id = nextNativeSocketId++;
            this.purpose = purpose === 'ondemand' ? 'ondemand' : 'game';
            this.errorFired = false;
            this.received = 0;
            nativeSockets.set(this.id, this);
            postNative({ type: 'socket', action: 'open', id: this.id, purpose: this.purpose });
        }

        get CONNECTING() {
            return 0;
        }
        get OPEN() {
            return 1;
        }
        get CLOSING() {
            return 2;
        }
        get CLOSED() {
            return 3;
        }

        send(data) {
            if (this.readyState === NativeSocket.CONNECTING) {
                throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
            }
            if (this.readyState !== NativeSocket.OPEN) {
                return; // a real WebSocket silently discards data once closing/closed
            }
            let bytes;
            if (data instanceof ArrayBuffer) {
                bytes = new Uint8Array(data);
            } else if (ArrayBuffer.isView(data)) {
                bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            } else if (typeof data === 'string') {
                bytes = new TextEncoder().encode(data);
            } else {
                throw new TypeError('NativeSocket.send: unsupported data type');
            }
            postNative({ type: 'socket', action: 'send', id: this.id, data: toBase64(bytes) });
        }

        close(code = 1000, reason = '') {
            if (this.readyState === NativeSocket.CLOSING || this.readyState === NativeSocket.CLOSED) {
                return;
            }
            // (a game socket the server took and never answered, which the client gives up on after 30 s: the box says so)
            if (this.purpose === 'game' && this.readyState === NativeSocket.OPEN && this.received === 0) {
                console.warn('[host] the game socket got no answer');
                lastSocketError = { reason: 'timed out', at: performance.now() };
            }
            this.readyState = NativeSocket.CLOSED;
            nativeSockets.delete(this.id);
            postNative({ type: 'socket', action: 'close', id: this.id });
            // (native sends nothing more for this id: the close is the page's own, as EngineSocket's)
            queueMicrotask(() => this._fire('close', new CloseEvent('close', { code, reason, wasClean: true })));
        }

        // One of native's events for this socket (LostCityHost.socket.events).
        _event(event) {
            switch (event.event) {
                case 'open':
                    if (this.readyState === NativeSocket.CONNECTING) {
                        this.readyState = NativeSocket.OPEN;
                        this._fire('open', new Event('open'));
                    }
                    break;
                case 'message': {
                    if (this.readyState !== NativeSocket.OPEN || typeof event.data !== 'string') {
                        break;
                    }
                    const bytes = fromBase64(event.data);
                    this.received++;
                    this._fire('message', new MessageEvent('message', { data: this.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]) }));
                    break;
                }
                case 'error':
                    this._failed(event.reason);
                    break;
                case 'close':
                    // (a socket still connecting that closes without an error failed: as EngineSocket, it fires both)
                    if (this.readyState === NativeSocket.CONNECTING) {
                        this._failed(event.reason);
                    }
                    this.readyState = NativeSocket.CLOSED;
                    nativeSockets.delete(this.id);
                    this._fire('close', new CloseEvent('close', { code: Number(event.code) || 1006, reason: String(event.reason ?? ''), wasClean: Number(event.code) === 1000 }));
                    break;
                default:
                    break;
            }
        }

        _failed(reason) {
            if (this.errorFired) {
                return;
            }
            this.errorFired = true;
            this.readyState = NativeSocket.CLOSED;
            const why = String(reason ?? 'network');
            console.warn(`[host] the ${this.purpose} socket failed: ${why}`);
            if (this.purpose === 'game') {
                lastSocketError = { reason: why, at: performance.now() };
            }
            this._fire('error', new Event('error'));
        }

        _fire(type, event) {
            this.dispatchEvent(event);
            const handler = this[`on${type}`];
            if (typeof handler === 'function') {
                try {
                    handler.call(this, event);
                } catch (err) {
                    // Like a real event handler: report, but never let it break the transport.
                    setTimeout(() => {
                        throw err;
                    });
                }
            }
        }
    }

    // Base64 (RFC 4648, with padding) for the bridge; Uint8Array's own where the engine has it (Safari 18.2, Chrome 140).
    function toBase64(bytes) {
        if (typeof bytes.toBase64 === 'function') {
            return bytes.toBase64();
        }
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return btoa(text);
    }

    function fromBase64(text) {
        if (typeof Uint8Array.fromBase64 === 'function') {
            return Uint8Array.fromBase64(text);
        }
        const binary = atob(text);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    window.WebSocket = ONLINE ? NativeSocket : EngineSocket;

    // The loader's caption says where the world is (index.html calls this right after the element, so it is right at the
    // first paint): one text node, as the native launch covers draw it.
    window.lcLoaderCaption = element => {
        if (element && ONLINE) {
            element.textContent = '2004Scape · November 2004 · online';
        }
    };

    // ------------------------------------------------------------------------------------------------ client access

    const client = () => window.__client ?? null;

    // The mobile HUD (hud.js), once booted; null in the classic layout's absence of it (e.g. hud.js failed to load).
    let hud = null;
    // The options menu for fingers (menu.js), once booted; null if it failed to load (the client then draws its own).
    let menu = null;
    // The World map window (worldmap.js), once booted; null if it failed to load (the HUD then has no World map button).
    let worldMap = null;
    // The phone's battery as native last reported it (LostCityHost.battery): { level 0..1, charging }, or null (not
    // known: the simulator, desktop Chrome), for the HUD's corner.
    let battery = null;

    function canvasElement() {
        return document.getElementById('canvas');
    }

    function dispatchKey(key, type) {
        canvasElement()?.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true }));
    }

    // The title screen's "Login" button (Client.titleScreenInput: sWid / 2 - 80, sHei / 2 + 70).
    const LOGIN_BUTTON_X = 302;
    const LOGIN_BUTTON_Y = 321;

    // A left click at game coordinates, picked up by the client's next cycle like a mouse click.
    function clickGame(x, y) {
        const c = client();
        if (!c) {
            return;
        }
        c.nextMouseClickX = x;
        c.nextMouseClickY = y;
        c.nextMouseClickTime = performance.now();
        c.nextMouseClickButton = 1;
    }

    function typeKey(key) {
        dispatchKey(key, 'keydown');
        dispatchKey(key, 'keyup');
    }

    // Keys from the native keyboard: the client's key queue is a ring of 128, and a keyboard-bar chip replaces a whole
    // line at once (up to 80 Backspaces and 80 characters). A key goes in at once while the queue has room (typing is
    // never delayed); the rest wait, in order, for the client to read what is there, frame by frame.
    // The queue also holds the keyboard's submit (queueAfterKeys): it must act after the keys typed before it, which the
    // client reads in its own cycle, and before the keys typed after it. Waiting outside the queue let a key typed right
    // after Send overtake the Enter (the line went out with the next message's first letters).
    const pendingKeys = [];
    const KEY_ROOM = 64; // keys the client may have unread before more wait
    let keyPump = 0;

    function keyBacklog() {
        const c = client();
        return c ? (c.keyQueueWritePos - c.keyQueueReadPos) & 127 : 0;
    }

    function queueKey(key) {
        if (pendingKeys.length === 0 && keyBacklog() < KEY_ROOM) {
            typeKey(key);
            return;
        }
        pendingKeys.push(key);
        schedulePump();
    }

    // Runs action once every key queued before it has been read by the client (or after timeoutMs at the latest), in
    // its place among the keys: at once when nothing is waiting.
    function queueAfterKeys(action, timeoutMs) {
        if (pendingKeys.length === 0 && keyBacklog() === 0) {
            action();
            return;
        }
        pendingKeys.push({ action, deadline: performance.now() + timeoutMs });
        schedulePump();
    }

    function schedulePump() {
        if (!keyPump) {
            keyPump = requestAnimationFrame(pumpKeys);
        }
    }

    function pumpKeys() {
        keyPump = 0;
        let room = KEY_ROOM - keyBacklog();
        while (pendingKeys.length > 0) {
            const next = pendingKeys[0];
            if (typeof next === 'string') {
                if (room <= 0) {
                    break;
                }
                typeKey(pendingKeys.shift());
                room--;
                continue;
            }
            // a submit waits until the client has read the keys before it
            if (keyBacklog() > 0 && performance.now() < next.deadline) {
                break;
            }
            pendingKeys.shift();
            next.action();
            room = KEY_ROOM - keyBacklog();
        }
        if (pendingKeys.length > 0) {
            schedulePump();
        }
    }

    // The client checks `now - timer > limit` for its 15 s connection timeout and 90 s idle timer. Setting the timers
    // to +Infinity while the engine is paused makes those checks false, and they are rebased on resume.
    function freezeClientTimers() {
        const c = client();
        if (!c) {
            return;
        }
        c.timeoutTimer = Infinity;
        c.idleTimer = Infinity;
    }

    function thawClientTimers() {
        const c = client();
        if (!c) {
            return;
        }
        const now = performance.now();
        c.timeoutTimer = now;
        c.idleTimer = now;
        c.noTimeoutTimer = now;
    }

    // ------------------------------------------------------------------------------------------------ keyboard

    // Same as the client's own typingContext() (patch 0005): report abuse, then the social prompt, then the amount
    // dialog, then chat; on the title screen only the login form takes keys, and chat takes none while an NPC dialogue
    // (chat modal) is open. kind null: nothing would receive what is typed.
    // The context also tells the keyboard bar how to help: cancellable (a Cancel button for prompts), maxLength and
    // charset (what the input takes, so the bar can refuse the rest: 'chat' public chat, whose { | } ~ only a '::'
    // command takes, 'text' a private message, 'alnum' the name to report, 'game' the password's Client.CHARSET, 'name'
    // the username and name prompts, 'digits' an amount), and chips (one-tap entries: '::' and the recent developer
    // commands for chat while the character is staff, recent and common amounts for an amount prompt).
    function inputContext() {
        const c = client();
        if (!c) {
            return { kind: null };
        }
        if (!c.ingame) {
            if (c.loginscreen !== 2) {
                return { kind: null };
            }
            // the login form's status line ("Connecting to server...", "Invalid username...") is under the keyboard:
            // the bar shows it instead of the field's name
            const status = [c.loginMes1, c.loginMes2].filter(Boolean).join(' ');
            const message = status && status !== LOGIN_HINT ? status : null;
            if (c.loginSelect === 1) {
                // (online: native's Remember box in the bar, accounts.rememberFor)
                const remember = ONLINE ? { remember: accounts.rememberFor(c.loginUser) } : {};
                return { kind: 'login-pass', prompt: message ?? 'Password', text: '*'.repeat(c.loginPass?.length ?? 0), secure: true, numeric: false, maxLength: 20, charset: 'game', ...remember };
            }
            return { kind: 'login-user', prompt: message ?? 'Username', text: c.loginUser ?? '', secure: false, numeric: false, maxLength: 12, charset: 'name' };
        }
        if (c.mainModalId !== -1 && c.mainModalId === c.reportAbuseComId) {
            return { kind: 'report', prompt: 'Player to report', text: c.reportAbuseInput ?? '', secure: false, numeric: false, cancellable: true, maxLength: 12, charset: 'alnum' };
        }
        if (c.socialInputOpen) {
            return { kind: 'social', prompt: c.socialInputHeader || 'Enter name', text: c.socialInput ?? '', secure: false, numeric: false, cancellable: true, maxLength: c.socialInputType === 3 ? 80 : 12, charset: c.socialInputType === 3 ? 'text' : 'name' };
        }
        if (c.dialogInputOpen) {
            return { kind: 'dialog', prompt: 'Enter amount', text: c.dialogInput ?? '', secure: false, numeric: true, cancellable: true, maxLength: 10, charset: 'digits', chips: amountChips() };
        }
        if (c.chatModalId !== -1) {
            return { kind: null };
        }
        // (no command chips for a normal player: the engine ignores their :: commands, Settings › World › Jmod)
        return { kind: 'chat', prompt: 'Chat', text: c.chatInput ?? '', secure: false, numeric: false, maxLength: 80, charset: 'chat', chips: c.staffmodlevel > 0 ? commandChips() : [] };
    }

    const LOGIN_HINT = 'Enter your username & password.';

    // Developer commands ('::tele ...', '::~bank') are a big part of an offline world: the last few are a tap away.
    const HISTORY_KEY = 'lostcity.cmdHistory';
    const AMOUNTS_KEY = 'lostcity.amounts';

    function recall(key) {
        try {
            const list = JSON.parse(localStorage.getItem(key) ?? '[]');
            return Array.isArray(list) ? list.filter(item => typeof item === 'string') : [];
        } catch {
            return [];
        }
    }

    function remember(key, value, max) {
        try {
            const list = [value, ...recall(key).filter(item => item !== value)].slice(0, max);
            localStorage.setItem(key, JSON.stringify(list));
        } catch {
            // storage unavailable: no history this session
        }
    }

    function commandChips() {
        return [{ label: '::', text: '::', whenEmpty: true }, ...recall(HISTORY_KEY).map(command => ({ label: command, text: command }))];
    }

    function amountChips() {
        const amounts = [...recall(AMOUNTS_KEY).slice(0, 3)];
        for (const common of ['1', '5', '10', '28', '100']) {
            if (amounts.length < 7 && !amounts.includes(common)) {
                amounts.push(common);
            }
        }
        return amounts.map(amount => ({ label: amount, text: amount, submit: true }));
    }

    const isLoginKind = kind => kind === 'login-user' || kind === 'login-pass';

    // Prompts that close themselves (amount, social, report) dismiss the keyboard when they go away.
    const TRANSIENT_KINDS = new Set(['dialog', 'social', 'report']);

    let desktopInput = null;

    function desktopKeyboardInput() {
        if (!desktopInput) {
            desktopInput = document.createElement('input');
            desktopInput.id = 'lc-text-input';
            desktopInput.type = 'text';
            for (const attr of ['autocomplete', 'autocorrect', 'autocapitalize']) {
                desktopInput.setAttribute(attr, 'off');
            }
            desktopInput.setAttribute('spellcheck', 'false');
            const forward = event => {
                event.preventDefault();
                dispatchKey(event.key, event.type);
            };
            desktopInput.addEventListener('keydown', forward);
            desktopInput.addEventListener('keyup', forward);
            document.body.appendChild(desktopInput);
        }
        return desktopInput;
    }

    const keyboard = {
        shown: false,
        context: null,

        show() {
            const c = client();
            if (c && !c.ingame && c.loginscreen === 0) {
                // the keyboard button on the title screen: open the login form first, as "Existing User" does
                c.loginMes1 = '';
                c.loginMes2 = 'Enter your username & password.';
                c.loginscreen = 2;
                c.loginSelect = 0;
            }
            const context = inputContext();
            if (!context.kind) {
                return; // nothing to type into (e.g. an NPC dialogue is open)
            }
            this.shown = true;
            this.context = context;
            startsToChat(context.kind);
            if (isNative) {
                postNative({ type: 'keyboard', action: 'show', ...context });
            } else {
                desktopKeyboardInput().focus({ preventScroll: true });
            }
        },

        hide() {
            if (!this.shown) {
                return;
            }
            this.shown = false;
            this.context = null;
            if (isNative) {
                postNative({ type: 'keyboard', action: 'hide' });
            } else {
                desktopInput?.blur();
                canvasElement()?.focus({ preventScroll: true });
            }
        },

        isShown() {
            return this.shown;
        },

        toggle() {
            if (this.shown) {
                this.hide();
            } else {
                this.show();
            }
        },

        // Called by the watcher: keep the native accessory bar in sync with what the client shows.
        sync() {
            if (!this.shown || !this.context) {
                return;
            }
            const next = inputContext();
            const prev = this.context;
            if (next.kind !== prev.kind) {
                // hide when the input went away, on logging in, and when an in-game input turns into the login form
                // (a dropped connection shows the title screen while the client reconnects)
                if (!next.kind || TRANSIENT_KINDS.has(prev.kind) || isLoginKind(prev.kind) !== isLoginKind(next.kind)) {
                    this.hide();
                    return;
                }
                this.context = next;
                startsToChat(next.kind);
                if (isNative) {
                    postNative({ type: 'keyboard', action: 'show', ...next });
                }
                return;
            }
            const chips = JSON.stringify(next.chips ?? null);
            if (next.text !== prev.text || next.prompt !== prev.prompt || chips !== JSON.stringify(prev.chips ?? null) || next.remember !== prev.remember) {
                this.context = next;
                if (isStaff()) {
                    startsToChat(next.kind); // (a staff line as the client now holds it: a chip, a Backspace)
                }
                if (isNative) {
                    // (chips too: the recent commands and amounts change as they are used; online the Remember box)
                    postNative({ type: 'keyboard', action: 'update', prompt: next.prompt, text: next.text, chips: next.chips ?? [], ...('remember' in next ? { remember: next.remember } : {}) });
                }
            }
        },

        // ---- native -> page
        insertText(text) {
            if (!this.shown) {
                lastHardwareTyping = performance.now(); // a hardware keyboard (the software one was not asked for)
                // Its Space comes this way too, through UIKit's text system (KeyboardBridge sends only named keys to
                // pressKey), and continues a dialogue like Return.
                if (String(text) === ' ' && continueDialogue()) {
                    return;
                }
            }
            // (typing, not a Space that clicked a dialogue on: a hardware keyboard's, or a staff line with what this adds)
            if (!this.shown || isStaff()) {
                startsToChat(inputContext().kind, text);
            }
            for (const ch of String(text)) {
                queueKey(ch === '\n' || ch === '\r' ? 'Enter' : ch);
            }
        },

        deleteBackward() {
            queueKey('Backspace');
        },

        // In the 274 client, Enter on the login form only switches between the two fields; logging in takes a click
        // on "Login". The native keyboard labels this key "Log in", so press that button once both fields are filled.
        // The username field's key also logs in: offline the password is never checked (the engine loads the save by
        // name), so an empty one is filled in. Online the server checks it: with none typed yet, the key goes on to the
        // password field instead.
        // Characters typed just before are still in the client's key queue, and the client handles a click before the
        // queued keys in its cycle, so the submit waits in the queue for them (queueAfterKeys); keys typed after it
        // wait behind it.
        submit() {
            const c = client();
            const login = !!c && !c.ingame && c.loginscreen === 2;
            return new Promise(resolve => queueAfterKeys(() => {
                this.submitNow();
                resolve();
            }, login ? 500 : 300));
        },

        submitNow() {
            const c = client();
            if (c && !c.ingame && c.loginscreen === 2 && c.loginUser?.trim().length > 0) {
                if (!c.loginPass && ONLINE) {
                    c.loginSelect = 1;
                    return;
                }
                if (!c.loginPass) {
                    c.loginPass = OFFLINE_PASSWORD;
                }
                clickGame(LOGIN_BUTTON_X, LOGIN_BUTTON_Y);
                return;
            }
            if (c?.ingame) {
                const context = inputContext();
                if (context.kind === 'chat' && /^::\S/.test(c.chatInput ?? '')) {
                    remember(HISTORY_KEY, c.chatInput, 8);
                } else if (context.kind === 'dialog' && /^\d+$/.test(c.dialogInput ?? '')) {
                    remember(AMOUNTS_KEY, c.dialogInput, 3);
                }
            }
            typeKey('Enter');
        },

        // The bar's Cancel on a prompt (amount, name, report): close it like the game's own cancel.
        cancel() {
            this.shown = false;
            this.context = null;
            client()?.hudCancelInput?.();
        },

        // How much of the page the native keyboard and its bar cover (CSS px, 0 = none), how long its animation takes,
        // and optionally its easing (a CSS cubic-bezier: Android sends its IME animation's own, docs/ANDROID.md §3.3;
        // iOS sends none and gets KEYBOARD_CURVE): the HUD lifts the chatbox above it, the title screen its login box.
        frame(overlap, duration, curve) {
            const height = Math.max(0, Math.round(Number(overlap) || 0));
            if (height !== keyboardOverlap) {
                keyboardOverlap = height;
                keyboardAnimation = Math.max(0, Number(duration) || 0);
                keyboardCurve = keyboardEasing(curve);
                layout();
            }
        },

        dismissed() {
            this.shown = false;
            this.context = null;
        },

        // Online: the player ticked or cleared the Remember box in the keyboard bar (the password's).
        remember(on) {
            accounts.setRemember(on === true);
        },

        // Hardware keys (KeyboardBridge sends key-down and key-up separately).
        pressKey(key, down) {
            const name = String(key);
            const c = client();
            if (down && !this.shown) {
                lastHardwareTyping = performance.now();
            }
            if (name === 'Enter' && c && !c.ingame && c.loginscreen === 2) {
                // Return on the login form logs in, as the software keyboard's "Log in" key does.
                if (down) {
                    void this.submit();
                }
                return;
            }
            if (down && name === 'Escape' && escape()) {
                return;
            }
            if (down && (name === 'Enter' || name === ' ') && continueDialogue()) {
                return;
            }
            if (down && name === 'Enter' && c?.ingame && /^::\S/.test(c.chatInput ?? '')) {
                remember(HISTORY_KEY, c.chatInput, 8);
            }
            dispatchKey(name, down ? 'keydown' : 'keyup');
        }
    };

    // The player starts to type something a bot may answer: the chat keyboard opens on the chat, a private message or
    // another social prompt (names to add), or a hardware keyboard types there (its characters come through insertText;
    // pressKey has only the named keys: arrows, Return...). The bots' chat model loads now if it is not in memory
    // (lm.warm), while the line is typed: the timing measured on an iPhone 13 mini.
    // A staff character's chat line is judged as it will be once the client has read every key on its way (`typed` is
    // what insertText adds): one that is still empty, ':', or starts with '::' is not chat yet (the client sends a '::'
    // line as a command, CLIENT_CHEAT, never as chat), so a Jmod's '::tele' (or the soak harness's) does not load the
    // model; the line's first other character does. A normal player's '::' does nothing (the engine ignores it), so the
    // chat keyboard opening loads the model for them, as measured.
    function startsToChat(kind, typed = '') {
        if (kind === 'social' || (kind === 'chat' && (!isStaff() || chatLinesAfterKeys(typed).some(isChatLine)))) {
            lm.warm('chat');
        }
    }

    function isStaff() {
        return client()?.staffmodlevel > 0;
    }

    // A chat line that a bot may hear: sent (Enter on a line that is not empty) and not a '::' command, or being typed and
    // neither empty, ':' nor '::...' (it may still become a command).
    function isChatLine({ line, sent }) {
        return !line.startsWith('::') && (sent || !'::'.startsWith(line));
    }

    // The chat lines as the client will hold them once it has read every key on its way: its chatInput, then the keys
    // still unread in its key queue (the client reads them in its cycle, so keys that come back to back, or while a long
    // frame holds the page, wait there), then those waiting here (pendingKeys; a submit is an Enter), then `typed`. By the
    // client's own rules (Client.ts, the chat's key handling): 32..122 adds, up to '~' on a '::' line, 80 at most; 8 takes
    // the last one off; 10 or 13 sends a line that is not empty. The lines sent on the way ({sent: true}), then the one
    // left.
    function chatLinesAfterKeys(typed) {
        const c = client();
        const lines = [];
        let line = String(c?.chatInput ?? '');
        const add = code => {
            if (code >= 32 && (code <= 122 || (line.startsWith('::') && code <= 126)) && line.length < 80) {
                line += String.fromCharCode(code);
            } else if (code === 8) {
                line = line.slice(0, -1);
            } else if ((code === 10 || code === 13) && line.length > 0) {
                lines.push({ line, sent: true });
                line = '';
            }
        };
        const addKey = key => add(key === 'Enter' ? 10 : key === 'Backspace' ? 8 : key.length === 1 ? key.charCodeAt(0) : 0);
        if (c && Array.isArray(c.keyQueue)) {
            for (let i = c.keyQueueReadPos & 127; i !== (c.keyQueueWritePos & 127); i = (i + 1) & 127) {
                add(c.keyQueue[i]);
            }
        }
        for (const key of pendingKeys) {
            addKey(typeof key === 'string' ? key : 'Enter');
        }
        for (const ch of String(typed ?? '')) {
            addKey(ch === '\n' || ch === '\r' ? 'Enter' : ch);
        }
        lines.push({ line, sent: false });
        return lines;
    }

    const OFFLINE_PASSWORD = 'offline';
    const KEYBOARD_CURVE = 'cubic-bezier(0.38, 0.7, 0.125, 1)'; // close to the iOS keyboard's own
    let keyboardOverlap = 0; // see keyboard.frame
    let keyboardAnimation = 0;
    let keyboardCurve = KEYBOARD_CURVE; // the last frame()'s easing
    let lastHardwareTyping = -Infinity;

    // A keyboard.frame() easing as CSS takes it: 'cubic-bezier(x1, y1, x2, y2)' with four finite numbers, both x in
    // 0..1 (CSS refuses the rest, and a refused value would drop the whole transition); anything else (none: iOS)
    // is KEYBOARD_CURVE. Built again from the numbers, so nothing else from native reaches the style.
    function keyboardEasing(curve) {
        const match = typeof curve === 'string' ? /^\s*cubic-bezier\(([^()]*)\)\s*$/i.exec(curve) : null;
        const n = match ? match[1].split(',').map(part => (/^\s*-?(\d+\.?\d*|\.\d+)\s*$/.test(part) ? Number(part) : NaN)) : [];
        if (n.length !== 4 || !n.every(Number.isFinite) || n[0] < 0 || n[0] > 1 || n[2] < 0 || n[2] > 1) {
            return KEYBOARD_CURVE;
        }
        return `cubic-bezier(${n.join(', ')})`;
    }

    // Space or Return on a hardware keyboard: continues a dialogue that waits for "Click here to continue" (the client
    // drops typed keys then anyway). Not with a chat line typed: a key meant for it must not move the dialogue on.
    function continueDialogue() {
        const c = client();
        return !!c?.ingame && !c.chatInput && c.hudState?.().chatContinue === true && c.hudContinue?.() === true;
    }

    // Escape on a hardware keyboard: closes what is on top (a confirm box, the licences, Settings, the how-to card, the World map, the characters list,
    // the options menu, a prompt, a chatbox or panel the player opened). False when there was nothing to close (the key
    // then goes to the game).
    function escape() {
        if (!document.getElementById('confirm').hidden) {
            closeConfirm(false);
            return true;
        }
        if (about.licencesOpen) {
            about.closeLicences();
            return true;
        }
        if (margins.open) {
            margins.close();
            return true;
        }
        if (!document.getElementById('settings').hidden) {
            closeSettings();
            return true;
        }
        const howto = document.getElementById('howto');
        if (!howto.hidden) {
            howto.hidden = true;
            return true;
        }
        if (worldMap?.isOpen) {
            worldMap.close();
            return true;
        }
        if (!document.getElementById('characters').hidden) {
            titleScreen.closeList();
            return true;
        }
        if (servers.isOpen) {
            servers.close();
            return true;
        }
        if (accounts.isOpen) {
            accounts.close();
            return true;
        }
        if (menu?.open) {
            menu.close();
            return true;
        }
        // the drawn 2004 menu (Options menu: Classic) closes the same way, by its serial
        const c = client();
        const drawn = hostMenus() ? null : c?.hudMenu?.();
        if (drawn) {
            c.hudMenuClose(drawn.serial);
            return true;
        }
        if (c?.hudCancelInput?.()) {
            keyboard.hide();
            return true;
        }
        return hud?.escape?.() === true;
    }

    // ------------------------------------------------------------------------------------------------ lcHost (client)

    // The options-menu button arms a one-shot "right click" for the next tap; it disarms itself after a few seconds.
    let secondaryArmed = false;
    let secondaryTimer = 0;
    const SECONDARY_ARMED_MS = 5000;

    function setSecondaryArmed(armed) {
        secondaryArmed = armed;
        clearTimeout(secondaryTimer);
        if (armed) {
            secondaryTimer = setTimeout(() => setSecondaryArmed(false), SECONDARY_ARMED_MS);
        }
        document.getElementById('btn-secondary')?.classList.toggle('active', armed);
    }

    // One vocabulary for the whole app: 'selection' a button or a highlighted option, 'light' an option picked or a
    // limit reached, 'medium' the options menu shown, 'success'/'error'/'warning' outcomes.
    function haptic(style) {
        if (settings.haptics !== false) {
            postNative({ type: 'haptic', style: style ?? 'light' });
        }
    }

    window.lcHost = {
        settings,
        // online the game server ({id, name, url, nodeId, members, rsa: {n, e} decimal strings or null}): its login key
        // (client patch 0030, lcLoginKey) and LocalOnDemand's remote files; null offline (docs/ONLINE.md)
        server: ONLINE ? { id: SERVER.id, name: SERVER.name, url: SERVER.url, nodeId: SERVER.nodeId, members: SERVER.members, rsa: SERVER.rsa } : null,
        // a socket to the game server for LocalOnDemand's remote files (purpose 'ondemand'), online only
        openSocket: purpose => (ONLINE ? new NativeSocket(null, 'binary', purpose) : null),
        // which app the page runs in, as the engine is told: on Android client patch 0026 sends a canvas its whole frame
        // when any pixel changed, not their rect ('web' = no app: desktop tests get the iOS path, as everywhere here)
        platform: window.LostCityNative?.platform ?? 'web',
        snapSetting, // (hud.mjs: what stored values the sheet no longer offers load as)
        keyboard,
        haptic,
        takeSecondaryClick() {
            if (!secondaryArmed) {
                return false;
            }
            setSecondaryArmed(false);
            return true;
        },
        // 'ingame', 'menu-open', 'menu-close' (the client already gives haptic feedback for a long-press), 'action-label',
        // 'stat' (patch 0035: a stat's XP as the server sent it, for the HUD's XP counter and drops).
        onClientEvent(name, detail) {
            if (name === 'ingame') {
                hud?.xpReset(); // (the stats that follow are where the character stands, not gains)
                // switch between the title canvas and the HUD in the same frame as the client
                layout();
                menu?.hideLabel();
            } else if (name === 'stat') {
                hud?.stat(detail);
            } else if (name === 'action-label') {
                menu?.label(detail);
            } else if (name === 'menu-open') {
                pressRing.cancel();
                if (hostMenus()) {
                    menu.show(detail); // (plays the haptic)
                } else {
                    haptic('medium');
                }
            } else if (name === 'menu-close') {
                menu?.hide();
            }
        }
    };

    // The large options menu is on unless the setting says otherwise (or menu.js is missing).
    const hostMenus = () => menu !== null && settings.largeMenus !== false;

    function applyHostMenus() {
        const c = client();
        if (typeof c?.setHostMenus === 'function') {
            c.setHostMenus(hostMenus());
        }
        if (!hostMenus()) {
            menu?.hide();
        }
    }

    // ------------------------------------------------------------------------------------------------ lifecycle

    let lifecycleState = 'running'; // 'running' | 'paused'
    let lifecycleChain = Promise.resolve();

    function resumeAudio() {
        if (audioMuted) {
            return; // (LostCityHost.audio.setMuted: native wants it quiet)
        }
        try {
            const ctx = window.audioContext;
            if (ctx && ctx.state !== 'running') {
                void ctx.resume();
            }
        } catch {
            // audio is best-effort
        }
    }

    // Settings › Sound on iOS: WebKit's audio session follows the silent switch ('ambient') or ignores it ('playback').
    // Android has no sound setting (a phone has no silent switch): native always plays, as 'playback' does, and ignores
    // soundMode, so this does nothing there (docs/ANDROID.md §1 Sound).
    function applyAudioSession() {
        if (ANDROID) {
            return;
        }
        try {
            if (navigator.audioSession) {
                navigator.audioSession.type = settings.soundMode === 'playback' ? 'playback' : 'ambient';
            }
        } catch {
            // older WebKit
        }
        audioIdle.arm(); // (whether it may suspend the context follows the sound mode)
    }

    // A fallback mute for native (docs/ANDROID.md §3.3: LostCityHost.audio.setMuted), used only where the WebView
    // cannot mute the page itself (WebViewCompat.setAudioMuted, feature MUTE_AUDIO): the client's AudioContext
    // (window.audioContext, its 3rdparty/audio.js) is suspended while muted and resumed after. The client resumes it on
    // every touch (its autoplay unlock), so while muted a resume is answered with a suspend (statechange), and the
    // watcher checks again (a context made after the call).
    let audioMuted = false;
    const watchedAudio = new WeakSet();

    function holdAudioMuted() {
        const ctx = window.audioContext;
        if (!ctx || typeof ctx.suspend !== 'function') {
            return;
        }
        if (!watchedAudio.has(ctx)) {
            watchedAudio.add(ctx);
            ctx.addEventListener?.('statechange', () => {
                if (audioMuted && ctx.state === 'running') {
                    void ctx.suspend().catch(() => {});
                }
            });
        }
        if (audioMuted && ctx.state === 'running') {
            void ctx.suspend().catch(() => {});
        }
    }

    // WebKit keeps the audio output running while an AudioContext runs, silent or not: on an iPhone 13 mini audiomxd took
    // 14-17.5 % of a core with the client's context running, 0.1-0.7 % with it suspended. So the client's context
    // (window.audioContext) is suspended once nothing has played on it for AUDIO_IDLE_MS, and resumed when a source
    // starts on it (start() on a suspended context plays once the resume is done, with the same samples: on an iPhone 13
    // mini its first sample is out about 7 ms later than on a running context, about 40 ms after minutes of silence) and,
    // ahead of that, when the player touches the page (a sound follows a tap a tick later at the soonest). Music keeps it
    // running: its buffers are scheduled ahead, so one is always active. Native's mute (setAudioMuted) and the
    // lifecycle's pause own the context while they last: nothing is suspended or resumed here then.
    // AUDIO_IDLE_SUSPEND:
    //   'ambient'  (as shipped) only while Settings › Sound follows the silent switch ('ambient'), where the session
    //              mixes with other apps' audio anyway: a silent stretch there costs the iPhone 13 mini about 23 points of
    //              a core less (audiomxd 18 % -> 0.1 %);
    //   'all'      in either sound mode. Not in Play (the default): there the page is the phone's Now Playing app while
    //              its context runs, and WebKit drops a context the page has suspended from Now Playing, so Control
    //              Center would show the previous app (Music) in the game's silences. (WebKit keeps the audio session
    //              active while the context is suspended, so other apps' audio stays interrupted as it does now);
    //   'off'      nothing is suspended.
    // Never on Android: native holds audio focus whatever the page does, but how long a resume takes on a phone there is
    // unmeasured.
    const AUDIO_IDLE_SUSPEND = 'ambient';
    const AUDIO_IDLE_MS = 10000;

    const audioIdle = {
        ctx: null,
        active: 0, // sources started on ctx that have not ended
        timer: 0,
        suspended: false, // ctx was suspended here (and not resumed since)

        // Once client.js has made its context, before anything plays on it (boot): every source started on it is counted
        // until it ends (the 'ended' event: also for a source stopped early, or before it started).
        install() {
            const ctx = window.audioContext;
            if (ANDROID || AUDIO_IDLE_SUSPEND === 'off' || this.ctx || typeof ctx?.suspend !== 'function' || typeof AudioBufferSourceNode !== 'function') {
                return;
            }
            this.ctx = ctx;
            const start = AudioBufferSourceNode.prototype.start;
            AudioBufferSourceNode.prototype.start = function (...args) {
                const started = start.apply(this, args); // (a second start() throws, and is not counted)
                if (this.context === audioIdle.ctx) {
                    audioIdle.active++;
                    this.addEventListener('ended', () => {
                        audioIdle.active--;
                        audioIdle.arm();
                    }, { once: true });
                    audioIdle.wake();
                }
                return started;
            };
            ctx.addEventListener('statechange', () => {
                if (ctx.state === 'running') {
                    this.suspended = false; // (resumed: here, by the client, by the lifecycle or by native's unmute)
                    this.arm();
                }
            });
            document.addEventListener('pointerdown', () => this.wake(), true);
            this.arm();
        },

        allowed() {
            return AUDIO_IDLE_SUSPEND === 'all' || (AUDIO_IDLE_SUSPEND === 'ambient' && settings.soundMode === 'ambient');
        },

        // (again whenever a source ends, the context runs again or Settings › Sound changes)
        arm() {
            clearTimeout(this.timer);
            if (!this.ctx) {
                return;
            }
            if (!this.allowed()) {
                this.wake(); // (one suspended in a mode that allowed it)
                return;
            }
            if (this.active > 0) {
                return;
            }
            this.timer = setTimeout(() => {
                if (this.active === 0 && this.allowed() && this.ctx.state === 'running' && !audioMuted && lifecycleState !== 'paused') {
                    this.suspended = true;
                    void this.ctx.suspend().catch(() => {});
                }
            }, AUDIO_IDLE_MS);
        },

        // (native's unmute and the lifecycle's resume: a context that ran on through them sends no statechange, and a
        // timer that fired meanwhile did nothing)
        rearm() {
            if (this.ctx && this.ctx.state === 'running' && !this.suspended) {
                this.arm();
            }
        },

        // (resumed whatever its state says now: a suspend still under way when a source starts reports 'running' until it
        // is done, and a resume asked meanwhile runs after it)
        wake() {
            if (this.suspended && !audioMuted && lifecycleState !== 'paused') {
                this.suspended = false;
                void this.ctx.resume().catch(() => {});
            }
            if (this.allowed()) {
                this.arm();
            }
        }
    };

    function setAudioMuted(muted) {
        audioMuted = muted === true;
        try {
            holdAudioMuted();
            if (!audioMuted) {
                resumeAudio();
                audioIdle.rearm();
            }
        } catch {
            // audio is best-effort
        }
        return audioMuted;
    }

    // { ok, error } from the engine; one with the bots also says whether their saves were written: bots { ok, error }
    // (ok stays about the characters' saves: docs/BOTS.md §4.1)
    function lifecycleResult(reply) {
        const result = { ok: !!reply?.ok, error: reply?.error ?? null };
        if (reply?.bots && typeof reply.bots === 'object') {
            result.bots = { ok: reply.bots.ok === true, error: reply.bots.error ?? null };
        }
        return result;
    }

    async function runLifecycle(event) {
        switch (event) {
            case 'pause':
            case 'background':
            case 'terminate': {
                if (lifecycleState !== 'paused') {
                    lifecycleState = 'paused';
                    // (online the server keeps ticking: the client must notice a socket that died meanwhile, so its
                    // timers run on; there is no engine to pause or save: engineRequest answers at once)
                    if (!ONLINE) {
                        freezeClientTimers();
                    }
                }
                const reply = await engineRequest('pause', 4000);
                return lifecycleResult(reply);
            }
            case 'foreground':
            case 'resume': {
                lifecycleState = 'running';
                if (!ONLINE) {
                    thawClientTimers();
                }
                resumeAudio();
                audioIdle.rearm();
                const reply = await engineRequest('resume', 4000);
                return lifecycleResult(reply);
            }
            case 'save': {
                const reply = await engineRequest('save', 4000);
                return lifecycleResult(reply);
            }
            default:
                return { ok: false, error: `unknown lifecycle event ${event}` };
        }
    }

    // Serialised so a quick pause/resume pair is applied in order.
    function lifecycle(event) {
        const run = lifecycleChain.then(() => runLifecycle(event));
        lifecycleChain = run.catch(() => null);
        return run;
    }

    document.addEventListener('visibilitychange', () => {
        // Native notifications usually arrive first; this covers desktop browsers and is harmless when repeated.
        void lifecycle(document.hidden ? 'background' : 'resume');
    });

    window.LostCityHost = {
        lifecycle,
        keyboard,
        // the fallback mute (setAudioMuted above): { muted } as it is now
        audio: {
            setMuted: muted => ({ muted: setAudioMuted(muted) }),
            get muted() {
                return audioMuted;
            }
        },
        memoryWarning() {
            console.warn(ANDROID ? '[host] Android memory warning (onTrimMemory)' : '[host] iOS memory warning');
            worldMap?.release(); // (a closed World map's iframe, ~40-75 MB)
        },
        saveNow: () => lifecycle('save'),
        // native's battery reading, now and at each change: the level 0..1 and whether it is charging (or full on the
        // charger); a level outside 0..1 (iOS's -1: unknown) hides it
        battery(level, charging) {
            const known = typeof level === 'number' && level >= 0 && level <= 1;
            battery = known ? { level, charging: charging === true } : null;
            return battery;
        },
        // online: native's socket events, in arrival order (NativeSocket)
        socket: {
            events(batch) {
                for (const event of Array.isArray(batch) ? batch : []) {
                    nativeSockets.get(Number(event?.id))?._event(event);
                }
            }
        },
        // online: an account's kept password (or null) for "Continue as", and which accounts have one after a change
        accounts: {
            login: (name, password) => accounts.login(String(name ?? ''), password ?? null),
            saved: map => accounts.setSaved(map)
        },
        // native's Add / Edit server box: { address, name }, or null for Cancel
        servers: {
            answer: answer => servers.answered(answer)
        },
        // the bots' chat model (docs/ARCHITECTURE.md §7.1): native's answer to a {type:'lm'} request, and its status
        bots: {
            lmReply: reply => lm.reply(reply),
            lmStatus: status => lm.setStatus(status)
        },
        get settings() {
            return { ...settings };
        },
        get engineState() {
            return engineState;
        }
    };

    // Native → page calls on Android (docs/ANDROID.md §3.1). WKWebView's callAsyncJavaScript awaits what a call returns;
    // Android's evaluateJavascript cannot, so the app calls window.__lcCall(id, "keyboard.insertText", [text]) instead:
    // the dotted path is resolved on window.LostCityHost, the result awaited, and for an id above 0 the outcome posted
    // back to the app's message listener as {ch:'reply', id, ok, value} or {ch:'reply', id, ok:false, error}. id 0 is
    // fire and forget (keystrokes). The app keeps its own timeouts. iOS never calls it, and without the Android listener
    // object a reply goes nowhere.
    window.__lcCall = async (id, path, args) => {
        let reply;
        try {
            const parts = String(path).split('.');
            const owner = parts.slice(0, -1).reduce((object, key) => object?.[key], window.LostCityHost);
            const fn = owner?.[parts.at(-1)];
            if (typeof fn !== 'function') {
                reply = { ch: 'reply', id, ok: false, error: 'missing' };
            } else {
                const value = await fn.apply(owner, Array.isArray(args) ? args : []);
                reply = { ch: 'reply', id, ok: true, value: value === undefined ? null : value };
            }
        } catch (err) {
            reply = { ch: 'reply', id, ok: false, error: String(err?.message ?? err) };
        }
        if (!(id > 0)) {
            return;
        }
        let text;
        try {
            text = JSON.stringify(reply);
        } catch (err) {
            text = JSON.stringify({ ch: 'reply', id, ok: false, error: `unserializable result: ${String(err?.message ?? err)}` });
        }
        try {
            window.lcAndroid?.postMessage(text);
        } catch (err) {
            console.warn('[host] native reply failed', err);
        }
    };

    // ------------------------------------------------------------------------------------------------ UI

    let loadingEl;
    let statusPillEl;

    // One loader from launch to the title screen (the native cover looks the same, so its hand-over does not show):
    // the bar fills with the world's preload and start and the client's own loading, and the loader fades out when the
    // title screen is drawn and the world is ready.
    const loaderProgress = { client: 0, engine: 0 };

    function showLoaderProgress() {
        const fraction = 0.06 + 0.94 * (0.5 * loaderProgress.client + 0.5 * loaderProgress.engine);
        setLoading(null, fraction);
    }

    function setLoading(text, fraction) {
        if (!loadingEl) {
            return;
        }
        if (text) {
            document.getElementById('loading-text').textContent = text;
        }
        if (typeof fraction === 'number') {
            const fill = document.getElementById('loading-fill');
            const width = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
            if (width > (parseFloat(fill.style.width) || 0)) {
                fill.style.width = `${width}%`; // never backwards
            }
        }
    }

    function titleReady(c) {
        return !!c && (c.ingame || (c.titleFlames && c.lastProgressPercent === 100)) && worldReady();
    }

    // The world can take a login: the engine on this phone has started, or (online) the game server is the world.
    const worldReady = () => engineState === 'ready' || engineState === 'remote';

    function hideLoading() {
        if (!loadingEl || loadingEl.classList.contains('fade')) {
            return;
        }
        loadingEl.classList.add('fade');
        setTimeout(() => {
            loadingEl.hidden = true;
        }, 400);
    }

    function setStatusPill(text) {
        if (!statusPillEl) {
            return;
        }
        statusPillEl.hidden = !text || !loadingEl?.hidden;
        statusPillEl.textContent = text ?? '';
    }

    // A notice in the status line for a few seconds (a save that failed, the bots being off).
    let noticeTimer = 0;

    function showNotice(text, ms) {
        if (!statusPillEl) {
            return;
        }
        statusPillEl.textContent = text;
        statusPillEl.hidden = false;
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => {
            statusPillEl.hidden = true;
        }, ms);
    }

    // The bots asked for but off this session ({type:'bots', active:false, reason} from the engine worker), in plain words.
    const BOTS_OFF = {
        'no-bundle': 'Bots are off: this build of the game has none.',
        'load-failed': 'Bots are off this session: they failed to load.',
        // (the remedy named: a damaged store turns the bots off at every launch until it is reset)
        'store-unreadable': 'Bots are off this session: their save file could not be read. Settings › Saved data › Reset world starts them afresh.',
        'store-corrupt': 'Bots are off this session: their save file is damaged. Settings › Saved data › Reset world starts them afresh.',
        mismatch: 'Bots are off this session: they do not fit this version of the game.',
        failed: 'Bots are off this session: they stopped working.'
    };
    let botsNotice = null; // shown once the title or the world is on screen (watchClient)
    // what Saved data did before it reloaded the page ('The world was reset.'), shown the same way
    const NOTICE_KEY = 'lostcity.notice'; // (sessionStorage)
    let bootNotice = (() => {
        try {
            const text = sessionStorage.getItem(NOTICE_KEY);
            sessionStorage.removeItem(NOTICE_KEY);
            return text;
        } catch {
            return null;
        }
    })();
    let botsNoticeShown = false;

    function showError(message) {
        const el = document.getElementById('error');
        if (!el) {
            return;
        }
        document.getElementById('error-text').textContent = message;
        el.hidden = false;
        if (loadingEl) {
            loadingEl.hidden = true;
        }
        postNative({ type: 'fatal', message });
    }

    // In game, including while the client logs in again after a dropped connection (it sets ingame=false meanwhile;
    // the HUD stays up and its world shows "Connection lost" instead of flipping to the stale title canvas).
    const isInGame = c => c?.ingame === true || c?.reconnecting === true;

    // The client failed to load (Client.maininit threw, or it started twice) and draws its own error screen instead.
    const clientFailed = c => c?.errorLoading === true || c?.errorHost === true || c?.errorStarted === true;

    // The safe area through a hidden element padded with env(safe-area-inset-*). The element stays in the page, so
    // every read is live: WKWebView reports the insets only after its first layout, and rotating the phone moves the
    // notch to the other side, neither with a resize event (the watcher checks for changes).
    // What the page lays out around is that with Settings › Display's margins (the native covers do the same:
    // LoadingOverlay.swift and LoadingCover.kt `margins`):
    // * the sides equal, the larger of the two, as iOS reports them in landscape (50 and 50 on an iPhone 13 mini):
    //   Android reports the camera hole on its side only (left 32, right 0), which left the HUD lopsided. None: 0;
    //   +16 / +32: that much more. (The keyboard bars keep the phone's own safe area: KeyboardInsets.kt, iOS's guide.)
    // * the top: Auto is what the phone reports (0 on an iPhone in landscape, a curved edge's on Android). None: 0.
    // * the bottom: Auto is what Android reports (a curved edge's, 0 on a flat screen), but 0 on iOS, whose 21 there is
    //   the home indicator, which the HUD covers (it hides itself and the edges defer system gestures). None: 0.
    //   (Top and bottom are set apart, unlike the sides: the home indicator stays at the bottom however the phone is held.)
    let safeProbe = null;
    let safeKey = '';

    const withMargins = safe => {
        const side = settings.safeSides < 0 ? 0 : Math.max(safe.left, safe.right) + settings.safeSides;
        const top = settings.safeTop < 0 ? 0 : safe.top + settings.safeTop;
        const bottom = settings.safeBottom < 0 ? 0 : (ANDROID ? safe.bottom : 0) + settings.safeBottom;
        return { top, right: side, bottom, left: side };
    };

    function readSafeArea() {
        const override = window.__lcSafeAreaOverride; // tests: desktop Chrome has no notch (web/test/hud.mjs)
        if (override && typeof override === 'object') {
            return withMargins({ top: Number(override.top) || 0, right: Number(override.right) || 0, bottom: Number(override.bottom) || 0, left: Number(override.left) || 0 });
        }
        if (!safeProbe) {
            safeProbe = document.createElement('div');
            safeProbe.style.cssText =
                'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
                'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
            document.body.appendChild(safeProbe);
        }
        const style = getComputedStyle(safeProbe);
        return withMargins({
            top: parseFloat(style.paddingTop) || 0,
            right: parseFloat(style.paddingRight) || 0,
            bottom: parseFloat(style.paddingBottom) || 0,
            left: parseFloat(style.paddingLeft) || 0
        });
    }

    const keyOfSafeArea = safe => `${safe.top},${safe.right},${safe.bottom},${safe.left}`;

    const RAIL_MIN_GUTTER = 58;
    const HUD_MIN_WIDTH = 667; // HUD px: the iPhone SE, the narrowest phone the HUD is laid out for
    // HUD px: the smallest screen the HUD is laid out and tested at (an iPhone SE with Display Zoom, web/test/hud.mjs):
    // the pixel snap below never leaves the HUD less room than this
    const HUD_SNAP_MIN = { width: 568, height: 320 };
    let uiZoom = 1; // see layout()

    // The crisp pixel snap (docs/ANDROID.md §1 "Pixels"): at a fractional device pixel ratio (Android: 2.625, 2.75,
    // 3.5...) a HUD px of 1 CSS px is 2.625 device px, so the 2004 sprites and bitmap fonts alternate 2 and 3 device px
    // and look soft. The zoom then becomes the nearest whole number of device px per HUD px (2.625 → 3 device px:
    // 1.142857, an 800x360 HUD on a 914x411 phone, as an iPhone 13 mini's 812x375 at 3x), as long as the HUD keeps the
    // room it is laid out for (the chosen zoom's: HUD_MIN_WIDTH for ×1.5 and ×2, else HUD_SNAP_MIN). It never rounds down
    // where the next whole number has no room, though: a larger Android Display size (a higher ratio: 3.125, 3.375 on a
    // 1080 px phone) could then never make the HUD bigger than the default's 3 device px, so there the zoom stays the
    // one the Display size asks for (soft, as iOS's Display Zoom makes everything bigger). Nothing changes at a
    // whole-number ratio: an iPhone (2 or 3) and the desktop tests keep their zoom exactly (1.5 × 3 = 4.5 device px stays).
    function snapZoom(zoom, dpr, room, vh) {
        if (!(dpr > 0) || Number.isInteger(dpr)) {
            return zoom;
        }
        const minWidth = zoom > 1 ? HUD_MIN_WIDTH : HUD_SNAP_MIN.width;
        const fits = px => px > 0 && room / (px / dpr) >= minWidth && vh / (px / dpr) >= HUD_SNAP_MIN.height;
        const px = Math.round(dpr * zoom);
        if (px < dpr * zoom && !fits(px + 1)) {
            return zoom;
        }
        return fits(px) ? px / dpr : zoom;
    }

    // The keyboard, Run, menu and Settings buttons are shared by both layouts: in the HUD the keyboard sits in the chat
    // bar (after the tap-to-drop button, which has the menu button's place there: a long-press gives the menu), Run with
    // the orbs, Settings last in the tab column; on the title screen and in the classic layout they are in the right
    // rail, the menu button with them. A button moved under a finger loses its pointer, so its press ends there (that
    // touch does nothing).
    const SHARED_BUTTONS = ['btn-keyboard', 'btn-run', 'btn-secondary', 'btn-settings'];

    function placeSharedButtons(hudShown) {
        const button = id => document.getElementById(id);
        const moving = () => SHARED_BUTTONS.forEach(id => pressResets.get(button(id))?.());
        if (hudShown) {
            if (button('btn-keyboard').parentElement.id !== 'hud-chat-bar') {
                moving();
                button('btn-chat-toggle').before(button('btn-keyboard'));
                setSecondaryArmed(false); // (the menu button stays in the hidden rail)
                button('hud-orbs').append(button('btn-run'));
                button('hud-tabs').append(button('btn-settings'));
            }
            for (const id of SHARED_BUTTONS) {
                button(id).hidden = false; // (the rail hides some on the title screen)
            }
        } else if (button('btn-keyboard').parentElement.id !== 'rail-right') {
            moving();
            button('rail-right').append(button('btn-keyboard'), button('btn-secondary'), button('btn-run'), button('btn-settings'));
        }
    }

    function layout() {
        const canvas = canvasElement();
        if (!canvas) {
            return;
        }
        // zoom: the 2004 sizes are made for a phone; on a tall screen (an iPad) the HUD, the menu and the overlays are drawn
        // larger as a whole, as far as the HUD keeps the width of the narrowest phone it is laid out for (an iPad mini
        // gets 1.5, not 2). The native loading cover computes the same zoom.
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const safe = readSafeArea();
        const dpr = window.devicePixelRatio || 1;
        const heightZoom = vh >= 720 ? 2 : vh >= 540 ? 1.5 : 1;
        const zoom = snapZoom([2, 1.5].find(z => z <= heightZoom && (vw - safe.left - safe.right) / z >= HUD_MIN_WIDTH) ?? 1, dpr, vw - safe.left - safe.right, vh);
        // (dpr: the HUD renders the world at a whole number of device px per game px at a fractional ratio, hud.js)
        const view = { vw, vh, safe, zoom, dpr };
        safeKey = keyOfSafeArea(view.safe);
        // the overlays' padding (host.css --safe-*: the phone's own until the first layout)
        for (const side of ['left', 'right', 'top', 'bottom']) {
            document.documentElement.style.setProperty(`--safe-${side}`, `${safe[side]}px`);
        }
        uiZoom = view.zoom;
        document.documentElement.style.setProperty('--ui-zoom', String(view.zoom));
        document.documentElement.classList.toggle('ui-zoomed', view.zoom !== 1); // (host.css: scaled with a transform)
        // (the snap's zoom: the zoomed layers drawn at their final scale, host.css html.ui-snapped)
        document.documentElement.classList.toggle('ui-snapped', view.zoom !== 1 && !Number.isInteger(dpr));
        // (a short layer, under 370 HUD px: Android's 360, Display Zoom's 320: Settings › World's rows a little tighter)
        document.documentElement.classList.toggle('ui-short', vh / view.zoom < 370);

        const mobile = settings.layout === 'mobile' && hud !== null;
        const inGame = isInGame(client());
        const hudShown = mobile && inGame;
        const body = document.body.classList;
        body.toggle('layout-mobile', mobile);
        body.toggle('layout-classic', !mobile);
        body.toggle('phase-game', inGame);
        body.toggle('phase-title', !inGame);
        body.toggle('pixelated', !settings.smoothScaling);

        hud?.setEnabled(mobile);
        if (!hudShown) {
            worldMap?.close(); // (its button is the HUD's)
        }
        placeSharedButtons(hudShown);
        hud?.layout(view, inGame);

        // in the HUD the title canvas stays in the page, invisible and untouchable: it is the target of key events
        canvas.classList.toggle('behind', hudShown);
        if (hudShown) {
            document.getElementById('rail-left').hidden = true;
            document.getElementById('rail-right').hidden = true;
            return;
        }
        classicLayout(canvas, view);
    }

    // The 765x503 canvas fitted to the screen. In game (the classic layout) the whole canvas, with the rails in the
    // gutters beside it. The title screen (both layouts) fits its top TITLE_FIT game px instead: the logo and the
    // titlebox with all its buttons; below them is only floor, which may run off the bottom, so the title is 22% larger
    // on a 375 pt screen. With the keyboard up on the login form, the canvas lifts so the form stays in view above it.
    // On the title only Settings shows, in the top right corner over the brick wall (nothing to tap there).
    const TITLE_FIT = 413;

    function classicLayout(canvas, view) {
        const { vw, vh, safe } = view;
        const inGame = isInGame(client());
        const fit = inGame ? 503 : TITLE_FIT;
        const scale = Math.min((vh - safe.top - safe.bottom) / fit, (vw - safe.left - safe.right) / 765);
        const width = 765 * scale;
        const height = 503 * scale;
        let left = (vw - width) / 2;
        left = Math.max(safe.left, Math.min(left, vw - safe.right - width));
        let top = safe.top + (inGame ? (vh - safe.top - safe.bottom - height) / 2 : Math.max(0, (vh - safe.top - safe.bottom - fit * scale) / 2));
        if (!inGame && keyboardOverlap > 0) {
            // the form from its message lines (game y 205) to the Login button (y 340), above the keyboard
            top = Math.min(top, Math.max(vh - keyboardOverlap - 6 - 340 * scale, 6 - 205 * scale));
        }
        canvas.style.transition = inGame ? '' : `top ${Math.round(keyboardAnimation * 1000)}ms ${keyboardCurve}`;
        Object.assign(canvas.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
        titleScreen.place({ left, top, scale, vh, inGame });

        const railLeft = document.getElementById('rail-left');
        const railRight = document.getElementById('rail-right');
        railRight.hidden = false;
        railRight.classList.toggle('title', !inGame);
        if (!inGame) {
            railLeft.hidden = true;
            for (const button of railRight.querySelectorAll('button')) {
                button.hidden = button.id !== 'btn-settings';
            }
            Object.assign(railRight.style, { left: `${vw - safe.right - 56}px`, width: '56px', top: `${safe.top}px` });
            return;
        }

        const gutterLeft = left - safe.left;
        const gutterRight = vw - safe.right - (left + width);
        const inGutters = Math.min(gutterLeft, gutterRight) >= RAIL_MIN_GUTTER;
        // "Hide" hides every control except Settings, which must stay reachable (it is the only way back).
        const showControls = settings.showControls && isTouchDevice();
        railLeft.hidden = !showControls;
        for (const button of railRight.querySelectorAll('button')) {
            button.hidden = button.id !== 'btn-settings' && !showControls;
        }
        railRight.classList.toggle('minimal', !showControls);
        railLeft.classList.toggle('overlay-mode', !inGutters);
        railRight.classList.toggle('overlay-mode', !inGutters);
        railRight.style.top = '';
        if (inGutters) {
            Object.assign(railLeft.style, { left: `${safe.left}px`, width: `${gutterLeft}px` });
            Object.assign(railRight.style, { left: `${left + width}px`, width: `${gutterRight}px` });
        } else {
            Object.assign(railLeft.style, { left: `${left + 6}px`, width: '56px' });
            Object.assign(railRight.style, { left: `${left + width - 62}px`, width: '56px' });
        }
    }

    // The save profile: players/<profile>/*.sav and bots/<profile>/bots.sav, 'main'. A test build may play in another one
    // so that the phone's own characters and world stay as they are (app-test.mjs --profile, which sets
    // window.__lcTestProfile before this script runs; the engine gets it as node.profile).
    const PROFILE = typeof window.__lcTestProfile === 'string' && /^[a-z0-9_-]{1,32}$/.test(window.__lcTestProfile) ? window.__lcTestProfile : 'main';

    // The title screen's own buttons, under the titlebox: "Continue as <name>" logs the most recently played character
    // in with one tap (offline a login is just a name), "Characters" lists the others; with no character yet, a hint
    // that any name makes one. They show on the welcome box (New User / Existing User) once the title is ready.
    const titleScreen = {
        saves: [], // [{ name, modified }], most recent first
        loaded: false,
        frame: null, // the canvas placement from classicLayout
        el: null,

        init() {
            this.el = document.getElementById('title-actions');
            bindTapButton(document.getElementById('btn-continue'), () => {
                const first = ONLINE ? accounts.list()[0] : this.saves[0];
                if (first && ONLINE) {
                    accounts.loginWith(first.name);
                } else if (first) {
                    this.login(first.name);
                }
            });
            bindTapButton(document.getElementById('btn-characters'), () => this.openList());
            bindTapButton(document.getElementById('btn-accounts'), () => accounts.open());
            bindTapButton(document.getElementById('btn-world'), () => servers.open());
            document.getElementById('world-name').textContent = ONLINE ? SERVER.name : 'This phone';
            if (ONLINE) {
                document.getElementById('title-hint').textContent = 'Online: log in with a name and a password';
            }
            document.getElementById('characters-close').addEventListener('click', () => this.closeList());
            onBackdropTap(document.getElementById('characters'), () => this.closeList());
        },

        // the saved characters, from the save folder's index (online: none here, the accounts are the server's)
        async refresh() {
            this.saves = ONLINE ? [] : characterSaves(await saveIndex());
            this.loaded = true;
            this.update();
        },

        place(frame) {
            this.frame = frame;
            this.update();
        },

        // shown on the welcome box once the title is ready, under the titlebox (game y 371)
        update() {
            const c = client();
            const show = !!this.frame && !this.frame.inGame && this.loaded && c?.loginscreen === 0 && !c.ingame && !c.reconnecting && worldReady() && !!loadingEl?.hidden && !clientFailed(c);
            if (this.el.hidden === !show && !show) {
                return;
            }
            this.el.hidden = !show;
            if (!show) {
                return;
            }
            const { left, top, scale, vh } = this.frame;
            const y = top + 371 * scale + 2;
            Object.assign(this.el.style, { left: `${left + 382 * scale}px`, top: `${y}px`, maxHeight: `${Math.max(0, vh - y - 2)}px` });
            // (online: the names played on this server, Accounts for every one of them)
            const first = ONLINE ? accounts.list()[0] : this.saves[0];
            document.getElementById('btn-continue').hidden = !first;
            document.getElementById('btn-characters').hidden = ONLINE || this.saves.length < 2;
            document.getElementById('btn-accounts').hidden = !ONLINE || !first;
            document.getElementById('title-hint').hidden = !!first;
            if (first) {
                document.getElementById('continue-name').textContent = first.name;
            }
        },

        login(name) {
            const c = client();
            if (!c || c.ingame || !worldReady()) {
                return;
            }
            this.closeList();
            c.loginUser = name;
            c.loginPass = OFFLINE_PASSWORD;
            c.loginMes1 = '';
            c.loginMes2 = 'Connecting to server...';
            c.loginscreen = 2;
            c.loginSelect = 0;
            clickGame(LOGIN_BUTTON_X, LOGIN_BUTTON_Y); // the form's Login button, next cycle
            this.update();
        },

        openList() {
            const list = document.getElementById('characters-list');
            list.textContent = '';
            for (const save of this.saves) {
                const button = document.createElement('button');
                button.className = 'title-btn character';
                button.innerHTML = '<span class="character-name"></span><span class="character-when"></span>';
                button.querySelector('.character-name').textContent = save.name;
                button.querySelector('.character-when').textContent = lastPlayed(save.modified);
                button.addEventListener('click', () => this.login(save.name));
                list.append(button);
            }
            document.getElementById('characters-where').textContent = isNative ? T.charactersWhere : 'Saved in the test server\'s save folder';
            document.getElementById('characters').hidden = false;
        },

        closeList() {
            document.getElementById('characters').hidden = true;
        }
    };

    // ------------------------------------------------------------------------------------------------ online

    // Online (docs/ONLINE.md) the names played on this server: "Continue as" the newest, Accounts the rest (settings
    // accounts[<server id>], usernames only, newest first). A password is kept only when the player ticks Remember in the
    // keyboard bar, and only by native (the Keychain, the Keystore: {type:'account', action:'save-password'} after the
    // login succeeded); the page never stores one and asks native for it at "Continue as" ({type:'account',
    // action:'login'}, answered by accounts.login).
    const ACCOUNT_ANSWER_MS = 30000; // native's password for an account the page asked for, at most this late
    const accounts = {
        // which accounts have a password kept: { <server id>: [lower-case names] } (native's savedPasswords, then saved())
        stored: savedPasswordsOf(window.LostCityNative?.savedPasswords),
        choice: null, // { name, on }: the Remember box as the player set it for this name (lower-case)
        asked: null, // { name, at }: the account login the page asked native for
        fromStore: null, // the lower-case name whose password native just gave (no need to keep it again)

        init() {
            document.getElementById('accounts-close').addEventListener('click', () => this.close());
            onBackdropTap(document.getElementById('accounts'), () => this.close());
        },

        list() {
            return ONLINE ? (settings.accounts[SERVER.id] ?? []) : [];
        },

        hasPassword(name) {
            return ONLINE && (this.stored[SERVER.id] ?? []).includes(String(name ?? '').trim().toLowerCase());
        },

        // The Remember box for this name: as the player set it, else on when its password is kept, else as last time on
        // this server (off the first time).
        rememberFor(name) {
            const key = String(name ?? '').trim().toLowerCase();
            if (this.choice?.name === key) {
                return this.choice.on;
            }
            return this.hasPassword(key) || settings.rememberDefault[SERVER?.id] === true;
        },

        setRemember(on) {
            if (!ONLINE) {
                return;
            }
            this.choice = { name: String(client()?.loginUser ?? '').trim().toLowerCase(), on };
            settings.rememberDefault = { ...settings.rememberDefault, [SERVER.id]: on };
            persistSettings();
            keyboard.sync();
        },

        // native -> page: the accounts with a password kept, after a change
        setSaved(map) {
            this.stored = savedPasswordsOf(map);
            this.render();
            titleScreen.update();
        },

        // After a new login on this server (not a reconnect): the name first in the list, and its password kept or
        // forgotten as the Remember box says.
        loggedIn() {
            const c = client();
            const name = String(c?.loginUser ?? '').trim();
            if (!ONLINE || !name) {
                return;
            }
            const key = name.toLowerCase();
            const others = this.list().filter(account => account.name.toLowerCase() !== key);
            settings.accounts = { ...settings.accounts, [SERVER.id]: [{ name, lastPlayed: Date.now() }, ...others].slice(0, MAX_ACCOUNTS) };
            persistSettings();
            const remember = this.rememberFor(name);
            if (remember && c.loginPass && this.fromStore !== key) {
                postNative({ type: 'account', action: 'save-password', server: SERVER.id, name, password: c.loginPass });
            } else if (!remember && this.hasPassword(name)) {
                postNative({ type: 'account', action: 'forget-password', server: SERVER.id, name });
            }
            this.choice = null;
            this.fromStore = null;
        },

        // (watcher) A login with the kept password that ended on the title (refused: the password changed on the server,
        // or anything else) leaves the form to the player: a password typed there is their own, kept or forgotten as
        // Remember says. (A server's transfer countdown is still the same login.)
        watch(c) {
            if (this.fromStore && !isInGame(c) && c.loginMes2 !== 'Connecting to server...' && !String(c.loginMes2 ?? '').startsWith('Your profile will be transferred')) {
                this.fromStore = null;
            }
        },

        // "Continue as", an Accounts row: native gives the kept password, or null (then the password field opens)
        loginWith(name) {
            const c = client();
            if (!c || isInGame(c) || !worldReady()) {
                return;
            }
            this.close();
            if (!isNative) {
                this.login(name, null, true);
                return;
            }
            this.asked = { name, at: performance.now() };
            postNative({ type: 'account', action: 'login', server: SERVER.id, name });
        },

        // native -> page (LostCityHost.accounts.login): with a password the form is filled and Login pressed (the page
        // keeps nothing); without one the name is filled in and the password field opens.
        login(name, password, own = false) {
            const c = client();
            const asked = this.asked;
            if (!own && (!asked || asked.name !== name || performance.now() - asked.at > ACCOUNT_ANSWER_MS)) {
                return;
            }
            this.asked = null;
            if (!c || isInGame(c)) {
                return;
            }
            c.loginUser = String(name);
            c.loginMes1 = '';
            c.loginscreen = 2;
            if (typeof password === 'string' && password) {
                this.fromStore = String(name).trim().toLowerCase();
                c.loginPass = password;
                c.loginMes2 = 'Connecting to server...';
                c.loginSelect = 0;
                clickGame(LOGIN_BUTTON_X, LOGIN_BUTTON_Y);
            } else {
                c.loginPass = '';
                c.loginMes2 = LOGIN_HINT;
                c.loginSelect = 1;
                keyboard.show();
            }
            titleScreen.update();
        },

        open() {
            this.render();
            document.getElementById('accounts-title').textContent = `Accounts on ${SERVER.name}`;
            document.getElementById('accounts-where').textContent = T.passwordsWhere;
            document.getElementById('accounts').hidden = false;
        },

        close() {
            document.getElementById('accounts').hidden = true;
        },

        get isOpen() {
            return !document.getElementById('accounts').hidden;
        },

        render() {
            const list = document.getElementById('accounts-list');
            if (!list || !ONLINE) {
                return;
            }
            list.textContent = '';
            for (const account of this.list()) {
                const kept = this.hasPassword(account.name);
                const row = dataRow(account.name, `${lastPlayed(account.lastPlayed)}${kept ? ' · password kept' : ''}`);
                if (kept) {
                    const mark = document.createElement('span');
                    mark.className = 'key-mark';
                    mark.setAttribute('aria-label', 'password kept');
                    row.querySelector('.data-name').append(mark);
                }
                const buttons = document.createElement('span');
                buttons.className = 'data-btns';
                const button = (label, plain, onClick) => {
                    const b = document.createElement('button');
                    b.className = `data-btn${plain ? ' plain' : ''}`;
                    b.textContent = label;
                    b.addEventListener('click', onClick);
                    buttons.append(b);
                };
                button('Log in', true, () => this.loginWith(account.name));
                if (kept) {
                    button('Forget password', false, () => postNative({ type: 'account', action: 'forget-password', server: SERVER.id, name: account.name }));
                }
                button('Remove', false, () => this.remove(account.name));
                row.append(buttons);
                list.append(row);
            }
            if (!this.list().length) {
                list.append(dataRow('None yet', 'Log in to add one'));
            }
        },

        // the name goes from this phone's list (and its kept password); the account on the server is not touched
        remove(name) {
            const key = name.toLowerCase();
            if (this.hasPassword(name)) {
                postNative({ type: 'account', action: 'forget-password', server: SERVER.id, name });
            }
            settings.accounts = { ...settings.accounts, [SERVER.id]: this.list().filter(account => account.name.toLowerCase() !== key) };
            persistSettings();
            this.render();
            titleScreen.update();
            if (!this.list().length) {
                this.close();
            }
        }
    };

    // native's savedPasswords: { <server id>: [lower-case names] }, anything else dropped
    function savedPasswordsOf(map) {
        const stored = {};
        for (const [id, names] of Object.entries(map && typeof map === 'object' ? map : {})) {
            if (Array.isArray(names)) {
                stored[id] = names.filter(name => typeof name === 'string').map(name => name.toLowerCase());
            }
        }
        return stored;
    }

    // The worlds (the title's World button, Settings › World › Change): this phone's world and the game servers the
    // player added. A tap on one plays on it: the page reloads there (switch). Add server and Edit ask native's box for an
    // address and a name (servers.answer), then check the address (/server-probe, native's: /crc, rs2.cgi, the client's
    // key) and show what it found in the list's place: Use, Save or Cancel. Delete asks first, and native removes the
    // server's downloaded files and kept passwords.
    const servers = {
        asking: null, // the resolve of native's server box while it is open
        probe: null, // { entry, url, name, result } being checked or shown
        leaving: false,

        init() {
            document.getElementById('worlds-close').addEventListener('click', () => this.close());
            onBackdropTap(document.getElementById('worlds'), () => this.close());
            document.getElementById('probe-use').addEventListener('click', () => void this.keep(true));
            document.getElementById('probe-save').addEventListener('click', () => void this.keep(false));
            document.getElementById('probe-cancel').addEventListener('click', () => this.showList());
            document.getElementById('world-change').addEventListener('click', () => {
                closeSettings();
                this.open();
            });
        },

        get isOpen() {
            return !document.getElementById('worlds').hidden;
        },

        open() {
            keyboard.hide();
            unreachable.hide();
            this.showList();
            document.getElementById('worlds').hidden = false;
        },

        close() {
            document.getElementById('worlds').hidden = true;
            this.probe = null;
            unreachable.reshow();
        },

        showList() {
            this.probe = null;
            document.getElementById('worlds-title').textContent = 'Choose a world';
            document.getElementById('worlds-probe').hidden = true;
            const list = document.getElementById('worlds-list');
            list.hidden = false;
            list.textContent = '';
            const here = ONLINE ? SERVER.id : 'offline';
            list.append(this.row('offline', 'This phone (offline)', here === 'offline' ? 'Playing now' : settings.bots > 0 ? `With ${settings.bots} bots` : 'No bots'));
            for (const server of settings.servers) {
                list.append(this.row(server.id, server.name, server.id === here ? `Playing now · ${window.lcServerUrl.address(server.url)}` : window.lcServerUrl.address(server.url), server));
            }
            const add = document.createElement('button');
            add.className = 'title-btn add-server';
            add.textContent = 'Add server';
            add.disabled = !isNative || settings.servers.length >= MAX_SERVERS;
            add.addEventListener('click', () => void this.add());
            list.append(add);
            document.getElementById('worlds-where').textContent = isNative ? 'Online, the game runs on the server: it keeps your progress there, not on this phone.' : `Add server: ${T.onlyInApp}`;
        },

        row(id, name, detail, server = null) {
            const row = document.createElement('div');
            row.className = `world-row${id === (ONLINE ? SERVER.id : 'offline') ? ' current' : ''}`;
            const main = document.createElement('button');
            main.className = 'title-btn character';
            main.innerHTML = '<span class="character-name"></span><span class="character-when"></span>';
            main.querySelector('.character-name').textContent = name;
            main.querySelector('.character-when').textContent = detail;
            main.addEventListener('click', () => void this.use(id));
            row.append(main);
            if (server) {
                const edit = document.createElement('button');
                edit.className = 'data-btn plain';
                edit.textContent = 'Edit';
                edit.disabled = !isNative;
                edit.addEventListener('click', () => void this.edit(server));
                row.append(edit);
                if (server.id !== (ONLINE ? SERVER.id : null)) {
                    const remove = document.createElement('button');
                    remove.className = 'data-btn';
                    remove.textContent = 'Delete';
                    remove.addEventListener('click', () => void this.remove(server));
                    row.append(remove);
                }
            }
            return row;
        },

        // native's Add / Edit server box: { address, name } as typed, or null (Cancel)
        ask(title, address = '', name = '') {
            this.asking?.(null);
            return new Promise(resolve => {
                this.asking = resolve;
                postNative({ type: 'server', action: 'ask', title, address, name });
            });
        },

        // native -> page (LostCityHost.servers.answer)
        answered(answer) {
            const resolve = this.asking;
            this.asking = null;
            resolve?.(answer && typeof answer === 'object' ? { address: String(answer.address ?? '').trim(), name: String(answer.name ?? '').trim() } : null);
        },

        async add() {
            const answer = await this.ask('Add a server');
            if (answer) {
                await this.check(null, answer.address, answer.name);
            }
        },

        async edit(server) {
            const answer = await this.ask(`Edit ${server.name}`, window.lcServerUrl.address(server.url), server.name);
            if (answer) {
                await this.check(server, answer.address, answer.name);
            }
        },

        // The address checked by native's probe; what it found in the list's place.
        async check(entry, typed, name) {
            const url = window.lcServerUrl.normalize(typed);
            document.getElementById('worlds-list').hidden = true;
            document.getElementById('worlds-probe').hidden = false;
            document.getElementById('worlds-title').textContent = entry ? `Edit ${entry.name}` : 'Add a server';
            const status = document.getElementById('probe-status');
            const show = (text, kind, notes = '') => {
                status.textContent = text;
                status.className = `probe-status${kind ? ` ${kind}` : ''}`;
                document.getElementById('probe-notes').textContent = notes;
            };
            document.getElementById('probe-address').textContent = url ? window.lcServerUrl.address(url) : typed || '(nothing typed)';
            const use = document.getElementById('probe-use');
            const save = document.getElementById('probe-save');
            if (!url) {
                this.probe = null;
                show('That is not an address. Type it like 192.168.1.20 or my-mac.local:8888, with http:// or https:// in front if the server needs it.', 'failed');
                use.disabled = save.disabled = true;
                return;
            }
            this.probe = { entry, url, name: name || entry?.name || window.lcServerUrl.hostOf(url), result: null };
            const probe = this.probe;
            show('Checking…', null);
            use.disabled = save.disabled = true;
            const result = await fetch(`server-probe?url=${encodeURIComponent(url)}`)
                .then(response => (response.ok ? response.json() : null))
                .catch(() => null);
            if (this.probe !== probe) {
                return; // (cancelled meanwhile)
            }
            probe.result = result;
            const notes = Array.isArray(result?.notes) ? result.notes.filter(note => typeof note === 'string').join('\n') : '';
            if (result?.ok) {
                const world = Number(result.nodeId) - 9;
                show(`Ready: a ${result.members === false ? 'free' : 'members'} world${world > 0 ? `, world ${world}` : ''}.`, 'ready', notes);
            } else {
                show(`Not ready: ${reasonWords(result?.error ?? 'unreachable')}`, 'failed', 'Save keeps it for later; Use needs it ready.');
            }
            use.disabled = !result?.ok;
            save.disabled = false;
        },

        // Save the checked server (Use: and play on it).
        async keep(use) {
            const probe = this.probe;
            if (!probe) {
                return;
            }
            const { entry, url, name, result } = probe;
            const found = result?.ok ? result : null;
            if (entry && url !== entry.url && !(await this.passwordsMoved(entry, url))) {
                return;
            }
            const server = serverEntry({
                id: entry?.id ?? window.lcServerUrl.newServerId(),
                name,
                url,
                nodeId: found ? found.nodeId : entry?.nodeId,
                members: found ? found.members : entry?.members,
                rsa: found ? found.rsa : entry?.rsa,
                added: entry?.added || Date.now()
            });
            settings.servers = entry ? settings.servers.map(s => (s.id === entry.id ? server : s)) : [...settings.servers, server];
            persistSettings();
            if (use) {
                // (the server in use, changed: this page still has the old one, so it loads again)
                const changed = entry?.id === SERVER?.id && sortedJson({ ...server, added: 0 }) !== sortedJson({ ...SERVER, added: 0 });
                await this.use(server.id, changed);
            } else {
                this.showList();
            }
        },

        // An entry given another address keeps its id, so the passwords kept for it would go to the new address at
        // "Continue as": right when the server moved (a new address on the network), wrong when it is another server.
        // With passwords kept the player says which (false: the probe stays as it is; the passwords are forgotten when
        // the player says it is another server).
        async passwordsMoved(entry, url) {
            if (this.probe?.entry !== entry || this.probe.url !== url) {
                return false;
            }
            const kept = (accounts.stored[entry.id] ?? []).length;
            if (!kept || !isNative) {
                return true;
            }
            const probe = this.probe;
            const moved = await confirmBox({
                title: 'The same server?',
                text: `${kept === 1 ? 'A password is' : `${kept} passwords are`} kept on this phone for ${entry.name} at ${window.lcServerUrl.address(entry.url)}. Keep ${kept === 1 ? 'it' : 'them'} only if ${window.lcServerUrl.address(url)} is the same server: "Continue as" would send ${kept === 1 ? 'it' : 'them'} there.`,
                action: 'Forget',
                cancel: 'Same server'
            }).then(forget => !forget);
            if (this.probe !== probe) {
                return false; // (the sheet moved on meanwhile)
            }
            if (!moved) {
                for (const name of accounts.stored[entry.id] ?? []) {
                    postNative({ type: 'account', action: 'forget-password', server: entry.id, name });
                }
            }
            return true;
        },

        async remove(server) {
            const ok = await confirmBox({
                title: `Delete ${server.name}?`,
                text: `It goes from this phone's list, with its accounts, any password kept for them and its downloaded game files. The server itself is not changed.`,
                action: 'Delete'
            });
            if (!ok) {
                return;
            }
            const { [server.id]: accountsGone, ...accountsLeft } = settings.accounts;
            const { [server.id]: rememberGone, ...rememberLeft } = settings.rememberDefault;
            void accountsGone;
            void rememberGone;
            settings.servers = settings.servers.filter(s => s.id !== server.id);
            settings.accounts = accountsLeft;
            settings.rememberDefault = rememberLeft;
            persistSettings();
            postNative({ type: 'server', action: 'delete', id: server.id });
            this.showList();
        },

        // Play on another world: the page reloads there. Leaving this phone's world saves it first, as Restart does; leaving
        // a server in game logs out through the game first (a bare reload would leave the character in that world for
        // 30-60 s, and the next login would be refused as "already logged in").
        // (again: the server in use once more, its entry changed: native reloads for it as for any other)
        async use(id, again = false) {
            if (id === (ONLINE ? SERVER.id : 'offline') && !again) {
                this.close();
                return;
            }
            if (this.leaving || (id !== 'offline' && !settings.servers.some(s => s.id === id))) {
                return;
            }
            this.leaving = true;
            try {
                if (ONLINE && client()?.reconnecting) {
                    // (the connection is lost and the game is trying again: there is no logging out, and nothing to wait for)
                    console.log('[host] leaving the server while its connection is lost');
                } else if (ONLINE && isInGame(client())) {
                    if (!(await logOutCleanly())) {
                        haptic('error');
                        showNotice('You could not be logged out (in combat?): try again in a moment.', 6000);
                        return;
                    }
                } else if (!ONLINE && !(await savedBeforeLeaving())) {
                    return;
                }
                settings.server = id;
                persistSettings();
                console.log(`[host] playing on ${id === 'offline' ? 'this phone' : id} next: reload`);
                if (isNative) {
                    postNative({ type: 'server', action: 'use', id });
                } else {
                    location.reload();
                }
            } finally {
                this.leaving = false;
            }
        }
    };

    // Online, in game: the Logout tab's "Click here to logout" pressed through the client, as the player would (classic
    // coordinates: the tab's centre until it is the open tab, as a first tap may only close a window; then the button in
    // its side panel, once a second); true once the client is back on the title, within 5 s (the server keeps a character
    // in combat a few seconds more: false then).
    const LOGOUT_TAB_INDEX = 10;
    const LOGOUT_TAB = [649, 484];
    const LOGOUT_BUTTON = [553 + 94, 205 + 170];

    async function logOutCleanly() {
        const c = client();
        const out = () => !c.ingame && !c.reconnecting;
        if (!c || out()) {
            return true;
        }
        if (typeof c.tapAt !== 'function' || typeof c.hudState !== 'function' || c.reconnecting) {
            return false;
        }
        const started = performance.now();
        let pressed = -Infinity;
        while (performance.now() - started < 5000 && !out()) {
            if (c.hudState().activeTab !== LOGOUT_TAB_INDEX) {
                c.tapAt(...LOGOUT_TAB, 1);
            } else if (performance.now() - pressed >= 1000) {
                pressed = performance.now();
                c.tapAt(...LOGOUT_BUTTON, 1);
            }
            await new Promise(resolve => setTimeout(resolve, 150));
        }
        return out();
    }

    // What native's words for a failed connection or file mean, in plain words (`local network`: the
    // phone's local network privacy refused it).
    function reasonWords(words) {
        const text = String(words ?? '');
        const known = {
            unreachable: 'it cannot be reached. Is it running, and is this phone on its network?',
            refused: 'nothing answered at that address (connection refused). Is the server running?',
            'timed out': 'it did not answer in time.',
            'not found': 'there is no server by that name.',
            dns: 'its name could not be looked up. Is this phone online?',
            tls: 'the secure connection failed (its certificate?).',
            network: 'the connection failed.',
            'not a 2004scape server': 'it does not answer as a 2004Scape server.',
            'checksum mismatch': 'its game files did not arrive whole.',
            'invalid address': 'that is not an address.',
            'no server': 'no server is chosen.',
            'local network': T.localNetwork
        };
        const http = /^http (\d{3})$/.exec(text);
        return known[text] ?? (http ? `it refused the game's connection (HTTP ${http[1]}).` : `${text || 'unknown'}.`);
    }

    // Online: the server cannot be reached, or refuses the game: a box over the title within seconds, the reason in plain
    // words, Try again (reload), Play offline, Choose world. From native's /crc words at boot (checkServer), the client's
    // own retry screen while it loads, and a login whose socket failed (NativeSocket: native's error words).
    const unreachable = {
        crcWords: null, // the boot's /crc answer when it was not the table (native's 502 words)
        shownFor: null, // what the box shows (closed by Choose world: shown again when the worlds close)
        seenError: null, // the socket error the box was shown for (a new failed login shows it again)

        init() {
            document.getElementById('unreachable-retry').addEventListener('click', () => location.reload());
            document.getElementById('unreachable-offline').addEventListener('click', () => void servers.use('offline'));
            document.getElementById('unreachable-choose').addEventListener('click', () => servers.open());
        },

        get isOpen() {
            return !document.getElementById('unreachable').hidden;
        },

        // watcher: the box, once something says so
        check(c) {
            if (!ONLINE || !c || this.isOpen || servers.isOpen || isInGame(c)) {
                return;
            }
            const loading = !(c.lastProgressPercent >= 100);
            if (this.crcWords && loading) {
                this.show(this.crcWords);
            } else if (loading && /Will retry in|please reload page/i.test(String(c.lastProgressMessage ?? ''))) {
                this.show(this.crcWords ?? 'files');
            } else if (!loading && c.loginMes2 === 'Error connecting to server.' && lastSocketError && lastSocketError !== this.seenError && performance.now() - lastSocketError.at < 15000) {
                this.seenError = lastSocketError;
                this.show(lastSocketError.reason);
            }
        },

        show(words) {
            this.shownFor = words;
            const title = document.getElementById('unreachable-title');
            title.textContent = `Could not connect to ${SERVER.name}`;
            document.getElementById('unreachable-text').textContent = `${window.lcServerUrl.address(SERVER.url)}: ${words === 'files' ? 'its game files could not be loaded.' : reasonWords(words)}`;
            keyboard.hide();
            hideLoading();
            document.getElementById('unreachable').hidden = false;
            haptic('error');
            console.warn(`[host] ${SERVER.url} could not be reached: ${words}`);
        },

        hide() {
            document.getElementById('unreachable').hidden = true;
        },

        // (the worlds closed without a choice: the server is still unreachable)
        reshow() {
            if (this.shownFor && !this.isOpen) {
                document.getElementById('unreachable').hidden = false;
            }
        }
    };

    // (online, boot) the server's /crc once, beside the client's own: a 502's words name what is wrong (native keeps the
    // table for the page load, so the client's request costs nothing more)
    function checkServer() {
        fetch('crc', { cache: 'no-store' })
            .then(async response => {
                if (!response.ok) {
                    unreachable.crcWords = (await response.text()).trim().slice(0, 60) || `http ${response.status}`;
                }
            })
            .catch(() => {
                unreachable.crcWords = 'unreachable';
            });
    }

    // Online, the client's words that are wrong for a game server, replaced as the client sets them (so no frame shows
    // them): New User's hint (patch 9's, for the world on this phone) and response 6's "RuneScape has been updated! /
    // Please reload this page." (a server with another game version or login key: patch 30).
    const ONLINE_WORDS = new Map([
        ['New character: type any name.', 'Type a name and a password.'],
        ['No password needed.', 'Your server may ask you to register first.'],
        ['RuneScape has been updated!', 'This server runs a different'],
        ['Please reload this page.', 'game version or key.']
    ]);

    function useOnlineWords(c) {
        for (const field of ['loginMes1', 'loginMes2']) {
            let value = c[field];
            Object.defineProperty(c, field, {
                configurable: true,
                enumerable: true,
                get: () => value,
                set: text => {
                    value = ONLINE_WORDS.get(text) ?? text;
                }
            });
        }
    }

    // Everything in the save folder ([{ path, size, modified }], ARCHITECTURE.md §3); [] if it cannot be read.
    async function saveIndex() {
        try {
            const response = await fetch('save-index');
            const files = response.ok ? await response.json() : [];
            return Array.isArray(files) ? files.filter(f => typeof f?.path === 'string') : [];
        } catch {
            return [];
        }
    }

    // The characters in the index: [{ safe: 'bob_smith', name: 'Bob Smith', path, modified }], most recent first.
    function characterSaves(files) {
        const prefix = `players/${PROFILE}/`;
        return files
            .filter(f => f.path.startsWith(prefix) && f.path.endsWith('.sav') && !f.path.slice(prefix.length).includes('/'))
            .map(f => {
                const safe = f.path.slice(prefix.length, -4);
                return { safe, name: displayName(safe), path: f.path, modified: Number(f.modified) || 0 };
            })
            .sort((a, b) => b.modified - a.modified);
    }

    // The engine's toSafeName (JString.toBase37): trimmed, at most 12 characters, letters lower-cased, digits, anything
    // else '_', none at either end.
    function safeName(name) {
        return String(name ?? '')
            .trim()
            .slice(0, 12)
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '_')
            .replace(/^_+|_+$/g, '');
    }

    // a save's file name is the safe name ("bob_smith"); the game shows it as "Bob Smith"
    function displayName(safe) {
        return safe.replace(/_/g, ' ').replace(/\b[a-z]/g, ch => ch.toUpperCase());
    }

    function lastPlayed(ms) {
        return ms ? `Played ${daysAgo(ms)}` : '';
    }

    function daysAgo(ms) {
        const days = Math.floor((Date.now() - ms) / 86400000);
        return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
    }

    function isTouchDevice() {
        return isNative || navigator.maxTouchPoints > 0;
    }

    function bindHoldButton(button, onDown, onUp) {
        let pointerId = null;
        const release = () => {
            if (pointerId === null) {
                return;
            }
            pointerId = null;
            button.classList.remove('pressed');
            onUp();
        };
        button.addEventListener('pointerdown', event => {
            event.preventDefault();
            if (pointerId !== null) {
                return;
            }
            pointerId = event.pointerId;
            button.setPointerCapture?.(event.pointerId);
            button.classList.add('pressed');
            onDown();
        });
        button.addEventListener('pointerup', release);
        button.addEventListener('pointercancel', release);
        button.addEventListener('lostpointercapture', release);
        button.addEventListener('contextmenu', event => event.preventDefault());
    }

    // A HUD button that acts on release, like a native one: the press follows the finger, and sliding off (more than
    // TAP_SLOP from the button, or a swipe longer than TAP_TRAVEL) cancels it without acting or a haptic. A dimmed
    // button (.forced/.disabled) acts but gives no click.
    const TAP_SLOP = 16;
    const TAP_TRAVEL = 28;
    const pressResets = new WeakMap(); // button -> ends its press without acting (placeSharedButtons)

    function bindTapButton(button, onTap) {
        let press = null; // { id, x, y, inside }
        const isInside = event => {
            const r = button.getBoundingClientRect();
            return event.clientX >= r.left - TAP_SLOP && event.clientX <= r.right + TAP_SLOP && event.clientY >= r.top - TAP_SLOP && event.clientY <= r.bottom + TAP_SLOP && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= TAP_TRAVEL;
        };
        const reset = () => {
            press = null;
            button.classList.remove('pressed');
        };
        pressResets.set(button, reset);
        button.addEventListener('pointerdown', event => {
            event.preventDefault();
            // A second finger on a button that is still pressed is ignored. A press whose pointer the button no longer
            // holds is stale: its pointerup went elsewhere (a button moved while pressed loses the capture silently).
            if (press && press.id !== event.pointerId && button.hasPointerCapture?.(press.id)) {
                return;
            }
            reset();
            press = { id: event.pointerId, x: event.clientX, y: event.clientY, inside: true };
            button.setPointerCapture?.(event.pointerId);
            button.classList.add('pressed');
        });
        button.addEventListener('pointermove', event => {
            if (press?.id === event.pointerId && press.inside && !isInside(event)) {
                press.inside = false; // once off, the press stays cancelled
                button.classList.remove('pressed');
            }
        });
        // A tap is followed by a synthesized click at the same spot, after pointerup has already run onTap. If onTap
        // opened an overlay (settings), that click would land on the overlay's backdrop and close it again.
        button.addEventListener('touchend', event => event.preventDefault(), { passive: false });
        const end = event => {
            if (press?.id !== event.pointerId) {
                return;
            }
            const act = event.type === 'pointerup' && press.inside && isInside(event);
            press = null;
            button.classList.remove('pressed');
            if (act) {
                if (!button.matches('.forced, .disabled, .unavailable')) {
                    haptic('selection');
                }
                if (secondaryArmed && button.id !== 'btn-secondary') {
                    setSecondaryArmed(false); // another button: the armed "right click" was not meant for it
                }
                onTap();
            }
        };
        button.addEventListener('pointerup', end);
        button.addEventListener('pointercancel', end);
        button.addEventListener('lostpointercapture', end);
        button.addEventListener('contextmenu', event => event.preventDefault());
    }

    // Ctrl held for the client: every click runs. Only used before the run mode exists (Tutorial Island has no Player
    // controls tab until late); after that the Run button switches the real run mode, see toggleRun.
    let runToggled = false;

    function setRunToggled(on) {
        runToggled = on;
        const c = client();
        if (c?.keyHeld) {
            c.keyHeld[5] = on ? 1 : 0;
        }
        refreshRunButton();
    }

    function toggleRun() {
        if (hud?.toggleRun()) {
            setRunToggled(false);
            return;
        }
        setRunToggled(!runToggled);
    }

    function refreshRunButton() {
        const c = client();
        const running = typeof c?.hudState === 'function' && c.ingame ? c.hudState().running : false;
        document.getElementById('btn-run')?.classList.toggle('active', runToggled || running);
    }

    // Camera keys held by the rail buttons. The client releases keys 1-4 on its own pointer/focus events (e.g. a
    // cancelled canvas touch), so held ones are asserted again afterwards and on every watcher tick.
    const heldRailKeys = new Set();

    function reassertHeldKeys() {
        const c = client();
        if (c?.keyHeld) {
            for (const key of heldRailKeys) {
                c.keyHeld[key] = 1;
            }
        }
    }

    function initControls() {
        for (const button of document.querySelectorAll('[data-hold]')) {
            const key = Number(button.dataset.hold);
            bindHoldButton(
                button,
                () => {
                    haptic('selection');
                    heldRailKeys.add(key);
                    reassertHeldKeys();
                },
                () => {
                    heldRailKeys.delete(key);
                    const c = client();
                    if (c?.keyHeld) {
                        c.keyHeld[key] = 0;
                    }
                }
            );
        }
        for (const type of ['pointercancel', 'pointerup', 'blur']) {
            window.addEventListener(type, () => {
                if (heldRailKeys.size > 0) {
                    setTimeout(reassertHeldKeys, 0);
                }
            }, true);
        }

        bindTapButton(document.getElementById('btn-keyboard'), () => keyboard.toggle());
        bindTapButton(document.getElementById('btn-secondary'), () => setSecondaryArmed(!secondaryArmed));
        bindTapButton(document.getElementById('btn-run'), toggleRun);
        bindTapButton(document.getElementById('btn-settings'), openSettings);

        document.getElementById('error-restart').addEventListener('click', () => restartGame());
    }

    // ------------------------------------------------------------------------------------------------ gestures

    const TOUCH_SLOP = 14; // the client's (patch 0012): a finger that moved further along either axis is no long-press
    const TAP_MAX_MS = 250; // the client's (patch 0036): a touch held longer is no tap; lifted before its menu, nothing

    // Is this pointer event on the world: the HUD's world surface, or the classic canvas's viewport (game 4..516, 4..338)?
    function onWorld(event) {
        const target = event.target;
        if (hud?.active) {
            return target?.id === 'surface-game';
        }
        if (target?.id !== 'canvas' || !client()?.ingame) {
            return false;
        }
        const r = target.getBoundingClientRect();
        const x = ((event.clientX - r.left) * 765) / r.width;
        const y = ((event.clientY - r.top) * 503) / r.height;
        return x > 4 && x < 516 && y > 4 && y < 338;
    }

    // Pinch zoom: two fingers on the world zoom the camera (Client.setCameraZoom, patch 0012). The first finger's own
    // gesture is cancelled (no tap, long-press or camera turn) and the client never sees the second one: its events stop
    // here, in the capture phase, until it lifts (and so do a third finger's while pinching).
    const pinch = {
        first: null, // { id, x, y }: a finger down on the world
        second: null, // { id, x, y } while pinching
        swallowed: new Set(),
        startDistance: 1,
        startZoom: 1,
        atLimit: false,
        saveTimer: 0
    };

    function cameraZoom() {
        const zoom = client()?.hudState?.().cameraZoom;
        return typeof zoom === 'number' ? zoom : settings.cameraZoom;
    }

    function setZoom(zoom) {
        const c = client();
        if (typeof c?.setCameraZoom !== 'function') {
            return;
        }
        const applied = c.setCameraZoom(zoom);
        const atLimit = Math.abs(applied - zoom) > 1e-3;
        if (atLimit && !pinch.atLimit) {
            haptic('light'); // the end of the zoom range
        }
        pinch.atLimit = atLimit;
        settings.cameraZoom = applied;
        clearTimeout(pinch.saveTimer);
        pinch.saveTimer = setTimeout(persistSettings, 800);
    }

    // The minimap's zoom (the HUD's slider; Client.setMinimapZoom, patch 0017): returns the zoom the client took.
    let minimapSaveTimer = 0;

    function setMinimapZoom(zoom) {
        const c = client();
        if (typeof c?.setMinimapZoom !== 'function') {
            return settings.minimapZoom;
        }
        settings.minimapZoom = c.setMinimapZoom(zoom);
        clearTimeout(minimapSaveTimer);
        minimapSaveTimer = setTimeout(persistSettings, 800);
        return settings.minimapZoom;
    }

    function initGestures() {
        const distance = () => Math.max(1, Math.hypot(pinch.first.x - pinch.second.x, pinch.first.y - pinch.second.y));

        window.addEventListener('pointerdown', event => {
            if (event.pointerType !== 'touch') {
                return;
            }
            if (event.isPrimary) {
                // a first finger: no other is down, so a pinch still recorded lost its pointerup or pointercancel (it
                // would swallow every touch from now on)
                pinch.first = null;
                pinch.second = null;
                pinch.swallowed.clear();
            }
            if (pinch.second) {
                pinch.swallowed.add(event.pointerId); // a third finger while pinching
                event.stopPropagation();
                return;
            }
            if (!onWorld(event)) {
                return;
            }
            if (pinch.first && pinch.first.id !== event.pointerId) {
                pinch.second = { id: event.pointerId, x: event.clientX, y: event.clientY };
                pinch.swallowed.add(event.pointerId);
                event.stopPropagation();
                client()?.cancelPointer?.(); // the first finger's tap / long-press / camera turn ends here
                pressRing.cancel();
                pinch.startDistance = distance();
                pinch.startZoom = cameraZoom();
                pinch.atLimit = false;
                return;
            }
            pinch.first = { id: event.pointerId, x: event.clientX, y: event.clientY };
        }, true);

        window.addEventListener('pointermove', event => {
            const finger = pinch.first?.id === event.pointerId ? pinch.first : pinch.second?.id === event.pointerId ? pinch.second : null;
            if (finger) {
                finger.x = event.clientX;
                finger.y = event.clientY;
                if (pinch.first && pinch.second) {
                    setZoom((pinch.startZoom * pinch.startDistance) / distance()); // fingers apart: closer
                }
            }
            if (pinch.swallowed.has(event.pointerId)) {
                event.stopPropagation();
            }
        }, true);

        // The pinch ends when either finger lifts. The other one stays ignored by the client until it lifts too (the
        // first since cancelPointer, the second because its events stop here); a first finger still down pinches again
        // with a new second one.
        const lift = event => {
            if (pinch.second?.id === event.pointerId) {
                pinch.second = null;
            } else if (pinch.first?.id === event.pointerId) {
                pinch.first = null;
                pinch.second = null;
            }
            if (pinch.swallowed.delete(event.pointerId)) {
                event.stopPropagation();
            }
        };
        window.addEventListener('pointerup', lift, true);
        window.addEventListener('pointercancel', lift, true);

        // desktop browsers: the mouse wheel zooms
        window.addEventListener('wheel', event => {
            if (!onWorld(event)) {
                return;
            }
            event.preventDefault();
            setZoom(cameraZoom() * Math.exp(event.deltaY * 0.0015));
        }, { passive: false });

        pressRing.init();
    }

    // A ring that fills under a finger held still on the game (world, panel, chat) until the long-press opens the
    // options menu, so a hold shows that it is working. It appears when the touch stops being a tap (TAP_MAX_MS: from
    // then on, lifting before the menu opens does nothing), so taps and drags never show it, and it gives up exactly
    // when the client's long-press does (exceedsGrabThreshold: more than TOUCH_SLOP along either axis, in the screen
    // coordinates the client reads, or the finger turned the camera, dragged or scrolled: touchMoving).
    const pressRing = {
        el: null,
        timer: 0,
        pointerId: -1,
        x: 0,
        y: 0,
        screenX: 0,
        screenY: 0,
        init() {
            this.el = document.getElementById('press-ring');
            window.addEventListener('pointerdown', event => this.start(event), true);
            window.addEventListener('pointermove', event => {
                if (event.pointerId !== this.pointerId) {
                    return;
                }
                if (Math.abs((event.screenX | 0) - this.screenX) > TOUCH_SLOP || Math.abs((event.screenY | 0) - this.screenY) > TOUCH_SLOP) {
                    this.cancel();
                } else if (!this.el.hidden && client()?.hudState?.().touchMoving === true) {
                    this.cancel(); // the camera turned (it starts at 8 px early in a touch), or a drag or scroll began
                }
            }, true);
            for (const type of ['pointerup', 'pointercancel']) {
                window.addEventListener(type, event => {
                    if (event.pointerId === this.pointerId) {
                        this.cancel();
                    }
                }, true);
            }
        },
        start(event) {
            this.cancel();
            const id = event.target?.id;
            const onGame = id === 'surface-game' || id === 'surface-side' || id === 'surface-chat' || (id === 'canvas' && client()?.ingame);
            if (event.pointerType !== 'touch' || !onGame || pinch.second || menu?.open) {
                return;
            }
            this.pointerId = event.pointerId;
            this.x = event.clientX;
            this.y = event.clientY;
            this.screenX = event.screenX | 0;
            this.screenY = event.screenY | 0;
            const delay = TAP_MAX_MS;
            this.timer = setTimeout(() => {
                if (client()?.hudState?.().longPressable === false) {
                    return; // nothing to choose there (the minimap, bare stone): a hold is just a tap
                }
                const el = this.el;
                el.style.left = `${this.x}px`;
                el.style.top = `${this.y}px`;
                el.style.setProperty('--fill-ms', `${Math.max(60, settings.longPressMs - delay)}ms`);
                el.hidden = false;
                el.classList.remove('filling');
                void el.offsetWidth; // restart the fill
                el.classList.add('filling');
            }, delay);
        },
        cancel() {
            clearTimeout(this.timer);
            this.pointerId = -1;
            if (this.el && !this.el.hidden) {
                this.el.hidden = true;
                this.el.classList.remove('filling');
            }
        }
    };

    // ------------------------------------------------------------------------------------------------ settings panel

    function parseSettingValue(raw) {
        if (raw === 'true') {
            return true;
        }
        if (raw === 'false') {
            return false;
        }
        const number = Number(raw);
        return Number.isFinite(number) && raw.trim() !== '' ? number : raw;
    }

    function refreshSettingsPanel() {
        for (const row of document.querySelectorAll('.row[data-layout]')) {
            row.hidden = row.dataset.layout !== settings.layout;
        }
        // XP drops: a category of the mobile layout's (the classic one has no HUD); its speed and style greyed out, their
        // choices kept, while XP drops are off
        document.getElementById('nav-xpdrops').hidden = settings.layout !== 'mobile';
        for (const row of document.querySelectorAll('#section-xpdrops .xp-option')) {
            row.classList.toggle('unused', settings.xpDrops === false);
            for (const button of row.querySelectorAll('.seg button')) {
                button.disabled = settings.xpDrops === false;
            }
        }
        // where the world is (Change: the worlds); online the settings of the world on this phone, the bots' chat and its
        // saved data are not this page's
        document.getElementById('world-playon-name').textContent = ONLINE ? `${SERVER.name} (${window.lcServerUrl.address(SERVER.url)})` : 'This phone';
        for (const row of document.querySelectorAll('#section-world .offline-only')) {
            row.hidden = ONLINE;
        }
        document.getElementById('world-online-note').hidden = !ONLINE;
        document.getElementById('nav-botchat').hidden = ONLINE;
        document.getElementById('nav-savedata').hidden = ONLINE;
        // saving needs a character in the world (on this phone: online the server saves); a changed world setting asks
        // for the restart that applies it
        document.getElementById('settings-save').hidden = !isInGame(client()) || ONLINE;
        const restartNeeded = !ONLINE && Object.keys(bootSettings).some(key => settings[key] !== bootSettings[key]);
        const restart = document.getElementById('settings-restart');
        restart.classList.toggle('needed', restartNeeded);
        document.getElementById('nav-world').classList.toggle('needed', restartNeeded);
        if (!restart.dataset.busy) {
            restart.textContent = restartNeeded ? 'Restart to apply' : 'Restart';
        }
        for (const group of document.querySelectorAll('.seg[data-setting]')) {
            const value = settings[group.dataset.setting];
            for (const button of group.querySelectorAll('button')) {
                button.classList.toggle('on', parseSettingValue(button.dataset.value) === value);
            }
        }
    }

    function applySettings() {
        if (settings.layout === 'classic' && !settings.showControls) {
            // their buttons are hidden now: nothing may stay switched on invisibly
            setRunToggled(false);
            setSecondaryArmed(false);
        }
        const c = client();
        if (c && typeof c.setTargetedFramerate === 'function' && c.tfps !== settings.fps) {
            c.setTargetedFramerate(settings.fps);
        }
        applyHostMenus();
        if (c && typeof c.setCameraZoom === 'function') {
            c.setCameraZoom(settings.cameraZoom);
        }
        if (c && typeof c.setMinimapZoom === 'function') {
            c.setMinimapZoom(settings.layout === 'mobile' ? settings.minimapZoom : 1); // (the classic layout has no slider)
        }
        c?.setAttackOptions?.(settings.npcAttack, settings.playerAttack);
        applyAudioSession();
        layout();
    }

    // Settings › Display › Screen margins: its rows are the sheet's (initSettingsPanel), applied at once; while it is open
    // Settings steps aside (host.css #settings.aside), so the HUD's edges show around the box. Back returns to Settings.
    const margins = {
        init() {
            document.getElementById('margins-open').addEventListener('click', () => this.show());
            document.getElementById('margins-close').addEventListener('click', () => this.close());
            onBackdropTap(document.getElementById('margins'), () => this.close());
        },

        get open() {
            return !document.getElementById('margins').hidden;
        },

        show() {
            refreshSettingsPanel();
            document.getElementById('settings').classList.add('aside');
            document.getElementById('margins').hidden = false;
        },

        close() {
            document.getElementById('margins').hidden = true;
            document.getElementById('settings').classList.remove('aside');
        }
    };

    function openSettings() {
        keyboard.hide(); // it would cover the sheet
        menu?.close();
        refreshSettingsPanel();
        document.getElementById('settings').hidden = false;
        showSettingsSection(settingsSection);
    }

    // Settings' categories (the buttons down the left): the one shown stays chosen until another is, also after Settings
    // closes. Saved data reads the save folder each time it is shown; Bot chat starts without the last Test's answer.
    let settingsSection = 'display';

    function showSettingsSection(name) {
        if (savedData.busy) {
            return; // (a delete, or the restart of Reset world or Delete everything, is under way)
        }
        if (document.getElementById(`nav-${name}`)?.hidden) {
            name = 'display'; // (the last category shown is not offered now: XP drops in the classic layout)
        }
        const pane = document.getElementById('settings-pane');
        if (name !== settingsSection) {
            pane.scrollTop = 0;
        }
        settingsSection = name;
        for (const button of document.querySelectorAll('.settings-nav button')) {
            const on = button.dataset.section === name;
            button.classList.toggle('on', on);
            button.setAttribute('aria-selected', String(on));
        }
        for (const section of pane.querySelectorAll('.settings-section')) {
            section.hidden = section.id !== `section-${name}`;
        }
        if (name === 'savedata') {
            void savedData.show();
        } else if (name === 'botchat') {
            botChat.show();
        }
    }

    function openWorldMap() {
        keyboard.hide(); // it would cover the sheet
        menu?.close();
        worldMap?.open();
    }

    function showHowToPlay() {
        document.getElementById('howto').hidden = false;
        if (!settings.seenHowToPlay) {
            settings.seenHowToPlay = true;
            persistSettings();
        }
    }

    function closeSettings() {
        if (savedData.busy) {
            return;
        }
        margins.close();
        document.getElementById('settings').hidden = true;
    }

    // Reloading ends the engine, and with it any save that could not be written yet (the engine keeps those in memory
    // and retries): the characters', and the bots' (their store, Documents/bots/<profile>/bots.sav). So a failed save of
    // either stops the restart; tapping Restart again within 10 s restarts anyway.
    let restartAnywayUntil = 0;

    async function restartGame(button = null) {
        if (await savedBeforeLeaving(button)) {
            location.reload();
        }
    }

    // The world on this phone is left (Restart, a switch to a game server): true once it is saved, or when a save that
    // failed is to be left anyway (the same request again within 10 s); false: stop, the status line says why.
    async function savedBeforeLeaving(button = null) {
        const reply = await lifecycle('save').catch(() => null);
        const botsFailed = !!reply?.ok && reply.bots?.ok === false;
        if (engineState === 'ready' && (!reply?.ok || botsFailed) && performance.now() > restartAnywayUntil) {
            restartAnywayUntil = performance.now() + 10000;
            // (with no button to say it, the notice says a second tap goes ahead)
            const again = button ? '' : ' Tap again to go on anyway.';
            if (botsFailed) {
                warnBotsNotSaved(reply.bots.error, again);
            } else {
                warnSaveFailed(reply?.error, again);
            }
            if (button) {
                button.dataset.busy = '1';
                button.textContent = botsFailed ? 'Bots not saved: tap again to restart anyway' : 'Could not save: tap again to restart anyway';
                setTimeout(() => {
                    delete button.dataset.busy;
                    refreshSettingsPanel();
                }, 10000);
            }
            return false;
        }
        return true;
    }

    function warnSaveFailed(error, more = '') {
        console.warn('[host] save failed:', error);
        haptic('error');
        showNotice(`Your progress could not be saved. ${T.storageFull}${more}`, 8000);
    }

    // The character was saved, the bots were not (the engine keeps their saves and tries again).
    function warnBotsNotSaved(error, more = '') {
        console.warn('[host] the bots could not be saved:', error);
        haptic('error');
        showNotice(`The bots could not be saved. ${T.storageFull}${more}`, 8000);
    }

    // After a save: the character's failing first, else the bots'.
    function warnIfNotSaved(reply) {
        if (!reply?.ok) {
            warnSaveFailed(reply?.error);
        } else if (reply.bots?.ok === false) {
            warnBotsNotSaved(reply.bots.error);
        }
    }

    // ------------------------------------------------------------------------------------------------ saved data

    // Settings › Saved data: the characters (players/<profile>/<name>.sav) with a Delete each, the world (the bots' store
    // bots/<profile>/bots.sav: the bots, the ones that quit, the characters' friend lists) with Reset world, and Delete
    // everything; each asks first (confirmBox). Native keeps a deleted file as <file>.bak until that file is saved again,
    // so a mistake can still be undone by hand in the Files app.
    //  - A character is deleted by the engine (its delete message): it may hold a newer save of it in memory, which would
    //    bring the character back. The one in the world cannot be deleted.
    //  - The world, and everything, go with a restart: the world is paused and saved (the characters' saves must be
    //    written, as for Restart, or nothing is deleted), the engine is stopped so that nothing writes a save again, the
    //    files are deleted, and the page reloads.
    const BOTS_STORE = `bots/${PROFILE}/bots.sav`;

    const savedData = {
        characters: [], // characterSaves()
        store: null, // the bots' store in the index ({ path, modified }), or null
        bots: null, // what it holds ({ bots, quit }), or null if it cannot be read as one
        busy: false,

        init() {
            document.getElementById('savedata-reset').addEventListener('click', () => void this.resetWorld());
            document.getElementById('savedata-everything').addEventListener('click', () => void this.deleteEverything());
        },

        // (showSettingsSection)
        async show() {
            this.message(null);
            this.render(); // (the last list at once, the save folder's as soon as it is read)
            await this.refresh();
        },

        async refresh() {
            const files = await saveIndex();
            this.characters = characterSaves(files);
            this.store = files.find(f => f.path === BOTS_STORE) ?? null;
            this.bots = this.store ? await readBotsSummary() : null;
            this.render();
        },

        render() {
            const list = document.getElementById('savedata-characters');
            list.textContent = '';
            const c = client();
            const playing = isInGame(c) ? safeName(c.loginUser) : null;
            for (const save of this.characters) {
                const inWorld = save.safe === playing;
                const row = dataRow(save.name, inWorld ? 'In the world now: log out to delete' : lastPlayed(save.modified), 'Delete', () => void this.deleteCharacter(save));
                row.querySelector('button').disabled = this.busy || inWorld;
                list.append(row);
            }
            if (!this.characters.length) {
                list.append(dataRow('None yet', 'Log in with any name to make one'));
            }

            let bots;
            if (this.store) {
                const saved = `saved ${daysAgo(Number(this.store.modified) || 0)}`;
                bots = this.bots ? `${this.bots.bots} bot${this.bots.bots === 1 ? '' : 's'}${this.bots.quit ? `, ${this.bots.quit} quit` : ''} · ${saved}` : `Saved ${daysAgo(Number(this.store.modified) || 0)}`;
            } else {
                bots = bootSettings.bots > 0 && !botsOff ? 'None saved yet' : 'None: Bots are Off';
            }
            document.getElementById('savedata-bots').textContent = bots;
            document.getElementById('savedata-reset').disabled = this.busy || !this.store;
            document.getElementById('savedata-everything').disabled = this.busy || (!this.characters.length && !this.store);
            document.getElementById('savedata-where').textContent = isNative ? T.savedataWhere : 'A deleted save stays in the test server\'s save folder as a .bak file until it is saved over.';
        },

        message(text) {
            const el = document.getElementById('savedata-message');
            el.hidden = !text;
            el.textContent = text ?? '';
        },

        async deleteCharacter(save) {
            const where = isNative ? T.whereShort : 'in the save folder';
            const ok = await confirmBox({
                title: `Delete ${save.name}?`,
                text: `${save.name}'s levels, items, bank and quests will be gone. Logging in as ${save.name} again makes a new character.\n\nThe old save stays ${where} as ${save.safe}.sav.bak until a new ${save.name} is saved.`,
                action: 'Delete'
            });
            if (!ok) {
                return;
            }
            this.busy = true;
            this.message(null);
            this.render();
            const reply = await deleteCharacterSave(save.safe);
            this.busy = false;
            if (reply.ok) {
                haptic('success');
                console.log(`[host] deleted the character ${save.safe}`);
            } else {
                haptic('error');
                console.warn(`[host] could not delete the character ${save.safe}: ${reply.error}`);
                this.message(reply.error === 'in-world' ? `${save.name} is in the world: log out first.` : `${save.name} could not be deleted. ${T.storageFull}`);
            }
            await this.refresh();
            void titleScreen.refresh();
        },

        async resetWorld() {
            const where = isNative ? T.whereShort : 'in the save folder';
            const ok = await confirmBox({
                title: 'Reset the world?',
                text: `The bots start over, as in a new world. Your characters are kept, but their friend and ignore lists are emptied.\n\nThe game restarts. The old world stays ${where} as bots.sav.bak until the new one is saved.`,
                action: 'Reset world'
            });
            if (ok) {
                await this.wipe(false, 'The world was reset.');
            }
        },

        async deleteEverything() {
            const n = this.characters.length;
            const who = n === 0 ? 'The bots' : `${n === 1 ? 'Your character' : `All ${n} characters`}${this.store ? ' and the bots' : ''}`;
            const rest = isNative ? 'the app\'s log and the recent :: commands' : 'the recent :: commands';
            const ok = await confirmBox({
                title: 'Delete everything?',
                text: `${who} will be gone, as before the first launch, and so will ${rest}. Your settings are kept.\n\nThe game restarts. The old saves stay ${isNative ? T.whereShort : 'in the save folder'} as .bak files until they are saved over.`,
                action: 'Delete everything'
            });
            if (ok) {
                await this.wipe(true, 'Everything was deleted.');
            }
        },

        // Deletes the bots' store (everything: and every character) and restarts. Reset world keeps the characters, so
        // their saves must be written first, else nothing happens; for Delete everything the save only makes the .bak
        // files the newest.
        async wipe(everything, done) {
            this.busy = true;
            this.message('Saving…');
            this.render();
            const reply = await lifecycle('pause'); // (saves everything and stops the world's clock)
            if (!everything && engineState === 'ready' && !reply.ok) {
                void lifecycle('resume');
                this.busy = false;
                haptic('error');
                this.message(`Your character could not be saved, so nothing was deleted. ${T.storageFull}`);
                this.render();
                return;
            }
            this.message('Restarting…');
            stopEngine();
            // (the files as they are now: that save may have written a new one, a new character's or the bots' first)
            const paths = everything ? [...characterSaves(await saveIndex()).map(save => save.path), BOTS_STORE] : [BOTS_STORE];
            let failed = await deleteSaves(paths);
            if (failed.length === 0) {
                // a write the engine had already started may land after the delete: once more for anything still there
                const left = new Set((await saveIndex()).map(f => f.path));
                failed = await deleteSaves(paths.filter(path => left.has(path)));
            }
            if (everything) {
                // (2026-10-27) and the rest the game kept: the :: commands and amounts typed lately, and the app's log
                // (native starts it again, empty; the lines below are its first)
                for (const key of [HISTORY_KEY, AMOUNTS_KEY]) {
                    try {
                        localStorage.removeItem(key);
                    } catch {
                        // storage unavailable: nothing was kept there either
                    }
                }
                postNative({ type: 'clear-log' });
            }
            if (failed.length) {
                console.error(`[host] Saved data: could not delete ${failed.join(', ')}`);
            } else if (everything) {
                // (no names: the new log keeps nothing of the characters)
                const n = paths.length - 1; // (the characters' saves, then the bots' store)
                console.log(`[host] Saved data: deleted everything (${n} character${n === 1 ? '' : 's'}, the bots, the :: commands${isNative ? ', the log' : ''})`);
            } else {
                console.log(`[host] Saved data: deleted ${paths.join(', ') || 'nothing'}`);
            }
            try {
                sessionStorage.setItem(NOTICE_KEY, failed.length ? 'Some saved data could not be deleted. Try again in Settings > Saved data.' : done);
            } catch {
                // no notice then
            }
            location.reload();
        }
    };

    // A row of the Saved data sheet: a name, a detail line under it, a button (or none).
    function dataRow(name, detail, action = null, onClick = null) {
        const row = document.createElement('div');
        row.className = 'data-row';
        row.innerHTML = '<span class="data-text"><span class="data-name"></span><span class="data-detail"></span></span>';
        row.querySelector('.data-name').textContent = name;
        row.querySelector('.data-detail').textContent = detail;
        if (action) {
            const button = document.createElement('button');
            button.className = 'data-btn';
            button.textContent = action;
            button.addEventListener('click', onClick);
            row.append(button);
        }
        return row;
    }

    // A character's save, through the engine while the world runs (ok, or error: 'in-world' or why not).
    async function deleteCharacterSave(safe) {
        if (engine && engineState === 'ready') {
            return engineCall({ type: 'delete', name: safe }, 4000);
        }
        const failed = await deleteSaves([`players/${PROFILE}/${safe}.sav`]);
        return failed.length ? { ok: false, error: 'the delete failed' } : { ok: true };
    }

    // DELETE save/<path> for each (gone already is fine); returns the paths that failed.
    async function deleteSaves(paths) {
        const failed = [];
        for (const path of paths) {
            const response = await fetch(`save/${path}`, { method: 'DELETE' }).catch(() => null);
            if (!response || (!response.ok && response.status !== 404)) {
                failed.push(path);
            }
        }
        return failed;
    }

    // What the bots' store holds (docs/BOTS.md §4.5: "LCBOTS01", a count, then { name, save } records, one of them
    // "_meta"): { bots, quit }, or null if it is not one.
    async function readBotsSummary() {
        try {
            const response = await fetch(`save/${BOTS_STORE}`);
            if (!response.ok) {
                return null;
            }
            const data = new Uint8Array(await response.arrayBuffer());
            const view = new DataView(data.buffer);
            if (data.length < 10 || String.fromCharCode(...data.subarray(0, 8)) !== 'LCBOTS01') {
                return null;
            }
            let bots = 0;
            let quit = 0;
            let p = 10;
            for (let i = view.getUint16(8); i > 0; i--) {
                const length = data[p];
                const name = String.fromCharCode(...data.subarray(p + 1, p + 1 + length));
                const size = view.getUint32(p + 1 + length); // (throws past the end: not a store)
                p += 1 + length + 4;
                if (name === '_meta') {
                    const meta = JSON.parse(new TextDecoder().decode(data.subarray(p, p + size)));
                    quit = Array.isArray(meta?.quit) ? meta.quit.length : 0;
                } else if (!name.startsWith('_')) {
                    bots++;
                }
                p += size;
            }
            return p === data.length ? { bots, quit } : null;
        } catch {
            return null;
        }
    }

    // ------------------------------------------------------------------------------------------------ the bots' chat model

    // The bots' chat model (docs/ARCHITECTURE.md §7.1; the engine's half: docs/BOTS.md §4.1). The bots' engine asks for a
    // reply's words ({type:'bots-lm', id, mode, local, online, maxChars, timeoutMs}); the page hands the request to native
    // ({type:'lm', ...}, with the player's Think first as think: the engine never hears of it) and native's answer back to
    // the engine ({type:'bots-lm-reply', id, text, source, error?, ms}: ms from the page's send). With no native app, or
    // with Settings › Bot chat on Rules, or with the chosen model not there, the page answers null 'unavailable' at once.
    // The engine hears the player's choice and what is there ({type:'bots-lm-mode', mode, local, online}) before its world
    // starts and on every change. Only the bots' engine gets any of these: with the bots off the engine is the plain one
    // (engine.js) and never hears a word of it.
    const LM_TEST_PROMPT = Object.freeze({
        system: 'You are a player of RuneScape in late 2004, typing into the game\'s chat box. Answer with one short chat line as players typed then: mostly lowercase, no quotes, at most 80 characters.',
        context: '',
        user: 'Your friend Zezima says: yo whats up'
    });
    // lm.warm: a load under this is quick (about 1.3 s on an iPhone 13 mini, 1.2-1.8 s on the Android emulator; the first
    // one with Metal's shaders still to prepare about 15 s); a chat start's warm-up is asked again after this at most
    const LM_QUICK_LOAD_MS = 5000;
    const LM_CHAT_WARM_MS = 10000;
    // lm.notice: what the player reads in the chat when the model in the app rests for memory and when it is back (game
    // messages: each within the chatbox's 459 px of the p12 font, which clips them; e2e.mjs measures them)
    const LM_REST_LINES = Object.freeze(['Warning: low memory. The on-device chat model is off for 10+ minutes.', 'Bots use scripted replies. Fewer bots (Settings > World) helps.']);
    const LM_BACK_LINES = Object.freeze(['The on-device chat model is back on.']);
    // (a notice on entering the world waits a moment: the player is then in the engine's world)
    const LM_NOTICE_LOGIN_MS = 2000;

    function lmStatusOf(raw) {
        const local = raw?.local ?? {};
        const online = raw?.online ?? {};
        return {
            local: {
                available: local.available === true,
                loaded: local.loaded === true,
                name: typeof local.name === 'string' ? local.name : null,
                bytes: Number(local.bytes) || 0,
                reason: typeof local.reason === 'string' ? local.reason : null,
                // whether the model writes a short note before its reply: 'never', 'always', or 'option' (the request's
                // think decides: Settings › Bot chat › Think first)
                think: ['never', 'always', 'option'].includes(local.think) ? local.think : 'never',
                // how long its last load took on this install, app version and system version (ms), or null: none yet
                lastLoadMs: Number(local.lastLoadMs) > 0 ? Number(local.lastLoadMs) : null,
                // 'memory': it rests, the phone having run short of memory (native's BotChatModel.memoryRest: 10 min,
                // then until the phone is not under memory pressure); null: it does not
                rest: local.rest === 'memory' ? 'memory' : null
            },
            online: {
                keySet: online.keySet === true,
                hint: typeof online.hint === 'string' ? online.hint : null,
                valid: typeof online.valid === 'boolean' ? online.valid : null,
                problem: typeof online.problem === 'string' ? online.problem : null
            }
        };
    }

    const lm = {
        status: lmStatusOf(window.LostCityNative?.lm),
        engineBots: false, // the engine runs the bots (engine-bots.js): the only one that asks
        chatWarmAt: -Infinity, // when a chat start last asked native to load the model (warm)
        restTold: false, // the player was told in this world session that the model rests (lm.notice)
        noticeTimer: 0,
        pending: new Map(), // id -> { sent, timer }: requests native has not answered yet
        testSeq: 0,
        tests: new Map(), // (negative ids) the Bot chat page's Test -> resolve

        // (bots ideas, round 4: I model) Bots' own talk can be the model's: the on-device model is in the app and a chat
        // model is chosen (not Rules); its requests always go to the on-device model (the engine's ambientAvailable)
        ambientUsable() {
            return this.status.local.available && settings.botChat !== 'rules';
        },

        // whether the chosen backend, or its fallback, is there (the engine's own test: port/BotModel modelAvailable)
        usable(mode) {
            if (mode === 'local') {
                return this.status.local.available;
            }
            return mode === 'online' && (this.status.online.keySet || this.status.local.available);
        },

        sendMode() {
            if (!this.engineBots || !engine || engineState === 'dead' || engineState === 'stopped') {
                return;
            }
            // (while the model in the app rests for memory the engine hears there is none: the rules' lines, no requests)
            // (bots ideas, round 4: I model: ambient, Bots' own talk as Model where it can be used)
            engine.postMessage({ type: 'bots-lm-mode', mode: settings.botChat, local: this.status.local.available && !this.status.local.rest, online: this.status.online.keySet, ambient: settings.botAmbient === 'model' && this.ambientUsable() });
        },

        // Whether the bots in this world talk with the model in the app (On-device, or Claude online with no key, which
        // then answers with it), as warm() decides.
        usesLocal() {
            const mode = settings.botChat;
            return isNative && this.engineBots && this.status.local.available && (mode === 'local' || (mode === 'online' && !this.status.online.keySet));
        },

        // The model in the app rests for memory (status local.rest) or is back: the player reads it once in the chat, as
        // game messages through the engine (runtime/bots/page.ts), while in the world with bots that talk with it. The
        // rest is told when it starts, or on entering the world while it lasts (after LM_NOTICE_LOGIN_MS); its end only
        // to a player who was told it started in this world session.
        notice(delay = 0) {
            clearTimeout(this.noticeTimer);
            if (delay > 0) {
                this.noticeTimer = setTimeout(() => this.notice(), delay);
                return;
            }
            const inWorld = this.usesLocal() && isInGame(client()) && engine && engineState !== 'dead' && engineState !== 'stopped';
            let lines = null;
            if (this.status.local.rest && !this.restTold && inWorld) {
                this.restTold = true;
                lines = LM_REST_LINES;
            } else if (!this.status.local.rest && this.restTold) {
                this.restTold = false;
                lines = inWorld ? LM_BACK_LINES : null;
            }
            if (lines) {
                engine.postMessage({ type: 'bots-lm-notice', lines: [...lines] });
            }
        },

        // Leaving the world: a rest still on is told again at the next login.
        leftWorld() {
            clearTimeout(this.noticeTimer);
            this.restTold = false;
        },

        // In the world with the bots and the model in the app chosen (or Claude online with no key, which then answers with
        // it): native loads it in the background (about 1 s), so the first reply does not wait for it. (With a key Claude
        // answers; the model in the app is only its fallback, loaded if needed.)
        // - 'chat': the player starts to type something a bot may answer (startsToChat): the model loads then, if it is
        //   not in memory (a warm-up of a loaded model would only put its idle unload off).
        // - 'world': entering the world, or choosing the model there: only until a load here has been quick (the status's
        //   lastLoadMs under LM_QUICK_LOAD_MS). The first load after an install, an app update or a system update takes
        //   about 15 s on an iPhone, while Metal prepares the model's shaders: that one starts as soon as it can.
        warm(on) {
            const mode = settings.botChat;
            const uses = mode === 'local' || (mode === 'online' && !this.status.online.keySet);
            if (!isNative || !this.engineBots || !this.status.local.available || !uses || !isInGame(client()) || this.status.local.rest) {
                return;
            }
            if (on === 'chat') {
                // (asked once while it loads: every key would ask again)
                if (this.status.local.loaded || performance.now() - this.chatWarmAt < LM_CHAT_WARM_MS) {
                    return;
                }
                this.chatWarmAt = performance.now();
            } else if (this.status.local.lastLoadMs !== null && this.status.local.lastLoadMs < LM_QUICK_LOAD_MS) {
                return;
            }
            postNative({ type: 'lm-warm' });
        },

        toEngine(reply) {
            if (engine && engineState !== 'dead' && engineState !== 'stopped') {
                engine.postMessage({ type: 'bots-lm-reply', ...reply });
            }
        },

        // engine -> page
        request(msg) {
            const id = Number(msg?.id);
            if (!Number.isInteger(id) || id < 0) {
                return;
            }
            // (bots ideas, round 4: I model) a line of the bots' own talk (msg.ambient): the model in the app only, while
            // Bots' own talk is Model and usable and the model does not rest; else answered 'unavailable' at once
            const ambient = msg.ambient === true;
            const mode = ambient ? 'local' : settings.botChat;
            const usable = ambient ? settings.botAmbient === 'model' && this.ambientUsable() && !this.status.local.rest : this.usable(mode);
            if (!isNative || !usable) {
                this.toEngine({ id, text: null, source: null, error: 'unavailable', ms: 0 });
                return;
            }
            const timeoutMs = Math.min(30000, Math.max(1000, Number(msg.timeoutMs) || 9000));
            // (native answers within timeoutMs; a page that hears nothing a while after that answers for it)
            const timer = setTimeout(() => this.reply({ id, text: null, source: null, error: 'timeout' }), timeoutMs + 3000);
            this.pending.set(id, { sent: performance.now(), timer });
            // (think: Settings › Bot chat › Think first as it is now: the model in the app writes its note first, when it
            // is one that offers the choice; only with On-device, where the page shows it as in use: Claude online never
            // thinks, and its fallback to the model in the app answers without the note; the bots' own talk never does:
            // native refuses it when the phone is warm, while it rests and behind a reply to the human)
            postNative({ type: 'lm', id, mode, ...(ambient ? { ambient: true } : {}), think: !ambient && mode === 'local' && settings.botThink === true, local: msg.local, online: msg.online, maxChars: msg.maxChars, timeoutMs });
        },

        // native -> page (LostCityHost.bots.lmReply)
        reply(raw) {
            const id = Number(raw?.id);
            const reply = {
                id,
                text: typeof raw?.text === 'string' ? raw.text : null,
                source: raw?.source === 'local' || raw?.source === 'online' ? raw.source : null,
                ...(raw?.error ? { error: String(raw.error) } : {})
            };
            if (id < 0) {
                this.tests.get(id)?.(reply);
                this.tests.delete(id);
                return;
            }
            const pending = this.pending.get(id);
            if (!pending) {
                return; // answered already (the page's own timeout), or a request of an earlier page
            }
            clearTimeout(pending.timer);
            this.pending.delete(id);
            this.toEngine({ ...reply, ms: Math.round(performance.now() - pending.sent) });
        },

        // native -> page (LostCityHost.bots.lmStatus)
        setStatus(raw) {
            this.status = lmStatusOf(raw);
            this.sendMode();
            this.notice();
            botChat.render();
        },

        // Settings › Bot chat › Test: one line from Claude, never from the on-device model (fallback: false)
        test() {
            const id = -++this.testSeq;
            return new Promise(resolve => {
                const timer = setTimeout(() => {
                    this.tests.delete(id);
                    resolve({ id, text: null, source: null, error: 'timeout' });
                }, 15000);
                this.tests.set(id, reply => {
                    clearTimeout(timer);
                    resolve(reply);
                });
                postNative({ type: 'lm', id, mode: 'online', fallback: false, think: false, local: { system: '', user: '' }, online: { ...LM_TEST_PROMPT }, maxChars: 80, timeoutMs: 9000 });
            });
        }
    };

    // Settings › Bot chat: who writes the bots' replies to you (Rules, On-device, Claude online), the model in the app (and,
    // for a model trained both ways, Think first: its note before each reply), Bots' own talk (bots ideas, round 4: Rules
    // or Model, the model in the app wording the bots' talk near you), the Claude key (typed into native's own secure box:
    // the page never sees it, only whether one is set and how it ends), what Claude online sends, and a Test of the key. A
    // choice applies at once (the engine hears the chat model and Bots' own talk: lm.sendMode; Think first goes with each
    // request).
    const botChat = {
        el: null,
        testing: false,
        testText: null,

        init() {
            this.el = document.getElementById('section-botchat');
            document.getElementById('botchat-key-set').addEventListener('click', () => {
                haptic('selection');
                postNative({ type: 'lm-key', action: 'set' }); // (native's secure box; its result comes as a status)
            });
            document.getElementById('botchat-key-remove').addEventListener('click', () => void this.removeKey());
            document.getElementById('botchat-test').addEventListener('click', () => void this.test());
        },

        // (showSettingsSection)
        show() {
            this.testText = null;
            this.render();
        },

        render() {
            if (!this.el) {
                return;
            }
            const { local, online } = lm.status;
            const mb = bytes => `${Math.max(1, Math.round(bytes / 1048576))} MB`;
            document.getElementById('botchat-local').textContent = local.available
                ? `${local.name ?? 'In the app'} · ${mb(local.bytes)}${local.loaded ? ' · loaded' : ''}`
                : !isNative ? T.onlyInApp : Object.hasOwn(LM_REASONS, local.reason ?? '') ? LM_REASONS[local.reason] : 'Not in this build';
            // Think first: only for a model that writes its note when asked (one that always or never does has no choice);
            // greyed out, its choice kept, unless the on-device model writes the replies (lm.request: think only then)
            const think = document.getElementById('botchat-think');
            const thinkUsed = settings.botChat === 'local';
            think.hidden = local.think !== 'option';
            think.classList.toggle('unused', !thinkUsed);
            for (const button of think.querySelectorAll('.seg button')) {
                button.disabled = !thinkUsed;
            }
            document.getElementById('botchat-think-hint').textContent = thinkUsed
                ? 'The bots plan each reply first: about a second slower.'
                : 'Only with the On-device chat model.';
            // (bots ideas, round 4: I model) Bots' own talk: greyed out, its choice kept, unless the on-device model is in
            // the app and a chat model is chosen (lm.ambientUsable: its requests go to the on-device model only)
            const ambient = document.getElementById('botchat-ambient');
            const ambientUsed = lm.ambientUsable();
            ambient.classList.toggle('unused', !ambientUsed);
            for (const button of ambient.querySelectorAll('.seg button')) {
                button.disabled = !ambientUsed;
            }
            // (round 4 fixes: stage 1 words no reactions to the player; (bots ideas, round 5 ship) with stage 2's, the
            // design's "Reactions to you and talk between bots near you")
            document.getElementById('botchat-ambient-hint').textContent = ambientUsed
                ? 'Reactions to you and talk between bots near you'
                : !local.available ? (isNative ? 'Only with the on-device model.' : T.onlyInApp) : 'Only with a chat model (not Rules).';
            let key;
            if (!isNative) {
                key = T.onlyInApp;
            } else if (!online.keySet) {
                key = online.problem === 'not a key' ? 'Not set: that was not a key' : 'Not set';
            } else {
                const state = online.valid === false ? 'refused: set it again' : online.problem && online.problem !== 'not a key' ? online.problem : online.valid ? 'works' : '';
                key = `Ends in ${online.hint ?? '…'}${state ? ` · ${state}` : ''}`;
            }
            document.getElementById('botchat-key').textContent = key;
            const set = document.getElementById('botchat-key-set');
            set.textContent = online.keySet ? 'Change' : 'Set key';
            set.disabled = !isNative;
            document.getElementById('botchat-key-remove').hidden = !online.keySet;
            const test = document.getElementById('botchat-test');
            test.disabled = !isNative || !online.keySet || this.testing;
            document.getElementById('botchat-test-result').textContent = this.testText ?? (online.keySet ? 'Asks Claude for one line, to check the key' : 'Set a key first');
            for (const button of this.el.querySelectorAll('.seg[data-setting="botChat"] button')) {
                button.disabled = button.dataset.value === 'local' && !local.available && settings.botChat !== 'local';
            }
        },

        async removeKey() {
            const ok = await confirmBox({
                title: 'Remove the Claude key?',
                text: T.keyRemove,
                action: 'Remove'
            });
            if (ok) {
                postNative({ type: 'lm-key', action: 'remove' });
            }
        },

        async test() {
            if (this.testing || !isNative) {
                return;
            }
            this.testing = true;
            this.testText = 'Asking Claude...';
            this.render();
            const reply = await lm.test();
            this.testing = false;
            const why = {
                refused: lm.status.online.valid === false ? 'the key was refused' : 'Claude declined',
                timeout: 'no answer in time',
                unavailable: 'no key set',
                'failed: network': 'no connection',
                'failed: rate limited': 'rate limited, try again soon',
                'failed: overloaded': 'Claude is busy, try again soon',
                'failed: billing': 'a billing problem on the account',
                'failed: permission': 'the key may not use this model'
            };
            this.testText = reply.text ? `Claude: ${reply.text}` : `No line: ${why[reply.error] ?? reply.error ?? 'no answer'}`;
            haptic(reply.text ? 'success' : 'error');
            this.render();
        }
    };

    // Settings › About: the version line (build-info.json: the app's version, from VERSION, and the upstream commits the
    // bundle was built from), the disclaimer and credits (index.html), and Licences: licenses.txt (LICENSE and
    // THIRD_PARTY_NOTICES.md as plain text, scripts/lib/notices.mjs) in a sheet over Settings, read when first opened.
    const about = {
        text: null, // licenses.txt once read

        init() {
            document.getElementById('about-licences').addEventListener('click', () => void this.openLicences());
            document.getElementById('licences-close').addEventListener('click', () => this.closeLicences());
            onBackdropTap(document.getElementById('licences'), () => this.closeLicences());
            fetch('build-info.json')
                .then(response => (response.ok ? response.json() : null))
                .then(info => {
                    if (info?.version) {
                        document.getElementById('about-version').textContent = `2004Scape ${info.version} · Lost City 274`;
                    }
                    const commits = info ? `Engine-TS ${info.engine ?? '?'}, Content ${info.content ?? '?'}, Client-TS ${info.webclient ?? '?'}` : '?';
                    const where = ONLINE ? `Online: ${SERVER.name} (${window.lcServerUrl.hostOf(SERVER.url)})` : 'Offline';
                    document.getElementById('about').textContent = `${where}. Built from ${commits}${info?.debug ? ' (debug)' : ''}.`;
                })
                .catch(() => {});
        },

        get licencesOpen() {
            return !document.getElementById('licences').hidden;
        },

        async openLicences() {
            const view = document.getElementById('licences-text');
            document.getElementById('licences').hidden = false;
            view.scrollTop = 0;
            if (this.text === null) {
                view.textContent = 'Loading…';
                try {
                    const response = await fetch('licenses.txt');
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    this.text = await response.text();
                } catch (err) {
                    console.error('[host] licenses.txt could not be read', err);
                    view.textContent = 'The licences could not be loaded. They are in THIRD_PARTY_NOTICES.md beside the source code.';
                    return;
                }
            }
            view.textContent = this.text;
        },

        closeLicences() {
            document.getElementById('licences').hidden = true;
        }
    };

    // "Are you sure?": resolves true for the action, false for Cancel (or the cancel label given), the backdrop or Escape.
    let confirmResolve = null;

    function confirmBox({ title, text, action, cancel = 'Cancel' }) {
        closeConfirm(false);
        document.getElementById('confirm-title').textContent = title;
        document.getElementById('confirm-text').textContent = text;
        document.getElementById('confirm-ok').textContent = action;
        document.getElementById('confirm-cancel').textContent = cancel;
        document.getElementById('confirm').hidden = false;
        return new Promise(resolve => {
            confirmResolve = resolve;
        });
    }

    function closeConfirm(answer) {
        document.getElementById('confirm').hidden = true;
        const resolve = confirmResolve;
        confirmResolve = null;
        resolve?.(answer);
    }

    function initConfirm() {
        document.getElementById('confirm-cancel').addEventListener('click', () => closeConfirm(false));
        document.getElementById('confirm-ok').addEventListener('click', () => closeConfirm(true));
        onBackdropTap(document.getElementById('confirm'), () => closeConfirm(false));
    }

    // A tap on an overlay's backdrop (one that started there, not a click left over from the tap that opened it).
    function onBackdropTap(overlay, onTap) {
        let pressed = false;
        overlay.addEventListener('pointerdown', event => {
            pressed = event.target === overlay;
        });
        overlay.addEventListener('click', event => {
            if (event.target === overlay && pressed) {
                onTap();
            }
            pressed = false;
        });
    }

    function initSettingsPanel() {
        for (const group of document.querySelectorAll('.seg[data-setting]')) {
            for (const button of group.querySelectorAll('button')) {
                button.addEventListener('click', () => {
                    settings[group.dataset.setting] = parseSettingValue(button.dataset.value);
                    haptic('selection');
                    refreshSettingsPanel();
                    applySettings();
                    persistSettings();
                    if (group.dataset.setting === 'botChat') {
                        lm.sendMode(); // (at once: no restart)
                        lm.warm('world');
                        botChat.render();
                    } else if (group.dataset.setting === 'botAmbient') {
                        lm.sendMode(); // (bots ideas, round 4: I model: at once)
                    }
                });
            }
        }
        document.getElementById('settings-close').addEventListener('click', closeSettings);
        onBackdropTap(document.getElementById('settings'), closeSettings);
        document.getElementById('settings-save').addEventListener('click', async event => {
            const button = event.currentTarget;
            button.disabled = true;
            const result = await lifecycle('save').catch(() => null);
            button.textContent = result?.ok ? 'Saved' : 'Save failed';
            if (result?.ok && result.bots?.ok !== false) {
                haptic('success');
            } else {
                warnIfNotSaved(result);
            }
            setTimeout(() => {
                button.textContent = 'Save now';
                button.disabled = false;
            }, 1500);
        });
        document.getElementById('settings-restart').addEventListener('click', event => restartGame(event.currentTarget));
        for (const button of document.querySelectorAll('.settings-nav button')) {
            button.addEventListener('click', () => {
                if (button.dataset.section !== settingsSection) {
                    haptic('selection');
                }
                showSettingsSection(button.dataset.section);
            });
        }
        document.getElementById('settings-howto').addEventListener('click', () => {
            closeSettings();
            showHowToPlay();
        });
        document.getElementById('howto-ok').addEventListener('click', () => {
            document.getElementById('howto').hidden = true;
        });
    }

    // ------------------------------------------------------------------------------------------------ watcher

    let lastPhase = null;
    let windowFreeSince = 0; // when the world was last seen without a window open (see watchClient)
    // The loader gives way after LOADER_TIMEOUT_MS even if the title never reports ready (the canvas shows why). A world
    // still starting then says so in the status line, and one that has not started after ENGINE_TIMEOUT_MS has failed:
    // nothing else would report a start that hangs, and a login would wait for it forever. Both count the time the page
    // has run, so a launch the app spent suspended in the background does not time out.
    const LOADER_TIMEOUT_MS = 45000;
    const ENGINE_TIMEOUT_MS = 90000;
    let runMs = 0;
    let lastWatch = performance.now();

    // The engine autosaves every 15 minutes and the app saves whenever it leaves the foreground; this covers a crash or
    // a memory kill while playing. One save is ~1 KB written by the engine in a few ms.
    const AUTOSAVE_MS = 2 * 60 * 1000;
    let lastAutosave = performance.now();

    // While the loader shows, it is checked every LOADER_WATCH_MS as well as by the watcher, so the title shows as soon
    // as it and the world are ready (the watcher's 200 ms alone left the loader up to 200 ms longer).
    const LOADER_WATCH_MS = 50;

    function watchLoader() {
        const c = client();
        if (!c || loadingEl.hidden || loadingEl.classList.contains('fade')) {
            return;
        }
        loaderProgress.client = Math.max(loaderProgress.client, 0.5 + 0.5 * ((Number(c.lastProgressPercent) || 0) / 100));
        showLoaderProgress();
        // (a client that failed to load: its own error screen shows at once)
        if (titleReady(c) || clientFailed(c) || runMs > LOADER_TIMEOUT_MS) {
            hideLoading();
        }
    }

    function watchClient() {
        const c = client();
        if (!c) {
            return;
        }
        const now = performance.now();
        runMs += Math.min(now - lastWatch, 1000); // (a longer gap: the page was not running)
        lastWatch = now;
        if (globalThis.__LC_BZIP2__ && (Number(c.lastProgressPercent) >= 100 || clientFailed(c))) {
            delete globalThis.__LC_BZIP2__; // (the client has loaded its archives: libbzip2's instance and memory can go)
        }
        watchLoader();
        if (bootNotice && worldReady() && loadingEl.hidden) {
            showNotice(bootNotice, 6000);
            bootNotice = null;
        } else if (botsNotice && engineState === 'ready' && loadingEl.hidden && statusPillEl.hidden) {
            showNotice(botsNotice, 10000);
            botsNotice = null;
            botsNoticeShown = true;
        }
        if (engineState === 'booting' && runMs > LOADER_TIMEOUT_MS) {
            if (runMs > ENGINE_TIMEOUT_MS) {
                engine?.terminate(); // (a late 'ready' must not bring it back)
                engineFailed('The game engine did not start.');
            } else if (loadingEl.hidden && statusPillEl.hidden && !clientFailed(c)) {
                setStatusPill('The world is still starting…');
            }
        }
        const phase = isInGame(c) ? 'ingame' : 'title';
        if (phase !== lastPhase) {
            if (phase === 'ingame' && lastPhase === 'title' && !c.reconnecting) {
                haptic('success'); // logged in
                accounts.loggedIn(); // (online: the name, and its password kept or forgotten as Remember says)
            }
            lastPhase = phase;
            postNative({ type: 'status', phase });
            if (phase === 'ingame') {
                lm.warm('world'); // (the first load after an install is the slow one: lm.warm)
                lm.notice(LM_NOTICE_LOGIN_MS); // (a rest still on)
            }
            layout();
            if (phase === 'title') {
                lm.leftWorld();
                setSecondaryArmed(false);
                void titleScreen.refresh();
            }
        }
        // the keyboard button is dimmed while nothing would take what is typed (e.g. during an NPC dialogue)
        document.getElementById('btn-keyboard').classList.toggle('disabled', phase === 'ingame' && !keyboard.shown && inputContext().kind === null);
        titleScreen.update();
        accounts.watch(c);
        unreachable.check(c);
        // the first visit to the world: how to play with fingers, once the world has settled with no window open (the
        // character designer opens only a moment after logging in)
        const settled = phase === 'ingame' && c.ingame && c.mainModalId === -1 && c.sideModalId === -1 && c.chatModalId === -1;
        windowFreeSince = settled ? windowFreeSince || performance.now() : 0;
        if (!settings.seenHowToPlay && settled && performance.now() - windowFreeSince >= 1500 && worldReady() && document.getElementById('settings').hidden) {
            showHowToPlay();
        }
        if (lifecycleState === 'paused' && !ONLINE) {
            freezeClientTimers(); // a late packet may have rebased them
        }
        if (audioMuted) {
            holdAudioMuted(); // (a context the client made after native muted it)
        }
        if (runToggled && c.keyHeld && c.keyHeld[5] !== 1) {
            c.keyHeld[5] = 1; // focus changes release held keys
        }
        reassertHeldKeys();
        if (keyOfSafeArea(readSafeArea()) !== safeKey) {
            layout();
        }
        if (!hud?.active) {
            refreshRunButton(); // (the HUD keeps it current itself)
        }
        if (phase === 'ingame' && lifecycleState === 'running' && engineState === 'ready' && performance.now() - lastAutosave >= AUTOSAVE_MS) {
            lastAutosave = performance.now();
            void lifecycle('save').then(warnIfNotSaved);
        }
        if (typeof c.tfps === 'number' && c.tfps !== settings.fps && typeof c.setTargetedFramerate === 'function') {
            c.setTargetedFramerate(settings.fps);
        }
        keyboard.sync();
    }

    // ------------------------------------------------------------------------------------------------ boot

    // Settings › Sound as the app has it: no silent switch row on Android (a phone has none; native always plays,
    // docs/ANDROID.md §1 Sound), no Vibration row on a device without a vibrator (LostCityNative.haptics false: many
    // Android tablets), and no Sound category when neither is left.
    function applyPlatformRows() {
        const vibration = window.LostCityNative?.haptics !== false;
        document.getElementById('sound-row').hidden = ANDROID;
        document.getElementById('sound-note').hidden = ANDROID;
        document.getElementById('vibration-row').hidden = !vibration;
        document.getElementById('nav-sound').hidden = ANDROID && !vibration;
    }

    // Android (docs/ANDROID.md §3.3): {type:'loader-drawn'} once the page's own loader is on screen, so native can take
    // its launch cover away without a visible hand-over: the fonts loaded, the logo decoded, two frames drawn (at most
    // 0.8 s: the iOS app's loaderDrawn script, which native runs itself there after 'ready').
    async function postLoaderDrawn() {
        const drawn = (async () => {
            await document.fonts.ready;
            const logo = new Image();
            logo.src = 'ui/sprites/logo.png';
            await logo.decode().catch(() => {});
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        })();
        await Promise.race([drawn.catch(() => {}), new Promise(resolve => setTimeout(resolve, 800))]);
        postNative({ type: 'loader-drawn' });
    }

    // The client's cache (OnDemand's files: __LC_CACHE__), and libbzip2 for its jag archives while it loads
    // (__LC_BZIP2__, bzip2.js: none without WebAssembly, and the client decodes them itself). Both are there before the
    // Client is made.
    async function loadClientCache() {
        const decoder = window.__lcBzip2?.load('engine/bzip2.wasm') ?? null;
        const names = ['main_file_cache.dat', 'main_file_cache.idx0', 'main_file_cache.idx1', 'main_file_cache.idx2', 'main_file_cache.idx3', 'main_file_cache.idx4'];
        const files = await Promise.all(
            names.map(async name => {
                const response = await fetch(`cache/${name}`);
                if (!response.ok) {
                    throw new Error(`cache/${name}: HTTP ${response.status}`);
                }
                return new Uint8Array(await response.arrayBuffer());
            })
        );
        globalThis.__LC_CACHE__ = { dat: files[0], idx: files.slice(1) };
        const bzip2 = await decoder;
        if (bzip2) {
            globalThis.__LC_BZIP2__ = bzip2;
        }
    }

    // What boot starts first, before the page builds its own controls: the world's boot in its worker, the client's
    // cache and client.js, so they load while the page lays itself out (client.js reads __LC_CACHE__ only once the Client
    // exists; the worker's messages wait for boot's first await, after all of the page's init). Null on a browser without
    // the iterator helpers the engine needs (boot says so, with nothing started); else { engineError } when the worker
    // could not be made, or { cache, client } to await (their failures are reported there).
    function startLoading() {
        if (ONLINE) {
            // the client alone (its cache is LocalOnDemand's checked copy of the server's files, docs/ONLINE.md), and
            // the server's /crc once, for the words of a 502 (unreachable.check); no engine, so no iterator helpers needed
            const cache = loadClientCache();
            const clientModule = import('./client/client.js');
            cache.catch(() => {});
            clientModule.catch(() => {});
            return { cache, client: clientModule };
        }
        if (typeof Iterator !== 'function' || typeof Iterator.prototype?.map !== 'function') {
            return null;
        }
        try {
            startEngine();
        } catch (err) {
            return { engineError: err };
        }
        const cache = loadClientCache();
        const clientModule = import('./client/client.js');
        cache.catch(() => {});
        clientModule.catch(() => {});
        return { cache, client: clientModule };
    }

    async function boot() {
        loadingEl = document.getElementById('loading');
        statusPillEl = document.getElementById('status-pill');
        if (ANDROID) {
            // native's launch cover draws the bar at the 6 % this loader starts from (LoadingCover.kt, as the iPhone's
            // LoadingOverlay): the page's fill starts there too, without growing from 0 behind the cover, so the cover's
            // hand-over to the page changes no pixel of the bar (iOS keeps its own start)
            const fill = document.getElementById('loading-fill');
            fill.style.transition = 'none';
            setLoading(null, 0.06);
            void fill.offsetWidth;
            fill.style.transition = '';
        }
        checkStoredSettings();
        bootSettings = { members: settings.members, xpRate: settings.xpRate, lowMemory: settings.lowMemory, bots: settings.bots, jmod: settings.jmod };
        const loading = startLoading();
        try {
            worldMap = window.__lcWorldMap?.init({ client, haptic, bindTapButton }) ?? null;
        } catch (err) {
            console.error('[host] the World map failed to start', err);
            worldMap = null;
        }
        try {
            hud = window.__lcHud?.init({
                client,
                settings,
                online: ONLINE, // (Report abuse in the chat bar)
                haptic,
                bindTapButton,
                setMinimapZoom,
                openWorldMap: worldMap ? openWorldMap : null,
                isRunHeld: () => runToggled,
                battery: () => battery,
                keyboard: () => ({
                    overlap: keyboardOverlap,
                    duration: keyboardAnimation,
                    curve: keyboardCurve,
                    kind: keyboard.shown ? keyboard.context?.kind ?? null : null,
                    // something is being typed: the software keyboard is up, or a hardware one was used just now
                    typing: keyboard.shown || performance.now() - lastHardwareTyping < 15000
                })
            }) ?? null;
        } catch (err) {
            console.error('[host] the HUD failed to start; using the classic layout', err);
            hud = null;
        }
        try {
            menu = window.__lcMenu?.init({ client, haptic, safeArea: readSafeArea, zoom: () => uiZoom }) ?? null;
        } catch (err) {
            console.error('[host] the options menu failed to start; the client draws its own', err);
            menu = null;
        }
        initControls();
        initGestures();
        initSettingsPanel();
        applyPlatformRows();
        savedData.init();
        botChat.init();
        initConfirm();
        about.init();
        margins.init();
        titleScreen.init();
        accounts.init();
        servers.init();
        unreachable.init();
        if (ONLINE) {
            checkServer();
        }
        layout();
        window.addEventListener('resize', layout);
        window.addEventListener('orientationchange', () => setTimeout(layout, 50));
        applyAudioSession();
        postNative({ type: 'ready' });
        postNative({ type: 'status', phase: 'booting' });
        if (ANDROID) {
            void postLoaderDrawn();
        }

        showLoaderProgress();
        // The engine's scripts use the iterator helpers (Chrome 122, Safari 18.4): an older WebView would fail somewhere
        // inside the world's start, so say plainly what to update instead (native checks the version too, on Android
        // before it loads the page). startLoading started nothing then.
        if (!loading) {
            const version = /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? null;
            console.error(`[host] no iterator helpers (${navigator.userAgent}): the engine cannot run here`);
            showError(isNative ? T.tooOld(version) : 'This browser is too old for the game: it needs JavaScript\'s iterator helpers (Chrome 122, Safari 18.4 or later).');
            postNative({ type: 'status', phase: 'error', detail: 'webview too old' });
            return;
        }
        if (loading.engineError) {
            engineFailed(`The game engine could not be started.\n${loading.engineError?.message ?? loading.engineError}`);
            return;
        }

        try {
            await loading.cache;
            loaderProgress.client = 0.25;
            showLoaderProgress();
            const { Client } = await loading.client;
            audioIdle.install(); // (client.js has made its AudioContext: nothing has played on it yet)
            loaderProgress.client = 0.4;
            showLoaderProgress();
            // (online the server's world: its node id names it in the friends list, its members flag the items' names)
            window.__client = ONLINE ? new Client(SERVER.nodeId, bootSettings.lowMemory, SERVER.members) : new Client(NODE_ID, bootSettings.lowMemory, bootSettings.members);
            if (ONLINE) {
                useOnlineWords(window.__client);
            }
        } catch (err) {
            console.error('[host] client failed to load', err);
            showError(`The game client failed to load.\n${err?.message ?? err}`);
            return;
        }

        applySettings();
        setInterval(watchClient, 200);
        const loaderWatch = setInterval(() => {
            if (loadingEl.hidden || loadingEl.classList.contains('fade')) {
                clearInterval(loaderWatch);
                return;
            }
            watchLoader();
        }, LOADER_WATCH_MS);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
    } else {
        void boot();
    }
})();
