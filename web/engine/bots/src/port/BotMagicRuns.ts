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
import { getBaseLevel, countItem, interactHeldOp, interactSpellOnHeld, isNear } from '#/engine/bot/BotAction.js';
import { CombatTask, combatWeaponFor, fitToFight } from '#/engine/bot/tasks/CombatTask.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { ErrandTask, act, bank, clickLoc, either, fight, freeSlots, gather, heldOp, obj, owned, pause, say, soft, walk, withinRange, type At, type ErrandPlan, type Step, type StepResult } from '#/engine/bot/tasks/ErrandTask.js';
import LocType from '#/cache/config/LocType.js';
// ---- (bots ideas, Track B: A6, the wine crowd) ----
import { walkTo } from '#/engine/bot/BotAction.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { claimStandTile, releaseStandTile } from '#/engine/bot/port/BotTiles.js';
import { scheduleInTicks } from '#/engine/bot/port/BotSchedule.js';
import { noteRivalry, sayLootLine } from '#/engine/bot/port/BotLoot.js';
// ---- end of Track B's (ideas) block ----
// ---- (bots ideas, round 1's left-overs: T1, T2) the grab's human moment; the way out by the temple's door ----
import { botReactionTicks } from '#/engine/bot/port/BotTiming.js';
import { when } from '#/engine/bot/tasks/ErrandTask.js';
import { isApproached } from '#/engine/GameMap.js';
// ---- end of the left-overs' block ----

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
/** (bots ideas, Track B: A6) 274's worn slots of the weapon and the shield */
const WEAPON_SLOT = 3;
const SHIELD_SLOT = 5;

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

/** (bots ideas, round 1, the fixes: B3) the grab's step, its temple tile given back however the stint ends */
type WineStep = Step & { release(p: Player): void };

/**
 * The wine telegrabbed off the chaos temple's table as a player's client casts it (OpObjTHandler: the spell's component on
 * the ground item), each time it is back (274 respawns it), until the runes or the pack run out, then the bank.
 * (bots ideas, Track B: A6, the wine crowd) from a tile of its own in the temple (a crowd of grabbers stood on one), until
 * its stint is over; each cast's outcome read from its pack (a wine more: its grab landed; the runes gone and no wine:
 * another's landed first, 274's "Too late - it's gone!"): a lost grab now and then gets a word, and the winner answers.
 */
