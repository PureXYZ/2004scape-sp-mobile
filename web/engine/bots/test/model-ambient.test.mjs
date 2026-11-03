#!/usr/bin/env node
// The model for the bots' own talk (bots ideas round 4, theme I stage 1: port/BotModelAmbient, BotThreads' and BotChat's
// marked blocks, port/BotModel's ambient asks, port/BotModelGuard's ambient checks), in the real 274 world
// (members, a few aged bots; the director, the cliques' doings, habits, hang-outs, the arena, random events, trains,
// alching, scams, witnesses, teleport spells and theme H's moves off), each scene on its own dice (test/lib/dice.mjs
// scene), the bots held with stand tasks in an open field, the library's stub model (port/BotModel setModelForTest) with
// Settings › Bot chat › Bots' own talk on Model unless a scene says otherwise:
//   guard     the ambient checks: a line that drops the rules' counter-question ("41 u?") or one of their numbers is
//             refused ('counter', 'numbers'), and passes without the ambient flag; (round 4 fixes, M6) so is one that adds
//             a counter-question the rules did not ask ("ps2 i think, u?"); the guard's counter rule is BotThreads'
//             COUNTER_RX
//   far       a thread 30 tiles from the human: no request, every turn the rules' ('far' counted)
//   near      a thread 10 tiles from the human (the 20 s pace off): one request per turn after the opener, none for the
//             openers and the closer, each said in the stub's words (kind 'practice', to the partner), marked ambient in
//             the log ('thread', the partner's last line its heard, the rules' turn its hint, a counter kept), no later
//             than the rules' time + 4; the replies' own numbers (MD1-MD6's) untouched
//   answer    a bot's question near the human: the answer to it in the stub's words ('botanswer'), the asker's "ty" or
//             counter turn the rules'
//   pacing    two lines due within 20 s: the second the rules' with no request ('pacing'); one with a request in flight
//             too ('inflight'); 34 ticks on, a request again
//   human     a reply to the human asked while an ambient request is in flight goes out and is answered; the human's
//             line to the very bot waiting on the model: the rules' line said (superseded), and its reply to the human
//   cap       (round 4 fixes, M3) an ambient request in flight is not counted toward the replies' MAX_IN_FLIGHT (3): three
//             replies to the human go out with it, a fourth is 'busy'
//   hold      (round 4 fixes, M5) a line to the human through sayTyped (the vendor's answer, "sry was afk") while the bot
//             waits on the model: its ambient line falls back (superseded) to the rules' line at its rules' time, and the
//             line to the human is typed from there, not from the model's deadline (rules' time + 4)
//   counter   a stub line without the rules' counter-question: the rules' line is said ('guard', reason 'counter')
//   silent    a stub that never answers: the rules' line by its rules' time + 4 ('deadline'), the thread goes on
//   online    with Chat model Claude online (a key): ambient requests carry mode 'local' and ambient: true, the
//             replies to the human mode 'online' and no ambient; the outcome log line marked "(ambient)", no words
//   off       Bots' own talk on Rules (and no model at all): no request, ambientWords false, no dice drawn; the same
//             with the setting on but far from the human; the mod bot's lines never the model's
// (bots ideas, round 5: I stage 2, the reactions to the human)
//   golden    renderLocal of every situation of the round 2 model's data (phase7-data-r2: situations, eval, target; not
//             published: PHASE7_DATA_R2 or --golden-data; skipped when absent)
//             byte for byte as the engine rendered them before the reactions (test/data/model-golden-r2.json); a reply's prompt and the
//             same situation as a reaction: only the task and the chat's end differ
//   reaction  the reactions' switch on: a dance (port/BotWitness) and a level-up (port/BotReactions) near the human, each
//             one ambient request ('reaction'), its prompt "Say one short chat line to {name}." and its chat ending
//             "({name} is dancing)" / "({name} levelled woodcutting to N)" and the answer idea, said in the stub's words
//             to the human (kind 'reaction')
//   reactoff  the switch forced off (AMBIENT_REACTIONS ships true since r3): a dance and a level-up near the human with the model and Bots' own talk
//             on: the rules' lines, no request, nothing told to the capture's listeners; ambientWords for a reaction
//             false, no dice
//   refusal   (round 5 ship) the guard's false refusals, the checker (model-data/checks.mjs) agreeing: a reaction may name
//             the human's own combat ("lol lvl 14 in the wildy" at the ditch), any other number stays a claim ('level');
//             a question about following ("why u follow me", "u following me?") is no promise, "follow me", "ill follow
//             u", "come with me" are
//   role      the guard keeps a reaction's role: a thanks ("ty", "thx", "np") or "wat u want" / "who is u" refused
//             ('role'), a gz with the event's level passes; not without the ambient flag, nor for a thread's turn; a stub
//             that thanks: the rules' line said
//   first     a reaction (an emote) decided in the tick a thread's turn was asked goes first (the turn superseded: its rules' line);
//             one a tick later waits ('inflight', 'pacing')
//   errors    none
//
//   node --expose-gc web/engine/bots/test/model-ambient.test.mjs [--seed=5] [--only=guard,far,...] [--golden-data=DIR]
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';
import { mulberry, scene } from './lib/dice.mjs';
import { checkReply } from './model-data/checks.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const SEED = Number(args.seed ?? 5);
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const want = name => !ONLY || ONLY.has(name);
const out = (s = '') => process.stdout.write(s + '\n');
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
const errors = [];
for (const level of ['log', 'info', 'debug', 'warn']) console[level] = () => {};
console.error = (...a) => {
    const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
    if (!text.includes('ExperimentalWarning') && !text.includes('--trace-warnings')) errors.push(text.slice(0, 400));
};
Math.random = mulberry(SEED);

const engineDir = prepareEngineClone('model-ambient', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/ambient.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, BotChat, Ambient: A, BotModelNs: BM, BotModelGuardNs: G, Threads: T, Minimap: M } = lib;

const N = 30;
const sim = await lib.Sim.create({ bots: N, members: true, debug: false, ageNewBots: true, humanName: 'casey' });
sim.addHuman(3222, 3218, 0);
const human = sim.human;
while (sim.bots().length < N && World.currentTick < 80) sim.tick();
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
lib.setD2OffersForTest(false);
lib.setLingerForTest(false);
lib.setTeleportRatesForTest({ teleporter: false });
// (a named line's reply is the model's unless a rude talker answers it rudely: those stay the rules')
lib.setRudeRatesForTest({ reply: 0 });
M.setMovementRatesForTest(M.MOVEMENT_OFF);
for (let i = 0; i < 40; i++) sim.tick();
const all = sim.bots();
check(`${N} bots in the world`, all.length === N, all.length);
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const said = [];
lib.sayListeners.push((player, text, kind, to) => said.push({ t: World.currentTick, name: player.username, text, kind, to: to?.username ?? null }));
const tick = (n = 1) => {
    for (let i = 0; i < n; i++) sim.tick();
};

