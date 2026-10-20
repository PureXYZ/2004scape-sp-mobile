// port (the realism work, phase 5b, Track A: the player-mod bot; "a silver-crown bot telling
// spammers off", the human too, at most once per 10 minutes). 2004's worlds had player
// moderators since June 2004: a silver crown before the name in the chatbox, nothing else.
//   - Who: one per world (two at 500 online or more), a pure function of the pool: of the levelling names aged experienced or
//     veteran (port/BotAge), friendly (persona friendliness 0.3+) and no meme persona, the first in the pool by the name's
//     own seed (nameSeed 'player-mod'). It plays as any levelling bot, and it never quits (BotManager._quitOne), so the
//     crown stays with one name; a human who takes the name passes it to the next.
//   - The crown: its staffModLevel is 1 (BotManager, at spawn), which port/BotSay sends with each of its lines as 274's
//     MessagePublicHandler does a human's (the client draws the silver crown; nothing else in 274 reads level 1). Never a
//     Jmod's gold crown.
//   - Its duty: it hears scam calls (a bot's line of kind 'scam', Track P's callers, or one that reads like one: upstream's
//     "Doubling gold trade me") through BotSay's sayListeners, and the human's spam through BotChat's humanLineListeners
//     (the same line 3 times in a minute, 5 lines in 20 s, a scam phrase, 3 starred words in a minute, a password);
//     within 25 tiles, on its floor, with no screen, trade, talk, break or set piece and out of the Wilderness, it walks
//     to within 6 tiles (a sub-task of a minute at most; busy at its task, a fight or a sub-task, it stays and types when
//     they are within its 15-tile view), waits a person's 3-10 s and says one line in a proper sentence ("Doubling money
//     is a scam. Don't trade him.", "Please don't spam."), kind 'mod': at most one every 2 minutes and 8 an hour, the
//     human at most once per 10 minutes and never a human whose own crown is gold (Jmod On). The scammer may answer ("wasnt
//     me lol"; a scam caller's own stint answers for itself, port/BotScams), a bot near now and then ("omg a player mod").
//     The spam log says what came of each (Q2's detail).
//   - Its answers: "is there a mod here", "r u a mod", "how do i become a mod" (port/BotAnswers' intents; here when the human
//     asks to nobody and the mod is in earshot: it answers, the bots near keep quiet).
// Per tick: nothing. A bot's line costs a regular expression; a human's line a few compares.
import WordEnc from '#/cache/wordenc/WordEnc.js';
import type Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { walkTo } from '#/engine/bot/BotAction.js';
import { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';
import { BOT_NAMES, isLevelling, normalizeBotName, plannerOf } from '#/engine/bot/port/BotRoster.js';
import { ageTierFor } from '#/engine/bot/port/BotAge.js';
import { personaOf } from '#/engine/bot/port/BotPersona.js';
import { nameSeed } from '#/engine/bot/port/BotSeed.js';
import { sayListeners, type LineKind } from '#/engine/bot/port/BotSay.js';
import { BotChat, humanLineListeners, isAddressingBot } from '#/engine/bot/port/BotChat.js';
import { isAway } from '#/engine/bot/port/BotHabits.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';
import { ANSWER_LINES } from '#/engine/bot/port/BotAnswers.js';
import { arenaLines, rand, sayArenaText } from '#/engine/bot/port/BotArena.js';
import { scheduleInTicks } from '#/engine/bot/port/BotSchedule.js';

/** within this many tiles (and its floor) the mod hears spam */
export const MOD_HEARS = 25;
/** it walks to within this many tiles, for at most this long; busy at its task, it types from where it stands within view */
const MOD_NEAR = 6;
const MOD_VIEW = 15;
const MOD_WALK_TICKS = 60;
/** a person's moment before it speaks (3-10 s) */
const MOD_REACT: [number, number] = [5, 17];
/** a duty line at most every 2 minutes and 8 an hour; the human at most once per 10 minutes */
export const MOD_GAP = 200;
export const MOD_PER_HOUR = 8;
export const MOD_HUMAN_GAP = 1000;
/** the human's spam: the same line 3 times in 60 s, 5 lines in 20 s, 3 starred words in a minute */
const SAME_LINES = 3;
const SAME_TICKS = 100;
const FLOOD_LINES = 5;
const FLOOD_TICKS = 33;
const STARRED_WORDS = 3;
/** the scammer answers the mod this often; a bot near reacts this often (one at most) */
const SCAMMER_ANSWERS = 0.6;
const NEAR_REACTS = 0.25;

/** what a scam call reads like (Track P's callers, upstream's "Doubling gold trade me", "Trimming armour, 25k gp") */
export const SCAM_TEXT = /\bdoubl(e|ing)\b.*\b(money|gold|gp|coins|cash|items)\b|\btrim(ming)?\b.*\barmou?r\b|\barmou?r\b.*\btrim(ming)?\b|\bfree (armou?r|stuff|items|trimming|members)\b|\bgiving away (free )?(stuff|items|gp|money)\b|\bsay ur pass\b/i;
/** a password named (the human's line as typed; 274's filter stars "password") */
const PASS_TEXT = /\bpass ?word\b|\bur pass\b|\byour pass\b|\bmy pass\b/i;
/** "is there a mod here", "any mods on", "r u a mod", "are you a mod", "how do i become a mod" */
const MOD_ASKED = /\b(is there|are there|any|anyone|any1) (a |any )?(player )?(mod|mods|pmod)\b|\b(are|r) (you|u) a (player )?mod\b|\bhow (do|can) (i|you|u) (become|be|get) (a )?(player )?mod\b/i;

export type Spam = 'scam' | 'spam' | 'clean' | 'pass';

// ── who ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

let byRank: string[] | null = null;
/** every bot name by its own seed ('player-mod'): the order the pick walks (a hash and a sort, once) */
function rankOrder(): string[] {
    if (!byRank) {
        const scored: [number, string][] = BOT_NAMES.map(name => [nameSeed(name, 'player-mod'), name]);
        scored.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
        byRank = scored.map(s => s[1]);
    }
    return byRank;
}

/** a name that may be the mod: levelling, aged experienced or veteran (port/BotAge), friendly, no meme persona (pure) */
function mayBeMod(name: string): boolean {
    const planner = plannerOf(name);
    if (!planner || !isLevelling(planner)) return false;
    const tier = ageTierFor(name, planner);
    if (tier !== 'experienced' && tier !== 'veteran') return false;
    const persona = personaOf(name, planner);
    return persona.friendliness >= 0.3 && !persona.meme;
}

/** (tests) the names that may be the mod, best first (the whole roster's: a persona each, so only the tests ask) */
function ranked(): string[] {
    return rankOrder().filter(mayBeMod);
}

let mods = new Set<string>();
let modsAt = -Infinity;
/** how often the pick is looked at again (the pool changes rarely: a newcomer, a name a human takes) */
const PICK_TICKS = 500;

/** (tests) the mods' names, whatever the pool (null: the pick); never set by the game */
let testMods: Set<string> | null = null;
export function setModNamesForTest(names: readonly string[] | null): void {
    testMods = names ? new Set(names.map(normalizeBotName)) : null;
    modsAt = -Infinity;
}

/** The mods' names now: the first candidates in the pool (one, two at 500 online or more). */
export function playerModNames(): ReadonlySet<string> {
    if (testMods) {
        ensureListeners();
        return testMods;
    }
    const now = World.currentTick;
    if (now - modsAt < PICK_TICKS && now >= modsAt) return mods;
    modsAt = now;
    ensureListeners();
    const want = BotManager.stats().configured >= 500 ? 2 : 1;
    const next = new Set<string>();
    // (the pool's names first, in rank order: a persona only for those, not the roster's 2,400)
    for (const name of rankOrder()) {
        if (next.size >= want) break;
        if (BotManager.sessionLeftOf(name) !== Infinity && mayBeMod(name)) next.add(name);
    }
    mods = next;
    return mods;
}

/** BotManager: is the bot of this name the player-mod bot (its crown at spawn; it never quits)? */
export function isPlayerModName(name: string): boolean {
    return playerModNames().has(normalizeBotName(name));
}

/** a bot with the crown (its staff level 1) */
export function isPlayerMod(p: Player): boolean {
    return p.is_bot === true && p.staffModLevel === 1;
}

/** (tests) the pick again at once; the names the pick ranks first (pure: the roster, the ages, the personas) */
export function repickModsForTest(): void {
    modsAt = -Infinity;
}
export function rankedModCandidates(): readonly string[] {
    return ranked();
}

// ── its duty ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Duty {
    /** its duty lines (ticks), the last hour's */
    said: number[];
}
const duties = new Map<string, Duty>();
function dutyOf(name: string): Duty {
    let d = duties.get(name);
    if (!d) duties.set(name, (d = { said: [] }));
    return d;
}
/** the human's last telling-off by name, by any mod (two mods at 500 online: still once per 10 minutes) */
const humanToldAt = new Map<string, number>();