function grabWine(max: number, stint = 0): WineStep {
    let waitTicks = 0;
    let casts = 0;
    let waited = 0;
    // ---- (bots ideas, Track B: A6) the stint's end, its own tile, the last cast's runes and wines ----
    let until = -1;
    let tile: [number, number] | null = null;
    let cast: { laws: number; wines: number; at: number } | null = null;
    // ---- end of Track B's (ideas) block ----
    // (bots ideas, round 1's left-overs: T1) the tick it clicks on the wine it saw come back (-1: none seen yet); (T2) its
    // grabs in a row that never ran
    let clickAt = -1;
    let unreached = 0;
    return {
        label: 'telegrab',
        tick(p): StepResult {
            // (round 1's left-overs: T2: and in a crowd's stint off the temple's floor, out of its walls however it got
            // there: no grab at the table through a wall, its tile inside out of its reach while the door is shut; over,
            // as out of the temple)
            if (!isNear(p, MAGIC_PLACES.chaosTemple[0], MAGIC_PLACES.chaosTemple[1], 8) || (stint > 0 && !onTempleFloor(p))) {
                wineEnds['left the temple'] = (wineEnds['left the temple'] ?? 0) + 1;
                return 'fail';
            }
            // (round 1's left-overs: T1) the spell's own hold (its p_delays; its target the wine until it runs), then on
            if (waitTicks > 0) {
                waitTicks--;
                return 'run';
            }
            if (p.delayed || (cast !== null && p.target !== null && World.currentTick - cast.at < 20)) return 'run';
            const end = (why = 'end'): StepResult => {
                const r = casts > 0 ? 'done' : 'fail';
                // (bots ideas, Track B: A6) why a stint ended, for the report (wineEnds)
                wineEnds[`${why}${casts > 0 ? '' : ' (no cast)'}`] = (wineEnds[`${why}${casts > 0 ? '' : ' (no cast)'}`] ?? 0) + 1;
                casts = 0;
                waited = 0;
                // ---- (bots ideas, Track B: A6) ----
                until = -1;
                cast = null;
                if (tile) releaseStandTile(p);
                tile = null;
                // ---- end of Track B's (ideas) block ----
                clickAt = -1;
                unreached = 0;
                return r;
            };
            // ---- (bots ideas, Track B: A6) the last cast's outcome; the stint's end; a tile of its own ----
            const now = World.currentTick;
            if (cast) {
                const wines = carried(p, obj('wine_of_zamorak'));
                if (wines > cast.wines) noteWine(p, 'won', now);
                else if (carried(p, Items.LAW_RUNE) < cast.laws) noteWine(p, 'lost', now);
                // (round 1's left-overs: T2) a grab that never ran (its runes kept, no wine: "I can't reach that!"): three
                // in a row and it stops trying
                else if (++unreached >= 3) {
                    cast = null;
                    return end('no reach');
                }
                if (wines > cast.wines || carried(p, Items.LAW_RUNE) < cast.laws) unreached = 0;
                cast = null;
            }
            if (stint > 0) {
                if (until < 0) until = now + stint;
                if (now >= until) return end('stint over');
                if (!tile) {
                    const [cx, cz, cl] = MAGIC_PLACES.chaosTemple;
                    // (round 1's left-overs: T2: and one the grab reaches the table from, as the game asks: within the
                    // spell's 10 and in sight of it (the engine's approach test); from the temple's east end, behind its
                    // altar, the grab got "I can't reach that!": a stint of 40 casts and no wine in the m100 probe run)
                    tile = claimStandTile(p, cx, cz, cl, WINE_TILE_RANGE, (x, z) => TEMPLE_TILES.has(`${x},${z}`) && grabsFrom(x, z)) ?? [p.x, p.z];
                }
                // (round 1's left-overs: T2: no grab on the way to its tile: with its walk queued it cast from where it was)
                if (p.x !== tile[0] || p.z !== tile[1]) {
                    if (!p.hasWaypoints()) walkTo(p, tile[0], tile[1]);
                    waitTicks = 1;
                    clickAt = -1;
                    return 'run';
                }
            }
            // ---- end of Track B's (ideas) block ----
            if (casts >= max) return end('casts');
            if (freeSlots(p) === 0) return end('pack full');
            if (carried(p, Items.LAW_RUNE) === 0) return end('no laws');
            if (carried(p, Items.AIR_RUNE) === 0 && !wears(p, Items.STAFF_OF_AIR)) return end('no air');
            const wine = wineOnTable(p);
            if (!wine) {
                // (taken: by the bot's last grab, or another player; it is back in a while. Round 1's left-overs, T1: it
                // watches the table, as a grabber does, each tick: it looked every 5 ticks from 6-11 after its cast, so
                // its grabs came 51-55 ticks apart, the respawn's 48 and one of five steps: 15-22 % of two in a row alike)
                clickAt = -1;
                waited++;
                return waited > 600 && stint <= 0 ? end('no wine') : 'run';
            }
            // (round 1's left-overs: T1) the wine back: the grab clicked a person's moment after it is seen (wineReaction);
            // gone meanwhile (another's grab landed), no click: it waits for the next
            if (clickAt < 0) clickAt = now + wineReaction(p);
            if (now < clickAt) return 'run';
            clickAt = -1;
            const com = Component.getId('magic:telekinetic_grab');
            const spell = com === -1 ? undefined : Component.get(com);
            if (!spell || !p.isComponentVisible(spell)) return end('no spell');
            // (bots ideas, Track B: A6: a crowd's grabber recasts a person's moment after it sees the wine back)
            cast = { laws: carried(p, Items.LAW_RUNE), wines: carried(p, obj('wine_of_zamorak')), at: now };
            p.clearPendingAction();
            p.setInteraction(Interaction.ENGINE, wine, ServerTriggerType.APOBJT, com);
            casts++;
            waitTicks = 1;
            return 'run';
        },
        // ---- (bots ideas, round 1, the fixes: B3) the errand's end (WineStint): its own tile given back ----
        release(p) {
            if (tile) releaseStandTile(p);
            tile = null;
            until = -1;
            cast = null;
            clickAt = -1;
            unreached = 0;
        }
        // ---- end of Track B's (ideas) block ----
    };
}

