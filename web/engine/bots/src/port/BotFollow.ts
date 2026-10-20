// port: a short real Follow (the realism work, phase 2: "follow me" said to a sociable bot that is free, a social bot
// or one standing about, BotAnswers.willingToFollow): the bot follows the player with the game's own Follow (player
// option 3, which the engine walks) for 20-40 s, as a sub-task that pauses its own task (BotPlayer.setSubTask), then
// stops and goes back to it. Only a PKer follows a player into the Wilderness (as "come here": port/ComeHereTask); a
// fight, a trade or the player leaving ends it. Not "come here" (a private message, which is unchanged).
//
// port (the realism work, phase 3: "bot friend cliques ... travel together (real Follow)"): a clique's
// travel (port/BotCliques): friends going the same way set off together, and the ones behind follow the one ahead with
// the same Follow (CliqueFollowTask; stopped at a rock or a fence, a walk past it first: FollowDetour, which the PK
// cliques' followers use too) until it arrives at its spot, stops for a while (a fight, a bank, a break), leaves their
// sight (a boat, stairs) or goes into the Wilderness; then each walks its own last steps.
//
// port (the realism work, phase 5b, Track D: groups on the move; "clan walks in matching capes, newbie follow
// trains"): a chain (ChainFollowTask): each follows the one ahead of it in a line, not all the leader, with the same
// Follow; no "arrived": whoever runs the line (port/BotClanWalk, port/BotTrains) says when it is over (stop()), and
// the one ahead may change (setLead: one ahead of it left the line). One far behind (round a building, past a gate the
// Follow cannot see) walks there by a path, then follows again.
import { botWalkPath } from '#/engine/bot/port/BotPathing.js';
import type Player from '#/engine/entity/Player.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import World from '#/engine/World.js';
import { interactPlayerOp, walkTo } from '#/engine/bot/BotAction.js';
import { BotTask, humanDelay, randInt } from '#/engine/bot/tasks/BotTaskBase.js';
import { followsIntoWilderness, outsideWilderness } from '#/engine/bot/port/ComeHereTask.js';
import { inFight, inFightQuick } from '#/engine/bot/port/BotChat.js';

/** Farther than this (tiles), or on another floor, and the player is gone. */
const MAX_DISTANCE = 20;

export class FollowTask extends BotTask {
    private readonly target: Player;
    private readonly duration: number;
    private ticks = 0;
    private done = false;

    /** `duration`: ticks it follows (20-40 s) */
    constructor(target: Player, duration: number) {
        super('Follow');
        this.target = target;
        this.duration = duration;
    }

    /** (false: the player is gone or far, or a trade began; the follow is stopped too, as BotPlayer then drops the sub-task) */
    shouldRun(player: Player): boolean {
        const t = this.target;
        const ok = t.slot !== -1 && t.level === player.level && Math.max(Math.abs(t.x - player.x), Math.abs(t.z - player.z)) <= MAX_DISTANCE && player.botTradeTargetPid === -1;
        if (!ok && player.target === t) player.clearInteraction();
        return ok;
    }

    tick(player: Player): void {
        this.ticks++;
        const t = this.target;
        if (this.ticks >= this.duration || inFight(player) || (!followsIntoWilderness(player) && !outsideWilderness(t.x, t.z))) {
            this.stop(player);
            return;
        }
        if (!isFollowing(player, t)) interactPlayerOp(player, t.slot, 3);
    }

    isComplete(): boolean {
        return this.done;
    }

    override reset(): void {
        super.reset();
        this.ticks = 0;
        this.done = false;
    }

    /** it stops following (the engine would walk it after the player for good) */
    private stop(player: Player): void {
        this.done = true;
        if (player.target === this.target) player.clearInteraction();
        player.clearWaypoints();
    }
}

/** the bot follows `target` with the game's Follow now (player option 3, the engine walks it) */
function isFollowing(player: Player, target: Player): boolean {
    return player.target === target && (player.targetOp === ServerTriggerType.APPLAYER3 || player.targetOp === ServerTriggerType.OPPLAYER3);
}

