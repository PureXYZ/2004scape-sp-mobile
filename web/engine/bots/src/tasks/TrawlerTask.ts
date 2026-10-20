// port (the variety work, round 2, Track M: members places and minigames): the Fishing Trawler (274's game_trawler) at Port Khazard, played by a crew of bots
// through the real clicks, as a group of players played it in 2004:
//   - the crew: one bot calls it ("trawler anyone?"); while it gathers at the dock, the bots asked for their next plan
//     near Kandarin may join (port/BotMinigames: past the far budget, up to CREW_SIZE for the world's N, 4-8); they board
//     together when enough are at the dock, or the few there after CREW_WAIT, or it breaks up;
//   - the supplies at the Khazard general store (the real shop: swamp paste, rope, a bailing bucket), a bank stop first
//     when the pack is too full for them;
//   - the gangplank (274's oploc1: onto the boat), the wait for Murphy, 274's trawler_start (the sail: the game's move);
//   - at sea, ten minutes: each leak in reach patched with swamp paste (274's oploc1 shipleak), the net mended with rope
//     upstairs when it rips (the ladders), the hold bailed when it floods (the bailing bucket: fill, tip over the side);
//   - the end: back at the dock with Murphy (274's trawler_win), the catch from the net on land (its window; closed, the
//     catch falls at the bot's feet, its own drop, and the fish are taken, the junk left); or sunk (the wreck: a floating
//     barrel to the shore, 274's trawler_escape).
// Every move the game makes (the sail out and back, the flood's, the wreck's, the barrel's) is marked as the game's for
// the humanlike runner (noteMove 'event'), seen in the tick it lands. Lines: the call, the joins, the boarding, the sea's
// shouts, the catch, the sinking (port/BotOutings sayMembers, kind 'setpiece').
import {
    BotTask,
    Player,
    InvType,
    walkTo,
    findNpcByName,
    findLocByName,
    findLocByNameWhere,
    Loc,
    interactNpcOp,
    interactLoc,
    interactLocOp,
    countItem,
    Items,
    StuckDetector,
    teleportNear,
    advanceBankWalk,
    bankInvId,
    humanDelay,
    randInt,
    openShopStock,
    buyFromOpenShop,
    TargetPause
} from '#/engine/bot/tasks/BotTaskBase.js';
import World from '#/engine/World.js';
import ObjType from '#/cache/config/ObjType.js';
import { EntityLifeCycle } from '#/engine/entity/EntityLifeCycle.js';
import { botAnswerDialogue, botScript, findLootObj, getBaseLevel, interactHeldOp, interactObjOp, noteMove, PlayerStat, tilesInSquare } from '#/engine/bot/BotAction.js';
import { moveItems } from '#/engine/bot/port/BotInventoryCompat.js';
import { MembersPlaces } from '#/engine/bot/BotKnowledge.js';
import { countMinigame, noteOutingEnd, noteOutingStart, onlineN, sayMembers } from '#/engine/bot/port/BotOutings.js';

/** the trawler wants Fishing 15 for a catch (274's trawlernetland) */
export const TRAWLER_FISHING = 15;
/** the supplies a bot takes: swamp paste, rope, a bailing bucket */
const PASTE = 20;
const ROPES = 1;
/** coins it wants for them and the store's price (about 42 a paste) */
const SUPPLY_COINS = 1200;
/** a crew gathers this long before it boards with the few there (ticks), and breaks up this long after with fewer than 2 */
export const CREW_WAIT = 600;
const CREW_GIVE_UP = 900;
/** the least crew that boards */
export const CREW_MIN = 2;
/** a visit is over after this long whatever happened (ticks: the gathering, the trip, the catch) */
const VISIT_TICKS = 4500;
/** in the lobby this long with no sail (another crew at sea): off the boat */
const LOBBY_TICKS = 400;

/** the crew's size for N online: 3-4 at 100, 5-6 at 250, 6-8 at 500 (the plan: a group of 4-8 visible at the dock) */
export function crewSize(n: number = onlineN()): number {
    const lo = n >= 400 ? 6 : n >= 200 ? 5 : 3;
    return lo + randInt(0, lo >= 6 ? 2 : 1);
}

