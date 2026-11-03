#!/usr/bin/env node
// Lives with arcs (bots ideas round 2, theme C):
// staged in the real 274 world, each scene on its own dice (test/lib/dice.mjs), the director, cliques, habits, hang-outs,
// random events and the other ambient pieces off, its bots held with a stand task:
//   goals     every levelling bot draws a goal from its real state (a level 5-25 up in a skill it trains, or 99 from 95; a
//             piece its upgrades would buy; a sum; a combat or total level), a PKer and a vendor none; the goal survives
//             BotManager.exportWorld and a restore; its words and progress ("3 lvls to go for 60 wc")
//   done      a level goal completes on a staged level-up: the celebration ("finally 41 wc!!") in the level-up line's place,
//             one line only, a bot near says gz, the goal gone and the next one 5-30 minutes on; a money goal done at a
//             look, its line at a calm moment
//   lean      200 picks of a woodcutting-goal bot put woodcutting first about 35 % of the time (99: about 60 %)
//   answers   "whats ur goal" from the human gets the goal's words; "im going for 99 wc" an upstream reply, no goal answer
//   moods     a staged death and kill-steal tilt a bot (its sensitivities from its name), its idle line from the tilt pool;
//             a rude talker's rude-reply chance x1.5 when tilted; an elated bot the likelier gz responder; boredom moves the
//             next pick off the last skill and never ends a plan (the task the same 15 minutes on)
//   rage      tilt 0.75+: a rage line, then the logout within 40 s with no bank trip; a line from the human in that window
//             is answered before the logout; (the review's C-1) a line said to a bot is owed before it is read, and an
//             abrupt goodbye given then waits for its answer (BotManager._endSession); a line kept for a bot on its break
//             holds its rage-quit until it is back and has answered
//   hop       6 bots at one rock cluster, waiting: one says "w8 hopping" and is out within 15 s, away 5-20 minutes
//   ninety-off (the review's C-2, C-3) no 99 gathering in the Wilderness (one out of it, then ended when its host goes in,
//             its guests let go); the one that ended without its 99 none again at the next login; at 1x XP 10k XP to go is
//             not near, a measured 120 XP-tenths a tick is; a task of another skill ends it
//   endgame   a bosser's goal of combat 100 makes its endgame trips 1.5 times as likely (round 1's hook)
//   errors    none
//
//   node --expose-gc web/engine/bots/test/arcs.test.mjs [--seed=5] [--only=goals,rage]
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
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const wants = name => ONLY === null || ONLY.has(name);
const out = (s = '') => process.stdout.write(s + '\n');
const checks = [];
const safe = v => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? String(x) : k === 'p' || k === 'bot' || k === 'to' ? x?.username ?? x : x));
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : safe(detail) });
const errors = [];
for (const level of ['log', 'info', 'debug', 'warn']) console[level] = () => {};
console.error = (...a) => {
    const text = a.map(String).join(' ');
    if (!text.includes('ExperimentalWarning') && !text.includes('--trace-warnings')) errors.push(text.slice(0, 300));
};
Math.random = mulberry(SEED);

const engineDir = prepareEngineClone('arcs-c', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/arcs.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, PlayerStat, ArcsStore: S, Goals: G, Moods: Md, Leaving: L } = lib;

// ======== the world ========
const N = 32;
const said = [];
lib.sayListeners.push((p, text, kind, to) => said.push({ t: World.currentTick, name: p.username, p, text, kind: typeof kind === 'string' ? kind : kind?.kind, to: to ?? null }));
const logouts = [];
const botLines = [];
lib.onArcs('logout', e => logouts.push({ t: World.currentTick, name: e.name }));
const sim = await lib.Sim.create({ bots: N, members: true, debug: false, spawnPerTick: N, ackLogouts: true, lives: true });
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
Md.setRageScaleForTest(0);
L.setLeaveRatesForTest({ hop: 0, bigDrop: 0 });
// (a level-up line to the bots near: BotChat.onBotLine, whose gz is the chat's own dice)
{
    const onBotLine = lib.BotChat.onBotLine.bind(lib.BotChat);
    lib.BotChat.onBotLine = (bot, line, kind) => {
        botLines.push({ t: World.currentTick, bot, line, kind });
        return onBotLine(bot, line, kind);
    };
}
const run = (max, until = () => false) => {
    for (let i = 0; i < max; i++) {
        sim.tick();
        if (until()) return i + 1;
    }
    return -1;
};
run(20);
const bots = sim.bots();
check(`${N} bots in the world`, bots.length === N, bots.length);
const STAND = { name: 'Idle', reset() {}, interrupt() {}, interrupted: false, shouldRun: () => true, isComplete: () => false, tick() {}, activityStep: () => null };
function hold(p, name = 'Idle') {
    const ai = sim.botPlayer(p);
    ai.currentTask = Object.assign(Object.create(STAND), { name });
    ai.planEnds = World.currentTick + 1e6;
    // (its no-XP clock from now: a stand of minutes is no stalled plan, BotPlayer._watchPlan)
    ai.planXp = -1;
    ai.planXpTick = World.currentTick;
    // (unhurt, no sub-task: a staged bot is free)
    p.levels[PlayerStat.HITPOINTS] = p.baseLevels[PlayerStat.HITPOINTS];
    if (ai.hasSubTask()) ai._dropSubTask?.();
    p.clearWaypoints();
    p.clearPendingAction();
}
for (const p of bots) hold(p);
const levelling = bots.filter(p => ['skiller', 'fighter', 'balanced', 'random'].includes(p.botPlanner));
const extras = bots.filter(p => !levelling.includes(p));
/** levels a staged bot's skill (XP and level: the bot sees a level-up) */
function setLevel(p, stat, level) {
    p.stats[stat] = lib.getExpByLevel(level);
    p.baseLevels[stat] = level;
    p.levels[stat] = level;
}
/** puts a bot on a tile near (x, z) (staging: the test's own move) */
function place(p, x, z) {
    p.teleport(x, z, 0);
    p.clearWaypoints();
}
const free = [...levelling];
const take = () => free.shift();
// (every levelling bot out of its fresh levels: 20 in each skill, so its goals are a staged bot's)
for (const p of levelling) for (let stat = 0; stat < 21; stat++) if (stat !== 18 && stat !== 19 && p.baseLevels[stat] < 20) setLevel(p, stat, stat === PlayerStat.HITPOINTS ? 25 : 20);
run(5);

