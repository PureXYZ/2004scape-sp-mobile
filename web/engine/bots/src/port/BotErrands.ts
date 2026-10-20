/**
 * port (the variety work, round 2, Track D2: DO-15, the F2P quests' look-alikes; "newcomers walk F2P
 * quest steps with chatter; quest state never changes")
 *
 * Every bot has every quest done (BotManager.BOT_VARPS), so a quest itself cannot run: a newcomer or a low-level bot
 * (combat 3-25) walks one's steps instead, as 2004's newcomers were seen doing them, the gathering and the talking real
 * (an egg taken from the farm, a cow milked with a bucket, wheat milled, wool spun, ores mined; each NPC talked to,
 * who answers as after the quest), with a line now and then near others ("where do i get an egg", "finally done cooks
 * assistant lol": lines2004-activities.json, event 'errand', kinds 'q-<quest>-<step>'). No varp is written by the bot;
 * no dialogue option that starts a quest, opens a shop, teleports or starts a fight is picked (each NPC's options read
 * from 274's scripts: Lady Keli's guards, Aubury's and Sedridor's teleports left alone).
 *
 * The quests: Cook's Assistant, Sheep Shearer, Rune Mysteries, The Restless Ghost, Romeo and Juliet (Romeo, Father
 * Lawrence and the Apothecary: Juliet is upstairs in a house no walk climbs), Doric's Quest, Prince Ali Rescue (a
 * walk-through: Hassan, Osman, Leela, Joe at the jail, Aggie), Goblin Diplomacy (the two generals), Witch's Potion
 * (an onion and Hetty).
 */
import type Player from '#/engine/entity/Player.js';
import InvType from '#/cache/config/InvType.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import { Items, Locations, SkillProgression, type SkillStep } from '#/engine/bot/BotKnowledge.js';
import { getBaseLevel, countItem } from '#/engine/bot/BotAction.js';
import { CraftingTask } from '#/engine/bot/tasks/CraftingTask.js';
import { coinsOwned } from '#/engine/bot/BotNeeds.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { CHAIN_PLACES, nearestGeneral } from '#/engine/bot/port/BotChains.js';
import {
    ErrandTask,
    act,
    bank,
    clickLoc,
    climb,
    gather,
    inner,
    obj,
    owned,
    pause,
    say,
    shop,
    take,
    talk,
    useOnLoc,
    useOnNpc,
    walk,
    when,
    freeSlots,
    withinRange,
    type At,
    type ErrandPlan,
    type Step,
    type StepResult
} from '#/engine/bot/tasks/ErrandTask.js';

/** where the quests' people and things are (274's spawns; test/content-names.test.mjs checks each) */
export const QUEST_PLACES = {
    cook: [3208, 3214, 0] as At,
    kitchenPot: [3210, 3212, 0] as At,
    farmEggs: [3227, 3300, 0] as At,
    farmBucket: [3225, 3294, 0] as At,
    cows: [3253, 3272, 0] as At,
    fred: [3189, 3274, 0] as At,
    shears: [3152, 3306, 0] as At,
    sheep: Locations.LUMBRIDGE_SHEEP as At,
    duke: [3211, 3220, 1] as At,
    wizardsTowerLadder: [3105, 3162, 0] as At,
    wizardsTowerBasement: [3103, 9575, 0] as At,
    sedridor: [3104, 9572, 0] as At,
    aubury: [3252, 3402, 0] as At,
    aereck: [3244, 3207, 0] as At,
    urhney: [3236, 3154, 0] as At,
    coffin: [3250, 3193, 0] as At,
    romeo: [3211, 3424, 0] as At,
    lawrence: [3254, 3477, 0] as At,
    apothecary: [3196, 3404, 0] as At,
    rimmingtonMine: [2981, 3237, 0] as At,
    doric: [2951, 3450, 0] as At,
    hassan: [3300, 3163, 0] as At,
    osman: [3286, 3181, 0] as At,
    leela: [3112, 3263, 0] as At,
    jail: [3127, 3246, 0] as At,
    aggie: [3087, 3258, 0] as At,
    generals: [2957, 3509, 0] as At,
    betty: [3013, 3258, 0] as At,
    hetty: [2968, 3207, 0] as At
} as const;

const carried = (p: Player, id: number): number => countItem(p, id);
const line = (kind: string, chance = 0.5): Step => say(`q-${kind}`, chance);

/** the store nearest a place: a shop step there */
function general(at: At, opts: Parameters<typeof shop>[2]): Step {
    const [npc, where] = nearestGeneral(at[0], at[1]);
    return shop(npc, where, opts);
}

