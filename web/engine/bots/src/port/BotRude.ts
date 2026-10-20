// port: 2004 rudeness (the realism work, phase 5a, Track F: fights, skills and manners; "2004 rudeness:
// kill-stealing and rock-stealing, rude replies", and kill-stealing from the human in
// multi-combat too, within the caps). Before, bots took an NPC or a rock someone else was going for only by accident and
// in silence (the audit: no deliberate kill-steal anywhere, nobody ever said "ks"), and every reply to the human was
// polite whoever said it.
//
//   - Who: the bots of rude deeds (port/BotPersona rudeActs: the rude talkers and 1 bot in 12 more, about 20 % of
//     levelling bots, most PKers); the polite majority leaves the human's rock alone while another is free and gives up
//     an NPC someone else takes (CombatTask, MiningTask).
//   - Kill-stealing (CombatTask): in a single-way area the race (274's player_combat.rs2: an NPC fought in the last 8
//     ticks says "Someone else is fighting that." to anyone else): a rude fighter attacks the NPC another player is
//     walking to (a bot that clicked it, the human), nearer to it than they are, KS_SINGLE a pick where that NPC is the
//     nearest (twice the spec's 15 %: R1); in a multi-combat area (no such check: the most damage takes the drop,
//     npc_findhero) it joins an NPC another player fights, KS_MULTI a pick, the human's too. At most one steal per bot
//     per KS_BOT_GAP_TICKS (15 min) and one on the human per KS_HUMAN_GAP_TICKS (20 min) world-wide: friction at the
//     2004 crowds, not a war.
//   - Rock-stealing (MiningTask): with no free rock of its ore near for a minute, a rude miner takes one another
//     bot works, or the human's, ROCK_STEAL a roll (ROCK_LAZY even when a free one is farther than 5 tiles); the same
//     caps, one rock steal per bot an hour and one in the world per half hour. Both mine it; the first ore empties it
//     (274's mining.rs2: loc_change), the other gets nothing.
//   - The arguments (port/BotChatter.argue): the victim's line ("ks!", "that was my rock"), the stealer's answer after
//     it (a rude one's often, a polite one's now and then "sry"); two lines, never mid-fight.
//   - Rude replies (port/BotChat.composeReply → rudeReply): a rude talker's reply to the human is rude RUDE_REPLY of the
//     time where the question allows one ("use ur map lol", "get a job lol", "who asked").
// Everything here is O(1) a call (the humans of the tick are read once a tick, when a bot asks); the incident log is the
// humanlike runner's and the tests' (R1-R4).
import type Loc from '#/engine/entity/Loc.js';
import type Npc from '#/engine/entity/Npc.js';
import Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { CoordGrid } from '#/engine/CoordGrid.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import { personaOf, isRude } from '#/engine/bot/port/BotPersona.js';
import type { PlannerKey } from '#/engine/bot/port/BotRoster.js';

// ── the rates and caps (the spec's defaults; tuned to the humanlike runs where said) ─────────────────────────────────

/**
 * a single-way steal: the chance a pick where someone else's NPC (one they walk to) is the nearest becomes a steal. The
 * spec's 15 % (and 10 % in multi-combat) made 3 in 600 fighting bot-hours in the humanlike runs (0.5 per 100, R1's band
 * 1-6): at 100 bots another's NPC is a rude fighter's nearest now and then only
 */
export const KS_SINGLE = 0.3;
/** a multi-combat steal: the chance a pick where an NPC someone else fights is the nearest becomes a steal */
export const KS_MULTI = 0.2;
/** a single-way steal only from a player at least this far from the NPC (they are still on the way), the stealer nearer */
export const KS_FAR = 3;
/**
 * a rude miner takes a claimed rock (or the human's) this often when no free rock of its ore is near: once it has waited
 * ROCK_WAIT_TICKS for one (274's copper, tin and iron come back in seconds: a moment's wait is no reason; a minute at the
 * rocks is: half a minute made 7 steals in 83 mining bot-hours, 8.5 per 100, R2's band 1-8), one roll per ROCK_ROLL_TICKS
 */
