#!/usr/bin/env node
// The arcs foundation (bots ideas, round 2): the saved arcs,
// the bus and the line helper that themes C (lives with arcs) and D (word that travels) build on. Behaviour-neutral by
// itself (test/identity.mjs against the round's base); here:
//   store     (port/BotArcsStore) a round trip of every goal kind, ties and phrases (the compact encoding, the doc's
//             example entry, the times relative to the export's tick); nothing to save is null (the world JSON unchanged);
//             an old store without arcs, a corrupt section (no throw, nothing restored), a malformed entry skipped and the
//             rest kept, a foreign version; the caps (6 acquaintances, 2 grudges, 2 phrases: the strongest, then the
//             latest; one tie a pair and sign); a synthetic pool of 2,000 bots at the caps within 160 KB (the weakest ties
//             dropped first, goals and phrases kept); a quit's record and every tie to it gone; a tie to a name the pool
//             does not hold, or to no bot's name (a human's), never saved or restored; the catchphrases' list append only
//             (test/ref/catchphrases.lock)
//   world     in the real 274 world: BotManager.exportWorld has no `arcs` while there are none, and carries them when there
//             are; playTicks; a pool name dropped (BotManager._drop: a quit, a human's name) forgets its arcs
//   bus       (port/BotArcsEvents) the logins, the lines said (their kind, a sayArcLine's tag), an event noted, a level-up,
//             a death, a steal reach their listeners; a listener's throw is logged, never reaches the site; what C and D
//             ask of each other (null or false until the other provides it); a registered tick runs every N play ticks; the arcs' play clock is BotManager's (held for a test); and every listed site
//             carries its emit in a marked block (the kill, the duel's end and the director's are checked in their source)
//   say       (port/BotArcsSay) sayArcLine fills the slots (a template with a slot left unfilled, or one the filter would
//             change, is no candidate), says a fresh line once (the registry), and each budget mode counts as intended:
//             'slot' nothing (the due line itself), 'own' one owed line (the debt), 'budgeted' the next due line pushed
//             out, 'chatter' a quiet after it (never sooner); its 'said' event carries the caller's tag
//   leave     BotManager.leaveSoon with `abrupt` and `away`: the bot goes at its time with no wrap-up, its next absence is the
//             one asked; mayLeaveAbruptly refuses a bot with a set-piece role or a trade
//   errors    none
//
//   node --expose-gc web/engine/bots/test/arcs-store.test.mjs [--seed=5] [--update-lock]
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, BOTS_SRC, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';
import { mulberry, scene } from './lib/dice.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const SEED = Number(args.seed ?? 5);
const out = (s = '') => process.stdout.write(s + '\n');
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
const errors = [];
for (const level of ['log', 'info', 'debug', 'warn']) console[level] = () => {};
console.error = (...a) => {
    const text = a.map(String).join(' ');
    if (!text.includes('ExperimentalWarning') && !text.includes('--trace-warnings')) errors.push(text.slice(0, 300));
};
Math.random = mulberry(SEED);

const engineDir = prepareEngineClone('arcs-store', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/arcs.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, ArcsStore: S, ArcsEvents: E } = lib;
const NAMES = lib.BOT_NAMES;
const all = () => true;

