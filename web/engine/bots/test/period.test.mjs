#!/usr/bin/env node
// Period content (bots ideas round 3, theme G, the G builder), in the real 274 world (16 aged bots, members, theme G on: Sim.create({ period:
// true }); the director, the cliques' doings, habits, hang-outs, the arena, random events, trains, alching, scams and
// witnesses off; every bot held with a stand task), each scene on dice of its own (test/lib/dice.mjs scene):
//   kitten     a cat person's trip (port/BotPets, tasks/PetTripTask): its sub-task from the habit, Gertrude's door
//              clicked open, her dialogue, 100 coins, the kitten out beside it; the visit noted (kind 'pet'); the kitten
//              follows a 30-tile walk, is fed (a sardine used on it: hunger 0) and stroked (its page continued), comes
//              after a jump; 40 minutes of the habit with no pet page left open and the kitten kept; out of pet food, a
//              food trip takes its own fish from the bank; a logout and a login keep it (274's follower_login); a death
//              loses it (death.rs2's follower_death), counted as a death, not neglect; no dice while theme G is off
//   runelink   two bots down Burthorpe's stairs and the hall's stairs into the Runelink room, the longer waiter's
//              challenge (op 1, Challenge) answered, a whole game by the column buttons (no move forced by the sand timer,
//              no turn of 30 s, no engine error), out by the stairs to Burthorpe, no rescue jump; a bot waiting there never
//              challenges the human, answers the human's challenge in 3-10 s and plays it; the human resigns (274's
//              resign path: its engine errors noted) and the bot reads the end screen and goes
//   gnomeball  the walk in by the Stronghold, the gate (both hands unequipped), the referee's ball, shots and a win (the
//              game's Ranged and Agility XP), out by the gate, the weapon wielded again, the free ball dropped; no tackle
//              with the human away, a real one with the human in view
//   talk       the topic pet only with a pet out, gamesroom on a members world, Castle Wars' thread lines to come, the
//              answers (a kitten, the Games Room, Runelink, Gnomeball, Castle Wars), the doing phrases and the place; none
//              of it while theme G is off; (round 3's tune) the period's idle talk in the due idle line's place: off,
//              nothing and no dice; on, about its share, kind 'idle', spread over the kinds, each to whom it fits; (the
//              KQ fixes, T-3) the update's quests talked of (idle and in threads) as done or to do as the bot's own
//              answer to "did you do X" says
//   cw         no task's spot within 16 tiles of Castle Wars' sealed lobby; none of its lines says it is open (PC9)
//   lines      every period moment has lines, said as set pieces; nothing while theme G is off; every kind of the idle
//              talk has lines
//   errors     none
//
//   node --expose-gc web/engine/bots/test/period.test.mjs [--seed=3] [--only=kitten,runelink,gnomeball,talk,cw,lines]
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
const ONLY = args.only ?? null;
const want = name => ONLY === null || ONLY.split(',').includes(name);
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

const engineDir = prepareEngineClone('period', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/period.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, Period: P, Pets, Items, PeriodPlaces, PlayerStat, InvType } = lib;
const cheb = (ax, az, bx, bz) => Math.max(Math.abs(ax - bx), Math.abs(az - bz));

const N = 16;
const sim = await lib.Sim.create({ bots: N, members: true, debug: false, ageNewBots: true, ackLogouts: true, period: true });
sim.addHuman(3222, 3218, 0);
// (nobody a cat person but the scenes' own)
Pets.setCatPeopleForTest([]);
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
check(`${N} bots in the world, theme G on`, bots.length === N && P.periodOn(), { bots: bots.length, on: P.periodOn() });
check("the pet habit in BotPlayer's periodHabits (port/BotPeriodIndex)", lib.periodHabits.includes(Pets.tickPets));

const STAND = { name: 'Idle', reset() {}, interrupt() {}, interrupted: false, shouldRun: () => true, isComplete: () => false, tick() {}, activityStep: () => null };
/** held where it is with a stand task of this name (its sub-task cleared), full Hitpoints and run energy */
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
    p.levels[PlayerStat.HITPOINTS] = p.baseLevels[PlayerStat.HITPOINTS];
    p.runenergy = 10000;
}
for (const p of bots) hold(p);
function run(ticks, until = () => false) {
    for (let i = 0; i < ticks; i++) {
        sim.tick();
        if (until()) return i + 1;
    }
    return -1;
}
/** a clean pack (and worn) with these items, the bank cleared of what the scene gives */
function kit(p, items, worn = []) {
    p.clearPendingAction();
    p.clearWaypoints();
    p.getInventory(InvType.INV).removeAll();
    p.getInventory(InvType.WORN).removeAll();
    lib.giveItems(p, items, false);
    lib.wearItems(p, worn);
    p.runenergy = 10000;
}
function bankOf(p) {
    const id = InvType.getId('bank');
    return id === -1 ? null : p.getInventory(id);
}
function place(p, x, z, level = 0) {
    p.teleJump(x, z, level);
    run(1);
}
/** a walk task: walkTo when it has no route, and every 10 ticks */
function walkTask(x, z, level = 0, near = 2) {
    const t = Object.assign(Object.create(STAND), { name: 'Walk', interrupted: false, done: false });
    t.tick = p => {
        if (p.level === level && cheb(p.x, p.z, x, z) <= near) {
            t.done = true;
            return;
        }
        if (!p.hasWaypoints() || World.currentTick % 10 === 0) lib.walkTo(p, x, z, level);
    };
    t.isComplete = () => t.done;
    return t;
}
function assign(p, task) {
    const ai = sim.botPlayer(p);
    ai.currentTask = task;
    ai.planEnds = World.currentTick + 1e6;
}
const said = [];
lib.sayListeners.push((bot, text, kind) => said.push({ name: bot.username, text, kind, t: World.currentTick }));
const free = bots.filter(p => lib.isLevelling(p.botPlanner) && !lib.isNewbie(p) && p.combatLevel >= 15);
const take = () => free.shift();

