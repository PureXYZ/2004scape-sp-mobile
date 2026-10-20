// The engine hooks of the bots (docs/BOTS.md §4.3): own-property wrappers on the World singleton (World.cycle looks every
// step up on `this`, as runtime/ticker.ts relies on too) and a wrapper on a handler prototype - no engine source is
// patched. index.ts checks every target before anything is wrapped. Every hook body is guarded: an exception from bot
// code must never reach World.cycle's catch (which removes every player and exits) or processClientsIn's (which
// disconnects the human whose packet was being handled).
//
//   World.processClientsIn     after: BotManager.clearAfkEvents() - the engine's own random-event roll is cleared for every
//                              bot (the flag is set here); the bot library arms bots near a human itself (phase 5a)
//   World.processPlayers       after: BotManager.tick() - keep-alive, staggered spawning, the AI (upstream: World.cycle)
//   World.sendPrivateMessage   before: BotChat.onPrivateMessage ("come here" ...); consumed messages go no further
//   MessagePublicHandler       after a successful handle(): BotChat.onPublicMessage with the line as typed (the bots
//                              say only filtered lines themselves: port/BotSay)
import { BotManager } from '#/engine/bot/BotManager.js';
import { BotChat } from '#/engine/bot/port/BotChat.js';
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import MessagePublicHandler from '#/network/game/client/handler/MessagePublicHandler.js';
import type MessagePublic from '#/network/game/client/model/MessagePublic.js';
import { fromBase37 } from '#/util/JString.js';

import { botError, bots, botsActive, disableBots } from './state.js';

type WorldHooks = {
    processClientsIn(): void;
    processPlayers(): void;
    sendPrivateMessage(player: Player, targetUsername37: bigint, message: string): void;
};
const world = World as unknown as WorldHooks;

export function hookTargetsMissing(): string[] {
    const missing = (['processClientsIn', 'processPlayers', 'sendPrivateMessage'] as const).filter(m => typeof world[m] !== 'function').map(m => `World.${m}`);
    if (typeof MessagePublicHandler.prototype.handle !== 'function') missing.push('MessagePublicHandler.prototype.handle');
    return missing;
}

const isBot = (p: Player) => (p as Player & { is_bot?: boolean }).is_bot === true;

const SAMPLES = 1024;
/**
 * What the bots cost per tick (BotManager.tick in ms), their path searches each tick and the budget (port/BotPathing),
 * and when they joined: [tick, how many].
 */
export const botTickStats = { durations: new Float64Array(SAMPLES), searches: new Uint16Array(SAMPLES), searchBudget: 0, ticks: 0, maxMs: 0, spawns: [] as [number, number][] };

export function botTickSummary() {
    const n = Math.min(botTickStats.ticks, SAMPLES);
    const d = Array.from(botTickStats.durations.subarray(0, n)).sort((a, b) => a - b);
    const pick = (q: number) => (n ? +d[Math.min(n - 1, Math.floor(q * n))].toFixed(2) : 0);
    return { ticks: botTickStats.ticks, avgMs: n ? +(d.reduce((a, b) => a + b, 0) / n).toFixed(2) : 0, p50Ms: pick(0.5), p95Ms: pick(0.95), maxMs: +botTickStats.maxMs.toFixed(2) };
}

export function installHooks(): void {
    const processClientsIn = world.processClientsIn;
    world.processClientsIn = function (this: typeof World) {
        processClientsIn.call(this);
        if (!botsActive()) return;
        bots.counters.clientsIn++;
        try {
            BotManager.clearAfkEvents();
        } catch (e) {
            botError('afk', 'clearing the bots\' random events failed', e);
        }
    };

    let failuresInARow = 0;
    let spawned = 0;
    const processPlayers = world.processPlayers;
    world.processPlayers = function (this: typeof World) {
        processPlayers.call(this);
        if (!botsActive()) return;
        const t0 = performance.now();
        try {
            BotManager.tick();
            bots.counters.botTicks++;
            failuresInARow = 0;
        } catch (e) {
            // the library isolates each bot's errors; this is the library itself failing
            bots.counters.tickFailures++;
            botError('tick', 'BotManager.tick failed', e);
            if (++failuresInARow >= 10) disableBots('BotManager.tick failed 10 ticks in a row', 'failed');
        }
        const ms = performance.now() - t0;
        const sample = botTickStats.ticks++ % SAMPLES;
        botTickStats.durations[sample] = ms;
        if (ms > botTickStats.maxMs) botTickStats.maxMs = ms;
        try {
            const stats = BotManager.stats();
            botTickStats.searches[sample] = stats.pathSearchesLastTick ?? 0;
            botTickStats.searchBudget = stats.pathSearchBudget ?? 0;
            const now = stats.spawned;
            if (now > spawned) {
                botTickStats.spawns.push([this.currentTick, now - spawned]);
                // (the last 200 logins: upstream's list grew by one for every tick with a login, all session)
                if (botTickStats.spawns.length > 200) botTickStats.spawns.splice(0, botTickStats.spawns.length - 200);
            }
            spawned = now;
        } catch (e) {
            botError('stats', 'BotManager.stats failed', e);
        }
    };

    const sendPrivateMessage = world.sendPrivateMessage;
    world.sendPrivateMessage = function (this: typeof World, player: Player, targetUsername37: bigint, message: string) {
        if (botsActive() && !isBot(player)) {
            try {
                bots.counters.privateChats++;
                if (BotChat.onPrivateMessage(player, fromBase37(targetUsername37), message)) {
                    bots.counters.privateConsumed++;
                    return;
                }
            } catch (e) {
                botError('chat', 'the bots failed to read a private message', e);
            }
        }
        sendPrivateMessage.call(this, player, targetUsername37, message);
    };

    const handlePublic = MessagePublicHandler.prototype.handle;
    MessagePublicHandler.prototype.handle = function (this: MessagePublicHandler, message: MessagePublic, player: Player): boolean {
        const ok = handlePublic.call(this, message, player);
        if (ok && botsActive() && player.logMessage !== null && !isBot(player)) {
            try {
                bots.counters.publicChats++;
                // the line as typed: the filter masked words the bots listen for ("noob") and, across words, the
                // bot's name ("Kevin1991 noob" arrived as "Kevi**********")
                BotChat.onPublicMessage(player, player.logMessage);
            } catch (e) {
                botError('chat', 'the bots failed to hear a public message', e);
            }
        }
        return ok;
    };
}
