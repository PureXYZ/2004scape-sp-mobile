/**
 * SocialTask.ts
 *
 * "Extras" personality — social bot.
 * Upstream: it approached real players, chatted, then led them on a short walking tour of a dozen destinations and
 * tipped them from 100,000 coins at the end; 5 % of the tours were Wilderness lures (it crossed the ditch and attacked a
 * player who followed).
 *
 * port (the realism work, phase 3: population, track C; "social bots as regulars": per-hub caps, own
 * tiles, chatting with each other and with passers-by; the scripted tour and the 100k coin tips dropped; "I like the idea
 * of having luring, keep that"):
 *  - A social bot is a regular of one hub: the first of its name's order of hubs (weighted by 2004's crowds there,
 *    the research) with room under the hub's cap. A cap is a quarter of the bots usually seen there, at least 1: the
 *    2004 estimate per 100 online or, once the regulars have looked a while, the bots they saw within 15 tiles of it
 *    (not social bots; the lower of the two), rounded; Lumbridge's at most 3 per 100 online. Every hub at its cap (a big
 *    world with thin crowds), the hub where it makes the smallest share of the crowd. Once the crowds are known, the
 *    newest regular of a hub over its cap moves now and then to a hub with room (or a much smaller share). Varrock
 *    square and Falador park joined the hubs. Below combat 16 not Draynor (its dark wizards).
 *  - At its hub it stands on a tile of its own (port/BotTiles.claimStandTile: the crowds work's; until that is in, one
 *    no other regular holds and nobody stands on), steps to another now and then, greets a passer-by now and then (a bot
 *    or a human; not the same one again for 30 minutes, nor one another regular greeted lately), waves or dances now and
 *    then, has short exchanges with other bots there at a low rate (port/BotStage), and answers as any bot does
 *    (port/BotChat).
 *  - It still approaches a human now and then (upstream's job: "Hi sim human!", "Ur levels look decent", "How long u
 *    been playing?"; any social bot at most once in 15-30 minutes for a human, each one once a session), and no tour
 *    follows: a goodbye now and then, back to its tile.
 *  - About 1 approach in 5 is a lure (upstream's 1 tour in 20): a 2004 form ("free armour in the wildy", a drop party at
 *    the wildy edge, "ill guard u while u mine", "i know a safe spot", or upstream's own pitch), then upstream's lead to
 *    Edgeville and, if the human follows, north into the Wilderness, deep enough that the game lets it attack them (the
 *    combat levels' difference: at most level 12), the betrayal and the attack. At most one lure for a human in 30
 *    minutes; only a human free (no fight, no window) and outside the Wilderness; the game's PvP rules decide every hit,
 *    and a human killed there loses what the game takes.
 *  - port (the realism work, phase 5b, Track P: "scams and more lures"; lures may lead to a waiting PK
 *    team): six more 2004 forms (data/social.json: a vendor's deal at the edge, free lobs, a clan recruiting, a phat
 *    dropped, a paid helper, a rare spawn), all drawn evenly. While a PK team raids at the edge (a 'pk_raid' run of
 *    port/BotSetPieces near Edgeville or in Varrock's Wilderness), half the lures lead there instead: to the team's
 *    leader, "lol get him guys" on arrival, and the team fights under its own rules (the lurer leaves the pile to them:
 *    the raid's 3 a target). The rates stay (1 approach in 5, a human at most once in 30 minutes). Every approach and lure
 *    is logged (approachLog, lureLog: the humanlike report's K4).
 *  - port (phase 5b, Track P): the fake Wilderness drop party, a director's set piece ('fake_dp'): a social regular at
 *    Varrock West, or a bot at Edgeville's bank, calls out "drop party at lvl 3 wildy!!" 3-4 times over about 3
 *    minutes while Edgeville's PKers patrol the edge; bots near say "its a lure lol". Talk only: whoever goes meets the
 *    PKers under their own rules.
 *
 *  - port (the variety work, round 2, Track S2: P5, the approach v2):
 *    the opener reacts to what the human is (data/social.json approach: its gear, a cape or a hat, its combat level, what
 *    it holds, the place: "nice cape", "lvl 3 lol hi", "first time in fally?"), upstream's five small-talk lines kept in
 *    the pool word for word; after a question the regular waits 15-25 s for an answer (the human talking with it holds
 *    it, as before), then goes on with a statement or leaves (a goodbye half the time); never a second question the human
 *    did not answer; a word ("cool") after the human's answer now and then. A regular greets a passer-by once a login,
 *    and none of its optional lines over its share of its hub's talk (port/BotVoice: about a fifth in an hour).
 *
 * Pathfinding strategy:
 *  - Movement uses _stuckWalk (StuckDetector + walkTo, a rescue jump only where no human sees it) — the same path stack
 *    every other bot task uses. The lure's lead walks upstream's via point (Barbarian Village) first.
 *  - Floor-level 0 is enforced every tick so bots never end up upstairs.
 */

