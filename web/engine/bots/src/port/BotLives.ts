// port (bots ideas, round 2, theme C: lives with arcs):
// the table through which the shared files reach theme C's modules (port/BotGoals, BotMoods, BotLeaving, BotWhims,
// BotNinetyNine), so each shared file carries one marked block calling an entry here and imports none of
// them (no import cycle: this module is a leaf, types only; weddings were cut this round). Each C module fills its entries when it loads
// (port/BotSetPieceIndex imports them, BotManager imports that); an entry left empty is "nothing to do": the shared file
// goes on as before (a test world without theme C, an older library's tests).
//
//   the planner (BotGoalPlanner, its "C arcs" blocks)
//     beginPick / endPick   around every pick of a levelling or extra bot's planner (a tilted bot's risky pick, BotFumble)
//     plannerTask           before the candidates: a goal's purchase come into reach (the upgrade path's shop trip), a whim's
//                           own trip (a skiller's Wilderness whim, an outing)
//     candidates            the candidates reordered: a whim's skill first, then the goal's lean, then boredom's avoidance
//     bankstandSooner       a gear or money goal's skiller: its bankstand session 25 % sooner
//     extrasTask            an extra's (vendor, social, PKer) whim at its session's first pick, and its bank on the way back
//     picked                the task picked (boredom's clock: the task kind it does)
//   the chatter (BotChatter)
//     levelUp               a level-up that completed a goal: the celebration in the level-up line's place
//     sayPending            the celebration said (the pending line it set)
//     idleLine              the due idle line from a mood's pool (tilt, elation, boredom), or nothing
//     dropValue             a fighter's pick-up worth noting (an item id and its value): elation, the big-drop leave
//   the answers (BotAnswers.stateAnswer) and the threads (BotThreads Side)
//     goalAnswer            "whats ur goal": the bot's own goal, or null (upstream's replies)
//     sideGoal / sideWant   a thread's {goal} and {want} from the saved goal
//   the chat (BotChat), the steals (BotRude), the fumbles (BotFumble), the endgame (BotEndgameCore)
//     rudeReplyScale        a tilted rude talker's rude replies (x1.5)
//     gzWeight              an elated bot is the likelier gz responder (the same number of gz)
//     riskyNow              a tilted careless bot's pick: isShaken ignored once, its careless roll doubled
//     endgameScale          a bosser whose goal points at the endgame: its endgame trips more often
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import type { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';

/** a celebration the chatter holds in its pending slot (BotChatter: Pending.arc) */
export interface LivesPending {
    pool: readonly string[];
    slots: Readonly<Record<string, string | number>>;
    /** the goal-done line goes to the bots near as a level-up's (BotChat.onBotLine: their gz) */
    gz: boolean;
    /** 'slot': it is the level-up's own line (its roll passed); 'own': in the place of the bot's next due line */
    budget?: 'slot' | 'own';
    /** what the line is about, for the C log */
    event: string;
    /** the module's own note of it (a goal's log entry: its line's tick) */
    entry?: { said?: number };
}

export interface LivesHooks {
    beginPick?(player: Player): void;
    /** the task picked: a replacement (a whim's, timed), or null (as picked) */
    endPick?(player: Player, task: BotTask | null): BotTask | null;
    plannerTask?(player: Player, weights: Readonly<Partial<Record<string, number>>>): BotTask | null;
    /** a whim due at the session's first pick: it takes the carry-on's place */
    whimFirst?(player: Player): boolean;
    candidates?(player: Player, candidates: string[], weights: Readonly<Partial<Record<string, number>>>): void;
    bankstandSooner?(player: Player): boolean;
    extrasTask?(player: Player, type: string): BotTask | null;
    levelUp?(bot: Player, stat: string, level: number): LivesPending | null;
    sayPending?(bot: Player, pending: LivesPending): boolean;
    idleLine?(bot: Player): boolean;
    dropValue?(bot: Player, id: number): void;
    goalAnswer?(bot: Player, msg: string): string | null;
    sideGoal?(bot: Player): string | null;
    sideWant?(bot: Player): string | null;
    rudeReplyScale?(bot: Player): number;
    gzWeight?(bot: Player): number;
    riskyNow?(bot: Player): boolean;
    endgameScale?(p: Player): number;
}

/** theme C's entries (each C module fills its own at load) */
export const LIVES: LivesHooks = {};

/**
 * theme C on or off: on in the game (always); a staged test world turns it off unless it asks for it (test/lib/simworld
 * Sim.create's `lives`, as the far-town outings are), so another theme's staged scenes run as before theme C: its hooks
 * out of this table (the shared files' blocks do nothing) and its listeners and passes idle (no dice drawn)
 */
export const LIVES_CTL = { on: true };
let stashed: LivesHooks | null = null;
/** (tests) theme C on or off (above). Never called by the game. */
export function setLivesForTest(on: boolean): void {
    if (on === LIVES_CTL.on) return;
    LIVES_CTL.on = on;
    if (!on) {
        stashed = { ...LIVES };
        for (const k of Object.keys(LIVES) as (keyof LivesHooks)[]) delete LIVES[k];
    } else if (stashed) {
        Object.assign(LIVES, stashed);
        stashed = null;
    }
}

// ── theme C's lines said (the humanlike runner's AR4, AR10; the tests) ──────────────────────────────────────────────

export interface LivesLine {
    t: number;
    name: string;
    /** its group's event (arcs-goal, arcs-mood, arcs-leave, arcs-99, arcs-whim, arcs-party) and kind */
    event: string;
    kind: string;
    text: string;
}
const LINES_MAX = 5000;
export const livesLines: LivesLine[] = [];

/** a C line said (sayArcLine's result), for the log */
export function noteLivesLine(bot: Player, event: string, kind: string, text: string): void {
    livesLines.push({ t: World.currentTick, name: bot.username, event, kind, text });
    if (livesLines.length > LINES_MAX) livesLines.splice(0, livesLines.length - LINES_MAX);
}
