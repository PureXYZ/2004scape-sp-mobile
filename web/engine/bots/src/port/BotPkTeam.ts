// port (the realism work, phase 5b, Track D: groups on the move; "PK teams":
// a team piles onto the human in multi-combat as 274 allows, at most 3 on one target, with no
// warning line first): a PK team raid, a set piece of the director (port/BotDirector). 2004's PKers went "in 2s and 3s"
// (Sal's tips), and a team's pile could only happen in multi-combat: 274's pvp_in_combat_check skips its
// "already under attack" rules when the target stands in a multi-combat zone (port/BotContent isMultiCombat). The edge
// north of Edgeville is single-combat; north of Varrock the Wilderness is multi-combat from level 1 (x 3136-3327).
//
//   - The team: a PK clique (port/BotCliques) with 2-4 online at their PK task, not in a fight, with 30 minutes of session
//     left (its leader, the first of the clique online as on patrol, 45); an Edgeville clique first, a deep one half as
//     often (deep PKers attack humans only).
//   - announce: an Edgeville team meets north of Edgeville bank after a bank trip for food ("team going varrock wildy, whos
//     in", "grab food first"); a deep team meets in the strip. build: the team walks east into the Varrock Wilderness
//     (levels 3-6) round its leader. peak: 10-15 minutes of patrol there, the leader from point to point, the others
//     round it. end: back to the edge (a deep team to its own zones).
//   - The pile: in the raid, a team-mate may join its leader's target, or take one a team-mate fights, only where the
//     target stands in multi-combat and fewer than 3 of the team are on it (mayShare); in a single-combat zone the
//     game would refuse the second attacker anyway, and the bots never try. The human there is fair game under 274's
//     rules (an Edgeville team attacks anyone in range, a deep team humans only): by design.
//   - A member below 40 % of its Hitpoints with no food runs (the PK tasks' escape); two out, or the leader, and the team
//     goes home ("retreat retreat").
// The PK tasks (tasks/EdgevillePKerTask, tasks/PKerTask) read their part through port/BotSetPieces' eventRoleOf (this
// module's PkRaid view): where to stand, whom to follow, whom they may share; they keep their own fight, food, prayers and
// escape. Every line is a set piece's (LineKind 'setpiece', out of H7), counted against its speaker's talk budget.
import Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { randInt } from '#/engine/bot/tasks/BotTaskBase.js';
import { eventRoleOf, nextSetPieceId, register, type SetPieceContext, type SetPiecePhase, type SetPiecePlan, type SetPieceRun, type SetPieceVenue } from '#/engine/bot/port/BotSetPieces.js';
import { botPersona, inFightQuick, sayTyped } from '#/engine/bot/port/BotChat.js';
import { countAsBudgetedLine, noteEvent } from '#/engine/bot/port/BotChatter.js';
import { cliqueInfoOf } from '#/engine/bot/port/BotCliques.js';
import { isMultiCombat } from '#/engine/bot/port/BotContent.js';
import { directorBots, LEAD_SESSION_LEFT, RECRUIT_SESSION_LEFT, recruitedLately } from '#/engine/bot/port/BotDirector.js';
import { rumourText, setPieceLine } from '#/engine/bot/port/BotLines.js';
import { reactionTicks, typingTicks } from '#/engine/bot/port/BotTiming.js';

/** the Varrock Wilderness's multi-combat strip a raid patrols, levels 3-7 (content/maps/multiway.csv: x 3136-3327, levels 1-8) */
export const RAID_ZONE = { x0: 3150, x1: 3250, z0: 3536, z1: 3568 };
/** its patrol points (the walking graph's nodes there: test/groups.test checks each is multi-combat) */
export const PATROL_POINTS: readonly (readonly [number, number])[] = [
    [3160, 3544], [3176, 3544], [3192, 3543], [3208, 3544], [3224, 3544], [3240, 3544],
    [3160, 3560], [3176, 3559], [3192, 3559], [3208, 3560], [3224, 3560], [3240, 3560]
];
/** an Edgeville team's meeting: north of Edgeville bank, short of the Wilderness */
export const EDGE_MEET: readonly [number, number] = [3094, 3503];
/** at most this many of a team on one target (the default; 274 itself has no cap in multi-combat) */
export const MAX_ON_ONE = 3;
/** a member runs below this share of its Hitpoints with no food (the PK tasks' own escape is at 30 %) */
export const RAID_ESCAPE_BELOW = 0.4;
/** members round their leader within this */
const FORMATION = 3;
/** the gathering at most (3 minutes), the walk there at most (4), the patrol (10-15 minutes), the way home at most (4) */
const GATHER_TICKS = 300;
const GO_TICKS = 400;
const PATROL_TICKS: readonly [number, number] = [1000, 1500];
const HOME_TICKS = 400;
/** the leader's next patrol point after this long at one */
const POINT_TICKS: readonly [number, number] = [40, 100];
/** a team: 2-4 */
const TEAM: readonly [number, number] = [2, 4];
/** a move farther than this between the director's steps is a jump (a death's respawn, a teleport) */
const JUMP_TILES = 30;

