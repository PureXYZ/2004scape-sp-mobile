/**
 * port (the variety work, round 2, Track D2: DO-8 and DO-11, the low-level economy chains; plan
 * the research)
 *
 * The 2004 newcomers' small trades, each an errand (tasks/ErrandTask) through the real game, skills and items earned:
 *   - cowhides: the Lumbridge cows fought for their hides, tanned at Ellis in Al Kharid (his tanning screen), leather
 *     gloves, boots and bodies with a needle and thread (CraftingTask's leather: the tanner, the bank, the leather screen);
 *   - feathers: the chickens fought, the feathers sold at the Lumbridge general store;
 *   - pottery: Rimmington's clay, the sink's water, the Barbarian Village wheel and oven, the pots banked at Edgeville;
 *   - flour: the wheat field north of Lumbridge, the mill's hopper and flour bin (a pot each), bread from the flour and
 *     the courtyard fountain's water on the castle kitchen's range, the bread sold;
 *   - picking: Draynor's cabbages and Lumbridge's potatoes, sold at the general store or banked (Fred's onion garden
 *     behind his house has its gate shut to every route);
 *   - shrimps and anchovies netted at Draynor or Al Kharid and cooked on a fire the bot lights there;
 *   - trout and salmon on the Barbarian Village longhall's fire.
 * Offered to low-level bots (combat 3-20) and skillers by persona and level (chainFor, the planner's hook block). The
 * report's AM11 and AM1b read their time (task kinds Hides, Feathers, Pottery, Flour, Picking, FireCook).
 */
import type Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import { Items, Locations, SkillProgression, type SkillStep } from '#/engine/bot/BotKnowledge.js';
import { getBaseLevel, countItem, hasLocAt } from '#/engine/bot/BotAction.js';
import { CombatTask, combatWeaponFor, fitToFight } from '#/engine/bot/tasks/CombatTask.js';
import { CraftingTask } from '#/engine/bot/tasks/CraftingTask.js';
import { SmithingTask } from '#/engine/bot/tasks/SmithingTask.js';
import { fireAllowedAt } from '#/engine/bot/tasks/FiremakingTask.js';
import { coinsOwned } from '#/engine/bot/BotNeeds.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import World from '#/engine/World.js';
import LocType from '#/cache/config/LocType.js';
import {
    ErrandTask,
    answerMake,
    soft,
    act,
    bank,
    clickLoc,
    climb,
    combine,
    dropAll,
    fight,
    freeSlots,
    gather,
    inner,
    lightFire,
    obj,
    owned,
    pause,
    say,
    shop,
    take,
    useOnLoc,
    walk,
    when,
    withinRange,
    type At,
    type ErrandPlan,
    type Step,
    type StepResult
} from '#/engine/bot/tasks/ErrandTask.js';

// ── places (274's map: the loc and NPC debugnames checked by test/content-names.test.mjs) ─────────────────────────────

export const CHAIN_PLACES = {
    cows: Locations.COWS_LUMBRIDGE as At,
    cowsInside: [3256, 3279, 0] as At,
    cowsNorth: Locations.COWS_LUMBRIDGE2 as At,
    chickens: Locations.CHICKENS_LUMBRIDGE as At,
    chickensFred: Locations.CHICKENS_LUMBRIDGE2 as At,
    chickensInside: [3233, 3297, 0] as At,
    general: [3211, 3246, 0] as At,
    dommik: [3321, 3193, 0] as At,
    rimmingtonClay: [2985, 3238, 0] as At,
    rimmingtonWell: [2957, 3214, 0] as At,
    potteryWheel: [3086, 3409, 0] as At,
    potteryOven: [3085, 3407, 0] as At,
    wheat: [3220, 3344, 0] as At,
    millLadder: [3164, 3307, 0] as At,
    millLadder1: [3164, 3307, 1] as At,
    millLadder2: [3164, 3307, 2] as At,
    hopper: [3166, 3306, 2] as At,
    flourBin: [3166, 3306, 0] as At,
    courtyardFountain: [3221, 3224, 0] as At,
    kitchenRange: [3211, 3215, 0] as At,
    cabbages: [3055, 3291, 0] as At,
    potatoes: [3151, 3278, 0] as At,
    potatoesEast: [3249, 3307, 0] as At,
    draynorFish: Locations.FISH_DRAYNOR as At,
    alkharidFish: Locations.FISH_ALKHARID as At,
    barbFish: Locations.FISH_BARBARIAN as At,
    longhallFire: [3078, 3443, 0] as At,
    rimmingtonCopper: [2978, 3245, 0] as At,
    rimmingtonTin: [2985, 3237, 0] as At,
    rimmingtonIron: [2970, 3239, 0] as At,
    faladorEastBank: Locations.FALADOR_EAST_BANK as At
} as const;

