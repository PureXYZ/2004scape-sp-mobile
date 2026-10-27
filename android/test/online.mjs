// Online mode in the real Android app (docs/ONLINE.md, docs/ANDROID.md §7): the debug app on an emulator, driven over
// adb and CDP as smoke.mjs drives it, playing on a local Engine-TS 274 on this Mac (never an outside server) that the
// emulator reaches through `adb reverse`. The Android counterpart of iOS's `app-test --server`.
//
//   node android/test/online.mjs --engine <dir> [--serial emulator-5554] [--no-build] [--no-install] [--port 47640]
//                                [--node-bin <dir>] [--only a,b] [--skip a,b]
//   node android/test/online.mjs --server http://127.0.0.1:<port> …     (an engine already running on this Mac)
//
// --engine <dir>: a copy of Server/engine + Server/content made there (APFS clones, web/test/online/engine.mjs), started
// as the stock variant on --port (web), +1 (management) and +2 (node), and stopped at the end; --node-bin: a folder with
// a Node 24 whose worker threads run the engine's logins. The app's data is cleared
// at the start (an emulator only, as drive.mjs).
//
// Phases (screenshots and results.json in android/build/online/):
//   add        offline, the title's World button → the worlds sheet → Add server: the native box in the 2004 look (its
//              fields and placeholders; filled and OK'd through the DEBUG hook) → the probe says Ready → Use: the page
//              reloads on the server
//   boot       online: the cover's caption "online", engineState 'remote', no engine or save requests, /crc through the
//              proxy, the bundle's archives used (nothing fetched from the server), the title's World says the name
//   login      New User with a password through the native keyboard, Remember ticked in the bar: in the world; the
//              password kept in the Keystore (one file, not readable), the account in the settings; then the tutorial
//              skipped
//   background HOME for 5, 25, 45 and 70 s (the server's 30 s idle and 60 s silence limits): back in the world each time
//              (on its own socket or after the client's reconnect)
//   crash      the renderer crashed: the notice says to log in again; the page comes back online; "Continue as" logs in
//              with the kept password (no keyboard)
//   play       after that fresh login: a walk on the minimap, Report abuse in the chat bar
//   offline    Settings › World › Change → This phone: logged out first, the page reloads offline (the engine on the
//              page again, the cover's caption "offline")
//   lan        Android 17's local network access (the permission revoked; the engine at the emulator's alias for this
//              Mac, 10.0.2.2, a private address): Add server with that address asks for the permission first (the
//              notice and the system's prompt), allowed the probe says Ready; revoked again, a probe straight away
//              times out as "local network" and asks then; allowed, it works. Left revoked
//   leaks      the password never reaches logcat or the app's log file
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ACTIVITY, PKG, device, sleep } from './lib/adb.mjs';
import { prepareEngine, startEngine } from '../../web/test/online/engine.mjs';

const ANDROID = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO = path.dirname(ANDROID);
const OUT = path.join(ANDROID, 'build', 'online');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
};
const SERIAL = option('--serial', process.env.ANDROID_SERIAL ?? 'emulator-5554');
const ONLY = option('--only', null)?.split(',');
const SKIP = option('--skip', '')?.split(',') ?? [];
const wanted = phase => (!ONLY || ONLY.includes(phase)) && !SKIP.includes(phase);
const ENGINE_DIR = option('--engine', null);
const PORT = Number(option('--port', 47640));
const NODE_BIN = option('--node-bin', null);
let SERVER = option('--server', null);
if (!ENGINE_DIR && !SERVER) {
    console.error('online.mjs needs --engine <dir> (a local Engine-TS copy it starts) or --server http://127.0.0.1:<port>');
    process.exit(2);
}
if (!SERIAL.startsWith('emulator-')) {
    console.error(`online.mjs clears the app's data: it runs on an emulator only, not ${SERIAL}`);
    process.exit(1);
}
const PASSWORD = 'Pw4OnlineT3st';
const CAPTION = mode => `2004Scape · November 2004 · ${mode}`;

fs.mkdirSync(OUT, { recursive: true });
for (const old of fs.readdirSync(OUT)) if (old.endsWith('.png')) fs.rmSync(path.join(OUT, old));
const d = device(SERIAL);
const results = { serial: SERIAL, started: new Date().toISOString(), checks: [], measures: {} };
let failures = 0;
let shotIndex = 0;

