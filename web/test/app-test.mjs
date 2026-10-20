#!/usr/bin/env node
// Runs web/test/autotest.js inside the real app, on a simulator or on the iPhone, and answers its requests
// (screenshots, backgrounding the app, memory samples).
//
//   node web/test/app-test.mjs                  # simulator "LostCity Test (iPhone 13 mini)" (created if missing)
//   node web/test/app-test.mjs --device [udid]  # the connected iPhone (unlocked); leaves the TEST build installed,
//                                               # so run ios/scripts/deploy.sh afterwards to put the normal app back
//   node web/test/app-test.mjs --sim "iPad mini (A17 Pro)"  # another existing simulator, e.g. an iPad
//   options: --no-build (reuse build/Game and the last app build), --debug-web (unminified web build),
//            --keep-data (simulator: don't uninstall first),
//            --bots N (the world runs N bots: the test build's autotest.json asks autotest.js to set Settings › World ›
//            Bots to N, which restarts the page once, and the run adds the bots' checks and measurements; 0 = off;
//            a count the sheet does not offer, such as 75, works too),
//            --skip-pack (the web build skips the engine's packer, as build-web.mjs --skip-pack),
//            --lm-bench[=MIN] (the phone spike of the bots' on-device chat model, docs/ARCHITECTURE.md §7.1: with --bots 500
//            unless --bots says otherwise, after the bots' checks autotest.js runs 5 min with no generation, MIN min (20)
//            with a reply generated every 5 s and 5 min back to back, the phases scaled by MIN/20; every 10 s it logs the
//            frame rate, the engine's tick, the app's memory and heat and the generations, into lm-bench.jsonl, and ends with
//            lm-bench-summary.json and the gate's checks. Needs the model in the app: ios/scripts/prepare-model.sh --spike (or
//            <gguf>); implies --skip-pack and --profile bench; --lm-every=SEC sets the main phase's cadence, 5 s;
//            --lm-threads=N and --lm-gpuLayers=N the model's options for the run; --lm-think benches the note mode: every
//            reply written with the model's short note first, as Settings › Bot chat › Think first asks, which needs a
//            model that writes one: model.json's template qwen-chatml-hybrid or qwen-chatml-think),
//            --profile NAME (the run plays in players/NAME/ and bots/NAME/, as an earlier bench did, so the phone's own
//            characters and world, profile main, stay as they are)
//
// The run plays in the app's own Documents, profile `main` (the simulator's are wiped first unless --keep-data). So a
// --device run leaves on the iPhone: the TEST build (until ios/scripts/deploy.sh), the character "Autotest"
// (players/main/autotest.sav, in the Characters list), and with --bots N the phone's own bots store
// (bots/main/bots.sav): its bots played on during the run, and with more bots than the phone runs, records of the extra
// ones too (the bots of a later count go on from them). The Bots setting goes back to what the phone had once the run
// finishes (DONE); a run that stops before that (timeout, crash, Ctrl-C) leaves it at N: set it in Settings › World.
//
// Output: build/tmp/app-test/<sim|device>-<time>/ (console.log, screenshots, memory.txt).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IOS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_SIM = 'LostCity Test (iPhone 13 mini)';
const DERIVED = path.join(IOS, 'build', 'DerivedData');

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const onDevice = flag('--device');
const deviceArg = onDevice ? argv[argv.indexOf('--device') + 1] : undefined;
const SIM_NAME = flag('--sim') ? argv[argv.indexOf('--sim') + 1] : TEST_SIM;
const lmBenchArg = argv.find(a => a === '--lm-bench' || a.startsWith('--lm-bench='));
const LM_BENCH_MIN = lmBenchArg ? Number(lmBenchArg.split('=')[1] ?? 20) : null;
if (lmBenchArg && !(LM_BENCH_MIN > 0)) {
    console.error('--lm-bench takes the minutes of its main phase (a reply every 5 s), e.g. --lm-bench=20');
    process.exit(1);
}
// (--lm-think: the bench's replies with the model's note first, Settings › Bot chat › Think first)
const LM_THINK = flag('--lm-think');
if (LM_THINK && LM_BENCH_MIN === null) {
    console.error('--lm-think goes with --lm-bench (it benches the note mode)');
    process.exit(1);
}
const BOTS = flag('--bots') ? Number(argv[argv.indexOf('--bots') + 1]) : LM_BENCH_MIN ? 500 : null; // null: the setting stays as it is
const SKIP_PACK = flag('--skip-pack') || LM_BENCH_MIN !== null;
const PROFILE = flag('--profile') ? argv[argv.indexOf('--profile') + 1] : LM_BENCH_MIN !== null ? 'bench' : null;
if (PROFILE !== null && !/^[a-z0-9_-]{1,32}$/.test(PROFILE)) {
    console.error('--profile takes a name of lowercase letters, digits, - and _');
    process.exit(1);
}
if (BOTS !== null && !(Number.isInteger(BOTS) && BOTS >= 0)) {
    console.error('--bots takes a number of bots (0 = off)');
    process.exit(1);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.join(IOS, 'build', 'tmp', 'app-test', `${onDevice ? 'device' : 'sim'}-${stamp}`);
fs.mkdirSync(OUT, { recursive: true });

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const t0 = Date.now();
function note(message) {
    const line = `[app-test +${((Date.now() - t0) / 1000).toFixed(1)}s] ${message}`;
    console.log(line);
    fs.appendFileSync(path.join(OUT, 'driver.log'), `${line}\n`);
}

// ------------------------------------------------------------------------------------------------ target

function findPairedDevice() {
    const list = sh('xcrun', ['devicectl', 'list', 'devices']);
    for (const line of list.split('\n')) {
        if ((line.includes('available (paired)') || / connected /.test(line)) && !line.includes('simulated')) {
            const id = line.split(/\s+/).find(word => /^[0-9A-F]{8}-[0-9A-F]{16}$/.test(word));
            if (id) {
                return id;
            }
        }
    }
    return null;
}

function findOrCreateSimulator() {
    const devices = JSON.parse(sh('xcrun', ['simctl', 'list', 'devices', '-j'])).devices;
    for (const [runtime, list] of Object.entries(devices)) {
        const found = list.find(d => d.name === SIM_NAME && d.isAvailable);
        if (found) {
            return { udid: found.udid, runtime };
        }
    }
    if (SIM_NAME !== TEST_SIM) {
        throw new Error(`no available simulator named "${SIM_NAME}" (xcrun simctl list devices)`);
    }
    const runtimes = JSON.parse(sh('xcrun', ['simctl', 'list', 'runtimes', '-j'])).runtimes.filter(r => r.isAvailable && r.platform === 'iOS');
    const runtime = runtimes.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true })).at(-1);
    if (!runtime) {
        throw new Error('no iOS simulator runtime installed');
    }
    const udid = sh('xcrun', ['simctl', 'create', SIM_NAME, 'com.apple.CoreSimulator.SimDeviceType.iPhone-13-mini', runtime.identifier]).trim();
    note(`created simulator ${SIM_NAME} (${runtime.name}) ${udid}`);
    return { udid, runtime: runtime.identifier };
}

