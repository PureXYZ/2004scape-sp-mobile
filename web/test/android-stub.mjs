// What the Android app gives the page before host.js runs (docs/ANDROID.md §3.1), for the desktop harnesses that run
// the page as the Android app does (e2e.mjs, hud.mjs and gallery/gallery.mjs with --platform android): a script for
// Page.addScriptToEvaluateOnNewDocument, and the Android screens they use.
//
// The script, in the main frame only (the app's document-start script checks window.top === window too):
//   window.LostCityNative       {platform: 'android', appVersion, build, osVersion, sdkInt, deviceModel, simulator,
//                               emulator, debug, webView, haptics, settings, lm}: settings are what the page last sent
//                               ({type:'settings'}), kept in localStorage as the app keeps them, so a reload gets them
//                               back the way the app hands them back (read when the page reads them: a harness may
//                               seed localStorage in a script that runs after this one)
//   window.LostCityNativeBridge {native, log}.postMessage(m) → lcAndroid.postMessage(JSON.stringify({ch, msg: m}))
//                               (bridge: false leaves it out, and LostCityNative.settings with it: the page then has no
//                               native handler and keeps its settings in localStorage itself, as in a desktop browser,
//                               but has the Android platform's words and screen)
//   window.lcAndroid            a stub of the app's WebMessageListener object: it records every message it is sent,
//                               parsed, in window.__androidStub.posted ({ch:'native'|'log'|'reply', ...}) and answers
//                               nothing (the harness calls window.__lcCall as the app's evaluateJavascript would)
//   window.Worker               wrapped: the page's init message to the engine is kept in window.__androidStub.init
//   window.__androidStub.loaderFill  the loader bar's fill widths as the page sets them, in order (the native cover draws
//                               6 %, so the page's first should be that)
export const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/145.0.0.0 Mobile Safari/537.36';

// Android screens in landscape (CSS px at the device's real pixel ratio; safe: the camera cutout, which an immersive app
// with cutout mode ALWAYS sees through env(safe-area-inset-*)), with what the page should make of them: the HUD's zoom
// (host.js layout(): the crisp pixel snap at a fractional ratio) and the world's render size (hud.js renderSize: a whole
// number of device px per game px where that leaves a 512 px window beside the side panel, else the iPhone rule).
export const ANDROID_SCREENS = {
    // the Medium Phone AVD (2400x1080 at 420 dpi, no cutout emulated) and Pixel 9-class phones: 3 device px per HUD px and
    // per game px, as a 3x iPhone
    'a-medium': { name: 'Medium Phone AVD / Pixel 9 class', view: { width: 914, height: 411 }, dpr: 2.625, safe: { top: 0, right: 0, bottom: 0, left: 0 }, zoom: 3 / 2.625, world: [800, 360] },
    // the AVD at its other Display sizes (Settings › Display size: 356, 460, 500, 540 dpi). Small and Large stay crisp
    // (2 and 3 device px per HUD px); at Larger and Largest 4 would leave the HUD under 320 px tall, so rather than round
    // down to the default's 3 (the HUD would not grow), the zoom is the Display size's own (soft): 3.125 and 3.375
    // device px per HUD px, and the world likewise (the iPhone rule)
    // (356 dpi is a ratio of 2.2250001: Android's density is the float densityDpi × (1f / 160), and the WebView reports it)
    'a-small': { name: 'Medium Phone AVD, Display size Small', view: { width: 1078, height: 485 }, dpr: Math.fround(356 * Math.fround(1 / 160)), safe: { top: 0, right: 0, bottom: 0, left: 0 }, zoom: 2 / Math.fround(356 * Math.fround(1 / 160)), world: [800, 360] },
    'a-large': { name: 'Medium Phone AVD, Display size Large', view: { width: 834, height: 375 }, dpr: 2.875, safe: { top: 0, right: 0, bottom: 0, left: 0 }, zoom: 3 / 2.875, world: [800, 360] },
    'a-larger': { name: 'Medium Phone AVD, Display size Larger', view: { width: 768, height: 345 }, dpr: 3.125, safe: { top: 0, right: 0, bottom: 0, left: 0 }, zoom: 1, world: [768, 345] },
    'a-largest': { name: 'Medium Phone AVD, Display size Largest', view: { width: 711, height: 320 }, dpr: 3.375, safe: { top: 0, right: 0, bottom: 0, left: 0 }, zoom: 1, world: [742, 334] },
    // Pixel 10 (2424x1080 at 420 dpi), its camera hole on the left
    'a-pixel10': { name: 'Pixel 10', view: { width: 923, height: 411 }, dpr: 2.625, safe: { top: 0, right: 0, bottom: 0, left: 32 }, zoom: 3 / 2.625, world: [808, 360] },
    // Pixel 10 Pro class (2856x1280 at 480 dpi): a whole-number ratio, so the iPhone rules exactly
    'a-pro': { name: 'Pixel 10 Pro class', view: { width: 952, height: 427 }, dpr: 3, safe: { top: 0, right: 0, bottom: 0, left: 32 }, zoom: 1, world: [952, 427] },
    // 2400x1080 at 480 dpi (many Galaxy phones)
    'a-800': { name: '2400x1080 at 480 dpi', view: { width: 800, height: 360 }, dpr: 3, safe: { top: 0, right: 0, bottom: 0, left: 30 }, zoom: 1, world: [800, 360] },
    // 1920x1080 at 420 dpi: the HUD snaps; at 3 device px a game px no 512 px window would fit beside the panel, so the
    // world keeps the iPhone rule (soft at 2.625), rendered a little larger, as the smallest phone's, now that the camera
    // hole's 24 is kept on both sides
    'a-732': { name: '1920x1080 at 420 dpi', view: { width: 732, height: 412 }, dpr: 2.625, safe: { top: 0, right: 0, bottom: 0, left: 24 }, zoom: 3 / 2.625, world: [762, 429] },
    // 1280x720 at 320 dpi: the smallest phone; the world renders a little larger so the bank fits beside the panel
    'a-640': { name: '1280x720 at 320 dpi', view: { width: 640, height: 360 }, dpr: 2, safe: { top: 0, right: 0, bottom: 0, left: 0 }, zoom: 1, world: [694, 391] },
    // a tablet (2560x1600 at 320 dpi): the HUD ×1.5 as on an iPad
    'a-tablet': { name: 'Tablet 2560x1600', view: { width: 1280, height: 800 }, dpr: 2, safe: { top: 0, right: 0, bottom: 0, left: 0 }, zoom: 1.5, world: [810, 506] }
};

