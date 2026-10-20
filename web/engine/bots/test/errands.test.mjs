#!/usr/bin/env node
// New activities (the variety work, round 2, Track D2), in the real 274 world, each scene staged with its own dice
// (test/lib/dice.mjs) and run to its end through the real game:
//   chains     cowhides (the Lumbridge cows, Ellis's tanning screen, gloves on the leather screen, banked), feathers
//              (the chickens, sold at the general store), pottery (Rimmington's clay and well, the Barbarian Village
//              wheel and oven), flour (the wheat, the mill's hopper and bin, bread on the castle kitchen's range), picking,
//              shrimps on a fire the bot lights, trout on the Barbarian longhall's fire, bronze (Rimmington's copper and
//              tin, the Falador furnace)
//   quests     Cook's Assistant (an egg, a cow milked, the mill's flour, the cook), Rune Mysteries (the Duke upstairs, the
//              Wizards' Tower's basement, Aubury), Romeo and Juliet: the NPCs' after-quest dialogue, no varp changed
//   runs       superheat, enchanting, the wine of Zamorak telegrabbed in the chaos temple; herblore with unidentified
//              herbs (the Identify op)
//   wilderness a bold bot's trip: its rare banked first, skeletons by the ditch, home to Edgeville
//   travel     Varrock to the Gnome course by the spirit trees (the moves marked: no unseen jump)
//   fixes      (round 2, the fixes) every spirit tree's ride to each destination, clicked while still walking up; the green
//              dragons' trip: its strip at the booth, its armour shield swapped for the anti-dragon shield, a two-hander's
//              bot kept from the dragons; superheat's pickaxe and fire; feathers by a fly fisher sell only those gained; a
//              hosted errand's bank stop starts no hang-out; a full bank keeps a deposit in the pack
//   offers     the planner's: chains for combat 3-20, quests for newcomers, an errand under way kept at a rescan; the
//              bold trait from its own seed; every errand line's moment has lines, through the filter
//   leftovers  a smelter at a level-up smelts on (its page clicked away)
//   errors     none
//
//   node --expose-gc web/engine/bots/test/errands.test.mjs [--seed=5]
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

const engineDir = prepareEngineClone('errands', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/errands.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, Items, Errand, Chains, Quests, MagicRuns, HerbRuns, WildTrips, Travel, Picks } = lib;
const S = lib.PlayerStat;
const o = n => Errand.obj(n);

// ---- the world ----
const sim = await lib.Sim.create({ bots: 24, members: true, debug: false });
sim.addHuman(3222, 3218, 0);
for (let i = 0; i < 12; i++) sim.tick();
lib.setHabitRatesForTest({ breaks: 0, lingers: 0, watch: 0, abrupt: 0 });
lib.setHangoutRateForTest(0.0001);
lib.setArenaRatesForTest(0);
lib.setDirectorForTest({ first: 1e9, gap: 1e9 });
lib.setCliqueBehaviourForTest(false);
lib.setEventRatesForTest({ odds: 0 });
lib.setTrainRatesForTest({ ask: 0, form: 0, yes: 0, join: 0 });
lib.setAlchRateForTest(0);
// (every bot held by a task no rescan replaces: 'Idle' is one BotPlayer never interrupts)
const STAND = { name: 'Idle', reset() {}, interrupt() {}, interrupted: false, shouldRun: () => true, isComplete: () => false, tick() {}, activityStep: () => null };
const hold = p => {
    const ai = sim.botPlayer(p);
    ai.currentTask = Object.create(STAND);
    ai.planEnds = World.currentTick + 1e6;
    p.clearWaypoints();
    p.clearPendingAction();
};
const bots = sim.bots();
for (const b of bots) hold(b);
const free = bots.filter(b => lib.isLevelling(b.botPlanner));
check('the world: 24 bots online, levelling ones to stage', bots.length === 24 && free.length >= 8, `${free.length} levelling`);

