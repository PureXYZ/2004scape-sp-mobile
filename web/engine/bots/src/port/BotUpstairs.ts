// port (the variety work, round 2, Track M: members places and minigames): the climb to a spot upstairs that the walk's
// gateways (BotAction.walkTo: the Seers' wheel, Lumbridge castle, the Wizards' Guild) do not cover: Yanille's watchtower
// (its watchmen, Thieving 65: the tower guard lets a bot of the Watchtower quest up, 274's oploc1 towerladder). The way
// up and down is the building's own ladder or stairs, clicked as a player clicks them (their Climb-up, Climb-down), a
// guard's page continued; nothing is jumped. (The Wizards' Tower's caged demon is no spot: 274's cage stops a ranger's
// arrows from outside it, BotKnowledge MembersPlaces.WIZARDS_TOWER_DEMON.)
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import LocType from '#/cache/config/LocType.js';
import { botAnswerDialogue, botScript, findLocByName, interactLocOp, noteMove, walkTo } from '#/engine/bot/BotAction.js';
import { botPathToLoc, botReachedLoc } from '#/engine/bot/port/BotPathing.js';

interface Flight {
    /** the floor it leaves from */
    level: number;
    /** the ladder's or stairs' loc and where it stands */
    loc: string;
    at: readonly [number, number];
    /** a tile on the right side of the walls to walk to before the click (the watchtower is entered from the east, not
     * from Yanille's side of its wall) */
    approach?: readonly [number, number];
}

interface Building {
    key: string;
    /** [x0, z0, x1, z1] inclusive */
    box: readonly [number, number, number, number];
    up: readonly Flight[];
    down: readonly Flight[];
}

const BUILDINGS: readonly Building[] = [
    {
        key: 'yanille-watchtower',
        box: [2538, 3104, 2556, 3122],
        up: [{ level: 0, loc: 'towerladder', at: [2544, 3111], approach: [2547, 3113] }],
        down: [{ level: 1, loc: 'laddertop', at: [2544, 3111] }]
    }
];

/** (tests) climbs clicked by building and way */
export const climbStats: Record<string, number> = {};

function inBox(b: Building, x: number, z: number): boolean {
    return x >= b.box[0] && x <= b.box[2] && z >= b.box[1] && z <= b.box[3];
}

/** the building one of these spots is in (an upstairs spot's), or null */
export function buildingAt(x: number, z: number): string | null {
    return BUILDINGS.find(b => inBox(b, x, z))?.key ?? null;
}

const lastClick = new WeakMap<Player, number>();

/**
 * Toward `dest` on another floor of one of the buildings: up from the ground (dest's building) or down to the ground (the
 * bot's): to the flight of its floor, then its click. True while it handled this tick (a walk, a click, a page, the
 * climb's own delay); false when there is nothing to climb here (the same floor, or no building of ours).
 */
export function climbLeg(player: Player, dest: readonly [number, number, number]): boolean {
    const [dx, dz, dl] = dest;
    if (player.level === dl) return false;
    const going: 'up' | 'down' = player.level < dl ? 'up' : 'down';
    const building = BUILDINGS.find(b => inBox(b, going === 'up' ? dx : player.x, going === 'up' ? dz : player.z));
    if (!building) return false;
    if (botAnswerDialogue(player, 1) !== null) return true;
    if (player.delayed || botScript(player)) return true;
    const flight = (going === 'up' ? building.up : building.down).find(f => f.level === player.level);
    if (!flight) return false;
    const [fx, fz] = flight.at;
    const now = World.currentTick;
    if (now - (lastClick.get(player) ?? -100) < 6 || player.hasWaypoints()) return true;
    // (the click once a walk reaches the ladder or stairs from here; else to the foot first, on the right side of the
    // walls (its approach: the watchtower is entered from the east, not from Yanille's side of its wall)
    const loc = Math.max(Math.abs(player.x - fx), Math.abs(player.z - fz)) <= 12 ? findLocByName(fx, fz, player.level, flight.loc, 3) : null;
    const forceapproach = loc ? LocType.get(loc.type).forceapproach : 0;
    const reaches = loc !== null && (botReachedLoc(player.level, player.x, player.z, loc.x, loc.z, loc.width, loc.length, loc.angle, loc.shape, forceapproach) || botPathToLoc(player.level, player.x, player.z, loc.x, loc.z, loc.width, loc.length, loc.angle, loc.shape, forceapproach, false).length > 0);
    if (!loc || !reaches) {
        const [ax, az] = flight.approach ?? flight.at;
        if (Math.max(Math.abs(player.x - ax), Math.abs(player.z - az)) <= 1 && !loc) return false;
        walkTo(player, ax, az, player.level);
        return true;
    }
    const ops = (LocType.get(loc.type).op ?? []).map(o => String(o ?? '').toLowerCase());
    const i = ops.findIndex(o => o === (going === 'up' ? 'climb-up' : 'climb-down'));
    lastClick.set(player, now);
    interactLocOp(player, loc, (i >= 0 ? i + 1 : 1) as 1 | 2 | 3 | 4 | 5);
    // (the climb is 274's own move, a tile or few off the ladder's foot: marked as the game's for the humanlike runner)
    noteMove(player, 'event');
    const key = `${building.key}:${going}`;
    climbStats[key] = (climbStats[key] ?? 0) + 1;
    return true;
}
