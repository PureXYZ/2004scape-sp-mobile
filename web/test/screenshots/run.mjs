#!/usr/bin/env node
// Takes the README's screenshots (docs/images/) in the real app: a test copy of the web bundle with
// web/test/screenshots/stage.js injected logs a character in, skips the tutorial and asks for the shots, which this
// driver takes with the simulator's or the emulator's own screenshot command.
//
//   node web/test/screenshots/run.mjs --ios [--sim "LostCity Test (iPhone 13 mini)"]   # the iOS Simulator
//   node web/test/screenshots/run.mjs --android [--serial emulator-5554]               # the emulator (its data cleared)
//   options: --only pk (only the Edgeville PK shots), --no-build (reuse the last test build), --release (the iOS app's Release configuration, as
//            scripts/release.sh builds it; the page needs no debug hooks)
//
// The run installs a Debug (or Release) build with the staged bundle (with the simulator's or the emulator's app data wiped first),
// and afterwards builds the normal web bundle again (build/Game or android/build/web/Game; the staged one is marked as a
// test build, so ios/scripts/deploy.sh and android/scripts/deploy.sh rebuild it anyway). Raw shots go to
// build/tmp/screenshots/<ios|android>-<time>/ (world-*, panel-*, bots-*, pk-*); pick, scale and compress them into docs/images.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const ANDROID = flag('--android');
if (ANDROID === flag('--ios')) {
    console.error('usage: run.mjs --ios [--sim NAME] | --android [--serial SERIAL]  [--no-build]');
    process.exit(2);
}
const BUILD = !flag('--no-build');
const CONFIG = flag('--release') ? 'Release' : 'Debug';
const ONLY = option('--only', null);
const SIM_NAME = option('--sim', 'LostCity Test (iPhone 13 mini)');
const SERIAL = option('--serial', process.env.ANDROID_SERIAL ?? 'emulator-5554');
const ANDROID_HOME = process.env.ANDROID_HOME ?? path.join(process.env.HOME, 'Library', 'Android', 'sdk');
const ADB = path.join(ANDROID_HOME, 'platform-tools', 'adb');
const PKG = 'io.github.purexyz.scape2004';
const GAME = ANDROID ? path.join(ROOT, 'android', 'build', 'web', 'Game') : path.join(ROOT, 'build', 'Game');
const DERIVED = path.join(ROOT, 'build', 'DerivedData');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.join(ROOT, 'build', 'tmp', 'screenshots', `${ANDROID ? 'android' : 'ios'}-${stamp}`);
fs.mkdirSync(OUT, { recursive: true });

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
const t0 = Date.now();
const note = message => console.log(`[shots +${((Date.now() - t0) / 1000).toFixed(0)}s] ${message}`);

function buildWeb(staged) {
    const args = [path.join(ROOT, 'scripts', 'build-web.mjs'), '--skip-pack', ...(ANDROID ? ['--out', GAME] : [])];
    sh('node', args, { stdio: 'inherit' });
    if (!staged) {
        return;
    }
    fs.copyFileSync(path.join(HERE, 'stage.js'), path.join(GAME, 'lcshots.js'));
    const index = path.join(GAME, 'index.html');
    const tag = '<script src="host.js"></script>';
    const html = fs.readFileSync(index, 'utf8');
    if (!html.includes(tag)) {
        throw new Error(`${tag} not found in ${index}`);
    }
    const only = ONLY ? `<script>window.LCSHOTS_ONLY = ${JSON.stringify(ONLY)};</script>\n    ` : '';
    fs.writeFileSync(index, html.replace(tag, `${tag}\n    ${only}<script src="lcshots.js"></script>`));
    // (a test build: the deploy scripts rebuild a bundle that says so rather than install it)
    const infoFile = path.join(GAME, 'build-info.json');
    fs.writeFileSync(infoFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(infoFile, 'utf8')), autotest: true }, null, 2));
}

// ------------------------------------------------------------------------------------------------ the target

let udid = null;
let bundle = PKG;
let child = null;

function screenshot(name) {
    const file = path.join(OUT, `${name}.png`);
    if (ANDROID) {
        fs.writeFileSync(file, execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 }));
    } else {
        sh('xcrun', ['simctl', 'io', udid, 'screenshot', file], { stdio: 'ignore' });
    }
    note(`${name}.png`);
}

if (BUILD) {
    note('building the staged web bundle…');
    buildWeb(true);
}

