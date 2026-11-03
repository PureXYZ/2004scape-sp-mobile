/**
 * port (bots ideas, round 1, Track A: the period endgame) the dusty key, as a 2004 player got
 * it: 274 locks Taverley's deep part (its blue dragons, hellhounds, black demons and black dragons) behind the dusty-key
 * door (deepdungeondoor), and the key comes from Velrak the explorer, in the jail's cell:
 *   1. down the Taverley ladder and through the prison doors to the jail (264 steps from the floor);
 *   2. the jailer fought (his Attack clicked, food eaten when hurt) until his jail key lies on the ground (274's drop: the
 *      killer's, for 100 ticks),
 *      taken with the real op;
 *   3. the jail key used on the cell's door (dungeonjail: its script lets the player in);
 *   4. Velrak's Talk-to answered "So... do you know anywhere good to explore?" then "Yes please!": the dusty key (274's
 *      inv_add, his own script);
 *   5. out of the cell (op1 opens it from inside), the jail key dropped (a player had no use for it), the dusty key banked.
 * Once in a bot's life (a bot that owns a dusty key is never offered it); about 15 minutes. A bosser of combat 85+ gets
 * it before its first Taverley trip (port/BotEndgame's offer). New aged bots of combat 85+ hold one half the time
 * (port/BotAge's 'a-dustykey', last in their kit).
 */
import type Player from '#/engine/entity/Player.js';
import InvType from '#/cache/config/InvType.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import World from '#/engine/World.js';
import { Locations } from '#/engine/bot/BotKnowledge.js';
import { botScript, countItem, findLocByName, findNpcByName, interactNpcOp, interactUseLocOp, findObjNear } from '#/engine/bot/BotAction.js';
import { eatBestFood, humanDelay } from '#/engine/bot/tasks/BotTaskBase.js';
import { act, bank, dropAll, obj, owned, soft, take, talk, walk, when, type At, type ErrandPlan, type ErrandTask, type Step } from '#/engine/bot/tasks/ErrandTask.js';
import { walkTo } from '#/engine/bot/BotAction.js';
import { dungeonLeg } from '#/engine/bot/port/BotDungeons.js';
import { BosserErrand, emitEndgameEvent } from '#/engine/bot/port/BotEndgameCore.js';
import { foodWithdraw, goodFoodOwned, sayStep } from '#/engine/bot/port/BotEndgameFight.js';

const JAILER = Locations.TAVERLEY_JAILER as At;
const JAIL_DOOR = Locations.TAVERLEY_JAIL_DOOR as At;
const VELRAK = Locations.TAVERLEY_VELRAK as At;
const BANK = Locations.FALADOR_WEST_BANK as At;

/** the errands (the report, the tests): begun, the jailer's key taken, the cell opened, the dusty keys got */
export const velrakStats = { begun: 0, jailKeys: 0, cells: 0, keys: 0 };

/** asked of a bot once at most per this much play (ticks: a failed errand is not retried at once) */
const RETRY_GAP = 18000;
const lastAsked = new Map<string, number>();

/** may this bot go for the dusty key now (none owned, combat 60+: the jailer is level 47, not asked lately)? */
export function mayAskVelrak(p: Player): boolean {
    if (owned(p, obj('dusty_key')) > 0 || p.combatLevel < 60) return false;
    return World.currentTick - (lastAsked.get(p.username.toLowerCase()) ?? -Infinity) >= RETRY_GAP;
}

/** the jail key on the ground near the bot (its own drop, or anyone's after the reveal) */
function jailKeyNear(p: Player): boolean {
    return findObjNear(p, p.x, p.z, p.level, obj('jail_key'), 8) !== null;
}

/**
 * the jailer fought, as a player clicks his Attack (op 2) and eats when hurt, until `until(p)` (his key dropped): a fight of
 * its own, not a CombatTask's (a fighter's watchdog and walks: two rescue jumps in a 500-bot world's first run); waits
 * while another fights him or he has not come back yet (274's respawn 100 ticks); fails after MAX_FIGHT
 */
const MAX_FIGHT = 900;
function attackJailer(until: (p: Player) => boolean): Step {
    let ticks = 0;
    let wait = 0;
    return {
        label: 'the jailer',
        tick(p) {
            if (until(p)) {
                ticks = 0;
                return 'done';
            }
            if (++ticks > MAX_FIGHT) {
                ticks = 0;
                return 'fail';
            }
            if (p.levels[PlayerStat.HITPOINTS] * 2 < p.baseLevels[PlayerStat.HITPOINTS] && !p.delayed && eatBestFood(p)) {
                wait = 3;
                return 'run';
            }
            if (wait > 0 && --wait > 0) return 'run';
            const jailer = findNpcByName(JAILER[0], JAILER[1], 0, 'jailer', 12);
            if (!jailer) return 'run';
            const t = p.target as unknown as { nid?: number } | null;
            if (t && t.nid === jailer.nid) return 'run';
            interactNpcOp(p, jailer, 2);
            wait = 6 + humanDelay(p, 'retarget');
            return 'run';
        }
    };
}