interface Crew {
    id: number;
    leader: Player;
    members: Set<Player>;
    target: number;
    formedAt: number;
    /** the tick it began to board (late members then give up) */
    boardAt: number;
    state: 'forming' | 'boarding' | 'over';
}
let crew: Crew | null = null;
let nextCrewId = 1;
/** at sea: the leak each crew member went for, and when (a crew-mate takes another) */
const leakClaims = new WeakMap<object, { player: Player; at: number }>();

/** (tests, the runner) crews, games, leaks patched, nets mended, buckets bailed, catches, sinkings */
export const trawlerStats = { crews: 0, boarded: 0, games: 0, leaks: 0, nets: 0, bails: 0, catches: 0, fish: 0, sunk: 0, ended: {} as Record<string, number> };

/** a crew is gathering at Port Khazard with room for one more */
export function crewForming(): boolean {
    if (crew && crew.state === 'forming') {
        for (const m of crew.members) if (m.slot === -1) crew.members.delete(m);
        if (crew.members.size === 0) crew = null;
    }
    return crew !== null && crew.state === 'forming' && crew.members.size < crew.target;
}

/** a crew exists (gathering, boarding or at sea): one boat, one crew at a time */
export function crewExists(): boolean {
    if (crew && ![...crew.members].some(m => m.slot !== -1)) crew = null;
    return crew !== null;
}

/** the bots of the crew (tests) */
export function crewMembers(): Player[] {
    return crew ? [...crew.members] : [];
}

/** (tests) no crew */
export function resetTrawlerForTest(): void {
    crew = null;
}

/** May the bot crew the trawler: Fishing 15, the coins for its supplies (pack or bank), near Kandarin (it walks there) */
export function mayTrawl(player: Player): boolean {
    if (getBaseLevel(player, PlayerStat.FISHING) < TRAWLER_FISHING) return false;
    const bid = bankInvId();
    const bank = bid === -1 ? null : player.getInventory(bid);
    if (countItem(player, Items.COINS) + (bank?.getItemCount(Items.COINS) ?? 0) < SUPPLY_COINS + 300) return false;
    const [dx, dz] = MembersPlaces.TRAWLER_DOCK;
    return Math.max(Math.abs(player.x - dx), Math.abs(player.z - dz)) <= 450;
}

let ids: { paste: number; rope: number; bucket: number; full: number } | null = null;
function itemIds(): { paste: number; rope: number; bucket: number; full: number } {
    return (ids ??= { paste: ObjType.getId('swamppaste'), rope: ObjType.getId('rope'), bucket: ObjType.getId('bucket_bailing'), full: ObjType.getId('bucket_bailingfull') });
}

/** the fish worth taking from the catch (the junk is left: boots, broken staves, seaweed ...) */
const KEEP = ['raw_shrimp', 'raw_sardine', 'raw_anchovies', 'raw_tuna', 'raw_lobster', 'raw_swordfish', 'raw_shark', 'raw_seaturtle', 'raw_mantaray', 'oystershell', 'casket'];
let keepIds: Set<number> | null = null;
function keep(): Set<number> {
    return (keepIds ??= new Set(KEEP.map(n => ObjType.getId(n)).filter(id => id !== -1)));
}

/** where the bot is: at sea (the trawler's region west of the map), at the wreck, ashore */
function atSea(player: Player): boolean {
    return player.x < 2100 && player.z > 4780 && player.z < 4880;
}
/** the flooded trawler (274's copy of the ship 128 tiles east of the dry one) */
function flooded(player: Player): boolean {
    return atSea(player) && player.x >= 1990 && player.x < 2060;
}
/** the wreck (swimming: the barrels) */
function wrecked(player: Player): boolean {
    return atSea(player) && player.x >= 1930 && player.x < 1990;
}
/** (the variety work, round 2, the fixes) where the bot is, for the game's moves between them */
function trawlerRealm(player: Player): 'wreck' | 'flooded' | 'sea' | 'lobby' | 'shore' {
    return wrecked(player) ? 'wreck' : flooded(player) ? 'flooded' : atSea(player) ? 'sea' : inLobby(player) ? 'lobby' : 'shore';
}

/** on the trawler at the dock (the lobby: its deck and hold) */
function inLobby(player: Player): boolean {
    return Math.abs(player.x - 2671) <= 6 && Math.abs(player.z - 3174) <= 8 && !(player.level === 0 && player.z < 3171);
}

