// port (bots ideas, round 3, theme G: period content): theme G's talk that is not a set piece:
//   - the answers (port/BotAnswers' G period block, through port/BotPeriod periodTalk.answer): where a kitten comes from
//     ("gertrude west of varrock 100gp"), the Games Room ("under burthorpe"), what Runelink is ("its like connect 4 lol"),
//     Gnomeball ("gnome stronghold"), Castle Wars (never open: "not out yet", "next month i think"); "wanna play
//     runelink?" to a bot waiting in the Games Room: "ya challenge me" (the human's challenge is answered: the bot never
//     challenges first), elsewhere "maybe later";
//   - the thread topic pet's question (port/BotThreads, through periodTalk.hasPetOut): a pet out now;
//   - (bots ideas, round 3 tune, 2026-11-01: period talk weighted up to about 3 %, PC8) the period's idle
//     talk: now and then the chatter's due idle line is one of the period's instead (port/BotChatter, through
//     periodTalk.idleLine: periodIdleLine), PERIOD_IDLE_SHARE × (0.5 + curiosity) of the time, of a kind the bot may say
//     (the Games Room and Runelink, Gnomeball, kittens (its own when it has one out), Castle Wars to come, the rock crabs
//     (×3 near Rellekka), the Fremennik Trials (×2 near Rellekka), Horror from the Deep for combat 30+), kind 'idle' in
//     the due line's place: H7 and the human's lines (X1) stay, the talk shifts. (The KQ fixes, T-3: the two quests'
//     talk done or still to do as the bot's own answer to "did you do X" says, port/BotAnswers saysQuestDone: at combat 45
//     done, below it to do; one kind of the two fits, each with the quest's weight.) Its lines: the talk-* groups of
//     data/lines2004-period.json (event 'period') and lines2004-buzz.json (event 'buzz'), never noted on a bot, so the
//     idle picker never says them out of turn.
// Members worlds only; nothing while theme G is off (periodOn: no pick, no dice).
import type Player from '#/engine/entity/Player.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { periodOn } from '#/engine/bot/port/BotPeriod.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { hasPetOut } from '#/engine/bot/port/BotPets.js';
import { inGamesRoom } from '#/engine/bot/port/BotRunelink.js';
// ---- (bots ideas, round 3 tune: G period) the period's idle talk ----
import World from '#/engine/World.js';
import { arcLines, sayArcLine } from '#/engine/bot/port/BotArcsSay.js';
import { speakerFree } from '#/engine/bot/port/BotLines.js';
import { botPersona } from '#/engine/bot/port/BotTiming.js';
// ---- end of the tune's imports ----
// ---- (the KQ fixes, T-3) the update's quests done or not as the bot's answers say (port/BotAnswers' QUESTS) ----
import { saysQuestDone } from '#/engine/bot/port/BotAnswers.js';
// ---- end of T-3's import ----

/** every answer this module can give (test/chat-filter.test.mjs) */
export const PERIOD_ANSWERS = {
    kitten: ['gertrude west of varrock 100gp', 'gertrude, west of varrock', 'buy one off gertrude, 100gp', 'gertrude sells them, west of varrock', 'from gertrude after the fluffs quest'],
    gamesRoom: ['under burthorpe', 'burthorpe, down the stairs', 'its under burthorpe', 'go down the stairs in burthorpe'],
    runelink: ['its like connect 4 lol', 'get 4 in a row', 'connect 4 basically', 'u get 4 runes in a row'],
    playYes: ['ya challenge me', 'sure challenge me', 'ok challenge me', 'ya go on'],
    playNo: ['maybe later', 'nah im busy', 'later maybe', 'not now lol'],
    gnomeball: ['gnome stronghold', 'the pitch in the gnome stronghold', 'gnome stronghold, west side', 'in the gnome stronghold'],
    castleWars: ['not out yet', 'next month i think', 'its not out yet lol', 'comes out soon', 'soon i think', 'not till next month']
} as const;