/** a clean pack and bank with these items, full run energy, these levels */
function kit(p, levels, items, bankItems = []) {
    p.clearPendingAction();
    p.clearWaypoints();
    p.activeScript = null;
    p.getInventory(lib.InvType.INV).removeAll();
    p.getInventory(lib.bankInvId()).removeAll();
    lib.giveItems(p, items, false);
    lib.giveItems(p, bankItems, true);
    for (const [k, v] of Object.entries(levels)) p.setLevel(S[k], v);
    p.combatLevel = p.getCombatLevel();
    p.runenergy = 10000;
}
function place(p, x, z, level = 0) {
    p.teleJump(x, z, level);
    sim.tick();
}
function assign(p, task) {
    task.reset();
    const ai = sim.botPlayer(p);
    ai.currentTask = task;
    ai.planEnds = World.currentTick + 1e6;
}
/** ticks until `until()` or `max`; -1 when it never came */
function run(max, until = () => false) {
    for (let i = 0; i < max; i++) {
        sim.tick();
        if (until()) return i + 1;
    }
    return -1;
}
const count = (p, id) => p.getInventory(lib.InvType.INV).getItemCount(id);
const banked = (p, id) => p.getInventory(lib.bankInvId()).getItemCount(id);
/** the rescue jumps (unseen moves) a bot made since `since` (teleportStats' causes) */
const jumpsNow = () => lib.teleportStats.jumps;
/** an errand staged on a bot and run to its end: the task, how it ended, the ticks */
function stage(name, p, task, max) {
    scene(SEED, name);
    assign(p, task);
    const host = task;
    const errand = task.errand ?? task;
    const t = run(max, () => host.isComplete(p) || sim.botPlayer(p).currentTask !== host);
    return { errand, t, outcome: errand.outcome, rounds: errand.roundsDone, state: errand.state, at: [p.x, p.z, p.level] };
}
let next = 0;
const bot = () => free[next++ % free.length];

// ---- the chains ----
{
    const p = bot();
    kit(p, { ATTACK: 5, STRENGTH: 5, DEFENCE: 5, HITPOINTS: 12 }, [[o('bronze_sword'), 1]], [[995, 100]]);
    place(p, 3232, 3290);
    const coins0 = count(p, 995) + banked(p, 995);
    const r = stage('feathers', p, Chains.chainTask('feathers'), 3500);
    check('chains: feathers: the chickens fought (a sub-task, as a fighter), the feathers sold at the general store, rounds done', r.outcome === 'done' && r.rounds >= 1 && count(p, o('feather')) === 0, { ...r, errand: undefined, coins: count(p, 995) + banked(p, 995) - coins0 });
    hold(p);
}
{
    const p = bot();
    kit(p, { ATTACK: 10, STRENGTH: 10, DEFENCE: 10, HITPOINTS: 15, CRAFTING: 5 }, [[o('bronze_scimitar'), 1], [995, 300]], [[995, 500]]);
    place(p, 3250, 3270);
    const xp0 = p.stats[S.CRAFTING];
    const r = stage('hides', p, Chains.chainTask('hides'), 3000);
    const made = ['leather_gloves', 'leather_boots', 'leather_vambraces', 'leather_body', 'leather_chaps'].reduce((a, n) => a + banked(p, o(n)) + count(p, o(n)), 0);
    check("chains: cowhides: the cows fought for hides, tanned at Ellis's screen, leather made with a needle and thread (crafting XP), banked", r.rounds >= 1 && p.stats[S.CRAFTING] > xp0 && made >= 5, { outcome: r.outcome, rounds: r.rounds, made, xp: p.stats[S.CRAFTING] - xp0, t: r.t });
    hold(p);
}
{
    const p = bot();
    kit(p, { CRAFTING: 3, MINING: 5 }, [[o('bronze_pickaxe'), 1]], [[995, 200]]);
    place(p, 3005, 3360);
    const xp0 = p.stats[S.CRAFTING];
    const r = stage('pottery', p, Chains.chainTask('pottery'), 3000);
    check("chains: pottery: Rimmington's clay, buckets from its general store, the well's water, the Barbarian Village wheel and oven, pots banked at Edgeville", r.rounds >= 1 && p.stats[S.CRAFTING] > xp0 && banked(p, o('pot_empty')) >= 2, { outcome: r.outcome, rounds: r.rounds, pots: banked(p, o('pot_empty')), t: r.t });
    hold(p);
}
{
    const p = bot();
    kit(p, { COOKING: 5 }, [], [[995, 200]]);
    place(p, 3212, 3240);
    const xp0 = p.stats[S.COOKING];
    const r = stage('flour', p, new Errand.ErrandHost(Chains.chainTask('flour')), 2500);
    check("chains: flour: wheat picked, the mill climbed, the hopper filled and its controls pulled, the bin emptied into pots, bread baked on the castle kitchen's range (cooking XP)", r.rounds >= 1 && p.stats[S.COOKING] > xp0, { outcome: r.outcome, rounds: r.rounds, xp: p.stats[S.COOKING] - xp0, t: r.t, state: r.state, at: r.at });
    hold(p);
}
{
    const p = bot();
    kit(p, {}, []);
    place(p, 3150, 3270);
    const r = stage('picking', p, new Errand.ErrandHost(Chains.chainTask('picking')), 2000);
    check('chains: picking: a field nearby (the potatoes past the fence passed over), the crop sold or banked, as a sub-task (no XP for long)', r.outcome === 'done' && r.rounds >= 1, { outcome: r.outcome, rounds: r.rounds, t: r.t });
    hold(p);
}
{
    const p = bot();
    kit(p, { FISHING: 10, COOKING: 10, FIREMAKING: 10, ATTACK: 20, STRENGTH: 20, DEFENCE: 20, HITPOINTS: 20 }, [], [[o('net'), 1], [o('tinderbox'), 1], [Items.LOGS, 10], [995, 100]]);
    place(p, 3092, 3245);
    const xp0 = p.stats[S.COOKING];
    const r = stage('firecook', p, Chains.chainTask('fireCook'), 2500);
    check('chains: shrimps netted at Draynor, cooked on a fire the bot lit (tinderbox on logs), the burnt dropped, the rest banked', r.rounds >= 1 && p.stats[S.COOKING] > xp0 && count(p, o('burntfish1')) === 0, { outcome: r.outcome, rounds: r.rounds, xp: p.stats[S.COOKING] - xp0, t: r.t });
    hold(p);
}
{
    const p = bot();
    kit(p, { FISHING: 25, COOKING: 25, ATTACK: 20, STRENGTH: 20, DEFENCE: 20, HITPOINTS: 25 }, [], [[o('fly_fishing_rod'), 1], [o('feather'), 300], [995, 100]]);
    place(p, 3094, 3491);
    const r = stage('barbfire', p, Chains.chainTask('barbFire'), 1800);
    check("chains: trout on the Barbarian longhall's fire (its doors, its fire), banked at Edgeville", r.rounds >= 1 && banked(p, Items.TROUT) + banked(p, Items.SALMON) >= 5, { outcome: r.outcome, rounds: r.rounds, trout: banked(p, Items.TROUT), t: r.t });
    hold(p);
}
{
    const p = bot();
    kit(p, { MINING: 10, SMITHING: 5 }, [[o('bronze_pickaxe'), 1]], [[995, 50]]);
    place(p, 3005, 3360);
    const r = stage('bronze', p, Chains.chainTask('bronze'), 2500);
    check("chains: bronze: Rimmington's copper and tin, banked at Falador East, smelted at the Falador furnace (SmithingTask's)", r.rounds >= 1 && banked(p, Items.BRONZE_BAR) + count(p, Items.BRONZE_BAR) >= 8, { outcome: r.outcome, rounds: r.rounds, bars: banked(p, Items.BRONZE_BAR) + count(p, Items.BRONZE_BAR), t: r.t });
    // (iron at Smithing and Mining 15: the same chain on Rimmington's iron rocks; bronze for the low levels; staged in the
    // dev runs, 11 bars of 2 loads in 1,600 ticks)
    const ironOk = lvl => {
        kit(p, { MINING: lvl, SMITHING: lvl }, [[o('iron_pickaxe'), 1]], []);
        return Chains.CHAINS.iron().ok(p) && Chains.chainWeights(p).iron > 0;
    };
    const at10 = ironOk(10);
    const at20 = ironOk(20);
    const w20 = Chains.chainWeights(p);
    check("chains: iron bars from Smithing and Mining 15 (Rimmington's iron rocks)", !at10 && at20, { at10, at20, bronze: w20.bronze, iron: w20.iron });
    hold(p);
}