// ======== kitten: Gertrude's door, the purchase, the follow, feeding, stroking, a jump, 40 minutes, a food trip, a
// logout and a login, a death ========
if (want('kitten')) {
    scene(SEED, 'kitten');
    let p = take();
    const name = p.username;
    hold(p);
    kit(p, [[Items.COINS, 400], [Items.RAW_SARDINE, 6]]);
    bankOf(p)?.removeAll();
    place(p, 3165, 3424);
    Pets.resetPetStatsForTest();
    Pets.setCatPeopleForTest([name]);
    Pets.forgetCareForTest(p);
    // (no dice and nothing done while theme G is off)
    P.setPeriodForTest({ on: false });
    const r0 = Math.random;
    let draws = 0;
    Math.random = () => (draws++, r0());
    const habitOff = Pets.tickPets(sim.botPlayer(p));
    Math.random = r0;
    check('theme G off: the pet habit does nothing and draws no dice', habitOff === false && draws === 0 && Pets.careForTest(p) === null, { draws });
    P.setPeriodForTest(null);
    run(1);
    check('a cat person (the test\'s) is tracked by the habit', Pets.careForTest(p)?.track === true);
    Pets.dueCareForTest(p, 'trip');
    let sawTrip = false;
    const visits0 = P.periodStats.visits.pet ?? 0;
    const coins0 = p.getInventory(InvType.INV).getItemCount(Items.COINS);
    const t = run(900, () => {
        if (sim.botPlayer(p).subTask?.name === 'PetTrip') sawTrip = true;
        return Pets.petObjOf(p) !== -1 && !sim.botPlayer(p).hasSubTask();
    });
    const pet = Pets.petOf(p);
    check('the trip: a PetTrip sub-task from the habit, the kitten bought', sawTrip && t !== -1 && pet?.kind === 'kitten', { sawTrip, t, obj: Pets.petObjOf(p), trip: lib.petTripStats, at: [p.x, p.z] });
    check("Gertrude's door clicked open (or found open), her dialogue talked", lib.petTripStats.talks >= 1, lib.petTripStats);
    check('100 coins paid (274: gertrude.rs2)', coins0 - p.getInventory(InvType.INV).getItemCount(Items.COINS) === 100, coins0 - p.getInventory(InvType.INV).getItemCount(Items.COINS));
    check('the kitten beside it (the follower NPC whose uid is its own)', pet !== null && cheb(pet.npc.x, pet.npc.z, p.x, p.z) <= 3, pet ? [pet.npc.x, pet.npc.z, p.x, p.z] : null);
    check("the visit noted: kind 'pet', ended 'bought'; petStats.bought 1", (P.periodStats.visits.pet ?? 0) === visits0 + 1 && P.periodLog.some(v => v.name === name && v.kind === 'pet' && v.outcome === 'bought') && Pets.petStats.bought === 1, { visits: P.periodStats.visits, log: P.periodLog.filter(v => v.name === name) });
    // (the follow: out of her house, then a 30-tile walk)
    hold(p);
    const outside = walkTask(PeriodPlaces.GERTRUDE_OUTSIDE[0] + 2, PeriodPlaces.GERTRUDE_OUTSIDE[1] + 3, 0, 0);
    assign(p, outside);
    run(60, () => outside.done);
    hold(p);
    run(15);
    const walk = walkTask(p.x + 28, p.z + 12);
    assign(p, walk);
    const dists = [];
    run(200, () => {
        const k = Pets.petOf(p);
        if (World.currentTick % 5 === 0 && k) dists.push(cheb(k.npc.x, k.npc.z, p.x, p.z));
        return walk.done;
    });
    // (held at once where the walk ended: its planner's next task walked it off in those 15 ticks at some seeds)
    hold(p);
    run(15);
    const after = Pets.petOf(p);
    // (within 274's 15 tiles after: its ai_timer puts it beside the owner only past them, and a kitten caught on a fence
    // at 15 stays there, as at seeds 9 and 10)
    check('the kitten follows a 30-tile walk (it trails a running owner; 274 brings it back past 15 tiles), within them after', walk.done && after !== null && Math.max(...dists) <= 17 && cheb(after.npc.x, after.npc.z, p.x, p.z) <= 15, { done: walk.done, dists, after: after ? cheb(after.npc.x, after.npc.z, p.x, p.z) : null });
    // (a feed and a stroke, due now)
    const sard0 = p.getInventory(InvType.INV).getItemCount(Items.RAW_SARDINE);
    const fed0 = Pets.petStats.fed;
    Pets.dueCareForTest(p, 'feed');
    run(30, () => Pets.petStats.fed > fed0 && !Pets.careForTest(p)?.act);
    run(3);
    check('fed: a sardine used on it, hunger 0', Pets.petStats.fed === fed0 + 1 && p.getInventory(InvType.INV).getItemCount(Items.RAW_SARDINE) === sard0 - 1 && Pets.petNeeds(p).hunger === 0, { fed: Pets.petStats.fed, sard: p.getInventory(InvType.INV).getItemCount(Items.RAW_SARDINE), needs: Pets.petNeeds(p) });
    const st0 = Pets.petStats.stroked;
    const pages0 = Pets.petStats.pagesContinued;
    Pets.dueCareForTest(p, 'stroke');
    run(30, () => Pets.petStats.stroked > st0 && !Pets.careForTest(p)?.act);
    run(3);
    check('stroked: its page continued, nothing left open, attention back to 28 (or 23)', Pets.petStats.stroked === st0 + 1 && Pets.petStats.pagesContinued > pages0 && lib.botScript(p) === null && [23, 28].includes(Pets.petNeeds(p).attention), { stroked: Pets.petStats.stroked, pages: Pets.petStats.pagesContinued, needs: Pets.petNeeds(p) });
    // (a jump: the kitten teleports to its owner, 274's ai_timer)
    const [jx, jz] = [p.x + 40, p.z];
    lib.botTeleport(p, jx, jz, 0, 'task');
    run(5);
    const k2 = Pets.petOf(p);
    check('after a 40-tile jump the kitten is beside it within 5 ticks', k2 !== null && cheb(k2.npc.x, k2.npc.z, p.x, p.z) <= 3, k2 ? [k2.npc.x, k2.npc.z, p.x, p.z] : null);
    // (40 minutes of the habit at its own pace: no page left open, the kitten kept)
    const open0 = Pets.petStats.pagesOpen;
    const fedA = Pets.petStats.fed;
    const strA = Pets.petStats.stroked;
    let openTicks = 0;
    let longest = 0;
    run(2400, () => {
        if (lib.botScript(p) && p.activeScript?.execution === 3) {
            openTicks++;
            longest = Math.max(longest, openTicks);
        } else openTicks = 0;
        return false;
    });
    check('40 minutes: fed and stroked at its own pace, no pet page left open 10 s, the kitten kept', Pets.petStats.pagesOpen === open0 && longest < 17 && Pets.petStats.fed > fedA && Pets.petStats.stroked > strA && Pets.petOf(p) !== null, { pagesOpen: Pets.petStats.pagesOpen - open0, longest, fed: Pets.petStats.fed - fedA, stroked: Pets.petStats.stroked - strA, needs: Pets.petNeeds(p), warnings: Pets.petStats.warnings });
    // (out of pet food: a food trip takes its own fish from the bank)
    hold(p);
    kit(p, [[Items.COINS, 200]]);
    bankOf(p)?.add(Items.RAW_TROUT, 7);
    const trips0 = Pets.petStats.foodTrips;
    Pets.dueCareForTest(p, 'feed');
    Pets.dueCareForTest(p, 'trip');
    const tf = run(700, () => Pets.petStats.foodTrips > trips0 && !sim.botPlayer(p).hasSubTask() && lib.petTripStats.bankFood > 0);
    check('out of pet food: a food trip, its own raw trout from the bank (none bought)', tf !== -1 && p.getInventory(InvType.INV).getItemCount(Items.RAW_TROUT) + Pets.petStats.fed - Pets.petStats.fed >= 4 && (bankOf(p)?.getItemCount(Items.RAW_TROUT) ?? 0) <= 3, { tf, trout: p.getInventory(InvType.INV).getItemCount(Items.RAW_TROUT), bank: bankOf(p)?.getItemCount(Items.RAW_TROUT), trip: lib.petTripStats });
    hold(p);
    // (the review's G-4: a kitten with no pet food and 50 coins: no trip to Port Sarim, whose shop wants 80 (PetTripTask
    // shopCoinsFor), where it asked 30 and the trip ended at once with no food every look)
    kit(p, [[Items.COINS, 50]]);
    bankOf(p)?.removeAll();
    const tripsShort = Pets.petStats.trips;
    Pets.dueCareForTest(p, 'trip');
    run(30);
    check("a kitten with no food and 50 coins: no trip (the shop's 80 coins asked first)", Pets.petObjOf(p) !== -1 && Pets.petStats.trips === tripsShort && !sim.botPlayer(p).hasSubTask(), { trips: Pets.petStats.trips - tripsShort, sub: sim.botPlayer(p).subTask?.name ?? null, ended: lib.petTripStats.ended });
    // (a trip that comes back with no food, its pack full: the next look 15 minutes on, not every TRIP_LOOK)
    hold(p);
    kit(p, [[Items.COINS, 100], [lib.ObjType.getId('bones'), 27]]);
    const noFood0 = lib.petTripStats.ended['no-food'] ?? 0;
    const tripsFull = Pets.petStats.trips;
    Pets.dueCareForTest(p, 'trip');
    run(40);
    const lookIn = (Pets.careForTest(p)?.tripLook ?? 0) - World.currentTick;
    check("a trip that came back with no food (its pack full): the next look 15 minutes on", Pets.petStats.trips === tripsFull + 1 && (lib.petTripStats.ended['no-food'] ?? 0) === noFood0 + 1 && lookIn > 1000, { trips: Pets.petStats.trips - tripsFull, ended: lib.petTripStats.ended, lookIn });
    // (as before: coins and its own fish in the pack)
    kit(p, [[Items.COINS, 200], [Items.RAW_TROUT, 4]]);
    hold(p);
    // (a logout and a login: 274's follower_login re-adds it)
    const obj = Pets.petObjOf(p);
    BotManager.leaveSoon(name, 1, { abrupt: true, away: [1, 3] });
    run(300, () => p.slot === -1);
    const outNow = p.slot === -1;
    let back = null;
    // (its return now: the manager's queue, as a returner's whose absence is over; again while its logout is saved)
    const member = [...BotManager.members.values()].find(m => m.name === name);
    // (the logout's save acknowledged: the sim's login thread answers in a microtask, after the run loop yields)
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    run(600, () => {
        if (member && member.state === 'offline') BotManager._queue(member);
        back = World.getPlayerByUsername(name) ?? null;
        return back !== null && back.slot !== -1 && (sim.botPlayer(back) ?? null) !== null;
    });
    if (outNow && back) {
        // (held from its login: its planner's first task walked it off before the look at some seeds)
        hold(back);
        run(8);
        hold(back);
        // (the kitten put down near it by 274's follower_login, then following: a moment to come up, at most 20 ticks)
        run(20, () => {
            const k = Pets.petOf(back);
            return k !== null && cheb(k.npc.x, k.npc.z, back.x, back.z) <= 6;
        });
        const k3 = Pets.petOf(back);
        check('a logout and a login keep it: the same pet item, the kitten near it again', Pets.petObjOf(back) === obj && k3 !== null && cheb(k3.npc.x, k3.npc.z, back.x, back.z) <= 6, { obj, now: Pets.petObjOf(back), k3: k3 ? cheb(k3.npc.x, k3.npc.z, back.x, back.z) : null });
        p = back;
    } else check('a logout and a login keep it (the bot logged out and back in)', false, { outNow, back: !!back, member: member ? { state: member.state, name: member.name } : null, name });
    // (a death: the game's own damage script; the pet goes, counted as a death)
    if (p.slot !== -1) {
        hold(p);
        Pets.setCatPeopleForTest([name]);
        const lost0 = { ...Pets.petStats.lost };
        const script = lib.ScriptProvider.getByName('[queue,damage_player]');
        p.enqueueScript(script, lib.PlayerQueueType.NORMAL, 0, [p.levels[PlayerStat.HITPOINTS]]);
        run(40, () => p.levels[PlayerStat.HITPOINTS] <= 0);
        run(40);
        run(30);
        check('a death loses it (death.rs2 follower_death), counted as a death', Pets.petObjOf(p) === -1 && Pets.petStats.lost.death === lost0.death + 1 && Pets.petStats.lost.neglect === lost0.neglect, { obj: Pets.petObjOf(p), lost: Pets.petStats.lost });
        p.levels[PlayerStat.HITPOINTS] = p.baseLevels[PlayerStat.HITPOINTS];
        hold(p);
    }
    Pets.setCatPeopleForTest([]);
}

