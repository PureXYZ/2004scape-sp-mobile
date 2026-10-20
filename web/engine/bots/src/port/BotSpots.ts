// port (the variety work, round 1, Track D: WHERE-2, spot capacity and live occupancy): how many bots a spot holds and
// how many are there now, so that a pick sends a bot to a spot with room (BotKnowledge pickNear: its weight times
// max(MIN_WEIGHT, 1 - occupants / capacity)) and a busy one sends it to a neighbour of the same tier (Draynor's willows
// to Lumbridge's river, Draynor west, Rimmington or Port Sarim). The research:
// a quarter of the busy bots stood on a step with 4+ others at 100 online, three quarters at 500 (Lumbridge's trees 31
// at once, Falador's furnace 21); pickNear weighed only distance and phase 3's crowds.
//
//   spot       a step's place and what it works there (spotKey): a grove's trees of one kind, a mine's rocks of one ore,
//              a shore's fishing spots of one kind, a fighting area (every combat style alike), a pickpocket's marks, a
//              stall; anything else by its action and place (a fire lane, a range, a furnace, a course)
//   capacity   from the 274 map, once per spot and cached (spotCapacity): its trees, rocks, fishing spots or NPC spawns
//              within the radius its task searches, each holding what a 2004 player shared (a willow or a yew 2 cutters,
//              a rock 1 miner, a fishing spot 3, a monster half a fighter, a mark 1 thief, a stall 2); the rest a fixed
//              number by kind (DEFAULT_CAPACITY)
//   occupants  the bots whose task works the spot now (counted once a tick, when a pick asks: every bot online's task's
//              step; a fletcher's while it chops its logs; a task switched to later in the tick moves its bot's count,
//              noteTaskSwitch), the picking bot left out (setPicker: its own spot's count less one)
//
// Reads the world only (zones, NPC list, the bots' tasks); no dice. Loaded by the planner (BotGoalPlanner imports it),
// which sets BotKnowledge's hook here.
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import LocType from '#/cache/config/LocType.js';
import NpcType from '#/cache/config/NpcType.js';
import { Items, setSpotWeight, type SkillStep } from '#/engine/bot/BotKnowledge.js';

/** the least weight a full spot keeps (a pick can still land on it when nothing else is near) */
export const MIN_WEIGHT = 0.05;
/**
 * the most bots a pick counts on a spot's room (however many trees or monsters it has): 2004's spots had a few players
 * each, the next ones went on to the next spot of the tier (the research's measure: 4+ others on a spot, at most 10 % of
 * the bots at 100 online; Lumbridge's 22 trees otherwise took 20 cutters before they weighed less than its neighbours)
 */
export const COMFORT = 5;

/** the trees of a woodcutting step (274 debugname prefixes, as WoodcuttingTask's) */
const TREE_PREFIX: Readonly<Record<number, string>> = {
    [Items.LOGS]: 'tree',
    [Items.OAK_LOGS]: 'oaktree',
    [Items.WILLOW_LOGS]: 'willowtree',
    [Items.MAPLE_LOGS]: 'mapletree',
    [Items.YEW_LOGS]: 'yewtree',
    [Items.MAGIC_LOGS]: 'magictree'
};
/** how many cutters a tree holds (a normal tree falls at its first log; the others take turns of many logs) */
const PER_TREE: Readonly<Record<string, number>> = { tree: 1, oaktree: 1.5, willowtree: 2, mapletree: 2, yewtree: 2, magictree: 2 };

/** the rocks of a mining step's ore (274 debugname prefixes, as MiningTask's ORE_ROCKS) */
const ORE_ROCK: Readonly<Record<number, string>> = {
    [Items.COPPER_ORE]: 'copperrock',
    [Items.TIN_ORE]: 'tinrock',
    [Items.IRON_ORE]: 'ironrock',
    [Items.COAL]: 'coalrock',
    [Items.GOLD_ORE]: 'goldrock',
    [Items.MITHRIL_ORE]: 'mithrilrock',
    [Items.ADAMANTITE_ORE]: 'adamantiterock',
    [Items.RUNITE_ORE]: 'runiterock',
    [Items.CLAY]: 'clayrock'
};

