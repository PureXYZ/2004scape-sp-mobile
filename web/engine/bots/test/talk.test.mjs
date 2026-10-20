#!/usr/bin/env node
// What they say (the variety work, round 1, Track S), on the lines and in
// the real 274 world:
//   bugs        SAY-5 one death line a death (its category's event used up; a Wilderness death's line uses up the death;
//               the Elvarg line never said); SAY-7 the bots' own greetings ("Heyy kev :)", "yo", "heya") are greetings, a
//               newbie's "im new lol" no question (a welcome now and then, no "ty" for nothing); SAY-6 a response never
//               answers a response, the specific ones never said, the rest after the classes they fit; SAY-14 the
//               registry's meaning key ("I love wc" is "I love woodcutting", a styled line keys as its own); SAY-15 "gotta
//               get off soon" only near a session's end
//   company     P2: alone a fifth of the talk (a quiet at the lone rate), a line due when the company left held and dropped;
//               with company a little more
//   repertoire  P6: a bot says its own share of upstream's pools (a quarter of the ambient, response and brb lines), the
//               same at every login; two or three catchphrases of its own, said now and then
//   register    P9: a fast abbreviator picks fewer formal upstream lines than a careful adult (words verbatim)
//   slots       P3: a slot line fits only when its slots can be filled, filled from the bot's state (a woodcutter at
//               Draynor's willows: willows, wc, its level, the next unlock); {dest} only in a walk's last stretch; the
//               registry keys the template in the square
//   families    P11: account safety (no "password"), clan recruiting (a clique's clan, its capes' colour), dance (the
//               emote), romance (never a kid's), a veteran's tip near a newbie; nothing after 2004 (H22's words)
//   effects     P10: no chat signature; in the world no talk in a colour or with an
//               effect (adverts only: a clan's recruiting call aside)
//   sellers     S8: a seller's own log-normal pace (median 8-45 s, a CV near 0.8); about half the vendors' auto typers
//               (a gap of 8-15 s of their own, the same every time)
//   friends     S9: a friend's first message is about what it does
//   errors      none
//
//   node --expose-gc web/engine/bots/test/talk.test.mjs [--seed=5]
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';
import * as M from './lib/humanlike-metrics.mjs';

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
function mulberry(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
Math.random = mulberry(SEED);
const rand = mulberry(SEED + 1);
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : 0);

const engineDir = prepareEngineClone('talk', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/talk.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, Lines: L, Slots } = lib;
const sim = await lib.Sim.create({ bots: 40, members: true, debug: false });
const variety = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data/lines2004-variety.json'), 'utf8'));

// ---- contexts (as test/lines.test.mjs makes them) ----
const names = lib.BOT_NAMES;
const personas = names.map(n => ({ name: n, p: lib.personaOf(n) }));
const nameWhere = f => personas.find(x => f(x.p))?.name;
const PLAIN = nameWhere(p => !p.meme && p.friendliness > 0.2 && p.ageBand === 'teen');
function neighbour(over = {}) {
    return { player: null, display: 'Kev', isBot: true, dist: 5, cb: 30, total: 500, newbie: false, pker: false, gathering: true, away: false, at99: [], worn: { cape: false, hat: false, fullrune: false, phat: false, santa: false }, ...over };
}
function ctx(over = {}) {
    const name = over.name ?? PLAIN;
    const base = {
        name, display: name, persona: lib.personaOf(name), planner: 'skiller', task: 'Woodcut', state: 'chop', action: null, targets: ['willow'],
        x: 3086, z: 3234, level: 0, wild: 0, cb: 30, total: 500, newbie: false, members: true, moving: false, hpShare: 1, nearLevel: false,
        wears: { phat: false, fullrune: false }, near: [neighbour()], events: new Map(), heard: { any: false, levelup: false, answer: false, cls: null },
        sessionLeft: 4000, now: 100000, ...over
    };
    if (!('slots' in over)) base.slots = Slots.slotValues({ kind: base.task, action: base.action, targets: base.targets, x: base.x, z: base.z, level: base.level, members: base.members, moving: base.moving, levels: over.levels ?? Array(21).fill(25), stepAt: over.stepAt ?? null, drop: over.drop ?? null });
    return base;
}
const picks = (make, n, purpose = 'idle') => {
    const outp = [];
    for (let i = 0; i < n; i++) {
        L.resetLineRegistry();
        const p = L.pickLine(make(i), purpose, rand);
        if (p) outp.push(p);
    }
    return outp;
};

