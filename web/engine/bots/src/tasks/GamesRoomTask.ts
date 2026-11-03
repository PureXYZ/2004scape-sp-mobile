/**
 * GamesRoomTask.ts (port; bots ideas, round 3, theme G: period content; with an override on Runelink's
 * timeouts): a
 * visit to the Games Room under Burthorpe to play Runelink (274's game_gamesroom), through the real stairs, screens and
 * buttons, at a person's pace.
 *
 *   - Who: a members world's levelling bot (port/BotMinigames' catalogue, key 'GamesRoom', weight 2 x its liking: its
 *     sociability, a kid's 1.5 times; the far budget). While one waits alone in the room, a bot within ROOM_JOIN_TILES
 *     of the stairs that may come is offered a join, ROOM_JOIN of its asks, past the budget, as a Trawler crew's; at most
 *     roomCap(N) in the room (2 at 100 online, 6 at 500).
 *   - The way in: Burthorpe's stairs (board_game_stairs_grey_all, 274's telejump to the arrival hall), the hall's stairs
 *     down (board_game_stairs_top), a tile of its own in the Runelink room; each stairs' move marked as the game's.
 *   - The wait (2-6 minutes the first time): the human's challenge is answered in 3-10 s (its op 1 back, then Challenge:
 *     the human's %duel2accept is the bot's uid, port/BotRunelink challengerOf) when its session has a game's time left
 *     (GAME_LEFT; else it is off), a bot's in 2-6 s; with a free partner (a bot waiting in the room) the one waiting
 *     longer challenges it: op 1, Challenge. Bots never challenge the human; now and then a room line ("any1 wanna play
 *     runelink?").
 *   - The game: its role 'runelink' (port/BotSetPieces setRole: its session's end, an abrupt leave, a "come here", a
 *     random event and its breaks wait for it) from the challenge to the end screen, past the session's give-up too
 *     (BotManager, port/BotRunelink runelinkHold); each turn a think of 3-15 s, then the column (port/BotRunelink
 *     chooseColumn), never past MOVE_DEADLINE (sooner on the human's 15 s timer: moveDeadline): 274's sand timer never
 *     runs out on a bot. An opponent gone, the board is closed (274's resign).
 *   - After: the end screen read and closed (its Close), "gg" now and then, the rank's word; again (AGAIN, up to 1-3
 *     games), else the way out: the stairs base, the hall's stairs up to Burthorpe (port/BotExits' Games Room rule, which
 *     any walk from the room takes).
 * Its name 'GamesRoom' (MINIGAME_KINDS: MG1; the runner's H19 leaves its seated waits out). A minigame visit
 * (port/BotOutings) and a period visit of kind 'games' (port/BotPeriod: PC10).
 */
import {
    BotTask, Player,
    walkTo, interactLoc, findLocByName,
    StuckDetector, randInt,
} from '#/engine/bot/tasks/BotTaskBase.js';
import World from '#/engine/World.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import { interactIfButtonByName, interactPlayerOp, noteMove } from '#/engine/bot/BotAction.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { PeriodPlaces } from '#/engine/bot/BotKnowledge.js';
import { countMinigame, noteOutingEnd, noteOutingStart, onlineN, outingRate, ticksSinceOuting } from '#/engine/bot/port/BotOutings.js';
import { notePeriodEnd, notePeriodStart, periodOn } from '#/engine/bot/port/BotPeriod.js';
import { sayPeriodLine } from '#/engine/bot/port/BotPeriodPlan.js';
import { clearRole, eventRoleOf, setRole } from '#/engine/bot/port/BotSetPieces.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { botPersona } from '#/engine/bot/port/BotTiming.js';
import { arcsTie } from '#/engine/bot/port/BotArcsEvents.js';
import { gamesRoomOut } from '#/engine/bot/port/BotExits.js';
import {
    MOVE_DEADLINE, boardOf, challengerOf, chooseColumn, closeMode, inGamesRoom, inRunelinkGame, inRunelinkRoom, ingameVarbit, moveDeadline, myTurn,
    onOptionsScreen, onViewScreen, partnerOf, runelinkRank, runelinkStats, strengthOf, thinkTicks
} from '#/engine/bot/port/BotRunelink.js';

