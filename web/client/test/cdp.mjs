// Minimal Chrome DevTools Protocol driver for the client harness: launches headless Chrome with an isolated
// profile on a CDP port in the client range (47400-47449) and exposes send/on/evaluate/touch helpers.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function launchChrome({ port = 47401, profileDir, chrome = CHROME }) {
    if (port < 47400 || port > 47449) {
        throw new Error(`CDP port ${port} is outside the client's range 47400-47449`);
    }
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.mkdirSync(profileDir, { recursive: true });
    const proc = spawn(
        chrome,
        [
            '--headless=new',
            `--remote-debugging-port=${port}`,
            '--remote-debugging-address=127.0.0.1',
            `--user-data-dir=${profileDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-background-timer-throttling', // the game loop runs on setTimeout
            '--disable-renderer-backgrounding',
            '--autoplay-policy=no-user-gesture-required',
            '--mute-audio',
            'about:blank'
        ],
        { stdio: 'ignore' }
    );
    let version = null;
    for (let i = 0; i < 100 && !version; i++) {
        await sleep(100);
        try {
            version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        } catch {
            // not up yet
        }
    }
    if (!version) {
        proc.kill('SIGKILL');
        throw new Error('Chrome did not start (CDP endpoint not reachable)');
    }
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
    });
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.addEventListener('message', ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`)) : resolve(msg.result);
        } else if (msg.method) {
            for (const l of listeners) {
                l(msg);
            }
        }
    });
    const send = (method, params = {}, sessionId) =>
        new Promise((resolve, reject) => {
            const i = ++id;
            pending.set(i, { resolve, reject });
            ws.send(JSON.stringify({ id: i, method, params, sessionId }));
        });
    const close = async () => {
        try {
            await send('Browser.close');
        } catch {
            // already gone
        }
        ws.close();
        await sleep(300);
        proc.kill('SIGKILL');
        fs.rmSync(profileDir, { recursive: true, force: true });
    };
    return { send, on: fn => listeners.push(fn), close };
}

// A page target with helpers. `metrics` = Emulation.setDeviceMetricsOverride params.
export async function openPage(cdp, { metrics, userAgent, touchEmulation = true }) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const S = (m, p) => cdp.send(m, p, sessionId);
    const console = [];
    cdp.on(msg => {
        if (msg.sessionId !== sessionId) {
            return;
        }
        if (msg.method === 'Runtime.consoleAPICalled') {
            console.push(`[${msg.params.type}] ${msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`.slice(0, 500));
        } else if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails;
            console.push(`[exception] ${d.exception?.description ?? d.text}`.slice(0, 800));
        } else if (msg.method === 'Log.entryAdded') {
            console.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`.slice(0, 500));
        }
    });
    await S('Runtime.enable');
    await S('Log.enable');
    await S('Page.enable');
    await S('Emulation.setDeviceMetricsOverride', metrics);
    if (touchEmulation) {
        await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    if (userAgent) {
        await S('Emulation.setUserAgentOverride', { userAgent });
    }
    const evaluate = async (expression, { awaitPromise = true } = {}) => {
        const r = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
        if (r.exceptionDetails) {
            throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n${expression.slice(0, 200)}`);
        }
        return r.result?.value;
    };
    const screenshot = async file => {
        const r = await S('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    };
    // Touch helpers in CSS px. Each touch point may carry an `id` (multi-touch).
    const touch = {
        start: points => S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points }),
        move: points => S('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points }),
        end: (points = []) => S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: points }),
        cancel: () => S('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
    };
    return { S, sessionId, targetId, console, evaluate, screenshot, touch, navigate: url => S('Page.navigate', { url }) };
}
