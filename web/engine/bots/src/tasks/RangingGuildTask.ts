// port (the variety work, round 2, Track M: members places and minigames): the
// Ranging Guild's archery competition (274's game_ranging), played as a player plays it, through the real clicks:
//   - the guild's door (274's ranging_guild_door: Ranged 40; walkTo opens it on the way in and out);
//   - the competition judge (op 1): "Sure, I'll give it a go." (200 coins: 274 gives 10 bronze arrows and starts the
//     count, %targetcount); the bronze arrows wielded (their Wield, op 2: the bot's own arrows into the pack);
//   - behind the haystacks, 5+ tiles from the targets (the script's own rule), a target clicked (274's aploc1: its roll,
//     the points, the Ranged XP, the "Hit Blue!" window, closed again) ten times, a person's moment between shots;
//   - the judge again: the tickets for the points (archery_ticket, 1 per 10 points), then another round (2-4 a visit,
//     while it has the coins), and its own arrows back on.
// It needs a bow worn (the script's inv_totalcat(worn, weapon_bow)) and the coins (taken out at a bank on the way when
// the pack is short). The tickets stay in the pack (the next bank stop banks them, as a player's).
import {
    BotTask,
    Player,
    InvType,
    walkTo,
    findNpcByName,
    findLocByName,
    interactNpcOp,
    countItem,
    Items,
    StuckDetector,
    teleportNear,
    advanceBankWalk,
    bankInvId,
    humanDelay,
    randInt,
    TargetPause
} from '#/engine/bot/tasks/BotTaskBase.js';
import World from '#/engine/World.js';
import ObjType from '#/cache/config/ObjType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import { Interaction } from '#/engine/entity/Interaction.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import { botAnswerDialogue, botScript, interactHeldOp, getBaseLevel, PlayerStat } from '#/engine/bot/BotAction.js';
import { moveItems } from '#/engine/bot/port/BotInventoryCompat.js';
import { MembersPlaces } from '#/engine/bot/BotKnowledge.js';
import { countMinigame, noteOutingEnd, noteOutingStart, sayMembers } from '#/engine/bot/port/BotOutings.js';

/** the competition's fee (274's judge) */
export const RANGING_FEE = 200;
/** rounds a visit (each RANGING_FEE) */
export const RANGING_ROUNDS: readonly [number, number] = [2, 4];
/** the Guild's door wants this Ranged */
export const RANGING_LEVEL = 40;
/** a shot at least this many ticks after the last (the script's own 2-tick hold), then a person's moment (TargetPause) */
const SHOT_LEAST = 3;
/** a visit is over after this long whatever happened (ticks) */
const VISIT_TICKS = 3000;

/** (tests, the runner) rounds played, shots, tickets, visits that ended and why */
export const rangingStats = { visits: 0, rounds: 0, shots: 0, tickets: 0, ended: {} as Record<string, number> };

let targetCountVarp: number | undefined;
function targetCount(player: Player): number {
    targetCountVarp ??= VarPlayerType.getByName('targetcount')?.id ?? -1;
    return targetCountVarp === -1 ? 0 : (player.getVar(targetCountVarp) as number);
}

let bronzeArrow = -1;
let archeryTicket = -1;
function ids(): void {
    if (bronzeArrow === -1) bronzeArrow = ObjType.getId('bronze_arrow');
    if (archeryTicket === -1) archeryTicket = ObjType.getId('archery_ticket');
}

/** a bow (short or long, any wood: 274's weapon_bow) in the bot's hands */
export function wieldsBow(player: Player): boolean {
    const id = player.getInventory(InvType.WORN)?.get(3)?.id;
    if (id === undefined) return false;
    const name = ObjType.get(id)?.debugname ?? '';
    return /(short|long)bow/.test(name) && !name.startsWith('unstrung') && !name.includes('crossbow');
}

/** coins in the pack and the bank */
function coinsAll(player: Player): number {
    const bid = bankInvId();
    const bank = bid === -1 ? null : player.getInventory(bid);
    return countItem(player, Items.COINS) + (bank?.getItemCount(Items.COINS) ?? 0);
}

/** May the bot take part now: Ranged 40, a bow in hand, the fee for two rounds, a free slot for the arrows. */
export function mayCompete(player: Player): boolean {
    const inv = player.getInventory(InvType.INV);
    return getBaseLevel(player, PlayerStat.RANGED) >= RANGING_LEVEL && wieldsBow(player) && coinsAll(player) >= RANGING_FEE * 2 + 500 && (inv?.freeSlotCount ?? 0) >= 2;
}

