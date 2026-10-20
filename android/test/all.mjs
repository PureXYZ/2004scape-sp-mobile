#!/usr/bin/env node
// Every Android test on one device or emulator, after one build of the app, with a summary table (docs/ANDROID.md §4
// Tests). The normal debug APK (with the chat model) is built once; the tests that need a test variant of the web
// bundle build it themselves (drive: the native-layer test page; app-test: the autotest run) and put the normal build
// back (lib/testbuild.mjs), so the order below never installs a test variant where the next test expects the app.
//
//   node android/test/all.mjs [--serial emulator-5554] [--quick] [--no-build] [--only a,b] [--skip a,b]
//                             [--bots N] [--instrumented]
//
// Steps, in order (each one's output is shown and kept in android/build/all/<step>.log):
//   build      ./gradlew :app:assembleDebug (the web bundle, the model, the APK)
//   jvm        ./gradlew :app:testDebugUnitTest :botchat:test (the JVM tests: router, saves, lifecycle, settings, bridge,
//              keyboard, haptics, audio, cover, provider, the chat model's host and port)
//   smoke      android/test/smoke.mjs --no-build
//   keyboard   android/test/keyboard.mjs --no-build
//   shell      android/test/shell.mjs --no-build
//   lm         android/test/lm.mjs --only model --no-build (the model phase; release and none build other APKs)
//   llm        (only with --instrumented or --only llm) :llm:connectedDebugAndroidTest with the local mock of the
//              Messages API behind adb reverse (docs/ANDROID.md §5.5)
//   drive      android/test/drive.mjs (emulators only: it clears the app's data)
//   app-test   android/test/app-test.mjs [--bots N] (on a phone: --device <serial>, which keeps its data)
// --quick: build, jvm and smoke. --no-build: use the APK already built. A step that fails does not stop the others; one
// of smoke, keyboard or shell that found no page to drive at its start (no DevTools target in 30 s, before any check)
// runs once more, and the table says so.
// Exit status 0 only if every step passed; android/build/all/summary.json has the table.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { device } from './lib/adb.mjs';
import { ANDROID, GRADLE_ENV, normalApk } from './lib/testbuild.mjs';
import { mockBehindReverse } from './lib/mock.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
};
const SERIAL = option('--serial', process.env.ANDROID_SERIAL ?? 'emulator-5554');
const emulator = SERIAL.startsWith('emulator-');
const QUICK = argv.includes('--quick');
const STEPS = ['build', 'jvm', 'smoke', 'keyboard', 'shell', 'lm', 'llm', 'drive', 'app-test'];
const ONLY = option('--only', null)?.split(',') ?? null;
const SKIP = option('--skip', '')?.split(',').filter(Boolean) ?? [];
const BOTS = option('--bots', null);
for (const name of [...(ONLY ?? []), ...SKIP]) {
    if (!STEPS.includes(name)) {
        console.error(`unknown step ${name} (steps: ${STEPS.join(', ')})`);
        process.exit(2);
    }
}
const defaultSteps = QUICK ? ['build', 'jvm', 'smoke'] : STEPS.filter(s => s !== 'llm' || argv.includes('--instrumented'));
const steps = (ONLY ?? defaultSteps).filter(s => !SKIP.includes(s) && !(s === 'build' && argv.includes('--no-build')));
const OUT = path.join(ANDROID, 'build', 'all');
fs.mkdirSync(OUT, { recursive: true });
const d = device(SERIAL);
const results = [];
const started = Date.now();

/** Runs a command with its output shown here and kept in <step>.log; resolves to {code, text}. */
function run(step, cmd, args, { env = process.env, cwd = path.dirname(ANDROID) } = {}) {
    return new Promise(resolve => {
        const log = fs.createWriteStream(path.join(OUT, `${step}.log`));
        console.log(`\n=== ${step}: ${path.basename(cmd)} ${args.join(' ')}`);
        const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let text = '';
        const take = chunk => {
            text += chunk;
            if (text.length > 4 << 20) text = text.slice(-(2 << 20));
            process.stdout.write(chunk);
            log.write(chunk);
        };
        child.stdout.on('data', take);
        child.stderr.on('data', take);
        child.on('close', code => {
            log.end();
            resolve({ code, text });
        });
    });
}

// What each runner prints at its end: "N/M checks passed" (smoke, keyboard, shell, lm) or "result: pass=N fail=M"
// (drive, app-test).
function checksOf(text) {
    let m = [...text.matchAll(/(\d+)\/(\d+) checks passed/g)].at(-1);
    if (m) return { pass: Number(m[1]), fail: Number(m[2]) - Number(m[1]) };
    m = [...text.matchAll(/result: pass=(\d+) fail=(\d+)/g)].at(-1);
    if (m) return { pass: Number(m[1]), fail: Number(m[2]) };
    return null;
}

/**
 * JUnit XML reports under `dirs`: tests, failures + errors, skipped. Gradle empties a task's report folder when the task
 * runs, and an up-to-date task (nothing changed since its last passing run) leaves the reports of that run, which are
 * then the current result.
 */
