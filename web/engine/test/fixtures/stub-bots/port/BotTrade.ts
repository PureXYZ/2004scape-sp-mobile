// Stub trade (docs/BOTS.md §4.2): BotTrade.onTradeRequest(human, bot), called by the runtime's p_bot_interact_trade
// stage 0 (the overlay's [opplayer4,_]: a human asks the bot to trade). The contract, as the library keeps it: a bot
// that can trade and is free takes the request (the first one wins: its trade target is the human, and it says
// "One moment please, <name>"); any other declines in a word and keeps no trade target; a request from the human it
// already trades with changes nothing. Stub bots have no tasks: a free one takes it, one that has a target declines.
// `requests` records every call (test hook).
import type Player from '#/engine/entity/Player.js';

export const BotTrade = {
    requests: [] as { from: string; bot: string; took: boolean }[],

    onTradeRequest(player: Player, bot: Player): void {
        const free = bot.botTradeTargetPid === -1;
        this.requests.push({ from: player.username, bot: bot.username, took: free });
        if (bot.botTradeTargetPid === player.uid) return;
        if (!free) {
            bot.say('Busy with a trade, hold on');
            return;
        }
        bot.botTradeTargetPid = player.uid;
        bot.botTradeTargetStage = 0;
        bot.say(`One moment please, ${player.displayName}`);
    }
};
