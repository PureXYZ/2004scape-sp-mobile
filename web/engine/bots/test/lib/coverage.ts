// Task coverage for test/sim.mjs --scenario=coverage: every task kind the upstream planners can pick, each given to
// one bot with what it needs (levels, tools, materials), so each can be seen to start and make progress on 274 in
// one run. A case passes when the bot gains XP in one of its skills (or, for the tasks that give none, shows its
// own sign of progress).
import Player from '#/engine/entity/Player.js';
import InvType from '#/cache/config/InvType.js';
import { Inventory } from '#/engine/Inventory.js';
import { Items, SkillProgression, Locations, type SkillStep } from '#/engine/bot/BotKnowledge.js';
import { BotTask, bankInvId } from '#/engine/bot/tasks/BotTaskBase.js';
import { BuryBonesTask, BankTask } from '#/engine/bot/tasks/UtilTasks.js';
import { ShopTripTask } from '#/engine/bot/tasks/ShopTripTask.js';
import { WoodcuttingTask } from '#/engine/bot/tasks/WoodcuttingTask.js';
import { MiningTask } from '#/engine/bot/tasks/MiningTask.js';
import { FishingTask } from '#/engine/bot/tasks/FishingTask.js';
import { CombatTask } from '#/engine/bot/tasks/CombatTask.js';
import { FiremakingTask } from '#/engine/bot/tasks/FiremakingTask.js';
import { CookingTask } from '#/engine/bot/tasks/CookingTask.js';
import { SmithingTask } from '#/engine/bot/tasks/SmithingTask.js';
import { ThievingTask } from '#/engine/bot/tasks/ThievingTask.js';
import { CraftingTask } from '#/engine/bot/tasks/CraftingTask.js';
import { FlaxPickingTask } from '#/engine/bot/tasks/FlaxPickingTask.js';
import { WaterFillingTask } from '#/engine/bot/tasks/WaterFillingTask.js';
import { RunecraftingTask } from '#/engine/bot/tasks/RunecraftingTask.js';
import { FletchingTask } from '#/engine/bot/tasks/FletchingTask.js';
import { BowStringingTask } from '#/engine/bot/tasks/BowStringingTask.js';
import { HerbloreTask } from '#/engine/bot/tasks/HerbloreTask.js';
import { AgilityTask } from '#/engine/bot/tasks/AgilityTask.js';
import { RangedMagicTask } from '#/engine/bot/tasks/RangedMagicTask.js';
import { PickupSpawnTask } from '#/engine/bot/tasks/PickupSpawnTask.js';
import { BankstandTask } from '#/engine/bot/tasks/BankstandTask.js';
import { SocialTask } from '#/engine/bot/tasks/SocialTask.js';
import { VendorTask } from '#/engine/bot/tasks/VendorTask.js';
import { PKerTask } from '#/engine/bot/tasks/PKerTask.js';
import { EdgevillePKerTask } from '#/engine/bot/tasks/EdgevillePKerTask.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import ObjType from '#/cache/config/ObjType.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { BotGoalPlanner } from '#/engine/bot/BotGoalPlanner.js';

export interface CoverageCase {
    name: string;
    /** the task kind (BotTask.name before any ':') */
    kind: string;
    /** a members-only activity: not run on a free world */
    members: boolean;
    levels?: Partial<Record<keyof typeof PlayerStat, number>>;
    inv?: [number, number][];
    bank?: [number, number][];
    /** items put on (worn) at the start */
    worn?: number[];
    /** anything else the case needs, after levels and items (a bot hurt before it starts) */
    setup?(player: Player): void;
    /** the task, or… */
    make?(): BotTask;
    /** …the planner's choice: a planner with these skill weights (Personalities' shape) picks every task */
    plan?: Partial<Record<string, number>>;
    /**
     * (the variety work, round 1) the bot it needs, by its name (the names are the roster's): the runner (test/sim.mjs)
     * swaps a bot that is not with a forced case's
     */
    bot?(name: string): boolean;
    /** progress: XP in any of these skills… (kind '*': any task kind counts as started) */
    skills?: (keyof typeof PlayerStat)[];
    /** …or this (for tasks without XP); `start` is a snapshot taken at setup */
    progress?(player: Player, start: Snapshot): boolean;
}

export interface Snapshot {
    stats: Int32Array;
    inv: Map<number, number>;
    bank: Map<number, number>;
    said: string[];
}

function step(skill: string, pred: (s: SkillStep) => boolean): SkillStep {
    const s = SkillProgression[skill]?.find(pred);
    if (!s) throw new Error(`no ${skill} step`);
    return s;
}

function counts(inv: Inventory | null): Map<number, number> {
    const out = new Map<number, number>();
    if (!inv) return out;
    for (let i = 0; i < inv.capacity; i++) {
        const it = inv.get(i);
        if (it) out.set(it.id, (out.get(it.id) ?? 0) + it.count);
    }
    return out;
}

export function snapshot(player: Player, said: string[]): Snapshot {
    return { stats: Int32Array.from(player.stats), inv: counts(player.getInventory(InvType.INV)), bank: counts(player.getInventory(bankInvId())), said };
}

function gained(player: Player, start: Snapshot, id: number): number {
    const now = counts(player.getInventory(InvType.INV)).get(id) ?? 0;
    const bank = counts(player.getInventory(bankInvId())).get(id) ?? 0;
    return now + bank - (start.inv.get(id) ?? 0) - (start.bank.get(id) ?? 0);
}

/** how many more of the item the bank holds than at the start (a catch or a cut banked) */
function bankGained(player: Player, start: Snapshot, id: number): number {
    return (counts(player.getInventory(bankInvId())).get(id) ?? 0) - (start.bank.get(id) ?? 0);
}

/** the bot has the item anywhere: worn, carried or banked (a piece of gear it bought goes on) */
function ownsAnywhere(player: Player, id: number): boolean {
    return [InvType.WORN, InvType.INV, bankInvId()].some(inv => (counts(player.getInventory(inv)).get(id) ?? 0) > 0);
}

