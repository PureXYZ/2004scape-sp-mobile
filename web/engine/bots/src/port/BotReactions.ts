// port: bots react to a human near them, unprompted (the realism work, phase 2; "who talks: all four":
// "bots react to the human unprompted: gz on their level-ups, waving back, 'u following me?', comments on gear"). Each
// human is watched through a small cache, with no engine patch:
//   - its base levels (as BotPlayer._checkLevelUps watches a bot's): a level up shows its fireworks (274's levelup.rs2
//     spotanim), and 0-2 bots within 15 tiles say gz, by sociability (more at a milestone);
//   - its emote (the animation it plays this tick): a wave gets one bot's wave back now and then, sometimes a "hi";
//   - what it follows (its interaction: the Follow option): a bot followed for 20 s says "u following me?";
//   - who stands next to it (every 10 ticks): a bot it stood beside for 30 s says "hi" or "sup?" now and then;
//   - what it wears (every 50 ticks): rarely a bot within 6 tiles comments on a partyhat, a santa, full rune, dragon;
//   - (the realism work, phase 5b, Track D) word of mouth: a set piece elsewhere (port/BotDirector, half its events), one
//     bot near the human says its rumour once ("drop party at fally park!!"): talk only, nobody is sent anywhere.
//   - (the variety work, round 2, Track S2: P7, react-human) what the human does: a dance or another emote, going into the
//     Wilderness, a kill (a player, or a monster of level 25+), its death (port/BotWitness watches every player's
//     Hitpoints): one bot near now and then reacts to it ("nice dance lol", "careful in the wildy", "nice kill", "lol u
//     died"), through port/BotWitness.reactToHuman: never more than one a minute for a human, each kind at its own gap.
// Every reaction is rate-limited per human and per bot, comes from a bot free to talk (BotChat.botsFreeNear: not away,
// not fighting or trading, not talking with someone), is typed (BotChat.sayTyped) and said through composeReply (a
// language model may word it later), and opens the reply window (port/BotSpoke) so the human's answer reaches the bot.
// Ticked by BotChat.tickTalk every tick a human is in the world; per human per tick it is a few comparisons, and the
// scans over the bots run every 10 or 50 ticks.
import ObjType from '#/cache/config/ObjType.js';
import SeqType from '#/cache/config/SeqType.js';
import InvType from '#/cache/config/InvType.js';
import { isClientConnected } from '#/engine/entity/NetworkPlayer.js';
import Player from '#/engine/entity/Player.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import World from '#/engine/World.js';
import { PlayerInfoProt } from '#/network/rsbuf/index.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { BotChat, botPersona, botsFreeNear, chatDice, composeReply, sayTyped, type IntentResult } from '#/engine/bot/port/BotChat.js';
import { botEmote } from '#/engine/bot/port/BotEmote.js';
import { isAway } from '#/engine/bot/port/BotHabits.js';
import { scheduleInTicks } from '#/engine/bot/port/BotSchedule.js';
import { noteSpoke, type SpokeKind } from '#/engine/bot/port/BotSpoke.js';
import { reactionTicks } from '#/engine/bot/port/BotTiming.js';
// (the realism work, phase 5b, Track D: a rumour near the human)
import { isFresh, noteSaid } from '#/engine/bot/port/BotLines.js';
import { styleLine } from '#/engine/bot/port/BotStyle.js';
// (the variety work, round 2, Track S2: the human's doings, react-human)
import Npc from '#/engine/entity/Npc.js';
import NpcType from '#/cache/config/NpcType.js';
import { NpcStat } from '#/engine/entity/NpcStat.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { reactToHuman } from '#/engine/bot/port/BotWitness.js';

/** gz to a human's level-up ({name}: theirs, said in about one in five by the persona's echo) */
const GZ = ['gz', 'gz m8', 'gratz', 'grats', 'gz!', 'gj', 'nice', 'congrats', 'gz {name}', 'gratz {name}'];
/** a hello to a human who waved */
const WAVE_HELLO = ['hey', 'hi', 'hiya', 'yo', 'hi {name}'];
/** to a human who follows it */
const FOLLOWED = ['u following me?', 'why u following me', 'stop following me lol', 'lol why', '?', 'can i help u?', 'u lost?', 'u following me lol'];
/** to a human standing next to it a while */
const NEXT_TO = ['hi', 'sup?', 'hey', 'yo', 'u need something?', 'hey {name}', 'sup', 'hi there', 'can i help u?'];

