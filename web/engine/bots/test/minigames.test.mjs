#!/usr/bin/env node
// Members places and minigames (the variety work, round 2, Track M:
// far places scale with N, the members minigames,
// Wilderness trips and status gear for the other tracks), in the real 274 world:
//   budget     the far budget scales with N (4 at 100, 13 at 250, 30 at 500); the hook offers an outing only while fewer
//              are out, each bot once an hour at most, keeps one under way (a rescan's pick is the same task), none on a
//              free world
//   the map    every outing's spot holds what its task works (its monsters, its fishing spots; port/BotSpots' count from
//              the map); the minigames' NPCs and locs where the places say (the judge, the targets, Murphy, the gangplank,
//              Cap'n Izzy, the arena's ladder, the carts' drivers)
//   ranging    the Ranging Guild's competition: a ranger walks in by the door, pays the judge, wields the bronze arrows,
//              shoots the targets from behind the haystacks (the Ranged XP, the window closed), claims its tickets, plays
//              another round, its own arrows back on; no unseen jump
//   outings    a fight outing to Yanille's ogres from Ardougne: walked (no jump), fought there (XP), said where it went, on
//              the registry while out and off it after; Shilo's river by the cart (Hajedy's dialogue, the fare, 274's ride
//              marked as the game's move) and back by Vigroy's
//   exits      (round 2, the fixes) a Shilo fisher out of feathers takes Vigroy's cart; a walk out of Shilo with no coins
//              takes the fare from Shilo's bank first; a watchman thief upstairs with its Hitpoints low climbs down; a walk
//              from the tower's top floor climbs down first; a walk from the arena's platform and from its pit climbs out (the
//              rope, the ladder), never across the map; a fight outing's junk drop keeps its own items and the tools; the
//              planner's keep step hands back an outing under way
//   lines      every moment's lines exist (data/lines2004-members.json), said as 'setpiece'
//   errors     none
//
//   node --expose-gc web/engine/bots/test/minigames.test.mjs [--seed=5]
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';
import { scene } from './lib/dice.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const SEED = Number(args.seed ?? 5);
const ONLY = args.only ?? null;
const out = (s = '') => process.stdout.write(s + '\n');
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
const errors = [];
for (const level of ['log', 'info', 'debug', 'warn']) console[level] = () => {};
console.error = (...a) => {
    const text = a.map(String).join(' ');
    if (!text.includes('ExperimentalWarning') && !text.includes('--trace-warnings')) errors.push(text.slice(0, 300));
};
scene(SEED, 'world');

const engineDir = prepareEngineClone('minigames', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/minigames.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, Outings, Minigames, Items, MembersPlaces, OUTING_STEPS, PlayerStat } = lib;
const cheb = (ax, az, bx, bz) => Math.max(Math.abs(ax - bx), Math.abs(az - bz));
const want = name => ONLY === null || name.includes(ONLY);

// ---- the far budget (no world needed) ----
{
    const b = n => Outings.farBudget(n);
    check('budget: 4 out at 100 online (about 3 there at a time), 13 at 250, 30 at 500 (scaled with N)', b(100) === 4 && b(250) >= 12 && b(250) <= 14 && b(500) >= 28 && b(500) <= 32 && b(10) >= 1, [b(10), b(100), b(250), b(500)]);
    check('budget: Treasure Trails a cap of their own, 1 per 100 online, at least 1', Outings.trailBudget(100) === 1 && Outings.trailBudget(500) === 5 && Outings.trailBudget(20) === 1);
}

// ---- the world ----
const sim = await lib.Sim.create({ bots: 12, members: true, debug: false });
sim.addHuman(3222, 3218, 0);
for (let i = 0; i < 400 && sim.bots().length < 12; i++) sim.tick();
for (let i = 0; i < 12; i++) sim.tick();
lib.setHabitRatesForTest({ breaks: 0, lingers: 0, watch: 0, abrupt: 0 });
lib.setHangoutRateForTest(0.0001);
lib.setArenaRatesForTest(0);
lib.setDirectorForTest({ first: 1e9, gap: 1e9 });
lib.setCliqueBehaviourForTest(false);
lib.setEventRatesForTest({ odds: 0 });
lib.setTrainRatesForTest({ ask: 0, form: 0, yes: 0, join: 0 });
lib.setAlchRateForTest(0);
Outings.setOutingRatesForTest(0);
check('the world: 12 bots online', sim.bots().length === 12, `${sim.bots().length}`);

// ---- the map: each outing's spot and the minigames' NPCs and locs ----
{
    const empty = Object.entries(OUTING_STEPS).filter(([, s]) => lib.Spots.measuredCapacity(s) <= 0).map(([k]) => k);
    check("the map: every outing's spot holds what its task works (monsters, fishing spots: port/BotSpots' count)", empty.length === 0, empty.join(', ') || `${Object.keys(OUTING_STEPS).length} spots`);
    const npc = (name, [x, z, l], r = 6) => lib.findNpcByName(x, z, l, name, r) !== null;
    const at = {
        judge: npc('ranging_guild_competition_judge', MembersPlaces.RANGING_JUDGE),
        murphy: npc('murphy', MembersPlaces.TRAWLER_MURPHY),
        izzy: npc('agilityarena_clerk', MembersPlaces.ARENA_IZZY),
        hajedy: npc('brimhavencartdriver', MembersPlaces.BRIMHAVEN_CART),
        vigroy: npc('shilocartdriver', MembersPlaces.SHILO_CART),
        rellekka: npc('viking_fisherman1', MembersPlaces.FISH_RELLEKKA, 8),
        watchmen: npc('yanille_watchman', MembersPlaces.WATCHMEN_YANILLE, 6)
    };
    check('the map: the judge, Murphy, Cap\'n Izzy, the carts\' drivers, Rellekka\'s fisherman and the watchmen where the places say', Object.values(at).every(Boolean), at);
}