const STAND = { name: 'Idle', reset() {}, interrupt() {}, interrupted: false, shouldRun: () => true, isComplete: () => false, tick() {}, activityStep: () => null };
/** the bot held with a stand task (its sub-task cleared), full HP */
function hold(p) {
    const ai = sim.botPlayer(p);
    ai.currentTask = Object.assign(Object.create(STAND), { name: 'Idle', interrupted: false, tick: () => {} });
    ai.planEnds = World.currentTick + 1e6;
    if (ai.hasSubTask()) {
        ai._interruptSubTask?.();
        ai._dropSubTask?.();
    }
    p.levels[3] = p.baseLevels[3];
    p.runenergy = 10000;
    p.afkEventReady = false;
}
const place = (p, x, z) => {
    p.closeModal();
    p.clearWaypoints();
    p.clearInteraction();
    p.teleJump(x, z, 0);
};
for (const p of all) hold(p);
// (the talkers: sociable levelling bots, no newbies, none a clique mate of another, no mod)
const talkers = all.filter(p => lib.isLevelling(p.botPlanner) && !lib.isNewbie(p) && p.staffModLevel === 0 && lib.personaOf(p.username, p.botPlanner).sociability >= 0.2);
let next = 0;
/** two bots, the next of the talkers in turn (the thread scenes come first: fresh pairs, no pair's memory of a topic) */
const pair = () => {
    const out = [];
    for (let i = 0; out.length < 2 && i < talkers.length; i++) {
        const p = talkers[next++ % talkers.length];
        if (!out.includes(p) && !out.some(q => lib.BotCliques.sameClique(q.username, p.username))) out.push(p);
    }
    return out;
};
check('enough talkers for the scenes (8+)', talkers.length >= 8, talkers.length);
/** an open, flat field (west of Lumbridge's windmill road) */
const FIELD = [3160, 3240];
const open = (x, z, w = 14) => {
    for (let i = 0; i <= w; i++) if (!sim.isWalkable(x + i, z, 0)) return false;
    return true;
};
let base = null;
for (let dz = 0; dz < 30 && !base; dz += 2) for (let dx = 0; dx < 30 && !base; dx += 3) if (open(FIELD[0] + dx, FIELD[1] + dz) && open(FIELD[0] + dx, FIELD[1] + dz + 3)) base = [FIELD[0] + dx, FIELD[1] + dz];
check('an open field for the scenes', base !== null, base);
const humanAt = (dx, dz = 0) => {
    sim.teleportHuman(base[0] + dx, base[1] + dz, 0);
    tick(1);
};
/** the scene's bots quiet (their next line of their own put off), out of any thread, typing nothing, nothing in flight */
const settle = (...bots) => {
    for (const p of bots) lib.quietForTest(p);
    for (let t = 0; t < 120; t++) {
        if (bots.every(p => !T.inThread(p) && !BotChat.midTalk(p)) && BM.modelRequestsInFlight() === 0) return true;
        tick();
    }
    return false;
};

// ---- the model: the stub with Bots' own talk as a scene asks; every request the channel saw ----
let sent = [];
/** the stub (or a model of the scene's own), Bots' own talk on `ambient`, the requests recorded */
function model(stub = 'stub', opts = {}) {
    BM.setModelForTest(stub, { latencyTicks: 2, failRate: 0, plantRate: 0, ambient: true, ...opts });
    const channel = BM.modelChannel();
    sent = [];
    BM.setModelChannel(msg => {
        sent.push(msg);
        channel(msg);
    });
    A.setAmbientRatesForTest({ gap: opts.gap ?? 0 });
}
const ambientLog = () => BM.modelStats.log.filter(e => e.ambient);

/** a thread a opens with b, drawn here (its lines known) and begun; the turns said, in order */
function thread(a, b, depth = 4) {
    T.resetThreadsForTest();
    let lines = null;
    for (let i = 0; i < 8 && !lines; i++) lines = T.drawThread(a, b, depth);
    if (!lines) return null;
    const from = said.length;
    T.begin(a, b, lines, World.currentTick, true);
    for (let t = 0; t < 200; t++) {
        tick();
        if (!T.inThread(a) && World.currentTick - (said.at(-1)?.t ?? 0) > 6) break;
    }
    const turns = said.slice(from).filter(s => s.kind === 'practice' && ((s.name === a.username && s.to === b.username) || (s.name === b.username && s.to === a.username)));
    return { lines, turns };
}
/** the turns a model may word: after the opener, no opener, no closer */
const wordable = lines => lines.filter((l, i) => i > 0 && !l.opener && !l.closer);

// ---- guard (the ambient checks) ----
if (want('guard')) {
    scene(SEED, 'guard');
    const [a, b] = pair();
    const s = lib.BotModelPromptNs.situationOf({ bot: a, to: b, heard: 'wc lvl?', channel: 'public', via: 'thread', greeted: false, intent: { id: 'thread', text: '41 u?' } });
    const amb = { ambient: true };
    const r1 = G.guardReply('41 lol', s, amb);
    const r2 = G.guardReply('ya 41 u?', s, amb);
    const s2 = { ...s, hint: { intent: 'thread', text: 'like 200k for a set' } };
    const r3 = G.guardReply('like 300k for a set', s2, amb);
    const r3b = G.guardReply('bout 200k for one', s2, amb);
    const s3 = { ...s, hint: { intent: 'thread', text: 'nice kat123 42 here' } };
    const r5 = G.guardReply('lol nice, 42 here', s3, amb);
    const r4 = G.guardReply('41 lol', s, {});
    // (round 4 fixes, M6) a counter-question the model added where the rules asked none
    const s4 = { ...s, hint: { intent: 'thread', text: 'ps2 i think' } };
    const r6 = G.guardReply('ps2 i think, u?', s4, amb);
    const r6b = G.guardReply('ya ps2 i think', s4, amb);
    const r6c = G.guardReply('ps2 i think, u?', s4, {});
    check("guard: the rules' counter-question dropped is refused ('counter'), kept passes", r1.ok === false && r1.reason === 'counter' && r2.ok === true, { r1, r2 });
    check("guard: a number of the rules' line missing is refused ('numbers'), kept passes", r3.ok === false && (r3.reason === 'numbers' || r3.reason === 'price') && r3b.ok === true, { r3, r3b });
    check("guard: a name's digits in the rules' line are no number to keep (\"kat123\")", r5.ok === true, r5);
    check('guard: without the ambient flag (a reply to the human) neither check applies', r4.ok === true, r4);
    check("guard (round 4 fixes, M6): a counter-question the rules did not ask, added by the model (\"ps2 i think, u?\"), is refused ('counter'); without one passes, and without the ambient flag too", r6.ok === false && r6.reason === 'counter' && r6b.ok === true && r6c.ok === true, { r6, r6b, r6c });
    check("guard: the counter rule is BotThreads' COUNTER_RX", G.AMBIENT_COUNTER_RX.source === T.COUNTER_RX.source && G.AMBIENT_COUNTER_RX.flags === T.COUNTER_RX.flags);
    check("guard: 'counter' and 'numbers' are GUARD_REASONS", G.GUARD_REASONS.includes('counter') && G.GUARD_REASONS.includes('numbers'));
}