/**
 * port (the realism work, phase 3): 274's Follow walks straight at the friend's last tile and stops at a rock, a tree or a
 * fence (it takes no path), where a person clicks the ground past it and follows again. A follower that has not moved for
 * FOLLOW_STUCK of its turns while more than FOLLOW_GAP from its friend walks by a path to where the friend is (walkTo,
 * which drops the Follow), aimed again every DETOUR_AIM ticks at a friend that moved on, until it is near the friend again
 * or DETOUR ticks pass; then the Follow again (its caller's click).
 */
const FOLLOW_STUCK = 3;
const FOLLOW_GAP = 3;
const DETOUR: [number, number] = [8, 16];
const DETOUR_AIM = 4;

export class FollowDetour {
    private still = 0;
    private lastX = -1;
    private lastZ = -1;
    private until = -1;
    private aimAt = -1;
    private aimX = -1;
    private aimZ = -1;

    /** each turn while it follows `lead` (or should): true while a detour is under way (no Follow click now) */
    check(player: Player, lead: Player, following: boolean): boolean {
        const now = World.currentTick;
        const gap = Math.max(Math.abs(lead.x - player.x), Math.abs(lead.z - player.z));
        if (now < this.until) {
            // (near the friend again: the Follow again; the friend moved on: aimed again)
            if (gap <= FOLLOW_GAP + 1) {
                this.until = -1;
                return false;
            }
            if (now - this.aimAt >= DETOUR_AIM && Math.max(Math.abs(lead.x - this.aimX), Math.abs(lead.z - this.aimZ)) > FOLLOW_GAP) this.aim(player, lead, now);
            return true;
        }
        this.still = following && gap > FOLLOW_GAP && player.x === this.lastX && player.z === this.lastZ ? this.still + 1 : 0;
        this.lastX = player.x;
        this.lastZ = player.z;
        if (this.still < FOLLOW_STUCK) return false;
        this.still = 0;
        this.aim(player, lead, now);
        this.until = now + randInt(DETOUR[0], DETOUR[1]);
        return true;
    }

    reset(): void {
        this.still = 0;
        this.lastX = -1;
        this.lastZ = -1;
        this.until = -1;
        this.aimAt = -1;
    }

    private aim(player: Player, lead: Player, now: number): void {
        player.clearWaypoints();
        // (searched at once, as a click is: the level of detail (port/BotPathing) kept a follower far from every human
        // waiting for its turn while its friend walked on: within 8 tiles half the way, against 70 %+ before)
        const path = botWalkPath(player.level, player.x, player.z, lead.x, lead.z);
        if (path.length > 0) player.queueWaypoints(path);
        else walkTo(player, lead.x, lead.z, lead.level);
        this.aimAt = now;
        this.aimX = lead.x;
        this.aimZ = lead.z;
    }
}

/** a friend this far ahead (tiles), or on another floor, is out of sight: each goes its own way */
const CLIQUE_MAX_DISTANCE = 25;
/** the leader within this of its destination has arrived; or within ARRIVED_NEAR and at work there (at a tree, a rock, a
 * monster) or standing (ARRIVED_STILL ticks: its spot is a little off the step's point) */
const ARRIVED = 8;
const ARRIVED_NEAR = 20;
const ARRIVED_STILL = 5;
/** the leader standing this long (ticks) has stopped (a bank, a fight, a break): no point following */
const LEADER_STILL = 60;
/** a follower farther behind than this runs to catch up */
const CATCH_UP = 4;

/**
 * port (the realism work, phase 3): a friend of the bot's clique leads, the bot follows it with the game's Follow until
 * the leader is within ARRIVED of `dest` (their spot), stands for LEADER_STILL ticks, is out of sight or in the
 * Wilderness, or `most` ticks pass; a fight or a trade ends it too. `onEnd` is told when it ends, however it ends.
 */
