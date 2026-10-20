// Repeated error and warning lines, limited (engine-bots.js only). World.processPlayers catches an error in a player's
// turn and logs it (World.ts: console.error(err)); for a human it then logs the player out, so it is logged once. A bot
// has no client and BotManager keeps it in the world, so the same error would be logged every tick for the rest of the
// session, each line a stack trace that boot.js posts to the page and the page to the native log (ScriptRunner's
// errors are six lines each, the same way). So every console.error / console.warn line of the worker is shown at most
// PER_WINDOW times in a window of WINDOW_TICKS world ticks; further lines with the same first line (printError's time
// stamp aside) in that window are counted instead, and one summary line when the window ends says how many were not
// shown and which. A line seen for the first time is always shown, and so is everything once the engine exited.
// Counted in bots.counters: engineErrors, engineWarnings, linesNotShown.
import World from '#/engine/World.js';

import { hasExited } from '../../shims/globals.js';
import { testOptions } from '../options.js';
import { bots } from './state.js';

type Level = 'error' | 'warn';
type Log = (...args: unknown[]) => void;

/** Ticks per window (test override: __LC_ENGINE_TEST__.botsLogWindowTicks), and how often a line is shown in one. */
const WINDOW_TICKS = Math.max(1, Math.trunc(Number((testOptions as { botsLogWindowTicks?: number }).botsLogWindowTicks) || 100));
const PER_WINDOW = 3;
/** Distinct lines kept count of in a window; past that a new line is shown, and not counted. */
const MAX_KEYS = 256;

const shown: Record<Level, Log> = { error: () => {}, warn: () => {} };
const counts = new Map<string, number>(); // `${level} ${first line}` -> lines in this window
let windowIndex = -1;
let notShown = 0;
let errorsNotShown = 0;

export const logLimits = { windowTicks: WINDOW_TICKS, perWindow: PER_WINDOW, summaries: 0 };

// printError (Logger.ts) starts its line with kleur-coloured `${toLocaleDateString()} ${toLocaleTimeString()}\t`
const ANSI = /\x1b\[[0-9;]*m/g;
const STAMP = /^[^\t\n]*\d{1,2}[:.]\d{2}[:.]\d{2}[^\t\n]*\t\s*/;

function argText(a: unknown): string {
    if (typeof a === 'string') return a;
    if (a !== null && typeof a === 'object' && typeof (a as Error).message === 'string' && 'stack' in a) return `${(a as Error).name ?? 'Error'}: ${(a as Error).message}`;
    if (a === null || typeof a !== 'object') return String(a);
    return Object.prototype.toString.call(a);
}

/** What makes two lines "the same": the first line of the text boot.js would post. */
function firstLine(args: unknown[]): string {
    let text = '';
    for (const a of args) {
        text += (text ? ' ' : '') + argText(a);
        if (text.includes('\n') || text.length > 300) break;
    }
    const nl = text.indexOf('\n');
    return (nl >= 0 ? text.slice(0, nl) : text).replace(ANSI, '').replace(STAMP, '').slice(0, 300);
}

function summarise(): void {
    if (notShown > 0) {
        const repeated = [...counts].filter(([, n]) => n > PER_WINDOW).sort((a, b) => b[1] - a[1]);
        const which = repeated.slice(0, 3).map(([key, n]) => `${n - PER_WINDOW}× "${key.slice(key.indexOf(' ') + 1, key.indexOf(' ') + 141)}"`);
        if (repeated.length > 3) which.push(`${repeated.length - 3} more`);
        const kind = errorsNotShown === notShown ? 'error' : errorsNotShown > 0 ? 'error and warning' : 'warning';
        const from = windowIndex * WINDOW_TICKS;
        (errorsNotShown > 0 ? shown.error : shown.warn)(
            `[engine] ${notShown} repeated ${kind} lines were not shown in ticks ${from}-${from + WINDOW_TICKS - 1} (a line is shown ${PER_WINDOW} times per ${WINDOW_TICKS} ticks): ${which.join(', ')}`
        );
        logLimits.summaries++;
    }
    notShown = 0;
    errorsNotShown = 0;
}

/** After every tick (index.ts), and before every line: a window that ended gets its summary. */
export function rollLogWindow(): void {
    const w = Math.floor(World.currentTick / WINDOW_TICKS);
    if (w === windowIndex) return;
    summarise();
    windowIndex = w;
    counts.clear();
}

function admit(level: Level, args: unknown[]): boolean {
    if (level === 'error') bots.counters.engineErrors++;
    else bots.counters.engineWarnings++;
    if (hasExited()) {
        summarise(); // the session's last lines: all of them, after what was held back
        return true;
    }
    rollLogWindow();
    const key = `${level} ${firstLine(args)}`;
    const n = (counts.get(key) ?? 0) + 1;
    if (n <= PER_WINDOW) {
        if (n > 1 || counts.size < MAX_KEYS) counts.set(key, n);
        return true;
    }
    counts.set(key, n);
    notShown++;
    if (level === 'error') errorsNotShown++;
    bots.counters.linesNotShown++;
    return false;
}

/** Wraps console.error / console.warn (boot.js's, which post each line to the page). Once, when the bots are on. */
export function limitRepeatedLogs(): void {
    const target = console as unknown as Record<Level, Log>;
    for (const level of ['error', 'warn'] as const) {
        const log = target[level];
        if (typeof log !== 'function') continue;
        shown[level] = (...args) => log.apply(console, args);
        target[level] = (...args: unknown[]) => {
            let show = true;
            try {
                show = admit(level, args);
            } catch {
                // the limiter never costs a line
            }
            if (show) shown[level](...args);
        };
    }
}