/** Every line a reaction says ({name}: the human's; the gear comments as gearLines makes them), for test/chat-filter.test.mjs. */
export const REACTION_LINES = { gz: GZ, waveHello: WAVE_HELLO, followed: FOLLOWED, nextTo: NEXT_TO } as const;

/** the gaps (ticks): per human, between two of a kind; per bot, between two of its reactions; per bot, between two gear comments */
const GZ_GAP = 100;
const WAVE_GAP = 30;
const FOLLOWED_TICKS = 34;
const NEXT_TO_TICKS = 50;
const NEXT_TO_GAP = 300;
const GEAR_GAP = 1500;
const BOT_GAP = 600;
const BOT_GEAR_GAP = 6000;
/** a gear comment's chance at each look (every 50 ticks), once a bot is near and the gaps are over */
const GEAR_CHANCE = 0.08;

interface Watch {
    levels: Int32Array | null;
    lastGz: number;
    lastWave: number;
    following: Player | null;
    followSince: number;
    followSaid: boolean;
    /** where it stands and since when; the bots next to it and since when */
    hx: number;
    hz: number;
    still: number;
    nextTo: Map<Player, number>;
    lastNextTo: number;
    lastGear: number;
    /** (variety round 2, S2) in the Wilderness at the last tick; what it fights (a kill: its Hitpoints at 0) */
    wild: boolean;
    fighting: Npc | Player | null;
}

const watches = new WeakMap<Player, Watch>();
/** each bot's last reaction, and its last gear comment */
const botSaid = new WeakMap<Player, number>();
const gearSaid = new WeakMap<Player, number>();

let waveSeq = -2;

/** the humans in the world (found every HUMANS_EVERY ticks: a scan over the players, not one a tick) */
let humans: Player[] = [];
const HUMANS_EVERY = 10;

/** BotChat.tickTalk: every tick a human is in the world */
export function tickReactions(): void {
    const now = World.currentTick;
    if (now % HUMANS_EVERY === 0 || humans.some(h => h.slot === -1)) {
        humans = [];
        for (const p of World.playerLoop.all()) if (!p.is_bot && p.slot !== -1 && isClientConnected(p)) humans.push(p);
    }
    for (const human of humans) {
        if (human.slot === -1) continue;
        let w = watches.get(human);
        if (!w) {
            w = { levels: null, lastGz: -Infinity, lastWave: -Infinity, following: null, followSince: 0, followSaid: false, hx: human.x, hz: human.z, still: now, nextTo: new Map(), lastNextTo: -Infinity, lastGear: -Infinity, wild: wildernessLevelAt(human.x, human.z) > 0, fighting: null };
            watches.set(human, w);
        }
        levelUps(human, w, now);
        waves(human, w, now);
        // (variety round 2, S2: its emotes, the Wilderness, its kills)
        emotes(human);
        wilderness(human, w);
        kills(human, w);
        follows(human, w, now);
        if (now % 10 === 0) standers(human, w, now);
        if (now % 50 === 25) gear(human, w, now);
    }
}

/** a bot that may react now: free to talk and not reacted lately */
function ready(bot: Player, now: number): boolean {
    return now - (botSaid.get(bot) ?? -Infinity) >= BOT_GAP;
}

/** the bot says the reaction (typed, after it notices), and the human's answer may reach it (the reply window) */
function react(bot: Player, human: Player, intent: IntentResult, spoke: SpokeKind | null, now: number): void {
    const text = composeReply({ bot, to: human, heard: '', channel: 'public', via: 'reaction', greeted: false, intent });
    if (!text) return;
    botSaid.set(bot, now);
    // (variety round 2: the registry knows it, for the next bot's pickFresh)
    noteSaid(bot, intent.text, now);
    sayTyped(bot, text, { to: human, kind: 'reaction', then: spoke ? () => noteSpoke(bot, spoke, World.currentTick, human) : undefined }, reactionTicks(botPersona(bot), 'notice'));
}

