#!/usr/bin/env node
// The native layer's test page on the Android app: the twin of web/test/native/drive.mjs (+ drive-hw.mjs), which runs
// web/test/native/game-test on the iOS simulator. The same page (test.js, with its Android branches) and the same phases:
// routes (MIME, statuses, HEAD, scripts and modules, wasm, saves from the page and from an engine-like worker's sync XHR,
// the header transport, /log, an 8 MB file, aborts, parallel requests, a blocked navigation, haptics, keep-awake, the
// memory warning, settings), keyboard (every kind, the traits, typing, the input rules, chips, paste, Send, hardware keys
// through the debug hook, Vibration off/on), lm (the chat model's status, the key's native box, Claude online against
// the local mock, busy), lifecycle (terminate, a background cycle, a page that never answers), the renderer killed in
// the background and in front, the crash loop's error screen, and real hardware keys (adb input keyevent).
// android/test/PARITY.md maps each iOS check to this run or to the other Android tests.
//
//   node android/test/drive.mjs [--serial emulator-5554] [--no-build] [--start-phase P]
//
// It builds a debug APK whose web bundle is the test page (lib/testbuild.mjs: the normal bundle and APK are put back
// before the run), without the chat model (-Plc.model=none: like the simulator, which runs none; the on-device model is
// android/test/lm.mjs's), installs it with the app's data cleared, launches it with the verbose log, and reacts to the
// page's markers in the native log (the console bridge's `[js:log]` lines):
//   SHOT <name>                 → adb screencap into android/build/drive/run-*/<name>.png
//   ACTION background-cycle     → the Settings app in front for 5 s, then the game again (am start: the same activity)
//   ACTION background-hang      → the same for 12 s (past the 8 s flush timeout)
//   ACTION background-kill      → the Settings app, the renderer crashed meanwhile (DEBUG renderer-crash over CDP:
//                                 chrome://crash; the AVD has no root to kill the isolated renderer process), then the
//                                 game again
//   ACTION kill-webcontent      → the renderer crashed (the same) with the app in front
//   ACTION kill-webcontent-loop → the third renderer death in two minutes (DEBUG renderer-kill: terminate(), the other
//                                 way a renderer goes): the error screen is checked here (uiautomator), then Try again
//                                 reloads the page, which goes on to the hardware keys
//   HWKEYS idle / shown         → real key events (adb shell input keyevent), as drive-hw.mjs types them on the simulator
//   DONE pass=N fail=M          → stop
// It also runs the local mock of the Messages API (web/test/lm/mock-claude.mjs) behind `adb reverse`, for the page's
// chat-model phase (the app's online requests go there through a DEBUG hook): 127.0.0.1:47591 on the device (LM_MOCK_PORT,
// baked into the test build), the first free port from there on this Mac (lib/mock.mjs).
//
// The run clears the app's data at the start and again at the end, then installs the normal debug APK again (if one is
// built), so it runs on an emulator only (as iOS's on the simulator); --serial names one.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ACTIVITY, ADB, PKG, device, sleep } from './lib/adb.mjs';
import { ANDROID, REPO, WEB_GAME, apkFile, buildTestApk, gradle, isTestBundle, normalApk } from './lib/testbuild.mjs';
import { mockBehindReverse } from './lib/mock.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
};
const SERIAL = option('--serial', process.env.ANDROID_SERIAL ?? 'emulator-5554');
const START_PHASE = option('--start-phase', process.env.START_PHASE ?? null);
const MOCK_PORT = Number(process.env.LM_MOCK_PORT ?? 47591);
if (!SERIAL.startsWith('emulator-')) {
    console.error(`drive.mjs clears the app's data: it runs on an emulator only (as iOS's on the simulator), not ${SERIAL}`);
    process.exit(1);
}
const GAME_TEST = path.join(REPO, 'web', 'test', 'native', 'game-test');
const BUILD_DIR = path.join(ANDROID, 'build', 'drive');
const TEST_APK = path.join(BUILD_DIR, 'app-drive.apk');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.join(BUILD_DIR, `run-${stamp}`);
fs.mkdirSync(OUT, { recursive: true });

