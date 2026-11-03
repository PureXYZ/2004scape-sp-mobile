// port (bots ideas, round 3, theme G: period content): kittens and cats, 274's pets since
// 29 Mar 2004 (content quest_fluffs pet.rs2, gertrude.rs2), kept by the bots that would have kept one.
//
//   - CAT PEOPLE: members worlds only; a bot whose name draws under CAT_PERSON_SHARE on its own salt ('cat-person': no
//     other trait moves), any role but the PKers (both kinds), the player mod and newbies. Vendors are in: a vendor's
//     cat at Varrock West is the pet most seen. About 25 online at 500, 20 with a pet out; 5 and 4 at 100 (5 %: round
//     3's tune, from 3 %).
//   - THE KITTEN: bought from Gertrude, west of Varrock, through 274's own dialogue (tasks/PetTripTask: food first, her
//     door clicked open, her Talk-to, "Yes please.", 100 coins): the bot's first session (in this process) with the
//     coins; after a pet is lost, again after 1-3 hours of play at REBUY_CHANCE. The trip is a sub-task taken at a free
//     moment of the bot's task (a skill, a fight, a stall), so a vendor goes too; its task goes on after.
//   - THE CARE (this module's habit, from the bot's tick: BotPlayer's periodHabits, pushed by port/BotPeriodIndex): a
//     kitten stroked (op 3, its page continued) every 10-15 minutes of play and fed (a pet food used on it: raw shrimps,
//     anchovies, sardines, trout, salmon, tuna, or cooked trout, salmon, tuna the bot owns) every 15-22, both once in the
//     first minutes after a login (hunger and attention carry over between sessions); a grown cat or an overgrown one
//     (no hunger, no attention in 274) stroked every 20-40 minutes. The gaps are the bot's own (its name's seed), a
//     careless bot's (carelessness over 0.6, about 1 in 10) 1.6 times as long, and it skips one care in 4. A warning
//     page ("I think it's hungry!", "I think it wants some attention.") is continued at a person's moment and answered
//     (fed or stroked) within 30 s, the careless bot's skips apart: a kitten runs away now and then by 274's own rule (a
//     careless bot's about once in 15-25 hours out), as people's did. No kitten page is left open (PC4). Out of pet food
//     with a kitten out: a food trip (its own raw catch from the bank, else 10 raw sardines at Port Sarim).
//   - Never "Chase vermin" (its say lines would be chat), never shoo, never pick up. The pet follows everywhere by 274's
//     ai_timer; a bot that dies loses it (death.rs2's follower_death), as a player would; a logout keeps it
//     (%follower_obj, a perm varp in the bot's own save: nothing new in bots.sav); on a free world the habit is off (a
//     saved pet re-spawns at login by 274's own follower_login, as a human's would).
//   - THE SWITCH: every hook asks periodOn() first (theme G off: no dice, no state); a free world, no state either.
//   - petStats (the humanlike runner's PC3, PC4): bought, fed, stroked, pages continued and those left open 10 s+, lost
//     (neglect, death), grown; petOf(p) for the runner's sample of pets out.
// The lines (data/lines2004-period.json, event 'period', kinds pet-*) are set pieces (port/BotPeriodPlan sayPeriodLine:
// out of H7, counted in X2, in the place of the speaker's next unprompted line).
import type Player from '#/engine/entity/Player.js';
import type Npc from '#/engine/entity/Npc.js';
import World from '#/engine/World.js';
import ObjType from '#/cache/config/ObjType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import InvType from '#/cache/config/InvType.js';
import ScriptState from '#/engine/script/ScriptState.js';
import type ScriptStateT from '#/engine/script/ScriptState.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import type { BotPlayer } from '#/engine/bot/BotPlayer.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { botContinuePage, botInteractUseObjNpc, botScript, findAggressorNpc, interactNpcOp } from '#/engine/bot/BotAction.js';
import { Items } from '#/engine/bot/BotKnowledge.js';
import { coinsOwned } from '#/engine/bot/BotNeeds.js';
import { periodOn } from '#/engine/bot/port/BotPeriod.js';
import { sayPeriodLine } from '#/engine/bot/port/BotPeriodPlan.js';
import { arcsPlay, onArcs } from '#/engine/bot/port/BotArcsEvents.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { isPlayerModName } from '#/engine/bot/port/BotModBot.js';
import { botPersona } from '#/engine/bot/port/BotTiming.js';
import { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';
import { tradeScreen } from '#/engine/bot/port/BotTradeScreen.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { PetTripTask, bankedPetFood, setPetBoughtHook, shopCoinsFor } from '#/engine/bot/tasks/PetTripTask.js';

// ── the defaults (G-content §5: approved) ──────────────────────────────────────────────────────────────────────────

/**
 * members bots by name (salt 'cat-person') who keep a pet (bots ideas, round 3 tune: 3 % to 5 %,
 * 2026-11-01: PC3 was 0.6-1.4 pets out per 100 online, its band 1-4; the 3 % are among the 5 %, the salt's draw unchanged)
 */
export const CAT_PERSON_SHARE = 0.05;
/** a kitten's stroke and feed gaps (world ticks, the bot's own within these: its name's seed), a cat's stroke gap */
export const STROKE_GAP: readonly [number, number] = [1000, 1500];
export const FEED_GAP: readonly [number, number] = [1500, 2200];
export const CAT_STROKE_GAP: readonly [number, number] = [2000, 4000];
/** after a login: the first feed within, the first stroke within (ticks: hunger and attention carry over) */
export const LOGIN_FEED: readonly [number, number] = [20, 100];
export const LOGIN_STROKE: readonly [number, number] = [60, 200];
/** a careless bot (carelessness over CARELESS): its gaps this many times as long, one care in CARELESS_SKIP skipped */
export const CARELESS = 0.6;
export const CARELESS_GAPS = 1.6;
export const CARELESS_SKIP = 0.25;
/** a warning page answered (fed or stroked) within this (ticks: 30 s) */
export const WARNING_ANSWER: readonly [number, number] = [4, 50];
/** a pet page continued after a person's moment (ticks), and counted as left open past this (10 s) */
export const PAGE_READ: readonly [number, number] = [2, 6];
export const PAGE_OPEN_TICKS = 17;
/** after a pet is lost: another after this much play (1-3 h), this often */
export const REBUY_PLAY: readonly [number, number] = [6000, 18000];
export const REBUY_CHANCE = 0.7;
/** a purchase or food trip only with this much of the session left, and at most this far from Gertrude (tiles) */
const TRIP_SESSION_LEFT = 2000;
const TRIP_TILES = 800;
/** how often a cat person with no pet (or no pet food) looks at a trip (ticks) */
const TRIP_LOOK = 300;
/** after a trip that came back with no food, the next look this much later (ticks: 15 min) */
const NO_FOOD_LOOK = 1500;
/** a care's click: the bot held for it at most this long (ticks) */
const CARE_TICKS = 25;
/** what a kitten costs (gertrude.rs2) and what the bot wants besides for its food */
export const KITTEN_COST = 100;
const TRIP_COINS = 160;
/** pet food in the pack a trip wants, and the least before a food trip with a kitten out */
export const PET_FOOD_WANT = 4;
/** sardines at Port Sarim only for a bot east of this (White Wolf Mountain's x: Kandarin's bots bring their own fish) */
export const SARDINES_EAST_OF = 2880;
/** the lines' odds */
const BUY_LINE = 0.5;
const FEED_LINE = 0.08;
const LOST_LINE = 0.5;
const GROW_LINE = 0.6;

/** task kinds a pet trip may pause (a skill, a fight, a stall, a stand): never a minigame, an outing, a set piece */
const TRIP_FROM = new Set(['Woodcut', 'Mine', 'Fish', 'Cook', 'Smith', 'Crafting', 'Fletching', 'BowStringing', 'Herblore', 'Firemaking', 'Pick Flax', 'Combat', 'RangedMagic', 'Thieve', 'Agility', 'Runecrafting', 'Prayer', 'Vendor', 'Bankstand', 'Social', 'Idle', 'Init', 'Walk', 'Bank', 'ShopTrip', 'FoodTrip', 'WaterFilling', 'Magic']);

// ── the game's ids (looked up once, after the cache is loaded) ─────────────────────────────────────────────────────

export type PetKind = 'kitten' | 'cat' | 'overgrown';

interface PetIds {
    followerObj: number;
    followerUid: number;
    catGrowth: number;
    /** the pet foods, raw first (pet.rs2's opnpcu list) */
    foods: number[];
    /** kittenobject*, growncatobject*, overgrowncatobject*: obj id -> kind */
    kinds: Map<number, PetKind>;
}
let ids: PetIds | null = null;
function petIds(): PetIds {
    if (!ids) {
        const kinds = new Map<number, PetKind>();
        for (const colour of ['', '_light', '_brown', '_black', '_browngrey', '_bluegrey']) {
            for (const [prefix, kind] of [
                ['kittenobject', 'kitten'],
                ['growncatobject', 'cat'],
                ['overgrowncatobject', 'overgrown']
            ] as const) {
                const id = ObjType.getId(`${prefix}${colour}`);
                if (id !== -1) kinds.set(id, kind);
            }
        }
        ids = {
            followerObj: VarPlayerType.getId('follower_obj'),
            followerUid: VarPlayerType.getId('follower_uid'),
            catGrowth: VarPlayerType.getId('cat_growth'),
            foods: [Items.RAW_SARDINE, Items.RAW_SHRIMP, Items.RAW_ANCHOVIES, Items.RAW_TROUT, Items.RAW_SALMON, Items.RAW_TUNA, Items.TROUT, Items.SALMON, ObjType.getId('tuna')].filter(id => typeof id === 'number' && id !== -1),
            kinds
        };
    }
    return ids;
}

/** the pet foods a bot may feed its kitten, raw first (its own raw catch, sardines bought; cooked trout, salmon, tuna) */
export function petFoods(): readonly number[] {
    return petIds().foods;
}

function varp(p: Player, id: number): number {
    if (id === -1) return -1;
    const v = p.getVar(id);
    return typeof v === 'number' ? v : -1;
}

/** the bot's %follower_obj (its pet's item), or -1 with none */
export function petObjOf(p: Player): number {
    const v = varp(p, petIds().followerObj);
    return v > 0 ? v : -1;
}

/** what a pet item is (kitten, cat, overgrown cat), or null */
export function petKindOfObj(obj: number): PetKind | null {
    return petIds().kinds.get(obj) ?? null;
}

/** the bot's pet out now (the follower NPC whose uid its %follower_uid holds) and what it is, or null */
export function petOf(p: Player): { npc: Npc; kind: PetKind } | null {
    const obj = petObjOf(p);
    if (obj === -1) return null;
    const kind = petKindOfObj(obj);
    if (!kind) return null;
    const uid = varp(p, petIds().followerUid);
    if (uid <= 0) return null;
    const npc = World.getNpcByUid(uid);
    return npc && npc.isActive ? { npc, kind } : null;
}

/** hunger (0-20: a page at 16 and 18, gone at 20) and attention (28 after a stroke; pages at 40, 45, gone at 50): %cat_growth's bits */
export function petNeeds(p: Player): { hunger: number; attention: number; growth: number } {
    const g = Math.max(0, varp(p, petIds().catGrowth));
    return { hunger: g & 31, attention: (g >> 5) & 63, growth: (g >> 11) & 511 };
}

/** the pet foods in the bot's pack (a count) */
export function petFoodCarried(p: Player): number {
    const inv = p.getInventory(InvType.INV);
    if (!inv) return 0;
    let n = 0;
    for (const id of petIds().foods) n += inv.getItemCount(id);
    return n;
}

/** the pack slot of the first pet food (raw first), or null */
function petFoodSlot(p: Player): { id: number; slot: number } | null {
    const inv = p.getInventory(InvType.INV);
    if (!inv) return null;
    for (const id of petIds().foods) {
        for (let slot = 0; slot < inv.capacity; slot++) if (inv.get(slot)?.id === id) return { id, slot };
    }
    return null;
}

/** a kitten or a cat in the pack or the bank (Gertrude's own check: she sells none to such a player) */
function petItemOwned(p: Player): boolean {
    const kinds = petIds().kinds;
    for (const invId of [InvType.INV, InvType.getId('bank')]) {
        const inv = invId === -1 ? null : p.getInventory(invId);
        if (!inv) continue;
        for (let slot = 0; slot < inv.capacity; slot++) {
            const id = inv.get(slot)?.id;
            if (id !== undefined && kinds.has(id)) return true;
        }
    }
    return false;
}

// ── who ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A cat person (members worlds; no PKer, the mod or a newbie; its own salt). Asks no switch: callers ask periodOn() first. */
export function isCatPerson(p: Player): boolean {
    if (!isMembersWorld()) return false;
    if (testCatPeople !== null) return testCatPeople.has(p.username);
    const planner = p.botPlanner as string | undefined;
    if (planner === 'extras_pker' || planner === 'extras_edgeville_pker') return false;
    if (isPlayerModName(p.username) || isNewbie(p)) return false;
    return nameSeed(p.username, 'cat-person') / 4294967296 < CAT_PERSON_SHARE;
}

/** (tests) these names are the cat people (null: the names' own draw) */
let testCatPeople: ReadonlySet<string> | null = null;
export function setCatPeopleForTest(names: readonly string[] | null): void {
    testCatPeople = names === null ? null : new Set(names);
}

// ── the stats ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** the runner's PC3 and PC4 (pets out are its own sample: petOf) */
export const petStats = {
    trips: 0,
    bought: 0,
    foodTrips: 0,
    fed: 0,
    stroked: 0,
    skipped: 0,
    warnings: 0,
    answered: 0,
    pagesContinued: 0,
    /** pet pages seen open PAGE_OPEN_TICKS (10 s) or more */
    pagesOpen: 0,
    lost: { neglect: 0, death: 0 } as Record<string, number>,
    grown: 0,
    /** world ticks a pet was out, by the habit's own watch (PC4's pet-hours) */
    petTicks: 0
};

export function petStatsCopy(): typeof petStats {
    return JSON.parse(JSON.stringify(petStats)) as typeof petStats;
}

/** (tests) the counts at 0 (the cat people and their sessions' care stay) */
export function resetPetStatsForTest(): void {
    for (const k of Object.keys(petStats) as (keyof typeof petStats)[]) {
        if (k === 'lost') petStats.lost = { neglect: 0, death: 0 };
        else (petStats as Record<string, unknown>)[k] = 0;
    }
}

// ── a bot's care (this session: its Player) and its rebuy (by name, this process) ──────────────────────────────────

interface Act {
    kind: 'stroke' | 'feed';
    start: number;
    npc: Npc;
    /** the bot's script seen under way (the stroke's p_delay, its page) */
    seen: boolean;
}

interface Care {
    /** a cat person, or a bot with a pet (its save's): every other bot is a WeakMap read and done */
    track: boolean;
    /** the bot's own gaps (its name's seed) */
    strokeGap: number;
    feedGap: number;
    catGap: number;
    careless: boolean;
    nextStroke: number;
    nextFeed: number;
    /** the pet item seen last look, and its kind (-1, null: none) */
    had: number;
    hadKind: PetKind | null;
    /** the habit's last look (every few ticks) */
    looked: number;
    phase: number;
    act: Act | null;
    /** a pet page first seen open (-1: none), when it is read, and whether it was counted as left open */
    pageSince: number;
    pageAt: number;
    pageCounted: boolean;
    /** a warning to answer: by when, and with what */
    answer: { by: number; kind: 'stroke' | 'feed' } | null;
    /** the next look at a purchase or a food trip, and the trip under way (or just over) */
    tripLook: number;
    trip: PetTripTask | null;
    /** the bot died lately (its death on the bus): a pet gone then went with its death */
    diedAt: number;
    /** a care due but not free for it: the next look */
    waitUntil: number;
}

const cares = new WeakMap<Player, Care>();
/** by name: when a lost pet may be bought again (play ticks; Infinity: not this process), and whether one was ever seen */
const rebuys = new Map<string, number>();
const owners = new Set<string>();

function between(r: () => number, [lo, hi]: readonly [number, number]): number {
    return Math.round(lo + (hi - lo) * r());
}

function jitter(gap: number): number {
    return Math.round(gap * (0.85 + 0.3 * Math.random()));
}

/** every bot that is neither a cat person nor a pet owner this session: one shared record, no dice */
const UNTRACKED = { track: false } as Care;

function careOf(p: Player): Care {
    let c = cares.get(p);
    if (c) return c;
    const obj = petObjOf(p);
    if (obj === -1 && !isCatPerson(p)) {
        cares.set(p, UNTRACKED);
        return UNTRACKED;
    }
    const r = seededRandom(nameSeed(p.username, 'pet-care'));
    const careless = botPersona(p).carelessness > CARELESS;
    const scale = careless ? CARELESS_GAPS : 1;
    const now = World.currentTick;
    c = {
        track: true,
        strokeGap: Math.round(between(r, STROKE_GAP) * scale),
        feedGap: Math.round(between(r, FEED_GAP) * scale),
        catGap: Math.round(between(r, CAT_STROKE_GAP) * scale),
        careless,
        nextStroke: now + between(Math.random, LOGIN_STROKE),
        nextFeed: now + between(Math.random, LOGIN_FEED),
        had: obj,
        hadKind: obj === -1 ? null : petKindOfObj(obj),
        looked: now,
        phase: nameSeed(p.username, 'pet-look') % 10,
        act: null,
        pageSince: -1,
        pageAt: -1,
        pageCounted: false,
        answer: null,
        tripLook: now + between(Math.random, [50, TRIP_LOOK]),
        trip: null,
        diedAt: -1,
        waitUntil: -1
    };
    if (obj !== -1) owners.add(p.username);
    cares.set(p, c);
    return c;
}

// (the bot's death: a pet gone right after went with it, death.rs2's follower_death; asked only while theme G is on)
let deathsHeard = false;
function listenForDeaths(): void {
    if (deathsHeard) return;
    deathsHeard = true;
    onArcs('death', e => {
        if (!periodOn()) return;
        const c = cares.get(e.bot);
        if (c?.track) c.diedAt = World.currentTick;
    });
}

/**
 * the scripts behind the bot's open script: itself, its gosubs' callers and the scripts a label jump left (274's
 * [timer,petcat_growth] jumps to [label,kitten_growth], whose ~chatplayer is the page): their names
 */
function scriptNames(state: ScriptStateT): string[] {
    const names = [state.script?.name ?? ''];
    for (const f of state.frames) names.push(f.script?.name ?? '');
    for (let i = 0; i < state.debugFp; i++) names.push(state.debugFrames[i]?.script?.name ?? '');
    return names;
}

const PET_SCRIPTS = /petcat|\[label,kitten_growth\]|\[label,cat_growth\]/;

/** a page of the pet's open now (its timer's warning or growth box, a stroke's, a feed's) */
function petPageOpen(p: Player): boolean {
    const s = p.activeScript;
    if (!s || s.execution !== ScriptState.PAUSEBUTTON) return false;
    return scriptNames(s).some(n => PET_SCRIPTS.test(n));
}

/**
 * free for a care's click: no trade, script, window or set piece; and no fight, no attacker, out of the Wilderness, unhurt
 * (urgent, a hungry or lonely kitten or a care long overdue: only no attacker on it now, as a player feeds between kills:
 * a fighter's fight lock never lapsed between its kills, and kittens ran away)
 */
function freeToCare(p: Player, urgent = false): boolean {
    if (p.botTradeTargetPid !== -1 || tradeScreen(p) !== null || p.botComeHereReturnX !== -1) return false;
    if (p.delayed || botScript(p) !== null || p.containsModalInterface() || eventRoleOf(p) !== null) return false;
    if (urgent) return findAggressorNpc(p, 8) === null;
    if (World.currentTick < p.preventLogoutUntil || wildernessLevelAt(p.x, p.z) > 0) return false;
    if (p.levels[PlayerStat.HITPOINTS] * 2 < p.baseLevels[PlayerStat.HITPOINTS]) return false;
    return findAggressorNpc(p, 8) === null;
}

/** a kitten's care is urgent: its hunger or attention near a warning (the game's "Miaow!" overhead), a warning to answer, or long overdue */
const OVERDUE = 300;
function urgentCare(p: Player, c: Care, kind: 'stroke' | 'feed', pet: PetKind, now: number): boolean {
    if (pet !== 'kitten') return false;
    if (c.answer !== null) return true;
    const needs = petNeeds(p);
    if (kind === 'feed') return needs.hunger >= 13 || now - c.nextFeed >= OVERDUE;
    return needs.attention >= 37 || now - c.nextStroke >= OVERDUE;
}

/** free for a trip (a sub-task: its task paused at a moment a player would): see TRIP_FROM */
function freeForTrip(bot: BotPlayer): boolean {
    const p = bot.player;
    if (bot.hasSubTask() || !freeToCare(p)) return false;
    if (p.level !== 0 || p.z >= 6400 || p.hasWaypoints()) return false;
    const name = bot.currentTask?.name ?? 'Init';
    if (name.includes(':outing:') || name.includes(':buzz:') || !TRIP_FROM.has(name.split(':')[0])) return false;
    if (BotManager.sessionLeftOf(p.username) < TRIP_SESSION_LEFT) return false;
    const [gx, gz] = [3150, 3410];
    return Math.max(Math.abs(p.x - gx), Math.abs(p.z - gz)) <= TRIP_TILES;
}

/** a purchase is due: no pet (follower, pack or bank), never one seen this process or its rebuy's time come */
function purchaseDue(p: Player): boolean {
    if (petObjOf(p) !== -1 || petItemOwned(p)) return false;
    const rebuy = rebuys.get(p.username);
    if (rebuy !== undefined && arcsPlay() < rebuy) return false;
    return coinsOwned(p) >= TRIP_COINS;
}

// ── the habit ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The pet habit, from the bot's tick (BotPlayer periodHabits): true while it holds the bot (a care's click and its
 * page, as a short break holds it: the task waits). Theme G off or a free world: false at once, no dice, no state.
 */
