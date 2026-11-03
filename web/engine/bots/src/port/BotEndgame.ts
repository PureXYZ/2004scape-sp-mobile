/**
 * port (bots ideas, round 1, Track A: the period endgame) the veterans' trips
 * to 274's endgame spots, offered by the planner's Track D2 block (port/BotD2Picks, after the Wilderness trips):
 *   - who: a levelling bot with the bosser trait (its own seed 'a-bosser': 0.6 of names), not a newcomer; a spot by its
 *     levels and its seeded taste ('a-endgame-taste': dragons, demons or hounds);
 *   - how often: ENDGAME_SHARE of an eligible bosser's picks, at most one start per START_GAP of play;
 *   - the entry tickets (A1): FOOD_GATE pieces of food that heal 12 or more owned (it carries 15-20; without them no trip),
 *     the anti-dragon shield (the Duke's real talk, port/BotWildTrips' step), the dusty key (Velrak's errand first,
 *     port/BotVelrak: the key door is BotAction's, the key used on it), the prayer recharged at a real altar before a demon
 *     spot when its points are down (Pray-at; potions only if owned: none are conjured);
 *   - the solo spots (A2): Taverley's blue dragons, hellhounds, black demons and black dragons behind the dusty-key door,
 *     the Heroes' Guild's blue dragon, the Edgeville dungeon's black demons (the Wilderness's three are port/BotWildTrips'
 *     WILD_SPOTS: the Demonic Ruins, the deep dungeon's fire giants, the red dragons), each with its capacity;
 *   - the fight: a CombatTask held on the spot (its eating, looting and walking), Protect from Melee pressed against the
 *     demons while it fights (the prayer tab's button: 274 drains the points), over when its food is down to 2 with its
 *     Hitpoints under half, its prayer out (demons), its pack full, its time up (20-40 min), or it died (copied from
 *     port/BotWildTrips: a bot back at Lumbridge's spawn never walks back to its death spot);
 *   - the drop moment (A9): its own kill's notable drop (rune, dragon, a half key, 10k+) said ("rune chain!!"; a dragon
 *     item always), and bots within 15 tiles say gz (port/BotDropSale records what it picked up, for its sale stints).
 * Every bot on a trip carries the role 'bosser' (port/BotEndgameCore). Every click is a client's; every drop the game's.
 */
