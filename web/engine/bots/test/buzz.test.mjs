#!/usr/bin/env node
// The update buzz (bots ideas round 3, theme G, the H builder's parts: tasks/BuzzTask, tasks/CrabTask,
// tasks/LighthouseTask), in
// the real 274 world (members; a few aged bots; the director, the cliques' doings, habits, hang-outs, the arena, random
// events, trains, alching, scams, witnesses and teleport spells off), each scene on its own dice (test/lib/dice.mjs
// scene), theme G on (Sim.create({ period: true })) and theme H off, the scene's bot given its buzz task by hand, full
// run energy and Hitpoints:
//   offer     the registry holds the crabs, rellekka and lighthouse entries; with the key forced, the planner's hook gives
//             a free fighter `Combat:buzz:crabs` and notes its visit; theme G off: nothing, no dice
//   crabs     at the west rocks with the human away: no crab wakes, the bot rock-hops (beside another "Rocks" now and
//             then, never standing 100 ticks on one tile), gains no combat XP, no rescue jump; the human in view: a crab
//             wakes and the bot fights it (its target a Rock Crab), XP the game's, no rescue jump
//   lighthouse  a bot of Agility 70 jumps the causeway north, goes in by the door, up the stairs to the top and down,
//             out and back south to the Rellekka side, its task done, no rescue jump and never Jossik; a bot of Agility 1
//             slips (the game's roll), starts again, gives up after 3 slips, on the Rellekka side; never a jump with a
//             slip spot ahead at 10 Hitpoints or under (the largest slip): with no food it gives up on the shore
//             (northbound) or stands on the island until its Hitpoints are back (southbound), then crosses; at Agility 35,
//             Hitpoints 30 and 3 shrimps it never dies; a death all the same (the respawn far off) ends the visit, its
//             role cleared, no jump judged and no rescue jump
//   off       theme G off: the members catalogue's Rellekka weight, the cw thread's pools and the towns players name are
//             aedac0b's (the update's three places unknown), no dice
//   sights    a sightseer stands at 3-4 of Rellekka's stops, its visit ended 'over' or 'time', no rescue jump
//   lines     every buzz kind the tasks say has lines (data/lines2004-buzz.json); a buzz line heard boosts a bot near
//   errors    none
//
//   node --expose-gc web/engine/bots/test/buzz.test.mjs [--seed=5] [--only=offer,crabs,lighthouse,sights,lines,off]
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

const engineDir = prepareEngineClone('buzz', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/period.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, Period: P, PeriodPlan: Plan, Buzz, Crab, Lighthouse: L, PeriodPlaces, BuzzPlaces } = lib;