export interface ModLogEntry {
    t: number;
    mod: string;
    what: Spam;
    /** who spammed: a bot's name, or the human's */
    who: string;
    human: boolean;
    /** the tick of the spam it answers */
    spamAt: number;
    text: string;
}
/** every duty line said, oldest first (the humanlike report's Q2, the tests) */
export const modLog: ModLogEntry[] = [];
/** what came of a spam: a mod told them off, or why none did (no mod online, none within 25 tiles, its caps, busy, a Jmod) */
export type Heard = 'told' | 'none' | 'far' | 'caps' | 'busy' | 'jmod';
/** every spam the mods heard of (the human's flagged lines, the scam calls), oldest first: Q2's ground truth */
export const spamLog: { t: number; who: string; human: boolean; what: Spam; x: number; z: number; level: number; heard: Heard }[] = [];

/** may it type a line: online and alive, no screen, trade, talk, break or set piece, out of the Wilderness */
function canSpeak(mod: Player): boolean {
    if (mod.slot === -1 || mod.levels[PlayerStat.HITPOINTS] <= 0 || !BotManager.botFor(mod) || eventRoleOf(mod)) return false;
    if (mod.botTradeTargetPid !== -1 || mod.modalMain !== -1) return false;
    return !isAway(mod) && !BotChat.inConversation(mod) && wildernessLevelAt(mod.x, mod.z) <= 0;
}

