/**
 * DuelArenaTask.ts (port; the realism work, phase 5b, Track A: the Duel Arena; the arena's
 * life is port/BotArena's)
 *
 * A bot's visit to the Duel Arena (members), 20-45 minutes, as a 2004 player made one:
 *   travel     the walk there (walkTo, or a teleport spell where port/BotTeleport allows): from west of Al Kharid's fence
 *              by the toll gate's east side, then the walkway in from the west, then Fadli's bank (straight to the bank,
 *              walkTo wandered along the River Lum and the complex's walls, and the stuck check jumped the bot)
 *   bank       a staker at Fadli's bank (else a chest's): the pack down to its food (3-6) and the coins it stakes with
 *              (a third of its coins at most); its weapon stays worn. A watcher only takes a few coins for tomatoes
 *   heal       a nurse's Heal, a click a moment, to full Hitpoints (274 starts a duel at the Hitpoints you have)
 *   tomatoes   3 watchers in 10, once a visit: 5-15 rotten tomatoes from the crate's Shop of Distaste
 *   stand      a staker on a tile of its own in the challenge area: a call every 4-9 minutes ("fight 5k no rules": its offer),
 *              a partner from the stakers near (25 tiles, 15 combat levels) every 10-30 s, an answer to a challenge (a
 *              bot's agreed one at once; a human's if it is fair, the purse allows and they never beat it, else a word),
 *              and the human now and then (port/BotArena's rules: where they stand, 5 minutes apart, never again after
 *              a no, a silence or a loss to them)
 *   duel       the duel itself (port/BotDuel's DuelSession: the screens, the fight, the result), then a line or an
 *              emote, its weapon back on after a box duel, its Hitpoints back, its tile again
 *   watch      a watcher (or a big stake's crowd) at any duel under way in the complex, leaning on a wall whose tile has
 *              the fight in sight within 10 tiles (Lean against, oploc5; 274's approach for an item used on a player is
 *              its line of sight), a cheer or a shout now and then, its tomatoes at the duellists (10+ ticks apart)
 *   leave      after its time, a losing streak ("brb more cash") or its coins: its plan goes on (the next visit is due
 *              1-2 hours of play on: port/BotArena)
 * The director's big stake (port/BotArena's duel_stake) gives its two duellists a 'bigstake' sub-task (travel, bank,
 * heal, meet, the agreed duel) and its crowd a 'crowd' one (watch that duel), which end with the run.
 *
 * A duellist has a set-piece role (port/BotSetPieces.setRole) from its challenge to a moment after the duel: BotManager
 * holds its logout, its habits take no break. It never walks while a duel screen is open.
 */
import {
    BotTask, Player, Loc, InvType, StuckDetector, walkTo, teleportNear, randInt, bankInvId,
    carriedFood, edibleFoodIds, interactNpcOp, interactLocOp, findLocByName, openShopStock, buyFromOpenShop, humanDelay
} from '#/engine/bot/tasks/BotTaskBase.js';
import ObjType from '#/cache/config/ObjType.js';
import Component from '#/cache/config/Component.js';
import NpcType from '#/cache/config/NpcType.js';
import LocType from '#/cache/config/LocType.js';
import World from '#/engine/World.js';
import { isApproached } from '#/engine/GameMap.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import { Items } from '#/engine/bot/BotKnowledge.js';
import { botContinuePage, findLocByPrefixWhere, findNpcFiltered, interactHeldOp } from '#/engine/bot/BotAction.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { coinsOwned } from '#/engine/bot/BotNeeds.js';
import { bankedId, moveItems } from '#/engine/bot/port/BotInventoryCompat.js';
import { claimStandTile, releaseStandTile, stepToTile } from '#/engine/bot/port/BotTiles.js';
import { botEmote, type Emote } from '#/engine/bot/port/BotEmote.js';
import { clearRole, setRole } from '#/engine/bot/port/BotSetPieces.js';
// (the variety work, round 2, the fixes: B7, a rich bot's status pieces on at Fadli's bank)
import { dressForArena, hasStatusToWear } from '#/engine/bot/port/BotGear.js';
import { useItemOnPlayer } from '#/engine/bot/port/BotScreens.js';
import { scheduleInTicks } from '#/engine/bot/port/BotSchedule.js';
import { DuelSession, DuelStatus, duelPartnerVar, duelScreen, duelStatus, hasChallenged, inChallengeArea, inDuelArena, inFightZone, type DuelDeal, type DuelOutcome } from '#/engine/bot/port/BotDuel.js';
import {
    ARENA, arenaLines, arenaVisitors, callOffer, callTakenUp, challengeAnswered, challengeHumanNow, drawRules, drawStake, duelVoice, fullHp, humanCap,
    joinArena, leaveArena, liveDuelOf, liveDuels, noteDuelEnd, noteDuelStart, noteHumanChallenge, noteHumanDuel, pickStakeSpot, rand, refuseHuman, rulesOf,
    sampleSpectators, sayArena, sayArenaText, stakeRoom, testDeal, visitEnded, type BigStakeRun, type DuelRecord
} from '#/engine/bot/port/BotArena.js';

export type ArenaRole = 'staker' | 'watcher' | 'bigstake' | 'crowd';

export interface ArenaOptions {
    /** the director's big stake this bot is part of */
    run?: BigStakeRun;
    /** a big stake's duellist: its opponent, the deal, which of the two challenges */
    partner?: Player;
    deal?: DuelDeal;
    challenger?: boolean;
    /** a crowd member sets off this many ticks after it hears of it */
    delay?: number;
    /** the visit's length (ticks) when it arrives: 20-45 minutes unless given (the tests' longer stays) */
    stay?: number;
}

type State = 'wait' | 'travel' | 'bank' | 'heal' | 'tomatoes' | 'stand' | 'meet' | 'duel' | 'watch' | 'done';

