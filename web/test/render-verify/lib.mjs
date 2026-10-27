// render-verify: shared helpers (the page script, the exposed client bundle, the game-level steps both drivers use, PNGs)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const IOS = path.resolve(HERE, '..', '..', '..');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
// the iPhone 13 mini in landscape, as hud.mjs runs it (a 50 px notch inset each side, 21 px home indicator)
export const SAFE = { top: 0, right: 50, bottom: 21, left: 50 };
export const VIEW = { width: 812, height: 375, dpr: 3 };

// The renderer classes the oracle needs, exposed on globalThis.__lc by a line added before the bundle's export block
// (a debug bundle keeps the class names). Returns the source to serve as /client/client.js.
export const EXPOSED = ['VarpType', 'IfType', 'Pix2D', 'Pix3D', 'Model', 'ModelSource', 'World', 'PixMap', 'ClientLocAnim', 'ClientEntity', 'ClientNpc', 'ClientPlayer', 'ClientObj', 'ClientProj', 'MapSpotAnim', 'LocType', 'SeqType', 'Square', 'GameShell', 'IncrRender', 'IncrVerify', 'Client'];
export function exposeClient(gameDir) {
    const file = path.join(gameDir, 'client', 'client.js');
    const src = fs.readFileSync(file, 'utf8');
    const at = src.lastIndexOf('\nexport {');
    if (at < 0) throw new Error(`${file}: no export block (not a client bundle?)`);
    const have = EXPOSED.filter(n => new RegExp(`^var ${n} = `, 'm').test(src));
    for (const need of ['Pix2D', 'Pix3D', 'Model', 'ModelSource', 'World']) {
        if (!have.includes(need)) throw new Error(`${file}: no class ${need} (a release bundle? build with --debug)`);
    }
    return { source: `${src.slice(0, at)}\nglobalThis.__lc = { ${have.join(', ')} };${src.slice(at)}`, exposed: have };
}

// The script injected at document start: the settings the page boots with, the oracle, the prototype (impl
// 'prototype'), synthetic touches (WebKit), the canvas read-back, the safe area.
export function pageScript({ settings, impl, touch = false, safe = undefined, nativeHooks = null, bare = false }) {
    safe ??= SAFE;
    const parts = [`try { localStorage.setItem('lostcity.settings', JSON.stringify(${JSON.stringify(settings)})); } catch {}`, `window.__lcSafeAreaOverride = ${JSON.stringify(safe)};`];
    if (touch) {
        // (WebKit on the Mac: a touch screen, as the phone's page sees it)
        parts.push(`try { Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5, configurable: true }); } catch {} if (!('ontouchstart' in window)) window.ontouchstart = null;`);
        parts.push(fs.readFileSync(path.join(HERE, 'input.js'), 'utf8'));
    }
    if (bare) return parts.join('\n;\n'); // (no oracle, no wrappers: the build as it is)
    if (impl === 'prototype') parts.push(fs.readFileSync(path.join(HERE, 'prototype-incr.js'), 'utf8'));
    if (nativeHooks) parts.push(fs.readFileSync(nativeHooks, 'utf8'));
    else if (fs.existsSync(path.join(HERE, 'native-hooks.js'))) parts.push(fs.readFileSync(path.join(HERE, 'native-hooks.js'), 'utf8'));
    parts.push(fs.readFileSync(path.join(HERE, 'oracle.js'), 'utf8'));
    parts.push(fs.readFileSync(path.join(HERE, 'shown.js'), 'utf8'));
    return parts.join('\n;\n');
}