/** free to walk over: it may speak, and no fight, script delay or sub-task holds it */
function free(mod: Player): boolean {
    if (!canSpeak(mod) || mod.delayed || World.currentTick < mod.preventLogoutUntil) return false;
    return !BotManager.botFor(mod)!.hasSubTask();
}

/** the mods online now */
function modsOnline(): Player[] {
    const out: Player[] = [];
    for (const name of playerModNames()) {
        const p = World.getPlayerByUsername(name);
        if (p && p.is_bot === true && p.slot !== -1 && BotManager.botFor(p) !== null) out.push(p);
    }
    return out;
}

/**
 * Spam was said by `speaker` (a scam caller, the human): a mod within 25 tiles that is free and within its caps goes to
 * tell them off. True when one does.
 */
export function noteSpam(speaker: Player, what: Spam): boolean {
    const now = World.currentTick;
    const human = speaker.is_bot !== true;
    const entry = { t: now, who: speaker.username, human, what, x: speaker.x, z: speaker.z, level: speaker.level, heard: 'none' as Heard };
    spamLog.push(entry);
    while (spamLog.length > 2000) spamLog.shift();
    // (never a Jmod: a gold crown is not told off by a silver one)
    if (human && speaker.staffModLevel >= 2) {
        entry.heard = 'jmod';
        return false;
    }
    for (const mod of modsOnline()) {
        if (mod === speaker) continue;
        const dist = mod.level !== speaker.level ? Infinity : Math.max(Math.abs(mod.x - speaker.x), Math.abs(mod.z - speaker.z));
        if (dist > MOD_HEARS) {
            if (entry.heard === 'none') entry.heard = 'far';
            continue;
        }
        const d = dutyOf(mod.username);
        while (d.said.length && now - d.said[0] >= 6000) d.said.shift();
        if (d.said.length >= MOD_PER_HOUR || (d.said.length && now - d.said[d.said.length - 1] < MOD_GAP) || (human && now - (humanToldAt.get(speaker.username) ?? -Infinity) < MOD_HUMAN_GAP)) {
            entry.heard = 'caps';
            continue;
        }
        // free, it walks over; busy at its task (a fight, a sub-task), it types from where it stands when they are in view
        const walks = free(mod);
        if (!walks && (!canSpeak(mod) || dist > MOD_VIEW)) {
            entry.heard = 'busy';
            continue;
        }
        // (claimed at once: a second line of the same spam does not send it twice)
        d.said.push(now);
        if (human) humanToldAt.set(speaker.username, now);
        entry.heard = 'told';
        const duty: DutyOrder = { target: speaker, what, spamAt: now };
        if (walks) BotManager.botFor(mod)!.setSubTask(new ModDutyTask(speaker, what, now));
        else {
            scheduleInTicks(rand(MOD_REACT[0], MOD_REACT[1]), () => {
                const t = duty.target;
                if (!canSpeak(mod) || t.slot === -1 || t.level !== mod.level || Math.max(Math.abs(t.x - mod.x), Math.abs(t.z - mod.z)) > MOD_HEARS) return;
                speakDuty(mod, duty);
            });
        }
        return true;
    }
    return false;
}