/** What a PK task asks of the raid it is in (port/BotSetPieces eventRoleOf: the run, cast to this). */
export interface PkRaid {
    readonly kind: 'pk_raid';
    /** below this share of its Hitpoints with no food it runs */
    readonly escapeBelow: number;
    /** its part now: to the meeting, on the way, on patrol, home; null: none */
    partOf(p: Player): 'gather' | 'go' | 'patrol' | 'home' | null;
    /** where it heads or stands now; null: its task's own spot */
    spotFor(p: Player): [number, number] | null;
    /** its team's leader, or null (it leads) */
    leaderOf(p: Player): Player | null;
    /** of one team in this raid */
    sameTeam(a: Player, b: Player): boolean;
    /** may `p` attack `target` while team-mates do: the target in multi-combat and fewer than MAX_ON_ONE of the team on it */
    mayShare(p: Player, target: Player): boolean;
    /** the target its leader fights, when it may share it; null otherwise */
    teamTarget(p: Player): Player | null;
    /** it joined a team-mate's target (a word now and then: "pile him") */
    notePile(p: Player, target: Player): void;
    /** it ran, beaten (two out, or the leader: the team goes home) */
    noteOut(p: Player): void;
}

/** The PK raid `p` has a part in, or null (the PK tasks: port/BotSetPieces' eventRoleOf, no import of this module needed). */
export function raidOf(p: Player): PkRaid | null {
    const role = eventRoleOf(p);
    // (this module's own run only: a run of another kind's shape under the name, a test's stand-in, has no spots)
    return role?.run instanceof PkRaidRun ? role.run : null;
}

const PK_TASKS = new Set(['EdgevillePKer', 'PKer']);

/** a PKer the raid may take now: at its PK task, playing, no part, not in a fight, its session long enough, not taken lately */
function available(p: Player, play: number, need: number): boolean {
    if (p.is_bot !== true || p.slot === -1 || p.levels[PlayerStat.HITPOINTS] * 2 < p.baseLevels[PlayerStat.HITPOINTS]) return false;
    const ai = BotManager.botFor(p);
    if (!ai || ai.hasSubTask() || !PK_TASKS.has(ai.currentTask?.name ?? '') || eventRoleOf(p)) return false;
    if (inFightQuick(p) || recruitedLately(p.username, play)) return false;
    return BotManager.sessionLeftOf(p.username) >= need;
}

interface RaidPlan {
    team: Player[];
    edge: boolean;
    first: readonly [number, number];
}

