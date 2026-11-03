#!/usr/bin/env node
// The r3 retrain's situations (the bots ideas work, round 5: theme I stage 2):
// the on-device model learns two new kinds of line beside round 2's replies to the human: a reaction to the
// human (port/BotModelAmbient kind 'reaction': renderLocal's reaction branch, Situation.event) and a bot's turn in the
// bots' own talk (a thread's turn after the opener, a bot's answer to a bot: 'thread', 'botanswer', the partner in the
// human's place). From the r3 captures (sample.mjs --set=r3: humanlike --model-capture; stage-r3.mjs: the staged world):
//
//   select  1. read every capture; keep the lines of the new kinds (the replies to the human are round 2's);
//           2. deduplicate: one per run, tick, bot and line; a bot's line of a kind at most twice (its reaction of a
//              group, its turn of the same hint); a turn's hint and heard line (numbers aside) at most HINT_CAP times; a
//              reaction's hint and event at most REACT_CAP times for a persona (its bot's kind and age band);
//           3. group them: the reactions by what they are to (GROUPS_REACT: gz on a level, a milestone, died, died to a
//              PKer, a kill, a dance or another emote, the Wilderness, followed, next to or a wave, the gear or level of a
//              passer-by), the turns by what they do (GROUPS_TURN: a thread's answer to the opener, a turn that asks back,
//              the answer to a partner's "u?", a later turn, a bot's answer to a bot); pick REACT reactions over their
//              groups evenly and TURNS turns by TURN_SHARE, spread inside each over the bot's kind, the world (members
//              or free, 1x or 10x) and (a turn) its topic by square-root shares;
//           4. rename "Sim Human" as select.mjs does (2004 player names, seeded);
//           5. the stratified order (kind, group, world, bot kind, age band); a target split held out of each kind (every
//              k-th: TARGET_REACT reactions, split 'target-react'; TARGET_TURN turns, 'target-turn': never trained on, for
//              the r3 model's evaluation); ids r3-0001.. in that order; train and target dealt in turn to batches of about
//              BATCH (batch-r3-react-NN, batch-r3-turn-NN), so each has the same spread.
//           Writes <data>/r3-situations.jsonl and <data>/r3-prompts.jsonl (renderLocal, for eval.mjs gen).
//   finish  the round 2 model's line for each (eval.mjs gen's file over r3-prompts.jsonl): modelReply and modelGuard (as
//           select-r2.mjs: "ok", the guard's reason with its ambient checks, or "checks: ..."); then the data dir:
//             situations.jsonl   round 2's 4,450 rows unchanged (--old's) + the r3 rows (split train, target-react or
//                                target-turn; `ambient` their kind)
//             batches/batch-r3-{react,turn}-NN.jsonl  {id, split, ambient, group, situation, ruleText, event, modelReply,
//                                modelGuard} a line (the writers' batches)
//             target-react.jsonl, target-turn.jsonl  the held-out rows; and <split>-prompts.jsonl, their prompts (as
//                                assemble writes them, with no reference yet: build-model.sh target-r3-base)
//             eval/r3-gen-r2.jsonl   the round 2 model's line on every r3 row (--gen, as it came)
//             eval/r2-on-target-r3/<split>-rules.jsonl  the rules' lines of the two target splits (build-model.sh
//                                target-r3-base puts the round 2 model's lines and their scores beside them: the
//                                baseline r3 is compared with)
//           and round 2's files as they are, so assemble reads one folder: eval.jsonl, target.jsonl, notes.jsonl,
//           replies/batch-01..25.jsonl, BRIEF.md, BRIEF-R2.md, eval/ (round 2's generations: gen-r1, gen-r2 (its plain
//           lines), gen-r2-think, gen-base-fewshot, target-gen-r1).
//
//   node web/engine/bots/test/model-data/select-r3.mjs select --raw=DIR[,DIR] --old=<phase7-data-r2> --data=<data-r3>
//        [--react=600] [--turns=600] [--target-react=80] [--target-turn=80] [--batch=75] [--seed=53] [--dry]
//   node web/engine/bots/test/model-data/select-r3.mjs finish --old=<phase7-data-r2> --data=<data-r3> --gen=<gen.jsonl>
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { importInEngine } from '../lib/clone.mjs';
import { checkReply } from './checks.mjs';
import { mulberry, namesIn, playerNamer, rename, renamed, shuffler } from './select-lib.mjs';

