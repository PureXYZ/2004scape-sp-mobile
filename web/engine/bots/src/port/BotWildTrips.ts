/**
 * port (the variety work, round 2, Track D2: WHERE-4, Wilderness levelling trips; 1-2 bots per 100
 * online)
 *
 * A bold, combat-capable levelling bot (its own trait, a seed of its own: about 1 name in 3) now and then trains in the
 * Wilderness, as 2004's did for the empty spawns: its rares banked first at Edgeville (a rare is never risked: W's note),
 * food from its bank, then north over the ditch to one of 274's Wilderness spots that suits its levels:
 *   - the skeletons by the ditch (level 5-10), the hill giants east (17), the hobgoblins (30) (the Graveyard of Shadows'
 *     zombies and the Dark Warriors' Fortress left out: their walls, the watchdog's jumps and "I can't reach that!");
 *   - coal at the skeleton mine (10), iron, mithril and adamant at the hobgoblins' mine (30) (the fixes: where 274's
 *     rocks are), the runite rocks (46);
 *   - the lesser demons (44) for combat 70+;
 *   - members: the green dragons (37, with the anti-dragon shield the Duke of Lumbridge gives anyone who did Dragon
 *     Slayer: asked for in a real talk when it has none). (The Wilderness agility course left out: AgilityTask there
 *     clicked its obstacles from where it could not reach them and its stuck checks jumped it, 37 in a 2-hour run.)
 * PKers may kill it (its items kept: the content overlay); a level-up or a near death there gets a line now and then
 * (lines2004-activities.json 'wild-...'). The trip ends after its time, back at the Edgeville bank. WT1 in the report.
 */
import type Player from '#/engine/entity/Player.js';
import InvType from '#/cache/config/InvType.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import { Items, Locations, SkillProgression, type SkillStep } from '#/engine/bot/BotKnowledge.js';
import { getBaseLevel, countItem } from '#/engine/bot/BotAction.js';
import { bankInvId, edibleFoodIds } from '#/engine/bot/tasks/BotTaskBase.js';
import ObjType from '#/cache/config/ObjType.js';
import { bankedId } from '#/engine/bot/port/BotInventoryCompat.js';
import { CombatTask, combatWeaponFor, fitToFight } from '#/engine/bot/tasks/CombatTask.js';
import { MiningTask } from '#/engine/bot/tasks/MiningTask.js';
import { AgilityTask } from '#/engine/bot/tasks/AgilityTask.js';
import { isRare } from '#/engine/bot/port/BotPrices.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { bestMeleeWeapon, stripForWilderness, wearCarried } from '#/engine/bot/port/BotGear.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import World from '#/engine/World.js';
import { ErrandTask, act, bank, fight, inner, obj, owned, say, soft, talk, walk, when, withinRange, type At, type ErrandPlan, type Step } from '#/engine/bot/tasks/ErrandTask.js';

const EDGEVILLE_BANK = Locations.EDGEVILLE_BANK as At;
/** where 274 puts a player who died (Lumbridge's courtyard) */
const LUMBRIDGE_SPAWN: At = [3222, 3218, 0];
const level = (p: Player, stat: PlayerStat): number => getBaseLevel(p, stat);

/** a combat spot in the Wilderness (a step of its own: its monsters, its weapon tier) */
function fightStep(x: number, z: number, npcs: string[], min: number, max: number, weapon: number): SkillStep {
    return { minLevel: min, maxLevel: max, action: 'combat', location: [x, z, 0], levelBand: true, toolItemIds: [weapon], xpPerAction: 300, ticksPerAction: 4, successRate: 1, itemGained: Items.BONES, extra: { npcTypes: npcs, hitsToKill: 8 } };
}
function mineStep(x: number, z: number, ore: number, min: number): SkillStep {
    const picks = (SkillProgression.MINING ?? []).find(s => s.action === 'mine')?.toolItemIds ?? [];
    return { minLevel: min, maxLevel: 99, action: 'mine', location: [x, z, 0], toolItemIds: picks, xpPerAction: 500, ticksPerAction: 6, successRate: 0.5, itemGained: ore };
}

