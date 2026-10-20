#!/usr/bin/env node
// What bots do and where (the variety work, round 1, Track D, research
// the research), in the real 274 world:
//   names      a name's theme (yew_cutter woodcutting at yews, cake_thief the baker's stall, coal_digger coal, ess_miner
//              essence; a food or a weapon is none), favourites (1-2) and home town, the same every time; about 1 in 5 a
//              power-dropper; each trait from a seed of its own
//   the map    every step's spot holds something its task works (port/BotSpots' count from the map: trees, rocks,
//              fishing spots, monsters, marks, stalls); the dungeons' ways in (BotKnowledge DUNGEON_ENTRIES): the locs
//              clicked by the entrance, the way up by the floor, every underground spot a walk from its floor; the new
//              steps on a free world where 274 has them free
//   picks      firemaking's lane near the bot (WHERE-1: none beyond FIRE_LANE_TILES from Varrock East; before, any of
//              the seven); a busy spot sends a bot to its neighbours (WHERE-2: Draynor's willows with 8 woodcutters on
//              them); thieves spread from Lumbridge's men (DO-9); the 2004 mix's factors (DO-5); a cook's range by its
//              bank loop, never Lumbridge castle's banked in Al Kharid (DO-16); a themed bot's theme first (its roll
//              before the logs claim; after a tool trip for it, the theme again), its spots weighed (DO-6); (the fixes)
//              the occupants counted once a tick, the picker's own spot less one, a switch moving its count; a stand-in
//              place without an action no spot
//   carrying   the first pick after a login (DO-7): the pack's willows give woodcutting, fletching or firemaking; the
//   on         login tile by the Barbarian Village coal gives mining
//   in the     an essence run (DO-4): Aubury's teleport, essence, the portal, the Varrock East bank, no unseen jump and the
//   world      moves marked; a power-dropper drops its willows one by one and chops on (a pack of leftovers banked), a
//              banker banks (DO-12); the log that fills a woodcutter's or a fletcher's pack, no "too full" message
//              (ISS-11); a miner down the Falador
//              stairs to the dwarven mine's iron, by the stairs (no jump); new aged bots' air talisman (Rune Mysteries)
//   errors     none
//
//   node --expose-gc web/engine/bots/test/activities.test.mjs [--seed=5]
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';

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

function mulberry(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
Math.random = mulberry(SEED);

const engineDir = prepareEngineClone('activities', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/activities.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, Spots, Favourites, PowerDrop, Items, Locations, SkillProgression } = lib;
const cheb = (ax, az, bx, bz) => Math.max(Math.abs(ax - bx), Math.abs(az - bz));
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : 0);

// ---- names: themes, favourites, homes, power-droppers (no world needed) ----
{
    const t = n => Favourites.themeOf(n);
    const yew = t('Yew Cutter');
    check("names: 'Yew Cutter' cuts yews (woodcutting, yew logs)", yew?.skills[0] === 'WOODCUTTING' && yew.gains?.includes(Items.YEW_LOGS), yew);
    check("names: 'Fish Fanatic' fishes, 'Lobster Lou' lobsters", t('Fish Fanatic')?.skills[0] === 'FISHING' && t('Lobster Lou')?.gains?.includes(Items.RAW_LOBSTER));
    check("names: 'Cake Thief' at the baker's stall, 'Coal Digger' mines coal, 'Ess Miner' runs essence", t('Cake Thief')?.target === 'bakers_stall_stealing' && t('Coal Digger')?.gains?.includes(Items.COAL) && t('Ess Miner')?.skills[0] === 'RUNECRAFT');
    check("names: 'Yew Longbow' fletches, 'Log Burner' makes fires, 'Gem Cutter 3' crafts (not trees)", t('Yew Longbow')?.skills[0] === 'FLETCHING' && t('Log Burner')?.skills[0] === 'FIREMAKING' && t('Gem Cutter 3')?.skills[0] === 'CRAFTING');
    check("names: a food, a toy or a weapon is no theme ('Fish N Chips', 'War Hammer 7', 'Shark Eater'), nor a plain name ('Kevin1991')", !t('Fish N Chips') && !t('War Hammer 7') && !t('Shark Eater') && !t('Kevin1991'));
    const names = lib.BOT_NAMES;
    const themed = names.slice(0, 2400).filter(n => t(n));
    check('names: about 200 of the first 2,400 names carry an activity (220 with the words; foods and weapons left out)', themed.length >= 170 && themed.length <= 230, `${themed.length}`);
    // (the 2,400 names for 750 and 1000 online came later, written in the same style: fewer of them have the words)
    const share = names.filter(n => t(n)).length / names.length;
    check(`names: 4-10 % of all ${names.length} names carry an activity`, share >= 0.04 && share <= 0.1, `${(100 * share).toFixed(1)} %`);
    const droppers = names.filter(n => Favourites.isDropper(n)).length;
    check('names: about 1 in 5 power-train (DROPPER_SHARE 0.2)', droppers / names.length >= 0.17 && droppers / names.length <= 0.23, `${droppers} of ${names.length}`);
    const w = lib.Personalities.SKILLER.weights;
    const same = names.slice(0, 300).every(n => JSON.stringify(Favourites.favouritesOf(n, w)) === JSON.stringify(Favourites.favouritesOf(n, w)) && Favourites.homeOf(n, true).key === Favourites.homeOf(n, true).key && Favourites.isDropper(n) === Favourites.isDropper(n));
    const sizes = names.slice(0, 300).map(n => Favourites.favouritesOf(n, w).length);
    check('names: favourites (1-2 skills) and home the same every time; a themed name its theme first', same && sizes.every(x => x >= 1 && x <= 2) && Favourites.favouritesOf('Yew Cutter', w)[0] === 'WOODCUTTING');
    const freeHomes = names.slice(0, 500).map(n => Favourites.HOMES.find(h => h.key === Favourites.homeOf(n, false).key));
    const homes = new Set(names.slice(0, 500).map(n => Favourites.homeOf(n, true).key));
    check('names: homes spread over the towns (10+), a free world\'s always a free town', homes.size >= 10 && freeHomes.every(h => !h.members), `${homes.size} towns`);
}

