// port (bots ideas, round 2, theme C: lives with arcs, C4 and the mini party of C2): a 99's
// gathering, tied to the real level (99 only), never the director's; and an elated bot's own mini drop party.
//
// The 99 (a set piece of kind 'ninety_nine', started by its bot, ticked here every 5 ticks):
//   near    a levelling bot at 98 in a skill whose 99 is 10 minutes of its training away or less, as its XP in the stat
//           came the last minutes (measured: 1-6 minutes of it; just after its login, while its task trains the stat,
//           60k XP to go at 10x XP, scaled by the world's XP rate: 6k at 1x, 300k at 50x), out of the Wilderness and on no
//           trip there (the review's C-2, C-3): 'ninety-nine-near' on the bus first (theme D seeds the rumour of this 99:
//           the knowers below are its); it says "almost 99 {skill}!!" in the place of its next due line; its online clique
//           mates within 300 tiles "get the PM" (no line, no packet: a client's quiet act) and come (0.8); its acquaintances
//           of 3+ within 200 (theme D's ties: 0.5) and the bots that know of this 99 within 150 (theme D's rumour
//           'ninety_nine' of this host: 0.3 + 0.3 x sociability), free bots each (a levelling bot out of newbie time and
//           the Wilderness, unhurt, no sub-task or a hang-out, no set piece, 30+ minutes of its session left, not the
//           director's recruit of the last 2 hours), at most 12 (20 above 100 online)
//   off     the 99 not coming: its task trains another skill or is another kind than at the start, with nothing in the
//           stat for 30 s, or nothing for 6 minutes (the hold aside); the host into the Wilderness or off on a trip there;
//           30 minutes at the most: the run ends, its guests go back to their own tasks, and that name's 99 in the stat
//           has no gathering for 3 hours of play (its next logins too)
//   hold    two of its actions left (its XP a action, as gained): it stops at its tree, rock or spot (a sub-task, its task
//           waiting) until 3 guests stand within 10 tiles or 4 minutes have passed ("wait for every1", "99 in 1!!")
//   99      its task's next action: 274's level-up (the fireworks, the jingle: levelup.rs2) and the 99 line the chatter
//           always says; each guest's gz ("gz on 99!!"), a cheer, a clap or a dance from half of them; 'ninety-nine' on the
//           bus (theme D), elation (port/BotMoods)
//   party   with 20k+ coins and friendliness over 0, 0.6 of the time: "99 party at {place} 5 min!!" (a call, in its colour),
//           and a drop party at the nearest bank (port/BotParty startOwnParty: a kit of its own things worth 3-10k, 8-20
//           piles, 274's reveal; its guests asked again)
// The mini party (elation 0.8+, port/BotMoods): with 20k+ coins, friendliness over 0.2 and sociability over 0.5, 0.25 of the
// time, at most once a bot in 6 hours of play and once in the world in 20 minutes: "mini drop party!!" and a drop party of
// 4-10 piles worth 1-3k at its spot (on the ground floor, out of the Wilderness: else the nearest bank), its guests the
// bots within 15 tiles and the walk-ins. Both are 'own-party' on the bus (theme D's rumour seeds).
// Never staged around the human: a 99 is where its bot trains, a mini party where its bot is. Never in the Wilderness: a
// guest's walk ends when its host's tile is in it (as BotParty.guestFree), and the 99 party is at a bank (none is in it).
// The log (ninetyLog): the humanlike runner's AR9, the tests.
import type Player from '#/engine/entity/Player.js';
import { getExpByLevel } from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { BotTask, randInt, StuckDetector, teleportNear, walkTo } from '#/engine/bot/tasks/BotTaskBase.js';
import { arcsKnows, arcsPlay, arcsTie, emitArcs, registerArcsTick, onArcs, type ArcsVenue } from '#/engine/bot/port/BotArcsEvents.js';
import { arcLines, pickArcLine, sayArcLine } from '#/engine/bot/port/BotArcsSay.js';
import { nearestBankFor } from '#/engine/bot/port/BotAnswers.js';
import { cliqueOf } from '#/engine/bot/port/BotCliques.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { recruitedLately } from '#/engine/bot/port/BotDirector.js';
import { botEmote, type Emote } from '#/engine/bot/port/BotEmote.js';
import { LIVES_CTL, noteLivesLine } from '#/engine/bot/port/BotLives.js';
import { moodActions } from '#/engine/bot/port/BotMoods.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { coinsOwned, guestFree, startOwnParty, walkInFree, type PartyRun } from '#/engine/bot/port/BotParty.js';
import { sayPieceText } from '#/engine/bot/port/BotPieceLines.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { taskKind } from '#/engine/bot/port/BotLines.js';
import Environment from '#/util/Environment.js';
import { eventRoleOf, nextSetPieceId, runEnded, runStarted, type SetPiecePhase, type SetPieceRun, type SetPieceVenue } from '#/engine/bot/port/BotSetPieces.js';
import { placeAt } from '#/engine/bot/port/BotSlots.js';
import { claimStandTile, releaseStandTile, stepToTile } from '#/engine/bot/port/BotTiles.js';
import { botPersona } from '#/engine/bot/port/BotTiming.js';

