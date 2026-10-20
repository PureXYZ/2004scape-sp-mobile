// port: a bot that is not out to fight answers a monster that attacks it (Phase 3: with earned gear a death costs a bot
// its kit). Upstream left this to four skilling tasks (woodcutting, fletching's logs, mining, fishing), which ran only
// from a monster above the bot's combat level, and only to the middle of their spot, where the bot mostly was already;
// every other task walked or worked on. In the 50-bot sims Lumbridge's giant spiders (level 2, aggressive to combat 4
// and below) and its bear killed level-3 woodcutters, fishers and a bot on a shop trip: 274 does not let a player who
// is busy (at a tree, on a walk) hit back by itself, and one that stops gets its auto-retaliate, against a bear too.
// Now, for every task but the fights and thieving (BotPlayer: OWN_DEFENCE_KINDS), BotPlayer asks here first:
//   - a monster of at most the bot's level is fought off, while the bot is above FIGHT_BACK_ABOVE of its Hitpoints;
//     one that neither hits nor is hit for FIGHT_STALL_TICKS (behind a wall or a fence; two Al Kharid warriors at a bot
//     in a single-combat area) is ignored until the bot is hurt;
//   - any other, or once the bot is hurt, is run from, running: of the ways away from it (straight away, a quarter turn
//     either side) the route that ends farthest from it, and on again for as long as it chases, at most
//     FLEE_MAX_TICKS. Its searches are never refused for the budget (in a busy tick a bot that waited for one stood
//     still while a spider killed it);
//   - cornered (no route gets it 3 tiles off: a hut with its door shut), it fights a weak attacker, hurt or not, and
//     walks off from a strong one by the game's own walk, which opens the door on the way (a level-3 fighter running
//     from a giant spider inside a goblin hut east of Lumbridge stepped to and fro until it died);
//   - the third run in FLEE_WINDOW_TICKS ends the task (the planner picks again).
// port (the realism work, phase 5a, Track F: the danger check; "fallible bots", fallible, not suicidal):
//   - on the run it eats (its best food, a bite every EAT_RUNNING_TICKS) below EAT_RUNNING_BELOW of its Hitpoints: an eat
//     stops an attack, not the walk (274's consume script). It never ate on the run before;
//   - a careless bot notices an attacker later: round(carelessness × 4) ticks of being hit before it answers;
//   - hurt (under DANGER_BELOW of its Hitpoints) where monsters hunt it (port/BotDanger: dangerAt, huntsMe), a careful
//     bot gets its Hitpoints back first: it eats, or fetches food from a bank where nothing hunts it (tasks/RestTask, a
//     sub-task: its task waits); with no food anywhere it leaves (its task ends) and heals to REST_TO doing something
//     where nothing hunts it (isHealing: the planner's step 1e). A careless one (carelessness × 0.5, decided once a
//     while) goes on. The phase-1 leftover "skilling at low HP beside aggressive monsters far above the bot";
//   - attacked on White Wolf Mountain: now and then "stupid wolves" (port/BotChatter's 'wolves').
import type Npc from '#/engine/entity/Npc.js';
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import { findAggressorNpc, getNpcCombatLevel, interactNpcOp, walkTo } from '#/engine/bot/BotAction.js';
import { botWalkPath } from '#/engine/bot/port/BotPathing.js';
import { bankedFood, carriedFood, eatBestFood, hpBelow, npcReach, type BotTask } from '#/engine/bot/tasks/BotTaskBase.js';
import NpcType from '#/cache/config/NpcType.js';
import { dangerAt, huntsMe } from '#/engine/bot/port/BotDanger.js';
import { carelessnessOf, carelessRoll, dangerStats, isShaken, keepOffHunted, REPEAT_DEATH_TICKS } from '#/engine/bot/port/BotFumble.js';
import { noteEvent, onWhiteWolfMountain } from '#/engine/bot/port/BotChatter.js';
import { RestTask, REST_TO, REST_LIMIT_TICKS } from '#/engine/bot/tasks/RestTask.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';

/** the task kinds that answer their own attackers: the fights (combat, ranged and magic, PKers); a thief's stall guard is answered here */
export const OWN_DEFENCE_KINDS: ReadonlySet<string> = new Set(['Combat', 'RangedMagic', 'PKer', 'EdgevillePKer']);

