// Where the bots' saves go and who gets a name (docs/BOTS.md §4.5, §4.6), on top of runtime/saves.ts and the login
// thread without changing either (engine.js has neither of these wrappers):
//
//  - saves.write: a save of a name BotManager.ownsName() goes into the bot store (store.ts) instead of a
//    players/<profile>/ PUT - whichever path produced it (logout and the 15-minute autosave through the login thread,
//    lifecycle pause/save and exit through entry.saveAll) - and counts as written: lifecycle-done.ok is about the
//    human's saves only (lifecycle-done.bots says whether the store was written: page.ts). The store is written whole,
//    after the human saves, at every save occasion: at the end of saveAll (lifecycle pause/background/save: the app
//    leaving the foreground, Save now, the page's autosave, Reset world's pause; and the exit; its last step is
//    saves.retryPending), and on the microtask after the login thread's batch for the engine's 15-minute autosave and
//    for a human's logout. A bot's own logout (the living world's comings and goings: about 1.3 a second at 1000
//    online) only updates its record in memory: the store is written for those at most once every STORE_WRITE_TICKS
//    world ticks (30 s), the first one at once, the rest with the first tick that is due (docs/BOTS.md §4.5; one write
//    of 1.15 MB at 1000 bots a tick with a logout was about 5 GB an hour, twice that on Android, whose .bak is a copy:
//    docs/ANDROID.md §1). A record waiting for that write is lost only with the process (a crash or a kill without a
//    pause first), like the newest moves of every bot since its last save.
//  - World.onLoginMessage: a human logging in with the name of a bot in the world (the login thread already answered
//    "new player": the bot's save is not in players/) waits while the bot leaves through the normal logout path; once
//    its final save is in the store the name is released and the login answered. After ~10 s, counted in world ticks
//    (a paused world holds the login for as long as it is paused), it is refused like an account that is already
//    online (World answers 5). Reply ordering is the login thread's: the bot's logout acknowledgement reaches World
//    before the held login reply is passed on, so World no longer sees the name as logging out.
//  - the human names a bot must not take: human saves in players/<profile>/ (one GET of /save-index when the bots
//    start), names saved or logged in this session, humans online. A login with no save (a new character) brings a
//    few newcomers into the world after it (BotManager.newCharacter).
import { BotManager } from '#/engine/bot/BotManager.js';
import { NetworkPlayer } from '#/engine/entity/NetworkPlayer.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import World from '#/engine/World.js';
import Packet from '#/io/Packet.js';
import { toSafeName } from '#/util/JString.js';

import { hasExited } from '../../shims/globals.js';
import { testOptions } from '../options.js';
import { saves } from '../saves.js';
import { xhrSync } from '../xhr.js';
import { botError, bots } from './state.js';
import { botStore } from './store.js';

type LoginReply = { type: 'player_login'; username: string; socket: string; reply: number; [k: string]: unknown };
type LoginMessage = LoginReply | { type: 'player_logout'; username: string; success: boolean } | { type: string; username: string; [k: string]: unknown };
type WorldLogin = { onLoginMessage(msg: LoginMessage): void };
const world = World as unknown as WorldLogin;

/**
 * How many world ticks a human's login waits for the bot with that name to leave: 17 = ~10 s at 600 ms (test override:
 * __LC_ENGINE_TEST__.botsCollisionTicks). Ticks, not a timer: the bot leaves in a tick, and while the world is paused
 * (the app in the background) it cannot, so a timer would refuse a login that only had to wait for the resume.
 */
const COLLISION_TICKS = Math.max(1, Math.trunc(Number((testOptions as { botsCollisionTicks?: number }).botsCollisionTicks) || 17));

export const humanNames = new Set<string>();
/** held: the logins waiting for a bot to leave, with the world tick and the time they started waiting. */
export const collisions = { held: new Map<string, { msg: LoginReply; tick: number; since: number }>(), yielded: 0, refused: 0, holdTicks: COLLISION_TICKS };

