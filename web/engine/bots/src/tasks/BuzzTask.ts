// port (bots ideas, round 3, theme G: the update buzz, the H builder's): the world is always 23 Nov 2004, three weeks after the Fremennik Trials and six days after
// Horror from the Deep: Rellekka, its rock crabs and the lighthouse were where everyone went to look. A buzz visit is one
// of the update's draws, on a budget of its own (port/BotPeriod: 2 out at 100 online, 15 at 500, 36 at 1000), offered at
// the planner's ask (port/BotPeriodPlan periodTaskFor) from the entries registered here:
//   crabs       weight 3, combat 15-60, at most 1.2 per 100 online (6 at 500): tasks/CrabTask, 20-40 minutes
//   rellekka    weight 2: sightseeing, 3-4 stops over 6-12 minutes (the square, the market, the longhall's door, the
//               piers, Skulgrimen's), now and then a beer bought at the longhall (its barkeep's Trade: the shop's own
//               price, 2 gp) and drunk (its Drink: the game's own drunk stats)
//   lighthouse  weight 1, Agility 35+, Hitpoints 30+, 3+ food, at most 0.4 per 100: tasks/LighthouseTask (the causeway's
//               jumps, the door, the stairs; never Jossik)
// The walk there is walkTo's (the walking graph, minimap hops near the human; a real Camelot teleport for a bot with the
// Magic and the runes: port/BotTeleport decides). BuzzTask wraps the visit's own task as OutingTask does a far town's:
// its name is the task's kind with ':buzz:<key>' after it (`Combat:buzz:crabs`), so the planner, the chatter and the
// runner see a crab fight as a fight; it keeps the time, says where it is going and that it got there now and then
// (sayBuzzLine: kind 'setpiece', out of H7, in X2, in the place of its next unprompted line), and ends at its time, when
// the task is over, or when the task would bank (no bank at Rellekka in 2004: the next plan banks the load). Its start
// and end are port/BotPeriod's notePeriodStart/End (the budget, PC1, PC10). A line of the buzz heard by a bot within 15
// tiles boosts that bot's buzz offer for its session (port/BotPeriod buzzBoost: theme D's word that travels, through the
// arcs bus's 'said' event, the line's tag {kind: 'buzz', id: key}).
// Theme G's switch first (periodOn) in every hook: off, nothing here draws a die.
import { BotTask, Player, walkTo, StuckDetector, randInt, countItem, Items, InvType, findNpcByName, interactNpcOp, buyFromOpenShop, openShopStock, carriedFood, getBaseLevel, PlayerStat } from '#/engine/bot/tasks/BotTaskBase.js';
import type { SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import World from '#/engine/World.js';
import ObjType from '#/cache/config/ObjType.js';
import { interactHeldOp, botScript } from '#/engine/bot/BotAction.js';
import { BuzzPlaces, MembersPlaces } from '#/engine/bot/BotKnowledge.js';
import { buzzBoost, buzzBoostOf, buzzTaskName, notePeriodEnd, notePeriodStart, periodOn, periodOutOn, registerPeriodEntry, BUZZ_EVENT } from '#/engine/bot/port/BotPeriod.js';
import { arcLines, sayArcLine } from '#/engine/bot/port/BotArcsSay.js';
import { onArcs } from '#/engine/bot/port/BotArcsEvents.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { botPersona } from '#/engine/bot/port/BotTiming.js';
import { worldPlayers } from '#/engine/bot/port/BotPlayers.js';
import { claimStandTile, releaseStandTile, stepToTile } from '#/engine/bot/port/BotTiles.js';
import { findNearestWalkableTile } from '#/engine/bot/BotNavigation.js';
import { CrabTask, crabGroupFor, mayCrab } from '#/engine/bot/tasks/CrabTask.js';
import { LighthouseTask, mayLighthouse } from '#/engine/bot/tasks/LighthouseTask.js';

// ── the lines ─────────────────────────────────────────────────────────────────

/**
 * The bot says a fresh line of the buzz's `kind` (data/lines2004-buzz.json, event 'buzz') now or after `delay`: kind
 * 'setpiece' (out of H7, counted in X2), budgeted (its next due line pushed out), tagged {kind: 'buzz', id: key} for the
 * bots that hear it. Null when theme G is off, on a free world, or with none fresh.
 */
export function sayBuzzLine(bot: Player, kind: string, key: string, delay = 2, to: Player | null = null): string | null {
    if (!periodOn() || !isMembersWorld()) return null;
    return sayArcLine(bot, arcLines(BUZZ_EVENT, kind), {}, { kind: 'setpiece', budget: 'budgeted', delay, to, arc: { kind: 'buzz', id: key } });
}

/** a buzz line heard within this many tiles, by a bot that may go, boosts its offer with this chance (+ curiosity's) */
export const HEAR_TILES = 15;
const HEAR_BASE = 0.6;
const HEAR_CURIOSITY = 0.3;
export const buzzHeard = { lines: 0, boosted: 0 };

// (theme D's word that travels: the buzz's lines carry their key; a bot near that hears one goes more often, for its session)
onArcs('said', e => {
    if (e.arc?.kind !== 'buzz' || !periodOn()) return;
    const speaker = e.bot;
    const key = typeof e.arc.id === 'string' ? e.arc.id : null;
    buzzHeard.lines++;
    for (const p of worldPlayers()) {
        if (p === speaker || p.is_bot !== true || p.level !== speaker.level || Math.max(Math.abs(p.x - speaker.x), Math.abs(p.z - speaker.z)) > HEAR_TILES) continue;
        if (!isLevelling(p.botPlanner as PlannerKey) || buzzBoostOf(p).factor > 1) continue;
        if (Math.random() >= HEAR_BASE + HEAR_CURIOSITY * botPersona(p).curiosity) continue;
        buzzBoost(p, key);
        buzzHeard.boosted++;
    }
});

// ── the wrapper ───────────────────────────────────────────────────────────────

/** a visit's minutes (world minutes, drawn once) by key, counted from its arrival; the way there at most TRAVEL_TICKS */
const MINUTES: Readonly<Record<string, [number, number]>> = { crabs: [20, 40], rellekka: [6, 12], lighthouse: [10, 25] };
const TRAVEL_TICKS = 2400;
/** a line on setting out, on arriving, on leaving: this often */
const GO_LINE = 0.35;
const THERE_LINE = 0.3;
const LEAVE_LINE = 0.3;

/** the visit's own task, as BuzzTask drives it */
interface BuzzInner extends BotTask {
    at(player: Player): boolean;
    banking?(): boolean;
    finish?(player: Player, why: string): void;
    /** on its way back where no walk leads (the lighthouse's causeway): ticked on after the visit's end */
    returning?(player: Player): boolean;
}

/** the visits so far and how they ended (tests) */
export const buzzTaskStats = { begun: 0, arrived: 0, ended: {} as Record<string, number> };

export class BuzzTask extends BotTask {
    readonly key: string;
    readonly inner: BuzzInner;
    private phase: 'travel' | 'there' | 'leave' | 'done' = 'travel';
    private started = false;
    private startedAt = -1;
    private endsAt = -1;
    private outcome = 'done';
    private player: Player | null = null;

    constructor(key: string, inner: BuzzInner) {
        super(buzzTaskName(inner.name.split(':')[0], key));
        this.key = key;
        this.inner = inner;
    }

    get state(): unknown {
        return this.phase === 'there' || this.phase === 'travel' ? (this.inner as unknown as { state?: unknown }).state : this.phase;
    }

    override activityStep(): SkillStep | null {
        try {
            return this.inner.activityStep();
        } catch {
            return null;
        }
    }

    shouldRun(player: Player): boolean {
        if (this.phase === 'done' || this.interrupted) return false;
        // (the visit's own task done: this one ends it in its next tick, the visit noted 'over')
        return this.phase === 'leave' || this.inner.shouldRun(player) || this.inner.isComplete(player);
    }

    isComplete(_player: Player): boolean {
        return this.phase === 'done';
    }

    override interrupt(): void {
        super.interrupt();
        this.inner.interrupt();
        this._end('interrupted');
    }

    override reset(): void {
        super.reset();
        if (this.started && this.phase !== 'done') this._end('reset');
        this.inner.reset();
    }

    tick(player: Player): void {
        if (this.interrupted || this.phase === 'done') return;
        this.player = player;
        const now = World.currentTick;
        if (!this.started) {
            this.started = true;
            this.startedAt = now;
            buzzTaskStats.begun++;
            notePeriodStart(player, this.key, 'buzz');
            if (Math.random() < GO_LINE) sayBuzzLine(player, `buzz-go-${this.key}`, this.key);
        }
        if (this.phase === 'leave') {
            // (across the causeway: its jumps back first)
            if (this.inner.returning?.(player) && !this.inner.isComplete(player)) {
                this.inner.tick(player);
                return;
            }
            this._end(this.outcome);
            return;
        }
        if (this.phase === 'travel') {
            if (this.inner.at(player)) {
                this.phase = 'there';
                buzzTaskStats.arrived++;
                const [lo, hi] = MINUTES[this.key] ?? [10, 20];
                this.endsAt = now + randInt(lo, hi) * 100;
                if (Math.random() < THERE_LINE) sayBuzzLine(player, `buzz-there-${this.key}`, this.key, randInt(3, 12));
            } else if (now - this.startedAt > TRAVEL_TICKS) {
                this._leave(player, 'travel');
                return;
            }
        }
        if (this.phase === 'there' && now >= this.endsAt) {
            this._leave(player, 'time');
            return;
        }
        if (this.inner.isComplete(player) || this.inner.interrupted || !this.inner.shouldRun(player)) {
            this._leave(player, 'over');
            return;
        }
        if (this.inner.banking?.()) {
            this._leave(player, 'bank');
            return;
        }
        this.inner.tick(player);
    }

    private _leave(player: Player, outcome: string): void {
        if (this.phase === 'leave' || this.phase === 'done') return;
        this.phase = 'leave';
        this.outcome = outcome;
        this.inner.finish?.(player, outcome);
        if (!this.inner.returning?.(player)) this.inner.interrupt();
        if (outcome !== 'travel' && Math.random() < LEAVE_LINE) sayBuzzLine(player, `buzz-leave-${this.key}`, this.key);
    }

    private _end(outcome: string): void {
        if (this.phase === 'done') return;
        this.phase = 'done';
        buzzTaskStats.ended[outcome] = (buzzTaskStats.ended[outcome] ?? 0) + 1;
        if (this.player) {
            this.inner.finish?.(this.player, outcome);
            notePeriodEnd(this.player, outcome);
        }
    }
}

// ── sightseeing at Rellekka ────────────────────────────────────────────────────

/** a stop: stood at this long (ticks: 1.5-3 minutes), 3-4 of them */
const STOP_TICKS: [number, number] = [90, 180];
const STOPS: [number, number] = [3, 4];
/** the beer: bought now and then at the longhall's stop (its barkeep's Trade), with this many coins carried */
const BEER_CHANCE = 0.4;
const BEER_COINS = 10;
/** within this of a stop the bot is there; of the square, at Rellekka */
const STOP_NEAR = 3;
const RELLEKKA_NEAR = 30;

export const tourStats = { tours: 0, stops: 0, beers: 0, drunk: 0 };

/** a sightseer's 3-4 stops at Rellekka (its name 'Sightsee') */
export class RellekkaTourTask extends BotTask {
    private readonly stops: [string, number, number][];
    private index = 0;
    private standUntil = -1;
    private readonly stuck = new StuckDetector(40, 4, 3);
    private done = false;
    /** the beer: 'want' (at the longhall), 'shop' (its window asked for), 'have' (bought), 'drunk' */
    private beer: 'no' | 'want' | 'shop' | 'have' | 'drunk' = 'no';
    private beerAt = -1;
    private hadTarget = false;

    constructor() {
        super('Sightsee');
        const pool = [...BuzzPlaces.RELLEKKA_STOPS];
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        this.stops = pool.slice(0, randInt(STOPS[0], STOPS[1]));
        tourStats.tours++;
    }

    get state(): unknown {
        return this.done ? 'done' : `stop-${this.stops[this.index]?.[0] ?? 'end'}`;
    }

    at(player: Player): boolean {
        const [sx, sz] = MembersPlaces.RELLEKKA_SQUARE;
        return player.level === 0 && Math.max(Math.abs(player.x - sx), Math.abs(player.z - sz)) <= RELLEKKA_NEAR;
    }

    shouldRun(_player: Player): boolean {
        return !this.done && !this.interrupted;
    }

    isComplete(_player: Player): boolean {
        return this.done;
    }

    finish(player: Player, _why: string): void {
        releaseStandTile(player);
        if (player.containsModalInterface()) player.closeModal();
    }

    tick(player: Player): void {
        if (this.done || this.interrupted) return;
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        const now = World.currentTick;
        if (this.beer === 'shop' || this.beer === 'have') {
            if (this._beer(player, now)) return;
        }
        const stop = this.stops[this.index];
        if (!stop) {
            this.done = true;
            return;
        }
        const [name, x, z] = stop;
        const near = Math.max(Math.abs(player.x - x), Math.abs(player.z - z));
        if (this.standUntil < 0) {
            if (near > STOP_NEAR) {
                // (a door opened on the way: the next click a person's moment later)
                if (this.hadTarget && player.target === null) {
                    this.hadTarget = false;
                    this.cooldown = randInt(1, 3);
                    return;
                }
                this.hadTarget = player.target !== null;
                const to = findNearestWalkableTile(0, x, z, 3) ?? { x, z };
                if (!this.stuck.check(player, to.x, to.z)) walkTo(player, to.x, to.z, 0);
                else if (this.stuck.desperatelyStuck) {
                    // (lost on the way: the sightseeing is given up where it is, no rescue jump)
                    this.done = true;
                } else {
                    player.clearWaypoints();
                    walkTo(player, to.x, to.z, 0);
                }
                return;
            }
            this.standUntil = now + randInt(STOP_TICKS[0], STOP_TICKS[1]);
            tourStats.stops++;
            const tile = claimStandTile(player, x, z, 0, 3);
            if (tile) stepToTile(player, tile[0], tile[1]);
            if (name === 'longhall' && this.beer === 'no' && countItem(player, Items.COINS) >= BEER_COINS && Math.random() < BEER_CHANCE) this.beer = 'want';
            return;
        }
        if (this.beer === 'want' && this._beer(player, now)) return;
        if (now >= this.standUntil) {
            releaseStandTile(player);
            this.index++;
            this.standUntil = -1;
            this.cooldown = randInt(1, 4);
        }
    }

    /** the beer at the longhall: its barkeep's Trade, one bought in its window, the window shut, drunk a while later */
    private _beer(player: Player, now: number): boolean {
        const beerId = ObjType.getId('beer');
        if (beerId === -1) {
            this.beer = 'drunk';
            return false;
        }
        if (this.beer === 'want') {
            const keep = findNpcByName(player.x, player.z, 0, 'viking_longhall_barkeep', 12);
            if (!keep) {
                this.beer = 'drunk';
                return false;
            }
            interactNpcOp(player, keep, 3);
            this.beer = 'shop';
            this.beerAt = now;
            return true;
        }
        if (this.beer === 'shop') {
            if (openShopStock(player)) {
                const had = countItem(player, beerId);
                buyFromOpenShop(player, beerId, 1);
                // (one bought: the window shut on its next tick)
                if (countItem(player, beerId) > had || now - this.beerAt > 6) {
                    if (countItem(player, beerId) > had) tourStats.beers++;
                    player.closeModal();
                    this.beer = countItem(player, beerId) > 0 ? 'have' : 'drunk';
                    this.beerAt = now + randInt(5, 25);
                }
                return true;
            }
            if (now - this.beerAt > 25) this.beer = 'drunk';
            return now - this.beerAt <= 25;
        }
        if (this.beer === 'have') {
            if (now < this.beerAt || player.delayed || botScript(player)) return false;
            const inv = player.getInventory(InvType.INV);
            const slot = inv ? Array.from({ length: inv.capacity }, (_, i) => i).find(i => inv.get(i)?.id === beerId) : undefined;
            if (inv && slot !== undefined) {
                interactHeldOp(player, inv, beerId, slot, 1);
                tourStats.drunk++;
                if (Math.random() < 0.5) sayBuzzLine(player, 'rellekka-beer', 'rellekka', randInt(3, 9));
            }
            this.beer = 'drunk';
            return true;
        }
        return false;
    }
}

// ── the registry (port/BotPeriod: the buzz's entries; port/BotPeriodIndex imports this module) ──────────────────

registerPeriodEntry({ key: 'crabs', kind: 'buzz', weight: 3, capPer100: 1.2, fits: p => mayCrab(p), make: p => new BuzzTask('crabs', new CrabTask(crabGroupFor(periodOutOn('crabs')), p)) });
registerPeriodEntry({ key: 'rellekka', kind: 'buzz', weight: 2, fits: () => true, make: () => new BuzzTask('rellekka', new RellekkaTourTask()) });
registerPeriodEntry({ key: 'lighthouse', kind: 'buzz', weight: 1, capPer100: 0.4, fits: p => mayLighthouse(p), make: () => new BuzzTask('lighthouse', new LighthouseTask()) });

/** (tests) the food a lighthouse visit asks for; Agility and Hitpoints (LighthouseTask's) */
export function buzzFitsForTest(p: Player): { crabs: boolean; lighthouse: boolean; food: number; agility: number } {
    return { crabs: mayCrab(p), lighthouse: mayLighthouse(p), food: carriedFood(p), agility: getBaseLevel(p, PlayerStat.AGILITY) };
}
