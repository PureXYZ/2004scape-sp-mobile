#!/usr/bin/env node
// End-to-end test of build/Game in headless Chrome (iPhone 13 mini landscape emulation, touch input):
// boot → title screen → login through the keyboard bridge → in game → save → pause/resume (no disconnect) →
// dropped-connection reconnect → reload → re-login restores the saved position.
//
//   node web/test/e2e.mjs [--port 47510] [--keep] [--game <dir>] [--bots N] [--no-jmod] [--lm-stub] [--platform android]
//   (build first: node scripts/build-web.mjs [--debug])
//
// --bots N: the world runs N bots (Settings › World › Bots, stored before the page loads the way the page keeps its
// settings outside the app; docs/BOTS.md). The character goes to Lumbridge, where the bots start, and the run adds
// the bots' checks: the page asks for them, the engine loads its bots bundle, other players appear, the bots' saves go
// to bots/<profile>/bots.sav (lifecycle saves say so: bots {ok}) and never into the title's Characters list, a bots.sav
// that cannot be written makes Settings › Restart wait, a restart goes on with the same bots, no engine errors, no
// "bots are off" notice; last, a session with bots.sav and its .bak damaged runs without the bots and says so in the
// status line. --bots 0: bots off, said explicitly: the plain engine, nobody else in the world, nothing read or written
// under bots/, no notice. Without --bots the run is the usual one.
//
// Last, Settings › Saved data (every run): a second character is deleted (the one in the world cannot be), Reset world
// (with a bots' store: the store goes, the character stays) and Delete everything restart the game with those saves gone.
//
// --no-jmod: Settings › World › Jmod Off (stored before the page loads, like --bots): the character is a normal player
// (staff level 0 in the client, no "::" chips on the chat keyboard). Every run checks the staff level it asked for.
//
// --lm-stub: the bots' chat model's relay (docs/ARCHITECTURE.md §7.1) with a stub "native" in the page (a fake
// webkit.messageHandlers.native that answers {type:'lm'} through LostCityHost.bots.lmReply and keeps a key's status), and
// the bots on (10 unless --bots says otherwise): the player's choice reaches the engine before its world starts and on
// every change (bots-lm-mode); a request posted from inside the engine worker (CDP, the worker's own global) goes to
// native with its prompts and native's line comes back to the worker (bots-lm-reply, with ms); Settings › Bot chat (the
// model, Think first: shown only for a model that offers it, every On-device request carrying think as the setting
// says at once, greyed out with Claude online (think false), kept across a reload; Set key, Test, Remove); Rules, no native, a failed reply and a reply that never comes are
// answered for the engine; with the bots off the engine hears nothing of it. Only these checks (no login): a short run.
//
// --platform android: the page as the Android app runs it (docs/ANDROID.md §3), in desktop Chrome: an Android phone's
// screen (914x411 CSS px at 2.625) and WebView's user agent, and before host.js, on every load, what the app's
// document-start script defines: window.LostCityNative {platform:'android', …, settings: the harness's, kept in
// localStorage as the app keeps them}, window.LostCityNativeBridge (the contract's shape, posting {ch, msg} JSON) and a
// stub of the app's message listener object, lcAndroid, that records what it is sent and answers nothing. The run adds:
// the engine is told platform 'android'; every save reaches serve.mjs in X-LC-Body + X-LC-Length with no body (one
// "[serve] … in X-LC-Body" line each); the page's messages (ready, status, keyboard) go through the bridge; pause and
// resume go through window.__lcCall as the app calls them, and its replies ({ch:'reply'}, 'missing', none for id 0) reach
// lcAndroid; the page API of docs/ANDROID.md §3.3 on the title screen ({type:'loader-drawn'} after ready, the crisp
// pixel snap's HUD zoom and 800x360 world, no silent switch row, no back(), keyboard.frame's curve, audio.setMuted); and
// last, a WebView without iterator helpers gets the error that names Android System WebView (no engine), and a phone
// without a vibrator no Vibration row and no Sound category. Without it (the default, iOS-like run) every save carries a real body. Not with --lm-stub
// (its stub is iOS's webkit.messageHandlers).
//
// Exit code 0 = all checks passed. Screenshots and logs: build/tmp/e2e/ (e2e-android/ with --platform android).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ANDROID_SCREENS, ANDROID_UA, androidPageScript } from './android-stub.mjs';
import { serve } from './serve.mjs';

