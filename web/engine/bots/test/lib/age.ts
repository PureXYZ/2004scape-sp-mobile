// What test/age.test.mjs needs: the real 274 world (map, configs), new bot players and the ageing module.
import World from '#/engine/World.js';
import Player from '#/engine/entity/Player.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import Packet from '#/io/Packet.js';
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import { isMapBlocked, isZoneAllocated } from '#/engine/GameMap.js';
import { getExpByLevel, getLevelByExp } from '#/engine/entity/Player.js';
import { setWorld } from '#/engine/bot/BotWorld.js';
import { applyWorldRules } from '#/engine/bot/port/BotWorldRules.js';
import { BOT_NAMES, PLANNERS, normalizeBotName } from '#/engine/bot/port/BotRoster.js';
import { AGE_TIERS, ageTierFor, agedStats, applyAge, combatLevelOf } from '#/engine/bot/port/BotAge.js';
import { BotGoalPlanner, Personalities } from '#/engine/bot/BotGoalPlanner.js';
import { Locations } from '#/engine/bot/BotKnowledge.js';

export { World, InvType, ObjType, BOT_NAMES, PLANNERS, AGE_TIERS, ageTierFor, agedStats, applyAge, combatLevelOf, normalizeBotName, getExpByLevel, getLevelByExp, Locations };
// (the variety work, round 1, track W) a newcomer's class look
export { newcomerClassLook } from '#/engine/bot/port/BotAge.js';

export async function startWorld(members: boolean): Promise<void> {
    await World.start(false, false);
    setWorld(World);
    applyWorldRules(members);
}

/** A bot as BotManager makes a fresh one (no save) before ageing: the Lumbridge spawn, Herblore 3. */
export function freshBot(name: string): Player {
    const player = PlayerLoading.load(name, new Packet(new Uint8Array(0)), null);
    const [x, z, level] = Locations.LUMBRIDGE_SPAWN;
    player.x = x;
    player.z = z;
    player.level = level;
    player.baseLevels[15] = 3;
    player.levels[15] = 3;
    player.stats[15] = getExpByLevel(3);
    return player;
}

export function items(player: Player, invId: number): { slot: number; id: number; count: number }[] {
    const inv = invId === -1 ? null : player.getInventory(invId);
    const out: { slot: number; id: number; count: number }[] = [];
    for (let slot = 0; slot < (inv?.capacity ?? 0); slot++) {
        const it = inv!.get(slot);
        if (it) out.push({ slot, id: it.id, count: it.count });
    }
    return out;
}

export function bankId(): number {
    return InvType.getId('bank');
}

export function walkable(x: number, z: number, level: number): boolean {
    return isZoneAllocated(level, x, z) && !isMapBlocked(x, z, level);
}

export function freeToPlay(x: number, z: number): boolean {
    return World.gameMap.isFreeToPlay(x, z);
}

/** Runs the bot's first planner pick (its InitTask) once, as on its first tick. */
export function runInitTask(player: Player): void {
    const task = new BotGoalPlanner(Personalities.BALANCED).pickTask(player);
    task?.tick(player);
}

/** A snapshot of everything ageing sets. */
export function snapshotOf(player: Player): string {
    return JSON.stringify({
        stats: Array.from(player.stats),
        levels: Array.from(player.baseLevels),
        combat: player.combatLevel,
        at: [player.x, player.z, player.level],
        worn: items(player, InvType.WORN),
        inv: items(player, InvType.INV),
        bank: items(player, bankId())
    });
}