const N = 10;
const sim = await lib.Sim.create({ bots: N, members: true, debug: false, ageNewBots: true, period: true });
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
for (let i = 0; i < 40; i++) sim.tick();
const bots = sim.bots();
check(`${N} bots in the world`, bots.length === N, bots.length);
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const STAND = { name: 'Idle', reset() {}, interrupt() {}, interrupted: false, shouldRun: () => true, isComplete: () => false, tick() {}, activityStep: () => null };
/** held with a stand task (its sub-task cleared), full HP and run energy */
function hold(p, task = null) {
    const ai = sim.botPlayer(p);
    ai.currentTask = task ?? Object.assign(Object.create(STAND), { name: 'Idle', interrupted: false });
    ai.planEnds = World.currentTick + 1e6;
    // (and the plan's no-XP stall (BotPlayer _watchPlan: 1500 ticks) never ends it: a held bot gains none, and the scenes'
    // ticks before it decided where a check at a multiple of 100 fell: seed 3's sightseer was re-planned at its first tick)
    ai.planXp = p.stats.reduce((a, x) => a + x, 0);
    ai.planXpTick = 1e12;
    if (ai.hasSubTask()) {
        ai._interruptSubTask?.();
        ai._dropSubTask?.();
    }
    p.levels[3] = p.baseLevels[3];
    p.runenergy = 10000;
    p.afkEventReady = false;
}
const place = (p, x, z, level = 0) => {
    p.closeModal();
    p.clearWaypoints();
    p.clearInteraction();
    p.teleJump(x, z, level);
};
for (const p of bots) hold(p);
const STAT = { attack: 0, defence: 1, strength: 2, hitpoints: 3, ranged: 4, prayer: 5, magic: 6, agility: 16 };
/** combat about 33: the melee stats and Hitpoints 30, the rest 1 */
function fighterLevels(p) {
    for (const s of [STAT.attack, STAT.defence, STAT.strength, STAT.hitpoints]) setLevel(p, s, 30);
    for (const s of [STAT.ranged, STAT.prayer, STAT.magic]) setLevel(p, s, 1);
}
/** the stat at `level` (its XP too), the combat level worked out again (Player.setLevel) */
function setLevel(p, stat, level) {
    p.setLevel(stat, level);
}
/** a fighter of about combat 30, a scimitar in hand and 5 lobsters */
const pack = p => p.getInventory(lib.InvType.INV);
function kit(p, food = 5) {
    const inv = pack(p);
    for (let i = 0; i < inv.capacity; i++) inv.delete(i);
    inv.add(lib.Items.LOBSTER, 1);
    for (let i = 1; i < food; i++) inv.add(lib.Items.LOBSTER, 1);
    inv.add(lib.Items.COINS, 200);
    inv.add(lib.Items.IRON_SCIMITAR, 1);
}
const fighter = bots.find(p => lib.isLevelling(p.botPlanner) && !lib.isNewbie(p)) ?? bots[0];
const combatXp = p => p.stats[0] + p.stats[1] + p.stats[2] + p.stats[3];
const jumps = () => lib.teleportStats.jumps;

// ---- offer ----
if (want('offer')) {
    scene(SEED, 'offer');
    const keys = P.periodEntries().map(e => e.key);
    check('offer: the registry holds the crabs, rellekka and lighthouse entries', ['crabs', 'rellekka', 'lighthouse'].every(k => keys.includes(k)), keys);
    fighterLevels(fighter);
    kit(fighter);
    place(fighter, 2725, 3490);
    sim.tick();
    P.resetPeriodForTest();
    P.setPeriodForTest({ on: true, rate: 1000, n: 100 });
    P.forcePeriodKeyForTest('crabs');
    const task = Plan.periodTaskFor(fighter, null);
    check('offer: with the key forced, a free fighter is offered Combat:buzz:crabs', task?.name === 'Combat:buzz:crabs', { task: task?.name ?? null, cb: fighter.combatLevel, why: P.periodStats.why, may: Plan.mayBuzz(fighter) });
    P.setPeriodForTest({ on: false });
    let draws = 0;
    const real = Math.random;
    Math.random = () => (draws++, real());
    const off = Plan.periodTaskFor(fighter, null);
    Math.random = real;
    check('offer: theme G off, nothing and no dice', off === null && draws === 0, draws);
    P.setPeriodForTest(null);
    P.forcePeriodKeyForTest(null);
}