/** a spot without a count from the map: what its action holds */
const DEFAULT_CAPACITY: Readonly<Record<string, number>> = { firemaking: 6, cook: 3, smelt: 4, smith: 3, agility: 8, fletch: 6, craft: 6, runecraft: 12, essence: 8 };

/** the radius (tiles) a task searches its spot within, by kind: what its capacity counts */
const RADIUS = { tree: 15, rock: 15, fish: 20, fight: 22, pocket: 18, stall: 15 };

// ── what a spot is ─────────────────────────────────────────────────────────────────────────────────────────────────

/** the suffix of a fishing step's spots (as FishingTask._findFishSpot) */
function fishSuffix(step: SkillStep): string {
    const g = step.itemGained;
    if (g === Items.RAW_SHARK) return '_memberfish';
    if (g === Items.RAW_LOBSTER || g === Items.RAW_SWORDFISH || g === Items.RAW_TUNA) return '_rarefish';
    if (g === Items.RAW_TROUT || g === Items.RAW_SALMON) return '_freshfish';
    return '_saltfish';
}

/** the monsters (or marks) a step works: its extra's names */
function npcNames(step: SkillStep): string[] {
    const extra = step.extra as { npcType?: unknown; npcTypes?: unknown; npcName?: unknown } | undefined;
    const out: string[] = [];
    if (Array.isArray(extra?.npcTypes)) for (const n of extra.npcTypes) if (typeof n === 'string') out.push(n);
    if (typeof extra?.npcType === 'string') out.push(extra.npcType);
    if (typeof extra?.npcName === 'string') out.push(extra.npcName);
    return out;
}

/** A step's spot: what it works there and where (steps of every combat style at one place are one spot). */
export function spotKey(step: SkillStep): string {
    const [x, z, level] = step.location;
    const at = `@${x},${z},${level}`;
    switch (step.action) {
        case 'woodcut':
            return `tree:${TREE_PREFIX[step.itemGained ?? Items.LOGS] ?? 'tree'}${at}`;
        case 'mine':
            return `rock:${ORE_ROCK[step.itemGained ?? -1] ?? 'rock'}${at}`;
        case 'fish':
            return `fish:${fishSuffix(step)}${at}`;
        case 'combat':
        case 'ranged':
        case 'magic':
            return `fight${at}`;
        case 'thieve':
            return `pocket:${npcNames(step)[0] ?? 'man'}${at}`;
        case 'thieve_stall':
            return `stall:${String((step.extra as { locName?: unknown } | undefined)?.locName ?? '')}${at}`;
        default:
            return `${actionKind(step.action)}${at}`;
    }
}

function actionKind(action: string | undefined): string {
    // (the fixes: a step-like object without an action, a test's stand-in task's place, crashed the count: the full
    // suite's "reading 'startsWith'" in a Fletching bot's pick; stepOfTask leaves such a step out, and this reads it safely)
    if (typeof action !== 'string') return 'none';
    if (action.startsWith('fletch_') || action.startsWith('string_')) return 'fletch';
    if (action.startsWith('craft_') || action.startsWith('cut_') || action === 'spin_flax' || action === 'pick_flax') return 'craft';
    return action;
}

// ── capacity (from the map, once a spot) ───────────────────────────────────────────────────────────────────────────

const capacities = new Map<string, number>();

/** How many bots the step's spot holds (at least 1): from the map the first time, then cached. */
export function spotCapacity(step: SkillStep): number {
    const key = spotKey(step);
    let c = capacities.get(key);
    if (c === undefined) {
        c = Math.max(1, Math.round(measure(step) * 10) / 10);
        capacities.set(key, c);
    }
    return c;
}