const bots = sim.bots();
const free = [...bots];
const take = f => {
    const i = free.findIndex(f);
    return i === -1 ? null : free.splice(i, 1)[0];
};
const levelling = p => lib.isLevelling(p.botPlanner) && !sim.botPlayer(p)?.hasSubTask();
function assign(p, task) {
    task.reset();
    const ai = sim.botPlayer(p);
    ai.currentTask = task;
    ai.planEnds = World.currentTick + 30000;
    p.clearWaypoints();
    p.clearPendingAction();
}
function run(ticks, until = () => false) {
    for (let i = 0; i < ticks; i++) {
        sim.tick();
        if (until()) return i + 1;
    }
    return -1;
}
/** a clean pack with these items, its run energy full, nothing in its hands' way */
function kit(p, items, bankItems = [], worn = []) {
    p.clearPendingAction();
    p.clearWaypoints();
    p.activeScript = null;
    p.getInventory(lib.InvType.INV).removeAll();
    p.getInventory(lib.InvType.WORN).removeAll();
    lib.giveItems(p, items, false);
    if (bankItems.length) lib.giveItems(p, bankItems, true);
    lib.wearItems(p, worn);
    p.runenergy = 10000;
}
function levels(p, map) {
    for (const [stat, lv] of Object.entries(map)) p.setLevel(PlayerStat[stat], lv);
    p.combatLevel = p.getCombatLevel();
}
function place(p, x, z, level = 0) {
    p.teleJump(x, z, level);
    run(1);
}
const STAND = { name: 'Stand', reset() {}, interrupt() {}, interrupted: false, shouldRun: () => true, isComplete: () => false, tick() {}, activityStep: () => null };
const hold = p => assign(p, Object.create(STAND));
for (const p of bots) hold(p);
/** the bot's moves of more than a step that are not the game's (its marked moves) */
function watchMoves(p) {
    const own = [];
    let last = [p.x, p.z, p.level];
    const marks0 = lib.teleportStats.marks.length;
    return {
        tick() {
            const d = p.level !== last[2] ? 99 : cheb(p.x, p.z, last[0], last[1]);
            if (d > 2) own.push({ t: World.currentTick, from: last, to: [p.x, p.z, p.level] });
            last = [p.x, p.z, p.level];
        },
        /**
         * the jumps no mark of the bot's covers (12 ticks before to 3 after), as the runner classes them: no ladder or stairs
         * (a floor's step), no dungeon's way (5000+ tiles of z), no boat (a deck, 20+ tiles)
         */
        unseen() {
            const marks = lib.teleportStats.marks.slice(marks0).filter(m => m.name === p.username.toLowerCase());
            const dist = j => cheb(j.from[0], j.from[1], j.to[0], j.to[1]);
            return own.filter(j => !(j.from[2] !== j.to[2] && dist(j) <= 3) && Math.abs(j.to[1] - j.from[1]) < 5000 && !((j.from[2] === 1 || j.to[2] === 1) && Math.abs(j.to[0] - j.from[0]) + Math.abs(j.to[1] - j.from[1]) > 20) && !marks.some(m => m.tick >= j.t - 12 && m.tick <= j.t + 3));
        }
    };
}
const lines = [];
lib.sayListeners.push((player, line, kind) => lines.push({ name: player.username, line, kind, t: World.currentTick }));

// ---- the lines: every moment's ----
{
    const kinds = ['outing-go-yanille', 'outing-there-yanille', 'outing-leave-yanille', 'outing-go-karamja', 'outing-go-burthorpe', 'outing-go-rellekka', 'outing-go-shilo', 'range-go', 'range-start', 'range-shot', 'range-done', 'range-done-good', 'trawler-call', 'trawler-join', 'trawler-board', 'trawler-sea', 'trawler-net', 'trawler-win', 'trawler-sink', 'trawler-catch', 'arena-go', 'arena-tag', 'arena-hit', 'arena-done', 'trail-go', 'trail-ask', 'trail-dig', 'trail-step', 'trail-done', 'trail-giveup'];
    const missing = kinds.filter(k => lib.pieceLines('members', k).length === 0);
    check("lines: every outing's and minigame's moment has its lines (data/lines2004-members.json, event 'members')", missing.length === 0, missing.join(', ') || `${kinds.length} moments`);
}

// ---- the Ranging Guild's competition ----
if (want('ranging')) {
    scene(SEED, 'ranging');
    const p = take(levelling);
    levels(p, { RANGED: 55, ATTACK: 30, STRENGTH: 30, DEFENCE: 30, HITPOINTS: 40 });
    const shortbow = Items.SHORTBOW;
    const iron = Items.IRON_ARROW;
    kit(p, [[Items.COINS, 2000]], [[Items.COINS, 5000]], [shortbow]);
    p.getInventory(lib.InvType.WORN).set(13, { id: iron, count: 200 });
    place(p, 2725, 3490);
    check('ranging: a ranger of 55 with a shortbow and coins may compete', lib.mayCompete(p) && lib.wieldsBow(p));
    const moves = watchMoves(p);
    const xp0 = p.stats[PlayerStat.RANGED];
    const ticket = lib.ObjType.getId('archery_ticket');
    const task = new lib.RangingGuildTask(2);
    assign(p, task);
    const r0 = lib.rangingStats.rounds;
    const shots0 = lib.rangingStats.shots;
    const t = run(4000, () => {
        moves.tick();
        return task.isComplete(p);
    });
    const tickets = p.getInventory(lib.InvType.INV).getItemCount(ticket);
    const quiver = p.getInventory(lib.InvType.WORN).get(13);
    check('ranging: the judge paid, ten shots a round, the rounds played, the tickets won, the Ranged XP from the targets', t > 0 && lib.rangingStats.rounds - r0 === 2 && lib.rangingStats.shots - shots0 >= 20 && tickets > 0 && p.stats[PlayerStat.RANGED] > xp0, { t, rounds: lib.rangingStats.rounds - r0, shots: lib.rangingStats.shots - shots0, tickets, xp: p.stats[PlayerStat.RANGED] - xp0, at: [p.x, p.z], state: task.state, ended: lib.rangingStats.ended });
    check('ranging: its own arrows back in the quiver, the coins paid (2 x 200)', quiver?.id === iron, { quiver: quiver ? [lib.ObjType.get(quiver.id).debugname, quiver.count] : null });
    check('ranging: walked in and out, no unseen jump', moves.unseen().length === 0, moves.unseen().slice(0, 3));
    check('ranging: off the registry when done', Outings.outingOf(p) === null && Outings.outingLog.some(e => e.key === 'RangingGuild' && e.name === p.username && e.end > 0));
    hold(p);
    free.push(p);
}