const d = device(SERIAL);
const t0 = Date.now();
const note = msg => {
    const line = `[drive +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`;
    console.log(line);
    fs.appendFileSync(`${OUT}/drive.log`, `${line}\n`);
};

// Checks the driver itself makes (the page cannot see its own error screen), counted with the page's.
const driverChecks = [];
function check(name, ok, detail = '') {
    driverChecks.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ------------------------------------------------------------------------------------------------ 1. the test build

const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1/messages`;
if (!argv.includes('--no-build')) {
    // the normal bundle's ui/ (the fonts and sprites the native cover draws with), so it has to exist
    if (!fs.existsSync(path.join(WEB_GAME, 'index.html')) || isTestBundle(WEB_GAME)) gradle(':app:buildWeb');
    buildTestApk({
        out: TEST_APK,
        gradleArgs: ['-Plc.model=none'],
        makeBundle: (game, normal) => {
            fs.cpSync(GAME_TEST, game, { recursive: true });
            if (normal) fs.cpSync(path.join(normal, 'ui'), path.join(game, 'ui'), { recursive: true });
            // t/big.bin: 8 MiB + 123 bytes, byte i = (i * 31 + (i >> 11)) & 255 (checked byte-for-byte by test.js)
            const big = new Uint8Array(8 * 1024 * 1024 + 123);
            for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 11)) & 255;
            fs.writeFileSync(path.join(game, 't', 'big.bin'), big);
            fs.writeFileSync(path.join(game, 'lm-mock.txt'), MOCK_URL);
            if (START_PHASE) fs.writeFileSync(path.join(game, 'start-phase.txt'), START_PHASE);
        }
    });
    note(`built ${path.relative(REPO, TEST_APK)} (the test page, no chat model); the normal web bundle and debug APK are back`);
}
if (!fs.existsSync(TEST_APK) || !apkFile(TEST_APK, 'assets/Game/test.js')) {
    console.error(`${TEST_APK} is missing; build without --no-build first`);
    process.exit(1);
}
const builtPhase = apkFile(TEST_APK, 'assets/Game/start-phase.txt')?.toString().trim() ?? null;
if (builtPhase !== (START_PHASE ?? null)) {
    console.error(`${TEST_APK} was built ${builtPhase ? `to start at ${builtPhase}` : 'to start at the beginning'}; build it again (without --no-build) for ${START_PHASE ? `--start-phase ${START_PHASE}` : 'a full run'}`);
    process.exit(1);
}
const builtMock = apkFile(TEST_APK, 'assets/Game/lm-mock.txt')?.toString().trim();
if (builtMock !== MOCK_URL) {
    console.error(`${TEST_APK} points at the mock ${builtMock}; build it again for ${MOCK_URL}`);
    process.exit(1);
}

// ------------------------------------------------------------------------------------------------ 2. device, install

const mock = await mockBehindReverse(d, { devicePort: MOCK_PORT, slowMs: 6000 });
note(`mock Messages API on this Mac's port ${mock.hostPort}, the device's ${MOCK_PORT}`);
// Gboard shows beside the AVD's hardware keyboard only with this on (keyboard.mjs does the same); put back at the end
const imeWithHardKeyboard = d.adbQuiet('shell', 'settings', 'get', 'secure', 'show_ime_with_hard_keyboard').trim();
d.adbQuiet('shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1');
d.adbQuiet('shell', 'settings', 'put', 'secure', 'immersive_mode_confirmations', 'confirmed');
d.adbQuiet('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
d.adbQuiet('emu', 'sensor', 'set', 'acceleration', '9.81:0:0');
d.adbQuiet('shell', 'svc', 'power', 'stayon', 'true');
d.adbQuiet('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
d.adbQuiet('shell', 'am', 'force-stop', PKG);
const installed = d.adbQuiet('install', '-r', TEST_APK);
if (!/Success/.test(installed)) {
    console.error(`adb install failed: ${installed.trim()}`);
    process.exit(1);
}
// (a fresh start, as the simulator's uninstall: saves, WebView storage, settings, the key)
d.adbQuiet('shell', 'pm', 'clear', PKG);
note(`installed on ${SERIAL} with the app's data cleared`);

// ------------------------------------------------------------------------------------------------ 3. run

const logPath = `${OUT}/console.log`;
const log = fs.createWriteStream(logPath);
d.clearLog();
const logcat = spawn(ADB, ['-s', SERIAL, 'logcat', '-v', 'threadtime', 'LostCity:V', '*:S'], { stdio: ['ignore', 'pipe', 'pipe'] });
d.adb('shell', 'am', 'start', '-W', '-S', '-n', ACTIVITY, '--ez', 'lostcity.verbose', 'true');
let lastTotal = null;
let done = false;
const queue = [];
let busy = false;
const screenshot = name => {
    try {
        d.screenshot(`${OUT}/${name}.png`);
        note(`screenshot ${name}.png`);
    } catch (e) {
        note(`screenshot ${name} failed: ${e.message.split('\n')[0]}`);
    }
};

/**
 * Ends the WebView's renderer through a DEBUG hook, over CDP (it works with the app in the background too):
 * `renderer-crash` crashes it (chrome://crash: onRenderProcessGone with didCrash true, as iOS's SIGKILL of WebContent),
 * `renderer-kill` ends it (WebViewRenderProcess.terminate(): didCrash false). Resolves to the native log's line.
 */
async function killRenderer(action) {
    let page = null;
    const gone = waitLog(/WebView renderer gone/, 12000);
    try {
        page = await d.connect({ timeoutMs: 15000 });
        const pid = d.adbQuiet('shell', 'dumpsys', 'activity', 'services', PKG).match(/app=ProcessRecord\{\w+ (\d+):[^}]*sandboxed_process/)?.[1];
        note(`ending the renderer ${pid ?? '?'} (DEBUG ${action})`);
        await page.eval(`window.LostCityNativeBridge.native.postMessage({ type: 'debug', id: 0, action: ${JSON.stringify(action)} })`);
    } catch (e) {
        note(`${action}: ${e.message.split('\n')[0]}`);
    } finally {
        page?.close();
    }
    return gone;
}

function settingsApp() {
    d.adbQuiet('shell', 'am', 'start', '-a', 'android.settings.SETTINGS');
}
function backToGame() {
    d.adbQuiet('shell', 'am', 'start', '-n', ACTIVITY);
}

// Real key events, as drive-hw.mjs's System Events keystrokes into the Simulator: through the system's input pipeline
// (a virtual hardware keyboard), each down and up.
function keys(names) {
    for (const name of names) {
        d.adbQuiet('shell', 'input', 'keyevent', name);
    }
}

async function act(line) {
    let m;
    if ((m = line.match(/\bSHOT (\S+)/))) {
        screenshot(m[1]);
    } else if ((m = line.match(/\bACTION (background-cycle|background-hang)/))) {
        const seconds = m[1] === 'background-cycle' ? 5 : 12;
        note(`backgrounding (the Settings app) for ${seconds} s`);
        settingsApp();
        await sleep(seconds * 1000);
        note('foregrounding the app');
        backToGame();
    } else if (line.includes('ACTION background-kill')) {
        note('backgrounding (the Settings app), then ending the renderer while in the background');
        settingsApp();
        await sleep(2500);
        const gone = await killRenderer('renderer-crash');
        check('crash-bg: a real renderer crash in the background is noticed there (no reload until the app is back)', /crash=true, .*app in background/.test(gone ?? ''), gone ?? 'no "renderer gone" line');
        await sleep(3000);
        note('foregrounding the app');
        backToGame();
        await sleep(600);
        screenshot('crash-bg-restarting');
    } else if (line.includes('ACTION kill-webcontent-loop')) {
        const stopped = await killRenderer('renderer-kill');
        await sleep(1500);
        screenshot('crash-loop');
        const ui = d.uiDump();
        check('crash loop: the third renderer death in two minutes (this one terminate(), not a crash) stops at the error screen with Try again', /crash=false, .*3× in 2 min/.test(stopped ?? '') && /cover_retry/.test(ui) && /Try again/.test(ui), stopped ?? 'no "renderer gone" line');
        note(`page so far: ${lastTotal ?? 'unknown'}`);
        // (iOS's run stops here and drive-hw.mjs relaunches for the hardware keys: Try again reloads the page, which is
        // in phase 'done' and goes on to 'hwkeys')
        const tapped = d.tapNative(/^Try again$/);
        check('crash loop: Try again reloads the page', tapped && !!(await waitLog(/loading .*\(retry after repeated crashes\)/, 8000)));
    } else if (line.includes('ACTION kill-webcontent')) {
        const gone = await killRenderer('renderer-crash');
        check('crash: a real renderer crash in front is noticed (crash=true, the app visible)', /crash=true, .*app visible/.test(gone ?? ''), gone ?? 'no "renderer gone" line');
        await sleep(700);
        screenshot('crash-restarting');
    } else if (line.includes('HWKEYS idle')) {
        await sleep(500);
        note('typing (idle): a b ← Esc F1 ⌫ ↩ ⇥');
        keys(['KEYCODE_A', 'KEYCODE_B', 'KEYCODE_DPAD_LEFT', 'KEYCODE_ESCAPE', 'KEYCODE_F1', 'KEYCODE_DEL', 'KEYCODE_ENTER', 'KEYCODE_TAB']);
    } else if (line.includes('HWKEYS shown')) {
        await sleep(500);
        note('typing (shown): c d ⌫ ↩');
        keys(['KEYCODE_C', 'KEYCODE_D', 'KEYCODE_DEL', 'KEYCODE_ENTER']);
    } else if ((m = line.match(/\bDONE (pass=\d+ fail=\d+)/))) {
        note(`page finished: ${m[1]}`);
        await sleep(500);
        finish(m[1]);
    }
}
async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) await act(queue.shift());
    busy = false;
}

