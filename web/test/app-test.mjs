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
//            characters and world, profile main, stay as they are),
//            --soak NAME|FILE (a performance soak instead of the checks after the login: web/test/perf/NAME.json or a file
//            of that shape; docs/BUILDING.md §4 "A/B on the phone"). The soak goes to the app at launch (the DEBUG builds'
//            -LostCityTest argument), so --no-build runs any soak on the last test build; it implies --profile bench and
//            --skip-pack, and --bots N sets the soak's count. Each phase is measured from inside the page and recorded
//            from outside: on the iPhone with xctrace (the phase's `traces`: am = Activity Monitor + Core Animation FPS +
//            Thermal State, tp = + Time Profiler, gpu = + GPU, tpo = the Time Profiler template alone; --no-trace: none;
//            a soak with "xctrace": false, as at 500+ bots where Instruments disconnects, records only with --trace),
//            on a simulator by sampling its processes' CPU time and footprint. A soak with startup.launches N launches the
//            app until N clean launches have reported their start-up marks (startup.trace 'am': each launch recorded on
//            the iPhone). Output beside the console log: soak.jsonl, soak-raw.jsonl, startup.jsonl, traces/ or samples/,
//            and summary.json + summary.txt (web/test/perf/summary.mjs; --no-summary: not made),
//            --build-only (build the test app and stop: the runs after it take --no-build),
//            --server <url> (online mode, docs/ONLINE.md: instead of the offline checks the run adds that server through the
//            Add server box and its probe, plays there (a password login with Remember, Continue as from the Keychain, a
//            walk, a banker's dialogue and the bank), backgrounds the app 5, 25, 45 and 70 s around the server's 30 and 60 s
//            limits, kills WebContent and logs in again, switches to the world on the phone and back; never an official
//            server), --engine <dir> (with --server http://127.0.0.1:<port>: the run starts and stops a local Engine-TS
//            itself, web/test/online/engine.mjs: the copy in <dir> on <port>, its management port +1 and node port +2; then
//            also the server stopped (the unreachable box, Play offline) and a content-drift copy (drift.mjs, <dir>-drift)
//            on <port> +3: its files fetched and cached, and taken from the cache at the next launch),
//            --engine-node <dir> (a folder with the Node 24 the engine's worker threads need, as e2e.mjs --engine-node)
//
// The run plays in the app's own Documents, profile `main` (the simulator's are wiped first unless --keep-data). So a
// --device run leaves on the iPhone: the TEST build (until ios/scripts/deploy.sh), the character "Autotest"
// (players/main/autotest.sav, in the Characters list), and with --bots N the phone's own bots store
// (bots/main/bots.sav): its bots played on during the run, and with more bots than the phone runs, records of the extra
// ones too (the bots of a later count go on from them). The Bots setting goes back to what the phone had once the run
// finishes (DONE); a run that stops before that (timeout, crash, Ctrl-C) leaves it at N: set it in Settings › World.
//
// Output: build/tmp/app-test/<sim|device>-<time>/ (console.log, screenshots, memory.txt, result.json).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTENT_DIR } from '../../scripts/lib/upstream.mjs';
import { prepareDrift } from './online/drift.mjs';
import { prepareEngine, startEngine } from './online/engine.mjs';
import { SoakLines, launchTestArg, lmPrompts, loadSoak, soakBuildProblem, soakTimeoutMin } from './perf/soak.mjs';

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
// (--soak: the soak's phases; its bots from --bots or the soak)
const SOAK = flag('--soak') ? soakOrExit(() => loadSoak(argv[argv.indexOf('--soak') + 1], { bots: flag('--bots') ? BOTS : undefined })) : null;
const SKIP_PACK = flag('--skip-pack') || LM_BENCH_MIN !== null || SOAK !== null;
const PROFILE = flag('--profile') ? argv[argv.indexOf('--profile') + 1] : LM_BENCH_MIN !== null || SOAK ? 'bench' : null;
// (xctrace on the iPhone, unless --no-trace or the soak says it cannot record there and --trace does not insist)
const TRACE = SOAK !== null && onDevice && !flag('--no-trace') && (SOAK.xctrace !== false || flag('--trace'));
if (PROFILE !== null && !/^[a-z0-9_-]{1,32}$/.test(PROFILE)) {
    console.error('--profile takes a name of lowercase letters, digits, - and _');
    process.exit(1);
}
if (BOTS !== null && !(Number.isInteger(BOTS) && BOTS >= 0)) {
    console.error('--bots takes a number of bots (0 = off)');
    process.exit(1);
}
function soakOrExit(load) {
    try {
        return load();
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
// (online mode: the server, and the local engine the run controls; the passwords it types, for the logs' check)
const SERVER = flag('--server') ? argv[argv.indexOf('--server') + 1] : null;
const ENGINE_DIR = flag('--engine') ? path.resolve(argv[argv.indexOf('--engine') + 1]) : null;
const ENGINE_NODE = flag('--engine-node') ? path.resolve(argv[argv.indexOf('--engine-node') + 1]) : null;
const serverPort = SERVER ? Number(/^http:\/\/127\.0\.0\.1:(\d+)\/?$/.exec(SERVER)?.[1] ?? 0) : 0;
if (SERVER && (BOTS !== null || SOAK || LM_BENCH_MIN !== null || PROFILE !== null)) {
    console.error('--server runs the online checks alone (no --bots, --soak, --lm-bench or --profile)');
    process.exit(1);
}
if (ENGINE_DIR && !(serverPort > 0 && serverPort < 65532)) {
    console.error('--engine takes --server http://127.0.0.1:<port> (the engine on <port>, management +1, node +2, the drift copy +3)');
    process.exit(1);
}
if (ENGINE_DIR && onDevice) {
    console.error('--engine runs on a simulator (the iPhone cannot reach 127.0.0.1): give the device --server with the Mac\'s address');
    process.exit(1);
}
const ONLINE = SERVER ? { url: SERVER.replace(/\/$/, ''), drift: ENGINE_DIR ? `http://127.0.0.1:${serverPort + 3}` : null, control: !!ENGINE_DIR, passwords: [`pw${stamp.replace(/\D/g, '').slice(-6)}`, `dr${stamp.replace(/\D/g, '').slice(-6)}`] } : null;
const OUT = path.join(IOS, 'build', 'tmp', 'app-test', `${onDevice ? 'device' : 'sim'}-${stamp}${SOAK ? `-${SOAK.name}` : ''}${ONLINE ? '-online' : ''}`);
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

// --engine: the engine's copy and the drift copy (made once; the drift's moved files go to autotest.json for its checks)
if (ENGINE_DIR) {
    prepareEngine(ENGINE_DIR, path.dirname(CONTENT_DIR));
    const drift = prepareDrift({ dir: `${ENGINE_DIR}-drift`, from: ENGINE_DIR, nodeBin: ENGINE_NODE });
    ONLINE.driftFiles = { anims: drift.anims, map: drift.map };
}

if (!flag('--no-build')) {
    note('building web (autotest)…');
    sh('node', [path.join(IOS, 'scripts', 'build-web.mjs'), '--autotest', ...(flag('--debug-web') ? ['--debug'] : []), ...(SKIP_PACK ? ['--skip-pack'] : [])], { stdio: 'inherit' });
    if (BOTS !== null || LM_BENCH_MIN !== null || SOAK || ONLINE) {
        // what autotest.js reads (the test build only: build/Game is rebuilt without it when the run ends); a soak build
        // has the chat model's prompts, for any soak's lm phase (the soak itself comes at launch). A soak's bots are the
        // soak's: autotest.json's count only says what --no-build runs without --soak ask for.
        const config = { ...(BOTS !== null && !SOAK ? { bots: BOTS } : {}), ...(LM_BENCH_MIN !== null ? { lmBench: lmBenchConfig() } : {}), ...(SOAK ? { lmPrompts: lmPrompts(IOS) } : {}), ...(ONLINE ? { online: ONLINE } : {}) };
        fs.writeFileSync(path.join(IOS, 'build', 'Game', 'autotest.json'), `${JSON.stringify(config)}\n`);
        note(`autotest.json: ${ONLINE ? `online, ${ONLINE.url}${ONLINE.control ? ` (and the drift copy on ${ONLINE.drift})` : ''}` : SOAK ? `the soak's ${SOAK.bots} bots, the chat model's prompts` : `${BOTS ?? 'the phone\'s'} bots`}${LM_BENCH_MIN !== null ? `, lm-bench ${JSON.stringify({ ...config.lmBench, prompts: config.lmBench.prompts.length })}` : ''}`);
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
if (flag('--build-only')) {
    // (the Xcode build alone, e.g. under a lock on a shared Mac; the runs then take --no-build)
    sh('node', [path.join(IOS, 'scripts', 'build-web.mjs'), '--skip-pack'], { stdio: 'ignore' });
    note(`built ${APP}; build/Game is the normal bundle again. Run with --no-build (and the same --soak or --bots) to use it`);
    process.exit(0);
}
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
// (--no-build online: the build's server is what this run's must be; the run's passwords are the build's)
const builtOnline = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP, 'Game', 'autotest.json'), 'utf8')).online ?? null;
    } catch {
        return null;
    }
})();
if (ONLINE && (builtOnline?.url !== ONLINE.url || builtOnline?.drift !== ONLINE.drift || JSON.stringify(builtOnline?.driftFiles) !== JSON.stringify(ONLINE.driftFiles))) {
    console.error(`${APP} was built ${builtOnline ? `for --server ${builtOnline.url}${builtOnline.control ? ' with --engine' : ''}` : 'without --server'}; build it again (without --no-build)`);
    process.exit(1);
}
if (ONLINE) {
    ONLINE.passwords = builtOnline.passwords;
} else if (builtOnline) {
    console.error(`${APP} was built for --server ${builtOnline.url}; build it again (without --no-build) for the offline run`);
    process.exit(1);
}
if (!SOAK && builtBots !== BOTS) {
    console.error(`${APP} was built ${builtBots === null ? 'without --bots' : `with --bots ${builtBots}`}; build it again (without --no-build) for ${BOTS === null ? 'no --bots' : `--bots ${BOTS}`}`);
    process.exit(1);
}
if (SOAK) {
    // (the soak comes at launch; what it needs of the build: the save profile, the prompts for an lm phase)
    const read = file => (fs.existsSync(path.join(APP, 'Game', file)) ? fs.readFileSync(path.join(APP, 'Game', file), 'utf8') : null);
    const problem = soakBuildProblem({ index: read('index.html'), autotest: read('autotest.json') }, SOAK, PROFILE);
    if (problem) {
        console.error(`${APP}: ${problem}; build it again (without --no-build) with --soak`);
        process.exit(1);
    }
}

