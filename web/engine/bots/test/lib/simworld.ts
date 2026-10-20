// The real rev-274 world, headless, with the bot library on top (loaded by test/sim.mjs through tsx from a scratch
// clone of Server/engine whose src/engine/bot is this library). It installs the two hooks the runtime glue installs
// (BotManager.tick after World.processPlayers, clearAfkEvents after World.processClientsIn), adds a "human"
// NetworkPlayer on a socket that only counts bytes, and drives World.cycle by hand: no 600 ms wait.
import World from '#/engine/World.js';
import Player from '#/engine/entity/Player.js';
import { NetworkPlayer } from '#/engine/entity/NetworkPlayer.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import Packet from '#/io/Packet.js';
import ClientSocket from '#/server/ClientSocket.js';
import routefinder, { CollisionType } from '#/engine/routefinder/index.js';
import PlayerInfoEncoder from '#/network/game/server/codec/PlayerInfoEncoder.js';
import * as rsbuf from '#/network/rsbuf/index.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import { isMapBlocked, isZoneAllocated } from '#/engine/GameMap.js';
import InvType from '#/cache/config/InvType.js';
import { BotManager, type BotLoadResult, type BotStartOptions } from '#/engine/bot/BotManager.js';
import { BotPlayer } from '#/engine/bot/BotPlayer.js';
import { BotChat } from '#/engine/bot/port/BotChat.js';
import { BotTrade } from '#/engine/bot/port/BotTrade.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { pathSearchesThisTick } from '#/engine/bot/port/BotPathing.js';
import { BOT_NAMES, groupCap, initialPool, isLevelling, onlineShare, plannerOf, PLANNERS, poolShare } from '#/engine/bot/port/BotRoster.js';
import { sayListeners } from '#/engine/bot/port/BotSay.js';
import { advertsPerMinute, claimNearestStall, claimVendorStall, hubTilesForTest, releaseStall, stallOf, TRADE_BANKS, vendorHome } from '#/engine/bot/port/BotTradeSpots.js';
import { ageTierFor } from '#/engine/bot/port/BotAge.js';
import { teleportStats, walkTo, findNpcByName, interactNpcOp } from '#/engine/bot/BotAction.js';
import * as walkGraph from '#/engine/bot/port/BotWalkGraph.js';
import { buyFromOpenShop, openShopStock } from '#/engine/bot/tasks/BotTaskBase.js';
import LocType from '#/cache/config/LocType.js';
import NpcType from '#/cache/config/NpcType.js';
import { NpcMode } from '#/engine/entity/NpcMode.js';
import { NEWBIE_BEGS, NEWBIE_QUESTIONS, TUTORIAL_COINS, TUTORIAL_KIT, isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { isAway, lastBreakOf } from '#/engine/bot/port/BotHabits.js';
export * as BotCliques from '#/engine/bot/port/BotCliques.js';
// (phase 5b: the coverage scenario runs without the Duel Arena's visits: setArenaRatesForTest(0))
export * as BotArena from '#/engine/bot/port/BotArena.js';
// (the realism work, phase 3: arrivals and sessions; namespaces, so that an A/B copy of the library without them loads)
import * as Sessions from '#/engine/bot/port/BotSessions.js';
import * as Newbie from '#/engine/bot/port/BotNewbie.js';
import * as Age from '#/engine/bot/port/BotAge.js';

export { World, BotManager, BotPlayer, BotChat, BotTrade, PlayerStat, BOT_NAMES, groupCap, initialPool, isLevelling, onlineShare, plannerOf, PLANNERS, poolShare, sayListeners, stallOf, advertsPerMinute, claimNearestStall, claimVendorStall, hubTilesForTest, releaseStall, TRADE_BANKS, vendorHome, wildernessLevelAt, InvType, ageTierFor, PlayerLoading, Packet, teleportStats, walkTo, findNpcByName, interactNpcOp, buyFromOpenShop, openShopStock, walkGraph, Player, LocType, NpcType, NpcMode, routefinder, NEWBIE_BEGS, NEWBIE_QUESTIONS, TUTORIAL_COINS, TUTORIAL_KIT, isAway, lastBreakOf, isNewbie, Sessions, Newbie, Age };
export { coverageCases, giveItems, wearItems, casePlanner, snapshot } from './coverage.js';

/**
 * The hang-out a bot is on (realism phase 3, port/BotHangout): its task, or its sub-task (one begun at a bank stop);
 * null: none. Read by name, so a run against an older library (LC_BOTS_SRC) has none.
 */
type Named = { name?: string; state?: string };
export function hangoutOf(bot: Player): Named | null {
    const ai = (bot as unknown as { _bot?: { subTask?: Named | null; currentTask?: Named | null } })._bot;
    if (ai?.subTask?.name === 'Hangout') return ai.subTask;
    return ai?.currentTask?.name === 'Hangout' ? ai.currentTask : null;
}

class CountingSocket extends ClientSocket {
    bytes = 0;
    constructor() {
        super();
        this.remoteAddress = '127.0.0.1';
    }
    send(src: Uint8Array): void {
        this.bytes += src.length;
    }
    close(): void {}
    terminate(): void {}
}

/**
 * No sessions, newcomers or quits unless a test asks for them (`extra.timing`): the world, chat, trade and PK tests
 * follow the same bots for their whole run; the living world is test/churn.mjs's.
 */
const STEADY_TIMING = { session: [1e7, 1e7] as [number, number], away: [1e7, 1e7] as [number, number], newcomer: [1e7, 1e7] as [number, number], newCharacterCount: [0, 0] as [number, number] };

export interface SimOptions {
    bots: number;
    members: boolean;
    debug: boolean;
    humanName?: string;
    human?: [number, number, number];
    spawnPerTick?: number;
    /** names a "human" character has (the roster backfills them) */
    reserved?: string[];
    saves?: Map<string, Uint8Array>;
    /** a new bot store: the bots created with it get an age (BotStartOptions.ageNewBots, port/BotAge) */
    ageNewBots?: boolean;
    /** more BotManager.start options (the living world's: timing, savedNames, onQuit ...) */
    extra?: Partial<BotStartOptions>;
    /** the login thread acknowledges logouts (and keeps the saves in `saves`), as the runtime's does: bots can come back */
    ackLogouts?: boolean;
    /** whether a human counts as in the world (default: the sim's human is) */
    humanPresent?: () => boolean;
    /**
     * (variety round 2, Track M) the far-town outings' and minigames' planner hooks (port/BotMinigames): off in a staged
     * world unless asked for, as the other ambient set pieces are (a staged test's free bots went to the Trawler); the
     * humanlike report turns them on in its own block
     */
    outings?: boolean;
}

export interface TickSample {
    tick: number;
    cycleMs: number;
    botMs: number;
    botSearches: number;
    allSearches: number;
    playerInfo: number;
}

export class Sim {
    readonly human: NetworkPlayer;
    readonly socket: CountingSocket;
    readonly samples: TickSample[] = [];
    readonly startMs: number;
    private readonly cycle: () => void;
    private searchesTotal = 0;
    private findPathUncounted: typeof routefinder.findPath = routefinder.findPath.bind(routefinder);
    private playerInfoMax = 0;
    private botMs = 0;

    private constructor(name: string, startMs: number) {
        this.socket = new CountingSocket();
        this.human = PlayerLoading.load(name, new Packet(new Uint8Array(0)), this.socket) as NetworkPlayer;
        this.startMs = startMs;
        this.cycle = Object.getPrototypeOf(World).cycle as () => void;
    }

    static async create(options: SimOptions): Promise<Sim> {
        const t0 = performance.now();
        await World.start(false, false);
        const startMs = performance.now() - t0;

        // World.cycle reschedules itself through this.cycle; the harness calls the prototype's instead
        (World as unknown as { cycle: () => void }).cycle = () => {};

        // the runtime glue's hooks (BOTS.md §4.3), as own-property wrappers
        const proto = Object.getPrototypeOf(World) as Record<string, (...args: unknown[]) => unknown>;
        const sim = new Sim(options.humanName ?? 'sim human', startMs);
        const w = World as unknown as Record<string, unknown>;
        w.processPlayers = function (this: typeof World) {
            proto.processPlayers.call(this);
            const s = performance.now();
            BotManager.tick();
            sim.botMs = performance.now() - s;
        };
        w.processClientsIn = function (this: typeof World) {
            proto.processClientsIn.call(this);
            BotManager.clearAfkEvents();
        };

        // count every path search (bots' and the engine's), and the human's PLAYER_INFO
        const findPath = routefinder.findPath.bind(routefinder);
        sim.findPathUncounted = findPath;
        (routefinder as unknown as { findPath: typeof findPath }).findPath = (...args: Parameters<typeof findPath>) => {
            sim.searchesTotal++;
            return findPath(...args);
        };
        const encode = PlayerInfoEncoder.prototype.encode;
        PlayerInfoEncoder.prototype.encode = function (buf, message) {
            if (message.bytes.length > sim.playerInfoMax) sim.playerInfoMax = message.bytes.length;
            return encode.call(this, buf, message);
        };

        const saves = options.saves ?? new Map<string, Uint8Array>();
        const reserved = new Set((options.reserved ?? []).map(n => n.toLowerCase().replaceAll(' ', '_')));
        const humanName = sim.human.username;
        if (options.ackLogouts) {
            // runtime/threads.ts: a logout's save is written and acknowledged (World then lets the name log in again)
            const thread = (World as unknown as { loginThread: { postMessage(msg: unknown): void; emit(ev: string, msg: unknown): void } }).loginThread;
            thread.postMessage = (msg: unknown) => {
                const m = msg as { type?: string; username?: string; save?: Uint8Array };
                if ((m.type === 'player_logout' || m.type === 'player_autosave') && m.username && m.save && m.username !== humanName) saves.set(m.username, m.save.slice());
                if (m.type === 'player_logout') queueMicrotask(() => thread.emit('message', { type: 'player_logout', username: m.username, success: true }));
            };
        }
        // ---- (variety round 2, Track M) the outings' hooks off unless asked for (a library without them: nothing) ----
        await import('#/engine/bot/port/BotOutings.js').then(m => m.setOutingRatesForTest(options.outings ? 1 : 0)).catch(() => {});
        // ---- end of Track M's block ----
        BotManager.start(World, {
            ...options.extra,
            timing: options.extra?.timing ?? STEADY_TIMING,
            count: options.bots,
            members: options.members,
            debug: options.debug,
            spawnPerTick: options.spawnPerTick,
            ageNewBots: options.ageNewBots ?? options.extra?.ageNewBots,
            humanInWorld: options.humanPresent ?? (() => sim.human.slot !== -1),
            isReservedName: name => name === humanName || reserved.has(name),
            loadSave: (name): BotLoadResult => {
                const data = saves.get(name);
                return data ? { status: 'ok', data } : { status: 'missing' };
            }
        });
        return sim;
    }

    /** Puts the human in the world (a real NetworkPlayer on a socket that only counts bytes). */
    addHuman(x: number, z: number, level = 0): void {
        this.human.x = x;
        this.human.z = z;
        this.human.level = level;
        World.newPlayers.add(this.human);
    }

    tick(): TickSample {
        this.human.lastResponse = World.currentTick;
        this.human.lastConnected = World.currentTick;
        this.playerInfoMax = 0;
        this.botMs = 0;
        const searchesBefore = this.searchesTotal;
        const tick = World.currentTick;
        const s = performance.now();
        this.cycle.call(World);
        const sample: TickSample = {
            tick,
            cycleMs: performance.now() - s,
            botMs: this.botMs,
            botSearches: pathSearchesThisTick(),
            allSearches: this.searchesTotal - searchesBefore,
            playerInfo: this.playerInfoMax
        };
        this.samples.push(sample);
        return sample;
    }

    bots(): Player[] {
        return [...BotManager.activeBots()];
    }

    botPlayer(player: Player): BotPlayer | null {
        return BotManager.botFor(player);
    }

    /** Is this player in the human's client player list (rsbuf)? */
    sees(player: Player): boolean {
        return this.human.slot !== -1 && player.slot !== -1 && rsbuf.hasPlayer(this.human.slot, player.slot);
    }

    /** Bots whose player the human's client has in its player list (rsbuf). */
    visibleBots(): number {
        let n = 0;
        for (const p of BotManager.activeBots()) if (rsbuf.hasPlayer(this.human.slot, p.slot)) n++;
        return n;
    }

    /** Every bot rebuilds its appearance now (as if all changed gear in the same tick). */
    rebuildAppearances(): void {
        for (const p of BotManager.activeBots()) p.buildAppearance(InvType.WORN);
    }

    /**
     * The bots' AI stops (BotManager still keeps them online) and they drop their routes, interactions and scripts (a
     * bot moved mid-obstacle would run the rest of 274's agility walk from where it lands: its stack overflows).
     */
    freezeBots(): void {
        BotPlayer.prototype.tick = function () {};
        for (const p of BotManager.activeBots()) {
            p.clearWaypoints();
            p.clearPendingAction();
            p.activeScript = null;
        }
    }

    /**
     * The human jumps to (x, z) and stands there: a walk or an interaction it had is dropped (fighting back an NPC
     * that attacked it, it chased the NPC off, and the "come here" check's bot followed it 30 tiles)
     */
    teleportHuman(x: number, z: number, level = 0): void {
        this.human.clearPendingAction();
        this.human.clearWaypoints();
        this.human.teleJump(x, z, level);
    }

    /** The human gets the bot's levels (so their combat levels match). */
    copyLevels(from: Player): void {
        for (let stat = 0; stat < from.baseLevels.length; stat++) {
            if (from.baseLevels[stat] > 1) this.human.setLevel(stat, from.baseLevels[stat]);
        }
    }

    /** The player this one is attacking (an attack op on a player), or null. */
    attackTarget(player: Player): Player | null {
        const op = player.targetOp;
        const attacking = op === ServerTriggerType.APPLAYER2 || op === ServerTriggerType.OPPLAYER2;
        return attacking && player.target instanceof Player ? player.target : null;
    }

    isWalkable(x: number, z: number, level: number): boolean {
        return isZoneAllocated(level, x, z) && !isMapBlocked(x, z, level);
    }

    /** How many tiles `from` walks to (x, z) (doors as they are now), or -1. A search the tick counters do not see. */
    walkDistance(from: Player, x: number, z: number): number {
        const path = this.findPathUncounted(from.level, from.x, from.z, x, z, 1, 1, 1, 0, -1, false, 0, 25, CollisionType.NORMAL);
        let tiles = 0;
        let [px, pz] = [from.x, from.z];
        for (const packed of path) {
            const [wx, wz] = [(packed >> 14) & 0x3fff, packed & 0x3fff];
            tiles += Math.max(Math.abs(wx - px), Math.abs(wz - pz));
            [px, pz] = [wx, wz];
        }
        return path.length > 0 && px === x && pz === z ? tiles : -1;
    }

    isFreeToPlay(x: number, z: number): boolean {
        return World.gameMap.isFreeToPlay(x, z);
    }

    saveAll(): Map<string, Uint8Array> {
        const out = new Map<string, Uint8Array>();
        for (const p of BotManager.activeBots()) out.set(p.username, p.save().slice());
        return out;
    }
}