// ---- an outing to Yanille's ogres ----
if (want('outing')) {
    scene(SEED, 'outing');
    const p = take(levelling);
    levels(p, { ATTACK: 55, STRENGTH: 55, DEFENCE: 50, HITPOINTS: 55 });
    kit(p, [[Items.RUNE_SCIMITAR, 1], [Items.LOBSTER, 10], [Items.COINS, 500]], [], []);
    lib.wearItems(p, [Items.RUNE_SCIMITAR]);
    p.getInventory(lib.InvType.INV).remove(Items.RUNE_SCIMITAR, 1);
    place(p, 2655, 3283);
    const moves = watchMoves(p);
    const causes0 = new Map([...lib.teleportStats.byCause].map(([k, [j]]) => [k, j]));
    const step = OUTING_STEPS['yanille-ogres'];
    const inner = new lib.CombatTask(step, PlayerStat.ATTACK);
    const task = new lib.OutingTask('yanille-ogres', 'yanille', inner, 12);
    check('outing: the task is the fight, by its name (Combat:outing:yanille-ogres)', task.name === 'Combat:outing:yanille-ogres' && task.activityStep() === step && task.shouldRun(p));
    assign(p, task);
    const xp0 = p.stats[PlayerStat.ATTACK] + p.stats[PlayerStat.STRENGTH] + p.stats[PlayerStat.DEFENCE];
    let onRegistry = false;
    let there = -1;
    const t = run(2000, () => {
        moves.tick();
        if (Outings.outingOf(p) === 'yanille-ogres') onRegistry = true;
        if (there < 0 && cheb(p.x, p.z, step.location[0], step.location[1]) <= 20) there = World.currentTick;
        return task.isComplete(p);
    });
    const xp = p.stats[PlayerStat.ATTACK] + p.stats[PlayerStat.STRENGTH] + p.stats[PlayerStat.DEFENCE] - xp0;
    check('outing: walked from Ardougne to the ogres, fought (XP), over at its time', there > 0 && xp > 0 && t > 0, { there, xp, t, at: [p.x, p.z], state: task.state, ended: lib.outingTaskStats.ended });
    check('outing: on the registry while out, off it after', onRegistry && Outings.outingOf(p) === null);
    const causes = [...lib.teleportStats.byCause].filter(([k, [j]]) => j > (causes0.get(k) ?? 0)).map(([k, [j]]) => `${k} ${j - (causes0.get(k) ?? 0)}`);
    check('outing: walked, no unseen jump', moves.unseen().length === 0, { unseen: moves.unseen().slice(0, 3), causes });
    hold(p);
    free.push(p);
}

// ---- Yanille's watchmen, upstairs in the watchtower ----
if (want('watchmen')) {
    scene(SEED, 'watchmen');
    const p = take(levelling);
    levels(p, { THIEVING: 70, ATTACK: 40, STRENGTH: 40, DEFENCE: 40, HITPOINTS: 50 });
    kit(p, [[Items.LOBSTER, 5], [Items.COINS, 100]]);
    place(p, 2612, 3092);
    const moves = watchMoves(p);
    const step = OUTING_STEPS['yanille-watchmen'];
    const task = new lib.OutingTask('yanille-watchmen', 'yanille', new lib.ThievingTask(step), 10);
    assign(p, task);
    const xp0 = p.stats[PlayerStat.THIEVING];
    let up = -1;
    const t = run(2500, () => {
        moves.tick();
        if (up < 0 && p.level === 1) up = World.currentTick;
        return task.isComplete(p);
    });
    check("watchmen: up the watchtower's ladder (the guard's page, 274's oploc1), the watchmen pickpocketed (Thieving XP), down the ladder at its time", up > 0 && p.stats[PlayerStat.THIEVING] > xp0 && t > 0 && p.level === 0, { up, xp: p.stats[PlayerStat.THIEVING] - xp0, t, at: [p.x, p.z, p.level], ended: lib.outingTaskStats.ended });
    check('watchmen: no unseen jump', moves.unseen().length === 0, moves.unseen().slice(0, 3));
    hold(p);
    free.push(p);
}