import type Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import World from '#/engine/World.js';
import { Items, Locations } from '#/engine/bot/BotKnowledge.js';
import { countItem, getBaseLevel, walkTo } from '#/engine/bot/BotAction.js';
import type { SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import { CombatTask, combatWeaponFor } from '#/engine/bot/tasks/CombatTask.js';
import { act, bank, clickLoc, fight, obj, owned, soft, talk, walk, when, withinRange, type At, type ErrandPlan, type ErrandTask, type Step } from '#/engine/bot/tasks/ErrandTask.js';
import { dungeonLeg } from '#/engine/bot/port/BotDungeons.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { stripForWilderness } from '#/engine/bot/port/BotGear.js';
import { bankDragonShield, bankWornRares, twoHanderBest, wearDragonShield } from '#/engine/bot/port/BotWildTrips.js';
import { BosserErrand, emitEndgameEvent, endgameOfferScale, lastEndgameStart, tripsAt } from '#/engine/bot/port/BotEndgameCore.js';
import { deathCheck, fightOver, fightWatcher, foodIds, foodWithdraw, goodFoodCarried, goodFoodOwned, protectionsOff, sayEndgame, sayStep, whileAlive, FOOD_GATE, FOOD_CARRY } from '#/engine/bot/port/BotEndgameFight.js';
import { velrakTask, mayAskVelrak } from '#/engine/bot/port/BotVelrak.js';
import { kbdLeaderTask, mayLeadKbd } from '#/engine/bot/port/BotEndgameTeams.js';
import { kqLeaderTask, mayLeadKq } from '#/engine/bot/port/BotKqTeams.js'; // (bots ideas, the KQ track)
import { dropAdvert, noteSold, saleDue, SALE_TICKS } from '#/engine/bot/port/BotDropSale.js';
import { BankstandTask } from '#/engine/bot/tasks/BankstandTask.js';
import type { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';

export { onEndgameEvent, endgameOfferScale, isBosser, BOSSER_ROLE, tripOf, tripsAt, tripLog, type EndgameEvent } from '#/engine/bot/port/BotEndgameCore.js';
export { dropMoment, dropStats, dropLog, isNotableDrop, isSaleLoot, sayEndgame, endgameLineStats, protectPrayer, goodFoodOwned, deathCheck, fightWatcher, ENDGAME_FOOD, FOOD_GATE, FOOD_CARRY } from '#/engine/bot/port/BotEndgameFight.js';

const level = (p: Player, stat: PlayerStat): number => getBaseLevel(p, stat);

// ── who bosses ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** the bosser trait's share of names (its own seed 'a-bosser'): not every veteran bossed in 2004 */
export const BOSSER_SHARE = 0.6;
export function hasBosserTrait(name: string): boolean {
    return seededRandom(nameSeed(name, 'a-bosser'))() < BOSSER_SHARE;
}

export type Taste = 'dragons' | 'demons' | 'hounds';
/** a bosser's taste for its spots (its own seed 'a-endgame-taste'): a weight 0.2-1 each */
export function endgameTaste(name: string): Readonly<Record<Taste, number>> {
    const rand = seededRandom(nameSeed(name, 'a-endgame-taste'));
    return { dragons: 0.2 + 0.8 * rand(), demons: 0.2 + 0.8 * rand(), hounds: 0.2 + 0.8 * rand() };
}

/** a levelling bot of a bosser's kind (a skiller only at combat 85+), not a newcomer, with the trait */
export function mayBoss(p: Player): boolean {
    const planner = p.botPlanner as PlannerKey;
    if (!isLevelling(planner) || isNewbie(p) || !hasBosserTrait(p.username)) return false;
    return planner !== 'skiller' || p.combatLevel >= 85;
}

// ── the gates ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** an eligible bosser's pick becomes an endgame trip this often (0.30: about 25-35 % of its time) */
export const ENDGAME_SHARE = 0.3;
/** at most one start per this much play (ticks: 45 minutes) */
export const START_GAP = 4500;
/** a trip's fight lasts this long at most (ticks: 20-40 minutes) */
export const TRIP_TICKS: readonly [number, number] = [2000, 4000];
let tripTicks: readonly [number, number] = TRIP_TICKS;
/** (tests) the fight's length (null: TRIP_TICKS) */
export function setEndgameTripTicksForTest(range: readonly [number, number] | null): void {
    tripTicks = range ?? TRIP_TICKS;
}

// ── the solo spots (A2) ───────────────────────────────────────────────────────────────────────────────────────────────

export interface SoloSpot {
    readonly key: string;
    readonly taste: Taste;
    readonly at: At;
    readonly npcs: readonly string[];
    readonly cap: number;
    /** behind Taverley's dusty-key door */
    readonly dusty?: boolean;
    /** the anti-dragon shield worn */
    readonly shield?: boolean;
    /** Protect from Melee (the demons; Prayer 43) */
    readonly prayer?: boolean;
    /** in the Wilderness (level 5): its rares to the bank, stripped as the Wilderness trips are */
    readonly wild?: boolean;
    readonly bank: At;
    readonly altar: At;
    fits(p: Player): boolean;
}

const meleeFit = (p: Player, combat: number): boolean => p.combatLevel >= combat && level(p, PlayerStat.ATTACK) >= 65 && level(p, PlayerStat.STRENGTH) >= 65 && level(p, PlayerStat.DEFENCE) >= 60;
const prayerFit = (p: Player): boolean => level(p, PlayerStat.PRAYER) >= 43;

export const SOLO_SPOTS: readonly SoloSpot[] = [
    // (round 1 fixes, A5: the shield spots not for a bot whose best weapon is a two-hander: no shield beside it, and its
    // fight's first walk went to a bank for it, the anti-dragon shield to the bank: port/BotWildTrips twoHanderBest)
    { key: 'taverley-blue', taste: 'dragons', at: Locations.TAVERLEY_BLUE_DRAGONS, npcs: ['blue_dragon'], cap: 2, dusty: true, shield: true, bank: Locations.FALADOR_WEST_BANK, altar: Locations.CHAOS_TEMPLE_ALTAR, fits: p => meleeFit(p, 85) && !twoHanderBest(p) },
    { key: 'taverley-hounds', taste: 'hounds', at: Locations.TAVERLEY_HELLHOUNDS, npcs: ['hellhound'], cap: 2, dusty: true, bank: Locations.FALADOR_WEST_BANK, altar: Locations.CHAOS_TEMPLE_ALTAR, fits: p => meleeFit(p, 85) },
    { key: 'taverley-demons', taste: 'demons', at: Locations.TAVERLEY_BLACK_DEMONS, npcs: ['black_demon'], cap: 2, dusty: true, prayer: true, bank: Locations.FALADOR_WEST_BANK, altar: Locations.CHAOS_TEMPLE_ALTAR, fits: p => meleeFit(p, 100) && prayerFit(p) },
    { key: 'taverley-black', taste: 'dragons', at: Locations.TAVERLEY_BLACK_DRAGONS, npcs: ['black_dragon'], cap: 1, dusty: true, shield: true, bank: Locations.FALADOR_WEST_BANK, altar: Locations.CHAOS_TEMPLE_ALTAR, fits: p => meleeFit(p, 110) && !twoHanderBest(p) },
    { key: 'heroes-blue', taste: 'dragons', at: Locations.HEROES_BLUE_DRAGON, npcs: ['blue_dragon'], cap: 1, shield: true, bank: Locations.FALADOR_WEST_BANK, altar: Locations.CHAOS_TEMPLE_ALTAR, fits: p => meleeFit(p, 85) && !twoHanderBest(p) },
    { key: 'edge-demons', taste: 'demons', at: Locations.EDGEVILLE_BLACK_DEMONS, npcs: ['black_demon'], cap: 1, prayer: true, wild: true, bank: Locations.EDGEVILLE_BANK, altar: Locations.VARROCK_CHURCH_ALTAR, fits: p => meleeFit(p, 100) && prayerFit(p) }
];

const stepMemo = new Map<string, SkillStep>();
/** the spot's fight (a step of its own: its monsters, an underground spot's way in) */
export function spotStep(spot: { key: string; at: At; npcs: readonly string[] }): SkillStep {
    let s = stepMemo.get(spot.key);
    if (!s) {
        s = { minLevel: 1, maxLevel: 99, action: 'combat', location: [spot.at[0], spot.at[1], spot.at[2]], levelBand: true, toolItemIds: [Items.ADAMANT_SCIMITAR ?? Items.MITHRIL_SCIMITAR], xpPerAction: 400, ticksPerAction: 4, successRate: 1, itemGained: Items.BONES, extra: { npcTypes: [...spot.npcs], hitsToKill: 12, dungeon: spot.at[1] > 6400 } };
        stepMemo.set(spot.key, s);
    }
    return s;
}

/** what the trips did (the report, the tests): offered, started by spot, the Duke's shields, the altar visits */
export const endgameStats = { asked: 0, offered: {} as Record<string, number>, shields: 0, altars: 0, noFood: 0, velrak: 0 };

/**
 * A walk to `at` that takes a dungeon's way in from the surface first (port/BotDungeons.dungeonLeg: its ladder, its
 * trapdoor), then walkTo's own (its doors, the key door with the key carried); fails after `maxTicks`.
 */
export function goTo(at: At, near = 3, maxTicks = 4000, label = 'go'): Step {
    let ticks = 0;
    const w = walk(at, near, maxTicks, label);
    return {
        label,
        tick(p, t) {
            if (at[1] > 6400 && p.z < 6400 && p.level === 0) {
                if (++ticks > maxTicks) {
                    ticks = 0;
                    return 'fail';
                }
                dungeonLeg(p, at[0], at[1], (x, z) => walkTo(p, x, z, 0));
                return 'run';
            }
            const r = w.tick(p, t);
            if (r !== 'run') ticks = 0;
            return r;
        }
    };
}

/** the anti-dragon shield (a bot with none asks the Duke, a real talk: every bot did Dragon Slayer), worn at the booth */
export function shieldSteps(back: At): Step[] {
    const shield = obj('antidragonbreathshield');
    return [
        when(
            q => owned(q, shield) === 0,
            talk('duke_of_lumbridge', [3211, 3220, 1], { answers: [1] }),
            act('shield', q => (countItem(q, shield) > 0 ? ((endgameStats.shields++, 'done')) : 'fail')),
            walk(back, 4, 3000, 'back')
        ),
        act('shield on', q => (wearDragonShield(q, shield) ? 'done' : 'fail'))
    ];
}

/** the prayer recharged at the altar (Pray-at) when its points are down, a bot with the level (`min`) */
export function altarSteps(altar: At, min = 43): Step {
    return when(
        q => level(q, PlayerStat.PRAYER) >= min && q.levels[PlayerStat.PRAYER] < q.baseLevels[PlayerStat.PRAYER],
        soft(clickLoc(['altar', 'chaosaltar'], 'Pray-at', altar, { radius: 4, max: 2, wait: 6 })),
        act('prayed', () => ((endgameStats.altars++, 'done')))
    );
}

/** a solo spot's trip (A2) */
export function soloTrip(spot: SoloSpot): ErrandPlan {
    const key = obj('dusty_key');
    const shield = obj('antidragonbreathshield');
    const plan: ErrandPlan = {
        kind: 'Endgame',
        key: spot.key,
        at: spot.at,
        members: true,
        ok(p) {
            const step = spotStep(spot);
            return combatWeaponFor(p, step) !== null && goodFoodOwned(p) >= FOOD_GATE && (!spot.dusty || owned(p, key) > 0);
        },
        build(p) {
            const length = tripTicks[0] + Math.floor(Math.random() * (tripTicks[1] - tripTicks[0]));
            const carry = FOOD_CARRY[0] + Math.floor(Math.random() * (FOOD_CARRY[1] - FOOD_CARRY[0] + 1));
            const step = spotStep(spot);
            const death = deathCheck();
            const watcher = fightWatcher(spot.prayer ? 'melee' : null, spot.key);
            let started = -1;
            const died = (q: Player): boolean => {
                const d = death.died(q);
                const task = boundTasks.get(plan);
                if (d && task && !task.died) {
                    task.died = true;
                    emitEndgameEvent(q, 'bossDeath', { spot: spot.key });
                }
                return d;
            };
            const way: Step[] = [
                bank({ near: spot.bank, keep: () => [key, shield, ...foodIds()], withdraw: q => [...foodWithdraw(carry)(q), [key, spot.dusty ? 1 : 0, spot.dusty], [shield, spot.shield ? 1 : 0]] }),
                act('food', q => (goodFoodCarried(q) >= Math.min(FOOD_GATE, carry) ? 'done' : ((endgameStats.noFood++, 'fail'))))
            ];
            if (spot.wild) {
                way.push(
                    act('strip', q => {
                        stripForWilderness(q);
                        return 'done';
                    }),
                    bankWornRares()
                );
            }
            if (spot.shield) way.push(...shieldSteps(spot.bank));
            if (spot.prayer) way.push(altarSteps(spot.altar));
            way.push(
                sayStep(`eg-go-${spot.taste}`, 0.4),
                goTo(spot.at, 6, 5000, 'to the spot'),
                act('start', () => {
                    started = World.currentTick;
                    return 'done';
                })
            );
            // (round 1 fixes, A1: the death looked for from the first step, the way there and home step by step: a bot
            // killed on the way respawned at Lumbridge and walked to the spot again, and one killed on the way home walked
            // back to its bank by its death spot)
            const steps: Step[] = whileAlive(died, ...way);
            steps.push(
                soft(
                    fight(
                        () => {
                            const t = new CombatTask(step, PlayerStat.STRENGTH);
                            t.holdStep = true;
                            return t;
                        },
                        q => died(q) || (started >= 0 && World.currentTick - started >= length) || fightOver(q, spot.prayer === true),
                        length + 600,
                        q => {
                            if (!died(q)) watcher.watch(q);
                        }
                    )
                ),
                act('over', q => {
                    watcher.end(q);
                    if (!died(q)) protectionsOff(q);
                    return 'done';
                }),
                ...whileAlive(
                    died,
                    act('prayers off', q => (protectionsOff(q) ? 'run' : 'done')),
                    // (round 1 fixes, A7: the line's kind as the fight ended, not as the trip began with its pack full)
                    act('say eg-done', q => ((sayEndgame(q, goodFoodCarried(q) <= 2 ? 'eg-food-out' : 'eg-done', 0.3), 'done'))),
                    soft(walk(spot.bank, 4, 5000, 'back to the bank')),
                    bank({ near: spot.bank }),
                    ...(spot.shield ? [bankDragonShield(shield)] : [])
                )
            );
            return steps;
        }
    };
    return plan;
}

/** a solo spot's trip task (the offer's; the tests') */
export function soloTripTask(key: string): BosserErrand | null {
    const spot = SOLO_SPOTS.find(s => s.key === key);
    if (!spot) return null;
    return bindTrip(soloTrip(spot), 'solo');
}

/** the plan's own task (its death flag) */
export function bindTrip(plan: ErrandPlan, kind: 'solo' | 'wild' | 'kbd' | 'kq' | 'arena'): BosserErrand {
    const t = new BosserErrand(plan, kind);
    boundTasks.set(plan, t);
    return t;
}
const boundTasks = new WeakMap<ErrandPlan, BosserErrand>();

// ── the offer ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** the offers on (a staged test of another feature turns them off) */
let offersOn = true;
export function setEndgameOffersForTest(on: boolean): void {
    offersOn = on;
}

/** the spots that suit the bot now (its levels, its key, the capacities, within reach of its bank) */
export function openSpots(p: Player): SoloSpot[] {
    return SOLO_SPOTS.filter(s => s.fits(p) && tripsAt(s.key) < s.cap && withinRange(p, s.bank, 400));
}

/** a weighted draw of one of `spots` by the bot's taste */
function byTaste<T extends { taste: Taste }>(name: string, spots: readonly T[]): T | null {
    if (spots.length === 0) return null;
    const taste = endgameTaste(name);
    let roll = Math.random() * spots.reduce((a, s) => a + taste[s.taste], 0);
    for (const s of spots) {
        roll -= taste[s.taste];
        if (roll < 0) return s;
    }
    return spots[spots.length - 1];
}

/** may this bot start an endgame trip now (its trait, its kind, the gap since its last, the food gate, a members world)? */
export function mayStartEndgame(p: Player): boolean {
    if (!offersOn || !isMembersWorld() || !mayBoss(p) || p.combatLevel < 85) return false;
    if (World.currentTick - lastEndgameStart(p.username) < START_GAP) return false;
    if (wildernessLevelAt(p.x, p.z) > 0) return false;
    return goodFoodOwned(p) >= FOOD_GATE;
}

/**
 * The planner's offer (port/BotD2Picks, after the Wilderness trips): an eligible bosser, ENDGAME_SHARE of its picks (its
 * goals' scale), to a solo spot by its taste; a Taverley spot without the dusty key is Velrak's errand first (once in its
 * life); else null.
 */
export function endgameFor(p: Player, roll?: number): ErrandTask | null {
    endgameStats.asked++;
    // (the dice only for an eligible bosser: no other bot's picks draw one more number than before)
    if (!mayStartEndgame(p) || (roll ?? Math.random()) >= ENDGAME_SHARE * endgameOfferScale(p)) return null;
    const open = openSpots(p);
    // (A3: the KBD, a team's, among them by its taste for dragons: no team now, the bar, its gap)
    const kbd = mayLeadKbd(p) ? [{ key: 'kbd', taste: 'dragons' as Taste }] : [];
    // ---- (bots ideas, the KQ track: A4) the Kalphite Queen, a team's, among them by its taste for demons (the big beasts):
    // no team now, the world's last attempt 4 hours of play ago, the bar, 3 more of it free online (port/BotKqTeams
    // mayLeadKq: no dice; an ineligible bosser's draw is as before) ----
    const kq = mayLeadKq(p, q => hasBosserTrait(q.username)) ? [{ key: 'kq', taste: 'demons' as Taste }] : [];
    const pick = byTaste(p.username, [...open, ...kbd, ...kq]);
    if (pick?.key === 'kq') {
        endgameStats.offered.kq = (endgameStats.offered.kq ?? 0) + 1;
        return kqLeaderTask(q => hasBosserTrait(q.username));
    }
    // ---- end of the KQ track's offer ----
    if (pick?.key === 'kbd') {
        endgameStats.offered.kbd = (endgameStats.offered.kbd ?? 0) + 1;
        return kbdLeaderTask(shieldSteps, q => hasBosserTrait(q.username));
    }
    const spot = pick as SoloSpot | null;
    if (!spot) return null;
    if (spot.dusty && owned(p, obj('dusty_key')) === 0) {
        if (!mayAskVelrak(p)) {
            // (no key and no errand now: a spot without the key, else nothing)
            const keyless = byTaste(p.username, open.filter(s => !s.dusty));
            return keyless ? offer(keyless) : null;
        }
        endgameStats.velrak++;
        return velrakTask();
    }
    return offer(spot);
}

function offer(spot: SoloSpot): ErrandTask {
    endgameStats.offered[spot.key] = (endgameStats.offered[spot.key] ?? 0) + 1;
    return bindTrip(soloTrip(spot), 'solo');
}

/** (the plan's bound task: its death flag, set by the plan's own check) */
export function boundTaskOf(plan: ErrandPlan): BosserErrand | null {
    return boundTasks.get(plan) ?? null;
}

// ── drop sales (A9) ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The planner's offer of a sale stint (port/BotD2Picks, after the endgame's): a bot with SALE_MIN of its own endgame loot
 * still owned (port/BotDropSale), SALE_SHARE of its picks, at most once per SALE_GAP: a BankstandTask in its own-drops
 * mode at its nearest trade bank for 10-25 minutes; else null.
 */
export function dropSaleFor(p: Player, roll?: number): BotTask | null {
    if (!offersOn || p.is_bot !== true) return null;
    const stock = saleDue(p, roll);
    if (!stock) return null;
    return dropSaleTask(stock);
}

/** a sale stint of this stock (the offer's; the tests') */
export function dropSaleTask(stock: ReadonlyMap<number, number>): BotTask {
    const ticks = SALE_TICKS[0] + Math.floor(Math.random() * (SALE_TICKS[1] - SALE_TICKS[0]));
    return new BankstandTask({ name: 'DropSale', stock, ticks, advert: (s, priceOf) => dropAdvert(s, priceOf), sold: noteSold });
}
