// render-verify: the Chrome driver (headless Chrome over CDP, an iPhone 13 mini in landscape as hud.mjs emulates it:
// 812x375 CSS px at 3x, touch, the iPhone's user agent, its safe area; real touches through Input.dispatchTouchEvent)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { IPHONE_UA, SAFE, sleep, VIEW } from './lib.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function openChrome({ url, inject, cdpPort, profileDir, view = VIEW, safe = SAFE, ua = IPHONE_UA, log = () => {} }) {
    fs.mkdirSync(profileDir, { recursive: true });
    const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    chrome.stderr.on('data', () => {});
    let version = null;
    for (let i = 0; i < 100 && !version; i++) {
        await sleep(200);
        try {
            version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
        } catch {
            // not up yet
        }
    }
    if (!version) {
        chrome.kill('SIGKILL');
        throw new Error('Chrome did not start');
    }
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
    let nextId = 0;
    const pending = new Map();
    const consoleLines = [];
    ws.addEventListener('message', event => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        }
        if (msg.method === 'Runtime.consoleAPICalled') {
            const line = `[${msg.params.type}] ${msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`;
            if (consoleLines.length < 5000) consoleLines.push(line);
            if (msg.params.type === 'error') log(`console ${line}`);
        } else if (msg.method === 'Runtime.exceptionThrown') {
            const line = `[exception] ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`;
            if (consoleLines.length < 5000) consoleLines.push(line);
            log(line);
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
    const metrics = v => S('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.dpr, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
    await metrics(view);
    await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await S('Emulation.setUserAgentOverride', { userAgent: ua });
    await S('Emulation.setSafeAreaInsetsOverride', { insets: safe });
    await S('Page.addScriptToEvaluateOnNewDocument', { source: inject });
    await S('Page.navigate', { url });

    const evaluate = async expression => {
        const reply = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (reply.error) throw new Error(`evaluate: ${reply.error.message}`);
        if (reply.result?.exceptionDetails) throw new Error(`evaluate failed: ${reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text}`);
        return reply.result?.result?.value;
    };
    const points = new Map(); // id -> {x, y}
    const dispatch = type => S('Input.dispatchTouchEvent', { type, touchPoints: [...points].map(([id, p]) => ({ x: p.x, y: p.y, id })) });
    const d = {
        engine: 'chrome',
        consoleLines,
        eval: evaluate,
        async waitFor(expression, timeoutMs, intervalMs = 200) {
            const started = Date.now();
            while (Date.now() - started < timeoutMs) {
                try {
                    const value = await evaluate(expression);
                    if (value) return { ok: true, ms: Date.now() - started, value };
                } catch {
                    // navigating
                }
                await sleep(intervalMs);
            }
            return { ok: false, ms: Date.now() - started };
        },
        async down(x, y, id = 1) {
            points.set(id, { x, y });
            await dispatch(points.size === 1 ? 'touchStart' : 'touchStart');
        },
        async move(x, y, id = 1) {
            points.set(id, { x, y });
            await dispatch('touchMove');
        },
        async up(x, y, id = 1) {
            points.delete(id);
            await dispatch(points.size ? 'touchEnd' : 'touchEnd');
        },
        async tap(x, y, holdMs = 60) {
            await d.down(x, y);
            await sleep(holdMs);
            await d.up(x, y);
        },
        async drag(x0, y0, x1, y1, steps = 12, stepMs = 25) {
            await d.down(x0, y0);
            await sleep(30);
            for (let i = 1; i <= steps; i++) {
                await d.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
                await sleep(stepMs);
            }
            await d.up(x1, y1);
        },
        async pinch(cx, cy, from, to, steps = 10, stepMs = 30) {
            await d.down(cx - from / 2, cy, 1);
            await d.down(cx + from / 2, cy, 2);
            await sleep(40);
            for (let i = 1; i <= steps; i++) {
                const s = from + ((to - from) * i) / steps;
                points.set(1, { x: cx - s / 2, y: cy });
                points.set(2, { x: cx + s / 2, y: cy });
                await dispatch('touchMove');
                await sleep(stepMs);
            }
            await d.up(cx + to / 2, cy, 2);
            await d.up(cx - to / 2, cy, 1);
        },
        async resize(width, height, dpr = view.dpr) {
            await metrics({ width, height, dpr });
            await d.waitFor(`innerWidth === ${width} && innerHeight === ${height}`, 5000, 50);
            await sleep(300);
        },
        async screenshot(file) {
            const r = await S('Page.captureScreenshot', { format: 'png' });
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
        },
        async reload() {
            await S('Page.reload', { ignoreCache: true });
        },
        async close() {
            try {
                ws.close();
            } catch {}
            chrome.kill('SIGKILL');
            await sleep(300);
        }
    };
    return d;
}
