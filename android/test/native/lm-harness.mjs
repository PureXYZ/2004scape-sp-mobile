#!/usr/bin/env node
// The bots' chat model's native side on the Mac, Android's build of it: the app's BotChatModel, OnlineModel and
// LocalModel (android/botchat, plain Kotlin/JVM) with the C++ core (android/llm/src/main/cpp) built as liblcllm.dylib
// against llama.cpp b11297's macOS prebuilt (android/scripts/fetch-llama.sh), CPU only as on Android, run on the Mac's JVM
// (Android Studio's JBR) by Gradle (:botchat:lmHarness, src/harness/.../HarnessMain.kt) against the local mock of the
// Messages API (web/test/lm/mock-claude.mjs, shared with the iOS harness). The Android twin of web/test/native/lm-harness.mjs:
// the same 49 checks with the same names, then the Android extras A1-A5. Last it checks every
// request the mock got: the API's fields, as docs/ARCHITECTURE.md §7.1 lists them (a request the mock found wrong fails the
// run). No real API call, no key.
//
//   node android/test/native/lm-harness.mjs [--no-model] [--model <folder>] [--port 47590]
//   (the model from android/build/model-assets/Model: android/scripts/prepare-model.sh, the trained model from the
//   cache, the iPhone's hybrid model; --no-model runs without one)
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockClaude } from '../../../web/test/lm/mock-claude.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANDROID = path.resolve(HERE, '..', '..');
const REPO = path.resolve(ANDROID, '..');
const OUT = path.join(ANDROID, 'build', 'tmp', 'lm-harness');
const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const PORT = Number(option('--port', 47590));
const MODEL = argv.includes('--no-model') ? 'none' : path.resolve(option('--model', path.join(ANDROID, 'build', 'model-assets', 'Model')));
const SDK = process.env.ANDROID_HOME ?? path.join(process.env.HOME, 'Library', 'Android', 'sdk');
const CMAKE = path.join(SDK, 'cmake', '4.1.2', 'bin');
const NDK_JNI_H = path.join(SDK, 'ndk', '30.0.16248370', 'toolchains', 'llvm', 'prebuilt', 'darwin-x86_64', 'sysroot', 'usr', 'include', 'jni.h');
const JAVA_HOME = process.env.JAVA_HOME ?? '/Applications/Android Studio.app/Contents/jbr/Contents/Home';

fs.mkdirSync(OUT, { recursive: true });
execFileSync(path.join(ANDROID, 'scripts', 'fetch-llama.sh'), [], { stdio: 'inherit' });
if (MODEL !== 'none' && !fs.existsSync(path.join(MODEL, 'model.json'))) {
    console.error(`no model in ${MODEL}: run android/scripts/prepare-model.sh <gguf> (or pass --no-model)`);
    process.exit(2);
}

console.log('building liblcllm.dylib…');
const build = path.join(OUT, 'cmake');
execFileSync(path.join(CMAKE, 'cmake'), ['-S', path.join(ANDROID, 'llm', 'src', 'main', 'cpp'), '-B', build, '-G', 'Ninja',
    `-DCMAKE_MAKE_PROGRAM=${path.join(CMAKE, 'ninja')}`, '-DLC_HOST=ON', '-DCMAKE_BUILD_TYPE=Release', `-DNDK_JNI_H=${NDK_JNI_H}`], { stdio: ['ignore', 'ignore', 'inherit'] });
execFileSync(path.join(CMAKE, 'cmake'), ['--build', build], { stdio: 'inherit' });

const mock = await startMockClaude({ port: PORT });
const lines = [];
const prompts = path.join(REPO, 'web', 'test', 'lm', 'bench-prompts.json');
const code = await new Promise(resolve => {
    const child = spawn(path.join(ANDROID, 'gradlew'), ['-q', '--console=plain', ':botchat:lmHarness', `-PlcllmDir=${build}`, `--args=${mock.url} ${MODEL} ${prompts}`], {
        cwd: ANDROID,
        env: { ...process.env, JAVA_HOME, ANDROID_HOME: SDK },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let pending = '';
    const onData = chunk => {
        pending += chunk.toString();
        let i;
        while ((i = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, i);
            pending = pending.slice(i + 1);
            lines.push(line);
            if (/^(CHECK|INFO|DONE)/.test(line) || /\[lm\]/.test(line) || /^FAILURE|^\s*> /.test(line)) {
                console.log(line);
            }
        }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', resolve);
});

// every request the app made, as the API takes it
const requests = mock.requests;
const wrong = requests.filter(r => r.problems.length);
const keys = new Set(requests.map(r => r.key));
const body = requests[0]?.body;
const sample = body && {
    model: body.model,
    max_tokens: body.max_tokens,
    thinking: body.thinking,
    output_config: body.output_config,
    system: body.system?.map(b => ({ type: b.type, chars: b.text?.length, cache_control: b.cache_control ?? null })),
    messages: body.messages?.map(m => ({ role: m.role, chars: m.content?.length }))
};
console.log(`mock: ${requests.length} requests, ${wrong.length} malformed, keys …${[...keys].join(', …')}; the first: ${JSON.stringify(sample)}; headers ${JSON.stringify(requests[0]?.headers)}`);
for (const r of wrong) {
    console.log(`CHECK FAIL a request the API would refuse — ${r.problems.join('; ')}`);
}
await mock.close();
fs.writeFileSync(path.join(OUT, 'run.log'), `${lines.join('\n')}\n`);
const summary = lines.find(l => l.startsWith('DONE'));
const ok = code === 0 && wrong.length === 0 && !!summary && requests.length > 0;
console.log(`${ok ? 'PASS' : 'FAIL'}: ${summary ?? 'the harness did not finish'}${wrong.length ? `, ${wrong.length} malformed requests` : ''} (log: ${path.relative(REPO, path.join(OUT, 'run.log'))})`);
process.exit(ok ? 0 : 1);
