// Test stub of the bot library's API (docs/BOTS.md §4.2) for the runtime's own tests, built in place of
// web/engine/bots/src by test/bots.test.mjs (`buildEngine({ bots: { lib } })`; the real library with --real).
// No AI: plain client-less players from a roster that join once a human is in the world (never on tick 0, at most
// spawnPerTick a tick), stroll a few tiles now and then, are kept alive, retire/release on demand and answer chat
// (port/BotChat.ts). Contract behaviour only, so whatever the glue relies on is exercised without the real bots.
import InvType from '#/cache/config/InvType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import { ChatModePrivate } from '#/engine/entity/ChatModes.js';
import Player from '#/engine/entity/Player.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import { findPath, isMapBlocked, isZoneAllocated } from '#/engine/GameMap.js';
import type World from '#/engine/World.js';
import Packet from '#/io/Packet.js';
import { toSafeName } from '#/util/JString.js';

import './port/PlayerBotFields.js';

export type BotLoadResult = { status: 'ok'; data: Uint8Array } | { status: 'missing' } | { status: 'error'; error: string };

export interface BotStartOptions {
    count: number;
    members: boolean;
    debug: boolean;
    humanInWorld(): boolean;
    isReservedName(name: string): boolean;
    loadSave(name: string): BotLoadResult;
    spawnPerTick?: number;
    // the living world (the real library's sessions; the stub only logs in and out on the tests' request)
    ageNewBots?: boolean;
    savedNames?(): Iterable<string>;
    isQuit?(name: string): boolean;
    onQuit?(name: string): void;
    isFriendOfHuman?(name: string): boolean;
    timing?: Record<string, unknown>;
    /** the last run's world (the stub keeps no world: it has no exportWorld) */
    world?: unknown;
}

// 100 roster slots + backfill names at the end; every fifth name has a space (safe name "stub_bot5")
export const NAMES: string[] = Array.from({ length: 120 }, (_, i) => (i % 5 === 4 ? `stub bot${i + 1}` : `stubbot${i + 1}`));
const ROSTER = 100;
const LUMBRIDGE = { x: 3222, z: 3218, level: 0 };

type Bot = { name: string; player: Player; state: 'active' | 'retiring'; home: { x: number; z: number }; nextStroll: number; stay: boolean };

class StubBotManager {
    private world: typeof World | null = null;
    private opts: BotStartOptions | null = null;
    private queue: string[] = []; // names still to spawn, in slot order
    private readonly bots = new Map<string, Bot>();
    private readonly retired = new Set<string>(); // never respawned this session
    private readonly skipped: string[] = [];
    private readonly says: { tick: number; bot: string; text: string }[] = [];
    private spawned = 0;
    private errors = 0;
    private lastTickMs = 0;
    private maxTickMs = 0;
    /** test hook: [tick, bots spawned in it] */
    readonly spawnLog: [number, number][] = [];
    /** test hooks: new characters seen, and bots sent out by logOff (they come back with comeBack) */
    newCharacters = 0;
    private readonly away = new Set<string>();

    start(world: typeof World, opts: BotStartOptions): void {
        if (this.world) throw new Error('BotManager.start: already started');
        this.world = world;
        this.opts = opts;
        const count = Math.max(0, Math.min(ROSTER, opts.count | 0));
        // slot i = NAMES[i]; a slot whose name a human has takes the next unused name from the end of the list
        const used = new Set<string>();
        let backfill = NAMES.length - 1;
        for (let i = 0; i < count; i++) {
            let name = toSafeName(NAMES[i]);
            if (opts.isReservedName(name)) {
                this.skipped.push(name);
                while (backfill >= ROSTER && (used.has(toSafeName(NAMES[backfill])) || opts.isReservedName(toSafeName(NAMES[backfill])))) backfill--;
                if (backfill < ROSTER) continue;
                name = toSafeName(NAMES[backfill--]);
            }
            used.add(name);
            this.queue.push(name);
        }
        if (opts.debug) console.info(`[bots] stub: ${this.queue.length} bots queued`);
    }

    tick(): void {
        const world = this.world;
        const opts = this.opts;
        if (!world || !opts) return;
        const t0 = performance.now();
        const tick = world.currentTick;
        // keep-alive: a client-less Player's lastResponse/lastConnected are only refreshed by NetworkPlayer.decodeIn
        for (const bot of this.bots.values()) {
            bot.player.lastResponse = tick;
            bot.player.lastConnected = tick;
            // (the contract: a bot leaving for a human who wants its name is not held by the combat logout lock)
            if (bot.state === 'retiring') bot.player.preventLogoutUntil = -1;
        }
        if (this.queue.length && tick > 0 && !world.shutdownSoon && opts.humanInWorld()) {
            let n = 0;
            while (this.queue.length && n < (opts.spawnPerTick ?? 5)) {
                const name = this.queue.shift()!;
                if (this.spawn(name)) n++;
            }
            if (n) this.spawnLog.push([tick, n]);
        }
        for (let i = this.says.length - 1; i >= 0; i--) {
            const s = this.says[i];
            if (s.tick > tick) continue;
            this.says.splice(i, 1);
            const bot = this.bots.get(s.bot);
            if (bot?.state === 'active') bot.player.say(s.text);
        }
        for (const bot of this.bots.values()) {
            if (bot.state !== 'active' || bot.stay || tick < bot.nextStroll || bot.player.slot === -1) continue;
            try {
                bot.nextStroll = tick + 8 + Math.floor(Math.random() * 8);
                const x = bot.home.x + Math.floor(Math.random() * 5) - 2;
                const z = bot.home.z + Math.floor(Math.random() * 5) - 2;
                bot.player.queueWaypoints(findPath(bot.player.level, bot.player.x, bot.player.z, x, z));
            } catch (e) {
                this.errors++;
                console.error(`[bots] stub: ${bot.name} stroll failed`, e);
            }
        }
        this.lastTickMs = performance.now() - t0;
        this.maxTickMs = Math.max(this.maxTickMs, this.lastTickMs);
    }

