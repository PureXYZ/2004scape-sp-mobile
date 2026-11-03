// port (the bots ideas work, round 1, Track B: loot): a bot at the human's death pile, as a
// sub-task that holds its own task meanwhile (BotPlayer.setSubTask; port/BotLoot starts it).
//
//   killer   the bot that killed the human (or whose client sees the pile's private items at the drop): it goes next
//            to the pile, and from the drop takes what it sees, the most valuable stack first (ties at random), each a
//            real Take (op 3) a person's click apart ('page'), skipping stacks under 50 gp, until 40 ticks past the drop
//            (long before the reveal: the leftovers are the vultures'). A full pack and a stack worth 1,000 gp or more: a
//            bite of its own food for room (at most 4 a pile, never with an attacker; never one of the human's), and
//            never a drop. Nothing to see 15 ticks after the death: it was not the hero, done. Then one line, "ty for the
//            {item}" (45 %, 5k or more taken) or "no loot? lol" (50 %, a pile under 2k).
//   vulture  a bot of the trait near the death (port/BotLoot enrolVultures): a PvP pile it cannot see yet (274: the
//            hero's for 100 ticks) it waits out on a tile of its own 2-4 off it, facing it ("w8 for it", the first
//            waiter), watching from 5 ticks before the reveal a client expects from the death, and rushes at the first
//            item it sees, a moment later ('notice'): the most valuable of the top three (weighted, so two vultures do
//            not always click the same), a click apart, items of 30 gp or more, 30 ticks or a full pack; nothing 15
//            ticks past the reveal: the killer took it all ("aw he took it all"). An NPC death's pile is public at once:
//            a looter a moment and 3-10 ticks on, a picker a minute and more on (60-100 ticks), and not with the owner
//            within 3 tiles. "yoink" after its first take. A bot that is not a PKer with 2k or more, or 3 stacks, banks
//            them at the nearest bank (LeaveBankTask, its task's keep list) before its task goes on; a PKer's ledger is
//            its PK task's to bank.
// Attacked by a player: it is over (the pile is left for the reveal: a PJer jumping a looter is 2004); a vulture hurt below
// half too. (bots ideas, round 1, the fixes: B2) a killer hurt below half loots all the same, as a player did, with a
// bite of its own food while it waits for the drop (its PK task, held meanwhile, would have eaten). A pile it cannot
// reach (water, a fence) is given up after 10 ticks without progress. Every click is a client's (interactObjOp,
// interactHeldOp); the engine decides who gets an item. (B1) a click still out when it ends, however it ends, is settled:
// a take that landed is noted (the ledger: else the PKer's restock deleted the human's item), and its interaction goes, so
// none lands after.
import Player from '#/engine/entity/Player.js';
import type Obj from '#/engine/entity/Obj.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import InvType from '#/cache/config/InvType.js';
import World from '#/engine/World.js';
import { BotTask, randInt, walkTo, FOOD_IDS, advanceBankWalk, bankInvId, StuckDetector } from '#/engine/bot/tasks/BotTaskBase.js';
import { LeaveBankTask } from '#/engine/bot/tasks/UtilTasks.js';
import { interactHeldOp, interactObjOp, objInReach } from '#/engine/bot/BotAction.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { keepIds } from '#/engine/bot/port/BotHabits.js';
import { worldPlayers } from '#/engine/bot/port/BotPlayers.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import { roomFor } from '#/engine/bot/port/BotInventoryCompat.js';
import { claimStandTile, releaseStandTile } from '#/engine/bot/port/BotTiles.js';
import { botPersona, reactionTicks } from '#/engine/bot/port/BotTiming.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { bankLoot, ledgerKeep, logLoot, lootSay, noteMissed, noteTake, pileValue, pileView, sayLootLine, tellLoot, valueOf, REVEAL_AFTER, DROP_AFTER, type Pile, type VultureTrait } from '#/engine/bot/port/BotLoot.js';
import { lootTasks } from '#/engine/bot/port/BotLootFactory.js';

