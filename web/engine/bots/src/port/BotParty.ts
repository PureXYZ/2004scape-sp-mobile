// port (the realism work, phase 5b, Track P: drop parties and the Seers' Party Room; spec
// the research, "Round 5b", the defaults chosen; research
// the research): two set pieces (port/BotSetPieces), both with cheap real items the human can
// pick up ("drop parties, including the members Seers' Party Room").
//
//   drop_party  (both worlds) at the busiest of Falador park, Varrock square and Lumbridge's courtyard (the bots within
//               60 tiles of each at the start: never the human's place). A host near it with 3k+ coins banks for a kit of
//               its own things (2-10k: cheap runes, arrows, feathers, produce, old gear, a coin pile; 12-28 piles), walks
//               there and calls it out 2-3 times over a 3-5 minute lead ("drop party fally park 5 min!!!"), then drops
//               the kit pile by pile (the item's own Drop: [opheld5] ~dropslot) stepping about a 5x5 square. 274 keeps a
//               player's drop private for 100 ticks: then every pile shows for everyone at once and the crowd and the human
//               scramble (tasks/PartyGuestTask: a guest's first grab 2-6 ticks after the reveal, then one every 2-4 ticks,
//               2-5 items, with the item's own Take: [opobj3]).
//   party_room  (members) in Seers' Village: a host within 120 tiles banks at Seers for a kit (5-20k) and the lever's 1,000
//               coins, calls it at the bank and in the room, puts the kit in the chest (the chest's own deposit window,
//               8 slots an accept), pulls the lever (its dialogue: Balloon Bonanza, 1,000 coins, Party Pete within 16
//               tiles), and the guests pop the 200 balloons (each pop's item, 1 in 4, is the popper's alone: 274's
//               inv_dropitem). 1 party in 4 the knights' Nightly Dance too (500 coins).
//
// Guests: free bots within 60 tiles (the director's freeBots: not busy, not a newbie, a session of 30+ minutes left),
// each joining with chance 0.4 + 0.4 x sociability, at most 15 (25 above 100 online), their walks spread over the lead
// (one from further off sets off early enough for the drop). The Party Room asks within 250 tiles over a lead of 5-9
// minutes and needs 3 who come ("bigger Party Room parties", 2026-10-17: Seers' 60 tiles gave 1-2 guests).
// They resume their own task after (their part is a sub-task). The host's part is a sub-task too: its own task waits.
//
// No profit loop: the kit is the host's own bank, never bought or made; the lever's coins are a sink; nothing goes back to
// the host. The kit leaves out tools, rares, untradeables and (on a free world) members items (those never reveal).
//
// The log (partyLog): each party's guests, peak crowd, drops and who took them when, the chest and the balloons, for the
// humanlike report's DP1-DP5 and the tests.
import type Player from '#/engine/entity/Player.js';
import Obj from '#/engine/entity/Obj.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import ObjType from '#/cache/config/ObjType.js';
import InvType from '#/cache/config/InvType.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { eventRoleOf, register, setPieceLog, nextSetPieceId, type SetPieceContext, type SetPieceDef, type SetPiecePhase, type SetPiecePlan, type SetPieceRun, type SetPieceVenue } from '#/engine/bot/port/BotSetPieces.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { isRare, itemValue } from '#/engine/bot/port/BotPrices.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { isNewbie, lumbridgeLowLevel } from '#/engine/bot/port/BotNewbie.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { botPersona } from '#/engine/bot/port/BotTiming.js';
import { nameSeed } from '#/engine/bot/port/BotSeed.js';
import { anyPieceLine, sayPieceLine } from '#/engine/bot/port/BotPieceLines.js';
import { scheduleInTicks } from '#/engine/bot/port/BotSchedule.js';
import { bankedId, moveItems } from '#/engine/bot/port/BotInventoryCompat.js';
import { PartyHostTask } from '#/engine/bot/tasks/PartyHostTask.js';
import { PartyGuestTask } from '#/engine/bot/tasks/PartyGuestTask.js';
import { hangoutOf } from '#/engine/bot/port/BotHangout.js';
import partyJson from '../../data/party.json';

// ── the data ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type PartyKind = 'drop_party' | 'party_room';

export interface PartyVenue extends SetPieceVenue {
    kind: PartyKind;
    members?: boolean;
    /** the middle of the square the host drops in (F2P), the room's middle (the Party Room) */
    drop: [number, number];
    /** the Party Room: its box (x0, z0, x1, z1), chest, lever, Party Pete's spot, the Seers' bank */
    room?: [number, number, number, number];
    chest?: [number, number];
    lever?: [number, number];
    pete?: [number, number];
    bank?: [number, number];
}

interface PartyJson {
    venues: (Omit<PartyVenue, 'level'> & { level?: number })[];
    stackable: string[];
    produce: string[];
    gearMetals: string[];
    betterMetals: string[];
    betterRunes: Record<string, number>;
    tools: string[];
    defaults: PartyDefaults;
}

export interface PartyDefaults {
    budget: Record<PartyKind, [number, number]>;
    drops: Record<PartyKind, [number, number]>;
    betterChance: number;
    betterMax: number;
    coinShare: [number, number];
    jokeCoinChance: number;
    hostCoins: number;
    lever: number;
    knights: number;
    knightsChance: number;
    lead: Record<PartyKind, [number, number]>;
    /** guests asked from this far ("bigger Party Room parties", 2026-10-17: Seers' 60 tiles held 0-4 free bots
     * at 100 online, 150 hardly more; 250 takes in Catherby, Camelot, the Fishing Guild and East Ardougne, with a lead of
     * 5-9 minutes for the walk, and 3 who come or no party) */
    guestRadius: Record<PartyKind, number>;
    hostRadius: Record<PartyKind, number>;
    guestCap: [number, number];
    joinChance: [number, number];
    minGuests: Record<PartyKind, number>;
    /** the guests who must say yes for a party to begin */
    minComing: Record<PartyKind, number>;
    hostSessionLeft: number;
    guestSessionLeft: number;
    firstGrab: [number, number];
    grabGap: [number, number];
    takes: [number, number];
    pops: [number, number];
    popGap: [number, number];
    runTicks: number;
}

