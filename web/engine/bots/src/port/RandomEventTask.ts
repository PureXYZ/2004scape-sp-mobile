// port: a bot's answer to a random event that came to it (the realism work, phase 5a, Track E; port/BotRandomEvents arms
// the bots near the human and says what came of each flag). A sub-task (BotPlayer.setSubTask, as port/ComeHereTask):
// its main task waits while it runs, and it runs only while something is due (responseDue), a person's moment after
// the event:
//   - a page open (the genie's, the old man's, the lamp's, the box's, the mime's and the maze's) is clicked on;
//   - the genie, the old man and the drunken dwarf: talked to (room made in the pack first: a full pack drops the lamp);
//     the triffid's strange plant picked once it is ready;
//   - the lamp rubbed 10-60 s after it came: 60 % the skill of what the bot does, 25 % a slow one (members: Agility,
//     Herblore, Runecraft, Prayer; free: Prayer, Crafting), 15 % its lowest combat stat; the lamp's buttons as a player
//     presses them (xplamp:<skill>, xplamp:confirm), a skill the world refuses (members on a free world) its lowest
//     combat stat instead;
//   - a strange box opened 5-40 s after it came and answered (the box's own answer, varp %xplamp, the way a player reads
//     the shapes; 10 % a wrong button, and the copy too), never left: boxes replicate every 90 s up to 28;
//   - the mime copied (its emote is its varn npc_int; 10 % wrong each round) and, after 10 minutes on the stage, the
//     unseen way home; the maze finished unseen at its shrine after 90-240 s (274's own end: the cheer, the way home, the
//     reward by the time left), only where no human can see either end;
//   - a tool head picked up and fitted 5-20 s after it landed (never left to be revealed, 100 ticks after it fell), a
//     worn handle off first and the tool worn again after; a big fish's rod or net picked up;
//   - a gas rock or an ent the bot noticed left after a swing or three (its task picks another);
//   - after the fail teleport: a 3-8 s look about, then down the stairs or up a basement's ladder (climbNearby, as the
//     test walked it from all 36 spots), a re-plan from where it is (its task interrupted: the planner picks again,
//     near it); the unseen jump to the spot's exit after 100 ticks, where no human sees either end;
//   - the drops of a hostile event NPC it killed picked up (its own, while there is room); a swarm that comes for a
//     fighter run from (its 255 Hitpoints: 274's way is to walk off).
import type Player from '#/engine/entity/Player.js';
import Npc from '#/engine/entity/Npc.js';
import Loc from '#/engine/entity/Loc.js';
import type Obj from '#/engine/entity/Obj.js';
import World from '#/engine/World.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import NpcType from '#/cache/config/NpcType.js';
import LocType from '#/cache/config/LocType.js';
import Component from '#/cache/config/Component.js';
import { CoordGrid } from '#/engine/CoordGrid.js';
import ScriptState from '#/engine/script/ScriptState.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';
import {
    botAnswerDialogue,
    botContinuePage,
    botScript,
    botTeleport,
    climbNearby,
    findAggressorNpc,
    getBaseLevel,
    interactHeldOp,
    interactHeldOpU,
    interactIF_UseOp,
    interactIfButtonByName,
    interactLocOp,
    interactNpcOp,
    interactObjOp,
    noteMove
} from '#/engine/bot/BotAction.js';
import { OWN_DEFENCE_KINDS, runFromAttackers } from '#/engine/bot/port/BotDefence.js';
import { personaOf } from '#/engine/bot/port/BotPersona.js';
import type { PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { reactionTicks } from '#/engine/bot/port/BotTiming.js';
import { tradeScreen } from '#/engine/bot/port/BotTradeScreen.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { nearestNode, nodePos } from '#/engine/bot/port/BotWalkGraph.js';
import { nearBank } from '#/engine/bot/port/BotLines.js';
import {
    eventContent,
    eventKindOfNpc,
    eventStateOf,
    eventNpcOf,
    failExitFor,
    humanDistance,
    NPC_EVENTS,
    npcInt,
    randomEventListeners,
    sayEvent,
    taskKindOf,
    varp,
    type EventKind,
    type EventState
} from '#/engine/bot/port/BotRandomEvents.js';

/** the maze's shrine (macro_maze_complete, 3x3 at 0_45_71_31_31) and the tile south of it */
const MAZE_SHRINE: [number, number] = [2911, 4575];
const MAZE_LANDING: [number, number] = [2912, 4574];
/** the mime (0_31_74_27_26) */
const MIME_AT: [number, number] = [2011, 4762];
/** after this long on the mime's stage the bot goes home unseen (its 4 in a row take 2-3 minutes) */
const MIME_FALLBACK_TICKS = 1000;
/** the fail teleport's way down: the unseen jump after this long */
const FAIL_FALLBACK_TICKS = 100;
/** a lamp or a box is seen to this near a bank (its booth spot), before the bot deposits its pack */
const LAMP_BANK_TILES = 12;
/** a wrong answer at the box and at the mime this often */
const WRONG_SHARE = 0.1;
/** a click the game did not answer is clicked again after this long */
const RETRY_TICKS = 15;

export class RandomEventTask extends BotTask {
    constructor() {
        super('RandomEvent');
    }

    shouldRun(player: Player): boolean {
        return player.levels[PlayerStat.HITPOINTS] > 0;
    }

    isComplete(player: Player): boolean {
        const st = stateFor(player);
        return st === null || !responseDue(player, st, World.currentTick);
    }

    tick(player: Player): void {
        const st = stateFor(player);
        if (st) respond(player, st, World.currentTick);
    }
}

function stateFor(player: Player): EventState | null {
    return eventStateOf(player);
}

// ── what is due ──────────────────────────────────────────────────────────────

/** a chat page open (a script waiting on "click here to continue"), not a choice */
function pageOpen(player: Player): boolean {
    const s = botScript(player);
    return s !== null && s.execution === ScriptState.PAUSEBUTTON;
}

function carried(player: Player, id: number): { slot: number; count: number } | null {
    if (id === -1) return null;
    const inv = player.getInventory(InvType.INV);
    if (!inv) return null;
    for (let slot = 0; slot < inv.capacity; slot++) {
        const it = inv.get(slot);
        if (it && it.id === id) return { slot, count: it.count };
    }
    return null;
}

function worn(player: Player, id: number): number {
    const w = player.getInventory(InvType.WORN);
    if (!w || id === -1) return -1;
    for (let slot = 0; slot < w.capacity; slot++) if (w.get(slot)?.id === id) return slot;
    return -1;
}

/** a tool head in the pack, and the handle it fits (worn or in the pack) */
function headAndHandle(player: Player): { head: { id: number; slot: number }; handle: number } | null {
    const c = eventContent();
    const inv = player.getInventory(InvType.INV);
    if (!inv) return null;
    for (let slot = 0; slot < inv.capacity; slot++) {
        const it = inv.get(slot);
        if (!it || !c.heads.has(it.id)) continue;
        const pick = (ObjType.get(it.id)?.debugname ?? '').includes('pickaxe');
        const handle = pick ? c.pickHandle : c.axeHandle;
        if (carried(player, handle) || worn(player, handle) !== -1) return { head: { id: it.id, slot }, handle };
    }
    return null;
}

/** the swarm (or another hostile event NPC a fighter cannot win against) that comes for a fighter */
function swarmOnFighter(player: Player): Npc | null {
    if (!OWN_DEFENCE_KINDS.has(taskKindOf(player))) return null;
    const npc = findAggressorNpc(player, 8);
    return npc && eventKindOfNpc(npc) === 'swarm' ? npc : null;
}

/** Is an answer due now? (cheap: the task's isComplete and port/BotRandomEvents ask it every tick) */
export function responseDue(player: Player, st: EventState, now: number): boolean {
    if (player.levels[PlayerStat.HITPOINTS] <= 0) return false;
    if (st.fail) return true;
    // (in a trade nothing is clicked: its window stays, its outcome is the trade's; the answer waits)
    if (player.botTradeTargetPid !== -1 || tradeScreen(player) !== null) return false;
    if (st.zoneKind) return true;
    const ev = st.ev;
    const npcEvent = ev !== null && ev.endedAt < 0 && NPC_EVENTS.has(ev.kind as EventKind);
    if (pageOpen(player) && (now <= st.pageUntil || npcEvent || st.boxSeen >= 0 || st.lampSeen >= 0)) return true;
    if (st.boxSeen >= 0 && now >= st.boxAt) return true;
    if (st.lampSeen >= 0 && now >= st.lampAt) return true;
    // (a lamp or a box at once before a bank, or with a full pack that sends a gatherer to one: a player rubs or opens it
    // first; the deposit took everything but the tools, the lamp too, which 274 will not bank (bank_check_allowed:
    // unbankable), and it was never rubbed)
    if ((st.boxSeen >= 0 || st.lampSeen >= 0) && (nearBank(player.x, player.z, player.level, LAMP_BANK_TILES) || (player.getInventory(InvType.INV)?.freeSlotCount ?? 1) === 0)) return true;
    if (npcEvent && npcAnswerDue(player, ev!, now)) return true;
    if (st.drops.some(d => now >= d.pickAt && d.obj.isActive)) return true;
    if (st.rewield || headAndHandle(player)) return true;
    // (a tool head or a rod on its way to the ground, or there: the bot stands and looks for it, its task waits (without
    // its tool the task would end, and the planner buy another))
    if (holdingForDrop(st)) return true;
    if (ev && ev.endedAt < 0 && (ev.kind === 'gas' || ev.kind === 'ent') && ev.answerAt >= 0 && now >= ev.answerAt && !ev.left && workingHazard(player)) return true;
    if (st.loot && lootNear(player, st) !== null) return true;
    return swarmOnFighter(player) !== null;
}

function holdingForDrop(st: EventState): boolean {
    const ev = st.ev;
    return (ev !== null && ev.endedAt < 0 && (ev.kind === 'lostaxe' || ev.kind === 'lostpickaxe' || ev.kind === 'bigfish')) || st.drops.some(d => d.obj.isActive);
}

function npcAnswerDue(player: Player, ev: NonNullable<EventState['ev']>, now: number): boolean {
    if (ev.ignore || ev.answered || now < ev.answerAt) return false;
    const npc = ev.npc;
    if (!npc || !npc.isActive || !eventNpcOf(npc, player)) return false;
    const n = npcInt(npc);
    // (the plant: it goes to it, and picks it once it is ready; a hostile one is BotDefence's)
    if (ev.kind === 'triffid') return (NpcType.get(npc.type)?.debugname ?? '') === 'macro_triffidseed' && n >= 0;
    // (happy -1, the dwarf angry -2: nothing to say any more)
    return n >= 0 && n < 4;
}

function workingHazard(player: Player): boolean {
    const c = eventContent();
    const t = player.target;
    if (t instanceof Loc) return (LocType.get(t.type)?.category ?? -1) === c.catGas;
    if (t instanceof Npc) return eventKindOfNpc(t) === 'ent';
    return false;
}

function lootNear(player: Player, st: EventState): Obj | null {
    const loot = st.loot;
    if (!loot) return null;
    // (only once the NPC is dead: while it lives, its fight is BotDefence's)
    const ev = st.ev;
    if (ev?.npc && ev.npc.isActive) return null;
    for (let zx = (loot.x - 3) >> 3; zx <= (loot.x + 3) >> 3; zx++) {
        for (let zz = (loot.z - 3) >> 3; zz <= (loot.z + 3) >> 3; zz++) {
            for (const obj of World.gameMap.getZone(zx << 3, zz << 3, loot.level).getAllObjsSafe()) {
                if (!obj.isActive || obj.receiver64 !== player.hash64) continue;
                if (Math.max(Math.abs(obj.x - loot.x), Math.abs(obj.z - loot.z)) > 3) continue;
                if ((ObjType.get(obj.type)?.cost ?? 0) <= 0) continue;
                return obj;
            }
        }
    }
    return null;
}

// ── the answers ──────────────────────────────────────────────────────────────

/** a person's quick click (a page read, the next button): ticks */
function pageTicks(player: Player): number {
    return reactionTicks(personaOf(player.username, (player.botPlanner as PlannerKey) ?? null), 'page');
}

function wait(st: EventState, now: number, ticks: number): void {
    st.actAt = now + Math.max(1, ticks);
}

/** one tick of the answer: the most urgent due thing, a person's moment after the last click */
export function respond(player: Player, st: EventState, now: number): void {
    if (now < st.actAt || player.delayed) return;
    const ev = st.ev;
    if (st.fail) return failRecovery(player, st, now);
    // (a fighter's swarm: walked off)
    if (swarmOnFighter(player)) {
        runFromAttackers(player);
        return;
    }
    if (pageOpen(player)) {
        if (botAnswerDialogue(player, 1)) wait(st, now, pageTicks(player));
        return;
    }
    if (st.zoneKind === 'mime') return mime(player, st, now);
    if (st.zoneKind === 'maze') return maze(player, st, now);
    if (ev && ev.endedAt < 0 && NPC_EVENTS.has(ev.kind as EventKind) && npcAnswerDue(player, ev, now)) return talk(player, st, ev, now);
    if (st.rewield || headAndHandle(player) || st.drops.some(d => now >= d.pickAt && d.obj.isActive)) return tools(player, st, now);
    if (holdingForDrop(st)) return;
    if (ev && ev.endedAt < 0 && (ev.kind === 'gas' || ev.kind === 'ent') && ev.answerAt >= 0 && now >= ev.answerAt && !ev.left && workingHazard(player)) {
        // (a click elsewhere: the swing stops; its task finds another rock or tree, not this one: isEventHazard)
        player.clearPendingAction();
        ev.left = true;
        return;
    }
    if (st.boxSeen >= 0 && now >= st.boxAt) return box(player, st, now);
    if (st.lampSeen >= 0 && now >= st.lampAt) return lamp(player, st, now);
    const loot = lootNear(player, st);
    if (loot) {
        if ((player.getInventory(InvType.INV)?.freeSlotCount ?? 0) < 1) {
            st.loot = null;
            return;
        }
        if (player.target !== loot) interactObjOp(player, loot, 3);
        wait(st, now, 3);
    }
}

/** room in the pack for `slots` more: the commonest gathered item (logs, ore, fish) dropped, one a tick */
function makeRoom(player: Player, slots: number): boolean {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return false;
    if (inv.freeSlotCount >= slots) return true;
    const counts = new Map<number, number>();
    for (let slot = 0; slot < inv.capacity; slot++) {
        const it = inv.get(slot);
        if (it && !ObjType.get(it.id).stackable) counts.set(it.id, (counts.get(it.id) ?? 0) + 1);
    }
    let best = -1;
    let most = 1;
    for (const [id, n] of counts) {
        const name = ObjType.get(id)?.debugname ?? '';
        const gathered = /^(raw_|logs$|oak_logs|willow_logs|maple_logs|yew_logs|magic_logs|blankrune|blank_rune|coal$|clay$|cowhide$|bones$|flax$)/.test(name) || name.endsWith('_ore');
        if (gathered && n >= most) {
            best = id;
            most = n;
        }
    }
    if (best === -1) return false;
    for (let slot = 0; slot < inv.capacity; slot++) {
        if (inv.get(slot)?.id === best) {
            interactHeldOp(player, inv, best, slot, 5);
            return false;
        }
    }
    return false;
}

/** the genie, the old man, the dwarf: talk to it; the plant: pick it */
function talk(player: Player, st: EventState, ev: NonNullable<EventState['ev']>, now: number): void {
    const npc = ev.npc!;
    // (the plant before it is ready: "The fruit isn't ready to be picked yet..." the first time, then it waits by it)
    if (ev.kind === 'triffid' && npcInt(npc) !== 1 && Math.max(Math.abs(player.x - npc.x), Math.abs(player.z - npc.z)) <= 2 && now - st.clickAt < 200) return;
    // (the lamp, the gift, the kebab and the beer: a full pack drops them under the bot)
    const room = ev.kind === 'dwarf' ? 2 : 1;
    if (!makeRoom(player, room) && (player.getInventory(InvType.INV)?.freeSlotCount ?? 0) < room) {
        // (nothing to drop: it talks anyway; the game puts what does not fit on the ground)
        if (st.dropTries++ < 3) {
            wait(st, now, pageTicks(player));
            return;
        }
    }
    if (player.target === npc && now - st.clickAt < RETRY_TICKS) return;
    interactNpcOp(player, npc, 1);
    st.clickAt = now;
    st.pageUntil = now + 40;
}

/** the lamp: rubbed, a skill picked, confirmed (then its page clicked on) */
function lamp(player: Player, st: EventState, now: number): void {
    const c = eventContent();
    const root = rootOf('xplamp:confirm');
    if (root !== -1 && player.modalMain === root) {
        if (!st.lampSkill) st.lampSkill = lampSkill(player);
        const chosen = varp(player, c.varXplamp);
        if (chosen !== 0) {
            const stat = STAT_OF[st.lampSkill] ?? PlayerStat.ATTACK;
            st.lampStat = stat;
            st.lampXp = player.stats[stat];
            st.lampLevel = player.baseLevels[stat];
            interactIfButtonByName(player, 'xplamp:confirm');
            st.pageUntil = now + 30;
            wait(st, now, pageTicks(player));
            return;
        }
        // (a skill the world refuses, members on a free world: the lowest combat stat)
        if (st.lampTries++ >= 2) st.lampSkill = lowestCombat(player);
        interactIfButtonByName(player, `xplamp:${st.lampSkill}`);
        wait(st, now, pageTicks(player));
        return;
    }
    const lampAt = carried(player, c.lamp);
    if (!lampAt) return;
    if (now - st.clickAt < RETRY_TICKS && st.clickAt >= st.lampSeen) {
        // (rubbed: its window opens next tick)
        if (now - st.clickAt < 3) return;
    }
    interactHeldOp(player, player.getInventory(InvType.INV)!, c.lamp, lampAt.slot, 1);
    st.clickAt = now;
    wait(st, now, 2);
}

const STAT_OF: Readonly<Record<string, PlayerStat>> = {
    attack: PlayerStat.ATTACK,
    strength: PlayerStat.STRENGTH,
    ranged: PlayerStat.RANGED,
    magic: PlayerStat.MAGIC,
    defence: PlayerStat.DEFENCE,
    hitpoints: PlayerStat.HITPOINTS,
    prayer: PlayerStat.PRAYER,
    agility: PlayerStat.AGILITY,
    herblore: PlayerStat.HERBLORE,
    thieving: PlayerStat.THIEVING,
    crafting: PlayerStat.CRAFTING,
    runecraft: PlayerStat.RUNECRAFT,
    mining: PlayerStat.MINING,
    smithing: PlayerStat.SMITHING,
    fishing: PlayerStat.FISHING,
    cooking: PlayerStat.COOKING,
    firemaking: PlayerStat.FIREMAKING,
    woodcutting: PlayerStat.WOODCUTTING,
    fletching: PlayerStat.FLETCHING
};
const MEMBERS_SKILLS = new Set(['agility', 'herblore', 'thieving', 'fletching']);
const TASK_SKILL: Readonly<Record<string, string>> = {
    Woodcut: 'woodcutting',
    Mine: 'mining',
    Fish: 'fishing',
    Cook: 'cooking',
    Smith: 'smithing',
    Thieve: 'thieving',
    Agility: 'agility',
    Firemaking: 'firemaking',
    Fletching: 'fletching',
    BowStringing: 'fletching',
    Crafting: 'crafting',
    'Pick Flax': 'crafting',
    Runecrafting: 'runecraft',
    Herblore: 'herblore',
    Prayer: 'prayer'
};

/** the lamp's skill: 60 % what the bot does, 25 % a slow skill, 15 % its lowest combat stat (the world's skills only) */
export function lampSkill(player: Player, random: () => number = Math.random): string {
    const members = isMembersWorld();
    const r = random();
    if (r < 0.6) {
        const kind = taskKindOf(player);
        let skill = TASK_SKILL[kind] ?? null;
        if (kind === 'Combat') skill = lowestCombat(player, ['attack', 'strength', 'defence']);
        if (kind === 'RangedMagic') skill = getBaseLevel(player, PlayerStat.RANGED) >= getBaseLevel(player, PlayerStat.MAGIC) ? 'ranged' : 'magic';
        if (skill && (members || !MEMBERS_SKILLS.has(skill))) return skill;
    }
    if (r < 0.85) {
        const slow = members ? ['agility', 'herblore', 'runecraft', 'prayer'] : ['prayer', 'crafting'];
        return slow[Math.floor(random() * slow.length)];
    }
    return lowestCombat(player);
}

function lowestCombat(player: Player, from: readonly string[] = ['attack', 'strength', 'defence', 'hitpoints', 'ranged', 'magic']): string {
    let best = from[0];
    let level = Infinity;
    for (const s of from) {
        const l = getBaseLevel(player, STAT_OF[s]);
        if (l < level) {
            level = l;
            best = s;
        }
    }
    return best;
}

/** the strange box: opened, then the button its question's answer is (%xplamp: 0 centre, 1 side, 2 top) */
function box(player: Player, st: EventState, now: number): void {
    const c = eventContent();
    const root = rootOf('macro_cube:answer_button1');
    if (root !== -1 && player.modalMain === root) {
        const right = Math.max(0, Math.min(2, varp(player, c.varXplamp)));
        let pressed = right;
        if (Math.random() < WRONG_SHARE) {
            pressed = (right + 1 + Math.floor(Math.random() * 2)) % 3;
            st.boxWrong++;
        }
        interactIfButtonByName(player, `macro_cube:answer_button${pressed + 1}`);
        st.pageUntil = now + 30;
        // (the next box, if any: a few seconds later)
        st.boxAt = now + 3 + Math.floor(Math.random() * 5);
        wait(st, now, 2);
        return;
    }
    const cube = carried(player, c.cube);
    if (!cube) return;
    if (now - st.clickAt < 3) return;
    interactHeldOp(player, player.getInventory(InvType.INV)!, c.cube, cube.slot, 1);
    st.clickAt = now;
}

/** the mime: its emote copied when the emotes' window is up; home unseen after 10 minutes */
function mime(player: Player, st: EventState, now: number): void {
    if (now - st.zoneSince >= MIME_FALLBACK_TICKS) {
        const home = targetCoord(player);
        if (home && unseenJump(player, home[0], home[1], home[2])) wait(st, now, 5);
        else wait(st, now, 50);
        return;
    }
    const root = rootOf('macro_mime_emotes:com_2');
    if (root === -1 || player.modalChat !== root) return;
    if (st.mimeSeen !== root || now - st.clickAt > 20) {
        // (it looks a moment before it copies: the emote shows for a couple of seconds)
        if (st.mimeSeen !== root) {
            st.mimeSeen = root;
            wait(st, now, 2 + Math.floor(Math.random() * 5));
            return;
        }
    }
    const mimeNpc = findNpcNamed(MIME_AT[0], MIME_AT[1], 0, 3, 'macro_mime');
    let n = mimeNpc ? npcInt(mimeNpc) : 0;
    if (n < 0 || n > 7) n = 0;
    if (Math.random() < WRONG_SHARE) n = (n + 1 + Math.floor(Math.random() * 7)) % 8;
    interactIfButtonByName(player, `macro_mime_emotes:com_${2 + n}`);
    st.clickAt = now;
    st.pageUntil = now + 40;
    st.mimeSeen = -1;
    wait(st, now, 6);
}

/** the maze: after 90-240 s (a real maze time), the shrine at its centre, reached unseen (no human sees either end) */
function maze(player: Player, st: EventState, now: number): void {
    if (now < st.zoneDoneAt) return;
    const d = Math.max(Math.abs(player.x - MAZE_SHRINE[0] - 1), Math.abs(player.z - MAZE_SHRINE[1] - 1));
    if (d > 3) {
        if (!unseenJump(player, MAZE_LANDING[0], MAZE_LANDING[1], 0)) wait(st, now, 50);
        else wait(st, now, 2);
        return;
    }
    const shrine = findLocNamed(MAZE_SHRINE[0], MAZE_SHRINE[1], 0, 2, 'macro_maze_complete');
    if (!shrine) return;
    if (player.target === shrine && now - st.clickAt < RETRY_TICKS) return;
    interactLocOp(player, shrine, 1);
    st.clickAt = now;
    st.pageUntil = now + 40;
}

/**
 * (the variety work, round 1, track W: tools in hand) the kind of tool whose handle came off the bot's hands: that kind
 * goes back on, not the first axe or pickaxe in its pack (a miner's name holds its pickaxe now: with the axe's head lost,
 * the pickaxe in its pack went on instead of the fitted axe)
 */
const rewieldKind = new WeakMap<Player, 'axe' | 'pickaxe'>();

/** the tools: a worn handle off, the head picked up and fitted, the tool worn again; a big fish's rod picked up */
function tools(player: Player, st: EventState, now: number): void {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return;
    const hh = headAndHandle(player);
    if (hh) {
        const wornSlot = worn(player, hh.handle);
        if (wornSlot !== -1) {
            if (!makeRoom(player, 1)) return wait(st, now, pageTicks(player));
            const com = Component.getId('wornitems:wear');
            if (com !== -1) interactIF_UseOp(player, com, hh.handle, wornSlot, 1, InvType.WORN);
            st.rewield = true;
            rewieldKind.set(player, hh.handle === eventContent().axeHandle ? 'axe' : 'pickaxe');
            return wait(st, now, pageTicks(player));
        }
        const handle = carried(player, hh.handle);
        if (handle) interactHeldOpU(player, inv, hh.head.id, hh.head.slot, hh.handle, handle.slot);
        return wait(st, now, pageTicks(player));
    }
    const due = st.drops.find(d => now >= d.pickAt && d.obj.isActive);
    if (due) {
        // (a worn handle comes off into the pack too: room for both)
        const c = eventContent();
        const handleWorn = worn(player, c.axeHandle) !== -1 || worn(player, c.pickHandle) !== -1;
        const need = due.kind === 'head' && handleWorn ? 2 : 1;
        if (!makeRoom(player, need)) return wait(st, now, pageTicks(player));
        if (player.target === due.obj && now - st.clickAt < RETRY_TICKS) return;
        interactObjOp(player, due.obj, 3);
        st.clickAt = now;
        return;
    }
    if (st.rewield) {
        // (the fitted tool back in its hands: the kind whose handle came off)
        const kind = rewieldKind.get(player);
        const fits = kind === 'axe' ? /_axe$/ : kind === 'pickaxe' ? /_pickaxe$/ : /_(pickaxe|axe)$/;
        for (let slot = 0; slot < inv.capacity; slot++) {
            const it = inv.get(slot);
            const name = it ? (ObjType.get(it.id)?.debugname ?? '') : '';
            if (it && fits.test(name) && !name.includes('broken')) {
                interactHeldOp(player, inv, it.id, slot, 2);
                break;
            }
        }
        st.rewield = false;
        wait(st, now, pageTicks(player));
    }
}

/** the way back from the fail teleport: a look about, down the stairs (or up a basement's ladder), a re-plan */
function failRecovery(player: Player, st: EventState, now: number): void {
    const f = st.fail!;
    if (now < f.pauseUntil) return;
    if (player.level === 0 && player.z < 6400) return recovered(player, st, now, false);
    // (no stairs answered in FAIL_FALLBACK_TICKS: the unseen jump to the spot's exit, tried every 10 ticks where no human
    // sees either end; the stairs again meanwhile: a bot held past them on an away break, or seen by the human, climbed
    // nothing more and stood upstairs until the human left)
    if (now - f.at >= FAIL_FALLBACK_TICKS && now - f.lastJump >= 10) {
        f.lastJump = now;
        const exit = failExitFor(f.to[0], f.to[1], f.to[2]);
        let [x, z] = exit ? exit.exit : [player.x, player.z];
        if (!exit && player.z >= 6400) {
            const node = nearestNode(f.from[0], f.from[1]);
            if (node >= 0) [x, z] = nodePos(node);
        }
        if (unseenJump(player, x, z, 0)) return recovered(player, st, now, true);
    }
    if (pageOpen(player)) {
        // (a staircase's "Climb up or down?": down, or up out of a basement)
        botAnswerDialogue(player, player.z >= 6400 ? 1 : 2);
        return wait(st, now, pageTicks(player));
    }
    if (player.hasWaypoints() || player.target || now - f.lastClimb < 3) return;
    climbNearby(player, player.z >= 6400 ? 'climb-up' : 'climb-down', 15);
    f.lastClimb = now;
    f.climbs++;
}

function recovered(player: Player, st: EventState, now: number, fallback: boolean): void {
    const f = st.fail!;
    st.fail = null;
    for (const l of randomEventListeners) {
        try {
            l({ type: 'recovered', bot: player, name: player.username, tick: now, ticks: now - f.at, fallback, from: f.to, to: [player.x, player.z, player.level] });
        } catch {
            // (a listener's fault never reaches the world)
        }
    }
    // a re-plan from here: its task ends, the planner picks again, near where it is now (walking back, or another spot)
    BotManager.botFor(player)?.currentTask?.interrupt();
}

/** the unseen jump (botTeleport's rule: no human sees either end), marked real for the runner */
function unseenJump(player: Player, x: number, z: number, level: number): boolean {
    if (humanDistance(player.x, player.z, player.level) <= 17 || humanDistance(x, z, level) <= 17) return false;
    if (!botTeleport(player, x, z, level, 'event')) return false;
    noteMove(player, 'event');
    for (const l of randomEventListeners) {
        try {
            l({ type: 'move', bot: player, name: player.username, tick: World.currentTick, move: 'fallback', to: [x, z, level] });
        } catch {
            // (a listener's fault never reaches the world)
        }
    }
    return true;
}

/** %macro_event_target_coord: where the mime or the maze took the bot from */
function targetCoord(player: Player): [number, number, number] | null {
    const v = varp(player, eventContent().varTargetCoord);
    if (v <= 0) return null;
    const c = CoordGrid.unpackCoord(v);
    return [c.x, c.z, c.level];
}

const roots = new Map<string, number>();
function rootOf(comName: string): number {
    let r = roots.get(comName);
    if (r === undefined) {
        const id = Component.getId(comName);
        r = id === -1 ? -1 : (Component.get(id)?.rootLayer ?? -1);
        roots.set(comName, r);
    }
    return r;
}

function findNpcNamed(x: number, z: number, level: number, radius: number, debugname: string): Npc | null {
    for (let zx = (x - radius) >> 3; zx <= (x + radius) >> 3; zx++) {
        for (let zz = (z - radius) >> 3; zz <= (z + radius) >> 3; zz++) {
            for (const npc of World.gameMap.getZone(zx << 3, zz << 3, level).getAllNpcsSafe()) {
                if (npc.isActive && (NpcType.get(npc.type)?.debugname ?? '') === debugname && Math.max(Math.abs(npc.x - x), Math.abs(npc.z - z)) <= radius) return npc;
            }
        }
    }
    return null;
}

function findLocNamed(x: number, z: number, level: number, radius: number, debugname: string): Loc | null {
    for (let zx = (x - radius) >> 3; zx <= (x + radius) >> 3; zx++) {
        for (let zz = (z - radius) >> 3; zz <= (z + radius) >> 3; zz++) {
            for (const loc of World.gameMap.getZone(zx << 3, zz << 3, level).getAllLocsSafe()) {
                if (loc.isActive && (LocType.get(loc.type)?.debugname ?? '') === debugname && Math.max(Math.abs(loc.x - x), Math.abs(loc.z - z)) <= radius) return loc;
            }
        }
    }
    return null;
}

/** (port/BotRandomEvents) the lamp is gone: its XP told, its line */
export function lampDone(player: Player, st: EventState): void {
    if (st.lampStat < 0) return;
    const xp = player.stats[st.lampStat] - st.lampXp;
    const skill = st.lampSkill ?? 'attack';
    for (const l of randomEventListeners) {
        try {
            l({ type: 'lamp-rubbed', bot: player, name: player.username, tick: World.currentTick, stat: skill, xp, level: st.lampLevel });
        } catch {
            // (a listener's fault never reaches the world)
        }
    }
    sayEvent(player, 'lamp', skill);
    st.lampStat = -1;
    st.lampSkill = null;
    st.lampTries = 0;
}