const target = onDevice ? { udid: deviceArg && !deviceArg.startsWith('--') ? deviceArg : findPairedDevice() } : findOrCreateSimulator();
if (!target.udid) {
    console.error('No paired iPhone found. Connect and unlock it, or pass --device <udid>.');
    process.exit(1);
}
note(`target: ${onDevice ? 'device' : 'simulator'} ${target.udid}`);

// ------------------------------------------------------------------------------------------------ build + install

// The bench's configuration (autotest.js lmBenchChecks): the phases, and the prompts (the engine's renderLocal of real
// reply situations: web/test/lm/render-prompts.mjs)
function lmBenchConfig() {
    const scale = LM_BENCH_MIN / 20;
    const prompts = JSON.parse(fs.readFileSync(path.join(IOS, 'web', 'test', 'lm', 'bench-prompts.json'), 'utf8')).prompts.map(p => p.local);
    const options = {};
    for (const name of ['threads', 'gpuLayers']) {
        const arg = argv.find(a => a.startsWith(`--lm-${name}=`));
        if (arg) {
            options[name] = Number(arg.split('=')[1]);
        }
    }
    const every = Number(argv.find(a => a.startsWith('--lm-every='))?.split('=')[1] ?? 5);
    return { baselineMin: 5 * scale, periodicMin: 20 * scale, periodicEverySec: every > 0 ? every : 5, burstMin: 5 * scale, sampleSec: 10, prompts, ...(Object.keys(options).length ? { options } : {}), ...(LM_THINK ? { think: true } : {}) };
}

