// Headless Chrome over the DevTools protocol for the gallery scripts (capture.mjs, gallery.mjs): one page, iPhone-like
// touch emulation (or an Android phone's user agent and pixel ratio), evaluate / screenshot / touch helpers.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

export async function launch({ port, profileDir, view = { width: 812, height: 375 }, scale = 2, initScripts = [], userAgent = IPHONE_UA }) {
    fs.mkdirSync(profileDir, { recursive: true });
    const chrome = spawn(
        CHROME,
        ['--headless=new', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank'],
        { stdio: ['ignore', 'ignore', 'pipe'] }
    );

    let version = null;
    for (let i = 0; i < 60 && !version; i++) {
        await sleep(200);
        try {
            version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        } catch {
            // not up yet
        }
    }
    if (!version) {
        chrome.kill();
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
            consoleLines.push(`[${msg.params.type}] ${msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`);
        } else if (msg.method === 'Runtime.exceptionThrown') {
            consoleLines.push(`[exception] ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
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
    await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await S('Emulation.setUserAgentOverride', { userAgent });
    for (const source of initScripts) {
        await S('Page.addScriptToEvaluateOnNewDocument', { source });
    }

    const page = {
        consoleLines,
        S,
        // (s: the device pixel ratio, fractional ones too: an Android phone's 2.625)
        async setView(v, s = scale) {
            await S('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: s, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
        },
        async setUserAgent(ua) {
            await S('Emulation.setUserAgentOverride', { userAgent: ua });
        },
        // CSS env(safe-area-inset-*) like the phone's (the host's own reads can be overridden by __lcSafeAreaOverride)
        async setSafeArea(insets) {
            await S('Emulation.setSafeAreaInsetsOverride', { insets: { top: insets.top, left: insets.left, bottom: insets.bottom, right: insets.right } });
        },
        async evaluate(expression) {
            const reply = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
            if (reply.result?.exceptionDetails) {
                throw new Error(`evaluate failed: ${reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text}`);
            }
            return reply.result?.result?.value;
        },
        async waitFor(expression, timeoutMs, intervalMs = 150) {
            const started = Date.now();
            while (Date.now() - started < timeoutMs) {
                try {
                    const value = await page.evaluate(expression);
                    if (value) {
                        return { ok: true, ms: Date.now() - started, value };
                    }
                } catch {
                    // navigating
                }
                await sleep(intervalMs);
            }
            return { ok: false, ms: Date.now() - started };
        },
        async navigate(url) {
            await S('Page.navigate', { url });
        },
        async screenshot(file) {
            const reply = await S('Page.captureScreenshot', { format: 'png' });
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, Buffer.from(reply.result.data, 'base64'));
            return file;
        },
        // touchPoints: [{x, y}] (several for multi-touch); [] ends every touch
        async touch(type, points) {
            await S('Input.dispatchTouchEvent', { type, touchPoints: points });
        },
        async tap(x, y, holdMs = 60) {
            await page.touch('touchStart', [{ x, y }]);
            await sleep(holdMs);
            await page.touch('touchEnd', []);
        },
        async rect(selector) {
            return page.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; const r = n.getBoundingClientRect(); const cs = getComputedStyle(n); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !n.closest('[hidden]') }; })()`);
        },
        async close() {
            try {
                ws.close();
            } catch {
                // ignore
            }
            chrome.kill();
        }
    };
    await page.setView(view, scale);
    return page;
}

export { sleep };
