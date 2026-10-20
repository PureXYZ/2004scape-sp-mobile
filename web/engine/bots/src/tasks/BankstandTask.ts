// port: trades follow the trade screens (port/BotTradeScreen.TradeSession) and the prices are fair. Upstream offered
// every slot of the bot's pack (coins, tools, food and the gear a fighter takes off included), priced 'all' from a stock
// list that was empty before the first bank visit and after every trade ("Everything will cost 0gp."), accepted any
// coin stack at or above the price (keeping the change) and clicked the accept buttons on timers. Here the bot takes a
// trade only with stock in its pack, offers only that stock, prices 'all' from what is in the offer, never at 0, gives
// the change back (it keeps its coins when it banks) and refuses an overpayment of one item's price or more; the bank
// is used with its window open and closed afterwards.
import ObjType from '#/cache/config/ObjType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import Component from '#/cache/config/Component.js';
import {
    interactIF_UseOp, interactIfButtonByName,
    viableItemIds
} from '#/engine/bot/BotAction.js';
import { findClosest, Interfaces, Items } from '#/engine/bot/BotKnowledge.js';
import {
    BotTask,
    Player,
    walkTo,
    isNear,
    Locations,
    randInt,
    StuckDetector,
    ProgressWatchdog,
    InvType,
    bankInvId,
    openNearbyGate,
    advanceBankWalk,
    teleportNear
} from '#/engine/bot/tasks/BotTaskBase.js';
import World from '#/engine/World.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { botSay } from '#/engine/bot/port/BotSay.js';
import { clearTradeTarget, packCounts, setOffer, tradeOffer, TradeSession, type TradeDeal, type TradeOutcome, type TradingTask } from '#/engine/bot/port/BotTradeScreen.js';
import { depositItems } from '#/engine/bot/port/BotInventoryCompat.js';
import { claimNearestStall, releaseStall, takeAdvertTurn, TRADE_BANKS, type Stall } from '#/engine/bot/port/BotTradeSpots.js';
import { categoryOf, itemValue, sellPrice, streetPrice } from '#/engine/bot/port/BotPrices.js';
import { advertGapOf, buyerNear, vendorStock } from '#/engine/bot/tasks/VendorTask.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';

const VIABLE_ITEMS = new Set(viableItemIds);

function pick(lines: readonly string[]): string {
    return lines[Math.floor(Math.random() * lines.length)];
}

export class BankstandTask extends BotTask implements TradingTask {
    private state: 'walk'
        | 'move'
        | 'bank_walk'
        | 'bank'
        | 'idle'
        | 'trade' = 'walk';

    private duration:number;
    /** port: the stint is over (isComplete) */
    private finished = false;
    /** port: its stall at the trade bank nearest it (port/BotTradeSpots: bankstanders spread over the banks too) */
    private stall: Stall | null = null;
    private readonly stuck = new StuckDetector(10, 2, 1);
    private readonly watchdog = new ProgressWatchdog();
    private hasBanked: boolean = false;
    /** port: what the bot sells, from its pack (the sellable items, noted): item id as held -> count and price each */
    private stock: Map<number, { count: number; price: number }> = new Map();
    /** port: one price per item for the session (askFor: the same for the same name since the realism work's phase 4; upstream drew one on every call) */
    private readonly prices: Map<number, number> = new Map();
    /** port: what the human asked for in this trade: an item (as held), everything, or nothing yet */
    private request: number | 'all' | null = null;
    private readonly trade = new TradeSession();
    /** port: ticks since the bot used the bank booth (its window opens a tick later) */
    private bankWait = 0;
    /** The bot this task last ran for: reset() closes a trade still open when the bot switches tasks. */
    private self: Player | null = null;
    private intentCooldown = 0;
    /** (the variety work, round 1, Track S: ISS-5) the tick its next advert may come (its own log-normal pace, VendorTask advertGapOf) */
    private advertDue = -1;

    constructor() {
        super('Bankstand');
        this.duration = 3000; //3,000 * 0.6 = 1,800 seconds = 30 minutes
        this.finished = false;
    }

