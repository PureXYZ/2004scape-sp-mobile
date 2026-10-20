// The keyboard on the real app (docs/ANDROID.md §4.1): Gboard and hardware keys on
// an emulator or phone, driven over adb (key taps on Gboard, `input keyevent`) and CDP (the page's state and what reaches
// LostCityHost.keyboard). It needs a debug build (the keyboard's debug hooks and WebContents debugging).
//
//   node android/test/keyboard.mjs [--serial emulator-5554] [--no-build] [--no-install] [--only a,b] [--skip a,b]
//
// The test turns settings secure show_ime_with_hard_keyboard on (Gboard beside a hardware keyboard; the AVD has one) and
// puts it back at the end. Gboard's keys are tapped where its landscape layout puts them on the AVD (a toolbar, a number
// row, then QWERTY), measured from the top of the IME. For the bar-only checks every IME is disabled for a moment (the
// AVD shows Gboard beside its hardware keyboard whatever the setting says), and enabled again, the default set, at the end.
//
// Phases (screenshots and results.json in android/build/keyboard/; the login always runs):
//   idle      at the title: the bridge's view holds focus, no editor, the WebView never focused
//   login     the login form brings up Gboard (VISIBLE_PASSWORD | NO_SUGGESTIONS, Go, no extract UI), the bar on it, the form
//             lifted (keyboard.frame = IME + bar, the IME's duration and curve); typed on Gboard, its Backspace, a refused
//             '.' (warning haptic, flash), the password masked, Gboard's Go logs in, the keyboard goes, the navigation bar too
//   chat      the chat line: Gboard typing, Send empties the bar, the '::' chip (whenEmpty), the :: rule for '~', a held
//             hardware Backspace repeating, a refused '{', a paste (quotes, dashes, line breaks), Ctrl+V, a composing IME
//             through the live InputConnection (and the bar's Send ending one); the chatbox lifted above the keyboard
//   dismiss   a tap on the game leaves the focus alone; the system Back closes Gboard → dismissed(); Gboard's hide key too
//   amount    an amount prompt: the number pad, amount chips (one submits), Cancel cancels the prompt
//   hardware  keys with no keyboard asked for: letters, Space (as text), Backspace, Enter, a held arrow (the camera turns),
//             Escape (closes Settings), Tab, Control, F1, Home, PageDown, Space continuing a dialogue; with only the bar (no
//             IME): typing, Enter, Back doing nothing (the bar's hide button closes it); a volume key is the system's
//   focus     a native text field borrows focus and gives it back (KeyboardFocus); the notification shade and HOME keep
//             the keyboard (and the page's chatbox where it was)
//   cutout    with a display cutout the bar keeps 12/6 dp from the safe edges (equal sides) on either side; a 180° turn keeps the keyboard
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ACTIVITY, PKG, device, sleep } from './lib/adb.mjs';

const ANDROID = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ANDROID, 'build', 'keyboard');
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
for (const old of fs.readdirSync(OUT)) if (old.endsWith('.png')) fs.rmSync(path.join(OUT, old));
const d = device(SERIAL);
const results = { serial: SERIAL, started: new Date().toISOString(), checks: [] };
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

async function waitFor(fn, timeoutMs, intervalMs = 120) {
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

let page = null;
const client = expression => page.eval(`(() => { const c = window.__client; return ${expression}; })()`);

async function debug(action, extra = {}) {
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

const kb = () => debug('keyboard-state');

/** Records what reaches LostCityHost.keyboard (the calls native makes through __lcCall), from now on. */
async function record() {
    await page.eval(`(() => {
        const k = window.LostCityHost.keyboard;
        if (!k.__recorded) {
            for (const name of ['insertText', 'deleteBackward', 'submit', 'cancel', 'frame', 'dismissed', 'pressKey']) {
                const original = k[name];
                k[name] = function (...args) { window.__kbdRec.push([name, ...args]); return original.apply(this, args); };
            }
            k.__recorded = true;
        }
        window.__kbdRec = [];
    })()`);
}
const recorded = () => page.eval('window.__kbdRec ?? []');
const lastFrame = async () => (await recorded()).filter(e => e[0] === 'frame').at(-1) ?? null;
const text = events => events.filter(e => e[0] === 'insertText').map(e => e[1]).join('');
const pressed = (events, key) => events.some(e => e[0] === 'pressKey' && e[1] === key && e[2] === true) && events.some(e => e[0] === 'pressKey' && e[1] === key && e[2] === false);

async function reconnect(timeoutMs = 30000) {
    page?.close();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        page = await d.connect({ timeoutMs: Math.max(1000, deadline - Date.now()) });
        try {
            if ((await page.eval('1 + 1')) === 2) return page;
        } catch {}
        page.close();
        if (Date.now() > deadline) throw new Error('no live page target');
        await sleep(500);
    }
}

const waitLog = (pattern, timeoutMs = 5000) => waitFor(() => d.log().find(line => pattern.test(line)), timeoutMs, 200);
const logLines = pattern => d.log().filter(line => pattern.test(line)).map(line => line.replace(/^.*?\] /, ''));

// ---------------------------------------------------------------------------------------------------- the screen, Gboard

const SIZE = /(\d+)x(\d+)/.exec(d.adbQuiet('shell', 'wm', 'size').split('\n').filter(l => l.includes('size')).at(-1) ?? '1080x2400');
const SCREEN_W = Math.max(+SIZE[1], +SIZE[2]);
const SCREEN_H = Math.min(+SIZE[1], +SIZE[2]);
const DENSITY = Number(/(\d+)/.exec(d.adbQuiet('shell', 'wm', 'density').split('\n').filter(l => l.includes('density')).at(-1) ?? '420')[1]) / 160;

/**
 * Gboard's text layout in landscape on this emulator, measured from its top edge (dp): its toolbar, a number row (the
 * VISIBLE_PASSWORD layout has one), q-p, a-l (half a key in), shift z-m backspace, then ?123 , space . action, and its
 * own hide key under the left end.
 */