// ======== the store (pure) ========
{
    S.resetArcsForTest();
    check('nothing to save: exportArcs is null (the world JSON unchanged), 0 bytes', S.exportArcs(1000) === null && S.arcsBytes() === 0);
    S.arcsOf(NAMES[3]);
    check('an empty record is nothing to save', S.exportArcs(1000) === null);
    S.resetArcsForTest();
}
// ---- the doc's example entry and a round trip of every goal kind ----
{
    S.resetArcsForTest();
    const T = 100_000;
    const [a, b, c, d, e] = [NAMES[100], NAMES[1000], NAMES[1555], NAMES[40], NAMES[2]];
    // (the encoding's example: "2s":"L81o.gg.3op5|q5+4@25p,12j-5@33|182@cd": woodcutting 60, set 592 minutes before t)
    const ra = S.arcsOf(a);
    ra.goal = { kind: 'L', stat: 8, target: 60, since: T - 592 * 100, base: parseInt('3op5', 36) };
    ra.ties = [
        { other: NAMES[parseInt('q5', 36)], sign: 1, strength: 4, last: T - parseInt('25p', 36) * 100 },
        { other: NAMES[parseInt('12j', 36)], sign: -1, strength: 5, last: T - parseInt('33', 36) * 100 }
    ];
    ra.phrases = [{ phrase: parseInt('18', 36), strength: 2, last: T - parseInt('cd', 36) * 100 }];
    S.arcsOf(b).goal = { kind: 'G', target: 1079, since: T - 3000, base: 4200, flags: 3 };
    S.arcsOf(c).goal = { kind: 'M', target: 100, since: T, base: 985 };
    S.arcsOf(d).goal = { kind: 'C', target: 70, since: T - 50, base: 63 };
    S.arcsOf(e).goal = { kind: 'T', target: 1000, since: T - 123456, base: 951 };
    S.arcsOf(e).ties = [{ other: a, sign: 1, strength: 9, last: T - 1 }];
    S.arcsOf(e).phrases = [{ phrase: 0, strength: 9, last: T }];
    const raw = S.exportArcs(T);
    const id = n => S.arcsIdOf(n);
    check("the encoding: { v: 1, t, b: { id36: 'goal|ties|phrases' } }, the encoding's example entry exactly", raw?.v === 1 && raw.t === T && raw.b[id(a)] === 'L81o.gg.3op5|q5+4@25p,12j-5@33|182@cd', raw?.b?.[id(a)]);
    check('the encoding: a goal alone, flags and all ("G..."), trailing empty sections left out', raw?.b?.[id(b)] === `G${(1079).toString(36)}.${(30).toString(36)}.${(4200).toString(36)}.3` && !raw.b[id(c)].includes('|'), [raw?.b?.[id(b)], raw?.b?.[id(c)]]);
    check('the bytes: arcsBytes is the JSON\'s length', S.arcsBytes() === JSON.stringify(raw).length, `${S.arcsBytes()} vs ${JSON.stringify(raw).length}`);
    const before = JSON.parse(JSON.stringify([...S.arcsEntries()]));
    S.resetArcsForTest();
    const P = 7; // the new run's play tick at the restore
    S.restoreArcs(JSON.parse(JSON.stringify(raw)), P, all);
    const after = new Map(S.arcsEntries());
    const rel = t => P - Math.floor((T - t) / 100) * 100;
    const same = before.every(([name, rec]) => {
        const got = after.get(name);
        if (!got) return false;
        const goalOk = !rec.goal || (got.goal && got.goal.kind === rec.goal.kind && got.goal.target === rec.goal.target && got.goal.stat === rec.goal.stat && got.goal.base === rec.goal.base && (got.goal.flags ?? 0) === (rec.goal.flags ?? 0) && got.goal.since === rel(rec.goal.since));
        const tiesOk = JSON.stringify((rec.ties ?? []).map(t => [t.other, t.sign, t.strength, rel(t.last)])) === JSON.stringify((got.ties ?? []).map(t => [t.other, t.sign, t.strength, t.last]));
        const phrasesOk = JSON.stringify((rec.phrases ?? []).map(p => [p.phrase, p.strength, rel(p.last)])) === JSON.stringify((got.phrases ?? []).map(p => [p.phrase, p.strength, p.last]));
        return goalOk && tiesOk && phrasesOk;
    });
    check('a round trip: every goal kind (L G M C T, a stat, flags), the ties (+, -) and phrases back, their times relative to the new play clock (minutes)', same && after.size === before.length, { before: before.length, after: after.size });
    check('a round trip again gives the same section (from the restored records, at the same age)', JSON.stringify(S.exportArcs(P)) === JSON.stringify({ ...raw, t: P }), JSON.stringify(S.exportArcs(P)).slice(0, 200));
    S.resetArcsForTest();
}
// ---- old, corrupt and foreign sections ----
{
    S.resetArcsForTest();
    const a = NAMES[10];
    S.arcsOf(a).goal = { kind: 'C', target: 40, since: 0, base: 30 };
    const good = JSON.parse(JSON.stringify(S.exportArcs(500)));
    S.resetArcsForTest();
    let threw = false;
    try {
        S.restoreArcs(undefined, 0, all);
        S.restoreArcs(null, 0, all);
    } catch {
        threw = true;
    }
    check('an old store without arcs: nothing restored, no throw', !threw && [...S.arcsEntries()].length === 0);
    const throwing = { v: 1, t: 5, b: {} };
    Object.defineProperty(throwing.b, '0', { enumerable: true, get() { throw new Error('boom'); } });
    const corrupt = ['garbage', 42, [], { v: 1 }, { v: 1, t: 'x', b: {} }, { v: 1, t: 1.5, b: {} }, { v: 1, t: 0, b: [] }, { v: 1, t: 0, b: 'L81o' }, { v: 1, t: 0, b: { 0: 5, 1: null, '-': 'C14.0.u', zzzzzz: 'C14.0.u' } }, { v: 1, t: 0, b: { 0: 'L81o.gg', 1: 'Q14.0.u', 2: '|q5+X@2', 3: '||18@x@', 4: 'C14.0.u|||' } }, throwing];
    const restoredAny = [];
    threw = false;
    for (const raw of corrupt) {
        try {
            S.restoreArcs(raw, 0, all);
        } catch {
            threw = true;
        }
        if ([...S.arcsEntries()].length) restoredAny.push(JSON.stringify(raw)?.slice(0, 60));
        S.resetArcsForTest();
    }
    check('a corrupt section (not an object, no or a bad t, b not an object, malformed entries, a getter that throws): no throw, nothing restored', !threw && restoredAny.length === 0, restoredAny.join(' | '));
    S.restoreArcs({ ...good, b: { ...good.b, 0: 'L81o.gg', 1: 'zz+9@9' } }, 0, all);
    check('a malformed entry is skipped, the good one kept', S.peekArcs(a)?.goal?.target === 40 && [...S.arcsEntries()].length === 1, [...S.arcsEntries()].map(([n]) => n));
    S.resetArcsForTest();
    S.restoreArcs({ ...good, v: 2 }, 0, all);
    check('a foreign version (v 2): nothing restored', [...S.arcsEntries()].length === 0);
    threw = false;
    try {
        S.restoreArcs(good, 0, () => {
            throw new Error('known failed');
        });
    } catch {
        threw = true;
    }
    check('a `known` that throws: no throw, nothing restored', !threw && [...S.arcsEntries()].length === 0);
    S.resetArcsForTest();
}
// ---- the caps ----
{
    S.resetArcsForTest();
    const owner = NAMES[50];
    const rec = S.arcsOf(owner);
    rec.ties = [];
    for (let i = 0; i < 10; i++) rec.ties.push({ other: NAMES[200 + i], sign: 1, strength: 1 + (i % 9), last: 1000 + i });
    for (let i = 0; i < 4; i++) rec.ties.push({ other: NAMES[300 + i], sign: -1, strength: 1 + i, last: 2000 + i });
    rec.ties.push({ other: NAMES[208], sign: 1, strength: 2, last: 5 }); // (a second tie to 208: the stronger one counts)
    rec.phrases = [0, 1, 2, 3, 4].map(i => ({ phrase: i, strength: [3, 9, 9, 1, 5][i], last: 100 * i }));
    const raw = S.exportArcs(10_000);
    const [, ties = '', phrases = ''] = raw.b[S.arcsIdOf(owner)].split('|');
    const plus = ties.split(',').filter(t => t.includes('+'));
    const minus = ties.split(',').filter(t => t.includes('-'));
    // (strengths 1-9 then 1: 200..209 have 1,2,...,9,1; the 6 strongest are 9,8,7,6,5,4: NAMES[208..203])
    const keptPlus = plus.map(t => S.arcsNameOf(t.split('+')[0]));
    // (phrases 0-4 at strengths 3 9 9 1 5: the two 9s, 1 and 2, in their order)
    const wantPhrases = [1, 2].map(i => `${i.toString(36)}9@${Math.floor((10000 - 100 * i) / 100).toString(36)}`).join(',');
    check('caps in the export: 6 acquaintances (the strongest), 2 grudges (the strongest), 2 phrases (the strongest, then the latest)', plus.length === 6 && minus.length === 2 && [203, 204, 205, 206, 207, 208].every(i => keptPlus.includes(NAMES[i])) && minus.every(t => ['4', '3'].includes(t.split('-')[1][0])) && phrases === wantPhrases, { plus, minus, phrases, wantPhrases });
    check('one tie a pair and sign: the stronger of two to the same bot', plus.filter(t => S.arcsNameOf(t.split('+')[0]) === NAMES[208]).length === 1 && plus.some(t => t.startsWith(`${S.arcsIdOf(NAMES[208])}+9`)), plus);
    S.trimArcs(rec);
    check('trimArcs: the record in memory within the same caps', rec.ties.filter(t => t.sign > 0).length === 6 && rec.ties.filter(t => t.sign < 0).length === 2 && rec.phrases.length === 2);
    S.resetArcsForTest();
}
// ---- 2,000 bots at the caps: within 160 KB, the weakest ties dropped first ----
{
    S.resetArcsForTest();
    const r = mulberry(SEED * 7 + 1);
    const pool = NAMES.slice(0, 2000);
    const T = 2_000_000;
    for (let i = 0; i < pool.length; i++) {
        const rec = S.arcsOf(pool[i]);
        rec.goal = { kind: 'L', stat: i % 21, target: 99, since: T - Math.floor(r() * 4e6), base: Math.floor(r() * 1.3e6) };
        rec.ties = [];
        for (let k = 0; k < 6; k++) rec.ties.push({ other: pool[(i + 1 + k * 37) % pool.length], sign: 1, strength: 1 + Math.floor(r() * 9), last: T - Math.floor(r() * 6e5) });
        for (let k = 0; k < 2; k++) rec.ties.push({ other: pool[(i + 500 + k * 11) % pool.length], sign: -1, strength: 1 + Math.floor(r() * 5), last: T - Math.floor(r() * 6e5) });
        rec.phrases = [0, 1].map(k => ({ phrase: (i + k * 7) % 46, strength: 1 + Math.floor(r() * 9), last: T - Math.floor(r() * 6e5) }));
    }
    const t0 = performance.now();
    const raw = S.exportArcs(T);
    const ms = performance.now() - t0;
    const json = JSON.stringify(raw);
    const entries = Object.values(raw.b);
    const tieStrengths = entries.flatMap(v => (v.split('|')[1] || '').split(',').filter(Boolean).map(t => Number(t.match(/[+-](\d)@/)[1])));
    const allStrengths = [...S.arcsEntries()].flatMap(([, rec]) => rec.ties.map(t => t.strength));
    const dropped = allStrengths.length - tieStrengths.length;
    const minKept = Math.min(...tieStrengths);
    // (the weakest went first: every strength below the weakest kept is gone, none above it)
    const below = allStrengths.filter(s => s < minKept).length;
    const keptAtMin = tieStrengths.filter(s => s === minKept).length;
    const allAtMin = allStrengths.filter(s => s === minKept).length;
    check(`2,000 bots at the caps: ${json.length} bytes ≤ 160 KB (${dropped} weakest ties of ${allStrengths.length} dropped; every goal and phrase kept; ${ms.toFixed(1)} ms)`, json.length <= 160_000 && S.arcsBytes() === json.length && entries.length === 2000 && entries.every(v => v.split('|')[0] !== '' && (v.split('|')[2] || '').split(',').length === 2) && dropped > 0, { bytes: json.length, dropped });
    check('2,000 bots at the caps: the weakest ties went first (all below the weakest kept, part of its strength)', dropped === below + (allAtMin - keptAtMin) && below + allAtMin - keptAtMin > 0, { minKept, below, keptAtMin, allAtMin, dropped });
    // (typical: a goal and a tie or two: about 45 bytes a bot)
    S.resetArcsForTest();
    for (let i = 0; i < pool.length; i++) {
        const rec = S.arcsOf(pool[i]);
        if (i % 10 < 7) rec.goal = { kind: 'L', stat: i % 21, target: 40 + (i % 50), since: T - Math.floor(r() * 3e5), base: Math.floor(r() * 1e5) };
        if (i % 3 === 0) rec.ties = [{ other: pool[(i + 1) % pool.length], sign: 1, strength: 2, last: T - Math.floor(r() * 3e5) }];
    }
    const typical = JSON.stringify(S.exportArcs(T)).length;
    check(`typical (7 in 10 with a goal, 1 in 3 a tie): about 45 bytes a bot or less (${(typical / 2000).toFixed(1)})`, typical / 2000 <= 50, typical);
    S.resetArcsForTest();
}
// ---- quits, unknown names, the human ----
{
    S.resetArcsForTest();
    const [a, b, c, z] = [NAMES[20], NAMES[21], NAMES[22], NAMES[23]];
    S.arcsOf(a).ties = [{ other: b, sign: 1, strength: 3, last: 0 }, { other: z, sign: -1, strength: 2, last: 0 }];
    S.arcsOf(b).ties = [{ other: a, sign: 1, strength: 3, last: 0 }];
    S.arcsOf(z).goal = { kind: 'C', target: 50, since: 0, base: 40 };
    S.arcsOf(c).ties = [{ other: z, sign: 1, strength: 5, last: 0 }];
    const raw = JSON.parse(JSON.stringify(S.exportArcs(100)));
    S.forgetArcs(z);
    check('a quit (forgetArcs): its record and every tie to it gone, the rest kept', S.peekArcs(z) === undefined && !S.peekArcs(a).ties.some(t => t.other === z) && S.peekArcs(a).ties.length === 1 && S.peekArcs(c)?.ties === undefined, { a: S.peekArcs(a), c: S.peekArcs(c) });
    S.resetArcsForTest();
    S.restoreArcs(raw, 0, n => n !== z);
    check('restore: a record of a name the pool does not hold, and every tie to it, dropped', S.peekArcs(z) === undefined && S.peekArcs(a).ties.length === 1 && S.peekArcs(a).ties[0].other === b && S.peekArcs(c) === undefined, { a: S.peekArcs(a), c: S.peekArcs(c) });
    S.resetArcsForTest();
    // (the human's name is never a bot's: a tie to it has no id and is never written; a record under it neither)
    const human = 'sim human';
    S.arcsOf(a).ties = [{ other: human, sign: 1, strength: 9, last: 0 }, { other: a, sign: 1, strength: 9, last: 0 }];
    S.arcsOf(human).goal = { kind: 'C', target: 50, since: 0, base: 40 };
    check("a tie to the human (no bot's name), to itself, and a record of the human: never saved", S.arcsIdOf(human) === null && S.exportArcs(100) === null);
    S.resetArcsForTest();
}
// ---- the catchphrases' list: append only ----
{
    const LOCK = path.join(BOTS_DIR, 'test/ref/catchphrases.lock');
    const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    const list = lib.CATCHPHRASE_LIST;
    const hash = n => crypto.createHash('sha256').update(list.slice(0, n).join('\n')).digest('hex');
    const kept = list.length >= lock.count && hash(lock.count) === lock.sha256;
    check(`the catchphrases' list is append only: test/ref/catchphrases.lock's ${lock.count} are its first, in order (a saved phrase is its index)`, kept, `${list.length} now`);
    if (kept && args['update-lock'] && list.length > lock.count) {
        fs.writeFileSync(LOCK, JSON.stringify({ ...lock, count: list.length, sha256: hash(list.length) }, null, 4) + '\n');
        out(`catchphrases.lock: ${lock.count} -> ${list.length}`);
    }
    const lines = lib.catchphrasesOf(NAMES[7], lib.personaOf(NAMES[7], 'balanced'));
    check("a bot's catchphrase lines carry their index (Line.phrase, what the 'said' event carries)", lines.length >= 2 && lines.every(l => l.catchphrase && l.phrase === lib.catchphraseIndexOf(l.text) && l.phrase >= 0 && list[l.phrase] === l.text), lines.map(l => [l.text, l.phrase]));
}

