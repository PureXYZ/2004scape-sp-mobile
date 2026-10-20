// A bot's side of a trade with a human, driven by the trade screens (port; the request itself is port/BotTrade.ts).
//
// Upstream's vendor, bankstand and social tasks clicked the trade buttons on timers: accept, then a few ticks later
// the confirm screen's accept whether or not that screen was open (which replaced the bot's own "accepted" status: a
// human who accepted afterwards waited for good), coins put up before the trade window was open (which cancelled
// the human's pending request), and a walk mid-trade (walkTo closes every modal: "Other player declined trade.").
// Here the trading tasks read the screens and the trade's own state (%tradestatus, the tradeoffer inventories) every
// tick and act only on what is open: offers and the first accept only on trademain, the second accept only on
// tradeconfirm, never twice. A deal is checked again before each accept: the bot puts up exactly what it gives (the
// count dialog is answered at once) and accepts only while the human offers exactly what the deal expects. A slow
// human gets SCREEN_TICKS on each screen (renewed by every change they make) before the bot closes the trade itself.
import Component from '#/cache/config/Component.js';
import InvType from '#/cache/config/InvType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import type Player from '#/engine/entity/Player.js';
import ScriptState from '#/engine/script/ScriptState.js';
import World from '#/engine/World.js';
import { interactIF_UseOp, interactIfButton, interactPlayerOp } from '#/engine/bot/BotAction.js';
import { botSay } from '#/engine/bot/port/BotSay.js';
import { botReactionTicks } from '#/engine/bot/port/BotTiming.js';

/** %tradestatus (interface_trade/configs/trade.constant). */
export const TradeStatus = { RESET: 0, RECEIVED: 1, PENDING_ACCEPT: 2, ACCEPT: 3, PENDING_CONFIRM: 4 } as const;

/** 60 s: how long a human may leave a trade screen (or the bot's request) without a change before the bot gives up. */
export const SCREEN_TICKS = 100;
/** A trade target that has not moved on for this long while no trade screen is open is dropped (BotManager.tick). */
export const STALE_TRADE_TICKS = 120;
/** Beyond this (or on another floor) the trade partner is gone. */
const PARTNER_RANGE = 20;

export type TradeScreen = 'main' | 'confirm' | null;

interface TradeIds {
    main: number;
    confirm: number;
    mainAccept: number;
    confirmAccept: number;
    sideInv: number;
    mainInv: number;
    offer: number;
    inv: number;
    status: number;
    partner: number;
}

let ids: TradeIds | null = null;

/** The trade's interfaces, inventories and varps (looked up once, after the cache is loaded). */
function tradeIds(): TradeIds {
    if (!ids) {
        ids = {
            main: Component.getId('trademain'),
            confirm: Component.getId('tradeconfirm'),
            mainAccept: Component.getId('trademain:accept'),
            confirmAccept: Component.getId('tradeconfirm:accept'),
            sideInv: Component.getId('tradeside:inv'),
            mainInv: Component.getId('trademain:inv'),
            offer: InvType.getId('tradeoffer'),
            inv: InvType.getId('inv'),
            status: VarPlayerType.getId('tradestatus'),
            partner: VarPlayerType.getId('tradepartner')
        };
    }
    return ids;
}

/** The trade screen `player` has open. */
export function tradeScreen(player: Player): TradeScreen {
    const { main, confirm } = tradeIds();
    return player.modalMain === main ? 'main' : player.modalMain === confirm ? 'confirm' : null;
}

export function tradeStatus(player: Player): number {
    return player.getVar(tradeIds().status) as number;
}

/** What `player` has put up in the trade: item id -> total. */
export function tradeOffer(player: Player): Map<number, number> {
    return invCounts(player, tradeIds().offer);
}

/** `player`'s inventory: item id -> total. */
export function packCounts(player: Player): Map<number, number> {
    return invCounts(player, tradeIds().inv);
}

function invCounts(player: Player, invId: number): Map<number, number> {
    const out = new Map<number, number>();
    const inv = player.getInventory(invId);
    if (!inv) return out;
    for (let slot = 0; slot < inv.capacity; slot++) {
        const item = inv.get(slot);
        if (item) out.set(item.id, (out.get(item.id) ?? 0) + item.count);
    }
    return out;
}

export function sameItems(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>): boolean {
    if (a.size !== b.size) return false;
    for (const [id, n] of a) if (b.get(id) !== n) return false;
    return true;
}