/** 274's general stores (each sells pots, jugs, buckets and tinderboxes, two or three of each, and buys anything) */
export const GENERAL_STORES: readonly (readonly [string, At])[] = [
    ['generalshopkeeper1', [3211, 3246, 0]], // Lumbridge
    ['generalshopkeeper2', [3217, 3413, 0]], // Varrock
    ['generalshopkeeper3', [3315, 3182, 0]], // Al Kharid
    ['generalshopkeeper4', [2957, 3388, 0]], // Falador
    ['generalshopkeeper5', [3080, 3509, 0]], // Edgeville
    ['generalshopkeeper6', [2948, 3214, 0]] // Rimmington
];
/** the general store nearest (x, z): [its keeper, where] */
export function nearestGeneral(x: number, z: number): readonly [string, At] {
    let best = GENERAL_STORES[0];
    let bestD = Infinity;
    for (const g of GENERAL_STORES) {
        const d = Math.max(Math.abs(g[1][0] - x), Math.abs(g[1][1] - z));
        if (d < bestD) {
            bestD = d;
            best = g;
        }
    }
    return best;
}
/** a general store's shop step, the store nearest (x, z) */
function general(x: number, z: number, opts: Parameters<typeof shop>[2]): Step {
    const [npc, at] = nearestGeneral(x, z);
    return shop(npc, at, opts);
}

const I = {
    hide: () => obj('cow_hide'),
    needle: () => obj('needle'),
    thread: () => obj('thread'),
    feather: () => obj('feather'),
    rawChicken: () => obj('raw_chicken'),
    clay: () => obj('clay'),
    softClay: () => obj('softclay'),
    unfiredPot: () => obj('pot_unfired'),
    pot: () => obj('pot_empty'),
    bucket: () => obj('bucket_empty'),
    bucketWater: () => obj('bucket_water'),
    jug: () => obj('jug_empty'),
    jugWater: () => obj('jug_water'),
    grain: () => obj('grain'),
    flour: () => obj('pot_flour'),
    dough: () => obj('bread_dough'),
    bread: () => obj('bread'),
    burntBread: () => obj('burnt_bread'),
    tinderbox: () => obj('tinderbox'),
    net: () => obj('net'),
    flyRod: () => obj('fly_fishing_rod')
};
const BURNT_FISH = ['burntfish1', 'burntfish2', 'burntfish3', 'burntfish4', 'burntfish5'];
const PICKAXES = ['bronze_pickaxe', 'iron_pickaxe', 'steel_pickaxe', 'mithril_pickaxe', 'adamant_pickaxe', 'rune_pickaxe'];
const AXES = ['bronze_axe', 'iron_axe', 'steel_axe', 'black_axe', 'mithril_axe', 'adamant_axe', 'rune_axe'];
const LOGS = () => [Items.LOGS, Items.OAK_LOGS, Items.WILLOW_LOGS];

const level = (p: Player, stat: PlayerStat): number => getBaseLevel(p, stat);
/** a loc of this debugname within `r` of the bot (its own fire) */
function locNearBot(p: Player, name: string, r: number): boolean {
    const id = LocType.getId(name);
    for (let zx = (p.x - r) & ~7; zx <= p.x + r; zx += 8) {
        for (let zz = (p.z - r) & ~7; zz <= p.z + r; zz += 8) {
            const zone = World.gameMap.getZone(zx, zz, p.level);
            if (!zone) continue;
            for (const loc of zone.getAllLocsSafe()) if (loc.type === id && Math.max(Math.abs(loc.x - p.x), Math.abs(loc.z - p.z)) <= r) return true;
        }
    }
    return false;
}
const carried = (p: Player, id: number): number => countItem(p, id);
/** the first of these carried or banked, or -1 */
function ownedOf(p: Player, names: readonly string[]): number {
    for (const n of [...names].reverse()) {
        const id = obj(n);
        if (id >= 0 && owned(p, id) > 0) return id;
    }
    return -1;
}

/** a step of SkillProgression at `at` (the cows', the chickens') */
function stepAt(skill: string, at: At): SkillStep | null {
    return SkillProgression[skill]?.find(s => s.location[0] === at[0] && s.location[1] === at[1] && s.action === 'combat') ?? null;
}

/** a load's size for this round: a person's (a number of its own, by the bot's dice) */
function load(min: number, max: number): number {
    return min + Math.floor(Math.random() * (max - min + 1));
}

/** the chain's line now and then ('chain-hides-go' ...: lines2004-activities.json, event 'errand') */
const line = (kind: string, chance = 0.35): Step => say(`chain-${kind}`, chance);

// ── the chains ───────────────────────────────────────────────────────────────────────────────────────────────────

/** players at level 0 within 12 tiles of `at` (the emptier cow field) */
function playersNear(at: At): number {
    let n = 0;
    for (const q of World.playerLoop.all()) if (q.level === at[2] && Math.max(Math.abs(q.x - at[0]), Math.abs(q.z - at[1])) <= 12) n++;
    return n;
}

/**
 * cowhides: the cows fought for hides, then CraftingTask's leather (Ellis, the bank, the leather screen). The emptier of
 * Lumbridge's two cow fields, east (by Al Kharid) on a tie: one field had 3-5 hides bots at once with the fighters there
 * (AM2 10.1 % in a free world)
 */