// ---- far ----
if (want('far')) {
    scene(SEED, 'far');
    model();
    const [a, b] = pair();
    place(a, base[0], base[1]);
    place(b, base[0] + 2, base[1]);
    humanAt(32, 0);
    tick(2);
    const far0 = BM.modelStats.ambient.skipped.far ?? 0;
    const th = thread(a, b);
    const n = wordable(th?.lines ?? []).length;
    const reqs = sent.filter(m => m.ambient).length;
    // (the world's other bots' talk far from the human counts too)
    check('far: a thread 30 tiles from the human: said whole, no request, every wordable turn counted far', th && n > 0 && th.turns.length === th.lines.length && reqs === 0 && (BM.modelStats.ambient.skipped.far ?? 0) - far0 >= n, { turns: th?.turns.length, lines: th?.lines.length, reqs, far: (BM.modelStats.ambient.skipped.far ?? 0) - far0, n });
}

// ---- near ----
if (want('near')) {
    scene(SEED, 'near');
    model();
    const md0 = { eligible: BM.modelStats.eligible, requests: BM.modelStats.requests };
    let done = null;
    // (a few pairs, until a thread has two or more turns a model may word)
    for (let tries = 0; tries < 4 && !done; tries++) {
        const [a, b] = pair();
        if (!b) break;
        place(a, base[0], base[1] + 6);
        place(b, base[0] + 2, base[1] + 6);
        humanAt(10, 6);
        tick(2);
        const log0 = ambientLog().length;
        const sent0 = sent.length;
        const th = thread(a, b, 5);
        if (th && wordable(th.lines).length >= 1) done = { a, b, th, entries: ambientLog().slice(log0), reqs: sent.slice(sent0).filter(m => m.ambient) };
    }
    check('near: a thread with a turn a model may word', !!done, done && done.th.lines.map(l => l.text));
    if (done) {
        const { a, b, th, entries, reqs } = done;
        const n = wordable(th.lines).length;
        const asked = th.lines.map((l, i) => i > 0 && !l.opener && !l.closer);
        check('near: one request per turn after the opener (none for the openers and the closer), all ambient and local', reqs.length === n && entries.length === n && reqs.every(m => m.mode === 'local' && m.ambient === true), { n, reqs: reqs.length, entries: entries.length, opener: th.lines.map(l => !!l.opener), closer: th.lines.map(l => !!l.closer) });
        check('near: the thread said whole, turn by turn, to the partner', th.turns.length === th.lines.length && th.turns.every((t, i) => t.name === th.lines[i].speaker.username && t.to === th.lines[i].to.username), th.turns.map(t => `${t.name}: ${t.text}`));
        // each wordable turn said in the stub's words: the rules' line (lower-cased) in one of its forms, styled after
        const used = entries.filter(e => e.outcome === 'used');
        check("near: each in the stub's words (outcome used, said)", used.length === n && used.every(e => typeof e.said === 'string' && e.said.length > 0), entries.map(e => `${e.outcome} ${e.raw} -> ${e.said}`));
        const firstAsked = th.lines.findIndex((l, i) => asked[i]);
        const e0 = entries[0];
        check("near: the log entry: via 'thread', the partner's last line its heard, the rules' turn its hint (ruleText), its rules' due", e0 && e0.via === 'thread' && e0.bot === th.lines[firstAsked].speaker.username && e0.heard === th.turns[firstAsked - 1].text && typeof e0.rulesDue === 'number' && typeof e0.ruleText === 'string', e0);
        const late = entries.map(e => e.saidAt - e.rulesDue);
        check("near: no line later than its rules' time + 4 (LM8)", late.every(d => d <= 4), late);
        check('near: a counter-question of the rules kept in the words said', entries.filter(e => e.counter).every(e => G.AMBIENT_COUNTER_RX.test(String(e.raw).trim())), entries.filter(e => e.counter).map(e => e.raw));
        check("near: the replies' own numbers untouched (MD1-MD6: eligible, requests), the ambient ones counted apart", BM.modelStats.eligible === md0.eligible && BM.modelStats.requests === md0.requests && BM.modelStats.ambient.requests >= n && BM.modelStats.ambient.used >= n, { md: [BM.modelStats.eligible, BM.modelStats.requests], ambient: BM.modelStats.ambient });
        void a;
        void b;
    }
}

// ---- answer (a bot's answer to a bot's question) ----
if (want('answer')) {
    scene(SEED, 'answer');
    model();
    const [asker, bot] = pair();
    place(asker, base[0], base[1] + 12);
    place(bot, base[0] + 2, base[1] + 12);
    humanAt(8, 12);
    tick(3);
    const roll = lib.chatDice.roll;
    lib.chatDice.roll = () => 0.01; // (the answer's chances: someone answers; the stub's own choices are hashes)
    const log0 = ambientLog().length;
    const from = said.length;
    BotChat.onBotLine(asker, 'whats ur wc lvl?', 'idle');
    tick(40);
    lib.chatDice.roll = roll;
    const entries = ambientLog().slice(log0);
    const lines = said.slice(from).filter(s => s.kind === 'botreply');
    const answer = entries.find(e => e.via === 'botanswer');
    check("answer: a bot's answer to a bot's question near the human: one request ('botanswer', the question its heard), said in the stub's words", answer && answer.heard === 'whats ur wc lvl?' && answer.outcome === 'used' && lines.some(l => l.name === answer.bot && l.text === answer.said), { entries: entries.map(e => `${e.via} ${e.outcome} "${e.heard}" -> ${e.said}`), lines: lines.map(l => `${l.name}: ${l.text}`) });
    check("answer: the asker's ty or its own answer back the rules' (one request only)", entries.length === 1 && lines.length >= 2, { entries: entries.length, lines: lines.map(l => `${l.name}: ${l.text}`) });
}

/** a line of the bots' own talk as a thread's turn would ask it (to b, kind 'practice'); what then() saw */
function ask(a, b, hint, opts = {}) {
    const got = { then: null };
    const ok = A.ambientWords({ kind: 'thread', bot: a, partner: b, heard: opts.heard ?? 'wc lvl?', hint, ruleText: hint, extra: opts.extra ?? 2 }, { to: b, kind: 'practice', then: () => (got.then = World.currentTick) });
    return { ok, got, at: World.currentTick };
}

// ---- pacing ----
if (want('pacing')) {
    scene(SEED, 'pacing');
    model('stub', { gap: A.AMBIENT_GAP_TICKS });
    const [a, b] = pair();
    place(a, base[0], base[1] + 18);
    place(b, base[0] + 2, base[1] + 18);
    humanAt(6, 18);
    tick(2);
    const sk = () => ({ ...BM.modelStats.ambient.skipped });
    const s0 = sk();
    const first = ask(a, b, 'cutting willows');
    const inflight = ask(b, a, 'same lol');
    tick(8);
    const reqs1 = sent.filter(m => m.ambient).length;
    const from = said.length;
    const second = ask(b, a, 'nice');
    tick(20);
    const s1 = sk();
    const secondSaid = said.slice(from).find(s => s.name === b.username);
    check("pacing: the first line asked; a second while it is in flight the rules' ('inflight')", first.ok && !inflight.ok && (s1.inflight ?? 0) - (s0.inflight ?? 0) === 1, { first: first.ok, inflight: inflight.ok, s0, s1 });
    check("pacing: a line due within 20 s of the last request: the rules' line, no request ('pacing')", !second.ok && reqs1 === 1 && sent.filter(m => m.ambient).length === 1 && (s1.pacing ?? 0) - (s0.pacing ?? 0) === 1 && secondSaid === undefined, { second: second.ok, reqs: sent.filter(m => m.ambient).length, pacing: (s1.pacing ?? 0) - (s0.pacing ?? 0) });
    tick(Math.max(0, A.lastAmbientAskForTest() + A.AMBIENT_GAP_TICKS - World.currentTick));
    const third = ask(a, b, 'gl');
    check('pacing: 34 ticks (20 s) after the last request, a request again', third.ok && sent.filter(m => m.ambient).length === 2, { third: third.ok, gapWas: third.at - first.at });
    tick(20);
}

