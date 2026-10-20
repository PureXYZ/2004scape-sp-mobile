/**
 * BotAction.ts
 *
 * Low-level primitives that drive a real Player using the actual engine APIs.
 * Nothing here teleports. Every movement goes through the pathfinder.
 * (port: but botTeleport, the rescue jump for a stuck bot, which jumps only where no human can see either end)
 * Every interaction goes through setInteraction(). The engine's processInteraction()
 * client click does.
 *
 * Three categories of action:
 *
 *   WALK     — queueWaypoints via botWalkPath (accurate=true, range=104)
 *   INTERACT — setInteraction(Interaction.ENGINE, target, triggerType)
 *              The engine then walks the player to the target and fires the
 *              script trigger once in range. One call = one click.
 *   WORLD    — helpers to find NPCs and Locs near a coordinate so tasks
 *              can look up their targets before interacting.
 *
 * Import surface exposed to tasks:
 *   walkTo(player, x, z)
 *   isNear(player, x, z, dist)
 *   hasWaypoints(player)
 *   isMoving(player)
 *
 *   interactNpc(player, npc)          — op1 on an NPC (open shop, talk, etc.)
 *   interactLoc(player, loc)          — op1 on a Loc (chop tree, mine rock, etc.)
 *   interactLocOp(player, loc, op)    — opN on a Loc (specific option number)
 *   interactNpcOp(player, npc, op)    — opN on an NPC
 *
 *   findNpcNear(x, z, level, npcTypeId, radius)   — search for a live NPC
 *   findLocNear(x, z, level, locTypeId, radius)   — search for a live Loc
 *   findNpcByName(x, z, level, npcName, radius)   — search by debug name
 *   findLocByName(x, z, level, locName, radius)   — search by debug name
 *   findLocByNameWhere(...)                       — search by debug name + predicate
 *
 *   getLevel / getBaseLevel / getXp / addXp
 *   getBackpack / isInventoryFull / freeSlots
 *   countItem / addItem / removeItem / hasItem / clearBackpack
 *   getCombatLevel
 */

import Player from '#/engine/entity/Player.js';
import Npc from '#/engine/entity/Npc.js';
import Loc from '#/engine/entity/Loc.js';
import { Interaction } from '#/engine/entity/Interaction.js';
import { NpcMode } from '#/engine/entity/NpcMode.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import NpcType from '#/cache/config/NpcType.js';
import LocType from '#/cache/config/LocType.js';
import InvType from '#/cache/config/InvType.js';
import { getWorld } from '#/engine/bot/BotWorld.js';
import { botFindPath, botWalkPath, botPathToLoc, botReachedLoc, pathBudgetLeft } from '#/engine/bot/port/BotPathing.js';
import { BotCollisionMap } from '#/engine/bot/BotCollisionMap.js';
import { findNearestWalkableTile } from '#/engine/bot/BotNavigation.js';
import { MoveSpeed } from '#/engine/entity/MoveSpeed.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import Obj from '#/engine/entity/Obj.js';
import ObjType from '#/cache/config/ObjType.js';
import ScriptRunner from '#/engine/script/ScriptRunner.js';
import { EntityLifeCycle } from '#/engine/entity/EntityLifeCycle.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import CategoryType from '#/cache/config/CategoryType.js';
import { Inventory } from '#/engine/Inventory.js';
import { Items, dungeonRoute, type DungeonRoute } from '#/engine/bot/BotKnowledge.js';
import UnsetMapFlag from '#/network/game/server/model/UnsetMapFlag.js';
import Environment from '#/util/Environment.js';
import Component from '#/cache/config/Component.js';
import ScriptState from '#/engine/script/ScriptState.js';
import ParamType from '#/cache/config/ParamType.js';
import SeqType from '#/cache/config/SeqType.js';
import World from '#/engine/World.js';
import * as rsbuf from '#/network/rsbuf/index.js';
import { BotDebugService, itemName, npcDebugName, locDebugName } from '#/engine/bot/debug/BotDebugService.js';
import { invAddAll } from '#/engine/bot/port/BotInventoryCompat.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { tollGateIds } from '#/engine/bot/port/BotContent.js';
import { nearestNodes, nodePos, route as graphRoute, routeCost as graphRouteCost, componentOf, nodeAt } from '#/engine/bot/port/BotWalkGraph.js';
import { isAllowedCoord, isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { armourPieceOf, canWearPiece, isDragonShield, isSignatureHat, isWardrobeItem } from '#/engine/bot/port/BotLooks.js';
import { meleeWeaponOf, WEAPON_ATTACK } from '#/engine/bot/port/BotOutfits.js';
import { teleportLeg } from '#/engine/bot/port/BotTeleport.js';
import { travelLeg } from '#/engine/bot/port/BotTravel.js'; // (variety round 2, Track D2)
import { exitLeg, exiting } from '#/engine/bot/port/BotExits.js'; // (variety round 2, the fixes)
// (the realism work, phase 5a, Track M: a cast or a crossing's preparation pauses the stuck checks, White Wolf Mountain
// is crossed at a run, a wrong turn's 'lost' line; wrong turns read the walking graph's neighbours and the danger map)
import { leadsAFriend, noteWrongTurn, runsAcross, travelPaused } from '#/engine/bot/port/BotTeleport.js';
import { neighbours as graphNeighbours } from '#/engine/bot/port/BotWalkGraph.js';
import { dangerOfNode, huntsMe } from '#/engine/bot/port/BotDanger.js';
import { personaOf } from '#/engine/bot/port/BotPersona.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import type { PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { canTravel, CollisionType, LocShape } from '#/engine/routefinder/index.js';

/** Debug-only: resolves the BotPlayer wrapper's name off a Player, or null for real (non-bot) players. */
function _debugBotName(player: Player): string | null {
    return (player as any)._bot?.name ?? null;
}

/**
 * Debug-only: records the start of an NPC/Loc interaction as an in-flight
 * BotDebugAction. Resolution (success/failed/timeout) happens generically in
 * BotPlayer's per-tick debug hook by observing XP/inventory deltas and an
 * age-based timeout — this function only ever records that the click happened.
 * No-op (and zero-cost beyond one map lookup) for real players / when disabled.
 */
function _debugStartInteraction(
    player: Player,
    type: string,
    targetType: 'npc' | 'loc',
    targetId: number,
    targetName: string,
    x: number,
    z: number,
    op: number
): void {
    try {
        const botName = _debugBotName(player);
        if (!botName) return;
        BotDebugService.startAction(botName, type, `${type === 'interactLoc' || type === 'interactLocOp' ? 'oploc' : 'opnpc'}${op} ${targetName}`, {
            type: targetType,
            id: targetId,
            name: targetName,
            x, z,
            level: player.level
        });
        BotDebugService.noteTarget(botName, targetName);
    } catch {
        // debug hook must never affect gameplay
    }
}

export { PlayerStat };

// ── Teleport helper ───────────────────────────────────────────────────────────

/**
 * port: how far (tiles, Chebyshev, the same floor) a human sees another player: 274 lists the players within 15 tiles
 * of you (rsbuf BuildArea.PREFERRED_VIEW_DISTANCE), plus a margin for the human's next steps.
 */
export const HUMAN_SIGHT = 17;

/** port: why a bot jumps, for the teleport counters (test/sim.mjs reports them by task and reason). */
// ('event', the realism work's phase 5a: a random event's unseen fallbacks, the maze's finish and the way back from a fail
// teleport that found no stairs; port/BotRandomEvents marks them for the runner with port/BotMoves)
export type TeleportReason = 'watchdog' | 'stuck' | 'gateway' | 'dungeon' | 'task' | 'event';

/**
 * port (the realism work, phase 5a): a move a player could see that is not the unseen rescue jump: a real teleport
 * spell ('spell', port/BotTeleport) or a random event's ('event', port/BotRandomEvents: the game's fail teleport, the
 * maze and the mime in and out, the two unseen fallbacks the spec names). The library marks them (noteMove); the
 * humanlike runner classes a jump near a mark as that, not as a jump (its H21). (Phase 5b, Track A: 'duel', 274's own
 * jumps of a duel's two players into the arena and back to the hospital: port/BotDuel.)
 */
export type MoveClass = 'spell' | 'event' | 'duel';

/** port: teleports since the world started: done (unseen, silent) and refused (a human could see an end). */
export const teleportStats = {
    jumps: 0,
    refused: 0,
    /** `<task kind>/<reason>` (`/gateway:<name>` for a gateway's) -> [jumps, refused] */
    byCause: new Map<string, [number, number]>(),
    /** (phase 5a) the moves marked real, oldest first, capped: bot name (lower case), class, tick (noteMove) */
    marks: [] as { name: string; cls: MoveClass; tick: number }[]
};

const MAX_MOVE_MARKS = 5000;

/** port (phase 5a): mark the bot's move now, or one a few ticks from now (a cast lands about 3 ticks later), as real. */
/** port (the variety work, round 2): inside the rune essence mine's instance (RunecraftingTask's box) */
export function inRuneEssenceMine(x: number, z: number): boolean {
    return x >= 2870 && x <= 2950 && z >= 4790 && z <= 4870;
}

export function noteMove(player: Player, cls: MoveClass): void {
    const marks = teleportStats.marks;
    marks.push({ name: player.username.toLowerCase(), cls, tick: World.currentTick });
    if (marks.length > MAX_MOVE_MARKS) marks.splice(0, marks.length - MAX_MOVE_MARKS);
}

/** port: is a human (a player that is not a bot) within HUMAN_SIGHT of (x, z) on that floor? */
export function humanCanSee(x: number, z: number, level: number): boolean {
    for (const p of World.playerLoop.all()) {
        if (p.is_bot === true || p.level !== level) continue;
        if (Math.max(Math.abs(p.x - x), Math.abs(p.z - z)) <= HUMAN_SIGHT) return true;
    }
    return false;
}

function _countTeleport(player: Player, reason: TeleportReason, done: boolean, detail?: string): void {
    if (done) teleportStats.jumps++;
    else teleportStats.refused++;
    const task = ((player as any)._bot?.currentTask?.name as string | undefined)?.split(':')[0] ?? '-';
    const key = `${task}/${reason}${detail ? `:${detail}` : ''}`;
    let entry = teleportStats.byCause.get(key);
    if (!entry) teleportStats.byCause.set(key, (entry = [0, 0]));
    entry[done ? 0 : 1]++;
}

/**
 * Moves a bot to (x, z, level) at once.
 *
 * port: the teleport policy (BOTS.md, "Teleports"). Players in 2004 walked; a bot jumps only where no human can see
 * it, at either end (humanCanSee), and silently: no cast animation, nothing for anyone to see. Where a human could
 * see, it does not jump and returns false: the caller walks on, or waits. Upstream cast the spellbook teleport
 * (a 2-tick cast, then the jump) for every stuck walk, watchdog, toll gate, boat and hub hop, in front of everyone.
 * The jump also drops the walk queue and the interaction (the real teleport proc starts with p_stopaction: upstream
 * kept both, and a bot that landed walked back the way it came), and a dead bot does not jump (its death script runs).
 */
export function botTeleport(player: Player, x: number, z: number, level: number, reason: TeleportReason = 'task', detail?: string): boolean {
    // port: land on an open tile near the target (see _landingTile)
    [x, z] = _landingTile(level, x, z);

    if (player.levels[PlayerStat.HITPOINTS] <= 0 || humanCanSee(player.x, player.z, player.level) || humanCanSee(x, z, level)) {
        _countTeleport(player, reason, false, detail);
        return false;
    }
    // port: not in the middle of a script that moves the bot (an agility obstacle, a boat's sail): 274's agility_walk
    // steps one tile at a time toward the end it worked out, so a bot jumped away mid-obstacle overflowed the script's
    // stack (gosub_with_params, every tick). A chat page left open does not hold it (the caller tries again later)
    const script = botScript(player);
    if (player.delayed || (script && script.execution !== ScriptState.PAUSEBUTTON && script.execution !== ScriptState.COUNTDIALOG)) return false;

    try {
        const botName = _debugBotName(player);
        if (botName) BotDebugService.event(botName, 'movement', `teleport to (${x},${z},${level}) (${reason})`, { x, z, level });
    } catch {
        // debug hook must never affect gameplay
    }

    player.clearPendingAction();
    player.clearWaypoints();
    player.teleJump(x, z, level);
    _countTeleport(player, reason, true, detail);
    return true;
}

/** port: a landing tile must reach this many tiles in single steps, within LANDING_RADIUS of it. */
const LANDING_MIN_AREA = 12;
const LANDING_RADIUS = 6;
/** port: how far from the target a landing may spread, so bots sent to one spot do not stand on one tile. */
const LANDING_SPREAD = 2;

/**
 * port: the tile a teleport lands on. Upstream jumped to the exact tile it was given, often a random spot in an area
 * or a resource tile, which could be blocked or a pocket shut in by stalls, tables or walls: the bot then stood
 * there, unable to take a step, until a watchdog moved it again (a social bot in Varrock square, test/sim.mjs).
 * An open tile, picked at random among those a walk of LANDING_SPREAD steps from (x, z) reaches (so never across a
 * wall from it), else the nearest open tile within 8, else (x, z).
 */
function _landingTile(level: number, x: number, z: number): [number, number] {
    if (_openArea(level, x, z) >= LANDING_MIN_AREA) {
        const near = _reachableNear(level, x, z, LANDING_SPREAD);
        for (let tries = 0; tries < 4 && near.length > 0; tries++) {
            const i = Math.floor(Math.random() * near.length);
            const [tx, tz] = [near[i] >> 14, near[i] & 0x3fff];
            if (_openArea(level, tx, tz) >= LANDING_MIN_AREA) return [tx, tz];
        }
        return [x, z];
    }
    for (let r = 1; r <= 8; r++) {
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                if (_openArea(level, x + dx, z + dz) >= LANDING_MIN_AREA) return [x + dx, z + dz];
            }
        }
    }
    return [x, z];
}

/** port: the tiles (packed x << 14 | z) a player on (x, z) walks to in at most `steps` single N/S/E/W steps. */
function _reachableNear(level: number, x: number, z: number, steps: number): number[] {
    const seen = new Set<number>([(x << 14) | z]);
    let frontier: number[] = [x, z];
    for (let s = 0; s < steps; s++) {
        const next: number[] = [];
        for (let i = 0; i < frontier.length; i += 2) {
            const cx = frontier[i];
            const cz = frontier[i + 1];
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const key = ((cx + dx) << 14) | (cz + dz);
                if (seen.has(key) || BotCollisionMap.isCsvBlocked(level, cx + dx, cz + dz) || !canTravel(level, cx, cz, dx, dz, 1, 0, CollisionType.NORMAL)) continue;
                seen.add(key);
                next.push(cx + dx, cz + dz);
            }
        }
        frontier = next;
    }
    return [...seen];
}

/** port: the tiles (packed x << 14 | z) a player on (x, z) walks to in at most `steps` single steps (walls count). */
export function tilesInReach(level: number, x: number, z: number, steps: number): number[] {
    return _reachableNear(level, x, z, steps);
}

/** port: the tiles (packed x << 14 | z) a player on (x, z) walks to without leaving the square of `radius` around it */
export function tilesInSquare(level: number, x: number, z: number, radius: number): Set<number> {
    const seen = new Set<number>([(x << 14) | z]);
    const queue: number[] = [x, z];
    for (let i = 0; i < queue.length; i += 2) {
        const cx = queue[i];
        const cz = queue[i + 1];
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const key = ((cx + dx) << 14) | (cz + dz);
            if (Math.abs(cx + dx - x) > radius || Math.abs(cz + dz - z) > radius || seen.has(key)) continue;
            if (BotCollisionMap.isCsvBlocked(level, cx + dx, cz + dz) || !canTravel(level, cx, cz, dx, dz, 1, 0, CollisionType.NORMAL)) continue;
            seen.add(key);
            queue.push(cx + dx, cz + dz);
        }
    }
    return seen;
}

/** How many tiles (up to LANDING_MIN_AREA) a player on (x, z) reaches in single N/S/E/W steps without going far. */
function _openArea(level: number, x: number, z: number): number {
    if (BotCollisionMap.isCsvBlocked(level, x, z)) return 0;
    const seen = new Set<number>([x * 16384 + z]);
    const queue: number[] = [x, z];
    for (let i = 0; i < queue.length && seen.size < LANDING_MIN_AREA; i += 2) {
        const cx = queue[i];
        const cz = queue[i + 1];
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx;
            const nz = cz + dz;
            if (Math.abs(nx - x) > LANDING_RADIUS || Math.abs(nz - z) > LANDING_RADIUS || seen.has(nx * 16384 + nz)) continue;
            if (BotCollisionMap.isCsvBlocked(level, nx, nz) || !canTravel(level, cx, cz, dx, dz, 1, 0, CollisionType.NORMAL)) continue;
            seen.add(nx * 16384 + nz);
            queue.push(nx, nz);
        }
    }
    return seen.size;
}

// ── Walking ───────────────────────────────────────────────────────────────────

/**
 * Gateway regions — fenced or walled areas that require routing through a
 * specific approach tile / gate before reaching the interior destination.
 *
 * When walkTo() is called with a destination inside one of these regions and
 * the bot is currently outside, it walks to `approach` first, then tries
 * to open the gate before walking to `exit`. Once the bot is inside
 * the region normal pathfinding resumes. When leaving the region,
 * the bot will instead first go to `exit` and then to `approach`.
 * So only one gateway needs to be defined to handle both entry and exit.
 *
 * When adding a gateway to a region, bots will no longer enter/exit that
 * region through other means so make sure to also add a gateway to other
 * entrances even if they are open-ended and would otherwise not be required.
 * For readability, gateways are grouped by the region they are part of.
 *
 * Coordinate bounds are conservative on purpose — when in doubt keep them tight
 * so ordinary nearby destinations are never accidentally re-routed.
 */
type GatewayRegion = {
    readonly name: string;
    /** Destination is in the gated area. */
    readonly destInRegion: (x: number, z: number, l: number) => boolean;
    /**
     * Tile outside the region to approach from so the bot faces the gate from
     * the correct side. A second tile can be provided to create an area.
     * Keep the area small, for example a line that is one tile wide.
     */
    readonly approach: number[][];
    /**
     * Tile inside the region to exit from so the bot faces the gate from
     * the correct side. A second tile can be provided to create an area.
     * Keep the area small, for example a line that is one tile wide.
     */
    readonly exit: number[][];
    /**
     * If set, floor of the approach. Defaults to 0 (ground floor).
     */
    readonly approachLevel?: number;
    /**
     * If set, floor of the exit. Defaults to 0 (ground floor).
     */
    readonly exitLevel?: number;
    /**
     * If set, the bot is teleported instead of interacting with the gate.
     * Use for gates that require a toll or complex dialog that bots cannot
     * handle (e.g. the Al Kharid toll gate). Teleport location is
     * a random tile in the exit area (or approach area when leaving).
     */
    readonly teleport?: boolean;
};