// ---- (bots ideas, round 1's left-overs: T1, T2) ----
/**
 * Ticks from the wine seen back on the table to the grab's click (a draw for a grabber only, on the library's dice): the
 * spell and the jug clicked as the next round of a thing done over and over (BotTiming's 'next': the persona's reaction,
 * its slow clicks, now and then a look away), the moment the eye is on the table again (0-2 ticks: the chat, the pack,
 * the monks), a hesitation now and then (WINE_HESITATE: 2-9 ticks more) and a slip (WINE_SLIP: the jug missed, the spell
 * clicked again: 2-5 ticks more). The humanlike report's H18 counts two grabs in a row the same apart: the respawn is the
 * game's, so the spread is all the grabber's (about 5 % of pairs alike over the personas; median 7 ticks, a mean of 10).
 * The quickest of a crowd still grabs first, and one within the spell's 2 ticks of it is "Too late" (LV13).
 */
function wineReaction(p: Player): number {
    let ticks = botReactionTicks(p, 'next') + Math.floor(Math.random() * 3);
    if (Math.random() < WINE_HESITATE) ticks += 2 + Math.floor(Math.random() * 8);
    if (Math.random() < WINE_SLIP) ticks += 2 + Math.floor(Math.random() * 4);
    return ticks;
}
const WINE_HESITATE = 0.15;
const WINE_SLIP = 0.06;
/** Tests only: a grabber's reaction draw (the scene's dice) */
export const wineReactionForTest = (p: Player): number => wineReaction(p);

/** a grab from (x, z) reaches the wine's table: within the spell's approach range (274's 10) and in sight of it */
function grabsFrom(x: number, z: number): boolean {
    const [wx, wz, level] = MAGIC_PLACES.wine;
    return Math.max(Math.abs(x - wx), Math.abs(z - wz)) <= 10 && isApproached(level, x, z, wx, wz, 1, 1, 1, 1);
}

/** on the temple's own floor: inside its walls (TEMPLE_FLOOR) */
function onTempleFloor(p: Player): boolean {
    return p.level === MAGIC_PLACES.chaosTemple[2] && TEMPLE_FLOOR.has(`${p.x},${p.z}`);
}
/**
 * the temple's floor: every tile a walk from its middle reaches with the door shut (the map read in the 274 world
 * by a probe), the four out of the table's sight too (2939,3518, 2935,3517,
 * 2936,3517, 2935,3513): a grabber walks over them to its tile. TEMPLE_TILES is where a grabber may stand, and may leave
 * those out; this is where it may be
 */
const TEMPLE_FLOOR: ReadonlySet<string> = new Set(
    [
        [2939, 3518],
        ...[2932, 2933, 2935, 2936, 2937, 2938, 2939, 2940].map(x => [x, 3517]),
        ...[2931, 2932, 2933, 2934, 2935, 2936, 2937, 2938, 2939].map(x => [x, 3516]),
        ...[2931, 2932, 2933, 2934, 2935, 2936].map(x => [x, 3515]),
        ...[2930, 2931, 2932, 2933, 2934, 2935, 2936].map(x => [x, 3514]),
        [2935, 3513]
    ].map(([x, z]) => `${x},${z}`)
);

