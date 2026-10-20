#!/usr/bin/env node
// Which of the bot's own facts the lines use (the realism work, phase 7, round 2: the weak spots of the first blind
// test were the facts left out: "show me what" to "show me ur inv"). Each line is read as notes.mjs reads a written
// reply (its numbers against the levels, total, combat and HP; its words against what the bot carries and wears, what it
// does and where it is; the rules' answer when it keeps it), per focus of the target split (facts, follow-ups, the long
// tail, ordinary), beside the writers' reference when the prompts carry one:
//   facts    the share of lines that state one of the bot's facts (the rules' answer kept does not count)
//   recall   of the situations whose reference states a kind of fact (carrying, wearing, a level, what it does, where
//            it is, lately, the world), how many lines state the same kind
//
//   node fact-use.mjs --prompts=<target-prompts.jsonl> <name>=<gen.jsonl> ...
//   (e.g. --prompts=phase7-data-r2/lm-both/target-prompts.jsonl r1=eval/target-gen-r1.jsonl e2=<run>/epoch2/target-gen.jsonl)
import fs from 'fs';
import path from 'path';
import { noteOf } from './notes.mjs';

const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.filter(a => a.startsWith('--')).map(a => ((m => (m ? [m[1], m[2] ?? 'true'] : [a, 'true']))(a.match(/^--([^=]+)(?:=(.*))?$/)))));
const lines = argv.filter(a => !a.startsWith('--')).map(a => a.split('='));
if (!args.prompts || !lines.length) {
    console.error('usage: node fact-use.mjs --prompts=<target-prompts.jsonl> <name>=<gen.jsonl> ...');
    process.exit(2);
}
const readJsonl = file =>
    fs
        .readFileSync(path.resolve(file), 'utf8')
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l));

const rows = readJsonl(args.prompts);
const gens = lines.map(([name, file]) => [name, new Map(readJsonl(file).map(r => [r.id, r.text]))]);
const hasReference = rows.some(r => typeof r.reference === 'string');
if (hasReference) gens.unshift(['reference', new Map(rows.map(r => [r.id, r.reference]))]);

/** the facts a line states, as its note would say them ("carrying 13 shrimps", "wc 26", "doing: ...") */
function usesOf(s, text) {
    const m = noteOf(s, text ?? '').match(/uses: (.*?)\. tone:/);
    return !m || m[1] === 'nothing' ? [] : m[1].split(', ');
}
const KINDS = [
    ['carrying', 'carrying'],
    ['wearing', 'wearing'],
    ['doing', 'doing'],
    ['where', 'where'],
    ['wilderness', 'where'],
    ['the answer', 'hint'],
    ['lately', 'lately'],
    ['world', 'world']
];
const kindOf = u => KINDS.find(([prefix]) => u.startsWith(prefix))?.[1] ?? 'level';
const factKinds = (s, text) => new Set(usesOf(s, text).map(kindOf).filter(k => k !== 'hint'));

const focuses = [...new Set(rows.map(r => r.focus ?? 'all'))];
const groups = [['all', rows], ...(focuses.length > 1 ? focuses.map(f => [f, rows.filter(r => (r.focus ?? 'all') === f)]) : [])];
for (const [focus, rs] of groups) {
    const cells = gens.map(([name, gen]) => {
        let facts = 0;
        let hit = 0;
        let asked = 0;
        for (const r of rs) {
            const kinds = factKinds(r.situation, gen.get(r.id));
            if (kinds.size) facts++;
            if (!hasReference) continue;
            const ref = factKinds(r.situation, r.reference);
            if (!ref.size) continue;
            asked++;
            if ([...ref].some(k => kinds.has(k))) hit++;
        }
        return `${name}: facts ${Math.round((100 * facts) / rs.length)} %${hasReference ? `, recall ${hit}/${asked}` : ''}`;
    });
    console.log(`${focus} (${rs.length}): ${cells.join(' | ')}`);
}