process.removeAllListeners('warning'); // (the engine's SQLite notice)
const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const command = argv[0];
const args = Object.fromEntries(argv.filter(a => a.startsWith('--')).map(a => ((m => (m ? [m[1], m[2] ?? 'true'] : [a, 'true']))(a.match(/^--([^=]+)(?:=(.*))?$/)))));

/** the new kinds (port/BotModelAmbient AmbientKind) */
export const AMBIENT_KINDS = new Set(['reaction', 'thread', 'botanswer']);
/** a reaction's group: what it is to (port/BotModelAmbient ReactionKind, the waves with the hellos, the emotes with the dance, gear and level as a passer's) */
export const GROUPS_REACT = { gz: 'gz', milestone: 'milestone', died: 'died', pked: 'pked', kill: 'kill', dance: 'dance', emote: 'dance', wildy: 'wildy', followed: 'followed', nextto: 'nextto', wave: 'nextto', gear: 'passer', level: 'passer' };
/** the turns' groups and their shares of TURNS */
export const TURN_SHARE = { opener: 0.25, counter: 0.2, back: 0.15, later: 0.15, answer: 0.25 };
/** port/BotThreads COUNTER_RX (port/BotModelGuard AMBIENT_COUNTER_RX): a line that asks back */
const COUNTER_RX = /(?:^|[\s,])(?:u|you)\s*\?+\s*$|\b(?:wbu|hbu)\b\s*\??\s*$|\bwhat about (?:u|you)\b\s*\??\s*$|\band (?:u|you)\s*\??\s*$/i;
const HINT_CAP = 4;
const REACT_CAP = 3;

const readJsonl = file =>
    fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l));
const norm = t => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const plainNumbers = t => norm(t).replace(/\d+/g, '#');
const pad = (n, w) => String(n).padStart(w, '0');

/** a capture's group: a reaction's by what it is to, a turn's by what it does */
export function groupOf(c) {
    if (c.kind === 'reaction') return GROUPS_REACT[c.react] ?? null;
    if (c.kind === 'botanswer') return 'answer';
    if (COUNTER_RX.test(String(c.hint ?? '').trim())) return 'counter';
    if (COUNTER_RX.test(String(c.situation.heard.text ?? '').trim())) return 'back';
    return typeof c.turn === 'number' && c.turn >= 2 ? 'later' : 'opener';
}

