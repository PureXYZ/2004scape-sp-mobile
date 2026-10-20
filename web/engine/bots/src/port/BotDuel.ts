// port (the realism work, phase 5b, Track A: the Duel Arena, the
// the research): a bot's side of one duel, driven by 274's own duel screens as a
// player clicks them, on port/BotTradeScreen's TradeSession model. No overlay patch: a challenge leaves state a bot can
// read (the challenged player's %duelstatus is 1 and the challenger's %duel2accept holds its uid), and every step is a
// click a client makes:
//   request   the challenge (Challenge, op 1, APPLAYER1: 274 walks the challenger up to the other) or the answer to one
//             (op 1 back, which opens both players' screens); a challenge to a human waits for their click in the chatbox
//   select    duel_select_type + duel_side: the stake in coins only (duel_side:inv's Stake-X with the count answered at
//             once, BotScreens.pressInvButtonExact; duel_select_type:inv's Remove-X), the challenger's rules (one toggle a
//             tick: each resets both players' accept), accept once the bot has read the screen (BotTiming 'trade') and
//             only while the other's offer and the rules are what the deal says; any change starts the reading again
//   confirm   duel_confirm: the same deal still holds (it cannot change there in 274), accept after a moment's reading
//   arena     274 jumps both players into an arena (duel_arena_prepare_start: noteMove 'duel', the humanlike report lists
//             it apart from the unseen jumps) and counts down "3", "2", "1", "FIGHT!"
//   fight     Fight (op 2) on the opponent a person's moment after FIGHT!, again after it ate or lost its target; it eats
//             below half its Hitpoints when food is allowed; now and then (1 duel in 10, losing under a fifth of its
//             Hitpoints, forfeit allowed and the bot free to walk) it forfeits at the arena's trapdoor (Yes)
//   result    the winner reads duel_win a moment and closes it (274 pays the stake out then: duel_win's if_close); the
//             loser comes round in the hospital (duel_reset_all)
// The bot never walks while a duel screen is open (a walk closes it: a decline), and never keeps a partner in
// botTradeTargetPid (BotTradeScreen's safety net would drop it mid-fight). A human may change the stake or a rule at any
// time: both players' accept resets (the script) and the bot reads the screen again.
//
// Against a human (`deal.human`): the bot puts up exactly the human's coins up to its cap (min(25k, 10 % of its coins,
// what the purse has left: port/BotArena), never an item, and accepts only a fight it can make with melee (no No Melee,
// no Flower Power); items from the human: "i only stake gp", no accept.
import Component from '#/cache/config/Component.js';
import InvType from '#/cache/config/InvType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import type Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import World from '#/engine/World.js';
import { botContinuePage, findLocByPrefix, interactIfButtonByName, interactLocOp, interactPlayerOp, noteMove } from '#/engine/bot/BotAction.js';
import { Items } from '#/engine/bot/BotKnowledge.js';
import { pressInvButtonExact, walkDialogue, type DialogueWalk } from '#/engine/bot/port/BotScreens.js';
import { botReactionTicks } from '#/engine/bot/port/BotTiming.js';
import { carriedFood, eatBestFood } from '#/engine/bot/tasks/BotTaskBase.js';

/** %duelstatus (game_duelarena/configs/duelarena.constant) */
export const DuelStatus = { RESET: 0, RECEIVED: 1, PENDING_ACCEPT: 2, ACCEPT: 3, PENDING_CONFIRM: 4, CONFIRM: 5, START: 6, LOST: 7, VICTORY: 8, OPPONENT_RESIGNED: 9 } as const;

/** %dueloptions' bits (duelarena.constant) */
export const Rule = { NO_FORFEIT: 0, NO_MOVEMENT: 1, NO_WEAPONS: 2, NO_ARMOUR: 3, NO_RANGED: 4, NO_MELEE: 5, NO_MAGIC: 6, NO_POTIONS: 7, NO_FOOD: 8, NO_PRAYER: 9, OBSTACLES: 10, NO_JEWELRY: 11, FLOWER_POWER: 12, NO_SPECS: 13 } as const;

