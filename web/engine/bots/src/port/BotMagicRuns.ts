/**
 * port (the variety work, round 2, Track D2: DO-14, prayer and magic variety,
 * the research)
 *
 * 2004's other ways to train Prayer and Magic, each an errand (tasks/ErrandTask) through the real game, the runes and the
 * items earned (only a bot that owns them goes):
 *   - a bone run: the hill giants in the Edgeville dungeon fought for their big bones (a CombatTask that keeps them:
 *     keepBigBones), the load buried at the Edgeville bank;
 *   - superheat: iron ore (banked, or mined at Rimmington's rocks) turned to bars where it stands, 274's
 *     [opheldt,magic:superheat_item] (a nature rune and four fire runes, or a staff of fire), the bars banked at Falador;
 *   - enchanting: sapphire rings and amulets at a bank, [opheldt,magic:enchant_lvl1] (a cosmic and a water rune each);
 *   - the wine of Zamorak telegrabbed in the Asgarnian chaos temple, [apobjt,magic:telekinetic_grab] (a law and an air
 *     rune each), its monks about (the grab, unlike a hand's Take, does not set them on the bot: wine_of_zamorak.rs2).
 * The humanlike report reports each kind's bot-hours (BoneRun, Superheat, Enchant, Telegrab).
 */
import type Player from '#/engine/entity/Player.js';
import InvType from '#/cache/config/InvType.js';
import Component from '#/cache/config/Component.js';
import { Interaction } from '#/engine/entity/Interaction.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import World from '#/engine/World.js';
import Obj from '#/engine/entity/Obj.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import { Items, Locations, SkillProgression, type SkillStep } from '#/engine/bot/BotKnowledge.js';
import { getBaseLevel, countItem, interactSpellOnHeld, isNear } from '#/engine/bot/BotAction.js';
import { CombatTask, combatWeaponFor, fitToFight } from '#/engine/bot/tasks/CombatTask.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { ErrandTask, act, bank, clickLoc, either, fight, freeSlots, gather, heldOp, obj, owned, pause, say, walk, withinRange, type At, type ErrandPlan, type Step, type StepResult } from '#/engine/bot/tasks/ErrandTask.js';
import LocType from '#/cache/config/LocType.js';

/** is the loc of this debugname on (x, z) (a door shut: its closed form)? */
function locNearIs(p: Player, name: string, x: number, z: number): boolean {
    const id = LocType.getId(name);
    const zone = World.gameMap.getZone(x, z, p.level);
    if (!zone || id === -1) return false;
    for (const loc of zone.getAllLocsSafe()) if (loc.type === id && loc.x === x && loc.z === z) return true;
    return false;
}

export const MAGIC_PLACES = {
    edgevilleBank: Locations.EDGEVILLE_BANK as At,
    faladorWestBank: Locations.FALADOR_WEST_BANK as At,
    rimmingtonIron: [2973, 3237, 0] as At,
    chaosTemple: [2934, 3516, 0] as At,
    templeDoor: [2942, 3517, 0] as At,
    wine: [2930, 3515, 0] as At
} as const;

const carried = (p: Player, id: number): number => countItem(p, id);
const level = (p: Player, stat: PlayerStat): number => getBaseLevel(p, stat);
const line = (kind: string, chance = 0.35): Step => say(`magic-${kind}`, chance);

/** worn or carried */
function wears(p: Player, id: number): boolean {
    const worn = p.getInventory(InvType.WORN);
    if (worn) for (let s = 0; s < worn.capacity; s++) if (worn.get(s)?.id === id) return true;
    return false;
}

// ── the bone run ─────────────────────────────────────────────────────────────────────────────────────────────────

function giantStep(): SkillStep | null {
    return SkillProgression.ATTACK?.find(s => s.location === Locations.HILL_GIANTS_EDGEVILLE && s.action === 'combat') ?? null;
}

/** the big bones of the Edgeville dungeon's hill giants, buried at the Edgeville bank */
function boneRun(): ErrandPlan {
    let want = 0;
    return {
        kind: 'BoneRun',
        key: 'edgeville',
        at: Locations.HILL_GIANTS_EDGEVILLE as At,
        stat: PlayerStat.PRAYER,
        ok(p) {
            const step = giantStep();
            return step !== null && p.combatLevel >= 30 && combatWeaponFor(p, step) !== null && fitToFight(p, step);
        },
        build() {
            want = 10 + Math.floor(Math.random() * 12);
            return [
                line('bones-go'),
                fight(
                    () => {
                        const step = giantStep();
                        if (!step) return null;
                        const task = new CombatTask(step, PlayerStat.STRENGTH);
                        task.keepBigBones = true;
                        return task;
                    },
                    q => carried(q, Items.BIG_BONES) >= want || freeSlots(q) <= 1
                ),
                walk(MAGIC_PLACES.edgevilleBank, 4, 2500, 'to the bank'),
                line('bones-bury', 0.3),
                heldOp(Items.BIG_BONES, 1, { again: q => carried(q, Items.BIG_BONES) > 0, wait: 2 }),
                bank({ near: MAGIC_PLACES.edgevilleBank })
            ];
        },
        again: (_p, rounds) => rounds < 3
    };
}

