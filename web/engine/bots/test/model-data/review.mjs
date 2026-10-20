#!/usr/bin/env node
// The human-read parts of the language model's evaluation (the realism work, phase 7, Track L: the research):
//   judge-sheet  a blind sheet of N held-out situations, each with two replies (X and Y, shuffled) from two generated
//                files, or three (X, Y, Z) with --c, for the judge pass: "sounds like a 2004 player" 1-5, "true to the
//                facts" yes/no, "in the persona's voice" 1-5, with --answers (the retrain's weak spot) "answers the
//                line" yes/no and the best reply named; the key apart.
//                node review.mjs judge-sheet --a=base=<gen.jsonl> --b=lora=<gen.jsonl> [--c=<name>=<gen.jsonl>] [--answers] [--n=100] [--seed=7] --out=<sheet.md> --key=<key.json>
//   judge-tally  the scores ({"1": {"X": [2004, facts 1/0, persona(, answers 1/0)], "Y": [...](, "best": "X"|"Y"|"Z"|"tie")}, ...})
//                by variant, through the key.
//                node review.mjs judge-tally --key=<key.json> --scores=<scores.json> [--json=<out.json>]
//   blind-pick   a blind A/B test: 40 held-out situations the LoRA's line passed the guard on (20 the rules
//                answered: against the rules' line; 20 they leave unanswered: against a Claude-written line); prints the
//                20 that need a Claude-written reply (claude.json: {"id": "reply"}).
//                node review.mjs blind-pick --lora=<gen.jsonl> [--seed=11] --out=<picks.json>
//   blind-build  blind-test.md (the situations in short, A and B shuffled) and blind-test-key.json.
//                node review.mjs blind-build --picks=<picks.json> --claude=<claude.json> --lora=<gen.jsonl> --md=<blind-test.md> --key=<key.json>
// The prompts are phase7-data/lm/eval-prompts.jsonl (--prompts=). The replies are as the guard leaves them (guard-lib).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { importInEngine } from '../lib/clone.mjs';

process.removeAllListeners('warning');
const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const command = argv[0];
const args = Object.fromEntries(argv.filter(a => a.startsWith('--')).map(a => ((m => (m ? [m[1], m[2] ?? 'true'] : [a, 'true']))(a.match(/^--([^=]+)(?:=(.*))?$/)))));
// the held-out prompts: --prompts, else PHASE7_DATA's lm/eval-prompts.jsonl (the training data is not published with the
// repo, so one of them must name a copy of it)
const PROMPTS_ARG = args.prompts ?? (process.env.PHASE7_DATA ? path.join(process.env.PHASE7_DATA, 'lm/eval-prompts.jsonl') : null);
const PROMPTS = PROMPTS_ARG ? path.resolve(PROMPTS_ARG) : null;
function promptsFile() {
    if (!PROMPTS) {
        console.error('review: --prompts=<phase7-data>/lm/eval-prompts.jsonl (or PHASE7_DATA) is required: the training data is not published with the repo');
        process.exit(2);
    }
    return PROMPTS;
}
const readJsonl = file =>
    fs
        .readFileSync(path.resolve(file), 'utf8')
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l));
const out = (file, text) => fs.writeFileSync(path.resolve(file), text);