/** an item: taken where it spawns (the kitchen's pot, the farm's bucket), else bought at the store nearest */
function fetchItem(id: () => number, spawn: At, store: At): Step {
    let tried: Step | null = null;
    let buying: Step | null = null;
    return {
        label: `fetch ${spawn.join(',')}`,
        tick(p, t): StepResult {
            if (carried(p, id()) > 0) {
                tried = null;
                buying = null;
                return 'done';
            }
            if (!buying) {
                tried ??= take(id(), spawn, 4, 60);
                const r = tried.tick(p, t);
                if (r === 'run') return 'run';
                if (r === 'done') {
                    tried = null;
                    return 'done';
                }
                // (gone: another player has it; the store then)
                buying = general(store, { buy: [[id(), 1]] });
            }
            const r = buying.tick(p, t);
            if (r !== 'run') {
                tried = null;
                buying = null;
            }
            return r;
        }
    };
}

/** the steps to a pot of flour: wheat, the mill's hopper and its flour bin (port/BotChains' mill, one grain) */
function flourSteps(): Step[] {
    return [
        gather({ locs: ['wheat'] }, 'Pick', CHAIN_PLACES.wheat, obj('grain'), p => carried(p, obj('grain')) >= 1, { radius: 8 }),
        climb(['ladder'], 'climb-up', CHAIN_PLACES.millLadder, 1),
        climb(['laddermiddle'], 'climb-up', CHAIN_PLACES.millLadder1, 2),
        millOne(),
        climb(['laddertop'], 'climb-down', CHAIN_PLACES.millLadder2, 1),
        climb(['laddermiddle'], 'climb-down', CHAIN_PLACES.millLadder1, 0),
        clickLoc(['millbase', 'millbase_flour'], 'Empty', CHAIN_PLACES.flourBin, { radius: 3, watch: obj('pot_flour'), again: p => carried(p, obj('pot_flour')) === 0, wait: 3, max: 3 })
    ];
}

/** one grain in the hopper and the controls pulled (again when the grain would not go in: a pull first) */
function millOne(): Step {
    let phase: 'fill' | 'pull' = 'fill';
    let step: Step | null = null;
    let tries = 0;
    const end = (r: StepResult): StepResult => {
        phase = 'fill';
        step = null;
        tries = 0;
        return r;
    };
    return {
        label: 'mill',
        tick(p, t) {
            if (!step) {
                if (phase === 'fill' && carried(p, obj('grain')) === 0) return end(tries > 0 ? 'done' : 'fail');
                step =
                    phase === 'fill'
                        ? useOnLoc(obj('grain'), ['hopper_lumbridge', 'hopper_full'], CHAIN_PLACES.hopper, { radius: 3, wait: 4, max: 1 })
                        : clickLoc(['hopperlevers1', 'hoppercontrol_inuse'], 'Operate', CHAIN_PLACES.hopper, { radius: 4, wait: 6, max: 1 });
            }
            if (p.delayed) return 'run';
            const r = step.tick(p, t);
            if (r === 'run') return 'run';
            step = null;
            if (phase === 'fill') {
                phase = 'pull';
                if (r === 'fail' && ++tries > 3) return end('fail');
                return 'run';
            }
            phase = 'fill';
            tries++;
            return carried(p, obj('grain')) === 0 ? end('done') : 'run';
        }
    };
}

// ── the quests ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Cook's Assistant: an egg, a bucket of milk and a pot of flour, then the Lumbridge cook */
function cook(): ErrandPlan {
    return {
        kind: 'Quest',
        key: 'cook',
        at: QUEST_PLACES.cook,
        ok: p => freeSlots(p) >= 6,
        build: () => [
            line('cook-start'),
            fetchItem(() => obj('egg'), QUEST_PLACES.farmEggs, QUEST_PLACES.cook),
            line('cook-egg', 0.35),
            fetchItem(() => obj('bucket_empty'), QUEST_PLACES.farmBucket, QUEST_PLACES.cook),
            line('cook-milk', 0.4),
            useOnNpc(obj('bucket_empty'), ['cow', 'cow2', 'cow_beef'], QUEST_PLACES.cows, { radius: 12 }),
            act('milk', p => (carried(p, obj('bucket_milk')) > 0 ? 'done' : 'fail')),
            fetchItem(() => obj('pot_empty'), QUEST_PLACES.kitchenPot, QUEST_PLACES.cook),
            line('cook-flour', 0.4),
            ...flourSteps(),
            act('flour', p => (carried(p, obj('pot_flour')) > 0 ? 'done' : 'fail')),
            talk('cook', QUEST_PLACES.cook, { optional: true, pick: [1, 2, 3, 4] }),
            line('cook-done', 0.6),
            pause(5, 30)
        ]
    };
}