export class RangingGuildTask extends BotTask {
    private state: 'coins' | 'walk' | 'judge' | 'talk' | 'arrows' | 'stand' | 'shoot' | 'rewield' | 'done' = 'walk';
    private readonly rounds: number;
    private roundsDone = 0;
    private readonly stuck = new StuckDetector(40, 4, 3);
    private started = false;
    private startedAt = 0;
    private talkTicks = 0;
    private nextShot = 0;
    private shots = 0;
    private tickets0 = 0;
    /** the stand tile of its own by the haystacks (MembersPlaces.RANGING_STANDS: in sight of the targets, 5+ tiles off) */
    private stand: [number, number, number[]] = MembersPlaces.RANGING_STANDS[0];
    /** the target it aims at (MembersPlaces.RANGING_TARGETS: the first, another after a click that fired nothing) */
    private targetIndex = 0;
    /** the quiver's count when it last clicked (a click that fired nothing: another target) */
    private quiverAtClick = -1;
    private misses = 0;
    /** the judge: %targetcount when it clicked him, whether his dialogue opened, the clicks in a row */
    private countBefore = 0;
    private talked = false;
    private judgeTries = 0;
    /** its own arrows (the kind its quiver held), wielded again at the end */
    private ownArrows = -1;
    private outcome = 'done';
    /** a person's moment between shots, drawn anew each time (no shots in step: H18) */
    private readonly pause = new TargetPause('next', 1);

    constructor(rounds = randInt(RANGING_ROUNDS[0], RANGING_ROUNDS[1])) {
        super('RangingGuild');
        this.rounds = rounds;
    }

    shouldRun(player: Player): boolean {
        return this.state !== 'done' && !this.interrupted && (this.state !== 'walk' || wieldsBow(player));
    }

    isComplete(_player: Player): boolean {
        return this.state === 'done';
    }

    override interrupt(): void {
        super.interrupt();
        this._end(null, 'interrupted');
    }

    private _player: Player | null = null;

