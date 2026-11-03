/**
 * port (bots ideas, round 1, Track A: the period endgame) drop sales: a bot sells the endgame
 * loot it got in a sale stint at its nearest trade bank (tasks/BankstandTask in its own-drops mode: the trade screens,
 * the street price or the value rule, never below high alch; adverts in the period's forms: "selling rune chain 44k",
 * "wts d med 2.2m").
 *   - The stock is only what the bot itself picked up on its endgame trips (port/BotEndgameFight notes the pack's gains:
 *     rune and dragon pieces, half keys, 10k+ items, dragon bones and hides) and still owns: nothing is conjured, and what
 *     it sells it no longer owns (no profit loop). The registry is the session's (nothing is saved): an unsold drop goes
 *     back to the bank, and a later session keeps it as its own.
 *   - The offer (port/BotD2Picks, after the endgame's): a bot with SALE_MIN of such loot, SALE_SHARE of its picks, at most
 *     once per SALE_GAP of play, for SALE_TICKS.
 */
import type Player from '#/engine/entity/Player.js';
import ObjType from '#/cache/config/ObjType.js';
import World from '#/engine/World.js';
import { owned } from '#/engine/bot/tasks/ErrandTask.js';
import { formatGp, streetPrice, itemValue } from '#/engine/bot/port/BotPrices.js';

/** a bot's loot from its endgame trips this session: name -> item (unnoted) -> count */
const drops = new Map<string, Map<number, number>>();

/** the pack's gain of an endgame loot item on a trip (port/BotEndgameFight) */
export function noteDropGain(p: Player, id: number, n: number): void {
    const t = ObjType.get(id);
    const base = t.certtemplate !== -1 && t.certlink !== -1 ? t.certlink : id;
    const key = p.username.toLowerCase();
    let m = drops.get(key);
    if (!m) drops.set(key, (m = new Map()));
    m.set(base, (m.get(base) ?? 0) + n);
    saleStats.noted[t.debugname ?? String(id)] = (saleStats.noted[t.debugname ?? String(id)] ?? 0) + n;
}

/** the item and its note, carried or banked */
function ownedWithNotes(p: Player, id: number): number {
    const t = ObjType.get(id);
    return owned(p, id) + (t.certtemplate === -1 && t.certlink !== -1 ? owned(p, t.certlink) : 0);
}

/**
 * the loot it still owns of what it got: item -> count (the stock of a sale stint); (round 1 fixes, A3) the record no
 * more than it owns now (a copy it got later, a kit's or a shop's, is no drop of its own)
 */
export function saleStock(p: Player): Map<number, number> {
    const out = new Map<number, number>();
    const m = drops.get(p.username.toLowerCase());
    if (!m) return out;
    for (const [id, n] of m) {
        const have = Math.min(n, ownedWithNotes(p, id));
        if (have > 0) out.set(id, have);
        if (have <= 0) m.delete(id);
        else if (have < n) m.set(id, have);
    }
    return out;
}

/** what the stock is worth (street price, else value) */
export function saleValue(stock: ReadonlyMap<number, number>): number {
    let v = 0;
    for (const [id, n] of stock) v += (streetPrice(id) ?? itemValue(id)) * n;
    return v;
}

/** a stint is offered SALE_SHARE of the picks of a bot with SALE_MIN of loot, at most once per SALE_GAP of play */
export const SALE_SHARE = 0.2;
export const SALE_MIN = 10000;
export const SALE_GAP = 12000;
/** a stint's length (ticks: 10-25 minutes) */
export const SALE_TICKS: readonly [number, number] = [1000, 2500];

/** the sales (the report: EG6; the tests): stints offered, adverts, items sold by name */
export const saleStats = { offered: 0, adverts: 0, sold: {} as Record<string, number>, noted: {} as Record<string, number> };
/** the stints: bot, tick, the stock's value (the report's EG6) */
export const saleLog: { name: string; tick: number; value: number; items: string[] }[] = [];
const lastSale = new Map<string, number>();