/** whom a duty line answers: the spammer, what they said, when */
interface DutyOrder {
    readonly target: Player;
    readonly what: Spam;
    readonly spamAt: number;
}

/** the mod's walk over, its moment, its line, and what the others make of it */
export class ModDutyTask extends BotTask {
    private state: 'walk' | 'wait' | 'done' = 'walk';
    private began = -1;
    private speakAt = -1;
    readonly target: Player;
    readonly what: Spam;
    readonly spamAt: number;

    constructor(target: Player, what: Spam, spamAt: number) {
        super('ModDuty');
        this.target = target;
        this.what = what;
        this.spamAt = spamAt;
    }

    shouldRun(player: Player): boolean {
        return this.state !== 'done' && player.levels[PlayerStat.HITPOINTS] > 0;
    }

    isComplete(_player: Player): boolean {
        return this.state === 'done';
    }

    tick(player: Player): void {
        if (this.interrupted || this.state === 'done') return;
        const now = World.currentTick;
        if (this.began < 0) this.began = now;
        const t = this.target;
        const d = t.slot === -1 || t.level !== player.level ? Infinity : Math.max(Math.abs(t.x - player.x), Math.abs(t.z - player.z));
        if (d > MOD_HEARS + 10) {
            this.state = 'done';
            return;
        }
        if (this.state === 'walk') {
            if (d <= MOD_NEAR || now - this.began >= MOD_WALK_TICKS) {
                player.clearWaypoints();
                this.state = 'wait';
                this.speakAt = now + rand(MOD_REACT[0], MOD_REACT[1]);
                return;
            }
            if (!player.hasWaypoints() || now % 8 === 0) walkTo(player, t.x, t.z);
            return;
        }
        if (now < this.speakAt) return;
        this.state = 'done';
        speakDuty(player, this);
    }

    override interrupt(): void {
        super.interrupt();
        this.state = 'done';
    }

    override reset(): void {
        super.reset();
        if (this.began >= 0) this.state = 'done';
    }
}

/** the duty line (kind 'mod', as written: proper sentences), then the scammer's answer and a bot near's now and then */
function speakDuty(mod: Player, duty: DutyOrder): void {
    const human = duty.target.is_bot !== true;
    const event = duty.what === 'scam' ? (human ? 'mod-spam' : 'mod-scam') : duty.what === 'clean' ? 'mod-clean' : duty.what === 'pass' ? 'mod-pass' : 'mod-spam';
    const pool = arenaLines(event);
    if (pool.length === 0) return;
    const text = pool[Math.floor(Math.random() * pool.length)];
    // (a scam caller's stint answers for itself: port/BotScams hears the 'mod' line below, its caller says its
    // 'mod-answer' and the stint ends, its role with it, within the line's own call: so the role is read before it)
    const piece = eventRoleOf(duty.target);
    const answersItself = piece !== null && (piece.role === 'scam-caller' || piece.run?.kind === 'scam_spree');
    sayArenaText(mod, text, { plain: true, kind: 'mod', to: human ? duty.target : null });
    modLog.push({ t: World.currentTick, mod: mod.username, what: duty.what, who: duty.target.username, human, spamAt: duty.spamAt, text });
    while (modLog.length > 2000) modLog.shift();
    // the scammer's answer ("wasnt me lol"), a bot's only, and one answer, not two
    if (!human && duty.what === 'scam' && !answersItself && Math.random() < SCAMMER_ANSWERS) {
        const answer = arenaLines('mod-scammer');
        sayArenaText(duty.target, answer[Math.floor(Math.random() * answer.length)], { typed: true, delay: 3 });
    }
    // a bot near now and then: "omg a player mod" (a newbie: "how do i get a crown")
    if (Math.random() < NEAR_REACTS) {
        for (const p of BotManager.activeBots()) {
            if (p === mod || p === duty.target || p.level !== mod.level || Math.max(Math.abs(p.x - mod.x), Math.abs(p.z - mod.z)) > 10) continue;
            const newbie = isNewbie(p);
            const lines = arenaLines('mod-near', newbie ? 'newbie' : '');
            if (lines.length) sayArenaText(p, lines[Math.floor(Math.random() * lines.length)], { typed: true, delay: 4 });
            break;
        }
    }
}