let webContentBefore = new Set();
let webKitBefore = new Set();
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
    // WebContent (and other WebKit) processes of the simulator's other clients (none, usually) are not ours.
    webContentBefore = new Set(simWebContentPids());
    webKitBefore = new Set(simProcesses().filter(p => p.role !== 'app').map(p => p.pid));
}

// ------------------------------------------------------------------------------------------------ online: the engine

// --engine: the local Engine-TS the run starts, stops (ACTION server stop) and swaps for its drift copy (ACTION server
// start drift: on the --server port +3, with the same management and node ports, as only one runs at a time)
let engine = null;

async function startServer(variant) {
    await stopServer();
    const drift = variant === 'drift';
    const dir = drift ? prepareDrift({ dir: `${ENGINE_DIR}-drift`, from: ENGINE_DIR, nodeBin: ENGINE_NODE }).engine : path.join(ENGINE_DIR, 'engine');
    const log = fs.createWriteStream(path.join(OUT, `engine-${variant}.log`), { flags: 'a' });
    engine = await startEngine({ dir, ports: { web: serverPort + (drift ? 3 : 0), management: serverPort + 1, node: serverPort + 2 }, nodeBin: ENGINE_NODE, log: line => log.write(`${line}\n`) });
    note(`engine ${variant} up on ${engine.url} in ${engine.started} ms`);
}