// ── the defaults ───────────────────────────────────────────────────────────────────────────────────

export const NINETY = {
    /** near: its 99 this many ticks of its training away at its measured XP a tick (10 minutes) */
    nearTicks: 1000,
    /** its XP a tick measured over this long at the least (a minute), and the last this long at the most (6 minutes) */
    rateTicks: 100,
    rateWindow: 600,
    /** near before it is measured (just after its login, its task training the stat): XP left at 10x XP (the engine's tenths), x the world's XP rate / 10 */
    nearXp: 600_000,
    /** off: no XP in the stat this long (6 minutes), or this long when its task is another kind than at the start (30 s) */
    stallTicks: 600,
    movedTicks: 50,
    /** off: that name's 99 in the stat has no gathering again for this long (3 hours of play) */
    offGap: 18_000,
    holdActions: 2,
    holdMost: 400,
    holdGuests: 3,
    holdRange: 10,
    mates: { range: 300, chance: 0.8 },
    ties: { range: 200, chance: 0.5, strength: 3 },
    knowers: { range: 150, chance: 0.3, social: 0.3 },
    walkIns: { range: 15, chance: 0.3 },
    cap: [12, 20] as [number, number],
    sessionLeft: 3000,
    gzDelay: [2, 12] as [number, number],
    emoteShare: 0.5,
    party: { coins: 20_000, chance: 0.6, budget: [3000, 10_000] as [number, number], drops: [8, 20] as [number, number] },
    /** the gathering's end at the most (its training to the 99 is 10 minutes or less when it begins, a 4-minute hold on top) */
    runTicks: 3000
};
export const MINI = { coins: 20_000, chance: 0.25, friendliness: 0.2, sociability: 0.5, botGap: 36_000, worldGap: 2000, budget: [1000, 3000] as [number, number], drops: [4, 10] as [number, number], guestRange: 15 };
const XP_99 = getExpByLevel(99);
const SHORT: Readonly<Record<number, string>> = { 0: 'att', 1: 'def', 2: 'str', 3: 'hp', 4: 'range', 5: 'prayer', 6: 'mage', 7: 'cooking', 8: 'wc', 9: 'fletching', 10: 'fishing', 11: 'fm', 12: 'crafting', 13: 'smithing', 14: 'mining', 15: 'herb', 16: 'agility', 17: 'thieving', 20: 'rc' };
const cheb = (ax: number, az: number, bx: number, bz: number): number => Math.max(Math.abs(ax - bx), Math.abs(az - bz));

// ---- (bots ideas, round 2: C arcs; the review's C-2, C-3) what the bot trains, the Wilderness ----
/** the stat a task's kind trains, where it is one stat (a fight's is its style's: not here; its XP tells) */
const KIND_STAT: Readonly<Record<string, number>> = {
    Woodcut: PlayerStat.WOODCUTTING,
    Mine: PlayerStat.MINING,
    Essence: PlayerStat.MINING,
    Fish: PlayerStat.FISHING,
    Cook: PlayerStat.COOKING,
    Firemaking: PlayerStat.FIREMAKING,
    Fletching: PlayerStat.FLETCHING,
    BowStringing: PlayerStat.FLETCHING,
    Smith: PlayerStat.SMITHING,
    Crafting: PlayerStat.CRAFTING,
    Herblore: PlayerStat.HERBLORE,
    Agility: PlayerStat.AGILITY,
    AgilityArena: PlayerStat.AGILITY,
    Thieve: PlayerStat.THIEVING,
    Prayer: PlayerStat.PRAYER,
    Runecrafting: PlayerStat.RUNECRAFT
};
function taskKindOf(p: Player): string {
    return taskKind(BotManager.botFor(p)?.currentTask?.name);
}
/** in the Wilderness, or on a trip there (port/BotWildTrips' errands: WildTrip, WildMine), on its way in too */
function wildBound(p: Player): boolean {
    if (wildernessLevelAt(p.x, p.z) > 0) return true;
    const kind = taskKindOf(p);
    return kind === 'WildTrip' || kind === 'WildMine';
}
/** the world's XP rate (1 when unset) */
function xpRate(): number {
    const rate = Environment.node.xpRate;
    return typeof rate === 'number' && rate > 1 ? rate : 1;
}
// ---- end of C's block ----