if (LM_BENCH_MIN !== null) {
    const model = (() => {
        try {
            return JSON.parse(fs.readFileSync(path.join(IOS, 'build', 'Model', 'model.json'), 'utf8'));
        } catch {
            return null;
        }
    })();
    if (!model || !fs.existsSync(path.join(IOS, 'build', 'Model', model.file))) {
        console.error('--lm-bench needs the model in the app: run ios/scripts/prepare-model.sh --spike (or with a .gguf) first');
        process.exit(1);
    }
    if (LM_THINK && !['qwen-chatml-hybrid', 'qwen-chatml-think'].includes(model.template)) {
        console.error(`--lm-think needs a model that writes its note: build/Model/model.json's template is ${model.template ?? 'qwen-chatml-nothink'} (qwen-chatml-hybrid or qwen-chatml-think write one)`);
        process.exit(1);
    }
    note(`lm-bench: ${model.name} (${Math.round(model.bytes / 1048576)} MB, template ${model.template ?? 'qwen-chatml-nothink'}), main phase ${LM_BENCH_MIN} min${LM_THINK ? ', every reply with its note first (--lm-think)' : ''}`);
}

if (!flag('--no-build')) {
    note('building web (autotest)…');
    sh('node', [path.join(IOS, 'scripts', 'build-web.mjs'), '--autotest', ...(flag('--debug-web') ? ['--debug'] : []), ...(SKIP_PACK ? ['--skip-pack'] : [])], { stdio: 'inherit' });
    if (BOTS !== null || LM_BENCH_MIN !== null) {
        // what autotest.js reads (the test build only: build/Game is rebuilt without it when the run ends)
        const config = { ...(BOTS !== null ? { bots: BOTS } : {}), ...(LM_BENCH_MIN !== null ? { lmBench: lmBenchConfig() } : {}) };
        fs.writeFileSync(path.join(IOS, 'build', 'Game', 'autotest.json'), `${JSON.stringify(config)}\n`);
        note(`autotest.json: ${BOTS ?? 'the phone\'s'} bots${LM_BENCH_MIN !== null ? `, lm-bench ${JSON.stringify({ ...config.lmBench, prompts: config.lmBench.prompts.length })}` : ''}`);
    }
    if (PROFILE !== null) {
        // the save profile, before host.js reads it (host.js PROFILE)
        const index = path.join(IOS, 'build', 'Game', 'index.html');
        const tag = '<script src="host.js"></script>';
        fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace(tag, `<script>window.__lcTestProfile = ${JSON.stringify(PROFILE)};</script>\n    ${tag}`));
        note(`the run plays in the save profile ${PROFILE} (players/${PROFILE}/, bots/${PROFILE}/)`);
    }
    // llama.cpp's framework (the bots' on-device chat model) and the model folder, which the app links and bundles
    sh(path.join(IOS, 'ios', 'scripts', 'fetch-llama.sh'), [], { stdio: 'inherit' });
    note('building app…');
    sh('xcodebuild', [
        '-project', path.join(IOS, 'ios', 'LostCity.xcodeproj'), '-scheme', 'LostCity', '-configuration', 'Debug',
        // (a device build by id needs the phone unlocked; a generic one doesn't)
        '-destination', onDevice ? 'generic/platform=iOS' : `id=${target.udid}`, '-derivedDataPath', DERIVED, ...(onDevice ? ['-allowProvisioningUpdates'] : []),
        'build', '-quiet'
    ], { stdio: 'inherit' });
}
const APP = path.join(DERIVED, 'Build', 'Products', onDevice ? 'Debug-iphoneos' : 'Debug-iphonesimulator', 'LostCity.app');
if (!fs.existsSync(path.join(APP, 'Game', 'autotest.js'))) {
    console.error(`${APP} has no Game/autotest.js; build without --no-build first`);
    process.exit(1);
}
// the bundle id the build was signed with (io.github.purexyz.scape2004, plus BUNDLE_ID_SUFFIX from ios/Config/Local.xcconfig)
const BUNDLE = sh('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(APP, 'Info.plist')]).trim();
// (--no-build: the app asks for the bots its build was made with)
const builtBots = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP, 'Game', 'autotest.json'), 'utf8')).bots ?? null;
    } catch {
        return null;
    }
})();
if (builtBots !== BOTS) {
    console.error(`${APP} was built ${builtBots === null ? 'without --bots' : `with --bots ${builtBots}`}; build it again (without --no-build) for ${BOTS === null ? 'no --bots' : `--bots ${BOTS}`}`);
    process.exit(1);
}

