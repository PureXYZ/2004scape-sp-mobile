// port (the variety work, round 2, Track S2: P7, witnesses and reactions; WEAR-11, gear talk; plan
// the research): bots see what happens around them and now and then say
// so. The investigation found the victim of a death the only one to speak of it, no word on a partyhat worn at a bank, a
// drop announced into silence, a level-90 walking through a crowd unremarked, and no reaction at all to what a human did
// (died, danced, went into the Wilderness, killed something).
//
//   - a death near (a player's Hitpoints fall to 0, where it fell; not a duel's loss): one bot within 10 tiles, now and
//     then (its curiosity; a fight beside it is no bar, its killer never), says "rip", "lol he forgot to eat"; at the
//     Wilderness's edge or in it "lol he got pked", "pkers at the ditch"; the human's own death the same way, to it ("lol
//     u died");
//   - a drop announced near ("omg rune med"): one bot near says "lucky", "nice drop" or asks "what did u get" (the
//     bragger then names it);
//   - a rare worn near (the lines' seen-phat and seen-santa conditions, and any rare by name: bunny ears, a scythe): "omg
//     a phat", "how much for ur phat"; status gear ("nice zammy plate", "nice (t)", "omg dragon", "nice full rune"), at a
//     bank or a hub mostly, at the bots' low rate; what counts is port/BotFashion's notableGearOf (Track W2's: rares, status
//     gear, dragon, members show pieces, novelties), else a local list (trims, god armour, dragon, full rune, rares);
//   - a level 70+ or a level 3 passing: "omg lvl 92", "aww a newbie" (each pair once a session);
//   - a bot that put on something new and notable (a full set, a cape, a better weapon) shows it off now and then: "finally
//     full addy", "got a new cape lol";
//   - (S2-6) a statement, a complaint, a mishap, a meme or a laugh said near: one bot near now and then responds with a
//     line that fits its class ("true", "tell me about it", "unlucky", "lol wat": port/BotLines' responses);
//   - the human's own doings (port/BotReactions watches it): its death, a dance or another emote, going into the
//     Wilderness, a kill: one bot near reacts now and then, never more than once a minute.
// Every line through the 2004 library (data/lines2004-variety.json's witness, reaction and gear groups: port/BotLines,
// the repetition registry, the persona's style), from a bot free to talk (port/BotChatter.calm) and under its voice's
// share (port/BotVoice), typed (BotChat.sayTyped); a bot's own word counts against its talk budget (H7: the place of its
// next line, BotChatter.countAsOwnLine). Rate limits per bot, per area and per human. Every roll is Math.random
// (seeded in the sims); nothing reads the wall clock. Per tick: a counter; every SCAN_EVERY ticks a pass over the bots
// online (who wears what, who passes whom).
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { BotChat, botPersona, sayTyped } from '#/engine/bot/port/BotChat.js';
import { isFleeing } from '#/engine/bot/port/BotDefence.js';
import { isAway } from '#/engine/bot/port/BotHabits.js';
import { calm, countAsOwnLine, noteResponse } from '#/engine/bot/port/BotChatter.js';
import { ALL_LINES, contextOf, nearBank, NEW_LINES, noteSaid, pickLine, type Line, type LineContext } from '#/engine/bot/port/BotLines.js';
import { lastChatAt, type LineKind } from '#/engine/bot/port/BotSay.js';
import { noteSpoke, type HeardClass } from '#/engine/bot/port/BotSpoke.js';
import { styleLine } from '#/engine/bot/port/BotStyle.js';
import { reactionTicks } from '#/engine/bot/port/BotTiming.js';
import { noteVoiceHeld, voiceFree, voiceRoom } from '#/engine/bot/port/BotVoice.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { itemSay, type SlotValues } from '#/engine/bot/port/BotSlots.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { botEmote, EMOTES, type Emote } from '#/engine/bot/port/BotEmote.js';
// (the variety work, round 2, the integrator's: Track W2's notable gear, port/BotFashion)
import { notableGearOf as fashionNotableGear, statusPieceOf } from '#/engine/bot/port/BotFashion.js';
import { inThread } from '#/engine/bot/port/BotThreads.js';
import { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';

// ── the log (the humanlike runner: W10, W14, W15) ────────────────────────────

/** every reaction said: when, by whom, of which kind ('witness-death' ... 'react-dance'), about whom */
export const witnessLog: { t: number; name: string; event: string; about: string | null }[] = [];
const LOG_MAX = 20000;

function log(bot: Player, event: string, about: Player | null): void {
    if (witnessLog.length < LOG_MAX) witnessLog.push({ t: World.currentTick, name: bot.username, event, about: about?.username ?? null });
}

// ── the rates ────────────────────────────────────────────────────────────────

/** a bot says a word of these at most this often (15 minutes); a human's doings get one at most a minute */
const BOT_GAP = 1500;
/** a death beside it: a bot says a word of it unless it said one of these in the last 3 minutes */
const DEATH_GAP = 300;
const HUMAN_GAP = 100;
/** an area (274's map square) hears one witness of a death at most this often */
const AREA_GAP = 200;
/** a death: who saw it (within this), and the chance one of them says so (its curiosity on top) */
const DEATH_DISTANCE = 10;
const DEATH_CHANCE: [number, number] = [0.55, 0.3];
/** a drop announced: who heard it (within this), and the chance one answers; an ask ("what did u get") of those */
const DROP_DISTANCE = 10;
const DROP_CHANCE = 0.35;
const DROP_ASK = 0.35;
/** the scan for gear and levels, every this many ticks; who sees a wearer or a passer (within this) */
const SCAN_EVERY = 50;
const SEE_DISTANCE = 8;
/** a rare's chance of a comment at a scan; status gear's (a wearer once an hour at most); a 70+ or a level 3 passing */
const RARE_CHANCE = 0.03;
const GEAR_CHANCE = 0.008;
const WEARER_GAP = 6000;
/** a map square's next word on gear (6 minutes) */
const GEAR_AREA_GAP = 600;
const LEVEL_CHANCE = 0.025;
const LEVEL_HIGH = 70;
const LEVEL_LOW = 3;
/** a bot that put on something notable shows it off at this chance, with company */
const SHOW_CHANCE = 0.3;
/** the human's doings: the chance one bot near reacts (its kind's) */
const HUMAN_CHANCE: Readonly<Record<string, number>> = { 'react-death': 0.6, 'react-dance': 0.35, 'react-emote': 0.15, 'react-wild': 0.3, 'react-kill': 0.2 };
/** a kind of the human's doings gets a word at most this often */
const HUMAN_KIND_GAP: Readonly<Record<string, number>> = { 'react-death': 0, 'react-dance': 600, 'react-emote': 900, 'react-wild': 1500, 'react-kill': 600 };

const botSaid = new WeakMap<Player, number>();
const areaSaid = new Map<string, number>();
const humanSaid = new WeakMap<Player, { at: number; kinds: Map<string, number> }>();
/** a wearer's last comment; who commented on whom, who remarked whose level (each pair once a login) */
const wearerSaid = new WeakMap<Player, number>();
const remarked = new WeakMap<Player, WeakSet<Player>>();

function ready(bot: Player, now: number, gap = BOT_GAP): boolean {
    return now - (botSaid.get(bot) ?? -Infinity) >= gap;
}

/**
 * a bot that may say a word now: playing, not said one lately, and calm (port/BotChatter: not fighting, trading, in a
 * window, away or talking with a human); `fighting`: a death beside it, a fight or a window is no bar (players typed
 * "rip" between hits) and a word 3 minutes ago is none. (The fixes, B4: its voice's share is checked on the one drawn,
 * after the dice: voiced. Checked here first, every bot of a crowd walked port/BotVoice's ledger at every event.)
 */
function canSay(bot: Player, now: number, fighting = false): boolean {
    if (bot.is_bot !== true || BotManager.botFor(bot) === null || !ready(bot, now, fighting ? DEATH_GAP : BOT_GAP)) return false;
    if (!fighting) return calm(bot, now);
    // (a death beside it: a fight, a bank's or a trade's window is no bar, 274's chatbox stays open)
    return !isFleeing(bot) && !isAway(bot) && !BotChat.inConversation(bot) && !BotChat.midTalk(bot) && !inThread(bot);
}

// ── the lines ────────────────────────────────────────────────────────────────

const pools = new Map<string, readonly Line[]>();
/** the 2004 lines of a reaction's event (data/lines2004-variety.json) */
function poolOf(event: string): readonly Line[] {
    let pool = pools.get(event);
    if (!pool) {
        pool = NEW_LINES.filter(l => l.tag.event === event);
        pools.set(event, pool);
    }
    return pool;
}

/** the events of this module's lines (tests, the chat filter's checks) */
export const WITNESS_EVENTS = ['witness-death', 'witness-pk', 'witness-fight', 'witness-rare', 'witness-gear', 'witness-level', 'drops-reply', 'drops-ask', 'drops-answer', 'show-off', 'react-death', 'react-dance', 'react-emote', 'react-wild', 'react-kill'] as const;

interface SayOpts {
    /** whom it is about (a {name} line names only it; the log) */
    about: Player | null;
    /** the event's kind ('high', 'set' ...): the group's `kinds` */
    kind?: string;
    /** slots of its own ({n}: the passer's combat; {item}: the gear) */
    slots?: SlotValues;
    /** whom it is said to (the human, the bragger), else the one a {name} line names */
    to?: Player | null;
    lineKind: LineKind;
    /** after it is said */
    then?: () => void;
}

/**
 * `bot` says a line of `event`'s group now (typed: after it notices), true when one fits; noted (the registry, the
 * reply window), logged, and (a line of its own accord) in the place of its next line: the talk budget
 */
function say(bot: Player, event: string, opts: SayOpts): boolean {
    const now = World.currentTick;
    const ctx: LineContext = contextOf(bot, new Map([[event, { tick: now, kind: opts.kind }]]));
    if (opts.about) ctx.near = ctx.near.filter(n => n.player === opts.about);
    if (opts.slots) ctx.slots = { ...(ctx.slots ?? {}), ...opts.slots };
    const picked = pickLine(ctx, { event }, Math.random, poolOf(event));
    if (!picked) return false;
    const persona = botPersona(bot);
    noteSaid(bot, picked.text, now, picked.template);
    botSaid.set(bot, now);
    log(bot, event, opts.about);
    const to = opts.to !== undefined ? opts.to : (picked.to?.player ?? null);
    const emote = picked.line.tag.emote;
    sayTyped(bot, styleLine(picked.text, persona).line, {
        to,
        kind: opts.lineKind,
        then: () => {
            noteSpoke(bot, 'event', World.currentTick, to);
            if (emote && (EMOTES as readonly string[]).includes(emote)) botEmote(bot, emote as Emote, true);
            opts.then?.();
        }
    }, reactionTicks(persona, 'notice'));
    if (opts.lineKind !== 'reaction') countAsOwnLine(bot);
    return true;
}

/**
 * (the fixes, B4) `first` (drawn from `crowd` by pickCurious) if it is under its voice's share of a busy place
 * (port/BotVoice), else another drawn, a few at most; null (a line the cap held) when none is
 */
function voiced(crowd: readonly Player[], first: Player | null, now: number): Player | null {
    if (!first) return null;
    const left = crowd.filter(p => p !== first);
    let bot: Player | null = first;
    for (let tries = 0; bot && tries < 3; tries++) {
        if (voiceRoom(bot, now)) return bot;
        bot = pickCurious(left);
        if (bot) left.splice(left.indexOf(bot), 1);
    }
    noteVoiceHeld();
    return null;
}

/** one of `crowd` by its curiosity and sociability, one chatting lately (at its keyboard) more, or null */
function pickCurious(crowd: Player[]): Player | null {
    if (!crowd.length) return null;
    const now = World.currentTick;
    const w = (p: Player): number => (0.1 + botPersona(p).curiosity + 0.5 * botPersona(p).sociability) * (now - lastChatAt(p) <= 500 ? 3 : 1);
    let x = Math.random() * crowd.reduce((s, p) => s + w(p), 0);
    for (const p of crowd) if ((x -= w(p)) <= 0) return p;
    return crowd[crowd.length - 1];
}

/** the bots within `distance` of (x, z, level) that may say a word now (not `except`; `fighting`: a fight no bar) */
function witnesses(x: number, z: number, level: number, distance: number, now: number, except: (p: Player) => boolean, fighting = false): Player[] {
    const out: Player[] = [];
    for (const p of BotManager.activeBots()) {
        if (p.level !== level || Math.max(Math.abs(p.x - x), Math.abs(p.z - z)) > distance || except(p)) continue;
        if (canSay(p, now, fighting)) out.push(p);
    }
    return out;
}

function areaFree(x: number, z: number, level: number, key: string, now: number, gap = AREA_GAP): boolean {
    const area = `${key}|${x >> 6}_${z >> 6}_${level}`;
    if (now - (areaSaid.get(area) ?? -Infinity) < gap) return false;
    areaSaid.set(area, now);
    if (areaSaid.size > 4096) areaSaid.clear();
    return true;
}

/** at the Wilderness's edge (Edgeville's ditch, the PKers' ground) or in it */
function pkGround(x: number, z: number): boolean {
    return wildernessLevelAt(x, z) > 0 || (x >= 3060 && x <= 3140 && z >= 3505 && z <= 3530);
}

// ── a death near ─────────────────────────────────────────────────────────────

/** each player's Hitpoints at the last tick (a fall to 0 is a death, seen where it fell) */
const hpSeen = new WeakMap<Player, number>();

/** the Duel Arena's grounds: a duel's loss is no death (274's duel heals both; the arena's crowd has its own lines) */
function atDuelArena(x: number, z: number): boolean {
    return x >= 3325 && x <= 3395 && z >= 3195 && z <= 3285;
}

/** every tick: a player whose Hitpoints fell to 0 died where it stands: a bot near may say so (a human's: a reaction to it) */
function deaths(now: number): void {
    for (const p of World.playerLoop.all()) {
        if (p.slot === -1) continue;
        const hp = p.levels[PlayerStat.HITPOINTS];
        const was = hpSeen.get(p);
        hpSeen.set(p, hp);
        if (hp !== 0 || was === undefined || was === 0 || atDuelArena(p.x, p.z) || eventRoleOf(p)?.role === 'duellist') continue;
        witnessStats.deaths++;
        if (p.is_bot) witnessDeath(p, p.x, p.z, p.level);
        else reactToHuman(p, 'react-death', p.x, p.z, p.level);
    }
    void now;
}

/** `p` damaged `victim` lately (274's hero points, which the death script reads for the PK's loot) */
function hitIt(victim: Player, p: Player): boolean {
    for (const hero of victim.heroPoints) if (hero && hero.hash64 === p.hash64 && hero.points > 0) return true;
    return false;
}

/**
 * (a bot died: it fell at (x, z) on `level`) one bot that saw it may say so, a moment later: "rip", "lol he got pked". Not
 * the one that killed it (its own kill line is its own), nor a PKer at the edge.
 */
export function witnessDeath(victim: Player, x: number, z: number, level: number): void {
    const now = World.currentTick;
    const pk = pkGround(x, z);
    const event = pk ? 'witness-pk' : 'witness-death';
    // (not its killer, nor one that hit it (274's hero points: whoever damaged it): their kill lines are their own; a PKer
    // that only stood by may say a word)
    const crowd = witnesses(x, z, level, DEATH_DISTANCE, now, p => p === victim || p.target === victim || hitIt(victim, p), true);
    const picked = pickCurious(crowd);
    if (!picked) return;
    witnessStats.seen++;
    if (Math.random() >= (testRates.death ?? DEATH_CHANCE[0] + DEATH_CHANCE[1] * botPersona(picked).curiosity)) return;
    const bot = voiced(crowd, picked, now);
    if (!bot || !areaFree(x, z, level, 'death', now)) return;
    if (say(bot, event, { about: victim, lineKind: 'event' })) witnessStats.said++;
}

// ── a fight near (play-testing: the ditch "a little too quiet") ─────────────────────────────────────────

/** a PK fight seen (a look every SCAN_EVERY ticks): one bot within FIGHT_DISTANCE now and then cheers it on ("eat!", "dds him", "who's winning?") */
const FIGHT_DISTANCE = 10;
const FIGHT_CHANCE = 0.35;
/** one such word in a map square at most every this many ticks (a minute) */
const FIGHT_AREA_GAP = 100;

/**
 * (every SCAN_EVERY ticks) each fight between two players on the PKers' ground (one attacking the other, both standing):
 * a bot near it, not in it (nor attacking either), may say a word about it, by its curiosity.
 */
function fightsSeen(now: number): void {
    const seen = new Set<Player>();
    for (const p of World.playerLoop.all()) {
        const t = p.target;
        if (p.slot === -1 || !(t instanceof Player) || t.slot === -1 || seen.has(p) || seen.has(t)) continue;
        if ((p.levels[PlayerStat.HITPOINTS] ?? 0) <= 0 || (t.levels[PlayerStat.HITPOINTS] ?? 0) <= 0 || !pkGround(p.x, p.z)) continue;
        seen.add(p);
        seen.add(t);
        const crowd = witnesses(p.x, p.z, p.level, FIGHT_DISTANCE, now, w => w === p || w === t || w.target instanceof Player, true);
        const picked = pickCurious(crowd);
        if (!picked || Math.random() >= (testRates.fight ?? FIGHT_CHANCE * (0.5 + botPersona(picked).curiosity))) continue;
        const bot = voiced(crowd, picked, now);
        if (!bot || !areaFree(p.x, p.z, p.level, 'fight', now, FIGHT_AREA_GAP)) continue;
        if (say(bot, 'witness-fight', { about: null, lineKind: 'event' })) witnessStats.fights++;
    }
}

/** (the humanlike runner, tests) deaths seen (Hitpoints to 0), those with a bot free to say a word near, those it did */
export const witnessStats = { deaths: 0, seen: 0, said: 0, fights: 0 };

// ── a drop announced (port/BotChatter) ───────────────────────────────────────

/**
 * (port/BotChatter: `bragger` said a drop line, `text`, about `item` if it knows it) one bot near may answer: "lucky",
 * "nice drop"; or ask "what did u get" (when the line did not name it), and the bragger names it ("rune med lol")
 */
export function dropBrag(bragger: Player, text: string, item: string | null): void {
    const now = World.currentTick;
    const crowd = witnesses(bragger.x, bragger.z, bragger.level, DROP_DISTANCE, now, p => p === bragger);
    const picked = pickCurious(crowd);
    if (!picked || Math.random() >= (testRates.drop ?? DROP_CHANCE)) return;
    const bot = voiced(crowd, picked, now);
    if (!bot) return;
    const named = item !== null && text.toLowerCase().includes(item.toLowerCase());
    if (item !== null && !named && Math.random() < (testRates.dropAsk ?? DROP_ASK)) {
        say(bot, 'drops-ask', {
            about: bragger,
            to: bragger,
            lineKind: 'event',
            then: () => {
                // (the bragger names it: an answer, not one of its own lines; typed after anything it is typing)
                if (BotManager.botFor(bragger) === null || isAway(bragger)) return;
                const t = World.currentTick;
                const ctx = contextOf(bragger, new Map([['drops-answer', { tick: t }]]));
                ctx.slots = { ...(ctx.slots ?? {}), item };
                ctx.near = ctx.near.filter(n => n.player === bot);
                const picked = pickLine(ctx, { event: 'drops-answer' }, Math.random, poolOf('drops-answer'));
                if (!picked) return;
                noteSaid(bragger, picked.text, t, picked.template);
                log(bragger, 'drops-answer', bot);
                // (the fixes, B3: a line the drop had no room for before, in the place of one of the bragger's own)
                countAsOwnLine(bragger);
                sayTyped(bragger, styleLine(picked.text, botPersona(bragger)).line, { to: bot, kind: 'botreply' }, reactionTicks(botPersona(bragger), 'notice'));
            }
        });
        return;
    }
    say(bot, 'drops-reply', { about: bragger, to: bragger, lineKind: 'event' });
}

// ── (S2-6) a response to a line said near ("true", "ya it sucks", "unlucky") ─────────────────────────────────────

/** a line of these classes said near gets a response now and then (a question its answer, a greeting its hello: port/BotChat) */
const RESPONDED: ReadonlySet<HeardClass> = new Set<HeardClass>(['statement', 'complaint', 'mishap', 'meme', 'laugh']);
const RESPONSE_CHANCE = 0.1;
const RESPONSE_DISTANCE = 10;
/** with more bots than this free near, a response the rarer, by their number */
const RESPONSE_CROWD = 4;
let responsePool: readonly Line[] | null = null;

/**
 * (port/BotChatter: `speaker` said a line of class `cls`, other bots near) one bot near may respond to it now and then
 * ("true", "tell me about it", "unlucky", "lol wat"): a response line (upstream's verbatim, the 2004 ones by class) that
 * fits the class (port/BotLines responseFits), said to nobody in particular, one of its own lines (the talk budget)
 */
export function respondTo(speaker: Player, cls: HeardClass): void {
    if (!RESPONDED.has(cls) || Math.random() >= (testRates.respond ?? RESPONSE_CHANCE)) return;
    const now = World.currentTick;
    const crowd = witnesses(speaker.x, speaker.z, speaker.level, RESPONSE_DISTANCE, now, p => p === speaker);
    // (in a crowd a line is answered no more often than among a few: a bank of 30 at 500 online is no chorus)
    if (testRates.respond === undefined && crowd.length > RESPONSE_CROWD && Math.random() >= RESPONSE_CROWD / crowd.length) return;
    const bot = voiced(crowd, pickCurious(crowd), now);
    if (!bot) return;
    responsePool ??= ALL_LINES.filter(l => l.tag.c === 'response' && (l.tag.heard ?? 'any') === 'any');
    const ctx = contextOf(bot);
    ctx.heard = { any: true, levelup: false, answer: false, cls };
    const picked = pickLine(ctx, 'idle', Math.random, responsePool, true);
    if (!picked) return;
    const persona = botPersona(bot);
    noteSaid(bot, picked.text, now, picked.template);
    botSaid.set(bot, now);
    log(bot, 'response', speaker);
    noteResponse(bot, picked.text, cls, picked.line.tag.after ?? null);
    const text = picked.line.source === '2004' ? styleLine(picked.text, persona).line : picked.text;
    sayTyped(bot, text, { to: null, kind: 'idle', then: () => noteSpoke(bot, 'idle', World.currentTick, null, 'response') }, reactionTicks(persona, 'notice'));
    countAsOwnLine(bot);
}

// ── the human's doings (port/BotReactions) ──────────────────────────────────

/**
 * (port/BotReactions: the human died, danced or did another emote, went into the Wilderness, killed something, at (x, z)
 * on `level`) one bot within `distance` may react, to the human: "lol u died", "nice dance lol", "careful in the wildy".
 * At most one a minute for a human, and each kind at its own gap. True when one was said.
 */
export function reactToHuman(human: Player, event: string, x: number, z: number, level: number, distance = 10): boolean {
    const now = World.currentTick;
    let h = humanSaid.get(human);
    if (!h) humanSaid.set(human, (h = { at: -Infinity, kinds: new Map() }));
    if (now - h.at < HUMAN_GAP || now - (h.kinds.get(event) ?? -Infinity) < (HUMAN_KIND_GAP[event] ?? 600)) return false;
    const crowd = witnesses(x, z, level, distance, now, p => p === human || p.target === human, event === 'react-death' || event === 'react-kill');
    const picked = pickCurious(crowd);
    if (!picked || Math.random() >= (testRates.human ?? HUMAN_CHANCE[event] ?? 0.2)) return false;
    const bot = voiced(crowd, picked, now);
    if (!bot) return false;
    if (!say(bot, event, { about: human, to: human, lineKind: 'reaction' })) return false;
    h.at = now;
    h.kinds.set(event, now);
    return true;
}

// ── the scan: gear, rares, levels, show-off ──────────────────────────────────

/** what a player wears that people noticed in 2004: a rare, trimmed or god armour, dragon, full rune */
export interface NotableGear {
    /** (members and novelty, Track W2's: a Fremennik helm, a glory, a snelm, the mime's outfit: their own witness-gear groups since the round's fixes, B5, and the plain ones with {item}) */
    kind: 'rare' | 'trim' | 'god' | 'dragon' | 'fullrune' | 'members' | 'novelty';
    /** as players named it ("phat", "zammy plate", "rune (t)", "dragon med") */
    item: string;
    /**
     * (the variety work, round 2, the fixes: B5) what of its kind it is, for the lines that suit only that: a glory, a
     * Fremennik helm, a cape, a staff, a clue hat, a snelm (members); the mime's outfit, a holy symbol (novelty); zammy,
     * sara (god). The lines' kind is `${kind}-${sub}` (port/BotLines kindFits: a group of the plain kind fits it too)
     */
    sub?: string;
}

/** (B5) a members or novelty piece's or a god piece's sub-kind, from its 2004 name ("glory", "berserker helm", "zammy plate") */
function subOf(kind: NotableGear['kind'], item: string): string | undefined {
    const n = item.toLowerCase();
    if (kind === 'god') return n.startsWith('zammy') ? 'zammy' : n.startsWith('sara') ? 'sara' : undefined;
    if (kind === 'novelty') return /mime/.test(n) ? 'mime' : /holy/.test(n) ? 'holy' : undefined;
    if (kind !== 'members') return undefined;
    if (/glory/.test(n)) return 'glory';
    if (/snelm/.test(n)) return 'snelm';
    if (/helm/.test(n)) return 'helm';
    if (/cape|cloak/.test(n)) return 'cape';
    if (/staff/.test(n)) return 'staff';
    if (/beret|cavalier|headband|\bhat\b/.test(n)) return 'hat';
    return undefined;
}

/** (B5) the kind a gear line is picked for: the sub-kind's when it has one ('members-glory'), else its own */
export function gearLineKind(gear: NotableGear): string {
    return gear.sub ? `${gear.kind}-${gear.sub}` : gear.kind;
}

const RARES: readonly [RegExp, string][] = [
    [/partyhat/, 'phat'],
    [/santa hat/, 'santa'],
    [/halloween mask/, 'hween mask'],
    [/bunny ears/, 'bunny ears'],
    [/scythe/, 'scythe'],
    [/pumpkin/, 'pumpkin'],
    [/easter egg/, 'easter egg']
];
/** 274's god armour (Treasure Trails' rewards: "Zamorak platebody", "Saradomin plate", "Guthix kiteshield") */
const GODS: readonly [RegExp, string][] = [
    [/^zamorak (platebody|full helm|platelegs|plateskirt|kiteshield)$/, 'zammy'],
    [/^saradomin (plate|full|legs|skirt|kite)$/, 'sara'],
    [/^guthix (platebody|full helm|platelegs|plateskirt|kiteshield)$/, 'guthix']
];
/** a god piece's word as players said it */
const GOD_PIECE: Readonly<Record<string, string>> = { platebody: 'plate', plate: 'plate', 'full helm': 'helm', full: 'helm', platelegs: 'legs', legs: 'legs', plateskirt: 'skirt', skirt: 'skirt', kiteshield: 'kite', kite: 'kite' };

/**
 * (WEAR-11's local list: the fallback of notableGearOf, and a show-off's test) a player's most
 * notable worn piece, or null: a rare first, then trimmed, god armour, dragon, full rune
 */
export function localNotableGear(worn: readonly string[]): NotableGear | null {
    const names = worn.map(n => n.toLowerCase());
    for (const [rx, say] of RARES) if (names.some(n => rx.test(n))) return { kind: 'rare', item: say };
    // (274's trimmed armour: "Rune platebody (t)", "Adam platebody (g)"; the gilded set)
    const trimmed = names.find(n => /\((t|g)\)$/.test(n) || /^gilded /.test(n));
    if (trimmed) {
        if (trimmed.startsWith('gilded ')) return { kind: 'trim', item: 'gilded' };
        const base = itemSay(trimmed.replace(/\s*\((t|g)\)$/, '').replace(/^adam\b/, 'adamant').trim());
        return { kind: 'trim', item: base ? `${base} ${trimmed.endsWith('(g)') ? '(g)' : '(t)'}` : trimmed.endsWith('(g)') ? 'gold trim' : 'trimmed' };
    }
    for (const [rx, god] of GODS) {
        const n = names.find(x => rx.test(x));
        if (n) return { kind: 'god', item: `${god} ${GOD_PIECE[n.match(rx)?.[1] ?? ''] ?? 'armour'}` };
    }
    const dragon = names.find(n => /^dragon (med helm|longsword|sq shield|dagger|battleaxe|mace|scimitar|chainbody|platelegs|plateskirt|2h sword|spear)/.test(n));
    if (dragon) return { kind: 'dragon', item: itemSay(dragon) ?? 'dragon' };
    if (names.includes('rune full helm') && names.includes('rune platebody') && (names.includes('rune platelegs') || names.includes('rune plateskirt'))) return { kind: 'fullrune', item: 'full rune' };
    return null;
}

/** the names of what a player wears */
function wornNames(p: Player): string[] {
    const worn = p.getInventory(InvType.WORN);
    const out: string[] = [];
    for (let slot = 0; slot < (worn?.capacity ?? 0); slot++) {
        const item = worn?.get(slot);
        if (item) out.push((ObjType.get(item.id)?.name ?? '').toLowerCase());
    }
    return out;
}

/**
 * The most notable thing a player wears (the integrator's, round 2): Track W2's list (port/BotFashion.notableGearOf, rares
 * first, its 2004 nicknames) in this module's kinds: a holiday item is a rare's line, a status piece trimmed or god, full
 * rune only as the whole set (the local list's rule: one rune platebody is no remark); the local list when W2's has none
 */
export function notableGearOf(p: Player): NotableGear | null {
    const gear = notableGearKind(p);
    // (the fixes, B5: what of its kind it is, for the lines that suit only that)
    const sub = gear ? subOf(gear.kind, gear.item) : undefined;
    return gear && sub ? { ...gear, sub } : gear;
}

function notableGearKind(p: Player): NotableGear | null {
    for (const g of fashionNotableGear(p)) {
        if (g.kind === 'rare' || g.kind === 'holiday') return { kind: 'rare', item: g.nick };
        if (g.kind === 'status') return { kind: statusPieceOf(g.itemId)?.family === 'god' ? 'god' : 'trim', item: g.nick };
        if (g.kind === 'dragon') return { kind: 'dragon', item: g.nick };
        if (g.kind === 'members' || g.kind === 'novelty') return { kind: g.kind, item: g.nick };
    }
    return localNotableGear(wornNames(p));
}

/** what a bot shows off: a full metal set, a cape, a better weapon, a notable piece; null for anything else */
function showOffOf(before: readonly string[], now: readonly string[]): { kind: string; item: string } | null {
    const added = now.filter(n => !before.includes(n));
    if (!added.length) return null;
    const notable = localNotableGear(now);
    if (notable && !localNotableGear(before)) return { kind: notable.kind === 'fullrune' ? 'set' : 'any', item: notable.item };
    for (const metal of ['adamant', 'mithril', 'rune', 'black', 'steel']) {
        const set = (list: readonly string[]): boolean => list.includes(`${metal} full helm`) && list.includes(`${metal} platebody`) && (list.includes(`${metal} platelegs`) || list.includes(`${metal} plateskirt`));
        if (set(now) && !set(before)) return { kind: 'set', item: `full ${itemSay(metal) ?? metal}` };
    }
    const cape = added.find(n => / cape$/.test(n) && !/team-/.test(n));
    if (cape) return { kind: 'cape', item: 'cape' };
    const weapon = added.find(n => /^(adamant|rune|dragon) (scimitar|longsword|battleaxe|2h sword|warhammer|mace)$/.test(n));
    if (weapon) return { kind: 'weapon', item: itemSay(weapon) ?? weapon };
    return null;
}

/** what each bot wore at the last look, every piece it wore this login, and when it was first looked at */
const wornSeen = new WeakMap<Player, string[]>();
const wornEver = new WeakMap<Player, Set<string>>();
const firstSeen = new WeakMap<Player, number>();
/** a bot's first minutes online are its dressing (its kit, a weapon from the bank): nothing it puts on then is shown off */
const SHOW_SETTLE = 600;
let lastScan = -1;

/**
 * (BotChat.tickTalk: every tick a human is in the world) the deaths of this tick; every SCAN_EVERY ticks a look around:
 * gear, rares, levels, new kit
 */
export function tickWitness(): void {
    const now = World.currentTick;
    deaths(now);
    if (now - lastScan < SCAN_EVERY) return;
    lastScan = now;
    fightsSeen(now);
    const bots = [...BotManager.activeBots()];
    for (const p of bots) {
        if (p.slot === -1) continue;
        // (what it wears now against the last look: something new to it this login and notable is shown off now and then,
        // not its first minutes' dressing, nor a set it took off for a skill and put back on)
        const names = wornNames(p);
        const before = wornSeen.get(p);
        wornSeen.set(p, names);
        if (!firstSeen.has(p)) firstSeen.set(p, now);
        let ever = wornEver.get(p);
        if (!ever) wornEver.set(p, (ever = new Set()));
        const fresh = names.filter(n => !ever!.has(n));
        for (const n of names) ever.add(n);
        if (before && fresh.length && now - firstSeen.get(p)! >= SHOW_SETTLE && names.join('|') !== before.join('|')) {
            const show = showOffOf(before, names);
            // (a bot at its keyboard lately more often: talkers talk, H6)
            const chance = testRates.show ?? SHOW_CHANCE * (now - lastChatAt(p) <= 500 ? 1.5 : 0.5);
            if (show && canSay(p, now) && hasCompany(p) && Math.random() < chance && voiceFree(p, now)) say(p, 'show-off', { about: null, kind: show.kind, slots: { item: show.item }, lineKind: 'event' });
        }
    }
    for (const p of [...bots, ...humansIn()]) {
        if (p.slot === -1) continue;
        gearSeen(p, now);
        levelSeen(p, now);
    }
}

/** the humans in the world (a rare or a high level on the human is noticed too) */
function humansIn(): Player[] {
    const out: Player[] = [];
    for (const p of World.playerLoop.all()) if (!p.is_bot && p.slot !== -1) out.push(p);
    return out;
}

function hasCompany(bot: Player): boolean {
    for (const p of World.playerLoop.all()) if (p !== bot && p.level === bot.level && Math.max(Math.abs(p.x - bot.x), Math.abs(p.z - bot.z)) <= 15) return true;
    return false;
}

/** a rare or status gear worn at a bank or a hub (or anywhere a bot stands by): one bot near now and then remarks on it */
function gearSeen(wearer: Player, now: number): void {
    if (now - (wearerSaid.get(wearer) ?? -Infinity) < WEARER_GAP) return;
    if (!nearBank(wearer.x, wearer.z, wearer.level, 10) && !(wearer.is_bot && !wearer.hasWaypoints())) return;
    const gear = notableGearOf(wearer);
    if (!gear) return;
    if (Math.random() >= (testRates.gear ?? (gear.kind === 'rare' ? RARE_CHANCE : GEAR_CHANCE))) return;
    // (one word on gear in a map square every few minutes: a crowd of veterans at Varrock West is no chorus)
    if (testRates.gear === undefined && !areaFree(wearer.x, wearer.z, wearer.level, 'gear', now, GEAR_AREA_GAP)) return;
    const crowd = witnesses(wearer.x, wearer.z, wearer.level, SEE_DISTANCE, now, p => p === wearer || remarked.get(p)?.has(wearer) === true || wornHas(p, gear));
    const bot = voiced(crowd, pickCurious(crowd), now);
    if (!bot) return;
    if (!say(bot, gear.kind === 'rare' ? 'witness-rare' : 'witness-gear', { about: wearer, to: wearer, kind: gearLineKind(gear), slots: { item: gear.item }, lineKind: wearer.is_bot ? 'event' : 'reaction' })) return;
    wearerSaid.set(wearer, now);
    mark(bot, wearer);
}

/** the bot wears the same notable thing (it says nothing of it) */
function wornHas(p: Player, gear: NotableGear): boolean {
    return notableGearOf(p)?.item === gear.item;
}

function mark(bot: Player, other: Player): void {
    let set = remarked.get(bot);
    if (!set) remarked.set(bot, (set = new WeakSet()));
    set.add(other);
}

/** a level 70+ or a level 3 among bots that are not: one near now and then remarks on it (each pair once a login) */
function levelSeen(passer: Player, now: number): void {
    const cb = passer.combatLevel;
    const high = cb >= LEVEL_HIGH;
    const low = cb <= LEVEL_LOW;
    if ((!high && !low) || now - (wearerSaid.get(passer) ?? -Infinity) < WEARER_GAP / 2) return;
    // (a level 3 at Lumbridge's spawn is everywhere: only one out of it, walking past)
    if (low && (!passer.hasWaypoints() || Math.max(Math.abs(passer.x - 3222), Math.abs(passer.z - 3218)) <= 40)) return;
    if (Math.random() >= (testRates.level ?? LEVEL_CHANCE)) return;
    // (one remark on a level in a map square every few minutes, as on gear)
    if (testRates.level === undefined && !areaFree(passer.x, passer.z, passer.level, 'level', now, GEAR_AREA_GAP)) return;
    // (a high level remarked on by one well below it; a level 3 by a veteran)
    const crowd = witnesses(passer.x, passer.z, passer.level, SEE_DISTANCE, now, p => p === passer || remarked.get(p)?.has(passer) === true || (high ? p.combatLevel > cb - 25 : p.combatLevel < 40 || isNewbie(p)));
    const bot = voiced(crowd, pickCurious(crowd), now);
    if (!bot) return;
    if (!say(bot, 'witness-level', { about: passer, kind: high ? 'high' : 'low', slots: { n: String(cb) }, to: passer.is_bot ? null : passer, lineKind: passer.is_bot ? 'event' : 'reaction' })) return;
    wearerSaid.set(passer, now);
    mark(bot, passer);
}

// ── tests ────────────────────────────────────────────────────────────────────

/** Tests only: each kind's chance (a death's, a drop's and its ask's, the human's doings', a new kit's, gear's, a level's); null: the game's. */
const testRates: { death?: number; drop?: number; dropAsk?: number; human?: number; show?: number; gear?: number; level?: number; respond?: number; fight?: number } = {};
export function setWitnessRatesForTest(rates: typeof testRates | null): void {
    for (const k of Object.keys(testRates) as (keyof typeof testRates)[]) delete testRates[k];
    Object.assign(testRates, rates ?? {});
}

/** Tests only: forget the rates and the log. Never called by the game. */
export function resetWitnessForTest(): void {
    areaSaid.clear();
    witnessLog.length = 0;
    lastScan = -1;
}

/** Tests only: `bot` may react again now (its gap forgotten). Never called by the game. */
export function readyForTest(bot: Player): void {
    botSaid.delete(bot);
}