const DATA = partyJson as unknown as PartyJson;
/** the defaults (data/party.json); the tests may change a copy (setPartyDefaultsForTest) */
export const PARTY: PartyDefaults = JSON.parse(JSON.stringify(DATA.defaults)) as PartyDefaults;

export const VENUES: readonly PartyVenue[] = DATA.venues.map(v => ({ ...v, level: v.level ?? 0 }));

/** the item names of the data (the tests check every one resolves in 274) */
export const KIT_NAMES: readonly string[] = [...DATA.stackable, ...DATA.produce, ...Object.keys(DATA.betterRunes)];

const COINS_NAME = 'coins';
/** the Party Room: a stack in the chest at most this many (a pop drops 1 to all of it), a note at most this many */
const ROOM_STACK = 25;
const ROOM_NOTES = 15;

// ── small dice ───────────────────────────────────────────────────────────────────────────────────────────────────

function randIn([lo, hi]: readonly [number, number], random: () => number = Math.random): number {
    return lo + Math.floor(random() * (hi - lo + 1));
}

function logUniform([lo, hi]: readonly [number, number], random: () => number): number {
    return Math.round(Math.exp(Math.log(lo) + random() * (Math.log(hi) - Math.log(lo))));
}

function shuffled<T>(list: readonly T[], random: () => number): T[] {
    return list.map(x => ({ x, k: random() })).sort((a, b) => a.k - b.k).map(e => e.x);
}

const cheb = (ax: number, az: number, bx: number, bz: number): number => Math.max(Math.abs(ax - bx), Math.abs(az - bz));

// ── the kit ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type KitClass = 'stackable' | 'produce' | 'gear' | 'better';

/** one pile of the kit: `count` of item `id` (as it is in the bank), carried as `as` (a note: its id; else `id`) */
export interface KitPick {
    id: number;
    as: number;
    count: number;
    /** coins: its value */
    value: number;
    cls: KitClass;
}

export interface Kit {
    picks: KitPick[];
    /** the coin pile (0: none) */
    coins: number;
    /** the kit's value, coins included (port/BotPrices.itemValue) */
    value: number;
    /** piles dropped (F2P) or chest slots (the Party Room): a stack or a note is one, a single item one each */
    drops: number;
    budget: number;
    better: boolean;
    /** coins the host keeps in its pack for the lever (and the knights) */
    leverCoins: number;
    knights: boolean;
}

/** debugname sets, made once the packs are loaded */
let classes: { stackable: Set<string>; produce: Set<string>; tools: RegExp; gear: RegExp; better: RegExp; betterRunes: Map<string, number> } | null = null;
function kitClasses() {
    if (!classes) {
        classes = {
            stackable: new Set(DATA.stackable),
            produce: new Set(DATA.produce),
            tools: new RegExp(`(^|_)(${DATA.tools.join('|')})$`),
            gear: new RegExp(`^(${DATA.gearMetals.join('|')})_`),
            better: new RegExp(`^(${DATA.betterMetals.join('|')})_`),
            betterRunes: new Map(Object.entries(DATA.betterRunes))
        };
    }
    return classes;
}

/** The kit class of an item (its own id, not a note's), or null: never a tool, a rare, an untradeable, nor a members item on a free world. */
export function kitClassOf(id: number, members = isMembersWorld()): KitClass | null {
    const type = ObjType.get(id);
    if (!type || !type.tradeable || (type.members && !members) || isRare(id) || type.certtemplate !== -1) return null;
    const name = type.debugname ?? '';
    const c = kitClasses();
    if (c.tools.test(name)) return null;
    if (c.stackable.has(name) && type.stackable) return 'stackable';
    if (c.produce.has(name) && !type.stackable) return 'produce';
    if (c.betterRunes.has(name) && members) return 'better';
    if (type.wearpos === -1 || type.stackable) return null;
    if (c.gear.test(name)) return 'gear';
    if (c.better.test(name)) return 'better';
    return null;
}

/** what the bot owns in its bank and pack (as the bank keeps it: a note as its item), tools and worn items left out */
function owned(bot: Player): Map<number, number> {
    const out = new Map<number, number>();
    for (const invId of [bankInvIdOf(), InvType.INV]) {
        const inv = invId === -1 ? null : bot.getInventory(invId);
        for (let s = 0; inv && s < inv.capacity; s++) {
            const item = inv.get(s);
            if (!item) continue;
            const id = bankedId(item.id);
            out.set(id, (out.get(id) ?? 0) + item.count);
        }
    }
    return out;
}

let bankId = -2;
function bankInvIdOf(): number {
    if (bankId === -2) bankId = InvType.getId('bank');
    return bankId;
}

let coinsId = -2;
export function coinsItem(): number {
    if (coinsId === -2) coinsId = ObjType.getId(COINS_NAME);
    return coinsId;
}

/** The coins the bot owns (bank and pack). */
export function coinsOwned(bot: Player): number {
    return owned(bot).get(coinsItem()) ?? 0;
}

/** a note's id for an item that has one (the bank's "withdraw as note"), else the item's */
function noteOf(id: number): number {
    const type = ObjType.get(id);
    return type.certtemplate === -1 && type.certlink >= 0 ? type.certlink : id;
}

/**
 * A host's kit for a party of `kind` from what it owns (port: its bank and pack), or null when it is too thin (fewer
 * piles than the kind's least, or too few coins: 3k, the lever's on top in the Party Room). The budget is drawn
 * log-uniform; stackables a pile each, sized to the budget's share of a pile; produce single (F2P) or, in the Party
 * Room, a note when one is worth under 100 (Pete throws out a cheap single); gear single; 1 party in 10 one better item;
 * then a coin pile (now and then a joke one) topped up toward the budget.
 */
