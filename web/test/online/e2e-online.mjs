// End-to-end test of online mode (docs/ONLINE.md) in headless Chrome: the page as the app runs it online, through the
// desktop double of native (native-double.mjs: the socket bridge, the proxy routes, the accounts, the server box), against
// a local Engine-TS 274 and its variants. Never against an official server.
//
//   node web/test/e2e.mjs --engine <dir> [--engine-node <dir>] [--port 47625] [--only stock,down,login,...] [--keep]
//                         [--platform android]
//   node web/test/e2e.mjs --server http://127.0.0.1:47620 [--port 47625]      (a server already running: stock, down)
//   (build first: node scripts/build-web.mjs)
//
// --engine <dir>: the test engine's copy (engine.mjs prepareEngine: <dir>/engine and <dir>/content, APFS clones of the
// upstream checkouts, made when missing); the run starts and stops each variant itself, and makes the drift copy beside
// it (<dir>-drift, drift.mjs). --engine-node <dir>: a folder with a current Node 24 for the engine (its worker threads
// need one: engine.mjs). Each group, in order:
//   stock: boot with no engine requests and the caption online, the settings (given back with sorted keys, as native
//     stores them) not saved again; Settings gating; New User's online hint; a password
//     login through the keyboard bridge with Remember (save-password, accounts); Report abuse in the chat bar; the
//     logout and "Continue as" with the kept password; a dropped connection and the client's reconnect (opcode 18,
//     the same session); switching online -> offline in game (a clean logout, the engine on the page again) and back
//     from the title; Accounts (Forget password, Continue as without one, Remove); the worlds (an address that is not
//     one, Add server and its probe, Edit, Edit to another address of a server with a password kept (asked: the same
//     server?), a server that cannot be reached, Delete with its confirm box);
//   down: a server that cannot be reached: the box within seconds, Choose world, Edit the server in use to an address
//     that works and Use (the page loads again there), Play offline;
//   login: a login server with passwords: registered at the first login, a wrong password (3), the right one with
//     Remember; the password changed on the server: "Continue as" fails (3), the new one typed on the same form is kept
//     in place of the old, and "Continue as" works again;
//   key: a server with its own login key: the built-in key gets 6 (worded for a server), the server's key logs in;
//   full: maxConnected -1 (the engine checks players > maxConnected): 7; origin: an allowed Origin set: the upgrade refused (the box, the HTTP status);
//   silent: a server that takes the game's connection and never answers (silent.mjs in front of the stock engine): the
//     client gives up after its 30 s read timeout with "Error connecting to server." and keeps running (client patch
//     0031), the box says it did not answer;
//   production: staff level 0 (no "::" chips);
//   drift: a server whose content moved on: its versionlist downloaded and cached, the animations at the title and the
//     character's models and map in game fetched over the OnDemand socket and stored in the app's cache, the OnDemand
//     timer stopped on the title once nothing is left to fetch; the next session takes them from there.
// --platform android: the page as the Android app runs it (a Pixel-class screen at 2.625, WebView's user agent; the
// double speaks the Android bridge: LostCityNativeBridge and lcAndroid, its calls through window.__lcCall, and the page
// stores OnDemand files in X-LC-Body), every group the same.
// Exit code 0 = all checks passed. Screenshots, the double's log and results: build/tmp/e2e-online/ (-android).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTENT_DIR } from '../../../scripts/lib/upstream.mjs';
import { readFile, readPack } from '../../client/lib/cache.mjs';
import { ANDROID_SCREENS, ANDROID_UA } from '../android-stub.mjs';
import { launch, sleep } from '../gallery/cdp.mjs';
import { serve } from '../serve.mjs';
import { prepareDrift } from './drift.mjs';
import { PORTS, prepareEngine, startEngine } from './engine.mjs';
import { probeServer } from './native-double.mjs';
import { silentServer } from './silent.mjs';

const IOS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GROUPS = ['stock', 'down', 'login', 'key', 'full', 'origin', 'silent', 'production', 'drift'];
const SILENT_PORT = 47627;
const LOGIN_HINT = 'Enter your username & password.';
const SID = 's-e2etest1';

