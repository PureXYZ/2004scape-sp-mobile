// port (bots ideas, round 4: theme I, the model for the bots' own talk, stage 1): the on-device model words some of the bots' talk between themselves near the human, as it
// words their replies to the human (port/BotModel). The rules still decide everything else: who talks, when, what about
// and what the line says (their line is the hint, "(answer idea: ...)", and the fallback); the model only words it.
//
// What it words (stage 1, the shipped model):
//   - a thread's turns after the opener (port/BotThreads.turn, kind 'thread'): the speaker's situation with its partner in
//     the human's place, the partner's last line as `heard`, the rules' drawn turn as the hint; the openers ("wc lvl?",
//     "still 41?", a second topic's "btw ...") and the closer stay the rules';
//   - a bot's answer to another bot's question or named line (port/BotChat.botAnswer, kind 'botanswer'): the asker's line
//     as `heard`, the rules' answer as the hint; the asker's "ty", the question back and answerBack's counter turn stay
//     the rules'.
// When (ambientWords, every check before anything is drawn: none of it draws a die):
//   - Settings › Bot chat › Bots' own talk is Model, a model writes the replies, and the on-device model is in the app
//     (port/BotModel ambientAvailable; ambient lines never go to Claude, nor with Think first: the page's think false);
//   - the speaker stands within AMBIENT_RANGE (15) tiles of a human on its floor (lines the human can see);
//   - nothing is in flight (modelRequestsInFlight 0: a reply to the human never waits behind these; (round 4 fixes)
//     nor is one 'busy' for one: port/BotModel's MAX_IN_FLIGHT counts the replies, and native stops one running);
//   - AMBIENT_GAP_TICKS (34, 20 s) since the last ambient request, world-wide.
// The timing: the rules' own (port/BotChat ambientKeyboard: their line's typing, the same dice as sayTyped), the bot held
// at its keyboard to the deadline, AMBIENT_SLACK_TICKS (4) past it; the model's line, through the guard (its ambient
// checks too: the counter-question and the numbers kept, and (round 4 fixes) no counter-question of its own) and the
// persona's style, said at max(the answer + 1, its own typing time) and never past the deadline; any fallback (the
// deadline, an error, the guard, a reply to the human superseding it, (round 4 fixes) any line of the bot's to a human:
// port/BotChat.sayTyped) says the rules' line at its rules' time, or at once when that has passed. No retry. So a thread is
// delayed by 4 ticks at most, and only when the model is slow. The model's words are styled and timed on dice of their
// own (the bot's name and the request's id: port/BotSeed), never the world's: a fallback draws nothing the rules' line
// would not, and with the model's words the world's dice run as with the rules' line, so a run with the model and one
// without are the same world but for the words and their timing (humanlike's LM7 compares them).
// Its numbers: port/BotModel's modelStats.ambient (and its log, marked `ambient`): humanlike's LM1-LM8.
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { ambientKeyboard, botPersona, sayTypedAt, type TypedLine } from '#/engine/bot/port/BotChat.js';
import { ambientAvailable, askModel, modelChannel, modelRequestsInFlight, modelStats, NATIVE_TIMEOUT_MS, type ModelLogEntry } from '#/engine/bot/port/BotModel.js';
import { AMBIENT_COUNTER_RX } from '#/engine/bot/port/BotModelGuard.js';
import { renderLocal, situationOf } from '#/engine/bot/port/BotModelPrompt.js';
import type { OnlinePrompt } from '#/engine/bot/port/BotModelTypes.js';
import { worldPlayers } from '#/engine/bot/port/BotPlayers.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { styleLine } from '#/engine/bot/port/BotStyle.js';
import { typingTicks } from '#/engine/bot/port/BotTiming.js';

/** a speaker this close to a human on its floor (Chebyshev; about the client's view): its line may be the model's */
export const AMBIENT_RANGE = 15;
/** 20 s between two ambient requests, world-wide (at most 180 an hour) */
export const AMBIENT_GAP_TICKS = 34;
/** the deadline: the rules' own say time + this; then the rules' line at once */
export const AMBIENT_SLACK_TICKS = 4;

/** the kinds of the bots' own talk a model words (stage 1) */
export type AmbientKind = 'thread' | 'botanswer';

/** A line of the bots' own talk the rules decided, for the model to word. */
export interface AmbientRequest {
    kind: AmbientKind;
    /** who says it */
    bot: Player;
    /** whom it says it to (the human's place in the situation and the prompt) */
    partner: Player;
    /** the partner's line it answers, as it was said */
    heard: string;
    /** the rules' words: the hint ("(answer idea: ...)"), whose counter-question and numbers the model's line keeps */
    hint: string;
    /** the rules' line as the bot would say it (a thread's turn: styled), the fallback */
    ruleText: string;
    /** the intent the rules read in the partner's line (a bot's answer: its id), or none: the kind is the hint's intent */
    intent?: string | null;
    /** ticks before it starts to type (its notice: drawn by the caller, as before) */
    extra: number;
    /** told the words said (the model's styled, or the rules' line), before the line's `then` */
    onSaid?: (text: string) => void;
}