/** each rule's button on duel_select_type (duel_arena_settings.rs2), by its bit */
const RULE_BUTTONS: readonly string[] = [
    'duel_select_type:no_forfeit',
    'duel_select_type:no_movement',
    'duel_select_type:no_weapons',
    'duel_select_type:no_armour',
    'duel_select_type:no_ranged',
    'duel_select_type:no_melee',
    'duel_select_type:no_magic',
    'duel_select_type:no_potions',
    'duel_select_type:no_food',
    'duel_select_type:no_prayer',
    'duel_select_type:obstacles',
    'duel_select_type:no_jewelry',
    'duel_select_type:flower_power',
    'duel_select_type:no_specs'
];

/** a rule set's %dueloptions from its bits */
export function ruleBits(bits: readonly number[]): number {
    return bits.reduce((sum, b) => sum | (1 << b), 0);
}

/** the rules a bot will fight a human under: any it can fight with melee (no No Melee, no Flower Power) */
export function meleeAllowed(options: number): boolean {
    return (options & (1 << Rule.NO_MELEE)) === 0 && (options & (1 << Rule.FLOWER_POWER)) === 0;
}

/** 60 s: how long the other side may leave a screen without a change before the bot closes it (a decline) */
export const SCREEN_TICKS = 100;
/** a challenge to a human waits this long for their click (60 s: then the bot gives up) */
export const HUMAN_ANSWER_TICKS = 100;
/** a bot's challenge to another bot (the other's answer is a moment's: it read the call) */
const BOT_ANSWER_TICKS = 40;
/** 274's countdown is 4 ticks after the jump; the start waits at most this long */
const START_TICKS = 30;
/** 60 minutes: 274's own limit (duel_arena_time_limit: an honourable draw) */
const FIGHT_TICKS = 6100;
/** the winner reads the result this long (2-4 s) before closing it */
const RESULT_READ: [number, number] = [3, 7];
/** a bite below this share of its Hitpoints when food is allowed */
const EAT_BELOW = 0.5;
/** forfeit: the chance a duel is one the bot would give up (decided at the start), and the share of HP it does it under */
export const FORFEIT_CHANCE = 0.1;
const FORFEIT_BELOW = 0.2;
/** beyond this (or on another floor) the partner is gone */
const PARTNER_RANGE = 30;

export type DuelScreen = 'select' | 'confirm' | 'win' | null;
export type DuelPhase = 'request' | 'select' | 'confirm' | 'arena' | 'fight' | 'result';
/**
 * How a duel ended: 'won', 'lost' (in the arena; a forfeit too), 'draw' (274's time limit, an opponent who logged out:
 * stakes back), 'declined' (the other side closed a screen), 'timeout' (no answer, or no change on a screen for
 * SCREEN_TICKS: the bot closed it), 'gone' (the partner left), 'refused' (the deal no longer held on the confirm screen,
 * or the arenas were full).
 */
export type DuelOutcome = 'won' | 'lost' | 'draw' | 'declined' | 'timeout' | 'gone' | 'refused';

/** What the bot stakes and fights under. */
export interface DuelDeal {
    /** coins each side stakes (0: a friendly fight) */
    stake: number;
    /** %dueloptions (bot against bot: the challenger sets them, both check them) */
    rules: number;
    /** against a human: the bot mirrors their coins up to `cap` and takes any rules it can fight by melee */
    human?: { cap: number };
}

/** Lines the session says on the screens (port/BotArena's, in the persona's style); null keeps it quiet. */
export interface DuelVoice {
    say(bot: Player, pool: 'hello' | 'items' | 'rules' | 'change' | 'accept' | 'max', cap?: number): void;
}

interface DuelIds {
    select: number;
    confirm: number;
    win: number;
    status: number;
    partner: number;
    options: number;
    offer: number;
    winnings: number;
    inv: number;
}
let ids: DuelIds | null = null;

/** The duel's interfaces, varps and inventories (looked up once, after the cache is loaded). */
function duelIds(): DuelIds {
    if (!ids) {
        ids = {
            select: Component.getId('duel_select_type'),
            confirm: Component.getId('duel_confirm'),
            win: Component.getId('duel_win'),
            status: VarPlayerType.getId('duelstatus'),
            partner: VarPlayerType.getId('duel2accept'),
            options: VarPlayerType.getId('dueloptions'),
            offer: InvType.getId('dueloffer'),
            winnings: InvType.getId('duelwinnings'),
            inv: InvType.getId('inv')
        };
    }
    return ids;
}

/** The duel screen `player` has open. */
export function duelScreen(player: Player): DuelScreen {
    const { select, confirm, win } = duelIds();
    const main = player.modalMain;
    return main === select ? 'select' : main === confirm ? 'confirm' : main === win ? 'win' : null;
}

