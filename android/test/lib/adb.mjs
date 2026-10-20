// adb and CDP for the Android app's tests (docs/ANDROID.md §2 test/): one device by serial, the
// app's WebView over Chrome DevTools Protocol (debug builds enable WebContents debugging), screenshots, logcat.
//
//   import { device } from './lib/adb.mjs';
//   const d = device('emulator-5554');
//   const page = await d.connect();          // the page target on https://appassets.androidplatform.net
//   await page.eval('1 + 1');
//
// The host port forwarded to the WebView's devtools socket is per device (9000 + the emulator's console port mod 1000,
// e.g. 9554), so tests on other emulators of the same Mac do not take each other's port.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export const ANDROID_HOME = process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`;
export const ADB = `${ANDROID_HOME}/platform-tools/adb`;
export const PKG = 'io.github.purexyz.scape2004';
export const ACTIVITY = `${PKG}/.GameActivity`;
export const ORIGIN = 'https://appassets.androidplatform.net';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function device(serial, { port } = {}) {
    const devtoolsPort = port ?? 9000 + ((Number(/(\d+)$/.exec(serial)?.[1]) || 5554) % 1000);
    const adb = (...args) => execFileSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
    // (errors are expected here: their output is returned, not printed)
    const adbQuiet = (...args) => {
        try {
            return execFileSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            return String(err.stdout ?? '') + String(err.stderr ?? '');
        }
    };
    const pid = () => adbQuiet('shell', 'pidof', PKG).trim().split(/\s+/)[0] || null;

    /** The app's page as a CDP session: eval (awaits promises), send, touch helpers, worker eval. */
    async function connect({ timeoutMs = 30000, match = ORIGIN } = {}) {
        const started = Date.now();
        let target = null;
        let lastError = null;
        while (!target && Date.now() - started < timeoutMs) {
            try {
                const id = pid();
                if (id) {
                    adbQuiet('forward', '--remove', `tcp:${devtoolsPort}`);
                    adb('forward', `tcp:${devtoolsPort}`, `localabstract:webview_devtools_remote_${id}`);
                    const list = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
                    target = list.find(t => t.type === 'page' && t.url.startsWith(match)) ?? null;
                }
            } catch (err) {
                lastError = err;
            }
            if (!target) await sleep(300);
        }
        if (!target) throw new Error(`no page target on ${serial} (${lastError?.message ?? 'none listed'})`);
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', reject, { once: true });
        });
        let nextId = 0;
        const pending = new Map();
        const listeners = [];
        const workers = [];
        let closed = false;
        ws.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.id && pending.has(message.id)) {
                pending.get(message.id)(message);
                pending.delete(message.id);
                return;
            }
            if (message.method === 'Target.attachedToTarget') workers.push({ sessionId: message.params.sessionId, info: message.params.targetInfo });
            for (const listener of listeners) listener(message);
        });
        ws.addEventListener('close', () => {
            closed = true;
            for (const resolve of pending.values()) resolve({ error: { message: 'connection closed' } });
            pending.clear();
        });
        const send = (method, params = {}, sessionId) =>
            new Promise(resolve => {
                if (closed) return resolve({ error: { message: 'connection closed' } });
                const id = ++nextId;
                pending.set(id, resolve);
                ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
            });
        const evaluate = async (expression, sessionId) => {
            const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 120000 }, sessionId);
            if (reply.error) throw new Error(reply.error.message ?? JSON.stringify(reply.error));
            if (reply.result.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text);
            return reply.result.result.value;
        };
        const touch = async (x, y, holdMs = 60) => {
            await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
            await sleep(holdMs);
            await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        };
        return {
            target,
            send,
            on: fn => listeners.push(fn),
            get closed() {
                return closed;
            },
            eval: expression => evaluate(expression),
            touch,
            /** A tap at the centre of the first element matching `selector`; false if it is not shown. */
            async tapElement(selector, holdMs = 60) {
                const rect = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.offsetParent === null && getComputedStyle(e).position !== 'fixed') return null; const r = e.getBoundingClientRect(); return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
                if (!rect) return false;
                await touch(rect.x, rect.y, holdMs);
                return true;
            },
            /** A tap at classic game coordinates (765×503) on the title canvas. */
            async tapGame(gx, gy, holdMs = 60) {
                const r = await evaluate(`(() => { const r = document.getElementById('canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
                await touch(r.x + (gx * r.w) / 765, r.y + (gy * r.h) / 503, holdMs);
            },
            async attachWorkers() {
                await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
                for (let i = 0; i < 30 && !workers.length; i++) await sleep(100);
                return workers;
            },
            evalWorker: (expression, i = 0) => evaluate(expression, workers[i]?.sessionId),
            close: () => {
                try {
                    ws.close();
                } catch {}
            }
        };
    }

    return {
        serial,
        devtoolsPort,
        adb,
        adbQuiet,
        pid,
        connect,
        /**
         * `adb install -r` with the app stopped first: Android 17 swaps an app updated while on screen for a placeholder
         * and relaunches it when the install is done (PackageUpdateController), which can race the test's own
         * `pm clear` and launch and leave the launcher in front. Returns adb's last line ("Success").
         */
        install(apk) {
            adbQuiet('shell', 'am', 'force-stop', PKG);
            return adb('install', '-r', apk).trim().split('\n').pop();
        },
        /** The real screen (system bars, native views and all), as a PNG file. */
        screenshot(file) {
            const png = execFileSync(ADB, ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 });
            fs.writeFileSync(file, png);
            return file;
        },
        /** The app's native log lines (tag LostCity) since the last clearLog(). */
        log() {
            return adbQuiet('logcat', '-d', '-v', 'time', '-s', 'LostCity:V')
                .split('\n')
                .filter(line => line.includes('LostCity'));
        },
        clearLog() {
            adbQuiet('logcat', '-c');
        },
        /** Taps the first native view whose text or content-desc matches `pattern` (uiautomator); false if none. */
        tapNative(pattern) {
            adbQuiet('shell', 'uiautomator', 'dump', '/sdcard/lc-ui.xml');
            const xml = adbQuiet('shell', 'cat', '/sdcard/lc-ui.xml');
            for (const node of xml.match(/<node [^>]*>/g) ?? []) {
                const text = /text="([^"]*)"/.exec(node)?.[1] ?? '';
                const desc = /content-desc="([^"]*)"/.exec(node)?.[1] ?? '';
                const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
                if (bounds && (pattern.test(text) || pattern.test(desc))) {
                    const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
                    adbQuiet('shell', 'input', 'tap', String((x1 + x2) >> 1), String((y1 + y2) >> 1));
                    return true;
                }
            }
            return false;
        },
        /** The views on screen (uiautomator dump), for checks on native views. */
        uiDump() {
            adbQuiet('shell', 'uiautomator', 'dump', '/sdcard/lc-ui.xml');
            return adbQuiet('shell', 'cat', '/sdcard/lc-ui.xml');
        }
    };
}