/** Sheep Shearer: shears, the sheep, the castle's wheel (CraftingTask's wool), Fred the Farmer */
function sheep(): ErrandPlan {
    const woolStep = (): SkillStep | null => (SkillProgression.CRAFTING ?? []).find(s => s.action === 'craft_wool') ?? null;
    let want = 0;
    return {
        kind: 'Quest',
        key: 'sheep',
        at: QUEST_PLACES.fred,
        ok: p => woolStep() !== null && freeSlots(p) >= 8 && (owned(p, Items.SHEARS) > 0 || coinsOwned(p) >= 2),
        build: () => {
            want = 5 + Math.floor(Math.random() * 6);
            return [
                line('sheep-start'),
                talk('fred_the_farmer', QUEST_PLACES.fred, { optional: true, pick: [1, 2] }),
                when(p => owned(p, Items.SHEARS) === 0, fetchItem(() => Items.SHEARS, QUEST_PLACES.shears, QUEST_PLACES.fred)),
                line('sheep-shear', 0.35),
                inner(p => new CraftingTask(woolStep()!), p => carried(p, obj('ball_of_wool')) >= want, 4000, 'wool'),
                line('sheep-spin', 0.3),
                walk([3206, 3210, 0], 3, 600, 'down the stairs'),
                talk('fred_the_farmer', QUEST_PLACES.fred, { optional: true, pick: [1, 2] }),
                line('sheep-done', 0.6),
                general(QUEST_PLACES.fred, { sell: [obj('ball_of_wool'), obj('wool')] })
            ];
        }
    };
}

/** Rune Mysteries: Duke Horacio, the Wizards' Tower's basement and Sedridor, Aubury in Varrock */
function runeMysteries(): ErrandPlan {
    // (the Duke offers the dragon's-breath shield first when the bot carries or wears none: then "quests" is the second)
    const shieldHeld = (p: Player): boolean => carried(p, obj('antidragonbreathshield')) > 0 || (p.getInventory(InvType.WORN)?.getItemCount(obj('antidragonbreathshield')) ?? 0) > 0;
    return {
        kind: 'Quest',
        key: 'runemysteries',
        at: QUEST_PLACES.duke,
        build: p => [
            line('rune-start'),
            talk('duke_of_lumbridge', QUEST_PLACES.duke, { optional: true, answers: [shieldHeld(p) ? 1 : 2] }),
            line('rune-tower', 0.4),
            walk([3106, 3163, 0], 2, 2500, 'to the tower'),
            climb(['wizards_tower_laddertop'], 'climb-down', QUEST_PLACES.wizardsTowerLadder, 0, q => q.z > 6400),
            act('below', q => (q.z > 6400 ? 'done' : 'fail')),
            talk('head_wizard', QUEST_PLACES.sedridor, { optional: true, answers: [1] }),
            climb(['wizards_tower_ladder'], 'climb-up', QUEST_PLACES.wizardsTowerBasement, 0, q => q.z < 6400),
            act('above', q => (q.z < 6400 ? 'done' : 'fail')),
            line('rune-aubury', 0.4),
            talk('aubury', QUEST_PLACES.aubury, { optional: true, answers: [2] }),
            line('rune-done', 0.6)
        ]
    };
}

/** The Restless Ghost: Father Aereck, Father Urhney in the swamp, the coffin in the graveyard */
function ghost(): ErrandPlan {
    return {
        kind: 'Quest',
        key: 'ghost',
        at: QUEST_PLACES.coffin,
        build: () => [
            line('ghost-start'),
            talk('father_aereck', QUEST_PLACES.aereck, { optional: true, pick: [2, 3] }),
            line('ghost-urhney', 0.4),
            talk('father_urhney', QUEST_PLACES.urhney, { optional: true, answers: [1] }),
            line('ghost-grave', 0.35),
            clickLoc(['shutghostcoffin'], 'Open', QUEST_PLACES.coffin, { radius: 4, wait: 4, max: 1 }),
            pause(10, 40, 'look'),
            line('ghost-done', 0.6)
        ]
    };
}