// ======== runelink: two bots down the stairs, a whole game through the real screens, out by the stairs; the human's
// challenge answered in 3-10 s, its game, its resign; bots never challenge the human ========
if (want('runelink')) {
    scene(SEED, 'runelink');
    const { Runelink: R, GamesRoom: G } = lib;
    R.resetRunelinkStatsForTest();
    G.resetRoomForTest();
    const a = take();
    const b = take();
    const c = take();
    for (const p of [a, b, c]) {
        hold(p);
        kit(p, [[Items.COINS, 20]]);
    }
    // (one from the castle's north side, one from the side room west of the stairs hall, where bots that clicked the
    // stairs from a side room stood with "I can't reach that!")
    place(a, 2899, 3570);
    place(b, 2896, 3568);
    const jumps0 = { ...(P.periodStats.moves.games ?? {}) };
    const err0 = errors.length;
    const ta = new G.GamesRoomTask('leader', 1);
    const tb = new G.GamesRoomTask('joiner', 1);
    assign(a, ta);
    assign(b, tb);
    // (staged: no second game; the visits end after one)
    let inRoom = false;
    let sawGame = false;
    let maxTurn = 0;
    let turnSince = new Map();
    const trace = [];
    const endedAt = new Map();
    const t1 = run(3000, () => {
        if (World.currentTick % 25 === 0 && trace.length < 80 && World.currentTick > 2950) trace.push(`${World.currentTick} a ${a.x},${a.z},${a.level} ${ta.phase} ${ta.waitSince}/${ta.other?.username ?? '-'}/${ta.nextChallenge} b ${b.x},${b.z},${b.level} ${tb.phase} ${tb.waitSince}/${tb.other?.username ?? '-'}/${tb.nextChallenge} ${R.partnerUid(a)} ${R.partnerUid(b)} ${a.modalMain} ${b.modalMain}`);
        if (G.roomTasksForTest().length === 2 && [a, b].every(p => lib.inGamesRoomBox(p.x, p.z))) inRoom = true;
        if ([a, b].every(p => R.inRunelinkGame(p))) sawGame = true;
        for (const p of [a, b]) {
            if (R.inRunelinkGame(p) && R.myTurn(p)) {
                if (!turnSince.has(p)) turnSince.set(p, World.currentTick);
                maxTurn = Math.max(maxTurn, World.currentTick - turnSince.get(p));
            } else turnSince.delete(p);
        }
        for (const [p, t] of [[a, ta], [b, tb]]) if (t.isComplete(p) && !endedAt.has(p)) endedAt.set(p, [p.x, p.z, p.level]);
        return ta.isComplete(a) && tb.isComplete(b);
    });
    check('two bots down the Burthorpe stairs and the hall\'s stairs, into the room', inRoom, { a: [a.x, a.z, a.level], b: [b.x, b.z, b.level], phases: [ta.phase, tb.phase], trace: trace.slice(0, 30) });
    check('a whole game: both seated, moves made, finished (a win, a loss or a draw)', sawGame && R.runelinkStats.finished === 2 && R.runelinkStats.moves >= 7 && R.runelinkStats.wins + R.runelinkStats.losses + R.runelinkStats.draws === 2, R.runelinkStats);
    check('every move within the deadline: none forced by the sand timer, no turn of 30 s', R.runelinkStats.forced === 0 && maxTurn < 50, { forced: R.runelinkStats.forced, maxTurn });
    check("both out by the stairs to Burthorpe and its castle's doors after, their visits ended", t1 !== -1 && [a, b].every(p => endedAt.has(p) && !lib.inGamesRoomBox(endedAt.get(p)[0], endedAt.get(p)[1]) && endedAt.get(p)[2] === 0 && cheb(endedAt.get(p)[0], endedAt.get(p)[1], 2899, 3565) <= 15), { t1, a: endedAt.get(a), b: endedAt.get(b), exits: lib.exitStats });
    check('no rescue jump on the way (PC10)', JSON.stringify(P.periodStats.moves.games ?? {}) === JSON.stringify(jumps0), P.periodStats.moves.games);
    check('no engine error in the game', errors.length === err0, errors.slice(err0, err0 + 2).join(' | '));
    check('the visits noted (minigame GamesRoom, period kind games)', P.periodLog.filter(v => v.kind === 'games' && (v.name === a.username || v.name === b.username) && v.end !== -1).length === 2, P.periodLog.filter(v => v.kind === 'games'));
    hold(a);
    hold(b);
    // (the human's challenge: a bot waiting in the Runelink room answers it, and they play; the human resigns)
    R.resetRunelinkStatsForTest();
    const [rx0, rz0] = PeriodPlaces.RUNELINK_ROOM_BOX;
    const human = sim.human;
    place(c, 2899, 3570);
    const tc = new G.GamesRoomTask('leader', 1);
    assign(c, tc);
    run(400, () => tc.phase === 'wait');
    check('a bot waits in the Runelink room', tc.phase === 'wait' && c.level === 0 && R.inRunelinkRoom(c.x, c.z), { phase: tc.phase, at: [c.x, c.z, c.level] });
    sim.teleportHuman(c.x + 1, c.z, 0);
    run(3);
    // (60 ticks together, the human challenging nobody: the bot never challenges the human)
    let challenged = false;
    run(60, () => {
        if (R.partnerUid(c) === (human.uid | 0)) challenged = true;
        return false;
    });
    check('bots never challenge the human', !challenged && R.runelinkStats.challenges === 0);
    lib.interactPlayerOp(human, c.slot, 1);
    run(4);
    const humanOptions = R.onOptionsScreen(human);
    lib.interactIfButtonByName(human, 'boardgames_runelink_options:challenge');
    const asked = World.currentTick;
    const err1 = errors.length;
    const answered = run(60, () => R.inRunelinkGame(c) && R.inRunelinkGame(human));
    run(2);
    check("the human's challenge answered by the bot in 3-10 s (its op 1 back, Challenge): the game", humanOptions && answered !== -1 && answered >= 4 && answered <= 22 && R.runelinkStats.humanChallenges === 1 && R.runelinkStats.humanGames === 1, { humanOptions, answered, stats: R.runelinkStats, phase: tc.phase });
    // (the human plays a few moves, then resigns: closes the board)
    let humanMoves = 0;
    run(400, () => {
        if (R.inRunelinkGame(human) && R.myTurn(human) && World.currentTick % 4 === 0) {
            const board = R.boardOf(human);
            for (let col = 1; col <= 7; col++) {
                if (board[col - 1] === 0 && lib.interactIfButtonByName(human, `boardgames_runelink:column_${col}`)) {
                    humanMoves++;
                    break;
                }
            }
        }
        return humanMoves >= 3 && R.myTurn(human);
    });
    const botMoves = R.runelinkStats.moves;
    human.closeModal();
    const ended = run(40, () => !R.inRunelinkGame(c) && tc.phase !== 'game');
    const resignErrors = errors.length - err1;
    check('the human resigns: the bot sees its game over, reads the end screen, goes on', humanMoves >= 3 && botMoves >= 2 && ended !== -1 && R.runelinkStats.finished === 1, { humanMoves, botMoves, ended, phase: tc.phase, stats: R.runelinkStats });
    out(`note: the human's resign: ${resignErrors} engine error line(s)${resignErrors ? ` (${errors.slice(err1, err1 + 1).join(' ').slice(0, 160)})` : ''}`);
    if (resignErrors) errors.splice(err1, resignErrors);
    run(200, () => tc.phase === 'wait' || tc.isComplete(c));
    sim.teleportHuman(3222, 3218, 0);
    run(600, () => tc.isComplete(c));
    hold(c);
    check('the bot out of the room after its visit', !lib.inGamesRoomBox(c.x, c.z), { at: [c.x, c.z, c.level], phase: tc.phase });
    check('no role left on the bots (the logout hold is the game\'s only)', [a, b, c].every(p => lib.eventRoleOf(p) === null));

    // (the review's G-2: the human's challenge with less than a game's time left in the bot's session: it is off, no game)
    const member = [...BotManager.members.values()].find(m => m.name === c.username);
    const duel2accept = lib.VarPlayerType.getId('duel2accept');
    const [rx1, rz1] = PeriodPlaces.RUNELINK_ROOM_BOX.slice(2);
    const roomMid = [Math.round((rx0 + rx1) / 2), Math.round((rz0 + rz1) / 2)];
    /** the bot in the room on a new visit, waiting; the human beside it */
    const waitIn = () => {
        hold(c);
        place(c, roomMid[0], roomMid[1]);
        const task = new G.GamesRoomTask('leader', 1);
        assign(c, task);
        run(300, () => task.phase === 'wait');
        sim.teleportHuman(c.x + 1, c.z, 0);
        run(3);
        return task;
    };
    /** the human's challenge: its op 1 on the bot, its options (15 seconds a move, or as they open), Challenge */
    const humanChallenge = (fifteen) => {
        lib.interactPlayerOp(human, c.slot, 1);
        run(4);
        const opened = R.onOptionsScreen(human);
        if (fifteen) {
            lib.interactIfButtonByName(human, 'boardgames_runelink_options:15seconds_radio');
            run(1);
        }
        lib.interactIfButtonByName(human, 'boardgames_runelink_options:challenge');
        return opened;
    };
    R.resetRunelinkStatsForTest();
    const tl = waitIn();
    const end0 = member?.sessionEnd;
    if (member) member.sessionEnd = BotManager.play + 600;
    const lateOpened = humanChallenge(false);
    run(40, () => tl.phase === 'leave' || tl.isComplete(c));
    check("a human's challenge with less than a game's time left in its session (GAME_LEFT): the bot is off, no game", !!member && (tl.phase === 'leave' || tl.isComplete(c)) && lateOpened && R.runelinkStats.humanChallenges === 0 && R.runelinkStats.games === 0 && !R.inRunelinkGame(c), { member: !!member, left: BotManager.sessionLeftOf(c.username), phase: tl.phase, stats: R.runelinkStats });
    if (member) member.sessionEnd = end0;
    // (the human's challenge withdrawn: its %duel2accept cleared, as a new one would set it)
    human.setVar(duel2accept, -1);

    // (the review's G-1 and G-2: the human challenges with 15 seconds a move; the bot's session ends at the game's start,
    // its give-up short: it plays every move within the 15 s timer (none forced), stays to the end screen, then logs out)
    R.resetRunelinkStatsForTest();
    const tg = waitIn();
    const fastOpened = humanChallenge(true);
    const fastAnswered = run(60, () => R.inRunelinkGame(c) && R.inRunelinkGame(human));
    const sand = R.sandTicks(c);
    const giveUp0 = BotManager.timing.busyGiveUp;
    BotManager.timing.busyGiveUp = 10;
    if (member) member.sessionEnd = BotManager.play;
    let fastHuman = 0;
    let fastTurn = 0;
    let turnFrom = -1;
    const fastTurns = [];
    let seatedTo = -1;
    const fastEnded = run(1500, () => {
        if (R.inRunelinkGame(c) && R.myTurn(c)) {
            if (turnFrom === -1) turnFrom = World.currentTick;
            fastTurn = Math.max(fastTurn, World.currentTick - turnFrom);
        } else if (turnFrom !== -1) {
            fastTurns.push(World.currentTick - turnFrom);
            turnFrom = -1;
        }
        if (R.inRunelinkGame(c)) seatedTo = World.currentTick;
        if (R.inRunelinkGame(human) && R.myTurn(human)) {
            // (the human plays well, and at once: a longer game, its moves before the bot's next tick)
            const col = R.chooseColumn(R.boardOf(human), { win: 1, block: 1 });
            if (col > 0 && lib.interactIfButtonByName(human, `boardgames_runelink:column_${col}`)) fastHuman++;
        }
        return !R.inRunelinkGame(c) && tg.phase !== 'game';
    });
    const fastStats = R.runelinkStatsCopy();
    check("the human's 15 s challenge (its %boardgames_timepermove, copied by the answer): a game on 274's 25-tick sand timer", fastOpened && fastAnswered !== -1 && sand === 25 && fastStats.humanGames === 1, { fastOpened, fastAnswered, sand, stats: fastStats });
    check('every move of the 15 s game within its timer: none forced, no turn of 25 ticks (the review\'s G-1)', fastStats.moves >= 4 && fastStats.forced === 0 && fastTurn < 25, { moves: fastStats.moves, forced: fastStats.forced, fastTurn, fastTurns, fastHuman });
    check("its session over at the game's start, the give-up short: the game played to its end, no resign (the review's G-2)", fastEnded !== -1 && fastStats.resigned === 0 && (fastStats.ended.finished ?? 0) === 1 && seatedTo > 0, { fastEnded, stats: fastStats, phase: tg.phase });
    const out1 = run(600, () => c.slot === -1);
    check('then off after the end screen: logged out', out1 !== -1 && fastStats.resigned === 0, { out1, phase: tg.phase, at: [c.x, c.z, c.level] });
    BotManager.timing.busyGiveUp = giveUp0;
    sim.teleportHuman(3222, 3218, 0);
    run(3);
}