export function duelStatus(player: Player): number {
    return (player.getVar(duelIds().status) as number) ?? 0;
}

/** %duel2accept: the uid (an int32) of the player this one challenged or duels, else -1/0 */
export function duelPartnerVar(player: Player): number {
    return (player.getVar(duelIds().partner) as number) ?? -1;
}

export function duelOptions(player: Player): number {
    return (player.getVar(duelIds().options) as number) ?? 0;
}

/** Is `challenger`'s challenge waiting for `target` (274: the target's %duelstatus is received, the challenger's %duel2accept the target)? */
export function hasChallenged(challenger: Player, target: Player): boolean {
    return duelStatus(target) === DuelStatus.RECEIVED && duelPartnerVar(challenger) === (target.uid | 0);
}

/** item id -> total in one of the player's duel inventories ('offer' or 'winnings') */
export function duelInv(player: Player, which: 'offer' | 'winnings'): Map<number, number> {
    const out = new Map<number, number>();
    const inv = player.getInventory(which === 'offer' ? duelIds().offer : duelIds().winnings);
    if (!inv) return out;
    for (let slot = 0; slot < inv.capacity; slot++) {
        const item = inv.get(slot);
        if (item) out.set(item.id, (out.get(item.id) ?? 0) + item.count);
    }
    return out;
}

/** coins in the pack */
function packCoins(player: Player): number {
    const inv = player.getInventory(duelIds().inv);
    if (!inv) return 0;
    let n = 0;
    for (let slot = 0; slot < inv.capacity; slot++) {
        const item = inv.get(slot);
        if (item?.id === Items.COINS) n += item.count;
    }
    return n;
}

/** the duel's fight zones (duelarena.dbrow: duel_arena_fight_zones and the obstacle ones): x0, z0, x1, z1 */
export const FIGHT_ZONES: readonly (readonly [number, number, number, number])[] = [
    [3333, 3244, 3357, 3258], [3364, 3225, 3388, 3239], [3333, 3206, 3357, 3220],
    [3364, 3244, 3388, 3258], [3333, 3225, 3357, 3239], [3364, 3206, 3388, 3220]
];
/** the challenge area (duel_arena_zones: the whole complex; the fight zones are not part of it): x0, z0, x1, z1 */
export const CHALLENGE_AREA: readonly [number, number, number, number] = [3328, 3203, 3393, 3325];

/** in one of the six arenas (274's ~in_duel_arena) */
export function inFightZone(x: number, z: number, level: number): boolean {
    return level === 0 && FIGHT_ZONES.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1);
}

/** where a challenge may be made (274's ~in_duel_arena_challenge_area): the complex, not an arena */
export function inChallengeArea(x: number, z: number, level: number): boolean {
    const [x0, z0, x1, z1] = CHALLENGE_AREA;
    return level === 0 && x >= x0 && x <= x1 && z >= z0 && z <= z1 && !inFightZone(x, z, level);
}

/** anywhere in the complex (the challenge area and the arenas) */
export function inDuelArena(x: number, z: number, level: number): boolean {
    const [x0, z0, x1, z1] = CHALLENGE_AREA;
    return level === 0 && x >= x0 && x <= x1 && z >= z0 && z <= z1;
}

/**
 * Makes the bot's stake exactly `coins` (coins only: anything else it put up comes off), only while duel_select_type is
 * open; the count dialog is answered in the same call (BotPlayer would answer it 99). True when it is.
 */
export function setStake(bot: Player, coins: number): boolean {
    if (duelScreen(bot) !== 'select') return false;
    const offer = duelInv(bot, 'offer');
    for (const [id, n] of offer) {
        const keep = id === Items.COINS ? Math.min(n, coins) : 0;
        if (n > keep) pressInvButtonExact(bot, 'duel_select_type:inv', 'dueloffer', id, n - keep);
    }
    const have = duelInv(bot, 'offer').get(Items.COINS) ?? 0;
    if (coins > have) pressInvButtonExact(bot, 'duel_side:inv', 'inv', Items.COINS, coins - have);
    const now = duelInv(bot, 'offer');
    return (now.get(Items.COINS) ?? 0) === coins && [...now.keys()].every(id => id === Items.COINS);
}