/** the walk ends this near Fadli's chests */
const ARRIVE_TILES = 6;
/** the walk there is given up after this long (25 minutes: from Falador or Draynor it takes 5-10) */
const TRAVEL_LIMIT = 2500;
/** a nurse's Heal is clicked at most this many times a stop */
const HEAL_TRIES = 16;
const NURSES: ReadonlySet<string> = new Set(['duel_nurse1', 'duel_nurse2', 'duel_nurse3', 'duel_jaraah']);
/** a bot's challenge to another bot: the other answers within this long, or it is off */
const OFFER_TICKS = 50;
/** a challenge to the human: the call, then the click 3-8 s later */
const HUMAN_CALL_DELAY: [number, number] = [5, 13];
/** a duellist keeps its role this long after the duel (274's reset first; port/BotChatter's close call is the duel's own) */
const ROLE_AFTER_TICKS = 16;
/** a big stake's duellists try the challenge this many times */
const BIG_TRIES = 3;
const WIN_EMOTES: readonly Emote[] = ['cheer', 'dance', 'bow'];
const LOSE_EMOTES: readonly Emote[] = ['cry', 'angry'];
const WATCH_EMOTES: readonly Emote[] = ['cheer', 'clap', 'laugh', 'cheer', 'angry'];

let tomatoId = -1;
function tomato(): number {
    if (tomatoId === -1) tomatoId = ObjType.getId('rotten_tomato');
    return tomatoId;
}

function carried(bot: Player, id: number): number {
    const inv = bot.getInventory(InvType.INV);
    if (!inv) return 0;
    let n = 0;
    for (let slot = 0; slot < inv.capacity; slot++) {
        const item = inv.get(slot);
        if (item?.id === id) n += item.count;
    }
    return n;
}

function cheb(a: { x: number; z: number }, b: { x: number; z: number }): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

/** within a tomato's reach (10 tiles) and in sight (274's approach check for an item used on a player: line of sight) */
function inSight(from: { x: number; z: number }, to: Player): boolean {
    return cheb(from, to) <= ARENA.watch.reach && isApproached(to.level, from.x, from.z, to.x, to.z, 1, 1, 1, 1);
}

export class DuelArenaTask extends BotTask {
    readonly role: ArenaRole;
    readonly options: ArenaOptions;
    state: State = 'travel';
    private began = false;
    private ended = false;
    private lastPlayer: Player | null = null;
    private readonly stuck = new StuckDetector(30, 4, 2);
    private travelTicks = 0;
    /** on its way in: past Al Kharid's fence (east of it, or through the toll gate), then the walkway in from the west */
    private pastFence = false;
    private approached = false;
    private waitUntil = -1;
    /** the tick the visit ends (set when it arrives) */
    private visitEnds = -1;
    // the bank
    private bankWait = 0;
    private bankTries = 0;
    /** the coins it carries to stake (its pack's, after the bank) */
    carry = 0;
    // healing
    private healAt = 0;
    private heals = 0;
    // tomatoes
    private wantsTomatoes = false;
    private tomatoesDone = false;
    private shopWait = 0;
    private buyTries = 0;
    private tomatoWant = 0;
    // standing
    private tile: [number, number] | null = null;
    private walkTicks = 0;
    private callAt = 0;
    private searchAt = 0;
    private fidgetAt = 0;
    /** the offer of its last call ("10k melee only"), for the next partner's deal */
    private called: { stake?: number; rules?: string; at: number } | null = null;
    /** its challenge to a bot: the other reads this to answer it (until the duel is over) */
    offer: { to: Player; deal: DuelDeal; at: number } | null = null;
    /** another bot that picked it (its challenge is on the way) */
    reservedBy: Player | null = null;
    private reservedAt = -1;
    /** its answer to a bot's challenge (after a moment), or to the human's */
    private answer: { to: Player; deal: DuelDeal; at: number; human: boolean } | null = null;
    /** challengers it has turned down or taken up: uid -> tick (274's challenge stays set a while) */
    private handled = new Map<number, number>();
    /** a challenge to the human: its call, then its click */
    private toHuman: { human: Player; cap: number; at: number; opAt: number } | null = null;
    // the duel
    readonly session = new DuelSession();
    private duelPartner: Player | null = null;
    private duelHuman = false;
    private duelRecord: DuelRecord | null = null;
    private weapon = -1;
    private losses = 0;
    private maxLosses = 3;
    private duels = 0;
    private bigTries = 0;
    private roleGen = 0;
    // watching
    private watching: { record: DuelRecord; a: Player; b: Player } | null = null;
    /** the wall tile it leans on (another watcher picks another) */
    wall: [number, number] | null = null;
    private leanTries = 0;
    private releans = 0;
    /** its Lean against's click, and the walls it could not reach this duel */
    private leanAt = -1;
    private badWalls: string[] = [];
    private throwsLeft = 0;
    private nextThrowAt = 0;
    private tomatoesHeld = 0;
    private shouted = false;
    private emotes = 0;
    private watchedEnd = -1;
    private nextWatchAt = 0;

    constructor(role: ArenaRole, options: ArenaOptions = {}) {
        super('DuelArena');
        this.role = role;
        this.options = options;
    }

    /** in a duel now (from its challenge or answer to the result) */
    inDuel(): boolean {
        return this.session.active;
    }

    /** a free staker another may challenge: standing, no duel, no offer or answer, not picked already */
    freeForDuel(): boolean {
        const reserved = this.reservedBy !== null && World.currentTick - this.reservedAt <= OFFER_TICKS;
        return this.role === 'staker' && this.state === 'stand' && !this.session.active && this.offer === null && this.answer === null && this.toHuman === null && !reserved;
    }

    shouldRun(player: Player): boolean {
        return this.state !== 'done' && player.levels[PlayerStat.HITPOINTS] > 0;
    }

    isComplete(_player: Player): boolean {
        return this.state === 'done';
    }