// ---- human (replies to the human first) ----
if (want('human')) {
    scene(SEED, 'human');
    model('stub', { latencyTicks: 8 });
    const [a, b] = pair();
    const [c] = pair();
    place(a, base[0], base[1] + 24);
    place(b, base[0] + 2, base[1] + 24);
    place(c, base[0] + 4, base[1] + 24);
    humanAt(5, 24);
    tick(3);
    settle(a, b, c);
    // another bot's reply to the human, asked while an ambient one is in flight
    const amb = ask(a, b, 'cutting willows');
    const inFlight = BM.modelRequestsInFlight();
    const from = said.length;
    BotChat.onPublicMessage(human, `${c.displayName} whats ur cb`);
    tick(2);
    const replyReq = sent.find(m => !m.ambient);
    tick(40);
    const reply = said.slice(from).find(s => s.name === c.username && s.to === human.username);
    check('human: a reply to the human asked while an ambient request is in flight goes out (not ambient) and is answered', amb.ok && inFlight === 1 && replyReq && !replyReq.ambient && reply, { amb: amb.ok, inFlight, replyReq: !!replyReq, reply: reply?.text });
    // the human talks to the very bot waiting on the model (a slow one): its rules' line still said (superseded), and its reply
    model('stub', { latencyTicks: 30 });
    tick(A.AMBIENT_GAP_TICKS);
    settle(a, b, c);
    const from2 = said.length;
    const log0 = ambientLog().length;
    const amb2 = ask(a, b, 'cutting willows', { extra: 3 });
    BotChat.onPublicMessage(human, `${a.displayName} whats ur cb`);
    tick(60);
    const e = ambientLog().slice(log0)[0];
    const aLines = said.slice(from2).filter(s => s.name === a.username);
    check("human: the human's line to the bot waiting on the model: its ambient line falls back (superseded) to the rules' line, said, and the bot answers the human", amb2.ok && e?.outcome === 'superseded' && aLines.some(l => l.to === b.username && l.text === 'cutting willows') && aLines.some(l => l.to === human.username), { outcome: e?.outcome, lines: aLines.map(l => `${l.to}: ${l.text}`) });
}

// ---- (round 4 fixes, M3) cap: the bots' own talk is not counted toward the replies' MAX_IN_FLIGHT ----
/** a reply to the human as port/BotChat asks it (named, the rules' "hey"), straight to askModel; how it went */
function askReply(bot) {
    const got = { reason: null, used: null };
    const situation = lib.BotModelPromptNs.situationOf({ bot, to: human, heard: `${bot.displayName} hi`, channel: 'public', via: 'named', greeted: false, intent: { id: 'greeting', text: 'hey' } });
    BM.askModel({
        bot,
        to: human,
        via: 'named',
        intent: 'greeting',
        candidate: false,
        heard: `${bot.displayName} hi`,
        situation,
        local: lib.BotModelPromptNs.renderLocal(situation),
        online: lib.BotModelPromptNs.renderOnline(situation),
        ruleText: 'hey',
        deadline: World.currentTick + BM.MODEL_DEADLINE_TICKS,
        keepName: true,
        use: text => void (got.used = text),
        fallback: reason => {
            got.reason = reason;
            return 'hey';
        }
    });
    return got;
}
if (want('cap')) {
    scene(SEED, 'cap');
    model('stub', { latencyTicks: 12 });
    const [a, b] = pair();
    const [c1, c2] = pair();
    const [c3, c4] = pair();
    place(a, base[0], base[1] + 22);
    place(b, base[0] + 2, base[1] + 22);
    humanAt(5, 22);
    tick(3);
    settle(a, b, c1, c2, c3, c4);
    const amb = ask(a, b, 'cutting willows');
    const inFlight0 = BM.modelRequestsInFlight();
    const sent0 = sent.length;
    const replies = [c1, c2, c3].map(askReply);
    const fourth = askReply(c4);
    const out = sent.slice(sent0).filter(m => !m.ambient).length;
    check(`cap: with an ambient request in flight, ${BM.MAX_IN_FLIGHT} replies to the human go out (none 'busy'), the next one is 'busy'`, amb.ok && inFlight0 === 1 && replies.every(r => r.reason === null) && out === BM.MAX_IN_FLIGHT && fourth.reason === 'busy', { amb: amb.ok, inFlight0, replies: replies.map(r => r.reason), out, fourth: fourth.reason });
    tick(40);
    check('cap: the replies and the ambient line settled', replies.every(r => typeof r.used === 'string' || (r.reason !== null && r.reason !== 'busy')) && BM.modelRequestsInFlight() === 0, { replies: replies.map(r => r.used ?? r.reason), inFlight: BM.modelRequestsInFlight() });
    tick(A.AMBIENT_GAP_TICKS);
}

// ---- (round 4 fixes, M5) hold: a line to the human said through sayTyped while the bot waits on the model ----
if (want('hold')) {
    scene(SEED, 'hold');
    model('stub', { latencyTicks: 30 });
    const [a, b] = pair();
    place(a, base[0], base[1] + 25);
    place(b, base[0] + 2, base[1] + 25);
    humanAt(5, 25);
    tick(3);
    settle(a, b);
    const from = said.length;
    const log0 = ambientLog().length;
    const amb = ask(a, b, 'cutting willows', { extra: 3 });
    tick(1);
    const e = ambientLog().slice(log0)[0];
    const pending = e?.outcome === 'pending';
    // (the line's typing time on a die of the test's own, the same in sayTyped and here)
    const real = Math.random;
    Math.random = () => 0.5;
    const typing = lib.typingTicks(lib.botPersona(a), 'sry was afk', { busy: lib.isBusy(a), random: () => 0.5 });
    lib.sayTyped(a, 'sry was afk', { to: human, kind: 'reply' });
    Math.random = real;
    tick(40);
    const aLines = said.slice(from).filter(s => s.name === a.username);
    const rules = aLines.find(l => l.to === b.username);
    const afk = aLines.find(l => l.to === human.username);
    // (a line due at tick T is heard in T - 1's world tick or T's: `early`, the same for both lines)
    const early = rules ? e.rulesDue - rules.t : null;
    check("hold: a line to the human while the bot waits on the model: its ambient line falls back (superseded) to the rules' line at its rules' time, and the line to the human is typed from there (the rules' time + its typing), not from the deadline (+ 4)", amb.ok && pending && e.outcome === 'superseded' && rules?.text === 'cutting willows' && (early === 0 || early === 1) && afk?.text === 'sry was afk' && afk.t === e.rulesDue + typing - early, { pending, outcome: e?.outcome, rulesDue: e?.rulesDue, rules: rules && [rules.t, rules.text], afk: afk && [afk.t, afk.text], typing, deadline: e && e.rulesDue + A.AMBIENT_SLACK_TICKS });
    // a line to another bot while it waits: no change (the ambient line still the model's to give)
    tick(A.AMBIENT_GAP_TICKS);
    settle(a, b);
    const log1 = ambientLog().length;
    const amb2 = ask(a, b, 'nice');
    lib.sayTyped(a, 'lol', { to: b, kind: 'botreply' });
    const e2 = ambientLog().slice(log1)[0];
    check('hold: a line to another bot leaves the ambient request waiting', amb2.ok && e2?.outcome === 'pending', { outcome: e2?.outcome });
    tick(60);
}