// ── superheat ────────────────────────────────────────────────────────────────────────────────────────────────────

/** casts on every `item` carried with the spell `com`, one at a time (the spell holds the caster a few ticks) */
function castOnHeld(com: string, items: () => readonly number[], max = 30): Step {
    let waitTicks = 0;
    let casts = 0;
    let fails = 0;
    /** the last cast's item and how many were carried before it (judged when its wait is over) */
    let lastId = -1;
    let lastBefore = 0;
    const end = (): StepResult => {
        const r = casts - fails > 0 ? 'done' : 'fail';
        casts = 0;
        fails = 0;
        lastId = -1;
        return r;
    };
    return {
        label: `cast ${com}`,
        tick(p): StepResult {
            if (waitTicks > 0 && (--waitTicks > 0 || p.delayed)) return 'run';
            // (the variety work, round 2, the fixes) the last cast judged a few ticks after it, its item still there (out of
            // runes; a members' jewel on a free world, refused): two such and the run is over. Judged in the tick of the
            // click, before the spell ran, every cast from the third looked failed and none ended a refused one: 30 casts
            if (lastId !== -1) {
                if (carried(p, lastId) >= lastBefore && ++fails >= 2) return end();
                lastId = -1;
            }
            const inv = p.getInventory(InvType.INV);
            const id = items().find(i => carried(p, i) > 0);
            if (!inv || id === undefined || casts >= max) return end();
            let slot = -1;
            for (let s = 0; s < inv.capacity; s++) if (inv.get(s)?.id === id) slot = s;
            const before = carried(p, id);
            if (!interactSpellOnHeld(p, com, id, slot)) {
                if (++fails > 5) return end();
                waitTicks = 3;
                return 'run';
            }
            casts++;
            lastId = id;
            lastBefore = before;
            waitTicks = 3 + Math.floor(Math.random() * 3);
            return 'run';
        }
    };
}

const fireOk = (p: Player): boolean => wears(p, Items.STAFF_OF_FIRE) || carried(p, Items.FIRE_RUNE) >= 4;

/** (the variety work, round 2, the fixes) the pickaxes and the Mining level each wants (274's: bronze and iron 1, steel 6, mithril 21, adamant 31, rune 41) */
const PICKAXES: readonly (readonly [string, number])[] = [
    ['rune_pickaxe', 41],
    ['adamant_pickaxe', 31],
    ['mithril_pickaxe', 21],
    ['steel_pickaxe', 6],
    ['iron_pickaxe', 1],
    ['bronze_pickaxe', 1]
];
/** the best pickaxe the bot owns and may use, or -1 */
function ownedPickaxe(p: Player): number {
    const mining = level(p, PlayerStat.MINING);
    for (const [name, lvl] of PICKAXES) {
        const id = obj(name);
        if (id !== -1 && mining >= lvl && owned(p, id) > 0) return id;
    }
    return -1;
}