/**
 * (the realism work, phase 4: patchwork gear) the pieces a case's bot likes (port/BotLooks.setTasteForTest: what it buys
 * follows its taste); an A/B copy of an older library has no port/BotLooks, and buys as it did. (Phase 5b: a cape it buys
 * is `ownCape`, `cape` the one it wears, a clan's for a clique member: the cases give both)
 */
const Looks: { setTasteForTest?: (name: string, taste: Record<string, unknown> | null) => void } = await import('#/engine/bot/port/BotLooks.js').catch(() => ({}));
const likes = (taste: Record<string, unknown>) => (p: Player): void => Looks.setTasteForTest?.(p.username, taste);
/**
 * (the variety work, round 1) what a bot is by its name: track W's combat style and liked weapon kind (port/BotOutfits: a
 * ranger or a mage buys its style's pieces, never plate, and a liked kind's weapon comes before armour: the platebody's
 * case had smithy_steve, a ranger that likes battleaxes, and bought a battleaxe in its one shop trip) and track D's theme
 * (port/BotFavourites: a themed name does its theme first 3 picks in 4, whatever a plan weighs: the variety case had
 * flax_picker, which spun flax all run). An A/B copy of an older library has neither: any bot does
 */
const Outfits: { combatStyleOf?: (name: string) => string; weaponKindOf?: (name: string) => string } = await import('#/engine/bot/port/BotOutfits.js').catch(() => ({}));
const Favourites: { themeOf?: (name: string) => unknown } = await import('#/engine/bot/port/BotFavourites.js').catch(() => ({}));
/** a melee fighter that likes scimitars: the iron scimitar it wields is its kind's, and its coins go to the case's piece */
const meleeScimitar = (name: string): boolean => (Outfits.combatStyleOf?.(name) ?? 'melee') === 'melee' && (Outfits.weaponKindOf?.(name) ?? 'scimitar') === 'scimitar';
/** a name with no theme: the plan's weights pick */
const unthemed = (name: string): boolean => !Favourites.themeOf?.(name);
/** a red cape (port/BotGear's accessories: Thessalia's) */
const RED_CAPE = 1007;

/** a thief the planner sends to the stalls (combat 23: the market guards are level 21) */
const STALL_THIEF = { THIEVING: 5, ATTACK: 20, STRENGTH: 20, DEFENCE: 20, HITPOINTS: 20 };

const KNIFE_SPAWNS = [{ coords: Locations.KNIFE_SPAWN_LUMBRIDGE, via: [3199, 3218, 0] as [number, number, number] }];

