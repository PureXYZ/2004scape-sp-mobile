#!/usr/bin/env node
// The on-device model's prompt for training situations (the realism work, phase 7, Track L): port/BotModelPrompt's
// renderLocal (THE TRAINING FORMAT) of each line of a situations file (situations.jsonl, eval.jsonl or a batch: any
// JSON lines with {id, situation}), printed as the model sees it, or as JSON lines {id, system, user} with --jsonl.
//
//   node web/engine/bots/test/model-data/render.mjs <file.jsonl> [--id=s0001,s0002] [--limit=N] [--jsonl] [--online]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { importInEngine } from '../lib/clone.mjs';

process.removeAllListeners('warning'); // (the engine's SQLite notice)
const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => ((m => (m ? [m[1], m[2] ?? 'true'] : [a, 'true']))(a.match(/^--([^=]+)(?:=(.*))?$/)))));
const file = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!file) {
    console.error('usage: render.mjs <file.jsonl> [--id=a,b] [--limit=N] [--jsonl] [--online]');
    process.exit(2);
}
const rows = fs
    .readFileSync(path.resolve(file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
const ids = args.id ? new Set(args.id.split(',')) : null;
let picked = rows.filter(r => !ids || ids.has(r.id));
if (args.limit) picked = picked.slice(0, Number(args.limit));
const lib = await importInEngine(path.join(here, 'guard-lib.ts'), 'model-render');
for (const r of picked) {
    if (args.online === 'true') {
        const p = lib.renderOnline(r.situation);
        if (args.jsonl === 'true') console.log(JSON.stringify({ id: r.id, context: p.context, user: p.user }));
        else console.log(`── ${r.id} (online) ──\n[context]\n${p.context}\n[user]\n${p.user}\n`);
        continue;
    }
    const p = lib.renderLocal(r.situation);
    if (args.jsonl === 'true') console.log(JSON.stringify({ id: r.id, system: p.system, user: p.user }));
    else console.log(`── ${r.id} ──\n[system]\n${p.system}\n[user]\n${p.user}\n`);
}