export class CliqueFollowTask extends BotTask {
    private readonly leader: Player;
    private readonly dest: readonly [number, number, number];
    private readonly most: number;
    private readonly onEnd: (() => void) | undefined;
    private ticks = 0;
    private done = false;
    private ended = false;
    private stillSince = 0;
    private lastX = -1;
    private lastZ = -1;
    /** the world tick it last ran (a follow BotPlayer no longer runs, replaced by another sub-task, is over) */
    lastTickAt = -1;
    /** why it ended (tests): the leader arrived, the time was up, the leader stood, a fight, the Wilderness, the leader gone */
    endReason: 'arrived' | 'time' | 'still' | 'fight' | 'wilderness' | 'gone' | null = null;
    /** it ended, and holds the bot a person's moment more (its own task's next click is not in the tick the follow ended) */
    private holdUntil = -1;
    /** the world tick it clicks Follow again after the engine dropped it (-1: not due) */
    private followDue = -1;
    /** stuck behind a rock with its Follow: a walk past it (FollowDetour) */
    private readonly detour = new FollowDetour();

    constructor(leader: Player, dest: readonly [number, number, number], most: number, onEnd?: () => void) {
        super('CliqueFollow');
        this.leader = leader;
        this.dest = dest;
        this.most = most;
        this.onEnd = onEnd;
    }

    /** (false: the leader is gone, far or on another floor, or a trade began: the follow stops) */
    shouldRun(player: Player): boolean {
        if (this.done) return true; // (ended: it holds a person's moment, isComplete)
        const l = this.leader;
        const ok = !this.ended && l.slot !== -1 && l.level === player.level && Math.max(Math.abs(l.x - player.x), Math.abs(l.z - player.z)) <= CLIQUE_MAX_DISTANCE && player.botTradeTargetPid === -1;
        if (!ok) this.stop(player, 'gone');
        return ok;
    }

    /** the friend it follows */
    get leaderPlayer(): Player {
        return this.leader;
    }

    tick(player: Player): void {
        if (this.done) return; // (a person's moment after it ended: isComplete)
        this.ticks++;
        this.lastTickAt = World.currentTick;
        const l = this.leader;
        if (l.x !== this.lastX || l.z !== this.lastZ) {
            this.lastX = l.x;
            this.lastZ = l.z;
            this.stillSince = this.ticks;
        }
        const d = l.level === this.dest[2] ? Math.max(Math.abs(l.x - this.dest[0]), Math.abs(l.z - this.dest[1])) : Infinity;
        // (at work there: a tree, a rock, a fishing spot, a monster of its spot, a little off the step's point)
        const atWork = l.target !== null && (l.target as { username?: string }).username === undefined;
        const still = this.ticks - this.stillSince;
        const end = d <= ARRIVED || (d <= ARRIVED_NEAR && (atWork || still >= ARRIVED_STILL)) ? 'arrived' : this.ticks >= this.most ? 'time' : still >= LEADER_STILL ? 'still' : inFightQuick(player) ? 'fight' : !followsIntoWilderness(player) && !outsideWilderness(l.x, l.z) ? 'wilderness' : null;
        if (end) {
            this.stop(player, end);
            return;
        }
        // (behind by more than a few tiles: it runs to catch up, while it has the energy; beside it, it walks as the leader)
        const gap = Math.max(Math.abs(l.x - player.x), Math.abs(l.z - player.z));
        if (gap > CATCH_UP && player.runenergy >= 1000) player.run = 1;
        else if (gap <= 2 && player.run !== l.run) player.run = l.run;
        // (stuck behind a rock or a fence: a walk past it, then the Follow again)
        if (this.detour.check(player, l, isFollowing(player, l))) return;
        // (the first click at once; a follow the engine dropped, a person's moment later: BotTiming 'retarget')
        if (isFollowing(player, l)) this.followDue = -1;
        else if (this.ticks === 1 || (this.followDue >= 0 && World.currentTick >= this.followDue)) {
            this.followDue = -1;
            interactPlayerOp(player, l.slot, 3);
        } else if (this.followDue < 0) this.followDue = World.currentTick + 1 + humanDelay(player, 'retarget');
    }

