/**
 * VendorTask.ts
 *
 * "Extras" personality — vendor bot.
 * Carries a fixed stack (5k–8k) of noted random items to Varrock West Bank,
 * announces what they're selling, and accepts player trades to sell them.
 *
 * port: the trade follows the trade screens (port/BotTradeScreen.TradeSession), not timers: upstream clicked the
 * confirm screen's accept two ticks after the first accept whether or not that screen was open, and walked off
 * mid-trade, so a human slower than ~3 s was left at "Waiting for other player..." until the trade closed. A sale is
 * accepted only while the bot's own offer holds what it sells (upstream accepted with an empty offer when
 * [label,movetotrade] refused the item) and the human's change: upstream kept it. An overpayment of one item's price
 * or more (more than all it has costs) is refused with a message. On a free world the stock is free items.
 *
 * port: vendors (Phase 2). Vendors spread over the 2004 trade banks, one to a stall
 * (port/BotTradeSpots: Varrock West takes the most), and each bank's adverts share a budget of about 10-15 a minute.
 * Prices come from the item's value (port/BotPrices: never below high alch, buy-backs at most what a shop asks), the
 * stock size from the value (thousands of logs, a few dragon items, one partyhat), the line of trade from the vendor's
 * name ("Ore Trader" sells ores), and the adverts use the game's item names and 2004 prices ("12.5k"), without the
 * vendor's own name (the chat shows it) and sometimes in colour. Upstream sold anything at hand-set prices, bought it
 * back at 0.7 of those with 500M coins it refilled after every trade, and had every vendor at Varrock West.
 *
 * port (the realism work, phase 4: looks and economy, track B; "December 2004 street prices", "2004
 * rares at 2004 prices" and the in-character marketplace's vendor adverts):
 *  - Prices: about 45 items at their December 2004 street price ±10 % by the vendor's name (port/BotPrices: natures 15×
 *    their value, F2P armour near it; never below high alch; buy-backs at most the value), the value rule for the rest.
 *  - Rares (partyhats, santa hats, masks, crackers, Easter eggs) at 2004's prices, one at a time and never noted, only
 *    from a vendor of real levels (combat 40+ or a total of 500+: Jagex's 2004 scam guide warned of "a level 3 ...
 *    offering you rare or expensive items"), at a bank with no trade of its own (Varrock West, Falador West, Ardougne);
 *    sold, it is gone (the vendor stocks something else); never bought back. Upstream: 100m each, "noted", from level 3s.
 *  - Stock by trade bank (2004's trade geography: Sal's Realm): Falador East ores and bars, Draynor
 *    willows and axes, Al Kharid hides and leather, Varrock East essence, Edgeville potions and food (members: Catherby
 *    fish, Seers logs and bow strings); Varrock West anything. Then the vendor's name's line of trade, else anything.
 *  - Adverts in the period's forms ("selling lobs 160 ea", "selling nats 280 ea pm me", "wts rune
 *    scim 33k", "buying willows 24 ea"), with 2004's item nicknames (lobs, nats, ess, addy, d med, phat ...), "noted"
 *    only for bulk stock, counts for bulk ("selling 3k coal 150 ea"); each vendor has its own three forms and its own
 *    nickname for an item (from its name), and a buying line for bulk only, where it pays at least half its ask (it pays
 *    at most the value: "buying coal 45 ea" would read as a joke). A vendor's advert look is its own, from its name:
 *    most plain yellow, four in ten always the same colour and effect (cyan:wave:, red: ...). Upstream: three forms
 *    word for word, the game's names, "noted Blue partyhat".
 *  - Trade talk: in a trade, the human's "how much?" gets its price and a lowball ("100 ea?") a "lol no", through the
 *    conversation's composeReply (a trade line: rules, never the language model) and typed at the bot's speed. Trades'
 *    outcomes are unchanged.
 *
 * port (the variety work, round 1, Track S: ISS-5 and P12; a vendor sounded like a loop: three adverts every ~11 s for
 * hours, no break, no price change, no other word):
 *  - its own pace (a log-normal gap around its own median of 10-60 s, from its name) in the bank's turn, and no advert
 *    with nobody to sell to within 15 tiles (sellers do not count: the stall's turn passes);
 *  - breaks: away 1-5 minutes every 15-40 (now and then a "brb" and a "back"), quiet meanwhile;
 *  - its price drifts: 5-10 % off after 20 minutes unsold ("glory 95k"), told once ("price drop!!");
 *  - a second item after 30-60 minutes, or soon after a sale (the stall kept);
 *  - now and then a word of trade talk instead of an advert ("still selling lobs", "anyone??", "last 200"), and an
 *    answer to a neighbouring seller ("mine r cheaper lol").
 *
 * port (2004's sellers mostly ran an auto typer, so adverts may come more often):
 *  - about half the vendors run an auto typer (from the name): one advert of its own, word for word and in its look,
 *    every 8-15 s (its own gap, from its name), on time: it waits only for the bank's next turn, and keeps typing
 *    through a trade; it stops for a break, and its price drop is retyped (the "price drop!!" typed by hand, once);
 *    no trade talk between (the typer says it all);
 *  - the others type by hand, a little faster than before (medians 8-45 s), and the banks allow more adverts (about
 *    12-20 a minute, 25-50 at Varrock West: port/BotTradeSpots).
 */

import ObjType from '#/cache/config/ObjType.js';
import WordEnc from '#/cache/wordenc/WordEnc.js';
import { Items } from '#/engine/bot/BotKnowledge.js';
import { tilesInReach } from '#/engine/bot/BotAction.js';
import {
    BotTask,
    Player,
    InvType,
    walkTo,
    isNear,
    randInt,
    countItem,
    StuckDetector,
    ProgressWatchdog,
    openNearbyGate,
    teleportNear,
} from '#/engine/bot/tasks/BotTaskBase.js';
import World from '#/engine/World.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { botSay } from '#/engine/bot/port/BotSay.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { clearTradeTarget, tradeOffer, TradeSession, type TradeDeal, type TradeOutcome, type TradingTask } from '#/engine/bot/port/BotTradeScreen.js';
import { buyPrice, categoryOf, formatGp, itemValue, sellPrice, stockCount } from '#/engine/bot/port/BotPrices.js';
import { claimVendorStall, releaseStall, stallOf, takeAdvertTurn, TRADE_BANKS, type Stall } from '#/engine/bot/port/BotTradeSpots.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { composeReply, sayTyped } from '#/engine/bot/port/BotChat.js';
import type { ChatStyle } from '#/engine/bot/port/BotSay.js';
import { logNormal } from '#/engine/bot/port/BotTiming.js';
import { freshLine } from '#/engine/bot/port/BotLines.js';

// port: upstream's BUYBACK_RATE (0.7 of its price) is port/BotPrices' buyPrice, at most a shop's price
const STARTING_VENDOR_COINS = 500_000_000;
const NEVER_BUYBACK_ITEMS = new Set<number>([
    Items.ARROW_SHAFT,
]);

interface VendorStock {
    itemId: number;
    name: string;
    /** upstream's price: what a market item (no value in the game, no street price) sells for; 0 for the port's items */
    priceEach: number;
    /** port: the name it goes by where 274's own is ambiguous ("Herb", "Halloween mask", "Broken shield"); the game's name otherwise */
    alias?: string;
    /** port: a rare (partyhats, masks, the santa hat, crackers, Easter eggs): one at a time, unnoted, at its 2004 price */
    rare?: boolean;
    /** port: no value in the game (cost unset: bones, unidentified herbs, quest items): upstream's price, never bought back */
    market?: boolean;
    /** port (phase 4): the names it goes by in a trade, the commonest first ("lobs", "lobsters"): the adverts say them, the marketplace understands them */
    nicks?: readonly string[];
}

/** port (phase 4): 274 items the new stock needs that BotKnowledge's Items has no name for, by debugname (test/economy.test.mjs checks the ids) */
export const EXTRA_ITEMS = {
    strength4: 113,
    wine_of_zamorak: 245,
    christmas_cracker: 962,
    dragon_spear_p: 1263,
    amulet_of_glory: 1704,
    amulet_of_strength: 1725,
    amulet_of_power: 1731,
    easter_egg: 1961
} as const;

/**
 * (the variety work, round 2, track W2: WEAR-4) the status pieces vendors stock: [274 obj id, its name in 274 (test/fashion
 * checks each), the nicknames of 2004]; ids, not names: this table is built at the module's load
 */
export const STATUS_STOCK: ReadonlyArray<[number, string, string[]]> = [
    [2615, 'Rune platebody (g)', ['rune (g) plate', 'rune platebody (g)']],
    [2623, 'Rune platebody (t)', ['rune (t) plate', 'rune platebody (t)']],
    [2617, 'Rune platelegs (g)', ['rune (g) legs', 'rune platelegs (g)']],
    [2629, 'Rune kiteshield (t)', ['rune (t) kite', 'rune kiteshield (t)']],
    [2653, 'Zamorak platebody', ['zammy plate', 'zamorak platebody']],
    [2661, 'Saradomin plate', ['sara plate', 'saradomin plate']],
    [2673, 'Guthix full helm', ['guthix full', 'guthix full helm']],
    [2599, 'Adam platebody (t)', ['addy (t) plate', 'adam platebody (t)']],
    [2607, 'Adam platebody (g)', ['addy (g) plate', 'adam platebody (g)']],
    [2611, 'Adam kiteshield (g)', ['addy (g) kite', 'adam kiteshield (g)']],
    [2583, 'Black platebody (t)', ['black (t) plate', 'black platebody (t)']],
    [2591, 'Black platebody (g)', ['black (g) plate', 'black platebody (g)']],
    [2587, 'Black full helm (t)', ['black (t) full', 'black full helm (t)']],
    // (the pieces a rich bot of 10-60k can pay for: black and adamant (t) and (g))
    [2585, 'Black platelegs (t)', ['black (t) legs', 'black platelegs (t)']],
    [2595, 'Black full helm (g)', ['black (g) full', 'black full helm (g)']],
    [2589, 'Black kiteshield (t)', ['black (t) kite', 'black kiteshield (t)']],
    [2601, 'Adam platelegs (t)', ['addy (t) legs', 'adam platelegs (t)']],
    [2605, 'Adam full helm (t)', ['addy (t) full', 'adam full helm (t)']]
];

