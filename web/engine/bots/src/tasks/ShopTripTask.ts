/**
 * ShopTripTask.ts
 *
 * Walk to a shop NPC, trade, and buy a specific item.
 * Retries indefinitely until the item is purchased.
 * If coins run out, shouldRun() returns false and the planner re-routes.
 *
 * Stuck detection via StuckDetector catches both stationary bots and
 * oscillation (4-tile back-and-forth). After 5 failed escapes → teleport.
 */

import {
    BotTask, Player,
    walkTo, interactNpcOp, findNpcByName,
    hasItem, countItem, addItem, removeItem, isNear, isInventoryFull,
    Items, Shops,
    teleportToSafety, teleportNear, randInt, StuckDetector,
    openNearbyGate, advanceBankWalk, bankInvId, InvType,
    openShopStock, buyFromOpenShop, humanDelay,
} from '#/engine/bot/tasks/BotTaskBase.js';
import { noteTripFailed } from '#/engine/bot/BotNeeds.js';
import { _equipLoot, botAnswerDialogue, crossingFare } from '#/engine/bot/BotAction.js';
import ObjType from '#/cache/config/ObjType.js';
import { canTravel, CollisionType } from '#/engine/routefinder/index.js';
import { coinsOwned } from '#/engine/bot/BotNeeds.js';
import { moveItems } from '#/engine/bot/port/BotInventoryCompat.js';
import { WARDROBE_SHOPS, wearCarried } from '#/engine/bot/port/BotGear.js';
import { armourPieceOf, isWardrobeItem } from '#/engine/bot/port/BotLooks.js';

export class ShopTripTask extends BotTask {
    private readonly shopKey:  string;
    private readonly itemId:   number;
    private readonly quantity: number;
    private readonly costEach: number;
    private readonly npcName:  string;

    private state: 'bank_walk' | 'withdraw' | 'walk' | 'find' | 'interact' | 'buy' | 'done' = 'walk';
    private waitTicks     = 0;
    private findFailTicks = 0;
    /** port: the item's count in the pack when the shop opened, and after the last click */
    private startCount = -1;
    private lastCount = -1;
    /** port: approaches that did not open the shop */
    private openTries = 0;
    /** port: the trip's coins were counted (and fetched from the bank if short): once a trip */
    private coinsCounted = false;
    /** (the variety work, round 2, track W2) an upstairs shop's door reached: in and up from here */
    private entered = false;
    private readonly stuck = new StuckDetector(30, 4, 2);

    private static readonly NPC_NAMES: Record<string, string> = {
        BOB_AXES:            'bob',
        GERRANTS_FISHING:    'gerrant',
        VARROCK_SWORDS:      'swordshop1',
        VARROCK_ARCHERY:     'lowe',
        VARROCK_RUNES:       'aubury',
        AL_KHARID_SCIMITARS: 'zeke',
        LUMBRIDGE_GENERAL:   'generalshopkeeper1',
        // Was missing entirely — fell back to using the shop KEY itself as the
        // NPC name ("AL_KHARID_CRAFTING", not a real NPC), so findNpcByName()
        // in the 'find' state could never find anyone and bots paced at
        // (3285,3183) forever. Real debugname confirmed via
        // content/scripts/areas/area_alkharid/scripts/dommik.rs2.
        AL_KHARID_CRAFTING:  'dommik',
        // port: earned gear's shops (port/BotGear) and Taverley's herbs (274's debugnames)
        AL_KHARID_LEGS:      'louie_legs',
        VARROCK_ARMOUR:      'horvik_the_armourer',
        FALADOR_SHIELDS:     'cassie',
        FALADOR_CHAINS:      'wayne',
        BARBARIAN_HELMETS:   'peksa',
        TAVERLEY_HERBS:      'jatix',
        // port (the realism work, phase 4: patchwork gear and the wardrobe, port/BotGear WARDROBE_SHOPS)
        THESSALIA_CLOTHES:   'thessalia',
        BETTY_MAGIC:         'betty',
        RANAEL_SKIRTS:       'ranael',
        // port (the variety work, round 1, track W: weapons of every kind and the outfits, port/BotGear WARDROBE_SHOPS)
        VARROCK_SWORDSHOP:   'swordshop1',
        BRIAN_BATTLEAXES:    'brian',
        FLYNN_MACES:         'flynn',
        VARROCK_FANCY_DRESS: 'tailorp',
        ZAFF_STAFFS:         'zaff',
        GAIUS_2H:            'gaius',
        // port (the variety work, round 2, track W2: fashion; members, port/BotGear WARDROBE_SHOPS): Rellekka's Yrsa and
        // Skulgrimen, Canifis' Barker
        RELLEKKA_CLOTHES:    'viking_clothing_shopkeeper',
        RELLEKKA_WEAPONS:    'viking_weapons_salesman',
        CANIFIS_CLOTHES:     'werewolfshopkeeper2',
        // (round 2, W2: the shops round 1 could not reach) the guilds' keepers upstairs, Oziach after his dialogue
        CHAMPIONS_SCAVVO:    'scavvo',
        CHAMPIONS_VALAINE:   'valaine',
        HEROES_HELEMOS:      'helemos',
        OZIACH:              'oziach',
    };