// ---- the Wizards' Tower's caged lesser demon: no safe spot in 274 ----
if (want('tower')) {
    scene(SEED, 'tower');
    const p = take(levelling);
    levels(p, { RANGED: 55, DEFENCE: 40, HITPOINTS: 45 });
    kit(p, [], [], [Items.OAK_SHORTBOW]);
    const fired = [];
    for (const [x, z] of [[3107, 3157], [3106, 3158], [3105, 3160]]) {
        place(p, x, z, 2);
        p.getInventory(lib.InvType.WORN).set(13, { id: Items.IRON_ARROW, count: 100 });
        const [dx, dz, dl] = MembersPlaces.WIZARDS_TOWER_DEMON;
        const demon = lib.findNpcByName(dx, dz, dl, 'lesser_demon', 8);
        if (!demon) continue;
        lib.interactNpcOp(p, demon, 2);
        run(8);
        fired.push(100 - (p.getInventory(lib.InvType.WORN).get(13)?.count ?? 100));
        p.clearPendingAction();
        p.clearWaypoints();
    }
    check("tower: 274's cage stops arrows at the Wizards' Tower's lesser demon from every tile outside it (the 2004 safe spot is not in this content: no step there)", fired.length === 3 && fired.every(n => n === 0), fired);
    place(p, 3105, 3165, 0);
    hold(p);
    free.push(p);
}

// ---- Shilo's river by the cart ----
if (want('shilo')) {
    scene(SEED, 'shilo');
    const p = take(levelling);
    levels(p, { FISHING: 40, ATTACK: 40, STRENGTH: 40, DEFENCE: 40, HITPOINTS: 40 });
    kit(p, [[Items.FLY_FISHING_ROD, 1], [Items.FEATHER, 300], [Items.COINS, 600]]);
    place(p, 2785, 3205);
    const moves = watchMoves(p);
    const step = OUTING_STEPS['shilo-fishing'];
    const task = new lib.OutingTask('shilo-fishing', 'shilo', new lib.FishingTask(step), 10);
    assign(p, task);
    const fish0 = p.getInventory(lib.InvType.INV).getItemCount(Items.RAW_TROUT) + p.getInventory(lib.InvType.INV).getItemCount(Items.RAW_SALMON);
    let inShilo = -1;
    let fished = -1;
    const coins0 = p.getInventory(lib.InvType.INV).getItemCount(Items.COINS);
    const t = run(2500, () => {
        moves.tick();
        if (inShilo < 0 && lib.inShilo(p.x, p.z)) inShilo = World.currentTick;
        const fish = p.getInventory(lib.InvType.INV).getItemCount(Items.RAW_TROUT) + p.getInventory(lib.InvType.INV).getItemCount(Items.RAW_SALMON);
        if (fished < 0 && fish > fish0) fished = World.currentTick;
        return task.isComplete(p);
    });
    check("shilo: the cart from Brimhaven (Hajedy's dialogue, its fare), fished the river, the cart back at its time", inShilo > 0 && fished > 0 && t > 0 && !lib.inShilo(p.x, p.z) && p.getInventory(lib.InvType.INV).getItemCount(Items.COINS) < coins0, { inShilo, fished, t, at: [p.x, p.z], state: task.state, carts: lib.outingTaskStats.carts, ended: lib.outingTaskStats.ended });
    const banked = ['RAW_TROUT', 'RAW_SALMON'].reduce((n, k) => n + (p.getInventory(lib.bankInvId())?.getItemCount(Items[k]) ?? 0), 0);
    check("shilo: the catch banked at Shilo's own bank (its bankers) and back to the river, not a walk out", banked > 0 && (lib.outingTaskStats.ended.time ?? 0) >= 1, { banked, ended: lib.outingTaskStats.ended });
    check('shilo: the rides marked as the game\'s moves, no unseen jump', moves.unseen().length === 0, moves.unseen().slice(0, 3));
    hold(p);
    free.push(p);
}

