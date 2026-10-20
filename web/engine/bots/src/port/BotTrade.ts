// A human asks a bot to trade (op 4 on the player): the content overlay's [opplayer4,_] runs
// .p_bot_interact_trade(uid, 0) on the bot and the runtime's script command calls onTradeRequest (BOTS.md §4.2).
//
// port: upstream's [opplayer4,_] made every bot say "One moment please, <name>" and take the request, but only the
// vendor, bankstand and social tasks ever answered or cleared it. Any other bot stayed "trading" for good: deaf to its
// name (BotChat keeps a trading bot's partner's lines for the trade), "come here" refused, every later request
// answered "One moment please" again. Here a bot takes a request only when its task trades (Vendor, Bankstand: see
// port/BotTradeScreen.TradingTask) and is free for it, and the first request wins; every other bot declines in a word
// and keeps no trade target. The trade itself is the task's (port/BotTradeScreen.TradeSession).
//
// port (the realism work, phase 5b, Track P: scam callers, talk only): a bot calling scams (port/BotScams) turns a request
// down in its own words ("lol jk", "u actually fell for it"), as a line of its act (kind 'scam'): no window opens (274's
// trade.rs2 opens one only when both have asked, and a caller never asks), so no item can move.
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { botSay, type LineKind } from '#/engine/bot/port/BotSay.js';
import { isTradingTask } from '#/engine/bot/port/BotTradeScreen.js';
import { tradeRefusal as scamRefusal } from '#/engine/bot/port/BotScams.js';
import { sayPieceText } from '#/engine/bot/port/BotPieceLines.js';
// (the variety work, round 2, track W2: fashion) a rich bot buying a status piece from a bot vendor
import { isBuyingFrom } from '#/engine/bot/port/BotFashion.js';

/** A bot whose task does not trade. */
const DECLINE = ['No thanks', 'Nah im good', 'Not trading atm sorry', 'No ty', 'Sorry, busy', 'Got nothing to trade'];
const DECLINE_PKER = ['Lol no', 'No trades, only pks', 'Nah', 'Not here to trade'];
/** A trading bot already trading with someone else. */
const BUSY = ['One sec, trading someone', 'Busy with a trade, hold on', 'In a trade, try again in a bit'];

/** A double tap: the same refusal to the same player is not repeated within this many ticks. */
const REPEAT_TICKS = 3;
const lastRefusal = new WeakMap<Player, { uid: number; tick: number }>();

function pick(lines: readonly string[]): string {
    return lines[Math.floor(Math.random() * lines.length)];
}

function refuse(bot: Player, human: Player, line: string, kind?: LineKind): void {
    const last = lastRefusal.get(bot);
    const tick = World.currentTick;
    if (last && last.uid === human.uid && tick - last.tick < REPEAT_TICKS) return;
    lastRefusal.set(bot, { uid: human.uid, tick });
    // (a scam caller's answer: a line of its act, in its style, noted as said: port/BotPieceLines)
    if (kind === 'scam') sayPieceText(bot, line, 'scam', { to: human });
    else botSay(bot, line);
}

export const BotTrade = {
    /** `human` asks `bot` to trade (from the overlay's [opplayer4,_], while the human's request script runs). */
    onTradeRequest(human: Player, bot: Player): void {
        // (the variety work, round 2, track W2: a bot asks only to buy from a bot vendor, port/BotShowOff)
        if (bot.is_bot !== true || (human.is_bot === true && !isBuyingFrom(human, bot)) || !BotManager.isActiveBot(bot.username)) return;
        // its own request to this player (the social reward), or a second tap: the trade is already this player's
        if (bot.botTradeTargetPid === human.uid) return;

        // (phase 5b: a scam caller's own answer; it never takes the trade)
        const scam = scamRefusal(bot, human);
        if (scam !== null) {
            refuse(bot, human, scam, 'scam');
            return;
        }
        const task = BotManager.botFor(bot)?.currentTask ?? null;
        let refusal: string | null;
        if (bot.botTradeTargetPid !== -1) {
            refusal = isTradingTask(task) ? pick(BUSY) : pick(DECLINE);
        } else if (isTradingTask(task)) {
            refusal = task.tradeRefusal(bot, human);
        } else {
            refusal = pick(bot.botPlanner === 'extras_pker' || bot.botPlanner === 'extras_edgeville_pker' ? DECLINE_PKER : DECLINE);
        }
        if (refusal !== null) {
            refuse(bot, human, refusal);
            return;
        }

        bot.botTradeTargetPid = human.uid;
        bot.botTradeTargetStage = 0;
        bot.botTradeTargetChatName = '';
        bot.botTradeTargetChatMessage = '';
        botSay(bot, `One moment please, ${human.displayName}`);
    }
};