import {
    BotTask,
    Player,
    walkTo,
    isNear,
    randInt,
    StuckDetector,
    teleportNear,
    Locations,
} from '#/engine/bot/tasks/BotTaskBase.js';
import { interactPlayerOp, tilesInReach } from '#/engine/bot/BotAction.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { BotChat, botPersona, isBusy, sayTyped } from '#/engine/bot/port/BotChat.js';
import { nickOf, sameClique } from '#/engine/bot/port/BotCliques.js';
import { pvpWildernessLevel, wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { countAsChatter } from '#/engine/bot/port/BotChatter.js';
import { botEmote, everydayEmote } from '#/engine/bot/port/BotEmote.js';
import { isAway } from '#/engine/bot/port/BotHabits.js';
import { freshLine, isFresh, noteSaid } from '#/engine/bot/port/BotLines.js';
import { botSay } from '#/engine/bot/port/BotSay.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { noteSpoke } from '#/engine/bot/port/BotSpoke.js';
import { claimStandTile, releaseStandTile, stepToTile } from '#/engine/bot/port/BotTiles.js';
import { offStalls } from '#/engine/bot/port/BotHangout.js';
import { logNormal, reactionTicks, typingTicks } from '#/engine/bot/port/BotTiming.js';
import { clearTradeTarget } from '#/engine/bot/port/BotTradeScreen.js';
import WordEnc from '#/cache/wordenc/WordEnc.js';
import World from '#/engine/World.js';
import socialJson from '../../data/social.json';
// (phase 5b, Track P: the lure to a waiting PK team, the fake Wilderness drop party: port/BotSetPieces' runs, never another
// track's module; the set piece's lines: port/BotPieceLines)
import { eventRoleOf, nextSetPieceId, register, runningSetPieces, type SetPieceContext, type SetPieceDef, type SetPiecePhase, type SetPiecePlan, type SetPieceRun, type SetPieceVenue } from '#/engine/bot/port/BotSetPieces.js';
import { anyPieceLine, freshPieceText, sayPieceLine, sayPieceText } from '#/engine/bot/port/BotPieceLines.js';
import { scheduleInTicks } from '#/engine/bot/port/BotSchedule.js';
// (the variety work, round 2, Track S2: P5, the approach v2 and one voice's share)
import { voiceFree } from '#/engine/bot/port/BotVoice.js';
import { notableGearOf } from '#/engine/bot/port/BotWitness.js';
import { placeAt } from '#/engine/bot/port/BotSlots.js';
import { isQuestionText } from '#/engine/bot/port/BotChat.js';
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SCAN_RADIUS   = 20;
const FOLLOW_RADIUS = 14;
const MISS_LIMIT    = 4;
/** port: after an approach no social bot approaches that human again for 15-30 minutes (ticks); the same bot not again this session */
const APPROACH_GAP: [number, number] = [1500, 3000];
/** a scan at its tile every this many ticks (who passes, who to approach) */
const SCAN_TICKS: [number, number] = [6, 12];
/** the small talk of an approach: this many lines (upstream: 2) */
const TALK_LINES: [number, number] = [1, 2];
/** a conversation the human starts meanwhile holds the small talk at most this many scans */
const TALK_WAIT = 12;
/** a cap's share of the bots usually seen at a hub, and Lumbridge's most per 100 online (the defaults of phase 3) */
const CAP_SHARE = 0.25;
const LUMBRIDGE_PER_100 = 3;
/**
 * a hub's crowd as the regulars see it: the bots (not social) within this many tiles of its middle, a running average
 * (a new sample's weight); one hub looked at every CROWD_EVERY ticks in turn (by whichever regular scans first), so
 * every hub's is known within a few minutes; a cap uses it from CROWD_SAMPLES samples on
 */
const CROWD_VIEW = 15;
const CROWD_WEIGHT = 0.05;
const CROWD_EVERY = 10;
const CROWD_SAMPLES = 10;
/**
 * a passer-by: within this of the regular; its next greeting a heavy-tailed while later (log-normal: a median of 12
 * minutes, at least 72 seconds: people's gaps are bursty, the humanlike report's C2); the chance (by sociability)
 */
const GREET_RANGE = 6;
const GREET_GAP_MEDIAN = 1200;
const GREET_GAP_SIGMA = 1.0;
const GREET_GAP_MIN = 120;
const GREET_CHANCE: [number, number] = [0.2, 0.35];
/** the same passer-by: not again by this regular for 30 minutes, nor by any regular for 6 */
const GREET_AGAIN = 3000;
const GREET_ANY = 600;
/** a passer-by bot answers a greeting this often (by its sociability), with its name now and then */
const GREET_BACK: [number, number] = [0.2, 0.3];
const GREET_NAMED_BOT = 0.4;
const GREET_NAMED_HUMAN = 0.25;
/** a step to another tile within this, every 1.5-5 minutes */
const MOVE_RADIUS = 3;
const MOVE_GAP: [number, number] = [900, 3000];
/** a wave or a dance every 1.5-4.5 hours (the less sociable, the rarer; an everyday one, port/BotEmote: 10-30 minutes
 * before 2026-10-19, "rare and special") */
const EMOTE_GAP: [number, number] = [9000, 27000];
/** a tile it has not stepped onto after this many tries (an NPC on it) is given up for another */
const TILE_TRIES = 6;
/**
 * a regular over its hub's cap (once the crowds are known: a hub that turned out quieter than 2004's) looks for another
 * every 1-2 minutes: the newest of its hub moves, to the first of its name's order with room, else where it makes a
 * share of the crowd smaller by REBALANCE_GAIN than here; one at a time
 */
const REBALANCE_TICKS: [number, number] = [120, 200];
const REBALANCE_GAIN = 0.15;
/** lures: this share of approaches, at most one a human in this many ticks (30 minutes), at most this deep */
const LURE_SHARE = 0.2;
const LURE_GAP = 3000;
const LURE_MAX_WILD = 12;

// ── Hubs ──────────────────────────────────────────────────────────────────────
// x/z: the middle of its stand area; spawnX/Z: an outdoor tile it walks to first (and the rescue's landing); its stand
// tiles are those a player walks to from there within `radius` of the middle. `usual`: 2004's crowd in view of the spot
// per 100 online (the research has the whole hubs: Lumbridge 6-10 with its castle, church and fields, about half of it
// in the courtyard; Draynor 4-6 with its willows, fishing and market; Varrock West 4-6; Varrock's square and east bank
// part of 5-8, Falador's park and east bank part of 5-8; Barbarian Village 2-4; Port Sarim 2-4).

export interface Hub {
    key: string;
    x: number; z: number;
    spawnX: number; spawnZ: number;
    radius: number;
    usual: number;
    /** port: no bot below this combat level comes here (see DARK_WIZARDS_COMBAT) */
    minCombat?: number;
}

/**
 * port: Draynor's young dark wizards (by the bank's road and the riverside) attack players up to combat 14, from a
 * distance: below 16 a social bot keeps away, as the woodcutting and fishing tasks already do (upstream's own rule).
 * In the 274 sims two level-3 social bots died at the Draynor hub.
 */
const DARK_WIZARDS_COMBAT = 16;

export const HUBS: readonly Hub[] = [
    // Varrock West Bank — road south of the building
    // (port, the integration of phase 4: 3185,3431; at 3185,3433 the spot was the bankers' strip behind the booths, nine
    // tiles closed in, and its regulars stood there: port/BotTiles fills from the spot, test/tiles.test.mjs)
    { key: 'varrock_west', x: 3185, z: 3431, spawnX: 3185, spawnZ: 3431, radius: 5, usual: 5 },
    // Varrock East Bank — road south of the building
    // (port, the integration of phase 4: 3253,3411; 3253,3415 is a wall of the building, and the fill next to it was the
    // bankers' area behind the counter)
    { key: 'varrock_east', x: 3253, z: 3411, spawnX: 3253, spawnZ: 3411, radius: 5, usual: 2.5 },
    // Lumbridge — the courtyard south of the castle (LUMBRIDGE_SPAWN area)
    { key: 'lumbridge', x: 3222, z: 3218, spawnX: 3222, spawnZ: 3218, radius: 5, usual: 4 },
    // Barbarian Village — road through the village (BARBARIANS_VILLAGE)
    { key: 'barbarian_village', x: 3083, z: 3421, spawnX: 3083, spawnZ: 3420, radius: 5, usual: 3 },
    // Draynor Village — road south of the bank (DRAYNOR_BANK area)
    { key: 'draynor', x: 3092, z: 3240, spawnX: 3092, spawnZ: 3240, radius: 5, usual: 3, minCombat: DARK_WIZARDS_COMBAT },
    // Falador East Bank — road outside the bank (FALADOR_EAST_BANK)
    { key: 'falador_east', x: 3012, z: 3358, spawnX: 3012, spawnZ: 3360, radius: 5, usual: 2.5 },
    // Port Sarim — road near the docks (GERRANTS_FISHING area)
    { key: 'port_sarim', x: 3028, z: 3220, spawnX: 3028, spawnZ: 3220, radius: 4, usual: 2 },
    // port: Varrock square — round the fountain (2004: loitering, follow trains, dancers, drop-party crowds)
    { key: 'varrock_square', x: 3212, z: 3426, spawnX: 3212, spawnZ: 3424, radius: 6, usual: 2.5 },
    // port: Falador park — the lawn by the fountain (2004's hangout)
    { key: 'falador_park', x: 2997, z: 3377, spawnX: 2997, spawnZ: 3376, radius: 6, usual: 2 },
];

/** port: may a bot of this combat level go to this hub? */
function mayGo(player: Player, hub: Hub): boolean {
    return hub.minCombat === undefined || player.combatLevel >= hub.minCombat;
}

/** port: a hub's crowd as the regulars saw it (non-social bots within CROWD_VIEW of its middle), the samples' average */
const crowdSeen = new Map<string, { avg: number; n: number }>();
let crowdNext = 0;
let crowdAt = -1;

/** port: the bots usually seen at a hub (not social): 2004's estimate, or what the regulars saw there if fewer */
export function hubUsual(hub: Hub, online: number): number {
    const estimate = (hub.usual * online) / 100;
    const seen = crowdSeen.get(hub.key);
    return seen && seen.n >= CROWD_SAMPLES ? Math.min(estimate, seen.avg) : estimate;
}

/**
 * port: how many regulars a hub takes with `online` bots online: a quarter of the bots usually seen there (hubUsual),
 * at least 1; Lumbridge at most 3 per 100 online.
 */
export function hubCap(hub: Hub, online: number): number {
    let cap = Math.max(1, Math.round(CAP_SHARE * hubUsual(hub, online)));
    if (hub.key === 'lumbridge') cap = Math.min(cap, Math.max(1, Math.floor((LUMBRIDGE_PER_100 * online) / 100)));
    return cap;
}

/** port: tests only: forget the crowds seen. Never called by the game. */
export function forgetCrowdsForTest(): void {
    crowdSeen.clear();
}

/** port: the bot's order of hubs (from its name, the busier hubs first more often): its first with room is its hub */
export function hubOrder(name: string): number[] {
    const r = seededRandom(nameSeed(name, 'social-hub'));
    // (a weighted shuffle: each hub's key -ln(u) / weight, smallest first)
    return HUBS.map((hub, i) => ({ i, key: -Math.log(1 - r()) / hub.usual })).sort((a, b) => a.key - b.key).map(x => x.i);
}

// ── Lines ─────────────────────────────────────────────────────────────────────
// Upstream's, word for word (its tour's and its tips' are gone with them), and the new ones in data/social.json.

const BETRAY_PHRASES   = ['lol gotcha', 'enjoy the respawn :)', 'pk time lmao', 'shouldnt have followed', 'surprise!'];
const DARE_PHRASE      = 'come in if u dare lol';
const GREET_PHRASES    = ['hey', 'hi', 'yo', 'hiya', 'sup', 'ello', 'heya', 'wagwan'];
const CHAT_LINES       = ['nice to meet u!', 'how long u been playing?', 'ur levels look decent', 'what quest r u doing?', 'this game is addictive ngl'];
/**
 * port (the variety work, round 1, S6: by design) upstream's post-2004 line, its words kept, from the meme personas
 * only, as the other modern lines are (port/BotLines' meme category)
 */
const MEME_CHAT_LINE   = 'this game is addictive ngl';
const FOLLOW_PROMPTS   = ['follow me ill show u something cool', 'wanna see a good spot? follow me!', 'come with me, I know somewhere', 'follow me real quick', "let's go exploring, follow!"];
const WAIT_PHRASES     = ['u coming?', 'this way!', 'come on lol', 'follow follow', "u lost? I'm over here", 'catch up!'];
const MOVING_LINES     = ['almost there', 'not far now', 'just up here', 'good spot ahead', "u'll like this place", 'nearly there'];
const FAREWELL_PHRASES = ['nice chatting! gl with ur gains', 'cya around!', 'gotta go, laters!', 'good luck on ur adventures', 'see u round!'];
// upstream's Wilderness lure destination's own lines (Edgeville)
const LURE_APPROACH    = ['edgeville is nice, follow me', 'good spot up north, come see', 'follow me north a sec', 'theres something cool up here'];
const LURE_ARRIVAL     = ['nearly there...', 'just up here...', 'this way...'];

interface LureForm {
    pitch: readonly string[];
    lead: readonly string[];
}
/** port: the 2004 lure forms (data/social.json) and upstream's own (its tour's prompt and the Edgeville lines) */
const LURE_FORMS: Readonly<Record<string, LureForm>> = {
    ...socialJson.lure.forms,
    upstream: { pitch: [...FOLLOW_PROMPTS, ...LURE_APPROACH], lead: [...LURE_ARRIVAL, ...MOVING_LINES] }
};
const LURE_FORM_KEYS = Object.keys(LURE_FORMS);

/** port (phase 5b, Track P): a lure to a waiting PK team: its arrival line (data/social.json lure.ambush) */
const AMBUSH_LINES: readonly string[] = socialJson.lure.ambush;

/** (the variety work, round 2, S2-2) the approach's openers by what the human is (data/social.json approach) */
const APPROACH = socialJson.approach as Readonly<Record<string, readonly string[]>>;

/** Every line a social bot says (upstream's and the new), for test/chat-filter.test.mjs. */
export const SOCIAL_LINES = {
    betray: BETRAY_PHRASES, dare: [DARE_PHRASE], greet: GREET_PHRASES, chat: CHAT_LINES, wait: WAIT_PHRASES, farewell: FAREWELL_PHRASES,
    regularGreet: socialJson.regular.greet, regularGreetNamed: socialJson.regular.greetNamed, lureForms: LURE_FORMS, ambush: AMBUSH_LINES,
    // (variety round 2, S2-2: the approach's openers by what the human is, their slots {item} {n} {target} {place})
    approach: APPROACH
} as const;

// ── (the variety work, round 2, Track S2: P5) the approach v2 ────────────────────────────────────────────────────

/** an opener of `pool` with its slots filled, through the filter, or null */
function approachLine(pool: string, slots: Record<string, string>): string | null {
    const lines = APPROACH[pool] ?? [];
    for (let i = 0; i < 3 && lines.length; i++) {
        const line = pickRandom(lines).replace(/\{([a-z]+)\}/g, (all, k: string) => slots[k] ?? all);
        if (!line.includes('{') && WordEnc.filter(line) === line) return line;
    }
    return null;
}

/** the weapon a player holds, by its name (lower case), or '' */
function wielded(p: Player): string {
    const id = p.getInventory(InvType.WORN)?.get(3)?.id ?? -1;
    return id === -1 ? '' : (ObjType.get(id)?.name ?? '').toLowerCase();
}

/**
 * (variety round 2, S2-2) the approach's first words for `human`: about what it is (its notable gear, a cape or a hat,
 * its combat level, what it holds, the place) or one of upstream's five, weighted; null for none of the new ones
 */
export function approachOpener(human: Player, meme: boolean): string {
    const options: { w: number; line: () => string | null }[] = [];
    const gear = notableGearOf(human);
    // (the fixes, B5: "nice armour lol" only at armour, a trim, god armour, dragon, full rune; not at a glory or a mime)
    const armour = gear !== null && ['trim', 'god', 'dragon', 'fullrune'].includes(gear.kind);
    if (gear) options.push({ w: 3, line: () => approachLine(armour && Math.random() < 0.3 ? 'armour' : 'gear', { item: gear.item }) });
    const worn = human.getInventory(InvType.WORN);
    if (worn?.get(1)) options.push({ w: 1, line: () => approachLine('cape', {}) });
    const head = (ObjType.get(worn?.get(0)?.id ?? -1)?.name ?? '').toLowerCase();
    if (head && !/helm|coif|hood/.test(head)) options.push({ w: 0.7, line: () => approachLine('hat', {}) });
    const cb = human.combatLevel;
    if (cb >= 70) options.push({ w: 2, line: () => approachLine('high', { n: String(cb) }) });
    // (the fixes, B6: a level 3's ("lvl {n} lol hi": its level, 3 or 4 or 5, filled in))
    else if (cb <= 5) options.push({ w: 2, line: () => approachLine('low', { n: String(cb) }) });
    const weapon = wielded(human);
    if (/\baxe\b|hatchet/.test(weapon)) options.push({ w: 1.5, line: () => approachLine('Woodcut', {}) });
    else if (/pickaxe/.test(weapon)) options.push({ w: 1.5, line: () => approachLine('Mine', {}) });
    else if (/harpoon|fishing|net/.test(weapon)) options.push({ w: 1.5, line: () => approachLine('Fish', {}) });
    const place = placeAt(human.x, human.z, human.level);
    if (place) options.push({ w: 1.5, line: () => approachLine('place', { place: place.say }) });
    options.push({ w: 1, line: () => approachLine('idle', {}) });
    // (upstream's small talk, word for word: "this game is addictive ngl" from a meme persona only)
    const upstream = CHAT_LINES.filter(l => meme || l !== MEME_CHAT_LINE);
    options.push({ w: 3, line: () => pickRandom(upstream) });
    let x = Math.random() * options.reduce((sum, o) => sum + o.w, 0);
    for (const o of options) {
        if ((x -= o.w) > 0) continue;
        const line = o.line();
        if (line !== null) return line;
        break;
    }
    return pickRandom(upstream);
}

/** (variety round 2, S2-2) after a question the regular waits this long for an answer (15-25 s) */
const ANSWER_WAIT: [number, number] = [25, 42];
/** (variety round 2, S2-2) a word after the human's answer ("cool") this often */
const AFTER_WORD = 0.5;
/** (variety round 2, S2-2) the passers-by each regular greeted this login (once each) */
const greetedThisLogin = new WeakMap<Player, WeakSet<Player>>();

// ── port (phase 5b, Track P): the lures' log, the PK team at the edge ─────────────────────────────────────────────

/** an approach to a human (any social bot), a lure (its form, whether it led to a PK team): the humanlike report's K4 */
export interface LureNote {
    t: number;
    form: string;
    ambush: boolean;
    human: string;
    bot: string;
}
const LOG_MAX = 1000;
export const approachLog: { t: number; human: string; bot: string }[] = [];
export const lureLog: LureNote[] = [];

/** the Wilderness by Edgeville and north of Varrock (levels 1-8 and the edge's approach): where a raid's team waits */
function atTheEdge(x: number, z: number, level: number): boolean {
    return level === 0 && x >= 3060 && x <= 3330 && z >= 3480 && z <= 3590;
}

/** where a running PK team raid is now (Track D's 'pk_raid': its leader, else any of its team), in the Wilderness, or null */
export function raidAtTheEdge(): { run: SetPieceRun; x: number; z: number } | null {
    for (const run of runningSetPieces()) {
        if (run.kind !== 'pk_raid' || run.phase === 'end' || run.phase === 'done') continue;
        let at: Player | null = null;
        for (const [p, role] of run.roles) {
            if (p.slot === -1) continue;
            if (role === 'leader') {
                at = p;
                break;
            }
            at ??= p;
        }
        const [x, z, level] = at ? [at.x, at.z, at.level] : [run.venue.x, run.venue.z, run.venue.level];
        // (in the Wilderness: an Edgeville team still meeting north of the bank waits where nobody can be attacked)
        if (atTheEdge(x, z, level) && wildernessLevelAt(x, z) > 0) return { run, x, z };
    }
    return null;
}

/** (a lure leads to a waiting team half the time while one is there: the defaults; testRates.ambush) */
/** the lurer is there: within this of the team's leader */
const AMBUSH_RADIUS = 6;

/** port: the Wilderness lure's way: Edgeville (just south of the Wilderness), through Barbarian Village */
const LURE_DEST: [number, number, number] = Locations.YEWS_EDGEVILLE;     // [3087, 3476, 0]
const LURE_VIA: [number, number, number]  = Locations.BARBARIANS_VILLAGE; // [3082, 3434, 0]
const LURE_RADIUS = 5;

// ── Helpers ───────────────────────────────────────────────────────────────────

function chebyshev(ax: number, az: number, bx: number, bz: number): number {
    return Math.max(Math.abs(ax - bx), Math.abs(az - bz));
}

function pickRandom<T>(arr: readonly T[]): T {
    return arr[Math.floor(Math.random() * arr.length)]!;
}

/** port: the humans in the world (found once a tick: a scan over the players, not one per regular's scan) */
let humansAt = -1;
let humans: Player[] = [];
function humansNow(): Player[] {
    if (humansAt !== World.currentTick) {
        humansAt = World.currentTick;
        humans = [];
        for (const p of World.playerLoop.all()) if (!p.is_bot) humans.push(p);
    }
    return humans;
}

function findNearbyRealPlayer(bot: Player, radius: number): Player | null {
    let best: Player | null = null;
    let bestDist = radius + 1;
    for (const p of humansNow()) {
        if (p.level !== bot.level || p.slot === -1) continue;
        const d = chebyshev(bot.x, bot.z, p.x, p.z);
        if (d <= radius && d < bestDist) { best = p; bestDist = d; }
    }
    return best;
}

/** port: the players within `radius` of (x, z) on `level` (the zones there: a few, not the world) */
function playersNear(x: number, z: number, level: number, radius: number): Player[] {
    const out: Player[] = [];
    for (let zx = (x - radius) >> 3; zx <= (x + radius) >> 3; zx++) {
        for (let zz = (z - radius) >> 3; zz <= (z + radius) >> 3; zz++) {
            for (const p of World.gameMap.getZone(zx << 3, zz << 3, level).getAllPlayersSafe()) {
                if (p.level === level && chebyshev(p.x, p.z, x, z) <= radius) out.push(p);
            }
        }
    }
    return out;
}

/** port: the wilderness level at which the game lets two players of these combat levels fight (their difference, at least 1) */
function lureDepth(a: Player, b: Player): number {
    return Math.max(1, Math.abs(a.combatLevel - b.combatLevel));
}

function inCombatRange(wildLevel: number, a: number, b: number): boolean {
    return wildLevel > 0 && Math.abs(a - b) <= wildLevel;
}

/** port: N, the bots online the caps are for (BotManager.stats().configured, read once: it is fixed for a run) */
let configuredN = 0;
function onlineN(): number {
    if (configuredN === 0) configuredN = Math.max(0, BotManager.stats().configured);
    return Math.max(1, configuredN);
}

/** port: the test's knobs (test/social.test.mjs, test/scams.test.mjs): the lure share, the approach gap, the share of lures to a waiting PK team. Never set by the game. */
const testRates = { lure: LURE_SHARE, approachGap: APPROACH_GAP as [number, number], ambush: 0.5 };
export function setSocialRatesForTest(rates: Partial<typeof testRates>): void {
    Object.assign(testRates, rates);
}

// ── Task ──────────────────────────────────────────────────────────────────────

type SocialState = 'travel' | 'stand' | 'approach' | 'chat' | 'lure' | 'wilderness_trap';

/** port: what port/BotStage needs of a regular standing at its hub */
export interface RegularAt {
    bot: Player;
    hub: string;
}

export class SocialTask extends BotTask {
    private static readonly activePids = new Set<number>();
    /** port: when a human may be approached again (any social bot), by uid */
    private static readonly nextApproach = new Map<number, number>();
    /** port: when a human may be lured again (any social bot), by uid */
    private static readonly nextLure = new Map<number, number>();
    /** port: the humans each bot met this session (its Player: a new login is a new session) */
    private static met = new WeakMap<Player, Set<string>>();
    /** port: the regulars online and their tasks (a hub's count, its tiles), and when a passer-by was last greeted by any */
    private static readonly regulars = new Map<Player, SocialTask>();
    private static readonly lastGreeted = new Map<string, number>();

    private state: SocialState = 'travel';

    private target: Player | null = null;

    /** port: its hub (HUBS), its stand tile, whether the tile is port/BotTiles' (released there) */
    hubIndex = -1;
    tile: [number, number] | null = null;
    private tileClaimed = false;
    private tileTries = 0;
    /** port: who stood near it at its last scan (a passer-by is one new since), whom it greeted when */
    private near = new Set<Player>();
    private greeted = new Map<string, number>();
    private nextGreet = 0;
    private nextMove = 0;
    private nextEmote = 0;
    /** port: when it came to its hub (the newest of a hub over its cap moves first), and its next look at the caps */
    private arrivedAt = 0;
    private nextRebalance = 0;

    private chatPhase = 0;
    private talkCount = 2;
    private talkWait = 0;
    /** port: its small talk this meeting (drawn without repeats) */
    private talkLines: string[] = [];
    /** (variety round 2, S2-2) its question waits for an answer until this tick; the human answered one */
    private answerUntil = -1;
    private answered = false;

    // Approach state
    private approachTicks = 0;

    // Lure state
    private lureForm: LureForm | null = null;
    private lureWild = 1;
    private leadTicks          = 0;
    private leadCommentTick    = 0;
    private missedFollowChecks = 0;
    private viaReached         = false;
    private wildernessPhase    = 0;
    private betrayed           = false;
    /** port (phase 5b): the PK team this lure leads to (half the lures while one raids at the edge), and its wait there */
    private lureTeam: SetPieceRun | null = null;
    private ambushUntil        = -1;
    /** The bot this task last ran for (port: _resetTarget clears its own trade, upstream cleared the human's). */
    private self: Player | null = null;

    private readonly stuck     = new StuckDetector(30, 4, 2); // port: as the other tasks' ((12, 3, 1) jumped a bot on the first 12 ticks of a sideways leg)
    private readonly leadStuck = new StuckDetector(20, 4, 2);

    constructor() {
        super('Social');
    }

    shouldRun(_player: Player): boolean { return true; }

    tick(player: Player): void {
        if (this.interrupted) return;
        this.self = player;

        if (this.hubIndex === -1) this._chooseHub(player);
        const hub = HUBS[this.hubIndex]!;
        if (player.level !== 0 && this.state !== 'wilderness_trap' && this.state !== 'lure') {
            // (upstairs or underground: a rescue jump, where nobody sees it)
            teleportNear(player, hub.spawnX, hub.spawnZ);
            this._resetTarget();
            this.cooldown = 3;
            return;
        }

        if (this.cooldown > 0) { this.cooldown--; return; }

        switch (this.state) {
            case 'travel':          return this.handleTravel(player, hub);
            case 'stand':           return this.handleStand(player, hub);
            case 'approach':        return this.handleApproach(player);
            case 'chat':            return this.handleChat(player);
            case 'lure':            return this.handleLure(player);
            case 'wilderness_trap': return this.handleWildernessTrap(player);
        }
    }

    isComplete(): boolean { return false; }

    override reset(): void {
        super.reset();
        this._resetTarget();
        this._releaseTile();
        if (this.self) SocialTask.regulars.delete(this.self);
        this.hubIndex = -1;
        this.state = 'travel';
        this.near.clear();
    }

    /** port: the regulars standing at their hub's tile now (port/BotStage: exchanges between regulars at their hubs) */
    static regularsAtHubs(): RegularAt[] {
        const out: RegularAt[] = [];
        for (const [p, task] of SocialTask.regulars) {
            if (p.slot === -1 || task.state !== 'stand' || !task.tile || task.hubIndex < 0) continue;
            if (chebyshev(p.x, p.z, task.tile[0], task.tile[1]) > 1) continue;
            out.push({ bot: p, hub: HUBS[task.hubIndex]!.key });
        }
        return out;
    }

    /** port: how many regulars each hub has online (tests) */
    static regularsByHub(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const [p, task] of SocialTask.regulars) if (p.slot !== -1 && task.hubIndex >= 0) out[HUBS[task.hubIndex]!.key] = (out[HUBS[task.hubIndex]!.key] ?? 0) + 1;
        return out;
    }

    /** port: tests only (test/social.test.mjs): who met whom and the approach gaps forgotten (the lure gaps too, unless kept). Never called by the game. */
    static forgetForTest(keepLures = false): void {
        SocialTask.met = new WeakMap();
        SocialTask.nextApproach.clear();
        SocialTask.activePids.clear();
        if (!keepLures) SocialTask.nextLure.clear();
    }

    /** port: the task's state and target (tests: the lure) */
    view(): { state: SocialState; target: Player | null; hub: string | null; tile: [number, number] | null } {
        return { state: this.state, target: this.target, hub: this.hubIndex >= 0 ? HUBS[this.hubIndex]!.key : null, tile: this.tile };
    }

    // ── States ────────────────────────────────────────────────────────────────

    /** port: its hub: the first of its name's order with room under the hub's cap (its combat level allowing); all full, the least full */
    private _chooseHub(player: Player): void {
        const counts = HUBS.map(() => 0);
        for (const [p, task] of SocialTask.regulars) if (p !== player && p.slot !== -1 && task.hubIndex >= 0) counts[task.hubIndex]++;
        const online = onlineN();
        const order = hubOrder(player.username).filter(i => mayGo(player, HUBS[i]!));
        let choice = order.find(i => counts[i]! < hubCap(HUBS[i]!, online));
        // (every hub at its cap, a big world with thin crowds: where it makes the smallest share of the crowd)
        const share = (i: number) => (counts[i]! + 1) / (counts[i]! + 1 + hubUsual(HUBS[i]!, online));
        if (choice === undefined) choice = [...order].sort((a, b) => share(a) - share(b))[0] ?? 0;
        this.hubIndex = choice;
        SocialTask.regulars.set(player, this);
        this.state = 'travel';
    }

    /**
     * port: its hub over its cap (as the crowds are known, a hub quieter than 2004's): the newest of its regulars moves,
     * to the first hub of its name's order with room, else to the one where it makes a share of the crowd smaller by
     * REBALANCE_GAIN; true when it goes
     */
    private _rebalance(player: Player): boolean {
        const here = this.hubIndex;
        const online = onlineN();
        const counts = HUBS.map(() => 0);
        let newest: SocialTask | null = null;
        for (const [p, task] of SocialTask.regulars) {
            if (p.slot === -1 || task.hubIndex < 0) continue;
            counts[task.hubIndex]++;
            if (task.hubIndex === here && task.state === 'stand' && (!newest || task.arrivedAt > newest.arrivedAt)) newest = task;
        }
        if (newest !== this || counts[here]! <= hubCap(HUBS[here]!, online)) return false;
        const share = (i: number, n: number) => n / (n + hubUsual(HUBS[i]!, online));
        const order = hubOrder(player.username).filter(i => i !== here && mayGo(player, HUBS[i]!));
        let to = order.find(i => counts[i]! < hubCap(HUBS[i]!, online));
        if (to === undefined) {
            const best = [...order].sort((a, b) => share(a, counts[a]! + 1) - share(b, counts[b]! + 1))[0];
            if (best !== undefined && share(best, counts[best]! + 1) < share(here, counts[here]!) - REBALANCE_GAIN) to = best;
        }
        if (to === undefined) return false;
        this._releaseTile();
        this.hubIndex = to;
        this.arrivedAt = 0;
        this.state = 'travel';
        return true;
    }

    /** port: the bots (not social) within CROWD_VIEW of the hub's middle now */
    private _crowdAt(hub: Hub): number {
        let n = 0;
        for (const p of playersNear(hub.x, hub.z, 0, CROWD_VIEW)) if (p.is_bot && p.botPlanner !== 'extras_social') n++;
        return n;
    }

    /** port: walked to its hub (upstream teleported to a hub's spawn tile), then onto a tile of its own */
    private handleTravel(player: Player, hub: Hub): void {
        if (!isNear(player, hub.x, hub.z, hub.radius + 4)) {
            this._stuckWalk(player, hub.spawnX, hub.spawnZ);
            this.cooldown = 2;
            return;
        }
        if (!this.tile) this.tile = this._claimTile(player, hub, hub.x, hub.z, hub.radius);
        this.state = 'stand';
        const now = World.currentTick;
        if (this.arrivedAt === 0) this.arrivedAt = now;
        if (this.nextRebalance < now) this.nextRebalance = now + randInt(REBALANCE_TICKS[0], REBALANCE_TICKS[1]);
        this.nextMove = now + randInt(MOVE_GAP[0], MOVE_GAP[1]);
        if (this.nextEmote < now) this.nextEmote = now + this._emoteGap(player);
        if (this.nextGreet < now) this.nextGreet = now + randInt(60, 300);
        this.near = new Set(playersNear(player.x, player.z, player.level, GREET_RANGE));
    }

    private handleStand(player: Player, hub: Hub): void {
        const now = World.currentTick;
        if (!isNear(player, hub.x, hub.z, hub.radius + 8)) {
            this.state = 'travel';
            return;
        }
        if (!this.tile) this.tile = this._claimTile(player, hub, hub.x, hub.z, hub.radius);
        const [tx, tz] = this.tile;
        if (player.x !== tx || player.z !== tz) {
            // (a tile it cannot step onto, an NPC on it: another, after a few tries)
            if (++this.tileTries > TILE_TRIES) {
                this._releaseTile();
                this.tile = this._claimTile(player, hub, player.x, player.z, MOVE_RADIUS, (tx << 14) | tz);
                this.tileTries = 0;
            } else if (!player.hasWaypoints()) {
                // (a step of a few tiles is searched at once, as a click is: port/BotPathing's level of detail would
                // keep a regular far from every human waiting for its turn)
                if (!stepToTile(player, tx, tz)) this.tileTries = TILE_TRIES;
            }
            this.cooldown = 2;
            return;
        }
        this.tileTries = 0;

        // port: a look at the next hub's crowd (a cap is a quarter of it), every CROWD_EVERY ticks
        if (now - crowdAt >= CROWD_EVERY) {
            crowdAt = now;
            const looked = HUBS[crowdNext++ % HUBS.length]!;
            const crowd = this._crowdAt(looked);
            const seen = crowdSeen.get(looked.key);
            // (the samples' mean at first, then a running average: a world that changes moves it)
            if (seen) {
                seen.n++;
                seen.avg += (crowd - seen.avg) * Math.max(CROWD_WEIGHT, 1 / seen.n);
            } else crowdSeen.set(looked.key, { avg: crowd, n: 1 });
        }

        // port: over its hub's cap (the crowds known): the newest regular there may move to another hub
        if (now >= this.nextRebalance) {
            this.nextRebalance = now + randInt(REBALANCE_TICKS[0], REBALANCE_TICKS[1]);
            if (this._rebalance(player)) return;
        }

        // a human to approach (upstream's job): not one it met this session, nor one approached lately
        const found = findNearbyRealPlayer(player, SCAN_RADIUS);
        if (found && !SocialTask.activePids.has(found.uid) && this._mayApproach(player, found)) {
            this._startApproach(player, found, now);
            return;
        }

        const near = playersNear(player.x, player.z, player.level, GREET_RANGE);
        if (now >= this.nextGreet) this._greetPasserBy(player, near, now);
        this.near = new Set(near);

        if (now >= this.nextMove) {
            this.nextMove = now + randInt(MOVE_GAP[0], MOVE_GAP[1]);
            this._releaseTile();
            // (another tile: with port/BotTiles' claims the nearest free one was its own, and a regular stood 46 minutes)
            this.tile = this._claimTile(player, hub, tx, tz, MOVE_RADIUS, (tx << 14) | tz);
        } else if (now >= this.nextEmote) {
            this.nextEmote = now + this._emoteGap(player);
            // (a wave mostly, a dance now and then: not while it is busy or talking)
            if (!isBusy(player) && !isAway(player) && !BotChat.midTalk(player)) everydayEmote(player, Math.random() < 0.6 ? 'wave' : 'dance');
        }
        this.cooldown = randInt(SCAN_TICKS[0], SCAN_TICKS[1]);
    }

    /** port: a passer-by new since its last scan, now and then: "hi", "yo kev" (a bot may answer) */
    private _greetPasserBy(player: Player, near: Player[], now: number): void {
        if (isBusy(player) || isAway(player) || BotChat.inConversation(player) || BotChat.midTalk(player)) return;
        // (variety round 2, S2-2: not over its share of its hub's talk: port/BotVoice)
        if (!voiceFree(player, now)) return;
        const persona = botPersona(player);
        let once = greetedThisLogin.get(player);
        if (!once) greetedThisLogin.set(player, (once = new WeakSet()));
        for (const other of near) {
            if (other === player || this.near.has(other) || other.slot === -1) continue;
            if (now - (this.greeted.get(other.username) ?? -Infinity) < GREET_AGAIN) continue;
            // (variety round 2, S2-2: a passer-by once a login of the regular)
            if (once.has(other)) continue;
            if (now - (SocialTask.lastGreeted.get(other.username) ?? -Infinity) < GREET_ANY) continue;
            // (not one busy at something: a fight, a trade, a window)
            if (other.target !== null || other.modalMain !== -1 || other.botTradeTargetPid !== -1) continue;
            this.nextGreet = now + Math.max(GREET_GAP_MIN, Math.round(logNormal(GREET_GAP_MEDIAN, GREET_GAP_SIGMA)));
            if (Math.random() >= GREET_CHANCE[0] + GREET_CHANCE[1] * persona.sociability) return;
            this.greeted.set(other.username, now);
            once.add(other);
            SocialTask.lastGreeted.set(other.username, now);
            if (SocialTask.lastGreeted.size > 4096) SocialTask.lastGreeted.clear();
            const line = this._greeting(player, other);
            if (line === null) return;
            botSay(player, line, undefined, 'social', other);
            // (one of its persona's lines: port/BotChatter's next comes after a quiet)
            countAsChatter(player);
            if (!other.is_bot) {
                // (spoken to the player first: its answer, without the bot's name, reaches the bot: BotChat's reply window)
                noteSpoke(player, 'social', now, other);
                return;
            }
            // a bot answers now and then ("hey", "sup")
            const theirs = botPersona(other);
            if (BotManager.botFor(other) !== null && !isAway(other) && !isBusy(other) && !BotChat.inConversation(other) && !BotChat.midTalk(other) && Math.random() < GREET_BACK[0] + GREET_BACK[1] * theirs.sociability) {
                const back = freshLine(other, GREET_PHRASES.slice(0, 7));
                if (back !== null) sayTyped(other, back, { to: player, kind: 'botreply' }, reactionTicks(theirs, 'notice'));
            }
            return;
        }
    }

    /**
     * port: "hi", or with the passer-by's name now and then ("hey kev", "hi Sim Human") where the filter leaves it whole;
     * a fresh one (port/BotLines' repetition registry: not one another bot said here lately), noted as said; null: none
     */
    private _greeting(player: Player, other: Player): string | null {
        const name = other.is_bot ? (Math.random() < GREET_NAMED_BOT ? nickOf(other) : null) : Math.random() < GREET_NAMED_HUMAN ? other.displayName : null;
        if (name) {
            const line = pickRandom(socialJson.regular.greetNamed).replaceAll('{name}', name);
            if (WordEnc.filter(line) === line && isFresh(player.username, line, player.x, player.z, player.level, World.currentTick)) {
                noteSaid(player, line);
                return line;
            }
        }
        return freshLine(player, socialJson.regular.greet);
    }

    private _emoteGap(player: Player): number {
        return Math.round(randInt(EMOTE_GAP[0], EMOTE_GAP[1]) * (1.6 - botPersona(player).sociability));
    }

    private _startApproach(player: Player, found: Player, now: number): void {
        approachLog.push({ t: now, human: found.username, bot: player.username });
        if (approachLog.length > LOG_MAX) approachLog.shift();
        this.target = found;
        this.chatPhase = 0;
        this.talkWait = 0;
        this.approachTicks = 0;
        SocialTask.activePids.add(found.uid);
        SocialTask.nextApproach.set(found.uid, now + randInt(testRates.approachGap[0], testRates.approachGap[1]));
        let met = SocialTask.met.get(player);
        if (!met) SocialTask.met.set(player, (met = new Set()));
        met.add(found.username);
        // its small talk: one or two lines, no line twice (upstream drew with replacement: "nice to meet u!" twice)
        this.talkCount = randInt(TALK_LINES[0], TALK_LINES[1]);
        // (variety round 1, S6: "this game is addictive ngl" from a meme persona only)
        const meme = botPersona(player).meme;
        // (variety round 2, S2-2: the first about what the human is, now and then; upstream's lines in the pool)
        const opener = approachOpener(found, meme);
        const rest = CHAT_LINES.filter(l => (meme || l !== MEME_CHAT_LINE) && l !== opener).sort(() => Math.random() - 0.5);
        this.talkLines = [opener, ...rest].slice(0, this.talkCount);
        this.answerUntil = -1;
        this.answered = false;
        this._releaseTile();
        this.state = 'approach';
    }

    private handleApproach(player: Player): void {
        const t = this.target;
        if (!t || t.is_bot || t.slot === -1) { this._resetTarget(); return; }
        if (chebyshev(player.x, player.z, t.x, t.z) > 45) { this._resetTarget(); return; }

        this.approachTicks++;
        if (this.approachTicks > 25) {
            // Player kept moving — give up so another bot can try.
            this._resetTarget();
            return;
        }

        if (!isNear(player, t.x, t.z, 2)) {
            this._stuckWalk(player, t.x + randInt(-1, 1), t.z + randInt(-1, 1));
            this.cooldown = 1;
            return;
        }

        // (variety round 1: a greeting the human heard lately, "heya sim human!" from three regulars, is drawn again: the
        // registry, W4; the last draw is said whatever it is)
        let hello = '';
        for (let i = 0; i < 6; i++) {
            const greet = pickRandom(GREET_PHRASES);
            hello = Math.random() < 0.5 ? `${greet} ${t.displayName}!` : greet;
            if (isFresh(player.username, hello, player.x, player.z, player.level, World.currentTick)) break;
        }
        noteSaid(player, hello);
        botSay(player, hello, undefined, 'social', t);
        countAsChatter(player);
        // port: spoken to the player first: its answer, without the bot's name, reaches the bot (BotChat's reply window)
        noteSpoke(player, 'social', World.currentTick, t);
        this.state     = 'chat';
        this.chatPhase = 0;
        this.cooldown  = randInt(5, 9);
    }

    private handleChat(player: Player): void {
        const t = this.target;
        if (!t || t.slot === -1 || chebyshev(player.x, player.z, t.x, t.z) > 25) { this._resetTarget(); return; }

        if (!isNear(player, t.x, t.z, 3)) {
            walkTo(player, t.x + randInt(-1, 1), t.z + randInt(-1, 1));
        }
        // port: the human talks with it (named it, answered it): the conversation runs before its small talk goes on
        if (BotChat.inConversation(player) && this.talkWait < TALK_WAIT) {
            this.talkWait++;
            // (variety round 2, S2-2: its question answered)
            if (this.answerUntil >= 0) this.answered = true;
            this.cooldown = randInt(5, 8);
            return;
        }
        const now = World.currentTick;
        // (variety round 2, S2-2: after a question it waits 15-25 s for the answer; answered, a word now and then)
        if (this.answerUntil >= 0) {
            if (!this.answered && now < this.answerUntil) {
                this.cooldown = randInt(4, 8);
                return;
            }
            const wasAnswered = this.answered;
            this.answerUntil = -1;
            if (wasAnswered && Math.random() < AFTER_WORD) {
                const word = freshLine(player, APPROACH.after ?? []);
                if (word !== null) botSay(player, word, undefined, 'social', t);
            }
            // (unanswered: never another question; a statement goes on, else it leaves)
            if (!wasAnswered) this.talkLines = this.talkLines.map((l, i) => (i >= this.chatPhase && isQuestionText(l) ? '' : l));
            this.answered = false;
        }

        this.chatPhase++;
        if (this.chatPhase <= this.talkCount && (this.talkLines[this.chatPhase - 1] !== '' || this.chatPhase === 1)) {
            // (variety round 1: a line of small talk another regular said here lately, or the human heard in the last 45
            // minutes, is not said again (the registry: "ur levels look decent" from three regulars in an hour, W4); another
            // fresh one, else none)
            // (variety round 2, S2-2: not over its share of its hub's talk)
            const planned = this.talkLines[this.chatPhase - 1];
            const line = !voiceFree(player, now) ? null : planned && isFresh(player.username, planned, player.x, player.z, player.level, now) ? planned : freshLine(player, CHAT_LINES.filter(l => (botPersona(player).meme || l !== MEME_CHAT_LINE) && !this.talkLines.includes(l)));
            if (line !== null) {
                if (line === planned) noteSaid(player, line, now);
                botSay(player, line, undefined, 'social', t);
                noteSpoke(player, 'social', now, t);
                // (variety round 2, S2-2: a question waits for its answer)
                if (isQuestionText(line)) this.answerUntil = now + randInt(ANSWER_WAIT[0], ANSWER_WAIT[1]);
            }
            this.cooldown = randInt(8, 16);
            return;
        }

        // port: about 1 approach in 5 a lure (at most one a human in 30 minutes); else a goodbye now and then, and no tour
        if (this._lureFits(player, t)) {
            this._startLure(player, t);
            return;
        }
        // (variety round 1: a goodbye another regular said here lately, or the human heard, is not said again: the registry)
        const bye = Math.random() < 0.5 ? freshLine(player, FAREWELL_PHRASES) : null;
        if (bye !== null) botSay(player, bye, undefined, 'social', t);
        this._resetTarget();
    }

    /** port: a lure now? About 1 approach in 5; the human free and outside the Wilderness, not lured in 30 minutes, and in reach (LURE_MAX_WILD) */
    private _lureFits(player: Player, t: Player): boolean {
        if (Math.random() >= testRates.lure) return false;
        if (World.currentTick < (SocialTask.nextLure.get(t.uid) ?? 0)) return false;
        if (wildernessLevelAt(t.x, t.z) > 0 || t.modalMain !== -1 || t.target !== null) return false;
        return lureDepth(player, t) <= LURE_MAX_WILD;
    }

    private _startLure(player: Player, t: Player): void {
        const now = World.currentTick;
        SocialTask.nextLure.set(t.uid, now + LURE_GAP);
        const form = pickRandom(LURE_FORM_KEYS);
        this.lureForm = LURE_FORMS[form]!;
        this.lureWild = lureDepth(player, t);
        // port (phase 5b): half the lures, while a PK team raids at the edge, lead to it
        const team = raidAtTheEdge();
        this.lureTeam = team && Math.random() < testRates.ambush ? team.run : null;
        this.ambushUntil = -1;
        lureLog.push({ t: now, form, ambush: this.lureTeam !== null, human: t.username, bot: player.username });
        if (lureLog.length > LOG_MAX) lureLog.shift();
        this.leadTicks = 0;
        this.leadCommentTick = 0;
        this.missedFollowChecks = 0;
        this.viaReached = false;
        this.wildernessPhase = 0;
        this.betrayed = false;
        this.leadStuck.reset();
        botSay(player, pickRandom(this.lureForm.pitch), undefined, 'social', t);
        noteSpoke(player, 'social', now, t);
        this.state = 'lure';
        this.cooldown = randInt(5, 8);
    }

    /**
     * The lure's lead (upstream's, its tour gone): to Edgeville through Barbarian Village, checking every 10 ticks that
     * the human follows (gone 4 checks: a goodbye), a lead line now and then, a pause when the human falls behind.
     */
    private handleLure(player: Player): void {
        const t    = this.target;
        const form = this.lureForm;
        if (!t || !form || t.slot === -1) { this._resetTarget(); return; }

        if (chebyshev(player.x, player.z, t.x, t.z) > 100) {
            botSay(player, pickRandom(FAREWELL_PHRASES), undefined, 'social', t);
            this._resetTarget();
            return;
        }

        this.leadTicks++;

        // port (phase 5b): to the waiting team (its leader's tile now), while the raid goes on; else upstream's Edgeville
        if (this.lureTeam) {
            const team = this.lureTeam.phase !== 'end' && this.lureTeam.phase !== 'done' ? raidAtTheEdge() : null;
            if (!team || team.run !== this.lureTeam) this.lureTeam = null;
            else return this.leadToTeam(player, t, form, team.x, team.z);
        }

        const [dx, dz] = LURE_DEST;
        if (isNear(player, dx, dz, LURE_RADIUS)) {
            botSay(player, pickRandom(LURE_ARRIVAL), undefined, 'social', t);
            this.wildernessPhase = 0;
            this.state    = 'wilderness_trap';
            this.cooldown = randInt(2, 4);
            return;
        }

        let navX = dx;
        let navZ = dz;
        if (!this.viaReached) {
            const [vx, vz] = LURE_VIA;
            if (isNear(player, vx, vz, 10)) {
                this.viaReached = true;
                this.leadStuck.reset();
            } else {
                navX = vx;
                navZ = vz;
            }
        }

        // Follower check every 10 ticks.
        const playerFollowing = chebyshev(player.x, player.z, t.x, t.z) <= FOLLOW_RADIUS;
        if (this.leadTicks % 10 === 0) {
            if (!playerFollowing) {
                this.missedFollowChecks++;
                if (this.missedFollowChecks >= MISS_LIMIT) {
                    botSay(player, pickRandom(FAREWELL_PHRASES), undefined, 'social', t);
                    this._resetTarget();
                    return;
                }
                botSay(player, pickRandom(WAIT_PHRASES), undefined, 'social', t);
            } else {
                this.missedFollowChecks = Math.max(0, this.missedFollowChecks - 1);
            }
        }

        // a lead line now and then
        this.leadCommentTick++;
        if (this.leadCommentTick >= randInt(22, 35)) {
            if (playerFollowing && Math.random() < 0.6) botSay(player, pickRandom(form.lead), undefined, 'social', t);
            this.leadCommentTick = 0;
        }

        // Pause if the player has fallen behind.
        if (!playerFollowing && this.missedFollowChecks >= 2) {
            this.cooldown = 3;
            return;
        }

        this._leadStuckWalk(player, navX, navZ);
        this.cooldown = 1;
    }

    /**
     * port (phase 5b, Track P): the lure's lead to a PK team raiding at the edge (lures may lead to a
     * waiting team): straight there (the walk graph's way), the same checks that the human follows; at the team, "lol get
     * him guys" and a laugh, a while watching, then back to its hub. The team fights under its own rules (274's PvP and
     * multi-combat, the raid's 3 a target); the lurer does not join the pile.
     */
    private leadToTeam(player: Player, t: Player, form: LureForm, x: number, z: number): void {
        const now = World.currentTick;
        if (this.ambushUntil >= 0) {
            if (now >= this.ambushUntil || chebyshev(player.x, player.z, t.x, t.z) > 40) this._resetTarget();
            else this.cooldown = 3;
            return;
        }
        if (chebyshev(player.x, player.z, x, z) <= AMBUSH_RADIUS) {
            botSay(player, pickRandom(AMBUSH_LINES), undefined, 'social', t);
            botEmote(player, 'laugh');
            this.ambushUntil = now + randInt(30, 70);
            this.cooldown = 2;
            return;
        }
        const following = chebyshev(player.x, player.z, t.x, t.z) <= FOLLOW_RADIUS;
        if (this.leadTicks % 10 === 0) {
            if (!following) {
                if (++this.missedFollowChecks >= MISS_LIMIT) {
                    botSay(player, pickRandom(FAREWELL_PHRASES), undefined, 'social', t);
                    this._resetTarget();
                    return;
                }
                botSay(player, pickRandom(WAIT_PHRASES), undefined, 'social', t);
            } else this.missedFollowChecks = Math.max(0, this.missedFollowChecks - 1);
        }
        if (++this.leadCommentTick >= randInt(22, 35)) {
            if (following && Math.random() < 0.6) botSay(player, pickRandom(form.lead), undefined, 'social', t);
            this.leadCommentTick = 0;
        }
        if (!following && this.missedFollowChecks >= 2) {
            this.cooldown = 3;
            return;
        }
        this._leadStuckWalk(player, x, z);
        this.cooldown = 1;
    }

    /**
     * Upstream's trap: past the Wilderness's edge north of Edgeville, the betrayal, and the attack once the human is in
     * there too. port: as deep as the combat levels' difference needs (the game's rule: within the lower of both players'
     * wilderness levels), and an attack only where the game allows it (upstream clicked whatever the levels).
     */
    private handleWildernessTrap(player: Player): void {
        const t = this.target;
        if (!t || t.slot === -1 || chebyshev(player.x, player.z, t.x, t.z) > 60) {
            this._resetTarget();
            return;
        }

        this.wildernessPhase++;

        const depthZ = 3520 + 8 * (this.lureWild - 1) + 3;
        const inWild = wildernessLevelAt(player.x, player.z) > 0;
        if (!inWild || player.z < depthZ - 1) {
            walkTo(player, LURE_DEST[0], depthZ);
            this.cooldown = 1;
            if (this.wildernessPhase > 40 + 2 * this.lureWild * 8) this._resetTarget();
            return;
        }

        if (!this.betrayed) {
            this.betrayed = true;
            botSay(player, pickRandom(BETRAY_PHRASES), undefined, 'social', t);
        }

        let attacking = false;
        if (wildernessLevelAt(t.x, t.z) > 0 && inCombatRange(pvpWildernessLevel(player, t), player.combatLevel, t.combatLevel)) {
            interactPlayerOp(player, t.slot, 2);
            attacking = true;
            this.cooldown = 3;
        } else {
            if (this.wildernessPhase % 10 === 0) botSay(player, DARE_PHRASE, undefined, 'social', t);
            this.cooldown = 2;
        }

        if (this.wildernessPhase > (attacking ? 110 : 50)) {
            if (wildernessLevelAt(t.x, t.z) > 0) botSay(player, pickRandom(FAREWELL_PHRASES), undefined, 'social', t);
            this._resetTarget();
        }
    }

    /** port: may this bot approach the human now (see handleStand)? */
    private _mayApproach(player: Player, human: Player): boolean {
        if (SocialTask.met.get(player)?.has(human.username)) return false;
        if (World.currentTick < (SocialTask.nextApproach.get(human.uid) ?? 0)) return false;
        if (human.modalMain !== -1 || human.target !== null) return false;
        return true;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * port: a tile of its own within `radius` of (x, z): port/BotTiles' (the crowds work's), else one walkable from the
     * hub's spawn that no other regular holds and nobody stands on (its own tile if none)
     */
    private _claimTile(player: Player, hub: Hub, x: number, z: number, radius: number, not = -1): [number, number] {
        // (never a vendor's stall tile: the Falador East and Draynor hubs hold some; a vendor coming later stood on the regular;
        // nor the tile it leaves: port/BotTiles gives the nearest free tile, and a bot's own counts as free)
        const claimed = claimStandTile(player, x, z, 0, radius, (tx, tz) => offStalls(tx, tz) && ((tx << 14) | tz) !== not);
        if (claimed && ((claimed[0] << 14) | claimed[1]) !== not) {
            this.tileClaimed = true;
            return claimed;
        }
        if (claimed) releaseStandTile(player);
        this.tileClaimed = false;
        const taken = new Set<number>([not]);
        for (const [p, task] of SocialTask.regulars) if (p !== player && task.tile) taken.add((task.tile[0] << 14) | task.tile[1]);
        for (const p of playersNear(x, z, 0, radius + 1)) if (p !== player) taken.add((p.x << 14) | p.z);
        const tiles = tilesInReach(0, hub.spawnX, hub.spawnZ, hub.radius * 3).filter(k => chebyshev(k >> 14, k & 0x3fff, x, z) <= radius && chebyshev(k >> 14, k & 0x3fff, hub.x, hub.z) <= hub.radius + 1 && !taken.has(k));
        if (tiles.length === 0) return [player.x, player.z];
        const k = tiles[Math.floor(Math.random() * tiles.length)]!;
        return [k >> 14, k & 0x3fff];
    }

    private _releaseTile(): void {
        if (this.tileClaimed && this.self) releaseStandTile(this.self);
        this.tileClaimed = false;
        this.tile = null;
    }

    // Separate StuckDetector for the lead with longer patience before escalating — we don't want to teleport mid-lure,
    // just recover naturally.
    private _leadStuckWalk(player: Player, tx: number, tz: number): void {
        if (!this.leadStuck.check(player, tx, tz)) { walkTo(player, tx, tz); return; }
        if (this.leadStuck.desperatelyStuck) { teleportNear(player, tx, tz); this.leadStuck.reset(); return; }
        walkTo(player, player.x + randInt(-5, 5), player.z + randInt(-5, 5));
    }

    /** port: the approach, the lure or the trap is over: back to its hub (walked), its tile claimed again there */
    private _resetTarget(): void {
        if (this.target) {
            SocialTask.activePids.delete(this.target.uid);
        }
        // port: the bot's own trade (upstream cleared the human's fields), if one was left
        if (this.self && this.self.botTradeTargetPid !== -1) clearTradeTarget(this.self);
        if (this.self && this.self.target !== null && this.state === 'wilderness_trap') this.self.clearInteraction();
        this.target             = null;
        this.lureForm           = null;
        this.approachTicks      = 0;
        this.chatPhase          = 0;
        this.talkWait           = 0;
        this.answerUntil        = -1;
        this.answered           = false;
        this.leadTicks          = 0;
        this.leadCommentTick    = 0;
        this.missedFollowChecks = 0;
        this.viaReached         = false;
        this.wildernessPhase    = 0;
        this.betrayed           = false;
        this.lureTeam           = null;
        this.ambushUntil        = -1;
        this.stuck.reset();
        this.leadStuck.reset();
        this.state    = 'travel';
        this.cooldown = randInt(5, 10);
    }

    private _stuckWalk(player: Player, tx: number, tz: number): void {
        if (!this.stuck.check(player, tx, tz)) { walkTo(player, tx, tz); return; }
        if (this.stuck.desperatelyStuck) { teleportNear(player, tx, tz); this.stuck.reset(); return; }
        walkTo(player, player.x + randInt(-6, 6), player.z + randInt(-6, 6));
    }
}