export function tickPets(bot: BotPlayer): boolean {
    if (!periodOn() || !isMembersWorld()) return false;
    const p = bot.player;
    const c = careOf(p);
    if (!c.track) return false;
    listenForDeaths();
    const now = World.currentTick;
    if (c.act) return tickAct(p, c, now);
    // (a pet page open: read at a person's moment, then continued; a warning noted to answer)
    if (petPageOpen(p)) {
        if (c.pageSince === -1) {
            c.pageSince = now;
            c.pageAt = now + between(Math.random, PAGE_READ);
            c.pageCounted = false;
            noteWarning(p, c, now);
        }
        if (!c.pageCounted && now - c.pageSince >= PAGE_OPEN_TICKS) {
            c.pageCounted = true;
            petStats.pagesOpen++;
        }
        if (now >= c.pageAt && botContinuePage(p)) petStats.pagesContinued++;
        return false;
    }
    c.pageSince = -1;
    if ((now + c.phase) % 10 === 0) look(bot, c, now);
    const pet = c.had !== -1 ? petOf(p) : null;
    if (!pet) return false;
    // (a warning's answer first, then the care that is due)
    let due: 'stroke' | 'feed' | null = null;
    if (now < c.waitUntil) return false;
    const answering = c.answer !== null && now >= c.answer.by;
    if (answering) due = c.answer!.kind;
    else if (pet.kind === 'kitten' && now >= c.nextFeed) due = 'feed';
    else if (now >= c.nextStroke) due = 'stroke';
    if (due === null) return false;
    if (!freeToCare(p, answering || urgentCare(p, c, due, pet.kind, now))) {
        // (not now: a fight, a window, a trade; again a little later, its overdue time and its answer kept)
        c.waitUntil = now + 20;
        return false;
    }
    if (answering) c.answer = null;
    schedule(c, due, pet.kind, now);
    if (c.careless && Math.random() < CARELESS_SKIP) {
        petStats.skipped++;
        return false;
    }
    return startAct(bot, c, due, pet.npc, now);
}

