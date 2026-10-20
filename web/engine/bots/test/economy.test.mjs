#!/usr/bin/env node
// The bots' economy (the realism work, phase 4: looks and economy, track B; "December 2004 street
// prices", "2004 rares at 2004 prices" and the in-character marketplace's vendor adverts): the real 274 world with
// 40 bots (members), its vendors and the economy's modules (test/lib/economy.ts). Checks:
//   table     the street table (data/street_prices.json: the research) has about 45 items and the rares, each a real
//             274 item, every one in the vendors' stock
//   prices    a vendor's ask for a table item is its street price ±10 % (rounded the way people price), the high-alch
//             floor where the street was under it; the value rule for the rest as before; never below high alch (a
//             gold bar above what the Dwarven Mine's shop pays, since the review: a row's floor);
//             buy-backs at most the item's value, none for a rare, a market item or an item the game gives no value;
//             every price and buy-back written exactly ("12.5m" is 12,500,000)
//   rares     one at a time, the item itself (never noted), only from a vendor of real levels (combat 40+ or a total of
//             500+) at a bank with no trade of its own (Varrock West), never bought back; no advert says "noted"
//   banks     a vendor at a bank with a trade of its own (Falador East ores and bars, Draynor willows and axes, Al
//             Kharid hides and leather, Varrock East essence, Edgeville potions and food; Catherby fish, Seers logs and
//             bow strings) sells from it most of the time; at Varrock West anything
//   adverts   every stock item's adverts, for 60 vendors: the word filter leaves them whole, "noted" only for noted bulk,
//             a vendor's own three forms and nickname (the same name, the same lines), the marketplace and the price
//             checks understand every nickname and every advert that starts like a request, and the most common line
//             of 60 vendors' adverts is at most 10 % of them (E2's target)
//   looks     a vendor's advert look is its name's: the same every time, about four in ten coloured (colour 1-11, effect
//             0-2), the rest plain yellow
//   answers   the conversation's price answers are the vendor's ask for its own stock (port/BotAnswers.priceOf) and a
//             street price ±10 % for anyone else; trade talk reads a typed price ("1.5k", "3 for 450")
//
//   node --expose-gc web/engine/bots/test/economy.test.mjs [--seed=N] [--debug]
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const DEBUG = args.debug === 'true';
const out = (s = '') => process.stdout.write(s + '\n');
const t0 = performance.now();

// ---- a deterministic Math.random ----
{
    let s = Number(args.seed ?? 11) >>> 0 || 1;
    Math.random = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---- console: keep the errors, print only ours ----
const consoleErrors = [];
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    const real = console[level].bind(console);
    console[level] = (...a) => {
        const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
        if (level === 'error' && !text.includes('ExperimentalWarning')) consoleErrors.push(text);
        if (DEBUG) real(...a);
    };
}

const checks = [];
function check(name, ok, detail) {
    checks.push({ name, ok: !!ok, detail: ok ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail) });
    return !!ok;
}

