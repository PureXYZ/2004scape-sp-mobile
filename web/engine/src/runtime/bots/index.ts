// The bots glue (docs/BOTS.md §4.3), evaluated by src/entry-bots.ts right after the engine entry, so in engine-bots.js
// only. It reads bots.count from world.json and installs nothing when that is 0; otherwise, after checking that every
// target exists (a renamed engine method switches the bots off with a logged error, never the world):
//   ScriptRunner.HANDLERS[10100/10101]  p_isbot / p_bot_interact_trade (scripts.ts)
//   ScriptProvider.load                 + the content-script overlay after every load (overlay.ts): World.start and ::reload
//   World.start                         + BotManager.start once the world is up, before its first tick (the worker never
//                                       takes the startCycle branch where upstream started the bots)
//   World.processPlayers / processClientsIn / sendPrivateMessage, MessagePublicHandler   (hooks.ts)
//   World.friendThread.postMessage      the friend and ignore lists, bots logging in and out (friends.ts)
//   saves.write / saves.retryPending / World.onLoginMessage   the bot store and name collisions (routing.ts)
//   World.cycle                         after every tick: the bot store's write the bots' logouts waited for (routing.ts:
//                                       at most once every 30 s of world time), a login waiting too long for its bot is
//                                       refused (routing.ts),
//                                       the friend lists that waited for the world to fill are sent (friends.ts),
//                                       the repeated-log summary (logs.ts); a self-check after the first ticks: the
//                                       hooks ran and the keep-alive works
//   console.error / console.warn        repeated lines limited (logs.ts)
// What the page hears of the bots (their switching off, whether they were saved) is page.ts, wired by entry-bots.ts.
import InvType from '#/cache/config/InvType.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { BotChat } from '#/engine/bot/port/BotChat.js';
import { sayListeners } from '#/engine/bot/port/BotSay.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import ScriptRunner from '#/engine/script/ScriptRunner.js';
import World from '#/engine/World.js';
import MessagePublicHandler from '#/network/game/client/handler/MessagePublicHandler.js';
import Environment from '#/util/Environment.js';

import { botTickStats, botTickSummary, hookTargetsMissing, installHooks } from './hooks.js';
import { limitRepeatedLogs, logLimits, rollLogWindow } from './logs.js';
import { forgetDeletedCharacters, friendStats, friendTargetsMissing, friendsAfterTick, installFriends, isFriendOfHuman } from './friends.js';
import { applyOverlay, overlayStats, overlayTargetsMissing } from './overlay.js';
import { botsSaved } from './page.js';
import { checkHeldLogins, collisions, flushDueBots, humanInWorld, humanNames, installRouting, isReservedName, loadHumanNames, loadSave, routingTargetsMissing, storeWrites } from './routing.js';
import { BOT_COMMANDS, installScriptCommands } from './scripts.js';
import { botError, bots, disableBots, readBotsConfig } from './state.js';
import { botStore } from './store.js';

type WorldLifecycle = { start(skipMaps?: boolean, startCycle?: boolean): Promise<void>; cycle(): void };
const world = World as unknown as WorldLifecycle;

const check = { ticks: 0, hooks: false, botTicks: 0, keepAlive: false };

function install(): void {
    const missing = [...hookTargetsMissing(), ...overlayTargetsMissing(), ...routingTargetsMissing(), ...friendTargetsMissing()];
    if (typeof world.start !== 'function') missing.push('World.start');
    if (typeof world.cycle !== 'function') missing.push('World.cycle');
    if (missing.length) return disableBots(`the engine no longer has ${missing.join(', ')}`, 'mismatch');
    const taken = installScriptCommands();
    if (taken) return disableBots(taken, 'mismatch');

    // the overlay: after every load (entry.ts wraps load too, for the loading screen; this runs around that)
    const load = ScriptProvider.load;
    ScriptProvider.load = function (dir: string): number {
        const count = load.call(ScriptProvider, dir);
        if (count >= 0 && (bots.phase === 'installed' || bots.phase === 'started')) {
            let error: string | null;
            let code: 'mismatch' | 'failed' = 'mismatch';
            try {
                error = applyOverlay(dir, BOT_COMMANDS);
            } catch (e) {
                // never out of ScriptProvider.load: World.start would fail and the worker exit
                error = `the content-script overlay failed (${e instanceof Error ? e.message : e})`;
                code = 'failed';
            }
            if (error) {
                overlayStats.lastError = error;
                disableBots(error, code);
            }
        }
        return count;
    };

    installHooks();
    installRouting();
    installFriends();

    const start = world.start;
    world.start = async function (this: typeof World, skipMaps?: boolean, startCycle?: boolean) {
        await start.call(this, skipMaps, startCycle);
        startBots();
    };

    // runtime/ticker.ts owns World.cycle; a tick happened when currentTick moved (a paused tick is swallowed)
    const cycle = world.cycle;
    world.cycle = function (this: typeof World) {
        const tick = World.currentTick;
        cycle.call(this);
        if (World.currentTick === tick) return;
        try {
            if (botStore.loaded) flushDueBots(); // (also once the bots are off: the records of the ones that left)
            checkHeldLogins(); // (also once the bots are off: routing stays on for the names they had)
            if (botStore.loaded) friendsAfterTick();
            rollLogWindow();
        } catch (e) {
            botError('cycle', 'the bots glue failed after a tick', e);
        }
        if (bots.phase === 'started') {
            try {
                selfCheck();
            } catch (e) {
                botError('check', 'the bots self-check failed', e);
            }
        }
    };
    bots.phase = 'installed';
}