/** a Wilderness spot: its kind, who it suits, its step */
interface WildSpot {
    key: string;
    kind: 'fight' | 'mine' | 'agility';
    members?: boolean;
    /** suits the bot now */
    fits(p: Player): boolean;
    step(): SkillStep;
    /** the anti-dragon shield first */
    shield?: boolean;
}

const spotsMemo = new Map<string, SkillStep>();
function memo(key: string, make: () => SkillStep): () => SkillStep {
    return () => {
        let s = spotsMemo.get(key);
        if (!s) spotsMemo.set(key, (s = make()));
        return s;
    };
}

export const WILD_SPOTS: readonly WildSpot[] = [
    { key: 'skeletons', kind: 'fight', fits: p => p.combatLevel >= 25 && p.combatLevel <= 55, step: memo('skeletons', () => fightStep(3016, 3592, ['skeleton_unarmed', 'skeleton_armed'], 20, 55, Items.IRON_SCIMITAR)) },
    { key: 'hillgiants', kind: 'fight', fits: p => p.combatLevel >= 38 && p.combatLevel <= 90, step: memo('hillgiants', () => fightStep(3302, 3655, ['giant'], 35, 90, Items.IRON_SCIMITAR)) },
    { key: 'hobgoblins', kind: 'fight', fits: p => p.combatLevel >= 40 && p.combatLevel <= 90, step: () => (SkillProgression.ATTACK ?? []).find(s => s.location === Locations.HOBGOBLINS_WILDERNESS)! },
    { key: 'lesserdemons', kind: 'fight', fits: p => p.combatLevel >= 70, step: memo('lesserdemons', () => fightStep(3015, 3850, ['lesser_demon'], 65, 99, Items.ADAMANT_SCIMITAR ?? Items.MITHRIL_SCIMITAR)) },
    // (the variety work, round 2, the fixes: the 274 map's rocks: the skeleton mine's 34 coal rocks (3009-3023, 3586-3598,
    // level 10: the skeletons', combat 22-25, so a miner of combat 50+, whom they leave be, 274's aggression stopping at
    // twice their level) and the hobgoblin mine's iron (13 rocks at 3088-3101, 3765-3769, level 32: combat 60+, past its
    // hobgoblins' aggression). The spots at 3020,3570 and 3080,3570 had no rock at all, and their miners stood there (H19's
    // WildMine@wild_1_5); the little mine by the road north of Edgeville (two iron) is the Edgeville PKers' patrol, where
    // half the first runs' miners died, D1)
    { key: 'coal', kind: 'mine', fits: p => level(p, PlayerStat.MINING) >= 30 && level(p, PlayerStat.MINING) < 60 && p.combatLevel >= 50, step: memo('coal', () => mineStep(3016, 3591, Items.COAL, 30)) },
    { key: 'iron', kind: 'mine', fits: p => level(p, PlayerStat.MINING) >= 15 && level(p, PlayerStat.MINING) < 45 && p.combatLevel >= 60, step: memo('iron', () => mineStep(3095, 3767, Items.IRON_ORE, 15)) },
    { key: 'mithril', kind: 'mine', fits: p => level(p, PlayerStat.MINING) >= 55 && p.combatLevel >= 35, step: memo('mithril', () => mineStep(3090, 3757, Items.MITHRIL_ORE, 55)) },
    { key: 'runite', kind: 'mine', fits: p => level(p, PlayerStat.MINING) >= 85 && p.combatLevel >= 50, step: () => (SkillProgression.MINING ?? []).find(s => s.location === Locations.MINE_RUNITE)! },
    // (the variety work, round 2, the fixes: not for a bot whose best weapon is a two-hander: no shield beside it, and its
    // fight's bank stop wields it again, the shield to the bank)
    { key: 'greendragons', kind: 'fight', members: true, shield: true, fits: p => p.combatLevel >= 65 && !twoHanderBest(p), step: memo('greendragons', () => fightStep(3098, 3814, ['green_dragon'], 60, 99, Items.MITHRIL_SCIMITAR ?? Items.IRON_SCIMITAR)) }
];

