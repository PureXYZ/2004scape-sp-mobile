// The bots' content overlay and script commands, put in place as the runtime does (runtime/bots/index.ts): the scripts
// compiled from bots/content (compile.mjs: a bot keeps its items when it dies, a bot answers a trade request) replace
// their vanilla entries through the runtime's own overlay.ts and the vfs it reads, and the two script commands
// (runtime/bots/scripts.ts) are declared. For the tests that run the world as the app does: trade.test, humanlike.
import { vfs } from '../../../src/shims/vfs.js';
import { applyOverlay, OVERLAY_PATH, overlayStats } from '../../../src/runtime/bots/overlay.js';
import { BOT_COMMANDS, installScriptCommands } from '../../../src/runtime/bots/scripts.js';

/** The overlay and the commands, as the runtime installs them (index.ts): returns the number of scripts replaced. */
export function installBotsContent(scriptsBin: Uint8Array, scriptDat: Uint8Array, scriptIdx: Uint8Array): number {
    vfs.put(OVERLAY_PATH, scriptsBin);
    vfs.put('data/pack/server/script.dat', scriptDat);
    vfs.put('data/pack/server/script.idx', scriptIdx);
    const taken = installScriptCommands();
    if (taken) throw new Error(taken);
    const error = applyOverlay('data/pack', BOT_COMMANDS);
    if (error) throw new Error(error);
    return overlayStats.scripts;
}
