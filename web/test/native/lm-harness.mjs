#!/usr/bin/env node
// The bots' chat model's native side on the Mac: compiles the app's BotChatModel, OnlineModel, LocalModel and
// ModelKeyStore (LostCity/*.swift) with web/test/native/lm-harness/*.swift against the macOS slice of llama.cpp's
// framework (ios/scripts/fetch-llama.sh), starts the local mock of the Messages API (web/test/lm/mock-claude.mjs) and runs
// the router through the page's requests: the on-device model, Claude online with a good key, every failure falling
// back (a refused key, rate limits, overload, a server error, a refusal, an empty reply), the Test (no fallback), a slow
// API given up on in time, and 'busy' past 3 at once; the requests' think (Settings › Bot chat › Think first) with a model
// that offers the choice (template 'qwen-chatml-hybrid'): no note when off, the note first when on (also on Claude's
// fallback to the model), the note never in the reply, the timings' noteTokens; and the templates that decide alone. Last
// it checks every request the mock got: the API's fields, as docs/ARCHITECTURE.md §7.1 lists them (a request the mock
// found wrong fails the run: Claude online ignores think). No real API call, no key.
//
//   node web/test/native/lm-harness.mjs [--no-model] [--port 47590]
//   (the on-device model from build/Model: ios/scripts/prepare-model.sh --spike; --no-model runs without one. A hybrid
//   stand-in: the base GGUF cloned into a folder with a model.json {"name": ..., "template": "qwen-chatml-hybrid"},
//   then ios/scripts/prepare-model.sh <that folder>/<the gguf>)
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockClaude } from '../lm/mock-claude.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IOS = path.resolve(HERE, '..', '..', '..');
const OUT = path.join(IOS, 'build', 'tmp', 'lm-harness');
const argv = process.argv.slice(2);
const PORT = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : 47590;
const FRAMEWORKS = path.join(IOS, 'build', 'Vendor', 'llama.xcframework', 'macos-arm64_x86_64');
const MODEL = argv.includes('--no-model') ? 'none' : path.join(IOS, 'build', 'Model');

fs.mkdirSync(OUT, { recursive: true });
execFileSync(path.join(IOS, 'ios', 'scripts', 'fetch-llama.sh'), [], { stdio: 'inherit' });
if (MODEL !== 'none' && !fs.existsSync(path.join(MODEL, 'model.json'))) {
    console.error('no model in build/Model: run ios/scripts/prepare-model.sh --spike (or pass --no-model)');
    process.exit(2);
}

const binary = path.join(OUT, 'lm-harness');
const sources = ['LocalModel.swift', 'OnlineModel.swift', 'BotChatModel.swift', 'ModelKeyStore.swift'].map(f => path.join(IOS, 'ios', 'LostCity', f));
console.log('compiling the harness…');
execFileSync('swiftc', ['-O', '-swift-version', '6', '-F', FRAMEWORKS, '-framework', 'llama', '-Xlinker', '-rpath', '-Xlinker', FRAMEWORKS, ...sources, path.join(HERE, 'lm-harness', 'LogStub.swift'), path.join(HERE, 'lm-harness', 'main.swift'), '-o', binary], { stdio: 'inherit' });

const mock = await startMockClaude({ port: PORT });
const lines = [];
const code = await new Promise(resolve => {
    const child = spawn(binary, [mock.url, MODEL, path.join(IOS, 'web', 'test', 'lm', 'bench-prompts.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '';
    const onData = chunk => {
        pending += chunk.toString();
        let i;
        while ((i = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, i);
            pending = pending.slice(i + 1);
            lines.push(line);
            if (/^(CHECK|INFO|DONE)/.test(line) || /\[lm\]/.test(line)) {
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
console.log(`${ok ? 'PASS' : 'FAIL'}: ${summary ?? 'the harness did not finish'}${wrong.length ? `, ${wrong.length} malformed requests` : ''} (log: ${path.relative(IOS, path.join(OUT, 'run.log'))})`);
process.exit(ok ? 0 : 1);
