// port: answers from a bot's own state and what it knows of the world, for the questions 2004 players asked each
// other (the realism work, phase 2: the conversation). Upstream's chat AI had no answer to "asl", "how do i get to
// varrock", "where is the bank", "how much is a rune scim", "wanna go pk", "follow me", "what quest should i do", "u
// there?" or "wanna team up" (the research's probe: a greeting alone, "Yes Casey?", or nothing), and its marketplace
// knew no slang ("lobs", "ess", "nats"). Each answer here comes from the bot: its age, home and body (port/BotPersona,
// the player's gender), its levels and task, where it stands (directions from the walking world's towns and banks,
// spots from BotKnowledge's skill steps), prices (port/BotPrices: since phase 4 December 2004 street prices for about 45
// items, the value rule for the rest; a vendor's own is its ask; the vendors' nicknames understood). The words
// are the period's: short, lower case, u/ur/r, few apostrophes; the 274 client
// sentence-cases them. Every line passes the 274 word filter and chat codec (test/chat-filter.test.mjs).
//
// Who asks matters: directions start where the asker stands, quests and money tips suit the asker's levels (a bot
// sees a human's combat level as a player does). A bot answers for itself (asl, its levels, a PK invite) and as it
// knows the world; it never gives anything away (begging is refused: trades are unchanged).
import ObjType from '#/cache/config/ObjType.js';
import type Player from '#/engine/entity/Player.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { Items, SkillProgression, type SkillStep } from '#/engine/bot/BotKnowledge.js';
import type { Persona } from '#/engine/bot/port/BotPersona.js';
import { placePhrase } from '#/engine/bot/port/BotPlaces.js';
import { activityFor } from '#/engine/bot/port/BotActivity.js';
import { categoryOf, formatGp, sellPrice } from '#/engine/bot/port/BotPrices.js';
import { isAllowedCoord, isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { itemByNickname, vendorStock } from '#/engine/bot/tasks/VendorTask.js';
import { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';

/** What a rule understood and its answer (slots filled; `{name}` is left for BotChat.composeReply). */
export interface StateAnswer {
    /** the intent: 'asl', 'directions', 'bank', 'price', 'spots', 'pk', 'follow', ... */
    id: string;
    text: string;
    /** a willing bot follows the asker a little way (port/BotFollow) */
    follow?: boolean;
}

/** Picks a line from a pool (BotChat's: weighted, not the bot's last few). */
export type Picker = (pool: readonly string[]) => string;

export interface AnswerContext {
    bot: Player;
    /** its persona (port/BotPersona) */
    persona: Persona;
    /** who asked: the human, or a bot (bot↔bot); null when nobody in particular */
    asker: Player | null;
    /** the line as typed, and as the intents read it (BotChat.cleanMessage: lower case, shorthand spelled out) */
    raw: string;
    msg: string;
    pick: Picker;
}

/** The intents a line said to nobody may get a crowd's answer for (BotChat's floor control). */
export const CROWD_INTENTS: ReadonlySet<string> = new Set(['asl', 'age', 'from', 'pk', 'quest', 'team', 'beg', 'spots', 'bank', 'directions', 'price', 'money', 'attacked', 'newbie', 'presence', 'mod_any', 'mod_how']);

// ── The lines (every one through the word filter: test/chat-filter.test.mjs) ──────────────────────────────────────────

/** asl: {age} {g} (m/f) {region} */
const ASL = ['{age} {g} {region}', '{age} {g} {region}', '{age} {g} {region} u?', '{age} {g} {region}, u?', '{age} {g} {region} wbu'];
const ASL_REFUSE = ['no', 'why', 'lol no', 'not telling', 'y'];
const AGE = ['{age}', 'im {age}', '{age} u?', '{age} lol', '{age}, u?'];
const FROM = ['{region}', '{region} u?', 'im from {region}', '{region}, u?', '{region} lol'];
const FROM_YES = ['ya', 'yep', 'ya {region}', 'yes', 'yea'];
const FROM_NO = ['nah {region}', 'no {region}', 'no im from {region}', 'nope, {region}'];
const GENDER = { m: ['boy', 'guy lol', 'm', 'boy lol', 'dude'], f: ['girl', 'f', 'girl lol', 'yes girl'] };
const PLAYTIME: [number, readonly string[]][] = [
    [80, ['started today lol', 'like 2 days', 'first week lol', 'im new', 'few days']],
    [250, ['couple weeks', 'like a month', 'a few weeks', 'bout a month']],
    [500, ['few months', 'since the summer', 'like 4 months', 'a few months']],
    [800, ['like 6 months', 'since rs2 came out', 'most of the year', 'since march']],
    [1100, ['about a year', 'since classic', 'over a year', 'a year or so']],
    [Infinity, ['since classic lol', '2 years', 'since 2002', 'forever lol', 'since classic']]
];
const PK_YES = ['sure', 'k meet at edge', 'ya lets go', 'k bring food', 'sure where', 'ok meet me at edge bank', 'k', 'ya'];
const PK_LOW = ['nah im too low', 'lol im only {combat}', 'no way im {combat}', 'im too low lol', 'nah im {combat}'];
const PK_NO = ['nah', 'no ty', 'maybe later', 'nah im skilling', 'nah busy', 'not now', 'nah im good'];
const FIGHT_YES = ['k wildy', 'sure, edge', 'lol ok', 'k meet me at edge', 'bring it'];
const FIGHT_NO = ['lol no', 'nah', 'no ty', 'no lol', 'nah im good'];
const FOLLOW_YES = ['k', 'ok', 'where to?', 'k 1 sec', 'sure', 'ok lead the way', 'k where we going'];
const FOLLOW_NO = ['nah im busy', 'why', 'im busy atm', 'no ty', 'cant atm', 'nah', 'busy sry'];
const GEAR_THANKS = ['ty', 'thx', 'ty :)', 'lol ty', 'thanks', 'ty took ages', 'ty u too'];
const PRESENCE = ['here', 'im here', 'ya im here', 'ya here', 'here lol', 'yep im here', 'ya im here wats up'];
/** "u there?" to a bot at something: what it does ("ya, cutting willows") */
const PRESENCE_DOING = ['ya, {doing}', 'ya im {doing}', 'here, {doing}', 'yep {doing}'];
const TEAM_YES = ['sure what u doing', 'ok where r u', 'k what we doing', 'sure', 'ok', 'k where'];
const TEAM_NO = ['nah im good', 'maybe later', 'nah sry', 'im busy atm', 'nah i solo', 'no ty'];
const BEG_NO = ['no', 'lol no', 'nope', 'get ur own', 'no sry', 'im broke too', 'go kill cows lol', 'nah', 'no u', 'lol', 'get a job'];
const TRADE_YES = ['sure trade me', 'k trade', 'what u need?', 'what u looking for', 'trade me'];
const TRADE_NO = ['nah', 'trade what?', 'nah im not selling', 'what for?', 'nothing to trade lol', 'no ty'];
/** a market line said to a bot that does not trade: the human buys (it has none), or sells (it wants none) */
const MARKET_BUY_NO = ['dont have any', 'no sry', 'nope', 'not selling', 'none here'];
const MARKET_SELL_NO = ['nah im good', 'no ty', 'too much lol', 'nah', 'no thx'];
const BRB_OK = ['k', 'kk', 'ok', 'k cya', 'ok'];
const ATTACKED = ['run', 'run!', 'eat', 'lol run', 'run to the bank', 'eat food', 'just run', 'pray lol'];
const WHATSUP = ['nm u', 'not much', 'nothing much u?', 'nm', 'not much u?', 'just chilling'];
const HOW = ['good u?', 'not bad', 'good, u?', 'ok u', 'fine', 'good', 'not bad u?', 'ok i guess'];
const SKILL_LEVEL = ['{n}', '{n} u?', 'only {n}', '{n} :)', '{n} lol', 'im {n}', '{n} atm', '{n}, u?'];
const PRICE = ['like {price}', '{price}', 'about {price}', '{price} i think', 'idk like {price}', 'around {price}', '{price} ish'];
const PRICE_EACH = ['{price} ea', 'like {price} ea', 'about {price} each', '{price} each i think'];
const PRICE_MEMBERS = ['thats members', 'members item lol', 'cant get that on free'];
/** port (the review of phase 4): an item no one can trade (the veterans' bunny ears and scythe: 274 has no price for them) */
const PRICE_UNTRADEABLE = ['cant trade those', 'untradeable lol', 'u cant sell those', 'cant trade em, holiday item'];
const BANK_HERE = ['right there lol', 'its right there', 'lol its right there', 'right {dir} of u'];
const BANK = ['{dir}', 'bank is {dir}', '{bank}, {dir}', '{dir} of here', '{dir}, {bank}', '{bank}', '{bank} {dir}'];
/** to Al Kharid's bank from west of its wall: the toll gate (10 coins, or Prince Ali Rescue) */
const BANK_TOLL = ['{bank}, pay the toll', '{dir}, thru the toll gate', '{bank}, 10gp toll'];
const TOWN_HERE = ['ur in it lol', 'ur in {town} lol', 'this is {town}', 'lol ur here'];
const TOWN_NEAR = ['just {dir}', '{dir} of here', 'right {dir} of here', 'its just {dir}'];
const TOWN = ['{dir}', 'go {dir}', 'its {dir} of here', 'head {dir}', '{dir}, follow the road', 'walk {dir}', '{dir} lol'];
const TOWN_PAST = ['{dir} past {mid}', 'go {dir}, past {mid}', '{dir}, through {mid}'];
const TOWN_FAR = ['long walk {dir}', 'way {dir}', 'far {dir}', '{dir}, its a long walk'];
const TOWN_MEMBERS = ['thats members', 'u need members for that', 'members only lol'];
const TOWN_BOAT = ['take the boat at port sarim', 'boat from port sarim', 'boat at port sarim, 30gp'];
const SPOTS = ['{place}', 'try {place}', 'theres some {place}', '{place} i think', '{place}, {dir}'];
const QUEST = ['do {quest}', '{quest}', 'try {quest}', '{quest} is easy', '{quest}, its easy', 'i did {quest} first'];
const QUEST_DONE = ['ya', 'yep', 'ya ages ago', 'yep easy', 'ya', 'done it'];
const QUEST_NOT = ['nah', 'not yet', 'no im too low', 'nope', 'not yet lol'];
const MONEY = ['{tip}', '{tip} lol', '{tip} i guess', 'idk {tip}'];
/** "how much for ur sword": what it wears or carries is not for sale */
const NOT_FOR_SALE = ['not selling', 'its not for sale', 'nah its mine lol', 'not for sale lol', 'no lol'];
const SHRUG = ['idk', 'no idea', 'dunno', 'idk lol', 'no clue', 'not sure'];
// ---- (realism phase 5b, Track A: the player-mod bot, port/BotModBot) its answers in proper sentences, and the others' ----
/** the mod, asked "is there a mod here" or "r u a mod" */
const MOD_YES = ["Yes, I'm a player mod. How can I help?", "Yes, I'm a player mod. Can I help?"];
/** the mod, asked how to become one */
const MOD_HOW = ['Jagex picks the mods. Just be helpful.'];
/** a bot that is no mod, asked "r u a mod" */
const MOD_NO = ['no lol', 'lol no', 'i wish', 'nope', 'no im not'];
/** "is there a mod here": none in sight, or the crowned one near */
const MOD_NONE = ['dont think so', 'no mods on lol', 'nope', 'havent seen one'];
const MOD_THERE = ['ya theres one here', 'ya over there', 'theres a pmod here'];
/** a bot that is no mod, asked how to become one */
const MOD_HOW_OTHER = ['jagex picks them i think', 'idk', 'be nice lol', 'u cant ask lol'];
// ---- end of Track A's (phase 5b) lines ----

/** Every template this module can say ({slots} filled at run time), for test/chat-filter.test.mjs. */
export const ANSWER_LINES = {
    asl: ASL, aslRefuse: ASL_REFUSE, age: AGE, from: FROM, fromYes: FROM_YES, fromNo: FROM_NO, gender: [...GENDER.m, ...GENDER.f],
    playtime: PLAYTIME.flatMap(([, lines]) => lines),
    pkYes: PK_YES, pkLow: PK_LOW, pkNo: PK_NO, fightYes: FIGHT_YES, fightNo: FIGHT_NO,
    followYes: FOLLOW_YES, followNo: FOLLOW_NO, gear: GEAR_THANKS, presence: PRESENCE, presenceDoing: PRESENCE_DOING, teamYes: TEAM_YES, teamNo: TEAM_NO,
    beg: BEG_NO, tradeYes: TRADE_YES, tradeNo: TRADE_NO, marketBuyNo: MARKET_BUY_NO, marketSellNo: MARKET_SELL_NO, brb: BRB_OK, attacked: ATTACKED, whatsup: WHATSUP, how: HOW,
    skillLevel: SKILL_LEVEL, price: PRICE, priceEach: PRICE_EACH, priceMembers: PRICE_MEMBERS, priceUntradeable: PRICE_UNTRADEABLE,
    bankHere: BANK_HERE, bank: BANK, bankToll: BANK_TOLL, notForSale: NOT_FOR_SALE, townHere: TOWN_HERE, townNear: TOWN_NEAR, town: TOWN, townPast: TOWN_PAST, townFar: TOWN_FAR, townMembers: TOWN_MEMBERS, townBoat: TOWN_BOAT,
    spots: SPOTS, quest: QUEST, questDone: QUEST_DONE, questNot: QUEST_NOT, money: MONEY, shrug: SHRUG,
    // (realism phase 5b, Track A: the player-mod bot)
    modYes: MOD_YES, modHow: MOD_HOW, modNo: MOD_NO, modNone: MOD_NONE, modThere: MOD_THERE, modHowOther: MOD_HOW_OTHER
} as const;

// ── Places: towns (directions), banks, compass words ─────────────────────────────────────────────────────────────────

interface Town {
    /** as a player says it */
    say: string;
    /** how it is typed (cleaned: lower case, no punctuation) */
    words: readonly string[];
    x: number;
    z: number;
    /** its reach: within it the asker is "in" it */
    r: number;
    /** over the sea from the mainland: the boat */
    boat?: boolean;
}

/** 274's towns and landmarks (BotPlaces' places, the world map's labels), with the names players typed. */
export const TOWNS: readonly Town[] = [
    { say: 'lumbridge', words: ['lumbridge', 'lumby', 'lumbrige', 'lumbridge castle'], x: 3222, z: 3218, r: 30 },
    { say: 'varrock', words: ['varrock', 'varock', 'varrok', 'varrock square'], x: 3213, z: 3428, r: 45 },
    { say: 'falador', words: ['falador', 'fally', 'fallador', 'faly', 'falador park', 'fally park'], x: 2975, z: 3370, r: 45 },
    { say: 'draynor', words: ['draynor', 'draynor village'], x: 3093, z: 3250, r: 25 },
    { say: 'al kharid', words: ['al kharid', 'alkharid', 'kharid', 'al kharid palace'], x: 3293, z: 3190, r: 35 },
    { say: 'edgeville', words: ['edgeville', 'edge', 'edgville', 'edgevile'], x: 3093, z: 3493, r: 22 },
    { say: 'port sarim', words: ['port sarim', 'sarim'], x: 3030, z: 3220, r: 20 },
    { say: 'rimmington', words: ['rimmington', 'rimmy'], x: 2957, z: 3215, r: 20 },
    { say: 'barb village', words: ['barbarian village', 'barb village', 'barb vilage'], x: 3082, z: 3420, r: 18 },
    { say: 'karamja', words: ['karamja', 'musa point', 'karamja island'], x: 2918, z: 3165, r: 40, boat: true },
    { say: 'the wildy', words: ['wilderness', 'wildy', 'the wild'], x: 3100, z: 3540, r: 0 },
    { say: 'the champions guild', words: ['champions guild', 'champs guild', 'champion guild'], x: 3191, z: 3362, r: 8 },
    { say: 'the crafting guild', words: ['crafting guild'], x: 2933, z: 3285, r: 10 },
    { say: 'ice mountain', words: ['ice mountain'], x: 3007, z: 3478, r: 15 },
    { say: 'the monastery', words: ['monastery'], x: 3052, z: 3490, r: 12 },
    { say: 'draynor manor', words: ['draynor manor', 'the manor'], x: 3109, z: 3350, r: 15 },
    { say: 'the swamp', words: ['lumbridge swamp', 'lumby swamp', 'the swamp'], x: 3200, z: 3170, r: 20 },
    { say: 'goblin village', words: ['goblin village'], x: 2956, z: 3505, r: 15 },
    { say: 'the duel arena', words: ['duel arena'], x: 3361, z: 3240, r: 20 },
    { say: 'taverley', words: ['taverley', 'taverly', 'taverely'], x: 2900, z: 3440, r: 22 },
    { say: 'burthorpe', words: ['burthorpe', 'burthorp'], x: 2900, z: 3550, r: 20 },
    { say: 'catherby', words: ['catherby', 'cathery'], x: 2809, z: 3436, r: 25 },
    { say: 'camelot', words: ['camelot', 'cammy', 'camelot castle'], x: 2757, z: 3500, r: 15 },
    { say: 'seers', words: ['seers', 'seers village', 'seers village'], x: 2720, z: 3480, r: 25 },
    { say: 'ardougne', words: ['ardougne', 'ardy', 'east ardougne', 'ardougne market'], x: 2662, z: 3305, r: 45 },
    { say: 'yanille', words: ['yanille', 'yanile'], x: 2560, z: 3090, r: 25 },
    { say: 'brimhaven', words: ['brimhaven'], x: 2772, z: 3200, r: 30, boat: true },
    { say: 'entrana', words: ['entrana'], x: 2834, z: 3335, r: 30, boat: true },
    { say: 'the fishing guild', words: ['fishing guild'], x: 2603, z: 3415, r: 12 },
    { say: 'the gnome stronghold', words: ['gnome stronghold', 'tree gnome stronghold', 'the stronghold'], x: 2460, z: 3430, r: 60 },
    { say: 'shilo village', words: ['shilo village', 'shilo'], x: 2850, z: 2960, r: 25, boat: true },
    { say: 'port khazard', words: ['port khazard', 'khazard'], x: 2660, z: 3160, r: 18 },
    { say: 'witchaven', words: ['witchaven'], x: 2720, z: 3285, r: 15 },
    { say: 'tree gnome village', words: ['tree gnome village', 'gnome village'], x: 2525, z: 3170, r: 25 },
    { say: 'the barbarian outpost', words: ['barbarian outpost', 'barb outpost'], x: 2540, z: 3570, r: 20 },
    { say: 'white wolf mountain', words: ['white wolf mountain', 'white wolf'], x: 2848, z: 3480, r: 18 }
];

/** The ground-floor banks bots use (BotTaskBase's), as players named them. */
export const BANKS: readonly { say: string; x: number; z: number }[] = [
    { say: 'draynor bank', x: 3092, z: 3245 },
    { say: 'varrock west bank', x: 3185, z: 3444 },
    { say: 'varrock east bank', x: 3253, z: 3420 },
    { say: 'al kharid bank', x: 3269, z: 3163 },
    { say: 'fally west bank', x: 2946, z: 3368 },
    { say: 'fally east bank', x: 3013, z: 3355 },
    { say: 'edge bank', x: 3093, z: 3491 },
    { say: 'seers bank', x: 2725, z: 3493 },
    { say: 'catherby bank', x: 2808, z: 3441 },
    { say: 'ardy north bank', x: 2615, z: 3332 },
    { say: 'ardy south bank', x: 2655, z: 3283 },
    { say: 'yanille bank', x: 2613, z: 3093 },
    { say: 'the gnome bank', x: 2449, z: 3482 }
];

/** The way from (fromX, fromZ) to (x, z) as a compass word ("north east"); x grows east, z north. */
export function compass(dx: number, dz: number): string {
    const sector = Math.round(Math.atan2(dz, dx) / (Math.PI / 4));
    return ['west', 'south west', 'south', 'south east', 'east', 'north east', 'north', 'north west', 'west'][sector + 4];
}

function chebyshev(ax: number, az: number, bx: number, bz: number): number {
    return Math.max(Math.abs(ax - bx), Math.abs(az - bz));
}

/** the nearest bank to (x, z) a player may use on this world, and how far */
export function nearestBankFor(x: number, z: number): { say: string; x: number; z: number; d: number } | null {
    let best: { say: string; x: number; z: number; d: number } | null = null;
    for (const b of BANKS) {
        if (!isAllowedCoord(b.x, b.z)) continue;
        const d = chebyshev(x, z, b.x, b.z);
        if (!best || d < best.d) best = { ...b, d };
    }
    return best;
}

/** the town named in the cleaned line (the longest name that matches), or null */
export function townIn(msg: string): Town | null {
    const text = ` ${msg} `;
    let best: Town | null = null;
    let bestLen = 0;
    for (const town of TOWNS) {
        for (const w of town.words) {
            if (w.length > bestLen && text.includes(` ${w} `)) {
                best = town;
                bestLen = w.length;
            }
        }
    }
    return best;
}

/** the town whose reach (×1.5) holds (x, z), nearest first, or null */
function townAt(x: number, z: number): Town | null {
    let best: Town | null = null;
    let bestDepth = Infinity;
    for (const t of TOWNS) {
        if (t.r <= 0) continue;
        const depth = chebyshev(x, z, t.x, t.z) / t.r;
        if (depth <= 1.5 && depth < bestDepth) {
            best = t;
            bestDepth = depth;
        }
    }
    return best;
}

// ── Items: names as players typed them ───────────────────────────────────────────────────────────────────────────

/** an item's name or a line's words, compared whole: lower case, words only, each without a plural s (the marketplace's) */
export function itemKey(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(' ')
        .map(part => (part.endsWith('s') && part.length > 3 ? part.slice(0, -1) : part))
        .join(' ');
}

/** 2004 item slang, word by word ("lobs", "ess", "nats", "addy", "mith", "scim", "d long") */
const SLANG: Record<string, string> = {
    lobs: 'lobsters', lob: 'lobster', lobbies: 'lobsters', lobbys: 'lobsters', lobby: 'lobster', lobbie: 'lobster',
    swordies: 'swordfish', swordys: 'swordfish', swordie: 'swordfish', swordy: 'swordfish', sharkies: 'sharks',
    ess: 'rune essence', essence: 'rune essence', nats: 'nature runes', nat: 'nature rune', laws: 'law runes', cosmics: 'cosmic runes',
    deaths: 'death runes', bloods: 'blood runes', chaos: 'chaos runes', fires: 'fire runes', airs: 'air runes', waters: 'water runes',
    earths: 'earth runes', minds: 'mind runes', bodys: 'body runes',
    addy: 'adamant', adamy: 'adamant', mith: 'mithril', mithril: 'mithril', mithrill: 'mithril',
    scim: 'scimitar', scimmy: 'scimitar', scimmie: 'scimitar', scims: 'scimitars', scimmies: 'scimitars', scimi: 'scimitar',
    plate: 'platebody', plates: 'platebodys', legs: 'platelegs', kite: 'kiteshield', kites: 'kiteshields', med: 'med helm',
    meds: 'med helms', full: 'full helm', sq: 'sq shield', chain: 'chainbody', '2h': '2h sword', long: 'longsword', longs: 'longswords',
    phat: 'partyhat', phats: 'partyhats', hween: 'halloween mask', santa: 'santa hat', santas: 'santa hats',
    yews: 'yew logs', willows: 'willow logs', maples: 'maple logs', oaks: 'oak logs', magics: 'magic logs',
    dbones: 'dragon bones', d: 'dragon', str: 'strength', att: 'attack', pot: 'potion', pots: 'potions', ammy: 'amulet', ammys: 'amulets'
};

/** the words with the slang spelled out ("rune scim" → "rune scimitar", "addy ore" → "adamantite ore", "rune ess" → "rune essence") */
export function expandSlang(words: readonly string[]): string[] {
    const out: string[] = [];
    for (const w of words) {
        const long = SLANG[w];
        if (!long) {
            out.push(w);
            continue;
        }
        const parts = long.split(' ');
        // "rune ess", "pure ess": one rune essence
        if (parts[0] === 'rune' && (out.at(-1) === 'rune' || out.at(-1) === 'pure')) out.pop();
        out.push(...parts);
    }
    // the ores and bars are adamantite and runite ("addy ore", "rune bar")
    for (let i = 0; i + 1 < out.length; i++) {
        if (!/^(ore|ores|bar|bars)$/.test(out[i + 1])) continue;
        if (out[i] === 'adamant') out[i] = 'adamantite';
        else if (out[i] === 'rune') out[i] = 'runite';
    }
    return out;
}

let itemIds: Map<string, number> | null = null;

/** every object's name as itemKey gives it → its id (the first unnoted one) */
function itemIdsByKey(): Map<string, number> {
    if (!itemIds) {
        itemIds = new Map();
        for (let id = 0; id < ObjType.count; id++) {
            const type = ObjType.get(id);
            if (!type?.name || type.certtemplate !== -1) continue;
            const key = itemKey(type.name);
            if (!itemIds.has(key)) itemIds.set(key, id);
        }
    }
    return itemIds;
}

/** the item a run of words names (slang spelled out), the longest from the start, or null */
export function itemFromWords(words: readonly string[]): { id: number; key: string } | null {
    // port (phase 4): the words a vendor's adverts use for it, whole ("glory", "str pots", "jugs of water")
    let first = 0;
    while (first < words.length && /^(a|an|the|some|any|ur|your|my|for|on|1)$/.test(words[first])) first++;
    const plain = words.slice(first);
    const nickname = itemByNickname(plain.join(' '));
    if (nickname !== null) return { id: nickname.id, key: itemKey(nickname.name) };
    const expanded = expandSlang(words.filter(w => !/^(a|an|the|some|any|ur|your|my|of|for|on|1)$/.test(w)));
    const ids = itemIdsByKey();
    for (let n = expanded.length; n > 0; n--) {
        const key = itemKey(expanded.slice(0, n).join(' '));
        const id = ids.get(key);
        if (id !== undefined) return { id, key };
    }
    // port (phase 4): or a vendor's nickname at the start ("glory ammy worth")
    for (let n = plain.length - 1; n > 0; n--) {
        const nick = itemByNickname(plain.slice(0, n).join(' '));
        if (nick !== null) return { id: nick.id, key: itemKey(nick.name) };
    }
    // a potion asked for without its dose ("str pot"): the (4); a rare without its colour ("phat"): the red one
    const all = itemKey(expanded.join(' '));
    if (all.split(' ').length >= 2) {
        const dosed = ids.get(`${all} 4`) ?? ids.get(`${all} 3`);
        if (dosed !== undefined) return { id: dosed, key: all };
    }
    for (const rare of ['partyhat', 'halloween mask']) {
        if (all === rare || all.endsWith(` ${rare}`)) {
            const id = ids.get(`red ${rare}`);
            if (id !== undefined) return { id, key: rare };
        }
    }
    return null;
}

/** what `bot` would say one of item `id` goes for (its own view: port/BotPrices from its name), as 2004 wrote it */
export function priceOf(id: number, bot: Player): string {
    const listed = vendorStock().find(s => s.itemId === id);
    const category = categoryOf(id, listed?.rare === true, listed?.market === true);
    return formatGp(sellPrice(id, bot.username, category, listed?.priceEach ?? 0));
}

// ── Spots: where a skill's item comes from, where a monster is ───────────────────────────────────────────────────

/** what a player asks for → the items a step gains, or the monsters it fights */
const SPOT_ITEMS: [RegExp, number[]][] = [
    [/\biron\b/, [Items.IRON_ORE]], [/\bcoal\b/, [Items.COAL]], [/\bcopper\b/, [Items.COPPER_ORE]], [/\btin\b/, [Items.TIN_ORE]],
    [/\bgold\b/, [Items.GOLD_ORE]], [/\bsilver\b/, [Items.SILVER_ORE]], [/\b(mith|mithril)\b/, [Items.MITHRIL_ORE]],
    [/\b(addy|adamant|adamantite)\b/, [Items.ADAMANTITE_ORE]], [/\b(runite|rune ore)\b/, [Items.RUNITE_ORE]], [/\bclay\b/, [Items.CLAY]],
    [/\b(ess|essence)\b/, [Items.RUNE_ESSENCE]],
    [/\boaks?\b/, [Items.OAK_LOGS]], [/\bwillows?\b/, [Items.WILLOW_LOGS]], [/\bmaples?\b/, [Items.MAPLE_LOGS]], [/\byews?\b/, [Items.YEW_LOGS]],
    [/\bmagic (logs|trees?)\b|\bmagics\b/, [Items.MAGIC_LOGS]],
    [/\bshrimps?\b|\banchov/, [Items.RAW_SHRIMP, Items.RAW_ANCHOVIES]], [/\bsardines?\b|\bherring\b/, [Items.RAW_SARDINE, Items.RAW_HERRING]],
    [/\btrout\b|\bsalmon\b/, [Items.RAW_TROUT, Items.RAW_SALMON]], [/\bpike\b/, [Items.RAW_PIKE]], [/\btuna\b/, [Items.RAW_TUNA]],
    [/\b(lobs?|lobsters?|lobbies|lobbys)\b/, [Items.RAW_LOBSTER]], [/\b(swordfish|swordies)\b/, [Items.RAW_SWORDFISH]], [/\bsharks?\b/, [Items.RAW_SHARK]],
    [/\b(logs|trees)\b/, [Items.LOGS]]
];
const SPOT_MONSTERS: [RegExp, string][] = [
    [/\bcows?\b/, 'cow'], [/\bchickens?\b/, 'chicken'], [/\bgoblins?\b/, 'goblin'], [/\bhill giants?\b|\bgiants\b/, 'giant'],
    [/\bmoss giants?\b/, 'mossgiant'], [/\bice giants?\b/, 'icegiant'], [/\bguards?\b/, 'guard'], [/\bbarbarians?\b/, 'barbarian'],
    [/\bwarriors?\b|\bal kharid warriors?\b/, 'al_kharid_warrior'], [/\bmonks?\b/, 'monk'], [/\brats?\b/, 'giantrat'], [/\bdruids?\b/, 'chaos_druid'], [/\bmen\b/, 'man']
];

function stepFights(step: SkillStep, npc: string): boolean {
    const extra = step.extra as { npcType?: unknown; npcTypes?: unknown } | undefined;
    if (typeof extra?.npcType === 'string') return extra.npcType === npc;
    return Array.isArray(extra?.npcTypes) && extra.npcTypes.includes(npc);
}

/** the nearest place to (x, z) where a step gains one of `items` or fights `npc`, on this world; null if none */
export function nearestSpot(x: number, z: number, items: readonly number[], npc: string | null): [number, number] | null {
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (const steps of Object.values(SkillProgression)) {
        for (const step of steps) {
            const hit = npc !== null ? stepFights(step, npc) : step.itemGained !== undefined && items.includes(step.itemGained);
            if (!hit) continue;
            const [sx, sz, level] = step.location;
            if (level !== 0 || sz >= 6400 || !isAllowedCoord(sx, sz)) continue;
            const d = chebyshev(x, z, sx, sz);
            if (d < bestD) {
                best = [sx, sz];
                bestD = d;
            }
        }
    }
    return best;
}

// ── Quests and money ─────────────────────────────────────────────────────────────────────────────────────────────

interface Quest {
    say: string;
    words: readonly string[];
    /** about the combat level a player did it at */
    combat: number;
    members?: boolean;
}

/** 274's quests players talked about, with about the combat level they were done at */
const QUESTS: readonly Quest[] = [
    { say: 'cooks assistant', words: ['cooks assistant', 'cook assistant', 'cooks quest'], combat: 3 },
    { say: 'sheep shearer', words: ['sheep shearer'], combat: 3 },
    { say: 'the restless ghost', words: ['restless ghost'], combat: 3 },
    { say: 'rune mysteries', words: ['rune mysteries', 'rune mystery'], combat: 3 },
    { say: 'romeo and juliet', words: ['romeo and juliet', 'romeo'], combat: 3 },
    { say: 'imp catcher', words: ['imp catcher'], combat: 3 },
    { say: 'witches potion', words: ['witches potion', 'witchs potion', 'witch potion'], combat: 5 },
    { say: 'dorics quest', words: ['dorics quest', 'doric quest', 'dorics'], combat: 5 },
    { say: 'goblin diplomacy', words: ['goblin diplomacy'], combat: 5 },
    { say: 'ernest the chicken', words: ['ernest the chicken', 'ernest'], combat: 5 },
    { say: 'pirates treasure', words: ['pirates treasure', 'pirate treasure'], combat: 8 },
    { say: 'prince ali rescue', words: ['prince ali rescue', 'prince ali'], combat: 10 },
    { say: 'the knights sword', words: ['knights sword', 'knight sword'], combat: 15 },
    { say: 'vampire slayer', words: ['vampire slayer', 'vamp slayer'], combat: 18 },
    { say: 'shield of arrav', words: ['shield of arrav'], combat: 15 },
    { say: 'demon slayer', words: ['demon slayer'], combat: 22 },
    { say: 'black knights fortress', words: ['black knights fortress', 'black knight fortress', 'bkf'], combat: 25 },
    { say: 'dragon slayer', words: ['dragon slayer'], combat: 40 },
    { say: 'druidic ritual', words: ['druidic ritual'], combat: 5, members: true },
    { say: 'waterfall quest', words: ['waterfall quest', 'waterfall'], combat: 25, members: true },
    { say: 'tree gnome village', words: ['tree gnome village'], combat: 25, members: true },
    { say: 'fight arena', words: ['fight arena'], combat: 35, members: true },
    { say: 'lost city', words: ['lost city'], combat: 40, members: true },
    { say: 'heroes quest', words: ['heroes quest', 'heros quest', 'hero quest'], combat: 55, members: true },
    { say: 'the fremennik trials', words: ['fremennik trials', 'fremmy trials', 'fremennik'], combat: 45, members: true },
    { say: 'horror from the deep', words: ['horror from the deep'], combat: 45, members: true },
    { say: 'legends quest', words: ['legends quest', 'legend quest', 'legends'], combat: 75, members: true }
];

function questIn(msg: string): Quest | null {
    const text = ` ${msg} `;
    for (const q of QUESTS) if (q.words.some(w => text.includes(` ${w} `))) return q;
    return null;
}

/** money tips by the asker's combat level (the free world's first, then members') */
const MONEY_TIPS: [number, readonly string[], readonly string[]][] = [
    [20, ['sell cowhides', 'get feathers', 'fish shrimps', 'mine copper and tin', 'kill cows for hides'], ['pick flax', 'cowhides']],
    [40, ['mine iron', 'cut willows', 'big bones from hill giants', 'fish lobs', 'mine coal'], ['pick flax at seers', 'cut maples', 'lobs at catherby']],
    [Infinity, ['mine coal', 'cut yews', 'kill moss giants', 'fish lobs', 'merch at varrock west', 'make runes'], ['ice giants', 'swordies at catherby', 'cut magics lol', 'runecraft']]
];

// ── The intents ─────────────────────────────────────────────────────────────────────────────────────────────────

const REGION_WORDS: Record<string, readonly string[]> = {
    usa: ['usa', 'us', 'america'], uk: ['uk', 'england', 'britain'], canada: ['canada'], australia: ['aus', 'australia'],
    netherlands: ['netherlands'], sweden: ['sweden'], ireland: ['ireland'], 'new zealand': ['new zealand'], germany: ['germany'], norway: ['norway']
};
const REGION_ASKED: [RegExp, string][] = [
    [/\b(usa|us|america|american|the states)\b/, 'usa'], [/\b(uk|england|english|britain|british)\b/, 'uk'], [/\b(canada|canadian)\b/, 'canada'],
    [/\b(aus|australia|australian|aussie)\b/, 'australia'], [/\b(holland|netherlands|dutch)\b/, 'netherlands'], [/\b(sweden|swedish)\b/, 'sweden'],
    [/\b(ireland|irish)\b/, 'ireland'], [/\b(nz|new zealand)\b/, 'new zealand'], [/\b(germany|german)\b/, 'germany'], [/\b(norway|norwegian)\b/, 'norway']
];

const SKILL_STATS: [RegExp, number][] = [
    [/\b(attack|atk|att)\b/, 0], [/\b(defence|defense|def)\b/, 1], [/\b(strength|str)\b/, 2], [/\b(hitpoints|hp)\b/, 3], [/\b(ranged|range)\b/, 4],
    [/\b(prayer|pray)\b/, 5], [/\b(magic|mage)\b/, 6], [/\b(cooking|cook)\b/, 7], [/\b(woodcutting|woodcut|wc)\b/, 8], [/\b(fletching|fletch)\b/, 9],
    [/\b(fishing|fish)\b/, 10], [/\b(firemaking|fm)\b/, 11], [/\b(crafting|craft)\b/, 12], [/\b(smithing|smith)\b/, 13], [/\b(mining|mine)\b/, 14],
    [/\b(herblore|herb|herby)\b/, 15], [/\b(agility|agil|agi)\b/, 16], [/\b(thieving|thief|thieve)\b/, 17], [/\b(runecrafting|runecraft|rc)\b/, 20]
];

const NEWBIE_HELP: [RegExp, readonly string[]][] = [
    [/\bhow (do|can|should) (i|you) bank\b|\bhow to bank\b|\bwhere (do|can) i bank\b|\bhow do i (use|open) (the|a) bank\b|\bbank stuff\b/, ['click a bank booth', 'talk to a banker', 'use a bank booth', 'go to a bank and click the booth', 'click the booth lol']],
    [/\bturn on run\b|\bhow do i run\b|\bhow (do i|to) make my guy run\b/, ['click run in the controls tab', 'controls tab, the run button', 'theres a run button in the controls tab']],
    [/\b(add|get) (a )?friends?\b/, ['friends tab, add friend', 'click add friend in the friends tab', 'friends list tab']],
    [/\bwhere (do|can) i (get|buy) (armour|armor|better armour|better armor)\b/, ['horvik in varrock', 'varrock armour shop', 'kill stuff and buy some in varrock', 'horviks in varrock']],
    [/\b(better|best|good) (sword|weapon|scimitar)\b/, ['zeke in al kharid sells scims', 'varrock sword shop', 'get a scim', 'rune scim lol']],
    [/\bwhere (do|can) i sell\b|\bsell stuff\b|\bsell my stuff\b/, ['general store', 'any general store', 'trade ppl at varrock west', 'lumby general store']],
    [/\bwhere (do|can) i get food\b|\bneed food\b|\bhow do i get food\b/, ['fish shrimps', 'kill chickens and cook them', 'cook some meat', 'fish some shrimps and cook them']],
    [/\bwhat are (these|the) runes for\b|\bwhat do runes do\b/, ['magic', 'cast spells with them', 'air strike lol', 'spells, magic tab']],
    [/\bhow do i (cast|use magic|do magic)\b|\bcast spells\b/, ['magic tab, click air strike then a monster', 'click a spell then the monster', 'magic tab']],
    [/\bhow do i fish\b|\bhow do you fish\b/, ['get a net and click the spot', 'buy a net at port sarim', 'net fish at draynor', 'get a net lol']],
    [/\bhow do i mine\b|\bwhere (do|can) i get a pick(axe)?\b/, ['get a pickaxe and click a rock', 'bob in lumby has picks', 'click the rocks with a pick']],
    [/\bhow do i (cut|chop)\b|\bwhere (do|can) i get an axe\b/, ['get an axe and click a tree', 'bob in lumby sells axes', 'click a tree with an axe']],
    [/\bhow do i (make|light) (a )?fire\b/, ['use a tinderbox on logs', 'tinderbox on the logs', 'tinderbox on some logs']],
    [/\bhow do i cook\b/, ['use the fish on a fire', 'click the range with raw food', 'raw food on a range']],
    [/\b(level|levels|lvl) (up )?fast\b|\bhow do i train\b/, ['kill cows', 'just train lol', 'do quests', 'kill stuff', 'kill chickens then cows']],
    [/\bhow do (i|you) do quests\b|\bhow do quests work\b|\bstart a quest\b/, ['talk to npcs', 'the cook in lumby castle has one', 'check the quest tab', 'talk to the cook in the castle']],
    [/\bwhat does the cook want\b|\bcook want\b/, ['egg milk and flour', 'an egg, a bucket of milk and flour', 'egg, milk and flour']],
    [/\bwhere (do|can) i get (an )?egg\b/, ['the chicken farm', 'chickens north of lumby', 'chicken farm over the river']],
    [/\b(what|wat) do i do( now)?\b|\bwhat should i do\b/, ['kill some chickens', 'do cooks assistant', 'train ur stats', 'whatever u want lol']],
    [/\b(i am|im) lost\b/, ['where u trying to go', 'lol', 'where r u going']],
    [/\bget out of lumbridge\b|\bleave lumbridge\b/, ['walk lol', 'go north to varrock', 'walk west to draynor']],
    [/\bis there a shop\b|\bwhere is (the|a) (general )?(store|shop)\b/, ['general store north of the castle', 'every town has a general store', 'lumby general store']],
    [/\bis this game free\b|\bshould i get members\b|\bis members worth\b/, ['members is worth it', 'free is fine', 'members is 5 bucks a month', 'get members']],
    [/\bhow do i (wear|wield|equip)\b/, ['click it', 'click wield', 'just click it in ur pack']]
];

/**
 * The line's intent among the conversation's new ones, answered from the bot's state, or null. Checked after the
 * goodbye and before the greetings and upstream's intents (BotChat.processIntent): "where are you from" before "where
 * are you", "how do i get to varrock" before upstream's "where" filler.
 */
export function stateAnswer(ctx: AnswerContext): StateAnswer | null {
    const { msg, raw, bot, asker, pick, persona } = ctx;
    const from = asker ?? bot;
    const text = (id: string, line: string): StateAnswer => ({ id, text: line });

    // ---- (realism phase 5b, Track A) the player-mod bot (port/BotModBot: its crown is its staff level 1) ----
    const mod = modAnswer(msg, bot, pick);
    if (mod) return mod;

    // ---- the bot itself: asl, age, home, body, time played ----
    if (/\basl\b/.test(msg)) {
        if (persona.friendliness < -0.35 && Math.random() < 0.5) return text('asl', pick(ASL_REFUSE));
        return text('asl', fillAsl(pick(ASL), bot, persona, pick));
    }
    if (/\bhow old are you\b|\bhow old r you\b|\byour age\b|^age$/.test(msg)) return text('age', pick(AGE).replace('{age}', String(persona.age)));
    if (/\bwhere (are )?you from\b|\bwhere do you live\b|\bwhat country\b|\bwhere you live\b/.test(msg)) return text('from', pick(FROM).replace('{region}', regionWord(persona, pick)));
    const fromAsked = /\b(are )?you from\b|\bare you (english|british|american|canadian|aussie|australian|dutch|swedish|irish|german|norwegian)\b/.test(msg) ? REGION_ASKED.find(([rx]) => rx.test(msg)) : undefined;
    if (fromAsked) return text('from', pick(fromAsked[1] === persona.region ? FROM_YES : FROM_NO).replace('{region}', regionWord(persona, pick)));
    if (/\b(are )?you a (girl|boy|guy|chick|dude|female|male)\b|\b(girl|boy) or (boy|girl)\b|\bmale or female\b/.test(msg)) return text('gender', pick(bot.gender === 1 ? GENDER.f : GENDER.m));
    if (/\bhow long (have )?(you )?(been )?(play|playing|played)\b|\bhow long have you played\b|\bwhen did you start\b|\bhow long you been\b/.test(msg)) return text('playtime', pick(playtimeLines(bot)));

    // ---- invitations and requests ----
    if (/\b1v1\b|\bfight me\b|\bwanna fight\b|\bduel me\b|\bwanna duel\b/.test(msg)) return text('fight', pick(isPker(bot) ? FIGHT_YES : FIGHT_NO));
    if (/\b(wanna|want to|lets|let us|gonna|you want to|you wanna|any1 wanna|anyone wanna|anyone want to) (go )?(pk|pking|wildy|wild|wilderness)\b|^pk$|^pking$|\bgo pk\b/.test(msg)) {
        if (isPker(bot)) return text('pk', pick(PK_YES));
        if (bot.combatLevel < 30) return text('pk', pick(PK_LOW).replace('{combat}', String(bot.combatLevel)));
        return text('pk', pick(persona.sociability > 0.75 && persona.friendliness > 0.3 && Math.random() < 0.3 ? PK_YES : PK_NO));
    }
    if (/\bfollow me\b|\bcome with me\b|\bfollow\b|\bcome (to|here)\b/.test(msg)) {
        const willing = willingToFollow(bot, persona);
        return { id: 'follow', text: pick(willing ? FOLLOW_YES : FOLLOW_NO), follow: willing };
    }
    if (/\bteam up\b|\bwanna team\b|\btrain together\b|\bwanna train\b|\bduo\b|\bskill together\b|\bgo together\b/.test(msg)) return text('team', pick(persona.sociability > 0.5 && !isPker(bot) ? TEAM_YES : TEAM_NO));
    if (/\b(you|anyone|any1) (still )?there\b|\bare you there\b|\bare you afk\b|^afk$|\byou afk\b|\bstill there\b/.test(msg)) {
        const doing = asker && Math.random() < 0.5 ? doingShort(bot) : null;
        return text('presence', doing ? pick(PRESENCE_DOING).replace('{doing}', doing) : pick(PRESENCE));
    }
    if (/\bhow much (for|is|do you want for) (your|that|ur)\b|\b(sell|selling) (me )?(your|ur)\b/.test(msg)) return text('not_for_sale', pick(NOT_FOR_SALE));
    if (/\bcan i have\b|\bfree stuff\b|\bgive me\b|\bgimme\b|\bspare (some|any)?\b|\bsome (gp|money|coins)\b|\bany (gp|money)\b|\bdonate\b|\bcan you give me\b/.test(msg)) return text('beg', pick(BEG_NO));
    if (/\b(wanna|want to|lets) trade\b|^trade$|\btrade me\b|\banyone (want to|wanna) trade\b/.test(msg)) return text('trade', pick(isTrader(bot) ? TRADE_YES : TRADE_NO));
    if (/^(selling|buying|wts|wtb)\b/.test(msg)) return isTrader(bot) ? null : text('market', pick(/^(buying|wtb)\b/.test(msg) ? MARKET_BUY_NO : MARKET_SELL_NO));
    if (/^(brb|be right back|afk)$/.test(msg)) return text('brb', pick(BRB_OK));
    if (/\b(nice|cool|sweet|love your|like your) (gear|armour|armor|hat|sword|cape|plate|outfit|set|look|helm|scim|scimitar|bow|staff|shield|legs|boots|weapon|stuff)\b/.test(msg)) return text('gear', pick(GEAR_THANKS));
    if (/\b(being attacked|getting attacked|im dying|i am dying|save me|help me im|help im)\b/.test(msg)) return text('attacked', pick(ATTACKED));
    if (/^(what is up|wassup|wazzup|what is up with you)$/.test(msg)) return text('whatsup', pick(WHATSUP));
    if (/\bhow is it going\b|\bhow you doing\b|\bhow are you doing\b|\bhow are things\b|\byou good\b|\bhow is life\b/.test(msg)) return text('how', pick(HOW));

    // ---- the world: directions, banks, spots, prices, quests, money ----
    if (/\bwhere (is|are) (the |a )?(bank|nearest bank|closest bank)\b|\bnearest bank\b|\bclosest bank\b|\bwhich way (is )?(to )?the bank\b|\bhow do i get to (the|a) bank\b|^bank$/.test(msg)) {
        const bank = nearestBankFor(from.x, from.z);
        if (bank) return text('bank', bankLine(bank, from, pick));
    }
    const spot = spotAsked(msg);
    if (spot) {
        const at = nearestSpot(from.x, from.z, spot.items, spot.npc);
        if (at) return text('spots', spotLine(at, from, pick));
    }
    if (/\bhow (do|can|would) (i|you|one) get to\b|\bhow to get to\b|\bwhere is\b|\bwhich way (is|to)\b|\bway to\b|\bhow far is\b|\bdirections to\b|\bhow do i go to\b/.test(msg)) {
        const town = townIn(msg);
        if (town) return text('directions', townLine(town, from, pick));
    }
    const priced = priceAsked(msg);
    if (priced) {
        const obj = ObjType.get(priced.id);
        if (obj.members && !isMembersWorld()) return text('price', pick(PRICE_MEMBERS));
        // (the review of phase 4: the bunny ears and scythe veterans wear since phase 4 priced "like 1")
        if (!obj.tradeable) return text('price', pick(PRICE_UNTRADEABLE));
        return text('price', pick(obj.stackable ? PRICE_EACH : PRICE).replace('{price}', priceOf(priced.id, bot)));
    }
    if (/\b(what|which|good|best|easy|any) quests?\b.*\b(do|should|start|first|good|easy)\b|\bwhat quest\b|\bwhich quest\b|\bquest (should|to do)\b|\bgood quest\b|\beasy quest\b/.test(msg)) {
        const quest = questFor(asker ?? bot);
        if (quest) return text('quest', pick(QUEST).replace('{quest}', quest));
    }
    const done = /\b(did|have) you (do|done|finish|finished|beat|beaten|complete|completed)\b/.test(msg) ? questIn(msg) : null;
    if (done) return text('quest_done', pick(bot.combatLevel >= done.combat ? QUEST_DONE : QUEST_NOT));
    if (/\b(make|making|get|earn) (money|gp|cash|rich)\b|\bmoney making\b|\bmake some money\b|\bgood money\b|\bfast money\b|\bget rich\b/.test(msg)) {
        return text('money', pick(MONEY).replace('{tip}', moneyTip(asker ?? bot)));
    }

    // ---- newbie questions (port/BotNewbie's, and a human's) ----
    for (const [rx, lines] of NEWBIE_HELP) if (rx.test(msg)) return text('newbie', pick(lines));

    // ---- its levels: "what level is ur wc", "wc lvl?", "whats ur mining", "ur fishing?" ----
    const skill = SKILL_STATS.find(([rx]) => rx.test(msg));
    if (skill) {
        const rest = msg.replace(skill[0], ' ').replace(/\s+/g, ' ').trim();
        const asks = /\b(level|levels)\b/.test(msg) || /^(what is )?your( at| level)?$/.test(rest) || /^how high is your$/.test(rest) || (raw.includes('?') && rest.split(' ').filter(Boolean).length <= 1);
        if (asks) return text('skill', pick(SKILL_LEVEL).replace('{n}', String(bot.baseLevels[skill[1]])));
    }
    return null;
}

/**
 * (realism phase 5b, Track A) "r u a mod", "is there a mod here", "how do i become a mod": the player-mod bot (a bot whose
 * staff level is 1: its silver crown) answers as one, in proper sentences; another bot no, or that it sees one near
 */
function modAnswer(msg: string, bot: Player, pick: Picker): StateAnswer | null {
    if (!/\b(mod|mods|pmod|crown)\b/.test(msg)) return null;
    const isMod = bot.is_bot === true && bot.staffModLevel === 1;
    if (/\bhow (do|can|would) (i|you|one) (become|be|get to be|get) (a )?(player )?mod\b|\bhow (do|can) (i|you) get (a|the|that) crown\b/.test(msg)) return { id: 'mod_how', text: pick(isMod ? MOD_HOW : MOD_HOW_OTHER) };
    if (/\b(are )?you a (player )?mod\b|\bare you (a )?pmod\b/.test(msg)) return { id: 'mod_you', text: pick(isMod ? MOD_YES : MOD_NO) };
    if (/\b(is there|are there|any|anyone|any1) (a |any )?(player )?(mod|mods|pmod)\b/.test(msg)) {
        if (isMod) return { id: 'mod_any', text: pick(MOD_YES) };
        let near = false;
        for (const p of BotManager.activeBots()) {
            if (p !== bot && p.staffModLevel === 1 && p.level === bot.level && Math.max(Math.abs(p.x - bot.x), Math.abs(p.z - bot.z)) <= 15) {
                near = true;
                break;
            }
        }
        return { id: 'mod_any', text: pick(near ? MOD_THERE : MOD_NONE) };
    }
    return null;
}

/** "asl" from the bot: its age, its body's gender, its home */
function fillAsl(template: string, bot: Player, persona: Persona, pick: Picker): string {
    return template.replace('{age}', String(persona.age)).replace('{g}', bot.gender === 1 ? 'f' : 'm').replace('{region}', regionWord(persona, pick));
}

function regionWord(persona: Persona, pick: Picker): string {
    return pick(REGION_WORDS[persona.region] ?? [persona.region]);
}

/** how long it has played, from its total level (the age tier shows in it: port/BotAge) */
function playtimeLines(bot: Player): readonly string[] {
    const total = bot.baseLevels.reduce((sum, level, stat) => (stat === 18 || stat === 19 ? sum : sum + level), 0);
    return PLAYTIME.find(([max]) => total < max)![1];
}

/** what its task does, in a few words, lower case ("cutting willows", "killing cows"), or null (port/BotActivity) */
function doingShort(bot: Player): string | null {
    const task = BotManager.botFor(bot)?.currentTask;
    const what = task ? activityFor(task.name.split(':')[0], task.activityStep()) : null;
    return what ? what.toLowerCase().replace(/ lol$/, '') : null;
}

export function isPker(bot: Player): boolean {
    return bot.botPlanner === 'extras_pker' || bot.botPlanner === 'extras_edgeville_pker';
}

function isTrader(bot: Player): boolean {
    const task = BotManager.botFor(bot)?.currentTask?.name ?? '';
    return bot.botPlanner === 'extras_vendor' || task === 'Bankstand' || task === 'Vendor';
}

/** a short real Follow (port/BotFollow): a sociable bot that is free: a social bot or one standing about */
function willingToFollow(bot: Player, persona: Persona): boolean {
    if (persona.sociability < 0.5 || persona.friendliness < 0) return false;
    // (and not at a set piece: a scam caller's stint, a party, a duel; phase 5b)
    if (bot.botTradeTargetPid !== -1 || bot.botPlanner === 'extras_vendor' || eventRoleOf(bot) !== null) return false;
    const task = BotManager.botFor(bot)?.currentTask?.name.split(':')[0] ?? 'none';
    return bot.botPlanner === 'extras_social' || task === 'Social' || task === 'Idle' || task === 'none';
}

function bankLine(bank: { say: string; x: number; z: number; d: number }, from: Player, pick: Picker): string {
    const dir = compass(bank.x - from.x, bank.z - from.z);
    if (bank.d <= 12) return pick(BANK_HERE).replace('{dir}', dir);
    // (Al Kharid's bank from west of its wall: through the toll gate)
    const toll = bank.say === 'al kharid bank' && from.x < 3268 && Math.random() < 0.5;
    return pick(toll ? BANK_TOLL : BANK).replace('{dir}', dir).replace('{bank}', bank.say);
}

function townLine(town: Town, from: Player, pick: Picker): string {
    if (!isAllowedCoord(town.x, town.z)) return pick(TOWN_MEMBERS);
    const d = chebyshev(from.x, from.z, town.x, town.z);
    if (town.r > 0 && d <= town.r) return pick(TOWN_HERE).replace('{town}', town.say);
    const dir = compass(town.x - from.x, town.z - from.z);
    // an island from the mainland: the boat (Karamja's from Port Sarim)
    if (town.boat && from.x > 2950 && town.x < 2950) return pick(TOWN_BOAT);
    if (d <= 60) return pick(TOWN_NEAR).replace('{dir}', dir);
    // past a town on the way (the one at the midpoint), now and then
    const mid = townAt((from.x + town.x) >> 1, (from.z + town.z) >> 1);
    if (mid && mid !== town && mid !== townAt(from.x, from.z) && Math.random() < 0.4) return pick(TOWN_PAST).replace('{dir}', dir).replace('{mid}', mid.say);
    if (d > 250) return pick(TOWN_FAR).replace('{dir}', dir);
    return pick(TOWN).replace('{dir}', dir).replace('{town}', town.say);
}

/** "where can i mine iron", "where do i fish lobs", "best place to cut willows", "where are the cows" */
function spotAsked(msg: string): { items: number[]; npc: string | null } | null {
    if (!/\bwhere\b|\bbest (place|spot)\b|\bgood (place|spot)\b/.test(msg)) return null;
    const verb = /\b(mine|mining|fish|fishing|cut|cutting|chop|chopping|catch|get|find|kill|killing|train on|are the|is the|are some|are there)\b/.test(msg);
    if (!verb) return null;
    for (const [rx, npc] of SPOT_MONSTERS) if (rx.test(msg)) return { items: [], npc };
    for (const [rx, items] of SPOT_ITEMS) if (rx.test(msg)) return { items, npc: null };
    return null;
}

function spotLine(at: [number, number], from: Player, pick: Picker): string {
    const place = placePhrase(at[0], at[1]);
    const d = chebyshev(from.x, from.z, at[0], at[1]);
    const dir = compass(at[0] - from.x, at[1] - from.z);
    if (!place) return d <= 12 ? pick(BANK_HERE).replace('{dir}', dir) : pick(TOWN).replace('{dir}', dir).replace('{town}', 'it');
    const line = pick(SPOTS).replace('{place}', place.toLowerCase()).replace('{dir}', dir);
    return d <= 12 ? `${line} lol` : line;
}

/** "how much is a rune scim", "pc on lobs", "price of nats", "whats a phat worth", "how much r yews" */
function priceAsked(msg: string): { id: number } | null {
    const m = msg.match(/\b(?:how much (?:is|are|for|do|does|would)|price (?:of|on|for|check on)|pc (?:on|for)?|pc|what is (?:a |an |the )?(.+?) worth|how much (?:you|u) (?:selling|want) (?:for|ur|your)?)\s*(.*)$/);
    if (!m) return null;
    const phrase = (m[1] ?? m[2] ?? '').replace(/\b(worth|go for|going for|sell for|selling for|cost|now|these days|atm|each|ea)\b.*$/, '').trim();
    if (!phrase) return null;
    const words = phrase.split(' ').filter(Boolean);
    const found = itemFromWords(words);
    return found ? { id: found.id } : null;
}

function questFor(asker: Player): string | null {
    const members = isMembersWorld();
    const fits = QUESTS.filter(q => (!q.members || members) && q.combat <= asker.combatLevel && q.combat >= Math.min(40, asker.combatLevel) - 25);
    const pool = fits.length ? fits : QUESTS.filter(q => !q.members && q.combat <= 5);
    return pool[Math.floor(Math.random() * pool.length)]?.say ?? null;
}

function moneyTip(asker: Player): string {
    const row = MONEY_TIPS.find(([max]) => asker.combatLevel < max)!;
    const pool = isMembersWorld() && Math.random() < 0.4 ? row[2] : row[1];
    return pool[Math.floor(Math.random() * pool.length)];
}

/** Every quest and money tip (for test/chat-filter.test.mjs), the towns and banks as said. */
export const ANSWER_WORDS = {
    quests: QUESTS.map(q => q.say),
    money: MONEY_TIPS.flatMap(([, free, members]) => [...free, ...members]),
    towns: TOWNS.map(t => t.say),
    banks: BANKS.map(b => b.say),
    newbie: NEWBIE_HELP.flatMap(([, lines]) => lines),
    regions: Object.values(REGION_WORDS).flat()
};
