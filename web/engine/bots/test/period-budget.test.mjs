#!/usr/bin/env node
// The period foundation (bots ideas round 3, theme G step 1: port/BotPeriod, port/BotPeriodPlan, port/BotPeriodIndex),
// in the real 274 world (30 aged bots, the director,
// the cliques' doings, habits, hang-outs, the arena, random events, trains, alching, scams and witnesses off, every bot
// held with a stand task), on dice of its own (test/lib/dice.mjs scene):
//   switch    a staged world has theme G and theme H off (test/lib/simworld's period, movement); setPeriodForTest(null)
//             is the game's (on)
//   budget    buzzBudget: 2 at 100 online, 15 at 500, 36 at 1000 (BUZZ_PER_100 2 × (N/100)^1.25), none with none; an
//             entry's cap per 100 (crabs 1.2: 6 at 500, 1 at 100; the lighthouse 0.4: 2 at 500, its least 1 at 100)
//   dice      the planner's hook draws no dice and counts nothing while theme G is off, with an empty registry, and on a
//             free world's rule; the same with an entry registered and theme G off
//   offer     an entry registered and theme G on: a free bot (mayBuzz) is offered its task (`<kind>:buzz:<key>`), counted
//             by key; never two buzz visits in a row; a bot that may not (an extra, a newbie, low combat) is not; the
//             budget full, the gap (BUZZ_GAP play ticks after its last visit ended) and a cap stop it; an entry whose
//             make() gives null is left out for the next; fits() false is never made
//   keep      a buzz task under way is kept at a plan's end (keptPeriodTask), until it is complete
//   visits    notePeriodStart/End, periodOf, periodOut by kind, periodLog, a logout ends a visit; a rescue jump of a bot
//             out (BotAction botTeleport through teleportListeners) counted by kind and reason (PC10), another bot's not
//   boost     a rumour heard (buzzBoost): the offer × 2 for that bot's session, its key leaned to
//   lines     sayPeriodLine says nothing while theme G is off, or for a kind with no lines
//   errors    none
//
//   node --expose-gc web/engine/bots/test/period-budget.test.mjs [--seed=3]
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
const SEED = Number(args.seed ?? 3);
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

const engineDir = prepareEngineClone('period-budget', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/period.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, Period: P, PeriodPlan: Plan, Minimap } = lib;

const N = 30;
const sim = await lib.Sim.create({ bots: N, members: true, debug: false, ageNewBots: true, ackLogouts: true });
sim.addHuman(3222, 3218, 0);
// ---- switch ----
check('a staged world has theme G off (Sim.create without period)', P.periodOn() === false);
check('a staged world has every piece of theme H off (Sim.create without movement)', ['hops', 'pauses', 'overshoot', 'lanes', 'variants', 'walkUp', 'holds'].every(k => !Minimap.movementOn(k)));
P.setPeriodForTest(null);
check("setPeriodForTest(null): the game's (on)", P.periodOn() === true);
Minimap.setMovementRatesForTest(null);
check("setMovementRatesForTest(null): the game's (every piece on)", ['hops', 'pauses', 'overshoot', 'lanes', 'variants', 'walkUp', 'holds'].every(k => Minimap.movementOn(k)));
Minimap.setMovementRatesForTest(Minimap.MOVEMENT_OFF);
P.setPeriodForTest({ on: false });

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
for (let i = 0; i < 60; i++) sim.tick();
const bots = sim.bots();
check(`${N} bots in the world`, bots.length === N, bots.length);
const STAND = { name: 'Idle', reset() {}, interrupt() {}, interrupted: false, shouldRun: () => true, isComplete: () => false, tick() {}, activityStep: () => null };
/** held where it is with a stand task of this name (its sub-task cleared), full Hitpoints */
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
}
for (const p of bots) hold(p);
for (let i = 0; i < 3; i++) sim.tick();

// ---- budget ----
check('buzzBudget: 2 at 100, 15 at 500, 36 at 1000, 0 with none, 1 at 10', [100, 500, 1000, 0, 10].map(n => P.buzzBudget(n)).join(',') === '2,15,36,0,1', [100, 500, 1000, 0, 10].map(n => P.buzzBudget(n)));
const crabsCap = { key: 'x', kind: 'buzz', weight: 1, capPer100: 1.2, fits: () => true, make: () => null };
const lightCap = { ...crabsCap, capPer100: 0.4 };
check('periodCap: crabs 1.2 per 100 (6 at 500, 1 at 100), the lighthouse 0.4 (2 at 500, its least 1 at 100), none: no cap', [P.periodCap(crabsCap, 500), P.periodCap(crabsCap, 100), P.periodCap(lightCap, 500), P.periodCap(lightCap, 100), P.periodCap({ ...crabsCap, capPer100: undefined }, 500)].join(',') === '6,1,2,1,Infinity');
check('the defaults: gap 9000 play ticks, offer 0.25, combat 15, the boost 2', P.BUZZ_GAP === 9000 && P.BUZZ_OFFER === 0.25 && P.BUZZ_MIN_COMBAT === 15 && P.BUZZ_BOOST === 2);