/** Runs an Offer-X / Remove-X inventory button and answers its count dialog with `count` at once (exact amounts). */
function moveExact(bot: Player, com: number, invId: number, id: number, count: number): boolean {
    const inv = bot.getInventory(invId);
    if (!inv || count <= 0) return false;
    let slot = -1;
    for (let s = 0; s < inv.capacity && slot === -1; s++) if (inv.get(s)?.id === id) slot = s;
    if (slot === -1 || !interactIF_UseOp(bot, com, id, slot, 5, invId)) return false;
    const script = bot.activeScript;
    if (script && script.execution === ScriptState.COUNTDIALOG) {
        script.lastInt = count;
        bot.executeScript(script, true, true);
    }
    return true;
}

/**
 * Makes the bot's offer exactly `give` (taking back anything else), only while trademain is open: the scripts
 * ([label,movetotrade]) would move items into the offer with no trade open, and reset the partner's request.
 * True when the offer is exactly `give`. Changing it resets both players' accept, as for a human.
 */
export function setOffer(bot: Player, give: ReadonlyMap<number, number>): boolean {
    if (tradeScreen(bot) !== 'main') return false;
    const { sideInv, mainInv, offer, inv } = tradeIds();
    let current = tradeOffer(bot);
    if (sameItems(current, give)) return true;
    for (const [id, n] of current) {
        const want = give.get(id) ?? 0;
        if (n > want) moveExact(bot, mainInv, offer, id, n - want);
    }
    current = tradeOffer(bot);
    for (const [id, want] of give) {
        const have = current.get(id) ?? 0;
        if (want > have) moveExact(bot, sideInv, inv, id, want - have);
    }
    return sameItems(tradeOffer(bot), give);
}

/** Clicks accept on the open trade screen, unless the bot's own status already says it accepted that screen. */
export function acceptTrade(bot: Player): void {
    const screen = tradeScreen(bot);
    if (screen === null) return;
    const { mainAccept, confirmAccept } = tradeIds();
    const accepted = screen === 'main' ? TradeStatus.PENDING_ACCEPT : TradeStatus.PENDING_CONFIRM;
    if (tradeStatus(bot) !== accepted) interactIfButton(bot, screen === 'main' ? mainAccept : confirmAccept);
}

/** The bot's trade fields back to "no trade" (upstream's resetTrade). */
export function clearTradeTarget(bot: Player): void {
    bot.botTradeTargetPid = -1;
    bot.botTradeTargetStage = -1;
    bot.botTradeTargetChatName = '';
    bot.botTradeTargetChatMessage = '';
}

/**
 * What a trading task (Vendor, Bankstand) answers when a human asks it to trade: null when it takes the trade now,
 * else the line the bot says instead (out of stock, banking …). Called only when the bot has no trade target.
 */
export interface TradingTask {
    tradeRefusal(bot: Player, human: Player): string | null;
}

export function isTradingTask(task: unknown): task is TradingTask {
    return typeof (task as Partial<TradingTask> | null)?.tradeRefusal === 'function';
}

/** What the bot puts up and what it expects from the human (exactly); no `give`/`get` = no deal yet. */
export interface TradeDeal {
    /** What the bot says about the human's offer: said once, when it changes ('' says nothing). */
    line: string;
    give?: ReadonlyMap<number, number>;
    get?: ReadonlyMap<number, number>;
    /** No deal yet: what the bot shows in its offer meanwhile (not accepted). */
    show?: ReadonlyMap<number, number>;
}

/**
 * How a trade ended: 'done' (both accepted the confirm screen and the bot got what the deal promised), 'declined'
 * (the human closed it), 'timeout' (the window did not open, or the human changed nothing on a screen, for
 * SCREEN_TICKS: the bot closed it), 'lost' (the partner left, or the task ended the trade), 'refused' (the offers no
 * longer matched the deal on the confirm screen: the bot closed it).
 */
export type TradeOutcome = 'done' | 'declined' | 'timeout' | 'lost' | 'refused';

/**
 * One trade with a human, as a trading task drives it. begin() after the task took the request (or to ask the human
 * itself); then tick() every tick until it returns the outcome. The bot never walks while it trades (the tasks do
 * not, and walkTo would close the window).
 */