// ---- goals: drawn from the real state, saved ----
if (wants('goals')) {
    scene(SEED, 'goals');
    S.resetArcsForTest();
    const drawn = levelling.map(p => [p, G.ensureGoal(p)]);
    check(`every levelling bot draws a goal (${drawn.length})`, drawn.length > 0 && drawn.every(([, g]) => g && ['L', 'G', 'M', 'C', 'T'].includes(g.kind)), drawn.map(([p, g]) => `${p.botPlanner}:${g?.kind}`));
    check('an extra (PKer, vendor, social) keeps no goal', extras.length > 0 && extras.every(p => G.ensureGoal(p) === null && G.goalOf(p) === null), extras.map(p => p.botPlanner));
    const levelGoals = drawn.filter(([, g]) => g?.kind === 'L');
    const fit = levelGoals.every(([p, g]) => {
        const level = p.baseLevels[g.stat];
        return g.target === 99 ? level >= 95 : g.target >= level + 5 && g.target <= level + 25;
    });
    check('a level goal is 5-25 levels up (99 only from 95)', levelGoals.length > 0 && fit, levelGoals.map(([p, g]) => `${p.baseLevels[g.stat]}->${g.target}`));
    // a gear goal from the real upgrades, a money goal from the real coins
    const p = levelling[0];
    lib.Goals.setGoalForTest(p, null);
    const want = G.gearWanted(p);
    check('a gear goal is what the upgrades would buy with unlimited coins (1k+), as said ("rune legs")', want === null || (want.cost >= 1000 && typeof G.goalWords({ kind: 'G', target: want.itemId, since: 0, base: 0 }) === 'string'), want);
    // words and progress
    const g1 = { kind: 'L', stat: PlayerStat.WOODCUTTING, target: 60, since: 0, base: 0 };
    check('words: "60 wc", "60 wc for yews", "99 fishing", "100k", "1m", "cb 70", "1000 total"', G.goalWords(g1) === '60 wc' && G.goalWords(g1, true) === '60 wc for yews' && G.goalWords({ kind: 'L', stat: PlayerStat.FISHING, target: 99 }) === '99 fishing' && G.goalWords({ kind: 'M', target: 100 }) === '100k' && G.goalWords({ kind: 'M', target: 1000 }) === '1m' && G.goalWords({ kind: 'C', target: 70 }) === 'cb 70' && G.goalWords({ kind: 'T', target: 1000 }) === '1000 total', [G.goalWords(g1), G.goalWords(g1, true)]);
    setLevel(p, PlayerStat.WOODCUTTING, 57);
    check('progress: "3 lvls" to 60 wc', G.goalLeft(p, g1) === '3 lvls', G.goalLeft(p, g1));
    // saved and restored
    G.setGoalForTest(p, g1);
    const state = BotManager.exportWorld();
    const before = JSON.stringify(S.peekArcs(p.username).goal);
    S.resetArcsForTest();
    S.restoreArcs(JSON.parse(JSON.stringify(state.arcs)), BotManager.playTicks(), () => true);
    const back = S.peekArcs(p.username)?.goal;
    check('the goal survives exportWorld and a restore (kind, skill, target)', back && back.kind === 'L' && back.stat === PlayerStat.WOODCUTTING && back.target === 60, { before, back });
}

// ---- done: a level goal's celebration in the level-up line's place; a money goal's at a calm moment ----
if (wants('done')) {
    scene(SEED, 'done');
    const a = take();
    const b = take();
    place(a, 3210, 3220);
    place(b, 3212, 3221);
    hold(a);
    hold(b);
    run(3);
    G.CELEBRATE.company = 1;
    G.CELEBRATE.alone = 1;
    lib.resetLineRegistry();
    const wc = PlayerStat.WOODCUTTING;
    setLevel(a, wc, 40);
    run(2);
    G.setGoalForTest(a, { kind: 'L', stat: wc, target: 41 });
    const n0 = said.length;
    lib.SayChatter.dueNowForTest(a);
    setLevel(a, wc, 41);
    const isCelebration = l => lib.livesLines.some(x => x.name === a.username && x.event === 'arcs-goal' && x.kind === 'done' && x.text.toLowerCase() === l.text.toLowerCase());
    run(200, () => said.slice(n0).some(l => l.p === a && isCelebration(l)));
    run(60);
    const fromA = said.slice(n0).filter(l => l.p === a && (l.kind === 'levelup' || l.kind === 'event'));
    const lines = fromA.filter(isCelebration);
    const plain = fromA.filter(l => l.kind === 'levelup' && !lines.includes(l));
    const done = G.goalLog.filter(e => e.name === a.username && e.ev === 'done').at(-1);
    check('the level-up completes the goal: done in the log with company, the goal gone', done && done.target === 41 && done.company >= 1 && G.goalOf(a) === null, done);
    check('the celebration in the level-up line\'s place: one line of the goal-done pool ("finally 41 wc!!"), no plain level-up line', lines.length === 1 && plain.length === 0, { lines: lines.map(l => l.text), plain: plain.map(l => l.text) });
    const sent = botLines.some(x => x.bot === a && x.kind === 'levelup' && x.t >= lines[0]?.t - 1);
    check(`its roll ${done?.gz ? 'passed: the level-up\'s own line (kind levelup), the bots near may gz it' : 'failed: in the place of a due line (kind event), not sent for a gz'}`, done && lines[0] && sent === done.gz && lines[0].kind === (done.gz ? 'levelup' : 'event'), { gz: done?.gz, sent, kind: lines[0]?.kind });
    check('the next goal 5-30 minutes on, not at once', G.ensureGoal(a) === null);
    // a money goal done at a look: its line at a calm moment
    G.resetGoalMemoryForTest(a);
    const coins = lib.Items.COINS;
    G.setGoalForTest(a, { kind: 'M', target: 25 });
    const inv = a.getInventory(lib.InvType.INV);
    if (inv) inv.add(coins, 30000);
    const n1 = said.length;
    const c1 = lib.livesLines.length;
    G.checkGoalForTest(a);
    run(800, () => lib.livesLines.slice(c1).some(l => l.name === a.username && l.event === 'arcs-goal'));
    const m = G.goalLog.filter(e => e.name === a.username && e.ev === 'done').at(-1);
    check('a money goal done at a look (25k), its line said at a calm moment ("25k done!!")', m?.kind === 'M' && typeof m.said === 'number' && lib.livesLines.slice(c1).some(l => l.name === a.username && l.event === 'arcs-goal' && l.kind === 'done'), { m, lines: said.slice(n1).filter(l => l.p === a).map(l => l.text) });
    if (inv) inv.remove(coins, 30000);
    G.CELEBRATE.company = 0.8;
    G.CELEBRATE.alone = 0.3;
}