// ── port (the realism work, phase 5b, Track P): the fake Wilderness drop party ('fake_dp', a director's set piece) ──
//
// A lure called out to whoever is near, where the bots are: a social regular at Varrock West (its hub), or a bot at
// Edgeville's bank, says "drop party at lvl 3 wildy!!" 3-4 times over about 3 minutes, while Edgeville's PKers patrol the
// edge (it is planned only then); a bot near says "its a lure lol" now and then (at most twice). Talk only: whoever goes
// north meets the PKers under their own rules, and nothing else happens. Its calls and the crowd's words are a set
// piece's lines (kind 'setpiece', port/BotPieceLines), each in place of the speaker's next line.

/** where its callers stand: Varrock West's road (the social hub) and Edgeville's bank, and how far they look round */
const FAKE_DP_VENUES: readonly (SetPieceVenue & { radius: number; hub: string | null })[] = [
    { key: 'varrock_west', x: 3185, z: 3431, level: 0, say: 'varrock west', radius: 8, hub: 'varrock_west' },
    { key: 'edgeville', x: 3093, z: 3491, level: 0, say: 'edge', radius: 10, hub: null }
];
/** the calls: 3-4, this many ticks apart; the crowd's warnings: this chance a call, at most this many */
const FAKE_DP_CALLS: [number, number] = [3, 4];
const FAKE_DP_GAP: [number, number] = [40, 70];
const FAKE_DP_WARN = 0.35;
const FAKE_DP_WARN_MAX = 2;

