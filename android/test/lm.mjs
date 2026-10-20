// The bots' chat model in the real app on an emulator or phone (docs/ANDROID.md §5.6): the app's
// own page, engine and native glue (LmComponent), driven over adb and CDP. The references are the iOS game-test's `lm`
// phase (web/test/native/drive.mjs + game-test/test.js) and e2e.mjs --lm-stub; here the model really runs (the arm64
// emulator runs llama.cpp's CPU backend), and Claude online talks to web/test/lm/mock-claude.mjs on this Mac through
// `adb reverse` (the debug action lm-endpoint points it there: the real API is never called).
//
//   node android/test/lm.mjs [--serial emulator-5556] [--no-build] [--only model,release,none] [--mock-port 47591]
//
// Phases (checks, screenshots and results.json with the replies' timings in android/build/lm/):
//   model    the debug build with the model (android/scripts/prepare-model.sh's, the iPhone's): LostCityNative.lm at
//            document start; Settings › Bot chat (the model's name and size, On-device by default, Think first shown and
//            greyed with Rules and Claude online); the warm-up when the player enters the world (" · loaded"); real
//            replies to the engine's requests (posted from inside the engine worker, as e2e --lm-stub does) with Think
//            first on and off, their timings in the log; the key's box (typed and saved, "not a key" with the error
//            haptic, Cancel, Back, the IME, FLAG_SECURE); Claude online against the mock (a line, the Test button, the
//            fallback to the on-device model when the mock fails or cannot be reached, a refused key); Remove with the
//            confirm box; the page still cannot reach the network; the thermal override (cmd thermalservice
//            override-status 4 and 3 → busy); the model freed in the background and by a memory warning; an answer for a
//            page that reloaded is dropped; no key in any status or log line.
//   release  the release build (R8, the release key) with a probe in its web bundle (as a --autotest build: lmprobe.js,
//            never shipped): it installs, runs, and the on-device model replies with and without the note (no CDP or
//            debug hooks in a release build: the probe logs through the console bridge).
//   none     a -Plc.model=none build: "Not in this build", Rules by default, no Think first, native answers unavailable.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ACTIVITY, PKG, device, sleep } from './lib/adb.mjs';
import { screencap } from './lib/image.mjs';
import { startMockClaude } from '../../web/test/lm/mock-claude.mjs';

const ANDROID = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO = path.dirname(ANDROID);
const OUT = path.join(ANDROID, 'build', 'lm');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
};
const SERIAL = option('--serial', process.env.ANDROID_SERIAL ?? 'emulator-5554');
const ONLY = option('--only', 'model,release,none').split(',');
const BUILD = !argv.includes('--no-build');
const MOCK_PORT = Number(option('--mock-port', '47591'));
const MODEL = JSON.parse(fs.readFileSync(path.join(ANDROID, 'build', 'model-assets', 'Model', 'model.json'), 'utf8'));
const PROMPTS = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'test', 'lm', 'bench-prompts.json'), 'utf8')).prompts;
// Settings › Bot chat's texts on Android (host.js STRINGS.android, botChat.render)
const KEY_REMOVE = 'It is deleted from this phone. Claude online then answers with the on-device model, or with the rules.';
const MOCK_LINES = ['hey whats up', 'lol nm u', 'just chillin at the bank', 'sup m8', 'not much, u?'];

fs.mkdirSync(OUT, { recursive: true });
for (const old of fs.readdirSync(OUT)) if (old.endsWith('.png') || old.endsWith('.txt')) fs.rmSync(path.join(OUT, old));
const d = device(SERIAL);
const results = { serial: SERIAL, started: new Date().toISOString(), model: MODEL, checks: [], replies: [] };
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
const logLine = pattern => d.log().find(line => pattern.test(line)) ?? null;
const strip = line => line?.replace(/^.*?LostCity: /, '') ?? 'no log line';

function gradle(...args) {
    console.log(`gradle ${args.join(' ')}…`);
    execFileSync(path.join(ANDROID, 'gradlew'), [...args, '--console=plain', '-q'], { cwd: ANDROID, stdio: 'inherit' });
}

function install(apk) {
    console.log(`   ${d.install(apk)} (${path.relative(ANDROID, apk)})`);
}

function launch({ stop = true, settings = null } = {}) {
    const args = ['shell', 'am', 'start', '-W', ...(stop ? ['-S'] : []), '-n', ACTIVITY];
    if (settings) args.push('--es', 'lostcity.settings', `'${JSON.stringify(settings)}'`);
    const output = d.adb(...args);
    return { totalMs: Number(/TotalTime: (\d+)/.exec(output)?.[1] ?? NaN), launchState: /LaunchState: (\w+)/.exec(output)?.[1] ?? '?' };
}

let page = null;

async function reconnect(timeoutMs = 30000) {
    page?.close();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        page = await d.connect({ timeoutMs: Math.max(1000, deadline - Date.now()) });
        try {
            if ((await page.eval('1 + 1')) === 2) return page;
        } catch {
            // (a target that is going away)
        }
        page.close();
        if (Date.now() > deadline) throw new Error('no live page target');
        await sleep(500);
    }
}

/** A debug action ({type:'debug'}, DEBUG builds), answered through window.__lcDebugReply. */
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

/** The bench's {type:'lm-bench'} (DEBUG builds), answered the same way. */
async function bench(action, extra = {}, timeoutMs = 20000) {
    return page.eval(`new Promise(resolve => {
        const id = Math.floor(Math.random() * 1e9) + 1;
        const previous = window.__lcDebugReply;
        const timer = setTimeout(() => resolve({ timeout: true }), ${timeoutMs});
        window.__lcDebugReply = (replyId, value) => {
            if (replyId !== id) return previous?.(replyId, value);
            clearTimeout(timer);
            window.__lcDebugReply = previous;
            resolve(value);
        };
        window.LostCityNativeBridge.native.postMessage({ type: 'lm-bench', id, action: ${JSON.stringify(action)}, ...${JSON.stringify(extra)} });
    })`);
}

const STATE = `(() => { const c = window.__client; const h = window.LostCityHost;
  const base = { engine: h?.engineState ?? null };
  if (!c) return base;
  return { ...base, pct: c.lastProgressPercent, title: !!c.titleFlames, loginscreen: c.loginscreen, ingame: c.ingame,
    err: !!(c.errorLoading || c.errorHost || c.errorStarted), loaderHidden: document.getElementById('loading')?.hidden ?? null,
    modal: c.mainModalId, settingsOpen: !document.getElementById('settings').hidden }; })()`;
const state = () => page.eval(STATE);