/** Romeo and Juliet: Romeo in the square, Father Lawrence, the Apothecary, Romeo again */
function romeo(): ErrandPlan {
    return {
        kind: 'Quest',
        key: 'romeo',
        at: QUEST_PLACES.romeo,
        build: () => [
            line('romeo-start'),
            talk('romeo', QUEST_PLACES.romeo, { optional: true, answers: [1] }),
            line('romeo-lawrence', 0.35),
            talk('father_lawrence', QUEST_PLACES.lawrence, { optional: true, answers: [1] }),
            line('romeo-potion', 0.35),
            talk('apothecary', QUEST_PLACES.apothecary, { optional: true, pick: [2, 3] }),
            talk('romeo', QUEST_PLACES.romeo, { optional: true, answers: [1] }),
            line('romeo-done', 0.6)
        ]
    };
}

/** Doric's Quest: clay, copper and iron mined at Rimmington, taken to Doric north of Falador, banked after */
function doric(): ErrandPlan {
    const pickaxes = ['bronze_pickaxe', 'iron_pickaxe', 'steel_pickaxe', 'mithril_pickaxe', 'adamant_pickaxe', 'rune_pickaxe'];
    const pickOf = (p: Player): number => {
        for (const n of [...pickaxes].reverse()) if (owned(p, obj(n)) > 0) return obj(n);
        return -1;
    };
    return {
        kind: 'Quest',
        key: 'doric',
        at: QUEST_PLACES.doric,
        ok: p => pickOf(p) >= 0 && freeSlots(p) >= 14,
        build: p => {
            const pick = pickOf(p);
            const iron = getBaseLevel(p, PlayerStat.MINING) >= 15;
            return [
                when(q => carried(q, pick) === 0, bank({ keep: () => [], withdraw: [[pick, 1, true]] })),
                line('doric-start'),
                gather({ locs: ['clayrock1', 'clayrock2'] }, 'Mine', QUEST_PLACES.rimmingtonMine, Items.CLAY, q => carried(q, Items.CLAY) >= 6, { radius: 10 }),
                gather({ locs: ['copperrock1', 'copperrock2'] }, 'Mine', QUEST_PLACES.rimmingtonMine, Items.COPPER_ORE, q => carried(q, Items.COPPER_ORE) >= 4, { radius: 10 }),
                when(() => iron, gather({ locs: ['ironrock1', 'ironrock2'] }, 'Mine', QUEST_PLACES.rimmingtonMine, Items.IRON_ORE, q => carried(q, Items.IRON_ORE) >= 2, { radius: 10, maxTicks: 1500 })),
                line('doric-walk', 0.35),
                talk('doric', QUEST_PLACES.doric, { optional: true, answers: [1] }),
                line('doric-done', 0.6),
                bank({ keep: () => [pick] })
            ];
        }
    };
}

/** Prince Ali Rescue, walked through: Hassan and Osman in Al Kharid, Leela and Joe in Draynor, Aggie (never Lady Keli: her guards attack) */
function prince(): ErrandPlan {
    return {
        kind: 'Quest',
        key: 'prince',
        at: QUEST_PLACES.jail,
        build: () => [
            line('prince-start'),
            talk('hassan', QUEST_PLACES.hassan, { optional: true, answers: [1] }),
            talk('osman', QUEST_PLACES.osman, { optional: true, answers: [1] }),
            line('prince-draynor', 0.35),
            talk('leela', QUEST_PLACES.leela, { optional: true, answers: [1] }),
            talk('joe', QUEST_PLACES.jail, { optional: true, answers: [1] }),
            line('prince-jail', 0.35),
            talk('aggie', QUEST_PLACES.aggie, { optional: true, pick: [2, 3] }),
            line('prince-done', 0.6)
        ]
    };
}

/** Goblin Diplomacy: the two generals in Goblin Village */
function goblin(): ErrandPlan {
    return {
        kind: 'Quest',
        key: 'goblin',
        at: QUEST_PLACES.generals,
        build: () => [
            line('goblin-start'),
            talk('general_wartface', QUEST_PLACES.generals, { optional: true, answers: [1] }),
            talk('general_bentnoze', QUEST_PLACES.generals, { optional: true, answers: [1] }),
            line('goblin-done', 0.6)
        ]
    };
}

/** Witch's Potion: an eye of newt from Betty's in Port Sarim, then Hetty in Rimmington (Fred's onion garden is shut) */
function witch(): ErrandPlan {
    return {
        kind: 'Quest',
        key: 'witch',
        at: QUEST_PLACES.hetty,
        ok: p => freeSlots(p) >= 2 && coinsOwned(p) >= 3,
        build: () => [
            line('witch-start'),
            when(q => countItem(q, Items.COINS) < 3, bank({ coins: 10, keep: () => [] })),
            shop('betty', QUEST_PLACES.betty, { buy: [[Items.EYE_OF_NEWT, 1]] }),
            line('witch-hetty', 0.35),
            talk('hetty', QUEST_PLACES.hetty, { optional: true, answers: [1] }),
            line('witch-done', 0.6)
        ]
    };
}