/** the temple's door (shut: its closed form there) */
const TEMPLE_DOOR: At = [2941, 3517, 0];
const doorShut = (p: Player): boolean => locNearIs(p, 'loc_1530', TEMPLE_DOOR[0], TEMPLE_DOOR[1]);
const openDoor = (): Step => clickLoc(['loc_1530'], 'Open', TEMPLE_DOOR, { radius: 2, wait: 3, max: 2 });

/**
 * Out of the temple as a player leaves it, from its floor: the door opened from inside when shut (274 shuts a door 500
 * ticks after it was opened, so after a stint of 10-20 minutes it is), then a step out of it. The bank walk went from
 * inside, found no way through the shut door (the walking graph and the route search do not open it) and was rescue-
 * jumped: every Telegrab/stuck jump of the m100 runs (seeds 6 and 7, 5 of 5), from the temple's floor in its bank step.
 */
function leaveTemple(): Step {
    return when(onTempleFloor, either(doorShut, openDoor()), walk(MAGIC_PLACES.templeDoor, 1, 200, 'out of the temple'));
}
// ---- end of the left-overs' block ----

function wineOnTable(p: Player): Obj | null {
    const id = obj('wine_of_zamorak');
    const [x, z, level] = MAGIC_PLACES.wine;
    const zone = World.gameMap.getZone(x, z, level);
    if (!zone) return null;
    for (const o of zone.getAllObjsSafe()) if (o.type === id && o.x === x && o.z === z && (o.receiver64 === Obj.NO_RECEIVER || o.receiver64 === p.hash64)) return o;
    return null;
}

/** may it grab the wine: Telekinetic Grab's Magic, its laws and air (or an air staff) */
function mayGrab(p: Player): boolean {
    return level(p, PlayerStat.MAGIC) >= 33 && p.combatLevel >= 25 && owned(p, Items.LAW_RUNE) >= 5 && (owned(p, Items.AIR_RUNE) >= 5 || owned(p, Items.STAFF_OF_AIR) > 0);
}

/**
 * the wine of Zamorak grabbed with Telekinetic Grab in the Asgarnian chaos temple, banked at Falador West
 * (bots ideas, Track B: A6: a crowd's stint, 10-20 minutes of grabs from a tile of its own: wineCrowdFor)
 */
function telegrab(): WinePlan {
    const stint = WINE_STINT[0] + Math.floor(Math.random() * (WINE_STINT[1] - WINE_STINT[0] + 1));
    // (bots ideas, round 1, the fixes: B3) what its end puts back, however it comes (WineStint): the weapon and shield it
    // held before the staff, its temple tile
    let wieldAfter: number[] = [];
    let grab: WineStep | null = null;
    return {
        kind: 'Telegrab',
        key: 'wine',
        at: MAGIC_PLACES.chaosTemple,
        stat: PlayerStat.MAGIC,
        ok(p) {
            return mayGrab(p);
        },
        build(p) {
            // (bots ideas, Track B: A6: a stint's laws, up to 40)
            const n = Math.min(40, owned(p, Items.LAW_RUNE));
            // (bots ideas, Track B: A6: an air staff in its bank and too few air runes: the staff taken out and wielded for
            // the run's air; before, such a grabber came with neither, and 20 of 24 stints at 500 bots ended there)
            const staffOut = !wears(p, Items.STAFF_OF_AIR) && owned(p, Items.AIR_RUNE) < Math.min(n, 5) && owned(p, Items.STAFF_OF_AIR) > 0;
            const withdraw: (readonly [number, number, boolean?])[] = [[Items.LAW_RUNE, n, true], staffOut ? [Items.STAFF_OF_AIR, 1, true] : [Items.AIR_RUNE, wears(p, Items.STAFF_OF_AIR) ? 0 : n]];
            // (and after the stint what it held before, its weapon and shield, wielded again, the staff banked with the
            // wine: a fighter left with the staff in hand and its scimitar in the bank)
            const worn = p.getInventory(InvType.WORN);
            const heldBefore = staffOut ? [worn?.get(WEAPON_SLOT)?.id ?? -1, worn?.get(SHIELD_SLOT)?.id ?? -1].filter(id => id !== -1 && id !== Items.STAFF_OF_AIR) : [];
            wieldAfter = heldBefore;
            grab = grabWine(n, stint);
            return [
                bank({ near: MAGIC_PLACES.faladorWestBank, keep: () => [Items.LAW_RUNE, Items.AIR_RUNE, Items.STAFF_OF_AIR], withdraw }),
                ...(staffOut ? [heldOp(Items.STAFF_OF_AIR, 2, { wait: 2 })] : []),
                line('wine-go'),
                walk(MAGIC_PLACES.templeDoor, 2, 2500, 'to the temple'),
                // (its door, shut: opened; then in by the altar, the table in sight)
                either(doorShut, openDoor()),
                walk(MAGIC_PLACES.chaosTemple, 1, 200, 'in the temple'),
                grab,
                ...heldBefore.map(id => either(q => carried(q, id) > 0 && !wears(q, id), soft(heldOp(id, 2, { wait: 2 })))),
                leaveTemple(), // (round 1's left-overs: T2)
                line('wine-done', 0.3),
                bank({ near: MAGIC_PLACES.faladorWestBank, keep: () => [] })
            ];
        },
        // (bots ideas, Track B: A6: one stint)
        again: () => false,
        undo(p) {
            grab?.release(p);
            grab = null;
            const ids = wieldAfter;
            wieldAfter = [];
            wieldBack(p, ids);
        }
    };
}

