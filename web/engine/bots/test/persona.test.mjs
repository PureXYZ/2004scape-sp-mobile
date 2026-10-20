#!/usr/bin/env node
// Personas (port/BotPersona) and human timing (port/BotTiming), the realism work's foundation:
//   same name   the same persona every time, without Math.random (a bot is the same person at every login)
//   shares      over the 2,400 names: about 1 in 8 meme personas; most bots quiet (median about 5 lines an hour) and a
//               few chatty; mostly teenagers; mostly from the US and the UK; a year of birth in the name is the age
//   charset     every laugh and smiley a persona uses survives 274's chat codec (WordPack)
//   timing      typing time grows with the line, stays within 2-20 ticks; reactions within their caps, a person's medians
//
//   node web/engine/bots/test/persona.test.mjs
import path from 'path';
import { BOTS_SRC, importTs } from './lib/paths.mjs';

const P = await importTs(path.join(BOTS_SRC, 'port/BotPersona.ts'));
const T = await importTs(path.join(BOTS_SRC, 'port/BotTiming.ts'));
const R = await importTs(path.join(BOTS_SRC, 'port/BotRoster.ts'));

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
const median = xs => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const share = (xs, f) => xs.filter(f).length / xs.length;
const pct = x => `${(100 * x).toFixed(1)} %`;

// ---- same name, same persona, and no Math.random in it ----
{
    const realRandom = Math.random;
    let used = false;
    Math.random = () => {
        used = true;
        return 0.5;
    };
    const a = P.personaOf('Persona Test 1', 'skiller');
    const b = P.personaOf('persona_test_1', 'skiller');
    Math.random = realRandom;
    check('same name: the same persona (display or stored name), without Math.random', JSON.stringify(a) === JSON.stringify(b) && !used, used ? 'Math.random was called' : '');
}

// ---- shares over the whole name list ----
const personas = R.BOT_NAMES.map(name => ({ name, planner: R.plannerOf(name), p: P.personaOf(name) }));
const all = personas.map(x => x.p);
const levelling = personas.filter(x => x.planner && R.isLevelling(x.planner)).map(x => x.p);
check('about 1 in 8 meme personas', share(all, p => p.meme) > 0.1 && share(all, p => p.meme) < 0.15, pct(share(all, p => p.meme)));
const chat = levelling.map(p => p.chattiness);
const meanChat = chat.reduce((s, x) => s + x, 0) / chat.length;
check('levelling bots: median about 5 lines an hour, mean 4-10, a chatty tail', median(chat) > 3.5 && median(chat) < 7 && meanChat >= 4 && meanChat <= 10 && share(levelling, p => p.chattiness >= 15) > 0.01, `median ${median(chat).toFixed(1)}, mean ${meanChat.toFixed(1)}, ≥15: ${pct(share(levelling, p => p.chattiness >= 15))}`);
const social = personas.filter(x => x.planner === 'extras_social').map(x => x.p.chattiness);
// (phase 3 of the realism work: 1.75 times a levelling bot's idle talk, from 2.5: a social regular's greetings to
// passers-by and its exchanges at its hub carry the rest of its talk now; before, 1.8 times was checked)
check('social bots talk more', median(social) > median(chat) * 1.5, `median ${median(social).toFixed(1)}`);
const kids = share(all, p => p.ageBand === 'kid');
const teens = share(all, p => p.ageBand === 'teen');
const adults = share(all, p => p.ageBand === 'adult');
check('ages: mostly teenagers, some kids and adults', teens > 0.4 && teens < 0.7 && kids > 0.08 && kids < 0.3 && adults > 0.15 && adults < 0.45, `kids ${pct(kids)}, teens ${pct(teens)}, adults ${pct(adults)}`);
check('a year of birth in the name is the age in 2004', P.ageFromName('kevin1991') === 13 && P.ageFromName('aaron 1986') === 18 && P.ageFromName('sophie 2003') === null && P.ageFromName('rich kid 2k4') === null);
const named = personas.filter(x => P.ageFromName(x.name) !== null);
check('bots with a year in their name have that age', named.length > 100 && named.every(x => x.p.age === P.ageFromName(x.name)), `${named.length} names`);
const usa = share(all, p => p.region === 'usa');
const uk = share(all, p => p.region === 'uk');
check('regions: mostly the US, then the UK', usa > 0.35 && usa < 0.55 && uk > 0.17 && uk < 0.33, `usa ${pct(usa)}, uk ${pct(uk)}`);
check('typing speed 2.2-6.5 characters a second, kids slower', all.every(p => p.typingCps >= 2.2 && p.typingCps <= 6.5) && median(all.filter(p => p.ageBand === 'kid').map(p => p.typingCps)) < median(all.filter(p => p.ageBand === 'teen').map(p => p.typingCps)));
const pkers = personas.filter(x => x.planner === 'extras_pker' || x.planner === 'extras_edgeville_pker').map(x => x.p.friendliness);
check('PKers are less friendly than the rest', median(pkers) < median(levelling.map(p => p.friendliness)) - 0.3);
// phase 5 (texture): carelessness and rude deeds, from their own seed
const care = all.map(p => p.carelessness);
check('carelessness 0.05-1, median about 0.25, about 1 in 10 above 0.6, kids more', care.every(c => c >= 0.05 && c <= 1) && median(care) > 0.2 && median(care) < 0.32 && share(all, p => p.carelessness > 0.6) > 0.04 && share(all, p => p.carelessness > 0.6) < 0.16 && median(all.filter(p => p.ageBand === 'kid').map(p => p.carelessness)) > median(all.filter(p => p.ageBand === 'adult').map(p => p.carelessness)), `median ${median(care).toFixed(2)}, >0.6: ${pct(share(all, p => p.carelessness > 0.6))}`);
const rudeLevelling = share(levelling, p => p.rudeActs);
check('rude deeds: about 20 % of levelling bots, most PKers, every rude talker', rudeLevelling > 0.13 && rudeLevelling < 0.3 && share(personas.filter(x => x.planner === 'extras_pker' || x.planner === 'extras_edgeville_pker').map(x => x.p), p => p.rudeActs) > 0.5 && all.every(p => !P.isRude(p) || p.rudeActs), `levelling ${pct(rudeLevelling)}`);

