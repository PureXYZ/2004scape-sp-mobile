#!/usr/bin/env node
// The training data's situations, from the sampler's captures (the realism work, phase 7, Track L's first step:
// the research; test/model-data/sample.mjs makes the captures):
//   1. read every capture (<raw>/*.jsonl: humanlike --model-capture lines);
//   2. drop what the model never writes: the rules-only intents (RULES_ONLY below, from §3: the marketplace, trades, PK
//      and fights, follow and every intent that comes with an action, team-ups, rude lines, the conversation's goodbye;
//      Track E's wantsModel is the binding list) and the second bot's rude lines;
//   3. deduplicate (one situation per run, tick, bot and line; then at most 3 per bot and line in a run, and at most
//      HEARD_CAP of one heard line per via and hint/none across the runs, 6 for the scarce crowd and window, so "lol"
//      does not fill the set);
//   4. replace the sim's "Sim Human" (the human's name, the history's lines of theirs, any echo of it in a line, the
//      rules' line) with a 2004 player name, the same within a situation, never a name already in it;
//   5. pick TOTAL, stratified: by via (named, private, conversation, crowd + second, window: TARGET shares, a scarce
//      stratum all it has), hint vs none (NONE_SHARE of each via: the long tail), and inside each cell by bot kind and
//      age band (square-root shares: the rare kinds and bands lifted; every newbie kept first);
//   6. split EVAL held out (every 11th of the stratified order) and the rest into BATCHES batches dealt in turn from the
//      stratified order, so each batch has the same spread of vias, hint/none, kinds and age bands.
// Writes <data>/situations.jsonl (every picked situation with its id, split, batch and source), <data>/eval.jsonl and
// <data>/batches/batch-NN.jsonl ({id, situation, ruleText, kind} a line), and prints the numbers.
// Deterministic: seeded dice (--seed), the captures' order sorted.
//
//   node web/engine/bots/test/model-data/select.mjs --raw=DIR --data=DIR [--total=3300] [--eval=300] [--batches=19] [--seed=7] [--dry]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { importInEngine } from '../lib/clone.mjs';
import { RULES_ONLY, SECOND_RUDE, mulberry, namesIn, playerNamer, rename, renamed, shuffler } from './select-lib.mjs';

process.removeAllListeners('warning'); // (the engine's SQLite notice)
const here = path.dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(process.argv.slice(2).map(a => ((m => (m ? [m[1], m[2] ?? 'true'] : [a, 'true']))(a.match(/^--([^=]+)(?:=(.*))?$/)))));
if (!args.raw || !args.data) {
    console.error('usage: select.mjs --raw=DIR --data=DIR [--total=3300] [--eval=300] [--batches=19] [--seed=7] [--dry]');
    process.exit(2);
}
const RAW = path.resolve(args.raw);
const DATA = path.resolve(args.data);
const TOTAL = Number(args.total ?? 3300);
const EVAL = Number(args.eval ?? 300);
const BATCHES = Number(args.batches ?? 19);
const DRY = args.dry === 'true';
// (the game's word filter: a human name it would star is never used)
const guard = await importInEngine(path.join(here, 'guard-lib.ts'), 'model-select');
guard.loadWordEnc();
const HEARD_CAP = 4;
/** (the crowd and the reply window: fewer distinct lines reach them, so a line may come a few more times) */
const HEARD_CAP_SCARCE = 6;
/** the vias' shares of the set (crowd and second together); a stratum short of its share gives all it has, the rest is shared out */
const TARGET = { named: 0.3, private: 0.32, conversation: 0.22, crowd: 0.12, window: 0.04 };
/** the share of each via's situations with no hint (nothing understood: the model's long tail) */
const NONE_SHARE = 0.5;

export { RULES_ONLY } from './select-lib.mjs';

const dice = mulberry(Number(args.seed ?? 7));
const shuffle = shuffler(dice);
const playerName = playerNamer(dice, guard);