// ── the defaults (G-content §5: approved) ──────────────────────────────────────────────────────────────────────────

/** the catalogue's weight is port/BotMinigames'; a lone waiter's join: this often, within this of the stairs */
export const ROOM_JOIN = 0.5;
export const ROOM_JOIN_TILES = 150;
/** bots in the room at most: ROOM_PER_100 per 100 online, at least ROOM_MIN (2 at 100, 6 at 500) */
export const ROOM_PER_100 = 1.2;
export const ROOM_MIN = 2;
/** the first wait (ticks: 2-6 min), a wait after a game, the games a visit plays at most, and again after one */
export const WAIT_FIRST: readonly [number, number] = [1200, 3600];
export const WAIT_AGAIN: readonly [number, number] = [500, 1500];
export const GAMES: readonly [number, number] = [1, 3];
export const AGAIN = 0.4;
/** the human's challenge answered within (ticks: 3-10 s); a bot's; a challenge to a partner after this long together */
export const HUMAN_ANSWER: readonly [number, number] = [5, 17];
const BOT_ANSWER: readonly [number, number] = [3, 10];
const CHALLENGE_AFTER: readonly [number, number] = [5, 20];
/** a session's ticks left for a game (a typical one, 15 min): another game, or the human's challenge answered */
export const GAME_LEFT = 1500;
/** the end screen read for (ticks) */
const VIEW_TICKS: readonly [number, number] = [3, 9];
/** a visit is over after this long whatever happened (ticks: 40 min) */
const VISIT_TICKS = 24000;
/** an opponent gone this long and the board is closed */
const GONE_TICKS = 10;
/** the lines' odds */
const GO_LINE = 0.3;
const THERE_LINE = 0.25;
const CALL_LINE = 0.12;
const GG_LINE = 0.6;
const RESULT_LINE = 0.3;
const REMATCH_LINE = 0.4;

/**
 * Burthorpe's castle, whose hall holds the stairs down: its front (outside its double doors, south), the hall from those
 * doors north to the stairs (the probe: front, the double doors' Open, then straight north), and the castle's box (its
 * side rooms, the soldiers' too: a bot there walks out to the front first, as a click on the stairs from a side room
 * routed to the wrong side of their wall: "I can't reach that!")
 */
const CASTLE_FRONT: readonly [number, number] = [2898, 3554];
const HALL_IN: readonly [number, number] = [2898, 3561];
function inStairsHall(p: Player): boolean {
    return p.level === 0 && p.x >= 2897 && p.x <= 2900 && p.z >= 3559 && p.z <= 3565;
}
function inCastle(p: Player): boolean {
    // (inside its walls: north of the double doors at z 3558, south of the stairs hall's north wall at z 3570)
    return p.level === 0 && p.x >= 2888 && p.x <= 2908 && p.z >= 3559 && p.z <= 3569;
}

/** the pieces on a board */
function piecesOn(board: Int8Array): number {
    let n = 0;
    for (const v of board) if (v !== 0) n++;
    return n;
}

/** bots in the room (or on their way) now: their tasks */
const room = new Set<GamesRoomTask>();

/** how many bots may be in the room at once for `n` online */
export function roomCap(n: number = onlineN()): number {
    return Math.max(ROOM_MIN, Math.round((ROOM_PER_100 * n) / 100));
}

function sweep(): void {
    for (const t of room) if (t.isDone || t.botGone) room.delete(t);
}

/** the bots on a Games Room visit now (or on the way) */
export function roomCount(): number {
    sweep();
    return room.size;
}

/** a bot waiting in the room alone: no partner coming, none in the room free (the join's call) */
export function waitingAlone(): boolean {
    sweep();
    let waiting = 0;
    let coming = 0;
    for (const t of room) {
        if (t.phase === 'wait') waiting++;
        else if (t.phase === 'travel' || t.phase === 'down' || t.phase === 'room') coming++;
    }
    return waiting === 1 && coming === 0;
}

