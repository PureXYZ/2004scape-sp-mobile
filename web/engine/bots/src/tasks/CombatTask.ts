import {
    BotTask,
    Player,
    Npc,
    InvType,
    walkTo,
    interactNpcOp,
    findNpcByName,
    findNpcByPrefix,
    findNpcBySuffix,
    hasItem,
    isInventoryFull,
    isNear,
    getBaseLevel,
    PlayerStat,
    Items,
    getProgressionStep,
    teleportNear,
    randInt,
    bankInvId,
    INTERACT_TIMEOUT,
    StuckDetector,
    ProgressWatchdog,
    setCombatStyle,
    botJitter,
    advanceBankWalk,
    cleanGrimyHerbs,
    botTeleport,
    currentHp,
    maxHp,
    hpBelow,
    carriedFood,
    bankedFood,
    eatBestFood,
    withdrawFood,
    bankFoodAbove,
    webBladeFor,
    takeWebBlade,
    npcReachable,
    npcReach,
    gateToward,
    UNREACHABLE_NPC_TICKS,
    edibleFoodIds,
    dungeonRoute,
    CLAIMED_NPCS,
    bankCount,
    humanDelay,
    TargetPause,
} from '#/engine/bot/tasks/BotTaskBase.js';
import { botReachedEntity } from '#/engine/bot/port/BotPathing.js'; // (variety round 2, Track D2: D2-7)
import { bankStop } from '#/engine/bot/port/BotHabits.js';
import type { SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import {
    findObjByName,
    findObjByPrefix,
    findObjNear,
    findLootObj,
    interactHeldOp,
    pickupGroundItem,
    removeItem,
    findNpcFiltered,
    npcMatchesName,
    getNpcCombatLevel,
    findAggressorNpc,
    findOtherAggressorNpc,
    interactIF_UseOp,
    interactObjOp,
    _equipLoot,
    _wornContains,
    countItem,
    tryOpenNearbyGate, tryOpenGateNear, climbDownNear, closedGateBetween, openGateLoc } from '#/engine/bot/BotAction.js';
import NpcType from '#/cache/config/NpcType.js';
import { Interfaces, GRIMY_HERB_MAP, FOOD_IDS, levelUpStep, getProgressionStepWhere } from '#/engine/bot/BotKnowledge.js';
import ObjType from '#/cache/config/ObjType.js';
import type { BotTaskDebugInfo } from '#/engine/bot/debug/BotDebugTypes.js';
import { PlayerStatNameMap } from '#/engine/entity/PlayerStat.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { moveItems, bankedId } from '#/engine/bot/port/BotInventoryCompat.js';
import type { Inventory } from '#/engine/Inventory.js';
import { usableOnThisWorld } from '#/engine/bot/port/BotPkGear.js';
import { runFromAttackers } from '#/engine/bot/port/BotDefence.js';
import { bankedArmourToWear, bestMeleeWeapon, dressForFight, needsFightDress, weaponScore } from '#/engine/bot/port/BotGear.js';
import { meleeWeaponOf, weaponKindOf } from '#/engine/bot/port/BotOutfits.js';
import { isSignatureHat, isWardrobeItem } from '#/engine/bot/port/BotLooks.js';
import { statusPieceOf } from '#/engine/bot/port/BotFashion.js';
import { isTool } from '#/engine/bot/port/BotParty.js';
import { nearestGeneral } from '#/engine/bot/port/BotChains.js';
// (the realism work's phase 5a, Track F: misclicks and forgotten food, port/BotFumble; kill-stealing, port/BotRude)
import type Obj from '#/engine/entity/Obj.js';
import { forgotFood, fumbleDue, fumbled, isCareless, noticeNoFood, packFoodRoll } from '#/engine/bot/port/BotFumble.js';
import { claimArgument, humanAttacking, isMultiAt, KS_FAR, maySteal, noteSteal, noticedTaken, npcFighting, rollFor, rudeActs, rudeRates, startSteal } from '#/engine/bot/port/BotRude.js';
import { argue } from '#/engine/bot/port/BotChatter.js';
// (the variety work, round 1, Track D: the dungeons' clicks on the way in)
import { enterDungeon } from '#/engine/bot/port/BotDungeons.js';

// ── Shared NPC claim registry ─────────────────────────────────────────────────
// Module-level set of NPC keys currently targeted by any CombatTask instance.
// Bots skip NPCs in this set so they don't pile onto the same target.
// Key: the NPC's nid.

// port: 274's Npc has no `index`, so upstream always fell back to a key made of the NPC's position and type, which
// stopped matching as soon as the NPC moved (other bots then took the same NPC). Its nid (its slot in World.npcs)
// stays the same for as long as it is in the world, also when it respawns; -1 once it has left for good.
function _npcKey(npc: Npc): number {
    return npc.nid;
}

/**
 * port (the realism work, phase 5a, Track F): the fighting bot that claimed each NPC (by nid): the victim of a rude
 * bot's steal (port/BotRude), the one on its way to the NPC it clicked. CombatTask's claims only (RangedMagic's are not
 * stolen).
 */
const NPC_CLAIMERS = new Map<number, Player>();

type CombatExtra = {
    npcType?: string;
    npcTypes?: string[];
    hitsToKill?: number;
    itemsGained?: string[];
    npcName?: string;
    npcPrefix?: string;
    npcSuffix?: string;
};

// Melee style rotation: accurate(0)→attack, aggressive(1)→strength, defensive(3)→defence
const TRAIN_CYCLE: Array<{ stat: PlayerStat; style: 0 | 1 | 3 }> = [
    { stat: PlayerStat.ATTACK, style: 0 },
    { stat: PlayerStat.STRENGTH, style: 1 },
    { stat: PlayerStat.DEFENCE, style: 3 }
];

// Worn slots that are considered armor (helm, torso, shield, legs). Does not include weapon (3) or ammo (13).
const ARMOR_WORN_SLOTS = new Set([0, 4, 5, 7]);

// Scimitar tiers ordered best-first; the first entry whose minAtk ≤ player's Attack level is used.
export const SCIMITAR_TIERS: Array<{ minAtk: number; itemId: number }> = [
    { minAtk: 40, itemId: Items.RUNE_SCIMITAR    },
    { minAtk: 30, itemId: Items.ADAMANT_SCIMITAR },
    { minAtk: 20, itemId: Items.MITHRIL_SCIMITAR },
    { minAtk: 10, itemId: Items.BLACK_SCIMITAR   },
    { minAtk: 5,  itemId: Items.STEEL_SCIMITAR   },
    { minAtk: 1,  itemId: Items.IRON_SCIMITAR    },
    // port: and bronze, a new bot's (earned gear: port/BotGear)
    { minAtk: 1,  itemId: Items.BRONZE_SCIMITAR  },
];

// Food to carry into combat (upstream: 15 sharks). port: the best food the bot can eat on this world (BotTaskBase).
const COMBAT_FOOD = 15;
/** port: eat below this share of the Hitpoints level, and keep eating up to EAT_UNTIL while there is food */
const EAT_BELOW = 0.4;
const EAT_UNTIL = 0.8;
/** port: without food a bot does not start (or go on) fighting below this share of its Hitpoints */
const FIGHT_WITHOUT_FOOD_ABOVE = 0.5;
/** port (the realism work, phase 5a: forgotten food): a careless bot without food pushes on to here ("one more kill") */
const CARELESS_LEAVE_BELOW = 0.25;
/** port (phase 5a: misclicks): a busy NPC this near (tiles) is the misclick's, and the one fighting it must be beside it */
const MISCLICK_NPC_TILES = 6;
/** port (phase 5a: misclicks): a misclick's interaction is let go this long after the walk to it (274 answers it when it
 * gets there: a safety) */
const MISCLICK_HOLD_TICKS = 4;
/** port (phase 5a: loot manners): a rude fighter picks up others' revealed drops this near (tiles); a polite one only its own */
const RUDE_LOOT_TILES = 4;
/** port (phase 5a): its own kill's drop stays its own this long after the kill (274 reveals a drop to everyone at 100 ticks) */
const OWN_KILL_TICKS = 300;

// ── Weapons (port) ────────────────────────────────────────────────────────────
// A combat step's toolItemIds name the scimitar it wants (iron from 15, steel from 35). Upstream wanted that exact
// item in the pack: from Attack 35 every step asked for a steel scimitar (600 coins at Zeke's, and bots carry about
// 200) while the bot wore a better one (each bank trip equips the best scimitar its Attack allows, from InitTask's
// bank seed). Fighters started Combat, could not run it and earned nothing, and each bank trip's re-roll found only
// the steps that want no weapon at all (chickens, goblins, cows, rats, spiders). Now any melee weapon of that metal
// or better that the bot can wield counts, worn, in the pack or in the bank (the task fetches it from the bank).
const MELEE_WEAPON = /scimitar|sword|mace|battleaxe|warhammer|dagger|spear|halberd/i;
/** metal → [tier, Attack level needed to wield] */
const METAL_TIERS: ReadonlyArray<[string, number, number]> = [
    ['dragon', 7, 60],
    ['rune', 6, 40],
    ['adamant', 5, 30],
    ['mithril', 4, 20],
    ['black', 3, 10],
    ['steel', 2, 5],
    ['iron', 1, 1],
    ['bronze', 0, 1]
];

/** A melee weapon's metal tier and wield level, or null for anything else (tools, bows, staves). */
function meleeWeaponTier(itemId: number): [tier: number, attack: number] | null {
    const type = ObjType.get(itemId);
    if (type.wearpos !== 3 || !type.name || !MELEE_WEAPON.test(type.name)) return null;
    // (the variety work, round 1, track W: 274 names the adamant warhammer "Adamnt warhammer")
    const name = type.name.toLowerCase().replace(/^adamnt /, 'adamant ');
    for (const [metal, tier, attack] of METAL_TIERS) {
        if (name.startsWith(metal)) return [tier, attack];
    }
    return null;
}

/** The metal tier a combat step's weapon must have, or -1 when it needs none. */
function requiredWeaponTier(step: SkillStep): number {
    let need = -1;
    for (const id of step.toolItemIds) need = Math.max(need, meleeWeaponTier(id)?.[0] ?? 0);
    return need;
}

/**
 * port: has the bot a weapon good enough for this combat step, that it can wield here? 'carried' (worn or in the
 * pack), 'banked', or null.
 */
export function combatWeaponFor(player: Player, step: SkillStep): 'carried' | 'banked' | null {
    const need = requiredWeaponTier(step);
    if (need < 0) return 'carried';
    const attack = getBaseLevel(player, PlayerStat.ATTACK);
    const fits = (id: number): boolean => {
        const t = meleeWeaponTier(id);
        return t !== null && t[0] >= need && attack >= t[1] && usableOnThisWorld(id);
    };
    const inInv = (invId: number): boolean => {
        const inv = invId === -1 ? null : player.getInventory(invId);
        if (!inv) return false;
        for (let slot = 0; slot < inv.capacity; slot++) {
            const it = inv.get(slot);
            if (it && fits(it.id)) return true;
        }
        return false;
    };
    if (inInv(InvType.WORN) || inInv(InvType.INV)) return 'carried';
    return inInv(bankInvId()) ? 'banked' : null;
}

/** port: monsters at most this share of the bot's combat level (at least WEAK_FOE_MIN) hit too little to need food */
const WEAK_FOE_SHARE = 0.5;
const WEAK_FOE_MIN = 3;
/** port: and against them a bot without food fights on down to this share of its Hitpoints */
const WEAK_FOE_HP = 0.3;
/**
 * port: without food a fight starts only from this share of the Hitpoints, well above where the bot leaves one
 * (EAT_BELOW): at 30-40 % it went back as soon as it had healed a point and was hit down again (fighters killed by
 * Edgeville's men and Lumbridge's bears in the 50-bot sims)
 */
const FIGHT_START_WITHOUT_FOOD = 0.6;

/** port: are all the step's monsters weak for this bot (chickens, cows, goblins for most)? */
function weakFoes(player: Player, step: SkillStep): boolean {
    const extra = step.extra as { npcType?: unknown; npcTypes?: unknown } | undefined;
    const names = [extra?.npcType, ...(Array.isArray(extra?.npcTypes) ? extra.npcTypes : [])].filter((n): n is string => typeof n === 'string');
    if (names.length === 0) return false;
    const limit = Math.max(WEAK_FOE_MIN, Math.floor(player.combatLevel * WEAK_FOE_SHARE));
    for (const name of names) {
        const id = NpcType.getId(name);
        if (id === -1) return false; // (a prefix: not known here)
        const t = NpcType.get(id);
        const level = Math.max(1, Math.floor((t.stats[1] + t.stats[3]) * 0.25 + (t.stats[0] + t.stats[2]) * 0.325));
        if (level > limit) return false;
    }
    return true;
}

/**
 * port: may the bot fight now? With food (carried or banked) always; without, only above FIGHT_WITHOUT_FOOD_ABOVE of
 * its Hitpoints (they come back over time while it does something else), or WEAK_FOE_HP against a step's weak
 * monsters (earned gear: no bank of 999,999,999 swordfish any more, and a level-10 fighter needs none for chickens).
 */
export function fitToFight(player: Player, step?: SkillStep, starting = true): boolean {
    if (carriedFood(player) > 0 || bankedFood(player) > 0) return true;
    if (starting && hpBelow(player, FIGHT_START_WITHOUT_FOOD)) return false;
    return !hpBelow(player, step && weakFoes(player, step) ? WEAK_FOE_HP : FIGHT_WITHOUT_FOOD_ABOVE);
}

/**
 * port (2026-10-18, "why only Lumbridge?"): a full pack's junk is sold at the general store nearest the fight's
 * spot (port/BotChains GENERAL_STORES: Lumbridge, Varrock, Al Kharid, Falador, Edgeville, Rimmington) within this many
 * tiles of it, else it all goes to the bank. Upstream walked every fighter to Lumbridge's, from anywhere.
 */
const JUNK_STORE_RANGE = 80;

/** port (2026-10-18): sale clicks in a row that changed nothing (the shop refused) before the bank */
const IDLE_SELLS = 3;

/** port (2026-10-18): every item in the pack, counted (a sale changes it) */
function packTotal(player: Player): number {
    const inv = player.getInventory(InvType.INV);
    let n = 0;
    for (let slot = 0; inv && slot < inv.capacity; slot++) n += inv.get(slot)?.count ?? 0;
    return n;
}

/** port (2026-10-18): a rune of any kind (274's debugnames: airrune ... soulrune), banked by a fight, never sold */
function isRune(itemId: number): boolean {
    return /^[a-z]+rune$/.test(ObjType.get(itemId)?.debugname ?? '');
}

// port (the realism work, phase 4: patchwork gear): upstream's ARMOR_SETS (a full helm, platebody, platelegs and kiteshield
// per metal) is gone: the armour pieces by kind and metal are port/BotLooks' (armourPieces), what a bot buys and wears
// port/BotGear's (nextGearUpgrade, bankedArmourToWear) and a new aged bot's port/BotAge's (agedLook).

export class CombatTask extends BotTask {
    private step: SkillStep;
    private readonly primaryStat: PlayerStat; // governs location/progression
    private stat: PlayerStat; // current training stat (rotates per kill)
    private trainIndex = 0;
    private readonly noAttackTimeoutTicks = 12; // RS2 rounds are 5-6 ticks; allow ~2 full rounds before timeout
    /** port (2026-10-18): the items the pack held as the fight began (_notePack): banked, never sold as junk */
    private readonly ownItems = new Set<number>();
    /** port (2026-10-18): the general store a full pack's junk is sold at (_junkStore): its keeper, where */
    private junkStore: readonly [string, readonly [number, number, number]] | null = null;
    /** port (2026-10-18): the pack's item count at the last sale's click, and the clicks in a row since that changed nothing */
    private lastSellPack = -1;
    private idleSells = 0;
    /** port (2026-10-18): this visit sold something; the store of a visit that sold nothing (not asked again: _junkStore) */
    private soldHere = false;
    private refusedStore: string | null = null;

    private state: 'walk' | 'patrol' | 'scan' | 'interact' | 'flee' | 'shop_walk' | 'shop_open' | 'shop_sell' | 'bank_walk' | 'bank_deposit' | 'loot' | 'bury' | 'eat' = 'walk';

    private interactTicks = 0;
    private approachTicks = 0;
    /** port: re-engages of the current NPC since the bot last hit it */
    private reengages = 0;
    private lastXp = 0;
    private scanFail = 0;
    private fleeTicks = 0;
    private readonly FLEE_TICKS = 12; // run for ~12 ticks before resuming combat
    /** port: the flee is the run before the bank walk (hurt, no food: port/BotDefence.runFromAttackers) */
    private fleeToBank = false;

    /** port: the task tick of the last burying. Upstream read the wall clock (6 s: 10 ticks on the phone, hundreds of
     * ticks in the simulations, so a seed did not reproduce a run) */
    private lastBuryTick = 0;
    private readonly BURY_INTERVAL_TICKS = 10;
    private buryCount = 0;
    private buryWaitTicks = 0;

    private currentNpc: Npc | null = null;
    /** Key of the NPC this instance has claimed in CLAIMED_NPCS, or -1 if none. */
    private claimedNpcKey = -1;

    /** port: walks toward the chosen NPC that left the bot where it was (see _approachNpc) */
    private approachStalls = 0;
    private approachX = -1;
    private approachZ = -1;

    private readonly stuck = new StuckDetector(30, 4, 2);
    private readonly watchdog = new ProgressWatchdog(150);

    private intentCooldown = 0;

    private patrolTarget: [number, number] | null = null;
    private patrolTicks = 0;

    private hasFoughtInArea = false;

    /** True once we've done the initial weapon equip-from-inventory on first walk. */
    private _startEquipDone = false;

    /** Cached from the last tick so reset() can unequip armor without a player parameter. */
    private _lastPlayer: Player | null = null;

    /** port: the level the step was last checked against (levelUpStep runs when it rises) */
    private stepLevel = -1;
    /** port: ticks the eat state could not eat (a delay) */
    private eatTries = 0;
    /** port: a hit landed on the current NPC (so its leaving the world is a kill) */
    private hasHit = false;
    /** port: spots where nothing came of 150 ticks (the watchdog): not picked again by this task */
    private readonly failedSteps = new Set<SkillStep>();
    /** port: NPCs the bot found no way to (nid → the task tick until which they are skipped) */
    private readonly unreachable = new Map<number, number>();
    private taskTicks = 0;
    /** port: gates opened for the current NPC (each counts as a re-engage), and a click on it due once the gate is open */
    private gateTries = 0;
    private reclick = false;
    private gateLoc: any = null;
    /** port (the realism work, phase 2): a person's pause before the next NPC after a target is lost (BotTaskBase) */
    private readonly pause = new TargetPause();
    /** port: ground items not to loot (goblin mail, or one it could not pick up) until the task tick */
    private readonly skipLoot = new WeakMap<object, number>();
    /** port (phase 5a): where its last kills fell, by its task's clock (_mayLoot: its own drop after 274 revealed it) */
    private readonly ownKills: { x: number; z: number; level: number; at: number }[] = [];
    private lootObj: object | null = null;
    private lootTicks = 0;
    // port (the realism work, phase 5a, Track F: loot manners): a polite fighter picks up its own drops only (274 shows a
    // kill's drop to its hero for 100 ticks, World.addObj, then to everyone); a rude one others' revealed drops too, within
    // RUDE_LOOT_TILES ("loot stealing", legal and 2004)
    private readonly _lootOk = (o: any): boolean => o.type !== 288 && (this.skipLoot.get(o) ?? -1) <= this.taskTicks && this._mayLoot(o);
    /** port (phase 5a, Track F: misclicks): the busy NPC it misclicked and when (its interaction let go after MISCLICK_HOLD_TICKS) */
    private misclickNpc: Npc | null = null;
    private misclickAt = 0;
    private misclickHold = 0;
    /** port (phase 5a, Track F: kill-stealing): the NPC a rude bot is stealing, from whom, in a multi-combat area, noted */
    private steal: { npc: Npc; victim: Player; multi: boolean; noted: boolean } | null = null;

    /** (the variety work, round 2, Track D2) a bone run's fight (port/BotMagicRuns): its big bones kept for the bank, not buried here */
    keepBigBones = false;
    /**
     * (the variety work, round 2, the fixes) a Wilderness trip's fight (port/BotWildTrips): its spot holds for the trip, no
     * level-up moves it on. The step outgrown at the first level-up took the fight to a spot out of the Wilderness and
     * ended the trip's fight (its errand's sub-task: over when its spot moves); at 10x XP within minutes (WT1 0.26-0.98)
     */
    holdStep = false;

    constructor(step: SkillStep, stat: PlayerStat) {
        super('Combat');
        this.step = step;
        this.primaryStat = stat;
        this.stat = TRAIN_CYCLE[0].stat; // always start on attack
        this.watchdog.follow(() => this.step.location);
    }

    // ─────────────────────────────────────────────
    // LOGGING
    // ─────────────────────────────────────────────
    private lastLogKey = '';
    private lastLogTime = 0;

    private _log(player: Player | null, msg: string, key?: string): void {
        const now = Date.now();
        const logKey = key ?? msg;

        if (this.lastLogKey === logKey && now - this.lastLogTime < 750) return;

        this.lastLogKey = logKey;
        this.lastLogTime = now;

        const prefix = player ? `[P:${player.x},${player.z}]` : '[BOT]';
        console.log(`${prefix} [CombatTask] ${msg}`);
    }

    override activityStep(): SkillStep | null {
        return this.step;
    }

    shouldRun(player: Player): boolean {
        // port: a weapon worn or banked counts (combatWeaponFor), and no fighting at low health without food
        // (a fight under way goes on to its own limits: FIGHT_START_WITHOUT_FOOD is for one that starts)
        // port (the variety work, round 1, the integrator's): once started, its own low-Hitpoints rule decides (it eats, or
        // runs from its attackers to the bank and ends there unfit: tick's HP check, the bank state's fitToFight). Ending it
        // here came first: a hit from 4 to 2 of 10 at Edgeville's men ended the task, the planner picked woodcutting, and
        // the man still on the bot killed it by its trees (test/sim.mjs world, 100 bots)
        if (combatWeaponFor(player, this.step) === null) return false;
        return this.taskTicks > 0 || fitToFight(player, this.step, true);
    }

    /** port: the fight is over and the bot on its way out: its run from the attackers to the bank, the bank, eating */
    private _leaving(): boolean {
        return this.state === 'bank_walk' || this.state === 'bank_deposit' || this.state === 'eat' || (this.state === 'flee' && this.fleeToBank);
    }

    tick(player: Player): void {
        this._lastPlayer = player;
        this.taskTicks++;
        if (this.taskTicks === 1) this._notePack(player);
        // port (the realism work): a target lost (a kill, the loot picked up, the game's own retaliation): the next click
        // a person's moment later
        this.pause.observe(player);

        if (this.interrupted) return;

        // port (the realism work, phase 5a, Track F): a misclick on a busy NPC is let go (274 answers it with "Someone else
        // is fighting that." at once; should the fight there have ended, the bot does not fight on: a misclick is harmless)
        if (this.misclickNpc && this.taskTicks - this.misclickAt >= this.misclickHold) {
            if (player.target === this.misclickNpc) player.clearPendingAction();
            this.misclickNpc = null;
        }

        // (the variety work, round 1, the fixes: and its trips to sell junk, as RangedMagicTask's: the walk from Lumbridge's
        // east cows to the general store goes north round their field, away from the spot, and the watchdog jumped the
        // bot back onto the spot, from where it set off again: AM10's Combat@varrock_east_mine_south, 5-8 a run)
        const banking = this.state === 'bank_walk' || this.state === 'bank_deposit' || this.state === 'shop_walk' || this.state === 'shop_open' || this.state === 'shop_sell';
        const [sx, sz, sl] = this.step.location;
        const atSpot = player.level === sl && Math.max(Math.abs(player.x - sx), Math.abs(player.z - sz)) <= 15;

        if (this.watchdog.check(player, banking)) {
            player.clearWaypoints();
            player.clearPendingAction();
            // port: and another spot: nothing came of this one for 150 ticks (no NPC it could reach: the Crafting
            // Guild coast's hobgoblins are behind the rocks). Upstream teleported the bot back to the same spot for good.
            // Only a stall at the spot counts against it: the port's first version also gave up on a spot the bot was
            // still walking to, and walked off to another far one, and again (a teleport every ~150 ticks)
            if (atSpot) {
                this.failedSteps.add(this.step);
                this._rerollStep(player);
            }
            this._log(player, `WATCHDOG TRIGGERED (${atSpot ? 'at the spot: another one' : 'on the way'}), restarting scan`, 'watchdog');
            this.stuck.reset();
            this._releaseNpc();
            this.currentNpc = null;
            this.scanFail = 0;
            this.fleeTicks = 0;
            this.fleeToBank = false;
            this.cooldown = 0;
            this.state = 'walk';
            return;
        }

        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }

        if (this.intentCooldown > 0) this.intentCooldown--;

        // ── HP CHECK & HEALING ───────────────────────────────────────────────────
        // port: current Hitpoints (upstream compared the Hitpoints XP, so this never fired); without food the bot
        // leaves the fight for the bank (it withdraws food there; with none, the task ends) instead of fleeing back
        // to the same spot and fighting on
        const hp = currentHp(player);
        const hpMax = maxHp(player);

        // Low HP check
        // port: with two or more at it (a multi-combat spot: Varrock's dark wizards cast from range) at half its
        // Hitpoints, not 40% (a fighter there ate, fought on and died on its way to the bank)
        const leaving = this._leaving();
        // port (the realism work, phase 5a, Track F: forgotten food): without food a careless bot (about 1 in 8) pushes on to
        // a quarter of its Hitpoints before it leaves, against one foe or several ("one more kill"): where the occasional
        // death in a fight comes from; one that left its food in the bank says so now and then when it notices
        const noFood = !this._hasFood(player);
        const pushOn = noFood && isCareless(player);
        if (noFood && hpBelow(player, FIGHT_WITHOUT_FOOD_ABOVE) && forgotFood(player)) noticeNoFood(player);
        if (!leaving && (hpBelow(player, pushOn ? CARELESS_LEAVE_BELOW : EAT_BELOW) || (hpBelow(player, pushOn ? CARELESS_LEAVE_BELOW : FIGHT_WITHOUT_FOOD_ABOVE) && this._underSeveral(player)))) {
             if (this._hasFood(player)) {
                 this._log(player, `HP low (${hp}/${hpMax}), eating...`, 'heal_trigger');
                 this.state = 'eat';
                 this.eatTries = 0;
                 return;
             } else {
                 this._log(player, `HP low (${hp}/${hpMax}) and NO FOOD, leaving for the bank`, 'flee_low_hp');
                 this._releaseNpc();
                 this.currentNpc = null;
                 player.clearPendingAction();
                 // port: running from its attackers first (port/BotDefence), then the bank walk; upstream walked to the
                 // bank with them hitting it all the way
                 this.state = 'flee';
                 this.fleeToBank = true;
                 this.fleeTicks = 0;
                 return;
             }
        }

        // ── AGGRESSOR DETECTION ──────────────────────────────────────────────────
        // If an NPC that we did not initiate combat with starts chasing the bot
        // and its combat level exceeds the bot's, retreat to the spawn area.
        // Skip this check while banking/shopping — the bot is already leaving.
        // port: and while it fights (upstream skipped 'interact': a second, stronger attacker went unnoticed), where the
        // nearest attacker can be its own foe
        const safeStates = ['bank_walk', 'bank_deposit', 'flee', 'bury', 'eat'];
        if (!safeStates.includes(this.state)) {
            let aggressor = findAggressorNpc(player, 8);
            if (aggressor && aggressor === this.currentNpc) aggressor = findOtherAggressorNpc(player, this.currentNpc, 8);
            if (aggressor && aggressor !== this.currentNpc) {
                const npcLvl = getNpcCombatLevel(aggressor);
                if (npcLvl > player.combatLevel) {
                    this._log(player, `fleeing from lvl-${npcLvl} ${this._npcLabel(aggressor)}`, 'flee_trigger');
                    this._releaseNpc();
                    this.currentNpc = null;
                    this.state = 'flee';
                    this.fleeToBank = false;
                    this.fleeTicks = 0;
                    return;
                }
            }
        }

        // (the variety work, round 2, Track D2: a bone run's fight keeps its big bones for the bank: keepBigBones)
        const hasBones = hasItem(player, Items.BONES) || (!this.keepBigBones && hasItem(player, Items.BIG_BONES));

        const inventoryFull = isInventoryFull(player);
        const timeReady = this.taskTicks - this.lastBuryTick >= this.BURY_INTERVAL_TICKS;
        const shouldBury = hasBones && timeReady;

        if (this.state !== 'bury' && shouldBury) {
            this.state = 'bury';
            this._log(player, '→ bury bones', 'bury_bones');
            return;
        }

        if (this.state === 'bury') {
            const inv = player.getInventory(InvType.INV);
            if (!inv) {
                this.state = 'scan';
                return;
            }

            // BIG BONES FIRST
            for (let slot = 0; slot < inv.capacity; slot++) {
                const item = inv.get(slot);
                if (!item) continue;

                // port: buried with the game's Bury op (its animation and XP), as normal bones are; upstream removed
                // them and added the XP
                if (item.id === Items.BIG_BONES && !this.keepBigBones) {
                    interactHeldOp(player, inv, item.id, slot, 1);
                    this._log(player, 'buried big bones', 'bury_big');
                    this.cooldown = 1 + humanDelay(player, 'page'); // port (the realism work): a person's pace
                    return;
                }
            }

            // NORMAL BONES
            for (let slot = 0; slot < inv.capacity; slot++) {
                const item = inv.get(slot);
                if (!item) continue;

                if (item.id === Items.BONES) {
                    interactHeldOp(player, inv, item.id, slot, 1);
                    this._log(player, 'buried bones +45 XP', 'bury_small');
                    this.cooldown = 1 + humanDelay(player, 'page'); // port (the realism work): a person's pace
                    return;
                }
            }

            // but wait 1 extra tick as a safety net before giving up.
            this.buryWaitTicks++;
            if (this.buryWaitTicks < 2) {
                return;
            }

            // All bones buried or server never delivered
            this._log(player, 'finished burying', 'bury_done');
            this.lastBuryTick = this.taskTicks;
            this.buryCount = 0;
            this.buryWaitTicks = 0;
            this.state = 'scan';
            return;
        }

        // ── LEVEL UPDATE ─────────────────────────────
        // port: only when the level rose, and only off a spot the bot has outgrown, to one it has the weapon for
        // (BotKnowledge.levelUpStep; upstream jumped every tick to any higher step, weapon or not)
        const level = getBaseLevel(player, this.primaryStat);
        const skillName = this.primaryStat === PlayerStat.ATTACK ? 'ATTACK' : this.primaryStat === PlayerStat.STRENGTH ? 'STRENGTH' : 'DEFENCE';

        if (this.stepLevel === -1) this.stepLevel = level;
        const newStep = level > this.stepLevel && !this.holdStep ? levelUpStep(skillName, this.step, level, s => combatWeaponFor(player, s) !== null && !this.failedSteps.has(s), [player.x, player.z]) : null;
        this.stepLevel = level;
        if (newStep && newStep !== this.step) {
            this._log(player, `LEVEL UP → ${this.step.minLevel} → ${newStep.minLevel}`, 'level_up');
            this.step = newStep;
            this._releaseNpc();
            this.state = 'walk';
            this.currentNpc = null;
            this.scanFail = 0;
            this.patrolTarget = null;
            this.patrolTicks = 0;
        }

        // ── INVENTORY FULL ───────────────────────────
        if (isInventoryFull(player) && !['bank_walk', 'bank_deposit', 'shop_walk', 'shop_open', 'shop_sell'].includes(this.state)) {
            // Check if we have junk to sell - prefer shop over banking
            // (port: at a general store near the spot, else the bank: _junkStore)
            this.junkStore = this._junkStore();
            if (this.junkStore && this._hasJunkToSell(player)) {
                this._log(player, 'INVENTORY FULL → shop_walk (selling junk)', 'inv_full');
                this.idleSells = 0;
                this.lastSellPack = -1;
                this.soldHere = false;
                this.state = 'shop_walk';
            } else {
                this._log(player, 'INVENTORY FULL → bank_walk', 'inv_full');
                this.state = 'bank_walk';
            }
            this.currentNpc = null;
            return;
        }

        // ── DUNGEON EXIT ──────────────────────────────
        // If the bot is underground (z > 6000) and needs to bank or shop,
        // teleJump back to the surface dungeon entrance first so the surface
        // pathfinder can take over.
        if ((this.state === 'bank_walk' || this.state === 'shop_walk') && player.z > 6000) {
            const [ex, ez, el] = dungeonRoute(player.x, player.z).entrance; // port: this dungeon's way out
            this._log(player, `dungeon exit → ${ex},${ez}`, 'dungeon_exit');
            walkTo(player, ex, ez, el); // port: walkTo climbs out by the dungeon's ladder where it has one, else jumps
            return;
        }

        // ── SHOP ──────────────────────────────────────
        if (this.state === 'shop_walk') {
            if (!this.junkStore) {
                this.state = 'bank_walk';
                return;
            }
            const [keeper, [sx, sz, sl]] = this.junkStore;

            if (!isNear(player, sx, sz, 8, sl)) {
                this._stuckWalk(player, sx, sz);
                return;
            }

            const shopNpc = findNpcByName(player.x, player.z, player.level, keeper, 10);
            if (!shopNpc) return;

            interactNpcOp(player, shopNpc, 3);
            this.currentNpc = shopNpc;
            this.state = 'shop_open';
            this.cooldown = 2;
            return;
        }

        if (this.state === 'shop_open') {
            this.cooldown = 2;
            this.state = 'shop_sell';
            return;
        }

        if (this.state === 'shop_sell') {
            if (!this.currentNpc) {
                this.state = 'bank_walk';
                return;
            }

            // (port, 2026-10-18: a few clicks in a row that changed nothing, the shop refusing: "The shop has run out of
            // space." (its slots full of the world's loot), or a full pack's stack with no room for the coins: the bank)
            const pack = packTotal(player);
            if (this.lastSellPack !== -1 && pack !== this.lastSellPack) this.soldHere = true;
            this.idleSells = pack === this.lastSellPack ? this.idleSells + 1 : 0;
            this.lastSellPack = pack;
            // (a visit that sold nothing: this store is not asked again in this fight, its next full pack goes to the bank)
            if (this.idleSells >= IDLE_SELLS && !this.soldHere) this.refusedStore = this.junkStore?.[0] ?? null;

            this._sellJunk(player, this.currentNpc);

            // (port: or nothing left to sell: the rest is kept, food and raw meat too, and goes to the bank)
            if (!isInventoryFull(player) || !this._hasJunkToSell(player) || this.idleSells >= IDLE_SELLS) {
                this.state = 'bank_walk';
                this.currentNpc = null;
            }

            return;
        }

        // ── BANK ──────────────────────────────────────
        if (this.state === 'bank_walk') {
            // port: hurt and attacked on the way (Lumbridge's bears on the walk from the swamp to Draynor): it runs first
            if (hpBelow(player, EAT_BELOW) && runFromAttackers(player)) return;
            const result = advanceBankWalk(player, this.stuck);
            if (result === 'walk') return;
            // port (the realism work): a person's stop at the booth, never the same twice (port/BotHabits.bankStop)
            this.cooldown = result === 'ready' ? bankStop(player) : 0;
            this.state = 'bank_deposit';
            return;
        }

        if (this.state === 'bank_deposit') {
            this._unequipArmor(player);    // WORN armor → INV so it can be banked
            _equipLoot(player);
            cleanGrimyHerbs(player);
            this._depositGold(player);
            this._depositLoot(player);     // deposits unequipped armor too
            bankFoodAbove(player, COMBAT_FOOD); // port (variety round 1, track F): spare food above the trip's goes in too
            // port: the best food the bot can eat here (was: sharks, then any). port (the realism work, phase 5a, Track F:
            // forgotten food): now and then it leaves without (FORGET_FOOD × its carelessness) or with only 2-4
            const carried = carriedFood(player);
            if (carried < COMBAT_FOOD && bankedFood(player) > 0) {
                const took = packFoodRoll(player, carried);
                if (took === 'full') withdrawFood(player, COMBAT_FOOD);
                else if (took === 'few') withdrawFood(player, randInt(2, 4));
            } else withdrawFood(player, COMBAT_FOOD);
            this._withdrawAndEquipArmor(player); // withdraw + equip best armor for defence level
            this._withdrawAndEquipWeapon(player); // withdraw + equip best scimitar for attack level
            this._withdrawStepWeapon(player);    // port: any other weapon the step accepts, if no scimitar did
            this._meleeInHand(player, true);     // port: and no bow or staff in hand (from ranged or magic training)
            dressForFight(player);               // port (the variety work, round 1, track W): a style's hat, robe or leather where no metal went
            // port (the variety work, round 1, the fixes): a spot beyond the sewers' web, a blade to cut it (a mace or a
            // warhammer does not: a knife from the bank), else another spot
            takeWebBlade(player, this.step);
            if (webBladeFor(player, this.step) !== 'carried') {
                this.failedSteps.add(this.step);
                this._rerollStep(player);
            }
            // port: the spot holds for the plan (15-60 minute plans; a level-up still moves it on). Upstream
            // drew a random spot after every load, often across the map

            // port: no food in the bank either and still hurt: done for now (the planner picks something else
            // while the Hitpoints come back; fitToFight keeps it from picking combat meanwhile)
            if (!fitToFight(player, this.step)) {
                this._log(player, 'no food and low HP → task done', 'no_food');
                this.interrupt();
                return;
            }

            this.state = 'walk';
            this.cooldown = 3;
            return;
        }

        // ── WALK ──────────────────────────────────────
        if (this.state === 'walk') {
            // On first entry to walk (task just started or re-assigned after another task),
            // equip any weapon that accumulated in inventory (e.g. sword drops from a
            // previous RangedMagicTask run).  _equipLoot is also called after banking, so
            // this only matters for the very first walk before the first bank trip.
            if (!this._startEquipDone) {
                _equipLoot(player);
                this._startEquipDone = true;
                // port: the step's weapon is in the bank (an earlier bank trip, or another task, put it there)
                if (combatWeaponFor(player, this.step) === 'banked') {
                    this._log(player, 'weapon in the bank → bank_walk', 'weapon_banked');
                    this.state = 'bank_walk';
                    return;
                }
                // port (the realism work, phase 4: no plate at a skill, port/BotGear dressForSkill): its armour is in the
                // bank (a skill's bank stop took it off): it goes on there first, as a player puts their armour back on
                // (the variety work, round 1, track W: or a cook's chef's hat on, away from the range: port/BotGear)
                if (needsFightDress(player)) {
                    this._log(player, 'armour in the bank → bank_walk', 'armour_banked');
                    this.state = 'bank_walk';
                    return;
                }
                // port: and a bow or a staff in hand from ranged or magic training: a melee weapon (_meleeInHand)
                if (this._meleeInHand(player, false) === 'banked') {
                    this._log(player, 'a bow in hand, a melee weapon in the bank → bank_walk', 'weapon_banked');
                    this.state = 'bank_walk';
                    return;
                }
            }

            // Check for loot only if:
            // 1. Bot is near the combat area (within 20 tiles)
            // 2. Has fought in this area before
            const [lx, lz, ll] = this.step.location;
            const inCombatArea = isNear(player, lx, lz, 20, ll);

            if (inCombatArea && this.hasFoughtInArea) {
                const lootObj = findLootObj(player, player.x, player.z, player.level, 1, this._lootOk);
                if (lootObj) {
                    this.state = 'loot';
                    return;
                }
            }

            if (!isNear(player, lx, lz, 15, ll)) {
                // ── Dungeon navigation ─────────────────────────────────────────
                // Combat steps with extra.dungeon=true target underground areas
                // (z > 6000). The pathfinder cannot route across the surface/dungeon
                // boundary, so we walk the bot to the entrance then teleJump inside.
                const extra = this.step.extra as { dungeon?: boolean } | undefined;
                if (extra?.dungeon && lz > 6000 && player.z < 6000) {
                    const { entrance: [ex, ez], floor: [fx, fz, fl] } = dungeonRoute(lx, lz); // port: this dungeon's way in
                    if (!isNear(player, ex, ez, 6)) {
                        this._stuckWalk(player, ex, ez);
                        return;
                    }
                    // At entrance — teleJump to dungeon floor just inside
                    // (the variety work, round 1, Track D: a manhole or a trapdoor opened, then climbed down: port/BotDungeons)
                    if (enterDungeon(player, dungeonRoute(lx, lz))) return;
                    if (!climbDownNear(player, 6)) botTeleport(player, fx, fz, fl, 'dungeon'); // port: its ladder, where it has one (variety round 1, F: or its trapdoor, opened first)
                    return;
                }

                // Via waypoint: route through intermediate coord before destination.
                // Used to steer around obstacles (e.g. Draynor Mansion for Barbarian
                // Village combat area).  Only apply when the bot hasn't yet passed it.
                const via = this.step.via;
                if (via && player.level === via[2] && player.z < via[1] && !isNear(player, via[0], via[1], 5)) {
                    const [jx, jz] = botJitter(player, via[0], via[1], 3);
                    this._stuckWalk(player, jx, jz);
                    return;
                }
                const [jx, jz] = botJitter(player, lx, lz, 6);
                this._stuckWalk(player, jx, jz);
                return;
            }

            this.state = 'patrol';
            this.patrolTicks = 0;
            this.patrolTarget = null;
            return;
        }

        // ── EAT ──────────────────────────────────────
        if (this.state === 'eat') {
            this._eatFood(player);
            return;
        }

        // ── FLEE ──────────────────────────────────────
        // Run back toward the spawn area until clear of the aggressor.
        // walkTo automatically uses MoveSpeed.RUN when runenergy >= 30 %.
        if (this.state === 'flee') {
            if (this.fleeToBank) {
                if (runFromAttackers(player)) return;
                this.fleeToBank = false;
                this.state = 'bank_walk';
                return;
            }
            // Check for loot only if near combat area and has fought before
            const [flx, flz] = this.step.location;
            const inCombatArea = isNear(player, flx, flz, 20);
            if (inCombatArea && this.hasFoughtInArea) {
                const lootObj = findLootObj(player, player.x, player.z, player.level, 5, this._lootOk);
                if (lootObj) {
                    this.state = 'loot';
                    return;
                }
            }

            this.fleeTicks++;
            const [lx, lz] = this.step.location;
            // port: away from the NPC it flees (upstream ran to the step's spot: a bot already there stood still and was
            // killed, the only death of a non-PKer in 470 bot-hours of sims), else to the spot
            const chaser = findAggressorNpc(player, 10);
            if (chaser) {
                const dx = Math.sign(player.x - chaser.x) || (Math.random() < 0.5 ? -1 : 1);
                const dz = Math.sign(player.z - chaser.z) || (Math.random() < 0.5 ? -1 : 1);
                this._stuckWalk(player, player.x + dx * 10, player.z + dz * 10);
            } else {
                this._stuckWalk(player, lx, lz);
            }

            if (this.fleeTicks >= this.FLEE_TICKS || (!chaser && isNear(player, lx, lz, 12))) {
                this._log(player, 'fled to safety → scan', 'flee_done');
                this.state = 'scan';
                this.fleeTicks = 0;
                this.scanFail = 0;
            }
            return;
        }

        // ── PATROL ────────────────────────────────────
        if (this.state === 'patrol') {
            // Check for loot only if near combat area and has fought before
            const [lx, lz] = this.step.location;
            const inCombatArea = isNear(player, lx, lz, 20);
            if (inCombatArea && this.hasFoughtInArea) {
                const lootObj = findLootObj(player, player.x, player.z, player.level, 5, this._lootOk);
                if (lootObj) {
                    this.state = 'loot';
                    return;
                }
            }

            const [cx, cz] = this.step.location;
            const [jcx, jcz] = botJitter(player, cx, cz, 8);

            // port: no gate sweep here every patrol tick (it sent bots to every door, drawer and cupboard near their
            // spot, a third of all bot AI time): a gate is opened when the way to an NPC turns out to be shut
            // (_approachNpc, the interact timeouts) or a walk is stuck (_stuckWalk), and walkTo opens one in a route
            // that is shut altogether

            this.patrolTicks++;

            if (!this.patrolTarget || this.patrolTicks % randInt(3, 6) === 0) {
                this.patrolTarget = [jcx + randInt(-8, 8), jcz + randInt(-8, 8)];
            }

            const [tx, tz] = this.patrolTarget;
            walkTo(player, tx, tz);

            if (this.patrolTicks % 2 === 0) {
                let npc = this._findTargetNpc(player);

                if (!npc) {
                    npc = this._findTargetNpcWider(player);
                }

                if (npc && this.pause.ready) {
                    this._log(player, `patrol found NPC → ${this._npcLabel(npc)}`, 'patrol_found');

                    // Walk into melee range before engaging — prevents the engine
                    // routing backward when the NPC is partially obstructed.
                    if (!isNear(player, npc.x, npc.z, 5)) {
                        this._approachNpc(player, npc);
                        return;
                    }

                    // port (variety round 1, F: ISS-11): not one out of reach; a gate between opened first
                    if (this._reachFirst(player, npc)) return;
                    this._claimNpc(npc);
                    this.currentNpc = npc;
                    this.hasHit = false;
                    this.approachStalls = 0;
                    this.gateTries = 0;
                    this.reclick = false;
                    this.gateLoc = null;
                    setCombatStyle(player, TRAIN_CYCLE[this.trainIndex].style);
                    interactNpcOp(player, npc, 2);

                    this.state = 'interact';
                    this.interactTicks = 0;
                    this.approachTicks = 0;
                    this.lastXp = player.stats[this.stat];
                    this.scanFail = 0;
                    this.hasFoughtInArea = true;
                    return;
                }
            }

            if (this.patrolTicks > randInt(6, 12)) {
                this.state = 'scan';
                this.patrolTicks = 0;
                this.patrolTarget = null;
            }

            return;
        }

        // ── SCAN ──────────────────────────────────────
        if (this.state === 'scan') {
            // Check for loot only if near combat area and has fought before
            const [lx, lz] = this.step.location;
            const inCombatArea = isNear(player, lx, lz, 20);
            if (inCombatArea && this.hasFoughtInArea) {
                const lootObj = findLootObj(player, player.x, player.z, player.level, 5, this._lootOk);
                if (lootObj) {
                    this.state = 'loot';
                    return;
                }
            }

            // port: no gate sweep before every scan (see patrol): with any closed door or gate within 30 tiles, even one
            // it could not reach, the bot never scanned for an NPC at all

            // port (the realism work): after a kill the next NPC a moment later, as a person looks round for one
            // (TargetPause; one that attacks meanwhile gets the game's own retaliation, and the HP checks above still
            // run). Upstream clicked the next in the tick after the kill
            if (!this.pause.ready) return;

            // port (the realism work, phase 5a, Track F: misclicks): the click on a busy NPC is answered first ("Someone else
            // is fighting that."): its own NPC after it, a person's moment later (TargetPause)
            if (this.misclickNpc && player.target === this.misclickNpc) return;

            // port: an NPC already attacking the bot is the one to fight (attacking another gives "I'm already under
            // attack" outside a multi-combat area: 95 of those in a sim), unless it is one to flee from (above)
            const attacker = findAggressorNpc(player, 2);
            let npc = attacker && getNpcCombatLevel(attacker) <= player.combatLevel ? attacker : this._findTargetNpc(player);

            // port (phase 5a, Track F: kill-stealing): a rude bot now and then takes the NPC someone else is on the way to
            // (single-way: the race) or fights (multi-combat: the most damage takes the drop), where that one is the
            // nearest; within its caps (port/BotRude)
            if (!(attacker && npc === attacker)) {
                const steal = this._stealPick(player, npc);
                if (steal) {
                    this._engage(player, steal.npc, steal);
                    return;
                }
            }

            if (!npc) {
                this.scanFail++;

                if (this.scanFail <= 2) {
                    this._log(player, `scan fail ${this.scanFail}`, 'scan_fail');
                }

                if (this.scanFail === 2) {
                    npc = this._findTargetNpcWider(player);
                }

                if (this.scanFail === 3) {
                    this._stuckWalk(player, player.x + randInt(-4, 4), player.z + randInt(-4, 4));
                    return;
                }

                if (this.scanFail >= 4) {
                    this.scanFail = 0;
                    this.state = 'patrol';
                }

                return;
            }

            this._log(player, `found NPC → ${this._npcLabel(npc)}`, 'npc_found');

            // Walk into melee range before engaging — prevents the engine
            // routing backward when the NPC is partially obstructed.
            if (!isNear(player, npc.x, npc.z, 5)) {
                this._approachNpc(player, npc);
                return;
            }

            // port (phase 5a, Track F: misclicks): now and then the click lands on a busy NPC of its kind first (a harmless
            // one, port/BotFumble), inside the moment it takes anyway
            if (npc !== attacker && fumbleDue(player) && this._misclick(player, npc)) return;

            this._engage(player, npc, null);
            return;
        }

        // ── LOOT ──────────────────────────────────────
        if (this.state === 'loot') {
            // Blocklist: items to skip picking up
            const BLOCKLIST = [288]; // goblin mail

            // Find any ground object - picks up everything
            let obj = findLootObj(player, player.x, player.z, player.level, 5, this._lootOk);

            // Skip blocked items
            if (obj && BLOCKLIST.includes(obj.type)) {
                obj = null;
            }
            // port (the realism work): each item a person's moment after the last thing it clicked was done with
            // (TargetPause; the next item was picked up in the tick after the last: Combat's re-targets within a tick)
            if (obj && !this.pause.ready) return;
            // port: one it has gone for 10 ticks without picking it up (behind a fence): left for 300 ticks
            if (obj && obj === this.lootObj && ++this.lootTicks > 10) {
                this.skipLoot.set(obj, this.taskTicks + 300);
                obj = null;
            }
            if (obj && obj !== this.lootObj) {
                this.lootObj = obj;
                this.lootTicks = 0;
            }

            if (!obj) {
                // port: to the next NPC when there is none left to fight (upstream went back to 'interact' with no NPC
                // and stood there until the watchdog moved it, up to 90 s after a kill that dropped nothing)
                this.state = this.currentNpc ? 'interact' : 'scan';
                return;
            }

            this._log(player, `looting ${obj.type} @ ${obj.x},${obj.z}`, 'loot_found');

            if (!isNear(player, obj.x, obj.z, 1)) {
                walkTo(player, obj.x, obj.z);
                return;
            }

            interactObjOp(player, obj, 3);
            this.pause.held(); // (a pickup is over before the next tick's look: the pause starts from it)
            this.cooldown = randInt(1, 2);
            this.state = 'scan';
            return;
        }

        // ── COMBAT ───────────────────────────────────
        if (this.state === 'interact') {
            this.interactTicks++;
            this.approachTicks++;
            // port: on the way to the gate in the way: open it once there, then click the NPC again
            if (this.gateLoc && player.target !== null && 'nid' in (player.target as object)) this.gateLoc = null; // (fighting after all)
            if (this.gateLoc && this.currentNpc) {
                if ((player.hasWaypoints() || player.target !== null) && this.interactTicks < 20) return;
                const r = openGateLoc(player, this.gateLoc);
                if (r === 'walking' && this.interactTicks < 20) return;
                this.gateLoc = null;
                this.reclick = true;
                // port (the realism work): the NPC clicked again a moment after the gate opened (BotTiming 'retarget')
                this.cooldown = r === 'opened' ? humanDelay(player, 'retarget') : 0;
                return;
            }
            if (this.reclick && this.currentNpc && !player.hasWaypoints() && player.target === null && !player.delayed) {
                this.reclick = false;
                // port (variety round 1, F: ISS-11): not when it moved out of reach meanwhile
                // (variety round 2, Track D2: D2-7) a door shut between meanwhile: opened first (the gate leg), then the click
                if (this._doorBeforeClick(player, this.currentNpc)) return;
                if (this._outOfReach(player, this.currentNpc)) {
                    this._releaseNpc();
                    this.currentNpc = null;
                    return;
                }
                setCombatStyle(player, TRAIN_CYCLE[this.trainIndex].style);
                interactNpcOp(player, this.currentNpc, 2);
            }

            // port (the realism work, phase 5a, Track F: kill-stealing): another player has the NPC before the bot's first
            // hit (it fights it: a rude bot's steal, the human, an NPC that went for someone): every fighter gives it up at
            // once, a person's moment later the next (it re-engaged twice before, for nothing: "Someone else is fighting
            // that."), and now and then says so ("ks!": port/BotChatter.argue). A rude bot's own steal: in a multi-combat
            // area it fights on (it joins on purpose); a single-way race it lost, it lets go quietly
            if (this.currentNpc && !this.hasHit) {
                const taker = npcFighting(this.currentNpc);
                const mine = this.steal !== null && this.steal.npc === this.currentNpc;
                if (taker && taker !== player && !(mine && this.steal!.multi)) {
                    const npc = this.currentNpc;
                    this._releaseNpc();
                    this.currentNpc = null;
                    player.clearPendingAction();
                    if (npc.nid >= 0) this.unreachable.set(npc.nid, this.taskTicks + 100);
                    // (a take, when the other player attacks it: an NPC that went for someone else of its own is no "ks")
                    if (!mine && taker.target === npc) {
                        const incident = noticedTaken('ks', player, taker, npc, isMultiAt(npc.level, npc.x, npc.z));
                        if (incident && claimArgument(incident)) argue(player, incident, 'victim', taker);
                    }
                    this.steal = null;
                    this.state = 'scan';
                    this.interactTicks = 0;
                    this.approachTicks = 0;
                    this.reengages = 0;
                    this.cooldown = humanDelay(player, 'retarget');
                    return;
                }
            }

            // port: the NPC died (it leaves the world a few ticks after the killing blow, so upstream's check below,
            // made only on the tick a hit landed, always found it alive; the kill was noticed 12 ticks later by the
            // timeout, which never moved the style on: fighters trained Attack and nothing else)
            if (this.currentNpc && this.hasHit && !this._isNpcAlive(player, this.currentNpc)) {
                this._noteOwnKill(this.currentNpc);
                this._releaseNpc();
                this.currentNpc = null;
                this.hasHit = false;
                this.trainIndex = (this.trainIndex + 1) % TRAIN_CYCLE.length;
                this.stat = TRAIN_CYCLE[this.trainIndex].stat;
                this.state = 'loot';
                this.interactTicks = 0;
                this.approachTicks = 0;
                return;
            }

            if (player.stats[this.stat] > this.lastXp) {
                this.hasHit = true;
                // port (phase 5a, Track F): a steal's first hit: it is one (the caps were spent at the click), and the victim
                // bot now and then says so (port/BotChatter.argue)
                if (this.steal && this.steal.npc === this.currentNpc && !this.steal.noted) {
                    this.steal.noted = true;
                    const incident = noteSteal('ks', player, this.steal.victim, this.steal.npc, this.steal.multi, this.steal.multi ? 'multi' : 'single');
                    if (this.steal.victim.is_bot && claimArgument(incident)) argue(this.steal.victim, incident, 'victim', player);
                }
                // port: no bonus XP for the hit (bots level at the world's rate, on the game's XP).
                // Upstream added 2.0 XP to a random melee stat for every hit that landed
                this.lastXp = player.stats[this.stat];
                this.interactTicks = 0;
                this.approachTicks = 0; // hit confirmed — NPC is reachable, reset approach timeout
                this.reengages = 0;
                this.watchdog.notifyActivity();

                // Only move to loot when the NPC is actually gone from the world.
                if (this.currentNpc && this._isNpcAlive(player, this.currentNpc)) {
                    // Still alive — keep fighting; engine interaction persists.
                    return;
                }

                // NPC is dead / despawned — free the claim and go loot.
                this._noteOwnKill(this.currentNpc);
                this._releaseNpc();
                this.trainIndex = (this.trainIndex + 1) % TRAIN_CYCLE.length;
                this.stat = TRAIN_CYCLE[this.trainIndex].stat;
                this.state = 'loot';
                this.interactTicks = 0;
                this.approachTicks = 0;
                return;
            }

            // port (the realism work): not in the tick it lost its target (TargetPause)
            if (this.interactTicks >= this.noAttackTimeoutTicks && this.pause.ready) {
                if (this.currentNpc && this._isNpcAlive(player, this.currentNpc)) {
                    // NPC is alive but we haven't landed a hit — a gate or door may be
                    // blocking the approach.  Check for one close-range (12 tiles) before
                    // re-engaging.  openNearbyGate only matches CLOSED doors, so an
                    // already-open gate is transparently skipped and we fall through to
                    // the normal re-engage below.
                    // port: only when the bot did not get to the NPC (a bot next to it is fighting and missing, and
                    // upstream walked it off to a door mid-fight), and not for a gate it cannot get to either
                    const gate = !this._nextToNpc(player, this.currentNpc) && this.gateTries < 2 ? closedGateBetween(player, this.currentNpc.x, this.currentNpc.z, 8) : null;
                    if (gate && openGateLoc(player, gate) !== 'unreachable') {
                        this._log(player, 'gate blocking approach to NPC — opened', 'gate_block_npc');
                        this.gateTries++;
                        this.reengages++;
                        this.gateLoc = gate;
                        this.interactTicks = 0;
                        return;
                    }

                    // port: twice without a hit and it is one the bot cannot hit (behind a fence, or someone else's):
                    // passed over for 200 ticks. Upstream re-engaged for good: each re-engage reset the timeouts below,
                    // so only the watchdog ever ended it, 150 ticks later, giving up the whole spot
                    if (++this.reengages > 2) {
                        if (this.currentNpc.nid >= 0) this.unreachable.set(this.currentNpc.nid, this.taskTicks + 200);
                        this._releaseNpc();
                        this.currentNpc = null;
                        this.state = 'scan';
                        this.interactTicks = 0;
                        this.approachTicks = 0;
                        this.reengages = 0;
                        return;
                    }
                    // No gate in the way — NPC still alive but interaction dropped, re-engage.
                    // port (variety round 1, F: ISS-11): not when it is out of reach now (it walked behind a wall or into
                    // a building): passed over, the next looked for, with no "I can't reach that!"
                    // (variety round 2, Track D2: D2-7) a door between (the palace's rooms): opened first
                    if (this._doorBeforeClick(player, this.currentNpc)) return;
                    if (this._outOfReach(player, this.currentNpc)) {
                        this._releaseNpc();
                        this.currentNpc = null;
                        this.interactTicks = 0;
                        this.approachTicks = 0;
                        this.reengages = 0;
                        return;
                    }
                    this._log(player, 're-engage NPC', 'reengage');
                    setCombatStyle(player, TRAIN_CYCLE[this.trainIndex].style);
                    interactNpcOp(player, this.currentNpc, 2);
                    this.interactTicks = 0;
                    this.approachTicks = 0;
                    return;
                }
                // NPC is gone — stop waiting and scan for another target.
                this._log(player, 'no attack after timeout → NPC gone → loot/scan', 'no_attack_timeout');
                this._releaseNpc();
                this.currentNpc = null;
                this.state = 'loot'; // check for dropped loot first
                this.approachTicks = 0;
                this.interactTicks = 0;
                this.scanFail = 0;
                return;
            }

            if (this.approachTicks >= INTERACT_TIMEOUT) {
                // port: as above, only when the bot is not next to its NPC, and only a gate it can get to
                const gate = this.currentNpc && !this._nextToNpc(player, this.currentNpc) && this.gateTries < 2 ? closedGateBetween(player, this.currentNpc.x, this.currentNpc.z, 8) : null;
                if (gate && openGateLoc(player, gate) !== 'unreachable') {
                    this.gateTries++;
                    this.gateLoc = gate;
                    this.approachTicks = 0;
                    this.interactTicks = 0;
                    return;
                }

                this._releaseNpc();
                this.currentNpc = null;
                this.state = 'scan';
                this.approachTicks = 0;
                this.interactTicks = 0;
                return;
            }

            if (this.interactTicks >= INTERACT_TIMEOUT * 2) {
                this._releaseNpc(); // was missing — ensure claim is freed
                this.currentNpc = null;
                this.state = 'scan';
                this.approachTicks = 0;
                this.interactTicks = 0;
            }
        }
    }

    isComplete(): boolean {
        return false;
    }

    override getDebugInfo(player: Player): BotTaskDebugInfo {
        const [lx, lz, ll] = this.step.location;
        const hp = currentHp(player);
        const hpMax = maxHp(player);
        return {
            task: this.name,
            state: this.state,
            target: this.currentNpc ? `${NpcType.get(this.currentNpc.type).debugname ?? 'npc'}@(${this.currentNpc.x},${this.currentNpc.z})` : undefined,
            destination: { x: lx, z: lz, level: ll },
            details: {
                trainingStat: PlayerStatNameMap.get(this.stat) ?? `stat${this.stat}`,
                hp, maxHp: hpMax,
                interactTicks: this.interactTicks,
                approachTicks: this.approachTicks,
                scanFail: this.scanFail,
                fleeTicks: this.fleeTicks,
                buryCount: this.buryCount,
                stuck: this.stuck.getDebugSnapshot()
            }
        };
    }

    override reset(): void {
        super.reset();

        // port: the gear stays on (upstream took off the armour and weapon at every task switch and at logout: fighters
        // came back from a session in plain clothes, and the gathering task that came next banked the gear)
        this._lastPlayer = null;
        this.reengages = 0;

        this._releaseNpc(); // ensure any held claim is freed on task reassignment
        this.misclickNpc = null; // port (phase 5a)
        this.steal = null;

        this.state = 'walk';
        this.interactTicks = 0;
        this.approachTicks = 0;
        this.lastXp = 0;
        this.scanFail = 0;
        this.pause.reset();
        this.currentNpc = null;
        this.intentCooldown = 0;

        this.trainIndex = 0;
        this.stat = TRAIN_CYCLE[0].stat;

        this.patrolTarget = null;
        this.patrolTicks = 0;
        this.fleeTicks = 0;
        this.fleeToBank = false;
        this.approachStalls = 0;

        this.hasFoughtInArea = false;
        this._startEquipDone = false;
        this.stepLevel = -1;
        this.eatTries = 0;

        this.lastBuryTick = -this.BURY_INTERVAL_TICKS; // expire immediately so timer-fallback fires on first tick with bones
        this.buryCount = 0;
        this.buryWaitTicks = 0;

        this.stuck.reset();
        this.watchdog.reset();
    }

    private _npcLabel(npc: Npc): string {
        const anyNpc = npc as any;
        return anyNpc.type ?? anyNpc.name ?? anyNpc.index ?? 'unknown';
    }

    // ─────────────────────────────────────────────
    // NPC SEARCH
    // ─────────────────────────────────────────────

    /**
     * Returns true if the NPC is available to be targeted:
     *   - not currently in combat (target not set)
     *   - not already claimed by another CombatTask bot
     */
    private _isNpcAvailable(npc: Npc): boolean {
        // Skip NPCs that already have a combat target (being fought by someone else)
        if ((npc as any).target !== null && (npc as any).target !== undefined) return false;
        // Skip NPCs already claimed by another bot this tick
        if (CLAIMED_NPCS.has(_npcKey(npc))) return false;
        if ((this.unreachable.get(npc.nid) ?? -1) > this.taskTicks) return false; // port
        return true;
    }

    private _findTargetNpc(player: Player): Npc | null {
        const extra = this.step.extra as CombatExtra | undefined;
        const radius = 22;
        if (!extra) return null;

        const names: string[] = [];
        if (extra.npcTypes?.length) names.push(...extra.npcTypes);
        if (extra.npcType) names.push(extra.npcType);
        if (extra.npcName) names.push(extra.npcName);

        for (const name of names.sort(() => Math.random() - 0.5)) {
            const npc = findNpcFiltered(player.x, player.z, player.level, npc => npcMatchesName(npc, name) && this._isNpcAvailable(npc), radius);
            if (npc) return npc;
        }

        if (extra.npcPrefix) {
            return findNpcFiltered(player.x, player.z, player.level, npc => !!NpcType.get(npc.type).debugname?.startsWith(extra.npcPrefix!) && this._isNpcAvailable(npc), radius);
        }

        if (extra.npcSuffix) {
            return findNpcFiltered(player.x, player.z, player.level, npc => !!NpcType.get(npc.type).debugname?.endsWith(extra.npcSuffix!) && this._isNpcAvailable(npc), radius);
        }

        return null;
    }

    private _findTargetNpcWider(player: Player): Npc | null {
        const extra = this.step.extra as CombatExtra | undefined;
        const radius = 30;
        if (!extra) return null;

        const names: string[] = [];
        if (extra.npcTypes?.length) names.push(...extra.npcTypes);
        if (extra.npcType) names.push(extra.npcType);
        if (extra.npcName) names.push(extra.npcName);

        for (const name of names.sort(() => Math.random() - 0.5)) {
            const npc = findNpcFiltered(player.x, player.z, player.level, npc => npcMatchesName(npc, name) && this._isNpcAvailable(npc), radius);
            if (npc) return npc;
        }

        return null;
    }

    // ─────────────────────────────────────────────
    // NPC ALIVE CHECK
    // ─────────────────────────────────────────────

    /**
     * Returns true if the NPC object still exists in the world near the player.
     * Uses an object-reference comparison so we never confuse a respawned NPC
     * of the same type with the original target.
     */
    private _isNpcAlive(player: Player, npc: Npc): boolean {
        return findNpcFiltered(player.x, player.z, player.level, n => n === npc, 30) !== null;
    }

    // ─────────────────────────────────────────────
    // NPC CLAIM REGISTRY
    // ─────────────────────────────────────────────

    /** Register this bot's current target so other bots skip it. */
    private _claimNpc(npc: Npc): void {
        this._releaseNpc();
        const key = _npcKey(npc);
        if (key < 0) return; // port: an NPC that has left the world (nid -1) is no one's
        this.claimedNpcKey = key;
        CLAIMED_NPCS.add(this.claimedNpcKey);
        if (this._lastPlayer) NPC_CLAIMERS.set(key, this._lastPlayer); // port (phase 5a): whose it is (a steal's victim)
    }

    /** Release the current claim (NPC died, timed out, or task reset). */
    private _releaseNpc(): void {
        if (this.claimedNpcKey !== -1) {
            CLAIMED_NPCS.delete(this.claimedNpcKey);
            NPC_CLAIMERS.delete(this.claimedNpcKey);
            this.claimedNpcKey = -1;
        }
    }

    /**
     * port: clicks Attack on `npc` (the scan's engage). port (the realism work, phase 5a, Track F): a steal claims nothing
     * (the victim keeps its claim: no other bot piles on) and spends the stealer's caps now (port/BotRude.startSteal); its
     * first hit makes it one (noteSteal).
     */
    private _engage(player: Player, npc: Npc, steal: { npc: Npc; victim: Player; multi: boolean } | null): void {
        // port (the variety work, round 1, track F: ISS-11): not one out of reach (behind the palace's walls, a shut
        // door it cannot get to): passed over for a while, and the next looked for, with no "I can't reach that!"
        if (!steal && this._reachFirst(player, npc)) return;
        if (steal) {
            this._releaseNpc();
            startSteal(player, steal.victim, npc, steal.multi);
            this.steal = { npc, victim: steal.victim, multi: steal.multi, noted: false };
        } else {
            this._claimNpc(npc);
            this.steal = null;
        }
        this.currentNpc = npc;
        this.hasHit = false;
        this.approachStalls = 0;
        this.gateTries = 0;
        this.reclick = false;
        this.gateLoc = null;
        setCombatStyle(player, TRAIN_CYCLE[this.trainIndex].style);
        interactNpcOp(player, npc, 2);

        this.state = 'interact';
        this.interactTicks = 0;
        this.approachTicks = 0;
        this.lastXp = player.stats[this.stat];
        this.scanFail = 0;
        this.hasFoughtInArea = true;
    }

    /**
     * port (the variety work, round 1, track F: ISS-11): is the NPC out of the bot's reach (BotTaskBase.npcReachable)?
     * Then it is passed over for UNREACHABLE_NPC_TICKS and the scan goes on; unknown (no searches left this tick) is no.
     */
    /**
     * (the variety work, round 2, Track D2: D2-7) before a re-click: a closed door or gate between the bot and its NPC
     * (npcReach 'gate': the Al Kharid palace's rooms) is opened first, the NPC kept (the interact state's gate leg clicks
     * it after); true when it went for the door. Twice at most for an NPC (gateTries), as the first click's.
     */
    private _doorBeforeClick(player: Player, npc: Npc): boolean {
        if (this.gateTries >= 2 || npcReach(player, npc) !== 'gate') return false;
        const gate = gateToward(player, npc.x, npc.z);
        if (!gate || openGateLoc(player, gate) === 'unreachable') return false;
        this.gateTries++;
        this.gateLoc = gate;
        this.reclick = false;
        this.interactTicks = 0;
        return true;
    }

    private _outOfReach(player: Player, npc: Npc): boolean {
        if (npcReachable(player, npc) !== false) return false;
        if (npc.nid >= 0) this.unreachable.set(npc.nid, this.taskTicks + UNREACHABLE_NPC_TICKS);
        this._log(player, 'that NPC is out of reach: another', 'npc_out_of_reach');
        this.state = 'scan';
        return true;
    }

    /**
     * port (the variety work, round 1, track F: ISS-11): before a first click on an NPC: out of reach, passed over for a
     * while (the scan goes on); a gate between, opened first (_gateFirst). True when it did either (no click now).
     */
    private _reachFirst(player: Player, npc: Npc): boolean {
        this.gateTries = 0;
        const reach = npcReach(player, npc);
        if (reach === 'no') {
            if (npc.nid >= 0) this.unreachable.set(npc.nid, this.taskTicks + UNREACHABLE_NPC_TICKS);
            this._log(player, 'that NPC is out of reach: another', 'npc_out_of_reach');
            this.state = 'scan';
            return true;
        }
        return reach === 'gate' && this._gateFirst(player, npc);
    }

    /**
     * port (the variety work, round 1, track F: ISS-11): a closed gate or door between the bot and the NPC it is about to
     * click (a pen, a coop, a house): it opens it first (the interact state's gate leg), then clicks the NPC. A click
     * first was "I can't reach that!" (Fred's chicken coop: 54 an hour). True when it went for the gate.
     */
    private _gateFirst(player: Player, npc: Npc): boolean {
        const gate = this.gateTries < 2 ? gateToward(player, npc.x, npc.z) : null;
        if (!gate || openGateLoc(player, gate) === 'unreachable') return false;
        this._claimNpc(npc);
        this.steal = null;
        this.currentNpc = npc;
        this.hasHit = false;
        this.approachStalls = 0;
        this.gateTries++;
        this.gateLoc = gate;
        this.reclick = false;
        this.state = 'interact';
        this.interactTicks = 0;
        this.approachTicks = 0;
        this.lastXp = player.stats[this.stat];
        this.scanFail = 0;
        return true;
    }

    /** port (phase 5a): is this NPC one of the step's (its names, prefix or suffix)? */
    private _matchesStep(npc: Npc): boolean {
        const extra = this.step.extra as CombatExtra | undefined;
        if (!extra) return false;
        const names: string[] = [];
        if (extra.npcTypes?.length) names.push(...extra.npcTypes);
        if (extra.npcType) names.push(extra.npcType);
        if (extra.npcName) names.push(extra.npcName);
        if (names.some(name => npcMatchesName(npc, name))) return true;
        const debugname = NpcType.get(npc.type).debugname ?? '';
        if (extra.npcPrefix && debugname.startsWith(extra.npcPrefix)) return true;
        return !!extra.npcSuffix && debugname.endsWith(extra.npcSuffix);
    }

    /**
     * port (the realism work, phase 5a, Track F: kill-stealing): for a rude bot (port/BotPersona rudeActs), the NPC of its
     * step someone else is going for, when that is the nearest (nearer than `free`, the NPC it would take anyway): in a
     * single-way area one another bot clicked and walks to (its claim) or the human walks to, out of combat, that player at
     * least KS_FAR tiles off and the bot nearer (the race: 274 lets the first hit have it); in a multi-combat area one
     * another player fights (the most damage takes the drop: the human's too). KS_SINGLE or KS_MULTI a
     * pick of that NPC (the roll held a while), within the caps (port/BotRude.maySteal). Null: no steal.
     */
    private _stealPick(player: Player, free: Npc | null): { npc: Npc; victim: Player; multi: boolean } | null {
        if (!rudeActs(player) || !maySteal(player, false)) return null;
        const victims = new Map<Npc, [Player, boolean]>();
        const cheb = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
        const npc = findNpcFiltered(player.x, player.z, player.level, n => {
            if ((this.unreachable.get(n.nid) ?? -1) > this.taskTicks || !this._matchesStep(n)) return false;
            const multi = isMultiAt(n.level, n.x, n.z);
            if (multi) {
                const fighting = npcFighting(n);
                if (!fighting || fighting === player || fighting.target !== n) return false;
                victims.set(n, [fighting, true]);
                return true;
            }
            if (n.target !== null) return false;
            const mine = cheb(player, n);
            const claimer = n.nid >= 0 && CLAIMED_NPCS.has(n.nid) ? NPC_CLAIMERS.get(n.nid) : undefined;
            if (claimer && claimer !== player && claimer.slot !== -1 && claimer.target === n && cheb(claimer, n) >= KS_FAR && mine < cheb(claimer, n)) {
                victims.set(n, [claimer, false]);
                return true;
            }
            // (a human attacking it: one walking to talk to it or to pickpocket it is no victim)
            const human = humanAttacking(n);
            if (human && cheb(human, n) >= KS_FAR && mine < cheb(human, n)) {
                victims.set(n, [human, false]);
                return true;
            }
            return false;
        }, 22);
        if (!npc) return null;
        // (the nearest: nearer than the NPC it would take anyway, as _findNpc measures)
        const d = (n: Npc): number => Math.abs(n.x - player.x) + Math.abs(n.z - player.z);
        if (free && d(free) <= d(npc)) return null;
        const [victim, multi] = victims.get(npc)!;
        if (!maySteal(player, !victim.is_bot)) return null;
        if (!rollFor(player, npc, multi ? rudeRates.multi : rudeRates.single)) return null;
        return { npc, victim, multi };
    }

    /**
     * port (the realism work, phase 5a, Track F: misclicks): a click on a busy NPC of its step instead of `own` (one
     * another player fights from beside it, within MISCLICK_NPC_TILES, in a single-way area: 274 answers "Someone else is
     * fighting that."). Nothing claimed; its own NPC is picked a person's moment after (TargetPause). False: none near.
     */
    private _misclick(player: Player, own: Npc): boolean {
        const busy = findNpcFiltered(player.x, player.z, player.level, n => {
            if (n === own || !this._matchesStep(n)) return false;
            if (Math.max(Math.abs(n.x - player.x), Math.abs(n.z - player.z)) > MISCLICK_NPC_TILES || isMultiAt(n.level, n.x, n.z)) return false;
            const p = npcFighting(n);
            if (p === null || p === player || p.target !== n) return false;
            // (the variety work, round 2, the fixes: beside its footprint, not its south-west tile: a cow is 2×2, and a
            // player fighting one from its east or north side stood 2 off that tile and was never counted)
            const dx = Math.max(0, n.x - p.x, p.x - (n.x + n.width - 1));
            const dz = Math.max(0, n.z - p.z, p.z - (n.z + n.length - 1));
            return Math.max(dx, dz) <= 1;
        }, MISCLICK_NPC_TILES);
        if (!busy) return false;
        interactNpcOp(player, busy, 2);
        this.misclickNpc = busy;
        this.misclickAt = this.taskTicks;
        this.misclickHold = MISCLICK_HOLD_TICKS + Math.max(Math.abs(busy.x - player.x), Math.abs(busy.z - player.z));
        fumbled(player, 'npc');
        return true;
    }

    /**
     * port (phase 5a, Track F: loot manners): its own drop always (after 274 revealed it to everyone at 100 ticks too: a
     * long fight or a run off and back, OWN_KILL_TICKS); another's revealed drop only for a rude bot, near it
     */
    private _mayLoot(o: Obj): boolean {
        const p = this._lastPlayer;
        if (!p || o.receiver64 === p.hash64) return true;
        if (this.ownKills.some(k => k.level === o.level && Math.abs(k.x - o.x) <= 1 && Math.abs(k.z - o.z) <= 1 && this.taskTicks - k.at <= OWN_KILL_TICKS)) return true;
        return rudeActs(p) && Math.max(Math.abs(o.x - p.x), Math.abs(o.z - p.z)) <= RUDE_LOOT_TILES;
    }

    /** port (phase 5a): where a kill of its own fell (its drop's tile) */
    private _noteOwnKill(npc: Npc | null): void {
        if (!npc) return;
        this.ownKills.push({ x: npc.x, z: npc.z, level: npc.level, at: this.taskTicks });
        if (this.ownKills.length > 4) this.ownKills.shift();
    }

    // ─────────────────────────────────────────────
    // STUCK SYSTEM
    // ─────────────────────────────────────────────
    private _stuckWalk(player: Player, lx: number, lz: number): void {
        if (!this.stuck.check(player, lx, lz)) {
            walkTo(player, lx, lz);
            return;
        }

        if (this.stuck.desperatelyStuck) {
            teleportNear(player, lx, lz);
            this.stuck.reset();
            return;
        }

        if (tryOpenNearbyGate(player, 8)) { // port: a door by the bot only (30 sent it to any door around)
            this.intentCooldown = 3;
            return;
        }

        walkTo(player, player.x + randInt(-10, 10), player.z + randInt(-10, 10));
    }

    /**
     * port: walks toward the NPC it picked, and opens the nearest closed gate or door when that walk has left the bot
     * where it was for 3 ticks in a row (the route ends at a fence, or a door is shut): upstream opened gates on
     * timers instead, every patrol and scan tick, whether or not one was in the way.
     */
    private _approachNpc(player: Player, npc: Npc): void {
        const stalled = !player.hasWaypoints() && player.x === this.approachX && player.z === this.approachZ;
        this.approachStalls = stalled ? this.approachStalls + 1 : 0;
        this.approachX = player.x;
        this.approachZ = player.z;
        if (this.approachStalls >= 3 && this.intentCooldown === 0) {
            this.approachStalls = 0;
            const g = closedGateBetween(player, npc.x, npc.z, 8);
            if (g && openGateLoc(player, g) !== 'unreachable') {
                this._log(player, 'the way to the NPC is shut: opening a gate', 'gate_open_approach');
                this.intentCooldown = 4;
                return;
            }
            // port: no gate to open either: there is no way to this NPC from here (across water or a fence). Upstream
            // picked the same nearest NPC again every tick and stood still until its watchdog moved it to the same
            // spot (hobgoblins on the Crafting Guild coast, test/sim.mjs): it is skipped for a while instead
            if (npc.nid >= 0) this.unreachable.set(npc.nid, this.taskTicks + 200);
            this._log(player, 'no way to that NPC: trying another', 'npc_unreachable');
            this.state = 'patrol';
            this.patrolTicks = 0;
            this.patrolTarget = null;
            return;
        }
        walkTo(player, npc.x, npc.z);
    }

    /** port: do two or more NPCs attack the bot (its foe and another)? */
    private _underSeveral(player: Player): boolean {
        const first = findAggressorNpc(player, 8);
        return first !== null && findOtherAggressorNpc(player, first, 8) !== null;
    }

    /** port: is the bot on a tile next to the NPC (its whole size), where a melee attack reaches it? */
    private _nextToNpc(player: Player, npc: Npc): boolean {
        if (player.level !== npc.level) return false;
        const dx = Math.max(npc.x - player.x, 0, player.x - (npc.x + npc.width - 1));
        const dz = Math.max(npc.z - player.z, 0, player.z - (npc.z + npc.length - 1));
        // (the variety work, round 2, Track D2: D2-7) beside it with no wall between (274's reach): a bot beside an Al
        // Kharid palace warrior through the wall of its room was "next to it", so the door between was never opened and the
        // re-engage got "I can't reach that!" (14-22 a run)
        return Math.max(dx, dz) <= 1 && botReachedEntity(player.level, player.x, player.z, npc.x, npc.z, npc.width, npc.length);
    }

    // ─────────────────────────────────────────────
    // STEP RE-ROLL
    // ─────────────────────────────────────────────

    /**
     * After each bank trip, pick a fresh random step from all tiers the bot
     * qualifies for (level + tool ownership).  This spreads bots across
     * locations every inventory cycle instead of every level-up.
     */
    private _rerollStep(player: Player): void {
        const level = getBaseLevel(player, this.primaryStat);
        const skillName = this.primaryStat === PlayerStat.ATTACK ? 'ATTACK' : this.primaryStat === PlayerStat.STRENGTH ? 'STRENGTH' : 'DEFENCE';
        // port: a step whose weapon the bot has now (upstream: in the pack, so with the scimitar just equipped only
        // the steps that want no weapon qualified: chickens, goblins, cows, rats, spiders), and mostly one that suits
        // its level (BotKnowledge.suitedSteps)
        // port: and the nearer the likelier (BotKnowledge.pickStep, as the planner's pick): drawn anywhere, a watchdog at
        // a spot near the bot could send it across the map
        const newStep = getProgressionStepWhere(skillName, level, s => combatWeaponFor(player, s) === 'carried' && webBladeFor(player, s) !== 'none' && !this.failedSteps.has(s), [player.x, player.z]);
        if (newStep) {
            this.step = newStep;
            this.patrolTarget = null;
        }
    }

    // ─────────────────────────────────────────────
    // SHOP + BANK
    // ─────────────────────────────────────────────
    // ─────────────────────────────────────────────
    // SHOP + BANK
    // ─────────────────────────────────────────────
    /** port (2026-10-18): the general store nearest the fight's spot (its surface tile underground), or null past JUNK_STORE_RANGE */
    private _junkStore(): readonly [string, readonly [number, number, number]] | null {
        const [x, z0] = this.step.location;
        const z = z0 > 6000 ? z0 - 6400 : z0;
        const store = nearestGeneral(x, z);
        if (store[0] === this.refusedStore) return null;
        return Math.max(Math.abs(store[1][0] - x), Math.abs(store[1][1] - z)) <= JUNK_STORE_RANGE ? store : null;
    }

    /** port (2026-10-18): the items in the pack as the fight begins, the bot's own (never sold: _keepFromShop) */
    private _notePack(player: Player): void {
        const inv = player.getInventory(InvType.INV);
        for (let slot = 0; inv && slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (item) this.ownItems.add(item.id);
        }
    }

    private _hasJunkToSell(player: Player): boolean {
        const inv = player.getInventory(InvType.INV);
        if (!inv) return false;

        // Check if any item can be sold (not a tool item, not coins, not a banked herb/talisman)
        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item) continue;
            if (this._keepFromShop(item.id)) continue;
            return true;
        }

        return false;
    }

    /**
     * Items the bot banks rather than sells: the step's tools, coins, grimy herbs, the air talisman; port: and its food
     * and the raw meat its kills drop (earned food: the planner's cooking priority cooks the meat it banks). Upstream
     * sold everything else, its food too.
     */
    private _keepFromShop(itemId: number): boolean {
        if (this.step.toolItemIds.includes(itemId) || itemId === Items.COINS || itemId === Items.AIR_TALISMAN) return true;
        // port (phase 4): its accessories, hat, apron, rare or holiday item are banked, never sold (port/BotLooks)
        if (isWardrobeItem(itemId)) return true;
        // port (2026-10-18, "random items in the general store": a black platebody (g)): what the pack held when
        // the fight began (a Treasure Trail's reward, the piece a gear trip took off, another task's leftovers), any rune
        // (a teleporter's laws), any skill's tool and the status pieces (port/BotFashion: trims, gold, god, gilded) are
        // banked; only the fight's own loot is sold
        if (this.ownItems.has(itemId) || isTool(itemId) || isRune(itemId) || statusPieceOf(itemId) !== undefined) return true;
        if (GRIMY_HERB_MAP[itemId] !== undefined) return true;
        return FOOD_IDS.includes(itemId) || itemId === Items.RAW_BEEF || itemId === Items.RAW_CHICKEN;
    }

    private _sellJunk(player: Player, shopNpc: Npc): void {
        //<- shopNpc isn't needed anymore
        const inv = player.getInventory(InvType.INV);
        if (!inv) return;

        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item) continue;

            if (this._keepFromShop(item.id)) continue;

            if (interactIF_UseOp(player, Interfaces.SHOP_SIDE_INV, item.id, slot, 4)) {
                //info: Op 4 is sell 10 (Op1 value, op2 sell 1, op3 sell 5, op4 sell 10)(for SHOP_SIDE) Interfaces.SHOP_INV for buy
                console.log('(' + player.displayName + ') successfully sold item to shop: ' + item.id);
            } else {
                console.log('Could not sell item to shop! (' + item.id + ') for (' + player.displayName + ')');
            }
            //todo: check if more than 10 and repeat interfaceIF_UseOp
        }
    }

    private _depositGold(player: Player): void {
        const inv = player.getInventory(InvType.INV);
        const bid = bankInvId();
        if (!inv || bid === -1) return;

        const bank = player.getInventory(bid);
        if (!bank) return;

        // Keep 200gp in inventory — enough for ~20 Al Kharid gate passes (10gp each)
        // so the bot can exit after banking and reach its next task location.
        // Depositing every coin leaves the bot stranded inside gated areas.
        const KEEP_COINS = 200;

        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item || item.id !== Items.COINS) continue;

            const toDeposit = Math.max(0, item.count - KEEP_COINS);
            if (toDeposit > 0) {
                const moved = inv.remove(item.id, toDeposit);
                if (moved > 0) bank.add(Items.COINS, moved);
            }
        }
    }

    /** port: food the bot can eat on this world (a shark on a free world cannot be eaten) */
    private _hasFood(player: Player): boolean {
        return carriedFood(player) > 0;
    }

    private _eatFood(player: Player): void {
        if (!this._hasFood(player)) {
            // Out of food
            this.state = 'walk';
            return;
        }
        if (eatBestFood(player)) {
            this._log(player, 'ate to heal', 'ate_food');
            // port (the realism work): the next bite at a person's pace (BotTiming 'page'), not every 4th tick
            this.cooldown = 2 + humanDelay(player, 'page');
            this.eatTries = 0;
            // After eating, if HP is still relatively low and we have more food,
            // stay in eat state. Otherwise return to previous activity.
            this.state = hpBelow(player, EAT_UNTIL) && this._hasFood(player) ? 'eat' : 'walk';
            return;
        }
        // port: busy (a delay): try again, but not for ever
        if (++this.eatTries > 5) this.state = 'walk';
    }

    /** Move equipped armor (helm, torso, shield, legs) from WORN back to INV. */
    private _unequipArmor(player: Player): void {
        const equip = player.getInventory(InvType.WORN);
        const inv   = player.getInventory(InvType.INV);
        if (!equip || !inv) return;

        for (let slot = 0; slot < equip.capacity; slot++) {
            if (!ARMOR_WORN_SLOTS.has(slot)) continue;
            const item = equip.get(slot);
            if (!item) continue;
            // port (the realism work, phase 4): a rare or the bunny ears stay on (port/BotLooks: a signature hat)
            if (slot === 0 && isSignatureHat(item.id)) continue;
            const moved = moveItems(equip, inv, item.id, 1);
        }
    }

    /**
     * port: a bow or a staff still in hand (RangedMagicTask leaves its weapon on) is swapped for the best melee weapon
     * the bot can wield: one it carries goes on at once; one in the bank comes out at the bank (`atBank`), else the
     * answer is 'banked' (the task goes there); with none anywhere the hand is emptied (it fights bare-handed). Upstream
     * fought chickens with an oak shortbow and no arrows: no hit, no XP, for good. Null otherwise.
     */
    private _meleeInHand(player: Player, atBank: boolean): 'banked' | null {
        const worn = player.getInventory(InvType.WORN);
        const inv = player.getInventory(InvType.INV);
        const held = worn?.get(3);
        if (!worn || !inv || !held || meleeWeaponTier(held.id) !== null) return null;
        const attack = getBaseLevel(player, PlayerStat.ATTACK);
        const best = (from: Inventory | null): { id: number; slot: number } | null => {
            let found: { id: number; slot: number; tier: number } | null = null;
            for (let slot = 0; from && slot < from.capacity; slot++) {
                const it = from.get(slot);
                const t = it ? meleeWeaponTier(it.id) : null;
                if (it && t && attack >= t[1] && usableOnThisWorld(it.id) && (!found || t[0] > found.tier)) found = { id: it.id, slot, tier: t[0] };
            }
            return found;
        };
        const bid = bankInvId();
        const bank = bid === -1 ? null : player.getInventory(bid);
        let carried = best(inv);
        if (!carried && atBank && bank) {
            const banked = best(bank);
            if (banked && moveItems(bank, inv, banked.id, 1) > 0) carried = best(inv);
        }
        if (carried) {
            interactHeldOp(player, inv, carried.id, carried.slot, 2);
            return null;
        }
        if (!atBank && best(bank)) return 'banked';
        moveItems(worn, inv, held.id, held.count);
        return null;
    }

    /** Move the equipped scimitar from WORN slot 3 back to INV (used on task end). */
    private _unequipWeapon(player: Player): void {
        const equip = player.getInventory(InvType.WORN);
        const inv   = player.getInventory(InvType.INV);
        if (!equip || !inv) return;

        const wornWeapon = equip.get(3);
        if (!wornWeapon) return;
        // Only unequip if it's a scimitar from our managed set.
        if (!SCIMITAR_TIERS.some(s => s.itemId === wornWeapon.id)) return;

        const moved = moveItems(equip, inv, wornWeapon.id, 1);
    }

    /** Withdraw the best armor set the bot qualifies for (based on Defence) and equip it. */
    private _withdrawAndEquipArmor(player: Player): void {
        const inv = player.getInventory(InvType.INV);
        const bid = bankInvId();
        if (!inv || bid === -1) return;
        const bank = player.getInventory(bid);
        if (!bank) return;

        // port: per piece, the best one the bot owns that its Defence allows (earned gear: port/BotGear). Upstream
        // took its level's whole set from the bank, which InitTask had filled with every set from iron to rune.
        // port (the realism work, phase 4: patchwork gear): of any kind (a medium helm, a chainbody, a plateskirt, a
        // square shield: port/BotGear bankedArmourToWear), better than what it wears; no helm over a signature hat
        for (const pieceId of bankedArmourToWear(player)) moveItems(bank, inv, pieceId, 1);

        _equipLoot(player); // equip whatever we just withdrew
    }

    /**
     * Equip the best scimitar the bot qualifies for based on Attack level.
     * Unequips and banks the current weapon first if it needs upgrading.
     * port (the variety work, round 1, track W: WEAR-2, weapon taste, and the wear track's BUG-b): the best melee weapon
     * of any kind the bot owns (worn, carried, banked) that its Attack allows, by metal, its liked kind first at a metal
     * (port/BotGear bestMeleeWeapon); what it held, if worse (a weapon, an axe or pickaxe from the trees and rocks, a
     * bow, a staff, the scythe), to the bank. It used to know scimitars only: a looted mithril 2h, a rune longsword or a
     * dragon longsword went to the bank for an iron scimitar (86-92 % of the bots' melee weapons were scimitars).
     * Directly, at the booth, as the bots' other bank moves (a two-hander's shield to the bank with it).
     */
    private _withdrawAndEquipWeapon(player: Player): void {
        const inv   = player.getInventory(InvType.INV);
        const equip = player.getInventory(InvType.WORN);
        const bid   = bankInvId();
        if (!inv || !equip || bid === -1) return;
        const bank = player.getInventory(bid);
        if (!bank) return;

        const liked = weaponKindOf(player.username);
        const best = bestMeleeWeapon(player, [equip, inv, bank]);
        if (!best) return;
        const held = equip.get(3);
        const heldWeapon = held ? meleeWeaponOf(held.id) : undefined;
        if (held && heldWeapon && (held.id === best.id || weaponScore(heldWeapon, liked) >= weaponScore(best, liked))) return;
        // the held item (and a shield, for a two-hander) to the bank, the best weapon from the pack or the bank into the hand
        if (held) {
            if (bank.add(held.id, held.count) !== held.count) return;
            equip.delete(3);
        }
        const twoHands = ObjType.get(best.id).wearpos2 === 5;
        const shield = equip.get(5);
        if (twoHands && shield && bank.add(shield.id, shield.count) === shield.count) equip.delete(5);
        if (twoHands && equip.get(5)) {
            if (held && bank.remove(held.id, held.count) === held.count) equip.set(3, held);
            return;
        }
        const from = inv.getItemCount(best.id) > 0 ? inv : bank;
        if (from.remove(best.id, 1) === 1) equip.set(3, { id: best.id, count: 1 });
        else if (held && bank.remove(held.id, held.count) === held.count) equip.set(3, held);
    }

    /**
     * port: when no scimitar of the step's metal was withdrawn (_withdrawAndEquipWeapon knows scimitars only), the
     * best other weapon the step accepts comes out of the bank and goes on.
     */
    private _withdrawStepWeapon(player: Player): void {
        if (combatWeaponFor(player, this.step) !== 'banked') return;
        const inv = player.getInventory(InvType.INV);
        const bid = bankInvId();
        const bank = bid === -1 ? null : player.getInventory(bid);
        if (!inv || !bank) return;
        const attack = getBaseLevel(player, PlayerStat.ATTACK);
        let best = -1;
        let bestTier = -1;
        for (let i = 0; i < bank.capacity; i++) {
            const it = bank.get(i);
            const t = it ? meleeWeaponTier(it.id) : null;
            if (!it || !t || attack < t[1] || !usableOnThisWorld(it.id) || t[0] <= bestTier) continue;
            best = it.id;
            bestTier = t[0];
        }
        if (best !== -1 && moveItems(bank, inv, best, 1) > 0) _equipLoot(player);
    }

    private _depositLoot(player: Player): void {
        const inv = player.getInventory(InvType.INV);
        const bid = bankInvId();
        if (!inv || bid === -1) return;

        const bank = player.getInventory(bid);
        if (!bank) return;

        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item) continue;

            if (this.step.toolItemIds.includes(item.id)) continue;
            if (item.id === Items.COINS) continue;
            if (edibleFoodIds().includes(item.id)) continue; // port: members food on a free world goes to the bank

            const moved = inv.remove(item.id, item.count);
            if (moved > 0) {
                bank.add(bankedId(item.id), moved);
            }
        }
    }
}
