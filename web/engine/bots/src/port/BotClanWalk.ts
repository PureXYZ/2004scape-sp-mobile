// port (the realism work, phase 5b, Track D: groups on the move; "clan walks in matching capes"; saved bots buy a red
// cape at Thessalia's, new bots wear their clique's colour): a clan walk, a set piece of
// the director (port/BotDirector). 2004's clans had no clan chat: they met at a place and showed in matching capes,
// and clans walked across the F2P map.
//
//   - The clan: a levelling clique (port/BotCliques) with 3 or more members free (the director's isFreeForEvent) within
//     150 tiles of a hub (CLAN_HUBS: friends meet where most of them are), its leader the one with the most session left
//     (45 minutes at least); at most 6.
//   - The capes: the clique's colour (cliqueColourOf: new bots of a clique wear it, port/BotLooks) when 3 of them own one
//     (worn, in the pack or the bank), else red: those without one buy a red cape at Thessalia's (Varrock, 274's clothes
//     shop, 4 gp: a real purchase through the shop's window, port/BotGear clanCapePurchase) when the shop is within reach
//     of them and of the meeting hub, 3 at most (the shop stocks 4), none with a full pack; a leader with its cape already
//     where one can lead. A member that can get neither stays out of the walk: the capes match. A cape in the bank comes
//     out at the nearest bank's booth on the way to the meeting (a direct move, as the bots' bank moves are).
//   - The walk: the members gather at the hub (announce: the leader's call; build: the rest come, 6 minutes at most, 9
//     with a cape to buy), then 2-4 legs between hubs the walking graph joins with no gateway (no toll gate, boat,
//     stairs or Wilderness: nothing breaks the line), about 8-20 minutes: the leader walks (never runs) and stands while
//     the last of the line is more than 10 tiles behind; member i follows member i-1 with the game's Follow
//     (port/BotFollow ChainFollowTask: a conga line, not a star). At each hub a stop of 1-2 minutes: the line breaks up
//     onto tiles of their own beside the leader (port/BotTiles), an emote now and then, a line ("next stop varrock");
//     bots near it may say something of it (port/BotChatter: 'clan-seen'). At the last hub the leader ends it ("gf all"),
//     1-3 minutes there (no stop before it). Waiting at the meeting they mill about (a step every 50-110 ticks).
//   - The leader answers "can i join ur clan?" (the human's line, or a bot's): "need a red cape lol".
//   - Its rumour: "clan walking thru draynor lol" (port/BotLines rumourText, where the leader is).
// Every part is a sub-task (ClanLeadTask, ClanMemberTask): the bot's own task waits and goes on after. A member that is
// lost (a building the Follow cannot round, a gate) walks to the line by a path; one lost for good, or logged out,
// leaves the line and the one behind it follows the one ahead. The leader gone: the walk ends ("nvm lol"). Every line is
// a set piece's (LineKind 'setpiece', out of H7), counted against its speaker's talk budget.
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { walkTo } from '#/engine/bot/BotAction.js';
import { advanceBankWalk, BotTask, humanDelay, isInventoryFull, randInt, StuckDetector } from '#/engine/bot/tasks/BotTaskBase.js';
import { ShopTripTask } from '#/engine/bot/tasks/ShopTripTask.js';
import { nextSetPieceId, register, type SetPieceContext, type SetPiecePhase, type SetPiecePlan, type SetPieceRun, type SetPieceVenue } from '#/engine/bot/port/BotSetPieces.js';
import { BotChat, botPersona, humanLineListeners, sayTyped } from '#/engine/bot/port/BotChat.js';
import { countAsBudgetedLine, noteEvent } from '#/engine/bot/port/BotChatter.js';
import { cliqueColourOf, cliqueInfoOf } from '#/engine/bot/port/BotCliques.js';
import { directorBots, isFreeForEvent, LEAD_SESSION_LEFT } from '#/engine/bot/port/BotDirector.js';
import { botEmote, type Emote } from '#/engine/bot/port/BotEmote.js';
import { ChainFollowTask } from '#/engine/bot/port/BotFollow.js';
import { CAPE_SHOP, clanCapePurchase, wearClanCape, whereOwned } from '#/engine/bot/port/BotGear.js';
import { rumourText, setPieceLine, type SetPieceLineOptions } from '#/engine/bot/port/BotLines.js';
import { wardrobeItems } from '#/engine/bot/port/BotLooks.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { sayListeners } from '#/engine/bot/port/BotSay.js';
import { claimStandTile, releaseStandTile, stepToTile } from '#/engine/bot/port/BotTiles.js';
import { reactionTicks } from '#/engine/bot/port/BotTiming.js';
import { componentOf, nearestNode, route as graphRoute, routeCost } from '#/engine/bot/port/BotWalkGraph.js';
import { isAllowedCoord } from '#/engine/bot/port/BotWorldRules.js';

// ── the map: hubs and the legs between them ───────────────────────────────────────────────────────────────────────

export interface ClanHub {
    key: string;
    x: number;
    z: number;
    /** how a bot names it */
    say: string;
    members?: boolean;
}