let onLoginMessage: (msg: LoginMessage) => void = () => {};

export function routingTargetsMissing(): string[] {
    const missing: string[] = [];
    for (const m of ['write', 'retryPending', 'profile'] as const) if (typeof saves[m] !== 'function') missing.push(`saves.${m}`);
    if (typeof world.onLoginMessage !== 'function') missing.push('World.onLoginMessage');
    if (!(World.loginRequests instanceof Map) || !(World.logoutRequests instanceof Map)) missing.push('World.loginRequests/logoutRequests');
    return missing;
}

/** A name whose saves belong to the bot store (only once BotManager.start succeeded; never throws). */
export function botOwnsName(username: string): boolean {
    if (!bots.managerStarted) return false;
    try {
        return BotManager.ownsName(username);
    } catch (e) {
        botError('owns', 'BotManager.ownsName failed', e);
        return false;
    }
}

/**
 * The fewest world ticks between two writes of the store for the bots' own logouts: 50 = 30 s at 600 ms (test override:
 * __LC_ENGINE_TEST__.botsStoreWriteTicks). Ticks, not a timer: a paused world (the app in the background) writes nothing
 * and owes nothing; its pause wrote the store anyway.
 */
const STORE_WRITE_TICKS = Math.max(1, Math.trunc(Number((testOptions as { botsStoreWriteTicks?: number }).botsStoreWriteTicks) || 50));

/** The store's writes as the routing makes them: the last one's world tick and how many logouts waited for one. */
export const storeWrites = { lastTick: -Infinity, held: 0, coalesced: 0, everyTicks: STORE_WRITE_TICKS };
/** Why the store waits for a write (the first bot logout since the last one), or null: none is due. */
let storeWriteDue: string | null = null;

/**
 * Writes the whole store now if anything changed (force), or, for a bot's own logout (force false), now only when the
 * last write was STORE_WRITE_TICKS ticks ago or more; else flushDueBots writes it once that many ticks have passed.
 * The living world (BotManager.exportWorld) goes with every write.
 */
function flushBots(reason: string, force: boolean): void {
    if (!botStore.dirty) {
        storeWriteDue = null; // (written meanwhile: a save occasion, the store's own retry, a resume)
        return;
    }
    if (!force && World.currentTick - storeWrites.lastTick < STORE_WRITE_TICKS) {
        storeWrites.held++;
        storeWriteDue ??= reason;
        return;
    }
    if (storeWriteDue !== null) {
        storeWrites.coalesced++;
        if (!force) reason = `${storeWriteDue}, held ${World.currentTick - storeWrites.lastTick} ticks`;
    }
    storeWriteDue = null;
    storeWrites.lastTick = World.currentTick;
    // the living world goes with the bots' saves, to continue after a restart (an older library has no exportWorld)
    try {
        const state = (BotManager as { exportWorld?: () => unknown }).exportWorld?.();
        if (state) botStore.meta.world = state;
    } catch (e) {
        botError('world', 'BotManager.exportWorld failed', e);
    }
    botStore.flush(reason);
}

/** After every world tick (index.ts): the write the bots' logouts have waited STORE_WRITE_TICKS ticks for. */
export function flushDueBots(): void {
    if (storeWriteDue === null) return;
    if (!botStore.dirty) {
        storeWriteDue = null;
        return;
    }
    if (World.currentTick - storeWrites.lastTick >= STORE_WRITE_TICKS) flushBots(storeWriteDue, false);
}

/** One write on the microtask after the current batch of saves (the login thread hands over a batch at once). */
let flushQueued: { reason: string; force: boolean } | null = null;

