// port (bots ideas, round 3, theme G: the update buzz, the H builder's): a look at the lighthouse of Horror from the Deep (17 Nov 2004). tasks/BuzzTask wraps
// it (`Lighthouse:buzz:lighthouse`). For a bot of Agility 35+, Hitpoints 30+ and 3+ food (mayLighthouse):
//   - to the basalt causeway's south end, then its five jumps north (quest_horror basalt_rocks.rs2: the spots 1, 3, 5, 7,
//     9, each the loc's Jump-across, interactLoc), the slip at spot 3 the game's (stat_random(agility, 5, 255): 1-10
//     damage, the tide back to shore: it starts again), and after 3 slips it gives up, with a line;
//   - the lighthouse's door (the quest done: it lets the bot in), the spiral stairs up (base Climb-up, middle Climb-up),
//     1-3 minutes at the top, and down (top Climb-down, middle Climb-down), out by the door;
//   - the five jumps south (10, 8, 6, 4, 2; the slip at spot 8 sends it back north: it jumps again) to the Rellekka side.
// Never Jossik: his talk hands out the quest's casket and books, a quest reward. The causeway is its own walking-graph
// component: the bot never walks across, it jumps. While across, the set-piece role 'lighthouse' holds its session's end
// (a logout there would leave it where no walk leads out) and its hops and talk holds (port/BotMinimap, port/BotTalkMoves);
// a visit cut short (its time, the planner) jumps back first (returning: BuzzTask keeps ticking it). It eats below half
// its Hitpoints (a slip hurts), and with a slip spot still ahead never jumps at or under the largest slip (10): it eats
// first; with no food left it gives up northbound and, southbound, stands on the island and gets its Hitpoints back. A
// death all the same (the respawn out of the causeway's box) ends the visit, no jump judged and no rescue jump. Nothing
// it does gives XP but the game's (the jumps' Agility).
import { BotTask, Player, walkTo, StuckDetector, teleportNear, randInt, InvType, getBaseLevel, PlayerStat, carriedFood, findLocByName, interactLoc, interactLocOp } from '#/engine/bot/tasks/BotTaskBase.js';
import World from '#/engine/World.js';
import { interactHeldOp, botScript, botContinuePage } from '#/engine/bot/BotAction.js';
import { PeriodPlaces } from '#/engine/bot/BotKnowledge.js';
import { edibleFoodIds } from '#/engine/bot/tasks/BotTaskBase.js';
import { clearRole, eventRoleOf, setRole } from '#/engine/bot/port/BotSetPieces.js';
import { sayBuzzLine } from '#/engine/bot/tasks/BuzzTask.js';

/** who may go (G-content §5) */
export const LIGHTHOUSE_AGILITY = 35;
export const LIGHTHOUSE_HP = 30;
export const LIGHTHOUSE_FOOD = 3;
/** slips before it gives up (northbound) */
export const LIGHTHOUSE_SLIPS = 3;
/** the largest slip (basalt_rocks.rs2: ~damage_self(~random_range(1, 10))): no jump with a slip spot ahead at or under it */
export const LIGHTHOUSE_SLIP_HIT = 10;
/** at the top this long (1-3 minutes) */
const TOP_TICKS: [number, number] = [100, 300];
/** a click that moved nothing is tried this often, then the visit gives up */
const TRIES = 3;
/** a jump's click waits this long for its script (the walk to the rock, then the exactmove) */
const JUMP_WAIT = 16;
/** the Rellekka side: south of spot 1's landing */
const SHORE_Z = 3596;
/** the island's south edge (spot 9's landing, the walk to the door) */
const ISLAND_Z = 3619;
/** outside the door, inside it */
const DOOR_OUT: [number, number] = [2509, 3635];
/** the spiral stairs: the base (level 0), the middle (level 1), the top (level 2) */
const STAIRS: [number, number] = [2506, 3640];
export const LIGHTHOUSE_ROLE = 'lighthouse';

/** what the lighthouse visits did (tests) */
export const lighthouseStats = { begun: 0, jumps: 0, slips: 0, gaveUp: 0, top: 0, back: 0, stuck: 0, rests: 0, died: 0 };

/** may the bot go now: Agility 35+, Hitpoints 30+ (base) and above the largest slip now, 3+ food carried. No dice. */
export function mayLighthouse(player: Player): boolean {
    return getBaseLevel(player, PlayerStat.AGILITY) >= LIGHTHOUSE_AGILITY && getBaseLevel(player, PlayerStat.HITPOINTS) >= LIGHTHOUSE_HP && player.levels[PlayerStat.HITPOINTS] > LIGHTHOUSE_SLIP_HIT && carriedFood(player) >= LIGHTHOUSE_FOOD;
}

