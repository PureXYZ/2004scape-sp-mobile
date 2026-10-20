// Engine worker entry, bundled by build.mjs into engine/engine.js. boot.js preloads the virtual file system, then
// imports this module and calls attach() to hand over the page protocol (ARCHITECTURE.md §4):
//   page -> engine  start | connect | data | close | lifecycle (pause/resume/save) | delete
//   engine -> page  progress | ready | data | close | lifecycle-done | delete-done | exit      (log/booted come from boot.js)
//
// Import order matters: engine modules read the vfs and construct their helper Workers while they evaluate.
import './shims/vfs-guard.js';
import './runtime/patches.js';
import { staffModLevel } from './runtime/threads.js';

import World from '#/engine/World.js';
import OnDemand from '#/engine/OnDemand.js';
import { NetworkPlayer, isClientConnected } from '#/engine/entity/NetworkPlayer.js';
import Player from '#/engine/entity/Player.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import Packet from '#/io/Packet.js';
import NullClientSocket from '#/server/NullClientSocket.js';
import Environment from '#/util/Environment.js';
import { toSafeName } from '#/util/JString.js';

import bzip2 from './shims/bzip2.js';
import { EngineExit, __lc_exit, hasExited, setExitHandler } from './shims/globals.js';
import { getStore, vfs } from './shims/vfs.js';
import { progress, send, setPost, type Post } from './runtime/host.js';
import { testOptions } from './runtime/options.js';
import { flatGjstr, originalGjstr } from './runtime/patches.js';
import { saves } from './runtime/saves.js';
import * as ticker from './runtime/ticker.js';
import * as transport from './runtime/transport.js';
import { xhrSync } from './runtime/xhr.js';

// ---- vfs: evicted files are fetched again on demand (only the ::reload cheat reads data after start) ----------
getStore().loadSync = (abs, url) => {
    const r = xhrSync('GET', url);
    if (r.status === 200 && r.data) {
        console.info(`[vfs] re-fetched ${abs} (${r.data.length} bytes)`);
        return r.data;
    }
    console.error(`[vfs] cannot re-fetch ${abs} from ${url}: HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`);
    return null;
};

// ---- start-up progress for the loading screen (World.start is one long synchronous call) --------------------
type StartState = 'not-started' | 'starting' | 'started';
let startState: StartState = 'not-started';

const proto = Object.getPrototypeOf(World) as { reload: (clearInvs?: boolean) => void };
(World as unknown as { reload: (clearInvs?: boolean) => void }).reload = function (clearInvs?: boolean) {
    if (startState === 'starting') progress('start', 'Loading game configuration');
    proto.reload.call(World, clearInvs);
    // ::reload (ClientCheatHandler.ts:150) re-reads every pack through the vfs; drop them again afterwards
    if (startState === 'started') releaseStartupData('reload');
};

const realScriptLoad = ScriptProvider.load;
ScriptProvider.load = function (dir: string) {
    if (startState === 'starting') progress('start', 'Loading scripts');
    return realScriptLoad.call(ScriptProvider, dir);
};

const gameMap = World.gameMap as unknown as { init: () => void };
const realMapInit = gameMap.init;
gameMap.init = function () {
    if (startState === 'starting') progress('start', 'Loading the world map');
    realMapInit.call(gameMap);
};

// ---- memory: drop what only start-up needed --------------------------------------------------------------
let released = { files: 0, bytes: 0 };

function releaseStartupData(why: string) {
    if (testOptions.release === false) return;
    // Every preloaded file can be fetched again from the app bundle, so none has to stay resident: the map zip
    // (15 MB) and CSVs are only read by GameMap.init, the packs and the cache only by World.reload (::reload).
    const freed = vfs.evictReloadable();
    // OnDemand.cache keeps the 9 archive-0 files it read for the CRC table; nothing reads them again here
    for (const list of OnDemand.cache.packed) list.length = 0;
    const hadWasm = bzip2.kind === 'wasm';
    bzip2.release();
    released = { files: released.files + freed.files, bytes: released.bytes + freed.bytes };
    if (freed.files || hadWasm) {
        console.info(`[engine] ${why}: released ${freed.files} data files (${(freed.bytes / 1048576).toFixed(1)} MB)${hadWasm ? ' and the WASM bzip2 instance' : ''}`);
    }
}