/** may the bot play now (the catalogue's and the join's check; theme G's switch is the caller's) */
export function mayPlay(p: Player): boolean {
    if (!isMembersWorld() || isNewbie(p) || p.combatLevel < 3) return false;
    return p.levels[PlayerStat.HITPOINTS] * 2 >= p.baseLevels[PlayerStat.HITPOINTS];
}

/** the catalogue's liking: its sociability, a kid's 1.5 times (G-content §4.3 "Who") */
export function gamesRoomLiking(p: Player): number {
    const persona = botPersona(p);
    return (0.5 + persona.sociability) * (persona.ageBand === 'kid' ? 1.5 : 1);
}

/** The catalogue's entry: a first bot down the stairs, while the room has space. Theme G off: null, no dice. */
export function gamesRoomTaskFor(p: Player): BotTask | null {
    if (!periodOn() || !mayPlay(p) || roomCount() >= roomCap()) return null;
    return new GamesRoomTask('leader');
}

/**
 * The join (port/BotMinigames' hook, after its free check): a bot waits alone in the room, this bot is within
 * ROOM_JOIN_TILES of the stairs, the room has space, its last outing an hour ago: ROOM_JOIN of the time (the roll last).
 * Theme G off: null, no dice.
 */
export function gamesRoomJoinFor(p: Player, outingGap: number): BotTask | null {
    if (!periodOn() || !waitingAlone() || roomCount() >= roomCap() || !mayPlay(p)) return null;
    const [sx, sz] = PeriodPlaces.GAMES_STAIRS_DOWN;
    if (p.level !== 0 || Math.max(Math.abs(p.x - sx), Math.abs(p.z - sz)) > ROOM_JOIN_TILES) return null;
    if (ticksSinceOuting(p.username) < outingGap) return null;
    if (Math.random() >= Math.min(1, ROOM_JOIN * outingRate())) return null;
    return new GamesRoomTask('joiner');
}

type Phase = 'travel' | 'down' | 'room' | 'wait' | 'challenge' | 'answer' | 'game' | 'view' | 'leave' | 'done';

export class GamesRoomTask extends BotTask {
    readonly role: 'leader' | 'joiner';
    phase: Phase = 'travel';
    private readonly stuck = new StuckDetector(40, 4, 3);
    private started = -1;
    private _player: Player | null = null;
    private outcome = 'done';
    private ended = false;
    /** the tile of its own in the Runelink room */
    private stand: [number, number] | null = null;
    /** at the castle's front on the way in (the stairs' click after) */
    private atFront = false;
    private waitUntil = -1;
    private waitSince = -1;
    private called = false;
    /** a stairs' click: when, and how many */
    private clickAt = -1000;
    private clickGap = 8;
    /** the castle's double doors clicked, and the walks round to its front */
    private doorClicks = 0;
    /** its last tick with a target or a route (a door opened on the way): the next click a moment after */
    private busyAt = -1000;
    private clicks = 0;
    /** a challenge under way (made or answered): to whom, its step, when */
    private other: Player | null = null;
    private step: 'op' | 'screen' | 'sent' = 'op';
    private stepAt = -1;
    private nextChallenge = -1;
    /** the game: its turn's start, the move's due tick, a click made this turn, the rank before, its opponent */
    private turnStart = -1;
    private moveAt = -1;
    private deadline = MOVE_DEADLINE;
    private turnPieces = 0;
    private clicked = false;
    private rank0 = 0;
    private opponent: Player | null = null;
    private goneSince = -1;
    private viewUntil = -1;
    private readonly gamesWanted: number;
    private games = 0;
    private lastOpponent: string | null = null;
    private strength: { win: number; block: number } | null = null;
    /** a partner's challenge expected (another bot chose it): since when */
    private claimedAt = -1;