const GATEWAY_REGIONS: GatewayRegion[] = [
    {
        // ── Lumbridge castle ──────────────────────────────────────────────────
        // Bots anywhere in the castle band (x > 3200, including Lumbridge spawn
        // at 3222,3219) heading west toward Draynor village (x < 3185) have the
        // castle walls across their straight-line path.  The BFS can route
        // around the castle, but the 90-tile midpoint often lands on the wrong
        // side of the walls and returns empty, leaving the bot looping on the
        // compass fallback.
        //
        // Fix: Force bots to enter and leave through the north of the castle.
        // If they head for Draynor, they automatically pick the west most tile.
        name: 'Lumbridge',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'Lumbridge',
            'MisthalinEast',
            'Desert']),
        approach: [[3200, 3238], [3228, 3238]],
        exit: [[3201, 3237], [3228, 3237]]
    },
    {
        // ── Seers' village spinning house ↔ upstairs (ladder) ─────────────────
        // port: Seers' spinning wheel (2711,3471,1), for the flax picked next to the village
        name: 'SeersSpinning1',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'SeersSpinning1']),
        approach: [[2714, 3471]],
        exit: [[2714, 3470]],
        exitLevel: 1
    },
    {
        // ── Lumbridge castle ↔ 1st floor (south-west spiral staircase) ────────
        // port: up to the spinning wheel (3209,3212,1) and back down by the stairs, as players went; upstream's
        // crafting task teleported up from outside the castle and back down.
        name: 'LumbridgeCastle1',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'LumbridgeCastle1']),
        // (in the stairs' room, behind three doors from the courtyard: walkTo opens them, _openDoorToward)
        approach: [[3206, 3210]],
        exit: [[3206, 3210]],
        exitLevel: 1
    },
    {
        // ── the Wizards' Guild ↔ its first floor (stairs) ─────────────────────
        // port (the realism work, phase 5a, Track M): up to the Magic Guild Store (laws at Magic 66, members:
        // tasks/LawTripTask) and back down by the stairs, as players went; inside the guild, behind its doors (Magic 66:
        // their own script; walkTo opens them, _openDoorToward)
        name: 'WizardsGuild1',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'WizardsGuild1']),
        // (the stairs are climbed from their south side, the top's way down from its north: stairs.loc forceapproach)
        approach: [[2590, 3088]],
        exit: [[2590, 3092]],
        exitLevel: 1
    },
    // ---- (the variety work, round 2, track W2: fashion; round 1's leftover "the shops bots cannot reach") ----
    {
        // ── the Champions' Guild ↔ its first floor (stairs): Scavvo's runite shop and Valaine's ──────────────────────
        // (the stairs at 3188,3355 turned about: climbed from their north side, the top's way down from its south;
        // inside the guild, behind its door: 32 quest points, every bot's; walkTo opens it, _openDoorToward)
        name: 'ChampionsGuild1',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'ChampionsGuild1']),
        approach: [[3188, 3358], [3189, 3358]],
        exit: [[3188, 3354], [3189, 3354]],
        exitLevel: 1
    },
    {
        // ── the Champions' Guild's door (its hall on the ground floor) ───────────────────────────────────────────────
        // (the door puts a player through by its script, p_teleport; from inside the hall a walk anywhere far found no
        // way out: the walking graph's start is outside its walls, and the bot paced the hall until a rescue jump, 220
        // tiles to Falador. Out by the door first, as the way in)
        name: 'ChampionsGuild0',
        // (behind the door: the hall, and the first floor above it, which only its stairs reach: a walk from the hall up
        // to Valaine's is no walk out of the door; checkRegion's level-0 region would be every floor's, wider than the hall)
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            l === 0 ? 'ChampionsGuild0' : 'ChampionsGuild1']),
        approach: [[3191, 3364]],
        exit: [[3191, 3362]]
    },
    {
        // ── the Heroes' Guild ↔ its first floor (spiral stairs): Helemos' dragon weapons (members) ─────────────────
        // (the spiral stairs at 2895,3513, from the east; the top's way down from its east: spiralstairstop forceapproach;
        // behind the guild's doors: Heroes' Quest, every bot's)
        name: 'HeroesGuild1',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'HeroesGuild1']),
        approach: [[2897, 3513]],
        exit: [[2897, 3513]],
        exitLevel: 1
    },
    // ---- end of track W2's block ----
    {
        // ── Lumbridge sheep pen (gate) ────────────────────────────────────────
        // Fenced enclosure NE of Lumbridge castle. East gate at ~[3213, 3261].
        // Bots walking directly to the interior hit the fence unless they
        // approach from the east side and open the gate.
        name: 'LumbridgeSheep',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'LumbridgeSheep']),
        approach: [[3213, 3261], [3213, 3262]],
        exit: [[3212, 3261], [3212, 3262]]
    },
    {
        // ── Lumbridge ↔ Toll Gate ─────────────────────────────────────────────
        // South bridge over River Lum.
        name: 'RiverLumSouth',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'MisthalinEast',
            'Desert',
            'Wilderness',
            'Morytania']),
        approach: [[3244, 3225], [3244, 3226]],
        exit: [[3245, 3225], [3245, 3226]]
    },
    {
        // ── Lumbridge ↔ Varrock ───────────────────────────────────────────────
        // Second south bridge over River Lum near furnace.
        name: 'RiverLumSouth2',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'MisthalinEast',
            'Desert',
            'Wilderness',
            'Morytania']),
        approach: [[3234, 3261], [3234, 3262]],
        exit: [[3235, 3261], [3235, 3262]]
    },
    {
        // ── Barbarian Village ↔ Varrock ───────────────────────────────────────
        // Bridge over River Lum near Barbarian Village.
        name: 'RiverLumBarb',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'MisthalinEast',
            'Desert',
            'Morytania']),
        approach: [[3104, 3420], [3104, 3421]],
        exit: [[3105, 3420], [3105, 3421]]
    },
    {
        // ── Edgeville ↔ Varrock North ─────────────────────────────────────────
        // North bridge over River Lum near Wilderness.
        name: 'RiverLumNorth',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'MisthalinEast',
            'Wilderness',
            'Morytania']),
        approach: [[3131, 3516], [3131, 3518]],
        exit: [[3132, 3516], [3132, 3518]]
    },
    {
        // ── Lumbridge cow pen (gate) ──────────────────────────────────────────
        // Fenced enclosure north of Lumbridge castle.  South gate at ~[3253, 3265].
        // Bots walking directly to the interior ([3255, 3276]) hit the south
        // fence unless they approach through the gate tile.
        name: 'LumbridgeCow',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'LumbridgeCow']),
        approach: [[3252, 3266], [3252, 3267]],
        exit: [[3253, 3266], [3253, 3267]]
    },
    {
        // ── Lumbridge's west cow field (gate) ─────────────────────────────────
        // port (the variety work, round 1, track F): the fenced field north-west of Lumbridge (Locations.COWS_LUMBRIDGE2,
        // 3175,3320) opens only by its double gate on the south fence (loc_1551/loc_1553 at 3174-3175,3316; 274's map:
        // 1,410 tiles inside, no other way in). The walking graph's nodes inside it are a component of their own, so a
        // fighter walked to and fro outside until the watchdog jumped it in (15-25 of a 100-bot run's 20-45 rescue jumps)
        name: 'LumbridgeCowWest',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'LumbridgeCowWest']),
        approach: [[3174, 3315], [3175, 3315]],
        exit: [[3174, 3316], [3175, 3316]]
    },
    {
        // ── Varrock Square ↔ Varrock Palace ───────────────────────────────────
        // The yews at [3204, 3499] are north of Varrock palace and reachable
        // only by navigating through the city. Routing through the Varrock
        // south road entry gives the pathfinder a clear corridor to follow.
        name: 'VarrockPalace',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'VarrockPalace']),
        approach: [[3212, 3438], [3213, 3438]],
        exit: [[3212, 3439], [3213, 3439]]
    },
    {
        // ── Varrock East ↔ Varrock Palace ─────────────────────────────────────
        // East entrance to Varrock Palace.
        name: 'VarrockPalaceEast',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'VarrockPalace']),
        approach: [[3235, 3464], [3235, 3467]],
        exit: [[3234, 3465], [3234, 3466]]
    },
    {
        // ── Lumbridge ↔ Al Kharid (gate) ──────────────────────────────────────
        // The Lumbridge-AlKharid wall runs at x ≈ 3268, z ≈ 3197..3244.
        // Gate tile: ~[3268, 3227].  Destinations inside: warriors, bank,
        // scimitar shop, furnace, etc.  Bots must approach from the west side
        // (Lumbridge) to open the gate — NOT from the south where the wall has
        // no opening.  Without this routing a bot walking to [3294, 3172] hits
        // the wall 55 tiles south of the gate and can never open it.
        //
        // The gate charges a 10-coin toll and opens a dialog that bots cannot
        // handle.  Once the bot reaches the approach tile it is teleported
        // directly to the inside (3268, 3227) — the first open tile past the wall.
        name: 'AlKharid',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'Desert']),
        approach: [[3267, 3227], [3267, 3228]],
        exit:     [[3268, 3227], [3268, 3228]],
        teleport: true
    },
    {
        // ── Varrock ↔ Al Kharid ───────────────────────────────────────────────
        // Bots from Varrock should go through the opening in the fence to
        // the north instead of going to the south gate.
        name: 'AlKharidNorth',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'Desert']),
        approach: [[3279, 3330], [3285, 3330]],
        exit: [[3279, 3329], [3285, 3329]]
    },
    {
        // ── Al Kharid ↔ Desert (gate) ─────────────────────────────────────────
        // Access to the Kharidian desert via Shantay Pass. Requires a toll/pass
        // so bots teleport through the gate.
        name: 'ShantayPass',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'DesertSouth']),
        approach: [[3303, 3118], [3304, 3118]],
        exit: [[3303, 3115], [3304, 3115]],
        teleport: true
    },
    {
        // ── Port Sarim ↔ Draynor ──────────────────────────────────────────────
        // The Draynor market has a fence on its east side (x ≈ 3083, z ≈ 3248–
        // 3261). Bots leaving the Draynor bank (3092, 3245) heading northwest
        // toward Falador furnace, Falador range, or Barbarian Village willows
        // find the fence blocking the direct westward path through z ≈ 3248–
        // 3261. Via (3070, 3277) — just north of the fence top — the bot rounds
        // the corner and then has a clear westward run.
        name: 'DraynorFence',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'Misthalin',
            'Desert',
            'Wilderness',
            'Morytania']),
        approach: [[3069, 3276], [3069, 3278]],
        exit: [[3070, 3276], [3070, 3278]]
    },
    {
        // ── Falador ↔ Barbarian Village ───────────────────────────────────────
        // The fence gets largely removed in revision 360. By checking the
        // current revision we can ensure better compatilibty between revisions.
        // This gateway automatically gets disabled after that.
        name: 'BarbFence',
        destInRegion: (x, z, l) => Environment.engine.revision < 360 && checkRegion(x, z, l, [
            'Misthalin',
            'Desert',
            'Wilderness',
            'Morytania']),
        approach: [[3068, 3417], [3068, 3418]],
        exit: [[3069, 3416], [3069, 3418]]
    },
    {
        // ── Falador ↔ Barbarian Village ───────────────────────────────────────
        // Only enabled after revision 360. We still need a gateway otherwise
        // the bots walk all the way to the Draynor gateway.
        name: 'BarbFenceRemoved',
        destInRegion: (x, z, l) => Environment.engine.revision >= 360 && checkRegion(x, z, l, [
            'Misthalin',
            'Desert',
            'Wilderness',
            'Morytania']),
        approach: [[3068, 3327], [3068, 3446]],
        exit: [[3069, 3328], [3069, 3445]]
    },
    {
        // ── Port Sarim ↔ Entrana (boat) ───────────────────────────────────────
        // Bots heading to Entrana (gathering herblore supplies or woodcutting)
        // walk to the Port Sarim northern docks and teleport to Entrana.
        name: 'Entrana',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'Entrana']),
        approach: [[3048, 3234]],
        exit: [[2834, 3335]],
        teleport: true
    },
    {
        // ── Falador ↔ Taverley (gate) ─────────────────────────────────────────
        // The long wall between Falador and Taverley.
        name: 'Taverley',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'Taverley',
            'Kandarin',
            'Feldip',
            'Troll',
            'Tirannwn',
            'Fremennik']),
        approach: [[2936, 3450], [2936, 3451]],
        exit: [[2935, 3450], [2935, 3451]]
    },
    {
        // ── Port Sarim ↔ Taverley (gate) ──────────────────────────────────────
        // Taverley south gate near Dark Wizards' Tower.
        name: 'TaverleySouth',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'Taverley',
            'Kandarin',
            'Feldip',
            'Troll',
            'Tirannwn',
            'Fremennik']),
        approach: [[2933, 3319], [2934, 3319]],
        exit: [[2933, 3320], [2934, 3320]]
    },
    {
        // ── Taverley ↔ White Wolf Mountain ────────────────────────────────────
        // Bots heading from Taverley/Falador (x > 2870) toward Catherby/Seers
        // (x < 2800) must route through the mountain pass.
        // The BFS often gets lost in the mountain crags.
        name: 'WhiteWolf',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'WhiteWolf',
            'Kandarin',
            'Feldip',
            'Tirannwn',
            'Fremennik']),
        approach: [[2864, 3441], [2868, 3441]],
        exit: [[2864, 3442], [2868, 3442]]
    },
    {
        // ── White Wolf Mountain East ↔ White Wolf Mountain West ────────────────
        // Top of the mountain near the gnome glider.
        name: 'WhiteWolfWest',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'WhiteWolfWest',
            'Kandarin',
            'Feldip',
            'Tirannwn',
            'Fremennik']),
        approach: [[2853, 3508], [2853, 3510]],
        exit: [[2852, 3508], [2852, 3510]]
    },
    {
        // ── Port Sarim ↔ Karamja (boat) ───────────────────────────────────────
        // Bots heading to Karamja fishing spots (x < 2970) walk to the Port
        // Sarim docks (~3029, 3217) and are teleported to the Karamja landing
        // (2956, 3146). The boat costs 30 coins and triggers a dialog that
        // bots cannot handle natively, so teleport is used instead.
        // port: they take it as players do (SCRIPTED_CROSSINGS); the jump only if that fails
        name: 'MusaPointBoat',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'Karamja',
            'Kandarin',
            'Feldip',
            'Tirannwn',
            'Fremennik']),
        approach: [[3029, 3217]],
        exit: [[2956, 3146]],
        teleport: true
    },
    {
        // ── Musa Point ↔ Brimhaven (gate) ─────────────────────────────────────
        // Fence between Musa Point and Brimhaven.
        name: 'BrimhavenFence',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'Karamja',
            'Kandarin',
            'Feldip',
            'Tirannwn',
            'Fremennik']) &&
            !checkRegion(x, z, l, [
                'MusaPoint']),
        approach: [[2816, 3182], [2816, 3183]],
        exit: [[2815, 3182], [2815, 3183]]
    },
    {
        // ── Varrock ↔ Wilderness ──────────────────────────────────────────────
        // Longest stretch of the Wilderness border. This is compatible until
        // revision 456 where the Ditch is added. Coordinates will still be
        // correct but interaction would need to be added.
        name: 'WildernessVarrock',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'Wilderness']),
        approach: [[3135, 3520], [3327, 3520]],
        exit: [[3135, 3523], [3327, 3523]]
    },
    {
        // ── Edgeville ↔ Wilderness ────────────────────────────────────────────
        // Also includes the stretch with the Monastery.
        name: 'WildernessEdgeville',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'Wilderness']),
        approach: [[3042, 3520], [3123, 3520]],
        exit: [[3041, 3523], [3122, 3523]]
    },
    {
        // ── Ice Mountain ↔ Wilderness ─────────────────────────────────────────
        // Small passage connecting Ice Mountain with the Wilderness.
        name: 'WildernessIceMountain',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'Wilderness']),
        approach: [[2998, 3529], [2998, 3533]],
        exit: [[2995, 3529], [2995, 3534]]
    },
    {
        // ── Mind Altar ↔ Wilderness ───────────────────────────────────────────
        // Only enabled prior to revision 249 for backwards compatiblity.
        // After that it opens up to include the Chaos Temple.
        name: 'WildernessWestOld',
        destInRegion: (x, z, l) => Environment.engine.revision < 249 && checkRegion(x, z, l, [
            'Wilderness']),
        approach: [[2967, 3520], [2992, 3520]],
        exit: [[2967, 3523], [2992, 3523]]
    },
    {
        // ── Mind Altar ↔ Wilderness ───────────────────────────────────────────
        // Also connected to the new stretch with the Chaos Temple.
        name: 'WildernessWest',
        destInRegion: (x, z, l) => Environment.engine.revision >= 249 && checkRegion(x, z, l, [
            'Wilderness']),
        approach: [[2945, 3520], [2992, 3520]],
        exit: [[2945, 3523], [2992, 3523]]
    },
    {
        // ── White Wolf Mountain ↔ Catherby ────────────────────────────────────
        // West exit from the mountain connecting to Kandarin.
        name: 'Catherby',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'Kandarin',
            'Feldip',
            'Tirannwn',
            'Fremennik']),
        approach: [[2855, 3441]],
        exit: [[2855, 3440]]
    },
    {
        // ── Hemenster ↔ Baxtorian Falls ───────────────────────────────────────
        // South of Fishing Guild, used to path around Lake Hemenster.
        name: 'KandarinNorthWest',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'KandarinNorthWest',
            'Tirannwn']),
        approach: [[2610, 3365], [2610, 3393]],
        exit: [[2609, 3365], [2609, 3393]]
    },
    {
        // ── Baxtorian Falls ↔ Coal Trucks (gate) ──────────────────────────────
        // Gated mining area east of Baxtorian Falls.
        name: 'CoalTrucks',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'CoalTrucks']),
        approach: [[2567, 3457], [2568, 3457]],
        exit: [[2567, 3458], [2568, 3458]]
    },
    {
        // ── Fishing Guild ↔ Baxtorian Falls ───────────────────────────────────
        // Bottom of hill toward Baxtorian Falls.
        name: 'BaxtorianFalls',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'BaxtorianFalls']),
        approach: [[2550, 3470], [2554, 3470]],
        exit: [[2551, 3471], [2554, 3471]]
    },
    {
        // ── Baxtorian Falls ↔ Barbarian Outpost ───────────────────────────────
        // Bridge over river Dougne south of Barbarian Outpost.
        name: 'BarbarianOutpost',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'BarbarianOutpost']),
        approach: [[2525, 3513], [2526, 3513]],
        exit: [[2525, 3514], [2526, 3514]]
    },
    {
        // ── Barbarian Outpost ↔ Agility Course (gate) ─────────────────────────
        // Opening the gate requires completion of Alfred Grimhand's Barcrawl,
        // which the bots should have auto completed.
        name: 'BarbarianAgilityGate',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'BarbarianAgilityGate']),
        approach: [[2545, 3569], [2545, 3570]],
        exit: [[2546, 3569], [2546, 3570]]
    },
    {
        // ── Fishing Guild ↔ Ardougne Castle ───────────────────────────────────
        // Bridge over river Dougne, north of Ardougne Castle.
        name: 'RiverDougneFish',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'KandarinNorthWestRiver',
            'ArdougneRiverWest',
            'KandarinSouth',
            'Feldip',
            'Tirannwn']),
        approach: [[2581, 3363], [2582, 3363]],
        exit: [[2581, 3362], [2582, 3362]]
    },
    {
        // ── Baxtorian Falls ↔ Tree Gnome Stronghold ───────────────────────────
        // Bridge over river Dougne near Tourist Information Centre.
        name: 'RiverDougneTourist',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'KandarinNorthWestRiver',
            'Tirannwn']),
        approach: [[2535, 3400], [2535, 3401]],
        exit: [[2534, 3400], [2534, 3401]]
    },
    {
        // ── Ardougne ↔ Tree Gnome Stronghold (gate) ───────────────────────────
        // Gate to the Tree Gnome Stronghold. Bots should have auto completed to
        // help Femi (var 152) so they can open the gate without dialog.
        name: 'GnomeStronghold',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'GnomeStronghold']),
        approach: [[2460, 3382], [2462, 3382]],
        exit: [[2460, 3385], [2462, 3385]]
    },
    {
        // ── Tree Gnome Stronghold ↔ Gnome Stronghold South Bank (stairs) ──────
        // South stairs.
        // Bots need to interact with the stairs to get inside the bank.
        name: 'GnomeSouthBankS',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'GnomeSouthBank']),
        approach: [[2443, 3413], [2446, 3416]],
        exit: [[2445, 3416]],
        exitLevel: 1
    },
    {
        // ── Tree Gnome Stronghold ↔ Gnome Stronghold South Bank (stairs) ──────
        // North stairs.
        // Bots need to interact with the stairs to get inside the bank.
        name: 'GnomeSouthBankN',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'GnomeSouthBank']),
        approach: [[2444, 3433], [2447, 3436]],
        exit: [[2445, 3433]],
        exitLevel: 1
    },
    {
        // ── Tree Gnome Stronghold ↔ Grand Tree entrance (gate) ────────────────
        // Bots first need to open the gate to get into the Grand Tree.
        name: 'GrandTree',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'GrandTree',
            'GrandTree1']),
        approach: [[2465, 3491], [2466, 3491]],
        exit: [[2465, 3493], [2466, 3493]]
    },
    {
        // ── Grand Tree entrance ↔ Grand Tree 1st floor (stairs) ───────────────
        // Stairs to the 1st floor of the Grand Tree.
        name: 'GrandTree1',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'GrandTree1']),
        approach: [[2465, 3494], [2467, 3496]],
        exit: [[2465, 3494], [2467, 3496]],
        exitLevel: 1
    },
    {
        // ── Grand Tree 1st floor ↔ Grand Tree 2nd floor (stairs) ──────────────
        // Stairs to the 2nd floor of the Grand Tree.
        name: 'GrandTree2',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'GrandTree2']),
        approach: [[2465, 3494], [2467, 3496]],
        exit: [[2465, 3494], [2467, 3496]],
        approachLevel: 1,
        exitLevel: 2
    },
    {
        // ── Grand Tree 2nd floor ↔ Grand Tree 3nd floor (stairs) ──────────────
        // Stairs to the 3nd floor of the Grand Tree.
        name: 'GrandTree3',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'GrandTree3']),
        approach: [[2465, 3494], [2467, 3496]],
        exit: [[2465, 3494], [2467, 3496]],
        approachLevel: 2,
        exitLevel: 3
    },
    {
        // ── Brimhaven ↔ Ardougne (boat) ───────────────────────────────────────
        // Bots heading to Ardougne can take the boat from Karamja.
        // The boat costs 30 coins and triggers a dialog that
        // bots cannot handle natively, so teleport is used instead.
        // port: they take it as players do (SCRIPTED_CROSSINGS); the jump only if that fails
        name: 'BrimhavenBoat',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'Kandarin',
            'Feldip',
            'Tirannwn',
            'Fremennik']),
        approach: [[2772, 3234]],
        exit: [[2683, 3271]],
        teleport: true
    },
    {
        // ── Legends' Guild ↔ Ardougne Docks ───────────────────────────────────
        // Docks entrance to Ardougne.
        name: 'ArdougneDocks',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'Ardougne',
            'KandarinSouth',
            'Feldip']),
        approach: [[2688, 3275], [2688, 3276]],
        exit: [[2687, 3275], [2687, 3276]]
    },
    {
        // ── Legends' Guild ↔ Ardougne Market ──────────────────────────────────
        // East entrance to Ardougne.
        name: 'ArdougneMarket',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'Ardougne',
            'KandarinSouth',
            'Feldip']),
        approach: [[2688, 3304], [2688, 3306]],
        exit: [[2687, 3303], [2687, 3306]]
    },
    {
        // ── Hemenster ↔ Ardougne ──────────────────────────────────────────────
        // Main north entrance to Ardougne.
        name: 'ArdougneNorth',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'Ardougne',
            'KandarinSouth',
            'Feldip']),
        approach: [[2635, 3340], [2637, 3340]],
        exit: [[2635, 3339], [2637, 3339]]
    },
    {
        // ── Fishing Guild ↔ Ardougne ──────────────────────────────────────────
        // Entrance to Ardougne closest to north bank.
        name: 'ArdougneNorthBank',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'Ardougne',
            'KandarinSouth',
            'Feldip']),
        approach: [[2612, 3342], [2613, 3342]],
        exit: [[2612, 3341], [2613, 3341]]
    },
    {
        // ── Fishing Guild ↔ Ardougne ──────────────────────────────────────────
        // Entrance to Ardougne, north of castle.
        name: 'ArdougneNorthCastle',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'ArdougneRiverWest',
            'KandarinSouth',
            'Feldip']),
        approach: [[2587, 3342], [2588, 3342]],
        exit: [[2587, 3341], [2588, 3341]]
    },
    {
        // ── Tree Gnome Stronghold ↔ Ardougne ──────────────────────────────────
        // Small entrance to Ardougne, northwest corner.
        name: 'ArdougneNorthWest',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'ArdougneRiverWest',
            'KandarinSouth',
            'Feldip']),
        approach: [[2559, 3337]],
        exit: [[2559, 3336]]
    },
    {
        // ── Ardougne ↔ Battlefield ────────────────────────────────────────────
        // Southwest exit from Ardougne.
        name: 'ArdougneSouthWest',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'KandarinSouth',
            'Feldip']),
        approach: [[2559, 3264], [2663, 3264]],
        exit: [[2558, 3263], [2662, 3263]]
    },
    {
        // ── Ardougne zoo ↔ Monastery ──────────────────────────────────────────
        // Main south exit from Ardougne.
        name: 'ArdougneZoo',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'KandarinSouth',
            'Feldip']),
        approach: [[2602, 3264], [2603, 3264]],
        exit: [[2602, 3263], [2603, 3263]]
    },
    {
        // ── Ardougne ↔ Monastery ──────────────────────────────────────────────
        // Southeast exit from Ardougne closest to south bank.
        name: 'ArdougneSouthEast',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'KandarinSouth',
            'Feldip']),
        approach: [[2640, 3264], [2641, 3264]],
        exit: [[2639, 3263], [2640, 3263]]
    },
    {
        // ── Ardougne Market ↔ Ardougne Castle ─────────────────────────────────
        // Bridge to Ardougne Castle.
        name: 'ArdougneRiverWest',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'ArdougneRiverWest']),
        approach: [[2599, 3295], [2599, 3297]],
        exit: [[2598, 3295], [2598, 3297]]
    },
    {
        // ── East Ardougne ↔ West Ardougne (gate) ──────────────────────────────
        // Gate to West Ardougne, requires completion of Plague City which
        // the bots should have auto completed.
        name: 'WestArdougne',
        destInRegion: (x, z, l) => checkRegion(x, z, l, [
            'WestArdougne']),
        approach: [[2559, 3299], [2559, 3300]],
        exit: [[2556, 3299], [2556, 3300]]
    }
];

/**
 * Regions used as destination for gateways. Defined separately so they
 * can be used for multiple gateways. For readability, regions are grouped
 * under a bigger region that they are part of. The westernmost coordinate
 * is listed first and then drawn clockwise.
 */
type Region = {
    readonly name: string;
    /** 
     * Each [x, z] tile creates a line to the next tile.
     * A triangle is created with 3 tiles and more tiles can
     * be provided to precisely define a region as a polygon.
     */
    readonly coords: number[][];
    /**
     * If set, this region only applies to this floor and those above it.
     * Otherwise all floors are inside the region.
     */
    readonly level?: number;
    /**
     * If set, names of regions that should also be part of this region
     * but could not be included in `coords`.
     * This applies to dungeons and other separated regions.
     */
    readonly contains?: string[];
};

const REGIONS: Region[] = [
    // ── Kingdom of Misthalin ──────────────────────────────────────────────────
    {
        name: 'Misthalin',
        coords: [
            [3025, 3071],
            [3070, 3273],
            [3070, 3285],
            [3069, 3327],
            [3069, 3453],
            [3066, 3453],
            [3066, 3520],
            [3408, 3520],
            [3408, 3505],
            [3418, 3496],
            [3418, 3484],
            [3423, 3479],
            [3423, 3475],
            [3403, 3451],
            [3394, 3330],
            [3274, 3330],
            [3267, 3323],
            [3267, 3209],
            [3252, 3179],
            [3250, 3140],
            [3197, 3131],
            [3130, 3045]]
    },
    {
        name: 'Lumbridge',
        coords: [
            [3201, 3199],
            [3201, 3237],
            [3238, 3237],
            [3238, 3234],
            [3244, 3227],
            [3244, 3223],
            [3258, 3213],
            [3260, 3197],
            [3256, 3191],
            [3238, 3191],
            [3218, 3199]]
    },
    {
        // port: the house with the spinning wheel in Seers' village, upstairs
        name: 'SeersSpinning1',
        coords: [
            [2707, 3466],
            [2707, 3474],
            [2718, 3474],
            [2718, 3466]],
        level: 1
    },
    {
        // port: the castle's first floor (the spinning wheel), and the floors above
        name: 'LumbridgeCastle1',
        coords: [
            [3200, 3200],
            [3200, 3237],
            [3227, 3237],
            [3227, 3200]],
        level: 1
    },
    {
        // port (the realism work, phase 5a): the Wizards' Guild's first floor (the Magic Guild Store), and the floors above
        name: 'WizardsGuild1',
        coords: [
            [2585, 3081],
            [2585, 3094],
            [2597, 3094],
            [2597, 3081]],
        level: 1
    },
    // ---- (the variety work, round 2, track W2: the guilds' first floors, their shops) ----
    {
        name: 'ChampionsGuild1',
        coords: [
            [3185, 3346],
            [3185, 3364],
            [3198, 3364],
            [3198, 3346]],
        level: 1
    },
    {
        // (the hall behind the door: the tiles a player reaches from the stairs' foot without another door)
        name: 'ChampionsGuild0',
        coords: [
            [3188, 3355],
            [3188, 3362],
            [3194, 3362],
            [3194, 3355]],
        level: 0
    },
    {
        name: 'HeroesGuild1',
        coords: [
            [2887, 3502],
            [2887, 3518],
            [2904, 3518],
            [2904, 3502]],
        level: 1
    },
    // ---- end of track W2's block ----
    {
        name: 'LumbridgeSheep',
        coords: [
            [3193, 3257],
            [3193, 3276],
            [3204, 3276],
            [3210, 3275],
            [3212, 3269],
            [3212, 3257]]
    },
    {
        name: 'MisthalinEast',
        coords: [
            [3102, 3473],
            [3108, 3487],
            [3114, 3493],
            [3124, 3498],
            [3132, 3514],
            [3132, 3520],
            [3408, 3520],
            [3408, 3505],
            [3418, 3496],
            [3418, 3484],
            [3423, 3479],
            [3423, 3475],
            [3403, 3451],
            [3394, 3330],
            [3274, 3330],
            [3267, 3323],
            [3267, 3209],
            [3261, 3197],
            [3259, 3214],
            [3245, 3224],
            [3245, 3228],
            [3239, 3235],
            [3235, 3259],
            [3235, 3267],
            [3220, 3287],
            [3213, 3320],
            [3197, 3341],
            [3179, 3349],
            [3157, 3349],
            [3142, 3388],
            [3118, 3389],
            [3105, 3417],
            [3105, 3424],
            [3113, 3432],
            [3103, 3446]]
    },
    {
        name: 'LumbridgeCow',
        coords: [
            [3242, 3282],
            [3242, 3298],
            [3265, 3298],
            [3265, 3255],
            [3253, 3255],
            [3253, 3271]]
    },
    {
        // port (variety round 1, F): the west cow field's inside, kept within its fence (the fence runs on the diagonal
        // to the north-east; the strip south of the gate is outside)
        // port (the variety work, round 2, the fixes): traced round the 274 map's flood of the field (1,410 tiles, its gate
        // shut): every tile inside, none outside. The first outline stopped at z 3317 and x 3154, and missed the field's
        // south rows (the gate's own inside tiles, 3174-3175,3316) and its south-east lobe: a bot at the gate's inside was
        // "out of the field", walked west along the fence to 3153,3319, was "in" again and turned back to the gate, for good
        // (fixes.test's cow field, from 5c284de's dice on)
        name: 'LumbridgeCowWest',
        coords: [
            [3153, 3345], [3154, 3346], [3160, 3346], [3161, 3345], [3162, 3344], [3179, 3344], [3181, 3343], [3183, 3342],
            [3185, 3341], [3186, 3340], [3187, 3339], [3189, 3338], [3190, 3337], [3192, 3336], [3194, 3335], [3199, 3334],
            [3199, 3333], [3200, 3332], [3200, 3331], [3201, 3330], [3201, 3328], [3202, 3327], [3202, 3323], [3203, 3322],
            [3204, 3321], [3205, 3320], [3206, 3319], [3207, 3318], [3208, 3317], [3209, 3316], [3210, 3315], [3210, 3311],
            [3208, 3310], [3209, 3309], [3211, 3308], [3209, 3308], [3208, 3309], [3202, 3309], [3201, 3308], [3192, 3308],
            [3191, 3309], [3187, 3313], [3180, 3314], [3179, 3315], [3179, 3316], [3171, 3316], [3171, 3315], [3170, 3314],
            [3167, 3314], [3166, 3315], [3161, 3315], [3160, 3314], [3156, 3314], [3155, 3315], [3154, 3316], [3155, 3317],
            [3155, 3318], [3153, 3319], [3153, 3322], [3152, 3323], [3152, 3325], [3153, 3326]]
    },
    {
        name: 'VarrockPalace',
        coords: [
            [3186, 3458],
            [3186, 3461],
            [3188, 3463],
            [3188, 3475],
            [3191, 3478],
            [3191, 3496],
            [3200, 3507],
            [3228, 3507],
            [3234, 3501],
            [3234, 3454],
            [3219, 3439],
            [3208, 3439],
            [3189, 3458]]
    },
    // ── Kharidian Desert ──────────────────────────────────────────────────────
    {
        name: 'Desert',
        coords: [
            [2980, 2794],
            [3198, 3130],
            [3251, 3139],
            [3253, 3178],
            [3268, 3208],
            [3268, 3322],
            [3275, 3329],
            [3394, 3329],
            [3432, 3178],
            [3619, 3077],
            [3377, 2465]]
    },
    {
        name: 'DesertSouth',
        coords: [
            [2980, 2794],
            [3198, 3130],
            [3251, 3139],
            [3296, 3131],
            [3296, 3116],
            [3314, 3116],
            [3314, 3135],
            [3333, 3135],
            [3333, 3158],
            [3354, 3157],
            [3357, 3143],
            [3374, 3133],
            [3380, 3125],
            [3395, 3149],
            [3393, 3165],
            [3409, 3161],
            [3421, 3188],
            [3432, 3178],
            [3619, 3077],
            [3377, 2465]]
    },
    // ── Kingdom of Asgarnia ───────────────────────────────────────────────────
    {
        name: 'Asgarnia',
        coords: [
            [2784, 3326],
            [2800, 3398],
            [2837, 3429],
            [2846, 3428],
            [2859, 3415],
            [2864, 3420],
            [2864, 3436],
            [2857, 3441],
            [2854, 3441],
            [2840, 3449],
            [2843, 3458],
            [2834, 3466],
            [2829, 3491],
            [2815, 3496],
            [2796, 3488],
            [2788, 3502],
            [2802, 3551],
            [2833, 3551],
            [2840, 3577],
            [2879, 3577],
            [2892, 3585],
            [2940, 3583],
            [2940, 3520],
            [2992, 3520],
            [2998, 3526],
            [2998, 3534],
            [3006, 3543],
            [3023, 3543],
            [3040, 3520],
            [3065, 3520],
            [3065, 3452],
            [3068, 3452],
            [3068, 3326],
            [3069, 3284],
            [3069, 3274],
            [3024, 3071],
            [2962, 3114],
            [2963, 3177],
            [2883, 3218],
            [2886, 3324]]
    },
    {
        name: 'Entrana',
        coords: [
            [2784, 3326],
            [2800, 3398],
            [2870, 3396],
            [2886, 3324]]
    },
    {
        name: 'Taverley',
        coords: [
            [2788, 3502],
            [2802, 3551],
            [2833, 3551],
            [2840, 3577],
            [2879, 3577],
            [2892, 3585],
            [2940, 3583],
            [2940, 3520],
            [2929, 3520],
            [2929, 3509],
            [2936, 3509],
            [2936, 3475],
            [2940, 3471],
            [2940, 3454],
            [2935, 3454],
            [2935, 3448],
            [2940, 3448],
            [2944, 3444],
            [2944, 3413],
            [2936, 3387],
            [2936, 3320],
            [2928, 3320],
            [2928, 3328],
            [2911, 3328],
            [2911, 3320],
            [2887, 3324],
            [2871, 3397],
            [2800, 3399],
            [2837, 3429],
            [2846, 3428],
            [2859, 3415],
            [2864, 3420],
            [2864, 3436],
            [2857, 3441],
            [2854, 3441],
            [2840, 3449],
            [2843, 3458],
            [2834, 3466],
            [2829, 3491],
            [2815, 3496],
            [2796, 3488]]
    },
    {
        name: 'WhiteWolf',
        coords: [
            [2788, 3502],
            [2802, 3551],
            [2852, 3528],
            [2868, 3531],
            [2879, 3524],
            [2879, 3497],
            [2871, 3484],
            [2877, 3458],
            [2877, 3442],
            [2862, 3442],
            [2864, 3436],
            [2857, 3441],
            [2854, 3441],
            [2840, 3449],
            [2843, 3458],
            [2834, 3466],
            [2829, 3491],
            [2815, 3496],
            [2796, 3488]]
    },
    {
        name: 'WhiteWolfWest',
        coords: [
            [2788, 3502],
            [2802, 3551],
            [2852, 3528],
            [2852, 3507],
            [2858, 3501],
            [2858, 3492],
            [2852, 3484],
            [2852, 3451],
            [2862, 3442],
            [2864, 3436],
            [2857, 3441],
            [2854, 3441],
            [2840, 3449],
            [2843, 3458],
            [2834, 3466],
            [2829, 3491],
            [2815, 3496],
            [2796, 3488]]
    },
    // ── Karamja ───────────────────────────────────────────────────────────────
    {
        name: 'Karamja',
        coords: [
            [2672, 3205],
            [2709, 3246],
            [2807, 3257],
            [2784, 3325],
            [2885, 3323],
            [2882, 3217],
            [2962, 3176],
            [2961, 3113],
            [3024, 3070],
            [3008, 2857],
            [2729, 2852],
            [2727, 3103]]
    },
    {
        name: 'MusaPoint',
        coords: [
            [2816, 3144],
            [2816, 3217],
            [2882, 3217],
            [2962, 3176],
            [2961, 3113]]
    },
    // ── Wilderness ────────────────────────────────────────────────────────────
    {
        name: 'Wilderness',
        coords: [
            [2941, 3521],
            [2941, 3663],
            [2950, 3678],
            [2941, 3687],
            [2941, 4003],
            [3384, 4001],
            [3700, 3584],
            [3391, 3584],
            [3391, 3534],
            [3408, 3521],
            [3041, 3521],
            [3024, 3544],
            [3005, 3544],
            [2997, 3535],
            [2997, 3527],
            [2991, 3521]]
    },
    // ── Kingdom of Kandarin ───────────────────────────────────────────────────
    {
        name: 'Kandarin',
        coords: [
            [2176, 3636],
            [2331, 3741],
            [2490, 3596],
            [2532, 3596],
            [2567, 3583],
            [2651, 3597],
            [2657, 3597],
            [2662, 3600],
            [2668, 3597],
            [2676, 3599],
            [2681, 3604],
            [2686, 3600],
            [2717, 3594],
            [2728, 3594],
            [2744, 3587],
            [2754, 3590],
            [2801, 3551],
            [2787, 3502],
            [2796, 3487],
            [2816, 3495],
            [2828, 3490],
            [2833, 3465],
            [2842, 3457],
            [2839, 3448],
            [2853, 3440],
            [2856, 3440],
            [2863, 3435],
            [2863, 3421],
            [2858, 3416],
            [2847, 3429],
            [2836, 3430],
            [2799, 3399],
            [2783, 3326],
            [2806, 3257],
            [2708, 3247],
            [2671, 3206],
            [2726, 3102],
            [2680, 3066],
            [2516, 3066],
            [2455, 3060],
            [2455, 3009],
            [2305, 3021],
            [2326, 3078],
            [2365, 3080],
            [2365, 3142],
            [2408, 3335],
            [2346, 3335],
            [2334, 3392],
            [2178, 3392]]
    },
    {
        name: 'KandarinNorth',
        coords: [
            [2176, 3636],
            [2331, 3741],
            [2490, 3596],
            [2532, 3596],
            [2567, 3583],
            [2651, 3597],
            [2657, 3597],
            [2662, 3600],
            [2668, 3597],
            [2676, 3599],
            [2681, 3604],
            [2686, 3600],
            [2717, 3594],
            [2728, 3594],
            [2744, 3587],
            [2754, 3590],
            [2801, 3551],
            [2787, 3502],
            [2796, 3487],
            [2816, 3495],
            [2828, 3490],
            [2833, 3465],
            [2842, 3457],
            [2839, 3448],
            [2853, 3440],
            [2856, 3440],
            [2863, 3435],
            [2863, 3421],
            [2858, 3416],
            [2847, 3429],
            [2836, 3430],
            [2799, 3399],
            [2783, 3326],
            [2806, 3257],
            [2688, 3264],
            [2688, 3328],
            [2681, 3335],
            [2674, 3335],
            [2669, 3340],
            [2617, 3340],
            [2615, 3342],
            [2563, 3342],
            [2559, 3337],
            [2461, 3337],
            [2461, 3325],
            [2433, 3325],
            [2408, 3335],
            [2346, 3335],
            [2334, 3392],
            [2178, 3392]]
    },
    {
        name: 'KandarinNorthWest',
        coords: [
            [2176, 3636],
            [2331, 3741],
            [2490, 3596],
            [2532, 3596],
            [2567, 3583],
            [2599, 3505],
            [2599, 3430],
            [2595, 3425],
            [2578, 3425],
            [2578, 3414],
            [2583, 3414],
            [2593, 3393],
            [2609, 3393],
            [2609, 3351],
            [2593, 3351],
            [2598, 3342],
            [2563, 3342],
            [2559, 3337],
            [2461, 3337],
            [2461, 3325],
            [2433, 3325],
            [2408, 3335],
            [2346, 3335],
            [2334, 3392],
            [2178, 3392]]
    },
    {
        name: 'CoalTrucks',
        coords: [
            [2553, 3479],
            [2553, 3485],
            [2581, 3513],
            [2599, 3505],
            [2599, 3456],
            [2575, 3456],
            [2575, 3459],
            [2571, 3459],
            [2570, 3458],
            [2565, 3458],
            [2565, 3460],
            [2559, 3460],
            [2559, 3462],
            [2555, 3465],
            [2555, 3467],
            [2558, 3472]]
    },
    {
        name: 'BaxtorianFalls',
        coords: [
            [2473, 3532],
            [2491, 3596],
            [2532, 3596],
            [2567, 3583],
            [2581, 3514],
            [2552, 3486],
            [2552, 3478],
            [2557, 3472],
            [2555, 3471],
            [2533, 3471],
            [2496, 3431],
            [2496, 3512]]
    },
    {
        name: 'BarbarianOutpost',
        coords: [
            [2473, 3532],
            [2491, 3596],
            [2532, 3596],
            [2567, 3583],
            [2581, 3514],
            [2520, 3514],
            [2496, 3512]]
    },
    {
        name: 'BarbarianAgilityGate',
        coords: [
            [2528, 3551],
            [2528, 3556],
            [2546, 3556],
            [2546, 3573],
            [2555, 3573],
            [2555, 3561],
            [2553, 3559],
            [2553, 3543],
            [2552, 3542],
            [2529, 3542],
            [2529, 3550]]
    },
    {
        name: 'KandarinNorthWestRiver',
        coords: [
            [2176, 3636],
            [2331, 3741],
            [2490, 3596],
            [2472, 3532],
            [2495, 3511],
            [2495, 3430],
            [2497, 3428],
            [2534, 3408],
            [2534, 3398],
            [2550, 3388],
            [2567, 3370],
            [2572, 3361],
            [2578, 3362],
            [2585, 3362],
            [2593, 3351],
            [2598, 3342],
            [2563, 3342],
            [2559, 3337],
            [2461, 3337],
            [2461, 3325],
            [2433, 3325],
            [2408, 3335],
            [2346, 3335],
            [2334, 3392],
            [2178, 3392]]
    },
    {
        name: 'GnomeStronghold',
        coords: [
            [2369, 3423],
            [2369, 3431],
            [2371, 3433],
            [2371, 3442],
            [2375, 3446],
            [2375, 3457],
            [2381, 3464],
            [2381, 3473],
            [2374, 3486],
            [2374, 3532],
            [2472, 3532],
            [2495, 3511],
            [2495, 3430],
            [2497, 3428],
            [2497, 3418],
            [2493, 3403],
            [2505, 3391],
            [2467, 3391],
            [2465, 3389],
            [2465, 3384],
            [2457, 3384],
            [2457, 3389],
            [2455, 3391],
            [2442, 3391],
            [2438, 3388],
            [2435, 3388],
            [2427, 3393],
            [2421, 3393],
            [2414, 3400],
            [2414, 3408],
            [2410, 3412],
            [2392, 3412],
            [2386, 3407],
            [2380, 3408],
            [2376, 3411],
            [2375, 3417]]
    },
    {
        name: 'GnomeSouthBank',
        coords: [
            [2443, 3415],
            [2443, 3434],
            [2448, 3434],
            [2448, 3415]],
        level: 1
    },
    {
        name: 'GrandTree',
        coords: [
            [2463, 3493],
            [2463, 3498],
            [2468, 3498],
            [2468, 3493]]
    },
    {
        name: 'GrandTree1',
        coords: [
            [2438, 3478],
            [2438, 3520],
            [2500, 3520],
            [2500, 3478]],
        level: 1
    },
    {
        name: 'GrandTree2',
        coords: [
            [2438, 3478],
            [2438, 3520],
            [2500, 3520],
            [2500, 3478]],
        level: 2
    },
    {
        name: 'GrandTree3',
        coords: [
            [2438, 3478],
            [2438, 3520],
            [2500, 3520],
            [2500, 3478]],
        level: 3
    },
    {
        name: 'Ardougne',
        coords: [
            [2433, 3305],
            [2433, 3324],
            [2462, 3324],
            [2462, 3336],
            [2560, 3336],
            [2564, 3341],
            [2614, 3341],
            [2616, 3339],
            [2668, 3339],
            [2673, 3334],
            [2680, 3334],
            [2687, 3327],
            [2687, 3264],
            [2509, 3264],
            [2509, 3279],
            [2459, 3279],
            [2459, 3305]]
    },
    {
        name: 'ArdougneRiverWest',
        coords: [
            [2433, 3305],
            [2433, 3324],
            [2462, 3324],
            [2462, 3336],
            [2560, 3336],
            [2564, 3341],
            [2600, 3341],
            [2600, 3320],
            [2592, 3312],
            [2598, 3302],
            [2598, 3290],
            [2586, 3264],
            [2509, 3264],
            [2509, 3279],
            [2459, 3279],
            [2459, 3305]]
    },
    {
        name: 'WestArdougne',
        coords: [
            [2433, 3305],
            [2433, 3324],
            [2462, 3324],
            [2462, 3336],
            [2558, 3336],
            [2558, 3264],
            [2509, 3264],
            [2509, 3279],
            [2459, 3279],
            [2459, 3305]]
    },
    {
        name: 'KandarinSouth',
        coords: [
            [2305, 3021],
            [2326, 3078],
            [2365, 3080],
            [2365, 3142],
            [2408, 3334],
            [2432, 3324],
            [2432, 3304],
            [2458, 3304],
            [2458, 3278],
            [2508, 3278],
            [2508, 3263],
            [2686, 3263],
            [2805, 3256],
            [2708, 3247],
            [2671, 3206],
            [2726, 3102],
            [2680, 3066],
            [2516, 3066],
            [2455, 3060],
            [2455, 3009]]
    },
    // ── Feldip Hills ──────────────────────────────────────────────────────────
    {
        name: 'Feldip',
        coords: [
            [2456, 3008],
            [2456, 3059],
            [2516, 3065],
            [2680, 3065],
            [2640, 2793],
            [2289, 2798]]
    },
    // ── Morytania ─────────────────────────────────────────────────────────────
    {
        name: 'Morytania',
        coords: [
            [3392, 3535],
            [3392, 3583],
            [3900, 3583],
            [3900, 2800],
            [3619, 2800],
            [3620, 3078],
            [3433, 3179],
            [3395, 3330],
            [3404, 3450],
            [3424, 3474],
            [3424, 3480],
            [3419, 3485],
            [3419, 3497],
            [3409, 3506],
            [3409, 3522]]
    },
    // ── Troll Country ─────────────────────────────────────────────────────────
    {
        name: 'Troll',
        coords: [
            [2750, 3712],
            [2750, 3911],
            [2940, 4003],
            [2940, 3686],
            [2949, 3678],
            [2940, 3664],
            [2940, 3584],
            [2891, 3586],
            [2878, 3578],
            [2839, 3578],
            [2832, 3552],
            [2802, 3552],
            [2802, 3637],
            [2822, 3650],
            [2822, 3712]]
    },
    // ── Tirannwn ──────────────────────────────────────────────────────────────
    {
        name: 'Tirannwn',
        coords: [
            [2038, 3019],
            [2179, 3391],
            [2333, 3391],
            [2345, 3334],
            [2407, 3334],
            [2364, 3143],
            [2364, 3081],
            [2326, 3079],
            [2304, 3021]]
    },
    // ── Fremennik Province ────────────────────────────────────────────────────
    {
        name: 'Fremennik',
        coords: [
            [2052, 3809],
            [2052, 3957],
            [2779, 4145],
            [2749, 3912],
            [2749, 3711],
            [2821, 3711],
            [2821, 3651],
            [2801, 3638],
            [2801, 3552],
            [2754, 3591],
            [2744, 3588],
            [2729, 3595],
            [2718, 3595],
            [2687, 3601],
            [2681, 3605],
            [2675, 3600],
            [2668, 3598],
            [2662, 3601],
            [2656, 3598],
            [2652, 3598],
            [2567, 3584],
            [2533, 3597],
            [2491, 3597],
            [2331, 3742]]
    }
];

