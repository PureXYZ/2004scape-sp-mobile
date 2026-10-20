// Friend and ignore lists with the bots on (docs/BOTS.md §4.8). Offline the engine's friend server is a sink
// (runtime/threads.ts), so without the bots a friend list lasts one login and nobody is ever online; engine.js keeps
// it that way. With the bots this module stands in for that server, for the one world there is. It hears what World
// posts to its friend thread (an own-property wrapper on World.friendThread.postMessage, no engine source patched):
//   player_login            a human: its ignore list, and its friend list once the world has filled (the bots join
//                           after the human: sent at once, every friend coming in would print a line); until then the
//                           client says "Connecting to friendserver" (FRIENDLIST_LOADED 1, as 2004's did while it
//                           loaded). A bot: the humans who have it as a friend see it log in ("Kevin1991 has logged
//                           in." - the stock client's line)
//   player_logout           a bot: those humans see it log out
//   player_friendslist_*    the human's friend list changed (a bot in the world shows as online at once)
//   player_ignorelist_*     the human's ignore list changed
// The lists are kept per human character in the bot store's "_meta" record (store.ts) and written with the bots, at
// the same save occasions. Every handler is guarded: nothing here may throw into World. A character deleted in
// Settings › Saved data takes its lists with it (saves.delete, and at load those of characters with no save left), so a
// new character of that name starts with none.
import { BotManager } from '#/engine/bot/BotManager.js';
import World from '#/engine/World.js';
import type Player from '#/engine/entity/Player.js';
import FriendlistLoaded from '#/network/game/server/model/FriendlistLoaded.js';
import UpdateFriendList from '#/network/game/server/model/UpdateFriendList.js';
import UpdateIgnoreList from '#/network/game/server/model/UpdateIgnoreList.js';
import Environment from '#/util/Environment.js';
import { fromBase37, toBase37, toSafeName } from '#/util/JString.js';

import { saves } from '../saves.js';
import { botError, bots, botsActive } from './state.js';
import { botStore, type FriendLists } from './store.js';

/** The stock client keeps at most 200 friends; 274's friend server took 100 ignores. */
const MAX_FRIENDS = 200;
const MAX_IGNORES = 100;

type FriendMessage = { type?: unknown; username?: unknown; target?: unknown };
type FriendThread = { postMessage(msg: unknown, transfer?: unknown): void };

function friendThread(): FriendThread | null {
    const thread = (World as unknown as { friendThread?: FriendThread }).friendThread;
    return thread && typeof thread.postMessage === 'function' ? thread : null;
}

export function friendTargetsMissing(): string[] {
    return friendThread() ? [] : ['World.friendThread.postMessage'];
}

/** A friend list waits for the world to fill: at least this many ticks (BotManager queues the bots on the tick after the
 *  login), at most that many (18 s). */
const LOADING_MIN_TICKS = 2;
const LOADING_MAX_TICKS = 30;
/** The humans whose friend list is held back: name → the tick they logged in. */
const loading = new Map<string, number>();

/** What friends.ts did, for the tests. */
export const friendStats = { listsSent: 0, loginsShown: 0, logoutsShown: 0, changes: 0 };

const isBot = (p: Player | undefined) => (p as (Player & { is_bot?: boolean }) | undefined)?.is_bot === true;

function humansOnline(): Player[] {
    const out: Player[] = [];
    for (const p of World.playerLoop.all()) if (!isBot(p)) out.push(p);
    return out;
}

function lists(human: string, create: boolean): FriendLists | null {
    const all = botStore.meta.friends;
    if (Object.hasOwn(all, human)) return all[human];
    if (!create) return null;
    return (all[human] = { friends: [], ignores: [] });
}

/** A human has this bot as a friend (BotManager: such a bot never quits). */
export function isFriendOfHuman(name: string): boolean {
    const n = toSafeName(name);
    for (const l of Object.values(botStore.meta.friends)) if (l.friends.includes(n)) return true;
    return false;
}

/** In the world now (a bot logging in this tick counts: its own player_login follows). */
function online(name: string): boolean {
    return World.getPlayerByUsername(name) !== undefined;
}

function sendFriends(human: Player): void {
    const l = lists(toSafeName(human.username), false);
    for (const name of l?.friends ?? []) human.write(new UpdateFriendList(toBase37(name), online(name) ? Environment.node.id : 0));
    human.write(new FriendlistLoaded(2));
    friendStats.listsSent++;
}

/** The bots are in: no bot is on its way into the world (the stub library says nothing: in after the minimum). */
function worldFilled(): boolean {
    try {
        return ((BotManager.stats() as { joining?: number }).joining ?? 0) === 0;
    } catch {
        return true;
    }
}

/** After every world tick (index.ts): the friend lists that waited for the world to fill. */
export function friendsAfterTick(): void {
    for (const [name, since] of [...loading]) {
        const human = World.getPlayerByUsername(name);
        const waited = World.currentTick - since;
        if (!human || isBot(human)) {
            loading.delete(name);
        } else if (waited >= LOADING_MIN_TICKS && (waited >= LOADING_MAX_TICKS || !botsActive() || worldFilled())) {
            loading.delete(name);
            sendFriends(human);
        }
    }
}