// ---- saves -----------------------------------------------------------------------------------------------

/** Save every player now and retry earlier failed writes. Synchronous: returns once storage has answered. */
export function saveAll(reason: string): { ok: boolean; error?: string } {
    const failed = new Set<string>();
    if (startState === 'started') {
        for (const player of World.playerLoop.all()) {
            let bytes: Uint8Array;
            try {
                bytes = player.save();
            } catch (e) {
                console.error(`[save] ${player.username}: save() failed`, e);
                failed.add(player.username);
                continue;
            }
            if (!saves.write(player.username, bytes, reason)) failed.add(player.username);
        }
        // logged-out players whose save World has not handed to the login thread yet (normally none: it does so
        // within the same tick) - e.g. after a crash removed everyone right before process.exit
        for (const [username, request] of [...World.logoutRequests]) {
            if (saves.write(username, request.save, `${reason}, pending logout`)) {
                World.onLoginMessage({ type: 'player_logout', username, success: true });
            } else {
                failed.add(username);
            }
        }
    }
    for (const username of saves.retryPending(reason)) failed.add(username);
    return failed.size ? { ok: false, error: `could not write the save of ${[...failed].join(', ')}` } : { ok: true };
}

// ---- exit (process.exit shim) ----------------------------------------------------------------------------

setExitHandler(code => {
    ticker.stop();
    try {
        const r = saveAll('exit');
        if (!r.ok) console.error(`[engine] exit: ${r.error}`);
    } catch (e) {
        console.error('[engine] exit: saving players failed', e);
    }
    transport.closeAll();
    console.error(`[engine] stopped (process.exit(${code}))`);
    send({ type: 'exit', code });
});

// ---- page protocol ---------------------------------------------------------------------------------------

async function startWorld() {
    if (startState !== 'not-started') {
        console.warn('[engine] start: the world is already started');
        return;
    }
    startState = 'starting';
    const t0 = performance.now();
    progress('start', 'Starting the world');
    try {
        await World.start(false, false); // no OnDemandThread, and the tick loop is ours (runtime/ticker.ts)
    } catch (e) {
        if (!(e instanceof EngineExit)) {
            console.error('[engine] World.start failed', e);
            try {
                __lc_exit(1);
            } catch {
                // EngineExit
            }
        }
        return;
    }
    if (hasExited()) return;
    startState = 'started';
    releaseStartupData('start');
    try {
        ticker.begin();
    } catch (e) {
        if (!(e instanceof EngineExit)) throw e;
    }
    if (hasExited()) return;
    const ms = performance.now() - t0;
    console.info(`[engine] world ready in ${ms.toFixed(0)} ms: ${World.getTotalNpcs()} npcs, ${World.gameMap.getTotalZones()} zones, ${World.gameMap.getTotalLocs()} locs`);
    send({ type: 'ready', ms });
}

// native lifecycle names the host may pass straight through (ARCHITECTURE.md §7)
const LIFECYCLE_ALIASES: Record<string, string> = { background: 'pause', terminate: 'pause', foreground: 'resume' };

function lifecycle(reqId: unknown, event: string) {
    let result: { ok: boolean; error?: string };
    try {
        switch (LIFECYCLE_ALIASES[event] ?? event) {
            case 'pause':
                ticker.pause();
                result = saveAll('pause');
                break;
            case 'resume':
                ticker.resume();
                result = { ok: true };
                if (saves.pending.size) saves.retryPending('resume');
                break;
            case 'save':
                result = saveAll('save');
                break;
            default:
                result = { ok: false, error: `unknown lifecycle event '${event}'` };
        }
    } catch (e) {
        result = { ok: false, error: e instanceof EngineExit ? 'engine exited' : String(e) };
    }
    send({ type: 'lifecycle-done', reqId, ...result });
}