export class TrawlerTask extends BotTask {
    private state: 'bank' | 'shop' | 'buy' | 'dock' | 'board' | 'lobby' | 'sea' | 'wreck' | 'reward' | 'loot' | 'done' = 'dock';
    private role: 'leader' | 'member';
    private readonly stuck = new StuckDetector(40, 4, 3);
    private started = false;
    private startedAt = 0;
    private stateAt = 0;
    private lastX = -1;
    private lastZ = -1;
    private lastRealm = 'shore';
    private nextCall = 0;
    private sailed = false;
    private outcome = 'done';
    private shopTries = 0;
    private lastClick = 0;
    private rewardTries = 0;
    private wreckTries = 0;
    /** its next step about the dock or the deck while it waits */
    private millAt = 0;
    /** its next click at sea no sooner than this (a person's uneven pace: H18) */
    private nextClick = 0;
    /** a script held it last tick (a patch, a bail) */
    private busy = false;
    /** a person's moment after a patch, a bail or a mend before the next click (no click in step: H17, H18) */
    private readonly pause = new TargetPause('retarget');
    private _player: Player | null = null;

    constructor(role: 'leader' | 'member') {
        super('Trawler');
        this.role = role;
    }

    shouldRun(_player: Player): boolean {
        return this.state !== 'done' && !this.interrupted;
    }

    isComplete(_player: Player): boolean {
        return this.state === 'done';
    }

    override interrupt(): void {
        super.interrupt();
        this._end(null, 'interrupted');
    }

    override reset(): void {
        super.reset();
        if (this.started && this.state !== 'done') this._end(null, 'reset');
    }

    /** (tests) a bot back ashore after a game won, at the net on land (its catch staged by the test) */
    atNetForTest(player: Player): void {
        this.started = true;
        this.startedAt = World.currentTick;
        this.sailed = true;
        noteOutingStart(player, 'Trawler', 'khazard', 'minigame');
        this._set('reward');
    }

    /** the crew it is in, as the hook made it: the leader's new crew, a member's join */
    static form(leader: Player): void {
        crew = { id: nextCrewId++, leader, members: new Set([leader]), target: crewSize(), formedAt: World.currentTick, boardAt: -1, state: 'forming' };
        trawlerStats.crews++;
        countMinigame('Trawler', 'crews');
    }

    static join(member: Player): void {
        if (crew && crew.state === 'forming') crew.members.add(member);
    }