export function planKit(bot: Player, kind: PartyKind, random: () => number = Math.random, opts: { better?: boolean; knights?: boolean; joke?: boolean } = {}): Kit | null {
    const D = PARTY;
    const members = isMembersWorld();
    const have = owned(bot);
    const coins = coinsItem();
    const coinsHave = have.get(coins) ?? 0;
    const knights = kind === 'party_room' && (opts.knights ?? random() < D.knightsChance);
    const leverCoins = kind === 'party_room' ? D.lever + (knights ? D.knights : 0) : 0;
    if (coinsHave < D.hostCoins + leverCoins) return null;
    const budget = logUniform(D.budget[kind], random);
    // (the pack holds the piles: 28 slots, its tools kept)
    const maxDrops = kind === 'drop_party' ? 28 - toolsCarried(bot) : 26;
    const target = Math.min(maxDrops - 1, randIn(D.drops[kind], random));
    // (the coin pile's share kept back: now and then a joke pile instead, "lol 1 coin drop")
    const joke = opts.joke ?? random() < D.jokeCoinChance;
    const coinPart = joke ? 0 : Math.round(budget * (D.coinShare[0] + random() * (D.coinShare[1] - D.coinShare[0])));
    const itemsBudget = budget - coinPart;
    const perDrop = itemsBudget / Math.max(1, target - 1);
    const room = kind === 'party_room';

    const byClass: Record<KitClass, number[]> = { stackable: [], produce: [], gear: [], better: [] };
    for (const [id, n] of have) {
        if (id === coins || n <= 0) continue;
        const cls = kitClassOf(id, members);
        if (cls) byClass[cls].push(id);
    }
    const picks: KitPick[] = [];
    let drops = 0;
    let value = 0;
    const left = new Map(have);
    const take = (id: number, as: number, count: number, cls: KitClass, piles: number) => {
        const v = itemValue(id) * count;
        picks.push({ id, as, count, value: v, cls });
        left.set(id, (left.get(id) ?? 0) - count);
        drops += piles;
        value += v;
    };

    // 1 party in 10 adds one better item (a mithril or adamant piece, or natures on members) worth at most 30k, on top
    // of the budget
    let better = false;
    let betterValue = 0;
    if (opts.better ?? random() < D.betterChance) {
        for (const id of shuffled(byClass.better, random)) {
            const name = ObjType.get(id).debugname ?? '';
            const runes = kitClasses().betterRunes.get(name);
            const count = runes !== undefined ? Math.min(runes, left.get(id) ?? 0) : 1;
            if (count <= 0 || itemValue(id) * count > D.betterMax) continue;
            take(id, id, count, 'better', 1);
            better = true;
            betterValue = itemValue(id) * count;
            value -= betterValue;
            break;
        }
    }
    // stackables: a pile each (2-5 kinds; in the Party Room 1-3, at most 25 of each: a pop drops part of a stack, and
    // a big one would outlast the balloons), its size a pile's share of the budget
    for (const id of shuffled(byClass.stackable, random).slice(0, randIn(room ? [1, 3] : [2, 5], random))) {
        if (drops >= target || value >= itemsBudget) break;
        const unit = itemValue(id);
        const count = Math.max(1, Math.min(left.get(id) ?? 0, room ? ROOM_STACK : Infinity, Math.ceil((itemsBudget - value) / unit), Math.round((perDrop / unit) * (0.5 + random()))));
        if (count > 0) take(id, id, count, 'stackable', 1);
    }
    // produce and old gear, a few of each kind, those nearest a pile's share first (a single worth over three shares,
    // or over what is left of the budget, is no party's), until the piles or the budget are reached
    const fit = (id: number) => Math.abs(Math.log(itemValue(id) / perDrop)) + random();
    const singles = [...byClass.produce, ...byClass.gear].map(id => ({ id, k: fit(id) })).sort((a, b) => a.k - b.k).map(e => e.id);
    let kindsLeft = singles.length;
    for (const id of singles) {
        kindsLeft--;
        if (drops >= target || value >= itemsBudget) break;
        const unit = itemValue(id);
        const avail = left.get(id) ?? 0;
        if (avail <= 0) continue;
        const cls: KitClass = byClass.gear.includes(id) ? 'gear' : 'produce';
        if (room && unit < 100) {
            // (the Party Room: a cheap single would be Pete's "Reject!"; a note is left alone and drops a part a pop)
            if (cls === 'gear') continue;
            const count = Math.max(1, Math.min(avail, ROOM_NOTES, Math.ceil((itemsBudget - value) / unit), Math.round((perDrop / unit) * (0.5 + random()))));
            take(id, noteOf(id), count, 'produce', 1);
            continue;
        }
        if (unit > Math.max(150, 3 * perDrop)) continue;
        // (1-4 of a kind; more of each when few kinds are left: a thin bank still makes its piles)
        const want = Math.max(randIn([1, 4], random), Math.ceil((target - drops) / Math.max(1, kindsLeft + 1)));
        const n = Math.min(avail, cls === 'gear' ? 1 : want, target - drops, Math.floor((itemsBudget - value) / unit));
        if (n > 0) take(id, id, n, cls, n);
    }
    // the coin pile: its share, topped up toward the budget when the bank was thin (but never most of it: one pile the
    // whole party's worth is a jackpot, not a party), or the joke pile; the host keeps the lever's coins
    let pile = joke ? randIn([1, 10], random) : Math.max(0, Math.min(Math.max(coinPart, Math.round(budget * 0.5)), Math.round(budget - value)));
    pile = Math.max(0, Math.min(pile, coinsHave - leverCoins - 1));
    if (pile > 0 && drops < maxDrops) {
        drops++;
        value += pile;
    } else pile = 0;
    const least = kind === 'drop_party' ? D.drops.drop_party[0] : D.drops.party_room[0];
    if (drops < least) return null;
    return { picks, coins: pile, value: value + betterValue, drops, budget, better, leverCoins, knights };
}

/** the tools in the pack (kept there while the kit is carried) */
function toolsCarried(bot: Player): number {
    const inv = bot.getInventory(InvType.INV);
    let n = 0;
    for (let s = 0; inv && s < inv.capacity; s++) {
        const item = inv.get(s);
        if (item && isTool(item.id)) n++;
    }
    return n;
}

/** a tool the bot keeps in its pack through a party (an axe, a pickaxe, a net, a tinderbox ...) */
export function isTool(id: number): boolean {
    return kitClasses().tools.test(ObjType.get(id)?.debugname ?? '');
}

/**
 * At the bank (its window open: the booth's Use-quickly), the pack goes in but its tools, and the kit comes out: each pick
 * as planned (a note through the bank's withdraw-as-note), the coin pile and the lever's coins. What came out (the
 * picks with their counts as taken: the bank may have changed since the plan), or null when too little did.
 */
