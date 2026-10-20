// The crisp pixel snap in the real WebView (docs/ANDROID.md §1 "Pixels"): at the emulator's 2.625 device px per CSS px
// the page zooms the HUD by 8/7 so that each HUD px is exactly 3x3 device px. The desktop tests (hud.mjs, gallery.mjs
// --platform android) check the zoom the page asks for; only the phone's own screen shows what Android System WebView
// makes of it. This test screencaps the HUD in the world and the Settings overlay, and measures whether the 2004 art
// lands on whole device px:
//
//   * sprites drawn 1:1 (the tab icons, sideicons-*.png at 30 px): every opaque pixel of the sprite (read in the page)
//     should be one 3x3 block of device px of its own colour, at the box's whole-device-px origin;
//   * the bitmap fonts (RS Plain/Bold 12 at 16 px: the orbs' numbers, the Settings overlay's labels): every 3x3 block of
//     the screen's grid that holds the text's colour should be all that colour (a glyph pixel between device px is not);
//   * the Settings panel's 2px stone border: 6 device px of its colour, nothing blended;
//   * the side panel's canvas (inside its 3px stone frame) exactly 158x218 HUD px, its edges on whole device px.
//
//   node android/test/crisp.mjs [--serial emulator-5556] [--no-build] [--no-install]
//
// Crops scaled up 4x (evidence a person can look at) and results.json in android/build/crisp/.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ACTIVITY, PKG, device, sleep } from './lib/adb.mjs';
import { screencap, writePng } from './lib/image.mjs';

const ANDROID = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ANDROID, 'build', 'crisp');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
};
const SERIAL = option('--serial', process.env.ANDROID_SERIAL ?? 'emulator-5554');

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

let page = null;
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
const client = expression => page.eval(`(() => { const c = window.__client; return ${expression}; })()`);

// ---------------------------------------------------------------------------------------------------- measures

const near = (image, i, rgb, tolerance) => Math.abs(image.data[i] - rgb[0]) <= tolerance && Math.abs(image.data[i + 1] - rgb[1]) <= tolerance && Math.abs(image.data[i + 2] - rgb[2]) <= tolerance;

/**
 * A sprite drawn 1:1 at `box` (CSS px): each opaque sprite pixel should cover its own k×k device px (k = device px per
 * HUD px) in its own colour. Returns how many did, out of how many, and the box's device-px origin (whole when crisp).
 */
function spriteMatch(image, box, sprite, dpr, k, tolerance = 6) {
    const ox = box.x * dpr;
    const oy = box.y * dpr;
    const x0 = Math.round(ox);
    const y0 = Math.round(oy);
    let opaque = 0;
    let matched = 0;
    for (let j = 0; j < sprite.h; j++) {
        for (let i = 0; i < sprite.w; i++) {
            const s = (j * sprite.w + i) * 4;
            if (sprite.data[s + 3] !== 255) continue;
            opaque++;
            const rgb = [sprite.data[s], sprite.data[s + 1], sprite.data[s + 2]];
            let all = true;
            for (let dy = 0; dy < k && all; dy++) {
                for (let dx = 0; dx < k && all; dx++) {
                    const x = x0 + i * k + dx;
                    const y = y0 + j * k + dy;
                    if (x < 0 || y < 0 || x >= image.width || y >= image.height || !near(image, (y * image.width + x) * 4, rgb, tolerance)) all = false;
                }
            }
            if (all) matched++;
        }
    }
    return { opaque, matched, origin: [+ox.toFixed(3), +oy.toFixed(3)] };
}

/**
 * Text in `rgb` inside `box` (CSS px): the k×k blocks of the screen's grid (the HUD's origin is the screen's) that hold
 * the colour anywhere should hold it everywhere; a glyph pixel straddling device px fills a block only in part.
 */
