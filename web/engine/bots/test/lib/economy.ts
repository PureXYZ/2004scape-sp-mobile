// For test/economy.test.mjs (the realism work, phase 4: looks and economy, track B): the real 274 world of
// lib/simworld.ts plus the economy's modules: the street table and prices (port/BotPrices), the vendors' stock, adverts,
// looks and trade talk (tasks/VendorTask), the marketplace's request parser (port/BotChat) and the conversation's price
// answers (port/BotAnswers), the bankstanders' asks (tasks/BankstandTask, since the integration), with the word filter
// and the packs' item names.
export * from './simworld.js';
import ObjType from '#/cache/config/ObjType.js';
import WordEnc from '#/cache/wordenc/WordEnc.js';
import { Items } from '#/engine/bot/BotKnowledge.js';
import {
    ADVERT_FORMS,
    BANK_TRADE_KEYS,
    bankTradeWeight,
    EXTRA_ITEMS,
    itemByNickname,
    RARE_SELLER_COMBAT,
    RARE_SELLER_TOTAL,
    rareSeller,
    TRADE_TALK,
    typedPrice,
    vendorAdverts,
    vendorStock,
    vendorStyle,
    VendorTask
} from '#/engine/bot/tasks/VendorTask.js';
import { buyPrice, categoryOf, formatGp, isRare, itemValue, priceFloor, sellPrice, STREET_SPREAD, streetPrice, streetRows } from '#/engine/bot/port/BotPrices.js';
import { marketRequestOf } from '#/engine/bot/port/BotChat.js';
import { ANSWER_LINES, itemFromWords, itemKey, priceOf, stateAnswer } from '#/engine/bot/port/BotAnswers.js';
import { botPersona } from '#/engine/bot/port/BotTiming.js';
import { nameSeed } from '#/engine/bot/port/BotSeed.js';
import { BankstandTask } from '#/engine/bot/tasks/BankstandTask.js';
import { viableItemIds } from '#/engine/bot/BotAction.js';

export { ObjType, WordEnc, Items, ADVERT_FORMS, BANK_TRADE_KEYS, bankTradeWeight, EXTRA_ITEMS, itemByNickname, RARE_SELLER_COMBAT, RARE_SELLER_TOTAL, rareSeller, TRADE_TALK, typedPrice, vendorAdverts, vendorStock, vendorStyle, VendorTask };
export { buyPrice, categoryOf, formatGp, isRare, itemValue, priceFloor, sellPrice, STREET_SPREAD, streetPrice, streetRows, marketRequestOf, itemFromWords, itemKey, priceOf, nameSeed };
export { BankstandTask, viableItemIds, ANSWER_LINES, stateAnswer, botPersona };

/** A price as formatGp writes it, read back ("12.5m" → 12,500,000; "450" → 450). */
export function readGp(text: string): number {
    const m = text.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
    if (!m) return NaN;
    return Math.round(Number(m[1]) * (m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1000 : 1));
}