// ---- the world ----
const sim = await lib.Sim.create({ bots: 30, members: true, debug: false });
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
check('the world: 30 bots online', sim.bots().length === 30, `${sim.bots().length}`);

// ---- the map: every step's spot holds something, the dungeons' ways ----
{
    const COUNTED = new Set(['woodcut', 'mine', 'fish', 'combat', 'ranged', 'magic', 'thieve', 'thieve_stall']);
    const empty = [];
    let n = 0;
    for (const [skill, steps] of Object.entries(SkillProgression)) {
        for (const step of steps) {
            if (!COUNTED.has(step.action)) continue;
            n++;
            if (Spots.measuredCapacity(step) <= 0) empty.push(`${skill} ${step.action} ${step.location.join(',')} ${Spots.spotKey(step)}`);
        }
    }
    check("the map: every gathering, fighting and thieving step's spot holds something its task works (its capacity from the 274 map)", empty.length === 0, `${n} steps; empty: ${empty.slice(0, 6).join('; ')}`);
    const caps = name => {
        const s = Object.values(SkillProgression).flat().find(st => cheb(st.location[0], st.location[1], ...name.at) <= 0 && st.action === name.action && (name.gains === undefined || st.itemGained === name.gains));
        return s ? Spots.spotCapacity(s) : null;
    };
    const draynorWillows = caps({ at: [3086, 3234], action: 'woodcut', gains: Items.WILLOW_LOGS });
    const lumbyTrees = caps({ at: [3194, 3226], action: 'woodcut', gains: Items.LOGS });
    check("the map: capacities a player would share (Draynor's five willows: 10 cutters; Lumbridge's trees, more)", draynorWillows === 10 && lumbyTrees >= 5, { draynorWillows, lumbyTrees });

    const bad = [];
    for (const entry of lib.DUNGEON_ENTRIES) {
        const { entrance, floor, enter, exit } = entry.route;
        const enterOk = (enter ?? []).some(e => lib.locNear(entrance[0], entrance[1], 0, e.loc, 8));
        // (variety round 2, the fixes: on the floor's own level: the Agility Arena's is 3)
        const exitOk = !exit || lib.locNear(floor[0], floor[1], floor[2] ?? 0, exit.loc, 4);
        const walkable = sim.isWalkable(entrance[0], entrance[1], 0) && sim.isWalkable(floor[0], floor[1], floor[2] ?? 0);
        if (!enterOk || !exitOk || !walkable) bad.push(`${entry.name}: enter ${enterOk} exit ${exitOk} walkable ${walkable}`);
        // (and the route the box gives back is the entry's)
        const mid = [Math.floor((entry.box[0] + entry.box[2]) / 2), Math.floor((entry.box[1] + entry.box[3]) / 2)];
        if (lib.dungeonRoute(mid[0], mid[1]) !== entry.route) bad.push(`${entry.name}: dungeonRoute gives another route`);
    }
    check('the map: each dungeon way in (the sewers\' manhole, the Edgeville trapdoor, the volcano, the Falador stairs, the Ice Mountain trapdoor, the Mining Guild ladder): its locs by the entrance, its way up by the floor, both tiles walkable', bad.length === 0, bad.join('; ') || `${lib.DUNGEON_ENTRIES.length} entries`);

    const far = [];
    const under = Object.entries(SkillProgression).flatMap(([skill, steps]) => steps.filter(s => s.location[1] > 6400 && s.extra?.dungeon && lib.DUNGEON_ENTRIES.some(e => lib.dungeonRoute(s.location[0], s.location[1]) === e.route)).map(s => ({ skill, s })));
    const seen = new Set();
    for (const { skill, s } of under) {
        const key = s.location.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const [fx, fz] = lib.dungeonRoute(s.location[0], s.location[1]).floor;
        const steps = lib.walkSteps(0, fx, fz, s.location[0], s.location[1], 4);
        if (steps < 0) far.push(`${skill} ${key}`);
    }
    check('the map: every new underground spot is a walk from its dungeon\'s floor (doors opened as a walk opens them)', far.length === 0 && seen.size >= 8, far.join('; ') || `${seen.size} spots`);
}