// ---- (bots ideas, round 1, the fixes: B3: the wine stint's end) ----
/** the wine stint's plan: what its end puts back (WineStint) */
interface WinePlan extends ErrandPlan {
    undo(p: Player): void;
}

/** what it held before its air staff, wielded again from its pack (a moment later while it is delayed, a few tries) */
function wieldBack(p: Player, ids: readonly number[], tries = 5): void {
    const inv = p.getInventory(InvType.INV);
    const left = ids.filter(id => carried(p, id) > 0 && !wears(p, id));
    if (p.slot === -1 || !inv || left.length === 0) return;
    if (p.delayed) {
        if (tries > 0) scheduleInTicks(2, () => wieldBack(p, left, tries - 1));
        return;
    }
    for (const id of left) {
        for (let slot = 0; slot < inv.capacity; slot++) {
            if (inv.get(slot)?.id !== id) continue;
            interactHeldOp(p, inv, id, slot, 2);
            break;
        }
    }
}

/**
 * A wine stint as an errand whose end, however it comes (done, failed, switched away from, a logout's wind-down), puts
 * back what the stint took: the weapon and shield it held before its air staff, and its temple tile. The plan's own
 * steps wield them back only after a stint that went to its end: a failed walk or door, "left the temple", a rescan or a
 * logout left the staff in hand and its own weapon in the pack (for the next bank's keep list to deposit), and the tile
 * held. The class is made at its first use: no class extends ErrandTask while this module loads (an import cycle could
 * reach it before ErrandTask is made, as port/BotLootFactory notes for BotLoot).
 */
let WineStint: (new (plan: WinePlan) => ErrandTask) | null = null;
function wineStint(): ErrandTask {
    WineStint ??= class extends ErrandTask {
        private self: Player | null = null;
        override tick(player: Player): void {
            this.self = player;
            super.tick(player);
            if (super.isComplete(player)) this.undo();
        }
        override interrupt(): void {
            super.interrupt();
            this.undo();
        }
        override reset(): void {
            this.undo();
            super.reset();
        }
        private undo(): void {
            if (this.self) (this.plan as WinePlan).undo(this.self);
        }
    };
    return new WineStint(telegrab());
}
// ---- end of Track B's (ideas) block ----

/** every run, by its key */
export const MAGIC_RUNS: Readonly<Record<string, () => ErrandPlan>> = { boneRun, superheat, enchant, telegrab };