/**
 * For each region, check if point (x, z) is inside.
 * Return true if the point is in any of the regions.
 * If the region contains more regions, check if the point is in any of those.
 * But don't further check if those regions contain even more regions,
 * they can be added to the `contains` field of the main region if desired.
 * If the point was not found in any of the regions, return false.
 */
function checkRegion(x: number, z: number, level: number, names: string[]): boolean {
    for (const name of names) {
        const region = _region(name);
        if (!region) continue;
        if (region.level && region.level > level) continue;
        if (_inRegion(region, x, z)) return true;
        if (!region.contains) continue;
        for (const i of region.contains) {
            const contained = _region(i);
            if (!contained) continue;
            if (contained.level && contained.level > level) continue;
            if (_inRegion(contained, x, z)) return true;
        }
    }
    return false;
}

/** port: regions by name, and each polygon's bounding box: walkTo tests some 54 gateways' regions per call */
const REGION_BY_NAME = new Map<string, Region>();
const REGION_BOX = new Map<Region, [number, number, number, number]>();

function _region(name: string): Region | undefined {
    if (REGION_BY_NAME.size === 0) for (const r of REGIONS) REGION_BY_NAME.set(r.name, r);
    return REGION_BY_NAME.get(name);
}

function _inRegion(region: Region, x: number, z: number): boolean {
    let box = REGION_BOX.get(region);
    if (!box) {
        const xs = region.coords.map(c => c[0]);
        const zs = region.coords.map(c => c[1]);
        REGION_BOX.set(region, (box = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)]));
    }
    if (x < box[0] || z < box[1] || x > box[2] || z > box[3]) return false;
    return isInside(region.coords, x, z);
}

/**
 * Given a point (x, z) and a polygon represented by its vertices,
 * determine whether the point lies inside the polygon.
 * The polygon is represented by an array arr[][],
 * where arr[i] = [xi, zi] denotes the coordinates of the i-th vertex.
 * Return true if the point lies inside the polygon; otherwise, return false.
 * Note: A point lying on the boundary (edge or vertex) of the polygon
 * is also considered inside the polygon.
 */
function isInside(arr: number[][], x: number, z: number): boolean {
    const n = arr.length;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const [x1, z1] = arr[i];
        const [x2, z2] = arr[j];

        // Point lies on the current edge
        if (onSegment(x1, z1, x2, z2, x, z)) return true;

        // Check whether the horizontal ray from (x, z)
        // intersects the current edge
        const intersect =
            ((z1 > z) !== (z2 > z)) &&
            (x < (x2 - x1) * (z - z1) / (z2 - z1) + x1);

        if (intersect) inside = !inside;
    }
    return inside;
}

function onSegment(x1: number, z1: number, x2: number, z2: number, x: number, z: number): boolean {
    const c = (x - x1) * (z2 - z1) - (z - z1) * (x2 - x1);
    if (c !== 0) return false;

    return Math.min(x1, x2) <= x && x <= Math.max(x1, x2) &&
        Math.min(z1, z2) <= z && z <= Math.max(z1, z2);
}

/**
 * Raw pathfinding toward a single tile: accurate → relaxed → swept-angle → naive.
 * Does NOT do gateway or corridor pre-routing.  Call walkTo() for normal movement.
 *
 * Long-distance fallback strategy (dist > 100):
 *   1. Try the direct 90-tile midpoint (existing behaviour).
 *   2. If that fails, sweep ±20 °, ±40 °, ±60 ° around the direct heading at
 *      the same 90-tile distance.  A modest angle offset finds a reachable tile
 *      around a large building without straying far off course.
 *   3. If still failing, repeat the sweep at shorter (60-tile) segments.
 *
 * Final compass fallback (all midpoints failed):
 *   Try 8 compass directions at step sizes 50 → 25 → 15 tiles.
 *   Larger steps are necessary to actually clear a wide obstacle like a castle.
 *
 * port (rev 274):
 *   - The path search covers 128×128 tiles around the bot, so a target more than 63 tiles away can never be found:
 *     upstream's direct attempt beyond that and every 90-tile midpoint always failed. Segments are at most
 *     MAX_SEGMENT tiles (the two sweeps: 60 and 40 tiles).
 *   - One search per attempt: upstream followed every empty botWalkPath with botFindPath, the same search with the
 *     stricter acceptance (moveNear off), which cannot succeed when the first did not.
 *   - The attempts share the tick's path search budget (port/BotPathing) with every other bot. When that runs out the bot keeps its place
 *     in the list and carries on next tick (a sweep could cost 76 searches in one tick).
 *   - No CSV trim: an rsmod path never crosses a blocked tile (and the trim's order assumption is reversed in 274,
 *     where path[0] is the first step).
 */
const MAX_SEGMENT = 60;

type PathAttempt = { kind: 'path'; x: number; z: number } | { kind: 'gate' };

/** Where a bot stopped in its list of attempts, while it stays on the same tile with the same destination. */
const pathProgress = new WeakMap<Player, { key: string; next: number }>();

/**
 * port: a destination every attempt failed for, and until when the bot only steps toward it: upstream forgot a failed
 * sweep, and the step it took changed its tile, so the next tick ran the whole sweep again (26 to 38 searches a tick for
 * a stranded bot; a quarter of all searches found nothing)
 */
const failedSweeps = new WeakMap<Player, { x: number; z: number; until: number }>();
const FAILED_SWEEP_TICKS = 50;

/**
 * port: the last search of each tick's budget is kept for a bot that has had none for this long. A bot that walks now
 * and then (a social bot's stroll at its hub, a PKer's step along the ditch) asks once and only again 20-60 ticks
 * later: when every ask fell on a tick whose budget was gone, it stood on one tile for 300+ ticks (the aged world).
 * The budget itself holds: the others share one search less.
 */
const STARVED_SEARCH_TICKS = 20;
const lastSearch = new WeakMap<Player, number>();

/**
 * port (the variety work, round 1, track F: the login fill's jumps, ISS-1): the last tick each bot's walk stood still
 * because the tick's path searches were spent (its place kept for the next tick: _pathTowards, the walking graph's
 * start). The stuck checks leave those ticks out (BotTaskBase StuckDetector, ProgressWatchdog): at a login fill every bot
 * needs its first searches at once, far bots waited tens of ticks for theirs, and a wait read as "frozen" jumped 30-68
 * of 100 bots (191 of 500) out of sight in the first minutes of every session.
 */
const budgetWaits = new WeakMap<Player, number>();
/** port (variety round 1, F): the walks that waited for the budget, and the bot-ticks of it (tests, the report) */
export const budgetWaitStats = { waits: 0 };

function _waitedForBudget(player: Player): void {
    if (budgetWaits.get(player) !== World.currentTick) budgetWaitStats.waits++;
    budgetWaits.set(player, World.currentTick);
}

/** port (variety round 1, F): did the bot's walk stand still for the path budget at a tick `since` or later? */
export function waitedForBudgetSince(player: Player, since: number): boolean {
    return (budgetWaits.get(player) ?? -Infinity) >= since;
}

function _pathAttempts(player: Player, destX: number, destZ: number, dist: number, baseAngle: number): PathAttempt[] {
    const attempts: PathAttempt[] = [];
    const towards = (deg: number, step: number): void => {
        const angle = baseAngle + (deg * Math.PI) / 180;
        const x = Math.round(player.x + Math.cos(angle) * step);
        const z = Math.round(player.z + Math.sin(angle) * step);
        if (!BotCollisionMap.isCsvBlocked(player.level, x, z)) attempts.push({ kind: 'path', x, z });
    };
    if (dist <= 100) {
        // Short hop — try direct path first (a midpoint on the way when it is out of reach)
        if (dist <= MAX_SEGMENT) attempts.push({ kind: 'path', x: destX, z: destZ });
        else towards(0, MAX_SEGMENT);
        // Path is completely blocked — a door or gate is likely in the way.
        attempts.push({ kind: 'gate' });
    } else {
        // Long distance — try midpoints at the direct heading then sweep outward
        // so the pathfinder can find a clear intermediate tile around any obstacle
        for (const deg of [0, 20, -20, 40, -40, 60, -60]) towards(deg, Math.min(MAX_SEGMENT, dist - 1));
        // Retry with shorter segments in case the first target is unreachable
        for (const deg of [0, 20, -20, 40, -40, 60, -60]) towards(deg, 40);
    }
    // All directed midpoints failed — sweep 8 compass directions at increasing
    // step sizes so the bot can escape wide obstacles, not just doorway-width ones
    for (const step of [50, 25, 15]) {
        for (const deg of [0, 45, -45, 90, -90, 135, -135, 180]) towards(deg, step);
    }
    return attempts;
}

// ── The walking graph (port) ──────────────────────────────────────────────────

/** port: a walk at least this far (tiles) follows the walking graph (port/BotWalkGraph) */
const GRAPH_MIN = 40;
/** port: the bot heads for the route's node this many ahead of the one it is at, if within GRAPH_REACH tiles */
const GRAPH_AHEAD = 2;
/** port: a route the bot has not stepped along for this long is dropped (_blockedOnRoute) */
const BLOCKED_ROUTE_TICKS = 5;
/** port: and for this long its legs go one node ahead, closer to the graph's own walks */
const SHORT_LEGS_TICKS = 100;
const routeSteps = new WeakMap<Player, { x: number; z: number; since: number; shortUntil: number }>();

/** port: has the bot, with a route queued, not moved for BLOCKED_ROUTE_TICKS? (then short legs for a while) */
function _blockedOnRoute(player: Player): boolean {
    const now = World.currentTick;
    const st = routeSteps.get(player);
    if (!st || st.x !== player.x || st.z !== player.z) {
        routeSteps.set(player, { x: player.x, z: player.z, since: now, shortUntil: st?.shortUntil ?? 0 });
        return false;
    }
    if (now - st.since < BLOCKED_ROUTE_TICKS || player.delayed) return false;
    st.since = now;
    st.shortUntil = now + SHORT_LEGS_TICKS;
    return true;
}
const GRAPH_REACH = 48;
/** port: a bot this far from its place on the route (a fight, a detour) plans the route again */
const GRAPH_OFF_ROUTE = 40;

/** port: a graph walk under way: its goal node, the world's key, the route, the bot's place on it (and, phase 5a, a wrong turn) */
type GraphWalk = { goal: number; key: string; nodes: number[]; at: number; turn?: WrongTurn | null };
const graphWalks = new WeakMap<Player, GraphWalk>();
/** port: the graph node the bot can walk to from where it was (checked by a search), kept while it stays near there */
const graphStarts = new WeakMap<Player, { x: number; z: number; key: string; node: number; alts: number[] }>();
/** port: the near nodes searched so far from where the bot stands (reachable or not): a search the tick's budget cut short resumes */
const graphReach = new WeakMap<Player, { x: number; z: number; key: string; reach: Map<number, boolean> }>();
/** port: the start node is checked again once the bot is this far from where it was checked */
const GRAPH_START_MOVE = 8;

/** port: the route's limits on this world: a free world keeps to free areas */
function _graphAllowed(): { allowed: ((x: number, z: number) => boolean) | undefined; key: string } {
    return isMembersWorld() ? { allowed: undefined, key: '' } : { allowed: isAllowedCoord, key: 'f2p' };
}

/**
 * port: the node the bot walks onto the graph from: of the nodes near it, the nearest one a search reaches (the
 * nearest by distance can be across a river or a fence: another region). -1 when none (in a building with its door
 * shut, upstairs, underground); 'wait' when the tick's searches are spent.
 */
function _graphStart(player: Player): number | 'wait' {
    if (player.level !== 0) return -1;
    const { allowed, key } = _graphAllowed();
    const known = graphStarts.get(player);
    if (known && known.key === key && Math.max(Math.abs(known.x - player.x), Math.abs(known.z - player.z)) <= GRAPH_START_MOVE) return known.node;
    const near = nearestNodes(player.x, player.z, 4, allowed);
    let node = -1;
    for (let n = 0; n < near.length; n++) {
        const ok = _nodeReachable(player, near[n], key);
        if (ok === 'wait') return 'wait';
        if (!ok) continue;
        node = near[n];
        // port: the nearer ones after it, searched only if the graph does not route from it (_graphPlan): through a
        // gate left open the nearest node can be another region's
        graphStarts.set(player, { x: player.x, z: player.z, key, node, alts: near.slice(n + 1) });
        return node;
    }
    graphStarts.set(player, { x: player.x, z: player.z, key, node, alts: [] });
    return node;
}

/** port: whether the bot walks to graph node `i` from where it stands (a path search, kept while it stands there) */
function _nodeReachable(player: Player, i: number, key: string): boolean | 'wait' {
    const [nx, nz] = nodePos(i);
    if (Math.max(Math.abs(nx - player.x), Math.abs(nz - player.z)) <= 1) return true;
    let known = graphReach.get(player);
    if (!known || known.key !== key || known.x !== player.x || known.z !== player.z) graphReach.set(player, (known = { x: player.x, z: player.z, key, reach: new Map() }));
    const hit = known.reach.get(i);
    if (hit !== undefined) return hit;
    if (pathBudgetLeft(player) === 0) return 'wait'; // port (the realism work, phase 3): a far bot's share (level of detail L1)
    const path = botFindPath(0, player.x, player.z, nx, nz);
    const last = path[path.length - 1];
    const ok = path.length > 0 && ((last >> 14) & 0x3fff) === nx && (last & 0x3fff) === nz;
    known.reach.set(i, ok);
    return ok;
}

/**
 * port: the walking graph's component of the overworld area (x, z) is in: a tile walk from it (doors as they are, never
 * onto `avoid`: a gateway's other side) to the nearest graph node. -1 off the overworld, or with no node within reach.
 * Kept per tile (gateway ends and destinations repeat).
 */
const sideComps = new Map<string, number>();
const SIDE_TILES = 4000;
function _tilesOf(area: number[][]): number[][] {
    if (area.length < 2) return area.map(a => [a[0], a[1]]);
    const out: number[][] = [];
    for (let x = Math.min(area[0][0], area[1][0]); x <= Math.max(area[0][0], area[1][0]); x++) for (let z = Math.min(area[0][1], area[1][1]); z <= Math.max(area[0][1], area[1][1]); z++) out.push([x, z]);
    return out;
}
function _sideComp(x: number, z: number, level: number, avoid?: number[][]): number {
    x = Math.round(x);
    z = Math.round(z);
    if (level !== 0 || z >= 6400) return -1;
    const key = `${x},${z}${avoid ? '|' + avoid.map(a => a.join(',')).join(';') : ''}`;
    const hit = sideComps.get(key);
    if (hit !== undefined) return hit;
    const avoidSet = new Set((avoid ? _tilesOf(avoid) : []).map(([ax, az]) => ax * 16384 + az));
    const seen = new Set<number>([x * 16384 + z]);
    const q: number[] = [x, z];
    let comp = -1;
    for (let i = 0; i < q.length && seen.size < SIDE_TILES; i += 2) {
        const cx = q[i];
        const cz = q[i + 1];
        const n = nodeAt(cx, cz);
        if (n >= 0) {
            comp = componentOf(n);
            break;
        }
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const k = (cx + dx) * 16384 + cz + dz;
            if (seen.has(k) || avoidSet.has(k) || !canTravel(0, cx, cz, dx, dz, 1, 0, CollisionType.NORMAL)) continue;
            seen.add(k);
            q.push(cx + dx, cz + dz);
        }
    }
    sideComps.set(key, comp);
    if (sideComps.size > 4096) sideComps.delete(sideComps.keys().next().value!);
    return comp;
}

/** port: whether the walk from a graph node to a destination tile (or next to it) is open: checked once each, kept */
const graphLastLegs = new Map<string, boolean>();
const GRAPH_LAST_LEGS = 2048;
/** port: a graph route longer than this times the straight distance (plus GRAPH_DETOUR_TILES) is a detour round a gateway */
const GRAPH_DETOUR = 2;
const GRAPH_DETOUR_TILES = 60;

/**
 * port: the walking graph's route from the bot to (destX, destZ), when the walk can follow it: both on the overworld,
 * the graph routes from the node the bot can walk to (_graphStart) to the node nearest the destination (or, its last
 * leg closed, another near it on the bot's side: _graphGoals), with the node it ends at; the route is
 * no long detour (the graph has no edge through the toll gate: from Lumbridge it reaches Al Kharid by its north road,
 * round Varrock), and the destination is open from that last node (a search, once per destination: one behind a
 * fence, the sheep pen's, or a gateway's approach with the nearest node across the river, is not). Null when not;
 * 'wait' when the tick's searches are spent.
 */
function _graphPlan(player: Player, destX: number, destZ: number): { nodes: number[]; goal: number } | null | 'wait' {
    if (player.level !== 0) return null;
    const { allowed, key } = _graphAllowed();
    const goals = _graphGoals(destX, destZ, allowed);
    if (goals.length === 0) return null;
    const start = _graphStart(player);
    if (start === 'wait') return 'wait';
    if (start < 0) return null;
    // port (the variety work, round 1, track F): the nearest node first; when it is in another of the graph's components
    // than the bot (a node inside a fenced field for its gate's approach outside: Lumbridge's west cow field), the next
    // nearest of the bot's. (Not when the nearest is of the bot's own: a closed last leg there is a destination behind a
    // wall or a gate, walked as before; tried on every walk, the A/B runs had a third of the duels)
    const elsewhere = componentOf(goals[0]) !== componentOf(start);
    for (let g = 0; g < goals.length; g++) {
        const goal = goals[g];
        if (g > 0 && (!elsewhere || componentOf(goal) !== componentOf(start))) continue;
        let from = start;
        let nodes = graphRoute(start, goal, allowed, key);
        // port: the nearest reachable node may be across a gate the bot just came through: another reachable one, of the
        // goal's region
        if (!nodes) {
            for (const alt of graphStarts.get(player)?.alts ?? []) {
                if (componentOf(alt) !== componentOf(goal)) continue;
                const ok = _nodeReachable(player, alt, key);
                if (ok === 'wait') return 'wait';
                if (!ok) continue;
                nodes = graphRoute(alt, goal, allowed, key);
                if (nodes) {
                    from = alt;
                    break;
                }
            }
        }
        if (!nodes) continue;
        const [sx, sz] = nodePos(from);
        if (graphRouteCost(nodes) > GRAPH_DETOUR * Math.max(Math.abs(destX - sx), Math.abs(destZ - sz)) + GRAPH_DETOUR_TILES) continue;
        const open = _graphLegOpen(goal, destX, destZ);
        if (open === 'wait') return 'wait';
        if (open) return { nodes, goal };
    }
    return null;
}

