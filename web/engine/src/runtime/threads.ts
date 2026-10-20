// In-process implementations of the engine's helper threads (see shims/worker_threads.ts). Must be imported
// before '#/engine/World.js': World constructs its Workers in field initialisers (World.ts:112-114).
import { registerThread, type ThreadFactory, type ThreadPort } from '../shims/worker_threads.js';
import Environment from '#/util/Environment.js';

import { vfs } from '../shims/vfs.js';
import { saves } from './saves.js';

// ---- LoginThread (LoginThread.ts, `login.enabled === false` branches) ----------------------------------------
// Same message contract; saves go straight to native storage (runtime/saves.ts) instead of data/players/.

/**
 * The staff level every login gets: world.json `staffModLevel` (0..4; Settings › World › Jmod sends 4 or 0) when
 * present, else the engine's own rule (LoginThread.ts:63-67: 4 unless production). 0 is a normal player: no `::`
 * commands, no crown in chat, the ordinary report-abuse options. boot.js merges init.config into world.json before
 * this module evaluates; WorldConfig drops keys it does not know, so Environment never has this one.
 */
function readStaffModLevel(): number {
    const fallback = Environment.node.production ? 0 : 4;
    try {
        const world = JSON.parse(new TextDecoder().decode(vfs.read('/engine/data/config/world.json'))) as { staffModLevel?: unknown };
        if (world?.staffModLevel === undefined) return fallback;
        const level = Math.trunc(Number(world.staffModLevel));
        if (Number.isFinite(level)) return Math.min(4, Math.max(0, level));
        console.warn(`[login] world.json staffModLevel ${JSON.stringify(world.staffModLevel)} is not a number; using ${fallback}`);
    } catch (e) {
        console.error(`[login] cannot read staffModLevel from world.json; using ${fallback}`, e);
    }
    return fallback;
}

export const staffModLevel = readStaffModLevel();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onLoginRequest(port: ThreadPort, msg: any) {
    switch (msg.type) {
        case 'world_startup':
        case 'world_heartbeat':
            return;
        case 'player_login': {
            const { socket, username, lowMemory, reconnecting } = msg;
            const head = { type: 'player_login', socket, username, lowMemory, reconnecting };
            if (Environment.login.enabled) {
                console.warn('[login] login.enabled=true is not supported offline; answering "login server offline"');
                port.postMessage({ ...head, reply: -1, save: null, account_id: -1, members: false });
                return;
            }
            const loaded = saves.load(username);
            if (loaded.status === 'error') {
                // refuse rather than start a new character that would overwrite the real save on logout
                console.error(`[login] cannot read the save of '${username}': ${loaded.error}`);
                port.postMessage({ ...head, reply: -1, save: null, account_id: -1, members: false });
                return;
            }
            port.postMessage({
                ...head,
                reply: loaded.status === 'ok' ? 0 : 4, // 4 = no save yet: World treats it as a new player
                staffmodlevel: staffModLevel,
                save: loaded.status === 'ok' ? loaded.data : null,
                account_id: 1,
                members: Environment.node.members
            });
            return;
        }
        case 'player_logout': {
            const { username, save } = msg;
            saves.write(username, save, 'logout');
            // Always acknowledge: World blocks the name from logging in again until it gets success (World.ts:1961-1970,
            // 2233-2238). A failed write is kept in memory, retried, and preferred by the next login of that name.
            port.postMessage({ type: 'player_logout', username, success: true });
            return;
        }
        case 'player_autosave':
            saves.write(msg.username, msg.save, 'autosave');
            return;
        case 'player_force_logout':
        case 'player_ban':
        case 'player_mute':
            return; // login-server operations, no-ops offline (LoginThread.ts:146-168)
        default:
            console.error(`[login] unknown message type '${msg.type}'`);
    }
}

registerThread(/LoginThread\.(ts|js)$/, port => {
    port.on('message', msg => {
        try {
            onLoginRequest(port, msg);
        } catch (e) {
            console.error('[login] request failed', e);
        }
    });
});

// ---- threads that have nothing to do offline --------------------------------------------------------------

const sink: ThreadFactory = () => {};
registerThread(/FriendThread\.(ts|js)$/, sink); // friend server disabled: FriendThread.ts is a no-op too
registerThread(/LoggerThread\.(ts|js)$/, sink); // logger disabled: LoggerThread.ts is a no-op too

// The client reads models/maps/anims/midi from its own copy of the cache (ARCHITECTURE.md §6), so the engine
// serves no on-demand traffic and OnDemandThread.ts is not bundled. A client that opens an on-demand connection
// anyway (opcode 15) gets no data.
registerThread(/OnDemandThread\.(ts|js)$/, port => {
    let warned = false;
    port.on('message', (msg: { type?: string }) => {
        if (msg?.type === 'request' && !warned) {
            warned = true;
            console.warn('[ondemand] the engine does not serve on-demand files in this build (the client reads its local cache)');
        }
    });
});

registerThread(/DevThread\.(ts|js)$/, (_port, worker) => {
    console.warn(`[engine] ${worker.url} (content live reload) is not available; set build.liveReload=false`);
});