/** the killer: nothing it sees by this long after the death, it was not the hero; its takes end this long after the drop */
const KILLER_LOOK = 15;
const KILLER_TAKES = 40;
/** the killer skips stacks under this; a vulture under this */
const KILLER_FLOOR = 50;
const VULTURE_FLOOR = 30;
/** a bite for room: for a stack worth this much, at most this many a pile */
const BITE_FOR = 1000;
const BITES = 4;
/** the killer's lines: a loot line for this much taken (chance), a junk line for a pile under this (chance) */
const LOOT_LINE_FOR = 5000;
const LOOT_LINE = 0.45;
const JUNK_PILE = 2000;
const JUNK_LINE = 0.5;
const FULL_LINE = 0.25;
/** a vulture: its wait tile's distance from the pile, its watch before the expected reveal, its rush, its give-up */
const WAIT_NEAR = 2;
const WAIT_FAR = 4;
const WATCH_BEFORE = 5;
const RUSH_TICKS = 30;
const GIVE_UP_AFTER = 15;
/** an NPC death's pile: a looter after a moment and this; a picker after this (the 2004 minute's courtesy), not with the owner this near */
const LOOTER_WAIT: [number, number] = [3, 10];
const PICKER_WAIT: [number, number] = [60, 100];
const OWNER_NEAR = 3;
/** the vultures' lines: the first waiter's, the first at an NPC pile's, after a take, after nothing */
const WAIT_LINE = 0.35;
const NPC_LINE = 0.3;
const TAKE_LINE = 0.4;
const MISS_LINE = 0.5;
/** a vulture that is not a PKer banks this much, or this many stacks */
const BANK_FOR = 2000;
const BANK_STACKS = 3;
/** at most this long at the bank */
const BANK_TICKS = 900;
/** no step nearer the item this long: unreachable */
const STALL_TICKS = 10;

type Phase = 'go' | 'wait' | 'watch' | 'rush' | 'bank' | 'done';

/** a click on an item, waiting for the game's answer: the item, its type, how many the pack held, when */
interface Click {
    obj: Obj;
    type: number;
    held: number;
    at: number;
}

/** a player attacking it: not the pile's dead human (its attack stays set through its death), nor anyone at 0 Hitpoints */
function attackedBy(player: Player, pile: Pile): boolean {
    for (const p of worldPlayers()) {
        if (p === player || p === pile.human || p.slot === -1 || p.target !== player || p.levels[PlayerStat.HITPOINTS] <= 0) continue;
        if (p.targetOp === ServerTriggerType.APPLAYER2 || p.targetOp === ServerTriggerType.OPPLAYER2) return true;
    }
    return false;
}

export class LootPileTask extends BotTask {
    readonly pile: Pile;
    readonly role: 'killer' | 'vulture';
    readonly trait: VultureTrait;
    private phase: Phase = 'go';
    private click: Click | null = null;
    /** the next click's tick; the rush's start and end */
    private nextAt = 0;
    private rushFrom = -1;
    private rushUntil = -1;
    /** a PvP pile (nothing seen at the drop) or an NPC's (seen at once); null: not known yet */
    private pvp: boolean | null = null;
    private takes = 0;
    private taken = 0;
    private best: { id: number; value: number } | null = null;
    private bites = 0;
    /** (bots ideas, round 1, the fixes: B2) the killer's bite while it waits for the drop, hurt */
    private healed = false;
    private fullSaid = false;
    private skip = new Set<Obj>();
    private stall = { d: Infinity, since: 0 };
    private wait: [number, number] | null = null;
    private arrived = false;
    private bank: LeaveBankTask | null = null;
    private bankSince = 0;
    private seenAt = -1;
    /** its Wilderness level when it was asked (a bot that is not a PKer goes no deeper) */
    private readonly wildMax: number;
    private readonly pker: boolean;
    private readonly bot: Player;