// ---------------------------------------------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();
const crc32 = buf => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
};
// rgb: Int32Array of 0xRRGGBB, w x h (optionally scaled up by `scale`)
export function writePng(file, rgb, w, h, scale = 1) {
    const W = w * scale, H = h * scale;
    const raw = Buffer.alloc((W * 3 + 1) * H);
    for (let y = 0; y < H; y++) {
        const row = y * (W * 3 + 1);
        raw[row] = 0;
        for (let x = 0; x < W; x++) {
            const p = rgb[((y / scale) | 0) * w + ((x / scale) | 0)];
            raw[row + 1 + x * 3] = (p >> 16) & 0xff;
            raw[row + 2 + x * 3] = (p >> 8) & 0xff;
            raw[row + 3 + x * 3] = p & 0xff;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
// a saved crop (oracle RV.saved): the build's frame, the reference and the difference side by side
export function writeCrop(file, crop) {
    const a = new Int32Array(Buffer.from(crop.impl, 'base64').buffer.slice(0));
    const b = new Int32Array(Buffer.from(crop.ref, 'base64').buffer.slice(0));
    const { w, h } = crop;
    const out = new Int32Array((w * 3 + 4) * h);
    const W = w * 3 + 4;
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            out[y * W + x] = a[i];
            out[y * W + w + 2 + x] = b[i];
            out[y * W + 2 * w + 4 + x] = a[i] === b[i] ? (((a[i] >> 18) & 0x3f) * 0x010101) : 0xff00ff;
        }
    writePng(file, out, W, h, 3);
}

// ---------------------------------------------------------------------------------------------------- game steps

const C = 'window.__client';
export const game = d => {
    const g = {
        eval: e => d.eval(e),
        waitFor: (e, ms, every = 200) => d.waitFor(e, ms, every),
        async title(timeoutMs = 240000) {
            return d.waitFor(`${C}?.lastProgressPercent === 100 && !!${C}?.titleFlames && window.LostCityHost?.engineState === 'ready'`, timeoutMs, 500);
        },
        // offline a login is a name (a new one makes a character); the host's own path (titleScreen.login) taps the form's
        // Login button, this calls the client's login directly
        async login(name, timeoutMs = 90000) {
            let r = { ok: false };
            for (let i = 0; i < 8 && !r.ok; i++) {
                if (i > 0) await sleep(2500); // (the world may still be saving the character after a logout)
                await d.eval(`(() => { const c = ${C}; c.loginUser = ${JSON.stringify(name)}; c.loginPass = 'offline'; c.loginscreen = 2; c.loginSelect = 0; c.login(${JSON.stringify(name)}, 'offline', false); return true; })()`);
                // (a login right after a logout can hang in the client: retried after 20 s, which then goes through)
                r = await d.waitFor(`${C}?.ingame === true && !!${C}?.localPlayer && ${C}.sceneState === 2`, i === 0 ? Math.min(timeoutMs, 20000) : 20000, 300);
                if (!r.ok) {
                    r.why = await d.eval(`[${C}.loginMes1, ${C}.loginMes2]`);
                    (r.tries ??= []).push(r.why);
                }
            }
            return r;
        },
        // the Logout tab's button (as a player logs out: the world saves and lets the name go at once; the client's own
        // logout() alone leaves the player in the world for a minute or more)
        async logout() {
            // (the button's script does nothing while another script holds the player, e.g. just after a teleport:
            // tapped again every 2 s)
            const hud = await d.eval(`!document.getElementById('hud').hidden && !!document.querySelector('#hud-tabs .tab[data-tab="10"]')`);
            if (hud) {
                await g.tapElement('#hud-tabs .tab[data-tab="10"]').catch(() => {});
                await sleep(500);
            }
            // (the Logout tab itself, if the tap did not select it)
            await d.eval(`(() => { const c = ${C}; if (c.activeIcon !== 10 && c.sideIcon?.[10] !== -1) { c.activeIcon = 10; c.redrawSide = true; c.redrawIcons = true; } return c.activeIcon; })()`);
            await sleep(300);
            let r = { ok: false };
            for (let i = 0; i < 6 && !r.ok; i++) {
                await d.eval(`(${C}.ingame && ${C}.tapAt(647, 375), true)`);
                r = await d.waitFor(`${C}.ingame === false && !${C}.reconnecting`, 2000, 100);
                r.via = `logout button, tap ${i + 1}`;
            }
            if (!r.ok) {
                await d.eval(`${C}.logout().then(() => true)`);
                r = { ...(await d.waitFor(`${C}.ingame === false && !${C}.reconnecting`, 20000)), via: 'client logout()' };
            }
            return r;
        },
        async chat(text, settleMs = 700) {
            await d.eval(`window.LostCityHost.keyboard.insertText(${JSON.stringify(`${text}\n`)})`);
            await sleep(settleMs);
        },
        // a game message in the chatbox on Tutorial Island ("click to continue") eats the next click
        async dismiss() {
            for (let i = 0; i < 4 && (await d.eval(`!!${C}.tutComMessage || ${C}.hudState?.().chatContinue === true`)); i++) {
                await d.eval(`${C}.hudContinue?.()`);
                await sleep(400);
            }
        },
        tile: () => d.eval(`(() => { const c = ${C}; const p = c?.localPlayer; return p ? [c.mapBuildBaseX + (p.x >> 7), c.mapBuildBaseZ + (p.z >> 7), c.minusedlevel] : null; })()`),
        async tele(level, x, z, settleMs = 3000) {
            const there = `(() => { const t = ${C}.hudPlayerTile?.(); return t && t.x === ${x} && t.z === ${z} && ${C}.minusedlevel === ${level} && ${C}.sceneState === 2; })()`;
            await g.chat(`::tele ${level},${x >> 6},${z >> 6},${x & 63},${z & 63}`);
            let r = await d.waitFor(there, 6000);
            if (!r.ok) {
                // (a skill in progress holds the player and the command is dropped: a step aside stops it, then again)
                await d.eval(`(() => { const c = ${C}, p = c.localPlayer; c.tryMove(p.routeX[0], p.routeZ[0], (p.x >> 7) + 1, p.z >> 7, true, 0, 0, 0, 0, 0, 0); return true; })()`);
                await sleep(1500);
                await g.chat(`::tele ${level},${x >> 6},${z >> 6},${x & 63},${z & 63}`);
                r = await d.waitFor(there, 25000);
            }
            if (!r.ok) throw new Error(`teleport to ${level},${x},${z} did not arrive (at ${JSON.stringify(await g.tile())})`);
            await sleep(settleMs);
        },
        // a point of the client's viewport (viewport px) as page CSS px on the world surface (mobile) or the canvas (classic)
        async worldPoint(vx, vy) {
            return d.eval(`(() => { const c = ${C}; const s = document.getElementById('surface-game'); const mobile = s && s.getClientRects().length && !document.getElementById('hud').hidden;
                if (mobile) { const r = s.getBoundingClientRect(); return { x: r.left + (${vx} * r.width) / s.width, y: r.top + (${vy} * r.height) / s.height }; }
                const k = document.getElementById('canvas').getBoundingClientRect(); return { x: k.left + ((4 + ${vx}) * k.width) / 765, y: k.top + ((4 + ${vy}) * k.height) / 503 }; })()`);
        },
        // where a world tile's centre shows (viewport px), or null off screen
        async tilePoint(dx, dz, height = 0) {
            return d.eval(`(() => { const c = ${C}; const p = c.localPlayer; const x = (p.x >> 7) + ${dx}, z = (p.z >> 7) + ${dz}; c.getOverlayPos(x * 128 + 64, z * 128 + 64, ${height}); return c.projectX < 0 ? null : { x: c.projectX, y: c.projectY }; })()`);
        },
        async rect(selector) {
            return d.eval(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; const r = n.getBoundingClientRect(); const cs = getComputedStyle(n); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !n.closest('[hidden]') }; })()`);
        },
        async tapElement(selector, holdMs = 60) {
            const r = await g.rect(selector);
            if (!r?.visible) throw new Error(`${selector} is not on screen`);
            await d.tap(r.cx, r.cy, holdMs);
            return r;
        },
        async setting(key, value, nav = null) {
            await g.tapElement('#btn-settings');
            await sleep(400);
            if (nav) {
                await g.tapElement(`#nav-${nav}`);
                await sleep(200);
            }
            await g.tapElement(`.seg[data-setting="${key}"] button[data-value="${value}"]`);
            await sleep(500);
            await g.tapElement('#settings-close');
            await sleep(500);
        },
        hud: () => d.eval(`${C}.hudState?.()`),
        mark: label => d.eval(`window.__rv.mark(${JSON.stringify(label)})`)
    };
    return g;
};
