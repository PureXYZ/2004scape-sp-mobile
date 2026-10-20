#!/usr/bin/env node
// End-to-end harness for the patched client: builds it into a temp Game dir, serves that dir with the stub host
// page (test/stub: lcHost + fake WebSocket + engine worker), and drives headless Chrome over CDP with iPhone 13 mini
// landscape emulation (812x375 CSS px, DPR 3, touch). Real touch events go through Input.dispatchTouchEvent.
//
//   node web/client/test/run.mjs [--debug] [--quick] [--no-engine] [--engine-bundle <dir>] [--engine-layout auto|old|new]
//     --debug        test the debug build (default: release, which is what ships)
//     --quick        simulate the 90 s idle period by back-dating idleTimer instead of really waiting
//     --no-engine    title screen + login-screen tests only (canned "invalid login" socket, no engine bundle needed)
// Results, screenshots and logs: build/tmp/client/test-results-<release|debug>-<newengine|oldengine|noengine>-<full|quick>/
// (results.json, *.png, console.log, requests.log, stub-log.json).
import fs from 'node:fs';
import path from 'node:path';

import { buildClient } from '../build.mjs';
import { TMP_DIR } from '../lib/tree.mjs';
import { launchChrome, openPage } from './cdp.mjs';
import { DEFAULT_ENGINE_BUNDLE_DIR, startServer } from './serve.mjs';

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const DEBUG = flag('--debug');
const QUICK = flag('--quick');
const ENGINE = !flag('--no-engine');
// Engine worker build to test against: --engine-bundle, else the orchestrator's Game/engine once it exists, else the
// engine-compat bundle from the investigation. Layout 'new' = ARCHITECTURE.md §2 (engine/boot.js), 'old' = engine-compat
// (engine/engine-boot.js + bundle picked by the worker name); both speak init/booted/start/ready/connect/data/close.
const GAME_ENGINE_DIR = path.join(TMP_DIR, '..', '..', 'Game', 'engine');
const ENGINE_BUNDLE = path.resolve(opt('--engine-bundle', fs.existsSync(path.join(GAME_ENGINE_DIR, 'boot.js')) ? GAME_ENGINE_DIR : DEFAULT_ENGINE_BUNDLE_DIR));
const layoutOpt = opt('--engine-layout', 'auto');
const ENGINE_LAYOUT = layoutOpt !== 'auto' ? layoutOpt : fs.existsSync(path.join(ENGINE_BUNDLE, 'boot.js')) ? 'new' : 'old';
const OUT = path.join(TMP_DIR, `test-results-${DEBUG ? 'debug' : 'release'}-${ENGINE ? `${ENGINE_LAYOUT}engine` : 'noengine'}-${QUICK ? 'quick' : 'full'}`);
const HTTP_PORT = 47400;
const CDP_PORT = 47401;
const GAME = path.join(TMP_DIR, 'test-game');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = '') {
    results.push({ name, pass: !!pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
    return !!pass;
}
function skip(name, why) {
    results.push({ name, pass: null, detail: `skipped: ${why}` });
    console.log(`SKIP  ${name}  -- ${why}`);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
if (ENGINE && !fs.existsSync(path.join(ENGINE_BUNDLE, ENGINE_LAYOUT === 'new' ? 'boot.js' : 'engine-boot.js'))) {
    console.error(`no engine bundle at ${ENGINE_BUNDLE} (pass --engine-bundle <dir> or --no-engine)`);
    process.exit(2);
}

console.log(`building the ${DEBUG ? 'debug' : 'release'} client into ${GAME}`);
fs.rmSync(GAME, { recursive: true, force: true });
fs.mkdirSync(GAME, { recursive: true });
const build = await buildClient({ out: GAME, debug: DEBUG });

const server = await startServer({ port: HTTP_PORT, gameDir: GAME, engineBundleDir: ENGINE_BUNDLE });
const cdp = await launchChrome({ port: CDP_PORT, profileDir: path.join(TMP_DIR, 'chrome-profile') });
let page;
const timeline = {};

try {
    page = await openPage(cdp, {
        // iPhone 13 mini, landscape (WKWebView viewport measured in the simulator: 812x375 pt @3x)
        metrics: { width: 812, height: 375, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } },
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
    });
    const { evaluate, touch } = page;
    const shot = name => page.screenshot(path.join(OUT, name));
    const waitFor = async (expr, ms, label) => {
        const end = Date.now() + ms;
        for (;;) {
            let v;
            try {
                v = await evaluate(expr);
            } catch {
                v = undefined;
            }
            if (v) {
                return v;
            }
            if (Date.now() > end) {
                throw new Error(`timeout (${ms} ms) waiting for ${label ?? expr}`);
            }
            await sleep(50);
        }
    };
    const logLen = () => evaluate('__lcTest.log.length');
    const logSince = (i, type) => evaluate(`__lcTest.log.slice(${i})${type ? `.filter(e => e.type === ${JSON.stringify(type)})` : ''}`);
    const c = expr => evaluate(`(() => { const c = window.__client; return ${expr}; })()`);

    const t0 = Date.now();
    await page.navigate(`${server.url}/?mode=${ENGINE ? 'engine' : 'stub'}&engineLayout=${ENGINE_LAYOUT}`);

    // ---------------------------------------------------------------------------------------------------
    // 1. Title screen with LocalOnDemand: no IndexedDB, no ondemandworker, no second socket
    await waitFor('window.__client && (window.__client.mouseTrackingInterval || window.__client.errorLoading)', 90000, 'client maininit');
    timeline.titleMs = Date.now() - t0;
    await sleep(500);
    const rect = await evaluate(`(() => { const r = document.getElementById('canvas').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
    const g2c = (gx, gy) => ({ x: rect.left + ((gx + 0.5) * rect.width) / 765, y: rect.top + ((gy + 0.5) * rect.height) / 503 });
    let nextTouchId = 1;
    const tap = async (gx, gy, hold = 60) => {
        const p = g2c(gx, gy);
        const id = nextTouchId++;
        await touch.start([{ x: p.x, y: p.y, id }]);
        await sleep(hold);
        await touch.end([]);
        await sleep(120); // a few client cycles to consume the click
    };
    const title = await c(`({ errorLoading: c.errorLoading, errorMessage: c.errorMessage, db: c.db, odWorker: c.onDemand && c.onDemand.worker, remaining: c.onDemand && c.onDemand.remaining(), odCycle: c.onDemand && c.onDemand.cycle, flames: !!c.titleFlames, loginscreen: c.loginscreen, mobile: c.isMobile, fullscreen: document.fullscreenElement })`);
    await shot('01-title.png');
    check('title: client finished loading without error', !title.errorLoading, { ms: timeline.titleMs, errorMessage: title.errorMessage });
    check('title: no IndexedDB (client.db === null, indexedDB.open never called)', title.db === null && (await evaluate('__lcTest.idbOpens()')) === 0);
    const workers = await evaluate('__lcTest.workers');
    const odReqs = server.requests.filter(r => /ondemand/i.test(r.path));
    check('title: no OnDemand worker or socket (LocalOnDemand)', title.odWorker === null && !workers.some(w => /ondemand/i.test(w)) && odReqs.length === 0, { workers, odRequests: odReqs.length });
    check('title: all OnDemand requests served from __LC_CACHE__', title.remaining === 0 && title.odCycle > 0, { remaining: title.remaining, cycle: title.odCycle });
    const jagReqs = server.requests.filter(r => /^\/(crc|title|config|interface|media|versionlist|textures|wordenc|sounds)/.test(r.path));
    check('title: /crc + 8 jag archives fetched from the Game dir, all 200', jagReqs.length === 9 && jagReqs.every(r => r.status === 200), jagReqs.map(r => `${r.path}:${r.status}`).join(' '));
    check('title: emulated iPhone is mobile, not fullscreen', title.mobile === true && !title.fullscreen);

    // ---------------------------------------------------------------------------------------------------
    // 2. Multi-touch: a second finger must not click. Finger 1 on "Existing User", finger 2 on "New User".
    let mark = await logLen();
    {
        const a = g2c(462, 291), b = g2c(302, 291);
        await touch.start([{ x: a.x, y: a.y, id: 101 }]);
        await sleep(40);
        await touch.start([{ x: a.x, y: a.y, id: 101 }, { x: b.x, y: b.y, id: 102 }]);
        await sleep(40);
        await touch.end([{ x: a.x, y: a.y, id: 101 }]); // finger 2 lifts first
        await sleep(40);
        await touch.end([]);
        await sleep(200);
    }
    let clicks = await logSince(mark, 'click');
    let ls = await c('c.loginscreen');
    check('multi-touch: exactly one click (first finger), second finger ignored', clicks.length === 1 && clicks[0].x === 462 && ls === 2, { clicks, loginscreen: ls });
    const opened = await logSince(mark, 'kb-show');
    check('keyboard: opening the login form (Existing User) shows it for the username by itself', opened.length === 1 && opened[0].kind === 'login-user', opened.map(k => k.kind));
    const haptics = await logSince(mark, 'haptic');
    check("title: a finger on a title button gets haptic('selection')", haptics.length === 1 && haptics[0].style === 'selection', haptics);
    check('pointerdown focuses the canvas (hardware keyboard)', await evaluate(`document.activeElement === document.getElementById('canvas')`));
    await shot('02-login-screen.png');

    // ---------------------------------------------------------------------------------------------------
    // 3. Login screen keyboard: taps on user/pass, Enter switches field, Login hides it
    const user = `ios${String(Date.now()).slice(-6)}`;
    const pass = 'test1234';
    mark = await logLen();
    await tap(370, 258); // username field
    let kb = await logSince(mark, 'kb-show');
    check('keyboard: tap on the username field -> show (login-user)', kb.length >= 1 && kb.at(-1).kind === 'login-user', kb.map(k => k.kind));
    await evaluate(`__lcTest.insertText(${JSON.stringify(user)})`);
    await sleep(150);
    mark = await logLen();
    await evaluate(`__lcTest.key('Enter')`);
    await sleep(200);
    kb = await logSince(mark, 'kb-show');
    check('keyboard: Enter moves to the password field -> show again (login-pass)', kb.length === 1 && kb[0].kind === 'login-pass', kb.map(k => k.kind));
    mark = await logLen();
    await tap(370, 258); // back to username
    await tap(370, 274); // and to password
    const kbSeq = await logSince(mark);
    const kinds = kbSeq.filter(e => e.type === 'kb-show' || e.type === 'kb-hide').map(e => e.type === 'kb-hide' ? 'hide' : e.kind);
    check('keyboard: tapping user -> pass field re-shows (never hides) with the right kind', JSON.stringify(kinds) === JSON.stringify(['login-user', 'login-pass']), kinds);
    await evaluate(`__lcTest.insertText(${JSON.stringify(pass)})`);
    await sleep(150);
    const creds = await c('({ user: c.loginUser, pass: c.loginPass })');
    check('keyboard: injected keys reach the login fields', creds.user === user && creds.pass === pass, creds);

    if (!ENGINE) {
        mark = await logLen();
        await tap(302, 321); // Login
        await waitFor(`__lcTest.log.some(e => e.type === 'stub-login')`, 10000, 'stub login packet');
        await sleep(500);
        const hides = await logSince(mark, 'kb-hide');
        check('keyboard: tapping Login (outside the fields) hides it', hides.length >= 1);
        check('stub login: RSA login packet sent through the fake WebSocket', true, await c('c.loginMes1 + " / " + c.loginMes2'));
        skip('in-game tests', '--no-engine');
    } else {
        // -----------------------------------------------------------------------------------------------
        // 4. Login through the engine worker: new account on Tutorial Island
        mark = await logLen();
        const tLogin = Date.now();
        await tap(302, 321); // Login
        await waitFor('window.__client.ingame', 30000, 'ingame');
        timeline.loginMs = Date.now() - tLogin;
        await waitFor('window.__client.sceneState === 2', 30000, 'scene built');
        timeline.sceneMs = Date.now() - tLogin;
        await sleep(1500);
        await shot('03-ingame-tutorial.png');
        const after = await logSince(mark);
        check('login: reaches the game through the engine worker', true, { loginMs: timeline.loginMs, sceneMs: timeline.sceneMs });
        check('login: keyboard hidden on the way in', after.some(e => e.type === 'kb-hide'), after.filter(e => e.type.startsWith('kb')).map(e => e.type));
        check("host event: onClientEvent('ingame', true)", after.some(e => e.type === 'event' && e.name === 'ingame' && e.detail === true));
        const pos = await c('({ x: c.localPlayer && c.localPlayer.x, z: c.localPlayer && c.localPlayer.z, mainModalId: c.mainModalId, staff: c.staffmodlevel })');
        check('login: new account on Tutorial Island with the design interface open', pos.mainModalId !== -1, pos);

        // instrumentation: menu actions and client->server opcodes (property names survive minification)
        await evaluate(`(() => {
            const c = window.__client, T = window.__lcTest;
            const doAction = c.doAction;
            c.doAction = function (i) { T.rec('action', { i, option: this.menuOption[i], action: this.menuAction[i] }); return doAction.call(this, i); };
            const proto = Object.getPrototypeOf(c.out);
            const p1Enc = proto.p1Enc;
            T.opcodes = [];
            proto.p1Enc = function (op) { T.opcodes.push({ t: Math.round(performance.now()), op }); if (T.opcodes.length > 5000) T.opcodes.splice(0, 1000); return p1Enc.call(this, op); };
        })()`);

        // 5. Accept the character design (player_kit:accept at 223,266 66x31 in the main area at 4,4)
        await tap(4 + 223 + 33, 4 + 266 + 15);
        await waitFor('window.__client.mainModalId === -1', 10000, 'design interface closed');
        await sleep(1200);
        check('tap: tapping "Accept" closed the design interface', true);

        // 6. Tap = left click (walk)
        mark = await logLen();
        await tap(256, 250);
        await sleep(300);
        clicks = await logSince(mark, 'click');
        let actions = await logSince(mark, 'action');
        check('tap: one left click at the tapped game pixel, default action runs', clicks.length === 1 && clicks[0].button === 1 && clicks[0].x === 256 && clicks[0].y === 250 && actions.length === 1, { clicks, actions: actions.map(a => a.option) });

        // 7. Long-press opens the menu WHILE holding; release does not click
        await sleep(600);
        mark = await logLen();
        {
            const p = g2c(256, 200);
            await touch.start([{ x: p.x, y: p.y, id: nextTouchId++ }]);
            await sleep(750);
            const open = await c('({ open: c.isMenuOpen, area: c.menuArea, n: c.menuNumEntries })');
            await shot('04-longpress-menu-held.png');
            const during = await logSince(mark);
            check('long-press: menu is open BEFORE the finger lifts', open.open === true, open);
            // (the host plays the long-press haptic when it shows the menu, on 'menu-open')
            check('long-press: no client haptic (the host plays it on menu-open)', !during.some(e => e.type === 'haptic'), during.filter(e => e.type === 'haptic'));
            check('long-press: it is a right click (button 2), no left click', during.filter(e => e.type === 'click').map(e => e.button).join() === '2');
            check("host event: 'menu-open' with the options", during.some(e => e.type === 'event' && e.name === 'menu-open' && Array.isArray(e.detail?.options) && e.detail.options.length === open.n), during.filter(e => e.type === 'event').map(e => e.name));
            const pid = during.find(e => e.type === 'event' && e.name === 'menu-open')?.detail?.pointerId;
            check("host event: 'menu-open' names the long-press finger (pointerId) while it is down", Number.isInteger(pid) && pid >= 0, { pointerId: pid });
            await touch.end([]);
            await sleep(250);
        }
        let st = await c('({ open: c.isMenuOpen })');
        clicks = await logSince(mark, 'click');
        actions = await logSince(mark, 'action');
        check('long-press: release keeps the menu open and does not click', st.open === true && clicks.length === 1 && actions.length === 0, { open: st.open, clicks: clicks.map(k => k.button), actions });

        // tap the bottom option ("Cancel") of the open menu
        const menuRow = async (index /* 0 = bottom = Cancel */) => {
            const m = await c('({ area: c.menuArea, x: c.menuX, y: c.menuY, w: c.menuWidth, n: c.menuNumEntries, options: Array.from({ length: c.menuNumEntries }, (_, i) => c.menuOption[i]) })');
            const [ox, oy] = [[4, 4], [553, 205], [17, 357]][m.area];
            return { gx: ox + m.x + (m.w >> 1), gy: oy + m.y + (m.n - 1 - index) * 15 + 31 - 5, m };
        };
        let row = await menuRow(0);
        mark = await logLen();
        await tap(row.gx, row.gy);
        await sleep(200);
        actions = await logSince(mark, 'action');
        st = await c('({ open: c.isMenuOpen })');
        check('menu: tapping an option selects it and closes the menu', actions.length === 1 && /cancel/i.test(actions[0].option) && !st.open, { actions: actions.map(a => a.option) });

        // press-drag-release: long-press, slide onto an option, lift
        await sleep(300);
        mark = await logLen();
        {
            const p = g2c(256, 200);
            const id = nextTouchId++;
            await touch.start([{ x: p.x, y: p.y, id }]);
            await sleep(700);
            row = await menuRow(0);
            const q = g2c(row.gx, row.gy);
            for (let i = 1; i <= 5; i++) {
                await touch.move([{ x: p.x + ((q.x - p.x) * i) / 5, y: p.y + ((q.y - p.y) * i) / 5, id }]);
                await sleep(30);
            }
            await sleep(100);
            await touch.end([]);
            await sleep(250);
        }
        actions = await logSince(mark, 'action');
        st = await c('({ open: c.isMenuOpen, panning: c.panning })');
        check('long-press: sliding onto an option and lifting selects it (no camera pan)', actions.length === 1 && /cancel/i.test(actions[0].option) && !st.open, { actions: actions.map(a => a.option), st });

        // 8. Host "right-click" mode: the next tap clicks with button 2
        await sleep(300);
        await evaluate('__lcTest.armSecondary()');
        mark = await logLen();
        await tap(256, 200);
        await sleep(150);
        clicks = await logSince(mark, 'click');
        st = await c('({ open: c.isMenuOpen })');
        const taken = await logSince(mark, 'secondary-taken');
        check('secondary-click mode: the tap is a right click and opens the menu', taken.length === 1 && clicks.length === 1 && clicks[0].button === 2 && st.open, { clicks, open: st.open });
        const secondaryOpen = (await logSince(mark, 'event')).find(e => e.name === 'menu-open');
        check("secondary-click mode: 'menu-open' has pointerId -1 (no finger holds it)", secondaryOpen?.detail?.pointerId === -1, secondaryOpen?.detail);
        row = await menuRow(0);
        await tap(row.gx, row.gy);
        await sleep(200);
        mark = await logLen();
        await tap(256, 250);
        clicks = await logSince(mark, 'click');
        check('secondary-click mode is one-shot (next tap is a left click)', clicks.length === 1 && clicks[0].button === 1, clicks);

        // 9. Proportional camera drag
        await sleep(800);
        {
            const id = nextTouchId++;
            const p = g2c(256, 170);
            let x = p.x;
            await touch.start([{ x, y: p.y, id }]);
            await sleep(30);
            for (let i = 0; i < 6; i++) {
                x += 5; // 30 px: crosses the 20 px pan threshold
                await touch.move([{ x, y: p.y, id }]);
                await sleep(25);
            }
            await sleep(100);
            const yaw0 = await c('c.orbitCameraYaw');
            for (let i = 0; i < 8; i++) {
                x += 5; // +40 px
                await touch.move([{ x, y: p.y, id }]);
                await sleep(25);
            }
            await sleep(100);
            const yaw1 = await c('c.orbitCameraYaw');
            await sleep(700); // finger rests
            const yaw2 = await c('c.orbitCameraYaw');
            for (let i = 0; i < 16; i++) {
                x -= 5; // -80 px (back the other way)
                await touch.move([{ x, y: p.y, id }]);
                await sleep(25);
            }
            await sleep(100);
            const yaw3 = await c('c.orbitCameraYaw');
            const pitch0 = await c('c.orbitCameraPitch');
            let y = p.y;
            for (let i = 0; i < 6; i++) {
                y += 5; // finger down 30 px -> pitch +60
                await touch.move([{ x, y, id }]);
                await sleep(25);
            }
            await sleep(100);
            const pitch1 = await c('c.orbitCameraPitch');
            const held = await c('[1, 2, 3, 4].map(i => c.keyHeld[i] | 0).join()'); // never-pressed keys are undefined
            mark = await logLen();
            await touch.end([]);
            await sleep(200);
            clicks = await logSince(mark, 'click');
            await shot('05-camera-dragged.png');
            const d1 = (yaw0 - yaw1) & 0x7ff; // finger right -> yaw decreases (same direction as upstream's arrow emulation)
            const d3 = (yaw3 - yaw2) & 0x7ff;
            check('camera: 40 px drag turns the camera by 4 units/px (160)', d1 === 160, { yaw0, yaw1, delta: d1 });
            check('camera: stops when the finger stops', yaw2 === yaw1, { yaw1, yaw2 });
            check('camera: proportional (80 px back -> 320)', d3 === 320, { yaw2, yaw3, delta: d3 });
            check('camera: pitch follows vertical drag (2 units/px, clamped 128..383)', pitch1 - pitch0 === Math.min(383, pitch0 + 60) - pitch0, { pitch0, pitch1 });
            check('camera: no arrow keys held while dragging; release does not click', held === '0,0,0,0' && clicks.length === 0, { held, clicks });
            const sens = await (async () => {
                await evaluate('__lcTest.settings.cameraSensitivity = 0.5');
                const id2 = nextTouchId++;
                let sx = p.x;
                await touch.start([{ x: sx, y: p.y, id: id2 }]);
                for (let i = 0; i < 6; i++) {
                    sx += 5;
                    await touch.move([{ x: sx, y: p.y, id: id2 }]);
                    await sleep(25);
                }
                const a = await c('c.orbitCameraYaw');
                for (let i = 0; i < 8; i++) {
                    sx += 5;
                    await touch.move([{ x: sx, y: p.y, id: id2 }]);
                    await sleep(25);
                }
                const b = await c('c.orbitCameraYaw');
                await touch.end([]);
                await evaluate('__lcTest.settings.cameraSensitivity = 1');
                return (a - b) & 0x7ff;
            })();
            check('camera: lcHost.settings.cameraSensitivity scales it (0.5 -> 80)', sens === 80, { delta: sens });
            // no dead band: the turn starts at the touch slop (14 px) with the whole way from the touch-down point
            const short = await (async () => {
                const id3 = nextTouchId++;
                const yawA = await c('c.orbitCameraYaw');
                const m0 = await logLen();
                await touch.start([{ x: p.x, y: p.y, id: id3 }]);
                for (let i = 1; i <= 6; i++) {
                    await touch.move([{ x: p.x + 3 * i, y: p.y, id: id3 }]);
                    await sleep(20);
                }
                await touch.end([]);
                await sleep(200);
                return { delta: (yawA - (await c('c.orbitCameraYaw'))) & 0x7ff, clicks: (await logSince(m0, 'click')).length };
            })();
            check('camera: an 18 px drag turns 18 * 4 = 72 units (nothing lost to the threshold), no click', short.delta === 72 && short.clicks === 0, short);
        }

        // 10. pointercancel releases everything and never clicks
        await sleep(500);
        {
            // (a) pending long-press
            mark = await logLen();
            let p = g2c(256, 200);
            await touch.start([{ x: p.x, y: p.y, id: nextTouchId++ }]);
            await sleep(150);
            await touch.cancel();
            await sleep(700);
            st = await c('({ open: c.isMenuOpen, button: c.mouseButton })');
            clicks = await logSince(mark, 'click');
            check('pointercancel: cancels a pending long-press (no menu, no click)', !st.open && clicks.length === 0, { st, clicks });
            // (b) camera pan
            mark = await logLen();
            const id = nextTouchId++;
            await touch.start([{ x: p.x, y: p.y, id }]);
            for (let i = 1; i <= 8; i++) {
                await touch.move([{ x: p.x + i * 5, y: p.y, id }]);
                await sleep(25);
            }
            const panning = await c('c.panning');
            await touch.cancel();
            await sleep(150);
            st = await c('({ panning: c.panning, button: c.mouseButton })');
            clicks = await logSince(mark, 'click');
            check('pointercancel: ends a camera pan without a click', panning === true && st.panning === false && clicks.length === 0, { panningBefore: panning, st, clicks });
            // (c) drag emulation in the side panel (held left button)
            mark = await logLen();
            p = g2c(650, 330);
            const id3 = nextTouchId++;
            await touch.start([{ x: p.x, y: p.y, id: id3 }]);
            for (let i = 1; i <= 6; i++) {
                await touch.move([{ x: p.x, y: p.y + i * 4, id: id3 }]);
                await sleep(25);
            }
            const dragging = await c('({ dragging: c.dragging, button: c.mouseButton })');
            await touch.cancel();
            await sleep(150);
            st = await c('({ dragging: c.dragging, button: c.mouseButton, next: c.nextMouseClickButton, objDragArea: c.objDragArea })');
            clicks = await logSince(mark, 'click');
            check('pointercancel: releases a side-panel drag (button up, no click after the drag start)', dragging.dragging === true && dragging.button === 1 && !st.dragging && st.button === 0 && st.objDragArea === 0 && clicks.length === 1, { before: dragging, after: st, clicks: clicks.length });
        }

        // 11. Chat input: tap shows, tap elsewhere hides; typing goes to chatInput
        await sleep(300);
        mark = await logLen();
        await tap(256, 447);
        kb = await logSince(mark, 'kb-show');
        check('keyboard: tap on the chat input -> show (chat)', kb.length === 1 && kb[0].kind === 'chat', kb.map(k => k.kind));
        await evaluate(`__lcTest.insertText('hello')`);
        await sleep(150);
        check('keyboard: typed text lands in chatInput', (await c('c.chatInput')) === 'hello');
        await evaluate(`__lcTest.key('Backspace'); __lcTest.key('Backspace'); __lcTest.key('Backspace'); __lcTest.key('Backspace'); __lcTest.key('Backspace');`);
        mark = await logLen();
        await tap(256, 250);
        let hides = await logSince(mark, 'kb-hide');
        check('keyboard: tap outside an input -> hide', hides.length === 1);
        check('keyboard: in game that tap does nothing else (no click, no action)', (await logSince(mark, 'click')).length === 0 && (await logSince(mark, 'action')).length === 0, (await logSince(mark)).map(e => e.type));

        // 12. Amount dialog (P_COUNTDIALOG, server-initiated): ::give coins, ::~bank, long-press coins, "Deposit X"
        const chat = async line => {
            await tap(256, 447);
            await evaluate(`__lcTest.insertText(${JSON.stringify(line + '\n')})`);
            await sleep(200);
        };
        // During the tutorial the server's game messages go to the tutorial box (tutComMessage) and upstream uses
        // the next click anywhere to dismiss them, so tap the chat area before tapping anything that matters. While
        // the keyboard is up (after chat()), the first tap only hides it (patch "touch model").
        const dismissTutorialMessage = async () => {
            for (let i = 0; i < 3 && (await c('!!c.tutComMessage')); i++) {
                await tap(256, 400);
                await sleep(100);
            }
        };
        await chat('::give coins 100');
        await sleep(1300);
        await dismissTutorialMessage();
        await chat('::~bank');
        let bankOpen = false;
        try {
            await waitFor('window.__client.mainModalId !== -1 && window.__client.sideModalId !== -1', 8000, 'bank interface');
            bankOpen = true;
        } catch (e) {
            check('bank: ::~bank opened the bank interface', false, String(e.message));
        }
        if (bankOpen) {
            await sleep(800);
            // coins are in bank_side inv slot 0: [inv] x=16 y=8 (32x32 slots) in the side panel at 553,205
            const slot = { gx: 553 + 16 + 16, gy: 205 + 8 + 16 };
            mark = await logLen();
            const p = g2c(slot.gx, slot.gy);
            await touch.start([{ x: p.x, y: p.y, id: nextTouchId++ }]);
            await sleep(700);
            const m = await c('({ open: c.isMenuOpen, area: c.menuArea, options: Array.from({ length: c.menuNumEntries }, (_, i) => c.menuOption[i]) })');
            await touch.end([]);
            await sleep(200);
            check('long-press on an inventory item (side panel) opens its menu', m.open && m.area === 1, m.options);
            const idx = m.options.findIndex(o => /deposit[- ]x/i.test(o));
            if (idx >= 0) {
                row = await menuRow(idx);
                mark = await logLen();
                await tap(row.gx, row.gy);
                await waitFor('window.__client.dialogInputOpen', 5000, 'amount dialog');
                await sleep(200);
                kb = await logSince(mark, 'kb-show');
                await shot('06-amount-dialog.png');
                check('keyboard: server-initiated amount dialog (P_COUNTDIALOG) -> show (dialog)', kb.length >= 1 && kb.at(-1).kind === 'dialog', kb.map(k => k.kind));
                mark = await logLen();
                await evaluate(`__lcTest.insertText('5\\n')`);
                await sleep(1500);
                hides = await logSince(mark, 'kb-hide');
                const inv = await c('c.dialogInputOpen');
                check('keyboard: amount entered + Enter closes the dialog -> hide', !inv && hides.length === 1, { dialogInputOpen: inv, hides: hides.length });
            } else {
                check('bank: "Deposit X" option found', false, m.options);
            }
            await evaluate('window.__client.closeModal()');
            await sleep(1500); // the engine answers the close a tick later; let that settle
        }

        // 13. Report abuse (chat button at 412..512 x 467..499)
        mark = await logLen();
        await tap(462, 483);
        await sleep(200);
        kb = await logSince(mark, 'kb-show');
        const rep = await c('({ main: c.mainModalId, report: c.reportAbuseComId })');
        await shot('07-report-abuse.png');
        check('keyboard: report abuse opened -> show (report)', rep.main !== -1 && rep.main === rep.report && kb.length >= 1 && kb.at(-1).kind === 'report', { rep, kinds: kb.map(k => k.kind) });
        mark = await logLen();
        await evaluate('window.__client.closeModal()');
        await sleep(200);
        hides = await logSince(mark, 'kb-hide');
        check('keyboard: report abuse closed -> hide', hides.length === 1);

        // 14. Social input (ignore list "Add"): needs the tabs, so finish the tutorial and log in again
        await chat('::setvar tutorial 1000');
        await sleep(1300);
        await dismissTutorialMessage();
        await tap(649, 484); // logout tab
        await sleep(400);
        await tap(553 + 30 + 64, 205 + 163 + 7); // "Click here to logout" (player/interfaces/logout.if try_logout)
        let loggedOut = false;
        try {
            await waitFor('!window.__client.ingame', 10000, 'logout');
            loggedOut = true;
        } catch (e) {
            check('logout via the logout tab', false, e.message);
        }
        if (loggedOut) {
            await sleep(800);
            await tap(462, 291); // Existing User
            // Let each step land before the next: a tap takes effect on the next drawn frame, and typed keys are only
            // read in the next client cycle, while a tap on a login field selects it at once. Keys typed just before
            // a tap on the other field would otherwise end up in that field.
            await sleep(150);
            await tap(370, 258);
            await sleep(150);
            await evaluate(`__lcTest.insertText(${JSON.stringify(user)})`);
            await sleep(150);
            await tap(370, 274);
            await sleep(150);
            await evaluate(`__lcTest.insertText(${JSON.stringify(pass)})`);
            // The engine answers 5 ("already logged in") until its login thread has confirmed the previous session's
            // logout and save (World.ts "still trying to log out from the last session"), so retry like a player would.
            let attempts = 0;
            let relogged = false;
            let lastMessage = '';
            while (!relogged && attempts < 6) {
                attempts++;
                await tap(302, 321);
                try {
                    await waitFor('window.__client.ingame', 5000, 'second login');
                    relogged = true;
                } catch {
                    lastMessage = await c('c.loginMes1 + " / " + c.loginMes2');
                    await sleep(2000);
                }
            }
            if (!relogged) {
                const form = await c('({ loginscreen: c.loginscreen, loginSelect: c.loginSelect, user: c.loginUser, pass: c.loginPass })');
                throw new Error(`second login failed after ${attempts} attempts: ${lastMessage} ${JSON.stringify({ form, expected: { user, pass } })}`);
            }
            await waitFor('window.__client.sceneState === 2', 30000, 'second login scene');
            await sleep(1500);
            check('relog: second login (saved account, tutorial finished)', true, { attempts, engineSaid: attempts > 1 ? lastMessage : undefined });
            await tap(614, 484); // ignore tab
            await sleep(300);
            mark = await logLen();
            await tap(553 + 15 + 36, 205 + 224 + 18); // ignore.if com_2 (clientcode 501 = CC_ADD_IGNORE)
            await sleep(200);
            kb = await logSince(mark, 'kb-show');
            const soc = await c('({ open: c.socialInputOpen, header: c.socialInputHeader })');
            await shot('08-social-input.png');
            check('keyboard: social input (add ignore) -> show (social), never shown upstream', soc.open && kb.length >= 1 && kb.at(-1).kind === 'social', { soc, kinds: kb.map(k => k.kind) });
            mark = await logLen();
            await evaluate(`__lcTest.insertText('zezima\\n')`);
            await sleep(400);
            hides = await logSince(mark, 'kb-hide');
            check('keyboard: social input submitted -> hide', !(await c('c.socialInputOpen')) && hides.length === 1);

            // 14b. Drag-to-scroll: the quest list (questlist.if com_0: 168x229 layer, scroll height 1025) and the chat history
            const vdrag = async (gx, gy, dyCss, { dxCss = 0, probe } = {}) => {
                const p = g2c(gx, gy);
                const id = nextTouchId++;
                await touch.start([{ x: p.x, y: p.y, id }]);
                await sleep(30);
                const steps = 10;
                for (let i = 1; i <= steps; i++) {
                    await touch.move([{ x: p.x + (dxCss * i) / steps, y: p.y + (dyCss * i) / steps, id }]);
                    await sleep(25);
                }
                const during = probe ? await evaluate(probe) : null;
                const m = await logLen();
                await touch.end([]);
                await sleep(200);
                return { during, clicks: await logSince(m, 'click') };
            };
            await tap(612, 186); // quest tab
            await sleep(300);
            mark = await logLen();
            const list = await vdrag(640, 400, -45, { probe: `(() => { const t = window.__client.touchScroll; window.__scrollTarget = t; return t && typeof t === 'object' ? { scrollPos: t.scrollPos, scrollHeight: t.scrollHeight, height: t.height } : t; })()` });
            const listAfter = await evaluate('window.__scrollTarget && window.__scrollTarget.scrollPos');
            const listClicks = await logSince(mark, 'click');
            check('drag-to-scroll: vertical drag on the quest list scrolls it (content follows the finger)', list.during && list.during.scrollHeight > list.during.height && listAfter > 30 && listClicks.length === 0, { during: list.during, after: listAfter, clicks: listClicks.length });
            const hz = await vdrag(640, 400, 4, { dxCss: 30, probe: '({ dragging: window.__client.dragging, scroll: window.__client.touchScroll !== null, button: window.__client.mouseButton })' });
            check('drag-to-scroll: a horizontal-first drag keeps the left-button drag emulation', hz.during.dragging && !hz.during.scroll && hz.during.button === 1, hz.during);
            for (let i = 0; i < 9; i++) {
                await chat(`line ${i}`);
            }
            await tap(256, 250); // dismiss the keyboard
            await sleep(400);
            const before = await c('({ pos: c.chatScrollPos, height: c.chatScrollHeight })');
            mark = await logLen();
            const ch = await vdrag(250, 380, 40, { probe: '({ scroll: window.__client.touchScroll, pos: window.__client.chatScrollPos })' });
            const afterChat = await c('({ pos: c.chatScrollPos, height: c.chatScrollHeight })');
            check('drag-to-scroll: dragging the chat history down reveals older lines, no click', before.height > 78 && ch.during.scroll === 'chat' && afterChat.pos > before.pos && ch.clicks.length === 0, { before, during: ch.during, after: afterChat });
            await shot('08b-chat-scrolled.png');
        }

        // 15. Stay logged in: no IDLE_TIMER (209) after >90 s without input
        await evaluate('__lcTest.settings.stayLoggedIn = true');
        const idleMark = await evaluate('__lcTest.opcodes.length');
        if (QUICK) {
            await evaluate('window.__client.idleTimer = performance.now() - 95000');
            await sleep(2500);
        } else {
            console.log('idle: waiting 95 s without input (stayLoggedIn = true) ...');
            await sleep(95000);
        }
        let ops = await evaluate(`__lcTest.opcodes.slice(${idleMark}).map(o => o.op)`);
        let idle = await c('({ ingame: c.ingame, logoutTimer: c.logoutTimer, idleFor: Math.round(performance.now() - c.idleTimer) })');
        check(`idle: stayLoggedIn=true sends no IDLE_TIMER (${QUICK ? 'back-dated 95 s' : 'real 95 s idle'})`, !ops.includes(209) && idle.logoutTimer === 0 && idle.ingame && idle.idleFor > 90000, { idle, sent: ops.length, noTimeouts: ops.filter(o => o === 120).length });
        // control: the same with stayLoggedIn=false does send it (proves the probe sees IDLE_TIMER). Not idle while the
        // setting changes: the step above left the client 95 s idle, and a cycle in between would send one too many.
        await evaluate('window.__client.idleTimer = performance.now()');
        await evaluate('__lcTest.settings.stayLoggedIn = false');
        const ctlMark = await evaluate('__lcTest.opcodes.length');
        await evaluate('window.__client.idleTimer = performance.now() - 95000');
        await sleep(600);
        ops = await evaluate(`__lcTest.opcodes.slice(${ctlMark}).map(o => o.op)`);
        idle = await c('({ logoutTimer: c.logoutTimer })');
        check('idle control: stayLoggedIn=false sends IDLE_TIMER once and arms the logout timer', ops.filter(o => o === 209).length === 1 && idle.logoutTimer > 0, { idle, opcodes: ops.slice(0, 20) });
        await shot('09-end.png');
    }

    // ---------------------------------------------------------------------------------------------------
    // 16. Without a host page (desktop testing): MobileKeyboard falls back to a hidden <input type=text>
    fs.writeFileSync(path.join(OUT, 'stub-log.json'), JSON.stringify(await evaluate('__lcTest.log'), null, 1));
    page.console.push('---- navigating to the no-host page ----');
    await page.navigate(`${server.url}/?mode=stub&host=none`);
    await waitFor('window.__client && window.__client.mouseTrackingInterval', 60000, 'client (no host)');
    await sleep(300);
    await tap(462, 291); // Existing User
    await tap(370, 258); // username field
    const focused = await evaluate(`(() => { const a = document.activeElement; return a ? { tag: a.tagName, type: a.type } : null; })()`);
    for (const ch of 'abc') {
        await page.S('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, code: `Key${ch.toUpperCase()}` });
        await page.S('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}` });
    }
    await sleep(200);
    const typed = await c('c.loginUser');
    check('no host: keyboard falls back to a hidden text input; its keys reach the game', focused?.tag === 'INPUT' && focused.type === 'text' && typed === 'abc', { focused, typed });
    await tap(462, 400); // outside the fields
    check('no host: tapping outside hides it (canvas focused again)', await evaluate(`document.activeElement === document.getElementById('canvas')`));
} catch (e) {
    check('harness ran to completion', false, String(e.stack ?? e).slice(0, 1500));
} finally {
    if (page) {
        try {
            const name = fs.existsSync(path.join(OUT, 'stub-log.json')) ? 'stub-log-nohost.json' : 'stub-log.json';
            fs.writeFileSync(path.join(OUT, name), JSON.stringify(await page.evaluate('__lcTest.log'), null, 1));
        } catch {
            // page gone
        }
        fs.writeFileSync(path.join(OUT, 'console.log'), page.console.join('\n') + '\n');
    }
    fs.writeFileSync(path.join(OUT, 'requests.log'), server.requests.map(r => `${r.method} ${r.path} ${r.status} ${r.bytes ?? ''}`).join('\n') + '\n');
    await cdp.close();
    await server.close();
}

const failed = results.filter(r => r.pass === false);
const summary = { when: new Date().toISOString(), build: { debug: DEBUG, ms: build.ms, clientJsBytes: build.clientJsBytes }, engine: ENGINE ? { bundle: ENGINE_BUNDLE, layout: ENGINE_LAYOUT } : null, quick: QUICK, timeline, passed: results.filter(r => r.pass).length, failed: failed.length, skipped: results.filter(r => r.pass === null).length, results };
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(summary, null, 1));
console.log(`\n${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped -> ${OUT}`);
process.exit(failed.length ? 1 : 0);
