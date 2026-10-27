#!/usr/bin/env node
// Runs web/test/autotest.js inside the real Android app, on the emulator or a phone, and answers its requests
// (screenshots, backgrounding the app, memory samples): the Android twin of web/test/app-test.mjs (docs/ANDROID.md §2
// test/). The same autotest.js run as on the iPhone: boot → native keyboard login → walk → World map → save →
// background 5 s / 25 s → dropped connection → reload → re-login restores the position → memory warning → Saved data.
//
//   node android/test/app-test.mjs                      # emulator-5554 (or ANDROID_SERIAL); its data is cleared first
//   node android/test/app-test.mjs --serial emulator-5556
//   node android/test/app-test.mjs --device [serial]    # the first phone on USB (adb devices), or that one; its data
//                                                       # is kept, as on the iPhone
//   options: --no-build (reuse android/build/app-test/app-autotest.apk, the last test build), --debug-web (unminified
//            web build: Gradle -PwebDebug), --keep-data (emulator: don't clear the app's data first),
//            --bots N (the world runs N bots: autotest.json in the test bundle asks autotest.js to set Settings › World ›
//            Bots to N, which restarts the page once, and the run adds the bots' checks and measurements; 0 = off; a
//            count the sheet does not offer, such as 75, works too),
//            --pack (let the web build run the engine's packer, Gradle -PwebPack; without it the existing pack is used,
//            as every Android build does: iOS's --skip-pack is the default here and accepted for the same command line),
//            --lm-bench[=MIN] (the bots' on-device chat model under load, docs/ARCHITECTURE.md
//            §7.1: with --bots 500 unless --bots says otherwise, after the bots' checks autotest.js runs 5 min with no
//            generation, MIN min (20) with a reply generated every 5 s and 5 min back to back, the phases scaled by
//            MIN/20; every 10 s it logs the frame rate, the engine's tick, the app's memory and heat and the generations,
//            into lm-bench.jsonl, and ends with lm-bench-summary.json and the gate's checks. Needs the model in the APK:
//            android/scripts/prepare-model.sh <gguf>; implies --profile bench; --lm-every=SEC sets the main phase's
//            cadence, 5 s; --lm-threads=N and --lm-gpuLayers=N the model's options for the run; --lm-think benches the
//            note mode: every reply written with the model's short note first, as Settings › Bot chat › Think first
//            asks, which needs model.json's template qwen-chatml-hybrid or qwen-chatml-think),
//            --profile NAME (the run plays in players/NAME/ and bots/NAME/, so the phone's own characters and world,
//            profile main, stay as they are),
//            --soak NAME|FILE (a performance soak instead of the checks after the login: web/test/perf/NAME.json or a file
//            of that shape, as on the iPhone; docs/BUILDING.md §4 "A/B on the phone"). The soak goes to the app at launch
//            (the debug build's lostcity.test extra), so --no-build runs any soak on the last test build; it implies
//            --profile bench, and --bots N sets the soak's count. Each phase's window is sampled here: the app's,
//            its renderer's and the compositor's threads (top -H, /proc stat before and after), the app's frames (dumpsys
//            gfxinfo), the composed frame rate (SurfaceFlinger --latency) and memory (meminfo). A soak with
//            startup.launches N launches the app (am start -S -W) until N clean launches have reported their start-up
//            marks. Output beside the console log: soak.jsonl, soak-raw.jsonl, startup.jsonl (from the app's log file,
//            whose lines are whole), soak/ (the samples), summary.json + summary.txt (web/test/perf/summary.mjs;
//            --no-summary: not made),
//            --keep-test-build (leave the test build installed at the end)
//
// The test APK is the debug build with the autotest web variant (Gradle :app:buildWeb -PwebAutotest, i.e. build-web.mjs
// --autotest, plus autotest.json and the profile in the bundle), copied to android/build/app-test/app-autotest.apk. The
// normal web bundle and debug APK are set aside for the build and put back before the run (lib/testbuild.mjs), and at
// the end the normal debug APK is installed again (adb install -r: the saves stay); with none built, the run says how.
//
// The run plays in the app's own Documents, profile `main` (the emulator's data is cleared first unless --keep-data). So
// a --device run leaves on the phone: the character "Autotest" (players/main/autotest.sav), and with --bots N the phone's
// own bots store (bots/main/bots.sav). The Bots setting goes back to what the app had once the run finishes (DONE); a run
// that stops before that (timeout, crash, Ctrl-C) leaves it at N: set it in Settings › World.
//
// How it reads the page: autotest.js writes LCTEST lines with console.log, which the native console bridge
// (NativeScripts.CONSOLE_BRIDGE, in debug and release builds) puts in the native log as `[js:log] LCTEST …`, logcat tag
// LostCity. logcat splits an entry at 4,000 characters (Log.kt), so long lines are joined again here, and the bench's
// samples and summary are taken from the app's own log file at the end, which keeps every line whole.
//
// What differs from the iPhone's driver: backgrounding opens the system Settings app (am start) and brings the game back
// with am start (singleTask: the same activity); memory is dumpsys meminfo's PSS of the app and of its WebView renderer
// (the sandboxed process its SandboxedProcessService binding names); a renderer's death is the native log's "WebView
// renderer gone". Output: android/build/app-test/<emulator|device>-<time>/ (console.log, driver.log, screenshots,
// memory.txt, app-log.txt; with --lm-bench lm-bench.jsonl, lm-bench-summary.json, lm-native.log).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ACTIVITY, ADB, PKG, device, sleep } from './lib/adb.mjs';
import { ANDROID, REPO, WEB_GAME, apkFile, buildTestApk, firstUsbDevice, gradle, normalApk } from './lib/testbuild.mjs';
import { SoakLines, launchTestArg, lmPrompts, loadSoak, procStatScript, soakBuildProblem, soakTimeoutMin } from '../../web/test/perf/soak.mjs';

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const option = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const onDevice = flag('--device');
const SERIAL = onDevice ? (option('--device', null) ?? firstUsbDevice()) : option('--serial', process.env.ANDROID_SERIAL ?? 'emulator-5554');
const emulator = SERIAL?.startsWith('emulator-') ?? false;
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
const SOAK = (() => {
    if (!flag('--soak')) {
        return null;
    }
    try {
        return loadSoak(argv[argv.indexOf('--soak') + 1], { bots: flag('--bots') ? BOTS : undefined });
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
})();
const PROFILE = flag('--profile') ? argv[argv.indexOf('--profile') + 1] : LM_BENCH_MIN !== null || SOAK ? 'bench' : null;
if (PROFILE !== null && !/^[a-z0-9_-]{1,32}$/.test(PROFILE)) {
    console.error('--profile takes a name of lowercase letters, digits, - and _');
    process.exit(1);
}
if (BOTS !== null && !(Number.isInteger(BOTS) && BOTS >= 0)) {
    console.error('--bots takes a number of bots (0 = off)');
    process.exit(1);
}
if (!SERIAL) {
    console.error('No phone found on USB (adb devices). Enable USB debugging and allow this computer, or pass --device <serial>.');
    process.exit(1);
}
const BUILD_DIR = path.join(ANDROID, 'build', 'app-test');
const TEST_APK = path.join(BUILD_DIR, 'app-autotest.apk');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.join(BUILD_DIR, `${emulator ? 'emulator' : 'device'}-${stamp}${SOAK ? `-${SOAK.name}` : ''}`);
fs.mkdirSync(OUT, { recursive: true });

const d = device(SERIAL);
const t0 = Date.now();
function note(message) {
    const line = `[app-test +${((Date.now() - t0) / 1000).toFixed(1)}s] ${message}`;
    console.log(line);
    fs.appendFileSync(path.join(OUT, 'driver.log'), `${line}\n`);
}
note(`target: ${emulator ? 'emulator' : 'device'} ${SERIAL}`);

// ------------------------------------------------------------------------------------------------ build

// The bench's configuration (autotest.js lmBenchChecks): the phases, and the prompts (the engine's renderLocal of real
// reply situations: web/test/lm/render-prompts.mjs). As web/test/app-test.mjs's.
function lmBenchConfig() {
    const scale = LM_BENCH_MIN / 20;
    const prompts = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'test', 'lm', 'bench-prompts.json'), 'utf8')).prompts.map(p => p.local);
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
    const modelDir = path.join(ANDROID, 'build', 'model-assets', 'Model');
    const model = (() => {
        try {
            return JSON.parse(fs.readFileSync(path.join(modelDir, 'model.json'), 'utf8'));
        } catch {
            return null;
        }
    })();
    if (!model || !fs.existsSync(path.join(modelDir, model.file))) {
        console.error('--lm-bench needs the model in the APK: run android/scripts/prepare-model.sh <absolute path of the .gguf> first');
        process.exit(1);
    }
    if (LM_THINK && !['qwen-chatml-hybrid', 'qwen-chatml-think'].includes(model.template)) {
        console.error(`--lm-think needs a model that writes its note: android/build/model-assets/Model/model.json's template is ${model.template ?? 'qwen-chatml-nothink'} (qwen-chatml-hybrid or qwen-chatml-think write one)`);
        process.exit(1);
    }
    note(`lm-bench: ${model.name} (${Math.round(model.bytes / 1048576)} MB, template ${model.template ?? 'qwen-chatml-nothink'}), main phase ${LM_BENCH_MIN} min${LM_THINK ? ', every reply with its note first (--lm-think)' : ''}`);
}