const GBOARD_ROWS = { digits: 62, q: 99.4, a: 140.6, z: 183.2, bottom: 224.4, hide: 270.9 };

async function gboardTop() {
    const state = await kb();
    return SCREEN_H - Math.round(state.imeHeight * DENSITY);
}

async function gboardTap(keys) {
    const top = await gboardTop();
    const key = SCREEN_W / 10;
    const y = row => top + GBOARD_ROWS[row] * DENSITY;
    const where = ch => {
        const rows = [['digits', '1234567890', 0.5], ['q', 'qwertyuiop', 0.5], ['a', 'asdfghjkl', 1], ['z', 'zxcvbnm', 2]];
        for (const [row, letters, offset] of rows) {
            if (letters.includes(ch)) return [key * (letters.indexOf(ch) + offset), y(row)];
        }
        switch (ch) {
            case ' ': return [SCREEN_W / 2, y('bottom')];
            case '.': return [key * 8, y('bottom')];
            case ',': return [key * 2, y('bottom')];
            case '\b': return [key * 9.25, y('z')];
            case '\n': return [key * 9.25, y('bottom')];
            case 'hide': return [key * 0.47, y('hide')];
        }
        throw new Error(`no Gboard key for ${JSON.stringify(ch)}`);
    };
    for (const ch of keys === 'hide' ? ['hide'] : [...keys]) {
        const [x, yy] = where(ch);
        d.adb('shell', 'input', 'tap', String(Math.round(x)), String(Math.round(yy)));
        await sleep(160);
    }
}

/** Taps one of the bar's views (KeyboardAccessoryBar debug rects, screen px). */
async function tapBar(name, index = 0) {
    const views = (await kb()).views ?? {};
    const rect = name === 'chip' ? views.chips?.[index] : views[name];
    if (!rect) return false;
    d.adb('shell', 'input', 'tap', String(Math.round(rect[0] + rect[2] / 2)), String(Math.round(rect[1] + rect[3] / 2)));
    return true;
}

const keyevent = (...keys) => d.adb('shell', 'input', 'keyevent', ...keys);

/**
 * The app's touch vibrations in dumpsys vibrator_manager's recent history that started at or after `since` (the history
 * is capped, so it is counted by time, as shell.mjs does).
 */
function touchVibrations(since) {
    const recent = d.adbQuiet('shell', 'dumpsys', 'vibrator_manager').split(/Recent vibrations:/)[1]?.split(/Aggregated vibration history:/)[0] ?? '';
    return recent.split('\n').filter(line => line.includes(PKG) && /usage: TOUCH/.test(line) && line.trim().slice(0, 18) >= since);
}

/** What the page's layout gives the keyboard: the lifted chatbox, the login form's canvas. */
const PAGE_LAYOUT = `(() => {
    const r = id => { const e = document.getElementById(id); if (!e || e.hidden) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height }; };
    return { inner: innerHeight, chat: r('surface-chat'), canvas: r('canvas'), keyboardShown: window.lcHost.keyboard.isShown() };
})()`;

const always = [];
/** Focus never goes to the WebView, and the bridge's view keeps it (checked at every phase). */
async function checkFocus(label) {
    const s = await kb();
    const ok = s.isFirstResponder === true && s.webViewFocused === false && s.focused === 'KeyboardBridgeView';
    always.push(ok);
    if (!ok) check(`${label}: the bridge's view has focus, never the WebView`, false, { focused: s.focused, webViewFocused: s.webViewFocused, isFirstResponder: s.isFirstResponder });
    return s;
}

/** The IME service in landscape: not fullscreen, no extract editor (dumpsys input_method). */
function imeNotFullscreen() {
    const dump = d.adbQuiet('shell', 'dumpsys', 'input_method');
    const service = /inFullscreenMode=(\w+)/.exec(dump.split('\n').filter(l => /^\s+inFullscreenMode=|mInputShown|isInputViewShown/.test(l)).join('\n'));
    const editor = /inputType=0x80091 imeOptions=(0x[0-9a-f]+)/.exec(dump);
    return { fullscreen: service?.[1] ?? '?', imeOptions: editor?.[1] ?? null };
}

// ---------------------------------------------------------------------------------------------------- build, install, set up

