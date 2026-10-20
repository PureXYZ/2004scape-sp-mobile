// port: newbie newcomers (Phase 3). A brand-new account comes out at the Lumbridge courtyard as a
// player came off Tutorial Island in 2004: the tutorial's kit in its pack and 25 coins in its bank (274's
// tutorial.rs2, [label,tutorial_complete]), not the 200 coins and tools of an ordinary new bot. While it is a newbie it
// plays like one: it wields the bronze sword and wooden shield, wanders the courtyard (tasks/NewbieTask), goes to kill
// chickens and cows (BotGoalPlanner), asks newbie questions and begs the players it passes (port/BotChatter, more often
// than other bots talk); then its planner takes over.
//
// port (the realism work, phase 2): a newbie's lines are its own (these) 60 % of the time, else the newbie questions of
// upstream's idle lines and the 2004 lines that fit a newbie (port/BotLines: "how do i bank?" from a newbie or a low
// level only); about 15-36 lines an hour (its persona's rate times four), in bursts, the first within a few minutes,
// where upstream said one at 1.2 % a tick (72 an hour). Only real newbies (isNewbie) talk like this.
//
// port (the realism work, phase 3: "Lumbridge newbies", about 5-10 level-3s per 100 online around Lumbridge,
// newbie time measured in levels): a newcomer is a newbie until combat 10 or total level 60, whichever comes first (it
// was 5-15 minutes: at 10x XP a newbie outgrew Lumbridge in minutes, at 1x it left it level 3). It stays one across its
// sessions and the app's restarts (BotManager keeps the names in the living world's state). About 2 newcomers in 3 are
// slow levellers ("alts"; "slower turnover", 2026-10-15: it was 1 in 3): it wanders, stands about, visits the general store and Bob's axes, chats, and trains only now
// and then (isSlowNewbie: from its name), and talks at half a newbie's rate. BotManager's newcomer clock keeps about 7-9
// level-3s around Lumbridge per 100 online (lumbridgeLowLevel; port/BotSessions newcomerPace): at 10x XP a newbie is past
// them in minutes.
//
// port (the realism work, phase 5b, Track D: newbie follow trains, port/BotTrains): a newbie in LUMBRIDGE_AREA may ask a
// passer-by "can i follow u?" and follow it a few minutes, a second and a third behind it; a newbie still after it.
import type Player from '#/engine/entity/Player.js';
import { Items } from '#/engine/bot/BotKnowledge.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';

/** port (phase 3): a newcomer is a newbie until either of these (combat level, total level), whichever comes first */
export const NEWBIE_UNTIL: Readonly<{ combat: number; total: number }> = { combat: 10, total: 60 };

/**
 * port (phase 3): about this share of newcomers level slowly (they wander, chat and stand about more than they train).
 * The "slower turnover": 2 in 3, was 1 in 3. At 10x XP a quick newbie outgrows Lumbridge in minutes,
 * and the newcomer clock brought about 8 newcomers an hour at 100 online to keep 5-10 level-3s there, each retiring an
 * old bot (the pool turned over in about a day of play; the names lasted about 120 hours): the slow ones stay level-3s
 * for hours, so few newcomers are needed and familiar bots stay.
 */
export const SLOW_NEWBIE_SHARE = 2 / 3;

/** port (phase 3): how long a newbie's plan holds (BotPlayer: its rescan asks the planner again after it), in ticks */
export const NEWBIE_PLAN_TICKS: [number, number] = [200, 600];

/**
 * port (phase 3): the Lumbridge of "level-3s around Lumbridge": its castle, fields, swamp and cows (level 0;
 * the humanlike report's P1 counts the same square)
 */
export const LUMBRIDGE_AREA: Readonly<{ x0: number; x1: number; z0: number; z1: number }> = { x0: 3140, x1: 3270, z0: 3140, z1: 3300 };
/** port (phase 3): the combat level a "level-3" has at most (P1's) */
export const LOW_LEVEL_COMBAT = 5;

/** port (phase 3): a bot of combat 5 or less around Lumbridge (the newcomer clock keeps 7-9 per 100 online: port/BotSessions) */
export function lumbridgeLowLevel(player: Player): boolean {
    const a = LUMBRIDGE_AREA;
    return player.combatLevel <= LOW_LEVEL_COMBAT && player.level === 0 && player.x >= a.x0 && player.x <= a.x1 && player.z >= a.z0 && player.z <= a.z1;
}

/** 274's Tutorial Island kit, in its order (tutorial.rs2) */
export const TUTORIAL_KIT: readonly [number, number][] = [
    [Items.BRONZE_AXE, 1],
    [Items.TINDERBOX, 1],
    [Items.SMALL_FISHING_NET, 1],
    [Items.SHRIMP, 1],
    [Items.BUCKET, 1],
    [Items.POT, 1],
    [Items.BREAD, 1],
    [Items.BRONZE_PICKAXE, 1],
    [Items.BRONZE_DAGGER, 1],
    [Items.BRONZE_SWORD, 1],
    [Items.WOODEN_SHIELD, 1],
    [Items.SHORTBOW, 1],
    [Items.BRONZE_ARROW, 25],
    [Items.AIR_RUNE, 25],
    [Items.MIND_RUNE, 15],
    [Items.WATER_RUNE, 6],
    [Items.EARTH_RUNE, 4],
    [Items.BODY_RUNE, 2]
];
/** and the coins the tutorial's banker leaves in the bank */
export const TUTORIAL_COINS = 25;

