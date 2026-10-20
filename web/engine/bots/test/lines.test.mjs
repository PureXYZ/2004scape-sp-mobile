#!/usr/bin/env node
// What a bot says unprompted (port/BotLines, port/BotStyle; the realism work, phase 2: "upstream
// first, gated"), on contexts made up here and through the real 274 word filter:
//   tags       every one of upstream's idle lines has a tag (data/line_tags.json, the hand review of
//              test/line-tags-build.mjs) and every tag is valid: a known category and known places, kinds of place,
//              personas, events and claims; no tag for a line that is not one; the tags file is the builder's
//   gating     no goodbye or "brb" as idle talk (only sayOccasion's); no newbie question from combat 40+; the meta and
//              modern lines only from meme personas (about 1 in 8), and they do say some; skill and place lines only at
//              their task and place; event lines only while the event is fresh; a {name} claim only when true;
//              upstream's lines about 70 % of a pick when both kinds fit
//   registry   a line a human heard is not said again for an hour (45 minutes before the variety work), nor one another bot said in the same map square
//              for 10, nor one of a bot's own last 20
//   style      the persona's style (new lines only) keeps every line through the filter and the chat codec, and
//              changes a good share of them
//   level-ups  every form, for every skill, passes the filter and the codec; no shape (the humanlike report's H10) in
//              more than a fifth of them as said (styled); upstream's 15 phrases are in them, word for word
//   PK         each PKer says its own few lines of a pool (from its name), the same at every login; every PK line passes
//
//   node web/engine/bots/test/lines.test.mjs
import fs from 'fs';
import path from 'path';
import { BOTS_DIR } from './lib/paths.mjs';
import { importInEngine } from './lib/clone.mjs';
import * as M from './lib/humanlike-metrics.mjs';