// ---- dice: none while off, empty or a free world ----
let draws = 0;
const counted = fn => {
    const r = Math.random;
    draws = 0;
    Math.random = () => (draws++, r());
    try {
        return fn();
    } finally {
        Math.random = r;
    }
};
const free = bots.filter(p => Plan.mayBuzz(p));
check('some bots may go on a buzz visit (levelling, combat 15+, no newbie, on the overworld)', free.length >= 3, free.length);
const extra = bots.find(p => !lib.isLevelling(p.botPlanner));
check('an extra may not (vendors, socials, PKers keep their roles)', extra !== undefined && !Plan.mayBuzz(extra), extra?.botPlanner);
const low = bots.find(p => lib.isLevelling(p.botPlanner) && !lib.isNewbie(p) && p.combatLevel < 15);
if (low) check('a levelling bot under combat 15 may not', !Plan.mayBuzz(low), low.combatLevel);
const a = free[0];
P.resetPeriodForTest();
// (the builders' entries load with the module graph (the H builder's buzz: crabs, rellekka, the lighthouse; the G
// builder's): taken out of the registry for the foundation's checks, which stage their own, and put back at the end. The
// registry's array is periodEntries()'s own; the test empties it in place, the game never does)
const builderEntries = P.periodEntries().splice(0);
P.setPeriodForTest({ on: true, rate: 1000, n: 100 });
const empty = counted(() => Plan.periodTaskFor(a, null));
check('on, nothing registered: null, no dice, nothing counted', empty === null && draws === 0 && P.periodStats.asked === 0, { draws, asked: P.periodStats.asked });
// (a fake entry: its task a stand task named as a buzz task is)
let makes = 0;
const fake = key => Object.assign(Object.create(STAND), { name: P.buzzTaskName('Idle', key), interrupted: false });
P.registerPeriodEntry({ key: 'test', kind: 'buzz', weight: 1, fits: () => true, make: () => (makes++, fake('test')) });
check('the registry holds the entry', P.periodEntries().length === 1 && P.periodEntries()[0].key === 'test');
P.setPeriodForTest({ on: false, rate: 1000, n: 100 });
const off = counted(() => Plan.periodTaskFor(a, null));
check('an entry registered, theme G off: null, no dice, nothing counted, nothing made', off === null && draws === 0 && P.periodStats.asked === 0 && makes === 0, { draws, asked: P.periodStats.asked, makes });
check('theme G off: keptPeriodTask null', Plan.keptPeriodTask(a) === null);