/** the next care of this kind, from now */
function schedule(c: Care, kind: 'stroke' | 'feed', pet: PetKind, now: number): void {
    if (kind === 'feed') c.nextFeed = now + jitter(c.feedGap);
    else c.nextStroke = now + jitter(pet === 'kitten' ? c.strokeGap : c.catGap);
}

/** a warning page (hunger at 16 or 18, attention at 40 or 45): answered within 30 s, unless a careless bot skips it */
function noteWarning(p: Player, c: Care, now: number): void {
    const pet = petOf(p);
    if (!pet || pet.kind !== 'kitten') return;
    const needs = petNeeds(p);
    const kind = needs.hunger >= 16 ? 'feed' : needs.attention >= 40 ? 'stroke' : null;
    if (!kind) return;
    petStats.warnings++;
    if (c.careless && Math.random() < CARELESS_SKIP) {
        petStats.skipped++;
        return;
    }
    c.answer = { by: now + between(Math.random, WARNING_ANSWER), kind };
}

/** the click: a stroke (op 3) or a feed (a pet food used on it); false when it cannot (no food: a food trip later) */
function startAct(bot: BotPlayer, c: Care, kind: 'stroke' | 'feed', npc: Npc, now: number): boolean {
    const p = bot.player;
    if (kind === 'feed') {
        const food = petFoodSlot(p);
        if (!food) {
            // (out of pet food: a food trip at the next free moment)
            c.tripLook = Math.min(c.tripLook, now + 5);
            return false;
        }
        if (!botInteractUseObjNpc(p, npc, food.id, food.slot)) return false;
        petStats.fed++;
        if (Math.random() < FEED_LINE) sayPeriodLine(p, 'period', 'pet-feed');
    } else {
        interactNpcOp(p, npc, 3);
        petStats.stroked++;
    }
    if (c.answer?.kind === kind) c.answer = null;
    c.act = { kind, start: now, npc, seen: false };
    return true;
}