/** the Edgeville PKers patrolling at the edge now (bots of that planner north of Edgeville's bank, levels 1-5) */
export function pkersAtTheEdge(): Player[] {
    const out: Player[] = [];
    for (const p of playersNear(3093, 3542, 0, 24)) if (p.is_bot && p.botPlanner === 'extras_edgeville_pker' && p.z >= 3520) out.push(p);
    return out;
}

/** a caller for it: a bot standing at the venue, free to talk, no friendlier than most (a lurer's kind) */
function fakeDpCallers(venue: (typeof FAKE_DP_VENUES)[number]): Player[] {
    const out: Player[] = [];
    for (const p of playersNear(venue.x, venue.z, venue.level, venue.radius)) {
        // (not one armed for a random event: its answer would wait behind the calls)
        if (!p.is_bot || p.staffModLevel > 0 || p.afkEventReady || isBusy(p) || isAway(p) || BotChat.inConversation(p) || BotChat.midTalk(p)) continue;
        const ai = BotManager.botFor(p);
        if (!ai || ai.hasSubTask() || eventRoleOf(p) !== null || botPersona(p).friendliness >= 0.3) continue;
        const social = p.botPlanner === 'extras_social';
        if (venue.hub ? !social : !social && (p.botPlanner === 'extras_vendor' || p.botPlanner === 'extras_pker' || p.botPlanner === 'extras_edgeville_pker')) continue;
        if (BotManager.sessionLeftOf(p.username) < 600) continue;
        out.push(p);
    }
    return out;
}

