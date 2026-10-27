// In-app test run, injected into build/Game by `scripts/build-web.mjs --autotest` (never part of a normal build)
// and driven by web/test/app-test.mjs on the simulator or the iPhone (on Android by the app's driver in android/test/,
// docs/ANDROID.md §2: the page's own writes then use the header transport, writeBody).
//
// Runs the real game in the real app: boot → native keyboard login → walk → save → background/foreground →
// dropped connection → reload → re-login restores the saved position. With `app-test --bots N` (autotest.json in the
// test build: {"bots": N}) it first makes the page's Bots setting N (stored natively, then one restart), and after the
// login goes to where the bots start and checks what the player sees of them and what they cost (frame rate, the
// engine's tick as the page sees it, memory, save and pause times), that the save puts them in bots/main/bots.sav
// (the native save store), and after the reload that the title lists no bot; the rest of the run plays among them. At
// the end it sets the Bots setting back to what the app had before the run (if the run changed it).
// Results and requests for the driver (screenshots, backgrounding, memory samples) go out as console lines, which
// the native console bridge forwards to the app's stdout:
//   LCTEST PASS|FAIL <check> — <detail>
//   LCTEST INFO <text>
//   LCTEST SHOT <name>                  driver takes a screenshot
//   LCTEST ACTION background <seconds>  driver opens Settings, waits, brings the app back
//   LCTEST ACTION measure <label>       driver samples the app's memory
//   LCTEST INFO lm-bench {...}          (app-test --lm-bench) a sample of the on-device chat model's bench, every 10 s
//   LCTEST INFO lm-bench-summary {...}  its summary per phase, before the gate's PASS/FAIL lines
//   LCTEST DONE pass=<n> fail=<m>
// With app-test --server (autotest.json {online: …}: below, "online mode") the run plays on a game server instead:
//   LCTEST ACTION kill-webcontent       driver kills the app's WebContent process (the simulator; on Android the page
//                                       crashes its renderer itself through the DEBUG hook renderer-crash)
//   LCTEST ACTION server stop           (app-test --engine) driver stops the local engine
//   LCTEST ACTION server start drift    (app-test --engine) driver starts the content-drift copy
//   LCTEST ACTION relaunch              driver launches the app again (the next step comes from localStorage)
// With app-test --soak (a soak of web/test/perf/, sent at launch: below, "soak") the run measures phases instead of the
// checks after the login:
//   LCTEST INFO soak-startup {...}      this launch's start-up marks
//   LCTEST ACTION relaunch [{...}]      (a start-up series) the driver launches the app again, with the next number
//                                       and the settings to set back at the end (restoreBots), which a launch forgets
//   LCTEST INFO soak-phase-start <name> <epoch ms>
//   LCTEST ACTION soak <name>.<set> <seconds> <set>   driver records the window (xctrace on the iPhone, samples elsewhere)
//   LCTEST INFO soak-summary {...}      a phase's numbers; soak-raw {...} its frame and tick samples
//   LCTEST INFO <kind>-part <id> <i>/<n> <text>   a line longer than the console's 16,000 characters, in parts
(() => {
    'use strict';

    const USER = 'autotest';
    // the save profile the run plays in (app-test --profile: players/<profile>/, bots/<profile>/; host.js PROFILE)
    const PROFILE = typeof window.__lcTestProfile === 'string' ? window.__lcTestProfile : 'main';
    const STATE_KEY = 'lctest.state';
    const BOTS_KEY = 'lctest.bots'; // the Bots setting this run restarted the page for
    const BOTS_BEFORE_KEY = 'lctest.botsBefore'; // {bots, jmod}: the settings the app had before this run changed them
    const SOAK_KEY = 'lctest.soak'; // the soak's phase while it runs (a page that comes back with it set was reloaded)
    // (the app's handler as host.js picks it: WKWebView's on iOS, the Android app's bridge there: docs/ANDROID.md §3.1)
    const native = (window.webkit?.messageHandlers ?? window.LostCityNativeBridge)?.native ?? null;

    // ---- the engine worker's messages, seen by a wrapper around the page's Worker (this script runs before host.js
    // starts the engine on DOMContentLoaded): what the page asks for (init), what the engine says it loaded (booted,
    // ready), its error lines, and when its data arrives (in game: one message per tick, at the end of the tick)
    // (and for a soak: when the worker was made and the world's start began, the engine's 'lctest-perf' answers)
    const engine = { init: null, booted: null, ready: null, errors: [], arrivals: [], worker: null, createdAt: null, startAt: null, perfWaiters: new Map() };
    const PageWorker = window.Worker;
    window.Worker = class extends PageWorker {
        constructor(...args) {
            super(...args);
            engine.worker = this;
            engine.createdAt = performance.now();
            this.addEventListener('message', event => {
                const msg = event.data;
                if (msg?.type === 'data') {
                    engine.arrivals.push(performance.now());
                    if (engine.arrivals.length > 4096) {
                        engine.arrivals.splice(0, 2048);
                    }
                } else if (msg?.type === 'booted' || msg?.type === 'ready') {
                    engine[msg.type] = { ...msg, at: performance.now() };
                } else if (msg?.type === 'progress' && msg.stage === 'start' && engine.startAt === null) {
                    engine.startAt = performance.now();
                } else if (msg?.type === 'lctest-perf') {
                    engine.perfWaiters.get(msg.reqId)?.(msg);
                    engine.perfWaiters.delete(msg.reqId);
                } else if (msg?.type === 'log' && msg.level === 'error') {
                    engine.errors.push(String(msg.text).slice(0, 300));
                }
            });
        }
        postMessage(...args) {
            if (args[0]?.type === 'init') {
                engine.init = JSON.parse(JSON.stringify(args[0]));
            }
            return super.postMessage(...args);
        }
    };

    // When host.js makes the client (window.__client), for a soak's start-up marks: the first assignment turns this into
    // a plain property again and notes the time; nothing else changes.
    const clientMade = { at: null, hooks: [] };
    Object.defineProperty(window, '__client', {
        configurable: true,
        enumerable: true,
        get: () => undefined,
        set(value) {
            Object.defineProperty(window, '__client', { value, writable: true, configurable: true, enumerable: true });
            clientMade.at = performance.now();
            for (const hook of clientMade.hooks) {
                hook(value);
            }
        }
    });

    // A count of bots the Settings sheet does not offer (app-test --bots 75) is added to its Bots row before host.js
    // checks the stored settings against the sheet, which would take the nearest count it offers.
    document.addEventListener('readystatechange', () => {
        const row = document.readyState === 'interactive' ? document.querySelector('.seg[data-setting="bots"]') : null;
        let stored = window.LostCityNative?.settings?.bots;
        if (row && stored === undefined) {
            try {
                stored = JSON.parse(localStorage.getItem('lostcity.settings') ?? 'null')?.bots;
            } catch {
                stored = undefined;
            }
        }
        if (row && Number.isInteger(stored) && stored > 0 && ![...row.querySelectorAll('button')].some(button => Number(button.dataset.value) === stored)) {
            const button = document.createElement('button');
            button.dataset.value = String(stored);
            button.textContent = String(stored);
            row.append(button);
        }
    });

    const out = line => console.log(`LCTEST ${line}`);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    let pass = 0;
    let fail = 0;

    function check(name, ok, detail = '') {
        if (ok) {
            pass++;
        } else {
            fail++;
        }
        out(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
        return ok;
    }

    async function waitFor(fn, timeoutMs, intervalMs = 100) {
        const started = performance.now();
        while (performance.now() - started < timeoutMs) {
            try {
                const value = fn();
                if (value) {
                    return { ok: true, ms: Math.round(performance.now() - started), value };
                }
            } catch {
                // client not constructed yet
            }
            await sleep(intervalMs);
        }
        return { ok: false, ms: Math.round(performance.now() - started) };
    }

    // ---- native DEBUG channel (GameViewController.handleDebug)
    let debugId = 0;
    const debugWaiters = new Map();
    window.__lcDebugReply = (id, value) => {
        debugWaiters.get(id)?.(value);
        debugWaiters.delete(id);
    };

    function debug(action, extra = {}) {
        if (!native) {
            return Promise.resolve(undefined);
        }
        return new Promise(resolve => {
            const id = ++debugId;
            debugWaiters.set(id, resolve);
            native.postMessage({ type: 'debug', id, action, ...extra });
            setTimeout(() => {
                if (debugWaiters.delete(id)) {
                    resolve(undefined);
                }
            }, 5000);
        });
    }

    // What the driver launched the app with (app-test --soak; the DEBUG builds' launch-test action: the iOS launch argument
    // -LostCityTest, Android's launch extra lostcity.test): base64 of {soak, launch, clean}, or null (a run without one).
    // Asked at once, before the client exists, so that a soak's start-up marks see it made (soak, below).
    let launchTest = null;
    const launchTestRead = (async () => {
        const raw = await debug('launch-test');
        if (typeof raw !== 'string' || !raw) {
            return null;
        }
        try {
            launchTest = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), ch => ch.charCodeAt(0))));
        } catch (error) {
            out(`INFO soak: the launch's test argument is not base64 JSON (${error})`);
            return null;
        }
        if (launchTest?.soak) {
            trackStartup();
        }
        return launchTest;
    })();

    // ---- driver requests are fire-and-forget (the driver cannot reach the page); the page waits for their effects
    async function shot(name) {
        out(`SHOT ${name}`);
        await sleep(1200);
    }

    // ---- game helpers
    const c = () => window.__client;

    function clickGame(x, y, button = 1) {
        const client = c();
        if (client.ingame && typeof client.tapAt === 'function') {
            client.tapAt(x, y, button); // moves the pointer there and rebuilds the minimenu first, like a real tap
            return;
        }
        client.nextMouseClickX = x;
        client.nextMouseClickY = y;
        client.nextMouseClickTime = performance.now();
        client.nextMouseClickButton = button;
    }

    function tapElement(element) {
        const rect = element.getBoundingClientRect();
        const init = {
            pointerId: 1, // (the mouse's id, always an active pointer: setPointerCapture on another unknown id throws)
            pointerType: 'touch',
            isPrimary: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: 1
        };
        element.dispatchEvent(new PointerEvent('pointerdown', init));
        element.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
    }

    function position() {
        const client = c();
        const p = client?.localPlayer;
        return p ? [client.mapBuildBaseX + (p.x >> 7), client.mapBuildBaseZ + (p.z >> 7), client.minusedlevel] : null;
    }

    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    async function stablePosition(ms = 2000, timeoutMs = 20000) {
        let last = position();
        let since = performance.now();
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
            await sleep(200);
            const now = position();
            if (!same(now, last)) {
                last = now;
                since = performance.now();
            } else if (performance.now() - since >= ms) {
                return now;
            }
        }
        return position();
    }

    const lifecycleEvents = [];

    function recordLifecycle() {
        const host = window.LostCityHost;
        if (!host || host.__lctestWrapped) {
            return;
        }
        const original = host.lifecycle;
        host.lifecycle = event => {
            const at = performance.now();
            lifecycleEvents.push({ event, at: Math.round(at) });
            out(`INFO lifecycle ${event}`);
            const reply = original(event);
            // (how long native waits: a pause saves every character, the bots too, before the app may be suspended)
            Promise.resolve(reply).then(r => out(`INFO lifecycle ${event} answered in ${Math.round(performance.now() - at)} ms (ok ${r?.ok})`), () => {});
            return reply;
        };
        host.__lctestWrapped = true;
    }

    async function keyboardState() {
        return (await debug('keyboard-state')) ?? {};
    }

    async function login(password) {
        const title = await waitFor(() => c()?.lastProgressPercent === 100 && c()?.titleFlames && window.LostCityHost?.engineState === 'ready', 120000);
        check('title screen and world ready', title.ok, `${Math.round(performance.now())} ms after navigation`);
        if (!title.ok) {
            return false;
        }
        await sleep(500);

        clickGame(462, 291); // "Existing User"
        const form = await waitFor(() => c().loginscreen === 2, 5000);
        check('login form opens', form.ok);

        // the native keyboard comes up by itself for the username
        const shown = await waitFor(() => window.lcHost.keyboard.isShown(), 3000);
        await sleep(600); // keyboard animation
        let kb = await keyboardState();
        check('the login form brings up the native keyboard by itself', shown.ok && kb.requested === true && kb.isFirstResponder === true && kb.kind === 'login-user', JSON.stringify({ requested: kb.requested, kind: kb.kind, visible: kb.softwareKeyboardVisible }));
        await shot(`login-keyboard-${password?.length ?? 0}`);

        await debug('type', { text: USER });
        await waitFor(() => c().loginUser === USER, 3000);
        if (password !== null) {
            clickGame(360, 273); // the password field (optional offline)
            const pass = await waitFor(() => c().loginSelect === 1, 3000);
            await sleep(400);
            kb = await keyboardState();
            check('a tap on the password field moves the keyboard to it (masked)', pass.ok && kb.kind === 'login-pass' && kb.secure === true, JSON.stringify({ user: c().loginUser, kind: kb.kind, secure: kb.secure }));
            await debug('type', { text: password });
            await waitFor(() => c().loginPass === password, 3000);
        }
        await debug('bar', { button: 'submit' });
        const ingame = await waitFor(() => c().ingame === true && position() !== null, 30000);
        check(password === null ? 'the username\'s "Log in" key logs in with just a name' : '"Log in" key logs in', ingame.ok, `${ingame.ms} ms, message '${c().loginMes1} ${c().loginMes2}'`);
        if (!ingame.ok) {
            return false;
        }
        await sleep(1500);
        kb = await keyboardState();
        check('keyboard hides after login', !window.lcHost.keyboard.isShown() && kb.requested === false, JSON.stringify({ requested: kb.requested }));
        return true;
    }

    function saveIndex() {
        return fetch('save-index', { cache: 'no-store' })
            .then(r => r.json())
            .then(list => (Array.isArray(list) ? list : (list.files ?? list.entries ?? [])))
            .catch(() => []);
    }

    function saveIndexEntry(path = `players/${PROFILE}/${USER}.sav`) {
        return saveIndex().then(list => list.find(e => e.path === path) ?? null);
    }

    // The names in the bots' store (bots/main/bots.sav: "LCBOTS01", u16 count, count × {u8 length, name, u32 length,
    // save}; the "_meta" record is not a bot), through the save route; null if there is none.
    async function botStoreNames() {
        try {
            const response = await fetch(`save/bots/${PROFILE}/bots.sav`, { cache: 'no-store' });
            if (!response.ok) {
                return null;
            }
            const data = new Uint8Array(await response.arrayBuffer());
            const view = new DataView(data.buffer);
            if (data.length < 10 || String.fromCharCode(...data.subarray(0, 8)) !== 'LCBOTS01') {
                return null;
            }
            const names = [];
            let pos = 10;
            for (let i = view.getUint16(8); i > 0 && pos < data.length; i--) {
                const end = pos + 1 + data[pos];
                names.push(String.fromCharCode(...data.subarray(pos + 1, end)));
                pos = end + 4 + view.getUint32(end);
            }
            return names.filter(name => !name.startsWith('_')); // "_meta" is the store's own record, not a bot
        } catch {
            return null;
        }
    }

    // a name as the title shows it ("Mr Jones") -> as the saves keep it ("mr_jones")
    const safeName = name => String(name).trim().toLowerCase().replace(/[\s\u00a0]+/g, '_');

    async function fpsOver(ms) {
        const samples = [];
        const end = performance.now() + ms;
        while (performance.now() < end) {
            await sleep(1000);
            samples.push(c().fps);
        }
        return Math.round(samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length));
    }

    // The engine's tick as the page sees it: in game the engine's output for a tick arrives as one message at the end of
    // the tick, and ticks start at a steady period (600 ms plus the worker's timer lateness: World.cycle's drift
    // compensation only engages a whole tick behind, so in a Chrome worker it is ~608 ms). The intervals show missed or
    // stalled ticks; how late each message is against that period (from the most punctual one) estimates how much
    // longer a tick took than the quickest.
    function tickTiming(sinceMs) {
        const times = engine.arrivals.filter(t => t >= sinceMs);
        if (times.length < 5) {
            return null;
        }
        const pick = (list, q) => {
            const sorted = [...list].sort((a, b) => a - b);
            return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
        };
        const intervals = times.slice(1).map((t, i) => t - times[i]);
        const period = [...intervals].sort((a, b) => a - b)[intervals.length >> 1];
        const offsets = times.map(t => t - times[0] - period * Math.round((t - times[0]) / period));
        const late = offsets.map(offset => offset - Math.min(...offsets));
        return {
            ticks: times.length,
            seconds: Math.round((times.at(-1) - times[0]) / 100) / 10,
            intervalMs: { median: Math.round(period), avg: Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length), p95: pick(intervals, 0.95), max: pick(intervals, 1) },
            lateMs: { p50: pick(late, 0.5), p95: pick(late, 0.95), max: pick(late, 1) }
        };
    }

    // ---- bots (app-test --bots N)

    // What autotest.json in the test build asks for: a number of bots, or null (no file: the setting stays as it is).
    let autotestConfig = null;

    async function readConfig() {
        autotestConfig ??= await fetch('autotest.json', { cache: 'no-store' })
            .then(r => (r.ok ? r.json() : null))
            .catch(() => null);
        return autotestConfig;
    }

    async function wantedBots() {
        const soakBots = (await launchTestRead)?.soak?.bots;
        if (Number.isInteger(soakBots) && soakBots >= 0) {
            return soakBots; // (app-test --soak: the soak's count, which --bots can set)
        }
        const config = await readConfig();
        const count = Number(config?.bots);
        return config && Number.isInteger(count) && count >= 0 ? count : null;
    }

    // The page applies its Bots setting at boot (Settings › World › Bots, kept natively), so the run stores the count it
    // wants and restarts once. False: the page is restarting.
    async function applyBots(wanted) {
        const current = window.LostCityHost?.settings?.bots;
        let restarted = false;
        try {
            restarted = sessionStorage.getItem(BOTS_KEY) !== null;
            sessionStorage.removeItem(BOTS_KEY);
        } catch {
            // no sessionStorage: no restart either (see below)
        }
        settingsRestart = restarted;
        if (wanted === null) {
            if (current > 0) {
                out(`INFO the app runs ${current} bots (its own setting: 500 by default; app-test --bots 0 turns them off)`);
            }
            // the bots' checks teleport with ::tele, which needs Jmod: with the app's bots and Jmod Off (both the
            // defaults) the run keeps the bots and turns Jmod on, as it does for --bots (and sets it back at the end)
            if (!(current > 0 && window.LostCityHost?.settings?.jmod === false) && !restarted) {
                return true;
            }
            wanted = current;
        }
        const name = `bots: the page asks the engine for ${wanted ? `${wanted} bots` : 'none'} (Settings › World › Bots${restarted ? ', set by a restart' : ''} → init config.bots.count)`;
        // the bots' checks teleport the character with ::tele: with Settings › World › Jmod Off the run turns it on too (a
        // soak too: its phases teleport and set the game's options with :: commands)
        const jmodOff = (wanted > 0 || !!launchTest?.soak) && window.LostCityHost?.settings?.jmod === false;
        if ((current !== wanted || jmodOff) && !restarted) {
            const values = { bots: wanted, ...(jmodOff ? { jmod: true } : {}) };
            try {
                sessionStorage.setItem(BOTS_KEY, String(wanted));
                // (set back at the end; a soak's later launch has what the first one changed)
                sessionStorage.setItem(BOTS_BEFORE_KEY, JSON.stringify(launchTest?.before ?? { bots: Number.isInteger(current) ? current : 0, ...(jmodOff ? { jmod: false } : {}) }));
            } catch {
                check(name, false, `the setting is ${current}, and without sessionStorage the run cannot restart to change it`);
                return true;
            }
            out(`INFO bots: the page has ${current}${jmodOff ? ' and Jmod Off' : ''}, the run wants ${wanted}${jmodOff ? ' and Jmod On' : ''}: storing the settings and restarting`);
            if (native) {
                native.postMessage({ type: 'settings', values }); // (native merges it into what it keeps)
                const stored = await debug('settings'); // (answered after native stored it and renewed LostCityNative)
                if (stored?.bots !== wanted) {
                    out(`INFO bots: native keeps ${JSON.stringify(stored?.bots)}`);
                }
            } else {
                try {
                    const stored = JSON.parse(localStorage.getItem('lostcity.settings') ?? 'null');
                    localStorage.setItem('lostcity.settings', JSON.stringify({ ...(stored && typeof stored === 'object' ? stored : {}), ...values }));
                } catch {
                    // the check after the restart says so
                }
            }
            location.reload();
            return false;
        }
        check(name, current === wanted && engine.init?.config?.bots?.count === wanted, JSON.stringify({ setting: current, config: engine.init?.config?.bots ?? null }));
        return true;
    }

    // The other players the client draws (rev 274 Client: players[playerIds[i]] for i < playerCount, drawn once their
    // appearance has come), sampled every 500 ms until one is drawn (or timeoutMs), then settleMs more: bots walk in and
    // out of view.
    async function watchPlayers(timeoutMs, settleMs) {
        const started = performance.now();
        const seen = { firstMs: null, most: 0, names: new Set() };
        while (performance.now() - started < (seen.firstMs === null ? timeoutMs : seen.firstMs + settleMs)) {
            const client = c();
            const names = [];
            for (let i = 0; i < (client?.playerCount ?? 0); i++) {
                const player = client.players?.[client.playerIds?.[i]];
                if (player?.ready) {
                    names.push(player.name);
                }
            }
            names.forEach(name => seen.names.add(name));
            seen.most = Math.max(seen.most, names.length);
            if (names.length > 0 && seen.firstMs === null) {
                seen.firstMs = Math.round(performance.now() - started);
            }
            await sleep(500);
        }
        return seen;
    }

    const describeCrowd = seen => (seen.firstMs === null ? 'none drawn' : `the first drawn after ${seen.firstMs} ms, at most ${seen.most} at once: ${[...seen.names].slice(0, 10).join(', ')}`);

    // On Tutorial Island a game message waits in the chatbox for a tap, and chat takes no typing meanwhile.
    async function dismissTutorialMessage() {
        for (let i = 0; i < 3 && c().tutComMessage; i++) {
            clickGame(c().viewportX + 400, c().viewportY + 60);
            await sleep(400);
        }
    }

    // With bots: to where they start, what the player sees of them, and what they cost with them in view.
    async function botsChecks(count) {
        const booted = engine.booted;
        check(`bots: the engine loads its bots bundle for ${count} bots`, booted?.bundle === 'engine-bots.js' && booted.bots === count, JSON.stringify({ bundle: booted?.bundle ?? null, bots: booted?.bots ?? null, files: booted?.files, evalMs: Math.round(booted?.evalMs ?? -1), worldStartMs: Math.round(engine.ready?.ms ?? -1) }));
        // In a world the bots have played in for a while they are all over the map (about a sixth around Lumbridge), and
        // a fresh one's go off to their banks. The vendors spread over the trade banks, but Varrock West, the 2004 hub,
        // keeps two (the bots' port/BotTradeSpots, on both world types), and the bots online keep every planner group's
        // share: the character watches there (the run turned Jmod on for ::tele: applyBots)
        await dismissTutorialMessage();
        window.LostCityHost.keyboard.insertText('::tele 0,49,53,49,44\n');
        const there = await waitFor(() => same(position(), [3185, 3436, 0]), 10000);
        // (a fresh world fills at 5 bots a tick, those near the human first: the human is on Tutorial Island, so
        // Varrock West's come late; 1000 take about 2 minutes, so the watch is 60 s up to 500 and grows with the count)
        const crowd = await watchPlayers(Math.max(60000, count * 120), 5000);
        await shot('bots');
        check('bots: other players are drawn around the player', there.ok && crowd.firstMs !== null, `${there.ok ? '' : `the teleport did not arrive (${JSON.stringify(position())}); `}${describeCrowd(crowd)}`);

        const from = performance.now();
        const fps = await fpsOver(20000);
        const timing = tickTiming(from);
        out(`INFO bots: ${fps} fps over 20 s among ${count} bots; the engine's tick as the page sees it: ${JSON.stringify(timing)}`);
        check(`bots: the world keeps ticking with ${count} bots (20 s: 25+ ticks, none 1.8 s apart, p95 under 300 ms late)`, !!timing && timing.ticks >= 25 && timing.intervalMs.max < 1800 && timing.lateMs.p95 < 300, JSON.stringify(timing));
        out('ACTION measure bots');
        const at = performance.now();
        const saved = await window.LostCityHost.lifecycle('save');
        out(`INFO bots: saving the character and the bots answered in ${Math.round(performance.now() - at)} ms (ok ${saved?.ok}, bots ${JSON.stringify(saved?.bots ?? null)})`);
        // the bots' saves in their own store, through the native save store (Documents/bots/main/bots.sav)
        const store = await saveIndexEntry(`bots/${PROFILE}/bots.sav`);
        const names = await botStoreNames();
        check(`bots: the save writes the bots to bots/${PROFILE}/bots.sav (/save-index lists it; the reply says they were saved)`, saved?.ok === true && saved.bots?.ok === true && store?.size > 10 && names?.length > 0, JSON.stringify({ reply: saved, entry: store, bots: names?.length ?? null }));
        check('bots: no engine error lines', engine.errors.length === 0, engine.errors.slice(0, 3).join(' | '));
    }

    // After the reload, on the title: "Continue as" and the Characters list name the human characters only
    // (players/main/*.sav), never a bot of bots/main/bots.sav (a name both have is a human's: a human took that bot's name).
    async function titleChecks() {
        const shown = await waitFor(() => !document.getElementById('title-actions')?.hidden, 20000);
        const names = [];
        if (!document.getElementById('btn-continue').hidden) {
            names.push(document.getElementById('continue-name').textContent);
        }
        let listed = null;
        if (!document.getElementById('btn-characters').hidden) {
            tapElement(document.getElementById('btn-characters'));
            const open = await waitFor(() => !document.getElementById('characters').hidden, 3000);
            listed = open.ok ? [...document.querySelectorAll('#characters-list .character-name')].map(n => n.textContent) : null;
            await shot('bots-characters');
            document.getElementById('characters-close').click();
            names.push(...(listed ?? []));
        }
        const humans = new Set(
            (await saveIndex())
                .map(e => e.path)
                .filter(p => typeof p === 'string' && p.startsWith(`players/${PROFILE}/`) && /^players\/[^/]+\/[^/]+\.sav$/.test(p))
                .map(p => p.slice(`players/${PROFILE}/`.length, -4))
        );
        const bots = (await botStoreNames()) ?? [];
        const botsOnly = new Set(bots.filter(name => !humans.has(name)));
        const shownNames = names.map(safeName);
        const ok = shown.ok && shownNames.length > 0 && shownNames.every(name => humans.has(name) && !botsOnly.has(name)) && botsOnly.size > 0;
        check('bots: the title ("Continue as", Characters) lists only human characters, no bot', ok, JSON.stringify({ continueAs: names[0] ?? null, listed, humans: humans.size, botsInStore: bots.length }));
    }

    // What applyBots changed, as it was before ({bots, jmod?}, or a number from an older run), or null: kept in the page's
    // sessionStorage, which a soak's next launch does not have, so the driver hands it on (ACTION relaunch, launchTest).
    function settingsBefore() {
        try {
            const saved = JSON.parse(sessionStorage.getItem(BOTS_BEFORE_KEY) ?? 'null');
            if (saved !== null) {
                return saved;
            }
        } catch {
            // no sessionStorage
        }
        return launchTest?.before ?? null;
    }

    // The Bots setting as it was before the run changed it (applyBots), stored natively again; the page that runs now
    // keeps its own until it restarts. Nothing if the run did not change it.
    async function restoreBots() {
        const saved = settingsBefore();
        try {
            sessionStorage.removeItem(BOTS_BEFORE_KEY);
        } catch {
            // ignore
        }
        const before = Number.isInteger(saved) ? saved : saved?.bots; // (a number: from a run before Jmod was restored too)
        if (!Number.isInteger(before)) {
            return;
        }
        const values = { bots: before, ...(saved?.jmod === false ? { jmod: false } : {}) };
        const said = `the Bots setting${values.jmod === false ? ' and Jmod Off' : ''}`;
        if (native) {
            native.postMessage({ type: 'settings', values });
            const stored = await debug('settings');
            const back = stored?.bots === before && (values.jmod === undefined || stored?.jmod === false);
            out(`INFO bots: ${said} ${back ? 'back' : 'NOT back'} (as before the run: ${JSON.stringify(values)})${back ? '' : `: native keeps ${JSON.stringify({ bots: stored?.bots, jmod: stored?.jmod })}`}`);
        } else {
            try {
                const stored = JSON.parse(localStorage.getItem('lostcity.settings') ?? 'null');
                localStorage.setItem('lostcity.settings', JSON.stringify({ ...(stored && typeof stored === 'object' ? stored : {}), ...values }));
                out(`INFO bots: ${said} back (as before the run: ${JSON.stringify(values)})`);
            } catch {
                out(`INFO bots: could not set ${said} back`);
            }
        }
    }

    // ---- the bots' on-device chat model under load (app-test --lm-bench: the phone spike, docs/ARCHITECTURE.md §7.1)
    // With the bots running and in view (once they have all come into the world): the model's first load (cold) with one
    // reply, then three phases with the model in memory: no generation (the baseline), one reply generated every few
    // seconds (a typical reply prompt: the engine's renderLocal of real situations, web/test/lm/bench-prompts.json), then
    // replies back to back (the worst case); last, the model unloaded and loaded again (warm) for one reply. Every sample
    // (10 s) logs the client's frame rate, the engine's tick as the page sees it, the app's memory (phys_footprint,
    // os_proc_available_memory), the thermal state and the generations' timings (LCTEST INFO lm-bench {...}); at the end
    // the summary and the gate (LCTEST INFO lm-bench-summary, PASS/FAIL). The generations go to native through
    // {type:'lm-bench'} (GameViewController, DEBUG builds), the model's own queue. With config.think (app-test --lm-think)
    // every reply is written with the model's short note first, as Settings › Bot chat › Think first asks: the note's
    // tokens and time join the samples and the summary, and a check says the notes were written.
    let benchId = 0;

    function lmBench(action, extra = {}, timeoutMs = 15000) {
        if (!native) {
            return Promise.resolve(undefined);
        }
        return new Promise(resolve => {
            const id = 100000 + ++benchId; // (beside debug()'s ids: both answer through __lcDebugReply)
            debugWaiters.set(id, resolve);
            native.postMessage({ type: 'lm-bench', id, action, ...extra });
            setTimeout(() => {
                if (debugWaiters.delete(id)) {
                    resolve(undefined);
                }
            }, timeoutMs);
        });
    }

    const median = list => {
        const sorted = list.filter(Number.isFinite).sort((a, b) => a - b);
        return sorted.length ? sorted[sorted.length >> 1] : null;
    };
    const quantile = (list, q) => {
        const sorted = list.filter(Number.isFinite).sort((a, b) => a - b);
        return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
    };
    const round1 = v => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
    const THERMAL = ['nominal', 'fair', 'serious', 'critical'];

    async function lmBenchChecks(config) {
        const prompts = Array.isArray(config.prompts) ? config.prompts.filter(p => p?.system && p?.user) : [];
        const think = config.think === true; // (app-test --lm-think: the note first, with every reply)
        const phases = [
            { name: 'baseline', minutes: config.baselineMin ?? 5, every: 0 },
            { name: 'periodic', minutes: config.periodicMin ?? 20, every: config.periodicEverySec ?? 5 },
            { name: 'burst', minutes: config.burstMin ?? 5, every: -1 }
        ];
        const sampleMs = (config.sampleSec ?? 10) * 1000;
        const bots = window.LostCityHost?.settings?.bots ?? 0;
        const fillSec = config.fillSec ?? Math.round((bots / 5) * 0.6 + 30); // (5 bots join a tick once a human is in)
        if (fillSec > 0) {
            out(`INFO lm-bench: waiting ${fillSec} s for the ${bots} bots to come into the world`);
            await sleep(fillSec * 1000);
        }
        const first = await lmBench('stats');
        out(`INFO lm-bench start: ${JSON.stringify({ phases: phases.map(p => `${p.name} ${p.minutes} min`), prompts: prompts.length, think, stats: first })}`);
        if (!first || !prompts.length) {
            check('lm-bench: the native bench answers and has prompts', false, JSON.stringify({ stats: first ?? null, prompts: prompts.length }));
            return;
        }
        // (the model stays in memory through the phases: its idle unload, 5 min, would come in the baseline)
        out(`INFO lm-bench options: ${JSON.stringify(await lmBench('options', { ...(config.options ?? {}), idleSec: 3600 }))}`);
        // the first load, cold (after an install, as after a reboot), with one reply: no deadline for this one
        const cold = await lmBench('generate', { system: prompts[0].system, user: prompts[0].user, think, timeoutMs: 120000 }, 130000);
        const coldStats = await lmBench('stats');
        out(`INFO lm-bench cold load: ${JSON.stringify({ load: coldStats?.lastLoad ?? null, reply: cold?.text ?? null, note: cold?.note ?? null, error: cold?.error ?? null, timings: cold?.timings ?? null })}`);
        try {
            sessionStorage.setItem('lctest.lmbench', '1'); // (a page that comes back with it set was reloaded mid-bench)
        } catch {
            // the native termination count says it anyway
        }
        const samples = [];
        const generations = [];
        let promptIndex = 0;
        let running = null;
        let lastActivity = performance.now();
        const generate = phase => {
            const prompt = prompts[promptIndex++ % prompts.length];
            const at = performance.now();
            running = lmBench('generate', { system: prompt.system, user: prompt.user, think, timeoutMs: 9000 }, 20000).then(reply => {
                generations.push({ phase, at: Math.round(at), ms: Math.round(performance.now() - at), text: reply?.text ?? null, note: reply?.note ?? null, error: reply?.error ?? (reply ? null : 'no answer'), timings: reply?.timings ?? null });
                running = null;
            });
        };
        for (const phase of phases) {
            const phaseStart = performance.now();
            const phaseEnd = phaseStart + phase.minutes * 60000;
            let nextGeneration = phaseStart;
            let windowStart = phaseStart;
            let fpsWindow = [];
            let fromGen = generations.length;
            out(`INFO lm-bench phase ${phase.name} (${phase.minutes} min${phase.every > 0 ? `, a reply every ${phase.every} s` : phase.every < 0 ? ', replies back to back' : ', no generation'})`);
            while (performance.now() < phaseEnd) {
                await sleep(1000);
                fpsWindow.push(c().fps);
                const now = performance.now();
                if (phase.every > 0 && now >= nextGeneration && !running) {
                    generate(phase.name);
                    nextGeneration += phase.every * 1000;
                } else if (phase.every < 0 && !running) {
                    generate(phase.name);
                }
                if (now - lastActivity > 60000) {
                    lastActivity = now;
                    void debug('activity'); // (the screen stays on while the run plays by itself)
                }
                if (now - windowStart >= sampleMs) {
                    const stats = await lmBench('stats');
                    const tick = tickTiming(windowStart);
                    const gens = generations.slice(fromGen);
                    const sample = {
                        phase: phase.name,
                        t: Math.round((now - phaseStart) / 1000),
                        fps: median(fpsWindow),
                        fpsMin: Math.min(...fpsWindow),
                        tickP95: tick?.intervalMs.p95 ?? null,
                        tickMax: tick?.intervalMs.max ?? null,
                        lateP95: tick?.lateMs.p95 ?? null,
                        footprintMB: round1(stats?.footprintMB),
                        availableMB: round1(stats?.availableMB),
                        thermal: stats?.thermal ?? null,
                        loaded: stats?.loaded ?? null,
                        terminations: stats?.terminations ?? null,
                        battery: stats?.battery ? `${Math.round((stats.battery.level ?? -1) * 100)}% ${stats.battery.state}` : null,
                        gens: gens.length,
                        genMs: median(gens.map(g => g.ms)),
                        promptTps: median(gens.map(g => g.timings?.promptTps)),
                        genTps: median(gens.map(g => g.timings?.generateTps)),
                        ...(think ? { noteTokens: median(gens.map(g => g.timings?.noteTokens)), noteMs: median(gens.map(g => g.timings?.noteMs)) } : {}),
                        loadMs: gens.find(g => g.timings?.loadMs)?.timings.loadMs ?? null,
                        errors: gens.filter(g => g.error).length
                    };
                    samples.push(sample);
                    out(`INFO lm-bench ${JSON.stringify(sample)}`);
                    windowStart = now;
                    fpsWindow = [];
                    fromGen = generations.length;
                }
            }
            if (running) {
                await running; // (the phase's last reply, before the next phase's clock starts)
            }
        }
        // unloaded and loaded again (warm: the file in the page cache, Metal's pipelines compiled), with one reply
        await lmBench('unload');
        await sleep(3000);
        const warm = await lmBench('generate', { system: prompts[1 % prompts.length].system, user: prompts[1 % prompts.length].user, think, timeoutMs: 120000 }, 130000);
        const warmStats = await lmBench('stats');
        out(`INFO lm-bench warm load: ${JSON.stringify({ load: warmStats?.lastLoad ?? null, reply: warm?.text ?? null, error: warm?.error ?? null, timings: warm?.timings ?? null })}`);
        await lmBench('options', { idleSec: 300 });
        try {
            sessionStorage.removeItem('lctest.lmbench');
        } catch {
            // ignore
        }
        const last = await lmBench('stats');
        const of = name => samples.filter(s => s.phase === name);
        const gensOf = name => generations.filter(g => g.phase === name);
        const summary = {};
        for (const phase of phases) {
            const list = of(phase.name);
            const gens = gensOf(phase.name);
            summary[phase.name] = {
                samples: list.length,
                fpsMedian: median(list.map(s => s.fps)),
                fpsP05: quantile(list.map(s => s.fpsMin), 0.05),
                tickP95: quantile(list.map(s => s.tickP95), 0.95),
                tickP95Median: median(list.map(s => s.tickP95)),
                lateP95: median(list.map(s => s.lateP95)),
                footprintMaxMB: Math.max(...list.map(s => s.footprintMB ?? 0)),
                availableMinMB: Math.min(...list.map(s => s.availableMB ?? Infinity)),
                thermalMax: THERMAL[Math.max(...list.map(s => THERMAL.indexOf(s.thermal)))] ?? null,
                generations: gens.length,
                errors: gens.filter(g => g.error).length,
                genMsMedian: median(gens.map(g => g.ms)),
                genMsP95: quantile(gens.map(g => g.ms), 0.95),
                promptTps: median(gens.map(g => g.timings?.promptTps)),
                generateTps: median(gens.map(g => g.timings?.generateTps)),
                promptTokens: median(gens.map(g => g.timings?.promptTokens)),
                generatedTokens: median(gens.map(g => g.timings?.generatedTokens)),
                ...(think ? { noteTokens: median(gens.map(g => g.timings?.noteTokens)), noteTokensMax: Math.max(0, ...gens.map(g => g.timings?.noteTokens ?? 0)), noteMsMedian: median(gens.map(g => g.timings?.noteMs)), noteMsP95: quantile(gens.map(g => g.timings?.noteMs), 0.95) } : {}),
                loadMs: gens.map(g => g.timings?.loadMs).filter(Number.isFinite)
            };
        }
        summary.think = think;
        summary.coldLoad = { ms: coldStats?.lastLoad ?? null, replyMs: cold?.timings?.totalMs ?? null, error: cold?.error ?? null };
        summary.warmLoad = { ms: warmStats?.lastLoad ?? null, replyMs: warm?.timings?.totalMs ?? null, error: warm?.error ?? null };
        summary.terminations = (last?.terminations ?? 0) - (first.terminations ?? 0);
        summary.examples = generations.filter(g => g.text).slice(0, 12).map(g => g.text);
        if (think) {
            summary.notes = generations.filter(g => g.note).slice(0, 8).map(g => `${g.note} => ${g.text ?? '(no line)'}`);
        }
        summary.errors = [...new Set(generations.map(g => g.error).filter(Boolean))].slice(0, 5);
        out(`INFO lm-bench-summary ${JSON.stringify(summary)}`);
        const base = summary.baseline;
        const periodic = summary.periodic;
        const all = phases.map(p => summary[p.name]);
        const every = `${phases[1].every}-s`;
        check(`lm-bench gate: median fps in the ${every} phase >= 45 (50 is the target)`, periodic.fpsMedian >= 45, `${periodic.fpsMedian} fps (baseline ${base.fpsMedian}, burst ${summary.burst.fpsMedian})`);
        check(`lm-bench gate: the tick p95 in the ${every} phase within 10 % of the baseline's`, periodic.tickP95Median <= base.tickP95Median * 1.1, `${periodic.tickP95Median} ms against ${base.tickP95Median} ms (window p95 medians; burst ${summary.burst.tickP95Median} ms)`);
        check('lm-bench gate: no WebContent termination', summary.terminations === 0, `${summary.terminations}`);
        check('lm-bench gate: available memory never under 300 MB', all.every(p => p.availableMinMB >= 300), all.map(p => p.availableMinMB).join(' / '));
        check('lm-bench gate: thermal state never serious', all.every(p => THERMAL.indexOf(p.thermalMax) < 2), all.map(p => p.thermalMax).join(' / '));
        check('lm-bench: the replies come (at most 2 % fail)', periodic.generations > 0 && periodic.errors + summary.burst.errors <= 0.02 * (periodic.generations + summary.burst.generations), `${periodic.generations} + ${summary.burst.generations} replies, ${periodic.errors + summary.burst.errors} failed: ${summary.errors.join(' | ')}`);
        if (think) {
            const written = generations.filter(g => g.timings);
            // (in the note mode, each one; a note the model closed at once counts as written: the median says they were real)
            check('lm-bench --lm-think: every reply was written in the note mode, the notes not empty (median)', written.length > 0 && written.every(g => g.timings.think === true) && periodic.noteTokens > 0, `${written.filter(g => g.timings.think === true).length} of ${written.length} (${written.filter(g => !(g.timings.noteTokens > 0)).length} empty); note ${periodic.noteTokens} tokens (median, at most ${periodic.noteTokensMax}) in ${periodic.noteMsMedian} ms (p95 ${periodic.noteMsP95})`);
        }
    }

    // ---- soak (app-test --soak <config>: web/test/perf/*.json, docs/BUILDING.md §4)
    // With a soak in the launch's test argument (launchTest above) the run measures instead of checking. Every launch
    // reports its start-up marks (soak-startup: the page's own and the engine's, src/autotest/perf.ts). A start-up series
    // (soak.startup.launches N) asks the driver for another launch until N clean ones (launched, not the run's restart
    // for the settings) are measured. Then the phases, in the soak's order: those `where: 'title'` before the login, the
    // others after it. Each is a window of `sec` seconds (after `settleSec`, 3) in which it asks the driver to record
    // (`traces`: [{set, at, sec}], xctrace on the iPhone, samples on a simulator or Android; by default one 'am' over the
    // window) and measures from inside: the client's frames (mainredraw and mainloop wrapped), the page's display frames
    // (rAF), the engine's ticks as the engine times them (durations, start to start, World's phases, the bots' share) and
    // as the page sees them, the app's memory and heat (native stats), music and audio. Before its window a phase can
    // teleport (`tele`: "level,mx,mz,lx,lz"), wait for the bots to fill the world (`waitFill`: seconds at most), set game
    // options (`vars`: {varp: value} with ::setvar, e.g. option_music 4 = Music off, 2 = the default), suspend the
    // AudioContext (`audioOff`), walk to and fro (`walk`, a minimap tap every `walkEveryMs`, 3500), ask the chat model
    // (`lm`: {everySec, think}, the build's lmPrompts) or go to the background for its seconds (`background`).
    let settingsRestart = false; // (applyBots: this page is the run's restart for the settings)
    const boot = { client100: null, client100Exact: false, loaderFade: null };

    // the client reaching 100 % (its drawProgress wrapped from the moment host.js makes it) and the loader starting to fade
    function trackStartup() {
        const hook = client => {
            const draw = client?.drawProgress;
            if (typeof draw !== 'function' || (client.lastProgressPercent ?? 0) >= 100) {
                return; // (too late: soakRun's poll notes it)
            }
            client.drawProgress = function (message, progress) {
                if (progress >= 100 && boot.client100 === null) {
                    boot.client100 = performance.now();
                    boot.client100Exact = true;
                }
                return draw.call(this, message, progress);
            };
        };
        if (window.__client) {
            hook(window.__client);
        } else {
            clientMade.hooks.push(hook);
        }
        const watchLoader = () => {
            const loading = document.getElementById('loading');
            if (!loading) {
                return;
            }
            const seen = () => {
                if (boot.loaderFade === null && (loading.classList.contains('fade') || loading.hidden)) {
                    boot.loaderFade = performance.now();
                }
            };
            seen();
            new MutationObserver(seen).observe(loading, { attributes: true, attributeFilter: ['class', 'hidden'] });
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', watchLoader, { once: true });
        } else {
            watchLoader();
        }
    }

    // A soak's value, with the run it belongs to (the driver's: a phone's app log keeps earlier runs' lines); a line too
    // long for the console bridges (16,000 characters) goes out in numbered parts the drivers join.
    let partsSent = 0;
    function emit(kind, value) {
        const text = JSON.stringify({ run: launchTest?.run ?? null, ...value });
        const size = 15000;
        if (text.length <= size) {
            out(`INFO ${kind} ${text}`);
            return;
        }
        const id = `${kind}-${launchTest?.run ?? 'run'}-${launchTest?.launch ?? 1}-${++partsSent}`;
        const n = Math.ceil(text.length / size);
        for (let i = 0; i < n; i++) {
            out(`INFO ${kind}-part ${id} ${i + 1}/${n} ${text.slice(i * size, (i + 1) * size)}`);
        }
    }

    let perfRequests = 0;
    // the engine's own numbers (src/autotest/perf.ts): the ticks from `since` on, the start-up marks, the world's counts
    function enginePerf(since) {
        if (!engine.worker) {
            return Promise.resolve(null);
        }
        return new Promise(resolve => {
            const reqId = `perf-${++perfRequests}`;
            engine.perfWaiters.set(reqId, resolve);
            engine.worker.postMessage({ type: 'lctest-perf', reqId, since });
            setTimeout(() => {
                if (engine.perfWaiters.delete(reqId)) {
                    resolve(null);
                }
            }, 5000);
        });
    }

    const pageMs = epochMs => (Number.isFinite(epochMs) ? Math.round((epochMs - performance.timeOrigin) * 10) / 10 : null);
    const round = v => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

    function dist(list) {
        const d = list.filter(Number.isFinite).sort((a, b) => a - b);
        const n = d.length;
        if (!n) {
            return null;
        }
        const q = p => +d[Math.min(n - 1, Math.floor(p * n))].toFixed(2);
        const sum = d.reduce((a, b) => a + b, 0);
        return { n, avg: +(sum / n).toFixed(2), p50: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: +d[n - 1].toFixed(2), sum: Math.round(sum) };
    }
    const over = (list, ms) => list.filter(v => v > ms).length;

    async function soakStartup(titlePolledAt) {
        await waitFor(() => boot.loaderFade !== null, 3000, 20); // (host.js checks for the title every 200 ms)
        const nav = performance.getEntriesByType('navigation')[0];
        const clean = nav?.type !== 'reload' && !settingsRestart;
        const marks = (await enginePerf(1e12))?.marks ?? {};
        const ready = engine.ready?.at ?? null;
        const client100 = boot.client100 ?? (c()?.lastProgressPercent === 100 ? titlePolledAt : null);
        const stats = await lmBench('stats');
        const record = {
            launch: launchTest.launch ?? 1,
            clean,
            navigation: nav?.type ?? null,
            settingsRestart,
            bots: window.LostCityHost?.settings?.bots ?? 0,
            bundle: engine.booted?.bundle ?? null,
            // ms after the page's navigation started (performance.now()); the engine's marks put on the same clock
            page: { domInteractive: round(nav?.domInteractive), domContentLoaded: round(nav?.domContentLoadedEventStart), load: round(nav?.loadEventEnd) },
            workerCreated: round(engine.createdAt),
            engineBooted: round(engine.booted?.at),
            preloadMs: round(engine.booted?.preloadMs),
            evalMs: round(engine.booted?.evalMs),
            engineEvaluated: pageMs(marks.evaluated),
            worldStart: pageMs(marks.worldStart),
            worldStarted: pageMs(marks.worldStarted),
            firstTickStart: pageMs(marks.firstTickStart),
            firstTickEnd: pageMs(marks.firstTickEnd),
            readySent: pageMs(marks.ready),
            engineReady: round(ready),
            readyMs: round(engine.ready?.ms),
            clientCreated: round(clientMade.at),
            client100: round(client100),
            client100Exact: boot.client100Exact,
            // what host.js waits for to fade its loader (titleReady: the client at 100 % with its flames, the engine ready)
            titleReady: client100 !== null && ready !== null ? round(Math.max(client100, ready)) : round(titlePolledAt),
            titlePolled: round(titlePolledAt),
            loaderFade: round(boot.loaderFade),
            native: stats ? { footprintMB: round(stats.footprintMB), availableMB: round(stats.availableMB), thermal: stats.thermal ?? null } : null
        };
        emit('soak-startup', record);
        return record;
    }

    // the client's frames and the page's display frames, recorded while `on` (a phase's window)
    const frames = { intervals: [], draw: [], loop: [], last: 0, on: false };
    const raf = { times: [], cbMs: [], lastT: -1, on: false };
    let frameHooks = false;

    function installFrameHooks() {
        const client = c();
        if (frameHooks || !client) {
            return;
        }
        frameHooks = true;
        const redraw = client.mainredraw;
        const loop = client.mainloop;
        if (typeof redraw !== 'function' || typeof loop !== 'function') {
            out('INFO soak: the client has no mainredraw/mainloop to time');
            return;
        }
        client.mainredraw = function (...a) {
            if (!frames.on) {
                return redraw.apply(this, a);
            }
            const t = performance.now();
            if (frames.last) {
                frames.intervals.push(t - frames.last);
            }
            frames.last = t;
            return Promise.resolve(redraw.apply(this, a)).then(r => {
                frames.draw.push(performance.now() - t);
                return r;
            });
        };
        client.mainloop = function (...a) {
            if (!frames.on) {
                return loop.apply(this, a);
            }
            const t = performance.now();
            return Promise.resolve(loop.apply(this, a)).then(r => {
                frames.loop.push(performance.now() - t);
                return r;
            });
        };
        // (the HUD asks for every frame by name, so it gets this from its next frame on)
        const pageRaf = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = cb =>
            pageRaf(t => {
                if (!raf.on) {
                    return cb(t);
                }
                const s0 = performance.now();
                try {
                    return cb(t);
                } finally {
                    const ms = performance.now() - s0;
                    if (t !== raf.lastT) {
                        raf.lastT = t;
                        raf.times.push(t);
                        raf.cbMs.push(ms);
                    } else if (raf.cbMs.length) {
                        raf.cbMs[raf.cbMs.length - 1] += ms;
                    }
                }
            });
    }

    // (on: from no samples; off: the samples kept for the phase's summary)
    function recordFrames(on) {
        if (on) {
            frames.intervals = [];
            frames.draw = [];
            frames.loop = [];
            frames.last = 0;
            raf.times = [];
            raf.cbMs = [];
            raf.lastT = -1;
        }
        frames.on = on;
        raf.on = on;
    }

    const WALK = [[18, 8], [-18, -8], [8, -18], [-8, 18]]; // minimap taps around its centre: a few tiles there and back

    async function soakPrepare(spec) {
        if (spec.tele) {
            await dismissTutorialMessage();
            const [lv, mx, mz, lx, lz] = String(spec.tele).split(',').map(Number);
            window.LostCityHost.keyboard.insertText(`::tele ${spec.tele}\n`);
            const there = await waitFor(() => same(position(), [mx * 64 + lx, mz * 64 + lz, lv]), 10000);
            out(`INFO soak: ::tele ${spec.tele} ${there.ok ? 'arrived' : `did not arrive (${JSON.stringify(position())})`}`);
            await sleep(3000);
        }
        for (const [name, value] of Object.entries(spec.vars ?? {})) {
            window.LostCityHost.keyboard.insertText(`::setvar ${name} ${value}\n`);
            await sleep(1200);
        }
        if (spec.vars) {
            out(`INFO soak: game options ${JSON.stringify(spec.vars)}: music ${c()?.midiActive ? 'on' : 'off'}, sound ${c()?.waveEnabled ? 'on' : 'off'}`);
        }
        if (spec.waitFill) {
            const want = Math.floor((window.LostCityHost?.settings?.bots ?? 0) * 0.95);
            const started = performance.now();
            let active = 0;
            while (performance.now() - started < spec.waitFill * 1000) {
                active = (await enginePerf(1e12))?.extra?.active ?? 0;
                if (active >= want) {
                    break;
                }
                await sleep(3000);
                void debug('activity');
            }
            out(`INFO soak: ${active} bots active after ${Math.round((performance.now() - started) / 1000)} s (want ${want})`);
        }
        if (typeof spec.pageGcEverySec === 'number') {
            // (the app's collections of the page's heap, PageMemory: every n s from now on, 0 = none; an A/B)
            out(`INFO soak: page GC every ${spec.pageGcEverySec} s: ${JSON.stringify(await debug('page-gc-every', { sec: spec.pageGcEverySec }))}`);
        }
        if (spec.webkitLowMemory) {
            // (WebKit's own low-memory handler: what its processes give back, memory attribution)
            out(`INFO soak: org.WebKit.lowMemory posted: ${JSON.stringify(await debug('webkit-low-memory'))}`);
            await sleep(5000);
        }
        if (spec.audioOff) {
            try {
                await window.audioContext?.suspend();
            } catch {
                // no audio
            }
            out(`INFO soak: the AudioContext is ${window.audioContext?.state ?? 'absent'}`);
        }
    }

    async function soakBackground(spec) {
        recordLifecycle();
        const before = lifecycleEvents.length;
        const p0 = await enginePerf(1e12);
        const n0 = await lmBench('stats');
        const at = Date.now();
        out(`INFO soak-phase-start ${spec.name} ${at}`);
        const traces = spec.traces ?? [{ set: 'am', at: 0, sec: Math.max(5, spec.sec - 8) }];
        for (const t of traces) {
            out(`ACTION soak ${spec.name}.${t.set} ${t.sec} ${t.set}`);
        }
        await sleep(300);
        out(`ACTION background ${spec.sec}`);
        const back = await waitFor(() => lifecycleEvents.slice(before).some(e => e.event === 'foreground' || e.event === 'resume'), (spec.sec + 90) * 1000, 250);
        const p1 = await enginePerf(1e12);
        await sleep(3000);
        const n1 = await lmBench('stats');
        emit('soak-summary', {
            name: spec.name,
            kind: 'background',
            sec: spec.sec,
            window: { start: at, end: Date.now() },
            back: back.ok,
            events: lifecycleEvents.slice(before).map(e => e.event),
            ticksWhileAway: p0 && p1 ? p1.ticks - p0.ticks : null,
            ingame: !!c()?.ingame,
            native: { footprintMB: [n0, n1].map(n => round(n?.footprintMB)), thermal: [n0, n1].map(n => n?.thermal ?? null) }
        });
        await sleep(5000);
    }

    async function soakPhase(spec) {
        const name = spec.name;
        try {
            sessionStorage.setItem(SOAK_KEY, name);
        } catch {
            // (a reload then goes unnoticed: the driver counts WebContent terminations too)
        }
        if (spec.background) {
            return soakBackground(spec);
        }
        await soakPrepare(spec);
        // the chat model: loaded (one reply, cold) before the window, then a reply every lm.everySec in it
        const lm = spec.lm ?? null;
        const prompts = (autotestConfig?.lmPrompts ?? []).filter(p => p?.system && p?.user);
        const gens = [];
        let lmRunning = null;
        let lmIndex = 0;
        if (lm) {
            if (!prompts.length) {
                check(`soak ${name}: the build has the chat model's prompts (lmPrompts)`, false);
            } else {
                out(`INFO soak: lm options ${JSON.stringify(await lmBench('options', { idleSec: 3600 }))}`);
                const cold = await lmBench('generate', { system: prompts[0].system, user: prompts[0].user, think: lm.think === true, timeoutMs: 120000 }, 130000);
                out(`INFO soak: lm cold ${JSON.stringify({ text: cold?.text ?? null, error: cold?.error ?? null, timings: cold?.timings ?? null })}`);
            }
        }
        await sleep((spec.settleSec ?? 3) * 1000);
        void debug('activity');

        const traces = (spec.traces ?? [{ set: 'am', at: 1, sec: Math.max(5, spec.sec - 6) }]).map(t => ({ ...t, sent: false }));
        const sendTraces = elapsedSec => {
            for (const t of traces) {
                if (!t.sent && elapsedSec >= t.at) {
                    t.sent = true;
                    out(`ACTION soak ${name}.${t.set}${t.tag ?? ''} ${t.sec} ${t.set}`);
                }
            }
        };
        const p0 = await enginePerf(1e12);
        const ticks = { start: [], tickMs: [], callbackMs: [], phases: [], extraMs: [] };
        let nextTick = p0?.ticks ?? 0;
        const pollTicks = async () => {
            const r = await enginePerf(nextTick);
            if (!r) {
                return null;
            }
            for (let k = 0; k < r.start.length; k++) {
                ticks.start.push(r.start[k]);
                ticks.tickMs.push(r.tickMs[k]);
                ticks.callbackMs.push(r.callbackMs[k]);
                ticks.phases.push(r.phases.slice(k * 12, k * 12 + 12));
                ticks.extraMs.push(r.extraMs?.[k] ?? null);
            }
            nextTick = r.ticks;
            return r;
        };
        const nat = [await lmBench('stats')];
        const startEpoch = Date.now();
        out(`INFO soak-phase-start ${name} ${startEpoch}`);
        sendTraces(0);
        recordFrames(true);
        const t0 = performance.now();
        const t0Epoch = performance.timeOrigin + t0;
        const fps = [];
        let crowd = 0;
        let walkI = 0;
        let nextWalk = t0;
        let nextGen = t0;
        let lastActivity = t0;
        let lastPoll = t0;
        while (performance.now() - t0 < spec.sec * 1000) {
            await sleep(1000);
            const now = performance.now();
            fps.push(c().fps);
            crowd = Math.max(crowd, c().playerCount ?? 0);
            sendTraces((now - t0) / 1000);
            if (lm && prompts.length && now >= nextGen && !lmRunning) {
                const prompt = prompts[lmIndex++ % prompts.length];
                const at = performance.now();
                nextGen += (lm.everySec ?? 10) * 1000;
                lmRunning = lmBench('generate', { system: prompt.system, user: prompt.user, think: lm.think === true, timeoutMs: 12000 }, 25000).then(reply => {
                    gens.push({ at: Math.round(at - t0), ms: Math.round(performance.now() - at), chars: reply?.text?.length ?? null, error: reply?.error ?? (reply ? null : 'no answer'), timings: reply?.timings ?? null });
                    lmRunning = null;
                });
            }
            if (spec.walk && now >= nextWalk) {
                const [dx, dy] = WALK[walkI++ % WALK.length];
                clickGame(627 + dx, 85 + dy);
                nextWalk += spec.walkEveryMs ?? 3500;
            }
            if (now - lastActivity > 50000) {
                lastActivity = now;
                void debug('activity'); // (the screen stays on while the run plays by itself)
            }
            if (fps.length % 15 === 0) {
                nat.push(await lmBench('stats'));
            }
            if (now - lastPoll > 30000) {
                lastPoll = now;
                await pollTicks();
            }
        }
        const t1 = performance.now();
        const t1Epoch = performance.timeOrigin + t1;
        recordFrames(false);
        const endEpoch = Date.now();
        const last = await pollTicks();
        nat.push(await lmBench('stats'));
        if (lmRunning) {
            await lmRunning;
        }
        const audio = window.audioContext?.state ?? null; // (the window's: an audioOff phase resumes it now)
        if (spec.audioOff) {
            try {
                await window.audioContext?.resume();
            } catch {
                // no audio
            }
        }
        // the ticks that started in the window, and their start-to-start intervals (from the tick before the window)
        const inWindow = [];
        for (let k = 0; k < ticks.start.length; k++) {
            if (ticks.start[k] >= t0Epoch && ticks.start[k] < t1Epoch) {
                inWindow.push(k);
            }
        }
        const pick = list => inWindow.map(k => list[k]);
        const startIntervals = inWindow.filter(k => k > 0).map(k => ticks.start[k] - ticks.start[k - 1]);
        const tickMs = pick(ticks.tickMs);
        const PHASE_NAMES = ['cycle', 'world', 'clientIn', 'npc', 'player', 'logout', 'login', 'zone', 'clientOut', 'cleanup'];
        const phasesAvgMs = inWindow.length ? Object.fromEntries(PHASE_NAMES.map((key, i) => [key, +(inWindow.reduce((sum, k) => sum + ticks.phases[k][i], 0) / inWindow.length).toFixed(2)])) : null;
        const botsMs = pick(ticks.extraMs).filter(v => v !== null);
        const rafIntervals = raf.times.slice(1).map((t, i) => t - raf.times[i]);
        const wallMs = t1 - t0;
        const footprints = nat.map(n => round(n?.footprintMB));
        emit('soak-summary', {
            name,
            kind: spec.where === 'title' ? 'title' : 'ingame',
            sec: Math.round(wallMs / 100) / 10,
            window: { start: startEpoch, end: endEpoch },
            bots: window.LostCityHost?.settings?.bots ?? 0,
            ingame: !!c()?.ingame,
            position: position(),
            crowdMax: crowd,
            fps: { median: median(fps), min: Math.min(...fps), samples: fps.length },
            frames: { perSec: +(frames.intervals.length / (wallMs / 1000)).toFixed(1), interval: dist(frames.intervals), over25: over(frames.intervals, 25), over33: over(frames.intervals, 33), over50: over(frames.intervals, 50), over100: over(frames.intervals, 100), draw: dist(frames.draw), loopPerSec: +(frames.loop.length / (wallMs / 1000)).toFixed(1), loop: dist(frames.loop) },
            raf: { perSec: +(raf.times.length / (wallMs / 1000)).toFixed(1), interval: dist(rafIntervals), over20: over(rafIntervals, 20), over34: over(rafIntervals, 34), over50: over(rafIntervals, 50), cbMs: dist(raf.cbMs) },
            tickPage: tickTiming(t0),
            ticks: last
                ? {
                      n: inWindow.length,
                      tickMs: dist(tickMs),
                      callbackMs: dist(pick(ticks.callbackMs)),
                      startInterval: dist(startIntervals),
                      intervalOver650: over(startIntervals, 650),
                      intervalOver700: over(startIntervals, 700),
                      intervalOver900: over(startIntervals, 900),
                      over100: over(tickMs, 100),
                      over300: over(tickMs, 300),
                      phasesAvgMs,
                      botsMs: botsMs.length ? dist(botsMs) : null,
                      clamps: last.clamps - (p0?.clamps ?? 0),
                      state: last.state,
                      players: last.players,
                      npcs: last.npcs
                  }
                : null,
            botsState: last?.extra ?? null,
            native: { footprintMB: footprints, availableMB: nat.map(n => round(n?.availableMB)), thermal: nat.map(n => n?.thermal ?? null), battery: nat.map(n => (n?.battery ? `${Math.round(n.battery.level * 100)}% ${n.battery.state}` : null)), lowPower: nat.at(-1)?.lowPower ?? null, lmLoaded: nat.map(n => n?.loaded ?? null) },
            audio,
            music: { song: c()?.midiSong ?? null, active: c()?.midiActive ?? null, volume: c()?.midiVolume ?? null, wave: c()?.waveEnabled ?? null },
            lm: lm ? { gens: gens.length, ms: dist(gens.map(g => g.ms)), errors: gens.filter(g => g.error).length, list: gens } : null,
            engineErrors: engine.errors.length
        });
        // the samples themselves (rounded to 0.1 ms; the ticks' starts in ms from the window's start)
        emit('soak-raw', {
            name,
            frameIntervals: frames.intervals.map(round),
            drawMs: frames.draw.map(round),
            rafIntervals: rafIntervals.map(round),
            tickStart: inWindow.map(k => round(ticks.start[k] - t0Epoch)),
            tickMs: tickMs.map(round),
            callbackMs: pick(ticks.callbackMs).map(round),
            botsMs: botsMs.map(round)
        });
    }

    async function soakRun(test) {
        const soak = test.soak;
        await readConfig(); // (the build's autotest.json: the chat model's prompts)
        const title = await waitFor(() => c()?.lastProgressPercent === 100 && c()?.titleFlames && window.LostCityHost?.engineState === 'ready', 120000, 50);
        const titlePolledAt = performance.now();
        check('soak: title screen and world ready', title.ok, `${Math.round(titlePolledAt)} ms after navigation`);
        if (!title.ok) {
            return soakEnd();
        }
        const startup = await soakStartup(titlePolledAt);
        const series = soak.startup?.launches ?? 0;
        if (series > 0 && (test.clean ?? 0) + (startup.clean ? 1 : 0) < series) {
            const before = settingsBefore();
            out(`ACTION relaunch${before !== null ? ` ${JSON.stringify(before)}` : ''}`); // (the driver ends this launch and starts the next)
            return;
        }
        const phases = soak.phases ?? [];
        const firstIngame = phases.findIndex(p => (p.where ?? 'ingame') !== 'title');
        if (firstIngame >= 0 && phases.slice(firstIngame).some(p => p.where === 'title')) {
            check('soak: the title phases come before the others (the run cannot go back to the title)', false, phases.map(p => `${p.name}:${p.where ?? 'ingame'}`).join(' '));
            return soakEnd();
        }
        out(`INFO soak: ${JSON.stringify({ name: soak.name ?? null, phases: phases.map(p => p.name), bots: window.LostCityHost?.settings?.bots ?? 0, nativeInfo: window.LostCityNative ? { platform: window.LostCityNative.platform ?? 'ios', build: window.LostCityNative.build, os: window.LostCityNative.osVersion, model: window.LostCityNative.deviceModel, simulator: window.LostCityNative.simulator, emulator: window.LostCityNative.emulator, webView: window.LostCityNative.webView } : null, ua: navigator.userAgent })}`);
        if (window.LostCityNative?.platform !== 'android') {
            // (the iPhone locks after its Auto-Lock time outside the world; Android's driver keeps the screen on itself)
            out(`INFO soak: keep-awake ${JSON.stringify(await debug('keep-awake', { on: true }))}`);
        }
        installFrameHooks();
        for (const spec of phases.slice(0, firstIngame < 0 ? phases.length : firstIngame)) {
            await soakPhase(spec);
        }
        if (firstIngame >= 0) {
            if (!(await login(null))) {
                return soakEnd();
            }
            await sleep(3000);
            await enterWorld();
            for (const spec of phases.slice(firstIngame)) {
                await soakPhase(spec);
            }
        }
        return soakEnd();
    }

    async function soakEnd() {
        try {
            sessionStorage.removeItem(SOAK_KEY);
        } catch {
            // ignore
        }
        if (window.LostCityNative?.platform !== 'android') {
            await debug('keep-awake', { on: false });
        }
        check('soak: no engine error lines', engine.errors.length === 0, engine.errors.slice(0, 3).join(' | '));
        return finish();
    }

    // ---- phases
    // ---- the World map (worldmap.js): the globe opens it; the map (mapview.html in an iframe on the app's own scheme)
    // loads, tells the host so (postMessage) and draws the player at its centre; what it costs in memory; Close puts its
    // loop to sleep
    async function worldMapChecks() {
        out('ACTION measure before-worldmap');
        await sleep(1500);
        tapElement(document.getElementById('btn-worldmap'));
        const sheet = document.getElementById('worldmap');
        const map = () => document.getElementById('worldmap-frame')?.contentWindow?.lcMapView;
        const hostReady = await waitFor(() => !sheet.hidden && !sheet.classList.contains('loading'), 30000);
        const tile = c().hudPlayerTile();
        let pixel = null;
        const marked = await waitFor(() => {
            const canvas = document.getElementById('worldmap-frame').contentDocument.getElementById('canvas');
            pixel = [...canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data].slice(0, 3);
            return pixel.every(v => v > 240); // (the player's white dot)
        }, 3000);
        let centred = false;
        try {
            const m = map();
            centred = Math.abs(m.fx + m.mapOriginX - tile.x - 0.5) < 1 && Math.abs(m.mapOriginZ + m.mapHeight - m.fz - tile.z - 0.5) < 1;
        } catch (e) {
            out(`INFO the map's window is not reachable from the page: ${e}`);
        }
        check('the World map opens, loads in its iframe and marks the player at its centre', hostReady.ok && marked.ok && centred, JSON.stringify({ ms: hostReady.ms, tile, pixel, centred }));
        await shot('worldmap');
        out('ACTION measure worldmap');
        await sleep(1500);
        document.getElementById('worldmap-close').click();
        const asleep = await waitFor(() => sheet.hidden && map()?.paused === true, 3000);
        check('Close closes the World map and its loop sleeps', asleep.ok);
    }

    // After a login: Tutorial Island's first login opens the character designer (accepted), and the first visit's "how to
    // play" card (checked and closed).
    async function enterWorld() {
        if (c().mainModalId !== -1) {
            // "Accept" (classic 260,286: the designer is drawn at the viewport's modal offset, which the mobile layout
            // moves into the part of the world its HUD leaves free)
            clickGame(c().viewportX + c().modalX + 256, c().viewportY + c().modalY + 282);
            await waitFor(() => c().mainModalId === -1, 5000);
        }
        // the first visit's "how to play" card
        const howto = await waitFor(() => !document.getElementById('howto')?.hidden, 4000);
        if (howto.ok) {
            // The overlays grow with the page's zoom (×1.5 or ×2 on an iPad, 1 on an iPhone) as a whole, text included:
            // WebKit's CSS zoom and page zoom would leave the text of an element that sets its own font at 1x, and the
            // page zoom would also centre the card in the unzoomed viewport. The card's keys set their own font
            // (16px/18px), so their line is 18 px times the zoom.
            const panel = document.querySelector('.howto-panel')?.getBoundingClientRect();
            const key = document.querySelector('.howto-key');
            const keyBox = key?.getBoundingClientRect();
            const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
            const detail = `page ${innerWidth}x${innerHeight} at ${devicePixelRatio}x, zoom ${zoom}, card ${panel ? [panel.left, panel.top, panel.width, panel.height].map(Math.round).join(',') : '?'}, key ${key ? getComputedStyle(key).fontSize : '?'} drawn ${keyBox ? Math.round(keyBox.height) : '?'} px tall`;
            check('the how-to card is centred and its text grows with the zoom', !!panel && !!keyBox && Math.abs(panel.left + panel.width / 2 - innerWidth / 2) <= 2 && Math.abs(panel.top + panel.height / 2 - innerHeight / 2) <= 2 && Math.abs(keyBox.height - 18 * zoom) <= 1, detail);
            await shot('how-to-play');
            document.getElementById('howto-ok').click();
            await sleep(300);
        }
    }

    async function phaseA() {
        if (launchTest?.soak) {
            return soakRun(launchTest);
        }
        out(`INFO phase A: ${JSON.stringify({ native: !!native, ua: navigator.userAgent, nativeInfo: window.LostCityNative ? { platform: window.LostCityNative.platform ?? 'ios', build: window.LostCityNative.build, os: window.LostCityNative.osVersion, model: window.LostCityNative.deviceModel, simulator: window.LostCityNative.simulator, emulator: window.LostCityNative.emulator, webView: window.LostCityNative.webView } : null })}`);
        if (!(await login(null))) {
            return finish();
        }
        await shot('ingame');
        out('ACTION measure ingame');
        if (native) {
            check('screen kept awake while playing', (await debug('idle-timer')) === true);
        }
        await sleep(3000);

        // Tutorial Island's character designer and the how-to card, then walk with the minimap.
        await enterWorld();
        const hudShown = !document.getElementById('hud')?.hidden;
        const surface = document.getElementById('surface-game');
        out(`INFO layout ${window.lcHost?.settings?.layout ?? '?'}: HUD ${hudShown ? 'shown' : 'hidden'}, world ${surface?.width}x${surface?.height}`);
        if (window.lcHost?.settings?.layout === 'mobile') {
            check('mobile HUD in game, world rendered full screen', hudShown && surface?.width === c().viewportWidth && c().viewportWidth >= 512, JSON.stringify({ hudShown, surface: [surface?.width, surface?.height], viewport: [c().viewportWidth, c().viewportHeight] }));
        }
        const bots = window.LostCityHost?.settings?.bots ?? 0;
        if (bots > 0) {
            await botsChecks(bots); // (the rest of the run then plays among them)
        }
        const lmConfig = (await readConfig())?.lmBench;
        if (lmConfig) {
            await lmBenchChecks(lmConfig); // (among the bots, where botsChecks left the character)
        }
        const start = position();
        clickGame(627 + 18, 85 + 8); // minimap, a few tiles east/south (the minimap keeps its classic coordinates)
        const moved = await waitFor(() => !same(position(), start), 8000);
        const end = await stablePosition();
        check('player walks (minimap click)', moved.ok, `${JSON.stringify(start)} → ${JSON.stringify(end)}`);
        await shot('walked');
        if (hudShown) {
            await worldMapChecks();
        }

        const fpsFrom = performance.now();
        const fps = await fpsOver(10000);
        check('client frame rate', fps >= 25, `${fps} fps (target ${c().tfps ?? '?'})`);
        out(`INFO the engine's tick as the page sees it, those 10 s: ${JSON.stringify(tickTiming(fpsFrom))}`);

        const saved = await window.LostCityHost.lifecycle('save');
        const entry = await saveIndexEntry();
        check('save writes the player file', saved?.ok === true && entry?.size > 0, JSON.stringify({ reply: saved, entry }));

        recordLifecycle();
        for (const seconds of [5, 25]) { // (under a 30 s auto-lock: the phone must stay unlocked while in Settings)
            const stream = c().stream;
            const before = lifecycleEvents.length;
            out(`ACTION background ${seconds}`);
            const back = await waitFor(() => lifecycleEvents.slice(before).some(e => e.event === 'foreground' || e.event === 'resume'), (seconds + 60) * 1000, 250);
            const paused = lifecycleEvents.slice(before).some(e => ['pause', 'background', 'terminate'].includes(e.event));
            await sleep(4000);
            check(`background ${seconds} s: pause + resume, session kept`, back.ok && paused && c().ingame && c().stream === stream && !/connection lost/i.test(`${c().loginMes1}${c().loginMes2}`), JSON.stringify({ events: lifecycleEvents.slice(before).map(e => e.event), ingame: c().ingame, sameStream: c().stream === stream }));
        }
        await shot('after-background');

        const stream = c().stream;
        stream?.socket?.close?.();
        const reconnected = await waitFor(() => c().ingame && c().stream && c().stream !== stream, 30000, 250);
        check('dropped connection reconnects', reconnected.ok, `${reconnected.ms} ms`);
        out('ACTION measure after-play');

        const pos = await stablePosition();
        const saved2 = await window.LostCityHost.lifecycle('save');
        check('save before reload', saved2?.ok === true, JSON.stringify(saved2));
        try {
            sessionStorage.setItem(STATE_KEY, JSON.stringify({ phase: 'B', pos, pass, fail }));
        } catch (e) {
            out(`INFO sessionStorage unavailable (${e}); skipping the reload phase`);
            return finish();
        }
        out('INFO reloading the page');
        location.reload();
    }

    async function phaseB(state) {
        pass = state.pass;
        fail = state.fail;
        out('INFO phase B (after reload)');
        if ((window.LostCityHost?.settings?.bots ?? 0) > 0) {
            const title = await waitFor(() => c()?.lastProgressPercent === 100 && c()?.titleFlames && window.LostCityHost?.engineState === 'ready', 120000);
            if (title.ok) {
                await titleChecks();
            }
        }
        if (!(await login('any-password'))) {
            return finish();
        }
        await sleep(1500);
        check('re-login restores the saved position', same(position(), state.pos), `saved ${JSON.stringify(state.pos)} → now ${JSON.stringify(position())}`);
        await shot('relogin');
        if ((window.LostCityHost?.settings?.bots ?? 0) > 0) {
            out(`INFO bots after the reload: ${describeCrowd(await watchPlayers(20000, 2000))}`);
        }

        const warned = await debug('memory-warning');
        void warned;
        await sleep(1000);
        check('still in game after a memory warning', c().ingame === true);
        await savedDataChecks();
        finish();
    }

    // A page write's bytes as the app's router takes them: on Android base64url (no padding) in X-LC-Body with the count
    // in X-LC-Length and no body (its request interception never sees one: docs/ANDROID.md §3.2), else the body.
    function writeBody(buffer) {
        if (window.LostCityNative?.platform !== 'android') {
            return { body: buffer };
        }
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return { headers: { 'X-LC-Body': encoded, 'X-LC-Length': String(bytes.length) } };
    }

    // Settings › Saved data in the app: a second character (a copy of this one's save, written through the save route)
    // is deleted through the sheet and the engine (the worker's DELETE), kept as .bak, which the page then removes (a
    // fetch DELETE); the character in the world has no Delete.
    async function savedDataChecks() {
        const other = `players/${PROFILE}/lctest_del.sav`;
        const copy = await fetch(`save/players/${PROFILE}/${USER}.sav`, { cache: 'no-store' }).then(r => (r.ok ? r.arrayBuffer() : null));
        const put = copy ? await fetch(`save/${other}`, { method: 'PUT', ...writeBody(copy) }) : null;
        document.getElementById('settings').hidden = false; // (Settings, as its button opens it, on Saved data)
        document.getElementById('nav-savedata').click();
        const listed = await waitFor(() => [...document.querySelectorAll('#savedata-characters .data-row')].find(r => r.querySelector('.data-name')?.textContent === 'Lctest Del'), 5000);
        const mine = [...document.querySelectorAll('#savedata-characters .data-row')].find(r => r.querySelector('.data-name')?.textContent.toLowerCase() === USER);
        check('Saved data lists the characters, the one in the world without Delete', put?.status === 204 && listed.ok && listed.value.querySelector('button')?.disabled === false && mine?.querySelector('button')?.disabled === true, JSON.stringify({ put: put?.status, listed: listed.ok, mine: mine?.querySelector('.data-detail')?.textContent }));
        await shot('saved-data');
        if (listed.ok) {
            listed.value.querySelector('button').click();
            await sleep(300);
            const asked = document.getElementById('confirm-title').textContent;
            document.getElementById('confirm-ok').click();
            const gone = await waitFor(() => ![...document.querySelectorAll('#savedata-characters .data-name')].some(n => n.textContent === 'Lctest Del'), 5000);
            const save = await fetch(`save/${other}`, { cache: 'no-store' }).then(r => r.status);
            const bak = await fetch(`save/${other}.bak`, { cache: 'no-store' }).then(r => (r.ok ? r.arrayBuffer() : null));
            const same = !!bak && bak.byteLength === copy.byteLength && new Uint8Array(bak).every((b, i) => b === new Uint8Array(copy)[i]);
            const removed = await fetch(`save/${other}.bak`, { method: 'DELETE' }).then(r => r.status);
            check('Saved data deletes a character through the engine (kept as .bak; the page\'s DELETE removes the .bak)', asked === 'Delete Lctest Del?' && gone.ok && save === 404 && same && removed === 204, JSON.stringify({ asked, gone: gone.ok, save, bak: !!bak, same, removed }));
        }
        document.getElementById('nav-display').click();
        document.getElementById('settings-close').click();
        await sleep(300);
    }

    // ---- online mode (app-test --server, docs/ONLINE.md: autotest.json {online: {url, drift, control, passwords,
    // driftFiles}}). The run adds the server through the Add server box and its probe and plays there, through the same
    // native keyboard as offline; it goes on across reloads, a WebContent kill and (the drift server) a second launch, its
    // step in localStorage (sessionStorage does not outlive a launch). With control (app-test --engine) the driver also
    // stops the server (ACTION server stop) and starts the content-drift copy (ACTION server start drift).
    const ONLINE_KEY = 'lctest.online';
    const CAPTION = mode => `2004Scape · November 2004 · ${mode}`;
    const LOGOUT_TAB = [649, 484]; // (host.js logOutCleanly: the Logout tab, then its button, classic coordinates)
    const LOGOUT_BUTTON = [553 + 94, 205 + 170];
    // (the platform's words: the iOS run kills WebContent and native keeps passwords in the Keychain; the Android run
    // crashes the WebView's renderer, and the Keystore keeps them)
    const ANDROID_RUN = window.LostCityNative?.platform === 'android';
    const WEB_PROCESS = ANDROID_RUN ? 'the renderer' : 'WebContent';
    const KEPT_IN = ANDROID_RUN ? 'the Keystore' : 'the Keychain';
    // what the page asked native for (sockets by purpose) and what LocalOnDemand stored, since this page loaded
    const onlineSeen = { sockets: [], stored: [] };

    function onlineState() {
        try {
            return JSON.parse(localStorage.getItem(ONLINE_KEY) ?? 'null');
        } catch {
            return null;
        }
    }

    function nextOnlineStep(step, extra = {}) {
        localStorage.setItem(ONLINE_KEY, JSON.stringify({ ...onlineState(), ...extra, step, pass, fail }));
    }

    // The sockets the page opens (lcHost.openSocket: LocalOnDemand's) and its OnDemand PUTs, seen from the page.
    function watchOnline() {
        const host = window.lcHost;
        if (host && typeof host.openSocket === 'function' && !host.__lctestWrapped) {
            const open = host.openSocket;
            host.openSocket = purpose => {
                onlineSeen.sockets.push(purpose);
                return open(purpose);
            };
            host.__lctestWrapped = true;
        }
        const pageFetch = window.fetch;
        window.fetch = (input, init) => {
            const url = String(input?.url ?? input);
            if (init?.method === 'PUT' && /(^|\/)ondemand\/\d\/\d+$/.test(url)) {
                onlineSeen.stored.push(url.replace(/^.*ondemand\//, ''));
            }
            return pageFetch(input, init);
        };
    }

    const titleUp = mode => c()?.lastProgressPercent === 100 && !!c()?.titleFlames && !c().ingame && document.getElementById('loading')?.hidden === true && window.LostCityHost?.engineState === (mode === 'online' ? 'remote' : 'ready');
    const shown = id => document.getElementById(id)?.hidden === false;
    const text = id => document.getElementById(id)?.textContent ?? null;
    const inWorld = () => c()?.ingame === true && !c().reconnecting && position() !== null && c().sceneState === 2;
    const loginWords = () => `${c()?.loginMes1 ?? ''} / ${c()?.loginMes2 ?? ''}`;

    async function onlineTitle(mode, timeoutMs = 90000) {
        const up = await waitFor(() => titleUp(mode), timeoutMs);
        const native = await debug('online-state');
        out(`INFO online: the title (${mode}) ${Math.round(performance.now())} ms after navigation`);
        return { ok: up.ok, ms: Math.round(performance.now()), native, caption: text('loading-sub'), world: text('world-name') };
    }

    // The worlds sheet's Add server: native's box (filled and OK'd through its DEBUG hook, as the player would type), then
    // the page's probe of that address. True when the probe says Ready (Use on).
    async function addServer(url, name) {
        tapElement(document.getElementById('btn-world'));
        await waitFor(() => shown('worlds'), 3000);
        document.querySelector('#worlds-list .add-server')?.click();
        await sleep(1200);
        await shot(`online-add-server-${name.toLowerCase()}`);
        let box = null;
        for (let i = 0; i < 10 && !box?.shown; i++) {
            box = await debug('server-alert', { address: url.replace(/^http:\/\//, ''), name, button: 'ok' });
            if (!box?.shown) {
                await sleep(500);
            }
        }
        check(`Add server (${name}): native's box asks for the address and a name (its title, empty fields, the placeholders)`, box?.shown === true && box.title === 'Add a server' && box.address === '' && box.name === '' && box.placeholders?.[0] === '192.168.1.20 or my-mac.local:8888' && box.placeholders?.[1] === 'Optional', JSON.stringify(box));
        const address = url.replace(/^http:\/\//, '');
        const probed = await waitFor(() => shown('worlds-probe') && text('probe-address') === address && text('probe-status') !== 'Checking…', 20000);
        const use = !document.getElementById('probe-use').disabled;
        check(`...the page probes it through native (/server-probe): "${text('probe-status')}", Use on`, probed.ok && /^Ready/.test(text('probe-status')) && use, JSON.stringify({ address: text('probe-address'), notes: text('probe-notes') }));
        await shot(`online-probe-${name.toLowerCase()}`);
        return probed.ok && use;
    }

    // A login on the title through the native keyboard: New User or Existing User, the name, the "Log in" key (online: on to
    // the password field), the Remember box tapped to `remember` (null: as it comes), the password, "Log in". Resolves with
    // what the keyboard showed, once in the world or once the form says why not.
    async function onlineLogin(name, password, { newUser = false, remember = null } = {}) {
        clickGame(newUser ? 302 : 462, 291);
        const form = await waitFor(() => c().loginscreen === 2 && window.lcHost.keyboard.isShown(), 5000);
        await sleep(600);
        const hint = [c().loginMes1, c().loginMes2];
        const userKb = await keyboardState();
        await debug('type', { text: name });
        await waitFor(() => c().loginUser === name, 3000);
        await debug('bar', { button: 'submit' });
        const toPassword = await waitFor(() => c().loginSelect === 1 && window.lcHost.keyboard.context?.kind === 'login-pass', 4000);
        await sleep(500);
        const passKb = await keyboardState();
        let tapped = null;
        if (remember !== null && passKb.remember !== remember) {
            tapped = await debug('remember-tap');
            await sleep(400);
        }
        const rememberKb = await keyboardState();
        await shot(`online-password-${newUser ? 'new' : 'existing'}`);
        await debug('type', { text: password });
        await waitFor(() => c().loginPass === password, 3000);
        await debug('bar', { button: 'submit' });
        const outcome = await waitFor(() => inWorld() || (c().loginscreen === 2 && !!c().loginMes2 && !/Connecting to server/.test(loginWords()) && c().loginMes1 !== hint[0]), 30000);
        return { form: form.ok, hint, userKb, passKb, tapped, rememberKb, toPassword: toPassword.ok, outcome: outcome.ok, ingame: inWorld(), words: loginWords() };
    }

    // "Continue as" on the title (native gives the kept password: account login), into the world; a login the server still
    // refuses as "already logged in" (its 60 s after a dropped session) is tried again every 5 s as a player would.
    async function continueAs(timeoutMs = 30000) {
        tapElement(document.getElementById('btn-continue'));
        const started = performance.now();
        let tries = 1;
        for (;;) {
            const done = await waitFor(() => inWorld() || /already logged in/i.test(loginWords()), Math.max(1000, timeoutMs - (performance.now() - started)), 250);
            if (!done.ok || inWorld() || performance.now() - started > timeoutMs) {
                break;
            }
            await sleep(5000);
            tries++;
            window.LostCityHost.keyboard.submit(); // (the form keeps the name and the password native gave: "Log in" again)
            await waitFor(() => !/already logged in/i.test(loginWords()), 3000, 100);
        }
        return { ingame: inWorld(), tries, ms: Math.round(performance.now() - started), words: loginWords() };
    }

    async function logOut() {
        const out = () => c().ingame === false && !c().reconnecting;
        let pressed = -Infinity;
        const started = performance.now();
        while (performance.now() - started < 8000 && !out()) {
            if (c().hudState().activeTab !== 10) {
                c().tapAt(...LOGOUT_TAB, 1);
            } else if (performance.now() - pressed >= 1000) {
                pressed = performance.now();
                c().tapAt(...LOGOUT_BUTTON, 1);
            }
            await sleep(150);
        }
        return (await waitFor(() => out() && document.getElementById('hud')?.hidden === true, 10000)).ok;
    }

    const command = async line => {
        window.LostCityHost.keyboard.insertText(`${line}\n`); // (as the native keyboard types a chat line)
        await sleep(1500);
    };

    // A Banker at Draynor: tapped (his top option, Talk-to), his dialogue continued to "I'd like to access my bank
    // account, please.", which opens the bank. Bankers stand behind the booths, so a tap on one walks to the booth.
    async function talkToBanker() {
        const bankers = () => {
            const list = [];
            for (let i = 0; i < c().npcCount; i++) {
                const npc = c().npc[c().npcIds[i]];
                if (npc?.type?.name === 'Banker') {
                    list.push(npc);
                }
            }
            return list;
        };
        let talked = { ok: false };
        const tried = [];
        for (let attempt = 0; attempt < 6 && !talked.ok; attempt++) {
            for (const npc of bankers()) {
                c().getOverlayPos(npc.x, npc.z, ((npc.height || 100) / 2) | 0);
                if (c().projectX < 0) {
                    continue;
                }
                const x = c().viewportX + c().projectX;
                const y = c().viewportY + c().projectY;
                c().tapAt(x, y, 1);
                await sleep(200);
                tried.push(`${x},${y}: ${c().menuOption?.[c().menuNumEntries - 1] ?? '?'}`);
                talked = await waitFor(() => c().hudState().chatContinue, 8000);
                if (talked.ok) {
                    break;
                }
            }
            if (!talked.ok) {
                await sleep(1500);
            }
        }
        const greeting = talked.ok;
        await shot('online-banker');
        let chosen = false;
        if (greeting) {
            c().hudContinue();
            const asked = await waitFor(() => c().hudDialog()?.options.find(o => /access my bank account/.test(o.text)), 5000);
            if (asked.ok) {
                const o = asked.value;
                c().tapAt(o.x + o.w / 2, o.y + o.h / 2, 1);
                chosen = true;
                const said = await waitFor(() => c().hudState().chatContinue, 5000);
                if (said.ok) {
                    c().hudContinue();
                }
            }
        }
        const bank = await waitFor(() => c().mainModalId !== -1 && c().chatModalId === -1, 8000);
        check('online: a tap on a Banker talks to him (Talk-to over the bridge), his dialogue answered, the bank opens', greeting && chosen && bank.ok, JSON.stringify({ greeting, chosen, bank: bank.ok, modal: c().mainModalId, tried: tried.slice(0, 6) }));
        await shot('online-bank');
        c().closeModal();
        await sleep(800);
        return bank.ok;
    }

    // The app to the background (the driver opens Settings) for `seconds`, back, and what became of the session: kept (the
    // same socket), the client's reconnect (opcode 18, a new socket), or the server's logout (the title).
    async function backgroundOnline(seconds) {
        const stream = c().stream;
        const pos = position();
        const before = lifecycleEvents.length;
        out(`ACTION background ${seconds}`);
        const back = await waitFor(() => lifecycleEvents.slice(before).some(e => e.event === 'foreground' || e.event === 'resume'), (seconds + 60) * 1000, 250);
        await sleep(8000); // (a socket that died while suspended is noticed by the client's next read or write)
        await waitFor(() => inWorld() || (c().ingame === false && !c().reconnecting), 40000, 250);
        await sleep(2000);
        const outcome = inWorld() ? (c().stream === stream ? 'kept' : 'reconnected') : 'logged out';
        out(`INFO online: background ${seconds} s: ${outcome} (${JSON.stringify({ events: lifecycleEvents.slice(before).map(e => e.event), pos: position(), was: pos, words: loginWords() })})`);
        return { back: back.ok, outcome, was: pos };
    }

    // The game socket's bytes over `seconds` (the messages both ways as the page hands them to native and gets them back:
    // the WebSocket, TCP and IP framing come on top), standing or walking to and fro on the minimap every 4.5 s.
    async function gameTraffic(seconds, walk) {
        const counts = { sent: 0, received: 0, messagesOut: 0, messagesIn: 0 };
        const proto = window.WebSocket.prototype;
        const { send, _event: event } = proto;
        proto.send = function (data) {
            if (this.purpose === 'game' && this.readyState === 1) {
                counts.sent += data?.byteLength ?? 0;
                counts.messagesOut++;
            }
            return send.call(this, data);
        };
        proto._event = function (e) {
            if (this.purpose === 'game' && e?.event === 'message' && typeof e.data === 'string') {
                counts.received += (e.data.length * 3) / 4 - (e.data.endsWith('==') ? 2 : e.data.endsWith('=') ? 1 : 0);
                counts.messagesIn++;
            }
            return event.call(this, e);
        };
        const started = performance.now();
        let leg = 0;
        try {
            while (performance.now() - started < seconds * 1000) {
                if (walk) {
                    leg++;
                    clickGame(627 + (leg % 2 ? -18 : 18), 85 + (leg % 2 ? -8 : 8)); // (back and forth: the first walk's way)
                }
                await sleep(walk ? 4500 : 1000);
            }
        } finally {
            proto.send = send;
            proto._event = event;
        }
        const minutes = (performance.now() - started) / 60000;
        return { ...counts, seconds: Math.round(minutes * 60), perMinute: { sent: Math.round(counts.sent / minutes), received: Math.round(counts.received / minutes) }, walks: leg };
    }

    async function onlineRun(config) {
        recordLifecycle();
        const state = onlineState();
        if (state) {
            pass = state.pass;
            fail = state.fail;
        }
        const step = state?.step ?? 'add';
        out(`INFO online: step ${step} (${config.url}${config.control ? `, the run controls the engine; drift ${config.drift}` : ''})`);
        const steps = { add: onlineAdd, play: onlinePlay, crashed: onlineCrashed, offline: onlineOffline, back: onlineBack, down: onlineDown, 'down-offline': onlineDownOffline, drift: onlineDrift, 'drift-again': onlineDriftAgain };
        await (steps[step] ?? onlineAdd)(config, state ?? {});
    }

    // 1. A new app: this phone's world on the title; the server added (the box, the probe) and Use: the page reloads there.
    async function onlineAdd(config) {
        const title = await onlineTitle('offline', 120000);
        check('online: a new app starts on this phone (the title offline, World "This phone", the cover offline)', title.ok && title.world === 'This phone' && title.caption === CAPTION('offline') && title.native?.server === null, JSON.stringify(title));
        if (!title.ok || !(await addServer(config.url, 'Mac'))) {
            return finish();
        }
        nextOnlineStep('play');
        document.getElementById('probe-use').click(); // (this phone's world saved first, as Restart; then native reloads)
        await sleep(30000);
        check('online: Use plays on the server (the page reloads)', false, 'no reload 30 s after Use');
        finish();
    }

    // 2. On the server: the title with no engine; a new character with a password and Remember; play (walk, a Banker, the
    // bank); the background around the server's limits; the logout and "Continue as" (the Keychain); WebContent killed.
    async function onlinePlay(config) {
        const title = await onlineTitle('online');
        const server = window.LostCityHost?.settings?.server;
        check('online: the page on the server: the title with no engine on the page (no worker, engineState remote)', title.ok && engine.worker === null && server !== 'offline', JSON.stringify({ ms: title.ms, server, worker: !!engine.worker }));
        check('online: native plays this page load on the server (online-state: its id and URL) and its cover said "online", as the page', title.native?.server === server && title.native?.url === config.url && title.native?.caption === CAPTION('online') && title.caption === CAPTION('online') && title.world === 'Mac', JSON.stringify(title));
        await shot('online-title');
        if (!title.ok) {
            return finish();
        }
        const name = `${ANDROID_RUN ? 'and' : 'ios'}${String(Date.now()).slice(-7)}`;
        const login = await onlineLogin(name, config.passwords[0], { newUser: true, remember: true });
        check('New User online: the form says "Type a name and a password. / Your server may ask you to register first."', login.form && login.hint[0] === 'Type a name and a password.' && login.hint[1] === 'Your server may ask you to register first.', JSON.stringify(login.hint));
        check('the username\'s "Log in" key goes on to the password field; its bar has the Remember box (off the first time), no box for the name', login.toPassword && login.userKb.remember === null && login.passKb.kind === 'login-pass' && login.passKb.secure === true && login.passKb.remember === false, JSON.stringify({ user: login.userKb.remember, pass: [login.passKb.kind, login.passKb.secure, login.passKb.remember] }));
        check('a tap on the Remember box ticks it (and the page\'s next update keeps it)', login.tapped === true && login.rememberKb.remember === true, JSON.stringify({ tapped: login.tapped, now: login.rememberKb.remember }));
        check('a password login through the native keyboard and the socket bridge reaches the game', login.ingame, login.words);
        if (!login.ingame) {
            return finish();
        }
        await sleep(1500);
        await enterWorld();
        // (off Tutorial Island: the stock engine's characters are staff, debug on; the tutorial's interfaces go with a
        // new login, which is also the logout and "Continue as" below)
        await command('::setvar tutorial 1000');

        const out1 = await logOut();
        await sleep(800);
        const titled = { continueAs: shown('btn-continue') && text('continue-name'), accounts: shown('btn-accounts') };
        tapElement(document.getElementById('btn-accounts'));
        await waitFor(() => shown('accounts'), 3000);
        const rows = [...document.querySelectorAll('#accounts-list .data-row')].map(r => ({ name: r.querySelector('.data-name')?.textContent, key: !!r.querySelector('.key-mark') }));
        await shot('online-accounts');
        document.getElementById('accounts-close').click();
        await sleep(300);
        check(`the Logout tab logs out; the title offers "Continue as" the name, and Accounts marks it with a key (Remember: the password in ${KEPT_IN})`, out1 && titled.continueAs === name && titled.accounts && rows.length === 1 && rows[0].name === name && rows[0].key, JSON.stringify({ out: out1, titled, rows }));
        const again = await continueAs();
        const kb = await keyboardState();
        check(`"Continue as": native gives the password from ${KEPT_IN} (account login) and the page logs in, no keyboard`, again.ingame && again.tries === 1 && kb.requested === false, JSON.stringify({ again, kb: kb.requested }));
        if (!again.ingame) {
            return finish();
        }
        await sleep(1500);
        await command('::tele 0,48,50,20,43'); // (Draynor's bank, east of the booths)
        await stablePosition();
        await shot('online-ingame');
        out('ACTION measure online-ingame');

        const start = position();
        clickGame(627 + 18, 85 + 8); // (the minimap, a few tiles east and south)
        const moved = await waitFor(() => !same(position(), start), 8000);
        const end = await stablePosition();
        check('online: the player walks (a minimap tap, the server moves him)', moved.ok, `${JSON.stringify(start)} → ${JSON.stringify(end)}`);
        await talkToBanker();
        const fps = await fpsOver(5000);
        out(`INFO online: the client's frame rate in Draynor's bank: ${fps} fps`);
        // (the game socket's traffic, a minute standing and a minute walking: docs/ONLINE.md's note on mobile data)
        for (const walk of [false, true]) {
            out(`INFO online: traffic ${walk ? 'walking' : 'standing'} ${JSON.stringify(await gameTraffic(60, walk))}`);
        }
        await stablePosition();
        out('ACTION measure online-after-play');

        for (const seconds of [5, 25, 45, 70]) {
            const bg = await backgroundOnline(seconds);
            if (seconds < 60) {
                // (Engine-TS keeps a session 60 s without a packet; with debug on, as here, it never asks an idle logout)
                check(`online: background ${seconds} s (under the server's 60 s): still in the world, in the same place (${bg.outcome})`, bg.back && bg.outcome !== 'logged out' && same(position(), bg.was), JSON.stringify({ ...bg, now: position() }));
            } else {
                // (over 60 s the server may have logged the character out: the client's reconnect logs in afresh, or the title)
                const back = bg.outcome === 'logged out' ? await continueAs(90000) : { ingame: true };
                await stablePosition();
                check(`online: background ${seconds} s (over the server's 60 s): back in the world where he was (${bg.outcome}${bg.outcome === 'logged out' ? ', then "Continue as"' : ''})`, bg.back && back.ingame && same(position(), bg.was), JSON.stringify({ ...bg, back, now: position() }));
            }
            if (!inWorld()) {
                return finish();
            }
        }
        await shot('online-after-background');
        await sleep(2000);
        nextOnlineStep('crashed', { name, pos: position() });
        if (ANDROID_RUN) {
            // (the emulator has no root to kill the isolated renderer: native crashes it, a real onRenderProcessGone)
            await debug('renderer-crash');
        } else {
            out('ACTION kill-webcontent');
        }
        await sleep(30000);
        check(`online: ${WEB_PROCESS} killed`, false, 'the page still runs 30 s after the request');
        finish();
    }

    // 3. After WebContent died in game: native's restart notice says to log in again; "Continue as" (the server may still
    // hold the dropped session up to 60 s: "already logged in" until then); then to this phone's world from the game.
    async function onlineCrashed(config, state) {
        const title = await onlineTitle('online');
        const notice = await debug('last-notice');
        check(`online: after ${WEB_PROCESS} died the page comes back on the server (cover online), and native says "You will need to log in again."`, title.ok && title.caption === CAPTION('online') && /You will need to log in again\.$/.test(String(notice ?? '')), JSON.stringify({ title, notice }));
        const again = await continueAs(100000);
        await stablePosition();
        check('...and "Continue as" logs in again (after the server let the dropped session go), where he was', again.ingame && same(position(), state.pos), JSON.stringify({ again, pos: position(), was: state.pos }));
        await shot('online-relogin');
        if (!again.ingame) {
            return finish();
        }
        await sleep(1500);
        // Settings › World › Change, This phone: the page logs out through the game, then native reloads offline
        tapElement(document.getElementById('btn-settings'));
        await waitFor(() => shown('settings'), 3000);
        document.getElementById('nav-world').click();
        await sleep(300);
        const playOn = text('world-playon-name');
        await shot('online-settings-world');
        document.getElementById('world-change').click();
        await waitFor(() => shown('worlds'), 3000);
        const rows = [...document.querySelectorAll('#worlds-list .world-row')].map(r => `${r.querySelector('.character-name').textContent} | ${r.querySelector('.character-when').textContent}`);
        check(`online: Settings › World "Play on Mac (${lcServerUrl.address(config.url)})", Change: the worlds, This phone first, Mac "Playing now"`, playOn === `Mac (${lcServerUrl.address(config.url)})` && rows[0]?.startsWith('This phone') && /^Mac \| Playing now/.test(rows[1] ?? ''), JSON.stringify({ playOn, rows }));
        nextOnlineStep('offline');
        document.querySelector('#worlds-list .world-row:nth-child(1) .title-btn').click();
        await sleep(30000);
        check('online -> offline in game: the page logs out and reloads on this phone', false, `still here 30 s after This phone (${c().ingame ? 'in game' : 'logged out'})`);
        finish();
    }

    // 4. This phone's world again (the engine on the page); then back to the server from the title.
    async function onlineOffline() {
        const title = await onlineTitle('offline', 120000);
        check('online -> offline in game: logged out, the page on this phone again (the engine, the cover offline, World "This phone")', title.ok && engine.worker !== null && title.caption === CAPTION('offline') && title.native?.server === null && title.world === 'This phone', JSON.stringify(title));
        tapElement(document.getElementById('btn-world'));
        await waitFor(() => shown('worlds'), 3000);
        nextOnlineStep('back');
        document.querySelector('#worlds-list .world-row:nth-child(2) .title-btn').click();
        await sleep(30000);
        check('offline -> online from the title: the page reloads on the server', false, 'still here 30 s after the server\'s row');
        finish();
    }

    // 5. On the server again: the first "Continue as" logs in at once (the logout when leaving was clean); then, with the
    // engine under the run's control, the server stopped.
    async function onlineBack(config, state) {
        const title = await onlineTitle('online');
        const again = title.ok ? await continueAs(15000) : { ingame: false };
        check('offline -> online from the title: on the server again, and "Continue as" logs in at the first try (the earlier logout was clean)', title.ok && title.caption === CAPTION('online') && again.ingame && again.tries === 1, JSON.stringify({ title, again }));
        if (again.ingame) {
            await logOut();
        }
        if (!config.control) {
            out('INFO online: the server stopped and the drift server need app-test --engine (skipped)');
            return finish();
        }
        out('ACTION server stop');
        const down = await probeUntil(config.url, false, 60000);
        nextOnlineStep('down');
        out(`INFO online: the server is down (${down ? 'its probe fails' : 'its probe still answers'}): reloading`);
        location.reload();
    }

    // The probe (native /server-probe) until its ok is `ok`, or the time is up.
    async function probeUntil(url, ok, timeoutMs) {
        const started = performance.now();
        while (performance.now() - started < timeoutMs) {
            const probe = await fetch(`server-probe?url=${encodeURIComponent(url)}`, { cache: 'no-store' })
                .then(r => r.json())
                .catch(() => null);
            if (probe && probe.ok === ok) {
                return true;
            }
            await sleep(1000);
        }
        return false;
    }

    // 6. The server down: the unreachable box within seconds, Play offline.
    async function onlineDown() {
        const box = await waitFor(() => shown('unreachable'), 20000, 100);
        const said = { ms: Math.round(performance.now()), title: text('unreachable-title'), text: text('unreachable-text') };
        await shot('online-unreachable');
        check('online, the server down: within seconds the box "Could not connect to Mac", it cannot be reached (Try again, Play offline, Choose world)', box.ok && said.ms < 10000 && said.title === 'Could not connect to Mac' && /cannot be reached/.test(said.text ?? ''), JSON.stringify(said));
        nextOnlineStep('down-offline');
        document.getElementById('unreachable-offline').click();
        await sleep(30000);
        check('online, the server down: Play offline reloads on this phone', false, 'no reload 30 s after Play offline');
        finish();
    }

    // 7. Play offline worked; then a server whose game data moved on (the drift copy) is added and used.
    async function onlineDownOffline(config) {
        const title = await onlineTitle('offline', 120000);
        check('online, the server down: Play offline: this phone\'s world (the engine, the cover offline)', title.ok && engine.worker !== null && title.caption === CAPTION('offline') && window.LostCityHost?.settings?.server === 'offline', JSON.stringify(title));
        if (!config.drift) {
            return finish();
        }
        out('ACTION server start drift');
        const up = await probeUntil(config.drift, true, 240000);
        if (!up || !(await addServer(config.drift, 'Drift'))) {
            check('online: the drift server starts', up);
            return finish();
        }
        nextOnlineStep('drift');
        document.getElementById('probe-use').click();
        await sleep(30000);
        check('online: Use plays on the drift server (the page reloads)', false, 'no reload 30 s after Use');
        finish();
    }

    async function onlineCache() {
        const files = await debug('online-cache');
        return Array.isArray(files) ? files : [];
    }

    // 8. The drift server: its versionlist (another CRC) downloaded, the moved animations fetched over the OnDemand socket
    // and kept in the app's cache, at the title; in game a new character's models and the map of 48_48 too.
    async function onlineDrift(config) {
        const title = await onlineTitle('online', 120000);
        const id = window.LostCityHost?.settings?.server;
        const files = await onlineCache();
        const mine = files.filter(f => f.startsWith(`${id}/`)).map(f => f.slice(id.length + 1));
        const anims = config.driftFiles.anims.filter(f => mine.includes(`od/1/${f}`));
        check('drift: at the title, the server\'s versionlist (its own CRC) downloaded and cached, its 3 moved animations fetched over the OnDemand socket and cached', title.ok && title.world === 'Drift' && mine.some(f => /^versionlist-?\d+$/.test(f)) && onlineSeen.sockets.includes('ondemand') && anims.length === 3, JSON.stringify({ title: title.ok, sockets: onlineSeen.sockets, stored: onlineSeen.stored.slice(0, 8), cached: mine.slice(0, 12) }));
        if (!title.ok) {
            return finish();
        }
        const name = `dr${String(Date.now()).slice(-7)}`;
        const login = await onlineLogin(name, config.passwords[1], { newUser: true });
        const scene = login.ingame ? await waitFor(() => c().sceneState === 2, 30000) : { ok: false };
        await sleep(2000);
        await shot('online-drift-ingame');
        const after = (await onlineCache()).filter(f => f.startsWith(`${id}/`)).map(f => f.slice(id.length + 1));
        const map = after.includes(`od/3/${config.driftFiles.map}`);
        const models = after.filter(f => f.startsWith('od/0/')).length;
        check('drift: in game, the new character\'s models and the land of 48_48 (other versions) came from the server and went to the cache; the scene built', login.ingame && scene.ok && map && models > 0, JSON.stringify({ words: login.words, scene: scene.ok, map, models }));
        if (login.ingame) {
            await logOut();
        }
        nextOnlineStep('drift-again', { driftName: name, driftCache: after.length });
        if (ANDROID_RUN) {
            // (Chromium commits localStorage to disk up to 5 s after a write, and the driver's relaunch stops the app's
            // process: the next launch would start this step again)
            await sleep(8000);
        }
        out('ACTION relaunch');
        await sleep(60000);
        check('drift: the app launched again', false, 'no relaunch 60 s after the request');
        finish();
    }

    // 9. The next launch: everything from the app's cache, no OnDemand socket, at the title and in game.
    async function onlineDriftAgain(config, state) {
        const title = await onlineTitle('online', 120000);
        check('drift, the next launch: the title takes the moved files from the app\'s cache (no OnDemand socket)', title.ok && !onlineSeen.sockets.includes('ondemand') && onlineSeen.stored.length === 0, JSON.stringify({ title: title.ok, sockets: onlineSeen.sockets, stored: onlineSeen.stored }));
        const login = title.ok ? await onlineLogin(state.driftName, config.passwords[1]) : { ingame: false };
        const scene = login.ingame ? await waitFor(() => c().sceneState === 2, 30000) : { ok: false };
        await sleep(1500);
        await shot('online-drift-again');
        const cached = (await onlineCache()).filter(f => f.startsWith(`${window.LostCityHost?.settings?.server}/`)).length;
        check('drift, the next launch: in game the models and the map from the cache too (no OnDemand socket, nothing new stored)', login.ingame && scene.ok && !onlineSeen.sockets.includes('ondemand') && onlineSeen.stored.length === 0 && cached === state.driftCache, JSON.stringify({ words: login.words, scene: scene.ok, sockets: onlineSeen.sockets, cached, before: state.driftCache }));
        if (login.ingame) {
            await logOut();
        }
        finish();
    }

    async function finish() {
        try {
            sessionStorage.removeItem(STATE_KEY);
            localStorage.removeItem(ONLINE_KEY);
        } catch {
            // ignore
        }
        await restoreBots().catch(error => out(`INFO bots: setting the Bots setting back failed: ${error}`));
        out(`DONE pass=${pass} fail=${fail}`);
    }

    function start() {
        let state = null;
        try {
            state = JSON.parse(sessionStorage.getItem(STATE_KEY) ?? 'null');
            if (sessionStorage.getItem('lctest.lmbench') !== null) {
                // the page was loaded again during the lm-bench: its WebContent process was terminated
                sessionStorage.removeItem('lctest.lmbench');
                check('lm-bench gate: no WebContent termination', false, 'the page was reloaded during the bench');
                finish();
                return;
            }
            const soakPhaseRunning = sessionStorage.getItem(SOAK_KEY);
            if (soakPhaseRunning !== null) {
                // the page was loaded again during a soak's phase (its WebContent process was terminated)
                sessionStorage.removeItem(SOAK_KEY);
                check('soak: the page is not reloaded during a phase', false, `reloaded during ${soakPhaseRunning}`);
                finish();
                return;
            }
        } catch {
            state = null;
        }
        watchOnline(); // (it only counts; the offline run never opens a socket or stores an OnDemand file)
        // (app-test --server: the online run instead of the checks below)
        const run = readConfig().then(config => (config?.online ? onlineRun(config.online) : state?.phase === 'B' ? phaseB(state) : wantedBots().then(applyBots).then(go => (go ? phaseA() : undefined))));
        run.catch(error => {
            check('autotest script', false, String(error?.stack ?? error));
            finish();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