// ---- lean: the goal's skill first, GOAL_LEAN of the picks ----
if (wants('lean')) {
    scene(SEED, 'lean');
    const p = levelling.find(b => b.botPlanner !== 'fighter') ?? levelling[0];
    const base = ['FISHING', 'MINING', 'COOKING', 'WOODCUTTING', 'SMITHING', 'ATTACK'];
    const dice = mulberry(SEED * 31 + 7);
    const share = target => {
        G.setGoalForTest(p, { kind: 'L', stat: PlayerStat.WOODCUTTING, target });
        let first = 0;
        for (let i = 0; i < 200; i++) {
            const c = [...base].sort(() => dice() - 0.5);
            const was = c[0] === 'WOODCUTTING';
            G.goalLean(p, c, dice);
            if (c[0] === 'WOODCUTTING' && !was) first++;
            else if (was) first += 0;
        }
        return first / 200;
    };
    const s35 = share(Math.min(98, p.baseLevels[PlayerStat.WOODCUTTING] + 10));
    const s60 = share(99);
    // (the moved-to-front share: the lean's chance times the share not already first, about 5/6)
    check(`the lean: a woodcutting goal puts woodcutting first in ${(s35 * 100).toFixed(0)} % of 200 picks (about 35 % x 5/6)`, s35 >= 0.18 && s35 <= 0.42, s35);
    check(`a 99 goal leans harder: ${(s60 * 100).toFixed(0)} % (about 60 % x 5/6)`, s60 >= 0.38 && s60 <= 0.62 && s60 > s35, s60);
    G.setGoalForTest(p, null);
}

// ---- answers: "whats ur goal" ----
if (wants('answers')) {
    scene(SEED, 'answers');
    const p = take();
    place(p, sim.human.x + 2, sim.human.z + 1);
    hold(p);
    run(3);
    G.setGoalForTest(p, { kind: 'L', stat: PlayerStat.MINING, target: 30 });
    setLevel(p, PlayerStat.MINING, 27);
    lib.BotChat.onPublicMessage(sim.human, `${p.displayName} whats ur goal`);
    const n0 = said.length;
    run(120, () => said.slice(n0).some(l => l.p === p));
    const reply = said.slice(n0).find(l => l.p === p);
    check('"whats ur goal" gets the goal\'s words ("30 mining", "3 lvls to go")', reply && /30 mining|3 lvls/.test(reply.text) && reply.to === sim.human, reply?.text);
    run(40);
    const asked = G.goalLog.filter(e => e.ev === 'asked').length;
    const n1 = said.length;
    lib.BotChat.onPublicMessage(sim.human, `${p.displayName} im going for 99 wc`);
    run(400, () => said.slice(n1).some(l => l.p === p));
    const r2 = said.slice(n1).find(l => l.p === p);
    if (args.debug) out(`answers: ${JSON.stringify(said.slice(n1).filter(l => l.p === p || l.to === sim.human).map(l => [l.t, l.name, l.text, l.kind]))} p at ${p.x},${p.z} human ${sim.human.x},${sim.human.z} slot ${p.slot}`);
    check('"im going for 99 wc" (a statement) gets an upstream reply, not a goal answer', r2 && G.goalLog.filter(e => e.ev === 'asked').length === asked && !/30 mining/.test(r2.text), r2?.text);
    G.setGoalForTest(p, null);
}

