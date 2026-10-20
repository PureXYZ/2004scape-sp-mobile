// The Android app's smoke test: the real app on an emulator or phone, driven over adb and CDP (docs/ANDROID.md §2 test/,
// §7). It needs a debug build (WebContents debugging and the debug hooks).
//
//   node android/test/smoke.mjs [--serial emulator-5554] [--no-build] [--no-install] [--only a,b] [--skip a,b]
//
// Phases (each a list of checks; screenshots and results.json in android/build/smoke/):
//   boot      cold start (data cleared) to the title: am start's TotalTime, the native log's marks, the page's own
//   login     a new user logs in (the e2e taps + LostCityHost.keyboard), the designer accepted: in the world
//   walk      a touch on the minimap: the character moves
//   save      Settings › Save now → "Saved"; the save is on disk (run-as ls files/Documents/players/main), written
//             through X-LC-Body (the router's PUT log line)
//   back      Back does nothing: Settings and the options menu stay open, and with nothing open the app and page stay
//   home      HOME: pause/background flushed, the WebView paused; relaunch: foreground/resume answered, the same page
//   recreate  the activity destroyed in the background (Don't keep activities): the new one re-attaches the WebView,
//             no reload
//   settings  {type:'settings'} kept natively, refused above 64 KB, injected again as LostCityNative.settings
//   memory    am send-trim-memory: LostCityHost.memoryWarning() answered
//   rotate    reverse landscape with a display cutout: no reload, the safe area moves to the other side
//   crash     the renderer is killed: a new WebView, a reload, the character still saved
//   crashloop two more kills within two minutes: native's error screen; Try again reloads the game
//   nowebview the renderer killed and no new WebView can be made (debug webview-fail): the error screen; Try again makes
//             one and reloads the game
//   bots      25 bots (engine-bots.js): Save now writes bots/main/bots.sav through X-LC-Body
//   update    a CLEAR_TASK launch while in front (what Android 17's PackageUpdateController sends when the app is
//             updated on screen): the old activity's late onStop is ignored, the game keeps running; then a real
//             update and launch (deploy.sh's install -r + am start, which can race that relaunch): the game in front and
//             running, the character still there
//   floor     a WebView below the floor (debug lostcity.webViewFloor): the native error screen; Update leaves for the
//             store and coming back checks again; once the WebView passes (the floor lowered by a new intent, as an
//             update would), coming back starts the game
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ACTIVITY, PKG, device, sleep } from './lib/adb.mjs';

const ANDROID = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ANDROID, 'build', 'smoke');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
};
const SERIAL = option('--serial', process.env.ANDROID_SERIAL ?? 'emulator-5554');
const ONLY = option('--only', null)?.split(',');
const SKIP = option('--skip', '')?.split(',') ?? [];
const wanted = phase => (!ONLY || ONLY.includes(phase)) && !SKIP.includes(phase);