let webContentBefore = new Set();
const simWebContentPids = () =>
    sh('ps', ['-axo', 'pid=,command='])
        .split('\n')
        .filter(line => line.includes('com.apple.WebKit.WebContent') && line.includes('Simulator'))
        .map(line => Number(line.trim().split(/\s+/)[0]));

async function waitForUnlock() {
    const locked = () => {
        try {
            const reply = JSON.parse(sh('xcrun', ['devicectl', 'device', 'info', 'lockState', '--device', target.udid, '-j', '-'], { stdio: ['ignore', 'pipe', 'ignore'] }));
            return reply.result?.passcodeRequired === true;
        } catch {
            return true;
        }
    };
    if (!locked()) {
        return;
    }
    note('the iPhone is locked: unlock it (and keep it unlocked) to continue…');
    const deadline = Date.now() + 15 * 60 * 1000;
    while (locked()) {
        if (Date.now() > deadline) {
            console.error('Gave up waiting for the iPhone to be unlocked.');
            process.exit(1);
        }
        await sleep(2000);
    }
    note('unlocked');
}

if (onDevice) {
    await waitForUnlock();
    note('installing on the iPhone…');
    sh('xcrun', ['devicectl', 'device', 'install', 'app', '--device', target.udid, APP], { stdio: 'inherit' });
} else {
    try {
        sh('xcrun', ['simctl', 'boot', target.udid], { stdio: 'ignore' });
    } catch {
        // already booted
    }
    sh('xcrun', ['simctl', 'bootstatus', target.udid, '-b'], { stdio: 'ignore' });
    try {
        sh('xcrun', ['simctl', 'terminate', target.udid, BUNDLE], { stdio: 'ignore' });
    } catch {
        // not running
    }
    if (!flag('--keep-data')) {
        try {
            sh('xcrun', ['simctl', 'uninstall', target.udid, BUNDLE], { stdio: 'ignore' });
        } catch {
            // not installed
        }
    }
    sh('xcrun', ['simctl', 'install', target.udid, APP]);
    note('installed on the simulator');
    // WebContent processes of the simulator's other clients (none, usually) are not ours.
    webContentBefore = new Set(simWebContentPids());
}

// ------------------------------------------------------------------------------------------------ actions

function screenshot(name) {
    const file = path.join(OUT, `${name}.png`);
    try {
        if (onDevice) {
            sh('xcrun', ['devicectl', 'device', 'capture', 'screenshot', '--device', target.udid, '--destination', file, '--quiet'], { stdio: 'ignore' });
        } else {
            sh('xcrun', ['simctl', 'io', target.udid, 'screenshot', file], { stdio: 'ignore' });
        }
        note(`screenshot ${name}.png`);
    } catch (error) {
        note(`screenshot ${name} failed: ${error.message.split('\n')[0]}`);
    }
}

function launchOther(bundle) {
    if (onDevice) {
        sh('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', target.udid, bundle, '--quiet'], { stdio: 'ignore' });
    } else {
        sh('xcrun', ['simctl', 'launch', target.udid, bundle], { stdio: 'ignore' });
    }
}