export const ROCK_STEAL = 0.35;
export const ROCK_WAIT_TICKS = 100;
export const ROCK_ROLL_TICKS = 600;
/**
 * and this often even when a free one is farther than ROCK_LAZY_TILES (it does not walk; the research's 10 %: rare, as
 * the spec's defaults leave it out)
 */
export const ROCK_LAZY = 0.03;
export const ROCK_LAZY_TILES = 5;
/** at most one steal (an NPC or a rock) per bot this often (15 minutes) */
export const KS_BOT_GAP_TICKS = 1500;
/**
 * at most one rock steal per bot this often (an hour of play): at a full mine a rude miner's picks come every few
 * seconds, and with the 15 minutes alone it stole about every 15 minutes (the humanlike runs: 39 per 100 mining
 * bot-hours, R2's band 1-8)
 */
export const ROCK_BOT_GAP_TICKS = 6000;
/**
 * at most one rock steal this often, world-wide (30 minutes): a crowded world's mines have no free rock most of the time
 * (500 bots: 7 steals in half an hour, 42 per 100 mining bot-hours, R2's band 1-8); friction now and then, not a feud at
 * every mine
 */
export const ROCK_WORLD_GAP_TICKS = 3000;
/** at most one steal from the human this often, world-wide (20 minutes) */
export const KS_HUMAN_GAP_TICKS = 2000;
/** a pick's roll for one target holds this long (the next picks of the same NPC or rock do not roll again) */
export const ROLL_HOLD_TICKS = 100;

/**
 * a rude talker's reply to the human is a rude one this often, where the question allows one (rudeReply): half. The
 * spec's 30 % made 2.6 % of the replies to the human rude (R3's band 3-12 %): the rude talkers, a fifth of the speakers,
 * answer the human less than the rest (6 % of the replies in the probe run)
 */
export const RUDE_REPLY = 0.5;

/** the chances in use (the constants; test/texture.test.mjs raises them to stage a steal: setRudeRatesForTest) */
export const rudeRates = { single: KS_SINGLE, multi: KS_MULTI, rock: ROCK_STEAL, lazy: ROCK_LAZY, reply: RUDE_REPLY };

/** Tests only: other chances (unset: the defaults). Never set by the game. */
export function setRudeRatesForTest(rates: Partial<typeof rudeRates> | null): void {
    Object.assign(rudeRates, { single: KS_SINGLE, multi: KS_MULTI, rock: ROCK_STEAL, lazy: ROCK_LAZY, reply: RUDE_REPLY }, rates ?? {});
}

// ── the incidents ────────────────────────────────────────────────────────────────────────────────────────────────────

export type StealKind = 'ks' | 'rock';

export interface Incident {
    id: number;
    kind: StealKind;
    tick: number;
    /** names (lower case), and whether each is a human */
    stealer: string;
    victim: string;
    stealerHuman: boolean;
    victimHuman: boolean;
    /** a rude bot meant it (a steal); else the victim's view of an NPC another player took first */
    deliberate: boolean;
    /** in a multi-combat area (an NPC fought by both) */
    multi: boolean;
    /** how it came about: a single-way race or a multi-combat join; no free rock, or a lazy one ('' for a take nobody meant) */
    how: string;
    x: number;
    z: number;
    /** the tick the victim noticed (gave its NPC up, its rock emptied by the stealer: -1, never), said its line about it, and
     * the stealer its answer (-1: none) */
    noticed: number;
    victimLine: number;
    stealerLine: number;
}

const MAX_INCIDENTS = 5000;
/** every incident since the world started, oldest first (capped): the humanlike runner's R1, R1h, R2 and R4 */
export const incidents: Incident[] = [];
let nextId = 1;

/** the target of each open incident (the NPC or the rock) and its players, for the victim's notice and the argument */
const openByTarget = new WeakMap<object, { incident: Incident; stealer: Player; victim: Player }>();

