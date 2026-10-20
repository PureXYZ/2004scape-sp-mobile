#!/usr/bin/env node
// The retrain's situations (the realism work, phase 7, round 2: after the first blind test, where the
// model lost 13 of 20 to Claude-written lines: it missed the question asked, dropped its own counts and levels, or
// ended in a garbled phrase). From the round-2 sampler's captures (sample.mjs --set=r2 with human-lines.mjs --focus):
//
//   select  1. read every capture; drop what the model never writes (select.mjs's rules-only intents and port/BotModel's
//              RULES_ONLY_INTENTS: dance, slayer, stat19), the second bot's rude lines, the market and reactions;
//           2. deduplicate: one per run, tick, bot and line; at most 2 per bot and line in a run; none whose bot and line
//              (case and punctuation aside) the first 3,300 already have; at most 4 of one heard line (6 for the
//              questions the bot's own facts answer);
//           3. give each a focus, by the human line's category in human-lines.mjs (the pool it came from):
//                facts     a question its own facts answer: what it carries and how many, its gear, its levels (a skill,
//                          its best, its total, "anyone 70 wc"), what it is doing and its plans, where it is, yes/no
//                          about itself (human-lines' inv, worn, levels, doing, yesno; state and gear but greetings)
//                followup  the next line of a chat (conversation, the reply window, a PM after its own PM reply)
//                tail      the long tail the rules leave without a hint, said to the bot (named) or by PM
//                ordinary  the rest: the ordinary mix, so the model does not drift
//              and pick TOTAL by FOCUS_SHARE (facts with no hint lifted 1.5x; newbies first, 12 %), spread inside each
//              focus over its categories, vias and hint/none by square-root shares;
//           4. rename "Sim Human" as select.mjs does (2004 player names, seeded);
//           5. the stratified order (focus, category, via, hint, kind, age band); TARGET held out (every k-th: the
//              targeted test, never trained on); ids r2-0001.. in that order; train and target dealt in turn to
//              BATCHES batches numbered from FIRST_BATCH (20..25), so each has the same spread.
//           Writes <data>/r2-situations.jsonl and <data>/r2-prompts.jsonl (renderLocal, for eval.mjs gen).
//   finish  the current model's line for each (eval.mjs gen's file over r2-prompts.jsonl): modelReply (as the guard
//           leaves it) and modelGuard ("ok", the final guard's reason, or "checks: level, number" when the guard
//           passes but Track L's checks fail); then the complete data dir:
//             situations.jsonl  the first 3,300 rows unchanged + the 1,150 (split train or target, batch 20..25)
//             batches/batch-NN.jsonl  {id, split, situation, ruleText, kind, modelReply, modelGuard} a line
//             target.jsonl      the target rows ({id, situation, ruleText, kind, focus})
//             eval.jsonl, replies/batch-01..19.jsonl, BRIEF.md: copied unchanged from the first data dir
//             eval/target-gen-r1.jsonl  the current model's lines on the target rows (eval.mjs gen's format)
//             eval/gen-r1.jsonl, eval/gen-base-fewshot.jsonl: the first evaluation's generations on the 300 held out
//
//   node web/engine/bots/test/model-data/select-r2.mjs select --raw=DIR --old=<phase7-data> --data=<phase7-data-r2>
//        [--total=1150] [--target=150] [--batches=6] [--first-batch=20] [--seed=27] [--dry]
//   node web/engine/bots/test/model-data/select-r2.mjs finish --old=<phase7-data> --data=<phase7-data-r2> --gen=<gen.jsonl>
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { importInEngine } from '../lib/clone.mjs';
import { POOL, POOL_R2 } from './human-lines.mjs';
import { checkReply } from './checks.mjs';
import { RULES_ONLY, SECOND_RUDE, mulberry, namesIn, playerNamer, rename, renamed, shuffler } from './select-lib.mjs';

process.removeAllListeners('warning'); // (the engine's SQLite notice)
const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const command = argv[0];
const args = Object.fromEntries(argv.filter(a => a.startsWith('--')).map(a => ((m => (m ? [m[1], m[2] ?? 'true'] : [a, 'true']))(a.match(/^--([^=]+)(?:=(.*))?$/)))));