function pick<T>(list: readonly T[]): T {
    return list[Math.floor(Math.random() * list.length)];
}

/**
 * (variety round 2, S2: W4) a line of `pool` the human did not hear lately (the repetition registry: "u need something?"
 * from three bots within the hour at 500 online), else any; the registry notes it when it is said
 */
function pickFresh(bot: Player, pool: readonly string[]): string {
    const now = World.currentTick;
    const start = Math.floor(Math.random() * pool.length);
    for (let i = 0; i < pool.length; i++) {
        const line = pool[(start + i) % pool.length];
        if (isFresh(bot.username, line, bot.x, bot.z, bot.level, now)) return line;
    }
    return pool[start];
}

/** its base levels rose by 1-3 (a level-up; a jump of more is a direct write): 0-2 bots within 15 tiles say gz */
function levelUps(human: Player, w: Watch, now: number): void {
    const levels = human.baseLevels;
    if (!w.levels || w.levels.length !== levels.length) {
        w.levels = Int32Array.from(levels);
        return;
    }
    let level = -1;
    for (let stat = 0; stat < levels.length; stat++) {
        const was = w.levels[stat];
        const is = levels[stat];
        if (is === was) continue;
        w.levels[stat] = is;
        if (is > was && is - was <= 3) level = Math.max(level, is);
    }
    if (level < 0 || now - w.lastGz < GZ_GAP) return;
    w.lastGz = now;
    const milestone = level % 10 === 0 || level === 99;
    let said = 0;
    for (const bot of botsFreeNear(human, 15)) {
        if (!ready(bot, now)) continue;
        const chance = (0.1 + 0.4 * botPersona(bot).sociability) * (milestone ? 1.5 : 1) - (said > 0 ? 0.15 : 0);
        if (chatDice.roll() >= chance) continue;
        react(bot, human, { id: 'gz', text: pick(GZ) }, null, now);
        if (++said >= 2) break;
    }
}

/** it waves (the emote plays this tick): one bot within 10 tiles waves back now and then, sometimes with a hello */
function waves(human: Player, w: Watch, now: number): void {
    if (human.animId === -1 || (human.masks & PlayerInfoProt.ANIM) === 0) return;
    if (waveSeq === -2) waveSeq = SeqType.getId('emote_wave');
    if (human.animId !== waveSeq || now - w.lastWave < WAVE_GAP) return;
    w.lastWave = now;
    const crowd = botsFreeNear(human, 10).filter(bot => ready(bot, now));
    if (crowd.length === 0) return;
    const bot = crowd[0];
    const persona = botPersona(bot);
    if (chatDice.roll() >= 0.25 + 0.4 * persona.sociability) return;
    botSaid.set(bot, now);
    scheduleInTicks(1 + reactionTicks(persona, 'notice'), () => {
        if (BotManager.botFor(bot) !== null && !isAway(bot)) botEmote(bot, 'wave');
    });
    if (Math.random() < 0.4) react(bot, human, { id: 'greeting', text: pickFresh(bot, WAVE_HELLO) }, 'social', now);
}

// ── (the variety work, round 2, Track S2: P7, react-human) its doings ────────────────────────────────────────────

/** the emotes' animations (274's seq names), found once: a dance, and the rest a reaction may follow */
let emoteSeqs: { dance: number; other: Set<number> } | null = null;
function seqs(): { dance: number; other: Set<number> } {
    if (!emoteSeqs) {
        // (each name written out: test/content-names.test.mjs checks them against 274's packs)
        const ids = [SeqType.getId('emote_cheer'), SeqType.getId('emote_laugh'), SeqType.getId('emote_clap'), SeqType.getId('emote_bow'), SeqType.getId('emote_cry'), SeqType.getId('emote_angry'), SeqType.getId('emote_think'), SeqType.getId('emote_beckon')];
        emoteSeqs = { dance: SeqType.getId('emote_dance'), other: new Set(ids.filter(id => id !== -1)) };
    }
    return emoteSeqs;
}