function check(name, ok, detail = '') {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    results.checks.push({ name, ok: !!ok, detail: text });
    if (!ok) failures++;
    console.log(`${ok ? 'OK ' : 'XX '} ${name}${text ? ` — ${text}` : ''}`);
    return !!ok;
}

function shot(name) {
    const file = path.join(OUT, `${String(++shotIndex).padStart(2, '0')}-${name}.png`);
    d.screenshot(file);
    return file;
}

async function waitFor(fn, timeoutMs, intervalMs = 150) {
    const started = Date.now();
    for (;;) {
        let value;
        try {
            value = await fn();
        } catch {
            value = null;
        }
        if (value) return { ok: true, ms: Date.now() - started, value };
        if (Date.now() - started > timeoutMs) return { ok: false, ms: Date.now() - started, value };
        await sleep(intervalMs);
    }
}

const waitLog = (pattern, timeoutMs = 10000) => waitFor(() => d.log().find(line => pattern.test(line)), timeoutMs, 250);

const STATE = `(() => { const c = window.__client; const h = window.LostCityHost;
  const base = { engine: h?.engineState ?? null, server: window.lcHost?.server?.id ?? null };
  if (!c) return base;
  const p = c.localPlayer; const k = window.lcHost.keyboard; return { ...base, pct: c.lastProgressPercent, title: !!c.titleFlames,
    loginscreen: c.loginscreen, loginSelect: c.loginSelect, ingame: c.ingame, reconnecting: c.reconnecting, mes1: c.loginMes1,
    mes2: c.loginMes2, loaderHidden: document.getElementById('loading')?.hidden ?? null, modal: c.mainModalId,
    kind: k.context?.kind ?? null, remember: k.context?.remember, settingsOpen: !document.getElementById('settings').hidden,
    pos: p ? [c.mapBuildBaseX + (p.x >> 7), c.mapBuildBaseZ + (p.z >> 7), c.minusedlevel] : null }; })()`;

let page = null;
const state = () => page.eval(STATE);

async function debug(action, extra = {}) {
    return page.eval(`new Promise(resolve => {
        const id = Math.floor(Math.random() * 1e9) + 1;
        const previous = window.__lcDebugReply;
        const timer = setTimeout(() => resolve({ timeout: true }), 15000);
        window.__lcDebugReply = (replyId, value) => {
            if (replyId !== id) return previous?.(replyId, value);
            clearTimeout(timer);
            window.__lcDebugReply = previous;
            resolve(value);
        };
        window.LostCityNativeBridge.native.postMessage({ type: 'debug', id, action: ${JSON.stringify(action)}, ...${JSON.stringify(extra)} });
    })`);
}

async function reconnect(timeoutMs = 30000) {
    page?.close();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        page = await d.connect({ timeoutMs: Math.max(1000, deadline - Date.now()) });
        try {
            if ((await page.eval('1 + 1')) === 2) return page;
        } catch {
            // a target going away
        }
        page.close();
        if (Date.now() > deadline) throw new Error('no live page target');
        await sleep(500);
    }
}

/** The page after a reload native made (server use, a renderer death): a new CDP session once it is the new document. */
async function afterReload(label, mark) {
    const fresh = await waitFor(async () => {
        await reconnect(20000);
        return (await page.eval(`window.__onlineMark ?? null`)) !== mark;
    }, 40000, 500);
    check(`${label}: the page reloaded`, fresh.ok);
}

function launch({ stop = true, settings = null } = {}) {
    const args = ['shell', 'am', 'start', '-W', ...(stop ? ['-S'] : []), '-n', ACTIVITY, '--ez', 'lostcity.verbose', 'true'];
    if (settings) args.push('--es', 'lostcity.settings', `'${JSON.stringify(settings)}'`);
    return d.adb(...args);
}

async function titleUp(label, { engine, timeoutMs = 90000 }) {
    const up = await waitFor(async () => {
        const s = await state();
        return s.title && s.pct === 100 && (engine === null || s.engine === engine) && s.loaderHidden && !s.ingame ? s : null;
    }, timeoutMs, 200);
    check(`${label}: the title is up${engine ? ` (engineState ${engine})` : ''}`, up.ok, up.ok ? `${up.ms} ms` : JSON.stringify(up.value ?? (await state().catch(() => null))));
    return up.ok;
}

