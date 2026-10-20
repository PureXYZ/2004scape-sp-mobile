// port: a law rune run to the Wizards' Guild (the realism work, phase 5a, Track M). No free shop sells laws in 274; the
// Magic Guild Store in Yanille does (members, Magic 66 at the guild's doors). With "new bots only"
// (saved bots got no rune seed), this is how a saved bot comes by laws through play: a teleporter (port/BotTeleport) of
// Magic 66+ on a members world, out of laws, with coins to spare, now and then (the planner's magic step:
// port/BotAlch.alchTaskFor) takes its coins out at its bank, goes to Yanille (a teleport to Ardougne on the way when it
// qualifies), through the guild's door (its own script checks the level), up the stairs (a gateway: BotAction
// WizardsGuild1), trades with the store owner (the real shop: its price, its stock, a click of buy 1, 5 or 10 a tick),
// buys 20-50 laws and the elementals its spells lack, comes down and banks them at Yanille.
//
// A sink, not a loop: laws cost their value at the guild (40 gp, dearer as the stock runs down); nothing here sells.
import {
    BotTask,
    Player,
    InvType,
    Items,
    Locations,
    StuckDetector,
    advanceBankWalk,
    bankInvId,
    countItem,
    findNpcByName,
    interactNpcOp,
    walkTo,
    teleportNear,
    humanDelay,
    openShopStock,
    buyFromOpenShop
} from '#/engine/bot/tasks/BotTaskBase.js';
import { canTravel, CollisionType } from '#/engine/routefinder/index.js';
import { moveItems } from '#/engine/bot/port/BotInventoryCompat.js';
import { elementalsWanted } from '#/engine/bot/port/BotTeleport.js';

/** laws a run buys */
export const LAWS_BOUGHT: [number, number] = [20, 50];
/** coins it takes along (the laws dearer as the stock runs down: about 60 each at the end) */
const COINS_TAKEN = 4000;
/** within this of the store it walks to the store itself (up the stairs); farther, to Yanille's bank first (a teleport) */
const NEAR_GUILD = 60;

/** port (phase 5a): law runs so far and what they bought (the tests, the report) */
export const lawTripStats = { trips: 0, done: 0, laws: 0, elementals: 0 };

export class LawTripTask extends BotTask {
    private state: 'bank' | 'walk' | 'find' | 'open' | 'buy' | 'down' | 'deposit' | 'done' = 'bank';
    private readonly stuck = new StuckDetector(30, 4, 3);
    private readonly laws: number;
    private wait = 0;
    private tries = 0;
    private lastCount = -1;
    private shopping: [number, number][] = [];
    private started = false;

    constructor(laws: number) {
        super('LawTrip');
        this.laws = laws;
    }

    shouldRun(player: Player): boolean {
        return this.state !== 'done' && player.botTradeTargetPid === -1;
    }

    isComplete(_player: Player): boolean {
        return this.state === 'done';
    }

