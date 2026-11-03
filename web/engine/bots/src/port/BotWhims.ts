// port (bots ideas, round 2, theme C: lives with arcs, C5):
// off-role whims: in WHIM_SHARE of its sessions (drawn at its login, the library's dice) a bot does something its role
// seldom does, for one plan of 15-40 minutes, then goes back to its role.
//
//   skiller         a fight at its level (90 %: its lowest melee skill first), the skeletons by the Wilderness ditch (5 %:
//                   port/BotWildTrips' trip, when it fits; WT1 stays under 2), or (5 %) a fight too: "felt like a change lol"
//   fighter         a gathering skill (woodcutting, fishing, mining) first: "fishing for once lol", "lol me skilling"
//   balanced/random its least-weighted skill that it can work on first: "doing something different today"
//   vendor          a gathering skill near where it is, then its stall: "lol me skilling"
//   social regular  a short gathering stint (no line)
//   PKer            fishing, woodcutting or mining near Edgeville or Draynor at its real levels: "taking a break from pking";
//                   its pack cleared first as its restock clears it (port/BotLoot clearPackForRestock: the kit is the
//                   restock's, never banked), and everything it gathered or bought banked before its PK task takes it
//                   back (the restock would wipe it)
// A levelling bot's whim is its own candidates reordered at a pick (the whim's skill first, once: port/BotLivesIndex; a whim
// due takes its pick before a relog's carry-on and the variety work's D2 picks, so it is the session's first plan), an
// extra's a pick of a planner of that one skill (port/BotGoalPlanner's own, at the top of ExtrasGoalPlanner.pickTask). The
// whim's task ends when its time is up (a timed task: it is complete then), whatever its plan's length. Never a newbie,
// never a bot following a clique mate, never in a set-piece role, never a PKer holding the human's items. Lines 30 % of the
// time, in the place of its next due line. The log (whimLog): the humanlike runner's AR8, the tests.
import type Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import World from '#/engine/World.js';
import { BotGoalPlanner } from '#/engine/bot/BotGoalPlanner.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import type { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';
import { BankTask } from '#/engine/bot/tasks/UtilTasks.js';
import { FishingTask } from '#/engine/bot/tasks/FishingTask.js';
import { MiningTask } from '#/engine/bot/tasks/MiningTask.js';
import { WoodcuttingTask } from '#/engine/bot/tasks/WoodcuttingTask.js';
import { SkillProgression, stepDistance, type SkillStep } from '#/engine/bot/BotKnowledge.js';
import { hasAllTools } from '#/engine/bot/BotNeeds.js';
import { onArcs } from '#/engine/bot/port/BotArcsEvents.js';
import { arcLines, sayArcLine } from '#/engine/bot/port/BotArcsSay.js';
import { followsFriend } from '#/engine/bot/port/BotCliques.js';
import { taskKind } from '#/engine/bot/port/BotLines.js';
import { LIVES, LIVES_CTL, noteLivesLine } from '#/engine/bot/port/BotLives.js';
import { clearPackForRestock, holdsLoot } from '#/engine/bot/port/BotLoot.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';
import { wildTripTask } from '#/engine/bot/port/BotWildTrips.js';

// ── the defaults ───────────────────────────────────────────────────────────────────────────────────

/**
 * (share: the logins that roll a whim; 0.3 since round 2's check-in, was 0.15: 2-7 % of sessions had one in the
 * humanlike runs, the hoped-for band 10-25 %: some are lost, not free, no candidate)
 */
export const WHIM = { share: 0.3, minutes: [15, 40] as [number, number], line: 0.3, skillerWild: 0.05, skillerOuting: 0.05, tries: 3 };
const GATHER = ['WOODCUTTING', 'FISHING', 'MINING'] as const;
const MELEE = ['ATTACK', 'STRENGTH', 'DEFENCE'] as const;
/** the skills a balanced or random bot's whim may be in: those it can work on where it is (no talisman, course, staff) */
const WHIM_SKILLS = ['WOODCUTTING', 'FISHING', 'MINING', 'ATTACK', 'STRENGTH', 'DEFENCE', 'RANGED', 'THIEVING', 'CRAFTING', 'FLETCHING', 'SMITHING', 'COOKING', 'FIREMAKING'];
const SKILL_STAT: Readonly<Record<string, number>> = { ATTACK: PlayerStat.ATTACK, STRENGTH: PlayerStat.STRENGTH, DEFENCE: PlayerStat.DEFENCE, RANGED: PlayerStat.RANGED, WOODCUTTING: PlayerStat.WOODCUTTING, FISHING: PlayerStat.FISHING, MINING: PlayerStat.MINING, THIEVING: PlayerStat.THIEVING, CRAFTING: PlayerStat.CRAFTING, FLETCHING: PlayerStat.FLETCHING, SMITHING: PlayerStat.SMITHING, COOKING: PlayerStat.COOKING, FIREMAKING: PlayerStat.FIREMAKING };
/** the task kinds of a whim's skill (its task picked: the whim begun) */
const SKILL_KINDS: Readonly<Record<string, readonly string[]>> = {
    ATTACK: ['Combat'],
    STRENGTH: ['Combat'],
    DEFENCE: ['Combat'],
    RANGED: ['RangedMagic'],
    WOODCUTTING: ['Woodcut'],
    FISHING: ['Fish'],
    MINING: ['Mine'],
    THIEVING: ['Thieve'],
    CRAFTING: ['Crafting', 'Pick Flax'],
    FLETCHING: ['Fletching', 'BowStringing'],
    SMITHING: ['Smith'],
    COOKING: ['Cook'],
    FIREMAKING: ['Firemaking']
};