    constructor(shopKey: string, itemId: number, quantity: number, costEach: number) {
        super('ShopTrip');
        this.shopKey  = shopKey;
        this.itemId   = itemId;
        this.quantity = quantity;
        this.costEach = costEach;
        this.npcName  = ShopTripTask.NPC_NAMES[shopKey] ?? shopKey;
    }

    shouldRun(player: Player): boolean {
        if (this.state === 'done') return false;
        // No point walking to shop if we can't afford anything
        // port: banked coins count (fetched first: 'bank_walk'); upstream's bots with thousands banked stopped
        if (coinsOwned(player) < this.costEach) return false;
        // Can't receive the purchased item if the inventory is already full —
        // the bot must bank first. Returning false here lets the planner re-route
        // to a gathering task whose bank_walk state will clear space.
        if (isInventoryFull(player)) return false;
        return true;
    }

    tick(player: Player): void {
        if (this.interrupted) return;
        if (this.cooldown > 0) { this.cooldown--; return; }

        // (port, phase 4: and the wardrobe's shops, port/BotGear)
        const shop = Shops[this.shopKey] ?? WARDROBE_SHOPS[this.shopKey];
        if (!shop) { this.state = 'done'; return; }
        const [sx, sz, sl] = shop.location;

        // ── Walk to shop ──────────────────────────────────────────────────────
        // port: short of coins in the pack, with more in the bank: those first, with the boats' fares there and back
        // (crossingFare). Counted once a trip: counted every tick, the fare of the first boat on the way left the pack
        // short again and sent the bot back to its bank, for good (Ardougne's bank to the Brimhaven boat and back for an
        // hour: the aged sim, seed 3)
        if (this.state === 'walk' && !this.coinsCounted) {
            this.coinsCounted = true;
            if (countItem(player, Items.COINS) < this._coinsWanted(player, sx, sz, sl)) this.state = 'bank_walk';
        }
        if (this.state === 'bank_walk') {
            const result = advanceBankWalk(player, this.stuck);
            if (result === 'walk') return;
            this.cooldown = result === 'ready' ? humanDelay(player, 'bank') : 0; // port (the realism work): a person's stop
            this.state = 'withdraw';
            return;
        }
        if (this.state === 'withdraw') {
            const bid = bankInvId();
            const bank = bid === -1 ? null : player.getInventory(bid);
            const inv = player.getInventory(InvType.INV);
            const short = this._coinsWanted(player, sx, sz, sl) - countItem(player, Items.COINS);
            if (bank && inv && short > 0) moveItems(bank, inv, Items.COINS, short);
            this.stuck.reset();
            this.state = 'walk';
            return;
        }

        if (this.state === 'walk') {
            // (the variety work, round 2, track W2: to the shop's floor too: the guilds' shops are upstairs. On the ground
            // to the building's door first, by the walking graph (the stairs' gateway's route from afar found no path, and
            // from beside its wall "I can't reach that!": the bot stood until a rescue jump), then in and up; a ground
            // shop's door too, when it has one in the data: Varrock's tailor, whose back is to the city's east wall)
            const entrance = (WARDROBE_SHOPS[this.shopKey] as { entrance?: [number, number] } | undefined)?.entrance;
            if (player.level === 0 && entrance && !this.entered) {
                if (Math.max(Math.abs(player.x - entrance[0]), Math.abs(player.z - entrance[1])) > 2) {
                    this._stuckWalk(player, entrance[0], entrance[1], 0);
                    return;
                }
                this.entered = true;
            }
            if (!isNear(player, sx, sz, 8, sl)) {
                // port: one walk a tick (upstream walked twice: the second walkTo dropped the toll gate guard's
                // click the first had made, and the crossing fell back to a jump)
                this._stuckWalk(player, sx, sz, sl);
                return;
            }
            this.state         = 'find';
            this.findFailTicks = 0;
            return;
        }

        // ── Find shop NPC ─────────────────────────────────────────────────────
        if (this.state === 'find') {
            const npc = findNpcByName(player.x, player.z, player.level, this.npcName, 10);
            if (!npc) {
                this.findFailTicks++;
                walkTo(player, sx, sz, sl);
                // NPC not found for a long time — teleport to shop and retry
                if (this.findFailTicks >= 40) {
                    teleportNear(player, sx, sz, sl);
                    this.state         = 'find';
                    this.findFailTicks = 0;
                    this.stuck.reset();
                }
                return;
            }
            // port: next to the shopkeeper first, by walkTo, which opens the doors on the way: the engine routes a
            // player to an NPC through no door (Peksa's shop: "I can't reach that!" for good)
            // (next to it: two tiles can be across Peksa's wall, where she wanders)
            // port: and on the same side of a wall (outside Peksa's shut door, with her just inside it, the bot was
            // "next to" her: "I can't reach that!" three times, and the trip failed)
            const dx = Math.sign(npc.x - player.x);
            const dz = Math.sign(npc.z - player.z);
            const beside = Math.max(Math.abs(npc.x - player.x), Math.abs(npc.z - player.z)) <= 1 && ((dx === 0 && dz === 0) || canTravel(player.level, player.x, player.z, dx, dz, 1, 0, CollisionType.NORMAL));
            if (!beside) {
                if (!player.hasWaypoints()) this._stuckWalk(player, npc.x, npc.z, npc.level);
                if (++this.findFailTicks < 60) return;
            }
            interactNpcOp(player, npc, 3); // op3 = Trade on all shops
            this.state     = 'interact';
            this.waitTicks = 0;
            return;
        }

        // ── Wait for shop to open ─────────────────────────────────────────────
        // port: until its interface is up (the walk to the shopkeeper first), at most 15 ticks
        if (this.state === 'interact') {
            // (the variety work, round 2, track W2) a shopkeeper who talks first (Oziach: "I have slain the dragon!", his
            // "Can I buy a rune plate mail body now please?"): its pages continued, its first option taken, as a player clicks
            if (!openShopStock(player)) botAnswerDialogue(player, 1);
            if (openShopStock(player)) {
                this.state = 'buy';
                this.startCount = countItem(player, this.itemId);
                this.lastCount = -1;
                return;
            }
            if (++this.waitTicks >= 15) {
                // port: not open (the engine routes a player to an NPC through no shut door): back to the shopkeeper
                // by walkTo, which opens the door on the way (Peksa's), three times at most
                if (++this.openTries < 3) {
                    this.state = 'find';
                    this.findFailTicks = 0;
                    this.cooldown = 2;
                    return;
                }
                this._finish(player);
            }
            return;
        }

        // ── Buy item ──────────────────────────────────────────────────────────
        // port: through the shop's interface, a click a tick (buy 1, 5 or 10), until it has the quantity, the shop or
        // the coins run out (a click that changes nothing) or the pack is full. Upstream took the coins its table said
        // and made the item, whatever the shop had
        if (this.state === 'buy') {
            const have = countItem(player, this.itemId);
            const left = this.quantity - (have - this.startCount);
            const stuck = this.lastCount === have;
            if (left <= 0 || stuck || !openShopStock(player) || isInventoryFull(player)) {
                this._finish(player);
                return;
            }
            this.lastCount = have;
            if (!buyFromOpenShop(player, this.itemId, left)) this._finish(player);
        }
    }