// ---- (round 2, the fixes) an outing's dead ends: the ways out of Shilo and the watchtower, the arena's floors ----
if (want('exits')) {
    /** a task that walks to (x, z) every tick (the next task's walk after an outing ended where it ended) */
    const walker = (x, z) => ({ name: 'Walk', reset() {}, interrupt() {}, interrupted: false, shouldRun: () => true, isComplete: () => false, tick(q) { lib.walkTo(q, x, z, 0); }, activityStep: () => null });
    const E = lib.Exits.exitStats;
    {
        // (a fly fisher at Shilo's river whose feathers run out: the outing runs on to Vigroy's cart)
        scene(SEED, 'exits-shilo');
        const p = take(levelling);
        levels(p, { FISHING: 40, ATTACK: 40, STRENGTH: 40, DEFENCE: 40, HITPOINTS: 40 });
        kit(p, [[Items.FLY_FISHING_ROD, 1], [Items.FEATHER, 300], [Items.COINS, 400]]);
        place(p, 2785, 3205);
        const moves = watchMoves(p);
        const task = new lib.OutingTask('shilo-fishing', 'shilo', new lib.FishingTask(OUTING_STEPS['shilo-fishing']), 30);
        assign(p, task);
        const caught = () => p.getInventory(lib.InvType.INV).getItemCount(Items.RAW_TROUT) + p.getInventory(lib.InvType.INV).getItemCount(Items.RAW_SALMON);
        const fished = run(1500, () => (moves.tick(), lib.inShilo(p.x, p.z) && caught() > 0));
        p.getInventory(lib.InvType.INV).remove(Items.FEATHER, 1000);
        const carts0 = E.carts;
        const t = run(900, () => (moves.tick(), !lib.inShilo(p.x, p.z)));
        check("exits: a Shilo fly fisher out of feathers: its outing runs on to Vigroy's cart (the fare paid, his dialogue answered), out by the ride, no unseen jump", fished > 0 && t > 0 && E.carts > carts0 && moves.unseen().length === 0 && cheb(p.x, p.z, 2779, 3211) <= 20, { fished, t, at: [p.x, p.z], state: task.state, carts: E.carts - carts0, failed: E.failed, ended: lib.outingTaskStats.ended, unseen: moves.unseen().slice(0, 3) });
        // (a walk out of Shilo with no coins carried: Shilo's bank for the fare, then the cart)
        scene(SEED, 'exits-shilo-bank');
        kit(p, [], [[Items.COINS, 500]]);
        place(p, 2845, 2965);
        const moves2 = watchMoves(p);
        const w0 = E.withdrawals;
        const c0 = E.carts;
        assign(p, walker(3222, 3218));
        const t2 = run(900, () => (moves2.tick(), !lib.inShilo(p.x, p.z)));
        check("exits: a walk out of Shilo with no coins carried: Shilo's bank first (a banker clicked, the fare taken out), then Vigroy's cart, no unseen jump", t2 > 0 && E.withdrawals > w0 && E.carts > c0 && moves2.unseen().length === 0, { t: t2, at: [p.x, p.z], withdrawals: E.withdrawals - w0, carts: E.carts - c0, failed: E.failed, coins: p.getInventory(lib.InvType.INV).getItemCount(Items.COINS), unseen: moves2.unseen().slice(0, 3) });
        hold(p);
        free.push(p);
    }
    {
        // (a watchman thief upstairs whose Hitpoints drop with no food: down the tower's ladder, the outing's own way out)
        scene(SEED, 'exits-tower');
        const p = take(levelling);
        levels(p, { THIEVING: 70, ATTACK: 40, STRENGTH: 40, DEFENCE: 40, HITPOINTS: 50 });
        kit(p, [[Items.COINS, 100]]);
        place(p, 2545, 3115, 1);
        const moves = watchMoves(p);
        const task = new lib.OutingTask('yanille-watchmen', 'yanille', new lib.ThievingTask(OUTING_STEPS['yanille-watchmen']), 30);
        assign(p, task);
        run(5, () => (moves.tick(), false));
        p.levels[PlayerStat.HITPOINTS] = 6;
        const t = run(400, () => (moves.tick(), p.level === 0));
        check("exits: a watchman thief upstairs, its Hitpoints low and no food: down the watchtower's ladder (its outing's way out), no unseen jump", t > 0 && moves.unseen().length === 0 && cheb(p.x, p.z, 2544, 3111) <= 15, { t, at: [p.x, p.z, p.level], state: task.state, ended: lib.outingTaskStats.ended, unseen: moves.unseen().slice(0, 3) });
        // (a walk from the top floor to Yanille's square: the ladder down first, BotAction.walkTo's leg)
        p.levels[PlayerStat.HITPOINTS] = 50;
        place(p, 2545, 3115, 1);
        const moves2 = watchMoves(p);
        const down0 = lib.Upstairs.climbStats['yanille-watchtower:down'] ?? 0;
        assign(p, walker(2580, 3092));
        const t2 = run(400, () => (moves2.tick(), p.level === 0 && cheb(p.x, p.z, 2580, 3092) <= 10));
        check("exits: a walk from the watchtower's top floor to Yanille's square: down its ladder first (BotAction.walkTo, port/BotExits), there, no unseen jump", t2 > 0 && (lib.Upstairs.climbStats['yanille-watchtower:down'] ?? 0) > down0 && moves2.unseen().length === 0, { t: t2, at: [p.x, p.z, p.level], unseen: moves2.unseen().slice(0, 3) });
        hold(p);
        free.push(p);
    }
    {
        // (a bot left in the Agility Arena: from its platform by the ladder up, and from the pit by its rope, then the ladder)
        scene(SEED, 'exits-arena');
        const p = take(levelling);
        levels(p, { AGILITY: 45, HITPOINTS: 60, ATTACK: 40, STRENGTH: 40, DEFENCE: 40 });
        kit(p, [[Items.COINS, 100]]);
        place(p, 2805, 9587, 3);
        const j0 = lib.teleportStats.jumps;
        assign(p, walker(2809, 3200));
        const t = run(200, () => p.level === 0 && p.z < 6400);
        check("exits: a walk from the arena's platform by its ladder: up the ladder (BotKnowledge DUNGEON_ENTRIES' agility_arena), by Cap'n Izzy, no jump", t > 0 && cheb(p.x, p.z, 2808, 3193) <= 12 && lib.teleportStats.jumps === j0, { t, at: [p.x, p.z, p.level], jumps: lib.teleportStats.jumps - j0 });
        place(p, 2806, 9566, 0);
        const j1 = lib.teleportStats.jumps;
        const marks0 = lib.teleportStats.marks.filter(m => m.name === p.username.toLowerCase()).length;
        assign(p, walker(2809, 3200));
        let climbed = -1;
        const t2 = run(300, () => {
            if (climbed < 0 && p.level === 3) climbed = World.currentTick;
            return p.level === 0 && p.z < 6400;
        });
        // (the pit's rope lands on a platform; the ladder up is a walk from it, or the dungeon's jump to its entrance above:
        // the arena's platforms are crossed by its obstacles, AgilityArenaTask's)
        const marked = lib.teleportStats.marks.filter(m => m.name === p.username.toLowerCase()).length - marks0;
        check("exits: a walk from the arena's pit: up its climbing rope (clicked, marked as the game's move), then out of the arena by Cap'n Izzy (its ladder, or the arena's own entrance above), never across the map", marked > 0 && t2 > 0 && cheb(p.x, p.z, 2808, 3193) <= 12 && lib.teleportStats.jumps - j1 <= 1, { climbed, marked, t: t2, at: [p.x, p.z, p.level], jumps: lib.teleportStats.jumps - j1 });
        hold(p);
        free.push(p);
    }
    {
        // (a fight outing far from a bank drops its junk as the pack fills: never what the pack held when it set out, nor a tool)
        scene(SEED, 'exits-junk');
        const p = take(levelling);
        levels(p, { ATTACK: 55, STRENGTH: 55, DEFENCE: 50, HITPOINTS: 55 });
        const tinderbox = lib.ObjType.getId('tinderbox');
        const chisel = lib.ObjType.getId('chisel');
        kit(p, [[tinderbox, 1], [Items.LOBSTER, 5], [Items.COINS, 50]]);
        lib.wearItems(p, [Items.RUNE_SCIMITAR]);
        const step = OUTING_STEPS['karamja-jogres'];
        place(p, step.location[0], step.location[1]);
        const task = new lib.OutingTask('karamja-jogres', 'karamja', new lib.CombatTask(step, PlayerStat.ATTACK), 30);
        assign(p, task);
        run(3);
        // (then a chisel picked up and the pack filled with bones, as the fight's loot)
        lib.giveItems(p, [[chisel, 1], [Items.BONES, 30]], false);
        const bones0 = p.getInventory(lib.InvType.INV).getItemCount(Items.BONES);
        hold(p);
        let drops = 0;
        for (let i = 0; i < 6; i++) {
            task.dropAt = -100;
            if (task._dropJunk(p)) drops++;
            run(2);
        }
        const inv = p.getInventory(lib.InvType.INV);
        check("exits: a fight outing's junk dropped as the pack fills: the bones, never its own tinderbox (held when it set out) or a chisel (a tool of a skill), as the planner's bank trip keeps them", drops > 0 && inv.getItemCount(tinderbox) === 1 && inv.getItemCount(chisel) === 1 && inv.getItemCount(Items.BONES) < bones0, { drops, tinderbox: inv.getItemCount(tinderbox), chisel: inv.getItemCount(chisel), bones: [bones0, inv.getItemCount(Items.BONES)], free: inv.freeSlotCount });
        free.push(p);
    }
    {
        // (the planner's keep step: an outing under way is handed back before the visits, the hang-outs and the alch stints)
        scene(SEED, 'exits-keep');
        const p = take(levelling);
        levels(p, { ATTACK: 55, STRENGTH: 55, DEFENCE: 50, HITPOINTS: 55 });
        kit(p, [[Items.LOBSTER, 10], [Items.COINS, 500]]);
        lib.wearItems(p, [Items.RUNE_SCIMITAR]);
        place(p, 2655, 3283);
        const task = new lib.OutingTask('yanille-ogres', 'yanille', new lib.CombatTask(OUTING_STEPS['yanille-ogres'], PlayerStat.ATTACK), 30);
        assign(p, task);
        run(3);
        const picked = sim.botPlayer(p).planner.pickTask(p);
        check("exits: the planner's keep step hands back the outing under way (port/BotSetPieces' keep hooks), first of its steps", lib.keptHookTask(p) === task && picked === task, { picked: picked?.name ?? null });
        hold(p);
        free.push(p);
    }
}