    isComplete(): boolean {
        return this.done && World.currentTick >= this.holdUntil;
    }

    override reset(): void {
        super.reset();
        this.ticks = 0;
        this.done = false;
        this.holdUntil = -1;
        this.followDue = -1;
        this.stillSince = 0;
        this.lastX = -1;
        this.lastZ = -1;
        this.detour.reset();
        // (a reset by a logout's wind-down ends it for good: BotPlayer drops it)
        if (this.ended) this.done = true;
    }

    /** it stops following (the engine would walk it after the leader for good), once */
    private stop(player: Player, why: NonNullable<CliqueFollowTask['endReason']>): void {
        if (!this.done && why !== 'gone') this.holdUntil = World.currentTick + 1 + humanDelay(player, 'retarget');
        this.done = true;
        this.endReason ??= why;
        if (player.target === this.leader) player.clearInteraction();
        player.clearWaypoints();
        if (!this.ended) {
            this.ended = true;
            this.onEnd?.();
        }
    }
}

// ── a chain (the realism work, phase 5b, Track D) ────────────────────────────────────────────────────────────────

/** a chain follower this far (tiles) behind the one ahead walks there by a path (the Follow lost it), then follows again */
const CHAIN_PATH_GAP = 25;
/** the path walk is over this near the one ahead (the Follow again) */
const CHAIN_REJOIN = 6;
/** the walk is aimed again at one ahead that moved this far since (tiles), at most every CHAIN_AIM ticks */
const CHAIN_AIM = 8;
/** farther than this, on another floor, or out of the world: the one ahead is lost and the follow is over */
const CHAIN_LOST = 60;

/** why a chain follow ended: stopped by its line, out of time, the one ahead lost, a trade */
export type ChainEnd = 'stopped' | 'time' | 'gone' | 'trade';

/**
 * port (the realism work, phase 5b): the bot follows the one ahead of it in a line (a clan walk, a newbie follow
 * train) with the game's Follow (player option 3): a person's moment before it clicks Follow again once the engine
 * dropped it, a walk past a rock or a fence (FollowDetour), a run to catch up when it fell more than CATCH_UP behind
 * (while it has the energy), the one ahead's own pace when beside it, and a walk by a path when it fell CHAIN_PATH_GAP
 * behind. It waits out a fight (BotPlayer's self-defence holds it meanwhile). It ends when its line says (stop), after
 * `most` ticks, when the one ahead is lost (out of the world, another floor, CHAIN_LOST tiles) or a trade begins.
 * `onEnd` is told once, however it ends (not at a logout: whoever runs the line sees the bot gone). A bot followed by
 * one in its chain is "leading a friend" (port/BotTeleport.leadsAFriend: leaderPlayer): it casts no spell and takes no
 * wrong turn that would lose the line.
 */
export class ChainFollowTask extends BotTask {
    private lead: Player;
    private readonly most: number;
    private readonly onEnd: ((why: ChainEnd) => void) | undefined;
    private ticks = 0;
    private done = false;
    private ended = false;
    private holdUntil = -1;
    private followDue = -1;
    /** a walk by a path to the one ahead under way, and where it was aimed */
    private pathing = false;
    private aimAt = -1;
    private aimX = -1;
    private aimZ = -1;
    private readonly detour = new FollowDetour();
    /** the world tick it last ran (one BotPlayer no longer runs, another sub-task in its place, is over) */
    lastTickAt = -1;
    endReason: ChainEnd | null = null;

    constructor(lead: Player, most: number, onEnd?: (why: ChainEnd) => void) {
        super('ChainFollow');
        this.lead = lead;
        this.most = most;
        this.onEnd = onEnd;
    }

    /** the one it follows (port/BotTeleport.leadsAFriend reads it) */
    get leaderPlayer(): Player {
        return this.lead;
    }