async function stopServer() {
    if (engine) {
        await engine.stop();
        note(`engine ${engine.url} stopped`);
        engine = null;
    }
}

function killWebContent() {
    const pids = simWebContentPids().filter(pid => !webContentBefore.has(pid));
    note(`killing WebContent ${pids.join(', ') || '(none found)'}`);
    for (const pid of pids) {
        try {
            process.kill(pid, 'SIGKILL');
        } catch (error) {
            note(`kill ${pid}: ${error.message}`);
        }
    }
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

// ---- a soak's windows (ACTION soak <name> <seconds> <set>), one after another
// On the iPhone each is an xctrace recording of every process (kperf allows one session at a time: a request made while
// one runs waits for it; one that could only start well after its phase asked, more than 30 s, is skipped). On a
// simulator the app's processes (the app, and the WebKit processes the simulator started for it) are sampled at the
// window's start and end: their CPU time (ps) and footprint (footprint), which have no device meaning but check the run.
const TRACE_SETS = {
    am: ['Core Animation FPS', 'Thermal State'],
    tp: ['Time Profiler', 'Core Animation FPS', 'Thermal State'],
    gpu: ['GPU', 'Core Animation FPS', 'Thermal State'],
    disk: ['Disk Usage', 'Core Animation FPS', 'Thermal State'],
    full: ['Power Profiler', 'Time Profiler', 'Core Animation FPS', 'Thermal State', 'Disk Usage', 'GPU'],
    // (the Time Profiler template alone: no Activity Monitor, whose device-side sampling stalls with a big WebContent)
    tpo: { template: 'Time Profiler', instruments: [] }
};
const recordings = new Set();
let recordChain = Promise.resolve();

function record(name, seconds, set, { onRecording } = {}) {
    const requestedAt = Date.now();
    const done = (recordChain = recordChain.then(() => (onDevice ? traceWindow(name, seconds, set, requestedAt, onRecording) : sampleWindow(name, seconds, set, requestedAt))));
    recordings.add(done);
    void done.then(() => recordings.delete(done));
    return done;
}

function traceWindow(name, seconds, set, requestedAt, onRecording) {
    const dir = path.join(OUT, 'traces');
    fs.mkdirSync(dir, { recursive: true });
    const log = entry => fs.appendFileSync(path.join(dir, 'traces.jsonl'), `${JSON.stringify(entry)}\n`);
    if (!TRACE) {
        return Promise.resolve();
    }
    if (Date.now() - requestedAt > 30000) {
        // (a recording that would start well after its phase asked for it would measure the next phase)
        note(`trace ${name} (${set}): SKIPPED, the one before it was still being saved ${((Date.now() - requestedAt) / 1000).toFixed(1)} s after the request`);
        log({ name, set, seconds, skipped: true, requestedAt, at: Date.now() });
        onRecording?.(); // (a launch waiting for it goes ahead without, as when a recording cannot start)
        return Promise.resolve();
    }
    const spec = TRACE_SETS[set] ?? TRACE_SETS.am;
    const instruments = Array.isArray(spec) ? spec : spec.instruments;
    const template = Array.isArray(spec) ? 'Activity Monitor' : spec.template;
    const args = ['xctrace', 'record', '--device', target.udid, '--template', template, ...instruments.flatMap(i => ['--instrument', i]), '--all-processes', '--time-limit', `${seconds}s`, '--no-prompt', '--output', path.join(dir, `${name}.trace`)];
    return new Promise(resolve => {
        const out = fs.createWriteStream(path.join(dir, `${name}.log`));
        // (xctrace waits "for the device to boot" while CoreDevice's tunnel is down (devicectl: "available (paired)");
        // any devicectl request brings it up: one now, and one every 4 s while recording)
        const ping = () => spawn('xcrun', ['devicectl', 'device', 'info', 'lockState', '--device', target.udid, '--quiet'], { stdio: 'ignore' });
        try {
            sh('xcrun', ['devicectl', 'device', 'info', 'lockState', '--device', target.udid, '--quiet'], { stdio: 'ignore', timeout: 20000 });
        } catch {
            // the recording says whether it could start
        }
        const keepAlive = setInterval(ping, 4000);
        const startedAt = Date.now();
        let recordingAt = null;
        let endedAt = null;
        const child = spawn('xcrun', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const onOut = chunk => {
            out.write(chunk);
            const text = chunk.toString();
            if (recordingAt === null && /Ctrl-C to stop|Starting recording/.test(text)) {
                recordingAt = Date.now();
                onRecording?.();
            }
            if (endedAt === null && /Reached specified time limit|ending recording/i.test(text)) {
                endedAt = Date.now();
            }
        };
        child.stdout.on('data', onOut);
        child.stderr.on('data', onOut);
        note(`trace ${name} (${set}): ${seconds} s, ${((startedAt - requestedAt) / 1000).toFixed(1)} s after the request`);
        // (a recording sometimes never finishes ending on the device: Ctrl-C it 25 s after its time limit, kill it later)
        let hung = null;
        const interrupt = setTimeout(() => {
            hung = 'interrupted';
            note(`trace ${name}: still not saved 25 s after its time limit; interrupting`);
            child.kill('SIGINT');
        }, (seconds + 30) * 1000);
        const kill = setTimeout(() => {
            hung = 'killed';
            note(`trace ${name}: still running; killed`);
            child.kill('SIGKILL');
        }, (seconds + 90) * 1000);
        child.on('exit', code => {
            clearInterval(keepAlive);
            clearTimeout(interrupt);
            clearTimeout(kill);
            if (recordingAt === null) {
                onRecording?.(); // (a launch waiting for it goes ahead without)
            }
            log({ name, set, seconds, code, hung, requestedAt, startedAt, recordingAt, endedAt, exitedAt: Date.now() });
            note(`trace ${name}: xctrace exited ${code} after ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
            resolve();
        });
    });
}

/**
 * This simulator's processes for the app: the app, and the WebKit processes its launchd_sim (the one whose bootstrap
 * names this device) started since the install; another booted simulator's are not ours.
 */
function simProcesses() {
    const rows = sh('ps', ['-axo', 'pid=,ppid=,command='])
        .split('\n')
        .map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
        .filter(Boolean)
        .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
    const launchd = rows.find(r => r.command.startsWith('launchd_sim') && r.command.includes(`/${target.udid}/`))?.pid;
    const list = [];
    for (const { pid, ppid, command } of rows) {
        if (command.includes(`/${target.udid}/`) && /\/LostCity\.app\/LostCity(\s|$)/.test(command)) {
            list.push({ role: 'app', pid });
        } else if (ppid === launchd && !webKitBefore.has(pid)) {
            const role = /com\.apple\.WebKit\.(WebContent|GPU|Networking)\b/.exec(command)?.[1];
            if (role) {
                list.push({ role, pid });
            }
        }
    }
    return list;
}

/** ps's cumulative CPU time ("[[dd-]hh:]mm:ss.ss") in seconds, and RSS in MB, per pid. */
function cpuTimes(pids) {
    const out = new Map();
    if (!pids.length) {
        return out;
    }
    let text = '';
    try {
        text = sh('ps', ['-o', 'pid=,time=,rss=', '-p', pids.join(',')]);
    } catch (error) {
        text = String(error.stdout ?? '');
    }
    for (const line of text.split('\n')) {
        const [pid, time, rss] = line.trim().split(/\s+/);
        if (!pid || !time) {
            continue;
        }
        const [days, clock] = time.includes('-') ? time.split('-') : ['0', time];
        const seconds = clock.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) + Number(days) * 86400;
        out.set(Number(pid), { cpuSec: seconds, rssMB: Math.round(Number(rss) / 1024) });
    }
    return out;
}

function footprintMB(pid) {
    try {
        const text = sh('footprint', ['-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
        const m = /phys_footprint:\s*([\d.]+)\s*([KMG])B/i.exec(text) ?? /Footprint:\s*([\d.]+)\s*([KMG])B/i.exec(text);
        return m ? Math.round(Number(m[1]) * { K: 1 / 1024, M: 1, G: 1024 }[m[2].toUpperCase()]) : null;
    } catch {
        return null;
    }
}

async function sampleWindow(name, seconds, set, requestedAt) {
    const dir = path.join(OUT, 'samples');
    fs.mkdirSync(dir, { recursive: true });
    const procs = simProcesses();
    const startedAt = Date.now();
    const t0 = cpuTimes(procs.map(p => p.pid));
    await sleep(seconds * 1000);
    const t1 = cpuTimes(procs.map(p => p.pid));
    const endedAt = Date.now();
    const wall = (endedAt - startedAt) / 1000;
    const processes = procs.map(p => {
        const a = t0.get(p.pid);
        const b = t1.get(p.pid);
        return { ...p, cpuSec: a && b ? +(b.cpuSec - a.cpuSec).toFixed(2) : null, cpuPct: a && b ? +((100 * (b.cpuSec - a.cpuSec)) / wall).toFixed(1) : null, rssMB: b?.rssMB ?? null, footprintMB: b ? footprintMB(p.pid) : null };
    });
    const entry = { name, set, seconds, requestedAt, startedAt, endedAt, host: "the Mac's CPU: relative only", processes };
    fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(entry, null, 1)}\n`);
    note(`sample ${name}: ${processes.map(p => `${p.role} ${p.cpuPct ?? '?'}% ${p.footprintMB ?? p.rssMB ?? '?'} MB`).join(', ')}`);
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
// (a soak's lines: soak.jsonl, soak-raw.jsonl, startup.jsonl, long lines joined from their parts)
const soakLines = SOAK ? new SoakLines(OUT, { run: stamp }) : null;
const STARTUP_LAUNCHES = SOAK?.startup?.launches ?? 0;
let app = null;
let launchedAt = 0;
let launches = 0; // (a soak's start-up series launches the app several times)
let settingsBefore = null; // (the settings the series' first launch changed, for its last to set back: ACTION relaunch)

let summary = null;
let finished = false;
const queue = [];
let busy = false;
let terminations = 0; // (the native log's "WebContent process terminated")
let leaks = 0; // (online: console chunks with a password the run typed)
let leakTail = '';

async function launchApp() {
    launches++;
    const args = onDevice
        ? ['devicectl', 'device', 'process', 'launch', '--device', target.udid, '--terminate-existing', '--console', BUNDLE]
        : ['simctl', 'launch', '--console-pty', '--terminate-running-process', target.udid, BUNDLE];
    // the soak, and which launch this is (DEBUG builds: GameViewController's launch-test reads it)
    // (devicectl: after '--', or it would take -LostCityTest for an option of its own)
    const test = SOAK ? [...(onDevice ? ['--'] : []), '-LostCityTest', launchTestArg({ soak: SOAK, launch: launches, clean: soakLines.cleanLaunches, run: stamp, before: settingsBefore })] : [];
    const traceSet = SOAK?.startup?.trace;
    if (traceSet && TRACE) {
        // (the launch recorded from before it starts: the start-up's footprint)
        await new Promise(resolve => void record(`startup-${launches}.${traceSet}`, SOAK.startup.traceSec ?? 20, traceSet, { onRecording: resolve }));
    }
    note(`launching${SOAK ? ` (launch ${launches}${STARTUP_LAUNCHES ? `, ${soakLines.cleanLaunches} of ${STARTUP_LAUNCHES} clean launches measured` : ''})` : ''}: xcrun ${args.join(' ')}${test.length ? ' -LostCityTest <the soak>' : ''}`);
    const child = spawn('xcrun', [...args, ...test], { stdio: ['ignore', 'pipe', 'pipe'] });
    app = child;
    launchedAt = Date.now();
    const onData = lineReader();
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => {
        if (child !== app) {
            return; // (a launch the next one ended)
        }
        note(`launcher exited (${code})`);
        if (!finished) {
            finish(true);
        }
    });
}

// The app ended and a moment for its processes to go, before the next launch of a start-up series: on the iPhone a
// stopped launch takes the running one's place (it never runs), then the real launch replaces it.
async function endApp() {
    try {
        if (onDevice) {
            sh('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', target.udid, '--terminate-existing', '--start-stopped', BUNDLE, '--quiet'], { stdio: 'ignore' });
        } else {
            sh('xcrun', ['simctl', 'terminate', target.udid, BUNDLE], { stdio: 'ignore' });
        }
    } catch {
        // not running
    }
    await sleep(3000);
}

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
    } else if ((m = line.match(/LCTEST ACTION soak (\S+) (\d+)(?: (\w+))?/))) {
        void record(m[1], Number(m[2]), m[3] ?? 'am');
    } else if ((m = line.match(/LCTEST ACTION relaunch(?: (\{.*\}))?\s*$/)) && SOAK) {
        settingsBefore = m[1] ? JSON.parse(m[1]) : settingsBefore;
        if (launches >= STARTUP_LAUNCHES + 3) {
            note(`the start-up series has had ${launches} launches for ${STARTUP_LAUNCHES} clean ones: giving up`);
            finish(true);
            return;
        }
        app = null; // (its launcher's exit is this relaunch, not the app's end)
        await endApp();
        await launchApp();
    } else if (ONLINE && /LCTEST ACTION relaunch\s*$/.test(line)) {
        // (online: the next launch takes the drift server's files from the app's cache)
        app = null;
        await endApp();
        await launchApp();
    } else if ((m = line.match(/LCTEST ACTION server (stop|start drift)\s*$/))) {
        try {
            await (m[1] === 'stop' ? stopServer() : startServer('drift'));
        } catch (error) {
            note(`server ${m[1]}: ${error.message}`);
        }
    } else if (/LCTEST ACTION kill-webcontent\s*$/.test(line)) {
        if (onDevice) {
            note('kill-webcontent: not on the iPhone (the page waits and reports it)');
        } else {
            killWebContent();
        }
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

/** The console of one launch, line by line. */
function lineReader() {
    let pending = '';
    return chunk => {
        const text = chunk.toString();
        consoleLog.write(text);
        if (ONLINE?.passwords.some(password => `${leakTail}${text}`.includes(password))) {
            leaks++; // (online: a password typed in the run must never reach a log; with the end of the last chunk)
        }
        leakTail = text.slice(-16);
        pending += text;
        let i;
        while ((i = pending.indexOf('\n')) >= 0) {
            onLine(pending.slice(0, i).replace(/\r$/, ''));
            pending = pending.slice(i + 1);
        }
    };
}

function onLine(line) {
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
    } else if ((m = line.match(/LCTEST INFO soak-phase-start (\S+) (\d+)/))) {
        note(`soak phase ${m[1]} starts (page clock ${new Date(Number(m[2])).toISOString()})`);
    }
    soakLines?.line(line);
    if (/WebContent process terminated/.test(line)) {
        terminations++;
        note(`WebContent terminated (${terminations}): ${line.trim()}`);
    }
    if (/\[lm\]/.test(line) && LM_BENCH_MIN !== null) {
        fs.appendFileSync(path.join(OUT, 'lm-native.log'), `${line}\n`);
    }
    if ((/LCTEST (PASS|FAIL|INFO|DONE)/.test(line) && !/LCTEST INFO soak-(raw|summary|startup)(-part)? /.test(line)) || /\b(error|fatal|exception)\b/i.test(line)) {
        process.stdout.write(`${line}\n`);
    }
}

if (ENGINE_DIR) {
    await startServer('stock');
}
await launchApp();

// Launch frames (launch screen → loading overlay → title); not in a soak, whose start-up they would slow.
if (!SOAK) {
    void (async () => {
        for (const ms of [1500, 4000, 9000]) {
            await sleep(Math.max(0, launchedAt + ms - Date.now()));
            if (!finished) {
                screenshot(`launch-${ms}`);
            }
        }
    })();
}

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
    setTimeout(async () => {
        if (recordings.size) {
            note(`waiting for ${recordings.size} recording(s) to be saved…`);
            await Promise.race([Promise.all([...recordings]), sleep(10 * 60 * 1000)]);
        }
        app?.kill('SIGTERM');
        await stopServer();
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
        if (ONLINE) {
            note(leaks ? `FAIL: a password the run typed is in the app's log (${leaks} time${leaks === 1 ? '' : 's'})` : 'the app\'s log has none of the passwords the run typed');
        }
        fs.writeFileSync(path.join(OUT, 'result.json'), `${JSON.stringify({ target: onDevice ? 'device' : 'simulator', udid: target.udid, summary, crashed, terminations, bots: SOAK ? SOAK.bots : BOTS, soak: SOAK?.name ?? null, online: ONLINE ? { url: ONLINE.url, drift: ONLINE.drift, leaks } : null, launches, port: builtPort(), out: OUT }, null, 1)}\n`);
        if (SOAK && !flag('--no-summary')) {
            try {
                sh('node', [path.join(IOS, 'web', 'test', 'perf', 'summary.mjs'), OUT], { stdio: 'inherit' });
            } catch (error) {
                note(`the summary failed: ${error.message.split('\n')[0]} (node web/test/perf/summary.mjs ${OUT})`);
            }
        }
        note(`result: ${summary ?? (crashed ? 'app exited before the test finished' : 'timeout')} — ${OUT}`);
        const failed = !summary || !summary.endsWith('fail=0') || leaks > 0;
        process.exit(failed ? 1 : 0);
    }, 1500);
}

/** The repository revision the installed web bundle was built from (its build-info.json). */
function builtPort() {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP, 'Game', 'build-info.json'), 'utf8')).port ?? null;
    } catch {
        return null;
    }
}

process.on('SIGINT', () => finish(true));
// (with bots: a restart to apply the setting, waiting for them, measuring; the lm-bench: its phases; a soak: its phases
// and launches)
const TIMEOUT_MIN = (ONLINE ? 35 : BOTS > 0 || SOAK?.bots > 0 ? 12 : 8) + (LM_BENCH_MIN !== null ? (30 * LM_BENCH_MIN) / 20 + 10 : 0) + (SOAK ? soakTimeoutMin(SOAK) : 0);
setTimeout(() => {
    note(`TIMEOUT (${TIMEOUT_MIN} min)`);
    finish(true);
}, TIMEOUT_MIN * 60 * 1000);
