/**
 * ErrandTask.ts (the variety work, round 2, Track D2: new activities, research
 * the research)
 *
 * A small activity made of steps, each one a click a player's client sends (BotAction's entry points: a walk, a loc's
 * op, an item used on a loc or an NPC, an NPC's Talk-to and its dialogue, a shop's buttons, a bank booth), run one after
 * another: the low-level economy chains (port/BotChains: cowhides tanned at Ellis, feathers sold, pottery, flour at the
 * Lumbridge mill, picking, shrimps cooked on a fire the bot lights, trout on the Barbarian Village fire), the prayer and
 * magic runs (a bone run, superheat, enchanting, the wine of Zamorak), the Wilderness trips (port/BotWildTrips) and the
 * F2P quests' look-alikes (port/BotErrands: the steps walked with chatter, a quest's state never changed: every bot has
 * every quest done, BOT_VARPS, so the NPCs answer as after it).
 *
 * The task's name is `<kind>:<key>` ("Hides:lumbridge", "Quest:cook"): the kind is what the humanlike report groups
 * (AM1, AM11, QA1). A plan is built at the start of each round (`build`), so its steps see the bot as it is then (a pot
 * already carried, a bucket in the bank); a looping plan goes round again while `again` says so and the plan lasts. A
 * step that fails ends the task (the planner picks again): nothing is conjured, no item is made by the bot itself, and
 * no move is unseen (a walk that is desperately stuck fails its step instead of a jump; the walks' own rescue is
 * BotAction's, as every task's).
 */