function plan(ctx: SetPieceContext): SetPiecePlan | null {
    const byClique = new Map<string, { names: readonly string[]; planner: string; online: Player[] }>();
    for (const p of directorBots()) {
        if (p.is_bot !== true || (p.botPlanner !== 'extras_edgeville_pker' && p.botPlanner !== 'extras_pker')) continue;
        const info = cliqueInfoOf(p.username);
        if (!info || info.kind === 'levelling' || !available(p, ctx.play, RECRUIT_SESSION_LEFT)) continue;
        const key = info.names[0];
        const entry = byClique.get(key) ?? byClique.set(key, { names: info.names, planner: p.botPlanner, online: [] }).get(key)!;
        if (p.botPlanner === entry.planner) entry.online.push(p);
    }
    const options: { plan: RaidPlan; score: number }[] = [];
    for (const { names, planner, online } of byClique.values()) {
        if (online.length < TEAM[0]) continue;
        // (the leader: the first of the clique online, as on patrol (port/BotCliques pkCliqueLeader), with 45 minutes left)
        const team = [...online].sort((a, b) => names.indexOf(a.username) - names.indexOf(b.username)).slice(0, TEAM[1]);
        if (BotManager.sessionLeftOf(team[0].username) < LEAD_SESSION_LEFT) continue;
        const edge = planner === 'extras_edgeville_pker';
        const first = PATROL_POINTS[Math.floor(ctx.dice() * PATROL_POINTS.length)];
        options.push({ plan: { team, edge, first }, score: Math.min(1, team.length / 3) * (edge ? 1 : 0.5) });
    }
    if (options.length === 0) return null;
    const best = Math.max(...options.map(o => o.score));
    const top = options.filter(o => o.score === best);
    const pick = top[Math.floor(ctx.dice() * top.length)];
    const [x, z] = pick.plan.first;
    return { kind: 'pk_raid', venue: { key: 'varrock_wildy', x, z, level: 0, say: 'varrock wildy' }, score: pick.score, data: pick.plan };
}

function cheb(ax: number, az: number, bx: number, bz: number): number {
    return Math.max(Math.abs(ax - bx), Math.abs(az - bz));
}

/** the player `p` attacks now (an attack op on a player), or null */
function attacking(p: Player): Player | null {
    const op = p.targetOp;
    return p.target instanceof Player && (op === ServerTriggerType.APPLAYER2 || op === ServerTriggerType.OPPLAYER2) ? p.target : null;
}

/** its PK task's target (the one it fights or goes for), or the player it attacks */
function targetOf(p: Player): Player | null {
    const task = BotManager.botFor(p)?.currentTask as { target?: unknown } | null | undefined;
    const t = task?.target;
    return t instanceof Player ? t : attacking(p);
}

export class PkRaidRun implements SetPieceRun, PkRaid {
    readonly id = nextSetPieceId();
    readonly kind = 'pk_raid' as const;
    readonly venue: SetPieceVenue;
    phase: SetPiecePhase = 'announce';
    readonly startedAt: number;
    endsBy: number;
    readonly roles = new Map<Player, string>();
    outcome: string | undefined;
    readonly escapeBelow = RAID_ESCAPE_BELOW;
    leader: Player;
    readonly team: Player[];
    /** an Edgeville team (else a deep one) */
    readonly edge: boolean;
    /** the leader's patrol point, and when it moves on */
    point: readonly [number, number];
    private pointUntil = -1;
    private phaseUntil: number;
    private called = false;
    private readonly out = new Set<Player>();
    private readonly piled = new Set<Player>();
    private piles = 0;
    /** where each member stood at the last step */
    private readonly lastAt = new Map<Player, [number, number]>();

    constructor(p: RaidPlan, now: number) {
        this.team = [...p.team];
        this.leader = p.team[0];
        this.edge = p.edge;
        this.point = p.first;
        this.venue = { key: 'varrock_wildy', x: p.first[0], z: p.first[1], level: 0, say: 'varrock wildy' };
        this.startedAt = now;
        this.phaseUntil = now + GATHER_TICKS;
        this.endsBy = now + GATHER_TICKS + GO_TICKS + PATROL_TICKS[1] + HOME_TICKS + 200;
        this.roles.set(this.leader, 'leader');
        for (const m of this.team) if (m !== this.leader) this.roles.set(m, 'member');
    }

    // ── what the PK tasks ask ────────────────────────────────────────────────────────────────────────────────────

    partOf(p: Player): 'gather' | 'go' | 'patrol' | 'home' | null {
        if (!this.roles.has(p)) return null;
        switch (this.phase) {
            case 'announce':
                return 'gather';
            case 'build':
                return 'go';
            case 'peak':
                return 'patrol';
            case 'end':
                return 'home';
            default:
                return null;
        }
    }

    spotFor(p: Player): [number, number] | null {
        const part = this.partOf(p);
        if (part === null || part === 'home') return null;
        if (part === 'gather' && this.edge) return [EDGE_MEET[0] + randInt(-2, 2), EDGE_MEET[1] + randInt(-2, 2)];
        if (p === this.leader || part === 'gather') return [this.point[0] + randInt(-1, 1), this.point[1] + randInt(-1, 1)];
        // (round the leader, inside the strip)
        const x = Math.max(RAID_ZONE.x0, Math.min(RAID_ZONE.x1, this.leader.x + randInt(-FORMATION, FORMATION)));
        const z = Math.max(RAID_ZONE.z0, Math.min(RAID_ZONE.z1, this.leader.z + randInt(-FORMATION, FORMATION)));
        return [x, z];
    }