/** the jail key used on the cell's door until the bot is inside the cell (south of the door) */
function intoTheCell(): Step {
    let tries = 0;
    let wait = 0;
    return {
        label: 'into the cell',
        tick(p) {
            if (p.z < JAIL_DOOR[1] && Math.abs(p.x - JAIL_DOOR[0]) <= 3) {
                tries = 0;
                velrakStats.cells++;
                return 'done';
            }
            if (wait > 0 && (--wait > 0 || p.delayed || p.hasWaypoints() || botScript(p))) return 'run';
            if (++tries > 8) {
                tries = 0;
                return 'fail';
            }
            const door = findLocByName(JAIL_DOOR[0], JAIL_DOOR[1], 0, 'dungeonjail', 1);
            const key = obj('jail_key');
            const inv = p.getInventory(InvType.INV);
            if (!door || !inv) return 'fail';
            let slot = -1;
            for (let s = 0; s < inv.capacity; s++) if (inv.get(s)?.id === key) slot = s;
            if (slot === -1) return 'fail';
            interactUseLocOp(p, door, key, slot);
            wait = 8;
            return 'run';
        }
    };
}

/** down to the jail from the surface (the Taverley ladder: port/BotDungeons), then walkTo's walk through its doors */
function toTheJail(): Step {
    let ticks = 0;
    const w = walk([JAILER[0] - 1, JAILER[1], 0], 3, 4000, 'to the jail');
    return {
        label: 'to the jail',
        tick(p, t) {
            if (p.z < 6400 && p.level === 0) {
                if (++ticks > 3000) return 'fail';
                dungeonLeg(p, JAILER[0], JAILER[1], (x, z) => walkTo(p, x, z, 0));
                return 'run';
            }
            return w.tick(p, t);
        }
    };
}

function plan(): ErrandPlan {
    const dusty = obj('dusty_key');
    const jailKey = obj('jail_key');
    return {
        kind: 'Velrak',
        key: 'dusty-key',
        at: VELRAK,
        members: true,
        ok: p => owned(p, dusty) === 0,
        build(p) {
            velrakStats.begun++;
            lastAsked.set(p.username.toLowerCase(), World.currentTick);
            const steps: Step[] = [
                bank({ near: BANK, keep: () => [], withdraw: q => foodWithdraw(Math.min(6, goodFoodOwned(q)))(q) }),
                sayStep('eg-velrak-go', 0.3),
                toTheJail(),
                // the jailer attacked (his Attack, eating when hurt) until his jail key lies on the ground or is carried
                when(q => countItem(q, jailKey) === 0, attackJailer(q => countItem(q, jailKey) > 0 || jailKeyNear(q)), when(q => countItem(q, jailKey) === 0, take(jailKey, [JAILER[0], JAILER[1], 0], 8, 60))),
                act('jail key', q => (countItem(q, jailKey) > 0 ? ((velrakStats.jailKeys++, 'done')) : 'fail')),
                walk([JAIL_DOOR[0], JAIL_DOOR[1] + 1, 0], 1, 400, 'to the cell'),
                intoTheCell(),
                talk('velrak_the_explorer', VELRAK, { answers: [1, 1], radius: 6 }),
                act('dusty key', q => {
                    if (countItem(q, dusty) === 0) return 'fail';
                    velrakStats.keys++;
                    emitEndgameEvent(q, 'dustyKey', {});
                    return 'done';
                }),
                sayStep('eg-velrak-got', 0.5),
                // (out of the cell: walkTo opens it from inside, op1; the jail key dropped once out)
                soft(walk([JAIL_DOOR[0], JAIL_DOOR[1] + 2, 0], 1, 400, 'out of the cell')),
                dropAll([jailKey]),
                soft(walk(BANK, 4, 5000, 'back to the bank')),
                bank({ near: BANK })
            ];
            return steps;
        }
    };
}

/** the dusty-key errand (the offer's: port/BotEndgame; the tests') */
export function velrakTask(): ErrandTask {
    return new BosserErrand(plan(), 'velrak', false);
}
