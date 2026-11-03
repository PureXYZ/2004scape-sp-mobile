/**
 * PetTripTask.ts (port; bots ideas, round 3, theme G: kittens): a cat person's trip for its kitten, or for its kitten's food, as a sub-task
 * of the pet habit (port/BotPets: at a free moment of the bot's task, which goes on after).
 *
 *   1. Food first, when the pack holds fewer than PET_FOOD_WANT pet foods: its own fish from the bank (raw shrimps,
 *      anchovies, sardines, trout, salmon, tuna; cooked trout, salmon or tuna it owns), else 10 raw sardines from Gerrant's
 *      fishing shop in Port Sarim (274's port_sarim.inv, its stock of 200: Gerrant's Trade and the shop's own screen).
 *      Never from nothing. (Rellekka's fishmonger sells them too: the H builder's Rellekka visit buys them there for a cat
 *      person, port/BotPets isCatPerson.)
 *   2. A kitten trip: the coins (KITTEN_COST) from the bank when the pack is short; the walk to Gertrude's door (3150,3413,
 *      west of Varrock), the door clicked open (loc_1530: walkTo's door handling did not open it; a plain click does),
 *      the step in, Gertrude's Talk-to: her pages continued and "Yes please." (option 1), 274's gertrude.rs2 takes the 100
 *      coins and ~gertrude_give_cat spawns the follower beside the bot.
 * A period visit of kind 'pet' (port/BotPeriod notePeriodStart/End: PC10's rescue jumps), name 'PetTrip'.
 */
import {
    BotTask, Player, InvType,
    walkTo, interactNpcOp, interactLoc, findNpcByName, findLocByName,
    countItem, isNear, isInventoryFull,
    Items, StuckDetector, advanceBankWalk, bankInvId, nearestBank, openShopStock, buyFromOpenShop,
    randInt, humanDelay,
} from '#/engine/bot/tasks/BotTaskBase.js';
import World from '#/engine/World.js';
import ObjType from '#/cache/config/ObjType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import { botAnswerDialogue, botScript } from '#/engine/bot/BotAction.js';
import { coinsOwned } from '#/engine/bot/BotNeeds.js';
import { moveItems } from '#/engine/bot/port/BotInventoryCompat.js';
import { bankStop } from '#/engine/bot/port/BotHabits.js';
import { Locations, PeriodPlaces } from '#/engine/bot/BotKnowledge.js';
import { notePeriodEnd, notePeriodStart } from '#/engine/bot/port/BotPeriod.js';

/** the kitten's price (gertrude.rs2) */
const KITTEN_COST = 100;
/** pet foods a trip wants in the pack, and how many it buys or takes from the bank */
const FOOD_WANT = 4;
const FOOD_TAKE = 10;
/** sardines at Port Sarim only from east of White Wolf Mountain (port/BotPets' habit asks the same) */
const SARDINES_EAST_OF = 2880;
/** the trip is over after this long, whatever happened (ticks) */
const TRIP_TICKS = 4000;
/** Gertrude's dialogue: at most this long (ticks) */
const TALK_TICKS = 150;

/**
 * coins a trip wants for the shop: the sardines' (10 at the shop's dearest, half again) and the kitten's after them;
 * port/BotPets' habit asks the same before it sends a bot to Port Sarim (the review's G-4: it asked 30)
 */
export function shopCoinsFor(mode: 'kitten' | 'food'): number {
    return (mode === 'kitten' ? KITTEN_COST : 0) + 80;
}

/** the pet foods (port/BotPets petFoods' list, raw first; looked up once) */
let foods: number[] | null = null;
function petFoodIds(): number[] {
    foods ??= [Items.RAW_SARDINE, Items.RAW_SHRIMP, Items.RAW_ANCHOVIES, Items.RAW_TROUT, Items.RAW_SALMON, Items.RAW_TUNA, Items.TROUT, Items.SALMON, ObjType.getId('tuna')].filter(id => typeof id === 'number' && id !== -1);
    return foods;
}

function carried(p: Player): number {
    let n = 0;
    for (const id of petFoodIds()) n += countItem(p, id);
    return n;
}

/** the pet foods in the bot's bank (its own catch, bought fish) */
export function bankedPetFood(p: Player): number {
    const bid = bankInvId();
    const bank = bid === -1 ? null : p.getInventory(bid);
    if (!bank) return 0;
    let n = 0;
    for (const id of petFoodIds()) n += bank.getItemCount(id);
    return n;
}