// ---- picks ----
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
function kit(p, items, bankItems = []) {
    p.clearPendingAction();
    p.clearWaypoints();
    p.activeScript = null;
    p.getInventory(lib.InvType.INV).removeAll();
    lib.giveItems(p, items, false);
    if (bankItems.length) lib.giveItems(p, bankItems, true);
    p.runenergy = 10000;
}
/** the bot stands somewhere (a jump of the test's) */
function place(p, x, z, level = 0) {
    p.teleJump(x, z, level);
    run(1);
}
const STAND = { name: 'Stand', reset() {}, interrupt() {}, interrupted: false, shouldRun: () => true, isComplete: () => false, tick() {}, activityStep: () => null };
const hold = p => assign(p, Object.create(STAND));
const willow = (x, z) => SkillProgression.WOODCUTTING.find(s => s.itemGained === Items.WILLOW_LOGS && s.location[0] === x && s.location[1] === z);
const DRAYNOR_WILLOWS = willow(3086, 3234);

{
    // WHERE-1: from Varrock East's bank, a firemaker's lane within FIRE_LANE_TILES (before: any of the seven, Seers and Catherby 29 %)
    let farLanes = 0;
    let farBefore = 0;
    for (let i = 0; i < 1000; i++) {
        const s = lib.getProgressionStep('FIREMAKING', 30, undefined, [3253, 3420], { within: lib.FIRE_LANE_TILES });
        if (lib.stepDistance(s, 3253, 3420) > lib.FIRE_LANE_TILES) farLanes++;
        const b = lib.getProgressionStep('FIREMAKING', 30);
        if (lib.stepDistance(b, 3253, 3420) >= 300) farBefore++;
    }
    check(`picks: firemaking's lane from Varrock East within ${lib.FIRE_LANE_TILES} tiles (a lane near the bank its logs come from; drawn anywhere, ${pct(farBefore, 1000)} % were 300+ tiles off)`, farLanes === 0 && farBefore > 100, `${farLanes} of 1000 beyond`);

    // WHERE-2: 8 woodcutters on Draynor's willows: another bot by Draynor's bank picks a neighbour of the tier mostly
    // (Port Sarim's willows: Draynor's want combat 15, its dark wizards)
    const SARIM = willow(2990, 3183);
    const FROM = [2995, 3200];
    const before = { sarim: 0, n: 0 };
    for (let i = 0; i < 400; i++) {
        const s = lib.getProgressionStepWhere('WOODCUTTING', 35, () => true, FROM);
        before.n++;
        if (s === SARIM) before.sarim++;
    }
    const cutters = [];
    for (let i = 0; i < 8; i++) {
        const p = take(levelling);
        if (!p) break;
        kit(p, [[Items.BRONZE_AXE, 1]]);
        p.setLevel(lib.PlayerStat.WOODCUTTING, 35);
        place(p, 2986 + (i % 3), 3176 + Math.floor(i / 3));
        assign(p, new lib.WoodcuttingTask(SARIM));
        cutters.push(p);
    }
    run(1); // (the occupants are counted once a tick)
    const occ = Spots.spotOccupants(SARIM);
    let busy = 0;
    for (let i = 0; i < 400; i++) if (lib.getProgressionStepWhere('WOODCUTTING', 35, () => true, FROM) === SARIM) busy++;
    check(`picks: with ${occ} bots on Port Sarim's willows (capacity ${Spots.spotCapacity(SARIM)}, a pick's room for ${Spots.COMFORT}), a bot near them goes to another willow spot mostly (Rimmington's, Draynor's, Lumbridge's river)`, occ >= 6 && busy / 400 < 0.08 && before.sarim / before.n > 0.1, `Port Sarim's willows ${pct(busy, 400)} % of picks (empty: ${pct(before.sarim, before.n)} %)`);
    // (the fixes) counted once a tick with every bot: a picker's own spot less one, a switch later in the tick moves its
    // bot's count; a step-like place without an action (a test's stand-in task's) is no spot, and no crash (the suite's
    // "reading 'startsWith'" in a Fletching bot's pick: fixes.test.mjs's stand-ins)
    {
        lib.Spots.setPicker(cutters[0]);
        const own = Spots.spotOccupants(SARIM);
        lib.Spots.setPicker(null);
        Spots.noteTaskSwitch(cutters[1], { name: 'Idle' });
        const switched = Spots.spotOccupants(SARIM);
        const actionless = Object.values(SkillProgression).flat().filter(s => typeof s.action !== 'string').length;
        const standIn = { name: 'Mine', activityStep: () => ({ location: [3222, 3218, 0] }) };
        let keyOk = false;
        try {
            keyOk = typeof Spots.spotKey({ location: [3222, 3218, 0] }) === 'string';
        } catch {}
        check('occupancy: once a tick; the picker\'s own spot less one, a switch later in the tick moves its count; every step has an action, a stand-in place without one is no spot (no crash)', own === occ - 1 && switched === occ - 1 && actionless === 0 && Spots.stepOfTask(standIn) === null && keyOk, { occ, own, switched, actionless, keyOk });
        run(1);
    }
    for (const p of cutters) {
        hold(p);
        free.push(p);
    }

    // DO-9: a level-5 thief by Lumbridge: Lumbridge's men no longer its only spot (members: pickpocketing)
    const thief = take(levelling);
    place(thief, 3222, 3240);
    thief.setLevel(lib.PlayerStat.THIEVING, 5);
    const planner = sim.botPlayer(thief).planner;
    let lumby = 0;
    const where = {};
    for (let i = 0; i < 300; i++) {
        const s = planner._skillStep(thief, 'THIEVING', 5);
        const k = `${s?.extra?.npcName ?? s?.extra?.locName}@${s?.location.slice(0, 2).join(',')}`;
        where[k] = (where[k] ?? 0) + 1;
        if (s && s.location[0] === 3223 && s.location[1] === 3238) lumby++;
    }
    check("picks: a level-5 thief by Lumbridge picks Lumbridge's men under half the time (Varrock's men, Edgeville's, Al Kharid's, farmers, the tea stall; before: every time)", lumby / 300 < 0.5 && Object.keys(where).length >= 4, where);
    hold(thief);
    free.push(thief);

    // DO-5: the mix's factors (the planners' weights stay: new bots' ages split their XP by them)
    const skiller = lib.makeSkiller();
    // (a bot with no theme and neither skill a favourite: the factors alone)
    const p = take(b => levelling(b) && !Favourites.themeOf(b.username) && !Favourites.favouritesOf(b.username, lib.Personalities.SKILLER.weights).some(f => f === 'FLETCHING' || f === 'ATTACK'));
    const fletch = skiller._weightOf(p, 'FLETCHING', lib.Personalities.SKILLER.weights.FLETCHING);
    const att = skiller._weightOf(p, 'ATTACK', lib.Personalities.SKILLER.weights.ATTACK);
    const theme = Favourites.themeOf(p.username);
    const favs = Favourites.favouritesOf(p.username, lib.Personalities.SKILLER.weights);
    const plain = !theme && !favs.includes('FLETCHING') && !favs.includes('ATTACK');
    const mix = lib.MIX_2004.Skiller;
    check(`picks: a skiller's fletching weighs ${mix.FLETCHING} of its table's (17 to ${17 * mix.FLETCHING}), its attack ${mix.ATTACK} times (2 to ${2 * mix.ATTACK}); the table unchanged (new bots' ages split their XP by it)`, plain ? fletch === 17 * mix.FLETCHING && att === 2 * mix.ATTACK && lib.Personalities.SKILLER.weights.FLETCHING === 17 && mix.FLETCHING <= 0.5 && mix.ATTACK >= 2 : lib.Personalities.SKILLER.weights.FLETCHING === 17, { fletch, att, favs, theme: theme?.word ?? null });
    free.push(p);

    // DO-16: a cook by Lumbridge castle with shrimp banked: not Lumbridge castle's range (its bank is Al Kharid's, through the toll)
    const cook = take(levelling);
    kit(cook, [], [[Items.RAW_SHRIMP, 28]]);
    cook.setLevel(lib.PlayerStat.COOKING, 10);
    place(cook, 3215, 3225);
    const cp = sim.botPlayer(cook).planner;
    const ranges = {};
    for (let i = 0; i < 20; i++) {
        const t = cp._findCookingTask(cook);
        const s = t?.step;
        if (s) ranges[s.location.join(',')] = (ranges[s.location.join(',')] ?? 0) + 1;
    }
    const lumbyRange = Locations.LUMBRIDGE_RANGE.join(',');
    const chosen = Object.keys(ranges)[0]?.split(',').map(Number);
    const bank = chosen && lib.nearestBankTo(chosen[0], chosen[1]);
    check("picks: a cook by Lumbridge castle with shrimp banked cooks at a range whose bank is on its side of the toll gate (not Lumbridge castle's, banked in Al Kharid)", !ranges[lumbyRange] && chosen && lib.crossingFare(bank[0], bank[1], 0, chosen[0], chosen[1], 0) === 0, { ranges, bank });
    hold(cook);
    free.push(cook);
}

