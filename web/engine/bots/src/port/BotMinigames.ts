// port (the variety work, round 2, Track M: members places and minigames, research
// the research): the planner's hook for the members world's far towns and
// minigames, and their catalogue.
//
//   - The far budget (port/BotOutings farBudget: 4 out at 100 online, about 3 there at a time; 13 at 250, 30 at 500): while fewer are out, a
//     levelling bot asked for its next plan is offered one now and then (OFFER_CHANCE), each bot at most once in
//     OUTING_GAP world ticks; the catalogue's weights pick which, among those it may do now, times how much the bot likes
//     the skill (its theme's, else its planner's weights: a fighter's are mostly its fights). A bot at Catherby's
//     lobsters stays (CB1).
//   - The catalogue: the minigames (the Fishing Trawler at Port Khazard, a crew of 4-8; the Brimhaven Agility Arena; the
//     Ranging Guild's competition) and the outings to the far towns (Yanille's ogres and watchmen, Karamja's jogres,
//     Burthorpe's soldiers, Rellekka's lobsters, Shilo's river: tasks/OutingTask with the skill's own task).
//   - A Trawler crew forming at Port Khazard takes the bots near Kandarin that may come, past the budget, up to its size
//     (tasks/TrawlerTask's crew); a bot holding an easy clue scroll from a kill may follow it (tasks/TreasureTrailTask),
//     under a cap of its own.
//   - An outing or a minigame under way is kept: a rescan's pick is the same task (BotPlayer switches only to another
//     kind), so a plan's end does not cut it short; it ends on its own.
// No staging round the human: every visit comes from the bots' own plans.
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import type { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';
import { PlayerStat, getBaseLevel, hasItem, countItem } from '#/engine/bot/BotAction.js';
import { Items, Locations, OUTING_STEPS, SkillProgression, type SkillStep } from '#/engine/bot/BotKnowledge.js';
import { coinsOwned } from '#/engine/bot/BotNeeds.js';
import { registerKeepHook, registerPlannerHook, eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { homeOf, themeOf } from '#/engine/bot/port/BotFavourites.js';
import { CraftingTask } from '#/engine/bot/tasks/CraftingTask.js';
import { CookingTask } from '#/engine/bot/tasks/CookingTask.js';
import { FlaxPickingTask } from '#/engine/bot/tasks/FlaxPickingTask.js';
import { bankCount } from '#/engine/bot/tasks/BotTaskBase.js';
import { MINIGAME_KINDS, farBudget, notePick, onlineN, outCount, outOn, outingRate, ticksSinceOuting, trailBudget } from '#/engine/bot/port/BotOutings.js';
import { CombatTask, combatWeaponFor, fitToFight } from '#/engine/bot/tasks/CombatTask.js';
import { FishingTask } from '#/engine/bot/tasks/FishingTask.js';
import { ThievingTask } from '#/engine/bot/tasks/ThievingTask.js';
import { OutingTask } from '#/engine/bot/tasks/OutingTask.js';
import { SHILO_FARES_BOTH } from '#/engine/bot/port/BotExits.js';
import { RangingGuildTask, mayCompete } from '#/engine/bot/tasks/RangingGuildTask.js';
import { TrawlerTask, crewExists, crewForming, mayTrawl } from '#/engine/bot/tasks/TrawlerTask.js';
import { TreasureTrailTask, holdsEasyClue } from '#/engine/bot/tasks/TreasureTrailTask.js';
import { AgilityArenaTask, mayRunArena } from '#/engine/bot/tasks/AgilityArenaTask.js';

/** a levelling bot asked for its next plan while the budget has room is offered an outing this often */
export const OFFER_CHANCE = 0.35;
/** a bot holding an easy clue scroll follows it this often when asked for its next plan (under the trails' own cap) */
export const TRAIL_CHANCE = 0.35;
/** a Trawler crew gathering takes a bot that may come this often (past the budget, up to the crew's size) */
export const CREW_JOIN = 0.7;
/** a bot named for an activity is offered outings this much as often (its outings mostly its theme's) */
const THEMED_OFFER = 0.4;
/**
 * each outing or minigame (but the Trawler, whose crew has its size) holds at most KEY_PER_100 bots per 100 online, at
 * least KEY_MIN: at 500 online the arena had 17 at once of the far budget's 30 (2004's arena had a handful)
 */
const KEY_PER_100 = 1.6;
const KEY_MIN = 3;
export function keyCap(n: number = onlineN()): number {
    return Math.max(KEY_MIN, Math.round((KEY_PER_100 * n) / 100));
}

/** a bot's next outing at least this many world ticks after its last one ended (1 hour) */
export const OUTING_GAP = 6000;
/** no outing with less than this left of the bot's session (ticks: half an hour) */
const SESSION_LEFT = 3000;

/** the planner's asks and offers (the tests, the report) */
export const minigamePlanStats = { asked: 0, kept: 0, offered: 0, byKey: {} as Record<string, number>, why: { who: 0, stay: 0, budget: 0, gap: 0, roll: 0, none: 0 } };

/** (tests) one key only (null: the catalogue's pick) */
let forcedKey: string | null = null;
export function forceOutingForTest(key: string | null): void {
    forcedKey = key;
}

interface CatalogueEntry {
    key: string;
    town: string;
    weight: number;
    /** the skills it trains (a bot named for one of them, or fond of it, goes more often; a bot named for another, less) */
    skills: readonly string[];
    /** the task, or null when the bot may not do it now */
    make(player: Player): BotTask | null;
}

/** a combat outing: the skill of the three the bot trains least, in the step's band, with its weapon and fit to fight */
function fightOuting(key: string, town: string): (player: Player) => BotTask | null {
    return player => {
        const step = OUTING_STEPS[key];
        const stats = [PlayerStat.ATTACK, PlayerStat.STRENGTH, PlayerStat.DEFENCE];
        const stat = stats.reduce((a, b) => (getBaseLevel(player, b) < getBaseLevel(player, a) ? b : a));
        const level = getBaseLevel(player, stat);
        if (level < step.minLevel || level > step.maxLevel || player.combatLevel < step.minLevel) return null;
        if (combatWeaponFor(player, step) === null || !fitToFight(player, step)) return null;
        const task = new CombatTask(step, stat);
        return task.shouldRun(player) ? new OutingTask(key, town, task) : null;
    };
}

const COMBAT: readonly string[] = ['ATTACK', 'STRENGTH', 'DEFENCE'];

/**
 * how much a bot likes an outing: a bot named for an activity (port/BotFavourites) goes on outings of its theme's skill
 * (x THEMED_MATCH), others rarely (x THEMED_OTHER: yew_cutter keeps to its yews, AM4)
 */
const THEMED_MATCH = 2;
const THEMED_OTHER = 0.15;
/** an unthemed bot's liking, from its planner's weights: its weight for the entry's skills against its mean, within these */
const LIKING_MIN = 0.2;
const LIKING_MAX = 3;
function liking(player: Player, entry: CatalogueEntry): number {
    const theme = themeOf(player.username);
    if (theme) return entry.skills.includes(theme.skills[0]) ? THEMED_MATCH : THEMED_OTHER;
    // (a fighter's outings are mostly its fights, a skiller's the Trawler and the arena: the planner's own liking, so an
    // outing takes the place of what the bot would have trained anyway, and the 2004 mix holds (AM1's combat share))
    const weights = Object.values(plannerWeights(player)).filter((w): w is number => typeof w === 'number' && w > 0);
    if (weights.length === 0) return 1;
    const mean = weights.reduce((a, b) => a + b, 0) / weights.length;
    const own = entry.skills.reduce((a, s) => a + (plannerWeights(player)[s] ?? 0), 0) / entry.skills.length;
    return Math.min(LIKING_MAX, Math.max(LIKING_MIN, own / mean));
}

/** the bot's planner's skill weights (its personality's; none for a planner without them) */
function plannerWeights(player: Player): Partial<Record<string, number>> {
    const ai = BotManager.botFor(player) as unknown as { planner?: { personality?: { weights?: Partial<Record<string, number>> } } } | null;
    return ai?.planner?.personality?.weights ?? {};
}

/**
 * a bot working Catherby's lobsters (its task a fishing one, by the beach; or just logged in there, where it fished: its
 * carry-on comes after the hooks): no outing, no other signature; it stays (the 2004 regular at the lobsters, for hours;
 * CB1: the outings and the Trawler's crews had taken half of them, most at their login)
 */
const CATHERBY_STAY_TILES = 20;
function fishingAtCatherby(player: Player, previous: string | null): boolean {
    const kind = previous === null ? 'Init' : previous.split(':')[0];
    if ((kind !== 'Fish' && kind !== 'Init') || player.level !== 0) return false;
    const [cx, cz] = Locations.FISH_CATHERBY;
    return Math.max(Math.abs(player.x - cx), Math.abs(player.z - cz)) <= CATHERBY_STAY_TILES;
}

/**
 * a bot the hooks leave where it is: at Catherby's lobsters. (Keeping every bot in sight of a Kandarin hub as well, the
 * market's and Seers' bank's, did not fill them: at m500 s4 East Ardougne's market was empty 88 % of the time against
 * 64 % without, the worlds' own paths apart; not kept)
 */
function stays(player: Player, previous: string | null): boolean {
    return fishingAtCatherby(player, previous);
}

/** the catalogue (weights: the minigames a little above the towns; "all four" extras) */
const CATALOGUE: readonly CatalogueEntry[] = [
    { key: 'Trawler', town: 'khazard', weight: 3.5, skills: ['FISHING'], make: p => (!crewExists() && mayTrawl(p) ? new TrawlerTask('leader') : null) },
    { key: 'AgilityArena', town: 'brimhaven', weight: 3, skills: ['AGILITY'], make: p => (mayRunArena(p) ? new AgilityArenaTask() : null) },
    { key: 'RangingGuild', town: 'hemenster', weight: 3, skills: ['RANGED'], make: p => (mayCompete(p) ? new RangingGuildTask() : null) },
    { key: 'yanille-ogres', skills: COMBAT, town: 'yanille', weight: 1.5, make: fightOuting('yanille-ogres', 'yanille') },
    { key: 'karamja-jogres', skills: COMBAT, town: 'karamja', weight: 1, make: fightOuting('karamja-jogres', 'karamja') },
    { key: 'burthorpe-soldiers', skills: COMBAT, town: 'burthorpe', weight: 1, make: fightOuting('burthorpe-soldiers', 'burthorpe') },
    {
        key: 'rellekka-fishing',
        town: 'rellekka',
        weight: 1.5,
        skills: ['FISHING'],
        make: p => {
            const step: SkillStep = OUTING_STEPS['rellekka-fishing'];
            if (getBaseLevel(p, PlayerStat.FISHING) < step.minLevel || !hasItem(p, Items.LOBSTER_POT)) return null;
            const task = new FishingTask(step);
            return task.shouldRun(p) ? new OutingTask('rellekka-fishing', 'rellekka', task) : null;
        }
    },
    {
        key: 'shilo-fishing',
        town: 'shilo',
        weight: 1,
        skills: ['FISHING'],
        make: p => {
            const step: SkillStep = OUTING_STEPS['shilo-fishing'];
            // (the variety work, round 2, the fixes: and both carts' fares carried, port/BotExits: no bank on the way to Brimhaven)
            if (getBaseLevel(p, PlayerStat.FISHING) < step.minLevel || !hasItem(p, Items.FLY_FISHING_ROD) || countItem(p, Items.FEATHER) < 50 || coinsOwned(p) < 300 || countItem(p, Items.COINS) < SHILO_FARES_BOTH) return null;
            return new OutingTask('shilo-fishing', 'shilo', new FishingTask(step));
        }
    },
    {
        key: 'yanille-watchmen',
        town: 'yanille',
        weight: 1,
        skills: ['THIEVING'],
        make: p => {
            const step: SkillStep = OUTING_STEPS['yanille-watchmen'];
            if (getBaseLevel(p, PlayerStat.THIEVING) < step.minLevel || p.combatLevel < 30) return null;
            const task = new ThievingTask(step);
            return task.shouldRun(p) ? new OutingTask('yanille-watchmen', 'yanille', task) : null;
        }
    }
];

/** (tests) how much the bot likes the catalogue's entry `key` (its theme's, else its planner's weights), or null */
export function likingOf(player: Player, key: string): number | null {
    const entry = CATALOGUE.find(e => e.key === key);
    return entry ? liking(player, entry) : null;
}

/** is this task one of the hook's (an outing, a minigame) */
function isMembersTask(task: BotTask): boolean {
    return task.name.includes(':outing:') || MINIGAME_KINDS.includes(task.name);
}

/** a bot free for an outing now: a members world's levelling bot, no newbie, on the overworld out of the Wilderness, unhurt, on no errand, time left */
function free(player: Player): boolean {
    if (!isLevelling(player.botPlanner as PlannerKey) || isNewbie(player) || player.combatLevel < 15) return false;
    if (player.level !== 0 || player.z >= 6400 || wildernessLevelAt(player.x, player.z) > 0) return false;
    if (player.levels[PlayerStat.HITPOINTS] * 2 < player.baseLevels[PlayerStat.HITPOINTS] || player.botComeHereReturnX !== -1 || player.botTradeTargetPid !== -1 || eventRoleOf(player)) return false;
    return BotManager.sessionLeftOf(player.username) >= SESSION_LEFT;
}

/**
 * The outing or minigame under way, kept (a rescan's pick of the same task is no switch; a trawler crew at sea gains no XP
 * for ten minutes, and the plan's no-XP end would have cut it there), or null. (The variety work, round 2, the fixes: asked
 * first by the planner, BotGoalPlanner's keep step through port/BotSetPieces' keep hooks, before its hang-outs, alch stints
 * and set pieces: from this hook, after the arena's, a due Duel Arena visit, a hang-out or an alch stint took a bot off its
 * outing at a plan's end)
 */
export function keptMembersTask(player: Player): BotTask | null {
    if (!isMembersWorld()) return null;
    const current = BotManager.botFor(player)?.currentTask ?? null;
    if (current && isMembersTask(current) && !current.isComplete(player) && !current.interrupted && current.shouldRun(player)) {
        minigamePlanStats.kept++;
        return current;
    }
    return null;
}

/** The planner's hook: an outing or a minigame for this bot now, or null. */
export function membersTaskFor(player: Player, previous: string | null): BotTask | null {
    if (!isMembersWorld()) return null;
    const kept = keptMembersTask(player);
    if (kept) return kept;
    if (outingRate() === 0) return null;
    minigamePlanStats.asked++;
    if (previous !== null && previous.includes(':outing:')) return null; // (never two in a row)
    if (!free(player)) {
        minigamePlanStats.why.who++;
        return null;
    }
    if (stays(player, previous)) {
        minigamePlanStats.why.stay++;
        return null;
    }
    // (an easy clue scroll from a kill: followed now and then, under the trails' cap; most are walked in the towns)
    if (outCount('trail') < trailBudget() && holdsEasyClue(player) && Math.random() < Math.min(1, TRAIL_CHANCE * outingRate())) {
        minigamePlanStats.offered++;
        minigamePlanStats.byKey['TreasureTrail'] = (minigamePlanStats.byKey['TreasureTrail'] ?? 0) + 1;
        notePick('members', 'TreasureTrail', previous);
        return new TreasureTrailTask();
    }
    // (a Trawler crew gathering at Port Khazard: a bot near Kandarin that may crew comes, past the budget)
    if (crewForming() && ticksSinceOuting(player.username) >= OUTING_GAP && mayTrawl(player) && Math.random() < Math.min(1, CREW_JOIN * outingRate())) {
        minigamePlanStats.offered++;
        minigamePlanStats.byKey['Trawler-crew'] = (minigamePlanStats.byKey['Trawler-crew'] ?? 0) + 1;
        notePick('members', 'Trawler-crew', previous);
        return new TrawlerTask('member');
    }
    if (outCount('far') >= farBudget()) {
        minigamePlanStats.why.budget++;
        return null;
    }
    if (ticksSinceOuting(player.username) < OUTING_GAP) {
        minigamePlanStats.why.gap++;
        return null;
    }
    // (a bot named for an activity goes out less often: most of its time on its own thing)
    const themed = themeOf(player.username) !== null;
    if (Math.random() >= Math.min(1, OFFER_CHANCE * outingRate() * (themed ? THEMED_OFFER : 1))) {
        minigamePlanStats.why.roll++;
        return null;
    }
    // (the catalogue's weights among what it may do now: each entry's own checks)
    const options: { entry: CatalogueEntry; task: BotTask }[] = [];
    for (const entry of CATALOGUE) {
        if (forcedKey !== null && entry.key !== forcedKey) continue;
        if (entry.key !== 'Trawler' && outOn(entry.key).length >= keyCap()) continue;
        const task = entry.make(player);
        if (task) options.push({ entry, task });
    }
    if (options.length === 0) {
        minigamePlanStats.why.none++;
        return null;
    }
    const weightOf = (o: { entry: CatalogueEntry }): number => o.entry.weight * liking(player, o.entry);
    let roll = Math.random() * options.reduce((a, o) => a + weightOf(o), 0);
    let pick = options[options.length - 1];
    for (const o of options) {
        roll -= weightOf(o);
        if (roll <= 0) {
            pick = o;
            break;
        }
    }
    minigamePlanStats.offered++;
    minigamePlanStats.byKey[pick.entry.key] = (minigamePlanStats.byKey[pick.entry.key] ?? 0) + 1;
    notePick('members', pick.entry.key, previous);
    return pick.task;
}

registerPlannerHook((player, previous) => membersTaskFor(player, previous));
registerKeepHook(player => keptMembersTask(player));

// ── (M-1, WHERE-5) Kandarin's signature activities ──────────────────────────────────────────────────────────────────
// The far members hotspots stood empty in the humanlike runs (H1's worst: Ardougne's market 84-98 % of the time, Catherby
// 49-86 %, Seers' bank 24-58 %): 2004's members icons were the Catherby lobsters, Seers' flax and its wheel upstairs, the
// Ardougne market's cake and silk stalls. A members levelling bot in Kandarin (or whose home is there) is offered one of
// them now and then (SIGNATURE_CHANCE of its asks, times how much its planner likes those skills against its fights), by
// how much it likes each and what it may do: Catherby's lobsters, tuna or swordfish (Fishing 35+, its harpoon or cage)
// and the catch cooked at Catherby's range by the bank, Seers' flax picked and spun upstairs (Crafting 10+: the spinning
// when it has the flax), Ardougne's stalls (Thieving 5+, combat 20+: the market's guards). Not an outing:
// these towns are next to the members hubs, and they fill at every size. A bot named for another activity keeps to its own.

/** a Kandarin bot is offered a signature activity this often when asked for its next plan (times its planner's liking) */
export const SIGNATURE_CHANCE = 0.15;
/** the liking's scale: a planner whose skills are a third its signatures' gets the whole chance */
const SIGNATURE_LIKING = 3;
/** Kandarin: within this of Seers (or a home there) */
const KANDARIN: readonly [number, number] = [2720, 3400];
const KANDARIN_TILES = 220;
const KANDARIN_HOMES: ReadonlySet<string> = new Set(['catherby', 'seers', 'ardougne']);
/** the flax a spinner wants (the planner's FLAX_SPIN_MIN) */
const FLAX_SPIN = 25;

export const signatureStats = { asked: 0, offered: 0, byKey: {} as Record<string, number> };

function inKandarin(player: Player): boolean {
    if (Math.max(Math.abs(player.x - KANDARIN[0]), Math.abs(player.z - KANDARIN[1])) <= KANDARIN_TILES) return true;
    return KANDARIN_HOMES.has(homeOf(player.username, true).key);
}

/** the planner's weight for a skill (its personality's), 0 when it never trains it */
function plannerWeight(player: Player, skill: string): number {
    return plannerWeights(player)[skill] ?? 0;
}

/** the best step of `skill` at `where` the bot's level allows (its own level's) */
function bestStepAt(skill: string, level: number, where: (s: SkillStep) => boolean): SkillStep | null {
    const steps = (SkillProgression[skill] ?? []).filter(s => where(s) && level >= s.minLevel && level <= s.maxLevel);
    return steps.sort((a, b) => b.minLevel - a.minLevel)[0] ?? null;
}

/** the raw fish of Catherby's catch a cook takes to its range (14 or more, the planner's load) */
const CATHERBY_CATCH: readonly number[] = [Items.RAW_TUNA, Items.RAW_LOBSTER, Items.RAW_SWORDFISH];

/**
 * the signatures (weight: Catherby's above the others, as its lobsters were the members icon and its bank stands empty
 * most of the time; Ardougne's stalls below, its thieves came first)
 */
const SIGNATURES: readonly { key: string; skill: string; weight: number; make(player: Player): BotTask | null }[] = [
    {
        // (the catch cooked at Catherby's range by its bank: the lobster fisher's 2004 loop, in sight of the bank)
        key: 'catherby-cooking',
        skill: 'COOKING',
        weight: 2,
        make: p => {
            const level = getBaseLevel(p, PlayerStat.COOKING);
            const [rx, rz] = Locations.CATHERBY_RANGE;
            for (const fish of CATHERBY_CATCH) {
                if (countItem(p, fish) + bankCount(p, fish) < 14) continue;
                const step = bestStepAt('COOKING', level, s => s.location[0] === rx && s.location[1] === rz && s.itemConsumed === fish);
                if (step) return new CookingTask(step);
            }
            return null;
        }
    },
    {
        key: 'catherby-fishing',
        skill: 'FISHING',
        weight: 2,
        make: p => {
            // (the best of Catherby's tuna, lobsters and swordfish its level allows and whose tool it owns: a fisher of 50
            // with a lobster pot and no harpoon fishes lobsters)
            const level = getBaseLevel(p, PlayerStat.FISHING);
            const [cx, cz] = Locations.FISH_CATHERBY;
            const steps = (SkillProgression['FISHING'] ?? [])
                .filter(s => s.location[0] === cx && s.location[1] === cz && s.minLevel >= 35 && s.minLevel < 76 && level >= s.minLevel && level <= s.maxLevel)
                .filter(s => s.toolItemIds.some(id => hasItem(p, id) || bankCount(p, id) > 0))
                .sort((a, b) => b.minLevel - a.minLevel);
            for (const step of steps) {
                const task = new FishingTask(step);
                if (task.shouldRun(p)) return task;
            }
            return null;
        }
    },
    {
        key: 'seers-flax',
        skill: 'CRAFTING',
        weight: 1.5,
        make: p => {
            const level = getBaseLevel(p, PlayerStat.CRAFTING);
            const spin = bestStepAt('CRAFTING', level, s => s.action === 'spin_flax');
            if (!spin) return null;
            if (countItem(p, Items.FLAX) + bankCount(p, Items.FLAX) >= FLAX_SPIN) return new CraftingTask(spin);
            const pick = bestStepAt('CRAFTING', level, s => s.action === 'pick_flax');
            return pick ? new FlaxPickingTask(pick) : null;
        }
    },
    {
        key: 'ardougne-stalls',
        skill: 'THIEVING',
        weight: 0.6,
        make: p => {
            const level = getBaseLevel(p, PlayerStat.THIEVING);
            if (p.combatLevel < 20) return null;
            const stalls = [Locations.BAKER_STALL, Locations.SILK_STALL, Locations.FUR_STALL, Locations.SILVER_STALL];
            const step = bestStepAt('THIEVING', level, s => s.action === 'thieve_stall' && stalls.some(([x, z]) => s.location[0] === x && s.location[1] === z));
            if (!step) return null;
            const task = new ThievingTask(step);
            return task.shouldRun(p) ? task : null;
        }
    }
];

/**
 * how much of a planner's liking goes to the signatures' skills (their weights against all its skills'): a fighter's is
 * small, so the signatures take the place of its skills more than of its fights (the 2004 mix's combat share, AM1)
 */
function signatureLiking(player: Player): number {
    const weights = plannerWeights(player);
    let all = 0;
    let own = 0;
    for (const [skill, w] of Object.entries(weights)) {
        if (!w || w <= 0) continue;
        all += w;
        if (SIGNATURES.some(sig => sig.skill === skill)) own += w;
    }
    return all > 0 ? own / all : 0;
}

/**
 * a members fisher of 35+ done with a plan of fishing elsewhere (within CATHERBY_FISHER_TILES of Catherby: no plan begun
 * 300+ tiles off, AM8) goes on at Catherby's tuna, lobsters or swordfish this often (the plan's "Catherby lobsters for
 * members fishers 35+": 2004's members fished there, by the bank, rather than Karamja's boat or a river)
 */
export const CATHERBY_FISHER_CHANCE = 0.5;
const CATHERBY_FISHER_TILES = 300;

/** The planner's hook: a Kandarin signature activity for this bot now, or null. */
export function signatureTaskFor(player: Player, previous: string | null): BotTask | null {
    if (!isMembersWorld() || outingRate() === 0) return null;
    if (!isLevelling(player.botPlanner as PlannerKey) || isNewbie(player) || player.level !== 0 || player.z >= 6400) return null;
    if (stays(player, previous)) return null;
    // (a fisher elsewhere: Catherby's lobsters next, as members fishers of 35+ went there)
    if (previous !== null && previous.split(':')[0] === 'Fish' && !previous.includes(':outing:')) {
        const [cx, cz] = Locations.FISH_CATHERBY;
        const theme = themeOf(player.username);
        // (why a fisher was not sent, for the runner's FT2: 'far', 'theme', 'roll', 'none' (no step it may fish there))
        const why = theme && theme.skills[0] !== 'FISHING' ? 'theme' : Math.max(Math.abs(player.x - cx), Math.abs(player.z - cz)) > CATHERBY_FISHER_TILES ? 'far' : Math.random() >= Math.min(1, CATHERBY_FISHER_CHANCE * outingRate()) ? 'roll' : null;
        const task = why === null ? (SIGNATURES.find(sig => sig.key === 'catherby-fishing')?.make(player) ?? null) : null;
        notePick('fisher', task ? 'sent' : (why ?? 'none'), previous);
        if (task) {
            signatureStats.offered++;
            signatureStats.byKey['catherby-fisher'] = (signatureStats.byKey['catherby-fisher'] ?? 0) + 1;
            notePick('signature', 'catherby-fisher', previous);
            return task;
        }
    }
    if (!inKandarin(player)) return null;
    signatureStats.asked++;
    if (Math.random() >= Math.min(1, SIGNATURE_CHANCE * outingRate() * Math.min(1, SIGNATURE_LIKING * signatureLiking(player)))) return null;
    const theme = themeOf(player.username);
    const options: { key: string; task: BotTask; weight: number }[] = [];
    for (const sig of SIGNATURES) {
        if (theme && theme.skills[0] !== sig.skill) continue;
        const weight = plannerWeight(player, sig.skill) * sig.weight;
        if (weight <= 0) continue;
        const task = sig.make(player);
        if (task) options.push({ key: sig.key, task, weight });
    }
    if (options.length === 0) return null;
    let roll = Math.random() * options.reduce((a, o) => a + o.weight, 0);
    let pick = options[options.length - 1];
    for (const o of options) {
        roll -= o.weight;
        if (roll <= 0) {
            pick = o;
            break;
        }
    }
    signatureStats.offered++;
    signatureStats.byKey[pick.key] = (signatureStats.byKey[pick.key] ?? 0) + 1;
    notePick('signature', pick.key, previous);
    return pick.task;
}

registerPlannerHook((player, previous) => signatureTaskFor(player, previous));

/** (the tests) the world tick now: what a staged scene compares with */
export function nowTick(): number {
    return World.currentTick;
}