    tick(player: Player): void {
        if (this.interrupted || this.state === 'done') return;
        this._player = player;
        const now = World.currentTick;
        this.pause.observe(player);
        // (a move of the game's: the sail out and back, the flood, the wreck, the barrel; marked when it is seen. The variety
        // work, round 2, the fixes: a crossing between the shore, the boat at the dock, the trawler at sea, its flooded copy and
        // the wreck only: any move of 20+ tiles was marked, and a rescue jump on its bank, shop or dock walks with it)
        const realm = trawlerRealm(player);
        if (this.lastX !== -1 && realm !== this.lastRealm && Math.max(Math.abs(player.x - this.lastX), Math.abs(player.z - this.lastZ)) > 20) noteMove(player, 'event');
        this.lastX = player.x;
        this.lastZ = player.z;
        this.lastRealm = realm;
        if (!this.started) {
            this.started = true;
            this.startedAt = now;
            this.stateAt = now;
            noteOutingStart(player, 'Trawler', 'khazard', 'minigame');
            if (this.role === 'leader') {
                TrawlerTask.form(player);
                if (Math.random() < 0.6) sayMembers(player, 'trawler-call');
            } else {
                TrawlerTask.join(player);
                if (Math.random() < 0.5) sayMembers(player, 'trawler-join');
            }
            this.state = this._needsBank(player) ? 'bank' : this._needsSupplies(player) ? 'shop' : 'dock';
        }
        // (a visit has its limit; never at sea, where the game decides)
        if (now - this.startedAt > VISIT_TICKS && !atSea(player) && !inLobby(player)) {
            this._end(player, 'time');
            return;
        }
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        // (the game's own pages: the ship's journey, the help, the wreck's barrel; continued as a player clicks them)
        if (botAnswerDialogue(player, 1) !== null) return;

        // the game moved the bot: to sea, back ashore, to the wreck
        if (atSea(player) && this.state !== 'sea' && this.state !== 'wreck') {
            this._set(wrecked(player) ? 'wreck' : 'sea');
            if (!this.sailed) {
                this.sailed = true;
                trawlerStats.games++;
                countMinigame('Trawler', 'games');
            }
        }

        switch (this.state) {
            case 'bank': {
                const result = advanceBankWalk(player, this.stuck);
                if (result === 'walk') return;
                const bid = bankInvId();
                const bank = bid === -1 ? null : player.getInventory(bid);
                const inv = player.getInventory(InvType.INV);
                if (bank && inv) {
                    for (let slot = 0; slot < inv.capacity; slot++) {
                        const it = inv.get(slot);
                        if (it && it.id !== Items.COINS) moveItems(inv, bank, it.id, it.count);
                    }
                    const short = SUPPLY_COINS + 200 - countItem(player, Items.COINS);
                    if (short > 0) moveItems(bank, inv, Items.COINS, short);
                }
                this.cooldown = result === 'ready' ? humanDelay(player, 'bank') : 0;
                this.stuck.reset();
                this._set(this._needsSupplies(player) ? 'shop' : 'dock');
                return;
            }
            case 'shop': {
                const [sx, sz] = MembersPlaces.KHAZARD_STORE;
                if (Math.max(Math.abs(player.x - sx), Math.abs(player.z - sz)) > 4) {
                    this._walk(player, sx, sz);
                    return;
                }
                const keeper = findNpcByName(player.x, player.z, player.level, 'khazard_shopkeeper', 10);
                if (!keeper || ++this.shopTries > 4) {
                    this._set('dock');
                    return;
                }
                interactNpcOp(player, keeper, 3);
                this._set('buy');
                return;
            }
            case 'buy': {
                if (!openShopStock(player)) {
                    if (now - this.stateAt > 15) this._set('shop');
                    return;
                }
                const { paste, rope, bucket } = itemIds();
                const wants: [number, number][] = [
                    [paste, PASTE],
                    [rope, ROPES],
                    [bucket, 1]
                ];
                for (const [id, n] of wants) {
                    const have = countItem(player, id);
                    if (have < n && countItem(player, Items.COINS) > 60 && now - this.lastClick >= 1) {
                        this.lastClick = now;
                        if (buyFromOpenShop(player, id, n - have)) return;
                    }
                }
                player.closeModal();
                this._set('dock');
                return;
            }
            case 'dock': {
                const [dx, dz] = MembersPlaces.TRAWLER_DOCK;
                const near = Math.max(Math.abs(player.x - dx), Math.abs(player.z - dz)) <= 4 && player.level === 0;
                // (the crew boarded without it, a while ago: too late for this trip)
                if (crew && crew.state === 'boarding' && crew.boardAt >= 0 && now - crew.boardAt > 80 && !near) {
                    this._end(player, 'late');
                    return;
                }
                if (!near) {
                    // (a tile by the dock picked once: a new one every tick re-planned the walk every tick, and the
                    // stuck check took that for no progress and jumped the bot, round the store's corner)
                    if (!this.dockTile) {
                        const tiles = [...tilesInSquare(0, dx, dz, 1)];
                        const t = tiles[randInt(0, tiles.length - 1)] ?? ((dx << 14) | dz);
                        this.dockTile = [t >> 14, t & 0x3fff];
                    }
                    this._walk(player, this.dockTile[0], this.dockTile[1]);
                    return;
                }
                const c = crew;
                // (the leader calls again now and then while it gathers)
                if (c && c.leader === player && c.state === 'forming' && now >= this.nextCall) {
                    this.nextCall = now + randInt(150, 300);
                    if (now - c.formedAt > 100 && Math.random() < 0.5) sayMembers(player, 'trawler-call');
                }
                if (!c || !c.members.has(player)) {
                    // (no crew: gone on without it, or broken up)
                    this._end(player, 'no-crew');
                    return;
                }
                if (c.state === 'forming') {
                    this._mill(player, now, dx, dz, 3);
                    const there = [...c.members].filter(m => m.slot !== -1 && Math.max(Math.abs(m.x - dx), Math.abs(m.z - dz)) <= 6);
                    const waited = now - c.formedAt;
                    if (there.length >= c.target || (waited >= CREW_WAIT && there.length >= CREW_MIN)) {
                        c.state = 'boarding';
                        c.boardAt = now;
                        trawlerStats.boarded += there.length;
                        countMinigame('Trawler', 'crew-bots', there.length);
                        if (Math.random() < 0.6) sayMembers(player, 'trawler-board');
                    } else if (waited >= CREW_GIVE_UP) {
                        c.state = 'over';
                        crew = null;
                        this._end(player, 'no-crew');
                        return;
                    }
                    return;
                }
                if (c.state === 'boarding' && now - c.boardAt <= 80) this._set('board');
                else this._end(player, 'late');
                return;
            }
            case 'board': {
                if (inLobby(player) && player.level === 1) {
                    this._set('lobby');
                    return;
                }
                const [gx, gz] = MembersPlaces.TRAWLER_GANGPLANK;
                const plank = findLocByName(gx, gz, 0, 'trawler_gangplank', 3) ?? findLocByName(gx, gz, 1, 'trawler_gangplank', 3);
                if (!plank) {
                    this._end(player, 'no-plank');
                    return;
                }
                if (now - this.lastClick >= 8) {
                    this.lastClick = now;
                    interactLocOp(player, plank, 1);
                }
                if (now - this.stateAt > 120) this._end(player, 'no-board');
                return;
            }
            case 'lobby': {
                // (waiting for Murphy's sail, about the deck; another crew at sea keeps the trawler: off the boat after a while)
                this._mill(player, now, 2671, 3174, 2);
                if (now - this.stateAt > LOBBY_TICKS) {
                    const off = findLocByName(player.x, player.z, player.level, 'trawler_gangplankoff', 8);
                    if (off && now - this.lastClick >= 8) {
                        this.lastClick = now;
                        interactLocOp(player, off, 1);
                    }
                    if (!inLobby(player) || now - this.stateAt > LOBBY_TICKS + 100) this._end(player, 'no-sail');
                }
                return;
            }
            case 'sea': {
                if (!atSea(player)) {
                    // (back ashore: the win's journey home)
                    if (Math.random() < 0.4) sayMembers(player, 'trawler-win');
                    this._set('reward');
                    return;
                }
                if (wrecked(player)) {
                    this._set('wreck');
                    return;
                }
                this._play(player, now);
                return;
            }
            case 'wreck': {
                if (!atSea(player)) {
                    trawlerStats.sunk++;
                    countMinigame('Trawler', 'sunk');
                    if (Math.random() < 0.5) sayMembers(player, 'trawler-sink');
                    this._end(player, 'sunk');
                    return;
                }
                // (a floating barrel: one at a time, the next when the swim to it got nowhere; 274's third kind floats
                // and carries no one)
                if (now - this.lastClick < 12) return;
                this.lastClick = now;
                const barrels: Loc[] = [];
                for (const name of ['sinkingbarrel1', 'sinkingbarrel2']) {
                    const found = findLocByNameWhere(player.x, player.z, player.level, name, 14, () => true);
                    if (found) barrels.push(found);
                    const other = findLocByNameWhere(player.x, player.z, player.level, name, 14, l => l !== found);
                    if (other) barrels.push(other);
                }
                if (barrels.length === 0) return;
                interactLoc(player, barrels[this.wreckTries++ % barrels.length]);
                return;
            }
            case 'reward': {
                // (the net on land: its window of the catch; closed, the catch falls at the bot's feet)
                if (player.containsModalInterface()) {
                    player.closeModal();
                    this._set('loot');
                    return;
                }
                const [nx, nz] = MembersPlaces.TRAWLER_NET_LAND;
                const net = findLocByName(nx, nz, 0, 'trawlernetland', 3) ?? findLocByName(nx, nz, 1, 'trawlernetland', 3);
                if (!net || this.rewardTries > 6) {
                    this._end(player, 'no-net');
                    return;
                }
                if (now - this.lastClick >= 10) {
                    this.lastClick = now;
                    this.rewardTries++;
                    interactLoc(player, net);
                }
                return;
            }
            case 'loot': {
                // (its own drop, the fish of it; the junk left lying)
                const k = keep();
                const obj = findLootObj(player, player.x, player.z, player.level, 2, o => k.has(o.type) && o.lifecycle === EntityLifeCycle.DESPAWN);
                const inv = player.getInventory(InvType.INV);
                // (the catch falls when the window closes: a moment to look)
                if (!obj && now - this.stateAt < 4) return;
                if (!obj || (inv?.freeSlotCount ?? 0) === 0 || now - this.stateAt > 150) {
                    const fish = this._fishCount(player);
                    trawlerStats.catches++;
                    trawlerStats.fish += fish;
                    countMinigame('Trawler', 'catches');
                    if (Math.random() < 0.5) sayMembers(player, 'trawler-catch');
                    this._end(player, 'done');
                    return;
                }
                if (now - this.lastClick >= 2 && !player.hasWaypoints()) {
                    this.lastClick = now;
                    interactObjOp(player, obj, 3);
                }
                return;
            }
        }
    }

