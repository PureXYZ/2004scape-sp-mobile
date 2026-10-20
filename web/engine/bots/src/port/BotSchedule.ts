// Delayed bot actions (chat replies) counted in world ticks. Upstream used setTimeout, which fires while the world is
// paused (the app in the background) and after the engine stopped; these run inside BotManager.tick, so they wait
// for the world like everything else.
import { botConsole as console } from '#/engine/bot/port/BotLog.js';

interface Scheduled {
    due: number;
    run: () => void;
}

let queue: Scheduled[] = [];
let now = 0;

/** Runs `run` in the tick `ticks` from now (at least the next tick). */
export function scheduleInTicks(ticks: number, run: () => void): void {
    queue.push({ due: now + Math.max(1, Math.round(ticks)), run });
}

/** BotManager.tick: everything that is due. */
export function runScheduled(tick: number): void {
    now = tick;
    if (queue.length === 0) return;
    const due = queue.filter(s => s.due <= tick);
    if (due.length === 0) return;
    queue = queue.filter(s => s.due > tick);
    for (const s of due) {
        try {
            s.run();
        } catch (err) {
            console.error('[bots] a scheduled bot action failed', err);
        }
    }
}

/** Upstream's `delay + Math.random() * spread` milliseconds, in 600 ms ticks. */
export function msToTicks(ms: number): number {
    return Math.max(1, Math.round(ms / 600));
}
