#!/usr/bin/env node
// Conversation (the variety work, round 2, Track S2,
// the research), on the data and in the real 274 world:
//   threads     P4: about 30 topics; a thread of 2-3 turns between strangers, up to 6 between friends; a counter-question
//               ("41 u?") answered by the other from its own state; the lines whole through the word filter; a pair's
//               memory for the session (asl, where u from never twice, a topic followed up a while later: "still 41?");
//               a thread said in the world turn by turn, typed, to the other, kind 'practice'; the counter-question rule
//               for any bot's answer to a bot's question (port/BotChat: "whats ur wc lvl?" / "41 u?" / "38")
//   voice       P5: a busy place's talk (25+ lines in an hour from 5+ speakers) holds a bot over a fifth of it; a quiet
//               place's two talkers are free
//   approach    P5: a social regular's opener reacts to what the human is (a partyhat, its level), upstream's small talk
//               kept word for word ("this game is addictive ngl" a meme persona's only)
//   witnesses   P7: a death near (Hitpoints to 0) gets a word from a bot near ("rip"; at the ditch "lol he got pked"), never
//               from its killer; a drop announced gets "lucky" or "what did u get" and the bragger's answer; the human's
//               dance a reaction, never two within a minute; a statement now and then a response by its class
//   gear        WEAR-11: a partyhat worn at a bank gets a comment; a full set put on is shown off ("finally full addy"); 274's
//               trimmed and god armour named as players said them
//   cliques     P8: mates together talk (banter, an in-joke, a thread); each clique its own in-joke from its names
//   gz          S2-6: one roll for the crowd, by how many are near
//   fixes       (variety round 2, the fixes: B) upstream's answers keep their words (a question back a line of its own,
//               "I'm alright" / "u?"); an exchange's turns and the conversation's new chains each in the place of a line
//               of the speaker's own (the debt); a members or novelty piece gets its own words, never "nice armour"
//   errors      none
//
//   node --expose-gc web/engine/bots/test/threads.test.mjs [--seed=5]
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
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

const engineDir = prepareEngineClone('threads', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/threads.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, Threads: T, Witness: W, Voice: V, Lines: L, Cliques: C } = lib;
const sim = await lib.Sim.create({ bots: 40, members: true, debug: false });

// ======== the data and the pure parts ========
{
    const topics = T.THREAD_TOPICS;
    check('P4: about 30 topics (levels, what u doing, goals, members, asl, drops, Halo 2, Castle Wars ...)', topics.length >= 28 && ['level', 'doing', 'goal', 'members', 'asl', 'from', 'drops', 'halo', 'cw', 'zezima', 'school'].every(t => topics.includes(t)), topics.join(' '));
    const cases = [['41 u?', '41'], ['cutting willows, wbu', 'cutting willows'], ['Yeah not bad thanks, you?', 'Yeah not bad thanks'], ['16 m uk, u?', '16 m uk'], ['im 31 and u?', 'im 31'], ['hey', null], ['u there', null]];
    const bad = cases.filter(([t, want]) => T.withoutCounter(t) !== want);
    check('P4: a counter-question at a line\'s end is found and cut ("41 u?" is 41, "cutting willows, wbu" ...)', bad.length === 0, bad.map(([t]) => `${t} → ${T.withoutCounter(t)}`).join('; '));
    const g = n => W.localNotableGear(n);
    const gear = [
        [['red partyhat'], 'rare', 'phat'], [['santa hat'], 'rare', 'santa'], [['rune platebody (t)'], 'trim', 'rune plate (t)'], [['adam platebody (g)'], 'trim', 'addy plate (g)'],
        [['zamorak platebody'], 'god', 'zammy plate'], [['saradomin full'], 'god', 'sara helm'], [['dragon med helm'], 'dragon', 'dragon med'], [['rune full helm', 'rune platebody', 'rune platelegs'], 'fullrune', 'full rune']
    ];
    const wrong = gear.filter(([names, kind, item]) => g(names)?.kind !== kind || g(names)?.item !== item);
    check('WEAR-11: notable gear as players named it (a phat, rune (t), addy (g), zammy plate, sara helm, dragon med, full rune); bronze none', wrong.length === 0 && g(['bronze sword', 'leather body']) === null, wrong.map(([n]) => `${n.join('+')} → ${JSON.stringify(g(n))}`).join('; '));
    check('S2-6: a gz from the crowd: more than half with one bot near, more with a crowd, at most 0.85', lib.gzChanceForTest(1) >= 0.5 && lib.gzChanceForTest(1) <= 0.7 && lib.gzChanceForTest(5) > lib.gzChanceForTest(1) && lib.gzChanceForTest(20) <= 0.85, [1, 3, 5, 20].map(n => lib.gzChanceForTest(n).toFixed(2)).join(' '));
}