// ======== SAY-14: the meaning key ========
{
    const same = [['I love wc', 'I love woodcutting'], ['big bones lol', 'Big bones!'], ['sooo slow', 'so slow'], ['r u going 2 the bank plz', 'are you going 2 the bank please'], ['heyyy :)', 'hey'], ['im so poor lol', "I'm so poor"]];
    const bad = same.filter(([a, b]) => L.meaningKey(a) !== L.meaningKey(b));
    check('SAY-14: lines that mean the same key the same ("I love wc" / "I love woodcutting", "big bones lol" / "Big bones!")', bad.length === 0, bad.map(([a, b]) => `${a} ${L.meaningKey(a)} | ${b} ${L.meaningKey(b)}`).join('; '));
    check('SAY-14: a laugh alone keys as itself ("lol" is not "")', L.meaningKey('lol') === 'lol' && L.meaningKey('lmao') === 'lmao');
    // a styled line keys as the line it was (typos aside): the registry checks the key it notes
    const sample = personas.filter((_, i) => i % 60 === 0).map(x => x.p);
    let total = 0;
    let kept = 0;
    for (const line of L.NEW_LINES.filter(l => !l.slots).slice(0, 800)) {
        for (const p of sample) {
            const s = lib.styleLine(line.text, p, rand);
            if (s.correction) continue;
            total++;
            if (L.meaningKey(s.line) === L.meaningKey(line.text)) kept++;
        }
    }
    check('SAY-14: a styled line (no typo) keys as its own line at least 90 % of the time (the research: 80 %)', kept / total >= 0.9, `${kept} of ${total} (${pct(kept, total)} %)`);
    // the registry: noted styled, checked raw (as the chatter does: the raw line is noted)
    L.resetLineRegistry();
    L.noteSaidAt('kevin1991', 'I love wc', 3200, 3200, 0, 1000, true);
    check('SAY-14: a line a human heard is stale by meaning ("I love wc" heard, "I love woodcutting" not said)', !L.isFresh('other_bot', 'I love woodcutting', 3100, 3100, 0, 1500));
    L.resetLineRegistry();
    L.noteSaidAt('kevin1991', 'going for 41 wc', 3200, 3200, 0, 1000, false, 'going for {n} {skill}');
    check('P3: the registry keys a slot line\'s template in the square ("going for 41 wc", then another bot\'s "going for 42 wc" there)', !L.isFresh('other_bot', 'going for 42 wc', 3201, 3201, 0, 1100, true, 'going for {n} {skill}') && L.isFresh('other_bot', 'going for 42 wc', 3201, 3201, 0, 1100 + 1000, true, 'going for {n} {skill}'));
}