    /** port: the trip is over: the shop closed, and a trip that bought nothing noted (port/BotGear: not again soon) */
    private _finish(player: Player): void {
        // (the shop never opened: startCount unset)
        const bought = this.startCount >= 0 && countItem(player, this.itemId) > this.startCount;
        if (!bought) noteTripFailed(player, this.itemId);
        if (openShopStock(player)) player.closeModal();
        // port: a piece of gear goes on at once, as a player puts on what they bought (_equipLoot: the better one);
        // port (phase 4): an accessory, hat or apron into its empty slot (port/BotGear: _equipLoot wears metal only)
        if (bought && ObjType.get(this.itemId).wearpos !== -1) {
            if (isWardrobeItem(this.itemId) && !armourPieceOf(this.itemId)) wearCarried(player, this.itemId);
            else _equipLoot(player);
        }
        this.state = 'done';
    }

    isComplete(_p: Player): boolean { return this.state === 'done'; }

    /**
     * port: the coins this purchase takes (as many of the item as the bot can pay for, up to the quantity), and half
     * as much again: the shop's own price is dearer than the table's when its stock is low
     */
    private _coinsNeeded(player: Player): number {
        return Math.min(coinsOwned(player), Math.ceil(Math.min(this.quantity, Math.floor(coinsOwned(player) / this.costEach)) * this.costEach * 1.5));
    }