/** the offer is exactly `coins` coins (an empty offer for 0) */
function offerIs(offer: ReadonlyMap<number, number>, coins: number): boolean {
    if (coins === 0) return offer.size === 0;
    return offer.size === 1 && offer.get(Items.COINS) === coins;
}

function rand(lo: number, hi: number): number {
    return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** A duel's record (port/BotArena logs it; the humanlike report and the tests read it). */
export interface DuelFacts {
    /** the tick the screens opened (-1: never), the fight began (-1: never), it ended */
    opened: number;
    fightAt: number;
    endedAt: number;
    /** the stake and rules both screens agreed (the confirm screen's) */
    stake: number;
    rules: number;
    forfeit: boolean;
    /** the lowest share of its Hitpoints the bot had in the fight (a close one: "omg 2 hp lol") */
    lowest: number;
    /** its challenge reached the other (274 set its %duel2accept to them): one that never did was no one's to answer */
    requested: boolean;
}

/**
 * One duel, as a staker's task drives it: begin() to challenge or to answer a challenge, then tick() every tick until
 * it returns the outcome. The bot never walks while it runs (but to forfeit, which 274's own walk to the trapdoor does).
 */
export class DuelSession {
    phase: DuelPhase | null = null;
    partnerUid = -1;
    deal: DuelDeal | null = null;
    challenger = false;
    facts: DuelFacts = DuelSession.freshFacts();
    private deadline = 0;
    private seen = '';
    private settled = '';
    private acceptAt = -1;
    private actAt = 0;
    private opAt = 0;
    private ops = 0;
    private said = '';
    private agreed: { stake: number; rules: number; theirs: string } | null = null;
    private attackAt = -1;
    private eatAt = 0;
    private forfeiter = false;
    private forfeitWalk: DialogueWalk | null = null;
    private forfeitTries = 0;
    private readAt = -1;
    private voice: DuelVoice | null = null;
    private wasInArena = false;
    private won = false;
    private sawWin = false;
    private packAtFight = 0;
    private acceptedOnce = false;
    private changeSaid = false;

    get active(): boolean {
        return this.phase !== null;
    }

    private static freshFacts(): DuelFacts {
        return { opened: -1, fightAt: -1, endedAt: -1, stake: 0, rules: 0, forfeit: false, lowest: 1, requested: false };
    }

    /**
     * The bot challenges `partner` (`challenger`) or answers its challenge (op 1 either way: 274 opens both screens
     * when the other had challenged this one). A challenge to a human waits for their click (HUMAN_ANSWER_TICKS).
     */
    begin(bot: Player, partner: Player, deal: DuelDeal, challenger: boolean, voice: DuelVoice | null = null): void {
        const now = World.currentTick;
        this.phase = 'request';
        this.partnerUid = partner.uid;
        this.deal = deal;
        this.challenger = challenger;
        this.voice = voice;
        this.facts = DuelSession.freshFacts();
        this.deadline = now + (challenger ? (deal.human ? HUMAN_ANSWER_TICKS : BOT_ANSWER_TICKS) : 20);
        this.seen = '';
        this.settled = '';
        this.acceptAt = -1;
        this.said = '';
        this.agreed = null;
        this.attackAt = -1;
        this.eatAt = 0;
        this.forfeiter = Math.random() < FORFEIT_CHANCE;
        this.forfeitWalk = null;
        this.forfeitTries = 0;
        this.readAt = -1;
        this.wasInArena = false;
        this.won = false;
        this.sawWin = false;
        this.packAtFight = 0;
        this.acceptedOnce = false;
        this.changeSaid = false;
        this.ops = 1;
        this.opAt = now + 15;
        interactPlayerOp(bot, partner.slot, 1);
    }

    /** The partner (null once gone). */
    partner(): Player | null {
        return this.partnerUid === -1 ? null : World.getPlayerByUid(this.partnerUid);
    }

    /** Every tick while active: the outcome once the duel is over, else null. */
    tick(bot: Player): DuelOutcome | null {
        if (this.phase === null) return null;
        const now = World.currentTick;
        const partner = this.partner();
        const screen = duelScreen(bot);
        const status = duelStatus(bot);

        if (this.phase === 'request') {
            if (screen === 'select') {
                this.phase = 'select';
                this.facts.opened = now;
                this.facts.requested = true;
                this.deadline = now + SCREEN_TICKS;
                // (a person looks at the screen before the first click)
                this.actAt = now + botReactionTicks(bot, 'trade');
                if (this.deal?.human) this.voice?.say(bot, 'hello');
            } else {
                if (this.challenger && partner && duelPartnerVar(bot) === (partner.uid | 0)) this.facts.requested = true;
                if (!partner || !near(bot, partner)) return this.end(bot, 'gone');
                if (now >= this.deadline) return this.end(bot, 'timeout');
                // the challenge may not have reached them ("Other player is busy at the moment.", a route that did not get
                // there): once more, but never a second request on top of one that arrived (the human would get it twice)
                if (this.challenger && now >= this.opAt && this.ops < 3 && !bot.hasInteraction() && duelPartnerVar(bot) !== (partner.uid | 0)) {
                    this.ops++;
                    this.opAt = now + 15;
                    interactPlayerOp(bot, partner.slot, 1);
                }
                return null;
            }
        }

        if (this.phase === 'select') {
            if (screen === 'confirm') {
                this.phase = 'confirm';
                this.deadline = now + SCREEN_TICKS;
                this.settled = '';
            } else if (screen !== 'select') {
                return this.end(bot, 'declined');
            } else {
                return this.tickSelect(bot, partner, now);
            }
        }

        if (this.phase === 'confirm') {
            if (screen === null) {
                if (status >= DuelStatus.CONFIRM && status <= DuelStatus.START) {
                    // both accepted: 274 jumps both into an arena now (duel_arena_prepare_start), seen by anyone near
                    this.phase = 'arena';
                    this.deadline = now + START_TICKS;
                    noteMove(bot, 'duel');
                    return null;
                }
                return this.end(bot, 'declined');
            }
            if (screen !== 'confirm') return this.end(bot, 'declined');
            if (!partner) return this.end(bot, 'gone');
            if (now >= this.deadline) return this.end(bot, 'timeout');
            // (the offers and rules cannot change here in 274; a deal that does not hold is never accepted)
            const theirs = offerKey(duelInv(partner, 'offer'));
            if (!this.agreed || theirs !== this.agreed.theirs || duelOptions(bot) !== this.agreed.rules || !offerIs(duelInv(bot, 'offer'), this.agreed.stake)) return this.end(bot, 'refused');
            this.acceptWhenRead(bot, now, 'confirm', 'duel_confirm:accept', DuelStatus.PENDING_CONFIRM);
            return null;
        }

        if (this.phase === 'arena') {
            if (inFightZone(bot.x, bot.z, bot.level)) this.wasInArena = true;
            if (status === DuelStatus.START) {
                this.phase = 'fight';
                this.facts.fightAt = now;
                this.facts.stake = this.agreed?.stake ?? 0;
                this.facts.rules = this.agreed?.rules ?? 0;
                this.packAtFight = packCoins(bot);
                this.deadline = now + FIGHT_TICKS;
                // (FIGHT!: a person's moment, then the click)
                this.attackAt = now + 1 + botReactionTicks(bot, 'notice');
                return null;
            }
            // "All arenas of this type are full!" (a mesbox: clicked away) and the status back to 0: no duel
            if (botContinuePage(bot) || (status === DuelStatus.RESET && !this.wasInArena && now > this.deadline - START_TICKS + 3)) return this.end(bot, 'refused');
            if (now >= this.deadline) return this.end(bot, inFightZone(bot.x, bot.z, bot.level) ? 'draw' : 'refused');
            return null;
        }

        if (this.phase === 'fight') return this.tickFight(bot, partner, now, screen, status);

        // result: the winner reads duel_win a moment and closes it (274 pays the stake out on its close); 274 brings both
        // back to the hospital (duel_finish: the loser's death first), a moment after the fight's end
        if (screen === 'win') {
            if (!this.sawWin) {
                this.sawWin = true;
                this.markReturn(bot, partner);
            }
            if (this.readAt < 0) this.readAt = now + rand(RESULT_READ[0], RESULT_READ[1]);
            if (now >= this.readAt) bot.closeModal();
            return null;
        }
        if (now - this.facts.endedAt < 20 && (inFightZone(bot.x, bot.z, bot.level) || (this.won && !this.sawWin))) return null;
        return this.end(bot, this.won ? 'won' : 'lost');
    }

    /** 274 jumped the duellists back to the hospital (duel_reset_all): seen by anyone near, marked as the duel's (noteMove) */
    private markReturn(bot: Player, partner: Player | null): void {
        noteMove(bot, 'duel');
        if (partner && partner.is_bot === true) noteMove(partner, 'duel');
    }

    /** duel_select_type: the stake, the challenger's rules, the accept once read */
    private tickSelect(bot: Player, partner: Player | null, now: number): DuelOutcome | null {
        if (!partner || duelPartnerVar(bot) !== (partner.uid | 0)) return this.end(bot, 'gone');
        const deal = this.deal!;
        const theirs = duelInv(partner, 'offer');
        const options = duelOptions(bot);
        const key = `${offerKey(theirs)}|${options}|${duelStatus(partner)}`;
        if (key !== this.seen) {
            // every change the other side makes gives them their time on this screen again (a human who changes the deal
            // after the bot accepted: "dont change it lol", now and then)
            if (this.seen !== '' && deal.human && this.acceptedOnce && !this.changeSaid && Math.random() < 0.5) {
                this.changeSaid = true;
                this.voice?.say(bot, 'change');
            }
            this.seen = key;
            this.deadline = now + SCREEN_TICKS;
        }
        if (now >= this.deadline) return this.end(bot, 'timeout');
        if (now < this.actAt) return null;

        // what the bot puts up and whether the screen as it stands is a deal
        let stake: number;
        let ok: boolean;
        if (deal.human) {
            const coins = theirs.get(Items.COINS) ?? 0;
            const items = [...theirs.keys()].some(id => id !== Items.COINS);
            const cap = Math.min(deal.human.cap, packCoins(bot) + (duelInv(bot, 'offer').get(Items.COINS) ?? 0));
            stake = Math.min(coins, cap);
            ok = !items && coins === stake && meleeAllowed(options);
            if (items) this.line(bot, 'items');
            else if (!meleeAllowed(options)) this.line(bot, 'rules');
            else if (coins > cap) this.line(bot, 'max', cap);
        } else {
            // bot against bot: the challenger sets the rules, a toggle at a time (each resets both accepts)
            const want = deal.rules;
            if (options !== want) {
                if (this.challenger) {
                    const diff = options ^ want;
                    let bit = 0;
                    while (bit < RULE_BUTTONS.length && (diff & (1 << bit)) === 0) bit++;
                    if (bit < RULE_BUTTONS.length) interactIfButtonByName(bot, RULE_BUTTONS[bit]);
                    this.actAt = now + 1 + botReactionTicks(bot, 'page');
                }
                this.settled = '';
                return null;
            }
            stake = deal.stake;
            ok = offerIs(theirs, deal.stake);
        }
        if (!setStake(bot, stake)) {
            this.settled = '';
            this.actAt = now + 1 + botReactionTicks(bot, 'page');
            return null;
        }
        if (!ok) {
            this.settled = '';
            return null;
        }
        this.agreed = { stake, rules: options, theirs: offerKey(theirs) };
        this.acceptWhenRead(bot, now, `#${key}`, 'duel_select_type:accept', DuelStatus.PENDING_ACCEPT);
        return null;
    }

    /** the fight: Fight on the opponent, a bite now and then, a rare forfeit; the end from the bot's own state */
    private tickFight(bot: Player, partner: Player | null, now: number, screen: DuelScreen, status: number): DuelOutcome | null {
        const hp = bot.levels[PlayerStat.HITPOINTS];
        const base = Math.max(1, bot.baseLevels[PlayerStat.HITPOINTS]);
        if (hp > 0) this.facts.lowest = Math.min(this.facts.lowest, hp / base);
        // over: the win screen (274 opens it for the winner once both are back), a loss (the status, or the bot back in
        // the hospital without it), a draw (the time limit, an opponent who logged out: 274 resets both)
        if (screen === 'win' || status === DuelStatus.VICTORY || status === DuelStatus.OPPONENT_RESIGNED) {
            this.won = true;
            this.phase = 'result';
            this.facts.endedAt = now;
            return null;
        }
        if (status === DuelStatus.LOST) {
            this.won = false;
            this.phase = 'result';
            this.facts.endedAt = now;
            return null;
        }
        if (!inFightZone(bot.x, bot.z, bot.level)) {
            // back in the hospital with no win screen of its own: lost (the other has the win screen, or the stake is gone),
            // or a draw (274's time limit, an opponent who logged out: the stake back in the pack)
            this.facts.endedAt = now;
            this.markReturn(bot, partner);
            const theyWon = partner !== null && duelScreen(partner) === 'win';
            const stakeBack = (this.agreed?.stake ?? 0) > 0 && packCoins(bot) >= this.packAtFight + (this.agreed?.stake ?? 0);
            if (!theyWon && (partner === null || stakeBack)) return this.end(bot, 'draw');
            this.phase = 'result';
            this.won = false;
            return null;
        }
        if (now >= this.deadline) return null;
        if (hp <= 0 || !partner) return null;
        const rules = this.agreed?.rules ?? 0;

        // a forfeit under way: the trapdoor's Yes
        if (this.forfeitWalk) {
            const r = this.forfeitWalk.tick();
            if (r !== 'walking') this.forfeitWalk = null;
            return null;
        }
        // (now and then a bot gives up a lost fight: its stake goes; never under No Forfeit or No Movement)
        if (this.forfeiter && hp < base * FORFEIT_BELOW && (rules & ((1 << Rule.NO_FORFEIT) | (1 << Rule.NO_MOVEMENT))) === 0 && this.forfeitTries < 2) {
            const theirShare = partner.levels[PlayerStat.HITPOINTS] / Math.max(1, partner.baseLevels[PlayerStat.HITPOINTS]);
            if (theirShare > hp / base) {
                const door = findLocByPrefix(bot.x, bot.z, bot.level, 'arena_trapdoor', 30);
                if (door) {
                    this.forfeitTries++;
                    this.facts.forfeit = true;
                    interactLocOp(bot, door, 1);
                    this.forfeitWalk = walkDialogue(bot, [1], 40);
                    return null;
                }
            }
        }
        // a bite below half its Hitpoints when food is allowed (an eat stops the attack: Fight again after it)
        if ((rules & (1 << Rule.NO_FOOD)) === 0 && hp < base * EAT_BELOW && now >= this.eatAt && carriedFood(bot) > 0 && !bot.delayed) {
            if (eatBestFood(bot)) {
                this.eatAt = now + 3 + botReactionTicks(bot, 'page');
                this.attackAt = now + 2 + botReactionTicks(bot, 'page');
                return null;
            }
        }
        // Fight: at the start, and again a person's moment after its target was lost
        if (bot.target !== partner) {
            if (this.attackAt < 0) this.attackAt = now + botReactionTicks(bot, 'retarget');
            if (now >= this.attackAt && !bot.delayed) {
                interactPlayerOp(bot, partner.slot, 2);
                this.attackAt = -1;
            }
        }
        return null;
    }

    /** a line on the screens (a human's duel), once per kind in a row */
    private line(bot: Player, pool: 'items' | 'rules' | 'max', cap?: number): void {
        const key = pool === 'max' ? `max${cap}` : pool;
        if (this.said === key) return;
        this.said = key;
        this.voice?.say(bot, pool, cap);
    }

    /** accepts the screen `key` once the bot has read it (BotTiming 'trade'): never twice */
    private acceptWhenRead(bot: Player, now: number, key: string, button: string, accepted: number): void {
        if (key !== this.settled) {
            this.settled = key;
            this.acceptAt = now + botReactionTicks(bot, 'trade');
        }
        if (now < this.acceptAt || duelStatus(bot) === accepted) return;
        if (!interactIfButtonByName(bot, button)) return;
        this.acceptedOnce = true;
        if (this.deal?.human && this.said !== 'accept' && Math.random() < 0.3) {
            this.said = 'accept';
            this.voice?.say(bot, 'accept');
        }
    }

    /**
     * Ends the duel: a screen still open is closed (274 tells the other side the bot declined, and gives the stakes back),
     * a win screen too (its close pays out: never left open), and a challenge op still under way dropped.
     */
    end(bot: Player, outcome: DuelOutcome): DuelOutcome {
        const screen = duelScreen(bot);
        if (screen !== null) bot.closeModal();
        if (this.phase === 'request' && bot.target !== null) bot.clearInteraction();
        if (this.facts.endedAt < 0) this.facts.endedAt = World.currentTick;
        this.phase = null;
        this.forfeitWalk = null;
        return outcome;
    }
}

function offerKey(offer: ReadonlyMap<number, number>): string {
    return [...offer].sort((a, b) => a[0] - b[0]).join(';');
}

function near(a: Player, b: Player): boolean {
    return a.level === b.level && Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) <= PARTNER_RANGE;
}