const KITTEN = /\b(where|how)\b.*\b(kitten|kitty|kittens|cat|cats)\b|\bget a (kitten|cat|kitty)\b|\bbuy a (kitten|cat)\b/;
const GAMES_ROOM = /\b(where|how)\b.*\b(games room|game room|gamesroom)\b|\bwhere\b.*\brunelink\b/;
const RUNELINK_WHAT = /\b(what is|whats|wats|how do (you|i) play) runelink\b/;
const PLAY = /\b(wanna|want to|lets|let us|any1|anyone|anybody|u want to|you want to) (play )?runelink\b|^runelink\??$|\bplay runelink\b/;
const GNOMEBALL = /\b(where|how)\b.*\bgnome ?ball\b/;
const CASTLE_WARS = /\b(castle wars|castlewars|cw)\b.*\b(out|open|when|where|how|is|play|playing)\b|\b(when|where|how|is)\b.*\b(castle wars|castlewars)\b/;

/** is the bot waiting in the Games Room for a game (its visit's wait) */
function waitingInRoom(bot: Player): boolean {
    if (!inGamesRoom(bot.x, bot.z)) return false;
    const task = BotManager.botFor(bot)?.currentTask as { name?: string; phase?: string } | null | undefined;
    return task?.name === 'GamesRoom' && task.phase === 'wait';
}

/** port/BotAnswers' question about theme G's content: the answer, or null (theme G off, a free world: null, no pick) */
export function periodAnswer(msg: string, bot: Player, pick: (pool: readonly string[]) => string): { id: string; text: string } | null {
    if (!periodOn() || !isMembersWorld()) return null;
    if (PLAY.test(msg)) return { id: 'period_play', text: pick(waitingInRoom(bot) ? PERIOD_ANSWERS.playYes : PERIOD_ANSWERS.playNo) };
    if (RUNELINK_WHAT.test(msg)) return { id: 'period_runelink', text: pick(PERIOD_ANSWERS.runelink) };
    if (GAMES_ROOM.test(msg)) return { id: 'period_gamesroom', text: pick(PERIOD_ANSWERS.gamesRoom) };
    if (KITTEN.test(msg)) return { id: 'period_kitten', text: pick(PERIOD_ANSWERS.kitten) };
    if (GNOMEBALL.test(msg)) return { id: 'period_gnomeball', text: pick(PERIOD_ANSWERS.gnomeball) };
    if (CASTLE_WARS.test(msg)) return { id: 'period_cw', text: pick(PERIOD_ANSWERS.castleWars) };
    return null;
}

/** port/BotThreads' topic pet: a pet out now (theme G on, a members world) */
export function petOutForTalk(p: Player): boolean {
    return hasPetOut(p);
}

// ---- (bots ideas, round 3 tune: G period) the period's idle talk in the due idle line's place (the header) ----

/** the chatter's due idle line is the period's talk this often, × (0.5 + curiosity): about 5 % of a bot's idle lines */
export const PERIOD_IDLE_SHARE = 0.05;
/** Rellekka's square, and the crabs' and the trials' talk the more within this of it (as port/BotThreads' crabs topic) */
const RELLEKKA: readonly [number, number] = [2660, 3670];
const RELLEKKA_TALK = 60;
const nearRellekka = (p: Player): boolean => p.level === 0 && Math.max(Math.abs(p.x - RELLEKKA[0]), Math.abs(p.z - RELLEKKA[1])) <= RELLEKKA_TALK;

/**
 * the idle talk's kinds: its lines' event and kind (port/BotArcsSay arcLines), its weight for the bot, and who may say
 * it (no dice). Spread over the update's things; Castle Wars (to come) a small part
 */