/** a care under way: held until its click is done (the walk to the pet, the script, its page continued), or too long */
function tickAct(p: Player, c: Care, now: number): boolean {
    const act = c.act!;
    if (now - act.start > CARE_TICKS || World.currentTick < p.preventLogoutUntil || p.botTradeTargetPid !== -1 || !act.npc.isActive) {
        c.act = null;
        return false;
    }
    if (petPageOpen(p)) {
        act.seen = true;
        if (c.pageSince === -1) {
            c.pageSince = now;
            c.pageAt = now + between(Math.random, PAGE_READ);
        }
        if (now >= c.pageAt && botContinuePage(p)) {
            petStats.pagesContinued++;
            c.pageSince = -1;
        }
        return true;
    }
    c.pageSince = -1;
    if (p.delayed || botScript(p) !== null) {
        act.seen = true;
        return true;
    }
    // (done: the script ran and no page is open, or the interaction is gone)
    if (act.seen || (p.target === null && now - act.start >= 3)) {
        c.act = null;
        return false;
    }
    return true;
}

/** every 10 ticks: the pet's state (lost, grown), its ticks out, and a purchase or a food trip when due */
function look(bot: BotPlayer, c: Care, now: number): void {
    const p = bot.player;
    const obj = petObjOf(p);
    const kind = obj === -1 ? null : petKindOfObj(obj);
    if (c.had !== -1 && obj === -1) {
        // (gone: with its owner's death, else 274's own neglect rule)
        const died = (c.diedAt !== -1 && now - c.diedAt <= 200) || p.levels[PlayerStat.HITPOINTS] <= 0;
        petStats.lost[died ? 'death' : 'neglect']++;
        rebuys.set(p.username, Math.random() < REBUY_CHANCE ? arcsPlay() + between(Math.random, REBUY_PLAY) : Infinity);
        if (!died && Math.random() < LOST_LINE) sayPeriodLine(p, 'period', 'pet-lost');
    } else if (c.had === -1 && obj !== -1) {
        // (a new pet: the first care soon, its kitten's first meal at a person's pace)
        owners.add(p.username);
        c.nextFeed = now + between(Math.random, [300, 900]);
        c.nextStroke = now + between(Math.random, [600, 1200]);
    } else if (obj !== -1 && c.hadKind === 'kitten' && kind === 'cat') {
        petStats.grown++;
        if (Math.random() < GROW_LINE) sayPeriodLine(p, 'period', 'pet-grow');
    }
    if (obj !== -1) petStats.petTicks += now - c.looked;
    c.had = obj;
    c.hadKind = kind;
    c.looked = now;
    // (a trip that came back with no food, its pack full or its coins short at the start: a longer while to the next
    // look, not a trip every TRIP_LOOK that ends at once: the review's G-4)
    if (c.trip !== null && c.trip.result !== '') {
        if (c.trip.result === 'no-food') c.tripLook = Math.max(c.tripLook, now + NO_FOOD_LOOK);
        c.trip = null;
    }
    if (now < c.tripLook) return;
    c.tripLook = now + TRIP_LOOK;
    if (!isCatPerson(p)) return;
    const wantFood = obj !== -1 && kind === 'kitten' && petFoodCarried(p) === 0;
    const wantKitten = obj === -1 && purchaseDue(p);
    if (!wantFood && !wantKitten) return;
    // (food to get: its own fish in the bank, or sardines at Port Sarim, east of White Wolf Mountain: a walk there from
    // Kandarin stalled at the mountain's foot and was rescue-jumped, the probe's trips from Seers and Ardougne both; the
    // coins the trip's shop wants, the kitten's too on a kitten trip: PetTripTask shopCoinsFor)
    const banked = bankedPetFood(p);
    const sarim = p.x >= SARDINES_EAST_OF && coinsOwned(p) >= shopCoinsFor(wantKitten ? 'kitten' : 'food');
    if (wantFood && banked === 0 && !sarim) return;
    if (wantKitten && petFoodCarried(p) + banked < PET_FOOD_WANT && !sarim) return;
    if (!freeForTrip(bot)) {
        c.tripLook = now + 60;
        return;
    }
    petStats.trips++;
    if (wantFood) petStats.foodTrips++;
    c.trip = new PetTripTask(wantKitten ? 'kitten' : 'food');
    bot.setSubTask(c.trip);
}