function hides(): ErrandPlan {
    const east = playersNear(CHAIN_PLACES.cows) <= playersNear(CHAIN_PLACES.cowsNorth);
    const field = east ? CHAIN_PLACES.cows : CHAIN_PLACES.cowsNorth;
    const cow = (): SkillStep | null => stepAt('ATTACK', field);
    let want = 0;
    return {
        kind: 'Hides',
        key: east ? 'lumbridge' : 'fred',
        at: field,
        stat: PlayerStat.CRAFTING,
        ok(p) {
            const step = cow();
            if (!step || combatWeaponFor(p, step) === null || !fitToFight(p, step)) return false;
            const tools = owned(p, I.needle()) > 0 && owned(p, I.thread()) > 0;
            return tools || coinsOwned(p) >= 60;
        },
        build(p) {
            want = load(8, 16);
            const toolsMissing = (q: Player): boolean => owned(q, I.needle()) === 0 || owned(q, I.thread()) === 0;
            return [
                when(toolsMissing, bank({ coins: 60, keep: () => [] }), shop('dommik', CHAIN_PLACES.dommik, { buy: [[I.needle(), owned(p, I.needle()) > 0 ? 0 : 1], [I.thread(), owned(p, I.thread()) > 0 ? 0 : 5]] })),
                line('hides-go'),
                // (into the field first, on the errand's own walk: from Al Kharid's toll gate the walking graph goes round
                // the field's north end, a walk away from the cows that the fight's stuck check read as stuck, and jumped:
                // D2-7's "long way"; its walk reads the route's legs)
                soft(walk(east ? CHAIN_PLACES.cowsInside : field, 4, 1500, 'to the cows')),
                // (a fight cut short, the hides it has are tanned all the same; the fight's own bank trips (its armour, a
                // retreat for food at a low level) bank them, and the leather task takes them from the bank)
                soft(fight(q => (cow() ? new CombatTask(cow()!, PlayerStat.STRENGTH) : null), q => carried(q, I.hide()) >= want || freeSlots(q) <= 2)),
                act('hides', q => (owned(q, I.hide()) > 0 ? 'done' : 'fail')),
                line('hides-tan'),
                inner(
                    q => {
                        const step = leatherStep(q);
                        return step ? new CraftingTask(step) : null;
                    },
                    () => false,
                    6000,
                    'leather',
                    true
                ),
                line('hides-done', 0.25),
                // (what it made banked with the beef; the needle and thread kept for the next load)
                bank({ keep: () => [I.needle(), I.thread()] })
            ];
        },
        again: (p, rounds) => rounds < 2 && owned(p, I.needle()) > 0 && owned(p, I.thread()) > 0
    };
}

/** the leather step of the bot's Crafting level (gloves at 1, boots at 7, vambraces at 11, a body at 14, chaps at 18), or null */
function leatherStep(p: Player): SkillStep | null {
    const lvl = level(p, PlayerStat.CRAFTING);
    const leather = (SkillProgression.CRAFTING ?? []).filter(s => s.action.startsWith('craft_leather_') && s.minLevel <= lvl);
    // (the variety work, round 2, the fixes: past every leather step's band, its best (the chaps): none was "undefined",
    // and CraftingTask's constructor threw, m500 s4)
    const inBand = leather.filter(s => lvl <= s.maxLevel);
    const steps = inBand.length > 0 ? inBand : leather;
    if (steps.length === 0) return null;
    // (now and then the one below the best: gloves as well as bodies)
    steps.sort((a, b) => b.minLevel - a.minLevel);
    return steps.length > 1 && Math.random() < 0.3 ? steps[1] : steps[0];
}

/** feathers: the chickens fought, the feathers (and the raw chicken) sold at the general store */
function feathers(): ErrandPlan {
    // (the farm's chickens by the cows; Fred's are in a coop whose fence a fight clicks through: "I can't reach that!")
    const at = (): At => CHAIN_PLACES.chickens;
    let spot: At = CHAIN_PLACES.chickens;
    let want = 0;
    return {
        kind: 'Feathers',
        key: 'lumbridge',
        at: CHAIN_PLACES.chickens,
        stat: PlayerStat.ATTACK,
        ok(p) {
            const step = stepAt('ATTACK', CHAIN_PLACES.chickens);
            return step !== null && combatWeaponFor(p, step) !== null && fitToFight(p, step);
        },
        build(p) {
            spot = at();
            // (the variety work, round 2, the fixes: the feathers it carried before, a fly fisher's bait, are its own: the
            // fight counts and the store buys only the ones gained. With 300 carried the fight was over at once and the bait
            // sold)
            const bait = carried(p, I.feather());
            want = bait + load(40, 120);
            return [
                line('feathers-go'),
                // (into the farm's pen on the errand's own walk, its gate opened on the way)
                soft(walk(CHAIN_PLACES.chickensInside, 3, 1500, 'to the chickens')),
                fight(() => (stepAt('ATTACK', spot) ? new CombatTask(stepAt('ATTACK', spot)!, PlayerStat.ATTACK) : null), q => carried(q, I.feather()) >= want || freeSlots(q) <= 2),
                line('feathers-sell'),
                general(CHAIN_PLACES.general[0], CHAIN_PLACES.general[1], { sell: [I.feather(), I.rawChicken()], keep: id => (id === I.feather() ? bait : 0) })
            ];
        },
        again: (_p, rounds) => rounds < 2
    };
}

