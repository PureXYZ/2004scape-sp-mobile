/**
 * port (the variety work, round 2, the fixes: an outing's dead ends) the ways out of two places a bot's walk cannot leave by
 * a route, asked by BotAction.walkTo before its route search (beside the essence mine's portal, the integrator's):
 *   - Shilo Village's walls: Vigroy's cart to Brimhaven (his Talk-to, his pages continued, "Yes please" chosen; 274's
 *     calc_shilocart_cost takes 5 % of the coins carried, 10 at least: a bot short of 10 takes some out at Shilo's own bank
 *     first, its bankers by the cart), the ride's p_teleport marked as the game's move (noteMove) at each page continued,
 *     the last a tick before it lands;
 *   - an upper floor of one of port/BotUpstairs' buildings (Yanille's watchtower): down its own ladder (climbLeg).
 * An outing that ended there (its interrupt, a fight's give-up, the feathers gone, its Hitpoints low) left the bot to its
 * next task's walk, which searched for a route, found none and was rescue-jumped 450+ tiles: Shilo's river to (3288,3189),
 * the watchtower's top floor to (3288,3188,0). Nothing here jumps: a way out that does not come (no driver, no coins in
 * the bank either, EXIT_TICKS without getting out) hands the walk back to its own rescue.
 */
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import InvType from '#/cache/config/InvType.js';
import VarBitType from '#/cache/config/VarBitType.js'; // (bots ideas, round 3: G period: the Games Room's board)
// (BotAction imports this module for walkTo's legs: its functions are used only inside these, after every module is loaded)
import { botAnswerDialogue, botScript, countItem, findNpcByName, interactNpcOp, noteMove, walkTo } from '#/engine/bot/BotAction.js';
import { findLocByName, interactLocOp } from '#/engine/bot/BotAction.js'; // (bots ideas, Track A: the Mage Arena's way up)
import { Items, MembersPlaces, inShilo } from '#/engine/bot/BotKnowledge.js';
import { buildingAt, climbLeg } from '#/engine/bot/port/BotUpstairs.js';
import { moveItems } from '#/engine/bot/port/BotInventoryCompat.js';

/** the cart's least fare (274's calc_shilocart_cost: 5 % of the coins carried, 10 at least, 200 at most) */
export const SHILO_FARE_MIN = 10;
/** coins carried for both rides: the way in (Hajedy) leaves the fare back (OutingTask asks it before the ride in) */
export const SHILO_FARES_BOTH = 2 * SHILO_FARE_MIN;
/** coins taken out at Shilo's bank by a bot short of the fare */
const SHILO_WITHDRAW = 100;
/** a way out under way this long (ticks) without the bot out has failed: the walk's own rescue after */
const EXIT_TICKS = 400;
/** a failed way out is tried again after this long (ticks: a driver back, coins found) */
const EXIT_RETRY = 600;
/** the driver's Talk-to at most this often, this many times */
const CART_GAP = 12;
const CART_TRIES = 4;

/** (tests, the report) the ways out begun (by kind), the driver's clicks, Shilo bank withdrawals, the failures */
export const exitStats = { begun: {} as Record<string, number>, carts: 0, withdrawals: 0, failed: {} as Record<string, number> };

interface ExitState {
    kind: 'shilo' | 'upstairs' | 'arena' | 'games';
    began: number;
    seen: number;
    failedAt: number;
    cartAt: number;
    tries: number;
    bankAt: number;
    banked: boolean;
    over: boolean;
}

const exits = new WeakMap<Player, ExitState>();

function stateFor(player: Player, kind: ExitState['kind']): ExitState {
    const now = World.currentTick;
    let st = exits.get(player);
    // (a new way out: none before, another kind, the last one long over, or failed a while ago)
    if (!st || st.kind !== kind || now - st.seen > 50 || (st.over && now - st.failedAt > EXIT_RETRY)) {
        st = { kind, began: now, seen: now, failedAt: -1, cartAt: -1000, tries: 0, bankAt: -1, banked: false, over: false };
        exits.set(player, st);
        exitStats.begun[kind] = (exitStats.begun[kind] ?? 0) + 1;
    }
    st.seen = now;
    return st;
}

function fail(st: ExitState, why: string): false {
    if (!st.over) {
        exitStats.failed[why] = (exitStats.failed[why] ?? 0) + 1;
        st.failedAt = World.currentTick;
    }
    st.over = true;
    return false;
}

/**
 * walkTo's leg (BotAction.walkTo): true while the way out of Shilo's walls or an upper floor takes this tick (a walk to
 * the cart or the ladder, a click, a page); false when there is none here (or it failed: the walk goes on as before).
 */