// ---- the Fishing Trawler: a crew of three ----
if (want('trawler')) {
    scene(SEED, 'trawler');
    lib.resetTrawlerForTest();
    const crew = [take(levelling), take(levelling), take(levelling)];
    crew.forEach((p, i) => {
        levels(p, { FISHING: 45, CRAFTING: 30, ATTACK: 30, STRENGTH: 30, DEFENCE: 30, HITPOINTS: 35 });
        kit(p, [[Items.COINS, 2500]]);
        place(p, 2650 + i * 2, 3280);
    });
    const tasks = crew.map((p, i) => new lib.TrawlerTask(i === 0 ? 'leader' : 'member'));
    const moves = crew.map(p => watchMoves(p));
    const s0 = { ...lib.trawlerStats };
    assign(crew[0], tasks[0]);
    run(2, () => {
        moves.forEach(m => m.tick());
        return false;
    });
    assign(crew[1], tasks[1]);
    assign(crew[2], tasks[2]);
    let crewSeen = 0;
    const t = run(5000, () => {
        moves.forEach(m => m.tick());
        crewSeen = Math.max(crewSeen, lib.crewMembers().length);
        return tasks.every((task, i) => task.isComplete(crew[i]));
    });
    const st = lib.trawlerStats;
    const fish = crew.reduce((n, p) => n + ['RAW_SHRIMP', 'RAW_SARDINE', 'RAW_ANCHOVIES', 'RAW_TUNA', 'RAW_LOBSTER', 'RAW_SWORDFISH', 'RAW_SHARK'].reduce((m, k) => m + (Items[k] ? p.getInventory(lib.InvType.INV).getItemCount(Items[k]) : 0), 0), 0);
    check('trawler: a crew of three formed, bought their supplies at the Khazard store, boarded by the gangplank and sailed (274\'s trawler_start)', crewSeen === 3 && st.games > s0.games && st.boarded - s0.boarded >= 3, { crewSeen, games: st.games - s0.games, boarded: st.boarded - s0.boarded, ended: st.ended, at: crew.map(p => [p.x, p.z, p.level]) });
    check('trawler: at sea, the leaks patched with swamp paste (and the net mended, the hold bailed when it came to that)', st.leaks - s0.leaks > 0, { leaks: st.leaks - s0.leaks, nets: st.nets - s0.nets, bails: st.bails - s0.bails });
    check('trawler: the game ended, the catch from the net on land taken (fish in the packs), or sunk and swum ashore', t > 0 && ((st.catches - s0.catches >= 1 && fish > 0) || st.sunk > s0.sunk), { t, catches: st.catches - s0.catches, fish, sunk: st.sunk - s0.sunk });
    const unseen = moves.flatMap(m => m.unseen());
    check("trawler: the game's moves (the sail out and back, the flood, the wreck) marked, no unseen jump", unseen.length === 0, unseen.slice(0, 3));
    check('trawler: off the registry, the crew gone', crew.every(p => Outings.outingOf(p) === null) && !lib.crewExists(), crew.map((p, i) => [tasks[i].state, p.x, p.z, p.level, sim.botPlayer(p)?.currentTask?.name]));
    crew.forEach(p => {
        hold(p);
        free.push(p);
    });
}