/** it dances, or cheers, laughs, claps ... (the animation starts this tick): a bot near now and then reacts */
function emotes(human: Player): void {
    if (human.animId === -1 || (human.masks & PlayerInfoProt.ANIM) === 0) return;
    const { dance, other } = seqs();
    if (human.animId === dance) reactToHuman(human, 'react-dance', human.x, human.z, human.level);
    else if (other.has(human.animId)) reactToHuman(human, 'react-emote', human.x, human.z, human.level);
}

/** it steps over the ditch into the Wilderness: a bot near the edge now and then says "careful in the wildy" */
function wilderness(human: Player, w: Watch): void {
    const wild = wildernessLevelAt(human.x, human.z) > 0;
    if (wild && !w.wild && human.level === 0) reactToHuman(human, 'react-wild', human.x, human.z, human.level, 15);
    w.wild = wild;
}

/** what it fights falls (its Hitpoints at 0): a player, or a monster of level 25 or more: "nice kill" now and then */
function kills(human: Player, w: Watch): void {
    const t = human.target;
    if (t instanceof Npc || (t instanceof Player && t !== human)) w.fighting = t;
    const f = w.fighting;
    if (!f) return;
    const dead = f instanceof Npc ? f.levels[NpcStat.HITPOINTS] === 0 : f.levels[PlayerStat.HITPOINTS] === 0;
    if (!dead) {
        // (it stopped fighting it: forgotten once it is out of reach)
        if (human.target !== f && Math.max(Math.abs(f.x - human.x), Math.abs(f.z - human.z)) > 15) w.fighting = null;
        return;
    }
    w.fighting = null;
    const notable = f instanceof Player || (NpcType.get(f.type)?.vislevel ?? 0) >= 25;
    // (the variety work, round 2, the fixes: B6: its kill only when it hit it, 274's hero points (the death script's
    // loot owner): a player it only followed or traded with, or a monster it talked to, that died of somebody else's
    // hits got "nice kill" too)
    if (notable && hitBy(f, human)) reactToHuman(human, 'react-kill', human.x, human.z, human.level);
}

/** (B6) `p` damaged `victim` lately (274's hero points, a player's and a monster's alike) */
function hitBy(victim: Npc | Player, p: Player): boolean {
    for (const hero of victim.heroPoints) if (hero && hero.hash64 === p.hash64 && hero.points > 0) return true;
    return false;
}

/** it follows a bot (the Follow option) for 20 s: that bot asks why, now and then */
function follows(human: Player, w: Watch, now: number): void {
    const t = human.target;
    const following = t instanceof Player && t.is_bot && (human.targetOp === ServerTriggerType.APPLAYER3 || human.targetOp === ServerTriggerType.OPPLAYER3);
    if (!following) {
        w.following = null;
        return;
    }
    if (w.following !== t) {
        w.following = t;
        w.followSince = now;
        w.followSaid = false;
        return;
    }
    if (w.followSaid || now - w.followSince < FOLLOWED_TICKS) return;
    w.followSaid = true;
    if (BotManager.botFor(t) === null || isAway(t) || BotChat.inConversation(t) || !ready(t, now) || chatDice.roll() >= 0.7) return;
    react(t, human, { id: 'followed', text: pick(FOLLOWED) }, 'question', now);
}

/** it stands still next to a bot (2 tiles) for 30 s: that bot says hi now and then (once a stand, a few minutes apart) */
function standers(human: Player, w: Watch, now: number): void {
    if (human.x !== w.hx || human.z !== w.hz) {
        w.hx = human.x;
        w.hz = human.z;
        w.still = now;
        w.nextTo.clear();
        return;
    }
    if (now - w.lastNextTo < NEXT_TO_GAP) return;
    for (const bot of BotManager.activeBots()) {
        if (bot.level !== human.level || Math.max(Math.abs(bot.x - human.x), Math.abs(bot.z - human.z)) > 2) {
            if (w.nextTo.has(bot)) w.nextTo.delete(bot);
            continue;
        }
        const since = w.nextTo.get(bot);
        if (since === undefined) {
            w.nextTo.set(bot, now);
            continue;
        }
        if (now - since < NEXT_TO_TICKS || now - w.still < NEXT_TO_TICKS) continue;
        // (once a stand: the bot does not say it again until the human moves)
        w.nextTo.set(bot, Infinity);
        if (!ready(bot, now) || BotChat.inConversation(bot) || !botsFreeNear(human, 2).includes(bot)) continue;
        if (chatDice.roll() >= 0.2 + 0.35 * botPersona(bot).sociability) continue;
        w.lastNextTo = now;
        react(bot, human, { id: 'greeting', text: pickFresh(bot, NEXT_TO) }, 'social', now);
        return;
    }
}