// ── the log ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NinetyRecord {
    id: number;
    kind: 'ninety_nine' | 'mini_party';
    host: string;
    stat?: number;
    start: number;
    end: number;
    outcome: string;
    asked: number;
    came: number;
    /** the hold: from, ticks, guests within 10 tiles when it let go */
    holdAt?: number;
    held?: number;
    byAtRelease?: number;
    /** the 99: its tick, the guests within 10 tiles then, the gz said, the emotes */
    at99?: number;
    guestsAt?: number;
    gz?: number;
    emotes?: number;
    /** its drop party (a PartyRun's record id), or none */
    party?: number | null;
    x: number;
    z: number;
}
const LOG_MAX = 500;
export const ninetyLog: NinetyRecord[] = [];
function log(r: NinetyRecord): NinetyRecord {
    ninetyLog.push(r);
    if (ninetyLog.length > LOG_MAX) ninetyLog.splice(0, ninetyLog.length - LOG_MAX);
    return r;
}
export const ninetyStats = { near: 0, held: 0, ninetyNines: 0, parties: 0, mini: 0, miniRefused: 0 };

// ── a guest: to a tile near the bot, a look, the gz ──────────────────────────────────────────────────────────────

const WALK_LIMIT = 650;
export class NinetyGuestTask extends BotTask {
    stage: 'walk' | 'watch' | 'linger' | 'done' = 'walk';
    lastTick = World.currentTick;
    private tile: [number, number] | null = null;
    private walkTicks = 0;
    private readonly stuck = new StuckDetector(30, 4, 2);
    private leaveAt = -1;
    private player: Player | null = null;
    constructor(readonly run: NinetyRun) {
        super('NinetyNineGuest');
    }
    shouldRun(): boolean {
        return this.stage !== 'done';
    }
    isComplete(): boolean {
        return this.stage === 'done';
    }
    finish(): void {
        if (this.stage === 'done') return;
        this.stage = 'done';
        if (this.player) releaseStandTile(this.player);
    }
    /** the 99 is done: it stays a moment, then its own task again */
    linger(): void {
        if (this.stage === 'done') return;
        this.stage = 'linger';
        this.leaveAt = World.currentTick + randInt(20, 80);
    }
    tick(player: Player): void {
        const now = World.currentTick;
        this.player = player;
        this.lastTick = now;
        if (this.run.phase === 'done') return this.finish();
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        const host = this.run.host;
        // (bots ideas, round 2: C arcs, the review's C-2: its host's tile in the Wilderness: it goes, as BotParty.guestFree)
        if (wildernessLevelAt(host.x, host.z) > 0) return this.finish();
        if (this.stage === 'linger') {
            if (now >= this.leaveAt) this.finish();
            return;
        }
        if (host.slot === -1 || host.level !== player.level && this.stage === 'watch') return this.finish();
        if (this.stage === 'walk') {
            // (a tile of its own within 5 of the bot, claimed again when the bot moved on)
            if (!this.tile || cheb(this.tile[0], this.tile[1], host.x, host.z) > 6) {
                releaseStandTile(player);
                this.tile = claimStandTile(player, host.x, host.z, host.level, 5);
            }
            if (!this.tile) return this.finish();
            const [tx, tz] = this.tile;
            const d = player.level === host.level ? cheb(player.x, player.z, tx, tz) : 99;
            if (d === 0) {
                player.clearWaypoints();
                this.stage = 'watch';
                this.run.arrived(player);
                return;
            }
            if (++this.walkTicks > WALK_LIMIT) return this.finish();
            if (d <= 12) {
                if (!player.hasWaypoints()) stepToTile(player, tx, tz);
                return;
            }
            if (!this.stuck.check(player, tx, tz)) walkTo(player, tx, tz);
            else if (this.stuck.desperatelyStuck) {
                teleportNear(player, tx, tz);
                this.stuck.reset();
            } else walkTo(player, player.x + randInt(-6, 6), player.z + randInt(-6, 6));
            return;
        }
        // watch: the bot moved on (a fisher's spot): after it
        if (cheb(player.x, player.z, host.x, host.z) > 8) {
            this.stage = 'walk';
            this.walkTicks = 0;
        }
    }
}

