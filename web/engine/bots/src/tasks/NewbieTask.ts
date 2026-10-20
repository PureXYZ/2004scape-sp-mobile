/**
 * NewbieTask.ts (port)
 *
 * Newbie newcomers (Phase 3: port/BotNewbie): a brand-new account's first steps off Tutorial Island.
 * It wields the tutorial's bronze sword and wooden shield, as the tutorial taught, then wanders the Lumbridge courtyard
 * and around the castle for a minute or three, stopping now and then; meanwhile port/BotChatter has it ask newbie
 * questions and beg the players it passes. The planner then sends it to the chickens and cows while it is a newbie.
 * port (the realism work, phase 2): the wander ends with its newbie time too (with other dice a wander begun late
 * outlasted it: test/churn.mjs's "no newbie wander after its newbie time").
 *
 * port (the realism work, phase 3: newbie time measured in levels, the slow levellers): a stint is 'first' (the wander
 * round the courtyard after it logs in) or 'idle' (2-6 minutes of what a newbie does between fights, and most of what a
 * slow leveller does: a walk to a spot round the castle, the general store or Bob's axes and a look about there, a
 * stand where it is). Every stint ends as soon as the bot is no newbie any more (isNewbie: combat 10 or total 60).
 */
import { BotTask, Player, InvType, walkTo, isNear, randInt, Items, Locations, StuckDetector } from '#/engine/bot/tasks/BotTaskBase.js';
import World from '#/engine/World.js';
import { interactHeldOp, _wornContains } from '#/engine/bot/BotAction.js';
import { BotCollisionMap } from '#/engine/bot/BotCollisionMap.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { CombatTask } from '#/engine/bot/tasks/CombatTask.js';
import type { SkillStep } from '#/engine/bot/BotKnowledge.js';
import type { PlayerStat } from '#/engine/bot/BotAction.js';

/** how long the first wander lasts: 1-3 minutes */
const WANDER_TICKS: [number, number] = [100, 300];
/** port (phase 3): how long an idle stint lasts: 2-6 minutes */
const STINT_TICKS: [number, number] = [200, 600];
/** how far from the courtyard the first wander goes */
const WANDER_RADIUS = 12;
/**
 * port (phase 3): the longest a newbie stands still in one go (a pause where it arrived, then a stand), in ticks: 84 s,
 * under 274's 90 s without input that logs a player out (the client's idle timer); then it walks on
 */
const STILL_MOST = 140;

/**
 * port (phase 3): where a newbie hangs about in Lumbridge, [x, z, radius]: the courtyard (off the island), in front of the
 * castle, among the men and women north of it, the church, the road north past the general store
 */
const NEWBIE_PLACES: readonly [number, number, number][] = [
    [Locations.LUMBRIDGE_COURTYARD[0], Locations.LUMBRIDGE_COURTYARD[1], 8],
    [Locations.LUMBRIDGE_CASTLE_APPROACH[0], Locations.LUMBRIDGE_CASTLE_APPROACH[1], 3],
    [Locations.THIEVE_LUMBRIDGE_MAN[0], Locations.THIEVE_LUMBRIDGE_MAN[1], 6],
    [Locations.LUMBRIDGE_ALTAR[0], Locations.LUMBRIDGE_ALTAR[1], 3],
    [Locations.FIRE_LUMBRIDGE_ROAD[0], Locations.FIRE_LUMBRIDGE_ROAD[1], 5]
];
/** port (phase 3): the shops a newbie looks into: the general store and Bob's axes */
const NEWBIE_SHOPS: readonly (readonly [number, number, number])[] = [Locations.LUMBRIDGE_GENERAL, Locations.BOB_AXES];

export type NewbieStint = 'first' | 'idle';

export class NewbieTask extends BotTask {
    private state: 'gear' | 'walk' | 'pause' | 'done' = 'gear';
    private until = -1;
    private pauseUntil = 0;
    /** where it walks, and how long it stands there on arrival */
    private spot: [number, number] | null = null;
    private stand: [number, number] = [10, 40];
    /** port (phase 3): the tick it last stopped walking (STILL_MOST: a newbie standing about walks on before 90 s) */
    private stillSince = -1;
    private readonly stuck = new StuckDetector(30, 4, 2);
    readonly stint: NewbieStint;

    constructor(stint: NewbieStint = 'first') {
        super('Newbie');
        this.stint = stint;
    }

    shouldRun(player: Player): boolean {
        return this.state !== 'done' && isNewbie(player);
    }

    /** its stint is over, or the bot is no newbie any more (port, phase 3: then its planner takes over at once) */
    isComplete(player: Player): boolean {
        return this.state === 'done' || !isNewbie(player);
    }

    override reset(): void {
        super.reset();
        this.state = 'gear';
        this.until = -1;
        this.spot = null;
        this.stuck.reset();
    }