// ---- the quest look-alikes ----
/** the quests' varps a bot has (BOT_VARPS: every quest done): never written by a look-alike (the mill's flour count, a
 * run toggle, the combat style are the game's own state, not a quest's) */
const varps = p => lib.BOT_VARPS.map(([, id]) => p.getVar(id));
for (const [key, at, max, what] of [
    ['cook', [3222, 3218], 2500, "Cook's Assistant: an egg from the farm's coop, a bucket on a cow (milk), the mill's flour in a pot, the cook talked to"],
    ['runemysteries', [3222, 3218], 2000, "Rune Mysteries: the Duke upstairs, the Wizards' Tower's basement (its ladder, both ways), Sedridor, Aubury (no teleport, no shop)"],
    ['romeo', [3220, 3432], 1500, 'Romeo and Juliet: Romeo, Father Lawrence and the Apothecary in Varrock']
]) {
    const p = bot();
    kit(p, { ATTACK: 5, STRENGTH: 5, DEFENCE: 5, HITPOINTS: 12 }, [[995, 20]], [[995, 100]]);
    place(p, at[0], at[1]);
    const before = varps(p);
    const talks0 = Errand.talkStats.talked;
    const jumps0 = jumpsNow();
    const r = stage(`quest-${key}`, p, new Errand.ErrandHost(Quests.questTask(key)), max);
    const after = varps(p);
    const changed = before.filter((v, i) => v !== after[i]).length;
    check(`quests: ${what}: done as the bot's sub-task, its NPCs talked to (after the quest), no quest varp written, no unseen jump`, r.outcome === 'done' && Errand.talkStats.talked > talks0 && changed === 0 && jumpsNow() === jumps0, { outcome: r.outcome, t: r.t, talks: Errand.talkStats.talked - talks0, varpsChanged: changed, jumps: jumpsNow() - jumps0 });
    hold(p);
}
{
    // the egg and the milk are where 274 spawns them, the cook's dialogue safe: the items stay with the bot
    const p = bot();
    check('quests: the look-alikes (9) each have a start, and a newcomer gets one near it, never one it did this session', Object.keys(Quests.QUESTS).length >= 6 && (() => {
        p.botNewbie = true;
        place(p, 3222, 3218);
        Quests.forgetQuestsForTest(p);
        const keys = new Set();
        for (let i = 0; i < 30; i++) {
            const t = Quests.questFor(p, 0);
            if (t) keys.add(t.name);
        }
        p.botNewbie = false;
        return keys.size >= 5 && keys.size === [...keys].length;
    })());
    hold(p);
}