/** Claude's prompt for an ambient request: none (ambient lines go to the on-device model only; native never reads it) */
const NO_ONLINE: OnlinePrompt = Object.freeze({ system: '', context: '', user: '' });

const rates = { gap: AMBIENT_GAP_TICKS, range: AMBIENT_RANGE };
let lastAskAt = -Infinity;

/** a human (not a bot, logged in) on the bot's floor within `range` tiles */
function nearHuman(bot: Player, range: number): boolean {
    for (const p of worldPlayers()) {
        if (p.is_bot === true || p.slot === -1 || p.level !== bot.level) continue;
        if (Math.abs(p.x - bot.x) <= range && Math.abs(p.z - bot.z) <= range) return true;
    }
    return false;
}

/**
 * Why this line stays the rules' ('off': Bots' own talk is not the model's, or no channel; 'mod': the player-mod bot's
 * lines are always the rules'; 'far': no human near; 'inflight': a request in flight; 'pacing': the 20 s gap), or null:
 * the model may word it. No dice.
 */
export function ambientRefusal(bot: Player): string | null {
    if (!ambientAvailable() || modelChannel() === null) return 'off';
    if (bot.staffModLevel > 0) return 'mod';
    if (!nearHuman(bot, rates.range)) return 'far';
    if (modelRequestsInFlight() > 0) return 'inflight';
    if (World.currentTick - lastAskAt < rates.gap) return 'pacing';
    return null;
}

/** the line said, noted in the log entry (LM5, LM8) and told to the caller, before its own `then` */
function saidLine(line: TypedLine, entry: ModelLogEntry, text: string, onSaid?: (text: string) => void): TypedLine {
    const then = line.then;
    return {
        ...line,
        then: () => {
            entry.said = text;
            entry.saidAt = World.currentTick;
            onSaid?.(text);
            then?.();
        }
    };
}

/**
 * The bots' own talk in the on-device model's words: the rules' line `req` (to be said with `line`: to, kind, then)
 * asked of the model, said in its words or the rules' (port/BotModel askModel). False when the model may not word it
 * (ambientRefusal: nothing done, nothing drawn): the caller says the rules' line as before.
 */
export function ambientWords(req: AmbientRequest, line: TypedLine): boolean {
    const why = ambientRefusal(req.bot);
    if (why === 'off') return false;
    if (why !== null) {
        const skipped = modelStats.ambient.skipped;
        skipped[why] = (skipped[why] ?? 0) + 1;
        return false;
    }
    const bot = req.bot;
    const persona = botPersona(bot);
    const now = World.currentTick;
    lastAskAt = now;
    // (the rules' timing, as sayTyped would type their line now; the keyboard held to the deadline)
    const kb = ambientKeyboard(bot, req.ruleText, req.extra, AMBIENT_SLACK_TICKS);
    const situation = situationOf({ bot, to: req.partner, heard: req.heard, channel: 'public', via: req.kind, greeted: false, intent: { id: req.intent ?? req.kind, text: req.hint } }, now);
    // (native's own timeout a tick before the deadline: its rules' line then at its time, not said late)
    const timeoutMs = Math.max(1000, Math.min(NATIVE_TIMEOUT_MS, (kb.deadline - now - 1) * 600));
    askModel({
        bot,
        to: req.partner,
        via: req.kind,
        intent: req.intent ?? null,
        candidate: false,
        heard: req.heard,
        situation,
        local: renderLocal(situation),
        online: NO_ONLINE,
        ruleText: req.ruleText,
        deadline: kb.deadline,
        // (the partner's name as the model wrote it: no echo roll, no die)
        keepName: true,
        ambient: { rulesDue: kb.due, counter: AMBIENT_COUNTER_RX.test(req.hint.trim()), timeoutMs },
        use: (text, entry) => {
            kb.release();
            // (the words' own dice: the world's run as with the rules' line)
            const dice = seededRandom(nameSeed(bot.username, `ambient#${entry.id}`));
            const styled = styleLine(text, persona, dice);
            // (its own typing time from the decision, after the answer, and never past the deadline)
            const due = Math.max(World.currentTick + 1, Math.min(kb.deadline, kb.start + req.extra + typingTicks(persona, styled.line, { busy: kb.busy, random: dice })));
            sayTypedAt(bot, styled.line, saidLine(line, entry, styled.line, req.onSaid), due, styled.correction, dice);
        },
        fallback: (_reason, entry) => {
            kb.release();
            // (the rules' line at its rules' time, or at once when that has passed)
            sayTypedAt(bot, req.ruleText, saidLine(line, entry, req.ruleText, req.onSaid), Math.max(World.currentTick, kb.due));
            return req.ruleText;
        }
    });
    return true;
}

/** (tests) the 20 s gap and the range (default: AMBIENT_GAP_TICKS, AMBIENT_RANGE), and the gap's clock forgotten */
export function setAmbientRatesForTest(opts: { gap?: number; range?: number } = {}): void {
    rates.gap = opts.gap ?? AMBIENT_GAP_TICKS;
    rates.range = opts.range ?? AMBIENT_RANGE;
    lastAskAt = -Infinity;
}

/** (tests) the tick of the last ambient request (-Infinity: none yet) */
export function lastAmbientAskForTest(): number {
    return lastAskAt;
}