if (!flag('--no-build')) {
    note('building the test APK (the autotest web variant)…');
    buildTestApk({
        out: TEST_APK,
        makeBundle: game => {
            gradle(':app:buildWeb', '-PwebAutotest', ...(flag('--debug-web') ? ['-PwebDebug'] : []), ...(flag('--pack') ? ['-PwebPack'] : []));
            if (BOTS !== null || LM_BENCH_MIN !== null || SOAK) {
                // what autotest.js reads (the test bundle only); a soak build has the chat model's prompts, for any soak's
                // lm phase (the soak itself comes at launch, and its bots with it)
                const config = { ...(BOTS !== null && !SOAK ? { bots: BOTS } : {}), ...(LM_BENCH_MIN !== null ? { lmBench: lmBenchConfig() } : {}), ...(SOAK ? { lmPrompts: lmPrompts(REPO) } : {}) };
                fs.writeFileSync(path.join(game, 'autotest.json'), `${JSON.stringify(config)}\n`);
                note(`autotest.json: ${SOAK ? `the soak's ${SOAK.bots} bots, the chat model's prompts` : `${BOTS ?? "the app's"} bots`}${LM_BENCH_MIN !== null ? `, lm-bench ${JSON.stringify({ ...config.lmBench, prompts: config.lmBench.prompts.length })}` : ''}`);
            }
            if (PROFILE !== null) {
                // the save profile, before host.js reads it (host.js PROFILE)
                const index = path.join(game, 'index.html');
                const tag = '<script src="host.js"></script>';
                fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace(tag, `<script>window.__lcTestProfile = ${JSON.stringify(PROFILE)};</script>\n    ${tag}`));
                note(`the run plays in the save profile ${PROFILE} (players/${PROFILE}/, bots/${PROFILE}/)`);
            }
        }
    });
    note(`test APK: ${path.relative(REPO, TEST_APK)}; ${path.relative(REPO, WEB_GAME)} and the debug APK are the normal build again`);
}
if (!fs.existsSync(TEST_APK) || !apkFile(TEST_APK, 'assets/Game/autotest.js')) {
    console.error(`${TEST_APK} is missing or has no assets/Game/autotest.js; build without --no-build first`);
    process.exit(1);
}
// (--no-build: the app asks for the bots its build was made with)
const builtBots = (() => {
    try {
        return JSON.parse(apkFile(TEST_APK, 'assets/Game/autotest.json')?.toString() ?? 'null')?.bots ?? null;
    } catch {
        return null;
    }
})();
if (!SOAK && builtBots !== BOTS) {
    console.error(`${TEST_APK} was built ${builtBots === null ? 'without --bots' : `with --bots ${builtBots}`}; build it again (without --no-build) for ${BOTS === null ? 'no --bots' : `--bots ${BOTS}`}`);
    process.exit(1);
}
if (SOAK) {
    // (the soak comes at launch; what it needs of the build: the save profile, the prompts for an lm phase)
    const problem = soakBuildProblem({ index: apkFile(TEST_APK, 'assets/Game/index.html')?.toString() ?? null, autotest: apkFile(TEST_APK, 'assets/Game/autotest.json')?.toString() ?? null }, SOAK, PROFILE);
    if (problem) {
        console.error(`${TEST_APK}: ${problem}; build it again (without --no-build) with --soak`);
        process.exit(1);
    }
}
if (LM_BENCH_MIN !== null && !apkFile(TEST_APK, 'assets/Model/model.json')) {
    console.error(`${TEST_APK} has no model (assets/Model): build it again with the model (android/scripts/prepare-model.sh, no -Plc.model=none)`);
    process.exit(1);
}