/**
 * port (the variety work, round 1, track F): the nodes a graph walk to (destX, destZ) may end at, nearest first: the
 * nearest, and GRAPH_GOAL_MORE more within GRAPH_GOAL_TILES of it (_graphPlan takes another only when the nearest's last
 * leg is closed)
 */
const GRAPH_GOAL_MORE = 3;
const GRAPH_GOAL_TILES = 24;
function _graphGoals(destX: number, destZ: number, allowed: ((x: number, z: number) => boolean) | undefined): number[] {
    return nearestNodes(destX, destZ, 1 + GRAPH_GOAL_MORE, allowed).filter((n, i) => {
        if (i === 0) return true;
        const [x, z] = nodePos(n);
        return Math.max(Math.abs(x - destX), Math.abs(z - destZ)) <= GRAPH_GOAL_TILES;
    });
}

/** port: is the walk from graph node `goal` to (destX, destZ) open (a search, once per pair: graphLastLegs)? 'wait': no search left this tick */
function _graphLegOpen(goal: number, destX: number, destZ: number): boolean | 'wait' {
    const leg = `${goal}>${destX},${destZ}`;
    let open = graphLastLegs.get(leg);
    if (open === undefined) {
        const [gx, gz] = nodePos(goal);
        if (Math.max(Math.abs(gx - destX), Math.abs(gz - destZ)) <= 1) open = true;
        else {
            if (pathBudgetLeft({ x: gx, z: gz, level: 0 }) === 0) return 'wait'; // (counted where it starts: L1)
            const path = botWalkPath(0, gx, gz, destX, destZ);
            const last = path.length > 0 ? path[path.length - 1] : -1;
            open = last !== -1 && Math.max(Math.abs(((last >> 14) & 0x3fff) - destX), Math.abs((last & 0x3fff) - destZ)) <= 1;
        }
        graphLastLegs.set(leg, open);
        if (graphLastLegs.size > GRAPH_LAST_LEGS) graphLastLegs.delete(graphLastLegs.keys().next().value!);
    }
    return open;
}

/** port: a destination the graph does not join the bot to, and until when that answer holds (no plan every call) */
const graphNo = new WeakMap<Player, { goal: number; x: number; z: number; until: number }>();
const GRAPH_NO_TICKS = 50;

/**
 * port: the bot's graph walk to (destX, destZ): the one under way while it heads for the same node and the bot is on
 * the route, else a new plan (_graphPlan). Null when the graph does not join them; 'wait' when the tick's searches are
 * spent.
 */
function _graphWalk(player: Player, destX: number, destZ: number): GraphWalk | null | 'wait' {
    if (player.level !== 0) return null;
    const { allowed, key } = _graphAllowed();
    const goals = _graphGoals(destX, destZ, allowed);
    if (goals.length === 0) return null;
    const goal = goals[0];
    const walk = graphWalks.get(player);
    // (a walk to another of the destination's goal nodes: _graphPlan's pick when the nearest's leg is closed)
    if (walk && goals.includes(walk.goal) && walk.key === key) {
        const [ax, az] = nodePos(walk.nodes[walk.at]);
        if (Math.max(Math.abs(ax - player.x), Math.abs(az - player.z)) <= GRAPH_OFF_ROUTE) return walk;
    }
    const no = graphNo.get(player);
    if (no && no.goal === goal && World.currentTick < no.until && Math.max(Math.abs(no.x - player.x), Math.abs(no.z - player.z)) <= GRAPH_START_MOVE) return null;
    const plan = _graphPlan(player, destX, destZ);
    if (plan === 'wait') return 'wait';
    if (!plan || plan.nodes.length < 2) {
        graphWalks.delete(player);
        graphNo.set(player, { goal, x: player.x, z: player.z, until: World.currentTick + GRAPH_NO_TICKS });
        return null;
    }
    const fresh: GraphWalk = { goal: plan.goal, key, nodes: plan.nodes, at: 0 };
    graphWalks.set(player, fresh);
    _noteGraphWalk(player, fresh);
    return fresh;
}

/** port: does the walking graph join the bot and (destX, destZ) (_graphWalk)? Then the walk needs no gateway. */
function _graphJoins(player: Player, destX: number, destZ: number): 'yes' | 'no' | 'wait' {
    const walk = _graphWalk(player, destX, destZ);
    return walk === 'wait' ? 'wait' : walk ? 'yes' : 'no';
}

/**
 * port: where a long walk heads now: a node of the walking graph ahead on the route to (destX, destZ). Null for a
 * short walk, off the overworld (upstairs, underground), when the bot is near the end (it walks straight there), or
 * when the graph does not join the bot and the destination (a gateway lies between: walkTo crosses it first, and its
 * approach is in the bot's region). A free world's route keeps to free areas.
 */
function _graphTarget(player: Player, destX: number, destZ: number): [number, number] | null {
    if (player.level !== 0 || Math.max(Math.abs(destX - player.x), Math.abs(destZ - player.z)) < GRAPH_MIN) return null;
    const walk = _graphWalk(player, destX, destZ);
    if (!walk || walk === 'wait') return null;
    // port (the realism work, phase 5a): a wrong turn under way (out to the wrong node, a look round, back to the route)
    const detour = _wrongTurnTarget(player, walk);
    if (detour) return detour;
    // where the bot is on the route: the nearest of the next few nodes (it may cut past one)
    let best = Infinity;
    for (let i = walk.at; i < Math.min(walk.nodes.length, walk.at + 5); i++) {
        const [x, z] = nodePos(walk.nodes[i]);
        const d = Math.max(Math.abs(x - player.x), Math.abs(z - player.z));
        if (d <= best) {
            best = d;
            walk.at = i;
        }
    }
    const last = walk.nodes.length - 1;
    // port (phase 5a): at the junction where its wrong turn is due, it takes it
    const turn = _takeWrongTurn(player, walk);
    if (turn) return turn;
    // near the end: straight to the destination (the last node is the one nearest it, within two cells)
    if (walk.at >= last - 1 && Math.max(Math.abs(destX - player.x), Math.abs(destZ - player.z)) <= MAX_SEGMENT) return null;
    const shortLegs = (routeSteps.get(player)?.shortUntil ?? 0) > World.currentTick;
    for (let ahead = shortLegs ? 1 : GRAPH_AHEAD; ahead >= 1; ahead--) {
        const [x, z] = nodePos(walk.nodes[Math.min(last, walk.at + ahead)]);
        if (ahead === 1 || Math.max(Math.abs(x - player.x), Math.abs(z - player.z)) <= GRAPH_REACH) return [x, z];
    }
    return null;
}

// ── Wrong turns (port: the realism work, phase 5a, Track M; "fallible bots") ──────────────────────────
//
// People lost their way on long walks. A graph walk of WRONG_TURN_MIN+ tiles of route takes one wrong turn with
// WRONG_TURN × the persona's carelessness ÷ its median (port/BotPersona: most careful, a few careless), rolled once per
// walk: at a junction of the route (a node with 3+ neighbours, not within 2 nodes of the end) it heads for a neighbour
// off the route (never into the Wilderness, onto a node whose monsters hunt it, or a members area on a free world; the
// graph has no edge through a gate, a boat or stairs), stops there (or after WRONG_OUT_TICKS), looks round 2-6 ticks
// (now and then a 'lost' line: "oops wrong way"), and walks back to the junction and on. Never on an errand (a
// sub-task: "come here", a follow, a random event), in a trade, a social bot's lead, or in the Wilderness. The stuck
// checks wait meanwhile (isCrossing). Counted for the humanlike report's F2 (wrongTurnStats).

/** a walk this long (tiles of graph route) may take a wrong turn */
export const WRONG_TURN_MIN = 80;
/** the chance a walk takes one, at the median carelessness (0.25: port/BotPersona) */
export const WRONG_TURN = 0.06;
const CARELESS_MEDIAN = 0.25;
/** the detour out: given up after this long; the look round; the walk back: given up after this long */
const WRONG_OUT_TICKS = 25;
const WRONG_PAUSE: [number, number] = [2, 6];
const WRONG_BACK_TICKS = 40;
/** a fresh plan to the same goal within this long is the same walk (a route re-planned after a fight, a blocked step) */
const SAME_WALK_TICKS = 200;

interface WrongTurn {
    /** the route's index of the junction, the junction itself, and the wrong node off it */
    at: number;
    junction: number;
    node: number;
    state: 'pending' | 'out' | 'pause' | 'back' | 'done';
    since: number;
    until: number;
}

/** port (phase 5a): wrong turns so far (the humanlike report's F2): walks of WRONG_TURN_MIN+ that could take one, turns
 * taken, back on the route */
export const wrongTurnStats = { walks: 0, turns: 0, back: 0, rolled: 0, noJunction: 0, cut: 0, dropped: 0 };

/** per bot: its graph walks of late, each with its wrong turn (a re-planned route keeps it; a few, as BotTeleport's trips) */
type WrongWalk = { goal: number; tick: number; turn: WrongTurn | null };
const wrongWalks = new WeakMap<Player, WrongWalk[]>();
const WRONG_WALKS_KEPT = 4;
/** a wrong turn's junction lies in this first share of the route (reached before the walk's end or a re-plan) */
const WRONG_TURN_SPAN = 0.6;

/** Tests only (test/teleport.test.mjs): wrong turns this many times as often. Never set by the game. */
let wrongTurnRate = 1;
export function setWrongTurnRateForTest(rate: number): void {
    wrongTurnRate = rate;
}

/**
 * a walk that may go wrong: not on an errand or in a trade, not a social bot's lead, not leading a friend of its clique
 * (port/BotTeleport.leadsAFriend: the follower lost it on the detour), out of the Wilderness
 */
function _mayGoWrong(player: Player): boolean {
    if (player.botTradeTargetPid !== -1 || player.botComeHereReturnX !== -1) return false;
    const ai = (player as unknown as { _bot?: { hasSubTask?: () => boolean; currentTask?: { name?: string } | null } })._bot;
    if (!ai || ai.hasSubTask?.()) return false;
    const kind = (ai.currentTask?.name ?? '').split(':')[0];
    if (kind === 'Social' || kind === 'ComeHere') return false;
    return wildernessLevelAt(player.x, player.z) === 0 && !travelPaused(player) && !leadsAFriend(player);
}

/**
 * A junction of the route for a wrong turn (not the start, not within 2 nodes of the end; in its first WRONG_TURN_SPAN
 * where it has one) with a neighbour off the route the bot may take; null when none.
 */
function _pickJunction(player: Player, nodes: number[], now: number): WrongTurn | null {
    const { allowed } = _graphAllowed();
    const junctions: [number, number[]][] = [];
    for (let i = 1; i <= nodes.length - 3; i++) {
        const near = graphNeighbours(nodes[i]);
        if (near.length < 3) continue;
        const off = near
            .map(([n]) => n)
            .filter(n => {
                if (n === nodes[i - 1] || n === nodes[i + 1]) return false;
                const [x, z] = nodePos(n);
                return (!allowed || allowed(x, z)) && wildernessLevelAt(x, z) === 0 && !huntsMe(player, dangerOfNode(n));
            });
        if (off.length) junctions.push([i, off]);
    }
    if (!junctions.length) return null;
    const early = junctions.filter(([i]) => i <= Math.max(1, Math.floor(nodes.length * WRONG_TURN_SPAN)));
    const pool = early.length ? early : junctions;
    const [at, off] = pool[Math.floor(Math.random() * pool.length)];
    return { at, junction: nodes[at], node: off[Math.floor(Math.random() * off.length)], state: 'pending', since: now, until: 0 };
}

/** a new graph walk (_graphWalk's fresh plan): counted, and its wrong turn rolled (a re-plan keeps the walk's) */
function _noteGraphWalk(player: Player, walk: GraphWalk): void {
    const now = World.currentTick;
    const list = (wrongWalks.get(player) ?? []).filter(r => now - r.tick <= SAME_WALK_TICKS);
    wrongWalks.set(player, list);
    const rec = list.find(r => r.goal === walk.goal);
    if (rec) {
        rec.tick = now;
        // (the same junction if the new route still passes it and the wrong node is still off it, else another on it;
        // one under way ends: the bot follows its new route)
        const turn = rec.turn;
        if (turn && turn.state === 'pending') {
            const at = walk.nodes.indexOf(turn.junction);
            if (at >= 1 && at <= walk.nodes.length - 3 && walk.nodes[at - 1] !== turn.node && walk.nodes[at + 1] !== turn.node) {
                turn.at = at;
                walk.turn = turn;
            } else {
                const again = _pickJunction(player, walk.nodes, now);
                if (again) walk.turn = rec.turn = again;
                else {
                    wrongTurnStats.dropped++;
                    turn.state = 'done';
                }
            }
        } else if (turn && turn.state !== 'done') turn.state = 'done';
        return;
    }
    const fresh: WrongWalk = { goal: walk.goal, tick: now, turn: null };
    list.push(fresh);
    if (list.length > WRONG_WALKS_KEPT) list.shift();
    if (graphRouteCost(walk.nodes) < WRONG_TURN_MIN || !_mayGoWrong(player)) return;
    wrongTurnStats.walks++;
    const care = personaOf(player.username, (player.botPlanner as PlannerKey) ?? null).carelessness;
    if (Math.random() >= WRONG_TURN * (care / CARELESS_MEDIAN) * wrongTurnRate) return;
    wrongTurnStats.rolled++;
    const turn = _pickJunction(player, walk.nodes, now);
    if (!turn) {
        wrongTurnStats.noJunction++;
        return;
    }
    fresh.turn = turn;
    walk.turn = turn;
}

/** at its wrong turn's junction (or just past it): out to the wrong node; else null */
function _takeWrongTurn(player: Player, walk: GraphWalk): [number, number] | null {
    const turn = walk.turn;
    if (!turn || turn.state !== 'pending' || walk.at < turn.at) return null;
    // (cut well past it, or an errand now: no wrong turn this walk)
    if (walk.at > turn.at + 1 || !_mayGoWrong(player)) {
        wrongTurnStats.cut++;
        turn.state = 'done';
        return null;
    }
    turn.state = 'out';
    turn.since = World.currentTick;
    wrongTurnStats.turns++;
    return nodePos(turn.node);
}

/** the wrong turn under way: where it heads (its own tile while it looks round), or null when none (or it is back) */
function _wrongTurnTarget(player: Player, walk: GraphWalk): [number, number] | null {
    const turn = walk.turn;
    if (!turn || turn.state === 'pending' || turn.state === 'done') return null;
    const now = World.currentTick;
    const rec = wrongWalks.get(player)?.find(r => r.goal === walk.goal);
    if (rec) rec.tick = now;
    if (turn.state === 'out') {
        const [x, z] = nodePos(turn.node);
        if (Math.max(Math.abs(x - player.x), Math.abs(z - player.z)) > 2 && now - turn.since <= WRONG_OUT_TICKS) return [x, z];
        turn.state = 'pause';
        turn.since = now;
        turn.until = now + WRONG_PAUSE[0] + Math.floor(Math.random() * (WRONG_PAUSE[1] - WRONG_PAUSE[0] + 1));
        player.clearWaypoints();
        noteWrongTurn(player);
    }
    if (turn.state === 'pause') {
        if (now < turn.until) return [player.x, player.z];
        turn.state = 'back';
        turn.since = now;
    }
    // back to the junction, then on along the route
    const [jx, jz] = nodePos(walk.nodes[turn.at]);
    if (Math.max(Math.abs(jx - player.x), Math.abs(jz - player.z)) > 2 && now - turn.since <= WRONG_BACK_TICKS) return [jx, jz];
    turn.state = 'done';
    walk.at = turn.at;
    wrongTurnStats.back++;
    return null;
}

/** a wrong turn's detour under way (the stuck checks wait for it: isCrossing) */
function _detouring(player: Player): boolean {
    const turn = graphWalks.get(player)?.turn;
    return !!turn && (turn.state === 'out' || turn.state === 'pause' || turn.state === 'back') && World.currentTick - turn.since <= WRONG_BACK_TICKS + 10;
}

/**
 * port: the leg the bot walks now (the point walkTo walks it to: the destination, or a gateway's approach or exit) and
 * how far it has left on it (along the walking graph's route where it follows one), for walkTo's destination: the
 * stuck checks measure progress by it (a route over White Wolf Mountain or round a wall leads away from the
 * destination for a while)
 */
const walkFinals = new WeakMap<Player, { x: number; z: number; tick: number }>();
const walkLegs = new WeakMap<Player, { key: string; x: number; z: number; level: number; left: number; tick: number }>();
const LEG_FRESH_TICKS = 200;
export function walkLeft(player: Player, destX: number, destZ: number, near = 3): { key: string; left: number } | null {
    const f = walkFinals.get(player);
    const leg = walkLegs.get(player);
    if (!f || !leg || World.currentTick - leg.tick > LEG_FRESH_TICKS || Math.max(Math.abs(f.x - destX), Math.abs(f.z - destZ)) > near) return null;
    // (measured now, from where the bot is: a long queued route is walked for many ticks between plans)
    let left = Math.max(Math.abs(leg.x - player.x), Math.abs(leg.z - player.z));
    // port (the variety work, round 1, track F): a dungeon's leg to its next door, along the route queued (it winds: the
    // Edgeville dungeon's east passage leads away from the giants' door for 15 tiles before it turns)
    if (routeLegs.get(player) === leg.key && player.hasWaypoints()) left = _queuedRouteLeft(player);
    const walk = graphWalks.get(player);
    if (walk && player.level === 0 && leg.level === 0 && _graphGoals(leg.x, leg.z, _graphAllowed().allowed).includes(walk.goal)) {
        let best = Infinity;
        let at = walk.at;
        for (let i = walk.at; i < Math.min(walk.nodes.length, walk.at + 5); i++) {
            const [x, z] = nodePos(walk.nodes[i]);
            const d = Math.max(Math.abs(x - player.x), Math.abs(z - player.z));
            if (d <= best) {
                best = d;
                at = i;
            }
        }
        left = graphRouteCost(walk.nodes.slice(at)) + best;
    }
    return { key: leg.key, left };
}

/** port (variety round 1, F): the leg (walkLegs key) whose progress is its queued route's length (a dungeon's door leg) */
const routeLegs = new WeakMap<Player, string>();

/** port (variety round 1, F): the tiles (Chebyshev, segment by segment) of the route the bot has queued, from where it stands */
function _queuedRouteLeft(player: Player): number {
    let x = player.x;
    let z = player.z;
    let left = 0;
    for (let i = player.waypointIndex; i >= 0; i--) {
        const wp = player.waypoints[i];
        const wx = (wp >> 14) & 0x3fff;
        const wz = wp & 0x3fff;
        left += Math.max(Math.abs(wx - x), Math.abs(wz - z));
        x = wx;
        z = wz;
    }
    return left;
}

function _pathTowards(player: Player, destX: number, destZ: number): void {
    // port: a long walk follows the walking graph: its next node instead of a point on the straight line, which a
    // wall or a fence across the way left the bot pressed against (port/BotWalkGraph)
    const via = _graphTarget(player, destX, destZ);
    {
        const walk = via ? graphWalks.get(player) : undefined;
        let left = Math.max(Math.abs(destX - player.x), Math.abs(destZ - player.z));
        if (walk && walk !== null) {
            const [nx, nz] = nodePos(walk.nodes[walk.at]);
            left = graphRouteCost(walk.nodes.slice(walk.at)) + Math.max(Math.abs(nx - player.x), Math.abs(nz - player.z));
        }
        walkLegs.set(player, { key: `${player.level}:${destX},${destZ}`, x: destX, z: destZ, level: player.level, left, tick: World.currentTick });
    }
    if (via) [destX, destZ] = via;
    const dx = destX - player.x;
    const dz = destZ - player.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 1) return;

    const failed = failedSweeps.get(player);
    if (failed && World.currentTick < failed.until && Math.abs(failed.x - destX) <= 3 && Math.abs(failed.z - destZ) <= 3) {
        _naiveStep(player, dx, dz);
        return;
    }

    const attempts = _pathAttempts(player, destX, destZ, dist, Math.atan2(dz, dx));
    const key = `${player.level}_${player.x}_${player.z}>${destX}_${destZ}`;
    const progress = pathProgress.get(player);
    let next = progress && progress.key === key ? progress.next : 0;

    // (the budget's last search is a starved bot's: STARVED_SEARCH_TICKS)
    const starved = World.currentTick - (lastSearch.get(player) ?? -Infinity) >= STARVED_SEARCH_TICKS;
    // port (the realism work, phase 3: level of detail L1): a bot far from every human, within the far bots' third
    const mayStart = (): boolean => pathBudgetLeft(player) > (starved ? 0 : 1);
    for (; next < attempts.length; next++) {
        const attempt = attempts[next];
        if (attempt.kind === 'gate') {
            // openNearbyGate only matches CLOSED doors (locs with Open/Walk-through ops
            // but without Close ops), so an already-open gate is never double-interacted.
            if (!mayStart()) break;
            lastSearch.set(player, World.currentTick);
            // port: a gate the bot cannot get to does not end the search (it searched the same two routes every
            // tick and never got to the sweeps below); and the door is one on the way (_openDoorToward), not the
            // nearest
            if (_openDoorToward(player, destX, destZ) !== 'none') {
                pathProgress.delete(player);
                return;
            }
            continue;
        }
        if (!mayStart()) break;
        lastSearch.set(player, World.currentTick);
        const path = botWalkPath(player.level, player.x, player.z, attempt.x, attempt.z);
        if (path.length > 0) {
            // port: a route that stops short of the destination itself (the search gets as close as it can: outside a
            // shut door, round Peksa's shop for good) first tries the door on the way; with none, it is walked
            if (attempt.x === destX && attempt.z === destZ && dist <= MAX_SEGMENT) {
                const last = path[path.length - 1];
                if (Math.max(Math.abs(((last >> 14) & 0x3fff) - destX), Math.abs((last & 0x3fff) - destZ)) > 1 && pathBudgetLeft(player) > 0 && _openDoorToward(player, destX, destZ) !== 'none') {
                    pathProgress.delete(player);
                    return;
                }
            }
            pathProgress.delete(player);
            player.queueWaypoints(path);
            return;
        }
    }

    if (next < attempts.length) {
        // out of searches this tick: stay put and continue from here next tick
        pathProgress.set(player, { key, next });
        _waitedForBudget(player); // port (variety round 1, F): a wait, not a stall
        return;
    }
    pathProgress.delete(player);
    failedSweeps.set(player, { x: destX, z: destZ, until: World.currentTick + FAILED_SWEEP_TICKS });
    _naiveStep(player, dx, dz);
}

/** Absolute last resort: 1-tile naive step (skip if CSV-blocked) */
function _naiveStep(player: Player, dx: number, dz: number): void {
    const naiveX = player.x + Math.sign(dx);
    const naiveZ = player.z + Math.sign(dz);
    if (!BotCollisionMap.isCsvBlocked(player.level, naiveX, naiveZ)) {
        player.queueWaypoint(naiveX, naiveZ);
    }
}

/**
 * port: run on until the energy is nearly gone, and on again only past the bot's own threshold (40 to 80%, from its
 * name), as a player toggles it. Upstream ran at 30% and over, and walked below: at about 30% the bot switched every
 * tick (69% of its running streaks lasted one tick).
 */
function _setRun(player: Player): void {
    // port (the realism work, phase 5a): White Wolf Mountain on foot is crossed at a run, once there is energy for it
    // (port/BotTeleport packed food and waited for 40 % at the bank)
    if (player.run === 0 && player.runenergy >= 1000 && runsAcross(player)) player.run = 1;
    if (player.run === 1) {
        if (player.runenergy < 300) player.run = 0;
        return;
    }
    let h = 0;
    for (let i = 0; i < player.username.length; i++) h = (h * 31 + player.username.charCodeAt(i)) | 0;
    if (player.runenergy >= 4000 + (Math.abs(h) % 4000)) player.run = 1;
}

/**
 * Walk toward (destX, destZ) using accurate collision-respecting pathfinding.
 *
 * Automatically routes through known gateway regions (Al Kharid gate, cow pen,
 * Varrock north) so bots always approach gates from the correct side, and
 * through terrain corridors (Lumbridge castle west bypass, etc.) so bots
 * are never trapped looping against a large solid obstacle.
 *
 * For destinations beyond 100 tiles, walks in 90-tile segments — each call
 * advances the bot and the next tick continues toward the final goal.
 *
 * Must set moveSpeed=WALK first — updateMovement() skips its reset when
 * moveSpeed is INSTANT, permanently blocking headless player movement.
 */
// ── Scripted crossings (port) ─────────────────────────────────────────────────

/** port: a crossing the game runs by script, made as a player makes it: talk to one of `npcs` (op), answer its dialogue (`choices`: 1-based, in order; a page with one button is continued) */
interface ScriptedCrossing {
    npcs: readonly string[];
    op: 1 | 2 | 3 | 4 | 5;
    choices: readonly number[];
}

/**
 * port: the gateways bots cross the game's way (the real gate and boats): `in` into the gateway's
 * region, `out` back. The toll gate's guard lets every bot through free (they have Prince Ali Rescue done: a friend
 * of Al-Kharid); the Karamja boat costs 30 coins each way (a Port Sarim sailor; back, the customs officer's search),
 * and so does the Brimhaven-Ardougne boat (Brimhaven's customs officer; back, Captain Barnaby). Upstream teleported
 * across all of them: 30-40 casts in 10 minutes at the toll gate. (Shantay Pass and Entrana are still jumps, unseen.)
 */
const SCRIPTED_CROSSINGS: Record<string, { in: ScriptedCrossing; out: ScriptedCrossing; fare?: number }> = {
    AlKharid: { in: { npcs: ['borderguard1'], op: 1, choices: [] }, out: { npcs: ['borderguard2'], op: 1, choices: [] } },
    // (the first option throughout: "Yes please."; the customs officer's "Can I journey on this ship?", then "Ok."; and
    // without Pirate's Treasure, "Why?", "Search away, I have nothing to hide." and "Ok.")
    MusaPointBoat: {
        in: { npcs: ['captain_tobias', 'seaman_lorris', 'seaman_thresnor'], op: 1, choices: [] },
        out: { npcs: ['customs_officer'], op: 1, choices: [] },
        fare: 30
    },
    // Brimhaven's customs officer to Ardougne (the same dialogue: x < 2815 sails there), Captain Barnaby back (the
    // Karamja sailors' dialogue)
    BrimhavenBoat: {
        in: { npcs: ['customs_officer'], op: 1, choices: [] },
        out: { npcs: ['captain_barnaby'], op: 1, choices: [] },
        fare: 30
    }
};

/** port: the walking graph's regions the gateways join (both ends on the overworld), and the fare to cross each */
let compEdges: [number, number, number][] | null = null;
function _compEdges(): [number, number, number][] {
    if (compEdges) return compEdges;
    compEdges = [];
    for (const gw of GATEWAY_REGIONS) {
        if ((gw.approachLevel ?? 0) !== 0 || (gw.exitLevel ?? 0) !== 0 || !gw.approach[0] || !gw.exit[0]) continue;
        const a = _sideComp(gw.approach[0][0], gw.approach[0][1], 0, gw.exit);
        const e = _sideComp(gw.exit[0][0], gw.exit[0][1], 0, gw.approach);
        if (a < 0 || e < 0 || a === e) continue;
        compEdges.push([a, e, SCRIPTED_CROSSINGS[gw.name]?.fare ?? 0]);
    }
    return compEdges;
}

/**
 * port: the walking graph's region of (x, z): its side's component (_sideComp), else that of the nearest node within 32
 * tiles (a step's tile inside a building, on a rock, in a pen), else -1 (an altar's realm, underground)
 */
function _regionOf(x: number, z: number, level: number): number {
    const comp = _sideComp(x, z, level);
    if (comp >= 0 || level !== 0 || z >= 6400) return comp;
    const n = nearestNodes(x, z, 1, _graphAllowed().allowed)[0];
    if (n === undefined) return -1;
    const [nx, nz] = nodePos(n);
    return Math.max(Math.abs(nx - x), Math.abs(nz - z)) <= 32 ? componentOf(n) : -1;
}

/** port: the fares there and back by the walking graph's regions (the cheapest way over the gateways), or null where it cannot tell */
function _graphFare(fromX: number, fromZ: number, fromLevel: number, x: number, z: number, level: number): number | null {
    const ca = _regionOf(fromX, fromZ, fromLevel);
    const cb = _regionOf(x, z, level);
    if (ca < 0 || cb < 0) return null;
    if (ca === cb) return 0;
    const best = new Map<number, number>([[ca, 0]]);
    const queue: [number, number][] = [[0, ca]];
    while (queue.length > 0) {
        queue.sort((p, q) => p[0] - q[0]);
        const [d, u] = queue.shift()!;
        if (d > (best.get(u) ?? Infinity)) continue;
        if (u === cb) return 2 * d;
        for (const [p, q, f] of _compEdges()) {
            const t = p === u ? q : q === u ? p : -1;
            if (t < 0 || d + f >= (best.get(t) ?? Infinity)) continue;
            best.set(t, d + f);
            queue.push([d + f, t]);
        }
    }
    return null;
}