/** the caller's part: a sub-task, its calls in place, a warning from the crowd now and then */
export class FakeDpCallTask extends BotTask {
    readonly run: FakeDpRun;
    private calls = 0;
    private readonly max = randInt(FAKE_DP_CALLS[0], FAKE_DP_CALLS[1]);
    private next = World.currentTick + randInt(3, 15);
    private warned = 0;
    lastTick = World.currentTick;
    private done = false;
    /** where it calls from (x, z, level) */
    private at: [number, number, number] | null = null;

    constructor(run: FakeDpRun) {
        super('Callout');
        this.run = run;
    }

    shouldRun(_p: Player): boolean {
        return !this.done;
    }

    isComplete(_p: Player): boolean {
        return this.done;
    }

    finish(): void {
        this.done = true;
    }

    tick(player: Player): void {
        const now = World.currentTick;
        this.lastTick = now;
        if (this.run.phase === 'done' || this.calls >= this.max) {
            this.done = true;
            return;
        }
        // port (the variety work, round 1, track F): a caller drawn at the bank with its window open (its task's deposit)
        // closes it first, as the Party host does: with it open (BotChat.isBusy) it stood mute for its 6 minutes
        if (!this.at && player.modalMain !== -1) player.closeModal();
        // (moved off where it began: a random event's teleport, a death: the calls are over)
        this.at ??= [player.x, player.z, player.level];
        if (player.level !== this.at[2] || Math.max(Math.abs(player.x - this.at[0]), Math.abs(player.z - this.at[1])) > 10) {
            this.done = true;
            return;
        }
        if (now < this.next || player.hasWaypoints() || isBusy(player) || BotChat.inConversation(player) || BotChat.midTalk(player)) return;
        this.next = now + randInt(FAKE_DP_GAP[0], FAKE_DP_GAP[1]);
        if (sayPieceLine(player, 'fakedp', 'call', 'setpiece') === null) return;
        this.calls++;
        this.run.calls++;
        if (this.warned >= FAKE_DP_WARN_MAX || Math.random() >= FAKE_DP_WARN) return;
        const near = playersNear(player.x, player.z, player.level, 12).filter(p => p !== player && p.is_bot && !sameClique(p.username, player.username) && !isBusy(p) && !isAway(p) && !BotChat.inConversation(p));
        if (!near.length) return;
        const who = near[Math.floor(Math.random() * near.length)];
        const text = freshPieceText(who, 'fakedp', 'warn');
        if (text === null) return;
        this.warned++;
        const persona = botPersona(who);
        scheduleInTicks(reactionTicks(persona, 'notice') + typingTicks(persona, text), () => {
            if (who.slot !== -1 && !isBusy(who)) {
                sayPieceText(who, text, 'setpiece', { to: player });
                this.run.warnings++;
            }
        });
    }
}