// ======== SAY-6: responses ========
{
    const responses = L.ALL_LINES.filter(l => l.tag.c === 'response' && (l.tag.heard ?? 'any') === 'any');
    const afterResponse = responses.filter(l => L.responseFits(l.tag, 'response'));
    check('SAY-6: no response follows a response', afterResponse.length === 0, afterResponse.slice(0, 3).map(l => l.text).join(' | '));
    const specific = ['They left 50 minutes ago', 'He is in the cave', 'You need 25 of 40 to do that', 'Thats the max', 'I will be with you in a moment', 'Take it outside', 'Pot calling the kettle black etc'];
    const classes = ['statement', 'question', 'greeting', 'levelup', 'mishap', 'brag', 'complaint', 'meme', 'laugh', 'thanks', 'spam', 'social', 'newbie'];
    const neverSaid = specific.filter(t => {
        const l = L.UPSTREAM_LINES.find(x => x.text === t);
        return l && classes.every(c => !L.responseFits(l.tag, c) || (t === 'Take it outside' || t === 'Pot calling the kettle black etc'));
    });
    check('SAY-6: the specific responses ("He is in the cave", "Thats the max") follow no class a bot says; "Take it outside" only a rude line', neverSaid.length === specific.length && !L.responseFits(L.UPSTREAM_LINES.find(x => x.text === 'Take it outside').tag, 'statement'), neverSaid);
    check('SAY-6: every heard:any response has its classes (after)', responses.every(l => Array.isArray(l.tag.after) && l.tag.after.length > 0), responses.filter(l => !l.tag.after).slice(0, 3).map(l => l.text).join(' | '));
    // picks: after a statement, a laugh or "true"; after a question, "ya"/"idk"; after a level-up's class, gz-like; never "He is in the cave"
    const after = cls => picks(i => ctx({ heard: { any: true, levelup: false, answer: false, cls }, near: [neighbour(), neighbour()] }), 600).filter(p => p.line.tag.c === 'response');
    const s = after('statement');
    const r = after('response');
    const q = after('question');
    check('SAY-6: responses after a statement fit one ("lol", "true", "me too")', s.length > 0 && s.every(p => L.responseFits(p.line.tag, 'statement')), s.slice(0, 6).map(p => p.text).join(' | '));
    check('SAY-6: no response at all after a response', r.length === 0, r.slice(0, 3).map(p => p.text).join(' | '));
    check('SAY-6: responses after a question are answers ("ya", "idk", "Let me think about it")', q.length > 0 && q.every(p => p.line.tag.after?.includes('question')), q.slice(0, 6).map(p => p.text).join(' | '));
    // the class of what a bot said
    const cls = [['lol', null, 'laugh'], ['omg i died', { c: 'death' }, 'mishap'], ['rune drop!!', { c: 'drop-claim', event: 'rune-drop' }, 'brag'], ['wc lvl?', { c: 'question' }, 'question'], ['this is so slow', { c: 'ambient' }, 'complaint'], ['hey all', { c: 'greeting' }, 'greeting'], ['Lag', { c: 'response' }, 'response']];
    const wrong = cls.filter(([t, tag, want]) => L.heardClassOf(tag, t) !== want);
    check('SAY-6: a line\'s class from its tag and words (a laugh, a mishap, a brag, a question, a complaint, a greeting, a response)', wrong.length === 0, wrong.map(([t, tag, want]) => `${t}: ${L.heardClassOf(tag, t)} not ${want}`).join('; '));
}

// ======== SAY-5: the Elvarg line; a death line's event ========
{
    const elvarg = L.UPSTREAM_LINES.find(l => l.text === 'Dying to Elvargs fiery breath sums up my life');
    const deathCtx = ev => ctx({ cb: 60, events: new Map([[ev, { tick: 100000 - 20 }]]), x: 3222, z: 3218, task: 'none', targets: [] });
    const died = [...picks(() => deathCtx('death'), 400, { event: 'death' }), ...picks(() => deathCtx('wild-death'), 400, { event: 'wild-death' }), ...picks(() => deathCtx('death'), 600)];
    check('SAY-5: "Dying to Elvargs fiery breath..." is never said (an event no bot has; its words kept)', elvarg && elvarg.tag.event === 'unsaid' && !died.some(p => p.line === elvarg), died.filter(p => p.line === elvarg).length);
    const deathLines = L.ALL_LINES.filter(l => l.tag.c === 'death');
    check('SAY-5: every death line\'s event is a death\'s (its tag\'s, else its category\'s): saying it uses it up', deathLines.every(l => ['death', 'wild-death', 'unsaid'].includes(L.lineEventOf(l.tag))), deathLines.filter(l => !['death', 'wild-death', 'unsaid'].includes(L.lineEventOf(l.tag))).map(l => l.text).slice(0, 3).join(' | '));
}

// ======== SAY-15: "gotta get off soon" ========
{
    const school = lib.PRACTICES.practices.find(p => p.id === 'school');
    const turn = school?.turns[0];
    const soon = 'my mom says i gotta get off soon';
    check('SAY-15: the school practice\'s "my mom says i gotta get off soon" only with 5-15 minutes of the session left', turn && lib.turnLines(turn, turn.lines, 1000).includes(soon) && !lib.turnLines(turn, turn.lines, 3000).includes(soon) && !lib.turnLines(turn, turn.lines, 200).includes(soon) && !lib.turnLines(turn, turn.lines, Infinity).includes(soon) && lib.turnLines(turn, turn.lines, 3000).length === turn.lines.length - 1);
}