    tick(player: Player): void {
        this.lastPlayer = player;
        if (this.interrupted || this.state === 'done') return;
        const now = World.currentTick;
        // (every tick: back from a big stake's part, a sub-task whose own entry in the registry went with it, a visitor is
        // found by the others again)
        joinArena(player, this);
        if (!this.began) {
            this.began = true;
            if (this.options.delay) {
                this.state = 'wait';
                this.waitUntil = now + this.options.delay;
            }
            this.maxLosses = rand(ARENA.staker.losses[0], ARENA.staker.losses[1]);
            this.wantsTomatoes = this.role === 'crowd' ? Math.random() < 0.5 : this.role === 'watcher' && Math.random() < ARENA.watch.tomatoShare;
            this.tomatoWant = rand(ARENA.watch.buy[0], ARENA.watch.buy[1]);
        }
        // a big stake's part ends with its run
        const run = this.options.run;
        if (run && run.over && !this.session.active) return this._finish(player);
        // (274's win screen is never left open: its close pays the stake out)
        if (!this.session.active && duelScreen(player) === 'win') player.closeModal();
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        switch (this.state) {
            case 'wait':
                if (now >= this.waitUntil) this.state = 'travel';
                return;
            case 'travel':
                return this._travel(player);
            case 'bank':
                return this._bank(player);
            case 'heal':
                return this._heal(player, now);
            case 'tomatoes':
                return this._buyTomatoes(player);
            case 'stand':
                return this._stand(player, now);
            case 'meet':
                return this._meet(player, now);
            case 'duel':
                return this._duel(player);
            case 'watch':
                return this._watch(player, now);
        }
    }

    // ── travel, bank, heal, tomatoes ─────────────────────────────────────────────────────────────────────────────────

    private _travel(player: Player): void {
        const [bx, bz] = ARENA.places.bank;
        if (player.level === 0 && cheb(player, { x: bx, z: bz }) <= ARRIVE_TILES) {
            player.clearWaypoints();
            this.stuck.reset();
            this.state = this._needsBank(player) ? 'bank' : this._afterBank(player);
            return;
        }
        // (from outside the complex by the walkway in from the west first, and from west of Al Kharid's fence by the toll
        // gate's east side before it: walkTo straight there wandered along the complex's walls, or along the River Lum)
        const [ax, az] = ARENA.places.approach;
        const [gx, gz] = ARENA.places.tollGate;
        if (!this.approached && (inDuelArena(player.x, player.z, player.level) || (player.level === 0 && cheb(player, { x: ax, z: az }) <= 3))) this.approached = true;
        if (!this.pastFence && (this.approached || player.x >= ARENA.places.fenceX || (player.level === 0 && cheb(player, { x: gx, z: gz }) <= 3))) this.pastFence = true;
        const [tx, tz] = this.approached ? [bx, bz] : this.pastFence ? [ax, az] : [gx, gz];
        if (++this.travelTicks > TRAVEL_LIMIT) return this._finish(player);
        if (!this.stuck.check(player, tx, tz)) walkTo(player, tx, tz);
        else if (this.stuck.desperatelyStuck) {
            teleportNear(player, tx, tz);
            this.stuck.reset();
        } else walkTo(player, player.x + randInt(-6, 6), player.z + randInt(-6, 6));
    }

    /**
     * a staker banks (its pack down to food and stake coins); a watcher only when it wants tomatoes and has no coins, or
     * (the variety work, round 2, the fixes: B7) is rich with a status piece in its bank to put on (port/BotGear)
     */
    private _needsBank(player: Player): boolean {
        if (this.role === 'staker' || this.role === 'bigstake') return true;
        return (this.wantsTomatoes && carried(player, Items.COINS) < 20 && coinsOwned(player) >= 20) || hasStatusToWear(player);
    }

    /** the arena's bank: Fadli's Bank (twice), else a chest's (Open, then Bank) */
    private _bank(player: Player): void {
        const bankMain = Component.getId('bank_main');
        if (bankMain !== -1 && player.modalMain === bankMain) {
            // (the fixes, B7: a rich bot's best on first, its trims or god armour: the arena was where 2004's rich showed them)
            dressForArena(player);
            this._stock(player);
            player.closeModal();
            this.cooldown = humanDelay(player, 'bank');
            this.state = this._afterBank(player);
            return;
        }
        if (this.bankWait > 0) {
            this.bankWait--;
            return;
        }
        if (this.bankTries >= 4) {
            // (no bank came up: the visit goes on with what it carries)
            this.carry = carried(player, Items.COINS);
            this.state = this._afterBank(player);
            return;
        }
        this.bankTries++;
        this.bankWait = 15;
        if (this.bankTries <= 2) {
            const fadli = findNpcFiltered(player.x, player.z, 0, npc => NpcType.get(npc.type).debugname === 'duel_fadli', 12);
            if (fadli) {
                interactNpcOp(player, fadli, 3);
                return;
            }
        }
        const open = findLocByName(player.x, player.z, 0, 'duel_chestopen', 8);
        if (open) {
            interactLocOp(player, open, 2);
            return;
        }
        const shut = findLocByName(player.x, player.z, 0, 'loc_3193', 8);
        if (shut) interactLocOp(player, shut, 1);
    }

    /**
     * What it carries for the visit (the bank is open): a staker its food (3-6) and its stake coins (a third of its coins,
     * 5k at the least; a big stake's exactly its stake), everything else banked (274 needs room in the pack for what a
     * duel's rules take off); a watcher a few coins for tomatoes, nothing banked
     */
    private _stock(player: Player): void {
        const inv = player.getInventory(InvType.INV);
        const bid = bankInvId();
        const bank = bid === -1 ? null : player.getInventory(bid);
        if (!inv || !bank) return;
        const owned = coinsOwned(player);
        if (this.role === 'staker' || this.role === 'bigstake') {
            const foodWant = rand(ARENA.visit.food[0], ARENA.visit.food[1]);
            const food = new Set(edibleFoodIds());
            let foodKept = 0;
            for (let slot = 0; slot < inv.capacity; slot++) {
                const item = inv.get(slot);
                if (!item || item.id === Items.COINS) continue;
                if (food.has(item.id) && foodKept < foodWant) {
                    foodKept += item.count;
                    continue;
                }
                const moved = inv.remove(item.id, item.count);
                // (a full bank keeps what it cannot take in the pack: nothing is lost)
                if (moved > 0) {
                    const added = bank.add(bankedId(item.id), moved);
                    if (added < moved) inv.add(item.id, moved - added);
                }
            }
            let need = foodWant - carriedFood(player);
            for (const id of edibleFoodIds()) {
                if (need <= 0) break;
                const inBank = bank.getItemCount(id);
                if (inBank > 0) need -= moveItems(bank, inv, id, Math.min(need, inBank));
            }
        }
        let want: number;
        if (this.role === 'bigstake') want = (this.options.deal?.stake ?? 0) + 100;
        else if (this.role === 'staker') want = Math.min(owned, Math.max(5000, Math.round(owned * ARENA.visit.carry)), 200000);
        else want = Math.max(carried(player, Items.COINS), Math.min(owned, 60));
        const have = carried(player, Items.COINS);
        if (have > want) {
            const moved = inv.remove(Items.COINS, have - want);
            if (moved > 0) {
                const added = bank.add(Items.COINS, moved);
                if (added < moved) inv.add(Items.COINS, moved - added);
            }
        } else if (have < want) moveItems(bank, inv, Items.COINS, Math.min(want - have, bank.getItemCount(Items.COINS)));
        this.carry = carried(player, Items.COINS);
    }

