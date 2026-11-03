// port (the bots ideas work, round 1, Track B: PKers loot the human's death pile, vultures, the loot ledger; research
// B-loot): what happens to the human's items when it dies near bots, by 274's own rules.
//
// 274 (content/scripts/player/scripts/death.rs2, engine InvOps both_dropslot / inv_dropall, World.addObj, Zone.revealObj):
// a death with a hero (the player that did the most damage since the victim was last at full Hitpoints) drops the
// tradeables 7 ticks after Hitpoints reach 0, seen by the hero alone for 100 ticks, then by everyone, gone 200 ticks
// after the drop; a death with no hero (an NPC's) drops them public at once, for 200 ticks. Untradeables stay the dead
// player's. The engine refuses a Take on an item a player cannot see, whatever it clicks: a bot only ever sees what its
// client would (receiver64 = nobody or itself), and every take is the real Take (op 3, interactObjOp).
//
//   - the pile: BotWitness sees the human's Hitpoints reach 0 (not a duel's loss) and notes a pile (notePileDeath): where,
//     when. Each tick until the drop the tiles round it are looked at (the objs that were not there at the death), then
//     each item is followed to its end: taken (by whom), gone, or left (lootLog);
//   - the killer (tasks/LootPileTask 'killer'): the PK task that killed the human (startKillLoot), or any bot whose client
//     sees the pile's private items at the drop (a hero the PK tasks did not flag), takes the most valuable stacks first
//     before the reveal, eating its food for room (never dropping: a dropped kit shark is a free item, patch 0004's leak
//     again), then a line; it banks its loot at the Edgeville booth;
//   - vultures (LootPileTask 'vulture'): only bots already within 12 tiles at the death, free, of the trait (vultureOf:
//     a seeded share of PKers and rude levelling bots, a few polite pickers), at most 3 a PvP pile and 2 an NPC's; a PvP
//     pile they wait out (its reveal, a client's guess from the death: "his stuff shows in a min") on a tile of their own,
//     an NPC's they rush (a picker after a minute's courtesy); never into or deeper into the Wilderness for a pile (a
//     PKer may);
//   - the loot ledger: what a PKer took from the human's pile. A PK task's restock gave a whole new pack (upstream's
//     removeAll, which deleted the human's items with the rest): the ledger's quantities now stay (clearPackForRestock);
//     at the Edgeville booth (tasks/LootPileTask LootBooth) it banks them, then restocks. A PKer
//     holding a ledger is held from logging out (BotManager._busy, the give-up's 10 minutes), banks when its session is
//     over, and the ledger is saved with the world (exportLoot, restoreLoot): nothing of the human's vanishes or is
//     copied. A bot keeps its items when it dies (patch 0003), the ledger with them;
//   - lines (data/lines2004-loot.json): the killer's "ty for the {item}", "no loot? lol"; the vultures' "w8 for it",
//     "yoink", "aw he took it all", "finders keepers lol" (to the human, once, through BotWitness's minute: W15); a friendly
//     bot's "ur stuff is still here". At most 4 a pile; each takes the place of its speaker's next line (countAsOwnLine:
//     H7 holds).
// For the other themes: onLoot (a take's value, a miss), onLootRace (two bots for one item: never the human), vultureOf,
// lootLog. Every roll is Math.random (seeded in the sims); the trait is the name's (BotSeed salt 'vulture'); nothing
// reads the wall clock. Per tick: nothing without a pile (a human's death); with one, a 3×3 tile look.
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import { EntityLifeCycle } from '#/engine/entity/EntityLifeCycle.js';
import Obj from '#/engine/entity/Obj.js';
import Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import World from '#/engine/World.js';
import type { Inventory } from '#/engine/Inventory.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import { personaOf } from '#/engine/bot/port/BotPersona.js';
import { itemValue, streetPrice } from '#/engine/bot/port/BotPrices.js';
import { isMultiCombat, wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { worldPlayers } from '#/engine/bot/port/BotPlayers.js';
import { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';
import { sameClique } from '#/engine/bot/port/BotCliques.js';
import { isAway } from '#/engine/bot/port/BotHabits.js';
import { isFleeing } from '#/engine/bot/port/BotDefence.js';
import { BotChat, sayTyped } from '#/engine/bot/port/BotChat.js';
import { tradeScreen } from '#/engine/bot/port/BotTradeScreen.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { isPlayerModName } from '#/engine/bot/port/BotModBot.js';
import { contextOf, NEW_LINES, noteSaid, pickLine, type Line, type LineContext } from '#/engine/bot/port/BotLines.js';
import { countAsOwnLine } from '#/engine/bot/port/BotChatter.js';
import { botFilter } from '#/engine/bot/port/BotFilter.js';
import { styleLine } from '#/engine/bot/port/BotStyle.js';
import { botPersona, reactionTicks } from '#/engine/bot/port/BotTiming.js';
import { itemSay } from '#/engine/bot/port/BotSlots.js';
import { noteSpoke } from '#/engine/bot/port/BotSpoke.js';
import type { LineKind } from '#/engine/bot/port/BotSay.js';
import { depositItems } from '#/engine/bot/port/BotInventoryCompat.js';
import { pkFoods, pkTeleItems, vialsOf } from '#/engine/bot/port/BotPkFight.js';
import type { PkProfile } from '#/engine/bot/port/BotPkGear.js';
import type { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';
import { lootTasks } from '#/engine/bot/port/BotLootFactory.js';
// (BotWitness's one word a minute to a human: W15; function declarations, read at a death only)
import { humanReactionFree, noteHumanReaction } from '#/engine/bot/port/BotWitness.js';

// ── the numbers ─────────────────────────────────────────────────────────────────────

/** the drop comes this many ticks after Hitpoints reach 0 (274: ~player_death's delays); the reveal 100 after it */
export const DROP_AFTER = 7;
export const REVEAL_AFTER = 100;
/** a pile's items last this long after the drop (^lootdrop_duration) */
export const PILE_LIFE = 200;
/** vultures: only bots this near at the death */
export const VULTURE_RANGE = 12;
/** a hero the PK tasks did not flag: a bot whose client sees the pile's private items within this, at the drop */
export const HERO_RANGE = 15;
/** at most this many vultures a pile: a PvP pile (a hero's), an NPC's */
export const VULTURES_PVP = 3;
export const VULTURES_NPC = 2;
/** the trait's shares (salt 'vulture'): PKers looters, rude levelling bots looters, other levelling bots pickers */
const PKER_LOOTER = 0.35;
const RUDE_LOOTER = 0.5;
const PICKER = 0.12;
/** a trait's chance to enrol at one death */
const ENROL: Readonly<Record<Exclude<VultureTrait, null>, number>> = { looter: 0.6, picker: 0.35 };
/** at most this many loot and vulture lines a pile */
const PILE_LINES = 4;
/** a vulture holding the human's items answers its coming back within this (3 minutes), within VULTURE_BACK_RANGE */
const VULTURE_BACK_TICKS = 300;
const VULTURE_BACK_RANGE = 6;
const VULTURE_BACK_CHANCE = 0.5;
/** the polite word: a friendly bot near the pile when the human comes back (within 8) and items lie there */
const POLITE_RANGE = 8;
const POLITE_CHANCE = 0.2;
/** the killer banks at once with this much in its ledger, or this many stacks, or a kit id */
export const BANK_VALUE = 10_000;
export const BANK_STACKS = 6;

// ── the trait ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** a looter rushes a pile; a picker (polite) takes leftovers late; null: never */
export type VultureTrait = 'looter' | 'picker' | null;

function isPker(planner: string | null | undefined): boolean {
    return planner === 'extras_pker' || planner === 'extras_edgeville_pker';
}

/**
 * The name's habit at a pile (deterministic: BotSeed salt 'vulture'): PKers 35 % looters, levelling bots that do rude
 * things 50 % looters, the other levelling bots 12 % pickers; vendors, social regulars and the mod bot never. A newbie
 * never (isNewbie, at the death).
 */
export function vultureOf(name: string, planner?: PlannerKey | string | null): VultureTrait {
    if (!planner || isPlayerModName(name)) return null;
    const r = seededRandom(nameSeed(name, 'vulture'))();
    if (isPker(planner)) return r < PKER_LOOTER ? 'looter' : null;
    if (!isLevelling(planner as PlannerKey)) return null;
    if (personaOf(name, planner as PlannerKey).rudeActs) return r < RUDE_LOOTER ? 'looter' : null;
    return r < PICKER ? 'picker' : null;
}

// ── the log (the humanlike runner's LV metrics; the tests) ─────────────────────────────────────────────────────────

export type LootEventKind = 'death' | 'drop' | 'visible' | 'take' | 'eat' | 'line' | 'bank' | 'gone' | 'enrol' | 'giveup' | 'race' | 'used' | 'quit' | 'unsaved';

export interface LootEvent {
    t: number;
    pile: number;
    kind: LootEventKind;
    /** the bot or player (its username), '?' for nobody known */
    who: string;
    /** 'killer' | 'vulture' | 'other' | 'human' | the trait | the line's event ... */
    role?: string;
    item?: number;
    count?: number;
    value?: number;
    /** (death) the place; (enrol) the bot's; (take) the item's */
    x?: number;
    z?: number;
    /** (death, enrol) Wilderness levels: the pile's, the bot's */
    wild?: number;
    botWild?: number;
    /** (death) a PvP death by its hero points (a guess the bots never use); (drop) the item's first viewer: the hero's name, 'public', 'owner' */
    pvp?: boolean;
    hero?: string;
    /** (drop) the reveal and the end; (take) taken before the reveal */
    revealAt?: number;
    goneAt?: number;
    early?: boolean;
    /** (line) to the human; (enrol) a PKer; a mate of the hero */
    to?: string;
    pk?: boolean;
    mate?: boolean;
}

export const lootLog: LootEvent[] = [];
const LOG_MAX = 20000;
function log(e: LootEvent): void {
    if (lootLog.length < LOG_MAX) lootLog.push(e);
}
/** (tasks/LootPileTask) an event of a pile's sub-task */
export function logLoot(e: LootEvent): void {
    log(e);
}

// ── listeners (the other themes: moods, grudges) ───────────────────────────────────────────────────────────────────

export interface LootNews {
    bot: Player;
    /** what it took (street or value), 0 for a miss */
    value: number;
    kind: 'killer' | 'vulture' | 'missed';
}
const lootListeners: ((news: LootNews) => void)[] = [];
/** told when a bot is done at a pile: what it took (or that it missed) */
export function onLoot(listener: (news: LootNews) => void): void {
    lootListeners.push(listener);
}
const raceListeners: ((race: { a: Player; b: Player; kind: 'loot-race' }) => void)[] = [];
/** told when two bots went for one item and `a` got it (bots only: never the human) */
export function onLootRace(listener: (race: { a: Player; b: Player; kind: 'loot-race' }) => void): void {
    raceListeners.push(listener);
}
/** (theme D's ties) two bots' rivalry: the wine crowd's (port/BotMagicRuns), the safespots' (port/BotSafespots); `a` won */
export type RivalryKind = 'wine' | 'safespot';
const rivalryListeners: ((rivalry: { a: Player; b: Player; kind: RivalryKind }) => void)[] = [];
export function onRivalry(listener: (rivalry: { a: Player; b: Player; kind: RivalryKind }) => void): void {
    rivalryListeners.push(listener);
}
export function noteRivalry(a: Player, b: Player, kind: RivalryKind): void {
    if (!a.is_bot || !b.is_bot || a === b) return;
    for (const l of rivalryListeners) {
        try {
            l({ a, b, kind });
        } catch {
            /* a listener never stops the game */
        }
    }
}
export function tellLoot(news: LootNews): void {
    for (const l of lootListeners) {
        try {
            l(news);
        } catch {
            /* a listener never stops the game */
        }
    }
}

// ── the piles ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Pile {
    readonly id: number;
    readonly human: Player;
    /** the death's tile, then the drop's (the dying human can be a step or two on by then) */
    x: number;
    z: number;
    readonly level: number;
    readonly diedAt: number;
    /** the tick the items appeared (null: not yet), the reveal (the drop for a public pile) and the end */
    dropAt: number | null;
    revealAt: number;
    goneAt: number;
    /** a hero by its points at the death (a guess, for the caps and the log: the bots go by what they see) */
    readonly pvp: boolean;
    /** the hero by its points (the killer the bots know of), and by the drop (whose the items are) */
    readonly heroGuess: Player | null;
    hero: Player | null;
    /** the Wilderness level and multi-combat at the pile */
    readonly wild: number;
    readonly multi: boolean;
    /** the items on the ground when it died (not the pile's), and the pile's own */
    readonly before: Set<Obj>;
    readonly objs: Obj[];
    /** the pile's items accounted for (taken, gone) */
    readonly ended: Set<Obj>;
    /** an item seen gone, the tick (its taker logs it; else the registry, two ticks on) */
    readonly missing: Map<Obj, number>;
    /** who took what (an item: the bot that logged its take) */
    readonly takers: Map<Obj, Player>;
    /** (bots ideas, round 1, the fixes: B1) a take the ground guessed (followItems), its log entry: its taker's task corrects it */
    readonly guessed: Map<Obj, LootEvent>;
    readonly vultures: Player[];
    /** the killer's task is on it */
    killer: Player | null;
    /** loot and vulture lines said for it */
    lines: number;
    /** the first vulture's word said (one waiter, one first arrival) */
    waitSaid: boolean;
    npcSaid: boolean;
    politeSaid: boolean;
    /** mates of the hero enrolled at the reveal (once) */
    matesDone: boolean;
}

let nextPileId = 1;
const piles: Pile[] = [];
/** what a vulture holds of the human's: its value, when it took it, whether it said its word back */
const holders = new Map<Player, { pile: Pile; at: number; said: boolean }>();

/** the human's pile now (the newest of its deaths still on the ground), or null */
export function pileFor(human: Player): Pile | null {
    for (let i = piles.length - 1; i >= 0; i--) if (piles[i].human === human) return piles[i];
    return null;
}

/** every pile on the ground (tests, the runner) */
export function activePiles(): readonly Pile[] {
    return piles;
}

/** the items within `r` of (x, z) on `level` (a 3×3 look: every item, whoever sees it) */
function objsAround(x: number, z: number, level: number, r: number): Obj[] {
    const out: Obj[] = [];
    const map = World.gameMap;
    const seen = new Set<unknown>();
    for (let dx = -r; dx <= r; dx += r || 1) {
        for (let dz = -r; dz <= r; dz += r || 1) {
            const zone = map.getZone(x + dx, z + dz, level);
            if (!zone || seen.has(zone)) continue;
            seen.add(zone);
            for (const obj of zone.getAllObjsUnsafe()) {
                if (obj.level === level && Math.abs(obj.x - x) <= r && Math.abs(obj.z - z) <= r) out.push(obj);
            }
        }
    }
    return out;
}

/** the hero by its points at this moment (274's findhero: the most points), online, or null */
function heroByPoints(victim: Player): Player | null {
    let best: { hash64: bigint; points: number } | null = null;
    for (const h of victim.heroPoints) if (h && h.hash64 !== -1n && h.points > 0 && (!best || h.points > best.points)) best = h;
    if (!best) return null;
    for (const p of worldPlayers()) if (p.hash64 === best.hash64 && p.slot !== -1) return p;
    return null;
}

/**
 * (BotWitness: the human's Hitpoints reached 0 at (x, z), not a duel's loss) a pile to come: its place and time, and
 * the vultures near enough to have seen it. Once a death (a pile of the same human within the last 20 ticks is it).
 */
export function notePileDeath(human: Player, now: number = World.currentTick): Pile | null {
    if (human.is_bot) return null;
    const last = pileFor(human);
    if (last && now - last.diedAt <= 20) return last;
    const hero = heroByPoints(human);
    const wild = wildernessLevelAt(human.x, human.z);
    const pile: Pile = {
        id: nextPileId++,
        human,
        x: human.x,
        z: human.z,
        level: human.level,
        diedAt: now,
        dropAt: null,
        revealAt: now + DROP_AFTER + (hero ? REVEAL_AFTER : 0),
        goneAt: now + DROP_AFTER + PILE_LIFE,
        pvp: hero !== null,
        heroGuess: hero,
        hero: null,
        wild,
        multi: isMultiCombat(human.x, human.z, human.level),
        before: new Set(objsAround(human.x, human.z, human.level, DROP_SEARCH)),
        objs: [],
        ended: new Set(),
        missing: new Map(),
        takers: new Map(),
        guessed: new Map(),
        vultures: [],
        killer: null,
        lines: 0,
        waitSaid: false,
        npcSaid: false,
        politeSaid: false,
        matesDone: false
    };
    piles.push(pile);
    log({ t: now, pile: pile.id, kind: 'death', who: human.username, x: pile.x, z: pile.z, wild, pvp: pile.pvp, hero: hero?.username });
    enrolVultures(pile, now, false);
    return pile;
}

/** BotWitness's tick (every tick a human is in the world): each pile's drop, its items' ends, the words back */
export function tickPiles(now: number = World.currentTick): void {
    if (piles.length === 0 && holders.size === 0) return;
    for (let i = piles.length - 1; i >= 0; i--) {
        const pile = piles[i];
        if (pile.dropAt === null || now <= pile.dropAt + 1) findDrop(pile, now);
        followItems(pile, now);
        if (!pile.matesDone && now >= pile.revealAt && pile.dropAt !== null) {
            pile.matesDone = true;
            if (pile.revealAt > pile.dropAt) enrolVultures(pile, now, true);
        }
        politeWord(pile, now);
        // (a few ticks past its end; a pile with nothing dropped, a death with nothing tradeable, 30 ticks after the death)
        if (now > pile.goneAt + 5 || (pile.dropAt === null && now > pile.diedAt + 30)) {
            endPile(pile, now);
            piles.splice(i, 1);
        }
    }
    vultureBack(now);
}

/** the drop is looked for this far round the death's tile (the dying human can walk a step or two on: seed 7 of loot.test) */
const DROP_SEARCH = 3;

/**
 * the items that appeared round the death's tile since (the drop: both_dropslot / inv_dropall, all at once on the human's
 * tile): new, fresh (a full life left) and, once one is found, on its tile with its life
 */
function findDrop(pile: Pile, now: number): void {
    const first = pile.objs[0] ?? null;
    let fresh: Obj[] = [];
    for (const obj of objsAround(pile.x, pile.z, pile.level, first ? 0 : DROP_SEARCH)) {
        if (pile.before.has(obj) || pile.objs.includes(obj) || !obj.isActive || obj.lifecycle !== EntityLifeCycle.DESPAWN) continue;
        if (obj.lifecycleTick < PILE_LIFE - 2 || (first && (obj.x !== first.x || obj.z !== first.z))) continue;
        // (the dead human's own untradeables: never a bot's)
        if (obj.receiver64 === pile.human.hash64) {
            pile.before.add(obj);
            continue;
        }
        // (bots ideas, round 1, the fixes: B4) the human's drop is public (no hero) or its hero's (its points at the death):
        // a bot's own fresh drop by the death (a giant it killed: private to it) is not the pile, nor its owner the hero
        if (obj.receiver64 !== Obj.NO_RECEIVER && obj.receiver64 !== pile.heroGuess?.hash64) continue;
        fresh.push(obj);
    }
    // (the drop's tile, at its first sight: the one nearest the death's, where the human fell)
    if (!first && fresh.length > 0) {
        const d = (o: Obj): number => Math.max(Math.abs(o.x - pile.x), Math.abs(o.z - pile.z));
        const near = fresh.reduce((a, b) => (d(b) < d(a) ? b : a));
        fresh = fresh.filter(o => o.x === near.x && o.z === near.z);
    }
    for (const obj of fresh) {
        if (pile.dropAt === null) {
            pile.dropAt = now;
            pile.x = obj.x;
            pile.z = obj.z;
            const privateTo = obj.receiver64 !== Obj.NO_RECEIVER;
            pile.revealAt = privateTo ? now + Math.max(0, obj.reveal) : now;
            pile.goneAt = now + Math.max(0, obj.lifecycleTick);
            if (privateTo) for (const p of worldPlayers()) if (p.hash64 === obj.receiver64) pile.hero = p;
        }
        pile.objs.push(obj);
        const hero = obj.receiver64 === Obj.NO_RECEIVER ? 'public' : (pile.hero?.username ?? '?');
        log({ t: now, pile: pile.id, kind: 'drop', who: pile.human.username, item: obj.type, count: obj.count, value: valueOf(obj.type, obj.count), hero, revealAt: pile.revealAt, goneAt: pile.goneAt, x: obj.x, z: obj.z });
    }
    if (pile.dropAt === now && pile.hero && pile.hero.is_bot && pile.killer === null) {
        // a hero the PK tasks did not flag: its client sees the items
        const h = pile.hero;
        if (Math.max(Math.abs(h.x - pile.x), Math.abs(h.z - pile.z)) <= HERO_RANGE && h.level === pile.level) startKillLoot(h, pile.human);
    }
}

/** each item of the pile: gone from the ground, taken (its taker logs it, else whoever stands on it) or gone at its end */
function followItems(pile: Pile, now: number): void {
    for (const obj of pile.objs) {
        if (pile.ended.has(obj)) continue;
        if (obj.isActive && obj.count > 0) continue;
        const seen = pile.missing.get(obj);
        if (seen === undefined) {
            pile.missing.set(obj, now);
            continue;
        }
        // (two ticks for its taker's task to log it)
        if (now - seen < 2) continue;
        pile.ended.add(obj);
        if (seen >= pile.goneAt - 1) {
            log({ t: seen, pile: pile.id, kind: 'gone', who: '?', item: obj.type, count: obj.count, value: valueOf(obj.type, obj.count) });
            continue;
        }
        const taker = standingOn(obj);
        const guess: LootEvent = { t: seen, pile: pile.id, kind: 'take', who: taker?.username ?? '?', role: taker ? (taker.is_bot ? 'other' : taker === pile.human ? 'owner' : 'human') : '?', item: obj.type, count: obj.count, value: valueOf(obj.type, obj.count), early: seen < pile.revealAt, x: obj.x, z: obj.z };
        log(guess);
        pile.guessed.set(obj, guess);
    }
}

/** a player on the item's tile (or beside it), the human first: who took it, as far as the ground tells */
function standingOn(obj: Obj): Player | null {
    let best: Player | null = null;
    for (const p of worldPlayers()) {
        if (p.slot === -1 || p.level !== obj.level || Math.max(Math.abs(p.x - obj.x), Math.abs(p.z - obj.z)) > 1) continue;
        if (!best || (!p.is_bot && best.is_bot) || (p.x === obj.x && p.z === obj.z)) best = p;
    }
    return best;
}

function endPile(pile: Pile, now: number): void {
    for (const obj of pile.objs) {
        if (pile.ended.has(obj)) continue;
        pile.ended.add(obj);
        log({ t: now, pile: pile.id, kind: 'gone', who: '?', item: obj.type, count: obj.count, value: valueOf(obj.type, obj.count) });
    }
}

/**
 * (a take by a LootPileTask) `bot` took `count` of the pile's `obj` (seen in its pack): logged, the ledger for a PKer,
 * the holder for its word back; `role` 'killer' or 'vulture'
 */
export function noteTake(pile: Pile, obj: Obj, bot: Player, count: number, role: 'killer' | 'vulture'): void {
    const now = World.currentTick;
    const value = valueOf(obj.type, count);
    if (pile.ended.has(obj)) {
        // (bots ideas, round 1, the fixes: B1) taken while its task did not look (a monster's fight, a sub-task's end): the
        // ground's guess logged it two ticks on; the take is this bot's, and its ledger's
        const guess = pile.takers.has(obj) ? undefined : pile.guessed.get(obj);
        if (!guess || guess.kind !== 'take') return;
        Object.assign(guess, { who: bot.username, role, count, value });
    } else {
        pile.ended.add(obj);
        const seen = pile.missing.get(obj) ?? now;
        log({ t: seen, pile: pile.id, kind: 'take', who: bot.username, role, item: obj.type, count, value, early: seen < pile.revealAt, x: obj.x, z: obj.z });
    }
    pile.takers.set(obj, bot);
    if (isPker(bot.botPlanner)) addToLedger(bot, obj.type, count);
    if (role === 'vulture') holders.set(bot, { pile, at: now, said: false });
}

/** (a LootPileTask's click that came to nothing: another took the item) a race between two bots, when it was a bot */
export function noteMissed(pile: Pile, obj: Obj, bot: Player): void {
    const winner = pile.takers.get(obj) ?? standingOn(obj);
    if (!winner || !winner.is_bot || winner === bot) return;
    log({ t: World.currentTick, pile: pile.id, kind: 'race', who: winner.username, to: bot.username, item: obj.type });
    for (const l of raceListeners) {
        try {
            l({ a: winner, b: bot, kind: 'loot-race' });
        } catch {
            /* a listener never stops the game */
        }
    }
}

/** (tests and the runner) the pile an item belongs to, or null */
export function pileOfObj(obj: Obj): Pile | null {
    for (const pile of piles) if (pile.objs.includes(obj)) return pile;
    return null;
}

/** what an item is worth to a player: its 2004 street price, else its value, times the count */
export function valueOf(id: number, count = 1): number {
    return (streetPrice(id) ?? itemValue(id)) * count;
}

/** the pile's items this bot's client sees (nobody's or its own), most valuable first */
export function pileView(bot: Player, pile: Pile): Obj[] {
    const out = pile.objs.filter(o => o.isActive && o.count > 0 && !pile.ended.has(o) && (o.receiver64 === Obj.NO_RECEIVER || o.receiver64 === bot.hash64));
    return out.sort((a, b) => valueOf(b.type, b.count) - valueOf(a.type, a.count));
}

/** the pile's value as it fell (every item, whoever sees it) */
export function pileValue(pile: Pile): number {
    return pile.objs.reduce((n, o) => n + valueOf(o.type, o.count), 0);
}

// ── who may be a vulture ───────────────────────────────────────────────────────────────────────────────────────────

/** the PK team raid a bot is in (port/BotPkTeam: through port/BotSetPieces), or null */
function raidOf(p: Player): { kind: string; sameTeam(a: Player, b: Player): boolean } | null {
    const run = eventRoleOf(p)?.run as { kind?: string; sameTeam?: unknown } | null | undefined;
    return run && run.kind === 'pk_raid' && typeof run.sameTeam === 'function' ? (run as { kind: string; sameTeam(a: Player, b: Player): boolean }) : null;
}

/** a mate of the hero: its clique or its raid team */
function mateOf(hero: Player | null, p: Player): boolean {
    if (!hero) return false;
    return sameClique(hero.username, p.username) || raidOf(hero)?.sameTeam(hero, p) === true;
}

/** is the bot free to go for a pile: no fight, sub-task, set piece (a raid of another team's excepted), trade, break, talk */
function freeForPile(p: Player, hero: Player | null): boolean {
    const ai = BotManager.botFor(p);
    if (!ai || ai.hasSubTask()) return false;
    if (p.target !== null || p.delayed || p.levels[PlayerStat.HITPOINTS] <= 0) return false;
    const task = ai.currentTask as unknown as { target?: Player | null } | null;
    if (task && task.target) return false;
    const role = eventRoleOf(p);
    if (role) {
        const raid = raidOf(p);
        if (!raid || (hero && raid.sameTeam(hero, p))) return false;
    }
    if (p.botTradeTargetPid !== -1 || tradeScreen(p) !== null) return false;
    if (isAway(p) || isFleeing(p) || BotChat.inConversation(p)) return false;
    // (its session over: it wraps up)
    if (BotManager.sessionLeftOf(p.username) <= 0) return false;
    return true;
}

/**
 * The vultures of a pile: bots already within VULTURE_RANGE of it (never called from afar), free, of the trait, at its
 * chance, nearest first, up to the cap; not the hero nor its mates (`mates`: at the reveal, only the hero's mates, who
 * may take leftovers then). A bot that is not a PKer never goes into the Wilderness, nor deeper into it, for a pile.
 */
function enrolVultures(pile: Pile, now: number, mates: boolean): void {
    const hero = pile.hero ?? pile.heroGuess;
    const cap = pile.pvp ? VULTURES_PVP : VULTURES_NPC;
    if (pile.vultures.length >= cap) return;
    const near: [Player, number][] = [];
    for (const p of BotManager.activeBots()) {
        if (p === hero || p === pile.killer || p.level !== pile.level || pile.vultures.includes(p)) continue;
        const d = Math.max(Math.abs(p.x - pile.x), Math.abs(p.z - pile.z));
        if (d > VULTURE_RANGE) continue;
        if (mateOf(hero, p) !== mates) continue;
        near.push([p, d]);
    }
    near.sort((a, b) => a[1] - b[1]);
    for (const [p, d] of near) {
        if (pile.vultures.length >= cap) break;
        const trait = testRates.trait?.(p) ?? vultureOf(p.username, p.botPlanner);
        if (!trait || isNewbie(p)) continue;
        const pk = isPker(p.botPlanner);
        const botWild = wildernessLevelAt(p.x, p.z);
        if (!pk && pile.wild > 0 && (botWild <= 0 || pile.wild > botWild)) continue;
        if (!freeForPile(p, hero)) continue;
        if (Math.random() >= (testRates.enrol ?? ENROL[trait])) continue;
        const task = makeTask(pile, 'vulture', trait, p);
        if (!task) continue;
        pile.vultures.push(p);
        BotManager.botFor(p)!.setSubTask(task);
        log({ t: now, pile: pile.id, kind: 'enrol', who: p.username, role: trait, x: p.x, z: p.z, wild: pile.wild, botWild, pk, mate: mates || undefined, value: d });
    }
}

// ── the killer ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** the sub-task a pile asks for: tasks/LootPileTask's, registered in port/BotLootFactory (this module loads no task class) */
function makeTask(pile: Pile, role: 'killer' | 'vulture', trait: VultureTrait, bot: Player): BotTask | null {
    return lootTasks.make?.(pile, role, trait, bot) ?? null;
}

/**
 * (a PK task's 'killed' with the human as its target; a hero seen at the drop) the killer goes to the pile and takes
 * what its client sees, before the reveal. True when it does. A bot on another sub-task, or whose killing was of a bot
 * (bots drop nothing: patch 0003), does not.
 */
export function startKillLoot(killer: Player, victim: Player): boolean {
    if (!killer.is_bot || victim.is_bot) return false;
    const ai = BotManager.botFor(killer);
    if (!ai || ai.hasSubTask()) return false;
    const pile = pileFor(victim) ?? notePileDeath(victim);
    if (!pile || pile.killer !== null || World.currentTick > pile.diedAt + 20) return false;
    const task = makeTask(pile, 'killer', null, killer);
    if (!task) return false;
    pile.killer = killer;
    ai.setSubTask(task);
    return true;
}

// ── lines ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const pools = new Map<string, readonly Line[]>();
function poolOf(event: string): readonly Line[] {
    let pool = pools.get(event);
    if (!pool) {
        pool = NEW_LINES.filter(l => l.tag.event === event);
        pools.set(event, pool);
    }
    return pool;
}

/** the loot lines' events (tests, the chat filter's checks) */
export const LOOT_EVENTS = ['pk-loot', 'pk-junk', 'pk-full', 'vulture-wait', 'vulture-take', 'vulture-miss', 'vulture-npc', 'vulture-back', 'pile-polite'] as const;

/**
 * `bot` says a line of `event`'s group (data/lines2004-loot.json), typed after it notices: one that fits and is fresh
 * (the repetition registry), {item} filled when given (a filled line the word filter would star: one without the item),
 * in its persona's style; it takes the place of the bot's next line (countAsOwnLine: H7). True when one was said.
 * `pile`: counted against its 4 (and logged); `to`: said to the human (a reaction). Exported for the wine crowd, the
 * safespots and the camps (no pile).
 */
export function sayLootLine(bot: Player, event: string, opts: { pile?: Pile | null; item?: string | null; to?: Player | null; kind?: LineKind; delay?: number } = {}): boolean {
    const now = World.currentTick;
    if (opts.pile && opts.pile.lines >= PILE_LINES) return false;
    if (isAway(bot) || BotChat.inConversation(bot) || BotChat.midTalk(bot)) return false;
    const pool = poolOf(event);
    if (pool.length === 0) return false;
    const persona = botPersona(bot);
    const attempt = (item: string | null): { text: string; template?: string; line: string } | null => {
        const ctx: LineContext = contextOf(bot, new Map([[event, { tick: now }]]));
        ctx.slots = { ...(ctx.slots ?? {}) };
        if (item) ctx.slots.item = item;
        else delete ctx.slots.item;
        const picked = pickLine(ctx, { event }, Math.random, pool);
        if (!picked) return null;
        const styled = styleLine(picked.text, persona).line;
        if (botFilter(styled) !== styled) return null;
        return { text: picked.text, template: picked.template, line: styled };
    };
    const got = (opts.item ? attempt(opts.item) : null) ?? attempt(null);
    if (!got) return false;
    noteSaid(bot, got.text, now, got.template);
    const to = opts.to ?? null;
    const kind: LineKind = opts.kind ?? (to && !to.is_bot ? 'reaction' : 'event');
    sayTyped(bot, got.line, { to, kind, then: () => noteSpoke(bot, 'event', World.currentTick, to) }, opts.delay ?? reactionTicks(persona, 'notice'));
    countAsOwnLine(bot);
    if (opts.pile) {
        opts.pile.lines++;
        log({ t: now, pile: opts.pile.id, kind: 'line', who: bot.username, role: event, to: to && !to.is_bot ? to.username : undefined });
    } else log({ t: now, pile: 0, kind: 'line', who: bot.username, role: event, to: to && !to.is_bot ? to.username : undefined });
    return true;
}

/** an item as players named it ("rune scim", "addy kite"), or null */
export function lootSay(id: number): string | null {
    return itemSay(ObjType.get(id)?.name ?? '');
}

// ── the words to the human (through BotWitness's minute: W15) ──────────────────────────────────────────────────────


/** a vulture holding the human's items, the human back within 6 tiles within 3 minutes: "finders keepers lol" (once, half the time) */
function vultureBack(now: number): void {
    for (const [bot, h] of holders) {
        if (bot.slot === -1 || now - h.at > VULTURE_BACK_TICKS) {
            holders.delete(bot);
            continue;
        }
        if (h.said) continue;
        const human = h.pile.human;
        if (human.slot === -1 || human.level !== bot.level || human.levels[PlayerStat.HITPOINTS] <= 0) continue;
        if (Math.max(Math.abs(human.x - bot.x), Math.abs(human.z - bot.z)) > VULTURE_BACK_RANGE) continue;
        h.said = true;
        if (Math.random() >= (testRates.back ?? VULTURE_BACK_CHANCE)) continue;
        if (!humanReactionFree(human, now)) continue;
        if (sayLootLine(bot, 'vulture-back', { pile: h.pile, to: human, kind: 'reaction' })) noteHumanReaction(human, now);
    }
}

/** an NPC death's pile, items still there, the human back within 8 tiles: a friendly bot near that takes none may say so */
function politeWord(pile: Pile, now: number): void {
    if (pile.politeSaid || pile.dropAt === null || now < pile.dropAt + 5) return;
    const human = pile.human;
    if (human.slot === -1 || human.level !== pile.level || human.levels[PlayerStat.HITPOINTS] <= 0) return;
    if (Math.max(Math.abs(human.x - pile.x), Math.abs(human.z - pile.z)) > POLITE_RANGE) return;
    if (!pile.objs.some(o => o.isActive && o.count > 0 && o.receiver64 === Obj.NO_RECEIVER && !pile.ended.has(o))) return;
    pile.politeSaid = true;
    politeStats.near++;
    if (Math.random() >= (testRates.polite ?? POLITE_CHANCE)) return;
    if (!humanReactionFree(human, now)) {
        politeStats.gap++;
        return;
    }
    let best: Player | null = null;
    let bestD = POLITE_RANGE + 1;
    for (const p of BotManager.activeBots()) {
        if (p.level !== pile.level || pile.vultures.includes(p) || p === pile.killer) continue;
        const d = Math.max(Math.abs(p.x - pile.x), Math.abs(p.z - pile.z));
        if (d >= bestD || vultureOf(p.username, p.botPlanner) === 'looter' || botPersona(p).friendliness <= 0.4) continue;
        best = p;
        bestD = d;
    }
    if (!best) politeStats.nobody++;
    else if (sayLootLine(best, 'pile-polite', { pile, to: human, kind: 'reaction' })) {
        politeStats.said++;
        noteHumanReaction(human, now);
    } else politeStats.unsaid++;
}
/** (tests, the report) the polite word's chances: the human back by its items, the minute's gap, nobody to say it, said */
export const politeStats = { near: 0, gap: 0, nobody: 0, unsaid: 0, said: 0 };

// ── the ledger ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** per PKer (by username): what of the human's it took, by item, until banked */
const ledgers = new Map<string, Map<number, number>>();
/** the most bots and stacks a saved ledger holds (bots.sav stays small) */
const SAVED_BOTS = 32;
const SAVED_STACKS = 28;
/**
 * (bots ideas, round 1, the fixes: B6) per PKer: each item's newest take, as the bot's playtime then (274 saves the
 * playtime with the pack: Player.save). The world's state goes with every write of the store, a bot's own save only at
 * its occasions (a logout, an autosave), so a world restored after a kill of the app can hold takes its bot's save never
 * had: a ledger of sharks the bot's pack held only its kit's of, banked at the booth as the human's (items from nothing).
 * A restored ledger's items taken after the bot's own save (its playtime at the login less than the take's) are dropped
 * at its login (they went with the app's kill: logged 'unsaved').
 */
const stamps = new Map<string, Map<number, number>>();
/** restored ledgers' stamps, for the bot's login (noteLootLogin) */
const restored = new Map<string, Map<number, number>>();

function addToLedger(bot: Player, id: number, count: number): void {
    let l = ledgers.get(bot.username);
    if (!l) ledgers.set(bot.username, (l = new Map()));
    l.set(id, (l.get(id) ?? 0) + count);
    let at = stamps.get(bot.username);
    if (!at) stamps.set(bot.username, (at = new Map()));
    at.set(id, bot.playtime);
}

/** a PKer's ledger gone (banked, used up, left with the bot): its stamps with it */
function deleteLedger(name: string): void {
    ledgers.delete(name);
    stamps.delete(name);
    restored.delete(name);
}

/**
 * (bots ideas, round 1, the fixes: B5; BotManager._drop: a bot out of the pool for good, a quit or a human's login with
 * its name) its ledger goes with it, as a quitting player's items did (logged 'quit'): kept, it was saved from store to
 * store and took a place of the 32 a live one needed (exportLoot), whose bot then lost the human's items at a restock
 * after a restart
 */
export function dropLedger(name: string): void {
    const l = ledgers.get(name);
    deleteLedger(name);
    if (l) for (const [id, count] of l) log({ t: World.currentTick, pile: 0, kind: 'quit', who: name, item: id, count });
}

/** (bots ideas, round 1, the fixes: B6; BotManager: a bot's login) a restored ledger against the bot's own save */
export function noteLootLogin(player: Player): void {
    const r = restored.get(player.username);
    if (!r) return;
    restored.delete(player.username);
    const l = ledgers.get(player.username);
    if (!l) return;
    for (const [id, at] of r) {
        const count = l.get(id);
        if (count === undefined || player.playtime >= at) continue;
        log({ t: World.currentTick, pile: 0, kind: 'unsaved', who: player.username, item: id, count });
        l.delete(id);
    }
    if (l.size === 0) deleteLedger(player.username);
}

/** does this PKer hold the human's items (a ledger not yet banked)? */
export function holdsLoot(player: Player): boolean {
    return (ledgers.get(player.username)?.size ?? 0) > 0;
}

/** what of `id` its ledger keeps (a restock deletes none of it) */
export function ledgerKeep(player: Player, id: number): number {
    return ledgers.get(player.username)?.get(id) ?? 0;
}

/** the ledger (tests, the runner): item → count */
export function ledgerOf(name: string): ReadonlyMap<number, number> {
    return ledgers.get(name) ?? new Map();
}

/** the ledger's value (street or value) */
export function ledgerValue(player: Player): number {
    let n = 0;
    for (const [id, count] of ledgers.get(player.username) ?? []) n += valueOf(id, count);
    return n;
}

/** (the ledger lost items through play: eaten in a fight, a full pack's add) the ledger no more than the pack holds */
function trimLedger(player: Player): void {
    const l = ledgers.get(player.username);
    const inv = player.getInventory(InvType.INV);
    if (!l || !inv) return;
    for (const [id, count] of [...l]) {
        const have = inv.getItemCount(id);
        if (have < count) {
            log({ t: World.currentTick, pile: 0, kind: 'used', who: player.username, item: id, count: count - have });
            if (have <= 0) l.delete(id);
            else l.set(id, have);
        }
    }
    if (l.size === 0) deleteLedger(player.username);
}

/**
 * The PK kit's items: what its restock gives (the profile's gear, food, potions and their vials, the way out) and what
 * its fights leave of them (an empty vial, a glory's charges). A ledger holding one of them banks at once (lootBankDue):
 * the human's sharks would be eaten as its own.
 */
export function pkKitFamily(profile: PkProfile): Set<number> {
    const out = new Set<number>();
    const add = (id: number | undefined): void => {
        if (id !== undefined && id !== -1) out.add(id);
    };
    for (const id of [profile.weapon, profile.helm, profile.body, profile.legs, profile.shield, profile.neck, profile.cape, profile.boots, profile.gloves, profile.ammo, profile.specWeapon, profile.rangeWeapon, profile.food]) add(id);
    for (const pot of profile.pots) {
        add(pot);
        for (const v of vialsOf(pot)) add(v);
    }
    for (const id of pkFoods(profile)) add(id);
    for (const [id] of pkTeleItems(profile)) add(id);
    for (const name of ['vial_empty', 'amulet_of_glory', 'amulet_of_glory_1', 'amulet_of_glory_2', 'amulet_of_glory_3', 'amulet_of_glory_4']) add(ObjType.getId(name));
    return out;
}

/**
 * (both PK tasks' restock: upstream's removeAll) the pack emptied for the kit, as before, but the ledger's quantities:
 * the human's items stay (a restock with an empty ledger is upstream's, the same world)
 */
export function clearPackForRestock(player: Player): void {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return;
    trimLedger(player);
    const l = ledgers.get(player.username);
    if (!l) {
        inv.removeAll();
        return;
    }
    const keep = new Map<number, number>(l);
    for (let slot = 0; slot < inv.capacity; slot++) {
        const item = inv.get(slot);
        if (!item) continue;
        const kept = keep.get(item.id) ?? 0;
        if (kept >= item.count) {
            keep.set(item.id, kept - item.count);
            continue;
        }
        keep.set(item.id, 0);
        if (kept > 0) inv.set(slot, { id: item.id, count: kept });
        else inv.set(slot, null);
    }
}

/** does the PKer have to stop at the booth before its restock (the human's items in its ledger)? */
export function needsBooth(player: Player): boolean {
    return holdsLoot(player);
}

/**
 * (the PK tasks on patrol) should it go and bank now: its ledger worth BANK_VALUE, holding an item of its kit (it would
 * eat or drink it as its own), BANK_STACKS stacks, or its session over (it is held from logging out until it has banked)
 */
export function lootBankDue(player: Player, kit: ReadonlySet<number>): boolean {
    const l = ledgers.get(player.username);
    if (!l || l.size === 0) return false;
    if (l.size >= BANK_STACKS || ledgerValue(player) >= BANK_VALUE) return true;
    for (const id of l.keys()) if (kit.has(id)) return true;
    return BotManager.sessionLeftOf(player.username) <= 0;
}

/**
 * (the PK tasks at the Edgeville booth, the booth's window open) the ledger's quantities into the bank; the ledger
 * cleared. What a full bank refuses stays in the pack and in the ledger. Logged ('bank'): the stacks and their value.
 */
export function bankLoot(player: Player, bank: Inventory | null): { stacks: number; value: number } {
    const inv = player.getInventory(InvType.INV);
    if (!inv || !bank) return { stacks: 0, value: 0 };
    trimLedger(player);
    const l = ledgers.get(player.username);
    if (!l) return { stacks: 0, value: 0 };
    let stacks = 0;
    let value = 0;
    for (const [id, owed] of [...l]) {
        const moved = depositItems(inv, bank, id, Math.min(owed, inv.getItemCount(id)));
        if (moved <= 0) continue;
        stacks++;
        value += valueOf(id, moved);
        log({ t: World.currentTick, pile: 0, kind: 'bank', who: player.username, role: 'item', item: id, count: moved, value: valueOf(id, moved) });
        if (owed - moved <= 0) l.delete(id);
        else l.set(id, owed - moved);
    }
    if (l.size === 0) deleteLedger(player.username);
    return { stacks, value };
}

/** a saved ledger's stack: the item, its count, (bots ideas, round 1, the fixes: B6) the bot's playtime at its newest take */
export type SavedLootStack = [number, number] | [number, number, number];

/** the ledgers for the store (BotWorldState.loot): {name: [[id, count, playtime], ...]}, null when there is none */
export function exportLoot(): Record<string, SavedLootStack[]> | null {
    if (ledgers.size === 0) return null;
    const out: Record<string, SavedLootStack[]> = {};
    let n = 0;
    for (const [name, l] of ledgers) {
        if (n++ >= SAVED_BOTS) break;
        const at = stamps.get(name);
        out[name] = [...l].slice(0, SAVED_STACKS).map(([id, count]): SavedLootStack => (at?.has(id) ? [id, count, at.get(id)!] : [id, count]));
    }
    return out;
}

/**
 * the ledgers from the store (an older store has none; an older ledger no playtimes). (bots ideas, round 1, the fixes:
 * B6) a bot online already is checked against its save at once, the others at their login (noteLootLogin)
 */
export function restoreLoot(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    for (const [name, list] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof name !== 'string' || !Array.isArray(list)) continue;
        const l = new Map<number, number>();
        const at = new Map<number, number>();
        for (const e of list.slice(0, SAVED_STACKS)) {
            if (!Array.isArray(e) || (e.length !== 2 && e.length !== 3) || !Number.isInteger(e[0]) || !Number.isInteger(e[1]) || e[0] < 0 || e[1] <= 0) continue;
            l.set(e[0], (l.get(e[0]) ?? 0) + e[1]);
            if (e.length === 3 && Number.isInteger(e[2]) && e[2] >= 0) at.set(e[0], Math.max(at.get(e[0]) ?? 0, e[2]));
        }
        if (l.size === 0) continue;
        deleteLedger(name);
        ledgers.set(name, l);
        if (at.size === 0) continue;
        stamps.set(name, at);
        restored.set(name, new Map(at));
        for (const p of worldPlayers()) if (p.username === name && p.slot !== -1) noteLootLogin(p);
    }
}

// ── tests ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Tests only: a trait for each bot (else the name's), the enrol chance, the word back's and the polite word's. */
const testRates: { trait?: (p: Player) => VultureTrait; enrol?: number; back?: number; polite?: number } = {};
export function setLootRatesForTest(rates: typeof testRates | null): void {
    for (const k of Object.keys(testRates) as (keyof typeof testRates)[]) delete testRates[k];
    Object.assign(testRates, rates ?? {});
}

/** Tests only: no piles, holders, ledgers or log. Never called by the game. */
export function resetLootForTest(): void {
    piles.length = 0;
    holders.clear();
    ledgers.clear();
    stamps.clear();
    restored.clear();
    lootLog.length = 0;
}

/** Tests only: put `count` of `id` in a PKer's ledger (a staged pile's take). */
export function addToLedgerForTest(bot: Player, id: number, count: number): void {
    addToLedger(bot, id, count);
}