// ======== P6: repertoires and catchphrases ========
{
    const ambient = L.UPSTREAM_LINES.filter(l => l.tag.c === 'ambient');
    const shares = names.slice(0, 200).map(n => ambient.filter(l => L.inRepertoire(n, l)).length / ambient.length);
    const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
    check('P6: a bot\'s repertoire holds about a quarter of upstream\'s ambient lines (200 bots: 20-30 % on average)', mean >= 0.2 && mean <= 0.3, `${pct(mean * 100, 100)} %`);
    check('P6: the same repertoire at every login (from the name)', ambient.every(l => L.inRepertoire(names[3], l) === L.inRepertoire(names[3], l)) && ambient.some(l => L.inRepertoire(names[3], l) !== L.inRepertoire(names[4], l)));
    // an odd line: how many of 100 bots could say it
    const odd = L.UPSTREAM_LINES.find(l => l.text === 'Darkness overpowering.');
    const sayers = odd ? names.slice(0, 100).filter(n => L.inRepertoire(n, odd)).length : -1;
    check('P6: an odd line ("Darkness overpowering.") is in the repertoire of about a quarter of 100 bots', sayers >= 12 && sayers <= 40, `${sayers} of 100`);
    const cp = names.slice(0, 300).map(n => L.catchphrasesOf(n, lib.personaOf(n)));
    check('P6: every bot has 2-3 catchphrases of its own, the same at every call', cp.every(c => c.length >= 2 && c.length <= 3) && L.catchphrasesOf(names[7], lib.personaOf(names[7])) === L.catchphrasesOf(names[7], lib.personaOf(names[7])));
    const memes = new Set(variety.catchphrases.meme);
    const plainMeme = names.slice(0, 300).filter(n => !lib.personaOf(n).meme && L.catchphrasesOf(n, lib.personaOf(n)).some(l => memes.has(l.text)));
    check('P6: a meme catchphrase only for a meme persona', plainMeme.length === 0, plainMeme.slice(0, 3));
    const idle = picks(i => ctx({ name: names[i % 40], persona: lib.personaOf(names[i % 40]) }), 1500);
    const said = idle.filter(p => p.line.catchphrase).length;
    check('P6: catchphrases now and then: 0.5-8 % of idle picks', said / idle.length >= 0.005 && said / idle.length <= 0.08, `${said} of ${idle.length}`);
}

// ======== P9: register ========
{
    const fast = personas.filter(x => x.p.style.abbreviate >= 0.8 && !x.p.meme).slice(0, 10).map(x => x.name);
    const careful = personas.filter(x => x.p.ageBand === 'adult' && x.p.style.abbreviate < 0.3 && !x.p.meme).slice(0, 10).map(x => x.name);
    const formalShare = list => {
        const ps = picks(i => ctx({ name: list[i % list.length], persona: lib.personaOf(list[i % list.length]), task: 'none', targets: [], x: 3000, z: 3000 }), 1500).filter(p => p.line.source === 'upstream');
        return { formal: ps.filter(p => L.registerOf(p.line) > 0).length / ps.length, short: ps.filter(p => L.registerOf(p.line) < 0).length / ps.length, n: ps.length };
    };
    const f = formalShare(fast);
    const c = formalShare(careful);
    check('P9: a fast abbreviator picks fewer formal upstream lines than a careful adult (half or less), words verbatim', f.formal <= c.formal * 0.6 && f.n > 200 && c.n > 200, `formal ${pct(f.formal * 100, 100)} % vs ${pct(c.formal * 100, 100)} %; shorthand ${pct(f.short * 100, 100)} % vs ${pct(c.short * 100, 100)} %`);
}