    /** It follows another now (the one ahead of it left the line): the Follow on the new one, a moment later. */
    setLead(player: Player, lead: Player): void {
        if (lead === this.lead) return;
        if (player.target === this.lead) player.clearInteraction();
        this.lead = lead;
        this.followDue = -1;
        this.pathing = false;
        this.detour.reset();
    }

    /** Its line is over (or the bot leaves it): it stops following, a person's moment before its own task goes on. */
    finish(player: Player): void {
        this.stop(player, 'stopped');
    }

    /** it ended and holds the bot a moment, or it runs */
    get over(): boolean {
        return this.done;
    }

    shouldRun(player: Player): boolean {
        if (this.done) return true; // (ended: it holds a person's moment, isComplete)
        const l = this.lead;
        if (player.botTradeTargetPid !== -1) {
            this.stop(player, 'trade');
            return true;
        }
        const ok = !this.ended && l.slot !== -1 && l.level === player.level && Math.max(Math.abs(l.x - player.x), Math.abs(l.z - player.z)) <= CHAIN_LOST;
        if (!ok) this.stop(player, 'gone');
        return true;
    }

    tick(player: Player): void {
        if (this.done) return;
        this.ticks++;
        const now = World.currentTick;
        this.lastTickAt = now;
        if (this.ticks >= this.most) {
            this.stop(player, 'time');
            return;
        }
        // (a monster on it: BotPlayer's self-defence answers it and the follow waits)
        if (inFightQuick(player)) return;
        const l = this.lead;
        const gap = Math.max(Math.abs(l.x - player.x), Math.abs(l.z - player.z));
        // (far behind, the Follow's straight line lost it: a walk by a path, aimed again at one that moved on)
        if (gap > CHAIN_PATH_GAP || (this.pathing && gap > CHAIN_REJOIN)) {
            if (!this.pathing || (now - this.aimAt >= CHAIN_AIM && Math.max(Math.abs(l.x - this.aimX), Math.abs(l.z - this.aimZ)) > 3) || !player.hasWaypoints()) {
                if (player.target === l) player.clearInteraction();
                walkTo(player, l.x, l.z, l.level);
                this.aimAt = now;
                this.aimX = l.x;
                this.aimZ = l.z;
            }
            this.pathing = true;
            if (player.runenergy >= 1000) player.run = 1;
            return;
        }
        if (this.pathing) {
            this.pathing = false;
            player.clearWaypoints();
            this.followDue = now;
        }
        // (behind by more than a few tiles: it runs to catch up, while it has the energy; beside it, it keeps its pace)
        if (gap > CATCH_UP && player.runenergy >= 1000) player.run = 1;
        else if (gap <= 2 && player.run !== l.run) player.run = l.run;
        // (stuck behind a rock or a fence: a walk past it, then the Follow again)
        if (this.detour.check(player, l, isFollowing(player, l))) return;
        if (isFollowing(player, l)) this.followDue = -1;
        else if (this.ticks === 1 || (this.followDue >= 0 && now >= this.followDue)) {
            this.followDue = -1;
            interactPlayerOp(player, l.slot, 3);
        } else if (this.followDue < 0) this.followDue = now + 1 + humanDelay(player, 'retarget');
    }

    isComplete(): boolean {
        return this.done && World.currentTick >= this.holdUntil;
    }

    override reset(): void {
        super.reset();
        this.ticks = 0;
        this.done = false;
        this.holdUntil = -1;
        this.followDue = -1;
        this.pathing = false;
        this.aimAt = -1;
        this.detour.reset();
        // (a reset by a logout's wind-down ends it for good: BotPlayer drops it)
        if (this.ended) this.done = true;
    }

    /** it stops following (the engine would walk it after the one ahead for good), once */
    private stop(player: Player, why: ChainEnd): void {
        if (!this.done && why !== 'gone') this.holdUntil = World.currentTick + 1 + humanDelay(player, 'retarget');
        this.done = true;
        this.endReason ??= why;
        if (player.target === this.lead) player.clearInteraction();
        player.clearWaypoints();
        if (!this.ended) {
            this.ended = true;
            this.onEnd?.(why);
        }
    }
}