const VENDOR_ITEMS: VendorStock[] = [
    // 🔥 High-tier weapons & gear
    // port (phase 4): rune armour and helms with them (Varrock West's trade in 2004); the nicknames 2004 typed
    { itemId: Items.RUNE_SCIMITAR, name: 'Rune scimitar', priceEach: 25000, nicks: ['rune scim', 'rune scimmy', 'rune scimitar'] },
    { itemId: Items.RUNE_2H_SWORD, name: 'Rune 2h sword', priceEach: 40000, nicks: ['rune 2h', 'rune 2h sword'] },
    { itemId: Items.RUNE_LONGSWORD, name: 'Rune longsword', priceEach: 32000, nicks: ['rune long', 'rune longsword'] },
    { itemId: Items.RUNE_KITESHIELD, name: 'Rune kiteshield', priceEach: 35000, nicks: ['rune kite', 'rune kiteshield'] },
    { itemId: Items.RUNE_PLATEBODY, name: 'Rune platebody', priceEach: 0, nicks: ['rune plate', 'rune platebody'] },
    { itemId: Items.RUNE_PLATELEGS, name: 'Rune platelegs', priceEach: 0, nicks: ['rune legs', 'rune platelegs'] },
    { itemId: Items.RUNE_FULL_HELM, name: 'Rune full helm', priceEach: 0, nicks: ['rune full', 'rune full helm'] },
    { itemId: Items.RUNE_MED_HELM, name: 'Rune med helm', priceEach: 0, nicks: ['rune med', 'rune med helm'] },
    { itemId: Items.RUNE_CHAINBODY, name: 'Rune chainbody', priceEach: 0, nicks: ['rune chain', 'rune chainbody'] },

    { itemId: Items.DRAGON_DAGGER, name: 'Dragon dagger', priceEach: 60000, nicks: ['d dagger', 'dragon dagger'] },
    { itemId: Items.DRAGON_MED_HELM, name: 'Dragon med helm', priceEach: 100000, nicks: ['d med', 'dragon med', 'dragon med helm'] },
    { itemId: Items.DRAGON_SQ_SHIELD, name: 'Dragon sq shield', priceEach: 150000, nicks: ['d sq', 'dragon sq', 'dragon sq shield'] },
    { itemId: EXTRA_ITEMS.dragon_spear_p, name: 'Dragon spear(p)', priceEach: 0, nicks: ['d spear(p)', 'dragon spear(p)'] },

    // 🏹 Ranged BIS
    { itemId: Items.MAGIC_SHORTBOW, name: 'Magic shortbow', priceEach: 30000, nicks: ['magic shortbow'] },
    { itemId: Items.MAGIC_LONGBOW, name: 'Magic longbow', priceEach: 25000, nicks: ['magic longbow'] },
    { itemId: Items.RUNE_ARROWHEADS, name: 'Rune arrowheads', priceEach: 400, nicks: ['rune arrowtips'] },
    { itemId: Items.ADAMANT_ARROWHEADS, name: 'Adamant arrowheads', priceEach: 200, nicks: ['addy arrowtips', 'adamant arrowtips'] },

    // 🧙 Magic essentials
    { itemId: Items.DEATH_RUNE, name: 'Death rune', priceEach: 400, nicks: ['deaths', 'death runes'] },
    { itemId: Items.BLOOD_RUNE, name: 'Blood rune', priceEach: 500, nicks: ['bloods', 'blood runes'] },
    { itemId: Items.CHAOS_RUNE, name: 'Chaos rune', priceEach: 120, nicks: ['chaos runes', 'chaos'] },
    { itemId: Items.NATURE_RUNE, name: 'Nature rune', priceEach: 250, nicks: ['nats', 'nature runes'] },
    { itemId: Items.LAW_RUNE, name: 'Law rune', priceEach: 300, nicks: ['laws', 'law runes'] },
    { itemId: Items.COSMIC_RUNE, name: 'Cosmic rune', priceEach: 150, nicks: ['cosmics', 'cosmic runes'] },

    // QUEST ITEMS
    { itemId: Items.ARRAV_SHIELD_LEFT, name: 'Arrav Shield Left', priceEach: 1500, alias: 'Arrav shield left', market: true },
    { itemId: Items.ARRAV_SHIELD_RIGHT, name: 'Arrav Shield Right', priceEach: 1500, alias: 'Arrav shield right', market: true },
    { itemId: Items.PETE_CANDLESTICK, name: 'Petes Candlestick', priceEach: 25000 },
    { itemId: Items.MISC_KEY_HERO, name: 'Miscellaneous Key', priceEach: 25000, market: true },

    // 🧪 Potions (huge utility)
    { itemId: Items.PRAYER_POTION_3, name: 'Prayer potion (3)', priceEach: 8000, nicks: ['pray pots', 'prayer pots', 'prayer potions'] },
    // port (phase 4): strength potions as 2004 sold them, (4)s (upstream's (3)s: the street table has the (4)s)
    { itemId: EXTRA_ITEMS.strength4, name: 'Strength potion (4)', priceEach: 3000, nicks: ['str pots', 'strength pots', 'str potions'] },
    { itemId: Items.ATTACK_POTION_3, name: 'Attack potion (3)', priceEach: 1500, nicks: ['att pots', 'attack pots'] },
    { itemId: Items.ANTIPOISON_POTION_3, name: 'Antipoison (3)', priceEach: 2000, nicks: ['antipoisons', 'antipoison pots'] },
    { itemId: Items.RESTORE_POTION_3, name: 'Restore potion (3)', priceEach: 2500, nicks: ['restore pots', 'restores'] },

    // 🍖 Food meta
    { itemId: Items.RAW_SHARK, name: 'Raw shark', priceEach: 1000, nicks: ['raw sharks', 'raw sharkies'] },
    { itemId: Items.RAW_MANTA_RAY, name: 'Raw manta ray', priceEach: 1200, nicks: ['raw mantas', 'raw manta rays'] },
    { itemId: Items.RAW_SEA_TURTLE, name: 'Raw sea turtle', priceEach: 1100, nicks: ['raw turtles', 'raw sea turtles'] },
    { itemId: Items.SWORDFISH, name: 'Swordfish', priceEach: 400, nicks: ['swordies', 'swordfish'] },
    // port (phase 4): cooked lobsters and sharks (2004's food trade: Edgeville, Catherby)
    { itemId: Items.LOBSTER, name: 'Lobster', priceEach: 0, nicks: ['lobs', 'lobsters', 'lobbies'] },
    { itemId: Items.SHARK, name: 'Shark', priceEach: 0, nicks: ['sharks', 'sharkies'] },

    // ⛏️ Skilling core
    { itemId: Items.RUNE_ESSENCE, name: 'Rune essence', priceEach: 50, nicks: ['ess', 'rune ess', 'rune essence'] },
    { itemId: Items.COAL, name: 'Coal', priceEach: 700, nicks: ['coal'] },
    { itemId: Items.MITHRIL_ORE, name: 'Mithril ore', priceEach: 600, nicks: ['mith ore', 'mithril ore'] },
    { itemId: Items.IRON_ORE, name: 'Iron ore', priceEach: 300, nicks: ['iron ore', 'iron'] },
    // port (phase 4): the other ores and the bars (Falador East's trade in 2004)
    { itemId: Items.COPPER_ORE, name: 'Copper ore', priceEach: 0, nicks: ['copper ore', 'copper'] },
    { itemId: Items.TIN_ORE, name: 'Tin ore', priceEach: 0, nicks: ['tin ore', 'tin'] },
    { itemId: Items.ADAMANTITE_ORE, name: 'Adamantite ore', priceEach: 0, nicks: ['addy ore', 'adamantite ore'] },
    { itemId: Items.RUNITE_ORE, name: 'Runite ore', priceEach: 0, nicks: ['rune ore', 'runite ore'] },
    { itemId: Items.IRON_BAR, name: 'Iron bar', priceEach: 0, nicks: ['iron bars'] },
    { itemId: Items.STEEL_BAR, name: 'Steel bar', priceEach: 0, nicks: ['steel bars'] },
    { itemId: Items.MITHRIL_BAR, name: 'Mithril bar', priceEach: 0, nicks: ['mith bars', 'mithril bars'] },
    { itemId: Items.GOLD_BAR, name: 'Gold bar', priceEach: 0, nicks: ['gold bars'] },
    { itemId: Items.ADAMANTITE_BAR, name: 'Adamantite bar', priceEach: 0, nicks: ['addy bars', 'adamantite bars'] },
    { itemId: Items.RUNITE_BAR, name: 'Runite bar', priceEach: 0, nicks: ['rune bars', 'runite bars'] },

    // 🌲 Logs progression
    { itemId: Items.LOGS, name: 'Logs', priceEach: 100, nicks: ['logs'] },
    { itemId: Items.OAK_LOGS, name: 'Oak logs', priceEach: 150, nicks: ['oaks', 'oak logs'] },
    { itemId: Items.WILLOW_LOGS, name: 'Willow logs', priceEach: 200, nicks: ['willows', 'willow logs'] },
    { itemId: Items.MAPLE_LOGS, name: 'Maple logs', priceEach: 300, nicks: ['maples', 'maple logs'] },
    { itemId: Items.YEW_LOGS, name: 'Yew logs', priceEach: 500, nicks: ['yews', 'yew logs'] },
    { itemId: Items.MAGIC_LOGS, name: 'Magic logs', priceEach: 1000, nicks: ['magics', 'magic logs'] },
    // port (phase 4): axes (Draynor's trade in 2004, with its willows)
    { itemId: Items.IRON_AXE, name: 'Iron axe', priceEach: 0, nicks: ['iron axe'] },
    { itemId: Items.STEEL_AXE, name: 'Steel axe', priceEach: 0, nicks: ['steel axe'] },
    { itemId: Items.MITHRIL_AXE, name: 'Mithril axe', priceEach: 0, nicks: ['mith axe', 'mithril axe'] },
    { itemId: Items.ADAMANT_AXE, name: 'Adamant axe', priceEach: 0, nicks: ['addy axe', 'adamant axe'] },
    { itemId: Items.RUNE_AXE, name: 'Rune axe', priceEach: 0, nicks: ['rune axe'] },
    // port (phase 4): hides and leather (Al Kharid's trade in 2004)
    { itemId: Items.COW_HIDE, name: 'Cow hide', priceEach: 0, nicks: ['cowhides', 'cow hides'] },
    { itemId: Items.LEATHER, name: 'Leather', priceEach: 0, nicks: ['soft leather', 'leather'] },

    // 💎 Crafting / money makers
    { itemId: Items.UNCUT_DIAMOND, name: 'Uncut diamond', priceEach: 2000, nicks: ['uncut diamonds'] },
    { itemId: Items.UNCUT_RUBY, name: 'Uncut ruby', priceEach: 1200, nicks: ['uncut ruby'] },
    { itemId: Items.UNCUT_EMERALD, name: 'Uncut emerald', priceEach: 800, nicks: ['uncut emeralds'] },
    { itemId: Items.UNCUT_SAPPHIRE, name: 'Uncut sapphire', priceEach: 500, nicks: ['uncut sapphires'] },
    { itemId: Items.DRAGONSTONE, name: 'Dragonstone', priceEach: 10000, nicks: ['dragonstones'] },
    // port (phase 4): amulets (2004's: a strength or power amulet with the rune, a glory on members)
    { itemId: EXTRA_ITEMS.amulet_of_strength, name: 'Amulet of strength', priceEach: 0, nicks: ['str ammy', 'amulet of strength'] },
    { itemId: EXTRA_ITEMS.amulet_of_power, name: 'Amulet of power', priceEach: 0, nicks: ['power ammy', 'amulet of power'] },
    { itemId: EXTRA_ITEMS.amulet_of_glory, name: 'Amulet of glory', priceEach: 0, nicks: ['glory', 'amulet of glory'] },

    // 🧪 Herblore secondaries (high demand)
    { itemId: Items.EYE_OF_NEWT, name: 'Eye of newt', priceEach: 300, nicks: ['eye of newt'] },
    { itemId: Items.SNAPE_GRASS, name: 'Snape grass', priceEach: 800, nicks: ['snape grass'] },
    { itemId: Items.LIMPWURT_ROOT, name: 'Limpwurt root', priceEach: 700, nicks: ['limpwurts', 'limpwurt roots'] },
    // (274's name has an apostrophe: "Red spiders' eggs")
    { itemId: Items.RED_SPIDERS_EGGS, name: 'Red spiders eggs', priceEach: 900, alias: 'Red spiders eggs', nicks: ['red spiders eggs'] },
    // port (phase 4): wine of zamorak (members' market, 2004)
    { itemId: EXTRA_ITEMS.wine_of_zamorak, name: 'Wine of zamorak', priceEach: 0, nicks: ['wines of zamorak', 'wine of zamorak'] },

    // 🌿 High-tier herbs
    { itemId: Items.GRIMY_RANARR, name: 'Grimy ranarr', priceEach: 8000, alias: 'Grimy ranarr', market: true, nicks: ['grimy ranarrs', 'grimy ranarr'] },
    { itemId: Items.GRIMY_KWUARM, name: 'Grimy kwuarm', priceEach: 5000, alias: 'Grimy kwuarm', market: true, nicks: ['grimy kwuarms', 'grimy kwuarm'] },
    { itemId: Items.GRIMY_CADANTINE, name: 'Grimy cadantine', priceEach: 6000, alias: 'Grimy cadantine', market: true, nicks: ['grimy cadantines', 'grimy cadantine'] },
    { itemId: Items.GRIMY_TORSTOL, name: 'Grimy torstol', priceEach: 10000, alias: 'Grimy torstol', market: true, nicks: ['grimy torstols', 'grimy torstol'] },

    // 🦴 Prayer training
    { itemId: Items.DRAGON_BONES, name: 'Dragon bones', priceEach: 3000, market: true, nicks: ['dragon bones', 'd bones'] },
    { itemId: Items.BABYDRAGON_BONES, name: 'Babydragon bones', priceEach: 1500, market: true, nicks: ['babydragon bones'] },
    { itemId: Items.BIG_BONES, name: 'Big bones', priceEach: 300, market: true, nicks: ['big bones'] },

    // 🧵 Fletching essentials
    { itemId: Items.BOW_STRING, name: 'Bow string', priceEach: 200, nicks: ['bow strings', 'bowstrings'] },
    { itemId: Items.ARROW_SHAFT, name: 'Arrow shaft', priceEach: 20, nicks: ['arrow shafts'] },
    // port (phase 4): feathers (a street price of 5-10 in 2004)
    { itemId: Items.FEATHER, name: 'Feather', priceEach: 0, nicks: ['feathers'] },

    // 🛡️ Mid-tier gear (progression)
    { itemId: Items.ADAMANT_PLATEBODY, name: 'Adamant platebody', priceEach: 40000, nicks: ['addy plate', 'addy platebody', 'adamant platebody'] },
    { itemId: Items.MITHRIL_PLATEBODY, name: 'Mithril platebody', priceEach: 20000, nicks: ['mith plate', 'mithril platebody'] },
    { itemId: Items.BLACK_PLATEBODY, name: 'Black platebody', priceEach: 10000, nicks: ['black plate', 'black platebody'] },

    { itemId: Items.ADAMANT_SCIMITAR, name: 'Adamant scimitar', priceEach: 12000, nicks: ['addy scim', 'adamant scimitar'] },
    { itemId: Items.MITHRIL_SCIMITAR, name: 'Mithril scimitar', priceEach: 6000, nicks: ['mith scim', 'mithril scimitar'] },

    // port (the variety work, round 2, track W2: WEAR-4, status gear; "vendors at estimated prices"): Treasure
    // Trail trims and god armour, Varrock's rich trade of late 2004; priced by data/street_prices.json's
    // labelled estimates (port/BotPrices). A rich bot buys one on a show-off visit (port/BotShowOff)
    ...STATUS_STOCK.map(([itemId, name, nicks]) => ({ itemId, name, priceEach: 0, nicks })),

    // 🎯 Extra economy fillers (useful bulk items)
    { itemId: Items.CAKE, name: 'Cake', priceEach: 100, nicks: ['cakes'] },

    // 🧪 Supplies
    { itemId: Items.VIAL_OF_WATER, name: 'Vial of water', priceEach: 50, nicks: ['vials of water'] },

    // port: Soft clay was here (Items.SOFT_CLAY is not an item in 274: the vendor stocked nothing)
    { itemId: Items.BUCKET_OF_WATER, name: 'Bucket of water', priceEach: 50, nicks: ['buckets of water'] },
    { itemId: Items.JUG_OF_WATER, name: 'Jug of water', priceEach: 50, nicks: ['jugs of water'] },
    // port (phase 4): the rares at 2004's prices (port/BotPrices' street table: upstream's 100m is gone), one at a time
    { itemId: Items.BLUE_PARTYHAT, name: 'Blue Partyhat', priceEach: 100000000, rare: true, nicks: ['blue phat', 'blue partyhat'] },
    { itemId: Items.RED_PARTYHAT, name: 'Red Partyhat', priceEach: 100000000, rare: true, nicks: ['red phat', 'red partyhat'] },
    { itemId: Items.WHITE_PARTYHAT, name: 'White Partyhat', priceEach: 100000000, rare: true, nicks: ['white phat', 'white partyhat'] },
    { itemId: Items.PURPLE_PARTYHAT, name: 'Purple Partyhat', priceEach: 100000000, rare: true, nicks: ['purple phat', 'purple partyhat'] },
    { itemId: Items.GREEN_PARTYHAT, name: 'Green Partyhat', priceEach: 100000000, rare: true, nicks: ['green phat', 'green partyhat'] },
    // port: a second White Partyhat here (it came up twice as often as the others)
    { itemId: Items.YELLOW_PARTYHAT, name: 'Yellow Partyhat', priceEach: 100000000, rare: true, nicks: ['yellow phat', 'yellow partyhat'] },
    { itemId: Items.RED_HALLOWEEN_MASK, name: 'Red Halloween Mask', priceEach: 100000000, alias: 'Red halloween mask', rare: true, nicks: ['red hween mask', 'red hween', 'red halloween mask'] },
    { itemId: Items.BLUE_HALLOWEEN_MASK, name: 'Blue Halloween Mask', priceEach: 100000000, alias: 'Blue halloween mask', rare: true, nicks: ['blue hween mask', 'blue hween', 'blue halloween mask'] },
    { itemId: Items.GREEN_HALLOWEEN_MASK, name: 'Green Halloween Mask', priceEach: 100000000, alias: 'Green halloween mask', rare: true, nicks: ['green hween mask', 'green hween', 'green halloween mask'] },
    { itemId: Items.SANTA_HAT, name: 'Santa Hat', priceEach: 100000000, rare: true, nicks: ['santa', 'santa hat'] },
    { itemId: EXTRA_ITEMS.christmas_cracker, name: 'Christmas cracker', priceEach: 0, rare: true, nicks: ['cracker', 'xmas cracker', 'christmas cracker'] },
    { itemId: EXTRA_ITEMS.easter_egg, name: 'Easter egg', priceEach: 0, rare: true, nicks: ['easter egg'] }
];