// ======== P5: the voice cap (a busy place's talk) ========
{
    V.resetVoiceForTest();
    const t0 = World.currentTick;
    const at = (name, x = 3200, z = 3200) => ({ username: name, x, z, level: 0 });
    // a busy place: 30 lines from 6 speakers, 'loud' 10 of them
    for (let i = 0; i < 30; i++) V.noteVoice(i < 10 ? 'loud' : `p${i % 5}`, 3200 + (i % 7), 3200 - (i % 5), 0, t0 - 100 + i);
    const busy = !V.voiceFree(at('loud'), t0) && V.voiceFree(at('p1'), t0) && V.voiceFree(at('newcomer'), t0);
    // a quiet place: two woodcutters talking (40 lines, two speakers): no cap
    for (let i = 0; i < 40; i++) V.noteVoice(i % 2 ? 'cutter_a' : 'cutter_b', 2900, 3100, 0, t0 - 100 + i);
    const quiet = V.voiceFree(at('cutter_a', 2900, 3100), t0);
    // an hour later the place has forgotten
    const later = V.voiceFree(at('loud'), t0 + 6001);
    // lines 20 tiles away are another place
    const apart = V.voiceFree(at('loud', 3230, 3200), t0);
    check('P5: at a busy place (25+ lines in an hour, 5+ speakers) a bot over a fifth of its talk is held, others free; two talkers alone are free; an hour on, free; 20 tiles off is another place', busy && quiet && later && apart, { busy, quiet, later, apart });
    V.resetVoiceForTest();
}

// ======== in the world ========
C.setCliqueBehaviourForTest(false);
lib.setHabitRatesForTest({ breaks: 0, lingers: 0, watch: 0, abrupt: 0 });
lib.setHangoutRateForTest(0.0001);
lib.setDirectorForTest({ first: 1e9, gap: 1e9 });
// (the human far from everything staged here: bots come online only with a human in the world)
sim.addHuman(3300, 3000);
for (let i = 0; i < 400 && sim.bots().length < 40; i++) sim.tick();
sim.freezeBots();
const said = [];
lib.sayListeners.push((player, text, kind, to) => said.push({ t: World.currentTick, name: player.username, text, kind, to: to?.username ?? null }));
const bots = sim.bots().filter(p => !lib.isNewbie(p) && !['extras_vendor', 'extras_pker', 'extras_edgeville_pker', 'extras_social'].includes(p.botPlanner));
const place = (p, x, z) => {
    p.clearWaypoints();
    p.clearPendingAction();
    p.teleJump(x, z, 0);
};
const tick = n => {
    for (let i = 0; i < n; i++) sim.tick();
};
check('in the world: levelling bots to stage', bots.length >= 14, `${bots.length} of ${sim.bots().length}`);
if (bots.length < 14) {
    for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    process.exit(1);
}
const clean = text => lib.WordEnc.filter(text) === text && !/[{}]/.test(text) && text.length <= 80;
const nameOf = p => p.username;