// ======== gnomeball: the walk in from the Stronghold, the gate (hands unequipped), the referee, the ball, a win's XP,
// out by the gate, the weapon wielded again, the free ball dropped; tackles only with the human in view ========
if (want('gnomeball')) {
    scene(SEED, 'gnomeball');
    const { Gnomeball: GB } = lib;
    GB.resetGnomeballStatsForTest();
    const p = take();
    hold(p);
    for (const [stat, lv] of [[PlayerStat.RANGED, 70], [PlayerStat.AGILITY, 50], [PlayerStat.HITPOINTS, 60], [PlayerStat.ATTACK, 40], [PlayerStat.DEFENCE, 20]]) p.setLevel(stat, lv);
    p.combatLevel = p.getCombatLevel();
    kit(p, [[Items.COINS, 100]], [lib.ObjType.getId('rune_scimitar'), lib.ObjType.getId('wooden_shield')]);
    p.levels[PlayerStat.HITPOINTS] = p.baseLevels[PlayerStat.HITPOINTS];
    const [ax, az] = lib.Locations.GNOME_AGILITY;
    place(p, ax, az - 6);
    const xp0 = { r: p.stats[PlayerStat.RANGED], a: p.stats[PlayerStat.AGILITY] };
    const scim = lib.ObjType.getId('rune_scimitar');
    const ball = lib.ObjType.getId('ball_gnomeball_game');
    const task = new GB.GnomeballTask(1);
    assign(p, task);
    let wasInside = false;
    let handsEmpty = false;
    const jumps0 = { ...(P.periodStats.moves.gnomeball ?? {}) };
    const t = run(4000, () => {
        if (GB.onPitch(p)) {
            wasInside = true;
            if (p.getInventory(InvType.WORN).get(3)?.id !== scim && p.getInventory(InvType.INV).getItemCount(scim) === 1) handsEmpty = true;
        }
        return task.isComplete(p);
    });
    const s = GB.gnomeballStats;
    check('the walk in from the Stronghold, the gate (its hands unequipped into the pack), the pitch', wasInside && handsEmpty, { wasInside, handsEmpty, phase: task.phase, at: [p.x, p.z] });
    check("the referee's ball, shots at the goal, a win (the game's XP: Ranged and 300+ Agility)", s.balls >= 1 && s.shots >= 5 && s.wins === 1 && p.stats[PlayerStat.AGILITY] - xp0.a >= 300 && p.stats[PlayerStat.RANGED] - xp0.r >= 300, { s, xp: { r: p.stats[PlayerStat.RANGED] - xp0.r, a: p.stats[PlayerStat.AGILITY] - xp0.a } });
    check('out by the gate, its weapon wielded again, the free ball dropped', t !== -1 && !GB.onPitch(p) && p.getInventory(InvType.WORN).get(3)?.id === scim && s.rewielded >= 1 && p.getInventory(InvType.INV).getItemCount(ball) === 0, { t, at: [p.x, p.z], rhand: p.getInventory(InvType.WORN).get(3)?.id, ball: p.getInventory(InvType.INV).getItemCount(ball), ended: s.ended });
    check('no tackle with the human away (274 hunts a carrier only in a client\'s view)', s.tackles === 0, s.tackles);
    check('no rescue jump (PC10)', JSON.stringify(P.periodStats.moves.gnomeball ?? {}) === JSON.stringify(jumps0), P.periodStats.moves.gnomeball);
    check('the visit noted (minigame Gnomeball, period kind gnomeball)', P.periodLog.some(v => v.kind === 'gnomeball' && v.name === p.username && v.end !== -1));
    // (with the human watching: the tacklers hunt; a low agility loses the ball)
    hold(p);
    p.setLevel(PlayerStat.AGILITY, 30);
    const [sx, sz] = PeriodPlaces.GNOMEBALL_SIDE;
    place(p, sx, sz);
    sim.teleportHuman(2392, 3497, 0);
    run(3);
    const t2 = new GB.GnomeballTask(1);
    assign(p, t2);
    const gtrace = [];
    run(900, () => {
        if (World.currentTick % 6 === 0 && gtrace.length < 60) gtrace.push(`${World.currentTick} ${p.x},${p.z} ${t2.phase} ball=${p.getInventory(InvType.WORN).get(3)?.id === ball} scr=${p.activeScript?.execution ?? '-'} opts=${p.resumeButtons?.length ?? 0} modal=${p.modalMain}/${p.modalChat} tgt=${p.target ? 'y' : 'n'} d=${p.delayed}`);
        return GB.gnomeballStats.tackles >= 1 || t2.isComplete(p);
    });
    check('with the human in view the tacklers hunt: a real tackle, the referee again', GB.gnomeballStats.tackles >= 1, { s: GB.gnomeballStats, phase: t2.phase, at: [p.x, p.z], hp: p.levels[PlayerStat.HITPOINTS], trace: gtrace.slice(0, 40) });
    // (the review's G-3: a carrier is tackled back only with the bot's own ball, 274's %npc_attacking_uid; one with the
    // human's is left alone. Staged in one tick: a gnome made a carrier of the human's ball, then of the bot's, reverted)
    {
        const red = lib.NpcTypeConfig.getId('gnomeballer_red');
        const redBall = lib.NpcTypeConfig.getId('gnomeballer_red_withball');
        const taker = lib.VarNpcType.getId('npc_attacking_uid');
        const g = lib.findNpcFiltered(p.x, p.z, 0, n => n.type === red, 40);
        let staged = null;
        if (g && redBall !== -1 && taker !== -1) {
            const was = g.getVar(taker);
            g.changeType(redBall, 50, false);
            g.setVar(taker, sim.human.uid | 0);
            const humans = GB.carriesBallOf(g, sim.human) && !GB.carriesBallOf(g, p);
            g.setVar(taker, p.uid | 0);
            const own = GB.carriesBallOf(g, p) && !GB.carriesBallOf(g, sim.human);
            g.setVar(taker, typeof was === 'number' ? was : -1);
            g.changeType(g.baseType, 1, false);
            staged = { humans, own, back: g.type === red };
        }
        check("only its own ball's carrier is the bot's to tackle back, never the human's (the review's G-3)", staged !== null && staged.humans && staged.own && staged.back, staged);
    }
    sim.teleportHuman(3222, 3218, 0);
    run(1500, () => t2.isComplete(p));
    check('and out again with its weapon on', !GB.onPitch(p) && p.getInventory(InvType.WORN).get(3)?.id === scim, { at: [p.x, p.z], phase: t2.phase });
    hold(p);
}