/** (tests) what a spot's count from the map found, before the floor of 1: 0 means nothing of its kind in reach */
export function measuredCapacity(step: SkillStep): number {
    return measure(step);
}

function measure(step: SkillStep): number {
    const [x, z, level] = step.location;
    switch (step.action) {
        case 'woodcut': {
            const prefix = TREE_PREFIX[step.itemGained ?? Items.LOGS] ?? 'tree';
            // (the trees of its kind that can be chopped: 274's 'tree' prefix also names walls, doors and stumps)
            return countLocs(x, z, level, RADIUS.tree, name => name.startsWith(prefix) && !name.includes('stump'), op => op === 'chop down') * (PER_TREE[prefix] ?? 1);
        }
        case 'mine': {
            const prefix = ORE_ROCK[step.itemGained ?? -1];
            return prefix ? countLocs(x, z, level, RADIUS.rock, name => name.startsWith(prefix)) : DEFAULT_CAPACITY.craft;
        }
        case 'fish': {
            const suffix = fishSuffix(step);
            return countNpcs(x, z, level, RADIUS.fish, name => name.endsWith(suffix)) * 3;
        }
        case 'combat':
        case 'ranged':
        case 'magic': {
            const names = npcNames(step);
            return countNpcs(x, z, level, RADIUS.fight, name => names.some(n => name === n || name.startsWith(n))) * 0.5;
        }
        case 'thieve': {
            const names = npcNames(step);
            const want = names.length > 0 ? names : ['man'];
            return countNpcs(x, z, level, RADIUS.pocket, name => want.some(n => name === n || name.startsWith(n)));
        }
        case 'thieve_stall': {
            const locName = String((step.extra as { locName?: unknown } | undefined)?.locName ?? '');
            return countLocs(x, z, level, RADIUS.stall, name => name === locName) * (locName.startsWith('chest') ? 1 : 2);
        }
        default:
            return DEFAULT_CAPACITY[actionKind(step.action)] ?? 4;
    }
}

/** Locs within `radius` (Chebyshev) of (x, z) whose debugname passes `named` (and whose first op passes `op`, if given). */
function countLocs(x: number, z: number, level: number, radius: number, named: (name: string) => boolean, op?: (op: string) => boolean): number {
    let n = 0;
    const seen = new Set<number>();
    for (let zx = (x - radius) & ~7; zx <= x + radius; zx += 8) {
        for (let zz = (z - radius) & ~7; zz <= z + radius; zz += 8) {
            const zone = World.gameMap.getZone(zx, zz, level);
            if (!zone) continue;
            for (const loc of zone.getAllLocsSafe()) {
                if (Math.max(Math.abs(loc.x - x), Math.abs(loc.z - z)) > radius) continue;
                const key = (loc.x << 14) | loc.z;
                if (seen.has(key)) continue;
                const type = LocType.get(loc.type);
                const name = type.debugname ?? '';
                if (!named(name)) continue;
                if (op && !op(String(type.op?.[0] ?? '').toLowerCase())) continue;
                seen.add(key);
                n++;
            }
        }
    }
    return n;
}

/** NPCs whose spawn lies within `radius` (Chebyshev) of (x, z) on the level and whose debugname passes `named`. */
function countNpcs(x: number, z: number, level: number, radius: number, named: (name: string) => boolean): number {
    let n = 0;
    for (const npc of World.npcs) {
        if (!npc || npc.level !== level) continue;
        if (Math.max(Math.abs(npc.startX - x), Math.abs(npc.startZ - z)) > radius) continue;
        if (named(NpcType.get(npc.type).debugname ?? '')) n++;
    }
    return n;
}

// ── occupants (the bots there now) ─────────────────────────────────────────────────────────────────────────────────

/** the task a bot runs and its step (a fletcher's chopping step while it chops), as the occupancy reads it */
type Tasked = { name?: string; activityStep?: () => SkillStep | null; wcStep?: SkillStep | null; state?: string };

