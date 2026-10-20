#!/usr/bin/env node
// Simulator driver for the native-layer test page (game-test/).
//
//   node drive.mjs            # copy the built app, swap Game/ for game-test/, re-sign, install,
//                             # launch with console capture, react to the page's markers
//
// Markers printed by test.js (through the console bridge → native stdout):
//   SHOT <name>                 → xcrun simctl io screenshot run-*/<name>.png
//   ACTION background-cycle     → open Settings (app goes to background), 5 s, reopen the app
//   ACTION background-hang      → same, 12 s in background (> the 8 s native flush timeout)
//   ACTION kill-webcontent      → kill -9 the app's WebContent process
//   DONE pass=N fail=M          → terminate the app, stop
//
// It also runs the local mock of the Messages API (web/test/lm/mock-claude.mjs, port LM_MOCK_PORT or 47591) for the
// test page's bots' chat model phase: the app's online requests go there (a DEBUG hook), never to the real API.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockClaude } from '../lm/mock-claude.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const TMP = `${ROOT}/build/tmp/swift`;
fs.mkdirSync(TMP, { recursive: true });
const UDID = process.env.UDID ?? fs.readFileSync(`${TMP}/sim-udid.txt`, 'utf8').trim();
const BUILT = `${ROOT}/build/DerivedData-swift/Build/Products/Debug-iphonesimulator/LostCity.app`;
// the bundle id the build was signed with (io.github.purexyz.scape2004, plus BUNDLE_ID_SUFFIX from ios/Config/Local.xcconfig)
const BUNDLE = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', `${BUILT}/Info.plist`], { encoding: 'utf8' }).trim();
const APP = `${TMP}/LostCity.app`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = `${TMP}/run-${stamp}`;
fs.mkdirSync(OUT, { recursive: true });

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const note = (msg) => {
    const line = `[drive +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`;
    console.log(line);
    fs.appendFileSync(`${OUT}/drive.log`, line + '\n');
};

// 1. Test build: built app + test pages as Game/ (keeping the built Game/ui, the fonts and sprites of the native views),
// ad-hoc re-signed.
fs.rmSync(APP, { recursive: true, force: true });
sh('ditto', [BUILT, APP]);
fs.rmSync(`${APP}/Game`, { recursive: true, force: true });
sh('ditto', [`${HERE}/game-test`, `${APP}/Game`]);
if (fs.existsSync(`${BUILT}/Game/ui`)) sh('ditto', [`${BUILT}/Game/ui`, `${APP}/Game/ui`]);
// t/big.bin: 8 MiB + 123 bytes, byte i = (i * 31 + (i >> 11)) & 255 (checked byte-for-byte by test.js)
const big = new Uint8Array(8 * 1024 * 1024 + 123);
for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 11)) & 255;
fs.writeFileSync(`${APP}/Game/t/big.bin`, big);
if (process.env.START_PHASE) fs.writeFileSync(`${APP}/Game/start-phase.txt`, process.env.START_PHASE);
const mock = await startMockClaude({ port: Number(process.env.LM_MOCK_PORT ?? 47591), slowMs: 6000 });
fs.writeFileSync(`${APP}/Game/lm-mock.txt`, mock.url);
sh('codesign', ['--force', '--sign', '-', '--timestamp=none', '--preserve-metadata=entitlements', APP]);
note(`signed ${APP}: ${sh('codesign', ['--verify', '--verbose=1', APP], { stdio: ['ignore', 'pipe', 'pipe'] }) || 'ok'}`);

// 2. Boot if needed, then a fresh install (uninstall wipes the data container: saves, WebKit
// storage, defaults).
try { sh('xcrun', ['simctl', 'boot', UDID], { stdio: 'ignore' }); } catch {}
sh('xcrun', ['simctl', 'bootstatus', UDID, '-b'], { stdio: 'ignore' });
try { sh('xcrun', ['simctl', 'terminate', UDID, BUNDLE], { stdio: 'ignore' }); } catch {}
try { sh('xcrun', ['simctl', 'uninstall', UDID, BUNDLE], { stdio: 'ignore' }); } catch {}
sh('xcrun', ['simctl', 'install', UDID, APP]);
note(`installed on ${UDID}`);

let lastTotal = null;
function killWebContent() {
    const pids = simWebContentPids().filter((p) => !before.has(p));
    note(`killing WebContent ${pids.join(',')}`);
    for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch (e) { note(`kill ${pid}: ${e.message}`); }
}
const simWebContentPids = () => {
    // Simulator processes run on the host; WebContent ones live under the simulator runtime root.
    const out = sh('ps', ['-axo', 'pid=,command=']);
    return out.split('\n').filter((l) => l.includes('com.apple.WebKit.WebContent') && l.includes('Simulator')).map((l) => Number(l.trim().split(/\s+/)[0]));
};
const before = new Set(simWebContentPids());
note(`pre-existing simulator WebContent pids: ${[...before].join(',') || 'none'}`);