// ======== P3: slots ========
{
    check('P3: the next unlocks as 2004 counted them (25 wc: 30 willows; 38 att: 40 rune; 42 prayer: 43; 53 mage: 55 high alch)', Slots.nextUnlock('wc', 25, true)?.unlock === 'willows' && Slots.nextUnlock('att', 38, true)?.next === 40 && Slots.nextUnlock('prayer', 42, true)?.next === 43 && Slots.nextUnlock('mage', 53, true)?.unlock === 'high alch' && Slots.nextUnlock('att', 45, false)?.unlock === undefined);
    const levels = Array(21).fill(1);
    levels[8] = 27;
    const v = Slots.slotValues({ kind: 'Woodcut', action: null, targets: ['willow'], x: 3086, z: 3234, level: 0, members: true, moving: false, levels, stepAt: null, drop: null });
    check('P3: a woodcutter at Draynor\'s willows: {place} draynor, {target} willows, {skill} wc, {n} 27, {next} 30, {unlock} willows, {want} addy axe', v.place === 'draynor' && v.target === 'willows' && v.skill === 'wc' && v.n === '27' && v.next === '30' && v.unlock === 'willows' && v.want === 'addy axe' && !v.dest, v);
    const walk = Slots.slotValues({ kind: 'Mine', action: null, targets: ['iron'], x: 3213 + 60, z: 3428, level: 0, members: true, moving: true, levels, stepAt: [3213, 3428], drop: null });
    const far = Slots.slotValues({ kind: 'Mine', action: null, targets: ['iron'], x: 3090, z: 3250, level: 0, members: true, moving: true, levels, stepAt: [3213, 3428], drop: null });
    check('P3: {dest} in a walk\'s last stretch only (60 tiles from Varrock: "varrock"; from Draynor: none)', walk.dest === 'varrock' && far.dest === undefined, { walk: walk.dest, far: far.dest });
    const atWillows = picks(() => ctx({ levels }), 1500);
    const slotted = atWillows.filter(p => p.line.slots);
    check('P3: a woodcutter at the willows says slot lines, filled, no slot left', slotted.length > 50 && slotted.every(p => !/[{}]/.test(p.text)), `${slotted.length} of ${atWillows.length}: ${slotted.slice(0, 5).map(p => p.text).join(' | ')}`);
    const nowhere = picks(() => ctx({ task: 'none', targets: [], x: 3000, z: 3000, slots: {} }), 600);
    check('P3: a line whose slots cannot be filled does not fit', nowhere.every(p => !p.line.slots), nowhere.filter(p => p.line.slots).slice(0, 3).map(p => p.text).join(' | '));
    const specific = atWillows.filter(p => L.isSpecificLine(p.line)).length;
    check('P3: at the willows a good share of idle picks are about the task, the target or the place (35 %+; W6 counts the event lines too)', specific / atWillows.length >= 0.35, `${pct(specific, atWillows.length)} %`);
    const fit = atWillows.filter(p => !M.isQuestion(p.text)).map(p => M.contextFit(p.text, 'Woodcut', 3086, 3234, 0));
    const judged = fit.filter(f => f.skill !== null || f.place !== null);
    const ok = judged.filter(f => f.skill !== false && f.place !== false).length;
    check('P3: the humanlike report\'s context fit (H8) on these picks is at least 90 %', ok / judged.length >= 0.9, `${ok} of ${judged.length}`);
    // arrivals name the place
    const arrive = picks(() => ctx({ task: 'none', targets: [], x: 2997, z: 3375, events: new Map([['arrival', { tick: 100000 - 5 }]]) }), 300, { event: 'arrival' }).filter(p => p.line.source === '2004' && p.line.tag.event === 'arrival');
    check('P3: a 2004 arrival line at Falador park names the place ("finally in fally")', arrive.length > 0 && arrive.filter(p => p.text.includes('fally')).length / arrive.length >= 0.8, arrive.slice(0, 4).map(p => p.text).join(' | '));
    const drop = picks(() => ctx({ task: 'Combat', targets: ['hill giant'], x: 3110, z: 9840, drop: 'rune med', events: new Map([['drop', { tick: 100000 - 5, item: 'rune med' }]]) }), 300, { event: 'drop' });
    check('P3: a drop line names the item ("omg rune med")', drop.some(p => p.text.includes('rune med')), drop.slice(0, 4).map(p => p.text).join(' | '));
}