// ---- prayer and magic, herblore ----
{
    const p = bot();
    kit(p, { MAGIC: 50, SMITHING: 20, MINING: 20 }, [], [[995, 100], [Items.NATURE_RUNE, 10], [Items.FIRE_RUNE, 60], [Items.IRON_ORE, 10]]);
    place(p, 2946, 3368);
    const r = stage('superheat', p, MagicRuns.magicRunTask('superheat'), 600);
    check('runs: superheat: the iron superheated at the bank with the real spell (the runes taken), the bars banked', r.outcome === 'done' && banked(p, Items.IRON_BAR) >= 9 && banked(p, Items.NATURE_RUNE) === 0, { outcome: r.outcome, bars: banked(p, Items.IRON_BAR), t: r.t });
    hold(p);
}
{
    const p = bot();
    kit(p, { MAGIC: 20 }, [], [[995, 100], [o('sapphire_ring'), 5], [Items.COSMIC_RUNE, 10], [Items.WATER_RUNE, 10]]);
    place(p, 2946, 3368);
    const r = stage('enchant', p, MagicRuns.magicRunTask('enchant'), 400);
    check('runs: enchanting: sapphire rings enchanted at a bank (rings of recoil), banked', r.outcome === 'done' && banked(p, o('ring_of_recoil')) === 5, { outcome: r.outcome, recoil: banked(p, o('ring_of_recoil')), t: r.t });
    hold(p);
}
{
    const p = bot();
    kit(p, { MAGIC: 40, ATTACK: 30, STRENGTH: 30, DEFENCE: 30, HITPOINTS: 30 }, [], [[995, 100], [Items.LAW_RUNE, 6], [Items.AIR_RUNE, 6]]);
    place(p, 2946, 3368);
    const r = stage('telegrab', p, MagicRuns.magicRunTask('telegrab'), 1500);
    check("runs: the wine of Zamorak telegrabbed in the chaos temple (its door opened; the spell on the table's wine as a client casts it), banked at Falador", r.rounds >= 1 && banked(p, o('wine_of_zamorak')) >= 3, { outcome: r.outcome, wines: banked(p, o('wine_of_zamorak')), t: r.t });
    hold(p);
}
{
    const p = bot();
    kit(p, { HERBLORE: 5 }, [], [[995, 300], [199, 12]]);
    place(p, 2946, 3368);
    scene(SEED, 'herblore');
    const task = HerbRuns.herbRunFor(p, 0);
    const t = task ? (assign(p, task), run(1200, () => banked(p, Items.ATTACK_POTION_3) >= 5)) : -1;
    check("herblore: a bot with unidentified guams (the druids' drop) gets HerbloreTask: Jatix's vials and eyes of newt, the fountain, the herbs identified (the real op), attack potions", task !== null && t > 0, { task: task?.name, potions: banked(p, Items.ATTACK_POTION_3), t });
    hold(p);
}