/**
 * port: the boat fares the walking graph knows a trip needs, 0 where it cannot tell (an altar's realm, underground):
 * the planner's filter. crossingFare's fallback, upstream's regions, charged 120 for trips with no boat on the way
 * (Seers to any runecrafting altar), which kept a poor bot from them
 */
export function knownFare(fromX: number, fromZ: number, fromLevel: number, x: number, z: number, level: number): number {
    return _graphFare(fromX, fromZ, fromLevel, x, z, level) ?? 0;
}

/**
 * port: the coins a bot must carry for the scripted crossings between (fromX, fromZ) and (x, z), there and back (the
 * Karamja boat: 30 each way); 0 if the trip crosses none that costs. A task that goes there takes it from the bank
 * (withdrawFare); a bot without it at the crossing falls back to the jump (unseen only), not three futile tries.
 */
export function crossingFare(fromX: number, fromZ: number, fromLevel: number, x: number, z: number, level: number): number {
    // port: the cheapest way between the two ends' regions of the walking graph (a gate or a fence costs nothing, a
    // boat its fare): none from Lumbridge to the Gnome Stronghold (by the Taverley gate), 30 each way to Karamja.
    // Upstream's regions counted every boat whose region one end was in: 120 for Seers to Draynor, and none of them needed
    const known = _graphFare(fromX, fromZ, fromLevel, x, z, level);
    if (known !== null) return known;
    let fare = 0;
    for (const gw of GATEWAY_REGIONS) {
        const f = SCRIPTED_CROSSINGS[gw.name]?.fare;
        if (f && gw.destInRegion(x, z, level) !== gw.destInRegion(fromX, fromZ, fromLevel)) fare += 2 * f;
    }
    return fare;
}

/** port: the gangplanks off the boats' decks (level 1), where a trip leaves the bot: Karamja's two, Ardougne's, Brimhaven's */
const SHIP_PLANKS: readonly [number, number, string][] = [
    [2956, 3144, 'sarimshipplank_off'],
    [3031, 3217, 'karamjashipplank_off'],
    [2683, 3269, 'brimhavenshipplank_off'],
    [2774, 3234, 'ardougneshipplank_off']
];

interface CrossingState {
    gw: string;
    inbound: boolean;
    def: ScriptedCrossing;
    start: number;
    tries: number;
    lastTry: number;
    choice: number;
}

const crossings = new WeakMap<Player, CrossingState>();
/** port: a crossing that has not got the bot across in this long has failed (a boat trip and its dialogue take about 40 ticks) */
const CROSSING_TICKS = 200;

/**
 * port: a dialogue the bot is in (a script waiting on "Click here to continue" or a choice): a page is continued, a
 * choice answered with `option` (1-based). Null when none is open.
 */
export function botAnswerDialogue(player: Player, option: number): 'page' | 'choice' | null {
    const script = player.activeScript;
    if (!script || script.execution !== ScriptState.PAUSEBUTTON) return null;
    const options = _visibleOptions(player);
    if (options.length > 1) {
        interactIfButton(player, options[Math.max(0, Math.min(option, options.length) - 1)]);
        return 'choice';
    }
    // a page (chatnpc, chatplayer, mesbox: p_pausebutton with no button of its own): the client's RESUME_PAUSEBUTTON,
    // as ResumePauseButtonHandler takes it. Without it a bot waited on the toll gate guard's first page until a watchdog
    // moved it (850 ticks), and on the boat's "Yes please." after its choice
    player.executeScript(script, true, true);
    return 'page';
}

/**
 * port: a choice's options (p_choice2-5: resume buttons on the open multi interface). The engine keeps a choice's
 * buttons after it is answered (until the chat closes), so the next page still lists them: only visible ones count.
 */
function _visibleOptions(player: Player): number[] {
    return player.resumeButtons.filter(id => {
        const com = Component.get(id);
        return com !== undefined && player.isComponentVisible(com);
    });
}

/**
 * port: a chat page left open (the essence mine's "too full" box, a level-up, an NPC's last line) continued, as a
 * player clicks it away; false if there is none, or it is a choice (those are the crossings' and the tasks' own).
 * A task that waited on any open script stood there for good: no client clicks a bot's pages away.
 */
export function botContinuePage(player: Player): boolean {
    const script = player.activeScript;
    if (!script || script.execution !== ScriptState.PAUSEBUTTON || _visibleOptions(player).length > 1) return false;
    player.executeScript(script, true, true);
    return true;
}

/**
 * port: the script the bot is in (a delay, a chat page, a count box), or null. The engine can leave one that is over in
 * activeScript: firemaking's goes on in the world queue (world_delay, for the fire's ashes) and ends there, where nothing
 * clears it, so a bot that had lit a fire was "in a script" for good: no jump across a boat it had no fare for, no
 * emote, and a wait at the anvil, the furnace or the kebab seller until a watchdog moved it. One that the world or an
 * NPC has taken over is not the bot's either (it can no longer move the bot).
 */
export function botScript(player: Player): ScriptState | null {
    const script = player.activeScript;
    if (!script) return null;
    const e = script.execution;
    return e === ScriptState.SUSPENDED || e === ScriptState.PAUSEBUTTON || e === ScriptState.COUNTDIALOG ? script : null;
}

/**
 * port: a scripted crossing is under way (its dialogue, the sail, a ship's deck): the stuck checks wait for it. (The
 * realism work, phase 5a: and a teleport cast, a crossing's preparation at the bank, a wrong turn's detour: port/BotTeleport,
 * _detouring. The checks measured them as stalls, and a desperately stuck bot jumps.)
 */
export function isCrossing(player: Player): boolean {
    // (the variety work, round 2, the fixes: and a way out of Shilo or a building's upper floor, port/BotExits)
    if (travelPaused(player) || _detouring(player) || exiting(player)) return true;
    const st = crossings.get(player);
    if (st && World.currentTick - st.lastTry <= 20) return true;
    return player.level === 1 && SHIP_PLANKS.some(([px, pz]) => Math.max(Math.abs(player.x - px), Math.abs(player.z - pz)) <= 6);
}

/** port: the crossing of `gw` this way: true while under way (the walk waits), false when there is none or it failed (the jump) */
function _crossByScript(player: Player, gw: GatewayRegion, inbound: boolean): boolean {
    const def = SCRIPTED_CROSSINGS[gw.name]?.[inbound ? 'in' : 'out'];
    if (!def) return false;
    // (not the fare on it, and not paid already: the sailor would only say so)
    if (countItem(player, Items.COINS) < (SCRIPTED_CROSSINGS[gw.name].fare ?? 0) && crossings.get(player)?.gw !== gw.name) return false;
    const now = World.currentTick;
    let st = crossings.get(player);
    if (!st || st.gw !== gw.name || st.def !== def || now - st.lastTry > CROSSING_TICKS) {
        st = { gw: gw.name, inbound, def, start: now, tries: 0, lastTry: -Infinity, choice: 0 };
        crossings.set(player, st);
    }
    if (now - st.start > CROSSING_TICKS || st.tries >= 3) return false;
    if (_continueCrossing(player)) return true;
    if (now - st.lastTry < 10) return true; // on its way to the NPC
    let npc: Npc | null = null;
    for (const name of def.npcs) {
        const found = findNpcByName(player.x, player.z, player.level, name, 16);
        if (found && (!npc || Math.max(Math.abs(found.x - player.x), Math.abs(found.z - player.z)) < Math.max(Math.abs(npc.x - player.x), Math.abs(npc.z - player.z)))) npc = found;
    }
    if (!npc) return false;
    interactNpcOp(player, npc, def.op);
    st.tries++;
    st.lastTry = now;
    st.choice = 0;
    return true;
}

/** port: a crossing under way: its dialogue answered, the sail or the gate's walk waited out, a ship's deck left by its gangplank */
function _continueCrossing(player: Player): boolean {
    const st = crossings.get(player);
    const now = World.currentTick;
    if (st && now - st.lastTry <= CROSSING_TICKS) {
        const answered = botAnswerDialogue(player, st.def.choices[st.choice] ?? 1);
        if (answered !== null) {
            if (answered === 'choice') st.choice++;
            st.lastTry = now;
            return true;
        }
        if (player.delayed || botScript(player)) {
            st.lastTry = now;
            return true;
        }
        // across: done (a later dialogue is none of the crossing's)
        const gw = GATEWAY_REGIONS.find(g => g.name === st.gw);
        if (gw && gw.destInRegion(player.x, player.z, player.level) === st.inbound) crossings.delete(player);
    }
    if (player.level === 1) {
        for (const [px, pz, name] of SHIP_PLANKS) {
            if (Math.max(Math.abs(player.x - px), Math.abs(player.z - pz)) > 6) continue;
            const plank = findLocByName(px, pz, 1, name, 1);
            if (plank) {
                interactLocOp(player, plank, 1);
                return true;
            }
        }
    }
    return false;
}

export function walkTo(player: Player, destX: number, destZ: number, level = 0): void {
    walkFinals.set(player, { x: destX, z: destZ, tick: World.currentTick });
    try {
        const botName = _debugBotName(player);
        if (botName) BotDebugService.noteDestination(botName, destX, destZ, level);
    } catch {
        // debug hook must never affect gameplay
    }

    // If a gate/door interaction is already pending (queued by openNearbyGate on
    // the previous tick), preserve it rather than wiping it here.  The engine's
    // processInteraction will walk the bot to the gate and fire APLOC1; calling
    // clearPendingAction before that happens is the root cause of the "sometimes
    // opens, sometimes doesn't" inconsistency — the interaction races against the
    // next bot tick and only survives when the engine processes it first.
    if (_hasGateInteractionPending(player)) return;
    // port (the realism work, phase 5a): nothing while a script holds the bot (p_delay: a teleport's cast, a climb, a
    // pick-up). The engine drops a player's move clicks then (MoveClickHandler), but queueWaypoints does not ask: a bot
    // walked off in the middle of a cast, and on through other scripts' delays
    if (player.delayed) return;
    // port: a gate's script the bot set off a moment ago (the gnome stronghold's walks the bot to its side, then moves
    // it through): wait for it. A new walk in the middle took the bot away again (a sweep 50 tiles back, every time)
    {
        const opened = lastDoorOpened.get(player);
        const script = botScript(player);
        if (opened && World.currentTick - opened[1] <= 8 && (player.delayed || (script && script.execution === ScriptState.SUSPENDED))) return;
    }
    if (_continueDoorWalk(player)) return;
    // port: a toll gate's or a boat's crossing under way (its dialogue, the sail), and off a ship's deck
    if (_continueCrossing(player)) return;

    // port: underground (a dungeon below z 6400) with a target on the surface: climb out first (no route search
    // crosses the two). Upstream searched for a surface route from below, found none and wandered the dungeon
    // until a stuck detector teleported it (a bot whose next task began there, test/sim.mjs --scenario=aged)
    // port (the variety work, round 1, track F: dungeon-to-dungeon trips, ISS-4): and with a target in another dungeon: out
    // of this one first (the task's own leg takes it down the other's way in). Upstream searched across, found nothing and
    // was jumped underground from one dungeon to the other (the Edgeville dungeon to the ice dungeon: 298 tiles)
    // port (the variety work, round 2, the integrator's): in the rune essence mine (an instance, no route out) with a target
    // outside it: out by its portal first, as RunecraftingTask's mine_exit (a bot that logged out there, or whose next task
    // began there: a bank or shop walk searched for a route, found none and was jumped)
    if (player.level === 0 && level === 0 && inRuneEssenceMine(player.x, player.z) && !inRuneEssenceMine(destX, destZ)) {
        // (the variety work, round 2, the fixes: and nothing in the portal's p_delay, its script under way: a click and a
        // mark again each tick of it)
        if (player.delayed || botContinuePage(player)) return;
        const portal = findLocByName(player.x, player.z, 0, 'blankrunestone_exit_portal', 40);
        if (portal) {
            if (player.target !== portal && botScript(player) === null) {
                interactLocOp(player, portal, 1);
                // (the portal puts it at %exit_essence_mine_coord, by Aubury for every bot: his Teleport, the bots' only way
                // in, sets it before the jump, a saved varp: the game's move)
                noteMove(player, 'event');
            }
            return;
        }
    }
    // port (the variety work, round 2, the fixes: an outing's dead ends) behind Shilo's walls or upstairs in Yanille's
    // watchtower with a target elsewhere: Vigroy's cart, or the tower's ladder down, first (port/BotExits). A walk from
    // there searched for a route, found none and was rescue-jumped 450+ tiles
    if (exitLeg(player, destX, destZ, level)) return;
    // port (the variety work, round 2, the fixes): a dungeon whose floor is on another level (the Brimhaven Agility Arena's
    // platforms, level 3; its pit, level 0) with a target out of it: its own way out (_otherFloorExit). The block below
    // asks for level 0 and a level-0 ladder: a bot left on the arena's platforms walked from there with no route at all
    if (player.z > 6400 && level === 0) {
        const route = dungeonRoute(player.x, player.z);
        if (route.floor[2] !== 0 && route.exit && (destZ < 6400 || !sameDungeon(player.x, player.z, destX, destZ)) && _otherFloorExit(player, route)) return;
    }
    if (player.z > 6400 && level === 0 && player.level === 0) {
        const leaving = destZ < 6400 || !sameDungeon(player.x, player.z, destX, destZ);
        const route = dungeonRoute(leaving ? player.x : destX, leaving ? player.z : destZ);
        if (leaving || route.doors) {
            // (variety round 1, F: a route queued is walked out, as a plain walk's: not searched again every tick)
            if (player.hasWaypoints() && _blockedOnRoute(player)) player.clearWaypoints();
            if (player.hasWaypoints()) {
                _setRun(player);
                player.moveSpeed = MoveSpeed.WALK;
                return;
            }
        }
        if (leaving) {
            const { entrance: [ex, ez, el], floor: [fx, fz] } = route;
            // (variety round 1, F) a dungeon with doors: room by room back to its floor first
            if (route.doors && _dungeonDoorsWalk(player, route, fx, fz)) return;
            // port: up the dungeon's ladder, walked to, where it has one by its floor tile (the ice dungeon); else the jump
            if (_findLoc(fx, fz, 0, 4, loc => _hasOp(loc, 'climb-up')) !== null) {
                if (Math.max(Math.abs(player.x - fx), Math.abs(player.z - fz)) > 3) _pathTowards(player, fx, fz);
                // port (the variety work, round 1, the fixes): by the floor, but across a wall from it (the map's unused
                // floor round the Varrock sewers, where a rescue jump had put a bot: it clicked the manhole's ladder
                // through the wall, "I can't reach that!" 657 times): the jump, as a dungeon without a ladder
                else if (!_floorRoom(fx, fz).has((player.x << 14) | player.z)) botTeleport(player, ex, ez, el, 'dungeon');
                else interactNearbyLocByOps(player, 'climb-up', 6);
                return;
            }
            botTeleport(player, ex, ez, el, 'dungeon');
            return;
        }
        // port (variety round 1, F): within a dungeon with doors (the Edgeville trapdoor's way to the hill giants), room by room
        if (route.doors && _dungeonDoorsWalk(player, route, destX, destZ)) return;
    }

    // port (the realism work, phase 5a): a long trip by a bot with the Magic level and the runes may be a real teleport
    // spell, seen like a player's (port/BotTeleport decides once per destination; most bots walk)
    if (teleportLeg(player, destX, destZ, level)) return;
    if (travelLeg(player, destX, destZ, level)) return; // (the variety work, round 2, Track D2: a spirit tree or a glider for a long walk, port/BotTravel)

    // If the bot already has waypoints queued from a previous call, let the
    // existing path play out rather than recalculating every tick.  Without this
    // guard, the compass-sweep fallback picks a direction, then the very next
    // tick recalculates and picks a different direction, producing the
    // back-and-forth oscillation seen especially around Draynor Village.
    // Run/speed are still updated so the bot can toggle run while walking.
    // port: but a route the bot has not taken a step of for BLOCKED_ROUTE_TICKS is dropped: a tile on it is one a
    // blocking NPC stands on (the path search does not see NPCs that block players; a player's step does: Draynor
    // Manor's nasty trees held a bot 800 ticks). The legs that follow are short ones (_graphTarget)
    if (player.hasWaypoints() && _blockedOnRoute(player)) player.clearWaypoints();
    if (player.hasWaypoints()) {
        _setRun(player);
        player.moveSpeed = MoveSpeed.WALK;
        return;
    }

    // Cancel any active engine interaction (setInteraction target) before setting
    // new waypoints.  Without this, processInteraction() re-routes the player back
    // toward the old target every tick, overriding the walkTo waypoints and causing
    // the "moving backwards" symptom when transitioning between task states
    // (e.g. fishing spot → bank, or woodcutting → bank).
    player.clearPendingAction();

    // Toggle persistent run based on current energy.
    // Enable at 30 % (3 000/10 000); disable below 30 % so energy recovers.
    // runanim must be non-(-1) for this to take effect — set in BotAppearance.randomize.
    _setRun(player);

    player.moveSpeed = MoveSpeed.WALK; // guard against INSTANT; processMovement overrides via defaultMoveSpeed()

    if (Math.abs(player.x - destX) < 1 && Math.abs(player.z - destZ) < 1 && player.level === level) return;

    // port: the walking graph joins the bot and the destination (port/BotWalkGraph): no gate, boat, ladder or toll gate
    // between, so no gateway; the walk follows the graph (_pathTowards). The gateways' regions were drawn for straight-
    // line walks and overlap: north of Lumbridge castle the 'Lumbridge' gateway (its castle band, eastern Misthalin and
    // the desert as one region) sent a bot bound for Varrock West mine back and forth across z 3237 for good
    if (level === 0 && player.level === 0) {
        const joined = _graphJoins(player, destX, destZ);
        if (joined === 'wait') {
            _waitedForBudget(player); // (out of searches this tick: the bot carries on next tick; variety round 1, F: a wait)
            return;
        }
        if (joined === 'yes') {
            _pathTowards(player, destX, destZ);
            return;
        }
    }

    // ── Gateway routing ─────────────────────────────────────────────────────
    // If the destination is inside a gated region and the bot is outside,
    // walk to the approach area first, then open the gate, then proceed
    // to the exit area. If there are multiple gateways to the destination,
    // try to find the most optimal route before selecting the next gateway.
    // Working backwards through the gateways from destination to the bot,
    // find the optimal gateway and set it as new destination.
    // Repeat until no gateways are left so we know our first destination.
    let gw: GatewayRegion | null = null;
    let gwExit: number[][] | null = null;
    let next = [destX, destZ, level];
    let nextExit = next;
    const currRegions = [...GATEWAY_REGIONS];
    // port: the chain, from the destination back to the bot; and the side `next` is on (the chosen gateway's exit side)
    const chain: { gw: GatewayRegion; next: number[]; nextExit: number[]; gwExit: number[][]; approachArea: number[][] }[] = [];
    let nextAvoid: number[][] | undefined = undefined;
    const coins = countItem(player, Items.COINS);
    for (const _i of GATEWAY_REGIONS) {
        let bestgw: GatewayRegion | null = null;
        let bestDist = Infinity;
        let bestDist2 = Infinity;
        let best = next;

        // Check whether the destination requires more diagonal or
        // vertical/horizontal movement. For use later.
        let diagonal = true;
        const dx = next[0] - player.x;
        const dz = next[1] - player.z;
        if (dx > 2 * dz || dz > 2 * dx) diagonal = false;

        for (const curr of currRegions) {
            let approach = curr.approach;
            let exit = curr.exit;
            // Approach or exit not properly defined.
            if (approach.length < 1 || exit.length < 1) continue;
            if (approach[0].length < 2 || exit[0].length < 2) continue;
            let approachLevel = curr.approachLevel ?? 0;
            let exitLevel = curr.exitLevel ?? 0;

            // Only consider gateways where the destination
            // is in the region and the bot is outside.
            // Or the destination is outside but the bot inside.
            if (curr.destInRegion(next[0], next[1], next[2])) {
                if (curr.destInRegion(player.x, player.z, player.level)) {
                    continue;
                }
            } else {
                if (!curr.destInRegion(player.x, player.z, player.level)) {
                    continue;
                } else {
                    // Swap values when exiting for easier calculation.
                    approach = curr.exit;
                    exit = curr.approach;
                    approachLevel = curr.exitLevel ?? 0;
                    exitLevel = curr.approachLevel ?? 0;
                }
            }

            // port: a gateway whose far end is not in the walking graph's region of `next` needs more gateways after it
            // (the Brimhaven boat's for a walk from Seers to Draynor: Karamja, its fence and the Karamja boat): not
            // this one, where the regions say so (a gateway's regions are drawn coarsely: Kandarin is in the Karamja boat's)
            if (exitLevel === 0 && next[2] === 0) {
                const ce = _sideComp(exit[0][0], exit[0][1], 0, approach);
                const cn = _sideComp(next[0], next[1], 0, nextAvoid);
                if (ce >= 0 && cn >= 0 && ce !== cn) continue;
            }

            // If an approach/exit area is defined, check for the optimal tile.
            const bestApproach = closestBetween(approach, [player.x, player.z], [next[0], next[1]]);
            let bestExit = [exit[0][0], exit[0][1]];
            if (exit.length > 1) {
                // If teleport area is defined, use the average.
                if (curr.teleport) {
                    bestExit[0] = (exit[0][0] + exit[1][0]) / 2;
                    bestExit[1] = (exit[0][1] + exit[1][1]) / 2;
                } else {
                    bestExit = closestBetween(exit, bestApproach, [next[0], next[1]]);
                }
            }

            // Combine distance from bot to gateway and distance from
            // gateway to destination. If no teleport, also add distance from
            // approach to exit. The best gateway has the least total distance.
            // Use Chebyshev distance if the destination requires more
            // vertical/horizontal movement and Manhattan distance for diagonal.
            // This better ensures that we don't pick a gateway behind the bot.
            // If this results in gateways having the same distance,
            // use Euclidean distance to find the one closest to our path.
            const dx1 = Math.abs(bestApproach[0] - player.x);
            const dz1 = Math.abs(bestApproach[1] - player.z);
            const dx2 = Math.abs(next[0] - bestExit[0]);
            const dz2 = Math.abs(next[1] - bestExit[1]);
            let dx3 = 0;
            let dz3 = 0;
            if (!curr.teleport) {
                dx3 = Math.abs(bestExit[0] - bestApproach[0]);
                dz3 = Math.abs(bestExit[1] - bestApproach[1]);
            }

            let currDist = 0;
            if (diagonal) {
                currDist = dx1 + dz1 + dx2 + dz2 + dx3 + dz3;
            } else {
                currDist = Math.max(dx1 + dz1) + Math.max(dx2 + dz2) + Math.max(dx3 + dz3);
            }
            const currDist2 =
                Math.sqrt(dx1 * dx1 + dz1 * dz1) +
                Math.sqrt(dx2 * dx2 + dz2 * dz2) +
                Math.sqrt(dx3 * dx3 + dz3 * dz3);
            // port: a boat the bot has no fare for only when there is no other way (it is the jump)
            const fare = SCRIPTED_CROSSINGS[curr.name]?.fare ?? 0;
            if (fare > 0 && coins < fare) currDist += 1000;
            if (currDist < bestDist || (currDist === bestDist && currDist2 < bestDist2)) {
                bestgw    = curr;
                bestDist  = currDist;
                bestDist2 = currDist2;
                best      = [bestApproach[0], bestApproach[1], approachLevel];
                nextExit  = [bestExit[0], bestExit[1], exitLevel];
                gwExit    = exit;
            }
        }

        // Found gateway is set as new destination so we go back and find
        // a route to it first until there are no more prior gateways.
        // In which case we can finally path to this gateway.
        if (bestgw) {
            gw = bestgw;
            next = best;
            chain.push({ gw: bestgw, next: best, nextExit, gwExit: gwExit!, approachArea: bestgw.destInRegion(player.x, player.z, player.level) ? bestgw.exit : bestgw.approach });
            nextAvoid = bestgw.destInRegion(player.x, player.z, player.level) ? bestgw.approach : bestgw.exit;

            // Ensure each gateway is only used once in the calculated route.
            const index = currRegions.indexOf(bestgw);
            if (index > -1) {
                currRegions.splice(index, 1);
            }
        } else {
            break;
        }
    }

    // If a gateway was found, one of 4 things will happen.
    // 1. If not near approach tile, walk to it first.
    // 2. If teleport is set, teleport to exit area.
    // 3. If changing floor, interact with stairs.
    // 4. Otherwise walk to exit area.
    // port: the gateways the walking graph walks past (White Wolf Mountain's three, between Taverley and Catherby: their
    // regions sent a bot over the top and back down for good): the walk goes to the first one it does not join
    if (chain.length > 1 && player.level === 0) {
        const start = _graphStart(player);
        if (start === 'wait') {
            _waitedForBudget(player);
            return;
        }
        const cb = componentOf(start);
        if (cb >= 0) {
            for (let i = 0; i < chain.length - 1; i++) {
                const c = chain[i];
                if (c.next[2] !== 0 || _sideComp(c.next[0], c.next[1], 0, c.gwExit) !== cb) continue;
                // (and no long detour: the graph's walk, as _graphPlan plans it)
                const plan = _graphPlan(player, Math.round(c.next[0]), Math.round(c.next[1]));
                if (plan === 'wait') {
                    _waitedForBudget(player);
                    return;
                }
                if (!plan) continue;
                gw = c.gw;
                next = c.next;
                nextExit = c.nextExit;
                gwExit = c.gwExit;
                break;
            }
        }
    }
    if (gw && gwExit) {
        const gwDist = Math.max(Math.abs(player.x - next[0]), Math.abs(player.z - next[1])); // Chebyshev distance
        // port: stairs and ladders from the approach tile itself: 5 tiles off can be the wrong side of a wall (a bot in
        // the room next to Lumbridge castle's stairs clicked them every tick: "I can't reach that!"); the walk there
        // opens the doors on the way (_openDoorToward)
        const crossAt = next[2] !== nextExit[2] ? 1 : 5;

        if (gwDist > crossAt) {
            // Not yet at the approach tile — walk toward it first.
            // If the requested destination is CSV-blocked or WALK_BLOCKED,
            // find the nearest walkable tile.
            if (BotCollisionMap.isCsvBlocked(next[2], next[0], next[1])) {
                const alt = findNearestWalkableTile(next[2], next[0], next[1], 5);
                if (!alt) return; // nowhere reachable near this destination
                next[0] = alt.x;
                next[1] = alt.z;
            }
            _pathTowards(player, next[0], next[1]);

            try {
                const botName = _debugBotName(player);
                if (botName) BotDebugService.event(botName, 'movement', `approach gateway ${gw.name} (${next[0]},${next[1]},${next[2]})`);
            } catch {
                // debug hook must never affect gameplay
            }
            return;
        }

        // Close to approach tile — cross the gate.
        // port: the game's way where there is one (SCRIPTED_CROSSINGS: the toll gate's guard, the Karamja boat); the
        // jump below (unseen only) is the fallback when it fails
        if (gw.teleport && _crossByScript(player, gw, !gw.destInRegion(player.x, player.z, player.level))) return;
        if (gw.teleport) {
            let teleportDestX = gwExit[0][0];
            let teleportDestZ = gwExit[0][1];
            // Toll/dialog gate that bots can't interact with — teleport through.
            // If teleport area is defined, use random tile in area.
            if (gwExit.length > 1) {
                const xMin = Math.min(gwExit[0][0], gwExit[1][0]);
                const zMin = Math.min(gwExit[0][1], gwExit[1][1]);
                const xMax = Math.max(gwExit[0][0], gwExit[1][0]);
                const zMax = Math.max(gwExit[0][1], gwExit[1][1]);
                teleportDestX = xMin + Math.floor(Math.random() * (xMax - xMin + 1));
                teleportDestZ = zMin + Math.floor(Math.random() * (zMax - zMin + 1));
            }
            // If the requested destination is CSV-blocked or WALK_BLOCKED,
            // find the nearest walkable tile before teleporting.
            if (BotCollisionMap.isCsvBlocked(nextExit[2], teleportDestX, teleportDestZ)) {
                const alt = findNearestWalkableTile(nextExit[2], teleportDestX, teleportDestZ, 5);
                if (!alt) return; // nowhere reachable near this destination
                teleportDestX = alt.x;
                teleportDestZ = alt.z;
            }
            botTeleport(player, teleportDestX, teleportDestZ, nextExit[2], 'gateway', gw.name);
            return;
        }

        // Changing floor, interact with stairs.
        if (next[2] < nextExit[2] || (next[1] > 4100 && nextExit[1] <= 4100)) {
            interactNearbyLocByOps(player, 'climb-up', 8);
            return;
        } else if (next[2] > nextExit[2] || (next[1] <= 4100 && nextExit[1] > 4100)) {
            interactNearbyLocByOps(player, 'climb-down', 8);
            return;
        }

        // Walk inside the exit area as we may need to get through
        // more gateways before the last destination is reachable.
        // Make sure we actually get a walkable tile in the exit area.
        if (BotCollisionMap.isCsvBlocked(nextExit[2], nextExit[0], nextExit[1])) {
            nextExit = closestBetween(gwExit, [player.x, player.z], [destX, destZ], nextExit[2]);
        }
        _pathTowards(player, nextExit[0], nextExit[1]);

        try {
            const botName = _debugBotName(player);
            if (botName) BotDebugService.event(botName, 'movement', `exiting gateway ${gw.name} (${nextExit[0]},${nextExit[1]},${nextExit[2]})`);
        } catch {
            // debug hook must never affect gameplay
        }
        return;
    }
    // No more gateways found, path directly to destination.

    // ── Destination validation ───────────────────────────────────────────────
    // If the requested destination is CSV-blocked or WALK_BLOCKED
    // find the nearest walkable tile.
    if (BotCollisionMap.isCsvBlocked(level, destX, destZ)) {
        const alt = findNearestWalkableTile(level, destX, destZ, 5);
        if (!alt) return; // nowhere reachable near this destination
        destX = alt.x;
        destZ = alt.z;
    }

    // ── Normal pathfinding ──────────────────────────────────────────────────
    _pathTowards(player, destX, destZ);
}

