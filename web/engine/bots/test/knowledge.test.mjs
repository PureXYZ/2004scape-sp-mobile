#!/usr/bin/env node
// BotKnowledge against the real 274 map (test/lib/knowledge.ts): from each gathering, thieving and combat step's spot,
// that step's own task's search finds something to do (a mining step its own ore). On a members world, so every
// step is in the map; a step with nothing in reach fails.
//
//   node web/engine/bots/test/knowledge.test.mjs [--all]   (--all: list every step)
import path from 'path';
import { BOTS_DIR } from './lib/paths.mjs';
import { importInEngine, simWorldConfig } from './lib/clone.mjs';

for (const level of ['log', 'info', 'debug', 'warn']) console[level] = () => {};
const ALL = process.argv.includes('--all');
const out = s => process.stdout.write(`${s}\n`);

const lib = await importInEngine(path.join(BOTS_DIR, 'test/lib/knowledge.ts'), 'unit-knowledge', simWorldConfig({ members: true }));
await lib.World.start(false, false);
const results = lib.checkSteps();
const bad = results.filter(r => !r.own);
out(`knowledge: ${results.length} steps checked against the 274 map (${results.filter(r => r.members).length} in members' areas); ${bad.length} with nothing of their own in reach`);
for (const r of ALL ? results : bad) out(`${r.own ? 'ok  ' : 'FAIL'} ${r.skill} ${r.action} at ${r.at}: ${r.what} → ${r.found ?? 'nothing'}`);
process.exit(bad.length ? 1 : 0);