/** pottery: Rimmington's clay softened at its sink, pots thrown and fired in Barbarian Village, banked at Edgeville */
function pottery(): ErrandPlan {
    let n = 0;
    return {
        kind: 'Pottery',
        key: 'barbarian',
        at: CHAIN_PLACES.potteryWheel,
        stat: PlayerStat.CRAFTING,
        ok(p) {
            const pick = ownedOf(p, PICKAXES);
            return pick >= 0 && (owned(p, I.bucket()) + owned(p, I.bucketWater()) > 0 || coinsOwned(p) >= 20);
        },
        build(p) {
            const pick = ownedOf(p, PICKAXES);
            const buckets = owned(p, I.bucket()) + owned(p, I.bucketWater());
            n = Math.max(4, Math.min(12, buckets > 0 ? buckets : load(6, 10)));
            return [
                bank({ coins: 20, keep: q => [pick, I.bucket(), I.bucketWater()], withdraw: [[pick, 1, true], [I.bucket(), 12], [I.bucketWater(), 12]] }),
                // (buckets: its own, and two more at Rimmington's general store by the clay while it has fewer than eight:
                // the store keeps two, and at 500 bots it is often sold out: then its own do)
                when(q => carried(q, I.bucket()) + carried(q, I.bucketWater()) < 8 && countItem(q, Items.COINS) >= 4, soft(general(CHAIN_PLACES.rimmingtonClay[0], CHAIN_PLACES.rimmingtonClay[1], { buy: [[I.bucket(), 2]] }))),
                act('buckets', q => (carried(q, I.bucket()) + carried(q, I.bucketWater()) > 0 ? 'done' : 'fail')),
                line('pottery-go'),
                gather({ locs: ['clayrock1', 'clayrock2'] }, 'Mine', CHAIN_PLACES.rimmingtonClay, I.clay(), q => carried(q, I.clay()) >= carried(q, I.bucket()) + carried(q, I.bucketWater()), { radius: 6 }),
                useOnLoc(() => I.bucket(), ['well'], CHAIN_PLACES.rimmingtonWell, { radius: 4, again: q => carried(q, I.bucket()) > 0, wait: 2 }),
                combine(I.clay(), I.bucketWater(), { again: q => carried(q, I.clay()) > 0 && carried(q, I.bucketWater()) > 0 }),
                line('pottery-wheel'),
                useOnLoc(() => I.softClay(), ['potterywheel'], CHAIN_PLACES.potteryWheel, { radius: 4, again: q => carried(q, I.softClay()) > 0, wait: 6, then: q => answerMake(q, 'skill_multi3:makex_a', carried(q, I.softClay())) }),
                useOnLoc(() => I.unfiredPot(), ['potteryoven'], CHAIN_PLACES.potteryOven, { radius: 4, again: q => carried(q, I.unfiredPot()) > 0, wait: 8, then: q => answerMake(q, 'skill_multi3:makex_a', carried(q, I.unfiredPot())) }),
                line('pottery-done', 0.3),
                bank({ near: Locations.EDGEVILLE_BANK as At, keep: [pick, I.bucket()] })
            ];
        },
        again: (_p, rounds) => rounds < 2
    };
}

/** flour at the Lumbridge mill (wheat, the hopper, the bin), bread on the castle kitchen's range */
function flour(): ErrandPlan {
    let n = 0;
    return {
        kind: 'Flour',
        key: 'lumbridge',
        at: CHAIN_PLACES.flourBin,
        stat: PlayerStat.COOKING,
        ok(p) {
            return owned(p, I.pot()) + owned(p, I.flour()) > 0 || coinsOwned(p) >= 40;
        },
        build(p) {
            const pots = owned(p, I.pot());
            n = Math.max(3, Math.min(10, pots > 0 ? pots : load(4, 8)));
            const containers = (q: Player): number => carried(q, I.jug()) + carried(q, I.bucket()) + carried(q, I.jugWater()) + carried(q, I.bucketWater());
            return [
                when(q => owned(q, I.pot()) < n || owned(q, I.jug()) + owned(q, I.bucket()) === 0, bank({ coins: 50, keep: () => [I.pot(), I.jug(), I.bucket()], withdraw: [[I.pot(), n], [I.jug(), n], [I.bucket(), n]] })),
                when(q => carried(q, I.pot()) < n || containers(q) < n, general(p.x, p.z, { buy: q => [[I.pot(), Math.max(0, n - carried(q, I.pot()))], [I.jug(), Math.max(0, n - containers(q))]] })),
                line('flour-go'),
                gather({ locs: ['wheat'] }, 'Pick', CHAIN_PLACES.wheat, I.grain(), q => carried(q, I.grain()) >= carried(q, I.pot()), { radius: 8 }),
                line('flour-mill', 0.25),
                climb(['ladder'], 'climb-up', CHAIN_PLACES.millLadder, 1),
                climb(['laddermiddle'], 'climb-up', CHAIN_PLACES.millLadder1, 2),
                hopperRounds(),
                climb(['laddertop'], 'climb-down', CHAIN_PLACES.millLadder2, 1),
                climb(['laddermiddle'], 'climb-down', CHAIN_PLACES.millLadder1, 0),
                clickLoc(['millbase', 'millbase_flour'], 'Empty', CHAIN_PLACES.flourBin, { radius: 3, watch: I.flour(), again: q => carried(q, I.pot()) > 0, wait: 3, max: 12 }),
                act('flour', q => (carried(q, I.flour()) > 0 ? 'done' : 'fail')),
                line('flour-bread', 0.3),
                // bread: the kitchen sink's water, the dough, the range (the Cook lets anyone use it)
                // (the courtyard's fountain: the kitchen's sink is behind its doors, and a route to it failed one walk in two)
                useOnLoc(() => (carried(p, I.jug()) > 0 ? I.jug() : I.bucket()), ['fountain'], CHAIN_PLACES.courtyardFountain, { radius: 3, again: q => carried(q, I.jug()) + carried(q, I.bucket()) > 0, wait: 2 }),
                when(q => carried(q, I.flour()) > 0 && carried(q, I.jugWater()) > 0, combine(I.flour(), I.jugWater(), { answer: 1, again: q => carried(q, I.flour()) > 0 && carried(q, I.jugWater()) > 0 })),
                when(q => carried(q, I.flour()) > 0 && carried(q, I.bucketWater()) > 0, combine(I.flour(), I.bucketWater(), { answer: 1, again: q => carried(q, I.flour()) > 0 && carried(q, I.bucketWater()) > 0 })),
                act('dough', q => (carried(q, I.dough()) > 0 ? 'done' : 'fail')),
                useOnLoc(() => I.dough(), ['cooksquestrange'], CHAIN_PLACES.kitchenRange, { radius: 3, again: q => carried(q, I.dough()) > 0, wait: 4 }),
                dropAll([I.burntBread()]),
                line('flour-done', 0.25),
                general(CHAIN_PLACES.general[0], CHAIN_PLACES.general[1], { sell: [I.bread(), I.flour()] })
            ];
        },
        again: (_p, rounds) => rounds < 2
    };
}