// ---- counter ----
if (want('counter')) {
    scene(SEED, 'counter');
    model((s, msg) => (msg.ambient ? '41 lol' : 'ok'));
    const [a, b] = pair();
    place(a, base[0], base[1] + 26);
    place(b, base[0] + 2, base[1] + 26);
    humanAt(6, 26);
    tick(2);
    // (round 4 fixes: the scene's bots quiet and nothing in flight first, as the human scene; only a's requests counted:
    // the world's own talk near the human may ask too, the 20 s pace being off here)
    settle(a, b);
    const log0 = ambientLog().length;
    const from = said.length;
    const why = A.ambientRefusal(a);
    const r = ask(a, b, '41 u?');
    tick(30);
    const entries = ambientLog().slice(log0);
    const e = entries.find(en => en.bot === a.username);
    const others = new Set(entries.filter(en => en.bot !== a.username).map(en => en.id));
    const asked = sent.filter(m => m.ambient && !others.has(m.id)).length;
    const line = said.slice(from).find(s => s.name === a.username);
    check("counter: a stub line without the rules' counter-question: refused ('counter'), the rules' line said", r.ok && e?.outcome === 'guard' && e.reason === 'counter' && line?.text === '41 u?' && r.got.then !== null, { ok: r.ok, why, outcome: e?.outcome, reason: e?.reason, line: line?.text });
    check("counter: no retry for the bots' own talk (one request)", asked === 1 && !e?.retried, { asked, sent: sent.length });
}

// ---- silent ----
if (want('silent')) {
    scene(SEED, 'silent');
    model(() => null, { failRate: 1 });
    const [a, b] = pair();
    place(a, base[0], base[1] + 28);
    place(b, base[0] + 2, base[1] + 28);
    humanAt(6, 28);
    tick(2);
    // (failRate 1: half the stub's requests never answer, half answer null: a few lines until one never answers)
    let found = null;
    for (let i = 0; i < 6 && !found; i++) {
        const log0 = ambientLog().length;
        const from = said.length;
        const r = ask(a, b, `gl with ${i + 40} wc`);
        tick(40);
        const e = ambientLog().slice(log0)[0];
        const line = said.slice(from).find(s => s.name === a.username);
        if (e?.outcome === 'deadline') found = { r, e, line, i };
        else tick(A.AMBIENT_GAP_TICKS);
    }
    check("silent: a stub that never answers: the rules' line at its rules' time + 4 at the latest ('deadline'), its then() after", found && found.line?.text === `gl with ${found.i + 40} wc` && found.e.saidAt <= found.e.rulesDue + A.AMBIENT_SLACK_TICKS && found.r.got.then === found.e.saidAt, found && { saidAt: found.e.saidAt, rulesDue: found.e.rulesDue, then: found.r.got.then, line: found.line?.text });
}