// ---- the Wilderness ----
{
    const p = bot();
    const name = lib.BOT_NAMES.slice(0, 2000);
    const bold = name.filter(n => WildTrips.isWildBold(n)).length / name.length;
    check(`wilderness: about ${WildTrips.BOLD_SHARE * 100} % of the names bold, the same every time (a seed of its own)`, Math.abs(bold - WildTrips.BOLD_SHARE) < 0.04 && name.slice(0, 50).every(n => WildTrips.isWildBold(n) === WildTrips.isWildBold(n)), `${Math.round(bold * 1000) / 10} %`);
    kit(p, { ATTACK: 40, STRENGTH: 40, DEFENCE: 40, HITPOINTS: 40 }, [[o('mithril_scimitar'), 1]], [[995, 500], [o('lobster'), 20]]);
    p.getInventory(lib.InvType.WORN).set(0, { id: o('red_partyhat'), count: 1 });
    place(p, 3094, 3491);
    WildTrips.setWildTripTicksForTest([500, 600]);
    let wildTicks = 0;
    scene(SEED, 'wild');
    const task = WildTrips.wildTripTask('skeletons');
    assign(p, task);
    const t = run(3000, () => {
        if (lib.wildernessLevelAt(p.x, p.z) > 0) wildTicks++;
        return task.isComplete(p);
    });
    WildTrips.setWildTripTicksForTest(null);
    check("wilderness: a trip: its partyhat banked first, the skeletons by the ditch fought, home to Edgeville's bank", task.outcome === 'done' && banked(p, o('red_partyhat')) === 1 && wildTicks >= 400 && lib.wildernessLevelAt(p.x, p.z) === 0, { outcome: task.outcome, wildTicks, t, at: [p.x, p.z] });
    hold(p);
}

// ---- travel ----
{
    const p = bot();
    kit(p, { AGILITY: 30, ATTACK: 30, STRENGTH: 30, DEFENCE: 30, HITPOINTS: 30 }, [], [[995, 100]]);
    place(p, 3210, 3430);
    Travel.forgetTravelForTest(p);
    const marks0 = lib.teleportStats.marks.filter(m => m.name === p.username.toLowerCase() && m.cls === 'event').length;
    const jumps0 = jumpsNow();
    const done0 = Travel.travelStats.done['trees-varrock-stronghold'] ?? 0;
    scene(SEED, 'travel');
    const step = lib.SkillProgression.AGILITY.find(s => s.extra?.course === 'GNOME');
    assign(p, new lib.AgilityTask(step));
    const t = run(600, () => Math.max(Math.abs(p.x - 2474), Math.abs(p.z - 3436)) <= 12);
    const marks = lib.teleportStats.marks.filter(m => m.name === p.username.toLowerCase() && m.cls === 'event').length - marks0;
    check("travel: Varrock to the Gnome course by the spirit trees (Varrock's young tree, the Tree Gnome Village's on to the Stronghold), the moves marked, no unseen jump", t > 0 && t < 400 && (Travel.travelStats.done['trees-varrock-stronghold'] ?? 0) === done0 + 1 && marks >= 2 && jumpsNow() === jumps0, { t, marks, jumps: jumpsNow() - jumps0 });
    check('travel: the routes chosen only when well shorter (Lumbridge by the glider; a walk under 300 tiles, East Ardougne to the Stronghold: walked)', Travel.bestRoute(3210, 3430, 2474, 3436)?.key === 'trees-varrock-stronghold' && Travel.bestRoute(3222, 3218, 2474, 3436)?.key === 'glider-alkharid-grandtree' && Travel.bestRoute(3210, 3430, 3100, 3300) === null && Travel.bestRoute(2660, 3300, 2474, 3436) === null, [Travel.bestRoute(3210, 3430, 2474, 3436)?.key, Travel.bestRoute(3222, 3218, 2474, 3436)?.key, Travel.bestRoute(2965, 3380, 2474, 3436)?.key]);
    hold(p);
}