export interface WhimEntry {
    t: number;
    name: string;
    planner: string;
    /** what: 'combat', 'gather', 'skill', 'wild' (a skiller's), 'pk-break' (a PKer's) */
    what: string;
    skill: string;
    started: boolean;
    /** when it began and ends (world ticks; -1: not begun) */
    from: number;
    until: number;
    /** given up: its pick never came to it (WHIM.tries), or it was not free */
    lost?: string;
    line?: string | null;
    banked?: boolean;
}
const LOG_MAX = 2000;
export const whimLog: WhimEntry[] = [];
export const whimStats = { rolled: 0, started: 0, lost: 0, banked: 0 };

interface Whim {
    entry: WhimEntry;
    phase: 'due' | 'on' | 'bank' | 'off';
    tries: number;
    planner: BotGoalPlanner | null;
}
const whims = new WeakMap<Player, Whim>();

function log(e: WhimEntry): WhimEntry {
    whimLog.push(e);
    if (whimLog.length > LOG_MAX) whimLog.splice(0, whimLog.length - LOG_MAX);
    return e;
}

const isPker = (p: Player): boolean => p.botPlanner === 'extras_pker' || p.botPlanner === 'extras_edgeville_pker';

/** a whim's task: complete when its time is up, else as the task itself (the task, its name and fields, as it is) */
function timed(task: BotTask, entry: WhimEntry): BotTask {
    return new Proxy(task, {
        get(target, prop) {
            if (prop === 'isComplete') return (p: Player) => World.currentTick >= entry.until || target.isComplete(p);
            const v = Reflect.get(target, prop, target);
            return typeof v === 'function' ? v.bind(target) : v;
        }
    });
}

/** the places an extra's gathering whim is near: a PKer's Edgeville or Draynor, any other's where it is */
const PK_NEAR: readonly [number, number][] = [
    [3093, 3493],
    [3093, 3250]
];
const NEAR_TILES = 90;

/**
 * an extra's gathering task near (a PKer's: by Edgeville or Draynor), at its real level, with its tool owned (carried,
 * worn or banked: the task fetches it), or null (the narrowed planner's pick then: a tool's shop trip, a farther spot)
 */
function nearGatherTask(p: Player, skill: string): BotTask | null {
    const stat = SKILL_STAT[skill];
    const level = p.baseLevels[stat] ?? 1;
    const steps = (SkillProgression[skill] ?? []).filter((s: SkillStep) => s.location[2] === 0 && level >= s.minLevel && (s.action === 'fish' || s.action === 'mine' || s.action === 'woodcut'));
    const centres = isPker(p) ? PK_NEAR : ([[p.x, p.z]] as [number, number][]);
    const near = steps.filter(s => centres.some(([x, z]) => stepDistance(s, x, z) <= NEAR_TILES) && hasAllTools(p, s));
    if (!near.length) return null;
    // (the nearest to the bot, of its best level's)
    near.sort((a, b) => b.minLevel - a.minLevel || stepDistance(a, p.x, p.z) - stepDistance(b, p.x, p.z));
    const step = near[0];
    const task = step.action === 'fish' ? new FishingTask(step) : step.action === 'mine' ? new MiningTask(step) : new WoodcuttingTask(step);
    return task.shouldRun(p) ? task : null;
}

/** the fighting task kinds a whim of another skill never takes */
const FIGHT_KINDS: ReadonlySet<string> = new Set(['Combat', 'RangedMagic']);

