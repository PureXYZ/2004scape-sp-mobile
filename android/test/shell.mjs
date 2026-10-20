// The Android shell's emulator checks (docs/ANDROID.md §4 "Shell"): haptics, the sound mode, the loading cover and its
// hand-over, the Files app's view of the saves, the launcher icon. The real debug app on an emulator or phone, driven
// over adb and CDP as android/test/smoke.mjs drives it (lib/adb.mjs), plus the raw screen (lib/image.mjs).
//
//   node android/test/shell.mjs [--serial emulator-5556] [--no-build] [--no-install] [--only a,b] [--skip a,b]
//
// Phases (screenshots, pixel diffs and results.json in android/build/shell/):
//   haptics   every style the page sends is played (DEBUG `haptics`, dumpsys vibrator_manager's touch vibrations),
//             intensity, native's own (a refused key's warning, the fatal path's error), none with Settings › Vibration
//             off, none sent with the system's Touch feedback off
//   audio     audio focus held in front (dumpsys audio), muted and focus given back in the background, back on return;
//             a stored soundMode 'ambient' and the ringer on silent or vibrate (cmd audio set-ringer-mode) change nothing;
//             a call (emulator: adb emu gsm call) takes the focus and mutes, and its end brings both back
//   cover     the native loader against the page's own, pixel by pixel (a copy of #loading under DEBUG overlay
//             `loading`), then a cold launch filmed by screencaps: the launch screen black with no icon, the last frame
//             of the cover against the first of the page; the error screen and a notice
//   provider  the DocumentsProvider over adb `content` (an outside caller: root, listing, read, write → .bak, unchanged
//             writes skipped, hidden files) and DEBUG `documents` (create, rename, copy, move, delete as the Files app)
//   files     the system Files app (DocumentsUI) at the 2004Scape root: players/main/<name>.sav listed; a save written
//             meanwhile appears by itself (change notifications)
//   icon      the APK's icon (aapt2 badging), the launcher's app list shows the rune stones
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { ACTIVITY, ADB, ANDROID_HOME, PKG, device, sleep } from './lib/adb.mjs';
import { compare, crop, diffImage, screencap, writePng } from './lib/image.mjs';

const execFileAsync = promisify(execFile);
const ANDROID = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ANDROID, 'build', 'shell');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
};
const SERIAL = option('--serial', process.env.ANDROID_SERIAL ?? 'emulator-5554');
const ONLY = option('--only', null)?.split(',');
const SKIP = option('--skip', '')?.split(',') ?? [];
const wanted = phase => (!ONLY || ONLY.includes(phase)) && !SKIP.includes(phase);
const AUTHORITY = 'io.github.purexyz.scape2004.documents';
const STYLES = ['light', 'medium', 'heavy', 'soft', 'rigid', 'selection', 'success', 'warning', 'error'];

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

let page = null;

/** A DEBUG action and its window.__lcDebugReply (smoke.mjs's). */
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

/** A page → native message, as host.js posts it. */
const post = message => page.eval(`window.LostCityNativeBridge.native.postMessage(${JSON.stringify(message)})`);

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

function launch({ stop = true, settings = null } = {}) {
    const args = ['shell', 'am', 'start', '-W', ...(stop ? ['-S'] : []), '-n', ACTIVITY, '--ez', 'lostcity.verbose', 'true'];
    if (settings) args.push('--es', 'lostcity.settings', `'${JSON.stringify(settings)}'`);
    return d.adb(...args);
}

async function bootToTitle(label, timeoutMs = 120000) {
    const booted = await waitFor(async () => {
        const s = await page.eval(`(() => { const c = window.__client; return { title: !!c?.titleFlames, pct: c?.lastProgressPercent, engine: window.LostCityHost?.engineState, loaderHidden: document.getElementById('loading')?.hidden }; })()`);
        return s.title && s.pct === 100 && s.engine === 'ready' && s.loaderHidden ? s : null;
    }, timeoutMs, 200);
    check(`${label}: the title is up`, booted.ok, `${booted.ms} ms`);
    return booted.ok;
}

function dismissImmersiveSheet() {
    return d.tapNative(/^Got it$/i);
}

/** The vibrations dumpsys vibrator_manager lists (its recent history), as text blocks. */
function vibrations() {
    const text = d.adbQuiet('shell', 'dumpsys', 'vibrator_manager');
    const recent = text.split(/Recent vibrations:/)[1]?.split(/Aggregated vibration history:/)[0] ?? '';
    return recent.split('\n').filter(line => line.includes(PKG));
}

const audioFocusHolders = () => (d.adbQuiet('shell', 'dumpsys', 'audio').split(/Audio Focus stack entries/)[1] ?? '').split(/\n\s*\n/)[0];