// ======== talk: the thread topics pet (with a pet out) and gamesroom, the answers; none while theme G is off ========
const CASTLE_WARS_OPEN = /playing (cw|castle wars)|(cw|castle wars) game|won (at|a) (cw|castle wars)/i;
if (want('talk')) {
    scene(SEED, 'talk');
    const { PeriodTalk: T } = lib;
    // (a kitten for a cat person: its trip from her door)
    const owner = free.find(p => p.slot !== -1 && Pets.petObjOf(p) === -1) ?? take();
    hold(owner);
    kit(owner, [[Items.COINS, 300], [Items.RAW_SARDINE, 5]]);
    place(owner, PeriodPlaces.GERTRUDE_OUTSIDE[0], PeriodPlaces.GERTRUDE_OUTSIDE[1] + 1);
    Pets.setCatPeopleForTest([owner.username]);
    Pets.forgetCareForTest(owner);
    run(1);
    Pets.dueCareForTest(owner, 'trip');
    run(600, () => Pets.petOf(owner) !== null && !sim.botPlayer(owner).hasSubTask());
    hold(owner);
    check('a pet out for the talk scene', Pets.hasPetOut(owner), Pets.petObjOf(owner));
    const others = sim.bots().filter(p => p !== owner && p.slot !== -1 && Pets.petObjOf(p) === -1).slice(0, 10);
    const topicsOf = (a, b, n) => {
        const seen = new Map();
        const lines = [];
        for (let i = 0; i < n; i++) {
            const t = lib.drawThread(a, b, 6);
            if (!t) continue;
            for (const id of lib.lastThreadTopicsForTest()) seen.set(id, (seen.get(id) ?? 0) + 1);
            if (lib.lastThreadTopicsForTest().includes('cw')) lines.push(...t.map(l => l.text));
        }
        return { seen, lines };
    };
    // (theme G off: no pet, gamesroom, nor the period's Castle Wars pools)
    P.setPeriodForTest({ on: false });
    const offSeen = new Set();
    for (const a of others.slice(0, 5)) for (const id of topicsOf(a, owner, 40).seen.keys()) offSeen.add(id);
    check('theme G off: the topics pet and gamesroom never drawn', !offSeen.has('pet') && !offSeen.has('gamesroom'), [...offSeen]);
    P.setPeriodForTest(null);
    let petWith = 0;
    let petWithout = 0;
    let rooms = 0;
    const cwLines = [];
    for (const a of others.slice(5)) {
        const withPet = topicsOf(a, owner, 40);
        petWith += withPet.seen.get('pet') ?? 0;
        rooms += withPet.seen.get('gamesroom') ?? 0;
        cwLines.push(...withPet.lines);
    }
    for (let i = 0; i + 1 < others.length; i += 2) {
        const without = topicsOf(others[i], others[i + 1], 40);
        petWithout += without.seen.get('pet') ?? 0;
        rooms += without.seen.get('gamesroom') ?? 0;
        cwLines.push(...without.lines);
    }
    check('theme G on: the topic pet with a pet out, never without one; gamesroom on a members world', petWith >= 1 && petWithout === 0 && rooms >= 1, { petWith, petWithout, rooms });
    check("Castle Wars' thread lines all in the future tense (PC9)", cwLines.every(l => !CASTLE_WARS_OPEN.test(l)), cwLines.filter(l => CASTLE_WARS_OPEN.test(l)));
    // (the answers)
    let picks = 0;
    const pick = list => (picks++, list[0]);
    const ask = (msg, bot = others[0]) => T.periodAnswer(msg, bot, pick)?.id ?? null;
    check('answers: a kitten, the Games Room, Runelink, Gnomeball, Castle Wars', ask('where do you get a kitten') === 'period_kitten' && ask('where is the games room') === 'period_gamesroom' && ask('what is runelink') === 'period_runelink' && ask('where is gnomeball') === 'period_gnomeball' && ask('when is castle wars out') === 'period_cw', [ask('where do you get a kitten'), ask('where is the games room'), ask('what is runelink'), ask('where is gnomeball'), ask('when is castle wars out')]);
    check("answers: \"want to play runelink\" away from the Games Room: not now (the human's challenge is the way to play)", T.PERIOD_ANSWERS.playNo.includes(T.periodAnswer('want to play runelink', others[0], list => list[0])?.text ?? ''));
    P.setPeriodForTest({ on: false });
    picks = 0;
    check('answers: none, and no pick, while theme G is off', ask('where do you get a kitten') === null && picks === 0);
    P.setPeriodForTest(null);
    check('the doing phrases and the place name', lib.activityFor('GamesRoom', null) === 'Playing runelink' && lib.activityFor('Gnomeball', null) === 'Playing gnomeball' && lib.activityFor('Sightsee', null) === 'Sightseeing' && lib.activityFor('Lighthouse', null) === 'Sightseeing' && lib.placePhrase(2219, 4940) === 'in the Games Room');
    // ---- (bots ideas, round 3 tune) the period's idle talk in the chatter's due idle line's place (port/BotPeriodTalk
    // periodIdleLine): off, nothing and no dice; on, about PERIOD_IDLE_SHARE × (0.5 + curiosity) of the due lines, said
    // as kind 'idle' (in H7: the due line's place), spread over the kinds, each kind to whom it fits ----
    check("the period's idle talk hooked in the leaf (port/BotPeriodIndex: the chatter's due idle line)", P.periodTalk.idleLine === T.periodIdleLine);
    const talkers = [owner, ...others];
    const realRandom = Math.random;
    let draws = 0;
    P.setPeriodForTest({ on: false });
    Math.random = () => (draws++, realRandom());
    const offSaid = talkers.filter(b => T.periodIdleLine(b)).length;
    Math.random = realRandom;
    P.setPeriodForTest(null);
    check("idle talk: theme G off, nothing said and no dice", offSaid === 0 && draws === 0, { offSaid, draws });
    T.resetPeriodTalkStatsForTest();
    const talkFrom = said.length;
    const ROUNDS = 100;
    for (let i = 0; i < ROUNDS; i++) for (const b of talkers) T.periodIdleLine(b);
    // (the loop's counts: the chatter's own due lines reach the hook too in the ticks after)
    const st = { ...T.periodTalkStats, byKind: { ...T.periodTalkStats.byKind } };
    // (one line a tick shows: a bot's lines of this one tick come out over the next ones)
    run(60);
    const expected = talkers.reduce((a, b) => a + T.PERIOD_IDLE_SHARE * (0.5 + lib.personaOf(b.username, b.botPlanner ?? null).curiosity), 0) * ROUNDS;
    const talkIdle = said.slice(talkFrom).filter(l => l.kind === 'idle' && talkers.some(b => b.username === l.name));
    check(`idle talk: theme G on, about ${Math.round(expected)} of ${talkers.length * ROUNDS} due lines rolled in (PERIOD_IDLE_SHARE × (0.5 + curiosity)), said as 'idle'`, st.asked === talkers.length * ROUNDS && st.rolled >= expected * 0.6 && st.rolled <= expected * 1.4 && st.said >= 20 && talkIdle.length >= st.said, { asked: st.asked, rolled: st.rolled, said: st.said, idle: talkIdle.length });
    check('idle talk: spread over the kinds (4+ of them, none half of it)', Object.keys(st.byKind).length >= 4 && Object.values(st.byKind).every(n => n <= st.said / 2), st.byKind);
    const kindOf = k => T.PERIOD_IDLE_KINDS.find(x => x.kind === k);
    const low = { combatLevel: 20 };
    check("idle talk: Horror from the Deep for combat 30+, the crabs 15+; the bot's own kitten only with one out, wanting one only without", !kindOf('talk-hftd-done').fits(low) && !kindOf('talk-hftd-todo').fits(low) && kindOf('talk-crabs').fits(low) === true && kindOf('talk-pet').fits(owner) && !kindOf('talk-pet').fits(others[0]) && kindOf('talk-kitten').fits(others[0]) && !kindOf('talk-kitten').fits(owner));
    // ---- (the KQ fixes, T-3) the update's quests talked of as done or still to do as the bot's own answer to "did you do
    // X" says (port/BotAnswers stateAnswer): at each combat level one kind of each pair fits, the done one where the answer
    // is a yes, HFTD's to do from combat 30, no dice; the threads' update and fremmy answers the same, each side's ----
    {
        const [subject, asker] = [others[0], others[1]];
        const cb0 = [subject.combatLevel, asker.combatLevel];
        const answerOf = (p, quest) => lib.stateAnswer({ bot: p, persona: lib.personaOf(p.username, p.botPlanner ?? null), asker: null, raw: `did you do ${quest}`, msg: `did you do ${quest}`, pick: l => l[0] });
        const yes = a => a?.id === 'quest_done' && lib.ANSWER_LINES.questDone.includes(a.text);
        const rows = [];
        const badKinds = [];
        const badThreads = [];
        let answered = 0;
        let fitDraws = 0;
        const levels = [3, 20, 29, 30, 44, 45, 46, 80, 126];
        levels.forEach((cb, i) => {
            subject.combatLevel = cb;
            asker.combatLevel = levels[levels.length - 1 - i];
            const fr = yes(answerOf(subject, 'the fremennik trials'));
            const hf = yes(answerOf(subject, 'horror from the deep'));
            const r0 = Math.random;
            Math.random = () => (fitDraws++, r0());
            const fits = k => kindOf(k).fits(subject);
            const row = { cb, fr, hf, fd: fits('talk-fremmy-done'), ft: fits('talk-fremmy-todo'), hd: fits('talk-hftd-done'), ht: fits('talk-hftd-todo') };
            Math.random = r0;
            rows.push(row);
            if (row.fd !== fr || row.ft === fr || row.hd !== hf || row.ht !== (!hf && cb >= 30)) badKinds.push(row);
            // (the subject answers, the asker its own word: each from the pool its own answer to the human says)
            const askerDone = { update: yes(answerOf(asker, 'horror from the deep')), fremmy: yes(answerOf(asker, 'the fremennik trials')) };
            for (const [id, done] of [['update', hf], ['fremmy', fr]]) {
                const pools = lib.THREAD_LINES.topics[id];
                for (let n = 0; n < 15; n++) {
                    const turns = lib.drawTopicForTest(id, asker, subject, 6) ?? [];
                    const ans = turns[1];
                    if (ans?.by === 1) answered++;
                    if (ans && ans.by === 1 && !(done ? pools.yes : pools.no).includes(ans.plain ?? ans.text)) badThreads.push({ id, cb, answer: ans.text });
                    const own = turns[2];
                    // (update's: the asker's own answer only after a counter-question, "ya u?"; else an after word)
                    if (own && own.by === 0 && id === 'update' && ans?.plain !== undefined && !(askerDone.update ? pools.yes : pools.no).includes(own.text)) badThreads.push({ id, asker: asker.combatLevel, own: own.text });
                    if (own && own.by === 0 && id === 'fremmy' && !askerDone.fremmy && pools.ownYes.includes(own.text)) badThreads.push({ id, asker: asker.combatLevel, own: own.text });
                }
            }
        });
        subject.combatLevel = cb0[0];
        asker.combatLevel = cb0[1];
        check("idle talk (T-3): the Fremennik Trials' and HFTD's talk done or to do as the bot's answer to \"did you do X\" says (one kind of each pair, HFTD's to do from 30, no dice)", badKinds.length === 0 && fitDraws === 0 && rows.some(r => r.fr) && rows.some(r => !r.fr), { rows: rows.map(r => `${r.cb}:${+r.fr}${+r.fd}${+r.ft}/${+r.hf}${+r.hd}${+r.ht}`).join(' '), fitDraws });
        check('threads (T-3): the update and fremmy topics answered from yes or no by the same rule, each side its own', badThreads.length === 0 && answered >= 200, { answered, bad: badThreads.slice(0, 4) });
    }
    Pets.setCatPeopleForTest([]);
}

