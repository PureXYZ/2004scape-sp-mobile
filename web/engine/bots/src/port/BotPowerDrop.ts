// port (the variety work, round 1, Track D: DO-12, power-dropping): a power-trainer's full pack (port/BotFavourites
// isDropper: about 1 gatherer in 5; DROPPED_LOADS: willows, oaks, normal logs, iron, shrimps, anchovies) goes on the
// ground where it stands, one item at a time through the game's own Drop (274's [opheld5,_]: the item lies there for its
// owner, then for everyone, then goes), at a person's clicking pace, and it works on: the 2004 way to train Woodcutting,
// Mining and Fishing fast ("drop the willows"). The research found every gatherer banking every load.
// Nobody picks the items up (a bot never takes what another player could see).
import type Player from '#/engine/entity/Player.js';
import InvType from '#/cache/config/InvType.js';
import { interactHeldOp } from '#/engine/bot/BotAction.js';
import { DROPPED_LOADS, dropsLoad } from '#/engine/bot/port/BotFavourites.js';
import type { SkillStep } from '#/engine/bot/BotKnowledge.js';

export { dropsLoad };

/** a drop's pace: the next one 1-2 ticks after the last, and now and then a pause (a look about) of 3-7 */
const DROP_PAUSE_CHANCE = 0.12;

/**
 * The least of the step's load a full pack holds for a power-trainer to drop it (else it banks: a pack full of a
 * previous task's leftovers, a few logs among them, went drop, nothing to drop, chop, drop again, and never to a bank)
 */
export const DROP_LEAST = 10;

/** A full pack the bot drops here: a power-trainer's (dropsLoad) with DROP_LEAST or more of the step's load in it */
export function dropsHere(player: Player, step: SkillStep): boolean {
    if (!dropsLoad(player, step)) return false;
    const inv = player.getInventory(InvType.INV);
    if (!inv) return false;
    let n = 0;
    for (let slot = 0; slot < inv.capacity; slot++) if (inv.get(slot)?.id === step.itemGained) n++;
    return n >= DROP_LEAST;
}

/** Has the pack still something of the step's load to drop? */
export function loadLeft(player: Player, step: SkillStep): boolean {
    const id = step.itemGained;
    if (id === undefined || !DROPPED_LOADS.has(id)) return false;
    const inv = player.getInventory(InvType.INV);
    if (!inv) return false;
    for (let slot = 0; slot < inv.capacity; slot++) if (inv.get(slot)?.id === id) return true;
    return false;
}

/**
 * Drops one of the step's load from the pack (its first slot holding one, as a player clicks down the pack) and returns
 * the ticks to wait before the next; -1 when there is nothing left to drop (or the click could not be made: the bot is
 * held by a script).
 */
export function dropOne(player: Player, step: SkillStep): number {
    const id = step.itemGained;
    const inv = player.getInventory(InvType.INV);
    if (id === undefined || !inv || !DROPPED_LOADS.has(id)) return -1;
    for (let slot = 0; slot < inv.capacity; slot++) {
        if (inv.get(slot)?.id !== id) continue;
        if (!interactHeldOp(player, inv, id, slot, 5)) return player.delayed ? 1 : -1;
        return 1 + (Math.random() < 0.5 ? 1 : 0) + (Math.random() < DROP_PAUSE_CHANCE ? 3 + Math.floor(Math.random() * 5) : 0);
    }
    return -1;
}

/** the drops sent, by item (the humanlike runner's AM1 detail and the tests) */
export const dropStats = { loads: 0, items: 0 };
