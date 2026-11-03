// port (bots ideas, round 3, theme G: period content; with an override: bots never let a game's sand timer
// run out, and never log out mid-game): the Games Room's Runelink (274's game_gamesroom, under Burthorpe: the wiki dates
// it 24 Nov 2004, the frozen world's "today's update") as a bot plays it, through the game's own screens.
//
//   - The board: the bot's own copy of 274's boardgames_boardinv (42 slots, 7 wide, row 0 on top; a column is full when
//     its top slot is set), its piece the varbit boardgames_piece's rune, the other player's any other piece; the turn
//     the varbit boardgames_myturn; in a game while boardgames_ingame is 1 and the boardgames_runelink screen is open.
//   - A move (chooseColumn): a win in one taken 60-95 % of the time and the other's blocked 50-90 % of the time (the
//     bot's own strength from its name's seed, salt 'runelink'), else a column that hands the other no win above it,
//     leaning to the centre; the click is the screen's own column_N button after a think of 3-15 s (thinkTicks: the
//     persona's reaction), never past MOVE_DEADLINE (the 30 s sand timer is 50 ticks: 274's forced move, and its timeout
//     path is where an upstream script error happens, so a bot never lets it run out). A game of 15 s a move (the
//     human's challenge: the answer copies its %boardgames_timepermove) is thought about faster, by the time the sand
//     timer shows (sandTicks, moveDeadline).
//   - The challenge: player op 1 in the Runelink room opens boardgames_runelink_options at once (274's [opplayer1,_]:
//     %duel2accept), its Challenge button sends "name:duelreq:"; the other's op 1 back inherits the settings, and its
//     Challenge starts the game (both seated at a table). challengerOf: a player in the room whose %duel2accept is this
//     bot's uid with its own screen closed (its Challenge clicked), as tasks/DuelArenaTask reads a duel's.
//   - runelinkStats: games begun and finished, by how they ended, moves, those 274 forced, the human's challenges
//     answered (the runner's PC6).
// Every hook of the Games Room's asks theme G's switch first (port/BotPeriod periodOn); this module draws no dice
// itself except chooseColumn's and thinkTicks' (the library's, Math.random).
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import Component from '#/cache/config/Component.js';
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import VarBitType from '#/cache/config/VarBitType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import { PeriodPlaces } from '#/engine/bot/BotKnowledge.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { botPersona } from '#/engine/bot/port/BotTiming.js';
import { worldPlayers } from '#/engine/bot/port/BotPlayers.js';
import { periodOn } from '#/engine/bot/port/BotPeriod.js';

/** a think before a move: 3-15 s (ticks) × the persona's reaction, never past MOVE_DEADLINE ticks of its turn */
export const THINK_TICKS: readonly [number, number] = [5, 25];
export const MOVE_DEADLINE = 38;
/** 274's sand timer by %boardgames_timepermove (get_sandtimer_interval: 15 s, 30 s, 1 min, 2 min), in ticks */
export const SAND_TICKS: readonly number[] = [25, 50, 100, 200];
/** a shorter timer's click this many ticks before it runs out at the latest (the 30 s one's is MOVE_DEADLINE's 12) */
const SAND_MARGIN = 4;
/** the strength's ranges (G-content §5: approved) */
export const WIN_TAKEN: readonly [number, number] = [0.6, 0.95];
export const BLOCK_TAKEN: readonly [number, number] = [0.5, 0.9];
/** the centre lean (columns 1-7) */
const CENTRE = [1, 2, 3, 4, 3, 2, 1];

