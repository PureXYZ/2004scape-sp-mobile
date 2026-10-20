/**
 * EssenceTask.ts (the variety work, round 1, Track D: DO-4, essence mining)
 *
 * The essence run of late 2004, among the most visible F2P activities: a
 * pickaxe, Aubury's teleport from his rune shop in south-east Varrock (Rune Mysteries done, as every bot has), a pack of
 * rune essence in the mine (Mining XP, any level), the mine's portal back to him, the pack banked at Varrock East (the
 * bank nearest him), and again. RunecraftingTask's own legs in its 'essence' mode (only the game's scripts move the bot:
 * Aubury, the portal; marked for the humanlike runner). The essence stays in the bank, where bankstanders sell what they
 * bank and Varrock East's vendors stock it; a bot with a talisman crafts runes some of the time instead (the planner:
 * BotGoalPlanner._findRunecraftingTask).
 */
import { RunecraftingTask } from '#/engine/bot/tasks/RunecraftingTask.js';

export class EssenceTask extends RunecraftingTask {
    constructor() {
        super('essence');
    }
}