/** (the fixes) is the best melee weapon the bot owns (worn, carried, banked: CombatTask's pick) a two-hander? */
function twoHanderBest(p: Player): boolean {
    const bid = bankInvId();
    const best = bestMeleeWeapon(p, [p.getInventory(InvType.WORN), p.getInventory(InvType.INV), bid === -1 ? null : p.getInventory(bid)]);
    return best !== undefined && ObjType.get(best.id).wearpos2 === 5;
}

// ── who goes ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** a bold bot (its name's own seed: about 1 in 3), who trains in the Wilderness now and then */
export const BOLD_SHARE = 0.4;
export function isWildBold(name: string): boolean {
    return seededRandom(nameSeed(name, 'd2-wild-bold'))() < BOLD_SHARE;
}

/**
 * (the variety work, round 2, the fixes) a mining trip's weight among the open trips, a fight's 1: a miner at the ditch's
 * mines stands still for the Edgeville PKers (half the mining trips of the fixes' first runs ended in a death at a skill,
 * D1), a fighter fights back
 */
export const MINE_WEIGHT = 0.25;

/** a bold bot's pick goes to a trip this often (WT1: 1-2 levelling bots in the Wilderness per 100 online) */
export const WILD_SHARE = 0.26;

/** a trip's length in the Wilderness (ticks: 15-35 minutes) */
export const WILD_TICKS: readonly [number, number] = [1500, 3500];
let tripTicks: readonly [number, number] = WILD_TICKS;
/** (tests) a trip's length in the Wilderness (null: WILD_TICKS) */
export function setWildTripTicksForTest(range: readonly [number, number] | null): void {
    tripTicks = range ?? WILD_TICKS;
}

/** what the trips did (the report, the tests): picked, by spot; deaths are the report's (D1-D4) */
export const wildStats = { trips: {} as Record<string, number>, shields: 0 };

// ── the trip ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** its worn rares to the bank (as BotGear's bank stops take armour off: the bank's own inventory), at a bank */
function bankWornRares(): Step {
    return act('rares to the bank', p => {
        const worn = p.getInventory(InvType.WORN);
        const bid = bankInvId();
        const bankInv = bid === -1 ? null : p.getInventory(bid);
        if (!worn || !bankInv) return 'done';
        for (let s = 0; s < worn.capacity; s++) {
            const it = worn.get(s);
            if (it && isRare(it.id) && bankInv.add(it.id, it.count) === it.count) worn.delete(s);
        }
        return 'done';
    });
}

/**
 * (the variety work, round 2, the fixes) the anti-dragon shield on, at the bank: a two-hander in its hand to the bank first
 * (no shield beside one), an armour shield swapped out to the bank (wearCarried leaves armour on); true only when it is
 * worn after. The act ignored wearCarried's answer: the shield stayed in the pack over an armour shield, and went on beside
 * a two-hander, and the bot fought the dragons without it
 */
function wearDragonShield(p: Player, shield: number): boolean {
    const worn = p.getInventory(InvType.WORN);
    const bid = bankInvId();
    const bankInv = bid === -1 ? null : p.getInventory(bid);
    if (!worn) return false;
    if (worn.get(5)?.id === shield) return true;
    const held = worn.get(3);
    if (held && ObjType.get(held.id).wearpos2 === 5) {
        if (!bankInv || bankInv.add(bankedId(held.id), held.count) !== held.count) return false;
        worn.delete(3);
    }
    const on = worn.get(5);
    if (on) {
        if (!bankInv || bankInv.add(bankedId(on.id), on.count) !== on.count) return false;
        worn.delete(5);
    }
    wearCarried(p, shield);
    return worn.get(5)?.id === shield;
}