// P4: threads drawn: strangers 2-3 turns, friends up to 6; a counter-question answered by the other
{
    scene(SEED, 'threads-drawn');
    let total = 0;
    let three = 0;
    let over = 0;
    let dirty = [];
    let counters = 0;
    let answered = 0;
    let wrongTo = 0;
    for (let i = 0; i < 40; i++) {
        const a = bots[i % bots.length];
        const b = bots[(i * 7 + 3) % bots.length];
        if (a === b) continue;
        const lines = T.drawThread(a, b, T.DEPTH_OTHERS);
        if (!lines) continue;
        total++;
        if (lines.length >= 3) three++;
        if (lines.length > 3) over++;
        for (const [k, l] of lines.entries()) {
            if (!clean(l.text)) dirty.push(l.text);
            if (!((l.speaker === a && l.to === b) || (l.speaker === b && l.to === a))) wrongTo++;
            if (T.COUNTER_RX.test(l.text.trim()) && k < lines.length - 1) {
                counters++;
                if (lines[k + 1].speaker !== l.speaker) answered++;
            }
        }
    }
    check('P4: threads between strangers: 3 turns most of the time (2 at least), never over 3', total >= 30 && three / total >= 0.7 && over === 0, `${three} of ${total} of 3 turns, ${over} over`);
    check('P4: every line whole through the 274 filter, said by one of the two to the other', dirty.length === 0 && wrongTo === 0, `${dirty.slice(0, 4).join(' | ')} ${wrongTo}`);
    check('P4: a counter-question ("41 u?") mid-thread is answered by the other', counters >= 5 && answered === counters, `${answered} of ${counters}`);
    // friends: up to 6
    const [a, b] = [bots[0], bots[1]];
    C.setCliquesForTest([[a.username, b.username]]);
    const depth = T.depthFor(a, b);
    let longest = 0;
    let friends = 0;
    for (let i = 0; i < 25; i++) {
        const x = bots[2 + (i % 6)];
        const y = bots[8 + (i % 6)];
        C.setCliquesForTest([[x.username, y.username]]);
        const lines = T.drawThread(x, y, T.depthFor(x, y));
        if (!lines) continue;
        friends++;
        longest = Math.max(longest, lines.length);
        if (lines.length > T.DEPTH_FRIENDS) longest = 99;
    }
    C.setCliquesForTest(null);
    check('P4: clique mates (and hub regulars) talk up to 6 turns: some threads over 3, none over 6', depth === 6 && friends >= 15 && longest >= 4 && longest <= 6, { depth, friends, longest });
}

// P4: the pair's memory: nothing asked again in a session; a level compare followed up a while later
{
    scene(SEED, 'threads-memory');
    const [p, q] = [bots[10], bots[11]];
    const topics = [];
    for (let i = 0; i < 14; i++) {
        const lines = T.drawThread(p, q, T.DEPTH_OTHERS);
        if (lines) topics.push(...T.lastThreadTopicsForTest());
    }
    const twice = topics.filter((t, i) => topics.indexOf(t) !== i);
    check('P4: a pair never opens a topic it talked of this session again (14 threads in a row: each topic once)', topics.length >= 12 && twice.length === 0, `${topics.join(' ')}${twice.length ? `; twice ${twice.join(' ')}` : ''}`);
    check('P4: the engine\'s count of topics asked again is 0', T.threadStats().repeats === 0, `${T.threadStats().repeats}`);
    // a while later (15 minutes of play): a level compare is followed up ("still 41?", "u get 50 yet?")
    const before = T.threadStats().followUps;
    tick(1550);
    let follow = null;
    for (let i = 0; i < 30 && !follow; i++) {
        const lines = T.drawThread(p, q, T.DEPTH_OTHERS);
        if (lines && T.threadStats().followUps > before) follow = lines;
    }
    const again = T.lastThreadTopicsForTest().filter(t => t === 'asl' || t === 'from' || t === 'playtime');
    check('P4: a while later a topic they talked of is followed up, once ("still 41?", "u get 50 yet?", "still cutting willows?"); asl, "where u from" never again', follow !== null && /still|yet|going|now/.test(follow[0].text) && again.length === 0, follow ? follow.map(l => l.text).join(' / ') : 'none');
    check('P4: (port/BotStage) a practice\'s topic is in the pair\'s memory too', (() => {
        const [x, y] = [bots[12], bots[13]];
        const before2 = T.pairTalkedOf(x, y, 'practice-pk');
        T.notePairTopic(x, y, 'practice-pk');
        return !before2 && T.pairTalkedOf(y, x, 'practice-pk');
    })());
}