/** iron (banked ore, or Rimmington's rocks) superheated into bars, the bars banked at Falador West */
function superheat(): ErrandPlan {
    let mine = false;
    return {
        kind: 'Superheat',
        key: 'falador',
        at: MAGIC_PLACES.faladorWestBank,
        stat: PlayerStat.MAGIC,
        ok(p) {
            // (the variety work, round 2, the fixes: the staff of fire worn, a banked one is no fire (its runes are
            // withdrawn and none were there: the 'runes' step failed at the bank); and a pickaxe of its own to mine with,
            // or the ore: its withdrawal was a need, and the errand failed at the bank)
            return level(p, PlayerStat.MAGIC) >= 43 && level(p, PlayerStat.SMITHING) >= 15 && owned(p, Items.NATURE_RUNE) >= 8 && (wears(p, Items.STAFF_OF_FIRE) || owned(p, Items.FIRE_RUNE) >= 32) && (owned(p, Items.IRON_ORE) >= 8 || (level(p, PlayerStat.MINING) >= 15 && ownedPickaxe(p) !== -1));
        },
        build(p) {
            mine = owned(p, Items.IRON_ORE) < 8;
            const natures = Math.min(26, owned(p, Items.NATURE_RUNE));
            const pick = ownedPickaxe(p);
            const staff = owned(p, Items.STAFF_OF_FIRE) > 0;
            const room = mine ? 20 : 24;
            const withdraw: (readonly [number, number, boolean?])[] = [[Items.NATURE_RUNE, natures, true]];
            if (!staff || !wears(p, Items.STAFF_OF_FIRE)) withdraw.push([Items.FIRE_RUNE, natures * 4]);
            if (mine) withdraw.push([pick, 1, true]);
            else withdraw.push([Items.IRON_ORE, Math.min(room, natures)]);
            return [
                bank({ near: MAGIC_PLACES.faladorWestBank, keep: () => [Items.NATURE_RUNE, Items.FIRE_RUNE, pick, Items.IRON_ORE], withdraw }),
                act('runes', q => (carried(q, Items.NATURE_RUNE) > 0 && fireOk(q) ? 'done' : 'fail')),
                line('superheat-go'),
                ...(mine ? [gather({ locs: ['ironrock1', 'ironrock2'] }, 'Mine', MAGIC_PLACES.rimmingtonIron, Items.IRON_ORE, q => carried(q, Items.IRON_ORE) >= Math.min(room, carried(q, Items.NATURE_RUNE)), { radius: 10 })] : []),
                castOnHeld('magic:superheat_item', () => [Items.IRON_ORE]),
                line('superheat-done', 0.25),
                bank({ near: MAGIC_PLACES.faladorWestBank, keep: () => [] })
            ];
        },
        again: (p, rounds) => rounds < 3 && owned(p, Items.NATURE_RUNE) >= 4
    };
}

// ── enchanting ───────────────────────────────────────────────────────────────────────────────────────────────────

// (the variety work, round 2, the fixes: on a free world the amulet only: the ring of recoil and the games necklace are
// members' objects, which 274's magic_spell_enchant refuses there ("You can only make that on a members' server."), and
// the run cast at the ring 30 times)
const ENCHANTABLE = () => (isMembersWorld() ? [obj('sapphire_ring'), obj('strung_sapphire_amulet'), obj('sapphire_necklace')] : [obj('strung_sapphire_amulet')]).filter(id => id >= 0);

/** sapphire jewellery enchanted at the bank nearest (lvl-1 enchant: a cosmic and a water rune each) */
function enchant(): ErrandPlan {
    return {
        kind: 'Enchant',
        key: 'sapphire',
        at: MAGIC_PLACES.faladorWestBank,
        stat: PlayerStat.MAGIC,
        ok(p) {
            const jewels = ENCHANTABLE().reduce((a, id) => a + owned(p, id), 0);
            return level(p, PlayerStat.MAGIC) >= 7 && jewels >= 3 && owned(p, Items.COSMIC_RUNE) >= 3 && (owned(p, Items.WATER_RUNE) >= 3 || owned(p, Items.STAFF_OF_WATER) > 0);
        },
        build(p) {
            const n = Math.min(26, owned(p, Items.COSMIC_RUNE));
            const jewel = ENCHANTABLE().find(id => owned(p, id) > 0) ?? -1;
            return [
                bank({ keep: () => [Items.COSMIC_RUNE, Items.WATER_RUNE, jewel], withdraw: [[Items.COSMIC_RUNE, n, true], [Items.WATER_RUNE, n], [jewel, Math.min(24, n), true]] }),
                line('enchant-go'),
                castOnHeld('magic:enchant_lvl1', ENCHANTABLE),
                pause(2, 10),
                bank({ keep: () => [] })
            ];
        },
        again: (p, rounds) => rounds < 2 && ENCHANTABLE().some(id => owned(p, id) > 0)
    };
}

// ── the wine of Zamorak ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The wine telegrabbed off the chaos temple's table as a player's client casts it (OpObjTHandler: the spell's component on
 * the ground item), each time it is back (274 respawns it), until the runes or the pack run out, then the bank.
 */
