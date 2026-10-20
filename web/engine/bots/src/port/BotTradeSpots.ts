// port: where bots sell. About half the vendors sell at Varrock West, the 2004 trade hub: on its
// stalls, then in a crowd in its bank hall and on the road in front, a tile each; every other trade bank has one or
// two (its vendor stalls), and a vendor whose home bank is full goes to Varrock West (a members town's vendor first
// tries the other members towns, nearest first). Upstream had them all at
// Varrock West on a few tiles (a dozen vendors, adverts every second). Each bank has a talk budget, whoever speaks:
// about 12-20 adverts a minute, 25-50 at Varrock West (2026-10-18, "more often chat ads is ok": 2004's
// sellers ran auto typers, tasks/VendorTask; it was 10-15 and 20-30). The stalls are walkable tiles in the bank hall, 2-4 tiles from
// the booths, each reachable from the bank's spot (measured on the 274 map).
import type Player from '#/engine/entity/Player.js';
import { canTravel, CollisionType } from '#/engine/routefinder/index.js';
import { isAllowedCoord } from '#/engine/bot/port/BotWorldRules.js';
import { nameIndex } from '#/engine/bot/port/BotSeed.js';

export interface TradeBank {
    key: string;
    /** the bank's spot (as BotKnowledge.Locations has it) */
    center: [number, number, number];
    /** stall tiles, the first `vendorStalls` for vendors and the rest for bankstanders too */
    stalls: [number, number][];
    /** how many vendors it takes on its stalls (Varrock West takes more, in its crowd) */
    vendorStalls: number;
    /** how often a vendor makes it its home (weight; the hub: as often as all the other banks together) */
    weight: number;
    /** a members bank (a free world has none) */
    members?: boolean;
    /** the trade hub (Varrock West): half the vendors' homes, every vendor no other bank has room for */
    hub?: boolean;
    /** the hub's crowd: patches of tiles, each those reachable within `steps` steps of (x, z) */
    crowd?: [x: number, z: number, steps: number][];
    /** ticks between its adverts (5-8: 12-20 a minute) */
    advertGap?: [number, number];
}

export const TRADE_BANKS: readonly TradeBank[] = [
    // (its crowd: the bank hall, and the road in front of its south door; adverts 2-4 ticks apart, 25-50 a minute)
    { key: 'varrock_west', center: [3185, 3444, 0], stalls: [[3184, 3443], [3184, 3445], [3184, 3441], [3184, 3447], [3181, 3439], [3181, 3437], [3183, 3427], [3179, 3429]], vendorStalls: 4, weight: 1, hub: true, crowd: [[3183, 3441, 7], [3183, 3428, 6]], advertGap: [2, 4] },
    { key: 'varrock_east', center: [3253, 3420, 0], stalls: [[3252, 3421], [3254, 3421], [3250, 3421], [3257, 3421]], vendorStalls: 2, weight: 1 },
    { key: 'falador_west', center: [2946, 3368, 0], stalls: [[2945, 3369], [2947, 3369], [2943, 3365], [2943, 3367]], vendorStalls: 2, weight: 1 },
    { key: 'falador_east', center: [3013, 3355, 0], stalls: [[3012, 3356], [3014, 3356], [3010, 3352], [3010, 3356]], vendorStalls: 2, weight: 1 },
    { key: 'draynor', center: [3092, 3245, 0], stalls: [[3093, 3244], [3093, 3246], [3093, 3242]], vendorStalls: 2, weight: 1 },
    { key: 'edgeville', center: [3093, 3491, 0], stalls: [[3093, 3491], [3093, 3489], [3093, 3493], [3093, 3487]], vendorStalls: 2, weight: 1 },
    { key: 'al_kharid', center: [3269, 3163, 0], stalls: [[3270, 3164], [3270, 3166], [3270, 3168]], vendorStalls: 2, weight: 1 },
    // members
    { key: 'catherby', center: [2808, 3441, 0], stalls: [[2807, 3440], [2809, 3440], [2805, 3440], [2805, 3444]], vendorStalls: 2, weight: 1, members: true },
    { key: 'seers', center: [2725, 3493, 0], stalls: [[2724, 3492], [2726, 3492], [2722, 3492], [2728, 3492]], vendorStalls: 2, weight: 1, members: true },
    { key: 'ardougne_south', center: [2655, 3283, 0], stalls: [[2654, 3282], [2654, 3284], [2654, 3280], [2654, 3286]], vendorStalls: 2, weight: 1, members: true },
    { key: 'ardougne_north', center: [2615, 3332, 0], stalls: [[2614, 3333], [2616, 3333], [2612, 3329], [2612, 3333]], vendorStalls: 2, weight: 1, members: true }
];

export interface Stall {
    bank: TradeBank;
    tile: [number, number];
    /** a tile of the hub's crowd, not a stall: its vendor stands on it, and does not step about (its neighbours') */
    crowd?: boolean;
}