// ── Dungeons with doors (port: the variety work, round 1, track F; ISS-4) ─────────────────────────────────────────

/** (the fixes) the tiles a walk from a dungeon's floor reaches within 6 of it (its ladder's room), kept by floor */
const floorRooms = new Map<number, Set<number>>();
function _floorRoom(fx: number, fz: number): Set<number> {
    const key = (fx << 14) | fz;
    let room = floorRooms.get(key);
    if (!room) floorRooms.set(key, (room = tilesInSquare(0, fx, fz, 6)));
    return room;
}

/**
 * port (variety round 1, F): are (ax, az) and (bx, bz), both underground, in the same dungeon? The same named route
 * (BotKnowledge.dungeonRoute's key), else the same entrance; two places of no known dungeon within a search's reach.
 */
export function sameDungeon(ax: number, az: number, bx: number, bz: number): boolean {
    if (az < 6400 || bz < 6400) return false;
    const a = dungeonRoute(ax, az);
    const b = dungeonRoute(bx, bz);
    if (a.key || b.key) return a.key === b.key;
    const known = (r: typeof a, x: number, z: number): boolean => r.floor[0] !== x || r.floor[1] !== z;
    if (known(a, ax, az) || known(b, bx, bz)) return a.entrance[0] === b.entrance[0] && a.entrance[1] === b.entrance[1];
    return Math.max(Math.abs(ax - bx), Math.abs(az - bz)) <= 100;
}

/**
 * port (the variety work, round 2, the fixes): out of a dungeon whose floor is on another level (the Agility Arena's): below
 * its floor (the arena's pit) up the nearest climbing rope or ladder (its Climb, Climb-up), marked as the game's move; on
 * its floor its exit (the ladder up) clicked where a walk reaches it. Where none does (the arena's platforms are crossed by
 * its obstacles, AgilityArenaTask's), the dungeon's jump to its entrance above, as a dungeon with no ladder. True while it
 * handled this tick.
 */
function _otherFloorExit(player: Player, route: DungeonRoute): boolean {
    if (player.delayed || botScript(player)) return true;
    const [fx, fz, fl] = route.floor;
    const [ex, ez, el] = route.entrance;
    if (player.level < fl) {
        const rope = _findLoc(player.x, player.z, player.level, 30, loc => _hasOp(loc, 'climb') || _hasOp(loc, 'climb-up'));
        if (!rope) return botTeleport(player, ex, ez, el, 'dungeon') || true;
        if (player.target !== rope) {
            const ops = (LocType.get(rope.type).op ?? []).map(o => String(o ?? '').toLowerCase());
            const i = ops.findIndex(o => o === 'climb' || o === 'climb-up');
            interactLocOp(player, rope, (i >= 0 ? i + 1 : 1) as 1 | 2 | 3 | 4 | 5);
            noteMove(player, 'event'); // (the rope's climb_ladder: the game's move)
        }
        return true;
    }
    if (player.level !== fl || !route.exit) return false;
    const exit = findLocByName(fx, fz, fl, route.exit.loc, 4);
    if (!exit) return botTeleport(player, ex, ez, el, 'dungeon') || true;
    if (player.target === exit) return true;
    const t = LocType.get(exit.type);
    let reaches = botReachedLoc(fl, player.x, player.z, exit.x, exit.z, exit.width, exit.length, exit.angle, exit.shape, t.forceapproach);
    if (!reaches) {
        if (pathBudgetLeft(player) <= 0) {
            _waitedForBudget(player);
            return true;
        }
        const path = botPathToLoc(fl, player.x, player.z, exit.x, exit.z, exit.width, exit.length, exit.angle, exit.shape, t.forceapproach, false);
        const last = path.length > 0 ? path[path.length - 1] : -1;
        reaches = last !== -1 && botReachedLoc(fl, (last >> 14) & 0x3fff, last & 0x3fff, exit.x, exit.z, exit.width, exit.length, exit.angle, exit.shape, t.forceapproach);
    }
    if (!reaches) return botTeleport(player, ex, ez, el, 'dungeon') || true;
    interactLocOp(player, exit, route.exit.op as 1 | 2 | 3 | 4 | 5);
    return true;
}

/** a dungeon room's flood at most this many tiles (the hill giants' room is 763) and this far from where it starts */
const ROOM_TILES = 4000;
const ROOM_REACH = 90;
/** a tile's room, kept a while (a bot's: until it walks near a door or this many ticks pass) */
const ROOM_KEEP_TICKS = 40;
const roomOfTile = new Map<string, number>();
/** (a bot's rooms by route: two at most, a walk between the two routes of one dungeon asks both) */
const roomOfBot = new WeakMap<Player, { key: string; room: number; x: number; z: number; tick: number }[]>();

/**
 * port (the variety work, round 1, the fixes): a route's own name for the rooms kept: a dungeon of two routes (the
 * Edgeville dungeon's giants and druids: one key, a door in common, then a door each) numbers its rooms by each
 * route's doors, so a room kept for one is no room of the other's
 */
function _routeId(route: DungeonRoute): string {
    const doors = route.doors ?? [];
    return `${route.key ?? route.entrance.join(',')}|${doors.map(group => group[0].join(',')).join('/')}`;
}
/** port (variety round 1, F): the dungeon walks room by room (the tests, the report) */
export const dungeonWalkStats = { legs: 0, crossings: 0, unknownRoom: 0 };

/**
 * The room of (x, z) in a dungeon with doors: 0 on the floor's side of the first door, i between door i-1 and door i,
 * doors.length beyond the last; -1 when the flood meets none of the doors' tiles. A flood of single steps that never
 * crosses a door's own tile pair (open or shut: an open door joins the rooms only through its frame).
 */
function _roomOf(route: DungeonRoute, x: number, z: number): number {
    const doors = route.doors!;
    const pairs = new Set<string>();
    for (const group of doors) for (const [ax, az, bx, bz] of group) {
        pairs.add(`${ax},${az}>${bx},${bz}`);
        pairs.add(`${bx},${bz}>${ax},${az}`);
    }
    const seen = new Set<number>([(x << 14) | z]);
    const queue: number[] = [x, z];
    for (let i = 0; i < queue.length && seen.size < ROOM_TILES; i += 2) {
        const cx = queue[i];
        const cz = queue[i + 1];
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx;
            const nz = cz + dz;
            const k = (nx << 14) | nz;
            if (seen.has(k) || Math.max(Math.abs(nx - x), Math.abs(nz - z)) > ROOM_REACH) continue;
            if (pairs.has(`${cx},${cz}>${nx},${nz}`)) continue;
            if (!canTravel(0, cx, cz, dx, dz, 1, 0, CollisionType.NORMAL)) continue;
            seen.add(k);
            queue.push(nx, nz);
        }
    }
    const has = (tx: number, tz: number): boolean => seen.has((tx << 14) | tz);
    if (doors[0].some(([ax, az]) => has(ax, az))) return 0;
    for (let i = 1; i < doors.length; i++) {
        if (doors[i - 1].some(([, , bx, bz]) => has(bx, bz)) && doors[i].some(([ax, az]) => has(ax, az))) return i;
    }
    return doors[doors.length - 1].some(([, , bx, bz]) => has(bx, bz)) ? doors.length : -1;
}

/** (variety round 1, F) the bot's room in the route's dungeon, kept while it walks between doors */
function _botRoom(player: Player, route: DungeonRoute): number {
    const key = _routeId(route);
    const now = World.currentTick;
    const rooms = roomOfBot.get(player) ?? [];
    const kept = rooms.find(r => r.key === key);
    const nearDoor = route.doors!.some(group => group.some(([ax, az, bx, bz]) => Math.max(Math.abs(player.x - ax), Math.abs(player.z - az)) <= 2 || Math.max(Math.abs(player.x - bx), Math.abs(player.z - bz)) <= 2));
    if (kept && now - kept.tick < ROOM_KEEP_TICKS && !nearDoor && Math.max(Math.abs(kept.x - player.x), Math.abs(kept.z - player.z)) <= 30) return kept.room;
    const room = _roomOf(route, player.x, player.z);
    roomOfBot.set(player, [{ key, room, x: player.x, z: player.z, tick: now }, ...rooms.filter(r => r.key !== key)].slice(0, 2));
    return room;
}

/** (tests) the room of (x, z) in its dungeon with doors (BotKnowledge.dungeonRoute), -1 for none (or a dungeon without doors) */
export function dungeonRoomForTest(x: number, z: number): number {
    const route = dungeonRoute(x, z);
    return route.doors ? _roomOf(route, x, z) : -1;
}

function _tileRoom(route: DungeonRoute, x: number, z: number): number {
    const key = `${_routeId(route)}|${x},${z}`;
    let room = roomOfTile.get(key);
    if (room === undefined) {
        room = _roomOf(route, x, z);
        roomOfTile.set(key, room);
        if (roomOfTile.size > 2048) roomOfTile.delete(roomOfTile.keys().next().value!);
    }
    return room;
}

/**
 * port (variety round 1, F): a walk to (destX, destZ) inside a dungeon with doors (BotKnowledge.dungeonRoute's `doors`):
 * in the target's room, false (the walk is a plain one); else toward the next door between: to its near side, then
 * through it (the walk opens it, _openDoorToward). True when it moved the bot.
 */
function _dungeonDoorsWalk(player: Player, route: DungeonRoute, destX: number, destZ: number): boolean {
    const from = _botRoom(player, route);
    const to = _tileRoom(route, destX, destZ);
    if (from < 0 && to >= 0) {
        // port (the variety work, round 1, the fixes): the bot in a room of another route of this dungeon (the giants' room
        // for a walk to the druids, or the druids' for one to the giants: a branch each off the east passage): back by its
        // own route toward the floor, to the rooms the two share, then on by the target's
        const own = dungeonRoute(player.x, player.z);
        if (own !== route && own.doors && own.key !== undefined && own.key === route.key && _botRoom(player, own) > 0) return _dungeonDoorsWalk(player, own, own.floor[0], own.floor[1]);
    }
    if (from < 0 || to < 0) {
        if (from < 0) dungeonWalkStats.unknownRoom++;
        return false;
    }
    if (from === to) return false;
    // the door between: the next one inward (to > from) or outward
    const group = route.doors![to > from ? from : from - 1];
    const near = (p: [number, number, number, number]): [number, number] => (to > from ? [p[0], p[1]] : [p[2], p[3]]);
    const far = (p: [number, number, number, number]): [number, number] => (to > from ? [p[2], p[3]] : [p[0], p[1]]);
    // (of a double door, the pair nearest the bot)
    let pair = group[0];
    for (const p of group) {
        const [nx, nz] = near(p);
        const [bx, bz] = near(pair);
        if (Math.max(Math.abs(player.x - nx), Math.abs(player.z - nz)) < Math.max(Math.abs(player.x - bx), Math.abs(player.z - bz))) pair = p;
    }
    const [nx, nz] = near(pair);
    const [fx, fz] = far(pair);
    if (player.x === nx && player.z === nz) {
        // at the door: through it (a closed one is opened on the way, _pathTowards's door attempt)
        dungeonWalkStats.crossings++;
        roomOfBot.delete(player);
        _pathTowards(player, fx, fz);
        routeLegs.set(player, `${player.level}:${fx},${fz}`);
        return true;
    }
    dungeonWalkStats.legs++;
    _pathTowards(player, nx, nz);
    routeLegs.set(player, `${player.level}:${nx},${nz}`);
    return true;
}

/**
 * port (variety round 1, F: hill giants by the Edgeville trapdoor): down the ladder or trapdoor within `radius` (its
 * Climb-down), or a closed trapdoor there opened first (274's [oploc1,trapdoor]: it opens for 500 ticks, then its
 * Climb-down takes the bot below). False when there is neither.
 */
export function climbDownNear(player: Player, radius: number): boolean {
    if (interactNearbyLocByOps(player, 'climb-down', radius)) return true;
    const trapdoor = _findLoc(player.x, player.z, player.level, radius, loc => (LocType.get(loc.type).debugname ?? '').startsWith('trapdoor') && _hasOp(loc, 'open'));
    if (!trapdoor) return false;
    if (player.target === trapdoor) return true;
    interactLocOp(player, trapdoor, 1);
    return true;
}

/**
 * Find the point in an area closest between 2 points.
 * This is done by combining the distance from point `a` to a point in the area
 * and from point `b` to that point in the area.
 * Returning the point in the area with the least distance.
 */
function closestBetween(area: number[][], a: number[], b: number[], csvLevel?: number): number[] {
    let best = [area[0][0], area[0][1]];
    // Only caculate if area actually consists of more than one tile.
    if (area.length > 1) {
        let bestDist = Infinity;
        const xMin = Math.min(area[0][0], area[1][0]);
        const zMin = Math.min(area[0][1], area[1][1]);
        const xMax = Math.max(area[0][0], area[1][0]);
        const zMax = Math.max(area[0][1], area[1][1]);
        for (let x = xMin; x <= xMax; x++) {
            for (let z = zMin; z <= zMax; z++) {
                // If set, make sure we get in the area on a walkable tile.
                if (csvLevel && BotCollisionMap.isCsvBlocked(csvLevel, x, z)) continue;
                const dxa = x - a[0];
                const dza = z - a[1];
                const dxb = x - b[0];
                const dzb = z - b[1];
                const dist =
                    Math.sqrt(dxa * dxa + dza * dza) +
                    Math.sqrt(dxb * dxb + dzb * dzb);
                if (dist < bestDist) {
                    bestDist = dist;
                    best = [x, z];
                }
            }
        }
    }
    return best;
}




/**
 * Items we wish the bots to sell to real players, namely materials such as logs, ores, bars, etc... In their noted forms.
 */
export const viableItemIds:    number[] = [
    2349, //bronze_bar
    2350, //cert_bronze_bar
    2351, //iron_bar
    2352, //cert_iron_bar
    2353, //steel_bar
    2354, //cert_steel_bar
    2355, //silver_bar
    2356, //cert_silver_bar
    2357, //gold_bar
    2358, //cert_gold_bar
    2359, //mithril_bar
    2360, //cert_mithril_bar
    2361, //adamantite_bar
    2362, //cert_adamantite_bar
    2363, //runite_bar
    2364, //cert_runite_bar
    39, //bronze_arrowheads
    40, //iron_arrowheads
    41, //steel_arrowheads
    42, //mithril_arrowheads
    43, //adamant_arrowheads
    44, //rune_arrowheads
    221, //eye_of_newt
    223, //red_spiders_eggs
    225, //limpwurt_root
    227, //vial_water
    229, //vial_empty
    231, //snape_grass
    314, //feather
    317, //raw_shrimp
    321, //raw_anchovies
    327, //raw_sardine
    331, //raw_salmon
    335, //raw_trout
    341, //raw_cod
    345, //raw_herring
    349, //raw_pike
    353, //raw_mackerel
    359, //raw_tuna
    363, //raw_bass
    371, //raw_swordfish
    377, //raw_lobster
    383, //raw_shark
    389, //raw_mantaray
    395, //raw_seaturtle
    401, //seaweed
    434, //clay
    526, //bones
    530, //bat_bones
    532, //big_bones
    534, //babydragon_bones
    536, //dragon_bones
    1617, //uncut_diamond
    1619, //uncut_ruby
    1621, //uncut_emerald
    1623, //uncut_sapphire
    1625, //uncut_opal
    1627, //uncut_jade
    1629, //uncut_red_topaz
    1631, //uncut_dragonstone
    434, //clay
    435, //cert_clay
    436, //copper_ore
    437, //cert_copper_ore
    438, //tin_ore
    439, //cert_tin_ore
    440, //iron_ore
    441, //cert_iron_ore
    442, //silver_ore
    443, //cert_silver_ore
    444, //gold_ore
    445, //cert_gold_ore
    446, //perfect_gold_ore
    447, //mithril_ore
    448, //cert_mithril_ore
    449, //adamantite_ore
    450, //cert_adamantite_ore
    451, //runite_ore
    452, //cert_runite_ore
    453, //coal
    454, //cert_coal
    1511, //logs
    1512, //cert_logs
    1513, //magic_logs
    1514, //cert_magic_logs
    1515, //yew_logs
    1516, //cert_yew_logs
    1517, //maple_logs
    1518, //cert_maple_logs
    1519, //willow_logs
    1520, //cert_willow_logs
    1521, //oak_logs
    1522 //cert_oak_logs
];




/**
 * interface interface use operation: 1 - 4
 * interfaceId, itemId, itemSlot, operation
 */
export function interactIF_UseOp(player: Player, intrfce: number, item: number, slot: number, op: number, invId:number = -1): boolean {
    // jagex has if_button1-5
    const com = Component.get(intrfce);
    if (typeof com === 'undefined') {
        console.log('Component undefined');
        return false;
    }
    // port: only an interface the bot has open, as the engine's InvButtonHandler checks a client's
    if (!player.isComponentVisible(com)) {
        return false;
    }
    if(!com.iop || !com.iop.length) {
        console.log('Cannot find com.inventoryOptions');
        return false;
    }

    if (!com.iop[op - 1]) {
        return false;
    }
    let inv = null;

    if(invId == -1) {
        const listener = player.invListeners.find(l => l.com === intrfce);
        if (!listener) {
            console.log('No listener active');
            return false;
        }

        inv = player.getInventoryFromListener(listener);
    } else {
        inv = player.getInventory(invId);
    }

    if (!inv || !inv.validSlot(slot) || !inv.hasAt(slot, item)) {
        console.log('inv or invslot invalid');
        return false;
    }

    if (player.delayed) {
        console.log('Player is busy...');
        return false;
    }

    player.lastItem = item;
    player.lastSlot = slot;

    let trigger: ServerTriggerType;
    if (op === 1) {
        trigger = ServerTriggerType.INV_BUTTON1;
    } else if (op === 2) {
        trigger = ServerTriggerType.INV_BUTTON2;
    } else if (op === 3) {
        trigger = ServerTriggerType.INV_BUTTON3;
    } else if (op === 4) {
        trigger = ServerTriggerType.INV_BUTTON4;
    } else {
        trigger = ServerTriggerType.INV_BUTTON5;
    }

    const script = ScriptProvider.getByTrigger(trigger, intrfce, -1);
    if (script) {
        const root = Component.get(com.rootLayer);

        player.executeScript(ScriptRunner.init(script, player), root.overlay == false);
    } else if (Environment.node.debug) {
        player.messageGame(`No trigger for [${ServerTriggerType.toString(trigger)},${com.comName}]`);
    }

    return true;
}
export function interactHeldOp(player: Player, inv: Inventory, itemId: number, slot: number, op: 1 | 2 | 3 | 4 | 5 | 6): boolean {
    const trigger = (ServerTriggerType.OPHELD1 + (op - 1)) as ServerTriggerType;
    if (!inv || !inv.validSlot(slot) || !inv.hasAt(slot, itemId)) {
        player.clearPendingAction();
        return false;
    }
    const type = ObjType.get(itemId);
    if (player.delayed) {
        return false;
    }
    // port: as the engine's OpHeldHandler: only an option the item has, and the click ends what the bot was about to
    // do (eating stops an attack until the bot clicks its target again, as a player's does)
    if (!type.iop || !type.iop[op - 1]) {
        return false;
    }

    player.lastItem = itemId;
    player.lastSlot = slot;
    player.clearPendingAction();
    player.moveClickRequest = false;
    player.faceEntity = -1;
    player.masks |= player.entitymask;

    const script = ScriptProvider.getByTrigger(trigger, type.id, type.category);
    if (script) {
        player.executeScript(ScriptRunner.init(script, player), true);
    }

    if (op === 1 && itemId === Items.BONES) {
        console.log('BOT burying bone traditionally:', itemId);
        return true;
    }
    return true;
}

/**
 * port (a PKer switched from its dragon dagger to its scimitar kept the dagger's animation): what
 * 274's wear script does after it moves the items, for gear the bots put on by hand (worn.set: a swap while delayed,
 * the PKers' kits, the looks). [proc,update_all] sets the stand and walk animations, the bonuses and the combat varps:
 * %com_attackanim, %com_maxhit and %damagetype, which pvp_melee reads, stayed the old weapon's. With protected access
 * (the attack tab's step resets %autocast_spell, a protected varp) it is the wear script's own call; while the bot is
 * delayed, its other steps, none of which needs it (BotPlayer runs it again on its next tick, whole if it can). `previous` is
 * the weapon held before (-1: none), as the wear script passes it.
 */
export function refreshWorn(player: Player, previous: number): void {
    if (!player.delayed && !player.protect) {
        const script = ScriptProvider.getByName('[proc,update_all]');
        if (script) player.executeScript(ScriptRunner.init(script, player, null, [previous]), true);
        return;
    }
    for (const name of ['update_weight_equipment', 'update_bas', 'update_bonuses', 'update_weight', 'player_combat_stat']) {
        const script = ScriptProvider.getByName(`[proc,${name}]`);
        if (script) player.executeScript(ScriptRunner.init(script, player), false);
    }
}

/**
 * port (the realism work, phase 5a, Track M: high alchemy): a spell cast on an item in the pack, as the client's OPHELDT
 * packet does it and the engine's OpHeldTHandler runs it: the spell's button must be shown (the magic tab) and take a
 * held item, the backpack shown, the item in its slot; then [opheldt,<spell>] runs with protected access (alchemy.rs2
 * checks the level and the runes, takes them, gives the XP and the coins, and holds the caster 3 ticks). False when it
 * could not be clicked; the script may still refuse (its messages say why).
 */
export function interactSpellOnHeld(player: Player, spellComName: string, itemId: number, slot: number): boolean {
    if (player.delayed) return false;
    const spellComId = Component.getId(spellComName);
    const spellCom = spellComId === -1 ? undefined : Component.get(spellComId);
    // (ComActionTarget.HELD: 16)
    if (!spellCom || (spellCom.actionTarget & 16) === 0 || !player.isComponentVisible(spellCom)) return false;
    const pack = Component.get(Component.getId('inventory:inv'));
    if (pack && !player.isComponentVisible(pack)) return false;
    const inv = player.getInventory(InvType.INV);
    if (!inv || !inv.validSlot(slot) || !inv.hasAt(slot, itemId)) return false;
    player.lastItem = itemId;
    player.lastSlot = slot;
    player.clearPendingAction();
    const script = ScriptProvider.getByTrigger(ServerTriggerType.OPHELDT, spellComId, -1);
    if (!script) return false;
    player.executeScript(ScriptRunner.init(script, player), true);
    return true;
}

/**
 * oplocu handler converted -- useful for cooking, smithing,
 */
export function interactUseLocOp(player: Player, loc: Loc, item: number, slot: number): boolean {
    if (_continueDoorWalk(player)) return false;
    if (player.delayed) {
        player.write(new UnsetMapFlag());
        return false;
    }
    const inv = player.getInventory(InvType.INV);
    if (!inv || !inv.validSlot(slot) || !inv.hasAt(slot, item)) {
        player.write(new UnsetMapFlag());
        player.clearPendingAction();
        return false;
    }
    if (!loc) {
        player.write(new UnsetMapFlag());
        player.clearPendingAction();
        return false;
    }
    player.clearPendingAction();
    if (ObjType.get(item).members && !Environment.node.members) {
        player.messageGame("To use this item please login to a members' server.");
        player.write(new UnsetMapFlag());
        return false;
    }
    player.lastUseItem = item;
    player.lastUseSlot = slot;
    _debugStartInteraction(player, 'interactUseLocOp', 'loc', loc.type, `${locDebugName(loc.type)} <- ${itemName(item)}`, loc.x, loc.z, 0);
    player.clearWaypoints(); // port: a click replaces the walk (the engine routes bots to NPCs and players, _routeToLoc to locs)
    if (!_routeToLoc(player, loc)) return false;
    player.setInteraction(Interaction.ENGINE, loc, ServerTriggerType.APLOCU);
    //player.opcalled = true; //<- This is in NetworkPlayer not sure if its needed
    return true;
}

export function interactHeldOpU(player: Player, inv: Inventory, itemId: number, slot: number, useItem: number, useSlot: number): boolean {
    if (player.delayed) {
        return false;
    }
    player.lastItem = itemId;
    player.lastSlot = slot;
    player.lastUseItem = useItem;
    player.lastUseSlot = useSlot;
    if (inv.get(slot)?.id !== itemId || inv.get(useSlot)?.id !== useItem) {
        console.log('Useitem data does not match!', itemId, useItem);
        return false;
    }
    const objType = ObjType.get(player.lastItem);
    const useObjType = ObjType.get(player.lastUseItem);

    player.clearPendingAction();
    player.faceEntity = -1;
    player.masks |= player.entitymask;

    // [opheldu,b]
    let script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, objType.id, -1);

    // [opheldu,a]
    if (!script) {
        script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, useObjType.id, -1);
        [player.lastItem, player.lastUseItem] = [player.lastUseItem, player.lastItem];
        [player.lastSlot, player.lastUseSlot] = [player.lastUseSlot, player.lastSlot];
    }

    // [opheld,b_category]
    const objCategory = objType.category !== -1 ? CategoryType.get(objType.category) : null;
    if (!script && objCategory) {
        script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, -1, objCategory.id);
    }

    // [opheld,a_category]
    const useObjCategory = useObjType.category !== -1 ? CategoryType.get(useObjType.category) : null;
    if (!script && useObjCategory) {
        script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, -1, useObjCategory.id);
        [player.lastItem, player.lastUseItem] = [player.lastUseItem, player.lastItem];
        [player.lastSlot, player.lastUseSlot] = [player.lastUseSlot, player.lastSlot];
    }

    if (script) {
        player.executeScript(ScriptRunner.init(script, player), true);
    }
    return true;
}

/**
 * Convenience wrapper: resolve a component name string to its numeric ID and
 * delegate to interactIfButton.  Returns false if the name is unknown.
 *
 * Usage:
 *   interactIfButtonByName(player, 'multiobj3_close:com_1')
 *   interactIfButtonByName(player, 'multiobj2:objtext1')
 */
export function interactIfButtonByName(player: Player, comName: string): boolean {
    const comId = Component.getId(comName);
    if (comId === -1) return false;
    return interactIfButton(player, comId);
}

//Interface buttons
export function interactIfButton(player: Player, comId: number): boolean {
    const com = Component.get(comId);
    // port: only a component the bot has open, as the engine checks a client's IF_BUTTON (IfButtonHandler). Upstream
    // had the check commented out, and its trading tasks clicked tradeconfirm:accept with the confirm screen not
    // open: that replaced the bot's "accepted" status on the first screen, and the human waited for good.
    if (typeof com === 'undefined' || !player.isComponentVisible(com)) {
        return false;
    }

    player.lastCom = comId;

    if (player.resumeButtons.indexOf(player.lastCom) !== -1) {
        if (player.activeScript && player.activeScript.execution === ScriptState.PAUSEBUTTON) {
            player.executeScript(player.activeScript, true, true);
        }
    } else {
        const root = Component.get(com.rootLayer);

        const script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.IF_BUTTON, comId, -1);
        if (script) {
            player.executeScript(ScriptRunner.init(script, player), root.overlay == false);
        } else if (Environment.node.debug) {
            player.messageGame(`No trigger for [if_button,${com.comName}]`);
        }
    }

    return true;
}



//Player op
/**
 * Usage:
 * @param player - Player from botPlayer
 * @param slot - Target Player PID (Maybe slot in 254?)
 * @param op  - op 1-4
 * op 1 duel
 * op 2 attack
 * op 3 follow
 * op 4 trade
 */
export function interactPlayerOp(player: Player, slot: number, op: number): boolean {
    const other = World.getPlayer(slot);
    if (!other) {
        player.write(new UnsetMapFlag());
        player.clearPendingAction();
        return false;
    }

    let mode: ServerTriggerType;
    if (op === 1) {
        mode = ServerTriggerType.APPLAYER1;
    } else if (op === 2) {
        mode = ServerTriggerType.APPLAYER2;
    } else if (op === 3) {
        mode = ServerTriggerType.APPLAYER3;
    } else {
        mode = ServerTriggerType.APPLAYER4;
    }

    player.clearPendingAction();
    player.clearWaypoints(); // port: a click replaces the walk (the engine routes bots to NPCs and players, _routeToLoc to locs)
    player.setInteraction(Interaction.ENGINE, other, mode);
    return true;
}