/** a bot fights back a monster of at most its own level while above this share of its Hitpoints */
const FIGHT_BACK_ABOVE = 0.4;
/** a fight with no blow landed either way for this long is a stalemate: the attacker is ignored until the bot is hurt
 * (in the 274 sims a bot with two warriors at it in Al Kharid's palace stood 576 ticks, the one it attacked and the
 * other each kept from the fight; a bot in a goblin hut swung at a spider outside for 4,240 ticks). A run the bot got
 * away on starts the clock again; one spent cornered, fighting, does not */
const FIGHT_STALL_TICKS = 24;
/** it runs this far at a time */
const FLEE_TILES = 12;
/** a new leg (its searches) at most this often */
const LEG_TICKS = 4;
/** a run whose best route ends nearer than this is no run: the bot is cornered */
const CORNERED_TILES = 3;
/** a run ends when nothing chases the bot any more, or this long after it began */
const FLEE_MAX_TICKS = 40;
/** the third run within this many ticks ends the bot's task */
const FLEE_WINDOW_TICKS = 600;
const MAX_FLEES = 3;
/** an NPC's Hitpoints in its levels (NpcStat.HITPOINTS) */
const NPC_HITPOINTS = 3;
/** port (phase 5a): on the run, eat below this share of the Hitpoints, a bite at most every EAT_RUNNING_TICKS */
export const EAT_RUNNING_BELOW = 0.45;
const EAT_RUNNING_TICKS = 3;
/** port (phase 5a: the danger check): hurt below this share where monsters hunt the bot, it gets its Hitpoints back first */
export const DANGER_BELOW = 0.5;
/** port (phase 5a): the danger check looks this often (ticks), and a careless bot's "go on anyway" holds this long */
const DANGER_CHECK_TICKS = 8;
const DANGER_DECISION_TICKS = 600;
/** port (phase 5a): the danger check is for a bot at its task's spot, this near (tiles): one walking through goes on */
const DANGER_SPOT_TILES = 20;

interface Flight {
    since: number;
    /** when its last leg began */
    leg: number;
    /** port: a leg got it away (not cornered all along: then the fight's stalemate clock runs on) */
    ran: boolean;
}

const flights = new WeakMap<Player, Flight>();
/** port (phase 5a): its last bite on the run, a careless bot's late notice (the attacker, from when it answers), the danger
 * check's decision (go on until then: a careless bot's) */
const lastBite = new WeakMap<Player, number>();
const notices = new WeakMap<Player, { npc: Npc; at: number }>();
const dangerGoOn = new WeakMap<Player, number>();
/** port (phase 5a): a bot that left a hunted spot hurt with no food: healing until then (and under REST_TO) */
const healing = new WeakMap<Player, number>();
/**
 * port (phase 5a): the tick of the bot's last food trip for the danger check (a RestTask with no food carried); another
 * within REFETCH_TICKS and it leaves the spot instead (keepOffHunted): it ate what it fetched at the bank and came back
 * with none, a walk to a safe bank and back each time its Hitpoints fell, the whole plan
 */
const lastFetch = new WeakMap<Player, number>();
const REFETCH_TICKS = 3000;
/** the fight a bot is in: its foe, and both sides' Hitpoints since when */
const fights = new WeakMap<Player, { npc: Npc; since: number; hp: number; npcHp: number }>();
const fleeStarts = new WeakMap<Player, number[]>();
/** port: an attacker that neither hit nor was hit for FIGHT_STALL_TICKS (behind a wall: a hut's, a fence) is ignored until the bot is hurt */
const ignored = new WeakMap<Player, { npc: Npc; hp: number }>();

function ignoring(player: Player, npc: Npc): boolean {
    const ig = ignored.get(player);
    if (!ig || ig.npc !== npc) return false;
    const hp = player.levels[PlayerStat.HITPOINTS];
    if (hp < ig.hp) {
        ignored.delete(player);
        return false;
    }
    ig.hp = hp;
    return true;
}

/**
 * One tick of the bot's self-defence: 'fight' (it fights a weak attacker) and 'flee' (it runs): its task waits;
 * 'give-up': it runs, for the third time in a few minutes, and its task should end; null: nothing attacks it.
 */