    private _afterBank(player: Player): State {
        if (this.visitEnds < 0) this.visitEnds = World.currentTick + (this.options.stay ?? rand(ARENA.visit.length[0], ARENA.visit.length[1]));
        if (this.role === 'staker' || this.role === 'bigstake') return 'heal';
        return this.wantsTomatoes && !this.tomatoesDone && carried(player, Items.COINS) >= 15 ? 'tomatoes' : 'watch';
    }

    /** to full Hitpoints at a nurse (Heal: 12 a click), then on */
    private _heal(player: Player, now: number): void {
        if (botContinuePage(player)) return; // ("You look healthy to me!")
        if (fullHp(player) || this.heals >= HEAL_TRIES) {
            this.heals = 0;
            this.state = this.role === 'bigstake' ? 'meet' : 'stand';
            return;
        }
        if (now < this.healAt || player.delayed) return;
        const nurse = findNpcFiltered(player.x, player.z, 0, npc => NURSES.has(NpcType.get(npc.type).debugname ?? ''), 15);
        this.heals++;
        if (!nurse) {
            // (none near: to the hospital's middle, where they stand)
            const [x0, z0, x1, z1] = ARENA.places.hospital;
            walkTo(player, (x0 + x1) >> 1, (z0 + z1) >> 1);
            this.healAt = now + 10;
            return;
        }
        interactNpcOp(player, nurse, 3);
        this.healAt = now + 4 + humanDelay(player, 'page');
    }

    /** the crate's Shop of Distaste: 5-15 rotten tomatoes, once a visit */
    private _buyTomatoes(player: Player): void {
        const done = (): void => {
            this.tomatoesDone = true;
            if (openShopStock(player)) player.closeModal();
            this.state = 'watch';
        };
        if (openShopStock(player)) {
            const have = carried(player, tomato());
            if (have >= this.tomatoWant || ++this.buyTries > 6 || !buyFromOpenShop(player, tomato(), this.tomatoWant - have)) return done();
            this.cooldown = 1 + humanDelay(player, 'page');
            return;
        }
        if (++this.shopWait > 45) return done();
        if (this.shopWait % 15 === 1) {
            const crate = findLocByName(player.x, player.z, 0, 'rotten_tomato_crate', 12);
            if (!crate) return done();
            interactLocOp(player, crate, 1);
        }
    }

    // ── standing and staking ─────────────────────────────────────────────────────────────────────────────────────────

    /** a free tile of its own on a walkway of the challenge area: a stake spot where the others stand, or `at` */
    private _claimTile(player: Player, at: readonly [number, number, number] | null): [number, number] | null {
        for (let tries = 0; tries < 3; tries++) {
            const [x, z, r] = at ?? pickStakeSpot(player);
            const tile = claimStandTile(player, x, z, 0, r, (tx, tz) => inChallengeArea(tx, tz, 0));
            if (tile) return tile;
        }
        return null;
    }

    /** to its tile (true: on it, or none to be had) */
    private _toTile(player: Player, at: readonly [number, number, number] | null = null): boolean {
        if (!this.tile) this.tile = this._claimTile(player, at);
        if (!this.tile) return true;
        const [tx, tz] = this.tile;
        if (player.x === tx && player.z === tz && player.level === 0) {
            this.walkTicks = 0;
            return true;
        }
        if (player.hasWaypoints()) return false;
        if (++this.walkTicks > 150) {
            // (no way onto it: another tile, then where it stands)
            releaseStandTile(player);
            this.walkTicks = 0;
            this.tile = claimStandTile(player, player.x, player.z, 0, 0);
            return false;
        }
        if (cheb(player, { x: tx, z: tz }) <= 12) stepToTile(player, tx, tz);
        else walkTo(player, tx, tz);
        return false;
    }