    constructor(pile: Pile, role: 'killer' | 'vulture', trait: VultureTrait, bot: Player) {
        super(role === 'killer' ? 'LootPile:killer' : 'LootPile:vulture');
        this.pile = pile;
        this.role = role;
        this.trait = trait;
        this.bot = bot;
        this.wildMax = wildernessLevelAt(bot.x, bot.z);
        this.pker = bot.botPlanner === 'extras_pker' || bot.botPlanner === 'extras_edgeville_pker';
    }

    shouldRun(_p: Player): boolean {
        return this.phase !== 'done';
    }

    isComplete(_p: Player): boolean {
        return this.phase === 'done';
    }

    override interrupt(): void {
        super.interrupt();
        this._settle(this.bot);
        this.phase = 'done';
        releaseStandTile(this.bot);
    }

    override reset(): void {
        super.reset();
        // (its click settled, its wait tile given back: a logout's wind-down resets the sub-task)
        this._settle(this.bot);
        if (this.phase === 'done' || this.bot.slot === -1) releaseStandTile(this.bot);
    }

    tick(player: Player): void {
        if (this.phase === 'done') return;
        const now = World.currentTick;
        const pile = this.pile;
        if (this.phase === 'bank') return this._bank(player, now);
        // (attacked by a player, or a vulture hurt: over; the pile's end; a bot gone far or off its floor. The killer loots
        // hurt: bots ideas, round 1, the fixes: B2, "full 2004 loot": a human that fought back could leave its killer under
        // half, which gave the pile up on its first tick, to the vultures at the reveal)
        const hurt = this.role === 'vulture' && player.levels[PlayerStat.HITPOINTS] * 2 < player.baseLevels[PlayerStat.HITPOINTS];
        const attacked = attackedBy(player, pile);
        if (attacked || hurt || now > pile.goneAt || player.level !== pile.level || Math.max(Math.abs(player.x - pile.x), Math.abs(player.z - pile.z)) > 25) return this._end(player, now, attacked ? 'attacked' : hurt ? 'hurt' : 'gone');
        if (this.click) {
            this._answer(player, now);
            if (this.click) return;
        }
        if (this.role === 'killer') this._killer(player, now);
        else this._vulture(player, now);
    }

    // ── the killer ─────────────────────────────────────────────────────────────────────────────────────────────────

    private _killer(player: Player, now: number): void {
        const pile = this.pile;
        const view = pile.dropAt !== null ? pileView(player, pile) : [];
        if (view.length && this.seenAt < 0) {
            this.seenAt = now;
            logLoot({ t: now, pile: pile.id, kind: 'visible', who: player.username, role: 'killer' });
            this.nextAt = now + 1 + reactionTicks(botPersona(player), 'notice');
        }
        if (this.seenAt < 0) {
            // (to the pile meanwhile; nothing for it to see: it was not the hero)
            if (now > pile.diedAt + KILLER_LOOK) return this._end(player, now, 'not-hero');
            // (bots ideas, round 1, the fixes: B2) hurt below half: a bite of its own food meanwhile, once
            if (!this.healed && player.levels[PlayerStat.HITPOINTS] * 2 < player.baseLevels[PlayerStat.HITPOINTS]) this._heal(player, now);
            if (Math.max(Math.abs(player.x - pile.x), Math.abs(player.z - pile.z)) > 1 && !player.hasWaypoints()) walkTo(player, pile.x, pile.z);
            return;
        }
        if (pile.dropAt !== null && now > pile.dropAt + KILLER_TAKES) return this._end(player, now, 'time');
        if (now < this.nextAt) return;
        const next = view.find(o => !this.skip.has(o) && valueOf(o.type, o.count) >= KILLER_FLOOR);
        if (!next) return this._end(player, now, 'taken');
        this._takeOrMakeRoom(player, now, next, view);
    }