/** a seeded shuffle (mulberry32): the sheets come out the same for the same seed */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function shuffle(xs, rand) {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function voiceWords(s) {
    const v = s.bot.voice;
    const w = [v.rude ? 'rude' : v.friendliness < 0.15 ? 'blunt' : v.friendliness > 0.6 ? 'friendly' : 'chill'];
    w.push(v.abbreviate >= 0.5 ? 'lots of abbreviations' : v.abbreviate >= 0.2 ? 'some abbreviations' : 'types words out');
    if (v.helpfulness >= 0.6) w.push('helpful');
    w.push(v.chattiness >= 12 ? 'chatty' : v.chattiness <= 3 ? 'quiet' : 'says a bit');
    return w.join(', ');
}
const KIND = { skiller: 'skiller', fighter: 'fighter', balanced: 'all-rounder', random: 'all-rounder', extras_social: 'hangs out', extras_vendor: 'merchant', extras_pker: 'pker', extras_edgeville_pker: 'pker' };
const VIA = { named: 'said near it, with its name', private: 'a private message', conversation: 'the next line of a chat with it', crowd: 'said to nobody; it answers as a bystander', second: 'another bot answered first', window: 'an answer to its own last line' };

/** a situation in short (full: every level and the hint, for the judge; else the blind test's shorter view) */
function brief(s, full) {
    const f = s.facts;
    const b = s.bot;
    const lines = [];
    lines.push(`**${b.name}**: ${b.age}, ${b.region}, ${b.newbie ? 'a new player' : KIND[b.kind] ?? b.kind}. Voice: ${voiceWords(s)}. ${s.world.members ? 'Members' : 'Free'} world.`);
    const doing = f.activity ?? (f.place ? `standing ${f.place}` : 'standing around');
    const top = Object.entries(f.levels)
        .sort((x, y) => y[1] - x[1])
        .slice(0, 4)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ');
    const levels = full ? Object.entries(f.levels).map(([k, v]) => `${k} ${v}`).join(' ') : `best: ${top}`;
    lines.push(`Combat ${f.combat}, total ${f.total} (${levels}); HP ${f.hp[0]}/${f.hp[1]}; ${doing}${f.wilderness ? `, wilderness ${f.wilderness}` : ''}; online ${f.online} min.`);
    const extra = [];
    if (f.worn.length) extra.push(`wears ${f.worn.join(', ')}`);
    if (f.carrying.length) extra.push(`carries ${f.carrying.join(', ')}`);
    if (f.events.length) extra.push(`lately: ${f.events.join('; ')}`);
    if (f.friendsNear.length) extra.push(`friends near: ${f.friendsNear.join(', ')}`);
    if (extra.length) lines.push(`${extra.join('. ')}.`);
    const hist = s.history.slice(full ? -6 : -3);
    if (hist.length) lines.push(`Chat before: ${hist.map(h => `${h.pm ? '[pm] ' : ''}${h.name}: "${h.text}"`).join(' · ')}`);
    const where = s.human.distance < 0 ? 'a PM' : `${s.human.distance} tiles away`;
    lines.push(`**${s.human.name}** (combat ${s.human.combat}, ${where}; ${VIA[s.heard.via] ?? s.heard.via}): **"${s.heard.text}"**`);
    if (full) lines.push(`Hint (the rules understood): ${s.hint ? `${s.hint.intent}: "${s.hint.text}"` : 'none'}`);
    return lines.join('  \n');
}

async function guardLib() {
    const lib = await importInEngine(path.join(here, 'guard-lib.ts'), 'model-review');
    lib.loadWordEnc();
    return lib;
}
const guarded = (lib, text, s) => {
    const g = lib.guardReply(text ?? '', s);
    return g.ok ? { text: g.text, ok: true } : { text: String(text ?? '').trim(), ok: false, reason: g.reason };
};

async function judgeSheet() {
    const variants = ['a', 'b', 'c'].filter(k => args[k]).map(k => args[k].split('='));
    const sides = ['X', 'Y', 'Z'].slice(0, variants.length);
    const answers = args.answers === 'true';
    const prompts = readJsonl(promptsFile());
    const gens = variants.map(([, file]) => new Map(readJsonl(file).map(r => [r.id, r.text])));
    const rand = rng(Number(args.seed ?? 7));
    const n = Number(args.n ?? 100);
    // (stratified by via: each via in proportion)
    const byVia = {};
    for (const p of prompts) (byVia[p.via] ??= []).push(p);
    let picked = [];
    for (const [via, list] of Object.entries(byVia)) picked.push(...shuffle(list, rand).slice(0, Math.round((list.length / prompts.length) * n)));
    picked = shuffle(picked, rand).slice(0, n);
    const lib = await guardLib();
    const key = {};
    const count = ['', '', 'two', 'three'][variants.length];
    const md = [
        `# Judge sheet (${picked.length} held-out situations, ${count} replies each, blind)`,
        '',
        answers
            ? 'Score each reply: 2004 (1-5), facts (1 = true to the facts, 0 = not), persona (1-5), answers (1 = it answers the line or fits it, 0 = a non sequitur or a dodge); then name the best reply (or tie).'
            : 'Score each reply: 2004 (1-5), facts (1 = true to the facts, 0 = not), persona (1-5).',
        ''
    ];
    picked.forEach((p, i) => {
        // (two replies: one coin, as the first sheets were drawn; three: a shuffle)
        const order = variants.length === 2 ? (rand() < 0.5 ? [1, 0] : [0, 1]) : shuffle([...variants.keys()], rand);
        const replies = order.map(v => guarded(lib, gens[v].get(p.id), p.situation));
        key[i + 1] = { id: p.id, ...Object.fromEntries(sides.map((side, j) => [side, variants[order[j]][0]])), ...Object.fromEntries(sides.map((side, j) => [`guard${side}`, replies[j].ok ? 'ok' : replies[j].reason])) };
        md.push(`## ${i + 1} (${p.id})`, brief(p.situation, true), '', ...sides.map((side, j) => `- ${side}: \`${replies[j].text}\`${replies[j].ok ? '' : ` (guard: ${replies[j].reason})`}`), '');
    });
    out(args.out, md.join('\n'));
    out(args.key, JSON.stringify(key, null, 1) + '\n');
    console.log(`judge-sheet: ${picked.length} situations -> ${args.out} (key ${args.key})`);
}

function judgeTally() {
    const key = JSON.parse(fs.readFileSync(path.resolve(args.key), 'utf8'));
    const scores = JSON.parse(fs.readFileSync(path.resolve(args.scores), 'utf8'));
    const by = {};
    let ties = 0;
    for (const [n, k] of Object.entries(key)) {
        const sc = scores[n];
        if (!sc) continue;
        const sides = ['X', 'Y', 'Z'].filter(side => k[side] && sc[side]);
        for (const side of sides) {
            const v = k[side];
            const [voice, facts, persona, answers] = sc[side];
            by[v] ??= { n: 0, voice: 0, facts: 0, persona: 0, answers: 0, answered: 0, voiceHist: [0, 0, 0, 0, 0], better: 0, best: 0 };
            by[v].n++;
            by[v].voice += voice;
            by[v].facts += facts;
            by[v].persona += persona;
            by[v].voiceHist[voice - 1]++;
            if (answers !== undefined) {
                by[v].answers += answers;
                by[v].answered++;
            }
        }
        // (preferred: the higher 2004 + persona, a unique top; best: the judge's own pick)
        const sums = sides.map(side => sc[side][0] + sc[side][2]);
        const top = Math.max(...sums);
        if (sums.filter(x => x === top).length === 1) by[k[sides[sums.indexOf(top)]]].better++;
        if (sc.best === 'tie') ties++;
        else if (sc.best && k[sc.best]) by[k[sc.best]].best++;
    }
    const result = Object.fromEntries(
        Object.entries(by).map(([v, s]) => [
            v,
            {
                judged: s.n,
                '2004 (1-5)': Math.round((s.voice / s.n) * 100) / 100,
                '2004 histogram 1..5': s.voiceHist,
                'true to the facts': `${Math.round((s.facts / s.n) * 1000) / 10} %`,
                'persona (1-5)': Math.round((s.persona / s.n) * 100) / 100,
                ...(s.answered ? { 'answers the line': `${Math.round((s.answers / s.answered) * 1000) / 10} %` } : {}),
                'preferred (2004 + persona)': s.better,
                ...(Object.values(scores).some(sc => sc.best) ? { 'the judge\'s best': s.best } : {})
            }
        ])
    );
    if (Object.values(scores).some(sc => sc.best)) result.ties = ties;
    console.log(JSON.stringify(result, null, 1));
    if (args.json) out(args.json, JSON.stringify(result, null, 1) + '\n');
}

async function blindPick() {
    const prompts = readJsonl(promptsFile());
    const lora = new Map(readJsonl(args.lora).map(r => [r.id, r.text]));
    const rand = rng(Number(args.seed ?? 11));
    const lib = await guardLib();
    // (situations the LoRA's line passed the guard on: a refused line is never said in the game, the rules' is)
    const usable = prompts.filter(p => lib.guardReply(lora.get(p.id) ?? '', p.situation).ok);
    // (the rules' half: situations they answered; the Claude half: the long tail they leave unanswered)
    const withRules = shuffle(usable.filter(p => p.ruleText), rand);
    const others = shuffle(usable.filter(p => !p.ruleText), rand);
    // (spread over the vias: at most 8 of one via in each half)
    const take = (list, n) => {
        const got = [];
        const count = {};
        for (const p of list) {
            if (got.length >= n) break;
            if ((count[p.via] ?? 0) >= 8) continue;
            count[p.via] = (count[p.via] ?? 0) + 1;
            got.push(p);
        }
        return got;
    };
    const rulesHalf = take(withRules, 20);
    const claudeHalf = take(others, 20);
    const picks = [...rulesHalf.map(p => ({ id: p.id, against: 'rules' })), ...claudeHalf.map(p => ({ id: p.id, against: 'claude' }))];
    out(args.out, JSON.stringify(picks, null, 1) + '\n');
    console.log(`blind-pick: ${picks.length} -> ${args.out}; Claude-written replies needed for:`);
    for (const p of claudeHalf) console.log(`\n=== ${p.id}\n${brief(p.situation, true)}\n(rules: ${p.ruleText ?? 'nothing'})`);
}

async function blindBuild() {
    const prompts = new Map(readJsonl(promptsFile()).map(p => [p.id, p]));
    const picks = JSON.parse(fs.readFileSync(path.resolve(args.picks), 'utf8'));
    const claude = JSON.parse(fs.readFileSync(path.resolve(args.claude), 'utf8'));
    const lora = new Map(readJsonl(args.lora).map(r => [r.id, r.text]));
    const rand = rng(Number(args.seed ?? 13));
    const lib = await guardLib();
    const order = shuffle(picks, rand);
    const key = {};
    const md = [
        '# Blind test: which reply sounds like a real 2004 player?',
        '',
        "40 situations from the held-out set (the model never trained on them). In each, a bot hears the human's line and two replies are shown, A and B, in a random order. One is the trained on-device model's (Qwen3.5-0.8B with the 2004 LoRA, as the game would say it before the persona's typing style is added); the other is the rules' own line (what the game says today) or a line written by Claude to the writers' brief. The key is in `blind-test-key.json`: look only after you have marked them.",
        '',
        'For each, mark A, B, "both fine" or "both off", and anything that gives a line away.',
        ''
    ];
    order.forEach((pick, i) => {
        const p = prompts.get(pick.id);
        const model = guarded(lib, lora.get(p.id), p.situation).text;
        const other = pick.against === 'rules' ? p.ruleText.replaceAll('{name}', p.situation.human.name) : claude[p.id];
        if (!other) throw new Error(`blind-build: no Claude-written reply for ${p.id}`);
        const swap = rand() < 0.5;
        const [a, b] = swap ? [other, model] : [model, other];
        key[i + 1] = { id: p.id, A: swap ? pick.against : 'model', B: swap ? 'model' : pick.against };
        md.push(`## ${i + 1}`, brief(p.situation, false), '', `- **A**: \`${a}\``, `- **B**: \`${b}\``, '', 'Your pick: ', '');
    });
    out(args.md, md.join('\n'));
    out(args.key, JSON.stringify({ note: 'model = the LoRA (the cache's models/bots-2004-q4km.gguf), rules = the rules\' own line, claude = written by the L-train agent to phase7-data/BRIEF.md', items: key }, null, 1) + '\n');
    console.log(`blind-build: ${order.length} -> ${args.md} (key ${args.key})`);
}

if (command === 'judge-sheet') await judgeSheet();
else if (command === 'judge-tally') judgeTally();
else if (command === 'blind-pick') await blindPick();
else if (command === 'blind-build') await blindBuild();
else {
    console.error('usage: review.mjs judge-sheet|judge-tally|blind-pick|blind-build ... (see the header)');
    process.exit(2);
}