// ---- moods ----
if (wants('moods')) {
    scene(SEED, 'moods');
    const p = take();
    const q = take();
    place(p, 3230, 3215);
    place(q, 3231, 3216);
    hold(p);
    hold(q);
    run(3);
    const s = Md.sensitivityOf(p);
    check('sensitivities from the name: temper 0.5-2.08, patience 0.6-1.6, excitability 0.6-1.8, the same again', s.temper >= 0.5 && s.temper <= 2.08 && s.patience >= 0.6 && s.patience <= 1.6 && s.excitability >= 0.6 && s.excitability <= 1.8 && JSON.stringify(Md.sensitivityOf(p)) === JSON.stringify(s), s);
    lib.noteDeath(p, false);
    const afterDeath = Md.moodOf(p).tilt;
    lib.noteSteal('ks', q, p, { x: p.x, z: p.z }, false, 'race');
    const afterKs = Md.moodOf(p).tilt;
    check(`a death and a kill-steal tilt it (${afterDeath.toFixed(2)}, then ${afterKs.toFixed(2)}: 0.5 and 0.25 x temper)`, Math.abs(afterDeath - Math.min(1, 0.5 * s.temper)) < 0.02 && afterKs > afterDeath, { afterDeath, afterKs });
    run(500);
    const later = Md.moodOf(p).tilt;
    check('tilt decays (half-life 10 minutes)', later < afterKs && Math.abs(later - afterKs * Math.pow(0.5, 0.5)) < 0.05, { afterKs, later });
    Md.setMoodForTest(p, { tilt: 0.7 });
    // (and through the chatter's due line: one of its idle lines is a tilt line; alone, so that no thread with q takes it)
    place(q, 3260, 3230);
    run(2);
    let viaChatter = false;
    for (let i = 0; i < 20 && !viaChatter; i++) {
        lib.resetLineRegistry();
        lib.SayChatter.dueNowForTest(p);
        const n = said.length;
        lib.SayChatter.sayDueForTest(p);
        run(25);
        viaChatter = said.slice(n).some(l => l.p === p && lib.livesLines.some(x => x.text.toLowerCase() === l.text.toLowerCase() && x.event === 'arcs-mood' && x.kind === 'tilt'));
    }
    check('the chatter\'s due idle line is the tilt line now and then (BotChatter sayDue)', viaChatter, said.filter(l => l.p === p).slice(-6).map(l => l.text));
    place(q, 3231, 3216);
    run(2);
    let tiltLines = 0;
    for (let i = 0; i < 16; i++) {
        lib.resetLineRegistry();
        if (lib.LIVES.idleLine(p)) tiltLines++;
        run(1);
    }
    check(`tilted (0.7): about half its idle lines from the tilt pool (${tiltLines} of 16)`, tiltLines >= 3 && tiltLines <= 13, tiltLines);
    check('a tilted bot\'s rude-reply chance x1.5, an untilted one\'s as ever', lib.LIVES.rudeReplyScale(p) === 1.5 && lib.LIVES.rudeReplyScale(q) === 1);
    Md.setMoodForTest(q, { elation: 0.5 });
    check('an elated bot is the likelier gz responder (x1.5), a calm one as ever', lib.LIVES.gzWeight(q) === 1.5 && lib.LIVES.gzWeight(levelling.at(-1)) === 1);
    lib.emitArcs({ k: 'duel', winner: q, loser: p, stake: 50000 });
    check('a duel: the loser tilted more, the winner elated more', Md.moodOf(p).tilt > 0.7 && Md.moodOf(q).elation > 0.5, [Md.moodOf(p), Md.moodOf(q)]);
    // boredom: the next pick off the last skill; never a plan cut short
    Md.setMoodForTest(p, null);
    Md.setBoredForTest(p, 'Fish', PlayerStat.FISHING, 70);
    const bored = Md.moodOf(p).boredom;
    let avoided = 0;
    for (let i = 0; i < 40; i++) if (Md.boredSkillToAvoid(p) === PlayerStat.FISHING) avoided++;
    check(`bored (${bored.toFixed(2)} after 70 minutes at fishing): the next pick avoids it about 70 % (${avoided} of 40)`, bored >= 0.6 && avoided >= 18 && avoided <= 38, { bored, avoided });
    const ai = sim.botPlayer(p);
    const task = ai.currentTask;
    run(300);
    check('boredom never ends a plan: the task the same 300 ticks on', ai.currentTask === task);
    Md.setMoodForTest(p, null);
    Md.setMoodForTest(q, null);
}

// ---- rage: a rage line, then out within 40 s, no bank trip; the human's line answered first ----
if (wants('rage')) {
    scene(SEED, 'rage');
    Md.setRageScaleForTest(100);
    L.LEAVE.rageLine = 1;
    const p = take();
    place(p, 3218, 3226);
    hold(p);
    run(3);
    const x0 = p.x;
    const z0 = p.z;
    const n0 = said.length;
    const t0 = World.currentTick;
    Md.setMoodForTest(p, { tilt: 0.9 });
    const leave = L.leavingNow(p);
    run(120, () => logouts.some(l => l.name === p.username && l.t >= t0));
    const out = logouts.find(l => l.name === p.username && l.t >= t0);
    const line = said.slice(n0).find(l => l.p === p);
    check('tilt 0.75+: a rage line (kind departure)', leave && line && line.kind === 'departure' && lib.livesLines.some(l => l.event === 'arcs-leave' && l.kind === 'rage' && l.text.toLowerCase() === line.text.toLowerCase()), line);
    check(`then out within 40 s (${out ? out.t - t0 : '-'} ticks), no bank trip (it left where it stood)`, out && out.t - t0 <= 75 && Math.abs(p.x - x0) <= 2 && Math.abs(p.z - z0) <= 2, { out, t0, x: p.x - x0, z: p.z - z0 });
    // a line from the human in that window: answered before the logout
    const r = take();
    place(r, sim.human.x + 1, sim.human.z + 2);
    hold(r);
    run(3);
    const t1 = World.currentTick;
    Md.setMoodForTest(r, { tilt: 0.9 });
    const leaveR = L.leavingNow(r);
    // (the human talks to it just before its time to go)
    run(Math.max(0, (leaveR ? leaveR.t : t1) + 15 - World.currentTick));
    const n1 = said.length;
    lib.BotChat.onPublicMessage(sim.human, `${r.displayName} where is the bank`);
    run(200, () => logouts.some(l => l.name === r.username && l.t >= t1));
    const outR = logouts.find(l => l.name === r.username && l.t >= t1);
    const answer = said.slice(n1).find(l => l.p === r && l.to === sim.human);
    check('a line from the human in the window is answered before the logout (never ignored)', leaveR && outR && answer && answer.t <= outR.t, { answer: answer?.text, at: answer?.t, out: outR?.t });
    // (the review's C-1: a line said to a bot is owed from the moment it is said, before it is read: an abrupt goodbye
    // given then is stretched for its answer, BotManager._endSession)
    const q = take();
    if (q) {
        place(q, sim.human.x - 1, sim.human.z + 2);
        hold(q);
        run(3);
        const t2 = World.currentTick;
        const n2 = said.length;
        lib.BotChat.onPublicMessage(sim.human, `${q.displayName} where is the bank`);
        check('a line said to a bot is owed before it is read (BotChat.owesHumanReply; midTalk not yet)', lib.BotChat.owesHumanReply(q) && !lib.BotChat.midTalk(q));
        BotManager.leaveSoon(q.username, 1, { abrupt: true });
        run(200, () => logouts.some(l => l.name === q.username && l.t >= t2));
        const outQ = logouts.find(l => l.name === q.username && l.t >= t2);
        const answerQ = said.slice(n2).find(l => l.p === q && l.to === sim.human);
        if (args.debug) process.stdout.write(`abrupt q: ${safe(said.slice(n2).map(l => [l.t, l.name, l.text, l.kind, l.to?.username ?? null]))} q=${q.username} at ${q.x},${q.z} human ${sim.human.x},${sim.human.z}\n`);
        check('an abrupt goodbye given with that line unread: stretched, the line answered first', outQ && answerQ && answerQ.t <= outQ.t, { answer: answerQ?.text, at: answerQ?.t, out: outQ?.t, t2 });
    }
    // (a line kept for a bot on its break: its rage-quit waits till it is back and has answered, however long)
    const m = take();
    if (m) {
        place(m, sim.human.x + 2, sim.human.z - 1);
        hold(m);
        run(3);
        lib.setAwayForTest(m, true);
        lib.BotChat.onPublicMessage(sim.human, `${m.displayName} where is the bank`);
        run(4);
        const t3 = World.currentTick;
        Md.setMoodForTest(m, { tilt: 0.9 });
        const leaveM = L.leavingNow(m);
        // (past its rage-quit's latest time and a reply's longest wait: still here)
        run(L.LEAVE.rageOut[1] + lib.OWED_REPLY_MOST + 20, () => logouts.some(l => l.name === m.username && l.t >= t3));
        const stayed = !logouts.some(l => l.name === m.username && l.t >= t3) && m.slot !== -1;
        const n3 = said.length;
        lib.setAwayForTest(m, false);
        run(250, () => logouts.some(l => l.name === m.username && l.t >= t3));
        const outM = logouts.find(l => l.name === m.username && l.t >= t3);
        const answerM = said.slice(n3).find(l => l.p === m && l.to === sim.human);
        check('a line kept for a bot on its break: its rage-quit waits till it is back, then the line answered before the logout', leaveM && stayed && outM && answerM && answerM.t <= outM.t, { leave: !!leaveM, stayed, answer: answerM?.text, at: answerM?.t, out: outM?.t });
    }
    Md.setRageScaleForTest(0);
    L.LEAVE.rageLine = 0.8;
}

