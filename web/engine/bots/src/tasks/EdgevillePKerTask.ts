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
    removeItem,
    countItem,
    isInventoryFull,
    teleportNear,
    StuckDetector,
    ProgressWatchdog,
    Items,
    FOOD_IDS,
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
import { noteSpectacle } from '#/engine/bot/port/BotHabits.js';
import { pkCliqueLeader, pkCliqueMates, sameClique } from '#/engine/bot/port/BotCliques.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
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
    ADAMANT_FULL_HELM: 1161,
    ADAMANT_PLATEBODY: 1123,
    ADAMANT_PLATELEGS: 1073,
    ADAMANT_KITESHIELD: 1199,
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
const DHIDE_BODIES: [number, number, number][] = [
    [I.GREEN_DHIDE_BODY, 40, 1],
    [I.BLUE_DHIDE_BODY, 50, 1],
    [I.RED_DHIDE_BODY, 60, 1],
    [I.BLACK_DHIDE_BODY, 70, 1],
];
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

// port (the realism work, phase 2): upstream's pool, each PKer saying its own few lines of it and of the 2004 lines
// (port/BotLines pkLine: from its name), at half its fights: "Gl ****" (the filter's "Gl noob") was the line most said
// by two bots in one place, 55 times in two hours at the ditch
const GL_PHRASES = ['Gl', 'Gl noob', 'Attack is a newb so ill take my anger out on you'];
const GL_CHANCE = 0.5;
/** (2026-10-19) a call for a fight at a rescan with nobody to fight (every 4-7 ticks): about one in 3 minutes a PKer */
const WAIT_CALL = 0.02;

/** port: port/BotPkGear's shape (the same fields as upstream's), with the kit's (port/BotPkFight pkKitted) */
type PkerProfile = PkProfile;

function bestByLevel(items: [number, number, number][], level: number): number {
    let best = items[0]![0];
    for (const [id, req] of items) {
        if (level >= req) best = id;
    }
    return best;
}

function pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(Math.random() * arr.length)]!;
}