    constructor(role: 'leader' | 'joiner', games = randInt(GAMES[0], GAMES[1])) {
        super('GamesRoom');
        this.role = role;
        this.gamesWanted = games;
    }

    get isDone(): boolean {
        return this.phase === 'done';
    }

    get botGone(): boolean {
        return this._player !== null && this._player.slot === -1;
    }

    /** waiting in the room and free for a challenge (no challenge under way, no game) */
    get free(): boolean {
        return this.phase === 'wait' && this.other === null;
    }

    shouldRun(_player: Player): boolean {
        return this.phase !== 'done' && !this.interrupted;
    }

    isComplete(_player: Player): boolean {
        return this.phase === 'done';
    }

    override interrupt(): void {
        // (an empty world's logout, a rescue: a game under way is closed first, 274's resign; never left seated)
        const p = this._player;
        if (p && p.slot !== -1 && inRunelinkGame(p)) {
            p.closeModal();
            runelinkStats.resigned++;
        }
        super.interrupt();
        this._end(p, 'interrupted');
    }

    tick(player: Player): void {
        if (this.interrupted || this.phase === 'done') return;
        this._player = player;
        const now = World.currentTick;
        if (this.started === -1) {
            this.started = now;
            room.add(this);
            runelinkStats.visits++;
            noteOutingStart(player, 'GamesRoom', 'burthorpe', 'minigame');
            notePeriodStart(player, 'GamesRoom', 'games');
            if (inGamesRoom(player.x, player.z)) this.phase = player.level === 1 ? 'down' : 'room';
            else if (Math.random() < GO_LINE) sayPeriodLine(player, 'period', 'games-go');
        }
        // (a game is never cut short by the visit's time: it ends first)
        if (now - this.started > VISIT_TICKS && this.phase !== 'game' && this.phase !== 'view' && this.phase !== 'leave') this._leave(player, 'time');
        if (this.cooldown > 0 && this.phase !== 'game') {
            this.cooldown--;
            return;
        }
        // (a game began, whatever the bot thought it was doing: its challenge answered)
        if (this.phase !== 'game' && this.phase !== 'view' && inRunelinkGame(player)) this._startGame(player, now);
        switch (this.phase) {
            case 'travel':
                return this._travel(player, now);
            case 'down':
                return this._down(player, now);
            case 'room':
                return this._room(player, now);
            case 'wait':
                return this._wait(player, now);
            case 'challenge':
            case 'answer':
                return this._challenge(player, now);
            case 'game':
                return this._game(player, now);
            case 'view':
                return this._view(player, now);
            case 'leave':
                if (!inGamesRoom(player.x, player.z) && player.level === 0) {
                    // (up in Burthorpe's castle: out by its doors to its front, then the visit is over)
                    const [fx, fz] = CASTLE_FRONT;
                    if ((inCastle(player) || inStairsHall(player)) && now - this.started < VISIT_TICKS + 1500 && !this.stuck.desperatelyStuck) {
                        if (!this.stuck.check(player, fx, fz)) {
                            if (!player.hasWaypoints() || now % 10 === 0) walkTo(player, fx, fz, 0);
                        } else walkTo(player, fx, fz, 0);
                        return;
                    }
                    this._end(player, this.outcome);
                    return;
                }
                if (!gamesRoomOut(player)) this._end(player, 'stuck');
                return;
        }
    }

    // ── the way in ──

