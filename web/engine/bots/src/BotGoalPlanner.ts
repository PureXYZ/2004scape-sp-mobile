/**
 * BotGoalPlanner.ts
 *
 * Picks the next task given the bot's personality and current state.
 *
 * Decision order each call:
 *   1. First ever call → InitTask
 *   2. Has bones + wants prayer → BuryBonesTask
 *   3. Weighted skill pick (filtered to skills with content)
 *   4a. Bot can't afford the tools → try a cheaper skill or combat for coins
 *   4b. Bot has tools → WoodcuttingTask/MiningTask/FishingTask/CombatTask
 *
 * Skill rotation is managed by BotPlayer's rescan timer (150 ticks),
 * not here. The planner is stateless about which skill was last chosen.
 * (port: 600 ticks, RESCAN_TICKS, each bot's from a point of its own)
 */

import Player from '#/engine/entity/Player.js';
import InvType from '#/cache/config/InvType.js';
import { PlayerStat, getBaseLevel, hasItem, countItem, isInventoryFull, knownFare, crossingFare } from '#/engine/bot/BotAction.js';
import { Items, Locations, SkillProgression, getProgressionStep, getProgressionStepWhere, getWoodcuttingStepForLog, stepDistance, stepSurface } from '#/engine/bot/BotKnowledge.js';
import type { PickOptions, SkillStep } from '#/engine/bot/BotKnowledge.js';
import { getMissingPurchases, canAffordStep, totalCostOfMissing, hasAllTools, coinsOwned, tripFailedRecently } from '#/engine/bot/BotNeeds.js';
import type { Purchase } from '#/engine/bot/BotNeeds.js';
import { bankInvId, BotTask, canUseTool } from '#/engine/bot/tasks/BotTaskBase.js';
import { InitTask, BuryBonesTask, IdleTask, BankTask } from '#/engine/bot/tasks/UtilTasks.js';
import { ShopTripTask } from '#/engine/bot/tasks/ShopTripTask.js';
import { WoodcuttingTask, woodcutStepRefused } from '#/engine/bot/tasks/WoodcuttingTask.js';
import { MiningTask } from '#/engine/bot/tasks/MiningTask.js';
import { FishingTask } from '#/engine/bot/tasks/FishingTask.js';
import { CombatTask, combatWeaponFor, fitToFight, SCIMITAR_TIERS } from '#/engine/bot/tasks/CombatTask.js';
import { nextGearUpgrade, wardrobeTrip } from '#/engine/bot/port/BotGear.js';
import { FoodTripTask, KEBAB_SELLER } from '#/engine/bot/tasks/FoodTripTask.js';
import { NewbieCombatTask, NewbieTask } from '#/engine/bot/tasks/NewbieTask.js';
import { isNewbie, isSlowNewbie } from '#/engine/bot/port/BotNewbie.js';
import { bankedFood, carriedFood } from '#/engine/bot/tasks/BotTaskBase.js';
import { FiremakingTask } from '#/engine/bot/tasks/FiremakingTask.js';
import { CookingTask } from '#/engine/bot/tasks/CookingTask.js';
import { SmithingTask } from '#/engine/bot/tasks/SmithingTask.js';
import { ThievingTask } from '#/engine/bot/tasks/ThievingTask.js';
import { CraftingTask } from '#/engine/bot/tasks/CraftingTask.js';
import { RangedMagicTask, MIN_COINS_TO_SHOP as RM_MIN_COINS } from '#/engine/bot/tasks/RangedMagicTask.js';
import { RunecraftingTask } from '#/engine/bot/tasks/RunecraftingTask.js';
import { FletchingTask } from '#/engine/bot/tasks/FletchingTask.js';
import { BowStringingTask } from '#/engine/bot/tasks/BowStringingTask.js';
import { PickupSpawnTask } from '#/engine/bot/tasks/PickupSpawnTask.js';
import type { SpawnEntry } from '#/engine/bot/tasks/PickupSpawnTask.js';
import { HerbloreTask } from '#/engine/bot/tasks/HerbloreTask.js';
import { BankstandTask } from '#/engine/bot/tasks/BankstandTask.js';
import { FlaxPickingTask } from '#/engine/bot/tasks/FlaxPickingTask.js';
import { WaterFillingTask } from '#/engine/bot/tasks/WaterFillingTask.js';
import { SocialTask } from '#/engine/bot/tasks/SocialTask.js';
import { VendorTask } from '#/engine/bot/tasks/VendorTask.js';
import { PKerTask } from '#/engine/bot/tasks/PKerTask.js';
import { EdgevillePKerTask } from '#/engine/bot/tasks/EdgevillePKerTask.js';
import { AgilityTask } from '#/engine/bot/tasks/AgilityTask.js';
import { BotDebugService } from '#/engine/bot/debug/BotDebugService.js';
import type { BotPlannerCandidate } from '#/engine/bot/debug/BotDebugTypes.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { hangoutFor } from '#/engine/bot/port/BotHangout.js';
import { cliqueSkillsFor, cliqueStepFor } from '#/engine/bot/port/BotCliques.js';
import type { PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { alchTaskFor } from '#/engine/bot/port/BotAlch.js';
import { keptHookTask, setPieceTaskFor } from '#/engine/bot/port/BotSetPieces.js';
// (the realism work's phase 5a, Track F: the danger check, step 1e, and the White Wolf Mountain reach rule)
import World from '#/engine/World.js';
import { RestTask } from '#/engine/bot/tasks/RestTask.js';
import { hpBelow } from '#/engine/bot/tasks/BotTaskBase.js';
import { DANGER_BELOW, huntedAt, isHealing } from '#/engine/bot/port/BotDefence.js';
import { carelessChance, carelessRoll, dangerStats, isShaken } from '#/engine/bot/port/BotFumble.js';
import { huntsMe, routeDanger, type Danger } from '#/engine/bot/port/BotDanger.js';
import { nearestNode, route as graphRoute } from '#/engine/bot/port/BotWalkGraph.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
// (the variety work, round 1, Track D: what bots do and where) spot capacity and occupancy (the planner's pick leaves the
// bot itself out), favourites and homes from the name, the essence runs
import { setPicker, spotOccupants, spotRoom } from '#/engine/bot/port/BotSpots.js';
import { FAVOURITE_WEIGHT, HOME_WEIGHT, PREFER_WEIGHT, THEME_FIRST, THEME_WEIGHT, favouritesOf, homeOf, nearHome, themeOf, themeStep, type Theme } from '#/engine/bot/port/BotFavourites.js';
import { nearestBankTo } from '#/engine/bot/tasks/BotTaskBase.js';
import { EssenceTask } from '#/engine/bot/tasks/EssenceTask.js';
import { ESSENCE_STEP } from '#/engine/bot/tasks/RunecraftingTask.js';
// (the variety work, round 1, the integrator's: a combat style's training bias; a kind the bank guard just ended)
import { combatStyleOf, type CombatStyle } from '#/engine/bot/port/BotOutfits.js';
import { endedFutileLately } from '#/engine/bot/tasks/BotTaskBase.js';
// ---- (the variety work, round 2, Track D2: new activities) the round's offers (port/BotD2Picks) ----
import { d2NewbiePick, d2Pick, keptErrand } from '#/engine/bot/port/BotD2Picks.js';
// ---- end of Track D2's imports ----

/** Combined bank+inventory flax count required to switch from gathering to spinning. */
const FLAX_SPIN_MIN = 25;

/** (the variety work, round 1, Track D: DO-16) a toll gate on a cook's bank-range loop counts as this many tiles more */
const COOK_TOLL_TILES = 150;

/** port (the realism work, phase 3): how often a bot with a friend online at a skill it trains picks that skill first */
const FRIEND_SKILL_CHANCE = 0.6;

/** port: the wool task is offered only this near the Lumbridge sheep pen (the food trip's 250 tiles) */
const WOOL_TRIP_TILES = 250;

// ── (the variety work, round 1, Track D: what bots do and where) ─────────────────────────────────────────────────────
/**
 * DO-5, a 2004 mix of levelling time (the research: combat 30-40 %,
 * woodcutting about 10, fishing 8-10, mining about 8, fletching at most 8, thieving at most 6, cooking, smithing and
 * crafting 4-5 each, agility about 3, runecrafting and essence 4-6, firemaking about 3). The planners' weights
 * (Personalities) stay as they were, since new bots' ages split their XP by them (port/BotAge); the planner's shuffle
 * multiplies them by these factors. Before: combat 20 % of members' levelling time, fletching 16-20, thieving 9-11,
 * runecrafting 0. A random planner's weights (1-20 from its name) get a floor for combat (MIX_COMBAT_FLOOR) instead.
 */
export const MIX_2004: Readonly<Record<string, Readonly<Partial<Record<string, number>>>>> = {
    Skiller: { ATTACK: 6, STRENGTH: 6, DEFENCE: 5, RANGED: 4, MAGIC: 3, FLETCHING: 0.4, THIEVING: 0.6, RUNECRAFT: 1.4, WOODCUTTING: 0.4, MINING: 0.8, FIREMAKING: 0.7 },
    Fighter: { ATTACK: 1.5, STRENGTH: 1.5, DEFENCE: 1.5, FLETCHING: 0.6, THIEVING: 0.7, RUNECRAFT: 1.2, WOODCUTTING: 0.55 },
    Balanced: { ATTACK: 2.5, STRENGTH: 2.5, DEFENCE: 2.2, RANGED: 2, MAGIC: 1.5, FLETCHING: 0.4, THIEVING: 0.6, RUNECRAFT: 1.1, WOODCUTTING: 0.4, MINING: 0.8 },
    Random: { RANGED: 1.5, MAGIC: 1.5, FLETCHING: 0.45, THIEVING: 0.6, RUNECRAFT: 1, WOODCUTTING: 0.5, MINING: 0.8 }
};
/** a random planner's combat skills weigh at least this (its name's 1-20 otherwise) */
export const MIX_COMBAT_FLOOR = 18;
/** DO-5: the logs claim (10+ logs banked: firemaking or fletching) takes the pick at most this often (was always) */
export const LOGS_CLAIM_CHANCE = 0.8;
/** DO-5: a priority claim's least chance (a skill the bot hardly trains): its materials are used some time */
export const CLAIM_FLOOR = 0.5;
/**
 * WHERE-1 (and the verifier's note): firemaking's lanes within this many tiles of the bot when there are any (its logs
 * come from the bank it stands at, not from a spot); 21-31 % of members' firemaking plans started 300+ tiles away
 */
export const FIRE_LANE_TILES = 150;
/**
 * AM8: a candidate whose spot is FAR_PLAN_TILES or more away is passed over this often (a long trip now and then, as
 * players made; most plans near where the bot is). A favourite or the theme is not.
 */
export const FAR_PLAN_TILES = 300;
export const FAR_PLAN_SKIP = 0.6;
/**
 * a favourite's, the theme's and agility's (every course is far from the F2P towns: a few long trips, as 2004's Gnome
 * course regulars made)
 */
const FAR_LIKED_SKIP = 0.35;
/** DO-7: the first pick after a login carries on what the bot was doing (its login tile, its pack) this often */
export const CARRY_ON_CHANCE = 0.6;
/** DO-7: the picks after a login it keeps trying (a bank trip for a full pack, a shop trip for a tool come first) */
const CARRY_ON_PICKS = 3;
/**
 * DO-6: a theme pick that came to one of these (a tool from a shop or a spawn) goes on with the theme at the next pick:
 * the trip was the theme's (a fisher's net bought, then a fight drawn at the next pick: 1 themed bot in 4 in a 30-minute
 * 500-bot world)
 */
const THEME_TRIP_KINDS = new Set(['ShopTrip', 'PickupSpawn']);
/** DO-6: what a theme's skill is fed by, when it has nothing to work (a smith's ore, a cook's fish): its next candidate */
const THEME_FEEDER: Readonly<Record<string, string>> = { SMITHING: 'MINING', COOKING: 'FISHING' };
/** the task kinds that are a bot's doing (not an errand, the bank, a hang-out or a set piece): a carry-on is one of them */
const DOING_KINDS = new Set(['Combat', 'RangedMagic', 'Woodcut', 'Fish', 'Mine', 'Fletching', 'BowStringing', 'Thieve', 'Cook', 'Smith', 'Crafting', 'Pick Flax', 'Agility', 'Runecrafting', 'Essence', 'Firemaking', 'Herblore']);
/** DO-7: a step this near the login tile is what the bot was doing there */
export const CARRY_ON_TILES = 40;
/** DO-7: a step's nearness to the login tile weighs 1 / (1 + (d / CARRY_ON_NEAR)²): the one it stood at most */
const CARRY_ON_NEAR = 8;
/** DO-7: at a bank, a skill whose gathered stack it holds weighs this much more (it logged out after a deposit) */
const CARRY_ON_BANKED = 3;
/** DO-4: a bot with a talisman crafts runes this often when it picks runecrafting (else it mines essence for sale) */
export const RUNECRAFT_SHARE = 0.4;
/**
 * DO-4: the essence miners at once that make a bot pick something else (the mine is one spot: port/BotSpots; 2004's was
 * busy: 16 at once in a 500-bot world without it; 5.3-5.7 with 8 or 12, under AM9's 1.5 per 100 online)
 */
export const ESSENCE_ROOM = 20;
/**
 * (the variety work, round 1, the plan's default: "a combat style biases training modestly") a ranger's Ranged and a
 * mage's Magic weigh this much more in the shuffle (port/BotOutfits combatStyleOf: the style it dresses for, from its
 * name); a melee bot's weights stay as they are
 */
export const STYLE_TRAINING_BIAS = 2;
/** the woodcutting, fishing and mining steps a pack's items say a bot was at (DO-7: its pack) */
const PACK_SKILLS: readonly [string, (id: number) => boolean][] = [
    ['WOODCUTTING', id => ([Items.LOGS, Items.OAK_LOGS, Items.WILLOW_LOGS, Items.MAPLE_LOGS, Items.YEW_LOGS, Items.MAGIC_LOGS] as number[]).includes(id)],
    ['FISHING', id => ([Items.RAW_SHRIMP, Items.RAW_SARDINE, Items.RAW_TROUT, Items.RAW_SALMON, Items.RAW_TUNA, Items.RAW_LOBSTER, Items.RAW_SWORDFISH, Items.RAW_SHARK, Items.RAW_ANCHOVIES] as number[]).includes(id)],
    ['MINING', id => ([Items.COPPER_ORE, Items.TIN_ORE, Items.IRON_ORE, Items.COAL, Items.GOLD_ORE, Items.MITHRIL_ORE, Items.ADAMANTITE_ORE, Items.CLAY] as number[]).includes(id)],
    ['RUNECRAFT', id => id === Items.RUNE_ESSENCE]
];

const KNIFE_SPAWNS: SpawnEntry[] = [
    // Lumbridge knife is south of the castle — route east of the walls first.
    { coords: Locations.KNIFE_SPAWN_LUMBRIDGE, via: [3199, 3218, 0] },
    { coords: Locations.KNIFE_SPAWN_CATHERBY },
    { coords: Locations.KNIFE_SPAWN_SEERS },
];

// ── Personality ───────────────────────────────────────────────────────────────

export interface BotPersonality {
    name: string;
    weights: Partial<Record<string, number>>;
}

export const Personalities: Record<string, BotPersonality> = {
    SKILLER: {
        name: 'Skiller',
        weights: {
            // Combat — low priority, but still trainable
            ATTACK: 2,
            STRENGTH: 2,
            DEFENCE: 2,
            RANGED: 2,
            MAGIC: 2,
            PRAYER: 6,

            // Gathering — high priority
            WOODCUTTING: 15,
            FISHING: 20,
            MINING: 15,

            // Production — high priority
            COOKING: 15,
            SMITHING: 15,
            FIREMAKING: 9,
            CRAFTING: 12,
            FLETCHING: 17,

            // Support / utility skills
            RUNECRAFT: 5,
            HERBLORE: 8,
            THIEVING: 15,
            AGILITY: 10
        }
    },

    FIGHTER: {
        name: 'Fighter',
        weights: {
            // Combat — primary focus
            ATTACK: 30,
            STRENGTH: 30,
            DEFENCE: 20,
            RANGED: 12,
            MAGIC: 8,
            PRAYER: 8,

            // Gathering — low priority
            WOODCUTTING: 3,
            FISHING: 4,
            MINING: 4,

            // Production — low priority
            COOKING: 5,
            SMITHING: 5,
            FIREMAKING: 2,
            CRAFTING: 3,
            FLETCHING: 3,

            // Support / utility skills
            RUNECRAFT: 3,
            HERBLORE: 4,
            THIEVING: 3,
            AGILITY: 4
        }
    },

    BALANCED: {
        name: 'Balanced',
        weights: {
            // Combat
            // port (the realism work, phase 3: 2004's combat crowds, "more of the levelling bots' time fighting where it
            // suits their persona"): 13/13/10, was 10/10/8; a balanced bot fought 9-16 % of its time, a fighter 41-50 %
            ATTACK: 13,
            STRENGTH: 13,
            DEFENCE: 10,
            RANGED: 6,
            MAGIC: 6,
            PRAYER: 6,

            // Gathering
            WOODCUTTING: 10,
            FISHING: 10,
            MINING: 8,

            // Production
            COOKING: 8,
            SMITHING: 7,
            FIREMAKING: 7,
            CRAFTING: 7,
            FLETCHING: 9,

            // Support / utility
            RUNECRAFT: 6,
            HERBLORE: 6,
            THIEVING: 8,
            AGILITY: 8
        }
    }
};

// Skill name → PlayerStat
const SKILL_STAT: Record<string, PlayerStat> = {
    ATTACK: PlayerStat.ATTACK,
    STRENGTH: PlayerStat.STRENGTH,
    DEFENCE: PlayerStat.DEFENCE,
    HITPOINTS: PlayerStat.HITPOINTS,
    RANGED: PlayerStat.RANGED,
    PRAYER: PlayerStat.PRAYER,
    MAGIC: PlayerStat.MAGIC,
    COOKING: PlayerStat.COOKING,
    WOODCUTTING: PlayerStat.WOODCUTTING,
    FLETCHING: PlayerStat.FLETCHING,
    FISHING: PlayerStat.FISHING,
    FIREMAKING: PlayerStat.FIREMAKING,
    CRAFTING: PlayerStat.CRAFTING,
    SMITHING: PlayerStat.SMITHING,
    MINING: PlayerStat.MINING,
    THIEVING: PlayerStat.THIEVING,
    RUNECRAFT: PlayerStat.RUNECRAFT,
    HERBLORE: PlayerStat.HERBLORE,
    AGILITY: PlayerStat.AGILITY,
};

// Only skills with content implemented in BotKnowledge.ts
const SKILLS_WITH_CONTENT = new Set(
    Object.entries(SkillProgression)
        .filter(([, steps]) => steps.length > 0)
        .map(([name]) => name)
);

// Shops close enough to Lumbridge spawn that bots can reach without getting stuck.
// Bots will ONLY go to these shops automatically. Starter weapons/tools are given
// via InitTask so bots never need to walk to Varrock or Port Sarim just to begin.
// port: Gerrant's in Port Sarim too (the only fishing shop): without it a fisher had only the net it started with, and
// from Fishing 20 (fly rod, pot, harpoon) most of its steps were out of reach; it is a free walk from Lumbridge.
const NEARBY_SHOPS = new Set(['BOB_AXES', 'LUMBRIDGE_GENERAL', 'AL_KHARID_SCIMITARS', 'AL_KHARID_CRAFTING', 'VARROCK_ARCHERY', 'VARROCK_RUNES', 'VARROCK_STAFFS', 'GERRANTS_FISHING']);

/** port: Gold bars a bot must have before ring crafting claims priority over its weighted skills. */
const RING_PRIORITY_MIN_BARS = 5;
const COMBAT_SKILLS = new Set(['ATTACK', 'STRENGTH', 'DEFENCE']);
/** port (the realism work, phase 3): the levelling bots' planners (the roster's), the ones that take hang-outs */
const LEVELLING_PERSONALITIES = new Set(['Skiller', 'Fighter', 'Balanced', 'Random']);

// ── Planner ───────────────────────────────────────────────────────────────────

export class BotGoalPlanner {
    readonly personality: BotPersonality;
    private initialised = false;
    /** port: a newbie newcomer had its first wander round the courtyard (port/BotNewbie) */
    private newbieWandered = false;
    // Counts pickTask calls remaining before bankstand is eligible again.
    // Initialised with a random offset so bots don't all bankstand at once.
    private bankstandCooldown = Math.floor(Math.random() * 20) + 10;
    /** (the variety work, round 1, Track D: DO-7) the first pick of this login is still to come: it may carry on */
    private firstPick = true;
    /** (DO-7) the carry-on's picks left this login (-1: not rolled yet) */
    private carryOnLeft = -1;
    /** (DO-7) the bot has a save (skipInit): a login of a bot that played before, which may carry on */
    private saved = false;
    /** (Track D: DO-6) what the bot likes, from its name (port/BotFavourites), read at its first pick */
    private likes: { name: string; theme: Theme | null; favourites: string[]; home: { x: number; z: number }; style: CombatStyle } | null = null;
    /** (Track D: DO-6) this pick rolled its theme first (_pickBestTask), and the next pick takes the theme without a roll */
    private themeRolled = false;
    private themeAgain = false;
    /** (DO-6) this pick is the theme's again after its tool trip: no far-skip (the trip's pick passed it) */
    private themeForced = false;
    /** (Track D: DO-7) the skill (and the step) this pick prefers: what the bot was doing before it logged out */
    private prefer: { skill: string; step: SkillStep | null } | null = null;

    constructor(personality: BotPersonality = Personalities.BALANCED) {
        this.personality = personality;
    }

    /**
     * port: a bot with a save had its InitTask (coins, starter tools, bank seed) when it was new. Upstream ran it at
     * every spawn, so each launch (and now each return to the world) gave it another 200 coins and starter tools.
     */
    skipInit(): void {
        this.initialised = true;
        this.saved = true;
    }

    /** (the variety work, round 1, the fixes) did the bot have a save at this login (skipInit)? A PKer's class look asks (port/BotOutfits pkProfileAtLogin) */
    hasSave(): boolean {
        return this.saved;
    }

    pickTask(player: Player): BotTask | null {
        // (the variety work, round 1, Track D: the bot is not one of the occupants of the spots it weighs: port/BotSpots)
        setPicker(player);
        let task: BotTask | null;
        this.themeRolled = false;
        try {
            task = this._pickTaskInternal(player);
        } finally {
            setPicker(null);
        }
        // (Track D: DO-6) a theme pick that came to a tool trip: the theme again next time (THEME_TRIP_KINDS)
        if (this.themeRolled) this.themeAgain = task !== null && THEME_TRIP_KINDS.has(task.name.split(':')[0]);
        if (BotDebugService.enabled) {
            try {
                this._recordDecision(player, task);
            } catch {
                // debug hook must never affect gameplay
            }
        }
        return task;
    }

    private _pickTaskInternal(player: Player): BotTask | null {
        // ── 1. Init ───────────────────────────────────────────────────────────
        if (!this.initialised) {
            this.initialised = true;
            // port: a newbie newcomer comes with Tutorial Island's kit (port/BotNewbie)
            return isNewbie(player) ? new InitTask([], 'tutorial') : new InitTask(this._starterItems());
        }

        // ── 1b. A newbie's first minutes (port/BotNewbie) ─────────────────────
        if (isNewbie(player)) return this._newbieTask(player);

        // ── 1k. (the variety work, round 2, the fixes) an outing, a minigame or an errand under way kept, before the visits
        // below: the members hook kept its own only after the hang-outs, the alch stints and the set pieces (the arena's hook
        // first), and D2's after the claims, so a due Duel Arena visit (from 900 tiles), a hang-out or an alch stint took a
        // bot off its outing at a plan's end ──
        {
            const kept = keptHookTask(player);
            if (kept) return kept;
            // (an errand through the danger check, as D2's own pick was)
            const errand = keptErrand(player);
            if (errand) return this._dangerChecked(player, errand);
        }

        // ── 1c. A hang-out now and then (port/BotHangout; the realism work's 2004 hotspots) ──
        // (between plans: Falador park, Varrock square or a bank near it, every 1-2 hours of play; a levelling bot's planner)
        if (LEVELLING_PERSONALITIES.has(this.personality.name)) {
            const previous = ((player as unknown as { _bot?: { currentTask?: BotTask | null } })._bot?.currentTask?.name ?? null);
            const hangout = hangoutFor(player, previous);
            if (hangout) return hangout;
            // ── 1f. High alchemy at a trade bank now and then (port/BotAlch; the realism work's phase 5a) ──
            const alch = alchTaskFor(player, previous);
            if (alch) return alch;
            // ── 1g. A set piece's own visit (port/BotSetPieces: the Duel Arena's; the realism work's phase 5b) ──
            const piece = setPieceTaskFor(player, previous);
            if (piece) return piece;
            // ── 1d. A wardrobe trip now and then (port/BotGear; the realism work's patchwork gear, phase 4) ──
            // (its hat, apron, cape, boots or gloves from a shop near it, once in 1-2 hours of play at most; since the variety
            // work, round 1, track W, any levelling bot's outfit pieces; the integrator's: after the visits with a cadence of
            // their own, as the carry-on below, since a trip before them took Duel Arena asks: A1, A2)
            const outfit = wardrobeTrip(player, player.botPlanner as PlannerKey);
            if (outfit) {
                const trip = new ShopTripTask(outfit.shopKey, outfit.itemId, 1, outfit.cost);
                if (trip.shouldRun(player)) return trip;
            }
        }

        // ── 1h. (the variety work, round 1, Track D: DO-7, relog continuity) the first pick after a login carries on,
        // CARRY_ON_CHANCE of the time, with what the bot was doing: the gatherer's load in its pack, else the step nearest
        // where it logged in (it logs in where it logged out: no save change). Before: 13-24 % started what they left ──
        // (rolled once a login; tried for its first CARRY_ON_PICKS picks until one is a doing: a bank trip for the full pack
        // it logged out with, or a shop trip for a tool, comes first; after the hang-outs and visits above, which keep their
        // own cadence: a carry-on before them took the Duel Arena's asks, A1)
        if (this.firstPick && this.saved && LEVELLING_PERSONALITIES.has(this.personality.name)) {
            if (this.carryOnLeft < 0) this.carryOnLeft = Math.random() < CARRY_ON_CHANCE ? CARRY_ON_PICKS : 0;
            if (this.carryOnLeft > 0) {
                this.carryOnLeft--;
                const carried = this._carryOn(player);
                if (carried) {
                    if (DOING_KINDS.has(carried.name.split(':')[0]) || this.carryOnLeft === 0) this.firstPick = false;
                    return carried;
                }
            }
            this.firstPick = false;
        }

        // ── 2. Passive prayer ─────────────────────────────────────────────────
        if ((this.personality.weights['PRAYER'] ?? 0) > 0) {
            if (hasItem(player, Items.BONES) || hasItem(player, Items.BIG_BONES)) {
                return new BuryBonesTask();
            }
        }

        // ── 3 + 4. Pick skill, handle affordability ───────────────────────────
        // ── 1e. The danger check (the realism work's phase 5a, Track F): the next task's spot against the bot's Hitpoints ──
        return this._dangerChecked(player, this._pickBestTask(player));
    }

    /**
     * port (the realism work, phase 5a, Track F: the danger check, step 1e): the next task's spot is where monsters hunt
     * the bot (port/BotDanger) and it is under DANGER_BELOW of its Hitpoints (REST_TO while it heals: BotDefence
     * isHealing): a careful bot gets them back first (tasks/RestTask: it eats, or fetches food from a bank where nothing
     * hunts it); with no food anywhere it does something where nothing hunts it meanwhile (another task: three tries, else
     * a minute idle); a careless one (carelessness × 0.5) goes anyway. After a second death within 30 minutes
     * (port/BotFumble isShaken) none of those spots for a while, hurt or not. Fights keep their own rules (fitToFight,
     * their eating) unless shaken.
     */
    private _dangerChecked(player: Player, task: BotTask | null): BotTask | null {
        if (!task) return task;
        // (the White Wolf Mountain reach rule for every pick: the logs' priority and the others pick their step without
        // it, and a level-3 firemaker walked from Al Kharid to Seers over the mountain)
        if (!this._taskReachable(player, task)) return this._otherTask(player, t => this._taskReachable(player, t));
        if (isShaken(player) && this._hunted(player, task)) return this._otherTask(player, t => !this._hunted(player, t));
        const kind = task.name.split(':')[0];
        // (the variety work, round 1, the integrator's: track F's bank guard) a kind the guard ended as futile within the
        // last 30 minutes (two bank arrivals with the same pack and no XP: a ranger that cannot put its picked gear in hand)
        // is not picked again at once
        if (endedFutileLately(player, kind)) return this._otherTask(player, t => !endedFutileLately(player, t.name.split(':')[0]));
        if (kind === 'Combat' || kind === 'RangedMagic') return task;
        if ((!hpBelow(player, DANGER_BELOW) && !isHealing(player)) || !this._hunted(player, task)) return task;
        if (carelessRoll(player, 0.5)) {
            dangerStats.goOn++;
            return task;
        }
        if (carriedFood(player) > 0) dangerStats.eat++;
        else if (bankedFood(player) > 0) dangerStats.fetch++;
        else dangerStats.leave++;
        return carriedFood(player) + bankedFood(player) > 0 ? new RestTask() : this._otherTask(player, t => !this._hunted(player, t));
    }

    /** port (phase 5a): another task that passes `ok` (three tries, each reachable), else a minute idle and a new pick */
    private _otherTask(player: Player, ok: (task: BotTask) => boolean): BotTask {
        for (let i = 0; i < 3; i++) {
            const other = this._pickBestTask(player);
            if (other && ok(other) && this._taskReachable(player, other)) return other;
        }
        return new IdleTask(100);
    }

    /** port (phase 5a): the task's spot is within the bot's reach (_reachable; a task without a spot: yes) */
    private _taskReachable(player: Player, task: BotTask): boolean {
        const step = this._stepOf(task);
        return !step || this._reachable(player, step);
    }

    /** port (phase 5a): the task's step (its spot), or null */
    private _stepOf(task: BotTask): SkillStep | null {
        try {
            return task.activityStep();
        } catch {
            return null;
        }
    }

    /** port (phase 5a): is the task's spot one where monsters hunt the bot? (a task without a spot: no) */
    private _hunted(player: Player, task: BotTask): boolean {
        const step = this._stepOf(task);
        if (!step) return false;
        const [x, z, level] = step.location;
        return huntedAt(player, x, z, level);
    }

    /**
     * port (the realism work, phase 5a, Track F: the White Wolf Mountain reach rule): a spot whose walk crosses
     * monsters that hunt the bot in a multi-combat area (Taverley to Catherby over the mountain: its wolves pile on) is
     * out of reach for a careful bot under combat WWM_MIN_COMBAT, and for one with no food anywhere, as an unaffordable
     * step is; a careless bot (its "go anyway", carelessness × 0.5, held for a plan) goes. The rest go, and pack food
     * for it or cast a spell (Track M: packTravelFood, port/BotTeleport).
     */
    private _reachable(player: Player, step: SkillStep): boolean {
        const [x, z, level] = step.location;
        if (level !== 0 || player.level !== 0 || !isMembersWorld()) return true;
        // (only a walk over the mountain's longitude can cross it: the one land way between Asgarnia and Kandarin; the
        // route itself, a search, only then, and cached)
        if ((player.x < WWM_X) === (x < WWM_X) || z > 3700 || player.z > 3700 || !crossesHunters(player, x, z)) return true;
        if (boldFor(player)) return true;
        return player.combatLevel >= WWM_MIN_COMBAT && carriedFood(player) + bankedFood(player) > 0;
    }

    /**
     * Debug-only: reconstructs a human-readable summary of this decision for
     * the dashboard's Planner tab. Deliberately re-derives shouldRun/reason
     * from the same public helpers _pickBestTask uses, rather than threading
     * reasoning state through every branch above — keeps the actual decision
     * logic completely untouched.
     */
    private _recordDecision(player: Player, chosen: BotTask | null): void {
        const botName = (player as any)._bot?.name;
        if (!botName) return;

        const candidates: BotPlannerCandidate[] = [];
        for (const [skill, weight] of Object.entries(this.personality.weights)) {
            if (!weight || weight <= 0 || !SKILLS_WITH_CONTENT.has(skill)) continue;
            const stat = SKILL_STAT[skill];
            if (stat === undefined) continue;
            const level = getBaseLevel(player, stat);
            if (level >= 99) {
                candidates.push({ name: skill, weight, shouldRun: false, reason: 'already 99' });
                continue;
            }
            const step = getProgressionStep(skill, level);
            if (!step) {
                candidates.push({ name: skill, weight, shouldRun: false, reason: 'no progression step for level' });
                continue;
            }
            const missing = getMissingPurchases(player, step);
            if (missing.length > 0) {
                const afford = canAffordStep(player, step);
                candidates.push({ name: skill, weight, shouldRun: false, reason: afford ? `needs shop trip: ${missing[0].shopKey}` : 'cannot afford required tools' });
            } else {
                candidates.push({ name: skill, weight, shouldRun: true });
            }
        }

        const reason = chosen ? `selected ${chosen.name}` : 'no runnable task found — idling';
        BotDebugService.recordPlannerDecision(botName, chosen?.name ?? null, reason, candidates);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private _pickBestTask(player: Player): BotTask | null {
        // ── Full inventory: bank gathered resources before anything else ──────
        // When the inventory is full, ShopTripTask.shouldRun will refuse to run
        // (no slot for the purchased item) and gathering tasks can't proceed
        // either. The only way out is to bank first.
        //
        // We keep coins and every tool ID appearing in any progression step so
        // the bot doesn't accidentally bank its axe/pickaxe/weapon alongside the
        // logs/ores/fish that actually caused the overflow.
        if (isInventoryFull(player)) {
            const keepIds = new Set<number>([Items.COINS]);
            for (const steps of Object.values(SkillProgression)) {
                for (const step of steps) {
                    for (const id of step.toolItemIds) keepIds.add(id);
                }
            }
            return new BankTask([...keepIds]);
        }

        // ── BANKSTAND: periodic sell session at Varrock West Bank ────────────
        // Triggered every ~20-40 planner calls (roughly once every 30-60 min at
        // the default 150-tick rescan interval). Skipped when inventory is full
        // so the bot banks first.
        // (port: the rescan is 600 ticks; the planner is also asked whenever a task ends or cannot run)
        if (this.bankstandCooldown <= 0) {
            this.bankstandCooldown = Math.floor(Math.random() * 20) + 20;
            return new BankstandTask();
        }
        this.bankstandCooldown--;

        // ── COOKING priority: cook whenever any fish are available ───────────
        // Without this, FISHING (weight 25) almost always beats COOKING (weight 15)
        // in the weighted shuffle, so bots accumulate fish forever and never cook.
        // If the bot has ≥ 5 fish (bank or inventory) and cooking is in their
        // personality, cook immediately regardless of the weighted skill order.
        // (the variety work, round 1, Track D: DO-6) a bot named for an activity rolls for it first, THEME_FIRST of the
        // time (and without a roll after a tool trip for it), before the claims below: then only its own skill's claim
        // (a smith's bars, a cook's fish, a firemaker's or a fletcher's logs) may take the pick; the claims came first and
        // took 2 in 5 themed miners and woodcutters to fletching (a 30-minute 500-bot world: one plan a bot)
        const theme = this._likes(player).theme;
        this.themeForced = theme !== null && !this.prefer && this.themeAgain;
        const themeRoll = theme !== null && !this.prefer && (this.themeAgain || Math.random() < THEME_FIRST);
        if (themeRoll) this.themeRolled = true;
        const claims = (...skills: string[]): boolean => !themeRoll || skills.includes(theme!.skills[0]);

        // (the variety work, round 1, Track D: DO-5) each claim takes the pick by how much the bot likes the skill (its
        // weight in the 2004 mix against its top one: _claimChance): a fighter with a stack of ore from its age, or meat
        // from its kills, smelted and cooked first at every pick (combat was 11 % of the planners' picks, 20 % of time)
        if ((this.personality.weights['COOKING'] ?? 0) > 0 && claims('COOKING') && Math.random() < this._claimChance(player, 'COOKING')) {
            const cookTask = this._findCookingTask(player);
            if (cookTask) return cookTask;
        }

        // ── SMITHING priority: smith whenever any ores/bars are available ────
        // Similar priority to cooking — smith whenever materials are available.
        // This ensures smelting takes priority over other skills when bot has ores/bars.
        if ((this.personality.weights['SMITHING'] ?? 0) > 0 && claims('SMITHING') && Math.random() < this._claimChance(player, 'SMITHING')) {
            const smithTask = this._findSmithingTask(player);
            if (smithTask) return smithTask;
            console.log(`[Planner] ${player.username} SMITHING skipped: no smithTask (ores/bars?)`);
        }

        // ── LOGS priority: 50/50 split between Firemaking and Fletching ──────
        // When the bot has ≥ 10 logs matching either skill's current step,
        // a coin flip decides which task runs instead of relying on weights alone.
        // Falls through to null (and on to the weighted loop) when no logs available.
        // (the variety work, round 1, Track D: DO-5) at most 8 times in 10 (LOGS_CLAIM_CHANCE), by how much the bot likes
        // the skills (_claimChance), not always: the claim made firemaking 23 % of a free world's picks and fletching
        // 16-20 % of members' levelling time
        if (((this.personality.weights['FIREMAKING'] ?? 0) > 0 || (this.personality.weights['FLETCHING'] ?? 0) > 0) && claims('FIREMAKING', 'FLETCHING') && Math.random() < LOGS_CLAIM_CHANCE * Math.max(this._claimChance(player, 'FIREMAKING'), this._claimChance(player, 'FLETCHING'))) {
            const logsTask = this._findLogsTask(player);
            if (logsTask) return logsTask;
        }

        // ── STRINGING priority: string bows whenever both materials are banked ──
        // Unstrung bows come from FletchingTask's log cutting, bow strings from
        // CraftingTask's spin_flax — both are gathering loops with no reason to
        // stop on their own, so stringing needs to actively claim priority
        // whenever it has something to consume, same reasoning as cooking/smithing.
        if ((this.personality.weights['FLETCHING'] ?? 0) > 0 && claims('FLETCHING')) {
            const stringTask = this._findStringingTask(player);
            if (stringTask) return stringTask;
        }

        // ── CRAFTING priority (Phase 2 only) ─────────────────────────────────
        // Only runs when Mining >= 40 AND Smithing >= 40 — i.e. the gold pipeline
        // is active and the bot should prioritise ringing gold bars into rings.
        // Phase 1 (wool spinning) goes through the normal weighted rotation below
        // so it doesn't starve every other skill.
        // port: and only with gold bars to ring, like the cooking and smithing priorities (they claim the bot only
        // while it has something to consume). Upstream handed every call to _findCraftingTask, whose first answer
        // is flax: with Mining and Smithing at 40 a members-world bot picked and spun flax and nothing else (16 of
        // 16 bots for 5,000 ticks in a sim), and a free-world one bought ring moulds, banked them and bought more.
        if ((this.personality.weights['CRAFTING'] ?? 0) > 0 && claims('CRAFTING')) {
            const mineLevel = getBaseLevel(player, PlayerStat.MINING);
            const smithLevel = getBaseLevel(player, PlayerStat.SMITHING);
            if (mineLevel >= 40 && smithLevel >= 40) {
                const ringTask = this._findRingTask(player, RING_PRIORITY_MIN_BARS);
                if (ringTask) return ringTask;
            }
        }

        // ---- (the variety work, round 2, Track D2: new activities) the economy chains, the quest look-alikes, the prayer
        // and magic runs, herblore, the Wilderness trips: each its share of the picks of the bots it suits, an errand under
        // way kept (port/BotD2Picks); not over a theme's roll or a carry-on, nor at a relog's first pick; (round 2, the fixes)
        // a levelling personality's planner only, as the hang-outs, the alch stints and the set pieces: a planner of the
        // tests' own weights (the coverage's cases) trains what they ask (a hides chain took a cape buyer's whole run) ----
        if (!themeRoll && !this.prefer && LEVELLING_PERSONALITIES.has(this.personality.name)) {
            const d2 = d2Pick(player, this.personality.name, this.saved);
            if (d2) return d2;
        }
        // ---- end of Track D2's block ----

        // Build candidate list ordered by weight (highest first after shuffle)
        const candidates = this._buildCandidates(player);
        if (candidates.length === 0) return new IdleTask(30);
        // port (the realism work, phase 3): a friend online (port/BotCliques) trains a skill this bot trains too: most
        // times that skill first, and cliqueStepFor (in _combatStep, _skillStep) gives the friend's spot:
        // "bot friend cliques" train together
        const friendSkills = cliqueSkillsFor(player);
        let friendFirst = false;
        if (friendSkills.length > 0 && Math.random() < FRIEND_SKILL_CHANCE) {
            const i = candidates.findIndex(skill => friendSkills.includes(skill));
            if (i > 0) candidates.unshift(...candidates.splice(i, 1));
            friendFirst = i >= 0;
        }
        // (the variety work, round 1, Track D: DO-6) a bot named for an activity does it first on its roll above
        // (yew_cutter cuts, fish_fanatic fishes: before, 20-23 of 26-30 such bots never did their name's); a carry-on's
        // skill (DO-7) first always
        if (this.prefer) {
            const i = candidates.indexOf(this.prefer.skill);
            if (i > 0) candidates.unshift(...candidates.splice(i, 1));
        } else if (theme && themeRoll && !friendFirst) {
            const i = candidates.indexOf(theme.skills[0]);
            if (i > 0) candidates.unshift(...candidates.splice(i, 1));
            // (a smith with no ore, a cook with no fish: its own supply next, as the 2004 player mined its ore)
            const feeder = THEME_FEEDER[theme.skills[0]];
            const j = feeder ? candidates.indexOf(feeder) : -1;
            if (i >= 0 && j > 1) candidates.splice(1, 0, ...candidates.splice(j, 1));
        }

        for (const skillName of candidates) {
            const stat = SKILL_STAT[skillName];
            const level = getBaseLevel(player, stat);

            // ── COOKING: scan all matching steps for one whose fish is in bank ─
            // getProgressionStep picks randomly, but multiple steps share the same
            // level (e.g. RAW_SHRIMP step and RAW_SARDINE step both start at lv 1).
            // We must find the step whose consumed item the bot actually has ≥ 28 of,
            // rather than hoping the random pick matches.
            if (skillName === 'COOKING') {
                const cookTask2 = this._findCookingTask(player);
                if (cookTask2) return cookTask2;
                continue; // no matching fish found — try next skill
            }

            if (skillName === 'CRAFTING') {
                const craftTask2 = this._findCraftingTask(player);
                // (the variety work, round 1, Track D: AM8) a far one (Seers' flax from Varrock) passed over most times
                if (craftTask2 && this._farTask(player, skillName, craftTask2)) continue;
                // (WHERE-2) a full spinning wheel or furnace (port/BotSpots spotRoom: one wheel, no neighbour of its tier
                // in a free world) passed over mostly: 16 bots spun at Lumbridge castle's at once in a 500-bot world
                if (craftTask2 && this._fullSpot(craftTask2)) continue;
                if (craftTask2) return craftTask2;
                continue; // no viable crafting step right now — try next skill
            }

            // ── RANGED / MAGIC: both use RangedMagicTask ─────────────────────
            // The task handles its own equipment purchasing logic (bow + arrows for
            // ranged, staff + mind runes for magic). It only initiates when the bot
            // has the required gear OR has ≥ 5 000 coins to buy it.
            if (skillName === 'RANGED' || skillName === 'MAGIC') {
                const rmTask = this._findRangedMagicTask(player, stat);
                // (the variety work, round 1, Track D: AM8) a far spot passed over most times
                if (rmTask && this._farTask(player, skillName, rmTask)) continue;
                if (rmTask) return rmTask;
                continue;
            }

            // ── RUNECRAFT: unlocked by owning any talisman (combat drop) ─────
            // RunecraftingTask manages its own progression and altar selection.
            // shouldRun() returns false until a talisman is in bank/inventory,
            // so this candidate is silently skipped until that condition is met.
            if (skillName === 'RUNECRAFT') {
                const rcTask = this._findRunecraftingTask(player);
                // (Track D: AM8) an essence run from far off (Aubury's from Falador) passed over most times
                if (rcTask && this._farTask(player, skillName, rcTask)) continue;
                if (rcTask) return rcTask;
                continue;
            }

            // port: a combat step the bot has the weapon for (worn, carried or banked: combatWeaponFor), mostly one
            // that suits its level; and no fighting at low health without food
            const combat = COMBAT_SKILLS.has(skillName);
            const step = combat ? this._combatStep(player, skillName, level) : this._skillStep(player, skillName, level);
            if (!step) continue;
            // (the variety work, round 1, Track D: AM8) a spot far away is passed over most times (the next candidate is
            // nearer), unless it is a favourite: a long trip now and then, as players made one
            if (this._farSkip(player, skillName, step)) continue;
            // (against the step's monsters: weak ones need no food; hurt and none: kebabs first, if it can buy them)
            if (combat && !fitToFight(player, step)) {
                const food = this._foodTrip(player);
                if (food) return food;
                continue;
            }
            if (step.action === 'combat' && combatWeaponFor(player, step) !== null) {
                return this._combatOrUpgrade(player, step, stat);
            }
            // port: a gathering step whose tools are in the bank (a combat trip banks every other skill's tools):
            // the task fetches them. Upstream bought new ones (a bronze pickaxe over the rune one in the bank), or
            // with no shop for them never did the skill again.
            if (step.action === 'woodcut' || step.action === 'mine' || step.action === 'fish') {
                const carried = step.action === 'fish' ? step.toolItemIds.every(id => hasItem(player, id)) : step.toolItemIds.some(id => hasItem(player, id) && canUseTool(player, id));
                if (!carried) {
                    const task = step.action === 'woodcut' ? new WoodcuttingTask(step) : step.action === 'mine' ? new MiningTask(step) : new FishingTask(step);
                    if (task.shouldRun(player)) return task;
                }
            }

            const missing = getMissingPurchases(player, step);

            if (missing.length === 0) {
                // Double-check: getMissingPurchases omits unaffordable items (returns empty list
                // even if tools are missing), so we must verify the bot actually owns every tool.
                // Woodcutting/mining list all valid tiers — any one suffices.
                // Fletching knife is special: it can live in the bank (task withdraws it on
                // the bank_walk → withdraw_logs transition), so we accept bank ownership too.
                let toolOk: boolean;
                if (step.action.startsWith('fletch_')) {
                    toolOk = this._hasKnifeAccessible(player);
                    console.log(`[Planner:${player.username}] FLETCHING weighted-loop step=${step.action} knifeOk=${toolOk}`);
                    if (!toolOk) {
                        console.log(`[Planner:${player.username}] FLETCH→PickupSpawn (knife gone)`);
                        return new PickupSpawnTask(Items.KNIFE, KNIFE_SPAWNS);
                    }
                } else if (skillName === 'FLETCHING' && step.action.startsWith('string_')) {
                    // Stringing is handled by the dedicated STRINGING priority
                    // check above (_findStringingTask), which scans every
                    // string_ step for one with materials available rather than
                    // relying on whichever random step getProgressionStep handed
                    // to this loop. Nothing to do with that random pick here.
                    continue;
                } else {
                    // port: owned anywhere (carried, worn or banked: each task fetches its banked tools), one of a
                    // group of alternatives (BotNeeds.toolGroups); upstream wanted every tool in the pack
                    toolOk = hasAllTools(player, step);
                    if (!toolOk) continue;
                }

                // Check consumable availability (bait, feathers, raw fish for cooking, logs for FM)
                // If the step consumes an item that isn't purchasable (e.g. raw fish, logs),
                // the bot must first produce it via a different skill step.
                if (step.itemConsumed && step.itemConsumed !== -1) {
                    const hasInv = hasItem(player, step.itemConsumed, 1);

                    // Check bank for consumable (count for cooking minimum-batch check)
                    const bid = bankInvId();
                    let bankConsumeCount = 0;

                    if (bid !== -1) {
                        const bank = player.getInventory(bid);
                        if (bank) {
                            for (let i = 0; i < bank.capacity; i++) {
                                const item = bank.get(i);
                                if (!item) continue;
                                if (item.id === step.itemConsumed) bankConsumeCount += item.count;
                            }
                        }
                    }

                    const hasBank = bankConsumeCount > 0;
                    if (!hasInv && !hasBank) {
                        if (skillName === 'FIREMAKING') {
                            const wcLevel = getBaseLevel(player, PlayerStat.WOODCUTTING);
                            const wcStep = getWoodcuttingStepForLog(step.itemConsumed!, wcLevel, [player.x, player.z]);
                            console.log(`[Planner:${player.username}] FIREMAKING no logs(id=${step.itemConsumed}) → wcStep=${wcStep ? wcStep.action : 'null'}`);
                            if (wcStep) {
                                return new WoodcuttingTask(wcStep);
                            }
                        } else if (skillName === 'FLETCHING') {
                            // FletchingTask handles its own log acquisition via embedded woodcutting
                            console.log(`[Planner:${player.username}] FLETCHING no logs → FletchingTask (self-contained WC)`);
                            return new FletchingTask(step);
                        }

                        continue;
                    }

                    const alsoConsumes = step.extra?.alsoConsumes as number | undefined;
                    if (alsoConsumes && !hasItem(player, alsoConsumes, 1)) {
                        continue;
                    }
                }
                // Has everything — go do the skill
                // port: a task only if it can run now (upstream handed out tasks that refused to: a fisher under combat
                // 16 at Draynor, which then asked again, every tick: 15 of 19 new fishing tasks in a sim)
                const ready = (task: BotTask): BotTask | null => (task.shouldRun(player) ? task : null);
                let task: BotTask | null = null;
                if (step.action === 'combat') task = ready(new CombatTask(step, stat));
                else if (step.action === 'woodcut') task = ready(new WoodcuttingTask(step));
                else if (step.action === 'mine') task = ready(new MiningTask(step));
                else if (step.action === 'fish') task = ready(new FishingTask(step));
                else if (step.action === 'firemaking') task = ready(new FiremakingTask(step));
                else if (step.action === 'smelt' || step.action === 'smith') task = ready(new SmithingTask(step));
                else if (step.action === 'agility') task = ready(new AgilityTask(step));
                // port: and stalls (upstream built no task for a 'thieve_stall' step, so half of all thieving picks
                // from level 5 came to nothing; _skillStep keeps bots under combat 20 off the guarded stalls)
                else if (step.action === 'thieve' || step.action === 'thieve_stall') task = ready(new ThievingTask(step));
                if (task) return task;
                if (['combat', 'woodcut', 'mine', 'fish', 'firemaking', 'smelt', 'smith', 'agility', 'thieve', 'thieve_stall'].includes(step.action)) continue;
                if (step.action === 'herblore_attack') {
                    // Require guams (chaos druid drops) — no guams, no herblore.
                    const herblBid = bankInvId();
                    let guamCount = countItem(player, step.itemConsumed!);
                    if (herblBid !== -1) {
                        const bankInv = player.getInventory(herblBid);
                        if (bankInv) {
                            for (let i = 0; i < bankInv.capacity; i++) {
                                const it = bankInv.get(i);
                                if (it && it.id === step.itemConsumed) guamCount += it.count;
                            }
                        }
                    }
                    if (guamCount < 5) continue; // not enough guams yet
                    return new HerbloreTask(step);
                }
                if (step.action.startsWith('fletch_')) {
                    if (step.itemConsumed) {
                        let totalLogs = countItem(player, step.itemConsumed);
                        const fletchBid = bankInvId();
                        if (fletchBid !== -1) {
                            const bankInv = player.getInventory(fletchBid);
                            if (bankInv) {
                                for (let i = 0; i < bankInv.capacity; i++) {
                                    const it = bankInv.get(i);
                                    if (it?.id === step.itemConsumed) totalLogs += it.count;
                                }
                            }
                        }
                        console.log(`[Planner:${player.username}] FLETCH weighted-loop logs=${totalLogs} (id=${step.itemConsumed}) step=${step.action}`);
                        if (totalLogs < 10) { console.log(`[Planner:${player.username}] FLETCH skip: only ${totalLogs} logs`); continue; }
                    }
                    console.log(`[Planner:${player.username}] FLETCH→FletchingTask (weighted-loop) step=${step.action}`);
                    return new FletchingTask(step);
                }
                continue;
            }

            if (canAffordStep(player, step)) {
                // Only go to nearby shops — distant shops cause bots to get stuck.
                // Starter gear is provided by InitTask so basics are always available.
                const first = missing[0];
                if (NEARBY_SHOPS.has(first.shopKey)) {
                    return new ShopTripTask(first.shopKey, first.itemId, first.quantity, first.cost);
                }
                // Distant shop needed — skip this skill for now
            }

            // Can't afford this skill's tools — try the next candidate
            // (lower-weight skills may be cheaper or tool-free)
        }

        // All skills need tools the bot can't afford.
        // Fall back to combat to earn coins — chickens/goblins need only a sword (32gp)
        // If even that's too expensive, idle briefly and hope for drops
        const combatFallback = this._cheapestCombatTask(player);
        return combatFallback ?? new IdleTask(30);
    }

    /**
     * If the bot has any cookable fish (in bank OR carried inventory) for their
     * current cooking level, return a CookingTask for that fish.  Otherwise null.
     *
     * We count both locations because bots often switch tasks before filling their
     * inventory, so fish may never reach the bank.  CookingTask always does a
     * bank_walk first, depositing the carried fish before withdrawing a full load.
     *
     * Threshold is 1 — matching CookingTask.MIN_FISH — so cooking starts as soon
     * as the bot has caught anything.
     */
    private _findCookingTask(player: Player): CookingTask | null {
        const bid = bankInvId();
        const bank = bid !== -1 ? player.getInventory(bid) : null;
        const level = getBaseLevel(player, PlayerStat.COOKING);
        const steps = SkillProgression['COOKING'].filter(s => level >= s.minLevel && level <= s.maxLevel);

        // Collect ALL viable steps (correct fish type + enough quantity).
        // Then pick randomly so bots spread across all cooking locations
        // instead of every bot always choosing the first (Al Kharid) entry.
        const candidates: typeof steps = [];
        for (const cs of steps) {
            const fishId = cs.itemConsumed;
            if (!fishId) continue;

            // Count fish in bank
            let count = 0;
            if (bank) {
                for (let i = 0; i < bank.capacity; i++) {
                    const it = bank.get(i);
                    if (it?.id === fishId) count += it.count;
                }
            }
            // Also count fish currently in carried inventory (not yet banked)
            count += countItem(player, fishId);

            // port: half a load at least (upstream went off to cook 5 fish: half of its cooking time was bank walks)
            if (count >= 14) candidates.push(cs);
        }

        if (candidates.length === 0) return null;
        // port: the range nearest the bot (upstream drew one of Al Kharid, Varrock and Falador at random, wherever the
        // bot was); bots spread by where they fish
        // (the variety work, round 1, Track D: DO-16) by the loop it walks for every load: CookingTask banks at the bank
        // nearest its range, so a range is its walk to that bank once and the bank-range loop each load (3 loads' worth),
        // a toll gate on the loop as COOK_TOLL_TILES more (a bot banked in Al Kharid and cooked at Lumbridge castle's
        // range through the gate: 106 + 146 ticks of walking a load)
        const cost = (cs: SkillStep): number => {
            const [rx, rz, rl] = cs.location;
            const [bx, bz, bl] = nearestBankTo(rx, rz);
            const loop = Math.max(Math.abs(bx - rx), Math.abs(bz - rz)) + (crossingFare(bx, bz, bl, rx, rz, rl) > 0 ? COOK_TOLL_TILES : 0);
            return Math.max(Math.abs(player.x - bx), Math.abs(player.z - bz)) + 3 * loop;
        };
        return new CookingTask(candidates.reduce((a, b) => (cost(b) < cost(a) ? b : a)));
    }

    /**
     * If the bot has any ores (in bank OR carried inventory) OR bars for their
     * current smithing level, return a SmithingTask.  Otherwise null.
     *
     * Anvil mode (smith action) requires level >= 18 and bars in inventory.
     * Furnace mode (smelt action) requires ores in inventory.
     */
    private _findSmithingTask(player: Player): SmithingTask | null {
        const bid = bankInvId();
        const bank = bid !== -1 ? player.getInventory(bid) : null;
        const level = getBaseLevel(player, PlayerStat.SMITHING);
        const steps = SkillProgression['SMITHING'].filter(s => level >= s.minLevel && level <= s.maxLevel);

        const candidates: typeof steps = [];
        for (const ss of steps) {
            const consumedId = ss.itemConsumed;
            if (!consumedId) continue;

            // Count item in bank
            let count = 0;
            if (bank) {
                for (let i = 0; i < bank.capacity; i++) {
                    const it = bank.get(i);
                    if (it?.id === consumedId) count += it.count;
                }
            }
            // Also count in carried inventory
            count += countItem(player, consumedId);

            // For bronze bars, also need tin ore (steel: two coal a bar)
            if (ss.extra?.alsoConsumes) {
                const alsoConsumesId = ss.extra.alsoConsumes as number;
                let tinCount = 0;
                if (bank) {
                    for (let i = 0; i < bank.capacity; i++) {
                        const it = bank.get(i);
                        if (it?.id === alsoConsumesId) tinCount += it.count;
                    }
                }
                tinCount += countItem(player, alsoConsumesId);
                // port: the bars it can make (any tin at all sent it off for a bar or two)
                count = Math.min(count, Math.floor(tinCount / ((ss.extra.alsoConsumesCount as number | undefined) ?? 1)));
            }

            if (count >= 14) candidates.push(ss); // port: half a load, as cooking (5 sent it across the map for a few bars)
        }

        // port: only a task that can run (an anvil step needs a hammer, pack or bank): a priority that hands the bot
        // a task it cannot start is asked again the next tick, and the next
        const runnable = candidates.map(c => new SmithingTask(c)).filter(t => t.shouldRun(player));
        if (runnable.length === 0) return null;
        // port: at the furnace or anvil nearest the bot (one at random sent Rimmington's miners to Al Kharid), the
        // highest step it can do there (steel before iron: the nearest alone always smelted iron, never steel)
        const stepOf = (t: SmithingTask): SkillStep => (t as unknown as { step: SkillStep }).step;
        const dist = (t: SmithingTask): number => { const l = stepOf(t).location; return Math.max(Math.abs(player.x - l[0]), Math.abs(player.z - l[1])); };
        const nearest = Math.min(...runnable.map(dist));
        return runnable.filter(t => dist(t) <= nearest + 5).reduce((a, b) => (stepOf(b).minLevel > stepOf(a).minLevel ? b : a));
    }

    /**
     * Returns the appropriate CraftingTask (or a supporting task) for the
     * player's current state.  Priority order:
     *
     *   1. Flax: consumer (spin_flax) beats producer (pick_flax) — only gather
     *      more flax when the bank+inventory supply is running low, so a bot
     *      that already has flax banked spins it into bow strings instead of
     *      picking forever. See FLAX_SPIN_MIN below.
     *   2. Leather crafting / gem cutting: independent of the gold pipeline —
     *      hides come from combat, gems from thieving/drops — so these run
     *      whenever the crafting level and materials line up, regardless of
     *      Mining/Smithing.
     *   3. Phase 2 (craft_ring): once Mining >= 40 AND Smithing >= 40.
     *      Requires ring_mould in inventory and gold bars in bank/inv.
     *   4. Phase 1 (craft_wool): universal fallback — no materials besides
     *      shears required, so this always has something to do.
     *
     * Returns null when nothing above can run right now.
     */
    private _findCraftingTask(player: Player): BotTask | null {
        const mineLevel = getBaseLevel(player, PlayerStat.MINING);
        const smithLevel = getBaseLevel(player, PlayerStat.SMITHING);
        const phase2Unlocked = mineLevel >= 40 && smithLevel >= 40;

        const steps = SkillProgression['CRAFTING'];
        if (!steps || steps.length === 0) return null;

        const craftLevel = getBaseLevel(player, PlayerStat.CRAFTING);

        // ── Flax: spin (consumer) takes priority over picking (producer) ──────
        // pick_flax has no in-game level requirement, but spinning needs 10, so
        // there's no point gathering before that. Once spinnable, only send the
        // bot back to the field when supply is low — otherwise keep spinning
        // down what's already banked. This is what makes FlaxPickingTask
        // terminate each cycle (see its bankedOnce flag) rather than run forever.
        // port: what the bot owns is crafted first (flax to spin, leather or hides, uncut gems, gold bars); picking flax
        // only after those (upstream picked flax first: a members bot's gems and leather were never crafted)
        const spinStep = steps.find(s => s.action === 'spin_flax' && craftLevel >= s.minLevel && craftLevel <= s.maxLevel);
        if (spinStep) {
            const flaxSupply = countItem(player, Items.FLAX) + this._bankCount(player, Items.FLAX);
            if (flaxSupply >= FLAX_SPIN_MIN) {
                return new CraftingTask(spinStep);
            }
        }

        // ── Soften clay: if bot has buckets but no bucket-of-water ────────────
        const softenStep = steps.find(s => s.action === 'soften_clay' && craftLevel >= s.minLevel && craftLevel <= s.maxLevel);
        if (softenStep && hasItem(player, Items.BUCKET) && !hasItem(player, Items.BUCKET_OF_WATER)) {
            return new WaterFillingTask(Items.BUCKET, Items.BUCKET_OF_WATER);
        }

        // ── Leather crafting: needle + thread + (leather or cowhide anywhere) ──
        // port: the best leather step whose material the bot has (upstream took the first step its level allowed: from 28
        // the hard leather body, whose hard leather no bot makes, so it never crafted leather again)
        const owns = (id: number): boolean => this._bankCount(player, id) > 0 || countItem(player, id) > 0;
        // port: hides the tanner makes into the step's leather: soft (1 gp), or hard (3 gp) for the hard leather body
        const usable = (s: SkillStep): boolean => owns(s.itemConsumed!) || (owns(Items.COW_HIDE) && (s.itemConsumed === Items.LEATHER || (s.itemConsumed === Items.HARD_LEATHER && coinsOwned(player) >= 3)));
        const byBest = (a: SkillStep, b: SkillStep): number => b.minLevel - a.minLevel;
        const leatherSteps = steps.filter(s => (s.action.startsWith('craft_leather_') || s.action === 'craft_hard_leather_body') && craftLevel >= s.minLevel);
        // port: the level's own step, else the best below it (soft leather at 28+, with no hard leather to make a body of)
        const leatherStep = leatherSteps.filter(s => craftLevel <= s.maxLevel && usable(s)).sort(byBest)[0] ?? leatherSteps.filter(usable).sort(byBest)[0];
        if (leatherStep) {
            const hasNeedle = hasItem(player, Items.NEEDLE) || this._bankCount(player, Items.NEEDLE) > 0;
            const hasThread = hasItem(player, Items.THREAD) || this._bankCount(player, Items.THREAD) > 0;
            if (!hasNeedle && NEARBY_SHOPS.has('AL_KHARID_CRAFTING')) {
                return new ShopTripTask('AL_KHARID_CRAFTING', Items.NEEDLE, 1, 100);
            }
            if (!hasThread && NEARBY_SHOPS.has('AL_KHARID_CRAFTING')) {
                return new ShopTripTask('AL_KHARID_CRAFTING', Items.THREAD, 5, 5);
            }
            if (hasNeedle && hasThread) {
                return new CraftingTask(leatherStep);
            }
        }

        // ── Gem cutting: chisel + uncut gems in bank/inv ───────────────────────
        // port: any uncut gem it owns and its level cuts, the best first (upstream looked only at the first gem step)
        const gemStep = steps
            .filter(s => s.action.startsWith('cut_') && craftLevel >= s.minLevel && craftLevel <= s.maxLevel && owns(s.itemConsumed!))
            .sort((a, b) => b.minLevel - a.minLevel)[0];
        if (gemStep) {
            const hasChisel = hasItem(player, Items.CHISEL) || this._bankCount(player, Items.CHISEL) > 0;
            if (!hasChisel && NEARBY_SHOPS.has('AL_KHARID_CRAFTING')) {
                return new ShopTripTask('AL_KHARID_CRAFTING', Items.CHISEL, 1, 100);
            }
            if (hasChisel) {
                return new CraftingTask(gemStep);
            }
        }

        if (phase2Unlocked) {
            // ── Phase 2: gold rings ─────────────────────────────────────────────
            // port: only with gold bars (a mould with nothing to cast was bought, banked and bought again), and a
            // mould in the bank counts (CraftingTask withdraws it)
            const ringTask = this._findRingTask(player, 1);
            if (ringTask) return ringTask;
        }

        // ── Flax picking (members), when there is nothing of its own to craft ──
        if (spinStep) {
            const flaxStep = steps.find(s => s.action === 'pick_flax' && craftLevel >= s.minLevel && craftLevel <= s.maxLevel);
            if (flaxStep) {
                return new FlaxPickingTask(flaxStep);
            }
        }

        // ── Phase 1: wool spinning — universal fallback ────────────────────────
        const woolStep = steps.find(s => s.action === 'craft_wool');
        if (!woolStep) return null;
        // port: only near Lumbridge (its sheep pen, its castle's wheel), as _foodTrip: a members bot in Ardougne walked
        // there by Brimhaven and Karamja, and was jumped the last stretch; one far off picks something nearer
        const [px, pz] = Locations.LUMBRIDGE_SHEEP;
        if (Math.max(Math.abs(player.x - px), Math.abs(player.z - pz)) > WOOL_TRIP_TILES) return null;

        if (!hasItem(player, Items.SHEARS)) {
            // Shears are given as a starter item, but if somehow lost, buy from
            // the Lumbridge General Store (1gp, always in NEARBY_SHOPS).
            return new ShopTripTask('LUMBRIDGE_GENERAL', Items.SHEARS, 1, 1);
        }

        return new CraftingTask(woolStep);
    }

    /** Counts how many of an item are sitting in the bank (0 if bank not loaded). */
    private _bankCount(player: Player, itemId: number): number {
        const bid = bankInvId();
        if (bid === -1) return 0;
        const bank = player.getInventory(bid);
        if (!bank) return 0;
        let count = 0;
        for (let i = 0; i < bank.capacity; i++) {
            const item = bank.get(i);
            if (item?.id === itemId) count += item.count;
        }
        return count;
    }

    /**
     * Scans every string_ step (unstrung bow + bow string → finished bow) for
     * one whose level requirement is met and whose materials are available in
     * bank or inventory. Unlike the other FLETCHING steps, getProgressionStep()
     * can't be trusted to hand back a matching string_ step here — it picks
     * randomly among all steps at the bot's level, so a bot could be sitting on
     * a full set of, say, willow materials while the random pick keeps landing
     * on maple. Returns null when no string_ step has both materials ready.
     */
    private _findStringingTask(player: Player): BowStringingTask | null {
        const level = getBaseLevel(player, PlayerStat.FLETCHING);
        const steps = SkillProgression['FLETCHING'].filter(s => s.action.startsWith('string_') && level >= s.minLevel && level <= s.maxLevel);

        for (const step of steps) {
            const unstrungId = step.itemConsumed!;
            const stringId = (step.extra?.stringItem as number | undefined) ?? Items.BOW_STRING;
            const hasUnstrung = countItem(player, unstrungId) > 0 || this._bankCount(player, unstrungId) > 0;
            const hasString = countItem(player, stringId) > 0 || this._bankCount(player, stringId) > 0;
            if (hasUnstrung && hasString) {
                return new BowStringingTask(step);
            }
        }
        return null;
    }

    /**
     * Returns a RangedMagicTask if the bot can do ranged or magic right now.
     *
     * Conditions:
     *   • Has bow + arrows (ranged mode) OR staff_of_air + mind runes (magic mode), OR
     *   • Has ≥ 5 000 coins total (inv + bank) to buy equipment at Varrock.
     *
     * Returns null if neither condition is met (bot can't afford gear yet).
     */
    private _findRangedMagicTask(player: Player, stat: PlayerStat): RangedMagicTask | null {
        // Determine appropriate progression step for the stat
        const skillName = stat === PlayerStat.RANGED ? 'RANGED' : 'MAGIC';
        const level = getBaseLevel(player, stat);
        const step = this.prefer?.skill === skillName && this.prefer.step && level >= this.prefer.step.minLevel && level <= this.prefer.step.maxLevel ? this.prefer.step : getProgressionStep(skillName, level, undefined, [player.x, player.z], this._pickOpts(player, skillName));
        if (!step) return null;

        // port: the task's own test: gear worn, carried or banked (upstream here: carried only, and only a shortbow or
        // an oak one and a staff of air with mind runes, so a bot whose bow and arrows were worn or banked was sent
        // shopping with 3,000 coins or never trained), and no fighting at low health without food
        const task = new RangedMagicTask(step, stat);
        return task.shouldRun(player) ? task : null;
    }

    /**
     * Returns a RunecraftingTask if the bot has a talisman (any tier) and a
     * pickaxe.  The task itself picks the highest qualifying altar internally.
     */
    private _findRunecraftingTask(player: Player): BotTask | null {
        // (the variety work, round 1, Track D: DO-4) with a talisman, runes RUNECRAFT_SHARE of the time; else (and with
        // none: most bots, every saved one until a drop) essence from Aubury's mine, banked at Varrock East (EssenceTask):
        // runecrafting and the essence mine were 0 % of the bots' time
        const runes = new RunecraftingTask();
        const canRunes = runes.shouldRun(player);
        if (canRunes && Math.random() < RUNECRAFT_SHARE) return runes;
        const essence = new EssenceTask();
        // (the essence mine is one spot: with a crowd in it already, more often something else, 1 - its miners /
        // ESSENCE_ROOM: 16 at once at 500 online)
        if (essence.shouldRun(player) && Math.random() < 1 - spotOccupants(ESSENCE_STEP) / ESSENCE_ROOM) return essence;
        return canRunes ? runes : null;
    }

    /**
     * When the bot has ≥ 10 logs consumable by its current Firemaking OR Fletching
     * step, returns either a FiremakingTask or a FletchingTask with a 50/50 coin
     * flip.  If only one of the two tasks can currently use the available logs,
     * that task is returned without a flip.  Returns null when logs are scarce
     * (< 10) so the weighted loop handles gathering and the FM woodcutting fallback.
     */
    private _findLogsTask(player: Player): BotTask | null {
        const fmWeight = this.personality.weights['FIREMAKING'] ?? 0;
        const fletchWeight = this.personality.weights['FLETCHING'] ?? 0;

        // (the variety work, round 1, Track D: WHERE-1) from where the bot is: a lane near it (FIRE_LANE_TILES: its logs
        // come from its bank, not from a spot), and the fletching step's nominal spot too; upstream drew any of the map's
        // seven lanes alike (Varrock to Seers to burn one load)
        const from: [number, number] = [player.x, player.z];
        const fmStep = fmWeight > 0 ? getProgressionStep('FIREMAKING', getBaseLevel(player, PlayerStat.FIREMAKING), undefined, from, { within: FIRE_LANE_TILES, weigh: this._pickOpts(player, 'FIREMAKING').weigh }) : null;
        const fletchStep = fletchWeight > 0 ? getProgressionStep('FLETCHING', getBaseLevel(player, PlayerStat.FLETCHING), undefined, from) : null;

        if (!fmStep && !fletchStep) return null;

        const bid = bankInvId();
        const bank = bid !== -1 ? player.getInventory(bid) : null;

        const totalLogs = (logId: number): number => {
            if (logId === -1) return 0;
            let n = countItem(player, logId);
            if (bank) {
                for (let i = 0; i < bank.capacity; i++) {
                    const it = bank.get(i);
                    if (it?.id === logId) n += it.count;
                }
            }
            return n;
        };

        const fmLogId = fmStep?.itemConsumed ?? -1;
        const fletchLogId = fletchStep?.itemConsumed ?? -1;

        const fmAvail = fmStep !== null && fmLogId !== -1 && totalLogs(fmLogId) >= 10;
        const fletchAvail =
            fletchStep !== null &&
            fletchStep.action.startsWith('fletch_') &&
            fletchLogId !== -1 &&
            totalLogs(fletchLogId) >= 10;

        console.log(`[Planner:${player.username}] _findLogsTask fmAvail=${fmAvail}(logId=${fmLogId},n=${totalLogs(fmLogId)}) fletchAvail=${fletchAvail}(logId=${fletchLogId},n=${totalLogs(fletchLogId)})`);

        if (!fmAvail && !fletchAvail) return null;

        const doFletching = (): BotTask => {
            if (!this._hasKnifeAccessible(player)) {
                console.log(`[Planner:${player.username}] FLETCH→PickupSpawn (no knife)`);
                return new PickupSpawnTask(Items.KNIFE, KNIFE_SPAWNS);
            }
            console.log(`[Planner:${player.username}] FLETCH→FletchingTask step=${fletchStep!.action}`);
            return new FletchingTask(fletchStep!);
        };

        // (the variety work, round 1, Track D: DO-5) the flip by the skills' weights in the 2004 mix (and the theme's,
        // the favourites': _weightOf), not the planner's table: a skiller's fletching 17 against firemaking's 9 made
        // fletching 10 % of a 500-bot world's levelling time through this claim alone
        const fmW = fmWeight > 0 ? this._weightOf(player, 'FIREMAKING', fmWeight) : 0;
        const fletchW = fletchWeight > 0 ? this._weightOf(player, 'FLETCHING', fletchWeight) : 0;
        if (fmAvail && !fletchAvail) {
            if (fletchStep && fletchWeight > 0) {
                const total = fmW + fletchW;
                if (Math.random() >= fmW / total) {
                    // FletchingTask handles its own WC when logs are low
                    console.log(`[Planner:${player.username}] FLETCH→FletchingTask (self-contained WC, fmAvail but fletchAvail=false)`);
                    return doFletching();
                }
            }
            console.log(`[Planner:${player.username}] FLETCH→FM (only fmAvail)`);
            return new FiremakingTask(fmStep!);
        }
        if (!fmAvail && fletchAvail) return doFletching();

        // Both available — weighted flip proportional to fm/fletch weights
        const total = fmW + fletchW;
        return Math.random() < fmW / total ? new FiremakingTask(fmStep!) : doFletching();
    }

    /**
     * Returns skill names in weighted-random order.
     * Skills the bot can't afford (and has no free fallback) sink to the bottom.
     */
    private _buildCandidates(player: Player): string[] {
        const affordable: string[] = [];
        const unaffordable: string[] = [];

        const entries = Object.entries(this.personality.weights)
            .filter(
                ([skill, w]) =>
                    w &&
                    w > 0 &&
                    SKILLS_WITH_CONTENT.has(skill) &&
                    (() => {
                        const stat = SKILL_STAT[skill];
                        return stat !== undefined && getBaseLevel(player, stat) < 99;
                    })()
            )
            // (the variety work, round 1, Track D: DO-5's 2004 mix, DO-6's favourites and theme)
            .map(([skill, w]): [string, number] => [skill, this._weightOf(player, skill, w ?? 0)]);

        // Weighted shuffle into two buckets
        let remaining = entries.slice();
        while (remaining.length > 0) {
            const total = remaining.reduce((s, [, w]) => s + (w ?? 0), 0);
            let roll = Math.random() * total;
            let chosen = remaining[remaining.length - 1];
            for (const entry of remaining) {
                roll -= entry[1] ?? 0;
                if (roll <= 0) {
                    chosen = entry;
                    break;
                }
            }
            remaining = remaining.filter(e => e !== chosen);

            const [skill] = chosen;
            const stat = SKILL_STAT[skill];
            const level = stat !== undefined ? getBaseLevel(player, stat) : 0;
            const step = getProgressionStep(skill, level);
            if (!step) continue;

            if (canAffordStep(player, step)) {
                affordable.push(skill);
            } else {
                unaffordable.push(skill);
            }
        }

        // Affordable skills first, then unaffordable (so we try them but won't
        // issue an unaffordable shop trip — _pickBestTask skips those)
        return [...affordable, ...unaffordable];
    }

    /**
     * Fallback: find the cheapest combat progression step the bot can afford.
     * Used when all other skills are too expensive to get started.
     */
    private _cheapestCombatTask(player: Player): BotTask | null {
        // (hurt and no food: per step below, weak monsters need none)
        for (const skillName of ['ATTACK', 'STRENGTH', 'DEFENCE']) {
            const stat = SKILL_STAT[skillName];
            // port: PlayerStat.ATTACK is 0, so upstream's `if (!stat) continue` skipped Attack
            if (stat === undefined) continue;
            const level = getBaseLevel(player, stat);
            const step = this._combatStep(player, skillName, level);
            if (!step || !fitToFight(player, step)) continue; // port: hurt and no food: not now (weak monsters need none)
            if (combatWeaponFor(player, step) !== null) return this._combatOrUpgrade(player, step, stat); // port: worn or banked too

            const missing = getMissingPurchases(player, step);
            if (missing.length === 0) {
                // getMissingPurchases silently drops unaffordable items, so verify ownership
                if (!step.toolItemIds.every(id => hasItem(player, id))) continue;
                // Has all tools — can fight
                return new CombatTask(step, stat); // has weapon
            }
            if (canAffordStep(player, step) && NEARBY_SHOPS.has(missing[0].shopKey)) {
                // Tools available at a nearby shop — go buy them
                return new ShopTripTask(missing[0].shopKey, missing[0].itemId, missing[0].quantity, missing[0].cost);
            }
            // Weapon only available at distant shop — skip combat for now
            // (bot should have received starter weapon from InitTask)
        }
        return null;
    }

    /**
     * port: a combat step for this skill and level, preferring one the bot has the weapon for (worn, carried or
     * banked), mostly one that suits its level; else any (the caller may buy its scimitar).
     */
    private _combatStep(player: Player, skillName: string, level: number): SkillStep | null {
        // port (the realism work, phase 3): a clique-mate's spot first, when the bot can fight there (port/BotCliques: they
        // train together)
        const mate = cliqueStepFor(player, skillName, level);
        if (mate && mate.action === 'combat' && level >= mate.minLevel && level <= mate.maxLevel && combatWeaponFor(player, mate) !== null && fitToFight(player, mate) && this._reachable(player, mate)) return mate;
        // (the variety work, round 1, Track D: DO-7) the step it was at before it logged out, when it can fight there
        const was = this.prefer?.skill === skillName ? this.prefer.step : null;
        if (was && was.action === 'combat' && level >= was.minLevel && level <= was.maxLevel && combatWeaponFor(player, was) !== null && fitToFight(player, was) && this._reachable(player, was)) return was;
        // port: nearer spots more often (from); without food, one whose monsters it can fight without (earned gear); the
        // realism work (phase 3): 2004's crowd spots more often, each within its band of levels (BotKnowledge crowd, levelBand)
        const from: [number, number] = [player.x, player.z];
        // (the variety work, round 1, Track D: its home town's spots and its theme's more often, a busy spot less: _pickOpts,
        // port/BotSpots)
        const opts = this._pickOpts(player, skillName);
        // (port, phase 5a: and not across White Wolf Mountain for a careful low-level bot: _reachable)
        return (
            getProgressionStepWhere(skillName, level, s => combatWeaponFor(player, s) !== null && fitToFight(player, s) && this._reachable(player, s), from, opts) ??
            getProgressionStepWhere(skillName, level, s => combatWeaponFor(player, s) !== null && this._reachable(player, s), from, opts) ??
            getProgressionStepWhere(skillName, level, s => this._reachable(player, s), from, opts)
        );
    }

    /**
     * port: a non-combat skill's step for the weighted loop. Fletching's bow-stringing steps are left out (the
     * stringing priority hands those out when bows and strings are banked: upstream's random pick landed on one two
     * times in three and did nothing with it), and a thief under combat 20 is kept off the stalls (their guards hit
     * hard; the Ardougne baker's stall guard is level 21).
     */
    private _skillStep(player: Player, skillName: string, level: number): SkillStep | null {
        // port: nearer spots more often (from)
        const from: [number, number] = [player.x, player.z];
        // port: not a spot whose boat fare (there and back: Karamja's lobsters and gold) the bot cannot pay: it jumped
        // across, unseen, every trip once its coins were gone
        const coins = coinsOwned(player);
        const affordable = (s: SkillStep): boolean => knownFare(player.x, player.z, player.level, s.location[0], s.location[1], s.location[2]) <= coins;
        const usable = (s: SkillStep): boolean => {
            if (skillName === 'FLETCHING' && s.action.startsWith('string_')) return false;
            if (skillName === 'THIEVING' && player.combatLevel < 20 && s.action === 'thieve_stall') return false;
            // (the variety work, round 1, Track D) nor Draynor's willows under combat 15: WoodcuttingTask refuses them
            if (skillName === 'WOODCUTTING' && woodcutStepRefused(player, s)) return false;
            // (port, phase 5a: and not across White Wolf Mountain for a careful low-level bot: _reachable)
            return affordable(s) && this._reachable(player, s);
        };
        // port (the realism work, phase 3): a clique-mate's step first, when the bot can do it here (port/BotCliques)
        const mate = cliqueStepFor(player, skillName, level);
        if (mate && level >= mate.minLevel && level <= mate.maxLevel && (SkillProgression[skillName] ?? []).includes(mate) && usable(mate)) return mate;
        // (the variety work, round 1, Track D: DO-7) the step it was at before it logged out, when it can do it here
        const was = this.prefer?.skill === skillName ? this.prefer.step : null;
        if (was && level >= was.minLevel && level <= was.maxLevel && usable(was)) return was;
        // (Track D: its home town's spots and its theme's more often, a busy spot less; firemaking's lanes near it: WHERE-1)
        const opts = this._pickOpts(player, skillName);
        return getProgressionStepWhere(skillName, level, usable, from, skillName === 'FIREMAKING' ? { ...opts, within: FIRE_LANE_TILES } : opts);
    }

    // ── (the variety work, round 1, Track D: what bots do and where) ───────────────────────────────────────────────────

    /** DO-6: what this bot likes (port/BotFavourites, from its name: the same every login), read once */
    private _likes(player: Player): { name: string; theme: Theme | null; favourites: string[]; home: { x: number; z: number }; style: CombatStyle } {
        if (!this.likes || this.likes.name !== player.username) {
            const theme = themeOf(player.username);
            this.likes = { name: player.username, theme, favourites: favouritesOf(player.username, this.personality.weights), home: homeOf(player.username, isMembersWorld()), style: combatStyleOf(player.username) };
        }
        return this.likes;
    }

    /**
     * DO-5: how often a priority claim (cooking, smithing, the logs) takes the pick: CLAIM_FLOOR, and the rest by the
     * skill's weight in the shuffle against the bot's top skill's (a skiller's cooking claims most picks, a fighter's few)
     */
    private _claimChance(player: Player, skill: string): number {
        const w = this.personality.weights[skill] ?? 0;
        if (w <= 0) return 0;
        let top = 0;
        for (const [s, sw] of Object.entries(this.personality.weights)) if ((sw ?? 0) > 0 && SKILL_STAT[s] !== undefined) top = Math.max(top, this._weightOf(player, s, sw ?? 0));
        return top > 0 ? CLAIM_FLOOR + (1 - CLAIM_FLOOR) * Math.min(1, this._weightOf(player, skill, w) / top) : 1;
    }

    /** DO-5 and DO-6: a skill's weight in the shuffle: the planner's, times the 2004 mix's factor, the favourites' and the theme's */
    private _weightOf(player: Player, skill: string, weight: number): number {
        let w = weight * (MIX_2004[this.personality.name]?.[skill] ?? 1);
        if (this.personality.name === 'Random' && COMBAT_SKILLS.has(skill)) w = Math.max(w, MIX_COMBAT_FLOOR);
        const likes = this._likes(player);
        if (likes.theme?.skills[0] === skill) w *= THEME_WEIGHT;
        else if (likes.favourites.includes(skill)) w *= FAVOURITE_WEIGHT;
        // (the integrator's) a ranger trains Ranged and a mage Magic a bit more (STYLE_TRAINING_BIAS)
        if ((likes.style === 'ranger' && skill === 'RANGED') || (likes.style === 'mage' && skill === 'MAGIC')) w *= STYLE_TRAINING_BIAS;
        return w;
    }

    /** DO-6: a pick's own weights: the spots of its home town (HOME_WEIGHT) and of its name's theme (PREFER_WEIGHT) */
    private _pickOpts(player: Player, skill: string): PickOptions {
        const likes = this._likes(player);
        const theme = likes.theme?.skills[0] === skill ? likes.theme : null;
        return {
            weigh: (s: SkillStep): number => {
                const [sx, sz] = stepSurface(s);
                return (nearHome(likes.home, [sx, sz]) ? HOME_WEIGHT : 1) * (theme && themeStep(theme, s) ? PREFER_WEIGHT : 1);
            }
        };
    }

    /**
     * AM8: a candidate's spot is FAR_PLAN_TILES or more away: passed over FAR_PLAN_SKIP of the time, FAR_LIKED_SKIP for a
     * favourite, the theme or agility (a long trip for what the bot likes, or for a course, now and then); never a carry-on
     */
    private _farSkip(player: Player, skill: string, step: SkillStep): boolean {
        if (this.prefer?.skill === skill || stepDistance(step, player.x, player.z) < FAR_PLAN_TILES) return false;
        const likes = this._likes(player);
        // (the theme's pick again after its tool trip: that pick passed this already)
        if (this.themeForced && likes.theme?.skills[0] === skill) return false;
        // (never a friend's spot: the cliques train together, phase 3)
        const stat = SKILL_STAT[skill];
        if (stat !== undefined && step === cliqueStepFor(player, skill, getBaseLevel(player, stat))) return false;
        // (a favourite, the theme, agility, or a spot at its home town: a bot of Catherby goes home from Varrock)
        const liked = likes.theme?.skills[0] === skill || likes.favourites.includes(skill) || skill === 'AGILITY' || nearHome(likes.home, stepSurface(step));
        return Math.random() < (liked ? FAR_LIKED_SKIP : FAR_PLAN_SKIP);
    }

    /** WHERE-2: the task's spot is full: passed over 1 - spotRoom of the time (a task without a spot: never) */
    private _fullSpot(task: BotTask): boolean {
        const step = this._stepOf(task);
        return step !== null && Math.random() >= spotRoom(step);
    }

    /** AM8: _farSkip for a task the planner built itself (crafting, runecrafting): by its step's spot, if it has one */
    private _farTask(player: Player, skill: string, task: BotTask): boolean {
        const step = this._stepOf(task);
        return step !== null && this._farSkip(player, skill, step);
    }

    /**
     * DO-7: what the bot was doing before it logged out (it logs in where it logged out; nothing saved): the gatherer's
     * load in its pack (logs, fish, ore, essence: its skill), else the step nearest its login tile (within CARRY_ON_TILES,
     * a skill it trains) first, through the usual pick (its claims, tools and coins). Null: no hint, or nothing came of it.
     */
    private _carryOn(player: Player): BotTask | null {
        const hint = this._packHint(player) ?? this._nearestStep(player);
        if (!hint) return null;
        this.prefer = hint;
        try {
            return this._dangerChecked(player, this._pickBestTask(player));
        } finally {
            this.prefer = null;
        }
    }

    /** DO-7: the skills whose gathered items (logs, fish, ore, essence) the bank holds, when the bot is at a bank */
    private _bankedSkills(player: Player): Set<string> {
        const out = new Set<string>();
        const [bx, bz] = nearestBankTo(player.x, player.z);
        if (Math.max(Math.abs(player.x - bx), Math.abs(player.z - bz)) > 8) return out;
        const bid = bankInvId();
        const bank = bid === -1 ? null : player.getInventory(bid);
        if (!bank) return out;
        for (let slot = 0; slot < bank.capacity; slot++) {
            const item = bank.get(slot);
            const hit = item ? PACK_SKILLS.find(([, is]) => is(item.id)) : undefined;
            if (hit) out.add(hit[0]);
        }
        return out;
    }

    /** DO-7: the skill its pack's gathered items say (the most of one kind), if it trains it */
    private _packHint(player: Player): { skill: string; step: SkillStep | null } | null {
        const inv = player.getInventory(InvType.INV);
        if (!inv) return null;
        const bySkill = new Map<string, number>();
        const ids = new Set<number>();
        const count = (from: { capacity: number; get(slot: number): { id: number; count: number } | null }): void => {
            for (let slot = 0; slot < from.capacity; slot++) {
                const item = from.get(slot);
                if (!item) continue;
                const hit = PACK_SKILLS.find(([, is]) => is(item.id));
                if (!hit) continue;
                bySkill.set(hit[0], (bySkill.get(hit[0]) ?? 0) + item.count);
                ids.add(item.id);
            }
        };
        count(inv);
        let best: string | null = null;
        for (const [skill, n] of bySkill) if ((this.personality.weights[skill] ?? 0) > 0 && (best === null || n > (bySkill.get(best) ?? 0))) best = skill;
        if (!best) return null;
        // (its step: the nearest that gives what it carries)
        const level = getBaseLevel(player, SKILL_STAT[best]);
        let step: SkillStep | null = null;
        let bestD = CARRY_ON_TILES + 1;
        for (const s of SkillProgression[best] ?? []) {
            if (level < s.minLevel || level > s.maxLevel || s.itemGained === undefined || !ids.has(s.itemGained)) continue;
            const d = stepDistance(s, player.x, player.z);
            if (d < bestD) {
                bestD = d;
                step = s;
            }
        }
        return { skill: best, step };
    }

    /**
     * DO-7: a step near the login tile (within CARRY_ON_TILES) of a skill the bot trains and its level allows, each
     * skill's nearest drawn by its weight in the shuffle (the 2004 mix's, _weightOf) times its nearness (CARRY_ON_NEAR:
     * the spot it stood at counts most): a fighter that logged out by a bank among trees mostly fights on, a woodcutter
     * by its trees chops on
     */
    private _nearestStep(player: Player): { skill: string; step: SkillStep } | null {
        // (at a bank: the gathered stacks it banked there count for their skill: it logged out after a deposit)
        const banked = this._bankedSkills(player);
        const options: { skill: string; step: SkillStep; w: number }[] = [];
        for (const [skill, w] of Object.entries(this.personality.weights)) {
            const stat = SKILL_STAT[skill];
            if (!w || w <= 0 || stat === undefined) continue;
            const level = getBaseLevel(player, stat);
            let best: SkillStep | null = null;
            let bestD = CARRY_ON_TILES + 1;
            for (const s of SkillProgression[skill] ?? []) {
                if (level < s.minLevel || level > s.maxLevel || s.action.startsWith('string_') || s.action.startsWith('fletch_')) continue;
                const d = stepDistance(s, player.x, player.z);
                if (d < bestD) {
                    bestD = d;
                    best = s;
                }
            }
            if (best) options.push({ skill, step: best, w: (this._weightOf(player, skill, w) * (banked.has(skill) ? CARRY_ON_BANKED : 1)) / (1 + (bestD / CARRY_ON_NEAR) ** 2) });
        }
        let roll = Math.random() * options.reduce((a, o) => a + o.w, 0);
        for (const o of options) {
            roll -= o.w;
            if (roll < 0) return { skill: o.skill, step: o.step };
        }
        return options.length ? options[options.length - 1] : null;
    }

    /**
     * port: gold ring crafting when the bot has at least `minBars` gold bars (pack or bank) and a ring mould (pack or
     * bank: CraftingTask fetches it), or a ring mould trip when it has the bars but no mould and can pay for one.
     */
    private _findRingTask(player: Player, minBars: number): BotTask | null {
        const step = SkillProgression['CRAFTING']?.find(s => s.action === 'craft_ring');
        if (!step) return null;
        const bars = countItem(player, Items.GOLD_BAR) + this._bankCount(player, Items.GOLD_BAR);
        if (bars < minBars) return null;
        if (hasItem(player, Items.RING_MOULD) || this._bankCount(player, Items.RING_MOULD) > 0) {
            return new CraftingTask(step);
        }
        if (canAffordStep(player, step) && countItem(player, Items.COINS) >= 100 && NEARBY_SHOPS.has('AL_KHARID_CRAFTING')) {
            return new ShopTripTask('AL_KHARID_CRAFTING', Items.RING_MOULD, 1, 100);
        }
        return null;
    }

    /**
     * All bots get a full starter kit so they can attempt any beginning skill
     * without a shop trip. This avoids long walks on the very first session.
     *
     * Given to every bot regardless of personality:
     *   bronze_axe      — woodcutting from level 1
     *   bronze_sword    — combat from level 1
     *   bronze_pickaxe  — mining from level 1
     *   small_net       — fishing (shrimp) from level 1
     *
     * As bots level up and earn coins from selling resources, they upgrade
     * to better equipment via shop trips.
     */
    private _starterItems(): number[] {
        // (an iron scimitar: the combat steps past the chickens ask for one; earned gear, port/BotGear, buys from there)
        return [Items.BRONZE_AXE, Items.KNIFE, Items.IRON_SCIMITAR, Items.BRONZE_PICKAXE, Items.SMALL_FISHING_NET, Items.TINDERBOX, Items.HAMMER, Items.SHEARS];
    }

    /**
     * port: a fighter with no food at all (carried or banked) buys kebabs from Karim in Al Kharid, a coin each
     * (FoodTripTask: earned food), when it has the coins and is within 250 tiles of him; null when
     * not (a failed trip is not tried again for an hour)
     */
    private _foodTrip(player: Player): BotTask | null {
        if (carriedFood(player) > 0 || bankedFood(player) > 0) return null;
        if (coinsOwned(player) < 10 || tripFailedRecently(player, Items.KEBAB) || player.level !== 0) return null;
        const [kx, kz] = KEBAB_SELLER;
        if (Math.max(Math.abs(player.x - kx), Math.abs(player.z - kz)) > 250) return null;
        const trip = new FoodTripTask();
        return trip.shouldRun(player) ? trip : null;
    }

    /**
     * port: a combat step, or first a trip for the next piece of gear the bot can buy (port/BotGear: earned gear:
     * a better scimitar or armour piece its levels allow, from the shop that sells it, with its coins)
     */
    private _combatOrUpgrade(player: Player, step: SkillStep, stat: PlayerStat): BotTask {
        const food = this._foodTrip(player);
        if (food) return food;
        const up = nextGearUpgrade(player, SCIMITAR_TIERS);
        if (up) {
            const trip = new ShopTripTask(up.shopKey, up.itemId, 1, up.cost);
            if (trip.shouldRun(player)) return trip;
        }
        return new CombatTask(step, stat);
    }

    /**
     * port: a newbie newcomer's task (port/BotNewbie): first a wander round the Lumbridge courtyard
     * (NewbieTask), then the chickens or the cows near Lumbridge with the tutorial's sword, whatever its personality;
     * hurt and without food, another wander while the Hitpoints come back.
     * port (the realism work, phase 3: newbie time measured in levels, NEWBIE_TRAIN): a newbie trains at Lumbridge's
     * chickens, cows and goblins most of the time and now and then has an idle stint (the general store, Bob's axes, a
     * look about); a slow leveller (port/BotNewbie isSlowNewbie, about 2 in 3) the other way round. Its plans are a few
     * minutes long (newbiePlanEnds), so it is asked again often, and its planner takes over soon after it outgrew them.
     */
    private _newbieTask(player: Player): BotTask {
        if (!this.newbieWandered) {
            this.newbieWandered = true;
            return new NewbieTask('first');
        }
        // ---- (variety round 2, Track D2) a newcomer's quest look-alike or newbie chain now and then (port/BotD2Picks) ----
        {
            const d2 = d2NewbiePick(player);
            if (d2) return d2;
        }
        // ---- end of Track D2's newcomers' block ----
        if (Math.random() < NEWBIE_TRAIN[isSlowNewbie(player.username) ? 1 : 0]) {
            const step = newbieCombatStep(player);
            if (step) {
                const stats = [PlayerStat.ATTACK, PlayerStat.STRENGTH, PlayerStat.DEFENCE];
                return new NewbieCombatTask(step, stats[Math.floor(Math.random() * stats.length)]);
            }
        }
        return new NewbieTask('idle');
    }

    /** True if knife is in inventory or bank — used to avoid a shop trip when it just needs withdrawing. */
    private _hasKnifeAccessible(player: Player): boolean {
        if (hasItem(player, Items.KNIFE)) return true;
        const bid = bankInvId();
        if (bid === -1) return false;
        const bank = player.getInventory(bid);
        if (!bank) return false;
        for (let i = 0; i < bank.capacity; i++) {
            if (bank.get(i)?.id === Items.KNIFE) return true;
        }
        return false;
    }
}

// ── The danger check (the realism work, phase 5a, Track F) ───────────────────

/** port (phase 5a): a careful bot under this combat level does not cross White Wolf Mountain (its wolves hunt it) */
export const WWM_MIN_COMBAT = 15;
/** port (phase 5a): White Wolf Mountain's longitude: Taverley east of it, Catherby west */
const WWM_X = 2856;
/** port (phase 5a): a careless bot's "go anyway" over the mountain holds this long (a plan's length at most) */
const BOLD_TICKS = 3000;
const bold = new WeakMap<Player, { until: number; roll: number }>();

/**
 * port (phase 5a): this bot's "go anyway" now (carelessness × 0.5, drawn once in BOLD_TICKS). (The variety work, round
 * 2, the fixes: the draw is held, its chance read now, as carelessRoll's with the same one die: a death's halved
 * carelessness counts at once, and the tests' switch for careless moments, BotFumble.setCarelessRollsForTest, covers a
 * draw held from before it. The White Wolf Mountain check, test/texture.test.mjs, got a careful bot's 4 % "go anyway".)
 */
function boldFor(player: Player): boolean {
    const now = World.currentTick;
    let b = bold.get(player);
    if (!b || now >= b.until) bold.set(player, (b = { until: now + BOLD_TICKS, roll: Math.random() }));
    return b.roll < carelessChance(player, 0.5);
}

/** port (phase 5a): the danger along the walk graph's route between two nodes (static: the map's spawns), cached */
const routeDangers = new Map<string, Danger | null>();
function routeDangerBetween(a: number, b: number): Danger | null {
    const key = `${a}>${b}`;
    let d = routeDangers.get(key);
    if (d === undefined) {
        const nodes = graphRoute(a, b);
        d = nodes ? routeDanger(nodes) : null;
        if (routeDangers.size > 4096) routeDangers.clear();
        routeDangers.set(key, d);
    }
    return d;
}

/** port (phase 5a): the danger of the walk over White Wolf Mountain itself (Taverley to Catherby, the graph's route) */
function wwmDanger(): Danger | null {
    const a = nearestNode(2895, 3443);
    const b = nearestNode(2809, 3437);
    return a < 0 || b < 0 ? null : routeDangerBetween(a, b);
}

/**
 * port (phase 5a): does the bot's walk to (x, z) cross monsters that hunt it in a multi-combat area (port/BotDanger
 * along the walk graph's route: White Wolf Mountain's wolves between Taverley and Catherby)? Overworld only. Where the
 * graph does not join the two (a gateway between: Falador's to Taverley), a walk over the mountain's longitude is a walk
 * over the mountain (the one land way between Asgarnia and Kandarin).
 */
export function crossesHunters(player: Player, x: number, z: number): boolean {
    const a = nearestNode(player.x, player.z);
    const b = nearestNode(x, z);
    if (a < 0 || b < 0 || a === b) return false;
    const d = routeDangerBetween(a, b) ?? ((player.x < WWM_X) !== (x < WWM_X) && z <= 3700 && player.z <= 3700 ? wwmDanger() : null);
    return !!d && d.multi && huntsMe(player, d);
}

// ── Newbies (port/BotNewbie) ──────────────────────────────────────────────────

/**
 * port (the realism work, phase 3): the chance a newbie's next task is a fight (else an idle stint, NewbieTask): a
 * newbie's and a slow leveller's. The "slower turnover": a slow leveller (an "alt") fights one plan
 * in 200 (it was 3 in 100: at 10x XP a fight or two took it past combat 5 in a couple of hours, and the newcomer clock
 * brought new accounts to keep Lumbridge's level-3s, each retiring an old bot), so it stays a level-3 about Lumbridge
 * for its sessions, and the clock seldom needs a newcomer.
 */
export const NEWBIE_TRAIN: readonly [number, number] = [0.85, 0.005];

/** port (phase 3): Lumbridge (its castle) and how far from it a newbie's fights are (its chickens, cows and goblins) */
const LUMBRIDGE: readonly [number, number] = [3222, 3218];
const NEWBIE_FIGHT_TILES = 90;
/** port (phase 3): the monsters a newbie fights, and how much more often than goblins (whose step has spiders and men too) */
const NEWBIE_PREY: Readonly<Record<string, number>> = { chicken: 3, cow: 2, goblin: 1 };

/**
 * port (phase 3): a combat step for a newbie: one of the attack steps on Lumbridge's chickens, cows or goblins
 * (NEWBIE_PREY's weights), within NEWBIE_FIGHT_TILES of the castle, that it is fit for (food, Hitpoints); null: none
 */
function newbieCombatStep(player: Player): SkillStep | null {
    const steps: [SkillStep, number][] = [];
    let sum = 0;
    for (const s of SkillProgression['ATTACK'] ?? []) {
        if (s.action !== 'combat' || s.location[2] !== 0) continue;
        if (Math.max(Math.abs(s.location[0] - LUMBRIDGE[0]), Math.abs(s.location[1] - LUMBRIDGE[1])) > NEWBIE_FIGHT_TILES) continue;
        const extra = s.extra as { npcType?: unknown; npcTypes?: unknown } | undefined;
        const names = typeof extra?.npcType === 'string' ? [extra.npcType] : Array.isArray(extra?.npcTypes) ? (extra.npcTypes as unknown[]) : [];
        const weight = Math.max(0, ...names.map(n => (typeof n === 'string' ? (NEWBIE_PREY[n] ?? 0) : 0)));
        if (weight <= 0 || !fitToFight(player, s)) continue;
        steps.push([s, weight]);
        sum += weight;
    }
    let roll = Math.random() * sum;
    for (const [s, weight] of steps) {
        roll -= weight;
        if (roll < 0) return s;
    }
    return steps.length > 0 ? steps[steps.length - 1][0] : null;
}

// ── Factories ─────────────────────────────────────────────────────────────────

export function makeSkiller(): BotGoalPlanner {
    return new BotGoalPlanner(Personalities.SKILLER);
}
export function makeFighter(): BotGoalPlanner {
    return new BotGoalPlanner(Personalities.FIGHTER);
}
export function makeBalanced(): BotGoalPlanner {
    return new BotGoalPlanner(Personalities.BALANCED);
}

/**
 * port: the weights come from the bot's name, the same at every login, as its age and a PKer's build do (port/BotSeed);
 * upstream drew new ones at every login, so a "random" bot was a different player each session.
 */
export function makeRandom(name?: string): BotGoalPlanner {
    const allSkills = Object.keys(SKILL_STAT).filter(s => SKILLS_WITH_CONTENT.has(s));
    const weights: Record<string, number> = {};
    const roll = name ? seededRandom(nameSeed(name, 'random-planner-weights')) : Math.random;
    for (const s of allSkills) weights[s] = Math.floor(roll() * 20) + 1;
    return new BotGoalPlanner({ name: 'Random', weights });
}

// ── Extras personalities ───────────────────────────────────────────────────────

/**
 * Temporary tester planner for Barbarian Agility course validation.
 * Seeds the entry requirement so the bot can immediately use the course.
 */
export class AgilityTestGoalPlanner extends BotGoalPlanner {
    private started = false;
    private seededStats = false;

    constructor() {
        super({ name: 'Agility Test', weights: { AGILITY: 100 } });
    }

    override pickTask(player: Player): BotTask | null {
        if (!this.seededStats) {
            this.seededStats = true;
            if (getBaseLevel(player, PlayerStat.AGILITY) < 35) {
                player.setLevel(PlayerStat.AGILITY, 35);
            }
            if (getBaseLevel(player, PlayerStat.HITPOINTS) < 30) {
                player.setLevel(PlayerStat.HITPOINTS, 30);
            }
        }

        if (!this.started) {
            this.started = true;
            return new InitTask([]);
        }

        const step = SkillProgression.AGILITY.find(s => s.extra?.course === 'BARBARIAN');
        return step ? new AgilityTask(step) : new IdleTask(30);
    }
}

export function makeAgilityTester(): AgilityTestGoalPlanner {
    return new AgilityTestGoalPlanner();
}

export type ExtrasType = 'social' | 'vendor' | 'pker' | 'edgeville_pker';

/**
 * Goal planner for "extras" bots — social, vendor, and wilderness PKer.
 * These bots skip all skilling logic and run a single specialised task.
 */
export class ExtrasGoalPlanner extends BotGoalPlanner {
    private readonly extrasType: ExtrasType;
    private extrasInit = false;

    constructor(type: ExtrasType) {
        super({ name: `Extras-${type}`, weights: {} });
        this.extrasType = type;
    }

    override pickTask(_player: Player): BotTask | null {
        if (!this.extrasInit) {
            this.extrasInit = true;
            // Extras bots skip the normal InitTask — their tasks self-initialise.
        }
        switch (this.extrasType) {
            case 'social':         return new SocialTask();
            case 'vendor':         return new VendorTask();
            case 'pker':           return new PKerTask();
            case 'edgeville_pker': return new EdgevillePKerTask();
        }
    }
}

export function makeExtrasSocial(): ExtrasGoalPlanner {
    return new ExtrasGoalPlanner('social');
}
export function makeExtrasVendor(): ExtrasGoalPlanner {
    return new ExtrasGoalPlanner('vendor');
}
export function makeExtrasPKer(): ExtrasGoalPlanner {
    return new ExtrasGoalPlanner('pker');
}
export function makeExtrasEdgevillePKer(): ExtrasGoalPlanner {
    return new ExtrasGoalPlanner('edgeville_pker');
}