    leaderOf(p: Player): Player | null {
        return !this.roles.has(p) || p === this.leader ? null : this.leader;
    }

    sameTeam(a: Player, b: Player): boolean {
        return a !== b && this.roles.has(a) && this.roles.has(b);
    }

    mayShare(p: Player, target: Player): boolean {
        if (!this.roles.has(p) || this.roles.has(target) || this.phase === 'done') return false;
        if (!isMultiCombat(target.x, target.z, target.level)) return false;
        // (every bot on it counts: a team-mate going for it, and any other bot attacking it, a lone PKer on the human too)
        let on = 0;
        for (const m of this.roles.keys()) if (m !== p && m.slot !== -1 && targetOf(m) === target) on++;
        for (const m of BotManager.activeBots()) if (m !== p && !this.roles.has(m) && m.level === target.level && attacking(m) === target) on++;
        return on < MAX_ON_ONE;
    }

    teamTarget(p: Player): Player | null {
        if (p === this.leader || !this.roles.has(p) || this.phase !== 'peak') return null;
        const t = targetOf(this.leader);
        return t && t.slot !== -1 && t.level === p.level && this.mayShare(p, t) ? t : null;
    }

    notePile(p: Player, target: Player): void {
        if (this.piled.has(target) || !this.roles.has(p)) return;
        this.piled.add(target);
        this.piles++;
        if (Math.random() < 0.5) say(p, 'pk-team-pile', target);
    }

    noteOut(p: Player): void {
        if (!this.roles.has(p) || this.out.has(p)) return;
        this.out.add(p);
        if (Math.random() < 0.6) say(p, 'pk-team-retreat');
        if ((this.out.size >= 2 || p === this.leader) && this.phase === 'peak') this.goHome(World.currentTick, 'beaten');
    }

    /** piles started (a team-mate on a target a team-mate fought), for the log */
    get pileCount(): number {
        return this.piles;
    }

    // ── the run ──────────────────────────────────────────────────────────────────────────────────────────────────

    tick(now: number): void {
        if (this.phase === 'done') return;
        if (this.leader.slot === -1 || !BotManager.botFor(this.leader)) {
            this.abort('leader left');
            return;
        }
        // (one dead, or a jump since the last step (Lumbridge's respawn, a teleport): out of the team. The director steps
        // every 5 ticks, a run 10 tiles at most)
        for (const m of [...this.roles.keys()]) {
            const last = this.lastAt.get(m);
            const jumped = last !== undefined && cheb(m.x, m.z, last[0], last[1]) > JUMP_TILES;
            this.lastAt.set(m, [m.x, m.z]);
            if (m.levels[PlayerStat.HITPOINTS] <= 0 || jumped) this.left(m, 'death');
            if ((this.phase as SetPiecePhase) === 'done') return;
        }
        if (this.phase === 'announce') {
            const meet = this.edge ? EDGE_MEET : this.point;
            if (!this.called && cheb(this.leader.x, this.leader.z, meet[0], meet[1]) <= 6) {
                this.called = true;
                const after = say(this.leader, 'pk-team-call');
                // (an answer after the call is out: its reading and typing on top)
                for (const m of this.team) if (m !== this.leader && this.roles.has(m) && Math.random() < 0.5) say(m, 'pk-team-answer', null, after + randInt(4, 16));
                this.onlookers(meet);
            }
            const here = [...this.roles.keys()].every(m => cheb(m.x, m.z, meet[0], meet[1]) <= 8);
            if ((this.called && here) || now >= this.phaseUntil) {
                this.phase = 'build';
                this.phaseUntil = now + GO_TICKS;
                say(this.leader, 'pk-team-go');
            }
            return;
        }
        if (this.phase === 'build') {
            if (cheb(this.leader.x, this.leader.z, this.point[0], this.point[1]) <= 8 || now >= this.phaseUntil) {
                this.phase = 'peak';
                this.phaseUntil = now + randInt(PATROL_TICKS[0], PATROL_TICKS[1]);
                this.pointUntil = now + randInt(POINT_TICKS[0], POINT_TICKS[1]);
            }
            return;
        }
        if (this.phase === 'peak') {
            if (now >= this.phaseUntil) {
                this.goHome(now, 'done');
                return;
            }
            // (the leader from point to point, a neighbour's, while it is not fighting)
            if (now >= this.pointUntil && targetOf(this.leader) === null && cheb(this.leader.x, this.leader.z, this.point[0], this.point[1]) <= 6) {
                const near = PATROL_POINTS.filter(q => q !== this.point && cheb(q[0], q[1], this.point[0], this.point[1]) <= 20);
                this.point = near.length > 0 ? near[Math.floor(Math.random() * near.length)] : this.point;
                this.pointUntil = now + randInt(POINT_TICKS[0], POINT_TICKS[1]);
            }
            return;
        }
        // (home: an Edgeville team back toward the edge, a deep one to its zones; over once it is out of the strip)
        const away = [...this.roles.keys()].every(m => m.slot === -1 || m.x < RAID_ZONE.x0 - 10 || !this.edge);
        if (away || now >= this.phaseUntil) this.finish(this.outcome ?? 'done');
    }