    tick(player: Player): void {
        if (this.interrupted || this.state === 'done') return;
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        if (!this.started) {
            this.started = true;
            lawTripStats.trips++;
        }
        const [sx, sz, sl] = Locations.WIZARDS_GUILD_STORE;
        switch (this.state) {
            case 'bank': {
                // its coins for the run, at the bank it is near
                const result = advanceBankWalk(player, this.stuck);
                if (result === 'walk') return;
                const bid = bankInvId();
                const bank = bid === -1 ? null : player.getInventory(bid);
                const inv = player.getInventory(InvType.INV);
                const short = COINS_TAKEN - countItem(player, Items.COINS);
                if (bank && inv && short > 0) moveItems(bank, inv, Items.COINS, short);
                this.cooldown = result === 'ready' ? humanDelay(player, 'bank') : 0;
                this.stuck.reset();
                this.state = countItem(player, Items.COINS) >= 1000 ? 'walk' : 'done';
                return;
            }
            case 'walk': {
                if (player.level === sl && Math.max(Math.abs(player.x - sx), Math.abs(player.z - sz)) <= 6) {
                    this.state = 'find';
                    this.wait = 0;
                    return;
                }
                // (far off, on the ground: to Yanille's bank first, by the guild, where a teleport may take it (port/BotTeleport
                // plans spells for walks on the ground only: one to the store upstairs never got the Ardougne teleport)
                if (player.level === 0 && Math.max(Math.abs(player.x - sx), Math.abs(player.z - sz)) > NEAR_GUILD) {
                    const [bx, bz] = Locations.YANILLE_BANK;
                    this._walk(player, bx, bz, 0);
                    return;
                }
                this._walk(player, sx, sz, sl);
                return;
            }
            case 'find': {
                const npc = findNpcByName(player.x, player.z, player.level, 'magic_store_owner', 10);
                if (!npc) {
                    if (++this.wait > 40) this.state = 'down';
                    else walkTo(player, sx, sz, sl);
                    return;
                }
                // (next to it first, on its side of the counter: walkTo opens doors, the engine routes to an NPC through none)
                const dx = Math.sign(npc.x - player.x);
                const dz = Math.sign(npc.z - player.z);
                const beside = Math.max(Math.abs(npc.x - player.x), Math.abs(npc.z - player.z)) <= 1 && ((dx === 0 && dz === 0) || canTravel(player.level, player.x, player.z, dx, dz, 1, 0, CollisionType.NORMAL));
                if (!beside && ++this.wait < 60) {
                    if (!player.hasWaypoints()) walkTo(player, npc.x, npc.z, npc.level);
                    return;
                }
                interactNpcOp(player, npc, 3); // Trade
                this.state = 'open';
                this.wait = 0;
                return;
            }
            case 'open': {
                if (openShopStock(player)) {
                    // (the laws first; then the elementals its spells lack: elementalsWanted counts the laws it owns)
                    this.shopping = [[Items.LAW_RUNE, countItem(player, Items.LAW_RUNE) + this.laws]];
                    this.lastCount = -1;
                    this.state = 'buy';
                    return;
                }
                if (++this.wait >= 15) {
                    this.wait = 0;
                    this.state = ++this.tries < 3 ? 'find' : 'down';
                }
                return;
            }
            case 'buy': {
                const item = this.shopping[0];
                if (!item || !openShopStock(player)) {
                    this._closeShop(player);
                    return;
                }
                const [id, want] = item;
                const have = countItem(player, id);
                if (have >= want || have === this.lastCount || countItem(player, Items.COINS) < 100) {
                    this.shopping.shift();
                    if (id === Items.LAW_RUNE) {
                        lawTripStats.laws += Math.max(0, have - (want - this.laws));
                        for (const [rune, n] of elementalsWanted(player)) this.shopping.push([rune, countItem(player, rune) + n]);
                    } else lawTripStats.elementals++;
                    this.lastCount = -1;
                    if (this.shopping.length === 0) this._closeShop(player);
                    return;
                }
                this.lastCount = have;
                if (!buyFromOpenShop(player, id, want - have)) this.lastCount = have;
                return;
            }
            case 'down':
            case 'deposit': {
                // down the stairs and out of the guild, to Yanille's bank: the runes in
                const [bx, bz, bl] = Locations.YANILLE_BANK;
                if (this.state === 'down') {
                    if (player.level === bl && Math.max(Math.abs(player.x - bx), Math.abs(player.z - bz)) <= 3) {
                        this.state = 'deposit';
                        this.stuck.reset();
                        return;
                    }
                    this._walk(player, bx, bz, bl);
                    return;
                }
                const result = advanceBankWalk(player, this.stuck);
                if (result === 'walk') return;
                const bid = bankInvId();
                const bank = bid === -1 ? null : player.getInventory(bid);
                const inv = player.getInventory(InvType.INV);
                if (bank && inv) for (const id of [Items.LAW_RUNE, Items.FIRE_RUNE, Items.WATER_RUNE, Items.EARTH_RUNE, Items.AIR_RUNE, Items.COINS]) moveItems(inv, bank, id, countItem(player, id));
                this.cooldown = result === 'ready' ? humanDelay(player, 'bank') : 0;
                lawTripStats.done++;
                this.state = 'done';
                return;
            }
        }
    }

    private _closeShop(player: Player): void {
        if (openShopStock(player)) player.closeModal();
        this.state = 'down';
        this.stuck.reset();
    }

    /** a walk with the stuck checks every task has (the rescue jump only where no human sees: botTeleport) */
    private _walk(player: Player, x: number, z: number, level: number): void {
        if (!this.stuck.check(player, x, z)) {
            walkTo(player, x, z, level);
            return;
        }
        if (this.stuck.desperatelyStuck) {
            teleportNear(player, x, z, level);
            this.stuck.reset();
            return;
        }
        player.clearWaypoints();
        walkTo(player, x, z, level);
    }

    override reset(): void {
        super.reset();
        this.wait = 0;
        this.stuck.reset();
        if (this.started && this.state !== 'done') this.state = 'done';
    }
}