function grabWine(max: number): Step {
    let waitTicks = 0;
    let casts = 0;
    let waited = 0;
    return {
        label: 'telegrab',
        tick(p): StepResult {
            if (!isNear(p, MAGIC_PLACES.chaosTemple[0], MAGIC_PLACES.chaosTemple[1], 8)) return 'fail';
            if (waitTicks > 0 && (--waitTicks > 0 || p.delayed || p.target !== null)) return 'run';
            const end = (): StepResult => {
                const r = casts > 0 ? 'done' : 'fail';
                casts = 0;
                waited = 0;
                return r;
            };
            if (casts >= max || freeSlots(p) === 0 || carried(p, Items.LAW_RUNE) === 0 || (carried(p, Items.AIR_RUNE) === 0 && !wears(p, Items.STAFF_OF_AIR))) return end();
            const wine = wineOnTable(p);
            if (!wine) {
                // (taken: by the bot's last grab, or another player; it is back in a while)
                waitTicks = 5;
                waited += 5;
                return waited > 600 ? end() : 'run';
            }
            const com = Component.getId('magic:telekinetic_grab');
            const spell = com === -1 ? undefined : Component.get(com);
            if (!spell || !p.isComponentVisible(spell)) return end();
            p.clearPendingAction();
            p.setInteraction(Interaction.ENGINE, wine, ServerTriggerType.APOBJT, com);
            casts++;
            waitTicks = 6 + Math.floor(Math.random() * 6);
            return 'run';
        }
    };
}

function wineOnTable(p: Player): Obj | null {
    const id = obj('wine_of_zamorak');
    const [x, z, level] = MAGIC_PLACES.wine;
    const zone = World.gameMap.getZone(x, z, level);
    if (!zone) return null;
    for (const o of zone.getAllObjsSafe()) if (o.type === id && o.x === x && o.z === z && (o.receiver64 === Obj.NO_RECEIVER || o.receiver64 === p.hash64)) return o;
    return null;
}

/** the wine of Zamorak grabbed with Telekinetic Grab in the Asgarnian chaos temple, banked at Falador West */
function telegrab(): ErrandPlan {
    return {
        kind: 'Telegrab',
        key: 'wine',
        at: MAGIC_PLACES.chaosTemple,
        stat: PlayerStat.MAGIC,
        ok(p) {
            return level(p, PlayerStat.MAGIC) >= 33 && p.combatLevel >= 25 && owned(p, Items.LAW_RUNE) >= 5 && (owned(p, Items.AIR_RUNE) >= 5 || owned(p, Items.STAFF_OF_AIR) > 0);
        },
        build(p) {
            const n = Math.min(20, owned(p, Items.LAW_RUNE));
            return [
                bank({ near: MAGIC_PLACES.faladorWestBank, keep: () => [Items.LAW_RUNE, Items.AIR_RUNE], withdraw: [[Items.LAW_RUNE, n, true], [Items.AIR_RUNE, wears(p, Items.STAFF_OF_AIR) ? 0 : n]] }),
                line('wine-go'),
                walk(MAGIC_PLACES.templeDoor, 2, 2500, 'to the temple'),
                // (its door, shut: opened; then in by the altar, the table in sight)
                either(q => locNearIs(q, 'loc_1530', 2941, 3517), clickLoc(['loc_1530'], 'Open', [2941, 3517, 0], { radius: 2, wait: 3, max: 2 })),
                walk(MAGIC_PLACES.chaosTemple, 1, 200, 'in the temple'),
                grabWine(n),
                line('wine-done', 0.3),
                bank({ near: MAGIC_PLACES.faladorWestBank, keep: () => [] })
            ];
        },
        again: (p, rounds) => rounds < 2 && owned(p, Items.LAW_RUNE) >= 5
    };
}

/** every run, by its key */
export const MAGIC_RUNS: Readonly<Record<string, () => ErrandPlan>> = { boneRun, superheat, enchant, telegrab };

export function magicRunTask(key: string): ErrandTask | null {
    const make = MAGIC_RUNS[key];
    return make ? new ErrandTask(make()) : null;
}

/** a pick of a bot that may go on one goes to one this often (rare: they need the runes, the jewellery, the levels) */
export const MAGIC_RUN_SHARE = 0.04;

/** the planner's offer (port/BotD2Picks): one of the runs this bot may start now, MAGIC_RUN_SHARE of its picks; else null */
export function magicRunFor(p: Player, roll: number = Math.random()): ErrandTask | null {
    if (roll >= MAGIC_RUN_SHARE) return null;
    const open: string[] = [];
    for (const [k, make] of Object.entries(MAGIC_RUNS)) {
        const plan = make();
        if (plan.members && !isMembersWorld()) continue;
        if (!withinRange(p, plan.at)) continue;
        if (!plan.ok || plan.ok(p)) open.push(k);
    }
    if (open.length === 0) return null;
    // (the bone run, open to every fighter of 30+, half the weight of the runs that need their runes and items)
    const weights = open.map(k => (k === 'boneRun' ? 0.5 : 1));
    let x = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < open.length; i++) if ((x -= weights[i]) <= 0) return magicRunTask(open[i]);
    return magicRunTask(open[open.length - 1]);
}