/**
 * the hopper: a grain in, the controls pulled, again for each grain carried (at most 12: the bin holds 30); a grain that
 * would not go in ("There is already grain in the hopper.": a pull that did not take) gets a pull first
 */
function hopperRounds(): Step {
    let step: Step | null = null;
    let phase: 'fill' | 'pull' = 'fill';
    let rounds = 0;
    let refused = 0;
    const reset = (r: StepResult): StepResult => {
        step = null;
        phase = 'fill';
        rounds = 0;
        refused = 0;
        return r;
    };
    return {
        label: 'hopper',
        tick(p, t) {
            if (phase === 'fill' && !step && (countItem(p, obj('grain')) === 0 || rounds >= 12)) return reset(rounds > 0 ? 'done' : 'fail');
            step ??= phase === 'fill' ? useOnLoc(() => obj('grain'), ['hopper_lumbridge', 'hopper_full'], CHAIN_PLACES.hopper, { radius: 3, wait: 4, max: 1 }) : clickLoc(['hopperlevers1', 'hoppercontrol_inuse'], 'Operate', CHAIN_PLACES.hopper, { radius: 4, wait: 6, max: 1 });
            if (p.delayed) return 'run';
            const r = step.tick(p, t);
            if (r === 'run') return 'run';
            step = null;
            if (phase === 'fill') {
                if (r === 'fail' && ++refused > 2) return reset('fail');
                phase = 'pull';
                return 'run';
            }
            if (r === 'fail') return reset('fail');
            phase = 'fill';
            rounds++;
            return 'run';
        }
    };
}

/** picking: cabbages by Draynor, potatoes west and east of Lumbridge; sold, or banked at Draynor */
function picking(): ErrandPlan {
    const fields = [
        { key: 'cabbages', at: CHAIN_PLACES.cabbages, loc: 'cabbage', item: () => obj('cabbage'), weight: 3 },
        { key: 'potatoes', at: CHAIN_PLACES.potatoes, loc: 'potato', item: () => obj('potato'), weight: 2 },
        { key: 'potatoes', at: CHAIN_PLACES.potatoesEast, loc: 'potato', item: () => obj('potato'), weight: 2 }
    ];
    let field = fields[0];
    return {
        kind: 'Picking',
        key: 'fields',
        at: CHAIN_PLACES.potatoes,
        build(p) {
            // (the field nearest the bot, mostly)
            const near = [...fields].sort((a, b) => Math.max(Math.abs(a.at[0] - p.x), Math.abs(a.at[1] - p.z)) - Math.max(Math.abs(b.at[0] - p.x), Math.abs(b.at[1] - p.z)));
            field = Math.random() < 0.7 ? near[0] : fields[Math.floor(Math.random() * fields.length)];
            const want = Math.min(freeSlots(p), load(10, 26));
            // (sold when a general store is near the field, else banked)
            const store = nearestGeneral(field.at[0], field.at[1]);
            const sells = Math.max(Math.abs(store[1][0] - field.at[0]), Math.abs(store[1][1] - field.at[1])) <= 70 && Math.random() < 0.7;
            return [
                when(q => freeSlots(q) < 10, bank({ keep: () => [] })),
                line(`picking-${field.key}`),
                gather({ locs: [field.loc] }, 'Pick', field.at, field.item(), q => carried(q, field.item()) >= want, { radius: 10 }),
                line('picking-done', 0.25),
                sells ? general(field.at[0], field.at[1], { sell: [field.item()] }) : bank({ keep: () => [] })
            ];
        },
        again: (_p, rounds) => rounds < 2
    };
}

