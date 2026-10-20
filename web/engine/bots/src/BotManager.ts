/**
 * BotManager.ts
 *
 * Spawns and ticks all bots.
 *
 * port (rev 274, iOS engine worker): upstream patched World.ts (init inside World.start's `if (startCycle)`, which the
 * worker never runs; tick after processPlayers; a processLogouts rewrite) and read its roster, saves and data with
 * fs. Here the runtime glue (web/engine/src/runtime/bots) calls this module (BOTS.md §4.2):
 *
 *   start(World, options)   after World.start, before the first tick: the pool, world rules; spawns nothing yet
 *   tick()                  every tick after World.processPlayers: keep-alive, sessions (who logs out, who comes
 *                           back, newcomers), staggered spawning, then the AI
 *   clearAfkEvents()        after World.processClientsIn: no bot keeps the engine's random-event roll; one that
 *                           port/BotRandomEvents armed keeps its flag (phase 5a: events on bots near the human)
 *   newCharacter()          a human made a new character: a few newcomers follow it into the world
 *   retire(name) / release(name), ownsName(name), isActiveBot(name), activeBots(), stats()
 *
 * The living world (BOTS.md §4.4): options.count is how many bots are online at a time, out of a pool of about twice
 * that (port/BotRoster). Each bot plays a session, logs out through the normal logout path (its save goes to the bot
 * store) and comes back later from that save; newcomers join at the Lumbridge spawn now and then, and an old account
 * quits for good when the pool is over its size. Durations are play ticks: world ticks with a human in the world
 * (port/BotSessions). With nobody in the world (the title screen) every bot logs out; the world fills again at the next
 * login.
 *
 * Saves come and go through the runtime (options.loadSave; the engine's own logout/autosave path, which the glue
 * routes to the bot store), so this module does no I/O. Each bot's errors are isolated: a throw inside World.cycle
 * removes every player and stops the world.
 */