export function withdrawKit(bot: Player, kit: Kit): Kit | null {
    const bid = bankInvIdOf();
    const inv = bot.getInventory(InvType.INV);
    const bank = bid === -1 ? null : bot.getInventory(bid);
    if (!inv || !bank) return null;
    let unbanked = false;
    for (let s = 0; s < inv.capacity; s++) {
        const item = inv.get(s);
        if (!item || isTool(item.id)) continue;
        const moved = inv.remove(item.id, item.count);
        if (moved <= 0) continue;
        // (a full bank keeps what it cannot take in the pack)
        const added = bank.add(bankedId(item.id), moved);
        if (added < moved) {
            inv.add(item.id, moved - added);
            unbanked = true;
        }
    }
    // (a full bank: what stayed in the pack would go out with the kit, the host's own things with it: no party)
    if (unbanked) return null;
    const picks: KitPick[] = [];
    let drops = 0;
    let value = 0;
    for (const pick of kit.picks) {
        let got = 0;
        if (pick.as !== pick.id) {
            // (withdraw-as-note: the items leave the bank, their note comes into the pack)
            const removed = bank.remove(pick.id, pick.count);
            if (removed > 0) {
                const added = inv.add(pick.as, removed);
                if (added < removed) bank.add(pick.id, removed - added);
                got = added;
            }
        } else got = moveItems(bank, inv, pick.id, pick.count);
        if (got <= 0) continue;
        const stack = ObjType.get(pick.as).stackable;
        picks.push({ ...pick, count: got, value: itemValue(pick.id) * got });
        drops += stack ? 1 : got;
        value += itemValue(pick.id) * got;
    }
    const coins = coinsItem();
    const wanted = kit.coins + kit.leverCoins;
    const gotCoins = wanted > 0 ? moveItems(bank, inv, coins, wanted) : 0;
    const pile = Math.max(0, Math.min(kit.coins, gotCoins - kit.leverCoins));
    if (pile > 0) {
        drops++;
        value += pile;
    }
    const least = kit.leverCoins > 0 ? PARTY.drops.party_room[0] : PARTY.drops.drop_party[0];
    if (drops < Math.min(least, kit.drops) || gotCoins < kit.leverCoins) return null;
    return { ...kit, picks, coins: pile, drops, value };
}

// ── the log ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** one pile dropped (F2P): when, when 274 showed it to all, when it went and to whom */
export interface DropNote {
    item: string;
    count: number;
    t: number;
    /** 274's reveal: the drop's tick + 100 (an item that cannot reveal: -1) */
    revealAt: number;
    goneAt: number;
    /** 'bot' (a guest took it: `name`), 'other' (gone before its time: the human, a passer-by), 'despawned', or null (still there) */
    by: 'bot' | 'other' | 'despawned' | null;
    name: string | null;
}

export interface PartyRecord {
    id: number;
    kind: PartyKind;
    venue: string;
    host: string;
    start: number;
    end: number;
    outcome: string;
    budget: number;
    kitValue: number;
    kitDrops: number;
    better: boolean;
    joke: boolean;
    /** guests asked, came (reached the venue), left early */
    asked: number;
    came: number;
    /**
     * (the variety work, round 1, track F: ISS-3) asked guests not free at their moment and asked again (retries), given
     * up (lost: the next of the pool asked in their place), and passers-by who joined at the build-up or the drop
     * (walk-ins: started, and came)
     */
    retries?: number;
    lost?: number;
    replaced?: number;
    walkIns?: number;
    walkInsCame?: number;
    peak: number;
    /** the bots (not the host) within 8 tiles of the venue at the peak, sampled every 5 ticks: the most */
    lines: number;
    drops: DropNote[];
    /** the Party Room: the chest's filled slots before and after the deposit and at the end; the lever, the knights */
    chest: { before: number; after: number; end: number } | null;
    lever: boolean;
    knights: boolean;
    pops: { host: number; guests: number; items: number };
    /** what the host's own pops gave it (its own kit back: 274 gives a pop's item to the popper) */
    hostGot: { item: string; count: number }[];
    /** the bots of the party still at the venue 10 minutes after it ended (stuck), -1 until then */
    stuckAfter: number;
}

const LOG_MAX = 500;
/** every party since the world started (a capped ring): the humanlike report and the tests */
export const partyLog: PartyRecord[] = [];

// ── the run ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** an object (a drop, a balloon) a guest is after: no other guest goes for it */
const CLAIM_TICKS = 15;

/** the bots (not `except`) within `r` tiles of (x, z) on `level` (the zones there) */
export function botsNear(x: number, z: number, level: number, r: number, except: Player | null = null): Player[] {
    const out: Player[] = [];
    for (let zx = (x - r) >> 3; zx <= (x + r) >> 3; zx++) {
        for (let zz = (z - r) >> 3; zz <= (z + r) >> 3; zz++) {
            for (const p of World.gameMap.getZone(zx << 3, zz << 3, level).getAllPlayersSafe()) {
                if (p !== except && p.is_bot && p.level === level && cheb(p.x, p.z, x, z) <= r) out.push(p);
            }
        }
    }
    return out;
}

/** a bot's sub-task now (BotPlayer keeps it private) */
function subTaskOf(bot: Player): unknown {
    return (bot as unknown as { _bot?: { subTask?: unknown } })._bot?.subTask ?? null;
}

export class PartyRun implements SetPieceRun {
    readonly id: number;
    readonly kind: PartyKind;
    readonly venue: PartyVenue;
    phase: SetPiecePhase = 'announce';
    readonly startedAt: number;
    endsBy: number;
    readonly roles = new Map<Player, string>();
    readonly host: Player;
    readonly hostTask: PartyHostTask;
    /** the kit as planned, then as withdrawn */
    kit: Kit;
    /** the tick the host drops (F2P) or opens the chest (the Party Room): the lead's end */
    readonly dropAt: number;
    readonly record: PartyRecord;
    /** guests not yet on their way: when each sets off, and the last moment it may (its walk before the drop) */
    private readonly pending: { bot: Player; at: number; latest: number }[] = [];
    /** (variety round 1, F: ISS-3) the pool's bots not asked at the start: the next asked in a lost guest's place */
    reserve: Player[] = [];
    readonly guests = new Map<Player, PartyGuestTask>();
    /** the piles dropped (F2P), their objects */
    readonly drops: { obj: Obj; note: DropNote }[] = [];
    firstDropAt = -1;
    lastDropAt = -1;
    /** the host has dropped everything (F2P) or the balloons are falling (the Party Room) */
    dropsDone = false;
    balloonsAt = -1;
    private readonly claims = new Map<object, { bot: Player; until: number }>();
    /** guest lines said (a party's crowd says a few, not a stream) */
    guestLines = 0;
    private finished = false;