function startBots(): void {
    if (bots.phase !== 'installed') return; // switched off while the world started (e.g. the overlay did not match)
    if (overlayStats.applied === 0) return disableBots('the content-script overlay was not applied', 'mismatch');
    const t0 = performance.now();
    const store = botStore.load();
    if (!store.ok) return disableBots(`${store.error}; nothing may overwrite the bots' progress`, store.kind === 'unreadable' ? 'store-unreadable' : 'store-corrupt');
    const humanSaves = loadHumanNames();
    if (humanSaves) forgetDeletedCharacters(humanSaves);
    const { count, debug, spawnPerTick, pathSearchesPerTick, timing } = bots.config;
    try {
        BotManager.start(World, {
            count,
            members: Environment.node.members,
            debug,
            humanInWorld,
            isReservedName,
            loadSave,
            ...(spawnPerTick ? { spawnPerTick } : {}),
            ...(pathSearchesPerTick ? { pathSearchesPerTick } : {}),
            ...(timing ? { timing } : {}),
            // the living world (docs/BOTS.md §4.4): the pool starts with the saved bots; a pool bot without a record gets
            // an age (store.ts turns ageing on for every store, an older one included)
            ageNewBots: botStore.meta.ageing === true,
            // the living world as the last run left it: the same bots online, their sessions and absences
            world: botStore.meta.world,
            savedNames: () => botStore.botNames(),
            isQuit: name => botStore.isQuit(name),
            onQuit: name => botStore.quit(name),
            isFriendOfHuman
        });
    } catch (e) {
        console.error('[bots] BotManager.start failed', e);
        return disableBots('BotManager.start failed', 'failed');
    }
    bots.managerStarted = true;
    bots.phase = 'started';
    const saved = store.count ? `${store.count} saved in ${botStore.relPath()}${store.source === 'bak' ? ' (from the .bak)' : ''}` : 'none saved yet';
    console.info(`[bots] about ${count} bots online once a player is in the world (${saved}; ${overlayStats.scripts} scripts overlaid; ${(performance.now() - t0).toFixed(0)} ms)`);
}

// After the first ticks: BotManager ticked from the processPlayers hook (and processClientsIn ran), and once bots are in
// the world their keep-alive holds. If not, a hook did not take (e.g. an engine update renamed a method).
function selfCheck(): void {
    check.ticks++;
    if (!check.hooks && check.ticks >= 3) {
        const c = bots.counters;
        if (c.clientsIn < check.ticks - 1 || c.botTicks + c.tickFailures < check.ticks - 1) {
            return disableBots(`a hook did not take: ${check.ticks} ticks, but processClientsIn ran ${c.clientsIn} and processPlayers ${c.botTicks + c.tickFailures} times`, 'mismatch');
        }
        check.hooks = true;
    }
    if (check.keepAlive) return;
    const active = [...BotManager.activeBots()];
    if (!active.length || ++check.botTicks < 3) return;
    const now = World.currentTick; // already the next tick: the one just run refreshed them
    const stale = active.filter(p => now - p.lastResponse > 2 || now - p.lastConnected > 2);
    if (stale.length) return disableBots(`the keep-alive does not work (${stale.length} of ${active.length} bots are going stale)`, 'failed');
    check.keepAlive = true;
    if (bots.config.debug) console.info('[bots] self-check passed');
}

bots.config = readBotsConfig();
if (bots.config.count > 0) {
    limitRepeatedLogs();
    install();
}

/** Internals for test harnesses (test/bots.test.mjs); not used by the page. */
export const botsTest = {
    bots,
    check,
    BotManager,
    BotChat,
    /** told of every line a bot says (the real library speaks as typed lines, not Player.say) */
    sayListeners,
    botStore,
    overlayStats,
    collisions,
    /** the store's writes as the routing coalesces them: lastTick, held, coalesced, everyTicks */
    storeWrites,
    humanNames,
    friendStats,
    logLimits,
    botsSaved,
    botTickStats,
    botTickSummary,
    readBotsConfig,
    disableBots,
    ScriptProvider,
    ScriptRunner,
    InvType,
    MessagePublicHandler
};
