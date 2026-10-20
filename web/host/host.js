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
            tooOld: () => 'This iPhone\'s iOS is too old for the game (iOS 18.4 or later is needed). Update it in Settings > General > Software Update, then open the game again.'
        },
        android: {
            charactersWhere: 'Saved on this phone: Files > 2004Scape > players',
            savedataWhere: 'A deleted save stays in Files > 2004Scape as a .bak file until it is saved over.',
            whereShort: 'in Files',
            storageFull: 'Is the phone\'s storage full?',
            onlyInApp: 'Only in the app',
            keyRemove: 'It is deleted from this phone. Claude online then answers with the on-device model, or with the rules.',
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
        showControls: true, // classic layout: the side rails
        largeMenus: true, // the options menu for fingers (menu.js) instead of the drawn 2004 one
        // Settings › Display › Screen margins: Side, Top and Bottom (CSS px, readSafeArea): -1 None (the HUD up to
        // the glass edge, over a notch or camera hole), 0 Auto (the phone's safe area), 16 or 32 more than Auto
        safeSides: 0,
        safeTop: 0,
        safeBottom: 0,
        longPressMs: 400,
        cameraSensitivity: 1,
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
        botThink: BOT_THINK_DEFAULT
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
        return merged; // (checked against the Settings sheet at boot: checkStoredSettings)
    }

    const settings = loadSettings();
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
        if (corrected) {
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
    let engineState = 'booting'; // 'booting' | 'ready' | 'dead' | 'stopped' (Saved data's restarts: stopEngine)
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

    window.WebSocket = EngineSocket;

    // ------------------------------------------------------------------------------------------------ client access

    const client = () => window.__client ?? null;

    // The mobile HUD (hud.js), once booted; null in the classic layout's absence of it (e.g. hud.js failed to load).
    let hud = null;
    // The options menu for fingers (menu.js), once booted; null if it failed to load (the client then draws its own).
    let menu = null;
    // The World map window (worldmap.js), once booted; null if it failed to load (the HUD then has no World map button).
    let worldMap = null;

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
                return { kind: 'login-pass', prompt: message ?? 'Password', text: '*'.repeat(c.loginPass?.length ?? 0), secure: true, numeric: false, maxLength: 20, charset: 'game' };
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
                if (isNative) {
                    postNative({ type: 'keyboard', action: 'show', ...next });
                }
                return;
            }
            const chips = JSON.stringify(next.chips ?? null);
            if (next.text !== prev.text || next.prompt !== prev.prompt || chips !== JSON.stringify(prev.chips ?? null)) {
                this.context = next;
                if (isNative) {
                    // (chips too: the recent commands and amounts change as they are used)
                    postNative({ type: 'keyboard', action: 'update', prompt: next.prompt, text: next.text, chips: next.chips ?? [] });
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
        // name), so an empty one is filled in.
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
        // 'ingame', 'menu-open', 'menu-close' (the client already gives haptic feedback for a long-press), 'action-label'.
        onClientEvent(name, detail) {
            if (name === 'ingame') {
                // switch between the title canvas and the HUD in the same frame as the client
                layout();
                menu?.hideLabel();
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

    function setAudioMuted(muted) {
        audioMuted = muted === true;
        try {
            holdAudioMuted();
            if (!audioMuted) {
                resumeAudio();
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
                    freezeClientTimers();
                }
                const reply = await engineRequest('pause', 4000);
                return lifecycleResult(reply);
            }
            case 'foreground':
            case 'resume': {
                lifecycleState = 'running';
                thawClientTimers();
                resumeAudio();
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
        return !!c && (c.ingame || (c.titleFlames && c.lastProgressPercent === 100)) && engineState === 'ready';
    }

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
                if (this.saves[0]) {
                    this.login(this.saves[0].name);
                }
            });
            bindTapButton(document.getElementById('btn-characters'), () => this.openList());
            document.getElementById('characters-close').addEventListener('click', () => this.closeList());
            onBackdropTap(document.getElementById('characters'), () => this.closeList());
        },

        // the saved characters, from the save folder's index
        async refresh() {
            this.saves = characterSaves(await saveIndex());
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
            const show = !!this.frame && !this.frame.inGame && this.loaded && c?.loginscreen === 0 && !c.ingame && !c.reconnecting && engineState === 'ready' && !!loadingEl?.hidden && !clientFailed(c);
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
            const first = this.saves[0];
            document.getElementById('btn-continue').hidden = !first;
            document.getElementById('btn-characters').hidden = this.saves.length < 2;
            document.getElementById('title-hint').hidden = !!first;
            if (first) {
                document.getElementById('continue-name').textContent = first.name;
            }
        },

        login(name) {
            const c = client();
            if (!c || c.ingame || engineState !== 'ready') {
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
    // options menu, so a hold shows that it is working. It appears only after a short hold, so taps and drags never
    // show it, and it gives up exactly when the client's long-press does (exceedsGrabThreshold: more than TOUCH_SLOP
    // along either axis, in the screen coordinates the client reads).
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
                if (event.pointerId === this.pointerId && (Math.abs((event.screenX | 0) - this.screenX) > TOUCH_SLOP || Math.abs((event.screenY | 0) - this.screenY) > TOUCH_SLOP)) {
                    this.cancel();
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
            const delay = 140;
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
        // saving needs a character in the world; a changed world setting asks for the restart that applies it
        document.getElementById('settings-save').hidden = !isInGame(client());
        const restartNeeded = Object.keys(bootSettings).some(key => settings[key] !== bootSettings[key]);
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
        const reply = await lifecycle('save').catch(() => null);
        const botsFailed = !!reply?.ok && reply.bots?.ok === false;
        if (engineState === 'ready' && (!reply?.ok || botsFailed) && performance.now() > restartAnywayUntil) {
            restartAnywayUntil = performance.now() + 10000;
            if (botsFailed) {
                warnBotsNotSaved(reply.bots.error);
            } else {
                warnSaveFailed(reply?.error);
            }
            if (button) {
                button.dataset.busy = '1';
                button.textContent = botsFailed ? 'Bots not saved: tap again to restart anyway' : 'Could not save: tap again to restart anyway';
                setTimeout(() => {
                    delete button.dataset.busy;
                    refreshSettingsPanel();
                }, 10000);
            }
            return;
        }
        location.reload();
    }

    function warnSaveFailed(error) {
        console.warn('[host] save failed:', error);
        haptic('error');
        showNotice(`Your progress could not be saved. ${T.storageFull}`, 8000);
    }

    // The character was saved, the bots were not (the engine keeps their saves and tries again).
    function warnBotsNotSaved(error) {
        console.warn('[host] the bots could not be saved:', error);
        haptic('error');
        showNotice(`The bots could not be saved. ${T.storageFull}`, 8000);
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
            const ok = await confirmBox({
                title: 'Delete everything?',
                text: `${who} will be gone, as before the first launch. Your settings are kept.\n\nThe game restarts. The old saves stay ${isNative ? T.whereShort : 'in the save folder'} as .bak files until they are saved over.`,
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
            if (failed.length) {
                console.error(`[host] Saved data: could not delete ${failed.join(', ')}`);
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
                think: ['never', 'always', 'option'].includes(local.think) ? local.think : 'never'
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
        pending: new Map(), // id -> { sent, timer }: requests native has not answered yet
        testSeq: 0,
        tests: new Map(), // (negative ids) the Bot chat page's Test -> resolve

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
            engine.postMessage({ type: 'bots-lm-mode', mode: settings.botChat, local: this.status.local.available, online: this.status.online.keySet });
        },

        // In the world with the bots and the model in the app chosen (or Claude online with no key, which then answers with
        // it): native loads it now, in the background (about 1 s; once after an install, about 15 s), so the first reply
        // does not wait for it. (With a key Claude answers; the model in the app is only its fallback, loaded if needed.)
        warm() {
            const mode = settings.botChat;
            const uses = mode === 'local' || (mode === 'online' && !this.status.online.keySet);
            if (isNative && this.engineBots && this.status.local.available && uses && isInGame(client())) {
                postNative({ type: 'lm-warm' });
            }
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
            const mode = settings.botChat;
            if (!isNative || !this.usable(mode)) {
                this.toEngine({ id, text: null, source: null, error: 'unavailable', ms: 0 });
                return;
            }
            const timeoutMs = Math.min(30000, Math.max(1000, Number(msg.timeoutMs) || 9000));
            // (native answers within timeoutMs; a page that hears nothing a while after that answers for it)
            const timer = setTimeout(() => this.reply({ id, text: null, source: null, error: 'timeout' }), timeoutMs + 3000);
            this.pending.set(id, { sent: performance.now(), timer });
            // (think: Settings › Bot chat › Think first as it is now: the model in the app writes its note first, when it
            // is one that offers the choice; only with On-device, where the page shows it as in use: Claude online never
            // thinks, and its fallback to the model in the app answers without the note)
            postNative({ type: 'lm', id, mode, think: mode === 'local' && settings.botThink === true, local: msg.local, online: msg.online, maxChars: msg.maxChars, timeoutMs });
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
    // for a model trained both ways, Think first: its note before each reply), the Claude key (typed into native's own
    // secure box: the page never sees it, only whether one is set and how it ends), what Claude online sends, and a Test of
    // the key. A choice applies at once (the engine hears the chat model: lm.sendMode; Think first goes with each request).
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
                    document.getElementById('about').textContent = `Offline. Built from ${commits}${info?.debug ? ' (debug)' : ''}.`;
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

    // "Are you sure?": resolves true for the action, false for Cancel, the backdrop or Escape.
    let confirmResolve = null;

    function confirmBox({ title, text, action }) {
        closeConfirm(false);
        document.getElementById('confirm-title').textContent = title;
        document.getElementById('confirm-text').textContent = text;
        document.getElementById('confirm-ok').textContent = action;
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
                        lm.warm();
                        botChat.render();
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

    function watchClient() {
        const c = client();
        if (!c) {
            return;
        }
        const now = performance.now();
        runMs += Math.min(now - lastWatch, 1000); // (a longer gap: the page was not running)
        lastWatch = now;
        if (!loadingEl.hidden && !loadingEl.classList.contains('fade')) {
            loaderProgress.client = Math.max(loaderProgress.client, 0.5 + 0.5 * ((Number(c.lastProgressPercent) || 0) / 100));
            showLoaderProgress();
            // (a client that failed to load: its own error screen shows at once)
            if (titleReady(c) || clientFailed(c) || runMs > LOADER_TIMEOUT_MS) {
                hideLoading();
            }
        }
        if (bootNotice && engineState === 'ready' && loadingEl.hidden) {
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
            }
            lastPhase = phase;
            postNative({ type: 'status', phase });
            if (phase === 'ingame') {
                lm.warm(); // (the first reply need not wait for the model's load)
            }
            layout();
            if (phase === 'title') {
                setSecondaryArmed(false);
                void titleScreen.refresh();
            }
        }
        // the keyboard button is dimmed while nothing would take what is typed (e.g. during an NPC dialogue)
        document.getElementById('btn-keyboard').classList.toggle('disabled', phase === 'ingame' && !keyboard.shown && inputContext().kind === null);
        titleScreen.update();
        // the first visit to the world: how to play with fingers, once the world has settled with no window open (the
        // character designer opens only a moment after logging in)
        const settled = phase === 'ingame' && c.ingame && c.mainModalId === -1 && c.sideModalId === -1 && c.chatModalId === -1;
        windowFreeSince = settled ? windowFreeSince || performance.now() : 0;
        if (!settings.seenHowToPlay && settled && performance.now() - windowFreeSince >= 1500 && engineState === 'ready' && document.getElementById('settings').hidden) {
            showHowToPlay();
        }
        if (lifecycleState === 'paused') {
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

    async function loadClientCache() {
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
                haptic,
                bindTapButton,
                setMinimapZoom,
                openWorldMap: worldMap ? openWorldMap : null,
                isRunHeld: () => runToggled,
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
        // before it loads the page).
        if (typeof Iterator !== 'function' || typeof Iterator.prototype?.map !== 'function') {
            const version = /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? null;
            console.error(`[host] no iterator helpers (${navigator.userAgent}): the engine cannot run here`);
            showError(isNative ? T.tooOld(version) : 'This browser is too old for the game: it needs JavaScript\'s iterator helpers (Chrome 122, Safari 18.4 or later).');
            postNative({ type: 'status', phase: 'error', detail: 'webview too old' });
            return;
        }
        try {
            startEngine();
        } catch (err) {
            engineFailed(`The game engine could not be started.\n${err?.message ?? err}`);
            return;
        }

        try {
            await loadClientCache();
            loaderProgress.client = 0.25;
            showLoaderProgress();
            const { Client } = await import('./client/client.js');
            loaderProgress.client = 0.4;
            showLoaderProgress();
            window.__client = new Client(NODE_ID, bootSettings.lowMemory, bootSettings.members);
        } catch (err) {
            console.error('[host] client failed to load', err);
            showError(`The game client failed to load.\n${err?.message ?? err}`);
            return;
        }

        applySettings();
        setInterval(watchClient, 200);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
    } else {
        void boot();
    }
})();