const visible = selector => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; const r = e.getBoundingClientRect(); return !e.closest('[hidden]') && r.width > 0 && r.height > 0; })()`);
const inWorld = (ms = 40000) => waitFor(async () => {
    const s = await state();
    return s.ingame && !s.reconnecting && s.pos ? s : null;
}, ms, 250);

// ---------------------------------------------------------------------------------------------------- engine, app

let engine = null;
if (ENGINE_DIR) {
    const dir = prepareEngine(ENGINE_DIR, path.resolve(REPO, '..', 'Server'));
    console.log(`starting the stock Engine-TS in ${dir} (web ${PORT})…`);
    engine = await startEngine({ dir, variant: 'stock', ports: { web: PORT, management: PORT + 1, node: PORT + 2 }, nodeBin: NODE_BIN });
    SERVER = engine.url;
    console.log(`   up in ${engine.started} ms: ${SERVER}`);
}
const serverPort = Number(new URL(SERVER).port || 80);
const ADDRESS = `127.0.0.1:${serverPort}`;

if (!argv.includes('--no-build')) {
    console.log('building the debug APK…');
    execFileSync(path.join(ANDROID, 'gradlew'), [':app:assembleDebug', '--console=plain', '-q'], { cwd: ANDROID, stdio: 'inherit' });
}
if (!argv.includes('--no-install')) console.log(d.install(path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')));
d.adbQuiet('shell', 'settings', 'put', 'secure', 'immersive_mode_confirmations', 'confirmed');
d.adbQuiet('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
d.adbQuiet('emu', 'sensor', 'set', 'acceleration', '9.81:0:0');
d.adbQuiet('shell', 'svc', 'power', 'stayon', 'true');
d.adbQuiet('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
d.adb('reverse', `tcp:${serverPort}`, `tcp:${serverPort}`);

const USER = `and${Date.now() % 100000}`;
results.user = USER;
let serverId = null;

try {
    d.adb('shell', 'pm', 'clear', PKG);
    d.clearLog();
    launch({ settings: { seenHowToPlay: true, bots: 0 } });
    await reconnect();
    await titleUp('offline launch', { engine: 'ready' });
    d.tapNative(/^Got it$/i);

    // ------------------------------------------------------------------------------------------------ add
    {
        // (always: the other phases play on the server it adds)
        await page.tapElement('#btn-world');
        const sheet = await waitFor(() => visible('#worlds-list'), 3000);
        check('add: the title\'s World button opens the worlds sheet', sheet.ok);
        await page.eval(`document.querySelector('#worlds-list .add-server').click()`);
        const box = await waitFor(async () => {
            const ui = d.uiDump();
            return /resource-id="io\.github\.purexyz\.scape2004:id\/server_address"/.test(ui) ? ui : null;
        }, 6000, 400);
        shot('add-server-box');
        check('add: Add server brings up the native box (Address, Name, Cancel, OK)', box.ok && ['server_title', 'server_address', 'server_name', 'server_cancel', 'server_ok'].every(id => box.value.includes(`id/${id}`)));
        const presented = await debug('ui-state');
        check('add: the box is a dialog over the game (ui-state presented)', presented?.presented === 'Dialog', JSON.stringify(presented?.presented));
        const filled = await debug('server-alert', { address: `  ${ADDRESS} `, name: ' Mac ', button: 'ok' });
        check('add: the box showed "Add a server", empty, with the placeholders', filled?.shown === true && filled.title === 'Add a server' && filled.address === '' && filled.name === '' &&
            JSON.stringify(filled.placeholders) === JSON.stringify(['192.168.1.20 or my-mac.local:8888', 'Optional']), JSON.stringify(filled));
        const ready = await waitFor(() => page.eval(`(() => { const s = document.getElementById('probe-status'); return s && /^Ready/.test(s.textContent) ? s.textContent : null; })()`), 15000, 250);
        await sleep(300);
        shot('add-probe-ready');
        check('add: the probe of the typed address says Ready (a members world)', ready.ok && /members world/.test(ready.value), ready.value ?? await page.eval(`document.getElementById('probe-status')?.textContent`));
        const kb = await debug('keyboard-state');
        check('add: the keyboard bridge has its focus back after the box', kb?.isFirstResponder === true && kb.lent === false, JSON.stringify({ first: kb?.isFirstResponder, lent: kb?.lent }));
        await page.eval('window.__onlineMark = "before-use"');
        d.clearLog();
        await page.tapElement('#probe-use');
        const used = await waitLog(/\[host\] loading .*\(play on server s-/, 10000);
        check('add: Use → native stores the choice and reloads the page on the server', used.ok, used.value?.replace(/^.*\[host\] /, ''));
        await afterReload('add', 'before-use');
    }

    // ------------------------------------------------------------------------------------------------ boot
    {
        const up = await titleUp('boot online', { engine: 'remote' });
        const online = await debug('online-state');
        serverId = online?.server ?? null;
        results.measures.onlineState = online;
        check('boot: this page load plays on the server; the cover said "online"; the bridge\'s User-Agent names Android', up && /^s-/.test(serverId ?? '') && online.url === `http://${ADDRESS}` && online.caption === CAPTION('online') && /\(Android \d/.test(online.userAgent), JSON.stringify(online));
        const log = d.log();
        const asked = log.filter(line => /\[scheme\] (GET|PUT|POST|HEAD) \/(engine\/(boot|engine)|save-index|save\/)/.test(line));
        check('boot: no engine on the page (no engine/boot.js or engine.js, no /save-index or /save)', asked.length === 0, asked.slice(0, 3).join(' | ') || 'none');
        const crc = log.find(line => /\[online\] \/crc of /.test(line));
        check('boot: /crc through the proxy, the same archives as the bundle (nothing to fetch)', /the same archives as the bundle/.test(crc ?? ''), crc?.replace(/^.*\[online\] /, '') ?? 'no /crc line');
        check('boot: no archive fetched from the server', !log.some(line => /\[online\] \w+-?\d+ of .*cached/.test(line)));
        const title = await page.eval(`({ world: document.getElementById('world-name').textContent, hint: document.getElementById('title-hint').hidden ? null : document.getElementById('title-hint').textContent, characters: !document.getElementById('btn-characters').hidden })`);
        check('boot: the title\'s World says "Mac", the online hint, no Characters', title.world === 'Mac' && /^Online/.test(title.hint ?? '') && !title.characters, JSON.stringify(title));
        shot('title-online');
    }

    // ------------------------------------------------------------------------------------------------ login
    if (wanted('login') || wanted('background') || wanted('crash') || wanted('play')) {
        d.clearLog();
        await page.tapGame(302, 291); // New User
        const form = await waitFor(async () => {
            const s = await state();
            return s.loginscreen === 2 && s.kind === 'login-user' ? s : null;
        }, 5000);
        check('login: New User opens the form with the username keyboard', form.ok, JSON.stringify(form.value ?? null));
        await debug('type', { text: USER });
        await sleep(400);
        await debug('bar', { button: 'submit' });
        const pass = await waitFor(async () => {
            const k = await debug('keyboard-state');
            return k?.kind === 'login-pass' && k.remember !== null && k.remember !== undefined ? k : null;
        }, 5000);
        check('login: on to the password, the bar shows the Remember box (not ticked)', pass.ok && pass.value.remember === false, JSON.stringify({ kind: pass.value?.kind, remember: pass.value?.remember, layout: pass.value?.rememberLayout }));
        await sleep(1000); // (the bar's chips and line settle: ChangeBounds, 150 ms)
        const layout = (await debug('keyboard-state'))?.rememberLayout;
        const right = rect => rect[0] + rect[2];
        check('login: the Remember box sits left of Log in, clear of the input line', !!layout && right(layout.remember) <= layout.submit[0] && right(layout.field) <= layout.remember[0], JSON.stringify(layout));
        const ticked = await debug('remember-tap');
        await sleep(400);
        shot('login-remember');
        const pageSide = await state();
        check('login: a tap ticks it and the page hears it (its keyboard context says remember: true)', ticked === true && pageSide.remember === true, JSON.stringify({ ticked, page: pageSide.remember }));
        await debug('type', { text: PASSWORD });
        await sleep(400);
        await debug('bar', { button: 'submit' });
        const world = await inWorld(60000);
        check('login: a password login through the native keyboard reaches the world', world.ok, JSON.stringify(world.value?.pos ?? (await state())));
        const remembered = await waitLog(/\[accounts\] remembered the password of /, 8000);
        const files = d.adbQuiet('shell', 'run-as', PKG, 'find', 'no_backup/server-passwords', '-type', 'f').trim().split('\n').filter(Boolean);
        const raw = files.length ? d.adbQuiet('shell', 'run-as', PKG, 'cat', files[0]) : '';
        check('login: Remember on → the password kept: one Keystore-wrapped file for this server, the password not in it', remembered.ok && files.length === 1 && files[0].includes(`/${serverId}/`) && !raw.includes(PASSWORD) && raw.startsWith('LCP1'), files.join(' '));
        const accounts = await debug('settings');
        check('login: the account is in the settings (names only, never a password)', accounts?.accounts?.[serverId]?.[0]?.name === USER && !JSON.stringify(accounts).includes(PASSWORD), JSON.stringify(accounts?.accounts));
        // the designer (once it is open: accepted after the tutorial skip it would start the tutorial again), the tutorial
        // skipped (the stock engine's characters are staff), Lumbridge, a walk
        const designer = await waitFor(async () => (await state()).modal !== -1, 10000);
        await page.eval('(() => { const c = window.__client; if (c.mainModalId !== -1) c.tapAt(c.viewportX + c.modalX + 256, c.viewportY + c.modalY + 282, 1); })()');
        const accepted = await waitFor(async () => (await state()).modal === -1, 6000);
        check('login: the character designer opens and is accepted', designer.ok && accepted.ok);
        await page.eval(`LostCityHost.keyboard.insertText('::setvar tutorial 1000\\n')`);
        await sleep(1500);
        await page.eval(`LostCityHost.keyboard.insertText('::tele 0,50,50,22,18\\n')`);
        await sleep(2500);
    }

    // ------------------------------------------------------------------------------------------------ background
    if (wanted('background')) {
        for (const seconds of [5, 25, 45, 70]) {
            d.clearLog();
            d.adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
            await sleep(seconds * 1000);
            launch({ stop: false });
            await reconnect();
            const back = await inWorld(45000);
            const log = d.log();
            const closes = log.filter(line => /\[socket\] socket \d+ \(game.*(closed|error)/.test(line)).map(line => line.replace(/^.*\[socket\] /, ''));
            const opened = log.filter(line => /\[socket\] socket \d+ \(game.*open$/.test(line)).length;
            results.measures[`background${seconds}`] = { back: back.ok, ms: back.ms, closes, opened };
            check(`background ${seconds} s: back in the world${closes.length ? ' (after the client\'s reconnect)' : ' (the same socket)'}`, back.ok, `${back.ms} ms; ${closes.length ? closes.join(' | ') : 'no socket closed'}${opened ? `; ${opened} socket(s) opened` : ''}`);
        }
        shot('after-background');
    }

    // ------------------------------------------------------------------------------------------------ crash
    if (wanted('crash')) {
        await page.eval('window.__onlineMark = "before-crash"');
        d.clearLog();
        const crashed = Date.now();
        await page.eval(`window.LostCityNativeBridge.native.postMessage({ type: 'debug', id: 0, action: 'renderer-crash' })`);
        const gone = await waitLog(/WebView renderer gone/, 12000);
        check('crash: the renderer crashed', gone.ok, gone.value?.replace(/^.*\[host\] /, ''));
        await afterReload('crash', 'before-crash');
        const notice = await debug('last-notice');
        check('crash: the notice says the game is restarting and to log in again', typeof notice === 'string' && notice.endsWith(' You will need to log in again.'), JSON.stringify(notice));
        await titleUp('crash: back online', { engine: 'remote' });
        await sleep(1000);
        const continueAs = await page.eval(`!document.getElementById('btn-continue').hidden && document.getElementById('continue-name').textContent`);
        check('crash: the title offers "Continue as" the account', continueAs === USER, JSON.stringify(continueAs));
        // (the server keeps the dead page's character in the world until it asks for an idle logout, 30 s without a
        // connection: a login before that is "already logged in", as on iOS and in a browser)
        await sleep(Math.max(0, 36000 - (Date.now() - crashed)));
        d.clearLog();
        await page.tapElement('#btn-continue');
        const back = await inWorld(30000);
        if (!back.ok) results.measures.continueAs = await state();
        const asked = d.log().find(line => /\[accounts\] login as .*: the stored password/.test(line));
        const kb = await debug('keyboard-state');
        check('crash: Continue as logs in with the kept password (native gave it; no keyboard)', back.ok && !!asked && kb?.requested === false, asked?.replace(/^.*\[accounts\] /, '') ?? 'no account login line');
    }

    // ------------------------------------------------------------------------------------------------ play
    // (after a fresh login: the first one left Tutorial Island's tabs and instructions up, which a relog clears)
    if (wanted('play') && wanted('crash')) {
        await sleep(2500);
        const before = (await state()).pos;
        const rect = await page.eval(`(() => { const r = document.getElementById('surface-map').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
        await page.touch(rect.x + (95 * rect.w) / 172, rect.y + (89 * rect.h) / 156);
        const moved = await waitFor(async () => JSON.stringify((await state()).pos) !== JSON.stringify(before), 8000);
        await sleep(2000);
        shot('walked-online');
        check('play: a touch on the minimap walks (the server moves the character)', moved.ok, `${JSON.stringify(before)} → ${JSON.stringify((await state()).pos)}`);

        let open = false;
        for (let i = 0; i < 3 && !open; i++) {
            await page.tapElement('#btn-chat-toggle');
            open = (await waitFor(() => visible('#hud-chat-modes'), 1500)).ok;
        }
        const report = await visible('#btn-report');
        shot('report-abuse');
        check('play: Report abuse is in the chat bar online', open && report);
        await page.tapElement('#btn-chat-toggle');
    }

    // ------------------------------------------------------------------------------------------------ offline
    if (wanted('offline')) {
        await page.eval('window.__onlineMark = "before-offline"');
        d.clearLog();
        await page.tapElement('#btn-settings');
        await page.eval(`document.getElementById('nav-world').click()`);
        await sleep(300);
        const playOn = await page.eval(`document.getElementById('world-playon-name').textContent`);
        check('offline: Settings › World says where the game plays (Mac and its address)', playOn.startsWith('Mac'), JSON.stringify(playOn));
        await page.eval(`document.getElementById('world-change').click()`);
        await waitFor(() => visible('#worlds-list'), 3000);
        await page.eval(`[...document.querySelectorAll('#worlds-list .world-row .character')].find(b => b.querySelector('.character-name').textContent === 'This phone').click()`);
        const reload = await waitLog(/\[host\] loading .*\(play offline\)/, 15000);
        const loggedOut = d.log().findIndex(line => /\[socket\] socket \d+ \(game.*closed/.test(line));
        check('offline: This phone logs out first, then native reloads the page offline', reload.ok, reload.value?.replace(/^.*\[host\] /, ''));
        await afterReload('offline', 'before-offline');
        await titleUp('offline again', { engine: 'ready' });
        const online = await debug('online-state');
        check('offline: no server for this page; the cover said "offline"; LostCityNative.settings.server is offline', online?.server === null && online.caption === CAPTION('offline') && (await page.eval('window.LostCityNative.settings.server')) === 'offline', `${JSON.stringify(online)} (socket closed at log line ${loggedOut})`);
        shot('offline-title');
    }

    // ------------------------------------------------------------------------------------------------ lan
    if (wanted('lan')) {
        const permission = 'android.permission.ACCESS_LOCAL_NETWORK';
        const lan = `10.0.2.2:${serverPort}`;
        const relaunch = async label => {
            // (a revoked runtime permission ends the app's process)
            d.adbQuiet('shell', 'am', 'force-stop', PKG);
            d.adbQuiet('shell', 'pm', 'revoke', PKG, permission);
            d.clearLog();
            launch();
            await reconnect();
            await titleUp(label, { engine: null });
        };
        const prompt = () => waitFor(() => (/permissioncontroller/.test(d.uiDump()) ? true : null), 8000, 500);

        // 1. Add server with a local address (the emulator's alias for this Mac, a private address): native asks first
        await relaunch('lan: relaunched without the permission');
        const access = await debug('local-network');
        await sleep(1500);
        d.tapNative(/^Got it$/i);
        const sheet = await waitFor(async () => {
            if (!(await visible('#worlds-list'))) await page.tapElement('#btn-world');
            return page.eval(`!!document.querySelector('#worlds-list .add-server') && !document.getElementById('worlds').hidden`);
        }, 10000, 1000);
        if (!sheet.ok) {
            shot('lan-no-sheet');
            results.measures.lanTitle = await page.eval(`({ world: (() => { const e = document.getElementById('btn-world'); const r = e.getBoundingClientRect(); return { hidden: e.hidden, closed: !!e.closest('[hidden]'), r: [r.left, r.top, r.width, r.height] }; })(), overlays: [...document.querySelectorAll('.overlay')].filter(o => !o.hidden).map(o => o.id), top: (() => { const e = document.getElementById('btn-world'); const r = e.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.id ?? null; })() })`);
        }
        check('lan: the worlds sheet opens again', sheet.ok, JSON.stringify(results.measures.lanTitle ?? ''));
        await page.eval(`document.querySelector('#worlds-list .add-server').click()`);
        await sleep(1500);
        await debug('server-alert', { address: lan, name: 'LAN', button: 'ok' });
        const asked = await prompt();
        shot('lan-permission-prompt');
        const notice = await debug('last-notice');
        check('lan: Add server with a local address, the permission not granted: the notice and the system\'s prompt before the probe', access?.exists === true && access.granted === false && asked.ok && /local network/.test(notice ?? ''), JSON.stringify({ access, notice }));
        const allowed = d.tapNative(/^Allow$/i);
        const ready = await waitFor(() => page.eval(`(() => { const s = document.getElementById('probe-status'); return s && /^(Ready|Not ready)/.test(s.textContent) ? s.textContent : null; })()`), 15000, 250);
        check('lan: allowed, the probe of the local address says Ready', allowed && /^Ready/.test(ready.value ?? ''), JSON.stringify(ready.value));
        await page.tapElement('#probe-cancel');

        // 2. a connection refused for want of it (the probe asked straight away): "local network", the notice, the prompt
        await relaunch('lan: relaunched without the permission again');
        const probe = () => page.eval(`fetch('server-probe?url=' + encodeURIComponent('http://${lan}')).then(r => r.json())`);
        const refused = await probe();
        const asked2 = await prompt();
        const notice2 = await debug('last-notice');
        results.measures.lan = { access, refused, notice: notice2 };
        check('lan: a local address without the permission: the probe says "local network" (it timed out), then the notice and the prompt', refused?.ok === false && refused.error === 'local network' && asked2.ok && /local network/.test(notice2 ?? ''), JSON.stringify({ refused, notice: notice2 }));
        d.tapNative(/^Allow$/i);
        await sleep(1000);
        const again = await probe();
        check('lan: allowed, the same probe works', again?.ok === true, JSON.stringify(again));
        d.adbQuiet('shell', 'am', 'force-stop', PKG);
        d.adbQuiet('shell', 'pm', 'revoke', PKG, permission);
    }
} catch (error) {
    check('the run finished', false, error.stack ?? String(error));
} finally {
    // ------------------------------------------------------------------------------------------------ leaks
    const logcat = d.adbQuiet('logcat', '-d', '-v', 'time', '-s', 'LostCity:V');
    const file = d.adbQuiet('shell', 'cat', `/sdcard/Android/data/${PKG}/files/Logs/lostcity.log`);
    fs.writeFileSync(path.join(OUT, 'logcat.txt'), logcat);
    fs.writeFileSync(path.join(OUT, 'app-log.txt'), file);
    check('leaks: the password is in neither logcat nor the app\'s log file', !logcat.includes(PASSWORD) && !file.includes(PASSWORD), `${logcat.length} + ${file.length} characters`);
    page?.close();
    d.adbQuiet('reverse', '--remove', `tcp:${serverPort}`);
    d.adbQuiet('shell', 'svc', 'power', 'stayon', 'false');
    if (engine) await engine.stop();
    const passed = results.checks.filter(c => c.ok).length;
    results.finished = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(results, null, 1)}\n`);
    console.log(`\n${passed}/${results.checks.length} checks passed — ${OUT}`);
    process.exit(failures ? 1 : 0);
}