// (by name, not by the Player: a bot that logs in again is a new Player, and its caps went with the old one)
let lastSteal = new Map<string, number>();
let lastRockSteal = new Map<string, number>();
let lastOnHuman = -Infinity;
let lastRockWorld = -Infinity;

function nameOf(p: Player): string {
    return p.username.toLowerCase();
}

/**
 * May this bot steal now (a rude deed, its own caps and, from the human, the world's)? `kind` 'rock': its rock cap and
 * the world's too.
 */
export function maySteal(bot: Player, fromHuman: boolean, kind: StealKind = 'ks'): boolean {
    if (!rudeActs(bot)) return false;
    const now = World.currentTick;
    if (now - (lastSteal.get(nameOf(bot)) ?? -Infinity) < KS_BOT_GAP_TICKS) return false;
    if (kind === 'rock' && (now - (lastRockSteal.get(nameOf(bot)) ?? -Infinity) < ROCK_BOT_GAP_TICKS || now - lastRockWorld < ROCK_WORLD_GAP_TICKS)) return false;
    return !fromHuman || now - lastOnHuman >= KS_HUMAN_GAP_TICKS;
}

/** A bot of rude deeds (port/BotPersona rudeActs). */
export function rudeActs(bot: Player): boolean {
    return personaOf(bot.username, (bot.botPlanner as PlannerKey | undefined) ?? null).rudeActs;
}

/** A rude talker (port/BotPersona isRude): its replies may be rude, its answer in an argument too. */
export function rudeTalker(bot: Player): boolean {
    return isRude(personaOf(bot.username, (bot.botPlanner as PlannerKey | undefined) ?? null));
}

function record(kind: StealKind, stealer: Player, victim: Player, deliberate: boolean, multi: boolean, x: number, z: number, how = ''): Incident {
    const incident: Incident = {
        id: nextId++,
        kind,
        tick: World.currentTick,
        stealer: nameOf(stealer),
        victim: nameOf(victim),
        stealerHuman: !stealer.is_bot,
        victimHuman: !victim.is_bot,
        deliberate,
        multi,
        how,
        x,
        z,
        noticed: -1,
        victimLine: -1,
        stealerLine: -1
    };
    incidents.push(incident);
    if (incidents.length > MAX_INCIDENTS) incidents.splice(0, incidents.length - MAX_INCIDENTS);
    return incident;
}

/** a rude bot's steal under way (its click), by target: the victim's notice knows it was meant, and how (noticedTaken) */
const attempts = new WeakMap<object, { stealer: Player; victim: Player; tick: number; how: string }>();
/** an attempt counts for the victim's notice this long (the stealer's walk to it, its first hit) */
const ATTEMPT_TICKS = 100;

/**
 * A rude bot sets out to steal `target` from `victim` (it clicks it): the caps are spent now, whether or not it wins
 * the race (the next chance only after the gaps).
 */
export function startSteal(stealer: Player, victim: Player, target: object, multi = false, kind: StealKind = 'ks', how = kind === 'ks' ? (multi ? 'multi' : 'single') : ''): void {
    const now = World.currentTick;
    lastSteal.set(nameOf(stealer), now);
    if (kind === 'rock') {
        lastRockSteal.set(nameOf(stealer), now);
        lastRockWorld = now;
    }
    if (!victim.is_bot) lastOnHuman = now;
    attempts.set(target, { stealer, victim, tick: now, how });
}

/**
 * The steal took (the stealer's first hit on the NPC, its click on the rock): the incident, or the one the victim's
 * notice already made of it (noticedTaken, the same pair on the same target: it was meant).
 */