/** where clans meet and stop: 2004's hubs and landmarks (each the walking graph's: test/groups.test checks) */
export const CLAN_HUBS: readonly ClanHub[] = [
    { key: 'lumbridge_courtyard', x: 3222, z: 3218, say: 'lumby' },
    { key: 'lumbridge_mill', x: 3166, z: 3290, say: 'the mill' },
    { key: 'draynor_bank', x: 3092, z: 3245, say: 'draynor' },
    { key: 'draynor_manor_road', x: 3109, z: 3336, say: 'draynor manor' },
    { key: 'port_sarim', x: 3026, z: 3208, say: 'port sarim' },
    { key: 'rimmington', x: 2957, z: 3215, say: 'rimmington' },
    { key: 'falador_west_bank', x: 2946, z: 3368, say: 'fally west bank' },
    { key: 'falador_park', x: 2997, z: 3375, say: 'fally park' },
    { key: 'falador_east_bank', x: 3013, z: 3355, say: 'fally east bank' },
    { key: 'goblin_village', x: 2956, z: 3505, say: 'goblin village' },
    { key: 'monastery', x: 3051, z: 3490, say: 'the monastery' },
    { key: 'barbarian_village', x: 3082, z: 3420, say: 'barb village' },
    { key: 'edgeville_bank', x: 3093, z: 3491, say: 'edge' },
    { key: 'cooks_guild', x: 3143, z: 3443, say: 'the cooks guild' },
    { key: 'varrock_west_bank', x: 3185, z: 3436, say: 'varrock west bank' },
    { key: 'varrock_square', x: 3212, z: 3428, say: 'varrock square' },
    { key: 'varrock_east_bank', x: 3253, z: 3420, say: 'varrock east bank' },
    { key: 'varrock_south', x: 3208, z: 3384, say: 'south varrock' },
    { key: 'champions_guild', x: 3191, z: 3366, say: 'the champs guild' },
    { key: 'al_kharid_bank', x: 3269, z: 3167, say: 'al kharid' },
    { key: 'al_kharid_palace', x: 3293, z: 3170, say: 'the palace' },
    { key: 'al_kharid_mine', x: 3299, z: 3300, say: 'al kharid mine' },
    { key: 'seers_bank', x: 2725, z: 3493, say: 'seers', members: true },
    { key: 'seers_church', x: 2727, z: 3464, say: 'seers church', members: true },
    { key: 'camelot_gate', x: 2758, z: 3480, say: 'camelot', members: true },
    { key: 'catherby_bank', x: 2808, z: 3441, say: 'catherby', members: true },
    { key: 'legends_guild', x: 2729, z: 3349, say: 'the legends guild', members: true },
    { key: 'ardougne_north_bank', x: 2616, z: 3332, say: 'ardy north bank', members: true },
    { key: 'ardougne_market', x: 2662, z: 3305, say: 'ardy market', members: true },
    { key: 'ardougne_south_bank', x: 2655, z: 3283, say: 'ardy south bank', members: true },
    { key: 'ardougne_zoo', x: 2610, z: 3270, say: 'the zoo', members: true }
];

/** the legs a walk takes, either way (40-260 tiles each by the walking graph, no gateway between: test/groups.test) */
export const CLAN_LEGS: readonly (readonly [string, string])[] = [
    ['lumbridge_courtyard', 'draynor_bank'], ['lumbridge_courtyard', 'champions_guild'], ['lumbridge_courtyard', 'varrock_south'], ['lumbridge_courtyard', 'lumbridge_mill'],
    ['draynor_bank', 'draynor_manor_road'], ['draynor_bank', 'port_sarim'], ['draynor_bank', 'falador_east_bank'], ['draynor_bank', 'lumbridge_mill'],
    ['draynor_manor_road', 'barbarian_village'], ['draynor_manor_road', 'port_sarim'], ['port_sarim', 'rimmington'], ['rimmington', 'falador_east_bank'],
    ['falador_west_bank', 'falador_park'], ['falador_west_bank', 'goblin_village'], ['falador_park', 'goblin_village'], ['falador_west_bank', 'barbarian_village'],
    ['falador_east_bank', 'barbarian_village'], ['falador_park', 'monastery'], ['falador_park', 'falador_east_bank'],
    ['barbarian_village', 'edgeville_bank'], ['barbarian_village', 'varrock_west_bank'], ['barbarian_village', 'cooks_guild'], ['barbarian_village', 'champions_guild'], ['barbarian_village', 'monastery'],
    ['edgeville_bank', 'monastery'], ['edgeville_bank', 'champions_guild'], ['cooks_guild', 'varrock_west_bank'],
    ['varrock_west_bank', 'varrock_east_bank'], ['varrock_square', 'varrock_east_bank'], ['varrock_square', 'champions_guild'], ['varrock_west_bank', 'champions_guild'], ['varrock_square', 'varrock_south'],
    ['varrock_east_bank', 'al_kharid_mine'], ['champions_guild', 'al_kharid_mine'], ['al_kharid_bank', 'al_kharid_palace'], ['al_kharid_palace', 'al_kharid_mine'], ['al_kharid_bank', 'al_kharid_mine'],
    ['seers_bank', 'catherby_bank'], ['catherby_bank', 'camelot_gate'], ['catherby_bank', 'seers_church'], ['seers_church', 'legends_guild'], ['seers_bank', 'legends_guild'], ['catherby_bank', 'legends_guild'],
    ['legends_guild', 'ardougne_market'], ['ardougne_north_bank', 'ardougne_market'], ['ardougne_market', 'ardougne_south_bank'], ['ardougne_south_bank', 'ardougne_zoo'], ['ardougne_north_bank', 'ardougne_zoo'], ['seers_bank', 'ardougne_north_bank']
];

/**
 * members within this of the meeting hub come to it (a clan's friends meet where most of them are: the director's
 * recruits for a crowd come from 60 tiles, but a clique's members train apart, 3 of one within 60 tiles of a hub at 100
 * bots about once in a few hours of play; within 150 a few times an hour, a walk of 1-3 minutes to the meeting)
 */
