#!/usr/bin/env node
// The language model's training data (the realism work, phase 7, Track L: the research): each written
// situation rendered by port/BotModelPrompt renderLocal (THE TRAINING FORMAT: the on-device prompt's system and user
// turns) with the writers' reply as the assistant turn, in mlx-lm's chat format. The tokenizer's own chat template adds
// the empty think block (`<think>\n\n</think>\n\n`) before an assistant turn that follows the last user turn, exactly as
// at inference (native's qwen-chatml-nothink), so `--mask-prompt` trains on the reply and its <|im_end|> only.
//
// In:  phase7-data/situations.jsonl ({id, split, batch, kind, ruleText, situation}: 3,000 train, 300 eval; the retrain's
//      data dir, phase7-data-r2, adds 1,000 train and 150 target, ids r2-NNNN)
//      phase7-data/replies/batch-NN.jsonl ({id, reply}: the writers', checked by check-replies.mjs; target rows too)
// Out: <out>/train.jsonl, <out>/valid.jsonl   {"messages": [system, user, assistant]} (valid: 1 in 20, by via, chosen
//                                            in each round apart: the first 3,000 give the same 150 as before, the
//                                            retrain's 1,000 another 50)
//      <out>/eval-prompts.jsonl              {id, via, hint, kind, ruleText, system, user, situation} (the 300 held out)
//      <out>/valid-prompts.jsonl             the same for the valid situations (choosing an epoch)
//      <out>/target-prompts.jsonl            the same for the target situations (split 'target': the retrain's
//                                            targeted test, never trained on nor in valid), with `focus` and
//                                            `reference` (the writers' reply, or null)
//      <out>/target-writers.json             {id: the writers' reply} for the target situations (review.mjs blind-build's
//                                            --claude: the writers' lines against the model's)
//      <out>/calibration.txt                 the train examples as the model reads them (llama-imatrix's input for the
//                                            Q4_K_M quantization; never the eval set)
//      <out>/manifest.json                   counts, the valid ids, the replies' sha256
//
// (bots ideas, round 5: I stage 2, the r3 data: select-r3.mjs) The new kinds (a row with `ambient`: a reaction to the human,
// a bot's turn in the bots' own talk) are plain-only: their reply without a note in every mode (ambient lines never ask
// for Think first), --plain-repeat times (default 1) beside round 2's rows; their own valid share (1 in 20, as each round's);
// their target splits ('target-react', 'target-turn': never trained on, never in valid) as <out>/target-react-prompts.jsonl
// and target-turn-prompts.jsonl (with `group` and `reference`) and target-react-writers.json, target-turn-writers.json.
// Their replies: replies/batch-r3-react-NN.jsonl and batch-r3-turn-NN.jsonl beside round 2's batch-NN.jsonl.
//
//   node web/engine/bots/test/model-data/assemble.mjs [--data=<phase7-data>] [--out=<phase7-data>/lm] [--valid-every=20] [--plain-repeat=1]
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { importInEngine } from '../lib/clone.mjs';
import { chatExample, chatExampleThink, thinkContent } from './chatml.mjs';

process.removeAllListeners('warning'); // (the engine's SQLite notice)
const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => ((m => (m ? [m[1], m[2] ?? 'true'] : [a, 'true']))(a.match(/^--([^=]+)(?:=(.*))?$/)))));
// (the phase 7 training data is not published with the repo: --data or PHASE7_DATA names a copy of it)
const DATA_ARG = args.data ?? process.env.PHASE7_DATA;
if (!DATA_ARG) {
    console.error('assemble: --data=<phase7-data> (or PHASE7_DATA) is required: the training data is not published with the repo');
    process.exit(2);
}
const DATA = path.resolve(DATA_ARG);
const OUT = path.resolve(args.out ?? path.join(DATA, 'lm'));
const VALID_EVERY = Number(args['valid-every'] ?? 20);
// (the note variant, : notes.mjs's {id, note} per situation; the assistant turn is the note in the
// think block, then the reply)
// --both ("maybe thinking can be an option"): every training example twice, without its note and with it, so
// one model replies at once or writes its note first, as the prompt asks (Qwen3.5's own thinking switch); the valid set too
const BOTH = args.both === 'true';
const NOTES = args.notes ? new Map(fs.readFileSync(path.resolve(args.notes), 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)).map(r => [r.id, r.note])) : null;
// (bots ideas, round 5: I stage 2) each plain-only row (the new kinds) this many times in train
const PLAIN_REPEAT = Math.max(1, Number(args['plain-repeat'] ?? 1));
/** a row of the new kinds (select-r3.mjs): plain-only */
const plainOnly = r => typeof r.ambient === 'string';
/** the r3 target splits */
const AMBIENT_TARGETS = ['target-react', 'target-turn'];

const readJsonl = file =>
    fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l));

const situations = readJsonl(path.join(DATA, 'situations.jsonl'));
const replies = new Map();
const repliesHash = crypto.createHash('sha256');
const replyFiles = fs
    .readdirSync(path.join(DATA, 'replies'))
    .filter(f => /^batch-(\d\d|r3-(react|turn)-\d\d)\.jsonl$/.test(f))
    .sort();
