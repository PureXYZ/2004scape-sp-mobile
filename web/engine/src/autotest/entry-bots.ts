// engine/engine-bots.js's entry in a test build (scripts/build-web.mjs --autotest; build.mjs bundles it in place of
// src/entry-bots.ts): the bots' entry as it is, plus autotest/perf.ts's measurements with the bots' share of every
// tick (BotManager.tick, as runtime/bots/hooks.ts times it) and their numbers (BotManager.stats(), the store's writes).
// It takes the place of entry-bots.ts's attach in this bundle's exports (a local export wins over export *).
import { attach as attachBots } from '../entry-bots.js';
import { botsTest } from '../runtime/bots/index.js';
import type { Post } from '../runtime/host.js';

import { answerPerf, setPerfExtra, watchPost } from './perf.js';

export * from '../entry-bots.js';

let botTicks = 0;
setPerfExtra({
    tickMs: () => {
        const t = botsTest.botTickStats;
        if (t.ticks === botTicks) return 0; // (no bots this tick: switched off, or none configured)
        botTicks = t.ticks;
        return t.durations[(t.ticks - 1) % t.durations.length];
    },
    state: () => {
        let stats: Record<string, unknown> = {};
        try {
            stats = botsTest.BotManager.stats() as unknown as Record<string, unknown>;
        } catch {
            // (the bots are off: no manager to ask)
        }
        // the counts only (a list of names would only grow the message)
        const numbers = Object.fromEntries(Object.entries(stats).filter(([, v]) => typeof v === 'number'));
        return { ...numbers, phase: botsTest.bots.phase, botTicks: botsTest.botTickStats.ticks, store: { ...botsTest.storeWrites } };
    }
});

export function attach(host: { post: Post }): ReturnType<typeof attachBots> {
    const post = watchPost(host.post);
    const handle = attachBots({ post });
    return msg => {
        if (msg?.type === 'lctest-perf') answerPerf(post, msg);
        else handle(msg);
    };
}