    /**
     * Ten minutes at sea, as a crew shares the work: each bot patches the nearest leak no other has taken (its claim,
     * swamp paste: 274's oploc1 shipleak), the crew's first mends the net upstairs when it rips (rope, the ladders), and
     * once the ship floods every third bails the hold (the bucket filled, tipped over the side) while the rest patch.
     * A click while one is under way (walking to a leak, the patch's own delay) waits for it.
     */
    private _play(player: Player, now: number): void {
        // (a patch's or a bail's own script lets go: a person's moment before the next click, H18)
        if (player.delayed || botScript(player)) {
            this.busy = true;
            return;
        }
        // (at sea a crew clicks as fast as it can: the trawler is a race against the leaks, 274's flood rising by each
        // open leak every 5 ticks; still a person's few ticks between clicks)
        if (this.busy) {
            this.busy = false;
            this.nextClick = Math.max(this.nextClick, now + randInt(1, 3));
        }
        if (player.target !== null || !this.pause.ready) return;
        if (now < this.nextClick) return;
        this.nextClick = now + randInt(1, 4);
        const { paste, rope, bucket, full } = itemIds();
        const inv = player.getInventory(InvType.INV);
        if (!inv) return;
        const index = this._crewIndex(player);
        // (a full bailing bucket: tipped over the side)
        if (flooded(player) && player.level === 0 && countItem(player, full) > 0) {
            const slot = this._slotOf(player, full);
            if (slot !== -1 && interactHeldOp(player, inv, full, slot, 1)) {
                this.lastClick = now;
                this.pause.held();
                trawlerStats.bails++;
                return;
            }
        }
        // (the bailers of the crew, once flooded: every other one, the hold first; 274 lowers the flood by one a bucket)
        const bailer = flooded(player) && player.level === 0 && countItem(player, bucket) > 0 && (index % 2 === 1 || countItem(player, paste) === 0);
        if (bailer) {
            const slot = this._slotOf(player, bucket);
            if (slot !== -1 && interactHeldOp(player, inv, bucket, slot, 1)) {
                this.lastClick = now;
                this.pause.held();
                return;
            }
        }
        // (the nearest leak no crew-mate has taken: patched with swamp paste)
        if (countItem(player, paste) > 0 && player.level === 0) {
            const leak = findLocByNameWhere(player.x, player.z, 0, 'shipleak', 8, l => {
                const by = leakClaims.get(l);
                return !by || by.player === player || now - by.at > 6 || by.player.slot === -1;
            });
            if (leak) {
                leakClaims.set(leak, { player, at: now });
                this.lastClick = now;
                interactLoc(player, leak);
                trawlerStats.leaks++;
                if (Math.random() < 0.03) sayMembers(player, 'trawler-sea');
                return;
            }
        }
        // (the net ripped, upstairs: the crew's first goes up with its rope and mends it; the rest stay on the leaks)
        if (index === 0 && countItem(player, rope) > 0) {
            const torn = findLocByName(player.x, player.z, 1, 'trawlernet_top_l', 16) ?? findLocByName(player.x, player.z, 1, 'trawlernet_top_r', 16);
            if (torn) {
                this.lastClick = now;
                if (player.level === 0) {
                    const ladder = findLocByName(player.x, player.z, 0, 'trawler_ladder', 12);
                    if (ladder) interactLoc(player, ladder);
                } else {
                    interactLoc(player, torn);
                    trawlerStats.nets++;
                    if (Math.random() < 0.1) sayMembers(player, 'trawler-net');
                }
                return;
            }
        }
        // (upstairs with nothing to mend: back down to the leaks)
        if (player.level === 1) {
            const down = findLocByName(player.x, player.z, 1, 'trawler_laddertop', 12);
            if (down) {
                this.lastClick = now;
                interactLoc(player, down);
            }
            return;
        }
        // (flooded, no leak to patch: the hold bailed)
        if (flooded(player) && countItem(player, bucket) > 0) {
            const slot = this._slotOf(player, bucket);
            if (slot !== -1 && interactHeldOp(player, inv, bucket, slot, 1)) {
                this.lastClick = now;
                this.pause.held();
                return;
            }
        }
    }