export function noteSteal(kind: StealKind, stealer: Player, victim: Player, target: object, multi = false, how = ''): Incident {
    const now = World.currentTick;
    const attempt = attempts.get(target);
    if (!attempt || attempt.stealer !== stealer || now - attempt.tick > ATTEMPT_TICKS) startSteal(stealer, victim, target, multi, kind, how);
    const open = openByTarget.get(target);
    if (open && open.stealer === stealer && open.victim === victim && (now - open.incident.tick <= ATTEMPT_TICKS || open.incident.deliberate)) {
        open.incident.deliberate = true;
        open.incident.multi = open.incident.multi || multi;
        if (how && !open.incident.how) open.incident.how = how;
        return open.incident;
    }
    const at = target as { x: number; z: number };
    const incident = record(kind, stealer, victim, true, multi, at.x, at.z, how);
    openByTarget.set(target, { incident, stealer, victim });
    return incident;
}

/**
 * The victim's side: `victim` was going for `target` and `taker` has it now. The incident of a rude bot's steal (the
 * same target and pair lately: noteSteal's, or a new one marked meant when the taker set out to steal it), else a new
 * one that nobody meant (another player was first). Null when it is not one to speak of (the same player, or none).
 */
export function noticedTaken(kind: StealKind, victim: Player, taker: Player | null, target: object, multi = false): Incident | null {
    if (!taker || taker === victim) return null;
    const now = World.currentTick;
    const open = openByTarget.get(target);
    if (open && open.victim === victim && open.stealer === taker && now - open.incident.tick <= ATTEMPT_TICKS * 2) {
        if (open.incident.noticed < 0) open.incident.noticed = now;
        return open.incident;
    }
    const attempt = attempts.get(target);
    const meant = !!attempt && attempt.stealer === taker && attempt.victim === victim && now - attempt.tick <= ATTEMPT_TICKS;
    const at = target as { x: number; z: number };
    // (a steal the victim noticed before the stealer's first hit landed: a miss gives no XP: how it came about, from the click)
    const incident = record(kind, taker, victim, meant, multi, at.x, at.z, meant ? attempt.how : '');
    incident.noticed = now;
    openByTarget.set(target, { incident, stealer: taker, victim });
    return incident;
}

/** the incidents an argument was started for (each once: the victim's notice and the stealer's first hit both see it) */
const argued = new WeakSet<Incident>();

/** True the first time it is asked for an incident: the caller starts its argument (port/BotChatter.argue). */
export function claimArgument(incident: Incident): boolean {
    if (argued.has(incident)) return false;
    argued.add(incident);
    return true;
}

/** The open incident on `target` that `stealer` made against `victim` lately (null: none), for the argument. */
export function openIncident(target: object, victim: Player | null, stealer: Player | null = null): Incident | null {
    const open = openByTarget.get(target);
    if (!open || World.currentTick - open.incident.tick > 600) return null;
    if (victim && open.victim !== victim) return null;
    if (stealer && open.stealer !== stealer) return null;
    return open.incident;
}

/** The two players of an open incident on `target` (null: none or too old). */
export function incidentPlayers(target: object): { incident: Incident; stealer: Player; victim: Player } | null {
    const open = openByTarget.get(target);
    return open && World.currentTick - open.incident.tick <= 600 ? open : null;
}

/** Is `bot` the stealer of a deliberate incident on `target` (its own steal: no "that was my rock" from the thief)? */
export function stoleIt(bot: Player, target: object): boolean {
    const open = openByTarget.get(target);
    return !!open && open.stealer === bot && open.incident.deliberate && World.currentTick - open.incident.tick <= 600;
}

// ── a pick's roll (once per target for a while) ──────────────────────────────────────────────────────────────────────

const rolls = new WeakMap<Player, WeakMap<object, { tick: number; hit: boolean }>>();

/** The pick's roll for this bot and target, made once and held `hold` ticks (the next picks of it read the same). */
export function rollFor(bot: Player, target: object, chance: number, hold = ROLL_HOLD_TICKS): boolean {
    let mine = rolls.get(bot);
    if (!mine) rolls.set(bot, (mine = new WeakMap()));
    const now = World.currentTick;
    const held = mine.get(target);
    if (held && now - held.tick < hold) return held.hit;
    const hit = Math.random() < chance;
    mine.set(target, { tick: now, hit });
    return hit;
}

// ── the humans of the tick (read once a tick, when a bot asks) ───────────────────────────────────────────────────────