/** shrimps and anchovies netted at Draynor or Al Kharid and cooked on a fire the bot lights by the water */
function fireCook(): ErrandPlan {
    let spot: At = CHAIN_PLACES.draynorFish;
    return {
        kind: 'FireCook',
        key: 'shrimp',
        at: CHAIN_PLACES.draynorFish,
        stat: PlayerStat.COOKING,
        ok(p) {
            const logs = LOGS().some(id => owned(p, id) >= 2);
            // (no logs of its own: an axe and Draynor's trees by the water, combat 16 for its dark wizards' side)
            const chop = ownedOf(p, AXES) >= 0 && p.combatLevel >= 16;
            return owned(p, I.net()) > 0 && (logs || chop) && (owned(p, I.tinderbox()) > 0 || coinsOwned(p) >= 10);
        },
        build(p) {
            const haveLogs = LOGS().some(id => owned(p, id) >= 2);
            spot = !haveLogs || (p.combatLevel >= 16 && Math.random() < 0.6) ? CHAIN_PLACES.draynorFish : CHAIN_PLACES.alkharidFish;
            const logId = LOGS().find(id => owned(p, id) >= 2) ?? Items.LOGS;
            const axe = haveLogs ? -1 : ownedOf(p, AXES);
            return [
                when(q => owned(q, I.tinderbox()) === 0, bank({ coins: 10, keep: [I.net()] }), general(p.x, p.z, { buy: [[I.tinderbox(), 1]] })),
                bank({ near: spot, keep: () => [I.net(), I.tinderbox(), logId, axe], withdraw: [[I.net(), 1, true], [I.tinderbox(), 1, true], [logId, haveLogs ? 5 : 0, haveLogs], [axe, haveLogs ? 0 : 1, !haveLogs]] }),
                // (logs: a few chopped from the trees by Draynor's water)
                when(q => !LOGS().some(id => carried(q, id) > 0), gather({ locs: ['tree', 'tree2'] }, 'Chop down', [3090, 3240, 0], Items.LOGS, q => carried(q, Items.LOGS) >= 4, { radius: 18, maxTicks: 900 })),
                line('firecook-go'),
                gather({ npcs: ['_saltfish'] }, 'Net', spot, Items.RAW_SHRIMP, q => freeSlots(q) <= 1, { radius: 10, maxTicks: 2500 }),
                // (no tile by the water takes a fire: the catch banked raw)
                soft(lightFire(LOGS(), fireAllowedAt, hasLocAt)),
                line('firecook-cook', 0.3),
                when(q => locNearBot(q, 'fire', 2), cookOnFire([Items.RAW_SHRIMP, Items.RAW_ANCHOVIES])),
                dropAll(BURNT_FISH.map(obj)),
                bank({ near: spot, keep: () => [I.net(), I.tinderbox(), ...LOGS(), ...AXES.map(obj)] })
            ];
        },
        again: (p, rounds) => rounds < 2 && (LOGS().some(id => owned(p, id) >= 2) || ownedOf(p, AXES) >= 0)
    };
}

/** every raw fish carried cooked on the fire the bot stands by (lit by it), one at a time; a new fire when it went out */
function cookOnFire(raws: readonly number[]): Step {
    let cook: Step | null = null;
    let relight: Step | null = null;
    let fires = 0;
    const rawOf = (p: Player): number | undefined => raws.find(id => countItem(p, id) > 0);
    return {
        label: 'cook on fire',
        tick(p, t) {
            if (rawOf(p) === undefined) {
                cook = null;
                relight = null;
                fires = 0;
                return 'done';
            }
            if (relight) {
                const r = relight.tick(p, t);
                if (r === 'run') return 'run';
                relight = null;
                // (no fire again: the rest raw to the bank)
                if (r === 'fail') {
                    fires = 0;
                    return 'done';
                }
            }
            cook ??= useOnLoc(() => rawOf(p) ?? raws[0], ['fire'], [p.x, p.z, p.level], { radius: 3, again: q => rawOf(q) !== undefined, wait: 3 });
            const r = cook.tick(p, t);
            if (r === 'run') return 'run';
            cook = null;
            // (the fire went out under it: another log, if it has one)
            if (r === 'fail') {
                // (out of logs: the rest raw to the bank, as a player out of logs does)
                if (++fires > 3 || !LOGS().some(id => countItem(p, id) > 0)) {
                    fires = 0;
                    return 'done';
                }
                relight = lightFire(LOGS(), fireAllowedAt, hasLocAt);
            }
            return 'run';
        }
    };
}

/** every raw fish of `raws` carried cooked on the loc there (a fire, a range), one at a time */
function cookAt(locs: readonly string[], at: At, raws: readonly number[]): Step {
    let current = -1;
    return useOnLoc(() => current, locs, at, {
        radius: 4,
        wait: 3,
        again: q => {
            current = raws.find(id => countItem(q, id) > 0) ?? -1;
            return current !== -1;
        },
        then: q => {
            if (current === -1) current = raws.find(id => countItem(q, id) > 0) ?? -1;
            return false;
        }
    });
}