async function select() {
    if (!args.raw || !args.old || !args.data) {
        console.error('usage: select-r3.mjs select --raw=DIR[,DIR] --old=<phase7-data-r2> --data=<data-r3> [--react=600] [--turns=600] [--target-react=80] [--target-turn=80] [--batch=75] [--seed=53] [--dry]');
        process.exit(2);
    }
    const RAWS = String(args.raw).split(',').map(d => path.resolve(d));
    const DATA = path.resolve(args.data);
    const REACT = Number(args.react ?? 600);
    const TURNS = Number(args.turns ?? 600);
    const TARGET_REACT = Number(args['target-react'] ?? 80);
    const TARGET_TURN = Number(args['target-turn'] ?? 80);
    const BATCH = Number(args.batch ?? 75);
    const dice = mulberry(Number(args.seed ?? 53));
    const shuffle = shuffler(dice);
    const guard = await importInEngine(path.join(here, 'guard-lib.ts'), 'model-select-r3');
    guard.loadWordEnc();
    const playerName = playerNamer(dice, guard);

    // ── 1. read, and the new kinds only ──
    const raw = [];
    let runs = 0;
    for (const dir of RAWS) {
        for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
            runs++;
            for (const c of readJsonl(path.join(dir, file))) raw.push({ config: `${path.basename(dir)}/${file.replace(/\.jsonl$/, '')}`, ...c });
        }
    }
    const stats = { captures: raw.length, runs, replies: 0, noGroup: 0, dupExact: 0, dupBot: 0, dupHint: 0 };
    let pool = raw.filter(c => {
        if (!AMBIENT_KINDS.has(c.kind)) return (stats.replies++, false);
        c.group = groupOf(c);
        if (!c.group) return (stats.noGroup++, false);
        return true;
    });

    // ── 2. deduplicate ──
    {
        const seen = new Set();
        pool = pool.filter(c => {
            const key = `${c.config}|${c.t}|${c.situation.bot.name}|${c.hint}|${c.situation.heard.text}`;
            if (seen.has(key)) return (stats.dupExact++, false);
            seen.add(key);
            return true;
        });
        const perBot = new Map();
        pool = pool.filter(c => {
            const key = c.kind === 'reaction' ? `${c.situation.bot.name}|${c.group}` : `${c.situation.bot.name}|${norm(c.hint)}`;
            const n = (perBot.get(key) ?? 0) + 1;
            perBot.set(key, n);
            if (n > 2) return (stats.dupBot++, false);
            return true;
        });
        const groups = new Map();
        for (const c of pool) {
            // (a reaction's event and pool are few: its variety is the bot's, so the cap is a persona's: its kind and age band)
            const key = c.kind === 'reaction' ? `${c.group}|${norm(c.hint)}|${c.event}|${c.situation.bot.kind}|${c.situation.bot.ageBand}` : `${c.group}|${plainNumbers(c.hint)}|${plainNumbers(c.situation.heard.text)}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(c);
        }
        pool = [];
        for (const list of groups.values()) {
            shuffle(list);
            const cap = list[0].kind === 'reaction' ? REACT_CAP : HINT_CAP;
            pool.push(...list.slice(0, cap));
            stats.dupHint += Math.max(0, list.length - cap);
        }
    }
    const reactions = pool.filter(c => c.kind === 'reaction');
    const turns = pool.filter(c => c.kind !== 'reaction');
    stats.candidates = { reactions: reactions.length, turns: turns.length };

    // ── 3. pick by group ──
    const world = c => `${c.members ? 'm' : 'f'}${c.xpRate}`;
    function pickFrom(list, n, strata) {
        const groups = new Map();
        for (const c of list) {
            const key = strata(c);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(c);
        }
        for (const g of groups.values()) shuffle(g);
        const keys = [...groups.keys()].sort();
        const picked = [];
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
    /** quotas by share, a group short of its own giving the rest to the others with room */
    function quotas(byGroup, shares, total) {
        const q = new Map(Object.entries(shares).map(([g, share]) => [g, Math.min(byGroup.get(g)?.length ?? 0, Math.round(share * total))]));
        let left = total - [...q.values()].reduce((a, b) => a + b, 0);
        while (left > 0) {
            const room = [...q.keys()].filter(g => (byGroup.get(g)?.length ?? 0) > q.get(g));
            if (!room.length) break;
            for (const g of room) {
                if (left <= 0) break;
                q.set(g, q.get(g) + 1);
                left--;
            }
        }
        return q;
    }
    const groupsOf = list => {
        const m = new Map();
        for (const c of list) {
            if (!m.has(c.group)) m.set(c.group, []);
            m.get(c.group).push(c);
        }
        return m;
    };
    const reactGroups = groupsOf(reactions);
    const turnGroups = groupsOf(turns);
    const REACT_NAMES = [...new Set(Object.values(GROUPS_REACT))];
    const qReact = quotas(reactGroups, Object.fromEntries(REACT_NAMES.map(g => [g, 1 / REACT_NAMES.length])), REACT);
    const qTurn = quotas(turnGroups, TURN_SHARE, TURNS);
    let picked = [];
    for (const g of REACT_NAMES) picked.push(...pickFrom(reactGroups.get(g) ?? [], qReact.get(g), c => `${c.react}|${world(c)}|${c.situation.bot.kind}`));
    for (const g of Object.keys(TURN_SHARE)) picked.push(...pickFrom(turnGroups.get(g) ?? [], qTurn.get(g), c => `${c.topic ?? c.situation.hint?.intent ?? '-'}|${world(c)}|${c.situation.bot.kind}`));

    // ── 4. the human's name ──
    picked = picked.map(c => {
        const s = c.situation;
        const taken = namesIn(s);
        let name = playerName();
        while (taken.has(name.toLowerCase())) name = playerName();
        return { ...c, human: name, situation: rename(s, name), ruleText: renamed(c.ruleText, name), hint: renamed(c.hint, name) };
    });

    // ── 5. the stratified order, the target splits, the batches ──
    const KIND_ORDER = ['skiller', 'fighter', 'balanced', 'random', 'extras_social', 'extras_vendor', 'extras_pker', 'extras_edgeville_pker'];
    const GROUP_ORDER = [...REACT_NAMES, ...Object.keys(TURN_SHARE)];
    const stratum = c => [c.kind === 'reaction' ? 0 : 1, String(GROUP_ORDER.indexOf(c.group)).padStart(2, '0'), world(c), String(KIND_ORDER.indexOf(c.situation.bot.kind)).padStart(2, '0'), c.situation.bot.ageBand, c.situation.bot.newbie ? 'n' : 'o'].join('|');
    shuffle(picked);
    picked.sort((a, b) => (stratum(a) < stratum(b) ? -1 : stratum(a) > stratum(b) ? 1 : 0));
    const sides = [
        { name: 'react', list: picked.filter(c => c.kind === 'reaction'), target: TARGET_REACT, split: 'target-react' },
        { name: 'turn', list: picked.filter(c => c.kind !== 'reaction'), target: TARGET_TURN, split: 'target-turn' }
    ];
    let n = 0;
    for (const side of sides) {
        const step = side.list.length / Math.max(1, side.target);
        const at = new Set(Array.from({ length: Math.min(side.target, side.list.length) }, (_, i) => Math.floor(i * step + step / 2)));
        side.list.forEach((c, i) => {
            c.id = `r3-${pad(++n, 4)}`;
            c.split = at.has(i) ? side.split : 'train';
        });
        const batches = Math.max(1, Math.round(side.list.length / BATCH));
        let nTrain = 0;
        let nTarget = 0;
        for (const c of side.list) c.batch = `r3-${side.name}-${pad(1 + ((c.split === 'train' ? nTrain++ : nTarget++) % batches), 2)}`;
        side.batches = batches;
    }
    picked = sides.flatMap(s => s.list);

    // ── the numbers ──
    const count = (list, f) => {
        const m = new Map();
        for (const c of list) m.set(f(c), (m.get(f(c)) ?? 0) + 1);
        return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const pct = (k, d) => `${Math.round((k / d) * 1000) / 10} %`;
    const show = (title, list, f) => console.log(`${title}: ${count(list, f).map(([k, v]) => `${k} ${v} (${pct(v, list.length)})`).join(', ')}`);
    console.log(`captures ${stats.captures} from ${stats.runs} runs; replies to the human left out ${stats.replies}; no group ${stats.noGroup}; duplicates dropped ${stats.dupExact} exact, ${stats.dupBot} same bot, ${stats.dupHint} over the hint caps; candidates: reactions ${stats.candidates.reactions}, turns ${stats.candidates.turns}`);
    console.log(`candidates by group: ${[...reactGroups.entries(), ...turnGroups.entries()].map(([g, l]) => `${g} ${l.length}`).join(', ')}`);
    console.log(`quotas: ${[...qReact.entries(), ...qTurn.entries()].map(([g, q]) => `${g} ${q}`).join(', ')}`);
    for (const g of [...REACT_NAMES, ...Object.keys(TURN_SHARE)]) {
        const have = (reactGroups.get(g) ?? turnGroups.get(g) ?? []).length;
        const want = REACT_NAMES.includes(g) ? Math.round(REACT / REACT_NAMES.length) : Math.round(TURN_SHARE[g] * TURNS);
        if (have < want) console.log(`  SHORT: ${g} has ${have} candidates for ${want}`);
    }
    console.log(`picked ${picked.length}: ${count(picked, c => c.split).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    show('kind', picked, c => c.kind);
    show('group', picked, c => c.group);
    show('reaction', picked.filter(c => c.kind === 'reaction'), c => c.react);
    show('topic', picked.filter(c => c.kind === 'thread'), c => c.topic ?? '-');
    show('world', picked, c => `${c.members ? 'members' : 'free'} x${c.xpRate} ${c.bots}`);
    show('bot kind', picked, c => c.situation.bot.kind);
    show('age band', picked, c => c.situation.bot.ageBand);
    show('rude', picked, c => (c.situation.bot.voice.rude ? 'rude' : 'not'));
    show('source', picked, c => (c.staging ? 'staged' : 'natural'));
    show('target-react', picked.filter(c => c.split === 'target-react'), c => c.group);
    show('target-turn', picked.filter(c => c.split === 'target-turn'), c => c.group);
    for (const b of [...new Set(picked.map(c => c.batch))].sort()) {
        const rows = picked.filter(c => c.batch === b);
        console.log(`  batch-${b}: ${rows.length} (train ${rows.filter(c => c.split === 'train').length}, target ${rows.filter(c => c.split !== 'train').length}); ${count(rows, c => c.group).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    }
    if (args.dry === 'true') return;

    // ── write ──
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(
        path.join(DATA, 'r3-situations.jsonl'),
        picked.map(c => JSON.stringify({ id: c.id, split: c.split, batch: c.batch, ambient: c.kind, group: c.group, react: c.react ?? null, topic: c.topic ?? null, turn: c.turn ?? null, source: { config: c.config, staged: c.staged ?? null, seed: c.seed, members: c.members, xpRate: c.xpRate, bots: c.bots, t: c.t }, ruleText: c.ruleText, event: c.event ?? null, situation: c.situation })).join('\n') + '\n'
    );
    fs.writeFileSync(
        path.join(DATA, 'r3-prompts.jsonl'),
        picked
            .map(c => {
                const p = guard.renderLocal(c.situation);
                return JSON.stringify({ id: c.id, via: c.situation.heard.via, hint: c.situation.hint, kind: c.kind, ruleText: c.ruleText, system: p.system, user: p.user, situation: c.situation });
            })
            .join('\n') + '\n'
    );
    console.log(`wrote ${path.join(DATA, 'r3-situations.jsonl')} and r3-prompts.jsonl`);
}

async function finish() {
    if (!args.old || !args.data || !args.gen) {
        console.error('usage: select-r3.mjs finish --old=<phase7-data-r2> --data=<data-r3> --gen=<gen.jsonl>');
        process.exit(2);
    }
    const OLD = path.resolve(args.old);
    const DATA = path.resolve(args.data);
    const GEN = path.resolve(args.gen);
    const rows = readJsonl(path.join(DATA, 'r3-situations.jsonl'));
    const gen = new Map(readJsonl(GEN).map(r => [r.id, r]));
    const missing = rows.filter(r => !gen.has(r.id));
    if (missing.length) throw new Error(`finish: ${missing.length} rows have no generated line (${missing.slice(0, 3).map(r => r.id).join(', ')} ...)`);
    const lib = await importInEngine(path.join(here, 'guard-lib.ts'), 'model-select-r3-finish');
    lib.loadWordEnc();
    for (const r of rows) {
        const text = String(gen.get(r.id).text ?? '');
        const g = lib.guardReply(text, r.situation, { ambient: true });
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
    // round 2's files, as they are
    const copy = (from, to) => {
        if (!fs.existsSync(from)) return;
        if (fs.existsSync(to) && fs.readFileSync(to).equals(fs.readFileSync(from))) return;
        if (fs.existsSync(to)) throw new Error(`finish: ${to} exists and differs from ${from}: not overwritten`);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
    };
    for (const f of ['eval.jsonl', 'target.jsonl', 'notes.jsonl', 'BRIEF.md', 'BRIEF-R2.md']) copy(path.join(OLD, f), path.join(DATA, f));
    for (const f of fs.readdirSync(path.join(OLD, 'replies')).filter(f => /^batch-\d\d\.jsonl$/.test(f))) copy(path.join(OLD, 'replies', f), path.join(DATA, 'replies', f));
    for (const [from, to] of [['gen-base-fewshot.jsonl', 'gen-base-fewshot.jsonl'], ['gen-r1.jsonl', 'gen-r1.jsonl'], ['gen-lora.jsonl', 'gen-r2.jsonl'], ['gen-lora-think.jsonl', 'gen-r2-think.jsonl'], ['target-gen-r1.jsonl', 'target-gen-r1.jsonl'], ['report.json', 'report-r2.json']]) copy(path.join(OLD, 'eval', from), path.join(DATA, 'eval', to));
    // situations.jsonl: round 2's rows unchanged, then the r3 rows
    const oldText = fs.readFileSync(path.join(OLD, 'situations.jsonl'), 'utf8');
    const ids = new Set(oldText.split('\n').filter(l => l.trim()).map(l => JSON.parse(l).id));
    for (const r of rows) if (ids.has(r.id)) throw new Error(`finish: ${r.id} is already an id of round 2's data`);
    const newRow = r => JSON.stringify({ id: r.id, split: r.split, batch: r.batch, ambient: r.ambient, group: r.group, react: r.react, topic: r.topic, turn: r.turn, source: r.source, kind: r.ambient, ruleText: r.ruleText, event: r.event, situation: r.situation, modelReply: r.modelReply, modelGuard: r.modelGuard });
    fs.writeFileSync(path.join(DATA, 'situations.jsonl'), (oldText.endsWith('\n') ? oldText : `${oldText}\n`) + rows.map(newRow).join('\n') + '\n');
    fs.mkdirSync(path.join(DATA, 'batches'), { recursive: true });
    const batches = [...new Set(rows.map(r => r.batch))].sort();
    for (const b of batches) {
        const list = rows.filter(r => r.batch === b);
        fs.writeFileSync(path.join(DATA, 'batches', `batch-${b}.jsonl`), list.map(r => JSON.stringify({ id: r.id, split: r.split, ambient: r.ambient, group: r.group, situation: r.situation, ruleText: r.ruleText, event: r.event, kind: r.ambient, modelReply: r.modelReply, modelGuard: r.modelGuard })).join('\n') + '\n');
    }
    const prompts = new Map(readJsonl(path.join(DATA, 'r3-prompts.jsonl')).map(p => [p.id, p]));
    for (const split of ['target-react', 'target-turn']) {
        const list = rows.filter(r => r.split === split);
        fs.writeFileSync(path.join(DATA, `${split}.jsonl`), list.map(r => JSON.stringify({ id: r.id, situation: r.situation, ruleText: r.ruleText, kind: r.ambient, group: r.group, event: r.event })).join('\n') + '\n');
        // (its prompts, as assemble writes them but with no reference yet: build-model.sh target-r3-base before the writers)
        fs.writeFileSync(path.join(DATA, `${split}-prompts.jsonl`), list.map(r => JSON.stringify({ ...prompts.get(r.id), group: r.group, event: r.event, reference: null })).join('\n') + '\n');
        // (the rules' lines beside the baseline: build-model.sh target-r3-base writes the round 2 model's lines on the
        // split there, and their scores)
        fs.mkdirSync(path.join(DATA, 'eval', 'r2-on-target-r3'), { recursive: true });
        fs.writeFileSync(path.join(DATA, 'eval', 'r2-on-target-r3', `${split}-rules.jsonl`), list.map(r => JSON.stringify({ id: r.id, variant: 'rules', text: r.ruleText })).join('\n') + '\n');
    }
    fs.writeFileSync(path.join(DATA, 'eval', 'r3-gen-r2.jsonl'), rows.map(r => JSON.stringify({ ...gen.get(r.id), variant: 'r2' })).join('\n') + '\n');

    // the numbers: the round 2 model on the new situations
    const count = (list, f) => {
        const m = new Map();
        for (const r of list) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
        return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const ok = rows.filter(r => r.modelGuard === 'ok').length;
    console.log(`finish: ${rows.length} rows (${count(rows, r => r.split).map(([k, v]) => `${k} ${v}`).join(', ')}) in ${batches.length} batches; the round 2 model: ok ${ok} (${Math.round((ok / rows.length) * 1000) / 10} %)`);
    for (const g of [...new Set(rows.map(r => r.group))]) {
        const list = rows.filter(r => r.group === g);
        console.log(`  ${g}: ok ${list.filter(r => r.modelGuard === 'ok').length}/${list.length}; ${count(list.filter(r => r.modelGuard !== 'ok'), r => r.modelGuard).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    }
    for (const b of batches) {
        const list = rows.filter(r => r.batch === b);
        console.log(`  batch-${b}.jsonl: ${list.length} rows (train ${list.filter(r => r.split === 'train').length}, target ${list.filter(r => r.split !== 'train').length})`);
    }
    console.log(`wrote ${DATA}: situations.jsonl (round 2's + r3), batches/, target-react.jsonl, target-turn.jsonl, eval/r2-on-target-r3/, and round 2's files`);
}

if (command === 'select') await select();
else if (command === 'finish') await finish();
else {
    console.error('usage: select-r3.mjs select|finish ... (see the header)');
    process.exit(2);
}