// P4: a thread said in the world: turn by turn, typed, to the other, kind 'practice'
{
    scene(SEED, 'threads-said');
    const [a, b] = [bots[2], bots[3]];
    place(a, 2700, 3000);
    place(b, 2702, 3001);
    tick(3);
    T.resetThreadsForTest();
    const from = said.length;
    let started = false;
    for (let i = 0; i < 6 && !started; i++) started = T.startThread(a, 'test', b, 6);
    const during = T.inThread(a) && T.inThread(b);
    tick(400);
    const lines = said.slice(from).filter(s => (s.name === a.username && s.to === b.username) || (s.name === b.username && s.to === a.username));
    const typed = lines.length >= 2 && lines.every(s => s.kind === 'practice') && lines[0].name === a.username && lines.slice(1).every((s, i) => s.t > lines[i].t);
    check('P4: a thread is said turn by turn, each typed after the last, to the other (kind practice); both are in it while it lasts, free after', started && during && typed && !T.inThread(a), lines.map(s => `${s.name.slice(0, 6)}: ${s.text}`).join(' / '));
}

// P4: the counter-question rule for any bot's answer to a bot's question (port/BotChat)
{
    scene(SEED, 'threads-counter');
    const roll = lib.chatDice.roll;
    lib.chatDice.roll = () => 0;
    let asked = 0;
    let back = 0;
    let owed = 0;
    const shown = [];
    const debtOf = p => lib.Chatter.chatterStateOf(p)?.debt ?? null;
    for (let i = 0; i < 4; i++) {
        const [a, b] = [bots[4 + 2 * i], bots[5 + 2 * i]];
        place(a, 2650 + 30 * i, 3060);
        place(b, 2652 + 30 * i, 3061);
        tick(3);
        const from = said.length;
        const debt0 = debtOf(a);
        lib.BotChat.onBotLine(a, 'whats ur wc lvl?', 'idle');
        tick(120);
        const reply = said.slice(from).find(s => s.name === b.username && s.to === a.username);
        if (!reply || !T.COUNTER_RX.test(reply.text.trim())) continue;
        asked++;
        const own = said.slice(from).find(s => s.name === a.username && s.to === b.username && s.t > reply.t);
        if (own && /\d/.test(own.text)) back++;
        // (the fixes, B3: the answer back in the place of one of the asker's own lines; its chatter is frozen: nothing paid)
        if (own && debt0 !== null && debtOf(a) === debt0 + 1) owed++;
        shown.push(`${reply.text} / ${own?.text ?? '-'}`);
    }
    lib.chatDice.roll = roll;
    check('P4: a bot\'s answer to a bot that asks back ("41 u?") gets the asker\'s own answer from its state ("38")', asked >= 3 && back === asked, `${back} of ${asked}: ${shown.join(' | ')}`);
    check('B3: the asker\'s answer back is in the place of a line of its own (its debt one more)', back >= 3 && owed === back, `${owed} of ${back}`);
}

// P5: a social regular's opener reacts to what the human is; upstream's small talk word for word
{
    scene(SEED, 'approach');
    const human = sim.human;
    const phat = lib.ObjType.getId('red_partyhat');
    const plain = Array.from({ length: 300 }, () => lib.Social.approachOpener(human, false));
    lib.wearItems(human, [phat]);
    const dressed = Array.from({ length: 300 }, () => lib.Social.approachOpener(human, false));
    human.getInventory(lib.InvType.WORN).delete(0);
    const upstream = lib.Social.SOCIAL_LINES.chat;
    const lowLines = lib.Social.SOCIAL_LINES.approach.low;
    check('P5: the opener reacts to what the human is: a phat ("nice phat"), a level 3 ("u new?"); upstream\'s five word for word; "this game is addictive ngl" never from a non-meme', dressed.some(l => /phat/.test(l)) && !plain.some(l => /phat/.test(l)) && plain.some(l => lowLines.includes(l)) && plain.some(l => upstream.includes(l)) && ![...plain, ...dressed].includes('this game is addictive ngl') && [...plain, ...dressed].every(clean), `${[...new Set(dressed)].slice(0, 6).join(' | ')}`);
}