/** True if the bot has queued walk steps remaining. */
export function hasWaypoints(player: Player): boolean {
    return player.hasWaypoints();
}

/** True if the bot is currently mid-walk (has waypoints). */
export function isMoving(player: Player): boolean {
    return player.hasWaypoints();
}

/** True if the bot is within `dist` tiles of (x, z) on the same floor. */
export function isNear(player: Player, x: number, z: number, dist: number, level = 0): boolean {
    return player.level === level && Math.abs(player.x - x) <= dist && Math.abs(player.z - z) <= dist;
}

// ── Interactions ──────────────────────────────────────────────────────────────

/**
 * Interact with an NPC using op 1 (e.g. "Talk-to", "Attack").
 * The engine will path the bot to the NPC and fire [opnpc1,npcName].
 */
export function interactNpc(player: Player, npc: Npc): void {
    _debugStartInteraction(player, 'interactNpc', 'npc', npc.type, npcDebugName(npc.type), npc.x, npc.z, 1);
    player.clearPendingAction();
    player.clearWaypoints(); // port: a click replaces the walk (the engine routes bots to NPCs and players, _routeToLoc to locs)
    player.setInteraction(Interaction.ENGINE, npc, ServerTriggerType.APNPC1);
}

/**
 * Interact with an NPC using a specific option number (1-5).
 * op=2 is typically "Trade" for shops.
 */
export function interactNpcOp(player: Player, npc: Npc, op: 1 | 2 | 3 | 4 | 5): void {
    const trigger = (ServerTriggerType.APNPC1 + (op - 1)) as ServerTriggerType;
    _debugStartInteraction(player, 'interactNpcOp', 'npc', npc.type, npcDebugName(npc.type), npc.x, npc.z, op);
    player.clearPendingAction();
    player.clearWaypoints(); // port: a click replaces the walk (the engine routes bots to NPCs and players, _routeToLoc to locs)
    player.setInteraction(Interaction.ENGINE, npc, trigger);
}

export function interactObjOp(player: Player, obj: Obj, op: 1 | 2 | 3 | 4 | 5): void {
    const trigger = (ServerTriggerType.APOBJ1 + (op - 1)) as ServerTriggerType;

    player.clearPendingAction();
    player.clearWaypoints(); // port: a click replaces the walk (the engine routes bots to NPCs and players, _routeToLoc to locs)
    player.setInteraction(Interaction.ENGINE, obj, trigger);

    // port: a client sends its route to the item with the click, and the server walks a player (clientRoutefinder,
    // as in 274's default world config) only along that route: for an obj it computes none, so a bot that was not
    // already on the item's tile got "I can't reach that!" (the knife pickup never worked)
    if (player.x !== obj.x || player.z !== obj.z) {
        const path = pathBudgetLeft(player) > 0 ? botWalkPath(player.level, player.x, player.z, obj.x, obj.z) : new Uint32Array(0);
        if (path.length > 0) player.queueWaypoints(path);
        else player.queueWaypoint(obj.x, obj.z);
    }

    if (op === 1) {
        // could later add anti-misclick, loot priority, etc.
    }
}

//Ground items
//Ground items
function _findObj(player: Player, cx: number, cz: number, level: number, radius: number, predicate: (obj: Obj) => boolean): Obj | null {
    let best: Obj | null = null;
    let bestDist = Infinity;
    const zoneRadius = Math.ceil(radius / 8) + 1;
    for (let dz = -zoneRadius; dz <= zoneRadius; dz++) {
        for (let dx = -zoneRadius; dx <= zoneRadius; dx++) {
            const zx = cx + dx * 8;
            const zz = cz + dz * 8;
            const zone = getWorld().gameMap.getZone(zx, zz, level);
            if (!zone) continue;
            for (const obj of zone.getAllObjsSafe()) {
                if (!predicate(obj)) continue;
                if (obj.receiver64 === Obj.NO_RECEIVER || obj.receiver64 === player.hash64) {
                    //<- added this
                    const dist = Math.abs(obj.x - cx) + Math.abs(obj.z - cz);
                    if (dist <= radius * 2 && dist < bestDist) {
                        bestDist = dist;
                        best = obj;
                    }
                }
            }
        }
    }
    return best;
}
export function findObjByPrefix(player: Player, cx: number, cz: number, level: number, prefix: string, radius = 20): Obj | null {
    return _findObj(player, cx, cz, level, radius, obj => {
        const t = ObjType.get(obj.type);
        return !!t.debugname?.startsWith(prefix);
    });
}
export function findObjNear(player: Player, cx: number, cz: number, level: number, objTypeId: number, radius = 10): Obj | null {
    return _findObj(player, cx, cz, level, radius, obj => obj.type === objTypeId);
}
export function findObjByName(player: Player, cx: number, cz: number, level: number, objName: string, radius = 10): Obj | null {
    const typeId = ObjType.getId(objName);
    if (typeId === -1) return null;
    return findObjNear(player, cx, cz, level, typeId, radius);
}

export function findAnyObj(player: Player, cx: number, cz: number, level: number, radius = 1): Obj | null {
    return _findObj(player, cx, cz, level, radius, () => true);
}

/**
 * Find lootable ground objects (monster drops, items that will despawn).
 * Excludes static/world items that have FOREVER lifecycle.
 */
export function findLootObj(player: Player, cx: number, cz: number, level: number, radius = 1, accept?: (obj: Obj) => boolean): Obj | null {
    return _findObj(player, cx, cz, level, radius, obj => {
        return obj.lifecycle === EntityLifeCycle.DESPAWN && (!accept || accept(obj));
    });
}

/**
 * Interact with a Loc using op 1 (e.g. "Chop", "Mine", "Fish").
 * The engine will path the bot adjacent to the Loc and fire [oploc1,locName].
 */
export function interactLoc(player: Player, loc: Loc): void {
    if (_continueDoorWalk(player)) return;
    _debugStartInteraction(player, 'interactLoc', 'loc', loc.type, locDebugName(loc.type), loc.x, loc.z, 1);
    player.clearPendingAction();
    player.clearWaypoints(); // port: a click replaces the walk (the engine routes bots to NPCs and players, _routeToLoc to locs)
    if (!_routeToLoc(player, loc)) return;
    player.setInteraction(Interaction.ENGINE, loc, ServerTriggerType.APLOC1);
}

/**
 * port: the route to the loc that a client sends with the click (BotPathing.botPathToLoc): 274 walks a player to a loc
 * only along that route. Upstream sent none, so a bot not already standing where it could use the loc got "I can't
 * reach that!" (test/sim.mjs: cooks at ranges, miners at rocks, the castle stairs). With no way there but through a
 * closed door, the bot opens the door nearest the loc first, as a player would, and returns false: the click comes
 * again once the door is open (the stairs to Lumbridge castle's spinning wheel are behind one). With no way at all it
 * walks as near as it can, as a client's route does.
 */
function _routeToLoc(player: Player, loc: Loc): boolean {
    const forceapproach = LocType.get(loc.type).forceapproach;
    if (botReachedLoc(player.level, player.x, player.z, loc.x, loc.z, loc.width, loc.length, loc.angle, loc.shape, forceapproach)) return true;
    let path = botPathToLoc(player.level, player.x, player.z, loc.x, loc.z, loc.width, loc.length, loc.angle, loc.shape, forceapproach, false);
    if (path.length === 0) {
        if (_openDoorToward(player, loc.x, loc.z, loc) !== 'none') return false;
        path = botPathToLoc(player.level, player.x, player.z, loc.x, loc.z, loc.width, loc.length, loc.angle, loc.shape, forceapproach, true);
    }
    if (path.length > 0) player.queueWaypoints(path);
    return true;
}

/**
 * Interact with a Loc using a specific option number (1-5).
 */
export function interactLocOp(player: Player, loc: Loc, op: 1 | 2 | 3 | 4 | 5): void {
    if (_continueDoorWalk(player)) return;
    const trigger = (ServerTriggerType.APLOC1 + (op - 1)) as ServerTriggerType;
    _debugStartInteraction(player, 'interactLocOp', 'loc', loc.type, locDebugName(loc.type), loc.x, loc.z, op);
    player.clearPendingAction();
    player.clearWaypoints(); // port: a click replaces the walk (the engine routes bots to NPCs and players, _routeToLoc to locs)
    if (!_routeToLoc(player, loc)) return;
    player.setInteraction(Interaction.ENGINE, loc, trigger);
}

// ── World search ──────────────────────────────────────────────────────────────

/**
 * Search zones around (cx, cz) for a live NPC matching npcTypeId.
 * Returns the closest one found within `radius` tiles, or null.
 */
export function findNpcNear(cx: number, cz: number, level: number, npcTypeId: number, radius = 10): Npc | null {
    return _findNpc(cx, cz, level, radius, npc => npc.type === npcTypeId);
}

/**
 * Search zones around (cx, cz) for a live NPC whose debug name matches.
 */
export function findNpcByName(cx: number, cz: number, level: number, npcName: string, radius = 10): Npc | null {
    const typeId = NpcType.getId(npcName);
    if (typeId === -1) return null;
    return findNpcNear(cx, cz, level, typeId, radius);
}

/**
 * Like findNpcByName but skips a specific NPC (by nid) so the bot can cycle
 * through multiple targets instead of always locking onto the same one.
 * Falls back to any matching NPC if no alternative is found.
 */
export function findNpcByNameExcluding(cx: number, cz: number, level: number, npcName: string, excludeNid: number, radius = 10): Npc | null {
    const typeId = NpcType.getId(npcName);
    if (typeId === -1) return null;
    const alt = findNpcFiltered(cx, cz, level, npc => npc.type === typeId && npc.nid !== excludeNid, radius);
    return alt ?? findNpcNear(cx, cz, level, typeId, radius);
}

/**
 * Search zones around (cx, cz) for a live Loc (object in the world) matching locTypeId.
 * Returns the closest one found within `radius` tiles, or null.
 */
export function findLocNear(cx: number, cz: number, level: number, locTypeId: number, radius = 10): Loc | null {
    return _findLoc(cx, cz, level, radius, loc => loc.type === locTypeId);
}

/**
 * Search zones around (cx, cz) for a live Loc whose debug name matches.
 */
export function findLocByName(cx: number, cz: number, level: number, locName: string, radius = 10): Loc | null {
    const typeId = LocType.getId(locName);
    if (typeId === -1) return null;
    return findLocNear(cx, cz, level, typeId, radius);
}

/**
 * Search for a live Loc whose debug name matches and satisfies a caller predicate.
 */
export function findLocByNameWhere(
    cx: number,
    cz: number,
    level: number,
    locName: string,
    radius: number,
    predicate: (loc: Loc) => boolean
): Loc | null {
    const typeId = LocType.getId(locName);
    if (typeId === -1) return null;
    return _findLoc(cx, cz, level, radius, loc => loc.type === typeId && predicate(loc));
}

/**
 * Search for any Loc whose type name starts with a prefix.
 * Optional exclude: substring that must NOT appear in the debugname.
 */
export function findLocByPrefix(cx: number, cz: number, level: number, prefix: string, radius = 10, exclude?: string): Loc | null {
    return _findLoc(cx, cz, level, radius, loc => {
        const name = LocType.get(loc.type).debugname;
        if (!name?.startsWith(prefix)) return false;
        if (exclude && name.includes(exclude)) return false;
        return true;
    });
}

/**
 * Same as findLocByPrefix, but also requires a caller predicate to pass —
 * e.g. "not already claimed by another bot" (see claimLoc/isLocClaimed in
 * BotTaskBase.ts) so multiple bots searching from nearby tiles don't all
 * deterministically land on the exact same nearest resource node.
 */
export function findLocByPrefixWhere(cx: number, cz: number, level: number, prefix: string, radius: number, predicate: (loc: Loc) => boolean, exclude?: string): Loc | null {
    return _findLoc(cx, cz, level, radius, loc => {
        const name = LocType.get(loc.type).debugname;
        if (!name?.startsWith(prefix)) return false;
        if (exclude && name.includes(exclude)) return false;
        return predicate(loc);
    });
}

/**
 * Search for any NPC whose type name starts with a prefix.
 */
export function findNpcByPrefix(cx: number, cz: number, level: number, prefix: string, radius = 20): Npc | null {
    return _findNpc(cx, cz, level, radius, npc => {
        const t = NpcType.get(npc.type);
        return !!t.debugname?.startsWith(prefix);
    });
}

/**
 * Raw NPC search with a caller-supplied predicate.
 * Use this when you need combined type + combat-state + exclusion-set filtering
 * that the named helpers cannot express in a single call.
 */
export function findNpcFiltered(cx: number, cz: number, level: number, predicate: (npc: Npc) => boolean, radius = 22): Npc | null {
    return _findNpc(cx, cz, level, radius, predicate);
}

/**
 * Returns true if the NPC's debug name matches the given string by exact type
 * name first, then by prefix — the same two-step check used inside the combat
 * target search routines.
 */
export function npcMatchesName(npc: Npc, name: string): boolean {
    const typeId = NpcType.getId(name);
    if (typeId !== -1 && npc.type === typeId) return true;
    return !!NpcType.get(npc.type).debugname?.startsWith(name);
}

// ── Internal zone search ──────────────────────────────────────────────────────

function _findNpc(cx: number, cz: number, level: number, radius: number, predicate: (npc: Npc) => boolean): Npc | null {
    let best: Npc | null = null;
    let bestDist = Infinity;

    const zoneRadius = Math.ceil(radius / 8) + 1;
    for (let dz = -zoneRadius; dz <= zoneRadius; dz++) {
        for (let dx = -zoneRadius; dx <= zoneRadius; dx++) {
            const zx = cx + dx * 8;
            const zz = cz + dz * 8;
            const zone = getWorld().gameMap.getZone(zx, zz, level);
            if (!zone) continue;
            for (const npc of zone.getAllNpcsSafe()) {
                // port: the distance first, the predicate only for an NPC that would be the nearest so far
                const dist = Math.abs(npc.x - cx) + Math.abs(npc.z - cz);
                if (dist > radius * 2 || dist >= bestDist || !predicate(npc)) continue;
                bestDist = dist;
                best = npc;
            }
        }
    }
    return best;
}

function _findLoc(cx: number, cz: number, level: number, radius: number, predicate: (loc: Loc) => boolean): Loc | null {
    let best: Loc | null = null;
    let bestDist = Infinity;

    const zoneRadius = Math.ceil(radius / 8) + 1;
    for (let dz = -zoneRadius; dz <= zoneRadius; dz++) {
        for (let dx = -zoneRadius; dx <= zoneRadius; dx++) {
            const zx = cx + dx * 8;
            const zz = cz + dz * 8;
            const zone = getWorld().gameMap.getZone(zx, zz, level);
            if (!zone) continue;
            for (const loc of zone.getAllLocsSafe()) {
                // port: the distance first, the caller's predicate only for a loc that would be the nearest so far
                const dist = Math.abs(loc.x - cx) + Math.abs(loc.z - cz);
                if (dist > radius * 2 || dist >= bestDist) continue;
                if (!predicate(loc)) continue;
                bestDist = dist;
                best = loc;
            }
        }
    }
    return best;
}

/** port: is there a loc on (x, z) (a fire, a tree, furniture: a fire cannot be lit there)? */
export function hasLocAt(x: number, z: number, level: number): boolean {
    const zone = getWorld().gameMap.getZone(x, z, level);
    if (!zone) return false;
    for (const loc of zone.getAllLocsSafe()) {
        // (the ground layer, as 274's map_locaddunsafe: centrepieces and roofs; not walls, wall decoration or ground decoration)
        if (loc.x === x && loc.z === z && loc.shape >= LocShape.CENTREPIECE_STRAIGHT && loc.shape !== LocShape.GROUND_DECOR) return true;
    }
    return false;
}

// ── Skills ────────────────────────────────────────────────────────────────────

export function getLevel(player: Player, stat: PlayerStat): number {
    return player.levels[stat];
}

export function getBaseLevel(player: Player, stat: PlayerStat): number {
    return player.baseLevels[stat];
}

export function getXp(player: Player, stat: PlayerStat): number {
    return player.stats[stat];
}

export function addXp(player: Player, stat: PlayerStat, xp: number): void {
    player.addXp(stat, xp);
    try {
        const botName = _debugBotName(player);
        if (botName) BotDebugService.noteXpGain(botName, stat, player.stats[stat]);
    } catch {
        // debug hook must never affect gameplay
    }
}

/**
 * Sets the player's melee combat mode (com_mode varp).
 */
export function setCombatStyle(player: Player, style: 0 | 1 | 2 | 3): void {
    const varp = VarPlayerType.getByName('com_mode');
    if (varp) player.setVar(varp.id, style);
}

/**
 * Enables autocast for an arbitrary combat spell.
 * Sets autocast_spell = the spell's varp value (see
 * content/scripts/skill_combat/configs/magic/spells.constant, e.g. 51 =
 * ^wind_strike, 4 = ^wind_bolt, 8 = ^wind_blast, 12 = ^wind_wave) and
 * attackstyle_magic = 3 (autocast toggle on).
 */
export function setAutocastSpell(player: Player, autocastVarp: number): void {
    const spellVarp = VarPlayerType.getByName('autocast_spell');
    if (spellVarp) player.setVar(spellVarp.id, autocastVarp);

    const styleVarp = VarPlayerType.getByName('attackstyle_magic');
    if (styleVarp) player.setVar(styleVarp.id, 3); // 3 = spell chosen + autocast enabled
}

/** Enables autocast wind strike specifically — kept for callers that only ever need the base spell. */
export function setAutocastWindStrike(player: Player): void {
    setAutocastSpell(player, 51); // 51 = ^wind_strike
}

// ── Inventory ─────────────────────────────────────────────────────────────────

export function getBackpack(player: Player) {
    return player.getInventory(InvType.INV);
}

export function isInventoryFull(player: Player): boolean {
    const inv = getBackpack(player);
    return inv ? inv.freeSlotCount === 0 : false;
}

export function freeSlots(player: Player): number {
    const inv = getBackpack(player);
    return inv ? inv.freeSlotCount : 0;
}

export function countItem(player: Player, itemId: number): number {
    const inv = getBackpack(player);
    if (!inv) return 0;
    let total = 0;
    for (const item of inv.items) {
        if (item && item.id === itemId) total += item.count;
    }
    return total;
}

export function addItem(player: Player, itemId: number, count = 1): boolean {
    const inv = getBackpack(player);
    if (!inv) return false;
    const before = countItem(player, itemId);
    const success = invAddAll(inv, itemId, count);
    try {
        const botName = _debugBotName(player);
        if (botName) {
            const after = countItem(player, itemId);
            BotDebugService.event(botName, 'inventory', `addItem ${itemName(itemId)} x${count}: ${success ? 'ok' : 'FAILED'} (${before} -> ${after})`, { itemId, count, before, after, success });
        }
    } catch {
        // debug hook must never affect gameplay
    }
    return success;
}

export function removeItem(player: Player, itemId: number, count = 1): boolean {
    const inv = getBackpack(player);
    if (!inv) return false;
    const before = countItem(player, itemId);
    const success = inv.remove(itemId, count) >= count;
    try {
        const botName = _debugBotName(player);
        if (botName) {
            const after = countItem(player, itemId);
            BotDebugService.event(botName, 'inventory', `removeItem ${itemName(itemId)} x${count}: ${success ? 'ok' : 'FAILED'} (${before} -> ${after})`, { itemId, count, before, after, success });
        }
    } catch {
        // debug hook must never affect gameplay
    }
    return success;
}

export function clearBackpack(player: Player): void {
    getBackpack(player)?.removeAll();
}

/**
 * Directly picks up a ground object into the player's backpack,
 * bypassing the engine interaction / script system entirely.
 * Returns true if the item was added and the obj removed from the world.
 */
export function pickupGroundItem(player: Player, obj: Obj): boolean {
    if (!obj.isValid()) return false;

    const inv = getBackpack(player);
    if (!inv) return false;

    if (!invAddAll(inv, obj.type, obj.count)) return false;

    getWorld().removeObj(obj, -1);
    return true;
}

export function hasItem(player: Player, itemId: number, count = 1): boolean {
    return countItem(player, itemId) >= count;
}

export function getCombatLevel(player: Player): number {
    return player.combatLevel;
}

export function interactUseObjNpcOp(player: Player, npcu: Npc, item: number, slot: number): boolean {
    const nid = npcu?.nid;

    if (player.delayed) {
        player.write(new UnsetMapFlag());
        return false;
    }

    const inv = player.getInventory(InvType.INV);
    if (!inv || !inv.validSlot(slot) || !inv.hasAt(slot, item)) {
        player.write(new UnsetMapFlag());
        player.clearPendingAction();
        return false;
    }

    const npc = World.getNpc(nid);
    if (!npc || npc.delayed) {
        player.write(new UnsetMapFlag());
        player.clearPendingAction();
        return false;
    }

    if (!rsbuf.hasNpc(player.slot, npc.nid)) {
        player.write(new UnsetMapFlag());
        player.clearPendingAction();
        return false;
    }

    player.clearPendingAction();
    if (ObjType.get(item).members && !Environment.node.members) {
        player.messageGame("To use this item please login to a members' server.");
        player.write(new UnsetMapFlag());
        return false;
    }

    player.lastUseItem = item;
    player.lastUseSlot = slot;

    player.clearWaypoints(); // port: a click replaces the walk (the engine routes bots to NPCs and players, _routeToLoc to locs)
    player.setInteraction(Interaction.ENGINE, npc, ServerTriggerType.APNPCU);
    return true;
}

/**
 * Bot-safe variant of interactUseObjNpcOp.
 *
 * Identical to interactUseObjNpcOp except the rsbuf.hasNpc() check is omitted.
 * Bots are server-side entities with no client zone-send buffer, so hasNpc()
 * always returns false for them and would silently block every interaction.
 * All other guards (player.delayed, valid slot, npc exists, members check)
 * are preserved.
 */
export function botInteractUseObjNpc(player: Player, npc: Npc, item: number, slot: number): boolean {
    const inv = player.getInventory(InvType.INV);
    if (!npc || !inv || !inv.validSlot(slot) || !inv.hasAt(slot, item)) {
        //Add a console.log to check?
        player.write(new UnsetMapFlag());
        player.clearPendingAction();
        return false;
    }

    const live = World.getNpc(npc.nid);
    if (!live) {
        //Add a console.log to check?
        player.write(new UnsetMapFlag());
        player.clearPendingAction();
        return false;
    }

    player.clearPendingAction();
    if (ObjType.get(item).members && !Environment.node.members) {
        player.messageGame("To use this item please login to a members' server.");
        player.write(new UnsetMapFlag());
        return false;
    }

    player.lastUseItem = item;
    player.lastUseSlot = slot;
    player.clearWaypoints(); // port: a click replaces the walk (the engine routes bots to NPCs and players, _routeToLoc to locs)
    player.setInteraction(Interaction.ENGINE, live, ServerTriggerType.APNPCU);
    return true;
}

/**
 * Compute the combat level of an NPC from its stat block.
 * Formula mirrors the RS2 visible combat level:
 *   floor((defence + hitpoints) * 0.25 + (attack + strength) * 0.325)
 */
export function getNpcCombatLevel(npc: Npc): number {
    const t = NpcType.get(npc.type);
    const atk = t.stats[0]; // NpcStat.ATTACK
    const def = t.stats[1]; // NpcStat.DEFENCE
    const str = t.stats[2]; // NpcStat.STRENGTH
    const hp = t.stats[3]; // NpcStat.HITPOINTS
    return Math.max(1, Math.floor((def + hp) * 0.25 + (atk + str) * 0.325));
}

/**
 * Find any NPC within `radius` tiles that is currently targeting `player`.
 * Used by CombatTask to detect aggressive NPCs the bot did not initiate combat with.
 */
/** port: the last answers per bot and radius (the search reads up to 49 zones, and tasks ask every tick) */
const aggressorCache = new WeakMap<Player, Map<number, { tick: number; npc: Npc | null }>>();

/**
 * port: does this NPC act on the player it targets (its [ai_opplayerN] or [ai_applayerN] script: an attack)? An NPC
 * also targets a player it runs from (274's cowardly giant spiders: PLAYERESCAPE), follows or faces; upstream took
 * those for attackers, and its skilling bots fled from spiders that were running from them.
 */
function actsOn(npc: Npc, player: Player): boolean {
    return npc.target === player && npc.targetOp >= NpcMode.OPPLAYER1 && npc.targetOp <= NpcMode.APPLAYER5;
}

export function findAggressorNpc(player: Player, radius = 10): Npc | null {
    // port: an answer from the last 3 ticks stands while that NPC still targets the bot (a new attacker is seen at most
    // 2 ticks late)
    const now = World.currentTick;
    let byRadius = aggressorCache.get(player);
    if (!byRadius) aggressorCache.set(player, (byRadius = new Map()));
    const last = byRadius.get(radius);
    if (last && now - last.tick < 3 && (last.npc === null || actsOn(last.npc, player))) return last.npc;
    const npc = _findNpc(player.x, player.z, player.level, radius, npc => actsOn(npc, player));
    byRadius.set(radius, { tick: now, npc });
    return npc;
}

/** port: an NPC other than `except` that attacks the player (a second attacker: a multi-combat area's), or null */
export function findOtherAggressorNpc(player: Player, except: Npc | null, radius = 8): Npc | null {
    return _findNpc(player.x, player.z, player.level, radius, npc => npc !== except && actsOn(npc, player));
}

/**
 * Search for any NPC whose debugname ends with a given suffix.
 */
export function findNpcBySuffix(cx: number, cz: number, level: number, suffix: string, radius = 20, where?: (npc: Npc) => boolean): Npc | null {
    return _findNpc(cx, cz, level, radius, npc => {
        const t = NpcType.get(npc.type);
        return !!t.debugname?.endsWith(suffix) && (!where || where(npc));
    });
}

/**
 * Has item equipped (itemId)
 * @param player
 * @param itemId
 * @private
 */
export function _wornContains(player: Player, itemId: number): boolean {
    const equip = player.getInventory(InvType.WORN);
    if (!equip) return false;

    for (let slot = 0; slot < equip.capacity; slot++) {
        const item = equip.get(slot);
        if (!item) continue;
        if (item.id === itemId) return true;
    }

    return false;
}

function _getWearSlot(oType: ObjType): number | null {
    return oType.wearpos ?? oType.wearpos2 ?? oType.wearpos3 ?? null;
}
function _getEquippedItem(player: Player, slotId: number) {
    const equip = player.getInventory(InvType.WORN);
    if (!equip) return null;

    return equip.get(slotId);
}

function _getTier(name?: string | null): number {
    if (!name) return 0;

    name = name.toLowerCase();

    if (name.includes('dragon')) return 6;
    if (name.includes('rune') || name.includes('giant')) return 5; //<- remove giant for something else, its a custom easter weapon
    if (name.includes('adamant')) return 4;
    if (name.includes('mithril')) return 3;
    if (name.includes('black')) return 2;
    if (name.includes('steel')) return 1;
    if (name.includes('iron')) return 0;
    if (name.includes('bronze')) return 0;
    return -1;
}

export function _isUpgrade(newItem: ObjType, currentItem: ObjType | null): boolean {
    if (!currentItem) return true;

    const newTier = _getTier(newItem.name);
    const currentTier = _getTier(currentItem.name);

    // port (the realism work, phase 4): iron over bronze (both tier 0: a bought iron piece never went on over bronze);
    // not the quiver's (RangedMagicTask picks its arrows)
    if (newTier === 0 && currentTier === 0) return newItem.wearpos !== 13 && /iron/i.test(newItem.name ?? '') && /bronze/i.test(currentItem.name ?? '');
    return newTier > currentTier;
}

export function _equipLoot(player: Player): void {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return;

    for (let slot = 0; slot < inv.capacity; slot++) {
        const item = inv.get(slot);
        if (!item) continue;
        // port (the realism work, phase 4): the wardrobe's items (hats, aprons, capes and the other accessories, rares,
        // holiday items) go on by port/BotGear's rules, not by a metal in their name ("Black wizard hat" read as black
        // armour went back on over the bot's helm at every bank trip)
        if (isWardrobeItem(item.id)) continue;
        const oType = ObjType.get(item.id);
        const wearSlot = _getWearSlot(oType);
        if (wearSlot === null) continue;

        const equipped = _getEquippedItem(player, wearSlot);
        const equippedType = equipped ? ObjType.get(equipped.id) : null;

        // port (the variety work, round 1, track W: BUG-a, the wear track's report): only a melee weapon (by its metal,
        // port/BotOutfits) and an armour piece (port/BotLooks) count as an upgrade. The names' metals did: a dark
        // wizard's looted "Black robe" was black armour and went on over an iron platebody, which never came back; a
        // "Dragonhide body" was dragon; and a woodcutter's "Rune axe" was a rune weapon, wielded over its scimitar
        if (wearSlot === 3) {
            const weapon = meleeWeaponOf(item.id);
            if (!weapon || player.baseLevels[0] < WEAPON_ATTACK[weapon.tier]) continue;
            const held = equipped ? meleeWeaponOf(equipped.id) : undefined;
            if (held && held.tier >= weapon.tier) continue;
        } else if (wearSlot === 0 || wearSlot === 4 || wearSlot === 5 || wearSlot === 7) {
            const piece = armourPieceOf(item.id);
            if (!piece || piece.tier < 0 || !canWearPiece(piece, player.baseLevels[1])) continue;
            const on = equipped ? armourPieceOf(equipped.id) : undefined;
            if (on && on.tier >= piece.tier) continue;
            // (the variety work, round 2, the fixes: a Wilderness trip's anti-dragon shield stays on: port/BotWildTrips)
            if (wearSlot === 5 && equipped && isDragonShield(equipped.id)) continue;
            // port (the realism work, phase 4): no helm over a rare or the bunny ears (port/BotLooks: a signature hat)
            if (wearSlot === 0 && equipped && isSignatureHat(equipped.id)) continue;
        } else if (wearSlot === 13) {
            //Ammo
            //Bronze - Rune can be tiered
            if (!_isUpgrade(oType, equippedType) || _getTier(oType.name) === -1) continue;
        } else {
            // capes, amulets, gloves, boots, rings: by port/BotGear's rules (a cape's colour is no upgrade)
            continue;
        }

        if (!_wornContains(player, item.id)) {
            if (interactHeldOp(player, inv, item.id, slot, 2)) {
                //item equipped
            }
        }
    }
}

