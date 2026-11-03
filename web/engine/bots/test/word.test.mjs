#!/usr/bin/env node
// Word that travels (bots ideas round 2, theme D: port/BotRumours, port/BotTies, port/BotSlang, the clique stagger in
// port/BotCliques). In the real 274 world, 56 aged
// bots, each scene with its own dice (test/lib/dice.mjs scene), the director, the cliques' doings, habits, hang-outs, the
// arena, random events, trains, alching, scams and witnesses off, every bot held with a stand task:
//   hear      a rumour's telling (a knower's due idle line, LineKind rumour, the line's tag) teaches some of the bots within
//             15 tiles; a clique mate 200 tiles off learns it by "PM" (no line); the human hears it and never becomes a
//             knower; "where?" asked of the teller gets the rumour's place
//   party     a staged drop party at Falador park: a knower 130 tiles away joins as a word guest (PartyRun.addWordGuest)
//             and is at the drop before it; the director's telling prefers a knower among the bots near, else makes its
//             pick one ("heard it from a friend")
//   wrong     a distorted version (a wrong place) heard: a knower walks there, says "wheres the dp??" and is back at its
//             own task within 2 minutes; a hurt knower, or one armed for a random event, does not (a word guest's free
//             rules, port/BotParty wordGuestFree)
//   pk        a pk rumour: a Wilderness trip near its place is skipped (the hook port/BotWildTrips asks), one elsewhere not;
//             a knower on a trip there turns back (its trip ends)
//   rocks     a full mine heard of: a miner of that ore is sent to another mine of it at its walk's start, a free one
//             preferred when heard of
//   ties      two settled bots together a while in two sessions: strength 2, no greeting in the session it formed, a
//             greeting at the next one ("hey again", the chatter rule); the tie restored from the store; it decays a step a
//             day of play apart; tieOf answers theme C
//   grudge    a meant KS: the victim's grudge (2) against the stealer; "u again" at their next meeting; the KS war: a rude
//             grudge-holder's roll x3 against its enemy, never past port/BotRude's caps (maySteal false after a steal); a
//             steal with the human, a kill of the human: no tie; two Edgeville PKers' fight: a rivalry both ways, the rival
//             preferred among valid targets
//   slang     a bot hears another's catchphrase and adopts it (strength 9), says it as its own slot's line, keeps it across a
//             save and restore, and lets it fade; the human saying a catchphrase is never adopted; at the defaults a few
//             bots hearing a phrase 40 times adopt it now and then
//   stagger   a clique mate's login bonus only after its stagger (log-normal, median 10 minutes, 3-30) since the first
//             mate's login, and only for 60 % of the mates; never within 2 minutes; leaving together 1-6 minutes
//   ninety    a 99 to come ('ninety-nine-near'): the bots within 15 of the 99er and its clique mates within 300 know it;
//             knowsRumour's 'ninety_nine:<name>' is that bot's 99 only (theme C's guest list), the plain kind any 99
//   hearsay   a director's drop party: its host is the rumour's subject and never tells it as hearsay; another knower does
//   release   a rumour at its end lets go of its knowers and its run, out of every knower's set; a knower logged out is
//             dropped while it lives; a teller's last telling let go once "where?" is past asking
//   human     no tie, rumour knower or phrase holds the human's name (WT10)
//   errors    none
//
//   node --expose-gc web/engine/bots/test/word.test.mjs [--seed=5]
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
    const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
    if (!text.includes('ExperimentalWarning') && !text.includes('--trace-warnings')) errors.push(text.slice(0, 400));
};
Math.random = mulberry(SEED);

const engineDir = prepareEngineClone('word', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/arcs.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, ArcsStore: S, Rumours: R, Ties: T, Slang: G, Party, Cliques: C } = lib;
const hooks = lib.WordHooks.wordHooks;
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
/** a scene's own dice: Math.random, and theme D's dice seeded from it (port/BotWordHooks) */
const sceneD = name => {
    scene(SEED, name);
    lib.WordHooks.seedWordDiceForTest(null);
};