    tick(player: Player): void {
        if (this.interrupted) return;
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        const now = World.currentTick;
        if (this.until === -1) {
            const [lo, hi] = this.stint === 'first' ? WANDER_TICKS : STINT_TICKS;
            this.until = now + randInt(lo, hi);
        }

        // the tutorial's sword and shield on, one a tick, as the game's Wield
        if (this.state === 'gear') {
            for (const id of [Items.BRONZE_SWORD, Items.WOODEN_SHIELD]) {
                if (_wornContains(player, id)) continue;
                const inv = player.getInventory(InvType.INV);
                const slot = inv ? findSlot(inv, id) : -1;
                if (inv && slot !== -1 && interactHeldOp(player, inv, id, slot, 2)) {
                    this.cooldown = 1;
                    return;
                }
            }
            this.state = 'walk';
            return;
        }

        if (now >= this.until) {
            this.state = 'done';
            return;
        }
        if (this.state === 'pause') {
            if (now >= this.pauseUntil) this.state = 'walk';
            return;
        }
        // a spot to walk to (or, in an idle stint, now and then a stand where it is), then a pause there (a newbie
        // looking about, or into a shop)
        if (!this.spot && !this._next(player, now)) return;
        const [sx, sz] = this.spot!;
        if (isNear(player, sx, sz, 1, player.level) || this.stuck.check(player, sx, sz)) {
            this.spot = null;
            this.stuck.reset();
            this.state = 'pause';
            // (still since it stopped walking: a spot it was at already is no walk)
            if (this.stillSince < 0) this.stillSince = now;
            this.pauseUntil = Math.min(now + randInt(this.stand[0], this.stand[1]), this.stillSince + STILL_MOST);
            return;
        }
        this.stillSince = -1;
        if (!player.hasWaypoints()) walkTo(player, sx, sz, player.level);
    }

    /** the next thing to do: a spot to walk to (true), or a stand where it is (false: it pauses now) */
    private _next(player: Player, now: number): boolean {
        if (this.stint === 'first') {
            this.spot = openTileNear(player, Locations.LUMBRIDGE_COURTYARD[0], Locations.LUMBRIDGE_COURTYARD[1], WANDER_RADIUS);
            this.stand = [10, 40];
            return true;
        }
        const roll = Math.random();
        // (only where it walked to in this stint: one begun as another ended does not know how long the bot stood)
        if (roll < 0.25 && this.stillSince >= 0 && now - this.stillSince <= STILL_MOST - 30) {
            // a stand where it is: looking about, reading the chat; never past STILL_MOST in all (274 logs a player out
            // after 90 s without input): then it walks on
            this.state = 'pause';
            this.pauseUntil = Math.min(now + randInt(20, 60), this.stillSince + STILL_MOST);
            return false;
        }
        // a walk: to the general store or Bob's axes, else to a spot round the castle; somewhere it is not (a newbie that
        // has stood a while walks on)
        for (let tries = 0; tries < 3; tries++) {
            if (roll < 0.5 && tries === 0) {
                const [x, z] = NEWBIE_SHOPS[Math.floor(Math.random() * NEWBIE_SHOPS.length)];
                this.spot = openTileNear(player, x, z, 1);
                this.stand = [10, 30];
            } else {
                const [x, z, radius] = NEWBIE_PLACES[Math.floor(Math.random() * NEWBIE_PLACES.length)];
                this.spot = openTileNear(player, x, z, radius);
                this.stand = [10, 40];
            }
            if (!isNear(player, this.spot[0], this.spot[1], 2, player.level)) break;
        }
        return true;
    }
}

/**
 * port (the realism work, phase 3): a newbie's fight at Lumbridge's chickens, cows or goblins (BotGoalPlanner): a
 * CombatTask (its kind is 'Combat') that is over once the bot is no newbie (combat 10 or total level 60): its planner
 * takes over at once. A plain CombatTask went on, as the planner's next pick was often 'Combat' too and the rescan
 * switches only to another kind of task: a fighter at Attack 40 kept killing chickens till its next bank trip.
 */
export class NewbieCombatTask extends CombatTask {
    constructor(step: SkillStep, stat: PlayerStat) {
        super(step, stat);
    }

    override isComplete(player?: Player): boolean {
        return player !== undefined && !isNewbie(player);
    }
}

function findSlot(inv: NonNullable<ReturnType<Player['getInventory']>>, id: number): number {
    for (let slot = 0; slot < inv.capacity; slot++) if (inv.get(slot)?.id === id) return slot;
    return -1;
}

/** an open tile within `radius` of (cx, cz) (the place itself when none comes up) */
function openTileNear(player: Player, cx: number, cz: number, radius: number): [number, number] {
    for (let attempt = 0; attempt < 8; attempt++) {
        const x = cx + randInt(-radius, radius);
        const z = cz + randInt(-radius, radius);
        if (!BotCollisionMap.isCsvBlocked(player.level, x, z)) return [x, z];
    }
    return [cx, cz];
}