    constructor(plan: SetPiecePlan, host: Player, kit: Kit, venue: PartyVenue) {
        const now = World.currentTick;
        this.id = nextSetPieceId();
        this.kind = venue.kind;
        this.venue = venue;
        this.startedAt = now;
        this.host = host;
        this.kit = kit;
        this.dropAt = now + randIn(PARTY.lead[this.kind]);
        // (a lead longer than a drop party's, the Party Room's 5-9 minutes for its guests' walk, adds to its time)
        this.endsBy = now + PARTY.runTicks + Math.max(0, this.dropAt - now - PARTY.lead.drop_party[1]);
        this.hostTask = new PartyHostTask(this);
        this.roles.set(host, 'host');
        this.record = {
            id: this.id,
            kind: this.kind,
            venue: venue.key,
            host: host.username,
            start: now,
            end: -1,
            outcome: 'running',
            budget: kit.budget,
            kitValue: kit.value,
            kitDrops: kit.drops,
            better: kit.better,
            joke: kit.coins > 0 && kit.coins <= 10,
            asked: 0,
            came: 0,
            retries: 0,
            lost: 0,
            replaced: 0,
            walkIns: 0,
            walkInsCame: 0,
            peak: 0,
            lines: 0,
            drops: [],
            chest: venue.kind === 'party_room' ? { before: -1, after: -1, end: -1 } : null,
            lever: false,
            knights: false,
            pops: { host: 0, guests: 0, items: 0 },
            hostGot: [],
            stuckAfter: -1
        };
        void plan;
        partyLog.push(this.record);
        if (partyLog.length > LOG_MAX) partyLog.shift();
    }

    /** a guest sets off at `at` (its walk spread over the lead), and asked again till `latest` if it is busy then */
    addGuest(bot: Player, at: number, latest = at): void {
        this.pending.push({ bot, at, latest: Math.max(at, latest) });
        this.record.asked++;
    }

    /** (variety round 1, F) the last moment a guest at (x, z) may set off to be there for the drop */
    latestFor(bot: Player): number {
        const [dx, dz] = this.venue.drop;
        return this.dropAt - (Math.round(1.3 * Math.max(Math.abs(bot.x - dx), Math.abs(bot.z - dz))) + 20);
    }

    // ── the director's calls ──

    tick(now: number): void {
        if (this.phase === 'done') return;
        if (now >= this.endsBy) return this.abort('timeout');
        if (!this.hostHere(now)) return this.abort('host left');
        for (let i = this.pending.length - 1; i >= 0; i--) {
            const g = this.pending[i];
            if (g.at > now) continue;
            this.pending.splice(i, 1);
            if (this.startGuest(g.bot)) continue;
            // port (the variety work, round 1, track F: ISS-3): busy at its moment (a bank stop, its pack, a random event):
            // asked again GUEST_RETRY_TICKS on while it can still be there for the drop; then the next of the pool in its
            // place. It was dropped silently: parties stayed at 2-5 bots
            if (g.bot.slot !== -1 && now + GUEST_RETRY_TICKS <= g.latest) {
                this.pending.push({ ...g, at: now + GUEST_RETRY_TICKS });
                this.record.retries = (this.record.retries ?? 0) + 1;
            } else {
                this.record.lost = (this.record.lost ?? 0) + 1;
                this.replaceGuest(now);
            }
        }
        this.walkIns(now);
        for (const [bot, task] of [...this.guests]) {
            if (task.isComplete(bot)) continue;
            if (bot.slot === -1 || !BotManager.isActiveBot(bot.username)) this.left(bot, 'logout');
            else if (subTaskOf(bot) !== task && now - task.lastTick > 30) this.left(bot, 'stuck');
        }
        this.phase = this.hostTask.phase;
        if (this.phase === 'build' || this.phase === 'peak') {
            const [x, z] = this.venue.drop;
            this.record.peak = Math.max(this.record.peak, botsNear(x, z, this.venue.level, 8, this.host).length);
        }
        this.updateDrops(now);
        if (this.hostTask.isComplete(this.host)) this.finish('done');
    }

    left(p: Player, why: 'logout' | 'death' | 'fight' | 'stuck'): void {
        if (p === this.host) {
            this.abort(`host ${why}`);
            return;
        }
        const task = this.guests.get(p);
        if (task) task.finish();
        this.guests.delete(p);
        this.roles.delete(p);
    }

    rumour(): string | null {
        if (this.phase !== 'announce' && this.phase !== 'build' && this.phase !== 'peak') return null;
        return anyPieceLine('party-rumour', this.venue.key);
    }

    abort(why: string): void {
        if (this.finished) return;
        // (the host gone: a guest there says so now and then)
        if (why.startsWith('host')) {
            const there = [...this.guests.keys()].filter(g => g.slot !== -1 && cheb(g.x, g.z, this.venue.drop[0], this.venue.drop[1]) <= 10);
            if (there.length && Math.random() < 0.6) this.guestLine(there[Math.floor(Math.random() * there.length)], 'host-gone', true);
        }
        this.finish(why);
    }

    // ── the roles' calls ──

    /** a guest line, within the party's few (`always`: past the cap) */
    guestLine(bot: Player, kind: string, always = false): boolean {
        if (!always && this.guestLines >= this.guestLineCap()) return false;
        if (sayPieceLine(bot, 'party', kind, 'setpiece') === null) return false;
        this.guestLines++;
        this.record.lines++;
        return true;
    }

    /** a host's call: those before the party (its adverts: call-first, call-soon, call-again) in its colour, the rest plain */
    hostLine(kind: string, opts: { wave?: boolean } = {}): boolean {
        const advert = /^call-(first|soon|again)/.test(kind);
        const style = !advert ? undefined : opts.wave ? { colour: hostColour(this.host), effect: 1 } : hostColour(this.host) ? { colour: hostColour(this.host) } : undefined;
        if (sayPieceLine(this.host, 'party', kind, 'setpiece', { style }) === null) return false;
        this.record.lines++;
        return true;
    }