export function defend(player: Player): 'fight' | 'flee' | 'give-up' | null {
    const now = World.currentTick;
    const flight = flights.get(player);
    if (flight) {
        const chaser = findAggressorNpc(player, FLEE_TILES);
        if (!chaser || ignoring(player, chaser) || now - flight.since >= FLEE_MAX_TICKS) {
            flights.delete(player);
            if (flight.ran) fights.delete(player);
            return null;
        }
        eatOnTheRun(player, now); // (port, phase 5a)
        // at the leg's end, or stopped against something: on again, away from where the chaser is now
        if (!player.hasWaypoints() && now - flight.leg >= LEG_TICKS) {
            flight.leg = now;
            if (!runLeg(player, chaser)) return cornered(player, chaser);
            flight.ran = true;
        }
        return 'flee';
    }
    const npc = findAggressorNpc(player, 8);
    if (!npc) {
        fights.delete(player);
        notices.delete(player);
        dangerCheck(player, now);
        return null;
    }
    if (ignoring(player, npc)) return null;
    // port (phase 5a): a careless bot notices its attacker a moment late (round(carelessness × 4) ticks of being hit)
    const notice = notices.get(player);
    if (!notice || notice.npc !== npc) {
        notices.set(player, { npc, at: now + Math.round(carelessnessOf(player) * 4) });
        if (onWhiteWolfMountain(player.x, player.z) && (NpcType.get(npc.type).debugname ?? '').includes('wolf')) noteEvent(player, 'wolves');
    }
    if (now < (notices.get(player)?.at ?? now)) return null;
    if (stalemate(player, npc, now)) {
        ignored.set(player, { npc, hp: player.levels[PlayerStat.HITPOINTS] });
        fights.delete(player);
        if (player.target === npc) player.clearPendingAction();
        return null;
    }
    if (getNpcCombatLevel(npc) <= player.combatLevel && !hpBelow(player, FIGHT_BACK_ABOVE)) {
        if (player.target !== npc) {
            // port (the variety work, round 1, the fixes): not one past a wall or a shut door (a barbarian woman on the
            // long hall's door tile, the bot inside: "I can't reach that!" 43 times before the stalemate's ignore): ignored
            // as a stalemate is, till it hurts the bot (with the tick's searches spent, the click as before)
            const reach = npcReach(player, npc);
            if (reach === 'no' || reach === 'gate') {
                ignored.set(player, { npc, hp: player.levels[PlayerStat.HITPOINTS] });
                fights.delete(player);
                return null;
            }
            interactNpcOp(player, npc, 2); // (Attack; the fight goes on by itself)
        }
        return 'fight';
    }
    const starts = (fleeStarts.get(player) ?? []).filter(t => now - t < FLEE_WINDOW_TICKS);
    starts.push(now);
    fleeStarts.set(player, starts);
    const run: Flight = { since: now, leg: now, ran: false };
    flights.set(player, run);
    player.clearPendingAction(); // (off the tree, the rock, the walk)
    player.run = 1; // (the walks' own run switch takes over again after: BotAction._setRun)
    if (!runLeg(player, npc)) return cornered(player, npc);
    run.ran = true;
    return starts.length >= MAX_FLEES ? 'give-up' : 'flee';
}

/** Has the fight with this foe gone FIGHT_STALL_TICKS with no blow landed either way? (it is noted as it goes) */
function stalemate(player: Player, npc: Npc, now: number): boolean {
    const hp = player.levels[PlayerStat.HITPOINTS];
    const npcHp = npc.levels[NPC_HITPOINTS];
    const fight = fights.get(player);
    if (!fight || fight.npc !== npc || fight.hp !== hp || fight.npcHp !== npcHp) {
        fights.set(player, { npc, since: now, hp, npcHp });
        return false;
    }
    return now - fight.since >= FIGHT_STALL_TICKS;
}

/**
 * port: the run, for the kinds that answer their own attackers (OWN_DEFENCE_KINDS): a fighter or archer that leaves,
 * hurt with no food (or with several at it), runs from its attackers before it walks to the bank, legs as above, on
 * for as long as one chases, at most FLEE_MAX_TICKS. Their bank walk was a plain walk with the monster hitting the
 * bot all the way (deaths to monks and men in the coverage run, to Varrock's dark wizards in an aged one). Call it
 * every tick: true while the bot runs; false when nothing chases it (any more), the run is over or it is cornered.
 */