export function exitLeg(player: Player, destX: number, destZ: number, level: number): boolean {
    if (level !== 0) return false;
    // ---- (bots ideas, round 3: G period) the Games Room under Burthorpe (either floor; no walking graph in it) with a
    // target out of it: up its stairs first ----
    if (inGamesRoomBox(player.x, player.z) && !inGamesRoomBox(destX, destZ)) return gamesRoomOut(player);
    // ---- end of G period's block ----
    if (player.level > 0) {
        if (buildingAt(player.x, player.z) === null) return false;
        const st = stateFor(player, 'upstairs');
        if (st.over) return false;
        if (World.currentTick - st.began > EXIT_TICKS) return fail(st, 'upstairs');
        // (down the building's own flight, its click marked as the game's move: port/BotUpstairs)
        return climbLeg(player, [destX, destZ, 0]);
    }
    if (inShilo(player.x, player.z) && !inShilo(destX, destZ)) return shiloCartOut(player);
    // ---- (bots ideas, Track A: the period endgame) the Mage Arena's cellar and chamber (z 4680-4730: no dungeon of
    // walkTo's, and no route out): the chamber's pool, then the cellar's ladder up ----
    if (inMageArenaBelow(player.x, player.z) && !inMageArenaBelow(destX, destZ)) return mageArenaOut(player);
    // ---- end of Track A's block ----
    return false;
}

// ---- (bots ideas, Track A: the period endgame) the way up out of the Mage Arena (its cellar: Kolodion, a banker; its
// chamber: the statues and the guardian, reached by the cellar's pool): from the chamber its pool out
// (magearena_waterportal2, 274's jump_in_sparkling_pool: back to the cellar), from the cellar its ladder up
// (magearena_ladder_from_cellar, to the ruined building at 3091,3957); each click's move marked as the game's ----
/** the Mage Arena's cellar and chamber (2490-2560, 4675-4730, level 0) */
export function inMageArenaBelow(x: number, z: number): boolean {
    return x >= 2490 && x <= 2560 && z >= 4675 && z <= 4730;
}
const ARENA_CHAMBER_MAX_X = 2525;

function mageArenaOut(player: Player): boolean {
    if (player.level !== 0) return false;
    const st = stateFor(player, 'arena');
    if (st.over) return false;
    if (World.currentTick - st.began > EXIT_TICKS) return fail(st, 'arena');
    if (player.delayed || botScript(player)) {
        botAnswerDialogue(player, 1);
        return true;
    }
    const chamber = player.x <= ARENA_CHAMBER_MAX_X;
    const [name, x, z] = chamber ? ['magearena_waterportal2', 2508, 4686] : ['magearena_ladder_from_cellar', 2542, 4713];
    const loc = findLocByName(x, z, 0, name, 3);
    if (!loc) return fail(st, 'arena-loc');
    if (player.target === loc) return true;
    if (now() - st.cartAt < CART_GAP) return true;
    st.cartAt = now();
    interactLocOp(player, loc, 1);
    noteMove(player, 'event');
    return true;
}
function now(): number {
    return World.currentTick;
}
// ---- end of Track A's block ----

/** a way out under way for this bot (the stuck checks wait for it, as for a boat's crossing: BotAction.isCrossing) */
export function exiting(player: Player): boolean {
    const st = exits.get(player);
    return st !== undefined && !st.over && World.currentTick - st.seen <= 20;
}

/**
 * Out of Shilo by Vigroy's cart: to the driver, his Talk-to, the pages continued and "Yes please" chosen (option 1), the
 * ride's p_teleport (marked); short of the fare, Shilo's bank first. True while under way; false out, or failed.
 */
export function shiloCartOut(player: Player): boolean {
    const st = stateFor(player, 'shilo');
    if (st.over) return false;
    const now = World.currentTick;
    if (!inShilo(player.x, player.z) || player.level !== 0) {
        // (out: the next way out is a new one)
        exits.delete(player);
        return false;
    }
    if (now - st.began > EXIT_TICKS) return fail(st, 'shilo-time');
    if (botAnswerDialogue(player, 1) !== null) {
        // (the cart's pages: its last one's continue is the ride, p_teleport to Brimhaven: the game's move)
        if (now - st.cartAt < 60) noteMove(player, 'event');
        return true;
    }
    if (player.delayed || botScript(player)) return true;
    const coins = countItem(player, Items.COINS);
    if (coins < SHILO_FARE_MIN) return st.banked ? fail(st, 'shilo-coins') : shiloWithdraw(player, st);
    if (st.tries >= CART_TRIES) return fail(st, 'shilo-cart');
    const [cx, cz] = MembersPlaces.SHILO_CART;
    if (Math.max(Math.abs(player.x - cx), Math.abs(player.z - cz)) > 4) {
        walkTo(player, cx, cz, 0);
        return true;
    }
    if (now - st.cartAt < CART_GAP) return true;
    const driver = findNpcByName(player.x, player.z, 0, 'shilocartdriver', 10);
    if (!driver) return fail(st, 'shilo-driver');
    interactNpcOp(player, driver, 1);
    st.cartAt = now;
    st.tries++;
    exitStats.carts++;
    return true;
}

