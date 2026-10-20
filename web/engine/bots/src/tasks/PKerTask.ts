/**
 * PKerTask.ts
 *
 * "Extras" personality — deep-wilderness PKer.
 * Picks one of 60 generated profiles (30 pures + 30 mains) and hunts across
 * 12 deep-wilderness patrol zones (Z ~3663–3820).  Full combat engine shared
 * with EdgevillePKerTask: special attacks, food, potions, banking, blacklist,
 * stacking detection.  The only difference from EdgevillePKerTask is the
 * hunting area — this bot goes deep, not shallow-ditch.
 */

import Player from '#/engine/entity/Player.js';
import ObjType from '#/cache/config/ObjType.js';
import {
    BotTask,
    walkTo,
    isNear,
    randInt,
    PlayerStat,
    hasItem,
    addItem,
    countItem,
    isInventoryFull,
    teleportNear,
    StuckDetector,
    ProgressWatchdog,
    Items,
    humanDelay,
} from '#/engine/bot/tasks/BotTaskBase.js';
import {
    interactPlayerOp,
    interactHeldOp,
    interactIfButtonByName,
    setVarp,
    _wornContains,
} from '#/engine/bot/BotAction.js';
import World from '#/engine/World.js';
import InvType from '#/cache/config/InvType.js';
import { botWalkPath, pathBudgetLeft } from '#/engine/bot/port/BotPathing.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { isMultiCombat, pvpWildernessLevel, wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { botSay } from '#/engine/bot/port/BotSay.js';
import { pkFixedLine, pkLine } from '#/engine/bot/port/BotLines.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import {
    F2P_PK_ITEMS,
    freeWorldPkProfiles,
    pkEquipItem as equipItem,
    pkRegear as regear,
    pkTryEquipFromInventory as tryEquipFromInventory,
    pkDropStaleSpecial,
    stripMembersItems,
    usableOnThisWorld
} from '#/engine/bot/port/BotPkGear.js';
import { PJED_WITHIN, newPkTactics, pkEngageTactics, pkPrayersOff, pkSayEscape, pkSayPjed, pkSayRan } from '#/engine/bot/port/BotPkTactics.js';
import { PkPjWatch, pkFightToWatch } from '#/engine/bot/port/BotPkPj.js';
// (PK tactics, 2026-10-19: getting out, eating, potions, the KO switch, the kit)
import { PkFight, PkTeleport, pkCanTele, pkFoodLeft, pkHitBy, pkKitted, pkRecharge, pkSetLevels, pkSetMagic, pkTeleItems, pkTopUp, pkWaysOf } from '#/engine/bot/port/BotPkFight.js';
import type { PkProfile } from '#/engine/bot/port/BotPkGear.js';
import { nameIndex, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { classPkProfile, pkProfileAtLogin } from '#/engine/bot/port/BotOutfits.js';
// (the variety work, round 2, track W2: WEAR-8, PK outfit variety)
import { pkVarietyAtLogin, pkVariedProfile } from '#/engine/bot/port/BotFashion.js';
import { whereOwned } from '#/engine/bot/port/BotGear.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { noteSpectacle } from '#/engine/bot/port/BotHabits.js';
import { pkCliqueLeader, sameClique } from '#/engine/bot/port/BotCliques.js';
import { FollowDetour } from '#/engine/bot/port/BotFollow.js';
import { claimStandTile, releaseStandTile, sharesTile, stepToTile } from '#/engine/bot/port/BotTiles.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
// (the realism work, phase 5b, Track D: PK team raids into the Varrock Wilderness's multi-combat; the raid's view through
// port/BotSetPieces only: port/BotPkTeam is a set piece's module, loaded with the director's)
import { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';
import type { PkRaid } from '#/engine/bot/port/BotPkTeam.js';

/** port (the realism work, phase 5b): the PK team raid this PKer has a part in (port/BotPkTeam), or null */
function raidOf(p: Player): PkRaid | null {
    const run = eventRoleOf(p)?.run as (Partial<PkRaid> & { kind?: string }) | null | undefined;
    // (Track D's raid only: another run under its name, a test's stand-in for a lure, has no spots: a PKer that read one
    // threw at every tick)
    return run && run.kind === 'pk_raid' && typeof run.spotFor === 'function' ? (run as PkRaid) : null;
}

/** port: a PK line, when one of its own is fresh (port/BotLines pkLine); else nothing */
function sayPk(player: Player, line: string | null): void {
    if (line !== null) botSay(player, line, undefined, 'pk');
}

// ── Item IDs ──────────────────────────────────────────────────────────────────

const I = {
    RUNE_SCIMITAR: 1333,
    DRAGON_DAGGER: 1215,
    DRAGON_DAGGER_P: 1231,
    DRAGON_LONGSWORD: 1305,
    DRAGON_BATTLEAXE: 1377,
    MAGIC_SHORTBOW: 861,
    RUNE_ARROW: 892,
    COIF: 1169,
    MONK_ROBE_TOP: 544,
    GREEN_DHIDE_BODY: 1135,
    BLUE_DHIDE_BODY: 2499,
    RED_DHIDE_BODY: 2501,
    BLACK_DHIDE_BODY: 2503,
    GREEN_DHIDE_CHAPS: 1099,
    BLUE_DHIDE_CHAPS: 2493,
    RED_DHIDE_CHAPS: 2495,
    BLACK_DHIDE_CHAPS: 2497,
    RUNE_FULL_HELM: 1163,
    DRAGON_MED_HELM: 1149,
    RUNE_PLATEBODY: 1127,
    RUNE_PLATELEGS: 1079,
    RUNE_KITESHIELD: 1201,
    AMULET_OF_GLORY: 1704,
    AMULET_OF_STRENGTH: 1725,
    LEATHER_BOOTS: 1061,
    GREEN_DHIDE_VAMBRACES: 1065,
    BLUE_DHIDE_VAMBRACES: 2487,
    RED_DHIDE_VAMBRACES: 2489,
    BLACK_DHIDE_VAMBRACES: 2491,
    LOBSTER: 379,
    SWORDFISH: 373,
    SHARK: 385,
    SUPER_ATTACK4: 2436,
    SUPER_STRENGTH4: 2440,
    SUPER_DEFENCE4: 2442,
    PRAYER_POTION4: 2434,
    SUPER_RESTORE4: 3024,
    BLACK_CAPE: 1019,
    BLUE_CAPE: 1021,
    YELLOW_CAPE: 1023,
    GREEN_CAPE: 1027,
    PURPLE_CAPE: 1029,
    ORANGE_CAPE: 1031,
    LEGENDS_CAPE: 1052,
    SARADOMIN_CAPE: 2412,
    GUTHIX_CAPE: 2413,
    ZAMORAK_CAPE: 2414,
};

const COMMON_CAPES = [I.BLACK_CAPE, I.BLUE_CAPE, I.YELLOW_CAPE, I.GREEN_CAPE, I.PURPLE_CAPE, I.ORANGE_CAPE, I.SARADOMIN_CAPE, I.GUTHIX_CAPE, I.ZAMORAK_CAPE];
// port: the highwayman mask is 2631 in 274; 979 is a quest item there that cannot be worn (it went into worn slot -1)
const PURE_HATS = [1169, 2633, 2635, 2637, 2639, 2641, 2643, 2645, 2647, 2649, 2631];
const DHIDE_CHAPS: [number, number, number][] = [
    [I.GREEN_DHIDE_CHAPS, 40, 1],
    [I.BLUE_DHIDE_CHAPS, 50, 1],
    [I.RED_DHIDE_CHAPS, 60, 1],
    [I.BLACK_DHIDE_CHAPS, 70, 1],
];
const DHIDE_VAMBS: [number, number, number][] = [
    [I.GREEN_DHIDE_VAMBRACES, 40, 1],
    [I.BLUE_DHIDE_VAMBRACES, 50, 1],
    [I.RED_DHIDE_VAMBRACES, 60, 1],
    [I.BLACK_DHIDE_VAMBRACES, 70, 1],
];

// ── Profile generation (identical to EdgevillePKerTask) ───────────────────────

/** port: port/BotPkGear's shape (the same fields as upstream's), with the kit's (port/BotPkFight pkKitted) */
type PkerProfile = PkProfile;

function bestByLevel(items: [number, number, number][], level: number): number {
    let best = items[0]![0];
    for (const [id, req] of items) {
        if (level >= req) best = id;
    }
    return best;
}

/** The members world's profiles (exported for test/pk.test.mjs: the same tables at every start). */
export function generatePkerProfiles(): PkerProfile[] {
    // port: the same tables at every start (seeded), so a PKer's build, picked by its name, never changes
    const rand = seededRandom(0x504b0001);
    const pickP = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
    const profiles: PkerProfile[] = [];

    const strOpts = [60, 65, 70, 75, 80, 85, 90, 95, 99];
    const rangeOpts = [61, 65, 70, 75, 80, 85, 90, 99];
    const prayOpts = [1, 15, 31, 44, 52, 70];

    for (let i = 0; i < 30; i++) {
        const str = strOpts[i % strOpts.length]!;
        const range = rangeOpts[Math.floor(i / 3) % rangeOpts.length]!;
        const pray = prayOpts[Math.floor(i / 7) % prayOpts.length]!;
        const hp = Math.max(40, Math.min(99, 25 + Math.floor(str * 0.65)));

        const legs = bestByLevel(DHIDE_CHAPS, range);
        const gloves = bestByLevel(DHIDE_VAMBS, range);

        profiles.push({
            name: `pure-${i}`,
            atk: 60, str, def: 1, hp, range, pray,
            weapon: I.RUNE_SCIMITAR,
            specWeapon: pickP([I.DRAGON_DAGGER_P, I.DRAGON_LONGSWORD, I.MAGIC_SHORTBOW]),
            rangeWeapon: I.MAGIC_SHORTBOW,
            ammo: I.RUNE_ARROW,
            helm: pickP(PURE_HATS),
            // port: a pure (Defence 1) cannot wear a d'hide body (it needs 40 Defence): a monk's robe or a leather body
            body: i % 3 === 0 ? I.MONK_ROBE_TOP : F2P_PK_ITEMS.LEATHER_BODY,
            legs,
            shield: -1,
            neck: pickP([I.AMULET_OF_STRENGTH, I.AMULET_OF_GLORY]),
            cape: pickP(COMMON_CAPES),
            boots: I.LEATHER_BOOTS,
            gloves,
            food: pickP([I.SWORDFISH, I.SHARK]),
            pots: [I.SUPER_ATTACK4, I.SUPER_STRENGTH4].concat(pray > 31 ? [I.PRAYER_POTION4] : []),
        });
    }

    const mainStrOpts = [65, 70, 75, 80, 85, 90, 95, 99];
    const mainDefOpts = [30, 40, 45, 50, 60, 65, 70, 80];
    const mainAtkOpts = [60, 65, 70, 75, 80, 85, 90, 99];

    for (let i = 0; i < 30; i++) {
        const atk = mainAtkOpts[i % mainAtkOpts.length]!;
        const str = mainStrOpts[Math.floor(i / 2) % mainStrOpts.length]!;
        const def = mainDefOpts[Math.floor(i / 3) % mainDefOpts.length]!;
        const hp = Math.max(50, Math.min(99, 35 + Math.floor((str + def) * 0.4)));
        const range = Math.max(50, Math.min(99, 40 + Math.floor(str * 0.5)));
        const pray = pickP([31, 44, 52, 60, 70]);

        const hasDragon = atk >= 60;
        const mainWeapon = hasDragon && i % 2 === 0 ? I.DRAGON_LONGSWORD : I.RUNE_SCIMITAR;

        let specWeapon = -1;
        if (hasDragon) {
            specWeapon = mainWeapon === I.DRAGON_LONGSWORD ? I.DRAGON_BATTLEAXE : pickP([I.DRAGON_DAGGER_P, I.DRAGON_LONGSWORD, I.MAGIC_SHORTBOW]);
        }

        profiles.push({
            name: `main-${i}`,
            atk, str, def, hp, range, pray,
            weapon: mainWeapon,
            specWeapon,
            rangeWeapon: I.MAGIC_SHORTBOW,
            ammo: I.RUNE_ARROW,
            // port: rune from 40 Defence, adamant below (a main of 30 wore rune)
            helm: def >= 60 && i % 3 === 0 ? I.DRAGON_MED_HELM : def >= 40 ? I.RUNE_FULL_HELM : F2P_PK_ITEMS.ADAMANT_FULL_HELM,
            body: def >= 40 ? I.RUNE_PLATEBODY : F2P_PK_ITEMS.ADAMANT_PLATEBODY,
            legs: def >= 40 ? I.RUNE_PLATELEGS : F2P_PK_ITEMS.ADAMANT_PLATELEGS,
            shield: def >= 40 ? I.RUNE_KITESHIELD : F2P_PK_ITEMS.ADAMANT_KITESHIELD,
            neck: I.AMULET_OF_GLORY,
            cape: pickP(def >= 60 ? [...COMMON_CAPES, I.LEGENDS_CAPE] : COMMON_CAPES),
            boots: I.LEATHER_BOOTS,
            gloves: I.GREEN_DHIDE_VAMBRACES,
            food: I.SHARK,
            pots: [I.SUPER_ATTACK4, I.SUPER_STRENGTH4].concat(
                str >= 80 ? [I.PRAYER_POTION4] : [],
                def >= 60 ? [I.SUPER_DEFENCE4] : [],
            ),
        });
    }

    return profiles;
}

const PROFILES = generatePkerProfiles();
/** port: a free world's PKers wear and use only free items (port/BotPkGear.ts) */
const FREE_WORLD_PROFILES: PkerProfile[] = freeWorldPkProfiles();

/**
 * port: the build of the bot with this (normalised) name on this world: the same at every login (BotSeed). With the bot
 * (its login's pick): the class's look only for a PKer new since round 1 or saved in it (port/BotOutfits pkProfileAtLogin)
 */
export function pkerProfileFor(username: string, player?: Player): PkerProfile {
    const profiles = isMembersWorld() ? PROFILES : FREE_WORLD_PROFILES;
    const profile = profiles[nameIndex(username, 'pker', profiles.length)]!;
    // port (the variety work, round 2, track W2: WEAR-8) its gloves, boots, amulet, helm, legs and weapon from its own seed
    // (port/BotFashion pkVariedProfile; a class name's hat kept), on round 1's class look
    const members = isMembersWorld();
    const classed = classPkProfile(username, profile, 'pker') !== null;
    // port (PK tactics, 2026-10-19): the fight's kit on top (port/BotPkFight pkKitted: its style, KO weapon, potions,
    // way out), the same for a saved PKer and a new one: how it fights, not how it looks
    // port (the variety work, round 1, track W: WEAR-6): a mage's or archer's name in its class's look, its build as before
    if (!player) return pkKitted(username, pkVariedProfile(username, classPkProfile(username, profile, 'pker') ?? profile, 'pker', members, classed), 'pker', members);
    // (the fixes: the integrator's rule) a PKer saved before round 1 keeps its look; (round 2) one saved before round 2 its outfit
    const saved = BotManager.botFor(player)?.planner.hasSave() ?? false;
    const owns = (id: number): boolean => whereOwned(player, id) !== null;
    return pkKitted(username, pkVarietyAtLogin(username, pkProfileAtLogin(username, profile, 'pker', saved, owns), 'pker', members, saved, owns, classed), 'pker', members);
}

// ── Patrol zones (deep wilderness) ────────────────────────────────────────────

// Deep wilderness hunting zones (wild levels ~18–38).
const HUNTING_ZONES: [number, number][] = [
    [3082, 3663],  //  0 — Graveyard of Shadows west  (~wild 18)
    [3235, 3663],  //  1 — Graveyard of Shadows east  (~wild 18)
    [3050, 3695],  //  2 — west wilderness             (~wild 22)
    [3100, 3715],  //  3 — mid wilderness              (~wild 25)
    [3285, 3715],  //  4 — east wilderness ruins       (~wild 25)
    [3060, 3750],  //  5 — deep west                  (~wild 29)
    [3190, 3752],  //  6 — deep mid                   (~wild 30)
    [3290, 3752],  //  7 — deep east                  (~wild 30)
    [3050, 3790],  //  8 — far west                   (~wild 34)
    [3105, 3800],  //  9 — far mid (Lava Maze area)    (~wild 36)
    [3240, 3800],  // 10 — far east                   (~wild 36)
    [2972, 3820],  // 11 — far west deep               (~wild 38)
];

const EDGEVILLE_BANK: [number, number] = [3093, 3491];
/** port: just north of the Wilderness border above Edgeville (274 has no ditch yet): a rescue's landing on the way out */
const EDGEVILLE_DITCH: [number, number, number] = [3093, 3523, 0];

// ── Constants ─────────────────────────────────────────────────────────────────

const SCAN_RADIUS      = 25;
const DISENGAGE_DIST   = 55;
/** port: a fight in which nothing lands for this many engage ticks (about 35 s) is given up (see handleEngage) */
const STALEMATE_TICKS = 30;

/** port: a player's combat XP (attack, defence, strength, hitpoints, ranged, magic): it rises with each hit landed */
function combatXp(p: Player): number {
    return p.stats[PlayerStat.ATTACK] + p.stats[PlayerStat.DEFENCE] + p.stats[PlayerStat.STRENGTH] + p.stats[PlayerStat.HITPOINTS] + p.stats[PlayerStat.RANGED] + p.stats[PlayerStat.MAGIC];
}
const ZONE_DURATION_MIN = 60;
const ZONE_DURATION_MAX = 130;
const ZONE_WANDER       = 18;
/**
 * port (the realism work, phase 2): at most points of its zone it reaches, a deep PKer lurks 5-60 s, as 2004's PKers
 * waited for prey to walk by (it scans for one meanwhile); upstream walked from point to point without a stop (moving 96 %
 * of its ticks). The humanlike report's C11 wants deep PKers still at least 30 % of the time.
 */
const LURK_CHANCE = 0.7;
const LURK_TICKS: [number, number] = [8, 100];
/**
 * port (the realism work, phase 3; "bot friend cliques ... PK together"): a PKer of a PK clique
 * (port/BotCliques) follows the first of its clique online: within CLIQUE_FOLLOW of it on the way to their zone, and on
 * patrol within CLIQUE_FAR once it moved off, it follows it (the game's Follow, a person's moment after it moved; stuck
 * behind a rock, a walk past it first: port/BotFollow.FollowDetour), stands beside it (within FORMATION) while it lurks
 * or fights, and fights its own target (one attacker a target, isTargetClaimed).
 */
const CLIQUE_FOLLOW = 15;
const CLIQUE_FAR = 80;
const FORMATION = 3;
const WILD_Z_START      = 3520;

// port (the realism work, phase 2): upstream's pools, each PKer saying its own few lines of them and of the 2004 PK
// lines (port/BotLines pkLine: from its name), and the patrol taunts a tenth as often: at 500 bots the 11 most-said
// lines were PK taunts to nobody, 117-164 times an hour each
const GL_PHRASES    = ['Gl', 'Gl noob', 'gl hf'];
const PATROL_TAUNTS = ['1v1?', 'looking for trouble', 'come out come out', 'safe spot?', 'gf gear', 'who wants some', 'free kills', 'anyone out here?'];
const FIGHT_TAUNTS  = ['get rekt', 'gg', 'nowhere to run', 'rip', 'gf noob', 'lol', 'u ded', 'ez'];
/** a patrol taunt: at a zone change now and then, and on patrol about once in 21 minutes (upstream: 0.4 and 0.008) */
const ZONE_TAUNT_CHANCE = 0.04;
const PATROL_TAUNT_CHANCE = 0.0008;

// ── Helpers ───────────────────────────────────────────────────────────────────

function chebyshev(ax: number, az: number, bx: number, bz: number): number {
    return Math.max(Math.abs(ax - bx), Math.abs(az - bz));
}

function wildernessLevel(z: number): number {
    if (z < WILD_Z_START) return 0;
    return Math.max(1, Math.floor((z - WILD_Z_START) / 8) + 1);
}

function inCombatRange(wildLevel: number, attackerCb: number, targetCb: number): boolean {
    if (wildLevel <= 0) return false;
    return Math.abs(attackerCb - targetCb) <= wildLevel;
}

function isFightingAnother(target: Player, self: Player): boolean {
    return target.target != null && 'slot' in target.target && target.target !== self;
}

/**
 * A player attacking this bot: one whose target is the bot with an attack op (port: a Follow or a trade is none; with the
 * realism work's PK cliques a follower targets its leader with the game's Follow, and the leader took it for an attacker
 * and turned on its friend). Never a clique-mate (port/BotCliques).
 */
function getAttacker(player: Player): Player | null {
    for (const p of (World as any).playerLoop.all() as Iterable<Player>) {
        if (p === player || p.slot === -1) continue;
        if (p.target !== player || (p.targetOp !== ServerTriggerType.APPLAYER2 && p.targetOp !== ServerTriggerType.OPPLAYER2)) continue;
        if (sameClique(player.username, p.username)) continue;
        // port (the realism work, phase 5b): not one a third player fights in a single-combat zone: the game refuses the
        // bot's attack on it ("Someone else is already fighting your opponent."), so it does not try
        if (foughtByOther(p, player)) continue;
        return p;
    }
    return null;
}

/**
 * port (the realism work, phase 5b): does a player other than `self` attack `target` (an attack op on it) where `target`
 * stands in a single-combat zone? 274's pvp_in_combat_check refuses a second attacker there ("Someone else is already
 * fighting your opponent."): a bot does not try (a team's pile is for multi-combat only: port/BotPkTeam)
 */
function foughtByOther(target: Player, self: Player): boolean {
    if (isMultiCombat(target.x, target.z, target.level)) return false;
    for (const p of (World as any).playerLoop.all() as Iterable<Player>) {
        if (p === self || p === target || p.slot === -1) continue;
        if (p.target === target && (p.targetOp === ServerTriggerType.APPLAYER2 || p.targetOp === ServerTriggerType.OPPLAYER2)) return true;
    }
    return false;
}

// port: upstream read `bot.task`, which BotPlayer does not have (its task is `currentTask`), so no target was ever
// claimed and in a multi-combat zone several PKers could go for the same player
// port (the realism work, phase 5b: PK team raids): a team-mate's claim is no claim where the raid lets the bot share the
// target (it stands in multi-combat and fewer than 3 of the team are on it: port/BotPkTeam mayShare)
function isTargetClaimed(target: Player, excludeBot: Player, raid: PkRaid | null = null): boolean {
    for (const p of (World as any).playerLoop.all() as Iterable<Player>) {
        if (p === target || p === excludeBot) continue;
        if (p.slot === -1) continue;
        const task = (p as any)._bot?.currentTask;
        if (task instanceof PKerTask && task.target === target) {
            if (raid && raid.sameTeam(excludeBot, p) && raid.mayShare(excludeBot, target)) continue;
            return true;
        }
    }
    return false;
}

function findNearbyRealPlayer(bot: Player, radius: number, blacklist?: Map<string, number>): Player | null {
    const wildLevel = wildernessLevel(bot.z);
    if (wildLevel <= 0) return null;
    if (wildernessLevelAt(bot.x, bot.z) <= 0) return null; // port: the real wilderness (x bounds too)
    // port (the realism work, phase 5b: PK team raids): its leader's target first, where the team may pile on it
    const raid = raidOf(bot);
    const team = raid?.teamTarget(bot) ?? null;
    if (team && !(team as any).is_bot && !blacklist?.has(team.username) && chebyshev(bot.x, bot.z, team.x, team.z) <= radius && inCombatRange(pvpWildernessLevel(bot, team), bot.combatLevel, team.combatLevel)) return team;

    let best: Player | null = null;
    let bestDist = radius + 1;
    for (const p of (World as any).playerLoop.all() as Iterable<Player>) {
        if (p === bot) continue;
        if ((p as any).is_bot) continue;
        if (p.level !== bot.level) continue;
        if (p.slot === -1) continue;
        // port: the cheap tests first, and the claim (a pass over every player) only for a player nearer than the best
        // so far: upstream checked the claim of every player in the world, a scan cost players²
        const d = chebyshev(bot.x, bot.z, p.x, p.z);
        if (d >= bestDist) continue;
        if (blacklist?.has(p.username)) continue;
        // port: the game's rule, the lower of both wilderness levels (the target must be in the wilderness too)
        if (!inCombatRange(pvpWildernessLevel(bot, p), bot.combatLevel, p.combatLevel)) continue;
        if (isTargetClaimed(p, bot, raid)) continue;
        // (port, phase 5b: nor one a third player fights in a single-combat zone: the game would refuse it)
        if (foughtByOther(p, bot)) continue;
        best = p;
        bestDist = d;
    }
    return best;
}

function findSlot(inv: { get: (s: number) => { id: number } | null; capacity: number }, itemId: number): number {
    for (let s = 0; s < inv.capacity; s++) {
        const it = inv.get(s);
        if (it && it.id === itemId) return s;
    }
    return -1;
}

// port: equipItem, regear and tryEquipFromInventory (the same in both PK tasks) are in port/BotPkGear.ts, imported
// under these names, with the port's fixes: no members item on a free world, 274's wearpos, the wear script's conflicts

// ── Task ──────────────────────────────────────────────────────────────────────

export class PKerTask extends BotTask {
    private state: 'init' | 'walk' | 'banking' | 'patrol' | 'engage' | 'tele' = 'init';

    private profile: PkerProfile | null = null;
    target: Player | null = null;  // public so isTargetClaimed can read it

    /** port: the world tick the attack may be clicked again, and the tick it was seen dropped (-1: it holds) (_reclickDue) */
    private reclickAt = 0;
    private droppedAt = -1;
    private engageTicks      = 0;
    /** port: when the bot last hit or was hit (its combat XP rose or its hitpoints fell), in engageTicks */
    private lastHitTick = 0;
    private lastCombatXp = 0;
    private lastHitpoints = 0;
    private stackFixed       = false;
    private stackAttempts    = 0;
    private stackWalkCooldown = 0;
    private respawnTimer     = 0;
    private gearVersion      = 0;
    private static readonly GEAR_VERSION = 1;

    private readonly blacklist = new Map<string, number>();
    /** port: the engage's tactics (port/BotPkTactics), and a beaten bot on its way out of the Wilderness */
    private tactics = newPkTactics();
    private escaping = false;
    /** port (PK tactics, 2026-10-19): the engage's fight (port/BotPkFight), and a teleport out under way */
    private fight: PkFight | null = null;
    private tele: PkTeleport | null = null;

    private zonePoolIdx   = 0;
    /** port: its first zone was chosen (the one nearest it) */
    private zoneChosen = false;
    private zoneTicks     = 0;
    private zoneDuration  = 0;
    private waypointX     = 0;
    private waypointZ     = 0;
    private waypointSet   = false;
    /** port: the world tick its lurk at a patrol point ends (LURK_TICKS) */
    private lurkUntil     = 0;
    /** port (the realism work, phase 3): the world tick it follows its PK clique's leader again (-1: not due) */
    private followDue     = -1;
    /** port (the variety work, round 1, track F): the bot (its patrol tile is given back at a reset) */
    private lastPlayer: Player | null = null;
    /** port (the realism work, phase 3): its Follow stuck behind a rock: a walk past it */
    private readonly detour = new FollowDetour();
    // rescanTimer inherited as protected from BotTask

    private readonly stuck    = new StuckDetector(25, 4, 2);
    private readonly watchdog = new ProgressWatchdog(300);
    /** port: the bot was south of the Wilderness at the last tick (the rescue's landing: see the constructor) */
    private belowWilderness = true;
    /** port (the realism work, phase 5b): a PK team raid's spot for it now (port/BotPkTeam), which is its zone meanwhile */
    private raidSpot: [number, number] | null = null;
    /**
     * port (the realism work, phase 5b): engage ticks with nothing of its own landing, its target fought by a third player
     * in a single-combat zone, before it gives up (drawn at each engagement)
     */
    private refusedAfter = 5;
    /** port (PK tactics, round 2: "PJing"): the fight a PJer waits by (port/BotPkPj), and its own last fight's end */
    private pj: PkPjWatch | null = null;
    private fightEndAt = -1000;

    constructor() {
        super('PKer');
        this.zonePoolIdx  = Math.floor(Math.random() * HUNTING_ZONES.length);
        this.zoneDuration = randInt(ZONE_DURATION_MIN, ZONE_DURATION_MAX);
        // port: a stalled PKer's rescue jump (unseen, as every jump) lands on its way: past the Edgeville ditch from
        // south of the Wilderness, else in its zone. With no destination it went to Lumbridge's spawn, where the
        // human mostly stands, and was refused: two deep PKers paced in Edgeville bank for a whole session
        this.watchdog.follow(() => {
            if (this.belowWilderness) return EDGEVILLE_DITCH;
            const [zx, zz] = this._currentZoneCoords();
            return [zx, zz, 0];
        });
    }

    shouldRun(_player: Player): boolean { return true; }

    /**
     * port (the realism work, phase 5b: PK team raids, port/BotPkTeam): a raid took it on: to the strip (its zone meanwhile);
     * a fight it is in goes on first
     */
    joinRaid(_player: Player): void {
        if (this.state === 'engage' || this.state === 'init' || this.state === 'banking') return;
        this.state = 'walk';
        this.waypointSet = false;
        this.lurkUntil = 0;
    }

    tick(player: Player): void {
        if (this.interrupted) return;
        this.lastPlayer = player;
        // port: no special attack left set without the special weapon in hand (port/BotPkGear)
        pkDropStaleSpecial(player);
        // port (the realism work, phase 5b): a PK team raid's spot is its zone meanwhile; back from one, on to its own zone
        {
            const was = this.raidSpot !== null;
            this.raidSpot = raidOf(player)?.spotFor(player) ?? null;
            if (was && this.raidSpot === null && this.state === 'patrol') {
                this.state = 'walk';
                this.waypointSet = false;
            }
        }

        // Tick down blacklist entries.
        for (const [k, v] of this.blacklist) {
            if (v <= 1) this.blacklist.delete(k);
            else this.blacklist.set(k, v - 1);
        }

        this.belowWilderness = player.z < WILD_Z_START;
        if (this.watchdog.check(player, false)) {
            player.clearWaypoints();
            player.clearPendingAction();
            this.interrupt();
            return;
        }

        // port (PK tactics, 2026-10-19): in danger a bite comes on the first tick the game allows, not on the fight's turn
        if (this.cooldown > 0 && this.state === 'engage' && this.fight && this.fight.target === this.target) {
            this.fight.observe(player);
            this.fight.eat(player, true);
        }
        if (this.cooldown > 0) { this.cooldown--; return; }

        if (!this.profile) {
            // port: on a free world a free profile, and any members gear from a members world goes to the bank
            // port: the bot's own build, from its name: the same at every login (upstream drew one at each start, so
            // with sessions a PKer's levels and combat level changed every time it came back)
            this.profile = pkerProfileFor(player.username, player);
            stripMembersItems(player);
        }

        // Force re-init when gear version bumps.
        if (this.gearVersion < PKerTask.GEAR_VERSION) {
            this.gearVersion = PKerTask.GEAR_VERSION;
            this.target = null;
            this.state = 'init';
            this.stackFixed = false;
            this.respawnTimer = randInt(10, 40);
            this.watchdog.notifyActivity();
            return;
        }

        switch (this.state) {
            case 'init':    return this.handleInit(player);
            case 'walk':    return this.handleWalk(player);
            case 'banking': return this.handleBanking(player);
            case 'patrol':  return this.handlePatrol(player);
            case 'engage':  return this.handleEngage(player);
            case 'tele':    return this.handleTele(player);
        }
    }

    /** port: drops the target and the engine's attack on it (upstream kept the attack: see handleBanking) */
    private _dropTarget(player: Player): void {
        this.target = null;
        if (player.target && 'slot' in player.target) player.clearPendingAction();
        // port (PK tactics): a KO weapon left in hand goes back for the main one
        this.fight?.disarm(player);
        if (this.fight) this.fightEndAt = World.currentTick;
        this.fight = null;
    }

    /**
     * port (PK tactics, round 2): a player a PJer may jump: a real player (as its targets: findNearbyRealPlayer) on its
     * level, in combat range, not one it gave up on nor its team's; `now`, also not another's target, nor fought by a
     * third player (the game would refuse it)
     */
    private _mayJump(player: Player, p: Player, now: boolean): boolean {
        if ((p as any).is_bot || p.level !== player.level || this.blacklist.has(p.username) || sameClique(player.username, p.username)) return false;
        if (!inCombatRange(pvpWildernessLevel(player, p), player.combatLevel, p.combatLevel)) return false;
        const raid = raidOf(player);
        if (raid?.sameTeam(player, p)) return false;
        return !now || (!isTargetClaimed(p, player, raid) && !foughtByOther(p, player));
    }

    /**
     * port (PK tactics, 2026-10-19): out of the fight and the Wilderness (port/BotPkFight flee): a teleport where the
     * level allows its glory (30) or its spell (20), else a run south to the bank, teleporting once it is shallow enough
     * (handleBanking)
     */
    private _getOut(player: Player, how: 'run' | 'tele'): void {
        const t = this.target;
        this._dropTarget(player);
        if (t) this.blacklist.set(t.username, 200);
        pkSayEscape(player);
        // (in a PK team raid it tells the team: two out and the team goes home, port/BotPkTeam)
        raidOf(player)?.noteOut(player);
        this.escaping = true;
        player.run = 1;
        this.tele = how === 'tele' && this.profile ? new PkTeleport(player, this.profile) : null;
        this.state = this.tele ? 'tele' : 'banking';
        this.watchdog.notifyActivity();
    }

    /** port (PK tactics): a teleport out, a step a tick; then the bank (a glory lands at Edgeville, the spell in Varrock) */
    private handleTele(player: Player): void {
        const step = this.tele?.tick(player) ?? 'failed';
        this.watchdog.notifyActivity();
        if (step === 'casting') return;
        this.tele = null;
        this.state = 'banking';
        player.run = 1;
        // (a failed one: on foot from here, no second try)
        if (step === 'failed') this.teleFailed = true;
    }
    /** port (PK tactics): its teleport out failed this escape: it runs the rest */
    private teleFailed = false;

    /**
     * port (PK tactics): out of a fight, a bite when hurt (port/BotPkFight pkTopUp); and when hit by one it may not hit
     * back (a third player's fight in single combat) and hurt, it gets out. True when it got out.
     */
    private _outOfFight(player: Player): boolean {
        if (!this.profile) return false;
        if (!this.escaping && player.levels[PlayerStat.HITPOINTS] < player.baseLevels[PlayerStat.HITPOINTS] * 0.6 && pkHitBy(player)) {
            this._getOut(player, 'run');
            return true;
        }
        pkTopUp(player, this.profile);
        return false;
    }

    /**
     * port (the realism work, phase 2): the attack clicked again. While it lasts, now and then (every 4-6 ticks, as
     * upstream's every 5th engage tick); once it dropped (eating, a potion, a special's swap), a person's moment after
     * the bot noticed (BotTiming 'retarget'). Upstream re-clicked on every 5th tick whatever happened, so a dropped attack
     * came back in step (the humanlike report's H18: 11-14 % of the Edgeville PKers' intervals the same)
     */
    private _reclickDue(player: Player, target: Player): boolean {
        const now = World.currentTick;
        if (player.target === target) {
            this.droppedAt = -1;
            if (now < this.reclickAt) return false;
            this.reclickAt = now + randInt(4, 6);
            return true;
        }
        if (this.droppedAt < 0) {
            this.droppedAt = now;
            this.reclickAt = now + 1 + humanDelay(player, 'retarget');
        }
        if (now < this.reclickAt) return false;
        this.droppedAt = -1;
        this.reclickAt = now + randInt(4, 6);
        return true;
    }

    isComplete(): boolean { return false; }

    /** port (the realism work, phase 3): what a friend of its PK clique follows: its zone, and whether it patrols, lurks or fights */
    cliqueView(): { zone: number; centre: [number, number]; state: string; patrol: boolean; lurking: boolean; fighting: boolean } {
        return { zone: this.zonePoolIdx, centre: this._currentZoneCoords(), state: this.state, patrol: this.state === 'patrol' || this.state === 'walk', lurking: this.state === 'patrol' && World.currentTick < this.lurkUntil, fighting: this.state === 'engage' && this.target !== null };
    }

    /** port (the realism work, phase 3): the leader of its PK clique on patrol (or on its way), with its view; null: it leads or patrols alone */
    private _leader(player: Player): { lead: Player; view: ReturnType<PKerTask['cliqueView']> } | null {
        const lead = pkCliqueLeader(player);
        if (!lead || lead.level !== player.level) return null;
        const task = (lead as any)._bot?.currentTask;
        if (!(task instanceof PKerTask)) return null;
        const view = task.cliqueView();
        return view.patrol || view.fighting ? { lead, view } : null;
    }

    override reset(): void {
        super.reset();
        if (this.lastPlayer) releaseStandTile(this.lastPlayer); // (variety round 1, F: its patrol tile back)
        this.state = 'init';
        this.target = null;
        this.engageTicks = 0;
        this.stackFixed = false;
        this.stackAttempts = 0;
        this.stackWalkCooldown = 0;
        this.respawnTimer = 0;
        this.zoneTicks = 0;
        this.waypointSet = false;
        this.lurkUntil = 0;
        this.followDue = -1;
        this.detour.reset();
        this.rescanTimer = 0;
        this.blacklist.clear();
        this.stuck.reset();
        this.watchdog.reset();
        // profile and zonePoolIdx intentionally kept — bot retains identity across cycles
    }

    // ── States ────────────────────────────────────────────────────────────────

    private handleInit(player: Player): void {
        const p = this.profile!;

        pkSetLevels(player, p);

        if (this.respawnTimer > 0) {
            this.respawnTimer--;
            return;
        }

        this.replenish(player);

        // port: walked to (walk; a rescue jump only for a stuck bot, unseen): the zone nearest the
        // bot to start with. Upstream teleported to a random zone, wild 18-38, where 2004 blocked teleports
        if (!this.zoneChosen) {
            this.zoneChosen = true;
            this.zonePoolIdx = this._nearestZone(player.x, player.z);
        }
        const [zx, zz] = this._currentZoneCoords();
        console.log(`[PKerTask] ${player.displayName} profile=${p.name} cb=${player.combatLevel} zone=${zx},${zz}`);
        this.state    = 'walk';
        this.cooldown = randInt(2, 4);
    }

    private replenish(player: Player): void {
        const p = this.profile!;
        player.getInventory(InvType.INV)?.removeAll();
        stripMembersItems(player); // port: (a free world) nothing members-only stays worn

        // port: usableOnThisWorld below: no members item on a free world, whatever the profile says (a free world's
        // profiles have none), and -1 (none) as before
        for (const id of [p.weapon, p.helm, p.body, p.legs, p.shield, p.neck, p.cape, p.boots, p.gloves, p.ammo]) {
            if (!usableOnThisWorld(id)) continue;
            if (!_wornContains(player, id) && !hasItem(player, id)) {
                addItem(player, id, 1);
            }
        }
        regear(player, p);
        setVarp(player, 'sa_energy', 300, 1000);

        if (usableOnThisWorld(p.ammo)) {
            const worn = player.getInventory(InvType.WORN);
            if (worn) {
                const ammoWearSlot = ObjType.get(p.ammo).wearpos; // port: -1 (not null) when it cannot be worn
                if (ammoWearSlot !== -1) {
                    const existing = worn.get(ammoWearSlot);
                    if (existing && existing.id === p.ammo) {
                        // (port, PK tactics: a ranger's quiver, not upstream's 25)
                        worn.set(ammoWearSlot, { id: p.ammo, count: p.ammoCount || 25 });
                    }
                }
            }
        }

        // (port, PK tactics round 2: not one it wields: a ranger's shortbow is its main weapon, and its KO a 1-Attack one's)
        if (usableOnThisWorld(p.specWeapon) && !_wornContains(player, p.specWeapon) && !hasItem(player, p.specWeapon)) addItem(player, p.specWeapon, 1);
        if (usableOnThisWorld(p.rangeWeapon) && !_wornContains(player, p.rangeWeapon) && !hasItem(player, p.rangeWeapon)) addItem(player, p.rangeWeapon, 1);
        for (const potId of p.pots) {
            if (usableOnThisWorld(potId) && !hasItem(player, potId)) addItem(player, potId, 1);
        }
        // port (PK tactics): its way out (a charged glory, a teleport's runes) and the Magic for the spell
        for (const [id, n] of pkTeleItems(p)) {
            if (usableOnThisWorld(id)) addItem(player, id, n);
        }
        pkSetMagic(player, p);
        pkRecharge(player); // (round 2: its prayer points, for the boosts)
        const foodCount = usableOnThisWorld(p.food) ? countItem(player, p.food) : 20;
        for (let i = 0; i < 20 - foodCount && !isInventoryFull(player); i++) {
            addItem(player, p.food, 1);
        }
    }

    private handleWalk(player: Player): void {
        // port: the fight's prayers off (they drain the points: port/BotPkTactics)
        if (pkPrayersOff(player)) {
            this.cooldown = 1;
            return;
        }
        // port (PK tactics, 2026-10-19): someone attacking it on its way (it walked on under the hits), a bite when hurt
        const attacker = getAttacker(player);
        if (attacker) {
            this.target = attacker;
            this.engageTicks = 0;
            this.state = 'engage';
            this.watchdog.notifyActivity();
            return;
        }
        if (this._outOfFight(player)) return;
        // port (the realism work, phase 3): a PK clique's follower goes to its leader's zone, following it when near
        const led = this._leader(player);
        if (led) {
            this.zonePoolIdx = led.view.zone;
            this.zoneChosen = true;
        }
        const [zx, zz] = this._currentZoneCoords();
        if (!isNear(player, zx, zz, ZONE_WANDER + 5)) {
            if (led && chebyshev(player.x, player.z, led.lead.x, led.lead.z) <= CLIQUE_FOLLOW) {
                if (!this.detour.check(player, led.lead, this._following(player, led.lead)) && !this._following(player, led.lead)) this._followLater(player, led.lead, true);
                this.watchdog.notifyActivity();
                this.cooldown = 1;
                return;
            }
            // port: walked to, however far (upstream teleported to any zone over 120 tiles away)
            this.stuckWalk(player, zx + randInt(-8, 8), zz + randInt(-8, 8));
            this.cooldown = 1;
            return;
        }
        if (led && player.target === led.lead) player.clearInteraction();
        this.waypointSet = false;
        this.state = 'patrol';
    }

    private handleBanking(player: Player): void {
        // If something attacked the bot on the way back, engage it.
        // port: someone attacking the bot (upstream took the bot's own target: its attack on a player it had just
        // given up on was still set, so it re-engaged, gave up again and stood frozen on one tile, every tick)
        // port: not while it runs out of the Wilderness, beaten (port/BotPkTactics)
        const attacker = this.escaping ? null : getAttacker(player);
        if (attacker) {
            this.target = attacker;
            this.engageTicks = 0;
            this.state = 'engage';
            this.watchdog.notifyActivity();
            return;
        }

        if (this._outOfFight(player)) return;
        // port (PK tactics): running out deep, its glory or spell once the level allows it
        if (this.escaping && !this.teleFailed && this.profile && wildernessLevelAt(player.x, player.z) > 0 && pkCanTele(player, this.profile)) {
            this.tele = new PkTeleport(player, this.profile);
            this.state = 'tele';
            this.watchdog.notifyActivity();
            return;
        }
        const [bx, bz] = EDGEVILLE_BANK;
        this.stuckWalk(player, bx, bz);

        if (isNear(player, bx, bz, 5)) {
            this.replenish(player);
            this.escaping = false;
            this.teleFailed = false;
            this.waypointSet = false;
            // port: walks back out (upstream teleported to its zone)
            this.state    = 'walk';
            this.cooldown = randInt(2, 4);
        }
        this.watchdog.notifyActivity();
    }

    private handlePatrol(player: Player): void {
        // port: the fight's prayers off (they drain the points: port/BotPkTactics)
        if (pkPrayersOff(player)) {
            this.cooldown = 1;
            return;
        }
        // port (PK tactics): a bite when hurt; out when hit by one it may not hit back
        if (this._outOfFight(player)) return;
        this.zoneTicks++;

        // port (PK tactics, round 2: "PJing"): a PJer by a fight, off it a few tiles, until it may jump the one
        // left of it (port/BotPkPj: the game's 8 ticks after its last hit)
        if (this.pj) {
            const next = this.pj.next(player, p => this._mayJump(player, p, true), SCAN_RADIUS);
            if (next === 'over') {
                this.pj = null;
            } else if (next) {
                this.pj = null;
                this.target = next;
                this.engageTicks = 0;
                this.state = 'engage';
                releaseStandTile(player);
                interactPlayerOp(player, next.slot, 2);
                walkTo(player, next.x, next.z);
                noteSpectacle(player, 'pk');
                this.lurkUntil = 0;
                this.watchdog.notifyActivity();
                return;
            } else {
                const spot = this.pj.spot(player);
                if (spot && !player.hasWaypoints()) walkTo(player, spot[0], spot[1]);
                this.watchdog.notifyActivity();
                this.cooldown = 1;
                return;
            }
        }

        // Throttled target scan.
        if (this.rescanTimer <= 0) {
            // (round 2) a PJer: a fight near it first, to wait by (not in a raid: the team's spot holds it)
            if (!raidOf(player) && pkWaysOf(player.username).pj) {
                const watch = pkFightToWatch(player, SCAN_RADIUS, p => this._mayJump(player, p, false));
                if (watch) {
                    this.pj = watch;
                    this.watchdog.notifyActivity();
                    this.cooldown = 1;
                    return;
                }
            }
            const found = findNearbyRealPlayer(player, SCAN_RADIUS, this.blacklist);
            if (found) {
                // (a team-mate on it already: the team piles on, in multi-combat only: port/BotPkTeam)
                const raid = raidOf(player);
                if (raid && raid.mayShare(player, found) && isTargetClaimed(found, player)) raid.notePile(player, found);
                this.target = found;
                this.engageTicks = 0;
                this.state = 'engage';
                releaseStandTile(player); // (variety round 1, F: its patrol tile back)
                    sayPk(player, pkLine(player, 'gl', GL_PHRASES));
                interactPlayerOp(player, found.slot, 2);
                walkTo(player, found.x, found.z);
                noteSpectacle(player, 'pk'); // port (the realism work): a fight draws a look (port/BotHabits)
                this.lurkUntil = 0;
                this.watchdog.notifyActivity();
                return;
            }
            this.rescanTimer = randInt(3, 6);
        } else {
            this.rescanTimer--;
        }

        // port (the realism work, phase 3): a PK clique's follower patrols with its leader (its zone, near it, lurking with it)
        const led = this._leader(player);
        if (led && this._patrolWith(player, led)) return;

        // Cycle zone after spending enough time here.
        // port (the realism work, phase 5b): not on a raid (its zone is the raid's spot)
        if (this.zoneTicks >= this.zoneDuration && !this.raidSpot) {
            this.zoneTicks    = 0;
            this.zoneDuration = randInt(ZONE_DURATION_MIN, ZONE_DURATION_MAX);
            // port: on to one of the two zones nearest this one, walked (upstream: the next in a fixed order, often 150+
            // tiles off, by teleport)
            this.zonePoolIdx  = this._neighbourZone(this.zonePoolIdx);
            this.waypointSet  = false;
            if (Math.random() < ZONE_TAUNT_CHANCE) sayPk(player, pkLine(player, 'patrol', PATROL_TAUNTS));
            this.state = 'walk';
            return;
        }

        // Wander within zone.
        const [zx, zz] = this._currentZoneCoords();
        const lurking = World.currentTick < this.lurkUntil;
        if (!lurking && (!this.waypointSet || isNear(player, this.waypointX, this.waypointZ, 3))) {
            // port: a patrol point reached is progress (upstream never told the watchdog while patrolling, so in an
            // empty Wilderness the bot was teleported home about every 5 minutes); a bot that cannot reach one still is
            if (this.waypointSet) this.watchdog.notifyActivity();
            // port (the realism work): and there it lurks a while, most times (LURK_TICKS), before the next point
            if (this.waypointSet && Math.random() < LURK_CHANCE) this.lurkUntil = World.currentTick + randInt(...LURK_TICKS);
            this.waypointX  = zx + randInt(-ZONE_WANDER, ZONE_WANDER);
            this.waypointZ  = zz + randInt(-ZONE_WANDER / 2, ZONE_WANDER / 2);
            this.waypointSet = true;
            // port (the variety work, round 1, track F: H4's PKer/patrol stacking): a tile of its own at the point, where it
            // lurks (port/BotTiles): deep PKers lurked on random points with no claim, 2,501 of 9,051 idle bot-samples
            // stacked on a shared tile at 500 bots
            const own = claimStandTile(player, this.waypointX, this.waypointZ, player.level, 3);
            if (own) [this.waypointX, this.waypointZ] = own;
        }

        if (World.currentTick >= this.lurkUntil) this.stuckWalk(player, this.waypointX, this.waypointZ);

        if (Math.random() < PATROL_TAUNT_CHANCE) sayPk(player, pkLine(player, 'patrol', PATROL_TAUNTS));

        this.cooldown = 1;
    }

    private handleEngage(player: Player): void {
        const t = this.target;
        if (!t || t.slot === -1) {
            this._dropTarget(player);
            this.state  = 'banking';
            return;
        }

        this.engageTicks++;

        // port (PK tactics, 2026-10-19): its fight (port/BotPkFight) from the first tick on a target; getting out and a
        // bite before anything else (a player eats and runs whatever happens with the targets around it)
        if (this.engageTicks === 1 || this.fight?.target !== t) {
            this.fight?.disarm(player);
            this.fight = this.profile ? new PkFight(player, t, this.profile, true) : null;
        }
        const fight = this.fight;
        fight?.observe(player);
        if (fight) {
            const how = fight.flee(player);
            if (how) {
                this._getOut(player, how);
                return;
            }
            fight.eat(player);
        }
        // (round 2) in a fight: no fight to wait by; jumped just after its own fight: a PJer, and now and then a line at it
        if (this.engageTicks === 1) this.pj = null;
        if (this.engageTicks === 1 && t.target === player && World.currentTick - this.fightEndAt <= PJED_WITHIN) pkSayPjed(player);

        // Bail if target was already fighting someone else on tick 1.
        // port (the realism work, phase 5b): not a team-mate's fight in a raid, where the team piles on (multi-combat)
        const raid = raidOf(player);
        const teamFight = raid !== null && t.target instanceof Player && raid.sameTeam(player, t.target) && raid.mayShare(player, t);
        if (this.engageTicks === 1 && isFightingAnother(t, player) && !teamFight) {
            this.blacklist.set(t.username, 100);
            this._dropTarget(player);
            sayPk(player, pkFixedLine(player, 'Oops, sorry!')); // port: the word filter masks "Woops"; not twice in a place in 10 minutes
            walkTo(player, player.x + randInt(-6, 6), player.z + randInt(-6, 6));
            this.state    = 'patrol';
            this.cooldown = randInt(3, 6);
            this.watchdog.notifyActivity();
            return;
        }

        // Switch to whoever is attacking the bot if the target isn't.
        if (this.engageTicks > 3) {
            const hitsMe = t.target && 'slot' in t.target && t.target === player;
            if (!hitsMe) {
                const attacker = getAttacker(player);
                if (attacker && attacker !== t) {
                    this.target = attacker;
                    this.engageTicks = 0;
                    this.watchdog.notifyActivity();
                    return;
                }
            }
        }

        if (chebyshev(player.x, player.z, t.x, t.z) > DISENGAGE_DIST) {
            if (this.engageTicks > 5) pkSayRan(player); // (port, PK tactics: it teleported off)
            this._dropTarget(player);
            this.state  = 'banking';
            return;
        }

        // Drop target if combat range is no longer legal (fled to shallower wild).
        const wildLevel = pvpWildernessLevel(player, t); // port: both players' levels, not only the bot's
        if (!inCombatRange(wildLevel, player.combatLevel, t.combatLevel)) {
            if (this.engageTicks > 5) pkSayRan(player); // (port, PK tactics: it ran off, shallower)
            this._dropTarget(player);
            this.state  = 'banking';
            return;
        }

        // port: give up on a fight in which nothing lands for STALEMATE_TICKS: a target the bot cannot reach (a wall,
        // the ditch) or one busy fighting someone else. Upstream re-clicked the attack every 5 ticks, which also fed the
        // watchdog, and stayed engaged for good. Only the bot's own hits and the hits it takes count (food and
        // regeneration do not, nor the target's fight with a third player).
        const xpNow = combatXp(player);
        const hpNow = player.levels[PlayerStat.HITPOINTS];
        const landed = this.engageTicks <= 1 || xpNow !== this.lastCombatXp || hpNow < this.lastHitpoints;
        this.lastCombatXp = xpNow;
        this.lastHitpoints = hpNow;
        if (landed) {
            this.lastHitTick = this.engageTicks;
        } else if (this.engageTicks - this.lastHitTick > STALEMATE_TICKS) {
            this.blacklist.set(t.username, 300);
            this._dropTarget(player);
            this.state = 'patrol';
            this.watchdog.notifyActivity();
            return;
        }
        // port (the realism work, phase 5b): its target fought by a third player in a single-combat zone and nothing of its
        // own landing: the game refuses its attacks ("Someone else is already fighting your opponent."), and a player who
        // read that gives up within seconds (upstream looked only at the first tick, then the stalemate's 30)
        if (this.engageTicks === 1) this.refusedAfter = randInt(3, 8);
        else if (!teamFight && this.engageTicks - this.lastHitTick > this.refusedAfter && foughtByOther(t, player)) {
            this.blacklist.set(t.username, 300);
            this._dropTarget(player);
            this.state = 'patrol';
            this.watchdog.notifyActivity();
            return;
        }

        // port: smarter PKers (port/BotPkTactics): a kill line and the fight over, prayers; (PK tactics)
        // port/BotPkFight: getting out, eating, potions, the KO switch
        if (this.engageTicks === 1) this.tactics = newPkTactics();
        // port (the realism work, phase 5b): in a raid it runs sooner (under 40 % with no food), and tells the team
        if (raid && player.levels[PlayerStat.HITPOINTS] < player.baseLevels[PlayerStat.HITPOINTS] * raid.escapeBelow && !this.hasFood(player)) {
            this._getOut(player, this.profile && pkCanTele(player, this.profile) ? 'tele' : 'run');
            return;
        }
        if (this.profile) {
            // (round 2: the melee boosts, port/BotPkFight offence)
            const outcome = pkEngageTactics(player, t, this.tactics, { offence: fight?.offence(player) ?? false });
            if (outcome === 'killed') {
                noteSpectacle(t, 'pk'); // port (the realism work): the kill and its drop draw a look (port/BotHabits)
                this._dropTarget(player);
                // (PK tactics) little food left after it: the bank first, as people restocked between fights
                this.state = pkFoodLeft(player, this.profile) <= pkWaysOf(player.username).restockAt ? 'banking' : 'patrol';
                this.watchdog.notifyActivity();
                return;
            }
        }
        // (one of them a turn: a dose, the KO weapon on; the attack is clicked again below)
        if (fight && (fight.potions(player) || fight.koStep(player))) this.watchdog.notifyActivity();

        // Stacking detection.
        const stackedWith = this.isStackedWith(player);
        if (stackedWith) {
            this.stackAttempts++;
            const allDirs: [number, number][] = [[1,0], [-1,0], [0,1], [0,-1]];
            const dirIndex = (this.stackAttempts - 1) % 4;
            const isMover  = player.slot > (stackedWith as any).slot;

            if (this.stackWalkCooldown <= 0) {
                let dx: number, dz: number;
                if (isMover) {
                    [dx, dz] = allDirs[dirIndex]!;
                } else {
                    const [mx, mz] = allDirs[dirIndex]!;
                    dx = -mx; dz = -mz;
                }
                const tx = player.x + dx;
                const tz = player.z + dz;
                // port: within the bots' per-tick search budget (else the next tick)
                if (pathBudgetLeft() > 0) {
                    const path = botWalkPath(player.level, player.x, player.z, tx, tz);
                    if (path.length > 0) walkTo(player, tx, tz);
                    this.stackWalkCooldown = 6;
                }
            } else {
                this.stackWalkCooldown--;
                if (this._reclickDue(player, t)) {
                    interactPlayerOp(player, t.slot, 2);
                    this.watchdog.notifyActivity();
                }
            }
        } else {
            this.stackWalkCooldown = 0;
            if (this.stackAttempts > 0) this.stackFixed = true;
            this.stackAttempts = 0;
            // (port, PK tactics: a ranger shoots from where it stands, its bow's reach; the game walks a melee KO in)
            if (!this.stackFixed && this.profile?.style !== 'ranged') {
                if (chebyshev(player.x, player.z, t.x, t.z) > 1) walkTo(player, t.x, t.z);
            }
            if (this._reclickDue(player, t)) {
                interactPlayerOp(player, t.slot, 2);
                this.watchdog.notifyActivity();
            }
        }

        if (Math.random() < 0.015) sayPk(player, pkLine(player, 'fight', FIGHT_TAUNTS));

        this.cooldown = 1;
    }

    // ── Combat helpers ────────────────────────────────────────────────────────

    /** port: food it can eat in its pack (a raid's escape: port/BotPkTeam) */
    private hasFood(player: Player): boolean {
        return this.profile !== null && pkFoodLeft(player, this.profile) > 0;
    }

    private isStackedWith(player: Player): Player | null {
        for (const p of (World as any).playerLoop.all() as Iterable<Player>) {
            if (p === player || p.slot === -1) continue;
            if (p.x === player.x && p.z === player.z && p.level === player.level) return p;
        }
        return null;
    }

    // ── Locomotion ────────────────────────────────────────────────────────────

    /** port: the hunting zone nearest (x, z) */
    private _nearestZone(x: number, z: number): number {
        let best = 0;
        for (let i = 1; i < HUNTING_ZONES.length; i++) {
            if (Math.max(Math.abs(HUNTING_ZONES[i][0] - x), Math.abs(HUNTING_ZONES[i][1] - z)) < Math.max(Math.abs(HUNTING_ZONES[best][0] - x), Math.abs(HUNTING_ZONES[best][1] - z))) best = i;
        }
        return best;
    }

    /** port: one of the two zones nearest zone `i` */
    private _neighbourZone(i: number): number {
        const [x, z] = HUNTING_ZONES[i];
        const others = HUNTING_ZONES.map(([zx, zz], j) => [j, Math.max(Math.abs(zx - x), Math.abs(zz - z))] as const).filter(([j]) => j !== i).sort((a, b) => a[1] - b[1]);
        return others[Math.floor(Math.random() * Math.min(2, others.length))][0];
    }

    /**
     * port (the realism work, phase 3): a patrol turn beside its PK clique's leader: its leader's zone (another: walk
     * there); the game's Follow once its leader has moved off (FORMATION + 3 tiles: a person's moment later; stuck behind
     * a rock, a walk past it first), standing beside it (within FORMATION, never on its tile) once it lurks or fights;
     * the scan before this finds its own target. True when the turn is done (false: the leader is far, patrol alone).
     */
    private _patrolWith(player: Player, led: { lead: Player; view: ReturnType<PKerTask['cliqueView']> }): boolean {
        const { lead, view } = led;
        if (view.zone !== this.zonePoolIdx && !view.fighting) {
            this.zonePoolIdx = view.zone;
            this.waypointSet = false;
            this.state = 'walk';
            return true;
        }
        const d = chebyshev(player.x, player.z, lead.x, lead.z);
        if (d > CLIQUE_FAR) return false;
        this.zoneTicks = 0;
        this.waypointSet = false;
        // (its Follow stuck behind a rock: a walk past it, then the Follow again)
        if (this.detour.check(player, lead, this._following(player, lead))) {
            this.followDue = -1;
            this.watchdog.notifyActivity();
            this.cooldown = 1;
            return true;
        }
        if (this._following(player, lead)) {
            // (behind: it runs to catch up, while it has the energy)
            if (d > FORMATION + 2 && player.runenergy >= 1000) player.run = 1;
            if (d <= FORMATION && (view.lurking || view.fighting)) {
                player.clearInteraction();
                this.followDue = -1;
                // (not on its leader's very tile: a step aside; port, variety round 1, F: nor on another's, to a tile of its own
                // beside the leader: two followers of one leader stood on one tile)
                if (d === 0 || sharesTile(player)) {
                    const own = claimStandTile(player, lead.x, lead.z, lead.level, FORMATION, (x, z) => x !== lead.x || z !== lead.z);
                    if (!own || !stepToTile(player, own[0], own[1])) walkTo(player, player.x + (Math.random() < 0.5 ? 1 : -1), player.z + randInt(-1, 1));
                }
            }
        } else this._followLater(player, lead, d > FORMATION + 3);
        this.watchdog.notifyActivity();
        this.cooldown = 1;
        return true;
    }

    /** port (the realism work, phase 3): the bot follows `lead` with the game's Follow now */
    private _following(player: Player, lead: Player): boolean {
        return player.target === lead && (player.targetOp === ServerTriggerType.APPLAYER3 || player.targetOp === ServerTriggerType.OPPLAYER3);
    }

    /** port (the realism work, phase 3): when `due`, the Follow a person's moment after (BotTiming 'retarget'), not in the tick it was seen */
    private _followLater(player: Player, lead: Player, due: boolean): void {
        if (!due) {
            this.followDue = -1;
            return;
        }
        const now = World.currentTick;
        if (this.followDue < 0) this.followDue = now + 1 + humanDelay(player, 'retarget');
        else if (now >= this.followDue) {
            this.followDue = -1;
            interactPlayerOp(player, lead.slot, 3);
        }
    }

    private _currentZoneCoords(): [number, number] {
        // port (the realism work, phase 5b): a PK team raid's spot (port/BotPkTeam) is its zone meanwhile
        if (this.raidSpot) return this.raidSpot;
        return HUNTING_ZONES[this.zonePoolIdx % HUNTING_ZONES.length] ?? [3100, 3752];
    }

    private stuckWalk(player: Player, tx: number, tz: number): void {
        if (!this.stuck.check(player, tx, tz)) { walkTo(player, tx, tz); return; }
        if (this.stuck.desperatelyStuck) {
            this.respawnTimer = randInt(10, 40);
            this.state = 'init';
            this.target = null;
            this.stackFixed = false;
            this.stuck.reset();
            this.watchdog.notifyActivity();
            return;
        }
        walkTo(player, player.x + randInt(-10, 10), player.z + randInt(-10, 10));
    }
}