// ---- a themed bot (DO-6): its theme first, its spots weighed ----
{
    const yc = bots.find(p => p.username === 'yew_cutter');
    if (!yc) {
        check('themes: yew_cutter is online (the roster\'s first name)', false);
    } else {
        const planner = sim.botPlayer(yc).planner;
        const opts = planner._pickOpts(yc, 'WOODCUTTING');
        // (two steps alike for its home: Seers' yews and maples, far from every F2P home and Seers' both)
        const yewStep = SkillProgression.WOODCUTTING.find(s => s.itemGained === Items.YEW_LOGS && s.location[0] === Locations.YEWS_SEERS[0]);
        const mapleStep = SkillProgression.WOODCUTTING.find(s => s.itemGained === Items.MAPLE_LOGS && s.location[0] === Locations.MAPLES_SEERS[0]);
        const yews = opts.weigh(yewStep);
        const plainYews = opts.weigh(mapleStep);
        let first = 0;
        const order = [];
        for (let i = 0; i < 200; i++) {
            const c = planner._buildCandidates(yc);
            if (c[0] === 'WOODCUTTING') first++;
            if (i < 3) order.push(c.slice(0, 3).join('/'));
        }
        check(`themes: yew_cutter's picks weigh its theme's spots ${Favourites.PREFER_WEIGHT} times (Seers' yews against Seers' maples)`, yews === plainYews * Favourites.PREFER_WEIGHT, { yews, maples: plainYews });
        // (the shuffle alone: woodcutting's weight x4 among the skiller's 17 skills; the theme's roll, THEME_FIRST, puts it
        // first on top of that in the pick, below)
        check('themes: yew_cutter\'s shuffle puts woodcutting first about 1 time in 5 (THEME_WEIGHT; without it, about 1 in 16)', first / 200 > 0.13, `${pct(first, 200)} %: ${order.join(', ')}`);

        // the theme's roll comes before the claims: with 30 logs banked (the logs claim: firemaking or fletching) and an
        // axe, still woodcutting most picks; before, the claims came first (2 in 5 themed miners and woodcutters fletched)
        const make = { skiller: lib.makeSkiller, balanced: lib.makeBalanced, fighter: lib.makeFighter }[lib.plannerOf('yew_cutter')];
        hold(yc);
        place(yc, 3185, 3436);
        kit(yc, [[Items.BRONZE_AXE, 1], [Items.TINDERBOX, 1], [Items.KNIFE, 1]], [[Items.LOGS, 30]]);
        const picks = {};
        for (let i = 0; i < 200; i++) {
            const pl = make();
            pl.initialised = true;
            const t = pl.pickTask(yc);
            const k = t ? t.name.split(':')[0] : 'none';
            picks[k] = (picks[k] ?? 0) + 1;
        }
        const logsClaim = (picks.Firemaking ?? 0) + (picks.Fletching ?? 0);
        check('themes: yew_cutter with 30 logs banked still cuts most picks (its theme\'s roll before the logs claim), the claim a few', (picks.Woodcut ?? 0) / 200 >= 0.5 && logsClaim / 200 <= 0.3, picks);

        // a theme pick that came to a tool trip: the next pick takes the theme without a roll
        const bankInv = yc.getInventory(lib.bankInvId());
        bankInv?.removeAll();
        kit(yc, [[Items.COINS, 2000]]);
        // (and none in its hand: since the variety work's round 1, track W, a woodcutter wields its axe at the trees, port/
        // BotGear toolToWield, and an axe worn is an axe to the planner; yew_cutter chopped before this)
        yc.getInventory(lib.InvType.WORN)?.delete(3);
        const pl = make();
        pl.initialised = true;
        pl.themeAgain = true;
        const trip = pl.pickTask(yc);
        const tripKind = trip ? trip.name.split(':')[0] : 'none';
        const again = pl.themeAgain;
        kit(yc, [[Items.BRONZE_AXE, 1]]);
        let wc = 0;
        const next = {};
        for (let i = 0; i < 50; i++) {
            const p2 = make();
            p2.initialised = true;
            p2.themeAgain = true;
            const t2 = p2.pickTask(yc);
            const k2 = t2 ? t2.name.split(':')[0] : 'none';
            next[k2] = (next[k2] ?? 0) + 1;
            if (k2 === 'Woodcut') wc++;
        }
        check('themes: no axe: the theme\'s pick is a tool trip, and the next pick takes woodcutting again without a roll (every time)', (tripKind === 'ShopTrip' || tripKind === 'PickupSpawn') && again === true && wc === 50, { tripKind, again, next });
        hold(yc);
    }
}