/** trout and salmon caught at Barbarian Village and cooked on the longhall's fire */
function barbFire(): ErrandPlan {
    return {
        kind: 'FireCook',
        key: 'barbarian',
        at: CHAIN_PLACES.barbFish,
        stat: PlayerStat.COOKING,
        ok(p) {
            return level(p, PlayerStat.FISHING) >= 20 && level(p, PlayerStat.COOKING) >= 15 && owned(p, I.flyRod()) > 0 && owned(p, I.feather()) >= 30;
        },
        build() {
            return [
                bank({ near: CHAIN_PLACES.barbFish, keep: () => [I.flyRod(), I.feather()], withdraw: [[I.flyRod(), 1, true], [I.feather(), 200, true]] }),
                line('barbfire-go'),
                gather({ npcs: ['_freshfish'] }, 'Lure', CHAIN_PLACES.barbFish, Items.RAW_TROUT, q => freeSlots(q) === 0, { radius: 10, maxTicks: 3000 }),
                line('barbfire-cook', 0.3),
                cookAt(['fire'], CHAIN_PLACES.longhallFire, [Items.RAW_TROUT, Items.RAW_SALMON]),
                dropAll(BURNT_FISH.map(obj)),
                bank({ near: CHAIN_PLACES.barbFish, keep: () => [I.flyRod(), I.feather()] })
            ];
        },
        again: (_p, rounds) => rounds < 3
    };
}

/** bronze: copper and tin mined at Rimmington, banked at Falador East, smelted at the Falador furnace (SmithingTask's) */
function bronze(): ErrandPlan {
    return bars('bronze');
}

/** iron: Rimmington's iron rocks, smelted at the Falador furnace (Smithing and Mining 15; half the ore lost, as in 274) */
function iron(): ErrandPlan {
    return bars('iron');
}

/** the bar chain: bronze (copper and tin) or iron, mined at Rimmington and smelted through SmithingTask at Falador */
function bars(metal: 'bronze' | 'iron'): ErrandPlan {
    const bar = metal === 'bronze' ? Items.BRONZE_BAR : Items.IRON_BAR;
    const smelt = (): SkillStep | null => (SkillProgression.SMITHING ?? []).find(s => s.action === 'smelt' && s.itemGained === bar && s.location === Locations.FALADOR_FURNACE) ?? null;
    let n = 0;
    return {
        kind: 'Bronze',
        key: metal === 'bronze' ? 'falador' : 'iron',
        at: Locations.FALADOR_FURNACE as At,
        stat: PlayerStat.SMITHING,
        ok(p) {
            if (metal === 'iron' && (level(p, PlayerStat.SMITHING) < 15 || level(p, PlayerStat.MINING) < 15)) return false;
            return smelt() !== null && ownedOf(p, PICKAXES) >= 0;
        },
        build(p) {
            const pick = ownedOf(p, PICKAXES);
            n = metal === 'bronze' ? load(8, 13) : load(14, 24);
            const ores: Step[] =
                metal === 'bronze'
                    ? [
                          gather({ locs: ['copperrock1', 'copperrock2'] }, 'Mine', CHAIN_PLACES.rimmingtonCopper, Items.COPPER_ORE, q => carried(q, Items.COPPER_ORE) >= n, { radius: 6 }),
                          gather({ locs: ['tinrock1', 'tinrock2'] }, 'Mine', CHAIN_PLACES.rimmingtonTin, Items.TIN_ORE, q => carried(q, Items.TIN_ORE) >= n, { radius: 6 })
                      ]
                    : [gather({ locs: ['ironrock1', 'ironrock2'] }, 'Mine', CHAIN_PLACES.rimmingtonIron, Items.IRON_ORE, q => carried(q, Items.IRON_ORE) >= n, { radius: 8 })];
            return [
                when(q => carried(q, pick) === 0 || freeSlots(q) < (metal === 'bronze' ? 2 * n : n) + 1, bank({ keep: () => [pick], withdraw: [[pick, 1, true]] })),
                line(`${metal}-go`),
                ...ores,
                bank({ near: CHAIN_PLACES.faladorEastBank, keep: () => [pick] }),
                line(`${metal}-smelt`, 0.3),
                inner(() => (smelt() ? new SmithingTask(smelt()!) : null), () => false, 3000, 'smelt', true)
            ];
        },
        again: (_p, rounds) => rounds < 2
    };
}

/** every chain, by its key */
export const CHAINS: Readonly<Record<string, () => ErrandPlan>> = { hides, feathers, pottery, flour, picking, fireCook, barbFire, bronze, iron };

/** a chain's errand task (the tests'; the planner's through chainFor) */
export function chainTask(key: keyof typeof CHAINS | string): ErrandTask | null {
    const make = CHAINS[key];
    return make ? new ErrandTask(make()) : null;
}

// ── who takes one (the planner's hook block: chainFor) ──────────────────────────────────────────────────────────

/** a bot this weak or newer takes the chains (combat 3-20), a skiller at any combat while its skills are low */
export const CHAIN_COMBAT: readonly [number, number] = [3, 20];