export function magicRunTask(key: string): ErrandTask | null {
    if (key === 'telegrab') return wineStint(); // (bots ideas, round 1, the fixes: B3)
    const make = MAGIC_RUNS[key];
    return make ? new ErrandTask(make()) : null;
}

/** a pick of a bot that may go on one goes to one this often (rare: they need the runes, the jewellery, the levels) */
export const MAGIC_RUN_SHARE = 0.04;

/** the planner's offer (port/BotD2Picks): one of the runs this bot may start now, MAGIC_RUN_SHARE of its picks; else null */
export function magicRunFor(p: Player, roll: number = Math.random()): ErrandTask | null {
    // ---- (bots ideas, Track B: A6) the wine crowd short of its number: a grabber's stint (telegrab's slice of the share) ----
    const crowd = wineCrowdFor(p);
    if (crowd) return crowd;
    // ---- end of Track B's (ideas) block ----
    if (roll >= MAGIC_RUN_SHARE) return null;
    const open: string[] = [];
    for (const [k, make] of Object.entries(MAGIC_RUNS)) {
        if (k === 'telegrab') continue; // (bots ideas, Track B: A6: offered by the crowd's number, wineCrowdFor)
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

// ---- (bots ideas, Track B: A6, the wine crowd and its rivalry) ----
// 274's wine of Zamorak respawns every 30 ticks on the temple's table; a hand's Take burns the taker and sets the monks on
// it, a Telekinetic Grab does not, and the first grab to land takes it ("Too late - it's gone!" for the others). The
// grabbers' number: clamp(round(N / 120), 1, 5) (1 at 100 online, 4 at 500, 5 at 1000); a bot that may grab (Magic 33,
// its laws and air) is offered a stint while fewer are there (half its picks, within the errands' range). After a lost
// grab 1 in 4 says a word (at most one in 3 minutes a bot), and the winner answers 3 times in 10. The texture of a newbie's
// hand-take (the research's last cut) is not built.

/** a grabber per this many bots online, and at most this many */
const WINE_PER = 120;
const WINE_MAX = 5;
/** a stint at the temple: 10-20 minutes */
const WINE_STINT: [number, number] = [1000, 2000];
/** a grabber's tile: within this of the temple's middle, one of the temple's own floor tiles (a walk from its middle
 * with the door shut reaches them; the map read in the 274 world by a probe): a tile
 * claimed outside, round by the open door, took the grabber more than 8 tiles off and its run failed. (Round 1's
 * left-overs: and only those a Telekinetic Grab at the table reaches from, cast from each in the 274 world by
 * a probe: from 2939,3518, 2935,3517, 2936,3517 and 2935,3513 every
 * grab is "I can't reach that!": loot.test's grabber, seed 1, spent its stint's 5 casts on 2935,3517 and came back with
 * no wine) */
const WINE_TILE_RANGE = 6;
const TEMPLE_TILES: ReadonlySet<string> = new Set(
    [
        ...[2932, 2933, 2937, 2938, 2939, 2940].map(x => [x, 3517]),
        ...[2931, 2932, 2933, 2934, 2935, 2936, 2937, 2938, 2939].map(x => [x, 3516]),
        ...[2931, 2932, 2933, 2934, 2935, 2936].map(x => [x, 3515]),
        ...[2930, 2931, 2932, 2933, 2934, 2935, 2936].map(x => [x, 3514])
    ].map(([x, z]) => `${x},${z}`)
);
/** a bot that may grab is offered a stint at this share of its picks while the crowd is short */
const WINE_OFFER = 0.5;
/** a lost grab's word (1 in 4, once in 3 minutes a bot); the winner's answer */
const WINE_LOST_LINE = 0.25;
const WINE_LINE_GAP = 300;
const WINE_WON_LINE = 0.3;
/** the grabbers counted at most this often */
const CROWD_EVERY = 25;

/** the grabbers the world wants at once, for this many bots online */
export function wineCrowdTarget(online: number): number {
    return Math.max(1, Math.min(WINE_MAX, Math.round(online / WINE_PER)));
}

let crowdSeen = { at: -Infinity, grabbers: 0, online: 0 };
/** the bots on a telegrab stint now, and the bots online (counted every CROWD_EVERY ticks) */
export function wineCrowd(): { grabbers: number; online: number } {
    const now = World.currentTick;
    if (now - crowdSeen.at >= CROWD_EVERY) {
        let grabbers = 0;
        let online = 0;
        for (const b of BotManager.activeBots()) {
            online++;
            if (BotManager.botFor(b)?.currentTask?.name.startsWith('Telegrab:')) grabbers++;
        }
        crowdSeen = { at: now, grabbers, online };
    }
    return crowdSeen;
}

/** (magicRunFor) a stint for a bot that may grab, while the crowd is short of its number; else null */
function wineCrowdFor(p: Player): ErrandTask | null {
    if (!withinRange(p, MAGIC_PLACES.chaosTemple)) return null;
    const crowd = wineCrowd();
    if (crowd.grabbers >= wineCrowdTarget(crowd.online) || !mayGrab(p)) return null;
    if (Math.random() >= (wineTestRates.offer ?? WINE_OFFER)) return null;
    crowdSeen.grabbers++;
    return wineStint();
}

/** why the stints ended (the humanlike report's LV12 detail) */
export const wineEnds: Record<string, number> = {};

/** every grab's outcome at the temple (the humanlike report: the crowd, the lost share) */
export const wineLog: { t: number; who: string; outcome: 'won' | 'lost'; grabbers: number }[] = [];
const lastWin = new Map<Player, number>();
const lastWord = new WeakMap<Player, number>();

/** a grab landed or lost: the log; a lost one's word now and then, the winner's answer */
function noteWine(p: Player, outcome: 'won' | 'lost', now: number): void {
    const near: Player[] = [];
    for (const [b, at] of lastWin) if (b.slot === -1 || now - at > 600) lastWin.delete(b);
    for (const b of BotManager.activeBots()) if (b !== p && Math.max(Math.abs(b.x - p.x), Math.abs(b.z - p.z)) <= 10 && BotManager.botFor(b)?.currentTask?.name.startsWith('Telegrab:')) near.push(b);
    if (wineLog.length < 20000) wineLog.push({ t: now, who: p.username, outcome, grabbers: near.length + 1 });
    if (outcome === 'won') {
        lastWin.set(p, now);
        return;
    }
    // the winner: the grabber near whose grab landed last (within 12 ticks)
    let winner: Player | null = null;
    for (const b of near) if (now - (lastWin.get(b) ?? -Infinity) <= 12 && (!winner || (lastWin.get(b) ?? 0) > (lastWin.get(winner) ?? 0))) winner = b;
    if (winner) noteRivalry(winner, p, 'wine');
    if (now - (lastWord.get(p) ?? -Infinity) < WINE_LINE_GAP || Math.random() >= (wineTestRates.lost ?? WINE_LOST_LINE)) return;
    if (!sayLootLine(p, 'wine-lost', { to: winner })) return;
    lastWord.set(p, now);
    if (winner && Math.random() < (wineTestRates.won ?? WINE_WON_LINE)) {
        const w = winner;
        scheduleInTicks(4 + Math.floor(Math.random() * 6), () => {
            if (w.slot !== -1) sayLootLine(w, 'wine-won', { to: p, kind: 'botreply' });
        });
    }
}

/** Tests only: the offer's share, a lost grab's word, the winner's answer (null: the game's). */
const wineTestRates: { offer?: number; lost?: number; won?: number } = {};
export function setWineRatesForTest(rates: typeof wineTestRates | null): void {
    for (const k of Object.keys(wineTestRates) as (keyof typeof wineTestRates)[]) delete wineTestRates[k];
    Object.assign(wineTestRates, rates ?? {});
}
// ---- end of Track B's (ideas) block ----