    private _stand(player: Player, now: number): void {
        const busy = this.offer !== null || this.answer !== null || this.toHuman !== null;
        // over: its time, a losing streak, its coins
        if (!busy) {
            if (now >= this.visitEnds) return this._leave(player, false);
            if (this.losses >= this.maxLosses || (this.carry < ARENA.stakes.min && this.duels > 0)) return this._leave(player, true);
        }
        // its answer to a challenge, a moment after it came
        if (this.answer) {
            if (now >= this.answer.at) {
                const a = this.answer;
                this.answer = null;
                if (a.to.slot !== -1 && hasChallenged(a.to, player)) this._begin(player, a.to, a.deal, false, a.human);
            }
            return;
        }
        if (duelStatus(player) === DuelStatus.RECEIVED && this._incoming(player, now)) return;
        // a challenge of its own on its way: to the human (the call, then the click), to a bot (its click)
        if (this.toHuman) return this._humanChallenge(player, now);
        if (this.offer) {
            if (this.offer.to.slot === -1 || now - this.offer.at > OFFER_TICKS) this.offer = null;
            else if (now >= this.offer.at) this._begin(player, this.offer.to, this.offer.deal, true, false);
            return;
        }
        if (this.reservedBy && now - this.reservedAt <= OFFER_TICKS) return;
        this.reservedBy = null;
        if (!this._toTile(player)) return;

        // the human, now and then (where they stand: port/BotArena's rules)
        if (fullHp(player)) {
            const h = challengeHumanNow(player, this.carry);
            if (h) {
                // (its call first, as it decided: the click 3-8 s after it)
                this.toHuman = { human: h.human, cap: h.cap, at: now, opAt: now + rand(HUMAN_CALL_DELAY[0], HUMAN_CALL_DELAY[1]) };
                sayArena(player, 'duel-human', '', { to: h.human });
                return;
            }
        }
        // a partner among the stakers near, every 10-30 s
        if (now >= this.searchAt) {
            this.searchAt = now + rand(ARENA.staker.search[0], ARENA.staker.search[1]);
            if (this._findPartner(player, now)) return;
        }
        // its call, every 4-9 minutes, with players near to hear it
        if (now >= this.callAt) {
            this.callAt = now + rand(ARENA.staker.call[0], ARENA.staker.call[1]);
            if (this._playersNear(player, 15) > 0) {
                const call = this._callLine(player, Math.min(stakeRoom(player, this.carry), Infinity));
                if (call) {
                    this.called = { ...callOffer(call), at: now };
                    sayArenaText(player, call, {});
                }
            }
            return;
        }
        if (now >= this.fidgetAt) {
            this.fidgetAt = now + rand(400, 1200);
            // (now and then over to where the others stand, else a look about)
            if (Math.random() < 0.4) {
                releaseStandTile(player);
                this.tile = null;
            } else if (Math.random() < 0.1) botEmote(player, Math.random() < 0.5 ? 'think' : 'cheer');
        }
    }

    /**
     * A call it can make good: its stake within `room` ("50k stake anyone" only with 50k to stake), plain now and then
     * ("stake?"); null: none
     */
    private _callLine(player: Player, room: number, plainShare = 0.35): string | null {
        const kind = Math.random() < plainShare ? 'plain' : Math.random() < 0.5 ? 'stake' : 'rules';
        const pool = arenaLines('duel-call', kind).filter(l => {
            const stake = callOffer(l).stake;
            return stake === undefined || stake <= room;
        });
        void player;
        return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
    }

    private _playersNear(player: Player, r: number): number {
        let n = 0;
        for (const p of World.playerLoop.all()) {
            if (p !== player && p.level === player.level && cheb(p, player) <= r && ++n >= 3) break;
        }
        return n;
    }

    /** a partner for a duel: the nearest free staker within 25 tiles and 15 combat levels, both unhurt; the deal; its click */
    private _findPartner(player: Player, now: number): boolean {
        if (!fullHp(player)) return false;
        let best: [Player, DuelArenaTask] | null = null;
        let bestD = Infinity;
        for (const [other, task] of arenaVisitors()) {
            if (other === player || !task.freeForDuel() || other.level !== player.level) continue;
            const d = cheb(other, player);
            if (d > ARENA.staker.reach || Math.abs(other.combatLevel - player.combatLevel) > ARENA.staker.combat || !fullHp(other)) continue;
            if (d < bestD) {
                best = [other, task];
                bestD = d;
            }
        }
        if (!best) return false;
        const [other, task] = best;
        // the deal: its last call's when it named one; else a line it says to the other now, whose words are the deal
        const room = Math.min(stakeRoom(player, this.carry), stakeRoom(other, task.carry));
        let line: string | null = null;
        let offer: { stake?: number; rules?: string } = {};
        if (this.called && now - this.called.at < 1500 && (this.called.stake ?? 0) <= room) offer = this.called;
        else if (Math.random() < 0.6) {
            line = this._callLine(player, room, 0.3);
            if (line) offer = callOffer(line);
        }
        const deal: DuelDeal = testDeal ?? { stake: offer.stake ?? drawStake(room, room), rules: offer.rules ? rulesOf(offer.rules) : drawRules() };
        task.reservedBy = player;
        task.reservedAt = now;
        this.offer = { to: other, deal, at: now + rand(4, 10) };
        if (line) sayArenaText(player, line, { to: other, typed: true });
        return true;
    }

    /** a challenge came (274 set its %duelstatus): from the bot that picked it, or the human; true when it handled it */
    private _incoming(player: Player, now: number): boolean {
        const from = this._challenger(player);
        if (!from) return false;
        const seen = this.handled.get(from.uid);
        if (seen !== undefined && now - seen < 200) return false;
        if (from.is_bot === true) {
            const task = arenaVisitors().find(([p]) => p === from)?.[1] ?? null;
            const offer = task?.offer;
            if (!offer || offer.to !== player || this.session.active) return false;
            this.handled.set(from.uid, now);
            // (the challenge it was picked for: a word now and then, then its own click a moment on)
            if (Math.random() < 0.4) sayArena(player, 'duel-agree', '', { to: from, typed: true });
            this.answer = { to: from, deal: offer.deal, at: now + 2 + humanDelay(player, 'trade'), human: false };
            this.reservedBy = null;
            return true;
        }
        this.handled.set(from.uid, now);
        if (this.handled.size > 32) this.handled.clear();
        // the human challenged it: fair, the purse, never after they beat it; else a word, and nothing
        const why = this.freeForDuel() ? refuseHuman(player, from, this.carry) : 'busy';
        if (why === null) {
            const cap = humanCap(player, from, this.carry);
            noteHumanChallenge(player, from, 'human', 'accepted');
            if (Math.random() < 0.5) sayArena(player, 'duel-agree', '', { to: from, typed: true });
            this.answer = { to: from, deal: { stake: 0, rules: 0, human: { cap } }, at: now + 2 + humanDelay(player, 'trade'), human: true };
            return true;
        }
        noteHumanChallenge(player, from, 'human', `declined:${why}`);
        if (this.role === 'staker' || Math.random() < 0.5) sayArena(player, 'duel-decline', why === 'busy' ? '' : why, { to: from, typed: true });
        return true;
    }

    /** who challenged it: a player within 15 tiles whose %duel2accept is this bot */
    private _challenger(player: Player): Player | null {
        const uid = player.uid | 0;
        for (const p of World.playerLoop.all()) {
            if (p === player || p.level !== player.level || cheb(p, player) > 15) continue;
            if (duelPartnerVar(p) === uid) return p;
        }
        return null;
    }