async function bootToTitle(label, timeoutMs = 180000) {
    const booted = await waitFor(async () => {
        const s = await state();
        return s.err ? s : s.title && s.pct === 100 && s.engine === 'ready' && s.loaderHidden ? s : null;
    }, timeoutMs, 150);
    check(`${label}: title drawn, world ready`, booted.ok && !booted.value?.err, booted.value ? `${booted.ms} ms` : 'timeout');
    return booted.ok;
}

async function login(user) {
    await page.tapGame(302, 291); // New user
    await waitFor(async () => (await state()).loginscreen === 2, 5000);
    await page.tapGame(360, 248);
    await sleep(400);
    await page.eval(`window.LostCityHost.keyboard.insertText(${JSON.stringify(user)})`);
    await sleep(300);
    await page.eval('window.LostCityHost.keyboard.submit()');
    const inWorld = await waitFor(async () => (await state()).ingame, 60000);
    check(`${user} logs in`, inWorld.ok, `${inWorld.ms} ms`);
    // (Tutorial Island's first login opens the character designer: Accept)
    const open = await waitFor(async () => (await state()).modal !== -1, 4000);
    if (open.ok) {
        await page.eval('(() => { const c = window.__client; c.tapAt(c.viewportX + c.modalX + 256, c.viewportY + c.modalY + 282, 1); })()');
        await waitFor(async () => (await state()).modal === -1, 6000);
    }
    return inWorld.ok;
}

// ---------------------------------------------------------------------------------------------------- Settings › Bot chat

async function openBotChat() {
    if (!(await state()).settingsOpen) {
        await page.tapElement('#btn-settings');
        await waitFor(async () => (await state()).settingsOpen, 3000);
    }
    await page.tapElement('#nav-botchat');
    await waitFor(() => page.eval(`!document.getElementById('section-botchat').hidden`), 3000);
}

async function closeSettings() {
    if ((await state()).settingsOpen) {
        await page.tapElement('#settings-close');
        await waitFor(async () => !(await state()).settingsOpen, 3000);
    }
}

const BOTCHAT = `(() => { const row = document.getElementById('botchat-think');
    return { local: document.getElementById('botchat-local').textContent, key: document.getElementById('botchat-key').textContent,
        set: document.getElementById('botchat-key-set').textContent, remove: !document.getElementById('botchat-key-remove').hidden,
        test: document.getElementById('botchat-test-result').textContent, testDisabled: document.getElementById('botchat-test').disabled,
        on: [...document.querySelectorAll('#section-botchat .seg[data-setting="botChat"] button.on')].map(b => b.textContent),
        disabled: [...document.querySelectorAll('#section-botchat .seg[data-setting="botChat"] button')].filter(b => b.disabled).map(b => b.dataset.value),
        think: !row.hidden, thinkUnused: row.classList.contains('unused'), thinkDisabled: [...row.querySelectorAll('.seg button')].map(b => b.disabled),
        thinkOn: [...row.querySelectorAll('.seg button.on')].map(b => b.textContent), thinkHint: document.getElementById('botchat-think-hint').textContent }; })()`;
const botChat = () => page.eval(BOTCHAT);
// (a tap, then a moment for the page to draw it: the screenshots come right after)
const choose = async value => (await page.tapElement(`#section-botchat .seg[data-setting="botChat"] button[data-value="${value}"]`)) && (await sleep(400), true);
const chooseThink = async on => (await page.tapElement(`#botchat-think .seg button[data-value="${on}"]`)) && (await sleep(400), true);

// ---------------------------------------------------------------------------------------------------- the page's side

// What native sends LostCityHost.bots, as it sends it (the page keeps only id, text, source and error of a reply): a
// wrapper around lmReply and lmStatus. __lcCall resolves the path when it is called, so native reaches the wrappers.
const RECORDER = `(() => {
    if (window.__lmTest) return true;
    const t = (window.__lmTest = { replies: [], statuses: [] });
    const bots = window.LostCityHost.bots;
    const reply = bots.lmReply, status = bots.lmStatus;
    bots.lmReply = v => { t.replies.push(JSON.parse(JSON.stringify(v))); return reply(v); };
    bots.lmStatus = v => { t.statuses.push(JSON.parse(JSON.stringify(v))); return status(v); };
    return true;
})()`;
const lastStatus = () => page.eval('window.__lmTest.statuses.at(-1) ?? null');
const allStatuses = () => page.eval('JSON.stringify(window.__lmTest.statuses)');
const rawReply = id => page.eval(`window.__lmTest.replies.find(r => r.id === ${id}) ?? null`);

let engineWorker = -1;

/** The engine worker over CDP (Target.setAutoAttach): requests are posted from inside it, as the bots' engine posts them. */
async function attachEngine() {
    const workers = await page.attachWorkers();
    engineWorker = workers.findIndex(w => /engine/.test(w.info?.url ?? ''));
    if (engineWorker < 0 && workers.length) engineWorker = 0;
    return engineWorker >= 0 ? workers[engineWorker].info.url : null;
}

const WORKER_REQUEST = (id, prompt, timeoutMs) => `(() => {
    if (!self.__lmListening) {
        self.__lmListening = true;
        self.__lmReplies = [];
        self.addEventListener('message', event => { if (event.data?.type === 'bots-lm-reply') self.__lmReplies.push(event.data); });
    }
    self.postMessage({ type: 'bots-lm', id: ${id}, mode: 'local', local: ${JSON.stringify(prompt.local)}, online: ${JSON.stringify(prompt.online)}, maxChars: 80, timeoutMs: ${timeoutMs} });
    return true;
})()`;

/** A request from the engine (bench prompt `promptIndex`): what native answered and what the engine got back. */
async function ask(id, { prompt = 0, timeoutMs = 9000, wait = true } = {}) {
    const started = Date.now();
    await page.evalWorker(WORKER_REQUEST(id, PROMPTS[prompt % PROMPTS.length], timeoutMs), engineWorker);
    if (!wait) return null;
    const engine = await waitFor(() => page.evalWorker(`(self.__lmReplies ?? []).find(r => r.id === ${id}) ?? null`, engineWorker), timeoutMs + 5000, 100);
    const raw = await rawReply(id);
    const line = logLine(new RegExp(`\\[lm\\] #${id} `));
    const result = { id, engine: engine.value, raw, line: line && strip(line), wallMs: Date.now() - started };
    results.replies.push(result);
    return result;
}

/** JSON with every object's keys sorted: native's statuses come in two key orders (document start sorts them). */
const sorted = value => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

const noteOf = r => (r?.raw?.timings ? `${r.raw.timings.think ? `note ${r.raw.timings.noteTokens} tokens in ${r.raw.timings.noteMs} ms, ` : ''}${r.raw.timings.totalMs} ms in all` : '');

// ---------------------------------------------------------------------------------------------------- the key's box