    /** a take of `obj`, or (a full pack) a bite for room, or the item skipped */
    private _takeOrMakeRoom(player: Player, now: number, obj: Obj, view: Obj[]): void {
        const inv = player.getInventory(InvType.INV);
        if (!inv) return this._end(player, now, 'no-pack');
        if (roomFor(inv, obj.type) <= 0) {
            const worth = valueOf(obj.type, obj.count);
            const slot = this.role === 'killer' && worth >= BITE_FOR && this.bites < BITES ? this._foodSlot(player) : -1;
            if (slot >= 0) {
                const id = inv.get(slot)!.id;
                if (interactHeldOp(player, inv, id, slot, 1)) {
                    this.bites++;
                    logLoot({ t: now, pile: this.pile.id, kind: 'eat', who: player.username, item: id });
                    if (!this.fullSaid && Math.random() < FULL_LINE) {
                        this.fullSaid = true;
                        sayLootLine(player, 'pk-full', { pile: this.pile, kind: 'pk' });
                    }
                }
                this.nextAt = now + 3 + reactionTicks(botPersona(player), 'page');
                return;
            }
            this.skip.add(obj);
            // (nothing else it could take either: done)
            if (view.every(o => this.skip.has(o) || roomFor(inv, o.type) <= 0)) return this._end(player, now, 'full');
            return;
        }
        if (!objInReach(player, obj)) {
            this.skip.add(obj);
            return;
        }
        this.click = { obj, type: obj.type, held: inv.getItemCount(obj.type), at: now };
        this.stall = { d: Infinity, since: now };
        interactObjOp(player, obj, 3);
    }

    /** (bots ideas, round 1, the fixes: B2) the killer hurt: a bite of its own food while it waits for the drop */
    private _heal(player: Player, now: number): void {
        const slot = this._foodSlot(player);
        const inv = player.getInventory(InvType.INV);
        if (slot < 0 || !inv) return;
        const id = inv.get(slot)!.id;
        if (!interactHeldOp(player, inv, id, slot, 1)) return;
        this.healed = true;
        logLoot({ t: now, pile: this.pile.id, kind: 'eat', who: player.username, role: 'hurt', item: id });
    }

    /** a slot of its own food (never one the human's items in its ledger hold), or -1 */
    private _foodSlot(player: Player): number {
        const inv = player.getInventory(InvType.INV);
        if (!inv || player.delayed) return -1;
        for (let slot = 0; slot < inv.capacity; slot++) {
            const it = inv.get(slot);
            if (!it || !FOOD_IDS.includes(it.id)) continue;
            if (inv.getItemCount(it.id) <= ledgerKeep(player, it.id)) continue;
            return slot;
        }
        return -1;
    }

    /** the game's answer to its last click: the item in its pack (a take), gone to another (a race), or not reached */
    private _answer(player: Player, now: number): void {
        const c = this.click!;
        const inv = player.getInventory(InvType.INV);
        const held = inv?.getItemCount(c.type) ?? 0;
        if (held > c.held) {
            this.click = null;
            this._took(player, c, held - c.held);
            this.nextAt = now + 1 + reactionTicks(botPersona(player), 'page');
            return;
        }
        if (!c.obj.isActive || c.obj.count <= 0) {
            if (now - c.at < 2) return;
            this.click = null;
            noteMissed(this.pile, c.obj, player);
            this.nextAt = now + 1 + reactionTicks(botPersona(player), 'page');
            return;
        }
        // (no nearer for a while: the item is out of reach; a click dropped: again)
        const d = Math.max(Math.abs(player.x - c.obj.x), Math.abs(player.z - c.obj.z));
        if (d < this.stall.d) this.stall = { d, since: now };
        if (now - this.stall.since > STALL_TICKS) {
            this.click = null;
            this.skip.add(c.obj);
            logLoot({ t: now, pile: this.pile.id, kind: 'giveup', who: player.username, role: 'unreachable', item: c.type });
            return;
        }
        if (now - c.at >= 4 && player.target !== c.obj && !player.hasWaypoints()) {
            c.at = now;
            interactObjOp(player, c.obj, 3);
        }
    }