// ======== the sites: every listed emit in a marked block ========
{
    const src = f => fs.readFileSync(path.join(BOTS_SRC, f), 'utf8');
    const sites = [
        ['port/BotChatter.ts', ['event', 'levelup']],
        ['port/BotFumble.ts', ['death']],
        ['port/BotRude.ts', ['steal']],
        ['tasks/PKerTask.ts', ['kill']],
        ['tasks/EdgevillePKerTask.ts', ['kill']],
        ['port/BotDuel.ts', ['duel']],
        ['port/BotSay.ts', ['said']],
        ['BotManager.ts', ['login', 'logout']],
        ['port/BotDirector.ts', ['set-piece']]
    ];
    const missing = [];
    for (const [file, kinds] of sites) {
        const text = src(file);
        for (const k of kinds) {
            const at = text.indexOf(`emitArcs({ k: '${k}'`);
            const block = at < 0 ? -1 : text.lastIndexOf('arcs foundation', at);
            if (at < 0 || block < 0 || at - block > 600) missing.push(`${file}: ${k}`);
        }
    }
    check('every site carries its emit in a marked "arcs foundation" block (chatter, fumble, rude, both PK kills, the duel, say, the logins, the director)', missing.length === 0, missing.join(', '));
    const kinds = ['goal-done', 'tilt', 'ninety-nine-near', 'ninety-nine', 'own-party', 'wedding'];
    const events = src('port/BotArcsEvents.ts');
    check("theme C's own kinds are in the bus's type (D listens): goal-done, tilt, ninety-nine-near, ninety-nine, own-party, wedding", kinds.every(k => events.includes(`k: '${k}'`)), kinds.filter(k => !events.includes(`k: '${k}'`)));
    const pieces = src('port/BotSetPieces.ts');
    check("the set pieces' kinds: ninety_nine, mini_party, wedding", ['ninety_nine', 'mini_party', 'wedding'].every(k => pieces.includes(`'${k}'`)));
}

