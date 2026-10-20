#!/usr/bin/env node
// The writers' checker (the realism work, phase 7, Track L: the research): a batch of training situations
// (phase7-data/batches/batch-NN.jsonl, {id, situation, ruleText, kind} a line) against the replies written for it
// (phase7-data/replies/batch-NN.jsonl, {id, reply} a line). It reports, by id:
//   format     a line that is not JSON {id, reply} with a string reply; an id twice; an id the batch lacks (extra); an id
//              of the batch with no reply (missing)
//   length     over 80 characters (274's chat line), or empty
//   charset    a character the chat codec cannot carry (it carries a-z 0-9, the space and !?.,:;()-&*'@#+=£$%"[])
//   guard      the foundation's guard (port/BotModelGuard guardReply) refuses it, with its reason (assistant,
//              anachronism, confession, filter: the game's word filter would star a word, long, charset, empty), or
//              changes it (a name or quotes in front, a second line): write the line itself, nothing around it
//   effect     brb, gtg, afk, bbl, logging off: each is an action in the rules (an AFK, a logout) that would not follow
//   promise    an offer or agreement to trade, follow, meet, give, lend, come, teach, show ("ill give u", "follow me",
//              "meet me at", "omw", "here u go"): a model line never commits a bot to anything
//   level      a number next to a skill, "lvl", "cb", "combat" or "total" that is not the bot's level ("60 wc" with wc 58);
//              a goal ("going for 60 wc", "almost 60") must be above it
//   number     any other number the situation does not have (its facts, the hint, the chat), except 99 and round goals:
//              no invented times, counts, prices or ages
//   repeat     the bot's own earlier line again, or the human's line echoed back (lines of 3+ words)
//   name-rate  the human's name in more than 1 reply in 8 of the batch (most replies never say it)
//   placeholder a "{name}" left in
// and, without failing, warnings: a number of the hint's that the reply drops, the same reply 4+ times in the batch,
// and (the retrain's weak spots) a best or highest skill named that is not the bot's highest level when the human asked
// for it (best-skill).
// The retrain's batches (phase7-data-r2, batch-20..25) carry split (train or target) and the current model's line
// (modelReply, modelGuard): the checker ignores them, except to count the replies that keep the model's line as it is.
// Exit 0 when nothing fails, 1 when something does, 2 on a usage error.
//
//   node web/engine/bots/test/model-data/check-replies.mjs <batch.jsonl> <replies.jsonl> [--quiet]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { importInEngine } from '../lib/clone.mjs';
import { CHARSET, MAX, checkReply } from './checks.mjs';

/** the skills' words (checks.mjs's, less combat and total, and less the verbs "mine", "fish", "cook") for the best-skill warning */
const SKILL_NAMES = {
    att: 'att|attack', str: 'str|strength', def: 'def|defence|defense', hp: 'hp|hitpoints', range: 'range|ranged|ranging', pray: 'pray|prayer', mage: 'mage|magic', cook: 'cooking',
    wc: 'wc|woodcutting|woodcut', fletch: 'fletch|fletching', fish: 'fishing', fm: 'fm|firemaking', craft: 'craft|crafting', smith: 'smith|smithing', mine: 'mining', herb: 'herb|herblore',
    agil: 'agil|agility', thief: 'thief|thieving', rc: 'rc|runecraft|runecrafting'
};
const ASKS_BEST = /\b(best|highest|top|main) (skill|lvl|level)|\bwhats ur (best|highest)\b|\bur (best|highest)\b|\bwhat skill is ur highest\b|\bso whats ur best\b|\band ur highest\b/;
/** a skill the reply names as the bot's best that is not its highest level (null: none, or right) */
function wrongBest(s, reply) {
    if (!ASKS_BEST.test(s.heard.text.toLowerCase())) return null;
    const t = reply.toLowerCase();
    const top = Math.max(...Object.values(s.facts.levels));
    for (const [skill, words] of Object.entries(SKILL_NAMES)) {
        const m = t.match(new RegExp(`\\b(${words})\\b`));
        if (!m) continue;
        // (a skill named with a number is checked by the level check; one named alone must be a highest)
        if (s.facts.levels[skill] < top && !new RegExp(`\\b(${words})\\s*\\d|\\d+\\s*(${words})\\b`).test(t)) return `"${m[0]}" (${s.facts.levels[skill]}) is not its best: the highest is ${top} (${Object.entries(s.facts.levels).filter(([, v]) => v === top).map(([k]) => k).join(', ')})`;
    }
    return null;
}

process.removeAllListeners('warning'); // (the engine's SQLite notice)
const here = path.dirname(fileURLToPath(import.meta.url));
const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
const QUIET = process.argv.includes('--quiet');
if (files.length !== 2) {
    console.error('usage: node web/engine/bots/test/model-data/check-replies.mjs <batch.jsonl> <replies.jsonl> [--quiet]');
    process.exit(2);
}
const [batchFile, repliesFile] = files.map(f => path.resolve(f));
for (const f of [batchFile, repliesFile]) {
    if (!fs.existsSync(f)) {
        console.error(`check-replies: no such file: ${f}`);
        process.exit(2);
    }
}