    /** its challenge to the human: the call said, the click 3-8 s on; the session then waits for theirs (60 s) */
    private _humanChallenge(player: Player, now: number): void {
        const c = this.toHuman!;
        if (c.human.slot === -1 || !inChallengeArea(c.human.x, c.human.z, c.human.level)) {
            challengeAnswered(player, c.human, 'ignored');
            this.toHuman = null;
            return;
        }
        if (now >= c.opAt) this._begin(player, c.human, { stake: 0, rules: 0, human: { cap: c.cap } }, true, true);
    }

    /** The human said "no" to its challenge (port/BotArena): a "k", and it is off. True when it was this bot's challenge. */
    humanSaidNo(human: Player): boolean {
        const p = this.lastPlayer;
        if (!p || !this.toHuman || this.toHuman.human !== human) return false;
        if (this.session.active && this.session.phase !== 'request') return false;
        challengeAnswered(p, human, 'refused');
        this.toHuman = null;
        if (this.session.active) this._endSession(p, 'declined');
        sayArena(p, 'duel-refused', '', { to: human, typed: true });
        if (Math.random() < 0.3) botEmote(p, 'no');
        return true;
    }

    /** May it take up the human's own call ("stake?" near it)? A free staker, fair, the purse, never one they beat. */
    canAnswerCall(human: Player): boolean {
        const p = this.lastPlayer;
        return p !== null && this.freeForDuel() && fullHp(p) && refuseHuman(p, human, this.carry) === null;
    }

    /** It takes up the human's call: "sure", then its challenge a few seconds on. */
    answerCall(human: Player, _offer: { stake?: number; rules?: string }): boolean {
        const p = this.lastPlayer;
        if (!p) return false;
        const cap = humanCap(p, human, this.carry);
        if (cap <= 0) return false;
        const now = World.currentTick;
        noteHumanChallenge(p, human, 'call', '');
        callTakenUp(p, human);
        sayArena(p, 'duel-agree', '', { to: human, typed: true });
        this.toHuman = { human, cap, at: now, opAt: now + rand(HUMAN_CALL_DELAY[0], HUMAN_CALL_DELAY[1]) + 4 };
        return true;
    }

    // ── the duel ─────────────────────────────────────────────────────────────────────────────────────────────────────

    private _begin(player: Player, partner: Player, deal: DuelDeal, challenger: boolean, human: boolean): void {
        if (player.modalMain !== -1) player.closeModal();
        player.clearWaypoints();
        this.duelPartner = partner;
        this.duelHuman = human;
        this.duelRecord = null;
        this.weapon = player.getInventory(InvType.WORN)?.get(3)?.id ?? -1;
        this.roleGen++;
        setRole(player, 'duellist');
        this.session.begin(player, partner, deal, challenger, human ? duelVoice(partner) : null);
        this.state = 'duel';
    }

    private _duel(player: Player): void {
        const was = this.session.phase;
        const outcome = this.session.tick(player);
        // the human's click came (both screens opened): their answer
        if (was === 'request' && this.session.phase === 'select' && this.toHuman) {
            challengeAnswered(player, this.toHuman.human, 'accepted');
            this.toHuman = null;
        }
        if (this.session.phase === 'fight' && this.duelPartner) {
            if (!this.duelRecord) this.duelRecord = noteDuelStart(player, this.duelPartner, this.session.facts, this.role === 'bigstake');
            sampleSpectators(player);
        }
        if (outcome !== null) this._afterDuel(player, outcome);
    }

    private _endSession(player: Player, outcome: DuelOutcome): void {
        this.session.end(player, outcome);
        this._afterDuel(player, outcome);
    }

    /** the duel is over: the records, a line or an emote, its weapon back, then its tile (a big stake's: done) */
    private _afterDuel(player: Player, outcome: DuelOutcome): void {
        const partner = this.duelPartner;
        const facts = this.session.facts;
        const fought = facts.fightAt >= 0;
        this.offer = null;
        if (this.toHuman && partner === this.toHuman.human) {
            // (a challenge that never reached them, a fence between, is no silence of theirs: no one's to answer)
            const silent = outcome === 'timeout' || outcome === 'gone';
            challengeAnswered(player, this.toHuman.human, silent && !facts.requested ? 'unreached' : silent ? 'ignored' : 'refused');
            if (outcome === 'timeout' && Math.random() < 1 / 3) sayArena(player, 'duel-giveup', '', { to: partner, typed: true });
            this.toHuman = null;
        }
        if (fought) {
            noteDuelEnd(player, outcome, facts);
            if (this.duelHuman && partner) noteHumanDuel(partner.username, player.username, outcome, facts.stake);
            this.duels++;
            if (outcome === 'won') this.losses = 0;
            else if (outcome === 'lost') this.losses++;
            // its words: a winner most times ("gf", "ty for the cash"; "omg 2 hp lol" after a close one), a loser half
            if (outcome === 'won' && Math.random() < 0.6) sayArena(player, 'duel-won', facts.lowest < 0.15 ? 'close' : '', { to: partner, typed: true, delay: 3 });
            else if (outcome === 'lost' && Math.random() < 0.5) sayArena(player, 'duel-lost', facts.forfeit ? 'forfeit' : '', { to: partner, typed: true, delay: 3 });
            this._emoteLater(player, outcome === 'won' ? WIN_EMOTES : outcome === 'lost' ? LOSE_EMOTES : [], outcome === 'won' ? 0.25 : 0.15);
        }
        this.carry = carried(player, Items.COINS);
        // a box duel took its weapon off (274's ~unequip_duel): back on
        if (this.weapon !== -1 && !player.getInventory(InvType.WORN)?.get(3)) {
            const inv = player.getInventory(InvType.INV);
            for (let slot = 0; inv && slot < inv.capacity; slot++) {
                if (inv.get(slot)?.id === this.weapon) {
                    interactHeldOp(player, inv, this.weapon, slot, 2);
                    break;
                }
            }
        }
        this._clearRoleSoon(player);
        this.duelPartner = null;
        this.duelRecord = null;
        if (this.role === 'bigstake') {
            if (!fought && ++this.bigTries < BIG_TRIES && !this.options.run?.over) {
                this.cooldown = 10;
                this.state = 'meet';
                return;
            }
            this.options.run?.duelOver(player, fought ? outcome : 'refused');
            if (outcome === 'won' && Math.random() < 0.8) sayArena(player, 'duel-won', '', { typed: true, delay: 8 });
            return this._finish(player);
        }
        this.cooldown = 2 + humanDelay(player, 'notice');
        this.state = fullHp(player) ? 'stand' : 'heal';
    }