/** Documents over adb `content` (the shell is an outside caller with MANAGE_DOCUMENTS, as DocumentsUI). */
const documentUri = relative => `content://${AUTHORITY}/document/${encodeURIComponent(relative ? `root/${relative}` : 'root')}`;
const childrenUri = relative => `${documentUri(relative)}/children`;
const contentQuery = uri => d.adbQuiet('shell', 'content', 'query', '--uri', uri);
const contentRead = relative => execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'content', 'read', '--uri', documentUri(relative)]);
function contentWrite(relative, bytes) {
    // (adb shell content write reads the bytes from its stdin)
    execFileSync(ADB, ['-s', SERIAL, 'shell', 'content', 'write', '--uri', documentUri(relative)], { input: bytes });
}
const ls = folder => d.adbQuiet('shell', 'run-as', PKG, 'ls', '-l', `files/Documents/${folder}`);
const names = listing => [...listing.matchAll(/_display_name=([^,]+),/g)].map(m => m[1]);

// ---------------------------------------------------------------------------------------------------- build, install

if (!argv.includes('--no-build')) {
    console.log('building the debug APK…');
    execFileSync(path.join(ANDROID, 'gradlew'), [':app:assembleDebug', '--console=plain', '-q'], { cwd: ANDROID, stdio: 'inherit' });
}
const APK = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
if (!argv.includes('--no-install')) console.log(d.install(APK));
d.adbQuiet('shell', 'settings', 'put', 'secure', 'immersive_mode_confirmations', 'confirmed');
d.adbQuiet('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
d.adbQuiet('shell', 'settings', 'put', 'system', 'user_rotation', '1');
if (SERIAL.startsWith('emulator-')) d.adbQuiet('emu', 'sensor', 'set', 'acceleration', '9.81:0:0');
d.adbQuiet('shell', 'svc', 'power', 'stayon', 'true');
d.adbQuiet('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
d.adbQuiet('shell', 'cmd', 'audio', 'set-ringer-mode', 'NORMAL');
d.adbQuiet('shell', 'settings', 'put', 'system', 'haptic_feedback_enabled', '1');

try {
    d.adb('shell', 'pm', 'clear', PKG);
    d.clearLog();
    launch({ settings: { seenHowToPlay: true, bots: 0 } });
    await reconnect();
    await bootToTitle('launch');
    if (dismissImmersiveSheet()) console.log('   (dismissed the "Viewing full screen" sheet)');

    // ------------------------------------------------------------------------------------------------ haptics
    if (wanted('haptics')) {
        await debug('haptics'); // (clears the list)
        const state = await debug('haptics-state');
        results.measures.haptics = state;
        check('haptics: the vibrator plays composition primitives (the AVD has a HAL vibrator)', state?.tier === 'composition' && state.hasVibrator === true, JSON.stringify(state));
        check('haptics: LostCityNative.haptics is true, so the page shows Settings › Vibration', await page.eval(`window.LostCityNative.haptics === true && document.getElementById('vibration-row').hidden === false`));
        const since = d.adbQuiet('shell', "date '+%m-%d %H:%M:%S.%3N'").trim(); // (the history's own time format)
        d.clearLog();
        for (const style of STYLES) {
            await post({ type: 'haptic', style });
            await sleep(400);
        }
        const played = await debug('haptics');
        check('haptics: every style the page sends is played', JSON.stringify(played) === JSON.stringify(STYLES), JSON.stringify(played));
        await sleep(500);
        // (the history is capped: count the entries that started after `since`)
        const fresh = vibrations().filter(line => line.trim().slice(0, 18) >= since);
        results.measures.vibrations = fresh;
        check('haptics: the system recorded them as touch vibrations', fresh.length >= STYLES.length && fresh.every(line => /usage: TOUCH/.test(line)), `${fresh.length} since ${since}; e.g. ${fresh.at(-1)?.trim().slice(0, 200)}`);
        const logged = STYLES.filter(style => d.log().some(line => line.includes(`[haptic] ${style}`)));
        check('haptics: the verbose log names each style', logged.length === STYLES.length, logged.join(' '));

        await post({ type: 'haptic', style: 'heavy', intensity: 0.3 });
        await post({ type: 'haptic', style: 'thud' });
        check('haptics: intensity and an unknown style (played as medium) are taken', JSON.stringify(await debug('haptics')) === JSON.stringify(['heavy', 'thud']));
        await debug('native-haptic', { style: 'warning' });
        check('haptics: native\'s own haptic (a refused key) is played', JSON.stringify(await debug('haptics')) === JSON.stringify(['warning']));
        d.clearLog();
        await post({ type: 'fatal', message: 'shell.mjs: the fatal path\'s haptic' });
        await waitLog(/FATAL \(the page shows it\)/, 3000);
        check('haptics: the fatal path plays the error haptic', JSON.stringify(await debug('haptics')) === JSON.stringify(['error']));

        await post({ type: 'settings', values: { haptics: false } });
        await sleep(300);
        await debug('native-haptic', { style: 'warning' });
        await post({ type: 'fatal', message: 'shell.mjs: Vibration off' });
        await sleep(500);
        check('haptics: with Settings › Vibration off native plays none (refused key, fatal)', JSON.stringify(await debug('haptics')) === '[]');
        await post({ type: 'settings', values: { haptics: null } });

        d.adb('shell', 'settings', 'put', 'system', 'haptic_feedback_enabled', '0');
        await sleep(300);
        const sinceOff = d.adbQuiet('shell', "date '+%m-%d %H:%M:%S.%3N'").trim();
        d.clearLog();
        await post({ type: 'haptic', style: 'medium' });
        await sleep(600);
        const off = d.log().find(line => /medium not played: Touch feedback is off/.test(line));
        check('haptics: with the system\'s Touch feedback off nothing reaches the vibrator', !!off && !vibrations().some(line => line.trim().slice(0, 18) >= sinceOff), off?.replace(/^.*\[haptic\] /, '') ?? 'no log line');
        d.adb('shell', 'settings', 'put', 'system', 'haptic_feedback_enabled', '1');
        await debug('haptics');
        // (the fatal messages left the session thinking the page failed: a reload puts it right)
        await debug('reload');
        await sleep(1500);
        await reconnect();
        await bootToTitle('haptics: reloaded');
    }

    // ------------------------------------------------------------------------------------------------ audio
    if (wanted('audio')) {
        let audio = await debug('audio');
        results.measures.audio = audio;
        check('audio: the game takes audio focus in front, sound on, muted through the WebView', audio.focus === 'held' && audio.muted === false && audio.primitive === 'webview', JSON.stringify(audio));
        const holders = audioFocusHolders();
        check('audio: dumpsys audio lists the game in the focus stack (USAGE_GAME)', holders.includes(PKG) && /USAGE_GAME/.test(holders), holders.split('\n').filter(l => l.includes(PKG)).join(' ').trim().slice(0, 240));

        d.clearLog();
        d.adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
        const muted = await waitLog(/\[audio\] muted \(in the background\)/, 8000);
        const gaveBack = d.log().some(line => /\[audio\] audio focus given back/.test(line));
        await sleep(500);
        check('audio: in the background it is muted and the focus given back', muted.ok && gaveBack && !audioFocusHolders().includes(PKG));
        d.clearLog();
        launch({ stop: false });
        const back = await waitLog(/\[audio\] sound on/, 8000);
        const regained = await waitLog(/audio focus requested: granted/, 5000);
        await reconnect();
        check('audio: back in front: sound on, focus taken again', back.ok && regained.ok);

        // no sound setting on Android (docs/ANDROID.md §1 Sound): an old 'ambient' (Mute) in the settings changes nothing,
        // nor does the ringer
        await post({ type: 'settings', values: { soundMode: 'ambient' } });
        await sleep(800);
        audio = await debug('audio');
        check('audio: a stored soundMode \'ambient\' changes nothing (focus held, sound on)', audio?.focus === 'held' && audio.muted === false && audioFocusHolders().includes(PKG), JSON.stringify(audio));
        for (const ringer of ['SILENT', 'VIBRATE']) {
            d.adb('shell', 'cmd', 'audio', 'set-ringer-mode', ringer);
            await sleep(1200);
            audio = await debug('audio');
            check(`audio: the ringer on ${ringer.toLowerCase()}: still playing`, audio?.muted === false && audio.focus === 'held', JSON.stringify(audio));
        }
        d.adbQuiet('shell', 'cmd', 'audio', 'set-ringer-mode', 'NORMAL'); // (a silent ringer rings without taking the focus)
        if (SERIAL.startsWith('emulator-')) {
            d.adbQuiet('emu', 'gsm', 'call', '5551234');
            const lost = await waitFor(async () => {
                const a = await debug('audio');
                return a?.muted && /audio focus lost/.test(a.reason) ? a : null;
            }, 8000, 300);
            check('audio: while the phone rings the focus is lost, muted', lost.ok, JSON.stringify(lost.value ?? (await debug('audio'))));
            d.adbQuiet('emu', 'gsm', 'cancel', '5551234');
            const regain = await waitFor(async () => {
                const a = await debug('audio');
                return a?.muted === false && a.focus === 'held' ? a : null;
            }, 8000, 300);
            check('audio: after the call the focus comes back, sound on', regain.ok, JSON.stringify(regain.value ?? (await debug('audio'))));
        }
        await post({ type: 'settings', values: { soundMode: null } });
        await sleep(300);
    }

    // ------------------------------------------------------------------------------------------------ cover
    if (wanted('cover')) {
        // 1. the native loader over a copy of the page's own (#loading as at boot: host.js hides the original for good)
        const geometry = await page.eval(`(() => { document.getElementById('lc-loader-copy')?.remove();
            const l = document.getElementById('loading').cloneNode(true); l.id = 'lc-loader-copy'; l.hidden = false; l.classList.remove('fade');
            l.style.background = '#000'; l.style.transition = 'none'; l.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
            document.body.appendChild(l);
            const f = l.querySelector('.loading-fill'); f.style.transition = 'none'; f.style.width = '6%';
            l.querySelector('.loading-text').textContent = 'Loading - please wait.';
            const r = e => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(v => Math.round(v * devicePixelRatio * 1000) / 1000); };
            return { dpr: devicePixelRatio, zoom: Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')), logo: r(l.querySelector('.loading-logo')), bar: r(l.querySelector('.loading-bar')) }; })()`);
        await sleep(700);
        const pageShot = screencap(d);
        await debug('overlay', { mode: 'loading' });
        await sleep(700);
        const coverShot = screencap(d);
        const ui = await debug('ui-state');
        await debug('overlay', { mode: 'hide' });
        await page.eval(`document.getElementById('lc-loader-copy')?.remove()`);
        results.measures.coverLayout = ui?.overlayLayout;
        check('cover: the native loader uses the page\'s zoom (the crisp snap)', Math.abs((ui?.overlayLayout?.zoom ?? 0) - geometry.zoom) < 1e-9, `page ${geometry.zoom}, cover ${ui?.overlayLayout?.zoom}`);
        const regions = regionsFor(geometry);
        const diffs = {};
        for (const [name, region] of Object.entries(regions)) diffs[name] = compare(pageShot, coverShot, region);
        diffs.screen = compare(pageShot, coverShot);
        results.measures.coverDiff = diffs;
        writePng(path.join(OUT, 'cover-page.png'), crop(pageShot, regions.loader));
        writePng(path.join(OUT, 'cover-native.png'), crop(coverShot, regions.loader));
        writePng(path.join(OUT, 'cover-diff.png'), diffImage(pageShot, coverShot, regions.loader));
        const summary = Object.entries(diffs).map(([k, v]) => `${k} ${v.differing}/${v.pixels} (max ${v.maxDelta})`).join('; ');
        console.log(`   cover vs page: ${summary}`);
        check('cover: the bar, its border, fill and text match the page\'s pixel for pixel', diffs.bar.differing === 0, summary);
        check('cover: the caption matches (at most 1/255 off)', diffs.caption.maxDelta <= 1, `${diffs.caption.differing} px, max ${diffs.caption.maxDelta}`);
        check('cover: the logo matches but for its nearest-neighbour phase (under 2 % of its box)', diffs.logo.differing / diffs.logo.pixels < 0.02, `${diffs.logo.differing}/${diffs.logo.pixels}`);
        check('cover: nothing differs outside the loader', diffs.screen.differing === diffs.loader.differing, `${diffs.screen.differing} on screen, ${diffs.loader.differing} in the loader`);

        // 2. a cold launch, filmed: the launch screen (black, no icon) until the cover
        const film = await filmLaunch();
        results.measures.launchFilm = film.summary;
        check('cover: the launch screen shows no icon (no rune-stone pixels before the cover)', film.splashIcon === 0, `${film.splashFrames} frame(s) between the launch and the cover, ${film.splashBlack} all black, ${film.splashIcon} with stones; ${JSON.stringify(film.summary)}`);
        await reconnect();
        await bootToTitle('cover: after the filmed launch');

        // 3. the hand-over, filmed: a reload with 250 bots (the page's loader stays up for seconds), the cover held 1.2 s
        //    after the page's loader-drawn (DEBUG cover-hold), the last frame of the cover against the first of the page
        await post({ type: 'settings', values: { bots: 250 } });
        await debug('cover-hold', { ms: 1200 });
        const handover = await filmHandover(regions);
        results.measures.handover = handover.summary;
        if (handover.cover && handover.page) {
            const parts = {};
            for (const [name, region] of Object.entries(handover.regions)) parts[name] = compare(handover.cover.image, handover.page.image, region);
            results.measures.handoverDiff = parts;
            writePng(path.join(OUT, 'handover-cover.png'), crop(handover.cover.image, regions.loader));
            writePng(path.join(OUT, 'handover-page.png'), crop(handover.page.image, regions.loader));
            writePng(path.join(OUT, 'handover-diff.png'), diffImage(handover.cover.image, handover.page.image, regions.loader));
            // the text's glyphs (white) wherever the fill has got to by then: the same pixels white in both
            const glyphs = whiteMismatch(handover.cover.image, handover.page.image, regions.bar);
            parts.textGlyphs = glyphs;
            const text = Object.entries(parts).map(([k, v]) => `${k} ${v.differing}/${v.pixels}`).join('; ');
            console.log(`   hand-over: cover frame ${handover.cover.ms} ms before the uncover, page frame ${handover.page.ms} ms after: ${text}`);
            check('cover: the hand-over changes no pixel of the bar\'s frame, its text\'s glyphs and the caption (the fill moves with the page\'s progress)', parts.barFrame.differing === 0 && glyphs.differing === 0 && parts.caption.maxDelta <= 1, text);
        } else {
            check('cover: the hand-over was filmed (a cover frame and a page frame)', false, JSON.stringify(handover.summary));
        }
        await post({ type: 'settings', values: { bots: 0 } }).catch(() => null);
        await reconnect();
        await post({ type: 'settings', values: { bots: 0 } });
        await debug('reload');
        await sleep(1500);
        await reconnect();
        await bootToTitle('cover: reloaded without bots');

        // 4. the error screen and a notice in the same look
        await debug('overlay', { mode: 'error', message: 'The game could not be loaded.\nshell.mjs: the error screen' });
        await sleep(600);
        const ui2 = d.uiDump();
        shot('cover-error');
        check('cover: the error screen has its title, message and button (uiautomator)', /Error - unable to continue!/.test(ui2) && /shell\.mjs: the error screen/.test(ui2) && /resource-id="io\.github\.purexyz\.scape2004:id\/cover_retry"/.test(ui2));
        await debug('overlay', { mode: 'hide' });
        d.clearLog();
        await debug('notice', { text: 'The game stopped unexpectedly (probably out of memory) and is restarting.' });
        await sleep(700);
        shot('cover-notice');
        check('cover: a notice shows (and is logged)', d.log().some(line => /\[host\] notice: The game stopped/.test(line)));
        await sleep(4500);
    }

    // ------------------------------------------------------------------------------------------------ provider
    if (wanted('provider')) {
        const root = contentQuery(`content://${AUTHORITY}/root`);
        check('provider: one root, "2004Scape" (Characters and the bots\' world)', /root_id=saves, document_id=root, title=2004Scape, summary=Characters and the bots' world/.test(root), root.trim());
        // a save written as the engine writes it (the router's PUT with X-LC-Body)
        const name = `shell${Date.now() % 100000}`;
        const first = Buffer.from(`first version of ${name} `.repeat(20));
        const put = async (relative, bytes) => page.eval(`fetch('save/${relative}', { method: 'PUT', headers: { 'X-LC-Body': ${JSON.stringify(bytes.toString('base64url'))}, 'X-LC-Length': '${bytes.length}' } }).then(r => r.status)`);
        check('provider: the game writes players/main/<name>.sav (router PUT)', (await put(`players/main/${name}.sav`, first)) === 204);
        const top = names(contentQuery(childrenUri('')));
        const mainList = contentQuery(childrenUri('players/main'));
        check('provider: the root lists players; players/main lists the save with its size', top.includes('players') && names(mainList).includes(`${name}.sav`) && mainList.includes(`_size=${first.length}`), `${top.join(', ')} | ${names(mainList).join(', ')}`);
        check('provider: content read gives the save\'s bytes', contentRead(`players/main/${name}.sav`).equals(first));
        const second = Buffer.from(`second version of ${name} `.repeat(25));
        contentWrite(`players/main/${name}.sav`, second);
        const written = await waitFor(() => contentRead(`players/main/${name}.sav`).equals(second), 5000, 300);
        const listing = ls('players/main');
        const bak = new RegExp(`\\s${first.length}\\s.*${name}\\.sav\\.bak`).test(listing);
        check('provider: a write from outside goes through SaveStore: the new bytes, the old as .bak', written.ok && bak, listing.trim().replace(/\n/g, ' | '));
        const gameSees = await page.eval(`fetch('save/players/main/${name}.sav').then(r => r.text())`);
        check('provider: the game reads what the Files app wrote', gameSees === second.toString());
        d.clearLog();
        contentWrite(`players/main/${name}.sav`, second);
        await waitLog(/from the Files app/, 4000);
        check('provider: writing the same bytes again leaves the .bak alone', d.log().some(line => line.includes(`wrote players/main/${name}.sav from the Files app (${second.length} B, unchanged)`)) && new RegExp(`\\s${first.length}\\s.*${name}\\.sav\\.bak`).test(ls('players/main')));
        d.adbQuiet('shell', 'run-as', PKG, 'touch', `files/Documents/players/main/.${name}.sav.1234.tmp`);
        const hidden = contentQuery(childrenUri('players/main'));
        const hiddenDoc = contentQuery(documentUri(`players/main/.${name}.sav.1234.tmp`));
        check('provider: hidden temp files are neither listed nor opened', !/\.tmp/.test(hidden) && !/_display_name/.test(hiddenDoc), hiddenDoc.trim().split('\n')[0]);
        d.adbQuiet('shell', 'run-as', PKG, 'rm', `files/Documents/players/main/.${name}.sav.1234.tmp`);

        // the Files app's own operations (through DocumentsContract, as DocumentsUI calls them)
        const docs = (op, extra = {}) => debug('documents', { op, ...extra });
        const folder = await docs('create', { parent: '', name: 'shell notes', dir: true });
        const file = await docs('create', { parent: 'shell notes', name: 'a.txt' });
        await docs('write', { path: 'shell notes/a.txt', text: 'hello from the Files app' });
        await sleep(600);
        const read = await docs('read', { path: 'shell notes/a.txt' });
        check('provider: create a folder and a file, write and read it', folder?.value === 'shell notes' && file?.value === 'shell notes/a.txt' && read?.value === 'hello from the Files app', JSON.stringify([folder, file, read]));
        const notesList = (await docs('list', { path: 'shell notes' }))?.value?.map(row => row.name) ?? [];
        check('provider: the created file\'s empty placeholder is not kept as a .bak', notesList.includes('a.txt') && !notesList.includes('a.txt.bak'), notesList.join(', '));
        const again = await docs('create', { parent: 'shell notes', name: 'a.txt' });
        check('provider: creating a name that exists picks "a (1).txt"', again?.value === 'shell notes/a (1).txt', JSON.stringify(again));
        const bad = await docs('create', { parent: 'shell notes', name: '.hidden' });
        check('provider: a hidden name is refused', bad?.ok === false, JSON.stringify(bad));
        const renamed = await docs('rename', { path: 'shell notes/a.txt', name: 'b.txt' });
        const clash = await docs('rename', { path: 'shell notes/b.txt', name: 'a (1).txt' });
        check('provider: rename, never onto an existing file', renamed?.value === 'shell notes/b.txt' && clash?.ok === false, JSON.stringify([renamed, clash]));
        const copied = await docs('copy', { path: 'shell notes/b.txt', to: '' });
        const moved = await docs('move', { path: 'shell notes/a (1).txt', to: '' });
        check('provider: copy and move within the folder', copied?.value === 'b.txt' && moved?.value === 'a (1).txt' && (await docs('read', { path: 'b.txt' }))?.value === 'hello from the Files app', JSON.stringify([copied, moved]));
        const deleted = await docs('delete', { path: 'b.txt' });
        const afterDelete = (await docs('list', { path: '' }))?.value?.map(row => row.name) ?? [];
        check('provider: delete keeps a save with no .bak as its .bak (the DELETE route\'s rule)', deleted?.ok && afterDelete.includes('b.txt.bak') && !afterDelete.includes('b.txt'), afterDelete.join(', '));
        await docs('delete', { path: 'b.txt.bak' });
        await docs('delete', { path: 'a (1).txt' });
        await docs('delete', { path: 'a (1).txt.bak' });
        await docs('delete', { path: 'shell notes' });
        const cleaned = (await docs('list', { path: '' }))?.value?.map(row => row.name) ?? [];
        check('provider: deleting a .bak removes it; a folder goes with its files', !cleaned.some(n => /^b\.txt|^a \(1\)|^shell notes/.test(n)), cleaned.join(', '));
        // the README's restore: delete <name>.sav (beside its .bak, so removed outright and the .bak kept), rename the .bak
        await docs('delete', { path: `players/main/${name}.sav` });
        const restored = await docs('rename', { path: `players/main/${name}.sav.bak`, name: `${name}.sav` });
        check('provider: deleting a save keeps the .bak beside it; renaming <name>.sav.bak restores the previous save', restored?.value === `players/main/${name}.sav` && contentRead(`players/main/${name}.sav`).equals(first), JSON.stringify(restored));
        results.saveName = name;
    }

    // ------------------------------------------------------------------------------------------------ files (DocumentsUI)
    if (wanted('files')) {
        const name = results.saveName ?? `shell${Date.now() % 100000}`;
        if (!results.saveName) {
            const bytes = Buffer.from(`save of ${name}`);
            await page.eval(`fetch('save/players/main/${name}.sav', { method: 'PUT', headers: { 'X-LC-Body': ${JSON.stringify(bytes.toString('base64url'))}, 'X-LC-Length': '${bytes.length}' } }).then(r => r.status)`);
        }
        d.adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `content://${AUTHORITY}/root/saves`, '-t', 'vnd.android.document/root');
        const rootShown = await waitFor(() => /text="players"/.test(d.uiDump()) && /2004Scape/.test(d.uiDump()), 10000, 600);
        if (d.tapNative(/^List view$/)) await sleep(1000); // (the grid puts file names below the screen)
        shot('files-root');
        check('files: the Files app opens the 2004Scape root and lists players', rootShown.ok);
        const opened = d.tapNative(/^players$/) && (await waitFor(() => /text="main"/.test(d.uiDump()), 6000, 600)).ok && d.tapNative(/^main$/);
        const listed = await waitFor(() => d.uiDump().includes(`text="${name}.sav"`), 8000, 600);
        shot('files-players-main');
        check(`files: players/main/${name}.sav is listed in the Files app`, opened && listed.ok);
        // a save written while the Files app shows the folder appears by itself (SaveStore.onChange → notifyChange)
        contentWrite(`players/main/${name}-notify.sav`, Buffer.from('written while the Files app looks'));
        const appeared = await waitFor(() => d.uiDump().includes(`text="${name}-notify.sav"`), 20000, 600);
        shot('files-notified');
        check('files: a save written meanwhile appears without a refresh (change notification)', appeared.ok, `${appeared.ms} ms (DocumentsUI reloads a few seconds after the notification)`);
        await page.eval(`fetch('save/players/main/${name}-notify.sav', { method: 'DELETE' }).then(r => r.status)`).catch(() => null);
        // (a DocumentsUI left running restarts this app for its provider after every install or clear: smoke.mjs's cold boot)
        d.adbQuiet('shell', 'am', 'force-stop', 'com.google.android.documentsui');
        launch({ stop: false });
        await reconnect();
    }

    // ------------------------------------------------------------------------------------------------ icon
    if (wanted('icon')) {
        const tools = fs.readdirSync(path.join(ANDROID_HOME, 'build-tools')).sort().reverse();
        const aapt2 = path.join(ANDROID_HOME, 'build-tools', tools[0], 'aapt2');
        const badging = execFileSync(aapt2, ['dump', 'badging', APK], { encoding: 'utf8' });
        const icons = badging.split('\n').filter(line => /^application-icon|^application: /.test(line));
        check('icon: the APK names the adaptive icon (mipmap ic_launcher) and the label 2004Scape', /application-label:'2004Scape'/.test(badging) && /application: label='2004Scape' icon='res\/mipmap-anydpi(-v\d+)?\/ic_launcher\.xml'/.test(badging), icons.join(' | ').slice(0, 300));
        d.adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
        await sleep(1500);
        let tries = 0;
        const found = await waitFor(() => {
            // the app list: the all-apps key, else a swipe up on the home screen
            if (tries++ % 3 === 0) d.adbQuiet('shell', 'input', 'keyevent', tries === 1 ? 'KEYCODE_ALL_APPS' : 'KEYCODE_HOME');
            else if (tries % 3 === 2) d.adbQuiet('shell', 'input', 'swipe', '1200', '1000', '1200', '150', '300');
            const xml = d.uiDump();
            const node = (xml.match(/<node [^>]*>/g) ?? []).find(n => /(text|content-desc)="2004Scape"/.test(n) && /bounds=/.test(n));
            return node ? /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node).slice(1).map(Number) : null;
        }, 20000, 900);
        if (found.ok) {
            const [x1, y1, x2, y2] = found.value;
            const image = screencap(d);
            // the launcher's icon cell is the app's node: the icon above its label
            const region = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
            writePng(path.join(OUT, 'icon-launcher.png'), crop(image, region));
            // the icon is the upper part of the cell: the stones' blue-grey and the dark cobblestone and letters (the
            // wallpaper may be blue-grey too, never that dark)
            let stone = 0;
            let dark = 0;
            for (let y = region.y; y < region.y + Math.round(region.h * 0.65); y++) {
                for (let x = region.x; x < region.x + region.w; x++) {
                    const i = (y * image.width + x) * 4;
                    const [r, g, b] = [image.data[i], image.data[i + 1], image.data[i + 2]];
                    if (b > 120 && b < 230 && Math.abs(r - g) < 25 && b - r > 8 && b - r < 60) stone++;
                    if (r + g + b < 90) dark++;
                }
            }
            check('icon: the launcher shows 2004Scape with the rune stones on dark cobblestone', stone > 1000 && dark > 2000, `${stone} stone and ${dark} dark px in the icon of the cell ${JSON.stringify(region)}`);
        } else {
            check('icon: the launcher lists 2004Scape', false, 'not found in the app list');
        }
        shot('launcher');
        launch({ stop: false });
    }
} catch (err) {
    check('the run finished', false, err.stack ?? String(err));
} finally {
    page?.close();
    d.adbQuiet('forward', '--remove', `tcp:${d.devtoolsPort}`);
    d.adbQuiet('shell', 'cmd', 'audio', 'set-ringer-mode', 'NORMAL');
    d.adbQuiet('shell', 'settings', 'put', 'system', 'haptic_feedback_enabled', '1');
    d.adbQuiet('shell', 'svc', 'power', 'stayon', 'false');
    results.finished = new Date().toISOString();
    results.failures = failures;
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
    console.log(`\n${results.checks.length - failures}/${results.checks.length} checks passed; screenshots and results.json in ${path.relative(process.cwd(), OUT) || OUT}`);
    process.exitCode = failures ? 1 : 0;
}

/** The loader's parts on screen, in device px, from the page's own boxes (with a few px of margin for anti-aliasing). */
function regionsFor(g) {
    const [lx, ly, lw, lh] = g.logo;
    const [bx, by, bw, bh] = g.bar;
    const box = (x, y, w, h) => ({ x: Math.max(0, Math.floor(x)), y: Math.max(0, Math.floor(y)), w: Math.ceil(w), h: Math.ceil(h) });
    const unit = g.dpr * g.zoom; // device px per layer CSS px
    return {
        loader: box(lx - 4, ly - 4, lw + 8, by + bh + 34 * unit - ly + 8),
        logo: box(lx - 2, ly - 2, lw + 4, lh + 4),
        bar: box(bx - 2, by - 2, bw + 4, bh + 4),
        barFrame: box(bx - 2, by - 2, bw + 4, Math.floor(2 * unit) + 1), // the top border, not the fill below it
        text: box(bx + 24 * unit, by + 3 * unit, bw - 27 * unit, bh - 6 * unit), // (right of the fill)
        caption: box(lx, by + bh + 8 * unit, lw, 18 * unit)
    };
}

/** Back-to-back screencaps on the device's clock until `stop()`. */
function startCamera() {
    const deviceNow = () => Number(d.adbQuiet('shell', 'date', '+%s%3N').trim());
    const t0 = Date.now();
    const offset = deviceNow() - Math.round((t0 + Date.now()) / 2); // device ms − host ms
    const frames = [];
    let filming = true;
    const done = (async () => {
        while (filming) {
            const start = Date.now();
            try {
                const { stdout } = await execFileAsync(ADB, ['-s', SERIAL, 'exec-out', 'screencap'], { encoding: 'buffer', maxBuffer: 128 << 20 });
                const width = stdout.readUInt32LE(0);
                const height = stdout.readUInt32LE(4);
                frames.push({ start: start + offset, end: Date.now() + offset, image: { width, height, data: stdout.subarray(stdout.length - width * height * 4) } });
            } catch {
                // (a frame lost)
            }
        }
    })();
    return { frames, stop: async () => { filming = false; await done; } };
}

/** The device time of the first native log line matching `pattern`. */
function logTime(lines, pattern) {
    const line = lines.find(l => pattern.test(l));
    const m = line && /^(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d\d\d)/.exec(line);
    return m ? new Date(new Date().getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}

/** A reload filmed: the cover (held by cover-hold) over the page's loader, then the page's loader alone. */
async function filmHandover(regions) {
    d.clearLog();
    const camera = startCamera();
    await sleep(200);
    await debug('reload');
    await sleep(6500);
    await camera.stop();
    const lines = d.log();
    const covered = logTime(lines, /the cover stays \d+ ms \(cover-hold\)/);
    const uncovered = logTime(lines, /the page's loader is drawn: uncovering/);
    const covers = covered && uncovered ? camera.frames.filter(f => f.start > covered && f.end < uncovered) : [];
    const pages = uncovered ? camera.frames.filter(f => f.start > uncovered + 300 && loaderOnScreen(f.image)) : [];
    const cover = covers.at(-1);
    const pageFrame = pages[0];
    const unit = (regions.bar.w - 4) / 304; // device px per layer CSS px
    return {
        cover: cover && { image: cover.image, ms: uncovered - cover.end },
        page: pageFrame && { image: pageFrame.image, ms: pageFrame.start - uncovered },
        regions: {
            logo: regions.logo,
            barFrame: regions.barFrame,
            // the bar right of its middle: the fill reaches there only past half the progress
            caption: regions.caption
        },
        summary: { frames: camera.frames.length, covers: covers.length, pages: pages.length, holdMs: covered && uncovered ? uncovered - covered : null, frameMs: camera.frames.length ? Math.round(camera.frames.reduce((s, f) => s + f.end - f.start, 0) / camera.frames.length) : null }
    };
}

/** Pixels white (the bar's text) in one image and not in the other, in a region. */
function whiteMismatch(a, b, region) {
    let differing = 0;
    let white = 0;
    for (let y = region.y; y < region.y + region.h; y++) {
        for (let x = region.x; x < region.x + region.w; x++) {
            const i = (y * a.width + x) * 4;
            const wa = a.data[i] > 200 && a.data[i + 1] > 200 && a.data[i + 2] > 200;
            const wb = b.data[i] > 200 && b.data[i + 1] > 200 && b.data[i + 2] > 200;
            if (wa) white++;
            if (wa !== wb) differing++;
        }
    }
    return { pixels: white, differing };
}

/** The loader's bar on screen (its red border in the middle of the screen). */
function loaderOnScreen(image) {
    const y = Math.round(image.height * 0.66);
    let red = 0;
    for (let x = Math.round(image.width * 0.3); x < Math.round(image.width * 0.7); x++) {
        for (let yy = y - 40; yy < y + 40; yy++) {
            const i = (yy * image.width + x) * 4;
            if (image.data[i] > 120 && image.data[i + 1] < 40 && image.data[i + 2] < 40) red++;
        }
    }
    return red > 500;
}

/** A cold launch filmed: the frames after the process started and before the cover (the system's launch screen). */
async function filmLaunch() {
    page?.close();
    page = null;
    d.adb('shell', 'am', 'force-stop', PKG);
    await sleep(800);
    d.clearLog();
    const camera = startCamera();
    await sleep(300);
    execFile(ADB, ['-s', SERIAL, 'shell', 'am', 'start', '-n', ACTIVITY]);
    await sleep(3500);
    await camera.stop();
    const lines = d.log();
    const launched = logTime(lines, /\[app\] Lost City/);
    const uncovered = logTime(lines, /the page's loader is drawn: uncovering/);
    // (the launcher is on screen until the launch screen covers it: only frames after the process started count)
    const splash = camera.frames.filter(f => launched !== null && f.start > launched && !loaderOnScreen(f.image) && (uncovered === null || f.end < uncovered));
    const count = (image, test) => {
        let n = 0;
        for (let y = Math.round(image.height * 0.25); y < Math.round(image.height * 0.75); y += 2) {
            for (let x = Math.round(image.width * 0.3); x < Math.round(image.width * 0.7); x += 2) {
                const i = (y * image.width + x) * 4;
                if (test(image.data[i], image.data[i + 1], image.data[i + 2])) n++;
            }
        }
        return n;
    };
    const lit = (r, g, b) => r + g + b > 30;
    const stone = (r, g, b) => b > 120 && b < 230 && Math.abs(r - g) < 25 && b - r > 8 && b - r < 60; // the icon's blue-grey
    return {
        splashFrames: splash.length,
        splashBlack: splash.filter(f => count(f.image, lit) === 0).length,
        splashIcon: splash.filter(f => count(f.image, stone) > 100).length,
        summary: { frames: camera.frames.length, launchToUncoverMs: launched && uncovered ? uncovered - launched : null, splash: splash.length, frameMs: camera.frames.length ? Math.round(camera.frames.reduce((sum, f) => sum + f.end - f.start, 0) / camera.frames.length) : null }
    };
}