function measure(label) {
    const lines = [`== ${label} (+${((Date.now() - t0) / 1000).toFixed(0)} s)`];
    if (onDevice) {
        lines.push('(device: use Xcode › Debug Navigator or Instruments for memory; not sampled here)');
    } else {
        for (const pid of simWebContentPids().filter(p => !webContentBefore.has(p))) {
            let footprint = '';
            try {
                footprint = sh('footprint', ['-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] })
                    .split('\n')
                    .filter(l => /phys_footprint|Footprint|TOTAL/i.test(l))
                    .slice(0, 3)
                    .join(' | ');
            } catch {
                footprint = '(footprint unavailable)';
            }
            const rss = sh('ps', ['-o', 'rss=', '-p', String(pid)]).trim();
            lines.push(`WebContent ${pid}: rss ${(Number(rss) / 1024).toFixed(0)} MB ${footprint}`);
        }
    }
    note(lines.join('\n  '));
    fs.appendFileSync(path.join(OUT, 'memory.txt'), `${lines.join('\n')}\n`);
}

// A first install from a free (Personal Team) developer account will not launch until its developer is trusted once
// on the phone; probe with a suspended launch and wait for that (or for an unlock, if the phone locked meanwhile).
async function waitUntilLaunchable() {
    const deadline = Date.now() + 15 * 60 * 1000;
    let lastProblem = '';
    for (;;) {
        try {
            sh('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', target.udid, '--terminate-existing', '--start-stopped', BUNDLE, '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
            if (lastProblem) {
                note('the app launches now');
            }
            return;
        } catch (error) {
            const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
            const problem = /explicitly trusted|invalid code signature/.test(text)
                ? 'iOS has not trusted this developer yet: on the iPhone open Settings › General › VPN & Device Management, tap the "Apple Development" profile, then Trust. Waiting…'
                : /locked/i.test(text)
                  ? 'the iPhone is locked: unlock it to continue…'
                  : `launch failed: ${text.split('\n').find(l => l.trim()) ?? error.message}`;
            if (problem !== lastProblem) {
                note(problem);
                lastProblem = problem;
            }
            if (Date.now() > deadline) {
                console.error('Gave up waiting for the app to become launchable.');
                process.exit(1);
            }
            await sleep(4000);
        }
    }
}

if (onDevice) {
    await waitUntilLaunchable();
}

// ------------------------------------------------------------------------------------------------ run

const consoleLog = fs.createWriteStream(path.join(OUT, 'console.log'));
const launchArgs = onDevice
    ? ['devicectl', 'device', 'process', 'launch', '--device', target.udid, '--terminate-existing', '--console', BUNDLE]
    : ['simctl', 'launch', '--console-pty', '--terminate-running-process', target.udid, BUNDLE];
note(`launching: xcrun ${launchArgs.join(' ')}`);
const app = spawn('xcrun', launchArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
const launchedAt = Date.now();

let summary = null;
let finished = false;
const queue = [];
let busy = false;
let terminations = 0; // (the native log's "WebContent process terminated")

async function act(line) {
    let m;
    if ((m = line.match(/LCTEST SHOT (\S+)/))) {
        screenshot(m[1]);
    } else if ((m = line.match(/LCTEST ACTION background (\d+)/))) {
        const seconds = Number(m[1]);
        note(`backgrounding the app (Settings) for ${seconds} s`);
        launchOther('com.apple.Preferences');
        await sleep(seconds * 1000);
        note('bringing the app back');
        launchOther(BUNDLE);
    } else if ((m = line.match(/LCTEST ACTION measure (\S+)/))) {
        measure(m[1]);
    } else if ((m = line.match(/LCTEST DONE (pass=\d+ fail=\d+)/))) {
        summary = m[1];
        await sleep(500);
        finish();
    }
}

async function pump() {
    if (busy) {
        return;
    }
    busy = true;
    while (queue.length) {
        await act(queue.shift());
    }
    busy = false;
}

let pending = '';
function onData(chunk) {
    const text = chunk.toString();
    consoleLog.write(text);
    pending += text;
    let i;
    while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i).replace(/\r$/, '');
        pending = pending.slice(i + 1);
        if (/LCTEST (SHOT|ACTION|DONE) /.test(line)) {
            queue.push(line);
            void pump();
        }
        let m;
        if ((m = line.match(/LCTEST INFO lm-bench (\{.*\})\s*$/))) {
            fs.appendFileSync(path.join(OUT, 'lm-bench.jsonl'), `${m[1]}\n`);
        } else if ((m = line.match(/LCTEST INFO lm-bench-summary (\{.*\})\s*$/))) {
            try {
                fs.writeFileSync(path.join(OUT, 'lm-bench-summary.json'), `${JSON.stringify(JSON.parse(m[1]), null, 2)}\n`);
            } catch {
                fs.writeFileSync(path.join(OUT, 'lm-bench-summary.json'), m[1]);
            }
        }
        if (/WebContent process terminated/.test(line)) {
            terminations++;
            note(`WebContent terminated (${terminations}): ${line.trim()}`);
        }
        if (/\[lm\]/.test(line) && LM_BENCH_MIN !== null) {
            fs.appendFileSync(path.join(OUT, 'lm-native.log'), `${line}\n`);
        }
        if (/LCTEST (PASS|FAIL|INFO|DONE)/.test(line) || /\b(error|fatal|exception)\b/i.test(line)) {
            process.stdout.write(`${line}\n`);
        }
    }
}
app.stdout.on('data', onData);
app.stderr.on('data', onData);
app.on('exit', code => {
    note(`launcher exited (${code})`);
    if (!finished) {
        finish(true);
    }
});

// Launch frames (launch screen → loading overlay → title).
void (async () => {
    for (const ms of [1500, 4000, 9000]) {
        await sleep(Math.max(0, launchedAt + ms - Date.now()));
        if (!finished) {
            screenshot(`launch-${ms}`);
        }
    }
})();

function finish(crashed = false) {
    if (finished) {
        return;
    }
    finished = true;
    try {
        if (onDevice) {
            // (the test build stays installed until ios/scripts/deploy.sh replaces it; send it to the background)
            sh('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', target.udid, 'com.apple.Preferences', '--quiet'], { stdio: 'ignore' });
        } else {
            sh('xcrun', ['simctl', 'terminate', target.udid, BUNDLE], { stdio: 'ignore' });
        }
    } catch {
        // ignore
    }
    setTimeout(() => {
        app.kill('SIGTERM');
        if (!onDevice) {
            try {
                const container = sh('xcrun', ['simctl', 'get_app_container', target.udid, BUNDLE, 'data']).trim();
                note(`Documents:\n${sh('find', ['.', '-type', 'f'], { cwd: path.join(container, 'Documents') })}`);
            } catch (error) {
                note(`could not list the container: ${error.message.split('\n')[0]}`);
            }
        }
        // Put the normal web bundle back so Xcode / deploy.sh never pick up the self-playing variant.
        try {
            sh('node', [path.join(IOS, 'scripts', 'build-web.mjs'), '--skip-pack'], { stdio: 'ignore' });
            note('build/Game restored to the normal (non-autotest) bundle');
        } catch (error) {
            note(`could not restore build/Game: ${error.message.split('\n')[0]} — run node scripts/build-web.mjs`);
        }
        if (onDevice) {
            note('the iPhone still has the TEST app installed: run ios/scripts/deploy.sh to put the normal app back');
        }
        if (terminations) {
            note(`WebContent terminations during the run: ${terminations}`);
        }
        note(`result: ${summary ?? (crashed ? 'app exited before the test finished' : 'timeout')} — ${OUT}`);
        const failed = !summary || !summary.endsWith('fail=0');
        process.exit(failed ? 1 : 0);
    }, 1500);
}

process.on('SIGINT', () => finish(true));
// (with bots: a restart to apply the setting, waiting for them, measuring; the lm-bench: its phases)
const TIMEOUT_MIN = (BOTS > 0 ? 12 : 8) + (LM_BENCH_MIN !== null ? (30 * LM_BENCH_MIN) / 20 + 10 : 0);
setTimeout(() => {
    note(`TIMEOUT (${TIMEOUT_MIN} min)`);
    finish(true);
}, TIMEOUT_MIN * 60 * 1000);