/** the bot on each stall ("bank:index") */
const taken = new Map<string, Player>();
/** each bot's stall */
const held = new Map<Player, string>();

/** The banks a bot may use on this world (a free world: the free ones). */
export function usableBanks(): TradeBank[] {
    return TRADE_BANKS.filter(b => isAllowedCoord(b.center[0], b.center[1]));
}

/**
 * A vendor's place: its old one if it still has one; else a stall at its home bank (from its name: the hub as often as
 * all the other banks together), a members town's vendor trying the other members towns next; else the hub: its
 * stalls, then a tile in its crowd. Until two vendors stand at the hub, a free town's vendor starts there (members
 * towns keep theirs: no walk across the map). Null only when no bank is usable.
 */
export function claimVendorStall(bot: Player): Stall | null {
    const current = stallOf(bot);
    if (current) return current;
    const banks = usableBanks();
    if (banks.length === 0) return null;
    const home = banks[homeIndex(bot.username, banks)];
    const hub = banks.find(b => b.hub);
    if (hub && home !== hub && !home.members && vendorsAt(hub) < 2) {
        const stall = freeStall(hub, 0, hub.vendorStalls);
        if (stall !== null) return take(bot, hub, stall);
    }
    if (home !== hub) {
        const others = home.members ? banks.filter(b => b.members && b !== home).sort((a, b) => between(home, a) - between(home, b)) : [];
        for (const bank of [home, ...others]) {
            const stall = freeStall(bank, 0, bank.vendorStalls);
            if (stall !== null) return take(bot, bank, stall);
        }
    }
    if (hub) {
        const stall = freeStall(hub, 0, hub.vendorStalls);
        if (stall !== null) return take(bot, hub, stall);
        const tile = hubTile(hub);
        if (tile) return takeTile(bot, hub, tile);
    }
    // (the hub's crowd full: any bank's free stall)
    for (const bank of banks) {
        const stall = freeStall(bank, 0, bank.vendorStalls);
        if (stall !== null) return take(bot, bank, stall);
    }
    return null;
}

/**
 * port: the hub's crowd (a crowd at Varrock West is right, in its hall and out front), a tile each: of the
 * tiles in its crowd patches (reachable within a few steps of each patch's middle), the nearest free one, the patches
 * filling evenly; never a stall (those are the stall vendors' and the bankstanders'). Before, every vendor past the
 * stalls stood on one of the same 4 tiles.
 */
const hubTiles = new Map<string, [number, number][]>();

/** the bank's crowd tiles, nearest a patch's middle first, the patches in turn (found once: the map does not change) */
function hubTilesOf(bank: TradeBank): [number, number][] {
    let tiles = hubTiles.get(bank.key);
    if (tiles) return tiles;
    const level = bank.center[2];
    // (not on a stall nor beside one: a stall's vendor or bank-stander steps a tile about it)
    const stalls = new Set<number>();
    for (const [x, z] of bank.stalls) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) stalls.add((x + dx) * 16384 + (z + dz));
    const found = new Map<number, [x: number, z: number, steps: number, patch: number]>();
    (bank.crowd ?? []).forEach(([sx, sz, most], patch) => {
        const steps = new Map<number, number>([[sx * 16384 + sz, 0]]);
        const queue: [number, number][] = [[sx, sz]];
        for (let i = 0; i < queue.length; i++) {
            const [x, z] = queue[i];
            const here = steps.get(x * 16384 + z)!;
            const known = found.get(x * 16384 + z);
            if (!stalls.has(x * 16384 + z) && (!known || here < known[2])) found.set(x * 16384 + z, [x, z, here, patch]);
            if (here === most) continue;
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const key = (x + dx) * 16384 + (z + dz);
                if (steps.has(key) || !canTravel(level, x, z, dx, dz, 1, 0, CollisionType.NORMAL)) continue;
                steps.set(key, here + 1);
                queue.push([x + dx, z + dz]);
            }
        }
    });
    tiles = [...found.values()].sort((a, b) => a[2] - b[2] || a[3] - b[3] || a[0] - b[0] || a[1] - b[1]).map(([x, z]) => [x, z]);
    hubTiles.set(bank.key, tiles);
    return tiles;
}

/** the nearest free crowd tile at the bank, or null */
function hubTile(bank: TradeBank): [number, number] | null {
    for (const tile of hubTilesOf(bank)) {
        const bot = taken.get(tileKey(bank, tile));
        if (bot === undefined || bot.slot === -1) return tile;
    }
    return null;
}

/** The crowd tiles (for the tests). */
export function hubTilesForTest(key: string): [number, number][] {
    const bank = TRADE_BANKS.find(b => b.key === key);
    return bank ? hubTilesOf(bank) : [];
}

/** A vendor's home bank (where it logs in fresh: BotManager), from its name: Varrock West half the time. */
export function vendorHome(name: string): [number, number, number] {
    const banks = usableBanks();
    return banks.length > 0 ? banks[homeIndex(name, banks)].center : TRADE_BANKS[0].center;
}