// ------------------------------------------------------------------------------------------------ install

function install(apk) {
    const output = d.adbQuiet('install', '-r', apk);
    if (!/Success/.test(output)) {
        console.error(`adb install failed: ${output.trim()}`);
        process.exit(1);
    }
}

note(`installing on ${SERIAL}…`);
d.adbQuiet('shell', 'am', 'force-stop', PKG);
install(TEST_APK);
if (emulator && !flag('--keep-data')) {
    d.adbQuiet('shell', 'pm', 'clear', PKG); // (the simulator's uninstall: a fresh start, saves and settings gone)
    note('installed; the app\'s data cleared');
} else {
    note('installed (the app\'s data kept)');
}
// the system's one-time "Viewing full screen" sheet over an immersive app: marked seen; landscape; the screen kept on
// while plugged in (the phone's own value is put back at the end)
const stayOn = d.adbQuiet('shell', 'settings', 'get', 'global', 'stay_on_while_plugged_in').trim();
d.adbQuiet('shell', 'settings', 'put', 'secure', 'immersive_mode_confirmations', 'confirmed');
if (emulator) {
    d.adbQuiet('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
    d.adbQuiet('emu', 'sensor', 'set', 'acceleration', '9.81:0:0');
}
d.adbQuiet('shell', 'svc', 'power', 'stayon', 'true');
d.adbQuiet('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');

// ------------------------------------------------------------------------------------------------ actions

function screenshot(name) {
    try {
        d.screenshot(path.join(OUT, `${name}.png`));
        note(`screenshot ${name}.png`);
    } catch (error) {
        note(`screenshot ${name} failed: ${error.message.split('\n')[0]}`);
    }
}

/** The app's WebView renderers: the sandboxed processes its SandboxedProcessService bindings run in. */
function rendererPids() {
    const services = d.adbQuiet('shell', 'dumpsys', 'activity', 'services', PKG);
    return [...new Set([...services.matchAll(/app=ProcessRecord\{\w+ (\d+):[^}]*sandboxed_process/g)].map(m => Number(m[1])))];
}

function pssOf(target) {
    const text = d.adbQuiet('shell', 'dumpsys', 'meminfo', String(target));
    const pss = /TOTAL PSS:\s+(\d+)/.exec(text)?.[1];
    const rss = /TOTAL RSS:\s+(\d+)/.exec(text)?.[1];
    const heap = /Native Heap:\s+(\d+)/.exec(text)?.[1];
    return pss ? `pss ${(pss / 1024).toFixed(0)} MB, rss ${(rss / 1024).toFixed(0)} MB${heap ? `, native heap ${(heap / 1024).toFixed(0)} MB` : ''}` : '(no meminfo)';
}

function measure(label) {
    const lines = [`== ${label} (+${((Date.now() - t0) / 1000).toFixed(0)} s)`];
    lines.push(`app ${d.pid() ?? '?'}: ${pssOf(PKG)}`);
    for (const pid of rendererPids()) lines.push(`renderer ${pid}: ${pssOf(pid)}`);
    note(lines.join('\n  '));
    fs.appendFileSync(path.join(OUT, 'memory.txt'), `${lines.join('\n')}\n`);
}

// ---- a soak's windows (ACTION soak <name> <seconds> <set>), one at a time: the app's, its renderer's, the compositor's
// and the audio server's threads (top -H over the window, and /proc/<pid>/task/*/stat before and after), the app's frames
// (gfxinfo, reset at the start), the composed frames (SurfaceFlinger --latency), the display's rate and the memory
// (meminfo); web/test/perf/summary.mjs reads them. A request made while one runs waits for it.
let sampleChain = Promise.resolve();
const sampling = new Set();
const OTHERS = ['surfaceflinger', 'android.hardware.graphics.composer3-service.ranchu', 'android.hardware.graphics.allocator-service.ranchu', 'android.hardware.graphics.composer@2.4-service', 'audioserver', 'android.hardware.audio.service', 'android.hardware.audio.service.ranchu', 'system_server'];

function pidsOf(name) {
    return d.adbQuiet('shell', 'pidof', name).trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
}

function sampleWindow(name, seconds) {
    const dir = path.join(OUT, 'soak');
    fs.mkdirSync(dir, { recursive: true });
    const requestedAt = Date.now();
    const done = (sampleChain = sampleChain.then(async () => {
        const app = Number(d.pid());
        const renderers = rendererPids();
        const names = {};
        for (const other of OTHERS) {
            for (const pid of pidsOf(other)) names[pid] = other.replace(/^android\.hardware\.(graphics|audio)\./, '').replace(/-service.*$/, '');
        }
        const pids = [...new Set([app, ...renderers, ...Object.keys(names).map(Number)].filter(Boolean))];
        const stat = () => d.adbQuiet('shell', procStatScript(pids)); // (one argument: procStatScript says why)
        const startedAt = Date.now();
        note(`soak window ${name}: ${seconds} s (${((startedAt - requestedAt) / 1000).toFixed(1)} s after the request), app ${app}, renderers ${renderers.join(',')}`);
        d.adbQuiet('shell', 'dumpsys', 'gfxinfo', PKG, 'reset');
        const stat0 = stat();
        const top = await new Promise(resolve => {
            const child = spawn(ADB, ['-s', SERIAL, 'shell', 'top', '-b', '-H', '-d', String(seconds), '-n', '2', '-p', pids.join(','), '-o', 'PID,TID,%CPU,TIME+,CMD,NAME'], { stdio: ['ignore', 'pipe', 'pipe'] });
            let text = '';
            child.stdout.on('data', c => (text += c));
            child.stderr.on('data', c => (text += c));
            child.on('exit', () => resolve(text));
        });
        const stat1 = stat();
        const endedAt = Date.now();
        const layers = d.adbQuiet('shell', 'dumpsys', 'SurfaceFlinger', '--list');
        const layer = layers.split('\n').map(l => l.trim()).filter(l => l.includes(PKG) && !/Background|Bounds/.test(l)).pop() ?? '';
        const files = {
            'top.txt': top,
            'stat0.txt': stat0,
            'stat1.txt': stat1,
            'gfxinfo.txt': d.adbQuiet('shell', 'dumpsys', 'gfxinfo', PKG),
            'latency.txt': `${layer}\n${layer ? d.adbQuiet('shell', 'dumpsys', 'SurfaceFlinger', '--latency', layer) : ''}`,
            'display.txt': d.adbQuiet('shell', 'dumpsys display | grep -iE "mActiveRenderFrameRate|renderFrameRate|mActiveSfDisplayMode|refreshRate=" | head -10'),
            'mem.txt': [`app ${app}: ${pssOf(PKG)}`, ...renderers.map(pid => `renderer ${pid}: ${pssOf(pid)}`)].join('\n')
        };
        for (const [suffix, text] of Object.entries(files)) {
            fs.writeFileSync(path.join(dir, `${name}.${suffix}`), text);
        }
        fs.appendFileSync(path.join(dir, 'windows.jsonl'), `${JSON.stringify({ name, seconds, requestedAt, startedAt, endedAt, app, renderers, names, layer })}\n`);
        note(`soak window ${name}: done (${((endedAt - startedAt) / 1000).toFixed(1)} s); ${files['mem.txt'].replace(/\n/g, '; ')}`);
    }));
    sampling.add(done);
    void done.then(() => sampling.delete(done));
}

// (a soak's: the soak and which launch this is, for the debug build's launch-test; am start -W says how long it took)
let launches = 0;
let settingsBefore = null; // (the settings the series' first launch changed, for its last to set back: ACTION relaunch)
function launchApp({ fresh }) {
    if (!fresh || !SOAK) {
        return d.adbQuiet('shell', 'am', 'start', ...(fresh ? ['-W', '-S'] : []), '-n', ACTIVITY);
    }
    launches++;
    const output = d.adbQuiet('shell', 'am', 'start', '-W', '-S', '-n', ACTIVITY, '--es', 'lostcity.test', launchTestArg({ soak: SOAK, launch: launches, clean: soakLines.cleanLaunches, run: stamp, before: settingsBefore }));
    const times = Object.fromEntries([...output.matchAll(/^(TotalTime|WaitTime|LaunchState): (\S+)/gm)].map(m => [m[1], /^\d+$/.test(m[2]) ? Number(m[2]) : m[2]]));
    fs.appendFileSync(path.join(OUT, 'launches.jsonl'), `${JSON.stringify({ launch: launches, at: Date.now(), ...times })}\n`);
    return output;
}

// ------------------------------------------------------------------------------------------------ run

const consoleLog = fs.createWriteStream(path.join(OUT, 'console.log'));
// (a soak's lines as they come, for the start-up series' count; the files are made again from the app's log at the end)
const soakLines = SOAK ? new SoakLines(OUT, { run: stamp }) : null;
const STARTUP_LAUNCHES = SOAK?.startup?.launches ?? 0;
d.clearLog();
const logcat = spawn(ADB, ['-s', SERIAL, 'logcat', '-v', 'threadtime', 'LostCity:V', '*:S'], { stdio: ['ignore', 'pipe', 'pipe'] });
note(`launching: adb -s ${SERIAL} shell am start -W -S -n ${ACTIVITY}${SOAK ? ' --es lostcity.test <the soak>' : ''}`);
let launchedAt = Date.now();
launchApp({ fresh: true });

let summary = null;
let finished = false;
const queue = [];
let busy = false;
let terminations = 0; // (the native log's "WebView renderer gone")

async function act(line) {
    let m;
    if ((m = line.match(/LCTEST SHOT (\S+)/))) {
        screenshot(m[1]);
    } else if ((m = line.match(/LCTEST ACTION background (\d+)/))) {
        const seconds = Number(m[1]);
        note(`backgrounding the app (Settings) for ${seconds} s`);
        d.adbQuiet('shell', 'am', 'start', '-a', 'android.settings.SETTINGS');
        await sleep(seconds * 1000);
        note('bringing the app back');
        launchApp({ fresh: false });
    } else if ((m = line.match(/LCTEST ACTION measure (\S+)/))) {
        measure(m[1]);
    } else if ((m = line.match(/LCTEST ACTION soak (\S+) (\d+)(?: (\w+))?/))) {
        sampleWindow(m[1], Number(m[2]));
    } else if ((m = line.match(/LCTEST ACTION relaunch(?: (\{.*\}))?\s*$/)) && SOAK) {
        settingsBefore = m[1] ? JSON.parse(m[1]) : settingsBefore;
        if (launches >= STARTUP_LAUNCHES + 3) {
            note(`the start-up series has had ${launches} launches for ${STARTUP_LAUNCHES} clean ones: giving up`);
            finish(true);
            return;
        }
        // (stopped, a moment for its processes to go, then the next launch; the process watch waits for it)
        launchedAt = Date.now();
        d.adbQuiet('shell', 'am', 'force-stop', PKG);
        await sleep(3000);
        note(`launching again (launch ${launches + 1}, ${soakLines.cleanLaunches} of ${STARTUP_LAUNCHES} clean launches measured)`);
        launchedAt = Date.now();
        launchApp({ fresh: true });
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

// One native log line (logcat's message: `[js:log] LCTEST …` for the page's console).
function onLine(line) {
    // (markers only from the console bridge's `[js:…]` copy: a verbose log also has Chromium's `[console:…]` copy)
    if (line.startsWith('[console:')) return;
    if (/LCTEST (SHOT|ACTION|DONE) /.test(line)) {
        queue.push(line);
        void pump();
    }
    if (/WebView renderer gone/.test(line)) {
        terminations++;
        note(`WebView renderer gone (${terminations}): ${line.trim()}`);
    }
    if (/\[lm\]/.test(line) && LM_BENCH_MIN !== null) {
        fs.appendFileSync(path.join(OUT, 'lm-native.log'), `${line}\n`);
    }
    soakLines?.line(line);
    if ((/LCTEST (PASS|FAIL|INFO|DONE)/.test(line) && !/LCTEST INFO soak-(raw|summary|startup)(-part)? /.test(line)) || /\b(error|fatal|exception)\b/i.test(line)) {
        process.stdout.write(`${line.length > 2000 ? `${line.slice(0, 2000)} …` : line}\n`);
    }
}

// logcat's threadtime lines: `MM-DD HH:MM:SS.mmm  PID  TID L TAG: message`. Log.kt writes a line longer than 4,000
// characters as several entries of 4,000 (the last shorter), one after another on its thread: joined again here.
const LOGCAT_CHUNK = 4000;
const partial = new Map(); // tid → the text so far
let pending = '';
function onData(chunk) {
    const text = chunk.toString();
    consoleLog.write(text);
    pending += text;
    let i;
    while ((i = pending.indexOf('\n')) >= 0) {
        const raw = pending.slice(0, i).replace(/\r$/, '');
        pending = pending.slice(i + 1);
        const m = /^\S+\s+\S+\s+\d+\s+(\d+)\s+\w\s+LostCity\s*: (.*)$/.exec(raw);
        if (!m) continue;
        const [, tid, message] = m;
        const joined = (partial.get(tid) ?? '') + message;
        if (message.length === LOGCAT_CHUNK) {
            partial.set(tid, joined);
            continue;
        }
        partial.delete(tid);
        onLine(joined);
    }
}
logcat.stdout.on('data', onData);
logcat.stderr.on('data', onData);
logcat.on('exit', code => {
    if (!finished) {
        note(`logcat exited (${code})`);
        finish(true);
    }
});

// The app's process going away during the run is a crash (iOS: the launcher exits with the app).
const watchProcess = setInterval(() => {
    if (!finished && Date.now() - launchedAt > 15000 && d.pid() === null) {
        note('the app\'s process is gone');
        finish(true);
    }
}, 5000);

// Launch frames (launch screen → loading cover → title); not in a soak, whose start-up they would slow.
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

/** The app's own log file (external files: readable with adb on a release build too), the rotated one first. */
function pullAppLog() {
    const dir = `/sdcard/Android/data/${PKG}/files/Logs`;
    const text = ['lostcity.1.log', 'lostcity.log'].map(name => d.adbQuiet('shell', 'cat', `${dir}/${name}`)).filter(t => !/No such file/.test(t)).join('');
    fs.writeFileSync(path.join(OUT, 'app-log.txt'), text);
    return text;
}

/** The bench's samples and summary, from the log file's whole lines (logcat could have cut a long one). */
function writeBench(logText) {
    const samples = [];
    let summaryLine = null;
    for (const line of logText.split('\n')) {
        let m;
        if ((m = line.match(/LCTEST INFO lm-bench (\{.*\})\s*$/))) {
            samples.push(m[1]);
        } else if ((m = line.match(/LCTEST INFO lm-bench-summary (\{.*\})\s*$/))) {
            summaryLine = m[1];
        }
    }
    if (samples.length) fs.writeFileSync(path.join(OUT, 'lm-bench.jsonl'), `${samples.join('\n')}\n`);
    if (summaryLine) {
        try {
            fs.writeFileSync(path.join(OUT, 'lm-bench-summary.json'), `${JSON.stringify(JSON.parse(summaryLine), null, 2)}\n`);
        } catch {
            fs.writeFileSync(path.join(OUT, 'lm-bench-summary.json'), summaryLine);
        }
    }
    note(`lm-bench: ${samples.length} samples${summaryLine ? ', the summary' : ', no summary'} (from the app's log file)`);
}

function finish(crashed = false) {
    if (finished) {
        return;
    }
    finished = true;
    clearInterval(watchProcess);
    void (async () => {
        if (sampling.size) {
            note(`waiting for ${sampling.size} soak window(s)…`);
            await Promise.race([Promise.all([...sampling]), sleep(5 * 60 * 1000)]);
        }
        // (the iPhone's driver sends the app to the background, the simulator's terminates it: HOME flushes the saves,
        // then on an emulator the app is stopped)
        d.adbQuiet('shell', 'input', 'keyevent', 'KEYCODE_HOME');
        await sleep(2500);
        finishRun(crashed);
    })();
}

function finishRun(crashed) {
    if (emulator) d.adbQuiet('shell', 'am', 'force-stop', PKG);
    logcat.kill('SIGTERM');
    const files = d.adbQuiet('shell', 'run-as', PKG, 'find', 'files/Documents', '-type', 'f');
    note(`Documents:\n${files.trim()}`);
    const logText = pullAppLog();
    if (LM_BENCH_MIN !== null) writeBench(logText);
    if (SOAK) writeSoak(logText);
    if (terminations) {
        note(`WebView renderer deaths during the run: ${terminations}`);
    }
    // the normal build back on the device (the test build has the self-playing page)
    if (flag('--keep-test-build')) {
        note(`the test build stays installed (--keep-test-build): run DEVICE=${SERIAL} android/scripts/deploy.sh to put the normal app back`);
    } else {
        const normal = normalApk();
        if (normal) {
            const ok = /Success/.test(d.adbQuiet('install', '-r', normal));
            note(ok ? `the normal debug build is installed again (${path.relative(REPO, normal)}, built ${fs.statSync(normal).mtime.toISOString().slice(0, 16).replace('T', ' ')})` : `could not install ${normal}: run DEVICE=${SERIAL} android/scripts/deploy.sh`);
        } else {
            note(`no normal debug APK is built: run DEVICE=${SERIAL} android/scripts/deploy.sh to put the normal app back (the test build is still installed)`);
        }
    }
    d.adbQuiet('shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', /^\d+$/.test(stayOn) ? stayOn : '0');
    d.adbQuiet('forward', '--remove', `tcp:${d.devtoolsPort}`);
    fs.writeFileSync(path.join(OUT, 'result.json'), `${JSON.stringify({ serial: SERIAL, target: emulator ? 'emulator' : 'device', summary, crashed, terminations, bots: SOAK ? SOAK.bots : BOTS, lmBench: LM_BENCH_MIN, soak: SOAK?.name ?? null, launches, port: builtPort(), out: OUT }, null, 1)}\n`);
    if (SOAK && !flag('--no-summary')) {
        const r = spawnSync(process.execPath, [path.join(REPO, 'web', 'test', 'perf', 'summary.mjs'), OUT], { stdio: 'inherit' });
        if (r.status !== 0) note(`the summary failed (node web/test/perf/summary.mjs ${OUT})`);
    }
    note(`result: ${summary ?? (crashed ? 'the app stopped before the test finished' : 'timeout')} — ${OUT}`);
    const failed = !summary || !summary.endsWith('fail=0');
    process.exit(failed ? 1 : 0);
}

/** A soak's files from the app's log file, whose lines are whole (logcat's were joined), when it has them all. */
function writeSoak(logText) {
    const fromLog = new SoakLines(OUT, { run: stamp, live: false });
    for (const line of logText.split('\n')) fromLog.line(line);
    if (fromLog.values.length >= soakLines.values.length) {
        fromLog.write();
    }
    note(`soak: ${fromLog.values.length} values in the app's log file, ${soakLines.values.length} from logcat (${fromLog.values.length >= soakLines.values.length ? "the log file's" : "logcat's"} kept)`);
}

/** The repository revision the test APK's web bundle was built from (its build-info.json). */
function builtPort() {
    try {
        return JSON.parse(apkFile(TEST_APK, 'assets/Game/build-info.json')?.toString() ?? 'null')?.port ?? null;
    } catch {
        return null;
    }
}

process.on('SIGINT', () => finish(true));
// (with bots: a restart to apply the setting, waiting for them, measuring; the lm-bench: its phases; a soak: its phases
// and launches)
const TIMEOUT_MIN = (BOTS > 0 || SOAK?.bots > 0 ? 12 : 8) + (LM_BENCH_MIN !== null ? (30 * LM_BENCH_MIN) / 20 + 10 : 0) + (SOAK ? soakTimeoutMin(SOAK) : 0);
setTimeout(() => {
    note(`TIMEOUT (${TIMEOUT_MIN} min)`);
    finish(true);
}, TIMEOUT_MIN * 60 * 1000);