interface RlIds {
    ingame: number;
    myturn: number;
    timepermove: number;
    piece: number;
    viewing: number;
    closemode: number;
    duel2accept: number;
    rank: number;
    board: number;
    pieces: number[];
    game: number;
    view: number;
    options: number;
    challenge: number;
}
let ids: RlIds | null = null;
/** 274's ids (looked up once, after the cache is loaded) */
export function rlIds(): RlIds {
    if (!ids) {
        const runes = ['firerune', 'waterrune', 'earthrune', 'airrune', 'mindrune', 'bodyrune', 'naturerune', 'chaosrune', 'lawrune', 'cosmicrune', 'bloodrune', 'soulrune'];
        ids = {
            ingame: VarBitType.getId('boardgames_ingame'),
            myturn: VarBitType.getId('boardgames_myturn'),
            timepermove: VarBitType.getId('boardgames_timepermove'),
            piece: VarBitType.getId('boardgames_piece'),
            viewing: VarBitType.getId('boardgames_viewing'),
            closemode: VarBitType.getId('boardgames_closemode'),
            duel2accept: VarPlayerType.getId('duel2accept'),
            rank: VarPlayerType.getId('boardgames_runelink_rank'),
            board: InvType.getId('boardgames_boardinv'),
            pieces: runes.map(r => ObjType.getId(`boardgames_runelink_${r}`)),
            game: Component.getId('boardgames_runelink'),
            view: Component.getId('boardgames_runelink_view'),
            options: Component.getId('boardgames_runelink_options'),
            challenge: Component.getId('boardgames_challenge')
        };
    }
    return ids;
}

function varbit(p: Player, id: number): number {
    if (id === -1) return 0;
    const v = p.getVarBit(id);
    return typeof v === 'number' ? v : 0;
}

/** %duel2accept: the uid (an int32) of the player this one challenged or plays, else -1/0 */
export function partnerUid(p: Player): number {
    const id = rlIds().duel2accept;
    if (id === -1) return -1;
    const v = p.getVar(id);
    return typeof v === 'number' ? v : -1;
}

/** the bot's Runelink rank (274's perm varp; 1000 from its first visit) */
export function runelinkRank(p: Player): number {
    const id = rlIds().rank;
    if (id === -1) return 0;
    const v = p.getVar(id);
    return typeof v === 'number' ? v : 0;
}

/** in a game: 274's boardgames_ingame, with its board's screen open */
export function inRunelinkGame(p: Player): boolean {
    return varbit(p, rlIds().ingame) === 1 && p.modalMain === rlIds().game && p.modalMain !== -1;
}

/** 274's in-game varbit alone (set until its game-end queue resets it) */
export function ingameVarbit(p: Player): boolean {
    return varbit(p, rlIds().ingame) === 1;
}

/** the game's end screen (boardgames_runelink_view) open */
export function onViewScreen(p: Player): boolean {
    return p.modalMain !== -1 && p.modalMain === rlIds().view;
}

/** the challenge's options (boardgames_runelink_options) or the room's challenge screen open */
export function onOptionsScreen(p: Player): boolean {
    return p.modalMain !== -1 && (p.modalMain === rlIds().options || p.modalMain === rlIds().challenge);
}

/** 274's result of the game just over (%boardgames_closemode: 1 a win, 2 a loss, 3 a draw; 0 none) */
export function closeMode(p: Player): number {
    return varbit(p, rlIds().closemode);
}

export function myTurn(p: Player): boolean {
    return varbit(p, rlIds().myturn) === 1;
}

/** the bot's board: 0 empty, 1 its own piece, 2 the other's (row 0 on top, 7 wide) */
export function boardOf(p: Player): Int8Array {
    const board = new Int8Array(42);
    const { board: invId, pieces, piece } = rlIds();
    const inv = invId === -1 ? null : p.getInventory(invId);
    if (!inv) return board;
    const mine = pieces[varbit(p, piece) - 1] ?? -2;
    for (let slot = 0; slot < 42 && slot < inv.capacity; slot++) {
        const it = inv.get(slot);
        if (it) board[slot] = it.id === mine ? 1 : 2;
    }
    return board;
}

// ── the play ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** the row a piece dropped in column c (0-6) lands on, or -1 when it is full */
function landing(board: Int8Array, c: number): number {
    for (let row = 5; row >= 0; row--) if (board[row * 7 + c] === 0) return row;
    return -1;
}