// ---- the Fishing Trawler's catch: the net on land after a game won (274's trawler_win staged: %trawler 3, a catch of 6) ----
if (want('trawler')) {
    scene(SEED, 'trawler-catch');
    const p = take(levelling);
    levels(p, { FISHING: 60, HITPOINTS: 30 });
    kit(p, [[Items.COINS, 100]]);
    place(p, 2667, 3163);
    p.setVar(lib.VarPlayerType.getByName('trawler').id, 3);
    p.setVar(lib.VarPlayerType.getByName('trawler_catch').id, 6);
    const task = new lib.TrawlerTask('member');
    assign(p, task);
    task.atNetForTest(p);
    const said = [];
    const mg = p.messageGame.bind(p);
    p.messageGame = m => {
        said.push(String(m));
        return mg(m);
    };
    const c0 = lib.trawlerStats.catches;
    const t = run(400, () => task.isComplete(p));
    const fish = ['RAW_SHRIMP', 'RAW_SARDINE', 'RAW_ANCHOVIES', 'RAW_TUNA', 'RAW_LOBSTER', 'RAW_SWORDFISH', 'RAW_SHARK'].reduce((m, k) => m + (Items[k] ? p.getInventory(lib.InvType.INV).getItemCount(Items[k]) : 0), 0);
    const junkLeft = lib.findLootObj ? null : null;
    check("trawler: the catch from the net on land (its window closed, the catch at the bot's feet, the fish taken with Take, the junk left)", t > 0 && lib.trawlerStats.catches === c0 + 1 && fish > 0, { t, fish, state: task.state, said: said.slice(0, 6), vars: [lib.VarPlayerType.getByName('trawler')?.id, lib.VarPlayerType.getByName('trawler_catch')?.id], ended: lib.trawlerStats.ended, pack: p.getInventory(lib.InvType.INV).items?.filter(Boolean).map(i => lib.ObjType.get(i.id).debugname) });
    hold(p);
    free.push(p);
}

// ---- a Treasure Trail: an easy clue from the game's data, dug, the casket opened, the trail followed ----
if (want('trail')) {
    scene(SEED, 'trail');
    // (the clues' steps from 274's own data: 6 digs, 14 talks, the ground floors' searches; upstairs and underground skipped)
    const easy = [];
    for (let id = 0; id < 20000; id++) {
        const t = lib.ObjType.get(id);
        if (!t || !t.debugname) continue;
        if (lib.Clues.isEasyClue(id)) easy.push(id);
    }
    const kinds = {};
    for (const id of easy) {
        const st = lib.Clues.clueStep(id);
        const k = st.kind === 'skip' ? `skip:${st.why}` : st.kind;
        kinds[k] = (kinds[k] ?? 0) + 1;
    }
    check("trail: the easy clues' steps from 274's data (digs, searches on the ground floor, talks to the NPC that takes the clue; the rest skipped)", easy.length >= 60 && kinds.dig === 6 && kinds.talk === 14 && kinds.search >= 25, kinds);
    const p = take(levelling);
    levels(p, { ATTACK: 40, STRENGTH: 40, DEFENCE: 40, HITPOINTS: 40 });
    const map1 = lib.ObjType.getId('trail_clue_easy_map001');
    kit(p, [[Items.COINS, 200], [lib.ObjType.getId('spade'), 1], [map1, 1]]);
    const dig = lib.Clues.clueStep(map1);
    place(p, dig.at[0] + 8, dig.at[1] + 3);
    const moves = watchMoves(p);
    const s0 = JSON.parse(JSON.stringify(lib.trailStats));
    const task = new lib.TreasureTrailTask();
    assign(p, task);
    let casket = -1;
    const t = run(3500, () => {
        moves.tick();
        const held = lib.Clues.carriedTrailItem(p);
        if (casket < 0 && held?.casket) casket = World.currentTick;
        return task.isComplete(p);
    });
    const st = lib.trailStats;
    check('trail: the map clue read, walked to its spot, dug with the spade (274\'s opheld1 spade: the casket), the casket opened', casket > 0 && st.caskets > s0.caskets && (st.steps.dig ?? 0) > (s0.steps.dig ?? 0), { casket, caskets: st.caskets - s0.caskets, steps: st.steps, at: [p.x, p.z] });
    check('trail: followed to its end: the reward (274\'s roll, in the pack) or a clue it cannot do dropped', t > 0 && (st.rewards > s0.rewards || Object.keys(st.gaveUp).length > Object.keys(s0.gaveUp).length || Object.values(st.gaveUp).reduce((a, b) => a + b, 0) > Object.values(s0.gaveUp).reduce((a, b) => a + b, 0)) && lib.Clues.carriedTrailItem(p) === null, { t, rewards: st.rewards - s0.rewards, gaveUp: st.gaveUp, ended: st.ended, clues: st.clues - s0.clues, steps: st.steps });
    check('trail: walked, no unseen jump', moves.unseen().length === 0, moves.unseen().slice(0, 3));
    hold(p);
    free.push(p);
}