export function runFromAttackers(player: Player): boolean {
    const now = World.currentTick;
    const chaser = findAggressorNpc(player, FLEE_TILES);
    const flight = flights.get(player);
    if (!flight) {
        if (!chaser) return false;
        flights.set(player, { since: now, leg: now, ran: true });
        player.clearPendingAction();
        player.run = 1; // (the walks' own run switch takes over again after: BotAction._setRun)
        if (runLeg(player, chaser)) return true;
        flights.delete(player);
        return false;
    }
    if (!chaser || now - flight.since >= FLEE_MAX_TICKS) {
        flights.delete(player);
        return false;
    }
    eatOnTheRun(player, now); // (port, phase 5a)
    if (!player.hasWaypoints() && now - flight.leg >= LEG_TICKS) {
        flight.leg = now;
        if (!runLeg(player, chaser)) {
            flights.delete(player);
            return false;
        }
    }
    return true;
}

/**
 * port (the realism work, phase 5a, Track F): a bite on the run, below EAT_RUNNING_BELOW of its Hitpoints with food in
 * its pack, at most every EAT_RUNNING_TICKS (274's consume script: the eat stops an attack, not the walk)
 */
function eatOnTheRun(player: Player, now: number): void {
    if (!hpBelow(player, EAT_RUNNING_BELOW) || carriedFood(player) === 0) return;
    if (now - (lastBite.get(player) ?? -Infinity) < EAT_RUNNING_TICKS) return;
    if (eatBestFood(player)) lastBite.set(player, now);
}

/** port (phase 5a): does a monster near (x, z) hunt this bot (port/BotDanger: on the overworld, by the node's monsters)? */
export function huntedAt(player: Player, x: number, z: number, level: number): boolean {
    return huntsMe(player, dangerAt(x, z, level));
}

/**
 * port (the realism work, phase 5a, Track F: the danger check), with nothing attacking the bot (a non-fighting task:
 * BotPlayer's self-defence asks): under DANGER_BELOW of its Hitpoints at its task's spot where monsters hunt it, a careful
 * levelling bot gets its Hitpoints back before it goes on: it eats, or fetches food from a bank where nothing hunts it
 * (tasks/RestTask as a sub-task); with no food anywhere its task ends and it heals doing something else (isHealing, the
 * planner's step 1e). A careless one (carelessness × 0.5, decided for DANGER_DECISION_TICKS) goes on. Every
 * DANGER_CHECK_TICKS.
 */
function dangerCheck(player: Player, now: number): void {
    if (((now + player.slot) % DANGER_CHECK_TICKS) !== 0 || !hpBelow(player, DANGER_BELOW)) return;
    if (!isLevelling(player.botPlanner as PlannerKey)) return;
    const ai = (player as unknown as { _bot?: { hasSubTask(): boolean; setSubTask(task: BotTask): void; currentTask?: BotTask | null } })._bot;
    if (!ai || ai.hasSubTask() || !ai.currentTask || ai.currentTask.name === 'Rest') return;
    // (at its task's spot: a walk through, to the spot or to a bank, goes on, its spot checked by the planner's step 1e;
    // a rest begun on White Wolf Mountain took bots to a bank over its top, into the wolves)
    let spot: [number, number, number] | null = null;
    try {
        spot = ai.currentTask.activityStep()?.location ?? null;
    } catch {
        spot = null;
    }
    if (!spot || spot[2] !== player.level || Math.max(Math.abs(spot[0] - player.x), Math.abs(spot[1] - player.z)) > DANGER_SPOT_TILES) return;
    if (!huntedAt(player, player.x, player.z, player.level)) return;
    if (now < (dangerGoOn.get(player) ?? -1)) return;
    if (!isShaken(player) && carelessRoll(player, 0.5)) {
        dangerGoOn.set(player, now + DANGER_DECISION_TICKS);
        dangerStats.goOn++;
        return;
    }
    if (carriedFood(player) + bankedFood(player) > 0) {
        if (carriedFood(player) > 0) dangerStats.eat++;
        else {
            // (a second food trip for the same kind of spot within half an hour: it leaves, and keeps off spots where
            // monsters hunt it for a while, as after a death; "not going back there")
            if (now - (lastFetch.get(player) ?? -Infinity) < REFETCH_TICKS) {
                keepOffHunted(player, REPEAT_DEATH_TICKS);
                dangerStats.leave++;
                ai.currentTask?.interrupt();
                return;
            }
            lastFetch.set(player, now);
            dangerStats.fetch++;
        }
        ai.setSubTask(new RestTask());
        return;
    }
    healing.set(player, now + REST_LIMIT_TICKS);
    dangerStats.leave++;
    ai.currentTask?.interrupt();
}