/** (the fixes) the anti-dragon shield back to the bank at the trip's end (the bot's own shield goes on at its next fight's bank stop) */
function bankDragonShield(shield: number): Step {
    return act('shield off', p => {
        const worn = p.getInventory(InvType.WORN);
        const bid = bankInvId();
        const bankInv = bid === -1 ? null : p.getInventory(bid);
        if (worn && bankInv && worn.get(5)?.id === shield && bankInv.add(shield, 1) === 1) worn.delete(5);
        return 'done';
    });
}

/** the trip's line at a level-up or a near death in the Wilderness (once each) */
function watcher(): (p: Player) => void {
    let lowSaid = false;
    let levels = -1;
    const sayNow = (p: Player, kind: string, chance: number): void => {
        const step = say(`wild-${kind}`, chance);
        step.tick(p, null as unknown as ErrandTask);
    };
    return p => {
        if (wildernessLevelAt(p.x, p.z) <= 0) return;
        let total = 0;
        for (let s = 0; s < p.baseLevels.length; s++) total += p.baseLevels[s];
        if (levels >= 0 && total > levels) sayNow(p, 'level', 0.5);
        levels = total;
        const hp = p.levels[PlayerStat.HITPOINTS] / Math.max(1, p.baseLevels[PlayerStat.HITPOINTS]);
        if (!lowSaid && hp < 0.3) {
            lowSaid = true;
            sayNow(p, 'close', 0.6);
        }
    };
}

function trip(spot: WildSpot): ErrandPlan {
    const food = (): number[] => edibleFoodIds();
    return {
        // (a mining trip's time is mining in the 2004 mix: its own kind, WildMine; a fight's WildTrip, combat)
        kind: spot.kind === 'mine' ? 'WildMine' : 'WildTrip',
        key: spot.key,
        at: [spot.step().location[0], spot.step().location[1], 0],
        members: spot.members,
        ok(p) {
            const step = spot.step();
            if (spot.kind === 'fight') return combatWeaponFor(p, step) !== null && fitToFight(p, step);
            if (spot.kind === 'mine') return step.toolItemIds.some(id => owned(p, id) > 0);
            return true;
        },
        build(p) {
            const length = tripTicks[0] + Math.floor(Math.random() * (tripTicks[1] - tripTicks[0]));
            const step = spot.step();
            const best = food().filter(id => owned(p, id) > 0).sort((a, b) => owned(p, b) - owned(p, a))[0] ?? -1;
            const pick = step.toolItemIds.find(id => owned(p, id) > 0) ?? -1;
            const shield = obj('antidragonbreathshield');
            let started = -1;
            // (the variety work, round 2, the fixes: a death ends the trip (its Hitpoints at 0, or back at Lumbridge's spawn
            // after the Wilderness): the trip's mining or fight walked a respawned bot back to where it died, and it died there
            // again, a death at a skill twice, D1)
            let died = false;
            let wasWild = false;
            const timeUp = (): boolean => {
                if (wildernessLevelAt(p.x, p.z) > 0) wasWild = true;
                if (started >= 0 && !died && (p.levels[PlayerStat.HITPOINTS] <= 0 || (wasWild && Math.max(Math.abs(p.x - LUMBRIDGE_SPAWN[0]), Math.abs(p.z - LUMBRIDGE_SPAWN[1])) <= 12))) died = true;
                return died || (started >= 0 && World.currentTick - started >= length);
            };
            const watch = watcher();
            const steps: Step[] = [
                // (rares to the bank; the trip's food and tool out)
                bank({ near: EDGEVILLE_BANK, keep: () => [best, pick, shield], withdraw: [[best, spot.kind === 'fight' ? 8 : 0], [pick, spot.kind === 'mine' ? 1 : 0, spot.kind === 'mine'], [shield, spot.shield ? 1 : 0]] }),
                // (the variety work, round 2, the fixes: track W2's strip at the booth, every trip's (a mining trip's too): its
                // show pieces to the bank, the plain pieces it owns on; then any rare left)
                act('strip', q => {
                    stripForWilderness(q);
                    return 'done';
                }),
                bankWornRares()
            ];
            if (spot.shield) {
                // (no shield of its own: the Duke gives one to anyone who did Dragon Slayer, every bot)
                steps.push(
                    when(q => owned(q, shield) === 0, talk('duke_of_lumbridge', [3211, 3220, 1], { answers: [1] }), act('shield', q => (countItem(q, shield) > 0 ? ((wildStats.shields++, 'done')) : 'fail')), walk(EDGEVILLE_BANK, 4, 3000, 'back north')),
                    act('shield on', q => (wearDragonShield(q, shield) ? 'done' : 'fail'))
                );
            }
            steps.push(
                say('wild-go', 0.4),
                act('start', () => {
                    started = World.currentTick;
                    return 'done';
                })
            );
            if (spot.kind === 'fight') {
                steps.push(
                    soft(
                        fight(
                            () => {
                                // (the spot holds for the trip: CombatTask holdStep)
                                const task = new CombatTask(step, PlayerStat.STRENGTH);
                                task.holdStep = true;
                                return task;
                            },
                            () => timeUp(),
                            length + 600,
                            watch
                        )
                    )
                );
            } else {
                steps.push(
                    soft(
                        inner(
                            () => {
                                if (spot.kind !== 'mine') return new AgilityTask(step);
                                // (the rocks hold for the trip: MiningTask holdStep)
                                const task = new MiningTask(step);
                                task.holdStep = true;
                                return task;
                            },
                            () => timeUp(),
                            length + 600,
                            spot.kind,
                            true
                        )
                    )
                );
            }
            // (home: the trip over, however it went; a walk that cannot get out leaves the bot to its next task's)
            // (after a death none: the next plan begins where 274 put it)
            steps.push(when(() => !died, say('wild-back', 0.3), soft(walk(EDGEVILLE_BANK, 4, 3000, 'back to Edgeville')), bank({ near: EDGEVILLE_BANK }), ...(spot.shield ? [bankDragonShield(shield)] : [])));
            return steps;
        }
    };
}