export async function runOnline(argv) {
    const option = (name, fallback = null) => {
        const i = argv.indexOf(`--${name}`);
        return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
    };
    const PORT = Number(option('port', 47625));
    const ANDROID = option('platform', 'ios') === 'android';
    const OUT = path.join(IOS, 'build', 'tmp', `e2e-online${ANDROID ? '-android' : ''}${PORT === 47625 ? '' : `-${PORT}`}`);
    const GAME = path.resolve(option('game', path.join(IOS, 'build', 'Game')));
    const SERVER = option('server');
    const ENGINE = SERVER ? null : path.resolve(option('engine', path.join(IOS, 'build', 'tmp', 'online-server')));
    const NODE_BIN = option('engine-node');
    const KEEP = argv.includes('--keep');
    const only = option('only', '').split(',').filter(Boolean);
    const groups = GROUPS.filter(g => (only.length ? only.includes(g) : SERVER ? g === 'stock' || g === 'down' : true));
    if (only.some(g => !GROUPS.includes(g))) {
        console.error(`--only takes ${GROUPS.join(', ')}`);
        return 2;
    }
    if (fs.existsSync(path.join(GAME, 'autotest.js'))) {
        console.error('build/Game is the self-playing autotest variant (left by app-test.mjs); run node scripts/build-web.mjs first');
        return 1;
    }
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });

    const checks = [];
    const check = (name, ok, detail = '') => {
        checks.push({ name, ok: !!ok, detail });
        console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
        return !!ok;
    };

    // ---------------------------------------------------------------------------------------------------- the server
    let engine = null;
    let engineDir = null;
    const startVariant = async variant => {
        await engine?.stop();
        engine = null;
        if (SERVER) {
            return { url: SERVER, key: null };
        }
        const dir = variant === 'drift' ? prepareDrift({ dir: `${ENGINE}-drift`, from: ENGINE, nodeBin: NODE_BIN }).engine : engineDir;
        engine = await startEngine({ dir, variant: variant === 'drift' || variant === 'silent' ? 'stock' : variant, nodeBin: NODE_BIN });
        console.log(`[e2e-online] engine ${variant} up in ${engine.started} ms`);
        return engine;
    };
    if (ENGINE) {
        engineDir = prepareEngine(ENGINE, path.dirname(CONTENT_DIR));
    }

    // ---------------------------------------------------------------------------------------------------- the page
    const requests = []; // [page load, 'METHOD /path']
    let pageLoads = 0;
    const server = await serve({
        port: PORT,
        root: GAME,
        saves: path.join(OUT, 'saves'),
        log: false,
        onLog: () => {},
        onRequest: (method, pathname) => {
            if (pathname === '/' || pathname === '/index.html') {
                pageLoads++;
            }
            requests.push([pageLoads, `${method} ${pathname}`]);
        },
        app: { platform: ANDROID ? 'android' : 'ios', cacheDir: path.join(OUT, 'app-cache'), settings: { seenHowToPlay: true, bots: 0, xpRate: 1, jmod: true } }
    });
    const app = server.app;
    const screen = ANDROID_SCREENS['a-medium'];
    const page = ANDROID
        ? await launch({ port: PORT + 1, profileDir: path.join(OUT, 'chrome-profile'), view: screen.view, scale: screen.dpr, userAgent: ANDROID_UA })
        : await launch({ port: PORT + 1, profileDir: path.join(OUT, 'chrome-profile'), view: { width: 812, height: 375 }, scale: 3 });
    // the loader's caption as the page first has it (right after its inline script), on every load
    await page.S('Page.addScriptToEvaluateOnNewDocument', {
        source: `document.addEventListener('readystatechange', () => { if (document.readyState === 'interactive') window.__e2eCaption = document.getElementById('loading-sub')?.textContent ?? null; });`
    });

    const evaluate = expression => page.evaluate(expression);
    const shot = name => page.screenshot(path.join(OUT, `${name}.png`)).catch(() => {});
    const waitFor = (expression, ms, interval = 150) => page.waitFor(expression, ms, interval);
    const STATE = `(() => { const c = window.__client; const h = window.LostCityHost; if (!c) return { engine: h?.engineState ?? null };
        const p = c.localPlayer; const k = window.lcHost.keyboard; return {
        engine: h.engineState, pct: c.lastProgressPercent, msg: c.lastProgressMessage, loginscreen: c.loginscreen, loginSelect: c.loginSelect,
        user: c.loginUser, pass: c.loginPass ? '(typed)' : '', ingame: c.ingame, reconnecting: c.reconnecting, mes1: c.loginMes1, mes2: c.loginMes2,
        staff: c.staffmodlevel, kb: k.isShown(), kind: k.context?.kind ?? null, remember: k.context?.remember, prompt: k.context?.prompt ?? null,
        pos: p ? [c.mapBuildBaseX + (p.x >> 7), c.mapBuildBaseZ + (p.z >> 7), c.minusedlevel] : null }; })()`;
    const state = () => evaluate(STATE);
    const visible = selector => page.rect(selector).then(r => !!r?.visible);
    const tapSel = async selector => {
        const r = await page.rect(selector);
        if (!r?.visible) {
            throw new Error(`${selector} is not on screen`);
        }
        await page.tap(r.cx, r.cy);
        await sleep(300);
    };
    const tapGame = async (gx, gy) => {
        const r = await page.rect('#canvas');
        await page.tap(r.x + (gx * r.w) / 765, r.y + (gy * r.h) / 503);
        await sleep(400);
    };
    const titleUp = (ms = 60000) => waitFor(`!!window.__client && window.__client.lastProgressPercent === 100 && !!window.__client.titleFlames && document.getElementById('loading').hidden && !window.__client.ingame`, ms);
    const open = async (label, ready = titleUp) => {
        const from = app.state.log.length;
        await page.navigate(server.url);
        const up = await ready();
        if (!up.ok) {
            await shot(`${label}-not-up`);
        }
        return { up, from, load: pageLoads };
    };
    const typed = (field, text) => waitFor(`window.__client.${field} === ${JSON.stringify(text)} && window.__client.keyQueueReadPos === window.__client.keyQueueWritePos`, 3000, 20);
    const posted = (from = 0) => app.state.posted.slice(from);
    const logSince = from => app.state.log.slice(from);
    const entry = (url, extra = {}) => ({ id: SID, name: 'Test server', url, nodeId: 10, members: true, rsa: null, added: Date.now(), ...extra });
    // the double's stored settings as native keeps them (the page reads them at its next load)
    const setSettings = patch => {
        app.state.settings = { ...app.state.settings, ...patch };
    };
    const useServer = async (url, extra = {}) => {
        const probe = await probeServer(url);
        setSettings({ server: SID, servers: [entry(probe.url ?? url, { nodeId: probe.nodeId, members: probe.members, rsa: probe.rsa, ...extra })] });
        return probe;
    };

    // A login on the title through the keyboard bridge, as the native keyboard types: New User or Existing User, the
    // name, the "Log in" key (online: on to the password field), Remember as asked, the password, "Log in". Resolves with
    // the state once in game or once the form says why not.
    const login = async (name, password, { newUser = false, remember = null } = {}) => {
        await tapGame(newUser ? 302 : 462, 291);
        const form = await waitFor(`window.__client.loginscreen === 2 && window.lcHost.keyboard.context?.kind === 'login-user'`, 4000);
        const hint = await evaluate(`[window.__client.loginMes1, window.__client.loginMes2]`);
        await evaluate(`LostCityHost.keyboard.insertText(${JSON.stringify(name)})`);
        await typed('loginUser', name);
        await evaluate('LostCityHost.keyboard.submit()');
        const toPassword = await waitFor(`window.__client.loginSelect === 1 && window.lcHost.keyboard.context?.kind === 'login-pass'`, 4000);
        const passField = await state();
        if (remember !== null) {
            await evaluate(`LostCityHost.keyboard.remember(${remember})`);
            await sleep(250);
        }
        await evaluate(`LostCityHost.keyboard.insertText(${JSON.stringify(password)})`);
        await typed('loginPass', password);
        await evaluate('LostCityHost.keyboard.submit()');
        const outcome = await waitFor(`window.__client.ingame === true || (!!window.__client.loginMes2 && !['Connecting to server...', ${JSON.stringify(LOGIN_HINT)}].includes(window.__client.loginMes2) && window.__client.loginMes1 !== 'Type a name and a password.')`, 30000);
        return { ...(await state()), form: form.ok, hint, toPassword: toPassword.ok, passField, outcome: outcome.ok };
    };
    const inGame = () => waitFor(`window.__client?.ingame === true && !window.__client.reconnecting && !!window.__client.localPlayer`, 30000);
    // The Logout tab's button, as the player taps it in the HUD (the tab, then "Click here to logout" in its panel).
    const logout = async () => {
        const out = `window.__client.ingame === false && !window.__client.reconnecting && document.getElementById('hud').hidden`;
        for (let i = 0; i < 12 && !(await evaluate(out)); i++) {
            const tab = await evaluate(`window.__client.hudState().activeTab`);
            const panel = await page.rect('#surface-side');
            if (tab !== 10 || !panel?.visible) {
                await tapSel('#hud-tabs .tab[data-tab="10"]'); // (a first tap may only close a window)
            } else {
                await page.tap(panel.x + (94 * panel.w) / 190, panel.y + (170 * panel.h) / 261); // "Click here to logout"
                await waitFor(out, 3000);
            }
            await sleep(300);
        }
        return waitFor(out, 5000);
    };
    // Tutorial Island: the character designer's Accept (classic 260,286 at the modal's offset in the world, through tapAt:
    // the pointer moved there and the menu built first), then the tutorial skipped (a staff command: the stock engine's
    // characters are staff). Accepted first: accepting it later starts the tutorial again (%tutorial = 1).
    const skipTutorial = async () => {
        await evaluate(`(() => { const c = window.__client; if (c.mainModalId !== -1) c.tapAt(c.viewportX + c.modalX + 256, c.viewportY + c.modalY + 282, 1); })()`);
        await waitFor(`window.__client.mainModalId === -1`, 5000);
        await evaluate(`LostCityHost.keyboard.insertText('::setvar tutorial 1000\\n')`);
        await sleep(1500);
    };
    const noErrors = (from, allowed = () => false) => page.consoleLines.slice(from).filter(line => /^\[(error|exception)\]/.test(line) && !allowed(line));

    let exitCode = 1;
    try {
        for (const group of groups) {
            console.log(`\n---- ${group} ----`);
            const variant = group === 'down' ? null : await startVariant(group);
            const consoleFrom = page.consoleLines.length;

            if (group === 'stock') {
                const probe = await useServer(variant.url);
                check('stock: the probe (as Add server runs it) finds a 2004Scape server: world 10, members, the key in its client.js', probe.ok && probe.crc && probe.nodeId === 10 && probe.members === true && /^\d{40,}$/.test(probe.rsa?.n ?? '') && probe.notes.length === 0, probe);

                // ---------------------------------------------------------------- boot
                const bootPosted = app.state.posted.length;
                const boot = await open('boot');
                const loads = requests.filter(([n]) => n === boot.load).map(([, r]) => r);
                const engineAsked = loads.filter(r => /\/engine\/(boot|engine|engine-bots|vfs-manifest)|\/save-index|\/save\//.test(r));
                const fetched = logSince(boot.from).filter(line => / from the server/.test(line));
                const caption = await evaluate(`({ first: window.__e2eCaption, now: document.getElementById('loading-sub').textContent, engine: LostCityHost.engineState, server: lcHost.server && { id: lcHost.server.id, url: lcHost.server.url } })`);
                check('boot: the title online, with no engine on the page (no engine/boot.js or engine.js, no /save-index, no /save) and engineState "remote"', boot.up.ok && engineAsked.length === 0 && caption.engine === 'remote' && caption.server?.id === SID, { ms: boot.up.ms, engineAsked, server: caption.server });
                check('boot: the loader says "online" from its first paint (one text node, as the native covers)', caption.first === '2004Scape · November 2004 · online' && caption.now === caption.first, caption);
                check('boot: /crc through the proxy, the 8 jags the bundled ones (the server\'s CRCs are the bundle\'s): nothing downloaded', logSince(boot.from).some(l => /^\/crc from .*: ok$/.test(l)) && fetched.length === 0, logSince(boot.from).filter(l => !l.startsWith('socket')));
                const natives = posted().filter(m => m.type === 'status').map(m => m.phase);
                check('boot: native hears ready and status booting / title, never engine-ready', posted().some(m => m.type === 'ready') && natives.includes('booting') && !natives.includes('engine-ready'), natives);
                await sleep(500);
                const bootSettings = posted(bootPosted).filter(m => m.type === 'settings');
                check('boot: the stored settings, given back with their keys sorted as native keeps them, are not saved again (nothing to correct)', bootSettings.length === 0, bootSettings.map(m => Object.keys(m.values ?? {}).length));
                const title = await evaluate(`({ world: document.getElementById('world-name').textContent, hint: document.getElementById('title-hint').hidden ? null : document.getElementById('title-hint').textContent, continueAs: !document.getElementById('btn-continue').hidden, characters: !document.getElementById('btn-characters').hidden, accounts: !document.getElementById('btn-accounts').hidden })`);
                await shot('stock-1-title');
                check('title: World "Test server", the online hint, no Characters (no saves online), no Continue as yet', title.world === 'Test server' && title.hint === 'Online: log in with a name and a password' && !title.continueAs && !title.characters && !title.accounts, title);

                // ---------------------------------------------------------------- Settings gating
                await tapSel('#btn-settings');
                await evaluate(`document.getElementById('nav-world').click()`);
                await sleep(250);
                const gating = await evaluate(`({ playOn: document.getElementById('world-playon-name').textContent, rows: [...document.querySelectorAll('#section-world .offline-only')].map(r => r.hidden), note: !document.getElementById('world-online-note').hidden,
                    detail: !document.querySelector('#section-world .seg[data-setting="lowMemory"]').closest('.row').hidden, botchat: document.getElementById('nav-botchat').hidden, savedata: document.getElementById('nav-savedata').hidden, save: document.getElementById('settings-save').hidden })`);
                await shot('stock-2-settings-world');
                await tapSel('#settings-close');
                check('Settings online: World says "Play on Test server (127.0.0.1:…)"; the world on this phone\'s rows and Restart hidden, the note, Detail kept; Bot chat and Saved data hidden; no Save now', /^Test server \(127\.0\.0\.1:\d+\)$/.test(gating.playOn) && gating.rows.length === 5 && gating.rows.every(Boolean) && gating.note && gating.detail && gating.botchat && gating.savedata && gating.save, gating);

                // ---------------------------------------------------------------- New User, a password login with Remember
                const name = `on${Date.now() % 100000}`;
                const postedFrom = app.state.posted.length;
                const first = await login(name, 'secret1', { newUser: true, remember: true });
                const kb = posted(postedFrom).filter(m => m.type === 'keyboard' && (m.kind === 'login-pass' || 'remember' in m));
                check('New User online: the login form with "Type a name and a password. / Your server may ask you to register first."', first.form && first.hint[0] === 'Type a name and a password.' && first.hint[1] === 'Your server may ask you to register first.', first.hint);
                check('the username\'s "Log in" key goes on to the password field (no password filled in online)', first.toPassword && first.passField.pass === '' && first.passField.kind === 'login-pass', first.passField);
                check('the password\'s keyboard carries the Remember box: off the first time, on after LostCityHost.keyboard.remember(true) (an update)', kb[0]?.action === 'show' && kb[0].remember === false && kb.some(m => m.action === 'update' && m.remember === true), kb.map(m => `${m.action} ${m.remember}`));
                check('a password login through the keyboard bridge reaches the game (a new character on the server)', first.ingame === true && (await inGame()).ok, { mes: [first.mes1, first.mes2] });
                await sleep(1500);
                const accountMsgs = posted(postedFrom).filter(m => m.type === 'account');
                const stored = app.state.settings.accounts?.[SID] ?? [];
                const savedNow = await evaluate(`JSON.stringify(window.LostCityNative.savedPasswords)`);
                check('Remember on: after the login the page asks native to keep the password (save-password, this server, the name), and only then', accountMsgs.length === 1 && accountMsgs[0].action === 'save-password' && accountMsgs[0].server === SID && accountMsgs[0].name === name && app.state.passwords.has(`${SID}/${name}`), { accountMsgs, savedNow });
                check('the name is kept in settings.accounts, newest first; never a password in the settings', stored[0]?.name === name && !JSON.stringify(app.state.settings).includes('secret1'), stored);
                await tapSel('#btn-settings');
                const saveNow = await evaluate(`document.getElementById('settings-save').hidden`);
                await tapSel('#settings-close');
                check('in game online: no Save now', saveNow);

                // ---------------------------------------------------------------- Report abuse, the logout, Continue as
                await skipTutorial();
                const out = await logout();
                await sleep(800);
                const titleAgain = await evaluate(`({ continueAs: !document.getElementById('btn-continue').hidden && document.getElementById('continue-name').textContent, accounts: !document.getElementById('btn-accounts').hidden })`);
                await shot('stock-3-continue-as');
                check('logged out through the Logout tab: the title offers "Continue as <name>" and Accounts', out.ok && titleAgain.continueAs === name && titleAgain.accounts, titleAgain);
                const continueFrom = app.state.posted.length;
                await tapSel('#btn-continue');
                const back = await inGame();
                const continued = posted(continueFrom).filter(m => m.type === 'account' || m.type === 'keyboard');
                check('"Continue as" with a kept password: native asked (account login), the page logs in at once (no keyboard), and keeps nothing again', back.ok && continued.length === 1 && continued[0].action === 'login' && continued[0].name === name, continued);
                await sleep(2500);
                // (off Tutorial Island, to Lumbridge: there the chat button first folds the tutorial's instructions away)
                await evaluate(`LostCityHost.keyboard.insertText('::tele 0,50,50,22,18\\n')`);
                await sleep(2500);
                const hudBefore = await evaluate(`(({ chatModal, mainModal, sideModal, tutorialChat, tutorialMessage, chatInput }) => ({ chatModal, mainModal, sideModal, tutorialChat, tutorialMessage, chatInput, tutComId: window.__client.tutComId, staff: window.__client.staffmodlevel }))(window.__client.hudState())`);
                hudBefore.pos = (await state()).pos;
                let chatOpen = { ok: false };
                for (let i = 0; i < 3 && !chatOpen.ok; i++) {
                    await tapSel('#btn-chat-toggle');
                    chatOpen = await waitFor(`!document.getElementById('hud-chat-modes').hidden`, 1500);
                }
                const report = await evaluate(`({ open: !document.getElementById('hud-chat-box').hidden, modesShown: !document.getElementById('hud-chat-modes').hidden, shown: !document.getElementById('btn-report').hidden, modes: [...document.querySelectorAll('#hud-chat-modes .chat-mode')].filter(b => !b.hidden).map(b => b.getAttribute('aria-label')) })`);
                report.hud = hudBefore;
                report.chatOpen = chatOpen.ok;
                await shot('stock-4-report-abuse');
                let reported = { ok: false };
                if (report.shown && (await visible('#btn-report'))) {
                    await tapSel('#btn-report');
                    reported = await waitFor(`window.__client.mainModalId !== -1 && window.__client.mainModalId === window.__client.reportAbuseComId && window.lcHost.keyboard.context?.kind === 'report'`, 4000);
                    await shot('stock-5-report-screen');
                    await evaluate('LostCityHost.keyboard.cancel()');
                    await sleep(400);
                }
                const reportClosed = await evaluate(`window.__client.mainModalId === -1`);
                check('Report abuse online: in the chat bar beside the filters; a tap opens the report screen with the keyboard\'s "report" kind; Cancel closes it', report.shown && report.modes.join() === 'Public chat,Private chat,Trade/duel,Report abuse' && reported.ok && reportClosed, report);
                await tapSel('#btn-chat-toggle');

                // ---------------------------------------------------------------- a dropped connection
                const before = (await state()).pos;
                const dropFrom = app.state.log.length;
                const acctFrom = app.state.posted.length;
                app.dropGameSockets();
                const lost = await waitFor(`window.__client.reconnecting === true || window.__client.ingame === false`, 20000, 50);
                const reconnected = await waitFor(`window.__client.ingame === true && !window.__client.reconnecting`, 30000);
                await sleep(2000);
                const after = await state();
                const dropLog = logSince(dropFrom);
                check('a dropped connection (native: error network, close 1006): the client logs in again (opcode 18) and is back in the same session, same tile', lost.ok && reconnected.ok && JSON.stringify(after.pos) === JSON.stringify(before) && dropLog.some(l => / \(game\) .*failed: network/.test(l)) && dropLog.some(l => / \(game\) open to /.test(l)), { before, after: after.pos, log: dropLog });
                check('...a reconnect is not a new login: no account message, no unreachable box', posted(acctFrom).every(m => m.type !== 'account') && !(await visible('#unreachable')));

                // ---------------------------------------------------------------- switching: online -> offline in game, back
                const switchFrom = app.state.log.length;
                await tapSel('#btn-settings');
                await evaluate(`document.getElementById('nav-world').click()`);
                await sleep(200);
                await tapSel('#world-change');
                await shot('stock-6-worlds-in-game');
                const rows = await evaluate(`[...document.querySelectorAll('#worlds-list .world-row')].map(r => r.querySelector('.character-name').textContent + ' | ' + r.querySelector('.character-when').textContent)`);
                await tapSel('#worlds-list .world-row:nth-child(1) .title-btn');
                const offline = await waitFor(`window.LostCityHost?.engineState === 'ready' && !!window.__client?.titleFlames && document.getElementById('loading').hidden`, 90000);
                const switchLog = logSince(switchFrom);
                const offState = await evaluate(`({ caption: window.__e2eCaption, server: LostCityHost.settings.server, world: document.getElementById('world-name').textContent })`);
                const engineLoaded = requests.some(([n, r]) => n === pageLoads && r === 'GET /engine/boot.js');
                check('worlds in game: This phone, then the server marked "Playing now"', rows[0]?.startsWith('This phone') && /^Test server \| Playing now/.test(rows[1] ?? ''), rows);
                check('online -> offline in game: logged out through the game (the server closed the socket, not the page), then `server use offline`, the page reloaded with the engine (caption offline)', offline.ok && switchLog.some(l => / \(game\) closed: 10\d\d/.test(l)) && !switchLog.some(l => /closed by the page/.test(l)) && switchLog.some(l => /^server use offline: reload$/.test(l)) && offState.caption === '2004Scape · November 2004 · offline' && offState.server === 'offline' && offState.world === 'This phone' && engineLoaded, { switchLog, offState, engineLoaded });
                await shot('stock-7-offline-title');
                const backFrom = app.state.log.length;
                await tapSel('#btn-world');
                await tapSel('#worlds-list .world-row:nth-child(2) .title-btn');
                const online = await waitFor(`window.LostCityHost?.engineState === 'remote' && !!window.__client?.titleFlames && document.getElementById('loading').hidden`, 60000);
                await sleep(500);
                const onState = await evaluate(`({ caption: window.__e2eCaption, continueAs: document.getElementById('continue-name').textContent })`);
                check('offline -> online from the title: the world saved first (as Restart), `server use`, the page online again with "Continue as" the name', online.ok && logSince(backFrom).includes(`server use ${SID}: reload`) && onState.caption === '2004Scape · November 2004 · online' && onState.continueAs === name, onState);

                // ---------------------------------------------------------------- Accounts
                await tapSel('#btn-accounts');
                const accountsShown = await evaluate(`[...document.querySelectorAll('#accounts-list .data-row')].map(r => ({ name: r.querySelector('.data-name').textContent, key: !!r.querySelector('.key-mark'), buttons: [...r.querySelectorAll('button')].map(b => b.textContent) }))`);
                await shot('stock-8-accounts');
                const forgetFrom = app.state.posted.length;
                await evaluate(`[...document.querySelectorAll('#accounts-list .data-row button')].find(b => b.textContent === 'Forget password').click()`);
                await waitFor(`!document.querySelector('#accounts-list .key-mark')`, 4000);
                const forgot = posted(forgetFrom).filter(m => m.type === 'account');
                check('Accounts: the name with a key mark (a password kept), Log in / Forget password / Remove; Forget password: native forgets it and says so (no key mark)', accountsShown.length === 1 && accountsShown[0].key && accountsShown[0].buttons.join() === 'Log in,Forget password,Remove' && forgot.length === 1 && forgot[0].action === 'forget-password' && !app.state.passwords.has(`${SID}/${name}`), { accountsShown, forgot });
                await tapSel('#accounts-close');
                const noKeyFrom = app.state.posted.length;
                await tapSel('#btn-continue');
                const askPassword = await waitFor(`window.__client.loginscreen === 2 && window.__client.loginSelect === 1 && window.lcHost.keyboard.context?.kind === 'login-pass'`, 5000);
                const asked = await state();
                await evaluate('LostCityHost.keyboard.remember(false)');
                await evaluate(`LostCityHost.keyboard.insertText('secret1')`);
                await typed('loginPass', 'secret1');
                await evaluate('LostCityHost.keyboard.submit()');
                const inAgain = await inGame();
                await sleep(800);
                check('"Continue as" with no password kept: the name filled in, the password field and keyboard open (Remember as last time on this server); a login with Remember off keeps nothing', askPassword.ok && asked.user === name && asked.remember === true && inAgain.ok && posted(noKeyFrom).filter(m => m.type === 'account').map(m => m.action).join() === 'login', { asked, accountMsgs: posted(noKeyFrom).filter(m => m.type === 'account') });
                await logout();
                await sleep(500);
                await tapSel('#btn-accounts');
                await evaluate(`[...document.querySelectorAll('#accounts-list .data-row button')].find(b => b.textContent === 'Remove').click()`);
                await sleep(400);
                const removed = await evaluate(`({ sheet: document.getElementById('accounts').hidden, continueAs: document.getElementById('btn-continue').hidden, hint: !document.getElementById('title-hint').hidden })`);
                check('Accounts › Remove: the name goes from this phone (settings.accounts), the title shows the hint again', removed.sheet && removed.continueAs && removed.hint && (app.state.settings.accounts?.[SID] ?? []).length === 0, removed);

                // ---------------------------------------------------------------- the worlds: Add, Edit, Delete
                await tapSel('#btn-world');
                const probeState = () => evaluate(`({ shown: !document.getElementById('worlds-probe').hidden, address: document.getElementById('probe-address').textContent, status: document.getElementById('probe-status').textContent, notes: document.getElementById('probe-notes').textContent, use: !document.getElementById('probe-use').disabled, save: !document.getElementById('probe-save').disabled })`);
                // (the probe shown for this address and done: native's box answers a moment after the tap)
                const settled = address => waitFor(`!document.getElementById('worlds-probe').hidden && document.getElementById('probe-address').textContent === ${JSON.stringify(address)} && document.getElementById('probe-status').textContent !== 'Checking…'`, 15000);
                app.state.answers.push({ address: 'my host!', name: '' });
                await evaluate(`document.querySelector('#worlds-list .add-server').click()`);
                await settled('my host!');
                const bad = await probeState();
                await shot('stock-9-not-an-address');
                check('Add server: native\'s box asked ({type:\'server\', action:\'ask\'}); an address that is not one is said so, Use and Save off', bad.shown && /^That is not an address/.test(bad.status) && !bad.use && !bad.save && posted().some(m => m.type === 'server' && m.action === 'ask' && m.title === 'Add a server'), bad);
                await tapSel('#probe-cancel');
                app.state.answers.push({ address: `ws://127.0.0.1:${new URL(variant.url).port}/`, name: 'Second' });
                await evaluate(`document.querySelector('#worlds-list .add-server').click()`);
                await settled(`127.0.0.1:${new URL(variant.url).port}`);
                const good = await probeState();
                await shot('stock-10-probe-ready');
                check('Add server: the address normalized and checked by the probe: "Ready: a members world, world 1."; Use and Save on', good.address === `127.0.0.1:${new URL(variant.url).port}` && good.status === 'Ready: a members world, world 1.' && good.use && good.save, good);
                await tapSel('#probe-save');
                const added = await evaluate(`[...document.querySelectorAll('#worlds-list .world-row .character-name')].map(n => n.textContent)`);
                const second = (app.state.settings.servers ?? []).find(s => s.name === 'Second');
                check('...Save: listed (This phone (offline), Test server, Second), stored with the probe\'s world, members and key', added.join() === 'This phone (offline),Test server,Second' && second?.url === variant.url.replace(/\/$/, '') && second.nodeId === 10 && second.members === true && !!second.rsa && /^s-[0-9a-z]{8}$/.test(second.id), { added, second });
                app.state.answers.push({ address: `127.0.0.1:${new URL(variant.url).port}`, name: 'Renamed' });
                await evaluate(`[...document.querySelectorAll('#worlds-list .world-row')].find(r => r.querySelector('.character-name').textContent === 'Second').querySelector('.data-btn.plain').click()`);
                await waitFor(`document.getElementById('worlds-title').textContent === 'Edit Second'`, 5000);
                await settled(`127.0.0.1:${new URL(variant.url).port}`);
                await tapSel('#probe-save');
                const renamed = (app.state.settings.servers ?? []).find(s => s.id === second?.id);
                check('Edit: the box prefilled (address, name), checked again, saved under the same id', renamed?.name === 'Renamed' && posted().some(m => m.type === 'server' && m.action === 'ask' && m.title === 'Edit Second' && m.name === 'Second' && m.address === `127.0.0.1:${new URL(variant.url).port}`), renamed);
                // the same entry given another address while a password is kept for it (native's savedPasswords at the next
                // load): the page asks whether it is the same server before "Continue as" could send the password there
                app.state.passwords.set(`${second?.id}/bob`, 'kept1');
                await open('stock-moved');
                await waitFor(`!document.getElementById('btn-world').hidden && !document.getElementById('title-actions').hidden`, 5000);
                await sleep(300);
                await tapSel('#btn-world');
                app.state.answers.push({ address: '127.0.0.1:47629', name: 'Renamed' });
                await evaluate(`[...document.querySelectorAll('#worlds-list .world-row')].find(r => r.querySelector('.character-name').textContent === 'Renamed').querySelector('.data-btn.plain').click()`);
                await settled('127.0.0.1:47629');
                const movedFrom = app.state.posted.length;
                await tapSel('#probe-save');
                const sameAsked = await waitFor(`!document.getElementById('confirm').hidden`, 3000);
                const sameBox = await evaluate(`({ title: document.getElementById('confirm-title').textContent, text: document.getElementById('confirm-text').textContent, ok: document.getElementById('confirm-ok').textContent, cancel: document.getElementById('confirm-cancel').textContent })`);
                await shot('stock-11a-same-server');
                await tapSel('#confirm-ok');
                await sleep(600);
                const moved = (app.state.settings.servers ?? []).find(s => s.id === second?.id);
                const movedForgot = posted(movedFrom).filter(m => m.type === 'account');
                check('Edit to another address with a password kept: "The same server?" asked first (Forget / Same server); Forget: native forgets it, the entry keeps its id at the new address', sameAsked.ok && sameBox.title === 'The same server?' && sameBox.ok === 'Forget' && sameBox.cancel === 'Same server' && movedForgot.length === 1 && movedForgot[0].action === 'forget-password' && movedForgot[0].server === second?.id && movedForgot[0].name === 'bob' && !app.state.passwords.has(`${second?.id}/bob`) && moved?.url === 'http://127.0.0.1:47629' && moved.name === 'Renamed', { sameBox, movedForgot, moved });
                app.state.answers.push({ address: '127.0.0.1:47629', name: 'Nowhere' });
                await evaluate(`document.querySelector('#worlds-list .add-server').click()`);
                await settled('127.0.0.1:47629');
                const down = await probeState();
                await shot('stock-11-probe-failed');
                check('Add server: a server that cannot be reached: "Not ready: it cannot be reached…", Save on (for later), Use off', /^Not ready: it cannot be reached/.test(down.status) && down.save && !down.use, down);
                await tapSel('#probe-cancel');
                const deleteFrom = app.state.posted.length;
                await evaluate(`[...document.querySelectorAll('#worlds-list .world-row')].find(r => r.querySelector('.character-name').textContent === 'Renamed').querySelector('.data-btn:not(.plain)').click()`);
                await sleep(300);
                const confirmTitle = await evaluate(`!document.getElementById('confirm').hidden && document.getElementById('confirm-title').textContent`);
                await shot('stock-12-delete-confirm');
                await tapSel('#confirm-ok');
                await sleep(300);
                const afterDelete = await evaluate(`[...document.querySelectorAll('#worlds-list .world-row .character-name')].map(n => n.textContent)`);
                const deleted = posted(deleteFrom).filter(m => m.type === 'server');
                const current = await evaluate(`[...document.querySelectorAll('#worlds-list .world-row')].find(r => r.querySelector('.character-name').textContent === 'Test server').querySelectorAll('button').length`);
                check('Delete: "Delete Renamed?" asked first; gone from the list and the settings; native told (server delete); the server in use has no Delete', confirmTitle === 'Delete Renamed?' && afterDelete.join() === 'This phone (offline),Test server' && deleted.length === 1 && deleted[0].action === 'delete' && deleted[0].id === second?.id && current === 2, { confirmTitle, afterDelete, deleted, current });
                await tapSel('#worlds-close');
                const errors = noErrors(consoleFrom);
                check('stock: no console errors', errors.length === 0, errors.slice(0, 5));
            }

            if (group === 'down') {
                // a server nothing answers on (a port no one listens to): native's /crc 502 "unreachable" at boot
                setSettings({ server: SID, servers: [entry('http://127.0.0.1:47629', { name: 'Nowhere' })] });
                const t = Date.now();
                await page.navigate(server.url);
                const box = await waitFor(`!document.getElementById('unreachable').hidden`, 15000, 50);
                const boxMs = Date.now() - t;
                const text = await evaluate(`({ title: document.getElementById('unreachable-title').textContent, text: document.getElementById('unreachable-text').textContent, loader: document.getElementById('loading').hidden || document.getElementById('loading').classList.contains('fade') })`);
                await shot('down-1-box');
                check('down: the box within seconds (not 45 s under the loader): "Could not connect to Nowhere", "127.0.0.1:47629: it cannot be reached…"', box.ok && boxMs < 8000 && text.title === 'Could not connect to Nowhere' && /^127\.0\.0\.1:47629: it cannot be reached/.test(text.text) && text.loader, { boxMs, ...text });
                await tapSel('#unreachable-choose');
                const chooser = await visible('#worlds');
                await tapSel('#worlds-close');
                const again = await visible('#unreachable');
                check('down: Choose world opens the worlds; closing them shows the box again', chooser && again);
                // the server moved (a new address on the network): Choose world, Edit it, the address that works, Use: the
                // page loads again on it (native's `server use` for the server in use), the box gone
                const working = engine?.url ?? SERVER ?? (ENGINE ? (await startVariant('stock')).url : null); // (--only down: the stock engine)
                if (working) {
                    const address = working.replace(/^http:\/\//, '').replace(/\/$/, '');
                    const editFrom = app.state.log.length;
                    const loadsBefore = pageLoads;
                    await tapSel('#unreachable-choose');
                    app.state.answers.push({ address, name: 'Nowhere' });
                    await evaluate(`[...document.querySelectorAll('#worlds-list .world-row')].find(r => r.querySelector('.character-name').textContent === 'Nowhere').querySelector('.data-btn.plain').click()`);
                    const ready = await waitFor(`document.getElementById('probe-status').textContent.startsWith('Ready') && !document.getElementById('probe-use').disabled`, 15000);
                    await tapSel('#probe-use');
                    const reloaded = await waitFor(`!!window.__client?.titleFlames && document.getElementById('loading').hidden && LostCityHost.engineState === 'remote'`, 60000);
                    await sleep(500);
                    const after = await evaluate(`({ box: !document.getElementById('unreachable').hidden, url: lcHost.server?.url, world: document.getElementById('world-name').textContent })`);
                    check('down: the server in use edited to an address that works, then Use: `server use` for it, the page loads again there (no box)', ready.ok && reloaded.ok && pageLoads === loadsBefore + 1 && logSince(editFrom).includes(`server use ${SID}: reload`) && !after.box && after.url === working.replace(/\/$/, '') && after.world === 'Nowhere', { after, pageLoads: pageLoads - loadsBefore, log: logSince(editFrom).filter(l => !l.startsWith('socket')) });
                    setSettings({ server: SID, servers: [entry('http://127.0.0.1:47629', { name: 'Nowhere' })] });
                    await page.navigate(server.url);
                    await waitFor(`!document.getElementById('unreachable').hidden`, 15000, 50);
                }
                await tapSel('#unreachable-offline');
                const offline = await waitFor(`window.LostCityHost?.engineState === 'ready' && !!window.__client?.titleFlames`, 90000);
                check('down: Play offline: the world on this phone (`server use offline`, the engine on the page)', offline.ok && app.state.settings.server === 'offline' && (await evaluate('window.__e2eCaption')) === '2004Scape · November 2004 · offline');
            }

            if (group === 'login') {
                await useServer(variant.url);
                await open('login');
                const name = `pw${Date.now() % 100000}`;
                const first = await login(name, 'right1', { newUser: true });
                check('login server: the first login registers the account (any password: registration is off on the website)', first.ingame === true, { mes: [first.mes1, first.mes2] });
                await inGame();
                await logout();
                await open('login-2');
                const wrong = await login(name, 'wrong1');
                await shot('login-1-wrong-password');
                check('login server: a wrong password: response 3, "Invalid username or password." in the form and in the keyboard bar\'s line', wrong.ingame === false && wrong.mes2 === 'Invalid username or password.', { mes: [wrong.mes1, wrong.mes2], prompt: wrong.prompt });
                await open('login-3');
                const rightFrom = app.state.posted.length;
                const right = await login(name, 'right1', { remember: true });
                await inGame();
                await sleep(800);
                check('login server: the right password logs in, kept with Remember', right.ingame === true && posted(rightFrom).some(m => m.type === 'account' && m.action === 'save-password') && app.state.passwords.get(`${SID}/${name}`) === 'right1', { mes: [right.mes1, right.mes2] });

                // the password changed on the server (here: the one kept on the phone is the old one): "Continue as" is refused,
                // the new one typed on the same form logs in and is kept in place of the old
                await logout();
                await sleep(800);
                app.state.passwords.set(`${SID}/${name}`, 'stale1');
                const staleFrom = app.state.posted.length;
                await tapSel('#btn-continue');
                const refused = await waitFor(`window.__client.loginMes2 === 'Invalid username or password.'`, 30000);
                await shot('login-2-kept-password-refused');
                await tapGame(382, 276); // (the password field)
                const field = await waitFor(`window.__client.loginSelect === 1 && window.lcHost.keyboard.context?.kind === 'login-pass'`, 4000);
                for (let i = 0; i < 'stale1'.length; i++) {
                    await evaluate('LostCityHost.keyboard.deleteBackward()');
                }
                await typed('loginPass', '');
                await evaluate(`LostCityHost.keyboard.insertText('right1')`);
                await typed('loginPass', 'right1');
                await evaluate('LostCityHost.keyboard.submit()');
                const retyped = await inGame();
                await sleep(800);
                const staleMsgs = posted(staleFrom).filter(m => m.type === 'account').map(m => m.action);
                check('a kept password the server refuses: "Continue as" gets 3; the new password typed on that form logs in and is kept in its place (save-password)', refused.ok && field.ok && retyped.ok && staleMsgs.join() === 'login,save-password' && app.state.passwords.get(`${SID}/${name}`) === 'right1', { staleMsgs, field: field.ok });
                await logout();
                await sleep(800);
                const againFrom = app.state.posted.length;
                await tapSel('#btn-continue');
                const continued = await inGame();
                check('...and "Continue as" logs in with it at once', continued.ok && posted(againFrom).filter(m => m.type === 'account').map(m => m.action).join() === 'login', posted(againFrom).filter(m => m.type === 'account'));
            }

            if (group === 'key') {
                const probe = await useServer(variant.url);
                await open('key');
                const name = `key${Date.now() % 100000}`;
                const wrong = await login(name, 'secret1', { newUser: true });
                await shot('key-1-wrong-key');
                check('a server with its own key, the entry with the key its client.js carries (the repo\'s): response 6, worded for a server: "This server runs a different / game version or key."', wrong.ingame === false && wrong.mes1 === 'This server runs a different' && wrong.mes2 === 'game version or key.' && probe.rsa?.n !== variant.key.n, { mes: [wrong.mes1, wrong.mes2] });
                setSettings({ servers: [entry(variant.url.replace(/\/$/, ''), { rsa: variant.key })] });
                await open('key-2');
                const right = await login(name, 'secret1', { newUser: true });
                check('...the entry with the server\'s own key (lcHost.server.rsa, client patch 0030): the login succeeds', right.ingame === true, { mes: [right.mes1, right.mes2] });
            }

            if (group === 'full') {
                await useServer(variant.url);
                await open('full');
                const full = await login(`full${Date.now() % 100000}`, 'secret1', { newUser: true });
                await shot('full-1');
                check('a full world (maxConnected -1): response 7, "This world is full."', full.ingame === false && full.mes1 === 'This world is full.', { mes: [full.mes1, full.mes2] });
            }

            if (group === 'origin') {
                await useServer(variant.url);
                const boot = await open('origin');
                const from = app.state.log.length;
                const t = Date.now();
                const refused = await login(`org${Date.now() % 100000}`, 'secret1', { newUser: true });
                const box = await waitFor(`!document.getElementById('unreachable').hidden`, 10000, 50);
                const text = await evaluate(`document.getElementById('unreachable-text').textContent`);
                await shot('origin-1-refused');
                check('a server that allows one Origin (the app sends none): the title loads (/crc has no Origin check), the game socket\'s upgrade is refused (http 4xx): "Error connecting to server." and the box with the HTTP status', boot.up.ok && refused.mes2 === 'Error connecting to server.' && box.ok && /it refused the game's connection \(HTTP 4\d\d\)\.$/.test(text) && logSince(from).some(l => /failed: http 4\d\d$/.test(l)), { ms: Date.now() - t, text, log: logSince(from) });
            }

            if (group === 'silent') {
                const silent = await silentServer({ port: SILENT_PORT, upstream: variant.url });
                try {
                    await useServer(silent.url);
                    await open('silent');
                    const from = app.state.log.length;
                    const t = Date.now();
                    await login(`sil${Date.now() % 100000}`, 'secret1', { newUser: true });
                    await waitFor(`window.__client.loginMes2 !== 'Connecting to server...'`, 20000);
                    const ms = Date.now() - t;
                    const quiet = await state();
                    const box = await waitFor(`!document.getElementById('unreachable').hidden`, 5000, 50);
                    const text = await evaluate(`document.getElementById('unreachable-text').textContent`);
                    const cycle = await evaluate('window.__client.constructor.loopCycle');
                    await sleep(1000);
                    const running = (await evaluate('window.__client.constructor.loopCycle')) > cycle;
                    await shot('silent-1-no-answer');
                    check('a server that takes the game\'s connection and never answers: after the client\'s 30 s read timeout "Error connecting to server.", the client still running (patch 0031), the box "it did not answer in time."', silent.upgrades >= 1 && quiet.mes2 === 'Error connecting to server.' && ms > 29000 && running && box.ok && /: it did not answer in time\.$/.test(text) && logSince(from).some(l => /\(game\) open to /.test(l)), { ms, mes: [quiet.mes1, quiet.mes2], running, text, upgrades: silent.upgrades });
                    await tapSel('#unreachable-choose');
                    const sheet = await visible('#worlds');
                    await tapSel('#worlds-close');
                    check('...and the page still answers: Choose world opens the worlds', sheet);
                } finally {
                    await silent.close();
                }
            }

            if (group === 'production') {
                await useServer(variant.url);
                await open('production');
                const prod = await login(`prod${Date.now() % 100000}`, 'secret1', { newUser: true });
                await inGame();
                await evaluate('LostCityHost.keyboard.show()');
                await sleep(300);
                const chat = await evaluate(`({ staff: window.__client.staffmodlevel, kind: window.lcHost.keyboard.context?.kind, chips: (window.lcHost.keyboard.context?.chips ?? []).length })`);
                await evaluate('LostCityHost.keyboard.dismissed()');
                check('a production server: a normal player (staff 0 from the server), no "::" chips on the chat keyboard', prod.ingame === true && chat.staff === 0 && chat.kind === 'chat' && chat.chips === 0, chat);
            }

            if (group === 'drift') {
                const drift = prepareDrift({ dir: `${ENGINE}-drift`, from: ENGINE, nodeBin: NODE_BIN });
                const pack = readPack(path.join(drift.engine, 'data', 'pack'));
                await useServer(variant.url, { id: SID });
                fs.rmSync(path.join(OUT, 'app-cache', 'online', SID), { recursive: true, force: true });
                const boot = await open('drift', () => titleUp(90000));
                const bootLog = logSince(boot.from);
                const fetched = bootLog.filter(l => / from the server: /.test(l));
                // (Android: the bytes came in X-LC-Body, as the app's router takes them)
                const stored = (log, archive, file, bytes) => log.includes(`/ondemand/${archive}/${file} stored (${bytes} bytes${ANDROID ? ', X-LC-Body' : ''})`);
                const animsStored = drift.anims.filter(f => stored(bootLog, 1, f, readFile(pack, 2, f).length));
                check('drift: the server\'s versionlist (its own CRC) downloaded through the proxy, checked and cached; the other 7 jags the bundled ones', boot.up.ok && fetched.length === 1 && /^\/versionlist-?\d+ from the server: \d+ bytes, cached$/.test(fetched[0]), fetched);
                check('drift: at the title the 3 animations of another version came over the OnDemand socket and went to the app\'s cache (the server\'s bytes)', bootLog.some(l => / \(ondemand\) open to /.test(l)) && animsStored.length === 3, { animsStored, log: bootLog.filter(l => /ondemand/.test(l)).slice(0, 8) });
                const idle = await waitFor(`(r => !!r && r.queue.length === 0 && r.pending.length === 0 && r.timer === null)(window.__client.onDemand?.remote)`, 5000);
                check('drift: with nothing left to fetch on the title, the OnDemand timer stops (no 20 ms cycle on the page\'s thread)', idle.ok, await evaluate(`(r => r && { queue: r.queue.length, pending: r.pending.length, timer: r.timer !== null, stream: !!r.stream })(window.__client.onDemand?.remote)`));
                const from = app.state.log.length;
                const name = `drift${Date.now() % 100000}`;
                const played = await login(name, 'secret1', { newUser: true });
                const scene = await waitFor(`window.__client.sceneState === 2`, 30000);
                await sleep(2000);
                await shot('drift-1-ingame');
                const gameLog = logSince(from);
                const mapStored = stored(gameLog, 3, drift.map, readFile(pack, 4, drift.map).length);
                const models = gameLog.filter(l => /^\/ondemand\/0\/\d+ stored \(\d+ bytes(, X-LC-Body)?\)$/.test(l) && /X-LC-Body/.test(l) === ANDROID);
                const mapFile = path.join(OUT, 'app-cache', 'online', SID, 'od', '3', String(drift.map));
                const same = fs.existsSync(mapFile) && fs.readFileSync(mapFile).equals(Buffer.from(readFile(pack, 4, drift.map)));
                check('drift: in game the character\'s own models (player kits of another version) and the land of square 48_48 came from the server, the scene built', played.ingame === true && scene.ok && mapStored && models.length > 0 && same, { mapStored, models: models.length, same });
                const puts = app.state.log.filter(l => /^\/ondemand\/.* stored/.test(l));
                check(ANDROID ? 'drift (Android): every file stored with its bytes in X-LC-Body, no body (the app\'s router never sees one)' : 'drift: every file stored with its bytes in the body', puts.length > 0 && puts.every(l => /X-LC-Body/.test(l) === ANDROID), { stored: puts.length, android: ANDROID });
                await logout();
                const again = await open('drift-2', () => titleUp(90000));
                const againLog = logSince(again.from);
                check('drift: the next session takes the animations from the app\'s cache: no OnDemand socket at the title, nothing downloaded', again.up.ok && !againLog.some(l => /\(ondemand\) open/.test(l)) && !againLog.some(l => / from the server/.test(l)), againLog.filter(l => !l.startsWith('socket')).slice(0, 6));
                const from2 = app.state.log.length;
                const second = await login(name, 'secret1');
                await waitFor(`window.__client.sceneState === 2`, 30000);
                await sleep(1500);
                check('drift: ...and in game its models and map from the app\'s cache too: no OnDemand socket', second.ingame === true && !logSince(from2).some(l => /\(ondemand\) open/.test(l)), logSince(from2).filter(l => /ondemand/.test(l)));
            }
        }
        const errors = noErrors(0, line => /net::ERR_|Failed to load resource/.test(line));
        check('no console errors or exceptions', errors.length === 0, errors.slice(0, 6));
        exitCode = checks.every(c => c.ok) ? 0 : 1;
    } catch (err) {
        console.error(err);
        check('harness completed', false, String(err?.stack ?? err).slice(0, 800));
        await shot('harness-error');
    } finally {
        fs.writeFileSync(path.join(OUT, 'console.log'), page.consoleLines.join('\n'));
        fs.writeFileSync(path.join(OUT, 'app.log'), app.state.log.join('\n'));
        fs.writeFileSync(path.join(OUT, 'posted.json'), JSON.stringify(app.state.posted, null, 1));
        fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ groups, checks }, null, 2));
        if (engine) {
            fs.writeFileSync(path.join(OUT, 'engine.log'), engine.lines.join('\n'));
        }
        console.log(`\n${checks.filter(c => c.ok).length}/${checks.length} checks passed — logs in ${path.relative(process.cwd(), OUT)}`);
        if (!KEEP) {
            await page.close();
            await server.close();
            await engine?.stop();
        }
    }
    return exitCode;
}