    /**
     * A wait about the dock or the deck as a person waits: a step or two now and then (every 20-60 ticks), a look round;
     * a crew standing stock-still for minutes is the bots' tell (H19's idle stands)
     */
    private _mill(player: Player, now: number, x: number, z: number, radius: number): void {
        if (now < this.millAt || player.hasWaypoints() || player.delayed) return;
        this.millAt = now + randInt(20, 60);
        // (the variety work, round 2, the fixes: a tile the dock's own floor reaches, as the dock's tile: a tile drawn in the
        // square (the water, past the pier's rail) was a walk round by the west of Port Khazard and back, and a rescue jump
        // by the dock, which the 20-tile mark had hidden)
        const tiles = [...tilesInSquare(player.level, x, z, radius)];
        const t = tiles.length > 0 ? tiles[randInt(0, tiles.length - 1)] : (player.x << 14) | player.z;
        const tx = t >> 14;
        const tz = t & 0x3fff;
        if (tx !== player.x || tz !== player.z) walkTo(player, tx, tz, player.level);
    }

    /** the bot's place in its crew (0: the first aboard, who minds the net) */
    private _crewIndex(player: Player): number {
        if (!crew) return 0;
        let i = 0;
        for (const m of crew.members) {
            if (m === player) return i;
            i++;
        }
        return 0;
    }