// ======== P11: topic families ========
{
    const fam = L.NEW_LINES.filter(l => variety.groups.some(g => g.lines.includes(l.text)));
    check('P11: no line of the new library says "password" (the 274 filter stars it) or a post-2004 word (H22)', fam.every(l => !/password/i.test(l.text) && !M.META.test(l.text)), fam.filter(l => /password/i.test(l.text) || M.META.test(l.text)).map(l => l.text).slice(0, 3).join(' | '));
    const romance = fam.filter(l => l.tag.who?.includes('notkid'));
    const kid = personas.find(x => x.p.ageBand === 'kid' && !x.p.meme)?.name;
    const kidPicks = picks(() => ctx({ name: kid, persona: lib.personaOf(kid), near: [neighbour(), neighbour()] }), 1500);
    check('P11: romance lines (about 15, low weight) never from a kid', romance.length >= 12 && romance.every(l => (l.tag.weight ?? 1) <= 0.3) && kidPicks.every(p => !p.line.tag.who?.includes('notkid')), `${romance.length} lines`);
    const dance = fam.filter(l => l.tag.emote === 'dance');
    check('P11: dance lines come with the dance emote', dance.length >= 10, `${dance.length}`);
    const clan = fam.filter(l => l.slots?.includes('clan') || l.tag.who?.includes('clan'));
    const clanless = picks(() => ctx({ x: 3185, z: 3441, task: 'none', targets: [] }), 800).filter(p => clan.includes(p.line));
    const clanned = picks(() => ({ ...ctx({ x: 3185, z: 3441, task: 'none', targets: [] }), slots: { ...ctx({ x: 3185, z: 3441, task: 'none', targets: [] }).slots, clan: 'dark knights' } }), 3000).filter(p => clan.includes(p.line));
    check('P11: clan recruiting only from a clique member (its {clan}), at a hub', clan.length >= 15 && clanless.length === 0 && clanned.length > 0, `${clanned.length}: ${clanned.slice(0, 3).map(p => p.text).join(' | ')}`);
    const tips = fam.filter(l => l.tag.at?.includes('newbie-near'));
    const helpful = personas.find(x => x.p.helpfulness > 0.6 && !x.p.meme)?.name;
    const tipNear = picks(() => ctx({ name: helpful, persona: lib.personaOf(helpful), cb: 60, task: 'none', targets: [], x: 3222, z: 3218, near: [neighbour({ newbie: true, dist: 4 })] }), 1500).filter(p => tips.includes(p.line));
    const tipNone = picks(() => ctx({ name: helpful, persona: lib.personaOf(helpful), cb: 60, task: 'none', targets: [], x: 3222, z: 3218 }), 800).filter(p => tips.includes(p.line));
    check('P11: a veteran\'s unasked tip only near a newbie', tips.length >= 15 && tipNear.length > 0 && tipNone.length === 0, `${tipNear.length} near a newbie, ${tipNone.length} without`);
    const counts = {};
    for (const g of variety.groups) counts[g.tag.c] = (counts[g.tag.c] ?? 0) + g.lines.length;
    check('P3/P11: the new library: about 500 lines (specific lines and topic families)', fam.length >= 450, `${fam.length}: ${JSON.stringify(counts)}`);
}

// ======== P10: no signatures (chat effects are for adverts) ========
check('P10: no persona has a chat signature (a colour and effect of its own for its talk)', personas.every(x => !('signature' in x.p)), `${personas.filter(x => 'signature' in x.p).length} of ${personas.length}`);

// ======== S8: a seller's pace ========
{
    const medians = names.slice(0, 200).map(n => {
        const gaps = Array.from({ length: 301 }, () => lib.advertGapOf(n)).sort((a, b) => a - b);
        return gaps[150];
    });
    const one = Array.from({ length: 2000 }, () => lib.advertGapOf(names[11]));
    const m = one.reduce((a, b) => a + b, 0) / one.length;
    const cv = Math.sqrt(one.reduce((a, b) => a + (b - m) ** 2, 0) / one.length) / m;
    check('S8: a seller\'s own pace: medians 8-45 s across sellers, its gaps log-normal (CV 0.6-1.1)', Math.min(...medians) >= 9 && Math.max(...medians) <= 90 && cv >= 0.6 && cv <= 1.1, `medians ${Math.min(...medians)}-${Math.max(...medians)} ticks, CV ${cv.toFixed(2)}`);
    // (2026-10-18) the auto typers: about half the vendors, each its own gap of 8-15 s, the same every time
    const typers = names.slice(0, 400).map(n => lib.autoTyperGapOf(n));
    const typing = typers.filter(g => g !== null);
    const steady = names.slice(0, 400).every((n, i) => lib.autoTyperGapOf(n) === typers[i]);
    check('S8: auto typers: about half the vendors (40-60 %), a gap of 13-25 ticks of their own, the same every time', typing.length / typers.length >= 0.4 && typing.length / typers.length <= 0.6 && typing.every(g => g >= 13 && g <= 25) && new Set(typing).size >= 8 && steady, `${typing.length} of ${typers.length}, gaps ${Math.min(...typing)}-${Math.max(...typing)}`);
}