// ---- online ----
if (want('online')) {
    scene(SEED, 'online');
    model();
    BM.setModelMode({ mode: 'online', local: true, online: true, ambient: true });
    const logLines = [];
    BM.setModelOutcomeLog(line => logLines.push(line));
    const [a, b] = pair();
    place(a, base[0], base[1] + 30);
    place(b, base[0] + 2, base[1] + 30);
    humanAt(6, 30);
    tick(2);
    settle(a, b);
    const r = ask(a, b, 'cutting willows');
    tick(10);
    BotChat.onPublicMessage(human, `${b.displayName} whats ur cb`);
    tick(30);
    const amb = sent.find(m => m.ambient);
    const rep = sent.find(m => !m.ambient);
    check("online: with Claude online, an ambient request carries mode 'local' and ambient: true; a reply to the human mode 'online' and no ambient", r.ok && amb?.mode === 'local' && amb.ambient === true && rep?.mode === 'online' && !('ambient' in rep), { amb: amb && { mode: amb.mode, ambient: amb.ambient }, rep: rep && { mode: rep.mode, ambient: rep.ambient } });
    check("online: the ambient request carries no Claude prompt (never sent there)", amb && amb.online.system === '' && amb.online.user === '' && amb.local.system.includes('Reply to'), amb && { online: amb.online });
    const ambLine = logLines.find(l => l.includes('(ambient)'));
    check('online: the outcome log line is marked "(ambient)", with no words', ambLine && !ambLine.includes('willows') && /model #\d+ .* thread \(ambient\): /.test(ambLine), logLines);
    // the on-device model resting (the page: local false): no ambient, though Claude still writes the replies
    BM.setModelMode({ mode: 'online', local: false, online: true, ambient: true });
    tick(A.AMBIENT_GAP_TICKS);
    const resting = ask(a, b, 'nice');
    check("online: the on-device model resting (local false): the bots' own talk the rules' (no request), the replies Claude's", !resting.ok && BM.modelAvailable() && !BM.ambientAvailable(), { ok: resting.ok });
    BM.setModelOutcomeLog(null);
    tick(20);
}

// ---- off ----
if (want('off')) {
    scene(SEED, 'off');
    const [a, b] = pair();
    place(a, base[0], base[1] + 32);
    place(b, base[0] + 2, base[1] + 32);
    humanAt(4, 32);
    tick(2);
    let draws = 0;
    const real = Math.random;
    const counting = () => {
        draws++;
        return real();
    };
    const tryOff = () => {
        draws = 0;
        Math.random = counting;
        const ok = A.ambientWords({ kind: 'thread', bot: a, partner: b, heard: 'wc lvl?', hint: '41 u?', ruleText: '41 u?', extra: 2 }, { to: b, kind: 'practice' });
        const refusal = A.ambientRefusal(a);
        Math.random = real;
        return { ok, draws, refusal };
    };
    // the setting on Rules (a model chosen)
    model();
    BM.setModelMode({ mode: 'local', local: true, online: false, ambient: false });
    const sent0 = sent.length;
    const rules = tryOff();
    // no model at all
    BM.resetModelForTest();
    const none = tryOff();
    // the setting on, far from the human
    model();
    humanAt(40, 32);
    const far = tryOff();
    check("off: Bots' own talk on Rules: ambientWords false, no request, no dice", !rules.ok && rules.draws === 0 && rules.refusal === 'off' && sent.length === sent0, rules);
    check('off: no model at all: the same', !none.ok && none.draws === 0 && none.refusal === 'off', none);
    check('off: the setting on but no human within 15 tiles: no request, no dice', !far.ok && far.draws === 0 && far.refusal === 'far' && sent.filter(m => m.ambient).length === 0, far);
    // the mod bot's lines
    humanAt(4, 32);
    const level = a.staffModLevel;
    a.staffModLevel = 1;
    const mod = tryOff();
    a.staffModLevel = level;
    check("off: the player-mod bot's lines are never the model's", !mod.ok && mod.refusal === 'mod' && mod.draws === 0, mod);
}

// ======== (bots ideas, round 5: I stage 2) the reactions to the human ========

const humanName = human.displayName || human.username;
const WITNESS_OFF = { death: 0, drop: 0, human: 0, show: 0, gear: 0, level: 0, respond: 0, fight: 0 };
/** the scene's spot clear of other bots (each within 14 tiles of it put back at Lumbridge's courtyard) */
const clear = (x, z, keep) => {
    for (const p of all) if (!keep.includes(p) && cheb(p, { x, z }) <= 14) place(p, 3222, 3218);
};
/**
 * the stub's words and Bots' own talk on, the reactions' switch as asked; a place's voice cap off (port/BotVoice: the
 * scenes' one spot fills its ledger, and a witness over its share says nothing: not what these scenes are about)
 */
function reactions(on, stub = 'stub', opts = {}) {
    model(stub, opts);
    A.setAmbientReactionsForTest(on);
    lib.setVoiceCapForTest(true);
}
const lastLines = text => text.split('\n').slice(-2);
/** port/BotWitness's minute between two reactions to a human, and port/BotReactions' between two gz, over */
const HUMAN_GAP = 101;

// ---- golden: the reply prompts as before, byte for byte ----
if (want('golden')) {
    scene(SEED, 'golden');
    const P = lib.BotModelPromptNs;
    const golden = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'test/data/model-golden-r2.json'), 'utf8'));
    const dir = path.resolve(String(args['golden-data'] ?? process.env.PHASE7_DATA_R2 ?? path.resolve(BOTS_DIR, 'test/data/no-golden-data')));
    if (!fs.existsSync(path.join(dir, 'situations.jsonl'))) check(`golden: round 2's situations rendered as at ${golden.base} (skipped: no data at ${dir})`, true);
    else {
        const got = {};
        for (const file of Object.keys(golden.files)) {
            const h = crypto.createHash('sha256');
            const rows = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
            for (const r of rows) {
                const p = P.renderLocal(r.situation);
                h.update(`${r.id}\n${p.system}\n${p.user}\n`);
            }
            got[file] = { rows: rows.length, sha256: h.digest('hex') };
        }
        const same = Object.entries(golden.files).every(([f, g]) => got[f]?.rows === g.rows && got[f]?.sha256 === g.sha256);
        check(`golden: renderLocal of round 2's ${Object.values(got).reduce((n, g) => n + g.rows, 0)} situations (situations, eval, target) byte for byte as at ${golden.base}`, same, { got, golden: golden.files });
    }
    // a reply's prompt, and the same situation as a reaction: the task and the chat's end only
    const [b] = pair();
    const s0 = P.situationOf({ bot: b, to: human, heard: 'gz', channel: 'public', via: 'named', greeted: false, intent: { id: 'thanks', text: 'ty' } });
    const reply = P.renderLocal(s0);
    const asReaction = P.renderLocal({ ...s0, heard: { ...s0.heard, text: '', via: 'reaction' }, hint: { intent: 'gz', text: 'gz' }, event: 'levelled woodcutting to 60' });
    const tail = lastLines(asReaction.user);
    const head = text => text.split('\n').slice(0, -2).join('\n');
    check("golden: a reaction's prompt: \"Say one short chat line to {name}.\" for the reply's task, the rest of the system turn the same; its chat the same lines before, then the event and the idea (no line of the human's heard)", reply.system.includes(`Reply to ${humanName} in one short chat line.`) && asReaction.system === reply.system.replace(`Reply to ${humanName} in one short chat line.`, `Say one short chat line to ${humanName}.`) && head(asReaction.user) === head(reply.user) && lastLines(reply.user)[0] === `${humanName}: gz` && tail[0] === `(${humanName} levelled woodcutting to 60)` && tail[1] === '(answer idea: gz)', { system: asReaction.system.split('\n')[0], user: asReaction.user });
}

// ---- reaction: the switch on, a dance and a level-up in the stub's words ----
if (want('reaction')) {
    scene(SEED, 'reaction');
    reactions(true);
    const [b] = pair();
    const spot = [base[0] + 3, base[1] + 34];
    clear(spot[0], spot[1], [b]);
    place(b, spot[0], spot[1]);
    humanAt(0, 34);
    tick(2);
    settle(b);
    lib.Witness.readyForTest(b);
    lib.setWitnessRatesForTest({ ...WITNESS_OFF, human: 1 });
    const log0 = ambientLog().length;
    const sent0 = sent.length;
    const from = said.length;
    const reacted = lib.Witness.reactToHuman(human, 'react-dance', human.x, human.z, 0, 10, 'is dancing');
    tick(30);
    const msgs = sent.slice(sent0).filter(m => m.ambient);
    const e = ambientLog().slice(log0).find(en => en.via === 'reaction');
    const line = said.slice(from).find(l => l.kind === 'reaction' && l.to === human.username);
    const tail = msgs[0] ? lastLines(msgs[0].local.user) : [];
    check("reaction: a dance near the human: one ambient request ('reaction', local), said in the stub's words to the human (kind 'reaction')", reacted && msgs.length === 1 && msgs[0].mode === 'local' && e?.outcome === 'used' && line?.text === e.said && line.name === e.bot, { reacted, msgs: msgs.length, e: e && `${e.via} ${e.outcome} ${e.raw} -> ${e.said}`, line });
    check("reaction: its prompt says \"Say one short chat line to {name}.\" and its chat ends \"({name} is dancing)\" and the answer idea", msgs[0] && msgs[0].local.system.includes(`Say one short chat line to ${humanName}.`) && !msgs[0].local.system.includes('Reply to') && tail[0] === `(${humanName} is dancing)` && /^\(answer idea: .+\)$/.test(tail[1] ?? ''), msgs[0] && { system: msgs[0].local.system.split('\n')[0], user: msgs[0].local.user });
    lib.setWitnessRatesForTest(WITNESS_OFF);
    // a level-up (port/BotReactions: gz, its chance forced)
    tick(A.AMBIENT_GAP_TICKS);
    settle(b);
    const sent1 = sent.length;
    const log1 = ambientLog().length;
    const from1 = said.length;
    const roll = lib.chatDice.roll;
    lib.chatDice.roll = () => 0.01;
    const was = human.baseLevels[8];
    human.baseLevels[8] = was + 1;
    tick(30);
    lib.chatDice.roll = roll;
    const gzMsg = sent.slice(sent1).find(m => m.ambient);
    const gz = ambientLog().slice(log1).find(en => en.via === 'reaction');
    const gzLine = said.slice(from1).find(l => l.kind === 'reaction' && l.to === human.username);
    check(`reaction: a level-up (woodcutting ${was + 1}): its chat ends "(${humanName} levelled woodcutting to ${was + 1})", the rules' gz the idea, said in the stub's words`, gzMsg && lastLines(gzMsg.local.user)[0] === `(${humanName} levelled woodcutting to ${was + 1})` && lib.REACTION_LINES.gz.some(g => lastLines(gzMsg.local.user)[1] === `(answer idea: ${g.replace(' {name}', '')})`) && gz?.outcome === 'used' && gzLine?.text === gz.said, { user: gzMsg?.local.user, gz: gz && `${gz.outcome} ${gz.raw} -> ${gz.said}`, line: gzLine });
    human.baseLevels[8] = was;
    tick(5);
    A.setAmbientReactionsForTest(null);
}

