// port (the realism work, phase 5b: set pieces, "Foundation (5b)"): the
// screens a set piece clicks through as a player does, shared by its tracks (the Duel Arena's stake window, the Party
// Room's chest and lever, a tomato thrown at a duellist). port/BotTradeScreen keeps its own trade window.
//
//   pressInvButtonExact(bot, com, inv, item, n)   an interface's inventory op 5 with the count dialog answered: "Offer-X"
//   pressInvButtonAll(bot, com, inv, item)        its op 4: "Offer-All"
//   walkDialogue(bot, answers)                    a dialogue walked a page or a choice a tick (the lever, a forfeit)
//   useItemOnPlayer(bot, target, item)            an item used on a player (OpPlayerUHandler's path: a tomato)
import type Player from '#/engine/entity/Player.js';
import { Interaction } from '#/engine/entity/Interaction.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import ScriptState from '#/engine/script/ScriptState.js';
import Component from '#/cache/config/Component.js';
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import { botAnswerDialogue, interactIF_UseOp } from '#/engine/bot/BotAction.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';

/** the first slot of `inv` holding `item`, or -1 */
function slotOf(bot: Player, invId: number, item: number): number {
    const inv = bot.getInventory(invId);
    for (let s = 0; inv && s < inv.capacity; s++) if (inv.get(s)?.id === item) return s;
    return -1;
}

/** an interface's component and an inventory by name (-1 for either: unknown) */
function ids(comName: string, invName: string): [number, number] {
    return [Component.getId(comName), InvType.getId(invName)];
}

/**
 * An interface's inventory op 5 on `item` with its count dialog answered `count` at once, as a player types the
 * number ("Offer-X", "Remove-X"): BotTradeScreen's moveExact, for any interface. False when the item or the interface
 * is not there, or the click was refused.
 */
export function pressInvButtonExact(bot: Player, comName: string, invName: string, item: number, count: number): boolean {
    const [com, inv] = ids(comName, invName);
    if (com === -1 || inv === -1 || count <= 0) return false;
    const slot = slotOf(bot, inv, item);
    if (slot === -1 || !interactIF_UseOp(bot, com, item, slot, 5, inv)) return false;
    const script = bot.activeScript;
    if (script && script.execution === ScriptState.COUNTDIALOG) {
        script.lastInt = count;
        bot.executeScript(script, true, true);
    }
    return true;
}

/** An interface's inventory op 4 on `item` ("Offer-All", "Remove-All"). */
export function pressInvButtonAll(bot: Player, comName: string, invName: string, item: number): boolean {
    const [com, inv] = ids(comName, invName);
    if (com === -1 || inv === -1) return false;
    const slot = slotOf(bot, inv, item);
    return slot !== -1 && interactIF_UseOp(bot, com, item, slot, 4, inv);
}

/**
 * A dialogue walked as a player clicks it: each tick() answers the page or the choice open now with the next of
 * `answers` (1-based options; a page takes any), one a tick. tick() is 'walking' while answers are left and a dialogue
 * is open or may still open, 'done' once all are given, 'lost' when no dialogue came within `waitTicks` of the last one.
 */
export interface DialogueWalk {
    tick(): 'walking' | 'done' | 'lost';
    /** answers given so far */
    readonly given: number;
}

export function walkDialogue(bot: Player, answers: readonly number[], waitTicks = 10): DialogueWalk {
    let given = 0;
    let idle = 0;
    return {
        get given() {
            return given;
        },
        tick() {
            if (given >= answers.length) return 'done';
            if (botAnswerDialogue(bot, answers[given]) === null) {
                // (none open yet: the script's own delay, the NPC's walk to the bot)
                return ++idle > waitTicks ? 'lost' : 'walking';
            }
            idle = 0;
            given++;
            return given >= answers.length ? 'done' : 'walking';
        }
    };
}

/**
 * An item from the pack used on another player, as OpPlayerUHandler takes the client's click (a tomato at a duellist):
 * the engine walks the bot to it and runs [opplayeru] / [apu] for the item. False when the bot is in a script's delay,
 * the target left, the item is not in the pack, or it is a members' item on a free world.
 */
export function useItemOnPlayer(bot: Player, target: Player, item: number): boolean {
    if (bot.delayed || target.slot === -1 || target === bot) return false;
    const slot = slotOf(bot, InvType.INV, item);
    if (slot === -1) return false;
    if (ObjType.get(item).members && !isMembersWorld()) return false;
    bot.clearPendingAction();
    bot.lastUseItem = item;
    bot.lastUseSlot = slot;
    return bot.setInteraction(Interaction.ENGINE, target, ServerTriggerType.APPLAYERU, item);
}