// Settings › Saved data deletes a character here, not from the page: the engine may hold a newer save of it in memory
// (a write that failed and is retried), which would bring the character back. One in the world is never deleted.
function deleteCharacter(reqId: unknown, name: unknown) {
    let result: { ok: boolean; error?: string };
    const username = typeof name === 'string' ? toSafeName(name) : '';
    if (!username) {
        result = { ok: false, error: 'no character name' };
    } else if (World.getPlayerByUsername(username) || World.logoutRequests.has(username)) {
        result = { ok: false, error: 'in-world' };
    } else {
        const error = saves.delete(username);
        result = error === null ? { ok: true } : { ok: false, error };
    }
    send({ type: 'delete-done', reqId, ...result });
}

type PageMessage =
    | { type: 'start' }
    | { type: 'connect'; id: number }
    | { type: 'data'; id: number; data: ArrayBuffer | ArrayBufferView }
    | { type: 'close'; id: number }
    | { type: 'lifecycle'; reqId: unknown; event: string }
    | { type: 'delete'; reqId: unknown; name: string }
    | { type: string; [k: string]: unknown };

function handleMessage(msg: PageMessage) {
    if (!msg || typeof msg !== 'object') return;
    if (hasExited()) {
        if (msg.type === 'lifecycle') send({ type: 'lifecycle-done', reqId: (msg as { reqId: unknown }).reqId, ok: false, error: 'engine has exited' });
        if (msg.type === 'delete') send({ type: 'delete-done', reqId: (msg as { reqId: unknown }).reqId, ok: false, error: 'engine has exited' });
        return;
    }
    try {
        switch (msg.type) {
            case 'data': {
                const m = msg as { id: number; data: ArrayBuffer | ArrayBufferView };
                transport.receive(m.id, m.data);
                break;
            }
            case 'connect':
                transport.connect((msg as { id: number }).id);
                break;
            case 'close':
                transport.remoteClose((msg as { id: number }).id);
                break;
            case 'lifecycle': {
                const m = msg as { reqId: unknown; event: string };
                lifecycle(m.reqId, m.event);
                break;
            }
            case 'delete': {
                const m = msg as { reqId: unknown; name: unknown };
                deleteCharacter(m.reqId, m.name);
                break;
            }
            case 'start':
                void startWorld();
                break;
            default:
                console.warn(`[engine] ignoring unknown message type '${msg.type}'`);
        }
    } catch (e) {
        if (!(e instanceof EngineExit)) console.error(`[engine] '${msg.type}' failed`, e);
    }
}

/** Called once by boot.js after this module evaluated: wires the page protocol, returns the message handler. */
export function attach(host: { post: Post }): (msg: PageMessage) => void {
    setPost(host.post);
    const n = Environment.node;
    console.info(
        `[engine] Engine-TS ${Environment.engine.revision}: node ${n.id}, ${n.members ? 'members' : 'free'}, production=${n.production}, staffModLevel=${staffModLevel}, debug=${n.debug}, xpRate=${n.xpRate}, profile=${n.profile}, bzip2=${bzip2.kind}`
    );
    return handleMessage;
}

/** Internals for test harnesses (test/); not used by the page. */
export const __test = {
    World,
    Player,
    NetworkPlayer,
    NullClientSocket,
    Packet,
    OnDemand,
    Environment,
    isClientConnected,
    vfs,
    saves,
    saveAll,
    bzip2,
    ticker,
    transport,
    testOptions,
    gjstr: { flat: flatGjstr, original: originalGjstr },
    released: () => released
};
