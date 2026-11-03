// port (bots ideas, round 3, theme G: the update buzz, the H builder's): Rellekka's rock crabs, the fight the Fremennik Trials of 2 Nov 2004 opened and every
// fighter of combat 15-60 talked about. tasks/BuzzTask wraps it (its name `Combat:buzz:crabs`).
//
// 274's crabs are "Rocks" (horror_rockcrab[_small]_inactive: no op, huntrange 1, aggressive) that turn into the Rock Crab
// (horror_rockcrab[_small]: level 13, 50 HP, op2 Attack) when one hunts a player (ai_applayer2). An NPC hunts only while a
// real client's NPC list holds it (engine World.ts: getNpcObservers), and bots have no client: the crabs wake for a bot
// exactly when the human can see them, and fight it as a player's. Unobserved, nothing wakes, nothing is fought and no XP
// comes: nobody sees it, and nothing is faked.
//
// So the bot does what 2004's crab fighters did between crabs: it walks by the rocks to wake them. While no woken crab is
// within WAKE_TILES (and nothing attacks it), every 15-35 s it steps to a free tile beside another "Rocks" 2-8 tiles off
// (rock-hopping: a claimed tile, port/BotTiles). When a crab wakes and targets it, or wakes within WAKE_TILES with no other
// player on it, it clicks Attack (op2) on that crab and the fight is the game's (its style for the stat it trains: the
// lowest of its melee three), a bite below half its Hitpoints, its drop taken after the kill (coins, stacks, anything of
// 20 gp or more: the fighters' rule). (CombatTask's own search matches NPC names by prefix, and every crab's name is a
// prefix of its sleeping form's: it clicked the "Rocks", which have no Attack.)
// The plan's XP watchdog is BuzzTask's keep hook's (port/BotPeriodPlan keptPeriodTask): a quiet stint at the rocks is no
// stall. Half the bots go to the west group (20 crabs), half to the east (14).
import { BotTask, Player, walkTo, StuckDetector, randInt, PlayerStat, getBaseLevel } from '#/engine/bot/tasks/BotTaskBase.js';
import type { SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import Npc from '#/engine/entity/Npc.js';
import NpcType from '#/cache/config/NpcType.js';
import World from '#/engine/World.js';
import { findAggressorNpc, findLootObj, findNpcFiltered, interactHeldOp, interactNpcOp, interactObjOp, setCombatStyle } from '#/engine/bot/BotAction.js';
import ObjType from '#/cache/config/ObjType.js';
import { InvType, edibleFoodIds } from '#/engine/bot/tasks/BotTaskBase.js';
import { BuzzPlaces, OUTING_STEPS } from '#/engine/bot/BotKnowledge.js';
import { combatWeaponFor, fitToFight } from '#/engine/bot/tasks/CombatTask.js';
import { claimStandTile, releaseStandTile, stepToTile } from '#/engine/bot/port/BotTiles.js';
import { sayBuzzLine } from '#/engine/bot/tasks/BuzzTask.js';

/** a crab's waking (a fight with a woken one begins): a line this often; a rock-hop: this often */
const WOKE_LINE = 0.3;
const WAIT_LINE = 0.02;

/** after a kill its drop is looted for at most this long (ticks); worth a Take from this many gp (or a stack) */
const LOOT_TICKS = 12;
const LOOT_COST = 20;
/** the attack style for the stat it trains (274's com_mode: accurate, aggressive, defensive) */
const STYLE: Partial<Record<number, 0 | 1 | 2 | 3>> = { [PlayerStat.ATTACK]: 0, [PlayerStat.STRENGTH]: 1, [PlayerStat.DEFENCE]: 3 };
/** a woken crab this near (tiles) is fought */
export const WAKE_TILES = 6;
/** a rock-hop every this many ticks (15-35 s) */
export const HOP_TICKS: [number, number] = [25, 58];
/** to a rock this far (tiles) */
const HOP_FROM = 2;
const HOP_TO = 8;
/** within this of the group's centre the bot is at the crabs */
export const CRABS_NEAR = 14;
/** the crabs' combat band (G-content §5) */
export const CRAB_COMBAT: [number, number] = [15, 60];

export type CrabGroup = 'west' | 'east';

/** what the crab fighters did (tests, the runner's PC2 detail) */
export const crabStats = { begun: 0, hops: 0, fights: 0, woke: 0, ended: {} as Record<string, number> };

const ACTIVE = ['horror_rockcrab', 'horror_rockcrab_small'];
const ROCKS = ['horror_rockcrab_inactive', 'horror_rockcrab_small_inactive'];
let activeIds: Set<number> | null = null;
let rockIds: Set<number> | null = null;
function ids(): { active: Set<number>; rocks: Set<number> } {
    if (!activeIds || !rockIds) {
        activeIds = new Set(ACTIVE.map(n => NpcType.getId(n)).filter(i => i !== -1));
        rockIds = new Set(ROCKS.map(n => NpcType.getId(n)).filter(i => i !== -1));
    }
    return { active: activeIds, rocks: rockIds };
}

/** a woken crab (its Rock Crab form) */
export function isWokenCrab(npc: Npc): boolean {
    return ids().active.has(npc.type);
}
/** a crab asleep ("Rocks") */
export function isCrabRock(npc: Npc): boolean {
    return ids().rocks.has(npc.type);
}

/** the step of a group (OUTING_STEPS' crab steps) */
export function crabStep(group: CrabGroup): SkillStep {
    return OUTING_STEPS[`rellekka-crabs-${group}`];
}

/** the melee stat a crab fighter trains: its lowest of the three, as the far towns' fights pick */
function fightStat(player: Player): PlayerStat {
    const stats = [PlayerStat.ATTACK, PlayerStat.STRENGTH, PlayerStat.DEFENCE];
    return stats.reduce((a, b) => (getBaseLevel(player, b) < getBaseLevel(player, a) ? b : a));
}

/** may the bot fight crabs now: combat 15-60, a weapon, fit to fight (food or Hitpoints). No dice. */
export function mayCrab(player: Player): boolean {
    if (player.combatLevel < CRAB_COMBAT[0] || player.combatLevel > CRAB_COMBAT[1]) return false;
    const step = crabStep('west');
    return combatWeaponFor(player, step) !== null && fitToFight(player, step);
}

/** the group with fewer of the crab fighters `out` there (the west on a tie) */
export function crabGroupFor(out: readonly Player[]): CrabGroup {
    let west = 0;
    let east = 0;
    for (const p of out) {
        const g = groupOf.get(p);
        if (g === 'west') west++;
        else if (g === 'east') east++;
    }
    return east < west ? 'east' : 'west';
}
const groupOf = new WeakMap<Player, CrabGroup>();

export class CrabTask extends BotTask {
    readonly group: CrabGroup;
    private readonly step: SkillStep;
    private readonly stat: PlayerStat;
    private readonly stuck = new StuckDetector(40, 4, 3);
    private nextHop = -1;
    private done = false;
    /** the rock it last stood by (another next time) */
    private lastRock = -1;
    /** the crab it fights (the woken NPC), and where it last stood (its drop falls there) */
    private crab: Npc | null = null;
    private crabAt: [number, number] = [0, 0];
    private crabSince = -1;
    /** a drop being looted: until when */
    private lootUntil = -1;
    private clickAt = -100;

    constructor(group: CrabGroup, player: Player | null = null) {
        super('Combat');
        this.group = group;
        this.step = crabStep(group);
        this.stat = player ? fightStat(player) : PlayerStat.ATTACK;
        if (player) groupOf.set(player, group);
    }

    get state(): unknown {
        return this.crab ? 'interact' : this.lootUntil >= 0 ? 'loot' : 'rocks';
    }

    override activityStep(): SkillStep | null {
        return this.step;
    }

    /** at the crabs (within CRABS_NEAR of the group's middle) */
    at(player: Player): boolean {
        const [cx, cz] = BuzzPlaces.CRAB_GROUPS[this.group];
        return player.level === 0 && Math.max(Math.abs(player.x - cx), Math.abs(player.z - cz)) <= CRABS_NEAR;
    }

    /** a weapon, and food or Hitpoints to fight on (CombatTask's rules: combatWeaponFor, fitToFight) */
    shouldRun(player: Player): boolean {
        return !this.done && !this.interrupted && combatWeaponFor(player, this.step) !== null && (this.crab !== null || fitToFight(player, this.step, false));
    }

    isComplete(_player: Player): boolean {
        return this.done;
    }

    override reset(): void {
        super.reset();
        this.crab = null;
        this.nextHop = -1;
        this.lootUntil = -1;
    }

    /** a full pack: BuzzTask ends the visit (no bank at Rellekka in 2004: the next plan banks the load) */
    banking(): boolean {
        const p = this.lastPlayer;
        const inv = p?.getInventory(InvType.INV);
        return !!inv && inv.freeSlotCount === 0 && this.crab === null;
    }
    private lastPlayer: Player | null = null;

    tick(player: Player): void {
        if (this.done || this.interrupted) return;
        this.lastPlayer = player;
        const now = World.currentTick;
        if (player.delayed) return;
        // (hurt below half: a bite, between the crab's hits as players ate)
        if (player.levels[PlayerStat.HITPOINTS] * 2 < player.baseLevels[PlayerStat.HITPOINTS] && now - this.clickAt >= 3 && this._eat(player)) {
            this.clickAt = now;
            return;
        }
        const [cx, cz] = BuzzPlaces.CRAB_GROUPS[this.group];
        if (!this.at(player) && this.crab === null) {
            if (!this.stuck.check(player, cx, cz)) walkTo(player, cx, cz, 0);
            else if (this.stuck.desperatelyStuck) {
                // (lost on the way: the visit is given up where it is, no rescue jump: the next plan's walk is its own)
                this.finish(player, 'stuck');
            } else {
                player.clearWaypoints();
                walkTo(player, cx, cz, 0);
            }
            return;
        }
        // ── a crab it fights: the engine's fight goes on while it is the bot's target; when it is gone, its drop ──
        if (this.crab) {
            const c = this.crab;
            if (c.isValid() && isWokenCrab(c)) this.crabAt = [c.x, c.z];
            const over = !c.isValid() || !isWokenCrab(c) || (now - this.crabSince > 20 && player.target !== c && c.target !== player);
            if (!over) {
                // (it lost the click (the crab walked off a tile): Attack again, a person's moment later)
                if (player.target !== c && now - this.clickAt >= randInt(3, 6)) {
                    interactNpcOp(player, c, 2);
                    this.clickAt = now;
                }
                return;
            }
            this.crab = null;
            this.lootUntil = now + LOOT_TICKS;
            return;
        }
        if (this.lootUntil >= 0) {
            if (now < this.lootUntil && this._loot(player, now)) return;
            this.lootUntil = -1;
        }
        // ── a crab woken near, or one at it: Attack (op2), the fight the game's ──
        const attacker = findAggressorNpc(player, 2);
        const woken = attacker && isWokenCrab(attacker) ? attacker : findNpcFiltered(player.x, player.z, player.level, npc => isWokenCrab(npc) && (npc.target === null || npc.target === player), WAKE_TILES);
        if (woken) {
            this.crab = woken;
            this.crabAt = [woken.x, woken.z];
            this.crabSince = now;
            crabStats.fights++;
            crabStats.woke++;
            releaseStandTile(player);
            setCombatStyle(player, STYLE[this.stat] ?? 0);
            if (player.target !== woken) {
                interactNpcOp(player, woken, 2);
                this.clickAt = now;
            }
            if (Math.random() < WOKE_LINE) sayBuzzLine(player, 'crabs-woke', 'crabs', randInt(2, 6));
            return;
        }
        this._rockHop(player);
    }

    /** its crab's drop (coins, stacks, anything of 20 gp or more: the fighters' rule), a Take each, while there is one */
    private _loot(player: Player, now: number): boolean {
        if (player.hasWaypoints() || player.target !== null) return true;
        if (now - this.clickAt < 2) return true;
        const inv = player.getInventory(InvType.INV);
        if (!inv || inv.freeSlotCount === 0) return false;
        const obj = findLootObj(player, this.crabAt[0], this.crabAt[1], player.level, 2, o => {
            if (o.receiver64 !== player.hash64) return false;
            const t = ObjType.get(o.type);
            return t.stackable || t.cost >= LOOT_COST;
        });
        if (!obj) return false;
        interactObjOp(player, obj, 3);
        this.clickAt = now;
        return true;
    }

    private _eat(player: Player): boolean {
        const inv = player.getInventory(InvType.INV);
        if (!inv) return false;
        const food = new Set(edibleFoodIds());
        for (let slot = 0; slot < inv.capacity; slot++) {
            const it = inv.get(slot);
            if (it && food.has(it.id)) {
                interactHeldOp(player, inv, it.id, slot, 1);
                return true;
            }
        }
        return false;
    }

    /** every 15-35 s, a step to a free tile beside another "Rocks" 2-8 tiles off */
    private _rockHop(player: Player): void {
        const now = World.currentTick;
        if (player.hasWaypoints()) return;
        if (this.nextHop < 0) this.nextHop = now + randInt(HOP_TICKS[0] >> 1, HOP_TICKS[1] >> 1);
        if (now < this.nextHop) return;
        this.nextHop = now + randInt(HOP_TICKS[0], HOP_TICKS[1]);
        const [cx, cz] = BuzzPlaces.CRAB_GROUPS[this.group];
        const rock = findNpcFiltered(player.x, player.z, player.level, npc => {
            if (!isCrabRock(npc) || npc.nid === this.lastRock) return false;
            const d = Math.max(Math.abs(npc.x - player.x), Math.abs(npc.z - player.z));
            return d >= HOP_FROM && d <= HOP_TO && Math.max(Math.abs(npc.x - cx), Math.abs(npc.z - cz)) <= CRABS_NEAR;
        }, HOP_TO);
        // (none in reach: back towards the group's middle, where they are)
        const [tx, tz] = rock ? [rock.x, rock.z] : [cx + randInt(-3, 3), cz + randInt(-3, 3)];
        const tile = claimStandTile(player, tx, tz, player.level, 1, (x, z) => x !== tx || z !== tz);
        if (!tile) return;
        if (rock) this.lastRock = rock.nid;
        crabStats.hops++;
        stepToTile(player, tile[0], tile[1]);
        if (Math.random() < WAIT_LINE) sayBuzzLine(player, 'crabs-wait', 'crabs', randInt(4, 15));
    }

    /** the visit is over (BuzzTask: its time, a full pack): its tile given back */
    finish(player: Player, why: string): void {
        if (this.done) return;
        this.done = true;
        releaseStandTile(player);
        crabStats.ended[why] = (crabStats.ended[why] ?? 0) + 1;
    }
}