    private static listPrice(itemId: number): number {
        let price = 0;
        switch(itemId) {
            //Logs->
            case Items.LOGS: //+1 for certed versions too
            case (Items.LOGS + 1):
                price = 150;
                break;
            case Items.OAK_LOGS:
            case (Items.OAK_LOGS + 1):
                price = 50;
                break;
            case Items.WILLOW_LOGS:
            case (Items.WILLOW_LOGS + 1):
                price = 50;
                break;
            case Items.MAPLE_LOGS:
            case (Items.MAPLE_LOGS + 1):
                price = 175;
                break;
            case Items.YEW_LOGS:
            case (Items.YEW_LOGS + 1):
                price = 400;
                break;
            case Items.MAGIC_LOGS:
            case (Items.MAGIC_LOGS + 1):
                price = 1100;
                break;
            //Ores->
            case Items.COPPER_ORE:
            case (Items.COPPER_ORE + 1):
            case Items.TIN_ORE:
            case (Items.TIN_ORE + 1):
                price = 50;
                break;
            case Items.IRON_ORE:
            case (Items.IRON_ORE + 1):
                price = 350;
                break;
            case Items.COAL:
            case (Items.COAL + 1):
                price = 650;
                break;
            case Items.MITHRIL_ORE:
            case (Items.MITHRIL_ORE + 1):
                price = 500;
                break;
            case Items.ADAMANTITE_ORE:
            case (Items.ADAMANTITE_ORE + 1):
                price = 800;
                break;
            case Items.RUNITE_ORE:
            case (Items.RUNITE_ORE + 1):
                price = 8000;
                break;
            //Bars->
            case Items.BRONZE_BAR:
            case (Items.BRONZE_BAR + 1):
                price = 250;
                break;
            case Items.IRON_BAR:
            case (Items.IRON_BAR + 1):
                price = 400;
                break;
            case Items.STEEL_BAR:
            case (Items.STEEL_BAR + 1):
                price = 1500;
                break;
            case Items.SILVER_BAR:
            case (Items.SILVER_BAR + 1):
                price = 100;
                break;
            case Items.GOLD_BAR:
            case (Items.GOLD_BAR + 1):
                price = 350;
                break;
            case Items.MITHRIL_BAR:
            case (Items.MITHRIL_BAR + 1):
                price = 2000;
                break;
            case Items.ADAMANTITE_BAR:
            case (Items.ADAMANTITE_BAR + 1):
                price = 4000;
                break;
            case Items.RUNITE_BAR:
            case (Items.RUNITE_BAR + 1):
                price = 10000;
                break;
            //Gems->
            case Items.UNCUT_OPAL:
            case (Items.UNCUT_OPAL + 1):
                price = 40;
                break;
            case Items.UNCUT_JADE:
            case (Items.UNCUT_JADE + 1):
                price = 80;
                break;
            case Items.UNCUT_RED_TOPAZ:
            case (Items.UNCUT_RED_TOPAZ + 1):
                price = 200;
                break;
            case Items.UNCUT_SAPPHIRE:
            case (Items.UNCUT_SAPPHIRE + 1):
                price = 1200;
                break;
            case Items.UNCUT_EMERALD:
            case (Items.UNCUT_EMERALD + 1):
                price = 3400;
                break;
            case Items.UNCUT_RUBY:
            case (Items.UNCUT_RUBY + 1):
                price = 4000;
                break;
            case Items.UNCUT_DIAMOND:
            case (Items.UNCUT_DIAMOND + 1):
                price = 5000;
                break;
            case Items.UNCUT_DRAGONSTONE:
            case (Items.UNCUT_DRAGONSTONE + 1):
                price = 25000;
                break;
            case Items.DRAGONSTONE:
            case (Items.DRAGONSTONE + 1):
                price = 40000;
                break;
            //Bones->
            case Items.BONES:
            case (Items.BONES + 1):
                price = 10;
                break;
            case Items.BIG_BONES:
            case (Items.BIG_BONES + 1):
                price = 300;
                break;
            case Items.BAT_BONES:
            case (Items.BAT_BONES + 1):
                price = 10;
                break;
            case Items.BABYDRAGON_BONES:
            case (Items.BABYDRAGON_BONES + 1):
                price = 450;
                break;
            case Items.DRAGON_BONES:
            case (Items.DRAGON_BONES + 1):
                price = 2000;
                break;
            //Raw fish->
            case Items.RAW_SHRIMP:
            case (Items.RAW_SHRIMP + 1):
            case Items.RAW_ANCHOVIES:
            case (Items.RAW_ANCHOVIES + 1):
                price = 10;
                break;
            case Items.RAW_SARDINE:
            case (Items.RAW_SARDINE + 1):
                price = 15;
                break;
            case Items.RAW_TROUT:
            case (Items.RAW_TROUT + 1):
                price = 20;
                break;
            case Items.RAW_COD:
            case (Items.RAW_COD + 1):
                price = 20;
                break;
            case Items.RAW_SALMON:
            case (Items.RAW_SALMON + 1):
                price = 30;
                break;
            case Items.RAW_HERRING:
            case (Items.RAW_HERRING + 1):
            case Items.RAW_PIKE:
            case (Items.RAW_PIKE + 1):
            case Items.RAW_MACKEREL:
            case (Items.RAW_MACKEREL + 1):
                price = 10;
                break;
            case Items.RAW_TUNA:
            case (Items.RAW_TUNA + 1):
                price = 100;
                break;
            case Items.RAW_BASS:
            case (Items.RAW_BASS + 1):
                price = 100;
                break;
            case Items.RAW_LOBSTER:
            case (Items.RAW_LOBSTER + 1):
                price = 200;
                break;
            case Items.RAW_SWORDFISH:
            case (Items.RAW_SWORDFISH + 1):
                price = 300;
                break;
            case Items.RAW_SHARK:
            case (Items.RAW_SHARK + 1):
                price = 800;
                break;
            case Items.RAW_SEA_TURTLE:
            case (Items.RAW_SEA_TURTLE + 1):
                price = 1200;
                break;
            case Items.RAW_MANTA_RAY:
            case (Items.RAW_MANTA_RAY + 1):
                price = 1500;
                break;
            //Misc->
            case Items.BRONZE_ARROWHEADS:
                price = 1;
                break;
            case Items.IRON_ARROWHEADS:
                price = 2;
                break;
            case Items.STEEL_ARROWHEADS:
                price = 3;
                break;
            case Items.MITHRIL_ARROWHEADS:
                price = 55;
                break;
            case Items.ADAMANT_ARROWHEADS:
                price = 100;
                break;
            case Items.RUNE_ARROWHEADS:
                price = 200;
                break;
            case Items.EYE_OF_NEWT:
            case (Items.EYE_OF_NEWT + 1):
                price = 150;
                break;
            case Items.RED_SPIDERS_EGGS:
            case (Items.RED_SPIDERS_EGGS + 1):
                price = 200;
                break;
            case Items.LIMPWURT_ROOT:
            case (Items.LIMPWURT_ROOT + 1):
                price = 500;
                break;
            case Items.SNAPE_GRASS:
            case (Items.SNAPE_GRASS + 1):
                price = 900;
                break;
            case Items.VIAL_EMPTY:
            case (Items.VIAL_EMPTY + 1):
                price = 50;
                break;
            case Items.VIAL_OF_WATER:
            case (Items.VIAL_OF_WATER + 1):
                price = 300;
                break;
            case Items.SEAWEED:
            case (Items.SEAWEED + 1):
                price = 400;
                break;
            case Items.FEATHER:
                price = 20;
                break;
            case Items.CLAY:
            case (Items.CLAY + 1):
                price = 2;
                break;
            default:
                price = 1;
                break;
        }
        // port (the realism work, phase 4): the list's price as it stands (askFor spreads it by the bot's name); upstream
        // added 1-150 coins at random, feathers at 21-170 and raw shrimps at 11-160
        return price;
    }