/** every quest look-alike, by its key */
export const QUESTS: Readonly<Record<string, () => ErrandPlan>> = { cook, sheep, runemysteries: runeMysteries, ghost, romeo, doric, prince, goblin, witch };

/** a quest look-alike's task (the tests'; the planner's through questFor) */
export function questTask(key: string): ErrandTask | null {
    const make = QUESTS[key];
    return make ? new ErrandTask(make()) : null;
}

// ── who walks one (the planner's hook block: questFor) ──────────────────────────────────────────────────────────

/** a newcomer (port/BotNewbie) or a bot of combat 3-25 */
export const QUEST_COMBAT: readonly [number, number] = [3, 25];
/** a newcomer's pick goes to a look-alike this often (with the questers': 10-20 % of its time, QA1b) */
export const QUEST_NEWBIE_SHARE = 0.06;
/**
 * a newcomer who is a quester (by its name, seed salt 'd2-quester') takes one QUESTER_PICK_SHARE of its picks until it
 * has done one this session, as many 2004 newcomers did a quest or two early on (the rest the odd one:
 * QUEST_NEWBIE_SHARE). Fewer left to chance, and not all at a session's start: its first pick, tried first, put half
 * a 3,000-tick run's newcomer time in quests and 3 % of another's.
 */
export const QUESTER_SHARE = 0.4;
export const QUESTER_PICK_SHARE = 0.25;
/** a low-level bot's pick, this often */
export const QUEST_LOW_SHARE = 0.03;

/** the look-alikes this bot did this session (never the same twice: a newcomer does a quest once) */
const done = new WeakMap<Player, Set<string>>();

/** where each starts (the nearest first, mostly: a Lumbridge newcomer's Cook's Assistant, a Varrock one's Romeo) */
const STARTS: Readonly<Record<string, At>> = {
    cook: QUEST_PLACES.cook,
    sheep: QUEST_PLACES.fred,
    runemysteries: QUEST_PLACES.duke,
    ghost: QUEST_PLACES.aereck,
    romeo: QUEST_PLACES.romeo,
    doric: QUEST_PLACES.rimmingtonMine,
    prince: QUEST_PLACES.hassan,
    goblin: QUEST_PLACES.generals,
    witch: QUEST_PLACES.betty
};

/**
 * The planner's offer (BotGoalPlanner's Track D2 block, and the newcomers' own path): a quest look-alike, QUEST_NEWBIE_SHARE
 * of a newcomer's picks and QUEST_LOW_SHARE of a combat 3-25 bot's, one it has not done this session, near it mostly;
 * null otherwise.
 */
export function questFor(p: Player, roll: number = Math.random()): ErrandTask | null {
    const newbie = isNewbie(p);
    if (!newbie && (p.combatLevel < QUEST_COMBAT[0] || p.combatLevel > QUEST_COMBAT[1])) return null;
    const did = done.get(p) ?? new Set<string>();
    const quester = newbie && did.size === 0 && seededRandom(nameSeed(p.username, 'd2-quester'))() < QUESTER_SHARE;
    if (roll >= (quester ? QUESTER_PICK_SHARE : newbie ? QUEST_NEWBIE_SHARE : QUEST_LOW_SHARE)) return null;
    const open = Object.keys(QUESTS).filter(k => !did.has(k) && withinRange(p, STARTS[k]));
    if (open.length === 0) return null;
    const dist = (k: string): number => Math.max(Math.abs(STARTS[k][0] - p.x), Math.abs(STARTS[k][1] - p.z));
    // (weighed by nearness: 1 / (1 + (d / 150)^2))
    const weights = open.map(k => 1 / (1 + (dist(k) / 150) ** 2));
    let x = Math.random() * weights.reduce((a, b) => a + b, 0);
    let key = open[open.length - 1];
    for (let i = 0; i < open.length; i++) {
        if ((x -= weights[i]) <= 0) {
            key = open[i];
            break;
        }
    }
    const plan = QUESTS[key]();
    if (plan.ok && !plan.ok(p)) return null;
    did.add(key);
    done.set(p, did);
    return new ErrandTask(plan);
}

/** (tests) a bot's look-alikes done this session forgotten */
export function forgetQuestsForTest(p: Player): void {
    done.delete(p);
}
