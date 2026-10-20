#!/usr/bin/env node
// The HUD gallery: renders the host page (web/host, served live from the source folder) around a stub client that
// draws captured game pixels (capture.mjs), in every HUD state at every phone size, and screenshots each one. A full
// run takes well under a minute, so layout and style changes can be checked on all sizes without playing the game.
//
//   node web/test/gallery/gallery.mjs [--port 47570] [--only state1,state2] [--devices mini,se,ipad-mini] [--scale 2] [--game <dir>]
//        [--platform android] [--host <dir>] [--out <dir>]
//   (default devices: mini, phone, max, se; ipad, ipad-mini, se-zoomed and mini-zoomed only when named)
//   → build/tmp/gallery/shots/<device>-<state>.png (or <out>/shots)   (run capture.mjs once first)
//
// --platform android (or Android devices named in --devices; 'android' names them all): the Android screens of
// web/test/android-stub.mjs at their real device pixel ratio (2.625 is where the 2004 pixels would go soft: --scale does
// not apply to them), WebView's user agent and the Android app's LostCityNative and bridge (its words: no silent
// switch, Files > 2004Scape...). Each Android shot also checks the HUD's zoom and the world's render size the page chose for the
// screen against the expected ones (the crisp pixel snap: docs/ANDROID.md §1), and the Settings pages fit in the HUD px
// the zoom leaves (360 on a 914x411 phone). Two more states: sound (Settings › Sound) and typing-android (the
// chatbox above Gboard's landscape height, 270 px, with Android's IME curve).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ANDROID_SCREENS, ANDROID_UA, androidPageScript } from '../android-stub.mjs';
import { serve } from '../serve.mjs';
import { IPHONE_UA, launch, sleep } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IOS = path.resolve(HERE, '..', '..', '..');
const argv0 = process.argv.slice(2);
// --host <dir>: another copy of web/host (e.g. an earlier commit's, to compare shots before and after a change)
const HOST = argv0.includes('--host') ? path.resolve(argv0[argv0.indexOf('--host') + 1]) : path.join(IOS, 'web', 'host');
const OUT = path.join(IOS, 'build', 'tmp', 'gallery');
const FIXTURES = path.join(OUT, 'fixtures');
// --out <dir>: the shots, Chrome's profile and the saves somewhere else (two runs at once, on two ports)
const RUN = argv0.includes('--out') ? path.resolve(argv0[argv0.indexOf('--out') + 1]) : OUT;
const SHOTS = path.join(RUN, 'shots');

const argv = process.argv.slice(2);
const option = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const GAME = path.resolve(option('game', path.join(IOS, 'build', 'Game'))); // (the HUD's fonts and sprites)
const PORT = Number(option('port', 47570));
const SCALE = Number(option('scale', 2));
const ONLY = option('only', '').split(',').filter(Boolean);
const PLATFORM = option('platform', 'ios');
if (PLATFORM !== 'ios' && PLATFORM !== 'android') {
    console.error('--platform takes ios (the default) or android');
    process.exit(2);
}
const DEVICE_FILTER = option('devices', PLATFORM === 'android' ? 'android' : '')
    .split(',')
    .filter(Boolean)
    .flatMap(name => (name === 'android' ? Object.keys(ANDROID_SCREENS) : [name]));