    private guestLineCap(): number {
        return 4 + Math.min(8, this.guests.size);
    }

    /** a guest takes aim at an object (a pile, a balloon): no other guest goes for it a while */
    claim(target: object, bot: Player): boolean {
        const now = World.currentTick;
        const c = this.claims.get(target);
        if (c && c.bot !== bot && c.until > now && c.bot.slot !== -1) return false;
        this.claims.set(target, { bot, until: now + CLAIM_TICKS });
        return true;
    }

    isClaimed(target: object, bot: Player): boolean {
        const c = this.claims.get(target);
        return !!c && c.bot !== bot && c.until > World.currentTick && c.bot.slot !== -1;
    }

    /** the host dropped a pile: its object (found on the host's tile, private to it) */
    noteDrop(obj: Obj): void {
        const now = World.currentTick;
        const type = ObjType.get(obj.type);
        const reveals = type.tradeable && (!type.members || isMembersWorld());
        const note: DropNote = { item: type.debugname ?? String(obj.type), count: obj.count, t: now, revealAt: reveals ? now + Obj.REVEAL : -1, goneAt: -1, by: null, name: null };
        this.drops.push({ obj, note });
        this.record.drops.push(note);
        if (this.firstDropAt < 0) this.firstDropAt = now;
        this.lastDropAt = now;
    }

    /** the first pile shows for everyone (F2P), or -1 */
    get firstRevealAt(): number {
        return this.firstDropAt < 0 ? -1 : this.firstDropAt + Obj.REVEAL;
    }

    get lastRevealAt(): number {
        return this.lastDropAt < 0 ? -1 : this.lastDropAt + Obj.REVEAL;
    }

    /** a guest took a pile (its pack holds it now) */
    noteTake(obj: Obj, bot: Player): void {
        const d = this.drops.find(x => x.obj === obj);
        if (!d || d.note.by !== null) return;
        d.note.by = 'bot';
        d.note.name = bot.username;
        d.note.goneAt = World.currentTick;
    }

    private updateDrops(now: number): void {
        for (const { obj, note } of this.drops) {
            if (note.by !== null || obj.isActive) continue;
            note.goneAt = now;
            // (274 removes an untaken pile 300 ticks after the drop: ~dropslot's duration)
            note.by = now >= note.t + 295 ? 'despawned' : 'other';
        }
    }

    hostHere(now: number): boolean {
        const h = this.host;
        if (h.slot === -1 || !BotManager.isActiveBot(h.username)) return false;
        return subTaskOf(h) === this.hostTask || now - this.hostTask.lastTick <= 60;
    }

    /** a guest sets off now (its part: a sub-task); false when it is not free to (no part given) */
    private startGuest(bot: Player, walkIn = false): boolean {
        if (this.phase === 'end' || this.phase === 'done') return false;
        const ai = BotManager.botFor(bot);
        // (variety round 1, F: ISS-3) a hang-out it stands in is given up for the party, as a player there would
        if (!ai || bot.slot === -1 || (ai.hasSubTask() && !inHangout(bot)) || eventRoleOf(bot) !== null || !(walkIn ? walkInFree(bot) : guestFree(bot))) return false;
        const task = new PartyGuestTask(this, walkIn);
        ai.setSubTask(task);
        this.guests.set(bot, task);
        this.roles.set(bot, 'guest');
        return true;
    }

    /** (variety round 1, F: ISS-3) a lost guest's place: the next of the pool still free, asked to set off a moment later */
    private replaceGuest(now: number): void {
        while (this.reserve.length > 0) {
            const bot = this.reserve.shift()!;
            if (bot.slot === -1 || this.roles.has(bot) || !guestFree(bot)) continue;
            const latest = this.latestFor(bot);
            if (latest < now + 2) continue;
            this.addGuest(bot, now + Math.min(latest - now, 2 + Math.floor(Math.random() * 10)), latest);
            this.record.replaced = (this.record.replaced ?? 0) + 1;
            return;
        }
    }

    /**
     * (variety round 1, F: ISS-3, the walk-ins) at the build-up and the drop, passers-by within WALK_IN_TILES (free
     * levelling bots and the social regulars of the place) join now and then, as 2004's drop parties pulled in whoever
     * heard the calls: a guest's part, not asked. At most WALK_IN_MOST a party; the party's guests and the cap first.
     */
    private walkIns(now: number): void {
        if (this.phase !== 'build' && this.phase !== 'peak') return;
        if ((this.record.walkIns ?? 0) >= WALK_IN_MOST || now < this.nextWalkIn) return;
        this.nextWalkIn = now + WALK_IN_EVERY;
        const [x, z] = this.venue.drop;
        for (const bot of botsNear(x, z, this.venue.level, WALK_IN_TILES, this.host)) {
            if ((this.record.walkIns ?? 0) >= WALK_IN_MOST) break;
            if (this.roles.has(bot) || !walkInFree(bot)) continue;
            if (Math.random() >= walkInChance * (0.5 + botPersona(bot).sociability)) continue;
            if (this.startGuest(bot, true)) this.record.walkIns = (this.record.walkIns ?? 0) + 1;
        }
    }
    private nextWalkIn = -1;

    /** a guest reached the venue (an asked one: `came`; a walk-in apart) */
    noteArrived(walkIn = false): void {
        if (walkIn) this.record.walkInsCame = (this.record.walkInsCame ?? 0) + 1;
        else this.record.came++;
    }

    private finish(outcome: string): void {
        if (this.finished) return;
        this.finished = true;
        const now = World.currentTick;
        this.phase = 'done';
        this.record.end = now;
        this.record.outcome = outcome;
        this.hostTask.finish();
        for (const task of this.guests.values()) task.finish();
        this.updateDrops(now);
        if (this.record.chest) this.record.chest.end = chestSlotsFilled();
        // (the director's record of the run, when it keeps one: this party's detail)
        const entry = setPieceLog.find(e => e.id === this.id);
        if (entry) entry.detail = { ...(entry.detail ?? {}), party: this.record };
        // DP5: who of the party still stands at the venue 10 minutes on (stuck)
        const bots = [this.host, ...this.guests.keys()];
        const at = new Map(bots.map(b => [b, [b.x, b.z] as [number, number]]));
        scheduleInTicks(1000, () => {
            let stuck = 0;
            for (const b of bots) {
                const [x0, z0] = at.get(b)!;
                if (b.slot === -1 || !BotManager.isActiveBot(b.username)) continue;
                if (cheb(b.x, b.z, this.venue.drop[0], this.venue.drop[1]) <= 8 && cheb(b.x, b.z, x0, z0) <= 2 && !atHomeHere(b, this.venue)) stuck++;
            }
            this.record.stuckAfter = stuck;
        });
    }
}

