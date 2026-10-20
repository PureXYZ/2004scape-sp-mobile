// port: what a bot says it is doing (Phase 3: livelier chat, answers from the bot's own state). From
// its task and the step the task works at: "Cutting willows in Draynor", "Killing cows near Lumbridge", "Fishing lobbies
// on Karamja". Upstream answered "what are you doing" with "Just chilling, you?" or "Doing some skills atm", whatever the
// bot did.
import NpcType from '#/cache/config/NpcType.js';
import type Player from '#/engine/entity/Player.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { Items, type SkillStep } from '#/engine/bot/BotKnowledge.js';
import { placePhrase } from '#/engine/bot/port/BotPlaces.js';

const TREES = new Map<number, string>([
    [Items.LOGS, 'trees'],
    [Items.OAK_LOGS, 'oaks'],
    [Items.WILLOW_LOGS, 'willows'],
    [Items.MAPLE_LOGS, 'maples'],
    [Items.YEW_LOGS, 'yews'],
    [Items.MAGIC_LOGS, 'magics']
]);

const FISH = new Map<number, string>([
    [Items.RAW_SHRIMP, 'shrimps'],
    [Items.RAW_ANCHOVIES, 'anchovies'],
    [Items.RAW_SARDINE, 'sardines'],
    [Items.RAW_HERRING, 'herring'],
    [Items.RAW_TROUT, 'trout'],
    [Items.RAW_SALMON, 'salmon'],
    [Items.RAW_PIKE, 'pike'],
    [Items.RAW_TUNA, 'tuna'],
    [Items.RAW_LOBSTER, 'lobbies'],
    [Items.RAW_SWORDFISH, 'swordies'],
    [Items.RAW_SHARK, 'sharks']
]);

const ORES = new Map<number, string>([
    [Items.COPPER_ORE, 'copper'],
    [Items.TIN_ORE, 'tin'],
    [Items.IRON_ORE, 'iron'],
    [Items.COAL, 'coal'],
    [Items.SILVER_ORE, 'silver'],
    [Items.GOLD_ORE, 'gold'],
    [Items.MITHRIL_ORE, 'mith'],
    [Items.ADAMANTITE_ORE, 'addy'],
    [Items.RUNITE_ORE, 'rune'],
    [Items.CLAY, 'clay'],
    [Items.RUNE_ESSENCE, 'ess']
]);

const COOKED = new Map<number, string>([
    [Items.SHRIMP, 'shrimps'],
    [Items.SARDINE, 'sardines'],
    [Items.HERRING, 'herring'],
    [Items.TROUT, 'trout'],
    [Items.SALMON, 'salmon'],
    [Items.LOBSTER, 'lobbies'],
    [Items.SWORDFISH, 'swordies'],
    [Items.SHARK, 'sharks'],
    [Items.COOKED_MEAT, 'meat'],
    [Items.COOKED_CHICKEN, 'chicken']
]);

/** the monsters of a combat or pickpocketing step, as a player names them ("cows", "men", "al-kharid warriors") */
function monsters(step: SkillStep): string | null {
    const extra = step.extra as { npcType?: unknown; npcTypes?: unknown } | undefined;
    const name = typeof extra?.npcType === 'string' ? extra.npcType : Array.isArray(extra?.npcTypes) && typeof extra.npcTypes[0] === 'string' ? extra.npcTypes[0] : null;
    if (!name) return null;
    const id = NpcType.getId(name);
    const shown = (id === -1 ? name : NpcType.get(id).name ?? name).toLowerCase();
    if (shown === 'man') return 'men';
    if (shown.endsWith('y')) return `${shown.slice(0, -1)}ies`;
    return `${shown}s`;
}

/** what a task of this kind does at this step, in a few words, or null (a chat at the bank, the start) */
export function activityFor(kind: string, step: SkillStep | null): string | null {
    switch (kind) {
        case 'Woodcut':
            return `Cutting ${(step && TREES.get(step.itemGained ?? -1)) ?? 'trees'}`;
        case 'Fletching':
            return 'Fletching';
        case 'BowStringing':
            return 'Stringing bows';
        case 'Fish': {
            const fish = step && FISH.get(step.itemGained ?? -1);
            return fish ? `Fishing ${fish}` : 'Fishing';
        }
        case 'Mine': {
            const ore = step && ORES.get(step.itemGained ?? -1);
            return ore ? `Mining ${ore}` : 'Mining';
        }
        case 'Cook': {
            const food = step && COOKED.get(step.itemGained ?? -1);
            return food ? `Cooking ${food}` : 'Cooking';
        }
        case 'Combat': {
            const them = step && monsters(step);
            return them ? `Killing ${them}` : 'Training combat';
        }
        case 'RangedMagic':
            return step?.action === 'ranged' ? 'Training range' : 'Training mage';
        case 'Smith':
            return step?.action === 'smelt' ? 'Smelting bars' : 'Smithing';
        case 'Firemaking':
            return 'Burning logs';
        case 'Crafting':
            if (step?.action === 'spin_flax') return 'Spinning flax';
            if (step?.action === 'craft_wool') return 'Spinning wool';
            if (step?.action === 'craft_ring') return 'Making gold rings';
            if (step?.action.startsWith('cut_')) return 'Cutting gems';
            if (step?.action.startsWith('craft_')) return 'Making leather stuff';
            return 'Crafting';
        case 'Thieve': {
            if (step?.action === 'thieve_stall') return 'Stealing from stalls lol';
            const them = step && monsters(step);
            return them ? `Pickpocketing ${them}` : 'Thieving';
        }
        case 'Agility':
            return 'Doing an agility course';
        case 'Runecrafting':
            return 'Crafting runes';
        case 'Herblore':
            return 'Making potions';
        case 'Prayer':
            return 'Burying bones';
        case 'Pick Flax':
            return 'Picking flax';
        case 'WaterFilling':
            return 'Filling vials';
        case 'ShopTrip':
            return 'Going shopping';
        case 'FoodTrip':
            return 'Getting some food';
        case 'Bank':
            return 'Banking';
        case 'Bankstand':
        case 'Vendor':
        case 'Sell':
            return 'Selling some stuff';
        case 'PKer':
        case 'EdgevillePKer':
            return 'Pking';
        // port (the realism work, phase 5a: tasks/AlchTask, tasks/LawTripTask)
        case 'Magic':
            return 'High alching';
        case 'LawTrip':
            return 'Getting laws';
        default:
            return null;
    }
}

/**
 * What the bot is doing and where, as a line ("Cutting willows in Draynor"), or null when it has nothing to tell (no
 * task, a chat at the bank). The place is its step's (where it works), else where it stands.
 */
export function activityLine(bot: Player): string | null {
    const task = BotManager.botFor(bot)?.currentTask;
    if (!task) return null;
    const step = task.activityStep();
    const what = activityFor(task.name.split(':')[0], step);
    if (!what) return null;
    const [x, z] = step ? step.location : [bot.x, bot.z];
    const where = placePhrase(x, z);
    return where ? `${what} ${where}` : what;
}