export function coverageCases(): CoverageCase[] {
    const cases: CoverageCase[] = [
        { name: 'woodcutting (trees, Lumbridge)', kind: 'Woodcut', members: false, inv: [[Items.BRONZE_AXE, 1]], make: () => new WoodcuttingTask(step('WOODCUTTING', s => s.itemGained === Items.LOGS)), skills: ['WOODCUTTING'] },
        // another task banked the axe: the bot fetches it first
        { name: 'woodcutting (axe in the bank)', kind: 'Woodcut', members: false, bank: [[Items.BRONZE_AXE, 1]], make: () => new WoodcuttingTask(step('WOODCUTTING', s => s.itemGained === Items.LOGS)), skills: ['WOODCUTTING'] },
        { name: 'mining (copper, Varrock west)', kind: 'Mine', members: false, inv: [[Items.BRONZE_PICKAXE, 1]], make: () => new MiningTask(step('MINING', s => s.itemGained === Items.COPPER_ORE)), skills: ['MINING'] },
        // FishingTask wants combat 16 at Al Kharid and Draynor (dark wizards)
        { name: 'fishing (shrimp, Al Kharid)', kind: 'Fish', members: false, levels: { ATTACK: 15, STRENGTH: 15, DEFENCE: 15, HITPOINTS: 15 }, inv: [[Items.SMALL_FISHING_NET, 1]], make: () => new FishingTask(step('FISHING', s => s.itemGained === Items.RAW_SHRIMP)), skills: ['FISHING'] },
        { name: 'combat (chickens, Lumbridge)', kind: 'Combat', members: false, inv: [[Items.BRONZE_SWORD, 1]], make: () => new CombatTask(step('ATTACK', s => s.extra?.npcType === 'chicken'), PlayerStat.ATTACK), skills: ['ATTACK', 'STRENGTH', 'DEFENCE', 'HITPOINTS'] },
        { name: 'combat (dark wizards, level 20+)', kind: 'Combat', members: false, levels: { ATTACK: 25, STRENGTH: 25, DEFENCE: 25, HITPOINTS: 30 }, inv: [[Items.IRON_SCIMITAR, 1]], make: () => new CombatTask(step('ATTACK', s => Array.isArray(s.extra?.npcTypes) && (s.extra!.npcTypes as string[]).includes('bearded_dark_wizard')), PlayerStat.ATTACK), skills: ['ATTACK', 'STRENGTH', 'DEFENCE', 'HITPOINTS'] },
        { name: 'prayer (bury bones)', kind: 'Prayer', members: false, inv: [[Items.BONES, 10]], make: () => new BuryBonesTask(), skills: ['PRAYER'] },
        { name: 'firemaking (logs)', kind: 'Firemaking', members: false, inv: [[Items.TINDERBOX, 1], [Items.LOGS, 10]], bank: [[Items.LOGS, 30]], make: () => new FiremakingTask(step('FIREMAKING', s => s.minLevel === 1)), skills: ['FIREMAKING'] },
        { name: 'cooking (shrimp on a range)', kind: 'Cook', members: false, bank: [[Items.RAW_SHRIMP, 40]], make: () => new CookingTask(step('COOKING', s => s.itemConsumed === Items.RAW_SHRIMP)), skills: ['COOKING'] },
        // Lumbridge castle's range, behind its doors
        { name: 'cooking (shrimp, Lumbridge castle)', kind: 'Cook', members: false, bank: [[Items.RAW_SHRIMP, 40]], make: () => new CookingTask(step('COOKING', s => s.itemConsumed === Items.RAW_SHRIMP && s.location === Locations.LUMBRIDGE_RANGE)), skills: ['COOKING'] },
        // all of it: 30 copper and 12 tin make 12 bars (upstream filled the inventory with copper and stalled)
        { name: 'smithing (smelt bronze)', kind: 'Smith', members: false, bank: [[Items.COPPER_ORE, 30], [Items.TIN_ORE, 12]], make: () => new SmithingTask(step('SMITHING', s => s.action === 'smelt' && s.itemConsumed === Items.COPPER_ORE)), progress: (p, start) => gained(p, start, Items.BRONZE_BAR) >= 12 },
        // the real smithing interface: bars used, platebodies made (upstream's anvil gave XP for every click and made nothing)
        { name: 'smithing (anvil, bronze bars)', kind: 'Smith', members: false, levels: { SMITHING: 18 }, inv: [[Items.HAMMER, 1]], bank: [[Items.BRONZE_BAR, 27]], make: () => new SmithingTask(step('SMITHING', s => s.action === 'smith')), progress: (p, start) => gained(p, start, Items.BRONZE_PLATEBODY) >= 3 && gained(p, start, Items.BRONZE_BAR) <= -15 && p.stats[PlayerStat.SMITHING] > start.stats[PlayerStat.SMITHING] },
        { name: 'crafting (shear sheep, spin wool)', kind: 'Crafting', members: false, inv: [[Items.SHEARS, 1]], make: () => new CraftingTask(step('CRAFTING', s => s.action === 'craft_wool')), skills: ['CRAFTING'] },
        { name: 'crafting (spin flax)', kind: 'Crafting', members: true, levels: { CRAFTING: 10 }, bank: [[Items.FLAX, 40]], make: () => new CraftingTask(step('CRAFTING', s => s.action === 'spin_flax')), skills: ['CRAFTING'] },
        { name: 'crafting (leather gloves)', kind: 'Crafting', members: false, inv: [[Items.NEEDLE, 1], [Items.THREAD, 10]], bank: [[Items.LEATHER, 20], [Items.COINS, 2000]], make: () => new CraftingTask(step('CRAFTING', s => s.action === 'craft_leather_gloves')), skills: ['CRAFTING'] },
        // port: hides tanned at the tanner's interface (1 gp each), and the body made in the leather interface
        { name: 'crafting (tan hides, leather body)', kind: 'Crafting', members: false, levels: { CRAFTING: 14 }, inv: [[Items.NEEDLE, 1], [Items.THREAD, 10]], bank: [[Items.COW_HIDE, 20], [Items.COINS, 500]], make: () => new CraftingTask(step('CRAFTING', s => s.action === 'craft_leather_body')), progress: (p, start) => gained(p, start, Items.LEATHER_BODY) >= 3 },
        // port: hard leather from the tanner (3 gp each): no bot ever had any, so the step never ran
        { name: 'crafting (hard leather body from hides)', kind: 'Crafting', members: false, levels: { CRAFTING: 28 }, inv: [[Items.NEEDLE, 1], [Items.THREAD, 10]], bank: [[Items.COW_HIDE, 20], [Items.COINS, 500]], make: () => new CraftingTask(step('CRAFTING', s => s.action === 'craft_hard_leather_body')), progress: (p, start) => gained(p, start, Items.HARD_LEATHER_BODY) >= 3 },
        { name: 'crafting (cut sapphires)', kind: 'Crafting', members: false, levels: { CRAFTING: 20 }, inv: [[Items.CHISEL, 1]], bank: [[Items.UNCUT_SAPPHIRE, 20]], make: () => new CraftingTask(step('CRAFTING', s => s.action === 'cut_sapphire')), skills: ['CRAFTING'] },
        { name: 'crafting (gold rings)', kind: 'Crafting', members: false, levels: { CRAFTING: 5, MINING: 40, SMITHING: 40 }, inv: [[Items.RING_MOULD, 1]], bank: [[Items.GOLD_BAR, 20]], make: () => new CraftingTask(step('CRAFTING', s => s.action === 'craft_ring')), skills: ['CRAFTING'] },
        { name: 'thieving (pickpocket men)', kind: 'Thieve', members: true, make: () => new ThievingTask(step('THIEVING', s => s.extra?.npcName === 'man')), skills: ['THIEVING'] },
        // (the coins a new bot has: the boats' fares there, Port Sarim's and Brimhaven's; combat 23, as the planner keeps
        // thieves under combat 20 off the guarded stalls: BotGoalPlanner._skillStep)
        { name: 'thieving (Ardougne baker\'s stall)', kind: 'Thieve', members: true, levels: STALL_THIEF, inv: [[Items.COINS, 200]], make: () => new ThievingTask(step('THIEVING', s => s.action === 'thieve_stall')), skills: ['THIEVING'] },
        // port: from Brimhaven by the boat to Ardougne (its customs officer, 30 coins, the gangplank; upstream teleported)
        // (it counts once it walks off the boat in Ardougne)
        { name: 'thieving (Ardougne, by the Brimhaven boat)', kind: 'Thieve', members: true, levels: STALL_THIEF, inv: [[Items.COINS, 200]], setup: p => p.teleJump(2772, 3228, 0), make: () => new ThievingTask(step('THIEVING', s => s.action === 'thieve_stall')), progress: p => p.level === 0 && p.x >= 2600 && p.x <= 2700 && p.z >= 3250 && p.z <= 3350 },
        { name: 'pick flax (Seers)', kind: 'Pick Flax', members: true, make: () => new FlaxPickingTask(step('CRAFTING', s => s.action === 'pick_flax')), progress: (p, start) => gained(p, start, Items.FLAX) > 0 },
        { name: 'fill buckets with water', kind: 'WaterFilling', members: false, inv: [[Items.BUCKET, 5]], make: () => new WaterFillingTask(Items.BUCKET, Items.BUCKET_OF_WATER), progress: (p, start) => gained(p, start, Items.BUCKET_OF_WATER) > 0 },
        { name: 'runecrafting (air runes)', kind: 'Runecrafting', members: false, inv: [[Items.AIR_TALISMAN, 1], [Items.BRONZE_PICKAXE, 1]], make: () => new RunecraftingTask(), skills: ['RUNECRAFT'] },
        { name: 'fletching (shortbows from logs)', kind: 'Fletching', members: true, levels: { FLETCHING: 5 }, inv: [[Items.KNIFE, 1], [Items.BRONZE_AXE, 1]], bank: [[Items.LOGS, 40]], make: () => new FletchingTask(step('FLETCHING', s => s.action === 'fletch_shortbow')), skills: ['FLETCHING'] },
        { name: 'fletching (string shortbows)', kind: 'BowStringing', members: true, levels: { FLETCHING: 5 }, bank: [[Items.UNSTRUNG_SHORTBOW, 20], [Items.BOW_STRING, 20]], make: () => new BowStringingTask(step('FLETCHING', s => s.action === 'string_shortbow')), skills: ['FLETCHING'] },
        { name: 'herblore (attack potions)', kind: 'Herblore', members: true, levels: { HERBLORE: 3 }, inv: [[Items.COINS, 5000]], bank: [[Items.CLEAN_GUAM, 20]], make: () => new HerbloreTask(step('HERBLORE', s => s.action === 'herblore_attack')), skills: ['HERBLORE'] },
        // port: the coins in the bank (upstream counted them, then shopped with the pack's and bought nothing)
        { name: 'herblore (coins and grimy guams in the bank)', kind: 'Herblore', members: true, levels: { HERBLORE: 3 }, bank: [[199, 20], [Items.COINS, 5000]], make: () => new HerbloreTask(step('HERBLORE', s => s.action === 'herblore_attack')), skills: ['HERBLORE'] },
        { name: 'agility (gnome course)', kind: 'Agility', members: true, make: () => new AgilityTask(step('AGILITY', s => s.extra?.course === 'GNOME')), skills: ['AGILITY'] },
        { name: 'agility (barbarian course)', kind: 'Agility', members: true, levels: { AGILITY: 35, HITPOINTS: 30 }, make: () => new AgilityTask(step('AGILITY', s => s.extra?.course === 'BARBARIAN')), skills: ['AGILITY'] },
        { name: 'agility (wilderness course)', kind: 'Agility', members: true, levels: { AGILITY: 52, HITPOINTS: 40 }, make: () => new AgilityTask(step('AGILITY', s => s.extra?.course === 'WILDERNESS')), skills: ['AGILITY'] },
        { name: 'ranged (shortbow)', kind: 'RangedMagic', members: false, inv: [[Items.SHORTBOW, 1], [Items.BRONZE_ARROW, 300]], make: () => new RangedMagicTask(step('RANGED', s => s.minLevel === 1), PlayerStat.RANGED), skills: ['RANGED'] },
        { name: 'magic (wind strike)', kind: 'RangedMagic', members: false, inv: [[Items.STAFF_OF_AIR, 1], [Items.MIND_RUNE, 300]], make: () => new RangedMagicTask(step('MAGIC', s => s.minLevel === 1), PlayerStat.MAGIC), skills: ['MAGIC'] },
        { name: 'shop trip (iron axe at Bob\'s)', kind: 'ShopTrip', members: false, inv: [[Items.COINS, 500]], make: () => new ShopTripTask('BOB_AXES', Items.IRON_AXE, 1, 56), progress: (p, start) => gained(p, start, Items.IRON_AXE) > 0 },
        { name: 'pick up the Lumbridge knife', kind: 'PickupSpawn', members: false, make: () => new PickupSpawnTask(Items.KNIFE, KNIFE_SPAWNS), progress: (p, start) => gained(p, start, Items.KNIFE) > 0 },
        { name: 'bank a full inventory', kind: 'Bank', members: false, inv: [[Items.LOGS, 27]], make: () => new BankTask([]), progress: (p, start) => (counts(p.getInventory(bankInvId())).get(Items.LOGS) ?? 0) > (start.bank.get(Items.LOGS) ?? 0) },
        { name: 'bankstand (sell at Varrock West)', kind: 'Bankstand', members: false, bank: [[Items.LOGS, 100], [Items.COPPER_ORE, 100]], make: () => new BankstandTask(), progress: (p, start) => start.said.length > 0 },
        { name: 'vendor (stall and adverts)', kind: 'Vendor', members: false, make: () => new VendorTask(), progress: (p, start) => p.botVendorStockItemId !== -1 && start.said.length > 0 },
        // (it says something, or stands at its hub on a tile of its own: a regular at a quiet hub may say nothing in a run's
        // 25 minutes, by its persona's rate and the dice; the realism work's phase 4 took the appearance off Math.random,
        // and with the dice this run's regular stood at Port Sarim in silence)
        { name: 'social', kind: 'Social', members: false, make: () => new SocialTask(), progress: (p, start) => start.said.length > 0 || (p as unknown as { _bot?: { currentTask?: { state?: string } | null } })._bot?.currentTask?.state === 'stand' },
        // ── port: the planner and task fixes (README, "Planner and tasks") ──
        // a worn scimitar counts (upstream wanted a steel scimitar in the pack from Attack 35, and bots wear a better one)
        { name: 'combat (Al Kharid warriors, rune scimitar worn)', kind: 'Combat', members: false, levels: { ATTACK: 45, STRENGTH: 45, DEFENCE: 45, HITPOINTS: 45 }, worn: [Items.RUNE_SCIMITAR], inv: [[Items.COINS, 200]], make: () => new CombatTask(step('ATTACK', s => s.extra?.npcType === 'al_kharid_warrior'), PlayerStat.ATTACK), skills: ['ATTACK', 'STRENGTH', 'DEFENCE', 'HITPOINTS'] },
        // current Hitpoints, not the XP: a hurt fighter with food eats, some of it (upstream never did; it sold it)
        { name: 'combat (hurt: eats its swordfish)', kind: 'Combat', members: false, levels: { ATTACK: 30, STRENGTH: 30, DEFENCE: 30, HITPOINTS: 40 }, inv: [[Items.IRON_SCIMITAR, 1], [Items.SWORDFISH, 5]], setup: p => { p.levels[PlayerStat.HITPOINTS] = 8; }, make: () => new CombatTask(step('ATTACK', s => s.extra?.npcType === 'cow'), PlayerStat.ATTACK), progress: p => { const left = counts(p.getInventory(InvType.INV)).get(Items.SWORDFISH) ?? 0; return left > 0 && left < 5; } },
        // and without food it leaves the fight for its bank's food (here a members world's shark is not food on a free one)
        { name: 'combat (hurt, no food: banks for some)', kind: 'Combat', members: false, levels: { ATTACK: 30, STRENGTH: 30, DEFENCE: 30, HITPOINTS: 40 }, inv: [[Items.IRON_SCIMITAR, 1]], bank: [[Items.SHARK, 50], [Items.LOBSTER, 20]], setup: p => { p.levels[PlayerStat.HITPOINTS] = 8; }, make: () => new CombatTask(step('ATTACK', s => s.extra?.npcType === 'cow'), PlayerStat.ATTACK), progress: (p, start) => gained(p, start, Items.LOBSTER) + gained(p, start, Items.SHARK) < 0 && (isMembersWorld() || gained(p, start, Items.SHARK) === 0) },
        // the bow worn, the arrows in the bank: upstream re-entered bank_walk every tick and never walked there
        { name: 'ranged (bow worn, arrows in the bank)', kind: 'RangedMagic', members: false, worn: [Items.SHORTBOW], bank: [[Items.BRONZE_ARROW, 300]], make: () => new RangedMagicTask(step('RANGED', s => s.minLevel === 1 && s.extra?.npcType === 'chicken'), PlayerStat.RANGED), skills: ['RANGED'] },
        // tools another task banked
        { name: 'mining (pickaxe in the bank)', kind: 'Mine', members: false, bank: [[Items.BRONZE_PICKAXE, 1]], make: () => new MiningTask(step('MINING', s => s.itemGained === Items.COPPER_ORE)), skills: ['MINING'] },
        { name: 'fishing (net in the bank)', kind: 'Fish', members: false, levels: { ATTACK: 15, STRENGTH: 15, DEFENCE: 15, HITPOINTS: 15 }, bank: [[Items.SMALL_FISHING_NET, 1]], make: () => new FishingTask(step('FISHING', s => s.itemGained === Items.RAW_SHRIMP && s.location[0] > 3200)), skills: ['FISHING'] },
        // port: Karamja's lobsters, by the boat from Port Sarim (a sailor's dialogue, 30 coins, the gangplank; upstream
        // teleported across): fishing XP is only had over there
        { name: 'fishing (lobsters on Karamja, by boat)', kind: 'Fish', members: false, levels: { FISHING: 40 }, inv: [[Items.LOBSTER_POT, 1], [Items.COINS, 200]], make: () => new FishingTask(step('FISHING', s => s.location[0] === 2924 && s.itemGained === Items.RAW_LOBSTER)), skills: ['FISHING'] },
        // ... with its coins in the bank: it fetches the fare first (upstream teleported; without it, the fallback jump)
        { name: 'fishing (lobsters on Karamja, the fare from the bank)', kind: 'Fish', members: false, levels: { FISHING: 40 }, inv: [[Items.LOBSTER_POT, 1]], bank: [[Items.COINS, 200]], make: () => new FishingTask(step('FISHING', s => s.location[0] === 2924 && s.itemGained === Items.RAW_LOBSTER)), skills: ['FISHING'] },
        // ... from Draynor's bank with plenty there: on the way across, the half paid to the sailor, the fare there and
        // back is short until it lands (realism phase 5a: the check did not wait for the crossing, and the bot turned
        // back at Karamja's dock for the bank, 60 coins a lap, until its bank could no longer pay: 200 coins lasted 2 laps)
        { name: 'fishing (lobsters on Karamja, a rich bank at Draynor)', kind: 'Fish', members: false, levels: { FISHING: 40 }, inv: [[Items.LOBSTER_POT, 1]], bank: [[Items.COINS, 5000]], setup: p => p.teleJump(...Locations.DRAYNOR_BANK), make: () => new FishingTask(step('FISHING', s => s.location[0] === 2924 && s.itemGained === Items.RAW_LOBSTER)), skills: ['FISHING'] },
        // Kandarin's willows (members), banked at Seers' and at Catherby's bank (started at the bank: the walk there is
        // the planner's)
        { name: 'woodcutting (willows, Seers)', kind: 'Woodcut', members: true, levels: { WOODCUTTING: 30 }, inv: [[Items.BRONZE_AXE, 1]], setup: p => p.teleJump(...Locations.SEERS_BANK), make: () => new WoodcuttingTask(step('WOODCUTTING', s => s.location === Locations.WILLOWS_SEERS)), progress: (p, start) => bankGained(p, start, Items.WILLOW_LOGS) > 0 },
        { name: 'woodcutting (willows, Catherby)', kind: 'Woodcut', members: true, levels: { WOODCUTTING: 30 }, inv: [[Items.BRONZE_AXE, 1]], setup: p => p.teleJump(...Locations.CATHERBY_BANK), make: () => new WoodcuttingTask(step('WOODCUTTING', s => s.location === Locations.WILLOWS_CATHERBY)), progress: (p, start) => bankGained(p, start, Items.WILLOW_LOGS) > 0 },
        // Catherby's cage/harpoon spots (members), banked at Catherby: tuna (35), lobsters walked to from Lumbridge, swordfish
        { name: 'fishing (tuna, Catherby)', kind: 'Fish', members: true, levels: { FISHING: 35 }, inv: [[Items.HARPOON, 1]], setup: p => p.teleJump(...Locations.CATHERBY_BANK), make: () => new FishingTask(step('FISHING', s => s.location === Locations.FISH_CATHERBY && s.itemGained === Items.RAW_TUNA)), progress: (p, start) => bankGained(p, start, Items.RAW_TUNA) > 0 },
        { name: 'fishing (lobsters, Catherby, from Lumbridge)', kind: 'Fish', members: true, levels: { FISHING: 40 }, inv: [[Items.LOBSTER_POT, 1]], make: () => new FishingTask(step('FISHING', s => s.location === Locations.FISH_CATHERBY && s.itemGained === Items.RAW_LOBSTER)), progress: (p, start) => bankGained(p, start, Items.RAW_LOBSTER) > 0 },
        { name: 'fishing (swordfish, Catherby)', kind: 'Fish', members: true, levels: { FISHING: 50 }, inv: [[Items.HARPOON, 1]], setup: p => p.teleJump(...Locations.CATHERBY_BANK), make: () => new FishingTask(step('FISHING', s => s.location === Locations.FISH_CATHERBY && s.itemGained === Items.RAW_SWORDFISH)), skills: ['FISHING'] },
        // the planner: Fishing 45 with only a net buys its lobster pot at Gerrant's (upstream: not a nearby shop)
        { name: 'planner: fisher of 45 buys a lobster pot', kind: 'ShopTrip', members: false, levels: { FISHING: 45 }, inv: [[Items.SMALL_FISHING_NET, 1], [Items.COINS, 300]], plan: { FISHING: 1 }, progress: (p, start) => gained(p, start, Items.LOBSTER_POT) > 0 || gained(p, start, Items.HARPOON) > 0 || gained(p, start, Items.FLY_FISHING_ROD) > 0 },
        // the planner: Mining and Smithing 40 without gold bars no longer hands every pick to flax and ring moulds
        // (Crafting's weight is there to open the ring priority, which must not claim the bot; a weighted pick of it
        // could take the whole run, a plan being 15-60 minutes: it was 3 in 48, and one run in a few crafted throughout)
        { name: 'planner: Mining and Smithing 40 keep their variety', kind: '*', members: false, levels: { MINING: 40, SMITHING: 40, CRAFTING: 20, WOODCUTTING: 30 }, inv: [[Items.SHEARS, 1], [Items.BRONZE_PICKAXE, 1], [Items.BRONZE_AXE, 1], [Items.COINS, 300]], plan: { CRAFTING: 0.01, MINING: 15, WOODCUTTING: 15, SMITHING: 15 }, bot: unthemed, skills: ['MINING', 'WOODCUTTING', 'SMITHING'] },
        // port: earned gear (port/BotGear): a fighter with coins buys the best piece its levels allow from the shop that
        // sells it, through the shop's interface (Zeke's in Al Kharid; Horvik's in Varrock), then fights
        { name: 'earned gear: a fighter buys the scimitar its Attack allows (Zeke)', kind: '*', members: false, bot: meleeScimitar, levels: { ATTACK: 10, STRENGTH: 10, DEFENCE: 1, HITPOINTS: 15 }, inv: [[Items.BRONZE_SCIMITAR, 1]], bank: [[Items.COINS, 1500]], plan: { ATTACK: 1, STRENGTH: 1 }, progress: (p, start) => ownsAnywhere(p, Items.STEEL_SCIMITAR) && !start.inv.has(Items.STEEL_SCIMITAR) },
        // (the best it can pay for: steel at Defence 5 when it has the coins, else iron)
        // (the realism work, phase 4: a bot buys the kind of piece its taste likes: these bots like plate and full helms)
        // (the integration of phase 4: the platebody its only want, legs worn, no helm or shield to its taste: with the
        // name's taste it bought legs, a helm and a shield first in a 58-bot world, 6 trips, and no platebody in 2,500
        // ticks; and bronze counts: Horvik holds one iron and one steel platebody, another fighter of the run may buy them,
        // and a sold-out piece is passed over for an hour)
        { name: 'earned gear: a fighter buys a platebody (Horvik)', kind: '*', members: false, bot: meleeScimitar, levels: { ATTACK: 1, STRENGTH: 10, DEFENCE: 5, HITPOINTS: 15 }, worn: [Items.IRON_SCIMITAR, Items.STEEL_PLATELEGS], bank: [[Items.COINS, 1500]], setup: likes({ body: 'plate', helm: 'none', legs: 'platelegs', shield: 'none', cape: false, ownCape: false, gloves: false, boots: false }), plan: { STRENGTH: 1, DEFENCE: 1 }, progress: p => [Items.STEEL_PLATEBODY, Items.IRON_PLATEBODY, Items.BRONZE_PLATEBODY].some(id => ownsAnywhere(p, id)) },
        // Peksa stands behind her counter in a shop with a door: a full helm (body and legs owned already; bronze when
        // the other fighters of the run have bought her three iron ones: a bought-out piece is passed over for an hour)
        { name: 'earned gear: a fighter buys a full helm (Peksa)', kind: '*', members: false, bot: meleeScimitar, levels: { ATTACK: 1, STRENGTH: 10, DEFENCE: 1, HITPOINTS: 15 }, worn: [Items.IRON_SCIMITAR, Items.IRON_PLATEBODY, Items.IRON_PLATELEGS, Items.BRONZE_KITESHIELD], bank: [[Items.COINS, 600]], setup: likes({ helm: 'full' }), plan: { STRENGTH: 1, DEFENCE: 1 }, progress: p => [Items.IRON_FULL_HELM, Items.BRONZE_FULL_HELM].some(id => ownsAnywhere(p, id)) },
        // ── the realism work, phase 4 (patchwork gear, port/BotGear): the other kinds and the accessories, from 274's shops ──
        // a black chainbody only Wayne has (Falador; Horvik's chainbodies stop at mithril and have no black)
        { name: 'earned gear: a fighter buys a black chainbody (Wayne)', kind: '*', members: false, bot: meleeScimitar, levels: { ATTACK: 1, STRENGTH: 15, DEFENCE: 10, HITPOINTS: 18 }, worn: [Items.IRON_SCIMITAR], bank: [[Items.COINS, 3000]], setup: likes({ body: 'chain' }), plan: { STRENGTH: 1, DEFENCE: 1 }, progress: p => [Items.BLACK_CHAINBODY, Items.STEEL_CHAINBODY, Items.IRON_CHAINBODY].some(id => ownsAnywhere(p, id)) },
        // an iron square shield (Cassie, Falador: her kiteshields stop at bronze), its body, legs and helm owned
        { name: 'earned gear: a fighter buys a square shield (Cassie)', kind: '*', members: false, bot: meleeScimitar, levels: { ATTACK: 1, STRENGTH: 10, DEFENCE: 1, HITPOINTS: 15 }, worn: [Items.IRON_SCIMITAR, Items.IRON_PLATEBODY, Items.IRON_PLATELEGS, Items.IRON_MED_HELM], bank: [[Items.COINS, 800]], setup: likes({ helm: 'med', shield: 'sq' }), plan: { STRENGTH: 1, DEFENCE: 1 }, progress: p => [Items.IRON_SQ_SHIELD, Items.BRONZE_SQ_SHIELD].some(id => ownsAnywhere(p, id)) },
        // a plateskirt from Ranael (Al Kharid, past the toll gate), its body owned
        { name: 'earned gear: a fighter buys a plateskirt (Ranael)', kind: '*', members: false, bot: meleeScimitar, levels: { ATTACK: 1, STRENGTH: 10, DEFENCE: 1, HITPOINTS: 15 }, worn: [Items.IRON_SCIMITAR, Items.IRON_PLATEBODY], bank: [[Items.COINS, 1500]], setup: likes({ legs: 'skirt' }), plan: { STRENGTH: 1, DEFENCE: 1 }, progress: p => [Items.IRON_PLATESKIRT, Items.BRONZE_PLATESKIRT].some(id => ownsAnywhere(p, id)) },
        // a red cape from Thessalia (Varrock), every piece it likes owned: combat 16, its Defence's best metal worn
        { name: 'earned gear: a fighter buys a cape (Thessalia)', kind: '*', members: false, bot: meleeScimitar, levels: { ATTACK: 1, STRENGTH: 30, DEFENCE: 1, HITPOINTS: 25 }, worn: [Items.IRON_SCIMITAR, Items.IRON_PLATEBODY, Items.IRON_PLATELEGS], bank: [[Items.COINS, 500]], setup: likes({ helm: 'none', body: 'plate', legs: 'platelegs', shield: 'none', cape: true, ownCape: true, gloves: false, boots: false }), plan: { STRENGTH: 1, DEFENCE: 1 }, progress: p => ownsAnywhere(p, RED_CAPE) },
        // the ice giants of the Asgarnian ice dungeon (down the Mudskipper Point ladder), for melee, ranged and magic
        { name: 'combat (ice giants, ice dungeon)', kind: 'Combat', members: false, levels: { ATTACK: 50, STRENGTH: 50, DEFENCE: 50, HITPOINTS: 50 }, worn: [Items.RUNE_SCIMITAR], inv: [[Items.SWORDFISH, 10]], make: () => new CombatTask(step('ATTACK', s => s.location === Locations.ICE_GIANTS_ICE_DUNGEON), PlayerStat.ATTACK), skills: ['ATTACK', 'STRENGTH', 'DEFENCE', 'HITPOINTS'] },
        { name: 'ranged (ice giants, ice dungeon)', kind: 'RangedMagic', members: false, levels: { RANGED: 50, DEFENCE: 40, HITPOINTS: 50 }, inv: [[Items.OAK_SHORTBOW, 1], [Items.IRON_ARROW, 500], [Items.SWORDFISH, 10]], make: () => new RangedMagicTask(step('RANGED', s => s.location === Locations.ICE_GIANTS_ICE_DUNGEON), PlayerStat.RANGED), skills: ['RANGED'] },
        { name: 'magic (ice giants, ice dungeon)', kind: 'RangedMagic', members: false, levels: { MAGIC: 50, DEFENCE: 40, HITPOINTS: 50 }, inv: [[Items.STAFF_OF_AIR, 1], [Items.MIND_RUNE, 500], [Items.SWORDFISH, 10]], make: () => new RangedMagicTask(step('MAGIC', s => s.location === Locations.ICE_GIANTS_ICE_DUNGEON), PlayerStat.MAGIC), skills: ['MAGIC'] },
        // the Cosmic altar (members): the dramen staff (in the bank from the login: UtilTasks.keepQuestItems) worn
        // through the Lumbridge swamp shed's door to Zanaris, the ruins, the altar, the portal, out by the ladder
        { name: 'runecrafting (cosmic runes, Zanaris)', kind: 'Runecrafting', members: true, levels: { RUNECRAFT: 27 }, inv: [[Items.COSMIC_TALISMAN, 1], [Items.BRONZE_PICKAXE, 1]], make: () => new RunecraftingTask(), skills: ['RUNECRAFT'] },
        // the planner: a fighter whose weapon is worn (Attack 40) fights where its level suits, not with the chickens
        { name: 'planner: a level-40 fighter with a worn scimitar fights', kind: 'Combat', members: false, levels: { ATTACK: 40, STRENGTH: 40, DEFENCE: 40, HITPOINTS: 40 }, worn: [Items.MITHRIL_SCIMITAR], bank: [[Items.SWORDFISH, 30]], plan: { ATTACK: 1, STRENGTH: 1, DEFENCE: 1 }, skills: ['ATTACK', 'STRENGTH', 'DEFENCE', 'HITPOINTS'] },
        // ── the realism work, phase 3 (2004 combat crowds, "2004 hotspots"): each crowd spot's fighters fight
        // there (the planner sends them by level band and crowd weight: BotKnowledge's crowd and levelBand)
        { name: 'combat (goblins, Lumbridge)', kind: 'Combat', members: false, levels: { ATTACK: 5, STRENGTH: 5, DEFENCE: 5, HITPOINTS: 12 }, inv: [[Items.BRONZE_SWORD, 1]], make: () => new CombatTask(step('ATTACK', s => s.location === Locations.GOBLINS_LUMBRIDGE), PlayerStat.ATTACK), skills: ['ATTACK', 'STRENGTH', 'DEFENCE', 'HITPOINTS'] },
        { name: 'combat (cows, Lumbridge)', kind: 'Combat', members: false, levels: { ATTACK: 12, STRENGTH: 12, DEFENCE: 10, HITPOINTS: 15 }, worn: [Items.IRON_SCIMITAR], make: () => new CombatTask(step('ATTACK', s => s.location === Locations.COWS_LUMBRIDGE), PlayerStat.STRENGTH), skills: ['ATTACK', 'STRENGTH', 'DEFENCE', 'HITPOINTS'] },
        { name: 'combat (barbarians, Barbarian Village)', kind: 'Combat', members: false, levels: { ATTACK: 20, STRENGTH: 20, DEFENCE: 20, HITPOINTS: 22 }, worn: [Items.IRON_SCIMITAR], inv: [[Items.SWORDFISH, 5]], make: () => new CombatTask(step('ATTACK', s => s.location === Locations.BARBARIANS_VILLAGE), PlayerStat.ATTACK), skills: ['ATTACK', 'STRENGTH', 'DEFENCE', 'HITPOINTS'] },
        { name: 'combat (Varrock guards)', kind: 'Combat', members: false, levels: { ATTACK: 28, STRENGTH: 28, DEFENCE: 25, HITPOINTS: 30 }, worn: [Items.STEEL_SCIMITAR], inv: [[Items.SWORDFISH, 8]], make: () => new CombatTask(step('ATTACK', s => s.location === Locations.GUARDS_VARROCK_SOUTH), PlayerStat.DEFENCE), skills: ['ATTACK', 'STRENGTH', 'DEFENCE', 'HITPOINTS'] },
        { name: 'combat (hill giants, Edgeville dungeon)', kind: 'Combat', members: false, levels: { ATTACK: 40, STRENGTH: 40, DEFENCE: 40, HITPOINTS: 42 }, worn: [Items.MITHRIL_SCIMITAR], inv: [[Items.SWORDFISH, 10]], make: () => new CombatTask(step('ATTACK', s => s.location === Locations.HILL_GIANTS_EDGEVILLE), PlayerStat.STRENGTH), skills: ['ATTACK', 'STRENGTH', 'DEFENCE', 'HITPOINTS'] },
        // (members: Kandarin's moss giants, from the Ardougne north bank)
        { name: 'combat (moss giants, Kandarin)', kind: 'Combat', members: true, levels: { ATTACK: 45, STRENGTH: 45, DEFENCE: 45, HITPOINTS: 48 }, worn: [Items.RUNE_SCIMITAR], inv: [[Items.SWORDFISH, 10]], setup: p => p.teleJump(...Locations.ARDOUGNE_NORTH_BANK), make: () => new CombatTask(step('ATTACK', s => s.location === Locations.MOSS_GIANTS_WEST), PlayerStat.ATTACK), skills: ['ATTACK', 'STRENGTH', 'DEFENCE', 'HITPOINTS'] },
        // (the Al Kharid mine's iron, a 2004 iron mine: walked to from the north, banked at Varrock East)
        { name: 'mining (iron, Al Kharid mine)', kind: 'Mine', members: false, levels: { MINING: 20 }, inv: [[Items.STEEL_PICKAXE, 1]], make: () => new MiningTask(step('MINING', s => s.location === Locations.MINE_AL_KHARID_IRON)), skills: ['MINING'] },
        // the planner: a level-12 fighter goes to the 2004 crowd spots of its band (chickens and goblins to 15, cows to 25,
        // barbarians from 10), and fights
        { name: 'planner: a level-12 fighter fights at a 2004 crowd spot', kind: 'Combat', members: false, levels: { ATTACK: 12, STRENGTH: 12, DEFENCE: 12, HITPOINTS: 15 }, worn: [Items.IRON_SCIMITAR], plan: { ATTACK: 1, STRENGTH: 1, DEFENCE: 1 }, skills: ['ATTACK', 'STRENGTH', 'DEFENCE', 'HITPOINTS'] },
        { name: 'PKer (deep wilderness)', kind: 'PKer', members: false, make: () => new PKerTask(), progress: p => wildernessLevelAt(p.x, p.z) >= 10 },
        { name: 'Edgeville PKer', kind: 'EdgevillePKer', members: false, make: () => new EdgevillePKerTask(), progress: p => wildernessLevelAt(p.x, p.z) >= 1 }
    ];
    return cases;
}

/** Puts these items on (into their worn slot, past the wear script). */
export function wearItems(player: Player, items: number[] | undefined): void {
    const worn = player.getInventory(InvType.WORN);
    if (!items || !worn) return;
    for (const id of items) {
        const pos = ObjType.get(id).wearpos;
        if (pos >= 0) worn.set(pos, { id, count: 1 });
    }
}

/** A planner with only these skill weights (the coverage case's `plan`), its InitTask done. */
export function casePlanner(weights: Partial<Record<string, number>>): BotGoalPlanner {
    const planner = new BotGoalPlanner({ name: 'coverage', weights });
    planner.skipInit();
    return planner;
}

export function giveItems(player: Player, items: [number, number][] | undefined, bank: boolean): void {
    if (!items) return;
    const inv = player.getInventory(bank ? bankInvId() : InvType.INV);
    if (!inv) return;
    for (const [id, count] of items) inv.add(id, count);
}