// The native log as it arrives (logcat threadtime: `date time pid tid level LostCity: message`), and a wait for a line.
const seen = [];
const waiters = [];
function onLine(line) {
    seen.push(line);
    if (seen.length > 5000) seen.splice(0, 2500);
    for (const w of [...waiters]) {
        if (w.pattern.test(line)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(line);
        }
    }
    const total = line.startsWith('[js:') && line.match(/TOTAL (pass=\d+ fail=\d+.*)$/);
    if (total) lastTotal = total[1];
    // (markers only from the console bridge's `[js:…]` copy: with the verbose log on, Chromium's own copy of each
    // console line is logged too, as `[console:…]`)
    const page = line.startsWith('[js:');
    if (page && /\b(SHOT|ACTION|DONE|HWKEYS) /.test(line)) {
        queue.push(line);
        void pump();
    }
    if (line.startsWith('[console:')) return;
    if (/\b(FAIL|PASS|INFO|LIFECYCLE) /.test(line) || /\[(life|host|kbd)\]/.test(line)) process.stdout.write(`${line.length > 1500 ? `${line.slice(0, 1500)} …` : line}\n`);
}
function waitLog(pattern, ms) {
    return new Promise(resolve => {
        const w = { pattern, resolve };
        waiters.push(w);
        setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) {
                waiters.splice(i, 1);
                resolve(null);
            }
        }, ms);
    });
}
const partial = new Map();
let buffer = '';
const onData = chunk => {
    const text = chunk.toString();
    log.write(text);
    buffer += text;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, i).replace(/\r$/, '');
        buffer = buffer.slice(i + 1);
        const m = /^\S+\s+\S+\s+\d+\s+(\d+)\s+\w\s+LostCity\s*: (.*)$/.exec(raw);
        if (!m) continue;
        // (Log.kt cuts a line into entries of 4,000 characters: joined again)
        const joined = (partial.get(m[1]) ?? '') + m[2];
        if (m[2].length === 4000) {
            partial.set(m[1], joined);
            continue;
        }
        partial.delete(m[1]);
        onLine(joined);
    }
};
logcat.stdout.on('data', onData);
logcat.stderr.on('data', onData);
logcat.on('exit', code => {
    if (!done) {
        note(`logcat exited (${code})`);
        finish(null);
    }
});
// Launch appearance: a burst of screenshots over the first ~1.5 s (launch screen → black → cover).
void (async () => {
    for (let i = 0; i < 6; i++) {
        await sleep(150);
        if (!done) screenshot(`launch-${i}`);
    }
})();