/** The members world's profiles (exported for test/pk.test.mjs: the same tables at every start). */
export function generateEdgevillePkerProfiles(): PkerProfile[] {
    // port: the same tables at every start (seeded), so a PKer's build, picked by its name, never changes
    const rand = seededRandom(0x504b0002);
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
            // port (PK tactics, 2026-10-19): a pure (Defence 1) cannot wear a d'hide body (274's levelrequire: 40
            // Defence); the PK tasks' gear goes on past the wear script, so the Edgeville pures wore one (PKerTask's had
            // this fix): a monk's robe or a leather body
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

        const rune = def >= 40;
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
            // port (2026-10-20, play-testing: no gear above a bot's levels): a main under 40 Defence in adamant (274's
            // levelrequire: rune's 40 Defence); the PK tasks' gear goes on past the wear script, so the 30s wore rune
            helm: def >= 60 && i % 3 === 0 ? I.DRAGON_MED_HELM : rune ? I.RUNE_FULL_HELM : I.ADAMANT_FULL_HELM,
            body: rune ? I.RUNE_PLATEBODY : I.ADAMANT_PLATEBODY,
            legs: rune ? I.RUNE_PLATELEGS : I.ADAMANT_PLATELEGS,
            shield: rune ? I.RUNE_KITESHIELD : I.ADAMANT_KITESHIELD,
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

const PROFILES = generateEdgevillePkerProfiles();
/** port: a free world's PKers wear and use only free items (port/BotPkGear.ts) */
const FREE_WORLD_PROFILES: PkerProfile[] = freeWorldPkProfiles();

/**
 * port: the build of the bot with this (normalised) name on this world: the same at every login (BotSeed). With the bot
 * (its login's pick): the class's look only for a PKer new since round 1 or saved in it (port/BotOutfits pkProfileAtLogin)
 */
export function edgevillePkerProfileFor(username: string, player?: Player): PkerProfile {
    const profiles = isMembersWorld() ? PROFILES : FREE_WORLD_PROFILES;
    const profile = profiles[nameIndex(username, 'edgeville_pker', profiles.length)]!;
    // port (the variety work, round 2, track W2: WEAR-8) its gloves, boots, amulet, helm, legs and weapon from its own seed
    // (port/BotFashion pkVariedProfile; a class name's hat kept), on round 1's class look
    const members = isMembersWorld();
    const classed = classPkProfile(username, profile, 'edgeville_pker') !== null;
    // port (PK tactics, 2026-10-19): the fight's kit on top (port/BotPkFight pkKitted: its style, KO weapon, potions,
    // way out), the same for a saved PKer and a new one: how it fights, not how it looks
    // port (the variety work, round 1, track W: WEAR-6): a mage's or archer's name in its class's look, its build as before
    if (!player) return pkKitted(username, pkVariedProfile(username, classPkProfile(username, profile, 'edgeville_pker') ?? profile, 'edgeville_pker', members, classed), 'edgeville_pker', members);
    // (the fixes: the integrator's rule) a PKer saved before round 1 keeps its look; (round 2) one saved before round 2 its outfit
    const saved = BotManager.botFor(player)?.planner.hasSave() ?? false;
    const owns = (id: number): boolean => whereOwned(player, id) !== null;
    return pkKitted(username, pkVarietyAtLogin(username, pkProfileAtLogin(username, profile, 'edgeville_pker', saved, owns), 'edgeville_pker', members, saved, owns, classed), 'edgeville_pker', members);
}

const EDGEVILLE_CENTER: [number, number, number] = [3093, 3491, 0];
const WILD_ZONE_CX = 3093;
const WILD_Z_MIN = 3526;
const WILD_Z_MAX = 3559;
const WILD_X_RADIUS = 14;
const SCAN_RADIUS = 22;
const DISENGAGE_DIST = 40;
/** port: a fight in which nothing lands for this many engage ticks (about 35 s) is given up (see handleEngage) */
const STALEMATE_TICKS = 30;

/** port: a player's combat XP (attack, defence, strength, hitpoints, ranged, magic): it rises with each hit landed */
function combatXp(p: Player): number {
    return p.stats[PlayerStat.ATTACK] + p.stats[PlayerStat.DEFENCE] + p.stats[PlayerStat.STRENGTH] + p.stats[PlayerStat.HITPOINTS] + p.stats[PlayerStat.RANGED] + p.stats[PlayerStat.MAGIC];
}
const DIESPAWN_DIST = 120;
/**
 * port (the realism work, phase 3; "bot friend cliques ... PK together"): an Edgeville PKer of a PK
 * clique (port/BotCliques) stands and walks within FORMATION of the first of its clique online at the edge (and that one,
 * the leader, beside a friend in a fight there), and walks on sooner (CLIQUE_WANDER) when that one has moved off or it
 * came back away from it (a fight over, a trip to the bank); each fights its own target (one attacker a target,
 * isTargetClaimed), a follower one within CLIQUE_FIGHT_NEAR of its leader: they fight near each other
 */
const FORMATION = 3;
const CLIQUE_WANDER: [number, number] = [3, 6];
const CLIQUE_FIGHT_NEAR = 10;
const BANK_DIST = 5;
const WILD_Z_START = 3520;

function chebyshev(ax: number, az: number, bx: number, bz: number): number {
    return Math.max(Math.abs(ax - bx), Math.abs(az - bz));
}

function wildLevel(z: number): number {
    if (z < WILD_Z_START) return 0;
    return Math.max(1, Math.floor((z - WILD_Z_START) / 8) + 1);
}

function inCombatRange(wildLvl: number, myCb: number, theirCb: number): boolean {
    if (wildLvl <= 0) return false;
    return Math.abs(myCb - theirCb) <= wildLvl;
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
        if (task instanceof EdgevillePKerTask && task.target === target) {
            if (raid && raid.sameTeam(excludeBot, p) && raid.mayShare(excludeBot, target)) continue;
            return true;
        }
    }
    return false;
}

/** port (the realism work, phase 3): at the edge, where the Edgeville PKers patrol (a little past it) */
function atTheEdge(p: Player): boolean {
    return Math.abs(p.x - WILD_ZONE_CX) <= WILD_X_RADIUS + 4 && p.z >= WILD_Z_MIN - 4 && p.z <= WILD_Z_MAX + 4;
}