/** (tests) the registry and the stats from empty */
export function resetDropSalesForTest(): void {
    drops.clear();
    lastSale.clear();
    saleLog.length = 0;
    saleStats.offered = 0;
    saleStats.adverts = 0;
    for (const k of Object.keys(saleStats.sold)) delete saleStats.sold[k];
    for (const k of Object.keys(saleStats.noted)) delete saleStats.noted[k];
}

/** a sale stint for the bot now? (the stock, the gap, the share) The stock when so, else null */
export function saleDue(p: Player, roll?: number): Map<number, number> | null {
    // (the dice only for a bot with loot to sell: no other bot's picks draw one more number than before)
    const key = p.username.toLowerCase();
    if (!drops.has(key)) return null;
    if (World.currentTick - (lastSale.get(key) ?? -Infinity) < SALE_GAP) return null;
    const stock = saleStock(p);
    if (stock.size === 0 || saleValue(stock) < SALE_MIN) return null;
    if ((roll ?? Math.random()) >= SALE_SHARE) return null;
    lastSale.set(key, World.currentTick);
    saleStats.offered++;
    saleLog.push({ name: p.username, tick: World.currentTick, value: saleValue(stock), items: [...stock.keys()].map(id => ObjType.get(id).debugname ?? String(id)) });
    if (saleLog.length > 2000) saleLog.splice(0, saleLog.length - 2000);
    return stock;
}

/** the period's short names for the drops (an advert's words) */
const SHORT: Readonly<Record<string, string>> = {
    rune_chainbody: 'rune chain',
    rune_med_helm: 'rune med',
    rune_full_helm: 'rune full',
    rune_sq_shield: 'rune sq',
    rune_kiteshield: 'rune kite',
    rune_platelegs: 'rune legs',
    rune_plateskirt: 'rune skirt',
    rune_platebody: 'rune plate',
    rune_scimitar: 'rune scim',
    rune_longsword: 'rune long',
    rune_2h_sword: 'rune 2h',
    rune_battleaxe: 'rune baxe',
    rune_warhammer: 'rune hammer',
    rune_spear: 'rune spear',
    dragon_med_helm: 'd med',
    dragon_chainbody: 'd chain',
    dragon_spear: 'd spear',
    dragon_bones: 'dragon bones',
    dragonhide_blue: 'blue d hide',
    dragonhide_black: 'black d hide',
    dragonhide_red: 'red d hide',
    dragonhide_green: 'green d hide'
};
export function shortName(id: number): string {
    const held = ObjType.get(id);
    const t = held.certtemplate !== -1 && held.certlink !== -1 ? ObjType.get(held.certlink) : held;
    return SHORT[t.debugname ?? ''] ?? (t.name ?? '').toLowerCase();
}

/** an advert of a drop sale in the period's forms; `priceOf` the bot's ask for one */
export function dropAdvert(stock: ReadonlyMap<number, number>, priceOf: (id: number) => number, random: () => number = Math.random): string | null {
    const items = [...stock].filter(([, n]) => n > 0);
    if (items.length === 0) return null;
    const [id, n] = items[Math.floor(random() * items.length)];
    const name = shortName(id);
    const price = formatGp(priceOf(id));
    saleStats.adverts++;
    if (n > 1) {
        const forms = [`selling ${n} ${name} ${price} ea`, `wts ${name} ${price} ea`, `selling ${name} ${price} each`];
        return forms[Math.floor(random() * forms.length)];
    }
    const forms = [`selling ${name} ${price}`, `wts ${name} ${price}`, `${name} for sale ${price}`, `selling ${name} ${price} pm me`];
    return forms[Math.floor(random() * forms.length)];
}

/** a sale made (BankstandTask's own-drops mode, a trade done): what went, (round 1 fixes, A3) off its loot's record */
export function noteSold(p: Player, id: number, n: number): void {
    const t = ObjType.get(id);
    const name = t.debugname ?? String(id);
    saleStats.sold[name] = (saleStats.sold[name] ?? 0) + n;
    const key = p.username.toLowerCase();
    const m = drops.get(key);
    if (!m) return;
    const base = t.certtemplate !== -1 && t.certlink !== -1 ? t.certlink : id;
    const left = (m.get(base) ?? 0) - n;
    if (left > 0) m.set(base, left);
    else m.delete(base);
    if (m.size === 0) drops.delete(key);
}