/** the bot of the 99 stops at its spot (its task waits): until the run lets it go */
export class NinetyHoldTask extends BotTask {
    released = false;
    lastTick = World.currentTick;
    constructor() {
        super('NinetyNineHold');
    }
    shouldRun(): boolean {
        return !this.released;
    }
    isComplete(): boolean {
        return this.released;
    }
    tick(player: Player): void {
        this.lastTick = World.currentTick;
        if (player.hasWaypoints()) player.clearWaypoints();
    }
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────────────────────────

export class NinetyRun implements SetPieceRun {
    readonly id = nextSetPieceId();
    readonly kind = 'ninety_nine' as const;
    venue: SetPieceVenue;
    phase: SetPiecePhase = 'announce';
    readonly startedAt = World.currentTick;
    endsBy = World.currentTick + NINETY.runTicks;
    readonly roles = new Map<Player, string>();
    readonly guests = new Map<Player, NinetyGuestTask>();
    private readonly pending: { bot: Player; at: number }[] = [];
    readonly record: NinetyRecord;
    hold: NinetyHoldTask | null = null;
    private holdFrom = -1;
    private actionXp = 0;
    private lastXp: number;
    private nextWalkIn = -1;
    private finished = false;
    /** (C-3) its last XP in the stat, and its task's kind at the start */
    private lastGainAt = World.currentTick;
    private readonly startKind: string;
    lineSaid = 0;
    constructor(readonly host: Player, readonly stat: number) {
        this.startKind = taskKindOf(host);
        this.venue = { key: `ninety_nine:${host.username}`, x: host.x, z: host.z, level: host.level, say: placeAt(host.x, host.z, host.level)?.say ?? '' };
        this.roles.set(host, 'host');
        this.lastXp = host.stats[stat];
        this.record = log({ id: this.id, kind: 'ninety_nine', host: host.username, stat, start: World.currentTick, end: -1, outcome: 'running', asked: 0, came: 0, x: host.x, z: host.z });
    }
    invite(bot: Player, delay: number): void {
        if (this.roles.has(bot)) return;
        this.pending.push({ bot, at: World.currentTick + delay });
        this.roles.set(bot, 'guest');
        this.record.asked++;
    }
    private readonly came = new Set<Player>();
    /** a guest at its tile by the bot (each once: it walks again when the bot moves on to another tree or spot) */
    arrived(bot: Player): void {
        if (this.came.has(bot)) return;
        this.came.add(bot);
        this.record.came++;
    }
    rumour(): string | null {
        return null;
    }
    left(p: Player): void {
        if (p === this.host) return this.abort('host left');
        this.guests.get(p)?.finish();
        this.guests.delete(p);
        this.roles.delete(p);
    }
    abort(why: string): void {
        this.finish(why);
    }
    private within(r: number): number {
        let n = 0;
        for (const g of this.guests.keys()) if (g.slot !== -1 && g.level === this.host.level && cheb(g.x, g.z, this.host.x, this.host.z) <= r) n++;
        return n;
    }
    tick(now: number): void {
        if (this.phase === 'done') return;
        const host = this.host;
        if (now >= this.endsBy) return this.abort('timeout');
        if (host.slot === -1 || !BotManager.isActiveBot(host.username)) return this.abort('host left');
        // (the guests set off as each "reads the PM")
        for (let i = this.pending.length - 1; i >= 0; i--) {
            const g = this.pending[i];
            if (g.at > now) continue;
            this.pending.splice(i, 1);
            const ai = BotManager.botFor(g.bot);
            if (!ai || g.bot.slot === -1 || ai.hasSubTask() || !guestFree(g.bot)) {
                this.roles.delete(g.bot);
                continue;
            }
            const task = new NinetyGuestTask(this);
            ai.setSubTask(task);
            this.guests.set(g.bot, task);
        }
        for (const [g, task] of [...this.guests]) if (task.isComplete() || g.slot === -1) this.left(g);
        this.venue = { ...this.venue, x: host.x, z: host.z, level: host.level };
        // (bots ideas, round 2: C arcs, the review's C-2: the host into the Wilderness, or off on a trip there: no hold, its
        // guests go)
        if (wildBound(host)) return this.abort('wilderness');
        if (this.phase === 'peak' || this.phase === 'end') return;
        // (its XP an action, as gained)
        const xp = host.stats[this.stat];
        if (xp > this.lastXp) {
            this.actionXp = Math.max(this.actionXp, xp - this.lastXp);
            this.lastGainAt = now;
        }
        this.lastXp = xp;
        const left = XP_99 - xp;
        // (C-3: the 99 not coming: its task trains another skill or is another kind than at the start, with nothing in the
        // stat for 30 s, or nothing in it for 6 minutes: its guests go; the hold aside, its own wait)
        if (!this.hold) {
            const kind = taskKindOf(host);
            const trains = KIND_STAT[kind];
            const idle = now - this.lastGainAt;
            const moved = (trains !== undefined && trains !== this.stat) || kind !== this.startKind;
            if ((moved && idle >= NINETY.movedTicks) || idle >= NINETY.stallTicks) return this.abort('not training');
        }
        if (this.hold) {
            this.walkIns(now);
            // (let go: 3 guests within 10 tiles, or 4 minutes)
            if (this.within(NINETY.holdRange) >= NINETY.holdGuests || now - this.holdFrom >= NINETY.holdMost) {
                this.hold.released = true;
                this.record.held = now - this.holdFrom;
                this.record.byAtRelease = this.within(NINETY.holdRange);
                this.hold = null;
                this.phase = 'build';
                this.lastGainAt = now; // (C-3: its no-XP clock from the hold's end)
                if (Math.random() < 0.5) this.say('hold', true);
            }
            return;
        }
        if (this.phase === 'announce' && this.actionXp > 0 && left <= NINETY.holdActions * this.actionXp && left > 0) this.startHold(now);
    }
    private startHold(now: number): void {
        const ai = BotManager.botFor(this.host);
        if (!ai || ai.hasSubTask()) return;
        this.hold = new NinetyHoldTask();
        ai.setSubTask(this.hold);
        this.holdFrom = now;
        this.record.holdAt = now;
        this.phase = 'build';
        ninetyStats.held++;
        this.host.clearPendingAction();
        this.say('hold');
    }
    /** a line of the 99's (its kind's pool): a set piece's, counted against the speaker's next due line */
    say(kind: string, any = false): void {
        if (this.lineSaid >= 6 && !any) return;
        const said = sayArcLine(this.host, arcLines('arcs-99', kind), { skill: SHORT[this.stat] ?? 'it' }, { kind: 'setpiece', budget: 'budgeted', spoke: 'event' });
        if (said) {
            this.lineSaid++;
            noteLivesLine(this.host, 'arcs-99', kind, said);
        }
    }
    /** passers-by within 15 tiles of a held bot join now and then */
    private walkIns(now: number): void {
        if (now < this.nextWalkIn || this.guests.size >= capOf()) return;
        this.nextWalkIn = now + 25;
        for (const p of BotManager.activeBots()) {
            if (p === this.host || this.roles.has(p) || p.level !== this.host.level || cheb(p.x, p.z, this.host.x, this.host.z) > NINETY.walkIns.range) continue;
            if (!walkInFree(p) || Math.random() >= NINETY.walkIns.chance * (0.5 + botPersona(p).sociability)) continue;
            this.invite(p, randInt(1, 6));
        }
    }
    /** the 99 itself: the guests' gz and emotes, then its party or the end */
    ninetyNine(now: number): void {
        if (this.phase === 'peak' || this.phase === 'done') return;
        this.phase = 'peak';
        if (this.hold) this.hold.released = true;
        this.record.at99 = now;
        this.record.guestsAt = this.within(NINETY.holdRange + 5);
        this.record.gz = 0;
        this.record.emotes = 0;
        ninetyStats.ninetyNines++;
        let i = 0;
        for (const g of this.guests.keys()) {
            if (g.slot === -1 || cheb(g.x, g.z, this.host.x, this.host.z) > 15) continue;
            const delay = randInt(NINETY.gzDelay[0], NINETY.gzDelay[1]) + 2 * i++;
            const said = sayArcLine(g, arcLines('arcs-99', 'gz'), { skill: SHORT[this.stat] ?? 'it' }, { kind: 'setpiece', budget: 'budgeted', spoke: 'event', delay, to: this.host });
            if (said) {
                this.record.gz!++;
                noteLivesLine(g, 'arcs-99', 'gz', said);
            }
            if (Math.random() < NINETY.emoteShare) {
                const emote: Emote = (['cheer', 'clap', 'dance'] as const)[randInt(0, 2)];
                if (botEmote(g, emote)) this.record.emotes!++;
            }
        }
        emitArcs({ k: 'ninety-nine', bot: this.host, stat: this.stat, venue: { x: this.host.x, z: this.host.z, level: this.host.level, say: this.venue.say } });
        // (its drop party now and then; else the guests linger a moment and go)
        const host = this.host;
        // (C-2: never from the Wilderness; its venue is a bank, none of them in it)
        const party = wildernessLevelAt(host.x, host.z) === 0 && coinsOwned(host) >= NINETY.party.coins && botPersona(host).friendliness > 0 && Math.random() < NINETY.party.chance * partyScale;
        if (party) {
            const guests = [...this.guests.keys()].filter(g => g.slot !== -1);
            this.finish('party');
            const run = ownPartyAtBank(host, 'ninety_nine', guests, NINETY.party.budget, NINETY.party.drops, 'call');
            this.record.party = run ? run.record.id : null;
            if (run) ninetyStats.parties++;
            return;
        }
        for (const t of this.guests.values()) t.linger();
        this.phase = 'end';
        this.endsBy = Math.min(this.endsBy, now + 100);
    }
    finish(outcome: string): void {
        if (this.finished) return;
        this.finished = true;
        this.phase = 'done';
        this.record.end = World.currentTick;
        this.record.outcome = outcome;
        // (C-3: ended without its 99: that name's 99 in the stat has no gathering for offGap of play)
        if (this.record.at99 === undefined) noteOff(this.host.username, this.stat);
        if (this.hold) this.hold.released = true;
        for (const t of this.guests.values()) t.finish();
        this.roles.clear();
        runs.delete(this);
        runEnded(this);
    }
}

const runs = new Set<NinetyRun>();
const nearDone = new WeakMap<Player, Set<number>>();
// ---- (bots ideas, round 2: C arcs; the review's C-3) its XP in a stat at 98, sampled; a 99 whose gathering ended without it ----
/** the near pass's samples of a stat at 98 (each 25 ticks, the last rateWindow) */
const xpSamples = new WeakMap<Player, Map<number, { t: number; xp: number }[]>>();
/** by name (one entry a name of the name list at the most), the stat's: the play tick its gathering ended without the 99 */
const offAt = new Map<string, Map<number, number>>();
function noteOff(name: string, stat: number): void {
    let byStat = offAt.get(name);
    if (!byStat) offAt.set(name, (byStat = new Map()));
    byStat.set(stat, arcsPlay());
}
function offLately(name: string, stat: number, play: number): boolean {
    const byStat = offAt.get(name);
    const at = byStat?.get(stat);
    if (at === undefined) return false;
    if (play - at < NINETY.offGap) return true;
    byStat!.delete(stat);
    if (byStat!.size === 0) offAt.delete(name);
    return false;
}
/** its XP a tick in the stat over the samples (rateTicks of them at the least), or null: not measured yet */
function xpPerTick(p: Player, stat: number, now: number): number | null {
    let byStat = xpSamples.get(p);
    if (!byStat) xpSamples.set(p, (byStat = new Map()));
    let list = byStat.get(stat);
    if (!list) byStat.set(stat, (list = []));
    const xp = p.stats[stat];
    list.push({ t: now, xp });
    while (list.length > 1 && now - list[1].t >= NINETY.rateWindow) list.shift();
    const span = now - list[0].t;
    return span >= NINETY.rateTicks ? Math.max(0, xp - list[0].xp) / span : null;
}
/** is its 99 near: nearTicks of its training at its measured rate; not measured yet, the scaled window while its task trains the stat */
function ninetyNear(p: Player, stat: number, left: number, rate: number | null): boolean {
    if (left <= 0) return false;
    if (rate !== null) return rate > 0 && left / rate <= NINETY.nearTicks;
    return KIND_STAT[taskKindOf(p)] === stat && left <= (NINETY.nearXp * xpRate()) / 10;
}
// ---- end of C's block ----
function capOf(): number {
    let online = 0;
    for (const _ of BotManager.activeBots()) online++;
    return online > 100 ? NINETY.cap[1] : NINETY.cap[0];
}

/** a bot free to come to a 99 or a party now */
function mayCome(p: Player, host: Player): boolean {
    if (p === host || p.slot === -1 || p.is_bot !== true || !isLevelling(p.botPlanner as PlannerKey) || isNewbie(p)) return false;
    const ai = BotManager.botFor(p);
    if (!ai || ai.hasSubTask() || eventRoleOf(p) !== null) return false;
    if (!guestFree(p) || BotManager.sessionLeftOf(p.username) < NINETY.sessionLeft) return false;
    return !recruitedLately(p.username, arcsPlay());
}

/** a bot at 98 with its 99 near (ninetyNear): its 99's gathering begins (never in the Wilderness or on a trip there) */
export function startNinetyNine(host: Player, stat: number): NinetyRun | null {
    if (eventRoleOf(host) !== null || host.slot === -1 || wildBound(host)) return null;
    const run = new NinetyRun(host, stat);
    runs.add(run);
    runStarted(run);
    ninetyStats.near++;
    // (bots ideas, round 2: C arcs, the review's D-2: on the bus before the guests are asked, so theme D's rumour of this
    // 99 is seeded and its knowers can be among them)
    const venue: ArcsVenue = { x: host.x, z: host.z, level: host.level, say: run.venue.say };
    emitArcs({ k: 'ninety-nine-near', bot: host, stat, venue, detail: { skill: SHORT[stat] } });
    // "almost 99 {skill}!!": in the place of its next due line
    const said = sayArcLine(host, arcLines('arcs-99', 'near'), { skill: SHORT[stat] ?? 'it' }, { kind: 'event', budget: 'own', spoke: 'event' });
    if (said) noteLivesLine(host, 'arcs-99', 'near', said);
    // the guests: its clique mates (the "PM"), its acquaintances, those who know
    const cap = capOf();
    const mates = new Set((cliqueOf(host.username) ?? []).filter(n => n !== host.username));
    const asked: Player[] = [];
    for (const p of BotManager.activeBots()) {
        if (asked.length >= cap) break;
        if (p.level !== host.level || !mayCome(p, host)) continue;
        const d = cheb(p.x, p.z, host.x, host.z);
        let chance = 0;
        if (mates.has(p.username) && d <= NINETY.mates.range) chance = NINETY.mates.chance * mateScale;
        else if (d <= NINETY.ties.range && (arcsTie(p.username, host.username)?.acquaintance ?? 0) >= NINETY.ties.strength) chance = NINETY.ties.chance;
        else if (d <= NINETY.knowers.range && arcsKnows(p, `ninety_nine:${host.username}`)) chance = NINETY.knowers.chance + NINETY.knowers.social * botPersona(p).sociability;
        if (chance > 0 && Math.random() < chance) asked.push(p);
    }
    for (const p of asked) run.invite(p, randInt(2, 60));
    return run;
}

/** a drop party of the bot's own at the nearest bank (a 99's) or its spot (a mini party), its call in its colour */
function ownPartyAtBank(host: Player, own: 'ninety_nine' | 'mini_party', guests: readonly Player[], budget: readonly [number, number], drops: readonly [number, number], callKind: string): PartyRun | null {
    let venue: { key: string; x: number; z: number; level: number; say: string } | null = null;
    if (own === 'mini_party' && host.level === 0 && wildernessLevelAt(host.x, host.z) === 0 && host.z < 6400) venue = { key: `mini_party:${host.username}`, x: host.x, z: host.z, level: 0, say: placeAt(host.x, host.z, 0)?.say ?? 'here' };
    if (!venue) {
        const bank = nearestBankFor(host.x, host.z);
        if (!bank || bank.d > 150) return null;
        venue = { key: `${own}:${bank.say}`, x: bank.x, z: bank.z, level: 0, say: bank.say };
    }
    const run = startOwnParty(host, venue, { budget, drops, guests, own });
    if (!run) return null;
    ownParties.add(run);
    // (its call: an advert's colour, a set piece's line counted against its next due line)
    const pool = arcLines(own === 'ninety_nine' ? 'arcs-99' : 'arcs-party', callKind);
    const picked = pickArcLine(host, pool, { place: venue.say });
    if (picked) {
        const said = sayPieceText(host, picked.text, 'setpiece', { style: { colour: 1 + (Math.abs(host.username.length * 7) % 5) } });
        if (said) noteLivesLine(host, own === 'ninety_nine' ? 'arcs-99' : 'arcs-party', callKind, said);
    }
    emitArcs({ k: 'own-party', run, host, detail: { own, venue: venue.say } });
    return run;
}

// ── the mini party (elation 0.8+, port/BotMoods) ─────────────────────────────────────────────────────────────────

const lastMini = new Map<string, number>();
let lastMiniWorld = -Infinity;
export function startMiniParty(p: Player): boolean {
    const play = arcsPlay();
    const persona = botPersona(p);
    if (p.slot === -1 || !isLevelling(p.botPlanner as PlannerKey) || isNewbie(p) || eventRoleOf(p) !== null) return false;
    if (coinsOwned(p) < MINI.coins || persona.friendliness <= MINI.friendliness || persona.sociability <= MINI.sociability) return false;
    if (Math.random() >= MINI.chance * miniScale) return false;
    const last = lastMini.get(p.username);
    if ((last !== undefined && play - last < MINI.botGap) || play - lastMiniWorld < MINI.worldGap) {
        ninetyStats.miniRefused++;
        return false;
    }
    const guests: Player[] = [];
    for (const q of BotManager.activeBots()) if (q.level === p.level && cheb(q.x, q.z, p.x, p.z) <= MINI.guestRange && mayCome(q, p)) guests.push(q);
    const run = ownPartyAtBank(p, 'mini_party', guests, MINI.budget, MINI.drops, 'mini-call');
    if (!run) return false;
    lastMini.set(p.username, play);
    lastMiniWorld = play;
    ninetyStats.mini++;
    log({ id: run.id, kind: 'mini_party', host: p.username, start: World.currentTick, end: -1, outcome: 'party', asked: guests.length, came: 0, party: run.record.id, x: p.x, z: p.z });
    return true;
}
moodActions.miniParty = startMiniParty;

// ── the passes ───────────────────────────────────────────────────────────────────────────────────────────────────

const ownParties = new Set<PartyRun>();

/** every 5 ticks: the 99s' runs and the own parties go on */
registerArcsTick(now => {
    if (!LIVES_CTL.on) return;
    for (const run of [...runs]) {
        try {
            run.tick(now);
        } catch {
            run.abort('error');
        }
    }
    for (const run of [...ownParties]) {
        try {
            if (run.phase !== 'done') run.tick(now);
        } catch {
            run.abort('error');
        }
        if (run.phase === 'done') {
            ownParties.delete(run);
            runEnded(run);
            emitArcs({ k: 'set-piece', run, phase: 'done' });
        }
    }
}, 5);

/** every 25 ticks: a levelling bot at 98 whose 99 is near (ninetyNear: its XP sampled here) */
registerArcsTick(now => {
    if (!LIVES_CTL.on) return;
    const play = arcsPlay();
    for (const p of BotManager.activeBots()) {
        if (!isLevelling(p.botPlanner as PlannerKey)) continue;
        for (let stat = 0; stat < p.baseLevels.length; stat++) {
            if (p.baseLevels[stat] !== 98 || stat === PlayerStat.HITPOINTS) continue;
            const rate = xpPerTick(p, stat, now);
            if (!ninetyNear(p, stat, XP_99 - p.stats[stat], rate)) continue;
            let done = nearDone.get(p);
            if (done?.has(stat)) continue;
            // (C-3: one that ended without its 99 lately, this session or another; C-2: in the Wilderness or on a trip
            // there it waits: its guests would walk to the PKers, and the hold stand among them)
            if (offLately(p.username, stat, play) || wildBound(p)) continue;
            if (!done) nearDone.set(p, (done = new Set()));
            done.add(stat);
            if (isNewbie(p) || [...runs].some(r => r.host === p)) continue;
            startNinetyNine(p, stat);
        }
    }
}, 25);

// the 99 itself (the level-up)
onArcs('levelup', e => {
    if (!LIVES_CTL.on) return;
    if (e.level < 99) return;
    for (const run of runs) if (run.host === e.bot && run.stat === e.stat) run.ninetyNine(World.currentTick);
});
onArcs('logout', e => {
    if (!LIVES_CTL.on) return;
    if (!e.bot) return;
    for (const run of [...runs]) {
        if (run.host === e.bot) run.abort('host left');
        else if (run.roles.has(e.bot)) run.left(e.bot);
    }
});

// ── the tests ────────────────────────────────────────────────────────────────────────────────────────────────────

let mateScale = 1;
let partyScale = 1;
let miniScale = 1;
/** (tests) the mates' chance, the 99 party's and the mini party's x these (null: as the game) */
export function setNinetyRatesForTest(rates: { mates?: number | null; party?: number | null; mini?: number | null }): void {
    if (rates.mates !== undefined) mateScale = rates.mates ?? 1;
    if (rates.party !== undefined) partyScale = rates.party ?? 1;
    if (rates.mini !== undefined) miniScale = rates.mini ?? 1;
}
/** (tests) the 99s under way */
export function ninetyRuns(): readonly NinetyRun[] {
    return [...runs];
}
/** (tests) forget the near marks of a bot (as a new session: its 99s ended without the 99 are kept), the mini parties' gaps; `off`: those too, and its XP samples */
export function resetNinetyForTest(p?: Player, off = false): void {
    if (p) nearDone.delete(p);
    if (p && off) {
        offAt.delete(p.username);
        xpSamples.delete(p);
    }
    lastMini.clear();
    lastMiniWorld = -Infinity;
}
/** (tests) the play tick that name's 99 in the stat ended without it lately, or null */
export function ninetyOffAt(name: string, stat: number): number | null {
    return offAt.get(name)?.get(stat) ?? null;
}
