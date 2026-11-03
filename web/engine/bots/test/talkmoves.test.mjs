#!/usr/bin/env node
// Talk moves (bots ideas round 3, theme H: port/BotTalkMoves' walk up to talk and stop to talk, BotThreads' and
// BotHabits' marked
// blocks), in the real 274 world (members, a few aged bots; the director, the cliques' doings, habits,
// hang-outs, the arena, random events, trains, alching, scams, witnesses and teleport spells off), each scene on its own
// dice (test/lib/dice.mjs scene), every piece of theme H off but the scene's own (setMovementRatesForTest), the bots held
// with stand tasks (a walker's tick walks: BotAction walkTo), in an open field away from the human:
//   walkup    two bots 9 tiles apart, a thread forced with the walk-up forced: the opener walks up and is within 3 tiles of
//             its partner when the first line is said; its tile was claimed and is given back after
//   walking   a walking partner is held through the thread (no waypoints, no step) and walks on within 6 ticks of the last
//             line; the opener standing at its spot is held too
//   never     a fighting bot (its combat lock), a PKer, a bot in the Wilderness, a vendor and a noHoldWhile hook's bot are
//             never held (talkHoldable false, holdForTalk refused); a walking PKer in a thread keeps walking; a bot
//             working its resource (an interaction) is not held by a thread
//   hit       a hit ends a hold at once
//   human     the human's line to a held bot ends the hold, and the bot answers it
//   stranger  a walking opener with a stranger 8 tiles off opens no thread ('walking'); with the walk-ups off it does
//   off       with theme H off a thread draws no dice of H's and holds nobody
//   errors    none
//
//   node --expose-gc web/engine/bots/test/talkmoves.test.mjs [--seed=5] [--only=walkup,walking,...]
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

const engineDir = prepareEngineClone('talkmoves', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/movement.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, Minimap: M, TalkMoves: TM, Threads: T } = lib;

const N = 30;
const sim = await lib.Sim.create({ bots: N, members: true, debug: false, ageNewBots: true, humanName: 'casey' });
sim.addHuman(3222, 3218, 0);
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
for (let i = 0; i < 40; i++) sim.tick();
const all = sim.bots();
check(`${N} bots in the world`, all.length === N, all.length);
const SHOW = process.env.TM_DEBUG ? out : () => {};
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const said = [];
lib.sayListeners.push((player, text, kind, to) => said.push({ t: World.currentTick, name: player.username, text, kind, to: to?.username ?? null }));
const tick = (n = 1) => {
    for (let i = 0; i < n; i++) sim.tick();
};