// ======== castle wars: talk only; no task's destination in its sealed lobby; its lines never say it is open ========
if (want('cw')) {
    scene(SEED, 'cw');
    const [x0, z0, x1, z1] = PeriodPlaces.CASTLE_WARS_LOBBY_BOX;
    const near = ([x, z]) => x >= x0 - 16 && x <= x1 + 16 && z >= z0 - 16 && z <= z1 + 16;
    const spots = [];
    for (const steps of Object.values(lib.SkillProgression)) for (const st of steps ?? []) spots.push(st.location);
    for (const st of Object.values(lib.OUTING_STEPS)) spots.push(st.location);
    for (const v of Object.values(lib.Locations)) if (Array.isArray(v) && typeof v[0] === 'number') spots.push(v);
    for (const [k, v] of Object.entries(lib.MembersPlaces)) if (Array.isArray(v) && typeof v[0] === 'number') spots.push(v);
    for (const [k, v] of Object.entries(PeriodPlaces)) if (!k.startsWith('CASTLE_WARS') && Array.isArray(v) && typeof v[0] === 'number' && v.length <= 3) spots.push(v);
    const inLobby = spots.filter(s => near(s));
    check(`no task's spot within 16 tiles of the sealed lobby (${spots.length} spots)`, inLobby.length === 0, inLobby.slice(0, 3));
    const T = lib.THREAD_LINES.topics;
    const cwPools = [...Object.values(T.cw ?? {}), ...Object.values(T.cwSoon ?? {})].flat().filter(x => typeof x === 'string');
    const periodLines = lib.NEW_LINES.filter(l => l.tag.event === 'period').map(l => l.text);
    const answers = Object.values(lib.PeriodTalk.PERIOD_ANSWERS).flat();
    const open = [...cwPools, ...periodLines, ...answers].filter(l => CASTLE_WARS_OPEN.test(l));
    check("Castle Wars' lines (the topic's pools, the period lines, the answers) all to come: none says it is open", open.length === 0 && cwPools.length >= 10, { open, pools: cwPools.length });
}