    private _travel(player: Player, now: number): void {
        if (inGamesRoom(player.x, player.z)) {
            this.phase = player.level === 1 ? 'down' : 'room';
            this.clicks = 0;
            return;
        }
        // (the stairs stand in a room of Burthorpe's castle, three shut doors in: the castle's front first, then the
        // stairs' own click from there, whose route opens each door on the way in turn, BotAction interactLoc; a walk to
        // a tile inside from the castle's north side wandered round its walls)
        const [sx, sz] = PeriodPlaces.GAMES_STAIRS_DOWN;
        const [fx, fz] = CASTLE_FRONT;
        if (!inStairsHall(player)) {
            if (!this.atFront) {
                if (player.level === 0 && Math.max(Math.abs(player.x - fx), Math.abs(player.z - fz)) <= 2) {
                    this.atFront = true;
                    this.stuck.reset();
                } else this._walk(player, fx, fz, 0);
                return;
            }
            // (at the front: the double doors' Open when they are shut, then in to the hall; the stairs' click only from
            // there: from a side room or the front its route went round the hall's wall, "I can't reach that!")
            if (player.delayed || player.target !== null) return;
            const shut = findLocByName(2898, 3558, 0, 'loc_1516', 1) ?? findLocByName(2899, 3558, 0, 'loc_1519', 1);
            if (shut) {
                if (now - this.clickAt < this.clickGap) return;
                if (++this.doorClicks > 5) {
                    this._leave(player, 'door');
                    return;
                }
                interactLoc(player, shut);
                this.clickAt = now;
                this.clickGap = randInt(6, 14);
                return;
            }
            const [hx, hz] = HALL_IN;
            if (this.stuck.check(player, hx, hz)) {
                // (no way in from here: round to the front again, a few times)
                this.stuck.reset();
                this.atFront = false;
                if (++this.doorClicks > 5) this._leave(player, 'door');
                return;
            }
            if (!player.hasWaypoints()) walkTo(player, hx, hz, 0);
            return;
        }
        this._stairs(player, now, 'board_game_stairs_grey_all', sx, sz, 0, 6);
    }

    private _down(player: Player, now: number): void {
        if (player.level === 0 && inGamesRoom(player.x, player.z)) {
            this.phase = 'room';
            this.clicks = 0;
            this.stuck.reset();
            return;
        }
        const [tx, tz] = PeriodPlaces.GAMES_STAIRS_TOP[0];
        this._stairs(player, now, 'board_game_stairs_top', tx, tz, 1);
    }

    /** a flight of stairs clicked (its move the game's), again after a while (a door opened on the way first), a few times */
    private _stairs(player: Player, now: number, name: string, x: number, z: number, level: number, most = 5): void {
        // (a person's moment between clicks, never the same twice: H18; the route under way, a door on it opened, first)
        if (player.target !== null || player.hasWaypoints()) this.busyAt = now;
        if (player.delayed || now - this.clickAt < this.clickGap || (player.target !== null && now - this.clickAt < 30) || player.hasWaypoints() || now - this.busyAt < this.clickGap / 2) return;
        const loc = findLocByName(x, z, level, name, 3);
        if (!loc || ++this.clicks > most) {
            this._leave(player, 'stairs');
            return;
        }
        interactLoc(player, loc);
        noteMove(player, 'event');
        this.clickAt = now;
        this.clickGap = randInt(6, 15);
    }

    private _room(player: Player, now: number): void {
        if (!this.stand) {
            const [x0, z0, x1, z1] = PeriodPlaces.RUNELINK_ROOM_BOX;
            this.stand = [randInt(x0 + 1, x1 - 1), randInt(z0 + 1, z1 - 1)];
        }
        const [x, z] = this.stand;
        const there = player.level === 0 && Math.max(Math.abs(player.x - x), Math.abs(player.z - z)) <= 1;
        if (!there && !this.stuck.check(player, x, z)) {
            if (!player.hasWaypoints()) walkTo(player, x, z, 0);
            return;
        }
        // (there, or as near as it gets: the wait)
        player.clearWaypoints();
        this.phase = 'wait';
        this.waitSince = now;
        this.waitUntil = now + randInt(WAIT_FIRST[0], WAIT_FIRST[1]);
        this.nextChallenge = now + randInt(CHALLENGE_AFTER[0], CHALLENGE_AFTER[1]);
        if (Math.random() < THERE_LINE) sayPeriodLine(player, 'period', 'games-there');
    }

    // ── the wait: answer a challenge, make one ──