/** in the causeway's box (the Rellekka side's south end, the rocks, the island, the lighthouse) */
function inLighthouseBox(player: Player): boolean {
    const [x0, z0, x1, z1] = PeriodPlaces.LIGHTHOUSE_BOX;
    return player.x >= x0 && player.x <= x1 && player.z >= z0 && player.z <= z1;
}

/** across the causeway (on its rocks or the island) */
export function acrossCauseway(player: Player): boolean {
    if (!inLighthouseBox(player)) return false;
    return player.level > 0 || player.z > SHORE_Z;
}

type Phase = 'walk' | 'north' | 'island' | 'door-in' | 'up1' | 'up2' | 'top' | 'down1' | 'down0' | 'door-out' | 'to-south' | 'south' | 'done';

export class LighthouseTask extends BotTask {
    private phase: Phase = 'walk';
    private index = 0;
    private slips = 0;
    private tries = 0;
    private clickAt = -100;
    /** a jump clicked: where it stood, its Hitpoints, and whether the jump's script has held it since (the walk to the rock first) */
    private before: { x: number; z: number; level: number; hp: number; held: boolean } | null = null;
    private topUntil = -1;
    private readonly stuck = new StuckDetector(40, 4, 3);
    private going = true;
    private started = false;
    /** the south jumps' rounds of failed clicks (then the rescue jump) */
    private southStuck = 0;
    /** standing to get its Hitpoints back before a slip spot (no food left: southbound) */
    private resting = false;

    constructor() {
        super('Lighthouse');
    }

    get state(): unknown {
        return this.phase;
    }

    /** "there": at the causeway's south end or past it */
    at(player: Player): boolean {
        const [sx, sz] = PeriodPlaces.CAUSEWAY_SOUTH_END;
        return acrossCauseway(player) || (player.level === 0 && Math.max(Math.abs(player.x - sx), Math.abs(player.z - sz)) <= 3);
    }

    /** across, on its way back: BuzzTask keeps ticking it after the visit's end */
    returning(player: Player): boolean {
        return this.phase !== 'done' && acrossCauseway(player);
    }

    shouldRun(_player: Player): boolean {
        return this.phase !== 'done' && !this.interrupted;
    }

    isComplete(_player: Player): boolean {
        return this.phase === 'done';
    }

    /** the visit is over (its time, the planner): back across first, by the jumps */
    finish(player: Player, _why: string): void {
        this.going = false;
        if (!acrossCauseway(player)) {
            this._done(player);
            return;
        }
        if (this.phase === 'north') this._turnBack();
        else if (this.phase === 'top' || this.phase === 'island') this.phase = player.level === 2 ? 'down1' : player.level === 1 ? 'down0' : this.phase === 'island' ? 'to-south' : this.phase;
    }