// P7: a death near: a word from a bot near, never its killer; at the ditch the PK words
{
    scene(SEED, 'witness-death');
    W.resetWitnessForTest();
    W.setWitnessRatesForTest({ death: 1 });
    const [victim, w1, w2] = [bots[0], bots[1], bots[2]];
    const run = (x, z) => {
        place(victim, x, z);
        place(w1, x + 3, z);
        place(w2, x - 2, z + 2);
        tick(3);
        for (const b of [w1, w2]) W.readyForTest(b);
        const from = said.length;
        const hp = victim.levels[lib.PlayerStat.HITPOINTS];
        victim.levels[lib.PlayerStat.HITPOINTS] = 0;
        tick(40);
        victim.levels[lib.PlayerStat.HITPOINTS] = hp;
        tick(2);
        return said.slice(from).filter(s => s.name !== victim.username && (s.name === w1.username || s.name === w2.username));
    };
    const plainDeath = run(2600, 3100);
    const pkDeath = run(3090, 3512);
    const deathPool = new Set(L.NEW_LINES.filter(l => l.tag.event === 'witness-death').map(l => L.meaningKey(l.text)));
    const pkPool = new Set(L.NEW_LINES.filter(l => l.tag.event === 'witness-pk').map(l => L.meaningKey(l.text)));
    check('P7: a death near gets a word from a bot near ("rip"), at the ditch a PK word ("lol he got pked"), logged about the victim', plainDeath.length === 1 && deathPool.has(L.meaningKey(plainDeath[0].text)) && pkDeath.length === 1 && pkPool.has(L.meaningKey(pkDeath[0].text)) && W.witnessLog.filter(w => w.about === victim.username).length === 2, `${plainDeath.map(s => s.text).join(' | ')} || ${pkDeath.map(s => s.text).join(' | ')}`);
    // the killer says nothing as a witness (its target is the victim)
    W.resetWitnessForTest();
    const killerSaid = (() => {
        place(victim, 2600, 3150);
        place(w1, 2601, 3150);
        place(w2, 2640, 3150);
        tick(3);
        W.readyForTest(w1);
        // (w1 hit it: 274's hero points)
        victim.heroPoints.addHero(w1.hash64, 5);
        const from = said.length;
        const hp = victim.levels[lib.PlayerStat.HITPOINTS];
        victim.levels[lib.PlayerStat.HITPOINTS] = 0;
        tick(30);
        victim.levels[lib.PlayerStat.HITPOINTS] = hp;
        victim.heroPoints.clear();
        return said.slice(from).filter(s => s.name === w1.username);
    })();
    check('P7: its killer is no witness', killerSaid.length === 0, killerSaid.map(s => `${s.kind}: ${s.text}`).join(' | '));
    W.setWitnessRatesForTest(null);
}

// P7: a drop announced: "lucky", or "what did u get" and the bragger's answer
{
    scene(SEED, 'witness-drop');
    W.resetWitnessForTest();
    const [bragger, near] = [bots[3], bots[4]];
    place(bragger, 2560, 3200);
    place(near, 2562, 3200);
    tick(3);
    W.readyForTest(near);
    W.setWitnessRatesForTest({ drop: 1, dropAsk: 0 });
    let from = said.length;
    W.dropBrag(bragger, 'omg rune med', 'rune med');
    tick(60);
    const reply = said.slice(from).filter(s => s.name === near.username && s.to === bragger.username);
    W.readyForTest(near);
    W.setWitnessRatesForTest({ drop: 1, dropAsk: 1 });
    from = said.length;
    W.dropBrag(bragger, 'nice drop!!', 'rune med');
    tick(90);
    const ask = said.slice(from).find(s => s.name === near.username && s.to === bragger.username);
    // (its answer in its own style: "just rune mmed lol", a typo and all)
    const named = said.slice(from).find(s => s.name === bragger.username && s.to === near.username && /rune/i.test(s.text)) && W.witnessLog.some(w => w.event === 'drops-answer' && w.name === bragger.username);
    W.setWitnessRatesForTest(null);
    check('P7: a drop announced near gets "lucky"; one that does not name it "what did u get", and the bragger names it', reply.length === 1 && ask && named, `${reply.map(s => s.text).join(' | ')} || ${said.slice(from).map(s => s.text).join(' / ')}`);
}