    /** its role a moment after the duel (274 resets both first; a newer duel keeps its own) */
    private _clearRoleSoon(player: Player): void {
        const gen = this.roleGen;
        scheduleInTicks(ROLE_AFTER_TICKS, () => {
            if (this.roleGen === gen && !this.session.active) clearRole(player);
        });
    }

    /** an emote a moment on, when the bot is free for one (no screen, not fighting) */
    private _emoteLater(player: Player, emotes: readonly Emote[], chance: number): void {
        if (emotes.length === 0 || Math.random() >= chance) return;
        const emote = emotes[Math.floor(Math.random() * emotes.length)];
        const until = World.currentTick + 40;
        const tryIt = (): void => {
            if (player.slot === -1 || BotManager.botFor(player) === null) return;
            if (!botEmote(player, emote) && World.currentTick < until) scheduleInTicks(3, tryIt);
        };
        scheduleInTicks(rand(6, 14), tryIt);
    }

    // ── a big stake's duellist: to the other, then the agreed duel ──────────────────────────────────────────────────

    private _meet(player: Player, now: number): void {
        const partner = this.options.partner;
        const deal = this.options.deal;
        if (!partner || !deal || partner.slot === -1) {
            this.options.run?.abort('a duellist left');
            return this._finish(player);
        }
        if (!this.options.challenger) {
            // the other waits on its tile and answers the challenge
            if (duelStatus(player) === DuelStatus.RECEIVED && hasChallenged(partner, player) && !this.answer) {
                if (Math.random() < 0.5) sayArena(player, 'duel-big', 'call', { to: partner, typed: true });
                this.answer = { to: partner, deal, at: now + 2 + humanDelay(player, 'trade'), human: false };
                return;
            }
            if (this.answer) {
                if (now >= this.answer.at) {
                    const a = this.answer;
                    this.answer = null;
                    if (hasChallenged(a.to, player)) this._begin(player, a.to, a.deal, false, false);
                }
                return;
            }
            this._toTile(player);
            return;
        }
        // the challenger walks up to it and challenges once both are there and unhurt
        if (cheb(player, partner) > 8 || partner.level !== player.level) {
            if (!player.hasWaypoints()) walkTo(player, partner.x, partner.z);
            return;
        }
        const ready = inChallengeArea(partner.x, partner.z, 0) && inChallengeArea(player.x, player.z, 0) && fullHp(partner) && fullHp(player) && duelScreen(partner) === null && partner.modalMain === -1;
        if (!ready || now < this.searchAt) return;
        this.searchAt = now + 60;
        if (Math.random() < 0.6) sayArena(player, 'duel-big', 'call', { to: partner, typed: true });
        this._begin(player, partner, deal, true, false);
    }

    // ── watching ─────────────────────────────────────────────────────────────────────────────────────────────────────

    private _watch(player: Player, now: number): void {
        const run = this.options.run;
        if (this.role === 'watcher' && now >= this.visitEnds && !this.watching) return this._leave(player, false);
        if (this.role === 'watcher' && duelStatus(player) === DuelStatus.RECEIVED) this._incoming(player, now);
        // the duel it watched is over: a word or an emote, a moment, then the next
        if (this.watching && this.watching.record.end >= 0) {
            if (this.watchedEnd < 0) this._duelEnded(player, now);
            if (now - this.watchedEnd < 15) return;
            this.watching = null;
            this.wall = null;
            this.tile = null;
            releaseStandTile(player);
            this.nextWatchAt = now + rand(20, 90);
        }
        if (!this.watching) {
            const pick = now < this.nextWatchAt ? null : run ? liveDuelOf(run.a) : this._nearestDuel(player);
            if (!pick) {
                this._toTile(player, ARENA.places.idleSpot);
                return;
            }
            this.watching = { record: pick.record, a: pick.a, b: pick.b };
            this.wall = null;
            this.leanTries = 0;
            this.releans = 0;
            this.badWalls = [];
            this.leanAt = -1;
            this.shouted = false;
            this.emotes = 0;
            this.watchedEnd = -1;
            this.tomatoesHeld = carried(player, tomato());
            this.throwsLeft = this.tomatoesHeld > 0 ? rand(ARENA.watch.throws[0], ARENA.watch.throws[1]) : 0;
            this.nextThrowAt = now + rand(15, 40);
        }
        const w = this.watching;
        // a tomato it threw (274 took it from the pack): the duel's
        const held = carried(player, tomato());
        if (held < this.tomatoesHeld) w.record.tomatoes += this.tomatoesHeld - held;
        this.tomatoesHeld = held;
        // a wall beside the duel, leant on (274's Lean against: the bot steps onto the wall's tile and looks in)
        if (!this.wall && this.leanTries < 3) {
            this.leanTries++;
            const loc = this._leanWall(player, w);
            if (loc) {
                releaseStandTile(player);
                this.tile = null;
                this.wall = [loc.x, loc.z];
                claimStandTile(player, loc.x, loc.z, 0, 0);
                interactLocOp(player, loc, 5);
                this.leanAt = now;
                this.cooldown = 3;
                return;
            }
        }
        if (player.hasWaypoints() || player.delayed) return;
        // (274 puts a leaning player on the wall's tile; still beside it a moment on, the wall was out of its reach from
        // where it came, "I can't reach that.": another wall)
        if (this.wall && this.leanAt >= 0) {
            if (player.x === this.wall[0] && player.z === this.wall[1]) this.leanAt = -1;
            else if (now - this.leanAt > 12) {
                this.badWalls.push(`${this.wall[0]},${this.wall[1]}`);
                releaseStandTile(player);
                this.wall = null;
                this.leanAt = -1;
                return;
            }
        }
        // a shout at the start, now and then
        if (!this.shouted && now - w.record.start < 60) {
            this.shouted = true;
            if (Math.random() < ARENA.watch.shout) {
                sayArena(player, 'duel-watch', 'start', { typed: true });
                return;
            }
        }
        // a tomato, 10+ ticks apart, at a duellist within 10 tiles in its sight (274's approach for an item used on a
        // player: out of sight it would walk the bot off its wall), once they fight
        if (this.throwsLeft > 0 && now >= this.nextThrowAt && held > 0 && w.record.start >= 0) {
            const target = Math.random() < 0.5 ? w.a : w.b;
            if (target.slot !== -1 && target.level === player.level && inSight(player, target) && useItemOnPlayer(player, target, tomato())) {
                this.throwsLeft--;
                this.nextThrowAt = now + ARENA.watch.gap + rand(0, 30);
                if (Math.random() < 0.15) sayArena(player, 'duel-watch', 'tomato', { typed: true });
                return;
            }
            // (the fight out of reach or sight of its wall: another wall nearer it, twice a duel at most)
            if (target.slot !== -1 && !inSight(player, target) && this.releans < 2) {
                this.releans++;
                this.wall = null;
                this.leanTries = 0;
            }
            this.nextThrowAt = now + 10;
        }
        // a cheer or a clap now and then (one a duel at most; since 2026-10-19, "emotes rare and special": a
        // couple a duel, at 2.5 times the chance, before)
        if (this.emotes < 1 && Math.random() < 0.01 && Math.random() < ARENA.watch.emote && botEmote(player, WATCH_EMOTES[Math.floor(Math.random() * WATCH_EMOTES.length)])) this.emotes++;
    }