// ---- hop: a crowded rock cluster ----
if (wants('hop')) {
    scene(SEED, 'hop');
    const six = [take(), take(), take(), take(), take(), take()].filter(Boolean);
    check('six bots for the mine', six.length === 6, six.length);
    // (Lumbridge swamp's east mine; each on its own tile, waiting: a Mine task that has no rock in hand)
    // (the crowd's 2 minutes count from here: the leave pass, every 100 ticks, may see it before t0)
    const placed = World.currentTick;
    six.forEach((p, i) => {
        place(p, 3226 + (i % 3), 3146 + Math.floor(i / 3));
        hold(p, 'Mine');
    });
    run(3);
    L.LEAVE.hopLine = 1;
    L.setLeaveRatesForTest({ hop: 100 });
    const t0 = World.currentTick;
    const n0 = said.length;
    run(500, () => L.leaveLog.some(e => e.reason === 'hop' && e.t >= t0 && e.logout >= 0));
    const e = L.leaveLog.find(x => x.reason === 'hop' && x.t >= t0 && x.logout >= 0);
    const hopper = six.find(p => p.username === e?.name);
    const line = said.slice(n0).find(l => l.p === hopper && l.kind === 'departure');
    if (args.debug) out(`hop six: ${JSON.stringify(six.map(p => [p.username, p.botPlanner, p.x, p.z, p.slot, p.target ? 'target' : null, sim.botPlayer(p)?.currentTask?.name, lib.Moods.sensitivityOf(p).patience.toFixed(2)]))}`);
    if (args.debug) out(`hop: ${JSON.stringify(L.leaveLog.slice(-3))} now ${World.currentTick} pending ${L.leavingNow(hopper ?? six[0]) ? 'yes' : 'no'} stats ${JSON.stringify(L.leaveStats)}`);
    const member = BotManager.members.get(e?.name);
    const away = member ? member.awayUntil - BotManager.playTicks() : -1;
    check('crowded 2 minutes: one hops ("w8 hopping", kind departure)', e && line && line.kind === 'departure' && e.t - placed >= L.LEAVE.hopCrowdTicks, { e, placed, line: line?.text });
    check(`out within 15 s of its line (${e ? e.logout - e.t : '-'} ticks), away 5-20 minutes (${away} play ticks)`, e && e.logout - e.t <= 30 && away >= 450 && away <= 2000, { e, away });
    // (a hopper does not hop again within 3 hours of play: its next crowd is let be)
    check('a bot hops at most once in 3 hours of play', hopper && L.leaveLog.filter(x => x.reason === 'hop' && x.name === hopper.username).length === 1);
    L.setLeaveRatesForTest({ hop: 0 });
    for (const p of six) if (p.slot !== -1) hold(p);
}