const engineDir = prepareEngineClone('economy', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const T = await importTs(path.join(BOTS_DIR, 'test/lib/economy.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, ObjType, WordEnc } = T;
const sim = await T.Sim.create({ bots: 40, members: true, debug: DEBUG });
sim.addHuman(3222, 3218, 0);
for (let i = 0; i < 150; i++) sim.tick();

const stock = T.vendorStock();
const names = T.BOT_NAMES.slice(0, 200);
const vendorNames = T.BOT_NAMES.filter(n => T.plannerOf(n) === 'extras_vendor');
const itemName = item => item.alias ?? ObjType.get(item.itemId).name;
const noted = item => !item.rare && ObjType.get(item.itemId).certlink >= 0 && ObjType.get(item.itemId).certtemplate === -1 && item.itemId !== T.Items.ARROW_SHAFT;
const kindOf = item => (item.rare ? 'rare' : ObjType.get(item.itemId).wearpos !== -1 ? 'gear' : 'bulk');
const highAlch = id => Math.floor(T.itemValue(id) * 0.6);

// ---- the table -------------------------------------------------------------------------------------------------
{
    const all = Object.entries(T.streetRows());
    // (the variety work, round 2, track W2: the status pieces and the Fremennik helms, labelled estimates: priced for the
    // vendors that stock some of them and the price checks, not all of them stocked; counted apart)
    const STATUS_ROW = /_trim$|_gold$|_goldplate$|^rune_\w+_(zamorak|saradomin|guthix)$|^viking_helmet_/;
    const status = all.filter(([d]) => STATUS_ROW.test(d));
    const rows = all.filter(([d]) => !STATUS_ROW.test(d));
    const rares = rows.filter(([, r]) => r.rare);
    const missing = all.filter(([debugname]) => ObjType.getId(debugname) === -1).map(([d]) => d);
    const misnamed = all.filter(([debugname, r]) => ObjType.getId(debugname) !== -1 && !r.name.startsWith(ObjType.get(ObjType.getId(debugname)).name)).map(([d, r]) => `${d}: "${r.name}" is "${ObjType.get(ObjType.getId(d)).name}"`);
    check(`the street table: ${rows.length - rares.length} items and ${rares.length} rares (and ${status.length} status pieces and helms of round 2, estimates), each a 274 item by its name`, rows.length - rares.length >= 40 && rows.length - rares.length <= 50 && rares.length >= 10 && status.length > 0 && status.every(([, r]) => /^estimate/.test(r.source)) && missing.length === 0 && misnamed.length === 0, { missing, misnamed });
    const unsold = rows.filter(([debugname]) => !stock.some(item => item.itemId === ObjType.getId(debugname))).map(([d]) => d);
    check('every street-table item is in the vendors\' stock', unsold.length === 0, unsold);
    check('every row has its source and range', rows.every(([, r]) => r.source && r.range && r.price > 0), rows.filter(([, r]) => !r.source || !r.range).map(([d]) => d));
    const extra = Object.entries(T.EXTRA_ITEMS).filter(([debugname, id]) => ObjType.getId(debugname) !== id).map(([d, id]) => `${d}=${id} is ${ObjType.getId(d)}`);
    check('the vendors\' extra items are the 274 ids of their debugnames', extra.length === 0, extra);
    const bad = stock.filter(item => !ObjType.get(item.itemId)?.name).map(item => item.name);
    check(`every stock item (${stock.length}) is a 274 item`, bad.length === 0, bad);
}

// ---- prices ----------------------------------------------------------------------------------------------------
{
    const outOfSpread = [];
    const belowAlch = [];
    const overValue = [];
    const inexact = [];
    const ratios = new Map();
    for (const item of stock) {
        const category = T.categoryOf(item.itemId, item.rare, item.market);
        const street = T.streetPrice(item.itemId);
        for (const name of names) {
            const price = T.sellPrice(item.itemId, name, category, item.priceEach);
            const buy = noted(item) ? T.buyPrice(item.itemId, price, category) : 0;
            if (street !== null) {
                // ±10 %, give or take its rounding (5s below 1,000, 50s below 10k ...: a step is at most 5 % of the price)
                const floor = T.priceFloor(item.itemId);
                if (price !== floor && (price < street * (1 - T.STREET_SPREAD) * 0.95 || price > street * (1 + T.STREET_SPREAD) * 1.05)) outOfSpread.push(`${item.name} ${price} (street ${street}) by ${name}`);
                if (price !== floor) ratios.set(item.name, [...(ratios.get(item.name) ?? []), price / street]);
            }
            if (price <= highAlch(item.itemId)) belowAlch.push(`${item.name} ${price} (high alch ${highAlch(item.itemId)})`);
            if (buy > T.itemValue(item.itemId)) overValue.push(`${item.name} bought at ${buy} (worth ${T.itemValue(item.itemId)})`);
            if ((item.rare || item.market || T.itemValue(item.itemId) <= 1) && buy !== 0) overValue.push(`${item.name} bought back at ${buy} (rare, market or no value)`);
            for (const n of [price, buy]) if (n > 0 && T.readGp(T.formatGp(n)) !== n) inexact.push(`${n} written ${T.formatGp(n)}`);
        }
    }
    check(`a table item's ask is its street price ±10 % (or its high-alch floor), ${names.length} vendors`, outOfSpread.length === 0, outOfSpread.slice(0, 5));
    const offCentre = [...ratios].filter(([, r]) => r.length >= 50 && Math.abs(r.reduce((a, b) => a + b, 0) / r.length - 1) > 0.03).map(([n, r]) => `${n} ${(r.reduce((a, b) => a + b, 0) / r.length).toFixed(3)}`);
    check('and spread about it (the mean ask of 200 vendors within 3 % of the street price)', offCentre.length === 0, offCentre);
    // (the review of phase 4: and a gold bar above what the Dwarven Mine's shop pays for one, 210: the alch floor, 185, was a
    // profit loop; the table row's floor)
    check(`never below high alch (${stock.length} items, ${names.length} vendors); gold bars at ${T.priceFloor(ObjType.getId('gold_bar'))}, above the Dwarven Mine's 210`, belowAlch.length === 0 && T.priceFloor(ObjType.getId('gold_bar')) > 210, belowAlch.slice(0, 5));
    check('buy-backs at most the item\'s value; none for a rare, a market item or one the game gives no value', overValue.length === 0, overValue.slice(0, 5));
    check('every ask and buy-back is written exactly ("12.5m" is 12,500,000)', inexact.length === 0, [...new Set(inexact)].slice(0, 5));
    // the period's pattern: natures far above their value, F2P armour near it, gold bars at their floor
    const ask = (debugname, name = 'market_mary') => T.sellPrice(ObjType.getId(debugname), name, T.categoryOf(ObjType.getId(debugname)), 0);
    check(`natures at about 300 (${ask('naturerune')}), lobsters about 150 (${ask('lobster')}), a rune scim about 33k (${ask('rune_scimitar')}), a partyhat about 12.5m (${ask('blue_partyhat')}), gold bars at their floor (${ask('gold_bar')})`, Math.abs(ask('naturerune') - 300) <= 35 && Math.abs(ask('lobster') - 150) <= 20 && Math.abs(ask('rune_scimitar') - 33000) <= 4000 && Math.abs(ask('blue_partyhat') - 12_500_000) <= 1_500_000 && ask('gold_bar') === T.priceFloor(ObjType.getId('gold_bar')));
    // the value rule for the rest, as before phase 4 (2.5 × the value for resources, 1.1 × for equipment, ±15 %)
    const valueRule = [];
    for (const item of stock.filter(i => T.streetPrice(i.itemId) === null && !i.rare && !i.market)) {
        const category = T.categoryOf(item.itemId, false, false);
        const factor = category === 'equipment' ? 1.1 : 2.5;
        for (const name of names.slice(0, 50)) {
            const price = T.sellPrice(item.itemId, name, category, item.priceEach);
            const v = T.itemValue(item.itemId) * factor;
            if (price !== T.priceFloor(item.itemId) && (price < v * 0.85 * 0.95 - 1 || price > v * 1.15 * 1.05 + 1)) valueRule.push(`${item.name} ${price} (value rule ${Math.round(v)})`);
        }
    }
    check('the value rule for the rest (2.5 × the value for resources, 1.1 × for equipment, ±15 %)', valueRule.length === 0, valueRule.slice(0, 5));
}

// ---- bankstanders (the integration of phase 4): what a vendor asks, by the bot's name -------------------------------
{
    // (upstream's hand-set list plus 1-150 coins at random sold coal at 651-800 and feathers at 21-170; the list's price,
    // ±15 % by the name, stays only for an item the game gives no value: bones, clay)
    const off = [];
    const listed = [];
    const items = [...new Set(T.viableItemIds)];
    for (const id of items) {
        for (const name of names.slice(0, 20)) {
            const ask = T.BankstandTask.askFor(name, id);
            const obj = ObjType.get(id);
            const base = obj.certtemplate !== -1 && obj.certlink !== -1 ? obj.certlink : id;
            if (T.streetPrice(id) !== null || T.itemValue(id) > 1) {
                if (ask !== T.sellPrice(base, name, T.categoryOf(base)) || ask <= highAlch(id)) off.push(`${obj.debugname} ${ask} by ${name}`);
                if (base !== id && ask !== T.BankstandTask.askFor(name, base)) off.push(`${obj.debugname} noted ${ask}, unnoted ${T.BankstandTask.askFor(name, base)} by ${name}`);
            } else {
                listed.push(id);
                // (the review of phase 4: an item the vendors sell at their list's price, at theirs: one price for it)
                const market = T.vendorStock().find(s => s.itemId === base && s.market === true);
                if (!(ask >= 1) || (market && ask !== T.sellPrice(base, name, 'market', market.priceEach))) off.push(`${obj.debugname} ${ask} by ${name} (no value${market ? `, the vendors' ${T.sellPrice(base, name, 'market', market.priceEach)}` : ''})`);
            }
        }
    }
    const coal = ObjType.getId('coal');
    const feather = ObjType.getId('feather');
    const name = names[0];
    // (and a market item's price spreads ±10 % by the name, as a street price: every vendor asked 3,000 for dragon bones)
    const dbones = ObjType.getId('dragon_bones');
    const dAsks = names.slice(0, 50).map(n => T.sellPrice(dbones, n, 'market', 3000));
    check(`a market item's ask spreads by the vendor's name: dragon bones ${Math.min(...dAsks)}-${Math.max(...dAsks)} (the list's 3,000 ±10 %)`, new Set(dAsks).size >= 5 && dAsks.every(a => a >= 2700 * 0.97 && a <= 3300 * 1.03), dAsks.slice(0, 8));
    check(`bankstanders ask the vendors' price for the same name (${items.length} items × 20 names), above high alch: coal ${T.BankstandTask.askFor(name, coal)}, feathers ${T.BankstandTask.askFor(name, feather)} (${new Set(listed).size} items with no value at the list's price)`, off.length === 0 && Math.abs(T.BankstandTask.askFor(name, coal) - 150) <= 20 && T.BankstandTask.askFor(name, feather) <= 10, off.slice(0, 5));
}

// ---- a vendor's stock: rares, banks ------------------------------------------------------------------------------
const taskOf = p => sim.botPlayer(p)?.currentTask ?? null;
let vendor = null;
for (let i = 0; i < 300 && !vendor; i++) {
    sim.tick();
    vendor = sim.bots().find(p => p.botPlanner === 'extras_vendor' && taskOf(p)?.name === 'Vendor' && taskOf(p).stock);
}
if (check('a vendor bot', vendor, sim.bots().map(p => p.botPlanner).join(','))) {
    const task = taskOf(vendor);
    sim.botPlayer(vendor).tick = () => {}; // (it keeps still: the test restocks it by hand)
    const setLevels = level => {
        for (let stat = 0; stat < vendor.baseLevels.length; stat++) if (stat !== 18 && stat !== 19) vendor.setLevel(stat, stat === 3 ? Math.max(10, level) : level);
    };
    const bankAt = key => T.TRADE_BANKS.find(b => b.key === key);
    const restock = (bankKey, n) => {
        const bank = bankAt(bankKey);
        const picks = [];
        for (let i = 0; i < n; i++) {
            task.stall = { bank, tile: bank.stalls[0] };
            task.handleInit(vendor);
            const pack = new Map();
            const inv = vendor.getInventory(T.InvType.INV);
            for (let s = 0; s < inv.capacity; s++) {
                const it = inv.get(s);
                if (it && it.id !== T.Items.COINS) pack.set(it.id, (pack.get(it.id) ?? 0) + it.count);
            }
            picks.push({ item: task.stock, count: task.itemCount, pack, adverts: [...task.adverts], buyBack: task.buyBack, noted: vendor.botVendorStockNoted });
        }
        return picks;
    };

    // real levels at Varrock West: rares now and then, each one unnoted and alone, no buy-back, no "noted" advert
    setLevels(70);
    check(`a vendor of combat ${vendor.combatLevel} sells rares (rareSeller)`, T.rareSeller(vendor), vendor.combatLevel);
    const rich = restock('varrock_west', 400);
    const rares = rich.filter(p => p.item.rare);
    const wrong = rares.filter(p => p.count !== 1 || p.noted || p.buyBack !== 0 || p.pack.size !== 1 || p.pack.get(p.item.itemId) !== 1 || p.adverts.some(a => /\bnoted\b/.test(a)) || p.adverts.length < 2);
    check(`rares at Varrock West from a vendor of real levels (${rares.length} of 400 restocks), each one item, the item itself (never noted), no buy-back, no "noted" advert`, rares.length >= 5 && wrong.length === 0, wrong.slice(0, 3).map(p => ({ item: p.item.name, count: p.count, noted: p.noted, buy: p.buyBack, pack: [...p.pack], adverts: p.adverts })));
    check(`a rare's adverts: "${rares[0]?.adverts.join('" | "')}"`, rares.length > 0 && rares.every(p => p.adverts.every(a => /\d(\.\d)?m|\d+k/.test(a))), rares.slice(0, 2).map(p => p.adverts));
    // the same vendor at its level 3 (combat 3, total about 30): never a rare
    setLevels(1);
    const poor = restock('varrock_west', 400);
    check(`a vendor of combat ${vendor.combatLevel} never sells a rare (400 restocks at Varrock West)`, !T.rareSeller(vendor) && poor.every(p => !p.item.rare), poor.filter(p => p.item.rare).map(p => p.item.name));
    // a total of 500 without the combat: a skiller's real levels count too
    for (let stat = 0; stat < vendor.baseLevels.length; stat++) if (stat !== 18 && stat !== 19) vendor.setLevel(stat, [0, 1, 2, 4, 6].includes(stat) ? 1 : stat === 3 ? 10 : 40);
    check(`a total of 500+ (combat ${vendor.combatLevel}) is real levels too`, vendor.combatLevel < T.RARE_SELLER_COMBAT && T.rareSeller(vendor), vendor.combatLevel);

    // the banks' own trades: most of the stock from it, never a rare (even from real levels)
    setLevels(70);
    for (const key of T.BANK_TRADE_KEYS) {
        const picks = restock(key, 300);
        const own = picks.filter(p => T.bankTradeWeight(key, p.item.itemId) > 0).length;
        check(`a vendor at ${key} sells from its trade most of the time (${own} of 300: ${[...new Set(picks.filter(p => T.bankTradeWeight(key, p.item.itemId) > 0).map(p => p.item.name))].slice(0, 6).join(', ')}), never a rare`, own >= 165 && picks.every(p => !p.item.rare), { own, rares: picks.filter(p => p.item.rare).length });
    }
    const hub = restock('varrock_west', 300);
    check(`at Varrock West anything (${new Set(hub.map(p => p.item.itemId)).size} items in 300 restocks)`, new Set(hub.map(p => p.item.itemId)).size >= 40);

    // a rare sold: no other this session (the review of phase 4: a "Rich Guy" restocked a rare at once 224 times in 300)
    const blue = T.vendorStock().find(i => i.itemId === T.Items.BLUE_PARTYHAT);
    task._stock(vendor, blue);
    task.tradeMode = 'selling';
    task._afterTrade(vendor, 'done');
    const afterSale = restock('varrock_west', 400);
    check('a vendor that sold its rare stocks no other this session (400 restocks at Varrock West, real levels)', T.rareSeller(vendor) && afterSale.every(p => !p.item.rare), afterSale.filter(p => p.item.rare).map(p => p.item.name));

    // the conversation's price answers: a vendor's for its own stock is its ask
    task.stall = { bank: bankAt('varrock_west'), tile: bankAt('varrock_west').stalls[0] };
    task.handleInit(vendor);
    const said = T.priceOf(task.stock.itemId, vendor);
    check(`the vendor's price answer for its own stock (${task.stockName}) is its ask: "${said}" for ${task.price}`, said === T.formatGp(task.price), { said, price: task.price });
    delete sim.botPlayer(vendor).tick;
}
{
    // (the review of phase 4) a price check of an untradeable item, the veterans' bunny ears and scythe: no price ("like 1")
    const bot = sim.bots()[0];
    const ctx = msg => ({ bot, persona: T.botPersona(bot), asker: null, raw: msg, msg, pick: lines => lines[0] });
    const ears = T.stateAnswer(ctx('how much is bunny ears'));
    const scythe = T.stateAnswer(ctx('pc scythe'));
    check(`a price check of the bunny ears or the scythe gets no price ("${ears?.text}", "${scythe?.text}")`, ears?.id === 'price' && scythe?.id === 'price' && T.ANSWER_LINES.priceUntradeable.includes(ears.text) && T.ANSWER_LINES.priceUntradeable.includes(scythe.text), { ears, scythe });
}
{
    const scim = ObjType.getId('rune_scimitar');
    const answers = names.slice(0, 100).map(n => T.readGp(T.priceOf(scim, { username: n })));
    check(`anyone's answer to "how much is a rune scim" is the street price ±10 % (${Math.min(...answers)}-${Math.max(...answers)})`, answers.every(a => a >= 33000 * 0.88 && a <= 33000 * 1.12), answers.slice(0, 5));
}

// ---- adverts -----------------------------------------------------------------------------------------------------
{
    const sixty = vendorNames.slice(0, 60);
    const masked = [];
    const notedWrong = [];
    const unparsed = [];
    const few = [];
    const forms = new Set();
    const pooled = new Map();
    for (const item of stock) {
        const name = itemName(item);
        const key = T.itemKey(name);
        const category = T.categoryOf(item.itemId, item.rare, item.market);
        for (const vendorName of sixty) {
            const price = T.sellPrice(item.itemId, vendorName, category, item.priceEach);
            const buy = noted(item) ? T.buyPrice(item.itemId, price, category) : 0;
            // (its nickname as VendorTask picks it: the commonest twice as often)
            const nicks = item.nicks ?? [name.toLowerCase()];
            const pool = [nicks[0], ...nicks];
            const nick = pool[T.nameSeed(vendorName, `nick:${item.itemId}`) % pool.length];
            const spec = { nick, price, buyBack: buy, kind: kindOf(item), noted: noted(item), count: item.rare ? 1 : 500, seed: T.nameSeed(vendorName, 'advert-forms'), short: T.nameSeed(vendorName, 'advert-short') % 2 === 0 };
            const lines = T.vendorAdverts(spec);
            if (JSON.stringify(lines) !== JSON.stringify(T.vendorAdverts(spec))) few.push(`${vendorName}: not the same lines twice`);
            if (lines.length < 2) few.push(`${vendorName} ${name}: ${lines.length} lines`);
            for (const line of lines) {
                if (WordEnc.filter(line) !== line) masked.push(`${line} -> ${WordEnc.filter(line)}`);
                if (/\bnoted\b/.test(line) && (spec.kind !== 'bulk' || !spec.noted)) notedWrong.push(line);
                forms.add(line.replace(nick, '{n}').replace(/\d[\d.]*[km]?/g, '#'));
                if (/^(selling|wts|buying)\b/.test(line)) {
                    const request = T.marketRequestOf(line);
                    if (request?.item !== key) unparsed.push(`"${line}" -> ${request?.item ?? 'nothing'} (want ${key})`);
                }
            }
            // (E2's proxy: each vendor says each of its lines as often, one stock each)
            if (T.nameSeed(vendorName, 'proxy-stock') % stock.length === stock.indexOf(item)) for (const line of lines) pooled.set(line, (pooled.get(line) ?? 0) + 1 / lines.length);
        }
    }
    check(`every stock item's adverts for 60 vendors pass the word filter whole`, masked.length === 0, masked.slice(0, 5));
    check('"noted" only in a bulk advert for noted stock (never a rare, never gear)', notedWrong.length === 0, notedWrong.slice(0, 5));
    check('every vendor has at least two adverts for every item, the same ones every time', few.length === 0, few.slice(0, 5));
    check(`adverts that start like a request ("selling", "wts", "buying") name their item to the marketplace`, unparsed.length === 0, unparsed.slice(0, 5));
    check(`the vendors' forms vary (${forms.size} shapes over 60 vendors)`, forms.size >= 12, [...forms].slice(0, 10));
    const total = [...pooled.values()].reduce((a, b) => a + b, 0);
    const top = Math.max(...pooled.values());
    check(`60 vendors with a stock each: their most common advert is ${((100 * top) / total).toFixed(1)} % of their adverts (E2: at most 10 %)`, total > 0 && top / total <= 0.1, [...pooled].sort((a, b) => b[1] - a[1]).slice(0, 3));
    // every nickname: the marketplace and the price checks understand it
    const nickMisses = [];
    for (const item of stock) {
        const key = T.itemKey(itemName(item));
        for (const nick of item.nicks ?? []) {
            const request = T.marketRequestOf(`buying ${nick}`);
            if (request?.item !== key) nickMisses.push(`market "buying ${nick}" -> ${request?.item ?? 'nothing'} (want ${key})`);
            const asked = T.itemFromWords(nick.split(' '));
            // (the masks share their name "Halloween mask": a price check finds one of them, the price is the same)
            if (!asked || (asked.id !== item.itemId && ObjType.get(asked.id).name !== ObjType.get(item.itemId).name)) nickMisses.push(`price check "${nick}" -> ${asked ? ObjType.get(asked.id).name : 'nothing'} (want ${itemName(item)})`);
        }
    }
    check('every nickname a vendor uses is understood by the marketplace ("buying lobs") and the price checks ("pc glory")', nickMisses.length === 0, nickMisses.slice(0, 6));
    check('"anyone selling lobs", "buying nats", "wtb str pots", "selling 300 iron ore 100 ea" name their items', T.marketRequestOf('anyone selling lobs')?.item === 'lobster' && T.marketRequestOf('buying nats')?.item === 'nature rune' && T.marketRequestOf('wtb str pots')?.item === T.itemKey('Strength potion(4)') && T.marketRequestOf('selling 300 iron ore 100 ea')?.item === 'iron ore', ['anyone selling lobs', 'buying nats', 'wtb str pots', 'selling 300 iron ore 100 ea'].map(l => T.marketRequestOf(l)?.item ?? null));
}

// ---- looks: a vendor's advert colour and effect ------------------------------------------------------------------
{
    const styles = vendorNames.map(n => [n, T.vendorStyle(n)]);
    const same = vendorNames.every(n => JSON.stringify(T.vendorStyle(n)) === JSON.stringify(T.vendorStyle(n)));
    const styled = styles.filter(([, s]) => s !== undefined);
    const share = styled.length / styles.length;
    const ranges = styled.every(([, s]) => s.colour >= 1 && s.colour <= 11 && s.effect >= 0 && s.effect <= 2);
    check(`a vendor's advert look is its name's: the same every time, ${(100 * share).toFixed(0)} % of ${styles.length} vendors coloured (about 40 %), colour 1-11 and effect 0-2`, same && share >= 0.3 && share <= 0.5 && ranges, { share, sample: styled.slice(0, 3) });
    const kinds = new Set(styled.map(([, s]) => `${s.colour}:${s.effect}`));
    check(`and they differ (${kinds.size} looks)`, kinds.size >= 10);
}

// ---- trade talk: a typed price -----------------------------------------------------------------------------------
{
    const cases = [['100', 100], ['100 ea', 100], ['1.5k', 1500], ['12m', 12_000_000], ['12.5 mil', 12_500_000], ['3 for 450', 150], ['can u do 140?', 140], ['how much', null], ['lol', null]];
    const wrong = cases.filter(([text, want]) => T.typedPrice(text) !== want).map(([text, want]) => `${text}: ${T.typedPrice(text)} (want ${want})`);
    check('trade talk reads a typed price ("1.5k", "12m", "3 for 450")', wrong.length === 0, wrong);
    const pools = Object.entries(T.TRADE_TALK);
    const dirty = pools.flatMap(([pool, lines]) => lines.map(l => l.replace('{p}', '160')).filter(l => WordEnc.filter(l) !== l).map(l => `${pool}: ${l}`));
    check('trade talk\'s lines pass the word filter whole', dirty.length === 0, dirty);
}

check('no bot errors', T.BotManager.stats().errors === 0, T.BotManager.stats().errors);
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).map(e => e.split('\n')[0]));

out(`economy: ${checks.filter(c => c.ok).length}/${checks.length} checks passed (${stock.length} stock items, ${Object.keys(T.streetRows()).length} street prices), ${World.currentTick} ticks, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
process.exit(checks.every(c => c.ok) ? 0 : 1);