// ---- crabs ----
if (want('crabs')) {
    scene(SEED, 'crabs');
    P.resetPeriodForTest();
    sim.teleportHuman(3222, 3218, 0);
    fighterLevels(fighter);
    kit(fighter);
    const [wx, wz] = BuzzPlaces.CRAB_GROUPS.west;
    place(fighter, wx, wz);
    sim.tick();
    const task = new Buzz.BuzzTask('crabs', new Crab.CrabTask('west', fighter));
    hold(fighter, task);
    const s0 = { ...Crab.crabStats };
    const xp0 = combatXp(fighter);
    const j0 = jumps();
    let still = 0;
    let maxStill = 0;
    let woke = 0;
    let prev = [fighter.x, fighter.z];
    for (let t = 0; t < 600; t++) {
        fighter.runenergy = 10000;
        sim.tick();
        if (lib.findNpcFiltered(fighter.x, fighter.z, 0, n => Crab.isWokenCrab(n), 20)) woke++;
        if (process.env.BZ_DEBUG && t % 10 === 0) out(`  t${t} ${fighter.x},${fighter.z} wp ${fighter.hasWaypoints()} task ${sim.botPlayer(fighter).currentTask?.name} state ${task.state} hops ${Crab.crabStats.hops} rock ${JSON.stringify(lib.findNpcFiltered(fighter.x, fighter.z, 0, n => Crab.isCrabRock(n), 8)?.x)}`);
        const at = [fighter.x, fighter.z];
        if (cheb(at, prev) === 0) maxStill = Math.max(maxStill, ++still);
        else still = 0;
        prev = at;
    }
    check('crabs: the human away, no crab wakes near the bot', woke === 0, woke);
    check('crabs: the bot rock-hops (beside other rocks), never 100 ticks on one tile', Crab.crabStats.hops - s0.hops >= 5 && maxStill < 100, { hops: Crab.crabStats.hops - s0.hops, maxStill });
    check('crabs: unobserved, no combat XP and no fight', combatXp(fighter) === xp0 && Crab.crabStats.fights === s0.fights, { xp: combatXp(fighter) - xp0, fights: Crab.crabStats.fights - s0.fights });
    check('crabs: the visit is noted (port/BotPeriod: crabs out), no rescue jump', P.periodOf(fighter)?.key === 'crabs' && jumps() === j0, { visit: P.periodOf(fighter), jumps: jumps() - j0 });
    // the human in view (8 tiles off, no rock within 4 of it: the crabs wake for the bot's walk by them, not the human's)
    sim.teleportHuman(2668, 3711, 0);
    let fought = false;
    let targeted = false;
    const xp1 = combatXp(fighter);
    for (let t = 0; t < 500 && !(fought && combatXp(fighter) > xp1); t++) {
        fighter.runenergy = 10000;
        fighter.levels[3] = Math.max(fighter.levels[3], Math.ceil(fighter.baseLevels[3] * 0.6));
        // (the human stays out of the crabs' reach: only the bot's walk wakes them)
        sim.tick();
        if (Crab.crabStats.fights > s0.fights) fought = true;
        if (process.env.BZ_DEBUG) {
            const w = lib.findNpcFiltered(fighter.x, fighter.z, 0, n => Crab.isWokenCrab(n), 10);
            out(`  c${t} ${fighter.x},${fighter.z} hp${fighter.levels[3]} state ${task.state} tgt ${fighter.target ? (fighter.target.username ?? lib.NpcTypeConfig.get(fighter.target.type).debugname) : '-'} woken ${w ? `${w.x},${w.z} tgt ${w.target ? (w.target.username ?? 'npc') : '-'}` : '-'} xp ${combatXp(fighter) - xp1}`);
        }
        const tgt = fighter.target;
        if (tgt && tgt.username === undefined && Crab.isWokenCrab(tgt)) targeted = true;
    }
    check('crabs: the human in view, a crab wakes and the bot fights it (a Rock Crab its target)', fought && targeted, { fights: Crab.crabStats.fights - s0.fights, woke: Crab.crabStats.woke - s0.woke, targeted });
    check('crabs: the fight\'s XP is the game\'s (gained), no rescue jump', combatXp(fighter) > xp1 && jumps() === j0, { xp: combatXp(fighter) - xp1, jumps: jumps() - j0 });
    task.interrupt();
    hold(fighter);
    sim.teleportHuman(3222, 3218, 0);
}