/**
 * a social regular whose hub is the venue stands there anyway (Varrock square, Falador park; since the variety work's
 * round 1, track F, Lumbridge's courtyard too, and a newbie or a low-level about Lumbridge there, the walk-ins of a
 * party at the castle): not stuck
 */
function atHomeHere(bot: Player, venue: PartyVenue): boolean {
    if (venue.key === 'lumbridge_courtyard' && (isNewbie(bot) || lumbridgeLowLevel(bot))) return true;
    // (and a hang-out's stand, 3-10 minutes on a tile of its own at the park, the square or a bank: the realism work's
    // 2004 hotspots, as the sims' stall check has it; a guest's came due as a party at Falador park ended: party.test after
    // round 1's merge, its second fixer)
    if (hangoutOf(bot)) return true;
    return bot.botPlanner === 'extras_social' && (venue.key === 'varrock_square' || venue.key === 'falador_park' || venue.key === 'lumbridge_courtyard');
}

/** the Party Room's shared chest: its filled slots (274's partyroom_dropinv, world-wide) */
export function chestSlotsFilled(): number {
    const id = InvType.getId('partyroom_dropinv');
    const inv = id === -1 ? null : World.getInventory(id);
    if (!inv) return 0;
    let n = 0;
    for (let s = 0; s < inv.capacity; s++) if (inv.get(s)) n++;
    return n;
}

/** a host's calls in a colour of its own now and then (from its name: the same every party; about 4 in 10: 1-11) */
function hostColour(bot: Player): number {
    const seed = nameSeed(bot.username, 'party-calls') % 100;
    return seed < 40 ? 1 + (seed % 11) : 0;
}

// ── who takes part ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * a bot free to come along now (the director's freeBots has done the rest): it is not hurt. (The variety work, round 1,
 * track F: ISS-3) a full pack comes too: at the party it watches, or drops a piece of junk for a pile (PartyGuestTask);
 * skillers' packs filled during the lead and they were lost at their start)
 */
export function guestFree(bot: Player): boolean {
    if (bot.slot === -1 || bot.level !== 0 || wildernessLevelAt(bot.x, bot.z) > 0) return false;
    // (armed for a random event: port/BotRandomEvents keeps the game's flag only on a bot it armed; its answer would
    // wait behind the party)
    if (bot.afkEventReady) return false;
    if (!isLevelling(bot.botPlanner as PlannerKey) || isNewbie(bot)) return false;
    if (bot.levels[PlayerStat.HITPOINTS] * 10 < bot.baseLevels[PlayerStat.HITPOINTS] * 7) return false;
    if (bot.botTradeTargetPid !== -1 || bot.botComeHereReturnX !== -1) return false;
    return !!bot.getInventory(InvType.INV);
}

/** (variety round 1, F: ISS-3) the guests asked are asked again this often while they are busy */
export const GUEST_RETRY_TICKS = 20;
/** (variety round 1, F: the walk-ins) passers-by this near the drop square, a look every WALK_IN_EVERY ticks, each joining with this chance (x 0.5 + its sociability), at most WALK_IN_MOST a party */
export const WALK_IN_TILES = 15;
const WALK_IN_EVERY = 25;
export const WALK_IN_CHANCE = 0.3;
/** (tests) the walk-ins' chance (null: WALK_IN_CHANCE). Never set by the game. */
let walkInChance = WALK_IN_CHANCE;
export function setWalkInChanceForTest(chance: number | null): void {
    walkInChance = chance ?? WALK_IN_CHANCE;
}
export const WALK_IN_MOST = 8;

/**
 * (variety round 1, F) a passer-by free to walk in: a levelling bot (a newbie too: Lumbridge's drop parties drew them) or
 * a social regular, out of a fight, a trade, a "come here", unhurt, on the ground floor out of the Wilderness, not armed
 * for a random event; never a vendor or a PKer at its post
 */
export function walkInFree(bot: Player): boolean {
    if (bot.is_bot !== true || bot.slot === -1 || bot.level !== 0 || wildernessLevelAt(bot.x, bot.z) > 0 || bot.afkEventReady) return false;
    if (!isLevelling(bot.botPlanner as PlannerKey) && bot.botPlanner !== 'extras_social') return false;
    if (bot.levels[PlayerStat.HITPOINTS] * 10 < bot.baseLevels[PlayerStat.HITPOINTS] * 7) return false;
    if (bot.botTradeTargetPid !== -1 || bot.botComeHereReturnX !== -1 || bot.delayed) return false;
    const ai = BotManager.botFor(bot);
    if (!ai || (ai.hasSubTask() && !inHangout(bot)) || eventRoleOf(bot) !== null) return false;
    // (not in a fight: a target that is an NPC it attacks)
    const t = bot.target as { nid?: number } | null;
    return !(t && t.nid !== undefined);
}

/**
 * (variety round 1, F) is the bot's sub-task one a party may take the place of: a hang-out (port/BotHangout), an alcher's
 * stint at a bank stop ('Magic', port/BotAlch), a login's linger (port/BotLinger)? A player there would go
 */
const GIVEN_UP_FOR_A_PARTY = new Set(['Hangout', 'Magic', 'Linger']);
function inHangout(bot: Player): boolean {
    const sub = (bot as unknown as { _bot?: { subTask?: { name?: string } | null } })._bot?.subTask;
    return GIVEN_UP_FOR_A_PARTY.has(sub?.name ?? '');
}