export class TradeSession {
    phase: 'open' | 'main' | 'confirm' | null = null;
    partnerUid = -1;
    private deadline = 0;
    private nudgeAt = 0;
    private said = '';
    private seen = '';
    private deal: TradeDeal | null = null;
    private before: Map<number, number> | null = null;
    /**
     * port (the realism work, phase 2): the screen as the bot last read it settled (both offers the deal's) and the tick
     * it accepts: a person reads a trade 1-4 s before accepting (port/BotTiming 'trade'). Upstream, and the port before
     * this, accepted in the very tick the offers matched or the confirm screen opened.
     */
    private settled = '';
    private acceptAt = -1;

    get active(): boolean {
        return this.phase !== null;
    }

    /**
     * The bot answers the request with its own trade op (the window opens for both once it reaches the human), or
     * sends its own request (the human opens the window by clicking it in the chatbox: they get SCREEN_TICKS).
     */
    begin(bot: Player, partner: Player): void {
        this.phase = 'open';
        this.partnerUid = partner.uid;
        this.deadline = World.currentTick + SCREEN_TICKS;
        this.nudgeAt = World.currentTick + Math.floor(SCREEN_TICKS / 2);
        this.said = '';
        this.seen = '';
        this.deal = null;
        this.before = null;
        this.settled = '';
        this.acceptAt = -1;
        bot.botTradeTargetPid = partner.uid;
        bot.botTradeTargetStage = 0;
        interactPlayerOp(bot, partner.slot, 4);
    }

    /** Something the human did that is not in the offers (a chat line): their time on this screen starts again. */
    touch(): void {
        if (this.phase === 'main' || this.phase === 'confirm') this.deadline = World.currentTick + SCREEN_TICKS;
    }

    /**
     * Every tick while active. `evaluate(partner, offer)` gives the deal for the human's current offer; `onOpen` runs
     * once when the window opens; `onNudge` once halfway through the wait for the window (a line, say), when the bot
     * sends its trade op again unless one is still under way. Returns the outcome once the trade is over, else null.
     */
    tick(bot: Player, evaluate: (partner: Player, offer: Map<number, number>) => TradeDeal, onOpen?: (partner: Player) => void, onNudge?: (partner: Player) => void): TradeOutcome | null {
        if (this.phase === null) return null;
        const now = World.currentTick;
        const screen = tradeScreen(bot);
        const partner = World.getPlayerByUid(this.partnerUid);

        if (this.phase === 'open') {
            if (screen === null) {
                const near = partner !== null && partner.level === bot.level && Math.max(Math.abs(partner.x - bot.x), Math.abs(partner.z - bot.z)) <= PARTNER_RANGE;
                if (!near) return this.end(bot, 'lost');
                if (now >= this.deadline) return this.end(bot, 'timeout');
                if (now === this.nudgeAt) {
                    onNudge?.(partner);
                    // (the first may not have reached them: "I can't reach that!", or they were busy)
                    if (!bot.hasInteraction()) interactPlayerOp(bot, partner.slot, 4);
                }
                return null;
            }
            this.phase = 'main';
            this.deadline = now + SCREEN_TICKS;
            bot.botTradeTargetStage = 1;
            if (partner && onOpen) onOpen(partner);
        }

        if (screen === null) {
            // the window closed: the human declined (the overlay already cleared the bot's target), or both accepted
            // the confirm screen and the trade went through
            return this.end(bot, this.phase === 'confirm' && this.completed(bot) ? 'done' : 'declined');
        }
        // a window with someone else than this partner (the trade scripts do not do that): not this trade
        // (the variety work, round 2, track W2: %tradepartner holds the uid as an int32, as BotDuel reads %duel2accept: a
        // partner whose uid is 2^31 or more, about half the names (World's uid is the name's hash << 11), never matched,
        // and the bot closed the window as 'lost' at once)
        if (!partner || bot.getVar(tradeIds().partner) !== (this.partnerUid | 0)) return this.end(bot, 'lost');

        if (screen === 'confirm' && this.phase === 'main') this.enterConfirm(bot, now);
        else if (screen === 'main') this.phase = 'main';

        if (this.phase === 'main') {
            const offer = tradeOffer(partner);
            const key = `${[...offer].join(';')}|${tradeStatus(partner)}`;
            if (key !== this.seen) {
                // every change the human makes gives them their time on this screen again
                this.seen = key;
                this.deadline = now + SCREEN_TICKS;
            }
            if (now >= this.deadline) return this.end(bot, 'timeout');
            const deal = evaluate(partner, offer);
            if (deal.line && deal.line !== this.said) {
                this.said = deal.line;
                botSay(bot, deal.line);
            }
            this.deal = deal.give && deal.get ? deal : null;
            // accept only with the bot's offer exactly the deal's (put up first: checked again next tick) and the
            // human's exactly what the deal expects; port: once it has read them (a change starts the reading again)
            if (this.deal) {
                if (setOffer(bot, this.deal.give!) && sameItems(offer, this.deal.get!)) this.acceptWhenRead(bot, now, '#' + [...offer].join(';'));
                else this.settled = '';
            } else {
                this.settled = '';
                if (deal.show) setOffer(bot, deal.show);
            }
            return null;
        }

        // the confirm screen: the offers cannot change here, but a deal that does not hold is never accepted
        if (now >= this.deadline) return this.end(bot, 'timeout');
        const deal = this.deal;
        if (!deal || !sameItems(tradeOffer(bot), deal.give!) || !sameItems(tradeOffer(partner), deal.get!)) return this.end(bot, 'refused');
        this.acceptWhenRead(bot, now, 'confirm');
        return null;
    }