// ---- whims: a levelling bot's whim skill first, its task timed; a PKer's fishing break, banked, then its PK task ----
if (wants('whims')) {
    scene(SEED, 'whims');
    const W = lib.Whims;
    // (a fighter's whim: a gathering skill first in its candidates, its task timed to the whim's end)
    const f = free.find(b => b.botPlanner === 'fighter' && b.slot !== -1) ?? take();
    if (free.includes(f)) free.splice(free.indexOf(f), 1);
    W.setWhimForTest(f, { what: 'gather', skill: 'WOODCUTTING' });
    const cands = ['ATTACK', 'STRENGTH', 'DEFENCE', 'FISHING', 'WOODCUTTING'];
    const first = W.whimCandidates(f, cands);
    const fake = { name: 'Woodcut:1521', isComplete: () => false, shouldRun: () => true, tick() {}, reset() {}, interrupt() {}, interrupted: false, activityStep: () => null };
    const timed = W.whimPicked(f, fake);
    const e = W.whimOf(f);
    check('a fighter\'s whim: woodcutting first in its candidates, its task timed (15-40 minutes)', first && cands[0] === 'WOODCUTTING' && timed && timed.name === 'Woodcut:1521' && e.started && e.until - e.from >= 1500 && e.until - e.from <= 4000 && !timed.isComplete(f), { cands, e });
    e.until = World.currentTick;
    check('its task is complete when the whim\'s time is up (then back to its role\'s picks)', timed.isComplete(f) && !fake.isComplete(f));
    W.setWhimForTest(f, null);
    // (a PKer's fishing break by Draynor: its pack cleared as its restock clears it, a net in its bank)
    const pker = extras.find(b => (b.botPlanner === 'extras_pker' || b.botPlanner === 'extras_edgeville_pker') && b.slot !== -1);
    check('a PKer in the world', !!pker, extras.map(b => b.botPlanner));
    if (pker) {
        const ai = sim.botPlayer(pker);
        const bankId = lib.InvType.getId('bank');
        const bank = pker.getInventory(bankId);
        bank.add(lib.Items.SMALL_FISHING_NET, 1);
        place(pker, 3089, 3232);
        // (a PKer's fighting levels, as its PK task sets them: at some seeds it is still at combat 3 here, and Draynor's
        // shrimps are for combat 16+ (FishingTask: the dark wizards), so its break went to a fight elsewhere)
        if (pker.combatLevel < 16) {
            for (const stat of [PlayerStat.ATTACK, PlayerStat.STRENGTH, PlayerStat.DEFENCE, PlayerStat.HITPOINTS]) setLevel(pker, stat, Math.max(40, pker.baseLevels[stat]));
            pker.combatLevel = pker.getCombatLevel();
        }
        pker.levels[PlayerStat.HITPOINTS] = pker.baseLevels[PlayerStat.HITPOINTS];
        ai.currentTask = null;
        W.setWhimForTest(pker, { what: 'pk-break', skill: 'FISHING' });
        const shrimpsBefore = bank.getItemCount(lib.Items.RAW_SHRIMP);
        let fished = -1;
        let sawTask = new Set();
        for (let i = 0; i < 3000 && fished < 0; i++) {
            sim.tick();
            sawTask.add(ai.currentTask?.name?.split(':')[0] ?? 'none');
            if (pker.getInventory(lib.InvType.INV).getItemCount(lib.Items.RAW_SHRIMP) >= 3) fished = i;
        }
        const w = W.whimOf(pker);
        check(`a PKer's whim: a fishing plan by Draynor (shrimps in its pack after ${fished} ticks)`, w && w.started && fished >= 0, { w, tasks: [...sawTask] });
        // (its time up: the bank, then its PK task)
        if (w) w.until = World.currentTick;
        const carried = pker.getInventory(lib.InvType.INV).getItemCount(lib.Items.RAW_SHRIMP);
        let banked = -1;
        let back = -1;
        for (let i = 0; i < 1500 && back < 0; i++) {
            sim.tick();
            if (banked < 0 && bank.getItemCount(lib.Items.RAW_SHRIMP) >= shrimpsBefore + carried && carried > 0) banked = i;
            const name = ai.currentTask?.name ?? '';
            if (banked >= 0 && (name === 'PKer' || name === 'EdgevillePKer')) back = i;
        }
        check(`its time up: what it caught banked (${carried} shrimps, after ${banked} ticks), never wiped by the restock`, banked >= 0 && w.banked, { banked, carried, inBank: bank.getItemCount(lib.Items.RAW_SHRIMP) });
        check(`then back to its PK task (after ${back} ticks)`, back >= 0, ai.currentTask?.name);
        W.setWhimForTest(pker, null);
        // (a level-3 PKer's break by Edgeville: no fishing spot of its level near (Barbarian Village's fly fishing is 20+),
        // and the one-skill planner's pick there is a fight: never that in its place, a 1-Attack pure's levels would go)
        place(pker, 3089, 3495);
        const fighting = [PlayerStat.ATTACK, PlayerStat.STRENGTH, PlayerStat.DEFENCE, PlayerStat.HITPOINTS, PlayerStat.RANGED, PlayerStat.PRAYER, PlayerStat.MAGIC];
        const kept = fighting.map(stat => [stat, pker.baseLevels[stat]]);
        for (const stat of fighting) setLevel(pker, stat, stat === PlayerStat.HITPOINTS ? 10 : 1);
        pker.combatLevel = pker.getCombatLevel();
        const lowLevel = pker.combatLevel;
        ai.currentTask = null;
        W.setWhimForTest(pker, { what: 'pk-break', skill: 'FISHING' });
        const lowTasks = new Set();
        for (let i = 0; i < 60; i++) {
            sim.tick();
            lowTasks.add(ai.currentTask?.name?.split(':')[0] ?? 'none');
        }
        // (its PK task sets its levels again once the break is dropped: the level at the whim's pick)
        check(`a level-3 PKer's break (combat ${lowLevel}): never a fight in its place`, lowLevel < 16 && !lowTasks.has('Combat'), { tasks: [...lowTasks], w: W.whimOf(pker) });
        W.setWhimForTest(pker, null);
        for (const [stat, level] of kept) setLevel(pker, stat, level);
        pker.combatLevel = pker.getCombatLevel();
    }
}