function readJsonl(file) {
    const rows = [];
    const bad = [];
    fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
            if (!line.trim()) return;
            try {
                rows.push(JSON.parse(line));
            } catch {
                bad.push(i + 1);
            }
        });
    return { rows, bad };
}

const lib = await importInEngine(path.join(here, 'guard-lib.ts'), 'model-check');
lib.loadWordEnc();

const batch = readJsonl(batchFile);
const replies = readJsonl(repliesFile);
const failures = [];
const warnings = [];
const fail = (id, reason, detail, reply) => failures.push({ id, reason, detail, reply });
const warn = (id, reason, detail, reply) => warnings.push({ id, reason, detail, reply });
for (const n of batch.bad) fail(`(batch line ${n})`, 'format', 'the batch line is not JSON', '');
for (const n of replies.bad) fail(`(replies line ${n})`, 'format', 'not a JSON line', '');

const byId = new Map(batch.rows.map(r => [r.id, r]));
const seen = new Map();
for (const row of replies.rows) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string') {
        fail('(no id)', 'format', `a line without a string id: ${JSON.stringify(row).slice(0, 80)}`, '');
        continue;
    }
    const keys = Object.keys(row).sort().join(',');
    if (keys !== 'id,reply') fail(row.id, 'format', `fields are {id, reply} only (got ${keys})`, row.reply ?? '');
    if (seen.has(row.id)) {
        fail(row.id, 'format', 'the id twice', row.reply ?? '');
        continue;
    }
    seen.set(row.id, row);
    if (!byId.has(row.id)) fail(row.id, 'extra', 'not an id of this batch', row.reply ?? '');
}
for (const id of byId.keys()) if (!seen.has(id)) fail(id, 'missing', 'no reply', '');

let named = 0;
let checked = 0;
let lower = 0;
let modelKept = 0;
let modelRows = 0;
const counts = new Map();
for (const [id, row] of seen) {
    const item = byId.get(id);
    if (!item) continue;
    const reply = row.reply;
    if (typeof reply !== 'string') {
        fail(id, 'format', 'reply is not a string', String(reply));
        continue;
    }
    checked++;
    const s = item.situation;
    if (!reply.trim()) {
        fail(id, 'length', 'empty', reply);
        continue;
    }
    if (reply.length > MAX) fail(id, 'length', `${reply.length} characters (at most ${MAX})`, reply);
    const lost = [...new Set([...reply].filter(ch => !CHARSET.test(ch.toLowerCase())))];
    if (lost.length) fail(id, 'charset', `the chat cannot carry ${lost.map(c => JSON.stringify(c)).join(' ')}`, reply);
    const g = lib.guardReply(reply, s);
    if (!g.ok) fail(id, 'guard', g.reason, reply);
    else if (g.text !== reply.trim()) fail(id, 'guard', `changed to "${g.text}": write the line alone (no name in front, no quotes, one line)`, reply);
    const c = checkReply(s, item.ruleText, reply);
    for (const f of c.failures) fail(id, f.reason, f.detail, reply);
    if (c.named) named++;
    // warnings
    for (const n of c.hintDropped) warn(id, 'hint-number', `the hint says ${n}; keep its facts unless the line has no room for them`, reply);
    const best = wrongBest(s, reply);
    if (best) warn(id, 'best-skill', best, reply);
    if (typeof item.modelReply === 'string') {
        modelRows++;
        if (item.modelReply.trim() === reply.trim()) modelKept++;
    }
    if (reply === reply.toLowerCase()) lower++;
    counts.set(c.norm, (counts.get(c.norm) ?? 0) + 1);
}
if (checked > 0 && named / checked > 1 / 8) fail('(batch)', 'name-rate', `the human's name in ${named} of ${checked} replies (${Math.round((named / checked) * 100)} %): at most 1 in 8`, '');
for (const [r, n] of counts) if (n >= 4) warn('(batch)', 'same-reply', `"${r}" ${n} times: vary it`, '');

if (!QUIET || failures.length) {
    for (const f of failures) console.log(`FAIL ${f.id}  ${f.reason}: ${f.detail}${f.reply ? `  | ${JSON.stringify(f.reply)}` : ''}`);
}
if (!QUIET) for (const w of warnings) console.log(`warn ${w.id}  ${w.reason}: ${w.detail}${w.reply ? `  | ${JSON.stringify(w.reply)}` : ''}`);
const byReason = {};
for (const f of failures) byReason[f.reason] = (byReason[f.reason] ?? 0) + 1;
console.log(
    `check-replies: ${path.basename(batchFile)}: ${byId.size} situations, ${seen.size} replies, ${checked} checked; ${failures.length} failure(s)${failures.length ? ` (${Object.entries(byReason).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}; ${warnings.length} warning(s); the human's name in ${named}; all lower case ${lower}${modelRows ? `; the model's line kept as it is in ${modelKept} of ${modelRows}` : ''}`
);
process.exit(failures.length ? 1 : 0);