let followerObjVarp: number | undefined;
function hasFollower(p: Player): boolean {
    followerObjVarp ??= VarPlayerType.getId('follower_obj');
    if (followerObjVarp === -1) return false;
    const v = p.getVar(followerObjVarp);
    return typeof v === 'number' && v > 0;
}

/** the trips and how they ended (the tests) */
export const petTripStats = { begun: 0, ended: {} as Record<string, number>, doors: 0, talks: 0, bankFood: 0, shops: 0 };

type State = 'start' | 'bank_walk' | 'bank_take' | 'shop_coins' | 'shop' | 'coins_walk' | 'coins_take' | 'walk' | 'door' | 'enter' | 'talk' | 'done';

export class PetTripTask extends BotTask {
    readonly mode: 'kitten' | 'food';
    private state: State = 'start';
    private readonly stuck = new StuckDetector(40, 4, 3);
    private started = -1;
    /** Gerrant's shop: its clicks (Trade, Buy), when, the sardines before */
    private shopAt = -100;
    private shopGap = 0;
    private trades = 0;
    private buys = 0;
    private sardines0 = 0;
    private doorTries = 0;
    private doorAt = -1;
    private talkAt = -1;
    private talkTries = 0;
    private noted = false;
    private ended = false;
    private outcome = 'done';
    private _player: Player | null = null;
    /** set when the kitten came (port/BotPets' line) */
    bought = false;

    constructor(mode: 'kitten' | 'food') {
        super('PetTrip');
        this.mode = mode;
    }

    shouldRun(player: Player): boolean {
        if (this.state === 'done' || this.interrupted) return false;
        // (a pet already: the trip is over, its visit ended here: BotPlayer drops a sub-task that cannot run without its
        // interrupt, and a visit left open counted the bot's later rescue jumps as the pet trip's, PC10)
        if (this.mode === 'kitten' && this.state !== 'talk' && hasFollower(player)) {
            this._end(player, 'has-pet');
            return false;
        }
        return true;
    }

    isComplete(_p: Player): boolean {
        return this.state === 'done';
    }

    override interrupt(): void {
        super.interrupt();
        this._end(this._player, 'interrupted');
    }

    override reset(): void {
        // (a sub-task is never resumed: a reset before its start is its start)
        super.reset();
    }