/**
 * the one-skill planner's pick for an extra's whim (its skill's task, a bank stop for its tool, a shop trip ...), or null
 * when it is a fight the whim is not about: a PKer at combat 3 has no fishing spot of its level by Edgeville or Draynor,
 * and the planner's pick was a fight (a 1-Attack pure's levels would go with it)
 */
function ownPick(task: BotTask | null, skill: string): BotTask | null {
    if (!task) return null;
    const kind = taskKind(task.name);
    return FIGHT_KINDS.has(kind) && !(SKILL_KINDS[skill] ?? []).includes(kind) ? null : task;
}

function minutes(): number {
    return (WHIM.minutes[0] + Math.random() * (WHIM.minutes[1] - WHIM.minutes[0])) * 100;
}

/** a levelling bot's whim at its login: what and in which skill */
function levellingWhim(p: Player): { what: string; skill: string } | null {
    const weights = BotManager.botFor(p)?.planner.personality.weights ?? {};
    const level = (s: string): number => p.baseLevels[SKILL_STAT[s]] ?? 1;
    switch (p.botPlanner) {
        case 'skiller': {
            const r = Math.random();
            if (r < WHIM.skillerWild) return { what: 'wild', skill: 'skeletons' };
            // (an outing, 5 %, is a fight too here: the far towns' outings keep their own cadence, port/BotOutings)
            let low: string = MELEE[0];
            for (const s of MELEE) if (level(s) < level(low)) low = s;
            return { what: 'combat', skill: low };
        }
        case 'fighter':
            return { what: 'gather', skill: GATHER[Math.floor(Math.random() * GATHER.length)] };
        default: {
            const list = WHIM_SKILLS.filter(s => (weights[s] ?? 0) > 0);
            if (!list.length) return null;
            const least = Math.min(...list.map(s => weights[s] ?? 0));
            const pool = list.filter(s => (weights[s] ?? 0) <= least + 1);
            return { what: 'skill', skill: pool[Math.floor(Math.random() * pool.length)] };
        }
    }
}

/** an extra's whim at its login: a gathering skill (a PKer's fishing, woodcutting or mining) */
function extraWhim(p: Player): { what: string; skill: string } {
    const skill = GATHER[Math.floor(Math.random() * GATHER.length)];
    return { what: isPker(p) ? 'pk-break' : 'gather', skill };
}

// ── the login ────────────────────────────────────────────────────────────────────────────────────────────────────

onArcs('login', e => {
    if (!LIVES_CTL.on) return;
    const p = e.bot;
    if (!p || p.is_bot !== true) return;
    whims.delete(p);
    if (Math.random() >= WHIM.share * whimScale) return;
    if (isNewbie(p)) return;
    const pick = isLevelling(p.botPlanner as PlannerKey) ? levellingWhim(p) : extraWhim(p);
    if (!pick) return;
    whimStats.rolled++;
    const entry = log({ t: World.currentTick, name: p.username, planner: p.botPlanner ?? '', what: pick.what, skill: pick.skill, started: false, from: -1, until: -1 });
    whims.set(p, { entry, phase: 'due', tries: 0, planner: null });
});

/** free for a whim now: no clique follow, no set-piece role, no human's items to bank */
function freeForWhim(p: Player): boolean {
    return followsFriend(p) === null && eventRoleOf(p) === null && !holdsLoot(p);
}

function lose(w: Whim, why: string): void {
    w.phase = 'off';
    w.entry.lost = why;
    whimStats.lost++;
}

function begin(p: Player, w: Whim): void {
    const now = World.currentTick;
    w.phase = 'on';
    w.entry.started = true;
    w.entry.from = now;
    w.entry.until = now + Math.round(minutes());
    whimStats.started++;
    const kind = w.entry.what === 'pk-break' ? 'pker' : p.botPlanner === 'skiller' ? (w.entry.what === 'wild' ? 'skiller-wild' : 'skiller') : p.botPlanner === 'fighter' ? (w.entry.skill === 'FISHING' && Math.random() < 0.5 ? 'fighter-fish' : 'fighter') : p.botPlanner === 'extras_vendor' ? 'vendor' : isLevelling(p.botPlanner as PlannerKey) ? 'balanced' : null;
    if (kind !== null && Math.random() < WHIM.line) {
        const said = sayArcLine(p, arcLines('arcs-whim', kind), {}, { kind: 'idle', budget: 'own', spoke: 'idle' });
        w.entry.line = said;
        if (said) noteLivesLine(p, 'arcs-whim', kind, said);
    }
}

// ── a levelling bot's whim (port/BotLivesIndex) ──────────────────────────────────────────────────────────────────