function queueFlush(reason: string, force: boolean): void {
    if (flushQueued) {
        // (a save occasion in the same batch, e.g. the 15-minute autosave of the human and the bots, writes at once)
        if (force && !flushQueued.force) flushQueued = { reason, force };
        return;
    }
    flushQueued = { reason, force };
    queueMicrotask(() => {
        const queued = flushQueued!;
        flushQueued = null;
        flushBots(queued.reason, queued.force);
    });
}

export function installRouting(): void {
    const write = saves.write;
    saves.write = function (this: typeof saves, username: string, save: Uint8Array, reason: string): boolean {
        if (botOwnsName(username)) {
            botStore.put(toSafeName(username), save);
            // a bot's own logout waits for the next write that is due; its autosave, a lifecycle save and the exit are
            // save occasions (saveAll's own flush comes first: saves.retryPending below)
            queueFlush(reason, reason !== 'logout');
            return true;
        }
        humanNames.add(toSafeName(username));
        const written = write.call(this, username, save, reason);
        // the human's logout and the engine's autosave are save occasions for the bots too (saveAll writes the store
        // itself: this one is then a no-op)
        queueFlush(`${reason} of a player`, true);
        return written;
    };

    const retryPending = saves.retryPending;
    saves.retryPending = function (this: typeof saves, reason = 'retry'): string[] {
        const failed = retryPending.call(this, reason);
        flushBots(reason, true);
        return failed;
    };

    const original = world.onLoginMessage;
    onLoginMessage = msg => original.call(World, msg);
    world.onLoginMessage = function (this: typeof World, msg: LoginMessage) {
        try {
            if (holdLogin(msg)) return;
        } catch (e) {
            botError('collision', 'the bot name check of a login failed', e);
        }
        const isNew = newCharacter(msg);
        original.call(this, msg);
        if (isNew) noteNewCharacter();
        if (msg?.type === 'player_logout' && msg.success === true) {
            try {
                afterLogout(msg.username);
            } catch (e) {
                botError('collision', 'releasing a bot name failed', e);
            }
        }
    };
}

/**
 * A human's login with no save that World will answer (its socket still waiting): a new character. Not a reconnect of
 * one that has not been saved yet. (The bots' own logins never come this way.) Asked before World handles the reply.
 */
function newCharacter(msg: LoginMessage): boolean {
    if (msg?.type !== 'player_login') return false;
    const login = msg as LoginReply;
    return login.reply === 4 && login.reconnecting !== true && World.loginRequests.has(login.socket);
}

function noteNewCharacter(): void {
    if (!bots.managerStarted || bots.phase !== 'started') return;
    try {
        BotManager.newCharacter();
    } catch (e) {
        botError('newchar', 'BotManager.newCharacter failed', e);
    }
}

function holdLogin(msg: LoginMessage): boolean {
    if (msg?.type !== 'player_login') return false;
    const login = msg as LoginReply;
    if (login.reply !== 0 && login.reply !== 4) return false; // refusals pass through
    const name = login.username;
    if (!botOwnsName(name) || !World.loginRequests.has(login.socket)) return false;
    humanNames.add(toSafeName(name));
    if (collisions.held.has(name)) {
        onLoginMessage({ ...login, reply: 3 }); // one login at a time for a name
        return true;
    }
    if (!World.getPlayerByUsername(name) && !World.logoutRequests.has(name)) {
        // the bot already left and its last save is in the store: the name is free
        release(name);
        return false;
    }
    BotManager.retire(name);
    bots.retiring.add(name);
    console.info(`[bots] ${name}: a player is logging in with this bot's name; the bot leaves the world and the name is theirs`);
    collisions.held.set(name, { msg: login, tick: World.currentTick, since: Date.now() });
    return true;
}

/** After every world tick (index.ts): a login that waited COLLISION_TICKS ticks for its bot is refused. */
export function checkHeldLogins(): void {
    for (const [name, held] of [...collisions.held]) {
        if (World.currentTick - held.tick >= COLLISION_TICKS) refuse(name);
    }
}