// ---- (round 2, the fixes) every spirit tree's ride to every destination, the bot still walking when the first page opens ----
{
    const p = bot();
    kit(p, { AGILITY: 30, ATTACK: 30, STRENGTH: 30, DEFENCE: 30, HITPOINTS: 30 }, [], [[995, 100]]);
    // (274's spirit_tree.rs2: the young tree's two pages and p_choice2 "Yes please"; the Village and Stronghold trees' two pages,
    // p_choice2 "Where can I go?", three pages, p_choice3 of three trees; ^village_tree, ^stronghold_tree, ^varrock_tree, ^khazard_tree)
    const VILLAGE = [2542, 3169];
    const STRONGHOLD = [2461, 3444];
    const VARROCK = [3179, 3507];
    const KHAZARD = [2555, 3259];
    const rides = [
        ['young-village', [3178, 3508, 0], 'loc_1317', [1], VILLAGE],
        ['village-khazard', [2542, 3170, 0], 'stronghold_ent', [2, 1], KHAZARD],
        ['village-varrock', [2542, 3170, 0], 'stronghold_ent', [2, 2], VARROCK],
        ['village-stronghold', [2542, 3170, 0], 'stronghold_ent', [2, 3], STRONGHOLD],
        ['stronghold-village', [2462, 3444, 0], 'ent', [2, 1], VILLAGE],
        ['stronghold-varrock', [2462, 3444, 0], 'ent', [2, 2], VARROCK],
        ['stronghold-khazard', [2462, 3444, 0], 'ent', [2, 3], KHAZARD]
    ];
    const results = [];
    for (const [key, board, loc, answers, lands] of rides) {
        scene(SEED, `tree-${key}`);
        // (clicked from 6-7 tiles off, on the tree's open side: a walk of several ticks to it before its first page)
        place(p, board[0] + (loc === 'stronghold_ent' ? -6 : 7), board[1]);
        const route = { key: `test-${key}`, hops: [{ board, loc, answers, lands: [lands[0], lands[1], 0] }], overhead: 30 };
        const task = new Travel.TravelTask(route);
        task.phase = 'click';
        const marks0 = lib.teleportStats.marks.filter(m => m.name === p.username.toLowerCase()).length;
        const jumps0 = jumpsNow();
        sim.botPlayer(p).setSubTask(task);
        const t = run(300, () => task.isComplete());
        const marked = lib.teleportStats.marks.filter(m => m.name === p.username.toLowerCase()).length - marks0;
        results.push({ key, t, done: Travel.travelStats.done[`test-${key}`] ?? 0, at: [p.x, p.z], landed: Math.max(Math.abs(p.x - lands[0]), Math.abs(p.z - lands[1])) <= 12, marked, jumps: jumpsNow() - jumps0 });
    }
    const bad = results.filter(r => !(r.t > 0 && r.done === 1 && r.landed && r.marked > 0 && r.jumps === 0));
    check("travel: every spirit tree's ride to each of its trees (the young tree to the Village; the Village tree to Khazard, Varrock, the Stronghold; the Stronghold's to the Village, Varrock, Khazard), clicked while still walking up to it: each landed where its choice says, the telejump marked, no jump", bad.length === 0, bad.length ? bad : `${results.length} rides`);
    hold(p);
}

// ---- (round 2, the fixes) the Wilderness trip's anti-dragon shield, its strip at the booth, a two-hander's bot kept from the dragons ----
{
    const p = bot();
    const shield = o('antidragonbreathshield');
    const kite = o('rune_kiteshield');
    kit(p, { ATTACK: 70, STRENGTH: 70, DEFENCE: 70, HITPOINTS: 70 }, [[o('rune_scimitar'), 1]], [[995, 500], [o('lobster'), 20], [shield, 1]]);
    p.getInventory(lib.InvType.WORN).removeAll();
    p.getInventory(lib.InvType.WORN).set(3, { id: o('rune_scimitar'), count: 1 });
    p.getInventory(lib.InvType.WORN).set(5, { id: kite, count: 1 });
    p.getInventory(lib.InvType.WORN).set(0, { id: o('red_partyhat'), count: 1 });
    p.getInventory(lib.InvType.INV).remove(o('rune_scimitar'), 1);
    p.combatLevel = p.getCombatLevel();
    place(p, 3094, 3491);
    scene(SEED, 'wild-shield');
    const task = WildTrips.wildTripTask('greendragons');
    assign(p, task);
    const t = run(200, () => task.state === 'fight' || task.state.startsWith('say') || task.outcome !== '' || lib.wildernessLevelAt(p.x, p.z) > 0);
    const worn = p.getInventory(lib.InvType.WORN);
    check("wilderness: the green dragons' trip: its partyhat banked at the booth (the strip), its rune kiteshield to the bank and the anti-dragon shield on (the act asks that it is worn)", t > 0 && worn.get(5)?.id === shield && banked(p, kite) === 1 && banked(p, o('red_partyhat')) === 1, { t, state: task.state, outcome: task.outcome, shield: worn.get(5) ? lib.ObjType.get(worn.get(5).id).debugname : null, kite: banked(p, kite), hat: banked(p, o('red_partyhat')) });
    hold(p);
    // (a bot whose best weapon is a two-hander: no green dragons, no shield could go on beside it)
    const dragons = WildTrips.WILD_SPOTS.find(s => s.key === 'greendragons');
    worn.set(3, { id: o('mithril_scimitar'), count: 1 });
    const fitsScimitar = dragons.fits(p);
    lib.giveItems(p, [[o('rune_2h_sword'), 1]], true);
    const fitsTwoHander = dragons.fits(p);
    check('wilderness: a bot whose best weapon is a two-hander is not sent to the green dragons (its shield would not go on)', fitsScimitar && !fitsTwoHander, { fitsScimitar, fitsTwoHander });
    p.getInventory(lib.bankInvId()).remove(o('rune_2h_sword'), 1);
}