/** before the candidates: a skiller's Wilderness whim (the skeletons by the ditch), or null */
export function whimPlannerTask(p: Player): BotTask | null {
    const w = whims.get(p);
    if (!w || w.phase !== 'due' || w.entry.what !== 'wild') return null;
    if (!freeForWhim(p)) return null;
    const task = wildTripTask('skeletons');
    const fits = task && p.combatLevel >= 25 && p.combatLevel <= 55;
    if (!task || !fits) {
        // (it does not suit the skeletons: a fight instead)
        w.entry.what = 'combat';
        w.entry.skill = 'ATTACK';
        return null;
    }
    begin(p, w);
    return timed(task, w.entry);
}

/** the candidates: the whim's skill first (its due pick); true when it put it there */
export function whimCandidates(p: Player, candidates: string[]): boolean {
    const w = whims.get(p);
    if (!w || w.phase !== 'due' || w.entry.what === 'wild') return false;
    if (!freeForWhim(p)) return false;
    const i = candidates.indexOf(w.entry.skill);
    if (i < 0) {
        lose(w, 'no candidate');
        return false;
    }
    if (i > 0) candidates.unshift(...candidates.splice(i, 1));
    w.tries++;
    return true;
}

/** the pick's task: the whim's (its skill's task kind) timed to its end and begun; another task, a try used */
export function whimPicked(p: Player, task: BotTask | null): BotTask | null {
    const w = whims.get(p);
    if (!w || w.phase !== 'due' || !task || w.tries === 0) return null;
    const kind = taskKind(task.name);
    if (!(SKILL_KINDS[w.entry.skill] ?? []).includes(kind)) {
        if (w.tries >= WHIM.tries) lose(w, `picked ${kind}`);
        return null;
    }
    begin(p, w);
    return timed(task, w.entry);
}

/** the planner's carry-on: a whim due takes its place at the session's first pick */
LIVES.whimFirst = p => {
    const w = whims.get(p);
    return !!w && w.phase === 'due' && freeForWhim(p);
};

// ── an extra's whim (BotGoalPlanner ExtrasGoalPlanner.pickTask) ─────────────────────────────────────────────────

LIVES.extrasTask = (p, _type) => {
    const w = whims.get(p);
    if (!w || w.phase === 'off') return null;
    const now = World.currentTick;
    if (w.phase === 'bank') {
        // (the bank trip done: its role again)
        w.phase = 'off';
        return null;
    }
    if (w.phase === 'due') {
        if (!freeForWhim(p) || p.level !== 0) {
            lose(w, 'not free');
            return null;
        }
        // (a PKer: its pack as its restock leaves it: the kit is the restock's, never banked)
        if (w.entry.what === 'pk-break') clearPackForRestock(p);
        const planner = new BotGoalPlanner({ name: 'Whim', weights: { [w.entry.skill]: 100 } });
        planner.skipInit();
        w.planner = planner;
        // (near Edgeville or Draynor, or where it is, with a tool it owns; else the one-skill planner's pick: its tool's trip)
        const task = nearGatherTask(p, w.entry.skill) ?? ownPick(planner.pickTask(p), w.entry.skill);
        if (!task) {
            lose(w, 'no task');
            return null;
        }
        begin(p, w);
        return timed(task, w.entry);
    }
    // on
    if (now < w.entry.until && w.planner) {
        const task = nearGatherTask(p, w.entry.skill) ?? ownPick(w.planner.pickTask(p), w.entry.skill);
        if (task) return timed(task, w.entry);
    }
    if (isPker(p)) {
        // (what it gathered or bought to the bank before its PK task's restock: never wiped)
        w.phase = 'bank';
        w.entry.banked = true;
        whimStats.banked++;
        return new BankTask([]);
    }
    w.phase = 'off';
    return null;
};

// ── the runner and the tests ─────────────────────────────────────────────────────────────────────────────────────

/** the bot's whim this session (the tests), or null */
export function whimOf(p: Player): WhimEntry | null {
    return whims.get(p)?.entry ?? null;
}
let whimScale = 1;
/** (tests) the whim's share x this (0: none; null: as the game) */
export function setWhimScaleForTest(scale: number | null): void {
    whimScale = scale ?? 1;
}
/** (tests) a whim for the bot now, of `what` in `skill` (null: none) */
export function setWhimForTest(p: Player, whim: { what: string; skill: string } | null): void {
    if (whim === null) {
        whims.delete(p);
        return;
    }
    const entry = log({ t: World.currentTick, name: p.username, planner: p.botPlanner ?? '', what: whim.what, skill: whim.skill, started: false, from: -1, until: -1 });
    whims.set(p, { entry, phase: 'due', tries: 0, planner: null });
}