// ---- carrying on after a login (DO-7) ----
{
    const p = take(levelling);
    const wcLevel = 35;
    p.setLevel(lib.PlayerStat.WOODCUTTING, wcLevel);
    p.setLevel(lib.PlayerStat.FLETCHING, 40);
    p.setLevel(lib.PlayerStat.FIREMAKING, 35);
    const kinds = {};
    for (let i = 0; i < 20; i++) {
        kit(p, [[Items.BRONZE_AXE, 1], [Items.KNIFE, 1], [Items.TINDERBOX, 1], [Items.WILLOW_LOGS, 20]]);
        // (by Port Sarim's willows: Draynor's want combat 15, its dark wizards)
        place(p, 2989, 3180);
        const planner = new lib.BotGoalPlanner(lib.Personalities.BALANCED);
        planner.skipInit();
        const t = planner._carryOn(p);
        const k = t ? t.name.split(':')[0] : 'none';
        kinds[k] = (kinds[k] ?? 0) + 1;
    }
    const logs = (kinds.Woodcut ?? 0) + (kinds.Fletching ?? 0) + (kinds.Firemaking ?? 0) + (kinds.Bank ?? 0);
    check('carrying on: a bot that logged out with willow logs in its pack goes on with them (woodcutting, fletching or firemaking; a bank trip for a full pack)', logs >= 16, kinds);

    // the login tile: by the Barbarian Village coal, Mining 35, an empty pack: mining
    const mine = {};
    for (let i = 0; i < 20; i++) {
        kit(p, [[Items.BRONZE_PICKAXE, 1]]);
        p.setLevel(lib.PlayerStat.MINING, 35);
        place(p, 3081, 3420);
        const planner = new lib.BotGoalPlanner(lib.Personalities.BALANCED);
        planner.skipInit();
        const t = planner._carryOn(p);
        const k = t ? t.name.split(':')[0] : 'none';
        mine[k] = (mine[k] ?? 0) + 1;
    }
    check('carrying on: a bot that logged in by the Barbarian Village mine (Mining 35) goes on mining', (mine.Mine ?? 0) >= 14, mine);
    hold(p);
    free.push(p);
}