/** four in a row through (row, c) for `who` */
function fourAt(board: Int8Array, row: number, c: number, who: number): boolean {
    for (const [dr, dc] of [
        [0, 1],
        [1, 0],
        [1, 1],
        [1, -1]
    ]) {
        let n = 1;
        for (const s of [1, -1]) {
            let r = row + dr * s;
            let cc = c + dc * s;
            while (r >= 0 && r < 6 && cc >= 0 && cc < 7 && board[r * 7 + cc] === who) {
                n++;
                r += dr * s;
                cc += dc * s;
            }
        }
        if (n >= 4) return true;
    }
    return false;
}

/** does a drop of `who` in column c win now */
export function winsWith(board: Int8Array, c: number, who: number): boolean {
    const row = landing(board, c);
    if (row === -1) return false;
    board[row * 7 + c] = who;
    const win = fourAt(board, row, c, who);
    board[row * 7 + c] = 0;
    return win;
}

/** would a drop of `who` in column c let the other win in that same column above it */
function handsWin(board: Int8Array, c: number, who: number): boolean {
    const row = landing(board, c);
    if (row <= 0) return false;
    board[row * 7 + c] = who;
    const theirs = winsWith(board, c, who === 1 ? 2 : 1);
    board[row * 7 + c] = 0;
    return theirs;
}

/** the bot's strength (its name's seed, salt 'runelink'): how often it takes a win in one, and blocks the other's */
export function strengthOf(name: string): { win: number; block: number } {
    const r = seededRandom(nameSeed(name, 'runelink'));
    return { win: WIN_TAKEN[0] + (WIN_TAKEN[1] - WIN_TAKEN[0]) * r(), block: BLOCK_TAKEN[0] + (BLOCK_TAKEN[1] - BLOCK_TAKEN[0]) * r() };
}

/**
 * The column (1-7) a bot of this strength plays on this board: a win in one (strength.win of the time), the other's
 * blocked (strength.block), else a column that hands the other no win above it, leaning to the centre. 0: none open.
 */
export function chooseColumn(board: Int8Array, strength: { win: number; block: number }, random: () => number = Math.random): number {
    const open: number[] = [];
    for (let c = 0; c < 7; c++) if (board[c] === 0) open.push(c);
    if (open.length === 0) return 0;
    const wins = open.filter(c => winsWith(board, c, 1));
    if (wins.length > 0 && random() < strength.win) return wins[0] + 1;
    const blocks = open.filter(c => winsWith(board, c, 2));
    if (blocks.length > 0 && random() < strength.block) return blocks[0] + 1;
    const safe = open.filter(c => !handsWin(board, c, 1));
    const pool = safe.length > 0 ? safe : open;
    let roll = random() * pool.reduce((a, c) => a + CENTRE[c], 0);
    for (const c of pool) {
        roll -= CENTRE[c];
        if (roll <= 0) return c + 1;
    }
    return pool[pool.length - 1] + 1;
}

/**
 * The game's sand timer (ticks): 274's get_sandtimer_interval of %boardgames_timepermove, the shorter of the bot's and
 * its opponent's (274's next turn sets the timer from the mover's, and an answer copies the challenger's: the same, but
 * the timer the board shows is the one that counts). 30 s (50) with no such varbit in the cache. Read in a game, where
 * 274 has always set it (the challenger's op 1 sets 30 s, its options may change it, the answer copies it).
 */
export function sandTicks(p: Player): number {
    const id = rlIds().timepermove;
    if (id === -1) return SAND_TICKS[1];
    const own = SAND_TICKS[varbit(p, id)] ?? SAND_TICKS[1];
    const other = partnerOf(p);
    return other ? Math.min(own, SAND_TICKS[varbit(other, id)] ?? SAND_TICKS[1]) : own;
}

/** the tick of its turn by which the bot has clicked: MOVE_DEADLINE, sooner on a shorter timer (15 s: 21) */
export function moveDeadline(p: Player): number {
    return Math.min(MOVE_DEADLINE, sandTicks(p) - SAND_MARGIN);
}