const RECRUIT_RANGE = 150;
/** a clan walks with 3-6 */
const CLAN_MIN = 3;
const CLAN_MAX = 6;
/** a walk's legs, and its length by the walking graph (tiles) */
const LEGS: readonly [number, number] = [2, 4];
const ROUTE_TILES: readonly [number, number] = [150, 700];
/** Thessalia's within this of a member and of the meeting hub: it buys its red cape there on its way */
const CAPE_REACH = 220;
/** at most this many buy a cape for a walk (Thessalia's stocks 4 red capes, and other bots buy them too) */
const MAX_BUYERS = 3;
/** the gathering's time at most (6 minutes; 9 with a cape to buy), the announce before it */
const GATHER_TICKS = 600;
const GATHER_BUY_TICKS = 900;
const ANNOUNCE_TICKS: readonly [number, number] = [60, 180];
/** at the meeting hub: within this of it */
const MEET_RANGE = 8;
/** each stop (1-2 minutes), the end (1-3 minutes) */
const STOP_TICKS: readonly [number, number] = [100, 190];
/**
 * waiting at the meeting, a step to another tile now and then (ticks): people mill about; a stand of 2 minutes or more
 * with nothing to do is what the humanlike report's H19 counts
 */
const MILL_TICKS: readonly [number, number] = [50, 110];
const END_TICKS: readonly [number, number] = [60, 180];
/** the leader stands while the last of the line is farther than this behind, and walks on once it is within WAIT_UNTIL */
const WAIT_GAP = 10;
const WAIT_UNTIL = 6;
/** a hub reached: within this */
const AT_HUB = 4;
/** an onlooker's chance at a stop (bots within ONLOOK_RANGE not in the clan, at most 2 a stop) */
const ONLOOK_CHANCE = 0.2;
const ONLOOK_RANGE = 10;
/**
 * the chances of a line (a set piece's few calls, not a stream: X2): a member's at the meeting and at a stop, the
 * leader's at a stop's arrival and at its end ("next stop varrock"), a member's at the end; an emote at a stop
 */
const MEMBER_LINE_CHANCE = 0.2;
const MEMBER_STOP_LINE_CHANCE = 0.1;
const ARRIVE_LINE_CHANCE = 0.3;
const NEXT_LINE_CHANCE = 0.6;
const EMOTE_CHANCE = 0.3;
/** the cape colours by index (port/BotLooks wardrobeItems().capes), as the lines name them */
export const CAPE_COLOURS: readonly string[] = ['red', 'black', 'blue', 'yellow', 'green', 'purple', 'orange'];

const hubByKey = new Map(CLAN_HUBS.map(h => [h.key, h] as const));
const legsOf = new Map<string, string[]>();
for (const [a, b] of CLAN_LEGS) {
    (legsOf.get(a) ?? legsOf.set(a, []).get(a)!).push(b);
    (legsOf.get(b) ?? legsOf.set(b, []).get(b)!).push(a);
}

/** a leg's length by the walking graph (cached; Infinity where it does not join the hubs) */
const legCost = new Map<string, number>();
export function clanLegTiles(a: ClanHub, b: ClanHub): number {
    const key = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
    let cost = legCost.get(key);
    if (cost === undefined) {
        const na = nearestNode(a.x, a.z);
        const nb = nearestNode(b.x, b.z);
        const nodes = na >= 0 && nb >= 0 && componentOf(na) === componentOf(nb) ? graphRoute(na, nb) : null;
        cost = nodes ? routeCost(nodes) : Infinity;
        legCost.set(key, cost);
    }
    return cost;
}

function hubAllowed(hub: ClanHub, members: boolean): boolean {
    return members ? true : !hub.members && isAllowedCoord(hub.x, hub.z);
}

/**
 * A walk from `start`: 2-4 legs to hubs not visited yet, ROUTE_TILES long by the walking graph (a few tries at random;
 * shorter where the hubs are near each other, as Al Kharid's), the start first; null when none fits.
 */
export function clanRoute(start: ClanHub, members: boolean, dice: () => number): ClanHub[] | null {
    let best: { hubs: ClanHub[]; tiles: number } | null = null;
    for (let attempt = 0; attempt < 12; attempt++) {
        const want = LEGS[0] + Math.floor(dice() * (LEGS[1] - LEGS[0] + 1));
        const hubs = [start];
        let tiles = 0;
        while (hubs.length - 1 < want) {
            const at = hubs[hubs.length - 1];
            const next = (legsOf.get(at.key) ?? []).map(k => hubByKey.get(k)!).filter(h => hubAllowed(h, members) && !hubs.includes(h) && Number.isFinite(clanLegTiles(at, h)));
            if (next.length === 0) break;
            const h = next[Math.floor(dice() * next.length)];
            tiles += clanLegTiles(at, h);
            hubs.push(h);
            if (tiles > ROUTE_TILES[1]) break;
        }
        if (hubs.length - 1 < LEGS[0] || tiles > ROUTE_TILES[1]) continue;
        if (tiles >= ROUTE_TILES[0]) return hubs;
        if (!best || tiles > best.tiles) best = { hubs, tiles };
    }
    return best && best.tiles >= ROUTE_TILES[0] / 2 ? best.hubs : null;
}

function cheb(ax: number, az: number, bx: number, bz: number): number {
    return Math.max(Math.abs(ax - bx), Math.abs(az - bz));
}

// ── the plan ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface ClanPlan {
    clique: readonly string[];
    leader: Player;
    /** the walkers, the leader first */
    walkers: Player[];
    /** those who buy a red cape at Thessalia's on the way */
    buyers: Set<Player>;
    /** the cape's colour (an index into wardrobeItems().capes) */
    colour: number;
    route: ClanHub[];
}