const STAND = { name: 'Idle', reset() {}, interrupt() {}, interrupted: false, shouldRun: () => true, isComplete: () => false, tick() {}, activityStep: () => null };
/** the bot held with a stand task of this name whose tick does `drive` (its sub-task cleared), full HP and run energy */
function hold(p, name = 'Idle', drive = null) {
    const ai = sim.botPlayer(p);
    ai.currentTask = Object.assign(Object.create(STAND), { name, interrupted: false, tick: drive ? player => drive(player) : () => {} });
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
// (the talkers: sociable levelling bots, no newbies, no extras, none a clique mate of another)
const talkers = all.filter(p => lib.isLevelling(p.botPlanner) && !lib.isNewbie(p) && lib.personaOf(p.username, p.botPlanner).sociability >= 0.3);
const levelling = all.filter(p => lib.isLevelling(p.botPlanner) && !lib.isNewbie(p));
const pairOf = (n = 2, used = new Set(), from = talkers) => {
    const out = [];
    for (const p of from) {
        if (used.has(p) || out.some(q => lib.BotCliques.sameClique(q.username, p.username))) continue;
        out.push(p);
        if (out.length === n) break;
    }
    for (const p of out) used.add(p);
    return out;
};
// (each scene its own bots of the lists, rotated a few each scene: the same pair seldom twice)
let used = new Set();
let rotation = 0;
const nextScene = () => {
    used = new Set();
    rotation += 3;
    talkers.push(...talkers.splice(0, 3 % Math.max(1, talkers.length)));
    levelling.push(...levelling.splice(0, 3 % Math.max(1, levelling.length)));
};
SHOW(`talkers ${talkers.length}, levelling ${levelling.length}`);
/** an open, flat field (west of Lumbridge's windmill road): walkable 14 tiles east of each base */
const FIELD = [3160, 3240];
const open = (x, z, w = 14) => {
    for (let i = 0; i <= w; i++) if (!sim.isWalkable(x + i, z, 0)) return false;
    return true;
};
let base = null;
for (let dz = 0; dz < 30 && !base; dz += 2) for (let dx = 0; dx < 30 && !base; dx += 3) if (open(FIELD[0] + dx, FIELD[1] + dz) && open(FIELD[0] + dx, FIELD[1] + dz + 3)) base = [FIELD[0] + dx, FIELD[1] + dz];
check('an open field for the scenes', base !== null, base);
sim.teleportHuman(base[0] + 30, base[1] + 30, 0);
/** a thread forced between a and b (a few tries: its area's gap, its topic) */
function force(a, b, depth = 4) {
    T.resetThreadsForTest();
    for (let i = 0; i < 6; i++) if (T.startThread(a, 'test', b, depth)) return true;
    return false;
}
const linesOf = (from, a, b) => said.slice(from).filter(s => s.kind === 'practice' && ((s.name === a.username && s.to === b.username) || (s.name === b.username && s.to === a.username)));

// ---- walkup (H3) ----
if (want('walkup')) {
    scene(SEED, 'walkup');
    nextScene();
    M.setMovementRatesForTest({ ...M.MOVEMENT_OFF, walkUp: 100, holds: 1 });
    const [a, b] = pairOf(2, used);
    place(a, base[0], base[1]);
    place(b, base[0] + 9, base[1]);
    tick(3);
    const from = said.length;
    const w0 = TM.talkMoveStats.walkUps;
    let firstAt = -1;
    let gapAtFirst = -1;
    let claimed = null;
    const started = force(a, b);
    for (let t = 0; t < 200; t++) {
        tick();
        claimed = claimed ?? TM.talkHoldOf(a)?.walk ?? null;
        const lines = linesOf(from, a, b);
        if (firstAt < 0 && lines.length) {
            firstAt = World.currentTick;
            gapAtFirst = cheb(a, b);
        }
        if (firstAt > 0 && !T.inThread(a) && !TM.talkHeld(a) && !TM.talkHeld(b)) break;
    }
    check('walkup: a forced thread with the walk-up forced: the opener walks up (talkMoveStats)', started && TM.talkMoveStats.walkUps === w0 + 1, { started, walkUps: TM.talkMoveStats.walkUps - w0, fails: T.threadStats().fails });
    check('walkup: the opener is within 3 tiles of its partner when the first line is said', firstAt > 0 && gapAtFirst <= 3, { firstAt, gapAtFirst, lines: linesOf(from, a, b).map(l => l.text) });
    tick(8);
    check('walkup: its tile was a claimed one within 2 of the partner, given back after the thread', claimed !== null && cheb({ x: claimed[0], z: claimed[1] }, { x: base[0] + 9, z: base[1] }) <= 2 && !TM.talkHoldOf(a) && lib.standTileOf(a) === null, { claimed, hold: !!TM.talkHoldOf(a), tile: lib.standTileOf(a) });
}

// ---- walking (H4) ----
if (want('walking')) {
    scene(SEED, 'walking');
    nextScene();
    M.setMovementRatesForTest({ ...M.MOVEMENT_OFF, holds: 1 });
    const [a, b] = pairOf(2, used);
    place(a, base[0], base[1] + 3);
    place(b, base[0] + 3, base[1] + 3);
    // b walks back and forth along the field (east, west)
    let leg = 0;
    const ends = [
        [base[0] + 14, base[1] + 3],
        [base[0], base[1] + 3]
    ];
    hold(b, 'Idle', player => {
        const [x, z] = ends[leg % 2];
        if (player.x === x && player.z === z) leg++;
        lib.walkTo(player, ends[leg % 2][0], ends[leg % 2][1], 0);
    });
    tick(2);
    const from = said.length;
    const h0 = TM.talkMoveStats.holds;
    const started = force(a, b);
    const trace = [];
    let lastLine = -1;
    for (let t = 0; t < 260; t++) {
        tick();
        const lines = linesOf(from, a, b);
        if (lines.length) lastLine = lines[lines.length - 1].t;
        trace.push({ t: World.currentTick, at: [b.x, b.z], wp: b.hasWaypoints(), held: TM.talkHeld(b), thread: T.inThread(b) });
        if (lastLine > 0 && !T.inThread(a) && World.currentTick - lastLine > 12) break;
    }
    const lines = linesOf(from, a, b);
    const firstLine = lines[0]?.t ?? -1;
    const during = trace.filter(e => e.t > firstLine && e.t <= lastLine);
    const still = during.length > 0 && during.every((e, i) => !e.wp && (i === 0 || (e.at[0] === during[i - 1].at[0] && e.at[1] === during[i - 1].at[1])));
    const moved = trace.find((e, i) => e.t > lastLine && i > 0 && (e.at[0] !== trace[i - 1].at[0] || e.at[1] !== trace[i - 1].at[1]));
    check('walking: a thread holds both bots (talkMoveStats.holds)', started && TM.talkMoveStats.holds >= h0 + 2, { started, holds: TM.talkMoveStats.holds - h0, lines: lines.length });
    check('walking: the walking partner stands through the thread (no waypoints, no step from its first line to its last)', lines.length >= 2 && still, { firstLine, lastLine, during: during.slice(0, 4) });
    check('walking: and walks on within 6 ticks of the last line', moved && moved.t - lastLine <= 7, { lastLine, moved: moved?.t });
    hold(b);
}

// ---- never ----
if (want('never')) {
    scene(SEED, 'never');
    nextScene();
    M.setMovementRatesForTest({ ...M.MOVEMENT_OFF, holds: 1, walkUp: 1 });
    const [f, k, w, x] = pairOf(4, used, levelling);
    const [h] = pairOf(1, used);
    const others = talkers.find(p => !used.has(p)) ?? talkers[0];
    place(f, base[0], base[1]);
    place(k, base[0] + 2, base[1]);
    place(h, base[0] + 4, base[1]);
    place(x, base[0] + 6, base[1]);
    place(w, 3100, 3560);
    tick(3);
    f.preventLogoutUntil = World.currentTick + 50;
    hold(k, 'PKer');
    const hook = p => p === x;
    TM.noHoldWhile.push(hook);
    const vendor = all.find(p => p.botPlanner === 'extras_vendor') ?? null;
    const cases = [
        ['fighting (its combat lock)', f],
        ['a PKer', k],
        ['in the Wilderness', w],
        ['a noHoldWhile hook', x],
        ...(vendor ? [['a vendor', vendor]] : [])
    ];
    const held = cases.filter(([, p]) => TM.talkHoldable(p) || TM.holdForTalk(p, others));
    check(`never: ${cases.map(c => c[0]).join(', ')}: never held (talkHoldable false, holdForTalk refused)`, held.length === 0 && cases.length >= 4, { held: held.map(c => c[0]), vendor: !!vendor });
    check('never: a plain bot is holdable (the check is not always false)', TM.talkHoldable(h), h.username);
    // a walking PKer in a thread keeps walking
    hold(k, 'PKer', player => lib.walkTo(player, base[0] + 14, base[1], 0));
    tick(1);
    T.resetThreadsForTest();
    force(h, k);
    let kWp = 0;
    for (let t = 0; t < 12; t++) {
        tick();
        if (k.hasWaypoints() || cheb(k, { x: base[0] + 14, z: base[1] }) <= 1) kWp++;
    }
    check('never: a walking PKer in a thread is not held (it walks on)', !TM.talkHeld(k) && kWp >= 6, { kWp });
    TM.noHoldWhile.splice(TM.noHoldWhile.indexOf(hook), 1);
    f.preventLogoutUntil = 0;
    hold(k);
    // a bot working its resource (an interaction under way) is not held by its thread
    const [r1, r2] = pairOf(2, used, levelling);
    place(r1, base[0], base[1] + 6);
    place(r2, base[0] + 2, base[1] + 6);
    tick(2);
    const fakeTarget = sim.human;
    r1.target = fakeTarget;
    TM.holdThread(r1, r2, true);
    check('never: a bot working its resource (its interaction) is not held by a thread; its partner is', !TM.talkHeld(r1) && TM.talkHeld(r2));
    r1.target = null;
    TM.releaseTalk(r2);
}

// ---- hit ----
if (want('hit')) {
    scene(SEED, 'hit');
    nextScene();
    M.setMovementRatesForTest({ ...M.MOVEMENT_OFF, holds: 1 });
    const [a, b] = pairOf(2, used, levelling);
    place(a, base[0], base[1] + 9);
    place(b, base[0] + 2, base[1] + 9);
    tick(2);
    const ok = TM.holdForTalk(a, b, 60);
    tick(3);
    const heldBefore = TM.talkHeld(a);
    a.levels[3] = Math.max(1, a.levels[3] - 1);
    tick(1);
    check('hit: a hold under way ends at once on a hit (the next tick)', ok && heldBefore && !TM.talkHeld(a) && (TM.talkMoveStats.ended.hit ?? 0) >= 1, { ok, heldBefore, ended: TM.talkMoveStats.ended });
    a.levels[3] = a.baseLevels[3];
}

// ---- human ----
if (want('human')) {
    scene(SEED, 'human');
    nextScene();
    M.setMovementRatesForTest({ ...M.MOVEMENT_OFF, holds: 1 });
    const [a, b] = pairOf(2, used);
    place(a, base[0] + 6, base[1] + 12);
    place(b, base[0] + 8, base[1] + 12);
    sim.teleportHuman(base[0] + 7, base[1] + 14, 0);
    tick(3);
    TM.holdForTalk(a, b, 60);
    const from = said.length;
    lib.BotChat.onPublicMessage(sim.human, `hi ${a.displayName} how r u`);
    let answered = -1;
    for (let t = 0; t < 80 && answered < 0; t++) {
        tick();
        if (said.slice(from).some(s => s.name === a.username)) answered = t;
    }
    check("human: the human's line to a held bot ends the hold, and the bot answers it (never ignored)", !TM.talkHeld(a) && answered >= 0, { held: TM.talkHeld(a), answered, ended: TM.talkMoveStats.ended });
    sim.teleportHuman(base[0] + 30, base[1] + 30, 0);
}

// ---- stranger ----
if (want('stranger')) {
    scene(SEED, 'stranger');
    nextScene();
    // (a pair the plain thread opens for: with the walk-ups off, the control; a pair that fails for another reason, its
    // area's gap or its topic, is passed over)
    let result = null;
    for (let k = 0; k < 4 && !result; k++) {
        const [a, b] = pairOf(2, used);
        if (!a || !b) break;
        const at = [base[0], base[1] + 15 + (k % 2) * 3];
        const walkOff = () => {
            place(a, at[0], at[1]);
            place(b, at[0] + 8, at[1]);
            hold(a, 'Idle', player => lib.walkTo(player, base[0] + 14, at[1] + 2, 0));
            tick(2);
        };
        M.setMovementRatesForTest({ ...M.MOVEMENT_OFF, walkUp: 1, holds: 1 });
        walkOff();
        const f0 = T.threadStats().fails.walking ?? 0;
        T.resetThreadsForTest();
        const opened = a.hasWaypoints() ? T.startThread(a, 'test', b, 4) : null;
        const refused = (T.threadStats().fails.walking ?? 0) - f0;
        M.setMovementRatesForTest(M.MOVEMENT_OFF);
        walkOff();
        T.resetThreadsForTest();
        const control = a.hasWaypoints() ? T.startThread(a, 'test', b, 4) : null;
        hold(a);
        tick(60);
        if (control === true) result = { opened, refused, control };
    }
    check("stranger: a walking opener with a stranger 8 tiles off opens no thread ('walking'), where with the walk-ups off the same opener opens it (as before theme H)", result && result.opened === false && result.refused === 1, result);
}

// ---- off ----
if (want('off')) {
    scene(SEED, 'off');
    nextScene();
    M.setMovementRatesForTest(M.MOVEMENT_OFF);
    const [a, b] = pairOf(2, used);
    place(a, base[0], base[1] + 18);
    place(b, base[0] + 9, base[1] + 18);
    tick(2);
    const h0 = TM.talkMoveStats.holds;
    const w0 = TM.talkMoveStats.walkUps;
    let draws = 0;
    const real = Math.random;
    Math.random = () => {
        draws++;
        return real();
    };
    const move = TM.openerMove(a, b);
    TM.holdThread(a, b, true);
    TM.threadEnded(a, b, true);
    const holdable = TM.talkHoldable(a);
    Math.random = real;
    check('off: theme H off, the opener moves as before (here), holds nobody and draws no dice', move === 'here' && draws === 0 && TM.talkMoveStats.holds === h0 && TM.talkMoveStats.walkUps === w0 && !TM.talkHeld(a) && !TM.holdForTalk(a, b), { move, draws, holdable });
}

M.setMovementRatesForTest(M.MOVEMENT_OFF);
check('no errors', errors.length === 0 && lib.botErrorCount() === 0, errors.slice(0, 3).join(' | '));
const failed = checks.filter(c => !c.ok);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : `: ${c.detail}`}`);
out(failed.length ? `talkmoves: ${failed.length} of ${checks.length} failed` : `talkmoves: all ${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