// ---- offer ----
scene(SEED, 'offer');
P.setPeriodForTest({ on: true, rate: 1000, n: 100 });
const t1 = Plan.periodTaskFor(a, 'Woodcut');
check('on, a free bot: offered the entry\'s task, `<kind>:buzz:<key>`', t1 !== null && t1.name === 'Idle:buzz:test', t1?.name);
check('counted: asked 1, offered 1, by key', P.periodStats.asked === 1 && P.periodStats.offered === 1 && P.periodStats.byKey.test === 1, P.periodStats);
check("the hook's pick in port/BotOutings' picks ('period')", (lib.pickStats().period?.['test<Woodcut'] ?? 0) === 1, lib.pickStats().period);
check('never two buzz visits in a row', Plan.periodTaskFor(a, 'Idle:buzz:test') === null && P.periodStats.why.again === 1);
check('an extra is not offered one', extra === undefined || (Plan.periodTaskFor(extra, null) === null && P.periodStats.why.who >= 1));
// (the budget: 2 at 100 online; two bots out fill it)
P.notePeriodStart(free[1], 'test', 'buzz');
P.notePeriodStart(free[2], 'test', 'buzz');
check('periodOut: 2 out on the buzz, periodOutOn its key', P.periodOut('buzz') === 2 && P.periodOutOn('test').length === 2 && P.periodOut('pet') === 0);
check('the budget full (2 of 2 at 100): no offer', Plan.periodTaskFor(a, null) === null && P.periodStats.why.budget === 1);
// (another kind out does not count against the buzz)
P.notePeriodEnd(free[2], 'done');
P.notePeriodStart(free[2], 'pet-trip', 'pet');
check('a pet trip out does not fill the buzz budget', P.periodOut('buzz') === 1 && P.periodOut() === 2);
check('periodOf: the visit (kind, key, start), -1 while it lasts', P.periodOf(free[1])?.key === 'test' && P.periodOf(free[1])?.kind === 'buzz' && P.periodOf(free[1])?.end === -1);
// (the gap: free[1]'s visit ends now; play ticks held)
lib.setPlayForTest(100000);
P.notePeriodEnd(free[1], 'done');
check('a visit ended: its outcome and end in the log', P.periodLog.some(v => v.name === free[1].username && v.outcome === 'done' && v.end === World.currentTick));
check('the gap: a bot asked again before BUZZ_GAP play ticks is not offered one', Plan.periodTaskFor(free[1], null) === null && P.periodStats.why.gap === 1);
lib.setPlayForTest(100000 + P.BUZZ_GAP);
const again = Plan.periodTaskFor(free[1], null);
check('after BUZZ_GAP play ticks it may be offered one again', again !== null, P.periodStats.why);
lib.setPlayForTest(null);
// (a cap: one out on the key holds it at 100 online)
P.registerPeriodEntry({ key: 'test', kind: 'buzz', weight: 1, capPer100: 0.5, fits: () => true, make: () => (makes++, fake('test')) });
P.notePeriodStart(free[3] ?? free[1], 'test', 'buzz');
check('an entry at its cap is not offered (none left: why none)', Plan.periodTaskFor(a, null) === null && P.periodStats.why.none >= 1, P.periodStats.why);
P.notePeriodEnd(free[3] ?? free[1], 'done');
// (make() null: the next entry; fits() false: never made)
let madeNever = 0;
P.registerPeriodEntry({ key: 'test', kind: 'buzz', weight: 5, fits: () => true, make: () => null });
P.registerPeriodEntry({ key: 'other', kind: 'buzz', weight: 1, fits: () => true, make: () => fake('other') });
P.registerPeriodEntry({ key: 'never', kind: 'buzz', weight: 100, fits: () => false, make: () => (madeNever++, fake('never')) });
const t2 = Plan.periodTaskFor(a, null);
check("an entry whose make() gives null is left out for the next ('other')", t2?.name === 'Idle:buzz:other', t2?.name);
check('an entry that does not fit is never made', madeNever === 0);
P.forcePeriodKeyForTest('test');
check('a forced key with no task: null', Plan.periodTaskFor(a, null) === null);
P.forcePeriodKeyForTest(null);

// ---- keep ----
{
    const ai = sim.botPlayer(a);
    const task = fake('other');
    ai.currentTask = task;
    P.notePeriodStart(a, 'other', 'buzz');
    check('a buzz task under way is kept at a plan\'s end', Plan.keptPeriodTask(a) === task && P.periodStats.kept === 1);
    task.isComplete = () => true;
    check('a complete one is not kept', Plan.keptPeriodTask(a) === null);
    P.notePeriodEnd(a, 'done');
    hold(a);
}

// ---- visits: the rescue jumps of a bot out (PC10) ----
{
    check("port/BotPeriodIndex put port/BotPeriod's listener in BotAction's teleportListeners", lib.teleportListeners.includes(P.notePeriodJump));
    // (jumps far from the human, unseen at both ends, as botTeleport allows: two bots out of its sight)
    const human = sim.human;
    const unseen = p => p.level === 0 && Math.max(Math.abs(p.x - human.x), Math.abs(p.z - human.z)) > 25;
    const b = free.find(p => unseen(p) && !P.periodOf(p) && p !== a);
    const c = bots.find(p => unseen(p) && !P.periodOf(p) && p !== b);
    if (b && c) {
        P.notePeriodStart(b, 'other', 'buzz');
        const [bx, bz, cx, cz] = [b.x, b.z, c.x, c.z];
        const jumped = lib.botTeleport(b, 3093, 3493, 0, 'watchdog');
        const otherJump = lib.botTeleport(c, 3093, 3495, 0, 'stuck');
        check("a jump of a bot out on a visit is counted by kind and reason; another bot's is not", jumped && otherJump && P.periodStats.moves.buzz?.watchdog === 1 && P.periodStats.moves.buzz?.stuck === undefined, { jumped, otherJump, moves: P.periodStats.moves });
        P.notePeriodEnd(b, 'done');
        lib.botTeleport(b, bx, bz, 0, 'watchdog');
        lib.botTeleport(c, cx, cz, 0, 'stuck');
        check('a jump after the visit ended is not counted', P.periodStats.moves.buzz?.watchdog === 1);
        hold(b);
        hold(c);
    } else check('two bots out of the human\'s sight (for the jump check)', false, `${b?.username} ${c?.username}`);
    check('visits by kind and key', P.periodStats.visits.buzz >= 4 && P.periodStats.visits.pet === 1 && P.periodStats.visitsByKey['buzz:test'] >= 3 && P.periodStats.visitsByKey['buzz:other'] >= 1, P.periodStats.visitsByKey);
}