/** The spot a task works now (null: none): its step's; a fletcher's woodcutting step while it chops its logs. */
export function stepOfTask(task: Tasked | null | undefined): SkillStep | null {
    if (!task) return null;
    let step: SkillStep | null;
    if (task.name === 'Fletching') step = task.wcStep ?? null;
    else {
        try {
            step = task.activityStep?.() ?? null;
        } catch {
            return null;
        }
    }
    // (the fixes: a step with no action is no spot: test/fixes.test.mjs's stand-in tasks' place, { location } only)
    return step && typeof step.action === 'string' ? step : null;
}

const counts = new Map<string, number>();
/** each bot's spot in this tick's count (the picker's own is left out of its pick) */
const spotOfBot = new Map<Player, string>();
let countedAt = -1;
/** the bot picking now (BotGoalPlanner.pickTask): it is not one of the spot's occupants */
let picker: Player | null = null;

/** The planner's pick is for this bot (null when it is done): the occupancy leaves it out. */
export function setPicker(player: Player | null): void {
    picker = player;
}

/**
 * Every bot's spot, once a tick. (The fixes, the reviewer's: counted again for each bot that picked in a tick, it read
 * every bot's task and its spot's key for each, 500 x 500 at a 500-bot fill; now once, the picker's own spot less one,
 * and a switch later in the tick moves its bot's count: noteTaskSwitch)
 */
function recount(): void {
    counts.clear();
    spotOfBot.clear();
    countedAt = World.currentTick;
    for (const p of World.playerLoop.all()) {
        if (p.is_bot !== true) continue;
        const ai = (p as unknown as { _bot?: { currentTask?: Tasked | null } })._bot;
        const step = stepOfTask(ai?.currentTask);
        if (!step) continue;
        const key = spotKey(step);
        spotOfBot.set(p, key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
}

/** The bots working the step's spot now (the picking bot left out). */
export function spotOccupants(step: SkillStep): number {
    if (countedAt !== World.currentTick) recount();
    const key = spotKey(step);
    const n = counts.get(key) ?? 0;
    return picker !== null && spotOfBot.get(picker) === key ? n - 1 : n;
}

/**
 * The bot switched to `task` (BotPlayer): this tick's count follows, so a bot that picks later in the tick sees it (as
 * the count again for each pick did). Before a count this tick, nothing: the tick's count reads the tasks then.
 */
export function noteTaskSwitch(player: Player, task: Tasked | null): void {
    if (countedAt !== World.currentTick) return;
    const was = spotOfBot.get(player);
    if (was !== undefined) {
        counts.set(was, (counts.get(was) ?? 1) - 1);
        spotOfBot.delete(player);
    }
    const step = stepOfTask(task);
    if (!step) return;
    const key = spotKey(step);
    spotOfBot.set(player, key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * The weight a pick gives the step for how full its spot is: max(MIN_WEIGHT, 1 - occupants / room), the room
 * min(capacity, COMFORT) times a 2004 crowd spot's crowd over CROWD_ROOM (phase 3's crowd weights: the hill giants,
 * Lumbridge's goblins and cows, the barbarians were crowded in 2004, and a pick that thinned them sent their fighters to
 * quiet spots: C15 fell under half)
 */
export function spotRoom(step: SkillStep): number {
    const crowd = Math.max(1, (step.crowd ?? 1) / CROWD_ROOM);
    return Math.max(MIN_WEIGHT, 1 - spotOccupants(step) / (Math.min(spotCapacity(step), COMFORT) * crowd));
}

/** a crowd spot's room grows by its crowd over this (crowd 3: twice the room) */
export const CROWD_ROOM = 1.5;

/** (tests) the counts and capacities forgotten (a new world) */
export function resetSpotsForTest(): void {
    capacities.clear();
    counts.clear();
    spotOfBot.clear();
    countedAt = -1;
    picker = null;
}

setSpotWeight(spotRoom);