/**
 * a person's think before a move: 3-15 s × the persona's reaction, within the deadline (ticks); on a shorter timer
 * than 30 s the think is shorter by as much (15 s: 1.5-7.5 s), and still within its deadline. The same one roll.
 */
export function thinkTicks(p: Player, random: () => number = Math.random): number {
    const sand = sandTicks(p);
    const scale = Math.min(1, sand / SAND_TICKS[1]);
    const base = (THINK_TICKS[0] + (THINK_TICKS[1] - THINK_TICKS[0]) * random()) * scale;
    return Math.max(scale < 1 ? 2 : 3, Math.min(moveDeadline(p) - 4, Math.round(base * botPersona(p).reaction)));
}

// ── the room ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** in the Games Room under Burthorpe (either floor) */
export function inGamesRoom(x: number, z: number): boolean {
    const [x0, z0, x1, z1] = PeriodPlaces.GAMES_ROOM_BOX;
    return x >= x0 && x <= x1 && z >= z0 && z <= z1;
}

/** in the Runelink room (either floor: a challenge there opens its options at once) */
export function inRunelinkRoom(x: number, z: number): boolean {
    const [x0, z0, x1, z1] = PeriodPlaces.RUNELINK_ROOM_BOX;
    return x >= x0 && x <= x1 && z >= z0 && z <= z1;
}

/**
 * The player who challenged `bot` and waits for its answer: one in the Games Room on its floor within 15 tiles, its
 * %duel2accept this bot's uid, its own screen closed (its Challenge clicked: 274's options close on it), in no game.
 */
export function challengerOf(bot: Player): Player | null {
    const uid = bot.uid | 0;
    for (const p of worldPlayers()) {
        if (p === bot || p.level !== bot.level || Math.max(Math.abs(p.x - bot.x), Math.abs(p.z - bot.z)) > 15) continue;
        if (partnerUid(p) !== uid || p.modalMain !== -1 || ingameVarbit(p) || !inGamesRoom(p.x, p.z)) continue;
        return p;
    }
    return null;
}

/** the player `p` plays or challenged (its %duel2accept), if still in the world */
export function partnerOf(p: Player): Player | null {
    const uid = partnerUid(p);
    if (uid === -1 || uid === 0) return null;
    return World.getPlayerByUid(uid);
}

/** a game's moves at most (the board's 42 slots) and the end screen's time after (ticks) */
const GAME_MOVES = 42;
const END_SCREEN_TICKS = 100;

/**
 * (BotManager's session end, the review's G-2) how long a bot in a Runelink game, or on its end screen, may hold its
 * session's end (play ticks from when it was first held): the whole game's moves at its sand timer and the end screen,
 * longer than the session's 10-minute give-up on a slow game (2 min a move: 84 minutes), so it never logs out
 * mid-game (274's resign) against the human, or a bot. 0 for any other bot, and while theme G is off.
 */
export function runelinkHold(p: Player): number {
    if (!periodOn() || p.slot === -1) return 0;
    if (!ingameVarbit(p) && !onViewScreen(p)) return 0;
    return GAME_MOVES * sandTicks(p) + END_SCREEN_TICKS;
}

// ── the stats ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** the runner's PC6 and the tests */
export const runelinkStats = {
    visits: 0,
    challenges: 0,
    accepted: 0,
    humanChallenges: 0,
    humanGames: 0,
    games: 0,
    finished: 0,
    /** games over (a bot-bot game counted once: half by each) */
    gamesFinished: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    moves: 0,
    /** turns that ended without the bot's click (274's sand timer) */
    forced: 0,
    /** games it left by closing the board (its opponent gone) */
    resigned: 0,
    ended: {} as Record<string, number>
};

export function runelinkStatsCopy(): typeof runelinkStats {
    return JSON.parse(JSON.stringify(runelinkStats)) as typeof runelinkStats;
}

export function resetRunelinkStatsForTest(): void {
    for (const k of Object.keys(runelinkStats) as (keyof typeof runelinkStats)[]) {
        if (k === 'ended') runelinkStats.ended = {};
        else (runelinkStats as Record<string, unknown>)[k] = 0;
    }
}
