// render-verify: the WebKit driver. The page runs in RVHost (host/RVHost.swift, compiled on first use into
// build/tmp/render-verify/RVHost): a macOS WKWebView, the Mac's WebKit and JavaScriptCore, which are the iPhone's
// version; 812x375 CSS px (the iPhone 13 mini's landscape size), the iPhone's user agent, a touch screen to the page
// (maxTouchPoints 5) and touches as synthetic pointer events (input.js). Evaluation goes through callAsyncJavaScript.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { HERE, IOS, IPHONE_UA, sleep, VIEW } from './lib.mjs';

const BIN = path.join(IOS, 'build', 'tmp', 'render-verify', 'RVHost');
const SRC = path.join(HERE, 'host', 'RVHost.swift');

export function buildHost() {
    if (fs.existsSync(BIN) && fs.statSync(BIN).mtimeMs > fs.statSync(SRC).mtimeMs) return BIN;
    fs.mkdirSync(path.dirname(BIN), { recursive: true });
    execFileSync('xcrun', ['swiftc', '-O', '-o', BIN, SRC, '-framework', 'AppKit', '-framework', 'WebKit'], { stdio: 'inherit' });
    return BIN;
}

// (WebKit has no CDP console here: errors are posted to the host)
const CONSOLE_HOOK = `(() => { const post = m => { try { webkit.messageHandlers.rv.postMessage(m); } catch {} };
    const err = console.error.bind(console); console.error = (...a) => { post({ console: 'error', text: a.map(String).join(' ').slice(0, 500) }); err(...a); };
    addEventListener('error', e => post({ console: 'exception', text: String(e.message) + ' ' + (e.filename || '') + ':' + (e.lineno || '') }));
    addEventListener('unhandledrejection', e => post({ console: 'exception', text: 'unhandled ' + String(e.reason?.stack ?? e.reason).slice(0, 500) })); })();`;

export async function openWebKit({ url, inject, tmp, view = VIEW, log = () => {} }) {
    const bin = buildHost();
    const injectFile = path.join(tmp, 'inject.js');
    fs.writeFileSync(injectFile, `${CONSOLE_HOOK}\n;\n${inject}`);
    const host = spawn(bin, [url, injectFile, String(view.width), String(view.height), IPHONE_UA], { stdio: ['pipe', 'pipe', 'pipe'] });
    host.stderr.on('data', () => {});
    let pid = 0;
    let nextId = 0;
    const pending = new Map();
    const consoleLines = [];
    let terminated = false;
    readline.createInterface({ input: host.stdout }).on('line', line => {
        if (line.startsWith('PID ')) {
            pid = Number(line.slice(4));
            return;
        }
        if (line === 'TERMINATED') {
            terminated = true;
            log('WebContent terminated');
            for (const p of pending.values()) p({ err: 'WebContent terminated' });
            return;
        }
        const m = /^(RES|ERR) (\d+) ?(.*)$/.exec(line);
        if (m) {
            const p = pending.get(m[2]);
            pending.delete(m[2]);
            const text = Buffer.from(m[3] ?? '', 'base64').toString('utf8');
            p?.(m[1] === 'RES' ? { ok: text } : { err: text });
            return;
        }
        if (line.startsWith('MSG ')) {
            try {
                const msg = JSON.parse(line.slice(4));
                if (msg.console) {
                    const l = `[${msg.console}] ${msg.text}`;
                    if (consoleLines.length < 5000) consoleLines.push(l);
                    log(`console ${l}`);
                }
            } catch {}
        }
    });
    const command = (cmd, rest, timeoutMs = 120000) =>
        new Promise((resolve, reject) => {
            if (terminated) return reject(new Error('WebContent terminated'));
            const id = String(++nextId);
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`${cmd} timed out`));
            }, timeoutMs);
            pending.set(id, r => {
                clearTimeout(timer);
                if (r.err !== undefined) reject(new Error(`${cmd} failed: ${r.err}`));
                else resolve(r.ok);
            });
            host.stdin.write(`${cmd} ${id} ${rest}\n`);
        });
    const evaluate = async expression => {
        const body = `const __v = await (${expression}); return JSON.stringify(__v === undefined ? null : __v);`;
        const text = await command('EVAL', Buffer.from(body, 'utf8').toString('base64'));
        return text === 'null' || text === '' ? (text === 'null' ? null : undefined) : JSON.parse(text);
    };
    const d = {
        engine: 'webkit',
        consoleLines,
        get pid() {
            return pid;
        },
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
        down: (x, y, id = 1) => evaluate(`window.__rvInput.down(${x}, ${y}, ${id})`),
        move: (x, y, id = 1) => evaluate(`window.__rvInput.move(${x}, ${y}, ${id})`),
        up: (x, y, id = 1) => evaluate(`window.__rvInput.up(${x}, ${y}, ${id})`),
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
                await d.move(cx - s / 2, cy, 1);
                await d.move(cx + s / 2, cy, 2);
                await sleep(stepMs);
            }
            await d.up(cx + to / 2, cy, 2);
            await d.up(cx - to / 2, cy, 1);
        },
        async resize(width, height) {
            await command('RESIZE', `${width} ${height}`);
            await d.waitFor(`innerWidth === ${width} && innerHeight === ${height}`, 5000, 50);
            await sleep(300);
        },
        async screenshot(file) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            await command('SNAP', file);
        },
        async reload() {
            await evaluate('(location.reload(), true)').catch(() => {});
        },
        async close() {
            try {
                host.stdin.write('QUIT\n');
            } catch {}
            await sleep(500);
            host.kill('SIGKILL');
            await sleep(300);
        }
    };
    return d;
}