function owns(p: Player, capeId: number): boolean {
    return capeId !== -1 && whereOwned(p, capeId) !== null;
}

/** the walk a clique could make now from the hub most of its free members are near, or null */
function planClique(names: readonly string[], free: Player[], ctx: SetPieceContext): ClanPlan | null {
    let best: { hub: ClanHub; near: Player[]; spread: number } | null = null;
    for (const hub of CLAN_HUBS) {
        if (!hubAllowed(hub, ctx.members)) continue;
        const near = free.filter(p => cheb(p.x, p.z, hub.x, hub.z) <= RECRUIT_RANGE);
        if (near.length < CLAN_MIN) continue;
        const spread = near.reduce((sum, p) => sum + cheb(p.x, p.z, hub.x, hub.z), 0);
        if (!best || near.length > best.near.length || (near.length === best.near.length && spread < best.spread)) best = { hub, near, spread };
    }
    if (!best) return null;
    const capes = wardrobeItems().capes;
    const own = cliqueColourOf(names[0]) ?? 0;
    let colour = own;
    let walkers = best.near.filter(p => owns(p, capes[own]));
    const buyers = new Set<Player>();
    if (own === 0 || walkers.length < CLAN_MIN) {
        // (red: theirs, or a red cape bought at Thessalia's on the way where the shop is near them and the hub)
        colour = 0;
        walkers = best.near.filter(p => owns(p, capes[0]));
        if (cheb(best.hub.x, best.hub.z, CAPE_SHOP[0], CAPE_SHOP[1]) <= CAPE_REACH) {
            for (const p of best.near) {
                // (a full pack takes nothing from the shop's window)
                if (buyers.size >= MAX_BUYERS || walkers.includes(p) || cheb(p.x, p.z, CAPE_SHOP[0], CAPE_SHOP[1]) > CAPE_REACH || isInventoryFull(p) || clanCapePurchase(p) === null) continue;
                walkers.push(p);
                buyers.add(p);
            }
        }
    }
    if (walkers.length < CLAN_MIN) return null;
    // (the leader: one with its cape already where one has 45 minutes of session left, a buyer's trip can fail (the
    // shop's stock out); of them the most session left; at most 6 walk, the nearest the hub)
    const canLead = walkers.filter(p => ctx.sessionLeft(p) >= LEAD_SESSION_LEFT);
    const owners = canLead.filter(p => !buyers.has(p));
    const leader = (owners.length > 0 ? owners : canLead).sort((a, b) => ctx.sessionLeft(b) - ctx.sessionLeft(a))[0];
    if (!leader) return null;
    const rest = walkers.filter(p => p !== leader).sort((a, b) => cheb(a.x, a.z, best!.hub.x, best!.hub.z) - cheb(b.x, b.z, best!.hub.x, best!.hub.z)).slice(0, CLAN_MAX - 1);
    for (const p of [...buyers]) if (p !== leader && !rest.includes(p)) buyers.delete(p);
    const route = clanRoute(best.hub, ctx.members, ctx.dice);
    if (!route) return null;
    return { clique: names, leader, walkers: [leader, ...rest], buyers, colour, route };
}