    tick(player: Player): void {
        if (this.phase === 'done') return;
        const now = World.currentTick;
        if (!this.started) {
            this.started = true;
            lighthouseStats.begun++;
        }
        // (a page of the game's (a slip's message is none): continued; a script under way (a jump's exactmove): wait)
        if (this.before && (player.delayed || botScript(player))) this.before.held = true;
        if (botContinuePage(player) || player.delayed || botScript(player)) return;
        // (died all the same (a slip at 1-10 Hitpoints): the respawn far from the causeway; the visit over, no jump judged
        // from there and no rescue jump back)
        if (this.phase !== 'walk' && !inLighthouseBox(player)) {
            lighthouseStats.died++;
            this.going = false;
            this.before = null;
            this._done(player);
            return;
        }
        // (a slip hurts: below half, a bite)
        if (player.levels[PlayerStat.HITPOINTS] * 2 < player.baseLevels[PlayerStat.HITPOINTS] && this._eat(player, now)) return;
        if (acrossCauseway(player)) {
            if (!eventRoleOf(player)) setRole(player, LIGHTHOUSE_ROLE);
        } else if (this.phase !== 'walk' && this.phase !== 'north' && this.phase !== 'south') {
            // (back on the Rellekka side out of turn: done)
            this._done(player);
            return;
        }
        switch (this.phase) {
            case 'walk':
                this._walk(player, PeriodPlaces.CAUSEWAY_SOUTH_END[0], PeriodPlaces.CAUSEWAY_SOUTH_END[1]);
                if (this.at(player)) {
                    this.phase = 'north';
                    this.index = 0;
                }
                return;
            case 'north':
                return this._jumps(player, now, PeriodPlaces.CAUSEWAY_NORTH, 1);
            case 'south':
                return this._jumps(player, now, PeriodPlaces.CAUSEWAY_SOUTH, -1);
            case 'island':
                if (!this.going) {
                    this.phase = 'to-south';
                    return;
                }
                if (player.z >= DOOR_OUT[1] - 1 && Math.abs(player.x - DOOR_OUT[0]) <= 1) {
                    this.phase = 'door-in';
                    this.tries = 0;
                    return;
                }
                this._walk(player, DOOR_OUT[0], DOOR_OUT[1]);
                return;
            case 'door-in':
                return this._loc(player, now, 'horror_lighthouse_doorway', 2509, 3636, 0, 1, () => player.z >= 3636, 'up1');
            case 'up1':
                return this._loc(player, now, 'horror_lighthouse_spiralstairs_base', STAIRS[0], STAIRS[1], 0, 1, () => player.level === 1, 'up2');
            case 'up2':
                return this._loc(player, now, 'horror_lighthouse_spiralstairs_middle', STAIRS[0], STAIRS[1], 1, 2, () => player.level === 2, 'top');
            case 'top':
                if (this.topUntil < 0) {
                    this.topUntil = now + randInt(TOP_TICKS[0], TOP_TICKS[1]);
                    lighthouseStats.top++;
                    if (Math.random() < 0.4) sayBuzzLine(player, 'lighthouse-top', 'lighthouse', randInt(5, 20));
                }
                if (now >= this.topUntil || !this.going) this.phase = 'down1';
                return;
            case 'down1':
                return this._loc(player, now, 'horror_lighthouse_spiralstairs_top', STAIRS[0], STAIRS[1] + 1, 2, 1, () => player.level === 1, 'down0');
            case 'down0':
                return this._loc(player, now, 'horror_lighthouse_spiralstairs_middle', STAIRS[0], STAIRS[1], 1, 3, () => player.level === 0, 'door-out');
            case 'door-out':
                if (player.z < 3636) {
                    this.phase = 'to-south';
                    return;
                }
                return this._loc(player, now, 'horror_lighthouse_doorway', 2509, 3636, 0, 1, () => player.z < 3636, 'to-south');
            case 'to-south': {
                const [, sx, sz] = PeriodPlaces.CAUSEWAY_SOUTH[0];
                if (Math.max(Math.abs(player.x - sx), Math.abs(player.z - sz)) <= 1) {
                    this.phase = 'south';
                    this.index = 0;
                    return;
                }
                this._walk(player, sx, sz);
                return;
            }
        }
    }

    /** the jumps of `spots` (north: +1, the z each jump gains; south: -1): each its loc's Jump-across */
    private _jumps(player: Player, now: number, spots: readonly [number, number, number][], dir: 1 | -1): void {
        if (this.before) {
            // (judged once the jump's script has run: the walk to its rock comes first; none within JUMP_WAIT: tried again)
            if (now - this.clickAt < 3 || (!this.before.held && now - this.clickAt < JUMP_WAIT)) return;
            const b = this.before;
            this.before = null;
            const dz = player.z - b.z;
            const moved = Math.max(Math.abs(player.x - b.x), Math.abs(dz));
            const hurt = player.levels[PlayerStat.HITPOINTS] < b.hp;
            // (a jump lands 2-3 tiles on, north, south or across: spots 5 and 6 jump west and east; a slip hurts and
            // the tide sweeps the bot back 4-5 tiles)
            if (b.held && moved >= 2 && dz * dir > -3 && !hurt) {
                lighthouseStats.jumps++;
                this.index++;
                this.tries = 0;
            } else if (hurt || dz * dir <= -3) {
                // a slip: the tide back (north: to the shore; south: onto the island's rocks), from the first jump again
                this.slips++;
                lighthouseStats.slips++;
                this.index = 0;
                this.tries = 0;
                if (Math.random() < 0.6) sayBuzzLine(player, 'lighthouse-slip', 'lighthouse', randInt(3, 8));
                if (dir === 1 && this.slips >= LIGHTHOUSE_SLIPS) {
                    this._giveUp(player);
                    return;
                }
            } else if (++this.tries >= TRIES) {
                lighthouseStats.stuck++;
                this.going = false;
                if (dir === 1 && !acrossCauseway(player)) this._done(player);
                else if (dir === 1) this._turnBack();
                else if (++this.southStuck >= TRIES) {
                    // (no jump south takes: the bot is across with no walk back; a rescue jump, unseen and counted)
                    teleportNear(player, PeriodPlaces.CAUSEWAY_SOUTH_END[0], PeriodPlaces.CAUSEWAY_SOUTH_END[1], 0);
                    this._done(player);
                } else this.tries = 0;
                return;
            }
        }
        if (this.index >= spots.length) {
            if (dir === 1) {
                this.phase = 'island';
                if (Math.random() < 0.5) sayBuzzLine(player, 'lighthouse-made', 'lighthouse', randInt(3, 10));
            } else {
                lighthouseStats.back++;
                this._done(player);
            }
            return;
        }
        // (a slip north lands short of spot 1's rock: walked to it; the next jump's rock is beside the last landing)
        const [spot, sx, sz] = spots[this.index];
        const loc = findLocByName(sx, sz, player.level, `horror_jumping_spot${spot}`, 1);
        if (!loc) {
            lighthouseStats.stuck++;
            this.going = false;
            this._done(player);
            return;
        }
        // (a slip spot still ahead and Hitpoints at or under the largest slip: a bite first; no food left, northbound it
        // gives up (on the shore, or back by the south spots, none of which slips there), southbound it stands where it
        // is (the island, a rock) and gets its Hitpoints back, 1 a minute)
        if (player.levels[PlayerStat.HITPOINTS] <= LIGHTHOUSE_SLIP_HIT && spots.slice(this.index).some(([n]) => PeriodPlaces.CAUSEWAY_SLIPS.includes(n))) {
            if (carriedFood(player) > 0) {
                this._eat(player, now);
                return;
            }
            if (dir === 1) {
                this._giveUp(player);
                return;
            }
            if (!this.resting) {
                this.resting = true;
                lighthouseStats.rests++;
            }
            return;
        }
        this.resting = false;
        if (this.index === 0 && Math.max(Math.abs(player.x - sx), Math.abs(player.z - sz)) > 3) {
            this._walk(player, sx, sz);
            return;
        }
        if (now - this.clickAt < 4) return;
        this.clickAt = now;
        this.before = { x: player.x, z: player.z, level: player.level, hp: player.levels[PlayerStat.HITPOINTS], held: false };
        interactLoc(player, loc);
    }

