// Drives World.cycle() (World.ts:340-527) without OnDemandThread and with pause/resume and a drift clamp.
//
// World.cycle reschedules itself with setTimeout(this.cycle.bind(this), delay) and compensates drift: after a
// freeze of P ms it runs ~P/600 ticks back to back (a 60 s iOS suspension = 100 ticks in ~1 s, which also trips
// the 100-tick no-response forced logout, World.ts:744). Because `this.cycle` is looked up on every reschedule,
// an own-property wrapper on the World instance sees every tick, and it:
//   - drops missed ticks: more than 5 ticks late -> nextTick = now (no catch-up burst). Smaller lateness keeps
//     upstream's compensation, so the average rate stays at 600 ms under normal jitter;
//   - pauses: a tick that fires while paused is swallowed, which ends the setTimeout chain;
//   - resumes: rebases the clock (nextTick = now + tickRate) and restarts the chain if it had ended;
//   - stops for good after process.exit (EngineExit is swallowed here, not thrown out of a timer).
import World from '#/engine/World.js';

import { EngineExit, __lc_exit } from '../shims/globals.js';

type State = 'idle' | 'running' | 'paused' | 'stopped';

const MAX_LATE_TICKS = 5;
const SAMPLES = 1024;

const realCycle = Object.getPrototypeOf(World).cycle as (this: typeof World) => void;

let state: State = 'idle';
let pausedBeforeStart = false;
let timerPending = false; // a setTimeout that will call World.cycle is outstanding (engine's or ours)
let lastTickStart = 0;

export const tickStats = {
    ticks: 0,
    clamps: 0,
    droppedMs: 0,
    durations: new Float64Array(SAMPLES), // ring buffer of the last SAMPLES tick durations (ms)
    maxMs: 0
};

function guardedCycle(this: typeof World) {
    timerPending = false;
    if (state !== 'running') return;
    const now = Date.now();
    const late = now - World.nextTick;
    if (World.tickRate > 0 && late > MAX_LATE_TICKS * World.tickRate) {
        tickStats.clamps++;
        tickStats.droppedMs += late;
        World.nextTick = now;
    }
    lastTickStart = now;
    const t0 = performance.now();
    try {
        realCycle.call(World);
        timerPending = true; // a completed cycle() always ends with setTimeout(this.cycle.bind(this), ...)
    } catch (e) {
        if (!(e instanceof EngineExit)) {
            // World.cycle handles its own errors (and exits); something failed around that handling
            console.error('[engine] tick failed', e);
            try {
                __lc_exit(1);
            } catch {
                // EngineExit
            }
        }
        state = 'stopped';
        return;
    }
    const ms = performance.now() - t0;
    tickStats.durations[tickStats.ticks % SAMPLES] = ms;
    tickStats.ticks++;
    if (ms > tickStats.maxMs) tickStats.maxMs = ms;
}

(World as unknown as { cycle: typeof guardedCycle }).cycle = guardedCycle;

function schedule(delay: number) {
    timerPending = true;
    setTimeout(() => World.cycle(), Math.max(0, delay));
}

/** First tick, after World.start(skipMaps=false, startCycle=false). Mirrors World.ts:330-335 minus OnDemand.cycle(). */
export function begin() {
    if (state !== 'idle') return;
    World.nextTick = Date.now() + World.tickRate;
    if (pausedBeforeStart) {
        state = 'paused';
        return;
    }
    state = 'running';
    World.cycle(); // the first tick runs synchronously, as upstream
}

export function pause() {
    if (state === 'running') state = 'paused';
    else if (state === 'idle') pausedBeforeStart = true;
}

export function resume() {
    if (state === 'idle') {
        pausedBeforeStart = false;
        return;
    }
    if (state !== 'paused') return;
    state = 'running';
    // rebase: time spent paused (or frozen) is not owed to the world
    const now = Date.now();
    World.nextTick = now + World.tickRate;
    if (!timerPending) schedule(lastTickStart + World.tickRate - now);
}

export function stop() {
    state = 'stopped';
}

export function tickerState(): State {
    return state;
}

export function tickSummary() {
    const n = Math.min(tickStats.ticks, SAMPLES);
    const d = Array.from(tickStats.durations.subarray(0, n)).sort((a, b) => a - b);
    const pick = (q: number) => (n ? +d[Math.min(n - 1, Math.floor(q * n))].toFixed(2) : 0);
    const avg = n ? +(d.reduce((a, b) => a + b, 0) / n).toFixed(2) : 0;
    return { ticks: tickStats.ticks, samples: n, avgMs: avg, p50Ms: pick(0.5), p95Ms: pick(0.95), maxMs: +tickStats.maxMs.toFixed(2), clamps: tickStats.clamps, droppedMs: tickStats.droppedMs };
}