let humansTick = -1;
let humans: Player[] = [];

/** The humans in the world now (a pass over the players, at most once a tick). */
export function humansNow(): readonly Player[] {
    const now = World.currentTick;
    if (now !== humansTick) {
        humansTick = now;
        humans = [];
        for (const p of World.playerLoop.all()) if (p.is_bot !== true && p.slot !== -1) humans.push(p);
    }
    return humans;
}

/** The human whose target is this loc or NPC (it mines the rock, walks to or fights the NPC), or null. */
export function humanAt(target: Loc | Npc): Player | null {
    for (const h of humansNow()) if (h.target === target) return h;
    return null;
}

/** the ops that attack an NPC: Attack (op 2, as the walk or in reach) and a spell on it */
const ATTACK_OPS: ReadonlySet<number> = new Set([ServerTriggerType.APNPC2, ServerTriggerType.OPNPC2, ServerTriggerType.APNPCT, ServerTriggerType.OPNPCT]);

/**
 * The human who attacks this NPC now (Attack, or a spell on it), or null. A human walking to talk to a man or to
 * pickpocket a guard is no kill-steal's victim (CombatTask's steal: it spent the world's 20 minutes on one).
 */
export function humanAttacking(npc: Npc): Player | null {
    for (const h of humansNow()) if (h.target === npc && ATTACK_OPS.has(h.targetOp)) return h;
    return null;
}

/** Is (x, z) in a multi-combat area (274's map_multiway: the zone's flag, content/maps/multiway.csv)? */
export function isMultiAt(level: number, x: number, z: number): boolean {
    return World.gameMap.isMulti(CoordGrid.packCoord(level, x, z));
}

/** The player an NPC fights now (its target, a player), or null. */
export function npcFighting(npc: Npc): Player | null {
    const t = npc.target;
    return t instanceof Player ? t : null;
}

// ── the courtesy (polite miners and the human's rock) ────────────────────────────────────────────────────────────────

/** what the miners did about the human's rock: passed over (another was free), shared (none was), taken (a rude steal) */
export const courtesy = { passedOver: 0, shared: 0, stolen: 0 };

// ── rude replies (port/BotChat.composeReply) ─────────────────────────────────────────────────────────────────────────

/** of those, an answer with a "nub" or "lol" after it instead of a line of its own */
const RUDE_ADDON = 0.25;

/**
 * The rude lines by what was asked. The words are the period's: "nub" (not the starred "noob"), "lol
 * ur poor", "who asked"; every one through the 274 filter and charset (test/chat-filter.test.mjs).
 */
export const RUDE_LINES = {
    /** the way somewhere, the bank, where to train */
    directions: ['figure it out', 'use ur map', 'do i look like a guide', 'ask some1 else', 'find it urself', 'its on the map nub', 'idk go look'],
    /** begging */
    beg: ['get a job lol', 'lol ur poor', 'no go away', 'beg somewhere else', 'lol no nub', 'stop begging'],
    /** "follow me", "wanna team up", "wanna pk" */
    no: ['no im busy', 'lol no', 'go away nub', 'no thx nub', 'y would i'],
    /** "nice gear", "nice cape" */
    gear: ['who asked', 'lol ok', 'i know', 'ya i know lol'],
    /** about itself: its levels, age, home, where it is, what it does */
    personal: ['y do u care', 'none of ur business', 'who wants to know', 'y', 'why', 'stop asking'],
    /** "hows it going", "u there?" */
    mood: ['what do u want', 'busy', 'leave me alone', 'ya what', 'go away'],
    /** a price */
    price: ['go ask a merchant', 'idk check the forums', 'more than u have lol'],
    /** after a plain answer: "{answer} nub" */
    addon: ['nub', 'lol', 'newb']
} as const;

/**
 * the question kinds (BotChat's intent ids: port/BotAnswers', the code's own and chat_responses.json's) and their rude
 * lines. Not a greeting, thanks, a goodbye, gz, a joke, a trade or the marketplace (those stay as they are)
 */