/** The box's views (uiautomator; the box is FLAG_SECURE, so screenshots show nothing of it). */
function keyBox() {
    const xml = d.uiDump();
    const field = /<node [^>]*class="android\.widget\.EditText"[^>]*>/.exec(xml)?.[0] ?? null;
    const boundsOf = node => node && /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node)?.slice(1).map(Number);
    const bounds = boundsOf(field);
    return {
        window: boundsOf(/<node [^>]*>/.exec(xml)?.[0] ?? null),
        shown: xml.includes('text="Claude API key"'),
        message: /text="(Paste your key[^"]*)"/.exec(xml)?.[1] ?? null,
        password: field ? /password="true"/.test(field) : null,
        focused: field ? /focused="true"/.test(field) : null,
        field: bounds ? { x: (bounds[0] + bounds[2]) >> 1, y: (bounds[1] + bounds[3]) >> 1 } : null,
        buttons: [...xml.matchAll(/<node [^>]*text="(Cancel|Save|CANCEL|SAVE)"[^>]*class="android\.widget\.Button"/g)].map(m => m[1])
    };
}

const imeShown = () => /mInputShown=true/.test(d.adbQuiet('shell', 'dumpsys', 'input_method'));

/** Closes the keyboard if it is up (Back), as a user does before tapping the box's buttons under it. */
async function hideIme() {
    if (!imeShown()) return;
    d.adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await waitFor(() => (imeShown() ? null : true), 3000, 300);
}

/** How many sampled pixels of `region` ([x1, y1, x2, y2]) are not black. */
function litIn(image, [x1, y1, x2, y2], step = 7) {
    let lit = 0;
    for (let y = y1; y < y2; y += step) {
        for (let x = x1; x < x2; x += step) {
            const i = (y * image.width + x) * 4;
            if (image.data[i] | image.data[i + 1] | image.data[i + 2]) lit++;
        }
    }
    return lit;
}

async function openKeyBox() {
    await page.tapElement('#botchat-key-set');
    const open = await waitFor(() => (keyBox().shown ? true : null), 6000, 300);
    return open.ok;
}

/** Types into the box's focused field (key events: the field holds input focus whether or not the IME is up). */
function typeKey(text) {
    d.adb('shell', 'input', 'text', text);
}

// ---------------------------------------------------------------------------------------------------- setup