for (const f of replyFiles) {
    const text = fs.readFileSync(path.join(DATA, 'replies', f), 'utf8');
    repliesHash.update(text);
    for (const row of text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l))) {
        if (replies.has(row.id)) throw new Error(`assemble: ${row.id} has two replies`);
        replies.set(row.id, row.reply);
    }
}

const train = situations.filter(r => r.split === 'train');
const evalRows = situations.filter(r => r.split === 'eval');
const targetRows = situations.filter(r => r.split === 'target');
const ambientTargets = Object.fromEntries(AMBIENT_TARGETS.map(split => [split, situations.filter(r => r.split === split)]));
const unknownSplit = situations.filter(r => !['train', 'eval', 'target', ...AMBIENT_TARGETS].includes(r.split));
if (unknownSplit.length) throw new Error(`assemble: unknown split ${unknownSplit[0].split} (${unknownSplit[0].id})`);
const missing = train.filter(r => typeof replies.get(r.id) !== 'string' || !replies.get(r.id).trim());
if (missing.length) throw new Error(`assemble: ${missing.length} train situations have no reply (${missing.slice(0, 5).map(r => r.id).join(', ')} ...)`);
const replyable = new Set([...train, ...targetRows, ...Object.values(ambientTargets).flat()].map(r => r.id));
const stray = [...replies.keys()].filter(id => !replyable.has(id));
if (stray.length) throw new Error(`assemble: replies for ids that are not train or target situations: ${stray.slice(0, 5).join(', ')}`);
const targetMissing = targetRows.filter(r => typeof replies.get(r.id) !== 'string' || !replies.get(r.id).trim());
if (targetMissing.length) console.warn(`assemble: ${targetMissing.length} target situations have no writers' reply (their reference is null)`);
for (const r of situations) {
    const s = r.situation;
    const texts = [s.heard.text, s.hint?.text ?? '', ...s.history.map(h => h.text), s.human.name, s.bot.name];
    if (texts.some(t => t.includes('<|') || t.includes('|>'))) throw new Error(`assemble: ${r.id} has a chat-template marker in its text`);
}

// the validation set: every VALID_EVERY-th of the train situations ordered by via then id (each via in proportion), in
// each round apart (the first data's s-ids, the retrain's r2- ids): the first 3,000 keep their 150
const roundOf = id => (id.match(/^(r\d+)-/)?.[1] ?? 'r1');
const validIds = new Set();
for (const round of [...new Set(train.map(r => roundOf(r.id)))].sort()) {
    const ordered = train.filter(r => roundOf(r.id) === round).sort((a, b) => a.situation.heard.via.localeCompare(b.situation.heard.via) || a.id.localeCompare(b.id));
    for (const r of ordered.filter((_, i) => i % VALID_EVERY === Math.floor(VALID_EVERY / 2))) validIds.add(r.id);
}

const lib = await importInEngine(path.join(here, 'guard-lib.ts'), 'model-assemble');
fs.mkdirSync(OUT, { recursive: true });
const out = { train: [], valid: [] };
const calibration = [];
for (const r of train) {
    const p = lib.renderLocal(r.situation);
    // ---- (bots ideas, round 5: I stage 2) a row of the new kinds: its reply alone, in every mode ----
    if (plainOnly(r)) {
        if (!validIds.has(r.id)) calibration.push(chatExample(p.system, p.user, replies.get(r.id)));
        const row = JSON.stringify({ messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }, { role: 'assistant', content: replies.get(r.id).trim() }] });
        if (validIds.has(r.id)) out.valid.push(row);
        else for (let k = 0; k < PLAIN_REPEAT; k++) out.train.push(row);
        continue;
    }
    // ---- end of I stage 2's block ----
    const note = NOTES ? NOTES.get(r.id) : null;
    if (NOTES && typeof note !== 'string') throw new Error(`assemble: ${r.id} has no note`);
    if (!validIds.has(r.id)) calibration.push(NOTES ? chatExampleThink(p.system, p.user, note, replies.get(r.id)) : chatExample(p.system, p.user, replies.get(r.id)));
    if (!validIds.has(r.id) && NOTES && BOTH) calibration.push(chatExample(p.system, p.user, replies.get(r.id)));
    const forms = NOTES && BOTH ? [thinkContent(note, replies.get(r.id)), replies.get(r.id).trim()] : [NOTES ? thinkContent(note, replies.get(r.id)) : replies.get(r.id).trim()];
    for (const content of forms) {
        const row = { messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }, { role: 'assistant', content }] };
        (validIds.has(r.id) ? out.valid : out.train).push(JSON.stringify(row));
    }
}
fs.writeFileSync(path.join(OUT, 'train.jsonl'), out.train.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'valid.jsonl'), out.valid.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'calibration.txt'), calibration.join(''));
const promptRow = r => {
    const p = lib.renderLocal(r.situation);
    return JSON.stringify({ id: r.id, via: r.situation.heard.via, hint: r.situation.hint, kind: r.kind, ruleText: r.ruleText, system: p.system, user: p.user, situation: r.situation });
};
const evalOut = evalRows.map(promptRow);
fs.writeFileSync(path.join(OUT, 'eval-prompts.jsonl'), evalOut.join('\n') + '\n');
// (the valid set as prompts too: choosing between epochs on it keeps the held-out 300 for the final evaluation)
fs.writeFileSync(path.join(OUT, 'valid-prompts.jsonl'), train.filter(r => validIds.has(r.id)).map(promptRow).join('\n') + '\n');
// (the retrain's targeted test: never trained on, never in valid; the writers' replies beside it as the reference)
for (const f of ['target-prompts.jsonl', 'target-writers.json']) if (fs.existsSync(path.join(OUT, f))) fs.rmSync(path.join(OUT, f));
if (targetRows.length) {
    fs.writeFileSync(
        path.join(OUT, 'target-prompts.jsonl'),
        targetRows.map(r => JSON.stringify({ ...JSON.parse(promptRow(r)), focus: r.focus ?? null, reference: replies.get(r.id)?.trim() || null })).join('\n') + '\n'
    );
    fs.writeFileSync(path.join(OUT, 'target-writers.json'), JSON.stringify(Object.fromEntries(targetRows.filter(r => replies.get(r.id)?.trim()).map(r => [r.id, replies.get(r.id).trim()])), null, 1) + '\n');
}