    private _wait(player: Player, now: number): void {
        // (the human's challenge first, then a bot's: answered at a person's moment)
        const by = challengerOf(player);
        if (by) {
            const human = by.is_bot !== true;
            // (the human's challenge with less than a game's time left in its session: it is off instead, as one who
            // must go soon, so a game with the human never starts on borrowed time: the review's G-2)
            if (human && BotManager.sessionLeftOf(player.username) < GAME_LEFT) {
                this._leave(player, 'late');
                return;
            }
            if (human) runelinkStats.humanChallenges++;
            this._beginChallenge(player, by, 'answer', now + randInt(...(human ? HUMAN_ANSWER : BOT_ANSWER)));
            return;
        }
        // (a partner's challenge expected that never came: free again)
        if (this.other !== null && now - this.claimedAt > 60) this.other = null;
        if (now >= this.waitUntil && this.other === null) {
            this._leave(player, this.games > 0 ? 'done' : 'nobody');
            return;
        }
        // (a free partner: the one waiting longer challenges; a rematch, or a bot it knows, first)
        if (now >= this.nextChallenge) {
            this.nextChallenge = now + randInt(CHALLENGE_AFTER[0], CHALLENGE_AFTER[1]);
            const partner = this._partner(player);
            if (partner) {
                this._beginChallenge(player, partner, 'challenge', now);
                return;
            }
        }
        if (!this.called && now - this.waitSince > 300 && Math.random() < CALL_LINE / 100) {
            this.called = true;
            sayPeriodLine(player, 'period', 'games-call');
        }
    }

    /** a bot to challenge: free in the room on this floor, one that waited less (the longer waiter challenges) */
    private _partner(player: Player): Player | null {
        let best: GamesRoomTask | null = null;
        let bestScore = -Infinity;
        for (const t of room) {
            const q = t._player;
            if (t === this || !t.free || !q || q.slot === -1 || q.level !== player.level || !inRunelinkRoom(q.x, q.z) && !inGamesRoom(q.x, q.z)) continue;
            if (Math.max(Math.abs(q.x - player.x), Math.abs(q.z - player.z)) > 15) continue;
            // (the longer waiter challenges: ties by name)
            if (t.waitSince < this.waitSince || (t.waitSince === this.waitSince && q.username < player.username)) continue;
            const tie = arcsTie(player.username, q.username);
            const score = (q.username === this.lastOpponent ? 2 : 0) + (tie ? Math.min(2, tie.acquaintance) - 2 * tie.grudge : 0);
            if (score > bestScore) {
                bestScore = score;
                best = t;
            }
        }
        if (!best) return null;
        best.other = player;
        best.claimedAt = World.currentTick;
        return best._player;
    }

    private _beginChallenge(player: Player, other: Player, phase: 'challenge' | 'answer', at: number): void {
        this.phase = phase;
        this.other = other;
        this.step = 'op';
        this.stepAt = at;
        setRole(player, 'runelink');
        if (phase === 'challenge') runelinkStats.challenges++;
    }

    /** the challenge's clicks: op 1 on the other, its screen (the room's challenge screen: Runelink, Select), Challenge */
    private _challenge(player: Player, now: number): void {
        const other = this.other;
        if (!other || other.slot === -1) return this._backToWait(player, now);
        if (now < this.stepAt) return;
        if (this.step === 'op') {
            interactPlayerOp(player, other.slot, 1);
            this.step = 'screen';
            this.stepAt = now;
            return;
        }
        if (this.step === 'screen') {
            if (player.modalMain !== -1 && !onOptionsScreen(player)) {
                // (another screen: not the challenge's)
                if (now - this.stepAt > 20) return this._backToWait(player, now);
                return;
            }
            if (!onOptionsScreen(player)) {
                if (now - this.stepAt > 25) return this._backToWait(player, now);
                return;
            }
            if (now - this.stepAt < 2) return;
            // (outside the Runelink room 274 asks which game first)
            if (interactIfButtonByName(player, 'boardgames_challenge:runelink_radio')) {
                interactIfButtonByName(player, 'boardgames_challenge:select');
                this.stepAt = now;
                return;
            }
            if (interactIfButtonByName(player, 'boardgames_runelink_options:challenge')) {
                this.step = 'sent';
                this.stepAt = now;
                if (this.phase === 'answer') runelinkStats.accepted++;
            } else if (now - this.stepAt > 25) this._backToWait(player, now);
            return;
        }
        // (sent: the game begins with the other's Challenge, or our answer's own; else back to the wait)
        if (now - this.stepAt > (this.phase === 'challenge' ? 45 : 15)) this._backToWait(player, now);
    }