    shouldRun(): boolean {
        return true;
    }

    /** port: one price per item and session. */
    private priceOf(player: Player, itemId: number): number {
        let price = this.prices.get(itemId);
        if (price === undefined) {
            price = BankstandTask.askFor(player.username, itemId);
            this.prices.set(itemId, price);
        }
        return price;
    }

    /**
     * port (the integration of the realism work's phase 4: "December 2004 street prices"): what a bankstander
     * asks for one, as a vendor does (port/BotPrices.sellPrice): an item of the street table at its street price ±10 % by
     * the bot's name, any other at its value's multiple, never below high alch; an item the game gives no value at the
     * vendors' list price (dragon bones, ±10 % by the name: the review of phase 4), else this list's hand-set price
     * ±15 % (bones, clay). Upstream's list plus 1-150 coins sold coal at 651-800 (150 on the street), feathers at 21-170
     * (5-10) and vials of water at 301-450 (worth 2), and its price checks (port/BotAnswers) said the vendors' prices.
     */
    static askFor(name: string, itemId: number): number {
        // (a note is priced as its item: the same ask for the same name, noted or not, as a vendor's)
        const obj = ObjType.get(itemId);
        const base = obj.certtemplate !== -1 && obj.certlink !== -1 ? obj.certlink : itemId;
        if (streetPrice(base) !== null || itemValue(base) > 1) return sellPrice(base, name, categoryOf(base));
        // (the review of phase 4: an item the vendors sell at their list's price, dragon bones, at theirs; one price)
        const listed = vendorStock().find(s => s.itemId === base && s.market === true);
        if (listed) return sellPrice(base, name, 'market', listed.priceEach);
        const roll = seededRandom(nameSeed(name, `bankstand-price:${base}`))();
        return Math.max(1, Math.round(BankstandTask.listPrice(base) * (0.85 + 0.3 * roll)));
    }