    private _fishCount(player: Player): number {
        const k = keep();
        const inv = player.getInventory(InvType.INV);
        let n = 0;
        if (inv) for (let i = 0; i < inv.capacity; i++) if (inv.get(i) && k.has(inv.get(i)!.id)) n += inv.get(i)!.count;
        return n;
    }

    private _needsSupplies(player: Player): boolean {
        const { paste, rope, bucket } = itemIds();
        return countItem(player, paste) < PASTE / 2 || countItem(player, rope) < 1 || countItem(player, bucket) + countItem(player, itemIds().full) < 1;
    }

    /** the pack too full for the supplies and a catch, or too few coins for them */
    private _needsBank(player: Player): boolean {
        const inv = player.getInventory(InvType.INV);
        return (inv?.freeSlotCount ?? 0) < PASTE + 6 || (this._needsSupplies(player) && countItem(player, Items.COINS) < SUPPLY_COINS);
    }

    private _slotOf(player: Player, id: number): number {
        const inv = player.getInventory(InvType.INV);
        if (!inv) return -1;
        for (let i = 0; i < inv.capacity; i++) if (inv.get(i)?.id === id) return i;
        return -1;
    }

    private _set(state: TrawlerTask['state']): void {
        this.state = state;
        this.stateAt = World.currentTick;
        this.lastClick = 0;
    }

    private _end(player: Player | null, outcome: string): void {
        if (this.state === 'done') return;
        this.state = 'done';
        this.outcome = outcome;
        trawlerStats.ended[outcome] = (trawlerStats.ended[outcome] ?? 0) + 1;
        const p = player ?? this._player;
        if (crew && p) {
            crew.members.delete(p);
            if (crew.members.size === 0 || (crew.leader === p && crew.state === 'forming' && crew.members.size === 0)) crew = null;
            else if (crew.state !== 'forming' && ![...crew.members].some(m => m.slot !== -1)) crew = null;
        }
        if (p && this.started) noteOutingEnd(p, outcome);
    }

    /** the tile by the dock it walks to (picked once a visit) */
    private dockTile: [number, number] | null = null;

    private _walk(player: Player, x: number, z: number): void {
        if (!this.stuck.check(player, x, z)) {
            walkTo(player, x, z, 0);
            return;
        }
        if (this.stuck.desperatelyStuck) {
            teleportNear(player, x, z, 0);
            this.stuck.reset();
            return;
        }
        player.clearWaypoints();
        walkTo(player, x, z, 0);
    }
}
