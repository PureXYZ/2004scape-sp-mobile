// The engine's measurements in a test build (scripts/build-web.mjs --autotest bundles src/autotest/entry.ts or
// entry-bots.ts in place of src/entry.ts and src/entry-bots.ts, so a normal build has none of this; build.mjs checks).
// For app-test --soak (web/test/autotest.js, docs/BUILDING.md §4): every tick's start, its duration as runtime/ticker.ts
// times it, the whole timer callback (with what the bots glue does after the tick) and World's own phase times
// (lastCycleStats, WorldStat order), kept in a ring; and the start-up's marks (the engine evaluated, World.start begun
// and done, the first tick, 'ready' sent). The page asks with {type:'lctest-perf', reqId, since} and gets every tick
// from `since` on (tick 0 = the world's first), as epoch milliseconds (performance.timeOrigin + now), so that the page
// can put them on its own clock.
//
// It wraps World.cycle once more, outside runtime/ticker.ts's guardedCycle (and the bots glue's after-tick work): World
// looks the method up on every reschedule, so an own property sees every tick. World.start is wrapped the same way.
// Neither wrapper changes what it calls, its arguments or its order; each tick adds two clock reads and a few typed-array
// writes.
import World from '#/engine/World.js';

import type { Post } from '../runtime/host.js';
import * as ticker from '../runtime/ticker.js';

const RING = 4096; // ticks: 41 minutes of world time
const PHASES = 12; // WorldStat (#/engine/WorldStat.ts): cycle, world, client in, npc, player, logout, login, zone, client out, cleanup, bandwidth in, out

const starts = new Float64Array(RING);
const tickMs = new Float32Array(RING);
const callbackMs = new Float32Array(RING);
const phases = new Uint16Array(RING * PHASES);
const extraMs = new Float32Array(RING);
let ticks = 0;

const epoch = () => performance.timeOrigin + performance.now();

/** Epoch ms of the start-up's steps, null until they happen. */
const marks = {
    evaluated: epoch(), // this module runs right after the engine's own modules (the entry's imports)
    worldStart: null as number | null,
    worldStarted: null as number | null,
    firstTickStart: null as number | null,
    firstTickEnd: null as number | null,
    ready: null as number | null
};

/** The bots bundle's share of each tick and its state (autotest/entry-bots.ts); none in engine.js. */
let extra: { tickMs: () => number; state: () => Record<string, unknown> } | null = null;

export function setPerfExtra(fn: typeof extra) {
    extra = fn;
}

type Cycle = (this: typeof World) => void;
const world = World as unknown as { cycle: Cycle; start: (skipMaps?: boolean, startCycle?: boolean) => Promise<void>; lastCycleStats: Uint16Array };

const cycle = world.cycle;
world.cycle = function (this: typeof World) {
    const counted = ticker.tickStats.ticks;
    const start = epoch();
    const t0 = performance.now();
    cycle.call(this);
    if (ticker.tickStats.ticks === counted) return; // paused or stopped: the ticker swallowed it
    const ms = performance.now() - t0;
    const i = ticks % RING;
    starts[i] = start;
    tickMs[i] = ticker.tickStats.durations[(ticker.tickStats.ticks - 1) % ticker.tickStats.durations.length];
    callbackMs[i] = ms;
    phases.set(world.lastCycleStats.subarray(0, PHASES), i * PHASES);
    extraMs[i] = extra ? extra.tickMs() : 0;
    if (ticks === 0) {
        marks.firstTickStart = start;
        marks.firstTickEnd = start + ms;
    }
    ticks++;
};

const start = world.start;
world.start = async function (this: typeof World, skipMaps?: boolean, startCycle?: boolean) {
    marks.worldStart = epoch();
    try {
        await start.call(this, skipMaps, startCycle);
    } finally {
        marks.worldStarted = epoch();
    }
};

/** The entry's post, noting when 'ready' goes out. */
export function watchPost(post: Post): Post {
    return (msg, transfer) => {
        if (msg.type === 'ready') marks.ready = epoch();
        post(msg, transfer);
    };
}

/** {type:'lctest-perf'}: the ticks since `since` (at most the ring), the marks and the world's counts. */
export function answerPerf(post: Post, msg: { [k: string]: unknown }): void {
    const from = Math.max(0, Math.min(ticks, Math.trunc(Number(msg.since) || 0)), ticks - RING);
    const n = ticks - from;
    const start = new Array<number>(n);
    const tick = new Array<number>(n);
    const callback = new Array<number>(n);
    const extraTick = new Array<number>(n);
    const phase = new Array<number>(n * PHASES);
    for (let k = 0; k < n; k++) {
        const i = (from + k) % RING;
        start[k] = starts[i];
        tick[k] = +tickMs[i].toFixed(3);
        callback[k] = +callbackMs[i].toFixed(3);
        extraTick[k] = +extraMs[i].toFixed(3);
        for (let p = 0; p < PHASES; p++) phase[k * PHASES + p] = phases[i * PHASES + p];
    }
    (post as (m: unknown) => void)({
        type: 'lctest-perf',
        reqId: msg.reqId,
        ticks,
        from,
        start,
        tickMs: tick,
        callbackMs: callback,
        phases: phase,
        extraMs: extra ? extraTick : null,
        marks,
        timeOrigin: performance.timeOrigin,
        state: ticker.tickerState(),
        clamps: ticker.tickStats.clamps,
        droppedMs: ticker.tickStats.droppedMs,
        players: World.getTotalPlayers(),
        npcs: World.getTotalNpcs(),
        extra: extra ? extra.state() : null
    });
}