const IOS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const portIndex = argv.indexOf('--port');
const PORT = portIndex >= 0 ? Number(argv[portIndex + 1]) : 47510;
const platformIndex = argv.indexOf('--platform');
const PLATFORM = platformIndex >= 0 ? argv[platformIndex + 1] : 'ios';
const ANDROID = PLATFORM === 'android';
if (PLATFORM !== 'ios' && !ANDROID) {
    console.error('--platform takes ios (the default) or android');
    process.exit(2);
}
// one folder per port, so runs on different ports can go in parallel
const OUT = path.join(IOS, 'build', 'tmp', `${ANDROID ? 'e2e-android' : 'e2e'}${PORT === 47510 ? '' : `-${PORT}`}`);
const KEEP = argv.includes('--keep');
const USER = `e2e${Date.now() % 100000}`;
const botsIndex = argv.indexOf('--bots');
const LM_STUB = argv.includes('--lm-stub');
const BOTS = botsIndex >= 0 ? Number(argv[botsIndex + 1]) : LM_STUB ? 10 : null; // null: the usual run
const JMOD = !argv.includes('--no-jmod');
if (BOTS !== null && !(Number.isInteger(BOTS) && BOTS >= 0)) {
    console.error('--bots takes a number of bots (0 = off)');
    process.exit(2);
}
if (ANDROID && LM_STUB) {
    console.error('--lm-stub stubs iOS\'s webkit.messageHandlers: not with --platform android');
    process.exit(2);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const savesDir = path.join(OUT, 'saves');
const workerLines = [];
const gameIndex = argv.indexOf('--game');
const GAME = gameIndex >= 0 ? path.resolve(argv[gameIndex + 1]) : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'build', 'Game');
if (fs.existsSync(path.join(GAME, 'autotest.js'))) {
    console.error('build/Game is the self-playing autotest variant (left by app-test.mjs); run node scripts/build-web.mjs first');
    process.exit(1);
}
const saveRequests = []; // (--bots) every request to the save routes: 'METHOD /save/...'
const writes = []; // every write the save routes took: { method, path, via: 'X-LC-Body' | 'body', bytes }
const server = await serve({
    port: PORT,
    root: GAME,
    saves: savesDir,
    log: false,
    logHeaderBodies: ANDROID, // (one line per save that came in X-LC-Body)
    android: ANDROID, // (the Android router alone: a write with its bytes in a body is refused, as the app never sees it)
    onLog: text => workerLines.push(text),
    onRequest: (method, pathname) => {
        if (BOTS !== null && pathname.startsWith('/save')) {
            saveRequests.push(`${method} ${pathname}`);
        }
    },
    onWrite: write => {
        if (write.path.startsWith('/save/')) {
            writes.push(write);
        }
    }
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
function check(name, ok, detail = '') {
    checks.push({ name, ok: !!ok, detail });
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------------------------------- Chrome + CDP

const cdpPort = PORT + 1;
const chrome = spawn(
    CHROME,
    [
        '--headless=new',
        `--remote-debugging-port=${cdpPort}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${path.join(OUT, 'chrome-profile')}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
        'about:blank'
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
);

let version = null;
for (let i = 0; i < 60 && !version; i++) {
    await sleep(200);
    try {
        version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
    } catch {
        // not up yet
    }
}
if (!version) {
    console.error('Chrome did not start');
    chrome.kill();
    process.exit(2);
}

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
let nextId = 0;
const pending = new Map();
const consoleLines = [];
let workerSession = null; // (--lm-stub) the engine worker's CDP session, from Target.attachedToTarget
ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
    }
    if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'worker') {
        workerSession = msg.params.sessionId;
    } else if (msg.method === 'Target.detachedFromTarget' && msg.params.sessionId === workerSession) {
        workerSession = null;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
        consoleLines.push(`[${msg.params.type}] ${msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
        consoleLines.push(`[exception] ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    } else if (msg.method === 'Log.entryAdded') {
        consoleLines.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
    }
});
const send = (method, params = {}, sessionId) =>
    new Promise(resolve => {
        const id = ++nextId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

const { result: target } = await send('Target.createTarget', { url: 'about:blank' });
const { result: attached } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
const S = (method, params) => send(method, params, attached.sessionId);
await S('Runtime.enable');
await S('Log.enable');
await S('Page.enable');
if (ANDROID) {
    // the Android reference screen (the AVD's: 2400x1080 at 2.625) and WebView 145's reduced user agent
    const screen = ANDROID_SCREENS['a-medium'];
    await S('Emulation.setDeviceMetricsOverride', { width: screen.view.width, height: screen.view.height, deviceScaleFactor: screen.dpr, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
    await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await S('Emulation.setUserAgentOverride', { userAgent: ANDROID_UA });
} else {
    await S('Emulation.setDeviceMetricsOverride', { width: 812, height: 375, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
    await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await S('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' });
}

async function evaluate(expression) {
    const reply = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (reply.result?.exceptionDetails) {
        throw new Error(`evaluate failed: ${reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text}`);
    }
    return reply.result?.result?.value;
}

async function screenshot(name) {
    const reply = await S('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(reply.result.data, 'base64'));
}

async function waitFor(description, expression, timeoutMs, intervalMs = 200) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const value = await evaluate(expression);
            if (value) {
                return { ok: true, ms: Date.now() - started, value };
            }
        } catch {
            // page navigating
        }
        await sleep(intervalMs);
    }
    return { ok: false, ms: Date.now() - started };
}

// Touch tap at game (canvas) coordinates.
async function tapGame(gx, gy, holdMs = 60) {
    const rect = await evaluate(`(() => { const r = document.getElementById('canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const x = rect.x + (gx * rect.w) / 765;
    const y = rect.y + (gy * rect.h) / 503;
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await sleep(holdMs);
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const STATE = `(() => { const c = window.__client; const h = window.LostCityHost; if (!c) return { engine: h?.engineState ?? null };
  const p = c.localPlayer; return {
    engine: h.engineState, msg: c.lastProgressMessage, pct: c.lastProgressPercent, title: !!c.titleFlames, loginscreen: c.loginscreen,
    loginSelect: c.loginSelect, user: c.loginUser, ingame: c.ingame, mes1: c.loginMes1, mes2: c.loginMes2, err: c.errorLoading,
    kb: window.lcHost.keyboard.isShown(), kbKind: window.lcHost.keyboard.context?.kind ?? null, kbCharset: window.lcHost.keyboard.context?.charset ?? null,
    pos: p ? [c.mapBuildBaseX + (p.x >> 7), c.mapBuildBaseZ + (p.z >> 7), c.minusedlevel] : null }; })()`;

const state = () => evaluate(STATE);

// The client reads typed keys in its next cycle, into the login field selected then, while a tap on a field selects it
// at once (pointerUp). So the next tap waits until the client holds what was typed: right after a touch Chrome can hold
// the client's timers back for ~100 ms, and the name then went into the password field.
const typedInto = (field, text) => `window.__client.${field} === ${JSON.stringify(text)} && window.__client.keyQueueReadPos === window.__client.keyQueueWritePos`;

// ---------------------------------------------------------------------------------------------------- bots (--bots N)

// In the page before host.js, on every load: the bots setting, stored where the page reads its settings outside the app
// (with the touch controls card marked seen: it would cover the world in the screenshots); what the page asks the engine
// worker for (init) and what the engine says it loaded (booted, ready), seen by a wrapper around the page's Worker, in
// window.__e2eEngine; and N added to the sheet's Bots row if the row does not offer N (the page would take the nearest
// count it offers: 75 would become 50).
// The engine's 'bots' messages (the bots asked for are off: docs/BOTS.md §4.1) go to window.__e2eEngine.bots, and every
// text the status line shows to window.__e2eEngine.notices.
const BOTS_PAGE = `(() => {
    const seen = (window.__e2eEngine = { init: null, booted: null, ready: null, bots: [], notices: [] });
    const PageWorker = window.Worker;
    window.Worker = class extends PageWorker {
        constructor(...args) {
            super(...args);
            this.addEventListener('message', event => {
                if (event.data?.type === 'booted' || event.data?.type === 'ready') {
                    seen[event.data.type] = { ...event.data };
                } else if (event.data?.type === 'bots') {
                    seen.bots.push({ ...event.data });
                }
            });
        }
        postMessage(...args) {
            if (args[0]?.type === 'init') {
                seen.init = JSON.parse(JSON.stringify(args[0]));
            }
            return super.postMessage(...args);
        }
    };
    try {
        const stored = JSON.parse(localStorage.getItem('lostcity.settings') ?? 'null');
        localStorage.setItem('lostcity.settings', JSON.stringify({ ...(stored && typeof stored === 'object' ? stored : {}), bots: ${BOTS}, seenHowToPlay: true }));
    } catch {}
    document.addEventListener('readystatechange', () => {
        const row = document.readyState === 'interactive' ? document.querySelector('.seg[data-setting="bots"]') : null;
        if (row && ![...row.querySelectorAll('button')].some(button => Number(button.dataset.value) === ${BOTS})) {
            const button = document.createElement('button');
            button.dataset.value = '${BOTS}';
            button.textContent = '${BOTS}';
            row.append(button);
        }
        const pill = document.readyState === 'interactive' ? document.getElementById('status-pill') : null;
        if (pill) {
            const note = () => {
                if (!pill.hidden && pill.textContent && seen.notices.at(-1) !== pill.textContent) {
                    seen.notices.push(pill.textContent);
                }
            };
            new MutationObserver(note).observe(pill, { attributes: true, attributeFilter: ['hidden'], childList: true, characterData: true, subtree: true });
        }
    });
})();`;

// No 'bots' message from the engine and no "Bots are off" in the status line in this page session (so far).
const NO_BOTS_NOTICE = `(() => { const seen = window.__e2eEngine; return !!seen && seen.bots.length === 0 && !seen.notices.some(text => /^Bots are off/.test(text)); })()`;
const botsSeen = () => evaluate('(() => { const seen = window.__e2eEngine; return seen && { bots: seen.bots, notices: seen.notices }; })()');

// Where fresh bots start: the bot library's LUMBRIDGE_SPAWN (web/engine/bots/src/BotKnowledge.ts), else upstream's
// (the road north-west of Lumbridge castle); the character goes there with the ::tele cheat.
const BOT_SPAWN = (() => {
    try {
        const found = fs.readFileSync(path.join(IOS, 'web', 'engine', 'bots', 'src', 'BotKnowledge.ts'), 'utf8').match(/LUMBRIDGE_SPAWN:\s*\[(\d+),\s*(\d+),\s*(\d+)\]/);
        if (found) {
            return found.slice(1, 4).map(Number);
        }
    } catch {
        // not there: upstream's
    }
    return [3180, 3240, 0];
})();
const TELE_TO_SPAWN = `::tele ${BOT_SPAWN[2]},${BOT_SPAWN[0] >> 6},${BOT_SPAWN[1] >> 6},${BOT_SPAWN[0] & 63},${BOT_SPAWN[1] & 63}`;

// The other players the client has (rev 274 Client: players[playerIds[i]] for i < playerCount); one is drawn once its
// appearance has come (ClientPlayer.ready).
const PLAYERS = `(() => { const c = window.__client; if (!c || typeof c.playerCount !== 'number' || !c.players || !c.playerIds) return null;
    const names = []; for (let i = 0; i < c.playerCount; i++) { const p = c.players[c.playerIds[i]]; if (p?.ready) names.push(p.name); }
    return { count: c.playerCount, ready: names.length, names }; })()`;

// Samples the client's other players every 500 ms until one is drawn (or timeoutMs), then for settleMs more (bots walk
// in and out of view): when the first was drawn, the most drawn at once, and every name seen.
async function watchPlayers(timeoutMs, settleMs) {
    const started = Date.now();
    const seen = { firstMs: null, most: { count: 0, ready: 0, names: [] }, names: new Set() };
    while (Date.now() - started < (seen.firstMs === null ? timeoutMs : seen.firstMs + settleMs)) {
        const players = await evaluate(PLAYERS).catch(() => null);
        if (players) {
            players.names.forEach(name => seen.names.add(name));
            if (players.ready > seen.most.ready) {
                seen.most = players;
            }
            if (players.ready > 0 && seen.firstMs === null) {
                seen.firstMs = Date.now() - started;
            }
        }
        await sleep(500);
    }
    return seen;
}

const watched = seen => (seen.firstMs === null ? 'none drawn' : `the first drawn after ${seen.firstMs} ms, at most ${seen.most.ready} at once: ${[...seen.names].slice(0, 10).join(', ')}`);

// The bots' store (docs/BOTS.md §4.5): "LCBOTS01", u16 count, count × { u8 nameLength, name, u32 saveLength, save }.
// The "_meta" record (JSON: the bots that quit, the friend lists) is not a bot: `meta`, not in count or names.
const EMPTY_BOT_STORE = Buffer.from('LCBOTS01\0\0', 'latin1');
const botStoreFile = path.join(savesDir, 'bots', 'main', 'bots.sav');

function readBotStore(file = botStoreFile) {
    if (!fs.existsSync(file)) {
        return null;
    }
    const data = fs.readFileSync(file);
    if (data.length < 10 || data.toString('latin1', 0, 8) !== 'LCBOTS01') {
        return { error: 'not an LCBOTS01 file', bytes: data.length };
    }
    const records = data.readUInt16BE(8);
    const names = [];
    const invalid = []; // records whose save is not a player save (magic 0x2004)
    let meta = null;
    let count = records;
    let pos = 10;
    for (let i = 0; i < records; i++) {
        const nameEnd = pos + 1 + (data[pos] ?? 0);
        if (nameEnd + 4 > data.length) {
            return { error: `truncated in record ${i}`, bytes: data.length, count, names };
        }
        const name = data.toString('latin1', pos + 1, nameEnd);
        const length = data.readUInt32BE(nameEnd);
        pos = nameEnd + 4 + length;
        if (pos > data.length) {
            return { error: `truncated in ${name}'s save`, bytes: data.length, count, names };
        }
        if (name === '_meta') {
            try {
                meta = JSON.parse(data.toString('utf8', nameEnd + 4, pos));
            } catch {
                invalid.push(name);
            }
            count--;
            continue;
        }
        if (length < 2 || data.readUInt16BE(nameEnd + 4) !== 0x2004) {
            invalid.push(name);
        }
        names.push(name);
    }
    return { bytes: data.length, count, names, invalid, trailing: data.length - pos, quit: meta?.quit ?? null };
}

const storeSummary = store => (store ? { ...store, names: store.names?.length > 8 ? [...store.names.slice(0, 8), `… ${store.names.length - 8} more`] : store.names } : null);
// a name as the client shows it ("Mr Jones") -> as the store keeps it (the safe name "mr_jones")
const safeName = name => String(name).toLowerCase().replace(/[\s\u00a0]+/g, '_');
const humanSaves = () => {
    const dir = path.join(savesDir, 'players', 'main');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.sav')).sort() : [];
};
const botRequests = () => saveRequests.filter(r => r.includes('/save/bots/'));

async function waitUntil(fn, timeoutMs, intervalMs = 200) {
    const started = Date.now();
    for (;;) {
        const value = fn();
        if (value || Date.now() - started >= timeoutMs) {
            return value;
        }
        await sleep(intervalMs);
    }
}

// A touch tap on an element's centre.
async function tapId(id) {
    await tapQuery(`#${id}`);
}

async function tapQuery(selector) {
    const r = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
    await sleep(60);
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(300);
}

async function login(user, pass, viaButton = false, newUser = false) {
    // Title → "New User" (offline: opens the login form with a hint) or "Existing User"
    await tapGame(newUser ? 302 : 462, 291);
    await sleep(400);
    let s = await state();
    if (newUser) {
        check('new-user tap opens the login form with the hint', s.loginscreen === 2 && /New character/.test(s.mes1), `loginscreen=${s.loginscreen} mes='${s.mes1} ${s.mes2}'`);
    } else {
        check('existing-user tap opens the login form', s.loginscreen === 2, `loginscreen=${s.loginscreen}`);
    }
    // Tap the username field → keyboard bridge should be asked to show (the bar takes what the field takes: 'name').
    await tapGame(360, 248);
    await sleep(300);
    s = await state();
    check('tapping the username field shows the keyboard', s.kb && s.kbKind === 'login-user' && s.kbCharset === 'name', `shown=${s.kb} kind=${s.kbKind} charset=${s.kbCharset}`);
    await evaluate(`window.LostCityHost.keyboard.insertText(${JSON.stringify(user)})`);
    if (pass === null) {
        await evaluate('window.LostCityHost.keyboard.submit()'); // the username's "Log in" key: offline a name is enough (it waits for the typed keys itself)
    } else {
        const typed = await waitFor('name typed', typedInto('loginUser', user), 3000, 20);
        await tapGame(360, 273); // the password field
        await sleep(400);
        s = await state();
        check('tapping the password field moves to it', typed.ok && s.user === user && s.loginSelect === 1 && s.kbKind === 'login-pass' && s.kbCharset === 'game', `user='${s.user}' loginSelect=${s.loginSelect} kind=${s.kbKind} charset=${s.kbCharset}`);
        await evaluate(`window.LostCityHost.keyboard.insertText(${JSON.stringify(pass)})`);
        if (viaButton) {
            await waitFor('password typed', typedInto('loginPass', pass), 3000, 20);
            await tapGame(302, 321); // "Login"
        } else {
            await evaluate('window.LostCityHost.keyboard.submit()'); // the keyboard's "Log in" key presses "Login"
        }
    }
    const inGame = await waitFor('in game', 'window.__client?.ingame === true', 25000);
    s = await state();
    check('login reaches the game', inGame.ok, `${inGame.ms} ms, mes='${s.mes1} ${s.mes2}'`);
    check('keyboard hides after login', !s.kb);
    return s;
}

// ---------------------------------------------------------------------------------------------------- the Android app (--platform android)

// In the page before host.js (--platform android), on every load, after the harness's settings script: what the Android
// app's document-start script defines (docs/ANDROID.md §3.1; web/test/android-stub.mjs): LostCityNative (its settings
// kept in localStorage as the app keeps them, handed back on the next load), LostCityNativeBridge and a stub of the
// app's message listener object, lcAndroid, that records every message (window.__androidStub.posted, parsed) and answers
// nothing; the page's init message to the engine is recorded too (its platform).
const ANDROID_PAGE = androidPageScript();

const androidStub = () => evaluate('JSON.parse(JSON.stringify(window.__androidStub ?? null))');
const replyTo = (stub, id) => stub?.posted.find(m => m.ch === 'reply' && m.id === id) ?? null;

// window.__lcCall as the Android app calls it (evaluateJavascript, docs/ANDROID.md §3.1), then the reply lcAndroid got.
async function lcCall(id, path, args = []) {
    await evaluate(`window.__lcCall(${id}, ${JSON.stringify(path)}, ${JSON.stringify(args)})`);
    const started = Date.now();
    for (;;) {
        const reply = replyTo(await androidStub(), id);
        if (reply || Date.now() - started > 8000) {
            return reply;
        }
        await sleep(50);
    }
}

// The Android page API (docs/ANDROID.md §3.3), on the title screen: {type:'loader-drawn'} after ready; the platform's
// Settings › Sound; no LostCityHost.back() (Back does nothing); keyboard.frame's curve; audio.setMuted.
async function androidPageChecks(natives) {
    const ready = natives.findIndex(m => m.type === 'ready');
    const drawn = natives.findIndex(m => m.type === 'loader-drawn');
    check('android: {type:\'loader-drawn\'} reaches native once, after ready (native takes its launch cover away)', ready === 0 && drawn > ready && natives.filter(m => m.type === 'loader-drawn').length === 1, JSON.stringify(natives.map(m => m.type).slice(0, 8)));
    const fills = (await androidStub())?.loaderFill ?? [];
    check('android: the loader\'s fill starts at the native cover\'s 6 % and never goes back', fills[0] === '6%' && fills.every((w, i) => i === 0 || parseFloat(w) >= parseFloat(fills[i - 1])), JSON.stringify(fills));

    const rows = await evaluate(`({ sound: !document.getElementById('sound-row').hidden, note: !document.getElementById('sound-note').hidden, vibration: !document.getElementById('vibration-row').hidden, nav: !document.getElementById('nav-sound').hidden })`);
    check('android: Settings › Sound has no silent switch row or note (native always plays) and shows Vibration (the phone has a vibrator)', !rows.sound && !rows.note && rows.vibration && rows.nav, JSON.stringify(rows));

    // Back does nothing: the page has no back() for native to call ('missing')
    const back = await lcCall(201, 'back');
    check('android: no LostCityHost.back() (Back does nothing)', back?.ok === false && back.error === 'missing', JSON.stringify(back));

    // keyboard.frame(overlap, duration, curve): the IME's own curve for the lift (here the title's login form); a curve
    // CSS would refuse, or anything else, falls back to the iOS one
    await lcSend('keyboard.frame', [270, 0.285, 'cubic-bezier(0.2, 0, 0, 1)']);
    const lifted = await evaluate(`document.getElementById('canvas').style.transition`);
    await lcSend('keyboard.frame', [0, 0.2, 'cubic-bezier(2, 0, 0, 1)']);
    const refused = await evaluate(`document.getElementById('canvas').style.transition`);
    await lcSend('keyboard.frame', [250, 0.2, 'url(x)']);
    const junk = await evaluate(`document.getElementById('canvas').style.transition`);
    await lcSend('keyboard.frame', [0, 0]);
    check('android: keyboard.frame(270, 0.285, \'cubic-bezier(0.2, 0, 0, 1)\') lifts with that curve; a refused or junk curve gets the iOS one', /285ms cubic-bezier\(0\.2, 0, 0, 1\)/.test(lifted) && /cubic-bezier\(0\.38, 0\.7, 0\.125, 1\)/.test(refused) && /cubic-bezier\(0\.38, 0\.7, 0\.125, 1\)/.test(junk), JSON.stringify({ lifted, refused, junk }));

    // audio.setMuted: the client's AudioContext suspended, and kept so when something resumes it (the client's touch
    // unlock); unmuted, running again
    const audioAt = () => evaluate(`window.audioContext?.state ?? null`);
    await evaluate(`window.audioContext?.resume()`);
    const before = await audioAt();
    const muted = await lcCall(203, 'audio.setMuted', [true]);
    await sleep(200);
    const whileMuted = await audioAt();
    await evaluate(`window.audioContext.resume()`);
    await sleep(300);
    const afterResume = await audioAt();
    const unmuted = await lcCall(204, 'audio.setMuted', [false]);
    await sleep(300);
    const after = await audioAt();
    check('android: audio.setMuted(true) suspends the client\'s AudioContext and keeps it suspended when it is resumed; (false) runs it again', before === 'running' && muted?.value?.muted === true && whileMuted === 'suspended' && afterResume === 'suspended' && unmuted?.value?.muted === false && after === 'running', JSON.stringify({ before, muted, whileMuted, afterResume, unmuted, after }));
}

// In game on the Android screen (914x411 at 2.625): 3 device px per HUD px (zoom 1.142857: an 800x360 HUD) and per game
// px (an 800x360 world, its surface covering the screen), the crisp pixel snap (docs/ANDROID.md §1).
async function androidWorldCheck() {
    const screen = ANDROID_SCREENS['a-medium'];
    const made = await evaluate(`(() => { const g = document.getElementById('surface-game');
        return { dpr: devicePixelRatio, zoom: Number(document.documentElement.style.getPropertyValue('--ui-zoom')), world: [g.width, g.height], css: [parseFloat(g.style.width), parseFloat(g.style.height)] }; })()`);
    check(`android: the crisp pixel snap at ${screen.dpr}: the HUD ×${screen.zoom.toFixed(6)} (whole device px per HUD px), the world ${screen.world.join('x')} game px covering the screen`, made.dpr === screen.dpr && Math.abs(made.zoom - screen.zoom) < 1e-9 && made.world.join() === screen.world.join() && made.css[0] >= screen.view.width - 0.01 && made.css[1] >= screen.view.height - 0.01 && Math.abs((made.css[0] * made.dpr) / made.world[0] - 3) < 1e-6, JSON.stringify(made));

}

// window.__lcCall(0, …) as the app sends keystrokes and frames: fire and forget, no reply.
const lcSend = (path, args = []) => evaluate(`window.__lcCall(0, ${JSON.stringify(path)}, ${JSON.stringify(args)})`);

// The save routes' writes since `from`: every one in X-LC-Body (Android) or every one with a body (iOS, desktop).
function writesCarried(from = 0) {
    const since = writes.slice(from);
    const want = ANDROID ? 'X-LC-Body' : 'body';
    return { ok: since.length > 0 && since.every(w => w.via === want), count: since.length, other: since.filter(w => w.via !== want).map(w => `${w.method} ${w.path} ${w.via}`).slice(0, 5), sample: since.slice(-3).map(w => `${w.method} ${w.path} ${w.bytes}`) };
}

// ---------------------------------------------------------------------------------------------------- the chat model (--lm-stub)

// In the page before host.js (--lm-stub): a stub "native" (window.webkit.messageHandlers.native) that keeps settings in
// localStorage, answers {type:'lm'} after 40 ms through LostCityHost.bots.lmReply (a line, or as window.__lmStub.answer
// says: 'fail' an error, 'none' nothing), and {type:'lm-key'} with a status through LostCityHost.bots.lmStatus; the
// startup status in window.LostCityNative.lm (a model in the app trained both ways, think 'option': Settings › Bot chat ›
// Think first shows; no key). What the page sends the worker and hears from it about the model is recorded (a wrapper
// around the page's Worker).
const LM_PAGE = bots => `(() => {
    const stub = (window.__lmStub = { sent: [], toWorker: [], fromWorker: [], answer: 'line',
        status: { local: { available: true, loaded: false, name: 'Stub model', bytes: 532517120, think: 'option' }, online: { keySet: false, model: 'claude-haiku-5-5' } } });
    let settings = {};
    try { settings = JSON.parse(localStorage.getItem('lostcity.settings') ?? '{}') ?? {}; } catch {}
    settings = { ...settings, bots: ${bots}, seenHowToPlay: true };
    try { localStorage.setItem('lostcity.settings', JSON.stringify(settings)); } catch {}
    window.LostCityNative = { platform: 'ios', appVersion: 'stub', build: '0', osVersion: 'stub', deviceModel: 'stub', simulator: true, debug: true, settings, lm: stub.status };
    const call = (fn, value, ms) => setTimeout(() => window.LostCityHost?.bots?.[fn]?.(value), ms);
    window.webkit = { messageHandlers: { native: { postMessage(msg) {
        const m = JSON.parse(JSON.stringify(msg));
        stub.sent.push(m);
        if (m.type === 'settings') {
            try { localStorage.setItem('lostcity.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('lostcity.settings') ?? '{}'), ...m.values })); } catch {}
        } else if (m.type === 'lm' && stub.answer !== 'none') {
            const online = m.mode === 'online' && stub.status.online.keySet;
            call('lmReply', stub.answer === 'fail' ? { id: m.id, text: null, source: null, error: 'failed: stub', ms: 40 } : { id: m.id, text: (online ? 'claude line ' : 'stub line ') + m.id, source: online ? 'online' : 'local', ms: 40 }, 40);
        } else if (m.type === 'lm-key') {
            stub.status.online = m.action === 'set' ? { keySet: true, hint: '…abcd', model: 'claude-haiku-5-5' } : { keySet: false, model: 'claude-haiku-5-5' };
            call('lmStatus', JSON.parse(JSON.stringify(stub.status)), 20);
        }
    } } } };
    const PageWorker = window.Worker;
    window.Worker = class extends PageWorker {
        constructor(...args) {
            super(...args);
            this.addEventListener('message', event => {
                const type = event.data?.type;
                if (type === 'booted' || type === 'bots-lm') stub.fromWorker.push(JSON.parse(JSON.stringify(event.data)));
            });
        }
        postMessage(...args) {
            const type = args[0]?.type;
            if (type === 'start' || (typeof type === 'string' && type.startsWith('bots-lm'))) stub.toWorker.push(JSON.parse(JSON.stringify(args[0])));
            return super.postMessage(...args);
        }
    };
})();`;

// A request as the bots' engine posts it, from inside the engine worker (its own global, through CDP), with a listener
// there that keeps what the page answers it (self.__lmReplies).
const LM_REQUEST = (id, timeoutMs = 9000) => `(() => {
    if (!self.__lmListening) {
        self.__lmListening = true;
        self.__lmReplies = [];
        self.addEventListener('message', event => { if (event.data?.type === 'bots-lm-reply') self.__lmReplies.push(event.data); });
    }
    self.postMessage({ type: 'bots-lm', id: ${id}, mode: 'local', local: { system: 'You are Kevin1991.', user: 'Dark Lord 91: hi kevin' }, online: { system: 'guide', context: 'You are Kevin1991.', user: 'Dark Lord 91: hi kevin' }, maxChars: 80, timeoutMs: ${timeoutMs} });
    return true;
})()`;

const inWorker = expression => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, workerSession).then(r => r.result?.result?.value);

async function workerReply(id, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const reply = await inWorker(`(self.__lmReplies ?? []).find(r => r.id === ${id}) ?? null`).catch(() => null);
        if (reply) {
            return { ...reply, waited: Date.now() - started };
        }
        await sleep(50);
    }
    return null;
}

const lmStub = () => evaluate('JSON.parse(JSON.stringify(window.__lmStub ?? null))');
const lastMode = async () => (await lmStub())?.toWorker.filter(m => m.type === 'bots-lm-mode').at(-1) ?? null;

async function lmStubChecks(stubScriptId, botsScriptId) {
    await S('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const attached = await waitUntil(() => workerSession, 5000);
    let stub = await lmStub();
    const toWorker = stub.toWorker.map(m => m.type);
    const firstMode = stub.toWorker.find(m => m.type === 'bots-lm-mode');
    check('lm: the engine hears the player\'s choice before its world starts (bots-lm-mode before start: local, a model in the app, no key)', toWorker.indexOf('bots-lm-mode') >= 0 && toWorker.indexOf('bots-lm-mode') < toWorker.indexOf('start') && firstMode?.mode === 'local' && firstMode.local === true && firstMode.online === false, JSON.stringify({ toWorker, firstMode }));
    check('lm: LostCityHost.bots has lmReply and lmStatus', await evaluate(`typeof window.LostCityHost.bots?.lmReply === 'function' && typeof window.LostCityHost.bots?.lmStatus === 'function'`));

    // a request from inside the engine worker: native gets it with its prompts, the worker gets native's line
    check('lm: the engine worker can be reached (CDP worker session)', !!attached, String(workerSession));
    await inWorker(LM_REQUEST(9001));
    let reply = await workerReply(9001, 3000);
    stub = await lmStub();
    const asked = stub.sent.find(m => m.type === 'lm' && m.id === 9001);
    // (Think first's default: host.js BOT_THINK_DEFAULT, nothing stored yet in this profile)
    const thinkDefault = await evaluate('window.LostCityHost.settings.botThink');
    check('lm: a request from the engine goes to native as {type:\'lm\', id, mode, think, local, online, maxChars, timeoutMs} (think: Think first\'s default until chosen)', asked?.mode === 'local' && typeof thinkDefault === 'boolean' && asked.think === thinkDefault && asked.local?.user === 'Dark Lord 91: hi kevin' && asked.online?.system === 'guide' && asked.online?.context === 'You are Kevin1991.' && asked.maxChars === 80 && asked.timeoutMs === 9000, JSON.stringify({ asked: asked ?? null, thinkDefault }));
    check('lm: native\'s line comes back to the engine (bots-lm-reply: text, source, ms from the page\'s send)', reply?.text === 'stub line 9001' && reply.source === 'local' && reply.ms >= 30 && reply.ms < 2000 && !('error' in reply), JSON.stringify(reply));

    // Settings › Bot chat: the model in the app, no key; Claude online applies at once
    await tapId('btn-settings');
    await tapId('nav-botchat');
    const page = await evaluate(`(() => { const s = document.getElementById('settings-pane'); const panel = document.querySelector('#settings .settings-panel').getBoundingClientRect();
        return { open: !document.getElementById('section-botchat').hidden, settingsHidden: document.getElementById('settings').hidden, local: document.getElementById('botchat-local').textContent, key: document.getElementById('botchat-key').textContent,
            set: document.getElementById('botchat-key-set').textContent, remove: !document.getElementById('botchat-key-remove').hidden, test: document.getElementById('botchat-test').disabled,
            on: [...document.querySelectorAll('#section-botchat .seg[data-setting="botChat"] button.on')].map(b => b.textContent), fits: s.scrollHeight <= s.clientHeight + 1, panel: [panel.left, panel.top, panel.right, panel.bottom].map(Math.round), view: [innerWidth, innerHeight],
            think: !document.getElementById('botchat-think').hidden, thinkOn: [...document.querySelectorAll('#botchat-think .seg button.on')].map(b => b.textContent) }; })()`);
    await screenshot('lm-1-botchat.png');
    check('lm: Settings › Bot chat (a category of Settings): On-device chosen, the model\'s name and size, no key (Set key, no Remove, Test off), all on screen', page.open && !page.settingsHidden && page.local === 'Stub model · 508 MB' && page.key === 'Not set' && page.set === 'Set key' && !page.remove && page.test && JSON.stringify(page.on) === '["On-device"]' && page.fits && page.panel[0] >= 0 && page.panel[2] <= page.view[0] && page.panel[1] >= 0 && page.panel[3] <= page.view[1], JSON.stringify(page));
    check(`lm: a model trained both ways (status think 'option'): Think first shows, at its default (${thinkDefault ? 'On' : 'Off'})`, page.think && JSON.stringify(page.thinkOn) === JSON.stringify([thinkDefault ? 'On' : 'Off']), JSON.stringify({ think: page.think, on: page.thinkOn }));

    // Think first applies at once: the next request carries think as the setting now says; the setting is kept
    await tapQuery('#botchat-think .seg button[data-value="true"]');
    await inWorker(LM_REQUEST(9010));
    reply = await workerReply(9010, 3000);
    stub = await lmStub();
    let thought = stub.sent.find(m => m.type === 'lm' && m.id === 9010);
    check('lm: Think first On: the next request carries think: true at once, the setting kept (botThink), the line comes back', thought?.think === true && stub.sent.some(m => m.type === 'settings' && m.values?.botThink === true) && reply?.text === 'stub line 9010', JSON.stringify({ think: thought?.think, reply }));
    await tapQuery('#botchat-think .seg button[data-value="false"]');
    await inWorker(LM_REQUEST(9011));
    reply = await workerReply(9011, 3000);
    stub = await lmStub();
    thought = stub.sent.find(m => m.type === 'lm' && m.id === 9011);
    check('lm: Think first Off again: think: false at once', thought?.think === false && stub.sent.filter(m => m.type === 'settings').at(-1)?.values?.botThink === false && reply?.text === 'stub line 9011', JSON.stringify({ think: thought?.think, reply }));
    await tapQuery('#botchat-think .seg button[data-value="true"]'); // (On for the rest: the Test and Claude's requests still send think: false)
    // a model that always or never writes its note: no choice, no row; the status back: the row again
    const thinkShown = () => evaluate(`!document.getElementById('botchat-think').hidden`);
    const statusWith = think => evaluate(`window.LostCityHost.bots.lmStatus({ ...window.__lmStub.status, local: { ...window.__lmStub.status.local, think: ${JSON.stringify(think)} } })`);
    await statusWith('always');
    const forAlways = await thinkShown();
    await statusWith('never');
    const forNever = await thinkShown();
    await evaluate(`window.LostCityHost.bots.lmStatus(window.__lmStub.status)`);
    const forOption = await thinkShown();
    check('lm: Think first hidden while the status says the model always or never writes its note, shown again for \'option\'', !forAlways && !forNever && forOption, JSON.stringify({ forAlways, forNever, forOption }));
    await tapQuery('#section-botchat .seg button[data-value="online"]');
    let mode = await lastMode();
    stub = await lmStub();
    check('lm: choosing Claude online tells the engine at once and keeps the setting', mode?.mode === 'online' && mode.online === false && stub.sent.some(m => m.type === 'settings' && m.values?.botChat === 'online'), JSON.stringify(mode));
    const thinkOnline = await evaluate(`(() => { const row = document.getElementById('botchat-think'); return { shown: !row.hidden, unused: row.classList.contains('unused'), disabled: [...row.querySelectorAll('.seg button')].map(b => b.disabled), on: [...row.querySelectorAll('.seg button.on')].map(b => b.textContent), hint: document.getElementById('botchat-think-hint').textContent }; })()`);
    check('lm: with Claude online Think first is greyed out (Off / On disabled, On still shown, "Only with the On-device chat model.")', thinkOnline.shown && thinkOnline.unused && JSON.stringify(thinkOnline.disabled) === '[true,true]' && JSON.stringify(thinkOnline.on) === '["On"]' && thinkOnline.hint === 'Only with the On-device chat model.', JSON.stringify(thinkOnline));

    // the key: native's secure box (stubbed), then its status; the engine hears that a key is there
    await tapId('botchat-key-set');
    await waitFor('key set', `document.getElementById('botchat-key').textContent.startsWith('Ends in')`, 3000);
    mode = await lastMode();
    stub = await lmStub();
    const keyed = await evaluate(`({ key: document.getElementById('botchat-key').textContent, set: document.getElementById('botchat-key-set').textContent, remove: !document.getElementById('botchat-key-remove').hidden, test: document.getElementById('botchat-test').disabled })`);
    check('lm: Set key asks native ({type:\'lm-key\', action:\'set\'}); its status shows "Ends in …abcd" (Change, Remove, Test on) and the engine hears a key is there', stub.sent.some(m => m.type === 'lm-key' && m.action === 'set') && keyed.key === 'Ends in …abcd' && keyed.set === 'Change' && keyed.remove && !keyed.test && mode?.online === true, JSON.stringify({ keyed, mode }));
    await tapId('botchat-test');
    const tested = await waitFor('test', `document.getElementById('botchat-test-result').textContent.startsWith('Claude:')`, 3000);
    stub = await lmStub();
    const test = stub.sent.find(m => m.type === 'lm' && m.id < 0);
    check('lm: Test asks Claude for one line (a negative id, online, no fallback, think false: Claude never thinks) and shows it', tested.ok && test?.mode === 'online' && test.fallback === false && test.think === false && test.online?.user && (await evaluate(`document.getElementById('botchat-test-result').textContent`)) === `Claude: claude line ${test.id}`, JSON.stringify(test ?? null));
    await screenshot('lm-2-botchat-key.png');
    await inWorker(LM_REQUEST(9002));
    reply = await workerReply(9002, 3000);
    thought = (await lmStub()).sent.find(m => m.type === 'lm' && m.id === 9002);
    check('lm: with Claude online and a key the reply is Claude\'s (source online; think false though Think first is On: the on-device fallback skips the note)', reply?.text === 'claude line 9002' && reply.source === 'online' && thought?.think === false, JSON.stringify({ reply, think: thought?.think }));

    // the page answers for the engine: Rules, a failed reply, a reply that never comes
    await tapQuery('#section-botchat .seg button[data-value="rules"]');
    mode = await lastMode();
    const sentBefore = (await lmStub()).sent.filter(m => m.type === 'lm').length;
    await inWorker(LM_REQUEST(9003));
    reply = await workerReply(9003, 2000);
    const sentAfter = (await lmStub()).sent.filter(m => m.type === 'lm').length;
    check('lm: Rules: the engine hears it, and a request is answered null \'unavailable\' at once, without native', mode?.mode === 'rules' && reply?.text === null && reply.error === 'unavailable' && reply.ms === 0 && sentAfter === sentBefore, JSON.stringify({ mode, reply, asked: sentAfter - sentBefore }));
    await tapQuery('#section-botchat .seg button[data-value="local"]');
    await evaluate(`window.__lmStub.answer = 'fail'`);
    await inWorker(LM_REQUEST(9004));
    reply = await workerReply(9004, 3000);
    check('lm: a failed reply reaches the engine with native\'s reason', reply?.text === null && reply.error === 'failed: stub', JSON.stringify(reply));
    await evaluate(`window.__lmStub.answer = 'none'`);
    await inWorker(LM_REQUEST(9005, 1000));
    reply = await workerReply(9005, 7000);
    check('lm: native that never answers: the page answers \'timeout\' a little after the request\'s timeoutMs (1 s + 3)', reply?.text === null && reply.error === 'timeout' && reply.ms >= 3900 && reply.ms < 6000, JSON.stringify(reply));
    await evaluate(`window.__lmStub.answer = 'line'`);

    // Remove asks first, then native forgets the key
    await tapId('botchat-key-remove');
    const asked2 = await evaluate(`!document.getElementById('confirm').hidden && document.getElementById('confirm-title').textContent`);
    await tapId('confirm-ok');
    await waitFor('key removed', `document.getElementById('botchat-key').textContent === 'Not set'`, 3000);
    stub = await lmStub();
    mode = await lastMode();
    check('lm: Remove asks first ("Remove the Claude key?"), then native removes it ({type:\'lm-key\', action:\'remove\'}); "Not set"; the engine hears no key', asked2 === 'Remove the Claude key?' && stub.sent.some(m => m.type === 'lm-key' && m.action === 'remove') && mode?.online === false, JSON.stringify({ asked2, mode }));
    // (Think first left at the opposite of its default: the reload below must bring that back, not the default)
    await tapQuery(`#botchat-think .seg button[data-value="${!thinkDefault}"]`);
    await tapId('nav-display');
    const back = await evaluate(`!document.getElementById('settings').hidden && document.getElementById('section-botchat').hidden && !document.getElementById('section-display').hidden`);
    await tapId('settings-close');
    check('lm: Display, from the categories, takes Bot chat\'s place', back);

    // no native app (a desktop browser): every request is answered 'unavailable' at once; the page says why
    await S('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubScriptId });
    workerSession = null;
    await S('Page.reload', {});
    await waitFor('title (no native)', 'window.__client?.lastProgressPercent === 100 && !!window.__client?.titleFlames', 60000);
    await waitFor('engine (no native)', "window.LostCityHost?.engineState === 'ready'", 60000);
    await sleep(500);
    await waitUntil(() => workerSession, 10000);
    await inWorker(LM_REQUEST(9006));
    reply = await workerReply(9006, 2000);
    await tapId('btn-settings');
    await tapId('nav-botchat');
    const desktop = await evaluate(`({ local: document.getElementById('botchat-local').textContent, key: document.getElementById('botchat-key').textContent, set: document.getElementById('botchat-key-set').disabled, on: [...document.querySelectorAll('#section-botchat .seg[data-setting="botChat"] button.on')].map(b => b.textContent), think: !document.getElementById('botchat-think').hidden, botThink: window.LostCityHost.settings.botThink })`);
    await tapId('nav-display');
    await tapId('settings-close');
    check('lm: no native app: a request is answered null \'unavailable\' at once; Bot chat says "Only in the iPhone app" (Set key off, no Think first)', reply?.text === null && reply.error === 'unavailable' && reply.ms === 0 && desktop.local === 'Only in the iPhone app' && desktop.key === 'Only in the iPhone app' && desktop.set && !desktop.think, JSON.stringify({ reply, desktop }));
    check(`lm: Think first is kept across the reload (${thinkDefault ? 'Off' : 'On'}, as left: not its default)`, desktop.botThink === !thinkDefault, JSON.stringify({ botThink: desktop.botThink, thinkDefault }));

    // the bots off (the plain engine): it hears nothing of the model
    await S('Page.removeScriptToEvaluateOnNewDocument', { identifier: botsScriptId });
    const offId = (await S('Page.addScriptToEvaluateOnNewDocument', { source: LM_PAGE(0) })).result.identifier;
    await S('Page.reload', {});
    await waitFor('engine (bots off)', "window.LostCityHost?.engineState === 'ready'", 60000);
    await sleep(500);
    stub = await lmStub();
    const booted = stub.fromWorker.find(m => m.type === 'booted');
    check('lm: with the bots off (engine.js) the engine hears nothing of the model (no bots-lm-* message)', booted && (booted.bundle ?? 'engine.js') === 'engine.js' && !stub.toWorker.some(m => m.type.startsWith('bots-lm')) && stub.toWorker.some(m => m.type === 'start'), JSON.stringify({ booted: booted && { bundle: booted.bundle, bots: booted.bots }, toWorker: stub.toWorker.map(m => m.type) }));
    await S('Page.removeScriptToEvaluateOnNewDocument', { identifier: offId });

    const errors = consoleLines.filter(line => /\[(error|exception)\]/.test(line));
    check('lm: no console errors or exceptions', errors.length === 0, errors.slice(0, 5).join(' | '));
}

class LmStubDone extends Error {}

let exitCode = 1;
let botNames = new Set(); // (--bots) the other players seen in the first session
let firstStore = null; // (--bots) the bots' store after the first save
try {
    let lmStubScript = null;
    let botsScript = null;
    if (LM_STUB) {
        lmStubScript = (await S('Page.addScriptToEvaluateOnNewDocument', { source: LM_PAGE(BOTS) })).result.identifier;
    }
    if (BOTS !== null) {
        botsScript = (await S('Page.addScriptToEvaluateOnNewDocument', { source: BOTS_PAGE })).result.identifier;
        // an earlier session's files: the bots' store (an empty one, dated ahead so that it would be "Continue as" if the
        // title ever listed it) and an older second character, so that the title lists its characters
        fs.mkdirSync(path.dirname(botStoreFile), { recursive: true });
        fs.writeFileSync(botStoreFile, EMPTY_BOT_STORE);
        fs.utimesSync(botStoreFile, new Date(Date.now() + 3600e3), new Date(Date.now() + 3600e3));
        const other = path.join(savesDir, 'players', 'main', 'zezima.sav');
        fs.mkdirSync(path.dirname(other), { recursive: true });
        fs.writeFileSync(other, 'not a save');
        fs.utimesSync(other, new Date(Date.now() - 3 * 86400e3), new Date(Date.now() - 3 * 86400e3));
    }

    // the world this run checks, not the app's defaults (500 bots, Jmod Off, 10× XP): Jmod as --no-jmod says, 1× XP, and
    // without --bots no bots
    const world = { jmod: JMOD, xpRate: 1, ...(BOTS === null ? { bots: 0 } : {}) };
    await S('Page.addScriptToEvaluateOnNewDocument', {
        source: `try { const s = JSON.parse(localStorage.getItem('lostcity.settings') ?? 'null'); localStorage.setItem('lostcity.settings', JSON.stringify({ ...(s && typeof s === 'object' ? s : {}), ...${JSON.stringify(world)} })); } catch {}`
    });
    if (ANDROID) {
        // (after the settings script: LostCityNative.settings carries what it stored, as the app's would)
        await S('Page.addScriptToEvaluateOnNewDocument', { source: ANDROID_PAGE });
    }

    // ---------------------------------------------------------------- boot
    const bootStart = Date.now();
    await S('Page.navigate', { url: server.url });
    const titleReady = await waitFor('title', 'window.__client?.lastProgressPercent === 100 && !!window.__client?.titleFlames', 60000);
    check('title screen loads', titleReady.ok, `${Date.now() - bootStart} ms`);
    const engineReady = await waitFor('engine', "window.LostCityHost?.engineState === 'ready'", 60000);
    check('engine worker reaches ready', engineReady.ok, `${Date.now() - bootStart} ms total`);
    await sleep(500);
    await screenshot('1-title.png');

    if (ANDROID) {
        const stub = await androidStub();
        const natives = (stub?.posted ?? []).filter(m => m.ch === 'native').map(m => m.msg);
        const phases = natives.filter(m => m.type === 'status').map(m => m.phase);
        check('android: the engine is told platform \'android\' (init.platform, from LostCityNative.platform)', stub?.init?.platform === 'android', JSON.stringify({ platform: stub?.init?.platform ?? null }));
        check('android: the page\'s messages go to native through LostCityNativeBridge as {ch:\'native\', msg} (ready, status booting/engine-ready)', natives[0]?.type === 'ready' && phases.includes('booting') && phases.includes('engine-ready') && natives.length === stub.posted.filter(m => m.ch === 'native').length, JSON.stringify({ types: natives.map(m => m.type).slice(0, 12), phases }));
        await androidPageChecks(natives);
    }

    if (BOTS !== null) {
        const seen = await evaluate('window.__e2eEngine ?? null');
        const setting = await evaluate('window.LostCityHost.settings.bots');
        check(`bots: the page asks the engine for ${BOTS ? `${BOTS} bots` : 'none'} (the Bots setting → init config.bots.count)`, setting === BOTS && seen?.init?.config?.bots?.count === BOTS, JSON.stringify({ setting, config: seen?.init?.config ?? null }));
        if (BOTS > 0) {
            check(`bots: the engine loads its bots bundle for ${BOTS} bots`, seen?.booted?.bundle === 'engine-bots.js' && seen.booted.bots === BOTS, JSON.stringify(seen?.booted ?? null));
        } else {
            const plain = !!seen?.booted && (seen.booted.bundle ?? 'engine.js') === 'engine.js' && !(seen.booted.bots > 0);
            check('bots off: the engine loads the plain bundle', plain, `${JSON.stringify(seen?.booted ?? null)}${seen?.booted && !('bundle' in seen.booted) ? ' (an engine from before the bots bundle: no bundle field)' : ''}`);
        }
    }

    if (LM_STUB) {
        await lmStubChecks(lmStubScript, botsScript);
        throw new LmStubDone();
    }

    // ---------------------------------------------------------------- login (new account)
    await login(USER, null, false, true);
    const placed = await waitFor('map', 'window.__client?.mapBuildBaseX > 0 && !!window.__client?.localPlayer', 15000);
    await sleep(2500);
    await screenshot('2-ingame.png');
    const first = await state();
    check('player has a position', placed.ok && Array.isArray(first.pos) && first.pos[0] > 0, JSON.stringify(first.pos));
    if (ANDROID) {
        await androidWorldCheck();
    }
    if (ANDROID) {
        const keyboard = ((await androidStub())?.posted ?? []).filter(m => m.ch === 'native' && m.msg?.type === 'keyboard').map(m => `${m.msg.action}${m.msg.kind ? ` ${m.msg.kind}` : ''}`);
        check('android: the login asked native for its keyboard through the bridge (show login-user … hide)', keyboard[0] === 'show login-user' && keyboard.at(-1) === 'hide', JSON.stringify(keyboard));
    }
    // Settings › World › Jmod: staff level 4 (the client is told 2: a crown in chat, the "::" chips) or a normal player
    await evaluate('window.LostCityHost.keyboard.show()');
    await sleep(300);
    const staff = await evaluate(`({ setting: window.LostCityHost.settings.jmod, staff: window.__client.staffmodlevel, kind: window.lcHost.keyboard.context?.kind ?? null, chips: (window.lcHost.keyboard.context?.chips ?? []).map(c => c.label) })`);
    await evaluate('window.LostCityHost.keyboard.dismissed()');
    await sleep(200);
    check(
        JMOD ? 'Jmod On (the default): staff level 2 in the client, the "::" chip on the chat keyboard' : 'Jmod Off: staff level 0 in the client, no "::" chips on the chat keyboard',
        staff.setting === JMOD && staff.kind === 'chat' && (JMOD ? staff.staff === 2 && staff.chips[0] === '::' : staff.staff === 0 && staff.chips.length === 0),
        JSON.stringify(staff)
    );

    if (BOTS !== null) {
        // ------------------------------------------------------------ to Lumbridge, where the bots start (BOTS.md §4.4)
        await evaluate(`window.LostCityHost.keyboard.insertText(${JSON.stringify(`${TELE_TO_SPAWN}\n`)})`);
        const there = await waitFor('Lumbridge', `(${STATE}).pos?.join() === '${BOT_SPAWN.join()}'`, 10000);
        const bundle = await evaluate('window.__e2eEngine?.booted?.bundle ?? null');
        if (BOTS > 0) {
            // (they come once a human is in the world, a few per tick: give the client a moment to show more of them)
            const crowd = bundle === 'engine-bots.js' ? await watchPlayers(60000, 5000) : null;
            crowd?.names.forEach(name => botNames.add(name));
            const detail = crowd ? watched(crowd) : bundle ? `the engine loaded ${bundle}, not its bots bundle` : 'the engine did not say which bundle it loaded (it has no bots bundle)';
            check('bots: other players appear around the player in Lumbridge', there.ok && crowd?.firstMs != null, `${there.ok ? '' : 'the teleport did not arrive; '}${detail}`);
        } else {
            await sleep(5000);
            const players = await evaluate(PLAYERS);
            check('bots off: nobody else in the world (Lumbridge)', there.ok && players?.count === 0, JSON.stringify({ arrived: there.ok, players }));
        }
        await screenshot('2b-lumbridge.png');
    }

    // ---------------------------------------------------------------- save
    const writesFrom = writes.length;
    const saveReply = await evaluate('window.LostCityHost.saveNow()');
    const savePath = path.join(savesDir, 'players', 'main', `${USER}.sav`);
    const saved = fs.existsSync(savePath) ? fs.readFileSync(savePath) : null;
    check('lifecycle save writes the player file', saveReply?.ok && saved && saved.readUInt16BE(0) === 0x2004, `${saved?.length ?? 0} bytes, reply=${JSON.stringify(saveReply)}`);
    if (BOTS > 0) {
        // all the bots in one file, written with the human's saves (BOTS.md §4.5); none of them under players/
        firstStore = await waitUntil(() => (readBotStore()?.count > 0 ? readBotStore() : null), 5000);
        const humans = humanSaves();
        const stored = !!firstStore && !firstStore.error && firstStore.count <= BOTS + 3 && Array.isArray(firstStore.quit) && firstStore.invalid.length === 0 && firstStore.trailing === 0; // (N online, and the new character's newcomers; _meta)
        check('bots: the save writes the bots to bots/main/bots.sav, and players/main keeps only the human characters', stored && JSON.stringify(humans) === JSON.stringify([`${USER}.sav`, 'zezima.sav']), JSON.stringify({ store: storeSummary(firstStore ?? readBotStore()), humans, requests: botRequests() }));
        // (lifecycle-done says whether the bots were saved, apart from ok: BOTS.md §4.1)
        check('bots: the save\'s reply says the bots were saved too (bots: {ok: true})', saveReply?.ok === true && saveReply.bots?.ok === true, JSON.stringify(saveReply));
    } else if (BOTS === 0) {
        check('bots off: the save\'s reply has no bots part', !!saveReply && !('bots' in saveReply), JSON.stringify(saveReply));
    }
    if (BOTS !== null) {
        check(`${BOTS ? 'bots' : 'bots off'}: no "bots are off" message from the engine and no such notice`, await evaluate(NO_BOTS_NOTICE), JSON.stringify(await botsSeen()));
    }
    const carried = writesCarried(writesFrom);
    check(ANDROID ? 'android: the save reached the server in X-LC-Body + X-LC-Length, with no body' : 'the save reached the server with a body (no X-LC-Body)', carried.ok, JSON.stringify(carried));

    // ---------------------------------------------------------------- pause longer than the client's 15 s timeout
    // (Android: through window.__lcCall, as the app's lifecycle coordinator calls it, and its replies)
    let paused = null;
    let resumed = null;
    if (ANDROID) {
        paused = await lcCall(101, 'lifecycle', ['pause']);
    } else {
        await evaluate("window.LostCityHost.lifecycle('pause')");
    }
    await sleep(17000);
    if (ANDROID) {
        resumed = await lcCall(102, 'lifecycle', ['resume']);
    } else {
        await evaluate("window.LostCityHost.lifecycle('resume')");
    }
    await sleep(3000);
    let s = await state();
    check('pause/resume keeps the session (no reconnect, no logout)', s.ingame && !/Connection lost/i.test(`${s.mes1}${s.mes2}`), JSON.stringify({ ingame: s.ingame }));
    if (ANDROID) {
        check('android: __lcCall(id, \'lifecycle\', [\'pause\'|\'resume\']) answers {ch:\'reply\', id, ok:true, value} through lcAndroid (the pause saved: value.ok)', paused?.ok === true && paused.value?.ok === true && resumed?.ok === true && resumed.value?.ok === true, JSON.stringify({ paused, resumed }));
        await evaluate(`window.__lcCall(0, 'keyboard.isShown', [])`);
        const missing = await lcCall(103, 'keyboard.noSuchThing', ['x']);
        const value = await lcCall(104, 'keyboard.isShown', []);
        const stub = await androidStub();
        check('android: __lcCall: a missing function → {ok:false, error:\'missing\'}; a plain value comes back; id 0 gets no reply', missing?.ok === false && missing.error === 'missing' && value?.ok === true && value.value === false && !stub.posted.some(m => m.ch === 'reply' && !(m.id > 0)), JSON.stringify({ missing, value }));
    }

    // ---------------------------------------------------------------- dropped connection → client reconnects (opcode 18)
    await evaluate('window.__client.stream?.socket?.close?.()');
    const reconnected = await waitFor('reconnect', 'window.__client?.ingame === true && !!window.__client?.stream', 30000, 500);
    await sleep(4000);
    s = await state();
    check('client recovers from a dropped connection', reconnected.ok && s.ingame, JSON.stringify({ ingame: s.ingame, pos: s.pos }));
    await screenshot('3-after-reconnect.png');
    if (BOTS > 0) {
        (await evaluate(PLAYERS))?.names.forEach(name => botNames.add(name));

        // ------------------------------------------------------------ the bots cannot be saved: Restart waits (BOTS.md §4.1)
        // bots.sav turned into a folder: its PUT fails (400) while the character's still works. The save's reply says
        // so (bots.ok false), and Settings › Restart does not reload but says the bots were not saved; once storage
        // works again the next save writes them.
        const good = fs.readFileSync(botStoreFile);
        fs.rmSync(botStoreFile);
        fs.mkdirSync(botStoreFile);
        const failed = await evaluate('window.LostCityHost.saveNow()');
        await evaluate('window.__e2eNotReloaded = true');
        await tapId('btn-settings');
        await tapId('nav-world');
        await tapId('settings-restart');
        await sleep(1500);
        const restart = await evaluate(`({ notReloaded: window.__e2eNotReloaded === true, label: document.getElementById('settings-restart').textContent, pill: document.getElementById('status-pill').hidden ? null : document.getElementById('status-pill').textContent })`);
        await screenshot('3a-bots-not-saved.png');
        await tapId('nav-display');
        await tapId('settings-close');
        fs.rmSync(botStoreFile, { recursive: true });
        fs.writeFileSync(botStoreFile, good);
        const recovered = await evaluate('window.LostCityHost.saveNow()');
        const after = readBotStore();
        check('bots: a bots.sav that cannot be written: the save says so apart (ok true, bots.ok false); Restart waits ("Bots not saved: tap again to restart anyway") and says why; the next save writes them', failed?.ok === true && failed.bots?.ok === false && restart.notReloaded && restart.label === 'Bots not saved: tap again to restart anyway' && restart.pill === `The bots could not be saved. ${ANDROID ? 'Is the phone\'s storage full?' : 'Is the iPhone storage full?'}` && recovered?.ok === true && recovered.bots?.ok === true && !after?.error && after?.count >= (firstStore?.count ?? 1), JSON.stringify({ failed, restart, recovered, store: storeSummary(after) }));
    }

    // ---------------------------------------------------------------- reload → re-login restores the save
    await evaluate('window.LostCityHost.saveNow()');
    const before = (await state()).pos;
    await S('Page.reload', {});
    await waitFor('title again', 'window.__client?.lastProgressPercent === 100 && !!window.__client?.titleFlames', 60000);
    await waitFor('engine again', "window.LostCityHost?.engineState === 'ready'", 60000);
    await sleep(500);
    if (BOTS !== null) {
        // the title offers the human characters only (players/main/*.sav): never a bot, nor the bots' store
        const shown = await waitFor('characters', `!document.getElementById('title-actions').hidden && !document.getElementById('btn-characters').hidden`, 5000);
        const offered = await evaluate(`document.getElementById('btn-continue').hidden ? null : document.getElementById('continue-name').textContent`);
        if (shown.ok) {
            await tapId('btn-characters');
        }
        const listed = await evaluate(`document.getElementById('characters').hidden ? null : [...document.querySelectorAll('#characters-list .character-name')].map(n => n.textContent)`);
        await screenshot('3b-characters.png');
        await tapId('characters-close');
        const botFiles = fs.readdirSync(path.dirname(botStoreFile)).filter(name => name.endsWith('.sav') && name !== 'bots.sav').map(name => name.slice(0, -4).replace(/_/g, ' '));
        const bots = new Set([...botNames, ...(firstStore?.names ?? []), ...botFiles].map(name => name.toLowerCase()));
        const named = [offered, ...(listed ?? [])].filter(Boolean).map(name => name.toLowerCase());
        const humansOnly = offered?.toLowerCase() === USER && JSON.stringify([...(listed ?? [])].map(name => name.toLowerCase()).sort()) === JSON.stringify([USER, 'zezima']) && !named.some(name => bots.has(name) || name === 'bots');
        check('bots: the title lists only the human characters ("Continue as", Characters): no bot, not the bots\' store', humansOnly, JSON.stringify({ continueAs: offered, listed, botsSeen: [...bots].slice(0, 10) }));
    }
    const second = await login(USER, 'any-password', true);
    await sleep(2000);
    s = await state();
    check('re-login restores the saved position', JSON.stringify(s.pos) === JSON.stringify(before), `before=${JSON.stringify(before)} after=${JSON.stringify(s.pos)}`);
    void second;
    await screenshot('4-relogin.png');
    if (BOTS > 0) {
        // The restarted world goes on with the same bots: they come back (from where their saves left them), and the next
        // save holds them all (records of bots it did not run are carried over: BOTS.md §4.5), apart from any that quit
        // for good (named in _meta). The world runs about N of a pool of about 2N, and the new character brought a few
        // newcomers (§4.4): at most 2N + 3 records. The first save may have come before all N had joined (5 a tick once
        // a human is in): the rest join in this session, so the first store's bots are a part of this one.
        const back = firstStore ? await watchPlayers(30000, 2000) : null;
        const reply = await evaluate('window.LostCityHost.saveNow()'); // (bots.sav is written before the reply)
        const store = readBotStore();
        const names = new Set(store?.names ?? []);
        const lost = (firstStore?.names ?? []).filter(name => !names.has(name) && !(store?.quit ?? []).includes(name));
        const unknown = [...(back?.names ?? [])].map(safeName).filter(name => !names.has(name));
        const goesOn = !!firstStore && !!store && !store.error && Array.isArray(store.quit) && reply?.bots?.ok === true && lost.length === 0 && unknown.length === 0 && store.count <= 2 * BOTS + 3 && store.count >= firstStore.count - store.quit.length;
        check(`bots: after a restart the world goes on with the same bots (bots.sav: the first save's ${firstStore?.count ?? 0}, and the pool of about ${2 * BOTS})`, goesOn, JSON.stringify({ inView: back ? watched(back) : null, first: storeSummary(firstStore), now: storeSummary(store), lost, unknown, reply }));
    }
    if (BOTS !== null) {
        check(`${BOTS ? 'bots' : 'bots off'}: after the restart, still no "bots are off" message or notice`, await evaluate(NO_BOTS_NOTICE), JSON.stringify(await botsSeen()));
    }

    // ---------------------------------------------------------------- settings panel opens and closes
    const tapElement = async id => {
        const r = await evaluate(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, hit: hit ? (hit.id || hit.tagName) + (hit.closest('#${id}') ? ' (inside)' : ' (OUTSIDE)') : null, w: r.width, h: r.height }; })()`);
        await evaluate(`(() => { window.__tapLog = []; for (const t of ['pointerdown','pointerup','pointercancel','click']) document.getElementById('${id}').addEventListener(t, e => window.__tapLog.push(e.type + ':' + e.pointerType), { once: true }); })()`);
        await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
        await sleep(60);
        await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await sleep(50);
        r.events = await evaluate('window.__tapLog.join(",")');
        return r;
    };
    const tap1 = await tapElement('btn-settings');
    await sleep(400);
    const settingsOpen = await evaluate("!document.getElementById('settings').hidden");
    await screenshot('5-settings.png');
    if (BOTS !== null) {
        await tapId('nav-world');
    }
    const botsRow = BOTS === null ? null : await evaluate(`(() => { const s = document.getElementById('settings-pane'); return { on: [...document.querySelectorAll('.seg[data-setting="bots"] button.on')].map(b => b.textContent), restart: document.getElementById('settings-restart').textContent, fits: s.scrollHeight <= s.clientHeight + 1 }; })()`);
    if (BOTS !== null) {
        await tapId('nav-display');
    }
    const tap2 = await tapElement('settings-close');
    await sleep(300);
    check('settings panel opens and closes', settingsOpen && (await evaluate("document.getElementById('settings').hidden")), JSON.stringify({ settingsOpen, tap1, tap2 }));
    if (BOTS !== null) {
        const label = BOTS === 0 ? 'Off' : String(BOTS);
        check(`bots: Settings › World › Bots shows ${label} (no restart pending), World on screen without scrolling`, JSON.stringify(botsRow.on) === JSON.stringify([label]) && botsRow.restart === 'Restart' && botsRow.fits, JSON.stringify(botsRow));
    }

    // (the one error line expected: the bots' store that could not be written on purpose, above)
    const expectedError = line => BOTS > 0 && /^\[error\] \[engine\] \[bots\] FAILED to write bots\/main\/bots\.sav/.test(line);
    if (BOTS !== null) {
        const engineErrors = consoleLines.filter(line => line.startsWith('[error] [engine]') && !expectedError(line));
        if (BOTS > 0) {
            check('bots: no engine error lines (both sessions)', engineErrors.length === 0, engineErrors.slice(0, 5).join(' | '));
        } else {
            const untouched = botRequests().length === 0 && fs.readFileSync(botStoreFile).equals(EMPTY_BOT_STORE);
            check('bots off: the world read and wrote nothing under bots/ (both sessions), and no engine error lines', untouched && engineErrors.length === 0, JSON.stringify({ requests: botRequests(), errors: engineErrors.slice(0, 3) }));
        }
    }
    const errors = consoleLines.filter(line => /\[(error|exception)\]/.test(line) && !expectedError(line));
    check('no console errors or exceptions', errors.length === 0, errors.slice(0, 5).join(' | '));

    if (BOTS > 0) {
        // ---------------------------------------------------------------- bots.sav and its .bak damaged (BOTS.md §4.5)
        // The world starts without the bots (never overwriting their store) and the status line says so, once, in plain
        // words (BOTS.md §4.1). (After the checks above: the engine logs this as an error.)
        // (the page leaves first: going to the background it saves, the bots too, which would rotate the damage away)
        await S('Page.navigate', { url: 'about:blank' });
        await sleep(1500);
        const damaged = Buffer.from('not a bot store');
        fs.writeFileSync(botStoreFile, damaged);
        fs.writeFileSync(`${botStoreFile}.bak`, damaged);
        const requestsFrom = saveRequests.length;
        await S('Page.navigate', { url: server.url });
        await waitFor('title (damaged bots.sav)', 'window.__client?.lastProgressPercent === 100 && !!window.__client?.titleFlames', 60000);
        const ready = await waitFor('engine (damaged bots.sav)', "window.LostCityHost?.engineState === 'ready'", 60000);
        const shown = await waitFor('the bots notice', `(window.__e2eEngine?.notices ?? []).some(text => text.startsWith('Bots are off this session: their save file is damaged.'))`, 15000);
        await screenshot('6-bots-off.png');
        const seen = await botsSeen();
        const booted = await evaluate('window.__e2eEngine?.booted ?? null');
        const untouched = fs.readFileSync(botStoreFile).equals(damaged) && !saveRequests.slice(requestsFrom).some(r => r.startsWith('PUT /save/bots/'));
        check('bots: with bots.sav and its .bak damaged the world starts without the bots, leaves the file alone, and the status line says "Bots are off this session: their save file is damaged." (and how to reset it)', ready.ok && shown.ok && seen?.bots.length === 1 && seen.bots[0].active === false && seen.bots[0].reason === 'store-corrupt' && booted?.bots === BOTS && untouched, JSON.stringify({ ...seen, booted: booted && { bundle: booted.bundle, bots: booted.bots }, untouched, requests: saveRequests.slice(requestsFrom).filter(r => r.includes('/save/bots/')) }));
    }

    // ---------------------------------------------------------------- Settings › Saved data (last: it deletes saves)
    const savedDataFrom = consoleLines.length;
    const playersDir = path.join(savesDir, 'players', 'main');
    const userSave = path.join(playersDir, `${USER}.sav`);
    const otherSave = path.join(playersDir, 'e2e_delete.sav'); // a second character: a copy of the first's save
    fs.copyFileSync(userSave, otherSave);
    const otherBytes = fs.readFileSync(otherSave);
    if (!(await state()).ingame) {
        await login(USER, 'any-password', true);
    }
    const openSavedData = async () => {
        await tapId('btn-settings');
        await tapId('nav-savedata');
        await waitFor('Saved data', `!document.getElementById('section-savedata').hidden && !document.getElementById('settings').hidden && document.querySelectorAll('#savedata-characters .data-row button').length > 0`, 5000);
        await sleep(300); // (the bots' line comes once the store is read)
        return evaluate(`[...document.querySelectorAll('#savedata-characters .data-row')].map(r => ({ name: r.querySelector('.data-name').textContent, detail: r.querySelector('.data-detail').textContent, disabled: r.querySelector('button')?.disabled ?? null }))`);
    };
    const rows = await openSavedData();
    await screenshot('7-saved-data.png');
    check('Saved data: the characters, the one in the world without Delete ("In the world now")', rows.length === (BOTS === null ? 2 : 3) && rows.some(r => r.name.toLowerCase() === USER && r.disabled === true && /In the world now/.test(r.detail)) && rows.some(r => r.name === 'E2e Delete' && r.disabled === false), JSON.stringify(rows));
    const otherRow = `#savedata-characters .data-row:nth-child(${rows.findIndex(r => r.name === 'E2e Delete') + 1}) .data-btn`;
    await tapQuery(otherRow);
    const asked = await evaluate(`!document.getElementById('confirm').hidden && document.getElementById('confirm-title').textContent`);
    await screenshot('7b-saved-data-confirm.png');
    await tapId('confirm-cancel');
    const cancelled = (await evaluate(`document.getElementById('confirm').hidden`)) && fs.existsSync(otherSave);
    await tapQuery(otherRow);
    await tapId('confirm-ok');
    const gone = await waitFor('the row goes', `![...document.querySelectorAll('#savedata-characters .data-name')].some(n => n.textContent === 'E2e Delete')`, 5000);
    const bak = fs.existsSync(`${otherSave}.bak`) && fs.readFileSync(`${otherSave}.bak`).equals(otherBytes);
    check('Saved data: Delete asks first ("Delete E2e Delete?"; Cancel keeps it), then the save goes, kept as .bak', asked === 'Delete E2e Delete?' && cancelled && gone.ok && !fs.existsSync(otherSave) && bak, JSON.stringify({ asked, cancelled, gone: gone.ok, bak }));

    const notice = text => waitFor(`the notice '${text}'`, `(() => { const pill = document.getElementById('status-pill'); return !pill.hidden && pill.textContent === ${JSON.stringify(text)}; })()`, 15000);
    const afterReload = async what => {
        const title = await waitFor(`title (${what})`, 'window.__client?.lastProgressPercent === 100 && !!window.__client?.titleFlames', 60000);
        const engine = await waitFor(`engine (${what})`, "window.LostCityHost?.engineState === 'ready'", 60000);
        return title.ok && engine.ok;
    };
    const reset = await evaluate(`({ disabled: document.getElementById('savedata-reset').disabled, bots: document.getElementById('savedata-bots').textContent })`);
    if (BOTS === null) {
        check('Saved data: no bots\' store, so Reset world is off ("None: Bots are Off")', reset.disabled && reset.bots === 'None: Bots are Off', JSON.stringify(reset));
    } else {
        const storeBefore = fs.readFileSync(botStoreFile);
        const savedAt = fs.statSync(userSave).mtimeMs;
        await tapId('savedata-reset');
        const askedReset = await evaluate(`document.getElementById('confirm-title').textContent`);
        await tapId('confirm-ok');
        const back = await afterReload('reset');
        const said = await notice('The world was reset.');
        await sleep(BOTS > 0 ? 3000 : 500);
        const booted = await evaluate('window.__e2eEngine?.booted ?? null');
        const fresh = !fs.existsSync(botStoreFile) || !readBotStore()?.error;
        const keptAsBak = fs.existsSync(`${botStoreFile}.bak`) && fs.readFileSync(`${botStoreFile}.bak`).equals(storeBefore);
        check(`Saved data: Reset world (${reset.bots}) restarts with the bots' store gone (kept as .bak) and the character kept, saved just before; "The world was reset."`, askedReset === 'Reset the world?' && !reset.disabled && back && said.ok && fresh && keptAsBak && fs.existsSync(userSave) && fs.statSync(userSave).mtimeMs > savedAt && booted?.bots === BOTS && (await evaluate(NO_BOTS_NOTICE)), JSON.stringify({ askedReset, reset, back, said: said.ok, fresh, keptAsBak, booted: booted && { bundle: booted.bundle, bots: booted.bots }, seen: await botsSeen() }));
    }

    if (await evaluate(`document.getElementById('settings').hidden || document.getElementById('section-savedata').hidden`)) {
        await openSavedData(); // (after Reset world: at the title)
    }
    await tapId('savedata-everything');
    const askedAll = await evaluate(`document.getElementById('confirm-title').textContent`);
    await tapId('confirm-ok');
    const backAll = await afterReload('everything');
    const saidAll = await notice('Everything was deleted.');
    await sleep(500);
    const left = fs.readdirSync(playersDir).filter(name => name.endsWith('.sav'));
    const title = await evaluate(`({ hint: !document.getElementById('title-hint').hidden, continueAs: !document.getElementById('btn-continue').hidden })`);
    await screenshot('7c-everything-deleted.png');
    check('Saved data: Delete everything restarts with no character and no bots\' store; "Everything was deleted."; the title asks for a name', askedAll === 'Delete everything?' && backAll && saidAll.ok && left.length === 0 && !fs.existsSync(botStoreFile) && fs.existsSync(`${userSave}.bak`) && title.hint && !title.continueAs, JSON.stringify({ askedAll, backAll, said: saidAll.ok, left, store: fs.existsSync(botStoreFile), title }));
    const savedDataErrors = consoleLines.slice(savedDataFrom).filter(line => /\[(error|exception)\]/.test(line));
    check('Saved data: no console errors', savedDataErrors.length === 0, savedDataErrors.slice(0, 5).join(' | '));

    if (ANDROID) {
        // last: a WebView without the iterator helpers the engine needs (older than Chrome 122) gets a plain error that
        // names Android System WebView, and no engine; and a phone without a vibrator no Vibration row
        const older = await S('Page.addScriptToEvaluateOnNewDocument', { source: `try { delete Iterator.prototype.map; } catch {} if (window.LostCityNative) window.LostCityNative.haptics = false;` });
        await S('Page.navigate', { url: server.url });
        const shown = await waitFor('the error screen', `!document.getElementById('error').hidden`, 20000);
        await sleep(300);
        const guard = await evaluate(`({ text: document.getElementById('error-text').textContent, vibration: !document.getElementById('vibration-row').hidden, nav: !document.getElementById('nav-sound').hidden, init: window.__androidStub?.init ?? null,
            fatal: (window.__androidStub?.posted ?? []).some(m => m.ch === 'native' && m.msg?.type === 'fatal'), engine: window.LostCityHost?.engineState })`);
        await S('Page.removeScriptToEvaluateOnNewDocument', { identifier: older.result?.identifier });
        await screenshot('8-webview-too-old.png');
        check('android: a WebView without iterator helpers: "Android System WebView is too old … (Chrome 145; 122 or later …)", fatal to native, the engine never started; no Vibration row or Sound category without a vibrator', shown.ok && /Android System WebView is too old/.test(guard.text) && /Chrome 145; 122 or later/.test(guard.text) && guard.fatal && guard.init === null && !guard.vibration && !guard.nav, JSON.stringify(guard));
    }

    exitCode = checks.every(c => c.ok) ? 0 : 1;
} catch (err) {
    if (err instanceof LmStubDone) {
        exitCode = checks.every(c => c.ok) ? 0 : 1;
    } else {
        console.error(err);
        check('harness completed', false, String(err));
    }
} finally {
    fs.writeFileSync(path.join(OUT, 'console.log'), consoleLines.join('\n'));
    fs.writeFileSync(path.join(OUT, 'worker.log'), workerLines.join('\n'));
    const bots = BOTS === null ? {} : { bots: BOTS, botsSeen: [...botNames], botStore: storeSummary(readBotStore()), saveRequests };
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ user: USER, platform: PLATFORM, checks, writes, ...bots }, null, 2));
    if (ANDROID) {
        const stub = await androidStub().catch(() => null);
        fs.writeFileSync(path.join(OUT, 'android-bridge.json'), JSON.stringify(stub, null, 2));
    }
    console.log(`\n${checks.filter(c => c.ok).length}/${checks.length} checks passed — logs in ${path.relative(process.cwd(), OUT)}`);
    if (!KEEP) {
        ws.close();
        chrome.kill('SIGTERM');
        await server.close();
    }
}
process.exit(exitCode);