const lib = await importInEngine(path.join(BOTS_DIR, 'test/lib/lines.ts'), 'unit-lines');
lib.loadWordEnc();
const L = lib.Lines;

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)} %` : '-');

// seeded dice (the tests repeat)
function mulberry(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = mulberry(274);

// ---- tags: valid and complete ----
const phrases = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data/bot_phrases.json'), 'utf8'));
const tagsFile = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data/line_tags.json'), 'utf8'));
const tags = tagsFile.tags;
// (realism phase 5b, Track D: 'rumour', word of mouth about a set piece, said only through port/BotLines rumourText)
const CATEGORIES = new Set(['ambient', 'question', 'newbie-question', 'greeting', 'response', 'departure', 'departure-soon', 'brb', 'back', 'death', 'close-call', 'drop-claim', 'level-claim', 'skill', 'place', 'pk', 'quest', 'name-claim', 'trade', 'meme', 'event', 'rumour']);
const SKILLS = new Set(['Woodcut', 'Mine', 'Fish', 'Combat', 'Cook', 'Smith', 'Thieve', 'Agility', 'Firemaking', 'Fletching', 'Crafting', 'Runecrafting', 'Herblore', 'Prayer', 'Ranged', 'Magic']);
// (revised in the variety work, round 1, Track S: 'newbie-near' a veteran's tip; 'clan' a clique's recruiting, 'notkid' the
// romance lines (teens and adults))
const AT = new Set(['bank', 'trade-bank', 'wild', 'edge', 'town', 'hub', 'dungeon', 'skilling', 'moving', 'still', 'near', 'close', 'crowd', 'quiet', 'lowhp', 'seen-cape', 'seen-hat', 'seen-fullrune', 'seen-phat', 'seen-santa', 'newbie-near']);
const WHO = new Set(['pker', 'social', 'vendor', 'trader', 'levelling', 'usa', 'uk', 'canada', 'australia', 'netherlands', 'sweden', 'ireland', 'new zealand', 'germany', 'norway', 'meme', 'rude', 'friendly', 'young', 'kid', 'teen', 'adult', 'esl', 'helpful', 'sociable', 'f2p', 'phat', 'fullrune', 'clan', 'notkid']);
/** (variety round 1, SAY-6) the classes a response follows (port/BotSpoke HeardClass), and 'never' */
const AFTER = new Set(['statement', 'question', 'greeting', 'levelup', 'mishap', 'brag', 'complaint', 'meme', 'laugh', 'rude', 'thanks', 'response', 'spam', 'social', 'newbie', 'never']);
const EMOTE = new Set(['cry', 'think', 'wave', 'bow', 'angry', 'dance', 'beckon', 'yes', 'no', 'laugh', 'cheer', 'clap']);
const EVENTS = new Set([...Object.keys(L.EVENT_WINDOW), 'axe-head', 'alch', 'random-event', 'clue-scroll']);
const CLAIMS = /^(newbie|autoer|pker|away|close|high-total|99-\w+)$/;
function tagProblems(tag) {
    const bad = [];
    if (!CATEGORIES.has(tag.c)) bad.push(`category ${tag.c}`);
    for (const s of tag.skills ?? []) if (!SKILLS.has(s)) bad.push(`skill ${s}`);
    for (const p of tag.places ?? []) if (!L.PLACE_AREAS[p]) bad.push(`place ${p}`);
    for (const a of tag.at ?? []) if (!AT.has(a)) bad.push(`at ${a}`);
    for (const w of tag.who ?? []) if (!WHO.has(w) && !w.startsWith('name-')) bad.push(`who ${w}`);
    if (tag.event && !EVENTS.has(tag.event)) bad.push(`event ${tag.event}`);
    if (tag.claim && !CLAIMS.test(tag.claim)) bad.push(`claim ${tag.claim}`);
    if (tag.near && !['in', 'region', 'away'].includes(tag.near)) bad.push(`near ${tag.near}`);
    if (tag.heard && !['any', 'levelup', 'answer'].includes(tag.heard)) bad.push(`heard ${tag.heard}`);
    for (const a of tag.after ?? []) if (!AFTER.has(a)) bad.push(`after ${a}`);
    if (tag.after && (tag.c !== 'response' || (tag.heard ?? 'any') !== 'any')) bad.push('after on a line that is no heard:any response');
    if (tag.after?.includes('response')) bad.push('a response after a response');
    if (tag.emote && !EMOTE.has(tag.emote)) bad.push(`emote ${tag.emote}`);
    if (tag.weight !== undefined && !(tag.weight > 0 && tag.weight <= 1)) bad.push(`weight ${tag.weight}`);
    for (const b of [tag.cb, tag.total]) if (b && !(Array.isArray(b) && b.length === 2 && b[0] <= b[1])) bad.push(`band ${b}`);
    if (tag.c === 'name-claim' && !tag.claim) bad.push('a name claim without its claim');
    if (tag.c === 'departure-soon' && !tag.mins) bad.push('departure-soon without minutes');
    return bad;
}
{
    const missing = phrases.idle.filter(t => !tags[t]);
    check(`every one of upstream's ${phrases.idle.length} idle lines has a tag`, missing.length === 0, missing.slice(0, 5).join(' | '));
    const extra = Object.keys(tags).filter(t => !phrases.idle.includes(t));
    check('no tag for a line that is not one', extra.length === 0, extra.slice(0, 5).join(' | '));
    const invalid = Object.entries(tags).map(([t, tag]) => [t, tagProblems(tag)]).filter(([, b]) => b.length);
    check('every tag is valid (category, skills, places, kinds of place, personas, events, claims)', invalid.length === 0, invalid.slice(0, 5).map(([t, b]) => `${t}: ${b.join(', ')}`).join(' | '));
    const invalidNew = lib.Lines.NEW_LINES.map(l => [l.text, tagProblems(l.tag)]).filter(([, b]) => b.length);
    check('every 2004 line group has a valid tag', invalidNew.length === 0, invalidNew.slice(0, 5).map(([t, b]) => `${t}: ${b.join(', ')}`).join(' | '));
    check('the tagged lines are all of them', L.UPSTREAM_LINES.length === phrases.idle.length, `${L.UPSTREAM_LINES.length}`);
    const counts = {};
    for (const t of Object.values(tags)) counts[t.c] = (counts[t.c] ?? 0) + 1;
    check('the meta and modern lines are tagged meme (the research: at least 18 % of the pool)', counts.meme / phrases.idle.length >= 0.18, `${counts.meme} of ${phrases.idle.length}`);
    // every line the humanlike report counts as a goodbye or a break is an occasion's line (or names a player, or says "in N minutes")
    const leak = phrases.idle.filter(t => !t.includes('{name}') && tags[t].c !== 'departure' && tags[t].c !== 'departure-soon' && M.isDeparture(t));
    const leakBrb = phrases.idle.filter(t => !t.includes('{name}') && tags[t].c !== 'brb' && M.BRB.test(t));
    check('every goodbye line (the report\'s words) is a departure, every "brb" line a break', leak.length === 0 && leakBrb.length === 0, [...leak, ...leakBrb].slice(0, 5).join(' | '));
    const { spawnSync } = await import('child_process');
    const built = spawnSync(process.execPath, [path.join(BOTS_DIR, 'test/line-tags-build.mjs'), '--check'], { encoding: 'utf8' });
    check('data/line_tags.json is the builder\'s (test/line-tags-build.mjs --check)', built.status === 0, (built.stdout + built.stderr).trim().split('\n').slice(-1)[0]);
    // (revised in the realism work's phase 5a: the 400-600 is lines2004.json's own library; phase 5a's files,
    // data/lines2004-texture.json and data/lines2004-events.json, come on top of it, all in NEW_LINES)
    // (revised in phase 5b, Track D: every data/lines2004-*.json file, 5a's and 5b's (groups, parties, arena), so a
    // track's own file counts without a new edit here)
    const count = file => JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data', file), 'utf8')).groups.reduce((n, g) => n + g.lines.length, 0);
    const new2004 = count('lines2004.json');
    const phase5 = fs
        .readdirSync(path.join(BOTS_DIR, 'data'))
        .filter(f => /^lines2004-.+\.json$/.test(f))
        .reduce((n, f) => n + count(f), 0);
    check("400-600 new 2004 lines in lines2004.json, phase 5's files' on top", new2004 >= 400 && new2004 <= 600 && L.NEW_LINES.length === new2004 + phase5, `${new2004} + ${phase5}`);
    const norm = s => s.toLowerCase().trim();
    const up = new Set(phrases.idle.map(norm));
    const dup = L.NEW_LINES.filter(l => up.has(norm(l.text)));
    const seen = new Set();
    const twice = L.NEW_LINES.filter(l => (seen.has(norm(l.text)) ? true : (seen.add(norm(l.text)), false)));
    check('no new line repeats an upstream line or another new line', dup.length === 0 && twice.length === 0, [...dup, ...twice].slice(0, 5).map(l => l.text).join(' | '));
    const words = L.NEW_LINES.map(l => M.words(l.text).length);
    const mean = words.reduce((a, b) => a + b, 0) / words.length;
    check('the new lines are short: 2.5-4 words on average (the humanlike report\'s C3)', mean >= 2.5 && mean <= 4, mean.toFixed(2));
}