/** a past-combat-20 bot's pick goes to a craft's chain this often, while the craft is low (bars, pottery, trout: AM1c) */
export const CRAFT_SHARE = 0.06;
/** the craft chains for a bot past combat 20 with Smithing under 45, Crafting under 30 or Cooking under 40 (not a
 * fighter's) */
const CRAFT_CHAINS: Readonly<Record<string, (p: Player) => boolean>> = {
    bronze: p => level(p, PlayerStat.SMITHING) < 45,
    iron: p => level(p, PlayerStat.SMITHING) < 45,
    pottery: p => level(p, PlayerStat.CRAFTING) < 30,
    barbFire: p => level(p, PlayerStat.COOKING) < 40
};

/** a bot past the chains' combat levels: the bars or pottery now and then while its craft is low; else null */
function craftFor(p: Player, roll: number): ErrandTask | null {
    if (roll >= CRAFT_SHARE || p.combatLevel <= CHAIN_COMBAT[1]) return null;
    const weights = chainWeights(p);
    const list: [string, number][] = [];
    for (const [k, low] of Object.entries(CRAFT_CHAINS)) {
        if (!low(p) || (weights[k] ?? 0) <= 0) continue;
        const plan = CHAINS[k]();
        if (!withinRange(p, plan.at) || (plan.ok && !plan.ok(p))) continue;
        list.push([k, weights[k]]);
    }
    if (list.length === 0) return null;
    let x = Math.random() * list.reduce((a, [, wt]) => a + wt, 0);
    for (const [k, wt] of list) if ((x -= wt) <= 0) return chainTask(k);
    return chainTask(list[list.length - 1][0]);
}

/** the chains that are a fight (a fighter's only ones) */
const FIGHT_CHAINS = new Set(['hides', 'feathers']);

/** how often a pick of a bot that suits them goes to a chain (AM11's 15-25 % of their levelling time) */
export const CHAIN_SHARE = 0.28;

/** each chain's weight for this bot (0: not for it): its levels, what it owns, the world */
export function chainWeights(p: Player): Record<string, number> {
    const cook = level(p, PlayerStat.COOKING);
    const craft = level(p, PlayerStat.CRAFTING);
    const fish = level(p, PlayerStat.FISHING);
    const w: Record<string, number> = {
        hides: craft < 40 ? 2.5 : 0.5,
        feathers: p.combatLevel <= 15 ? 2 : 0.5,
        pottery: craft < 30 ? 3 : 0.5,
        flour: cook < 30 ? 2 : 0.5,
        picking: p.combatLevel <= 12 ? 1.5 : 0.4,
        fireCook: fish < 40 && cook < 40 ? 3 : 0.5,
        barbFire: fish >= 20 && fish < 60 ? 2.5 : 0,
        bronze: level(p, PlayerStat.SMITHING) < 15 ? 3 : level(p, PlayerStat.SMITHING) < 30 ? 1 : 0.3,
        // (Smithing 15-45: iron bars, half of them lost at the furnace)
        iron: level(p, PlayerStat.SMITHING) >= 15 && level(p, PlayerStat.SMITHING) < 45 ? 2.5 : 0
    };
    // (the bot's own taste: its name's dice, a seed of its own: some like the farm, some the fishing)
    const r = seededRandom(nameSeed(p.username, 'd2-chain-taste'));
    for (const k of Object.keys(w)) w[k] *= 0.5 + r() * 1.5;
    return w;
}

/**
 * The planner's offer (BotGoalPlanner's Track D2 block): a chain for a bot in combat 3-20 (or a skiller with a low
 * craft), CHAIN_SHARE of its picks, by chainWeights among those whose plan may start now; null otherwise.
 */
export function chainFor(p: Player, skiller: boolean, roll: number = Math.random(), fighter = false): ErrandTask | null {
    const low = p.combatLevel >= CHAIN_COMBAT[0] && p.combatLevel <= CHAIN_COMBAT[1];
    const lowSkills = skiller && (level(p, PlayerStat.CRAFTING) < 30 || level(p, PlayerStat.COOKING) < 30);
    if (!low && !lowSkills) return fighter ? null : craftFor(p, roll);
    // (a fighter's half, and only the chains that are fights: its picks are its fights, the 2004 mix's combat share)
    if (roll >= CHAIN_SHARE * (low ? 1 : 0.6) * (fighter ? 0.5 : 1)) return null;
    const weights = chainWeights(p);
    const list: [string, number][] = [];
    for (const [k, wt] of Object.entries(weights)) {
        // (a skiller past the chains' combat levels takes the crafts, not the fights)
        if (wt <= 0 || (fighter && !FIGHT_CHAINS.has(k)) || (!low && FIGHT_CHAINS.has(k))) continue;
        const plan = CHAINS[k]();
        if (plan.members && !isMembersWorld()) continue;
        // (one within a walk: a chain 300+ tiles off is not what a bot there does, AM8)
        if (!withinRange(p, plan.at)) continue;
        if (plan.ok && !plan.ok(p)) continue;
        list.push([k, wt]);
    }
    if (list.length === 0) return null;
    let x = Math.random() * list.reduce((a, [, wt]) => a + wt, 0);
    for (const [k, wt] of list) {
        if ((x -= wt) <= 0) return chainTask(k);
    }
    return chainTask(list[list.length - 1][0]);
}