    private _backToWait(player: Player, now: number): void {
        if (onOptionsScreen(player)) player.closeModal();
        this.other = null;
        this.phase = 'wait';
        this.nextChallenge = now + randInt(CHALLENGE_AFTER[0] * 3, CHALLENGE_AFTER[1] * 3);
        clearRole(player);
    }

    // ── the game ──

    private _startGame(player: Player, now: number): void {
        // (274's p_telejump to a table, a tick ago: the game's move, for the runner's jumps)
        noteMove(player, 'event');
        this.phase = 'game';
        setRole(player, 'runelink');
        this.opponent = partnerOf(player) ?? this.other;
        this.other = null;
        this.turnStart = -1;
        this.clicked = false;
        this.goneSince = -1;
        this.rank0 = runelinkRank(player);
        runelinkStats.games++;
        if (this.opponent && this.opponent.is_bot !== true) runelinkStats.humanGames++;
        countMinigame('GamesRoom', 'games');
        void now;
    }

    private _game(player: Player, now: number): void {
        if (!inRunelinkGame(player)) {
            // (over: the end screen, or the board closed some other way)
            this._toView(player, now, onViewScreen(player) ? 'finished' : 'closed');
            return;
        }
        // (an opponent gone: the board closed, 274's resign; never left seated)
        if (!this.opponent || this.opponent.slot === -1 || partnerOf(player) === null) {
            if (this.goneSince === -1) this.goneSince = now;
            if (now - this.goneSince >= GONE_TICKS) {
                player.closeModal();
                runelinkStats.resigned++;
                this._toView(player, now, 'gone');
            }
            return;
        }
        this.goneSince = -1;
        if (myTurn(player)) {
            // (a turn over that it never saw end: its click runs at once, and a quick opponent's move came before its
            // next tick, so its turn again with no tick of the other's between; the board two pieces on tells it)
            if (this.turnStart !== -1 && piecesOn(boardOf(player)) >= this.turnPieces + 2) {
                if (!this.clicked) runelinkStats.forced++;
                this.turnStart = -1;
            }
            if (this.turnStart === -1) {
                // (the deadline by the game's sand timer: a 15 s game's sooner, the review's G-1)
                this.turnStart = now;
                this.clicked = false;
                this.moveAt = now + thinkTicks(player);
                this.deadline = moveDeadline(player);
                this.turnPieces = piecesOn(boardOf(player));
            }
            if (this.clicked) return;
            if (now >= this.moveAt || now - this.turnStart >= this.deadline - 2) {
                const strength = (this.strength ??= strengthOf(player.username));
                const col = chooseColumn(boardOf(player), strength);
                if (col > 0 && interactIfButtonByName(player, `boardgames_runelink:column_${col}`)) {
                    this.clicked = true;
                    runelinkStats.moves++;
                }
            }
            return;
        }
        // (its turn over: a turn it never clicked was 274's forced move)
        if (this.turnStart !== -1) {
            if (!this.clicked) runelinkStats.forced++;
            this.turnStart = -1;
            this.clicked = false;
        }
    }