    /** a take of the click's item seen in its pack: noted (the log, a PKer's ledger), counted for its lines */
    private _took(player: Player, c: Click, count: number): void {
        noteTake(this.pile, c.obj, player, count, this.role);
        this.takes++;
        const v = valueOf(c.type, count);
        this.taken += v;
        if (!this.best || v > this.best.value) this.best = { id: c.type, value: v };
    }

    /**
     * (bots ideas, round 1, the fixes: B1) its click at its end, however it ends (attacked, the pile gone, interrupted, a
     * wind-down): a take that landed is noted (a PKer's ledger: its next restock deleted an unnoted item of the human's),
     * and the click's interaction and walk dropped, so no take lands after it stopped watching
     */
    private _settle(player: Player): void {
        const c = this.click;
        if (!c) return;
        this.click = null;
        const held = player.getInventory(InvType.INV)?.getItemCount(c.type) ?? 0;
        if (held > c.held) this._took(player, c, held - c.held);
        if (player.target === c.obj) {
            player.clearPendingAction();
            player.clearWaypoints();
        }
    }

    // ── the vulture ────────────────────────────────────────────────────────────────────────────────────────────────

    private _vulture(player: Player, now: number): void {
        const pile = this.pile;
        // (the client's guess from the death: the drop 7 ticks on, the reveal 100 after)
        const expectedReveal = pile.diedAt + DROP_AFTER + REVEAL_AFTER;
        if (pile.dropAt === null) {
            if (now > pile.diedAt + 30) return this._end(player, now, 'no-drop');
            return this._goWait(player, now);
        }
        if (this.pvp === null && now >= pile.dropAt + 1) {
            // what its client shows a tick after the drop: items (an NPC death: public at once), or nothing (a PvP death)
            const view = pileView(player, pile);
            this.pvp = view.length === 0;
            if (!this.pvp) {
                this.seenAt = now;
                logLoot({ t: now, pile: pile.id, kind: 'visible', who: player.username, role: 'vulture' });
                const persona = botPersona(player);
                this.rushFrom = this.trait === 'picker' ? now + randInt(...PICKER_WAIT) : now + reactionTicks(persona, 'notice') + randInt(...LOOTER_WAIT);
            }
        }
        if (this.pvp === null) return this._goWait(player, now);
        if (this.pvp) return this._pvp(player, now, expectedReveal);
        return this._npc(player, now);
    }

    /** to a tile of its own 2-4 off the pile, facing it; the first waiter's word */
    private _goWait(player: Player, now: number): void {
        const pile = this.pile;
        if (!this.wait) {
            const deeper = (x: number, z: number): boolean => !this.pker && wildernessLevelAt(x, z) > this.wildMax;
            this.wait = claimStandTile(player, pile.x, pile.z, pile.level, WAIT_FAR, (x, z) => Math.max(Math.abs(x - pile.x), Math.abs(z - pile.z)) >= WAIT_NEAR && !deeper(x, z)) ?? [player.x, player.z];
        }
        const [wx, wz] = this.wait;
        if ((player.x !== wx || player.z !== wz) && !player.hasWaypoints()) walkTo(player, wx, wz);
        if (player.x === wx && player.z === wz) {
            player.faceSquare(pile.x, pile.z);
            if (!this.arrived) {
                this.arrived = true;
                if (!pile.waitSaid && pile.pvp) {
                    pile.waitSaid = true;
                    if (Math.random() < WAIT_LINE) sayLootLine(player, 'vulture-wait', { pile });
                }
            }
        }
        void now;
    }