function textBlocks(image, box, rgb, dpr, k, tolerance = 8) {
    let inked = 0;
    let whole = 0;
    const left = Math.max(0, Math.floor((box.x * dpr) / k) * k);
    const top = Math.max(0, Math.floor((box.y * dpr) / k) * k);
    const right = Math.min(image.width, Math.ceil((box.x + box.w) * dpr));
    const bottom = Math.min(image.height, Math.ceil((box.y + box.h) * dpr));
    for (let y = top; y + k <= bottom; y += k) {
        for (let x = left; x + k <= right; x += k) {
            let count = 0;
            for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) if (near(image, ((y + dy) * image.width + x + dx) * 4, rgb, tolerance)) count++;
            if (count === 0) continue;
            inked++;
            if (count === k * k) whole++;
        }
    }
    return { inked, whole };
}

/** The run lengths of one row (or column) of device px through a 1px border, its colour's run first. */
function borderRun(image, x, y, dx, dy, rgb, steps = 12, tolerance = 8) {
    let run = 0;
    let started = false;
    for (let n = 0; n < steps; n++) {
        const px = x + dx * n;
        const py = y + dy * n;
        const hit = near(image, (py * image.width + px) * 4, rgb, tolerance);
        if (hit) {
            run++;
            started = true;
        } else if (started) {
            break;
        }
    }
    return run;
}

/** A region scaled up `k` times, nearest neighbour. */
function zoomed(image, region, k = 4) {
    const w = Math.max(1, Math.min(region.w, image.width - region.x));
    const h = Math.max(1, Math.min(region.h, image.height - region.y));
    const out = { width: w * k, height: h * k, data: Buffer.alloc(w * k * h * k * 4) };
    for (let y = 0; y < out.height; y++) {
        for (let x = 0; x < out.width; x++) {
            const i = ((region.y + Math.floor(y / k)) * image.width + region.x + Math.floor(x / k)) * 4;
            image.data.copy(out.data, (y * out.width + x) * 4, i, i + 4);
        }
    }
    return out;
}

function evidence(image, name, box, dpr) {
    const file = path.join(OUT, `${String(++shotIndex).padStart(2, '0')}-${name}.png`);
    const x = Math.max(0, Math.floor(box.x * dpr) - 6);
    const y = Math.max(0, Math.floor(box.y * dpr) - 6);
    writePng(file, zoomed(image, { x, y, w: Math.min(300, Math.ceil(box.w * dpr) + 12), h: Math.min(200, Math.ceil(box.h * dpr) + 12) }));
}