export const DEVICES = {
    mini: { view: { width: 812, height: 375 }, safe: { top: 0, right: 50, bottom: 21, left: 50 } }, // iPhone 12/13 mini
    phone: { view: { width: 844, height: 390 }, safe: { top: 0, right: 47, bottom: 21, left: 47 } }, // iPhone 13/14
    max: { view: { width: 932, height: 430 }, safe: { top: 0, right: 59, bottom: 21, left: 59 } }, // iPhone Pro Max
    se: { view: { width: 667, height: 375 }, safe: { top: 0, right: 0, bottom: 0, left: 0 } }, // iPhone SE
    // only with --devices: an iPad Air and an iPad mini (the HUD ×1.5), an SE with Display Zoom (the smallest screen), an
    // iPhone 13 mini with Display Zoom
    ipad: { view: { width: 1180, height: 820 }, safe: { top: 0, right: 0, bottom: 20, left: 0 } },
    'ipad-mini': { view: { width: 1133, height: 744 }, safe: { top: 0, right: 0, bottom: 20, left: 0 } },
    'se-zoomed': { view: { width: 568, height: 320 }, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
    'mini-zoomed': { view: { width: 693, height: 320 }, safe: { top: 0, right: 44, bottom: 21, left: 44 } },
    // Android (web/test/android-stub.mjs): their own pixel ratio, the Android app's page
    ...Object.fromEntries(Object.entries(ANDROID_SCREENS).map(([name, screen]) => [name, { ...screen, platform: 'android' }]))
};
const DEFAULT_DEVICES = ['mini', 'phone', 'max', 'se'];

if (!fs.existsSync(path.join(FIXTURES, 'fixtures.json'))) {
    console.error('no fixtures: run node web/test/gallery/capture.mjs first');
    process.exit(1);
}

const file = (p, type) => () => ({ body: fs.readFileSync(p), type });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
const routes = {
    '/': file(path.join(HOST, 'index.html'), MIME['.html']),
    '/client/client.js': file(path.join(HERE, 'stub-client.js'), MIME['.js']),
    '/engine/boot.js': file(path.join(HERE, 'stub-engine.js'), MIME['.js']),
    // (the game build's own when there is one: Settings' version line wraps like the app's)
    '/build-info.json': () =>
        fs.existsSync(path.join(GAME, 'build-info.json'))
            ? { body: fs.readFileSync(path.join(GAME, 'build-info.json')), type: MIME['.json'] }
            : { body: JSON.stringify({ engine: 'stub', content: 'stub', webclient: 'stub', builtAt: 'gallery' }), type: MIME['.json'] },
    '/save-index': () => ({
        body: JSON.stringify([
            { path: 'players/main/gal10074.sav', size: 900, modified: Date.now() - 3600e3 },
            { path: 'players/main/zezima.sav', size: 900, modified: Date.now() - 3 * 86400e3 },
            { path: 'players/main/bob_the_builder.sav', size: 900, modified: Date.now() - 20 * 86400e3 },
            { path: 'players/main/zezima.sav.bak', size: 900, modified: Date.now() },
            { path: 'bots/main/bots.sav', size: 48000, modified: Date.now() - 600e3 }
        ]),
        type: MIME['.json']
    })
};
for (const name of fs.readdirSync(HOST)) {
    routes[`/${name}`] = () => ({ body: fs.readFileSync(path.join(HOST, name)), type: MIME[path.extname(name)] ?? 'application/octet-stream' });
}
for (const name of fs.readdirSync(FIXTURES)) {
    routes[`/fixtures/${name}`] = file(path.join(FIXTURES, name), MIME[path.extname(name)]);
}
for (const name of ['main_file_cache.dat', 'main_file_cache.idx0', 'main_file_cache.idx1', 'main_file_cache.idx2', 'main_file_cache.idx3', 'main_file_cache.idx4']) {
    routes[`/cache/${name}`] = () => ({ body: Buffer.alloc(0), type: 'application/octet-stream' });
}

// ---------------------------------------------------------------------------------------------------- states

const tapSel = async (page, selector) => {
    const r = await page.rect(selector);
    if (!r?.visible) {
        throw new Error(`${selector} is not on screen`);
    }
    await page.tap(r.cx, r.cy);
    await sleep(250);
};
const stub = (page, patch) => page.evaluate(`window.__stub.set(${JSON.stringify(patch)})`);

export const STATES = {
    world: async () => {},
    inventory: async page => tapSel(page, '#hud-tabs .tab[data-tab="3"]'),
    // tap-to-drop on: the knob red, the inventory's frame red
    'inventory-drop': async page => {
        await tapSel(page, '#hud-tabs .tab[data-tab="3"]');
        await tapSel(page, '#btn-drop');
    },
    stats: async page => tapSel(page, '#hud-tabs .tab[data-tab="1"]'),
    chat: async page => tapSel(page, '#btn-chat-toggle'),
    'chat-panel': async page => {
        await tapSel(page, '#hud-tabs .tab[data-tab="3"]');
        await tapSel(page, '#btn-chat-toggle');
    },
    dialogue: async page => {
        await tapSel(page, '#hud-tabs .tab[data-tab="3"]');
        await stub(page, { chatModal: true });
    },
    bank: async page => stub(page, { mainModal: true, sideModal: true }),
    'dialogue-options': async page => {
        await tapSel(page, '#hud-tabs .tab[data-tab="3"]');
        await stub(page, { chatModal: true, dialogOptions: ['Yes, I would like to buy some.', 'No thanks.', 'Can you tell me about this place?', 'What is this @red@dangerous@bla@ thing?'] });
    },
    tutorial: async page => {
        const tabs = new Array(15).fill(false);
        tabs[10] = tabs[11] = true;
        await stub(page, { tutorialChat: true, tabs, flashingTab: 11, runExists: false });
    },
    // a long-press: the finger goes down and the client opens its menu while it is held (then lifts without sliding)
    menu: async page => {
        const r = await page.rect('#surface-game');
        await page.touch('touchStart', [{ x: r.w * 0.45, y: r.h * 0.5 }]);
        await sleep(100);
        await page.evaluate(`window.__stub.openMenu(0, ['Walk here', 'Talk-to @yel@Hans', 'Examine @yel@Hans', 'Attack @yel@Man @gre@(level-2)', 'Pickpocket @yel@Man', 'Examine @yel@Man', 'Cancel'])`);
        await sleep(150);
        await page.touch('touchEnd', []);
    },
    'menu-inventory': async page => {
        await tapSel(page, '#hud-tabs .tab[data-tab="3"]');
        const r = await page.rect('#surface-side');
        await page.touch('touchStart', [{ x: r.x + r.w * 0.6, y: r.y + r.h * 0.4 }]);
        await sleep(100);
        await page.evaluate(`window.__stub.openMenu(1, ['Eat @lre@Shrimps', 'Use @lre@Shrimps', 'Drop @lre@Shrimps', 'Examine @lre@Shrimps', 'Cancel'])`);
        await sleep(150);
        await page.touch('touchEnd', []);
    },
    'press-ring': async page => {
        const r = await page.rect('#surface-game');
        await page.touch('touchStart', [{ x: r.w * 0.45, y: r.h * 0.5 }]);
        await sleep(330);
        await page.screenshot(path.join(SHOTS, `${page.device}-press-ring.png`)); // (while held)
        await page.touch('touchEnd', []);
        return 'shot';
    },
    // Settings: the categories down the left, Display's rows on the right
    settings: async page => {
        await settingsSection(page, 'display');
    },
    // World: its five rows and Restart, without scrolling on every phone, 360 HUD px tall and up (not on Display Zoom's 320)
    'settings-world': async page => {
        await settingsSection(page, 'world', 360);
    },
    // Settings › Saved data (the stub's character is in the world: no Delete for it), and its "Are you sure?"
    savedata: async page => {
        await page.evaluate(`window.__client.loginUser = 'gal10074'`);
        await tapSel(page, '#btn-settings');
        await page.evaluate(`document.getElementById('nav-savedata').click()`);
        await page.waitFor(`document.querySelectorAll('#savedata-characters .data-row').length === 3 && /47 bots/.test(document.getElementById('savedata-bots').textContent)`, 5000, 50);
        await settingsSection(page, 'savedata');
    },
    // Settings › Bot chat (host.js botChat) as the app shows it: a model in the app trained both ways (Think first shows), a
    // Claude key that works, a Test's line (STATE_INIT below gives the page a stub native and its status)
    botchat: async page => {
        await settingsSection(page, 'botchat');
        await page.evaluate(`document.getElementById('botchat-test-result').textContent = 'Claude: yo nm just chillin at varrock west'`);
        if (await page.evaluate(`document.getElementById('botchat-think').hidden`)) {
            throw new Error('Think first is hidden although the status offers it');
        }
    },
    // Settings › Tap options: what a tap does with Attack, on NPCs and players
    tapoptions: async page => {
        await settingsSection(page, 'tapoptions', 360);
    },
    // Settings › About: the version line, the disclaimer, the credits, Licences (on screen without scrolling, 360 HUD px
    // tall and up)
    about: async page => {
        await settingsSection(page, 'about', 360);
        await page.waitFor(`/^2004Scape \\d/.test(document.getElementById('about-version').textContent)`, 5000, 50);
    },
    // ...and its Licences: licenses.txt in a sheet over Settings
    licences: async page => {
        await settingsSection(page, 'about');
        await page.evaluate(`document.getElementById('about-licences').click()`);
        const loaded = await page.waitFor(`document.getElementById('licences-text').textContent.startsWith('2004Scape: licences')`, 5000, 50);
        if (!loaded.ok) {
            throw new Error('licenses.txt did not load (build/Game/licenses.txt: node scripts/build-web.mjs)');
        }
        const r = await page.evaluate(`(() => { const p = document.querySelector('#licences .settings-panel').getBoundingClientRect(); const t = document.getElementById('licences-text'); return { panel: [p.left, p.top, p.right, p.bottom].map(Math.round), wide: t.scrollWidth > t.clientWidth + 1, view: [innerWidth, innerHeight] }; })()`);
        const safe = DEVICES[page.device].safe;
        if ((r.panel[0] < safe.left || r.panel[1] < safe.top || r.panel[2] > r.view[0] - safe.right || r.panel[3] > r.view[1])) {
            throw new Error(`the Licences sheet runs out of the safe area: ${JSON.stringify(r)}`);
        }
        if (r.wide) {
            throw new Error(`the licences are wider than their sheet: ${JSON.stringify(r)}`);
        }
    },
    'savedata-confirm': async page => {
        await tapSel(page, '#btn-settings');
        await page.evaluate(`document.getElementById('nav-savedata').click()`);
        await page.waitFor(`document.querySelectorAll('#savedata-characters .data-row').length === 3`, 5000, 50);
        await page.evaluate(`document.querySelector('#savedata-characters .data-row:nth-child(2) .data-btn').click()`);
        await sleep(200);
    },
    howto: async page => {
        await tapSel(page, '#btn-settings');
        await page.evaluate(`document.getElementById('settings-howto').click()`);
    },
    title: async page => {
        await stub(page, { title: true });
        await sleep(600);
    },
    'title-characters': async page => {
        await stub(page, { title: true });
        await sleep(600);
        await tapSel(page, '#btn-characters');
    },
    'title-typing': async page => {
        await stub(page, { title: true, loginscreen: 2 });
        await page.evaluate(`(() => { const c = window.__client; c.loginscreen = 2; window.LostCityHost.keyboard.show(); window.LostCityHost.keyboard.frame(239, 0); })()`);
        await sleep(300);
    },
    typing: async page => {
        await page.evaluate(`(() => { window.LostCityHost.keyboard.show(); window.LostCityHost.keyboard.frame(239, 0); })()`);
        await sleep(300);
    },
    // Android: Gboard in landscape (about 226 px and the app's 44 px bar), the IME's own duration and curve
    'typing-android': async page => {
        if (DEVICES[page.device].platform !== 'android') {
            return 'skip';
        }
        await tapSel(page, '#hud-tabs .tab[data-tab="3"]');
        const covered = page.device === 'a-tablet' ? 400 : 270;
        await page.evaluate(`(() => { window.LostCityHost.keyboard.show(); window.LostCityHost.keyboard.frame(${covered}, 0.285, 'cubic-bezier(0.2, 0, 0, 1)'); })()`);
        await sleep(600);
        const curve = await page.evaluate(`document.getElementById('hud-chat-box').style.transition`);
        if (!/cubic-bezier\(0\.2, 0, 0, 1\)/.test(curve)) {
            throw new Error(`the chatbox's lift does not use the IME's curve: ${curve}`);
        }
    },
    // Settings › Sound: the silent switch and Vibration (iPhone), Vibration only (Android: a phone has no silent switch)
    sound: async page => {
        await settingsSection(page, 'sound', 320);
        const shown = await page.evaluate(`!document.getElementById('sound-row').hidden`);
        const want = DEVICES[page.device].platform !== 'android';
        if (shown !== want) {
            throw new Error(`the silent switch row is ${shown ? 'shown' : 'hidden'} on ${DEVICES[page.device].platform ?? 'ios'}`);
        }
    },
    'tutorial-collapsed': async page => {
        const tabs = new Array(15).fill(false);
        tabs[10] = tabs[11] = true;
        await stub(page, { tutorialChat: true, tabs, flashingTab: 11, runExists: false, tutorialKey: 'step1' });
        await sleep(200);
        await tapSel(page, '#btn-chat-toggle');
    },
    camera: async page => {
        await page.evaluate(`(() => { const s = window.LostCityHost.settings; })()`);
        await page.evaluate(`document.querySelector('.seg[data-setting="cameraButtons"] button[data-value="true"]')?.click()`);
    },
    // the camera pad above a dialogue's two answers, and giving way to five (no room above them on a phone)
    'camera-dialogue2': async page => {
        await page.evaluate(`document.querySelector('.seg[data-setting="cameraButtons"] button[data-value="true"]')?.click()`);
        await stub(page, { chatModal: true, dialogOptions: ['Yes please.', 'No thanks.'] });
    },
    'camera-dialogue5': async page => {
        await page.evaluate(`document.querySelector('.seg[data-setting="cameraButtons"] button[data-value="true"]')?.click()`);
        await stub(page, { chatModal: true, dialogOptions: ['Yes, I would like to buy some.', 'No thanks.', 'Can you tell me about this place?', 'What is this @red@dangerous@bla@ thing?', 'Goodbye.'] });
    },
    // typing with the panel open: the chatbox above the keyboard, scaled to fit beside what shows at its height
    'typing-panel': async page => {
        await tapSel(page, '#hud-tabs .tab[data-tab="3"]');
        const covered = page.device.startsWith('ipad') ? 400 : 239; // the keyboard and its bar
        await page.evaluate(`(() => { window.LostCityHost.keyboard.show(); window.LostCityHost.keyboard.frame(${covered}, 0); })()`);
        await sleep(300);
    },
    // a game message on Tutorial Island: in the chatbox beside the open panel (no dialogue: the panel stays)
    'tutorial-message': async page => {
        await stub(page, { tutorialChat: true, tabs: new Array(15).fill(true), runExists: false });
        await tapSel(page, '#hud-tabs .tab[data-tab="3"]');
        await stub(page, { tutorialMessage: true });
    },
    // a tab tapped while a window without a side panel is open: its panel over the window, which stays where it is
    'window-panel': async page => {
        await stub(page, { mainModal: true, world: 'world-bank' });
        await tapSel(page, '#hud-tabs .tab[data-tab="3"]');
    },
    // the World map (the real map applet: client/mapview.js and worldmap.jag from the game build), centred on the stub's
    // player in Lumbridge; with the Key and a key flashing, with the overview, and underground
    worldmap: async page => openWorldMap(page),
    'worldmap-key': async page => {
        await openWorldMap(page);
        await tapSel(page, '#worldmap-key');
        await tapSel(page, '#worldmap-keys .worldmap-key-row:nth-child(3)');
    },
    'worldmap-overview': async page => {
        await openWorldMap(page);
        await tapSel(page, '#worldmap-overview');
    },
    'worldmap-underground': async page => {
        await openWorldMap(page);
        await tapSel(page, '#worldmap-area button[data-area="1"]');
        await mapReady(page, 1);
    }
};

// Scripts a state needs in the page before host.js (added for that state's load only; android: on an Android device,
// after the Android app's script).
const BOTCHAT_LM = `{ local: { available: true, loaded: false, name: '2004 chat (Qwen3.5 0.8B + LoRA)', bytes: 529297472, think: 'option' }, online: { keySet: true, hint: '\u2026a1b2', valid: true } }`;
const STATE_INIT = {
    // (a model trained both ways: Think first shows)
    botchat: {
        ios: `window.webkit = { messageHandlers: { native: { postMessage() {} } } };
        window.LostCityNative = { platform: 'ios', settings: { seenHowToPlay: true }, lm: ${BOTCHAT_LM} };`,
        android: `window.LostCityNative.lm = ${BOTCHAT_LM};`
    }
};

// Opens Settings on a category and prints how it fits: the sheet inside the safe area, every category button on screen
// without scrolling (down to Display Zoom's 320 px), and the category's rows without scrolling on a screen at least
// fitHeight px tall (none: it may scroll).
async function settingsSection(page, name, fitHeight = Infinity) {
    if (await page.evaluate(`document.getElementById('settings').hidden`)) {
        await tapSel(page, '#btn-settings');
        await sleep(300);
    }
    await page.evaluate(`document.getElementById('nav-${name}').click()`);
    await sleep(100);
    const sheet = await page.evaluate(`(() => { const p = document.querySelector('#settings .settings-panel').getBoundingClientRect(); const s = document.getElementById('settings-pane'); const n = document.querySelector('#settings .settings-nav');
        return { shown: !document.getElementById('section-${name}').hidden, wide: s.scrollWidth > s.clientWidth + 1, scroll: s.scrollHeight, client: s.clientHeight, nav: n.scrollHeight, navClient: n.clientHeight, pane: Math.round(s.clientWidth), panel: [p.left, p.top, p.right, p.bottom].map(Math.round), view: [innerWidth, innerHeight] }; })()`);
    console.log(`  ${page.device}: ${name} ${sheet.scroll} of ${sheet.client} px${sheet.scroll > sheet.client + 1 ? ' (scrolls)' : ''}, ${sheet.pane} px wide; categories ${sheet.nav} of ${sheet.navClient} px; panel ${sheet.panel.join(',')} in ${sheet.view.join('x')}`);
    const safe = DEVICES[page.device].safe;
    // (fitHeight is in HUD px: the sheet is laid out at the viewport divided by the HUD's zoom, 360 on a 914x411
    // phone at 2.625)
    sheet.layerHeight = Math.round(sheet.view[1] / ((await page.evaluate(`Number(document.documentElement.style.getPropertyValue('--ui-zoom')) || 1`)) || 1));
    if (!sheet.shown) {
        throw new Error(`${name} is not shown`);
    }
    if (sheet.panel[0] < safe.left || sheet.panel[1] < safe.top || sheet.panel[2] > sheet.view[0] - safe.right || sheet.panel[3] > sheet.view[1]) {
        throw new Error(`the Settings sheet runs out of the safe area: ${JSON.stringify(sheet)}`);
    }
    if (sheet.wide) {
        throw new Error(`${name} is wider than the sheet: ${JSON.stringify(sheet)}`);
    }
    if (sheet.layerHeight >= 320 && sheet.nav > sheet.navClient + 1) {
        throw new Error(`the categories scroll on a ${sheet.view.join('x')} screen: ${JSON.stringify(sheet)}`);
    }
    if (sheet.layerHeight >= fitHeight && sheet.scroll > sheet.client + 1) {
        throw new Error(`${name} scrolls on a ${sheet.view.join('x')} screen: ${JSON.stringify(sheet)}`);
    }
}

async function mapReady(page, area) {
    const ready = await page.waitFor(`(() => { const m = document.getElementById('worldmap-frame')?.contentWindow?.lcMapView; return m?.ready === true && m.mapArea === ${area}; })()`, 20000, 100);
    if (!ready.ok) {
        throw new Error('the world map did not load');
    }
    await sleep(300);
}

async function openWorldMap(page) {
    await tapSel(page, '#btn-worldmap');
    await mapReady(page, 0);
}

// ---------------------------------------------------------------------------------------------------- run

// the bots' store Saved data reads (47 bots, 3 of them quit: docs/BOTS.md §4.5)
{
    const records = [...Array.from({ length: 47 }, (_, i) => [`bot${i}`, Buffer.alloc(900)]), ['_meta', Buffer.from(JSON.stringify({ v: 1, quit: ['a', 'b', 'c'], friends: {} }))]];
    const parts = [Buffer.from('LCBOTS01'), Buffer.from([0, records.length])];
    for (const [name, save] of records) {
        const size = Buffer.alloc(4);
        size.writeUInt32BE(save.length);
        parts.push(Buffer.from([name.length]), Buffer.from(name), size, save);
    }
    fs.mkdirSync(path.join(RUN, 'gallery-saves', 'bots', 'main'), { recursive: true });
    fs.writeFileSync(path.join(RUN, 'gallery-saves', 'bots', 'main', 'bots.sav'), Buffer.concat(parts));
}

const server = await serve({ port: PORT, root: GAME, saves: path.join(RUN, 'gallery-saves'), log: false, routes });
const page = await launch({
    port: PORT + 1,
    profileDir: path.join(RUN, 'gallery-profile'),
    scale: SCALE,
    initScripts: [
        `window.__lcSafeAreaOverride = window.__lcSafeAreaOverride || { top: 0, right: 0, bottom: 0, left: 0 };`,
        `try { localStorage.setItem('lostcity.settings', JSON.stringify({ seenHowToPlay: true })); } catch {}`
    ]
});
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
let androidScript = null; // the Android app's page script while an Android device is shown
try {
    for (const [deviceName, device] of Object.entries(DEVICES)) {
        if (DEVICE_FILTER.length ? !DEVICE_FILTER.includes(deviceName) : !DEFAULT_DEVICES.includes(deviceName)) {
            continue;
        }
        const android = device.platform === 'android';
        await page.setView(device.view, device.dpr ?? SCALE);
        await page.setUserAgent(android ? ANDROID_UA : IPHONE_UA);
        await page.setSafeArea(device.safe);
        page.device = deviceName;
        await page.S('Page.addScriptToEvaluateOnNewDocument', { source: `window.__lcSafeAreaOverride = ${JSON.stringify(device.safe)};` });
        if (android && !androidScript) {
            androidScript = (await page.S('Page.addScriptToEvaluateOnNewDocument', { source: androidPageScript() })).result?.identifier ?? null;
        } else if (!android && androidScript) {
            await page.S('Page.removeScriptToEvaluateOnNewDocument', { identifier: androidScript });
            androidScript = null;
        }
        for (const [stateName, apply] of Object.entries(STATES)) {
            if (ONLY.length && !ONLY.includes(stateName)) {
                continue;
            }
            const initSource = STATE_INIT[stateName]?.[android ? 'android' : 'ios'];
            const init = initSource ? (await page.S('Page.addScriptToEvaluateOnNewDocument', { source: initSource })).result?.identifier : null;
            await page.navigate(server.url);
            if (init) {
                await page.S('Page.removeScriptToEvaluateOnNewDocument', { identifier: init });
            }
            const ready = await page.waitFor(`!!window.__stub && !document.getElementById('hud').hidden && document.getElementById('loading').hidden`, 15000, 100);
            if (!ready.ok) {
                console.log(`✗ ${deviceName}/${stateName}: the HUD did not come up`);
                failures++;
                continue;
            }
            await page.evaluate(`window.__lcSafeAreaOverride = ${JSON.stringify(device.safe)}`);
            await sleep(500);
            try {
                if (device.world) {
                    // what the page made of the screen: the HUD's zoom (the pixel snap) and the world's render size
                    const made = await page.evaluate(`(() => { const g = document.getElementById('surface-game'), r = g.getBoundingClientRect();
                        return { dpr: devicePixelRatio, zoom: Number(document.documentElement.style.getPropertyValue('--ui-zoom')), world: [g.width, g.height], css: [r.width, r.height], platform: window.LostCityNative?.platform ?? null }; })()`);
                    const covers = made.css[0] >= device.view.width - 0.01 && made.css[1] >= device.view.height - 0.01;
                    if (Math.abs(made.zoom - device.zoom) > 1e-6 || made.world.join() !== device.world.join() || !covers || made.platform !== 'android' || made.dpr !== device.dpr) {
                        throw new Error(`the page made ${JSON.stringify(made)} of ${device.view.width}x${device.view.height} at ${device.dpr}, not zoom ${device.zoom} and a ${device.world.join('x')} world covering the screen`);
                    }
                }
                const outcome = await apply(page);
                if (outcome === 'skip') {
                    continue;
                }
                const taken = outcome === 'shot';
                await sleep(450);
                const shot = path.join(SHOTS, `${deviceName}-${stateName}.png`);
                if (!taken) {
                    await page.screenshot(shot);
                }
                console.log(`✓ ${path.relative(process.cwd(), shot)}`);
            } catch (err) {
                console.log(`✗ ${deviceName}/${stateName}: ${err.message}`);
                await page.screenshot(path.join(SHOTS, `${deviceName}-${stateName}-error.png`)).catch(() => {});
                failures++;
            }
        }
    }
    const errors = page.consoleLines.filter(line => /^\[(error|exception)\]/.test(line));
    if (errors.length) {
        console.log(`console errors:\n  ${[...new Set(errors)].slice(0, 10).join('\n  ')}`);
    }
} finally {
    await page.close();
    await server.close();
}
process.exit(failures ? 1 : 0);
