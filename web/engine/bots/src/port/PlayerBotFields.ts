// Bot-only fields on the engine's Player, declared without touching Player.ts (upstream added them as class fields of
// its rev-254 Player.ts). They are assigned only on bots (initBotFields, at spawn): a human never carries them, so
// every reader that can see a human tests `is_bot === true` first.
import type Player from '#/engine/entity/Player.js';

declare module '#/engine/entity/Player.js' {
    export default interface Player {
        is_bot?: boolean;
        botPlanner: string;
        // a trade with a human: the human's uid (-1 = none) and the stage the bot's task drives (0 = requested)
        botTradeTargetPid: number;
        botTradeTargetStage: number;
        // the trade partner's last public chat line (BotChat stores it, the trading task reads it)
        botTradeTargetChatName: string;
        botTradeTargetChatMessage: string;
        // marketplace: per human/request reply cooldowns (World.currentTick) and the vendor's current stock
        botVendorPmCooldowns: Record<string, number>;
        botVendorStockItemId: number;
        botVendorStockName: string;
        botVendorStockNoted: boolean;
        // "come here": where the bot stood when a human called it (-1 = not called)
        botComeHereReturnX: number;
        botComeHereReturnZ: number;
        // port: a newcomer that is a newbie still (port/BotNewbie: until combat 10 or total level 60; the realism work,
        // phase 3: newbie time measured in levels, it was a world tick, botNewbieUntil); false for any other bot
        botNewbie: boolean;
    }
}

export function initBotFields(player: Player, planner: string): void {
    player.is_bot = true;
    player.botPlanner = planner;
    player.botTradeTargetPid = -1;
    player.botTradeTargetStage = -1;
    player.botTradeTargetChatName = '';
    player.botTradeTargetChatMessage = '';
    player.botVendorPmCooldowns = {};
    player.botVendorStockItemId = -1;
    player.botVendorStockName = '';
    player.botVendorStockNoted = false;
    player.botComeHereReturnX = -1;
    player.botComeHereReturnZ = -1;
    player.botNewbie = false;
}

export function isBot(player: Player | null | undefined): player is Player {
    return player?.is_bot === true;
}