/** (the trip) the kitten is bought: its line now and then */
export function notePetBought(p: Player): void {
    petStats.bought++;
    owners.add(p.username);
    rebuys.delete(p.username);
    if (Math.random() < BUY_LINE) sayPeriodLine(p, 'period', 'pet-buy');
}

/** (the thread topic `pet`, the answers) has the bot a pet out now; asks the switch */
export function hasPetOut(p: Player): boolean {
    return periodOn() && isMembersWorld() && petObjOf(p) !== -1 && petOf(p) !== null;
}

/** (tests) a bot's care state: its gaps, the next cares, whether it tracks a pet */
export function careForTest(p: Player): Readonly<Care> | null {
    return cares.get(p) ?? null;
}

/** (tests) the bot's next care now (its pet out), or its trip look now */
export function dueCareForTest(p: Player, kind: 'stroke' | 'feed' | 'trip'): void {
    const c = careOf(p);
    const now = World.currentTick;
    if (kind === 'feed') c.nextFeed = now;
    else if (kind === 'stroke') c.nextStroke = now;
    else c.tripLook = now;
}

/** (tests) forget a bot's care (a new one is drawn at its next tick) and its rebuy */
export function forgetCareForTest(p: Player): void {
    cares.delete(p);
    rebuys.delete(p.username);
}

// (the trip's kitten bought: counted and said here; the task imports nothing of this module)
setPetBoughtHook(notePetBought);