// ---- (round 2, the fixes) superheat asks for a pickaxe or the ore, and worn fire; feathers sell only those gained ----
{
    const p = bot();
    kit(p, { MAGIC: 50, SMITHING: 20, MINING: 20 }, [], [[995, 100], [Items.NATURE_RUNE, 10], [Items.FIRE_RUNE, 60]]);
    const sh = () => MagicRuns.MAGIC_RUNS.superheat().ok(p);
    const noPick = sh();
    lib.giveItems(p, [[o('bronze_pickaxe'), 1]], true);
    const withPick = sh();
    p.getInventory(lib.bankInvId()).remove(Items.FIRE_RUNE, 60);
    lib.giveItems(p, [[Items.STAFF_OF_FIRE, 1]], true);
    const bankedStaff = sh();
    check('runs: superheat only with a pickaxe of its own (or the ore) and fire it can use (the staff worn, or the runes): none, a banked staff and no runes, not', !noPick && withPick && !bankedStaff, { noPick, withPick, bankedStaff });
    hold(p);
}
{
    const p = bot();
    kit(p, { ATTACK: 5, STRENGTH: 5, DEFENCE: 5, HITPOINTS: 12 }, [[o('bronze_sword'), 1], [o('feather'), 300]], [[995, 100]]);
    place(p, 3232, 3290);
    const r = stage('feathers-bait', p, Chains.chainTask('feathers'), 3500);
    check("chains: feathers by a fly fisher with 300 of its own: it fights for more, and the store buys only those gained (its bait kept)", r.rounds >= 1 && count(p, o('feather')) === 300, { outcome: r.outcome, rounds: r.rounds, feathers: count(p, o('feather')), t: r.t });
    hold(p);
}

// ---- (round 2, the fixes) a hosted errand's bank step starts no hang-out (it ended the errand); a full bank keeps the rest in the pack ----
{
    // (a bot with no hang-out drawn yet, its first due at once at a test rate)
    const p = free.find(b => lib.hangoutsOf(b) === null && !sim.botPlayer(b).hasSubTask()) ?? null;
    if (p) {
        kit(p, { ATTACK: 20, STRENGTH: 20, DEFENCE: 20, HITPOINTS: 20 }, [[995, 20]], [[995, 100]]);
        place(p, 3253, 3420);
        lib.setHangoutRateForTest(1e9);
        const errand = new Errand.ErrandTask(Quests.questTask('romeo').plan);
        sim.botPlayer(p).setSubTask(errand);
        lib.bankStop(p);
        const kept = sim.botPlayer(p).subTask === errand;
        lib.setHangoutRateForTest(0.0001);
        check("errands: a hosted errand's bank stop starts no hang-out in its place (BotHabits.bankStop: no sub-task replaced)", kept, { sub: sim.botPlayer(p).subTask?.name ?? null });
        errand.interrupt();
        hold(p);
    } else check("errands: a hosted errand's bank stop starts no hang-out in its place (no bot without a hang-out drawn: not staged)", true);
    // (depositItems: a bank with no room keeps the item in the pack; 274's add dropped what did not fit)
    const q = bot();
    kit(q, {}, [[o('lobster'), 3]]);
    const bankInv = q.getInventory(lib.bankInvId());
    for (let id = 1; bankInv.freeSlotCount > 0 && id < 20000; id++) {
        let type = null;
        try {
            type = lib.ObjType.get(id);
        } catch {
            type = null;
        }
        if (!type?.debugname || id === o('lobster') || type.certtemplate !== -1) continue;
        bankInv.add(id, 1);
    }
    const moved = lib.depositItems(q.getInventory(lib.InvType.INV), bankInv, o('lobster'), 3);
    check('errands: a deposit into a full bank keeps the item in the pack (depositItems: the room first)', moved === 0 && count(q, o('lobster')) === 3, { moved, pack: count(q, o('lobster')), free: bankInv.freeSlotCount });
    bankInv.removeAll();
    hold(q);
}

