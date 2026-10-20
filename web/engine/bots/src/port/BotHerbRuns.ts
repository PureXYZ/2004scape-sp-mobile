/**
 * port (the variety work, round 2, Track D2: DO-13, herblore, research
 * the research) members
 *
 * Herblore never ran: the planner wanted 5 clean guams, and druids drop the unidentified herb (274's "Herb", identified
 * with its own op). Now a bot with Herblore 3+ and 5+ herbs of its step (unidentified or clean, carried or banked) is
 * offered HerbloreTask (Jatix's vials and eyes of newt in Taverley, the Falador fountain's water, the herbs identified
 * with their real Identify op at the bank, the potions mixed there), HERB_SHARE of its picks, its step's spot Taverley's
 * herb shop (the step's own, Aemad's in East Ardougne, is not where the task goes). One with too few goes on a herb run:
 * the chaos druids of the Taverley dungeon fought for their herbs, identified at the Falador bank (the Identify op), then
 * the potions when the guams are there (an errand, kind Herblore: 2004's "druid run").
 */
import type Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import { GRIMY_HERB_MAP, Items, Locations, SkillProgression, type SkillStep } from '#/engine/bot/BotKnowledge.js';
import { getBaseLevel } from '#/engine/bot/BotAction.js';
import { HerbloreTask } from '#/engine/bot/tasks/HerbloreTask.js';
import { coinsOwned } from '#/engine/bot/BotNeeds.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { ErrandTask, bank, fight, heldOp, inner, owned, say, when, withinRange, type At, type ErrandPlan } from '#/engine/bot/tasks/ErrandTask.js';
import { CombatTask, combatWeaponFor, fitToFight } from '#/engine/bot/tasks/CombatTask.js';
import InvType from '#/cache/config/InvType.js';
import { countItem } from '#/engine/bot/BotAction.js';

/** a pick of a bot that has the herbs goes to herblore this often (AM1's herblore band, 1-4 % of members' levelling time) */
export const HERB_SHARE = 0.5;

/** the herbs of a step's clean herb the bot owns: clean, and unidentified (GRIMY_HERB_MAP: unidentified -> [clean, ...]) */
export function herbsFor(p: Player, clean: number): number {
    let n = owned(p, clean);
    for (const [unid, [c]] of Object.entries(GRIMY_HERB_MAP)) if (c === clean) n += owned(p, Number(unid));
    return n;
}

const stepsMemo = new Map<SkillStep, SkillStep>();
/** the step with Jatix's shop as its spot (where the task goes) */
function atTaverley(step: SkillStep): SkillStep {
    let s = stepsMemo.get(step);
    if (!s) stepsMemo.set(step, (s = { ...step, location: [...Locations.TAVERLEY_HERBS] as [number, number, number] }));
    return s;
}

/** the unidentified herbs (274's "Herb"): GRIMY_HERB_MAP's keys */
const UNIDENTIFIED = (): number[] => Object.keys(GRIMY_HERB_MAP).map(Number);
const carriedUnid = (p: Player): number => UNIDENTIFIED().reduce((a, id) => a + countItem(p, id), 0);

function druidStep(): SkillStep | null {
    return (SkillProgression.ATTACK ?? []).find(s => s.location === Locations.CHAOS_DRUIDS_TAVERLY && s.action === 'combat') ?? null;
}

/** the druid run: Taverley's chaos druids fought for their herbs, identified at the Falador bank, the potions after */
function druidRun(): ErrandPlan {
    let want = 0;
    return {
        kind: 'Herblore',
        key: 'druids',
        at: Locations.CHAOS_DRUIDS_TAVERLY as At,
        members: true,
        stat: PlayerStat.HERBLORE,
        ok(p) {
            const step = druidStep();
            return step !== null && p.combatLevel >= 20 && combatWeaponFor(p, step) !== null && fitToFight(p, step);
        },
        build() {
            want = 6 + Math.floor(Math.random() * 6);
            return [
                say('herbs-go', 0.35),
                fight(() => (druidStep() ? new CombatTask(druidStep()!, PlayerStat.STRENGTH) : null), q => carriedUnid(q) >= want || (q.getInventory(InvType.INV)?.freeSlotCount ?? 28) <= 2),
                bank({ near: Locations.FALADOR_WEST_BANK as At, keep: () => UNIDENTIFIED() }),
                say('herbs-identify', 0.3),
                heldOp(q => UNIDENTIFIED().find(id => countItem(q, id) > 0 && (GRIMY_HERB_MAP[id]?.[2] ?? 99) <= getBaseLevel(q, PlayerStat.HERBLORE)) ?? -1, 1, { again: q => UNIDENTIFIED().some(id => countItem(q, id) > 0 && (GRIMY_HERB_MAP[id]?.[2] ?? 99) <= getBaseLevel(q, PlayerStat.HERBLORE)), wait: 1 }),
                bank({ near: Locations.FALADOR_WEST_BANK as At, keep: () => [] }),
                // (the potions, when the guams are there: HerbloreTask's Jatix, fountain and bank)
                when(q => herbsFor(q, Items.CLEAN_GUAM) >= 5 && coinsOwned(q) >= 45, inner(q => herbloreTaskFor(q), () => false, 4000, 'potions', true))
            ];
        },
        again: (_p, rounds) => rounds < 2
    };
}

/** HerbloreTask for the best step the bot has 5 herbs and the coins for, or null */
function herbloreTaskFor(p: Player): HerbloreTask | null {
    const lvl = getBaseLevel(p, PlayerStat.HERBLORE);
    const steps = (SkillProgression.HERBLORE ?? []).filter(s => s.minLevel <= lvl && s.itemConsumed !== undefined && herbsFor(p, s.itemConsumed) >= 5);
    steps.sort((a, b) => b.minLevel - a.minLevel);
    for (const step of steps) {
        const task = new HerbloreTask(atTaverley(step));
        if (coinsOwned(p) >= 45 && task.shouldRun(p)) return task;
    }
    return null;
}

/** a pick of a bot with too few herbs goes on a druid run this often */
export const DRUID_RUN_SHARE = 0.08;

/** the druid run's task (the tests'; the planner's through herbRunFor) */
export function druidRunTask(): ErrandTask {
    return new ErrandTask(druidRun());
}

/** the planner's offer (port/BotD2Picks): HerbloreTask for a members bot with the herbs and coins for a batch, else now and then a druid run; else null */
export function herbRunFor(p: Player, roll: number = Math.random(), fighter = false): HerbloreTask | ErrandTask | null {
    if (!isMembersWorld() || roll >= HERB_SHARE) return null;
    const lvl = getBaseLevel(p, PlayerStat.HERBLORE);
    if (lvl < 3) return null;
    const task = herbloreTaskFor(p);
    if (task) return task;
    // (not a fighter's: its picks are its fights)
    if (!fighter && Math.random() < DRUID_RUN_SHARE / HERB_SHARE) {
        const plan = druidRun();
        if (withinRange(p, plan.at) && (!plan.ok || plan.ok(p))) return new ErrandTask(plan);
    }
    return null;
}

export { Items };