if (ANDROID) {
    if (BUILD) {
        note('building the debug APK (without the chat model)…');
        sh(path.join(ROOT, 'android', 'gradlew'), [':app:assembleDebug', '-PnoBuildWeb', '-Plc.model=none', '-q', '--console=plain'], { cwd: path.join(ROOT, 'android'), stdio: 'inherit', env: { ...process.env, ANDROID_HOME } });
    }
    const apk = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
    sh(ADB, ['-s', SERIAL, 'install', '-r', apk], { stdio: 'inherit' });
    sh(ADB, ['-s', SERIAL, 'shell', 'pm', 'clear', PKG], { stdio: 'ignore' });
    sh(ADB, ['-s', SERIAL, 'logcat', '-c']);
    child = spawn(ADB, ['-s', SERIAL, 'logcat', '-v', 'raw', 'LostCity:V', '*:S'], { stdio: ['ignore', 'pipe', 'pipe'] });
    sh(ADB, ['-s', SERIAL, 'shell', 'am', 'start', '-W', '-S', '-n', `${PKG}/.GameActivity`], { stdio: 'ignore' });
} else {
    const devices = JSON.parse(sh('xcrun', ['simctl', 'list', 'devices', 'available', '-j'])).devices;
    udid = Object.values(devices).flat().find(d => d.name === SIM_NAME)?.udid;
    if (!udid) {
        console.error(`no available simulator named "${SIM_NAME}" (xcrun simctl list devices)`);
        process.exit(1);
    }
    if (BUILD) {
        sh(path.join(ROOT, 'ios', 'scripts', 'fetch-llama.sh'), [], { stdio: 'inherit' });
        note(`building the app (${CONFIG}, simulator)…`);
        sh('xcodebuild', ['-project', path.join(ROOT, 'ios', 'LostCity.xcodeproj'), '-scheme', 'LostCity', '-configuration', CONFIG, '-destination', `id=${udid}`, '-derivedDataPath', DERIVED, 'build', '-quiet'], { stdio: 'inherit' });
    }
    const app = path.join(DERIVED, 'Build', 'Products', `${CONFIG}-iphonesimulator`, 'LostCity.app');
    bundle = sh('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(app, 'Info.plist')]).trim();
    try {
        sh('xcrun', ['simctl', 'boot', udid], { stdio: 'ignore' });
    } catch {
        // already booted
    }
    sh('xcrun', ['simctl', 'bootstatus', udid, '-b'], { stdio: 'ignore' });
    // (the app hides the status bar; this keeps a clean one should it show)
    sh('xcrun', ['simctl', 'status_bar', udid, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100', '--cellularBars', '4', '--wifiBars', '3'], { stdio: 'ignore' });
    for (const step of [['terminate', udid, bundle], ['uninstall', udid, bundle]]) {
        try {
            sh('xcrun', ['simctl', ...step], { stdio: 'ignore' });
        } catch {
            // not running, not installed
        }
    }
    sh('xcrun', ['simctl', 'install', udid, app]);
    child = spawn('xcrun', ['simctl', 'launch', '--console-pty', '--terminate-running-process', udid, bundle], { stdio: ['ignore', 'pipe', 'pipe'] });
}
note(`running on ${ANDROID ? SERIAL : `${SIM_NAME} (${udid})`}; shots in ${path.relative(ROOT, OUT)}`);

// ------------------------------------------------------------------------------------------------ the page's requests

const log = fs.createWriteStream(path.join(OUT, 'console.log'));
let result = null;
let pending = '';
let queue = Promise.resolve();
const finished = new Promise(resolve => {
    const onData = chunk => {
        pending += chunk.toString();
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const raw of lines) {
            const line = raw.replace(/\r$/, ''); // (the simulator's console is a pty: CRLF)
            log.write(`${line}\n`);
            const m = /LCSHOTS (SHOT|INFO|DONE) ?(.*)$/.exec(line);
            if (!m) {
                continue;
            }
            if (m[1] === 'SHOT') {
                const name = m[2].trim().replace(/[^\w-]/g, '_');
                queue = queue.then(() => screenshot(name));
            } else if (m[1] === 'INFO') {
                note(m[2]);
            } else {
                result = m[2].trim();
                queue.then(() => resolve());
            }
        }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => resolve());
    setTimeout(() => {
        note('timed out after 20 min');
        resolve();
    }, 20 * 60 * 1000);
});
await finished;
child.kill('SIGTERM');
if (ANDROID) {
    sh(ADB, ['-s', SERIAL, 'shell', 'am', 'force-stop', PKG], { stdio: 'ignore' });
} else {
    try {
        sh('xcrun', ['simctl', 'terminate', udid, bundle], { stdio: 'ignore' });
    } catch {
        // already gone
    }
}
note(`done (${result ?? 'no DONE line'}); putting the normal web bundle back`);
buildWeb(false);
console.log(`\nshots: ${OUT}`);
process.exit(result === 'ok' ? 0 : 1);