// ---- reactoff: the switch off (forced: AMBIENT_REACTIONS ships true): the rules', no request, no dice ----
if (want('reactoff')) {
    scene(SEED, 'reactoff');
    reactions(false);
    // (bots ideas, round 5 ship: the r3 model is pinned, so the switch ships on; the rest of this scene forces it off)
    check('reactoff: AMBIENT_REACTIONS ships true (the round 3 model), forced off here', A.AMBIENT_REACTIONS === true && A.ambientReactions() === false);
    const [b] = pair();
    const spot = [base[0] + 3, base[1] + 34];
    clear(spot[0], spot[1], [b]);
    place(b, spot[0], spot[1]);
    humanAt(0, 34);
    tick(2);
    settle(b);
    lib.Witness.readyForTest(b);
    const told = [];
    const listener = req => told.push(req.kind);
    A.ambientListeners.push(listener);
    const log0 = ambientLog().length;
    const sent0 = sent.length;
    const from = said.length;
    tick(HUMAN_GAP);
    lib.setWitnessRatesForTest({ ...WITNESS_OFF, human: 1 });
    const reacted = lib.Witness.reactToHuman(human, 'react-death', human.x, human.z, 0, 10);
    tick(30);
    lib.setWitnessRatesForTest(WITNESS_OFF);
    tick(HUMAN_GAP);
    const roll = lib.chatDice.roll;
    lib.chatDice.roll = () => 0.01;
    const was = human.baseLevels[14];
    human.baseLevels[14] = was + 1;
    tick(30);
    lib.chatDice.roll = roll;
    human.baseLevels[14] = was;
    const lines = said.slice(from).filter(l => l.kind === 'reaction' && l.to === human.username);
    A.ambientListeners.splice(A.ambientListeners.indexOf(listener), 1);
    // (the world's own talk far off may count its skips meanwhile: no reaction is asked, logged or told)
    const reactLog = ambientLog().slice(log0).filter(e => e.via === 'reaction');
    check("reactoff: a death and a level-up near the human, the model and Bots' own talk on: the rules' lines said, no request, no reaction in the model's log, nothing told to the capture's listeners", reacted && lines.length >= 2 && sent.length === sent0 && reactLog.length === 0 && told.length === 0, { reacted, lines: lines.map(l => `${l.name}: ${l.text}`), sent: sent.length - sent0, reactLog: reactLog.length, told });
    // ambientWords for a reaction with the switch off: false, no dice, no request
    let draws = 0;
    const real = Math.random;
    Math.random = () => (draws++, real());
    const ok = A.ambientWords({ kind: 'reaction', bot: b, partner: human, heard: '', hint: 'gz', ruleText: 'gz', extra: 2, event: 'levelled mining to 40', react: 'gz' }, { to: human, kind: 'reaction' });
    Math.random = real;
    check('reactoff: ambientWords for a reaction with the switch off: false, no dice drawn, no request', ok === false && draws === 0 && sent.length === sent0, { ok, draws });
}

// ---- role: a reaction keeps its role ----
if (want('role')) {
    scene(SEED, 'role');
    const [b, c] = pair();
    const P = lib.BotModelPromptNs;
    const s = { ...P.situationOf({ bot: b, to: human, heard: '', channel: 'public', via: 'reaction', greeted: false, intent: { id: 'gz', text: 'gz' } }), event: 'levelled woodcutting to 60' };
    const amb = { ambient: true };
    const refused = ['ty lol', 'thx! 40 now', 'thanks m8', 'np', 'wat u want', 'what do u want lol', 'who is u lol', 'who r u'].map(t => [t, G.guardReply(t, s, amb)]);
    const passed = ['gz', 'gz on 60 wc', 'nice 60 wc', 'gratz lol'].map(t => [t, G.guardReply(t, s, amb)]);
    check("role: a reaction that thanks or asks the human what it wants or who it is is refused ('role')", refused.every(([, r]) => r.ok === false && r.reason === 'role'), refused.map(([t, r]) => `${t}: ${r.ok ? 'ok' : r.reason}`));
    check("role: a gz with the event's level passes (\"gz on 60 wc\": the event's numbers are what it saw)", passed.every(([, r]) => r.ok), passed.map(([t, r]) => `${t}: ${r.ok ? 'ok' : r.reason}`));
    const plain = G.guardReply('ty lol', s, {});
    const st = P.situationOf({ bot: b, to: c, heard: 'gz on 50 str', channel: 'public', via: 'thread', greeted: false, intent: { id: 'thread', text: 'ty' } });
    const turn = G.guardReply('ty lol', st, amb);
    check("role: not without the ambient flag, nor for a thread's turn (a bot thanking a bot)", plain.ok && turn.ok, { plain, turn });
    check("role: 'role' is a GUARD_REASON", G.GUARD_REASONS.includes('role'));
    // a stub that thanks: refused, the rules' line said
    reactions(true, (sit, msg) => (msg.ambient && sit.event ? 'thx lol' : 'ok'));
    const spot = [base[0] + 3, base[1] + 34];
    clear(spot[0], spot[1], [b]);
    place(b, spot[0], spot[1]);
    humanAt(0, 34);
    tick(Math.max(A.AMBIENT_GAP_TICKS, HUMAN_GAP));
    settle(b);
    lib.Witness.readyForTest(b);
    lib.setWitnessRatesForTest({ ...WITNESS_OFF, human: 1 });
    const log0 = ambientLog().length;
    const from = said.length;
    const reacted = lib.Witness.reactToHuman(human, 'react-kill', human.x, human.z, 0, 10, 'killed a hill giant');
    tick(30);
    lib.setWitnessRatesForTest(WITNESS_OFF);
    const e = ambientLog().slice(log0).find(en => en.via === 'reaction');
    const line = said.slice(from).find(l => l.kind === 'reaction' && l.to === human.username);
    check("role: a stub that thanks for a reaction: refused ('guard', 'role'), the rules' line said", reacted && e?.outcome === 'guard' && e.reason === 'role' && line?.text && line.text !== 'thx lol' && e.ruleText === line.text, { reacted, e: e && `${e.outcome} ${e.reason} ${e.raw}`, line: line?.text, rules: e?.ruleText });
    A.setAmbientReactionsForTest(null);
}