/** port: the total level as the game counts it (every skill's base level; the two unused stats left out) */
export function totalLevel(player: Player): number {
    let total = 0;
    const levels = player.baseLevels;
    for (let stat = 0; stat < levels.length; stat++) if (stat !== 18 && stat !== 19) total += levels[stat];
    return total;
}

/** port (phase 3): levels past a newbie's (NEWBIE_UNTIL) */
export function outgrewNewbie(player: Player): boolean {
    return player.combatLevel >= NEWBIE_UNTIL.combat || totalLevel(player) >= NEWBIE_UNTIL.total;
}

/**
 * Is this bot a newbie still? port (phase 3): a newcomer (botNewbie, set by BotManager) below combat 10 and total level 60
 * (NEWBIE_UNTIL); once past either it is one no more, for good (levels never go down: the flag is cleared here).
 */
export function isNewbie(player: Player): boolean {
    if (player.is_bot !== true || player.botNewbie !== true) return false;
    if (outgrewNewbie(player)) {
        player.botNewbie = false;
        return false;
    }
    return true;
}

/** port (phase 3): a slow leveller (about 2 newcomers in 3, SLOW_NEWBIE_SHARE): the same for the same name, every session */
export function isSlowNewbie(name: string): boolean {
    return seededRandom(nameSeed(name, 'slow-newbie'))() < SLOW_NEWBIE_SHARE;
}

/**
 * port (phase 3): when a plan begun now (BotPlayer._newPlan) ends: a newbie's after NEWBIE_PLAN_TICKS, so that its
 * rescan asks the planner again (the newbie's next stint, or its planner's first plan once it outgrew Lumbridge: newbie
 * time was a timer the plan ended with); Infinity for any other bot
 */
export function newbiePlanEnds(player: Player, now: number): number {
    if (!isNewbie(player)) return Infinity;
    return now + NEWBIE_PLAN_TICKS[0] + Math.floor(Math.random() * (NEWBIE_PLAN_TICKS[1] - NEWBIE_PLAN_TICKS[0] + 1));
}

/**
 * a newbie's lines an hour (its persona's chattiness times four, within these; upstream's 1.2 % a tick was 72).
 * port (phase 3): 3-8, was 15-36: newbies are now about one bot in ten or twenty ("Lumbridge newbies"), not
 * one in hundreds, and at 15-36 an hour they alone added 1.5-3 lines to every bot-hour of the world (the humanlike
 * report's H7: 10.9 at 10x XP, band 4-10); their questions draw the bots' answers on top
 */
export const NEWBIE_LINES_PER_HOUR: [number, number] = [3, 8];
/**
 * port (phase 3): a slow leveller's (an "alt" standing about Lumbridge for hours) at half that, its persona's chattiness
 * times two: the slow ones are most of the newbies online in a long 10x world (they stay newbies for hours, a newbie
 * that is not for minutes)
 */
export const SLOW_NEWBIE_LINES_PER_HOUR: [number, number] = [1.5, 4];

/** port (phase 3): the lines an hour a newbie aims at (port/BotChatter): a slow leveller's half a newbie's */
export function newbieLinesPerHour(bot: Player, chattiness: number): number {
    const [lo, hi] = isSlowNewbie(bot.username) ? SLOW_NEWBIE_LINES_PER_HOUR : NEWBIE_LINES_PER_HOUR;
    return Math.min(hi, Math.max(lo, chattiness * (isSlowNewbie(bot.username) ? 2 : 4)));
}
/** the share of its lines from its own pools below (the rest: upstream's and the 2004 newbie lines that fit it) */
export const NEWBIE_OWN_SHARE = 0.6;
/** of its own lines, this share begs a player near it, the rest asks anyone */
export const NEWBIE_BEG_SHARE = 0.25;

/** what a newbie asks anyone around (2004's Lumbridge: no Grand Exchange, Cook's Assistant the first quest) */
export const NEWBIE_QUESTIONS: readonly string[] = [
    'how do i get to varrock',
    'where do i get armour',
    'how do u make money',
    'wat do i do now',
    'where are the cows',
    'wheres the bank',
    'how do i get out of lumbridge lol',
    'any1 wanna be friends',
    'how do i fish',
    'where can i sell stuff',
    'where can i get a better sword',
    'how do i lvl up fast',
    'lol im lost',
    'this game is so cool',
    'how do i turn on run',
    'where do i get food',
    'what are these runes for',
    'how do i cast spells',
    'is there a shop near here',
    'how do i get to falador',
    'wats the best weapon',
    'where are the chickens',
    'how do i add friends',
    'im new lol',
    'first day playing :)',
    'where is the general store',
    'how do i bank stuff',
    'what does the cook want',
    'where do i get an egg',
    'how do i do quests'
];

/** what a newbie says to a player it passes ({name}: theirs) */
export const NEWBIE_BEGS: readonly string[] = [
    '{name} can i have some money plz',
    '{name} spare some gp?',
    '{name} plz give me 100gp',
    '{name} can i have ur armour',
    '{name} u got any free stuff?',
    '{name} can u give me a better sword plz',
    '{name} wanna be friends?',
    'hi {name} im new',
    '{name} how did u get so high lvl'
];