fs.mkdirSync(OUT, { recursive: true });
for (const old of fs.readdirSync(OUT)) if (old.endsWith('.png')) fs.rmSync(path.join(OUT, old)); // (this run's shots only)
const d = device(SERIAL);
const results = { serial: SERIAL, started: new Date().toISOString(), checks: [], timings: {} };
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
  const base = { now: performance.now(), engine: h?.engineState ?? null, mark: window.__smokeMark ?? null };
  if (!c) return base;
  const p = c.localPlayer; return { ...base, pct: c.lastProgressPercent, title: !!c.titleFlames, loginscreen: c.loginscreen,
    ingame: c.ingame, mes1: c.loginMes1, mes2: c.loginMes2, err: !!(c.errorLoading || c.errorHost || c.errorStarted),
    loaderHidden: document.getElementById('loading')?.hidden ?? null, modal: c.mainModalId,
    settingsOpen: !document.getElementById('settings').hidden, menuOpen: !document.getElementById('menu-layer')?.hidden,
    pos: p ? [c.mapBuildBaseX + (p.x >> 7), c.mapBuildBaseZ + (p.z >> 7), c.minusedlevel] : null }; })()`;

let page = null;
const state = () => page.eval(STATE);

/** Posts a debug action to the app (DEBUG builds) and waits for its window.__lcDebugReply. */
async function debug(action, extra = {}) {
    return debugEval(action, extra).catch(err => {
        // the renderer-kill reply can lose the race with the renderer it ends: the log line tells instead
        if (action === 'renderer-kill' && /connection closed/.test(String(err))) return true;
        throw err;
    });
}

async function debugEval(action, extra) {
    return page.eval(`new Promise(resolve => {
        const id = Math.floor(Math.random() * 1e9) + 1;
        const previous = window.__lcDebugReply;
        const timer = setTimeout(() => resolve({ timeout: true }), 8000);
        window.__lcDebugReply = (replyId, value) => {
            if (replyId !== id) return previous?.(replyId, value);
            clearTimeout(timer);
            window.__lcDebugReply = previous;
            resolve(value);
        };
        window.LostCityNativeBridge.native.postMessage({ type: 'debug', id, action: ${JSON.stringify(action)}, ...${JSON.stringify(extra)} });
    })`);
}

/** A fresh CDP session on the app's page; a target that is going away (a dead renderer's) is passed over. */
async function reconnect(timeoutMs = 30000) {
    page?.close();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        page = await d.connect({ timeoutMs: Math.max(1000, deadline - Date.now()) });
        try {
            if ((await page.eval('1 + 1')) === 2) return page;
        } catch {
            // the old target, closing
        }
        page.close();
        if (Date.now() > deadline) throw new Error('no live page target');
        await sleep(500);
    }
}

/** Launches the app; `fresh`: force-stopped first, with these settings merged (debug lostcity.settings). */
function launch({ stop = true, settings = null, extras = [] } = {}) {
    const args = ['shell', 'am', 'start', '-W', ...(stop ? ['-S'] : []), '-n', ACTIVITY];
    if (settings) args.push('--es', 'lostcity.settings', `'${JSON.stringify(settings)}'`);
    args.push(...extras);
    const output = d.adb(...args);
    return { totalMs: Number(/TotalTime: (\d+)/.exec(output)?.[1] ?? NaN), launchState: /LaunchState: (\w+)/.exec(output)?.[1] ?? '?' };
}

/** The system's one-time "Viewing full screen" sheet over an immersive app: dismissed if it shows. */
function dismissImmersiveSheet() {
    return d.tapNative(/^Got it$/i);
}

async function bootToTitle(label, timeoutMs = 120000) {
    const booted = await waitFor(async () => {
        const s = await state();
        return s.err ? s : s.title && s.pct === 100 && s.engine === 'ready' && s.loaderHidden ? s : null;
    }, timeoutMs, 100);
    check(`${label}: title drawn, world ready, loader gone`, booted.ok && !booted.value?.err, booted.value ? { engine: booted.value.engine, pct: booted.value.pct, ms: booted.ms } : 'timeout');
    return booted;
}

async function login(user, { newUser }) {
    await page.tapGame(newUser ? 302 : 462, 291);
    const form = await waitFor(async () => (await state()).loginscreen === 2, 5000);
    check(`${newUser ? 'new' : 'existing'} user: the login form opens`, form.ok);
    await page.tapGame(360, 248);
    await sleep(400);
    await page.eval(`window.LostCityHost.keyboard.insertText(${JSON.stringify(user)})`);
    await sleep(300);
    const started = Date.now();
    await page.eval('window.LostCityHost.keyboard.submit()');
    const inWorld = await waitFor(async () => (await state()).ingame, 60000);
    const s = await state();
    check(`${user} logs in`, inWorld.ok, `${Date.now() - started} ms, pos ${JSON.stringify(s.pos)} ${s.mes1 ?? ''} ${s.mes2 ?? ''}`.trim());
    return inWorld.ok;
}

/** Tutorial Island's first login opens the character designer: "Accept" (web/test/autotest.js's way). */
async function acceptDesigner() {
    const open = await waitFor(async () => (await state()).modal !== -1, 4000);
    if (!open.ok) return;
    await page.eval('(() => { const c = window.__client; c.tapAt(c.viewportX + c.modalX + 256, c.viewportY + c.modalY + 282, 1); })()');
    const closed = await waitFor(async () => (await state()).modal === -1, 6000);
    check('the character designer is accepted', closed.ok);
}

async function saveNow(label) {
    const opened = (await page.tapElement('#btn-settings')) && (await waitFor(async () => (await state()).settingsOpen, 3000)).ok;
    check(`${label}: Settings opens`, opened);
    await page.tapElement('#settings-save');
    const saved = await waitFor(() => page.eval(`document.getElementById('settings-save').textContent`).then(t => (t === 'Saved' || t === 'Save failed' ? t : null)), 10000);
    check(`${label}: Save now → "Saved"`, saved.value === 'Saved', saved.value ?? 'no answer');
    return opened;
}

/**
 * Turns the device to landscape or reverse landscape. The activity is sensorLandscape, which follows the accelerometer
 * even with auto-rotate off, so the emulator's sensor is moved (as the spike did); a phone gets user_rotation, which only
 * an activity that does not follow the sensor obeys.
 */
function rotate(to) {
    if (SERIAL.startsWith('emulator-')) {
        d.adbQuiet('emu', 'sensor', 'set', 'acceleration', to === 'reverse' ? '-9.81:0:0' : '9.81:0:0');
    } else {
        d.adbQuiet('shell', 'settings', 'put', 'system', 'user_rotation', to === 'reverse' ? '3' : '1');
    }
}

const files = folder => d.adbQuiet('shell', 'run-as', PKG, 'ls', '-l', `files/Documents/${folder}`);

// ---------------------------------------------------------------------------------------------------- build, install

if (!argv.includes('--no-build')) {
    console.log('building the debug APK…');
    execFileSync(path.join(ANDROID, 'gradlew'), [':app:assembleDebug', '--console=plain', '-q'], { cwd: ANDROID, stdio: 'inherit' });
}
if (!argv.includes('--no-install')) {
    const apk = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
    console.log(d.install(apk));
}
const USER = `smoke${Date.now() % 100000}`;
results.user = USER;
// the system's education sheet for immersive apps is shown once per device; mark it seen (best effort)
d.adbQuiet('shell', 'settings', 'put', 'secure', 'immersive_mode_confirmations', 'confirmed');
d.adbQuiet('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
d.adbQuiet('shell', 'settings', 'put', 'system', 'user_rotation', '1');
rotate('landscape');
d.adbQuiet('shell', 'svc', 'power', 'stayon', 'true');
d.adbQuiet('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');

try {
    // ------------------------------------------------------------------------------------------------ boot
    d.adb('shell', 'pm', 'clear', PKG);
    d.clearLog();
    const t0 = Date.now();
    const started = launch({ settings: { seenHowToPlay: true, bots: 0, jmod: true } });
    results.timings.amStartTotalMs = started.totalMs;
    await reconnect();
    results.timings.cdpMs = Date.now() - t0;
    const booted = await bootToTitle('cold boot');
    const perf = await page.eval(`(() => { const n = performance.getEntriesByType('navigation')[0]; return { domContentLoaded: Math.round(n?.domContentLoadedEventEnd ?? 0), load: Math.round(n?.loadEventEnd ?? 0), title: Math.round(performance.now()) }; })()`);
    results.timings.page = perf;
    const marks = {};
    const log = d.log();
    const at = pattern => {
        const line = log.find(l => pattern.test(l));
        const time = line && /(\d\d):(\d\d):(\d\d)\.(\d\d\d)/.exec(line);
        return time ? ((+time[1] * 60 + +time[2]) * 60 + +time[3]) * 1000 + +time[4] : null;
    };
    const launchAt = at(/\[app\] Lost City/);
    for (const [name, pattern] of [['loading', /\[host\] loading /], ['ready', /\[host\] page ready/], ['title', /status title/], ['engineReady', /status engine-ready/]]) {
        const t = at(pattern);
        marks[name] = t !== null && launchAt !== null ? t - launchAt : null;
    }
    results.timings.nativeMarksMs = marks;
    console.log(`   am start TotalTime ${started.totalMs} ms (${started.launchState}); native marks after the launch line: ${JSON.stringify(marks)}; title after ${booted.ms} ms of polling`);
    // (WARM when the system had started the process for the Files app's DocumentsProvider: DocumentsUI, if it ran
    // lately, refreshes its roots after an install or a clear; the activity and the page still start from nothing)
    check('cold boot: launched cold and the page was loaded once', (started.launchState === 'COLD' || started.launchState === 'WARM') && log.filter(l => /\[host\] loading /.test(l)).length === 1, `${started.launchState}, ${log.filter(l => /\[host\] loading /.test(l)).length} load(s)`);
    check('cold boot: LostCityNative is the Android one', await page.eval(`window.LostCityNative?.platform === 'android' && window.LostCityNative.settings?.bots === 0 && typeof window.LostCityNativeBridge?.native?.postMessage === 'function'`));
    if (dismissImmersiveSheet()) console.log('   (dismissed the "Viewing full screen" sheet)');
    shot('title');

    // ------------------------------------------------------------------------------------------------ login, walk
    if (wanted('login') || wanted('walk') || wanted('save') || wanted('back') || wanted('home') || wanted('crash')) {
        await login(USER, { newUser: true });
        await acceptDesigner();
        await sleep(1000);
        shot('ingame');
        const awake = await debug('idle-timer');
        check('in the world: the screen is kept on', awake === true, JSON.stringify(awake));
        const session = await debug('session');
        check('in the world: both side edges are kept from the back gesture', session?.gestureExclusion === 2, JSON.stringify(session));
    }

    if (wanted('walk')) {
        const before = (await state()).pos;
        // a touch on the minimap a few tiles south-east (autotest.js's classic (645, 93), on the HUD's round minimap)
        const rect = await page.eval(`(() => { const r = document.getElementById('surface-map').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
        await page.touch(rect.x + (95 * rect.w) / 172, rect.y + (89 * rect.h) / 156);
        const moved = await waitFor(async () => JSON.stringify((await state()).pos) !== JSON.stringify(before), 8000);
        await sleep(2500);
        check('walk: a touch on the minimap moves the character', moved.ok, `${JSON.stringify(before)} → ${JSON.stringify((await state()).pos)}`);
        shot('walked');
    }

    // ------------------------------------------------------------------------------------------------ save, back
    if (wanted('save') || wanted('back')) {
        d.clearLog();
        await saveNow('save');
        shot('settings-saved');
        const listing = files('players/main');
        check('save: the character is on disk', listing.includes(`${USER}.sav`), listing.trim().replace(/\n/g, ' | '));
        const put = d.log().find(l => l.includes(`PUT players/main/${USER}.sav`) && l.includes('→ 204'));
        check('save: written through X-LC-Body (PUT … → 204)', !!put, put?.replace(/^.*\[save\] /, '') ?? 'no PUT line');

        // Back with Settings open does nothing (docs/ANDROID.md §1 Back): Settings stays, its Close closes it
        d.clearLog();
        d.adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        const ignored = await waitLog(/\[host\] back: ignored/, 3000);
        await sleep(500);
        check('back: Back with Settings open does nothing (Settings stays open)', ignored.ok && (await state()).settingsOpen);
        await page.tapElement('#settings-close');
        const closed = await waitFor(async () => !(await state()).settingsOpen, 3000);
        check('back: Settings\' Close closes it', closed.ok);
    }

    if (wanted('back')) {
        // the options menu: a long-press on the world opens it, Back leaves it open
        const size = await page.eval('({ w: innerWidth, h: innerHeight })');
        let menu = false;
        for (const [fx, fy] of [[0.5, 0.42], [0.42, 0.5], [0.58, 0.55]]) {
            await page.touch(size.w * fx, size.h * fy, 900);
            menu = (await waitFor(async () => (await state()).menuOpen, 1500)).ok;
            if (menu) break;
        }
        check('back: a long-press opens the options menu', menu);
        if (menu) {
            shot('options-menu');
            d.clearLog();
            d.adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
            const ignored = await waitLog(/\[host\] back: ignored/, 3000);
            await sleep(500);
            check('back: Back with the options menu open does nothing (the menu stays)', ignored.ok && (await state()).menuOpen);
            await page.eval(`window.LostCityHost.keyboard.pressKey('Escape', true), window.LostCityHost.keyboard.pressKey('Escape', false)`);
            const gone = await waitFor(async () => !(await state()).menuOpen, 3000);
            check('back: Escape still closes the options menu (a hardware keyboard)', gone.ok);
        }
        // nothing open: Back does nothing (the activity stays, the page stays, still in the world)
        await page.eval('window.__smokeMark = "back-" + Math.random()');
        const mark = (await state()).mark;
        d.clearLog();
        d.adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        await sleep(1500);
        const s = await state();
        const top = d.adbQuiet('shell', 'dumpsys', 'activity', 'activities').split('\n').find(l => /topResumedActivity|mResumedActivity/.test(l)) ?? '';
        const backLine = d.log().find(l => /\[host\] back: ignored/.test(l));
        check('back: with nothing open Back does nothing', !!backLine && s.mark === mark && s.ingame && !s.settingsOpen && top.includes(PKG), `${backLine?.replace(/^.*\[host\] /, '') ?? 'no back line'}; ${top.trim()}`);
    }

    // ------------------------------------------------------------------------------------------------ home
    if (wanted('home')) {
        await page.eval('window.__smokeMark = "home-" + Math.random()');
        const mark = (await state()).mark;
        const serialBefore = (await debug('session'))?.pageSerial;
        d.clearLog();
        d.adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
        const flushed = await waitLog(/flush #\d+ (done|FAILED)/, 10000);
        const paused = await waitLog(/web view paused/, 5000);
        await sleep(2000);
        const homeLog = d.log();
        check('home: pause flushed (the saves written), no second flush for background', /done/.test(flushed.value ?? '') && homeLog.some(l => /background: (already paused and saved|flush #\d+ already in flight)/.test(l)), homeLog.filter(l => /\[life\]/.test(l)).map(l => l.replace(/^.*\[life\] /, '')).join(' | '));
        check('home: the WebView is paused while stopped', paused.ok);
        d.clearLog();
        const relaunch = launch({ stop: false });
        const resumed = await waitLog(/(resume|foreground) → ok/, 10000);
        await sleep(1000);
        await reconnect();
        const s = await state();
        const lifeLog = d.log().filter(l => /\[life\]|web view resumed/.test(l)).map(l => l.replace(/^.*\] /, ''));
        check('home: relaunch answered foreground/resume ok', resumed.ok, lifeLog.join(' | '));
        const serialAfter = (await debug('session'))?.pageSerial;
        check('home: relaunch kept the same page (no reload), still in the world', s.mark === mark && s.ingame && serialAfter === serialBefore && relaunch.launchState !== 'COLD', `${relaunch.launchState}, mark ${s.mark === mark ? 'kept' : 'lost'}, serial ${serialBefore} → ${serialAfter}`);
        shot('after-home');
    }

    // ------------------------------------------------------------------------------------------------ recreate
    if (wanted('recreate')) {
        // (Activity.recreate() through the debug hook: the path of "Don't keep activities" and of a configuration change
        // the manifest does not list; the developer setting itself cannot be switched from adb on API 37)
        await page.eval('window.__smokeMark = "recreate-" + Math.random()');
        const { mark, ingame } = await state();
        d.clearLog();
        await debug('recreate');
        const reattached = await waitLog(/activity re-attached; the page keeps running/, 8000);
        await sleep(1000);
        await reconnect();
        const s = await state();
        const lines = d.log();
        const reloaded = lines.some(l => /\[host\] loading /.test(l));
        const detached = lines.some(l => /activity detached; the page keeps running/.test(l));
        check('recreate: a new activity re-attaches the WebView, the page keeps running', detached && reattached.ok && !reloaded && s.mark === mark && s.ingame === ingame, `${detached ? 'detached' : 'not detached'}, ${reattached.ok ? 're-attached' : 'no re-attach line'}${reloaded ? ', reloaded' : ''}, mark ${s.mark === mark ? 'kept' : 'lost'}`);
        const awake = ingame ? await debug('idle-timer') : null;
        if (ingame) check('recreate: the new window keeps the screen on in the world', awake === true);
        shot('recreated');
    }

    // ------------------------------------------------------------------------------------------------ settings
    if (wanted('settings')) {
        const value = Math.floor(Math.random() * 1e6);
        d.clearLog();
        await page.eval(`window.LostCityNativeBridge.native.postMessage({ type: 'settings', values: { smokeKey: ${value} } })`);
        const saved = await waitLog(/settings saved \(.*smokeKey/, 5000);
        const kept = await debug('settings');
        check('settings: {type:\'settings\'} is kept natively', saved.ok && kept?.smokeKey === value, saved.value?.replace(/^.*\[host\] /, '') ?? 'no log line');
        await page.eval(`window.LostCityNativeBridge.native.postMessage({ type: 'settings', values: { smokeBig: 'x'.repeat(70000) } })`);
        const refused = await waitLog(/settings rejected: values must be a JSON object under 64 KB/, 5000);
        check('settings: more than 64 KB is refused, the old values kept', refused.ok && (await debug('settings'))?.smokeBig === undefined);
        // injected again for the next document (a reload, as after a renderer crash)
        const { ingame } = await state();
        if (!ingame) {
            await debug('reload');
            await sleep(1500);
            await reconnect();
            await bootToTitle('settings: reloaded');
            check('settings: the next page gets them in LostCityNative.settings', (await page.eval('window.LostCityNative.settings.smokeKey')) === value);
        }
        await page.eval(`window.LostCityNativeBridge.native.postMessage({ type: 'settings', values: { smokeKey: null } })`);
        await sleep(300);
        check('settings: null removes a key', (await debug('settings'))?.smokeKey === undefined);
    }

    // ------------------------------------------------------------------------------------------------ memory
    if (wanted('memory')) {
        d.clearLog();
        d.adb('shell', 'am', 'send-trim-memory', PKG, 'RUNNING_CRITICAL');
        const answered = await waitLog(/memoryWarning → /, 6000);
        check('memory: a trim is passed to LostCityHost.memoryWarning()', /memoryWarning → ok/.test(answered.value ?? ''), answered.value?.replace(/^.*\[host\] /, '') ?? 'no answer');
    }

    // ------------------------------------------------------------------------------------------------ rotate
    if (wanted('rotate')) {
        const CUTOUT = 'com.android.internal.display.cutout.emulation.tall';
        const SAFE = `(() => { const p = document.createElement('div'); p.style.cssText = 'position:fixed;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'; document.body.appendChild(p); const s = getComputedStyle(p); const r = { top: parseFloat(s.paddingTop), right: parseFloat(s.paddingRight), bottom: parseFloat(s.paddingBottom), left: parseFloat(s.paddingLeft), w: innerWidth, h: innerHeight }; p.remove(); return r; })()`;
        d.adbQuiet('shell', 'cmd', 'overlay', 'enable-exclusive', '--category', CUTOUT);
        await sleep(3000);
        await page.eval('window.__smokeMark = "rotate-" + Math.random()');
        const { mark, ingame: wasInGame } = await state();
        d.clearLog();
        const left = await waitFor(async () => {
            const s = await page.eval(SAFE);
            return s.left > 0 ? s : null;
        }, 8000);
        shot('cutout-left');
        rotate('reverse');
        const right = await waitFor(async () => {
            const s = await page.eval(SAFE);
            return s.right > 0 && s.left === 0 ? s : null;
        }, 8000);
        await sleep(1000);
        shot('reverse-landscape');
        const s = await state();
        const recreated = d.log().some(l => /starting the game session|activity re-attached|\[host\] loading /.test(l));
        check('rotate: reverse landscape keeps the page (no reload, no new activity)', s.mark === mark && s.ingame === wasInGame && !recreated, `mark ${s.mark === mark ? 'kept' : 'lost'}${recreated ? ', recreated' : ''}`);
        check('rotate: the safe area follows the cutout to the other side', left.ok && right.ok, `landscape ${JSON.stringify(left.value)} → reverse ${JSON.stringify(right.value)}`);
        rotate('landscape');
        d.adbQuiet('shell', 'cmd', 'overlay', 'disable', CUTOUT);
        await sleep(2500);
    }

    // ------------------------------------------------------------------------------------------------ crash
    if (wanted('crash')) {
        await page.eval('window.__smokeMark = "crash-" + Math.random()');
        d.clearLog();
        const killed = await debug('renderer-kill');
        check('crash: the debug hook ends the renderer', killed === true, JSON.stringify(killed));
        const gone = await waitLog(/WebView renderer gone/, 10000);
        const reloading = await waitLog(/loading .*\(web content process terminated\)/, 10000);
        check('crash: the app noticed, made a new WebView and reloads', gone.ok && reloading.ok, gone.value?.replace(/^.*\[host\] /, '') ?? 'no renderer-gone line');
        await reconnect();
        await bootToTitle('crash: reloaded');
        const s = await state();
        check('crash: a fresh page (the old one is gone)', s.mark === null);
        shot('after-crash');
        const index = await page.eval(`fetch('save-index').then(r => r.json())`);
        check('crash: the character is still saved', index.some(e => e.path === `players/main/${USER}.sav` && e.size > 0), index.map(e => `${e.path} ${e.size}`).join(', '));
        const cont = await page.eval(`document.getElementById('continue-name')?.textContent ?? ''`);
        check('crash: the title offers to continue as the character', cont.toLowerCase() === USER.toLowerCase(), cont);
    }

    // ------------------------------------------------------------------------------------------------ crashloop
    if (wanted('crashloop')) {
        // (the crash phase was the first of three within two minutes; without it, three kills here)
        const kills = wanted('crash') ? 2 : 3;
        d.clearLog();
        for (let i = 0; i < kills; i++) {
            await waitFor(() => page.eval('typeof window.LostCityNativeBridge?.native?.postMessage === "function" && !!window.LostCityHost'), 15000);
            await debug('renderer-kill');
            await waitLog(new RegExp(`renderer gone .*${i + 1 + (3 - kills)}× in 2 min`), 10000);
            if (i < kills - 1) {
                await sleep(1500);
                await reconnect();
            }
        }
        page?.close();
        page = null;
        const stopped = await waitLog(/WebView renderer gone .*3× in 2 min/, 5000);
        await sleep(1000);
        const ui = d.uiDump();
        shot('crash-loop');
        const loaded = d.log().filter(l => /\[host\] loading /.test(l)).length;
        check('crashloop: three crashes in two minutes stop at the error screen (no fourth load)', stopped.ok && /cover_retry/.test(ui) && /Try again/.test(ui) && loaded === kills - 1, `${loaded} reload(s); ${/stopped unexpectedly 3 times/.test(ui) ? 'message shown' : 'no message'}`);
        d.clearLog();
        const tapped = d.tapNative(/^Try again$/);
        const retried = await waitLog(/loading .*\(retry after repeated crashes\)/, 8000);
        check('crashloop: Try again reloads the game', tapped && retried.ok);
        await reconnect();
        await bootToTitle('crashloop: reloaded');
    }

    // ------------------------------------------------------------------------------------------------ nowebview
    if (wanted('nowebview')) {
        // (after crashloop's Try again, which cleared the crash count: this kill is the first of a new two minutes)
        if (!page) await reconnect();
        d.clearLog();
        await debug('webview-fail', { count: 1 });
        await debug('renderer-kill');
        const failed = await waitLog(/the WebView could not be created/, 10000);
        page?.close();
        page = null;
        await sleep(1000);
        const ui = d.uiDump();
        shot('no-webview');
        check('nowebview: no new WebView after a renderer death: the error screen with Try again', failed.ok && /cover_retry/.test(ui) && /Try again/.test(ui) && /missing or disabled/.test(ui), failed.value?.replace(/^.*\[host\] /, '') ?? 'no log line');
        d.clearLog();
        const tapped = d.tapNative(/^Try again$/);
        const retried = await waitLog(/loading .*\(retry after the WebView could not be made\)/, 8000);
        check('nowebview: Try again makes a new WebView and loads the game in it', tapped && retried.ok, retried.value?.replace(/^.*\[host\] /, '') ?? `tapped ${tapped}, no load`);
        await reconnect();
        await bootToTitle('nowebview: reloaded');
    }

    // ------------------------------------------------------------------------------------------------ bots
    if (wanted('bots')) {
        d.clearLog();
        launch({ settings: { bots: 25 } });
        await reconnect();
        await bootToTitle('bots 25: boot', 180000);
        const booted = d.log().find(l => /engine booted/.test(l)) ?? '';
        check('bots 25: the engine with the bots is running', /engine-bots\.js with 25 bots/.test(booted), booted.replace(/^.*\[js:\w+\] /, ''));
        dismissImmersiveSheet();
        await login(USER, { newUser: false });
        await sleep(3000);
        d.clearLog();
        await saveNow('bots 25');
        const put = await waitLog(/PUT bots\/main\/bots\.sav \d+ B → 204/, 8000);
        check('bots 25: bots.sav written through X-LC-Body (PUT … → 204)', put.ok, put.value?.replace(/^.*\[save\] /, '') ?? 'no PUT line');
        const listing = files('bots/main');
        check('bots 25: bots.sav is on disk', /bots\.sav/.test(listing), listing.trim().replace(/\n/g, ' | '));
        await page.tapElement('#settings-close');
        shot('bots');
    }

    // ------------------------------------------------------------------------------------------------ update
    if (wanted('update')) {
        // (in the world from the bots phase, or on the title: either way the app is on screen)
        // first what PackageUpdateController sends, on its own: a launch with FLAG_ACTIVITY_NEW_TASK | CLEAR_TASK while
        // the game is in front, so a new activity starts before the old one stops
        d.clearLog();
        d.adb('shell', 'am', 'start', '-W', '-n', ACTIVITY, '-f', '0x10008000');
        await sleep(2500);
        await reconnect();
        const cleared = await debug('session');
        const ignored = d.log().some(l => /an older activity stopped after a newer one took the game: ignored/.test(l));
        const pausedAfterClear = d.log().some(l => /web view paused \(timers stopped\)|background → /.test(l));
        check('update: a CLEAR_TASK launch in front (a new activity before the old one stops): the old one\'s late onStop is ignored, the game keeps running', ignored && !pausedAfterClear && cleared?.started === true && cleared.resumed === true && cleared.webViewPaused === false, JSON.stringify({ ignored, pausedAfterClear, started: cleared?.started, resumed: cleared?.resumed, webViewPaused: cleared?.webViewPaused }));
        const apk = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
        page?.close();
        page = null;
        d.clearLog();
        d.adb('install', '-r', apk);
        launch(); // (deploy.sh's launch, right after its install)
        await sleep(6000); // (the system's relaunch, if any, comes a moment after the install finishes)
        await reconnect();
        await bootToTitle('update: after the install and launch', 120000);
        dismissImmersiveSheet();
        await sleep(1500);
        const session = await debug('session');
        const lines = d.log();
        const raced = lines.some(l => /an older activity stopped after a newer one took the game: ignored/.test(l));
        const pausedInFront = lines.some(l => /web view paused \(timers stopped\)/.test(l));
        check('update: the game is in front and running (started, resumed, the WebView not paused)', session?.started === true && session.resumed === true && session.webViewPaused === false && !pausedInFront, JSON.stringify({ ...session, raced, pausedInFront }));
        const cont = await page.eval(`document.getElementById('continue-name')?.textContent ?? ''`);
        check('update: the saves are kept (the title offers to continue as the character)', cont.toLowerCase() === USER.toLowerCase(), cont);
    }

    // ------------------------------------------------------------------------------------------------ floor
    if (wanted('floor')) {
        page?.close();
        page = null;
        d.clearLog();
        launch({ extras: ['--ei', 'lostcity.webViewFloor', '999'] });
        const refused = await waitLog(/cannot start: Android System WebView is too old/, 10000);
        await sleep(1000);
        const ui = d.uiDump();
        shot('webview-too-old');
        check('floor: a WebView below the floor gets the native error screen with Update', refused.ok && /resource-id="io\.github\.purexyz\.scape2004:id\/cover_retry"/.test(ui) && /Update/.test(ui), refused.value?.replace(/^.*\[host\] /, '') ?? 'no log line');
        // Update: the Play Store (or the browser) comes to the front; back in the app the WebView is checked again
        const resumedActivity = () => /(?:topResumedActivity|mResumedActivity)[=:][^\n]*/.exec(d.adbQuiet('shell', 'dumpsys', 'activity', 'activities'))?.[0] ?? '';
        d.clearLog();
        const tappedUpdate = d.tapNative(/^Update$/);
        await sleep(3000);
        const store = resumedActivity();
        d.clearLog(); // (what the button itself logged)
        launch({ stop: false }); // (back: the same activity, singleTask)
        const rechecked = await waitLog(/cannot start: Android System WebView is too old/, 8000);
        await sleep(500);
        check('floor: Update leaves for the store; back in the app the WebView is checked again (still too old: the screen stays)', tappedUpdate && store && !store.includes(PKG) && rechecked.ok && /cover_retry/.test(d.uiDump()), { store: store.replace(/^.*\{/, '{'), rechecked: rechecked.ok });
        // the WebView updated meanwhile (the floor lowered by a new intent): back in front, the game starts in this process
        d.clearLog();
        d.adb('shell', 'am', 'start', '-W', '-n', ACTIVITY, '--ei', 'lostcity.webViewFloor', '122');
        const started = await waitLog(/loading .*\(the WebView passed its check again\)/, 10000);
        check('floor: once the WebView passes, coming back makes it and loads the game (no restart needed)', started.ok && !d.log().some(l => /\[app\] Lost City /.test(l)), started.value?.replace(/^.*\[host\] /, '') ?? 'no load');
        await reconnect();
        await bootToTitle('floor: started after the check');
        d.adb('shell', 'am', 'force-stop', PKG);
        d.adbQuiet('shell', 'am', 'force-stop', 'com.android.vending');
        d.adbQuiet('shell', 'am', 'force-stop', 'com.android.chrome');
    }
} catch (err) {
    check('the run finished', false, err.stack ?? String(err));
} finally {
    page?.close();
    d.adbQuiet('forward', '--remove', `tcp:${d.devtoolsPort}`);
    d.adbQuiet('shell', 'settings', 'put', 'system', 'user_rotation', '1');
    d.adbQuiet('shell', 'svc', 'power', 'stayon', 'false');
    results.finished = new Date().toISOString();
    results.failures = failures;
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
    console.log(`\n${results.checks.length - failures}/${results.checks.length} checks passed; screenshots and results.json in ${path.relative(process.cwd(), OUT) || OUT}`);
    process.exitCode = failures ? 1 : 0;
}