    /** the duel it watched ended: a word or an emote now and then */
    private _duelEnded(player: Player, now: number): void {
        this.watchedEnd = now;
        const r = this.watching!.record;
        if (Math.random() < ARENA.watch.shout) sayArena(player, 'duel-watch', r.forfeit ? 'forfeit' : 'end', { typed: true });
        else this._emoteLater(player, WATCH_EMOTES, 0.15);
    }

    /** the nearest duel under way within 30 tiles */
    private _nearestDuel(player: Player): { record: DuelRecord; a: Player; b: Player } | null {
        let best: { record: DuelRecord; a: Player; b: Player } | null = null;
        // (any duel in the complex, the nearest first: 274 sends a duel to any of its six arenas, up to 60 tiles from the
        // hospital, and spectators walked over to the one that was on)
        let bestD = 80;
        for (const d of liveDuels()) {
            if (d.a === player || d.b === player || d.record.end >= 0) continue;
            const dist = Math.min(cheb(d.a, player), cheb(d.b, player));
            if (dist < bestD) {
                best = d;
                bestD = dist;
            }
        }
        return best;
    }

    /** a wall to lean on beside the duel: one 274 lets a player lean on (not a "nolean" one), outside the arenas, free */
    private _leanWall(player: Player, w: { a: Player; b: Player }): Loc | null {
        const cx = (w.a.x + w.b.x) >> 1;
        const cz = (w.a.z + w.b.z) >> 1;
        let best: Loc | null = null;
        let bestD = Infinity;
        const others = arenaVisitors();
        findLocByPrefixWhere(cx, cz, 0, 'duel_arena_top', 10, loc => {
            const name = LocType.get(loc.type).debugname ?? '';
            if (name.includes('nolean') || inFightZone(loc.x, loc.z, 0) || !inDuelArena(loc.x, loc.z, 0)) return false;
            if (others.some(([p, t]) => p !== player && t.wall !== null && t.wall[0] === loc.x && t.wall[1] === loc.z)) return false;
            if (this.badWalls.includes(`${loc.x},${loc.z}`)) return false;
            // (the nearest to the fight first, where a tomato reaches: 10 tiles in sight from the wall's tile, 274's own)
            const fromFight = cheb(loc, { x: cx, z: cz });
            if (fromFight > ARENA.watch.reach - 2 || !(inSight(loc, w.a) || inSight(loc, w.b))) return false;
            const d = cheb(loc, player) + 3 * fromFight;
            if (d < bestD) {
                best = loc;
                bestD = d;
            }
            return false;
        });
        return best;
    }

    // ── leaving ──────────────────────────────────────────────────────────────────────────────────────────────────────

    /** the visit is over (`broke`: a losing streak or no coins left: "brb more cash" now and then) */
    private _leave(player: Player, broke: boolean): void {
        if (broke && Math.random() < 0.6) sayArena(player, 'duel-leave', '', { typed: true });
        this._finish(player);
    }

    private _finish(player: Player): void {
        if (this.session.active) this.session.end(player, 'timeout');
        this.state = 'done';
        this._release(player);
    }

    /** its tile back, out of the registry, its role gone, the next visit due (once) */
    private _release(player: Player | null): void {
        if (!player) return;
        // (a challenge to the human not answered yet: it never reached its end; no refusal, the next may come)
        if (this.toHuman) {
            challengeAnswered(player, this.toHuman.human, 'unreached');
            this.toHuman = null;
        }
        releaseStandTile(player);
        if (!this.session.active) clearRole(player);
        leaveArena(player, this);
        if (this.began && !this.ended) {
            this.ended = true;
            if (this.role === 'staker' || this.role === 'watcher') visitEnded(player);
        }
    }

    override interrupt(): void {
        super.interrupt();
        const p = this.lastPlayer;
        if (p && this.session.active) this.session.end(p, 'timeout');
        this.state = 'done';
        this._release(p);
    }

    override reset(): void {
        super.reset();
        if (this.began) {
            // (a logout, a replaced sub-task: the visit is over; a duel screen still open is closed: 274 returns the stakes)
            const p = this.lastPlayer;
            if (p && this.session.active) this.session.end(p, 'timeout');
            this.state = 'done';
            this._release(p);
            return;
        }
        this.state = 'travel';
        this.travelTicks = 0;
        this.pastFence = false;
        this.approached = false;
        this.stuck.reset();
    }
}