function hostFree(bot: Player, kind: PartyKind, ctx: SetPieceContext): boolean {
    if (bot.slot === -1 || bot.level !== 0 || wildernessLevelAt(bot.x, bot.z) > 0 || bot.afkEventReady) return false;
    if (!isLevelling(bot.botPlanner as PlannerKey) || isNewbie(bot)) return false;
    if (bot.levels[PlayerStat.HITPOINTS] * 10 < bot.baseLevels[PlayerStat.HITPOINTS] * 7) return false;
    if (bot.botTradeTargetPid !== -1 || bot.botComeHereReturnX !== -1) return false;
    if (ctx.sessionLeft(bot) < PARTY.hostSessionLeft) return false;
    return coinsOwned(bot) >= PARTY.hostCoins + (kind === 'party_room' ? PARTY.lever : 0);
}

/** the guests a party may ask: free bots near the venue with 30+ minutes of their session left */
function guestPool(ctx: SetPieceContext, venue: PartyVenue): Player[] {
    const [x, z] = venue.drop;
    return ctx.freeBots(x, z, venue.level, PARTY.guestRadius[venue.kind], p => guestFree(p) && ctx.sessionLeft(p) >= PARTY.guestSessionLeft);
}

/** the host: the nearest free bot within its radius with a kit (null: none) */
function findHost(ctx: SetPieceContext, venue: PartyVenue, random: () => number): { bot: Player; kit: Kit } | null {
    const [x, z] = venue.drop;
    const kind = venue.kind;
    for (const bot of ctx.freeBots(x, z, venue.level, PARTY.hostRadius[kind], p => hostFree(p, kind, ctx), 20)) {
        const kit = planKit(bot, kind, random);
        if (kit) return { bot, kit };
    }
    return null;
}

// ── the set pieces ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A drop party's plan: the F2P venue with the most free bots within 60 tiles (ties: the dice), its host (the nearest
 * with a kit), when it has 6+ guests to ask; the score is that crowd's share of a full party (0-1). `only`: that venue
 * (the tests, the runner's forced party).
 */
export function planDropParty(ctx: SetPieceContext, only?: string): SetPiecePlan | null {
    let best: PartyVenue | null = null;
    let bestN = -1;
    for (const v of VENUES) {
        if (v.kind !== 'drop_party' || (only && v.key !== only)) continue;
        const n = guestPool(ctx, v).length;
        if (n > bestN || (n === bestN && ctx.dice() < 0.5)) {
            best = v;
            bestN = n;
        }
    }
    if (!best || bestN < PARTY.minGuests.drop_party) return null;
    const host = findHost(ctx, best, ctx.dice);
    if (!host) return null;
    return { kind: 'drop_party', venue: best, score: Math.min(1, bestN / 12), data: host };
}

/** The Party Room's plan (members): a host within 120 tiles of Seers with a kit and the lever's coins, 4+ guests to ask. */
export function planPartyRoom(ctx: SetPieceContext): SetPiecePlan | null {
    if (!ctx.members) return null;
    const venue = VENUES.find(v => v.kind === 'party_room');
    if (!venue) return null;
    const n = guestPool(ctx, venue).length;
    if (n < PARTY.minGuests.party_room) return null;
    const host = findHost(ctx, venue, ctx.dice);
    if (!host) return null;
    return { kind: 'party_room', venue, score: Math.min(1, n / 8), data: host };
}

/**
 * A party begins: the host's part (its sub-task: the bank, the walk, the calls, the drop or the chest and the lever),
 * and the guests asked (each with chance 0.4 + 0.4 x sociability, up to the cap), each setting off at its own moment in
 * the lead. Null when the host is no longer free.
 */
export function startParty(plan: SetPiecePlan, ctx: SetPieceContext): PartyRun | null {
    const data = plan.data as { bot: Player; kit: Kit } | undefined;
    const venue = VENUES.find(v => v.key === plan.venue.key);
    if (!data || !venue || data.bot.slot === -1) return null;
    const ai = BotManager.botFor(data.bot);
    if (!ai || ai.hasSubTask()) return null;
    // the guests who come (each with chance 0.4 + 0.4 x sociability, up to the cap); too few, and there is no party
    const cap = ctx.online > 100 ? PARTY.guestCap[1] : PARTY.guestCap[0];
    const coming: Player[] = [];
    const pool = guestPool(ctx, venue);
    for (const bot of pool) {
        if (bot === data.bot || coming.length >= cap) continue;
        if (ctx.dice() < PARTY.joinChance[0] + PARTY.joinChance[1] * botPersona(bot).sociability) coming.push(bot);
    }
    if (coming.length < PARTY.minComing[venue.kind]) return null;
    const run = new PartyRun(plan, data.bot, data.kit, venue);
    ai.setSubTask(run.hostTask);
    // (a walk of a minute or two: they set off over the lead's first two thirds; one from further off, the Party Room's
    // guests from up to 150 tiles, sets off early enough to be there for the drop)
    const lead = run.dropAt - run.startedAt;
    for (const bot of coming) {
        const latest = run.latestFor(bot);
        const at = Math.min(run.startedAt + Math.round(lead * (0.05 + 0.6 * ctx.dice())), latest);
        run.addGuest(bot, Math.max(run.startedAt, at), latest);
    }
    // (variety round 1, F: ISS-3) the rest of the pool, nearest first: a lost guest's place
    run.reserve = pool.filter(b => b !== data.bot && !coming.includes(b));
    return run;
}

export const DROP_PARTY: SetPieceDef = {
    kind: 'drop_party',
    // (the defaults: drop parties 25 of the hourly beat's 100 on members, 30 on a free world; on members 40 % of them in
    // the Seers' Party Room: 15 here and 10 there)
    weight: { members: 15, free: 30 },
    plan: ctx => planDropParty(ctx),
    start: (plan, ctx) => startParty(plan, ctx)
};

export const PARTY_ROOM: SetPieceDef = {
    kind: 'party_room',
    members: true,
    weight: { members: 10, free: 0 },
    plan: ctx => planPartyRoom(ctx),
    start: (plan, ctx) => startParty(plan, ctx)
};

register(DROP_PARTY);
register(PARTY_ROOM);

// ── tests ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** (tests) change the defaults (a copy of data/party.json's); null: back to the data's */
export function setPartyDefaultsForTest(over: Partial<PartyDefaults> | null): void {
    const base = JSON.parse(JSON.stringify(DATA.defaults)) as PartyDefaults;
    Object.assign(PARTY, base, over ?? {});
}
