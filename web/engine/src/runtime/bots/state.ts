// State shared by the bots glue (engine-bots.js only; docs/BOTS.md §4.3): the settings from world.json, the phase the
// bots are in, and how they are switched off for the session when something does not work - the world keeps running
// without them, never the other way round.
import { BotManager } from '#/engine/bot/BotManager.js';

import { vfs } from '../../shims/vfs.js';
import { postBotsOff, type BotsOffReason } from './page.js';

/** The roster's size (docs/BOTS.md §4.6); boot.js clamps init.config.bots.count to it as well. */
export const MAX_BOTS = 1000;

export interface BotsConfig {
    /** bots in the world (0 = off) */
    count: number;
    /** verbose bot logging (world.json bots.debug; errors are always logged) */
    debug: boolean;
    /** spawns per tick (world.json bots.spawnPerTick; the library's default when absent) */
    spawnPerTick?: number;
    /** path searches per tick for all bots (world.json bots.pathSearchesPerTick, for measuring; the library's default when absent) */
    pathSearchesPerTick?: number;
    /** session durations in ticks (world.json bots.timing, for tests: port/BotSessions.ts; the library checks them) */
    timing?: Record<string, unknown>;
}

/**
 * bots.* from the merged world.json: boot.js deep-merges init.config into it, and WorldConfig drops keys it does not
 * know, so Environment never has them.
 */
export function readBotsConfig(): BotsConfig {
    try {
        const world = JSON.parse(new TextDecoder().decode(vfs.read('/engine/data/config/world.json'))) as { bots?: { count?: unknown; debug?: unknown; spawnPerTick?: unknown; pathSearchesPerTick?: unknown; timing?: unknown } };
        const bots = world?.bots ?? {};
        const n = Math.trunc(Number(bots.count ?? 0));
        const perTick = Math.trunc(Number(bots.spawnPerTick));
        const searches = Math.trunc(Number(bots.pathSearchesPerTick));
        return {
            count: Number.isFinite(n) ? Math.min(MAX_BOTS, Math.max(0, n)) : 0,
            debug: bots.debug === true,
            spawnPerTick: Number.isFinite(perTick) && perTick > 0 ? perTick : undefined,
            pathSearchesPerTick: Number.isFinite(searches) && searches > 0 ? searches : undefined,
            timing: bots.timing && typeof bots.timing === 'object' && !Array.isArray(bots.timing) ? (bots.timing as Record<string, unknown>) : undefined
        };
    } catch (e) {
        console.error('[bots] cannot read bots from world.json: bots are off', e);
        return { count: 0, debug: false };
    }
}

export type Phase = 'off' | 'installed' | 'started' | 'disabled';

export const bots = {
    config: { count: 0, debug: false } as BotsConfig,
    phase: 'off' as Phase,
    /** why the bots were switched off for this session */
    disabledReason: null as string | null,
    /** the same, as the page hears it ({type:'bots', active:false, reason}: runtime/bots/page.ts) */
    disabledCode: null as BotsOffReason | null,
    /** BotManager.start succeeded: from then on its names are routed (also after the bots were switched off) */
    managerStarted: false,
    /** names the glue asked to leave (a human took the name, or the bots were switched off) */
    retiring: new Set<string>(),
    counters: {
        clientsIn: 0,
        botTicks: 0,
        tickFailures: 0,
        errors: 0,
        publicChats: 0,
        privateChats: 0,
        privateConsumed: 0,
        friendsOnline: 0,
        /** console.error / console.warn lines in the worker (the engine's and the bots'), and those not shown (logs.ts) */
        engineErrors: 0,
        engineWarnings: 0,
        linesNotShown: 0
    }
};

/** Bots spawn, tick and are routed (BotManager.start succeeded and nothing switched them off). */
export function botsActive(): boolean {
    return bots.phase === 'started';
}

const errorCounts = new Map<string, number>();

/** An error from bot code or a hook body: always logged, but at most 3 times per kind (then counted). */
export function botError(kind: string, message: string, e?: unknown): void {
    bots.counters.errors++;
    const n = (errorCounts.get(kind) ?? 0) + 1;
    errorCounts.set(kind, n);
    if (n <= 3) console.error(`[bots] ${message}${n === 3 ? ` (further '${kind}' errors are counted, not logged)` : ''}`, ...(e === undefined ? [] : [e]));
}

/**
 * Switch the bots off for this session, with one logged error and one message to the page (`code`: what host.js tells
 * the player). Bots in the world leave through the normal logout path (their saves still go to the bot store); every
 * hook turns into a pass-through.
 */
export function disableBots(reason: string, code: BotsOffReason = 'failed'): void {
    if (bots.phase === 'disabled') return;
    const wasStarted = bots.phase === 'started';
    bots.phase = 'disabled';
    bots.disabledReason = reason;
    bots.disabledCode = code;
    console.error(`[bots] bots are off for this session: ${reason}`);
    postBotsOff(code, reason);
    if (!wasStarted) return;
    try {
        for (const p of [...BotManager.activeBots()]) {
            if (BotManager.retire(p.username)) bots.retiring.add(p.username);
        }
    } catch (e) {
        botError('disable', 'sending the bots out of the world failed', e);
    }
}