// port: upstream's fixed stall positions outside Varrock West Bank are among port/BotTradeSpots' Varrock West stalls

// ── Adverts (the realism work, phase 4) ─────────────────────────────────────────────────────────────────────────────

/**
 * port (phase 4): the advert forms of 2004 ("selling lobs 160 ea", "selling nats 280 ea pm me", "wts
 * rune scim 33k", "buying coal 140 ea trade me"): {n} the item's nickname, {p} its price, {c} how many (bulk), {b} what
 * the vendor pays for one. Bulk stock (a stack of a resource) sells "ea", says how many and "noted" (only the forms
 * marked so); gear (equipment, one or several) and a rare are priced alone; a buying line only for bulk the vendor buys.
 */
export const ADVERT_FORMS = {
    bulk: ['selling {n} {p} ea', 'selling {n} {p} ea pm me', '{n} {p} ea, trade me', 'wts {n} {p} ea', 'selling {c} {n} {p} ea', 'selling noted {n} {p} each', 'cheap {n} {p} ea', '{n} for sale {p} ea', 'selling {n} {p} each, trade me'],
    gear: ['selling {n} {p}', 'selling {n} {p} pm me', '{n} {p}, trade me', 'wts {n} {p}', 'selling {n} {p} ea', 'cheap {n} {p}', '{n} for sale {p}', 'selling {n} only {p}'],
    rare: ['selling {n} {p}', 'wts {n} {p}', '{n} for sale {p}', 'selling {n} {p} trade me', 'selling {n} {p} pm me'],
    buy: ['buying {n} {b} ea', 'buying {n} {b} ea, trade me', 'buying noted {n} {b} ea']
} as const;

/** how many selling forms a vendor uses (its own, from its name: a 2004 seller repeated its own line) */
const FORMS_PER_VENDOR = 3;
/** a vendor advertises buying back only where it pays at least this share of its ask (it pays at most the value) */
const BUY_ADVERT_SHARE = 0.5;