// ---- refusal: (bots ideas, round 5 ship) the guard's false refusals, the checker agreeing ----
if (want('refusal')) {
    scene(SEED, 'refusal');
    const [b, c] = pair();
    const P = lib.BotModelPromptNs;
    const amb = { ambient: true };
    const at = (via, to, event, hint) => ({ ...P.situationOf({ bot: b, to, heard: '', channel: 'public', via, greeted: false, intent: { id: via === 'reaction' ? 'wildy' : 'thread', text: hint } }), ...(event ? { event } : {}) });
    const ditch = at('reaction', human, 'crossed the wilderness ditch', 'careful');
    // (a combat level for the human that none of the bot's own numbers is, and another one nobody has)
    const own = new Set([ditch.facts.combat, ditch.facts.total, ...Object.values(ditch.facts.levels), ...ditch.facts.hp]);
    let cb = 14;
    while (own.has(cb)) cb++;
    let other = cb + 9;
    while (own.has(other) || other === cb) other++;
    const s = { ...ditch, human: { ...ditch.human, combat: cb } };
    const both = t => ({ t, guard: G.guardReply(t, s, amb), check: checkReply(s, 'careful', t).failures.map(f => f.reason) });
    const show = r => `${r.t}: ${r.guard.ok ? 'ok' : r.guard.reason} / [${r.check.join(',')}]`;
    const named = [`lol lvl ${cb} in the wildy`, `${cb} cb in the wildy lol`, `careful ur only ${cb}`, `lvl ${cb}? u will die lol`].map(both);
    check(`refusal: a reaction to the ditch may name the human's own combat (${cb}) though the event does not carry it: the guard and the checker pass it`, named.every(r => r.guard.ok && r.check.length === 0), named.map(show));
    // (the review of the ship: the human's combat said of the bot itself is its claim)
    const wrong = [`lol lvl ${other} in the wildy`, `${other} cb in the wildy lol`, `im lvl ${cb} too`, `lol im ${cb} cb`, `lol my cb is ${cb}`].map(both);
    check(`refusal: any other number (${other}), or the human's combat said of the bot itself ("im lvl ${cb} too"), stays a claim: refused ('level'), by the checker too`, wrong.every(r => !r.guard.ok && r.guard.reason === 'level' && r.check.includes('level')), wrong.map(show));
    // (not for a thread's turn: the partner's combat there is a claim of the bot's as before)
    const st = { ...at('thread', c, null, 'nice'), human: { ...ditch.human, combat: cb } };
    const turn = G.guardReply(`lol lvl ${cb}`, st, amb);
    check(`refusal: not in a thread's turn: "lol lvl ${cb}" is the bot's claim there, refused ('level') as before`, !turn.ok && turn.reason === 'level', turn);
    // following: a question is no promise, a promise is
    const followed = at('reaction', human, 'has been following you for a while', 'u following me?');
    const asks = ['why u follow me', 'y u following me', 'u following me?', 'why do u keep following me', 'why u follow me lol', 'lol u following me?', 'u following me lol?', 'u follow me or what?'].map(t => ({ t, guard: G.guardReply(t, followed, amb), check: checkReply(followed, 'u following me?', t).failures.map(f => f.reason) }));
    check('refusal: a question about following passes the guard and the checker (no promise)', asks.every(r => r.guard.ok && !r.check.includes('promise')), asks.map(show));
    // (the review of the ship: a promise after the question, with one "?" at the end, keeps its refusal)
    const promises = ['follow me', 'ill follow u', 'come with me', 'can u follow me?', 'follow me lol', 'u follow me and ill give u 1k?', 'you following me to the bank, ill trade u there?', 'u follow me to varrock ill meet u there ok?', 'hey u follow me, come with me ok?', 'u following me lol omw to bank?'].map(t => ({ t, guard: G.guardReply(t, followed, amb), check: checkReply(followed, 'u following me?', t).failures.map(f => f.reason) }));
    check("refusal: a real promise stays refused ('promise'), by the checker too", promises.every(r => !r.guard.ok && r.guard.reason === 'promise' && r.check.includes('promise')), promises.map(show));
    // (and outside the ambient talk: a reply to the human's "why u follow me" is no promise either; "follow me" is)
    const reply = P.situationOf({ bot: b, to: human, heard: 'stop following me', channel: 'public', via: 'named', greeted: false, intent: null });
    check('refusal: a reply asking "why u follow me" passes, "follow me" does not', G.guardReply('why u follow me lol', reply).ok && G.guardReply('follow me lol', reply).reason === 'promise');
}

// ---- first: a reaction goes first ----
if (want('first')) {
    scene(SEED, 'first');
    reactions(true, 'stub', { gap: A.AMBIENT_GAP_TICKS, latencyTicks: 6 });
    const [a, b] = pair();
    const spot = [base[0] + 3, base[1] + 34];
    clear(spot[0], spot[1], [a, b]);
    place(a, spot[0], spot[1]);
    place(b, spot[0] + 2, spot[1]);
    humanAt(0, 34);
    tick(Math.max(A.AMBIENT_GAP_TICKS, HUMAN_GAP));
    settle(a, b);
    lib.Witness.readyForTest(a);
    lib.Witness.readyForTest(b);
    lib.setWitnessRatesForTest({ ...WITNESS_OFF, human: 1 });
    const log0 = ambientLog().length;
    const from = said.length;
    const turn = ask(a, b, 'cutting willows');
    // (an emote other than the dance: each kind has its own gap, the dance's was the reaction scene's)
    const reacted = lib.Witness.reactToHuman(human, 'react-emote', human.x, human.z, 0, 10, 'cheered');
    tick(30);
    const entries = ambientLog().slice(log0);
    const t = entries.find(en => en.via === 'thread');
    const r = entries.find(en => en.via === 'reaction');
    const turnLine = said.slice(from).find(l => l.name === a.username && l.to === b.username);
    check("first: a reaction in the tick a thread's turn was asked goes first: the turn superseded (its rules' line said), the reaction asked and said", turn.ok && reacted && t?.outcome === 'superseded' && turnLine?.text === 'cutting willows' && r?.outcome === 'used', { turn: turn.ok, reacted, t: t?.outcome, turnLine: turnLine?.text, r: r && `${r.outcome} -> ${r.said}` });
    // a tick later: the reaction waits its 20 s
    tick(A.AMBIENT_GAP_TICKS + HUMAN_GAP);
    settle(a, b);
    lib.Witness.readyForTest(a);
    lib.Witness.readyForTest(b);
    const log1 = ambientLog().length;
    const waited = () => (BM.modelStats.ambient.skipped.pacing ?? 0) + (BM.modelStats.ambient.skipped.inflight ?? 0);
    const waited0 = waited();
    const turn2 = ask(a, b, 'nice');
    tick(1);
    const reacted2 = lib.Witness.reactToHuman(human, 'react-death', human.x, human.z, 0, 10);
    tick(30);
    lib.setWitnessRatesForTest(WITNESS_OFF);
    const entries2 = ambientLog().slice(log1);
    check("first: a reaction a tick after a thread's turn was asked waits ('inflight' while the turn's request is out, else 'pacing'): the turn the model's, the reaction the rules'", turn2.ok && reacted2 && entries2.length === 1 && entries2[0].via === 'thread' && waited() - waited0 >= 1, { turn2: turn2.ok, reacted2, entries: entries2.map(e => `${e.via} ${e.outcome}`), waited: waited() - waited0 });
    A.setAmbientReactionsForTest(null);
}

BM.resetModelForTest();
A.setAmbientRatesForTest();
A.setAmbientReactionsForTest(null);
lib.setVoiceCapForTest(false);
check('no errors', errors.length === 0 && lib.botErrorCount() === 0, errors.slice(0, 3).join(' | '));
const failed = checks.filter(c => !c.ok);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : `: ${c.detail}`}`);
out(failed.length ? `model-ambient: ${failed.length} of ${checks.length} failed` : `model-ambient: all ${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