// ---- charset: what 274's chat codec carries (Server/webclient WordPack): a-z 0-9 space !?.,:;()-&*'@#+=£$%"[] ----
const CHARSET = /^[a-z0-9 !?.,:;()\-&*'@#+=£$%"[\]]*$/;
const tokens = new Set(all.flatMap(p => [...p.style.laughs, ...p.style.smileys]));
const bad = [...tokens].filter(t => !CHARSET.test(t.toLowerCase()));
check("every laugh and smiley survives 274's chat codec", bad.length === 0, bad.join(' '));

// ---- timing ----
{
    let s = 7;
    const random = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const typical = { ...P.personaOf('kevin1991'), typingCps: 4, thinkMs: 1800, reaction: 1, lapseRate: 0.05 };
    const short = Array.from({ length: 1000 }, () => T.typingTicks(typical, 'lol', { random }));
    const long = Array.from({ length: 1000 }, () => T.typingTicks(typical, 'yeah im cutting willows at draynor, u?', { random }));
    const busy = Array.from({ length: 1000 }, () => T.typingTicks(typical, 'yeah im cutting willows at draynor, u?', { random, busy: true }));
    check('typing: 2-20 ticks, a short line quick, a long one about 8-12 s, busy slower', [...short, ...long, ...busy].every(t => t >= 2 && t <= 20) && median(short) <= 6 && median(long) >= 11 && median(long) <= 20 && median(busy) >= median(long), `"lol" ${median(short)}, 39 chars ${median(long)}, busy ${median(busy)} ticks (median)`);
    const re = Array.from({ length: 2000 }, () => T.reactionTicks(typical, 'retarget', random));
    const bank = Array.from({ length: 2000 }, () => T.reactionTicks(typical, 'bank', random));
    const trade = Array.from({ length: 2000 }, () => T.reactionTicks(typical, 'trade', random));
    check('reactions: a re-click about 1-3 s (under 10 % within a tick) with a few lapses, a bank stop 3-20 s, a trade read 1-4 s', median(re) >= 2 && median(re) <= 4 && share(re, t => t <= 1) < 0.1 && share(re, t => t >= 8) > 0.02 && median(bank) >= 6 && median(bank) <= 13 && Math.max(...bank) <= 40 && median(trade) >= 2 && median(trade) <= 6, `re-click ${median(re)} (≤1: ${pct(share(re, t => t <= 1))}, ≥8: ${pct(share(re, t => t >= 8))}), bank ${median(bank)}, trade ${median(trade)} ticks`);
}

let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(failed ? `persona: ${failed} of ${checks.length} failed` : `persona: all ${checks.length} passed`);
process.exit(failed ? 1 : 0);