export type AdvertKind = 'bulk' | 'gear' | 'rare';

export interface AdvertSpec {
    /** the name it goes by ("lobs", "rune scim", "blue phat") */
    nick: string;
    price: number;
    /** what it pays for one it buys back (0: it buys none) */
    buyBack: number;
    kind: AdvertKind;
    /** its stock is noted (said only in a bulk form made for it) */
    noted: boolean;
    /** how many it holds */
    count: number;
    /** the vendor's own forms (its name's seed: FORMS_PER_VENDOR of the kind's forms and one buying form); every form when absent */
    seed?: number;
    /** writes 1500 as "1.5k" (a vendor's habit) */
    short?: boolean;
}

/** a price as the vendor writes it: formatGp, and "1.5k" for a round thousand-something when it writes so */
function priceText(n: number, short: boolean): string {
    return short && n >= 1000 && n < 10_000 && n % 100 === 0 ? `${n / 1000}k` : formatGp(n);
}

/** how many it says it sells: "3k", "500", "40" */
function countText(n: number): string {
    return n >= 1000 ? `${Math.floor(n / 1000)}k` : n >= 100 ? String(Math.floor(n / 100) * 100) : String(n);
}

/** the first `count` of `list` in an order from `seed` (the same seed, the same pick) */
function seededPick<T>(list: readonly T[], seed: number, count: number): T[] {
    const roll = seededRandom(seed);
    const order = list.map(item => ({ item, key: roll() }));
    order.sort((a, b) => a.key - b.key);
    return order.slice(0, count).map(o => o.item);
}

/**
 * port (phase 4): a vendor's adverts for its stock, each in the first price form the word filter leaves whole ("33k",
 * "for 33k", "33000", "for 33000": the filter reads digits as letters across words); a form none of whose price forms
 * passes is left out.
 */
export function vendorAdverts(spec: AdvertSpec): string[] {
    const fits = (form: string): boolean => (spec.kind === 'bulk' ? (!form.includes('noted') || spec.noted) && (!form.includes('{c}') || spec.count >= 20) : true);
    const selling = ADVERT_FORMS[spec.kind].filter(fits);
    // (bulk only: a vendor buys gear back noted, and "noted" is said of bulk alone; its trade's greeting says it buys)
    const buying = spec.kind === 'bulk' && spec.buyBack > 0 && spec.buyBack >= spec.price * BUY_ADVERT_SHARE ? ADVERT_FORMS.buy.filter(form => !form.includes('noted') || spec.noted) : [];
    const forms = spec.seed === undefined ? [...selling, ...buying] : [...seededPick(selling, spec.seed, FORMS_PER_VENDOR), ...seededPick(buying, spec.seed + 1, 1)];
    const short = spec.short === true;
    const lines: string[] = [];
    for (const form of forms) {
        const amount = form.includes('{b}') ? spec.buyBack : spec.price;
        const prices = [priceText(amount, short), `for ${priceText(amount, short)}`, String(amount), `for ${amount}`];
        const line = prices
            .map(p => form.replace('{n}', spec.nick).replace('{c}', countText(spec.count)).replace('{p}', p).replace('{b}', p))
            .find(l => WordEnc.filter(l) === l);
        if (line !== undefined && !lines.includes(line)) lines.push(line);
    }
    return lines;
}

/** port (phase 4): a vendor's advert look: most plain yellow; four in ten always the same colour and effect, from its name */
const STYLED_SHARE = 0.4;
/** colour (1 red, 2 green, 3 cyan, 4 purple, 5 white, 6-8 flash1-3, 9-11 glow1-3) and its weight; effect (0 none, 1 wave, 2 scroll) */
const SIGNATURE_COLOURS: readonly [number, number][] = [[1, 5], [2, 3], [3, 5], [4, 2], [5, 2], [6, 3], [7, 1], [8, 1], [9, 3], [10, 1], [11, 1]];
const SIGNATURE_EFFECTS: readonly [number, number][] = [[0, 45], [1, 40], [2, 15]];

function weighted(list: readonly [number, number][], roll: number): number {
    let x = roll * list.reduce((sum, [, w]) => sum + w, 0);
    for (const [value, w] of list) {
        x -= w;
        if (x < 0) return value;
    }
    return list[list.length - 1][0];
}

/** port (phase 4): the vendor's advert look (the same for the same name): undefined for plain yellow */
export function vendorStyle(name: string): ChatStyle | undefined {
    const roll = seededRandom(nameSeed(name, 'advert-style'));
    if (roll() >= STYLED_SHARE) return undefined;
    return { colour: weighted(SIGNATURE_COLOURS, roll()), effect: weighted(SIGNATURE_EFFECTS, roll()) };
}

/** port (phase 4): the nickname a vendor calls an item by (its own, from its name; the commonest one most often) */
function nickFor(vendor: string, item: VendorStock, name: string): string {
    const nicks = item.nicks ?? [];
    if (nicks.length === 0) return name.toLowerCase();
    const pool = [nicks[0], ...nicks];
    return pool[nameSeed(vendor, `nick:${item.itemId}`) % pool.length];
}

/** port: the stock vendors pick from (for the tests) */
export function vendorStock(): readonly { itemId: number; name: string; alias?: string; rare?: boolean; market?: boolean; priceEach: number; nicks?: readonly string[] }[] {
    return VENDOR_ITEMS;
}

/** port: the names vendors go by where the game's own name is ambiguous (the marketplace takes requests by them) */
export const VENDOR_ALIASES: readonly string[] = VENDOR_ITEMS.filter(item => item.alias !== undefined).map(item => item.alias!);