function plan(ctx: SetPieceContext): SetPiecePlan | null {
    // (the bots' own census: the levelling cliques with members free now)
    const byClique = new Map<string, { names: readonly string[]; free: Player[] }>();
    for (const p of directorBots()) {
        if (p.is_bot !== true || p.level !== 0 || !isLevelling(p.botPlanner as PlannerKey) || isNewbie(p)) continue;
        const info = cliqueInfoOf(p.username);
        if (!info || info.kind !== 'levelling' || !isFreeForEvent(p, ctx.play)) continue;
        const key = info.names[0];
        const entry = byClique.get(key) ?? byClique.set(key, { names: info.names, free: [] }).get(key)!;
        entry.free.push(p);
    }
    const options: ClanPlan[] = [];
    for (const { names, free } of byClique.values()) {
        if (free.length < CLAN_MIN) continue;
        const p = planClique(names, free, ctx);
        if (p) options.push(p);
    }
    if (options.length === 0) return null;
    const most = Math.max(...options.map(o => o.walkers.length));
    const top = options.filter(o => o.walkers.length === most);
    const pick = top[Math.floor(ctx.dice() * top.length)];
    const start = pick.route[0];
    return { kind: 'clan_walk', venue: { key: start.key, x: start.x, z: start.z, level: 0, say: start.say }, score: Math.min(1, pick.walkers.length / 4), data: pick };
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** the clan walk under way (one at a time: the director's), for the human's "can i join" and the bots' */
let active: ClanWalkRun | null = null;

/** The clan walk under way, or null (the humanlike runner reads its capes: G3). */
export function activeClanWalk(): ClanWalkRun | null {
    return active && active.phase !== 'done' ? active : null;
}

export class ClanWalkRun implements SetPieceRun {
    readonly id = nextSetPieceId();
    readonly kind = 'clan_walk' as const;
    readonly venue: SetPieceVenue;
    phase: SetPiecePhase = 'announce';
    readonly startedAt: number;
    endsBy: number;
    readonly roles = new Map<Player, string>();
    outcome: string | undefined;
    /** the cape's colour (an index into wardrobeItems().capes) and its item */
    readonly colour: number;
    readonly capeId: number;
    readonly route: readonly ClanHub[];
    leader: Player;
    /** the line behind the leader, in order (member i follows member i-1, the first the leader) */
    line: Player[];
    readonly tasks = new Map<Player, ClanLeadTask | ClanMemberTask>();
    /** the hub the leader heads for (route[leg]; 0 the meeting), a stop there under way until (-1: walking) */
    leg = 0;
    stopUntil = -1;
    /** the leader stands for the line to catch up */
    waiting = false;
    private waitLines = 0;
    private announceUntil = -1;
    private readonly gatherUntil: number;
    private legStarted = -1;
    private endAt = -1;
    private joinAnswered = false;

    constructor(p: ClanPlan, now: number) {
        const start = p.route[0];
        this.venue = { key: start.key, x: start.x, z: start.z, level: 0, say: start.say };
        this.startedAt = now;
        this.colour = p.colour;
        this.capeId = wardrobeItems().capes[p.colour] ?? -1;
        this.route = p.route;
        this.leader = p.leader;
        this.line = p.walkers.filter(w => w !== p.leader);
        this.gatherUntil = now + (p.buyers.size > 0 ? GATHER_BUY_TICKS : GATHER_TICKS);
        let tiles = 0;
        for (let i = 1; i < p.route.length; i++) tiles += clanLegTiles(p.route[i - 1], p.route[i]);
        this.endsBy = this.gatherUntil + Math.round(tiles * 1.6) + (p.route.length - 1) * STOP_TICKS[1] + END_TICKS[1] + 300;
        this.roles.set(p.leader, 'leader');
        for (const m of this.line) this.roles.set(m, 'member');
    }

    /** where the walk is now: the leader */
    get at(): [number, number] {
        return [this.leader.x, this.leader.z];
    }

    /** the hub the leader heads for or stops at */
    get hub(): ClanHub {
        return this.route[Math.min(this.leg, this.route.length - 1)];
    }

    /** the one a member follows: the one ahead of it in the line */
    aheadOf(p: Player): Player {
        const i = this.line.indexOf(p);
        return i <= 0 ? this.leader : this.line[i - 1];
    }

    /** the line walks now (not gathering, stopping or over) */
    get walking(): boolean {
        return this.phase === 'peak' && this.stopUntil < 0;
    }

    tick(now: number): void {
        if (this.phase === 'done') return;
        // (a part whose sub-task the bot no longer runs: it left the line, stuck or called away)
        for (const [p, task] of this.tasks) {
            if (!this.roles.has(p)) continue;
            if (task.gone(p)) this.left(p, 'stuck');
            if ((this.phase as SetPiecePhase) === 'done') return;
        }
        if (this.phase === 'announce' || this.phase === 'build') this.gather(now);
        else if (this.phase === 'peak') this.walk(now);
        else if (this.phase === 'end' && now >= this.endAt) this.finish('done');
    }

    private gather(now: number): void {
        const hub = this.route[0];
        const leaderThere = cheb(this.leader.x, this.leader.z, hub.x, hub.z) <= MEET_RANGE && this.tasks.get(this.leader)?.caped === true;
        if (this.phase === 'announce') {
            if (leaderThere && this.announceUntil < 0) {
                this.announceUntil = now + randInt(ANNOUNCE_TICKS[0], ANNOUNCE_TICKS[1]);
                say(this.leader, 'clan-call', { at: [hub.x, hub.z] });
            }
            if ((this.announceUntil >= 0 && now >= this.announceUntil) || now >= this.gatherUntil - 200) this.phase = 'build';
            return;
        }
        const here = this.line.filter(m => (this.tasks.get(m) as ClanMemberTask | undefined)?.ready === true && cheb(m.x, m.z, hub.x, hub.z) <= MEET_RANGE);
        if (here.length < this.line.length && now < this.gatherUntil) return;
        if (!leaderThere && now < this.gatherUntil + 100) return;
        // (who did not come in time stays out of it)
        for (const m of [...this.line]) if (!here.includes(m)) this.left(m, 'stuck');
        if (this.phase === 'done') return;
        if (!leaderThere || this.line.length < CLAN_MIN - 1) {
            this.abort('too few');
            return;
        }
        // (the line sets off: the nearest the leader behind it)
        this.line.sort((a, b) => cheb(a.x, a.z, this.leader.x, this.leader.z) - cheb(b.x, b.z, this.leader.x, this.leader.z));
        this.phase = 'peak';
        this.leg = 1;
        this.stopUntil = -1;
        this.legStarted = now;
        say(this.leader, 'clan-go');
    }

    private walk(now: number): void {
        const hub = this.hub;
        if (this.stopUntil >= 0) {
            if (now < this.stopUntil) return;
            this.stopUntil = -1;
            this.leg++;
            if (this.leg >= this.route.length) {
                this.phase = 'end';
                this.endAt = now + randInt(END_TICKS[0], END_TICKS[1]);
                say(this.leader, 'clan-end');
                for (const m of this.line) if (Math.random() < MEMBER_LINE_CHANCE) say(m, 'clan-end');
                return;
            }
            this.legStarted = now;
            const next = this.hub;
            if (Math.random() < NEXT_LINE_CHANCE) say(this.leader, 'clan-next', { at: [next.x, next.z] });
            return;
        }
        // (the last of the line far behind: the leader stands; on again once it caught up)
        const last = this.line[this.line.length - 1];
        const gap = last ? cheb(last.x, last.z, this.leader.x, this.leader.z) : 0;
        if (!this.waiting && gap > WAIT_GAP) {
            this.waiting = true;
            if (this.waitLines < 1 && Math.random() < 0.5) {
                this.waitLines++;
                say(this.leader, 'clan-wait');
            }
        } else if (this.waiting && gap <= WAIT_UNTIL) this.waiting = false;
        const legTicks = Math.round(clanLegTiles(this.route[this.leg - 1], hub) * 2.5) + 200;
        const arrived = cheb(this.leader.x, this.leader.z, hub.x, hub.z) <= AT_HUB;
        if (!arrived && now - this.legStarted < legTicks) return;
        // (at the hub, or the leg took far too long: a stop there anyway; at the last hub the end is its stop, 1-3 minutes:
        // a stop and then the end there stood them 3-6 minutes, the humanlike report's H19)
        this.waiting = false;
        if (this.leg >= this.route.length - 1) {
            this.phase = 'end';
            this.endAt = now + randInt(END_TICKS[0], END_TICKS[1]);
            say(this.leader, 'clan-end');
            for (const m of this.line) if (Math.random() < MEMBER_LINE_CHANCE) say(m, 'clan-end');
            this.onlookers();
            return;
        }
        this.stopUntil = now + randInt(STOP_TICKS[0], STOP_TICKS[1]);
        if (Math.random() < ARRIVE_LINE_CHANCE) say(this.leader, 'clan-next');
        for (const m of this.line) if (Math.random() < MEMBER_STOP_LINE_CHANCE) say(m, 'clan-member');
        this.onlookers();
    }

    /** bots near the stop, not of the clan, may say something of it (the chatter's 'clan-seen'), at most two */
    private onlookers(): void {
        let n = 0;
        for (const p of directorBots()) {
            if (n >= 2) break;
            if (p.level !== this.leader.level || this.roles.has(p) || cheb(p.x, p.z, this.leader.x, this.leader.z) > ONLOOK_RANGE) continue;
            if (!BotManager.botFor(p) || Math.random() >= ONLOOK_CHANCE) continue;
            noteEvent(p, 'clan-seen');
            n++;
        }
    }

    left(p: Player, why: 'logout' | 'death' | 'fight' | 'stuck'): void {
        if (!this.roles.has(p) || this.phase === 'done') return;
        this.roles.delete(p);
        const task = this.tasks.get(p);
        this.tasks.delete(p);
        if (p.slot !== -1) task?.release(p);
        if (p === this.leader) {
            // (the leader gone: a word from one of the line, and the walk is over)
            const speaker = this.line.find(m => m.slot !== -1);
            if (speaker && why === 'logout') say(speaker, 'clan-end');
            this.abort('leader left');
            return;
        }
        const i = this.line.indexOf(p);
        if (i >= 0) this.line.splice(i, 1);
        // (the one behind it follows the one ahead now)
        for (const m of this.line) (this.tasks.get(m) as ClanMemberTask | undefined)?.relink(m);
        if (this.phase === 'peak' && this.line.length < CLAN_MIN - 1) {
            this.phase = 'end';
            this.stopUntil = -1;
            this.endAt = World.currentTick + randInt(END_TICKS[0], END_TICKS[1]);
            say(this.leader, 'clan-end');
        }
    }

    rumour(): string | null {
        return rumourText('clan_walk', this.at);
    }

    abort(why: string): void {
        this.finish(why);
    }

    private finish(outcome: string): void {
        if (this.phase === 'done') return;
        this.outcome ??= outcome;
        this.phase = 'done';
        for (const [p, task] of this.tasks) task.release(p);
        this.tasks.clear();
        if (active === this) active = null;
    }

    /** a question to the clan ("can i join ur clan?"): the leader answers once a walk, after it read it */
    answerJoin(asker: Player): boolean {
        if (this.joinAnswered || this.phase === 'done' || this.leader.slot === -1) return false;
        if (asker.level !== this.leader.level || cheb(asker.x, asker.z, this.leader.x, this.leader.z) > 15) return false;
        this.joinAnswered = true;
        const leader = this.leader;
        const text = setPieceLine(leader, `clan-join-${CAPE_COLOURS[this.colour]}`);
        if (text === null) return false;
        sayTyped(leader, text, { to: asker, kind: 'setpiece' }, reactionTicks(botPersona(leader), 'notice') + 3);
        countAsBudgetedLine(leader);
        return true;
    }
}

/** a set piece's line, typed (LineKind 'setpiece'), counted against the bot's talk budget; false when none fits */
function say(bot: Player, moment: string, where: SetPieceLineOptions = {}, to: Player | null = null): boolean {
    if (bot.slot === -1 || !BotManager.botFor(bot)) return false;
    const text = setPieceLine(bot, moment, where);
    if (text === null) return false;
    sayTyped(bot, text, { to, kind: 'setpiece' }, reactionTicks(botPersona(bot), 'notice'));
    countAsBudgetedLine(bot);
    return true;
}

// ── the parts ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** a part's common ending: a person's moment, its tile given back */
abstract class ClanPart extends BotTask {
    protected readonly run: ClanWalkRun;
    protected done = false;
    protected holdUntil = -1;
    /** the world tick it last ran (a part BotPlayer no longer runs: another sub-task took its place) */
    protected lastTickAt = -1;
    private started = false;
    private ended = false;
    /** its cape: to see to, out of the bank, at Thessalia's, on */
    private cape: 'check' | 'bank' | 'shop' | 'on' = 'check';
    private readonly buys: boolean;
    private trip: ShopTripTask | null = null;
    protected readonly stuck = new StuckDetector(30, 4, 2);

    protected constructor(name: string, run: ClanWalkRun, buys: boolean) {
        super(name);
        this.run = run;
        this.buys = buys;
    }

    /**
     * Its clan's cape first: on already, from its pack, out of the bank at the nearest booth (a direct move, as the bots'
     * bank moves), or a red one bought at Thessalia's (the shop's window, 274's price) and put on. True while it sees to it;
     * false once it wears it. One that cannot get it leaves the walk (the leader: the walk is off).
     */
    protected seeToCape(player: Player): boolean {
        if (this.cape === 'on') return false;
        const id = this.run.capeId;
        if (this.cape === 'check') {
            const where = whereOwned(player, id);
            if (where === 'worn' || (where === 'pack' && wearClanCape(player, id, false))) {
                this.cape = 'on';
                return false;
            }
            if (where === 'bank') this.cape = 'bank';
            else {
                const buy = this.buys ? clanCapePurchase(player) : null;
                if (!buy) {
                    this.noCape(player);
                    return true;
                }
                this.trip = new ShopTripTask(buy.shopKey, buy.itemId, 1, buy.cost);
                this.trip.reset();
                this.cape = 'shop';
                if (Math.random() < 0.4) say(player, 'clan-cape');
            }
        }
        if (this.cape === 'bank') {
            if (advanceBankWalk(player, this.stuck) === 'walk') return true;
            wearClanCape(player, id, true);
            if (player.modalMain !== -1) player.closeModal();
            this.stuck.reset();
            if (whereOwned(player, id) !== 'worn') {
                this.noCape(player);
                return true;
            }
            this.cape = 'on';
            return false;
        }
        // (at Thessalia's)
        const trip = this.trip!;
        if (!trip.isComplete(player) && trip.shouldRun(player)) {
            trip.tick(player);
            return true;
        }
        if (whereOwned(player, id) === 'pack') wearClanCape(player, id, false);
        if (whereOwned(player, id) !== 'worn') {
            this.noCape(player);
            return true;
        }
        // (on: "got my cape", and a red one's own now and then, "red cape on lol")
        if (Math.random() < 0.4) say(player, this.run.colour === 0 && Math.random() < 0.5 ? 'clan-cape-on-red' : 'clan-cape-on');
        this.stuck.reset();
        this.cape = 'on';
        return false;
    }

    /** it could not get its cape: out of the walk (its leader: the walk is off) */
    private noCape(player: Player): void {
        if (player === this.run.leader) this.run.abort('no cape');
        else this.run.left(player, 'stuck');
    }

    /** wearing its cape (seen to) */
    get caped(): boolean {
        return this.cape === 'on';
    }

    shouldRun(): boolean {
        return true;
    }

    isComplete(): boolean {
        return this.done && World.currentTick >= this.holdUntil;
    }

    /** its bot no longer runs it (replaced, wound down at a logout): the walk lets it go */
    gone(player: Player): boolean {
        if (this.done) return false;
        if (this.ended) return true;
        const ai = BotManager.botFor(player) as unknown as { subTask?: unknown } | null;
        return this.started && World.currentTick - this.lastTickAt > 10 && ai?.subTask !== this;
    }

    /** the walk is over for it (or it left): it stops, a person's moment, then its own task */
    release(player: Player): void {
        if (this.done) return;
        this.done = true;
        this.holdUntil = World.currentTick + 1 + humanDelay(player, 'retarget');
        releaseStandTile(player);
        if (player.target !== null && (player.target as { username?: string }).username !== undefined) player.clearInteraction();
        this.ended = true;
    }

    protected began(): void {
        this.started = true;
        this.lastTickAt = World.currentTick;
    }

    override reset(): void {
        super.reset();
        // (a reset after it ran: a logout's wind-down; it is over)
        if (this.started) this.ended = true;
    }
}

/** the leader: to the meeting hub, then the legs (walking, never running), standing at each stop and for stragglers */
export class ClanLeadTask extends ClanPart {
    private emoted = -1;
    private standAt = -1;

    constructor(run: ClanWalkRun, buys: boolean) {
        super('ClanWalk', run, buys);
    }

    tick(player: Player): void {
        this.began();
        if (this.done || this.seeToCape(player)) return;
        const run = this.run;
        if (run.phase === 'announce' || run.phase === 'build') {
            const hub = run.route[0];
            if (cheb(player.x, player.z, hub.x, hub.z) > MEET_RANGE - 3) this.walkToward(player, hub.x, hub.z);
            else this.stand(player, hub.x, hub.z);
            return;
        }
        if (run.phase === 'peak' && run.walking && !run.waiting) {
            this.standAt = -1;
            const hub = run.hub;
            releaseStandTile(player);
            this.walkToward(player, hub.x, hub.z);
            // (a clan walks: the leader's pace is the line's)
            player.run = 0;
            return;
        }
        // (a stop, the end, or waiting for the line)
        if (run.waiting) {
            if (player.hasWaypoints()) player.clearWaypoints();
            return;
        }
        this.stand(player, player.x, player.z);
        if (this.emoted !== run.leg && Math.random() < EMOTE_CHANCE / 20) {
            this.emoted = run.leg;
            botEmote(player, pickEmote());
        }
    }

    private walkToward(player: Player, x: number, z: number): void {
        if (!this.stuck.check(player, x, z)) walkTo(player, x, z, 0);
        else if (!this.stuck.desperatelyStuck) {
            player.clearWaypoints();
            walkTo(player, x + randInt(-4, 4), z + randInt(-4, 4), 0);
        } else this.stuck.reset();
    }

    /** on a tile of its own near (x, z) */
    private stand(player: Player, x: number, z: number): void {
        const now = World.currentTick;
        // (waiting at the meeting it mills about: a step to another tile of its own now and then)
        const gathering = this.run.phase === 'announce' || this.run.phase === 'build';
        if (this.standAt < 0 || (gathering && now >= this.standAt)) {
            this.standAt = gathering ? now + randInt(MILL_TICKS[0], MILL_TICKS[1]) : now;
            releaseStandTile(player);
            const tile = claimStandTile(player, x, z, 0, 3);
            if (tile) stepToTile(player, tile[0], tile[1]);
        }
    }
}

/** a member: its cape first (on, from the bank, or bought at Thessalia's), the meeting, then the line */
export class ClanMemberTask extends ClanPart {
    private chain: ChainFollowTask | null = null;
    private standLeg = -2;
    private emoted = -1;
    /** at the meeting with its cape on */
    ready = false;

    constructor(run: ClanWalkRun, buys: boolean) {
        super('ClanWalk', run, buys);
    }

    /** the one it follows (port/BotTeleport.leadsAFriend: it casts no spell, takes no wrong turn while it leads one) */
    get leaderPlayer(): Player | null {
        return this.chain && this.run.walking ? this.chain.leaderPlayer : null;
    }

    /** the one ahead of it changed (one left the line) */
    relink(player: Player): void {
        this.chain?.setLead(player, this.run.aheadOf(player));
    }

    tick(player: Player): void {
        this.began();
        if (this.done || this.seeToCape(player)) return;
        const run = this.run;
        if (run.phase === 'announce' || run.phase === 'build') {
            const hub = run.route[0];
            if (cheb(player.x, player.z, hub.x, hub.z) > MEET_RANGE - 3) {
                if (!this.stuck.check(player, hub.x, hub.z)) walkTo(player, hub.x, hub.z, 0);
                else player.clearWaypoints();
                return;
            }
            if (!this.ready) {
                this.ready = true;
                if (Math.random() < MEMBER_LINE_CHANCE) say(player, 'clan-member');
            }
            this.standNear(player, hub.x, hub.z, -1);
            return;
        }
        if (run.walking) {
            this.standLeg = -2;
            releaseStandTile(player);
            if (!this.chain) {
                this.chain = new ChainFollowTask(run.aheadOf(player), Math.max(1, run.endsBy + 300 - World.currentTick));
                this.chain.reset();
            } else this.chain.setLead(player, run.aheadOf(player));
            this.chain.shouldRun(player);
            this.chain.tick(player);
            // (lost for good, or a trade began: out of the line)
            if (this.chain.over) run.left(player, 'stuck');
            return;
        }
        // (a stop, the end: off the line onto a tile of its own beside the leader)
        if (player.target === run.aheadOf(player)) player.clearInteraction();
        this.standNear(player, run.leader.x, run.leader.z, run.leg);
        if (this.emoted !== run.leg && run.phase === 'peak' && Math.random() < EMOTE_CHANCE / 20) {
            this.emoted = run.leg;
            botEmote(player, pickEmote());
        }
    }

    private millAt = -1;

    private standNear(player: Player, x: number, z: number, leg: number): void {
        const now = World.currentTick;
        // (waiting at the meeting it mills about: a step to another tile of its own now and then)
        if (this.standLeg === leg && !(leg === -1 && now >= this.millAt)) return;
        this.standLeg = leg;
        if (leg === -1) {
            this.millAt = now + randInt(MILL_TICKS[0], MILL_TICKS[1]);
            releaseStandTile(player);
        }
        const tile = claimStandTile(player, x, z, 0, 4);
        if (tile) stepToTile(player, tile[0], tile[1]);
    }
}

const STOP_EMOTES: readonly Emote[] = ['wave', 'dance', 'cheer', 'wave', 'clap'];
function pickEmote(): Emote {
    return STOP_EMOTES[Math.floor(Math.random() * STOP_EMOTES.length)];
}

function start(p: SetPiecePlan, _ctx: SetPieceContext): SetPieceRun | null {
    const data = p.data as ClanPlan;
    const now = World.currentTick;
    // (each still free: the plan was a moment ago)
    if (data.walkers.some(w => w.slot === -1 || !BotManager.botFor(w))) return null;
    listen();
    const run = new ClanWalkRun(data, now);
    for (const w of data.walkers) {
        const ai = BotManager.botFor(w)!;
        const task = w === data.leader ? new ClanLeadTask(run, data.buyers.has(w)) : new ClanMemberTask(run, data.buyers.has(w));
        run.tasks.set(w, task);
        ai.setSubTask(task);
    }
    active = run;
    return run;
}

register({ kind: 'clan_walk', weight: { members: 20, free: 25 }, plan, start });

// ── "can i join ur clan?" ─────────────────────────────────────────────────────────────────────────────────────────

const JOIN = /\bjoin\b.*\b(ur|your|the|this|that)?\s*clan\b|\bclan\b.*\bjoin\b|\bcan i (be in|come in) (ur|your) clan\b/i;

/**
 * The walks' ears, from the first walk on (not at this module's load: port/BotSetPieceIndex loads it, and an import
 * cycle through port/BotChat can run this module before BotChat's own body, its listeners' lists not made yet)
 */
let listening = false;
function listen(): void {
    if (listening) return;
    listening = true;
    // the human's line: the clan's leader near it answers ("need a red cape lol"), and no other bot does
    humanLineListeners.push((human, text) => {
        const run = activeClanWalk();
        if (!run || !JOIN.test(text)) return;
        return run.answerJoin(human);
    });
    // a bot's line near the walk ("can i join ur clan?", an onlooker's): the leader answers it too, once a walk
    sayListeners.push((player, line, kind) => {
        if (!active || kind === 'setpiece' || kind === 'rumour' || player.is_bot !== true || active.roles.has(player) || !JOIN.test(line)) return;
        const run = active;
        const asker = player;
        // (after the asker's line is out: the leader reads it)
        if (BotChat.inConversation(run.leader)) return;
        run.answerJoin(asker);
    });
}