//Simple varp getting using both id and name as a fallback if they don't match
export function setVarp(player: Player, varpName: string, varpId: number, varpValue: number) {
    const varp = VarPlayerType.get(varpId);
    const varpN = VarPlayerType.getByName(varpName);
    if (varp) {
        if (varpN) {
            if (varpId != varpN.id) {
                //varpId doesn't match use name preferably
                player.setVar(varpN.id, varpValue);
                return;
            }
        } else {
            console.log("Warning: can't find varp name: " + varpName);
        }
        player.setVar(varp.id, varpValue);
    } else {
        console.log("Error: can't find varp id: " + varpId);
    }
}

/**
 * Scan within `radius` tiles for any loc with an option that matches keyword.
 * If already adjacent to the loc, find which specific option number matches
 * the keyword and interact with it. If not yet adjacent, path to the loc.
 *
 * Returns true if an obstruction was found (interaction queued or walk started).
 */
/** port: does the loc have this op (lower case)? */
function _hasOp(loc: Loc, keyword: string): boolean {
    return (LocType.get(loc.type).op ?? []).some(o => typeof o === 'string' && o.toLowerCase() === keyword);
}

/**
 * port: clicks the nearest loc within `radius` with this op ('climb-down': a dungeon's ladder); false when there is none.
 */
export function climbNearby(player: Player, keyword: 'climb-up' | 'climb-down', radius: number): boolean {
    return interactNearbyLocByOps(player, keyword, radius);
}

function interactNearbyLocByOps(player: Player, keyword: string, radius = 30): boolean {
    const loc = _findLoc(player.x, player.z, player.level, radius, loc => {
        const t = LocType.get(loc.type);
        const ops = (t.op ?? []).filter((o): o is string => typeof o === 'string').map(o => o.toLowerCase());
        return ops.some(op => op === keyword);
    });
    if (!loc) return false;

    // port: the engine walks the bot to it (BotManager: bots route to what they click), so it is clicked from afar too
    // (upstream searched a path to the loc's own, blocked, tile first); and a click it is already walking to is not
    // repeated. The op is counted in the full list: upstream counted it after dropping the empty ops, off by one for
    // a loc whose first op is empty
    if (player.target === loc) return true;
    const t = LocType.get(loc.type);
    let op = 1 + (t.op ?? []).findIndex(o => typeof o === 'string' && o.toLowerCase() === keyword);
    if (op < 1) op = 1;
    interactLocOp(player, loc, op as 1 | 2 | 3 | 4 | 5);
    return true;
}

// ── Gate handling ─────────────────────────────────────────────────────────────

/**
 * port (the variety work, round 1, the fixes): does the bot reach this loc from where it stands (274's reach: no wall or
 * fence between)? isAdjacentToLoc measures the tiles only: a woodcutter by the members' fence east of Varrock was
 * "adjacent" to the trees past it and clicked them ("I can't reach that!" 120 times an hour from a fletcher)
 */
export function inReachOfLoc(player: Player, loc: Loc): boolean {
    const t = LocType.get(loc.type);
    return botReachedLoc(player.level, player.x, player.z, loc.x, loc.z, t.width, t.length, loc.angle, loc.shape, t.forceapproach);
}

/**
 * port (the variety work, round 1, the fixes): does a route take the bot to where it reaches this loc, doors as they are
 * now ('yes'), or not ('no': a shut door or a wall between), or are the tick's searches spent ('wait')? One search.
 */
export function locInRoute(player: Player, loc: Loc): 'yes' | 'no' | 'wait' {
    if (inReachOfLoc(player, loc)) return 'yes';
    if (pathBudgetLeft(player) === 0) {
        _waitedForBudget(player);
        return 'wait';
    }
    const t = LocType.get(loc.type);
    const path = botPathToLoc(player.level, player.x, player.z, loc.x, loc.z, t.width, t.length, loc.angle, loc.shape, t.forceapproach, false);
    if (path.length === 0) return 'no';
    const last = path[path.length - 1];
    return botReachedLoc(player.level, (last >> 14) & 0x3fff, last & 0x3fff, loc.x, loc.z, t.width, t.length, loc.angle, loc.shape, t.forceapproach) ? 'yes' : 'no';
}

/**
 * Returns true if the bot is standing adjacent (within 1 tile of any face)
 * of the given loc, accounting for the loc's width and length.
 */
export function isAdjacentToLoc(player: Player, loc: { x: number; z: number; type: number }): boolean {
    const t = LocType.get(loc.type);
    const w = t.width ?? 1;
    const l = t.length ?? 1;
    const dx = Math.max(0, Math.max(loc.x - player.x, player.x - (loc.x + w - 1)));
    const dz = Math.max(0, Math.max(loc.z - player.z, player.z - (loc.z + l - 1)));
    return dx <= 1 && dz <= 1 && dx + dz <= 1;
}

/**
 * Open-action keywords (lowercased) that indicate a closed/passable door or gate.
 * Covers standard "Open", toll gates ("Pay-toll(10gp)"), walk-through doors,
 * and Al Kharid palace curtains (loc_1528: op1="Open").
 */
const GATE_OPEN_KEYWORDS = ['open', 'pay', 'pay-toll', 'walk-through', 'pass-through', 'enter'];
const GATE_CLOSE_KEYWORDS = ['close', 'shut'];

/** Loc debug-name prefixes that represent closeable barriers (curtains, etc.). */
const BARRIER_NAME_PREFIXES = ['loc_1528']; // Al Kharid palace curtain (closed state)

/** Big door prefixes - large double doors that also need opening */
const BIG_DOOR_PREFIXES = ['big door', 'large door', 'double door'];

/**
 * Substrings of loc debugnames that are NEVER gates — purely decorative objects.
 * These are excluded so bots don't try to "open" or interact with them while
 * navigating past them (e.g. picking flowers at Varrock West Bank).
 */
const DECORATIVE_LOC_FRAGMENTS = ['flower', 'fern', 'plant', 'bush', 'thistle', 'nettle', 'cabbage', 'tulip', 'daisy', 'sunflower', 'chest', 'open chest', 'closed chest'];

/**
 * Directly executes the OPLOC1 script for a gate/door Loc.
 *
 * This bypasses processInteraction, which fails for Locs because:
 *   - pathToPathingTarget() is a no-op for non-PathingEntity targets (Locs)
 *   - tryInteract(false) fires first and hits the "default approach" branch,
 *     setting apRange=-1 and returning false without moving the player
 *   - With no waypoints and no steps taken, "I can't reach that!" fires and
 *     clears the interaction before tryInteract(true) ever gets a chance to run
 *
 * This replicates exactly what tryInteract(true) does when inOperableDistance:
 *   getOpTrigger() → ScriptProvider.getByTrigger(targetOp + 7, ...) i.e. OPLOC1
 *   executeScript(ScriptRunner.init(script, player, gate), true)
 *
 * Returns true if an OPLOC1 script was found and executed.
 */
function _executeGateScript(player: Player, gate: Loc): boolean {
    const locType = LocType.get(gate.type);
    const script = ScriptProvider.getByTrigger(ServerTriggerType.OPLOC1, gate.type, locType.category);
    if (!script) return false;
    player.clearPendingAction();
    player.executeScript(ScriptRunner.init(script, player, gate), true);
    return true;
}

/**
 * Walks toward a gate/door using plain waypoints (botWalkPath / botFindPath).
 * Does NOT call _pathTowards — that function calls openNearbyGate internally
 * which would create mutual recursion.
 */
function _walkToGate(player: Player, gate: Loc): boolean {
    // port: one search (botFindPath cannot succeed where botWalkPath did not), within the per-tick budget
    if (pathBudgetLeft(player) === 0) return false;
    const path = botWalkPath(player.level, player.x, player.z, gate.x, gate.z);
    if (path.length > 0) {
        player.clearPendingAction();
        player.queueWaypoints(path);
        return true;
    }
    return false;
}

/** port: doors each bot found shut after opening them (locked, members' only, one way): door key → tick until which
 * it is passed over */
const shutDoors = new WeakMap<Player, Map<number, number>>();
/** port: the door each bot opened last, and when */
const lastDoorOpened = new WeakMap<Player, [number, number]>();
const SHUT_DOOR_TICKS = 500;
/** port: the door a bot is walking to (_openDoorToward), and the tick it gives up */
const doorWalks = new WeakMap<Player, { door: Loc; until: number }>();

/**
 * port: a bot on its way to a door goes on to it and opens it there, before any other walk or click: upstream's next
 * walk (its route as near to the target as it got) took it straight back, and a bot circled Lumbridge castle for good.
 * True while the door keeps it busy this tick.
 */
function _continueDoorWalk(player: Player): boolean {
    const walk = doorWalks.get(player);
    if (!walk) return false;
    const { door } = walk;
    if (World.currentTick > walk.until || !(_isWeb(door) || _isClosedGate(door)) || player.level !== door.level) {
        doorWalks.delete(player);
        return false;
    }
    if (botReachedLoc(player.level, player.x, player.z, door.x, door.z, door.width, door.length, door.angle, door.shape, LocType.get(door.type).forceapproach)) {
        doorWalks.delete(player);
        lastDoorOpened.set(player, [_doorKey(door), World.currentTick]);
        if (_isWeb(door)) _cutWeb(player, door);
        else _executeGateScript(player, door);
        return true;
    }
    if (player.hasWaypoints()) return true;
    doorWalks.delete(player);
    return false;
}

/**
 * port (the variety work, round 1, the fixes): the sticky web across the Varrock sewers' passage to the moss giants
 * (3210,9898: 274's web.rs2, [oploc1,bigweb_slashable] cuts it with a wielded slashing weapon, [oplocu] with a knife or
 * any slashing weapon used on it; half the cuts fail; cut, it stays open 100 ticks). Walks took it for a wall: the moss
 * giants (Track D's sewer spot) were reached only by a rescue jump, and a bot there walked to and fro by the web for its
 * whole bank walk. A walk cuts it as it opens a door (_openDoorToward), with the bot's own blade.
 */
function _isWeb(loc: Loc): boolean {
    return loc.isActive && LocType.get(loc.type).debugname === 'bigweb_slashable';
}

let SLASH_ANIM_PARAM = -2;
let UNARMED_PUNCH = -1;
/** does this weapon slash (274's oc_param slashattack_anim other than the unarmed punch: a scimitar, a sword, an axe)? */
function _slashes(id: number): boolean {
    if (SLASH_ANIM_PARAM === -2) {
        SLASH_ANIM_PARAM = ParamType.getId('slashattack_anim');
        UNARMED_PUNCH = SeqType.getId('human_unarmedpunch');
    }
    const v = SLASH_ANIM_PARAM === -1 ? undefined : ObjType.get(id)?.params?.get(SLASH_ANIM_PARAM);
    return typeof v === 'number' && v !== UNARMED_PUNCH;
}

/** the bot's blade for a web: 'worn' (its weapon in hand slashes), the pack's slot of a knife or a slashing weapon, or null */
function _webBlade(player: Player): 'worn' | number | null {
    const held = player.getInventory(InvType.WORN)?.get(3);
    if (held && _slashes(held.id)) return 'worn';
    const inv = player.getInventory(InvType.INV);
    for (let slot = 0; inv && slot < inv.capacity; slot++) {
        const it = inv.get(slot);
        if (it && (ObjType.get(it.id)?.debugname === 'knife' || _slashes(it.id))) return slot;
    }
    return null;
}

/** a cut at the web the bot stands by: its weapon in hand (274's Slash), else its blade from the pack used on it */
function _cutWeb(player: Player, web: Loc): boolean {
    const blade = _webBlade(player);
    if (blade === null) return false;
    if (blade === 'worn') return _executeGateScript(player, web);
    const it = player.getInventory(InvType.INV)?.get(blade);
    return !!it && interactUseLocOp(player, web, it.id, blade);
}

/** (the fixes) does the bot carry a blade for a web (a slashing weapon in hand or in its pack, a knife)? */
export function carriesWebBlade(player: Player): boolean {
    return _webBlade(player) !== null;
}

/** (the fixes) a blade for a web in the bank: a knife, else a slashing weapon (every bot's InitTask gave it a knife and an iron scimitar); -1 for none */
export function bankedWebBlade(player: Player, bank: Inventory | null): number {
    let blade = -1;
    for (let slot = 0; bank && slot < bank.capacity; slot++) {
        const it = bank.get(slot);
        if (!it) continue;
        if (ObjType.get(it.id)?.debugname === 'knife') return it.id;
        if (blade === -1 && _slashes(it.id) && ObjType.get(it.id).wearpos === 3) blade = it.id;
    }
    return blade;
}

function _doorKey(loc: Loc): number {
    return (loc.level << 28) | (loc.x << 14) | loc.z;
}

/**
 * port (the variety work, round 1, track F: the Lumbridge castle stairs, ISS-10): the bot is getting a door or gate open
 * on its way (walking to it, its click queued, or opened in the last DOOR_PROGRESS_TICKS: its script moves it through).
 * The stuck checks count that as progress: the room with the castle's stairs is behind three doors, and a crafter that
 * opened them one by one in a crowded tick budget moved less than 4 tiles in 30 ticks and was jumped upstairs.
 */
const DOOR_PROGRESS_TICKS = 8;
export function isOpeningDoor(player: Player): boolean {
    const walk = doorWalks.get(player);
    if (walk && World.currentTick <= walk.until) return true;
    const opened = lastDoorOpened.get(player);
    if (opened && World.currentTick - opened[1] <= DOOR_PROGRESS_TICKS) return true;
    return _hasGateInteractionPending(player);
}

/**
 * port: the closed door or gate to open on the way to (tx, tz) when no route gets there: one the bot can get to now
 * (a route, not a door behind another), that leaves it nearest the target (bot to door plus door to target), not one
 * it found shut after opening it lately. Upstream opened the closed door nearest the bot, whichever it was, so bots
 * opened locked, members' and one-way doors over and over (the Draynor jail, Draynor Manor, the Falador members' gate:
 * test/sim.mjs), and never got through a chain of doors (the room with Lumbridge castle's stairs is behind three).
 * 'opened' (the bot stood at it: its script ran), 'walking' (a route to it is queued) or 'none'. At most 6 route
 * searches, within the tick's budget.
 */
function _openDoorToward(player: Player, tx: number, tz: number, except: Loc | null = null, radius = 16): 'opened' | 'walking' | 'none' {
    const now = World.currentTick;
    let shut = shutDoors.get(player);
    const cheb = (ax: number, az: number, bx: number, bz: number): number => Math.max(Math.abs(ax - bx), Math.abs(az - bz));
    const here = cheb(player.x, player.z, tx, tz);
    const doors: Loc[] = [];
    const zoneRadius = Math.ceil(radius / 8) + 1;
    for (let dz = -zoneRadius; dz <= zoneRadius; dz++) {
        for (let dx = -zoneRadius; dx <= zoneRadius; dx++) {
            const zone = getWorld().gameMap.getZone(player.x + dx * 8, player.z + dz * 8, player.level);
            if (!zone) continue;
            for (const loc of zone.getAllLocsSafe()) {
                // (not one far past the target; the way in can start well away from it: Lumbridge castle's stairs, 4
                // tiles from a bot outside the wall, are reached by the front doors 11 tiles from them. The order
                // below puts the doors on the way first)
                if (loc === except || cheb(loc.x, loc.z, player.x, player.z) > radius || cheb(loc.x, loc.z, tx, tz) > here + 12) continue;
                // (the fixes: a sticky web too, for a bot with a blade to cut it: _webBlade)
                if (!(_isWeb(loc) ? _webBlade(player) !== null : _isClosedGate(loc)) || (shut?.get(_doorKey(loc)) ?? 0) > now) continue;
                doors.push(loc);
            }
        }
    }
    doors.sort((a, b) => cheb(player.x, player.z, a.x, a.z) + cheb(a.x, a.z, tx, tz) - (cheb(player.x, player.z, b.x, b.z) + cheb(b.x, b.z, tx, tz)));
    let searches = 0;
    for (const door of doors) {
        const forceapproach = LocType.get(door.type).forceapproach;
        if (botReachedLoc(player.level, player.x, player.z, door.x, door.z, door.width, door.length, door.angle, door.shape, forceapproach)) {
            const key = _doorKey(door);
            const last = lastDoorOpened.get(player);
            // (a web: a cut fails half the time, 274's random(2), and is tried again)
            if (last && last[0] === key && now - last[1] < 10 && !_isWeb(door)) {
                // opened a moment ago and still closed: it does not open for this bot
                if (!shut) shutDoors.set(player, (shut = new Map()));
                shut.set(key, now + SHUT_DOOR_TICKS);
                continue;
            }
            lastDoorOpened.set(player, [key, now]);
            if (_isWeb(door) ? _cutWeb(player, door) : _executeGateScript(player, door)) return 'opened';
            continue;
        }
        if (searches++ >= 6 || pathBudgetLeft(player) === 0) break;
        const path = botPathToLoc(player.level, player.x, player.z, door.x, door.z, door.width, door.length, door.angle, door.shape, forceapproach, false);
        if (path.length > 0) {
            player.clearPendingAction();
            player.queueWaypoints(path);
            doorWalks.set(player, { door, until: now + 60 });
            return 'walking';
        }
    }
    return 'none';
}

/**
 * Scan within `radius` tiles for any closed door, gate, toll gate, or curtain.
 * Handles:
 *   - Standard "Open" ops (doors, gates)
 *   - "Pay-toll(10gp)" variants (Al Kharid gate)
 *   - Walk-through / pass-through doors
 *   - Al Kharid palace curtains (loc_1528 — op1="Open", blockwalk=yes while closed)
 *
 * Behaviour:
 *   - If already adjacent to the gate: directly executes the OPLOC1 script,
 *     bypassing the broken processInteraction path (see _executeGateScript).
 *   - If not yet adjacent: queues plain walk-waypoints toward the gate.
 *     Next call (BotPlayer universal sweep fires every 5 ticks) will execute.
 *
 * Returns true if an obstruction was found (interaction queued or walk started).
 */
export function openNearbyGate(player: Player, radius = 30): boolean {
    return _openNearbyGate(player, radius) !== 'none';
}

/**
 * port: openNearbyGate for a task that goes on with its own work otherwise: true only when it opened a gate or is
 * walking to one. A closed gate it cannot get to this tick ('unreachable') is false, so the task still does what it
 * would have done (upstream's true kept a combat bot from ever scanning for an NPC near a door it could not reach).
 */
export function tryOpenNearbyGate(player: Player, radius: number): boolean {
    const result = _openNearbyGate(player, radius);
    return result === 'opened' || result === 'walking';
}

/**
 * port: openNearbyGate, saying what it did: 'opened' (adjacent: the gate's script ran or the interaction is set),
 * 'walking' (a route to the gate is queued), 'unreachable' (a closed gate is near but there is no route to it this
 * tick) or 'none'. openNearbyGate keeps upstream's answer (true for all but 'none').
 */
function _openNearbyGate(player: Player, radius: number): 'none' | 'opened' | 'walking' | 'unreachable' {
    return _openGate(player, _findLoc(player.x, player.z, player.level, radius, _isClosedGate));
}

/** port: the closed gate or door nearest (x, z) that lies on the way from the bot to there (a detour of at most 6 tiles) */
export function closedGateBetween(player: Player, x: number, z: number, radius: number): Loc | null {
    const cheb = (ax: number, az: number, bx: number, bz: number) => Math.max(Math.abs(ax - bx), Math.abs(az - bz));
    const direct = cheb(player.x, player.z, x, z);
    return _findLoc(x, z, player.level, radius, loc => _isClosedGate(loc) && cheb(player.x, player.z, loc.x, loc.z) + cheb(loc.x, loc.z, x, z) <= direct + 6);
}

/** port: open this gate: 'opened' (adjacent: its script ran), 'walking' (on the way to it), 'unreachable', 'none' (open now) */
export function openGateLoc(player: Player, gate: Loc): 'none' | 'opened' | 'walking' | 'unreachable' {
    if (!gate.isActive || !_isClosedGate(gate)) return 'none';
    return _openGate(player, gate);
}

/**
 * port: tryOpenNearbyGate for the closed door or gate nearest to (x, z) rather than to the bot: the one between a bot
 * and a player it is walking to (a player inside a house), which is seldom the gate nearest to the bot.
 */
export function tryOpenGateNear(player: Player, x: number, z: number, radius: number): boolean {
    const result = _openGate(player, _findLoc(x, z, player.level, radius, _isClosedGate));
    return result === 'opened' || result === 'walking';
}

function _openGate(player: Player, gate: Loc | null): 'none' | 'opened' | 'walking' | 'unreachable' {
    if (!gate) return 'none';

    try {
        const botName = _debugBotName(player);
        if (botName) BotDebugService.noteRecovery(botName, 'gate');
    } catch {
        // debug hook must never affect gameplay
    }

    if (isAdjacentToLoc(player, gate)) {
        // Adjacent — fire the OPLOC1 script directly.
        if (_executeGateScript(player, gate)) return 'opened';
        // No OPLOC1 script found (unusual) — fall back to setInteraction (port: without interactLoc's route, which may
        // open a door itself)
        player.clearPendingAction();
        player.setInteraction(Interaction.ENGINE, gate, ServerTriggerType.APLOC1);
        return 'opened';
    }

    // Not adjacent — walk toward the gate tile with plain waypoints.
    // _pathTowards is intentionally NOT used here to avoid mutual recursion
    // (_pathTowards calls openNearbyGate when the path is fully blocked).
    return _walkToGate(player, gate) ? 'walking' : 'unreachable';
}

/**
 * Returns true if the player already has a pending gate/door interaction
 * queued (APLOC1 on a loc whose ops include an open keyword or that matches
 * a known barrier name prefix).
 *
 * walkTo calls this before clearPendingAction to avoid cancelling a gate
 * interaction that was set on the previous tick before the engine could
 * execute it — the root cause of the "sometimes opens, sometimes doesn't"
 * inconsistency.
 */
function _hasGateInteractionPending(player: Player): boolean {
    const target = player.target;
    if (!target || !(target instanceof Loc)) return false;
    if (player.targetOp !== ServerTriggerType.APLOC1) return false;
    const t = LocType.get((target as Loc).type);
    // Explicit barrier types (e.g. Al Kharid curtains)
    if (BARRIER_NAME_PREFIXES.some(p => t.debugname?.startsWith(p))) return true;
    const ops = (t.op ?? []).filter((o): o is string => typeof o === 'string').map(o => o.toLowerCase());
    return ops.some(op => GATE_OPEN_KEYWORDS.some(kw => op.startsWith(kw)));
}

// Toll gates that bots must never try to open — crossing is handled by the
// GATEWAY_REGIONS teleport in walkTo instead.
// port: by name (border_gate_toll_left/right, 2882/2883); upstream's list also had 1298-1300, 1173 and 375, which
// are ferns and a chest
let TOLL_GATE_TYPE_IDS: Set<number> | null = null;

// port: the closed-gate verdict per loc type, worked out once (upstream lowercased the names and filtered the ops of
// every loc in every sweep, 121 zones for a 30-tile one): 0 = not yet known, then one of these.
const GATE_NEVER = 1; // no open op (or a close op), a toll gate, decoration or furniture
const GATE_IN_WALL = 2; // an open op: a gate or door where it stands in a wall
const GATE_ALWAYS = 3; // a gate or door whatever its shape (the Gnome Stronghold gate and other centrepiece doors)
let GATE_VERDICTS: Uint8Array | null = null;
let FURNITURE_CATEGORIES: Set<number> | null = null;

/**
 * port: upstream's predicate took any loc with an Open op and no Close op, so combat bots walked to drawers,
 * cupboards, wardrobes and coffins (and trapdoors) near their spot and opened them again and again. A gate or door
 * stands in a wall (274's wall shapes, the diagonal wall too); among the rest only a type named as a door or gate,
 * never furniture: the drawer and cupboard categories, or a loc approached from its front only (forceapproach: every
 * drawer, cupboard and wardrobe in the 274 packs). Ground decoration (trapdoors) never: opening one clears no way.
 */
function _gateTypeVerdict(type: number): number {
    if ((TOLL_GATE_TYPE_IDS ??= tollGateIds()).has(type)) return GATE_NEVER;
    const t = LocType.get(type);
    // Decorative vegetation — never a gate regardless of any ops.
    const debugLower = t.debugname?.toLowerCase() ?? '';
    const nameLower  = (t.name ?? '').toLowerCase();
    if (DECORATIVE_LOC_FRAGMENTS.some(f => debugLower.includes(f) || nameLower.includes(f))) return GATE_NEVER;
    if (BARRIER_NAME_PREFIXES.some(p => t.debugname?.startsWith(p))) return GATE_ALWAYS;
    if (BIG_DOOR_PREFIXES.some(p => debugLower.includes(p))) return GATE_ALWAYS;
    const ops = (t.op ?? []).filter((o): o is string => typeof o === 'string').map(o => o.toLowerCase());
    const hasOpenOp = ops.some(op => GATE_OPEN_KEYWORDS.some(kw => op.startsWith(kw)));
    const hasCloseOp = ops.some(op => GATE_CLOSE_KEYWORDS.some(kw => op === kw));
    if (!hasOpenOp || hasCloseOp) return GATE_NEVER;
    FURNITURE_CATEGORIES ??= new Set([CategoryType.getId('drawer'), CategoryType.getId('cupboard_closed')].filter(id => id !== -1));
    if (t.forceapproach !== 0 || FURNITURE_CATEGORIES.has(t.category)) return GATE_NEVER;
    return /\b(doors?|gates?)\b/.test(nameLower) ? GATE_ALWAYS : GATE_IN_WALL;
}

/** Internal: returns true if `loc` passes the closed-gate predicate. (port: exported for test/pk.test.mjs) */
export function _isClosedGate(loc: Loc): boolean {
    const shape = loc.shape;
    if (shape === LocShape.GROUND_DECOR) return false;
    const verdicts = (GATE_VERDICTS ??= new Uint8Array(LocType.count));
    const type = loc.type;
    let verdict = type < verdicts.length ? verdicts[type] : _gateTypeVerdict(type);
    if (verdict === 0) verdicts[type] = verdict = _gateTypeVerdict(type);
    if (verdict === GATE_ALWAYS) return true;
    return verdict === GATE_IN_WALL && (shape <= LocShape.WALL_SQUARE_CORNER || shape === LocShape.WALL_DIAGONAL);
}

/**
 * Directional variant of openNearbyGate.
 *
 * Scans up to `radius` tiles (default 10) for any closed door or gate that
 * lies roughly BETWEEN the player and (destX, destZ) — defined as a positive
 * dot product between the player→gate vector and the player→destination
 * heading.  Gates that are directly behind or perpendicular to the heading
 * are ignored, preventing the bot from opening unrelated doors while walking.
 *
 * Used by walkTo so that every movement call automatically clears gates along
 * the route rather than only reacting after the bot gets stuck.
 *
 * Returns true if a qualifying gate was found and an Open interaction was queued.
 */
export function openGateToward(player: Player, destX: number, destZ: number, radius = 10): boolean {
    const dx = destX - player.x;
    const dz = destZ - player.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 1) return false;

    const headX = dx / dist;
    const headZ = dz / dist;
    // Cap scan radius at (dist + 2) so we don't open gates beyond the destination.
    const scanRadius = Math.min(radius, dist + 2);

    const gate = _findLoc(player.x, player.z, player.level, scanRadius, loc => {
        if (!_isClosedGate(loc)) return false;
        // Directional filter: gate must be in the forward hemisphere (dot > 0).
        const dot = (loc.x - player.x) * headX + (loc.z - player.z) * headZ;
        return dot > 0;
    });

    if (!gate) return false;

    if (isAdjacentToLoc(player, gate)) {
        // Adjacent — fire the OPLOC1 script directly (same fix as openNearbyGate).
        if (_executeGateScript(player, gate)) return true;
        player.clearPendingAction();
        player.setInteraction(Interaction.ENGINE, gate, ServerTriggerType.APLOC1);
        return true;
    }

    // Not adjacent — walk toward the gate tile with plain waypoints.
    _walkToGate(player, gate);
    return true;
}