// ======== the world ========
const N = 8;
const heard = { login: [], logout: [], said: [], event: [], levelup: [], death: [], steal: [] };
for (const k of Object.keys(heard)) lib.onArcs(k, e => heard[k].push(e));
const sim = await lib.Sim.create({ bots: N, members: true, debug: false, spawnPerTick: N, ackLogouts: true });
sim.addHuman(3222, 3218, 0);
while (sim.bots().length < N && World.currentTick < 40) sim.tick();
lib.setHabitRatesForTest({ breaks: 0, lingers: 0, watch: 0, abrupt: 0 });
lib.setHangoutRateForTest(0.0001);
lib.setArenaRatesForTest(0);
lib.setDirectorForTest({ first: 1e9, gap: 1e9 });
lib.resetDirectorForTest();
lib.setCliqueBehaviourForTest(false);
lib.setEventRatesForTest({ odds: 0 });
lib.setTrainRatesForTest({ ask: 0, form: 0, yes: 0, join: 0 });
lib.setAlchRateForTest(0);
lib.setScamRatesForTest({ ambient: false });
lib.setWitnessRatesForTest({ death: 0, drop: 0, human: 0, show: 0, gear: 0, level: 0, respond: 0, fight: 0 });
const run = (max, until = () => false) => {
    for (let i = 0; i < max; i++) {
        sim.tick();
        if (until()) return i + 1;
    }
    return -1;
};
run(30);
const bots = sim.bots();
check(`${N} bots in the world`, bots.length === N, bots.length);
const STAND = { name: 'Idle', reset() {}, interrupt() {}, interrupted: false, shouldRun: () => true, isComplete: () => false, tick() {}, activityStep: () => null };
function hold(p) {
    const ai = sim.botPlayer(p);
    ai.currentTask = Object.create(STAND);
    ai.planEnds = World.currentTick + 1e6;
    p.clearWaypoints();
    p.clearPendingAction();
}
for (const p of bots) hold(p);