    /** port: accepts the screen `key` once the bot has read it: a person's 1-4 s after it settled (BotTiming 'trade') */
    private acceptWhenRead(bot: Player, now: number, key: string): void {
        if (key !== this.settled) {
            this.settled = key;
            this.acceptAt = now + botReactionTicks(bot, 'trade');
        }
        if (now >= this.acceptAt) acceptTrade(bot);
    }

    private enterConfirm(bot: Player, now: number): void {
        this.phase = 'confirm';
        this.deadline = now + SCREEN_TICKS;
        bot.botTradeTargetStage = 2;
        // the bot's pack as the trade stands: after a decline its side comes back here, after the trade it does not
        this.before = packCounts(bot);
    }

    private completed(bot: Player): boolean {
        const deal = this.deal;
        const before = this.before;
        if (!deal || !before) return false;
        const now = packCounts(bot);
        // what it gets arrived, and what it gave (that it does not also get: coins and their change) did not come back
        for (const [id, n] of deal.get!) if ((now.get(id) ?? 0) < (before.get(id) ?? 0) + n) return false;
        for (const [id, n] of deal.give!) if (!deal.get!.has(id) && (now.get(id) ?? 0) >= (before.get(id) ?? 0) + n) return false;
        return deal.give!.size + deal.get!.size > 0;
    }

    /**
     * Ends the trade: the bot closes a window that is still open (the human is told it declined), drops a trade op
     * still under way (it would open a window with no trade behind it) and clears its trade fields - unless the human
     * already asked again (their new request came after the window closed: the overlay had cleared the target).
     */
    end(bot: Player, outcome: TradeOutcome): TradeOutcome {
        const windowWasOpen = this.phase !== 'open';
        this.phase = null;
        this.deal = null;
        this.before = null;
        this.settled = '';
        this.acceptAt = -1;
        if (tradeScreen(bot) !== null) bot.closeModal();
        if (!windowWasOpen && bot.target !== null) bot.clearInteraction();
        const askedAgain = windowWasOpen && tradeScreen(bot) === null && bot.botTradeTargetPid === this.partnerUid && bot.botTradeTargetStage === 0;
        if (!askedAgain) clearTradeTarget(bot);
        return outcome;
    }
}

const stale = new WeakMap<Player, { pid: number; stage: number; screen: TradeScreen; since: number }>();

/**
 * BotManager.tick's safety net, every tick for every bot: a trade target that has not moved on (same partner, stage
 * and trade screen) for STALE_TRADE_TICKS while the bot has no trade screen open is dropped. A trading task ends its
 * trades itself; this catches a request no task picked up (the bot switched tasks in between, a task error).
 */
export function dropStaleTradeTarget(bot: Player, tick: number): void {
    const pid = bot.botTradeTargetPid;
    if (pid === -1 || pid === undefined) {
        stale.delete(bot);
        return;
    }
    const screen = tradeScreen(bot);
    const seen = stale.get(bot);
    if (!seen || seen.pid !== pid || seen.stage !== bot.botTradeTargetStage || seen.screen !== screen) {
        stale.set(bot, { pid, stage: bot.botTradeTargetStage, screen, since: tick });
        return;
    }
    if (screen === null && tick - seen.since >= STALE_TRADE_TICKS) {
        clearTradeTarget(bot);
        stale.delete(bot);
    }
}
