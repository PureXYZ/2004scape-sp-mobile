/**
 * port (the variety work, round 2, Track D2: WHERE-6, travel
 * §6.3 P16) members
 *
 * 274's own ways to the far north-west of Kandarin, taken by real clicks: the spirit trees (area_gnome's spirit_tree.rs2:
 * the young tree north of Varrock to the Tree Gnome Village's, that one to the Gnome Stronghold's and back; the
 * Stronghold's to Varrock) and the gnome glider (gnome_glider.rs2: the pilot at Al Kharid, Kar-Hewo, to the top of the
 * Grand Tree, Ta Quir Priw, and back). Agility at the Gnome course was 91 % of the time a walk from 600+ tiles away.
 *
 * BotAction.walkTo asks travelLeg on a long walk (one marked line beside the teleport spells' leg): a route whose walk to
 * its first hop and from its last hop is well under the walk (TRAVEL_SAVES) is taken as the bot's sub-task (TravelTask:
 * the task that walks waits, no stuck check of its fires meanwhile), the hops clicked as a player clicks them (the tree's
 * Talk-to and its pages and choices, the pilot's Talk-to, its choice and the glider map's button), the game's own script
 * moving the bot (marked for the humanlike report: noteMove 'event'); then the walk goes on from where it landed. Decided
 * once a destination (a bot walks most trips); on a free world never (the trees and gliders are members').
 */
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import ScriptState from '#/engine/script/ScriptState.js';
import Component from '#/cache/config/Component.js';
import LocType from '#/cache/config/LocType.js';
import type Loc from '#/engine/entity/Loc.js';
// (BotAction imports this module for walkTo's leg, and BotTaskBase imports BotAction: so no class here extends BotTask at
// load, and BotTaskBase's helpers are used only inside the methods, after every module is loaded)
import type { BotTask, SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import { StuckDetector, humanDelay } from '#/engine/bot/tasks/BotTaskBase.js';
import { botAnswerDialogue, botScript, findNpcByName, interactIfButtonByName, interactLocOp, interactNpcOp, isNear, noteMove, walkTo } from '#/engine/bot/BotAction.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';

type At = readonly [number, number, number];

/** one ride: where the bot boards it, what it clicks, the answers it gives, where it lands */
interface Hop {
    /** the tile it boards from (beside the tree, the pilot) */
    readonly board: At;
    /** the loc clicked (a spirit tree), or the NPC (the pilot) */
    readonly loc?: string;
    readonly npc?: string;
    /** the dialogue's choices in order (1-based); pages are continued */
    readonly answers: readonly number[];
    /** a glider map's button, pressed when the map opens */
    readonly button?: string;
    /** where it lands (about) */
    readonly lands: At;
}

/** a route: its hops; it starts at the first's board and ends at the last's landing */
export interface TravelRoute {
    readonly key: string;
    readonly hops: readonly Hop[];
    /** ticks the clicks and dialogues add (a person's) */
    readonly overhead: number;
}

const VARROCK_TREE: Hop = { board: [3178, 3508, 0], loc: 'loc_1317', answers: [1], lands: [2542, 3169, 0] };
const VILLAGE_TREE_TO_STRONGHOLD: Hop = { board: [2542, 3170, 0], loc: 'stronghold_ent', answers: [2, 3], lands: [2461, 3444, 0] };
const STRONGHOLD_TREE_TO_VARROCK: Hop = { board: [2462, 3444, 0], loc: 'ent', answers: [2, 2], lands: [3179, 3507, 0] };
const ALKHARID_GLIDER: Hop = { board: [3285, 3213, 0], npc: 'gnomepilot', answers: [1], button: 'glidermap:com_22', lands: [2465, 3501, 3] };

export const TRAVEL_ROUTES: readonly TravelRoute[] = [
    { key: 'trees-varrock-stronghold', hops: [VARROCK_TREE, VILLAGE_TREE_TO_STRONGHOLD], overhead: 60 },
    { key: 'tree-stronghold-varrock', hops: [STRONGHOLD_TREE_TO_VARROCK], overhead: 30 },
    { key: 'glider-alkharid-grandtree', hops: [ALKHARID_GLIDER], overhead: 90 }
];

/** a walk at least this long (tiles) is worth a look */
export const TRAVEL_MIN = 300;
/** a route is taken when the walk with it is at most this share of the walk without */
export const TRAVEL_SAVES = 0.6;

const cheb = (ax: number, az: number, bx: number, bz: number): number => Math.max(Math.abs(ax - bx), Math.abs(az - bz));

/** a route's walk (tiles and its clicks) from (x, z) to (dx, dz) */
function routeCost(r: TravelRoute, x: number, z: number, dx: number, dz: number): number {
    const first = r.hops[0].board;
    const last = r.hops[r.hops.length - 1].lands;
    // (the Grand Tree's top: its floors down count as a walk of 40)
    return cheb(x, z, first[0], first[1]) + r.overhead + cheb(last[0], last[1], dx, dz) + (last[2] > 0 ? 40 : 0);
}

/** the route for this walk, or null: the walk itself is best */
export function bestRoute(x: number, z: number, dx: number, dz: number): TravelRoute | null {
    const direct = cheb(x, z, dx, dz);
    if (direct < TRAVEL_MIN) return null;
    let best: TravelRoute | null = null;
    let bestCost = direct * TRAVEL_SAVES;
    for (const r of TRAVEL_ROUTES) {
        const c = routeCost(r, x, z, dx, dz);
        if (c < bestCost) {
            best = r;
            bestCost = c;
        }
    }
    return best;
}

/** what travel did (the report: how many trips use each route; the tests) */
export const travelStats = { asked: 0, taken: {} as Record<string, number>, done: {} as Record<string, number>, failed: {} as Record<string, number>, ticks: [] as number[] };

/** the destination each bot decided on last, and the verdict (walk, or the route taken) */
const decided = new WeakMap<Player, { x: number; z: number; tick: number }>();
/** bots on a ride now (their sub-task): walkTo's leg says no meanwhile */
const riding = new WeakSet<Player>();

/**
 * walkTo's hook (BotAction.walkTo, beside teleportLeg; one marked line): true when this long walk is taken over by a ride
 * (the bot's sub-task from now: TravelTask); false: walk.
 */
export function travelLeg(player: Player, destX: number, destZ: number, level: number): boolean {
    if (riding.has(player) || level !== 0 || player.level !== 0 || player.z > 6400 || destZ > 6400 || !isMembersWorld()) return false;
    if (player.is_bot !== true || wildernessLevelAt(player.x, player.z) > 0) return false;
    const now = World.currentTick;
    const d = decided.get(player);
    // (the same destination, decided within the hour: as decided; a walk's detours and doors do not ask again)
    if (d && cheb(d.x, d.z, destX, destZ) <= 20 && now - d.tick < 6000) return false;
    if (cheb(player.x, player.z, destX, destZ) < TRAVEL_MIN) return false;
    decided.set(player, { x: destX, z: destZ, tick: now });
    travelStats.asked++;
    const route = bestRoute(player.x, player.z, destX, destZ);
    if (!route) return false;
    const ai = (player as unknown as { _bot?: { setSubTask(t: BotTask): void; hasSubTask(): boolean } })._bot;
    // (only for the bot's own plan's walk: a sub-task's walk (a fight, an errand) goes on foot)
    if (!ai || ai.hasSubTask()) return false;
    travelStats.taken[route.key] = (travelStats.taken[route.key] ?? 0) + 1;
    ai.setSubTask(new TravelTask(route) as unknown as BotTask);
    return true;
}

/** (tests) forget the bots' decisions */
export function forgetTravelForTest(player: Player): void {
    decided.delete(player);
}

/** the loc of this debugname nearest (x, z) within `r` */
function locNear(name: string, at: At, r: number): Loc | null {
    const id = LocType.getId(name);
    if (id === -1) return null;
    let best: Loc | null = null;
    let bestD = Infinity;
    for (let zx = (at[0] - r) & ~7; zx <= at[0] + r; zx += 8) {
        for (let zz = (at[1] - r) & ~7; zz <= at[1] + r; zz += 8) {
            const zone = World.gameMap.getZone(zx, zz, at[2]);
            if (!zone) continue;
            for (const loc of zone.getAllLocsSafe()) {
                const dd = cheb(loc.x, loc.z, at[0], at[1]);
                if (loc.type === id && dd <= r && dd < bestD) {
                    bestD = dd;
                    best = loc;
                }
            }
        }
    }
    return best;
}

/**
 * A ride's hops as the bot's sub-task: walk to the board (no further rides meanwhile), click, answer, press the map's
 * button, wait for the landing; over at the last landing (done) or at a hop that does not come (failed: the bot walks).
 */
export class TravelTask {
    readonly name = 'Travel';
    interrupted = false;
    private hop = 0;
    private phase: 'walk' | 'click' | 'talk' | 'fly' = 'walk';
    private waitTicks = 0;
    private ticks = 0;
    /** the hop's choices answered so far (its answers' index) */
    private given = 0;
    /**
     * (the variety work, round 2, the fixes) ticks with no dialogue since the click (still walking up to it), and in the
     * air: their own counts. `given` counted both, so a bot still walking when the tree's first page opened answered its
     * first choice with the last answer and its second with a page's 1 (the Village tree's ride ended at the Battlefield of
     * Khazard, the Stronghold tree's at the Tree Gnome Village instead of Varrock)
     */
    private idle = 0;
    private flying = 0;
    private talking = false;
    private clicks = 0;
    private readonly started = World.currentTick;
    private over = false;
    private rider: Player | null = null;
    /** for the debugger and the report */
    state = 'walk';

    private stuck: StuckDetector | null = null;

    constructor(readonly route: TravelRoute) {}

    shouldRun(): boolean {
        return !this.over;
    }
    isComplete(): boolean {
        return this.over;
    }
    interrupt(): void {
        this.interrupted = true;
        this.over = true;
        // (its rider free to ride again: an interrupted ride left the bot marked for its session)
        if (this.rider) riding.delete(this.rider);
    }
    reset(): void {
        this.stuck = null;
    }
    activityStep(): SkillStep | null {
        return null;
    }

    private end(player: Player, ok: boolean): void {
        this.over = true;
        riding.delete(player);
        const map = ok ? travelStats.done : travelStats.failed;
        map[this.route.key] = (map[this.route.key] ?? 0) + 1;
        if (ok) travelStats.ticks.push(World.currentTick - this.started);
    }

    tick(player: Player): void {
        if (this.over) return;
        riding.add(player);
        this.rider = player;
        const hop = this.route.hops[this.hop];
        this.state = `${this.phase} ${this.hop}`;
        if (++this.ticks > 3000) return this.end(player, false);
        if (this.waitTicks > 0) {
            this.waitTicks--;
            return;
        }
        if (this.phase === 'walk') {
            const [x, z, level] = hop.board;
            if (player.level === level && isNear(player, x, z, 3, level)) {
                this.phase = 'click';
                this.waitTicks = humanDelay(player, 'next');
                return;
            }
            this.stuck ??= new StuckDetector(40, 4, 3);
            if (!this.stuck.check(player, x, z)) walkTo(player, x, z, level);
            else if (this.stuck.desperatelyStuck) this.end(player, false);
            else walkTo(player, x + Math.floor(Math.random() * 7) - 3, z + Math.floor(Math.random() * 7) - 3, level);
            return;
        }
        if (this.phase === 'click') {
            if (++this.clicks > 3) return this.end(player, false);
            if (hop.loc) {
                const loc = locNear(hop.loc, hop.board, 6);
                if (!loc) return this.end(player, false);
                interactLocOp(player, loc, 1);
            } else if (hop.npc) {
                const npc = findNpcByName(hop.board[0], hop.board[1], hop.board[2], hop.npc, 8);
                if (!npc) return this.end(player, false);
                interactNpcOp(player, npc, 1);
            }
            this.phase = 'talk';
            this.given = 0;
            this.idle = 0;
            this.talking = false;
            this.waitTicks = 2;
            return;
        }
        if (this.phase === 'talk') {
            // (the glider's map: its button, the bot's move marked for the report first)
            if (hop.button) {
                const com = Component.getId(hop.button);
                const c = com === -1 ? undefined : Component.get(com);
                if (c && player.isComponentVisible(c)) {
                    noteMove(player, 'event');
                    interactIfButtonByName(player, hop.button);
                    this.phase = 'fly';
                    this.flying = 0;
                    this.waitTicks = 2;
                    return;
                }
            }
            const script = botScript(player);
            if (script && script.execution === ScriptState.PAUSEBUTTON) {
                // (its first page: the choices from the first; 274's spirit_tree.rs2 is two pages, p_choice2, three pages,
                // p_choice3 for the Village and Stronghold trees, two pages and p_choice2 for the young tree)
                if (!this.talking) {
                    this.talking = true;
                    this.given = 0;
                }
                const answer = hop.answers[Math.min(this.given, hop.answers.length - 1)];
                if (botAnswerDialogue(player, answer) === 'choice') {
                    this.given++;
                    // (a tree's last choice: its spirit_tree_tele, a page and the telejump: the game's move, marked)
                    if (!hop.button && this.given >= hop.answers.length) {
                        noteMove(player, 'event');
                        this.phase = 'fly';
                        this.flying = 0;
                    }
                }
                this.waitTicks = humanDelay(player, 'page');
                return;
            }
            // (no dialogue: still walking up to it, or it never came)
            if (++this.idle > 60) this.phase = 'click';
            return;
        }
        // fly: landed when the bot is near the hop's landing (the tree's telejump, the glider's teleport after its 3 ticks)
        const [lx, lz, ll] = hop.lands;
        if (player.level === ll && cheb(player.x, player.z, lx, lz) <= 12) {
            this.hop++;
            this.phase = 'walk';
            this.clicks = 0;
            this.stuck = null;
            if (this.hop >= this.route.hops.length) this.end(player, true);
            else this.waitTicks = humanDelay(player, 'next');
            return;
        }
        // (a page still open: the tree's last box, its continue the telejump: marked again)
        if (botScript(player)?.execution === ScriptState.PAUSEBUTTON) {
            if (!hop.button) noteMove(player, 'event');
            botAnswerDialogue(player, 1);
        }
        if (++this.flying > 40) this.end(player, false);
    }
}