// ---- the living world's state ----
{
    scene(SEED, 'world');
    S.resetArcsForTest();
    const plain = JSON.stringify(BotManager.exportWorld());
    check('exportWorld: no `arcs` while there are none', !('arcs' in BotManager.exportWorld()) && !plain.includes('"arcs"'));
    const [a, b] = bots;
    S.arcsOf(a.username).goal = { kind: 'L', stat: 14, target: 60, since: lib.arcsPlay() - 100, base: 1000 };
    S.arcsOf(a.username).ties = [{ other: b.username, sign: 1, strength: 2, last: lib.arcsPlay() }];
    const state = BotManager.exportWorld();
    check("exportWorld: the arcs ({ v: 1, t: the play clock, b }) when there are some", state.arcs?.v === 1 && state.arcs.t === BotManager.playTicks() && Object.keys(state.arcs.b).length === 1, state.arcs);
    check('playTicks is the play clock (stats().playTicks), the arcs\' clock too', BotManager.playTicks() === BotManager.stats().playTicks && lib.arcsPlay() === BotManager.playTicks() && BotManager.playTicks() > 0, [BotManager.playTicks(), BotManager.stats().playTicks, lib.arcsPlay()]);
    lib.setPlayForTest(123456);
    check('the arcs\' play clock held for a test (setPlayForTest), then BotManager\'s again', lib.arcsPlay() === 123456 && BotManager.exportWorld().arcs.t === 123456 && (lib.setPlayForTest(null), lib.arcsPlay() === BotManager.playTicks()));
    // (a pool name never in the world leaves the pool: BotManager._drop forgets its arcs and the ties to it)
    const members = BotManager.members;
    const away = [...members.values()].find(m => !m.owned && m.state === 'offline');
    if (away) {
        S.arcsOf(away.name).goal = { kind: 'C', target: 30, since: 0, base: 20 };
        S.arcsOf(a.username).ties.push({ other: away.name, sign: -1, strength: 3, last: 0 });
        BotManager.retire(away.name);
        check('a name that leaves the pool (BotManager._drop: a quit, a human\'s name): its arcs and the ties to it forgotten', !members.has(away.name) && S.peekArcs(away.name) === undefined && !S.peekArcs(a.username).ties.some(t => t.other === away.name));
    } else check('a pool name never in the world to drop', false, 'none');
    S.resetArcsForTest();
}