/** port/BotModel RULES_ONLY_INTENTS beyond select.mjs's list (the binding list: the model is never asked for these) */
const RULES_ONLY_R2 = new Set([...RULES_ONLY, 'dance', 'slayer', 'stat19']);
/** the focuses' shares of the set */
export const FOCUS_SHARE = { facts: 0.4, followup: 0.2, tail: 0.2, ordinary: 0.2 };
const FACT_CATS = new Set(['inv', 'worn', 'levels', 'doing', 'yesno']);
/** state and gear lines that are greetings or presence checks, not questions the facts answer */
const NOT_FACT = /^(hi|hey|heya|hiya|hello|yo|sup|morning|evening)\b|\b(u there|r u afk|u alive|hello\?|u busy|anyone on|is anyone here|anyone home|where is everyone|still here)\b/;
const HEARD_CAP = 4;
const HEARD_CAP_FACTS = 6;

const readJsonl = file =>
    fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l));
const norm = t => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const viaGroup = via => (via === 'second' ? 'crowd' : via);
const pad = (n, w) => String(n).padStart(w, '0');

/** the human line's category in the pool, by list: public lines with the bot's name put back as {name} */
const CATEGORY = new Map();
for (const [list, base] of Object.entries(POOL)) {
    const cats = { ...base, ...(POOL_R2[list] ?? {}) };
    for (const [cat, lines] of Object.entries(cats)) for (const line of lines) if (!CATEGORY.has(`${list}|${line}`)) CATEGORY.set(`${list}|${line}`, cat);
}
function categoryOf(s) {
    const text = s.heard.text;
    const via = s.heard.via;
    const lists = via === 'named' ? ['public'] : via === 'private' ? ['pm', 'followups'] : via === 'conversation' || via === 'window' ? ['followups', 'public', 'talk'] : ['talk', 'followups'];
    const named = text.replace(new RegExp(s.bot.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '{name}');
    for (const list of lists) {
        const cat = CATEGORY.get(`${list}|${list === 'public' ? named : text}`);
        if (cat) return { list, cat };
    }
    for (const list of ['followups', 'pm', 'talk']) {
        const cat = CATEGORY.get(`${list}|${text}`);
        if (cat) return { list, cat };
    }
    return { list: null, cat: 'other' };
}
/** a PM after the bot's own PM reply: the conversation goes on */
const pmThread = s => s.heard.via === 'private' && s.history.some(h => h.pm && h.who === 'you');
function focusOf(s) {
    const { cat } = categoryOf(s);
    const bare = norm(s.heard.text.replace(new RegExp(s.bot.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ''));
    if (FACT_CATS.has(cat) || ((cat === 'state' || cat === 'gear') && !NOT_FACT.test(bare))) return { focus: 'facts', cat };
    if (s.heard.via === 'conversation' || s.heard.via === 'window' || pmThread(s)) return { focus: 'followup', cat };
    if (!s.hint && (s.heard.via === 'named' || s.heard.via === 'private')) return { focus: 'tail', cat };
    return { focus: 'ordinary', cat };
}

async function select() {
    if (!args.raw || !args.old || !args.data) {
        console.error('usage: select-r2.mjs select --raw=DIR --old=<phase7-data> --data=<phase7-data-r2> [--total=1150] [--target=150] [--batches=6] [--first-batch=20] [--seed=27] [--dry]');
        process.exit(2);
    }
    const RAW = path.resolve(args.raw);
    const DATA = path.resolve(args.data);
    const OLD = path.resolve(args.old);
    const TOTAL = Number(args.total ?? 1150);
    const TARGET = Number(args.target ?? 150);
    const BATCHES = Number(args.batches ?? 6);
    const FIRST = Number(args['first-batch'] ?? 20);
    const dice = mulberry(Number(args.seed ?? 27));
    const shuffle = shuffler(dice);
    const guard = await importInEngine(path.join(here, 'guard-lib.ts'), 'model-select-r2');
    guard.loadWordEnc();
    const playerName = playerNamer(dice, guard);

    // ── 1. read, and the model's replies only ──
    const files = fs.readdirSync(RAW).filter(f => f.endsWith('.jsonl')).sort();
    const raw = [];
    for (const file of files) for (const c of readJsonl(path.join(RAW, file))) raw.push({ config: file.replace(/\.jsonl$/, ''), ...c });
    const stats = { captures: raw.length, runs: files.length, rulesOnly: 0, dupExact: 0, dupBot: 0, dupOld: 0, dupHeard: 0 };
    let pool = raw.filter(c => {
        const s = c.situation;
        const intent = s.hint?.intent ?? null;
        const drop = (intent && RULES_ONLY_R2.has(intent)) || (s.heard.via === 'second' && SECOND_RUDE.has(s.hint?.text ?? '')) || s.heard.via === 'market' || s.heard.via === 'reaction';
        if (drop) stats.rulesOnly++;
        return !drop;
    });

    // ── 2. deduplicate ──
    const old = readJsonl(path.join(OLD, 'situations.jsonl'));
    const oldKeys = new Set(old.map(r => `${r.situation.bot.name.toLowerCase()}|${norm(r.situation.heard.text)}`));
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
            const key = `${c.config}|${c.situation.bot.name}|${norm(c.situation.heard.text)}`;
            const n = (perBot.get(key) ?? 0) + 1;
            perBot.set(key, n);
            if (n > 2) return (stats.dupBot++, false);
            return true;
        });
        pool = pool.filter(c => {
            if (oldKeys.has(`${c.situation.bot.name.toLowerCase()}|${norm(c.situation.heard.text)}`)) return (stats.dupOld++, false);
            return true;
        });
    }
    for (const c of pool) Object.assign(c, focusOf(c.situation));
    {
        // (at most HEARD_CAP of one heard line, the bot's name aside; HEARD_CAP_FACTS for the facts: the answers differ by bot)
        const groups = new Map();
        for (const c of pool) {
            const key = norm(c.situation.heard.text.replace(new RegExp(c.situation.bot.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ''));
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(c);
        }
        pool = [];
        for (const list of groups.values()) {
            shuffle(list);
            list.sort((a, b) => Number(b.situation.bot.newbie) - Number(a.situation.bot.newbie));
            const cap = list[0].focus === 'facts' ? HEARD_CAP_FACTS : HEARD_CAP;
            pool.push(...list.slice(0, cap));
            stats.dupHeard += Math.max(0, list.length - cap);
        }
    }
    stats.candidates = pool.length;

    // ── 3. pick by focus ──
    const byFocus = new Map(Object.keys(FOCUS_SHARE).map(f => [f, []]));
    for (const c of pool) byFocus.get(c.focus).push(c);
    const quota = new Map(Object.entries(FOCUS_SHARE).map(([f, share]) => [f, Math.min(byFocus.get(f).length, Math.round(share * TOTAL))]));
    {
        // (a focus short of its quota gives all it has; the rest to the others with room, facts first)
        let left = TOTAL - [...quota.values()].reduce((a, b) => a + b, 0);
        for (const f of ['facts', 'followup', 'tail', 'ordinary']) {
            const room = byFocus.get(f).length - quota.get(f);
            const d = Math.max(0, Math.min(room, left));
            quota.set(f, quota.get(f) + d);
            left -= d;
        }
    }
    function pickFrom(list, n) {
        const picked = [];
        const newbies = shuffle(list.filter(c => c.situation.bot.newbie));
        picked.push(...newbies.slice(0, Math.min(newbies.length, Math.ceil(n * 0.12))));
        const rest = list.filter(c => !picked.includes(c));
        const groups = new Map();
        for (const c of rest) {
            const key = `${c.cat}|${viaGroup(c.situation.heard.via)}|${c.situation.hint ? 'hint' : 'none'}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(c);
        }
        for (const g of groups.values()) shuffle(g);
        const keys = [...groups.keys()].sort();
        while (picked.length < n) {
            const live = keys.filter(k => groups.get(k).length);
            if (!live.length) break;
            // (square-root shares; the facts with no hint, the rules' blind spot, lifted 1.5x)
            const w = live.map(k => Math.sqrt(groups.get(k).length) * (k.endsWith('|none') && list[0]?.focus === 'facts' ? 1.5 : 1));
            let r = dice() * w.reduce((a, b) => a + b, 0);
            let i = 0;
            while (r > w[i] && i < w.length - 1) r -= w[i++];
            picked.push(groups.get(live[i]).pop());
        }
        return picked;
    }
    let picked = [];
    for (const f of Object.keys(FOCUS_SHARE)) picked.push(...pickFrom(byFocus.get(f), quota.get(f)));

    // ── 4. the human's name ──
    picked = picked.map(c => {
        const s = c.situation;
        const taken = namesIn(s);
        let name = playerName();
        while (taken.has(name.toLowerCase())) name = playerName();
        return { ...c, human: name, situation: rename(s, name), ruleText: c.ruleText === null ? null : renamed(c.ruleText, name) };
    });

    // ── 5. the stratified order, the target set, the batches ──
    const KIND_ORDER = ['skiller', 'fighter', 'balanced', 'random', 'extras_social', 'extras_vendor', 'extras_pker', 'extras_edgeville_pker'];
    const FOCUS_ORDER = Object.keys(FOCUS_SHARE);
    const stratum = c => [FOCUS_ORDER.indexOf(c.focus), c.cat, viaGroup(c.situation.heard.via), c.situation.hint ? 'hint' : 'none', String(KIND_ORDER.indexOf(c.situation.bot.kind)).padStart(2, '0'), c.situation.bot.ageBand, c.situation.bot.newbie ? 'n' : 'o'].join('|');
    shuffle(picked);
    picked.sort((a, b) => (stratum(a) < stratum(b) ? -1 : stratum(a) > stratum(b) ? 1 : 0));
    const step = picked.length / TARGET;
    const targetAt = new Set(Array.from({ length: TARGET }, (_, i) => Math.floor(i * step + step / 2)));
    picked.forEach((c, i) => {
        c.id = `r2-${pad(i + 1, 4)}`;
        c.split = targetAt.has(i) ? 'target' : 'train';
    });
    let nTrain = 0;
    let nTarget = 0;
    for (const c of picked) c.batch = pad(FIRST + ((c.split === 'train' ? nTrain++ : nTarget++) % BATCHES), 2);

    // ── the numbers ──
    const count = (list, f) => {
        const m = new Map();
        for (const c of list) m.set(f(c), (m.get(f(c)) ?? 0) + 1);
        return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const pct = (n, d) => `${Math.round((n / d) * 1000) / 10} %`;
    const show = (title, list, f) => console.log(`${title}: ${count(list, f).map(([k, n]) => `${k} ${n} (${pct(n, list.length)})`).join(', ')}`);
    console.log(`captures ${stats.captures} from ${stats.runs} runs; rules-only dropped ${stats.rulesOnly}; duplicates dropped ${stats.dupExact} exact, ${stats.dupBot} same bot and line in a run, ${stats.dupOld} in the first 3,300, ${stats.dupHeard} over the heard-line cap; ${stats.candidates} candidates`);
    console.log(`candidates by focus: ${[...byFocus.entries()].map(([f, l]) => `${f} ${l.length}`).join(', ')}; quotas: ${[...quota.entries()].map(([f, n]) => `${f} ${n}`).join(', ')}`);
    const train = picked.filter(c => c.split === 'train');
    const target = picked.filter(c => c.split === 'target');
    console.log(`picked ${picked.length}: train ${train.length}, target ${target.length}`);
    show('focus', picked, c => c.focus);
    show('focus/category', picked, c => `${c.focus}/${c.cat}`);
    show('via', picked, c => viaGroup(c.situation.heard.via));
    show('hint', picked, c => (c.situation.hint ? 'hint' : 'none'));
    show('focus/hint', picked, c => `${c.focus}/${c.situation.hint ? 'hint' : 'none'}`);
    show('bot kind', picked, c => c.situation.bot.kind);
    show('age band', picked, c => c.situation.bot.ageBand);
    show('newbie', picked, c => (c.situation.bot.newbie ? 'newbie' : 'not'));
    show('world', picked, c => `${c.members ? 'members' : 'free'} x${c.xpRate} ${c.bots}`);
    show('rules answered', picked, c => (c.ruleText ? 'a rules line' : 'nothing'));
    show('target focus', target, c => c.focus);
    show('target hint', target, c => (c.situation.hint ? 'hint' : 'none'));
    for (let b = 0; b < BATCHES; b++) {
        const id = pad(FIRST + b, 2);
        const rows = picked.filter(c => c.batch === id);
        console.log(`  batch ${id}: train ${rows.filter(c => c.split === 'train').length}, target ${rows.filter(c => c.split === 'target').length}; ${count(rows, c => c.focus).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    }
    if (args.dry === 'true') return;

    // ── write ──
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(
        path.join(DATA, 'r2-situations.jsonl'),
        picked.map(c => JSON.stringify({ id: c.id, split: c.split, batch: c.batch, focus: c.focus, category: c.cat, source: { config: c.config, seed: c.seed, members: c.members, xpRate: c.xpRate, bots: c.bots, t: c.t }, kind: c.kind, ruleText: c.ruleText, situation: c.situation })).join('\n') + '\n'
    );
    // (guard-lib has renderLocal too: the engine is imported once a process)
    const lib = guard;
    fs.writeFileSync(
        path.join(DATA, 'r2-prompts.jsonl'),
        picked
            .map(c => {
                const p = lib.renderLocal(c.situation);
                return JSON.stringify({ id: c.id, via: c.situation.heard.via, hint: c.situation.hint, kind: c.kind, ruleText: c.ruleText, system: p.system, user: p.user, situation: c.situation });
            })
            .join('\n') + '\n'
    );
    console.log(`wrote ${path.join(DATA, 'r2-situations.jsonl')} and r2-prompts.jsonl`);
}

async function finish() {
    if (!args.old || !args.data || !args.gen) {
        console.error('usage: select-r2.mjs finish --old=<phase7-data> --data=<phase7-data-r2> --gen=<gen.jsonl>');
        process.exit(2);
    }
    const OLD = path.resolve(args.old);
    const DATA = path.resolve(args.data);
    const GEN = path.resolve(args.gen);
    const rows = readJsonl(path.join(DATA, 'r2-situations.jsonl'));
    const gen = new Map(readJsonl(GEN).map(r => [r.id, r]));
    const missing = rows.filter(r => !gen.has(r.id));
    if (missing.length) throw new Error(`finish: ${missing.length} rows have no generated line (${missing.slice(0, 3).map(r => r.id).join(', ')} ...)`);
    const lib = await importInEngine(path.join(here, 'guard-lib.ts'), 'model-select-r2-finish');
    lib.loadWordEnc();
    for (const r of rows) {
        const text = String(gen.get(r.id).text ?? '');
        const g = lib.guardReply(text, r.situation);
        if (!g.ok) {
            r.modelReply = text.trim();
            r.modelGuard = g.reason;
            continue;
        }
        r.modelReply = g.text;
        const c = checkReply(r.situation, r.ruleText, g.text);
        const failed = [...new Set(c.failures.map(f => f.reason))];
        r.modelGuard = failed.length ? `checks: ${failed.join(', ')}` : 'ok';
    }
    // the complete data dir
    const copy = (from, to) => {
        if (fs.existsSync(to) && fs.readFileSync(to).equals(fs.readFileSync(from))) return;
        if (fs.existsSync(to)) throw new Error(`finish: ${to} exists and differs from ${from}: not overwritten`);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
    };
    const oldText = fs.readFileSync(path.join(OLD, 'situations.jsonl'), 'utf8');
    const ids = new Set(oldText.split('\n').filter(l => l.trim()).map(l => JSON.parse(l).id));
    for (const r of rows) if (ids.has(r.id)) throw new Error(`finish: ${r.id} is already an id of the first data`);
    const newRow = r => JSON.stringify({ id: r.id, split: r.split, batch: r.batch, focus: r.focus, category: r.category, source: r.source, kind: r.kind, ruleText: r.ruleText, situation: r.situation, modelReply: r.modelReply, modelGuard: r.modelGuard });
    fs.writeFileSync(path.join(DATA, 'situations.jsonl'), (oldText.endsWith('\n') ? oldText : `${oldText}\n`) + rows.map(newRow).join('\n') + '\n');
    fs.mkdirSync(path.join(DATA, 'batches'), { recursive: true });
    const batches = [...new Set(rows.map(r => r.batch))].sort();
    for (const b of batches) {
        const list = rows.filter(r => r.batch === b);
        fs.writeFileSync(path.join(DATA, 'batches', `batch-${b}.jsonl`), list.map(r => JSON.stringify({ id: r.id, split: r.split, situation: r.situation, ruleText: r.ruleText, kind: r.kind, modelReply: r.modelReply, modelGuard: r.modelGuard })).join('\n') + '\n');
    }
    const target = rows.filter(r => r.split === 'target');
    fs.writeFileSync(path.join(DATA, 'target.jsonl'), target.map(r => JSON.stringify({ id: r.id, situation: r.situation, ruleText: r.ruleText, kind: r.kind, focus: r.focus })).join('\n') + '\n');
    copy(path.join(OLD, 'eval.jsonl'), path.join(DATA, 'eval.jsonl'));
    copy(path.join(OLD, 'BRIEF.md'), path.join(DATA, 'BRIEF.md'));
    for (const f of fs.readdirSync(path.join(OLD, 'replies')).filter(f => /^batch-\d\d\.jsonl$/.test(f))) copy(path.join(OLD, 'replies', f), path.join(DATA, 'replies', f));
    fs.mkdirSync(path.join(DATA, 'eval'), { recursive: true });
    fs.writeFileSync(path.join(DATA, 'eval', 'target-gen-r1.jsonl'), target.map(r => JSON.stringify({ ...gen.get(r.id), variant: 'r1' })).join('\n') + '\n');
    copy(path.join(OLD, 'eval', 'gen-lora.jsonl'), path.join(DATA, 'eval', 'gen-r1.jsonl'));
    copy(path.join(OLD, 'eval', 'gen-base-fewshot.jsonl'), path.join(DATA, 'eval', 'gen-base-fewshot.jsonl'));

    // the numbers: the current model on the new situations
    const count = (list, f) => {
        const m = new Map();
        for (const r of list) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
        return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const ok = rows.filter(r => r.modelGuard === 'ok').length;
    console.log(`finish: ${rows.length} rows (${rows.length - target.length} train, ${target.length} target) in batches ${batches.join(' ')}; the current model: ok ${ok} (${Math.round((ok / rows.length) * 1000) / 10} %)`);
    console.log(`  modelGuard: ${count(rows, r => r.modelGuard).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    for (const f of Object.keys(FOCUS_SHARE)) {
        const list = rows.filter(r => r.focus === f);
        console.log(`  ${f}: ok ${list.filter(r => r.modelGuard === 'ok').length}/${list.length}; ${count(list.filter(r => r.modelGuard !== 'ok'), r => r.modelGuard).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    }
    for (const b of batches) {
        const list = rows.filter(r => r.batch === b);
        console.log(`  batch-${b}.jsonl: ${list.length} rows (train ${list.filter(r => r.split === 'train').length}, target ${list.filter(r => r.split === 'target').length})`);
    }
    console.log(`wrote ${DATA}: situations.jsonl, batches/, target.jsonl, eval.jsonl, replies/batch-01..19.jsonl, BRIEF.md, eval/target-gen-r1.jsonl`);
}

if (command === 'select') await select();
else if (command === 'finish') await finish();
else {
    console.error('usage: select-r2.mjs select|finish ... (see the header)');
    process.exit(2);
}