    tick(player: Player): void {
        if (this.interrupted || this.state === 'done') return;
        this._player = player;
        this.pause.observe(player);
        ids();
        const now = World.currentTick;
        if (!this.started) {
            this.started = true;
            this.startedAt = now;
            rangingStats.visits++;
            noteOutingStart(player, 'RangingGuild', 'hemenster', 'minigame');
            this.tickets0 = countItem(player, archeryTicket);
            this.ownArrows = player.getInventory(InvType.WORN)?.get(13)?.id ?? -1;
            if (this.ownArrows === bronzeArrow) this.ownArrows = -1;
            // (a tile of its own by the haystacks: the shooters stand side by side)
            this.stand = this._freeStand(player);
            if (countItem(player, Items.COINS) < RANGING_FEE * this.rounds) this.state = 'coins';
            if (Math.random() < 0.4) sayMembers(player, 'range-go');
        }
        if (now - this.startedAt > VISIT_TICKS && this.state !== 'rewield') this.state = 'rewield';
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        // (the target's window after a shot, a level-up's box: closed as a player clicks it away)
        if (this.state !== 'talk' && player.containsModalInterface()) player.closeModal();

        switch (this.state) {
            case 'coins': {
                const result = advanceBankWalk(player, this.stuck);
                if (result === 'walk') return;
                const bid = bankInvId();
                const bank = bid === -1 ? null : player.getInventory(bid);
                const inv = player.getInventory(InvType.INV);
                const short = RANGING_FEE * this.rounds + 200 - countItem(player, Items.COINS);
                if (bank && inv && short > 0) moveItems(bank, inv, Items.COINS, short);
                this.cooldown = result === 'ready' ? humanDelay(player, 'bank') : 0;
                this.stuck.reset();
                this.state = countItem(player, Items.COINS) >= RANGING_FEE ? 'walk' : 'rewield';
                if (this.state === 'rewield') this.outcome = 'coins';
                return;
            }
            case 'walk': {
                const [jx, jz] = MembersPlaces.RANGING_JUDGE;
                if (player.level === 0 && Math.max(Math.abs(player.x - jx), Math.abs(player.z - jz)) <= 3) {
                    this.state = 'judge';
                    return;
                }
                this._walk(player, jx, jz);
                return;
            }
            case 'judge': {
                // (the next round only with its fee; else its arrows back on and home)
                if (countItem(player, Items.COINS) < RANGING_FEE && targetCount(player) === 0) {
                    this.outcome = 'coins';
                    this.state = 'rewield';
                    return;
                }
                const judge = findNpcByName(player.x, player.z, player.level, 'ranging_guild_competition_judge', 12);
                if (!judge || ++this.judgeTries > 6) {
                    this.outcome = 'no-judge';
                    this.state = 'rewield';
                    return;
                }
                this.countBefore = targetCount(player);
                interactNpcOp(player, judge, 1);
                this.state = 'talk';
                this.talkTicks = 0;
                this.talked = false;
                return;
            }
            case 'talk': {
                this.talkTicks++;
                // (a choice: "Sure, I'll give it a go." for a new round; mid-round with arrows "No thanks, I've got it.")
                const count = targetCount(player);
                const option = count >= 1 && count <= 10 && this._bronze(player) + this._bronzeWorn(player) > 0 ? 2 : 1;
                if (botAnswerDialogue(player, option) !== null) {
                    this.talked = true;
                    this.cooldown = humanDelay(player, 'page');
                    return;
                }
                if ((player.delayed || botScript(player)) && this.talkTicks < 40) return;
                // (no dialogue yet: on its way to the judge; none after a while: it clicks him again)
                if (!this.talked) {
                    if (this.talkTicks >= 25) this.state = 'judge';
                    return;
                }
                this.talked = false;
                this.judgeTries = 0;
                if (this.countBefore === 11 && count === 0) {
                    // (a round claimed: its tickets; the next if it may)
                    this.roundsDone++;
                    rangingStats.rounds++;
                    countMinigame('RangingGuild', 'rounds');
                    const won = countItem(player, archeryTicket) - this.tickets0;
                    if (this.roundsDone >= this.rounds || countItem(player, Items.COINS) < RANGING_FEE) {
                        if (Math.random() < 0.5) sayMembers(player, won >= 4 * this.roundsDone ? 'range-done-good' : 'range-done');
                        this.state = 'rewield';
                        return;
                    }
                    this.state = 'judge';
                    this.cooldown = humanDelay(player, 'retarget');
                    return;
                }
                if (count === 0) {
                    // (no round: the fee refused or a choice went wrong)
                    this.outcome = 'refused';
                    this.state = 'rewield';
                    return;
                }
                if (count === 11) {
                    this.state = 'judge';
                    return;
                }
                // (a round under way: its arrows on, then the targets)
                this.state = this._bronzeWorn(player) > 0 ? 'stand' : 'arrows';
                this.talkTicks = 0;
                if (this.roundsDone === 0 && this.state === 'arrows' && Math.random() < 0.3) sayMembers(player, 'range-start');
                return;
            }
            case 'arrows': {
                const inv = player.getInventory(InvType.INV);
                const slot = inv ? this._slotOf(player, bronzeArrow) : -1;
                if (!inv || slot === -1) {
                    // (no arrows: back to the judge, who sells ten)
                    this.state = this._bronzeWorn(player) > 0 ? 'stand' : 'judge';
                    return;
                }
                interactHeldOp(player, inv, bronzeArrow, slot, 2);
                this.cooldown = humanDelay(player, 'next');
                this.state = 'stand';
                return;
            }
            case 'stand': {
                const [sx, sz] = this.stand;
                if (player.x === sx && player.z === sz) {
                    // (there: the rest of the walk's route dropped, as a player stops where it clicked)
                    player.clearWaypoints();
                    this.state = 'shoot';
                    this.nextShot = now + randInt(2, 5);
                    this.quiverAtClick = -1;
                    return;
                }
                if (!player.hasWaypoints()) walkTo(player, sx, sz, 0);
                if (++this.talkTicks > 80) {
                    // (its tile out of reach: another, after a while the visit is over)
                    this.stand = this._freeStand(player);
                    this.talkTicks = 0;
                    if (++this.misses > 3) {
                        this.outcome = 'no-stand';
                        this.state = 'rewield';
                    }
                }
                return;
            }
            case 'shoot': {
                const count = targetCount(player);
                if (count >= 11 || (this._bronzeWorn(player) === 0 && this._bronze(player) === 0)) {
                    this.state = 'judge';
                    return;
                }
                if (this._bronzeWorn(player) === 0) {
                    this.state = 'arrows';
                    return;
                }
                if (now < this.nextShot || !this.pause.ready || player.delayed || player.hasWaypoints()) return;
                // (off its tile: back to it first; never a click from where the route to a target leads, by the targets)
                if (player.x !== this.stand[0] || player.z !== this.stand[1]) {
                    player.clearPendingAction();
                    this.state = 'stand';
                    this.talkTicks = 0;
                    return;
                }
                // (the last click fired nothing: the next target)
                const quiver = this._bronzeWorn(player);
                if (this.quiverAtClick !== -1 && quiver >= this.quiverAtClick) {
                    this.targetIndex++;
                    if (++this.misses > 8) {
                        this.outcome = 'no-shot';
                        this.state = 'rewield';
                        return;
                    }
                }
                const aims = this.stand[2];
                const [tx, tz] = MembersPlaces.RANGING_TARGETS[aims[this.targetIndex % aims.length]];
                const target = findLocByName(tx, tz, 0, 'loc_2513', 0);
                if (!target) {
                    this.outcome = 'no-target';
                    this.state = 'rewield';
                    return;
                }
                const before = count;
                this.quiverAtClick = quiver;
                // (the click on the target, as the client's: 274's aploc1 runs where the bot stands, in sight and range of
                // it; no route is walked, so no click ever leads the bot round the fence to the targets' locked door)
                player.clearPendingAction();
                player.setInteraction(Interaction.ENGINE, target, ServerTriggerType.APLOC1);
                this.shots++;
                rangingStats.shots++;
                this.nextShot = now + SHOT_LEAST;
                this.pause.held();
                if (before >= 1 && before % 4 === 0 && Math.random() < 0.15) sayMembers(player, 'range-shot');
                return;
            }
            case 'rewield': {
                // (its own arrows back in the quiver, when it had some)
                const inv = player.getInventory(InvType.INV);
                if (this.ownArrows !== -1 && inv) {
                    const slot = this._slotOf(player, this.ownArrows);
                    if (slot !== -1) interactHeldOp(player, inv, this.ownArrows, slot, 2);
                    this.ownArrows = -1;
                    this.cooldown = humanDelay(player, 'next');
                    return;
                }
                const won = countItem(player, archeryTicket) - this.tickets0;
                if (won > 0) {
                    rangingStats.tickets += won;
                    countMinigame('RangingGuild', 'tickets', won);
                }
                this._end(player, this.outcome);
                return;
            }
        }
    }

