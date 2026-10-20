// Logging for the bot library. Upstream logs freely (≈330 console/log calls: ~24 lines per tick and a 600-line status
// dump every 100 ticks with 100 bots), and on iOS every worker log line is a postMessage to the page and a native log
// write. Bot modules keep writing `console.*` as upstream does, but import this object under that name
// (`import { botConsole as console } from '#/engine/bot/port/BotLog.js'`), which shadows the global in that module:
//   log / info / debug  only with BotStartOptions.debug;
//   warn / error        always, but at most ERROR_BURST lines per ERROR_WINDOW ticks (the rest are counted and
//                       summarised once per window). Errors also count towards BotManager.stats().errors.
// The global console is looked up at call time, so a harness that replaces console.* sees every line.

const ERROR_WINDOW = 100; // ticks
const ERROR_BURST = 10;

let debugEnabled = false;
let windowStart = 0;
let windowLines = 0;
let suppressed = 0;
let errorCount = 0;

export function configureBotLog(debug: boolean): void {
    debugEnabled = debug;
}

export function isBotDebug(): boolean {
    return debugEnabled;
}

/** Called once per tick by BotManager: advances the rate-limit window. */
export function botLogTick(tick: number): void {
    if (tick - windowStart < ERROR_WINDOW) {
        return;
    }
    if (suppressed > 0) {
        globalThis.console.warn(`[bots] ${suppressed} more bot warning/error lines in the last ${ERROR_WINDOW} ticks were not logged`);
    }
    windowStart = tick;
    windowLines = 0;
    suppressed = 0;
}

/** Number of error lines (logged or not) since the bots started. */
export function botErrorCount(): number {
    return errorCount;
}

function limited(level: 'warn' | 'error', args: unknown[]): void {
    if (level === 'error') {
        errorCount++;
    }
    if (debugEnabled || windowLines < ERROR_BURST) {
        windowLines++;
        globalThis.console[level](...args);
    } else {
        suppressed++;
    }
}

export const botConsole = {
    log(...args: unknown[]): void {
        if (debugEnabled) globalThis.console.log(...args);
    },
    info(...args: unknown[]): void {
        if (debugEnabled) globalThis.console.info(...args);
    },
    debug(...args: unknown[]): void {
        if (debugEnabled) globalThis.console.debug(...args);
    },
    warn(...args: unknown[]): void {
        limited('warn', args);
    },
    error(...args: unknown[]): void {
        limited('error', args);
    }
};