/** Shilo's bank (its bankers, op 3 Bank, as advanceBankWalk's banker), a few coins for the cart; once a way out */
function shiloWithdraw(player: Player, st: ExitState): boolean {
    const now = World.currentTick;
    const [bx, bz] = MembersPlaces.SHILO_BANK;
    if (st.bankAt === -1) {
        if (Math.max(Math.abs(player.x - bx), Math.abs(player.z - bz)) > 3) {
            walkTo(player, bx, bz, 0);
            return true;
        }
        const banker = findNpcByName(player.x, player.z, 0, 'shilobanker', 8);
        if (!banker) return fail(st, 'shilo-banker');
        interactNpcOp(player, banker, 3);
        st.bankAt = now;
        return true;
    }
    if (now - st.bankAt < 3) return true;
    st.banked = true;
    const bid = InvType.getId('bank');
    const bank = bid === -1 ? null : player.getInventory(bid);
    const inv = player.getInventory(InvType.INV);
    if (bank && inv) moveItems(bank, inv, Items.COINS, Math.min(SHILO_WITHDRAW, bank.getItemCount(Items.COINS)));
    if (player.containsModalInterface()) player.closeModal();
    if (countItem(player, Items.COINS) < SHILO_FARE_MIN) return fail(st, 'shilo-coins');
    exitStats.withdrawals++;
    return true;
}

// ---- (bots ideas, round 3: G period) the way up out of the Games Room under Burthorpe (274's game_gamesroom, stairs.rs2):
// from the Runelink room's floor (level 0) the stairs base by the hall (board_game_stairs_base at 2207,4935: to the
// arrival hall), from the hall (level 1) the stairs up (board_game_stairs_grey_base2 at 2205,4935: to Burthorpe at
// 2899,3564); each click's move marked as the game's. A board under way is never closed here (tasks/GamesRoomTask's:
// the walk waits for its end); the end screen or a challenge's screen is closed first, as a player clicks it away ----
/** the Games Room's box, both floors (BotKnowledge PeriodPlaces.GAMES_ROOM_BOX) */
export function inGamesRoomBox(x: number, z: number): boolean {
    return x >= 2176 && x <= 2239 && z >= 4928 && z <= 4991;
}
let ingameBit: number | undefined;
function inBoardGame(player: Player): boolean {
    ingameBit ??= VarBitType.getId('boardgames_ingame');
    return ingameBit !== -1 && player.getVarBit(ingameBit) === 1;
}

/** Out of the Games Room by its stairs: true while under way (a walk to the stairs, a click), false out of it or failed. */
export function gamesRoomOut(player: Player): boolean {
    if (!inGamesRoomBox(player.x, player.z)) return false;
    const st = stateFor(player, 'games');
    if (st.over) return false;
    if (World.currentTick - st.began > EXIT_TICKS) return fail(st, 'games');
    if (player.delayed) return true;
    if (player.modalMain !== -1) {
        if (inBoardGame(player)) return true;
        player.closeModal();
        return true;
    }
    const [name, x, z, level] = (player.level === 0 ? ['board_game_stairs_base', 2207, 4935, 0] : ['board_game_stairs_grey_base2', 2205, 4935, 1]) as [string, number, number, number];
    const loc = findLocByName(x, z, level, name, 3);
    if (!loc) return fail(st, 'games-loc');
    // (its target or its route under way: the moment it ends is noted, and the next click a moment after it)
    if (player.target !== null || player.hasWaypoints()) {
        st.bankAt = now();
        return true;
    }
    // (on the Runelink room's floor: to the stairs' foot first (a click from the room's far side said "I can't reach
    // that!"), then the click)
    if (player.level === 0 && Math.max(Math.abs(player.x - 2208), Math.abs(player.z - 4937)) > 2) {
        if (now() - st.bankAt >= 2) walkTo(player, 2208, 4937, 0);
        return true;
    }
    // (a person's moment between clicks: 6-13 ticks, never the same twice; 2-5 after a walk or a click ended)
    if (now() - st.cartAt < 6 + ((st.tries * 7 + player.uid) & 7) || now() - st.bankAt < 2 + ((st.tries * 3 + player.uid) & 3)) return true;
    st.cartAt = now();
    st.tries++;
    interactLocOp(player, loc, 1);
    noteMove(player, 'event');
    return true;
}
// ---- end of G period's block ----