    tick(player: Player): void {
        if (this.interrupted || this.state === 'done') return;
        this._player = player;
        const now = World.currentTick;
        if (this.started === -1) {
            this.started = now;
            petTripStats.begun++;
            this.noted = true;
            notePeriodStart(player, this.mode === 'kitten' ? 'kitten' : 'pet-food', 'pet');
        }
        if (now - this.started > TRIP_TICKS) {
            this._end(player, 'time');
            return;
        }
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        switch (this.state) {
            case 'start': {
                if (carried(player) >= FOOD_WANT) this.state = this.mode === 'kitten' ? 'coins_walk' : 'done';
                else if (bankedPetFood(player) > 0) this.state = 'bank_walk';
                else if (coinsOwned(player) >= this._coinsForShop() && !isInventoryFull(player) && player.x >= SARDINES_EAST_OF) {
                    // (the coins first, at a bank on the way: the shop trip's own bank walk pulled against the walk to the
                    // shop, and the two stalled into rescue jumps)
                    this.state = countItem(player, Items.COINS) >= this._coinsForShop() ? 'shop' : 'shop_coins';
                    petTripStats.shops++;
                } else this.state = this.mode === 'kitten' ? 'coins_walk' : 'done';
                if (this.state === 'done') this._end(player, carried(player) > 0 ? 'done' : 'no-food');
                return;
            }
            case 'bank_walk': {
                const result = this._bankWalk(player);
                if (result === 'walk') return;
                this.cooldown = result === 'ready' ? bankStop(player) : 0;
                this.state = 'bank_take';
                return;
            }
            case 'bank_take': {
                // (its own fish, raw first; and the kitten's coins at the same booth)
                const bid = bankInvId();
                const bank = bid === -1 ? null : player.getInventory(bid);
                const inv = player.getInventory(InvType.INV);
                if (bank && inv) {
                    let want = FOOD_TAKE - carried(player);
                    for (const id of petFoodIds()) {
                        if (want <= 0 || inv.freeSlotCount === 0) break;
                        const n = Math.min(want, bank.getItemCount(id), inv.freeSlotCount);
                        if (n > 0) {
                            moveItems(bank, inv, id, n);
                            want -= n;
                        }
                    }
                    if (this.mode === 'kitten' && countItem(player, Items.COINS) < KITTEN_COST) moveItems(bank, inv, Items.COINS, Math.min(KITTEN_COST + 20 - countItem(player, Items.COINS), bank.getItemCount(Items.COINS)));
                    petTripStats.bankFood++;
                }
                if (player.containsModalInterface()) player.closeModal();
                this.stuck.reset();
                this.state = this.mode === 'kitten' ? 'walk' : 'done';
                if (this.state === 'done') this._end(player, carried(player) > 0 ? 'done' : 'no-food');
                return;
            }
            case 'shop_coins': {
                const result = this._bankWalk(player);
                if (result === 'walk') return;
                const bid = bankInvId();
                const bank = bid === -1 ? null : player.getInventory(bid);
                const inv = player.getInventory(InvType.INV);
                const short = this._coinsForShop() - countItem(player, Items.COINS);
                if (bank && inv && short > 0) moveItems(bank, inv, Items.COINS, Math.min(short, bank.getItemCount(Items.COINS)));
                if (player.containsModalInterface()) player.closeModal();
                this.cooldown = result === 'ready' ? bankStop(player) : 0;
                this.stuck.reset();
                this.state = 'shop';
                return;
            }
            case 'shop': {
                // (the long walk to Port Sarim its own, patient one; then Gerrant's own shop: his Trade (op 3), its
                // screen's Buy 10 (a few clicks at most), closed again. The shop trip's walks jumped a bot whose route
                // stalled, a woodcutter by Port Sarim's trees 13 times in a run)
                const [gx, gz] = Locations.GERRANTS_FISHING;
                if (player.level !== 0 || Math.max(Math.abs(player.x - gx), Math.abs(player.z - gz)) > 7) {
                    this._walk(player, gx, gz);
                    return;
                }
                if (player.delayed || now - this.shopAt < this.shopGap) return;
                this.shopAt = now;
                this.shopGap = randInt(3, 7);
                if (openShopStock(player)) {
                    const got = countItem(player, Items.RAW_SARDINE) - this.sardines0;
                    if (got < FOOD_TAKE && this.buys < 4 && !isInventoryFull(player) && buyFromOpenShop(player, Items.RAW_SARDINE, FOOD_TAKE - got)) {
                        this.buys++;
                        return;
                    }
                    player.closeModal();
                } else if (this.trades < 4) {
                    const gerrant = findNpcByName(player.x, player.z, 0, 'gerrant', 15);
                    if (gerrant) {
                        if (this.trades === 0) this.sardines0 = countItem(player, Items.RAW_SARDINE);
                        this.trades++;
                        interactNpcOp(player, gerrant, 3);
                        this.shopGap = randInt(8, 14);
                        return;
                    }
                }
                this.state = this.mode === 'kitten' ? 'coins_walk' : 'done';
                if (this.state === 'done') this._end(player, carried(player) > 0 ? 'done' : 'no-food');
                return;
            }
            case 'coins_walk': {
                if (countItem(player, Items.COINS) >= KITTEN_COST) {
                    this.state = 'walk';
                    return;
                }
                if (coinsOwned(player) < KITTEN_COST) {
                    this._end(player, 'coins');
                    return;
                }
                const result = this._bankWalk(player);
                if (result === 'walk') return;
                this.cooldown = result === 'ready' ? bankStop(player) : 0;
                this.state = 'coins_take';
                return;
            }
            case 'coins_take': {
                const bid = bankInvId();
                const bank = bid === -1 ? null : player.getInventory(bid);
                const inv = player.getInventory(InvType.INV);
                if (bank && inv) moveItems(bank, inv, Items.COINS, Math.min(KITTEN_COST + 20 - countItem(player, Items.COINS), bank.getItemCount(Items.COINS)));
                if (player.containsModalInterface()) player.closeModal();
                this.stuck.reset();
                this.state = countItem(player, Items.COINS) >= KITTEN_COST ? 'walk' : 'done';
                if (this.state === 'done') this._end(player, 'coins');
                return;
            }
            case 'walk': {
                const [ox, oz] = PeriodPlaces.GERTRUDE_OUTSIDE;
                if (player.level === 0 && isNear(player, ox, oz, 1)) {
                    this.state = 'door';
                    this.stuck.reset();
                    return;
                }
                this._walk(player, ox, oz);
                return;
            }
            case 'door': {
                // (her door, a plain click: open it unless it is open already)
                const [dx, dz] = PeriodPlaces.GERTRUDE_DOOR;
                const closed = findLocByName(dx, dz, 0, 'loc_1530', 1);
                if (!closed) {
                    this.state = 'enter';
                    return;
                }
                if (this.doorAt !== -1 && now - this.doorAt < 6) return;
                if (++this.doorTries > 4) {
                    this._end(player, 'door');
                    return;
                }
                interactLoc(player, closed);
                this.doorAt = now;
                petTripStats.doors++;
                return;
            }
            case 'enter': {
                const [ix, iz] = PeriodPlaces.GERTRUDE_INSIDE;
                if (player.level === 0 && player.x === ix && player.z === iz) {
                    this.state = 'talk';
                    this.cooldown = humanDelay(player, 'next');
                    return;
                }
                if (!player.hasWaypoints()) walkTo(player, ix, iz, 0);
                if (this.stuck.check(player, ix, iz)) {
                    // (shut again by someone: the door once more)
                    this.stuck.reset();
                    this.state = 'door';
                }
                return;
            }
            case 'talk': {
                if (hasFollower(player) && botScript(player) === null) {
                    this.bought = true;
                    this._end(player, 'bought');
                    return;
                }
                // (her pages continued, "Yes please." chosen: option 1 of her p_choice2)
                if (botAnswerDialogue(player, 1) !== null) {
                    this.cooldown = humanDelay(player, 'page');
                    return;
                }
                if (player.delayed || botScript(player)) return;
                if (this.talkAt !== -1) {
                    // (her talk over with no kitten (short of coins, one owned), or it never opened: once more, then home)
                    if (now - this.talkAt <= 20) return;
                    if (++this.talkTries >= 2) {
                        this._end(player, 'no-kitten');
                        return;
                    }
                    this.talkAt = -1;
                }
                const gertrude = findNpcByName(player.x, player.z, 0, 'gertrude', 8);
                if (!gertrude || countItem(player, Items.COINS) < KITTEN_COST) {
                    this._end(player, gertrude ? 'coins' : 'no-gertrude');
                    return;
                }
                interactNpcOp(player, gertrude, 1);
                this.talkAt = now;
                petTripStats.talks++;
                return;
            }
        }
    }