// ---- lighthouse ----
if (want('lighthouse')) {
    scene(SEED, 'lighthouse');
    P.resetPeriodForTest();
    const climber = bots.find(p => p !== fighter && lib.isLevelling(p.botPlanner) && !lib.isNewbie(p)) ?? bots[1];
    // (`opts`: the Hitpoints it starts at, its food (null: 8 lobsters; a number: that many shrimps), where it starts and in
    // which phase (south: on the island, its jumps back), and a hook each tick)
    const run = (agility, max, opts = {}) => {
        setLevel(climber, STAT.agility, agility);
        setLevel(climber, STAT.hitpoints, opts.base ?? 60);
        if (opts.shrimps == null) kit(climber, 8);
        else {
            const inv = pack(climber);
            for (let i = 0; i < inv.capacity; i++) inv.delete(i);
            for (let i = 0; i < opts.shrimps; i++) inv.add(lib.Items.SHRIMP, 1);
        }
        const [px, pz] = opts.south ? PeriodPlaces.CAUSEWAY_SOUTH[0].slice(1) : PeriodPlaces.CAUSEWAY_SOUTH_END;
        place(climber, px, pz);
        sim.tick();
        const inner = new L.LighthouseTask();
        const task = new Buzz.BuzzTask('lighthouse', inner);
        hold(climber, task);
        if (opts.hp != null) climber.levels[3] = opts.hp;
        // (on the island on its way back: the task's own phase, as after a visit's top)
        if (opts.south) Object.assign(inner, { phase: 'south', index: 0, going: false });
        const j0 = jumps();
        const s0 = { ...L.lighthouseStats };
        const trace = { island: false, inside: false, top: false, levels: new Set(), minHp: climber.levels[3], dead: false };
        let t = 0;
        for (; t < max && !task.isComplete(climber); t++) {
            climber.runenergy = 10000;
            sim.tick();
            trace.minHp = Math.min(trace.minHp, climber.levels[3]);
            if (climber.levels[3] <= 0) trace.dead = true;
            if (opts.each?.(t, inner, task) === 'stop') break;
            if (process.env.BZ_DEBUG) out(`  t${t} ${climber.x},${climber.z},${climber.level} ${inner.state} d${climber.delayed ? 1 : 0} hp${climber.levels[3]} wp${climber.hasWaypoints() ? 1 : 0} tgt${climber.target ? 1 : 0} ${JSON.stringify(L.lighthouseStats)}`);
            if (climber.z >= 3619 && climber.level === 0) trace.island = true;
            if (climber.z >= 3636) trace.inside = true;
            trace.levels.add(climber.level);
            if (climber.level === 2) trace.top = true;
        }
        const role = lib.eventRoleOf?.(climber)?.role ?? null;
        if (!opts.keep) hold(climber);
        // (the tasks kept on the result, out of its JSON)
        return Object.defineProperties({ t, done: task.isComplete(climber), at: [climber.x, climber.z, climber.level], jumps: jumps() - j0, roleNow: role, stats: Object.fromEntries(Object.entries(L.lighthouseStats).map(([k, v]) => [k, v - s0[k]])), trace, shore: !L.acrossCauseway(climber), role: lib.eventRoleOf?.(climber) ?? null }, { inner: { value: inner }, task: { value: task } });
    };
    const good = run(70, 3000);
    check('lighthouse: Agility 70: north over the causeway, in by the door, up to the top and down, out, back south', good.done && good.trace.island && good.trace.inside && good.trace.top && good.stats.top === 1 && good.stats.back === 1, good);
    check('lighthouse: back on the Rellekka side, no rescue jump, no role left', good.shore && good.jumps === 0 && good.role === null, good);
    const bad = run(1, 3000);
    // (at Agility 1 a jump at a slip spot takes 1 in 50 or so: most seeds give up after 3 slips; a lucky one crosses and
    // slips its way back over spot 8)
    check('lighthouse: Agility 1: it slips (the game\'s roll), gives up after 3 slips (or, lucky, crosses and comes back), on the Rellekka side', bad.done && bad.stats.slips >= 3 && (bad.stats.gaveUp === 1 || bad.stats.back === 1) && bad.shore && bad.jumps === 0, bad);
    // (the fixes, moveH-1: a Hitpoints floor before the slip spots; a death ends the visit)
    const slim = r => ({ t: r.t, done: r.done, at: r.at, jumps: r.jumps, stats: r.stats, shore: r.shore, role: r.role, roleNow: r.roleNow, minHp: r.trace.minHp, dead: r.trace.dead });
    const weak = run(70, 200, { hp: 6, shrimps: 0 });
    check('lighthouse: 6 Hitpoints and no food at the south end: it gives up on the shore, no jump clicked (spot 3 can slip 10)', weak.done && weak.stats.gaveUp === 1 && weak.stats.jumps === 0 && weak.stats.slips === 0 && weak.shore && weak.jumps === 0 && weak.role === null, slim(weak));
    // (southbound, on the island with spot 8 ahead: it stands; Agility 99 so its jumps all but never slip once healed)
    const rest = run(99, 250, { hp: 5, shrimps: 0, south: true, keep: true });
    check('lighthouse: 5 Hitpoints and no food on the island (spot 8 ahead): it stands, no jump clicked, its role held', !rest.done && rest.stats.rests === 1 && rest.stats.jumps === 0 && rest.stats.slips === 0 && L.acrossCauseway(climber) && climber.z >= 3619 && rest.roleNow === L.LIGHTHOUSE_ROLE && rest.jumps === 0, slim(rest));
    {
        // (its Hitpoints back: it jumps on, the visit's own task as it was)
        climber.levels[3] = climber.baseLevels[3];
        const b0 = L.lighthouseStats.back;
        const j0 = jumps();
        let t = 0;
        for (; t < 800 && !rest.task.isComplete(climber); t++) {
            climber.runenergy = 10000;
            sim.tick();
        }
        const role = lib.eventRoleOf?.(climber)?.role ?? null;
        check('lighthouse: its Hitpoints back, it jumps south to the Rellekka side, no rescue jump, no role left', rest.task.isComplete(climber) && L.lighthouseStats.back === b0 + 1 && !L.acrossCauseway(climber) && jumps() === j0 && role === null, { t, at: [climber.x, climber.z], role, back: L.lighthouseStats.back - b0, jumps: jumps() - j0 });
        hold(climber);
    }
    // (the reviewer's case: Agility 35, Hitpoints 30, 3 shrimps (3 each): about 5 crossings in 100 died before the floor)
    const tight = run(35, 9000, { base: 30, shrimps: 3 });
    check('lighthouse: Agility 35, Hitpoints 30, 3 shrimps: never under 1 Hitpoint, done on the Rellekka side, no rescue jump', tight.done && !tight.trace.dead && tight.stats.died === 0 && tight.shore && tight.jumps === 0 && tight.role === null, slim(tight));
    // (a death all the same: the respawn in Lumbridge, a jump's click pending)
    let clicked = false;
    const died = run(99, 60, {
        south: true,
        each: (t, inner) => {
            if (!clicked && inner.before) {
                clicked = true;
                climber.levels[3] = climber.baseLevels[3];
                place(climber, 3222, 3218);
            }
        }
    });
    check('lighthouse: a death on the causeway (the respawn far off): the visit ends at once, its role cleared, no jump judged, no rescue jump', clicked && died.done && died.stats.died === 1 && died.stats.jumps === 0 && died.stats.stuck === 0 && died.jumps === 0 && died.role === null && died.t < 10, slim(died));
}