// ---- contexts ----
const names = lib.BOT_NAMES;
const personas = names.map(n => ({ name: n, p: lib.personaOf(n) }));
const pickName = f => personas.find(x => f(x.p))?.name;
const MEME = pickName(p => p.meme);
const PLAIN = pickName(p => !p.meme && p.friendliness > 0.2);
const RUDE = pickName(p => !p.meme && p.friendliness < -0.2);
function neighbour(over = {}) {
    return { player: null, display: 'Sim Human', isBot: true, dist: 5, cb: 30, total: 500, newbie: false, pker: false, gathering: true, away: false, at99: [], worn: { cape: false, hat: false, fullrune: false, phat: false, santa: false }, ...over };
}
function ctx(over = {}) {
    const name = over.name ?? PLAIN;
    return {
        name,
        display: name,
        persona: lib.personaOf(name),
        planner: lib.plannerOf(name) ?? 'skiller',
        task: 'Woodcut',
        state: 'chop',
        action: null,
        targets: ['willow'],
        x: 3086,
        z: 3234,
        level: 0,
        wild: 0,
        cb: 30,
        total: 500,
        newbie: false,
        members: true,
        moving: false,
        hpShare: 1,
        nearLevel: false,
        wears: { phat: false, fullrune: false },
        near: [neighbour()],
        events: new Map(),
        heard: { any: false, levelup: false, answer: false },
        sessionLeft: 4000,
        now: 100000,
        ...over
    };
}
/** many idle picks over varied contexts (the registry cleared, so freshness never decides) */
function picks(make, n = 400) {
    const out = [];
    for (let i = 0; i < n; i++) {
        L.resetLineRegistry();
        const p = L.pickLine(make(i), 'idle', rand);
        if (p) out.push(p);
    }
    return out;
}
const TASKS = [
    ['Woodcut', ['willow'], 3086, 3234],
    ['Mine', ['iron'], 3285, 3365],
    ['Fish', ['lobster'], 2924, 3178],
    ['Combat', ['cow'], 3255, 3276],
    ['Cook', ['lobster'], 3211, 3215],
    ['Smith', ['iron'], 3108, 3499],
    ['Thieve', ['man'], 3222, 3218],
    ['RangedMagic', ['magic'], 3240, 3290],
    ['Firemaking', ['oak'], 3180, 3440],
    ['Vendor', [], 3185, 3444],
    ['PKer', [], 3100, 3700],
    ['none', [], 3000, 3000]
];
const variedCtx = (over = {}) => i => {
    const [task, targets, x, z] = TASKS[i % TASKS.length];
    const crowd = i % 3;
    return ctx({ task, targets, x, z, wild: z >= 3520 ? Math.floor((z - 3520) / 8) + 1 : 0, near: Array.from({ length: crowd * 2 }, () => neighbour()), heard: { any: i % 4 === 0, levelup: i % 9 === 0, answer: false }, cb: 3 + ((i * 7) % 110), ...over });
};

