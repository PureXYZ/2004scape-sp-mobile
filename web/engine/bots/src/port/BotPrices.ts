// port: vendor prices from the item's value (ObjType.cost), upstream's hand-set list sold coal at 700
// (worth 45) and bought anything back at 0.7 of that, refilling its 500M coins after every trade, so a player could
// turn a shop's eye of newt (3 gp) into 210 gp a piece without end. Here a vendor sells at about its category's
// multiple of the value (never below high alch: no profit in alching what it sells) and buys back at most at the
// value, what the game's shops ask (no profit in selling it what a shop sells), with a spread of its own from its name.
// An item the game gives no value (bones, unidentified herbs, quest items: cost unset) keeps upstream's price and is
// never bought back, so it cannot be a profit loop either.
//
// port (the realism work, phase 4: "December 2004 street prices" and "2004 rares at 2004
// prices"): about 45 items have the street price of December 2004 (data/street_prices.json, from the culture track's
// F8: RuneHQ's street prices of 4-18 Dec 2004, Sal's Realm's tips and Q&A; the rares are estimates), and a vendor's ask
// for one is that price ±10 % by the vendor's name (the default spread), still never below high alch; the value
// rule stays for the rest. Natures sell at 15 times their value, gold bars at their high alch (the street was under
// it), F2P armour near its value, as in 2004. The rares (partyhats about 12.5m, santa hats 550k, masks 1m, crackers
// 6m, Easter eggs 400k) come from the table too: one at a time, never noted, never bought back (VendorTask). Buy-backs
// stay at most the item's value, so a street price far above it is no profit loop.
import ObjType from '#/cache/config/ObjType.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import streetJson from '../../data/street_prices.json';

/** a rare (one, at a fixed price) or a market item (no value in the game: upstream's price, never bought back) */
export type PriceCategory = 'resource' | 'equipment' | 'rare' | 'market';

/** what a vendor asks, as a multiple of the item's value (players paid over the odds for raw materials in 2004) */
const SELL_FACTOR: Record<'resource' | 'equipment', number> = { resource: 2.5, equipment: 1.1 };
/** a vendor's buy-back, as a share of its own price (at most the item's value) */
const BUY_SHARE = 0.7;
/** port (phase 4): a vendor's ask is the street price ±this much, by its name (±10 %) */
export const STREET_SPREAD = 0.1;
/** the value rule's spread (±15 % by the vendor's name, as before phase 4) */
const VALUE_SPREAD = 0.15;

interface StreetRow {
    name: string;
    price: number;
    range: string;
    source: string;
    rare?: boolean;
    /** port (the review of phase 4): the least a vendor asks, above what a 274 shop pays for one (priceFloor) */
    floor?: number;
}

const STREET_ROWS = (streetJson as { items: Record<string, StreetRow> }).items;
/** the table by item id (the debugnames looked up once the packs are loaded) */
let streetById: Map<number, StreetRow> | null = null;

function streetTable(): Map<number, StreetRow> {
    if (!streetById) {
        streetById = new Map();
        for (const [debugname, row] of Object.entries(STREET_ROWS)) {
            const id = ObjType.getId(debugname);
            if (id !== -1) streetById.set(id, row);
        }
    }
    return streetById;
}

/** The item's own id: a note's item (a vendor's noted stock is priced as its item). */
function unnoted(id: number): number {
    const obj = ObjType.get(id);
    return obj.certtemplate !== -1 && obj.certlink !== -1 ? obj.certlink : id;
}

/** port (phase 4): the December 2004 street price of item `id` (a note: its item's), or null when the table has none. */
export function streetPrice(id: number): number | null {
    return streetTable().get(unnoted(id))?.price ?? null;
}

/** port (phase 4): one of the table's 2004 rares (partyhats, santa hat, masks, cracker, Easter egg)? */
export function isRare(id: number): boolean {
    return streetTable().get(unnoted(id))?.rare === true;
}

/** port (phase 4): the street table's rows by debugname (for the tests and the humanlike report's E1). */
export function streetRows(): Readonly<Record<string, Readonly<StreetRow>>> {
    return STREET_ROWS;
}

/** The item's value: what the game's shops ask (the item's, for a note). */
export function itemValue(id: number): number {
    return Math.max(1, ObjType.get(unnoted(id)).cost);
}

/**
 * The least a vendor sells for, rounded up to a price people write: high alch + 1 (no profit in alching what it sells).
 * port (the review of phase 4): or a table row's `floor`, above what a 274 shop pays for it (no profit in selling it on:
 * the street's gold bars, 150, sat at the alch floor, 185, and the Dwarven Mine's shop pays 210 for one, 0.7 of the
 * value). The only one: every other row's ask is above any 274 shop's buying price for it (the review's check of the
 * shops' stock and buy multipliers).
 */