// 3. Launch with console capture.
const logPath = `${OUT}/console.log`;
const log = fs.createWriteStream(logPath);
const app = spawn('xcrun', ['simctl', 'launch', '--console-pty', '--terminate-running-process', UDID, BUNDLE, '-LostCityVerbose', 'YES'], { stdio: ['ignore', 'pipe', 'pipe'] });
let buffer = '';
const queue = [];
let busy = false;
let done = false;
const screenshot = (name) => {
    sh('xcrun', ['simctl', 'io', UDID, 'screenshot', `${OUT}/${name}.png`], { stdio: 'ignore' });
    note(`screenshot ${name}.png`);
};
async function act(line) {
    let m;
    if ((m = line.match(/\bSHOT (\S+)/))) {
        screenshot(m[1]);
    } else if ((m = line.match(/\bACTION (background-cycle|background-hang)/))) {
        const seconds = m[1] === 'background-cycle' ? 5 : 12;
        note(`backgrounding (open Settings) for ${seconds} s`);
        sh('xcrun', ['simctl', 'launch', UDID, 'com.apple.Preferences']);
        await sleep(seconds * 1000);
        note('foregrounding the app');
        sh('xcrun', ['simctl', 'launch', UDID, BUNDLE]);
    } else if (line.includes('ACTION background-kill')) {
        note('backgrounding (open Settings), then killing WebContent while in the background');
        sh('xcrun', ['simctl', 'launch', UDID, 'com.apple.Preferences']);
        await sleep(2500);
        killWebContent();
        await sleep(3000);
        note('foregrounding the app');
        sh('xcrun', ['simctl', 'launch', UDID, BUNDLE]);
        await sleep(600);
        screenshot('crash-bg-restarting');
    } else if (line.includes('ACTION kill-webcontent-loop')) {
        killWebContent();
        await sleep(1500);
        screenshot('crash-loop');
        const total = lastTotal ?? 'unknown';
        note(`page finished: ${total}`);
        finish(0);
    } else if (line.includes('ACTION kill-webcontent')) {
        killWebContent();
        await sleep(700);
        screenshot('crash-restarting');
    } else if ((m = line.match(/\bDONE (pass=\d+ fail=\d+)/))) {
        note(`page finished: ${m[1]}`);
        await sleep(500);
        finish(0);
    }
}
async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) await act(queue.shift());
    busy = false;
}
const onData = (chunk) => {
    const text = chunk.toString();
    log.write(text);
    buffer += text;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, "");
        buffer = buffer.slice(i + 1);
        const total = line.match(/TOTAL (pass=\d+ fail=\d+.*)$/);
        if (total) lastTotal = total[1];
        if (/\b(SHOT|ACTION|DONE) /.test(line)) { queue.push(line); pump(); }
        if (/\b(FAIL|PASS|INFO|LIFECYCLE) /.test(line) || /\[(life|host|kbd)\]/.test(line)) process.stdout.write(line + '\n');
    }
};
app.stdout.on('data', onData);
app.stderr.on('data', onData);
app.on('exit', (code) => { note(`simctl launch exited (${code})`); if (!done) finish(1); });
// Launch appearance: a burst of screenshots over the first ~1.5 s (launch screen → black → cover).
(async () => { for (let i = 0; i < 6; i++) { await sleep(150); screenshot(`launch-${i}`); } })();

function finish(code) {
    if (done) return;
    done = true;
    const wrong = mock.requests.filter((r) => r.problems.length);
    note(`mock API: ${mock.requests.length} requests${wrong.length ? `, ${wrong.length} malformed: ${wrong.map((r) => r.problems.join('; ')).join(' | ')}` : ', all as the API takes them'}`);
    if (wrong.length) code = code || 1;
    void mock.close();
    try { sh('xcrun', ['simctl', 'terminate', UDID, BUNDLE], { stdio: 'ignore' }); } catch {}
    try { sh('xcrun', ['simctl', 'terminate', UDID, 'com.apple.Preferences'], { stdio: 'ignore' }); } catch {}
    setTimeout(() => {
        app.kill('SIGTERM');
        try {
            const container = sh('xcrun', ['simctl', 'get_app_container', UDID, BUNDLE, 'data']).trim();
            fs.cpSync(`${container}/Library/Caches/Logs`, `${OUT}/app-logs`, { recursive: true });
            note(`Documents tree:\n${sh('find', ['.'], { cwd: `${container}/Documents` })}`);
        } catch (e) { note(`could not copy container files: ${e.message}`); }
        note(`console log: ${logPath}`);
        process.exit(code);
    }, 800);
}
setTimeout(() => { note('TIMEOUT'); finish(2); }, 8 * 60 * 1000);  // (the chat model's phase adds about 30 s)
