#!/usr/bin/env node
// Real hardware-keyboard check: Simulator.app (hardware keyboard connected) + System Events
// keystrokes. Run after drive.mjs (reuses the installed app; sets the page phase to 'hwkeys').
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';

const TMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'build', 'tmp', 'swift');
const UDID = process.env.UDID ?? fs.readFileSync(`${TMP}/sim-udid.txt`, 'utf8').trim();
// the app drive.mjs installed, and its bundle id
const BUNDLE = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', `${TMP}/LostCity.app/Info.plist`], { encoding: 'utf8' }).trim();
const OUT = `${TMP}/run-hw-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
fs.mkdirSync(OUT, { recursive: true });
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const osa = (lines) => sh('osascript', lines.flatMap((l) => ['-e', l]));
const type = (steps) => osa(['tell application "DeviceHub" to activate', 'delay 1.0', 'tell application "System Events"',
    ...steps.flatMap((s) => [typeof s === 'number' ? `key code ${s}` : `keystroke "${s}"`, 'delay 0.2']), 'end tell']);

try { sh('xcrun', ['simctl', 'boot', UDID]); } catch {}  // quitting DeviceHub shuts the device down
sh('xcrun', ['simctl', 'bootstatus', UDID, '-b']);
sh('open', ['-a', '/Applications/Xcode.app/Contents/Applications/DeviceHub.app']);  // Xcode 27's simulator UI
await sleep(2000);
osa(['tell application "DeviceHub" to activate']);  // key window must be the device view before typing
await sleep(3000);
// The page left by drive.mjs is in phase 'done', which switches itself to 'hwkeys' on launch.
try { sh('xcrun', ['simctl', 'terminate', UDID, BUNDLE]); } catch {}
const app = spawn('xcrun', ['simctl', 'launch', '--console-pty', UDID, BUNDLE, '-LostCityVerbose', 'YES'], { stdio: ['ignore', 'pipe', 'pipe'] });
const log = fs.createWriteStream(`${OUT}/console.log`);
let buf = '';
let finished = false;
let sawControl = false;
const handle = async (line) => {
    if (line.includes('pressKey Control down')) sawControl = true;
    if (line.includes('HWKEYS idle')) {
        // A freshly opened DeviceHub needs a moment before it forwards keys: tap Control (harmless
        // to the checks) until the app reports it, then type for real.
        for (let i = 0; i < 25 && !sawControl; i++) {
            osa(['tell application "DeviceHub" to activate', 'delay 0.3', 'tell application "System Events" to key code 59']);
            await sleep(700);
        }
        console.log(`DeviceHub forwarding keys: ${sawControl}`);
        console.log('typing (idle): a b ← Esc F1 ⌫ ↩ ⇥');
        type(['a', 'b', 123, 53, 122, 51, 36, 48]);
    } else if (line.includes('HWKEYS shown')) {
        console.log('typing (shown): c d ⌫ ↩');
        type(['c', 'd', 51, 36]);
    } else if (/SHOT (\S+)/.test(line)) {
        const name = line.match(/SHOT (\S+)/)[1];
        sh('xcrun', ['simctl', 'io', UDID, 'screenshot', `${OUT}/${name}.png`]);
        console.log(`screenshot ${name}`);
    } else if (line.includes('DONE ')) {
        finished = true;
        setTimeout(() => { try { sh('xcrun', ['simctl', 'terminate', UDID, BUNDLE]); } catch {} app.kill(); process.exit(0); }, 500);
    }
};
const onData = (d) => {
    log.write(d);
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        if (/PASS|FAIL|INFO|HWKEYS|SHOT|DONE|\[kbd\]/.test(line)) console.log(line);
        handle(line);
    }
};
app.stdout.on('data', onData);
app.stderr.on('data', onData);
setTimeout(() => { if (!finished) { console.log('TIMEOUT'); try { sh('xcrun', ['simctl', 'terminate', UDID, BUNDLE]); } catch {} app.kill(); process.exit(2); } }, 120000);