// ---- gating ----
{
    const plain = picks(variedCtx({ name: PLAIN }), 1500);
    const memes = picks(variedCtx({ name: MEME }), 1500);
    const rude = picks(variedCtx({ name: RUDE }), 1500);
    const all = [...plain, ...memes, ...rude];
    const occasion = all.filter(p => ['departure', 'brb', 'back'].includes(p.line.tag.c));
    check('idle talk is never a goodbye, a "brb" or a "back" (those come only before a real logout or break)', occasion.length === 0, occasion.slice(0, 3).map(p => p.text).join(' | '));
    const reportDeparture = all.filter(p => !p.to && (M.isDeparture(p.text) || M.BRB.test(p.text)));
    check('no idle line the humanlike report counts as a goodbye or a break (H16, C4)', reportDeparture.length === 0, reportDeparture.slice(0, 3).map(p => p.text).join(' | '));
    check('a plain persona never says a meme line', plain.every(p => p.line.tag.c !== 'meme') && rude.every(p => p.line.tag.c !== 'meme'), plain.filter(p => p.line.tag.c === 'meme').slice(0, 3).map(p => p.text).join(' | '));
    const memeShare = memes.filter(p => p.line.tag.c === 'meme').length / memes.length;
    check('a meme persona does say meme lines (upstream\'s meta and modern jokes kept)', memeShare > 0.1, pct(memes.filter(p => p.line.tag.c === 'meme').length, memes.length));
    const swearPlain = plain.filter(p => p.line.tag.who?.includes('rude'));
    check('the rude lines (insults, swearing) only from rude personas', swearPlain.length === 0 && rude.some(p => p.line.tag.who?.includes('rude')), swearPlain.slice(0, 3).map(p => p.text).join(' | '));

    const vets = picks(i => ({ ...variedCtx({ name: i % 2 ? PLAIN : RUDE })(i), cb: 40 + (i % 80) }), 1500);
    const nq = vets.filter(p => p.line.tag.c === 'newbie-question');
    check('no newbie question from combat 40+', nq.length === 0, nq.slice(0, 3).map(p => p.text).join(' | '));
    const lows = picks(i => ({ ...variedCtx({ name: PLAIN })(i), cb: 3 + (i % 8), task: i % 2 ? 'Combat' : 'none', targets: ['chicken'], x: 3222, z: 3218 }), 800);
    check('low levels do ask newbie questions', lows.some(p => p.line.tag.c === 'newbie-question'), pct(lows.filter(p => p.line.tag.c === 'newbie-question').length, lows.length));
    const reportVets = vets.filter(p => M.NEWBIE_QUESTION.test(p.text.trim()));
    check('the humanlike report\'s "how do i / where is" questions from combat 40+ are rare (H8b)', reportVets.length / Math.max(1, vets.filter(p => M.isQuestion(p.text)).length) < 0.1, `${reportVets.length} of ${vets.filter(p => M.isQuestion(p.text)).length} questions: ${reportVets.slice(0, 3).map(p => p.text).join(' | ')}`);

    // skill and place lines where they fit
    let skillLines = 0;
    const skillBad = [];
    for (const [task, targets, x, z] of TASKS) {
        const got = picks(() => ctx({ task, targets, x, z, near: [neighbour(), neighbour()] }), 300);
        for (const p of got) {
            if (!p.line.tag.skills) continue;
            skillLines++;
            if (!L.fits(p.line, ctx({ task, targets, x, z, near: [neighbour(), neighbour()] }))) skillBad.push(`${task}: ${p.text}`);
        }
    }
    check('skill lines only at their task', skillLines > 50 && skillBad.length === 0, `${skillLines} skill lines; ${skillBad.slice(0, 3).join(' | ')}`);
    const draynor = picks(() => ctx({ task: 'Woodcut', targets: ['willow'], x: 3086, z: 3234 }), 600);
    const far = draynor.filter(p => p.line.tag.places && (p.line.tag.near ?? 'in') === 'in' && !p.line.tag.places.some(k => ['draynor', 'lumbridge'].includes(k) && Math.max(Math.abs(3086 - L.PLACE_AREAS[k].x), Math.abs(3234 - L.PLACE_AREAS[k].z)) <= L.PLACE_AREAS[k].r));
    check('a bot at Draynor\'s willows names no place it is not in', far.length === 0, far.slice(0, 3).map(p => p.text).join(' | '));
    // the humanlike report's H8 on these picks: skills and places in statements
    let judged = 0;
    let fitted = 0;
    for (const [task, targets, x, z] of TASKS) {
        for (const p of picks(() => ctx({ task, targets, x, z, near: [neighbour(), neighbour()] }), 200)) {
            if (p.to || M.isQuestion(p.text)) continue;
            const f = M.contextFit(p.text, task, x, z, 0);
            for (const v of [f.skill, f.place]) {
                if (v === null) continue;
                judged++;
                if (v) fitted++;
            }
        }
    }
    check('the humanlike report\'s context fit on these picks (H8) is at least 80 %', judged > 30 && fitted / judged >= 0.8, `${fitted} of ${judged}`);

    // events: only while fresh
    const death = { tick: 100000 - 100 };
    const withDeath = picks(() => ctx({ events: new Map([['death', death]]) }), 300).filter(p => p.line.tag.c === 'death');
    const noDeath = picks(() => ctx({}), 600).filter(p => p.line.tag.c === 'death');
    const oldDeath = picks(() => ctx({ events: new Map([['death', { tick: 100000 - 4000 }]]) }), 300).filter(p => p.line.tag.c === 'death');
    const eventPicks = [];
    for (let i = 0; i < 200; i++) {
        L.resetLineRegistry();
        const p = L.pickLine(ctx({ events: new Map([['death', death]]) }), { event: 'death' }, rand);
        if (p) eventPicks.push(p);
    }
    check('death lines only after a death (within 5 minutes)', withDeath.length > 0 && noDeath.length === 0 && oldDeath.length === 0 && eventPicks.length === 200 && eventPicks.every(p => p.line.tag.c === 'death'), `${withDeath.length} with, ${noDeath.length} without, ${oldDeath.length} after 6 minutes`);
    const wildOnly = eventPicks.filter(p => p.line.tag.event === 'wild-death');
    check('"lost all my stuff" and PK deaths only after a death in the Wilderness', wildOnly.length === 0, wildOnly.slice(0, 3).map(p => p.text).join(' | '));

    // {name} claims
    const cook = L.UPSTREAM_LINES.find(l => l.text.startsWith('{name} hit 99 Cooking'));
    const plainNear = ctx({ near: [neighbour()] });
    const cookNear = ctx({ near: [neighbour({ display: 'Chef', at99: ['COOKING'] })] });
    check('a {name} claim only when true ("{name} hit 99 Cooking": a player near with 99 Cooking)', L.namedFor(cook, plainNear).length === 0 && L.namedFor(cook, cookNear).length === 1);
    const pker = L.UPSTREAM_LINES.find(l => l.text === '{name} lures noobs into the Wilderness');
    check('"{name} lures noobs into the Wilderness" names only a PKer', L.namedFor(pker, ctx({ near: [neighbour({ pker: false })] })).length === 0 && L.namedFor(pker, ctx({ near: [neighbour({ pker: true })] })).length === 1);
    const alone = picks(() => ctx({ near: [] }), 500);
    check('with nobody near, no {name} line and no greeting', alone.every(p => !p.line.named && p.line.tag.c !== 'greeting'), alone.filter(p => p.line.named || p.line.tag.c === 'greeting').slice(0, 3).map(p => p.text).join(' | '));

    // upstream first
    const mixed = picks(variedCtx({ name: PLAIN }), 3000);
    const upShare = mixed.filter(p => p.line.source === 'upstream').length / mixed.length;
    check('upstream\'s lines are the main pool: about 70 % of the picks where both kinds fit (here 50-80 %)', upShare >= 0.5 && upShare <= 0.8, pct(mixed.filter(p => p.line.source === 'upstream').length, mixed.length));

    // moments: their own lines only
    for (const occasion of ['brb', 'back', 'departure']) {
        const got = [];
        for (let i = 0; i < 200; i++) {
            L.resetLineRegistry();
            const p = L.pickLine(ctx({ name: i % 2 ? PLAIN : RUDE }), occasion, rand);
            if (p) got.push(p);
        }
        check(`sayOccasion('${occasion}') picks only ${occasion} lines`, got.length === 200 && got.every(p => p.line.tag.c === occasion), `${got.length}; ${got.filter(p => p.line.tag.c !== occasion).slice(0, 2).map(p => p.text).join(' | ')}`);
    }
    const atBank = [];
    // (revised in the variety work, round 1, P6: a bot says its own share of upstream's brb lines: one whose repertoire
    // holds "banking brb")
    const banker = names.find(n => L.inRepertoire(n, L.UPSTREAM_LINES.find(l => l.text === 'banking brb')));
    for (let i = 0; i < 300; i++) {
        L.resetLineRegistry();
        const p = L.pickLine(ctx({ name: banker, persona: lib.personaOf(banker), x: 3092, z: 3245 }), 'brb', rand);
        if (p) atBank.push(p.text);
    }
    const awayBank = [];
    for (let i = 0; i < 300; i++) {
        L.resetLineRegistry();
        const p = L.pickLine(ctx({ name: banker, persona: lib.personaOf(banker), x: 3086, z: 3180 }), 'brb', rand);
        if (p) awayBank.push(p.text);
    }
    check('"banking brb" only at a bank', atBank.includes('banking brb') && !awayBank.includes('banking brb'));
    const gtgIn = L.UPSTREAM_LINES.find(l => l.text === 'Gtg in 30 minutes');
    check('"Gtg in 30 minutes" only with about 30 minutes left of its session', L.fits(gtgIn, ctx({ sessionLeft: 3000 })) && !L.fits(gtgIn, ctx({ sessionLeft: 600 })) && !L.fits(gtgIn, ctx({ sessionLeft: null })));
}