    private _end(player: Player | null, outcome: string): void {
        if (this.state === 'done' && outcome !== 'interrupted') return;
        const was = this.state;
        this.state = 'done';
        if (was === 'done') return;
        rangingStats.ended[outcome] = (rangingStats.ended[outcome] ?? 0) + 1;
        const p = player ?? this._player;
        if (p && this.started) noteOutingEnd(p, outcome);
    }

    override reset(): void {
        super.reset();
        if (this.started && this.state !== 'done') this._end(null, 'reset');
    }

    /** a stand tile no other player is on (the first free of RANGING_STANDS from a die of its own), else the first */
    private _freeStand(player: Player): [number, number, number[]] {
        const stands = MembersPlaces.RANGING_STANDS;
        const start = randInt(0, stands.length - 1);
        this.targetIndex = 0;
        for (let i = 0; i < stands.length; i++) {
            const [x, z] = stands[(start + i) % stands.length];
            let taken = false;
            for (const other of World.playerLoop.all()) {
                if (other !== player && other.level === 0 && other.x === x && other.z === z) {
                    taken = true;
                    break;
                }
            }
            if (!taken) return stands[(start + i) % stands.length];
        }
        return stands[start];
    }

    private _bronze(player: Player): number {
        return countItem(player, bronzeArrow);
    }

    private _bronzeWorn(player: Player): number {
        const worn = player.getInventory(InvType.WORN)?.get(13);
        return worn && worn.id === bronzeArrow ? worn.count : 0;
    }

    private _slotOf(player: Player, id: number): number {
        const inv = player.getInventory(InvType.INV);
        if (!inv) return -1;
        for (let i = 0; i < inv.capacity; i++) if (inv.get(i)?.id === id) return i;
        return -1;
    }

    private _walk(player: Player, x: number, z: number): void {
        if (!this.stuck.check(player, x, z)) {
            walkTo(player, x, z, 0);
            return;
        }
        if (this.stuck.desperatelyStuck) {
            teleportNear(player, x, z, 0);
            this.stuck.reset();
            return;
        }
        player.clearWaypoints();
        walkTo(player, x, z, 0);
    }
}