    /**
     * port: the coins to carry: the purchase's and the boats' fares from here to the shop and back (crossingFare), no
     * more than the bot owns (a bot with every coin in its pack and none banked walked to its bank and back for nothing)
     */
    private _coinsWanted(player: Player, sx: number, sz: number, sl: number): number {
        return Math.min(coinsOwned(player), this._coinsNeeded(player) + crossingFare(player.x, player.z, player.level, sx, sz, sl));
    }

    override reset(): void {
        super.reset();
        this.state         = 'walk';
        this.waitTicks     = 0;
        this.findFailTicks = 0;
        this.startCount    = -1;
        this.lastCount     = -1;
        this.openTries     = 0;
        this.coinsCounted  = false;
        this.entered       = false;
        this.stuck.reset();
    }

    private _stuckWalk(player: Player, lx: number, lz: number, ll = 0): void {
           if (!this.stuck.check(player, lx, lz)) {
               walkTo(player, lx, lz, ll);
               return;
           }
           if (this.stuck.desperatelyStuck) {
               teleportNear(player, lx, lz, ll);
               this.stuck.reset();
               return;
           }
           if (openNearbyGate(player, 5)) return;
   
           const dx   = lx - player.x;
           const dz   = lz - player.z;
           const escX = player.x + (Math.abs(dz) > Math.abs(dx) ? randInt(-10, 10) : (dz > 0 ? 10 : -10));
           const escZ = player.z + (Math.abs(dx) > Math.abs(dz) ? randInt(-10, 10) : (dx > 0 ? 10 : -10));
           walkTo(player, escX, escZ);
}
}