// ---- the repetition registry ----
{
    L.resetLineRegistry();
    const now = 50000;
    L.noteSaidAt('bot_a', 'willows r best xp', 3086, 3234, 0, now, true);
    // (revised in the variety work, round 1: an hour, the humanlike report's W4 window; it was 45 minutes)
    check('a line a human heard is not said again within the hour, anywhere', !L.isFresh('bot_b', 'willows r best xp', 2000, 2000, 0, now + 5900) && L.isFresh('bot_b', 'willows r best xp', 2000, 2000, 0, now + 6100));
    L.noteSaidAt('bot_a', 'so many logs', 3086, 3234, 0, now, false);
    check('a line another bot said in the same map square is not said there within 10 minutes', !L.isFresh('bot_b', 'so many logs', 3090, 3240, 0, now + 500) && L.isFresh('bot_b', 'so many logs', 3200, 3240, 0, now + 500) && L.isFresh('bot_b', 'so many logs', 3090, 3240, 0, now + 1100));
    L.resetLineRegistry();
    for (let i = 0; i < 20; i++) L.noteSaidAt('bot_c', `line number ${i}`, 0, 0, 0, i, false);
    const own = !L.isFresh('bot_c', 'line number 0', 5000, 5000, 1, 99999) && L.isFresh('bot_d', 'line number 0', 5000, 5000, 1, 99999);
    L.noteSaidAt('bot_c', 'line number 20', 0, 0, 0, 21, false);
    check('a bot never repeats one of its own last 20 lines', own && L.isFresh('bot_c', 'line number 0', 5000, 5000, 1, 99999));
    check('"lol" and the like are free to repeat (only the bot\'s own last ones count)', (L.noteSaidAt('bot_e', 'lol', 0, 0, 0, 1, true), L.isFresh('bot_f', 'lol', 0, 0, 0, 2)));
    // a pick never returns a stale line
    L.resetLineRegistry();
    const c = ctx({ events: new Map([['death', { tick: 99990 }]]) });
    let stale = 0;
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
        const p = L.pickLine(c, { event: 'death' }, rand);
        if (!p) break;
        if (seen.has(p.text.toLowerCase())) stale++;
        seen.add(p.text.toLowerCase());
        L.noteSaidAt(c.name, p.text, c.x, c.z, 0, c.now, true);
    }
    check('a pick re-rolls a line it said or a human heard (then silence)', stale === 0 && seen.size >= 6, `${seen.size} different death lines, ${stale} repeated`);
}

