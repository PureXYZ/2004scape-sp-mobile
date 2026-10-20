#!/usr/bin/env node
// The mobile HUD (web/host/hud.js + client patch 0011) in headless Chrome, emulating an iPhone 13 mini in landscape
// (812x375 CSS px at 3x, touch, a 50 px notch inset each side and a 21 px home indicator inset). It plays one new
// character with real touches on the HUD's surfaces and controls:
//   Tutorial Island: the character designer (a window placed clear of the HUD, a tab's panel over it), the instructions
//   in the chatbox, walking by tapping the world and the minimap, the camera drag and compass, long-press menus kept
//   clear of the HUD and the hold ring, taps and long-presses acting on what was under the finger when it landed (an
//   NPC, the ground), pinch zoom, Run (Ctrl before the run lesson), the menu button, typing above the keyboard beside
//   an open panel, a tutorial game message beside it;
//   after skipping the tutorial (::setvar, logout through the side panel, the characters list, log in again): the 13
//   tabs and their panel, tap-to-drop (the chat bar's button: an item dropped by a tap, its menu by a long-press, the
//   bank's inventory left alone), the action label (beside an item's slot and a red cross, fading out; a walk leaves it), the real Run, the compact chat lines, the chatbox toggle and history drag, the chat filters,
//   the keyboard bar's charsets, the quest list drag and glide, the bank (window and side panel), the panel stepping
//   aside for a dialogue or window, the World map (open, drag, pinch, double-tap, Key, overview, underground, centre,
//   close, Escape), the camera pad, hardware Space and Escape, a safe-area change, Settings (on screen without scrolling,
//   Restart beside the World heading) and Settings › Bot chat (in the safe area; Think first only for a model that offers
//   it, Off / On, the page still fitting; Escape back) and Settings › Tap options (Attack on top, by level, held or
//   hidden for NPCs and players; Escape back), the classic layout (its options-menu button) and back, and every
//   screen size the HUD is laid out for (iPhone SE to iPad Pro).
// It starts from settings an earlier version stored (a 450 ms hold). Screenshots of every state go to
// build/tmp/hud/ (hud-<port>/ for another --port).
//
//   node web/test/hud.mjs [--port 47530] [--keep] [--game <dir>] [--platform android]
//   (build first: node scripts/build-web.mjs [--debug] [--out <dir>])
//
// --platform android: the same play-through as the Android app's page on a Pixel-class phone (914x411 CSS px at
// 2.625, its camera hole a 32 px inset on the left, no bottom inset; WebView's user agent; the Android app's
// LostCityNative and bridge stub of web/test/android-stub.mjs, so the page takes its native paths: the keyboard asked of
// native, settings kept by it; e2e.mjs --platform android checks the messages). At 2.625 the crisp pixel snap applies (docs/ANDROID.md §1): the HUD ×1.142857 (an 800x360 HUD,
// 3 device px per HUD px) and an 800x360 world (3 device px per game px), so the checks expect those sizes, and the
// client's insets in its render px (0.875 a CSS px). The screens at the end are the Android ones of android-stub.mjs,
// each with its expected zoom and world. Screenshots: build/tmp/hud-android/.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ANDROID_SCREENS, ANDROID_UA, androidPageScript } from './android-stub.mjs';
import { serve } from './serve.mjs';

const IOS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const gameIndex = process.argv.indexOf('--game');
const GAME = gameIndex >= 0 ? path.resolve(process.argv[gameIndex + 1]) : path.join(IOS, 'build', 'Game');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const portIndex = argv.indexOf('--port');
const PORT = portIndex >= 0 ? Number(argv[portIndex + 1]) : 47530;
const platformIndex = argv.indexOf('--platform');
const PLATFORM = platformIndex >= 0 ? argv[platformIndex + 1] : 'ios';
const ANDROID = PLATFORM === 'android';
if (PLATFORM !== 'ios' && !ANDROID) {
    console.error('--platform takes ios (the default) or android');
    process.exit(2);
}
// one folder per port (and platform)
const OUT = path.join(IOS, 'build', 'tmp', `${ANDROID ? 'hud-android' : 'hud'}${PORT === 47530 ? '' : `-${PORT}`}`);
const KEEP = argv.includes('--keep');
const USER = `hud${Date.now() % 100000}`;
// the safe area the phone reports (Android: the camera hole on its side only) and the one the page lays out around: the
// sides made equal, the larger of the two, as iOS reports them (host.js readSafeArea)
const REPORTED_SAFE = ANDROID ? { top: 0, right: 0, bottom: 0, left: 32 } : { top: 0, right: 50, bottom: 21, left: 50 };
const SAFE = { ...REPORTED_SAFE, left: Math.max(REPORTED_SAFE.left, REPORTED_SAFE.right), right: Math.max(REPORTED_SAFE.left, REPORTED_SAFE.right) };
const VIEW = ANDROID ? { width: 914, height: 411 } : { width: 812, height: 375 };
const DPR = ANDROID ? 2.625 : 3;
// what the page makes of the main screen: the HUD's zoom (HUD px are CSS px × ZOOM) and the world's render size, and
// so the client's render px per CSS px (its insets, window positions)
const ZOOM = ANDROID ? 3 / 2.625 : 1;
const WORLD = ANDROID ? [800, 360] : [812, 375];
const RENDER = WORLD[0] === VIEW.width ? 1 : DPR / 3;
const toRender = css => Math.round(css * RENDER);
// Settings › Bot chat's model and key lines: no native app on iOS here (desktop Chrome); the Android run has the app's
// bridge stub, whose status says it has no model and no key
const BOT_CHAT_LINES = ANDROID ? { local: 'Not in this build', key: 'Not set' } : { local: 'Only in the iPhone app', key: 'Only in the iPhone app' };

// a window without a side panel (smithing) and an NPC dialogue page, opened client-side to test the HUD's response
const SMITHING = 994;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
if (fs.existsSync(path.join(GAME, 'autotest.js'))) {
    console.error('build/Game is the self-playing autotest variant (left by app-test.mjs); run node scripts/build-web.mjs first');
    process.exit(1);
}
const savesDir = path.join(OUT, 'saves');
const server = await serve({ port: PORT, root: GAME, saves: savesDir, log: false });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
function check(name, ok, detail = '') {
    checks.push({ name, ok: !!ok, detail });
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    return !!ok;
}

// ---------------------------------------------------------------------------------------------------- Chrome + CDP

