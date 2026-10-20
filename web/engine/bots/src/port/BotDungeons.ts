// port (the variety work, round 1, Track D: the new underground spots' way in): a walk to a step below ground goes to
// the dungeon's way in on the surface (BotKnowledge.dungeonRoute: its entrance) and takes it as a player does: the clicks
// its route lists (`enter`: a manhole or a trapdoor opened, then climbed down; the volcano's pot hole, the Falador
// stairs, the Mining Guild's ladder, the Ice Mountain trapdoor), else a 'climb-down' loc by the entrance (the older
// dungeons'), else today's unseen jump to the floor (BotAction.botTeleport: refused in a human's sight; the caller walks
// on). The way back up is walkTo's (it climbs out by the floor's ladder). Used by MiningTask (the dwarven mine and the
// Mining Guild); CombatTask's and RangedMagicTask's own legs (Track F's) take the route's clicks here too (enterDungeon,
// one line each, before their 'climb-down' and their jump).
import type Player from '#/engine/entity/Player.js';
import { botTeleport, climbNearby, findLocByName, interactLocOp, isNear, locInRoute, walkTo } from '#/engine/bot/BotAction.js';
import { dungeonRoute, type DungeonRoute } from '#/engine/bot/BotKnowledge.js';

/** how near the entrance (tiles) the bot looks for the way down, as CombatTask's leg */
const ENTRANCE_TILES = 6;

/**
 * The bot's walk to (x, z) when that is underground and the bot is not: true when this tick's move was made here (walked
 * toward the entrance with `walk`, a click on the way down, or the jump), false when (x, z) is not underground or the bot
 * is below already (the caller walks as usual).
 */
export function dungeonLeg(player: Player, x: number, z: number, walk: (x: number, z: number) => void): boolean {
    if (z <= 6400 || player.z > 6400 || player.level !== 0) return false;
    const route = dungeonRoute(x, z);
    const [ex, ez] = route.entrance;
    if (!isNear(player, ex, ez, ENTRANCE_TILES)) {
        walk(ex, ez);
        return true;
    }
    if (player.delayed) return true; // (a climb's script under way)
    if (enterDungeon(player, route) || climbNearby(player, 'climb-down', ENTRANCE_TILES)) return true;
    const [fx, fz, fl] = route.floor;
    botTeleport(player, fx, fz, fl, 'dungeon');
    return true;
}

/**
 * At a dungeon's entrance: the click its route lists that the bot can make now (the last of them found near: an open
 * manhole is climbed down, a shut one opened first); true when one was made (or the bot is held by a climb's script).
 * False when the route lists none, or none is near (the caller falls back to a 'climb-down' loc, then the jump).
 */
export function enterDungeon(player: Player, route: DungeonRoute): boolean {
    if (player.delayed) return true;
    const enter = route.enter ?? [];
    for (let i = enter.length - 1; i >= 0; i--) {
        const loc = findLocByName(player.x, player.z, player.level, enter[i].loc, ENTRANCE_TILES + 2);
        if (!loc) continue;
        // (the variety work, round 1, the fixes) one past a shut door is walked to first (the walk opens the door): the
        // Falador stairs to the dwarven mine are in a house, and a miner within 6 tiles outside its door clicked them ("I
        // can't reach that!" 26-32 times in 2 hours at 10x)
        const way = locInRoute(player, loc);
        if (way === 'wait') return true;
        if (way === 'no') {
            walkTo(player, loc.x, loc.z);
            return true;
        }
        if (player.target !== loc) interactLocOp(player, loc, enter[i].op as 1 | 2 | 3 | 4 | 5);
        return true;
    }
    return false;
}