    /** northbound, given up (its slips, or too hurt with no food): a line, then done on the shore or back by the jumps */
    private _giveUp(player: Player): void {
        lighthouseStats.gaveUp++;
        sayBuzzLine(player, 'lighthouse-giveup', 'lighthouse', randInt(4, 10));
        this.going = false;
        if (!acrossCauseway(player)) this._done(player);
        else this._turnBack();
    }

    /** north `k` jumps done, cut short: back by the south spots from the pair it is at */
    private _turnBack(): void {
        this.phase = 'south';
        this.index = Math.max(0, PeriodPlaces.CAUSEWAY_SOUTH.length - this.index);
        this.before = null;
        this.tries = 0;
    }

    /** a loc's op (`name` near x, z on `level`) until `done()`, then `next`; TRIES clicks that changed nothing: back */
    private _loc(player: Player, now: number, name: string, x: number, z: number, level: number, op: 1 | 2 | 3, done: () => boolean, next: Phase): void {
        if (done()) {
            this.phase = next;
            this.tries = 0;
            this.clickAt = -100;
            return;
        }
        if (now - this.clickAt < 6) return;
        const loc = findLocByName(x, z, level, name, 3);
        if (!loc || ++this.tries > TRIES) {
            lighthouseStats.stuck++;
            this.going = false;
            // (stuck inside: down and out as it can; else to the south jumps)
            this.phase = player.level > 0 ? (player.level === 2 ? 'down1' : 'down0') : player.z >= 3636 ? 'door-out' : 'to-south';
            if (this.tries > TRIES * 3) this._done(player);
            return;
        }
        this.clickAt = now;
        if (op === 1) interactLoc(player, loc);
        else interactLocOp(player, loc, op);
    }

    private _walk(player: Player, x: number, z: number): void {
        if (player.hasWaypoints()) return;
        if (!this.stuck.check(player, x, z)) walkTo(player, x, z, player.level);
        else if (this.stuck.desperatelyStuck && !acrossCauseway(player)) {
            // (lost on the Rellekka side: the visit is given up, no rescue jump)
            lighthouseStats.stuck++;
            this._done(player);
        } else {
            player.clearWaypoints();
            walkTo(player, x, z, player.level);
        }
    }

    private _eat(player: Player, now: number): boolean {
        if (now - this.clickAt < 3) return false;
        const inv = player.getInventory(InvType.INV);
        if (!inv) return false;
        const food = new Set(edibleFoodIds());
        for (let slot = 0; slot < inv.capacity; slot++) {
            const it = inv.get(slot);
            if (it && food.has(it.id)) {
                this.clickAt = now;
                interactHeldOp(player, inv, it.id, slot, 1);
                return true;
            }
        }
        return false;
    }

    private _done(player: Player): void {
        this.phase = 'done';
        if (eventRoleOf(player)?.role === LIGHTHOUSE_ROLE) clearRole(player);
    }
}