    private _toView(player: Player, now: number, how: string): void {
        // (274's p_teleport back to the Runelink room at the game's end: the game's move)
        noteMove(player, 'event');
        this.phase = 'view';
        this.viewUntil = now + randInt(VIEW_TICKS[0], VIEW_TICKS[1]);
        runelinkStats.finished++;
        // (a game between two bots is one game, counted half by each)
        runelinkStats.gamesFinished += this.opponent && this.opponent.is_bot === true ? 0.5 : 1;
        runelinkStats.ended[how] = (runelinkStats.ended[how] ?? 0) + 1;
        // (274's own result, %boardgames_closemode, read before the end screen's close resets it; else the rank's change)
        const mode = closeMode(player);
        const rank = runelinkRank(player);
        const result = mode === 1 ? 'win' : mode === 2 ? 'loss' : mode === 3 ? 'draw' : rank > this.rank0 ? 'win' : rank < this.rank0 ? 'loss' : 'draw';
        runelinkStats[result === 'win' ? 'wins' : result === 'loss' ? 'losses' : 'draws']++;
        countMinigame('GamesRoom', 'finished');
        this.games++;
        this.lastOpponent = this.opponent?.username ?? null;
        const to = this.opponent && this.opponent.slot !== -1 ? this.opponent : null;
        if (how === 'finished' && Math.random() < GG_LINE) sayPeriodLine(player, 'period', 'games-gg', to);
        else if (how === 'finished' && Math.random() < RESULT_LINE) sayPeriodLine(player, 'period', result === 'win' ? 'games-win' : result === 'loss' ? 'games-lose' : 'games-gg', to);
    }

    private _view(player: Player, now: number): void {
        if (now < this.viewUntil && onViewScreen(player)) return;
        // (the end screen's Close: 274's if_close resets the challenge)
        if (onViewScreen(player) || (player.modalMain !== -1 && !ingameVarbit(player))) player.closeModal();
        clearRole(player);
        this.opponent = null;
        const again = this.games < this.gamesWanted && now - this.started < VISIT_TICKS && Math.random() < AGAIN;
        if (!again || BotManager.sessionLeftOf(player.username) < GAME_LEFT) {
            this._leave(player, 'done');
            return;
        }
        this.phase = 'wait';
        this.waitSince = now;
        this.waitUntil = now + randInt(WAIT_AGAIN[0], WAIT_AGAIN[1]);
        this.nextChallenge = now + randInt(CHALLENGE_AFTER[0], CHALLENGE_AFTER[1]);
        if (this.lastOpponent && Math.random() < REMATCH_LINE) sayPeriodLine(player, 'period', 'games-rematch');
    }

    // ── the way out ──

    private _leave(player: Player, outcome: string): void {
        if (this.phase === 'leave' || this.phase === 'done') return;
        this.outcome = outcome;
        if (eventRoleOf(player)?.role === 'runelink') clearRole(player);
        if (onOptionsScreen(player)) player.closeModal();
        this.other = null;
        if (!inGamesRoom(player.x, player.z)) {
            this._end(player, outcome);
            return;
        }
        this.phase = 'leave';
    }

    private _end(player: Player | null, outcome: string): void {
        this.phase = 'done';
        room.delete(this);
        if (this.ended) return;
        this.ended = true;
        if (player) {
            if (eventRoleOf(player)?.role === 'runelink') clearRole(player);
            noteOutingEnd(player, outcome);
            notePeriodEnd(player, outcome);
        }
    }

    private _walk(player: Player, x: number, z: number, level: number): void {
        if (!this.stuck.check(player, x, z)) {
            if (!player.hasWaypoints() || World.currentTick % 10 === 0) walkTo(player, x, z, level);
            return;
        }
        // (no jump for a visit: a walk that cannot get there ends it, and the bot's next task goes on from here)
        if (this.stuck.desperatelyStuck) {
            this._leave(player, 'stuck');
            return;
        }
        player.clearWaypoints();
        walkTo(player, x, z, level);
    }

    /** (the debugger, the runner) its phase */
    get state(): string {
        return this.phase;
    }
}

/** (tests) the visits under way */
export function roomTasksForTest(): readonly GamesRoomTask[] {
    sweep();
    return [...room];
}

/** (tests) forget the room */
export function resetRoomForTest(): void {
    room.clear();
}