function finish(pageTotal) {
    if (done) return;
    done = true;
    const wrong = mock.requests.filter(r => r.problems.length);
    note(`mock API: ${mock.requests.length} requests${wrong.length ? `, ${wrong.length} malformed: ${wrong.map(r => r.problems.join('; ')).join(' | ')}` : ', all as the API takes them'}`);
    void mock.close();
    d.adbQuiet('shell', 'am', 'force-stop', PKG);
    d.adbQuiet('shell', 'am', 'force-stop', 'com.android.settings');
    setTimeout(() => {
        logcat.kill('SIGTERM');
        const logs = d.adbQuiet('shell', 'cat', `/sdcard/Android/data/${PKG}/files/Logs/lostcity.log`);
        fs.writeFileSync(`${OUT}/app-log.txt`, logs);
        note(`Documents tree:\n${d.adbQuiet('shell', 'run-as', PKG, 'find', 'files/Documents').trim()}`);
        note(`console log: ${logPath}`);
        // put the device back: the IME setting, the reverse port, the app's data (the test page's) and the normal build
        d.adbQuiet('shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', /^\d+$/.test(imeWithHardKeyboard) ? imeWithHardKeyboard : '0');
        d.adbQuiet('forward', '--remove', `tcp:${d.devtoolsPort}`);
        d.adbQuiet('shell', 'svc', 'power', 'stayon', 'false');
        d.adbQuiet('shell', 'pm', 'clear', PKG);
        const normal = normalApk();
        if (normal && /Success/.test(d.adbQuiet('install', '-r', normal))) {
            note(`the normal debug build is installed again (${path.relative(REPO, normal)}; the app's data was cleared)`);
        } else {
            note(`no normal debug APK installed: run DEVICE=${SERIAL} android/scripts/deploy.sh`);
        }
        const page = /pass=(\d+) fail=(\d+)/.exec(pageTotal ?? lastTotal ?? '');
        const pass = (page ? Number(page[1]) : 0) + driverChecks.filter(c => c.ok).length;
        const fail = (page ? Number(page[2]) : 1) + driverChecks.filter(c => !c.ok).length + (wrong.length ? 1 : 0);
        const failedNames = [...(/failed: (.*)$/.exec(lastTotal ?? '')?.[1]?.split(' | ') ?? []), ...driverChecks.filter(c => !c.ok).map(c => c.name)];
        fs.writeFileSync(`${OUT}/result.json`, `${JSON.stringify({ serial: SERIAL, page: pageTotal ?? lastTotal, driver: driverChecks, pass, fail, failed: failedNames, mockRequests: mock.requests.length, mockMalformed: wrong.length }, null, 1)}\n`);
        note(`result: pass=${pass} fail=${fail}${pageTotal ? '' : ' (the page did not finish)'}${failedNames.length ? ` failed: ${failedNames.join(' | ')}` : ''} — ${OUT}`);
        process.exit(fail || !pageTotal ? 1 : 0);
    }, 1500);
}
process.on('SIGINT', () => finish(null));
setTimeout(() => {
    note('TIMEOUT');
    finish(null);
}, 10 * 60 * 1000); // (iOS's 8 min, plus the hardware keys this run goes on to)