/** a trip's task to this spot (the tests'; the planner's through wildTripFor) */
export function wildTripTask(key: string): ErrandTask | null {
    const spot = WILD_SPOTS.find(s => s.key === key);
    return spot ? new ErrandTask(trip(spot)) : null;
}

/**
 * The planner's offer (port/BotD2Picks): a bold levelling bot (not a newcomer), WILD_SHARE of its picks, to a Wilderness
 * spot that suits it now (its levels, the world, its weapon or pickaxe); else null.
 */
export function wildTripFor(p: Player, roll: number = Math.random()): ErrandTask | null {
    if (roll >= WILD_SHARE || !isLevelling(p.botPlanner as PlannerKey) || isNewbie(p) || !isWildBold(p.username)) return null;
    const open = WILD_SPOTS.filter(s => (!s.members || isMembersWorld()) && s.fits(p) && withinRange(p, [s.step().location[0], s.step().location[1], 0]));
    const plans = open.map(trip).filter(plan => !plan.ok || plan.ok(p));
    if (plans.length === 0) return null;
    // (the variety work, round 2, the fixes: a fight four times as likely as a mine: the trips hold their spot now (WT1
    // 0.26-0.98 at 10x before), and a miner is a PKer's at the ditch's mines, a death at a skill, D1)
    const weight = (plan: ErrandPlan): number => (plan.kind === 'WildMine' ? MINE_WEIGHT : 1);
    let roll2 = Math.random() * plans.reduce((a, plan) => a + weight(plan), 0);
    let plan = plans[plans.length - 1];
    for (const candidate of plans) {
        roll2 -= weight(candidate);
        if (roll2 < 0) {
            plan = candidate;
            break;
        }
    }
    wildStats.trips[plan.key] = (wildStats.trips[plan.key] ?? 0) + 1;
    return new ErrandTask(plan);
}