// ---- the bus ----
{
    scene(SEED, 'bus');
    const logins = new Set(heard.login.map(e => e.name));
    check('the bus: every bot\'s login (BotManager._cameOnline), with its Player', bots.every(p => logins.has(p.username)) && heard.login.every(e => e.bot && e.bot.username === e.name), [...logins]);
    check("the bus: the chatter's events (each bot's 'login' event at its first tick)", bots.every(p => heard.event.some(e => e.bot === p && e.name === 'login')), heard.event.length);
    const [a, b, c] = bots;
    const nEvent = heard.event.length;
    lib.SayChatter.noteEvent(a, 'drop', { item: 'rune med' });
    check("the bus: noteEvent's event with its data", heard.event.length === nEvent + 1 && heard.event.at(-1).name === 'drop' && heard.event.at(-1).item === 'rune med' && heard.event.at(-1).bot === a);
    lib.SayChatter.chatterLevelUp(a, 'WOODCUTTING', 41, false, null);
    const lv = heard.levelup.at(-1);
    check("the bus: a level-up (its stat's number, name, level)", lv?.bot === a && lv.skill === 'WOODCUTTING' && lv.stat === lib.PlayerStat.WOODCUTTING && lv.level === 41 && lv.milestone === false, lv && { stat: lv.stat, skill: lv.skill, level: lv.level });
    lib.noteDeath(b, true);
    check('the bus: a death (in the Wilderness), whatever the planner', heard.death.at(-1)?.bot === b && heard.death.at(-1).wild === true);
    const target = { x: a.x, z: a.z };
    lib.noteSteal('rock', a, c, target, false, 'free');
    const st = heard.steal.at(-1);
    check('the bus: a steal (the incident, its two players)', st?.stealer === a && st.victim === c && st.incident.kind === 'rock' && st.incident.deliberate === true && !st.again, st && { kind: st.incident.kind, again: st.again });
    // (a listener's throw: logged, counted in the errors, the site goes on)
    // (bots ideas, round 2: D word: the themes' own listeners count too: the count is the one before the test's)
    const listening = E.arcsListenerCount('event');
    const stop = lib.onArcs('event', () => {
        throw new Error('a listener that throws');
    });
    const errs = lib.botErrorCount();
    const nErrors = errors.length;
    let threw = false;
    try {
        lib.SayChatter.noteEvent(a, 'arrival');
    } catch {
        threw = true;
    }
    stop();
    check("a listener's throw is logged (the bots' errors), never reaches the site", !threw && lib.botErrorCount() === errs + 1 && errors.length === nErrors + 1 && E.arcsListenerCount('event') === listening, { threw, errs: lib.botErrorCount() - errs });
    errors.splice(nErrors, 1); // (that one was the test's)
    // (a registered pass: every 10 play ticks, with the play clock)
    const calls = [];
    const stopTick = lib.registerArcsTick((now, play) => calls.push([now, play]), 10);
    run(35);
    stopTick();
    run(15);
    // (what C and D ask of each other: null or false while the other is not there; a provider's answer; its throw logged)
    const absent = E.arcsTie(a.username, b.username) === null && E.arcsKnows(a, 'party') === false && E.arcsMood(a) === null;
    E.provideArcs('tieOf', (x, y) => (x === a.username && y === b.username ? { acquaintance: 3, grudge: 0 } : null));
    E.provideArcs('knowsRumour', (bot, kind) => bot === a && kind === 'party');
    E.provideArcs('moodOf', () => {
        throw new Error('a provider that throws');
    });
    const errs2 = lib.botErrorCount();
    const nErrors2 = errors.length;
    const given = E.arcsTie(a.username, b.username)?.acquaintance === 3 && E.arcsTie(b.username, a.username) === null && E.arcsKnows(a, 'party') && !E.arcsKnows(b, 'party') && E.arcsMood(a) === null;
    const logged = lib.botErrorCount() === errs2 + 1 && errors.length === nErrors2 + 1;
    errors.splice(nErrors2, 1); // (that one was the test's)
    for (const k of ['tieOf', 'knowsRumour', 'moodOf']) E.provideArcs(k, null);
    check("what C and D ask of each other (arcsTie, arcsKnows, arcsMood): null or false without a provider, the provider's answer with one, a provider's throw logged (null)", absent && given && logged && E.arcsTie(a.username, b.username) === null, { absent, given, logged });
    check('a registered pass runs every 10 play ticks, with (now, play), and stops when asked', calls.length >= 3 && calls.length <= 4 && calls.every(([, play]) => play % 10 === 0) && calls.every(([now]) => now <= World.currentTick - 15), calls);
}