// P7: the human's dance: a reaction, never two within a minute; a statement now and then a response by its class
{
    scene(SEED, 'react-human');
    W.resetWitnessForTest();
    W.setWitnessRatesForTest({ human: 1, respond: 1 });
    const human = sim.human;
    sim.teleportHuman(2500, 3300);
    const [a, b] = [bots[5], bots[6]];
    place(a, 2502, 3300);
    place(b, 2498, 3301);
    tick(3);
    W.readyForTest(a);
    W.readyForTest(b);
    const from = said.length;
    const first = W.reactToHuman(human, 'react-dance', human.x, human.z, human.level);
    tick(20);
    W.readyForTest(a);
    W.readyForTest(b);
    const second = W.reactToHuman(human, 'react-emote', human.x, human.z, human.level);
    tick(100);
    W.readyForTest(a);
    W.readyForTest(b);
    const third = W.reactToHuman(human, 'react-wild', human.x, human.z, human.level);
    tick(40);
    const toHuman = said.slice(from).filter(s => s.to === human.username && s.kind === 'reaction');
    const logged = W.witnessLog.filter(w => w.event.startsWith('react-') && w.about === human.username);
    check('P7: the human\'s doings get a reaction to it, never two within a minute (a dance, then 20 ticks later nothing, a minute later the Wilderness)', first && !second && third && logged.length === 2 && toHuman.length >= 2, `${logged.map(w => w.event).join(', ')}: ${toHuman.map(s => s.text).join(' | ')}`);
    // a statement said near: a response that fits its class
    W.readyForTest(a);
    W.readyForTest(b);
    const from2 = said.length;
    const noted = lib.Chatter.talkStats().responses.length;
    W.respondTo(a, 'complaint');
    tick(40);
    const resp = said.slice(from2).filter(s => s.name === b.username);
    const last = lib.Chatter.talkStats().responses.slice(noted);
    const fits = resp.length === 1 && last.length === 1 && last[0].cls === 'complaint' && L.responseFits({ c: 'response', after: last[0].after ?? undefined }, 'complaint');
    check('S2-6: a complaint said near now and then gets a response that fits its class ("tell me about it"), never another response', fits, `${resp.map(s => s.text).join(' | ')} (${JSON.stringify(last[0] ?? null)})`);
    W.setWitnessRatesForTest(null);
    sim.teleportHuman(3300, 3000);
}

// WEAR-11: a partyhat at a bank gets a comment; a full set put on is shown off
{
    scene(SEED, 'gear');
    W.resetWitnessForTest();
    W.setWitnessRatesForTest({ gear: 1, show: 1 });
    const [wearer, looker, shower] = [bots[7], bots[8], bots[9]];
    place(wearer, 3185, 3441);
    place(looker, 3187, 3442);
    place(shower, 3183, 3440);
    lib.wearItems(wearer, [lib.ObjType.getId('red_partyhat')]);
    tick(3);
    for (const b of [wearer, looker, shower]) W.readyForTest(b);
    let from = said.length;
    tick(120);
    const comment = said.slice(from).find(s => s.to === wearer.username && /phat|partyhat|rich|hat/.test(s.text.toLowerCase()));
    const gearDebug = `${JSON.stringify(W.notableGearOf(wearer))} log ${JSON.stringify(W.witnessLog.slice(-3))} near ${said.slice(from).map(s => `${s.name}>${s.to}: ${s.text}`).slice(0, 4).join(' | ')}`;
    // the shower: its kit noted at a look, then a full addy set put on
    W.readyForTest(shower);
    tick(60);
    lib.wearItems(shower, ['adamant_full_helm', 'adamant_platebody', 'adamant_platelegs'].map(n => lib.ObjType.getId(n)));
    from = said.length;
    tick(120);
    const show = said.slice(from).find(s => s.name === shower.username);
    W.setWitnessRatesForTest(null);
    wearer.getInventory(lib.InvType.WORN).delete(0);
    check('WEAR-11: a partyhat worn at a bank gets a word from a bot near ("nice phat"), to its wearer', !!comment, comment?.text ?? gearDebug);
    check('WEAR-11: a full set put on is shown off ("finally full addy")', !!show && /addy/.test(show.text.toLowerCase()), show?.text ?? 'none');
}