    /**
     * port: the stock is what the pack holds of the sellable items (viableItemIds), never coins, tools, food or gear.
     * Upstream counted its bank withdrawals instead (empty before the first bank visit and after each trade, and
     * counting what did not fit in the pack). Not what the trade scripts refuse: an untradeable item (on a free world
     * every members object is).
     */
    private refreshStock(player: Player): void {
        this.stock.clear();
        const inv = player.getInventory(InvType.INV);
        if (!inv) return;
        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item || !VIABLE_ITEMS.has(item.id) || !ObjType.get(item.id).tradeable) continue;
            const entry = this.stock.get(item.id);
            if (entry) entry.count += item.count;
            else this.stock.set(item.id, { count: item.count, price: this.priceOf(player, item.id) });
        }
    }

    /** port: a trade request (port/BotTrade): taken only with stock to sell and not while banking. */
    tradeRefusal(bot: Player): string | null {
        if (!this.hasBanked || this.state === 'bank_walk' || this.state === 'bank') {
            return pick(['brb, banking', 'Banking, one sec', 'Gotta bank first, one sec']);
        }
        this.refreshStock(bot);
        if (this.stock.size === 0) return pick(['Sold out, sorry', 'Nothing left to sell, sorry']);
        return null;
    }

    // ───────────────── MAIN LOOP ─────────────────

    tick(player: Player): void {
        if (this.interrupted) return;
        this.self = player;

        // port: also not while trading (the watchdog teleports the bot away; a slow human takes minutes)
        const banking = this.state === 'bank_walk' || this.state === 'bank' || this.state === 'trade';

        if (this.watchdog.check(player, banking)) {
            player.clearWaypoints();
            player.clearPendingAction();
            this.interrupt();
            return;
        }

        // port: an accepted request is answered at once (port/BotTrade gives one only to a bot with stock, not banking)
        if (player.botTradeTargetPid !== -1 && this.state !== 'trade') {
            this.cooldown = 0;
            this.beginTrade(player);
        }

        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }

        // port: never mid-trade (the reset left the trade window open)
        if (this.state !== 'trade') {
            if (this.duration > 0) {
                this.duration--;
            } else {
                // port: the stint is over: what is left goes back into the bank as items (the notes too) and the task
                // ends (upstream reset itself and stood on: only the planner's 6-minute rescan, which closed a trade at
                // the confirm screen, ever ended a stint, never at its 30 minutes)
                this._endStint(player);
                return;
            }
        }

        switch (this.state) {
            case 'walk': return this.handleWalk(player);
            case 'move': return this.handleMove(player);
            case 'idle': return this.handleIdle(player);
            case 'bank_walk': return this.handleBankWalk(player);
            case 'bank': return this.handleBank(player);
            case 'trade': return this.handleTrade(player);
        }
    }

    // ───────────────── TRADE (port: screen by screen, port/BotTradeScreen.TradeSession) ─────────────────

    private beginTrade(player: Player): void {
        const target = World.getPlayerByUid(player.botTradeTargetPid);
        if (!target || target.level !== player.level || Math.max(Math.abs(target.x - player.x), Math.abs(target.z - player.z)) > 15) {
            console.log('[Trade] Reset: Invalid target');
            clearTradeTarget(player);
            return;
        }
        this.request = null;
        this.state = 'trade';
        this.trade.begin(player, target);
        this.watchdog.notifyActivity();
    }

    private handleTrade(player: Player): void {
        // what the human says during the trade (BotChat keeps the partner's last public line for the bot)
        const said = player.botTradeTargetChatMessage;
        if (this.trade.phase === 'main' && said) {
            player.botTradeTargetChatMessage = '';
            this.trade.touch();
            if (this.hear(player, said)) {
                botSay(player, 'Np');
                this.trade.end(player, 'declined');
                return this.afterTrade(player, 'declined');
            }
        }
        const outcome = this.trade.tick(
            player,
            (_partner, offer) => this.deal(player, offer),
            partner => {
                // the whole stock goes up first (and only the stock): the human sees what is for sale
                this.refreshStock(player);
                setOffer(player, this.stockOffer());
                botSay(player, `Oh hi ${partner.displayName}! ${pick(['Any?', 'Want any?', 'Anything?'])} Name the item, or say all for everything.`);
            }
        );
        if (outcome !== null) this.afterTrade(player, outcome);
    }

    /**
     * A line the human said: what they want (an item's name, 'all'/'everything') or 'no'. True: they want nothing
     * (upstream took any line with "no" in it for that, "noted logs" too).
     */
    private hear(player: Player, line: string): boolean {
        const msg = ` ${line.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()} `;
        for (const itemId of this.stock.keys()) {
            const name = ObjType.get(itemId).name?.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
            if (!name) continue;
            const singular = name.endsWith('s') ? name.slice(0, -1) : name;
            if (msg.includes(` ${name} `) || msg.includes(` ${singular} `) || msg.includes(` ${name}s `)) {
                this.request = itemId;
                return false;
            }
        }
        if (/ (all|everything) /.test(msg)) {
            this.request = 'all';
            return false;
        }
        if (/ (no|nah|nope|nothing|nvm|no thanks|no ty) /.test(msg)) return true;
        if (/ (yes|yeah|yea|yep|ok|okay|sure|y) /.test(msg)) {
            botSay(player, this.request === null ? 'Which one? Name the item, or say all.' : 'Put up your coins.');
            return false;
        }
        botSay(player, "I don't have that item right now.");
        return false;
    }

    /** The whole stock, as it would go in the offer. */
    private stockOffer(): Map<number, number> {
        const all = new Map<number, number>();
        for (const [id, { count }] of this.stock) all.set(id, count);
        return all;
    }

    /**
     * What the bot sells for the human's offer (port: exact, never at 0, the change back). Until there is a deal its
     * offer shows what is being talked about: its whole stock, or all it has of the item asked for.
     */
    private deal(player: Player, offer: Map<number, number>): TradeDeal {
        const request = this.request;
        const everything = this.stockOffer();
        if (request === null) return { line: '', show: everything };
        const coins = offer.get(Items.COINS) ?? 0;

        if (request === 'all') {
            let total = 0;
            let cheapest = Infinity;
            for (const [id, { count, price }] of this.stock) {
                if (!everything.has(id)) continue;
                total += count * price;
                cheapest = Math.min(cheapest, price);
            }
            if (total <= 0) return { line: 'Sold out, sorry.' };
            for (const id of offer.keys()) {
                if (id !== Items.COINS) return { line: 'Only coins please.', show: everything };
            }
            if (coins === 0) return { line: `Everything will cost ${total}gp. Put up your coins.`, show: everything };
            if (coins < total) return { line: `Everything is ${total}gp, you have ${coins}gp up.`, show: everything };
            const change = coins - total;
            if (change >= cheapest) return { line: `That's too much, everything is ${total}gp. Take back ${change}gp.`, show: everything };
            if (change > this.coinsOnHand(player)) return { line: `Put up exactly ${total}gp please, I have no change.`, show: everything };
            if (change > 0) everything.set(Items.COINS, change);
            return { line: `Everything for ${total}gp${change > 0 ? `, and ${change}gp change` : ''}. Accept when ready!`, give: everything, get: new Map([[Items.COINS, coins]]) };
        }

        const entry = this.stock.get(request);
        if (!entry || entry.count <= 0 || entry.price <= 0) {
            this.request = null;
            return { line: "I don't have that item right now.", show: everything };
        }
        const name = ObjType.get(request).name ?? 'that';
        const { count, price } = entry;
        const all = new Map([[request, count]]);
        for (const id of offer.keys()) {
            if (id !== Items.COINS) return { line: 'Only coins please.', show: all };
        }
        if (coins === 0) return { line: `${name} costs ${price}gp each, ${count * price}gp for all ${count}. Put up your coins.`, show: all };
        if (coins < price) return { line: `You need at least ${price}gp for 1.`, show: all };
        const n = Math.min(Math.floor(coins / price), count);
        const total = n * price;
        const change = coins - total;
        if (change >= price) return { line: `That's too much! ${n} ${name} is ${total}gp, take back ${change}gp.`, show: all };
        if (change > this.coinsOnHand(player)) return { line: `Put up exactly ${total}gp for ${n} please, I have no change.`, show: all };
        const give = new Map([[request, n]]);
        if (change > 0) give.set(Items.COINS, change);
        return { line: `I can sell you ${n} of them for ${total}gp${change > 0 ? `, and ${change}gp change` : ''}. Accept when ready!`, give, get: new Map([[Items.COINS, coins]]) };
    }

    /** Its coins for change: in the pack, and any already in its offer. */
    private coinsOnHand(player: Player): number {
        return (packCounts(player).get(Items.COINS) ?? 0) + (tradeOffer(player).get(Items.COINS) ?? 0);
    }

    private afterTrade(player: Player, outcome: TradeOutcome): void {
        console.log('[Trade] Over:', outcome);
        if (outcome === 'done') {
            botSay(player, Math.random() < 0.5 ? 'Pleasure doing business.' : 'Ty');
        } else if (outcome === 'timeout') {
            botSay(player, 'Too slow, trade me again when you are ready.');
        } else if (outcome === 'refused') {
            botSay(player, 'Something went wrong. Declining.');
        }
        // (the trade fields: TradeSession.end)
        this.request = null;
        this.refreshStock(player);
        this.watchdog.notifyActivity();
        // sold out: bank the coins and restock (upstream banked after every trade, and sold for 0gp until it had)
        if (this.stock.size === 0) {
            this.hasBanked = false;
            this.state = 'bank_walk';
        } else {
            this.state = 'idle';
        }
        this.cooldown = outcome === 'done' ? randInt(6, 10) : 2;
    }

    private handleMove(player: Player): void {
        // port: a step or two about its stall (upstream wandered the road outside Varrock West)
        const [lx, lz] = this._stallTile(player);
        if(Math.random() < 0.2) {
            walkTo(
                player,
                lx + randInt(-1, 1),
                lz + randInt(-1, 1)
            );
        }
        if(!this.hasBanked) {
            this.state = 'bank_walk';
        } else {
            this.state = 'idle';
        }
        this.cooldown = randInt(4, 6);
    }

    private formatGp(amount: number): string {
        if (amount >= 1_000_000) {
            return `${Math.floor(amount / 1_000_000)}m`;
        }
        if (amount >= 10_000) {
            return `${Math.floor(amount / 1_000)}k`;
        }
        return `${amount}`;
    }

    /** (variety round 1, ISS-5) stock worth a bank sale: 5 items or more, or 1k or more in all */
    private worthASale(): boolean {
        let count = 0;
        for (const [, data] of this.stock.entries()) count += data.count;
        return count >= 5 || this.getTotalStockValue() >= 1000;
    }

    private getTotalStockValue(): number {
        let total = 0;

        for (const [, data] of this.stock.entries()) {
            total += data.price * data.count;
        }

        return total;
    }

    private handleIdle(player: Player): void {
        const inv = player.getInventory(InvType.INV);
        if (!inv) return;
        // (the variety work, round 1, Track S: ISS-5: a bankstander's adverts came every 8-12 ticks and its bank's turn, a
        // metronome (gap CV 0.10), "Iron bar (1) - 260gp ea" for 11 minutes: now at its own log-normal pace, with someone
        // to sell to near (sellers do not count), and only stock worth a bank sale)
        const now = World.currentTick;
        const quiet = now < this.advertDue;
        if (this.hasBanked && !quiet && !buyerNear(player)) this.advertDue = now + randInt(20, 50);
        if (this.hasBanked && !quiet && buyerNear(player)) {
            player.closeModal();
            player.delayed = false;

            let saidSomething = false;

            if (this.stock.size === 0) {
                const rand = Math.random();

                if (Math.random() < 0.3) {
                    if (rand < 0.1) {
                        botSay(player, 'Just vibin here');
                    } else if (rand < 0.2) {
                        botSay(player, 'Dont even kno why im here');
                    } else if (rand < 0.3) {
                        botSay(player, 'Bankstanding lvls?');
                    } else if (rand < 0.4) {
                        botSay(player, 'This is exactly where I need to be');
                    } else if (rand < 0.5) {
                        botSay(player, 'Keep tryna find stuf but cant');
                    } else if (rand < 0.6) {
                        botSay(player, 'Zoned tf out');
                    } else if (rand < 0.7) {
                        botSay(player, 'I always do this');
                    } else if (rand < 0.8) {
                        botSay(player, 'Wher are my logss');
                    } else if (rand < 0.9) {
                        botSay(player, 'I think ive been hacked');
                    } else {
                        botSay(player, 'Guys, I just tried to do something very silly!');
                    }
                    saidSomething = true;
                }
            } else {
                const allItems = Array.from(this.stock.entries());
                const shuffled = allItems.sort(() => Math.random() - 0.5);

                const entries = shuffled.slice(0, 2).map(([id, data]) => {
                    const name = ObjType.get(id).name;
                    return (Math.random() < 0.5)
                        ? `${name} (${data.count}) - ${data.price}gp ea`
                        : `${name} (${data.count}) - ${data.price} ea`;
                });

                const totalValue = this.getTotalStockValue();
                const formattedTotal = this.formatGp(totalValue);

                const roll = Math.random();

                // port: without its name (the chat shows who says it: by design) and in the bank's turn (port/BotTradeSpots)
                if (this.stall && !takeAdvertTurn(this.stall.bank, World.currentTick)) {
                    // (another's turn at this bank)
                } else if (!this.worthASale()) {
                    // (too little to sell: it stands quiet)
                } else if (roll < 0.25) {
                    botSay(player, `Bank sale ${formattedTotal}`);
                    saidSomething = true;

                } else if (roll < 0.5) {
                    botSay(player, `Selling: ${entries.join(', ')}`);
                    saidSomething = true;

                } else {
                    botSay(player, `${entries.join(', ')}, all ${formattedTotal}`);
                    saidSomething = true;
                }
            }

            if (saidSomething) {
                this.watchdog.notifyActivity();
                this.advertDue = now + advertGapOf(player.username);
            }
        } else if (this.hasBanked) {
            player.closeModal();
            player.delayed = false;
        }
        // (variety round 1: standing at its stall is its work, quiet or not: the watchdog's)
        if (this.hasBanked) this.watchdog.notifyActivity();

        this.state = 'move';
        this.cooldown = randInt(8, 12);
    }

    private handleBankWalk(player: Player): void {
        // port: the bank of its stall (the trade bank nearest it with a free stall)
        const closest = this._bankSpot(player);
        if (!closest) return;

        const [bx, bz] = closest;

        if (!isNear(player, bx, bz, 4)) {
            this._stuckWalk(player, bx, bz);
            return;
        }

        

        if(!this.hasBanked) {
            this.state = 'bank';
        } else {
            this.state = 'walk';
        }
        this.cooldown = randInt(4, 6);

    }

    private handleBank(player: Player): void {
        const bank = player.getInventory(bankInvId());
        const inv = player.getInventory(InvType.INV);
        if (!bank || !inv) return;

        // port: the bank window opens the tick after the booth is used. Upstream deposited and withdrew before it was
        // open and left it open afterwards ('<bot> is busy at the moment.' to a trade request): now it banks with the
        // window open and closes it (or, when it does not open, banks without it).
        if (player.modalMain === Component.getId('bank_main')) {
            this.restock(player, true);
            player.closeModal();
        } else if (this.bankWait > 0 && ++this.bankWait <= 10) {
            return;
        } else if (this.bankWait > 0) {
            this.restock(player, false);
        } else {
            const result = advanceBankWalk(player, this.stuck);
            if (result === 'walk') return;
            if (result === 'ready') {
                this.bankWait = 1;
                return;
            }
            this.restock(player, false);
        }
        this.state = 'walk';
        this.cooldown = randInt(4, 6);
    }

    /**
     * Everything in the pack into the bank but its coins (port: the change it gives back), the sellable items back out
     * as notes; the stock is what came out.
     */
    private restock(player: Player, bankOpen: boolean): void {
        this.bankWait = 0;
        // port: no "Interacting with bank..." (upstream's status line, dropped: it read as a
        // bot's debug output)
        const inv = player.getInventory(InvType.INV);
        if (inv) {
            for (let i = 0; i < inv.capacity; i++) {
                const item = inv.get(i);
                if (item && item.id !== Items.COINS) {
                    this.depositItemToBank(player, item.id, item.count);
                }
            }
        }
        // withdraw as notes: the bank's button while its window is open, else the varp the button sets
        if (bankOpen) {
            interactIfButtonByName(player, 'bank_main:com_93');
        } else {
            player.setVar(VarPlayerType.getId('bankcert'), 1);
        }
        this.withdrawViableItems(player);
        this.hasBanked = true;
        this.refreshStock(player);
    }

    /**
     * deposits to bank and removes the item from inventory
     * @param player
     * @param itemId
     * @param count
     * @private
     */
    private depositItemToBank(player: Player, itemId: number, count: number): void {
        const inv = player.getInventory(InvType.INV);
        const bid = bankInvId();
        if (!inv || bid === -1) return;

        const bank = player.getInventory(bid);
        if (!bank) return;

        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item) continue;
            if(item.id == itemId) {
                // (the variety work, round 2, the fixes: room first)
                const moved = depositItems(inv, bank, item.id, count);
                if (moved > 0) {
                    console.log('Banked item: ' + item.id + ' x ' + item.count);
                    break;
                }
            }
        }
    }

    /**
     * Withdraws viable materials, from a list, from the bot's bank
     * Using inferface option 4 (Withdraw all)
     * @param player
     * @private
     */
    private withdrawViableItems(player: Player): void {
        const inv = player.getInventory(bankInvId());
        if(inv) {
            for (let slot = 0; slot < inv.capacity; slot++) {
                const item = inv.get(slot);
                if (!item) continue;
                if (VIABLE_ITEMS.has(item.id)) {
                    //we withdraw
                    console.log('Attempting to withdraw item: ' + item.id + ' from slot: ' + slot);
                    // port: the stock is counted from the pack afterwards (refreshStock): the bank script withdraws
                    // only what fits
                    if (!interactIF_UseOp(player, Interfaces.BANK_MAIN_INV, item.id, slot, 4, bankInvId())) {
                        console.log('Could not withdraw item! ('+ item.id +') for (' + player.displayName + ')');
                    }
                }
            }
        }
    }

    private handleWalk(player: Player): void {
        // If the bot is far from Varrock (e.g. spawned in Lumbridge or Karamja),
        // teleport directly to the bank area instead of walking the whole map.
        const [bx, bz] = this._bankSpot(player);
        // port: only where nobody sees it (botTeleport); else it walks
        if ((Math.abs(player.x - bx) > 50 || Math.abs(player.z - bz) > 50) && teleportNear(player, bx, bz)) {
            this.cooldown = randInt(2, 4);
            return;
        }

        // port: to its stall (upstream: Varrock West or the road outside it)
        const [lx, lz] = this._stallTile(player);

        if (!isNear(player, lx, lz, 2)) {
            walkTo(player, lx + randInt(-1, 1), lz + randInt(-1, 1));
            return;
        }

       

        this.state = 'idle';
        this.cooldown = randInt(4, 6);
    }

    // ───────────────── RESET ─────────────────

    private resetLoop(): void {
        this.state = 'walk';
        this.cooldown = 0;
        this.bankWait = 0;
        this.request = null;
        this.stuck.reset();
        this.watchdog.reset();
    }

    override reset(): void {
        super.reset();
        // port: the bot switches tasks with a trade open: close it (the human is told), do not leave them hanging
        if (this.trade.active && this.self) this.trade.end(this.self, 'lost');
        this.resetLoop();
        if (this.self) releaseStall(this.self);
        this.stall = null;
    }

    /** port: its stall, claimed at the trade bank nearest it; with none free, Varrock West's last */
    private _stallTile(player: Player): [number, number] {
        this.stall ??= claimNearestStall(player);
        if (this.stall) return this.stall.tile;
        const vwb = TRADE_BANKS[0];
        return vwb.stalls[vwb.stalls.length - 1];
    }

    private _bankSpot(player: Player): [number, number, number] {
        this._stallTile(player);
        return this.stall?.bank.center ?? TRADE_BANKS[0].center;
    }

    // ───────────────── STUCK HANDLER ─────────────────

   private _stuckWalk(player: Player, lx: number, lz: number): void {
        if (!this.stuck.check(player, lx, lz)) {
            walkTo(player, lx, lz);
            return;
        }

        if (this.stuck.desperatelyStuck) {
            teleportNear(player, lx, lz);
            this.stuck.reset();
            return;
        }

        if (openNearbyGate(player, 30)) {
            this.intentCooldown = 3;
            return;
        }

        walkTo(player, player.x + randInt(-10, 10), player.z + randInt(-10, 10));
    }

    isComplete(): boolean {
        return this.finished;
    }

    /** port: the stint is over: everything but coins into the bank (bankedId: notes as their items), notes off */
    private _endStint(player: Player): void {
        const inv = player.getInventory(InvType.INV);
        if (inv) {
            for (let i = 0; i < inv.capacity; i++) {
                const item = inv.get(i);
                if (item && item.id !== Items.COINS) this.depositItemToBank(player, item.id, item.count);
            }
        }
        player.setVar(VarPlayerType.getId('bankcert'), 0);
        this.finished = true;
    }
}