// ---- an essence run (DO-4) ----
{
    const p = take(levelling);
    kit(p, [[Items.BRONZE_PICKAXE, 1]]);
    // (the bank's floor, the customers' side)
    place(p, 3253, 3420);
    const jumps0 = lib.teleportStats.jumps;
    const causes0 = new Map([...lib.teleportStats.byCause].map(([k, [j]]) => [k, j]));
    const marks0 = lib.teleportStats.marks.filter(m => m.name === p.username.toLowerCase() && m.cls === 'event').length;
    const task = new lib.EssenceTask();
    check('essence: a bot with a pickaxe may run essence (no talisman, no level)', task.shouldRun(p) && task.name === 'Essence' && task.activityStep() === lib.ESSENCE_STEP);
    assign(p, task);
    const bankId = lib.bankInvId();
    const banked0 = p.getInventory(bankId)?.getItemCount(Items.RUNE_ESSENCE) ?? 0;
    let inMine = -1;
    let mined = -1;
    const own = [];
    let last = [p.x, p.z, p.level];
    const t = run(2500, () => {
        // (its own moves of more than a step that are not the game's: Aubury's teleport and the portal, z 4700-4900 in or out)
        const mineMove = (last[1] > 4700 && last[1] < 4900) !== (p.z > 4700 && p.z < 4900);
        if (!mineMove && (p.level !== last[2] || cheb(p.x, p.z, last[0], last[1]) > 2)) own.push(`t${World.currentTick} ${last.join(',')} -> ${p.x},${p.z},${p.level} (${task.state})`);
        last = [p.x, p.z, p.level];
        if (inMine < 0 && p.z > 4700 && p.z < 4900) inMine = World.currentTick;
        if (mined < 0 && sim.botPlayer(p).currentTask === task && p.getInventory(lib.InvType.INV).getItemCount(Items.RUNE_ESSENCE) >= 10) mined = World.currentTick;
        return (p.getInventory(bankId)?.getItemCount(Items.RUNE_ESSENCE) ?? 0) > banked0;
    });
    const banked = (p.getInventory(bankId)?.getItemCount(Items.RUNE_ESSENCE) ?? 0) - banked0;
    const marks = lib.teleportStats.marks.filter(m => m.name === p.username.toLowerCase() && m.cls === 'event').length - marks0;
    check('essence: Aubury\'s teleport into the mine, essence mined, the portal back, the pack banked at Varrock East', inMine > 0 && mined > 0 && banked >= 20 && t > 0, { inMine, mined, banked, ticks: t, at: [p.x, p.z, p.level], state: task.state });
    const causes = [...lib.teleportStats.byCause].filter(([k, [j]]) => j > (causes0.get(k) ?? 0)).map(([k, [j]]) => `${k} ${j - (causes0.get(k) ?? 0)}`);
    check('essence: no unseen jump on the way, and the game\'s moves (Aubury, the portal) marked for the humanlike runner', own.length === 0 && marks >= 2, { own, causes, marks });
    hold(p);
    free.push(p);
}