export class FakeDpRun implements SetPieceRun {
    readonly id = nextSetPieceId();
    readonly kind = 'fake_dp' as const;
    readonly venue: SetPieceVenue;
    phase: SetPiecePhase = 'peak';
    readonly startedAt = World.currentTick;
    endsBy = World.currentTick + 600;
    readonly roles = new Map<Player, string>();
    readonly caller: Player;
    readonly task: FakeDpCallTask;
    calls = 0;
    warnings = 0;

    constructor(venue: SetPieceVenue, caller: Player) {
        this.venue = venue;
        this.caller = caller;
        this.task = new FakeDpCallTask(this);
        this.roles.set(caller, 'caller');
    }

    tick(now: number): void {
        if (this.phase === 'done') return;
        const ai = BotManager.botFor(this.caller);
        const gone = this.caller.slot === -1 || !ai || (now - this.task.lastTick > 60 && !this.task.isComplete(this.caller));
        if (gone || now >= this.endsBy || this.task.isComplete(this.caller)) this.abort(gone ? 'caller left' : 'done');
    }

    left(p: Player, _why: 'logout' | 'death' | 'fight' | 'stuck'): void {
        if (p === this.caller) this.abort('caller left');
    }

    rumour(): string | null {
        return this.phase === 'done' ? null : anyPieceLine('fakedp', 'rumour');
    }