import Obj from '#/engine/entity/Obj.js';
import { botReachedEntity, botWalkPath, pathBudgetLeft } from '#/engine/bot/port/BotPathing.js';
import {
    BotTask,
    Player,
    Npc,
    Loc,
    InvType,
    walkTo,
    interactNpcOp,
    interactLocOp,
    interactUseLocOp,
    findNpcByName,
    findLocByName,
    hasItem,
    countItem,
    isInventoryFull,
    isNear,
    bankInvId,
    StuckDetector,
    advanceBankWalk,
    openNearbyGate,
    randInt,
    humanDelay,
    openShopStock,
    buyFromOpenShop,
    sellToOpenShop,
    botInteractUseObjNpc,
    npcReach,
    gateToward
} from '#/engine/bot/tasks/BotTaskBase.js';
import type { SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import { bankStop } from '#/engine/bot/port/BotHabits.js';
import { moveItems, depositItems } from '#/engine/bot/port/BotInventoryCompat.js';
import { botAnswerDialogue, botContinuePage, botScript, closedGateBetween, findNpcBySuffix, findObjNear, locInRoute, openGateLoc, openGateToward, tryOpenGateNear, interactHeldOp, interactHeldOpU, interactIfButtonByName, interactObjOp, freeSlots } from '#/engine/bot/BotAction.js';
import ScriptState from '#/engine/script/ScriptState.js';
import ObjType from '#/cache/config/ObjType.js';
import NpcType from '#/cache/config/NpcType.js';
import LocType from '#/cache/config/LocType.js';
import World from '#/engine/World.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';

// ── item and name look-ups (274's debugnames, resolved once) ──────────────────────────────────────────────────────────

const objIds = new Map<string, number>();
/** an item's id by its 274 debugname (-1: none; test/content-names.test.mjs checks every one the plans use) */
export function obj(name: string): number {
    let id = objIds.get(name);
    if (id === undefined) objIds.set(name, (id = ObjType.getId(name)));
    return id;
}

/** the item in the bank, all of it */
export function banked(player: Player, id: number): number {
    const bid = bankInvId();
    const bank = bid === -1 ? null : player.getInventory(bid);
    if (!bank || id < 0) return 0;
    let n = 0;
    for (let i = 0; i < bank.capacity; i++) {
        const it = bank.get(i);
        if (it?.id === id) n += it.count;
    }
    return n;
}

/** carried or banked */
export function owned(player: Player, id: number): number {
    return id < 0 ? 0 : countItem(player, id) + banked(player, id);
}

function slotOf(player: Player, id: number): number {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return -1;
    for (let s = 0; s < inv.capacity; s++) if (inv.get(s)?.id === id) return s;
    return -1;
}

const cheb = (ax: number, az: number, bx: number, bz: number): number => Math.max(Math.abs(ax - bx), Math.abs(az - bz));

// ── steps ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type StepResult = 'run' | 'done' | 'fail';

/** One step of an errand: tick() each tick until it is done (the next step) or fails (the task ends). */
export interface Step {
    readonly label: string;
    tick(p: Player, t: ErrandTask): StepResult;
    /** it answers its own dialogue (a chat, a choice, a make box): else a page left open (a level-up's) is clicked away first */
    readonly dialog?: boolean;
}

/** where a step works: [x, z, level] */
export type At = readonly [number, number, number];

/** an errand's offers stay within this many tiles of the bot (round 1's AM8: a plan's spot 300+ tiles off is a long walk) */
export const OFFER_RANGE = 300;
/** is `at` within OFFER_RANGE (or `d`) tiles of the bot, a dungeon's spot (and a bot in one) taken at the surface above it
 * (z less 6400: the Edgeville dungeon's hill giants by Edgeville, Taverley's druids by Taverley) */
export function withinRange(p: Player, at: At, d = OFFER_RANGE): boolean {
    const surface = (z: number): number => (z >= 6400 ? z - 6400 : z);
    return Math.max(Math.abs(p.x - at[0]), Math.abs(surface(p.z) - surface(at[1]))) <= d;
}

/**
 * A walk to within `near` tiles of `at` (its level too: walkTo's own stairs for the places it knows, else a plan's
 * climb steps first). A walk with no headway for long (StuckDetector's window, a detour, a gate opened) tries again; one
 * desperately stuck or over `maxTicks` fails (no jump of its own).
 */
export function walk(at: At, near = 2, maxTicks = 2000, label = 'walk'): Step {
    let ticks = 0;
    let stuck: StuckDetector | null = null;
    let doorTried = false;
    return {
        label,
        tick(p) {
            const [x, z, level] = at;
            if (p.level === level && isNear(p, x, z, near, level)) {
                ticks = 0;
                stuck = null;
                doorTried = false;
                return 'done';
            }
            if (++ticks > maxTicks) return 'fail';
            stuck ??= new StuckDetector(40, 4, 3);
            if (!stuck.check(p, x, z)) {
                walkTo(p, x, z, level);
                return 'run';
            }
            if (stuck.desperatelyStuck) {
                // (once: a door shut by the destination opened, a new window; then the walk has failed)
                if (!doorTried && tryOpenGateNear(p, x, z, 10)) {
                    doorTried = true;
                    stuck.reset();
                    return 'run';
                }
                return 'fail';
            }
            if (openNearbyGate(p, 8)) return 'run';
            p.clearWaypoints();
            walkTo(p, x + randInt(-4, 4), z + randInt(-4, 4), level);
            return 'run';
        }
    };
}

/** the loc of 274 debugname `name` (or one of `names`) within `radius` of `at`, nearest the bot (null: none) */
function locAt(names: readonly string[], at: At, radius: number, p: Player, pred?: (l: Loc) => boolean): Loc | null {
    let best: Loc | null = null;
    let bestD = Infinity;
    for (const name of names) {
        const id = LocType.getId(name);
        if (id === -1) continue;
        for (let zx = (at[0] - radius) & ~7; zx <= at[0] + radius; zx += 8) {
            for (let zz = (at[1] - radius) & ~7; zz <= at[1] + radius; zz += 8) {
                const zone = World.gameMap.getZone(zx, zz, at[2]);
                if (!zone) continue;
                for (const loc of zone.getAllLocsSafe()) {
                    if (loc.type !== id || cheb(loc.x, loc.z, at[0], at[1]) > radius) continue;
                    if (pred && !pred(loc)) continue;
                    const d = cheb(loc.x, loc.z, p.x, p.z);
                    if (d < bestD) {
                        bestD = d;
                        best = loc;
                    }
                }
            }
        }
    }
    return best;
}

/** the op number of a loc's op called `name` (case-insensitive), or -1 */
function locOp(loc: Loc, name: string): number {
    const ops = LocType.get(loc.type).op ?? [];
    const i = ops.findIndex(o => typeof o === 'string' && o.toLowerCase() === name.toLowerCase());
    return i === -1 ? -1 : i + 1;
}

/**
 * Up or down a ladder or a staircase by its op ('Climb-up', 'Climb-down'; a loc with a plain 'Climb' choice is answered
 * with the way): the game's script moves the bot (a real climb, as a player's). Done on `toLevel`.
 */
export function climb(locNames: readonly string[], op: 'climb-up' | 'climb-down', at: At, toLevel: number, there?: (p: Player) => boolean): Step {
    let tries = 0;
    let wait = 0;
    let walking: Step | null = null;
    const reachTries = { n: 0 };
    return {
        label: `climb ${op}`,
        dialog: true,
        tick(p) {
            // (a dungeon's ladder keeps the level: `there` says when the bot is below, or out)
            if (there ? there(p) : p.level === toLevel) {
                tries = 0;
                reachTries.n = 0;
                wait = 0;
                walking = null;
                return 'done';
            }
            if (p.level !== at[2] || (there && Math.abs(p.z - at[1]) > 200)) return 'fail';
            if (wait > 0) {
                wait--;
                // (a loc with one Climb op asks which way: up or down)
                if (botScript(p)?.execution === ScriptState.PAUSEBUTTON) botAnswerDialogue(p, op === 'climb-up' ? 1 : 2);
                return 'run';
            }
            if (!isNear(p, at[0], at[1], 4, at[2])) {
                walking ??= walk(at, 3, 600, 'climb walk');
                return walking.tick(p, null as unknown as ErrandTask) === 'fail' ? 'fail' : 'run';
            }
            const loc = locAt(locNames, at, 6, p);
            if (!loc) return 'fail';
            let n = locOp(loc, op);
            if (n === -1) n = locOp(loc, 'climb');
            if (n === -1) return 'fail';
            // (a ladder inside a mill or a tower: its door opened on the way, not clicked through the wall)
            const reach = reachLoc(p, loc, reachTries);
            if (reach === 'no') return 'fail';
            if (reach === 'wait') {
                wait = 4;
                return 'run';
            }
            if (++tries > 5) return 'fail';
            interactLocOp(p, loc, n as 1 | 2 | 3 | 4 | 5);
            wait = 12;
            return 'run';
        }
    };
}

/**
 * Before a click on an NPC: can the bot get at it from here (274's reach and route: BotTaskBase.npcReach)? 'go' when it
 * may click now; 'wait' while it opens a gate or door between, or walks round to it; 'no' when it cannot.
 */
function reachNpc(p: Player, npc: Npc, tries: { n: number }): 'go' | 'wait' | 'no' {
    const r = npcReach(p, npc);
    if (r === 'yes' || r === 'unknown') return 'go';
    if (++tries.n > 20) return 'no';
    // (a gate or door between: opened, every other look; else a walk to it, which opens what is shut on its way: a
    // farmer in his house behind his field's gate)
    if (r === 'gate' && (tries.n & 1) === 0) {
        const gate = gateToward(p, npc.x, npc.z);
        if (gate && openGateLoc(p, gate) !== 'unreachable') return 'wait';
    }
    if (!p.hasWaypoints() && !openNearbyGate(p, 3)) walkTo(p, npc.x, npc.z, npc.level);
    return 'wait';
}

/**
 * Talk-to an NPC (op 1) and its dialogue clicked through as a player does: a page continued, a choice answered with
 * the next of `answers` (1-based), or with `pick` (an option drawn: the harmless ones only, per NPC). Done once the
 * dialogue closed after a page or two; fails when the NPC is not there or never answers.
 */
export function talk(npcName: string, at: At, opts: { answers?: readonly number[]; pick?: readonly number[]; radius?: number; optional?: boolean } = {}): Step {
    let phase: 'walk' | 'click' | 'chat' = 'walk';
    let walking: Step | null = null;
    let given = 0;
    let idle = 0;
    let clicks = 0;
    let pause = 0;
    let pages = 0;
    const reachTries = { n: 0 };
    const step: Step = {
        label: `talk ${npcName}`,
        dialog: true,
        tick(p) {
            if (phase === 'walk') {
                // (up to its spot: inside its house or kitchen, its door opened on the way, not beside its wall)
                if (p.level === at[2] && isNear(p, at[0], at[1], 3, at[2])) phase = 'click';
                else {
                    walking ??= walk(at, 2, 2500, `walk to ${npcName}`);
                    return walking.tick(p, null as unknown as ErrandTask) === 'fail' ? 'fail' : 'run';
                }
            }
            if (phase === 'click') {
                if (pause > 0) {
                    pause--;
                    return 'run';
                }
                const npc = findNpcByName(p.x, p.z, p.level, npcName, opts.radius ?? 14);
                if (!npc) return 'fail';
                const reach = reachNpc(p, npc, reachTries);
                if (reach === 'no') return 'fail';
                if (reach === 'wait') {
                    pause = 6;
                    return 'run';
                }
                if (++clicks > 3) return 'fail';
                interactNpcOp(p, npc, 1);
                phase = 'chat';
                idle = 0;
                return 'run';
            }
            // the dialogue
            if (pause > 0) {
                pause--;
                return 'run';
            }
            const script = botScript(p);
            if (script && script.execution === ScriptState.PAUSEBUTTON) {
                idle = 0;
                let option = 1;
                if (opts.answers && given < opts.answers.length) option = opts.answers[given];
                else if (opts.pick && opts.pick.length > 0) option = opts.pick[Math.floor(Math.random() * opts.pick.length)];
                const r = botAnswerDialogue(p, option);
                if (r === 'choice') given++;
                if (r !== null) pages++;
                pause = humanDelay(p, 'page');
                return 'run';
            }
            // (walking up to the NPC, its script's own delay: then the dialogue's end)
            if (++idle > (pages > 0 ? 3 : 25)) {
                if (pages > 0) return 'done';
                phase = 'click';
            }
            return 'run';
        }
    };
    // (the step's state from the start at its end; an optional talk that could not happen is passed over: the errand goes on)
    return {
        label: step.label,
        dialog: true,
        tick(p, t) {
            const r = step.tick(p, t);
            if (r === 'run') return 'run';
            phase = 'walk';
            walking = null;
            given = 0;
            idle = 0;
            clicks = 0;
            pause = 0;
            pages = 0;
            reachTries.n = 0;
            if (r === 'fail' && opts.optional) {
                talkStats.missed++;
                return 'done';
            }
            if (r === 'done') talkStats.talked++;
            return r;
        }
    };
}

/** the errands' talks: held, and missed (an NPC not reached: an optional talk passed over) */
export const talkStats = { talked: 0, missed: 0 };

/**
 * A loc's op clicked (`op`: its name, 'Pick', 'Operate', 'Empty', 'Fire'), again while `again(p)` holds, each after the
 * last one's effect (`changed`: an item count it moves) or a few ticks; `max` clicks at most. The loc nearest the bot of
 * those named within `radius` of `at` (a picked crop's next one).
 */
/**
 * Before a click on a loc: does the bot get at it (274's reach from here, or a route to where it reaches it, doors as
 * they are: BotAction.locInRoute)? 'go'; 'wait' (no search left this tick, or a shut door near it opened, or a walk to it
 * under way); 'no' after a few tries (a fence, a wall with no door it can open).
 */
function reachLoc(p: Player, loc: Loc, tries: { n: number }): 'go' | 'wait' | 'no' {
    const r = locInRoute(p, loc);
    if (r === 'yes') {
        tries.n = 0;
        return 'go';
    }
    if (r === 'wait') return 'wait';
    if (++tries.n > 8) return 'no';
    if (!p.hasWaypoints()) {
        // (the door between the bot and the loc, on its way: not the nearest to the loc, a kitchen's cellar trapdoor)
        const gate = closedGateBetween(p, loc.x, loc.z, 10);
        if (gate && openGateLoc(p, gate) !== 'unreachable') return 'wait';
        if (openGateToward(p, loc.x, loc.z, 10)) return 'wait';
        walkTo(p, loc.x, loc.z, loc.level);
    }
    return 'wait';
}

export function clickLoc(locNames: readonly string[], op: string, at: At, opts: { radius?: number; again?: (p: Player) => boolean; watch?: number; max?: number; wait?: number } = {}): Step {
    let walking: Step | null = null;
    let clicks = 0;
    let effects = 0;
    let waitTicks = 0;
    let last = -1;
    let noEffect = 0;
    const reachTries = { n: 0 };
    const end = (r: StepResult): StepResult => {
        walking = null;
        clicks = 0;
        effects = 0;
        waitTicks = 0;
        last = -1;
        noEffect = 0;
        reachTries.n = 0;
        return r;
    };
    return {
        label: `${op} ${locNames[0]}`,
        tick(p) {
            if (p.level !== at[2] || !isNear(p, at[0], at[1], (opts.radius ?? 6) + 3, at[2])) {
                walking ??= walk(at, 3, 2500, `walk to ${locNames[0]}`);
                return walking.tick(p, null as unknown as ErrandTask) === 'fail' ? end('fail') : 'run';
            }
            const count = opts.watch !== undefined ? countItem(p, opts.watch) : -1;
            if (waitTicks > 0) {
                // (the click's effect: the watched item moved, or the bot is done walking up and acting)
                if (opts.watch !== undefined && count !== last) {
                    waitTicks = 0;
                    noEffect = 0;
                    effects++;
                } else if (--waitTicks > 0 || p.delayed || p.hasWaypoints()) return 'run';
                else if (opts.watch !== undefined) noEffect++;
                else effects++;
            }
            if (clicks > 0 && (!opts.again || !opts.again(p))) return end(effects > 0 || opts.watch === undefined ? 'done' : 'fail');
            if (clicks >= (opts.max ?? 60) || noEffect >= 4) return end(effects > 0 ? 'done' : 'fail');
            if (p.delayed) return 'run';
            const target = locAt(locNames, at, opts.radius ?? 6, p);
            if (!target) return end(effects > 0 ? 'done' : 'fail');
            const n = locOp(target, op);
            if (n === -1) return end('fail');
            const reach = reachLoc(p, target, reachTries);
            if (reach === 'no') return end(effects > 0 ? 'done' : 'fail');
            if (reach === 'wait') {
                waitTicks = 4;
                return 'run';
            }
            interactLocOp(p, target, n as 1 | 2 | 3 | 4 | 5);
            clicks++;
            last = count;
            waitTicks = (opts.wait ?? 6) + humanDelay(p, 'next');
            return 'run';
        }
    };
}

/**
 * An item used on a loc (a fish on a fire or range, wheat in the hopper, clay on the wheel, a bucket on a sink), again
 * while `again(p)` holds and the item is carried; each after the last one's effect or a few ticks.
 */
export function useOnLoc(item: number | (() => number), locNames: readonly string[], at: At, opts: { radius?: number; again?: (p: Player) => boolean; wait?: number; max?: number; then?: (p: Player) => boolean } = {}): Step {
    let walking: Step | null = null;
    let uses = 0;
    let effects = 0;
    let noEffect = 0;
    let waitTicks = 0;
    let fails = 0;
    let usedId = -1;
    let usedCount = -1;
    let waited = 0;
    const reachTries = { n: 0 };
    const end = (r: StepResult): StepResult => {
        walking = null;
        uses = 0;
        effects = 0;
        noEffect = 0;
        waitTicks = 0;
        fails = 0;
        usedId = -1;
        waited = 0;
        reachTries.n = 0;
        return r;
    };
    return {
        label: `use on ${locNames[0]}`,
        dialog: opts.then !== undefined,
        tick(p) {
            if (p.level !== at[2] || !isNear(p, at[0], at[1], (opts.radius ?? 6) + 3, at[2])) {
                walking ??= walk(at, 3, 2500, `walk to ${locNames[0]}`);
                return walking.tick(p, null as unknown as ErrandTask) === 'fail' ? end('fail') : 'run';
            }
            // (a skill's make-X box it opened: answered with all)
            if (opts.then && opts.then(p)) {
                waitTicks = Math.max(waitTicks, 4);
                return 'run';
            }
            // (a use's walk up and its script; a script left over is waited for 30 ticks at most)
            if (waitTicks > 0 && (--waitTicks > 0 || p.delayed || p.hasWaypoints() || (botScript(p) !== null && ++waited < 30))) return 'run';
            waited = 0;
            // (the last use's effect: the item it used went, or became another)
            if (usedId !== -1) {
                if (countItem(p, usedId) < usedCount) {
                    effects++;
                    noEffect = 0;
                } else noEffect++;
                usedId = -1;
            }
            if (uses > 0 && (!opts.again || !opts.again(p))) return end(effects > 0 ? 'done' : 'fail');
            if (uses >= (opts.max ?? 60) || noEffect >= 5) return end(effects > 0 ? 'done' : 'fail');
            const id = typeof item === 'function' ? item() : item;
            const slot = slotOf(p, id);
            if (slot === -1) return end(effects > 0 ? 'done' : 'fail');
            const loc = locAt(locNames, at, opts.radius ?? 6, p);
            if (!loc) return end('fail');
            // (the wrong side of a wall, a door shut in the way: the door opened, a walk to the loc, before the click)
            const reach = reachLoc(p, loc, reachTries);
            if (reach === 'no') return end(effects > 0 ? 'done' : 'fail');
            if (reach === 'wait') {
                waitTicks = 4;
                waited = 0;
                return 'run';
            }
            if (!interactUseLocOp(p, loc, id, slot)) {
                if (++fails > 6) return end('fail');
                waitTicks = 2;
                return 'run';
            }
            uses++;
            usedId = id;
            usedCount = countItem(p, id);
            waitTicks = (opts.wait ?? 4) + humanDelay(p, 'next');
            return 'run';
        }
    };
}

/** An item used on an NPC (an empty bucket on a cow: milk), again while `again(p)` holds; each use's effect watched. */
export function useOnNpc(item: number, npcNames: readonly string[], at: At, opts: { again?: (p: Player) => boolean; radius?: number } = {}): Step {
    let walking: Step | null = null;
    let effects = 0;
    let tries = 0;
    let waitTicks = 0;
    let usedCount = -1;
    const reachTries = { n: 0 };
    const end = (r: StepResult): StepResult => {
        walking = null;
        effects = 0;
        tries = 0;
        waitTicks = 0;
        usedCount = -1;
        reachTries.n = 0;
        return r;
    };
    return {
        label: `use on ${npcNames[0]}`,
        tick(p) {
            if (p.level !== at[2] || !isNear(p, at[0], at[1], (opts.radius ?? 8) + 2, at[2])) {
                walking ??= walk(at, 3, 2500, `walk to ${npcNames[0]}`);
                return walking.tick(p, null as unknown as ErrandTask) === 'fail' ? end('fail') : 'run';
            }
            if (waitTicks > 0 && (--waitTicks > 0 || p.delayed || p.hasWaypoints() || p.target !== null)) return 'run';
            if (usedCount !== -1) {
                if (countItem(p, item) < usedCount) effects++;
                usedCount = -1;
                if (effects > 0 && (!opts.again || !opts.again(p))) return end('done');
            }
            const slot = slotOf(p, item);
            if (slot === -1) return end(effects > 0 ? 'done' : 'fail');
            if (++tries > 12) return end(effects > 0 ? 'done' : 'fail');
            let npc: Npc | null = null;
            for (const name of npcNames) {
                npc = findNpcByName(p.x, p.z, p.level, name, opts.radius ?? 10);
                if (npc) break;
            }
            if (!npc) return end('fail');
            const reach = reachNpc(p, npc, reachTries);
            if (reach === 'no') return end(effects > 0 ? 'done' : 'fail');
            if (reach === 'wait') {
                waitTicks = 6;
                return 'run';
            }
            if (botInteractUseObjNpc(p, npc, item, slot)) usedCount = countItem(p, item);
            waitTicks = 3 + humanDelay(p, 'next');
            return 'run';
        }
    };
}

/** One item used on another in the pack (clay with a bucket of water, flour with a jug), again while `again(p)`. */
export function combine(a: number, b: number, opts: { again?: (p: Player) => boolean; answer?: number; max?: number } = {}): Step {
    let uses = 0;
    let waitTicks = 0;
    return {
        label: `combine ${a} ${b}`,
        dialog: opts.answer !== undefined,
        tick(p) {
            if (waitTicks > 0) {
                if (opts.answer !== undefined && botScript(p)?.execution === ScriptState.PAUSEBUTTON) {
                    botAnswerDialogue(p, opts.answer);
                    waitTicks = 3;
                    return 'run';
                }
                if (--waitTicks > 0 || p.delayed) return 'run';
            }
            if (uses > 0 && (!opts.again || !opts.again(p))) return 'done';
            if (uses >= (opts.max ?? 28)) return 'done';
            const inv = p.getInventory(InvType.INV);
            const sa = slotOf(p, a);
            const sb = slotOf(p, b);
            if (!inv || sa === -1 || sb === -1) return uses > 0 ? 'done' : 'fail';
            interactHeldOpU(p, inv, a, sa, b, sb);
            uses++;
            waitTicks = 2 + humanDelay(p, 'next');
            return 'run';
        }
    };
}

/** A carried item's own op (Identify a herb, Bury a bone): one at a time, while it is carried and `again(p)` holds. */
export function heldOp(item: number | ((p: Player) => number), op: 1 | 2 | 3 | 4 | 5, opts: { again?: (p: Player) => boolean; wait?: number } = {}): Step {
    let uses = 0;
    let waitTicks = 0;
    return {
        label: `held op${op}`,
        tick(p) {
            if (waitTicks > 0 && (--waitTicks > 0 || p.delayed)) return 'run';
            botContinuePage(p);
            if (uses > 0 && opts.again && !opts.again(p)) return 'done';
            const id = typeof item === 'function' ? item(p) : item;
            const inv = p.getInventory(InvType.INV);
            const slot = id < 0 ? -1 : slotOf(p, id);
            if (!inv || slot === -1) return uses > 0 ? 'done' : 'fail';
            if (interactHeldOp(p, inv, id, slot, op as 1 | 2 | 3 | 4 | 5 | 6)) uses++;
            waitTicks = (opts.wait ?? 2) + humanDelay(p, 'next');
            if (uses > 60) return 'done';
            return 'run';
        }
    };
}

/** a skill's make box (skill_multi: its Make X answered with `count`, or Make 1 when no count box comes) */
export function answerMake(p: Player, button: string, count: number): boolean {
    if (botScript(p)?.execution !== ScriptState.PAUSEBUTTON) return false;
    if (!interactIfButtonByName(p, button)) {
        botContinuePage(p);
        return false;
    }
    const box = p.activeScript;
    if (box && box.execution === ScriptState.COUNTDIALOG) {
        box.lastInt = count;
        p.executeScript(box, true, true);
    }
    return true;
}

/** the items of this id lying within `radius` of `at` (visible to the bot), nearest the bot first */
function objsAt(p: Player, item: number, at: At, radius: number): Obj[] {
    const out: Obj[] = [];
    for (let zx = (at[0] - radius) & ~7; zx <= at[0] + radius; zx += 8) {
        for (let zz = (at[1] - radius) & ~7; zz <= at[1] + radius; zz += 8) {
            const zone = World.gameMap.getZone(zx, zz, at[2]);
            if (!zone) continue;
            for (const o of zone.getAllObjsSafe()) {
                if (o.type !== item || cheb(o.x, o.z, at[0], at[1]) > radius) continue;
                if (o.receiver64 !== Obj.NO_RECEIVER && o.receiver64 !== p.hash64) continue;
                out.push(o);
            }
        }
    }
    return out.sort((a, b) => cheb(a.x, a.z, p.x, p.z) - cheb(b.x, b.z, p.x, p.z));
}

/** where a walk to (x, z) ends ([x, z]), or null: no search left this tick */
function walkEnd(p: Player, x: number, z: number): [number, number] | null {
    if (p.x === x && p.z === z) return [x, z];
    if (pathBudgetLeft(p) <= 0) return null;
    const path = botWalkPath(p.level, p.x, p.z, x, z);
    if (path.length === 0) return [p.x, p.z];
    const last = path[path.length - 1];
    return [(last >> 14) & 0x3fff, last & 0x3fff];
}

/**
 * An item lying in the world (a spawn: a pot in the kitchen, an egg at the farm, a bucket) taken with the real op
 * (Take, op 3; the engine walks the bot to it), within `radius` of `at`; done when the pack holds one more. A spawn
 * another player took is waited for a little (274 respawns it), then the step fails.
 */
export function take(item: number, at: At, radius = 6, maxWait = 120): Step {
    let walking: Step | null = null;
    let had = -1;
    let waitTicks = 0;
    let waited = 0;
    let clicks = 0;
    return {
        label: `take ${item}`,
        tick(p) {
            if (had === -1) had = countItem(p, item);
            if (countItem(p, item) > had) {
                had = -1;
                waited = 0;
                clicks = 0;
                return 'done';
            }
            if (isInventoryFull(p)) return 'fail';
            if (p.level !== at[2] || !isNear(p, at[0], at[1], radius + 2, at[2])) {
                walking ??= walk(at, 2, 2500, `walk to ${item}`);
                return walking.tick(p, null as unknown as ErrandTask) === 'fail' ? 'fail' : 'run';
            }
            if (waitTicks > 0 && (--waitTicks > 0 || p.delayed || p.hasWaypoints())) return 'run';
            // (one the bot gets beside: an egg in the coop's corner is out of reach, the next one is not)
            // (reached: on its tile, or beside it with no wall or fence between, 274's reach)
            const reaches = (x: number, z: number, c: Obj): boolean => (x === c.x && z === c.z) || botReachedEntity(p.level, x, z, c.x, c.z, 1, 1);
            let o: Obj | null = null;
            let here = false;
            for (const c of objsAt(p, item, at, radius)) {
                if (reaches(p.x, p.z, c)) {
                    o = c;
                    here = true;
                    break;
                }
                const end = walkEnd(p, c.x, c.z);
                if (end === null) return 'run';
                if (reaches(end[0], end[1], c)) {
                    o = c;
                    break;
                }
            }
            if (!o) {
                // (none, or none it reaches now: a gate shut, or taken: a while, then the next try)
                if (waited % 30 === 0 && objsAt(p, item, at, radius).length > 0) tryOpenGateNear(p, at[0], at[1], 10);
                waitTicks = 10;
                waited += 10;
                return waited > maxWait ? 'fail' : 'run';
            }
            // (beside it first, through the pen's gate: a click from outside a fence is "I can't reach that!")
            if (!here) {
                if (++clicks > 40) return 'fail';
                walkTo(p, o.x, o.z, o.level);
                waitTicks = 3;
                return 'run';
            }
            if (++clicks > 46) return 'fail';
            interactObjOp(p, o, 3);
            waitTicks = 4 + humanDelay(p, 'next');
            return 'run';
        }
    };
}

/**
 * A shop: Trade with its keeper (op 3), then its buttons as a player clicks them (274's shop interface: the game takes
 * the coins at its price and the stock it has): buy `buy` (item, how many), sell every `sell` item carried. Done when
 * bought and sold, the shop closed again; fails when the keeper is not there, the shop never opens or the stock is out.
 */
export function shop(npcName: string, at: At, opts: { buy?: readonly (readonly [number, number])[] | ((p: Player) => readonly (readonly [number, number])[]); sell?: readonly number[]; keep?: (id: number) => number; op?: 3 | 4 } = {}): Step {
    let walking: Step | null = null;
    let phase: 'walk' | 'open' | 'wait' | 'deal' = 'walk';
    let waitTicks = 0;
    let opens = 0;
    let pause = 0;
    const goal = new Map<number, number>();
    let deals = 0;
    return {
        label: `shop ${npcName}`,
        dialog: true,
        tick(p) {
            if (phase === 'walk') {
                if (p.level === at[2] && isNear(p, at[0], at[1], 4, at[2])) phase = 'open';
                else {
                    walking ??= walk(at, 3, 2500, `walk to ${npcName}`);
                    return walking.tick(p, null as unknown as ErrandTask) === 'fail' ? 'fail' : 'run';
                }
            }
            if (phase === 'open') {
                if (++opens > 3) return 'fail';
                const npc = findNpcByName(p.x, p.z, p.level, npcName, 12);
                if (!npc) return 'fail';
                if (goal.size === 0) for (const [id, n] of typeof opts.buy === 'function' ? opts.buy(p) : (opts.buy ?? [])) if (n > 0) goal.set(id, countItem(p, id) + n);
                interactNpcOp(p, npc, opts.op ?? 3);
                phase = 'wait';
                waitTicks = 0;
                return 'run';
            }
            if (phase === 'wait') {
                if (openShopStock(p)) {
                    phase = 'deal';
                    pause = humanDelay(p, 'next');
                    return 'run';
                }
                // (a keeper that talks first: its pages)
                if (botScript(p)?.execution === ScriptState.PAUSEBUTTON) botAnswerDialogue(p, 1);
                if (++waitTicks > 25) phase = 'open';
                return 'run';
            }
            if (pause > 0) {
                pause--;
                return 'run';
            }
            if (!openShopStock(p)) return deals > 0 ? 'done' : 'fail';
            for (const id of opts.sell ?? []) {
                // (the variety work, round 2, the fixes: `keep`, how many of it stay in the pack: sold 10, 5 or 1 at a time,
                // the shop's own buttons, down to it)
                const spare = countItem(p, id) - (opts.keep?.(id) ?? 0);
                if (spare > 0) {
                    sellToOpenShop(p, id, spare >= 10 ? 4 : spare >= 5 ? 3 : 2);
                    deals++;
                    pause = 1 + humanDelay(p, 'next');
                    return 'run';
                }
            }
            for (const [id, want] of goal) {
                const have = countItem(p, id);
                if (have >= want) continue;
                if (isInventoryFull(p) && slotOf(p, id) === -1) break;
                if (!buyFromOpenShop(p, id, want - have)) {
                    // (sold out: what it got will do, else the errand cannot go on)
                    goal.delete(id);
                    if (deals === 0 && goal.size === 0) {
                        p.closeModal();
                        return 'fail';
                    }
                    continue;
                }
                deals++;
                pause = 1 + humanDelay(p, 'next');
                return 'run';
            }
            p.closeModal();
            return 'done';
        }
    };
}

/**
 * A bank stop at the bank nearest `near` (or the bot): the booth clicked (advanceBankWalk), then the pack sorted as a
 * player does: everything deposited but `keep` (ids kept, coins kept unless `coins` is false), then `withdraw` (item,
 * how many in the pack after; `need`: the step fails without it). Banking is a click and the bank's own inventory, as
 * every task banks.
 */
export function bank(opts: { near?: At; keep?: readonly number[] | ((p: Player) => readonly number[]); withdraw?: readonly (readonly [number, number, boolean?])[] | ((p: Player) => readonly (readonly [number, number, boolean?])[]); coins?: number } = {}): Step {
    let phase: 'walk' | 'sort' = 'walk';
    let stuck: StuckDetector | null = null;
    let ticks = 0;
    return {
        label: 'bank',
        tick(p, t) {
            if (phase === 'walk') {
                if (++ticks > 2500) return 'fail';
                stuck ??= new StuckDetector(40, 4, 3);
                const coord = opts.near ? ([opts.near[0], opts.near[1], opts.near[2]] as [number, number, number]) : undefined;
                const r = advanceBankWalk(p, stuck, coord);
                if (r === 'walk') {
                    if (stuck.desperatelyStuck) return 'fail';
                    return 'run';
                }
                t.wait(r === 'ready' ? bankStop(p) : 1);
                phase = 'sort';
                return 'run';
            }
            const inv = p.getInventory(InvType.INV);
            const bid = bankInvId();
            const bankInv = bid === -1 ? null : p.getInventory(bid);
            phase = 'walk';
            stuck = null;
            ticks = 0;
            if (!inv || !bankInv) return 'fail';
            const keep = new Set<number>(typeof opts.keep === 'function' ? opts.keep(p) : (opts.keep ?? []));
            keep.add(obj('coins'));
            for (let s = 0; s < inv.capacity; s++) {
                const it = inv.get(s);
                if (!it || keep.has(it.id)) continue;
                // (the variety work, round 2, the fixes: what the bank has room for; the rest stays in the pack)
                depositItems(inv, bankInv, it.id, it.count);
            }
            const coinsId = obj('coins');
            if (opts.coins !== undefined) {
                const c = countItem(p, coinsId);
                if (c < opts.coins) moveItems(bankInv, inv, coinsId, opts.coins - c);
            }
            const list = typeof opts.withdraw === 'function' ? opts.withdraw(p) : (opts.withdraw ?? []);
            for (const [id, n, need] of list) {
                const have = countItem(p, id);
                if (have < n && id >= 0) moveItems(bankInv, inv, id, n - have);
                if (need && countItem(p, id) < Math.min(1, n)) return 'fail';
            }
            return 'done';
        }
    };
}

/** A pause of `min`-`max` ticks (a look round, a wait for a spawn). */
export function pause(min: number, max: number, label = 'pause'): Step {
    let left = -1;
    return {
        label,
        tick() {
            if (left < 0) left = randInt(min, max);
            if (left-- > 0) return 'run';
            left = -1;
            return 'done';
        }
    };
}

/** the steps only when `cond(p)` holds at their turn (else skipped) */
export function when(cond: (p: Player) => boolean, ...steps: Step[]): Step {
    let i = -1;
    return {
        label: `when ${steps[0]?.label ?? ''}`,
        dialog: steps.some(s => s.dialog),
        tick(p, t) {
            if (i === -1) {
                if (!cond(p)) return 'done';
                i = 0;
            }
            while (i < steps.length) {
                const r = steps[i].tick(p, t);
                if (r === 'run') return 'run';
                if (r === 'fail') {
                    i = -1;
                    return 'fail';
                }
                i++;
                return i >= steps.length ? ((i = -1), 'done') : 'run';
            }
            i = -1;
            return 'done';
        }
    };
}

/** the first step whose condition holds, else `otherwise` (or nothing) */
export function either(cond: (p: Player) => boolean, yes: Step, no: Step | null = null): Step {
    let chosen: Step | null | undefined;
    return {
        label: `either ${yes.label}`,
        dialog: yes.dialog || no?.dialog,
        tick(p, t) {
            if (chosen === undefined) chosen = cond(p) ? yes : no;
            if (!chosen) {
                chosen = undefined;
                return 'done';
            }
            const r = chosen.tick(p, t);
            if (r !== 'run') chosen = undefined;
            return r;
        }
    };
}

/** the step, its failure passed over (the errand goes on: a trip's fight cut short still walks home) */
export function soft(step: Step): Step {
    return {
        label: step.label,
        dialog: step.dialog,
        tick(p, t) {
            const r = step.tick(p, t);
            return r === 'fail' ? 'done' : r;
        }
    };
}

/** A step of its own code (a check, a note): `fn` returns the result at once. */
export function act(label: string, fn: (p: Player, t: ErrandTask) => StepResult): Step {
    return { label, tick: fn };
}

/**
 * Another task run inside the errand until `until(p)` holds (a fight at the cows for their hides, a net at the shrimps):
 * its own walking, clicks, looting and eating; reset when done. Fails when it ends or cannot run before that, or after
 * `maxTicks`.
 */
export function inner(make: (p: Player) => BotTask | null, until: (p: Player) => boolean, maxTicks = 6000, label = 'inner', completeIsDone = false): Step {
    let task: BotTask | null = null;
    let ticks = 0;
    return {
        label,
        tick(p) {
            if (until(p)) {
                task?.reset();
                task = null;
                ticks = 0;
                return 'done';
            }
            if (!task) {
                task = make(p);
                if (!task) return 'fail';
                task.reset();
                if (!task.shouldRun(p)) {
                    task = null;
                    return 'fail';
                }
            }
            if (++ticks > maxTicks || task.interrupted || task.isComplete(p) || !task.shouldRun(p)) {
                // (a task that ran its course: done, for an errand that runs it to its end)
                const ended = completeIsDone && ticks > 20;
                task.reset();
                task = null;
                ticks = 0;
                return until(p) || ended ? 'done' : 'fail';
            }
            task.tick(p);
            return 'run';
        }
    };
}

/** the op number of an NPC's op called `name` (case-insensitive), or -1 */
function npcOp(npc: Npc, name: string): number {
    const ops = NpcType.get(npc.type).op ?? [];
    const i = ops.findIndex(o => typeof o === 'string' && o.toLowerCase() === name.toLowerCase());
    return i === -1 ? -1 : i + 1;
}

/**
 * A resource worked as a player works it, until `until(p)`: the nearest rock, tree or crop of `locs` (or fishing spot of
 * `npcs`) within `radius` of `at` clicked with its op ('Mine', 'Chop down', 'Net'), and again when the bot stopped (the
 * rock emptied, the spot moved) a person's moment later; another one after a minute with nothing from it. Done when
 * `until` holds, or after `maxTicks` with something gathered; fails with nothing.
 */
export function gather(what: { locs?: readonly string[]; npcs?: readonly string[] }, op: string, at: At, item: number, until: (p: Player) => boolean, opts: { radius?: number; maxTicks?: number } = {}): Step {
    let walking: Step | null = null;
    let ticks = 0;
    let idle = 0;
    let last = -1;
    let sinceGain = 0;
    let gained = 0;
    let skip: object | null = null;
    let pauseTicks = 0;
    /** ticks since the last item, uncapped (a gate opened after 40) */
    let dry = 0;
    let gateTries = 0;
    /** locs out of the bot's reach (a fence between), until a tick */
    const fenced = new WeakMap<Loc, number>();
    /** busy with the last click (its walk, its target, the game's delay): a person's moment counts from its end */
    let wasBusy = false;
    return {
        label: `gather ${what.locs?.[0] ?? what.npcs?.[0] ?? ''}`,
        tick(p) {
            const count = countItem(p, item);
            dry++;
            if (last >= 0 && count > last) {
                gained += count - last;
                sinceGain = 0;
                dry = 0;
                gateTries = 0;
            }
            last = count;
            if (until(p) || isInventoryFull(p)) {
                const r = gained > 0 || until(p) ? 'done' : 'fail';
                ticks = 0;
                last = -1;
                gained = 0;
                dry = 0;
                gateTries = 0;
                walking = null;
                return r;
            }
            if (p.level !== at[2] || !isNear(p, at[0], at[1], (opts.radius ?? 8) + 4, at[2])) {
                walking ??= walk(at, 4, 2500, `walk to ${what.locs?.[0] ?? what.npcs?.[0] ?? ''}`);
                return walking.tick(p, null as unknown as ErrandTask) === 'fail' ? 'fail' : 'run';
            }
            walking = null;
            if (++ticks > (opts.maxTicks ?? 3000)) return gained > 0 ? 'done' : 'fail';
            sinceGain++;
            botContinuePage(p);
            if (pauseTicks > 0) {
                pauseTicks--;
                return 'run';
            }
            // (working: its click's interaction holds, or it walks up to it)
            const busy = p.delayed || p.hasWaypoints() || p.target !== null;
            if (busy && sinceGain < 60) {
                idle = 0;
                wasBusy = true;
                return 'run';
            }
            // (a rock, a crop or a spot done with: a person's moment from then, varied, now and then a look about; a
            // crop's pick is the game's 2 ticks, so a fixed pause after the click came round like a metronome, H17, H18)
            if (wasBusy) {
                wasBusy = false;
                pauseTicks = humanDelay(p, 'retarget') + (Math.random() < 0.15 ? randInt(4, 15) : randInt(0, 5));
                return 'run';
            }
            if (sinceGain >= 60 && p.target) skip = p.target as unknown as object;
            if (++idle < 2) return 'run';
            idle = 0;
            // (a while with nothing: a field's gate or a house's door shut in the way, opened)
            if (dry >= 40 && (++gateTries & 1) === 1 && gateTries < 12) {
                p.clearPendingAction();
                if (tryOpenGateNear(p, at[0], at[1], (opts.radius ?? 8) + 4)) {
                    pauseTicks = 6;
                    return 'run';
                }
            }
            if (dry >= 900) return gained > 0 ? 'done' : 'fail';
            let target: Loc | Npc | null = null;
            if (what.locs) {
                // (one the bot gets at: a crop past a fence is passed over, as a player picks the next one; one search a look)
                const now = World.currentTick;
                target = locAt(what.locs, at, opts.radius ?? 8, p, l => l !== skip && locOp(l, op) !== -1 && (fenced.get(l) ?? -1) < now);
                if (target) {
                    const r = locInRoute(p, target);
                    if (r === 'wait') return 'run';
                    if (r === 'no') {
                        fenced.set(target, now + 600);
                        return 'run';
                    }
                }
            }
            else if (what.npcs) {
                // (a fishing spot's debugname carries its map square: matched by its end, '_saltfish')
                for (const suffix of what.npcs) {
                    target = findNpcBySuffix(at[0], at[1], at[2], suffix, opts.radius ?? 8, n => n !== skip && npcOp(n, op) !== -1);
                    if (target) break;
                }
            }
            if (!target) {
                // (all taken or gone for now: a look round, then again)
                pauseTicks = randInt(8, 20);
                skip = null;
                return 'run';
            }
            if ('nid' in target) {
                const n = npcOp(target as Npc, op);
                if (n === -1) return 'fail';
                interactNpcOp(p, target as Npc, n as 1 | 2 | 3 | 4 | 5);
            } else {
                const n = locOp(target as Loc, op);
                if (n === -1) return 'fail';
                interactLocOp(p, target as Loc, n as 1 | 2 | 3 | 4 | 5);
            }
            sinceGain = Math.min(sinceGain, 30);
            wasBusy = true;
            return 'run';
        }
    };
}

/**
 * A fire lit where the bot stands, as a player lights one (the tinderbox used on a log in the pack: 274 drops the log
 * and lights it, the bot steps aside): first a step to a tile the game lets a fire be lit on (`allowed`) with nothing
 * on it. Done when a fire burns within 2 tiles of the bot (its own); fails without a tinderbox or a log, or after tries.
 */
export function lightFire(logIds: readonly number[], allowed: (x: number, z: number, level: number) => boolean, hasLocAt: (x: number, z: number, level: number) => boolean): Step {
    let tries = 0;
    let waitTicks = 0;
    let moving = 0;
    return {
        label: 'light fire',
        tick(p) {
            const fire = locAt(['fire'], [p.x, p.z, p.level], 2, p);
            if (fire && waitTicks >= 0 && tries > 0) {
                tries = 0;
                waitTicks = 0;
                return 'done';
            }
            if (waitTicks > 0 && (--waitTicks > 0 || p.delayed || botScript(p) !== null)) return 'run';
            if (moving > 0 && (--moving > 0 || p.hasWaypoints())) return 'run';
            if (tries >= 6) return 'fail';
            const inv = p.getInventory(InvType.INV);
            const tinder = slotOf(p, obj('tinderbox'));
            const logId = logIds.find(id => slotOf(p, id) !== -1);
            if (!inv || tinder === -1 || logId === undefined) return 'fail';
            if (!allowed(p.x, p.z, p.level) || hasLocAt(p.x, p.z, p.level)) {
                // (a step to a tile it may light on: the nearest such within 4)
                for (let r = 1; r <= 4; r++) {
                    for (let dx = -r; dx <= r; dx++) {
                        for (let dz = -r; dz <= r; dz++) {
                            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                            const x = p.x + dx;
                            const z = p.z + dz;
                            if (allowed(x, z, p.level) && !hasLocAt(x, z, p.level)) {
                                walkTo(p, x, z, p.level);
                                moving = 8;
                                tries++;
                                return 'run';
                            }
                        }
                    }
                }
                return 'fail';
            }
            interactHeldOpU(p, inv, logId, slotOf(p, logId), obj('tinderbox'), tinder);
            tries++;
            waitTicks = 6 + humanDelay(p, 'next');
            return 'run';
        }
    };
}

/** Every `items` in the pack dropped one by one through 274's Drop (op 5), at a person's pace (burnt fish). */
export function dropAll(items: readonly number[]): Step {
    let waitTicks = 0;
    return {
        label: 'drop',
        tick(p) {
            if (waitTicks > 0 && (--waitTicks > 0 || p.delayed)) return 'run';
            const inv = p.getInventory(InvType.INV);
            if (!inv) return 'done';
            for (let s = 0; s < inv.capacity; s++) {
                const it = inv.get(s);
                if (!it || !items.includes(it.id)) continue;
                interactHeldOp(p, inv, it.id, s, 5);
                waitTicks = 1 + (Math.random() < 0.5 ? 1 : 0);
                return 'run';
            }
            return 'done';
        }
    };
}

/**
 * A fight as the bot's sub-task (its own name 'Combat:errand': the bot answers its own attackers as a fighter does,
 * port/BotDefence), until `until(p)`: `make()` gives the fight (a CombatTask at the cows, the chickens, the giants). The
 * errand waits while it runs (BotPlayer runs a sub-task first); done when `until` holds after it, fails when the fight
 * ended without it twice (no food, hurt, the spot unreachable).
 */
export function fight(make: (p: Player) => BotTask | null, until: (p: Player) => boolean, maxTicks = 6000, watch?: (p: Player) => void): Step {
    let sub: ErrandFight | null = null;
    let ends = 0;
    return {
        label: 'fight',
        tick(p, t) {
            if (until(p)) {
                if (sub && !sub.isComplete(p)) sub.interrupt();
                sub = null;
                ends = 0;
                return 'done';
            }
            const ai = (p as unknown as { _bot?: { setSubTask(t: BotTask): void; hasSubTask(): boolean } })._bot;
            if (!ai) return 'fail';
            // (the errand runs only while no sub-task does: its fight is over, or another took its place)
            if (sub) {
                sub = null;
                if (++ends >= 3) return 'fail';
            }
            const inner = make(p);
            if (!inner) return 'fail';
            sub = new ErrandFight(inner, until, maxTicks, watch, t);
            if (!sub.shouldRun(p)) {
                sub = null;
                return 'fail';
            }
            ai.setSubTask(sub);
            return 'run';
        }
    };
}

/** a fight run as a sub-task for an errand (see `fight`): the inner task's every tick, over when `until` holds */
class ErrandFight extends BotTask {
    private ticks = 0;
    private readonly spot: SkillStep | null;
    constructor(
        readonly inner: BotTask,
        private readonly until: (p: Player) => boolean,
        private readonly maxTicks: number,
        private readonly watch?: (p: Player) => void,
        /** the errand it fights for: over with it (an errand interrupted ends its fight too) */
        private readonly parent?: ErrandTask
    ) {
        super(`${inner.name}:errand`);
        this.spot = inner.activityStep();
    }
    shouldRun(p: Player): boolean {
        return !this.interrupted && this.inner.shouldRun(p);
    }
    isComplete(p: Player): boolean {
        // (and over when the fight moved to another spot: a level-up takes a CombatTask to the next monsters, not the
        // errand's cows)
        return this.interrupted || (this.parent?.interrupted ?? false) || this.until(p) || this.ticks > this.maxTicks || this.inner.isComplete(p) || this.inner.interrupted || this.inner.activityStep() !== this.spot;
    }
    tick(p: Player): void {
        this.ticks++;
        this.watch?.(p);
        this.inner.tick(p);
    }
    override interrupt(): void {
        super.interrupt();
        this.inner.interrupt();
        this.inner.reset();
    }
    override reset(): void {
        super.reset();
        this.ticks = 0;
        this.inner.reset();
    }
    override activityStep(): SkillStep | null {
        return this.inner.activityStep();
    }
}

// ── lines ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * the errand's lines (data/lines2004-activities.json, event 'errand', the moment's `kinds`): said by a hook the line
 * module sets (port/BotErrandLines: setPieceLine, near others, through the talk budget); none in the bare engine
 */
let lineHook: ((p: Player, kind: string, chance: number) => boolean) | null = null;
export function setErrandLineHook(hook: ((p: Player, kind: string, chance: number) => boolean) | null): void {
    lineHook = hook;
}

/** A line about this moment of the errand (`kind`: 'q-cook-egg'), now and then (`chance`), when someone is near. */
export function say(kind: string, chance = 0.5): Step {
    return {
        label: `say ${kind}`,
        tick(p) {
            lineHook?.(p, kind, chance);
            return 'done';
        }
    };
}

// ── the task ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** An errand's plan (port/BotChains, port/BotErrands, port/BotWildTrips): what the task does and where. */
export interface ErrandPlan {
    /** the task kind ("Hides", "Quest"): the report's group */
    readonly kind: string;
    /** which one ("lumbridge", "cook") */
    readonly key: string;
    /** where it mostly works (its spot: the danger check, the report's places) */
    readonly at: At;
    /** a members' activity */
    readonly members?: boolean;
    /** may it start now? (its tools affordable, its level) */
    ok?(p: Player): boolean;
    /** the round's steps, built at its start */
    build(p: Player): Step[];
    /** another round after this one? (a chain's next load); none: the errand is over after one */
    again?(p: Player, rounds: number): boolean;
    /** the skill whose XP it mostly gives (the planner's no-XP clock: a plan with none, a quest's, ends at its last step) */
    readonly stat?: number;
}

/** what the errands did, for the humanlike report (AM11, QA1, the prayer and magic kinds' hours) and the tests */
export const errandStats = {
    started: {} as Record<string, number>,
    finished: {} as Record<string, number>,
    failed: {} as Record<string, number>,
    failedAt: {} as Record<string, number>,
    rounds: {} as Record<string, number>
};
function bump(map: Record<string, number>, key: string): void {
    map[key] = (map[key] ?? 0) + 1;
}

export class ErrandTask extends BotTask {
    readonly plan: ErrandPlan;
    private steps: Step[] = [];
    private index = 0;
    private rounds = 0;
    private done = false;
    private begun = false;
    private waitTicks = 0;
    private readonly spot: SkillStep;
    /** the step it is on, for the debugger and the report ('state', as the other tasks') */
    state = 'start';
    /** how it ended: 'done', 'fail:<step>' or '' */
    outcome = '';

    constructor(plan: ErrandPlan) {
        super(`${plan.kind}:${plan.key}`);
        this.plan = plan;
        this.spot = { minLevel: 1, maxLevel: 99, action: `errand_${plan.kind.toLowerCase()}`, location: [plan.at[0], plan.at[1], plan.at[2]], toolItemIds: [], xpPerAction: 0, ticksPerAction: 1, successRate: 1, extra: { errand: plan.key } };
    }

    override activityStep(): SkillStep | null {
        return this.spot;
    }

    /** the step's own wait (a bank stop's pause) */
    wait(ticks: number): void {
        this.waitTicks = Math.max(this.waitTicks, ticks);
    }

    shouldRun(player: Player): boolean {
        if (this.done || this.interrupted) return false;
        if (this.plan.members && !isMembersWorld()) return false;
        if (!this.begun && this.plan.ok && !this.plan.ok(player)) return false;
        return true;
    }

    isComplete(_player: Player): boolean {
        // (an interrupted errand is over: hosted as a sub-task (ErrandHost) it stayed one, doing nothing, after its host was
        // interrupted and another task forced in its place: a staker at the Duel Arena stood still)
        return this.done || this.interrupted;
    }

    override reset(): void {
        super.reset();
        // (a reset mid-errand, a plan switch or a sub-task: it starts its round again when it runs next)
        this.steps = [];
        this.index = 0;
        this.waitTicks = 0;
    }

    tick(player: Player): void {
        if (this.interrupted || this.done) return;
        if (this.waitTicks > 0) {
            this.waitTicks--;
            return;
        }
        if (!this.begun) {
            this.begun = true;
            bump(errandStats.started, this.name);
        }
        if (this.steps.length === 0) {
            this.steps = this.plan.build(player);
            this.index = 0;
            if (this.steps.length === 0) return this.finish('done');
        }
        const step = this.steps[this.index];
        this.state = step.label;
        // (a page left open, a level-up's box: clicked away as a player does, unless the step reads its own dialogue)
        if (!step.dialog && botContinuePage(player)) return;
        let r: StepResult;
        try {
            r = step.tick(player, this);
        } catch (err) {
            this.finish(`fail:${step.label}`);
            throw err;
        }
        if (r === 'fail') this.finish(`fail:${step.label}`);
        else if (r === 'done') {
            this.index++;
            if (this.index >= this.steps.length) {
                this.rounds++;
                bump(errandStats.rounds, this.name);
                if (this.plan.again && this.plan.again(player, this.rounds)) {
                    this.steps = [];
                    this.index = 0;
                    this.waitTicks = humanDelay(player, 'next');
                } else this.finish('done');
            }
        }
    }

    private finish(outcome: string): void {
        if (this.done) return;
        this.done = true;
        this.outcome = outcome;
        if (outcome === 'done') bump(errandStats.finished, this.name);
        else {
            bump(errandStats.failed, this.name);
            bump(errandStats.failedAt, `${this.name}|${outcome.slice(5)}`);
        }
    }

    /** rounds done so far */
    get roundsDone(): number {
        return this.rounds;
    }
}

/**
 * An errand run as the bot's sub-task (BotPlayer runs a sub-task before its plan, and no rescan or no-XP clock cuts it):
 * for an errand that earns no XP for long stretches (a quest look-alike's walks and talks, picking crops), which the plan's
 * 15 minutes without XP would end half done. Its name is the errand's (the report's kind); it is over when the errand is.
 */
export class ErrandHost extends BotTask {
    private started = false;
    constructor(readonly errand: ErrandTask) {
        super(errand.name);
    }
    override activityStep(): SkillStep | null {
        return this.errand.activityStep();
    }
    shouldRun(p: Player): boolean {
        return this.started || this.errand.shouldRun(p);
    }
    isComplete(p: Player): boolean {
        if (!this.started) return false;
        if (this.errand.isComplete(p) || this.errand.interrupted) return true;
        // (another sub-task took its place: a "come here", a random event: the errand is over)
        const ai = (p as unknown as { _bot?: { hasSubTask(): boolean } })._bot;
        return !ai?.hasSubTask();
    }
    tick(p: Player): void {
        if (this.started) return;
        const ai = (p as unknown as { _bot?: { setSubTask(t: BotTask): void } })._bot;
        if (!ai) return;
        this.started = true;
        ai.setSubTask(this.errand);
    }
    override interrupt(): void {
        super.interrupt();
        if (this.started && !this.errand.isComplete(null as unknown as Player)) this.errand.interrupt();
    }
    override reset(): void {
        super.reset();
    }
    /** the errand's step now (the report's, the debugger's) */
    get state(): string {
        return this.errand.state;
    }
}

/** (tests) an errand's stats from zero */
export function resetErrandStatsForTest(): void {
    for (const m of Object.values(errandStats)) for (const k of Object.keys(m)) delete m[k];
}

/** the free slots of the pack (re-exported for the plans) */
export { freeSlots, NpcType };