interface IdleKind {
    event: 'period' | 'buzz';
    kind: string;
    weight: (p: Player) => number;
    fits?: (p: Player) => boolean;
}
// ---- (the KQ fixes, T-3) the update's two quests as port/BotAnswers' QUESTS names them; HFTD talked of from combat 30 ----
const FREMMY = 'the fremennik trials';
const HFTD = 'horror from the deep';
export const HFTD_TALK_COMBAT = 30;
const fremmyWeight = (p: Player): number => (nearRellekka(p) ? 2 : 0.8);
// ---- end of T-3's names ----
export const PERIOD_IDLE_KINDS: readonly IdleKind[] = [
    { event: 'period', kind: 'talk-games', weight: () => 1 },
    { event: 'period', kind: 'talk-gnomeball', weight: () => 0.6 },
    { event: 'period', kind: 'talk-kitten', weight: () => 0.8, fits: p => !hasPetOut(p) },
    { event: 'period', kind: 'talk-pet', weight: () => 2, fits: p => hasPetOut(p) },
    { event: 'period', kind: 'talk-cw', weight: () => 0.5 },
    { event: 'buzz', kind: 'talk-crabs', weight: p => (nearRellekka(p) ? 3 : 1), fits: p => p.combatLevel >= 15 },
    // ---- (the KQ fixes, T-3) the quests' talk split, done and to do (lines2004-buzz.json's talk-*-done, talk-*-todo, a
    // group of lines either may say), by the rule of the bot's answers (saysQuestDone): "fremennik trials took me ages"
    // and then "not yet" to the human's "did you do the fremennik trials?" no more. One of each pair fits a bot (HFTD's to
    // do from combat 30, as its talk was), with the quest's old weight: the kinds' shares as they were ----
    { event: 'buzz', kind: 'talk-fremmy-done', weight: p => fremmyWeight(p), fits: p => saysQuestDone(p.combatLevel, FREMMY) },
    { event: 'buzz', kind: 'talk-fremmy-todo', weight: p => fremmyWeight(p), fits: p => !saysQuestDone(p.combatLevel, FREMMY) },
    { event: 'buzz', kind: 'talk-hftd-done', weight: () => 1, fits: p => saysQuestDone(p.combatLevel, HFTD) },
    { event: 'buzz', kind: 'talk-hftd-todo', weight: () => 1, fits: p => p.combatLevel >= HFTD_TALK_COMBAT && !saysQuestDone(p.combatLevel, HFTD) }
    // ---- end of T-3's kinds ----
];

/** the idle talk's counts: due lines asked (theme G on, a members world), rolled in, said, by kind (tests) */
export const periodTalkStats = { asked: 0, rolled: 0, said: 0, byKind: {} as Record<string, number> };
export function resetPeriodTalkStatsForTest(): void {
    periodTalkStats.asked = 0;
    periodTalkStats.rolled = 0;
    periodTalkStats.said = 0;
    periodTalkStats.byKind = {};
}

/**
 * port/BotChatter's due idle line, now and then the period's (kind 'idle', said at once in its place: budget 'slot'),
 * fresh and not said by SPEAKER_CAP others lately (port/BotLines speakerFree, as an idle line): true when said. Theme G
 * off or a free world: false at once, no dice.
 */
export function periodIdleLine(bot: Player): boolean {
    if (!periodOn() || !isMembersWorld()) return false;
    periodTalkStats.asked++;
    if (Math.random() >= PERIOD_IDLE_SHARE * (0.5 + botPersona(bot).curiosity)) return false;
    periodTalkStats.rolled++;
    const kinds = PERIOD_IDLE_KINDS.filter(k => !k.fits || k.fits(bot));
    const total = kinds.reduce((a, k) => a + k.weight(bot), 0);
    if (total <= 0) return false;
    let roll = Math.random() * total;
    let kind = kinds[kinds.length - 1];
    for (const k of kinds) {
        roll -= k.weight(bot);
        if (roll <= 0) {
            kind = k;
            break;
        }
    }
    const now = World.currentTick;
    const pool = arcLines(kind.event, kind.kind).filter(text => speakerFree(bot.username, text, now));
    const said = sayArcLine(bot, pool, {}, { kind: 'idle', budget: 'slot', spoke: 'idle' });
    if (!said) return false;
    periodTalkStats.said++;
    periodTalkStats.byKind[kind.kind] = (periodTalkStats.byKind[kind.kind] ?? 0) + 1;
    return true;
}
// ---- end of the tune's block ----