export function priceFloor(id: number): number {
    return ceilPrice(Math.max(Math.floor(itemValue(id) * 0.6) + 1, streetTable().get(unnoted(id))?.floor ?? 0));
}

/** Resources (stackable or raw), equipment (wearable), a rare or a market item (the vendor's list says so). */
export function categoryOf(id: number, rare = false, market = false): PriceCategory {
    if (rare) return 'rare';
    if (market) return 'market';
    return ObjType.get(unnoted(id)).wearpos !== -1 ? 'equipment' : 'resource';
}

/**
 * What `vendor` asks for one of item `id`. port (phase 4): an item of the street table, its December 2004 street price
 * ±10 % from the vendor's name; any other, its category's multiple of the value ±15 % from the vendor's name; rounded
 * the way people price, at least high alch + 1. `fixedPrice` for a rare or a market item the table does not have:
 * port (the review of phase 4) a market item's ±10 % from the vendor's name too (every vendor asked the list's 3,000
 * for dragon bones, and bankstanders asked their own list's 2,000: BankstandTask.askFor now asks this).
 */
export function sellPrice(id: number, vendor: string, category: PriceCategory, fixedPrice = 0): number {
    const street = streetPrice(id);
    const roll = seededRandom(nameSeed(vendor, `price:${id}`))();
    if (street !== null) return Math.max(priceFloor(id), roundPrice(street * (1 - STREET_SPREAD + 2 * STREET_SPREAD * roll)));
    if (category === 'rare') return fixedPrice;
    if (category === 'market') return fixedPrice > 0 ? Math.max(priceFloor(id), roundPrice(fixedPrice * (1 - STREET_SPREAD + 2 * STREET_SPREAD * roll))) : fixedPrice;
    const value = itemValue(id);
    return Math.max(priceFloor(id), roundPrice(value * SELL_FACTOR[category] * (1 - VALUE_SPREAD + 2 * VALUE_SPREAD * roll)));
}

/**
 * What a vendor pays for one it buys back: 0.7 of its price, and never more than the item's value (0: it does not buy:
 * a rare, a market item, an item the game gives no value). port (phase 4): rounded down to a price people write (an
 * advert says it, and "31.8k" for 31,849 was not what it paid), so still never above the value.
 */
export function buyPrice(id: number, sell: number, category: PriceCategory = 'resource'): number {
    if (category === 'rare' || category === 'market' || isRare(id) || itemValue(id) <= 1) return 0;
    // (in whole tenths: 45,500 × 0.7 is 31,849.999... in floating point)
    return Math.max(0, floorPrice(Math.min(Math.floor((sell * Math.round(BUY_SHARE * 10)) / 10), itemValue(id))));
}

/** A price as a 2004 player wrote it: 450, 4500, 12.5k, 250k, 1.2m (exact for every price roundPrice gives). */
export function formatGp(n: number): string {
    const one = (x: number): string => String(Math.round(x * 10) / 10);
    if (n >= 1_000_000) return `${one(n / 1_000_000)}m`;
    if (n >= 10_000) return `${one(n / 1000)}k`;
    return String(n);
}

/** How many a vendor holds: thousands of a cheap item, a few of a dear one, one rare. */
export function stockCount(value: number, category: PriceCategory, random: () => number = Math.random): number {
    const between = (a: number, b: number): number => a + Math.floor(random() * (b - a + 1));
    if (category === 'rare') return 1;
    if (category === 'market') return between(100, 1000);
    if (value <= 20) return between(2000, 8000);
    if (value <= 200) return between(500, 2000);
    if (value <= 2000) return between(100, 500);
    if (value <= 20000) return between(10, 100);
    if (value <= 200000) return between(2, 10);
    return 1;
}

/** the step prices are rounded to at `x`: 1s below 100, 5s below 1,000, 50s below 10k, 500s below 100k, 5k below 1m, 100k above (formatGp writes each exactly) */
function priceStep(x: number): number {
    return x < 100 ? 1 : x < 1000 ? 5 : x < 10_000 ? 50 : x < 100_000 ? 500 : x < 1_000_000 ? 5000 : 100_000;
}

/** Rounded the way people price (priceStep). */
function roundPrice(x: number): number {
    const step = priceStep(x);
    return Math.max(1, Math.round(x / step) * step);
}

/** Rounded up to the next price people write (a floor stays a floor). */
function ceilPrice(x: number): number {
    const step = priceStep(x);
    return Math.max(1, Math.ceil(x / step) * step);
}

/** Rounded down to a price people write (a cap stays a cap). */
function floorPrice(x: number): number {
    const step = priceStep(x);
    return Math.floor(x / step) * step;
}