// P8: clique banter: mates together talk; each clique its own in-joke
{
    scene(SEED, 'banter');
    const [a, b] = [bots[10], bots[11]];
    C.setCliquesForTest([[a.username, b.username]]);
    C.setCliqueBehaviourForTest(true);
    C.setBanterGapForTest(40);
    place(a, 2450, 3050);
    place(b, 2452, 3051);
    tick(3);
    T.resetThreadsForTest();
    const from = said.length;
    tick(500);
    const between = said.slice(from).filter(s => (s.name === a.username && s.to === b.username) || (s.name === b.username && s.to === a.username));
    const talk = between.filter(s => !/^(hey|hi|yo|sup|o hey|wassup|heya)\b/i.test(s.text));
    C.setCliqueBehaviourForTest(false);
    C.setBanterGapForTest(null);
    C.setCliquesForTest(null);
    check('P8: two clique mates together talk (a word to the other, an answer, a thread), every line whole', talk.length >= 3 && talk.every(s => clean(s.text)), talk.slice(0, 6).map(s => `${s.name.slice(0, 6)}: ${s.text}`).join(' / '));
    const cliques = C.allCliques().slice(0, 30);
    const jokes = cliques.map(c => C.inJokeOf(c.names));
    check('P8: a clique\'s in-joke comes from its names: the same every time, cliques\' differ (8+ kinds among 30)', cliques.every((c, i) => C.inJokeOf(c.names) === jokes[i]) && new Set(jokes).size >= 8, `${new Set(jokes).size} of ${cliques.length}`);
}

// (the variety work, round 2, the fixes: B1) upstream's answers keep their words: a question back is a line of its own
{
    scene(SEED, 'fixes-upstream');
    const chatResponses = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data/chat_responses.json'), 'utf8'));
    const how = new Set(chatResponses.intents.find(i => i.id === 'how').replies.map(r => r.text));
    const [p, q] = [bots[0], bots[1]];
    const asked = lib.answerFor('how are you', p, q);
    const own = lib.answerFor('whats ur combat', p, q);
    check('B1: an answer drawn from upstream\'s chat_responses.json is marked (word for word); the port\'s own is not', asked?.upstream === true && how.has(asked.text) && own !== null && !own.upstream, `${JSON.stringify(asked)} / ${JSON.stringify(own)}`);
    const roll = lib.chatDice.roll;
    lib.chatDice.roll = () => 0;
    let replies = 0;
    let verbatim = 0;
    let alone = 0;
    let plain = 0;
    const shown = [];
    for (let i = 0; i < 4; i++) {
        const [a, b] = [bots[2 + 2 * i], bots[3 + 2 * i]];
        place(a, 2650 + 30 * i, 3160);
        place(b, 2652 + 30 * i, 3161);
        tick(3);
        const from = said.length;
        lib.BotChat.onBotLine(a, 'how are you?', 'idle');
        tick(160);
        const theirs = said.slice(from).filter(s => s.name === b.username && s.to === a.username);
        if (!theirs.length) continue;
        replies++;
        if (how.has(theirs[0].text)) verbatim++;
        // (one with no question of its own: "u?" after it, a line of its own, when it asks back)
        if (!T.COUNTER_RX.test(theirs[0].text.trim())) {
            plain++;
            if (theirs[1] && lib.BOT_CHAT_LINES.askBackAlone.includes(theirs[1].text)) alone++;
        }
        shown.push(said.slice(from).filter(s => (s.name === a.username || s.name === b.username) && s.to !== null).map(s => s.text).join(' / '));
    }
    lib.chatDice.roll = roll;
    check('B1: a bot\'s "how are you?" to a bot gets upstream\'s answer word for word ("I\'m alright"), its question back a line of its own ("u?"), never "I\'m alright and u?"', replies >= 3 && verbatim === replies && alone === plain, `${verbatim} of ${replies} verbatim, ${alone} of ${plain} asked back alone: ${shown.join(' | ')}`);
}