// ── hearing ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** the human's last lines (normalised), for its spam: name -> [tick, line, starred words] */
const humanLines = new Map<string, { t: number; line: string; starred: number }[]>();

/** A bot's line (BotSay's listeners): a scam call (its kind, or its words), a password said. */
function onBotLine(player: Player, line: string, kind?: LineKind): void {
    if (player.is_bot !== true || kind === 'mod' || kind === 'rumour' || kind === 'setpiece' || isPlayerMod(player)) return;
    if (kind === 'scam' || SCAM_TEXT.test(line)) noteSpam(player, 'scam');
    else if (PASS_TEXT.test(line)) noteSpam(player, 'pass');
}

/**
 * A human's public line (BotChat's humanLineListeners, before the bots near answer): their spam noted for the mod; their
 * question for a mod ("is there a mod here") answered by the mod when one is in earshot (true: the bots near keep quiet).
 */
export function onHumanLine(human: Player, text: string): boolean {
    if (human.is_bot === true) return false;
    const now = World.currentTick;
    const line = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const starred = (WordEnc.filter(text).match(/\*+/g) ?? []).length;
    const list = humanLines.get(human.username) ?? [];
    list.push({ t: now, line, starred });
    while (list.length && now - list[0].t > 100) list.shift();
    humanLines.set(human.username, list);
    let what: Spam | null = null;
    if (SCAM_TEXT.test(text)) what = 'scam';
    else if (PASS_TEXT.test(text)) what = 'pass';
    else if (list.filter(l => l.line === line && now - l.t <= SAME_TICKS).length >= SAME_LINES || list.filter(l => now - l.t <= FLOOD_TICKS).length >= FLOOD_LINES) what = 'spam';
    else if (list.reduce((n, l) => n + l.starred, 0) >= STARRED_WORDS && starred > 0) what = 'clean';
    if (what) {
        noteSpam(human, what);
        return false;
    }
    // "is there a mod here" said to nobody, a mod in earshot: it answers (a line naming a bot is that bot's to answer)
    if (!MOD_ASKED.test(line)) return false;
    for (const mod of modsOnline()) {
        if (mod.level !== human.level || Math.max(Math.abs(mod.x - human.x), Math.abs(mod.z - human.z)) > 14 || isAddressingBot(text, mod)) continue;
        if (!canSpeak(mod)) continue;
        for (const p of BotManager.activeBots()) if (p !== mod && isAddressingBot(text, p)) return false;
        const how = /\bhow\b/.test(line);
        const pool = how ? ANSWER_LINES.modHow : ANSWER_LINES.modYes;
        sayArenaText(mod, pool[Math.floor(Math.random() * pool.length)], { plain: true, kind: 'reply', to: human, typed: true });
        return true;
    }
    return false;
}

let listening = false;
/** (once, lazily: listeners pushed at load could meet BotChat or BotSay mid-evaluation in an import cycle) */
function ensureListeners(): void {
    if (listening) return;
    listening = true;
    sayListeners.push(onBotLine);
    humanLineListeners.push(onHumanLine);
}

/** (tests) forget the duties and the logs */
export function resetModForTest(): void {
    duties.clear();
    humanToldAt.clear();
    modLog.length = 0;
    spamLog.length = 0;
    humanLines.clear();
    modsAt = -Infinity;
}