/** rarely, a bot near it comments on what it wears */
function gear(human: Player, w: Watch, now: number): void {
    if (now - w.lastGear < GEAR_GAP) return;
    const lines = gearLines(human);
    if (lines.length === 0) return;
    const bot = botsFreeNear(human, 6).find(b => ready(b, now) && now - (gearSaid.get(b) ?? -Infinity) >= BOT_GEAR_GAP);
    if (!bot || chatDice.roll() >= GEAR_CHANCE) return;
    w.lastGear = now;
    gearSaid.set(bot, now);
    react(bot, human, { id: 'gear', text: pickFresh(bot, lines) }, 'social', now);
}

/** what a human wears that a bot comments on (2004's: a partyhat, a santa, a mask, dragon, full rune), and what it says */
const GEAR: [(has: (rx: RegExp) => boolean) => boolean, string[]][] = [
    [has => has(/partyhat/), ['nice phat', 'omg a phat', 'nice phat lol', 'wow a phat']],
    [has => has(/santa hat/), ['nice santa', 'nice hat', 'omg a santa']],
    [has => has(/halloween mask/), ['nice mask', 'nice hween mask']],
    [has => has(/^dragon (med helm|longsword|sq shield|dagger|battleaxe|mace)/), ['nice dragon', 'omg dragon', 'nice d gear']],
    [has => has(/^rune full helm$/) && has(/^rune platebody$/) && has(/^rune platelegs$/), ['omg full rune', 'nice full rune', 'nice rune']],
    [has => has(/^rune platebody$/), ['nice rune plate', 'nice plate']]
];

/** Every gear comment (for test/chat-filter.test.mjs). */
export const GEAR_LINES: readonly string[] = GEAR.flatMap(([, lines]) => lines);

/** what a bot would say about what the human wears, or nothing */
export function gearLines(human: Player): string[] {
    const worn = human.getInventory(InvType.WORN);
    const names: string[] = [];
    for (let slot = 0; slot < (worn?.capacity ?? 0); slot++) {
        const item = worn?.get(slot);
        if (item) names.push((ObjType.get(item.id)?.name ?? '').toLowerCase());
    }
    const has = (rx: RegExp): boolean => names.some(n => rx.test(n));
    return GEAR.find(([wears]) => wears(has))?.[1] ?? [];
}

/** (phase 5b) a rumour near the human only when it is farther than this from the set piece (it has not seen it) */
const RUMOUR_AWAY = 40;

/**
 * (the realism work, phase 5b, Track D: word of mouth; port/BotDirector) a set piece's rumour said once near a human: a
 * bot free to talk within 15 tiles of it (not `excluded`, not reacted lately), when the human is more than RUMOUR_AWAY
 * tiles from the piece at (x, z) on its floor; typed, in the bot's style, LineKind 'rumour' (out of H7). The speaker, or
 * null (none near, the human at the piece).
 */
export function rumourNearHuman(text: string, excluded: (bot: Player) => boolean, x: number, z: number, level: number): Player | null {
    const now = World.currentTick;
    for (const human of humans) {
        if (human.slot === -1) continue;
        if (human.level === level && Math.max(Math.abs(human.x - x), Math.abs(human.z - z)) <= RUMOUR_AWAY) continue;
        const bot = botsFreeNear(human, 15).find(b => !excluded(b) && ready(b, now));
        if (!bot) continue;
        botSaid.set(bot, now);
        noteSaid(bot, text, now);
        const persona = botPersona(bot);
        sayTyped(bot, styleLine(text, persona).line, { to: null, kind: 'rumour' }, reactionTicks(persona, 'notice'));
        return bot;
    }
    return null;
}