    /** a PvP pile: wait, watch from the expected reveal less 5, rush at the first item seen; nothing 15 past it: a miss */
    private _pvp(player: Player, now: number, expectedReveal: number): void {
        if (this.rushFrom < 0) {
            if (now < expectedReveal - WATCH_BEFORE) return this._goWait(player, now);
            const view = pileView(player, this.pile);
            if (view.length > 0) {
                this.seenAt = now;
                logLoot({ t: now, pile: this.pile.id, kind: 'visible', who: player.username, role: 'vulture' });
                // (a picker, polite: a while later)
                this.rushFrom = now + reactionTicks(botPersona(player), 'notice') + (this.trait === 'picker' ? randInt(10, 30) : 0);
                return;
            }
            if (now > expectedReveal + GIVE_UP_AFTER) return this._end(player, now, 'nothing');
            return this._goWait(player, now);
        }
        this._rush(player, now);
    }

    /** an NPC death's pile: at the pile (its first word), then its rush at its time; a picker not with the owner near */
    private _npc(player: Player, now: number): void {
        const pile = this.pile;
        if (now < this.rushFrom) {
            // (a looter goes to the pile; a picker waits where it is)
            if (this.trait === 'looter' && Math.max(Math.abs(player.x - pile.x), Math.abs(player.z - pile.z)) > 1 && !player.hasWaypoints()) walkTo(player, pile.x, pile.z);
            if (!this.arrived && Math.max(Math.abs(player.x - pile.x), Math.abs(player.z - pile.z)) <= 2) {
                this.arrived = true;
                if (!pile.npcSaid) {
                    pile.npcSaid = true;
                    if (Math.random() < NPC_LINE) sayLootLine(player, 'vulture-npc', { pile });
                }
            }
            return;
        }
        if (this.rushUntil < 0 && this.trait === 'picker') {
            const owner = pile.human;
            if (owner.slot !== -1 && owner.level === pile.level && Math.max(Math.abs(owner.x - pile.x), Math.abs(owner.z - pile.z)) <= OWNER_NEAR) return this._end(player, now, 'owner-near');
        }
        this._rush(player, now);
    }

    /** the rush: the most valuable of the top three it sees (weighted), a click apart, 30 ticks or a full pack */
    private _rush(player: Player, now: number): void {
        if (now < this.rushFrom) return;
        if (this.rushUntil < 0) {
            this.rushUntil = now + RUSH_TICKS;
            releaseStandTile(player);
        }
        if (now > this.rushUntil) return this._end(player, now, 'time');
        if (now < this.nextAt) return;
        const view = pileView(player, this.pile).filter(o => !this.skip.has(o) && valueOf(o.type, o.count) >= VULTURE_FLOOR);
        if (view.length === 0) return this._end(player, now, this.takes > 0 ? 'taken' : 'nothing');
        const top = view.slice(0, 3);
        const weights = [0.55, 0.3, 0.15].slice(0, top.length);
        let roll = Math.random() * weights.reduce((a, b) => a + b, 0);
        let pick = top[0];
        for (let i = 0; i < top.length; i++) {
            roll -= weights[i];
            if (roll <= 0) {
                pick = top[i];
                break;
            }
        }
        const inv = player.getInventory(InvType.INV);
        if (inv && view.every(o => roomFor(inv, o.type) <= 0)) return this._end(player, now, 'full');
        if (inv && roomFor(inv, pick.type) <= 0) pick = view.find(o => roomFor(inv, o.type) > 0)!;
        this._takeOrMakeRoom(player, now, pick, view);
    }

    // ── the end ────────────────────────────────────────────────────────────────────────────────────────────────────