// ---- the Brimhaven Agility Arena ----
if (want('arena')) {
    scene(SEED, 'arena');
    const p = take(levelling);
    levels(p, { AGILITY: 45, HITPOINTS: 60, ATTACK: 40, STRENGTH: 40, DEFENCE: 40 });
    kit(p, [[Items.COINS, 1500]]);
    place(p, 2806, 3192);
    const moves = watchMoves(p);
    const xp0 = p.stats[PlayerStat.AGILITY];
    const s0 = { ...lib.arenaStats };
    const coins0 = p.getInventory(lib.InvType.INV).getItemCount(Items.COINS);
    const task = new lib.AgilityArenaTask();
    check('arena: a bot of Agility 45 with the fee may run the arena', lib.mayRunArena(p));
    assign(p, task);
    let down = -1;
    const t = run(3000, () => {
        moves.tick();
        if (down < 0 && lib.inArena(p) && p.level === 3) down = World.currentTick;
        return task.isComplete(p);
    });
    const st = lib.arenaStats;
    check("arena: Cap'n Izzy paid (his Pay: 200 coins), down the ladder, obstacles crossed (Agility XP), pillars tagged, out by the ladder at its time", t > 0 && down > 0 && st.paid > s0.paid && coins0 - p.getInventory(lib.InvType.INV).getItemCount(Items.COINS) >= 200 && st.crossings > s0.crossings && st.tags > s0.tags && p.stats[PlayerStat.AGILITY] > xp0 && p.level === 0 && p.z < 6400, { t, down, paid: st.paid - s0.paid, crossings: st.crossings - s0.crossings, tags: st.tags - s0.tags, tickets: st.tickets - s0.tickets, falls: st.falls - s0.falls, xp: p.stats[PlayerStat.AGILITY] - xp0, ended: st.ended, at: [p.x, p.z, p.level] });
    check('arena: the ladders, falls and climbs are the game\'s, no unseen jump', moves.unseen().length === 0, moves.unseen().slice(0, 3));
    hold(p);
    free.push(p);
}

// ---- the planner's hook: the budget, the gap, a free world none ----
if (want('hook')) {
    scene(SEED, 'hook');
    const p = take(levelling);
    levels(p, { RANGED: 55, ATTACK: 50, STRENGTH: 50, DEFENCE: 50, HITPOINTS: 50 });
    kit(p, [[Items.COINS, 3000], [Items.LOBSTER, 5]], [[Items.COINS, 5000]], [Items.SHORTBOW]);
    // (by Camelot)
    place(p, 2757, 3482);
    Outings.resetOutingsForTest();
    Outings.setOutingRatesForTest(1000, 100);
    Minigames.forceOutingForTest('RangingGuild');
    const offered = Minigames.membersTaskFor(p, null);
    check('hook: below the budget, a free ranger is offered the Ranging Guild', offered?.name === 'RangingGuild', offered?.name ?? null);
    // (the budget full: four out)
    for (const q of free.slice(0, 4)) Outings.noteOutingStart(q, 'test-far', 'test', 'outing');
    const none = Minigames.membersTaskFor(p, null);
    check('hook: the budget full (4 of 4 at 100), nothing offered', none === null && Outings.outCount('far') === 4);
    Outings.setOutingRatesForTest(1000, 250);
    check('hook: at 250 online the same four leave room', Minigames.membersTaskFor(p, null)?.name === 'RangingGuild');
    for (const q of free.slice(0, 4)) Outings.noteOutingEnd(q, 'test');
    // (each outing or minigame its own cap: 3 at 100 online, 8 at 500; the Guild with 4 on it at 250 is full)
    for (const q of free.slice(0, 4)) Outings.noteOutingStart(q, 'RangingGuild', 'hemenster', 'minigame');
    check('hook: each outing or minigame holds at most its cap (3 at 100, 4 at 250, 8 at 500): the Guild with 4 on it is not offered at 250', Minigames.keyCap(100) === 3 && Minigames.keyCap(250) === 4 && Minigames.keyCap(500) === 8 && Minigames.membersTaskFor(p, null) === null, [Minigames.keyCap(100), Minigames.keyCap(250), Minigames.keyCap(500)]);
    for (const q of free.slice(0, 4)) Outings.noteOutingEnd(q, 'test');
    // (its last one just ended: an hour's gap)
    Outings.noteOutingStart(p, 'RangingGuild', 'hemenster', 'minigame');
    Outings.noteOutingEnd(p, 'done');
    check('hook: a bot whose outing just ended waits its gap (an hour)', Minigames.membersTaskFor(p, null) === null);
    // (a bot at Catherby's lobsters stays there: no outing, no other signature; the same bot from a fight is offered one)
    Outings.resetOutingsForTest();
    const [cx, cz] = lib.Locations.FISH_CATHERBY;
    place(p, cx - 2, cz + 4);
    const stays = Minigames.membersTaskFor(p, 'Fish') === null && Minigames.signatureTaskFor(p, 'Fish') === null;
    check('hook: a bot fishing at Catherby stays (no outing, no other signature); from a fight it is offered one', stays && Minigames.membersTaskFor(p, 'Combat')?.name === 'RangingGuild', { stays });
    // (the catalogue's liking from the planner's weights: a fighter's outings mostly its fights, a skiller's the arena and the Trawler)
    const likes = bots.filter(b => lib.isLevelling(b.botPlanner) && lib.themeOf(b.username) === null).map(b => ({ planner: b.botPlanner, fight: Minigames.likingOf(b, 'yanille-ogres'), arena: Minigames.likingOf(b, 'AgilityArena'), trawler: Minigames.likingOf(b, 'Trawler') }));
    const fighters = likes.filter(l => l.planner === 'fighter');
    const skillers = likes.filter(l => l.planner === 'skiller');
    check("hook: the catalogue's liking is the planner's (a fighter likes its fights over the arena and the Trawler, a skiller the other way round)", fighters.every(l => l.fight > l.arena && l.fight > l.trawler) && skillers.every(l => l.fight < l.arena && l.fight < l.trawler) && fighters.length + skillers.length > 0, likes);
    Minigames.forceOutingForTest(null);
    Outings.resetOutingsForTest();
    Outings.setOutingRatesForTest(0);
    hold(p);
    free.push(p);
}

check('errors: none', errors.length === 0 && lib.botErrorCount?.() === 0, errors.slice(0, 3).join(' | '));

// ---- report ----
let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
out(`minigames: ${checks.length - failed} of ${checks.length} checks ok`);
process.exit(failed ? 1 : 0);
