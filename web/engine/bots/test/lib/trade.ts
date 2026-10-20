// For test/trade.test.mjs: the real 274 world of lib/simworld.ts plus what the runtime adds for trades - the content
// overlay (scripts.bin from bots/content/compile.mjs, put in place by the runtime's own overlay.ts through the vfs it
// reads) and the two script commands (runtime/bots/scripts.ts). The human acts through the engine's own packet
// handlers, with their checks (a visible component, a transmitted inventory, the other player in view).
export * from './simworld.js';
import { World } from './simworld.js';
import Component from '#/cache/config/Component.js';
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import WordEnc from '#/cache/wordenc/WordEnc.js';
import Player from '#/engine/entity/Player.js';
import IfButtonHandler from '#/network/game/client/handler/IfButtonHandler.js';
import InvButtonHandler from '#/network/game/client/handler/InvButtonHandler.js';
import OpPlayerHandler from '#/network/game/client/handler/OpPlayerHandler.js';
import ResumePCountDialogHandler from '#/network/game/client/handler/ResumePCountDialogHandler.js';
import IfButton from '#/network/game/client/model/IfButton.js';
import InvButton from '#/network/game/client/model/InvButton.js';
import OpPlayer from '#/network/game/client/model/OpPlayer.js';
import ResumePCountDialog from '#/network/game/client/model/ResumePCountDialog.js';
import type { NetworkPlayer } from '#/engine/entity/NetworkPlayer.js';
import { Items } from '#/engine/bot/BotKnowledge.js';
import { BankstandTask } from '#/engine/bot/tasks/BankstandTask.js';
import { TRADE_TALK, VendorTask, vendorAdverts, vendorStock } from '#/engine/bot/tasks/VendorTask.js';
import { buyPrice, categoryOf, formatGp, itemValue, sellPrice } from '#/engine/bot/port/BotPrices.js';
import { nameSeed } from '#/engine/bot/port/BotSeed.js';
import { SocialTask } from '#/engine/bot/tasks/SocialTask.js';
import { isTradingTask, sameItems, tradeOffer, tradeScreen, tradeStatus, TradeStatus } from '#/engine/bot/port/BotTradeScreen.js';
export { installBotsContent } from './botscontent.js';

export { Component, InvType, ObjType, VarPlayerType, WordEnc, Player, Items, BankstandTask, VendorTask, SocialTask, vendorAdverts, vendorStock, buyPrice, categoryOf, itemValue, sellPrice };
// (the realism work, phase 4: economy) trade talk's lines, prices as written, a name's dice
export { TRADE_TALK, formatGp, nameSeed };
export { isTradingTask, sameItems, tradeOffer, tradeScreen, tradeStatus, TradeStatus };

const opPlayerHandler = new OpPlayerHandler();
const ifButtonHandler = new IfButtonHandler();
const invButtonHandler = new InvButtonHandler();
const countDialogHandler = new ResumePCountDialogHandler();

/** The human clicks an op on another player (OPPLAYERn). */
export function opPlayer(human: Player, other: Player, op: number): boolean {
    return opPlayerHandler.handle(new OpPlayer(op, other.slot), human as NetworkPlayer);
}

/** The human clicks a button (IF_BUTTON), e.g. 'trademain:accept'. */
export function ifButton(human: Player, comName: string): boolean {
    return ifButtonHandler.handle(new IfButton(Component.getId(comName)), human);
}

/** The human clicks an inventory op (INV_BUTTON) on the first slot holding `obj`; op 5 (…-X) then answers `count`. */
export function invButton(human: Player, comName: string, invName: string, obj: number, op: number, count?: number): boolean {
    const inv = human.getInventory(InvType.getId(invName));
    if (!inv) return false;
    let slot = -1;
    for (let s = 0; s < inv.capacity && slot === -1; s++) if (inv.get(s)?.id === obj) slot = s;
    if (slot === -1 || !invButtonHandler.handle(new InvButton(op, obj, slot, Component.getId(comName)), human)) return false;
    return count === undefined || countDialogHandler.handle(new ResumePCountDialog(count), human);
}

/** The human closes the open interface (CLOSE_MODAL: the engine closes it in the player's next turn). */
export function closeModal(human: Player): void {
    human.requestModalClose = true;
}

export function invTotal(player: Player, invName: string, obj: number): number {
    const inv = player.getInventory(InvType.getId(invName));
    if (!inv) return 0;
    let n = 0;
    for (let s = 0; s < inv.capacity; s++) {
        const item = inv.get(s);
        if (item && item.id === obj) n += item.count;
    }
    return n;
}

/** An inventory as 'debugname x count' strings. */
export function invItems(player: Player, invName: string): string[] {
    const inv = player.getInventory(InvType.getId(invName));
    if (!inv) return [];
    const out: string[] = [];
    for (let s = 0; s < inv.capacity; s++) {
        const item = inv.get(s);
        if (item) out.push(`${ObjType.get(item.id).debugname}x${item.count}`);
    }
    return out;
}

/** The objs in the 274 packs the members flag says a free world refuses ([label,movetotrade]). */
export function isMembersObj(id: number): boolean {
    return ObjType.get(id).members;
}

export function currentTick(): number {
    return World.currentTick;
}
