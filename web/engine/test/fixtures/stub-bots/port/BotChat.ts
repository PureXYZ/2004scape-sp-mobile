// Stub chat (docs/BOTS.md §4.2): a bot addressed by its whole name answers "hi <name>" two ticks later; a private
// "come here" makes the bot walk to the sender. `heard` records every call (test hook).
import type Player from '#/engine/entity/Player.js';

import { BotManager } from '../BotManager.js';

export const BotChat = {
    heard: [] as { kind: 'public' | 'private'; from: string; to?: string; text: string }[],

    onPublicMessage(player: Player, text: string): void {
        this.heard.push({ kind: 'public', from: player.username, text });
        for (const bot of BotManager.addressed(text)) BotManager.sayLater(bot, `hi ${player.displayName}`, 2);
    },

    onPrivateMessage(player: Player, targetName: string, text: string): boolean {
        this.heard.push({ kind: 'private', from: player.username, to: targetName, text });
        if (!BotManager.isActiveBot(targetName) || text.trim().toLowerCase() !== 'come here') return false;
        const bot = [...BotManager.activeBots()].find(p => p.username === targetName);
        if (!bot) return false;
        BotManager.comeHere(bot, player);
        return true;
    }
};