const N = 56;
/** port/BotRumours' SQUARE_GAP (a map square's one telling per this long) and ANSWER_TICKS ("where?" asked this long after) */
const SQUARE_GAP_TICKS = 200;
const ANSWER_TICKS_TEST = 300;
const sim = await lib.Sim.create({ bots: N, members: true, debug: false, ageNewBots: true, ackLogouts: true, humanName: 'casey', word: true });
sim.addHuman(3222, 3218, 0);
const human = sim.human;
const tick = (n = 1) => {
    for (let i = 0; i < n; i++) sim.tick();
};
const run = (max, until = () => false) => {
    for (let i = 0; i < max; i++) {
        sim.tick();
        if (until()) return i + 1;
    }
    return -1;
};
while (sim.bots().length < N && World.currentTick < 60) sim.tick();
// (the staged world: the doings that would move or recruit the bots off)
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
tick(200);
const bots = sim.bots();
check(`${N} bots in the world`, bots.length === N, bots.length);
const STAND = { name: 'Idle', reset() {}, interrupt() {}, interrupted: false, shouldRun: () => true, isComplete: () => false, tick() {}, activityStep: () => null };
/** held where it is with a stand task of this name (its sub-task cleared), full Hitpoints and run energy, a clean pack */
function hold(p, name = 'Idle') {
    const ai = sim.botPlayer(p);
    ai.currentTask = Object.assign(Object.create(STAND), { name, interrupted: false });
    ai.planEnds = World.currentTick + 1e6;
    if (ai.hasSubTask()) {
        ai._interruptSubTask?.();
        ai._dropSubTask?.();
    }
    p.clearWaypoints();
    p.clearPendingAction();
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
for (const p of bots) hold(p);
const levelling = bots.filter(p => lib.isLevelling(p.botPlanner) && !lib.isNewbie(p));
const used = new Set();
/** the next levelling bot not used by an earlier scene (by a test of its own: a rude one, one of a planner) */
function take(ok = () => true) {
    const p = levelling.find(b => !used.has(b) && ok(b));
    if (p) used.add(p);
    return p ?? null;
}
/** a bot of any planner not used yet, the others first (a scene where any bot can know a rumour: the levelling ones kept) */
function takeAny() {
    const p = bots.find(b => !used.has(b) && !levelling.includes(b)) ?? levelling.find(b => !used.has(b));
    if (p) used.add(p);
    return p ?? null;
}
const said = [];
lib.onArcs('said', e => said.push({ t: World.currentTick, bot: e.bot, text: e.text, kind: e.kind, to: e.to ?? null, arc: e.arc ?? null, catchphrase: e.catchphrase }));
const pool = (event, kind) => lib.arcLines(event, kind).map(t => t.toLowerCase());
/** a said line (as shown: the filter's sentence case) is one of a pool's templates filled */

// ======== hear: a telling, the bots near, a mate's PM, the human ========
{
    sceneD('hear');
    R.resetRumoursForTest();
    R.setRumoursForTest({ tell: 1, pm: 1, distort: 0 });
    const speaker = take();
    const hearers = [];
    for (let i = 0; i < 6; i++) hearers.push(take());
    const mate = take();
    // (east of Lumbridge's castle, off every hub: a bot placed in one notes its arrival, and that event takes its due line)
    const [sx, sz] = [3236, 3236];
    place(speaker, sx, sz);
    hearers.forEach((p, i) => place(p, sx - 6 + (i % 4) * 4, sz - 5 + Math.floor(i / 4) * 8));
    place(mate, 3016, 3360);
    sim.teleportHuman(sx + 2, sz + 2, 0);
    for (const p of [speaker, ...hearers, mate]) hold(p);
    lib.Cliques.setCliquesForTest([[speaker.username, mate.username]]);
    tick(12);
    const r = R.seedForTest.custom('pk', 'kill', { x: 3016, z: 3592, level: 0, say: 'the skeletons' }, 2000, 'test', { pool: 'pk' });
    R.seedForTest.learn(speaker, r, 'seed');
    const k = R.knowledgeOf(mate, r);
    check('a knower\'s clique mate 200+ tiles off learns it by "PM" (no line)', k?.via === 'pm' && cheb(mate, speaker) >= 200 && !said.some(e => e.bot === speaker && e.to === mate), { via: k?.via, d: cheb(mate, speaker) });
    const n0 = said.length;
    // (its due line now; a thread or a talk with a bot near may take it first, as they take any due line: then the next)
    let t = -1;
    for (let attempt = 0; attempt < 4 && t < 0; attempt++) {
        lib.SayChatter.dueNowForTest(speaker);
        t = run(100, () => said.slice(n0).some(e => e.bot === speaker && e.arc));
    }
    const line = said.slice(n0).find(e => e.bot === speaker && e.arc);
    check("the knower's due idle line is the rumour: LineKind rumour, its tag on the 'said' event (the rumour's id and version)", t > 0 && line?.kind === 'rumour' && line.arc?.kind === 'pk' && String(line.arc?.id).startsWith(`${r.id}.`), line && { text: line.text, kind: line.kind, arc: line.arc });
    tick(5);
    const learnt = hearers.filter(p => R.knowledgeOf(p, r)?.via === 'heard');
    check('the bots within 15 tiles that heard it: some learn it (0.6 + 0.3 x curiosity each)', learnt.length >= 2, `${learnt.length} of ${hearers.length}`);
    check('the human heard it and is no knower (only bots are)', cheb(human, speaker) <= 15 && ![...r.knowers.keys()].some(p => p === human || !p.is_bot) && !r.record.names.includes(human.username));
    check('its record: one telling, knowers by seed, heard and PM', r.record.tellings === 1 && r.record.via.seed === 1 && r.record.via.pm >= 1 && r.record.via.heard >= learnt.length, r.record);
    // ("where?": the rumour's place, from the teller)
    const ans = lib.stateAnswer({ bot: speaker, persona: lib.personaNow(speaker), asker: human, raw: 'where?', msg: 'where', pick: list => list[0] });
    check('"where?" asked of the teller: the rumour\'s answer (its place, or an unsure one)', ans?.id === 'rumour' && (/skeletons/.test(ans.text) || pool('word-answer', 'unsure').includes(ans.text)), ans);
    const none = lib.stateAnswer({ bot: hearers[0], persona: lib.personaNow(hearers[0]), asker: human, raw: 'where?', msg: 'where', pick: list => list[0] });
    check('"where?" asked of a bot that told nothing: no rumour answer', none?.id !== 'rumour', none);
    check('knowsRumour (theme C asks through arcsKnows): a knower knows a pk rumour, another bot none', lib.ArcsEvents.arcsKnows(speaker, 'pk') && !lib.ArcsEvents.arcsKnows(take() ?? speaker, 'party'));
    lib.Cliques.setCliquesForTest(null);
    R.setRumoursForTest(null);
}

// ======== party: a word guest from 130 tiles; the director's telling from a knower ========
let partyRun = null;
let partyRumour = null;
let wrongBot = null;
let wrongNote = null;
let wrongLine = null;
let wrongBack = -1;
{
    sceneD('party');
    R.resetRumoursForTest();
    R.setRumoursForTest({ join: 1, joinSociable: 0, distort: 0, wrong: 1, knowers: 200 });
    // (no cliques in this scene: a clique PM would make the far knowers knowers before the test asks them)
    lib.Cliques.setCliquesForTest([]);
    const kitOf = p => Party.planKit(p, 'drop_party', mulberry(1));
    let host = levelling.filter(p => !used.has(p) && Party.coinsOwned(p) >= 5000 && kitOf(p) !== null).sort((a, b) => Party.coinsOwned(b) - Party.coinsOwned(a))[0];
    if (!host) {
        // (no aged bot rich enough at this seed's world: the richest with a kit is topped up to a host's coins)
        host = levelling.filter(p => !used.has(p)).sort((a, b) => Party.coinsOwned(b) - Party.coinsOwned(a))[0];
        const bank = host.getInventory(lib.InvType.getId('bank'));
        bank?.add(Party.coinsItem(), 8000);
    }
    used.add(host);
    place(host, 3013, 3358);
    hold(host);
    const guests = [];
    for (let i = 0; i < 6; i++) guests.push(take());
    guests.forEach((p, i) => {
        place(p, 2988 + (i % 3) * 4, 3362 + Math.floor(i / 3) * 6);
        hold(p);
    });
    const far = take();
    place(far, 3092, 3245);
    hold(far);
    tick(3);
    const ctx = lib.standInContext(true);
    const plan = Party.planDropParty(ctx, 'falador_park');
    const run0 = plan ? lib.startPiece(Party.DROP_PARTY, plan, ctx) : null;
    check('a drop party at Falador park starts (the stand-in director)', run0 !== null, plan ? 'no run' : 'no plan');
    if (run0) {
        partyRun = run0;
        lib.emitArcs({ k: 'set-piece', run: run0, phase: run0.phase });
        const r = R.rumourOfRun(run0);
        partyRumour = r;
        check("the party's rumour at its begin: the host and the bots near the venue know it", r !== null && r.knowers.has(run0.host) && guests.some(g => r.knowers.has(g)) && !r.knowers.has(far), r && { knowers: r.knowers.size });
        const d = cheb(far, { x: run0.venue.drop[0], z: run0.venue.drop[1] });
        R.seedForTest.learn(far, r, 'heard');
        check(`a knower ${d} tiles off, free and in time, comes as a word guest (PartyRun.addWordGuest)`, d >= 120 && d <= 200 && r.record.eligible >= 1 && r.record.acted >= 1 && run0.wordGuests.has(far) && run0.record.wordGuests === run0.wordGuests.size && R.knowledgeOf(far, r)?.acted === 'guest', { d, eligible: r.record.eligible, acted: r.record.acted });
        // (wrong: a knower that heard a distorted version, a wrong place: it walks there, finds nobody, says so, goes back)
        r.versions.push({ place: 'fally west bank', x: 2946, z: 3370, pool: 'party', distorted: true });
        // (but not when it is not free as a word guest at its set-off is: hurt, or armed for a random event; it comes as
        // a word guest then, under the party's own checks)
        const hurt = take();
        const armed = take();
        if (!hurt || !armed) check('two more levelling bots for the wrong place\'s free rules', false);
        else {
            place(hurt, 2972, 3394);
            place(armed, 2974, 3390);
            hold(hurt);
            hold(armed);
            hurt.levels[3] = Math.max(1, Math.floor(hurt.baseLevels[3] * 0.3));
            armed.afkEventReady = true;
            R.seedForTest.learn(hurt, r, 'heard', r.versions.length - 1);
            R.seedForTest.learn(armed, r, 'heard', r.versions.length - 1);
            armed.afkEventReady = false;
            const walked = p => r.record.wrong.some(x => x.name === p.username) || sim.botPlayer(p).subTask?.name === 'WordWalk' || R.knowledgeOf(p, r)?.acted === 'wrong';
            check('a knower of the wrong place at 30 % HP, or armed for a random event: no walk there (wordGuestFree, as at a word guest\'s set-off)', !walked(hurt) && !walked(armed) && R.knowledgeOf(hurt, r) !== null && R.knowledgeOf(armed, r) !== null, { hurt: R.knowledgeOf(hurt, r)?.acted, armed: R.knowledgeOf(armed, r)?.acted, hp: [hurt.levels[3], hurt.baseLevels[3]] });
        }
        wrongBot = take();
        place(wrongBot, 2968, 3392);
        hold(wrongBot);
        R.seedForTest.learn(wrongBot, r, 'heard', r.versions.length - 1);
        wrongNote = r.record.wrong.find(x => x.name === wrongBot.username) ?? null;
        // (the director's telling: a knower among the bots near first, else its own pick made one)
        const stranger = take();
        const knower = guests.find(g => r.knowers.has(g));
        const pick1 = hooks.directorSpeaker(run0, [stranger, knower], stranger);
        const pick2 = hooks.directorSpeaker(run0, [stranger], stranger);
        check("the director's telling: a knower among the bots near first; else its pick, made a knower ('a friend'), each line tagged", pick1.speaker === knower && pick1.tag?.kind === 'party' && pick2.speaker === stranger && R.knowledgeOf(stranger, r)?.via === 'friend' && pick2.tag?.kind === 'party', { p1: pick1.speaker?.username, p2: pick2.speaker?.username });
        let arrived = -1;
        const t0 = World.currentTick;
        const n0 = said.length;
        while (lib.tickPiece(run0) && World.currentTick - t0 < 1200) {
            tick(1);
            if (arrived < 0 && run0.roles.get(far) === 'guest' && cheb(far, { x: run0.venue.drop[0], z: run0.venue.drop[1] }) <= 6) arrived = World.currentTick;
            if (wrongNote && wrongNote.end >= 0 && wrongBack < 0 && !sim.botPlayer(wrongBot).hasSubTask()) wrongBack = World.currentTick - wrongNote.end;
            if (arrived >= 0 && run0.firstDropAt >= 0 && (!wrongNote || wrongBack >= 0 || World.currentTick - t0 > 700)) break;
        }
        wrongLine = wrongBot ? (said.slice(n0).find(e => e.bot === wrongBot && e.kind === 'event') ?? null) : null;
        const firstDrop = run0.firstDropAt >= 0 ? run0.firstDropAt : run0.dropAt;
        check('the word guest is at the drop before it (a guest of the party)', arrived >= 0 && arrived <= firstDrop, { arrived, firstDrop, at: [far.x, far.z], role: run0.roles.get(far) ?? null });
        tick(12);
        check('its record: the word guest came', r.record.wordGuests.find(g => g.name === far.username)?.came === true, r.record.wordGuests);
    }
    R.setRumoursForTest(null);
    lib.Cliques.setCliquesForTest(null);
}

// ======== wrong: a distorted version's wrong place (staged in the party's scene, above) ========
{
    check('a knower that heard a wrong place (a distorted version) walks there (a sub-task)', wrongNote !== null && wrongNote.place === 'fally west bank', wrongNote);
    check('there it says "wheres the dp??" or the like (word-fake, budgeted), its walk over', wrongNote?.arrived && wrongNote.line && wrongLine !== null && partyRumour?.record.fake >= 1, { note: wrongNote, line: wrongLine?.text });
    check('and is back at its own task within 2 minutes', wrongBack >= 0 && wrongBack <= 200 && sim.botPlayer(wrongBot)?.currentTask?.name === 'Idle', { wrongBack });
    R.setRumoursForTest(null);
    if (partyRun) {
        try {
            partyRun.abort('test');
        } catch {
            // (the test's)
        }
        lib.setPieceRunEnded(partyRun);
        lib.emitArcs({ k: 'set-piece', run: partyRun, phase: 'done' });
    }
}

// ======== pk: a trip skipped, a knower turned back ========
{
    sceneD('pk');
    R.resetRumoursForTest();
    const tripper = take();
    place(tripper, 3016, 3600);
    hold(tripper);
    tick(2);
    const task = lib.WildTrips.wildTripTask('skeletons');
    sim.botPlayer(tripper).currentTask = task;
    const r = R.seedForTest.custom('pk', 'kill', { x: 3016, z: 3592, level: 0, say: 'the skeletons' }, 2000, 'test', { pool: 'pk' });
    const avoidBefore = hooks.wildTripAvoid(tripper, 3016, 3592);
    R.seedForTest.learn(tripper, r, 'pm');
    check('a knower on a Wilderness trip near the pk place turns back (its trip ends)', !avoidBefore && task.interrupted === true && R.knowledgeOf(tripper, r)?.acted === 'turned' && r.record.turned === 1, { interrupted: task.interrupted, acted: R.knowledgeOf(tripper, r)?.acted });
    check('its trips near the place are skipped (port/BotWildTrips asks), a spot 200 tiles off is not', hooks.wildTripAvoid(tripper, 3020, 3600) && !hooks.wildTripAvoid(tripper, 3302, 3655) && r.record.avoided >= 1);
    const src = fs.readFileSync(path.join(BOTS_SRC, 'port/BotWildTrips.ts'), 'utf8');
    check("wildTripFor's spots pass the hook (a marked D block)", /\(bots ideas, round 2: D word[^\n]*\n\s*const open = WILD_SPOTS\.filter\([^\n]*wordHooks\.wildTripAvoid/.test(src));
    hold(tripper);
}

// ======== rocks: a full mine avoided, a free one preferred ========
{
    sceneD('rocks');
    R.resetRumoursForTest();
    const miner = take();
    hold(miner);
    const level = miner.baseLevels[lib.PlayerStat.MINING];
    const steps = (lib.SkillProgression.MINING ?? []).filter(s => s.action === 'mine' && level >= s.minLevel && level <= s.maxLevel && s.location[2] === 0 && lib.wildernessLevelAt(s.location[0], s.location[1]) <= 0 && R.mineSay(s.location[0], s.location[1]) !== null);
    // (an ore with steps at two mines or more, for the miner's level)
    const byOre = new Map();
    for (const s of steps) {
        const list = byOre.get(s.itemGained) ?? [];
        if (!list.some(x => Math.max(Math.abs(x.location[0] - s.location[0]), Math.abs(x.location[1] - s.location[1])) <= 20)) list.push(s);
        byOre.set(s.itemGained, list);
    }
    const pair = [...byOre.values()].find(list => list.length >= 2);
    if (!pair) check('a mining level with an ore at two mines', false, { level, steps: steps.length });
    else {
        const [fullStep, other] = pair;
        const informer = take();
        R.seedForTest.rocks(informer, fullStep, 'full');
        const r = R.liveRumours().find(x => x.kind === 'rocks' && x.sub === 'full');
        R.seedForTest.learn(miner, r, 'heard');
        const alt = hooks.rocksStep(miner, fullStep);
        const away = alt && Math.max(Math.abs(alt.location[0] - fullStep.location[0]), Math.abs(alt.location[1] - fullStep.location[1])) > 20;
        check(`a full mine heard of ("${r?.slots.ore} all taken at ${r?.slots.mine}"): the miner of that ore goes to another mine of it`, alt !== null && away && alt.itemGained === fullStep.itemGained, alt && { at: alt.location, full: fullStep.location });
        R.setRumoursForTest({ freePick: 1, freeSeed: 1 });
        const lone = take();
        R.seedForTest.rocks(lone, other, 'free');
        const free = R.liveRumours().find(x => x.kind === 'rocks' && x.sub === 'free');
        const miner2 = take();
        hold(miner2);
        miner2.baseLevels[lib.PlayerStat.MINING] = level;
        R.seedForTest.learn(miner2, free, 'heard');
        const alt2 = hooks.rocksStep(miner2, fullStep);
        check('a free mine heard of: preferred (its step there)', alt2 !== null && Math.max(Math.abs(alt2.location[0] - other.location[0]), Math.abs(alt2.location[1] - other.location[1])) <= 20, alt2 && alt2.location);
        R.setRumoursForTest(null);
    }
}

// ======== ties: two sessions together, a greeting at the next; the store; decay ========
{
    sceneD('ties');
    S.resetArcsForTest();
    T.resetTiesForTest();
    T.setTiesForTest({ form: 1, formSociable: 0, together: 250, greet: 1, greetSociable: 0, greetBack: 1 });
    const a = take();
    // (not clique mates: they have the cliques' own greeting)
    const b = take(p => !lib.Cliques.sameClique(a.username, p.username));
    place(a, 3245, 3155);
    place(b, 3247, 3157);
    hold(a, 'Fish');
    hold(b, 'Fish');
    tick(2);
    check('two levelling bots at the same task kind, standing, are settled (the same group)', T.tieForTest.groupOf(a) === 'L:Fish' && T.tieForTest.groupOf(b) === 'L:Fish', [T.tieForTest.groupOf(a), T.tieForTest.groupOf(b)]);
    run(300, () => T.tieStrength(a.username, b.username, 1) >= 1);
    const s1 = [T.tieStrength(a.username, b.username, 1), T.tieStrength(b.username, a.username, 1)];
    check('a while together in a session: their tie +1, both ways', s1[0] === 1 && s1[1] === 1, { s1, together: T.togetherTicks(a, b) });
    // (a second session: their time together again)
    T.newSessionForTest(a, b);
    const pairOf = e => (e.a === a.username && e.b === b.username) || (e.a === b.username && e.b === a.username);
    const l0 = T.tieLog.length;
    run(300, () => T.tieStrength(a.username, b.username, 1) >= 2);
    tick(30);
    const s2 = T.tieStrength(a.username, b.username, 1);
    const greetedNow = T.tieLog.slice(l0).some(e => e.kind === 'greet' && pairOf(e));
    check('a second session together: strength 2 (known), and no greeting in the session it formed', s2 === 2 && !greetedNow, { s2, greetedNow });
    check('tieOf (theme C asks through arcsTie): the acquaintance 2, no grudge', lib.ArcsEvents.arcsTie(a.username, b.username)?.acquaintance === 2 && lib.ArcsEvents.arcsTie(a.username, b.username)?.grudge === 0);
    // (the next session: a greeting at their first meeting, the other's answer; the clique greeting's rule)
    T.newSessionForTest(a, b);
    const n1 = said.length;
    const l1 = T.tieLog.length;
    run(100, () => T.tieLog.slice(l1).some(e => e.kind === 'greet-back' && pairOf(e)));
    const greetNote = T.tieLog.slice(l1).find(e => e.kind === 'greet' && pairOf(e));
    const g = greetNote ? (greetNote.a === a.username ? a : b) : null;
    const greet = g ? said.slice(n1).find(e => e.bot === g && e.to === (g === a ? b : a)) : null;
    check('the next session: a greeting at their first meeting ("hey again", "sup {nick}" ...), said to the other (LineKind event)', greet !== null && greet?.kind === 'event', greet ? { text: greet.text, kind: greet.kind } : { note: greetNote ?? null, clique: lib.Cliques.sameClique(a.username, b.username), s: T.tieStrength(a.username, b.username, 1), d: cheb(a, b), log: T.tieLog.slice(l1).map(e => `${e.kind}:${e.a}>${e.b}`), stats: T.tieStats, said: said.slice(n1).filter(e => e.bot === a || e.bot === b).map(e => e.text) });
    check('and the answer ("hey", "lol hi" ...), once a session', T.tieLog.slice(l1).filter(e => e.kind === 'greet-back' && pairOf(e)).length === 1 && T.tieLog.slice(l1).filter(e => e.kind === 'greet' && pairOf(e)).length === 1);
    // (the store: the tie round a save and a restore)
    const play = lib.arcsPlay();
    const raw = S.exportArcs(play);
    S.resetArcsForTest();
    S.restoreArcs(JSON.parse(JSON.stringify(raw)), play, () => true);
    check('the tie restored from the store (strength 2 both ways)', T.tieStrength(a.username, b.username, 1, play) === 2 && T.tieStrength(b.username, a.username, 1, play) === 2);
    check('it decays a step a day of play apart: 1 after 24 h, gone after 48 h', T.tieStrength(a.username, b.username, 1, play + 144_000) === 1 && T.tieStrength(a.username, b.username, 1, play + 288_000) === 0);
    T.setTiesForTest(null);
}

// ======== grudge: a meant KS, "u again", the KS war within the caps; the human; Edgeville rivals ========
{
    sceneD('grudge');
    T.setTiesForTest({ grudgeLine: 1, grudgeBack: 1 });
    const rude = take(p => lib.Rude.rudeActs(p));
    const stealer = take();
    const polite = take(p => !lib.Rude.rudeActs(p));
    if (!rude || !stealer || !polite) check('a rude and a polite levelling bot to stage', false, { rude: !!rude, polite: !!polite });
    else {
        place(rude, 3255, 3255);
        place(stealer, 3258, 3257);
        hold(rude);
        hold(stealer);
        tick(2);
        // (a meant KS: the stealer took the rude one's cow)
        lib.noteSteal('ks', stealer, rude, { x: 3257, z: 3256 }, false, 'single');
        check("a meant KS: the victim's grudge against the stealer (2), none the other way", T.tieStrength(rude.username, stealer.username, -1) === 2 && T.tieStrength(stealer.username, rude.username, -1) === 0);
        check('the KS war: a rude grudge-holder\'s steal roll x3 against its enemy; 1 against another, 1 for a polite one', hooks.stealFactor(rude, stealer) === 3 && hooks.stealFactor(rude, polite) === 1 && hooks.stealFactor(polite, stealer) === 1);
        lib.Rude.startSteal(rude, stealer, { x: 1, z: 1 });
        check("and never past port/BotRude's caps: after a steal, maySteal is false (15 minutes), whatever the factor", !lib.Rude.maySteal(rude, false) && hooks.stealFactor(rude, stealer) === 3);
        // ("u again" at their next meeting)
        T.newSessionForTest(rude, stealer);
        const n0 = said.length;
        const l0 = T.tieLog.length;
        const debt0 = lib.SayChatter.chatterStateOf(rude)?.debt ?? 0;
        run(80, () => T.tieLog.slice(l0).some(e => e.kind === 'grudge-back' && e.a === stealer.username));
        const note = T.tieLog.slice(l0).find(e => e.kind === 'grudge' && e.a === rude.username && e.b === stealer.username);
        const line = said.slice(n0).find(e => e.bot === rude && e.to === stealer);
        check('their next meeting: "u again", "{nick} the ks guy" ... to its enemy (its own slot: a line owed), the other\'s answer', note?.why === 'ks' && line !== undefined && T.tieLog.slice(l0).some(e => e.kind === 'grudge-back' && e.a === stealer.username && e.b === rude.username), { note, line: line?.text, debt0 });
        // (the human: no tie either way)
        lib.noteSteal('ks', stealer, human, { x: 3259, z: 3258 }, false, 'single');
        lib.emitArcs({ k: 'kill', killer: stealer, victim: human, edge: false });
        lib.emitArcs({ k: 'kill', killer: human, victim: polite, edge: false });
        check("a steal from the human, a kill of the human, the human's kill: no tie (bots only)", S.peekArcs(human.username) === undefined && !(S.peekArcs(stealer.username)?.ties ?? []).some(t => t.other === human.username) && !(S.peekArcs(polite.username)?.ties ?? []).some(t => t.other === human.username));
    }
    // (Edgeville PKers: a fight at the edge makes rivals; the rival preferred among the valid targets)
    const edge = bots.filter(p => p.botPlanner === 'extras_edgeville_pker').slice(0, 2);
    if (edge.length < 2) check('two Edgeville PKers to stage', false, edge.length);
    else {
        const [k1, k2] = edge;
        place(k1, 3090, 3530);
        place(k2, 3096, 3534);
        hold(k1);
        hold(k2);
        tick(2);
        lib.emitArcs({ k: 'kill', killer: k1, victim: k2, edge: true });
        check('an Edgeville PKer killed by another: a rivalry both ways (the victim 2, the killer 1)', T.tieStrength(k2.username, k1.username, -1) === 2 && T.tieStrength(k1.username, k2.username, -1) === 1);
        check('the rival preferred among valid targets at the edge; none when it is not valid', hooks.rival(k2, 15, () => true) === k1 && hooks.rival(k2, 15, p => p !== k1) === null && hooks.rival(rude ?? k2, 15, () => true) === null);
        hold(k1);
        hold(k2);
    }
    T.setTiesForTest(null);
}

// ======== slang: a phrase adopted, said, saved, faded; the human's never ========
{
    sceneD('slang');
    S.resetArcsForTest();
    G.resetSlangForTest();
    const speaker = take();
    const hearer = take();
    place(speaker, 3200, 3240);
    place(hearer, 3203, 3242);
    hold(speaker);
    hold(hearer);
    tick(2);
    const own = p => lib.catchphrasesOf(p.username, lib.personaNow(p)).filter(l => !l.borrowed).map(l => l.phrase);
    const phrase = own(speaker).find(i => !own(hearer).includes(i));
    if (phrase === undefined) check('a phrase the hearer has not', false);
    else {
        // (forced: 2 x (0.5 + sociability) is at least 1)
        G.setSlangForTest({ adopt: 2 });
        const text = lib.CATCHPHRASE_LIST[phrase];
        lib.botSayForTest(speaker, text, phrase);
        tick(2);
        const rec = S.peekArcs(hearer.username)?.phrases?.find(p => p.phrase === phrase);
        check("a bot hears another's catchphrase and adopts it (strength 9)", rec?.strength === 9 && G.slangLog.some(e => e.name === hearer.username && e.from === speaker.username), rec);
        const lines = lib.catchphrasesOf(hearer.username, lib.personaNow(hearer));
        const borrowed = lines.find(l => l.borrowed && l.phrase === phrase);
        check('its catchphrases now hold it, borrowed, at its strength\'s weight (the same slot as its own)', borrowed && borrowed.tag.weight === 1 && lines.filter(l => !l.borrowed).length === own(hearer).length, borrowed);
        const play = lib.arcsPlay();
        const raw = S.exportArcs(play);
        S.resetArcsForTest();
        S.restoreArcs(JSON.parse(JSON.stringify(raw)), play, () => true);
        check('saved and restored with the arcs', S.peekArcs(hearer.username)?.phrases?.some(p => p.phrase === phrase && p.strength === 9));
        check('it fades: weaker after an hour unsaid, gone after 4.5 hours', G.borrowedPhrases(hearer.username).length === 1 && (lib.setPlayForTest(play + 6000), G.borrowedPhrases(hearer.username)[0]?.weight === 7 / 9) && (lib.setPlayForTest(play + 27_000), G.borrowedPhrases(hearer.username).length === 0));
        lib.setPlayForTest(null);
        // (the human says another catchphrase beside them: never adopted)
        const other = lib.CATCHPHRASE_LIST.findIndex((t, i) => i !== phrase && !own(hearer).includes(i) && !own(speaker).includes(i));
        sim.teleportHuman(3201, 3241, 0);
        lib.BotChat.onPublicMessage(human, lib.CATCHPHRASE_LIST[other]);
        tick(3);
        check("the human saying a catchphrase: never adopted (bots pick up only each other's)", ![speaker, hearer].some(p => S.peekArcs(p.username)?.phrases?.some(x => x.phrase === other)));
        // (the defaults: four bots hearing a phrase 40 times adopt it now and then: 0.03 x (0.5 + sociability) a hearing)
        G.setSlangForTest(null);
        const crowd = [take(), take(), take(), take()].filter(Boolean);
        crowd.forEach((p, i) => {
            place(p, 3196 + i * 2, 3236);
            hold(p);
        });
        const fresh = lib.CATCHPHRASE_LIST.findIndex((t, i) => !crowd.some(p => own(p).includes(i)) && !own(speaker).includes(i));
        for (let i = 0; i < 40; i++) {
            lib.botSayForTest(speaker, lib.CATCHPHRASE_LIST[fresh], fresh);
            tick(2);
        }
        const adopted = crowd.filter(p => S.peekArcs(p.username)?.phrases?.some(x => x.phrase === fresh)).length;
        const expect = crowd.map(p => 1 - Math.pow(1 - 0.03 * (0.5 + lib.personaNow(p).sociability), 40));
        check('at the defaults, 40 hearings: adopted now and then (0.03 x (0.5 + sociability) a hearing)', adopted >= 1 || expect.every(x => x < 0.5), { adopted, expect: expect.map(x => x.toFixed(2)) });
    }
}

// ======== stagger: a mate's login bonus after its stagger, 60 % of the mates; leaving together 1-6 minutes ========
{
    sceneD('stagger');
    const names = lib.BOT_NAMES;
    let none = 0;
    const draws = [];
    for (let i = 0; i < 2000; i++) {
        const s = C.staggerOf(names[i % 500], names[(i * 7 + 3) % 500], 1000 + i * 37);
        if (s === null) none++;
        else draws.push(s);
    }
    draws.sort((a, b) => a - b);
    const median = draws[draws.length >> 1];
    check('the stagger: 60 % of the mates answer (the rest keep their own schedule)', none / 2000 >= 0.35 && none / 2000 <= 0.45, none / 2000);
    check('the stagger: log-normal, median about 10 minutes, within 3-30 minutes, never within 2', median >= 800 && median <= 1250 && draws[0] >= 300 && draws.at(-1) <= 3000, { median, lo: draws[0], hi: draws.at(-1) });
    // (the bonus: a clique of three, the first logs in; a mate answering gets it only after its stagger)
    // (three names of the pool that are not in the world: their logins are the test's)
    const trio = [names[400], names[408], names[416]];
    C.setCliquesForTest([trio]);
    C.setCliqueBehaviourForTest(true);
    const play0 = 50_000;
    lib.setPlayForTest(play0);
    lib.emitArcs({ k: 'login', name: trio[0], bot: null });
    const online = n => n === trio[0];
    const answering = trio.slice(1).find(n => C.staggerOf(n, trio[0], play0) !== null);
    if (!answering) check('a mate that answers (60 %)', false);
    else {
        const st = C.staggerOf(answering, trio[0], play0);
        lib.setPlayForTest(play0 + st - 1);
        const before = C.cliqueReturnBonus(answering, online);
        lib.setPlayForTest(play0 + st);
        const after = C.cliqueReturnBonus(answering, online);
        // (another mate logs in: the stagger counts from the clique's latest login again)
        lib.setPlayForTest(play0 + st + 50);
        lib.emitArcs({ k: 'login', name: trio.find(n => n !== answering && n !== trio[0]), bot: null });
        lib.setPlayForTest(play0 + st + 50 + st - 1);
        const again = C.cliqueReturnBonus(answering, online);
        lib.setPlayForTest(play0 + st + 50 + st);
        const later = C.cliqueReturnBonus(answering, online);
        lib.emitArcs({ k: 'logout', name: trio.find(n => n !== answering && n !== trio[0]), bot: null });
        check(`a mate's login bonus: none before its stagger (${st} ticks) since the clique's latest login, the bonus after`, before === 0 && after > 0 && again === 0 && later > 0, { before, after, again, later });
    }
    const own = trio.slice(1).find(n => C.staggerOf(n, trio[0], play0) === null);
    if (own) {
        lib.setPlayForTest(play0 + 5000);
        check('a mate that keeps its own schedule: no bonus however long', C.cliqueReturnBonus(own, online) === 0);
    }
    lib.emitArcs({ k: 'logout', name: trio[0], bot: null });
    lib.setPlayForTest(null);
    C.setCliquesForTest(null);
    C.setCliqueBehaviourForTest(false);
    const src = fs.readFileSync(path.join(BOTS_SRC, 'port/BotCliques.ts'), 'utf8');
    check('leaving together: the friend\'s "me too" logout 1-6 minutes on (LEAVE_SOON 100-600 play ticks)', /const LEAVE_SOON: \[number, number\] = \[100, 600\];/.test(src));
}

// ======== ninety: a 99 to come, its knowers; knowsRumour by the 99er's name ========
{
    sceneD('ninety');
    R.resetRumoursForTest();
    R.setRumoursForTest({ knowers: 200 });
    const hostA = takeAny();
    const nearA = takeAny();
    const mateA = takeAny();
    const farA = takeAny();
    const hostB = takeAny();
    if (!hostA || !nearA || !mateA || !farA || !hostB) check('five bots for the 99 scene', false);
    else {
        // (a clique of the 99er and its mate only: the near bot's and the far one's PMs are not the test's)
        lib.Cliques.setCliquesForTest([[hostA.username, mateA.username]]);
        place(hostA, 3176, 3300);
        place(nearA, 3180, 3304);
        place(mateA, 3176, 3420);
        place(farA, 3176, 3480);
        place(hostB, 2990, 3330);
        for (const p of [hostA, nearA, mateA, farA, hostB]) hold(p);
        tick(3);
        // (as theme C emits it, before its guest list: port/BotNinetyNine startNinetyNine)
        lib.emitArcs({ k: 'ninety-nine-near', bot: hostA, stat: 8, venue: { x: hostA.x, z: hostA.z, level: 0, say: 'lumby' }, detail: { skill: 'wc' } });
        lib.emitArcs({ k: 'ninety-nine-near', bot: hostB, stat: 10, venue: { x: hostB.x, z: hostB.z, level: 0, say: 'fally' }, detail: { skill: 'fishing' } });
        const knows = (p, h) => lib.ArcsEvents.arcsKnows(p, `ninety_nine:${h.username}`);
        const rA = R.liveRumours().find(x => x.sub === 'ninety_nine' && x.subject === hostA.username);
        check("a 99 to come: its rumour, known by the 99er, the bots within 15 (seed) and its clique mates within 300 ('the PM'), not a bot 180 off", rA && knows(hostA, hostA) && R.knowledgeOf(nearA, rA)?.via === 'seed' && R.knowledgeOf(mateA, rA)?.via === 'pm' && !knows(farA, hostA), rA && { via: rA.record.via, knowers: rA.knowers.size, d: [cheb(nearA, hostA), cheb(mateA, hostA), cheb(farA, hostA)] });
        check("knowsRumour 'ninety_nine:<name>': that bot's 99 only (theme C's guest list), not another's", knows(nearA, hostA) && !knows(nearA, hostB) && knows(hostB, hostB) && !knows(hostB, hostA));
        check("the plain kind keeps its meaning: 'ninety_nine' is any 99's, 'party' any party's", lib.ArcsEvents.arcsKnows(nearA, 'ninety_nine') && lib.ArcsEvents.arcsKnows(hostB, 'party') && !lib.ArcsEvents.arcsKnows(farA, 'ninety_nine'));
        lib.Cliques.setCliquesForTest(null);
    }
    R.setRumoursForTest(null);
}

// ======== hearsay: a director's party's host never tells it as hearsay ========
{
    sceneD('hearsay');
    R.resetRumoursForTest();
    R.setRumoursForTest({ tell: 1, distort: 0 });
    lib.Cliques.setCliquesForTest([]);
    const host = takeAny();
    const other = takeAny();
    if (!host || !other) check('two bots for the hearsay scene', false);
    else {
        // (both 200+ tiles from the venue, in one map square: the host asked first, so the square's gap is not the reason)
        place(host, 3200, 3300);
        place(other, 3204, 3302);
        hold(host);
        hold(other);
        tick(3);
        // (a director's drop party as it stands: its host's part, no word guests taken)
        const piece = { id: -1, kind: 'drop_party', phase: 'announce', venue: { key: 'falador_park', x: 3001, z: 3376, level: 0, say: 'fally park' }, endsBy: World.currentTick + 2000, roles: new Map([[host, 'host']]), host };
        const r = R.seedForTest.run(piece, 'director');
        R.seedForTest.learn(other, r, 'heard');
        const hostTold = R.seedForTest.tell(host, World.currentTick);
        let otherTold = false;
        for (let i = 0; i < 3 && !otherTold; i++) otherTold = R.seedForTest.tell(other, World.currentTick);
        check("a director's drop party: its host is the rumour's subject (an insider) and never tells it as hearsay; another knower there does", r?.subject === host.username && r.knowers.has(host) && !hostTold && otherTold, { subject: r?.subject, hostTold, otherTold });
        // (after the party: its parts let go, the host still its subject)
        piece.roles.clear();
        tick(SQUARE_GAP_TICKS + 1);
        check('after the party (its parts let go): the host still never tells it', !R.seedForTest.tell(host, World.currentTick));
        hold(host);
        hold(other);
    }
    lib.Cliques.setCliquesForTest(null);
    R.setRumoursForTest(null);
}

// ======== release: a rumour at its end lets go of its knowers, its run; logged-out knowers; a teller's last telling ========
{
    sceneD('release');
    R.resetRumoursForTest();
    R.setRumoursForTest({ tell: 1, distort: 0, missed: 0 });
    lib.Cliques.setCliquesForTest([]);
    const a = takeAny();
    const b = takeAny();
    if (!a || !b) check('two bots for the release scene', false);
    else {
        place(a, 3176, 3240);
        place(b, 3180, 3244);
        hold(a);
        hold(b);
        tick(3);
        const piece = { id: -2, kind: 'drop_party', phase: 'announce', venue: { key: 'falador_park', x: 3001, z: 3376, level: 0, say: 'fally park' }, endsBy: World.currentTick + 40, roles: new Map() };
        const r = R.seedForTest.custom('party', 'drop_party', { x: 3001, z: 3376, level: 0, say: 'fally park' }, 60, 'test', { run: piece, pool: 'party' });
        R.seedForTest.learn(a, r, 'heard');
        R.seedForTest.learn(b, r, 'heard');
        // (a knower of an ended session: a Player let go by the world, slot -1)
        const gone = { slot: -1, username: 'gone', is_bot: true };
        r.knowers.set(gone, { at: World.currentTick, version: 0, told: 0, via: 'heard', acted: null });
        let told = false;
        for (let i = 0; i < 3 && !told; i++) told = R.seedForTest.tell(a, World.currentTick);
        tick(12);
        check('a knower logged out is dropped while the rumour lives (its session its own Player)', !r.knowers.has(gone) && r.knowers.has(a) && r.knowers.has(b) && R.liveRumours().includes(r), { size: r.knowers.size });
        run(80, () => !R.liveRumours().includes(r) && r.knowers.size === 0);
        check('at its end: its knowers and its run let go, out of every knower\'s set', !R.liveRumours().includes(r) && r.knowers.size === 0 && r.run === null && !R.knownSetForTest(a).includes(r) && !R.knownSetForTest(b).includes(r), { size: r.knowers.size, run: r.run !== null, inA: R.knownSetForTest(a).includes(r) });
        check('the teller\'s last telling holds only the let-go record', told && R.lastToldForTest(a) === r, { told });
        tick(ANSWER_TICKS_TEST + 5);
        const ans = lib.stateAnswer({ bot: a, persona: lib.personaNow(a), asker: human, raw: 'where?', msg: 'where', pick: list => list[0] });
        check('past asking ("where?" 3 minutes on): no rumour answer, its last telling let go', ans?.id !== 'rumour' && R.lastToldForTest(a) === null, { ans: ans?.id ?? null });
        hold(a);
        hold(b);
    }
    lib.Cliques.setCliquesForTest(null);
    R.setRumoursForTest(null);
}

// ======== human: no tie, knower or phrase with the human's name ========
{
    const names = new Set();
    for (const [name, rec] of S.arcsEntries()) {
        names.add(name);
        for (const t of rec.ties ?? []) names.add(t.other);
    }
    for (const r of R.rumourLog) for (const n of r.names) names.add(n);
    for (const e of G.slangLog) {
        names.add(e.name);
        names.add(e.from);
    }
    check("no tie, rumour knower or borrowed phrase holds the human's name (WT10)", names.size > 0 && !names.has(human.username), { names: names.size });
}

check('no errors', errors.length === 0, errors.slice(0, 5).join(' | '));
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : `: ${c.detail}`}`);
const failed = checks.filter(c => !c.ok).length;
out(failed ? `word: ${failed} of ${checks.length} checks failed` : `word: all ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