// ---- the style layer: new lines only, the filter and the codec kept ----
{
    const sample = personas.filter((_, i) => i % 40 === 0).map(x => x.p);
    let total = 0;
    let changed = 0;
    let corrections = 0;
    const bad = [];
    // (revised in the variety work, round 1, P3: a slot line is styled as said, its slots filled: a value of each)
    const samples = lib.Slots.slotSamples();
    samples.clan = ['dark knights', 'the elite', 'team pk'];
    for (const line of L.NEW_LINES) {
        for (const [i, p] of sample.entries()) {
            const text = lib.Slots.fillSlots(line.text, Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, v[i % v.length]])));
            const s = lib.styleLine(text, p, rand);
            total++;
            if (s.line !== text) changed++;
            if (s.correction) corrections++;
            if (lib.filter(s.line) !== s.line || lib.lostInWordPack(s.line).length) bad.push(`${line.text} -> ${s.line}`);
            if (s.correction && (lib.filter(s.correction) !== s.correction || lib.lostInWordPack(s.correction).length)) bad.push(`correction ${s.correction}`);
        }
    }
    check('every styled new line (and its "*word" correction) passes the 274 filter and the chat codec', bad.length === 0, bad.slice(0, 3).join(' | '));
    check('the style changes a good share of the new lines (abbreviations, punctuation, laughs, typos)', changed / total > 0.2, pct(changed, total));
    check('some typos get a "*word" correction', corrections > 0 && corrections / total < 0.05, `${corrections} of ${total}`);
    check('the new lines are all "2004" (styled), upstream\'s all "upstream" (never styled)', L.NEW_LINES.every(l => l.source === '2004') && L.UPSTREAM_LINES.every(l => l.source === 'upstream'));
    const abbrev = lib.styleLine('are you going to the bank please', { ...lib.personaOf(PLAIN), ageBand: 'adult', style: { ...lib.personaOf(PLAIN).style, abbreviate: 1, typoRate: 0, exclaim: 0, endStop: 0, laughs: [], smileys: [] } }, () => 0.5);
    check('abbreviations: "are you going to the bank please" -> "r u going to the bank plz"', /^r u going to the bank (plz|pls)$/.test(abbrev.line), abbrev.line);
}

