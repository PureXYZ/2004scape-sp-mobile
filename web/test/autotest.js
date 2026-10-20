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
(() => {
    'use strict';

    const USER = 'autotest';
    // the save profile the run plays in (app-test --profile: players/<profile>/, bots/<profile>/; host.js PROFILE)
    const PROFILE = typeof window.__lcTestProfile === 'string' ? window.__lcTestProfile : 'main';
    const STATE_KEY = 'lctest.state';
    const BOTS_KEY = 'lctest.bots'; // the Bots setting this run restarted the page for
    const BOTS_BEFORE_KEY = 'lctest.botsBefore'; // {bots, jmod}: the settings the app had before this run changed them
    // (the app's handler as host.js picks it: WKWebView's on iOS, the Android app's bridge there: docs/ANDROID.md §3.1)
    const native = (window.webkit?.messageHandlers ?? window.LostCityNativeBridge)?.native ?? null;

    // ---- the engine worker's messages, seen by a wrapper around the page's Worker (this script runs before host.js
    // starts the engine on DOMContentLoaded): what the page asks for (init), what the engine says it loaded (booted,
    // ready), its error lines, and when its data arrives (in game: one message per tick, at the end of the tick)
    const engine = { init: null, booted: null, ready: null, errors: [], arrivals: [] };
    const PageWorker = window.Worker;
    window.Worker = class extends PageWorker {
        constructor(...args) {
            super(...args);
            this.addEventListener('message', event => {
                const msg = event.data;
                if (msg?.type === 'data') {
                    engine.arrivals.push(performance.now());
                    if (engine.arrivals.length > 4096) {
                        engine.arrivals.splice(0, 2048);
                    }
                } else if (msg?.type === 'booted' || msg?.type === 'ready') {
                    engine[msg.type] = { ...msg };
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
        // the bots' checks teleport the character with ::tele: with Settings › World › Jmod Off the run turns it on too
        const jmodOff = wanted > 0 && window.LostCityHost?.settings?.jmod === false;
        if ((current !== wanted || jmodOff) && !restarted) {
            const values = { bots: wanted, ...(jmodOff ? { jmod: true } : {}) };
            try {
                sessionStorage.setItem(BOTS_KEY, String(wanted));
                sessionStorage.setItem(BOTS_BEFORE_KEY, JSON.stringify({ bots: Number.isInteger(current) ? current : 0, ...(jmodOff ? { jmod: false } : {}) })); // (set back at the end)
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

    // The Bots setting as it was before the run changed it (applyBots), stored natively again; the page that runs now
    // keeps its own until it restarts. Nothing if the run did not change it.
    async function restoreBots() {
        let saved = null;
        try {
            saved = JSON.parse(sessionStorage.getItem(BOTS_BEFORE_KEY) ?? 'null');
            sessionStorage.removeItem(BOTS_BEFORE_KEY);
        } catch {
            saved = null;
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

    async function phaseA() {
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

        // Tutorial Island's first login opens the character designer; accept it, then walk with the minimap.
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

    async function finish() {
        try {
            sessionStorage.removeItem(STATE_KEY);
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
        } catch {
            state = null;
        }
        const run = state?.phase === 'B' ? phaseB(state) : wantedBots().then(applyBots).then(go => (go ? phaseA() : undefined));
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