    private _end(player: Player, now: number, why: string): void {
        if (this.phase === 'done' || this.phase === 'bank') return;
        this._settle(player);
        releaseStandTile(player);
        const pile = this.pile;
        if (this.takes === 0 && why !== 'taken') logLoot({ t: now, pile: pile.id, kind: 'giveup', who: player.username, role: why });
        if (this.role === 'killer') {
            if (why !== 'not-hero') {
                // (one line besides the kill line: the loot, or the junk)
                if (this.taken >= LOOT_LINE_FOR && Math.random() < LOOT_LINE) sayLootLine(player, 'pk-loot', { pile, item: this.best ? lootSay(this.best.id) : null, kind: 'pk' });
                else if (pileValue(pile) < JUNK_PILE && pile.objs.length > 0 && Math.random() < JUNK_LINE) sayLootLine(player, 'pk-junk', { pile, kind: 'pk' });
                tellLoot({ bot: player, value: this.taken, kind: 'killer' });
            }
            this.phase = 'done';
            return;
        }
        if (why === 'attacked' || why === 'hurt' || why === 'owner-near' || why === 'no-drop' || why === 'gone') {
            this.phase = 'done';
            return;
        }
        if (this.takes > 0) {
            if (Math.random() < TAKE_LINE) sayLootLine(player, 'vulture-take', { pile, item: this.best ? lootSay(this.best.id) : null });
            tellLoot({ bot: player, value: this.taken, kind: 'vulture' });
        } else {
            if (Math.random() < MISS_LINE) sayLootLine(player, 'vulture-miss', { pile });
            tellLoot({ bot: player, value: 0, kind: 'missed' });
        }
        // (the human's items to the bank: a bot that is not a PKer, a good take; a PKer's ledger is its PK task's)
        const ai = BotManager.botFor(player);
        if (!this.pker && ai && (this.taken >= BANK_FOR || this.takes >= BANK_STACKS)) {
            this.bank = new LeaveBankTask(keepIds(ai));
            this.bankSince = now;
            this.phase = 'bank';
            return;
        }
        this.phase = 'done';
    }

    private _bank(player: Player, now: number): void {
        const bank = this.bank!;
        bank.tick(player);
        if (bank.banked || now - this.bankSince > BANK_TICKS || attackedBy(player, this.pile)) {
            if (bank.banked) logLoot({ t: now, pile: this.pile.id, kind: 'bank', who: player.username, role: 'vulture', count: this.takes, value: this.taken });
            this.phase = 'done';
        }
    }
}

// ── the PKers' booth (both PK tasks, at the Edgeville bank) ───────────────────────────────────────────────────────────

/** the longest a PKer's stop at the booth takes before it banks where it stands (the library's direct deposit) */
const BOOTH_TICKS = 400;

/**
 * (the PK tasks' bank trip, at the bank: port/BotLoot needsBooth) the booth as a gatherer uses it (BotTaskBase
 * advanceBankWalk: the booth's Use-quickly, else a banker), then the ledger's quantities into the bank (port/BotLoot
 * bankLoot), before its restock. 'walk' until it is done.
 */
export class LootBooth {
    private readonly stuck = new StuckDetector(30, 4, 2);
    private state: 'walk' | 'wait' | 'done' = 'walk';
    private waitUntil = 0;
    private readonly since = World.currentTick;

    tick(player: Player): 'walk' | 'done' {
        const now = World.currentTick;
        if (this.state === 'done') return 'done';
        if (this.state === 'walk') {
            if (now - this.since <= BOOTH_TICKS) {
                const step = advanceBankWalk(player, this.stuck);
                if (step === 'walk') return 'walk';
                this.waitUntil = now + (step === 'ready' ? 2 : 0);
            }
            this.state = 'wait';
        }
        if (now < this.waitUntil) return 'walk';
        const bid = bankInvId();
        bankLoot(player, bid === -1 ? null : player.getInventory(bid));
        this.state = 'done';
        return 'done';
    }
}

// (port/BotLoot asks port/BotLootFactory for its sub-tasks: it loads no task class itself, so nothing it imports early
// meets a task class half made)
lootTasks.make = (pile, role, trait, bot) => new LootPileTask(pile, role, trait, bot);