    abort(_why: string): void {
        this.task.finish();
        this.phase = 'done';
        this.roles.clear();
    }
}

/** A fake drop party's plan: Edgeville's PKers at the edge, and a caller at Varrock West or Edgeville's bank (where more bots stand). */
export function planFakeDp(ctx: SetPieceContext): SetPiecePlan | null {
    if (pkersAtTheEdge().length === 0) return null;
    let best: { venue: SetPieceVenue; caller: Player; crowd: number } | null = null;
    for (const venue of FAKE_DP_VENUES) {
        const callers = fakeDpCallers(venue);
        if (!callers.length) continue;
        const crowd = playersNear(venue.x, venue.z, venue.level, 15).filter(p => p.is_bot).length;
        if (!best || crowd > best.crowd || (crowd === best.crowd && ctx.dice() < 0.5)) best = { venue, caller: callers[Math.floor(ctx.dice() * callers.length)], crowd };
    }
    if (!best) return null;
    return { kind: 'fake_dp', venue: best.venue, score: Math.min(1, best.crowd / 8), data: { caller: best.caller } };
}

export function startFakeDp(plan: SetPiecePlan, _ctx: SetPieceContext): FakeDpRun | null {
    const caller = (plan.data as { caller?: Player } | undefined)?.caller;
    const ai = caller ? BotManager.botFor(caller) : null;
    if (!caller || !ai || caller.slot === -1 || ai.hasSubTask()) return null;
    const run = new FakeDpRun(plan.venue, caller);
    // (it stops where it is and calls from there)
    caller.clearWaypoints();
    ai.setSubTask(run.task);
    return run;
}

export const FAKE_DP: SetPieceDef = {
    kind: 'fake_dp',
    weight: { members: 10, free: 10 },
    plan: ctx => planFakeDp(ctx),
    start: (plan, ctx) => startFakeDp(plan, ctx)
};
register(FAKE_DP);