function junit(dirs) {
    const total = { pass: 0, fail: 0, skipped: 0, suites: 0 };
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir, { recursive: true })) {
            const full = path.join(dir, String(file));
            if (!full.endsWith('.xml')) continue;
            // (a connected test's report is one file with a <testsuite> per class inside <testsuites>)
            for (const [head] of fs.readFileSync(full, 'utf8').matchAll(/<testsuite [^>]*>/g)) {
                const num = name => Number(new RegExp(`\\b${name}="(\\d+)"`).exec(head)?.[1] ?? 0);
                const failed = num('failures') + num('errors');
                total.suites++;
                total.fail += failed;
                total.skipped += num('skipped');
                total.pass += num('tests') - failed - num('skipped');
            }
        }
    }
    return total.suites ? total : null;
}

function record(step, ok, checks, extra = '') {
    results.push({ step, ok, checks, seconds: Math.round((Date.now() - stepStarted) / 1000), note: extra });
}

let stepStarted = Date.now();
const node = process.execPath;
const test = name => path.join(ANDROID, 'test', name);
const serialArgs = ['--serial', SERIAL];

for (const step of steps) {
    stepStarted = Date.now();
    try {
        if (step === 'build') {
            const r = await run(step, path.join(ANDROID, 'gradlew'), [':app:assembleDebug', '--console=plain', '-q'], { env: GRADLE_ENV, cwd: ANDROID });
            record(step, r.code === 0, null, r.code === 0 ? path.relative(ANDROID, normalApk() ?? '?') : `gradle exited ${r.code}`);
        } else if (step === 'jvm') {
            const r = await run(step, path.join(ANDROID, 'gradlew'), [':app:testDebugUnitTest', ':botchat:test', '-PnoBuildWeb', '--console=plain', '-q', '--continue'], { env: GRADLE_ENV, cwd: ANDROID });
            const counts = junit([path.join(ANDROID, 'app', 'build', 'test-results', 'testDebugUnitTest'), path.join(ANDROID, 'botchat', 'build', 'test-results', 'test')]);
            record(step, r.code === 0 && counts?.fail === 0, counts, counts ? `${counts.suites} classes` : 'no reports');
        } else if (['smoke', 'keyboard', 'shell'].includes(step)) {
            let r = await run(step, node, [test(`${step}.mjs`), ...serialArgs, '--no-build']);
            let retried = false;
            if (r.code !== 0 && checksOf(r.text)?.pass === 0 && /no page target/.test(r.text)) {
                // (the page's DevTools target never showed up, before any check: the Mac or the emulator was too busy
                // for the 30 s the test waits; once more, and the table says so)
                retried = true;
                r = await run(step, node, [test(`${step}.mjs`), ...serialArgs, '--no-build']);
            }
            const counts = checksOf(r.text);
            record(step, r.code === 0, counts, `${retried ? 'retried once (no page target at first); ' : ''}android/build/${step}/`);
        } else if (step === 'lm') {
            const r = await run(step, node, [test('lm.mjs'), ...serialArgs, '--only', 'model', '--no-build']);
            record(step, r.code === 0, checksOf(r.text), 'model phase; android/build/lm/');
        } else if (step === 'llm') {
            const mock = await mockBehindReverse(d, { devicePort: 47591 });
            const r = await run(step, path.join(ANDROID, 'gradlew'), [':llm:connectedDebugAndroidTest', `-Pandroid.testInstrumentationRunnerArguments.mock=${mock.deviceUrl}`, '--console=plain', '-q'], { env: { ...GRADLE_ENV, ANDROID_SERIAL: SERIAL }, cwd: ANDROID });
            await mock.close();
            const counts = junit([path.join(ANDROID, 'llm', 'build', 'outputs', 'androidTest-results', 'connected')]);
            record(step, r.code === 0 && counts?.fail === 0, counts, 'instrumented, with the mock');
        } else if (step === 'drive') {
            if (!emulator) {
                record(step, true, null, 'skipped: emulators only (it clears the app\'s data)');
                continue;
            }
            const r = await run(step, node, [test('drive.mjs'), ...serialArgs]);
            record(step, r.code === 0, checksOf(r.text), 'android/build/drive/');
        } else if (step === 'app-test') {
            const target = emulator ? serialArgs : ['--device', SERIAL];
            const r = await run(step, node, [test('app-test.mjs'), ...target, ...(BOTS !== null ? ['--bots', BOTS] : [])]);
            record(step, r.code === 0, checksOf(r.text), `${BOTS !== null ? `${BOTS} bots; ` : ''}android/build/app-test/`);
        }
    } catch (error) {
        record(step, false, null, String(error?.message ?? error).split('\n')[0]);
    }
}

// ---------------------------------------------------------------------------------------------------- summary
const width = Math.max(...results.map(r => r.step.length), 4);
const lines = [
    `\nAndroid tests on ${SERIAL}, ${Math.round((Date.now() - started) / 60000)} min:`,
    `  ${'step'.padEnd(width)}  result  checks          time    notes`,
    ...results.map(r => {
        const checks = r.checks ? `${r.checks.pass}/${r.checks.pass + r.checks.fail}${r.checks.skipped ? ` (+${r.checks.skipped} skipped)` : ''}` : '-';
        return `  ${r.step.padEnd(width)}  ${(r.ok ? 'PASS' : 'FAIL').padEnd(6)}  ${checks.padEnd(14)}  ${`${r.seconds} s`.padEnd(6)}  ${r.note}`;
    })
];
console.log(lines.join('\n'));
fs.writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify({ serial: SERIAL, finished: new Date().toISOString(), steps: results }, null, 1)}\n`);
fs.writeFileSync(path.join(OUT, 'summary.txt'), `${lines.join('\n')}\n`);
process.exitCode = results.every(r => r.ok) ? 0 : 1;