// ---- level-ups ----
{
    const stats = ['ATTACK', 'DEFENCE', 'STRENGTH', 'HITPOINTS', 'RANGED', 'PRAYER', 'MAGIC', 'COOKING', 'WOODCUTTING', 'FLETCHING', 'FISHING', 'FIREMAKING', 'CRAFTING', 'SMITHING', 'MINING', 'HERBLORE', 'AGILITY', 'THIEVING', 'RUNECRAFT'];
    let n = 0;
    let masked = 0;
    for (const stat of stats) {
        for (const level of [5, 10, 40, 43, 60, 99]) {
            const can = new Set(L.allLevelUpLines(stat, level));
            for (const line of L.levelUpCandidates(stat, level)) {
                n++;
                if (!can.has(line)) masked++;
            }
        }
    }
    const said = [];
    for (let i = 0; i < 4000; i++) said.push(L.levelUpLine(stats[i % stats.length], 5 + (i % 95), rand, i % 9 === 0 ? 30 + (i % 70) : null));
    const bad = said.filter(line => lib.filter(line) !== line || lib.lostInWordPack(line).length);
    check('every level-up line said passes the 274 filter and the chat codec (a masked form is drawn again)', bad.length === 0 && n > 1000, `${n} form-skill-level lines, ${masked} masked and never said ("level up! 40 wc": "pw"); ${bad.slice(0, 3).join(' | ')}`);
    const shapes = new Map();
    let total = 0;
    const sample = personas.filter((_, i) => i % 7 === 0).map(x => x.p);
    for (let i = 0; i < 6000; i++) {
        const stat = stats[i % stats.length];
        const raw = L.levelUpLine(stat, 5 + (i % 90), rand, i % 11 === 0 ? 40 + (i % 50) : null);
        const line = lib.styleLine(raw, sample[i % sample.length], rand).line;
        const shape = M.levelupShape(line);
        shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
        total++;
    }
    const [topShape, topN] = [...shapes].sort((a, b) => b[1] - a[1])[0];
    check('no level-up shape in more than a fifth of the lines as said (H10)', topN / total <= 0.2 && shapes.size >= 8, `top "${topShape}" ${pct(topN, total)}; ${shapes.size} shapes: ${[...shapes].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([s, k]) => `${s} ${pct(k, total)}`).join(', ')}`);
    const all = new Set(stats.flatMap(s => L.levelUpCandidates(s, 40)));
    const missing = L.UPSTREAM_LEVELUP.filter(ph => ![...all].some(l => l.includes(ph)));
    check('upstream\'s 15 level-up phrases are folded in, word for word', L.UPSTREAM_LEVELUP.length === 15 && missing.length === 0, missing.join(' | '));
    check('milestones: every 10th level, 99, and 2004\'s (40 attack, 43 prayer, 55 magic); 41 woodcutting is none', L.isMilestone('ATTACK', 40) && L.isMilestone('WOODCUTTING', 50) && L.isMilestone('COOKING', 99) && L.isMilestone('PRAYER', 43) && L.isMilestone('MAGIC', 55) && !L.isMilestone('WOODCUTTING', 41));
    const examples = Array.from({ length: 8 }, () => L.levelUpLine('WOODCUTTING', 41, rand));
    check('a level-up line names the skill in 2004 words ("41 wc", "woot 41 woodcutting"), never "- woodcutting 41"', examples.every(l => !/ - /.test(l)), examples.join(' | '));
}

// ---- PK lines ----
{
    const pkers = names.filter(n => ['extras_pker', 'extras_edgeville_pker'].includes(lib.plannerOf(n))).slice(0, 60);
    const subsets = pkers.map(n => L.pkSubsetOf(n, 'kill', lib.KILL_LINES).join('|'));
    const distinct = new Set(subsets).size;
    check('each PKer has its own few kill lines (from its name): at most 4, and most PKers a different set', subsets.every(s => s.split('|').length <= 4) && distinct >= pkers.length * 0.8, `${distinct} sets for ${pkers.length} PKers`);
    check('the same PKer has the same set at every login', L.pkSubsetOf(pkers[0], 'kill', lib.KILL_LINES).join('|') === subsets[0]);
    const pkAll = [...Object.values(L.PK_LINES).flat(), ...lib.KILL_LINES, ...lib.ESCAPE_LINES];
    const pkBad = pkAll.filter(l => lib.filter(l) !== l || lib.lostInWordPack(l).length);
    check('every PK line passes the filter and the codec', pkBad.length === 0, pkBad.join(' | '));
}

let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(failed ? `lines: ${failed} of ${checks.length} failed` : `lines: all ${checks.length} passed`);
process.exit(failed ? 1 : 0);
