// port (the variety work, round 2, track W2: fashion WEAR-4 and its R2, "rich bots put
// their best on at the trade hubs and the park"; status gear on about 1 rich bot in 5, vendors at
// estimated prices, new outfits reach saved bots through play): a rich bot's show-off visit. Now and then (every 1.5-3
// hours of play, an owner of a status piece every 40-80 minutes, its first 3-15 minutes into a session) a rich levelling bot (port/BotFashion isRich) near a trade hub
// leaves its plans for one:
//   bank   it walks to the hub's bank; at the booth it puts its best on (port/BotGear dressForHub: its status pieces
//          over the plain ones), and, when a bot vendor there sells a status piece it can wear and pay for (keeping
//          SHOWOFF_RESERVE), takes the coins out
//   buy    to the vendor, and the trade through 274's trade screens: its request (the vendor's VendorTask takes it:
//          port/BotTrade lets a buyer bot's request through, port/BotFashion isBuyingFrom), its coins up, the vendor's
//          note up, both accepts on both screens (port/BotTradeScreen TradeSession on the buyer's side); then the note into
//          its bank, which keeps the piece, and the piece on (dressForHub again)
//   stand  a few minutes at the hub's hang-out (Varrock's square for Varrock West and East, Falador's park for its banks,
//          the bank hall elsewhere: port/BotHangout's HangoutTask as its sub-task, as a bank stop's hang-out, when one may
//          come now: never two in a row), then back to its plans
// Saved bots too: what they buy and put on follows these. Never in the Wilderness, underground or upstairs, never a newbie.
import type Player from '#/engine/entity/Player.js';
import ObjType from '#/cache/config/ObjType.js';
import World from '#/engine/World.js';
import { BotTask, StuckDetector, walkTo, advanceBankWalk, isNear, randInt, bankInvId, InvType, teleportNear, Items } from '#/engine/bot/tasks/BotTaskBase.js';
import { TradeSession, type TradeOutcome } from '#/engine/bot/port/BotTradeScreen.js';
import { vendorAskOf } from '#/engine/bot/tasks/VendorTask.js';
import { HANGOUT_SPOTS, HangoutTask, hangoutsOf } from '#/engine/bot/port/BotHangout.js';
import { registerPlannerHook, eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';
import { isRich, setBuyingFrom, statusPieces } from '#/engine/bot/port/BotFashion.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { armourPieceOf, canWearPiece, SLOT_WEARPOS } from '#/engine/bot/port/BotLooks.js';
import { dressForHub, whereOwned } from '#/engine/bot/port/BotGear.js';
import { weaponKindOf } from '#/engine/bot/port/BotOutfits.js';
import { usableOnThisWorld } from '#/engine/bot/port/BotPkGear.js';
import { coinsOwned } from '#/engine/bot/BotNeeds.js';
import { depositItems, moveItems } from '#/engine/bot/port/BotInventoryCompat.js';
import { usableBanks, type TradeBank } from '#/engine/bot/port/BotTradeSpots.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';

/** play ticks between two show-off visits (1.5-3 hours); a bot that owns a status piece every 40-80 minutes (it has something to show) */
export const SHOWOFF_GAP_TICKS: [number, number] = [9000, 18000];
export const SHOWOFF_OWNER_GAP_TICKS: [number, number] = [4000, 8000];
/** the first visit of a session, this many ticks into it (10-40 minutes; an owner's 3-15: half the sessions are under an hour) */
const SHOWOFF_FIRST_TICKS: [number, number] = [1000, 4000];
const SHOWOFF_OWNER_FIRST_TICKS: [number, number] = [300, 1500];
/** a hub's bank this near (tiles, Chebyshev) */
export const SHOWOFF_RANGE = 120;
/** the coins a buyer keeps after a purchase */
export const SHOWOFF_RESERVE = 10_000;
/** a vendor this near the hub's bank (its stalls and the hub's crowd) */
const VENDOR_RANGE = 20;
/** the walks and the trade: given up after this long */
const WALK_LIMIT_TICKS = 600;
const TRADE_LIMIT_TICKS = 300;

/** the hubs a rich bot shows off at, how often (the 2004 trade hubs: Varrock West most, Falador and its park, Edgeville) */
const HUB_WEIGHT: Readonly<Record<string, number>> = { varrock_west: 3, falador_west: 2, falador_east: 2, edgeville: 1.5, varrock_east: 1, draynor: 0.5, al_kharid: 0.5, catherby: 1, seers: 1, ardougne_south: 1, ardougne_north: 1 };
/** where it stands after the bank (port/BotHangout's spots) */
const HUB_STAND: Readonly<Record<string, string>> = {
    varrock_west: 'varrock_square',
    varrock_east: 'varrock_square',
    falador_west: 'falador_park',
    falador_east: 'falador_park',
    edgeville: 'edgeville_bank',
    draynor: 'draynor_bank',
    al_kharid: 'al_kharid_bank',
    catherby: 'catherby_bank',
    seers: 'seers_bank',
    ardougne_south: 'ardougne_south_bank',
    ardougne_north: 'ardougne_north_bank'
};

/** what the visits did (tests, the humanlike report's L6 detail) */
export const showOffStats = { visits: 0, dressed: 0, tried: 0, bought: 0, coins: 0, items: {} as Record<string, number>, outcomes: {} as Record<string, number> };

/** each bot's next visit (World ticks; a new session is a new Player: its first visit 20-60 minutes in) */
const due = new WeakMap<Player, number>();
/** tests: visits due at once (0) or never (Infinity); null for the game's cadence */
let rateForTest: number | null = null;
export function setShowOffForTest(dueIn: number | null): void {
    rateForTest = dueIn;
}

/** the status pieces a vendor near (x, z) sells now: the vendor, the piece, its ask */
interface Offer {
    vendor: Player;
    itemId: number;
    price: number;
}

/** a bot vendor's status piece within VENDOR_RANGE of the hub's bank, that this bot wants and can pay for (the dearest it can) */
function offerFor(player: Player, bank: TradeBank): Offer | null {
    const defence = player.baseLevels[PlayerStat.DEFENCE];
    const coins = coinsOwned(player);
    const owned = ownedStatusTiers(player);
    let best: Offer | null = null;
    for (const vendor of World.playerLoop.all()) {
        if (vendor === player || vendor.is_bot !== true || vendor.botPlanner !== 'extras_vendor' || vendor.level !== bank.center[2]) continue;
        if (Math.max(Math.abs(vendor.x - bank.center[0]), Math.abs(vendor.z - bank.center[1])) > VENDOR_RANGE) continue;
        if (vendor.botTradeTargetPid !== -1) continue;
        for (const p of statusPieces()) {
            const price = vendorAskOf(vendor, p.id);
            if (price === null) continue;
            const piece = armourPieceOf(p.id);
            if (!piece || !canWearPiece(piece, defence) || !usableOnThisWorld(p.id)) continue;
            if (piece.slot === 'shield' && weaponKindOf(player.username) === '2h') continue;
            if ((owned.get(piece.slot) ?? -1) >= piece.tier) continue;
            if (coins - price < SHOWOFF_RESERVE) continue;
            if (!best || price > best.price) best = { vendor, itemId: p.id, price };
        }
    }
    return best;
}

/** the best status piece's tier the bot owns per slot (worn, carried, banked) */
function ownedStatusTiers(player: Player): Map<string, number> {
    const out = new Map<string, number>();
    for (const p of statusPieces()) {
        if (whereOwned(player, p.id) === null) continue;
        const piece = armourPieceOf(p.id);
        if (piece) out.set(piece.slot, Math.max(out.get(piece.slot) ?? -1, piece.tier));
    }
    return out;
}

/** the item a vendor hands over for a piece: its note (274's bank notes: VendorTask's stock of gear is noted) */
function tradeItemOf(itemId: number): number {
    const obj = ObjType.get(itemId);
    return obj && obj.certtemplate === -1 && obj.certlink >= 0 ? obj.certlink : itemId;
}

/**
 * The planner's hook (port/BotSetPieces registerPlannerHook, beside its hang-outs): a show-off visit for this bot now, or
 * null. A levelling bot that is rich, no newbie, on the surface outside the Wilderness, with no part in a set piece, a
 * hub's bank within SHOWOFF_RANGE, and its visit due.
 */
export function showOffFor(player: Player, previous: string | null): ShowOffTask | null {
    if (player.is_bot !== true || !isLevelling((player.botPlanner ?? '') as PlannerKey) || isNewbie(player) || eventRoleOf(player)) return null;
    // (not right after a hang-out either: the visit ends in one, and two never come in a row, port/BotHangout's gap)
    if (player.level !== 0 || player.z > 6400 || wildernessLevelAt(player.x, player.z) > 0 || previous === 'ShowOff' || previous === 'Hangout') return null;
    const now = World.currentTick;
    let at = due.get(player);
    // (a draw of its own, from the name and the tick, not the world's Math.random, as BotGear's wardrobe trips: a draw at
    // every levelling bot's first pick moved every other bot's dice after it, and the staged tests' worlds with them)
    const draw = seededRandom(nameSeed(player.username, 'show-off') ^ now);
    const between = ([lo, hi]: [number, number]): number => lo + Math.floor(draw() * (hi - lo + 1));
    // (an owner of a status piece has something to show: more often; one without comes to buy, Varrock West's trade most)
    const owner = ownedStatusTiers(player).size > 0;
    if (at === undefined) {
        const first = owner ? SHOWOFF_OWNER_FIRST_TICKS : SHOWOFF_FIRST_TICKS;
        at = rateForTest !== null ? now + rateForTest : now + between(first);
        due.set(player, at);
    }
    if (now < at) return null;
    const gap = owner ? SHOWOFF_OWNER_GAP_TICKS : SHOWOFF_GAP_TICKS;
    due.set(player, now + (rateForTest !== null ? (rateForTest === 0 ? 0 : rateForTest) : between(gap)));
    if (!isRich(player)) return null;
    const banks = usableBanks().filter(b => b.center[2] === 0 && (HUB_WEIGHT[b.key] ?? 0) > 0 && Math.max(Math.abs(b.center[0] - player.x), Math.abs(b.center[1] - player.z)) <= SHOWOFF_RANGE);
    if (!banks.length) return null;
    // (the nearer the likelier, as the hang-outs: weight / (1 + (d / 40)²); a buyer's Varrock West three times as likely again)
    const weights = banks.map(b => (HUB_WEIGHT[b.key] ?? 0) * (!owner && b.hub ? 3 : 1) / (1 + (Math.max(Math.abs(b.center[0] - player.x), Math.abs(b.center[1] - player.z)) / 40) ** 2));
    const total = weights.reduce((a, b) => a + b, 0);
    let x = draw() * total;
    for (let i = 0; i < banks.length; i++) {
        x -= weights[i];
        if (x < 0) return new ShowOffTask(banks[i]);
    }
    return new ShowOffTask(banks[banks.length - 1]);
}

registerPlannerHook((player, previous) => showOffFor(player, previous));

/** A show-off visit (see the header). */
export class ShowOffTask extends BotTask {
    readonly bank: TradeBank;
    private state: 'walk' | 'bank' | 'buy' | 'trade' | 'stow' | 'stand' | 'done' = 'walk';
    private ticks = 0;
    private offer: Offer | null = null;
    private readonly session = new TradeSession();
    private readonly stuck = new StuckDetector(30, 4, 2);
    private counted = false;
    private lastPlayer: Player | null = null;

    constructor(bank: TradeBank) {
        super('ShowOff');
        this.bank = bank;
    }

    shouldRun(player: Player): boolean {
        return this.state !== 'done' && wildernessLevelAt(player.x, player.z) === 0;
    }

    isComplete(_player: Player): boolean {
        return this.state === 'done';
    }

    tick(player: Player): void {
        this.lastPlayer = player;
        if (this.interrupted || this.state === 'done') return;
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        if (!this.counted) {
            this.counted = true;
            showOffStats.visits++;
        }
        this.ticks++;
        const [bx, bz, bl] = this.bank.center;
        if (this.state === 'walk') {
            if (isNear(player, bx, bz, 6, bl)) {
                this.state = 'bank';
                this.ticks = 0;
                return;
            }
            if (this.ticks > WALK_LIMIT_TICKS) return this._end(player);
            if (!this.stuck.check(player, bx, bz)) walkTo(player, bx, bz, bl);
            else if (this.stuck.desperatelyStuck) {
                teleportNear(player, bx, bz, bl);
                this.stuck.reset();
            } else walkTo(player, bx + randInt(-4, 4), bz + randInt(-4, 4), bl);
            return;
        }
        if (this.state === 'bank') {
            // (at the booth: its best on, port/BotGear dressForHub, through advanceBankWalk's dressing)
            const result = advanceBankWalk(player, this.stuck);
            if (result === 'walk') {
                if (this.ticks > WALK_LIMIT_TICKS) this._end(player);
                return;
            }
            dressForHub(player, true);
            if (this.wearsStatus(player)) showOffStats.dressed++;
            this.offer = offerFor(player, this.bank);
            if (this.offer) {
                // the coins for it into the pack
                const bid = bankInvId();
                const bank = bid === -1 ? null : player.getInventory(bid);
                const inv = player.getInventory(InvType.INV);
                const short = this.offer.price - (inv?.getItemCount(Items.COINS) ?? 0);
                if (bank && inv && short > 0) moveItems(bank, inv, Items.COINS, short);
                if ((inv?.getItemCount(Items.COINS) ?? 0) < this.offer.price || (inv?.freeSlotCount ?? 0) < 1) this.offer = null;
            }
            this.state = this.offer ? 'buy' : 'stand';
            this.ticks = 0;
            this.cooldown = randInt(2, 5);
            return;
        }
        if (this.state === 'buy') {
            const offer = this.offer!;
            const v = offer.vendor;
            // (the vendor gone, busy, or its stock changed: no purchase)
            if (!World.getPlayerByUid(v.uid) || v.level !== player.level || vendorAskOf(v, offer.itemId) !== offer.price || v.botTradeTargetPid !== -1 || this.ticks > WALK_LIMIT_TICKS) {
                this.offer = null;
                this.state = 'stand';
                return;
            }
            if (Math.max(Math.abs(v.x - player.x), Math.abs(v.z - player.z)) > 2) {
                if (!player.hasWaypoints()) walkTo(player, v.x, v.z, v.level);
                return;
            }
            showOffStats.tried++;
            setBuyingFrom(player, v.uid);
            this.session.begin(player, v);
            this.state = 'trade';
            this.ticks = 0;
            return;
        }
        if (this.state === 'trade') {
            const offer = this.offer!;
            const get = new Map([[tradeItemOf(offer.itemId), 1]]);
            const give = new Map([[Items.COINS, offer.price]]);
            const outcome: TradeOutcome | null = this.ticks > TRADE_LIMIT_TICKS ? this.session.end(player, 'timeout') : this.session.tick(player, () => ({ line: '', give, get }));
            if (outcome === null) return;
            setBuyingFrom(player, null);
            showOffStats.outcomes[outcome] = (showOffStats.outcomes[outcome] ?? 0) + 1;
            if (outcome === 'done') {
                showOffStats.bought++;
                showOffStats.coins += offer.price;
                const name = ObjType.get(offer.itemId)?.debugname ?? String(offer.itemId);
                showOffStats.items[name] = (showOffStats.items[name] ?? 0) + 1;
                this.state = 'stow';
            } else this.state = 'stand';
            this.ticks = 0;
            this.cooldown = randInt(2, 4);
            return;
        }
        if (this.state === 'stow') {
            // the note into the bank (274's bank keeps the piece), and the piece on
            const result = advanceBankWalk(player, this.stuck);
            if (result === 'walk') {
                if (this.ticks > WALK_LIMIT_TICKS) this.state = 'stand';
                return;
            }
            const bid = bankInvId();
            const bank = bid === -1 ? null : player.getInventory(bid);
            const inv = player.getInventory(InvType.INV);
            if (bank && inv && this.offer) {
                const note = tradeItemOf(this.offer.itemId);
                const n = inv.getItemCount(note);
                // (the variety work, round 2, the fixes: what the bank has room for, the rest kept in the pack: a full bank
                // lost the note, a status piece worth 40k-700k)
                if (n > 0) depositItems(inv, bank, note, n);
            }
            dressForHub(player, true);
            this.state = 'stand';
            this.ticks = 0;
            this.cooldown = randInt(2, 5);
            return;
        }
        if (this.state === 'stand') {
            // a hang-out at the hub's spot as its sub-task (port/BotHabits' bank stops start theirs so: the hang-out's own
            // stand, its spot's tile, its cadence; the reports count it as one); the visit is over
            // (only when a hang-out may come now: port/BotHangout's gap after the last one, as its own; else the visit ends at
            // the bank, its best on, and its plans go on in it)
            const spot = HANGOUT_SPOTS.find(s => s.key === HUB_STAND[this.bank.key]);
            if (player.modalMain !== -1) player.closeModal();
            const ai = (player as unknown as { _bot?: { setSubTask?: (task: BotTask) => void } })._bot;
            const schedule = hangoutsOf(player);
            if (spot && ai?.setSubTask && (!schedule || World.currentTick >= schedule.due)) ai.setSubTask(new HangoutTask(spot));
            this._end(player);
        }
    }

    /** does the bot wear a status piece now? */
    private wearsStatus(player: Player): boolean {
        const worn = player.getInventory(InvType.WORN);
        for (const slot of Object.values(SLOT_WEARPOS)) {
            const it = worn?.get(slot);
            if (it && armourPieceOf(it.id)?.status) return true;
        }
        return false;
    }

    private _end(player: Player): void {
        this.state = 'done';
        setBuyingFrom(player, null);
        if (this.session.active) this.session.end(player, 'lost');
    }

    override interrupt(): void {
        super.interrupt();
        // (a trade under way is ended, the buyer's request withdrawn)
        if (this.lastPlayer) {
            setBuyingFrom(this.lastPlayer, null);
            if (this.session.active) this.session.end(this.lastPlayer, 'lost');
        }
    }

    override reset(): void {
        super.reset();
        if (this.lastPlayer) setBuyingFrom(this.lastPlayer, null);
    }
}