/** The page's own reading of a sprite's pixels (the same PNG the HUD draws). */
const spritePixels = url => page.eval(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(url)};
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return { w: c.width, h: c.height, data: Array.from(g.getImageData(0, 0, c.width, c.height).data) };
})()`);

const rgbOf = css => (/rgba?\((\d+), (\d+), (\d+)/.exec(css) ?? []).slice(1, 4).map(Number);

// ---------------------------------------------------------------------------------------------------- run

if (!argv.includes('--no-build')) {
    console.log('building the debug APK…');
    execFileSync(path.join(ANDROID, 'gradlew'), [':app:assembleDebug', '--console=plain', '-q'], { cwd: ANDROID, stdio: 'inherit' });
}
if (!argv.includes('--no-install')) console.log(d.install(path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')));

try {
    d.adbQuiet('shell', 'settings', 'put', 'secure', 'immersive_mode_confirmations', 'confirmed');
    if (SERIAL.startsWith('emulator-')) d.adbQuiet('emu', 'sensor', 'set', 'acceleration', '9.81:0:0');
    d.adbQuiet('shell', 'svc', 'power', 'stayon', 'true');
    d.adb('shell', 'pm', 'clear', PKG);
    d.adb('shell', 'am', 'start', '-W', '-S', '-n', ACTIVITY, '--es', 'lostcity.settings', `'${JSON.stringify({ seenHowToPlay: true, bots: 0, jmod: true })}'`);
    await reconnect();
    const title = await waitFor(() => client('!!c && !!c.titleFlames && c.lastProgressPercent === 100 && window.LostCityHost?.engineState === "ready"'), 120000, 200);
    check('the title screen is up', title.ok, `${title.ms} ms`);
    d.tapNative(/^Got it$/i);
    await sleep(500);

    // a new character on Tutorial Island, the designer accepted
    const user = `crisp${Date.now() % 100000}`;
    await page.tapGame(302, 291);
    await waitFor(() => client('c.loginscreen === 2'), 5000);
    await page.eval(`window.LostCityHost.keyboard.insertText(${JSON.stringify(user)})`);
    await sleep(300);
    await page.eval('window.LostCityHost.keyboard.submit()');
    const inWorld = await waitFor(() => client('c.ingame === true'), 60000);
    check('a new character is in the world', inWorld.ok, user);
    if ((await waitFor(() => client('c.mainModalId !== -1'), 4000)).ok) {
        await page.eval('(() => { const c = window.__client; c.tapAt(c.viewportX + c.modalX + 256, c.viewportY + c.modalY + 282, 1); })()');
        await waitFor(() => client('c.mainModalId === -1'), 6000);
    }
    await sleep(2000);

    const view = await page.eval(`(() => ({ dpr: devicePixelRatio, zoom: Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')), snapped: document.documentElement.classList.contains('ui-snapped'), hudZoom: document.getElementById('hud-ui').style.zoom, hudTransform: document.getElementById('hud-ui').style.transform, vw: innerWidth, vh: innerHeight }))()`);
    results.view = view;
    const k = Math.round(view.zoom * view.dpr);
    check('the page snaps the HUD to a whole number of device px per HUD px (html.ui-snapped, zoom × dpr = 3)', view.snapped && Math.abs(view.zoom * view.dpr - 3) < 1e-9, view);

    // ---- the tab icons: 1:1 sprites centred on their slabs
    const tabs = await page.eval(`[...document.querySelectorAll('#hud-tabs .tab[data-tab]')].filter(t => !t.classList.contains('unavailable') && !t.hidden).map(t => {
        const r = t.getBoundingClientRect();
        const z = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom'));
        const url = /url\\("?([^")]+)"?\\)/.exec(getComputedStyle(t, '::after').backgroundImage)?.[1] ?? null;
        return { tab: t.dataset.tab, url, box: { x: r.left + r.width / 2 - 15 * z, y: r.top + r.height / 2 - 15 * z, w: 30 * z, h: 30 * z } };
    })`);
    let image = screencap(d);
    writePng(path.join(OUT, 'screen-world.png'), image);
    const sprites = new Map();
    let opaque = 0;
    let matched = 0;
    const perTab = [];
    for (const tab of tabs) {
        if (!tab.url) continue;
        if (!sprites.has(tab.url)) sprites.set(tab.url, await spritePixels(tab.url));
        const m = spriteMatch(image, tab.box, sprites.get(tab.url), view.dpr, k);
        opaque += m.opaque;
        matched += m.matched;
        perTab.push({ tab: tab.tab, ...m });
        if (perTab.length <= 2) evidence(image, `tab-${tab.tab}`, tab.box, view.dpr);
    }
    results.measures.tabIcons = perTab;
    console.log(`   tab icons: ${perTab.map(t => `#${t.tab} ${t.matched}/${t.opaque} at ${t.origin.join(',')}`).join('; ')}`);
    check(`tab icons (${perTab.length} shown, 1:1 sprites): every opaque sprite pixel is its own ${k}x${k} device px in its own colour`, perTab.length > 0 && opaque > 0 && matched / opaque >= 0.99, `${matched}/${opaque} (${((100 * matched) / Math.max(1, opaque)).toFixed(1)} %)`);

    // ---- the orbs' numbers: RS Plain 12 at 16 px
    const values = await page.eval(`['hp-value', 'prayer-value'].map(id => document.getElementById(id)).filter(e => e && e.textContent && e.offsetParent).map(e => { const r = e.getBoundingClientRect(); return { id: e.id, text: e.textContent, color: getComputedStyle(e).color, box: { x: r.left, y: r.top, w: r.width, h: r.height } }; })`);
    let inked = 0;
    let whole = 0;
    for (const value of values) {
        const m = textBlocks(image, value.box, rgbOf(value.color), view.dpr, k);
        inked += m.inked;
        whole += m.whole;
        results.measures[value.id] = { ...value, ...m };
        evidence(image, value.id, value.box, view.dpr);
    }
    check(`the orbs' numbers (RS Plain 12: ${values.map(v => JSON.stringify(v.text)).join(', ')}): every ${k}x${k} block with ink is all ink`, values.length > 0 && inked > 0 && whole / inked >= 0.98, `${whole}/${inked}`);

    // ---- the side panel's frame and canvas: the canvas exactly 158x218 HUD px (5/6 of the 2004 panel) on whole device px
    await page.tapElement('#hud-tabs .tab[data-tab="11"]');
    await sleep(800);
    const side = await page.eval(`(() => { const r = document.getElementById('surface-side').getBoundingClientRect(); const p = document.getElementById('hud-panel'); return { shown: !p.hidden, x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const sideEdges = [side.x, side.y, side.x + side.w, side.y + side.h].map(v => +(v * view.dpr).toFixed(3));
    results.measures.sidePanel = { ...side, deviceEdges: sideEdges };
    check(`the side panel's canvas is 158x218 HUD px (${158 * k}x${218 * k} device px) with its edges on whole device px`, side.shown && Math.abs(side.w * view.dpr - 158 * k) < 0.01 && Math.abs(side.h * view.dpr - 218 * k) < 0.01 && sideEdges.every(v => Math.abs(v - Math.round(v)) < 0.01), JSON.stringify({ size: [side.w * view.dpr, side.h * view.dpr].map(v => +v.toFixed(3)), edges: sideEdges }));
    await page.tapElement('#hud-tabs .tab[data-tab="11"]');
    await sleep(500);

    // ---- the Settings overlay (an .overlay, zoomed as the HUD is): its labels and a segmented button's 1px border
    await page.tapElement('#btn-settings');
    await waitFor(() => page.eval(`!document.getElementById('settings').hidden`), 3000);
    await page.tapElement('#nav-display');
    await sleep(800);
    const settings = await page.eval(`(() => {
        const label = document.querySelector('#section-display .row > span');
        const panel = document.querySelector('#settings .settings-panel');
        const title = document.querySelector('#settings .panel-title');
        const box = e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
        const s = getComputedStyle(panel);
        return { label: { text: label.textContent, color: getComputedStyle(label).color, box: box(label) }, title: { text: title.textContent, color: getComputedStyle(title).color, box: box(title) }, panel: { box: box(panel), border: s.borderLeftColor, borderWidth: s.borderLeftWidth } };
    })()`);
    image = screencap(d);
    writePng(path.join(OUT, 'screen-settings.png'), image);
    for (const [name, text] of [['settings-label', settings.label], ['settings-title', settings.title]]) {
        const m = textBlocks(image, text.box, rgbOf(text.color), view.dpr, k);
        results.measures[name] = { ...text, ...m };
        evidence(image, name, text.box, view.dpr);
        check(`Settings: ${JSON.stringify(text.text)} (RS font): every ${k}x${k} block with ink is all ink`, m.inked > 0 && m.whole / m.inked >= 0.98, `${m.whole}/${m.inked}`);
    }
    {
        // the panel's left border (2px of --stone-light) a third of the way down: its colour's run in device px
        const box = settings.panel.box;
        const y = Math.round((box.y + box.h / 3) * view.dpr);
        const x = Math.max(0, Math.round(box.x * view.dpr) - 4);
        const run = borderRun(image, x, y, 1, 0, rgbOf(settings.panel.border), 16, 3);
        results.measures.panelBorder = { ...settings.panel, run };
        evidence(image, 'settings-border', { x: box.x, y: box.y + box.h / 3 - 10, w: 20, h: 20 }, view.dpr);
        check(`Settings: the panel's 2px stone border is ${2 * k} device px of its colour (computed ${settings.panel.borderWidth})`, run === 2 * k, `${run} device px of ${settings.panel.border}`);
    }
} catch (err) {
    check('the run finished', false, err.stack ?? String(err));
} finally {
    page?.close();
    d.adbQuiet('forward', '--remove', `tcp:${d.devtoolsPort}`);
    d.adbQuiet('shell', 'svc', 'power', 'stayon', 'false');
    results.finished = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    const total = results.checks.length;
    console.log(`\n${total - failures}/${total} checks passed; crops (4x) and results.json in ${path.relative(process.cwd(), OUT) || OUT}`);
    process.exit(failures ? 1 : 0);
}
