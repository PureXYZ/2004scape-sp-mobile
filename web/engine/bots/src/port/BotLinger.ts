// port (the variety work, round 1, track F: pop-out): a bot that logs in within LINGER_TILES of a
// human lingers 10-40 s where it came in before it leaves for its task: it looks about (faces a tile near it now and then)
// and, by a bank, has a look at the booth (faces it a while), as a player does after a login. At a login fill the bots
// near the human come first (BotManager's near-you-first burst) and all walked off within 10-20 ticks (the humanlike
// report's H5 detail: 4 in view at t10, 2 at t20): now they thin out over half a minute. A sub-task (its own task waits);
// a bot far from every human starts at once, as before.
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { BotTask, randInt } from '#/engine/bot/tasks/BotTaskBase.js';
import { findLocByName } from '#/engine/bot/BotAction.js';

/** a login this near a human (tiles, the same floor) lingers */
export const LINGER_TILES = 15;
/** how long (ticks: 10-40 s) */
export const LINGER_TICKS: readonly [number, number] = [17, 67];
/** a look about every this many ticks; a booth this near is looked at */
const LOOK_EVERY: readonly [number, number] = [5, 14];
const BOOTH_TILES = 6;

/** (tests) the lingers begun */
export const lingerStats = { lingers: 0 };

/** Tests only: lingers off (false) or on (true, the default). Never set by the game. */
let enabled = true;
export function setLingerForTest(on: boolean): void {
    enabled = on;
}

/** a human (not a bot) within LINGER_TILES of the bot on its floor? */
function humanNear(bot: Player): boolean {
    for (const p of World.playerLoop.all()) {
        if (p.is_bot === true || p.slot === -1 || p.level !== bot.level) continue;
        if (Math.max(Math.abs(p.x - bot.x), Math.abs(p.z - bot.z)) <= LINGER_TILES) return true;
    }
    return false;
}

/** A login's linger for this bot, when a human is near it; null: it starts at once. */
export function loginLingerFor(bot: Player): LoginLingerTask | null {
    if (!enabled || bot.slot === -1 || !humanNear(bot)) return null;
    lingerStats.lingers++;
    return new LoginLingerTask(randInt(LINGER_TICKS[0], LINGER_TICKS[1]));
}

export class LoginLingerTask extends BotTask {
    private readonly ticks: number;
    private elapsed = 0;
    private nextLook = 0;
    private booth: { x: number; z: number } | null | undefined = undefined;
    private boothUntil = -1;

    constructor(ticks: number) {
        super('Linger');
        this.ticks = ticks;
    }

    shouldRun(): boolean {
        return this.elapsed < this.ticks;
    }

    isComplete(): boolean {
        return this.elapsed >= this.ticks;
    }

    override reset(): void {
        super.reset();
        this.elapsed = 0;
        this.nextLook = randInt(2, 6);
        this.booth = undefined;
        this.boothUntil = -1;
    }

    tick(player: Player): void {
        this.elapsed++;
        if (player.hasWaypoints() || player.delayed) return;
        // (by a bank: a look at the booth first, now and then: its bank checked)
        if (this.booth === undefined) {
            const booth = findLocByName(player.x, player.z, player.level, 'bankbooth', BOOTH_TILES);
            this.booth = booth && Math.random() < 0.6 ? { x: booth.x, z: booth.z } : null;
            if (this.booth) this.boothUntil = this.elapsed + randInt(6, 14);
        }
        if (this.booth && this.elapsed <= this.boothUntil) {
            if (this.elapsed === 1 || this.elapsed % 3 === 0) player.faceSquare(this.booth.x, this.booth.z);
            return;
        }
        if (this.elapsed < this.nextLook) return;
        this.nextLook = this.elapsed + randInt(LOOK_EVERY[0], LOOK_EVERY[1]);
        player.faceSquare(player.x + randInt(-6, 6), player.z + randInt(-6, 6));
    }
}