function findNearbyTarget(bot: Player, radius: number, blacklist?: Map<string, number>, near: Player | null = null): Player | null {
    // port (the realism work, phase 5b: PK team raids): its leader's target first, where the team may pile on it (multi-combat)
    const raid = raidOf(bot);
    const team = raid?.teamTarget(bot) ?? null;
    if (team && !blacklist?.has(team.username) && chebyshev(bot.x, bot.z, team.x, team.z) <= radius && inCombatRange(pvpWildernessLevel(bot, team), bot.combatLevel, team.combatLevel)) return team;
    let best: Player | null = null;
    let bestDist = radius + 1;
    for (const p of (World as any).playerLoop.all() as Iterable<Player>) {
        if (p === bot) continue;
        if (p.level !== bot.level) continue;
        if (p.slot === -1) continue;
        // port: the cheap tests first, and the claim (a pass over every player) only for a player nearer than the best
        // so far: upstream checked the claim of every player in the world, a scan cost players²
        const d = chebyshev(bot.x, bot.z, p.x, p.z);
        if (d >= bestDist) continue;
        if (blacklist?.has(p.username)) continue;
        // port (the realism work, phase 3): never a friend of its PK clique (port/BotCliques: they PK together); a
        // follower's target near its leader (they fight near each other)
        if (sameClique(bot.username, p.username)) continue;
        if (near && chebyshev(near.x, near.z, p.x, p.z) > CLIQUE_FIGHT_NEAR) continue;
        // port: only players it may attack (upstream took the nearest player and then gave up if that one was out
        // of combat range, so a PKer next to another bot never saw anyone else)
        if (!inCombatRange(pvpWildernessLevel(bot, p), bot.combatLevel, p.combatLevel)) continue;
        if (raid?.sameTeam(bot, p)) continue;
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

export class EdgevillePKerTask extends BotTask {
    private state: 'init' | 'walk_to_wild' | 'banking' | 'idle' | 'engage' | 'tele' = 'init';
    private profile: PkerProfile | null = null;
    target: Player | null = null; // port: public, as in PKerTask, so isTargetClaimed can read it
    /** port: the world tick the attack may be clicked again, and the tick it was seen dropped (-1: it holds) (_reclickDue) */
    private reclickAt = 0;
    private droppedAt = -1;
    private engageTicks = 0;
    /** port: when the bot last hit or was hit (its combat XP rose or its hitpoints fell), in engageTicks */
    private lastHitTick = 0;
    private lastCombatXp = 0;
    private lastHitpoints = 0;
    private wildTargetX = 0;
    private wildTargetZ = 0;
    private stackFixed = false;
    private stackAttempts = 0;
    private stackWalkCooldown = 0;
    private wanderTimer = 0;
    private respawnTimer = 0;
    /** port: idle turns since its last bank trip, and how many until the next (about 20-40 minutes) */
    private sinceBank = 0;
    private bankEvery = 1000 + Math.floor(Math.random() * 1001);
    private gearVersion = 0;
    private static readonly GEAR_VERSION = 1;

    private readonly blacklist = new Map<string, number>();
    /** port: the engage's tactics (port/BotPkTactics), and a beaten bot on its way out of the Wilderness */
    private tactics = newPkTactics();
    private escaping = false;
    /** port (PK tactics, 2026-10-19): the engage's fight (port/BotPkFight), and a teleport out under way */
    private fight: PkFight | null = null;
    private tele: PkTeleport | null = null;
    private readonly stuck = new StuckDetector(25, 4, 2);
    private readonly watchdog = new ProgressWatchdog(300);
    /** port (the realism work, phase 5b): it had a part in a PK team raid at its last turn */
    private inRaid = false;
    /**
     * port (the realism work, phase 5b): engage ticks with nothing of its own landing, its target fought by a third player
     * in a single-combat zone, before it gives up (drawn at each engagement)
     */
    private refusedAfter = 5;
    /** port (PK tactics, round 2: "PJing"): the fight a PJer waits by (port/BotPkPj), and its own last fight's end */
    private pj: PkPjWatch | null = null;
    private fightEndAt = -1000;

    constructor() {
        super('EdgevillePKer');
    }

    /**
     * port (the realism work, phase 5b: PK team raids, port/BotPkTeam): a raid took it on: food first (a bank trip at
     * Edgeville, "grab food first"), then the meeting; a fight it is in goes on first
     */
    joinRaid(_player: Player): void {
        if (this.state === 'engage' || this.state === 'init') return;
        this.state = 'banking';
        this.cooldown = randInt(1, 3);
    }

    shouldRun(_player: Player): boolean {
        return true;
    }

    tick(player: Player): void {
        if (this.interrupted) return;
        // port: no special attack left set without the special weapon in hand (port/BotPkGear)
        pkDropStaleSpecial(player);
        for (const [k, v] of this.blacklist) {
            if (v <= 1) this.blacklist.delete(k);
            else this.blacklist.set(k, v - 1);
        }
        if (this.watchdog.check(player, false)) {
            player.clearWaypoints();
            player.clearPendingAction();
            this.interrupt();
            return;
        }
        // port (the realism work): the fight's turn comes every other tick, but a dropped attack is clicked again on the
        // tick its pause is over (_reclickDue), not on the next turn (its re-clicks came in step: H18 11-12 %)
        if (this.cooldown > 0 && this.state === 'engage' && this.target && this.target.slot !== -1 && this.droppedAt >= 0 && World.currentTick >= this.reclickAt && this._reclickDue(player, this.target)) {
            interactPlayerOp(player, this.target.slot, 2);
            this.watchdog.notifyActivity();
        }
        // port (PK tactics, 2026-10-19): in danger a bite comes on the first tick the game allows, not on the fight's turn
        if (this.cooldown > 0 && this.state === 'engage' && this.fight && this.fight.target === this.target) {
            this.fight.observe(player);
            this.fight.eat(player, true);
        }
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        if (!this.profile) {
            // port: on a free world a free profile, and any members gear from a members world goes to the bank
            // port: the bot's own build, from its name: the same at every login (upstream drew one at each start, so
            // with sessions a PKer's levels and combat level changed every time it came back)
            this.profile = edgevillePkerProfileFor(player.username, player);
            stripMembersItems(player);
        }

        if (this.gearVersion < EdgevillePKerTask.GEAR_VERSION) {
            this.gearVersion = EdgevillePKerTask.GEAR_VERSION;
            this.target = null;
            this.state = 'init';
            this.stackFixed = false;
            this.respawnTimer = randInt(10, 40);
            this.watchdog.notifyActivity();
            return;
        }

        const [ex, ez] = EDGEVILLE_CENTER;
        const dist = chebyshev(player.x, player.z, ex, ez);
        // port (the realism work, phase 5b): a PK team raid takes it out east and holds it at the meeting (port/BotPkTeam);
        // back from one, it walks back to the edge
        const raid = raidOf(player);
        if (this.inRaid && !raid && this.state !== 'engage' && this.state !== 'banking') {
            const [wx, wz] = this.getWildernessSpot(player, this.cliqueLeader(player));
            this.wildTargetX = wx;
            this.wildTargetZ = wz;
            this.state = 'walk_to_wild';
        }
        this.inRaid = raid !== null;
        // port: not while it walks there (from Lumbridge after a death, from wherever it logged in): upstream teleported
        // it to Edgeville first, so only a death left it this far
        if (!raid && this.state !== 'init' && this.state !== 'walk_to_wild' && (dist > DIESPAWN_DIST || (dist < 10 && (this.state === 'idle' || this.state === 'engage')))) {
            this.target = null;
            this.state = 'init';
            this.stackFixed = false;
            this.respawnTimer = randInt(10, 40);
            this.watchdog.notifyActivity();
            return;
        }

        switch (this.state) {
            case 'init': return this.handleInit(player);
            case 'walk_to_wild': return this.handleWalkToWild(player);
            case 'banking': return this.handleBanking(player);
            case 'idle': return this.handleIdle(player);
            case 'engage': return this.handleEngage(player);
            case 'tele': return this.handleTele(player);
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
     * port (PK tactics, round 2): a player a PJer may jump: on its level, in combat range, not its clique, its team or one
     * it gave up on; `now`, also not another's target, nor fought by a third player (the game would refuse it)
     */
    private _mayJump(player: Player, p: Player, now: boolean): boolean {
        if (p.level !== player.level || this.blacklist.has(p.username) || sameClique(player.username, p.username)) return false;
        if (!inCombatRange(pvpWildernessLevel(player, p), player.combatLevel, p.combatLevel)) return false;
        const raid = raidOf(player);
        if (raid?.sameTeam(player, p)) return false;
        return !now || (!isTargetClaimed(p, player, raid) && !foughtByOther(p, player));
    }

    /**
     * port (PK tactics, 2026-10-19): out of the fight and the Wilderness (port/BotPkFight flee): a run to the bank (south,
     * out of the Wilderness: 274 has no ditch yet), or a teleport (its glory, its spell) and the bank from where it lands
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

    /** port (PK tactics): a teleport out, a step a tick; then the bank (from Edgeville, where a glory lands) */
    private handleTele(player: Player): void {
        const step = this.tele?.tick(player) ?? 'failed';
        this.watchdog.notifyActivity();
        if (step === 'casting') return;
        this.tele = null;
        this.state = 'banking';
        player.run = 1;
    }

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
     * port (the realism work): the least time to its next click on the target: a person's click or two ('next', at
     * least 3 ticks). It was 4-6 ticks: a target that kept slipping away was clicked again every 4, 5 or 6 ticks, a
     * third of them alike (the humanlike report's H18: 11-19 % once the game's retaliation no longer broke the runs).
     * (Phase 5a: a draw under 3 is drawn again, not raised to 3: raised, about two gaps in five were exactly 3 ticks, and
     * at 500 bots H18 came back to 13-15 %)
     */
    private _reclickGap(player: Player): number {
        for (let i = 0; i < 4; i++) {
            const gap = humanDelay(player, 'next');
            if (gap >= 3) return gap;
        }
        return randInt(3, 6);
    }

    /**
     * port (the realism work, phase 2): the attack clicked again. While it lasts, now and then (a person's click or two
     * apart: _reclickGap); once it dropped (eating, a potion, a special's swap), a person's moment after the bot noticed
     * (BotTiming 'next'). Upstream re-clicked on every 5th tick whatever happened, so a dropped attack came back in
     * step (the humanlike report's H18: 11-14 % of the Edgeville PKers' intervals the same)
     */
    private _reclickDue(player: Player, target: Player): boolean {
        const now = World.currentTick;
        if (player.target === target) {
            this.droppedAt = -1;
            if (now < this.reclickAt) return false;
            this.reclickAt = now + this._reclickGap(player);
            return true;
        }
        if (this.droppedAt < 0) {
            this.droppedAt = now;
            // (the same fight's next click, a round of the same thing: 'next', wide; 'retarget' kept a persona's re-clicks
            // in a few tick counts, a tenth of a chase's intervals alike)
            this.reclickAt = now + 1 + humanDelay(player, 'next');
        }
        if (now < this.reclickAt) return false;
        this.droppedAt = -1;
        this.reclickAt = now + this._reclickGap(player);
        return true;
    }

    isComplete(): boolean {
        return false;
    }

    override reset(): void {
        super.reset();
        this.state = 'init';
        this.target = null;
        this.engageTicks = 0;
        this.stackFixed = false;
        this.stackAttempts = 0;
        this.stackWalkCooldown = 0;
        this.wanderTimer = 0;
        this.respawnTimer = 0;
        this.blacklist.clear();
        this.stuck.reset();
        this.watchdog.reset();
    }

    private handleInit(player: Player): void {
        const p = this.profile!;

        pkSetLevels(player, p);

        if (this.respawnTimer > 0) {
            this.respawnTimer--;
            return;
        }

        this.replenish(player);

        const [wx, wz] = this.getWildernessSpot(player, this.cliqueLeader(player));
        this.wildTargetX = wx;
        this.wildTargetZ = wz;
        console.log(`[EdgevillePKer] ${player.displayName} profile=${p.name} cb=${player.combatLevel} spot=${wx},${wz}`);
        this.state = 'walk_to_wild';
        this.cooldown = randInt(2, 4);
        // port: walked from wherever it is, Lumbridge after a death too (walk). Upstream teleported
        // to Edgeville: 19-46 casts an hour in the Lumbridge courtyard where newcomers arrive
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
        if (usableOnThisWorld(p.specWeapon) && !_wornContains(player, p.specWeapon) && !hasItem(player, p.specWeapon)) {
            addItem(player, p.specWeapon, 1);
        }
        if (usableOnThisWorld(p.rangeWeapon) && !_wornContains(player, p.rangeWeapon) && !hasItem(player, p.rangeWeapon)) {
            addItem(player, p.rangeWeapon, 1);
        }
        for (const potId of p.pots) {
            if (usableOnThisWorld(potId) && !hasItem(player, potId)) {
                addItem(player, potId, 1);
            }
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

    private handleBanking(player: Player): void {
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
        const [bx, bz] = EDGEVILLE_CENTER;
        this.stuckWalk(player, bx, bz);
        if (isNear(player, bx, bz, BANK_DIST)) {
            this.replenish(player);
            this.escaping = false;
            const [wx, wz] = this.getWildernessSpot(player, this.cliqueLeader(player));
            this.wildTargetX = wx;
            this.wildTargetZ = wz;
            this.state = 'walk_to_wild';
            this.cooldown = randInt(2, 4);
        }
        this.watchdog.notifyActivity();
    }

    private handleWalkToWild(player: Player): void {
        // port: the fight's prayers off (they drain the points: port/BotPkTactics)
        if (pkPrayersOff(player)) {
            this.cooldown = 1;
            return;
        }
        // port (PK tactics, 2026-10-19): someone attacking it on its way (it stood and took the hits), a bite when hurt
        const attacker = getAttacker(player);
        if (attacker) {
            this.target = attacker;
            this.engageTicks = 0;
            this.state = 'engage';
            this.watchdog.notifyActivity();
            return;
        }
        if (this._outOfFight(player)) return;
        this.stuckWalk(player, this.wildTargetX, this.wildTargetZ);
        if (isNear(player, this.wildTargetX, this.wildTargetZ, 5)) {
            this.state = 'idle';
            this.cooldown = randInt(2, 4);
            return;
        }
        this.watchdog.notifyActivity();
        if (this.state !== 'init') {
            this.cooldown = 1;
        }
    }

    private handleIdle(player: Player): void {
        // port: the fight's prayers off (they drain the points: port/BotPkTactics)
        if (pkPrayersOff(player)) {
            this.cooldown = 1;
            return;
        }
        // port: someone attacking the bot (upstream took the bot's own target: its attack on a player it had just
        // given up on was still set, so it re-engaged, gave up again and stood frozen on one tile, every tick)
        const attacker = getAttacker(player);
        if (attacker) {
            this.target = attacker;
            this.engageTicks = 0;
            this.state = 'engage';
            this.watchdog.notifyActivity();
            return;
        }
        // port (PK tactics): a bite when hurt; out when hit by one it may not hit back
        if (this._outOfFight(player)) return;
        // port (PK tactics, round 2: "PJing"): a PJer by a fight, off it a few tiles, until it may jump the one
        // left of it (port/BotPkPj: the game's 8 ticks after its last hit); no "gl" to one it jumps
        if (this.pj) {
            const next = this.pj.next(player, p => this._mayJump(player, p, true), SCAN_RADIUS);
            if (next === 'over') {
                this.pj = null;
            } else if (next) {
                this.pj = null;
                this.target = next;
                this.engageTicks = 0;
                this.state = 'engage';
                interactPlayerOp(player, next.slot, 2);
                walkTo(player, next.x, next.z);
                noteSpectacle(player, 'pk');
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
        // port (the realism work, phase 3): the first of its PK clique at the edge, if it follows one
        const lead = this.cliqueLeader(player);
        // port (the realism work, phase 5b): in a PK team raid, to its part's spot when it is off it (the meeting, the
        // patrol round its leader: port/BotPkTeam)
        const raid = raidOf(player);
        const raidSpot = raid?.spotFor(player) ?? null;
        if (raidSpot && chebyshev(player.x, player.z, raidSpot[0], raidSpot[1]) > FORMATION + 3 && !player.hasWaypoints()) {
            walkTo(player, raidSpot[0], raidSpot[1]);
            this.watchdog.notifyActivity();
        }
        if (this.rescanTimer <= 0) {
            // (round 2) a PJer: a fight near it first, to wait by (not in a raid: the team's spot holds it)
            if (!raid && pkWaysOf(player.username).pj) {
                const watch = pkFightToWatch(player, SCAN_RADIUS, p => this._mayJump(player, p, false));
                if (watch) {
                    this.pj = watch;
                    this.watchdog.notifyActivity();
                    this.cooldown = 1;
                    return;
                }
            }
            const found = findNearbyTarget(player, SCAN_RADIUS, this.blacklist, lead);
            if (found) {
                const wildLvl = pvpWildernessLevel(player, found); // port: both players' levels, not only the bot's
                if (inCombatRange(wildLvl, player.combatLevel, found.combatLevel)) {
                    // (a team-mate on it already: the team piles on, in multi-combat only: port/BotPkTeam)
                    if (raid && raid.mayShare(player, found) && isTargetClaimed(found, player)) raid.notePile(player, found);
                    this.target = found;
                    this.engageTicks = 0;
                    this.state = 'engage';
                            if (Math.random() < GL_CHANCE) sayPk(player, pkLine(player, 'gl', GL_PHRASES));
                    interactPlayerOp(player, found.slot, 2);
                    walkTo(player, found.x, found.z);
                    noteSpectacle(player, 'pk'); // port (the realism work): a fight draws a look (port/BotHabits)
                    this.watchdog.notifyActivity();
                    return;
                }
            }
            this.rescanTimer = randInt(3, 6);
            // (play-testing: the ditch "a little too quiet") nobody to fight: now and then a call for one ("fight?",
            // "1v1 lvl 1 wild", "lol all safers"); pkLine keeps it under its share of a busy place's talk
            if (!raid && Math.random() < WAIT_CALL) sayPk(player, pkLine(player, 'patrol', []));
            // port: waiting at its post for someone to come is this task's work; upstream counted only the wander
            // (every 300-600 ticks with the idle cooldown) against the 300-tick watchdog, so in an empty Wilderness the
            // bot was teleported home about every 5 minutes
            this.watchdog.notifyActivity();
        } else {
            this.rescanTimer--;
        }
        // port: a short patrol along the ditch, and now and then a bank trip. Upstream stepped ±4
        // tiles every 150-300 ticks: a row of motionless PKers at the ditch
        // (away from a friend of its clique, which moved off or which it came back to: on again soon; the leader, beside a
        // friend in a fight)
        const anchor = lead ?? this.fightingMate(player);
        const apart = anchor !== null && Math.max(Math.abs(anchor.x - player.x), Math.abs(anchor.z - player.z)) > FORMATION + 3;
        if (apart && this.wanderTimer > CLIQUE_WANDER[1]) this.wanderTimer = randInt(...CLIQUE_WANDER);
        if (--this.wanderTimer <= 0) {
            const [wx, wz] = this.getWildernessSpot(player, anchor);
            walkTo(player, wx, wz);
            this.wanderTimer = apart ? randInt(...CLIQUE_WANDER) : randInt(20, 60);
            this.watchdog.notifyActivity();
        }
        if (++this.sinceBank >= this.bankEvery) {
            this.sinceBank = 0;
            this.bankEvery = randInt(1000, 2000);
            this.state = 'banking';
        }
        this.cooldown = 1;
    }

    private handleEngage(player: Player): void {
        const t = this.target;
        if (!t || t.slot === -1) {
            this._dropTarget(player);
            this.state = 'banking';
            return;
        }

        this.engageTicks++;

        // port (PK tactics, 2026-10-19): its fight (port/BotPkFight) from the first tick on a target; getting out and a
        // bite before anything else (a player eats and runs whatever happens with the targets around it)
        if (this.engageTicks === 1 || this.fight?.target !== t) {
            this.fight?.disarm(player);
            this.fight = this.profile ? new PkFight(player, t, this.profile, false) : null;
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

        // port (the realism work, phase 5b): not a team-mate's fight in a raid, where the team piles on (multi-combat)
        const raid = raidOf(player);
        const teamFight = raid !== null && t.target instanceof Player && raid.sameTeam(player, t.target) && raid.mayShare(player, t);
        if (this.engageTicks === 1 && isFightingAnother(t, player) && !teamFight) {
            this.blacklist.set(t.username, 1000);
            this._dropTarget(player);
            sayPk(player, pkFixedLine(player, 'Oops, sorry!')); // port: the word filter masks "Woops"; not twice in a place in 10 minutes
            walkTo(player, player.x + randInt(-6, 6), player.z + randInt(-6, 6));
            this.state = 'idle';
            this.cooldown = randInt(3, 6);
            this.watchdog.notifyActivity();
            return;
        }

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
            this.state = 'banking';
            return;
        }

        const wildLvl = pvpWildernessLevel(player, t); // port: both players' levels, not only the bot's
        if (!inCombatRange(wildLvl, player.combatLevel, t.combatLevel)) {
            if (this.engageTicks > 5 && wildernessLevelAt(t.x, t.z) === 0) pkSayRan(player); // (port, PK tactics: it ran out)
            this._dropTarget(player);
            this.state = 'banking';
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
            this.state = 'idle';
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
            this.state = 'idle';
            this.watchdog.notifyActivity();
            return;
        }

        // port: smarter PKers (port/BotPkTactics): a kill line and the fight over, prayers; (PK tactics)
        // port/BotPkFight: getting out, eating, potions, the KO switch
        if (this.engageTicks === 1) this.tactics = newPkTactics();
        // port (the realism work, phase 5b): in a raid it runs sooner (under 40 % with no food), and tells the team
        if (raid && player.levels[PlayerStat.HITPOINTS] < player.baseLevels[PlayerStat.HITPOINTS] * raid.escapeBelow && !this.hasFood(player)) {
            this._getOut(player, 'run');
            return;
        }
        if (this.profile) {
            // (no protection prayers at the edge, "no honour"; round 2: the melee boosts, yes)
            const outcome = pkEngageTactics(player, t, this.tactics, { honour: true, banter: true, offence: fight?.offence(player) ?? false });
            if (outcome === 'killed') {
                noteSpectacle(t, 'pk'); // port (the realism work): the kill and its drop draw a look (port/BotHabits)
                this._dropTarget(player);
                // (PK tactics) little food left after it: the bank first, as people restocked between fights
                this.state = pkFoodLeft(player, this.profile) <= pkWaysOf(player.username).restockAt ? 'banking' : 'idle';
                this.watchdog.notifyActivity();
                return;
            }
        }
        // (one of them a turn: a dose, the KO weapon on; the attack is clicked again below)
        if (fight && (fight.potions(player) || fight.koStep(player))) this.watchdog.notifyActivity();

        const stackedWith = this.isStackedWith(player);
        if (stackedWith) {
            this.stackAttempts++;
            const allDirs: [number, number][] = [[1,0], [-1,0], [0,1], [0,-1]];
            const dirIndex = (this.stackAttempts - 1) % 4;
            const isMover = player.slot > (stackedWith as any).slot;

            if (this.stackWalkCooldown <= 0) {
                let dx: number, dz: number;
                if (isMover) {
                    [dx, dz] = allDirs[dirIndex]!;
                } else {
                    const [mx, mz] = allDirs[dirIndex]!;
                    dx = -mx;
                    dz = -mz;
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
            if (this.stackAttempts > 0) {
                this.stackFixed = true;
            }
            this.stackAttempts = 0;
            // (port, PK tactics: a ranger shoots from where it stands, its bow's reach; the game walks a melee KO in)
            if (!this.stackFixed && this.profile?.style !== 'ranged') {
                if (chebyshev(player.x, player.z, t.x, t.z) > 1) {
                    walkTo(player, t.x, t.z);
                }
            }
            if (this._reclickDue(player, t)) {
                interactPlayerOp(player, t.slot, 2);
                this.watchdog.notifyActivity();
            }
        }

        this.cooldown = 1;
    }

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

    private getWildernessSpot(player: Player, near: Player | null): [number, number] {
        // port (the realism work, phase 5b): in a PK team raid, its part's spot (the meeting; the patrol round its leader)
        const spot = raidOf(player)?.spotFor(player);
        if (spot) return spot;
        // port (the realism work, phase 3): beside a friend of its PK clique at the edge (its leader; a leader's friend in a fight)
        if (near) {
            const x = Math.min(WILD_ZONE_CX + WILD_X_RADIUS, Math.max(WILD_ZONE_CX - WILD_X_RADIUS, near.x + randInt(-FORMATION, FORMATION)));
            const z = Math.min(WILD_Z_MAX, Math.max(WILD_Z_MIN, near.z + randInt(-FORMATION, FORMATION)));
            return [x, z];
        }
        return [WILD_ZONE_CX + randInt(-WILD_X_RADIUS, WILD_X_RADIUS), randInt(WILD_Z_MIN, WILD_Z_MAX)];
    }

    /** port (the realism work, phase 3): the first of its PK clique online, at the edge (where it patrols); null: it leads or is alone */
    private cliqueLeader(player: Player): Player | null {
        // port (the realism work, phase 5b): in a PK team raid, its team's leader wherever it is
        const raid = raidOf(player);
        if (raid) {
            const leader = raid.leaderOf(player);
            return leader && leader.level === player.level ? leader : null;
        }
        const lead = pkCliqueLeader(player);
        return lead && lead.level === player.level && atTheEdge(lead) ? lead : null;
    }

    /** port (the realism work, phase 3): a leader's friend of its PK clique in a fight at the edge (the nearest); null: none, or it follows */
    private fightingMate(player: Player): Player | null {
        if (pkCliqueLeader(player) !== null) return null;
        for (const mate of pkCliqueMates(player)) {
            const task = (mate as any)._bot?.currentTask;
            if (mate.level === player.level && task instanceof EdgevillePKerTask && task.state === 'engage' && task.target !== null && atTheEdge(mate)) return mate;
        }
        return null;
    }

    private stuckWalk(player: Player, tx: number, tz: number): void {
        if (!this.stuck.check(player, tx, tz)) {
            walkTo(player, tx, tz);
            return;
        }
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