/**
 * port (phase 5a): a bot that left a hunted spot hurt with no food anywhere (the danger check) heals to REST_TO, for at
 * most REST_LIMIT_TICKS: meanwhile the planner's step 1e keeps it off spots where monsters hunt it (274 gives a Hitpoint
 * back a minute; it fishes, cooks or chops somewhere safe meanwhile, as a player did, rather than stand at a bank)
 */
export function isHealing(player: Player): boolean {
    const until = healing.get(player);
    return until !== undefined && World.currentTick < until && hpBelow(player, REST_TO);
}

/** Is the bot running from an attacker now? (for the tests) */
export function isFleeing(player: Player): boolean {
    return flights.has(player);
}

/**
 * No way off (runLeg): a weak attacker is fought, hurt or not (better than standing in its reach); from a strong one
 * the bot walks off by the game's walk, which opens a shut door on the way (a run's routes do not).
 */
function cornered(player: Player, npc: Npc): 'fight' | 'flee' {
    if (getNpcCombatLevel(npc) <= player.combatLevel) {
        flights.delete(player);
        if (player.target !== npc) interactNpcOp(player, npc, 2);
        return 'fight';
    }
    const ax = Math.sign(player.x - npc.x) || (Math.random() < 0.5 ? 1 : -1);
    const az = Math.sign(player.z - npc.z) || (Math.random() < 0.5 ? 1 : -1);
    walkTo(player, player.x + ax * FLEE_TILES, player.z + az * FLEE_TILES, player.level);
    return 'flee';
}

/**
 * A leg of the run: of the routes FLEE_TILES straight away from the chaser and a quarter turn either side (as a walk
 * click gets them: to the tile, or as near as the bot can get), the one that ends farthest from it, out of a fenced
 * field by its gate as well. False when cornered: no route gets the bot CORNERED_TILES off.
 */
function runLeg(player: Player, chaser: Npc): boolean {
    const ax = Math.sign(player.x - chaser.x) || (Math.random() < 0.5 ? 1 : -1);
    const az = Math.sign(player.z - chaser.z) || (Math.random() < 0.5 ? 1 : -1);
    let best: Uint32Array | null = null;
    let bestFar = -1;
    for (const [dx, dz] of [[ax, az], [-az, ax], [az, -ax]]) {
        const path = botWalkPath(player.level, player.x, player.z, player.x + dx * FLEE_TILES, player.z + dz * FLEE_TILES);
        if (path.length === 0) continue;
        const end = path[path.length - 1];
        const far = Math.max(Math.abs(((end >> 14) & 0x3fff) - chaser.x), Math.abs((end & 0x3fff) - chaser.z));
        if (far > bestFar) {
            best = path;
            bestFar = far;
        }
    }
    // (no route at all: the bot already stands as near as it can get, a corner too)
    if (!best) return false;
    const end = best[best.length - 1];
    if (Math.max(Math.abs(((end >> 14) & 0x3fff) - player.x), Math.abs((end & 0x3fff) - player.z)) < CORNERED_TILES) return false;
    // port: and off the attack the game's auto-retaliate gave it between two legs (a blow that lands while the bot
    // stands at a leg's end, no route and no interaction: busy2 is false then). With that attack set the engine walks
    // the bot back to its foe whatever the route says: a combat-6 fighter "running" from a monk in Edgeville's
    // monastery stood and swung until it died (the 50-bot sim at 10x, seed 1)
    if (player.target) player.clearPendingAction();
    player.clearWaypoints();
    player.queueWaypoints(best);
    return true;
}