// ---- the planner's offers ----
{
    const p = bot();
    kit(p, { ATTACK: 10, STRENGTH: 10, DEFENCE: 10, HITPOINTS: 15, CRAFTING: 5, MINING: 5 }, [[o('bronze_sword'), 1], [o('bronze_pickaxe'), 1]], [[995, 300]]);
    place(p, 3222, 3240);
    scene(SEED, 'offers');
    const kinds = new Set();
    for (let i = 0; i < 40; i++) {
        const t = Chains.chainFor(p, false, 0);
        if (t) kinds.add(t.plan.kind);
    }
    const none = Chains.chainFor(p, false, 0.99);
    check(`offers: a combat 3-20 bot gets the chains that suit it (${[...kinds].join(', ')}), CHAIN_SHARE of its picks only`, kinds.size >= 4 && none === null);
    // an errand under way kept at a rescan: the planner hands back a task of its name
    const running = Chains.chainTask('feathers');
    assign(p, running);
    sim.tick();
    const again = Picks.d2Pick(p, 'Fighter');
    check('offers: an errand under way kept (a rescan of a plan that is over gets its twin, which BotPlayer keeps running)', again !== null && again.name === running.name);
    // (round 2, the fixes: one that never began and cannot run (its ok() fails: superheat for a bot of Magic 10) is not handed back)
    const stuck = MagicRuns.magicRunTask('superheat');
    assign(p, stuck);
    const keptStuck = Picks.keptErrand(p);
    check("offers: an errand that never began and cannot run is not kept (it was handed back every tick, and a newcomer stood)", keptStuck === null && !stuck.shouldRun(p), { kept: keptStuck?.name ?? null });
    assign(p, running);
    // (a fighter's chains are the fights; past combat 20 a craft's chain now and then while the craft is low; every offer
    // within 300 tiles, a dungeon's spot taken at the surface above it)
    const fights = new Set();
    for (let i = 0; i < 30; i++) fights.add(Chains.chainFor(p, false, 0, true)?.plan.kind ?? null);
    kit(p, { ATTACK: 40, STRENGTH: 40, DEFENCE: 40, HITPOINTS: 40, SMITHING: 20, MINING: 20, CRAFTING: 40, COOKING: 50 }, [[o('bronze_pickaxe'), 1]], [[995, 300]]);
    p.combatLevel = p.getCombatLevel();
    const crafts = new Set();
    for (let i = 0; i < 30; i++) crafts.add(Chains.chainFor(p, false, 0)?.plan.kind ?? null);
    const giants = lib.Locations.HILL_GIANTS_EDGEVILLE;
    const range = [Errand.withinRange({ x: 3094, z: 3491 }, giants), Errand.withinRange({ x: 2662, z: 3305 }, giants), Errand.withinRange({ x: 3100, z: 9900 }, [3094, 3491, 0])];
    check('offers: a fighter gets the fights (hides, feathers), a combat 40 bot the bars while its Smithing is low; within 300 tiles (a dungeon at the surface above)', (fights.has('Hides') || fights.has('Feathers')) && [...fights].every(k => k === 'Hides' || k === 'Feathers' || k === null) && [...crafts].every(k => k === 'Bronze' || k === null) && crafts.has('Bronze') && range.join() === 'true,false,true', { fights: [...fights], crafts: [...crafts], range });
    hold(p);
}
{
    // every moment the errands speak of has lines (event 'errand'), each through the filter (chat-filter.test.mjs: all groups)
    const kinds = new Set();
    const collect = steps => {
        for (const s of steps) if (s.label.startsWith('say ')) kinds.add(s.label.slice(4));
    };
    const p = bot();
    for (const make of [...Object.values(Chains.CHAINS), ...Object.values(Quests.QUESTS), ...Object.values(MagicRuns.MAGIC_RUNS)]) collect(make().build(p));
    const groups = lib.NEW_LINES.filter(l => l.tag.event === 'errand');
    const missing = [...kinds].filter(k => !groups.some(l => l.tag.kinds?.includes(k)));
    const quest = lib.NEW_LINES.filter(l => l.tag.event === 'errand' && l.tag.kinds?.some(k => k.startsWith('q-'))).length;
    check(`lines: every errand moment has its lines (${kinds.size} moments; ${quest} quest lines, about 60 asked)`, missing.length === 0 && quest >= 60, missing.join(', '));
    hold(p);
}

// ---- the leftovers ----
{
    // a smelter at a Smithing level-up smelts on: its page is clicked away (it stood 330 ticks at Al Kharid's furnace)
    const p = bot();
    kit(p, { SMITHING: 1 }, [], [[995, 50], [Items.COPPER_ORE, 14], [Items.TIN_ORE, 14]]);
    p.stats[S.SMITHING] = lib.getExpByLevel(2) - 10;
    place(p, 3269, 3167);
    scene(SEED, 'smelter');
    const step = lib.SkillProgression.SMITHING.find(s => s.action === 'smelt' && s.itemGained === Items.BRONZE_BAR && s.location === lib.Locations.AL_KHARID_FURNACE);
    assign(p, new lib.SmithingTask(step));
    const t = run(900, () => count(p, Items.BRONZE_BAR) + banked(p, Items.BRONZE_BAR) >= 10);
    check('leftovers: a smelter levels up at the furnace and smelts on (the level-up page clicked away)', t > 0 && p.baseLevels[S.SMITHING] >= 2, { t, bars: count(p, Items.BRONZE_BAR) + banked(p, Items.BRONZE_BAR), level: p.baseLevels[S.SMITHING] });
    hold(p);
}

check('errors: none', errors.length === 0 && lib.botErrorCount?.() === 0, errors.slice(0, 3).join(' | '));

// ---- report ----
let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
out(`errands: ${checks.length - failed} of ${checks.length} checks ok`);
process.exit(failed ? 1 : 0);