/** A bot came or went: every human who has it as a friend sees it (one whose list is still loading gets it with the list). */
function showBot(name: string, world: number): void {
    for (const human of humansOnline()) {
        if (loading.has(toSafeName(human.username))) continue;
        if (!lists(toSafeName(human.username), false)?.friends.includes(name)) continue;
        human.write(new UpdateFriendList(toBase37(name), world));
        if (world) friendStats.loginsShown++;
        else friendStats.logoutsShown++;
    }
}

function change(human: string, target: string, list: 'friends' | 'ignores', add: boolean): void {
    if (!target || target === human) return;
    const l = lists(human, add);
    if (!l) return;
    const names = l[list];
    const at = names.indexOf(target);
    if (add) {
        if (at !== -1 || names.length >= (list === 'friends' ? MAX_FRIENDS : MAX_IGNORES)) return;
        names.push(target);
    } else {
        if (at === -1) return;
        names.splice(at, 1);
    }
    friendStats.changes++;
    botStore.touch();
}

/** A character's save was deleted: its lists go, now (the store is written at once). */
function forget(human: string): void {
    if (!Object.hasOwn(botStore.meta.friends, human)) return;
    delete botStore.meta.friends[human];
    loading.delete(human);
    botStore.touch();
    botStore.flush('delete');
}

/** When the bots start, after loadHumanNames: the lists of characters with no save left (deleted while the bots were
 *  off, or in the Files app). `saved` = the names of the human saves; only call with a complete list. */
export function forgetDeletedCharacters(saved: ReadonlySet<string>): number {
    let forgotten = 0;
    for (const human of Object.keys(botStore.meta.friends)) {
        if (saved.has(human)) continue;
        delete botStore.meta.friends[human];
        forgotten++;
    }
    if (forgotten) {
        botStore.touch();
        console.info(`[bots] dropped the friend lists of ${forgotten} deleted character${forgotten === 1 ? '' : 's'}`);
    }
    return forgotten;
}

function onFriendMessage(msg: FriendMessage): void {
    if (!msg || typeof msg.type !== 'string' || typeof msg.username !== 'string') return;
    const name = toSafeName(msg.username);
    switch (msg.type) {
        case 'player_login': {
            const player = World.getPlayerByUsername(name);
            if (!player) return;
            if (isBot(player)) {
                if (botsActive()) showBot(name, Environment.node.id);
                return;
            }
            const ignores = lists(name, false)?.ignores ?? [];
            if (ignores.length) player.write(new UpdateIgnoreList(ignores.map(n => toBase37(n))));
            // (onLogin said the list is loaded, 2: offline there was never one to wait for)
            player.write(new FriendlistLoaded(1));
            loading.set(name, World.currentTick);
            return;
        }
        case 'player_logout':
            // removePlayer posts this once the player is out of the world: a bot, or the human leaving (nobody to tell).
            // Also once the bots were switched off: they leave then, and must not stay "online" in the lists
            if (!humansOnline().some(h => toSafeName(h.username) === name)) showBot(name, 0);
            return;
        case 'player_friendslist_add':
        case 'player_friendslist_remove':
        case 'player_ignorelist_add':
        case 'player_ignorelist_remove': {
            if (typeof msg.target !== 'bigint' || isBot(World.getPlayerByUsername(name))) return;
            const target = toSafeName(fromBase37(msg.target));
            const add = msg.type.endsWith('_add');
            change(name, target, msg.type.startsWith('player_friends') ? 'friends' : 'ignores', add);
            // offline nobody was ever online; a bot in the world is (the client opens a private message only then)
            if (add && msg.type === 'player_friendslist_add' && botsActive() && isBot(World.getPlayerByUsername(target))) {
                bots.counters.friendsOnline++;
                World.getPlayerByUsername(name)?.write(new UpdateFriendList(msg.target, Environment.node.id));
            }
            return;
        }
    }
}

export function installFriends(): void {
    const thread = friendThread()!;
    const post = thread.postMessage;
    thread.postMessage = function (this: FriendThread, msg: unknown, transfer?: unknown) {
        // the lists live in the store: none while it is not loaded (the bots off because it could not be read)
        if (botStore.loaded) {
            try {
                onFriendMessage(msg as FriendMessage);
            } catch (e) {
                botError('friend', 'the friend lists failed', e);
            }
        }
        post.call(this, msg, transfer);
    };

    const del = saves.delete;
    saves.delete = function (this: typeof saves, username: string): string | null {
        const error = del.call(this, username);
        if (error === null && botStore.loaded) {
            try {
                forget(toSafeName(username));
            } catch (e) {
                botError('friend', 'dropping a deleted character\'s friend lists failed', e);
            }
        }
        return error;
    };
}
