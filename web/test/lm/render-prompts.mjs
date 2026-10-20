#!/usr/bin/env node
// Renders real reply situations (humanlike's --model-capture: JSON lines {kind, ruleText, situation, ...}) into the
// prompts the bots send (port/BotModelPrompt renderLocal and renderOnline), for the phone spike's generation bench
// (autotest.js lm-bench, app-test.mjs --lm-bench) and the native tests: web/test/lm/bench-prompts.json.
//
//   node web/test/lm/render-prompts.mjs <capture.jsonl> [out.json]
//   (the capture: e.g. the phase 7 training data's foundation-capture-s6.jsonl, which is not published with the repo;
//   PHASE7_DATA=<that folder> stands for it. The output defaults to web/test/lm/bench-prompts.json)
//
// It picks a spread of situations (each way a line reaches a bot, with and without the rules' answer), and gives the
// human the 2004 name "Dark Lord 91" in place of the sims' "Sim Human". Run it from anywhere: the engine's modules come
// from a clone in build/tmp (the bot library's test harness), so nothing is written next to the caller.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IOS = path.resolve(HERE, '..', '..', '..');
const CAPTURE_ARG = process.argv[2] ?? (process.env.PHASE7_DATA ? path.join(process.env.PHASE7_DATA, 'foundation-capture-s6.jsonl') : null);
if (!CAPTURE_ARG) {
    console.error('render-prompts: give the capture (<phase7-data>/foundation-capture-s6.jsonl, or PHASE7_DATA): the training data is not published with the repo');
    process.exit(2);
}
const CAPTURE = path.resolve(CAPTURE_ARG);
const OUT = path.resolve(process.argv[3] ?? path.join(HERE, 'bench-prompts.json'));
const HUMAN = 'Dark Lord 91';
const PICK = 16;

const rows = fs
    .readFileSync(CAPTURE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(row => row.situation?.v === 1 && !['market', 'reaction'].includes(row.situation.heard?.via));

// a spread: round-robin over (via, hint or none), in capture order
const groups = new Map();
for (const row of rows) {
    const key = `${row.situation.heard.via}/${row.situation.hint ? 'hint' : 'none'}`;
    if (!groups.has(key)) {
        groups.set(key, []);
    }
    groups.get(key).push(row);
}
const picked = [];
for (let round = 0; picked.length < PICK && round < 64; round++) {
    for (const list of groups.values()) {
        if (list[round] && picked.length < PICK) {
            picked.push(list[round]);
        }
    }
}

const { importInEngine } = await import(path.join(IOS, 'web', 'engine', 'bots', 'test', 'lib', 'clone.mjs'));
const prompts = await importInEngine(path.join(IOS, 'web', 'engine', 'bots', 'src', 'port', 'BotModelPrompt.ts'), 'lm-prompts');

const renamed = situation => {
    const from = situation.human.name;
    const s = structuredClone(situation);
    s.human.name = HUMAN;
    s.history = s.history.map(line => (line.who === 'them' || line.name === from ? { ...line, name: HUMAN } : line));
    return s;
};

const out = picked.map((row, i) => {
    const situation = renamed(row.situation);
    return {
        id: i + 1,
        kind: row.kind,
        via: situation.heard.via,
        intent: situation.hint?.intent ?? null,
        heard: situation.heard.text,
        ruleText: row.ruleText,
        local: prompts.renderLocal(situation),
        online: prompts.renderOnline(situation)
    };
});
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify({ source: path.basename(CAPTURE), human: HUMAN, prompts: out }, null, 1)}\n`);
const chars = out.map(p => p.local.system.length + p.local.user.length);
console.log(`${out.length} prompts (${[...new Set(out.map(p => `${p.via}/${p.intent ?? 'none'}`))].join(', ')}) -> ${path.relative(IOS, OUT)}; local prompt ${Math.min(...chars)}-${Math.max(...chars)} chars`);
process.exit(0);