function homeIndex(name: string, banks: TradeBank[]): number {
    const others = banks.filter(b => !b.hub).reduce((n, b) => n + b.weight, 0);
    const weight = (b: TradeBank): number => (b.hub ? Math.max(1, others) : b.weight);
    const total = banks.reduce((n, b) => n + weight(b), 0);
    let roll = nameIndex(name, 'trade-bank', total);
    let home = 0;
    for (; home < banks.length - 1 && roll >= weight(banks[home]); home++) roll -= weight(banks[home]);
    return home;
}

/** A bankstander's stall: at the usable bank nearest the bot with a free stall (any of its stalls), or null. */
export function claimNearestStall(bot: Player): Stall | null {
    const current = stallOf(bot);
    if (current) return current;
    const banks = usableBanks().sort((a, b) => dist(bot, a) - dist(bot, b));
    for (const bank of banks) {
        const stall = freeStall(bank, 0, bank.stalls.length, true);
        if (stall !== null) return take(bot, bank, stall);
    }
    return null;
}

/** The bot leaves its stall (its task ended, it logged out). */
export function releaseStall(bot: Player): void {
    const key = held.get(bot);
    if (key === undefined) return;
    held.delete(bot);
    if (taken.get(key) === bot) taken.delete(key);
}

export function stallOf(bot: Player): Stall | null {
    const key = held.get(bot);
    if (key === undefined) return null;
    // ("bank:index" a stall, "bank@x,z" a crowd tile)
    const at = key.indexOf('@');
    if (at !== -1) {
        const bank = TRADE_BANKS.find(b => b.key === key.slice(0, at))!;
        const [x, z] = key.slice(at + 1).split(',').map(Number);
        return { bank, tile: [x, z], crowd: true };
    }
    const [bankKey, index] = key.split(':');
    const bank = TRADE_BANKS.find(b => b.key === bankKey)!;
    return { bank, tile: bank.stalls[Number(index)] };
}

// ── the talk budget ──────────────────────────────────────────────────────────

/** port: about 12-20 adverts a minute at a bank, whoever says them (5-8 ticks apart) */
const ADVERT_GAP: [number, number] = [5, 8];
const nextAdvert = new Map<string, number>();

/** May a bot at this bank advertise now? Yes takes the turn: the next one at the bank is 5-8 ticks later (the hub: 2-4). */
export function takeAdvertTurn(bank: TradeBank, now: number): boolean {
    if (now < (nextAdvert.get(bank.key) ?? 0)) return false;
    const [least, most] = bank.advertGap ?? ADVERT_GAP;
    nextAdvert.set(bank.key, now + least + Math.floor(Math.random() * (most - least + 1)));
    return true;
}

/** The most adverts a minute (100 ticks) the bank's budget allows (for the tests). */
export function advertsPerMinute(bank: TradeBank): number {
    return Math.ceil(100 / (bank.advertGap ?? ADVERT_GAP)[0]);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** the vendors at a bank: its vendor stalls taken, and its crowd (the hub's: a crowd stays when its stalls empty) */
function vendorsAt(bank: TradeBank): number {
    let n = 0;
    for (let i = 0; i < bank.vendorStalls; i++) {
        const bot = taken.get(`${bank.key}:${i}`);
        if (bot !== undefined && bot.slot !== -1) n++;
    }
    if (bank.crowd) {
        const prefix = `${bank.key}@`;
        for (const [key, bot] of taken) if (key.startsWith(prefix) && bot.slot !== -1) n++;
    }
    return n;
}

function freeStall(bank: TradeBank, from: number, to: number, fromEnd = false): number | null {
    const order = [...Array(to - from).keys()].map(i => from + i);
    // bankstanders take the stalls vendors take last
    if (fromEnd) order.reverse();
    for (const i of order) {
        const bot = taken.get(`${bank.key}:${i}`);
        if (bot === undefined || bot.slot === -1) return i;
    }
    return null;
}

function take(bot: Player, bank: TradeBank, index: number): Stall {
    claimKey(bot, `${bank.key}:${index}`);
    return { bank, tile: bank.stalls[index] };
}

function tileKey(bank: TradeBank, [x, z]: [number, number]): string {
    return `${bank.key}@${x},${z}`;
}

function takeTile(bot: Player, bank: TradeBank, tile: [number, number]): Stall {
    claimKey(bot, tileKey(bank, tile));
    return { bank, tile, crowd: true };
}

function claimKey(bot: Player, key: string): void {
    const before = taken.get(key);
    if (before !== undefined) held.delete(before);
    taken.set(key, bot);
    held.set(bot, key);
}

function between(a: TradeBank, b: TradeBank): number {
    return Math.max(Math.abs(a.center[0] - b.center[0]), Math.abs(a.center[1] - b.center[1]));
}

function dist(bot: Player, bank: TradeBank): number {
    return Math.max(Math.abs(bot.x - bank.center[0]), Math.abs(bot.z - bank.center[1]));
}