// (the fixes, B3) an exchange near the human (port/BotStage): each turn in the place of a line of its speaker's own
{
    scene(SEED, 'fixes-stage');
    const pair = bots.filter(p => lib.personaOf(p.username, p.botPlanner).sociability >= 0.35).slice(0, 2);
    if (pair.length === 2) {
        sim.teleportHuman(2950, 3040);
        place(pair[0], 2952, 3042);
        place(pair[1], 2953, 3042);
        tick(3);
        const debt0 = pair.map(p => lib.Chatter.chatterStateOf(p)?.debt ?? 0);
        const from = said.length;
        const roll = lib.chatDice.roll;
        lib.chatDice.roll = () => 0;
        tick(300);
        lib.chatDice.roll = roll;
        const turns = said.slice(from).filter(s => s.kind === 'practice' && pair.some(p => p.username === s.name));
        const owed = pair.map((p, i) => (lib.Chatter.chatterStateOf(p)?.debt ?? 0) - debt0[i]);
        const each = pair.map(p => Math.min(6, turns.filter(s => s.name === p.username).length));
        check('B3: an exchange near the human: each turn in the place of a line of its speaker\'s own (its debt one more a turn)', turns.length >= 2 && owed.every((n, i) => n === each[i]), `${turns.map(s => s.text).join(' / ')}; owed ${owed.join(', ')} for ${each.join(', ')}`);
        for (const p of pair) place(p, 2600 + Math.floor(Math.random() * 40), 3300);
        sim.teleportHuman(3300, 3000);
    } else check('B3: two sociable bots for the exchange', false);
}

// (the fixes, B7) the players standing near count among a place's voices, not only those who spoke in the hour
{
    V.resetVoiceForTest();
    const [loud, ...others] = bots.slice(20, 26);
    const [x, z] = [2350, 3400];
    place(loud, x, z);
    tick(2);
    const t0 = World.currentTick;
    // 30 lines in the hour: 9 of them loud's (30 %), the rest two others': 3 voices
    for (let i = 0; i < 30; i++) V.noteVoice(i < 9 ? loud.username : `quiet${i % 2}`, x + (i % 5), z, 0, t0 - 100 + i);
    const alone = V.voiceRoom(loud, t0);
    for (const [i, o] of others.entries()) place(o, x + 2 + i, z + 2);
    tick(2);
    const crowd = V.voiceRoom(loud, World.currentTick);
    check('B7: three voices in the hour and nobody else here: free; five more players standing near: held (a fair share of the voices present)', alone && !crowd, { alone, crowd });
    for (const [i, o] of [loud, ...others].entries()) place(o, 2600 + 3 * i, 3350);
    V.resetVoiceForTest();
}

// (the fixes, B5) a members or novelty piece gets its own words ("nice glory", "lol mime"), never armour's or wealth's
{
    const kinds = ['members-glory', 'members-helm', 'members', 'novelty-mime', 'novelty-holy', 'novelty'];
    const gearLines = L.NEW_LINES.filter(l => l.tag.event === 'witness-gear');
    const fits = kind => gearLines.filter(l => !l.tag.kinds || L.kindFits(l.tag.kinds, kind)).map(l => l.text);
    const wrong = kinds.flatMap(k => fits(k).filter(t => /armour|rich|gear/.test(t)).map(t => `${k}: ${t}`));
    const own = kinds.every(k => fits(k).some(t => !t.includes('{item}')));
    check('B5: the members and novelty pieces\' gear lines: their own words for each ("nice glory", "lol mime"), none of armour or wealth', wrong.length === 0 && own && fits('members-glory').includes('nice glory') && fits('novelty-mime').includes('lol mime') && fits('trim').includes('nice armour'), wrong.join('; '));
}

check('no errors', errors.length === 0, errors.slice(0, 3).join(' | '));

// ---- report ----
let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
out(`threads: ${failed ? `${failed} of ${checks.length} failed` : `all ${checks.length} passed`}`);
process.exit(failed ? 1 : 0);