const RUDE_BY_INTENT: Readonly<Record<string, keyof typeof RUDE_LINES>> = {
    directions: 'directions',
    bank: 'directions',
    spots: 'directions',
    help: 'directions',
    newbie: 'directions',
    quest: 'directions',
    money: 'directions',
    advice: 'directions',
    area: 'directions',
    area2: 'directions',
    beg: 'beg',
    begging: 'beg',
    follow: 'no',
    team: 'no',
    pk: 'no',
    fight: 'no',
    gear: 'gear',
    asl: 'personal',
    age: 'personal',
    from: 'personal',
    gender: 'personal',
    playtime: 'personal',
    play_time: 'personal',
    skill: 'personal',
    combat: 'personal',
    total: 'personal',
    whereami: 'personal',
    where: 'personal',
    doing: 'personal',
    bot: 'personal',
    who: 'personal',
    about: 'personal',
    goals: 'personal',
    quest_done: 'personal',
    attack: 'personal',
    strength: 'personal',
    defence: 'personal',
    hitpoints: 'personal',
    ranged: 'personal',
    prayer: 'personal',
    magic: 'personal',
    cooking: 'personal',
    woodcutting: 'personal',
    fletching: 'personal',
    fishing: 'personal',
    firemaking: 'personal',
    crafting: 'personal',
    smithing: 'personal',
    mining: 'personal',
    herblore: 'personal',
    agility: 'personal',
    thieving: 'personal',
    runecraft: 'personal',
    slayer: 'personal',
    how: 'mood',
    presence: 'mood',
    whatsup: 'mood',
    mood: 'mood',
    price: 'price'
};

/** every rude reply said lately (bot name lower case, tick, text): the humanlike runner's R3 (capped) */
export const rudeReplies: { name: string; tick: number; text: string }[] = [];
const MAX_RUDE_REPLIES = 5000;

/**
 * A rude form of a reply to the human (port/BotChat.composeReply), or null for the reply as it is: only from a rude
 * talker, RUDE_REPLY of the time, for a question that allows one (`intentId`); `answer` the plain reply (an add-on goes
 * after it). Never for a greeting, thanks, a trade, the marketplace, a "come here", nor a "follow me" the bot agrees to
 * (it follows: `willing`).
 */
export function rudeReply(bot: Player, intentId: string, answer: string, willing = false, random: () => number = Math.random): string | null {
    if (!rudeTalker(bot) || willing) return null;
    const pool = RUDE_BY_INTENT[intentId];
    if (!pool || random() >= rudeRates.reply) return null;
    const own = RUDE_LINES[pool];
    if (pool !== 'personal' && pool !== 'no' && random() < RUDE_ADDON) {
        const add = RUDE_LINES.addon[Math.floor(random() * RUDE_LINES.addon.length)];
        return `${answer.replace(/[.!]+$/, '')} ${add}`;
    }
    return own[Math.floor(random() * own.length)];
}

/** BotChat said a rude reply (the runner counts them: R3). */
export function noteRudeReply(bot: Player, text: string): void {
    rudeReplies.push({ name: nameOf(bot), tick: World.currentTick, text });
    if (rudeReplies.length > MAX_RUDE_REPLIES) rudeReplies.splice(0, rudeReplies.length - MAX_RUDE_REPLIES);
}

/** (tests) forget every incident, cap and count */
export function resetRudeForTest(): void {
    incidents.length = 0;
    rudeReplies.length = 0;
    lastSteal = new Map();
    lastRockSteal = new Map();
    lastOnHuman = -Infinity;
    lastRockWorld = -Infinity;
    setRudeRatesForTest(null);
    courtesy.passedOver = 0;
    courtesy.shared = 0;
    courtesy.stolen = 0;
    humansTick = -1;
}

/** (tests) the per-bot cap's last steal (or -Infinity) */
export function lastStealOf(bot: Player): number {
    return lastSteal.get(nameOf(bot)) ?? -Infinity;
}