/** a nickname or name as a request's words are compared: lower case, letters and digits, single spaces */
function nickKey(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
let nickIndex: Map<string, VendorStock> | null = null;

/**
 * port (phase 4): the item a vendor nickname names ("lobs", "glory", "str pots", "d spear(p)"): its id and its name in
 * the trade (its alias or the game's name), or null. The marketplace's request parser and the conversation's price
 * checks read the adverts' words with it.
 */
export function itemByNickname(text: string): { id: number; name: string } | null {
    if (!nickIndex) {
        nickIndex = new Map();
        for (const item of VENDOR_ITEMS) for (const nick of item.nicks ?? []) if (!nickIndex.has(nickKey(nick))) nickIndex.set(nickKey(nick), item);
    }
    const item = nickIndex.get(nickKey(text));
    return item ? { id: item.itemId, name: item.alias ?? ObjType.get(item.itemId)?.name ?? item.name } : null;
}

/**
 * port: a vendor's line of trade, from its name: "Ore Trader" sells ores, "Logs4sale" logs, "Gem Dealer" gems; a name
 * that says nothing gets any item. Upstream picked any item for any vendor ("Bar Merchant: Selling Death rune").
 * port (phase 4): the new stock in its lines (bars for a smith, axes for a woodsman, amulets for a jeweller, hides and
 * leather for a crafter).
 */
const THEMES: [RegExp, (item: VendorStock) => boolean][] = [
    [/ore|mine|miner|rock|coal/i, item => /ore$|coal|essence/i.test(item.name)],
    [/log|wood|tree|chop/i, item => /logs$| axe$/i.test(item.name)],
    [/gem|jewel/i, item => /uncut|dragonstone|amulet/i.test(item.name)],
    [/fish|lobster|shark|cook|food/i, item => /raw |swordfish|lobster|shark|cake/i.test(item.name)],
    [/herb|pot|brew/i, item => /grimy|potion|antipoison|newt|snape|limpwurt|spiders|wine/i.test(item.name)],
    [/rune|mage|magic|wiz/i, item => / rune$/i.test(item.name)],
    [/bone|pray/i, item => /bones$|prayer/i.test(item.name)],
    [/bow|arrow|fletch|range/i, item => /bow|arrow|string|shaft|feather/i.test(item.name)],
    [/plate|armou?r|smith|scim|blade|sword|weapon|bar|metal/i, item => /scimitar|platebody|platelegs|chainbody|sword|kiteshield|dagger|helm|shield| bar$/i.test(item.name)],
    [/craft|leather|hide|tan/i, item => /hide$|^leather$/i.test(item.name)],
    [/party|rare|rich|hat/i, item => item.rare === true]
];

/**
 * port (phase 4): what a trade bank's vendors sell first (2004's trade geography: Sal's Realm's "World 1 Trading",
 * the research), each item's weight: Falador East ores and bars, Draynor willows and axes, Al Kharid hides and
 * leather, Varrock East essence, Edgeville potions and food; on a members world Catherby fish and Seers' logs and bow
 * strings. Varrock West (the hub), Falador West and Ardougne have no trade of their own: anything, rares too.
 */
const BANK_TRADES: Record<string, (item: VendorStock) => number> = {
    falador_east: item => (/^(coal|iron ore|mithril ore)$/i.test(item.name) ? 2 : /ore$| bar$/i.test(item.name) ? 1 : 0),
    draynor: item => (/^willow logs$/i.test(item.name) ? 5 : /^(logs|oak logs)$/i.test(item.name) ? 1 : / axe$/i.test(item.name) ? 1 : 0),
    al_kharid: item => (/^(cow hide|leather)$/i.test(item.name) ? 1 : 0),
    varrock_east: item => (/^rune essence$/i.test(item.name) ? 1 : 0),
    edgeville: item => (/^(lobster|swordfish|strength potion|prayer potion)/i.test(item.name) ? 2 : /^(shark|cake|attack potion|antipoison|restore potion)/i.test(item.name) ? 1 : 0),
    catherby: item => (/^(lobster|swordfish|shark)$/i.test(item.name) ? 2 : /^raw /i.test(item.name) ? 1 : 0),
    seers: item => (/^(yew logs|maple logs)$/i.test(item.name) ? 2 : /^(magic logs|bow string)$/i.test(item.name) ? 1 : 0)
};
/** how often a vendor at a bank with a trade of its own sells from it (else its name's line, or anything) */
const BANK_TRADE_SHARE = 0.65;

/** port (phase 4): the banks whose vendors have a trade of their own (for the tests) */
export const BANK_TRADE_KEYS: readonly string[] = Object.keys(BANK_TRADES);

/** port (phase 4): an item's weight in a bank's own trade (0: not its trade, or a bank with none; for the tests) */
export function bankTradeWeight(bank: string, itemId: number): number {
    const item = VENDOR_ITEMS.find(i => i.itemId === itemId);
    return item && BANK_TRADES[bank] ? BANK_TRADES[bank](item) : 0;
}

/** port (phase 4): a vendor may sell a rare only with real levels (combat 40+ or a total of 500+) */
export const RARE_SELLER_COMBAT = 40;
export const RARE_SELLER_TOTAL = 500;

/** the total level as players see it (stats 18 and 19 are not skills in 274) */
function totalLevel(player: Player): number {
    let total = 0;
    player.baseLevels.forEach((level, stat) => {
        if (stat !== 18 && stat !== 19) total += level;
    });
    return total;
}

/** port (phase 4): may this vendor sell a rare? (its levels: Jagex's 2004 scam guide warned of a level 3 selling rares) */
export function rareSeller(player: Player): boolean {
    return player.combatLevel >= RARE_SELLER_COMBAT || totalLevel(player) >= RARE_SELLER_TOTAL;
}

/**
 * port (the review of phase 4): the vendors that sold their rare this session (the Player is the session's): they stock
 * no other. A rare is one, not a supply; a vendor whose name is in the rare line ("Rich Guy 99", "Blue Phat 7") took
 * another rare at once 224 times in 300, the partyhat it had just sold 23 times.
 */
const soldRare = new WeakSet<Player>();

/**
 * port (phase 4): trade talk. In a trade the human's chat reaches the vendor (BotChat gives it the trade partner's
 * lines): its price to "how much", "lol no" to a lowball, "k" to a fair offer, and its buy-back to a seller asking more.
 * {p} its price (what it pays, in sellHigh). Each through the filter (test/chat-filter.test.mjs).
 */
export const TRADE_TALK = {
    price: ['{p} ea', 'its {p} ea', '{p} each', '{p} ea m8'],
    priceOne: ['{p}', 'its {p}', '{p} for it'],
    lowball: ['lol no', 'no lol', 'lol no, {p} ea', 'lol no way', 'lol no, its {p} ea'],
    lowballOne: ['lol no', 'no lol', 'lol no, {p}', 'lol no way', 'lol no, its {p}'],
    firm: ['{p} ea, no less', 'cant go lower, {p} ea', 'nope, {p} ea', '{p} ea sry'],
    firmOne: ['{p}, no less', 'cant go lower than {p}', 'nope, {p}', '{p} sry'],
    cheaper: ['no lol', 'its cheap already', 'nope', 'no', 'lol no'],
    deal: ['k put the coins up', 'k', 'ok trade', 'deal'],
    sellHigh: ['lol no, {p} ea', 'too much, i pay {p} ea', 'i pay {p} ea', 'no lol, {p} ea']
} as const;
/** an offer below this share of the ask is a lowball ("lol no"); between it and the ask, a firm "no less" */
const LOWBALL_SHARE = 0.75;

/**
 * port (phase 4): a price a player typed ("150", "150 ea", "1.5k", "12m", "12.5 mil"), or for several ("3 for 450":
 * 150 each), in gp; null when there is none.
 */
export function typedPrice(text: string): number | null {
    const amount = (n: string, unit: string | undefined): number => Number(n) * (unit === 'k' ? 1000 : unit === 'm' || unit === 'mil' ? 1_000_000 : 1);
    const lower = text.toLowerCase();
    const per = lower.match(/\b(\d+)\s+for\s+(\d+(?:\.\d+)?)\s*(k|m|mil|gp)?\b/);
    if (per && Number(per[1]) > 0) {
        const each = amount(per[2], per[3]) / Number(per[1]);
        return Number.isFinite(each) && each > 0 ? Math.floor(each) : null;
    }
    const m = lower.match(/\b(\d+(?:\.\d+)?)\s*(k|m|mil|gp)?\b/);
    if (!m) return null;
    const n = amount(m[1], m[2]);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// ── (the variety work, round 1, Track S: ISS-5, P12) a seller's pace, breaks, price and talk ─────────────────────────

/** a seller's median gap between adverts (ticks): its own, from its name, 8-45 s (port, 2026-10-18: was 10-60 s) */
const ADVERT_MEDIAN: [number, number] = [13, 75];
/** the share of vendors with an auto typer, and its gap (ticks: 8-15 s, its own from its name) */
const AUTO_TYPER_SHARE = 0.5;
const AUTO_TYPER_GAP: [number, number] = [13, 25];
/** the spread of its gaps (log-normal σ: a coefficient of variation about 0.8) */
const ADVERT_SIGMA = 0.7;
/** a seller with nobody to sell to looks again this long after */
const NOBODY_RECHECK: [number, number] = [20, 50];
/** within this many tiles a player may buy (sellers do not count) */
const BUYER_DISTANCE = 15;
/** a break: away this long (1-5 minutes), every so long (15-40 minutes); a "brb" first and a "back" after, this often */
const BREAK_LENGTH: [number, number] = [100, 500];
const BREAK_EVERY: [number, number] = [1500, 4000];
const BREAK_SAY = 0.25;
const BACK_SAY = 0.2;
/** unsold this long, it asks 5-10 % less, once */
const PRICE_DROP_TICKS = 2000;
const PRICE_DROP: [number, number] = [0.05, 0.1];
/** a second item after 30-60 minutes; after a sale, within 2-6 */
const NEXT_ITEM: [number, number] = [3000, 6000];
const NEXT_ITEM_AFTER_SALE: [number, number] = [200, 600];
/** a word of trade talk instead of an advert this often; an answer to a neighbour's advert (within 6 tiles, in the last 30 ticks) this often */
const PATTER_SHARE = 0.12;
const RIVAL_SHARE = 0.06;
const RIVAL_DISTANCE = 6;
const RIVAL_TICKS = 30;

/** a seller's words besides its adverts ({n} its item, {p} its price, {c} how many): 2004's market talk */
export const VENDOR_PATTER = {
    still: ['still selling {n}', '{n} still for sale', 'still got {n}', 'anyone want {n}?', 'anyone??', 'anyone need {n}', '{n} anyone?', 'selling {n}, anyone?'],
    bulk: ['last {c} {n}', 'got {c} {n} left', 'bulk {n} cheap'],
    drop: ['price drop!! {n} {p}', '{n} now {p}', 'lowered {n} to {p}', '{n} {p}, cheaper now'],
    rival: ['mine r cheaper', 'lol mine r cheaper', 'buy mine lol', 'mine r better', 'dont buy his lol', 'cheaper here']
} as const;
/** a seller's break and return (said with kind brb) */
export const VENDOR_BREAK = { brb: ['brb', 'brb 2 min', 'afk 1 sec', 'brb food', 'afk', 'brb dont go anywhere'], back: ['back', 'bk', 'back, still selling', 're', 'back lol'] } as const;

/** (variety round 1) the tick each seller last advertised (a neighbour's answer: "mine r cheaper") */
const lastAdvert = new WeakMap<Player, number>();
/** (variety round 1, S8) each vendor's item and its ask now (the marketplace's answer quotes it: BotChat) */
const asks = new WeakMap<Player, { itemId: number; price: number }>();

/** (variety round 1, S8) what this vendor asks now for the item `itemId` (its base item: not the note), or null when it sells other */
export function vendorAskOf(bot: Player, itemId: number): number | null {
    const ask = asks.get(bot);
    return ask && ask.itemId === itemId ? ask.price : null;
}

/** a seller's own median gap (ticks), from its name */
function advertMedian(name: string): number {
    return ADVERT_MEDIAN[0] + ((nameSeed(name, 'advert-gap') % 1000) / 1000) * (ADVERT_MEDIAN[1] - ADVERT_MEDIAN[0]);
}
/** (variety round 1, for the bankstanders too) the next advert's gap: log-normal around the seller's own median, 5 s at least */
export function advertGapOf(name: string): number {
    return Math.max(8, Math.round(logNormal(advertMedian(name), ADVERT_SIGMA)));
}

/** a vendor's auto typer: its gap in ticks (the same every time, from its name), or null: it types by hand */
export function autoTyperGapOf(name: string): number | null {
    const roll = seededRandom(nameSeed(name, 'auto-typer'));
    if (roll() >= AUTO_TYPER_SHARE) return null;
    return AUTO_TYPER_GAP[0] + Math.floor(roll() * (AUTO_TYPER_GAP[1] - AUTO_TYPER_GAP[0] + 1));
}

/** a seller: a vendor, a bot at a stall (a bankstander) */
function isSeller(p: Player): boolean {
    return p.botPlanner === 'extras_vendor' || (p.is_bot === true && stallOf(p) !== null);
}
/** (variety round 1, also the bankstanders') a player within 15 tiles who is no seller: someone to sell to */
export function buyerNear(seller: Player): boolean {
    for (const p of World.playerLoop.all()) {
        if (p === seller || p.level !== seller.level || isSeller(p)) continue;
        if (Math.abs(p.x - seller.x) <= BUYER_DISTANCE && Math.abs(p.z - seller.z) <= BUYER_DISTANCE) return true;
    }
    return false;
}
/** a neighbouring seller advertised lately (within 6 tiles, in the last 30 ticks) */
function rivalAdvertised(seller: Player, now: number): boolean {
    for (const p of World.playerLoop.all()) {
        if (p === seller || p.level !== seller.level || Math.abs(p.x - seller.x) > RIVAL_DISTANCE || Math.abs(p.z - seller.z) > RIVAL_DISTANCE) continue;
        const at = lastAdvert.get(p);
        if (at !== undefined && now - at <= RIVAL_TICKS) return true;
    }
    return false;
}
/** a price a little lower, round as a seller writes it (95k, 9.5k, 140) */
function droppedPrice(price: number, off: number): number {
    const p = price * (1 - off);
    const step = p >= 10_000 ? 1000 : p >= 1000 ? 100 : p >= 100 ? 5 : 1;
    return Math.max(1, Math.min(price - 1, Math.round(p / step) * step));
}

export class VendorTask extends BotTask implements TradingTask {
    private state: 'init' | 'walk' | 'idle' | 'trade' | 'return_home' = 'init';

    private stock: VendorStock | null = null;
    private itemCount = 0;
    private stockMax = 0;       // original stocked amount — never decremented
    private assignedSpot: [number, number] | null = null; // deterministic stall position
    private tradeReturnSpot: [number, number] | null = null;
    /** port: its stall (port/BotTradeSpots), the stock's name as it says it, and its prices (port/BotPrices) */
    private stall: Stall | null = null;
    private stockName = '';
    private price = 0;
    private buyBack = 0;
    private adverts: string[] = [];
    /** port (phase 4): its advert look (its own, from its name: undefined for plain yellow) */
    private style: ChatStyle | undefined = undefined;
    /** (2026-10-18) its auto typer's gap (ticks; null: it types by hand) and the advert it repeats */
    private typerGap: number | null = null;
    private typerLine: string | null = null;

    // port: the trade with a human (screens, deal, timing) and which way it goes
    private readonly trade = new TradeSession();
    private tradeMode: 'selling' | 'buying' | null = null;
    /** The bot this task last ran for: reset() closes a trade still open when the bot switches tasks. */
    private self: Player | null = null;

    private duration = 3600; // ticks before restocking
    // (variety round 1, S8: its pace, breaks, price drift and next item, in world ticks)
    private stockedAt = -1;
    private nextItemAt = Infinity;
    private advertDue = -1;
    private nextBreakAt = -1;
    private breakUntil = -1;
    private dropped = false;
    private soldSinceStock = false;
    private nick = '';
    private kind: AdvertKind = 'bulk';
    /** (variety round 1, S8) the next stocking is its second item (another one) */
    private restocking = false;
    private readonly stuck = new StuckDetector(10, 2, 1);
    private readonly watchdog = new ProgressWatchdog();

    constructor() {
        super('Vendor');
    }

    shouldRun(): boolean {
        return true;
    }

    tick(player: Player): void {
        if (this.interrupted) return;
        this.self = player;

        // port: not while trading (the watchdog teleports the bot away; a slow human takes minutes)
        if (this.watchdog.check(player, this.state === 'trade')) {
            player.clearWaypoints();
            player.clearPendingAction();
            this.interrupt();
            return;
        }

        // Incoming trade request — handle it regardless of current idle state.
        // port: at once (upstream waited out the idle cooldown first, up to 12 s after "One moment please")
        if (player.botTradeTargetPid !== -1 && this.state !== 'trade') {
            this.cooldown = 0;
            this._beginTrade(player);
        }
        // (2026-10-18: an auto typer types on through a trade, on time)
        if (this.state === 'trade' && this.typerGap !== null) this._autoType(player, World.currentTick);

        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }

        // port: never mid-trade (it put the task back to 'init' with the trade window open)
        // (variety round 1, S8: a second item after 30-60 minutes of the world's time, or soon after a sale; it counted
        // the ticks off its idle turns, which came every 12-20, so a vendor kept its item for nine hours)
        if (this.state === 'idle' && World.currentTick >= this.nextItemAt) {
            this.state = 'init';
            this.nextItemAt = Infinity;
            this.restocking = true;
        }

        switch (this.state) {
            case 'init':         return this.handleInit(player);
            case 'walk':         return this.handleWalk(player);
            case 'idle':         return this.handleIdle(player);
            case 'trade':        return this.handleTrade(player);
            case 'return_home':   return this.handleReturnHome(player);
        }
    }

    isComplete(): boolean {
        return false;
    }

    /** port: a trade request (port/BotTrade): taken unless there is nothing to sell yet. */
    tradeRefusal(): string | null {
        if (!this.stock || this.state === 'init') {
            return Math.random() < 0.5 ? 'Restocking, one sec!' : 'Just restocking, trade me in a moment';
        }
        return null;
    }

    override reset(): void {
        super.reset();
        // port: the bot switches tasks with a trade open: close it (the human is told), do not leave them hanging
        if (this.trade.active && this.self) this.trade.end(this.self, 'lost');
        this.state = 'init';
        this.stock = null;
        this.itemCount = 0;
        this.stockMax = 0;
        this.duration = 3600;
        this.stockedAt = -1;
        this.nextItemAt = Infinity;
        this.advertDue = -1;
        this.nextBreakAt = -1;
        this.breakUntil = -1;
        this.tradeMode = null;
        this.assignedSpot = null;
        this.tradeReturnSpot = null;
        // port: its stall is free for another (its task ended, or it logs out)
        if (this.self) releaseStall(this.self);
        this.stall = null;
        this.stuck.reset();
        this.watchdog.reset();
    }

    // ── States ────────────────────────────────────────────────────────────────

    private handleInit(player: Player): void {
        // Clear any previous stock from inventory.
        const inv = player.getInventory(InvType.INV);
        if (inv) {
            for (let slot = 0; slot < inv.capacity; slot++) {
                const item = inv.get(slot);
                if (!item) continue;
                if (item.id === Items.COINS) continue;
                inv.remove(item.id, item.count);
            }
        }

        // Top up coins to 500M so the vendor always has buying power.
        // port: kept (supply unlimited, no purse); its buy-backs are at most a shop's price now
        if (inv) {
            const existingCoins = countItem(player, Items.COINS);
            if (existingCoins < STARTING_VENDOR_COINS) {
                inv.add(Items.COINS, STARTING_VENDOR_COINS - existingCoins);
            }
        }

        // (variety round 1, S8: its second item is another one, where another fits; a first stocking as before)
        const before = this.restocking ? this.stock : null;
        this.restocking = false;
        let picked = this._pickStock(player);
        for (let i = 0; i < 3 && before && picked.itemId === before.itemId; i++) picked = this._pickStock(player);
        this._stock(player, picked);
        this.state = 'walk';
        this.cooldown = randInt(2, 4);
    }

    /**
     * port (phase 4): what it sells next. Its stall first (claimed now: its bank's trade decides the stock); then, at a
     * bank with a trade of its own, that trade BANK_TRADE_SHARE of the time; else its name's line of trade 70 % of the
     * time (as before); else anything. On a free world only free items ([label,movetotrade] refuses a members object
     * there, and the bot took the coins for an empty offer; about a third of the list is members-only); a rare only from
     * a vendor of real levels, at a bank with no trade of its own, and none after it sold one this session (soldRare).
     */
    private _pickStock(player: Player): VendorStock {
        this.stall ??= claimVendorStall(player);
        const trade = this.stall ? BANK_TRADES[this.stall.bank.key] : undefined;
        const rares = trade === undefined && rareSeller(player) && !soldRare.has(player);
        const members = isMembersWorld();
        const choices = VENDOR_ITEMS.filter(item => (members || (!ObjType.get(item.itemId).members && !ObjType.get(this._tradeItemId(item)).members)) && (!item.rare || rares));
        if (trade) {
            const weights = choices.map(trade);
            const total = weights.reduce((a, b) => a + b, 0);
            if (total > 0 && Math.random() < BANK_TRADE_SHARE) {
                let x = Math.random() * total;
                for (let i = 0; i < choices.length; i++) {
                    x -= weights[i];
                    if (x < 0) return choices[i];
                }
            }
        }
        // port: mostly from its line of trade, when its name has one
        const theme = THEMES.find(([name]) => name.test(player.displayName));
        const themed = theme ? choices.filter(theme[1]) : [];
        const pool = themed.length > 0 && Math.random() < 0.7 ? themed : choices;
        return pool[Math.floor(Math.random() * pool.length)];
    }

    /** port (phase 4): stocks `picked`: its prices, its count (one rare, unnoted), its adverts and their look. */
    private _stock(player: Player, picked: VendorStock): void {
        const pickedTradeId = this._tradeItemId(picked);
        const pickedObj = ObjType.get(pickedTradeId);
        this.stock = picked;
        const category = categoryOf(picked.itemId, picked.rare, picked.market);
        this.price = sellPrice(picked.itemId, player.username, category, picked.priceEach);
        this.buyBack = this._isNotedStock(picked) ? buyPrice(picked.itemId, this.price, category) : 0;
        this.stockName = picked.alias ?? ObjType.get(picked.itemId).name ?? picked.name;
        this.itemCount = picked.rare ? 1 : pickedObj?.stackable ? stockCount(itemValue(picked.itemId), category) : 1;
        this.stockMax = this.itemCount;
        const kind: AdvertKind = picked.rare ? 'rare' : ObjType.get(picked.itemId).wearpos !== -1 ? 'gear' : 'bulk';
        this.adverts = vendorAdverts({
            nick: nickFor(player.username, picked, this.stockName),
            price: this.price,
            buyBack: this.buyBack,
            kind,
            noted: this._isNotedStock(picked),
            count: this.itemCount,
            seed: nameSeed(player.username, 'advert-forms'),
            short: nameSeed(player.username, 'advert-short') % 2 === 0
        });
        this.style = vendorStyle(player.username);
        this.typerGap = autoTyperGapOf(player.username);
        this.typerLine = this._typerLineOf(player);
        // (variety round 1, S8: its stocking's time, its ask, its next item)
        const now = World.currentTick;
        this.nick = nickFor(player.username, picked, this.stockName);
        this.kind = kind;
        this.stockedAt = now;
        this.dropped = false;
        this.soldSinceStock = false;
        this.nextItemAt = now + randInt(NEXT_ITEM[0], NEXT_ITEM[1]);
        if (this.nextBreakAt < 0) this.nextBreakAt = now + randInt(BREAK_EVERY[0], BREAK_EVERY[1]);
        asks.set(player, { itemId: picked.itemId, price: this.price });
        player.botVendorStockItemId = pickedTradeId;
        player.botVendorStockName = this.stockName;
        player.botVendorStockNoted = this._isNotedStock(picked);

        const inv = player.getInventory(InvType.INV);
        if (inv) {
            inv.add(pickedTradeId, this.itemCount);
        }

        console.log(`[VendorTask] ${player.displayName} stocking ${this.itemCount}x ${this._stockOfferName(picked)} at ${this.price}gp (buys at ${this.buyBack})`);
    }

    private handleWalk(player: Player): void {
        // Resolve (once) the deterministic stall position for this bot.
        // port: a stall of its own at a trade bank (port/BotTradeSpots), past them a tile of its own in Varrock West's
        // crowd; with no bank usable at all, by Varrock West's last stalls
        if (!this.assignedSpot) {
            this.stall = claimVendorStall(player);
            const vwb = TRADE_BANKS[0];
            this.assignedSpot = this.stall?.tile ?? vwb.stalls[vwb.stalls.length - 1 - (player.uid & 3)];
        }
        const [lx, lz] = this.assignedSpot;

        // Teleport if wildly far away.
        // port: only where nobody sees it (botTeleport); else it walks
        if ((Math.abs(player.x - lx) > 80 || Math.abs(player.z - lz) > 80) && teleportNear(player, lx, lz)) {
            this.cooldown = randInt(2, 3);
            return;
        }

        // (a crowd tile: onto it, its neighbours' are taken)
        if (this.stall?.crowd ? !isNear(player, lx, lz, 0) : !atStall(player, lx, lz)) {
            this._stuckWalk(player, lx, lz);
            this.cooldown = 1;
            return;
        }

        this.state = 'idle';
        this.cooldown = randInt(4, 8);
    }

    private handleIdle(player: Player): void {
        if (!this.stock || this.itemCount <= 0) {
            this.state = 'init';
            return;
        }

        // (variety round 1, S8: away a while now and then, quiet and still: a "brb" first and a "back" after, sometimes)
        const now = World.currentTick;
        if (this.breakUntil >= 0) {
            if (now < this.breakUntil) {
                this.watchdog.notifyActivity();
                this.cooldown = randInt(10, 20);
                return;
            }
            this.breakUntil = -1;
            this.nextBreakAt = now + randInt(BREAK_EVERY[0], BREAK_EVERY[1]);
            const back = Math.random() < BACK_SAY ? freshLine(player, VENDOR_BREAK.back) : null;
            if (back !== null) botSay(player, back, undefined, 'brb');
            this.advertDue = now + randInt(5, 20);
        } else if (this.nextBreakAt >= 0 && now >= this.nextBreakAt) {
            this.breakUntil = now + randInt(BREAK_LENGTH[0], BREAK_LENGTH[1]);
            const brb = Math.random() < BREAK_SAY ? freshLine(player, VENDOR_BREAK.brb) : null;
            if (brb !== null) botSay(player, brb, undefined, 'brb');
            this.watchdog.notifyActivity();
            this.cooldown = randInt(5, 10);
            return;
        }

        // Drift slightly around the assigned stall — max ±1 tile so bots stay spread out.
        // port: not in a crowd (its neighbours' tiles): back onto its own tile if it is off it
        if (this.stall?.crowd && this.assignedSpot) {
            const [sx, sz] = this.assignedSpot;
            if ((player.x !== sx || player.z !== sz) && !player.hasWaypoints()) walkTo(player, sx, sz);
        } else if (Math.random() < 0.2 && this.assignedSpot) {
            const [sx, sz] = this.assignedSpot;
            const near = tilesInReach(player.level, sx, sz, 1);
            const k = near[randInt(0, near.length - 1)];
            walkTo(player, k >> 14, k & 0x3fff);
        }

        // Announce stock, always including the bot's name so players know who is selling.
        // port: without its name (the chat shows who says it: by design), in the bank's turn (about 10-15
        // adverts a minute at a bank: port/BotTradeSpots), the game's item names and 2004 prices, sometimes in colour.
        // No "12x" or "@" (the word filter starred an advert's item around them: "Swordfi*********p ea")
        // port (phase 4): its own forms and nicknames, in its own look (vendorAdverts, vendorStyle)
        this.watchdog.notifyActivity();
        // (variety round 1, S8: unsold for 20 minutes, a little cheaper, once)
        if (!this.dropped && !this.soldSinceStock && this.stockedAt >= 0 && now - this.stockedAt >= PRICE_DROP_TICKS && !this.stock.rare) this._dropPrice(player);
        // (its own pace; with nobody to sell to, the stall's turn passes)
        if (now < this.advertDue) {
            this.cooldown = Math.max(1, Math.min(randInt(3, 6), this.advertDue - now));
            return;
        }
        // (2026-10-18: an auto typer with a line to type; one without, by hand)
        if (this.typerGap !== null && this.typerLine !== null) {
            this._autoType(player, now);
            this.cooldown = Math.max(1, Math.min(randInt(3, 6), this.advertDue - now));
            return;
        }
        if (!buyerNear(player)) {
            this.advertDue = now + randInt(NOBODY_RECHECK[0], NOBODY_RECHECK[1]);
            this.cooldown = randInt(3, 6);
            return;
        }
        if (this.stall && !takeAdvertTurn(this.stall.bank, now)) {
            this.cooldown = randInt(3, 6);
            return;
        }
        const line = this._advertLine(player, now);
        if (line) {
            botSay(player, line, this.style, 'trade');
            lastAdvert.set(player, now);
        }
        this.advertDue = now + advertGapOf(player.username);
        this.cooldown = randInt(3, 6);
    }

    /**
     * (2026-10-18) the auto typer, when its advert is due: said in the bank's next turn (it tries every tick till then),
     * its next one a gap after this one was due (on time, whenever it got its turn; one missed by a whole gap or more is
     * skipped); with nobody near to sell to it says nothing, and keeps its time
     */
    private _autoType(player: Player, now: number): void {
        if (this.typerGap === null || this.typerLine === null || now < this.advertDue) return;
        if (buyerNear(player)) {
            if (this.stall && !takeAdvertTurn(this.stall.bank, now)) return;
            botSay(player, this.typerLine, this.style, 'trade');
            lastAdvert.set(player, now);
        }
        this.advertDue = this.advertDue < 0 || now - this.advertDue >= this.typerGap ? now + this.typerGap : this.advertDue + this.typerGap;
    }

    /** (2026-10-18) the advert an auto typer repeats: one of its adverts (from its name), as its stock and price are now */
    private _typerLineOf(player: Player): string | null {
        if (this.typerGap === null || this.adverts.length === 0) return null;
        return this.adverts[nameSeed(player.username, 'typer-line') % this.adverts.length];
    }

    /** (variety round 1, S8) its next advert: one of its own, now and then a word of trade talk or an answer to a neighbour */
    private _advertLine(player: Player, now: number): string | null {
        const roll = Math.random();
        const fill = (t: string): string => t.replace('{n}', this.nick).replace('{p}', formatGp(this.price)).replace('{c}', String(this.itemCount >= 1000 ? `${Math.floor(this.itemCount / 1000)}k` : this.itemCount >= 100 ? Math.floor(this.itemCount / 100) * 100 : this.itemCount));
        const clean = (t: string): string | null => (WordEnc.filter(t) === t ? t : null);
        if (roll < RIVAL_SHARE && rivalAdvertised(player, now)) return clean(VENDOR_PATTER.rival[randInt(0, VENDOR_PATTER.rival.length - 1)]);
        if (roll < RIVAL_SHARE + PATTER_SHARE) {
            const pool: readonly string[] = this.kind === 'bulk' && this.itemCount >= 20 && Math.random() < 0.3 ? VENDOR_PATTER.bulk : VENDOR_PATTER.still;
            const said = clean(fill(pool[randInt(0, pool.length - 1)]));
            if (said) return said;
        }
        return this.adverts.length > 0 ? this.adverts[Math.floor(Math.random() * this.adverts.length)] : null;
    }

    /** (variety round 1, S8) 5-10 % off, its adverts redone at the new price, and told once ("price drop!! glory 95k") */
    private _dropPrice(player: Player): void {
        if (!this.stock) return;
        this.dropped = true;
        const price = droppedPrice(this.price, PRICE_DROP[0] + Math.random() * (PRICE_DROP[1] - PRICE_DROP[0]));
        if (price >= this.price) return;
        this.price = price;
        asks.set(player, { itemId: this.stock.itemId, price });
        this.adverts = vendorAdverts({
            nick: this.nick,
            price,
            buyBack: this.buyBack,
            kind: this.kind,
            noted: this._isNotedStock(this.stock),
            count: this.itemCount,
            seed: nameSeed(player.username, 'advert-forms'),
            short: nameSeed(player.username, 'advert-short') % 2 === 0
        });
        const told = VENDOR_PATTER.drop[randInt(0, VENDOR_PATTER.drop.length - 1)].replace('{n}', this.nick).replace('{p}', formatGp(price));
        // (2026-10-18: an auto typer's line retyped at the new price, the drop told by hand once)
        if (this.typerGap !== null) {
            this.typerLine = this._typerLineOf(player);
            if (WordEnc.filter(told) === told) botSay(player, told, undefined, 'trade');
            return;
        }
        if (WordEnc.filter(told) === told) this.adverts = [told, ...this.adverts];
    }

    private handleReturnHome(player: Player): void {
        if (!this.tradeReturnSpot) {
            this.state = this.itemCount > 0 ? 'idle' : 'init';
            return;
        }

        const [tx, tz] = this.tradeReturnSpot;
        if (player.x === tx && player.z === tz) {
            this.tradeReturnSpot = null;
            player.botComeHereReturnX = -1;
            player.botComeHereReturnZ = -1;
            this.state = this.itemCount > 0 ? 'idle' : 'init';
            this.cooldown = randInt(2, 4);
            return;
        }

        this._stuckWalk(player, tx, tz);
        this.cooldown = 1;
    }

    // port: the trade, screen by screen (port/BotTradeScreen.TradeSession); upstream's trade_init, trade_offer,
    // trade_confirm and trade_finalize states clicked on timers.
    private _beginTrade(player: Player): void {
        const target = World.getPlayerByUid(player.botTradeTargetPid);
        if (!target || !this.stock || target.level !== player.level || Math.max(Math.abs(target.x - player.x), Math.abs(target.z - player.z)) > 15) {
            console.log('[VendorTask] Trade reset: no target');
            clearTradeTarget(player);
            return;
        }
        if (this.state !== 'return_home' || !this.tradeReturnSpot) {
            this.tradeReturnSpot = player.botComeHereReturnX !== -1 && player.botComeHereReturnZ !== -1
                ? [player.botComeHereReturnX, player.botComeHereReturnZ]
                : [player.x, player.z];
        }
        this.tradeMode = null;
        this.state = 'trade';
        this.trade.begin(player, target);
        this.watchdog.notifyActivity();
    }

    private handleTrade(player: Player): void {
        // port (phase 4): what the human says meanwhile (BotChat passes it its trade partner's lines)
        const said = player.botTradeTargetChatMessage;
        if (said) {
            player.botTradeTargetChatMessage = '';
            this.trade.touch();
            const partner = World.getPlayerByUid(this.trade.partnerUid);
            if (partner) this._tradeTalk(player, partner, said);
        }
        const outcome = this.trade.tick(
            player,
            (_partner, offer) => this._deal(player, offer),
            partner => {
                const stock = this.stock;
                if (!stock) return;
                const buysNotes = this.buyBack > 0;
                const buybackText = buysNotes ? ` Also buying noted ${this.stockName} for ${this.buyBack}gp ea.` : '';
                const tradePrompt = buysNotes ? 'Put up coins to buy, or noted items to sell!' : 'Put up coins to buy!';
                // (a rare: the one it has)
                botSay(player, stock.rare ? `Hi ${partner.displayName}! Selling my ${this.stockName} for ${this.price}gp. ${tradePrompt}` : `Hi ${partner.displayName}! Selling ${this.stockName} for ${this.price}gp ea.${buybackText} ${tradePrompt}`);
            }
        );
        if (outcome !== null) this._afterTrade(player, outcome);
    }

    /**
     * port (phase 4): its answer to the human's line in a trade: its price to "how much", "lol no" to a lowball (under
     * three quarters of its ask), a firm "no less" to a near miss, "k" to its price or more, its buy-back to a seller
     * asking more; nothing to anything else. A trade line (composeReply keeps it as the rules made it), typed.
     */
    private _tradeTalk(player: Player, partner: Player, said: string): void {
        if (!this.stock) return;
        const text = said.toLowerCase();
        const one = this.stock.rare === true || this.itemCount <= 1;
        // (a bare small number is a count, "3 pls", not an offer of 3 gp)
        const typed = typedPrice(text);
        const offered = typed !== null && (typed >= this.price * 0.05 || /\d\s*(k|m|mil|gp)\b|\b(ea|each|gp)\b/.test(text)) ? typed : null;
        let pool: readonly string[] | null = null;
        let id = 'price';
        if (this.tradeMode === 'buying') {
            if (offered !== null && this.buyBack > 0 && offered > this.buyBack) {
                pool = TRADE_TALK.sellHigh;
                id = 'lowball';
            }
        } else if (offered !== null) {
            if (offered >= this.price) {
                pool = TRADE_TALK.deal;
                id = 'deal';
            } else {
                pool = offered < this.price * LOWBALL_SHARE ? (one ? TRADE_TALK.lowballOne : TRADE_TALK.lowball) : one ? TRADE_TALK.firmOne : TRADE_TALK.firm;
                id = 'lowball';
            }
        } else if (/\b(cheaper|lower|discount|less)\b/.test(text)) {
            pool = TRADE_TALK.cheaper;
            id = 'lowball';
        } else if (/\b(how much|price|pc|cost|how many gp)\b/.test(text)) {
            pool = one ? TRADE_TALK.priceOne : TRADE_TALK.price;
        }
        if (!pool) return;
        const line = pool[Math.floor(Math.random() * pool.length)].replace('{p}', formatGp(pool === TRADE_TALK.sellHigh ? this.buyBack : this.price));
        const reply = composeReply({ bot: player, to: partner, heard: said, channel: 'public', via: 'market', greeted: false, intent: { id, text: line } });
        if (reply) sayTyped(player, reply, { to: partner, kind: 'trade' });
    }

    /** What the bot gives and takes for the human's offer (port: exact, checked before every accept). */
    private _deal(player: Player, offer: Map<number, number>): TradeDeal {
        const stock = this.stock;
        if (!stock) return { line: '' };
        const tradeItemId = this._tradeItemId(stock);
        // port: it buys back only where it has a buy-back price (not rares)
        const buysNotes = this.buyBack > 0;
        const offerName = this._stockOfferName(stock);
        const priceEach = this.price;
        const gpOffered = offer.get(Items.COINS) ?? 0;
        const itemsOffered = buysNotes ? (offer.get(tradeItemId) ?? 0) : 0;

        for (const id of offer.keys()) {
            if (id !== Items.COINS && !(buysNotes && id === tradeItemId)) {
                return { line: buysNotes ? `Just coins to buy, or noted ${this.stockName} to sell please.` : 'Just coins please.' };
            }
        }
        if (gpOffered === 0 && itemsOffered === 0) return { line: '' };
        if (gpOffered > 0 && itemsOffered > 0) {
            return { line: `Put up coins to buy ${this.stockName}, or put up noted ${this.stockName} to sell. Not both!` };
        }

        // --- Selling mode: player offers coins ---
        if (gpOffered > 0) {
            this.tradeMode = 'selling';
            if (gpOffered < priceEach) {
                return { line: `Need at least ${priceEach}gp for 1 item. You have ${gpOffered}gp up.` };
            }
            const count = Math.min(Math.floor(gpOffered / priceEach), this.itemCount);
            const total = count * priceEach;
            const change = gpOffered - total;
            if (change >= priceEach) {
                // port: all the bot has, and more coins than that costs (upstream kept the rest)
                return { line: `That's too much! ${count}x ${offerName} is ${total}gp, take back ${change}gp.` };
            }
            // port: the change (less than one more item) goes back in the bot's offer; upstream kept it
            const give = new Map([[tradeItemId, count]]);
            if (change > 0) give.set(Items.COINS, change);
            return {
                line: change > 0 ? `Offering ${count}x ${offerName} for ${total}gp, and ${change}gp change. Accept when ready!` : `Offering ${count}x ${offerName} for ${total}gp. Accept when ready!`,
                give,
                get: new Map([[Items.COINS, gpOffered]])
            };
        }

        // --- Buying mode: player offers items ---
        this.tradeMode = 'buying';
        const buyPrice = this.buyBack;
        const coinsToOffer = itemsOffered * buyPrice;
        if (coinsToOffer <= 0) return { line: '' };
        if (countItem(player, Items.COINS) + (tradeOffer(player).get(Items.COINS) ?? 0) < coinsToOffer) {
            return { line: `I can't afford ${coinsToOffer}gp right now, sorry!` };
        }
        return {
            line: `Buying ${itemsOffered} ${this.stockName} for ${coinsToOffer}gp (${buyPrice}gp ea). Accept when ready!`,
            give: new Map([[Items.COINS, coinsToOffer]]),
            get: new Map([[tradeItemId, itemsOffered]])
        };
    }

    private _afterTrade(player: Player, outcome: TradeOutcome): void {
        console.log(`[VendorTask] Trade over: ${outcome}`);
        // port (phase 4): a rare it sold is gone: it stocks something else (rares are one at a time, not a supply)
        const sold = outcome === 'done' && this.tradeMode === 'selling' && this.stock?.rare === true;
        if (sold) soldRare.add(player);
        // (variety round 1, S8: a trade ends a break: it came back for it)
        if (this.breakUntil >= 0) {
            this.breakUntil = -1;
            this.nextBreakAt = World.currentTick + randInt(BREAK_EVERY[0], BREAK_EVERY[1]);
        }
        // (variety round 1, S8: a sale: no price drop, and its next item soon)
        if (outcome === 'done' && this.tradeMode === 'selling') {
            this.soldSinceStock = true;
            this.nextItemAt = Math.min(this.nextItemAt, World.currentTick + randInt(NEXT_ITEM_AFTER_SALE[0], NEXT_ITEM_AFTER_SALE[1]));
        }
        if (outcome === 'done') {
            if (this.tradeMode === 'buying') {
                botSay(player, Math.random() < 0.5 ? 'Good deal, thanks!' : 'Cheers!');
            } else {
                botSay(player, Math.random() < 0.5 ? 'Pleasure doing business!' : 'Ty!');
            }
        } else if (outcome === 'timeout') {
            botSay(player, 'Too slow, trade me again when you are ready!');
        } else if (outcome === 'refused') {
            botSay(player, 'Something went wrong. Declining.');
        }
        this._resetTrade(player, sold);
        this.watchdog.notifyActivity();
        this.cooldown = this.state === 'return_home' ? 1 : outcome === 'done' ? randInt(4, 8) : 2;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /** The item it trades: the note of a notable item (bulk and gear), port (phase 4): a rare itself (one, never noted). */
    private _tradeItemId(stock: VendorStock): number {
        if (stock.rare) return stock.itemId;
        const obj = ObjType.get(stock.itemId);
        if (obj?.certtemplate === -1 && obj.certlink >= 0) {
            return obj.certlink;
        }
        return stock.itemId;
    }

    private _isNotedStock(stock: VendorStock): boolean {
        if (NEVER_BUYBACK_ITEMS.has(stock.itemId)) {
            return false;
        }
        return this._tradeItemId(stock) !== stock.itemId;
    }

    private _stockOfferName(stock: VendorStock): string {
        // port: the game's name for it (or its alias), as the stock was set up (handleInit)
        const name = this.stock === stock && this.stockName ? this.stockName : (stock.alias ?? ObjType.get(stock.itemId).name ?? stock.name);
        return this._tradeItemId(stock) === stock.itemId ? name : `noted ${name}`;
    }

    /** After a trade: its stock back to the full count (vendors' supply is unlimited), its coins topped up; port (phase 4): a rare it sold is not (it restocks something else). */
    private _resetTrade(player: Player, rareGone = false): void {
        // (the trade fields: TradeSession.end)
        this.tradeMode = null;

        // Replenish inventory back to the original stock amount so the bot
        // never "runs out" — vendors have effectively infinite supply.
        if (this.stock && this.stockMax > 0) {
            const inv = player.getInventory(InvType.INV);
            if (inv) {
                const tradeItemId = this._tradeItemId(this.stock);
                // Clear all non-coin items so bought items and partial stacks never accumulate.
                for (let slot = 0; slot < inv.capacity; slot++) {
                    const existing = inv.get(slot);
                    if (existing && existing.id !== Items.COINS) {
                        inv.remove(existing.id, existing.count);
                    }
                }
                if (!rareGone) inv.add(tradeItemId, this.stockMax);
            }
            this.itemCount = rareGone ? 0 : this.stockMax;
            // (the marketplace no longer finds the rare it sold)
            if (rareGone) {
                player.botVendorStockItemId = -1;
                player.botVendorStockName = '';
            }
        }

        // Restore coins to STARTING_VENDOR_COINS so trimmed coins are always recovered.
        const invForCoins = player.getInventory(InvType.INV);
        if (invForCoins) {
            const currentCoins = countItem(player, Items.COINS);
            if (currentCoins < STARTING_VENDOR_COINS) {
                invForCoins.add(Items.COINS, STARTING_VENDOR_COINS - currentCoins);
            }
        }

        this.state = this.tradeReturnSpot ? 'return_home' : (this.itemCount > 0 ? 'idle' : 'init');
    }

    private _stuckWalk(player: Player, tx: number, tz: number): void {
        if (!this.stuck.check(player, tx, tz)) {
            walkTo(player, tx, tz);
            return;
        }
        if (this.stuck.desperatelyStuck) {
            teleportNear(player, tx, tz);
            this.stuck.reset();
            return;
        }
        if (openNearbyGate(player, 20)) return;
        walkTo(player, player.x + randInt(-8, 8), player.z + randInt(-8, 8));
    }
}

/** port: on its stall or a step or two from it on the same side of the counter (not across it: a vendor that logged
 * in behind the counter stood there for good, 2 tiles from its stall) */
function atStall(player: Player, x: number, z: number): boolean {
    return isNear(player, x, z, 2) && tilesInReach(player.level, x, z, 3).includes((player.x << 14) | player.z);
}