/** The page script (see the top of this file). */
export function androidPageScript({ bridge = true, haptics = true, lm = null } = {}) {
    const status = lm ?? { local: { available: false, loaded: false, think: 'never', reason: 'no-model' }, online: { keySet: false } };
    return `(() => {
    if (window.top !== window) return;
    const stub = (window.__androidStub = { posted: [], init: null });
    const KEY = 'lostcity.settings';
    // (read when the page reads it, at its boot: a harness's own settings script may run after this one)
    const stored = () => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { return {}; } };
    window.lcAndroid = {
        postMessage(data) {
            let message;
            try { message = JSON.parse(data); } catch { message = { unparsed: String(data) }; }
            stub.posted.push(message);
            if (message.ch === 'native' && message.msg?.type === 'settings') {
                try { localStorage.setItem(KEY, JSON.stringify({ ...JSON.parse(localStorage.getItem(KEY) ?? '{}'), ...message.msg.values })); } catch {}
            }
        }
    };
    if (${bridge}) {
        window.LostCityNativeBridge = {
            native: { postMessage: msg => window.lcAndroid.postMessage(JSON.stringify({ ch: 'native', msg })) },
            log: { postMessage: msg => window.lcAndroid.postMessage(JSON.stringify({ ch: 'log', msg })) }
        };
    }
    window.LostCityNative = { platform: 'android', appVersion: '1.0', build: '1', osVersion: '17', sdkInt: 37, deviceModel: 'desktop stub', simulator: false, emulator: true,
        debug: true, webView: '145.0.7632.218', haptics: ${haptics}, lm: ${JSON.stringify(status)} };
    if (${bridge}) Object.defineProperty(window.LostCityNative, 'settings', { get: stored, enumerable: true });
    stub.loaderFill = [];
    const findFill = new MutationObserver(() => {
        const fill = document.getElementById('loading-fill');
        if (!fill) return;
        findFill.disconnect();
        const record = () => { const width = fill.style.width; if (width && stub.loaderFill.at(-1) !== width) stub.loaderFill.push(width); };
        record();
        new MutationObserver(record).observe(fill, { attributes: true, attributeFilter: ['style'] });
    });
    findFill.observe(document, { childList: true, subtree: true });
    const PageWorker = window.Worker;
    window.Worker = class extends PageWorker {
        postMessage(...args) {
            if (args[0]?.type === 'init') stub.init = JSON.parse(JSON.stringify(args[0]));
            return super.postMessage(...args);
        }
    };
})();`;
}