    /**
     * the walk to the nearest bank its own patient one, then the booth by advanceBankWalk (whose own walk jumps a bot
     * whose route stalls: a probe's trip from Port Sarim to Draynor's bank was jumped there, a stall at its start)
     */
    private _bankWalk(player: Player): 'walk' | 'ready' | 'direct' {
        if (this.state === 'done') return 'walk';
        const [bx, bz, bl] = nearestBank(player);
        if (bl === 0 && player.level === 0 && !isNear(player, bx, bz, 3, 0)) {
            this._walk(player, bx, bz);
            return 'walk';
        }
        return advanceBankWalk(player, this.stuck);
    }

    private _coinsForShop(): number {
        return shopCoinsFor(this.mode);
    }

    private _walk(player: Player, x: number, z: number): void {
        if (!this.stuck.check(player, x, z)) {
            if (!player.hasWaypoints() || World.currentTick % 10 === 0) walkTo(player, x, z, 0);
            return;
        }
        // (no jump for a pet's errand: the trip is over, and the bot's own task goes on from here)
        if (this.stuck.desperatelyStuck) {
            this._end(player, 'stuck');
            return;
        }
        walkTo(player, player.x + randInt(-6, 6), player.z + randInt(-6, 6));
    }

    private _end(player: Player | null, outcome: string): void {
        this.state = 'done';
        if (this.ended) return;
        this.ended = true;
        this.outcome = outcome;
        petTripStats.ended[outcome] = (petTripStats.ended[outcome] ?? 0) + 1;
        if (this.noted && player) {
            this.noted = false;
            notePeriodEnd(player, outcome);
        }
        if (this.bought && player) onBought?.(player);
    }

    /** how the trip ended ('bought', 'done', 'no-food', 'coins', 'door', 'time', 'interrupted' ...) */
    get result(): string {
        return this.ended ? this.outcome : '';
    }
}

/** port/BotPets' line and count for a kitten bought (set at its load: no import of it here, no cycle) */
let onBought: ((p: Player) => void) | null = null;
export function setPetBoughtHook(fn: ((p: Player) => void) | null): void {
    onBought = fn;
}