// ---- power-dropping and the full pack (DO-12, ISS-11) ----
/** the game messages each bot got */
const messages = new Map();
{
    const proto = lib.Player.prototype;
    const mes = proto.messageGame;
    proto.messageGame = function (text) {
        if (this.is_bot) {
            const list = messages.get(this) ?? [];
            list.push({ t: World.currentTick, text: String(text) });
            messages.set(this, list);
        }
        return mes.call(this, text);
    };
}
{
    const dropper = take(p => levelling(p) && Favourites.isDropper(p.username));
    const banker = take(p => levelling(p) && !Favourites.isDropper(p.username));
    if (!dropper || !banker) {
        check('power-dropping: a dropper and a banker among the bots', false, { dropper: !!dropper, banker: !!banker });
    } else {
        for (const p of [dropper, banker]) {
            p.setLevel(lib.PlayerStat.WOODCUTTING, 40);
            kit(p, [[Items.BRONZE_AXE, 1]]);
        }
        // (Port Sarim's willows: no dark wizards, no combat level asked)
        const SARIM = willow(2990, 3183);
        place(dropper, 2989, 3180);
        place(banker, 2987, 3180);
        const dropperTask = new lib.WoodcuttingTask(SARIM);
        const bankerTask = new lib.WoodcuttingTask(SARIM);
        assign(dropper, dropperTask);
        assign(banker, bankerTask);
        // (chopping first; then the pack nearly full of willows, so the next log fills it)
        const chopping = run(400, () => dropperTask.state === 'interact' && bankerTask.state === 'interact');
        for (const p of [dropper, banker]) lib.giveItems(p, [[Items.WILLOW_LOGS, p.getInventory(lib.InvType.INV).freeSlotCount - 1]], false);
        const states = new Set();
        const drops0 = lib.PowerDrop.dropStats.items;
        let full = -1;
        let emptied = -1;
        let bankerFull = -1;
        let bankerBank = -1;
        run(900, () => {
            if (dropperTask.state) states.add(dropperTask.state);
            const n = dropper.getInventory(lib.InvType.INV).getItemCount(Items.WILLOW_LOGS);
            if (full < 0 && dropper.getInventory(lib.InvType.INV).freeSlotCount === 0) full = World.currentTick;
            if (full >= 0 && emptied < 0 && n === 0) emptied = World.currentTick;
            if (bankerFull < 0 && banker.getInventory(lib.InvType.INV).freeSlotCount === 0) bankerFull = World.currentTick;
            if (bankerFull >= 0 && bankerBank < 0 && bankerTask.state === 'bank_walk') bankerBank = World.currentTick;
            return emptied > 0 && bankerBank > 0;
        });
        const dropped = lib.PowerDrop.dropStats.items - drops0;
        // (27 drops at 1-2 ticks, a look of 3-7 now and then: 40-120 ticks; the bot's own pauses come between, a chat or a
        // trade's moment: 138 ticks once, seed 5)
        check('power-dropping: a dropper with a full pack of willows drops them one by one where it stands (27, at a person\'s pace) and chops on, no bank trip', chopping > 0 && full > 0 && emptied > full && emptied - full >= 27 && emptied - full <= 400 && dropped >= 27 && !states.has('bank_walk'), { chopping, full, emptied, dropped, states: [...states] });
        check('power-dropping: a banker (not a dropper) with a full pack walks to the bank at once', bankerFull > 0 && bankerBank >= bankerFull && bankerBank - bankerFull <= 2, { bankerFull, bankerBank });
        const tooFull = [dropper, banker].flatMap(p => (messages.get(p) ?? []).filter(m => m.text.includes('too full to hold any more logs')));
        check('the full pack: no "Your inventory is too full to hold any more logs" (the swing let go when the pack fills)', tooFull.length === 0, tooFull.slice(0, 3));
        // a dropper whose full pack is a previous task's leftovers (iron ore, 3 willows): to the bank, not a drop of nothing
        // (it went drop, chop, drop, and never to a bank)
        kit(dropper, [[Items.BRONZE_AXE, 1], [Items.WILLOW_LOGS, 3], [Items.IRON_ORE, 24]]);
        const junkTask = new lib.WoodcuttingTask(SARIM);
        assign(dropper, junkTask);
        const junkStates = new Set();
        run(30, () => {
            junkStates.add(junkTask.state);
            return junkTask.state === 'bank_walk';
        });
        check('power-dropping: a dropper with a full pack of leftovers (3 willows among iron ore) banks it, no drop', junkStates.has('bank_walk') && !junkStates.has('drop'), [...junkStates]);
        hold(dropper);
        hold(banker);
    }
}

