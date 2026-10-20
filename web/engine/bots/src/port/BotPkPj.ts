// port (PK tactics, round 2, 2026-10-19: "PJing"): 2004's pile jumpers, for both PK tasks. A PJer (about 1
// PKer in 5: port/BotPkFight pkWaysOf's pj) that sees two players fighting near it in single combat stands off a few
// tiles and waits; once the fight is over it jumps the one left (the other dead, gone, or off: it ran or teleported), or
// a hurt runner "on the way past", as soon as the game lets a third player on it: 274's pvp_in_combat_check refuses an
// attack on a player hit in the last 8 ticks by someone else ("Someone else is already fighting your opponent."), from
// its %lastcombat. The research (May 2005): "when you get the people running from a recent fight you can kill em on the
// way past", "wait until your target is getting attacked by another pker ..., then strike".
//
// The tasks decide who it may attack (their own rules: the combat range, its clique, a team, a claim); this module finds
// the fight, follows it and says when and whom to jump.
import Player from '#/engine/entity/Player.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import World from '#/engine/World.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import { isMultiCombat } from '#/engine/bot/port/BotContent.js';
import { pkFightStats } from '#/engine/bot/port/BotPkFight.js';

/** 274's single-way lock: no third player on one hit in the last 8 ticks (pvp_combat.rs2) */
export const PJ_LOCK = 8;
/** it waits for a fight this long (about 90 s), then gives up on it */
export const PJ_WAIT = 150;
/** it stands this far off the fight (tiles), and moves up once the fight is further than PJ_NEAR off */
const PJ_OFF = 4;
const PJ_NEAR = 7;

function chebyshev(ax: number, az: number, bx: number, bz: number): number {
    return Math.max(Math.abs(ax - bx), Math.abs(az - bz));
}

function attacks(p: Player, q: Player): boolean {
    return p.target === q && (p.targetOp === ServerTriggerType.APPLAYER2 || p.targetOp === ServerTriggerType.OPPLAYER2);
}

/** may a third player attack this one now: no hit on it for PJ_LOCK ticks (274's %lastcombat) */
export function pkFreeToJump(p: Player): boolean {
    const v = VarPlayerType.getByName('lastcombat');
    if (!v) return true;
    return (p.getVar(v.id) as number) + PJ_LOCK <= World.currentTick;
}

/** a fight a PJer watches */
export class PkPjWatch {
    readonly a: Player;
    readonly b: Player;
    private readonly since = World.currentTick;

    constructor(a: Player, b: Player) {
        this.a = a;
        this.b = b;
    }

    /**
     * Whom to jump now (the one left of the fight, the more hurt when both are; free of the lock and one it may
     * attack: `may`), null to wait on, or 'over' (both gone, or it waited PJ_WAIT ticks).
     */
    next(bot: Player, may: (p: Player) => boolean, radius: number): Player | null | 'over' {
        const near = (p: Player): boolean => p.slot !== -1 && p.level === bot.level && p.levels[PlayerStat.HITPOINTS] > 0 && chebyshev(bot.x, bot.z, p.x, p.z) <= radius;
        const left = [this.a, this.b].filter(near);
        if (left.length === 0 || World.currentTick - this.since > PJ_WAIT) return 'over';
        // (still at it: it waits)
        if (left.length === 2 && (attacks(this.a, this.b) || attacks(this.b, this.a))) return null;
        const share = (p: Player): number => p.levels[PlayerStat.HITPOINTS] / Math.max(1, p.baseLevels[PlayerStat.HITPOINTS]);
        const free = left.filter(pkFreeToJump);
        const ready = free.filter(may).sort((x, y) => share(x) - share(y));
        // (all free of the lock and none it may attack: another got there first, or out of its range: it gives up)
        if (ready.length === 0) return free.length === left.length ? 'over' : null;
        pkFightStats.pj.jumps++;
        return ready[0]!;
    }

    /** a tile a few off the fight on the bot's side, when it is further than PJ_NEAR off; else null (it stays) */
    spot(bot: Player): [number, number] | null {
        const mx = (this.a.x + this.b.x) >> 1;
        const mz = (this.a.z + this.b.z) >> 1;
        if (chebyshev(bot.x, bot.z, mx, mz) <= PJ_NEAR) return null;
        return [mx + Math.sign(bot.x - mx) * PJ_OFF, mz + Math.sign(bot.z - mz) * PJ_OFF];
    }
}

/**
 * The nearest fight within `radius` a PJer may watch: two players, one attacking the other, in single combat (in
 * multi-combat a PKer piles straight on: port/BotPkTeam), on its level, one of whom it may attack after (`may`).
 */
export function pkFightToWatch(bot: Player, radius: number, may: (p: Player) => boolean): PkPjWatch | null {
    let best: PkPjWatch | null = null;
    let bestDist = radius + 1;
    for (const p of World.playerLoop.all() as Iterable<Player>) {
        if (p === bot || p.slot === -1 || p.level !== bot.level) continue;
        const q = p.target;
        if (!(q instanceof Player) || q === bot || q.slot === -1 || !attacks(p, q)) continue;
        const d = chebyshev(bot.x, bot.z, p.x, p.z);
        if (d >= bestDist || isMultiCombat(p.x, p.z, p.level)) continue;
        if (!may(p) && !may(q)) continue;
        best = new PkPjWatch(p, q);
        bestDist = d;
    }
    if (best) pkFightStats.pj.watches++;
    return best;
}