if (!argv.includes('--no-build')) {
    console.log('building the debug APK…');
    execFileSync(path.join(ANDROID, 'gradlew'), [':app:assembleDebug', '--console=plain', '-q'], { cwd: ANDROID, stdio: 'inherit' });
}
if (!argv.includes('--no-install')) {
    const apk = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
    console.log(d.install(apk));
}
const showImeBefore = d.adbQuiet('shell', 'settings', 'get', 'secure', 'show_ime_with_hard_keyboard').trim();
const IMES = d.adbQuiet('shell', 'ime', 'list', '-s').split('\n').map(l => l.trim()).filter(l => l.includes('/'));
const DEFAULT_IME = d.adbQuiet('shell', 'settings', 'get', 'secure', 'default_input_method').trim();
function restoreImes() {
    for (const ime of IMES) d.adbQuiet('shell', 'ime', 'enable', ime);
    if (DEFAULT_IME.includes('/')) d.adbQuiet('shell', 'ime', 'set', DEFAULT_IME);
}
d.adbQuiet('shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1');
d.adbQuiet('shell', 'settings', 'put', 'secure', 'immersive_mode_confirmations', 'confirmed');
d.adbQuiet('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
d.adbQuiet('shell', 'settings', 'put', 'system', 'user_rotation', '1');
if (SERIAL.startsWith('emulator-')) d.adbQuiet('emu', 'sensor', 'set', 'acceleration', '9.81:0:0');
d.adbQuiet('shell', 'svc', 'power', 'stayon', 'true');
d.adbQuiet('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
const USER = `kbd${Date.now() % 100000}`;
results.user = USER;

try {
    d.adb('shell', 'pm', 'clear', PKG);
    d.clearLog();
    // verbose: the per-key lines (insertText, pressKey, refused characters, the haptic) are checked below
    d.adb('shell', 'am', 'start', '-W', '-S', '-n', ACTIVITY, '--es', 'lostcity.settings', `'${JSON.stringify({ seenHowToPlay: true, bots: 0, jmod: true })}'`, '--ez', 'lostcity.verbose', 'true');
    await reconnect();
    const title = await waitFor(() => client('!!c && !!c.titleFlames && c.lastProgressPercent === 100 && window.LostCityHost?.engineState === "ready"'), 120000, 200);
    check('the title screen is up and the world ready', title.ok, `${title.ms} ms`);
    if (d.tapNative(/^Got it$/i)) console.log('   (dismissed the "Viewing full screen" sheet)');
    await sleep(500);

    // ------------------------------------------------------------------------------------------------ idle
    if (wanted('idle')) {
        const s = await checkFocus('idle');
        check('idle: the bridge holds focus with no editor (hardware keys only), the WebView unfocused', s.isFirstResponder && !s.requested && s.inputView === 'none (hardware only)' && s.editor === false && s.webViewFocused === false && !s.barVisible, { focused: s.focused, inputView: s.inputView, editor: s.editor, bar: s.barVisible });
    }

    // ------------------------------------------------------------------------------------------------ login
    {
        await record();
        const canvasBefore = (await page.eval(PAGE_LAYOUT)).canvas;
        await page.tapGame(302, 291); // New User: the login form, and the keyboard comes up by itself for the username
        await waitFor(() => client('c.loginscreen === 2'), 5000);
        const up = await waitFor(async () => {
            const s = await kb();
            return s.requested && s.imeVisible && s.imeHeight > 100 && !s.composing ? s : null;
        }, 6000);
        await sleep(700);
        let s = await checkFocus('login');
        check('login: the username field brings up Gboard on the bridge (an editor: VISIBLE_PASSWORD | NO_SUGGESTIONS, Go, "Log in")', up.ok && s.kind === 'login-user' && s.keyboardType === 0x80091 && s.returnKeyType === 2 && s.submitTitle === 'Log in' && s.editor === true && s.inputView === 'system keyboard', { kind: s.kind, inputType: s.keyboardType?.toString(16), action: s.returnKeyType, ime: s.imeHeight, title: s.submitTitle });
        const ime = imeNotFullscreen();
        check('login: no fullscreen or extract UI in landscape (NO_EXTRACT_UI | NO_FULLSCREEN), Gboard under half the screen… or so', ime.fullscreen === 'false' && ime.imeOptions && (parseInt(ime.imeOptions, 16) & 0x12000000) === 0x12000000 && s.imeHeight < SCREEN_H / DENSITY * 0.8, { ...ime, imeHeightDp: s.imeHeight });
        const frame = await lastFrame();
        const expected = Math.round(s.imeHeight + 52);
        // (the lift comes with the IME's animation; Gboard sometimes comes up 9 dp taller first and settles without an
        // animation, which the page follows at once: then a last frame of 0 s after the animated one)
        const frames = (await recorded()).filter(e => e[0] === 'frame');
        const lift = frames.find(e => e[1] > 52);
        // With a hardware keyboard (the AVD has one) the bar alone is reported when no IME animation has begun after
        // 300 ms, since the IME may never come (a phone's on-screen keyboard is off beside a hardware one by default);
        // Gboard's first show after a cold boot can take longer, and then a bar-only frame (52 dp, 0 s) comes first.
        const early = lift ? frames.slice(0, frames.indexOf(lift)) : [];
        const barFirst = early.length === 0 || (s.hardKeyboard === true && early.every(e => e[1] === 52 && e[2] === 0));
        check('login: keyboard.frame = the IME + the 52 dp bar, with the IME\'s duration and curve', frame && frame[1] === expected && s.coveredHeight === expected && lift && lift[2] > 0.1 && lift[2] < 0.6 && barFirst && frames.every(e => e[3] === 'cubic-bezier(0.2, 0, 0, 1)') && (frame === lift || frame[2] === 0 || frame[2] === lift[2]), { frames, expected, coveredHeight: s.coveredHeight, hardKeyboard: s.hardKeyboard });
        const barTop = s.barTop;
        check('login: the bar rides on top of Gboard', s.barVisible && Math.abs(barTop + s.barHeight - (SCREEN_H / DENSITY - s.imeHeight)) < 1.5, { barTop, barHeight: s.barHeight, imeTop: SCREEN_H / DENSITY - s.imeHeight });
        // host.js layout(): the form (game y 205 to 340) above the keyboard, its top kept on the screen when it cannot fit
        const layout = await page.eval(PAGE_LAYOUT);
        const scale = layout.canvas.height / 503;
        const lifted = Math.min(canvasBefore.top, Math.max(layout.inner - frame?.[1] - 6 - 340 * scale, 6 - 205 * scale));
        check('login: the page lifts the login form for the keyboard (host.js\'s rule with keyboard.frame\'s height)', frame?.[1] > 0 && Math.abs(layout.canvas.top - lifted) < 2 && layout.canvas.top < canvasBefore.top, { before: Math.round(canvasBefore.top), after: Math.round(layout.canvas.top), expected: Math.round(lifted) });
        shot('login-gboard');

        d.clearLog();
        await gboardTap(`${USER}x`);
        await waitFor(() => client(`c.loginUser === ${JSON.stringify(USER + 'x')}`), 3000);
        await gboardTap('\b');
        const typed = await waitFor(() => client(`c.loginUser === ${JSON.stringify(USER)}`), 3000);
        s = await kb();
        check('login: Gboard types the name, its Backspace deletes (the bar and the IME\'s mirror follow)', typed.ok && s.displayText === USER && s.editable === USER, { loginUser: await client('c.loginUser'), bar: s.displayText, editable: s.editable });
        const before = s.rejections;
        const since = d.adbQuiet('shell', "date '+%m-%d %H:%M:%S.%3N'").trim(); // (the history's own time format)
        await gboardTap('.');
        s = await kb();
        const flashing = s.flashing;
        await sleep(500);
        const refusedLog = logLines(/refused characters \(charset name, max 12\)/);
        // the Haptics component plays it (its verbose line, not "no haptics component") and the vibrator gets it as a
        // touch vibration (dumpsys vibrator_manager's recent history)
        const haptic = logLines(/\[haptic\] warning$/);
        const vibrated = touchVibrations(since).length;
        check('login: a \'.\' in a name is refused: the warning haptic plays (a touch vibration), the bar flashes, nothing reaches the game', s.rejections === before + 1 && flashing && refusedLog.length > 0 && haptic.length > 0 && vibrated >= 1 && (await client('c.loginUser')) === USER, { rejections: `${before} → ${s.rejections}`, flashing, refusedLog, haptic, vibrated });

        await page.tapGame(360, 273); // the password field
        await waitFor(async () => (await kb()).kind === 'login-pass', 3000);
        await gboardTap('pw1');
        await waitFor(() => client('c.loginPass === "pw1"'), 3000);
        s = await kb();
        check('login: the password field keeps the keyboard (no restart), masked in the bar', s.kind === 'login-pass' && s.secure && s.displayText === '***' && s.keyboardType === 0x80091 && s.returnKeyType === 2 && s.imeVisible, { kind: s.kind, bar: s.displayText, pass: await client('c.loginPass') });
        shot('login-password');
        await record();
        await gboardTap('\n'); // Go: "Log in"
        const inWorld = await waitFor(() => client('c.ingame === true'), 30000);
        await waitFor(async () => !(await kb()).requested && !(await kb()).imeVisible, 5000);
        await sleep(800);
        s = await kb();
        const events = await recorded();
        check('login: Gboard\'s Go key submits and logs in; the keyboard goes, the page hears 0', inWorld.ok && events.some(e => e[0] === 'submit') && !s.requested && !s.imeVisible && !s.barVisible && (await lastFrame())?.[1] === 0, { ingame: inWorld.ok, frame: await lastFrame(), requested: s.requested, ime: s.imeVisible });
        const insets = await debug('insets');
        check('login: the navigation bar the IME brought is hidden again', insets.bars?.bottom === 0, insets.bars);
        await checkFocus('after login');
        // the character designer: Accept
        if (await waitFor(() => client('c.mainModalId !== -1'), 4000).then(r => r.ok)) {
            await page.eval('(() => { const c = window.__client; c.tapAt(c.viewportX + c.modalX + 256, c.viewportY + c.modalY + 282, 1); })()');
            await waitFor(() => client('c.mainModalId === -1'), 6000);
        }
        await sleep(800);
    }

    // ------------------------------------------------------------------------------------------------ chat
    async function openChat(label) {
        await record();
        await page.tapElement('#btn-keyboard');
        const up = await waitFor(async () => {
            const s = await kb();
            return s.requested && s.kind === 'chat' && s.imeVisible && !s.composing ? s : null;
        }, 6000);
        await sleep(600);
        if (!up.ok) check(`${label}: the chat keyboard comes up`, false, await kb());
        return up.ok;
    }

    if (wanted('chat')) {
        await openChat('chat');
        let s = await checkFocus('chat');
        check('chat: the chat line\'s keyboard: Send, the \'::\' chip (staff), charset chat, 80 at most', s.submitTitle === 'Send' && s.returnKeyType === 4 && JSON.stringify(s.chips) === '["::"]' && s.charset === 'chat' && s.maxLength === 80, { title: s.submitTitle, action: s.returnKeyType, chips: s.chips, charset: s.charset });
        const frame = await lastFrame();
        const layout = await page.eval(PAGE_LAYOUT);
        check('chat: the chatbox is lifted above Gboard and the bar (keyboard.frame = IME + 52)', frame?.[1] === Math.round(s.imeHeight + 52) && layout.chat && layout.chat.bottom <= layout.inner - frame[1] + 1, { frame, chat: layout.chat, keyboardTop: layout.inner - (frame?.[1] ?? 0) });

        await gboardTap('hello');
        await waitFor(() => client('c.chatInput === "hello"'), 3000);
        s = await kb();
        check('chat: Gboard types into the chat line, the bar shows it', (await client('c.chatInput')) === 'hello' && s.displayText === 'hello', { chatInput: await client('c.chatInput'), bar: s.displayText });
        shot('chat-gboard');
        await gboardTap('\n'); // Send
        const sent = await waitFor(() => client('c.chatInput === ""'), 3000);
        s = await kb();
        const events = await recorded();
        check('chat: Gboard\'s Send submits; the bar empties at once and the keyboard stays for the next line', sent.ok && events.some(e => e[0] === 'submit') && s.displayText === '' && s.requested && s.imeVisible, { chatInput: await client('c.chatInput'), bar: s.displayText, requested: s.requested });

        // the '::' chip: replaces the line, then only shows while the line is empty
        await tapBar('chip', 0);
        await waitFor(() => client('c.chatInput === "::"'), 3000);
        s = await kb();
        check('chat: the \'::\' chip enters \'::\' and hides (whenEmpty) once the line has text', (await client('c.chatInput')) === '::' && s.displayText === '::' && s.chips.length === 0, { chatInput: await client('c.chatInput'), chips: s.chips });
        shot('chat-chip');
        // '~' after '::' is taken (the :: rule); input text sends it as hardware key events
        d.adb('shell', 'input', 'text', '~bank');
        await waitFor(() => client('c.chatInput === "::~bank"'), 3000);
        check('chat: \'~\' is taken in a \'::\' command (hardware characters while the bar is up)', (await client('c.chatInput')) === '::~bank' && (await kb()).displayText === '::~bank', await client('c.chatInput'));
        // a held hardware Backspace repeats (400 ms, then every 50 ms) and empties the line
        d.clearLog();
        d.adb('shell', 'input', 'keyevent', '--duration', '1400', 'KEYCODE_DEL');
        await waitFor(() => client('c.chatInput === ""'), 3000);
        const backspaces = logLines(/pressKey Backspace down/).length;
        s = await kb();
        check('chat: a held Backspace repeats (its own 400/50 ms repeat) and the bar follows', (await client('c.chatInput')) === '' && s.displayText === '' && backspaces >= 7, { backspaces, chatInput: await client('c.chatInput'), bar: s.displayText });
        // '{' without '::' is refused
        const before = s.rejections;
        d.adb('shell', 'input', 'text', '{');
        await sleep(600);
        s = await kb();
        check('chat: \'{\' outside a \'::\' command is refused (nothing reaches the game)', s.rejections === before + 1 && (await client('c.chatInput')) === '', { rejections: `${before} → ${s.rejections}`, chatInput: await client('c.chatInput') });
        // a paste: quotes, dashes and the ellipsis as ASCII, line breaks as spaces
        await debug('paste', { text: '“Hi”—there\nfriend…' });
        await waitFor(() => client('c.chatInput.length > 0'), 3000);
        await sleep(300);
        check('chat: a paste is one line of ASCII (quotes, dashes, ellipsis; the line break a space), never a submit', (await client('c.chatInput')) === '"Hi"-there friend...', await client('c.chatInput'));
        // Ctrl+V pastes the clipboard (hardware)
        await debug('clipboard', { text: ' ok' });
        d.adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_V');
        await waitFor(() => client('c.chatInput.endsWith(" ok")'), 3000);
        check('chat: Ctrl+V pastes the clipboard', (await client('c.chatInput')) === '"Hi"-there friend... ok', await client('c.chatInput'));
        // empty the line again (a held hardware Backspace)
        for (let i = 0; i < 4 && (await client('c.chatInput.length')) > 0; i++) {
            d.adb('shell', 'input', 'keyevent', '--duration', '2600', 'KEYCODE_DEL');
            await sleep(400);
        }

        // a composing IME (voice input, a keyboard that composes despite the flags; Gboard's layout here never does),
        // through the live InputConnection, in one go (Gboard would end a composition it did not make)
        await record();
        const steps = [
            // [call, the bar's text (and the IME's mirror) after it, a composition open after it]
            [['setComposingText', 'he'], 'he', true],
            [['setComposingText', 'hel'], 'hel', true],
            [['setComposingText', 'help'], 'help', true],
            [['setComposingText', 'hello'], 'hello', true],
            [['commitText', 'hello '], 'hello ', false], // the commit replaces the composition
            [['setComposingText', 'wor'], 'hello wor', true],
            [['setComposingText', 'wo'], 'hello wo', true], // (Backspaces back to the common prefix)
            [['setComposingText', 'wox'], 'hello wox', true],
            [['finishComposingText'], 'hello wox', false], // kept
            [['deleteSurroundingText', 2, 0], 'hello w', false],
            [['sendKeyEvent', 67], 'hello ', false], // the IME's DEL
            [['commitText', 'a\nb'], 'hello a b', false], // a commit with a line break is a paste: one line, no submit
            [['commitText', ' c\u2028d\u2029e\u0085f'], 'hello a b c d e f', false], // Unicode's line breaks too
            [['setComposingText', '{x'], 'hello a b c d e fx', true], // '{' refused inside a composition
            [['finishComposingText'], 'hello a b c d e fx', false],
        ];
        const rejectionsBefore = (await kb()).rejections;
        const run = await debug('kbd-ime', { ops: steps.map(step => step[0]) });
        const bad = steps.map(([op, expected, composing], i) => {
            const got = run?.[i];
            return got && got.displayText === expected && got.editable === expected && got.composing === composing ? null : `${op[0]} → ${JSON.stringify(got)} (wanted ${JSON.stringify(expected)}${composing ? ', composing' : ''})`;
        }).filter(Boolean);
        const reached = await waitFor(() => client('c.chatInput === "hello a b c d e fx"'), 4000);
        const beforeAction = await recorded();
        await debug('kbd-ime', { ops: [['performEditorAction']] });
        const submitted = await waitFor(() => client('c.chatInput === ""'), 3000);
        const imeEvents = await recorded();
        check('chat: a composing IME is followed by difference (commit, finish, deletes, DEL, a paste, a refusal), its action key submits', bad.length === 0 && reached.ok && !beforeAction.some(e => e[0] === 'submit') && imeEvents.filter(e => e[0] === 'submit').length === 1 && submitted.ok && (await kb()).rejections === rejectionsBefore + 1, bad.length ? bad.join(' | ') : { reached: reached.ok, submitted: submitted.ok, rejections: (await kb()).rejections - rejectionsBefore });
        // a composition the line leaves behind (voice input, then the bar's Send): it ends with the line and the editor
        // restarts, so the IME's next composition starts on the empty line, not diffed against the sent one (Backspaces
        // into nothing, then only its tail, or the sent message typed back)
        await record();
        const left = await debug('kbd-ime', { ops: [['setComposingText', 'hello'], ['barSubmit'], ['setComposingText', 'hel']] });
        const leftLine = await waitFor(() => client('c.chatInput === "hel"'), 3000);
        const leftEvents = (await recorded()).filter(e => e[0] !== 'frame');
        check('chat: the bar\'s Send ends an open composition (the editor restarts); the IME\'s next one starts on the empty line', left?.[1]?.displayText === '' && left[1].composing === false && left[1].restarted === true && left?.[2]?.displayText === 'hel' && left[2].composing === true && leftLine.ok && text(leftEvents) === 'hellohel' && leftEvents.filter(e => e[0] === 'submit').length === 1 && !leftEvents.some(e => e[0] === 'deleteBackward'), { steps: left, events: leftEvents.map(e => e.join(':')).join(' ') });
        await debug('kbd-ime', { ops: [['finishComposingText'], ['deleteSurroundingText', 3, 0]] });
        await waitFor(() => client('c.chatInput === ""'), 3000);
        await checkFocus('chat');
    }

    // ------------------------------------------------------------------------------------------------ dismiss
    if (wanted('dismiss')) {
        if (!(await kb()).requested) await openChat('dismiss');
        // a tap on the game never gives the WebView focus (whether the keyboard stays is the page's call: the client's
        // MobileKeyboard puts it away on a tap in the world, as on iOS)
        const size = await page.eval('({ w: innerWidth, h: innerHeight })');
        await page.touch(size.w * 0.75, 40);
        await sleep(800);
        let s = await checkFocus('dismiss');
        check('dismiss: a tap on the game leaves the focus with the bridge (the WebView never takes it)', s.isFirstResponder && !s.webViewFocused && s.focused === 'KeyboardBridgeView', { requested: s.requested, focused: s.focused, webViewFocused: s.webViewFocused });
        if (!(await kb()).requested) await openChat('dismiss: again');
        await record();
        d.clearLog();
        keyevent('KEYCODE_BACK');
        await waitFor(async () => !(await kb()).imeVisible && !(await kb()).requested, 4000);
        await sleep(700);
        s = await kb();
        let events = await recorded();
        check('dismiss: the system Back closes Gboard → dismissed() (as iOS\'s hide button), keyboard.frame 0, the bar gone', events.some(e => e[0] === 'dismissed') && !s.requested && !s.barVisible && (await lastFrame())?.[1] === 0 && !(await page.eval('window.lcHost.keyboard.isShown()')) && logLines(/dismissed by the player/).length === 1, { events: events.map(e => e[0]).join(' '), log: logLines(/\[kbd\] (dismissed|ime will)/) });
        // Gboard's own hide key
        await openChat('dismiss: Gboard hide');
        await record();
        await gboardTap('hide');
        await waitFor(async () => !(await kb()).requested, 4000);
        await sleep(600);
        events = await recorded();
        check('dismiss: Gboard\'s own hide key → dismissed() too', events.some(e => e[0] === 'dismissed') && !(await kb()).requested, events.map(e => e[0]).join(' '));
        await checkFocus('dismiss');
    }

    // ------------------------------------------------------------------------------------------------ amount
    async function openAmount() {
        await page.eval('(() => { const c = window.__client; c.dialogInputOpen = true; c.dialogInput = ""; c.redrawChat = true; window.lcHost.keyboard.show(); })()');
        return waitFor(async () => {
            const s = await kb();
            return s.requested && s.kind === 'dialog' && s.imeVisible ? s : null;
        }, 6000);
    }

    if (wanted('amount')) {
        await record();
        const up = await openAmount();
        await sleep(700);
        let s = await checkFocus('amount');
        check('amount: an amount prompt gets the number pad (TYPE_CLASS_NUMBER, Done), amount chips and Cancel', up.ok && s.numeric && s.keyboardType === 2 && s.returnKeyType === 6 && s.cancelShown && s.submitTitle === 'OK' && s.chips.includes('5') && s.charset === 'digits', { inputType: s.keyboardType, action: s.returnKeyType, chips: s.chips, cancel: s.cancelShown });
        check('amount: keyboard.frame follows the number pad\'s height', (await lastFrame())?.[1] === Math.round(s.imeHeight + 52), { frame: await lastFrame(), ime: s.imeHeight });
        shot('amount-gboard');
        await record();
        await tapBar('chip', s.chips.indexOf('5')); // (an amount's chips are never whenEmpty: shown and listed alike)
        const closed = await waitFor(() => client('c.dialogInputOpen === false'), 3000);
        await waitFor(async () => !(await kb()).requested, 3000);
        let events = await recorded();
        check('amount: a chip enters its amount and submits it (the prompt closes, the keyboard goes)', closed.ok && text(events) === '5' && events.some(e => e[0] === 'submit') && !(await kb()).requested, events.map(e => e.join(':')).join(' '));
        await sleep(600);
        await record();
        await openAmount();
        await sleep(600);
        await tapBar('cancel');
        const cancelled = await waitFor(() => client('c.dialogInputOpen === false'), 3000);
        await waitFor(async () => !(await kb()).imeVisible, 3000);
        await sleep(500);
        events = await recorded();
        s = await kb();
        check('amount: Cancel cancels the prompt (keyboard.cancel), the keyboard goes, keyboard.frame 0', cancelled.ok && events.some(e => e[0] === 'cancel') && !events.some(e => e[0] === 'submit') && !s.requested && (await lastFrame())?.[1] === 0, events.map(e => e[0]).join(' '));
        await checkFocus('amount');
    }

    // ------------------------------------------------------------------------------------------------ hardware
    if (wanted('hardware')) {
        await record();
        d.clearLog();
        keyevent('KEYCODE_H', 'KEYCODE_I', 'KEYCODE_SPACE', 'KEYCODE_X', 'KEYCODE_DEL');
        await waitFor(() => client('c.chatInput === "hi "'), 3000);
        let events = await recorded();
        check('hardware: letters and Space arrive as text (insertText), Backspace as a key (pressKey down/up), with no keyboard asked for', (await client('c.chatInput')) === 'hi ' && text(events) === 'hi x' && pressed(events, 'Backspace') && !events.some(e => e[0] === 'pressKey' && e[1] === ' '), events.map(e => e.slice(0, 3).join(':')).join(' '));
        await record();
        keyevent('KEYCODE_ENTER');
        await waitFor(() => client('c.chatInput === ""'), 3000);
        events = await recorded();
        check('hardware: Enter sends the chat line (pressKey Enter down/up)', pressed(events, 'Enter') && (await client('c.chatInput')) === '', events.map(e => e.slice(0, 3).join(':')).join(' '));
        // a held arrow turns the camera, one key-down (system repeats dropped), one key-up
        await record();
        const yaw = await client('c.hudState().cameraYaw');
        d.adb('shell', 'input', 'keyevent', '--duration', '900', 'KEYCODE_DPAD_LEFT');
        await sleep(400);
        events = await recorded();
        const yaw2 = await client('c.hudState().cameraYaw');
        const downs = events.filter(e => e[0] === 'pressKey' && e[1] === 'ArrowLeft' && e[2] === true).length;
        check('hardware: a held arrow is one key-down until its key-up, and the camera turns', downs === 1 && pressed(events, 'ArrowLeft') && yaw2 !== yaw, { downs, yaw: `${yaw} → ${yaw2}` });
        // Escape closes the top thing (Settings)
        await page.tapElement('#btn-settings');
        const opened = await waitFor(() => page.eval('!document.getElementById("settings").hidden'), 3000);
        keyevent('KEYCODE_ESCAPE');
        const closed = await waitFor(() => page.eval('document.getElementById("settings").hidden'), 3000);
        check('hardware: Escape closes what is on top (Settings)', opened.ok && closed.ok);
        await record();
        keyevent('KEYCODE_TAB', 'KEYCODE_CTRL_LEFT', 'KEYCODE_F1', 'KEYCODE_MOVE_HOME', 'KEYCODE_PAGE_DOWN');
        await sleep(600);
        events = await recorded();
        check('hardware: Tab, Control, F1, Home, PageDown arrive with iOS\'s names (pressKey down/up)', ['Tab', 'Control', 'F1', 'Home', 'PageDown'].every(k => pressed(events, k)), events.map(e => e.slice(0, 3).join(':')).join(' '));
        // Space continues a dialogue that waits for "Click here to continue" (the page's rule, ARCHITECTURE.md §6.2): it
        // must come as text (insertText(' ')), never as a named key. The client's dialogue state is stood in for here.
        await page.eval(`(() => {
            const c = window.__client;
            c.__hudState = c.hudState;
            c.__hudContinue = c.hudContinue;
            window.__continued = 0;
            c.hudState = function () { return { ...c.__hudState.call(c), chatContinue: true }; };
            c.hudContinue = () => { window.__continued++; return true; };
        })()`);
        await record();
        keyevent('KEYCODE_SPACE');
        const continued = await waitFor(() => page.eval('window.__continued === 1'), 3000);
        events = await recorded();
        await page.eval('(() => { const c = window.__client; c.hudState = c.__hudState; c.hudContinue = c.__hudContinue; })()');
        check('hardware: Space (as text) continues a dialogue that waits for "Click here to continue", typing nothing', continued.ok && text(events) === ' ' && (await client('c.chatInput')) === '', { continued: continued.ok, events: events.map(e => e.slice(0, 3).join(':')).join(' ') });
        await checkFocus('hardware');

        // only the bar (iOS with a hardware keyboard): no IME comes. Gboard shows beside this emulator's keyboard whatever
        // show_ime_with_hard_keyboard says, so every IME is disabled for this part (put back below and in finally).
        for (const ime of IMES) d.adbQuiet('shell', 'ime', 'disable', ime);
        await sleep(800);
        await record();
        await page.tapElement('#btn-keyboard');
        const bar = await waitFor(async () => {
            const s = await kb();
            return s.requested && s.barVisible && s.coveredHeight === 52 ? s : null;
        }, 4000);
        await sleep(500);
        let s = await kb();
        check('hardware: with only a hardware keyboard the bar shows alone at the bottom and covers 52 dp', bar.ok && !s.imeVisible && Math.abs(s.barTop + s.barHeight - SCREEN_H / DENSITY) < 1.5 && (await lastFrame())?.[1] === 52, { ime: s.imeVisible, barTop: s.barTop, covered: s.coveredHeight, frame: await lastFrame() });
        d.adb('shell', 'input', 'text', 'yo');
        await waitFor(() => client('c.chatInput === "yo"'), 3000);
        s = await kb();
        check('hardware: typing shows in the bar', s.displayText === 'yo' && (await client('c.chatInput')) === 'yo', { bar: s.displayText });
        shot('bar-hardware-keyboard');
        keyevent('KEYCODE_ENTER');
        await waitFor(() => client('c.chatInput === ""'), 3000);
        s = await kb();
        check('hardware: Enter sends; the bar empties at once and stays', s.displayText === '' && s.requested && (await client('c.chatInput')) === '', { bar: s.displayText });
        await record();
        d.clearLog();
        keyevent('KEYCODE_BACK');
        await waitFor(() => logLines(/\[host\] back: ignored/).length > 0, 3000);
        await sleep(500);
        events = await recorded();
        s = await kb();
        check('hardware: Back does nothing (the bar stays, no dismissed(), the app in front)', !events.some(e => e[0] === 'dismissed') && s.requested && s.barVisible && logLines(/\[host\] back: ignored/).length === 1, { events: events.map(e => e[0]).join(' '), log: logLines(/back/) });
        await debug('bar', { button: 'hide' });
        await waitFor(async () => !(await kb()).requested, 3000);
        await sleep(500);
        events = await recorded();
        s = await kb();
        check('hardware: the bar\'s hide button closes it (dismissed(), keyboard.frame 0)', events.some(e => e[0] === 'dismissed') && !s.barVisible && (await lastFrame())?.[1] === 0, { events: events.map(e => e[0]).join(' ') });
        restoreImes();
        await sleep(800);
        await checkFocus('hardware: bar only');
        // volume keys are the system's (last: the volume panel shows for a few seconds)
        d.clearLog();
        keyevent('KEYCODE_VOLUME_DOWN');
        await sleep(400);
        check('hardware: a volume key is not the game\'s', logLines(/pressKey|insertText/).length === 0, logLines(/\[kbd\]/));
        await sleep(3500);
    }

    // ------------------------------------------------------------------------------------------------ focus
    if (wanted('focus')) {
        await openChat('focus');
        // a native text field borrows focus (KeyboardFocus.lend) and gives it back
        await debug('kbd-lend', { ms: 1500 });
        await sleep(700);
        let s = await kb();
        const lentState = { focused: s.isFirstResponder, lent: s.lent, bar: s.barVisible, ime: s.imeVisible, covered: s.coveredHeight };
        await sleep(2200);
        s = await kb();
        check('focus: a lend takes focus, the bar and the IME away; closing it gives focus and the keyboard back', lentState.lent && !lentState.focused && !lentState.bar && !lentState.ime && lentState.covered === 0 && s.isFirstResponder && !s.lent && s.requested && s.imeVisible && s.barVisible && s.coveredHeight === Math.round(s.imeHeight + 52), { during: lentState, after: { focused: s.isFirstResponder, ime: s.imeVisible, covered: s.coveredHeight } });
        // the notification shade over the app, then back: the keyboard is still there
        d.clearLog();
        d.adbQuiet('shell', 'cmd', 'statusbar', 'expand-notifications');
        await sleep(1500);
        d.adbQuiet('shell', 'cmd', 'statusbar', 'collapse');
        await sleep(2000);
        s = await kb();
        check('focus: the notification shade and back keep the keyboard (no dismissal)', s.requested && s.imeVisible && s.isFirstResponder && logLines(/dismissed by the player/).length === 0, { requested: s.requested, ime: s.imeVisible, log: logLines(/\[kbd\] (ime|dismissed|first)/) });
        // HOME and back: as iOS, the keyboard is up again
        await record();
        const coveredBefore = (await kb()).coveredHeight;
        d.clearLog();
        keyevent('KEYCODE_HOME');
        await sleep(2500);
        d.adb('shell', 'am', 'start', '-W', '-n', ACTIVITY);
        await sleep(2500);
        await reconnect();
        const back = await waitFor(async () => {
            const st = await kb();
            return st.requested && st.imeVisible && st.isFirstResponder ? st : null;
        }, 5000);
        await sleep(600);
        const frames = (await recorded()).filter(e => e[0] === 'frame').map(e => e[1]);
        // (Gboard sometimes comes back 9 dp taller and settles a moment later: the page follows the IME's own height,
        // never below it; a drop is a lower frame than both the old and the final height)
        const after = await kb();
        const lowest = Math.min(coveredBefore, after.coveredHeight);
        check('focus: HOME and back bring the keyboard back (iOS keeps it), no dismissal, the page\'s chatbox never dropping', back.ok && logLines(/dismissed by the player/).length === 0 && frames.every(h => h >= lowest) && after.coveredHeight === Math.round(after.imeHeight + 52), { before: coveredBefore, frames, after: after.coveredHeight, log: logLines(/\[kbd\] (ime will|ime did|ime shown|ime hidden|ime resized|dismissed|first|covers)/) });
        shot('after-home');
        await checkFocus('focus');
        keyevent('KEYCODE_BACK');
        await sleep(800);
    }

    // ------------------------------------------------------------------------------------------------ cutout
    if (wanted('cutout')) {
        // the bar keeps 12 dp from the safe area's leading edge and 6 dp from its trailing one (iOS's safeAreaLayoutGuide)
        const CUTOUT = 'com.android.internal.display.cutout.emulation.tall';
        d.adbQuiet('shell', 'cmd', 'overlay', 'enable-exclusive', '--category', CUTOUT);
        await sleep(3000);
        const sides = async () => {
            const s = await kb();
            const insets = await debug('insets');
            const v = s.views;
            return { left: insets.cutout.left, right: insets.cutout.right, prompt: v.prompt && v.prompt[0] / DENSITY, hideEnd: v.hide && (v.hide[0] + v.hide[2]) / DENSITY, width: SCREEN_W / DENSITY, covered: s.coveredHeight };
        };
        await openChat('cutout');
        const left = await sides();
        shot('bar-cutout');
        await record();
        d.clearLog();
        if (SERIAL.startsWith('emulator-')) d.adbQuiet('emu', 'sensor', 'set', 'acceleration', '-9.81:0:0');
        await sleep(3000);
        const right = await sides();
        const turned = await kb();
        const frames = (await recorded()).filter(e => e[0] === 'frame').map(e => e[1]);
        check('cutout: turning the phone over keeps the keyboard (the IME the system takes away comes back; no dismissal, no dip)', turned.requested && turned.imeVisible && logLines(/dismissed by the player/).length === 0 && frames.every(h => h === left.covered), { frames, log: logLines(/\[kbd\] (display|ime (hidden|will|shown)|dismissed|covers)/) });
        if (SERIAL.startsWith('emulator-')) d.adbQuiet('emu', 'sensor', 'set', 'acceleration', '9.81:0:0');
        d.adbQuiet('shell', 'cmd', 'overlay', 'disable', CUTOUT);
        await sleep(2500);
        const near = (a, b) => Math.abs(a - b) < 1.5;
        // (the sides made equal, the larger of the two, as iOS's landscape safe area: the cutout's inset on both)
        check('cutout: the bar keeps out of the cutout on either side, the same inset on both (12 dp in from the leading edge, 6 dp from the trailing one)', left.left > 0 && near(left.prompt, left.left + 12) && near(left.hideEnd, left.width - left.left - 6) && right.right > 0 && near(right.prompt, right.right + 12) && near(right.hideEnd, right.width - right.right - 6), { left, right });
        keyevent('KEYCODE_BACK');
        await sleep(800);
        await checkFocus('cutout');
    }

    check('focus is never the WebView\'s, at every phase', always.every(Boolean), `${always.filter(Boolean).length}/${always.length}`);
} catch (err) {
    check('the run finished', false, err.stack ?? String(err));
} finally {
    page?.close();
    d.adbQuiet('forward', '--remove', `tcp:${d.devtoolsPort}`);
    restoreImes();
    d.adbQuiet('shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', showImeBefore === 'null' || showImeBefore === '' ? '0' : showImeBefore);
    d.adbQuiet('shell', 'svc', 'power', 'stayon', 'false');
    results.finished = new Date().toISOString();
    results.failures = failures;
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
    console.log(`\n${results.checks.length - failures}/${results.checks.length} checks passed; screenshots and results.json in ${path.relative(process.cwd(), OUT) || OUT}`);
    process.exitCode = failures ? 1 : 0;
}