// ======== lines: every moment the code names has lines (data/lines2004-period.json), said as set pieces ========
if (want('lines')) {
    scene(SEED, 'lines');
    const kinds = ['pet-buy', 'pet-feed', 'pet-lost', 'pet-grow', 'games-go', 'games-there', 'games-call', 'games-gg', 'games-win', 'games-lose', 'games-rematch', 'gnomeball-go', 'gnomeball-score', 'gnomeball-tackled', 'gnomeball-win', 'gnomeball-leave'];
    const thin = kinds.filter(k => lib.pieceLines('period', k).length < 3);
    check(`every period moment has 3+ lines (${kinds.length} kinds)`, thin.length === 0, thin);
    // (round 3's tune: the period's idle talk, each kind 5+ lines, of its event)
    const talkThin = lib.PeriodTalk.PERIOD_IDLE_KINDS.filter(k => lib.pieceLines(k.event, k.kind).length < 5).map(k => k.kind);
    check(`the period's idle talk: every kind has 5+ lines (${lib.PeriodTalk.PERIOD_IDLE_KINDS.length} kinds)`, talkThin.length === 0, talkThin);
    const p = sim.bots().find(b => b.slot !== -1);
    hold(p);
    const from = said.length;
    const text = lib.PeriodPlan.sayPeriodLine(p, 'period', 'games-gg');
    run(40);
    const line = said.slice(from).find(s => s.name === p.username);
    check("a period line said as a set piece ('setpiece': out of H7, counted in X2)", text !== null && line?.kind === 'setpiece', { text, line });
    P.setPeriodForTest({ on: false });
    check('nothing said while theme G is off', lib.PeriodPlan.sayPeriodLine(p, 'period', 'games-gg') === null);
    P.setPeriodForTest(null);
}

check('no errors', errors.length === 0 && lib.botErrorCount() === 0, errors.slice(0, 3).join(' | '));
const failed = checks.filter(c => !c.ok);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : `: ${c.detail}`}`);
out(failed.length ? `period: ${failed.length} of ${checks.length} failed` : `period: all ${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