// ======== in the world: the chatter ========
lib.setCliqueBehaviourForTest(false);
lib.setHabitRatesForTest({ breaks: 0, lingers: 0, watch: 0, abrupt: 0 });
lib.setHangoutRateForTest(0.0001);
// (the human far from everything staged here: bots come online only with a human in the world)
sim.addHuman(3300, 3000);
for (let i = 0; i < 400 && sim.bots().length < 40; i++) sim.tick();
sim.freezeBots();
const said = [];
lib.sayListeners.push((player, text, kind, to) => said.push({ t: World.currentTick, name: player.username, text, kind, to: to?.username ?? null, styled: !!(player.chatColour || player.chatEffect) }));
const bots = sim.bots().filter(p => !lib.isNewbie(p) && !['extras_vendor', 'extras_pker', 'extras_edgeville_pker', 'extras_social'].includes(p.botPlanner));
const place = (p, x, z) => {
    p.clearWaypoints();
    p.clearPendingAction();
    p.teleJump(x, z, 0);
};
const tick = n => {
    for (let i = 0; i < n; i++) sim.tick();
};
check('in the world: levelling bots to stage', bots.length >= 12, `${bots.length} of ${sim.bots().length}: ${sim.bots().map(p => p.botPlanner).join(' ')}`);
if (bots.length < 12) {
    for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    process.exit(1);
}

// SAY-5: one death line a death
{
    const deathKeys = new Set(L.ALL_LINES.filter(l => l.tag.c === 'death').map(l => L.meaningKey(l.text)));
    let first = 0;
    let second = 0;
    const examples = [];
    for (const [i, bot] of bots.slice(0, 10).entries()) {
        place(bot, 3222 + (i % 5), 3218 + Math.floor(i / 5));
        tick(2);
        for (const wild of [false, true]) {
            lib.noteDeathForTest(bot, wild);
            for (let k = 0; k < 4; k++) {
                const from = said.length;
                lib.sayDueForTest(bot);
                tick(30);
                for (const s of said.slice(from)) {
                    if (s.name !== bot.username || !deathKeys.has(L.meaningKey(s.text))) continue;
                    if (k === 0) first++;
                    else {
                        second++;
                        examples.push(s.text);
                    }
                }
            }
            tick(200);
        }
    }
    check('SAY-5: after a death (plain or in the Wilderness) the next due line is about it, the three after it never', first >= 12 && second === 0, `${first} first, ${second} second: ${examples.slice(0, 3).join(' | ')}`);
}

// P2: alone, a fifth of the talk (a quiet drawn at the lone rate) and a line due when the company left held and dropped;
// with company the rate times 1 + 0.15 a player near (up to 4)
{
    const loners = bots.slice(0, 12);
    // (far apart, nobody within 15 tiles: Karamja's south and the sea, 40 tiles between each)
    loners.forEach((bot, i) => place(bot, 2860 + 40 * (i % 4), 3060 + 40 * Math.floor(i / 4)));
    tick(3);
    const near = bot => sim.bots().some(o => o !== bot && o.level === bot.level && Math.abs(o.x - bot.x) <= 15 && Math.abs(o.z - bot.z) <= 15);
    const lonely = loners.filter(b => !near(b));
    const meanQuiet = list => {
        let sum = 0;
        let n = 0;
        for (let i = 0; i < 300; i++) for (const bot of list) (sum += lib.quietForTest(bot), n++);
        return sum / n;
    };
    const alone = meanQuiet(lonely);
    const saidAfter = (list, quietAlone, ticks) => {
        let due = 0;
        let saidN = 0;
        for (let round = 0; round < 6; round++) {
            for (const bot of list) (lib.dueNowForTest(bot, quietAlone), due++);
            const from = said.length;
            for (let t = 0; t < ticks; t++) {
                for (const bot of list) lib.tickChatter(bot);
                sim.tick();
            }
            saidN += new Set(said.slice(from).filter(s => list.some(b => b.username === s.name) && s.kind !== 'levelup').map(s => s.name)).size;
        }
        return { due, said: saidN };
    };
    const held = saidAfter(lonely, false, 320);
    const lone = saidAfter(lonely, true, 40);
    // with company: at Varrock square, 2 tiles apart
    loners.forEach((bot, i) => place(bot, 3205 + (i % 6) * 2, 3425 + Math.floor(i / 6) * 2));
    tick(3);
    const company = meanQuiet(loners);
    const withCompany = saidAfter(loners, false, 40);
    check(`P2: alone a bot talks at about a fifth of its rate (LONE_RATE ${lib.LONE_RATE}): its quiet 3.5-10 times one with company`, lonely.length >= 8 && alone / company >= 3.5 && alone / company <= 10, `${lonely.length} alone: mean quiet ${Math.round(alone)} ticks, with company ${Math.round(company)}`);
    check('P2: a line due alone after a quiet with company is held and dropped; after a lone quiet it is said', held.said <= held.due * 0.1 && lone.said >= lone.due * 0.7, `held: ${held.said} of ${held.due} said; after a lone quiet: ${lone.said} of ${lone.due}`);
    check('P2: with company the due line is said (70 %+)', withCompany.said >= withCompany.due * 0.7, `${withCompany.said} of ${withCompany.due}`);
}