// ---- sayArcLine: slots, filter, freshness, the four budget modes ----
{
    scene(SEED, 'say');
    lib.resetLineRegistry();
    const [a, b] = bots;
    const Say = lib.ArcsSay;
    check('fillArcSlots: every slot filled, or null (one left unfilled)', Say.fillArcSlots('need {left} more for {item}', { left: '20k', item: 'rune legs' }) === 'need 20k more for rune legs' && Say.fillArcSlots('going for {goal}', {}) === null && Say.fillArcSlots('{n} lvls', { n: 3 }) === '3 lvls');
    check('the pools: arcLines of an event no group has is empty (the placeholder files)', lib.arcLines('no-such-event').length === 0);
    const state = () => {
        const s = lib.SayChatter.chatterStateOf(a);
        return s && { due: s.due, debt: s.debt };
    };
    check('the speaker has its chatter state', state() !== null);
    const said = [];
    const stop = lib.onArcs('said', e => {
        if (e.bot === a) said.push(e);
    });
    // a template with a slot left unfilled, or one the filter changes, is no candidate
    const none = Say.sayArcLine(a, ['going for {goal}', 'what the fuck'], {}, { kind: 'idle', budget: 'slot' });
    check('no candidate (a slot unfilled, a line the filter changes): null, nothing said, nothing counted', none === null && said.length === 0);
    // slot: the due line itself: said at once, nothing counted here
    let s0 = state();
    const line1 = Say.sayArcLine(a, ['testing my {thing} line lol'], { thing: 'slot' }, { kind: 'idle', budget: 'slot', arc: { kind: 'test', id: 1 }, styled: false });
    let s1 = state();
    // (said at once: this tick, or the next if the bot said a line this tick already, port/BotSay)
    const atOnce = said.length === 1 || run(1, () => said.length >= 1) === 1;
    check("'slot': said at once with its tag on the 'said' event, the speaker's due line and debt as they were", line1 === 'testing my slot line lol' && atOnce && said.length === 1 && said[0].text.toLowerCase() === line1 && said[0].kind === 'idle' && said[0].arc?.id === 1 && s1.due === s0.due && s1.debt === s0.debt, { line1, said: said.map(e => e.text), s0, s1 });
    // a line said is not fresh again for it (its own last 20)
    check('the registry: the same line again is not fresh: null', Say.sayArcLine(a, ['testing my {thing} line lol'], { thing: 'slot' }, { kind: 'idle', budget: 'slot', styled: false }) === null);
    // own: one owed line (the debt), the due line kept
    s0 = state();
    Say.sayArcLine(a, ['testing the own line'], {}, { kind: 'idle', budget: 'own', arc: { kind: 'test', id: 2 } });
    s1 = state();
    check("'own': the debt one up (its next due line skipped), the due line as it was", s1.debt === Math.min(6, s0.debt + 1) && s1.due === s0.due, { s0, s1 });
    // budgeted: the next due line pushed out
    s0 = state();
    Say.sayArcLine(a, ['testing the budgeted line'], {}, { kind: 'setpiece', budget: 'budgeted', arc: { kind: 'test', id: 3 } });
    s1 = state();
    check("'budgeted': the next due line pushed out (a quiet after its time), no debt", s1.due >= Math.max(World.currentTick, s0.due) + 30 && s1.debt === s0.debt, { s0, s1, now: World.currentTick });
    // chatter: a quiet after it, never sooner than it was
    s0 = state();
    Say.sayArcLine(a, ['testing the chatter line'], {}, { kind: 'event', budget: 'chatter', to: b, arc: { kind: 'test', id: 4 } });
    s1 = state();
    check("'chatter': its next line after a quiet, never sooner than it was, no debt", s1.due >= s0.due && s1.due >= World.currentTick + 30 && s1.debt === s0.debt, { s0, s1, now: World.currentTick });
    run(80, () => said.length >= 4);
    stop();
    const ids = said.map(e => e.arc?.id);
    check("the typed lines said, each with its kind and its tag on the 'said' event ('chatter' to its bot)", [2, 3, 4].every(i => ids.includes(i)) && said.find(e => e.arc?.id === 3)?.kind === 'setpiece' && said.find(e => e.arc?.id === 4)?.to === b, said.map(e => [e.text, e.kind, e.arc?.id]));
}