// ---- sights ----
if (want('sights')) {
    scene(SEED, 'sights');
    P.resetPeriodForTest();
    const visitor = bots.find(p => p !== fighter && lib.isLevelling(p.botPlanner) && !lib.isNewbie(p) && p !== bots[1]) ?? bots[2];
    kit(visitor);
    const [sx, sz] = lib.MembersPlaces.RELLEKKA_SQUARE;
    place(visitor, sx, sz);
    sim.tick();
    const task = new Buzz.BuzzTask('rellekka', new Buzz.RellekkaTourTask());
    hold(visitor, task);
    const t0 = { ...Buzz.tourStats };
    const j0 = jumps();
    let t = 0;
    for (; t < 2000 && !task.isComplete(visitor); t++) {
        visitor.runenergy = 10000;
        sim.tick();
    }
    const stops = Buzz.tourStats.stops - t0.stops;
    const end = P.periodLog.filter(v => v.name === visitor.username).at(-1);
    check('sights: a sightseer stands at 3-4 of Rellekka\'s stops, its visit over, no rescue jump', task.isComplete(visitor) && stops >= 3 && stops <= 4 && ['over', 'time'].includes(end?.outcome) && jumps() === j0, { t, stops, end, beers: Buzz.tourStats.beers - t0.beers, jumps: jumps() - j0 });
    hold(visitor);
}