// ── 1. read ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const files = fs.readdirSync(RAW).filter(f => f.endsWith('.jsonl')).sort();
const raw = [];
for (const file of files) {
    const config = file.replace(/\.jsonl$/, '');
    for (const line of fs.readFileSync(path.join(RAW, file), 'utf8').split('\n')) if (line.trim()) raw.push({ config, ...JSON.parse(line) });
}
const stats = { captures: raw.length, runs: files.length, rulesOnly: 0, dupExact: 0, dupBot: 0, dupHeard: 0 };

// ── 2. the model's replies only ───────────────────────────────────────────────────────────────────────────────────────
const viaGroup = via => (via === 'second' ? 'crowd' : via);
let pool = raw.filter(c => {
    const s = c.situation;
    const intent = s.hint?.intent ?? null;
    const drop = (intent && RULES_ONLY.has(intent)) || (s.heard.via === 'second' && SECOND_RUDE.has(s.hint?.text ?? '')) || s.heard.via === 'market' || s.heard.via === 'reaction';
    if (drop) stats.rulesOnly++;
    return !drop;
});

// ── 3. deduplicate ────────────────────────────────────────────────────────────────────────────────────────────────────
{
    const seen = new Set();
    pool = pool.filter(c => {
        const key = `${c.config}|${c.t}|${c.situation.bot.name}|${c.situation.heard.text}`;
        if (seen.has(key)) return (stats.dupExact++, false);
        seen.add(key);
        return true;
    });
    const perBot = new Map();
    pool = pool.filter(c => {
        const key = `${c.config}|${c.situation.bot.name}|${c.situation.heard.text.toLowerCase()}`;
        const n = (perBot.get(key) ?? 0) + 1;
        perBot.set(key, n);
        if (n > 3) return (stats.dupBot++, false);
        return true;
    });
    // (at most HEARD_CAP of one heard line per via and hint/none: chosen at random)
    const groups = new Map();
    for (const c of pool) {
        const key = `${viaGroup(c.situation.heard.via)}|${c.situation.hint ? 'hint' : 'none'}|${c.situation.heard.text.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
    }
    pool = [];
    for (const [key, list] of groups) {
        shuffle(list);
        // (newbies first: there are few)
        list.sort((a, b) => Number(b.situation.bot.newbie) - Number(a.situation.bot.newbie));
        const cap = /^(crowd|window)\|/.test(key) ? HEARD_CAP_SCARCE : HEARD_CAP;
        pool.push(...list.slice(0, cap));
        stats.dupHeard += Math.max(0, list.length - cap);
    }
}
stats.candidates = pool.length;

// ── 5. stratify ───────────────────────────────────────────────────────────────────────────────────────────────────────
const cells = new Map();
for (const c of pool) {
    const key = `${viaGroup(c.situation.heard.via)}|${c.situation.hint ? 'hint' : 'none'}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(c);
}
/**
 * quota per cell: the via's share, NONE_SHARE of it with no hint; a cell short of its quota gives all it has, and its
 * rest goes first to the same via's other cell (the via keeps its share), then to every cell with room
 */
function quotas() {
    const have = k => cells.get(k)?.length ?? 0;
    const out = new Map();
    for (const [via, share] of Object.entries(TARGET)) {
        const want = Math.round(share * TOTAL);
        let hint = Math.min(have(`${via}|hint`), Math.round(want * (1 - NONE_SHARE)));
        const none = Math.min(have(`${via}|none`), want - hint);
        hint = Math.min(have(`${via}|hint`), want - none);
        out.set(`${via}|hint`, hint);
        out.set(`${via}|none`, none);
    }
    for (let round = 0; round < 20; round++) {
        const total = [...out.values()].reduce((a, b) => a + b, 0);
        const left = TOTAL - total;
        if (left === 0) break;
        const open = [...out.keys()].filter(k => (left > 0 ? have(k) > out.get(k) : out.get(k) > 0));
        if (!open.length) break;
        const weight = open.reduce((a, k) => a + out.get(k) + 1, 0);
        let given = 0;
        for (const k of open) {
            const share = Math.trunc((left * (out.get(k) + 1)) / weight);
            const d = left > 0 ? Math.min(share, have(k) - out.get(k)) : Math.max(share, -out.get(k));
            out.set(k, out.get(k) + d);
            given += d;
        }
        if (given === 0) {
            // (the last few: one at a time to the largest open cells)
            const k = open.sort((x, y) => out.get(y) - out.get(x))[0];
            out.set(k, out.get(k) + Math.sign(left));
        }
    }
    return out;
}
/** inside a cell: newbies first, then by kind and age band, square-root shares */
function pickFrom(list, n) {
    const picked = [];
    const newbies = shuffle(list.filter(c => c.situation.bot.newbie));
    picked.push(...newbies.slice(0, Math.min(newbies.length, Math.ceil(n * 0.12))));
    const rest = list.filter(c => !picked.includes(c));
    const groups = new Map();
    for (const c of rest) {
        const key = `${c.situation.bot.kind}|${c.situation.bot.ageBand}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
    }
    for (const g of groups.values()) shuffle(g);
    const keys = [...groups.keys()].sort();
    // (draws: a group by its weight sqrt(size left), one at a time)
    while (picked.length < n) {
        const live = keys.filter(k => groups.get(k).length);
        if (!live.length) break;
        const w = live.map(k => Math.sqrt(groups.get(k).length));
        let r = dice() * w.reduce((a, b) => a + b, 0);
        let i = 0;
        while (r > w[i] && i < w.length - 1) r -= w[i++];
        picked.push(groups.get(live[i]).pop());
    }
    return picked;
}
const quota = quotas();
let picked = [];
for (const [key, list] of [...cells.entries()].sort()) picked.push(...pickFrom(list, quota.get(key) ?? 0));

// ── 4. the human's name ───────────────────────────────────────────────────────────────────────────────────────────────
picked = picked.map(c => {
    const s = c.situation;
    const taken = namesIn(s);
    let name = playerName();
    while (taken.has(name.toLowerCase())) name = playerName();
    return { ...c, human: name, situation: rename(s, name), ruleText: c.ruleText === null ? null : renamed(c.ruleText, name) };
});

// ── 6. the stratified order, the held-out set, the batches ────────────────────────────────────────────────────────────
const KIND_ORDER = ['skiller', 'fighter', 'balanced', 'random', 'extras_social', 'extras_vendor', 'extras_pker', 'extras_edgeville_pker'];
const stratum = c => [viaGroup(c.situation.heard.via), c.situation.hint ? 'hint' : 'none', String(KIND_ORDER.indexOf(c.situation.bot.kind)).padStart(2, '0'), c.situation.bot.ageBand, c.situation.bot.newbie ? 'n' : 'o'].join('|');
shuffle(picked);
picked.sort((a, b) => (stratum(a) < stratum(b) ? -1 : stratum(a) > stratum(b) ? 1 : 0));
const evalSet = [];
const train = [];
const step = picked.length / EVAL;
const evalAt = new Set(Array.from({ length: EVAL }, (_, i) => Math.floor(i * step + step / 2)));
picked.forEach((c, i) => (evalAt.has(i) ? evalSet : train).push(c));
const pad = (n, w) => String(n).padStart(w, '0');
picked.forEach((c, i) => (c.order = i));
// ids: s0001.. in the stratified order (stable for a given seed and captures)
for (const c of picked) c.id = `s${pad(c.order + 1, 4)}`;
const batches = Array.from({ length: BATCHES }, () => []);
train.forEach((c, i) => {
    c.batch = pad((i % BATCHES) + 1, 2);
    batches[i % BATCHES].push(c);
});
for (const c of evalSet) c.batch = null;

// ── the numbers ──────────────────────────────────────────────────────────────────────────────────────────────────────
const count = (list, f) => {
    const m = new Map();
    for (const c of list) m.set(f(c), (m.get(f(c)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const pct = (n, d) => `${Math.round((n / d) * 1000) / 10} %`;
const show = (title, list, f) => console.log(`${title}: ${count(list, f).map(([k, n]) => `${k} ${n} (${pct(n, list.length)})`).join(', ')}`);
console.log(`captures ${stats.captures} from ${stats.runs} runs; rules-only dropped ${stats.rulesOnly}; duplicates dropped ${stats.dupExact} exact, ${stats.dupBot} same bot and line, ${stats.dupHeard} over the heard-line cap; ${stats.candidates} candidates`);
console.log(`cells (have → picked): ${[...cells.keys()].sort().map(k => `${k} ${cells.get(k).length}→${quota.get(k) ?? 0}`).join(', ')}`);
console.log(`picked ${picked.length}: train ${train.length} in ${BATCHES} batches (${batches.map(b => b.length).join(' ')}), eval ${evalSet.length}`);
show('via', picked, c => viaGroup(c.situation.heard.via));
show('via (raw)', picked, c => c.situation.heard.via);
show('hint', picked, c => (c.situation.hint ? 'hint' : 'none'));
show('kind', picked, c => c.kind);
show('bot kind', picked, c => c.situation.bot.kind);
show('age band', picked, c => c.situation.bot.ageBand);
show('newbie', picked, c => (c.situation.bot.newbie ? 'newbie' : 'not'));
show('rude / meme', picked, c => `${c.situation.bot.voice.rude ? 'rude' : 'polite'}${c.situation.bot.voice.meme ? '+meme' : ''}`);
show('world', picked, c => `${c.members ? 'members' : 'free'} x${c.xpRate} ${c.bots}`);
show('config', picked, c => c.config);
show('rules answered', picked, c => (c.ruleText ? 'a rules line' : 'nothing'));
show('hint intent (top 25)', picked.filter(c => c.situation.hint), c => c.situation.hint.intent);
show('eval via', evalSet, c => viaGroup(c.situation.heard.via));
show('eval hint', evalSet, c => (c.situation.hint ? 'hint' : 'none'));
{
    const spread = batches.map(b => count(b, c => `${viaGroup(c.situation.heard.via)}|${c.situation.hint ? 'h' : 'n'}`));
    const keys = [...new Set(spread.flatMap(s => s.map(([k]) => k)))].sort();
    for (const k of keys) {
        const ns = spread.map(s => s.find(([kk]) => kk === k)?.[1] ?? 0);
        console.log(`  batches ${k.padEnd(18)} min ${Math.min(...ns)} max ${Math.max(...ns)}`);
    }
}
if (DRY) process.exit(0);

// ── write ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const line = c => JSON.stringify({ id: c.id, situation: c.situation, ruleText: c.ruleText, kind: c.kind });
fs.mkdirSync(path.join(DATA, 'batches'), { recursive: true });
fs.writeFileSync(
    path.join(DATA, 'situations.jsonl'),
    picked
        .slice()
        .sort((a, b) => a.order - b.order)
        .map(c => JSON.stringify({ id: c.id, split: c.batch ? 'train' : 'eval', batch: c.batch, source: { config: c.config, seed: c.seed, members: c.members, xpRate: c.xpRate, bots: c.bots, t: c.t }, kind: c.kind, ruleText: c.ruleText, situation: c.situation }))
        .join('\n') + '\n'
);
fs.writeFileSync(path.join(DATA, 'eval.jsonl'), evalSet.map(line).join('\n') + '\n');
for (const f of fs.readdirSync(path.join(DATA, 'batches'))) if (/^batch-\d+\.jsonl$/.test(f)) fs.rmSync(path.join(DATA, 'batches', f));
batches.forEach((b, i) => fs.writeFileSync(path.join(DATA, 'batches', `batch-${pad(i + 1, 2)}.jsonl`), b.map(line).join('\n') + '\n'));
console.log(`wrote ${path.join(DATA, 'situations.jsonl')}, eval.jsonl, batches/batch-01..${pad(BATCHES, 2)}.jsonl`);