// ---- leaving at once ----
{
    scene(SEED, 'leave');
    const [, , , d, e] = bots;
    check('mayLeaveAbruptly: a free bot may', lib.mayLeaveAbruptly(d));
    lib.setRole(d, 'guest');
    const withRole = lib.mayLeaveAbruptly(d);
    lib.clearRole(d);
    const was = d.botTradeTargetPid;
    d.botTradeTargetPid = e.pid ?? 1;
    const trading = lib.mayLeaveAbruptly(d);
    d.botTradeTargetPid = was;
    check('mayLeaveAbruptly: not with a set-piece role, nor in a trade', !withRole && !trading && lib.mayLeaveAbruptly(d));
    const name = d.username;
    const member = BotManager.members.get(name);
    const play0 = BotManager.playTicks();
    let away = null;
    const stop = lib.onArcs('logout', x => {
        if (x.name === name) away = { left: BotManager.playTicks(), until: member.awayUntil };
    });
    BotManager.leaveSoon(name, 20, { abrupt: true, away: [3000, 3000] });
    // (its wrap-up skipped: no bank trip, no goodbye; a hold the engine keeps, the logout's own ticks, then out)
    const gone = run(150, () => member.state === 'offline');
    stop();
    const logout = heard.logout.find(x => x.name === name);
    check('leaveSoon abrupt: it goes at its time (20 play ticks, then the logout), its logout on the bus', gone > 0 && away && away.left - play0 >= 20 && away.left - play0 <= 40 && logout?.bot === d, { gone, away, play0 });
    check("leaveSoon's away: its next absence is the one asked (3000 play ticks)", away && away.until === away.left + 3000, away);
}

check('no errors', errors.length === 0, errors.slice(0, 5).join(' | '));
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : `: ${c.detail}`}`);
const failed = checks.filter(c => !c.ok).length;
out(failed ? `arcs-store: ${failed} of ${checks.length} checks failed` : `arcs-store: all ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