const mock = ONLY.includes('model') ? await startMockClaude({ port: MOCK_PORT, slowMs: 10000 }) : null;
const mockRequests = async () => (await (await fetch(`http://127.0.0.1:${MOCK_PORT}/requests`)).json());
d.adbQuiet('shell', 'settings', 'put', 'secure', 'immersive_mode_confirmations', 'confirmed');
d.adbQuiet('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
d.adbQuiet('shell', 'settings', 'put', 'system', 'user_rotation', '1');
if (SERIAL.startsWith('emulator-')) d.adbQuiet('emu', 'sensor', 'set', 'acceleration', '9.81:0:0');
d.adbQuiet('shell', 'svc', 'power', 'stayon', 'true');
d.adbQuiet('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
d.adbQuiet('shell', 'cmd', 'thermalservice', 'reset');
const debugApk = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const releaseApk = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const existsRetry = () => fs.existsSync(path.join(OUT, 'release-logcat-1.txt'));
const apkEntries = apk => execFileSync('unzip', ['-l', apk], { encoding: 'utf8', maxBuffer: 16 << 20 });

try {
    // ================================================================================================ model
    if (ONLY.includes('model')) {
        console.log('\n== model: the debug build with the model');
        if (BUILD) gradle(':app:assembleDebug');
        check('model: the debug APK carries the model (assets/Model)', apkEntries(debugApk).includes(`assets/Model/${MODEL.file}`));
        install(debugApk);
        d.adb('reverse', `tcp:${MOCK_PORT}`, `tcp:${MOCK_PORT}`);
        d.adb('shell', 'pm', 'clear', PKG);
        d.clearLog();
        launch({ settings: { seenHowToPlay: true, bots: 25 } });
        await reconnect();
        await bootToTitle('model: boot');
        d.tapNative(/^Got it$/i);
        await page.eval(RECORDER);

        // ---- the status at document start, the defaults
        const native = await page.eval('window.LostCityNative');
        const lm = native.lm;
        check('model: LostCityNative.lm at document start: the model in the app (name, size, the note offered), not loaded, no key',
            lm?.local?.available === true && lm.local.name === MODEL.name && lm.local.bytes === MODEL.bytes && lm.local.think === 'option' && lm.local.loaded === false && !('reason' in lm.local) && lm.online?.keySet === false && lm.online.model === 'claude-haiku-5-5',
            JSON.stringify(lm));
        const defaults = await page.eval('({ botChat: window.LostCityHost.settings.botChat, botThink: window.LostCityHost.settings.botThink })');
        check('model: On-device is the default chat model with a model in the app; Think first On by default', defaults.botChat === 'local' && defaults.botThink === true, JSON.stringify(defaults));
        const status0 = await debug('lm-status');
        check('model: debug lm-status: the same status, no request yet', sorted(status0?.status) === sorted(lm) && status0?.counters?.requests === 0, JSON.stringify(status0));

        // ---- Settings › Bot chat
        await openBotChat();
        const mb = `${Math.max(1, Math.round(MODEL.bytes / 1048576))} MB`;
        let ui = await botChat();
        shot('botchat');
        check(`model: Settings › Bot chat shows the model ("${MODEL.name} · ${mb}"), On-device chosen, no key`, ui.local === `${MODEL.name} · ${mb}` && JSON.stringify(ui.on) === '["On-device"]' && ui.key === 'Not set' && ui.set === 'Set key' && !ui.remove && ui.testDisabled && ui.disabled.length === 0, JSON.stringify(ui));
        check('model: Think first is shown (the model is hybrid), On, in use with On-device', ui.think && JSON.stringify(ui.thinkOn) === '["On"]' && !ui.thinkUnused && JSON.stringify(ui.thinkDisabled) === '[false,false]' && /plan each reply first/.test(ui.thinkHint), JSON.stringify(ui));
        await choose('rules');
        const rules = await botChat();
        await choose('online');
        const online = await botChat();
        shot('botchat-online-think-greyed');
        await choose('local');
        const local = await botChat();
        const greyed = u => u.think && u.thinkUnused && JSON.stringify(u.thinkDisabled) === '[true,true]' && u.thinkHint === 'Only with the On-device chat model.' && JSON.stringify(u.thinkOn) === '["On"]';
        check('model: Think first greyed (Off/On disabled, its choice kept) with Rules and with Claude online, in use again with On-device', JSON.stringify(rules.on) === '["Rules"]' && greyed(rules) && JSON.stringify(online.on) === '["Claude online"]' && greyed(online) && JSON.stringify(local.on) === '["On-device"]' && !local.thinkUnused && JSON.stringify(local.thinkDisabled) === '[false,false]', JSON.stringify({ rules: [rules.on, rules.thinkDisabled], online: [online.on, online.thinkDisabled], local: [local.on, local.thinkDisabled] }));
        check('model: the choice is kept natively (settings botChat)', (await debug('settings'))?.botChat === 'local');
        await closeSettings();

        // ---- the warm-up when the player enters the world
        d.clearLog();
        const user = `lm${Date.now() % 100000}`;
        await login(user);
        const loaded = await waitLog(/\[lm\] local model loaded in \d+ ms/, 60000);
        const ingameAt = d.log().findIndex(l => /status ingame/.test(l));
        const loadedAt = d.log().findIndex(l => /\[lm\] local model loaded in/.test(l));
        check('model: entering the world warms the model up (lm-warm → loaded, after status ingame)', loaded.ok && ingameAt >= 0 && loadedAt > ingameAt, strip(loaded.value));
        results.warmLoad = strip(loaded.value);
        const loadedStatus = await waitFor(async () => (await lastStatus())?.local?.loaded === true, 5000);
        await openBotChat();
        ui = await botChat();
        shot('botchat-loaded');
        check('model: the status says loaded (LostCityHost.bots.lmStatus) and Bot chat shows " · loaded"', loadedStatus.ok && ui.local === `${MODEL.name} · ${mb} · loaded`, ui.local);
        check('model: the load is from the APK by mmap on the CPU', /0 on the GPU, \d+ threads, mmap\)/.test(loaded.value ?? ''), strip(loaded.value));
        await closeSettings();

        // ---- real replies to the engine's requests, Think first on and off
        const engineUrl = await attachEngine();
        check('model: the engine worker can be reached (CDP)', !!engineUrl, engineUrl ?? 'no worker');
        for (const [i, id] of [9101, 9102].entries()) {
            const r = await ask(id, { prompt: i });
            check(`model: a reply on the device with Think first On (#${id}): a line from the model, its note written, the timings in the log`,
                typeof r.engine?.text === 'string' && r.engine.text.length > 0 && r.engine.source === 'local' && r.raw?.timings?.think === true && r.raw.timings.noteTokens > 0 && r.raw.timings.generatedTokens > 0 && /local, think on, in \d+ ms: prompt \d+ tokens at \d+\/s, note \d+ tokens in \d+ ms, \d+ tokens at \d+\/s/.test(r.line ?? ''),
                `"${r.engine?.text}" — ${r.line}`);
        }
        await openBotChat();
        await chooseThink(false);
        await closeSettings();
        for (const [i, id] of [9103, 9104].entries()) {
            const r = await ask(id, { prompt: i + 2 });
            check(`model: a reply with Think first Off (#${id}): no note`,
                typeof r.engine?.text === 'string' && r.engine.text.length > 0 && r.engine.source === 'local' && r.raw?.timings?.think === false && /local, think off, in \d+ ms: prompt \d+ tokens at \d+\/s, \d+ tokens at \d+\/s/.test(r.line ?? ''),
                `"${r.engine?.text}" — ${r.line}`);
        }
        check('model: what the engine gets is the reply\'s words only (no think tags, at most 80 characters)', results.replies.filter(r => r.id >= 9101 && r.id <= 9104).every(r => !/think>/.test(r.engine?.text ?? '') && (r.engine?.text ?? '').length <= 80), results.replies.map(r => r.engine?.text).join(' | '));
        const generated = await bench('generate', { system: PROMPTS[0].local.system, user: PROMPTS[0].local.user, think: true, timeoutMs: 15000 });
        check('model: the debug bench generates directly (lm-bench generate: text, timings, note)', typeof generated?.text === 'string' && generated.timings?.think === true && typeof generated.note === 'string', JSON.stringify(generated).slice(0, 300));
        const stats = await bench('stats');
        check('model: lm-bench stats (loaded, the note offered, threads 2, nominal, the CPU variant, mmap)', stats?.loaded === true && stats.think === 'option' && stats.options?.threads === 2 && stats.thermal === 'nominal' && typeof stats.cpuVariant === 'string' && stats.mmap === true && Array.isArray(stats.lastLoad), JSON.stringify(stats));
        results.benchStats = stats;
        d.clearLog();
        const options3 = await bench('options', { threads: 3 });
        const unloadedForOptions = await waitLog(/\[lm\] local model unloaded \(bench options\)/, 5000);
        const options2 = await bench('options', { threads: 2 });
        const unloadedBench = await bench('unload');
        check('model: lm-bench options (threads, unloading the model) and unload', options3?.threads === 3 && options3.gpuLayers === 0 && unloadedForOptions.ok && options2?.threads === 2 && unloadedBench === true, JSON.stringify({ options3, options2, unloadedBench }));

        // ---- the key's box, typed as the player types it
        await openBotChat();
        const presentedBefore = (await debug('ui-state'))?.presented;
        await debug('haptics'); // (clears the list of haptics played)
        const opened = await openKeyBox();
        let box = keyBox();
        const uiState = await debug('ui-state');
        const lentState = await debug('keyboard-state'); // (the keyboard bridge lends its focus to the box's field)
        const screen = screencap(d);
        const [bx1, by1, bx2, by2] = box.window ?? [0, 0, 0, 0];
        const litBox = litIn(screen, [bx1 + 8, by1 + 8, bx2 - 8, by2 - 8]);
        const litGame = litIn(screen, [0, 0, Math.max(0, bx1 - 8), screen.height]);
        const config = await debug('config');
        check('model: Set key opens the native box: "Claude API key", the Android text, a masked field with focus, Cancel and Save', opened && box.message === 'Paste your key from platform.claude.com. It stays encrypted on this phone, never in the game. While Claude online is on, the chat and the bot\'s state go to Anthropic.' && box.password === true && box.focused === true && box.buttons.length === 2, JSON.stringify(box));
        check('model: ui-state names the box (presented AlertDialog)', presentedBefore === '' && uiState?.presented === 'AlertDialog', JSON.stringify({ presentedBefore, presented: uiState?.presented }));
        check('model: while the box is up the keyboard bridge has lent its focus (lent, not the first responder, no bar)', lentState?.lent === true && lentState.isFirstResponder === false && lentState.barVisible === false, JSON.stringify({ lent: lentState?.lent, firstResponder: lentState?.isFirstResponder, bar: lentState?.barVisible, focused: lentState?.focused }));
        check('model: the box is FLAG_SECURE: a screenshot shows it black, the game beside it as it is', box.window && litBox === 0 && litGame > 100, `box ${JSON.stringify(box.window)}: ${litBox} lit samples; the game left of it: ${litGame}`);
        check(`model: on a landscape phone (${config?.screenHeightDp} dp tall) the box comes up with the keyboard down, so it is read whole first`, config?.screenHeightDp < 560 && !imeShown(), JSON.stringify({ screenHeightDp: config?.screenHeightDp, ime: imeShown() }));
        if (box.field) d.adb('shell', 'input', 'tap', String(box.field.x), String(box.field.y));
        const ime = await waitFor(() => (imeShown() ? true : null), 4000, 300);
        check('model: a tap on the field opens the keyboard', ime.ok);
        typeKey('sk-ant-test-ok-abcd');
        box = keyBox();
        check('model: what is typed is masked (password field, not the key\'s text)', box.password === true && !d.uiDump().includes('sk-ant-test'), JSON.stringify({ password: box.password }));
        d.adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); // (the keyboard goes; the box stays)
        await sleep(800);
        box = keyBox();
        check('model: Back with the keyboard up closes the keyboard only', box.shown && !imeShown(), JSON.stringify({ shown: box.shown }));
        d.tapNative(/^save$/i);
        const saved = await waitFor(async () => (await lastStatus())?.online?.keySet === true, 5000);
        ui = await botChat();
        const afterBox = await debug('ui-state');
        check('model: Save keeps the key: the status says set, ends in …abcd; Bot chat "Ends in …abcd", Change, Remove, Test', saved.ok && saved.value && (await lastStatus()).online.hint === '…abcd' && ui.key === 'Ends in …abcd' && ui.set === 'Change' && ui.remove && !ui.testDisabled && afterBox?.presented === '', JSON.stringify({ status: await lastStatus(), key: ui.key }));
        check('model: the log says the key was saved (only its last four characters)', !!logLine(/\[lm\] Claude key saved \(…abcd\)/), strip(logLine(/Claude key saved/)));
        const backState = await debug('keyboard-state');
        check('model: after the box the bridge has its focus back (not lent; its view the first responder, never the WebView)', backState?.lent === false && backState.isFirstResponder === true && backState.focused === 'KeyboardBridgeView' && backState.webViewFocused === false, JSON.stringify({ lent: backState?.lent, firstResponder: backState?.isFirstResponder, focused: backState?.focused, webViewFocused: backState?.webViewFocused }));

        await openKeyBox();
        typeKey('x');
        await hideIme();
        d.tapNative(/^save$/i);
        const notKey = await waitFor(async () => ((await lastStatus())?.online?.problem === 'not a key' ? await lastStatus() : null), 5000);
        const haptics = await debug('haptics');
        check('model: what cannot be a key is refused: the key stays (…abcd), the status says "not a key", the error haptic plays', notKey.ok && notKey.value.online.hint === '…abcd' && Array.isArray(haptics) && haptics.includes('error'), JSON.stringify({ status: notKey.value?.online, haptics }));
        await openKeyBox();
        typeKey('sk-ant-test-other-9999');
        await hideIme();
        d.tapNative(/^cancel$/i);
        await sleep(800);
        const afterCancel = await debug('lm-status');
        check('model: Cancel keeps the key as it was', afterCancel?.status?.online?.hint === '…abcd' && !keyBox().shown, JSON.stringify(afterCancel?.status?.online));
        await openKeyBox();
        d.adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        await sleep(800);
        const afterBack = await debug('lm-status');
        check('model: Back closes the box as Cancel does', !keyBox().shown && afterBack?.status?.online?.hint === '…abcd' && (await debug('ui-state'))?.presented === '', JSON.stringify(afterBack?.status?.online));
        // an activity recreated with the box up (Don't keep activities, an unhandled change): the box goes with it, as Cancel
        await openKeyBox();
        d.clearLog();
        await debug('recreate');
        const closedWith = await waitLog(/\[lm\] the Claude key box closed with its activity/, 8000);
        await waitLog(/activity re-attached; the page keeps running/, 8000);
        await sleep(1500);
        await reconnect();
        await attachEngine();
        const leakedWindow = d.adbQuiet('logcat', '-d').split('\n').filter(l => /has leaked window|WindowLeaked/.test(l));
        const afterRecreate = await debug('lm-status');
        const recreatedState = await debug('keyboard-state');
        check('model: after the recreation the new activity\'s bridge holds the focus (the lend was closed with the box)', recreatedState?.lent === false && recreatedState.isFirstResponder === true && recreatedState.webViewFocused === false, JSON.stringify({ lent: recreatedState?.lent, firstResponder: recreatedState?.isFirstResponder, focused: recreatedState?.focused }));
        const reopened = await openKeyBox();
        d.tapNative(/^cancel$/i);
        await sleep(800);
        check('model: an activity recreated with the box up takes the box with it (as Cancel): no leaked window, the key kept, the next box opens', closedWith.ok && leakedWindow.length === 0 && afterRecreate?.status?.online?.hint === '…abcd' && reopened && !keyBox().shown, `${strip(closedWith.value)}; ${leakedWindow[0] ?? 'no leak'}; reopened ${reopened}`);

        // ---- Claude online against the mock
        const endpoint = await debug('lm-endpoint', { url: mock.url });
        check('model: debug lm-endpoint points Claude online at the mock (adb reverse)', endpoint === mock.url, String(endpoint));
        await choose('online');
        await closeSettings();
        let r = await ask(9201);
        check('model: Claude online with a good key: Claude\'s line (source online, usage in the reply), the time in the log', MOCK_LINES.includes(r.engine?.text) && r.engine.source === 'online' && r.raw?.usage?.output === 6 && /#9201 Claude in \d+ ms \(input 180, cache read \d+, write \d+, output 6 tokens\)/.test(r.line ?? ''), `"${r.engine?.text}" — ${r.line}`);
        await openBotChat();
        await page.tapElement('#botchat-test');
        const tested = await waitFor(() => page.eval(`document.getElementById('botchat-test-result').textContent`).then(t => (t.startsWith('Claude:') || t.startsWith('No line') ? t : null)), 15000);
        check('model: Bot chat › Test asks Claude for one line and shows it', /^Claude: /.test(tested.value ?? '') && MOCK_LINES.includes(tested.value.slice(8)), tested.value ?? 'no answer');
        await page.tapElement('#botchat-key-set');
        const broke = await debug('lm-key-alert', { text: 'sk-ant-test-broke-3333', button: 'save' });
        check('model: debug lm-key-alert sees the real box (shown, secure, its title, the field focused) and saves', broke?.shown === true && broke.secure === true && broke.title === 'Claude API key' && broke.firstResponder === true, JSON.stringify(broke));
        await waitFor(async () => (await lastStatus())?.online?.hint === '…3333', 5000);
        await closeSettings();
        d.clearLog();
        r = await ask(9202);
        check('model: the mock fails (500): the on-device model answers instead (source local)', typeof r.engine?.text === 'string' && r.engine.text.length > 0 && r.engine.source === 'local' && !!logLine(/#9202 Claude failed: http 500 api_error; the on-device model answers/), `"${r.engine?.text}" — ${strip(logLine(/#9202 Claude failed/))}`);
        await openBotChat();
        await page.tapElement('#botchat-key-set');
        await debug('lm-key-alert', { text: 'sk-ant-test-ok-efgh', button: 'save' });
        await waitFor(async () => (await lastStatus())?.online?.hint === '…efgh', 5000);
        await closeSettings();
        await debug('lm-endpoint', { url: `http://127.0.0.1:${MOCK_PORT + 8}/v1/messages` });
        r = await ask(9203);
        check('model: Claude cannot be reached (nothing listening): the on-device model answers', r.engine?.source === 'local' && typeof r.engine.text === 'string' && !!logLine(/#9203 Claude failed: network: .*; the on-device model answers/), `"${r.engine?.text}" — ${strip(logLine(/#9203 Claude failed/))}`);
        await debug('lm-endpoint', { url: mock.url });
        await openBotChat();
        await page.tapElement('#botchat-key-set');
        await debug('lm-key-alert', { text: 'sk-ant-test-bad-0000', button: 'save' });
        await waitFor(async () => (await lastStatus())?.online?.hint === '…0000', 5000);
        await closeSettings();
        r = await ask(9204);
        const refused = await lastStatus();
        await openBotChat();
        ui = await botChat();
        check('model: a refused key (401): the on-device model answers; the status says key refused; Bot chat "refused: set it again"', r.engine?.source === 'local' && refused?.online?.valid === false && refused.online.problem === 'key refused' && ui.key === 'Ends in …0000 · refused: set it again', JSON.stringify({ source: r.engine?.source, online: refused?.online, key: ui.key }));
        await page.tapElement('#botchat-test');
        const testedBad = await waitFor(() => page.eval(`document.getElementById('botchat-test-result').textContent`).then(t => (t.startsWith('No line') ? t : null)), 15000);
        check('model: Test with the refused key: "No line: the key was refused" (no on-device fallback for the Test)', testedBad.value === 'No line: the key was refused', testedBad.value ?? 'no answer');
        const requests = await mockRequests();
        check('model: every request the mock got is the app\'s request exactly (no problems)', requests.length >= 4 && requests.every(q => q.problems.length === 0), `${requests.length} requests; ${requests.flatMap(q => q.problems).join('; ')}`);
        shot('botchat-refused');

        // ---- Remove, with the confirm box
        await page.tapElement('#botchat-key-remove');
        const confirm = await waitFor(() => page.eval(`!document.getElementById('confirm').hidden && { title: document.getElementById('confirm-title').textContent, text: document.getElementById('confirm-text').textContent, action: document.getElementById('confirm-ok').textContent }`), 3000);
        shot('remove-confirm');
        check('model: Remove asks first, in Android\'s words ("It is deleted from this phone. …")', confirm.value?.title === 'Remove the Claude key?' && confirm.value.text === KEY_REMOVE && confirm.value.action === 'Remove', JSON.stringify(confirm.value));
        await page.tapElement('#confirm-ok');
        const removed = await waitFor(async () => (await lastStatus())?.online?.keySet === false, 5000);
        ui = await botChat();
        check('model: then native removes the key: the status says not set, Bot chat "Not set"; the log says so', removed.ok && ui.key === 'Not set' && !!logLine(/\[lm\] Claude key removed/), ui.key);
        const statusesText = await allStatuses();
        check('model: no status ever carried a key (only hints)', !statusesText.includes('sk-ant'), `${(await page.eval('window.__lmTest.statuses.length'))} statuses`);
        const beforePage = (await mockRequests()).length;
        const pageFetch = await page.eval(`Promise.all([fetch('http://127.0.0.1:${MOCK_PORT}/requests').then(r => r.status, e => String(e)), fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' }).then(r => r.status, e => String(e))])`);
        check('model: the page still cannot reach the network (127.0.0.1 and api.anthropic.com: 403 from the router; the mock saw nothing)', pageFetch[0] === 403 && pageFetch[1] === 403 && (await mockRequests()).length === beforePage, JSON.stringify(pageFetch));
        check('model: debug lm-endpoint with no url: the API\'s again', (await debug('lm-endpoint', {})) === 'https://api.anthropic.com/v1/messages');

        // ---- the phone is hot: the on-device model does not run
        await choose('local');
        await closeSettings();
        d.adb('shell', 'cmd', 'thermalservice', 'override-status', '4');
        d.clearLog();
        r = await ask(9301);
        const hotStats = await bench('stats');
        check('model: thermal override 4 (critical): busy at once, the log says why; the bench says critical', r.engine?.text === null && r.engine.error === 'busy' && r.raw?.ms < 200 && /#9301 the phone is hot \(thermal status critical\): no on-device reply/.test(r.line ?? '') && hotStats?.thermal === 'critical' && hotStats.thermalStatus === 4, `${r.line}; raw ${JSON.stringify(r.raw)}; stats ${hotStats?.thermal}/${hotStats?.thermalStatus}`);
        d.adb('shell', 'cmd', 'thermalservice', 'override-status', '3');
        r = await ask(9302);
        check('model: thermal override 3 (severe, iOS\'s serious): busy too', r.engine?.error === 'busy' && /#9302 the phone is hot \(thermal status severe\)/.test(r.line ?? ''), r.line);
        d.adb('shell', 'cmd', 'thermalservice', 'override-status', '2');
        r = await ask(9303);
        check('model: thermal override 2 (moderate): the model runs', r.engine?.source === 'local' && typeof r.engine.text === 'string', `"${r.engine?.text}" — ${r.line}`);
        d.adb('shell', 'cmd', 'thermalservice', 'reset');

        // ---- the model freed in the background, and by a memory warning
        d.clearLog();
        d.adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
        const unloaded = await waitLog(/\[lm\] local model unloaded \(background\)/, 10000);
        check('model: in the background the model is freed (onStop → suspend)', unloaded.ok, strip(unloaded.value));
        await sleep(1500);
        // (the shell's sound and the chat model both act on onStop: the game muted as well, neither in the other's way)
        const mutedInBackground = !!logLine(/\[audio\] muted \(in the background\)/); // (the page is paused: the log says it)
        launch({ stop: false });
        await waitLog(/(resume|foreground) → ok/, 10000);
        await reconnect();
        await attachEngine();
        const afterHome = await debug('lm-status');
        const soundBack = (await debug('audio'))?.muted === false;
        check('model: back in front: not loaded until asked', afterHome?.status?.local?.loaded === false, JSON.stringify(afterHome?.status?.local));
        check('model: the game was muted in the background alongside the unload, and has its sound back in front', mutedInBackground && soundBack, JSON.stringify({ mutedInBackground, soundBack }));
        r = await ask(9401, { prompt: 4 });
        check('model: the next request loads it again and replies (the load in the log line)', r.engine?.source === 'local' && /\(load \d+ ms\)/.test(r.line ?? ''), `"${r.engine?.text}" — ${r.line}`);
        d.clearLog();
        d.adb('shell', 'am', 'send-trim-memory', PKG, 'RUNNING_CRITICAL');
        const warned = await waitLog(/\[lm\] local model unloaded \(memory warning\)/, 10000);
        check('model: a memory warning frees the model', warned.ok, strip(warned.value));

        // ---- an answer for a page that has gone is dropped; the next document has the status
        await openBotChat();
        await chooseThink(true);
        await closeSettings();
        d.clearLog();
        await ask(9501, { prompt: 5, wait: false });
        await sleep(300);
        await debug('reload');
        const dropped = await waitLog(/\[lm\] #9501 answered after the page reloaded: dropped/, 20000);
        check('model: an answer asked by a page that reloaded is dropped', dropped.ok, strip(dropped.value));
        await sleep(1500);
        await reconnect();
        await bootToTitle('model: reloaded');
        // (all but `loaded`: the dropped request loaded the model while the new document was starting, and a status that
        // changes between its document start and host.js's first lines reaches neither, on iOS as here; the next does)
        const nativeAfter = await page.eval('window.LostCityNative');
        const live = await debug('lm-status');
        const withoutLoaded = status => status && { ...status, local: { ...status.local, loaded: null } };
        check('model: after a reload LostCityNative.lm is the current status (the key\'s and the model\'s), and Think first is still On', sorted(withoutLoaded(nativeAfter.lm)) === sorted(withoutLoaded(live?.status)) && nativeAfter.lm?.online?.keySet === false && nativeAfter.settings?.botThink === true, JSON.stringify({ document: nativeAfter.lm, live: live?.status }));

        const leaked = d.adbQuiet('logcat', '-d').split('\n').filter(l => /sk-ant-test/.test(l));
        check('model: no key in any log line (all of logcat)', leaked.length === 0, leaked.slice(0, 3).join(' | '));
        d.adbQuiet('reverse', '--remove', `tcp:${MOCK_PORT}`);
    }

    // ================================================================================================ release
    if (ONLY.includes('release')) {
        console.log('\n== release: the release build (R8, the release key), a probe in its web bundle');
        page?.close();
        page = null;
        const game = path.join(ANDROID, 'build', 'web', 'Game');
        const index = path.join(game, 'index.html');
        if (BUILD) {
            // (a probe as build-web.mjs --autotest injects its test run; taken out again after the build)
            const html = fs.readFileSync(index, 'utf8');
            fs.writeFileSync(path.join(game, 'lmprobe.js'), probeScript());
            fs.writeFileSync(index, html.replace('<script src="worldmap.js"></script>', '<script src="worldmap.js"></script>\n    <script src="lmprobe.js"></script>'));
            try {
                gradle(':app:assembleRelease', '-PnoBuildWeb');
            } finally {
                fs.writeFileSync(index, html);
                fs.rmSync(path.join(game, 'lmprobe.js'), { force: true });
            }
        }
        const entries = apkEntries(releaseApk);
        check('release: the APK carries the model and the probe (a test build)', entries.includes(`assets/Model/${MODEL.file}`) && entries.includes('assets/Game/lmprobe.js'));
        const aligned = execFileSync('node', [path.join(ANDROID, 'test', 'native', 'check-apk-alignment.mjs'), releaseApk], { encoding: 'utf8' });
        check('release: the model is 32-byte aligned in the release APK (mmap)', /mod 32 = 0/.test(aligned), aligned.trim().split('\n').pop());
        if (fs.existsSync(debugApk)) {
            // the verbose switch a debug build keeps (in the backed-up prefs), left behind for the release build to ignore
            install(debugApk);
            d.adb('shell', 'am', 'start', '-W', '-S', '-n', ACTIVITY, '--ez', 'lostcity.verbose', 'true');
            await sleep(3000);
        }
        install(releaseApk);
        d.clearLog();
        launch();
        let done = await waitLog(/LMPROBE done/, 90000);
        if (!done.ok) {
            // (kept for a look: the whole log of a launch that never got there; then one more launch)
            fs.writeFileSync(path.join(OUT, 'release-logcat-1.txt'), d.adbQuiet('logcat', '-d', '-v', 'time'));
            console.log(`   no probe after 90 s (${path.join(OUT, 'release-logcat-1.txt')}); launching again`);
            d.clearLog();
            launch();
            done = await waitLog(/LMPROBE done/, 90000);
        }
        results.releaseRetried = existsRetry();
        const lines = d.log();
        const launchLine = lines.find(l => /\[app\] Lost City /.test(l)) ?? '';
        check('release: a release build runs (no ", debug" in the launch line)', /Lost City 1\.0 \(1\) on /.test(launchLine), strip(launchLine));
        // (the console bridge's lines; another line quoting the probe, e.g. a verbose one, is passed over)
        const probe = kind => lines.filter(l => l.includes(`LMPROBE ${kind} `)).flatMap(l => {
            try {
                return [JSON.parse(l.slice(l.indexOf(`LMPROBE ${kind} `) + `LMPROBE ${kind} `.length))];
            } catch {
                return [];
            }
        });
        const info = probe('native')[0];
        check('release: LostCityNative: not debug, the model in the app', done.ok && info?.debug === false && info.lm?.local?.available === true && info.lm.local.name === MODEL.name, JSON.stringify(info ?? null));
        const replies = probe('reply');
        results.releaseReplies = replies;
        const withNote = replies.find(rr => rr.id === 1);
        const without = replies.find(rr => rr.id === 2);
        check('release: the on-device model replies with Think first (R8 kept what JNI reaches: the load, the generation, the note)', typeof withNote?.text === 'string' && withNote.text.length > 0 && withNote.source === 'local' && withNote.timings?.think === true && withNote.timings.noteTokens > 0, JSON.stringify(withNote ?? null));
        check('release: and without it', typeof without?.text === 'string' && without.text.length > 0 && without.timings?.think === false, JSON.stringify(without ?? null));
        check('release: the timings are in the log', lines.some(l => /\[lm\] #100001 local, think on, in \d+ ms/.test(l)) && lines.some(l => /\[lm\] #100002 local, think off, in \d+ ms/.test(l)), strip(lines.find(l => /\[lm\] #100001 local/.test(l))));
        check('release: lm-bench and the debug actions are not in a release build (logged as unhandled)', lines.some(l => /unhandled native message: lm-bench/.test(l)) && lines.some(l => /unhandled native message: debug/.test(l)));
        const loadedRelease = lines.find(l => /\[lm\] local model loaded in/.test(l));
        check('release: loaded from the APK by mmap', /mmap\)/.test(loadedRelease ?? ''), strip(loadedRelease));
        check('release: the verbose switch a debug build kept is ignored (no verbose lines)', !lines.some(l => /\[host\] page started: /.test(l)), strip(lines.find(l => /page started: /.test(l))));
        // the launch extras are a debug build's: the activity is exported, and a release build takes none of them
        d.clearLog();
        d.adb('shell', 'am', 'start', '-W', '-S', '-n', ACTIVITY, '--ez', 'lostcity.verbose', 'true', '--es', 'lostcity.settings', `'${JSON.stringify({ bots: 7 })}'`, '--ei', 'lostcity.webViewFloor', '999');
        const again = await waitLog(/LMPROBE done/, 90000);
        const extraLines = d.log();
        const honoured = extraLines.filter(l => /verbose log on|settings from the launch intent|cannot start: |page started: /.test(l));
        check('release: launch extras (lostcity.verbose, .settings, .webViewFloor) are ignored: no verbose log, settings untouched, the game starts', again.ok && honoured.length === 0, honoured.length ? strip(honoured.join(' | ')) : `the probe ran again: ${again.ok}`);
        d.adb('shell', 'am', 'force-stop', PKG);
    }

    // ================================================================================================ none
    if (ONLY.includes('none')) {
        console.log('\n== none: a build without the model (-Plc.model=none)');
        page?.close();
        page = null;
        if (BUILD) gradle(':app:assembleDebug', '-PnoBuildWeb', '-Plc.model=none');
        check('none: the APK has no model', !apkEntries(debugApk).includes('assets/Model/'));
        install(debugApk);
        d.adb('shell', 'pm', 'clear', PKG);
        d.clearLog();
        launch({ settings: { seenHowToPlay: true, bots: 25 } });
        await reconnect();
        await bootToTitle('none: boot');
        d.tapNative(/^Got it$/i);
        await page.eval(RECORDER);
        const lm = await page.eval('window.LostCityNative.lm');
        check('none: LostCityNative.lm: no model (reason no-model), never a note, no key', lm?.local?.available === false && lm.local.reason === 'no-model' && lm.local.think === 'never' && !('name' in lm.local) && lm.online?.keySet === false, JSON.stringify(lm));
        check('none: Rules is the default chat model', (await page.eval('window.LostCityHost.settings.botChat')) === 'rules');
        await openBotChat();
        const ui = await botChat();
        shot('botchat-none');
        check('none: Bot chat says "Not in this build", On-device cannot be chosen, no Think first', ui.local === 'Not in this build' && JSON.stringify(ui.on) === '["Rules"]' && JSON.stringify(ui.disabled) === '["local"]' && !ui.think, JSON.stringify(ui));
        await closeSettings();
        await page.eval(`window.LostCityNativeBridge.native.postMessage({ type: 'lm', id: 77, mode: 'local', think: true, local: { system: 's', user: 'u' }, online: { system: 's', context: '', user: 'u' }, maxChars: 80, timeoutMs: 9000 })`);
        const reply = await waitFor(() => rawReply(77), 5000);
        check('none: native answers a request null, unavailable, at once', reply.value?.text === null && reply.value.error === 'unavailable' && reply.value.ms < 100, JSON.stringify(reply.value));
        await page.eval(`window.LostCityNativeBridge.native.postMessage({ type: 'lm-warm' })`);
        await sleep(1500);
        check('none: lm-warm does nothing (no load, no library problem)', !logLine(/local model loaded|library did not load/), strip(logLine(/\[lm\]/)));
    }
} catch (err) {
    check('the run finished', false, err.stack ?? String(err));
} finally {
    page?.close();
    d.adbQuiet('shell', 'cmd', 'thermalservice', 'reset');
    d.adbQuiet('reverse', '--remove', `tcp:${MOCK_PORT}`);
    d.adbQuiet('forward', '--remove', `tcp:${d.devtoolsPort}`);
    d.adbQuiet('shell', 'svc', 'power', 'stayon', 'false');
    await mock?.close();
    results.finished = new Date().toISOString();
    results.failures = failures;
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
    const timed = results.replies.filter(r => r.raw?.timings);
    if (timed.length) {
        console.log('\nreplies on the device:');
        for (const r of timed) console.log(`   #${r.id} "${r.raw.text}" — ${noteOf(r)}, prompt ${r.raw.timings.promptTokens} tokens at ${r.raw.timings.promptTps}/s, ${r.raw.timings.generatedTokens} tokens at ${r.raw.timings.generateTps}/s${r.raw.timings.loadMs ? `, load ${r.raw.timings.loadMs} ms` : ''}`);
    }
    console.log(`\n${results.checks.length - failures}/${results.checks.length} checks passed; screenshots and results.json in ${path.relative(process.cwd(), OUT) || OUT}`);
    process.exitCode = failures ? 1 : 0;
}

// The release build's probe (lmprobe.js, in a test build's web bundle only): once the world is up it asks native for two
// replies as host.js would ({type:'lm'} with the iPhone bench's first prompt, Think first on, then off), and reports what
// LostCityHost.bots.lmReply got, and LostCityNative, through the console bridge (LMPROBE lines in the native log). It
// also posts lm-bench and a debug action, which a release build must log as unhandled.
function PROBE_SOURCE() {
    const prompt = window.__lmProbePrompt;
    const log = (kind, value) => console.log(`LMPROBE ${kind} ${JSON.stringify(value)}`);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    (async () => {
        while (!(window.LostCityHost?.engineState === 'ready' && window.LostCityHost?.bots)) await sleep(250);
        const replies = new Map();
        const original = window.LostCityHost.bots.lmReply;
        window.LostCityHost.bots.lmReply = reply => {
            replies.set(reply.id, reply);
            return original(reply);
        };
        log('native', { debug: window.LostCityNative?.debug, lm: window.LostCityNative?.lm });
        const native = window.LostCityNativeBridge.native;
        for (const [id, think] of [[1, true], [2, false]]) {
            native.postMessage({ type: 'lm', id: 100000 + id, mode: 'local', think, local: prompt.local, online: prompt.online, maxChars: 80, timeoutMs: 20000 });
            const started = Date.now();
            while (!replies.has(100000 + id) && Date.now() - started < 25000) await sleep(100);
            const reply = replies.get(100000 + id) ?? { error: 'no reply' };
            log('reply', { ...reply, id });
        }
        native.postMessage({ type: 'lm-bench', id: 1, action: 'stats' });
        native.postMessage({ type: 'debug', id: 1, action: 'lm-status' });
        await sleep(500);
        log('done', { replies: replies.size });
    })();
}
// (ids above 100000: the page's own relay drops replies it did not ask for, whatever their id)
function probeScript() {
    return `// lm.mjs's release probe (a test build only)\nwindow.__lmProbePrompt = ${JSON.stringify(PROMPTS[0])};\n(${PROBE_SOURCE.toString()})();\n`;
}