    private spawn(name: string): boolean {
        const world = this.world!;
        if (this.opts!.isReservedName(name)) {
            this.skipped.push(name); // a human took it since start()
            return false;
        }
        const loaded = this.opts!.loadSave(name);
        if (loaded.status === 'error') {
            this.skipped.push(name);
            console.error(`[bots] stub: not spawning ${name}: ${loaded.error}`);
            return false;
        }
        let player: Player;
        try {
            player = PlayerLoading.load(name, new Packet(loaded.status === 'ok' ? loaded.data : new Uint8Array(0)), null);
        } catch (e) {
            this.skipped.push(name);
            this.errors++;
            console.error(`[bots] stub: cannot load ${name}`, e);
            return false;
        }
        if (loaded.status === 'missing') {
            // fresh: near Lumbridge on a walkable tile, tutorial done (else [login,_] starts Tutorial Island)
            for (let attempt = 0; attempt < 20; attempt++) {
                const x = LUMBRIDGE.x + Math.floor(Math.random() * 9) - 4;
                const z = LUMBRIDGE.z + Math.floor(Math.random() * 9) - 4;
                if (isZoneAllocated(LUMBRIDGE.level, x, z) && !isMapBlocked(x, z, LUMBRIDGE.level)) {
                    player.x = x;
                    player.z = z;
                    break;
                }
            }
            player.level = LUMBRIDGE.level;
            player.setVar(VarPlayerType.getId('tutorial'), 1000);
        }
        player.members = this.opts!.members;
        player.privateChat = ChatModePrivate.ON;
        player.is_bot = true;
        player.botPlanner = 'stub';
        player.botTradeTargetPid = -1;
        player.botTradeTargetStage = -1;
        this.bots.set(name, { name, player, state: 'active', home: { x: player.x, z: player.z }, nextStroll: world.currentTick + 2, stay: false });
        world.newPlayers.add(player);
        player.buildAppearance(InvType.WORN);
        this.spawned++;
        return true;
    }

    clearAfkEvents(): void {
        for (const bot of this.bots.values()) bot.player.afkEventReady = false;
    }

    isBotPlayer(p: Player): boolean {
        return p.is_bot === true;
    }

    ownsName(name: string): boolean {
        return this.bots.has(toSafeName(name));
    }

    isActiveBot(name: string): boolean {
        return this.bots.get(toSafeName(name))?.state === 'active';
    }

    retire(name: string): boolean {
        const bot = this.bots.get(toSafeName(name));
        if (!bot || bot.state !== 'active') return false;
        bot.state = 'retiring';
        this.retired.add(bot.name);
        // the normal logout path (World.processLogouts). requestLogout alone is dropped while a logout is prevented (in
        // combat); loggingOut holds until World.processLogouts can take the bot out
        bot.player.requestLogout = true;
        bot.player.loggingOut = true;
        return true;
    }

    release(name: string): void {
        this.bots.delete(toSafeName(name));
        this.away.delete(toSafeName(name));
    }

    newCharacter(): void {
        this.newCharacters++;
    }

    /** test hook: the bot's session is over; it logs out through the normal path and stays owned (its saves are the store's). */
    logOff(name: string): boolean {
        const bot = this.bots.get(toSafeName(name));
        if (!bot || bot.state !== 'active' || bot.player.slot === -1) return false;
        bot.state = 'retiring';
        this.away.add(bot.name);
        bot.player.requestLogout = true;
        bot.player.loggingOut = true;
        return true;
    }

    /** test hook: a bot that logged off comes back from its saved record (once its logout went through). */
    comeBack(name: string): boolean {
        const n = toSafeName(name);
        const bot = this.bots.get(n);
        if (!bot || !this.away.has(n) || bot.player.slot !== -1 || this.world!.logoutRequests.has(n)) return false;
        this.away.delete(n);
        this.bots.delete(n);
        return this.spawn(n);
    }

    *activeBots(): Iterable<Player> {
        for (const bot of this.bots.values()) if (bot.state === 'active' && bot.player.slot !== -1) yield bot.player;
    }

    stats() {
        let active = 0;
        for (const bot of this.bots.values()) if (bot.state === 'active' && bot.player.slot !== -1) active++;
        return { configured: this.opts?.count ?? 0, spawned: this.spawned, active, skipped: [...this.skipped], lastTickMs: this.lastTickMs, maxTickMs: this.maxTickMs, pathSearchesLastTick: 0, pathSearchBudget: 0, errors: this.errors, pool: this.bots.size + this.queue.length, away: this.away.size };
    }

    // ---- for port/BotChat.ts --------------------------------------------------------------------------------

    /** Active bots whose display name ("Stub Bot5") the text contains as whole words. */
    addressed(text: string): Player[] {
        const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
        return [...this.activeBots()].filter(p => t.includes(` ${p.displayName.toLowerCase()} `));
    }

    sayLater(bot: Player, text: string, ticks: number): void {
        this.says.push({ tick: (this.world?.currentTick ?? 0) + ticks, bot: bot.username, text });
    }

    comeHere(bot: Player, to: Player): void {
        const entry = this.bots.get(bot.username);
        if (entry) entry.stay = true;
        bot.queueWaypoints(findPath(bot.level, bot.x, bot.z, to.x + 1, to.z));
    }
}

export const BotManager = new StubBotManager();