// ---- the 99: near, the mates' PM, the hold, the last action, their gz; its drop party at the nearest bank ----
if (wants('ninety')) {
    scene(SEED, 'ninety');
    const N9 = lib.Ninety;
    const host = take();
    const m1 = take();
    const m2 = take();
    lib.setCliquesForTest([[host.username, m1.username, m2.username]]);
    const logs = lib.Items.LOGS ?? 1511;
    const step = lib.SkillProgression.WOODCUTTING.filter(s => s.itemGained === logs && s.location[2] === 0).sort((a, b) => Math.max(Math.abs(a.location[0] - 3222), Math.abs(a.location[1] - 3218)) - Math.max(Math.abs(b.location[0] - 3222), Math.abs(b.location[1] - 3218)))[0];
    check('a normal-tree step near Lumbridge to stage at', !!step, step?.location);
    const [sx, sz] = step.location;
    place(host, sx, sz);
    place(m1, sx + 20, sz + 2);
    place(m2, sx + 18, sz - 3);
    hold(m1);
    hold(m2);
    // (its axe; woodcutting 98 with three and a half actions of a normal tree to its 99; 30k coins and a kit's things)
    const inv = host.getInventory(lib.InvType.INV);
    inv.removeAll();
    inv.add(lib.Items.BRONZE_AXE, 1);
    const bank = host.getInventory(lib.InvType.getId('bank'));
    bank.add(lib.Items.COINS, 30000);
    bank.add(lib.Items.AIR_RUNE, 300);
    bank.add(lib.Items.MIND_RUNE, 200);
    bank.add(lib.Items.IRON_ORE, 20);
    const wc = PlayerStat.WOODCUTTING;
    const XP99 = lib.getExpByLevel(99);
    const perAction = (step.xpPerAction ?? 250) * (lib.World?.xpRate ?? 1);
    host.stats[wc] = XP99 - Math.round(3.5 * perAction);
    host.baseLevels[wc] = 98;
    host.levels[wc] = 98;
    run(2);
    const task = new lib.WoodcuttingTask(step);
    task.reset();
    const ai = sim.botPlayer(host);
    ai.currentTask = task;
    ai.planEnds = World.currentTick + 30000;
    N9.setNinetyRatesForTest({ mates: 2, party: 2 });
    N9.NINETY.holdGuests = 2;
    lib.resetLineRegistry();
    const nearAt = run(200, () => N9.ninetyRuns().some(r => r.host === host));
    const r9 = N9.ninetyRuns().find(r => r.host === host);
    check(`near (98, under 60k XP to go): its gathering begins (${nearAt} ticks), "almost 99 wc"-like line, its two mates "get the PM"`, r9 && r9.roles.has(m1) && r9.roles.has(m2) && lib.livesLines.some(l => l.name === host.username && l.event === 'arcs-99' && l.kind === 'near'), { roles: r9 && [...r9.roles.values()], lines: lib.livesLines.filter(l => l.name === host.username).map(l => l.text) });
    const holdAt = run(600, () => r9?.record.holdAt !== undefined);
    check(`two actions to go: it holds at its tree (${holdAt} ticks), its line ("wait for every1")`, r9 && r9.record.holdAt !== undefined && sim.botPlayer(host).hasSubTask(), r9?.record);
    run(700, () => r9.record.held !== undefined);
    check(`its mates come and it lets go (held ${r9.record.held} ticks: both within 10 tiles, or 4 minutes with ${r9.record.byAtRelease})`, r9.record.held !== undefined && (r9.record.byAtRelease >= 2 ? r9.record.held < 400 : r9.record.held >= 400), r9.record);
    const n0 = said.length;
    run(600, () => host.baseLevels[wc] >= 99 && r9.record.gz !== undefined);
    run(40);
    const gz = said.slice(n0).filter(l => l.p !== host && lib.livesLines.some(x => x.event === 'arcs-99' && x.kind === 'gz' && x.name === l.name && x.text.toLowerCase() === l.text.toLowerCase()));
    check(`the last action: 99 woodcutting (the game's level-up), the gathering at its peak with ${r9.record.guestsAt} guests by it`, host.baseLevels[wc] === 99 && r9.record.at99 !== undefined && r9.record.guestsAt >= 1, r9.record);
    check(`its guests' gz ("gz on 99!!"): ${gz.length}, a set piece's lines`, gz.length >= 1 && gz.every(l => l.kind === 'setpiece'), gz.map(l => l.text));
    // (its drop party at the nearest bank: 20k+ coins, friendliness over 0: forced here)
    const party = lib.partyLog.find(p => p.own === 'ninety_nine' && p.host === host.username);
    if (lib.personaOf(host.username).friendliness > 0) {
        check('a 99 party at the nearest bank: its own drop party (a kit of its own things)', party && r9.record.party === party.id, { party: party && { id: party.id, venue: party.venue, budget: party.budget }, rec: r9.record.party });
        if (party) {
            run(1500, () => party.outcome !== 'running');
            const taken = party.drops.filter(d => d.by === 'bot').length;
            check(`its piles dropped (${party.drops.length}) and taken after 274's reveal (${taken} by bots)`, party.drops.length >= 4 && party.drops.every(d => d.revealAt < 0 || d.goneAt < 0 || d.by !== 'bot' || d.goneAt >= d.revealAt), { drops: party.drops.length, taken, outcome: party.outcome });
        }
    } else check('a host with friendliness under 0: no 99 party', !party);
    N9.setNinetyRatesForTest({ mates: null, party: null });
    N9.NINETY.holdGuests = 3;
    lib.setCliquesForTest(null);
    for (const p of [host, m1, m2]) if (p.slot !== -1) hold(p);
}

// ---- (the review's C-2, C-3) the 99 off: the Wilderness, a 99 that ended without it, the XP rate, another skill ----
if (wants('ninety-off')) {
    scene(SEED, 'ninety-off');
    const N9 = lib.Ninety;
    const wc = PlayerStat.WOODCUTTING;
    const XP99 = lib.getExpByLevel(99);
    const h = take();
    const mate = take();
    const runOf = p => N9.ninetyRuns().find(r => r.host === p);
    if (h && mate) {
        lib.setCliquesForTest([[h.username, mate.username]]);
        N9.setNinetyRatesForTest({ mates: 2 });
        // (98 woodcutting, 100 XP to go, a woodcutting task: near at once out of the Wilderness)
        setLevel(h, wc, 98);
        h.stats[wc] = XP99 - 1000;
        place(h, 3100, 3540);
        hold(h, 'Woodcut');
        place(mate, 3240, 3236);
        hold(mate);
        N9.resetNinetyForTest(h, true);
        run(60);
        check(`in the Wilderness (level ${lib.wildernessLevelAt(h.x, h.z)}): no 99 gathering`, !runOf(h) && lib.wildernessLevelAt(h.x, h.z) > 0, { at: [h.x, h.z] });
        place(h, 3230, 3232);
        hold(h, 'Woodcut');
        run(60, () => !!runOf(h));
        const r = runOf(h);
        check('out of it: the gathering begins, its mate asked', r && r.roles.has(mate), r && [...r.roles.values()]);
        if (r) {
            run(70, () => r.guests.has(mate));
            const guestTask = r.guests.get(mate);
            place(h, 3100, 3540);
            run(10);
            check(`its host into the Wilderness: the gathering over (${r.record.outcome}), its guest let go`, !runOf(h) && r.record.outcome === 'wilderness' && guestTask && guestTask.isComplete() && sim.botPlayer(mate)?.hasSubTask() !== true, { outcome: r.record.outcome, guest: guestTask?.stage, asked: r.record.asked, came: r.record.came });
            check('that 99 is remembered by name (no gathering for 3 hours of play)', N9.ninetyOffAt(h.username, wc) !== null);
            // (a new session: the near marks forgotten, as at a login; the name's 99 that ended without it is not)
            N9.resetNinetyForTest(h);
            place(h, 3230, 3232);
            hold(h, 'Woodcut');
            run(60);
            check('at its next login: no new gathering for the same 99', !runOf(h));
        }
        N9.setNinetyRatesForTest({ mates: null });
        lib.setCliquesForTest(null);
        place(h, 3230, 3232);
        hold(h);
        hold(mate);
    }
    const h2 = take();
    if (h2) {
        // (at 1x XP: 10k XP to go is not near (the old fixed window was 60k whatever the rate) ...)
        setLevel(h2, wc, 98);
        h2.stats[wc] = XP99 - 100_000;
        place(h2, 3222, 3240);
        hold(h2, 'Woodcut');
        N9.resetNinetyForTest(h2, true);
        run(60);
        check('at 1x XP, 10k XP to go and not measured yet: not near', !runOf(h2));
        // (... but its XP a tick measured, 10 minutes of it or less to go, is)
        N9.resetNinetyForTest(h2, true);
        const nearAt = run(300, () => {
            h2.stats[wc] += 120;
            return !!runOf(h2);
        });
        const r2 = runOf(h2);
        check(`at a measured 120 XP-tenths a tick (its 99 under 10 minutes away): near after ${nearAt} ticks`, r2 && nearAt >= 100, { nearAt, left: XP99 - h2.stats[wc] });
        if (r2) {
            // (its task now another skill's, no XP in woodcutting: the 99 not coming, the gathering over)
            hold(h2, 'Mine');
            run(80, () => !runOf(h2));
            check(`its task another skill's: the gathering over (${r2.record.outcome})`, !runOf(h2) && r2.record.outcome === 'not training', r2.record);
        }
        hold(h2);
    }
}