    private goHome(now: number, why: string): void {
        if (this.phase === 'end' || this.phase === 'done') return;
        this.outcome ??= why;
        this.phase = 'end';
        this.phaseUntil = now + HOME_TICKS;
        say(this.leader, why === 'beaten' ? 'pk-team-retreat' : 'pk-team-after');
    }

    /** bots near the meeting, not PKers, may speak of the team (the chatter's 'pk-team-seen'), at most two */
    private onlookers(at: readonly [number, number]): void {
        let n = 0;
        for (const p of directorBots()) {
            if (n >= 2) break;
            if (p.level !== 0 || this.roles.has(p) || p.botPlanner === 'extras_pker' || p.botPlanner === 'extras_edgeville_pker') continue;
            if (cheb(p.x, p.z, at[0], at[1]) > 12 || !BotManager.botFor(p) || Math.random() >= 0.3) continue;
            noteEvent(p, 'pk-team-seen');
            n++;
        }
    }

    left(p: Player, _why: 'logout' | 'death' | 'fight' | 'stuck'): void {
        if (!this.roles.has(p) || this.phase === 'done') return;
        this.roles.delete(p);
        if (p === this.leader) {
            this.abort('leader left');
            return;
        }
        if (this.roles.size < TEAM[0] && this.phase !== 'end') this.goHome(World.currentTick, 'too few');
    }

    rumour(): string | null {
        return rumourText('pk_raid', this.point);
    }

    abort(why: string): void {
        this.finish(why);
    }

    private finish(outcome: string): void {
        if (this.phase === 'done') return;
        this.outcome ??= outcome;
        this.phase = 'done';
    }
}

/**
 * a set piece's line, typed (LineKind 'setpiece') `after` ticks or more from now, counted against the bot's talk budget;
 * the ticks until it is out (0: none said)
 */
function say(bot: Player, moment: string, to: Player | null = null, after = 0): number {
    if (bot.slot === -1 || !BotManager.botFor(bot)) return 0;
    const text = setPieceLine(bot, moment);
    if (text === null) return 0;
    const persona = botPersona(bot);
    const extra = after + reactionTicks(persona, 'notice');
    sayTyped(bot, text, { to, kind: 'setpiece' }, extra);
    countAsBudgetedLine(bot);
    return extra + typingTicks(persona, text);
}

function start(p: SetPiecePlan, _ctx: SetPieceContext): SetPieceRun | null {
    const data = p.data as RaidPlan;
    if (data.team.some(m => m.slot === -1 || !BotManager.botFor(m))) return null;
    const run = new PkRaidRun(data, World.currentTick);
    // (each to its part: an Edgeville PKer banks for food first, a deep one walks to the strip)
    for (const m of data.team) {
        const task = BotManager.botFor(m)?.currentTask as { joinRaid?: (player: Player) => void } | null | undefined;
        task?.joinRaid?.(m);
    }
    return run;
}

register({ kind: 'pk_raid', weight: { members: 15, free: 20 }, plan, start });
