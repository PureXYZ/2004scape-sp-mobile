// port: random events on bots near the human (the realism work, phase 5a, Track E; "random events on
// bots near the human through the real scripts, including the game's own fail teleport in sight and XP lamps"; spec
// the research).
//
// 274 rolls a player's afkEventReady every 500 ticks (World.processClientsIn: 1/24, 1/12 for a player that stayed in one
// 21x21 square for 1,000 ticks), and the first script that reads it (afk_event: the general timer, a skill's loop, a
// spell) spends it and spawns an event. The bots' hook clears the engine's roll for every bot (BotManager.clearAfkEvents,
// BotPlayer.tick), so its Math.random never decides for a bot. This module arms chosen bots itself:
//   - who: every 500 ticks (274's cadence) the bots within 15 tiles of a human on its floor roll twice 274's odds (1/12,
//     1/6 after 1,000 ticks in one 21x21 square: an own tracker that mirrors Player.updateAfkZones; the bot's own is not
//     called, which would also give it 274's AFK tolerance of aggressive NPCs), BotManager's dice (Math.random, seeded in
//     the sims); not a bot crossing (a boat, the toll gate), trading, in a PK fight, a PKer, casting a teleport, on the
//     human's errand ("come here", "follow me"), leaving, or with an event of its own in the last 30 minutes; (phase
//     5b) nor one with a part in a set piece (port/BotSetPieces' roles: a clan walk, a PK team, a train, a party's host
//     or guest, a scam caller, a duellist);
//   - the cap: one event at a time near the humans (armed or under way), at least 5 minutes between two that started
//     near one; a winner of the roll is armed only while the cap allows (the roll's order);
//   - an armed bot keeps its flag (isArmed) until a script spends it: no forced timer, an idle bot meets it at its own
//     general timer (up to 5 minutes), a skiller at its next action, as in 274. Disarmed beyond 20 tiles from every
//     human, and before the engine's next roll (which would overwrite the flag: 499 ticks);
//   - what came of it (tickRandomEvents, after World.processPlayers ran the scripts): %macro_event and the NPC of
//     %macro_event_uid (the general events), an NPC whose npc_macro_event_target is the bot (the skills' hostile ones), a
//     handle in its hands (a lost axe or pickaxe head), the target it works turned into a gas rock, an ent, a big fish or
//     a whirlpool, the strange box, the mime's and the maze's zones; nothing (no room for the NPC, an area without events);
//   - the answers are port/RandomEventTask's, a sub-task (randomEventTaskFor): the genie, the old man, the dwarf and the
//     triffid after a person's moment (25 % ignored, 35 % at a gathering skill, every bot on an away break: the game's
//     fail teleport, in sight), the lamp, the box (never ignored), the mime, the maze (finished unseen), a tool head picked
//     up and fitted, a big fish's rod picked up, a gas rock or an ent left after a swing or three, the way down from where
//     the fail teleport put it; hostile ones are BotDefence's (fight or run), the drops of one it killed picked up;
//   - the moves the game makes (the fail teleport, the mime and the maze in and out) and the two unseen fallbacks are
//     marked real for the humanlike runner (BotAction.noteMove 'event'); a bot holds its logout while an event is under
//     way (holdsLogout: BotManager._busy); lines (port/BotChatter.noteEvent: random-event, lamp, fail-teleported,
//     axe-head; data/lines2004-events.json), and now and then a neighbour within 8 tiles says something (25 %).
// Cost: the zone tracker O(1) a bot a tick; the roll every 500 ticks over the bots near the humans; per tick only the
// armed bots and those with an event under way.
import World from '#/engine/World.js';
import Player from '#/engine/entity/Player.js';
import Npc from '#/engine/entity/Npc.js';
import Loc from '#/engine/entity/Loc.js';
import Obj from '#/engine/entity/Obj.js';
import { MoveSpeed } from '#/engine/entity/MoveSpeed.js';
import { NpcMode } from '#/engine/entity/NpcMode.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import NpcType from '#/cache/config/NpcType.js';
import LocType from '#/cache/config/LocType.js';
import ObjType from '#/cache/config/ObjType.js';
import InvType from '#/cache/config/InvType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import VarNpcType from '#/cache/config/VarNpcType.js';
import CategoryType from '#/cache/config/CategoryType.js';
import EnumType from '#/cache/config/EnumType.js';
import { CoordGrid } from '#/engine/CoordGrid.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { isCrossing, noteMove } from '#/engine/bot/BotAction.js';
import { inFightQuick } from '#/engine/bot/port/BotChat.js';
import { calm, countAsBudgetedLine, noteEvent } from '#/engine/bot/port/BotChatter.js';
import { contextOf, noteSaid, pickLine } from '#/engine/bot/port/BotLines.js';
import { personaOf } from '#/engine/bot/port/BotPersona.js';
import type { PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { botSay } from '#/engine/bot/port/BotSay.js';
import { scheduleInTicks } from '#/engine/bot/port/BotSchedule.js';
import { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';
import { noteSpoke } from '#/engine/bot/port/BotSpoke.js';
import { styleLine } from '#/engine/bot/port/BotStyle.js';
import { isCastHeld } from '#/engine/bot/port/BotTeleport.js';
import { tradeScreen } from '#/engine/bot/port/BotTradeScreen.js';
import { logNormal } from '#/engine/bot/port/BotTiming.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import type { BotTask } from '#/engine/bot/tasks/Index.js';
import { lampDone, RandomEventTask, responseDue } from '#/engine/bot/port/RandomEventTask.js';

// ── the defaults (the spec's "Random events" rows) ───────────────────────────

/** 274's AFK_EVENTRATE: a roll every 5 minutes */
export const ROLL_TICKS = 500;
/** twice 274's odds (AFK_CHANCE1 1/24, AFK_CHANCE2 1/12 for a player that stayed in its 21x21 squares 1,000 ticks) */
export const EVENT_ODDS = 1 / 12;
export const EVENT_ODDS_STILL = 1 / 6;
/** Player.updateAfkZones: a square of 21 around where it was, 1,000 ticks in it */
const AFK_SQUARE = 21;
const AFK_TICKS = 1000;
/** armed within the client's view of a human (15 tiles, its floor); disarmed beyond 20 */
export const ARM_DISTANCE = 15;
export const DISARM_DISTANCE = 20;
/** an armed flag lasts until the tick before the engine's next roll (World.processClientsIn's would overwrite it) */
function windowEnd(now: number): number {
    return (Math.floor(now / ROLL_TICKS) + 1) * ROLL_TICKS - 1;
}
/** at least 5 minutes between two events that start near a human; one at a time (armed or under way) */
export const EVENT_GAP_TICKS = 500;
/** a bot has one at most every 30 minutes */
export const BOT_GAP_TICKS = 3000;
/** an event under way counts against the cap for this long at most (a box left for a long break, a mime's fallback) */
const ACTIVE_CAP_TICKS = 1000;
/** NPC events ignored: 25 %, 35 % at a gathering skill (and every bot on an away break: it never answers) */
export const IGNORE_SHARE = 0.25;
export const IGNORE_SHARE_GATHERING = 0.35;
/** a person's moment before answering an NPC event: 3-25 s by persona (ticks); a third first let the first warning pass */
const REACTION_TICKS: [number, number] = [5, 42];
const WAIT_FOR_WARNING_SHARE = 1 / 3;
/** the hazards (a gas rock, an ent, a whirlpool) noticed this often; a noticed one is left after a swing or three */
export const NOTICE_GAS = 0.8;
export const NOTICE_ENT = 0.85;
export const NOTICE_WHIRLPOOL = 0.9;
const NOTICE_TICKS: [number, number] = [4, 12];
/** a neighbour within 8 tiles says something about another's event this often (3-10 s later) */
const NEIGHBOUR_DISTANCE = 8;
const NEIGHBOUR_CHANCE = 0.25;
const NEIGHBOUR_DELAY: [number, number] = [5, 17];
/** one neighbour's line per 64-tile map square at most this often, and a bot's at most this often */
const NEIGHBOUR_AREA_TICKS = 1500;
const NEIGHBOUR_BOT_TICKS = 3000;
/** a classification waits this long for its evidence (the box comes after the old man's two delays) */
const CLASSIFY_TICKS = 6;
/** a bot with no event under way is looked at for strays (a box or a lamp after a login, the mime's or maze's zone) this often */
const STRAY_CHECK_TICKS = 50;

/** what came of a spent flag */
export type EventKind =
    | 'genie'
    | 'oldman'
    | 'dwarf'
    | 'triffid'
    | 'swarm'
    | 'box'
    | 'mime'
    | 'maze'
    | 'golem'
    | 'dryad'
    | 'troll'
    | 'zombie'
    | 'shade'
    | 'watchman'
    | 'ent'
    | 'bigfish'
    | 'whirlpool'
    | 'gas'
    | 'gaschest'
    | 'lostaxe'
    | 'lostpickaxe'
    | 'none';

/** the NPC events a bot answers by talking or picking (RE6: answered or not) */
export const NPC_EVENTS: ReadonlySet<EventKind> = new Set<EventKind>(['genie', 'oldman', 'dwarf', 'triffid']);
/** the hostile ones (BotDefence answers them: fight or run) */
const HOSTILE_EVENTS: ReadonlySet<EventKind> = new Set<EventKind>(['swarm', 'golem', 'dryad', 'troll', 'zombie', 'shade', 'watchman']);

/** What the module tells its listeners (the humanlike runner, the tests). */
export interface RandomEventNote {
    type:
        | 'armed' // a bot near a human won the roll
        | 'disarmed' // its flag went unspent: `reason` far | expired | offline
        | 'start' // a script spent the flag: `kind` (none: nothing spawned), `humanDist` from the nearest human then
        | 'answered' // an NPC event answered (talked to, the triffid's fruit picked)
        | 'ignored' // an NPC event the bot let pass (the fail teleport, the dwarf's stones or the triffid follow)
        | 'lamp-got'
        | 'lamp-rubbed' // `stat`, `xp` gained
        | 'box-solved' // a strange box solved (`wrong`: a wrong answer before it)
        | 'move' // a move the game made or an unseen fallback: `move` fail | mime-in | mime-out | maze-in | maze-out | fallback
        | 'dropped' // a tool head or a rod of the bot's on the ground: `obj`
        | 'picked' // ... picked up
        | 'recovered' // back on the ground after a fail teleport (`ticks`), or the unseen fallback (`fallback`)
        | 'end'; // the event is over
    bot: Player;
    name: string;
    tick: number;
    kind?: EventKind;
    humanDist?: number;
    reason?: string;
    move?: 'fail' | 'mime-in' | 'mime-out' | 'maze-in' | 'maze-out' | 'fallback';
    from?: [number, number, number];
    to?: [number, number, number];
    obj?: Obj;
    stat?: string;
    xp?: number;
    /** the stat's level when the lamp was rubbed (its XP is 10 × it) */
    level?: number;
    ticks?: number;
    fallback?: boolean;
    wrong?: number;
}

/** the runner and the tests subscribe here (as to BotSay.sayListeners) */
export const randomEventListeners: ((note: RandomEventNote) => void)[] = [];

function tell(note: Omit<RandomEventNote, 'name' | 'tick'> & { tick?: number }): void {
    if (!randomEventListeners.length) return;
    const full = { ...note, name: note.bot.username, tick: note.tick ?? World.currentTick } as RandomEventNote;
    for (const listener of randomEventListeners) {
        try {
            listener(full);
        } catch {
            // a listener's fault never reaches the world
        }
    }
}

// ── the state ────────────────────────────────────────────────────────────────

/** an event under way on a bot */
export interface ActiveEvent {
    kind: EventKind | 'pending';
    /** the tick its flag was spent */
    start: number;
    /** within the cap's reach: armed near a human (it counts against the cap and for RE1) */
    near: boolean;
    humanDist: number;
    /** where it was when the flag was spent */
    from: [number, number, number];
    /** its NPC (the genie, the plant, the golem, the ent ...), as found */
    npc: Npc | null;
    /** an NPC event the bot lets pass, decided at the start */
    ignore: boolean;
    /** when it answers (an NPC event), when it notices (a hazard): a tick, -1 never */
    answerAt: number;
    answered: boolean;
    /** the NPC's warnings seen so far (its varn npc_int) */
    warnings: number;
    /** the fail teleport came (a genie or the old man not answered) */
    teleported: boolean;
    /** a hazard the bot stopped working */
    left: boolean;
    endedAt: number;
}

/** a tool head or a rod of the bot's on the ground (private to it for 100 ticks) */
export interface Drop {
    obj: Obj;
    at: number;
    /** when the bot goes for it (5-20 s after it landed) */
    pickAt: number;
    kind: 'head' | 'rod';
    /** the handle was in its hands (worn): it wears the tool again once fitted */
    worn: boolean;
}

/** the way back from where the fail teleport put it */
export interface FailRecovery {
    at: number;
    from: [number, number, number];
    to: [number, number, number];
    /** it stands a moment first (3-8 s) */
    pauseUntil: number;
    lastClimb: number;
    climbs: number;
    /** the last try of the unseen fallback (every 10 ticks after FAIL_FALLBACK_TICKS; the stairs meanwhile) */
    lastJump: number;
}

export interface EventState {
    /** the 21x21 squares (Player.updateAfkZones, mirrored): packed coords and the ticks in them */
    zone0: number;
    zone1: number;
    afkTicks: number;
    /** where it stood last tick (an event's moves) */
    lastX: number;
    lastZ: number;
    lastLevel: number;
    ev: ActiveEvent | null;
    /** the lamp: first seen, when it rubs it; the box: first seen, when it opens it */
    lampSeen: number;
    lampAt: number;
    boxSeen: number;
    boxAt: number;
    boxWrong: number;
    drops: Drop[];
    fail: FailRecovery | null;
    /** in the mime's or the maze's zone since, its unseen finish due at */
    zoneSince: number;
    zoneKind: 'mime' | 'maze' | null;
    zoneDoneAt: number;
    /** the hazards it noticed: a gas rock's, a whirlpool's NPC's or an ent's id and until when (port/BotRandomEvents.isEventHazard) */
    hazards: Map<string, { until: number; noticed: boolean }>;
    /** the drops of a hostile event NPC it fought, to pick up once it is dead */
    loot: { x: number; z: number; level: number; until: number } | null;
    task: RandomEventTask | null;
    /** the last stray check */
    strayCheck: number;
    // the answer's own clock (port/RandomEventTask): its next click, its last, a page its click opened (until), the lamp's
    // skill and its XP before, a handle it took off to wear the fitted tool again, the mime's window it looked at
    actAt: number;
    clickAt: number;
    pageUntil: number;
    dropTries: number;
    lampSkill: string | null;
    lampStat: number;
    lampXp: number;
    lampLevel: number;
    lampTries: number;
    rewield: boolean;
    mimeSeen: number;
}

const states = new WeakMap<Player, EventState>();
/** the bots armed now, and the tick their flag goes (the tick before the engine's next roll, which would overwrite it) */
const armed = new Map<Player, number>();
/**
 * a winner of the roll the cap held back (an event under way, or the last start under 5 minutes ago): armed as soon as
 * the cap allows, within its roll's window (a won roll is not lost to the gap: one event a roll at most, as 274's cadence)
 */
let pending: { player: Player; until: number } | null = null;
/** the bots with an event, a response or a recovery under way (the per-tick work) */
const active = new Set<Player>();
/** when each bot (by name, over logins) last had an event */
const lastEventOf = new Map<string, number>();
/** when the last event near a human started */
let lastNearStart = -Infinity;
/** a neighbour's line: per map square, per bot */
const neighbourAreaAt = new Map<string, number>();
const neighbourBotAt = new Map<string, number>();

/** (tests) the dice and the rates: odds × `odds`, the gaps (ticks), the ignore share */
const rates = { odds: 1, gap: EVENT_GAP_TICKS, botGap: BOT_GAP_TICKS, ignore: -1 as number, neighbour: NEIGHBOUR_CHANCE, rollEvery: ROLL_TICKS };
let dice: () => number = () => Math.random();

export function setEventRatesForTest(r: Partial<{ odds: number; gap: number; botGap: number; ignore: number; neighbour: number; rollEvery: number; dice: () => number }>): void {
    if (r.rollEvery !== undefined) rates.rollEvery = r.rollEvery;
    if (r.odds !== undefined) rates.odds = r.odds;
    if (r.gap !== undefined) rates.gap = r.gap;
    if (r.botGap !== undefined) rates.botGap = r.botGap;
    if (r.ignore !== undefined) rates.ignore = r.ignore;
    if (r.neighbour !== undefined) rates.neighbour = r.neighbour;
    if (r.dice) dice = r.dice;
}

/** (tests) forget everything: the armed, the events, the cap's clock */
export function resetRandomEventsForTest(): void {
    armed.clear();
    pending = null;
    active.clear();
    lastEventOf.clear();
    lastNearStart = -Infinity;
    neighbourAreaAt.clear();
    neighbourBotAt.clear();
}

function stateOf(player: Player): EventState {
    let st = states.get(player);
    if (!st) {
        st = {
            zone0: -1,
            zone1: -1,
            afkTicks: 0,
            lastX: player.x,
            lastZ: player.z,
            lastLevel: player.level,
            ev: null,
            lampSeen: -1,
            lampAt: -1,
            boxSeen: -1,
            boxAt: -1,
            boxWrong: 0,
            drops: [],
            fail: null,
            zoneSince: -1,
            zoneKind: null,
            zoneDoneAt: -1,
            hazards: new Map(),
            loot: null,
            task: null,
            strayCheck: -1,
            actAt: -1,
            clickAt: -100,
            pageUntil: -1,
            dropTries: 0,
            lampSkill: null,
            lampStat: -1,
            lampXp: 0,
            lampLevel: 0,
            lampTries: 0,
            rewield: false,
            mimeSeen: -1
        };
        states.set(player, st);
    }
    return st;
}

/** (tests, the response) the bot's event state, or null */
export function eventStateOf(player: Player): EventState | null {
    return states.get(player) ?? null;
}

// ── content names (resolved once the packs are loaded) ───────────────────────

let names: {
    varEvent: number;
    varUid: number;
    varTargetCoord: number;
    varXplamp: number;
    varnTarget: number;
    varnInt: number;
    catGas: number;
    catEnt: number;
    lamp: number;
    cube: number;
    axeHandle: number;
    pickHandle: number;
    triffidFruit: number;
    heads: Set<number>;
    rods: Set<number>;
    chestGas: number;
} | null = null;

function content() {
    if (names) return names;
    const obj = (n: string) => ObjType.getId(n);
    const heads = new Set<number>();
    // (by name, each checked by test/content-names.test: 274 has no black pickaxe)
    for (const n of [
        'macro_bronze_pickaxehead', 'macro_iron_pickaxehead', 'macro_steel_pickaxehead', 'macro_mithril_pickaxehead', 'macro_adamant_pickaxehead', 'macro_rune_pickaxehead',
        'macro_bronze_hatchethead', 'macro_iron_hatchethead', 'macro_steel_hatchethead', 'macro_black_hatchethead', 'macro_mithril_hatchethead', 'macro_adamant_hatchethead', 'macro_rune_hatchethead'
    ]) {
        const id = obj(n);
        if (id !== -1) heads.add(id);
    }
    const rods = new Set<number>();
    for (const n of ['fishing_rod', 'fly_fishing_rod', 'net', 'big_net', 'harpoon', 'lobster_pot']) {
        const id = obj(n);
        if (id !== -1) rods.add(id);
    }
    names = {
        varEvent: VarPlayerType.getId('macro_event'),
        varUid: VarPlayerType.getId('macro_event_uid'),
        varTargetCoord: VarPlayerType.getId('macro_event_target_coord'),
        varXplamp: VarPlayerType.getId('xplamp'),
        varnTarget: VarNpcType.getId('npc_macro_event_target'),
        varnInt: VarNpcType.getId('npc_int'),
        catGas: CategoryType.getId('mining_rock_macro_gas'),
        catEnt: CategoryType.getId('macro_event_ent'),
        lamp: obj('macro_genilamp'),
        cube: obj('macro_cube'),
        axeHandle: obj('macro_hatchethandle'),
        pickHandle: obj('macro_pickaxehandle'),
        triffidFruit: obj('macro_triffidfruit'),
        heads,
        rods,
        chestGas: LocType.getId('chest_macro_gas')
    };
    return names;
}

/** (the response) the content ids it needs */
export function eventContent() {
    return content();
}

/** a player variable (0 when the game has none of that name) */
export function varp(player: Player, id: number): number {
    if (id === -1) return 0;
    const v = player.getVar(id);
    return typeof v === 'number' ? v : 0;
}

function varn(npc: Npc, id: number): number {
    if (id === -1) return -1;
    const v = npc.getVar(id);
    return typeof v === 'number' ? v : -1;
}

/** the NPC's varn npc_int (the genie's and old man's warnings, the plant's readiness, the mime's emote) */
export function npcInt(npc: Npc): number {
    return varn(npc, content().varnInt);
}

/** the NPC's player (its npc_macro_event_target) is this bot (a script's int is signed: a uid over 2^31 reads negative) */
export function eventNpcOf(npc: Npc, player: Player): boolean {
    return (varn(npc, content().varnTarget) | 0) === (player.uid | 0) && player.uid !== -1;
}

// ── zones (274's mime and maze areas) ────────────────────────────────────────

/** the mime's and the maze's map squares' origins (their [mapzone] scripts' squares) */
const ZONE_ORIGIN: Readonly<Record<'mime' | 'maze', [number, number]>> = { mime: [31 << 6, 74 << 6], maze: [45 << 6, 71 << 6] };

/** the mime's stage (map square 31_74) and the maze (45_71) */
export function inMimeZone(x: number, z: number, level: number): boolean {
    return level === 0 && x >> 6 === 31 && z >> 6 === 74;
}
export function inMazeZone(x: number, z: number, level: number): boolean {
    return level === 0 && x >> 6 === 45 && z >> 6 === 71;
}

// ── the fail teleport's spots ────────────────────────────────────────────────

/**
 * The fail teleport's spots (274's macro_event_fail_teleports_free and _members enums: 24 and 23, 36 distinct) and the
 * way to the ground from each, found by test/randomevents.test.mjs's walk from every one (climbNearby with a radius of
 * 15 reaches the ground from all of them): 'ground' (it is on the ground already), 'down' (stairs or ladders down, the
 * floors), 'up' (a basement's ladder). `exit` is where the way comes out: the unseen fallback's landing.
 */
export const FAIL_TELEPORT_EXITS: Readonly<Record<string, { way: 'ground' | 'down' | 'up'; floors: number; exit: [number, number] }>> = {
    '1_3278_3500': { way: 'down', floors: 1, exit: [3285, 3496] }, // Jolly Boar Inn
    '1_3097_3268': { way: 'down', floors: 1, exit: [3098, 3266] }, // Morgan's house, Draynor
    '2_2954_3388': { way: 'down', floors: 2, exit: [2955, 3389] }, // Falador general store's tower
    '3_3221_3474': { way: 'down', floors: 3, exit: [3212, 3472] }, // Varrock palace, the south-east tower
    '1_3229_3223': { way: 'down', floors: 1, exit: [3229, 3223] }, // Lumbridge castle, the north gate tower
    '0_3097_9567': { way: 'up', floors: 1, exit: [3105, 3162] }, // the Wizards' Tower's basement
    '2_3287_3190': { way: 'down', floors: 2, exit: [3286, 3191] }, // Zeke's, the top floor
    '1_2964_3213': { way: 'down', floors: 1, exit: [2964, 3215] }, // Rimmington, the north-east house
    '0_2968_3335': { way: 'ground', floors: 0, exit: [2968, 3335] }, // Falador castle
    '0_2935_3515': { way: 'ground', floors: 0, exit: [2935, 3515] }, // the Asgarnian Chaos Temple
    '0_3212_3423': { way: 'ground', floors: 0, exit: [3212, 3423] }, // Varrock fountain
    '0_3076_3412': { way: 'ground', floors: 0, exit: [3076, 3412] }, // Barbarian Village
    '0_2996_3145': { way: 'ground', floors: 0, exit: [2996, 3145] }, // Thurgo
    '1_3025_3251': { way: 'down', floors: 1, exit: [3025, 3248] }, // Port Sarim, above Brian's
    '1_2975_3382': { way: 'down', floors: 1, exit: [2972, 3384] }, // Falador's shield shop
    '1_3214_3215': { way: 'down', floors: 1, exit: [3205, 3209] }, // Lumbridge castle's spinning wheel room
    '1_3112_3157': { way: 'down', floors: 1, exit: [3105, 3160] }, // the Wizards' Tower
    '0_3246_3451': { way: 'ground', floors: 0, exit: [3246, 3451] }, // Varrock museum
    '0_3283_3218': { way: 'ground', floors: 0, exit: [3283, 3218] }, // north Al Kharid, the gem stall
    '0_3045_3491': { way: 'ground', floors: 0, exit: [3045, 3491] }, // the monastery
    '0_3083_3469': { way: 'ground', floors: 0, exit: [3083, 3469] }, // Edgeville
    '2_3104_3163': { way: 'down', floors: 2, exit: [3105, 3160] }, // the Wizards' Tower, near Mizgog
    '0_3218_9618': { way: 'up', floors: 1, exit: [3209, 3217] }, // Lumbridge castle's basement
    '0_3263_3424': { way: 'ground', floors: 0, exit: [3263, 3424] }, // Varrock east bank
    '1_2519_3426': { way: 'down', floors: 1, exit: [2516, 3423] }, // the Tourist Information Centre
    '2_2700_3403': { way: 'down', floors: 2, exit: [2702, 3408] }, // Thormac's tower
    '1_2536_3076': { way: 'down', floors: 1, exit: [2537, 3088] }, // Yanille, the south-west walls
    '0_2434_3346': { way: 'ground', floors: 0, exit: [2434, 3346] }, // the Outpost
    '0_2787_3515': { way: 'ground', floors: 0, exit: [2787, 3515] }, // Camelot, outside the topiary
    '1_2616_3292': { way: 'down', floors: 1, exit: [2622, 3293] }, // East Ardougne, above the general store
    '1_2898_3423': { way: 'down', floors: 1, exit: [2897, 3428] }, // Taverley, next to Sanfew
    '1_2708_3472': { way: 'down', floors: 1, exit: [2714, 3470] }, // Seers' Village, near the spinning wheel
    '0_2663_3111': { way: 'ground', floors: 0, exit: [2663, 3111] }, // the second bridge to Hazelmere
    '1_2651_3163': { way: 'down', floors: 1, exit: [2651, 3165] }, // Port Khazard, above the anvil
    '0_2772_3235': { way: 'ground', floors: 0, exit: [2772, 3235] }, // Brimhaven, the north dock
    '1_2613_3208': { way: 'down', floors: 1, exit: [2617, 3207] } // the Ardougne monastery's east tower
};

/** the fail teleport's spots on this world (members or free), as 274's enum lists them: `${level}_${x}_${z}` */
export function failTeleportSpots(members: boolean = isMembersWorld()): string[] {
    const e = EnumType.getByName(members ? 'macro_event_fail_teleports_members' : 'macro_event_fail_teleports_free');
    if (!e) return [];
    const out: string[] = [];
    for (const v of e.values.values()) {
        if (typeof v !== 'number') continue;
        const c = CoordGrid.unpackCoord(v);
        out.push(`${c.level}_${c.x}_${c.z}`);
    }
    return out;
}

/** the table's entry for a landing (within 3 tiles of a spot on its floor), or null */
export function failExitFor(x: number, z: number, level: number): { way: 'ground' | 'down' | 'up'; floors: number; exit: [number, number] } | null {
    const exact = FAIL_TELEPORT_EXITS[`${level}_${x}_${z}`];
    if (exact) return exact;
    for (const [key, exit] of Object.entries(FAIL_TELEPORT_EXITS)) {
        const [l, sx, sz] = key.split('_').map(Number);
        if (l === level && Math.max(Math.abs(sx - x), Math.abs(sz - z)) <= 3) return exit;
    }
    return null;
}

// ── people near ──────────────────────────────────────────────────────────────

/** the nearest human (not a bot) on the bot's floor: Chebyshev tiles, Infinity for none */
export function humanDistance(x: number, z: number, level: number): number {
    let best = Infinity;
    for (const p of World.playerLoop.all()) {
        if (p.is_bot === true || p.level !== level) continue;
        const d = Math.max(Math.abs(p.x - x), Math.abs(p.z - z));
        if (d < best) best = d;
    }
    return best;
}

/** the name of the bot's sub-task (its BotPlayer's), or null */
export function subTaskName(player: Player): string | null {
    const ai = BotManager.botFor(player) as unknown as { subTask?: { name?: string } | null } | null;
    return ai?.subTask?.name ?? null;
}

const GATHERING = new Set(['Woodcut', 'Mine', 'Fish', 'Pick Flax', 'Thieve']);

/** the kind of the bot's main task ('Woodcut', 'Mine' ...), or 'none' */
export function taskKindOf(player: Player): string {
    return (BotManager.botFor(player)?.currentTask?.name ?? 'none').split(':')[0];
}

// ── the tick ─────────────────────────────────────────────────────────────────

/** BotManager.tick (with a human in the world), before the bots' turns: the zones, what came of armed flags, events under way, the roll. */
export function tickRandomEvents(): void {
    const now = World.currentTick;
    trackZones();
    for (const [player, until] of [...armed]) checkArmed(player, until, now);
    if (pending) armPending(now);
    for (const player of [...active]) {
        try {
            progress(player, now);
        } catch (err) {
            active.delete(player);
            throw err;
        }
    }
    if (now % rates.rollEvery === 0) roll(now);
}

/** Does this bot keep 274's afkEventReady (BotManager.clearAfkEvents, BotPlayer.tick)? Only while armed. */
export function isArmed(player: Player): boolean {
    return armed.has(player);
}

/** 274's updateAfkZones for every bot, mirrored (O(1) each): the ticks it has stayed in its two 21x21 squares */
function trackZones(): void {
    for (const player of BotManager.activeBots()) {
        const st = stateOf(player);
        st.afkTicks = Math.min(AFK_TICKS, st.afkTicks + 1);
        if (withinZone(st.zone0, player) || withinZone(st.zone1, player)) continue;
        const coord = CoordGrid.packCoord(0, player.x - 10, player.z - 10);
        st.zone1 = player.moveSpeed === MoveSpeed.INSTANT && player.jump ? coord : st.zone0;
        st.zone0 = coord;
        st.afkTicks = 0;
    }
}

function withinZone(coord: number, player: Player): boolean {
    if (coord === -1) return false;
    const c = CoordGrid.unpackCoord(coord);
    return player.x >= c.x && player.x < c.x + AFK_SQUARE && player.z >= c.z && player.z < c.z + AFK_SQUARE;
}

/** (tests) the bot has stayed in its squares the 1,000 ticks that double 274's odds */
export function zonesAfk(player: Player): boolean {
    return (states.get(player)?.afkTicks ?? 0) >= AFK_TICKS;
}

// ── the roll ─────────────────────────────────────────────────────────────────

/** one event at a time near the humans (armed or under way), and the gap since the last start near one */
function capAllows(now: number): boolean {
    if (armed.size > 0) return false;
    if (now - lastNearStart < rates.gap) return false;
    for (const player of active) {
        const ev = states.get(player)?.ev;
        if (ev && ev.near && ev.endedAt < 0 && now - ev.start < ACTIVE_CAP_TICKS) return false;
    }
    return true;
}

/** may this bot be armed now? (the spec's eligibility) */
export function eligible(player: Player, now: number = World.currentTick): boolean {
    return ineligible(player, now) === null;
}

/** why this bot may not be armed now, or null */
function ineligible(player: Player, now: number): string | null {
    if (player.slot === -1 || player.levels[PlayerStat.HITPOINTS] <= 0) return 'dead';
    const ai = BotManager.botFor(player);
    if (!ai) return 'offline';
    if (varp(player, content().varEvent) !== 0) return 'event';
    const planner = player.botPlanner as PlannerKey;
    if (planner === 'extras_pker' || planner === 'extras_edgeville_pker') return 'pker';
    if (isCrossing(player) || isCastHeld(player)) return 'crossing';
    if (player.botTradeTargetPid !== -1 || tradeScreen(player) !== null) return 'trade';
    if (inFightQuick(player) && player.target instanceof Player) return 'pvp';
    if (player.botComeHereReturnX !== -1) return 'errand';
    const sub = subTaskName(player);
    if (sub === 'ComeHere' || sub === 'Follow' || sub === 'Bank') return 'errand';
    // (phase 5b: a part in a set piece holds it as an errand does: a clan walk's line, a train's newbie, a PK team, a
    // party's host or guest, a scam caller, a duellist; an event's answer would wait behind its part's sub-task, an ignored
    // one the game's fail teleport would move it mid-piece)
    if (eventRoleOf(player) !== null) return 'setpiece';
    const last = lastEventOf.get(player.username);
    if (last !== undefined && now - last < rates.botGap) return 'recent';
    const st = states.get(player);
    if (st && (st.ev?.endedAt === -1 || st.fail || st.zoneKind)) return 'busy';
    return null;
}

/** (tests, the runner) the rolls so far: bots near a human, eligible, winners of the dice, armed; why the rest were not */
export const rollStats = { rolls: 0, candidates: 0, eligible: 0, still: 0, won: 0, armed: 0, capped: 0, deferred: 0, why: {} as Record<string, number> };

/**
 * Every ROLL_TICKS: the bots within ARM_DISTANCE of a human roll twice 274's odds (1/6 for one that stayed in its 21x21
 * squares); of the winners, in the roll's order, one is armed while the cap allows (the first the cap holds back
 * waits for it within the roll's window: armPending).
 */
function roll(now: number): void {
    rollStats.rolls++;
    const seen = new Set<Player>();
    const candidates: Player[] = [];
    for (const human of World.playerLoop.all()) {
        if (human.is_bot === true) continue;
        for (const bot of BotManager.activeBots()) {
            if (seen.has(bot) || bot.level !== human.level) continue;
            if (Math.max(Math.abs(bot.x - human.x), Math.abs(bot.z - human.z)) > ARM_DISTANCE) continue;
            seen.add(bot);
            candidates.push(bot);
        }
    }
    rollStats.candidates += candidates.length;
    for (const bot of candidates) {
        const why = ineligible(bot, now);
        if (why) {
            rollStats.why[why] = (rollStats.why[why] ?? 0) + 1;
            continue;
        }
        rollStats.eligible++;
        if (zonesAfk(bot)) rollStats.still++;
        const odds = (zonesAfk(bot) ? EVENT_ODDS_STILL : EVENT_ODDS) * rates.odds;
        if (dice() >= odds) continue;
        rollStats.won++;
        if (!capAllows(now)) {
            // (the first winner the cap holds back waits for it, within this roll's window; the rest lose their turn)
            if (!pending && armed.size === 0) {
                pending = { player: bot, until: windowEnd(now) };
                rollStats.deferred++;
            } else rollStats.capped++;
            continue;
        }
        rollStats.armed++;
        arm(bot, now);
    }
}

/** the held-back winner: armed once the cap allows (still eligible, within 20 tiles of a human), or its window is over */
function armPending(now: number): void {
    const p = pending!;
    if (now >= p.until || p.player.slot === -1 || ineligible(p.player, now) !== null || humanDistance(p.player.x, p.player.z, p.player.level) > DISARM_DISTANCE) {
        pending = null;
        rollStats.capped++;
        return;
    }
    if (!capAllows(now)) return;
    pending = null;
    rollStats.armed++;
    arm(p.player, now);
}

/** arms the bot: its flag is the game's afkEventReady, kept until a script spends it (or the window is over) */
function arm(player: Player, now: number): void {
    armed.set(player, windowEnd(now));
    player.afkEventReady = true;
    tell({ type: 'armed', bot: player, humanDist: humanDistance(player.x, player.z, player.level) });
}

/** (tests) arms a bot now, whatever the roll and the cap */
export function armForTest(player: Player): void {
    arm(player, World.currentTick);
}

/** (tests) the winner the cap holds back, if any, and the end of its window */
export function pendingForTest(): { name: string; until: number } | null {
    return pending ? { name: pending.player.username, until: pending.until } : null;
}

/** (tests) one roll now, as at 274's 500-tick cadence */
export function rollForTest(): void {
    roll(World.currentTick);
}

/** (tests) the bot was just put where it stands by a fail teleport: its way back begins (a look about first) */
export function failRecoveryForTest(player: Player): void {
    const st = stateOf(player);
    const now = World.currentTick;
    const here: [number, number, number] = [player.x, player.z, player.level];
    [st.lastX, st.lastZ, st.lastLevel] = here;
    st.fail = { at: now, from: here, to: here, pauseUntil: now + ri([5, 13]), lastClimb: -100, climbs: 0, lastJump: -100 };
    active.add(player);
}

function disarm(player: Player, reason: string): void {
    armed.delete(player);
    if (player.slot !== -1) player.afkEventReady = false;
    tell({ type: 'disarmed', bot: player, reason });
}

/** an armed flag: spent (a script read it), or disarmed (far from every human, the next roll near, logged out) */
function checkArmed(player: Player, until: number, now: number): void {
    if (player.slot === -1 || !BotManager.botFor(player)) {
        armed.delete(player);
        tell({ type: 'disarmed', bot: player, reason: 'offline' });
        return;
    }
    if (!player.afkEventReady) {
        armed.delete(player);
        const st = stateOf(player);
        const d = humanDistance(player.x, player.z, player.level);
        // (where it stands now: the last position kept is only fresh while an event is under way)
        if (!active.has(player)) [st.lastX, st.lastZ, st.lastLevel] = [player.x, player.z, player.level];
        st.dropTries = 0;
        st.ev = {
            kind: 'pending',
            start: now,
            near: true,
            humanDist: d,
            from: [player.x, player.z, player.level],
            npc: null,
            ignore: false,
            answerAt: -1,
            answered: false,
            warnings: 0,
            teleported: false,
            left: false,
            endedAt: -1
        };
        active.add(player);
        return;
    }
    if (now >= until) return disarm(player, 'expired');
    if (humanDistance(player.x, player.z, player.level) > DISARM_DISTANCE) return disarm(player, 'far');
    // (a trade begun meanwhile: no event in the middle of it, its outcome is the trade's)
    if (player.botTradeTargetPid !== -1 || tradeScreen(player) !== null) return disarm(player, 'trade');
}

// ── what came of it ──────────────────────────────────────────────────────────

const GENERAL_KINDS: Readonly<Record<number, EventKind>> = { 1: 'swarm', 2: 'genie', 3: 'dwarf', 4: 'oldman', 5: 'triffid', 6: 'box', 7: 'mime', 8: 'maze', 100: 'mime', 101: 'mime', 102: 'mime' };

/** an NPC's kind from its debugname (antimacro.npc), or null */
export function eventKindOfNpc(npc: Npc): EventKind | null {
    const name = NpcType.get(npc.type)?.debugname ?? '';
    if (name === 'macro_geni') return 'genie';
    if (name === 'macro_mage') return 'oldman';
    if (name === 'macro_dwarf') return 'dwarf';
    if (name.startsWith('macro_triffidseed')) return 'triffid';
    if (name === 'macro_swarm') return 'swarm';
    if (name.startsWith('macro_golemguardian')) return 'golem';
    if (name.startsWith('macro_dryhadguardian')) return 'dryad';
    if (name.startsWith('macro_rivertrollguardian')) return 'troll';
    if (name.startsWith('macro_zombie')) return 'zombie';
    if (name.startsWith('macro_shade')) return 'shade';
    if (name.startsWith('macro_watchman')) return 'watchman';
    if (name.startsWith('macro_ent')) return 'ent';
    if (name === 'macro_bigfish') return 'bigfish';
    if (name.startsWith('macro_whirlpool')) return 'whirlpool';
    return null;
}

function findNpc(x: number, z: number, level: number, radius: number, predicate: (npc: Npc) => boolean): Npc | null {
    let best: Npc | null = null;
    let bestD = Infinity;
    for (let zx = (x - radius) >> 3; zx <= (x + radius) >> 3; zx++) {
        for (let zz = (z - radius) >> 3; zz <= (z + radius) >> 3; zz++) {
            const zone = World.gameMap.getZone(zx << 3, zz << 3, level);
            for (const npc of zone.getAllNpcsSafe()) {
                if (!npc.isActive) continue;
                const d = Math.max(Math.abs(npc.x - x), Math.abs(npc.z - z));
                if (d > radius || d >= bestD || !predicate(npc)) continue;
                best = npc;
                bestD = d;
            }
        }
    }
    return best;
}

/** an obj of `ids` near (x, z) that only `player` sees yet (its own drop) */
function findOwnObj(player: Player, x: number, z: number, level: number, radius: number, ids: ReadonlySet<number>): Obj | null {
    for (let zx = (x - radius) >> 3; zx <= (x + radius) >> 3; zx++) {
        for (let zz = (z - radius) >> 3; zz <= (z + radius) >> 3; zz++) {
            const zone = World.gameMap.getZone(zx << 3, zz << 3, level);
            for (const obj of zone.getAllObjsSafe()) {
                if (!obj.isActive || !ids.has(obj.type) || obj.receiver64 !== player.hash64) continue;
                if (Math.max(Math.abs(obj.x - x), Math.abs(obj.z - z)) <= radius) return obj;
            }
        }
    }
    return null;
}

function carries(player: Player, id: number, worn = true): boolean {
    if (id === -1) return false;
    const inv = player.getInventory(InvType.INV);
    if (inv && inv.getItemCount(id) > 0) return true;
    return worn && (player.getInventory(InvType.WORN)?.getItemCount(id) ?? 0) > 0;
}

function locCategory(loc: Loc): number {
    return LocType.get(loc.type)?.category ?? -1;
}

/** what the spent flag brought, from the evidence (null: none yet) */
function classify(player: Player, ev: ActiveEvent): { kind: EventKind; npc: Npc | null } | null {
    const c = content();
    const general = GENERAL_KINDS[varp(player, c.varEvent)];
    if (general) {
        const uid = varp(player, c.varUid);
        const npc = uid > 0 ? World.getNpcByUid(uid) : null;
        return { kind: general, npc };
    }
    if (carries(player, c.axeHandle)) return { kind: 'lostaxe', npc: null };
    if (carries(player, c.pickHandle)) return { kind: 'lostpickaxe', npc: null };
    if (carries(player, c.cube, false)) return { kind: 'box', npc: null };
    if (inMimeZone(player.x, player.z, player.level)) return { kind: 'mime', npc: null };
    if (inMazeZone(player.x, player.z, player.level)) return { kind: 'maze', npc: null };
    // a hostile one that came for it (the skills' and the swarm: npc_macro_event_target is the bot)
    const hostile = findNpc(player.x, player.z, player.level, 6, npc => eventNpcOf(npc, player) && eventKindOfNpc(npc) !== null);
    if (hostile) return { kind: eventKindOfNpc(hostile)!, npc: hostile };
    // the target it works changed: an ent (the tree became one, and its chop goes on to it), a gas rock, a big fish, a whirlpool
    const target = player.target;
    if (target instanceof Npc) {
        const kind = eventKindOfNpc(target);
        if (kind === 'ent' || kind === 'bigfish' || kind === 'whirlpool') return { kind, npc: target };
    }
    if (target instanceof Loc && c.catGas !== -1 && locCategory(target) === c.catGas) return { kind: 'gas', npc: null };
    const near = findNpc(player.x, player.z, player.level, 3, npc => {
        const k = eventKindOfNpc(npc);
        return k === 'ent' || k === 'bigfish' || k === 'whirlpool';
    });
    if (near) return { kind: eventKindOfNpc(near)!, npc: near };
    if (c.chestGas !== -1 && findLocOfType(player.x, player.z, player.level, 2, c.chestGas)) return { kind: 'gaschest', npc: null };
    void ev;
    return null;
}

function findLocOfType(x: number, z: number, level: number, radius: number, type: number): Loc | null {
    for (let zx = (x - radius) >> 3; zx <= (x + radius) >> 3; zx++) {
        for (let zz = (z - radius) >> 3; zz <= (z + radius) >> 3; zz++) {
            const zone = World.gameMap.getZone(zx << 3, zz << 3, level);
            for (const loc of zone.getAllLocsSafe()) {
                if (loc.isActive && loc.type === type && Math.max(Math.abs(loc.x - x), Math.abs(loc.z - z)) <= radius) return loc;
            }
        }
    }
    return null;
}

/** the reaction before answering an NPC event (ticks): 3-25 s by the persona's reaction */
function reactionTicks(player: Player): number {
    const p = personaOf(player.username, (player.botPlanner as PlannerKey) ?? null);
    const t = Math.round(logNormal(11 * p.reaction, 0.45, dice));
    return Math.max(REACTION_TICKS[0], Math.min(REACTION_TICKS[1], t));
}

const ri = ([lo, hi]: readonly [number, number]): number => lo + Math.floor(dice() * (hi - lo + 1));

/** the event began: what the bot will do about it, its line, the neighbours */
function begin(player: Player, st: EventState, ev: ActiveEvent, kind: EventKind, npc: Npc | null, now: number): void {
    ev.kind = kind;
    ev.npc = npc;
    if (kind !== 'none') lastEventOf.set(player.username, ev.start);
    if (ev.near && kind !== 'none') lastNearStart = ev.start;
    tell({ type: 'start', bot: player, kind, humanDist: ev.humanDist, from: ev.from });
    if (kind === 'none') return end(player, st, now);
    const gathering = GATHERING.has(taskKindOf(player));
    if (NPC_EVENTS.has(kind)) {
        const share = rates.ignore >= 0 ? rates.ignore : gathering ? IGNORE_SHARE_GATHERING : IGNORE_SHARE;
        ev.ignore = dice() < share;
        // (a third let the first warning pass: the genie's and old man's comes 20 ticks after it appears, the dwarf's 10)
        const firstWarning = kind === 'dwarf' ? 11 : kind === 'triffid' ? 46 : 21;
        // (the plant: it goes to it after the moment, and waits by it till it is ready, 45 ticks after it grew)
        ev.answerAt = ev.start + reactionTicks(player);
        if (kind !== 'triffid' && dice() < WAIT_FOR_WARNING_SHARE) ev.answerAt = Math.max(ev.answerAt, ev.start + firstWarning + ri([2, 8]));
        if (!ev.ignore) say(player, 'random-event', kind);
        if (kind !== 'triffid') neighbours(player, `appear-${kind}`);
    } else if (kind === 'gas' || kind === 'ent' || kind === 'whirlpool') {
        const noticed = dice() < (kind === 'gas' ? NOTICE_GAS : kind === 'ent' ? NOTICE_ENT : NOTICE_WHIRLPOOL);
        ev.answerAt = noticed ? now + ri(NOTICE_TICKS) : -1;
        if (noticed) say(player, 'random-event', kind);
        // (the whirlpool: the bot's fishing stopped when the spot changed; noticed, it fishes elsewhere (isEventHazard))
        if (kind === 'whirlpool' && npc) st.hazards.set(`npc:${npc.nid}`, { until: now + 60, noticed });
        if (kind === 'ent' && npc) st.hazards.set(`npc:${npc.nid}`, { until: now + 60, noticed });
    } else if (kind === 'lostaxe' || kind === 'lostpickaxe') {
        say(player, 'axe-head', kind === 'lostaxe' ? 'axe' : 'pickaxe');
    } else {
        say(player, 'random-event', kind);
        if (HOSTILE_EVENTS.has(kind)) neighbours(player, `appear-${kind}`);
    }
}

/** the event is over (for the cap and the listeners) */
function end(player: Player, st: EventState, now: number): void {
    const ev = st.ev;
    if (ev && ev.endedAt < 0) {
        ev.endedAt = now;
        tell({ type: 'end', bot: player, kind: ev.kind === 'pending' ? 'none' : ev.kind, ticks: now - ev.start });
    }
}

/** is anything still under way for this bot (an event, a drop, a recovery, a zone, a box or a lamp)? */
function busyWithEvents(player: Player, st: EventState): boolean {
    return (st.ev !== null && st.ev.endedAt < 0) || st.drops.length > 0 || st.fail !== null || st.zoneKind !== null || st.boxSeen >= 0 || st.lampSeen >= 0 || st.loot !== null || armed.has(player);
}

/** one tick of a bot's events: the classification, the NPC's warnings, the moves the game makes, the drops, the end */
function progress(player: Player, now: number): void {
    const st = stateOf(player);
    if (player.slot === -1 || !BotManager.botFor(player)) {
        // (logged out: what was under way goes with it; a box or the maze comes back with the next login: the stray check)
        if (st.ev) end(player, st, now);
        st.drops = [];
        st.fail = null;
        st.zoneKind = null;
        st.loot = null;
        active.delete(player);
        return;
    }
    const ev = st.ev;
    const c = content();
    if (ev && ev.kind === 'pending') {
        const found = classify(player, ev);
        if (found) begin(player, st, ev, found.kind, found.npc, now);
        else if (now - ev.start >= CLASSIFY_TICKS) begin(player, st, ev, 'none', null, now);
    }

    // the game's moves: a jump of more than 3 tiles (or a floor with it)
    const moved = player.level !== st.lastLevel ? 99 : Math.max(Math.abs(player.x - st.lastX), Math.abs(player.z - st.lastZ));
    if (moved > 3) onJump(player, st, now);
    st.lastX = player.x;
    st.lastZ = player.z;
    st.lastLevel = player.level;

    if (ev && ev.endedAt < 0 && ev.kind !== 'pending') follow(player, st, ev, now);

    // the mime's and the maze's zones (the game's own moves in and out)
    const zone = inMimeZone(player.x, player.z, player.level) ? 'mime' : inMazeZone(player.x, player.z, player.level) ? 'maze' : null;
    if (zone !== st.zoneKind) {
        // 274 runs a map square's [mapzone] and [mapzoneexit] scripts from a client's map update (NetworkPlayer.updateMap),
        // never for a bot: the mime's and the maze's are run here, as for a player (the maze's timer: its reward falls 1 %
        // every 5 ticks; on the way out %macro_event and the tabs reset: without it a bot never had another event)
        if (st.zoneKind) player.triggerMapzoneExit(...ZONE_ORIGIN[st.zoneKind]);
        if (zone) player.triggerMapzone(...ZONE_ORIGIN[zone]);
        if (zone) {
            st.zoneSince = now;
            st.zoneDoneAt = zone === 'maze' ? now + ri([150, 400]) : now + 1000;
            // (a strange box for a full pack is the maze: 274's old man turns it into that)
            if (st.ev && st.ev.endedAt < 0 && st.ev.kind === 'box') st.ev.kind = zone;
        } else if (st.zoneKind) {
            say(player, 'random-event', `${st.zoneKind}-done`);
            if (st.ev && (st.ev.kind === 'mime' || st.ev.kind === 'maze')) end(player, st, now);
        }
        st.zoneKind = zone;
    }

    // the lamp and the box in its pack (a person's moment before it rubs or opens one)
    if (carries(player, c.lamp, false)) {
        if (st.lampSeen < 0) {
            st.lampSeen = now;
            st.lampAt = now + ri([17, 100]);
            tell({ type: 'lamp-got', bot: player });
            say(player, 'lamp', 'got');
        }
    } else {
        st.lampSeen = -1;
        if (st.lampStat >= 0) lampDone(player, st);
    }
    if (carries(player, c.cube, false)) {
        if (st.boxSeen < 0) {
            st.boxSeen = now;
            st.boxAt = now + ri([8, 67]);
        }
    } else if (st.boxSeen >= 0) {
        tell({ type: 'box-solved', bot: player, wrong: st.boxWrong });
        say(player, 'random-event', st.boxWrong > 0 ? 'box-wrong' : 'box-done');
        st.boxSeen = -1;
        st.boxWrong = 0;
        if (st.ev?.kind === 'box') end(player, st, now);
    }

    // its drops: picked up (gone from the ground into its pack), or gone (despawned, revealed)
    if (st.drops.length) {
        for (const d of [...st.drops]) {
            if (!d.obj.isActive || d.obj.receiver64 !== player.hash64) {
                st.drops.splice(st.drops.indexOf(d), 1);
                // (off the ground and in its pack, or fitted already: picked; still there for everyone, or gone: not)
                if (!d.obj.isActive && (carries(player, d.obj.type, false) || (d.kind === 'head' && !carries(player, c.axeHandle) && !carries(player, c.pickHandle)))) tell({ type: 'picked', bot: player, obj: d.obj });
            }
        }
        if (!st.drops.length && st.ev && (st.ev.kind === 'lostaxe' || st.ev.kind === 'lostpickaxe' || st.ev.kind === 'bigfish')) end(player, st, now);
    }

    if (st.loot && now > st.loot.until) st.loot = null;
    for (const [key, h] of st.hazards) if (now > h.until) st.hazards.delete(key);

    if (!busyWithEvents(player, st) && !(st.task && responseDue(player, st, now))) active.delete(player);
}

/** the event's own course after it began: the NPC's warnings, its answer, the drops landing, the hazard's end */
function follow(player: Player, st: EventState, ev: ActiveEvent, now: number): void {
    const c = content();
    const npc = ev.npc;
    const kind = ev.kind as EventKind;
    if (NPC_EVENTS.has(kind)) {
        if (npc && npc.isActive) {
            const n = npcInt(npc);
            // (the happy state: -1, the genie's, the old man's and the dwarf's; the picked plant leaves)
            if (n === -1 && !ev.answered) {
                ev.answered = true;
                tell({ type: 'answered', bot: player, kind });
            }
            if (n > ev.warnings && n >= 0 && n <= 4 && kind !== 'triffid') {
                ev.warnings = n;
                // (the second warning passed and still no answer: a neighbour may say so)
                if (n === 2 && !ev.answered) neighbours(player, 'afk');
            }
            if (kind === 'triffid' && carries(player, c.triffidFruit, false) && !ev.answered) {
                ev.answered = true;
                tell({ type: 'answered', bot: player, kind });
                say(player, 'random-event', 'triffid-fruit');
            }
        } else {
            if (!ev.answered && kind === 'triffid' && carries(player, c.triffidFruit, false)) {
                ev.answered = true;
                tell({ type: 'answered', bot: player, kind });
            }
            if (!ev.answered && !ev.teleported) {
                // (gone unanswered: the genie or the old man teleport the bot now, two ticks on; the dwarf turned on it)
                if (kind !== 'genie' && kind !== 'oldman') {
                    tell({ type: 'ignored', bot: player, kind });
                    end(player, st, now);
                } else if (now - ev.start > 400) end(player, st, now);
                return;
            }
            if (ev.answered) {
                if (kind === 'oldman' || kind === 'dwarf') say(player, 'random-event', kind === 'dwarf' ? 'dwarf-gift' : `oldman-${giftOf(player)}`);
                end(player, st, now);
            }
        }
        // (an angry dwarf or plant: BotDefence answers it; once it is gone the event is over)
        if (npc && npc.isActive && (kind === 'dwarf' || kind === 'triffid') && !ev.answered && npcAttacks(npc, player)) {
            if (!ev.ignore) ev.ignore = true;
        }
        return;
    }
    if (kind === 'lostaxe' || kind === 'lostpickaxe' || kind === 'bigfish') {
        // the head or the rod lands a tick or two after the event (a projectile's delay): found within 8 tiles
        if (!st.drops.length && now - ev.start <= 12) {
            const ids = kind === 'bigfish' ? c.rods : c.heads;
            const obj = findOwnObj(player, ev.from[0], ev.from[1], ev.from[2], 8, ids);
            if (obj) {
                const worn = kind !== 'bigfish' && (player.getInventory(InvType.WORN)?.getItemCount(kind === 'lostaxe' ? c.axeHandle : c.pickHandle) ?? 0) > 0;
                st.drops.push({ obj, at: now, pickAt: now + ri([8, 33]), kind: kind === 'bigfish' ? 'rod' : 'head', worn });
                tell({ type: 'dropped', bot: player, obj, kind });
                if (kind === 'bigfish') say(player, 'random-event', 'bigfish');
            }
        } else if (!st.drops.length && now - ev.start > 12) end(player, st, now);
        return;
    }
    if (kind === 'gas' || kind === 'ent' || kind === 'whirlpool') {
        // a hazard lasts 60 ticks (the rock, the ent, the whirlpool change back); the bot's broken tool is noted
        if (kind === 'gas' && player.target instanceof Loc && locCategory(player.target) === c.catGas) st.hazards.set(locKey(player.target), { until: now + 60, noticed: ev.answerAt >= 0 });
        if (now - ev.start >= 70) {
            if (brokeTool(player) && !ev.left) say(player, 'random-event', kind === 'gas' ? 'gas-boom' : 'ent-broke');
            end(player, st, now);
        }
        return;
    }
    if (HOSTILE_EVENTS.has(kind)) {
        if (npc && npc.isActive) {
            if (playerAttacks(player, npc)) st.loot = { x: npc.x, z: npc.z, level: npc.level, until: now + 60 };
        } else end(player, st, now);
        return;
    }
    if (kind === 'gaschest' && now - ev.start > 100) end(player, st, now);
}

/** the old man's gift: what its pack gained (a kebab, a spinach roll, coins, a casket) */
function giftOf(player: Player): string {
    const inv = player.getInventory(InvType.INV);
    for (const [name, gift] of [['casket', 'casket'], ['kebab', 'kebab'], ['spinach_roll', 'spinach']] as const) {
        const id = ObjType.getId(name);
        if (id !== -1 && inv && inv.getItemCount(id) > 0) return gift;
    }
    return 'coins';
}

/** its axe or pickaxe is a broken one now (an ent, a gas rock), worn or in the pack */
function brokeTool(player: Player): boolean {
    for (const inv of [player.getInventory(InvType.WORN), player.getInventory(InvType.INV)]) {
        for (let slot = 0; inv && slot < inv.capacity; slot++) {
            const it = inv.get(slot);
            const name = it ? (ObjType.get(it.id)?.debugname ?? '') : '';
            if (name.includes('broken') && /(pickaxe|hatchet)/.test(name)) return true;
        }
    }
    return false;
}

/** the NPC acts on the player (its [ai_opplayerN]/[ai_applayerN]: an attack), not a follow or a face (BotAction's actsOn) */
function npcAttacks(npc: Npc, player: Player): boolean {
    return npc.target === player && npc.targetOp >= NpcMode.OPPLAYER1 && npc.targetOp <= NpcMode.APPLAYER5;
}

/** the player attacks the NPC (its Attack op) */
function playerAttacks(player: Player, npc: Npc): boolean {
    return player.target === npc && (player.targetOp === ServerTriggerType.APNPC2 || player.targetOp === ServerTriggerType.OPNPC2);
}

function locKey(loc: Loc): string {
    return `loc:${loc.level}_${loc.x}_${loc.z}`;
}

/** a jump: the fail teleport, the mime or the maze in or out (the game's own moves), marked real for the runner */
function onJump(player: Player, st: EventState, now: number): void {
    const ev = st.ev;
    const from: [number, number, number] = [st.lastX, st.lastZ, st.lastLevel];
    const to: [number, number, number] = [player.x, player.z, player.level];
    const into = inMimeZone(player.x, player.z, player.level) ? 'mime-in' : inMazeZone(player.x, player.z, player.level) ? 'maze-in' : null;
    const outOf = inMimeZone(from[0], from[1], from[2]) ? 'mime-out' : inMazeZone(from[0], from[1], from[2]) ? 'maze-out' : null;
    if (into || outOf) {
        noteMove(player, 'event');
        // (a jump inside the zone is the unseen finish's: told by it)
        if (into && outOf) return;
        tell({ type: 'move', bot: player, move: (into ?? outOf) as RandomEventNote['move'], from, to, humanDist: Math.min(humanDistance(from[0], from[1], from[2]), humanDistance(to[0], to[1], to[2])) });
        return;
    }
    // (the fail teleport: a genie or the old man that went unanswered; the jump comes a couple of ticks after it left, onto
    // one of 274's spots (macro_event_fail_teleport: the enum's coord exactly). A climb, a mine's ladder, a boat or a
    // spell of the bot's own while the NPC still waits is none of it: the NPC follows it, as 274's macro_event_lost has
    // it, and the event goes on)
    if (ev && (ev.kind === 'genie' || ev.kind === 'oldman') && !ev.answered && !ev.teleported && now - ev.start < 400 && !(ev.npc && ev.npc.isActive) && failExitFor(player.x, player.z, player.level) !== null) {
        ev.teleported = true;
        noteMove(player, 'event');
        const humanDist = humanDistance(from[0], from[1], from[2]);
        tell({ type: 'move', bot: player, move: 'fail', from, to, humanDist });
        tell({ type: 'ignored', bot: player, kind: ev.kind });
        neighboursAt(player, from, 'teled');
        st.fail = { at: now, from, to, pauseUntil: now + ri([5, 13]), lastClimb: -100, climbs: 0, lastJump: -100 };
        say(player, 'fail-teleported', player.z >= 6400 ? 'basement' : player.level > 0 ? 'upstairs' : 'ground');
        end(player, st, now);
    }
}

// ── the answers (port/RandomEventTask) ───────────────────────────────────────

/**
 * BotPlayer.tick, before its sub-task runs: the bot's answer to an event that came to it, as a sub-task (the same one
 * while it runs), or null when none is due now. A bot on a break never gets here (its habits run first), and another
 * sub-task holds it unless it is its own (a hang-out, a friend's follow: those end for the answer). The answers run
 * anywhere (a box, the maze survive a logout); only the arming is near a human.
 */
export function randomEventTaskFor(player: Player, current: BotTask | null): BotTask | null {
    const now = World.currentTick;
    let st = states.get(player);
    if (!st || !active.has(player)) {
        // (a login with a box or a lamp in the pack, or in the mime's or the maze's zone: picked up here now and then)
        if (inMimeZone(player.x, player.z, player.level) || inMazeZone(player.x, player.z, player.level)) {
            st = stateOf(player);
            [st.lastX, st.lastZ, st.lastLevel] = [player.x, player.z, player.level];
            active.add(player);
        } else {
            st = stateOf(player);
            if (now - st.strayCheck < STRAY_CHECK_TICKS) return null;
            st.strayCheck = now;
            const c = content();
            if (!carries(player, c.cube, false) && !carries(player, c.lamp, false) && !carries(player, c.axeHandle) && !carries(player, c.pickHandle)) return null;
            [st.lastX, st.lastZ, st.lastLevel] = [player.x, player.z, player.level];
            active.add(player);
            return null;
        }
    }
    if (current && current !== st.task) {
        const name = current.name;
        if (name !== 'Hangout' && name !== 'CliqueFollow') return null;
        if (!responseDue(player, st, now)) return null;
        current.interrupt();
    }
    if (!responseDue(player, st, now)) return current === st.task ? current : null;
    if (!st.task) st.task = new RandomEventTask();
    return st.task;
}

/**
 * A skilling task's target finders skip a target that is a random event's hazard the bot noticed: a gas rock (its
 * category, mining_rock_macro_gas), an ent, a whirlpool (antimacro's macro_whirlpool_*, a "Fishing spot" whose debugname
 * ends as the real ones do). A bot that did not notice (20 % gas, 15 % an ent, 10 % a whirlpool) works on: a broken
 * pickaxe or axe, a lost rod (the 274 scripts). Another bot that sees one: the same odds, once per hazard.
 */
export function isEventHazard(player: Player, target: unknown): boolean {
    const c = content();
    if (target instanceof Loc) {
        if (c.catGas === -1 || locCategory(target) !== c.catGas) return false;
        return noticed(player, locKey(target), NOTICE_GAS);
    }
    if (target instanceof Npc) {
        const kind = eventKindOfNpc(target);
        if (kind !== 'whirlpool' && kind !== 'ent') return false;
        return noticed(player, `npc:${target.nid}`, kind === 'ent' ? NOTICE_ENT : NOTICE_WHIRLPOOL);
    }
    return false;
}

function noticed(player: Player, key: string, chance: number): boolean {
    const st = stateOf(player);
    const now = World.currentTick;
    let h = st.hazards.get(key);
    if (!h || now > h.until) {
        h = { until: now + 60, noticed: dice() < chance };
        st.hazards.set(key, h);
    }
    return h.noticed;
}

/** BotManager._busy: a bot whose session is over stays while an event is under way (a box, the mime, the maze, a head on the ground, the way down) */
export function holdsLogout(player: Player): boolean {
    const st = states.get(player);
    if (!st || !active.has(player)) return false;
    const now = World.currentTick;
    if (st.zoneKind || st.fail || st.drops.length || st.boxSeen >= 0) return true;
    if (st.lampSeen >= 0 && now - st.lampSeen < 500) return true;
    const ev = st.ev;
    return ev !== null && ev.endedAt < 0 && NPC_EVENTS.has(ev.kind as EventKind) && !ev.ignore && !ev.answered && now - ev.start < 200;
}

// ── lines ────────────────────────────────────────────────────────────────────

/** its own line about it, now and then (port/BotChatter: the event's chance by its persona, its talk budget) */
function say(player: Player, event: string, kind: string): void {
    noteEvent(player, event, { kind });
}

/** (the response) its line about an event it saw through (the lamp's skill ...) */
export function sayEvent(player: Player, event: string, kind: string): void {
    say(player, event, kind);
}

/** a neighbour within 8 tiles of the bot says something about its event (25 %), a few seconds later */
function neighbours(player: Player, kind: string): void {
    neighboursAt(player, [player.x, player.z, player.level], kind);
}

function neighboursAt(player: Player, [x, z, level]: [number, number, number], kind: string): void {
    if (dice() >= rates.neighbour) return;
    const now = World.currentTick;
    const area = `${x >> 6}_${z >> 6}_${level}`;
    if (now - (neighbourAreaAt.get(area) ?? -Infinity) < NEIGHBOUR_AREA_TICKS) return;
    const crowd: Player[] = [];
    for (const b of BotManager.activeBots()) {
        if (b === player || b.level !== level || Math.max(Math.abs(b.x - x), Math.abs(b.z - z)) > NEIGHBOUR_DISTANCE) continue;
        if (now - (neighbourBotAt.get(b.username) ?? -Infinity) < NEIGHBOUR_BOT_TICKS || !calm(b, now)) continue;
        crowd.push(b);
    }
    if (!crowd.length) return;
    const bot = crowd[Math.floor(dice() * crowd.length)];
    neighbourAreaAt.set(area, now);
    neighbourBotAt.set(bot.username, now);
    if (neighbourAreaAt.size > 4096) neighbourAreaAt.clear();
    const delay = ri(NEIGHBOUR_DELAY);
    scheduleInTicks(delay, () => {
        if (bot.slot === -1 || !BotManager.botFor(bot) || !calm(bot)) return;
        const at = World.currentTick;
        const ctx = contextOf(bot, new Map([['random-near', { tick: at, kind }]]));
        const picked = pickLine(ctx, { event: 'random-near' }, dice);
        if (!picked) return;
        const persona = personaOf(bot.username, (bot.botPlanner as PlannerKey) ?? null);
        const text = picked.line.source === '2004' ? styleLine(picked.text, persona, dice).line : picked.text;
        botSay(bot, text, undefined, 'event', null);
        noteSaid(bot, text, at);
        noteSpoke(bot, 'event', at, null);
        // (one of its persona's lines, in the place of its next: the talk budget)
        countAsBudgetedLine(bot);
    });
}