function refuse(name: string) {
    const held = collisions.held.get(name);
    if (!held) return;
    collisions.held.delete(name);
    collisions.refused++;
    console.warn(`[bots] ${name}: the bot did not leave within ${COLLISION_TICKS} ticks; the login is refused as for an account that is online`);
    if (!hasExited()) onLoginMessage({ ...held.msg, reply: 3 });
}

function release(name: string) {
    bots.retiring.delete(name);
    try {
        BotManager.release(name);
    } catch (e) {
        botError('release', 'BotManager.release failed', e);
    }
}

// World just accepted a logout acknowledgement: for a bot the glue sent away, its final save is in the store now
function afterLogout(name: string) {
    if (!bots.retiring.has(name) || World.getPlayerByUsername(name)) return;
    const held = collisions.held.get(name);
    // a human waits for this name: the store has the bot's final save before the name moves on (no-op if already
    // written); a bot sent away for another reason (the bots switched off) leaves like any other, its record in memory
    // until the next write that is due
    flushBots('a bot left', !!held);
    release(name);
    if (!held) return;
    collisions.held.delete(name);
    collisions.yielded++;
    console.info(`[bots] ${name}: the bot left after ${World.currentTick - held.tick} ticks (${Date.now() - held.since} ms); answering the login`);
    const isNew = newCharacter(held.msg);
    onLoginMessage(held.msg);
    if (isNew) noteNewCharacter();
}

// ---- for BotManager.start ------------------------------------------------------------------------------------

function workerBase(): string {
    const loc = (globalThis as unknown as { location?: { href?: string } }).location;
    return loc?.href ?? import.meta.url;
}

/** The human characters of this profile (players/<profile>/<name>.sav), with one GET of /save-index. Returns their
 *  names, or null if the index could not be read (then nobody knows which characters have a save). */
export function loadHumanNames(): Set<string> | null {
    const r = xhrSync('GET', new URL('../save-index', workerBase()).href);
    if (r.status !== 200 || !r.data) {
        console.warn(`[bots] /save-index: HTTP ${r.status}${r.error ? ` ${r.error}` : ''} - the saved characters' names are unknown (a bot with such a name gives it up at that character's login)`);
        return null;
    }
    try {
        const prefix = `players/${saves.profile()}/`;
        const files = JSON.parse(new TextDecoder().decode(r.data)) as { path?: unknown }[];
        if (!Array.isArray(files)) throw new Error('not an array');
        const saved = new Set<string>();
        for (const f of files) {
            const p = f?.path;
            if (typeof p === 'string' && p.startsWith(prefix) && p.endsWith('.sav') && !p.slice(prefix.length).includes('/')) saved.add(toSafeName(p.slice(prefix.length, -4)));
        }
        for (const name of saved) humanNames.add(name);
        return saved;
    } catch (e) {
        console.warn('[bots] /save-index is not a file list', e);
        return null;
    }
}

export function humanInWorld(): boolean {
    for (const p of World.playerLoop.all()) if (p instanceof NetworkPlayer) return true;
    return false;
}

export function isReservedName(name: string): boolean {
    const n = toSafeName(name);
    if (humanNames.has(n)) return true;
    const p = World.getPlayerByUsername(n);
    return !!p && p instanceof NetworkPlayer;
}

export function loadSave(name: string): { status: 'ok'; data: Uint8Array } | { status: 'missing' } | { status: 'error'; error: string } {
    const data = botStore.get(toSafeName(name));
    if (!data) return { status: 'missing' };
    try {
        // a damaged record: that bot sits this session out, and its record is written back unchanged
        if (!PlayerLoading.verify(new Packet(data))) return { status: 'error', error: `its record in ${botStore.relPath()} is damaged (CRC)` };
    } catch (e) {
        return { status: 'error', error: `its record in ${botStore.relPath()} is damaged (${e instanceof Error ? e.message : e})` };
    }
    return { status: 'ok', data: data.slice() };
}
