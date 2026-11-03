// port (bots ideas, round 3, theme H: movement): walk up to talk and stop to talk. 2004's players walked over to the one they talked to and stood
// still to type; the bots' threads (port/BotThreads) used to open 6 tiles apart (62 % of them 5+) and a quarter of
// their turns were typed by a bot walking off.
//
//   - STOP TO TALK (H4). holdForTalk(p, partner, maxTicks): the bot stands (its waypoints cleared) while the hold lasts;
//     port/BotHabits.tickHabits asks tickTalkHold in its marked block and returns true meanwhile, so its task is not
//     ticked and its watchdogs wait, as for a look at a spectacle. The hold is not "away": the bot answers a line said to
//     it, and a human's line ends the hold (never ignored). BotThreads holds both bots of a thread, from its first line
//     to 2-6 ticks after its last (at most HOLD_MAX ticks), when each is talkHoldable and walking or idle: a bot working
//     its resource (a tree, a rock, a fishing spot, a fight) is not held; 2004's players chatted at their trees. A hold
//     ends at once on the thread's end (going() false), a hit, a trade, a fight, an attacker within 8, the human talking
//     to the bot, a set piece, a logout.
//   - WALK UP TO TALK (H3). walkUpThen(a, b, onReady, onFail, maxTicks): `a` claims a free tile within 2 of `b`
//     (port/BotTiles), is held by a hold whose tick walks there (one short search), `b` held where it is if it was
//     walking (a stranger called over stops) or idle, not if it works its resource (a standing partner's task walked
//     it off in 4 of the first 9 walk-ups at 500 bots); every 2 ticks it looks: `a` within 3 of `b`, onReady (the
//     thread begins); after maxTicks or `b` more than 15 off, both let go and onFail. BotThreads.startThread's
//     opener walks up to a partner 5-12 tiles off when it stands free, at 0.3 + 0.5 × sociability (a clique mate
//     0.8); a walking opener with a stranger more than 4 tiles off opens no thread ('walking': its due line is said as
//     before). Exported for theme D (tie greetings, grudge lines) and round 4's I.
//   - talkHoldable(p): free for a hold or a walk-up: no fight (the combat lock, an aggressor within 8), HP at half or
//     more, out of the Wilderness, no script or delay, no trade or window, not talking with a human, not a newbie, no
//     sub-task, no "come here", not a PK task, the Duel Arena or agility, no set piece role, not a vendor, and no
//     noHoldWhile hook (another theme's: B's vultures, A's boss trips, C's leaving).
//   - The switch is port/BotMinimap's: movementOn('walkUp'), movementOn('holds') (off in a staged test world unless it
//     asks for movement: test/lib/simworld Sim.create({ movement: true })). Every hook asks it BEFORE any roll.
//   - At its load it gives port/BotMinimap what that leaf does not import: the typing rule's check (port/BotChat midTalk)
//     and the set piece roles' exemption from hops (port/BotSetPieces eventRoleOf).
// No new lines, nothing saved: the thread's length is the rules' (the talk budget, H7), only the walking off goes.
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import { BotChat } from '#/engine/bot/port/BotChat.js';
import { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';
import { minimapExempt, minimapHooks, movementOn, movementRates } from '#/engine/bot/port/BotMinimap.js';
import { botScript, findAggressorNpc, walkTo } from '#/engine/bot/BotAction.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { tradeScreen } from '#/engine/bot/port/BotTradeScreen.js';
import { claimStandTile, releaseStandTile, standTileOf } from '#/engine/bot/port/BotTiles.js';
import { scheduleInTicks } from '#/engine/bot/port/BotSchedule.js';
import { sameClique } from '#/engine/bot/port/BotCliques.js';
import { botPersona } from '#/engine/bot/port/BotTiming.js';
import { habitOf } from '#/engine/bot/port/BotHabits.js';

/** no talk hold and no walk-up while one of these is true for the bot (true: not now), pushed at the pusher's load */
export const noHoldWhile: ((player: Player) => boolean)[] = [];

// ---- port/BotMinimap's hooks: the typing rule (no new hop while a line is typed) and no hops in a set piece role ----
minimapHooks.typing = (player: Player): boolean => BotChat.midTalk(player);
minimapExempt.push((player: Player): boolean => eventRoleOf(player) !== null);
// ---- the other themes' walks (the spec's overrides), never hopped nor held:
//   - A's boss trips and boss-team follows: every bot on an endgame trip carries the set-piece role 'bosser'
//     (port/BotEndgameCore), a team's follow is a sub-task: the set-piece exemption above and BotAction's sub-task rule;
//   - B's vultures and pile rushes: tasks/LootPileTask is a sub-task (port/BotLoot setSubTask), its walks short;
//   - C's leaving walks: a leave's bank trip is a sub-task (port/BotLeaving bankBigDrop), and the session's wrap-up
//     (BotHabits' leaving: the bank, the last click, the goodbye) is named here ----
const leaving = (player: Player): boolean => habitOf(player) === 'leaving';
minimapExempt.push(leaving);
noHoldWhile.push(leaving);

/** a hold lasts at most this long (36 s) */
export const HOLD_MAX = 60;
/** a thread's hold ends this long after its last line (ticks): the bot steps again 2-6 ticks after it (its first step the
 * tick after its task queues the walk) */
export const HOLD_AFTER: [number, number] = [1, 5];
/** the walk-up: a partner this far (tiles) is walked up to; the opener stops within WALK_UP_NEAR; the tile within WALK_UP_TILE of the partner */
export const WALK_UP_FROM: [number, number] = [5, 12];
export const WALK_UP_NEAR = 3;
const WALK_UP_TILE = 2;
/** a walk-up is given up after this long (ticks), or with the partner this far off */
export const WALK_UP_TICKS = 15;
const WALK_UP_LOST = 15;
/** a walking opener opens no thread with a stranger more than this far off */
export const WALKING_STRANGER = 4;
/** the walk-up's chance: WALK_UP_BASE + WALK_UP_SOCIAL × sociability; a clique mate WALK_UP_MATE */
const WALK_UP_BASE = 0.3;
const WALK_UP_SOCIAL = 0.5;
const WALK_UP_MATE = 0.8;

/** task kinds whose bots are never held nor walked up with (PK, the Duel Arena, agility: their own timing) */
const NO_HOLD_KINDS = new Set(['PKer', 'EdgevillePKer', 'DuelArena', 'AgilityArena', 'Agility']);

/** what the holds and walk-ups did (tests, the humanlike runner's MV6 and MV7) */
export const talkMoveStats = {
    holds: 0,
    /** holds that ended, by why */
    ended: {} as Record<string, number>,
    holdTicks: 0,
    walkUps: 0,
    walkUpsReady: 0,
    walkUpsFailed: 0,
    /** threads a walking opener did not open (a stranger more than 4 off) */
    walking: 0
};

/** (tests) every stat back to zero */
export function resetTalkMoveStatsForTest(): void {
    talkMoveStats.holds = talkMoveStats.holdTicks = talkMoveStats.walkUps = talkMoveStats.walkUpsReady = talkMoveStats.walkUpsFailed = talkMoveStats.walking = 0;
    talkMoveStats.ended = {};
}

type BotAi = { hasSubTask?: () => boolean; currentTask?: { name?: string } | null };
const aiOf = (p: Player): BotAi | undefined => (p as unknown as { _bot?: BotAi })._bot;
const cheb = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

/**
 * Free for a talk hold or a walk-up: no fight, not hurt to half, no aggressor within 8, out
 * of the Wilderness, no script or delay, no trade or window, not talking with a human, not a newbie, no sub-task or
 * "come here", not a PK task, the Duel Arena or agility, no set piece role, not a vendor, no noHoldWhile hook. Draws no
 * dice.
 */
export function talkHoldable(p: Player): boolean {
    if (p.slot === -1 || !p.is_bot) return false;
    if (p.botComeHereReturnX !== -1 || p.botTradeTargetPid !== -1 || tradeScreen(p) !== null || p.containsModalInterface()) return false;
    if (World.currentTick < p.preventLogoutUntil || p.delayed || botScript(p) !== null) return false;
    if (p.levels[PlayerStat.HITPOINTS] * 2 < p.baseLevels[PlayerStat.HITPOINTS]) return false;
    if (isNewbie(p) || wildernessLevelAt(p.x, p.z) > 0 || p.botPlanner === 'extras_vendor') return false;
    const ai = aiOf(p);
    if (!ai || ai.hasSubTask?.()) return false;
    if (NO_HOLD_KINDS.has((ai.currentTask?.name ?? '').split(':')[0])) return false;
    if (eventRoleOf(p) !== null || BotChat.inConversation(p)) return false;
    for (const hook of noHoldWhile) if (hook(p)) return false;
    return findAggressorNpc(p, 8) === null;
}

/** working its resource or a fight (an interaction under way): a bot that keeps working while it talks */
function working(p: Player): boolean {
    return p.target !== null;
}

// ── holds ─────────────────────────────────────────────────────────────────────

interface TalkHold {
    partner: Player;
    since: number;
    /** the latest it lasts */
    until: number;
    /** its end after the thread's last line (-1: not yet) */
    endAt: number;
    /** Hitpoints when held (a hit ends it) */
    hp: number;
    /** a walk-up's: the tile it walks to (null: it stands) */
    walk: [number, number] | null;
    /** a walk-up's tile claimed (released with the hold) */
    claimed: boolean;
}
const holds = new WeakMap<Player, TalkHold>();

/** the bot's talk hold under way (tests, the runner), or null */
export function talkHoldOf(p: Player): Readonly<TalkHold> | null {
    return holds.get(p) ?? null;
}

/** Is the bot held for talk now? */
export function talkHeld(p: Player): boolean {
    const h = holds.get(p);
    return h !== undefined && World.currentTick < h.until && (h.endAt < 0 || World.currentTick < h.endAt);
}

/**
 * The bot stops for a talk with `partner`, at most `maxTicks` (a hold under way is kept, its latest end moved out):
 * its waypoints cleared. False (no hold) when the holds are off or the bot is not talkHoldable. Draws no dice.
 */
export function holdForTalk(p: Player, partner: Player, maxTicks = HOLD_MAX): boolean {
    if (!movementOn('holds') || !talkHoldable(p)) return false;
    const now = World.currentTick;
    const held = holds.get(p);
    if (held && talkHeld(p)) {
        held.partner = partner;
        held.until = Math.max(held.until, now + maxTicks);
        held.endAt = -1;
        return true;
    }
    holds.set(p, { partner, since: now, until: now + Math.min(maxTicks, HOLD_MAX), endAt: -1, hp: p.levels[PlayerStat.HITPOINTS], walk: null, claimed: false });
    p.clearWaypoints();
    talkMoveStats.holds++;
    return true;
}

/** The bot's talk hold ends `after` ticks from now (0: at once); `why` for the counts. */
export function releaseTalk(p: Player, after = 0, why = 'done'): void {
    const h = holds.get(p);
    if (!h) return;
    if (after > 0) {
        h.endAt = World.currentTick + after;
        return;
    }
    endHold(p, h, why);
}

function endHold(p: Player, h: TalkHold, why: string): void {
    if (holds.get(p) !== h) return;
    holds.delete(p);
    if (h.claimed && standTileOf(p) !== null) releaseStandTile(p);
    talkMoveStats.ended[why] = (talkMoveStats.ended[why] ?? 0) + 1;
    talkMoveStats.holdTicks += World.currentTick - h.since;
}

/** what ends a hold at once (null: nothing) */
function holdBroken(p: Player, h: TalkHold): string | null {
    if (p.slot === -1 || h.partner.slot === -1) return 'logout';
    if (p.botComeHereReturnX !== -1) return 'errand';
    if (p.botTradeTargetPid !== -1 || tradeScreen(p) !== null) return 'trade';
    if (World.currentTick < p.preventLogoutUntil) return 'fight';
    if (p.levels[PlayerStat.HITPOINTS] < h.hp) return 'hit';
    if (BotChat.inConversation(p)) return 'human';
    if (eventRoleOf(p) !== null) return 'setpiece';
    if (aiOf(p)?.hasSubTask?.()) return 'subtask';
    return findAggressorNpc(p, 8) !== null ? 'attacker' : null;
}

/**
 * port/BotHabits.tickHabits (its marked block): true while a talk hold holds the bot (its task waits); a walk-up's hold
 * walks it to its tile meanwhile. A hold that ran out or broke is let go (false).
 */
export function tickTalkHold(p: Player): boolean {
    const h = holds.get(p);
    if (!h) return false;
    const now = World.currentTick;
    if (now >= h.until) {
        endHold(p, h, 'max');
        return false;
    }
    if (h.endAt >= 0 && now >= h.endAt) {
        endHold(p, h, 'done');
        return false;
    }
    const broken = holdBroken(p, h);
    if (broken) {
        endHold(p, h, broken);
        return false;
    }
    if (h.walk) {
        if (p.x !== h.walk[0] || p.z !== h.walk[1]) walkTo(p, h.walk[0], h.walk[1], p.level);
        else if (p.hasWaypoints()) p.clearWaypoints();
    } else if (p.hasWaypoints()) p.clearWaypoints();
    return true;
}

// ── a thread's holds (port/BotThreads' marked blocks) ─────────────────────────

/**
 * BotThreads.begin (`first`) and each turn: the thread's two bots held, each when talkHoldable and walking or idle (not
 * working its resource or a fight), until its end (threadEnded), at most HOLD_MAX from its first line. Draws no dice.
 */
export function holdThread(a: Player, b: Player, first = false): void {
    for (const [p, other] of [
        [a, b],
        [b, a]
    ] as const) {
        const h = holds.get(p);
        if (h && talkHeld(p)) {
            // (a walk-up's hold at the thread's start: the thread's own from here, HOLD_MAX from its first line; the holds
            // off, the walk-up's stand ends)
            if (first && !movementOn('holds')) endHold(p, h, 'walkup');
            else {
                h.partner = other;
                h.walk = null;
                if (first) h.until = Math.max(h.until, World.currentTick + HOLD_MAX);
            }
            continue;
        }
        if (!movementOn('holds') || (working(p) && !p.hasWaypoints())) continue;
        holdForTalk(p, other, HOLD_MAX);
    }
}

/**
 * BotThreads.turn at the thread's end: past its last line (`natural`) each bot's hold ends 2-6 ticks later; a thread
 * that stopped (going() false: one went off, a human talked, a set piece) lets go at once.
 */
export function threadEnded(a: Player, b: Player, natural: boolean): void {
    for (const p of [a, b]) {
        const h = holds.get(p);
        if (!h) continue;
        if (natural && movementOn('holds')) releaseTalk(p, HOLD_AFTER[0] + Math.floor(Math.random() * (HOLD_AFTER[1] - HOLD_AFTER[0] + 1)));
        else endHold(p, h, natural ? 'done' : 'stopped');
    }
}

// ── walk up to talk ───────────────────────────────────────────────────────────

/**
 * `a` walks up to `b` (a free tile within 2 of it, claimed), held meanwhile; `b` held too if walking or idle. When `a`
 * is within 3 tiles: onReady(); after `maxTicks`, `b` more than 15 off, or either no longer holdable: both let go and
 * onFail(). False (nothing done, onFail not called) when it cannot begin: the walk-ups off, `a` not holdable, no free
 * tile. Draws no dice (port/BotTiles' pick of the tile: its own).
 */
export function walkUpThen(a: Player, b: Player, onReady: () => void, onFail: () => void, maxTicks = WALK_UP_TICKS): boolean {
    if (!movementOn('walkUp') || a === b || a.level !== b.level || !talkHoldable(a)) return false;
    const tile = claimStandTile(a, b.x, b.z, b.level, WALK_UP_TILE);
    if (!tile) return false;
    const now = World.currentTick;
    // (a hold without the holds' switch: the walk-up's own, its walk)
    holds.set(a, { partner: b, since: now, until: now + maxTicks + 2, endAt: -1, hp: a.levels[PlayerStat.HITPOINTS], walk: tile, claimed: true });
    a.clearWaypoints();
    talkMoveStats.walkUps++;
    // (b stops where it is: walking (a stranger called over stops) or idle; one working its resource works on)
    if ((b.hasWaypoints() || !working(b)) && talkHoldable(b)) {
        holds.set(b, { partner: a, since: now, until: now + maxTicks + 2, endAt: -1, hp: b.levels[PlayerStat.HITPOINTS], walk: null, claimed: false });
        b.clearWaypoints();
    }
    const giveUp = now + maxTicks;
    const poll = (): void => {
        const ha = holds.get(a);
        const t = World.currentTick;
        // (a's hold broke: a hit, a trade, the human; or b gone off)
        if (!ha || ha.partner !== b || b.slot === -1 || a.slot === -1 || b.level !== a.level || cheb(a, b) > WALK_UP_LOST || t >= giveUp) {
            if (ha && ha.partner === b) endHold(a, ha, 'walkup-fail');
            const hb = holds.get(b);
            if (hb && hb.partner === a && hb.endAt < 0) endHold(b, hb, 'walkup-fail');
            talkMoveStats.walkUpsFailed++;
            onFail();
            return;
        }
        if (cheb(a, b) <= WALK_UP_NEAR) {
            // there: it stands (the thread's own holds take over)
            ha.walk = null;
            a.clearWaypoints();
            talkMoveStats.walkUpsReady++;
            onReady();
            return;
        }
        scheduleInTicks(2, poll);
    };
    scheduleInTicks(2, poll);
    return true;
}

/**
 * BotThreads.startThread (its marked block), the thread's lines drawn: 'walk' when `a` walks up to `b` first (the
 * caller begins on onReady), 'refuse' when a walking `a` opens no thread with a stranger more than 4 off, 'here' to
 * begin as before. Off: 'here', with no dice.
 */
export function openerMove(a: Player, b: Player): 'walk' | 'refuse' | 'here' {
    if (!movementOn('walkUp')) return 'here';
    const d = cheb(a, b);
    const mate = sameClique(a.username, b.username);
    if (a.hasWaypoints() && !mate) {
        if (d > WALKING_STRANGER) {
            talkMoveStats.walking++;
            return 'refuse';
        }
        return 'here';
    }
    if (d < WALK_UP_FROM[0] || d > WALK_UP_FROM[1]) return 'here';
    // standing free (or a mate's walk): not working, holdable
    if (working(a) || !talkHoldable(a)) return 'here';
    const chance = (mate ? WALK_UP_MATE : WALK_UP_BASE + WALK_UP_SOCIAL * botPersona(a).sociability) * movementRates.walkUp;
    return Math.random() < chance ? 'walk' : 'here';
}