// ---- a big drop banked, then the session ends; an elated bot's mini party ----
if (wants('drop')) {
    scene(SEED, 'drop');
    const p = take();
    place(p, 3212, 3240);
    hold(p);
    run(3);
    L.setLeaveRatesForTest({ bigDrop: 10 });
    const t0 = World.currentTick;
    const plate = lib.ObjType ? lib.ObjType.getId('rune_platebody') : 1127;
    p.getInventory(lib.InvType.INV).add(plate, 1);
    lib.LIVES.dropValue(p, plate);
    const e = L.leavingNow(p);
    const elated = Md.moodOf(p).elation;
    check(`a rune platebody picked up (57k): a rune drop's elation (${elated.toFixed(2)}), then "gtg bank this lol" and the bank (its sub-task)`, e && e.reason === 'bank-drop' && e.line && sim.botPlayer(p).hasSubTask() && elated > 0.3, { e, elated });
    run(2500, () => logouts.some(l => l.name === p.username && l.t >= t0));
    const out = logouts.find(l => l.name === p.username && l.t >= t0);
    const bank = p.getInventory(lib.InvType.getId('bank'));
    check(`banked (the plate in its bank), then its session over: out ${out ? out.t - t0 : '-'} ticks on`, out && bank.getItemCount(plate) >= 1 && e.asked >= 0 && e.asked - t0 >= 0, { out, asked: e?.asked, inBank: bank.getItemCount(plate) });
    L.setLeaveRatesForTest({ bigDrop: 0 });
    // (an elated bot, friendly and sociable, 20k+ coins: a mini party at its spot)
    const N9 = lib.Ninety;
    const host = free.find(b => b.slot !== -1 && lib.personaOf(b.username).friendliness > 0.2 && lib.personaOf(b.username).sociability > 0.5);
    if (!host) check('a friendly, sociable levelling bot for the mini party (none among these: skipped)', true);
    else {
        free.splice(free.indexOf(host), 1);
        place(host, 3214, 3226);
        hold(host);
        const guest = take();
        if (guest) {
            place(guest, 3218, 3228);
            hold(guest);
        }
        const bank2 = host.getInventory(lib.InvType.getId('bank'));
        bank2.add(lib.Items.COINS, 30000);
        bank2.add(lib.Items.AIR_RUNE, 200);
        bank2.add(lib.Items.IRON_ORE, 10);
        run(3);
        N9.setNinetyRatesForTest({ mini: 10 });
        N9.resetNinetyForTest();
        Md.setMoodForTest(host, { elation: 0.9 });
        const party = lib.partyLog.find(x => x.own === 'mini_party' && x.host === host.username);
        check('elation 0.8+: a mini party (its own drop party at its spot, 4-10 piles planned)', party && party.kitDrops >= 3 && party.kitDrops <= 11, party && { venue: party.venue, drops: party.kitDrops, budget: party.budget });
        if (party) {
            run(1500, () => party.outcome !== 'running');
            check(`its piles dropped (${party.drops.length}), the party over (${party.outcome})`, party.drops.length >= 3 && party.outcome !== 'running', { drops: party.drops.length, outcome: party.outcome });
        }
        Md.setMoodForTest(host, { elation: 0.95 });
        check('at most one a bot in 6 hours of play (a second crossing: none)', lib.partyLog.filter(x => x.own === 'mini_party' && x.host === host.username).length === 1);
        N9.setNinetyRatesForTest({ mini: null });
        if (host.slot !== -1) hold(host);
        if (guest && guest.slot !== -1) hold(guest);
    }
}

// ---- endgame: round 1's hook ----
if (wants('endgame')) {
    scene(SEED, 'endgame');
    const p = levelling.find(b => b.slot !== -1);
    G.setGoalForTest(p, { kind: 'C', target: 100 });
    const scale = lib.endgameOfferScale(p);
    G.setGoalForTest(p, { kind: 'L', stat: PlayerStat.WOODCUTTING, target: 60 });
    const plain = lib.endgameOfferScale(p);
    check('a goal of combat 100 makes its endgame trips 1.5 times as likely; a woodcutting goal leaves them', scale === 1.5 && plain === 1, { scale, plain });
    G.setGoalForTest(p, null);
}

check('no errors', errors.length === 0, errors.slice(0, 5).join(' | '));
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : `: ${c.detail}`}`);
const failed = checks.filter(c => !c.ok).length;
out(failed ? `arcs: ${failed} of ${checks.length} checks failed` : `arcs: all ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
