// For test/tiles.test.mjs: the 274 map with the bots' own tiles (port/BotTiles), the hang-out spots (port/BotHangout) and
// the path search's level of detail (port/BotPathing L1), loaded in a scratch engine clone (test/lib/clone.mjs). The
// players are plain players (PlayerLoading without a client) given a slot, so their claims hold; one stands in its zone
// when a test needs a tile taken; a "human" is put in the world's player list for the level of detail.
import World from '#/engine/World.js';
import type Player from '#/engine/entity/Player.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import Packet from '#/io/Packet.js';
import LocType from '#/cache/config/LocType.js';
import { setWorld } from '#/engine/bot/BotWorld.js';
import { tilesInSquare, findLocByName } from '#/engine/bot/BotAction.js';
import { BotCollisionMap } from '#/engine/bot/BotCollisionMap.js';
import { claimStandTile, releaseStandTile, standTileOf, isTileClaimed, claimLocTile, usesLocFrom, claimedTiles, sharesTile, MAX_STAND_RADIUS } from '#/engine/bot/port/BotTiles.js';
import { HANGOUT_SPOTS, pickHangout, HANGOUT_RANGE } from '#/engine/bot/port/BotHangout.js';
import { HUBS as SOCIAL_HUBS } from '#/engine/bot/tasks/SocialTask.js';
import { beginPathTick, pathBudgetLeft, setPathSearchBudget, farSearchBudget, farFromHumans, botWalkPath, farSearchesThisTick, pathSearchesThisTick, LOD_NEAR_TILES } from '#/engine/bot/port/BotPathing.js';

export {
    World,
    LocType,
    tilesInSquare,
    findLocByName,
    BotCollisionMap,
    claimStandTile,
    releaseStandTile,
    standTileOf,
    isTileClaimed,
    claimLocTile,
    usesLocFrom,
    claimedTiles,
    sharesTile,
    MAX_STAND_RADIUS,
    HANGOUT_SPOTS,
    SOCIAL_HUBS,
    pickHangout,
    HANGOUT_RANGE,
    beginPathTick,
    pathBudgetLeft,
    setPathSearchBudget,
    farSearchBudget,
    farFromHumans,
    botWalkPath,
    farSearchesThisTick,
    pathSearchesThisTick,
    LOD_NEAR_TILES
};

export async function start(): Promise<void> {
    await World.start(false, false);
    (World as unknown as { cycle: () => void }).cycle = () => {}; // nothing runs on its own
    setWorld(World);
}

let nextSlot = 1;
/** A player at (x, z), with a slot (its claims hold); `bot`: a bot's flag. Not in a zone (standing nowhere) unless stood(). */
export function playerAt(name: string, x: number, z: number, level = 0, bot = true): Player {
    const player = PlayerLoading.load(name, new Packet(new Uint8Array(0)), null);
    player.x = x;
    player.z = z;
    player.level = level;
    player.slot = nextSlot++;
    (player as unknown as { is_bot: boolean }).is_bot = bot;
    return player;
}

/** The player stands on its tile (in its zone: another bot's claim skips the tile). */
export function stand(player: Player): void {
    World.gameMap.getZone(player.x, player.z, player.level).enter(player);
}

/** The player leaves the world (its slot goes: its claim no longer holds). */
export function leave(player: Player): void {
    player.slot = -1;
}

/** A human in the world's player list (the level of detail's), at (x, z). */
export function humanAt(x: number, z: number, level = 0): Player {
    const human = playerAt('a human', x, z, level, false);
    World.playerLoop.add(BigInt(human.slot), human);
    return human;
}