// ---- lines ----
if (want('lines')) {
    scene(SEED, 'lines');
    const kinds = ['crabs', 'rellekka', 'lighthouse'].flatMap(k => [`buzz-go-${k}`, `buzz-there-${k}`, `buzz-leave-${k}`]).concat(['crabs-woke', 'crabs-wait', 'rellekka-beer', 'lighthouse-slip', 'lighthouse-giveup', 'lighthouse-made', 'lighthouse-top']);
    const empty = kinds.filter(k => lib.NEW_LINES.filter(l => l.tag.event === 'buzz' && (l.tag.kinds ?? []).includes(k)).length === 0);
    check('lines: every buzz kind the tasks say has lines', empty.length === 0, empty);
    // a buzz line heard: a bot near is boosted (theme D's word), the speaker not
    const [speaker, hearer] = bots.filter(p => lib.isLevelling(p.botPlanner) && !lib.isNewbie(p)).slice(0, 2);
    place(speaker, 3200, 3240);
    place(hearer, 3203, 3241);
    // (a line the earlier scenes' bots still had to type, said first: then the boosts forgotten)
    for (let t = 0; t < 40; t++) sim.tick();
    P.resetPeriodForTest();
    const b0 = Buzz.buzzHeard.boosted;
    for (let i = 0; i < 4 && P.buzzBoostOf(hearer).factor === 1; i++) {
        Buzz.sayBuzzLine(speaker, 'buzz-there-crabs', 'crabs', 1);
        for (let t = 0; t < 30; t++) sim.tick();
    }
    check('lines: a buzz line heard within 15 tiles boosts the hearer\'s offer (the key leaned to), not the speaker\'s', P.buzzBoostOf(hearer).factor === P.BUZZ_BOOST && P.buzzBoostOf(hearer).key === 'crabs' && P.buzzBoostOf(speaker).factor === 1 && Buzz.buzzHeard.boosted > b0, { hearer: P.buzzBoostOf(hearer), speaker: P.buzzBoostOf(speaker) });
}

// ---- off: theme G off, the buzz's shared data as before it (the fixes, moveH-4) ----
if (want('off')) {
    scene(SEED, 'off');
    // (aedac0b's, as its data/threads.json and port/BotMinigames had them)
    const CW_BEFORE = { ask: ['castle wars next month!!', 'cant wait for castle wars', 'castle wars soon'], answer: ['ya cant wait', 'whats castle wars', 'finally', 'ya', 'sweet'], own: ['gonna be so fun', 'its like capture the flag', 'its gonna be sick', 'sara or zammy lol'], after: ['sweet', 'nice', 'cool', 'ya'] };
    const ASKS = ['where are rock crabs', 'where is rellekka', 'where is the lighthouse', 'where are the crabs'];
    const look = () => ({ weight: lib.catalogueWeightForTest('rellekka-fishing'), towns: ASKS.map(q => lib.townIn(q)?.say ?? null), varrock: lib.townIn('where is varrock')?.say ?? null });
    P.setPeriodForTest({ on: false });
    let draws = 0;
    const real = Math.random;
    Math.random = () => (draws++, real());
    const off = look();
    Math.random = real;
    P.setPeriodForTest({ on: true });
    const on = look();
    P.setPeriodForTest(null);
    check('off: theme G off, the Rellekka fishing outing\'s weight is 1.5 (2.5 on)', off.weight === 1.5 && on.weight === 2.5, { off: off.weight, on: on.weight });
    check('off: the cw thread\'s pools are aedac0b\'s (its new lines in cwSoon, drawn only with G on)', JSON.stringify(lib.THREAD_LINES.topics.cw) === JSON.stringify(CW_BEFORE) && ['they said castle wars soon', 'sara or zammy?'].every(l => lib.THREAD_LINES.topics.cwSoon.own.includes(l)), lib.THREAD_LINES.topics.cw);
    check('off: theme G off, no town for Rellekka, the crabs or the lighthouse (on: theirs); Varrock as ever; no dice', off.towns.every(t => t === null) && on.towns.every(t => t !== null) && off.varrock === 'varrock' && on.varrock === 'varrock' && draws === 0, { off, on, draws });
}

P.setPeriodForTest(null);
check('no errors', errors.length === 0 && lib.botErrorCount() === 0, errors.slice(0, 3).join(' | '));
const failed = checks.filter(c => !c.ok);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : `: ${c.detail}`}`);
out(failed.length ? `buzz: ${failed.length} of ${checks.length} failed` : `buzz: all ${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
