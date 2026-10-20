// "come here" (a human's private message to a bot, port/BotChat): the bot runs to the player and waits by them for a
// while, as a sub-task that pauses its own task (BotPlayer.setSubTask). Upstream only queued the run; any task that
// set its next interaction or path the following tick (a woodcutter re-clicking its tree) walked the bot straight
// back. A trade request from anyone ends the wait, so a vendor's task takes it from there (and later returns it to
// botComeHereReturnX/Z, as upstream).
//
// Only a PKer follows a player into the Wilderness. Any other bot refuses the call when the player (or the tile next
// to them) is in there, and stops following when the player goes in: a human who kills a bot in PvP gets 1-50,000
// coins (the death overlay), and upstream let a player call any bot over the ditch and kill it again and again.
import { MoveSpeed } from '#/engine/entity/MoveSpeed.js';
import type Player from '#/engine/entity/Player.js';
import { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';
import { tryOpenGateNear } from '#/engine/bot/BotAction.js';
import { BotCollisionMap } from '#/engine/bot/BotCollisionMap.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { botWalkPath, pathBudgetLeft } from '#/engine/bot/port/BotPathing.js';
import { botSay } from '#/engine/bot/port/BotSay.js';
import { inFight } from '#/engine/bot/port/BotChat.js';

/** How long the bot stays by the player once there (30 s), and how long it tries to get there. */
const STAY_TICKS = 50;
const GIVE_UP_TICKS = 100;
/** Beyond this (or another floor) the player is gone. */
const MAX_DISTANCE = 60;
/** No closer for this long: a closed door or gate is in the way (the route search treats one as a wall). */
const STALL_TICKS = 3;

/** What a bot that is not a PKer says when called into the Wilderness (a private reply, or overhead when the player walks in). */
export const WILDERNESS_REFUSALS = ['Not going in there!', 'No way, not into the Wilderness.', 'Nope, too dangerous in there.'];

/** The bots that follow a player into the Wilderness: the PKers (the deep-Wilderness and the Edgeville ones). */
export function followsIntoWilderness(bot: Player): boolean {
    return bot.botPlanner === 'extras_pker' || bot.botPlanner === 'extras_edgeville_pker';
}

/** A tile outside the Wilderness (the PK code's wilderness check). */
export function outsideWilderness(x: number, z: number): boolean {
    return wildernessLevelAt(x, z) <= 0;
}

export function pickWildernessRefusal(): string {
    return WILDERNESS_REFUSALS[Math.floor(Math.random() * WILDERNESS_REFUSALS.length)];
}

export class ComeHereTask extends BotTask {
    private readonly target: Player;
    private readonly intoWilderness: boolean;
    private ticks = 0;
    private arrivedAt = -1;
    private refused = false;
    private closest = Infinity;
    private stalled = 0;
    private toGate = false;

    constructor(target: Player, intoWilderness = false) {
        super('ComeHere');
        this.target = target;
        this.intoWilderness = intoWilderness;
    }

    shouldRun(player: Player): boolean {
        const t = this.target;
        return t.slot !== -1 && t.level === player.level && distance(player, t) <= MAX_DISTANCE && player.botTradeTargetPid === -1;
    }

    tick(player: Player): void {
        this.ticks++;
        // port: attacked by a player on the way (or while waiting): the bot's own task takes over again and fights back
        if (inFight(player)) {
            this.refused = true;
            return;
        }
        const t = this.target;
        if (!this.intoWilderness && !outsideWilderness(t.x, t.z)) {
            // the player went into the Wilderness: stay out (the sub-task ends) and say so
            this.refused = true;
            player.clearWaypoints();
            botSay(player, pickWildernessRefusal());
            return;
        }
        if (distance(player, t) <= 1) {
            if (this.arrivedAt === -1) {
                this.arrivedAt = this.ticks;
                player.clearWaypoints();
            }
            player.faceSquare(t.x, t.z);
            return;
        }
        if (this.arrivedAt !== -1 && distance(player, t) <= 3) return; // the player shuffles about: stay put
        const d = distance(player, t);
        if (d < this.closest) {
            this.closest = d;
            this.stalled = 0;
        } else if (!player.hasWaypoints()) {
            this.stalled++;
        }
        if (!player.hasWaypoints() && pathBudgetLeft() > 0) {
            // the route ends short of the player: open the door or gate next to them (upstream's run never opened one,
            // so a bot called to a player inside a house stopped at the wall); walking to it first, then opening it
            if (this.toGate || this.stalled >= STALL_TICKS) {
                const going = tryOpenGateNear(player, t.x, t.z, 6);
                this.toGate = going && player.hasWaypoints();
                this.stalled = 0;
                if (going) return;
            }
            // to the free tile next to the player that is closest to the bot (they may have moved)
            const tile = adjacentFreeTile(t, player, this.intoWilderness ? undefined : outsideWilderness);
            if (!tile) return;
            const path = botWalkPath(player.level, player.x, player.z, tile[0], tile[1]);
            if (path.length > 0) {
                player.run = 1;
                player.moveSpeed = MoveSpeed.RUN;
                player.queueWaypoints(path);
            }
        }
    }

    isComplete(_player: Player): boolean {
        return this.refused || (this.arrivedAt !== -1 && this.ticks - this.arrivedAt >= STAY_TICKS) || (this.arrivedAt === -1 && this.ticks >= GIVE_UP_TICKS);
    }
}

/**
 * The walkable tile next to `target` closest to `from` (and `allowed`, when given), or null when all eight are
 * blocked (or not allowed).
 */
export function adjacentFreeTile(target: Player, from: { x: number; z: number }, allowed?: (x: number, z: number) => boolean): [number, number] | null {
    let best: [number, number] | null = null;
    let bestDistance = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dz === 0) continue;
            const x = target.x + dx;
            const z = target.z + dz;
            if (BotCollisionMap.isCsvBlocked(target.level, x, z)) continue;
            if (allowed && !allowed(x, z)) continue;
            const d = Math.max(Math.abs(from.x - x), Math.abs(from.z - z)) + (dx !== 0 && dz !== 0 ? 0.5 : 0);
            if (d < bestDistance) {
                best = [x, z];
                bestDistance = d;
            }
        }
    }
    return best;
}

function distance(a: Player, b: Player): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}