// ---- boost ----
{
    scene(SEED, 'boost');
    P.setPeriodForTest({ on: true, rate: 1, n: 100 });
    P.registerPeriodEntry({ key: 'test', kind: 'buzz', weight: 1, fits: () => true, make: () => fake('test') });
    P.registerPeriodEntry({ key: 'never', kind: 'buzz', weight: 1, fits: () => false, make: () => null });
    const b = free.find(p => !P.periodOf(p) && p !== a) ?? a;
    check('no boost: factor 1', P.buzzBoostOf(b).factor === 1 && P.buzzBoostOf(b).key === null);
    // (the offer's rate over many asks, the gap reset each time: about 0.25 × (0.5 + curiosity), twice that boosted)
    const chance = 0.25 * (0.5 + lib.personaOf(b.username, b.botPlanner).curiosity);
    const rate = () => {
        let n = 0;
        // (an offer starts no visit, so nothing out and no gap between the asks)
        for (let i = 0; i < 2000; i++) if (Plan.periodTaskFor(b, null)) n++;
        return n / 2000;
    };
    // (the earlier scenes' gaps and visits forgotten: their held play clock is gone)
    P.resetPeriodForTest();
    const plain = rate();
    P.buzzBoost(b, 'other');
    const boosted = rate();
    check(`the offer about 0.25 × (0.5 + curiosity) = ${chance.toFixed(3)} of the asks`, Math.abs(plain - chance) < 0.04, { plain, why: P.periodStats.why });
    check('a rumour heard: about twice that for its session', Math.abs(boosted - Math.min(1, 2 * chance)) < 0.05, boosted);
    P.resetPeriodForTest();
    check('resetPeriodForTest forgets the boost', P.buzzBoostOf(b).factor === 1);
    P.buzzBoost(b, 'other');
    check('buzzBoost keeps the key heard of', P.buzzBoostOf(b).key === 'other' && P.buzzBoostOf(b).factor === 2);
}

// ---- lines ----
{
    const b = free[0];
    P.setPeriodForTest({ on: false });
    check('sayPeriodLine: nothing while theme G is off', Plan.sayPeriodLine(b, 'period', 'pet-buy') === null);
    P.setPeriodForTest(null);
    check('sayPeriodLine: nothing for a kind with no lines', Plan.sayPeriodLine(b, 'buzz', 'crabs-there') === null);
}

// ---- a logout ends a visit ----
{
    const b = free.find(p => !P.periodOf(p)) ?? free[0];
    P.notePeriodStart(b, 'test', 'buzz');
    BotManager.leaveSoon?.(b.username, 1, { abrupt: true });
    let left = false;
    for (let i = 0; i < 300 && !left; i++) {
        sim.tick();
        left = b.slot === -1;
    }
    if (left) {
        P.periodOut();
        check('a bot that logged out mid-visit: its visit ended (logout)', P.periodOf(b) === null && P.periodLog.some(v => v.name === b.username && v.outcome === 'logout'));
    } else check('a bot asked to leave logged out (for the logout check)', false, 'still online');
}

P.setPeriodForTest(null);
// (the builders' entries back, the staged ones out)
P.periodEntries().splice(0, P.periodEntries().length, ...builderEntries);
check('the builders\' entries are back in the registry', builderEntries.every(e => P.periodEntries().includes(e)) && P.periodEntries().length === builderEntries.length, P.periodEntries().map(e => e.key));
check('no errors', errors.length === 0 && lib.botErrorCount() === 0, errors.slice(0, 3).join(' | '));
const failed = checks.filter(c => !c.ok);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : `: ${c.detail}`}`);
out(failed.length ? `period-budget: ${failed.length} of ${checks.length} failed` : `period-budget: all ${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