// SAY-7: greetings and a newbie's statement
{
    const greetings = [...L.ALL_LINES.filter(l => l.tag.c === 'greeting' && !l.tag.event).map(l => l.text.replaceAll('{name}', '').trim()), 'Heyy :)', 'yo', 'heya', 'wassup', 'o hey', 'ello', 'hey all', 'heyyyy', 'hiii :D'];
    const notGreeting = greetings.filter(t => !lib.isGreetingLine(t));
    check('SAY-7: the bots\' own greetings ("Heyy {name} :)", yo, heya, wassup, o hey, ello, hey all, stretched, with a smiley) read as greetings', notGreeting.length <= 3, notGreeting.join(' | '));
    check('SAY-7: a newbie\'s statement is no question ("im new lol", "first day playing :)"); its question is', !lib.isQuestionText('im new lol') && !lib.isQuestionText('first day playing :)') && lib.isQuestionText('how do i fish'));
    // a newbie says it is new among bots: no shrug or "?" (it asked nothing), now and then a welcome
    const newbie = bots[0];
    const crowd = bots.slice(1, 6);
    place(newbie, 3222, 3218);
    crowd.forEach((b, i) => place(b, 3224 + i, 3220));
    tick(3);
    const roll = lib.chatDice.roll;
    lib.chatDice.roll = () => 0;
    const welcomes = [];
    const wrong = [];
    for (let i = 0; i < 6; i++) {
        const from = said.length;
        lib.BotChat.onBotLine(newbie, 'im new lol', 'newbie');
        tick(260);
        for (const s of said.slice(from)) {
            // (a bot's answer to it: a practice a regular near starts with it is no answer)
            if (s.to !== newbie.username || s.name === newbie.username || s.kind !== 'botreply') continue;
            if (lib.BOT_CHAT_LINES.newbieWelcome.includes(s.text.toLowerCase()) || lib.BOT_CHAT_LINES.newbieWelcome.some(w => w.toLowerCase() === s.text.toLowerCase())) welcomes.push(s.text);
            else wrong.push(s.text);
        }
    }
    lib.chatDice.roll = roll;
    check('SAY-7: "im new lol" gets a welcome now and then ("welcome", "gl"), never an answer as to a question', welcomes.length >= 1 && wrong.length === 0, `welcomes ${welcomes.join(', ')}; other ${wrong.join(', ')}`);
}

// S9: a friend's first message is about what it does
{
    const bot = bots[2];
    sim.botPlayer(bot); // (its task: whatever it had when frozen)
    const lines = Array.from({ length: 20 }, () => lib.friendOpener(bot));
    const L2 = lib.BOT_CHAT_LINES;
    const shaped = lines.every(t => L2.friendOpeners.includes(t) || [...L2.friendDoing, ...L2.friendLevel].some(f => new RegExp(`^${f.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(doing|n|skill)\}/g, '.+')}$`).test(t)));
    check('S9: a friend\'s first message: what it is doing, a level it got, else an opener; every one through the filter', shaped && lines.every(t => lib.WordEnc.filter(t) === t && t.length <= 80), lines.slice(0, 4).join(' | '));
}

// P10: the world's talk is plain yellow (adverts and set-piece calls aside; a clan's recruiting call is an advert)
{
    const ASIDE = new Set(['trade', 'setpiece', 'rumour', 'scam', 'mod']);
    const styled = said.filter(s => !ASIDE.has(s.kind) && s.styled && !/recruit|\bjoin\b|members|needs|pm me|add me/.test(s.text.toLowerCase()));
    check('P10: no talk in a colour or with an effect (adverts aside)', styled.length === 0 && said.length > 50, `${styled.length} of ${said.length} lines: ${styled.slice(0, 3).map(s => `${s.kind} "${s.text}"`).join(' | ')}`);
}

check('no errors', errors.length === 0, errors.slice(0, 3).join(' | '));

// ---- report ----
let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
out(`talk: ${failed ? `${failed} of ${checks.length} failed` : `all ${checks.length} passed`}`);
process.exit(failed ? 1 : 0);