// ---- the dwarven mine by the Falador stairs (D10, port/BotDungeons) ----
{
    const p = take(levelling);
    kit(p, [[Items.BRONZE_PICKAXE, 1]]);
    p.setLevel(lib.PlayerStat.MINING, 20);
    place(p, 3013, 3357);
    const step = SkillProgression.MINING.find(s => s.location[0] === Locations.MINE_DWARVEN_SOUTH[0] && s.location[1] === Locations.MINE_DWARVEN_SOUTH[1] && s.itemGained === Items.IRON_ORE);
    const dungeonJumps0 = [...lib.teleportStats.byCause].filter(([k]) => k.startsWith('Mine/')).reduce((a, [, [j]]) => a + j, 0);
    const xp0 = p.stats[lib.PlayerStat.MINING];
    assign(p, new lib.MiningTask(step));
    let below = -1;
    const t = run(900, () => {
        if (below < 0 && p.z > 6400) below = World.currentTick;
        return below > 0 && p.stats[lib.PlayerStat.MINING] > xp0;
    });
    const jumps = [...lib.teleportStats.byCause].filter(([k]) => k.startsWith('Mine/')).reduce((a, [, [j]]) => a + j, 0) - dungeonJumps0;
    check("the dwarven mine: a miner walks to the Falador stairs, climbs down (no jump) and mines the south end's iron", below > 0 && t > 0 && jumps === 0, { below, ticks: t, jumps, at: [p.x, p.z, p.level], xp: p.stats[lib.PlayerStat.MINING] - xp0 });
    hold(p);
    // (the fixes) from the east, outside the stairs house's door, within 6 tiles of the stairs: the door opened on the way,
    // then the stairs (it clicked them through the shut door: "I can't reach that!" 26-32 times in 2 hours at 10x)
    const q = take(levelling);
    kit(q, [[Items.BRONZE_PICKAXE, 1]]);
    q.setLevel(lib.PlayerStat.MINING, 20);
    const said = [];
    const messageGame = q.messageGame.bind(q);
    q.messageGame = (m, ...r) => {
        said.push(m);
        return messageGame(m, ...r);
    };
    place(q, 3066, 3380);
    assign(q, new lib.MiningTask(step));
    const down = run(200, () => q.z > 6400);
    check("the dwarven mine: a miner outside the stairs house's east door goes in by the door and down the stairs, no \"I can't reach that!\"", down > 0 && !said.some(m => /reach that/.test(m)), { down, at: [q.x, q.z], said: said.slice(0, 4) });
    q.messageGame = messageGame;
    hold(q);
}

// ---- new bots' air talisman (DO-4, new bots only, from a seed of its own) ----
{
    const names = lib.BOT_NAMES.slice(0, 1000);
    const kits = names.map(n => lib.talismanKit(n, 'novice'));
    const kept = kits.filter(k => k.some(([id]) => id === Items.AIR_TALISMAN)).length;
    check(`talismans: about ${lib.TALISMAN_KEPT * 100} % of new aged bots keep Rune Mysteries' air talisman, a newcomer none, the same every time`, Math.abs(kept / names.length - lib.TALISMAN_KEPT) < 0.05 && lib.talismanKit(names[0], 'newcomer').length === 0 && JSON.stringify(lib.talismanKit(names[3], 'veteran')) === JSON.stringify(lib.talismanKit(names[3], 'veteran')), `${kept} of ${names.length}`);
    const levels = new Array(21).fill(30);
    const name = names.find(n => lib.talismanKit(n, 'intermediate').length > 0);
    const k = lib.agedKit(name, 'intermediate', levels, true, 'balanced');
    check("talismans: an aged kit's bank holds it (after the runes, its own seed: the rest of the kit unchanged)", k.bank.some(([id]) => id === Items.AIR_TALISMAN) && JSON.stringify(k.bank.slice(-1)) === JSON.stringify([[Items.AIR_TALISMAN, 1]]));
}

// ---- the free world: the new steps where 274 has them free ----
// (BotWorldRules drops a members step on a free world: checked here by its place)
{
    const FREE = [Locations.SEWER_MOSS_GIANTS, Locations.SEWER_SKELETONS, Locations.EDGEVILLE_DUNGEON_SKELETONS, Locations.WHITE_KNIGHTS_FALADOR, Locations.DWARVES_ICE_MOUNTAIN, Locations.SCORPIONS_ALKHRAID, Locations.MINE_DWARVEN_SOUTH, Locations.MINE_DWARVEN_NORTH, Locations.MINE_LUMBRIDGE_SWAMP, Locations.WILLOWS_LUMBRIDGE, Locations.WILLOWS_DRAYNOR_WEST, Locations.WILLOWS_RIMMINGTON, Locations.FISH_LUMBRIDGE_RIVER];
    const members = FREE.filter(([x, z]) => !sim.isFreeToPlay(x, z));
    check("the free world: the F2P map's new spots are free in 274 (the sewers, the Edgeville dungeon, the White Knights, the dwarves, the scorpions, the dwarven and swamp mines, the new willows, the river's fly fishing)", members.length === 0, members.map(l => l.join(',')).join('; '));
}

check('errors: none', errors.length === 0 && lib.botErrorCount?.() === 0, errors.slice(0, 3).join(' | '));

// ---- report ----
let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
out(`activities: ${checks.length - failed} of ${checks.length} checks ok`);
process.exit(failed ? 1 : 0);