// ---- (bots ideas, round 5: I stage 2) the r3 target splits: never trained on, never in valid ----
for (const split of AMBIENT_TARGETS) {
    for (const f of [`${split}-prompts.jsonl`, `${split}-writers.json`]) if (fs.existsSync(path.join(OUT, f))) fs.rmSync(path.join(OUT, f));
    const rows = ambientTargets[split];
    if (!rows.length) continue;
    fs.writeFileSync(path.join(OUT, `${split}-prompts.jsonl`), rows.map(r => JSON.stringify({ ...JSON.parse(promptRow(r)), group: r.group ?? null, event: r.event ?? null, reference: replies.get(r.id)?.trim() || null })).join('\n') + '\n');
    fs.writeFileSync(path.join(OUT, `${split}-writers.json`), JSON.stringify(Object.fromEntries(rows.filter(r => replies.get(r.id)?.trim()).map(r => [r.id, replies.get(r.id).trim()])), null, 1) + '\n');
}
// ---- end of I stage 2's block ----

const byVia = rows => rows.reduce((m, r) => ((m[r.situation.heard.via] = (m[r.situation.heard.via] ?? 0) + 1), m), {});
const manifest = {
    made: 'web/engine/bots/test/model-data/assemble.mjs',
    format: NOTES
        ? 'mlx-lm chat {messages: [system, user, assistant]}; renderLocal (port/BotModelPrompt) of each situation; the assistant turn is <think>\\n{note}\\n</think>\\n\\n{reply} (the note variant: notes.mjs)'
        : 'mlx-lm chat {messages: [system, user, assistant]}; renderLocal (port/BotModelPrompt) of each situation; the chat template adds <think>\\n\\n</think>\\n\\n before the reply',
    notes: NOTES ? { file: path.resolve(args.notes), count: NOTES.size, both: BOTH } : null,
    replies: { files: replyFiles.length, count: replies.size, sha256: repliesHash.digest('hex') },
    train: { count: out.train.length, byVia: byVia(train.filter(r => !validIds.has(r.id))) },
    valid: { count: out.valid.length, byVia: byVia(train.filter(r => validIds.has(r.id))), every: VALID_EVERY, ids: [...validIds].sort() },
    eval: { count: evalOut.length, byVia: byVia(evalRows) }
};
if (targetRows.length) manifest.target = { count: targetRows.length, byVia: byVia(targetRows), withReference: targetRows.length - targetMissing.length };
// (bots ideas, round 5: I stage 2) the new kinds: plain-only rows in train and valid, and their target splits
{
    const plain = train.filter(plainOnly);
    if (plain.length) manifest.plainOnly = { repeat: PLAIN_REPEAT, train: plain.filter(r => !validIds.has(r.id)).length, valid: plain.filter(r => validIds.has(r.id)).length, byVia: byVia(plain) };
    for (const split of AMBIENT_TARGETS) if (ambientTargets[split].length) manifest[split] = { count: ambientTargets[split].length, byVia: byVia(ambientTargets[split]), withReference: ambientTargets[split].filter(r => replies.get(r.id)?.trim()).length };
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`assemble: train ${out.train.length}, valid ${out.valid.length}, eval ${evalOut.length}${targetRows.length ? `, target ${targetRows.length}` : ''}${AMBIENT_TARGETS.filter(t => ambientTargets[t].length).map(t => `, ${t} ${ambientTargets[t].length}`).join('')}${manifest.plainOnly ? ` (plain-only rows of the new kinds: train ${manifest.plainOnly.train} x${PLAIN_REPEAT}, valid ${manifest.plainOnly.valid})` : ''} -> ${OUT}`);