const cdpPort = PORT + 1;
const chrome = spawn(
    CHROME,
    ['--headless=new', `--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${path.join(OUT, 'chrome-profile')}`, '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank'],
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
const failedRequests = [];
ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
        consoleLines.push(`[${msg.params.type}] ${msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
        consoleLines.push(`[exception] ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    } else if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400 && !/\/save\//.test(msg.params.response.url)) {
        failedRequests.push(`${msg.params.response.status} ${msg.params.response.url}`);
    } else if (msg.method === 'Network.loadingFailed' && !msg.params.canceled) {
        failedRequests.push(`failed ${msg.params.errorText} (${msg.params.type})`);
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
await S('Page.enable');
await S('Network.enable');
await S('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: DPR, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setUserAgentOverride', { userAgent: ANDROID ? ANDROID_UA : 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' });
await S('Page.addScriptToEvaluateOnNewDocument', { source: `window.__lcSafeAreaOverride = ${JSON.stringify(REPORTED_SAFE)};` });
if (ANDROID) {
    await S('Page.addScriptToEvaluateOnNewDocument', { source: androidPageScript() });
}
await S('Emulation.setSafeAreaInsetsOverride', { insets: REPORTED_SAFE }); // CSS env(safe-area-inset-*) too

async function evaluate(expression) {
    const reply = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (reply.result?.exceptionDetails) {
        throw new Error(`evaluate failed: ${reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text}`);
    }
    return reply.result?.result?.value;
}

let shotIndex = 0;
async function screenshot(name) {
    const reply = await S('Page.captureScreenshot', { format: 'png' });
    const file = `${String(++shotIndex).padStart(2, '0')}-${name}.png`;
    fs.writeFileSync(path.join(OUT, file), Buffer.from(reply.result.data, 'base64'));
    return file;
}

async function waitFor(expression, timeoutMs, intervalMs = 150) {
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

// ---------------------------------------------------------------------------------------------------- touch

async function touch(type, x, y) {
    await S('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
}

async function tap(x, y, holdMs = 60) {
    await touch('touchStart', x, y);
    await sleep(holdMs);
    await touch('touchEnd');
}

async function drag(x0, y0, x1, y1, steps = 12, stepMs = 25) {
    await touch('touchStart', x0, y0);
    await sleep(30);
    for (let i = 1; i <= steps; i++) {
        await touch('touchMove', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
        await sleep(stepMs);
    }
    await touch('touchEnd');
}

async function rectOf(selector) {
    return evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; const r = n.getBoundingClientRect(); const cs = getComputedStyle(n); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !n.closest('[hidden]') }; })()`);
}

const visible = async selector => (await rectOf(selector))?.visible === true;

async function tapElement(selector) {
    const r = await rectOf(selector);
    if (!r?.visible) {
        throw new Error(`${selector} is not on screen`);
    }
    await tap(r.cx, r.cy);
    return r;
}

// a point of the client's viewport (viewport px) as CSS px on the world surface
async function worldPoint(vx, vy) {
    const r = await rectOf('#surface-game');
    const size = await evaluate(`(() => { const c = document.getElementById('surface-game'); return [c.width, c.height]; })()`);
    return { x: r.x + (vx * r.w) / size[0], y: r.y + (vy * r.h) / size[1] };
}

// a point of a 2D surface (area px) as CSS px
async function surfacePoint(selector, ax, ay) {
    const r = await rectOf(selector);
    const size = await evaluate(`(() => { const c = document.querySelector(${JSON.stringify(selector)}); return [c.width, c.height]; })()`);
    return { x: r.x + (ax * r.w) / size[0], y: r.y + (ay * r.h) / size[1] };
}

// HUD controls that must never overlap each other (the minimap as its circle; the chatbox as scaled, also lifted above
// the keyboard). The compass, the zoom slider's knob and the World map button sit on the minimap's ring on purpose.
async function hudOverlaps() {
    return evaluate(`(() => {
        const box = sel => { const n = document.querySelector(sel); if (!n || n.closest('[hidden]') || !n.getClientRects().length) return null; const r = n.getBoundingClientRect(); return { sel, l: r.left, t: r.top, r: r.right, b: r.bottom }; };
        const map = box('#hud-map');
        const rects = ['#btn-compass', '#map-zoom', '#btn-worldmap', '#hud-tabs', '#hud-panel', '#hud-chat-bar', '#hud-chat-lines', '#hud-chat-box', '#hud-dialog', '#hud-camera', ...[...document.querySelectorAll('#hud-orbs > button')].map(b => '#' + b.id)].map(box).filter(Boolean);
        const hit = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
        const found = [];
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (hit(rects[i], rects[j])) found.push(rects[i].sel + ' / ' + rects[j].sel);
        if (map) {
            const cx = (map.l + map.r) / 2, cy = (map.t + map.b) / 2, rad = (map.r - map.l) / 2;
            for (const r of rects) {
                if (r.sel === '#btn-compass' || r.sel === '#map-zoom' || r.sel === '#btn-worldmap') continue; // (on the ring)
                const nx = Math.min(Math.max(cx, r.l), r.r), ny = Math.min(Math.max(cy, r.t), r.b);
                if (Math.hypot(cx - nx, cy - ny) < rad - 0.5) found.push('#hud-map / ' + r.sel);
            }
        }
        const offscreen = rects.filter(r => r.l < 0 || r.t < 0 || r.r > innerWidth + 0.5 || r.b > innerHeight + 0.5).map(r => r.sel);
        return { found, offscreen };
    })()`);
}

const clean = overlap => overlap.found.length === 0 && overlap.offscreen.length === 0;

// A key of a hardware keyboard as KeyboardBridge sends it: key-down, then key-up.
async function pressKey(key) {
    await evaluate(`(() => { const k = window.LostCityHost.keyboard; k.pressKey(${JSON.stringify(key)}, true); k.pressKey(${JSON.stringify(key)}, false); })()`);
}

// Another screen: the size, the safe area (CSS env() and the host's override) and its pixel ratio (an iPhone's 3, an
// iPad's 2, unless given: an Android phone's own).
async function setScreen(view, safe, dpr = view.width > 1000 ? 2 : 3) {
    await evaluate(`window.__lcSafeAreaOverride = ${JSON.stringify(safe)}`);
    await S('Emulation.setSafeAreaInsetsOverride', { insets: safe });
    await S('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: dpr, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
    await waitFor(`innerWidth === ${view.width} && innerHeight === ${view.height}`, 3000, 50);
    await sleep(120); // (the HUD places itself in the resize event, and the client resizes its world with it)
}

// ---------------------------------------------------------------------------------------------------- game state

const C = 'window.__client';
// the action label (client patch 0020's 'action-label' events in window.__labels, shown by menu.js): its row (CSS px)
const LABEL = `(() => { const n = document.getElementById('action-label'), r = n.getBoundingClientRect(), cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    return { shown: !document.getElementById('label-layer').hidden, text: n.textContent, rect: [r.left, r.top, r.right, r.bottom].map(Math.round), opacity: Number(getComputedStyle(n).opacity),
        touchable: !!document.elementFromPoint(cx, cy)?.closest('#label-layer'), event: window.__labels.at(-1) ?? null, events: window.__labels.length }; })()`;
// beside the event's point like the long-press menu (24 px to one side, level with it, not over it)
// (24 HUD px: CSS px × the HUD's zoom)
const besidePoint = l => l.event && (Math.abs(l.rect[0] - l.event.x - 24 * ZOOM) <= 1 || Math.abs(l.event.x - l.rect[2] - 24 * ZOOM) <= 1) && Math.abs((l.rect[1] + l.rect[3]) / 2 - l.event.y) <= 1;
const hudState = () => evaluate(`${C}.hudState()`);
const free = () => evaluate(`[${C}.freeLeft, ${C}.freeTop, ${C}.freeRight, ${C}.freeBottom]`);
const position = () => evaluate(`(() => { const c = ${C}; const p = c?.localPlayer; return p ? [c.mapBuildBaseX + (p.x >> 7), c.mapBuildBaseZ + (p.z >> 7), c.minusedlevel] : null; })()`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function stablePosition(ms = 1500, timeoutMs = 15000) {
    let last = await position();
    let since = Date.now();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await sleep(200);
        const now = await position();
        if (!same(now, last)) {
            last = now;
            since = Date.now();
        } else if (Date.now() - since >= ms) {
            return now;
        }
    }
    return position();
}

// The minimenu the client would show at virtual (x, y), top entry first.
const menuAt = (x, y) => evaluate(`(() => { const c = ${C}; c.mouseX = ${x}; c.mouseY = ${y}; c.buildMinimenu(); return c.menuOption.slice(0, c.menuNumEntries).reverse(); })()`);

// The options under a viewport point (top entry last), as the pointer hovering there gets them. The world's options
// come from 3D picking during the draw, so they are read after two minimenus built since the pointer moved there (the
// first one's frame may have been picked before), not after a fixed wait, which a busy machine outruns.
const hover = (vx, vy) =>
    evaluate(`new Promise(resolve => { const c = ${C}, build = c.buildMinimenu; let builds = 0, timer = 0;
        const done = () => { clearTimeout(timer); delete c.buildMinimenu; resolve(c.menuOption.slice(0, c.menuNumEntries)); };
        c.buildMinimenu = function () { const r = build.apply(this, arguments); if (++builds === 2) done(); return r; };
        timer = setTimeout(done, 3000);
        c.mouseX = c.viewportX + ${vx}; c.mouseY = c.viewportY + ${vy}; })`);

// "Click to continue" (Tutorial Island's messages) eats the next click; tap it away on the world.
async function dismissTutorialMessage() {
    for (let i = 0; i < 3 && (await evaluate(`!!${C}.tutComMessage`)); i++) {
        const p = await worldPoint(406, 60);
        await tap(p.x, p.y);
        await sleep(400);
    }
}

// A tile next to the player whose top option is "Walk here", as a point on the world surface (CSS px; vx, vy: the
// viewport's), or null.
async function walkablePoint(offsets) {
    for (const [dx, dz] of offsets) {
        const point = await evaluate(`(() => { const c = ${C}; const p = c.localPlayer; const x = (p.x >> 7) + ${dx}, z = (p.z >> 7) + ${dz};
            c.getOverlayPos(x * 128 + 64, z * 128 + 64, 0); return { x: c.projectX, y: c.projectY, tile: [c.mapBuildBaseX + x, c.mapBuildBaseZ + z, c.minusedlevel] }; })()`);
        if (point.x < 0) {
            continue;
        }
        const top = (await hover(point.x, point.y)).at(-1);
        const screen = await worldPoint(point.x, point.y);
        const onWorld = await evaluate(`document.elementFromPoint(${screen.x}, ${screen.y})?.id === 'surface-game'`); // not under the HUD
        if (onWorld && top === 'Walk here') {
            return { ...screen, vx: point.x, vy: point.y, tile: point.tile };
        }
    }
    return null;
}

// Taps the world on a tile next to the player whose top option is "Walk here" and waits until the player arrives.
// The world's options come from 3D picking during the draw, so the pointer hovers there first and the top option is
// read once a fresh frame has been drawn (what a real tap does too: it waits for a frame drawn since the touch).
async function walkNear(offsets) {
    const start = await stablePosition();
    for (const [dx, dz] of offsets) {
        const point = await evaluate(`(() => { const c = ${C}; const p = c.localPlayer; const x = (p.x >> 7) + ${dx}, z = (p.z >> 7) + ${dz};
            c.getOverlayPos(x * 128 + 64, z * 128 + 64, 0); return { x: c.projectX, y: c.projectY, tile: [c.mapBuildBaseX + x, c.mapBuildBaseZ + z, c.minusedlevel] }; })()`);
        if (point.x < 0) {
            continue;
        }
        await evaluate(`(() => { const c = ${C}; c.mouseX = c.viewportX + ${point.x}; c.mouseY = c.viewportY + ${point.y}; })()`);
        await sleep(150);
        const top = await evaluate(`${C}.menuOption[${C}.menuNumEntries - 1]`);
        if (top !== 'Walk here') {
            continue;
        }
        const p = await worldPoint(point.x, point.y);
        if (!(await evaluate(`document.elementFromPoint(${p.x}, ${p.y})?.id === 'surface-game'`))) {
            continue; // under the HUD (the tutorial's instructions, the chat buttons)
        }
        await tap(p.x, p.y);
        const arrived = await waitFor(`(() => { const c = ${C}; const q = c.localPlayer; return JSON.stringify([c.mapBuildBaseX + (q.x >> 7), c.mapBuildBaseZ + (q.z >> 7), c.minusedlevel]) === ${JSON.stringify(JSON.stringify(point.tile))}; })()`, 6000);
        if (arrived.ok) {
            return { ok: true, from: start, to: point.tile, now: await position() };
        }
    }
    return { ok: false, from: start, to: null, now: await position() };
}

// Taps the open menu's "Cancel" row (always the bottom one).
async function cancelMenu() {
    const m = await evaluate(`(() => { const c = ${C}; return { open: c.isMenuOpen, area: c.menuArea, x: c.menuX, y: c.menuY, w: c.menuWidth, n: c.menuNumEntries }; })()`);
    if (!m.open) {
        return;
    }
    const ax = m.x + m.w / 2;
    const ay = m.y + (m.n - 1) * 15 + 31 - 5; // option 0's row centre (Client.mouseLoop)
    const p = m.area === 0 ? await worldPoint(ax, ay) : await surfacePoint(m.area === 1 ? '#surface-side' : '#surface-chat', ax, ay);
    await tap(p.x, p.y);
    await sleep(300);
}

// The title's New User / Existing User, a tap on the username field, the name, and the field's key ("Log in": offline a
// name is enough, the host fills in a password). holdSettings: a finger rests on the title's Settings meanwhile and
// lifts in game, where that button has moved into the tab column (a moved button loses the touch without a pointerup).
async function login(user, newUser, holdSettings = false) {
    const rect = await rectOf('#canvas');
    const game = (gx, gy) => ({ x: rect.x + (gx * rect.w) / 765, y: rect.y + (gy * rect.h) / 503 });
    let p = game(newUser ? 302 : 462, 291); // "New User" (offline: the login form) or "Existing User"
    await tap(p.x, p.y);
    await sleep(400);
    p = game(360, 258);
    await tap(p.x, p.y);
    await sleep(300);
    await evaluate(`window.LostCityHost.keyboard.insertText(${JSON.stringify(user)})`);
    const held = holdSettings ? await rectOf('#btn-settings') : null;
    if (held) {
        await touch('touchStart', held.cx, held.cy);
    }
    await evaluate('window.LostCityHost.keyboard.submit()');
    const result = await waitFor(`${C}?.ingame === true && !!${C}?.localPlayer && ${C}.sceneState === 2`, 30000);
    if (held) {
        await sleep(300);
        await touch('touchEnd');
    }
    return result;
}

// Logs in again after a logout with the title's "Continue as <name>" (the world may still be saving the character for
// a moment, so it retries).
async function relogin() {
    let result = { ok: false };
    for (let i = 0; i < 6 && !result.ok; i++) {
        if (i > 0) {
            await sleep(2000);
            await evaluate(`${C}.loginscreen = 0`);
            await sleep(300);
        }
        const button = await waitFor(`!document.getElementById('title-actions').hidden && !document.getElementById('btn-continue').hidden && document.getElementById('continue-name').textContent.toLowerCase() === ${JSON.stringify(USER)}`, 5000);
        if (!button.ok) {
            continue;
        }
        if (i === 0) {
            await screenshot('title-continue');
        }
        await tapElement('#btn-continue');
        result = await waitFor(`${C}?.ingame === true && !!${C}?.localPlayer && ${C}.sceneState === 2`, 20000);
    }
    return result;
}

async function typeChat(text) {
    await evaluate(`window.LostCityHost.keyboard.insertText(${JSON.stringify(`${text}\n`)})`);
    await sleep(700);
}

// ---------------------------------------------------------------------------------------------------- run

let exitCode = 1;
try {
    // settings an earlier version stored: it held for the menu 450 ms (the sheet now offers 300, 400 and 600), and a sound
    // mode that no longer exists; and the world this run checks (no bots, Jmod On for the "::" chip, 1× XP), not the defaults
    const seeded = await S('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('lostcity.settings', JSON.stringify({ longPressMs: 450, soundMode: 'loud', bots: 0, jmod: true, xpRate: 1 })); } catch {}` });
    await S('Page.navigate', { url: server.url });
    const title = await waitFor(`${C}?.lastProgressPercent === 100 && !!${C}?.titleFlames && window.LostCityHost?.engineState === 'ready'`, 90000);
    await S('Page.removeScriptToEvaluateOnNewDocument', { identifier: seeded.result.identifier });
    check('title screen and world ready', title.ok, `${title.ms} ms`);
    await sleep(500);
    await screenshot('title');
    const stored = await evaluate(`(() => { let s = null; try { s = JSON.parse(localStorage.getItem('lostcity.settings')); } catch {} return { live: [window.lcHost.settings.longPressMs, window.lcHost.settings.soundMode], stored: s && [s.longPressMs, s.soundMode] }; })()`);
    check('stored settings the sheet no longer offers: a 450 ms hold loads as 400, an unknown sound mode as the default (saved so)', same(stored.live, [400, 'playback']) && same(stored.stored, [400, 'playback']), JSON.stringify(stored));
    // (the same rule for the Bots row, Off 25 50 100 250 500 750 1000: a count that was on never becomes Off)
    const snaps = await evaluate(`[['bots', 10], ['bots', 0], ['bots', 75], ['bots', 600], ['bots', 2000], ['bots', 250], ['bots', 750], ['bots', 1000], ['longPressMs', 450]].map(([k, v]) => window.lcHost.snapSetting(k, v))`);
    check('...and stored Bots 10 (no longer offered) load as 25, never Off; 75 as 50, 600 as 500, 2000 as 1000; Off, 250, 750 and 1000 stay', same(snaps, [25, 0, 50, 500, 1000, 250, 750, 1000, 400]), JSON.stringify(snaps));

    const titleUi = await evaluate(`({ hud: document.getElementById('hud').hidden, canvasBehind: document.getElementById('canvas').classList.contains('behind'),
        rail: [...document.querySelectorAll('#rail-right > button')].filter(b => !b.hidden).map(b => b.id) })`);
    const titleFit = await evaluate(`(() => { const r = document.getElementById('canvas').getBoundingClientRect(); const s = document.getElementById('btn-settings').getBoundingClientRect(); return { scale: r.height / 503, settings: [s.left, s.top, s.width] }; })()`);
    const hint = await evaluate(`!document.getElementById('title-actions').hidden && !document.getElementById('title-hint').hidden && document.getElementById('btn-continue').hidden`);
    check('title: the larger classic canvas, HUD hidden, only Settings (top right)', titleUi.hud && !titleUi.canvasBehind && same(titleUi.rail, ['btn-settings']) && titleFit.scale > 0.85 && titleFit.settings[1] < 20, JSON.stringify({ ...titleUi, ...titleFit }));
    check('title: with no character yet, the hint that any name makes one', hint);

    // (a finger rests on Settings through the login: that it still works afterwards is checked where Settings opens below)
    const inGame = await login(USER, true, true);
    check('a new character logs in with just a name (the username field\'s key logs in)', inGame.ok, `${inGame.ms} ms`);
    await sleep(2500);
    await screenshot('ingame');
    // what the checks below read from the client: the options a click runs (doAction)
    await evaluate(`(() => { const c = ${C}; window.__actions = []; const act = c.doAction; c.doAction = function (i) { window.__actions.push(this.menuOption[i]); return act.call(this, i); }; })()`);
    await evaluate(`(() => { window.__labels = []; const on = window.lcHost.onClientEvent; window.lcHost.onClientEvent = function (name, detail) { if (name === 'action-label') window.__labels.push(detail); return on.call(this, name, detail); }; })()`);
    const fields = await evaluate(`(() => { const c = ${C}, s = c.hudState(); return { tutorialMessage: typeof s.tutorialMessage, longPressable: typeof s.longPressable, missing: ['sideModalId', 'errorLoading', 'errorHost', 'errorStarted'].filter(k => typeof c[k] === 'undefined') }; })()`);
    check('the client has what the host reads (hudState().tutorialMessage and longPressable, sideModalId, the load errors)', fields.tutorialMessage === 'boolean' && fields.longPressable === 'boolean' && fields.missing.length === 0, JSON.stringify(fields));

    const layout = await evaluate(`(() => { const c = ${C}; const g = document.getElementById('surface-game'); return {
        hud: !document.getElementById('hud').hidden, canvasBehind: document.getElementById('canvas').classList.contains('behind'),
        surface: [g.width, g.height], viewport: [c.viewportX, c.viewportY, c.viewportWidth, c.viewportHeight],
        free: [c.freeLeft, c.freeTop, c.freeRight, c.freeBottom] }; })()`);
    check('in game: HUD shown, title canvas behind it', layout.hud && layout.canvasBehind, JSON.stringify(layout));
    check(ANDROID ? 'the world renders full screen at 3 device px per game px (800x360 at 2.625: the crisp pixel snap)' : 'the world renders full screen at 1 game px per CSS px', same(layout.surface, WORLD) && same(layout.viewport, [1024, 4, ...WORLD]), JSON.stringify({ surface: layout.surface, viewport: layout.viewport }));
    check('the client keeps clear of the notch and the HUD', layout.free[0] === toRender(SAFE.left) && layout.free[2] < WORLD[0] - toRender(SAFE.right), JSON.stringify(layout.free));

    // ================================================================ Tutorial Island
    let s = await hudState();
    check('designer open: the tutorial instructions stay out of the way', s.tutorialChat && s.mainModal && !(await visible('#hud-chat-box')), JSON.stringify({ tutorialChat: s.tutorialChat, mainModal: s.mainModal }));
    if (s.mainModal) {
        const modal = await evaluate(`[${C}.modalX, ${C}.modalY, ${C}.freeLeft, ${C}.freeRight]`);
        check('the character designer is centred in the free part of the world', modal[0] >= modal[2] && modal[0] + 512 <= modal[3], JSON.stringify(modal));
        await screenshot('designer');
        // a tab tapped meanwhile (Game options; the tutorial hands it out before the designer): its panel shows over the
        // window, which stays where it is (it used to move into the notch, under the panel)
        await tapElement('#hud-tabs .tab[data-tab="11"]');
        await sleep(400);
        const over = await evaluate(`({ modal: [${C}.modalX, ${C}.modalY, ${C}.freeLeft, ${C}.freeRight], selected: document.querySelector('#hud-tabs .tab[data-tab="11"]').classList.contains('selected') })`);
        const panelOver = await rectOf('#hud-panel');
        await screenshot('designer-panel');
        check('a tab tapped while it is open shows its panel over the window, which stays where it was (clear of the notch)', panelOver.visible && over.selected && same(over.modal, modal) && over.modal[0] >= toRender(SAFE.left), JSON.stringify({ ...over, panel: [panelOver.x, panelOver.x + panelOver.w] }));
        await tapElement('#hud-tabs .tab[data-tab="11"]');
        await sleep(300);
        check('...and a second tap on that tab closes the panel', !(await visible('#hud-panel')) && same(await evaluate(`[${C}.modalX, ${C}.modalY, ${C}.freeLeft, ${C}.freeRight]`), modal));
        // the client's rule for a window wider than the free part: it starts at the free part's left edge and runs on under
        // the HUD on the right, never into the notch (setViewportInsets, then the HUD's own insets again)
        const clamp = await evaluate(`(() => { const c = ${C}; const w = c.viewportWidth, h = c.viewportHeight;
            const own = { left: c.freeLeft, top: c.freeTop, right: w - c.freeRight, bottom: h - c.freeBottom };
            const at = insets => { c.setViewportInsets(insets); return c.modalX; };
            const narrow = [at({ left: 50, top: 0, right: w - 466, bottom: 21 }), at({ left: 360, top: 0, right: 0, bottom: 21 })];
            return { narrow, edge: w - 512, back: at(own) }; })()`);
        check('a window wider than the free part starts at its left edge, else as far left as it fits (setViewportInsets)', same(clamp.narrow, [50, clamp.edge]) && clamp.back === modal[0], JSON.stringify(clamp));
        const accept = await worldPoint(modal[0] + 256, modal[1] + 282); // "Accept" (classic 260,286)
        await tap(accept.x, accept.y);
        const closed = await waitFor(`${C}.mainModalId === -1`, 5000);
        check("a tap on the designer's Accept (world surface) closes it", closed.ok);
        await sleep(800);
    }

    // the first visit to the world: how to play with fingers, once
    const howto = await waitFor(`!document.getElementById('howto').hidden`, 5000);
    await screenshot('how-to-play');
    check('the first visit shows how to play on a phone', howto.ok);
    if (howto.ok) {
        await tapElement('#howto-ok');
        await sleep(300);
    }

    s = await hudState();
    check('tutorial: the instructions open the chatbox', s.tutorialChat && (await visible('#hud-chat-box')), JSON.stringify({ tutorialChat: s.tutorialChat }));
    await tapElement('#btn-chat-toggle');
    await sleep(300);
    const glowing = await evaluate(`document.getElementById('btn-chat-toggle').classList.contains('glow')`);
    check('...which the chat button puts away (the button glows while they are away)', !(await visible('#hud-chat-box')) && glowing);
    await tapElement('#btn-chat-toggle');
    await sleep(300);
    check('...and shows again', await visible('#hud-chat-box'));

    await dismissTutorialMessage();
    const walk1 = await walkNear([[-2, 0], [0, -2], [2, 0], [0, 2], [-1, -1], [1, 1], [-2, 1], [2, -1], [1, 2], [-1, -2], [0, 3], [3, 0], [-3, 0], [0, -3]]);
    check('a tap on the world walks to that tile', walk1.ok, `${JSON.stringify(walk1.from)} → ${JSON.stringify(walk1.now)} (target ${JSON.stringify(walk1.to)})`);
    await screenshot('walked');

    const map = await rectOf('#surface-map');
    const mapScale = map.w / 172;
    const beforeMap = await stablePosition();
    await tap(map.x + (98 - 3) * mapScale, map.y + (80 + 10) * mapScale); // two tiles south (inside the house), inside the round map
    await waitFor(`(() => { const c = ${C}; const q = c.localPlayer; return q && JSON.stringify([c.mapBuildBaseX + (q.x >> 7), c.mapBuildBaseZ + (q.z >> 7), c.minusedlevel]) !== ${JSON.stringify(JSON.stringify(beforeMap))}; })()`, 6000);
    const afterMap = await stablePosition();
    check('a tap on the minimap walks there', !same(afterMap, beforeMap), `${JSON.stringify(beforeMap)} → ${JSON.stringify(afterMap)}`);

    // the minimap's zoom slider: the knob dragged round the ring past + zooms the map in as far as it goes (kept in the
    // settings), and back to the 2004 zoom it clicks into place; a tap on the map then follows the zoom
    const ring = await rectOf('#hud-map');
    const knob0 = await rectOf('#map-zoom');
    const groove = ring.w / 2 - 2; // (the ring is 4 px)
    const onGroove = a => [ring.cx + groove * Math.cos((a * Math.PI) / 180), ring.cy + groove * Math.sin((a * Math.PI) / 180)];
    await drag(knob0.cx, knob0.cy, ...onGroove(200));
    await sleep(900); // (saved after 800 ms)
    const zoomedIn = await evaluate(`(() => { let stored = null; try { stored = JSON.parse(localStorage.getItem('lostcity.settings')).minimapZoom; } catch {} return { client: ${C}.hudState().minimapZoom, setting: window.lcHost.settings.minimapZoom, stored }; })()`);
    const knob1 = await rectOf('#map-zoom');
    await screenshot('minimap-zoomed');
    check('the minimap zoom slider: dragging the knob towards + zooms the map in (kept in the settings)', zoomedIn.client === 2 && zoomedIn.setting === 2 && zoomedIn.stored === 2 && knob1.cy < knob0.cy, JSON.stringify({ ...zoomedIn, knob: [knob0.cy, knob1.cy] }));
    const clicks = await evaluate(`(() => { const c = ${C}, q = c.localPlayer, tiles = [], tryMove = c.tryMove;
        c.tryMove = function (sx, sz, dx, dz) { tiles.push(Math.hypot(dx - (q.x >> 7), dz - (q.z >> 7))); return false; };
        try { for (const z of [1, 2]) { c.setMinimapZoom(z); c.minimapState = 0; c.mouseClickButton = 1; c.mouseClickX = 550 + 25 + 73; c.mouseClickY = 4 + 4 + 75 + 32; c.minimapLoop(); } }
        finally { c.tryMove = tryMove; c.mouseClickButton = 0; c.setMinimapZoom(window.lcHost.settings.minimapZoom); }
        return tiles; })()`);
    check('...a tap on the zoomed map walks to where it shows (32 px: 8 tiles at the 2004 zoom, 4 at 2x)', clicks.length === 2 && Math.abs(clicks[0] - 8) <= 1 && Math.abs(clicks[1] - 4) <= 1, JSON.stringify(clicks));
    const k1 = await rectOf('#map-zoom');
    const detentAngle = (await evaluate(`(() => { const a = Math.atan2(${knob0.cy} - ${ring.cy}, ${knob0.cx} - ${ring.cx}); return a * 180 / Math.PI; })()`)) + 2;
    await drag(k1.cx, k1.cy, ...onGroove(detentAngle));
    await sleep(200);
    const unzoomed = await evaluate(`${C}.hudState().minimapZoom`);
    const overlapZoom = await hudOverlaps();
    check('...dragged back near the 2004 zoom it snaps to it; the knob stays clear of the column and orbs', unzoomed === 1 && clean(overlapZoom), JSON.stringify({ unzoomed, ...overlapZoom }));

    const yaw0 = await evaluate(`${C}.orbitCameraYaw`);
    let p = await worldPoint(300, 150);
    await drag(p.x, p.y, p.x + 120, p.y);
    await sleep(300);
    const yaw1 = await evaluate(`${C}.orbitCameraYaw`);
    check('dragging the world turns the camera', yaw1 !== yaw0, `${yaw0} → ${yaw1}`);
    const rose = await evaluate(`document.querySelector('#btn-compass .compass-rose').style.transform`);
    await tapElement('#btn-compass');
    const north = await waitFor(`${C}.orbitCameraYaw === 0`, 3000);
    check('a tap on the compass faces north (and the rose turned with the camera)', north.ok && /rotate\(/.test(rose), `yaw ${await evaluate(`${C}.orbitCameraYaw`)}, rose ${rose}`);

    // long-press on the world: the large menu opens beside the finger while it is held (the drawn one stays hidden)
    p = await worldPoint(300, 200);
    await touch('touchStart', p.x, p.y);
    await sleep(700);
    const held = await evaluate(`(() => { const m = document.getElementById('menu'); const r = m.getBoundingClientRect(); return { open: ${C}.isMenuOpen, shown: !document.getElementById('menu-layer').hidden, host: ${C}.hostMenus, rows: [...m.querySelectorAll('.menu-option')].map(n => n.textContent), rect: [r.left, r.top, r.right, r.bottom], rowH: m.querySelector('.menu-option')?.getBoundingClientRect().height ?? 0 }; })()`);
    await touch('touchEnd');
    await sleep(300);
    const stillOpen = await evaluate(`${C}.isMenuOpen && !document.getElementById('menu-layer').hidden`);
    await screenshot('long-press-menu');
    const underFinger = p.x >= held.rect[0] && p.x <= held.rect[2] && p.y >= held.rect[1] && p.y <= held.rect[3];
    check('a long-press on the world opens the large options menu while held, beside the finger', held.open && held.shown && held.host && held.rows.at(-1) === 'Cancel' && held.rowH >= 30 && !underFinger, JSON.stringify(held));
    check('...and it stays open after the finger lifts without sliding', stillOpen === true);
    const cancelFrom = await evaluate(`(() => { window.__touchEnds = []; window.addEventListener('touchend', event => window.__touchEnds.push(event.defaultPrevented)); return window.__actions.length; })()`);
    await tapElement('#menu .menu-option:last-child');
    await sleep(600);
    const cancelled = await evaluate(`({ actions: window.__actions.slice(${cancelFrom}), touchEnds: window.__touchEnds })`);
    check('its Cancel row closes it', !(await evaluate(`${C}.isMenuOpen`)) && (await evaluate(`document.getElementById('menu-layer').hidden`)));
    // After a tap iOS clicks whatever is under the finger then, unless the tap's touchend was cancelled. A row taken out
    // of the page on pointerup gets that touchend alone (it no longer reaches the menu's handler), and the click went
    // through to the world below: "Walk here", which cancelled the option just picked. (Chrome sends no such click, so
    // the check is on the touchend.)
    check('...and its touchend is cancelled, so iOS sends no click through to the world below', same(cancelled.actions, ['Cancel']) && same(cancelled.touchEnds, [true]), JSON.stringify(cancelled));

    // press-drag-release: hold, slide onto "Walk here" (the top option), lift there: the player walks
    const beforeSlide = await stablePosition();
    p = (await walkablePoint([[-2, 1], [2, 1], [-2, 2], [2, 2], [0, 2], [-3, 0], [3, 0], [-2, -1], [2, -1]])) ?? (await worldPoint(250, 120));
    await touch('touchStart', p.x, p.y);
    await sleep(650);
    const top = await rectOf('#menu .menu-option:first-child');
    const topText = await evaluate(`document.querySelector('#menu .menu-option')?.textContent ?? ''`);
    if (top?.visible) {
        for (let i = 1; i <= 8; i++) {
            await touch('touchMove', p.x + ((top.cx - p.x) * i) / 8, p.y + ((top.cy - p.y) * i) / 8);
            await sleep(30);
        }
    }
    const highlighted = await evaluate(`document.querySelector('#menu .menu-option.active')?.textContent ?? ''`);
    await touch('touchEnd');
    await sleep(300);
    const slid = await waitFor(`(() => { const c = ${C}; const q = c.localPlayer; return q && JSON.stringify([c.mapBuildBaseX + (q.x >> 7), c.mapBuildBaseZ + (q.z >> 7), c.minusedlevel]) !== ${JSON.stringify(JSON.stringify(beforeSlide))}; })()`, 5000);
    check('press-drag-release: sliding onto "Walk here" highlights it and lifting there walks', topText === 'Walk here' && highlighted === 'Walk here' && slid.ok && !(await evaluate(`${C}.isMenuOpen`)), JSON.stringify({ topText, highlighted, walked: slid.ok }));
    await stablePosition();

    // a tap beside the open menu closes it without acting
    p = await worldPoint(300, 200);
    await touch('touchStart', p.x, p.y);
    await sleep(650);
    await touch('touchEnd');
    await sleep(200);
    const beforeBeside = await position();
    const box = await rectOf('#menu');
    await tap(box.x > 200 ? box.x - 80 : box.x + box.w + 80, box.cy);
    await sleep(600);
    check('a tap beside the menu closes it without acting', !(await evaluate(`${C}.isMenuOpen`)) && same(await position(), beforeBeside));

    // the hold ring gives up exactly where the long-press does (more than 14 px along either axis): a finger that drifts
    // 10 px both ways keeps both, and the menu opens
    p = (await walkablePoint([[2, 0], [-2, 0], [0, 2], [0, -2], [2, 1], [-2, 1], [1, 2], [-1, 2]])) ?? (await worldPoint(250, 120));
    await touch('touchStart', p.x, p.y);
    await sleep(220);
    const ring0 = await evaluate(`!document.getElementById('press-ring').hidden`);
    await touch('touchMove', p.x + 10, p.y + 10);
    await sleep(60);
    const ring1 = await evaluate(`!document.getElementById('press-ring').hidden`);
    await sleep(450);
    const held2 = await evaluate(`${C}.hudMenu()`);
    await touch('touchEnd');
    await sleep(200);
    check('the hold ring stays on a finger that drifts 10 px both ways, and the menu then opens', ring0 && ring1 && held2 !== null, JSON.stringify({ ring0, ring1, menu: held2?.options }));
    // a pick and a close of that menu in the same client cycle (hud.js closes the menu of a surface it hides): the pick
    // still runs
    const picks = await evaluate('window.__actions.length');
    const pick = Math.max(0, held2?.options.indexOf('Walk here') ?? 0);
    if (held2) {
        await evaluate(`(() => { const c = ${C}; c.hudMenuSelect(${held2.serial}, ${pick}); c.hudMenuClose(${held2.serial}); })()`);
        await sleep(300);
    }
    const race = await evaluate(`({ actions: window.__actions.slice(${picks}), open: ${C}.isMenuOpen, shown: !document.getElementById('menu-layer').hidden })`);
    check('...and a pick and a close of it in the same cycle still pick', held2 !== null && same(race.actions, [held2.options[pick]]) && !race.open && !race.shown, JSON.stringify(race));

    // a touch acts on what was under the finger when it landed (patch 0021). A quarter turn of the camera while the finger
    // is down takes away what was under it, as a walking NPC does, or the ground while the player walks (the camera
    // follows the player). Walks are caught in tryMove (not made), and the NPC's options in doMenuAction (not sent).
    await dismissTutorialMessage();
    await stablePosition();
    const yaw = await evaluate(`${C}.orbitCameraYaw`);
    const turn = async (quarters, settleMs = 100) => {
        await evaluate(`(() => { const c = ${C}; c.orbitCameraYaw = ${(yaw + 512 * quarters) & 2047}; c.orbitCameraYawVelocity = 0; })()`);
        await sleep(settleMs);
    };
    // a finger down until the client has drawn the frame that keeps what is under it (headless Chrome holds the game
    // loop's timer for about 100 ms after a touchstart), the camera turned (and drawn), then held `holdMs` more and
    // lifted: the time it was down (a tap must stay under the 450 ms long-press), and whether a menu is open after
    const pressTurnLift = async (pt, holdMs, quarters = 1) => {
        const down = Date.now();
        await touch('touchStart', pt.x, pt.y);
        const landed = await waitFor(`${C}.landing === 'held'`, 1000, 10);
        await turn(quarters, 60);
        await sleep(holdMs);
        const ms = Date.now() - down;
        await touch('touchEnd');
        await sleep(200);
        return { landed: landed.ok, ms, menu: await evaluate(`${C}.isMenuOpen`) };
    };
    const menuRows = () => evaluate(`[...document.querySelectorAll('#menu .menu-option')].map(n => n.textContent)`);
    const tapMenuRow = async text => {
        const r = await evaluate(`(() => { const n = [...document.querySelectorAll('#menu .menu-option')].find(n => n.textContent === ${JSON.stringify(text)}); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        if (r) {
            await tap(r.x, r.y);
            await sleep(300);
        }
        return r !== null;
    };
    // (a loc's or an NPC's option that reached the server is answered within a game tick, "I can't reach that!" for
    // one out of reach, and on Tutorial Island a game message eats the next click (tutComMessage): past the tick it is
    // dropped, so it cannot eat a later check's tap)
    const walksDuring = async run => {
        await evaluate(`window.__walks = []; ${C}.tutComMessage = null`);
        await run();
        await sleep(300);
        const walks = await evaluate('window.__walks');
        await sleep(700);
        await evaluate(`${C}.tutComMessage = null`);
        return walks;
    };
    const stubActions = on => evaluate(on ? `${C}.doMenuAction = function () {}` : `delete ${C}.doMenuAction`);
    await evaluate(`(() => { const c = ${C}; window.__walks = []; c.tryMove = function (sx, sz, dx, dz) { window.__walks.push([c.mapBuildBaseX + dx, c.mapBuildBaseZ + dz]); return false; }; })()`);

    const ground = await walkablePoint([[2, 1], [-2, 1], [1, 2], [-1, 2], [2, -1], [-2, -1], [3, 0], [-3, 0], [0, 3]]);
    if (ground) {
        const tile = ground.tile.slice(0, 2);
        const still = await walksDuring(() => tap(ground.x, ground.y));
        await turn(1);
        // (tapped only where the turned camera puts a walk: a loc's or an NPC's option would reach the server, which
        // answers it or walks the player there (a tree's "You cannot cut down this tree yet"), and the checks after it
        // start from another tile. The top option there shows the tap would act on what is under the finger then)
        const turnedTop = (await hover(ground.vx, ground.vy)).at(-1);
        const turned = turnedTop === 'Walk here' ? await walksDuring(() => tap(ground.x, ground.y)) : turnedTop;
        await turn(0);
        let press = null;
        const turning = await walksDuring(async () => {
            press = await pressTurnLift(ground, 0);
        });
        if (press.menu) {
            await tapMenuRow('Cancel');
        }
        await turn(0);
        check('a tap walks to the tile under the finger when it landed, though the camera turned before it lifted', same(still, [tile]) && !same(turned, [tile]) && same(turning, [tile]), JSON.stringify({ tile, still, turned, turning, press }));

        let rows = [];
        const picked = await walksDuring(async () => {
            await pressTurnLift(ground, 600);
            rows = await menuRows();
            await tapMenuRow('Walk here');
        });
        await turn(0);
        check("...and so does the long-press menu's Walk here, the camera turned before it opened", rows.includes('Walk here') && same(picked, [tile]), JSON.stringify({ tile, rows, picked }));

        // a window that opens under the finger before it lifts: the tap acts on the window, not on the world it covered
        // (on a walk found again: the guide can have stepped onto the tile)
        const spot = (await walkablePoint([[2, 1], [-2, 1], [1, 2], [-1, 2], [2, -1], [-2, -1], [3, 0], [-3, 0], [0, 3]])) ?? ground;
        await stubActions(true);
        const from = await evaluate('window.__actions.length');
        await touch('touchStart', spot.x, spot.y);
        const landed = await waitFor(`${C}.landing === 'held'`, 1000, 10);
        const kept = await evaluate(`${C}.menuOption[${C}.menuNumEntries - 1]`);
        await evaluate(`${C}.mainModalId = ${SMITHING}`);
        await sleep(150);
        await touch('touchEnd');
        await sleep(300);
        const covered = await evaluate(`window.__actions.slice(${from})`);
        await evaluate(`${C}.mainModalId = -1`);
        await stubActions(false);
        await sleep(300);
        check('...but when a window opens under the finger before it lifts, the tap acts on what is there then', landed.ok && kept === 'Walk here' && covered.length === 1 && covered[0] !== 'Walk here', JSON.stringify({ kept, covered }));
    } else {
        check('a tap walks to the tile under the finger when it landed (no walkable tile on screen)', false);
    }

    // an NPC: its options open although the camera turn took it from under the finger, and a tap talks to it. findNpc: a
    // point on an NPC where its option is the top one (not a loc's behind it, the guide's drawers), on the world (not
    // under the HUD), in CSS px, and the turn (q quarters) that takes it from under that point (one beside the player,
    // the camera's pivot, can stay under it after a quarter turn). It is looked for there again last (a step can take
    // it away while the turns are tried); found again before each check, as NPCs wander (the guide too), and a little
    // later when none will do (npcsTried: what was under each point tried, for the failure)
    // (pointOf: at that fraction of its height: its middle first, then above and below it)
    const pointOf = (id, f) => evaluate(`(() => { const c = ${C}, n = c.npc[${id}]; if (!n?.type?.name) return null; c.getOverlayPos(n.x, n.z, ((n.height || 100) * ${f}) | 0); return c.projectX >= 0 ? { vx: c.projectX, vy: c.projectY } : null; })()`);
    const topAt = async at => {
        const pt = at && (await worldPoint(at.vx, at.vy));
        const onWorld = pt && (await evaluate(`document.elementFromPoint(${pt.x}, ${pt.y})?.id === 'surface-game'`));
        return { pt, top: onWorld ? (await hover(at.vx, at.vy)).at(-1) ?? '' : 'under the HUD' };
    };
    let npcsTried = [];
    const findNpc = async () => {
        const npcs = await evaluate(`(() => { const c = ${C}, out = []; for (let i = 0; i < c.npcCount; i++) { const n = c.npc[c.npcIds[i]]; if (n?.type?.name) out.push({ name: n.type.name, id: c.npcIds[i] }); } return out; })()`);
        npcsTried = [];
        for (const n of npcs) {
            for (const f of [0.5, 0.75, 0.25]) {
                const at = await pointOf(n.id, f);
                const here = at ? await topAt(at) : { top: 'off screen' };
                npcsTried.push(`${n.name} ${f}: ${here.top}`);
                if (!here.top.includes(n.name)) {
                    continue;
                }
                for (const q of [1, 3, 2]) {
                    await turn(q);
                    const turned = await hover(at.vx, at.vy);
                    await turn(0);
                    if (!turned.some(o => o.includes(n.name))) {
                        const now = await pointOf(n.id, f);
                        const again = now ? await topAt(now) : { top: 'off screen' };
                        if (again.top.includes(n.name)) {
                            return { name: n.name, ...now, ...again.pt, q };
                        }
                        npcsTried.push(`${n.name} ${f}: turn ${q}, then ${again.top}`);
                        break;
                    }
                    npcsTried.push(`${n.name} ${f}: still there after ${q}`);
                }
            }
        }
        return null;
    };
    const findNpcSoon = async () => {
        for (let i = 0; i < 4; i++) {
            const found = await findNpc();
            if (found) {
                return found;
            }
            await sleep(1500);
        }
        return null;
    };
    let npc = await findNpcSoon();
    if (npc) {
        await pressTurnLift(npc, 600, npc.q);
        const rows = await menuRows();
        await tapMenuRow('Cancel');
        await turn(npc.q);
        const gone = await hover(npc.vx, npc.vy);
        await turn(0);
        check(`a long-press opens the options of what was under the finger when it landed (${npc.name}, gone from there after the turn)`, rows.some(r => r.includes(npc.name)) && !gone.some(o => o.includes(npc.name)), JSON.stringify({ rows, gone }));
    } else {
        check('a long-press opens the options of the NPC under the finger when it landed (no NPC on screen)', false, JSON.stringify(npcsTried));
    }
    npc = await findNpcSoon();
    if (npc) {
        await stubActions(true);
        const from = await evaluate('window.__actions.length');
        const press = await pressTurnLift(npc, 0, npc.q);
        const tapped = await evaluate(`window.__actions.slice(${from})`);
        if (press.menu) {
            await tapMenuRow('Cancel');
        }
        await stubActions(false);
        await turn(0);
        check(`...and a tap does its top option there (${npc.name})`, tapped.length === 1 && tapped[0].includes(npc.name), JSON.stringify({ tapped, press }));
    } else {
        check('...and a tap does its top option there (no NPC on screen)', false, JSON.stringify(npcsTried));
    }
    await evaluate(`delete ${C}.tryMove`);

    // a use or target mode that a tap selected keeps its prompt in the top left after the finger lifts, where the hover
    // tooltip no longer shows (drawStringAntiMacro draws only those two)
    const prompts = await evaluate(`(async () => { const c = ${C}, font = c.b12, draw = font.drawStringAntiMacro, seen = [];
        font.drawStringAntiMacro = function (text, ...rest) { seen.push(text); return draw.call(this, text, ...rest); };
        const frames = () => new Promise(resolve => setTimeout(resolve, 200));
        const result = {};
        await frames(); result.none = seen.splice(0).length;
        c.objSelectedName = 'Tinderbox'; c.useMode = 1; await frames(); c.useMode = 0; result.use = [...new Set(seen.splice(0))];
        c.targetOp = 'Cast Wind strike on'; c.targetMode = 1; await frames(); c.targetMode = 0; result.target = [...new Set(seen.splice(0))];
        font.drawStringAntiMacro = draw;
        return result; })()`);
    check('a use or target mode keeps its prompt with no finger down ("Use Tinderbox with...", "Cast Wind strike on...")', prompts.none === 0 && same(prompts.use, ['Use Tinderbox with...']) && same(prompts.target, ['Cast Wind strike on...']), JSON.stringify(prompts));

    // pinch: two fingers on the world zoom the camera; the first finger neither walks nor turns the camera
    const zoom0 = await evaluate(`${C}.hudState().cameraZoom`);
    const yawPinch = await evaluate(`${C}.orbitCameraYaw`);
    const posPinch = await stablePosition();
    const c0 = await worldPoint(330, 170);
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c0.x - 30, y: c0.y, id: 1 }] });
    await sleep(40);
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c0.x - 30, y: c0.y, id: 1 }, { x: c0.x + 30, y: c0.y, id: 2 }] });
    for (let i = 1; i <= 10; i++) {
        await S('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c0.x - 30 - 8 * i, y: c0.y, id: 1 }, { x: c0.x + 30 + 8 * i, y: c0.y, id: 2 }] });
        await sleep(30);
    }
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(500);
    const zoom1 = await evaluate(`${C}.hudState().cameraZoom`);
    check('pinching the world zooms the camera in (and nothing else happens)', zoom1 < zoom0 - 0.2 && (await evaluate(`${C}.orbitCameraYaw`)) === yawPinch && same(await stablePosition(), posPinch) && !(await evaluate(`${C}.isMenuOpen`)), JSON.stringify({ zoom0, zoom1 }));
    await screenshot('zoomed-in');
    // fingers together zooms back out (to 1 again: 0.6 x 160 / 96), which is also what the host saves
    const c1 = await worldPoint(330, 170);
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c1.x - 80, y: c1.y, id: 1 }] });
    await sleep(40);
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c1.x - 80, y: c1.y, id: 1 }, { x: c1.x + 80, y: c1.y, id: 2 }] });
    for (let i = 1; i <= 8; i++) {
        await S('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c1.x - 80 + 4 * i, y: c1.y, id: 1 }, { x: c1.x + 80 - 4 * i, y: c1.y, id: 2 }] });
        await sleep(30);
    }
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(400);
    const zoom2 = await evaluate(`${C}.hudState().cameraZoom`);
    check('pinching back out zooms out again', Math.abs(zoom2 - 1) < 0.05, `zoom ${zoom2}`);
    const range = await evaluate(`(() => { const c = ${C}; const r = [c.setCameraZoom(0.5), c.setCameraZoom(2)]; c.setCameraZoom(${zoom2}); return r; })()`);
    check('the zoom range is 0.6 to 1.4 times the camera\'s distance', same(range, [0.6, 1.4]), JSON.stringify(range));

    s = await hudState();
    await tapElement('#btn-run');
    await sleep(300);
    let run = await evaluate(`({ held: ${C}.keyHeld[5], active: document.getElementById('btn-run').classList.contains('active') })`);
    check('Run (before the run lesson) makes clicks run', !s.runExists && run.active && run.held === 1, JSON.stringify({ runExists: s.runExists, ...run }));
    await tapElement('#btn-run');
    await sleep(200);
    check('Run again stops it', (await evaluate(`${C}.keyHeld[5]`)) === 0);

    const barButtons = await evaluate(`[...document.getElementById('hud-chat-bar').children].filter(n => n.tagName === 'BUTTON').map(n => n.id)`);
    check('the chat bar: tap-to-drop (in the options-menu button\'s place), the keyboard, the chat button', same(barButtons, ['btn-drop', 'btn-keyboard', 'btn-chat-toggle']) && !(await visible('#btn-secondary')), JSON.stringify(barButtons));

    // (the Game options panel stays open for the typing and the tutorial message below)
    await tapElement('#hud-tabs .tab[data-tab="11"]');
    await sleep(300);
    await tapElement('#btn-keyboard');
    await sleep(300);
    await waitFor('window.lcHost.keyboard.isShown()', 3000, 50); // (longer on a busy machine)
    const kb = await evaluate(`({ shown: window.lcHost.keyboard.isShown(), kind: window.lcHost.keyboard.context?.kind ?? null, charset: window.lcHost.keyboard.context?.charset ?? null, chips: (window.lcHost.keyboard.context?.chips ?? []).map(c => c.label) })`);
    check('the keyboard button opens the chat keyboard (with the "::" chip; the bar takes what chat takes)', kb.shown && kb.kind === 'chat' && kb.charset === 'chat' && kb.chips[0] === '::', JSON.stringify(kb));
    // the native keyboard reports how much it covers: the chatbox moves above it (scaled to fit beside what shows at its
    // height: the panel's top), the buttons give way
    await evaluate(`window.LostCityHost.keyboard.frame(239, 0)`);
    await sleep(400);
    const lifted = await evaluate(`(() => { const r = document.getElementById('hud-chat-box').getBoundingClientRect(); const p = document.getElementById('hud-panel').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right, panel: p.left, panelTop: p.top, shown: !document.getElementById('hud-chat-box').hidden, bar: !document.getElementById('hud-chat-bar').hidden }; })()`);
    let overlap = await hudOverlaps();
    await screenshot('typing');
    check('while typing, the chatbox shows above the keyboard, beside the open panel (nothing overlaps)', lifted.shown && lifted.bottom <= VIEW.height - 239 + 1 && lifted.top >= 0 && !lifted.bar && (lifted.right <= lifted.panel || lifted.bottom <= lifted.panelTop) && (await visible('#hud-panel')) && clean(overlap), JSON.stringify({ ...lifted, ...overlap }));
    await evaluate(`window.LostCityHost.keyboard.frame(0, 0)`);
    // a keyboard-bar chip replaces a long line at once (Backspaces for all of it, then the command): nothing may be lost
    // to the client's 128-key queue
    await evaluate(`window.LostCityHost.keyboard.insertText('x'.repeat(75))`);
    await sleep(500);
    await evaluate(`(() => { const k = window.LostCityHost.keyboard; for (let i = 0; i < 75; i++) k.deleteBackward(); k.insertText('::tele 0,50,50,22,18 and some more text to be long'); })()`);
    await sleep(1200);
    const chipLine = await evaluate(`${C}.chatInput`);
    check('a long chip burst reaches the chat line intact', chipLine === '::tele 0,50,50,22,18 and some more text to be long', JSON.stringify(chipLine));
    await evaluate(`(() => { const k = window.LostCityHost.keyboard; for (let i = 0; i < 60; i++) k.deleteBackward(); })()`);
    await sleep(600);
    await tapElement('#btn-keyboard');
    await sleep(200);

    // On Tutorial Island every action's game message ("::getcoord" prints one) waits in the chatbox for a tap. It is no
    // dialogue: the open panel stays, and the chatbox shows the message beside it.
    await dismissTutorialMessage();
    await evaluate(`window.LostCityHost.keyboard.insertText('::getcoord\\n')`);
    const message = await waitFor(`${C}.hudState().tutorialMessage === true`, 3000, 50);
    const beside = { chatModal: (await hudState()).chatModal, panel: await visible('#hud-panel'), chat: await visible('#hud-chat-box') };
    overlap = await hudOverlaps();
    await screenshot('tutorial-message');
    await dismissTutorialMessage();
    const dismissed = { message: (await hudState()).tutorialMessage, panel: await visible('#hud-panel') };
    check('a tutorial game message shows in the chatbox beside the open panel, which stays (nothing overlaps); a tap dismisses it', message.ok && beside.chatModal && beside.panel && beside.chat && clean(overlap) && !dismissed.message && dismissed.panel, JSON.stringify({ ...beside, ...overlap, dismissed }));

    // ================================================================ skip the tutorial, log out through the side panel
    await dismissTutorialMessage();
    await typeChat('::setvar tutorial 1000');
    await dismissTutorialMessage();
    await tapElement('#hud-tabs .tab[data-tab="10"]');
    await sleep(500);
    check('the Logout tab opens its panel', (await visible('#hud-panel')) && (await hudState()).activeTab === 10);
    await screenshot('panel-logout');
    // a second character on this phone (an older save the title then lists; never loaded here)
    const other = path.join(savesDir, 'players', 'main', 'zezima.sav');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'not a save');
    fs.utimesSync(other, new Date(Date.now() - 3 * 86400e3), new Date(Date.now() - 3 * 86400e3));
    p = await surfacePoint('#surface-side', 94, 170); // "Click here to logout"
    await tap(p.x, p.y);
    const out = await waitFor(`${C}.ingame === false && !${C}.reconnecting`, 10000);
    await sleep(800);
    const titleAgain = await evaluate(`({ hud: document.getElementById('hud').hidden, behind: document.getElementById('canvas').classList.contains('behind') })`);
    check('a tap on the panel\'s logout button (side surface) logs out to the title screen', out.ok && titleAgain.hud && !titleAgain.behind, JSON.stringify(titleAgain));
    const listButton = await waitFor(`!document.getElementById('title-actions').hidden && !document.getElementById('btn-characters').hidden`, 5000);
    if (listButton.ok) {
        await tapElement('#btn-characters');
        await sleep(300);
    }
    const listed = await evaluate(`[...document.querySelectorAll('#characters-list .character-name')].map(n => n.textContent)`);
    const listShown = await visible('#characters');
    await pressKey('Escape');
    await sleep(200);
    check('with two characters the title lists them (Characters), and Escape closes the list', listShown && listed.length === 2 && !(await visible('#characters')), JSON.stringify(listed));

    const again = await relogin();
    check('the title offers "Continue as <name>", which logs in with one tap', again.ok, `${again.ms ?? '?'} ms`);
    await sleep(2500);
    s = await hudState();
    check('a new session starts with the panel and chatbox closed', !(await visible('#hud-panel')) && !(await visible('#hud-chat-box')) && (await free())[0] === toRender(SAFE.left));
    const shownTabs = await evaluate(`[...document.querySelectorAll('#hud-tabs .tab[data-tab]')].filter(t => !t.classList.contains('unavailable')).length`);
    check('after the tutorial the column shows all 13 tabs', shownTabs === 13 && s.runExists, `${shownTabs} tabs, runExists ${s.runExists}`);
    await screenshot('after-tutorial');

    // ---- tabs and the side panel
    await tapElement('#hud-tabs .tab[data-tab="1"]');
    await sleep(400);
    s = await hudState();
    check('a tab opens the side panel on that tab', (await visible('#hud-panel')) && s.activeTab === 1, `activeTab ${s.activeTab}`);
    const sideBox = await rectOf('#surface-side');
    const column = await rectOf('#hud-tabs');
    // (Android: the snap's CSS zoom. Desktop Chrome's emulated pixel ratio lays the page out in CSS px, not device px as
    // the phone's WebView does, and rounds the zoomed 3px frame down to whole CSS px: the canvas inside comes out up to
    // 0.4 HUD px a side larger here than on the phone, where it is exactly 158x218 HUD px; android/test/crisp.mjs)
    const sideTolerance = ANDROID ? 1 : 0.5;
    check('...at 5/6 of the 2004 size (158x218), in from the right edge by no more than the column', Math.abs(sideBox.w - 158 * ZOOM) < sideTolerance && Math.abs(sideBox.h - 218 * ZOOM) < sideTolerance && column.w <= 76 * ZOOM + 0.01 && VIEW.width - SAFE.right - sideBox.x <= (76 + 4 + 4 + 166) * ZOOM + 0.01, JSON.stringify({ side: [sideBox.x, sideBox.w, sideBox.h], column: column.w }));
    check('the open tab shows its red stone', await evaluate(`document.querySelector('#hud-tabs .tab[data-tab="1"]').classList.contains('selected')`));
    await screenshot('panel-stats');
    overlap = await hudOverlaps();
    check('panel open: no HUD control overlaps another or runs off the screen', clean(overlap), JSON.stringify(overlap));
    const orbs = await evaluate(`({ hp: document.getElementById('hp-value').textContent, prayer: document.getElementById('prayer-value').textContent, state: [${C}.hudState().hp, ${C}.hudState().hpMax, ${C}.hudState().prayer] })`);
    check('the hitpoints and prayer orbs show the stats', orbs.hp === String(orbs.state[0]) && orbs.prayer === String(orbs.state[2]) && orbs.state[1] > 0, JSON.stringify(orbs));
    await tapElement('#hud-tabs .tab[data-tab="3"]');
    await sleep(400);
    s = await hudState();
    check('another tab switches the panel', s.activeTab === 3 && (await visible('#hud-panel')), `activeTab ${s.activeTab}`);
    await tapElement('#hud-tabs .tab[data-tab="3"]');
    await sleep(300);
    check('the open tab again closes the panel', !(await visible('#hud-panel')));
    await tapElement('#orb-prayer');
    await sleep(400);
    check('a tap on the prayer orb opens the prayer tab', (await visible('#hud-panel')) && (await hudState()).activeTab === 5);
    await tapElement('#orb-prayer');
    await sleep(300);
    check('...and again closes it', !(await visible('#hud-panel')));

    // ---- the real Run
    s = await hudState();
    await tapElement('#btn-run');
    await waitFor(`${C}.hudState().running === ${!s.running}`, 3000);
    run = await evaluate(`({ running: ${C}.hudState().running, varp: ${C}.var[173] ?? 0, active: document.getElementById('btn-run').classList.contains('active'), energy: document.getElementById('run-energy').textContent, ctrl: ${C}.keyHeld[5] })`);
    check('Run switches the run mode (Player controls) and shows the energy', run.running !== s.running && run.active === run.running && /%$/.test(run.energy) && run.ctrl === 0, JSON.stringify(run));
    await tapElement('#btn-run');
    await waitFor(`${C}.hudState().running === ${s.running}`, 3000);

    // ---- chat: lines over the world, the toggle, the history drag, the filters
    for (const line of ['hello', 'from', 'the hud']) {
        await typeChat(line);
    }
    await sleep(400);
    const lines = await evaluate(`[...document.querySelectorAll('#hud-chat-lines .chat-line')].map(n => n.textContent)`);
    check('the newest chat lines show over the world', (await visible('#hud-chat-lines')) && lines.length === 3 && /the hud$/i.test(lines[2]), JSON.stringify(lines));
    await screenshot('chat-lines');
    const linesBox = await rectOf('#hud-chat-lines');
    await tap(linesBox.x + 40, linesBox.y + linesBox.h / 2);
    await sleep(400);
    check('a tap on them goes through to the world (they do not open the chat)', !(await visible('#hud-chat-box')));
    await stablePosition();
    await tapElement('#btn-chat-toggle');
    await sleep(400);
    check('the chat button opens the chatbox', (await visible('#hud-chat-box')) && !(await visible('#hud-chat-lines')));
    overlap = await hudOverlaps();
    check('chatbox open: no HUD control overlaps another or runs off the screen', clean(overlap), JSON.stringify(overlap));
    for (let i = 0; i < 6; i++) {
        await typeChat(`line ${i}`);
    }
    const chat = await rectOf('#surface-chat');
    const scroll0 = await evaluate(`${C}.chatScrollPos`);
    await drag(chat.x + 200, chat.y + 20, chat.x + 200, chat.y + 70, 10);
    await sleep(300);
    const scroll1 = await evaluate(`${C}.chatScrollPos`);
    check('dragging the chat history (chat surface) scrolls it', scroll1 > scroll0, `${scroll0} → ${scroll1}`);
    await tapElement('#btn-chat-toggle');
    await sleep(300);
    check('the toggle closes the chatbox again', !(await visible('#hud-chat-box')) && (await visible('#hud-chat-lines')));

    await tapElement('#btn-chat-toggle');
    await sleep(300);
    const modes0 = (await hudState()).chatModes;
    await tapElement('.chat-mode[data-chat-mode="0"]');
    await sleep(400);
    const modes1 = (await hudState()).chatModes;
    const label = await evaluate(`document.querySelector('.chat-mode[data-chat-mode="0"] .chat-value').textContent`);
    check('Public chat cycles its filter and shows it', modes1[0] === (modes0[0] + 1) % 4 && label === ['On', 'Friends', 'Off', 'Hide'][modes1[0]], `${modes0[0]} → ${modes1[0]} '${label}'`);
    for (let i = 0; i < 3; i++) {
        await tapElement('.chat-mode[data-chat-mode="0"]');
        await sleep(400);
    }
    check('...four taps go round to where it was', (await hudState()).chatModes[0] === modes0[0]);

    // The keyboard bar refuses what an input would not take: the host names the input's characters. A private message
    // (opened here client-side) takes 'text', the name to report 'alnum' (the 2004 Report abuse button, which the HUD
    // leaves out, still opens that screen at its classic place). The game raises the keyboard for both; the bar's Cancel
    // closes them.
    const charsetOf = async kind => {
        const up = await waitFor(`window.lcHost.keyboard.isShown() && window.lcHost.keyboard.context?.kind === '${kind}'`, 3000, 50);
        const context = await evaluate('window.lcHost.keyboard.context');
        await evaluate('window.LostCityHost.keyboard.cancel()');
        await sleep(300);
        return up.ok ? [context.charset, context.maxLength] : null;
    };
    await evaluate(`(() => { const c = ${C}; c.socialInput = ''; c.socialInputHeader = 'Enter message to send to Zezima'; c.socialInputType = 3; c.socialInputOpen = true; c.redrawChat = true; })()`);
    const message3 = await charsetOf('social');
    await evaluate(`${C}.tapAt(462, 483, 1)`);
    const report = await charsetOf('report');
    const closed = await evaluate(`({ social: ${C}.socialInputOpen, modal: ${C}.mainModalId })`);
    check('the keyboard bar\'s charsets: \'text\' for a private message, \'alnum\' for the name to report (its Cancel closes both)', same(message3, ['text', 80]) && same(report, ['alnum', 12]) && !closed.social && closed.modal === -1, JSON.stringify({ message: message3, report, closed }));
    await tapElement('#btn-chat-toggle');
    await sleep(300);

    // ---- worn equipment: on touch a slot takes its whole grid cell, but exactly one slot takes a point. The cape, amulet
    // and arrows sit 41 px apart in 56 px cells: a tap just inside the cape's right edge removes the cape (it used to
    // remove the amulet).
    const invOf = tab => `(() => { const list = ${C}.chatInterface.constructor.list;
        const find = (com, x, y, scroll) => { for (let i = 0; i < (com?.children?.length ?? 0); i++) { const child = list[com.children[i]]; if (!child) continue;
            const cx = x + com.childX[i] + child.x, cy = y + com.childY[i] + child.y - scroll;
            if (child.type === 2) return { com: child, x: cx, y: cy };
            const found = child.type === 0 ? find(child, cx, cy, child.scrollPos) : null; if (found) return found; } return null; };
        return find(list[${C}.sideIcon[${tab}]], 553, 205, 0); })()`; // (the inventory under a tab's interface, at its virtual position)
    await tapElement('#hud-tabs .tab[data-tab="3"]');
    const carried = `${invOf(3)}.com.linkObjType.filter(o => o > 0).length`;
    const had = await evaluate(carried);
    await evaluate(`window.LostCityHost.keyboard.insertText('::give red_cape\\n::give amulet_of_strength\\n::give bronze_arrow 20\\n')`);
    await waitFor(`${carried} >= ${had + 3}`, 4000, 100);
    for (let i = 0; i < 8; i++) {
        // wear the first wearable item: its slot's top option, as a tap there would run it
        const slot = await evaluate(`(() => { const c = ${C}, inv = ${invOf(3)}, com = inv.com;
            for (let s = 0; s < com.linkObjType.length; s++) { if (com.linkObjType[s] <= 0) continue;
                const offset = s < 20 && com.invBackgroundX ? [com.invBackgroundX[s], com.invBackgroundY[s]] : [0, 0];
                c.mouseX = inv.x + (s % com.width) * (com.marginX + 32) + offset[0] + 16; c.mouseY = inv.y + ((s / com.width) | 0) * (com.marginY + 32) + offset[1] + 16;
                c.buildMinimenu(); if (/^(Wear|Wield)/.test(c.menuOption[c.menuNumEntries - 1])) { c.doAction(c.menuNumEntries - 1); return s; } }
            return -1; })()`);
        if (slot < 0) {
            break;
        }
        await waitFor(`${invOf(3)}.com.linkObjType[${slot}] <= 0`, 3000, 50);
    }
    await tapElement('#hud-tabs .tab[data-tab="4"]');
    await sleep(400);
    const worn = await evaluate(`(() => { const w = ${invOf(4)}; const icon = s => [w.x + (s % w.com.width) * (w.com.marginX + 32) + w.com.invBackgroundX[s], w.y + ((s / w.com.width) | 0) * (w.com.marginY + 32) + w.com.invBackgroundY[s]];
        return { id: w.com.id, items: [1, 2, 13].map(s => w.com.linkObjType[s]), cape: icon(1), amulet: icon(2), ammo: icon(13) }; })()`);
    const strip = await evaluate(`(() => { const c = ${C}, out = [];
        for (let x = ${worn.cape[0] - 14}; x <= ${worn.ammo[0] + 46}; x++) {
            c.mouseX = x; c.mouseY = ${worn.cape[1] + 16}; c.buildMinimenu();
            const slots = new Set(); for (let i = 0; i < c.menuNumEntries; i++) if (c.menuParamC[i] === ${worn.id}) slots.add(c.menuParamB[i]);
            out.push([x, [...slots].join()]); }
        return out; })()`);
    const onIcon = (x, icon) => x >= icon[0] && x < icon[0] + 32;
    const wrongSlots = strip.filter(([x, slots]) => slots.includes(',') || (onIcon(x, worn.cape) && slots !== '1') || (onIcon(x, worn.amulet) && slots !== '2') || (onIcon(x, worn.ammo) && slots !== '13'));
    p = await surfacePoint('#surface-side', worn.cape[0] + 30 - 553, worn.cape[1] + 16 - 205); // 2 px inside the cape's right edge
    await tap(p.x, p.y);
    await waitFor(`${invOf(4)}.com.linkObjType[1] <= 0 || ${invOf(4)}.com.linkObjType[2] <= 0`, 3000, 50);
    const removed = await evaluate(`[1, 2, 13].map(s => ${invOf(4)}.com.linkObjType[s])`);
    check('worn equipment: one slot per point (the cape, amulet and arrows), and a tap at the cape\'s edge removes the cape', worn.items.every(o => o > 0) && wrongSlots.length === 0 && removed[0] <= 0 && removed[1] === worn.items[1] && removed[2] === worn.items[2], JSON.stringify({ worn: worn.items, wrong: wrongSlots.slice(0, 4), after: removed }));

    // ---- tap-to-drop: the chat bar's drop button. While it is on, the button and the inventory panel's frame are red, a
    // tap on an item drops it whatever its top option (shrimps: Eat), a long-press still gives the item's menu; off
    // again, a tap does the top option (logs: Use).
    await tapElement('#hud-tabs .tab[data-tab="3"]');
    await sleep(300);
    const had2 = await evaluate(carried);
    await evaluate(`window.LostCityHost.keyboard.insertText('::give shrimp\\n::give logs\\n')`);
    await waitFor(`${carried} >= ${had2 + 2}`, 4000, 100);
    await sleep(300);
    // the slot whose top option matches, and its centre (virtual coordinates)
    const slotWith = async top => evaluate(`(() => { const c = ${C}, inv = ${invOf(3)}, com = inv.com;
        for (let s = 0; s < com.linkObjType.length; s++) { if (com.linkObjType[s] <= 0) continue;
            const x = inv.x + (s % com.width) * (com.marginX + 32) + 16, y = inv.y + ((s / com.width) | 0) * (com.marginY + 32) + 16;
            c.mouseX = x; c.mouseY = y; c.buildMinimenu(); if (${top}.test(c.menuOption[c.menuNumEntries - 1])) return { s, x, y }; }
        return null; })()`);
    const shrimps = await slotWith('/^Eat @lre@Shrimps/');
    const logs = await slotWith('/^Use @lre@Logs/');
    const DROP_STATE = `client: ${C}.hudState().tapToDrop, red: document.getElementById('hud-panel').classList.contains('drop-mode'), active: document.getElementById('btn-drop').classList.contains('active'), pressed: document.getElementById('btn-drop').getAttribute('aria-pressed')`;
    const dropState = () => evaluate(`({ ${DROP_STATE} })`);
    await tapElement('#btn-drop');
    await sleep(200);
    const dropOn = await dropState();
    check('the drop button turns tap-to-drop on: the button and the inventory\'s frame red', dropOn.client === true && dropOn.red && dropOn.active && dropOn.pressed === 'true', JSON.stringify(dropOn));
    await screenshot('tap-to-drop');
    const hpBefore = await evaluate(`${C}.hudState().hp`);
    let dropMark = await evaluate('window.__actions.length');
    p = await surfacePoint('#surface-side', shrimps.x - 553, shrimps.y - 205);
    const labelMark = await evaluate('window.__labels.length');
    await tap(p.x, p.y);
    await waitFor(`window.__labels.length > ${labelMark}`, 1000, 20);
    const slotLabel = await evaluate(LABEL);
    await screenshot('action-label-slot');
    const dropped = await waitFor(`${invOf(3)}.com.linkObjType[${shrimps.s}] <= 0`, 3000, 50);
    const dropActions = await evaluate(`window.__actions.slice(${dropMark})`);
    check('...then a tap on the shrimps (top option Eat) drops them', shrimps && dropped.ok && dropActions.length === 1 && /^Drop @lre@Shrimps/.test(dropActions[0]) && (await evaluate(`${C}.hudState().hp`)) === hpBefore, JSON.stringify({ shrimps, actions: dropActions }));
    check('...and says so beside the slot (the action label, in the menu\'s look)', slotLabel.shown && slotLabel.text === 'Drop Shrimps' && slotLabel.event.text === dropActions[0] && Math.abs(slotLabel.event.x - p.x) <= 1 && Math.abs(slotLabel.event.y - p.y) <= 1 && besidePoint(slotLabel), JSON.stringify({ p, ...slotLabel }));
    p = await surfacePoint('#surface-side', logs.x - 553, logs.y - 205);
    await touch('touchStart', p.x, p.y);
    await sleep(700);
    const logsMenu = await evaluate(`({ shown: !document.getElementById('menu-layer').hidden, rows: [...document.querySelectorAll('#menu .menu-option')].map(n => n.textContent) })`);
    await touch('touchEnd');
    await sleep(200);
    await pressKey('Escape');
    await sleep(300);
    check('...a long-press on an item still gives its menu (and does nothing by itself)', logsMenu.shown && logsMenu.rows[0] === 'Use Logs' && logsMenu.rows.includes('Drop Logs') && (await evaluate(`${invOf(3)}.com.linkObjType[${logs.s}]`)) > 0, JSON.stringify(logsMenu));
    await tapElement('#hud-tabs .tab[data-tab="1"]');
    await sleep(300);
    const otherTab = await dropState();
    await tapElement('#hud-tabs .tab[data-tab="3"]');
    await sleep(300);
    check('...it stays on with another tab open (the frame is red only on the inventory)', otherTab.client === true && otherTab.active && !otherTab.red && (await dropState()).red, JSON.stringify(otherTab));
    await tapElement('#btn-drop');
    await sleep(200);
    dropMark = await evaluate('window.__actions.length');
    await tap(p.x, p.y);
    await sleep(500);
    const dropOff = await evaluate(`({ ${DROP_STATE}, actions: window.__actions.slice(${dropMark}), useMode: ${C}.useMode, logs: ${invOf(3)}.com.linkObjType[${logs.s}] })`);
    check('...and off again a tap does the top option (Use Logs)', dropOff.client === false && !dropOff.red && !dropOff.active && dropOff.actions.length === 1 && /^Use @lre@Logs/.test(dropOff.actions[0]) && dropOff.useMode === 1 && dropOff.logs > 0, JSON.stringify(dropOff));
    await evaluate(`(() => { ${C}.useMode = 0; ${C}.redrawSide = true; })()`);
    await tapElement('#btn-drop'); // (on, for the bank below)
    await sleep(200);

    // ---- the action label: a tap that acts on something in the world says what it did beside its red cross (Take, on
    // the shrimps dropped above, under the player), fading out over 1 s and never taking a touch; a walk (a yellow
    // cross) leaves it
    const feet = await evaluate(`(() => { const c = ${C}, q = c.localPlayer; c.getOverlayPos(q.x, q.z, 0); return { x: c.projectX, y: c.projectY }; })()`);
    let takeAt = null;
    for (const [dx, dy] of [[0, 0], [0, -4], [4, 0], [-4, 0], [0, 4], [6, -6], [-6, -6], [6, 6], [-6, 6], [0, -8], [10, 0], [-10, 0]]) {
        const at = { x: feet.x + dx, y: feet.y + dy };
        if (/^Take @lre@Shrimps/.test((await hover(at.x, at.y)).at(-1))) {
            takeAt = at;
            break;
        }
    }
    const takeMark = await evaluate('window.__actions.length');
    // the fade as the label's own animation runs it, sampled in the page every frame (a busy machine delays what is read
    // from here by hundreds of ms): [its time, the opacity], and when the label is hidden (ms since the fade started).
    // Only a fade that starts from now on, the Take's: the Use Logs label can still be fading, and end, before it shows
    await evaluate(`(() => { const n = document.getElementById('action-label'), layer = document.getElementById('label-layer'), until = performance.now() + 8000, t0 = document.timeline.currentTime;
        const fade = (window.__fade = { samples: [], start: null, duration: null, hiddenAt: null, fades: 0 });
        const sample = now => { const a = n.getAnimations()[0];
            if (a && a.startTime !== null && a.startTime >= t0) {
                if (a.startTime !== fade.start) Object.assign(fade, { samples: [], start: a.startTime, duration: a.effect.getComputedTiming().duration, fades: fade.fades + 1 });
                fade.samples.push([Math.round(a.currentTime), Number(getComputedStyle(n).opacity)]); }
            if (fade.start !== null && layer.hidden) { fade.hiddenAt = Math.round(now - fade.start); return; }
            if (now < until) requestAnimationFrame(sample); };
        requestAnimationFrame(sample); })()`);
    if (takeAt) {
        p = await worldPoint(takeAt.x, takeAt.y);
        await tap(p.x, p.y);
    }
    // (the Take first, then its label: the client says what it did as it does it)
    await waitFor(`window.__actions.length > ${takeMark}`, 3000, 20);
    const labelShown = await waitFor(`/^Take /.test(window.__labels.at(-1)?.text)`, 1000, 20);
    const worldLabel = await evaluate(LABEL);
    const cross = await evaluate(`(() => { const c = ${C}; return [c.crossMode, c.crossX - c.viewportX, c.crossY - c.viewportY]; })()`);
    const crossAt = await worldPoint(cross[1], cross[2]);
    await screenshot('action-label-world');
    const takeActions = await evaluate(`window.__actions.slice(${takeMark})`);
    check('the action label: a tap on the dropped shrimps (Take) says so beside its red cross', takeAt && labelShown.ok && worldLabel.shown && takeActions.length === 1 && worldLabel.event.text === takeActions[0] && worldLabel.text === 'Take Shrimps' && cross[0] === 2 && Math.abs(worldLabel.event.x - crossAt.x) <= 1 && Math.abs(worldLabel.event.y - crossAt.y) <= 1 && besidePoint(worldLabel), JSON.stringify({ takeAt, crossAt, worldLabel, takeActions }));
    check('...and never takes a touch', !worldLabel.touchable, JSON.stringify(worldLabel));
    const labelGone = await waitFor(`document.getElementById('label-layer').hidden && window.__fade.hiddenAt !== null`, 3000, 50);
    const fade = await evaluate('window.__fade');
    // (the frame nearest 600 ms into it, half-way through the fading part: somewhere in 450-900 ms on a busy machine)
    const at600 = fade.samples.reduce((best, s) => (best === null || Math.abs(s[0] - 600) < Math.abs(best[0] - 600) ? s : best), null);
    const fadeOk = fade.duration === 1000 && at600 !== null && at600[0] >= 450 && at600[0] <= 900 && at600[1] > 0.05 && at600[1] < 0.9;
    check('...fading out over about 1 s', fadeOk && labelGone.ok && fade.hiddenAt > 700 && fade.hiddenAt < 1600, JSON.stringify({ duration: fade.duration, at600, frames: fade.samples.length, hiddenAt: fade.hiddenAt, fades: fade.fades }));
    const walkTo = await walkablePoint([[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2]]);
    const walkMark = await evaluate('window.__actions.length');
    await evaluate(`window.lcHost.onClientEvent('action-label', { text: 'Take @lre@Shrimps', x: 300, y: 150 })`);
    if (walkTo) {
        await tap(walkTo.x, walkTo.y);
    }
    await sleep(200);
    const walkLabel = await evaluate(`({ ...${LABEL}, actions: window.__actions.slice(${walkMark}) })`);
    check('...and a walk leaves it (no label of its own)', walkTo && walkLabel.shown && walkLabel.event.x === 300 && same(walkLabel.actions, ['Walk here']), JSON.stringify(walkLabel));

    // ---- quest list: drag to scroll on the side surface
    await tapElement('#hud-tabs .tab[data-tab="2"]');
    await sleep(500);
    const side = await rectOf('#surface-side');
    const sideAt = (ax, ay) => [side.x + (ax * side.w) / 190, side.y + (ay * side.h) / 261]; // (the panel is shown at 5/6)
    await touch('touchStart', ...sideAt(87, 195));
    await sleep(30);
    let questScroll = null;
    for (let i = 1; i <= 10; i++) {
        await touch('touchMove', ...sideAt(87, 195 - 4.5 * i));
        await sleep(25);
        questScroll = await evaluate(`(() => { const t = ${C}.touchScroll; return t && typeof t === 'object' ? t.scrollPos : null; })()`);
    }
    await touch('touchEnd');
    await sleep(300);
    check('dragging the quest list (side surface) scrolls it', questScroll > 0, `scrollPos ${questScroll}`);

    // A flick: the list glides on after the finger lifts, and a tap on it while it glides only stops it (as on a native
    // list); at rest the same tap clicks what is under it.
    const questList = `(() => { const list = ${C}.chatInterface.constructor.list; return list[list[${C}.sideIcon[2]].children[0]]; })()`;
    await evaluate(`(() => { ${questList}.scrollPos = 0; ${C}.redrawSide = true; })()`);
    await sleep(300);
    await touch('touchStart', ...sideAt(90, 210));
    await sleep(16);
    for (let i = 1; i <= 6; i++) {
        await touch('touchMove', ...sideAt(90, 210 - 22 * i));
        await sleep(12);
    }
    await touch('touchEnd');
    await sleep(150);
    const gliding = await evaluate(`${C}.touchGlide?.velocity ?? 0`);
    let mark = await evaluate('window.__actions.length');
    await tap(...sideAt(70, 120));
    await sleep(400);
    const stopped = await evaluate(`({ glide: ${C}.touchGlide, actions: window.__actions.slice(${mark}), modal: ${C}.mainModalId })`);
    check('a tap on the quest list while it glides on after a flick only stops it', Math.abs(gliding) >= 1 && stopped.glide === null && stopped.actions.length === 0 && stopped.modal === -1, JSON.stringify({ gliding, ...stopped }));
    await evaluate(`(() => { ${questList}.scrollPos = 0; ${C}.redrawSide = true; })()`);
    await sleep(300);
    let row = null; // a quest under the finger (not a heading)
    for (const ay of [120, 112, 128, 104, 136]) {
        if ((await menuAt(553 + 70, 205 + ay))[0] !== 'Cancel') {
            row = ay;
            break;
        }
    }
    mark = await evaluate('window.__actions.length');
    await tap(...sideAt(70, row ?? 120));
    const journal = await waitFor(`${C}.mainModalId !== -1`, 3000);
    check('...while at rest the same tap clicks the quest there (its journal opens)', row !== null && journal.ok && (await evaluate(`window.__actions.length - ${mark}`)) === 1, `row ${row}, journal ${journal.ok}`);
    await evaluate(`${C}.closeModal()`);
    await sleep(250);

    // ---- the panel steps aside for a window without a side panel (smithing) and comes back
    await tapElement('#hud-tabs .tab[data-tab="3"]');
    await sleep(400);
    await evaluate(`(() => { const c = ${C}; c.mainModalId = ${SMITHING}; })()`);
    await sleep(500);
    const smith = await evaluate(`({ modal: [${C}.modalX, ${C}.modalY], free: [${C}.freeLeft, ${C}.freeRight] })`);
    check('a window without a side panel: the player\'s panel steps aside and the window fits', !(await visible('#hud-panel')) && smith.modal[0] >= smith.free[0] && smith.modal[0] + 512 <= smith.free[1], JSON.stringify(smith));
    await screenshot('window-smithing');
    await evaluate(`(() => { const c = ${C}; c.mainModalId = -1; })()`);
    await sleep(500);
    check('...and comes back when it closes', await visible('#hud-panel'));
    // a tab tapped while such a window is open shows the panel over it (the window stays where it is); that panel stays
    // when the window closes, and the world's free part then ends at it
    await evaluate(`(() => { const c = ${C}; c.mainModalId = ${SMITHING}; })()`);
    await sleep(400);
    await tapElement('#hud-tabs .tab[data-tab="3"]');
    await sleep(400);
    const smithOver = await evaluate(`({ modal: [${C}.modalX, ${C}.modalY], free: [${C}.freeLeft, ${C}.freeRight] })`);
    const panelOverSmith = await visible('#hud-panel');
    await evaluate(`(() => { const c = ${C}; c.mainModalId = -1; })()`);
    await sleep(400);
    const smithAfter = await evaluate(`({ free: [${C}.freeLeft, ${C}.freeRight], panel: document.getElementById('hud-panel').getBoundingClientRect().left })`);
    check('a tab tapped while it is open shows the panel over the window, which stays put; the panel stays after it', panelOverSmith && same(smithOver, smith) && (await visible('#hud-panel')) && smithAfter.free[1] / RENDER <= smithAfter.panel + 0.5, JSON.stringify({ smithOver, smithAfter }));

    // ---- the bank: window + its side panel at the right edge, the tab column hidden, Run disabled
    await typeChat('::~bank');
    const bank = await waitFor(`${C}.mainModalId !== -1 && ${C}.sideModalId !== -1`, 8000);
    await sleep(800);
    const bankGeo = await evaluate(`(() => { const c = ${C}; const r = document.getElementById('hud-panel').getBoundingClientRect(); return { modal: [c.modalX, c.modalY], free: [c.freeLeft, c.freeRight], panel: [r.left, r.right] }; })()`);
    check('the bank: its window and inventory side by side, clear of the notch', bank.ok && (await visible('#hud-panel')) && !(await visible('#hud-tabs')) && bankGeo.modal[0] >= toRender(SAFE.left) && (bankGeo.modal[0] + 512) / RENDER <= bankGeo.panel[0] + 0.5 && bankGeo.panel[1] <= VIEW.width - SAFE.right + 0.5, JSON.stringify(bankGeo));
    await screenshot('bank');
    overlap = await hudOverlaps();
    // tap-to-drop, left on, deposits all in the bank: its inventory is framed red, and a tap on the logs there does "Deposit All"
    const bankSide = invOf(3).replace(`list[${C}.sideIcon[3]]`, `list[${C}.sideModalId]`);
    const logsType = await evaluate(`${invOf(3)}.com.linkObjType[${logs.s}]`);
    const bankLogs = await evaluate(`(() => { const inv = ${bankSide}, com = inv.com; const s = com.linkObjType.indexOf(${logsType});
        return s < 0 ? null : { s, x: inv.x + (s % com.width) * (com.marginX + 32) + 16, y: inv.y + ((s / com.width) | 0) * (com.marginY + 32) + 16 }; })()`);
    const bankMark = await evaluate('window.__actions.length');
    if (bankLogs) {
        p = await surfacePoint('#surface-side', bankLogs.x - 553, bankLogs.y - 205);
        await tap(p.x, p.y);
        await sleep(600);
    }
    const bankDrop = await evaluate(`({ client: ${C}.hudState().tapToDrop, deposit: ${C}.hudState().tapDeposit, red: document.getElementById('hud-panel').classList.contains('drop-mode'), actions: window.__actions.slice(${bankMark}) })`);
    check('the bank, with tap-to-drop left on: a red frame, and a tap on the logs in its inventory deposits all of them', bankLogs && bankDrop.client === true && bankDrop.deposit === true && bankDrop.red && bankDrop.actions.length === 1 && /^Deposit All @lre@Logs/.test(bankDrop.actions[0]), JSON.stringify({ bankLogs, ...bankDrop }));
    check('the bank: the minimap, orbs and tab column give way; nothing overlaps', !(await visible('#hud-map')) && !(await visible('#hud-orbs')) && !(await visible('#btn-run')) && overlap.found.length === 0, JSON.stringify(overlap));
    await evaluate(`${C}.closeModal()`);
    await sleep(800);
    check('after the bank the player\'s panel and the tab column are back', (await visible('#hud-panel')) && (await visible('#hud-tabs')));

    // ---- the World map: the globe on the ring opens the 2004 map in a sheet, centred on the player (a dot in a red ring);
    // drag pans and glides on, a pinch settles on one of the applet's zooms, a double-tap zooms in and a two-finger tap
    // out; the Key flashes a kind of icon, the overview shows, Underground shows what lies under the view, the centre
    // button glides back to the player; closed, the map's loop sleeps; it opens on the underground map in a dungeon
    const MAP = `document.getElementById('worldmap-frame')?.contentWindow?.lcMapView`;
    const mapAt = () => evaluate(`(() => { const m = ${MAP}; return { x: m.fx + m.mapOriginX, z: m.mapOriginZ + m.mapHeight - m.fz, zoom: m.zoom, targetZoom: m.targetZoom, area: m.mapArea, ready: m.ready, paused: m.paused, flash: m.flashTimer, key: m.currentKey, overview: m.showOverview, player: m.player, moving: !!(m.velocity || m.zoomTo || m.glideTo) }; })()`);
    const mapSettled = () => waitFor(`(() => { const m = ${MAP}; return m && !m.velocity && !m.zoomTo && !m.glideTo; })()`, 5000, 50);
    // the map canvas's pixel at a point of the sheet's map (CSS px from its top left)
    const mapPixel = (x, y) => `(() => { const c = document.getElementById('worldmap-frame').contentDocument.getElementById('canvas'); return [...c.getContext('2d').getImageData(${x}, ${y}, 1, 1).data].slice(0, 3); })()`;
    // (the host's messages reach the map a moment later: wait for what they do)
    const mapCentredOn = (tile, timeoutMs = 5000) => waitFor(`(() => { const m = ${MAP}; return m?.ready && !m.glideTo && Math.abs(m.fx + m.mapOriginX - ${tile.x + 0.5}) < 1 && Math.abs(m.mapOriginZ + m.mapHeight - m.fz - ${tile.z + 0.5}) < 1; })()`, timeoutMs, 50);
    const near = (a, b, d = 1) => Math.abs(a - b) < d;
    const playerTile = await evaluate(`${C}.hudPlayerTile()`);
    check('the World map button sits on the minimap\'s ring, lower right', (await visible('#btn-worldmap')) && (await (async () => { const g = await rectOf('#btn-worldmap'); const m = await rectOf('#hud-map'); return g.cx > m.cx && g.cy > m.cy && near(Math.hypot(g.cx - m.cx, g.cy - m.cy), m.w / 2 - 2, 2); })()));
    await tapElement('#btn-worldmap');
    const mapOpened = await waitFor(`${MAP}?.ready === true`, 20000);
    await mapSettled();
    let at = await mapAt();
    const frame = await rectOf('#worldmap-frame');
    // (the map's canvas is in the iframe's own px: the frame's on-screen size divided by the HUD's zoom)
    const frameCentre = [Math.floor(frame.w / ZOOM / 2), Math.floor(frame.h / ZOOM / 2)];
    const marked = await waitFor(`${mapPixel(...frameCentre)}.every(v => v > 240)`, 3000, 50); // (the white dot)
    check('the globe opens the World map over the world, centred on the player, who is marked there', mapOpened.ok && (await visible('#worldmap')) && at.area === 0 && near(at.x, playerTile.x + 0.5) && near(at.z, playerTile.z + 0.5) && marked.ok, JSON.stringify({ playerTile, at, centrePixel: await evaluate(mapPixel(...frameCentre)), ms: mapOpened.ms }));
    await screenshot('worldmap');

    await drag(frame.cx, frame.cy, frame.cx - 120, frame.cy - 60, 12, 20);
    await mapSettled();
    const dragged = await mapAt();
    check('dragging the map pans it with the finger (and it glides on)', dragged.x - at.x >= (120 / (at.zoom / 2)) * 0.9 && at.z - dragged.z >= (60 / (at.zoom / 2)) * 0.9, JSON.stringify({ at, dragged }));

    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: frame.cx - 40, y: frame.cy, id: 1 }] });
    await sleep(30);
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: frame.cx - 40, y: frame.cy, id: 1 }, { x: frame.cx + 40, y: frame.cy, id: 2 }] });
    for (let i = 1; i <= 10; i++) {
        await S('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: frame.cx - 40 - 4 * i, y: frame.cy, id: 1 }, { x: frame.cx + 40 + 4 * i, y: frame.cy, id: 2 }] });
        await sleep(25);
    }
    const pinching = await mapAt();
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await mapSettled();
    const pinched = await mapAt();
    check('a pinch zooms the map, then it settles on the applet\'s 100 % (its labels show again)', pinching.zoom > dragged.zoom * 1.3 && pinching.targetZoom === -1 && pinched.zoom === 8 && pinched.targetZoom === 8, JSON.stringify({ before: dragged.zoom, pinching: pinching.zoom, pinched: pinched.zoom }));

    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: frame.cx - 40, y: frame.cy, id: 1 }, { x: frame.cx + 40, y: frame.cy, id: 2 }] });
    await sleep(60);
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await mapSettled();
    const twoFinger = await mapAt();
    await tap(frame.cx, frame.cy);
    await sleep(120);
    await tap(frame.cx, frame.cy);
    await mapSettled();
    const doubleTapped = await mapAt();
    check('a two-finger tap zooms out a step (75 %), a double-tap back in (100 %)', twoFinger.zoom === 6 && doubleTapped.zoom === 8, JSON.stringify({ twoFinger: twoFinger.zoom, doubleTapped: doubleTapped.zoom }));

    await tapElement('#worldmap-key');
    await sleep(200);
    const keyRows = await evaluate(`[...document.querySelectorAll('#worldmap-keys .worldmap-key-row')].map(r => r.textContent)`);
    const bankRow = keyRows.indexOf('Bank');
    await tapElement(`#worldmap-keys .worldmap-key-row:nth-child(${bankRow + 1})`);
    await sleep(150);
    const flashing = await mapAt();
    await screenshot('worldmap-key');
    check('the Key lists the map\'s icons by name; Bank flashes every bank', (await visible('#worldmap-keys')) && keyRows.length > 20 && bankRow !== -1 && flashing.key === 5 && flashing.flash > 0 && (await evaluate(`document.querySelector('#worldmap-keys .worldmap-key-row.on')?.textContent`)) === 'Bank', JSON.stringify({ rows: keyRows.length, bankRow, flashing }));
    await tapElement('#worldmap-key');
    await tapElement('#worldmap-overview');
    await sleep(200);
    check('the Key closes again, and the overview shows', !(await visible('#worldmap-keys')) && (await mapAt()).overview === true);
    await screenshot('worldmap-overview');
    await tapElement('#worldmap-overview');
    await mapSettled();

    const surfaceAt = await mapAt();
    await tapElement('#worldmap-area button[data-area="1"]');
    const underground = await waitFor(`${MAP}?.ready === true && ${MAP}.mapArea === 1`, 20000);
    const under = await mapAt();
    check('Underground shows what lies under the view (6400 tiles north), and the button lights', underground.ok && near(under.x, surfaceAt.x, 1.5) && near(under.z, surfaceAt.z + 6400, 1.5) && (await evaluate(`document.querySelector('#worldmap-area button[data-area="1"]').classList.contains('on')`)), JSON.stringify({ surfaceAt, under }));
    await screenshot('worldmap-underground');
    await tapElement('#worldmap-area button[data-area="0"]');
    await waitFor(`${MAP}?.ready === true && ${MAP}.mapArea === 0`, 20000);
    await tapElement('#worldmap-me');
    const centred = await mapCentredOn(playerTile);
    at = await mapAt();
    check('back on the surface, the centre button glides back to the player', centred.ok && at.area === 0, JSON.stringify({ playerTile, at }));

    await tapElement('#worldmap-close');
    await sleep(300);
    check('Close closes the sheet, and the map\'s loop sleeps', !(await visible('#worldmap')) && (await mapAt()).paused === true && (await visible('#btn-worldmap')));

    // in a dungeon (Edgeville's) the map opens underground, on the player; Escape closes it
    await typeChat('::tele 0,48,154,25,12');
    const inDungeon = await waitFor(`${C}.hudPlayerTile()?.z === 9868`, 8000);
    await tapElement('#btn-worldmap');
    const reopened = await waitFor(`${MAP}?.ready === true && ${MAP}.mapArea === 1 && !${MAP}.paused`, 20000);
    await mapSettled();
    at = await mapAt();
    check('in a dungeon the World map opens underground, on the player', inDungeon.ok && reopened.ok && near(at.x, 3097.5) && near(at.z, 9868.5), JSON.stringify(at));
    await pressKey('Escape');
    await sleep(200);
    check('Escape closes the World map', !(await visible('#worldmap')));
    await evaluate('window.LostCityHost.memoryWarning()');
    await tapElement('#btn-worldmap');
    const remade = await waitFor(`${MAP}?.ready === true && !document.getElementById('worldmap').classList.contains('loading')`, 20000);
    check('a memory warning drops the closed map, which is made again at the next opening', remade.ok && (await evaluate(`document.querySelectorAll('#worldmap-frame').length`)) === 1 && (await mapCentredOn({ x: 3097, z: 9868 })).ok);
    await tapElement('#worldmap-close');
    await sleep(200);
    await typeChat(`::tele 0,${playerTile.x >> 6},${playerTile.z >> 6},${playerTile.x & 63},${playerTile.z & 63}`);
    await waitFor(`${C}.hudPlayerTile()?.x === ${playerTile.x} && ${C}.hudPlayerTile()?.z === ${playerTile.z}`, 8000);
    await sleep(1500);

    // ---- Settings: the camera pad on, and the drawn 2004 options menu (Options menu: Classic), until the Settings below
    await tapElement('#btn-settings');
    await sleep(400);
    await tapElement('.seg[data-setting="cameraButtons"] button[data-value="true"]');
    await sleep(150);
    await tapElement('#nav-controls');
    await tapElement('.seg[data-setting="largeMenus"] button[data-value="false"]');
    await sleep(150);
    await tapElement('#nav-display');
    await tapElement('#settings-close');
    await sleep(400);
    p = await worldPoint(300, 200);
    await touch('touchStart', p.x, p.y);
    await sleep(650);
    await touch('touchEnd');
    await sleep(200);
    const drawn = await evaluate(`${C}.isMenuOpen && document.getElementById('menu-layer').hidden`);
    await pressKey('Escape');
    await sleep(300);
    check('Options menu: Classic: a long-press opens the drawn 2004 menu, and Escape closes it', drawn && !(await evaluate(`${C}.isMenuOpen`)), `drawn ${drawn}`);

    // ---- a dialogue with a choice (the ::~help list of developer commands): its answers as finger-sized rows
    await typeChat('::~help');
    const dialog = await waitFor(`(() => { const d = ${C}.hudDialog?.(); return d && d.options.length >= 2 ? d.options.length : 0; })()`, 6000);
    await sleep(500);
    const answers = await evaluate(`(() => { const n = document.getElementById('hud-dialog'); const rows = [...n.querySelectorAll('.dialog-option')]; return { shown: !n.hidden && n.getClientRects().length > 0, rows: rows.length, h: rows[0]?.getBoundingClientRect().height ?? 0, chat: !document.getElementById('hud-chat-box').hidden }; })()`);
    await screenshot('dialogue-answers');
    check('a dialogue with a choice shows its answers as finger-sized rows in the chatbox\'s place', dialog.ok && answers.shown && answers.rows === dialog.value && answers.h >= 36 && !answers.chat, JSON.stringify({ options: dialog.value, ...answers }));
    overlap = await hudOverlaps();
    check('...where the camera pad gives way to its five answers (no room above them); nothing overlaps', dialog.value === 5 && !(await visible('#hud-camera')) && clean(overlap), JSON.stringify({ options: dialog.value, ...overlap }));
    if (answers.shown) {
        const before = await evaluate(`JSON.stringify(${C}.hudDialog()?.options.map(o => o.text))`);
        await tapElement('#hud-dialog .dialog-option:first-child');
        await sleep(800);
        const after = await evaluate(`JSON.stringify(${C}.hudDialog()?.options.map(o => o.text) ?? null)`);
        check('...and a tap on one answers it (the dialogue moves on)', after !== before, `${before.slice(0, 80)} → ${String(after).slice(0, 80)}`);
    }
    await evaluate(`${C}.closeModal?.()`);
    await sleep(500);

    // ---- the panel steps aside for a dialogue too (emulated: the chatbox shows an NPC dialogue page). A hardware
    // keyboard's Space reaches the page as typed text (UIKit's text system, not pressKey): a space in the chat line,
    // and while the dialogue waits for "Click here to continue" it continues it, like Return.
    await evaluate(`window.LostCityHost.keyboard.insertText(' ')`);
    await sleep(300);
    const typedSpace = await evaluate(`${C}.chatInput`);
    await evaluate('window.LostCityHost.keyboard.deleteBackward()');
    await sleep(300);
    await evaluate(`(() => { const c = ${C}; c.chatModalId = 4882; c.resumedPauseButton = false; c.redrawChat = true; })()`);
    await sleep(500);
    check('a dialogue: the chatbox opens and the panel steps aside', (await visible('#hud-chat-box')) && !(await visible('#hud-panel')));
    overlap = await hudOverlaps();
    check('...with the camera pad above the chatbox; nothing overlaps', (await visible('#hud-camera')) && clean(overlap), JSON.stringify(overlap));
    await evaluate(`window.LostCityHost.keyboard.insertText(' ')`);
    const spaced = await waitFor(`${C}.resumedPauseButton === true`, 2000, 50);
    check('a hardware Space continues "Click here to continue" (and types a space when there is nothing to continue)', typedSpace === ' ' && spaced.ok && (await evaluate(`${C}.chatInput`)) === '', JSON.stringify({ typedSpace, continued: spaced.ok }));
    await evaluate(`(() => { const c = ${C}; c.chatModalId = -1; c.redrawChat = true; })()`);
    await sleep(500);
    check('...and both go back afterwards', !(await visible('#hud-chat-box')) && (await visible('#hud-panel')));

    // ---- safe area: the HUD follows a change (rotation moves the notch; WKWebView reports insets late)
    await evaluate(`window.__lcSafeAreaOverride = { top: 0, right: 0, bottom: 0, left: 0 }`);
    const moved = await waitFor(`${C}.freeLeft === 0`, 3000);
    check('a safe-area change moves the HUD', moved.ok && Math.abs((await rectOf('#hud-chat-bar')).x - 4 * ZOOM) < 0.01);
    await evaluate(`window.__lcSafeAreaOverride = ${JSON.stringify(REPORTED_SAFE)}`);
    await waitFor(`${C}.freeLeft === ${toRender(SAFE.left)}`, 3000);

    // ---- Escape on a hardware keyboard closes what is on top: Settings › Help's card over the open panel, then the panel
    await tapElement('#btn-settings');
    await sleep(400);
    await tapElement('#settings-howto');
    await sleep(300);
    const card = (await visible('#howto')) && !(await visible('#settings'));
    await pressKey('Escape');
    await sleep(200);
    const underCard = { card: await visible('#howto'), panel: await visible('#hud-panel') };
    await pressKey('Escape');
    await sleep(300);
    check('Escape closes Settings › Help\'s card first (the panel under it stays), then the panel', card && !underCard.card && underCard.panel && !(await visible('#hud-panel')), JSON.stringify(underCard));

    // ---- settings: the classic layout and back
    const freeBefore = await free();
    await tapElement('#btn-settings');
    await sleep(400);
    // (each category's rows on screen without scrolling, the categories too, all in the safe area; Saved data's list may scroll)
    const section = name => evaluate(`(() => { const p = document.querySelector('#settings .settings-panel').getBoundingClientRect(); const s = document.getElementById('settings-pane'); const n = document.querySelector('#settings .settings-nav');
        return { shown: !document.getElementById('section-' + ${JSON.stringify(name)}).hidden, others: [...document.querySelectorAll('.settings-section')].filter(x => !x.hidden).length, on: [...n.querySelectorAll('button.on')].map(b => b.dataset.section),
            fits: s.scrollHeight <= s.clientHeight + 1 && s.scrollWidth <= s.clientWidth + 1, navFits: n.scrollHeight <= n.clientHeight + 1, panel: [p.left, p.top, p.right, p.bottom].map(Math.round) }; })()`);
    const inSafeArea = panel => panel[0] >= SAFE.left && panel[2] <= VIEW.width - SAFE.right && panel[1] >= 0 && panel[3] <= VIEW.height;
    const sheet = await section('display');
    check('Settings opens from the tab column (also after a finger rested on it through the login) on Display, its rows and the categories on screen without scrolling', (await visible('#settings')) && sheet.shown && sheet.others === 1 && same(sheet.on, ['display']) && sheet.fits && sheet.navFits && inSafeArea(sheet.panel), JSON.stringify(sheet));
    await screenshot('settings');

    // ---- Settings › Display › Screen margins: a page of its own over the game (Settings put aside), Side, Top and Bottom:
    // None / Auto / +16 / +32, applied at once
    await tapElement('#margins-open');
    await sleep(200);
    const marginsPage = await evaluate(`(() => { const p = document.querySelector('#margins .settings-panel').getBoundingClientRect();
        return { open: !document.getElementById('margins').hidden, aside: getComputedStyle(document.getElementById('settings')).visibility === 'hidden', panel: [p.left, p.top, p.right, p.bottom].map(Math.round) }; })()`);
    await screenshot('margins');
    check('Settings › Display › Screen margins (Adjust) opens its page over the game, Settings put aside, in the safe area', marginsPage.open && marginsPage.aside && inSafeArea(marginsPage.panel), JSON.stringify(marginsPage));
    const marginRows = await evaluate(`['safeSides', 'safeTop', 'safeBottom'].map(k => { const g = document.querySelector('.seg[data-setting="' + k + '"]');
        return g ? { choices: [...g.querySelectorAll('button')].map(b => b.textContent), on: [...g.querySelectorAll('button.on')].map(b => b.textContent) } : null; })`);
    check('...Side, Top and Bottom: None / Auto / +16 / +32, Auto on', marginRows.every(r => r && same(r.choices, ['None', 'Auto', '+16', '+32']) && same(r.on, ['Auto'])), JSON.stringify(marginRows));
    // the gaps from the screen's edges (CSS px): the tab column's on the right and at the bottom, the chat bar's on the left,
    // the minimap's and the orbs' at the top, and the sheet's top and bottom
    const gaps = () => evaluate(`(() => { const t = document.getElementById('hud-tabs').getBoundingClientRect(), c = document.getElementById('hud-chat-bar').getBoundingClientRect(),
        m = document.getElementById('hud-map').getBoundingClientRect(), o = document.getElementById('hud-orbs').getBoundingClientRect(), p = document.querySelector('#settings .settings-panel').getBoundingClientRect();
        return { right: innerWidth - t.right, left: c.left, bottom: innerHeight - t.bottom, chatBottom: innerHeight - c.bottom, mapTop: m.top, orbsTop: o.top, sheetTop: p.top, sheetBottom: innerHeight - p.bottom }; })()`);
    const pickMargin = async (key, label) => {
        await tapElement(`.seg[data-setting="${key}"] button:nth-child(${['None', 'Auto', '+16', '+32'].indexOf(label) + 1})`);
        await sleep(150);
        return gaps();
    };
    const auto = await gaps();
    const sidesNone = await pickMargin('safeSides', 'None');
    const sidesMore = await pickMargin('safeSides', '+32');
    const bottomMore = await pickMargin('safeBottom', '+16');
    const bottomNone = await pickMargin('safeBottom', 'None');
    await pickMargin('safeBottom', 'Auto');
    const topMore = await pickMargin('safeTop', '+16');
    const topNone = await pickMargin('safeTop', 'None');
    await pickMargin('safeSides', 'Auto');
    const marginsBack = await pickMargin('safeTop', 'Auto');
    const nearPx = (a, b) => Math.abs(a - b) < 1.5;
    const margins = { auto, sidesNone, sidesMore, bottomMore, bottomNone, topMore, topNone, back: marginsBack };
    check(`...Side margin: None takes the HUD to the glass edge (${SAFE.right} closer), +32 moves it 32 further in, on both sides`,
        nearPx(auto.right - sidesNone.right, SAFE.right) && nearPx(auto.left - sidesNone.left, SAFE.left) && nearPx(sidesMore.right - auto.right, 32) && nearPx(sidesMore.left - auto.left, 32), JSON.stringify(margins));
    check(`...Bottom margin: Auto keeps the HUD at the bottom edge (${ANDROID ? 'no curved edge here' : 'over the home indicator'}, as None), +16 lifts the tab column, the chat bar and the sheet by 16`,
        nearPx(auto.bottom, bottomNone.bottom) && nearPx(auto.chatBottom, bottomNone.chatBottom) && nearPx(bottomMore.bottom - auto.bottom, 16) && nearPx(bottomMore.chatBottom - auto.chatBottom, 16) && bottomMore.sheetBottom >= 16 * ZOOM - 1, JSON.stringify(margins));
    check(`...Top margin: Auto is the phone's top (${SAFE.top}, as None here), +16 lowers the minimap, the orbs and the sheet by 16; the bottom stays`,
        nearPx(auto.mapTop, topNone.mapTop + SAFE.top) && nearPx(topMore.mapTop - auto.mapTop, 16) && nearPx(topMore.orbsTop - auto.orbsTop, 16) && topMore.sheetTop >= 16 * ZOOM - 1 && nearPx(topMore.bottom, auto.bottom) && nearPx(topMore.chatBottom, auto.chatBottom), JSON.stringify(margins));
    check('...Auto, Auto and Auto again: everything back where it was', nearPx(marginsBack.right, auto.right) && nearPx(marginsBack.left, auto.left) && nearPx(marginsBack.bottom, auto.bottom) && nearPx(marginsBack.chatBottom, auto.chatBottom) && nearPx(marginsBack.mapTop, auto.mapTop), JSON.stringify(marginsBack));
    await tapElement('#margins-close');
    await sleep(200);
    const marginsBackTo = { page: await visible('#margins'), settings: await visible('#settings'), aside: await evaluate(`document.getElementById('settings').classList.contains('aside')`), on: await evaluate(`[...document.querySelectorAll('.settings-nav button.on')].map(b => b.dataset.section)`) };
    check('...Back returns to Settings on Display', !marginsBackTo.page && marginsBackTo.settings && !marginsBackTo.aside && same(marginsBackTo.on, ['display']), JSON.stringify(marginsBackTo));

    const sections = {};
    for (const name of ['sound', 'controls', 'world']) {
        await tapElement(`#nav-${name}`);
        await sleep(100);
        sections[name] = await section(name);
    }
    const hold = await evaluate(`[...document.querySelectorAll('.seg[data-setting="longPressMs"] button.on')].map(b => b.textContent)`);
    check('...Sound, Controls and World each shown alone, on screen without scrolling', Object.values(sections).every(s => s.shown && s.others === 1 && s.fits), JSON.stringify(sections));
    check('...and Hold for menu shows the stored 450 ms as Normal (400 ms)', same(hold, ['Normal']), JSON.stringify(hold));
    const restartRow = await evaluate(`(() => { const r = document.getElementById('settings-restart'); return { inWorld: !!r.closest('#section-world'), shown: r.offsetHeight > 0, save: document.getElementById('settings-save').offsetHeight > 0 }; })()`);
    check('...Restart in World; Save now in the header while in the world', restartRow.inWorld && restartRow.shown && restartRow.save, JSON.stringify(restartRow));
    await screenshot('settings-world');

    // ---- Settings › Bot chat (the bots' chat model, docs/ARCHITECTURE.md §7.1): a category, on screen without scrolling;
    // with no native app (Chrome) it says it is only in the iPhone app
    await tapElement('#nav-botchat');
    await sleep(300);
    const botchat = await evaluate(`(() => { const p = document.querySelector('#settings .settings-panel').getBoundingClientRect(); const s = document.getElementById('settings-pane');
        return { open: !document.getElementById('section-botchat').hidden, settings: !document.getElementById('settings').hidden, panel: [p.left, p.top, p.right, p.bottom].map(Math.round),
            fits: s.scrollHeight <= s.clientHeight + 1, local: document.getElementById('botchat-local').textContent, key: document.getElementById('botchat-key').textContent,
            choices: [...document.querySelectorAll('#section-botchat .seg[data-setting="botChat"] button')].map(b => b.textContent) }; })()`);
    await screenshot('botchat');
    check('Settings › Bot chat: a category, all of it on screen; Rules / On-device / Claude online; no native here', botchat.open && botchat.settings && botchat.panel[0] >= SAFE.left && botchat.panel[2] <= VIEW.width - SAFE.right && botchat.panel[1] >= 0 && botchat.panel[3] <= VIEW.height && botchat.fits && same(botchat.choices, ['Rules', 'On-device', 'Claude online']) && botchat.local === BOT_CHAT_LINES.local && botchat.key === BOT_CHAT_LINES.key, JSON.stringify(botchat));
    // Think first (the model's note before each reply): only when native's status says the model offers it ('option'),
    // so not here (no native: 'never'); with a model trained both ways it shows, Off / On, and the page still fits
    const thinkRow = () => evaluate(`(() => { const row = document.getElementById('botchat-think'); const p = document.querySelector('#settings .settings-panel').getBoundingClientRect(); const s = document.getElementById('settings-pane');
        return { shown: !!row && !row.hidden && row.offsetHeight > 0, choices: row ? [...row.querySelectorAll('.seg button')].map(b => b.textContent) : [], on: row ? [...row.querySelectorAll('.seg button.on')].map(b => b.textContent) : [],
            hint: row?.querySelector('.data-detail')?.textContent ?? '', panel: [p.left, p.top, p.right, p.bottom].map(Math.round), fits: s.scrollHeight <= s.clientHeight + 1, setting: window.LostCityHost.settings.botThink,
            unused: !!row?.classList.contains('unused'), grey: row ? getComputedStyle(row.querySelector('.data-name')).color : '', disabled: row ? [...row.querySelectorAll('.seg button')].map(b => b.disabled) : [] }; })()`);
    const chatModel = async value => {
        await tapElement(`#section-botchat .seg[data-setting="botChat"] button[data-value="${value}"]`);
        await sleep(150);
    };
    const lmStatus = think => evaluate(`window.LostCityHost.bots.lmStatus({ local: { available: true, loaded: false, name: '2004 chat (Qwen3.5 0.8B + LoRA)', bytes: 529297472, think: ${JSON.stringify(think)} }, online: { keySet: true, hint: '…a1b2', valid: true } })`);
    const noThink = await thinkRow();
    check('...Think first hidden: the status says the model never writes its note (no native here)', !noThink.shown && typeof noThink.setting === 'boolean', JSON.stringify(noThink));
    await lmStatus('option');
    await sleep(150);
    const thinkRules = await thinkRow();
    await screenshot('botchat-think-unused');
    check('...a model trained both ways (status think \'option\'), the chat model Rules: Think first shows greyed out ("Only with the On-device chat model.", Off / On disabled, its choice shown)', thinkRules.shown && thinkRules.unused && thinkRules.grey === 'rgb(140, 140, 140)' && same(thinkRules.disabled, [true, true]) && thinkRules.hint === 'Only with the On-device chat model.' && same(thinkRules.on, [thinkRules.setting ? 'On' : 'Off']), JSON.stringify(thinkRules));
    await chatModel('local');
    const think = await thinkRow();
    await screenshot('botchat-think');
    // (on screen without scrolling at an iPhone's 375 HUD px and up; Android's 2.625 phones have 360 (the pixel snap):
    // there the page with Think first may scroll a few px, as on iOS with Display Zoom)
    check('...On-device: Think first in use, Off / On (at its default), with its hint; the page still in the safe area, on screen without scrolling', think.shown && !think.unused && think.grey !== thinkRules.grey && same(think.disabled, [false, false]) && same(think.choices, ['Off', 'On']) && same(think.on, [think.setting ? 'On' : 'Off']) && think.hint.startsWith('The bots plan each reply first') && think.panel[0] >= SAFE.left && think.panel[2] <= VIEW.width - SAFE.right && think.panel[1] >= 0 && think.panel[3] <= VIEW.height && (think.fits || VIEW.height / ZOOM < 375), JSON.stringify(think));
    await tapElement('#botchat-think .seg button[data-value="true"]');
    await sleep(150);
    const thinkOn = await thinkRow();
    await tapElement('#botchat-think .seg button[data-value="false"]');
    await sleep(150);
    const thinkOff = await thinkRow();
    check('...On and Off apply at once (the setting botThink)', same(thinkOn.on, ['On']) && thinkOn.setting === true && same(thinkOff.on, ['Off']) && thinkOff.setting === false, JSON.stringify({ on: thinkOn, off: thinkOff }));
    await tapElement('#botchat-think .seg button[data-value="true"]');
    await chatModel('online');
    const thinkOnline = await thinkRow();
    await tapElement('#botchat-think .seg button[data-value="false"]'); // (disabled: no change)
    await sleep(150);
    const thinkOnlineTapped = await thinkRow();
    check('...Claude online: greyed out again, On kept and shown, a tap on Off does nothing', thinkOnline.unused && same(thinkOnline.disabled, [true, true]) && same(thinkOnline.on, ['On']) && thinkOnline.hint === 'Only with the On-device chat model.' && thinkOnlineTapped.setting === true && same(thinkOnlineTapped.on, ['On']), JSON.stringify({ online: thinkOnline, tapped: thinkOnlineTapped }));
    await chatModel('local');
    await tapElement('#botchat-think .seg button[data-value="false"]');
    await chatModel('rules'); // (as before: no native here)
    await sleep(150);
    await lmStatus('always');
    await sleep(100);
    const always = await thinkRow();
    await lmStatus('never');
    await sleep(100);
    const never = await thinkRow();
    check('...and hidden again for a model that always or never writes one (no choice to make)', !always.shown && !never.shown, JSON.stringify({ always: always.shown, never: never.shown }));
    await evaluate('window.LostCityHost.bots.lmStatus({})'); // (no native again, as before)

    // ---- Settings › Tap options (Client.setAttackOptions, patch 0025): what a tap does with Attack on NPCs and players.
    // A category on screen without scrolling; a choice reaches the client at once. The
    // client's own menu code runs on a stand-in NPC (Talk-to, Attack, Pickpocket) and a stand-in player in the
    // Wilderness (Attack, Follow and Trade with, both of those below Walk here as the server sends them), one weaker
    // and one stronger than the character: a tap does the first entry; "low" = one sorted below the others
    await tapElement('#nav-tapoptions');
    await sleep(300);
    const tapPage = await evaluate(`(() => { const p = document.querySelector('#settings .settings-panel').getBoundingClientRect(); const s = document.getElementById('settings-pane');
        return { open: !document.getElementById('section-tapoptions').hidden, settings: !document.getElementById('settings').hidden, panel: [p.left, p.top, p.right, p.bottom].map(Math.round), fits: s.scrollHeight <= s.clientHeight + 1,
            npc: [...document.querySelectorAll('#section-tapoptions .seg[data-setting="npcAttack"] button')].map(b => b.textContent), player: [...document.querySelectorAll('#section-tapoptions .seg[data-setting="playerAttack"] button')].map(b => b.textContent),
            on: [...document.querySelectorAll('#section-tapoptions .seg button.on')].map(b => b.dataset.value) }; })()`);
    await screenshot('tapoptions');
    check('Settings › Tap options: a category, all of it on screen; NPCs and Players: Tap / By level / Hold / Hidden, By level on', tapPage.open && tapPage.settings && tapPage.panel[0] >= SAFE.left && tapPage.panel[2] <= VIEW.width - SAFE.right && tapPage.panel[1] >= 0 && tapPage.panel[3] <= VIEW.height && tapPage.fits && same(tapPage.npc, ['Tap', 'By level', 'Hold', 'Hidden']) && same(tapPage.player, tapPage.npc) && same(tapPage.on, ['level', 'level']), JSON.stringify(tapPage));
    const attackEntries = () => evaluate(`(() => { const c = ${C}, me = c.localPlayer.combatLevel, out = {};
        // (a menu that starts with Walk here, as the world's does, top entry first after the client's sort: entries above
        // 1000 sink below the rest; Examine left out)
        const walk = () => { c.menuOption[0] = 'Walk here'; c.menuAction[0] = 718; c.menuNumEntries = 1; };
        const entries = () => { const r = []; for (let i = 0; i < c.menuNumEntries; i++) r.push({ text: c.menuOption[i].replace(/ @.*$/, '') + (c.menuAction[i] >= 2000 ? ' low' : ''), action: c.menuAction[i] });
            const shown = [...r.filter(e => e.action > 1000), ...r.filter(e => e.action <= 1000)].reverse(); walk();
            return shown.map(e => e.text).filter(t => t !== 'Examine').join(', '); };
        const ops = c.playerOp.slice(), pri = c.playerOpPriority.slice();
        c.playerOp[0] = null; c.playerOp[1] = 'Attack'; c.playerOp[2] = 'Follow'; c.playerOp[3] = 'Trade with'; c.playerOp[4] = null;
        c.playerOpPriority[0] = false; c.playerOpPriority[1] = false; c.playerOpPriority[2] = true; c.playerOpPriority[3] = true; c.playerOpPriority[4] = false;
        walk();
        for (const [name, level] of [['weak', Math.max(1, me - 1)], ['strong', me + 50]]) {
            c.addNpcOptions({ name: 'Man', vislevel: level, op: ['Talk-to', 'Attack', null, 'Pickpocket', null] }, 0, 0, 0);
            out['npc ' + name] = entries();
            c.addPlayerOptions({ name: 'Zezima', combatLevel: level, skillLevel: 0 }, 0, 0, 0);
            out['player ' + name] = entries();
        }
        for (let i = 0; i < 5; i++) { c.playerOp[i] = ops[i]; c.playerOpPriority[i] = pri[i]; }
        c.menuNumEntries = 0;
        return out; })()`);
    const tapChoice = async (key, value) => {
        await tapElement(`#section-tapoptions .seg[data-setting="${key}"] button[data-value="${value}"]`);
        await sleep(150);
    };
    const byLevel = await attackEntries();
    check('...By level (2004): Attack on top for a weaker NPC or player, below the rest for a stronger one', byLevel['npc weak'] === 'Attack, Talk-to, Pickpocket, Walk here' && byLevel['npc strong'] === 'Talk-to, Pickpocket, Walk here, Attack low'
        && byLevel['player weak'] === 'Attack, Walk here, Follow low, Trade with low' && byLevel['player strong'] === 'Walk here, Attack low, Follow low, Trade with low', JSON.stringify(byLevel));
    await tapChoice('npcAttack', 'tap');
    await tapChoice('playerAttack', 'tap');
    const onTop = await attackEntries();
    check('...Tap: Attack on top whatever their level', onTop['npc strong'] === 'Attack, Talk-to, Pickpocket, Walk here' && onTop['player strong'] === 'Attack, Walk here, Follow low, Trade with low' && onTop['npc weak'] === byLevel['npc weak'] && onTop['player weak'] === byLevel['player weak'], JSON.stringify(onTop));
    await tapChoice('npcAttack', 'hold');
    await tapChoice('playerAttack', 'hidden');
    const heldHidden = await attackEntries();
    const tapStored = await evaluate(`({ npc: window.LostCityHost.settings.npcAttack, player: window.LostCityHost.settings.playerAttack })`);
    check('...Hold: Attack below the rest even on a weaker NPC; Hidden: no Attack on a player; both kept in the settings', heldHidden['npc weak'] === 'Talk-to, Pickpocket, Walk here, Attack low' && heldHidden['npc strong'] === heldHidden['npc weak']
        && heldHidden['player weak'] === 'Walk here, Follow low, Trade with low' && heldHidden['player strong'] === heldHidden['player weak'] && tapStored.npc === 'hold' && tapStored.player === 'hidden', JSON.stringify({ heldHidden, tapStored }));
    await tapChoice('npcAttack', 'level');
    await tapChoice('playerAttack', 'level');
    const byLevelAgain = await attackEntries();
    check('...By level again restores the 2004 order', JSON.stringify(byLevelAgain) === JSON.stringify(byLevel), JSON.stringify(byLevelAgain));
    // the category stays chosen after Settings closes (Escape), and opens again where it was left
    await pressKey('Escape');
    await sleep(200);
    const settingsClosed = !(await visible('#settings'));
    await tapElement('#btn-settings');
    await sleep(400);
    const settingsAgain = await section('tapoptions');
    check('...Escape closes Settings; it opens again on Tap options', settingsClosed && settingsAgain.shown && same(settingsAgain.on, ['tapoptions']), JSON.stringify({ settingsClosed, settingsAgain }));

    // ---- Settings › About (host.js about): the version line, the disclaimer, the credits; Licences shows licenses.txt
    // (LICENSE + THIRD_PARTY_NOTICES.md, scripts/lib/notices.mjs) in a sheet over Settings that scrolls; Escape and Close
    // close it, leaving Settings on About
    await tapElement('#nav-about');
    await sleep(300);
    const version = fs.readFileSync(path.join(IOS, 'VERSION'), 'utf8').trim();
    const aboutPage = await evaluate(`(() => { const p = document.querySelector('#settings .settings-panel').getBoundingClientRect(); const s = document.getElementById('settings-pane');
        return { shown: !document.getElementById('section-about').hidden, others: [...document.querySelectorAll('.settings-section')].filter(x => !x.hidden).length, panel: [p.left, p.top, p.right, p.bottom].map(Math.round),
            fits: s.scrollWidth <= s.clientWidth + 1, version: document.getElementById('about-version').textContent, built: document.getElementById('about').textContent,
            disclaimer: document.getElementById('about-disclaimer').textContent, credits: document.getElementById('about-credits').textContent }; })()`);
    await screenshot('about');
    const DISCLAIMER = '2004Scape is an unofficial fan project. It is not affiliated with, endorsed by or connected to Jagex Ltd or the Lost City project. RuneScape is a registered trademark of Jagex Ltd. The game data the app is built from is the intellectual property of Jagex Ltd. This project is free: no ads, no payments, no accounts.';
    check(`Settings › About: "2004Scape ${version} · Lost City 274", the commits, the disclaimer and the credits (Lost City, 2004SP Progressive, llama.cpp, Qwen, Claude), in the safe area`,
        aboutPage.shown && aboutPage.others === 1 && inSafeArea(aboutPage.panel) && aboutPage.fits && aboutPage.version === `2004Scape ${version} · Lost City 274` && /^Offline\. Built from Engine-TS [0-9a-f]+, Content [0-9a-f]+, Client-TS [0-9a-f]+\.$/.test(aboutPage.built)
        && aboutPage.disclaimer === DISCLAIMER && ['Lost City', '2004SP Progressive', 'llama.cpp', 'Qwen', 'Claude'].every(name => aboutPage.credits.includes(name)), JSON.stringify(aboutPage));
    await tapElement('#about-licences');
    await waitFor(`document.getElementById('licences-text').textContent.length > 1000`, 5000);
    const licencesState = () => evaluate(`(() => { const p = document.querySelector('#licences .settings-panel').getBoundingClientRect(); const t = document.getElementById('licences-text');
        return { open: !document.getElementById('licences').hidden, settings: !document.getElementById('settings').hidden, panel: [p.left, p.top, p.right, p.bottom].map(Math.round),
            scrolls: t.scrollHeight > t.clientHeight * 4, wide: t.scrollWidth > t.clientWidth + 1, top: Math.round(t.scrollTop), head: t.textContent.slice(0, 31),
            notices: ['Copyright (c) 2026 PureXYZ', 'Copyright (c) 2023-2026 Lost City', 'attackishere', 'The ggml authors', 'Alibaba Cloud', 'Apache License', 'ISC License', 'Blue Oak Model License', 'Julian R Seward', 'Jagex Ltd'].filter(s => !t.textContent.includes(s)) }; })()`);
    const licences = await licencesState();
    await screenshot('licences');
    const textBox = await rectOf('#licences-text');
    await drag(textBox.cx, textBox.y + textBox.h * 0.8, textBox.cx, textBox.y + textBox.h * 0.2, 12, 25);
    await sleep(400);
    const scrolled = await licencesState();
    check('...Licences: licenses.txt over Settings, in the safe area, every notice in it; a drag scrolls it', licences.open && licences.settings && inSafeArea(licences.panel) && licences.scrolls && !licences.wide && licences.head === '2004Scape: licences and notices' && licences.notices.length === 0 && scrolled.top > 0,
        JSON.stringify({ licences, scrolledTop: scrolled.top }));
    await pressKey('Escape');
    await sleep(200);
    const afterEscape = { licences: await visible('#licences'), settings: await visible('#settings'), about: await visible('#section-about') };
    await tapElement('#about-licences');
    await sleep(300);
    const licencesAgain = await licencesState();
    await tapElement('#licences-close');
    await sleep(200);
    const afterClose = { licences: await visible('#licences'), settings: await visible('#settings') };
    check('...Escape closes the licences first (Settings stays on About); opened again it starts at the top; Close closes it', !afterEscape.licences && afterEscape.settings && afterEscape.about && licencesAgain.open && licencesAgain.top === 0 && !afterClose.licences && afterClose.settings,
        JSON.stringify({ afterEscape, licencesAgainTop: licencesAgain.top, afterClose }));
    await tapElement('#nav-controls');
    await tapElement('.seg[data-setting="largeMenus"] button[data-value="true"]');
    await sleep(150);
    await tapElement('#nav-display');
    await tapElement('.seg[data-setting="cameraButtons"] button[data-value="false"]');
    await sleep(150);
    await tapElement('.seg[data-setting="layout"] button[data-value="classic"]');
    await sleep(600);
    await tapElement('#settings-close');
    await sleep(500);
    const classic = await evaluate(`({ hud: document.getElementById('hud').hidden, behind: document.getElementById('canvas').classList.contains('behind'), viewport: [${C}.viewportX, ${C}.viewportWidth] })`);
    await screenshot('classic');
    check('the classic layout: the 2004 screen with side rails', classic.hud && !classic.behind && same(classic.viewport, [4, 512]), JSON.stringify(classic));
    // its rail keeps the options-menu button (the HUD's chat bar has tap-to-drop in its place), and tap-to-drop is off
    await tapElement('#btn-secondary');
    await sleep(200);
    const canvasBox = await rectOf('#canvas');
    await tap(canvasBox.x + (260 * canvasBox.w) / 765, canvasBox.y + (160 * canvasBox.h) / 503);
    await sleep(500);
    const classicMenu = await evaluate(`({ open: ${C}.isMenuOpen, shown: !document.getElementById('menu-layer').hidden, tapToDrop: ${C}.hudState().tapToDrop })`);
    check('...whose menu button makes the next tap open the options menu; tap-to-drop is off there', classicMenu.open && classicMenu.shown && classicMenu.tapToDrop === false, JSON.stringify(classicMenu));
    await screenshot('menu-button');
    await tapElement('#menu .menu-option:last-child');
    await sleep(400);
    await tapElement('#btn-settings');
    await sleep(400);
    await tapElement('.seg[data-setting="layout"] button[data-value="mobile"]');
    await sleep(600);
    await tapElement('#settings-close');
    await sleep(800);
    const back = await evaluate(`({ hud: !document.getElementById('hud').hidden, viewport: [${C}.viewportX, ${C}.viewportWidth], free: [${C}.freeLeft, ${C}.freeTop, ${C}.freeRight, ${C}.freeBottom] })`);
    check('...and back to the mobile layout, with the HUD insets as before', back.hud && same(back.viewport, [1024, WORLD[0]]) && same(back.free, freeBefore), JSON.stringify({ ...back, freeBefore }));
    await screenshot('mobile-again');

    // ---- every screen the HUD is laid out for, with the panel and the chatbox open, then typing above the keyboard. The
    // HUD is zoomed ×1.5 or ×2 only where the height allows it and the HUD still gets at least the SE's 667 px (contract
    // A); nothing overlaps or runs off the screen; no chat filter label is cut off (short labels, or none, where the long
    // ones do not fit); the world renders at most ~410,000 px.
    const NO_SAFE = { top: 0, right: 0, bottom: 0, left: 0 };
    const iosScreens = [
        { name: 'iPhone 13 mini', view: VIEW, safe: REPORTED_SAFE, zoom: 1, labels: 'long' },
        { name: 'iPhone 13 mini with Display Zoom', view: { width: 693, height: 320 }, safe: { top: 0, right: 44, bottom: 21, left: 44 }, zoom: 1 },
        { name: 'iPhone SE', view: { width: 667, height: 375 }, safe: NO_SAFE, zoom: 1 },
        { name: 'iPhone SE with Display Zoom', view: { width: 568, height: 320 }, safe: NO_SAFE, zoom: 1 },
        { name: 'iPhone Pro Max', view: { width: 932, height: 430 }, safe: { top: 0, right: 59, bottom: 21, left: 59 }, zoom: 1 },
        { name: 'iPad mini', view: { width: 1133, height: 744 }, safe: { top: 0, right: 0, bottom: 20, left: 0 }, zoom: 1.5 },
        { name: 'iPad Air 11"', view: { width: 1180, height: 820 }, safe: { top: 24, right: 0, bottom: 20, left: 0 }, zoom: 1.5 },
        { name: 'iPad Pro 13"', view: { width: 1376, height: 1032 }, safe: { top: 0, right: 0, bottom: 20, left: 0 }, zoom: 2 }
    ];
    // Android (--platform android): its screens at their own pixel ratio, each with the zoom and the world the page should
    // make of it (the crisp pixel snap at 2.625, the iPhone rules at a whole-number ratio), the main one first
    const screens = ANDROID
        ? [{ name: 'Pixel-class phone, camera hole left', view: VIEW, safe: REPORTED_SAFE, dpr: DPR, zoom: ZOOM, world: WORLD, labels: 'long' }, ...Object.values(ANDROID_SCREENS)]
        : iosScreens;
    await tapElement('#hud-tabs .tab[data-tab="3"]');
    await sleep(300);
    await tapElement('#btn-chat-toggle');
    await sleep(300);
    for (const screen of screens) {
        await setScreen(screen.view, screen.safe, screen.dpr);
        const shown = await evaluate(`(() => { const g = document.getElementById('surface-game'), modes = document.getElementById('hud-chat-modes');
            return { zoom: Number(document.documentElement.style.getPropertyValue('--ui-zoom')), world: [g.width, g.height], panel: !document.getElementById('hud-panel').hidden, chat: !document.getElementById('hud-chat-box').hidden,
                labels: modes.hidden ? 'none' : modes.classList.contains('short') ? 'short' : 'long',
                cut: modes.hidden ? [] : [...modes.querySelectorAll('.chat-mode')].filter(b => [...b.children].some(part => part.offsetWidth > b.clientWidth)).map(b => b.textContent) }; })()`);
        const open = await hudOverlaps();
        // the keyboard and its bar (Android: Gboard's landscape height and the app's bar, with the IME's curve)
        const covered = screen.view.height >= 700 ? 400 : ANDROID ? 270 : 239;
        await evaluate(`(() => { window.LostCityHost.keyboard.show(); window.LostCityHost.keyboard.frame(${covered}, 0${ANDROID ? ", 'cubic-bezier(0.2, 0, 0, 1)'" : ''}); })()`);
        await sleep(80);
        const lifted = await evaluate(`(() => { const r = document.getElementById('hud-chat-box').getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom)]; })()`);
        const typing = await hudOverlaps();
        await evaluate(`(() => { window.LostCityHost.keyboard.frame(0, 0); window.LostCityHost.keyboard.hide(); })()`);
        const fits = Math.abs(shown.zoom - screen.zoom) < 1e-9 && shown.panel && shown.chat && clean(open) && shown.cut.length === 0 && (!screen.labels || shown.labels === screen.labels) && shown.world[0] * shown.world[1] <= 412000 && (!screen.world || same(shown.world, screen.world));
        const above = lifted[1] <= screen.view.height - covered + 1 && lifted[0] >= screen.safe.top - 1 && clean(typing);
        const at = screen.dpr ? ` at ${screen.dpr}` : '';
        check(`${screen.name} (${screen.view.width}x${screen.view.height}${at}): the HUD ×${+screen.zoom.toFixed(6)}${screen.world ? `, the world ${screen.world.join('x')}` : ''}, panel and chatbox open, then typing: nothing overlaps, no label cut off`, fits && above, JSON.stringify({ ...shown, open, lifted, typing }));
    }
    // a narrow desktop window (no phone or iPad): the world renders larger so a window fits beside the panel, but within a
    // bound (it asked for 4608x8192 here)
    await setScreen({ width: 450, height: 800 }, NO_SAFE);
    const narrow = await evaluate(`(() => { const g = document.getElementById('surface-game'); return [g.width, g.height]; })()`);
    check('a narrow desktop window (450x800): the world renders at 768x1365, not without bound', same(narrow, [768, 1365]), JSON.stringify(narrow));
    await setScreen(VIEW, REPORTED_SAFE, DPR);
    await waitFor(`${C}.freeLeft === ${toRender(SAFE.left)}`, 3000);
    await tapElement('#btn-chat-toggle');
    await sleep(200);
    await tapElement('#hud-tabs .tab[data-tab="3"]');
    await sleep(300);

    const walk2 = await walkNear([[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1], [2, 1], [-2, -1], [1, -2], [-1, 2], [3, 0], [0, 3], [-3, 0], [0, -3]]);
    check('walking still works after switching layouts and screens', walk2.ok, `${JSON.stringify(walk2.from)} → ${JSON.stringify(walk2.now)} (target ${JSON.stringify(walk2.to)})`);

    const fps = await evaluate(`${C}.fps`);
    check('frame rate', fps >= 25, `${fps} fps (headless Chrome)`);
    check('still in game at the end (no silent logout)', await evaluate(`${C}.ingame === true && !!${C}.stream`));

    const errors = consoleLines.filter(line => /^\[(error|exception)\]/.test(line));
    check('no console errors or exceptions', errors.length === 0, errors.slice(0, 5).join(' | '));
    check('no failed requests (fonts, sprites)', failedRequests.length === 0, failedRequests.slice(0, 5).join(' | '));
    exitCode = checks.every(c => c.ok) ? 0 : 1;
} catch (err) {
    console.error(err);
    check('harness completed', false, String(err?.stack ?? err));
    try {
        await screenshot('error');
    } catch {
        // ignore
    }
} finally {
    fs.writeFileSync(path.join(OUT, 'console.log'), consoleLines.join('\n'));
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ user: USER, checks }, null, 2));
    console.log(`\n${checks.filter(c => c.ok).length}/${checks.length} checks passed — screenshots and logs in ${path.relative(process.cwd(), OUT)}`);
    if (!KEEP) {
        chrome.kill();
        await server.close();
        process.exit(exitCode);
    }
}