import Player, { getExpByLevel } from '#/engine/entity/Player.js';
import type World from '#/engine/World.js';
import { PlayerStat, getBaseLevel, setVarp, tilesInReach, tilesInSquare } from '#/engine/bot/BotAction.js';
import { BotPlayer } from '#/engine/bot/BotPlayer.js';
import { setWorld } from '#/engine/bot/BotWorld.js';
import { BotGoalPlanner, makeSkiller, makeFighter, makeBalanced, makeRandom, makeExtrasSocial, makeExtrasVendor, makeExtrasPKer, makeExtrasEdgevillePKer } from '#/engine/bot/BotGoalPlanner.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import Packet from '#/io/Packet.js';
import { Locations } from '#/engine/bot/BotKnowledge.js';
import { isMapBlocked, isZoneAllocated } from '#/engine/GameMap.js';
import { BotAppearance } from '#/engine/bot/BotAppearance.js';
import InvType from '#/cache/config/InvType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import { ChatModePrivate } from '#/engine/entity/ChatModes.js';
import { usableBanks, vendorHome } from '#/engine/bot/port/BotTradeSpots.js';
import { MoveStrategy } from '#/engine/entity/MoveStrategy.js';
import { BotDebugService } from '#/engine/bot/debug/BotDebugService.js';
import { initBotFields } from '#/engine/bot/port/PlayerBotFields.js';
import { NameSource, ROSTER_SLOTS, botNameKey, initialPool, isLevelling, normalizeBotName, onlineShare, groupCap, poolShare, poolSize, type PlannerKey, type RosterEntry } from '#/engine/bot/port/BotRoster.js';
import { applyWorldRules, isAllowedCoord, FREE_WORLD_SAFE_TILE } from '#/engine/bot/port/BotWorldRules.js';
import { beginPathTick, boostPathSearches, FILL_BOOST_TICKS, pathSearchBudget, pathSearchBudgetFor, pathSearchesThisTick, setPathSearchBudget } from '#/engine/bot/port/BotPathing.js';
// (the variety work, round 1, track F: a login near a human lingers a moment, port/BotLinger)
import { loginLingerFor } from '#/engine/bot/port/BotLinger.js';
import { runScheduled } from '#/engine/bot/port/BotSchedule.js';
import { botConsole as console, botErrorCount, botLogTick, configureBotLog } from '#/engine/bot/port/BotLog.js';
import { dropStaleTradeTarget, tradeScreen } from '#/engine/bot/port/BotTradeScreen.js';
import { agedStartBank, ageTierFor, applyAge } from '#/engine/bot/port/BotAge.js';
import { isNewbie, lumbridgeLowLevel } from '#/engine/bot/port/BotNewbie.js';
import { awayAfter, NEWCOMER_WAIT_LOOKS, newcomerGap, newcomerGapMost, newcomerPace, sessionLeft, sessionLength, timing as makeTiming, uniform, type SessionTiming } from '#/engine/bot/port/BotSessions.js';
import { cliqueReturnBonus } from '#/engine/bot/port/BotCliques.js';
import { BotChat } from '#/engine/bot/port/BotChat.js';
import { readyToLeave } from '#/engine/bot/port/BotHabits.js';
import { tickCliques } from '#/engine/bot/port/BotCliques.js';
import { holdsLogout, isArmed, tickRandomEvents } from '#/engine/bot/port/BotRandomEvents.js';
// (the realism work, phase 5b: set pieces: the director, the newbie trains, a bot's part in a piece; the pieces' modules
// register themselves at load, port/BotSetPieceIndex)
import { exportDirector, restoreDirector, tickDirector } from '#/engine/bot/port/BotDirector.js';
import { exportArena, restoreArena } from '#/engine/bot/port/BotArena.js';
import { tickTrains } from '#/engine/bot/port/BotTrains.js';
import { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';
import '#/engine/bot/port/BotSetPieceIndex.js';
// (the realism work, phase 5b, Track A: the player-mod bot: its silver crown at spawn, and it never quits)
import { isPlayerModName } from '#/engine/bot/port/BotModBot.js';

export type BotLoadResult = { status: 'ok'; data: Uint8Array } | { status: 'missing' } | { status: 'error'; error: string };

export interface BotStartOptions {
    /** N: about this many bots online at a time (the pool is about 2N: port/BotRoster). */
    count: number;
    /** Environment.node.members: on a free world bots stay in F2P. */
    members: boolean;
    /** Verbose bot logging; errors are always logged, rate-limited. */
    debug: boolean;
    /** Spawning waits until a human player is in the world, and play time only passes while one is. */
    humanInWorld(): boolean;
    /** A human character has this name (a save exists or a player is online): no bot uses it. */
    isReservedName(name: string): boolean;
    /** The bot's persisted save; 'error' means: do not spawn that bot this session. */
    loadSave(name: string): BotLoadResult;
    /** Bots spawned per tick (default 5): no login burst. */
    spawnPerTick?: number;
    /** Path searches all bots together may start per tick (default: 12 per 100 bots online, at least 12; port/BotPathing). */
    pathSearchesPerTick?: number;
    /** Ageing is on for this bot store (the runtime turns it on for every store): a pool bot without a save gets an age (port/BotAge); newcomers start fresh. */
    ageNewBots?: boolean;
    /** The names with a record in the bot store: the pool starts with them. */
    savedNames?(): Iterable<string>;
    /** A bot of that name quit for good: the name is never used again. */
    isQuit?(name: string): boolean;
    /** A bot quits for good (it is offline): the store drops its record and keeps the name as used. */
    onQuit?(name: string): void;
    /** A human has this bot as a friend: it never quits. */
    isFriendOfHuman?(name: string): boolean;
    /** Session durations (tests; world.json bots.timing); DEFAULT_TIMING otherwise. */
    timing?: Partial<SessionTiming>;
    /** Random numbers for the sessions (tests); Math.random otherwise. */
    random?(): number;
    /** port (phase 3): a clique's bonus for _pickReturner (tests: a fake clique); port/BotCliques.cliqueReturnBonus otherwise */
    cliqueReturnBonus?(name: string, isOnline: (name: string) => boolean): number;
    /** port: the living world as the last run left it (exportWorld, kept in the store): continue after a restart */
    world?: unknown;
}

/**
 * port: the living world, to continue after a restart (the same bots online, with sessions,
 * absences and the newcomer clock carried in the store): in play ticks from the moment it was taken. Upstream, and the
 * port before this, drew every launch afresh: about half the bots online changed at each restart.
 */
export interface BotWorldState {
    v: 1;
    /** bots online (or logged out only because the world emptied): the rest of their session (-1: a new one) */
    online: Record<string, number>;
    /** bots away: until they may come back */
    away: Record<string, number>;
    nextNewcomer: number;
    newcomersDue: number[];
    newcomersWaiting: number;
    /** port: the pool's size before any top-up (BotRoster.initialPool): newcomers shed what a top-up added past it */
    pool?: number;
    /**
     * port (the realism work, phase 3: "near you first"): each bot's last place in the world, [x, z, level], where it
     * logs in again: at a login the bots nearest the human come first (BotManager._fill). Missing in an older store
     * (then a bot's save, or a new bot's spawn, tells it).
     */
    at?: Record<string, [number, number, number]>;
    /** port (phase 3: newbie time measured in levels, port/BotNewbie): the newcomers that are newbies still */
    newbies?: string[];
    /** port (the realism work, phase 5b): the set pieces' director's schedule (port/BotDirector exportDirector) */
    director?: unknown;
    /** port (phase 5b): the Duel Arena's purse and the bots the human beat (port/BotArena exportArena) */
    arena?: unknown;
}

export interface BotStats {
    /** N: the online target */
    configured: number;
    /** logins this run */
    spawned: number;
    /** in the world and playing */
    active: number;
    skipped: string[];
    lastTickMs: number;
    maxTickMs: number;
    pathSearchesLastTick: number;
    /** the most path searches a tick (port/BotPathing) */
    pathSearchBudget: number;
    errors: number;
    /** the pool: bots that take turns (online, joining, leaving and away) */
    pool: number;
    joining: number;
    leaving: number;
    away: number;
    /** sessions that ended with a logout, returns after one, newcomers that joined and accounts that quit, this run */
    logoffs: number;
    returns: number;
    newcomers: number;
    quits: number;
    /** names left for newcomers */
    namesLeft: number;
    /** play ticks this run (world ticks with a human in the world) */
    playTicks: number;
    /**
     * port (phase 3, "near you first"): the last time the world filled at a login: the ticks from its queue to its last
     * login (-1: none yet, or not done), and how many of the bots near the human logged in in its first ticks
     */
    fillTicks: number;
    fillNear: number;
    /**
     * port (phase 3, "Lumbridge newbies"): when the newcomer clock last looked (every 100 play ticks): the bots of combat 5
     * or less around Lumbridge online, and the newbies online (port/BotNewbie)
     */
    lowLevels: number;
    newbies: number;
}

// port: each gets the bot's name (the random planner's weights come from it)
const PLANNER_MAP: Record<PlannerKey, (name: string) => BotGoalPlanner> = {
    skiller: makeSkiller,
    fighter: makeFighter,
    balanced: makeBalanced,
    random: makeRandom,
    extras_edgeville_pker: makeExtrasEdgevillePKer,
    extras_vendor: makeExtrasVendor,
    extras_pker: makeExtrasPKer,
    extras_social: makeExtrasSocial
};

const STATUS_EVERY_TICKS = 100;
/** A login that processLogins did not take is tried again this many times (a later play tick), then not this session. */
const MAX_FAILED_LOGINS = 3;
/** After a goodbye in a conversation the bot leaves this many ticks later (so the line is seen). */
const GOODBYE_TICKS = 3;
/**
 * port (the realism work, phase 3: "near you first"): at a login the bots whose place is within NEAR_TILES of
 * the human (at most NEAR_MOST, after the human's friends) log in within the first NEAR_BURST_TICKS ticks, a short burst;
 * the rest at spawnPerTick. Before, 5 a tick in the role mix's order: nobody in view for the first 5-10 ticks, and a
 * crowd that popped in one by one for a minute or more.
 */
const NEAR_TILES = 40;
const NEAR_MOST = 25;
const NEAR_BURST_TICKS = 3;
/** port (phase 3): a place on another level counts as this many tiles further (nobody sees across floors) */
const OTHER_LEVEL_TILES = 64;
/** port (phase 3): how often the newcomer clock looks at the level-3s about Lumbridge (play ticks): a newcomer comes sooner when few are */
const NEWBIE_CHECK_TICKS = 100;
/**
 * port (phase 3): a due bot whose clique-mates are online comes before the others of its planner group (port/BotCliques,
 * "bot friend cliques": they log in together), never past the role mix: the bonus (at most this) applies only
 * while its group has a whole place to fill (it stays within its share), on top of the group's shortness.
 */
const CLIQUE_RETURN_WEIGHT = 0.5;

/**
 * Quest and unlock varps every bot gets at each spawn: upstream's list (each name, id and value checked against
 * Server/content: varp.pack and the completion test in quests.rs2 [proc,count_questpoints]) plus the quests rev 274
 * added. Complete quests only unlock content; no rewards are given. [name, id, value]
 */
export const BOT_VARPS: ReadonlyArray<[string, number, number]> = [
    // Alfred Grimhand's Barcrawl (Barbarian agility gate), no Wilderness lever warning, Femi opens the Stronghold gate
    ['barcrawl', 77, 2],
    ['warning_wilderness_teleport_lever', 81, 1],
    ['femi_help', 152, 2],
    // all quests complete, by release date
    ['cookquest', 29, 2],
    ['demonstart', 222, 30],
    ['prieststart', 107, 5],
    ['rjquest', 144, 100],
    ['sheep', 179, 22],
    ['blackarmgang', 145, 4],
    ['haunted', 32, 3],
    ['vampire', 178, 3],
    ['imp', 160, 2],
    ['princequest', 273, 110],
    ['doricquest', 31, 100],
    ['spy', 130, 4],
    ['hetty', 67, 3],
    ['squire', 122, 7],
    ['goblinquest', 62, 6],
    ['hunt', 71, 4],
    ['dragonquest', 176, 10],
    ['druidquest', 80, 4],
    ['zanaris', 147, 6],
    ['ballquest', 226, 7],
    ['arthur', 14, 7],
    ['heroquest', 188, 15],
    ['scorpcatcher', 76, 6],
    ['crestquest', 148, 11],
    ['totemquest', 200, 5],
    ['fishingcompo', 11, 5],
    ['drunkmonkquest', 30, 80],
    ['ikov', 26, 80],
    ['cogquest', 10, 8],
    ['grail', 5, 10],
    ['treequest', 111, 9],
    ['arenaquest', 17, 15],
    ['hazeelcultquest', 223, 9],
    ['sheepherderquest', 60, 3],
    // (port, the realism work's phase 5a: 30, Plague City done and its scroll read, 274's gate on the Ardougne teleport,
    // "You haven't learnt how to cast this spell yet" at 29; every quest script treats 29 and 30 alike)
    ['elenaquest', 165, 30],
    ['seaslugquest', 159, 12],
    ['waterfall_quest', 65, 10],
    ['biohazard', 68, 16],
    ['junglepotion', 175, 12],
    ['grandtree', 150, 160],
    ['zombiequeen', 116, 15],
    ['upass', 161, 10],
    ['itgronigen', 112, 7],
    ['desertrescue', 197, 30],
    ['itwatchtower', 212, 13],
    ['mcannon', 0, 11],
    ['murderquest', 192, 2],
    ['itexamlevel', 131, 9],
    ['fluffs', 180, 6],
    ['legendsquest', 139, 75],
    ['runemysteries', 63, 6],
    ['chompybird', 293, 65],
    ['elemental_workshop_bits', 299, 1048576],
    ['priestperil', 302, 60],
    ['druidspirit', 307, 110],
    ['death_equiproom', 314, 80],
    ['troll_quest', 317, 50],
    // port: the quests rev 274 added. Regicide matters most: with Underground Pass complete and regicide_quest 0,
    // login.rs2's ~start_king_messenger_timer would send the King's messenger after every bot
    ['tbwt_main', 320, 6],
    ['regicide_quest', 328, 15],
    ['eadgar_quest', 335, 110],
    ['morttonquest', 339, 85],
    ['viking', 347, 10]
];
// Horror from the Deep (274): %horrorquest is the varbit at bits 0-10 of varp deephorror
const HORROR_VARP: [string, number] = ['deephorror', 351];
const HORROR_COMPLETE = 10;
const HORROR_BITS = 0x7ff;

/** Tutorial Island done (^tutorial_complete): what 274's tutorial leaves set; login.rs2 tests it. */
const TUTORIAL_VARP: [string, number] = ['tutorial', 281];
const TUTORIAL_COMPLETE = 1000;

type MemberState = 'offline' | 'queued' | 'online' | 'leaving';

/** A bot of the pool, online or not. */
interface Member {
    readonly name: string;
    readonly planner: PlannerKey;
    readonly slot: number;
    /** joined as a brand-new account this run: never aged, never quits this run */
    readonly newcomer: boolean;
    state: MemberState;
    /** this login's bot (queued, online, leaving); null while away */
    bot: BotPlayer | null;
    /** world tick of this login, and whether it reached the world */
    spawnTick: number;
    entered: boolean;
    /** a human takes the name (or the bots were switched off): it leaves and never comes back this run */
    retiring: boolean;
    /** cannot log in this run (its save cannot be read, or the engine kept refusing it) */
    excluded: boolean;
    /** in the world at least once this run: its saves go to the bot store */
    owned: boolean;
    /** sent out at once (the world emptied, or it would not leave): the combat lock does not hold it */
    forced: boolean;
    /** play ticks: when this session ends, when it may come back, and what was left of its session when the world emptied */
    sessionEnd: number;
    awayUntil: number;
    resume: number;
    /** port: online when the last run's world was saved (BotWorldState): first back at the first fill */
    wasOnline?: boolean;
    /** port (phase 3): its last place in the world (it logs in there again; BotWorldState.at), null: not known */
    at: [number, number, number] | null;
    /** port (phase 3): a newcomer that is a newbie still (port/BotNewbie: until combat 10 or total level 60) */
    newbie: boolean;
    /** port (phase 3): its session's length as drawn (-1: not drawn this run, or what was left of one): a check-in's absence is shorter */
    drawn: number;
    /** play tick it started leaving; the first play tick its session end was put off (-1 = not); its goodbye (-1 = none) */
    leftAt: number;
    busySince: number;
    goodbyeAt: number;
    failedLogins: number;
    sessions: number;
}

// ── BotManager singleton ──────────────────────────────────────────────────────

class BotManagerClass {
    private world: typeof World | null = null;
    private options: BotStartOptions | null = null;
    private timing: SessionTiming = makeTiming();
    private random: () => number = Math.random;
    private readonly members: Map<string, Member> = new Map();
    /** every name a bot had or a human holds, as far as this run knows: never a newcomer's */
    private readonly known: Set<string> = new Set();
    private names: NameSource | null = null;
    private pending: Member[] = [];
    private readonly skipped: string[] = [];
    private configured = 0;
    private poolCap = 0;
    /**
     * port: the size the pool keeps, past poolCap (a pool saved when N was higher stays): its size before a top-up
     * (BotRoster.initialPool), kept in the world state; while the pool is bigger, a second bot quits per newcomer
     */
    private poolKeep = 0;
    private spawnedTotal = 0;
    private tickCount = 0;
    private tickErrors = 0;
    private lastTickMs = 0;
    private maxTickMs = 0;
    private pathSearchesLastTick = 0;

    // sessions (play ticks: world ticks with a human in the world)
    private play = 0;
    private emptyTicks = 0;
    /** the world fills at once: at the first login of the run and after it emptied */
    private filling = true;
    private firstFill = true;
    /** play ticks at which a bot comes back to fill a place (one per missing bot, each after a short random gap) */
    private returnsDue: number[] = [];
    private nextNewcomer = 0;
    private readonly newcomersDue: number[] = [];
    /** port: a new character's newcomers, waiting for it to leave Tutorial Island */
    private newcomersWaiting = 0;
    private logoffs = 0;
    private returns = 0;
    private newcomers = 0;
    private quits = 0;
    /** NameSource.remaining() looks at every unused name (a player lookup each): counted when it changes, not per stats() */
    private namesLeft = 0;
    /** port (phase 3, near you first): the login fill's burst (the bots near the human, and the ticks it may take), its queue tick and stats */
    private burstLeft = 0;
    private burstTicks = 0;
    private fillQueuedAt = -1;
    private fillTicks = -1;
    private fillNear = 0;
    /** port (phase 3): a login fill is under way (its first queue set the burst; a later pick in it only joins the order) */
    private fillStarted = false;
    /** port (phase 3): the level-3s around Lumbridge and the newbies online when the newcomer clock last looked (_countLowLevels) */
    private lowLevels = 0;
    private newbiesOnline = 0;
    /** port (phase 3): the newcomer clock's looks in a row that waited (NEWCOMER_WAIT_LOOKS: then a newcomer anyway) */
    private newcomerWaits = 0;

    /** After World.start (the map and configs are loaded), before the first tick. Spawns nothing yet. */
    start(world: typeof World, options: BotStartOptions): void {
        if (this.world) {
            throw new Error('BotManager.start: already started');
        }
        this.world = world;
        this.options = options;
        this.timing = makeTiming(options.timing);
        this.random = options.random ?? Math.random;
        setWorld(world);
        configureBotLog(options.debug);
        BotDebugService.configure();

        const removed = applyWorldRules(options.members);
        this.configured = Math.max(0, Math.min(Math.floor(options.count) || 0, ROSTER_SLOTS));
        setPathSearchBudget(options.pathSearchesPerTick ?? pathSearchBudgetFor(this.configured));
        const saved = [...(options.savedNames?.() ?? [])].map(normalizeBotName);
        for (const name of saved) this.known.add(name);
        const isQuit = (name: string) => options.isQuit?.(name) === true;
        const { entries, reserved, topUp } = this.configured > 0 ? initialPool(this.configured, saved, name => !options.isReservedName(name), isQuit) : { entries: [], reserved: [], topUp: 0 };
        for (const entry of entries) this._addMember(entry);
        this.skipped.push(...reserved);
        for (const name of reserved) this.known.add(name);
        // (a pool bigger than this, saved when N was higher, stays: one bot quits per newcomer, so it does not grow;
        // port: but not one a top-up made bigger: poolKeep)
        this.poolCap = poolSize(this.configured);
        const kept = (options.world as Partial<BotWorldState> | null | undefined)?.pool;
        const before = entries.length - topUp;
        this.poolKeep = Math.max(this.poolCap, typeof kept === 'number' && Number.isFinite(kept) && kept >= 0 ? Math.min(before, kept) : before);
        this.names = new NameSource(name => this.known.has(name) || isQuit(name) || options.isReservedName(name));
        this.nextNewcomer = uniform(this.timing.newcomer, this.random);
        this._restoreWorld(options.world);
        this.namesLeft = this.names.remaining();
        const savedSet = new Set(saved);
        const fresh = entries.filter(e => !savedSet.has(e.name)).length;
        console.info(
            `[BotManager] about ${this.configured} bots online out of ${this.members.size} (${this.members.size - fresh} saved, ${fresh} new; ` +
                `${options.members ? 'members' : 'free'} world` +
                (removed > 0 ? `, ${removed} members-only steps dropped` : '') +
                (options.ageNewBots ? ', new bots get an age' : '') +
                `, ${pathSearchBudget()} path searches a tick` +
                (reserved.length > 0 ? `; names a human has: ${reserved.join(', ')}` : '') +
                ')'
        );
    }

    /** Every tick, after World.processPlayers and before World.processLogouts. Never throws. */
    tick(): void {
        const world = this.world;
        if (!world) return;
        const started = performance.now();
        const tick = world.currentTick;
        this.tickCount++;
        botLogTick(tick);
        beginPathTick();

        try {
            // keep-alive first, also while the world shuts down (upstream rewrote processLogouts for it): a
            // client-less Player's lastResponse/lastConnected are only refreshed by NetworkPlayer.decodeIn, so a bot
            // would be idle-logged-out after 50 ticks. A retiring bot gets none: it is forced out after 100.
            for (const member of this.members.values()) {
                const bot = member.bot;
                if (!bot) continue;
                const player = bot.player;
                if (player.slot === -1) {
                    if (member.entered) this._wentAway(member);
                    else if (member.spawnTick < tick && player.uid === -1) this._loginFailed(member);
                    continue;
                }
                if (!member.entered) this._cameOnline(member);
                if (member.retiring || member.forced) {
                    // it leaves for a human who wants the name, or for an empty world: a fight must not keep it here
                    // (every hit it takes renews the 16-tick combat logout lock, and the login waits only ~10 s for it)
                    player.preventLogoutUntil = -1;
                    player.loggingOut = true;
                    continue;
                }
                player.lastResponse = tick;
                player.lastConnected = tick;
                // its session is over: the player's logout button, every tick until the engine lets it go
                if (member.state === 'leaving') player.requestLogout = true;
            }

            if (world.shutdownSoon || world.shutdown) return;

            this._sessions();
            this._spawnSome(tick);
            runScheduled(tick);
            // port: a friend bot now and then messages the human first
            const isFriend = this.options?.isFriendOfHuman;
            if (isFriend && this.options!.humanInWorld()) BotChat.tickOpeners(name => isFriend(name));
            // port (the realism work): exchanges between bots near a human, and bots' reactions to a human (port/BotStage,
            // port/BotReactions)
            if (this.options!.humanInWorld()) {
                try {
                    BotChat.tickTalk();
                } catch (err) {
                    this.tickErrors++;
                    console.error('[BotManager] talk failed', err);
                }
                // port (the realism work, phase 3): bot friend cliques (port/BotCliques): who travels with whom, friends
                // greeting each other; a friend that leaves with another ends its session within `ticks` play ticks
                try {
                    tickCliques((name, ticks) => {
                        const member = this.members.get(name);
                        if (member && member.state === 'online' && !member.retiring) member.sessionEnd = Math.min(member.sessionEnd, this.play + ticks);
                    });
                } catch (err) {
                    this.tickErrors++;
                    console.error('[BotManager] cliques failed', err);
                }
                // port (the realism work, phase 5a): random events on bots near a human (port/BotRandomEvents: arming
                // at 274's own roll, the cap, what came of an armed flag)
                try {
                    tickRandomEvents();
                } catch (err) {
                    this.tickErrors++;
                    console.error('[BotManager] random events failed', err);
                }
                // port (the realism work, phase 5b): the set pieces' director, about one notable event an hour of play
                // where the bots are (port/BotDirector), and Lumbridge's newbie follow trains (port/BotTrains)
                try {
                    tickDirector();
                } catch (err) {
                    this.tickErrors++;
                    console.error('[BotManager] director failed', err);
                }
                try {
                    tickTrains();
                } catch (err) {
                    this.tickErrors++;
                    console.error('[BotManager] trains failed', err);
                }
            }

            if (BotDebugService.enabled) BotDebugService.setTick(this.tickCount);
            // a different bot goes first every tick: the path search budget (port/BotPathing) is spent in this
            // order, so a fixed order would leave the last bots without searches whenever the first ones use it up
            const playing: BotPlayer[] = [];
            for (const member of this.members.values()) {
                if (member.state === 'online' && !member.retiring && member.bot && member.bot.player.slot !== -1) playing.push(member.bot);
            }
            const first = playing.length > 0 ? this.tickCount % playing.length : 0;
            for (let i = 0; i < playing.length; i++) {
                const bot = playing[(first + i) % playing.length];
                try {
                    bot.tick();
                    // port: a trade request no task took up (a task switch in between, an error) does not leave the
                    // bot "trading" for good: deaf to its name and to "come here" (port/BotTradeScreen)
                    dropStaleTradeTarget(bot.player, tick);
                } catch (err) {
                    // never let one bot take the world down (World.cycle's catch removes every player and exits)
                    this.tickErrors++;
                    console.error(`[BotManager] ${bot.name}: tick failed`, err);
                }
            }

            if (this.tickCount % STATUS_EVERY_TICKS === 0) {
                this._printStatus();
            }
        } catch (err) {
            this.tickErrors++;
            console.error('[BotManager] tick failed', err);
        } finally {
            this.pathSearchesLastTick = pathSearchesThisTick();
            this.lastTickMs = performance.now() - started;
            if (this.lastTickMs > this.maxTickMs) this.maxTickMs = this.lastTickMs;
        }
    }

    /**
     * After World.processClientsIn, which rolls afkEventReady with Math.random. The engine's roll is cleared for every
     * bot; a bot keeps the flag only when port/BotRandomEvents armed it (the realism work's phase 5a: random events on
     * bots near the human, at its own seeded odds).
     */
    clearAfkEvents(): void {
        for (const member of this.members.values()) {
            if (member.bot && !isArmed(member.bot.player)) member.bot.player.afkEventReady = false;
        }
    }

    isBotPlayer(player: Player): boolean {
        return player.is_bot === true;
    }

    /** In the world at least once this run and not released: its saves go to the bot store. */
    ownsName(name: string): boolean {
        return this.members.get(normalizeBotName(name))?.owned === true;
    }

    /** In the world and playing (not retiring, not on its way out). */
    isActiveBot(name: string): boolean {
        const member = this.members.get(normalizeBotName(name));
        return member !== undefined && this._playing(member);
    }

    /** A human made a new character (a login with no save): 1-3 newcomers follow it into the world over the next minutes. */
    newCharacter(): void {
        if (!this.world || this.configured === 0) return;
        const count = uniform(this.timing.newCharacterCount, this.random);
        // port: they set out once no human is on Tutorial Island any more (_releaseNewcomers): a new character starts
        // there, and its newcomers met it at the Lumbridge courtyard, as new players come off the island
        this.newcomersWaiting += count;
        // the regular newcomer is not due on top of these (port, phase 3: nor the one a waiting clock lets in now and then)
        this.nextNewcomer = Math.max(this.nextNewcomer, this.play + uniform(this.timing.newcomer, this.random));
        this.newcomerWaits = 0;
        console.info(`[BotManager] a new character: ${count} newcomer${count === 1 ? '' : 's'} on the way`);
    }

    /**
     * A human wants this name: the bot logs out through the normal logout path (LOGOUT script, removePlayer, its
     * final save), never comes back this run and stays owned until release(). True for every owned bot (one away has
     * nothing left to do), false if the name is not a bot's this run (a pool bot that was never in the world leaves
     * the pool at once).
     */
    retire(name: string): boolean {
        const key = normalizeBotName(name);
        const member = this.members.get(key);
        if (!member) return false;
        if (!member.owned) {
            this._drop(member);
            return false;
        }
        if (!member.retiring) {
            member.retiring = true;
            this.pending = this.pending.filter(m => m !== member);
            const player = member.bot?.player;
            if (player && player.slot !== -1) {
                try {
                    member.bot!.windDown();
                } catch (err) {
                    console.error(`[BotManager] ${key}: winding down failed`, err);
                }
                player.preventLogoutUntil = -1;
                player.loggingOut = true;
            }
            console.info(`[BotManager] ${key} retires: a human logs in with this name`);
        }
        return true;
    }

    /** The glue stored the retired bot's final save: the name is a human's from now on. */
    release(name: string): void {
        const member = this.members.get(normalizeBotName(name));
        if (member) this._drop(member);
    }

    *activeBots(): IterableIterator<Player> {
        for (const member of this.members.values()) {
            if (this._playing(member)) yield member.bot!.player;
        }
    }

    /** The BotPlayer driving an active bot (chat, trade), or null: also for an old Player object of a bot that came back. */
    botFor(player: Player): BotPlayer | null {
        if (player.is_bot !== true) return null;
        const member = this.members.get(player.username);
        return member && this._playing(member) && member.bot!.player === player ? member.bot : null;
    }

    stats(): BotStats {
        let active = 0;
        let joining = 0;
        let leaving = 0;
        let away = 0;
        for (const member of this.members.values()) {
            if (this._playing(member)) active++;
            else if (member.state === 'queued' && !member.retiring) joining++;
            else if (member.state === 'leaving' || (member.state === 'online' && member.retiring)) leaving++;
            else if (member.state === 'offline') away++;
        }
        return {
            configured: this.configured,
            spawned: this.spawnedTotal,
            active,
            skipped: [...this.skipped],
            lastTickMs: this.lastTickMs,
            maxTickMs: this.maxTickMs,
            pathSearchesLastTick: this.pathSearchesLastTick,
            pathSearchBudget: pathSearchBudget(),
            errors: this.tickErrors + botErrorCount(),
            pool: this.members.size,
            joining,
            leaving,
            away,
            logoffs: this.logoffs,
            returns: this.returns,
            newcomers: this.newcomers,
            quits: this.quits,
            namesLeft: this.namesLeft,
            playTicks: this.play,
            fillTicks: this.fillTicks,
            fillNear: this.fillNear,
            lowLevels: this.lowLevels,
            newbies: this.newbiesOnline
        };
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private _addMember(entry: RosterEntry): Member {
        const member: Member = {
            name: entry.name,
            planner: entry.planner,
            slot: entry.slot,
            newcomer: entry.newcomer === true,
            state: 'offline',
            bot: null,
            spawnTick: -1,
            entered: false,
            retiring: false,
            excluded: false,
            owned: false,
            forced: false,
            sessionEnd: 0,
            awayUntil: 0,
            resume: 0,
            leftAt: -1,
            busySince: -1,
            goodbyeAt: -1,
            failedLogins: 0,
            sessions: 0,
            at: null,
            newbie: false,
            drawn: -1
        };
        this.members.set(entry.name, member);
        this.known.add(entry.name);
        return member;
    }

    /** Out of the pool for good (a human has the name now, or it quit). */
    private _drop(member: Member): void {
        this.members.delete(member.name);
        this.pending = this.pending.filter(m => m !== member);
        this.known.add(member.name);
    }

    /** In the world and not on its way out: online, or in since processLogins took it (its session starts next tick). */
    private _playing(member: Member): boolean {
        return (member.state === 'online' || member.state === 'queued') && !member.retiring && member.bot !== null && member.bot.player.slot !== -1;
    }

    /** processLogins took the bot: its session starts. */
    private _cameOnline(member: Member): void {
        member.entered = true;
        member.owned = true;
        if (member.retiring) return;
        member.state = 'online';
        member.sessions++;
        member.busySince = -1;
        member.goodbyeAt = -1;
        member.failedLogins = 0;
        let length: number;
        if (member.resume > 0) {
            length = member.resume; // the world emptied in the middle of its session
        } else if (member.sessions === 1 && this.firstFill) {
            // the first bots of a run are somewhere in their session already: they do not all leave together
            // port: the shortest from 50 ticks to a quarter session, drawn (a floor of exactly a quarter session, 500
            // ticks, sent 12 to 19% of the bots off in one wave 5 minutes after every launch)
            // port (phase 3): what is left of a session under way (port/BotSessions.sessionLeft: a long one is more
            // likely to be under way; with heavy tails the plain draw ended most first sessions early)
            const floor = 50 + this.random() * Math.max(0, this.timing.session[0] / 4 - 50);
            length = Math.max(floor, sessionLeft(this.timing.session, this.random));
            member.drawn = -1;
        } else {
            // port (phase 3, "heavier-tailed sessions"): 5 minutes to 6 hours (port/BotSessions.sessionLength)
            length = member.drawn = sessionLength(this.timing.session, this.random);
        }
        member.resume = 0;
        member.wasOnline = false;
        member.sessionEnd = this.play + length;
        if (member.sessions > 1) this.returns++;
        // port (the variety work, round 1, track F: pop-out): a login near a human lingers 10-40 s first (port/BotLinger)
        const bot = member.bot;
        if (bot) {
            const linger = loginLingerFor(bot.player);
            if (linger) bot.setSubTask(linger);
        }
    }

    /**
     * port (the variety work, round 1, track F: the scam caller's logout, port/BotScams): the session of the bot of that
     * name ends within `ticks` play ticks (its wrap-up and goodbye as any session's end), as a clique friend leaving
     * with another does (tickCliques). Nothing for a name not online.
     */
    leaveSoon(name: string, ticks: number): void {
        const member = this.members.get(normalizeBotName(name));
        if (member && member.state === 'online' && !member.retiring) member.sessionEnd = Math.min(member.sessionEnd, this.play + Math.max(1, Math.floor(ticks)));
    }

    /** The bot is out of the world (its logout went through): away until it comes back. */
    private _wentAway(member: Member): void {
        const wasLeaving = member.state === 'leaving';
        // port (phase 3): where it logs in again (near you first), and whether it is a newbie still (newbie by levels)
        const player = member.bot?.player;
        if (player) {
            member.at = [player.x, player.z, player.level];
            if (member.newbie) member.newbie = isNewbie(player);
        }
        member.state = 'offline';
        BotDebugService.unregisterBot(member.name);
        member.bot = null;
        member.entered = false;
        member.forced = false;
        member.leftAt = -1;
        member.busySince = -1;
        member.goodbyeAt = -1;
        // port (phase 3): a check-in (a short session) is followed by a shorter absence (port/BotSessions.awayAfter)
        member.awayUntil = member.resume > 0 ? this.play : this.play + awayAfter(wasLeaving ? member.drawn : -1, this.timing, this.random);
        if (member.retiring) return;
        if (wasLeaving) this.logoffs++;
        else console.info(`[BotManager] ${member.name} left the world`);
        if (this.options?.debug && member.resume === 0) console.info(`[BotManager] ${member.name} logged out; back in ${((member.awayUntil - this.play) / 100).toFixed(0)} min of play at the earliest`);
    }

    /** A login processLogins did not take (a player of that name was still there, or still saving): try again later. */
    private _loginFailed(member: Member): void {
        member.state = 'offline';
        member.bot = null;
        member.entered = false;
        member.failedLogins++;
        member.awayUntil = this.play + 10;
        if (member.failedLogins >= MAX_FAILED_LOGINS) {
            member.excluded = true;
            this.skipped.push(member.name);
            console.warn(`[BotManager] ${member.name} could not enter the world ${MAX_FAILED_LOGINS} times; not this session`);
        }
    }

    /** Who logs out, who comes back, who is new, and who quits. Play time passes only with a human in the world. */
    private _sessions(): void {
        const options = this.options!;
        if (!options.humanInWorld()) {
            this.emptyTicks++;
            if (this.emptyTicks === this.timing.emptyWorld) this._emptyWorld();
            return;
        }
        if (this.emptyTicks >= this.timing.emptyWorld) this.filling = true;
        this.emptyTicks = 0;
        const play = ++this.play;

        for (const member of this.members.values()) {
            if (member.retiring) continue;
            if (member.state === 'online' && (member.sessionEnd <= play || (member.goodbyeAt >= 0 && member.goodbyeAt <= play))) {
                // (its wrap-up runs every tick till it goes: a throw must not stop the other bots' tick each time)
                try {
                    this._endSession(member);
                } catch (err) {
                    this.tickErrors++;
                    console.error(`[BotManager] ${member.name}: ending its session failed`, err);
                    this._leave(member, true);
                }
            } else if (member.state === 'leaving' && !member.forced && play - member.leftAt >= this.timing.leaveGiveUp) {
                // still here because a fight keeps renewing the logout lock: back to playing (and defending itself) for
                // a bit, then it tries again. Anything else that holds it (a delay, a queued script) lets it go in time:
                // the engine has it loggingOut already.
                const player = member.bot!.player;
                if (this.world!.currentTick < player.preventLogoutUntil && !player.loggingOut) {
                    player.requestLogout = false;
                    member.state = 'online';
                    member.sessionEnd = play + uniform([this.timing.leaveGiveUp * 2, this.timing.leaveGiveUp * 6], this.random);
                    member.busySince = -1;
                }
            }
        }

        // port (phase 3: "Lumbridge newbies", newbie time measured in levels): the newcomer clock keeps about 7-9
        // level-3s around Lumbridge per 100 online (port/BotSessions newcomerPace): soon while fewer are about; while 9 or
        // more are it waits, and one look in NEWCOMER_WAIT_LOOKS lets one in anyway
        if (play >= this.nextNewcomer) {
            // (while it waits, one look in NEWCOMER_WAIT_LOOKS a newcomer comes anyway)
            const waits = newcomerPace(this._countLowLevels(), this.configured) === 'wait';
            this.newcomerWaits = waits ? this.newcomerWaits + 1 : 0;
            if (!waits || this.newcomerWaits >= NEWCOMER_WAIT_LOOKS) {
                this.newcomerWaits = 0;
                this._admitNewcomer();
            }
            this.nextNewcomer = play + newcomerGap(newcomerPace(this._countLowLevels(), this.configured), this.configured, this.timing, this.random);
        } else if (play % NEWBIE_CHECK_TICKS === 0 && newcomerPace(this._countLowLevels(), this.configured) === 'soon' && this.nextNewcomer - play > newcomerGapMost('soon', this.configured, this.timing)) {
            // (few level-3s about and the next newcomer far off: it comes sooner)
            this.nextNewcomer = play + newcomerGap('soon', this.configured, this.timing, this.random);
        }
        if (this.newcomersWaiting > 0 && !this._humanOnTutorialIsland()) {
            for (; this.newcomersWaiting > 0; this.newcomersWaiting--) this.newcomersDue.push(play + uniform(this.timing.newCharacterDelay, this.random));
            this.newcomersDue.sort((a, b) => a - b);
        }
        while (this.newcomersDue.length > 0 && this.newcomersDue[0] <= play) {
            this.newcomersDue.shift();
            this._admitNewcomer();
        }

        this._fill(play);
    }

    /**
     * port (phase 3): the level-3s around Lumbridge online (port/BotNewbie.lumbridgeLowLevel; a brand-new newcomer on its
     * way in counts: it comes out at the courtyard), and the newbies online; kept for stats()
     */
    private _countLowLevels(): number {
        let low = 0;
        let newbies = 0;
        for (const member of this.members.values()) {
            if (member.retiring) continue;
            if (member.state === 'queued') {
                if (member.newcomer && member.sessions === 0) low++;
                if (member.newbie) newbies++;
                continue;
            }
            const player = member.bot?.player;
            if (member.state !== 'online' || !player || player.slot === -1) continue;
            if (member.newbie) member.newbie = isNewbie(player);
            if (member.newbie) newbies++;
            if (lumbridgeLowLevel(player)) low++;
        }
        this.lowLevels = low;
        this.newbiesOnline = newbies;
        return low;
    }

    /**
     * Its session is over: it logs out, unless it is busy (then later), and with a goodbye if it was talking.
     * port (the realism work, phase 2): and as a player does (port/BotHabits.readyToLeave): a gatherer near a bank banks
     * its load, any other finishes what it is doing, stands a moment and now and then says goodbye with players near;
     * at most 150 ticks, then it goes anyway. A bot kept busy past busyGiveUp still leaves at once.
     */
    private _endSession(member: Member): void {
        const bot = member.bot!;
        const player = bot.player;
        const tick = this.world!.currentTick;
        const play = this.play;
        if (member.goodbyeAt < 0 || member.goodbyeAt > play) {
            const busy = this._busy(player, tick);
            if (busy === 'conversation' && member.goodbyeAt < 0) {
                // (typed: it leaves GOODBYE_TICKS after the line is said)
                member.goodbyeAt = play + BotChat.sayGoodbye(player) + GOODBYE_TICKS;
                return;
            }
            if (busy !== null && busy !== 'conversation') {
                if (member.busySince < 0) member.busySince = play;
                if (play - member.busySince < this.timing.busyGiveUp) return;
            }
            if (member.goodbyeAt > play) return;
            // (a bot that said its goodbye in a conversation goes then: no wrap-up and no second goodbye)
            if (busy === null && member.goodbyeAt < 0 && !readyToLeave(bot)) return;
        }
        this._leave(member, false);
    }

    /** What keeps a bot whose session is over in the world for now, or null. */
    private _busy(player: Player, tick: number): 'fight' | 'trade' | 'come here' | 'conversation' | 'busy' | null {
        if (tick < player.preventLogoutUntil) return 'fight';
        if (player.botTradeTargetPid !== -1 || tradeScreen(player) !== null) return 'trade';
        if (player.botComeHereReturnX !== -1) return 'come here';
        // port: a script it must finish (a delay, a protected queue); not an open interface, which the logout closes (an
        // open one kept smiths at the anvil and thieves past their session by the whole give-up, 10 minutes)
        if (player.delayed || player.protect) return 'busy';
        // port (the realism work, phase 5a): a random event under way (a strange box, the mime, the maze, a tool head on
        // the ground, the way down from a fail teleport: port/BotRandomEvents)
        if (holdsLogout(player)) return 'busy';
        // port (the realism work, phase 5b): a part in a set piece (a host, a duellist, a clan walk's leader: port/BotSetPieces)
        if (eventRoleOf(player)) return 'busy';
        if (BotChat.inConversation(player)) return 'conversation';
        return null;
    }

    /** The bot stops what it is doing (its claims on trees, NPCs and other bots go) and logs out through the normal path. */
    private _leave(member: Member, forced: boolean): void {
        const bot = member.bot!;
        member.state = 'leaving';
        member.leftAt = this.play;
        member.busySince = -1;
        member.goodbyeAt = -1;
        member.forced = forced;
        try {
            bot.windDown();
        } catch (err) {
            console.error(`[BotManager] ${member.name}: winding down failed`, err);
        }
        bot.player.requestLogout = true;
    }

    /** port: the living world now, for the store (BotWorldState); null before start */
    exportWorld(): BotWorldState | null {
        if (!this.world) return null;
        const state: BotWorldState = { v: 1, online: {}, away: {}, nextNewcomer: Math.max(0, this.nextNewcomer - this.play), newcomersDue: this.newcomersDue.map(t => Math.max(0, t - this.play)), newcomersWaiting: this.newcomersWaiting, pool: this.poolKeep, at: {}, newbies: [] };
        for (const member of this.members.values()) {
            if (member.retiring || member.excluded) continue;
            if (member.state === 'online') state.online[member.name] = Math.max(1, member.sessionEnd - this.play);
            else if (member.state === 'queued' || member.resume > 0 || (member.wasOnline && member.sessions === 0)) state.online[member.name] = member.resume > 0 ? member.resume : -1;
            else if (member.state === 'offline') state.away[member.name] = Math.max(0, member.awayUntil - this.play);
            else if (member.state === 'leaving') state.away[member.name] = this.timing.away[0]; // (its absence is drawn when it is out)
            // port (phase 3): its place (where it is now, or where it left), and whether it is a newbie still
            const player = member.bot && member.bot.player.slot !== -1 ? member.bot.player : null;
            const at = player ? ([player.x, player.z, player.level] as [number, number, number]) : member.at;
            if (at) state.at![member.name] = at;
            if (player ? isNewbie(player) : member.newbie) state.newbies!.push(member.name);
        }
        // port (phase 5b): the director's schedule (its next event, the last venues)
        const director = exportDirector();
        if (director !== null && director !== undefined) state.director = director;
        // port (phase 5b): the Duel Arena's purse and the bots the human beat (no farming across a restart)
        const arena = exportArena(this.play);
        if (arena !== null && arena !== undefined) state.arena = arena;
        return state;
    }

    /**
     * port (the realism work, phase 5b: the director's recruits, port/BotDirector): the play ticks left in the session of
     * the bot of that name online now (to its goodbye if it said one), 0 for one leaving or out, Infinity for a name the
     * pool does not hold (the tests' bots). The spec calls it sessionLeft; BotSessions has a sessionLeft of its own.
     */
    sessionLeftOf(name: string): number {
        const member = this.members.get(normalizeBotName(name));
        if (!member) return Infinity;
        if (member.state !== 'online' || member.retiring) return 0;
        const end = member.goodbyeAt >= 0 ? Math.min(member.sessionEnd, member.goodbyeAt) : member.sessionEnd;
        return Math.max(0, end - this.play);
    }

    /**
     * port: the last run's world (exportWorld), if the store has one: who comes back first and when the others may.
     * Each time at most this run's longest (a run with other timing: the tests' short sessions after a default run).
     */
    private _restoreWorld(raw: unknown): void {
        const state = raw as BotWorldState | null | undefined;
        if (!state || typeof state !== 'object' || state.v !== 1 || typeof state.online !== 'object' || typeof state.away !== 'object') return;
        const ticks = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? Math.max(-1, Math.floor(n)) : null);
        const timing = this.timing;
        // port (phase 3): the places (near you first) and the newbies (newbie by levels); an older store has neither
        const at = state.at && typeof state.at === 'object' ? state.at : {};
        const newbies = new Set(Array.isArray(state.newbies) ? state.newbies.filter(n => typeof n === 'string') : []);
        let online = 0;
        for (const member of this.members.values()) {
            const place = (at as Record<string, unknown>)[member.name];
            if (Array.isArray(place) && place.length === 3 && place.every(n => Number.isInteger(n) && n >= 0 && n < 16384)) member.at = [place[0], place[1], place[2]];
            if (newbies.has(member.name)) member.newbie = true;
            const left = ticks(state.online[member.name]);
            if (left !== null) {
                member.wasOnline = true;
                member.resume = left > 0 ? Math.min(left, timing.session[1]) : 0;
                online++;
                continue;
            }
            const away = ticks(state.away[member.name]);
            if (away !== null) member.awayUntil = this.play + Math.min(Math.max(0, away), timing.away[1]);
        }
        const next = ticks(state.nextNewcomer);
        if (next !== null) this.nextNewcomer = this.play + Math.min(Math.max(0, next), timing.newcomer[1]);
        if (Array.isArray(state.newcomersDue)) {
            for (const t of state.newcomersDue.slice(0, 10)) {
                const due = ticks(t);
                if (due !== null) this.newcomersDue.push(this.play + Math.min(Math.max(0, due), timing.newCharacterDelay[1]));
            }
            this.newcomersDue.sort((a, b) => a - b);
        }
        const waiting = ticks(state.newcomersWaiting);
        if (waiting !== null && waiting > 0) this.newcomersWaiting = Math.min(waiting, 10);
        // port (phase 5b): the director's schedule (an older store has none)
        try {
            restoreDirector(state.director);
        } catch (err) {
            console.error('[BotManager] the director\'s schedule could not be restored', err);
        }
        // port (phase 5b): the Duel Arena's purse and the bots the human beat (an older store has none)
        try {
            restoreArena(state.arena, this.play);
        } catch (err) {
            console.error('[BotManager] the Duel Arena\'s purse could not be restored', err);
        }
        console.info(`[BotManager] continuing the last run's world: ${online} bots were online`);
    }

    /** Nobody has been in the world for a while (the title screen): every bot logs out, keeping the rest of its session. */
    private _emptyWorld(): void {
        let n = 0;
        for (const member of this.pending) member.state = 'offline';
        this.pending = [];
        // (port, phase 3: the next login's fill is a new one, with its own burst near the human)
        this.fillStarted = false;
        this.burstLeft = 0;
        for (const member of this.members.values()) {
            if (member.retiring || !member.bot) continue;
            if (member.state === 'online') member.resume = Math.max(1, member.sessionEnd - this.play);
            else if (member.state === 'leaving') member.resume = 0;
            if (member.bot.player.slot === -1) continue;
            this._leave(member, true);
            n++;
        }
        if (n > 0) console.info(`[BotManager] nobody is in the world: ${n} bots log out until someone is`);
    }

    /**
     * Fewer than N bots online: each missing place is filled a short random gap later (so a bot that logs out is
     * replaced about as fast as bots log out, at any N), or, when the world fills, all at once.
     */
    private _fill(play: number): void {
        let online = 0;
        for (const member of this.members.values()) {
            if ((member.state === 'online' || member.state === 'queued') && !member.retiring) online++;
        }
        const missing = this.configured - online;
        if (missing <= 0) {
            this.returnsDue = [];
            if (this.filling && this.pending.length === 0) this._filled();
            return;
        }
        if (this.filling) {
            this.returnsDue = [];
            // port: the groups' shares counted once for the whole fill (upstream counted the pool again for every pick:
            // 48 ms in one tick at 500 online)
            const groups = this._groupCounts();
            for (let i = 0; i < missing; i++) {
                const member = this._pickReturner(true, groups);
                if (!member) break;
                this._queue(member);
                groups.online.set(member.planner, (groups.online.get(member.planner) ?? 0) + 1);
            }
            // port: the human's friends among them log in first (the same bots come, in another order): at 250 or 500
            // online the fill takes 50 to 100 ticks, longer than the friend list waits for it, and a burst of
            // "<friend> has logged in." followed every login
            // port (phase 3, "near you first"): then the nearest to the human first, each where it left (no
            // steering): the ones within NEAR_TILES (at most NEAR_MOST) in the first NEAR_BURST_TICKS ticks (_spawnSome)
            this._nearFirst(!this.fillStarted);
            this.fillStarted = true;
            if (this.pending.length === 0) this._filled();
            return;
        }
        if (this.returnsDue.length > missing) this.returnsDue.length = missing;
        while (this.returnsDue.length < missing) this.returnsDue.push(play + uniform(this.timing.returnGap, this.random));
        this.returnsDue.sort((a, b) => a - b);
        while (this.returnsDue.length > 0 && this.returnsDue[0] <= play) {
            this.returnsDue.shift();
            const member = this._pickReturner(false);
            if (member) this._queue(member);
        }
    }

    /**
     * port (phase 3, "near you first"): the fill's queue in login order: the human's friends, then by how far each bot's
     * place (BotWorldState.at, its save's, or a new bot's spawn: _placeOf) is from the human; the friends and the bots
     * within NEAR_TILES (at most NEAR_MOST) make the burst that logs in in the first NEAR_BURST_TICKS ticks. Only the
     * order changes: the same bots come, from where they left.
     */
    private _nearFirst(start: boolean): void {
        const isFriend = this.options?.isFriendOfHuman;
        const humans: [number, number, number][] = [];
        for (const p of this.world!.playerLoop.all()) if (p.is_bot !== true) humans.push([p.x, p.z, p.level]);
        const distance = (member: Member): number => {
            if (humans.length === 0) return 0;
            const [x, z, level] = this._placeOf(member);
            let best = Infinity;
            for (const [hx, hz, hl] of humans) best = Math.min(best, Math.max(Math.abs(x - hx), Math.abs(z - hz)) + (level === hl ? 0 : OTHER_LEVEL_TILES));
            return best;
        };
        const keyed = this.pending.map((member, i) => ({ member, i, friend: isFriend?.(member.name) === true, d: distance(member) }));
        keyed.sort((a, b) => Number(b.friend) - Number(a.friend) || a.d - b.d || a.i - b.i);
        this.pending = keyed.map(k => k.member);
        if (!start) return;
        const friends = keyed.filter(k => k.friend).length;
        const near = Math.min(NEAR_MOST, keyed.filter(k => !k.friend && k.d <= NEAR_TILES).length);
        this.burstLeft = friends + near;
        this.burstTicks = NEAR_BURST_TICKS;
        this.fillNear = near;
        this.fillQueuedAt = this.world!.currentTick;
        this.fillTicks = -1;
        if (this.options?.debug) console.info(`[BotManager] the world fills: ${keyed.length} bots, ${friends} friends and ${near} near first: ${keyed.slice(0, 12).map(k => `${k.member.name} ${k.friend ? 'friend' : k.d}`).join(', ')}`);
    }

    /**
     * port (phase 3): where a bot will log in: its last place (BotWorldState.at), else its save's (an older store), else a
     * new bot's: a newcomer at the courtyard, a vendor at its trade bank, a PKer at Edgeville, an aged levelling bot by its
     * tier's bank (port/BotAge.agedStartBank), any other at the Lumbridge spawn
     */
    private _placeOf(member: Member): [number, number, number] {
        if (member.at) return member.at;
        const saved = this._savedPlace(member.name);
        if (saved) return (member.at = saved);
        if (member.newcomer) return Locations.LUMBRIDGE_COURTYARD;
        if (member.planner === 'extras_vendor') return vendorHome(member.name);
        if (member.planner === 'extras_pker' || member.planner === 'extras_edgeville_pker') return Locations.EDGEVILLE_BANK;
        if (this.options?.ageNewBots && isLevelling(member.planner)) {
            const tier = ageTierFor(member.name, member.planner);
            const bank = tier === 'newcomer' ? null : agedStartBank(member.name, tier, this.options.members);
            if (bank) return bank;
        }
        return Locations.LUMBRIDGE_SPAWN;
    }

    /** port (phase 3): the place in a bot's save (a standard player save: x, z and level after its magic and version), or null */
    private _savedPlace(name: string): [number, number, number] | null {
        let loaded: BotLoadResult;
        try {
            loaded = this.options!.loadSave(name);
        } catch {
            return null;
        }
        if (loaded.status !== 'ok' || loaded.data.length < 9) return null;
        const d = loaded.data;
        if (((d[0] << 8) | d[1]) !== PlayerLoading.SAV_MAGIC) return null;
        return [(d[4] << 8) | d[5], (d[6] << 8) | d[7], d[8]];
    }

    private _filled(): void {
        this.filling = false;
        this.fillStarted = false;
        // port: the last run's bots that did not come back (fewer online now) are away like any other
        if (this.firstFill) for (const member of this.members.values()) member.wasOnline = false;
        this.firstFill = false;
    }

    private _queue(member: Member): void {
        member.state = 'queued';
        this.pending.push(member);
    }

    /**
     * Who comes back: an away bot whose absence is over, from the planner group that is most short of its share of the
     * online bots (vendors, PKers and social bots keep their places), the longest away first. When the world fills,
     * the bots that were online when it emptied come first and anyone may come; otherwise, if nobody is due, the one
     * due soonest comes only when the world is well short of N.
     */
    /** The pool's size, each planner group's share of it and how many of each are online (or queued). */
    private _groupCounts(): { share: Map<PlannerKey, number>; online: Map<PlannerKey, number>; pool: number } {
        const share = new Map<PlannerKey, number>();
        const online = new Map<PlannerKey, number>();
        let pool = 0;
        for (const member of this.members.values()) {
            if (member.retiring || member.excluded) continue;
            pool++;
            share.set(member.planner, (share.get(member.planner) ?? 0) + 1);
            if (member.state === 'online' || member.state === 'queued') online.set(member.planner, (online.get(member.planner) ?? 0) + 1);
        }
        return { share, online, pool };
    }

    private _pickReturner(filling: boolean, groups = this._groupCounts()): Member | null {
        const { share, online, pool } = groups;
        let best: Member | null = null;
        let bestScore = -Infinity;
        let soonest: Member | null = null;
        let onlineCount = 0;
        for (const n of online.values()) onlineCount += n;
        const bonusOf = this.options?.cliqueReturnBonus ?? cliqueReturnBonus;
        for (const member of this.members.values()) {
            if (member.state !== 'offline' || member.retiring || member.excluded) continue;
            if (!soonest || member.awayUntil < soonest.awayUntil) soonest = member;
            const due = member.awayUntil <= this.play || (filling && member.failedLogins === 0);
            if (!due) continue;
            // port: the group's place in the role mix (onlineShare: 70 % levelling, 30 % the extras); upstream's was
            // the group's share of the pool
            const want = onlineShare(this.configured, member.planner);
            const short = want - (online.get(member.planner) ?? 0);
            let score = short;
            if (filling && (member.resume > 0 || member.wasOnline)) score += 1000;
            score += (this.play - member.awayUntil) / 1e6 + this.random() * 1e-3; // longest away, then at random
            // port (phase 3, "bot friend cliques": they log in together; port/BotCliques): a clique-mate online
            // (or on its way in) makes a due bot come before the others of its group, never past the role mix (only
            // while its group has a place to fill; asked only of a bot the bonus could make the best)
            if (short >= 1 && score + CLIQUE_RETURN_WEIGHT > bestScore) {
                let bonus = 0;
                try {
                    bonus = bonusOf(member.name, name => this._onlineOrQueued(name));
                } catch (err) {
                    console.error(`[BotManager] ${member.name}: the clique bonus failed`, err);
                }
                if (bonus > 0) score += CLIQUE_RETURN_WEIGHT * Math.min(1, bonus);
            }
            if (score > bestScore) {
                bestScore = score;
                best = member;
            }
        }
        if (best) return best;
        const short = this.configured - Math.max(1, Math.floor(this.configured / 10));
        return soonest && onlineCount < short ? soonest : null;
    }

    /** port (phase 3): a bot of that name is online, or queued to log in (port/BotCliques: its clique-mates come sooner) */
    private _onlineOrQueued(name: string): boolean {
        const m = this.members.get(botNameKey(name));
        return m !== undefined && !m.retiring && (m.state === 'online' || m.state === 'queued');
    }

    /** A brand-new account joins at the Lumbridge spawn; an old one quits if the pool is over its size. */
    private _admitNewcomer(): void {
        if (this.configured === 0) return;
        const entry = this.names?.take();
        if (!entry) return;
        this.namesLeft = this.names!.remaining();
        const member = this._addMember(entry);
        // port (phase 3): a newbie until combat 10 or total level 60 (port/BotNewbie), across its sessions
        member.newbie = true;
        this.newcomers++;
        this._queue(member);
        console.info(`[BotManager] ${entry.name} (${entry.planner}) is new to the world`);
        if (this.members.size > this.poolCap) this._quitOne();
        // port: and a second while a top-up has the pool past the size it keeps (poolKeep), so it shrinks back
        if (this.members.size > this.poolKeep) this._quitOne();
    }

    /**
     * An away, not-new account that no human has as a friend quits for good (its record goes): a levelling one, from
     * the group most over its place in the pool (port/BotRoster.poolShare: as a rule the one a newcomer just joined),
     * or first an extra (a vendor, a PKer, a social bot) whose group is past its cap (port: a store saved under the first
     * mix, an eighth each, or N went down: the role mix, 70 % levelling, comes back as they quit).
     */
    private _quitOne(): void {
        const options = this.options!;
        const { share } = this._groupCounts();
        const over = (planner: PlannerKey): number => {
            const n = share.get(planner) ?? 0;
            if (isLevelling(planner)) return n - poolShare(this.configured, planner);
            const cap = groupCap(this.configured, planner);
            return n > cap ? 1000 + n - cap : -Infinity;
        };
        let member: Member | null = null;
        let best = -Infinity;
        for (const m of this.members.values()) {
            // (not one whose save could not be read: its record is kept as it is, to be recovered)
            if (m.state !== 'offline' || m.newcomer || m.retiring || m.excluded) continue;
            if (options.isFriendOfHuman?.(m.name)) continue;
            // port (the realism work, phase 5b): nor the player-mod bot (port/BotModBot: the crown stays with one name)
            if (isPlayerModName(m.name)) continue;
            const score = over(m.planner) + this.random() * 1e-3; // (within a group, at random)
            if (score > best) {
                best = score;
                member = m;
            }
        }
        if (!member) return;
        this._drop(member);
        this.quits++;
        try {
            options.onQuit?.(member.name);
        } catch (err) {
            console.error(`[BotManager] ${member.name}: onQuit failed`, err);
        }
        console.info(`[BotManager] ${member.name} quit the game`);
    }

    /**
     * Up to spawnPerTick bots once a human is in the world, never on tick 0 (an appearance built then is never sent).
     * port (phase 3, near you first): a login fill's burst (the friends and the bots near the human, _nearFirst) goes in
     * its first NEAR_BURST_TICKS ticks, more a tick if need be.
     */
    private _spawnSome(tick: number): void {
        const options = this.options;
        if (!options || this.pending.length === 0 || tick < 1 || !options.humanInWorld()) return;
        let perTick = Math.max(1, options.spawnPerTick ?? 5);
        if (this.burstLeft > 0 && this.burstTicks > 0) {
            perTick = Math.max(perTick, Math.ceil(this.burstLeft / this.burstTicks));
            this.burstTicks--;
        }
        let spawned = 0;
        while (spawned < perTick && this.pending.length > 0) {
            if (this._spawnBot(this.pending.shift()!, tick)) spawned++;
        }
        // port (the variety work, round 1, track F: the login fill's jumps): a fill's bots want their first routes at once:
        // the path searches are boosted until FILL_BOOST_TICKS after its last login (port/BotPathing)
        if (spawned > 0 && this.filling) boostPathSearches(tick + FILL_BOOST_TICKS);
        this.burstLeft = this.burstTicks > 0 ? Math.max(0, this.burstLeft - spawned) : 0;
        if (this.pending.length === 0 && this.fillQueuedAt >= 0 && this.fillTicks < 0) this.fillTicks = tick - this.fillQueuedAt;
    }

    private _spawnBot(member: Member, tick: number): boolean {
        const options = this.options!;
        const world = this.world!;
        const name = member.name;

        // a name can be taken after start (a new character, a player online): that bot leaves the pool
        if (options.isReservedName(name)) {
            this.skipped.push(name);
            this._drop(member);
            return false;
        }
        // its last logout is still being saved: a little later
        if (world.getPlayerByUsername(name) !== undefined || world.logoutRequests.has(name)) {
            member.state = 'offline';
            member.awayUntil = this.play + 5;
            return false;
        }

        const loaded = options.loadSave(name);
        if (loaded.status === 'error') {
            // like a human login: never start fresh over a save that could not be read
            console.error(`[BotManager] cannot read the save of ${name} (${loaded.error}); not spawned this session`);
            this._exclude(member);
            return false;
        }

        let player: Player;
        try {
            player = PlayerLoading.load(name, new Packet(loaded.status === 'ok' ? loaded.data : new Uint8Array(0)), null);
        } catch (err) {
            // upstream spawned a fresh bot here, whose next save would replace the real one
            console.error(`[BotManager] the save of ${name} is unreadable; not spawned this session`, err);
            this._exclude(member);
            return false;
        }
        const fresh = loaded.status === 'missing';

        if (fresh) {
            // New players start on Tutorial Island (Player.ts), so upstream's `x == null` scatter never ran: put a
            // new bot on a walkable tile around the Lumbridge spawn.
            const [x, z, level] = member.newcomer ? this._courtyardTile() : this._spawnTile(member.planner, name);
            player.x = x;
            player.z = z;
            player.level = level;
            try {
                // port (the realism work, phase 4): the body from the name; a newcomer in the design screen's clothes
                BotAppearance.randomize(player, { newcomer: member.newcomer });
            } catch (err) {
                console.error(`[BotManager] BotAppearance failed for ${name}`, err);
            }
            // Herblore 3 (Druidic Ritual)
            player.baseLevels[PlayerStat.HERBLORE] = 3;
            player.levels[PlayerStat.HERBLORE] = 3;
            player.stats[PlayerStat.HERBLORE] = getExpByLevel(3);
            if (options.ageNewBots && !member.newcomer) {
                try {
                    applyAge(player, name, member.planner, options.members);
                } catch (err) {
                    console.error(`[BotManager] ageing ${name} failed`, err);
                }
            }
        }

        setVarp(player, TUTORIAL_VARP[0], TUTORIAL_VARP[1], TUTORIAL_COMPLETE);
        for (const [varp, id, value] of BOT_VARPS) {
            setVarp(player, varp, id, value);
        }
        const horror = VarPlayerType.getByName(HORROR_VARP[0]);
        if (horror && horror.id === HORROR_VARP[1]) {
            player.setVar(horror.id, ((player.getVar(horror.id) as number) & ~HORROR_BITS) | HORROR_COMPLETE);
        }

        // the world's membership, and a free world's rule for players outside F2P (World.ts, 274)
        player.members = options.members;
        if (!isAllowedCoord(player.x, player.z)) {
            [player.x, player.z, player.level] = FREE_WORLD_SAFE_TILE;
        }
        // port: a bot saved behind a bank's counter (a fresh vendor or PKer used to log in on any open tile around its
        // post: a third of Varrock West's are behind the counter) logs in on the players' side of it
        if (!fresh) {
            const post = this._behindCounter(player.x, player.z, player.level);
            if (post) [player.x, player.z, player.level] = this._tileInReach(post[0], post[1], post[2], 5);
        }

        const bot = new BotPlayer(player, PLANNER_MAP[member.planner](name));
        if (!fresh) bot.planner.skipInit();
        initBotFields(player, member.planner);
        // port (the realism work, phase 5b): the player-mod bot's silver crown (port/BotModBot; BotSay sends it), 0 for the rest
        player.staffModLevel = isPlayerModName(name) ? 1 : 0;
        // port: a newcomer as a newbie off Tutorial Island (port/BotNewbie: by design); port (the realism work,
        // phase 3): until combat 10 or total level 60, across its sessions (it was its first 5-15 minutes)
        player.botNewbie = member.newbie;
        // port: the engine walks a bot to what it clicks (a rock, a range, a booth, an NPC), as a server that routes for
        // its players does. 274's world config leaves the routes to the clients (clientRoutefinder): a player's move
        // strategy is NAIVE, and a click with no route from a client walked the bot nowhere ("I can't reach that!",
        // test/sim.mjs: 57 such cooking clicks against 40 that worked)
        player.moveStrategy = MoveStrategy.SMART;
        player.privateChat = ChatModePrivate.ON;
        member.bot = bot;
        member.spawnTick = tick;
        member.entered = false;
        member.owned = true;
        this.spawnedTotal++;
        world.newPlayers.add(player);
        player.buildAppearance(InvType.WORN);
        const how = fresh ? (member.newcomer ? ', new to the world' : ', new') : member.sessions > 0 ? ', back' : '';
        console.info(`[BotManager] ${name} (${member.planner}) logs in at (${player.x}, ${player.z}, ${player.level})${how}`);
        return true;
    }

    private _exclude(member: Member): void {
        member.state = 'offline';
        member.excluded = true;
        this.skipped.push(member.name);
    }

    /**
     * A walkable tile within 5 of the Lumbridge spawn (engine collision), else the spawn tile itself. port: a vendor or
     * a PKer that is not new to the game starts at its post (upstream started every bot at Lumbridge: on a new world
     * PKers in rune arrived at level 3 and went off to the Wilderness through the newcomers' courtyard)
     */
    private _spawnTile(planner: PlannerKey | null = null, name = ''): [number, number, number] {
        // port: a vendor at its home trade bank (port/BotTradeSpots: they spread over the banks)
        const post = planner === 'extras_vendor' ? vendorHome(name) : planner === 'extras_pker' || planner === 'extras_edgeville_pker' ? Locations.EDGEVILLE_BANK : Locations.LUMBRIDGE_SPAWN;
        const [x, z, level] = post;
        return this._tileInReach(x, z, level, 5);
    }

    /** port: the bank post (a trade bank's middle, Edgeville's) whose counter (x, z) is behind, or null */
    private _behindCounter(x: number, z: number, level: number): [number, number, number] | null {
        for (const post of [...usableBanks().map(b => b.center), Locations.EDGEVILLE_BANK]) {
            if (post[2] !== level || Math.abs(x - post[0]) > 6 || Math.abs(z - post[1]) > 6) continue;
            if (!tilesInSquare(level, post[0], post[1], 24).has((x << 14) | z)) return post;
        }
        return null;
    }

    /** port: a tile within `most` of (x, z) that a player there walks to (never across a bank's counter or a wall) */
    private _tileInReach(x: number, z: number, level: number, most: number): [number, number, number] {
        const tiles = tilesInReach(level, x, z, most * 2).filter(k => Math.abs((k >> 14) - x) <= most && Math.abs((k & 0x3fff) - z) <= most && isZoneAllocated(level, k >> 14, k & 0x3fff));
        if (tiles.length === 0) return [x, z, level];
        const k = tiles[Math.floor(Math.random() * tiles.length)];
        return [k >> 14, k & 0x3fff, level];
    }

    /** port: where a new player comes off Tutorial Island (tutorial.rs2, tutorial_complete: 0_50_50_22_22), a step or two around it */
    private _courtyardTile(): [number, number, number] {
        const [x, z, level] = Locations.LUMBRIDGE_COURTYARD;
        return this._tileInReach(x, z, level, 2);
    }

    /** port: a human in the world on Tutorial Island (274's in_tutorial_island: the island and its cave) */
    private _humanOnTutorialIsland(): boolean {
        if (!this.world) return false;
        for (const p of this.world.playerLoop.all()) {
            if (p.is_bot === true) continue;
            if ((p.x >= 3053 && p.x <= 3156 && p.z >= 3056 && p.z <= 3136) || (p.x >= 3072 && p.x <= 3118 && p.z >= 9492 && p.z <= 9535)) return true;
        }
        return false;
    }

    private static readonly STAT_LABELS: string[] = ['Atk', 'Def', 'Str', 'HP', 'Rng', 'Pray', 'Mag', 'Cook', 'WC', 'Flet', 'Fish', 'FM', 'Craft', 'Smith', 'Mine', 'Herb', 'Agi', 'Thiev', 'Slay', 'Farm', 'RC'];

    /** Debug only (upstream printed six lines per bot every 100 ticks). */
    private _printStatus(): void {
        if (!this.options?.debug) return;
        const s = this.stats();
        console.log(
            `[BotManager] ${s.active} playing, ${s.joining} joining, ${s.leaving} leaving, ${s.away} away (pool ${s.pool}) | play ${s.playTicks} | ` +
                `${s.logoffs} logoffs, ${s.returns} returns, ${s.newcomers} newcomers, ${s.quits} quits | tick ${s.lastTickMs.toFixed(1)} ms (max ${s.maxTickMs.toFixed(1)}) | ${s.pathSearchesLastTick} path searches | ${s.errors} errors`
        );
        for (const member of this.members.values()) {
            if (!member.bot || member.bot.player.slot === -1) continue;
            const snap = member.bot.snapshot();
            const levels = BotManagerClass.STAT_LABELS.map((label, stat) => `${label}:${getBaseLevel(member.bot!.player, stat as PlayerStat)}`).join(' ');
            console.log(`[BotManager]   ${snap.name} • ${member.state} • ${snap.task ?? 'idle'} • (${snap.x}, ${snap.z}, ${snap.level}) • ${levels}`);
        }
    }
}

export const BotManager = new BotManagerClass();
