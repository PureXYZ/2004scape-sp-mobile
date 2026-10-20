// port (the realism work, phase 5b, Track P: drop parties and the Seers' Party Room; port/BotParty): a party's host, a
// sub-task (its own task waits, and goes on after). Everything through the game's own clicks:
//
//   F2P drop party   to a bank (the booth), the kit out of it (port/BotParty.withdrawKit: its pack in but its tools, the
//                    piles out), "drop party fally park 5 min!!!" there; the walk to the venue; one or two calls more
//                    over the lead ("dp in 2 min!!!", "drop party at fally park" with wave:), a beckon; then the piles one
//                    every 1-3 ticks with each item's own Drop ([opheld5] ~dropslot: 274 keeps it the host's for 100
//                    ticks), stepping about the 5x5 square; it stays until the last pile has shown for 30 s ("wait for it
//                    lol"), then "thats all lol" and a bow. It never picks anything back up.
//   the Party Room   the Seers' bank, "party at seers party room 3 min!!"; into the room, a call; the chest (Open, then
//                    Deposit: its window, the kit a click a pile, Accept every 8 slots), the lever (Pull: Balloon
//                    Bonanza, its 1,000 coins, Yes: Party Pete must be within 16 tiles, else nothing happens: once more,
//                    then the party is called off, the kit left in the chest as 274 leaves it); a few pops of its own,
//                    1 party in 4 the knights (Nightly Dance, 500 coins), then the goodbye.
//
// Its stage gives the run's phase (announce, build, peak, end). The rescue jump when desperately stuck is today's (unseen,
// refused in a human's sight).
import { BotTask, Player, walkTo, StuckDetector, teleportNear, randInt, advanceBankWalk, humanDelay, InvType } from '#/engine/bot/tasks/BotTaskBase.js';
import Obj from '#/engine/entity/Obj.js';
import type Loc from '#/engine/entity/Loc.js';
import LocType from '#/cache/config/LocType.js';
import ObjType from '#/cache/config/ObjType.js';
import World from '#/engine/World.js';
import { findLocByName, interactHeldOp, interactIfButtonByName, interactLocOp, tilesInSquare } from '#/engine/bot/BotAction.js';
import { botEmote } from '#/engine/bot/port/BotEmote.js';
import { pressInvButtonAll, pressInvButtonExact, walkDialogue, type DialogueWalk } from '#/engine/bot/port/BotScreens.js';
import { releaseStandTile, stepToTile } from '#/engine/bot/port/BotTiles.js';
import type { SetPiecePhase } from '#/engine/bot/port/BotSetPieces.js';
import { chestSlotsFilled, coinsItem, isTool, withdrawKit, type PartyRun } from '#/engine/bot/port/BotParty.js';
import { popStep, type PopState } from '#/engine/bot/tasks/PartyGuestTask.js';

type Stage = 'bank_walk' | 'bank' | 'walk' | 'wait' | 'drop' | 'chest' | 'lever' | 'pop' | 'knights' | 'linger' | 'bye' | 'done';
type ChestStep = 'open' | 'window' | 'deposit' | 'close';

/** the walk to the bank or the venue is given up after this long (ticks) */
const WALK_LIMIT = 900;
/** the host this far from the venue once there (or on another floor) was moved off: the party is off */
const MOVED_OFF = 30;
/** the chest's own window (274's party_drop_chest) and the temp inventory it fills (8 slots an accept) */
const TEMP_SLOTS = 8;

const cheb = (ax: number, az: number, bx: number, bz: number): number => Math.max(Math.abs(ax - bx), Math.abs(az - bz));

export class PartyHostTask extends BotTask {
    readonly run: PartyRun;
    stage: Stage = 'bank_walk';
    /** the world tick BotPlayer last ran it (the run checks the host is still at it) */
    lastTick = World.currentTick;
    private readonly stuck = new StuckDetector(30, 4, 2);
    private walkTicks = 0;
    private arrivedAt = -1;
    private nextFidget = -1;
    private readonly said = new Set<string>();
    /** F2P: whether it dropped on this tile (the next pile a step on, now and then), the piles' objects noted */
    private steppedAfter = true;
    private readonly noted = new Set<Obj>();
    private lingerUntil = -1;
    private byeAt = -1;
    // the Party Room
    private chestStep: ChestStep = 'open';
    private chestTries = 0;
    private dialog: DialogueWalk | null = null;
    private leverTries = 0;
    private coinsBefore = -1;
    private readonly pop: PopState = { target: null, since: -1, pops: 0, max: 0, until: -1, emptySince: -1, nextAt: -1 };
    private knightsDone = false;

    constructor(run: PartyRun) {
        super('PartyHost');
        this.run = run;
    }

    /** the run's phase by its stage: the bank and the walk the announcement, the wait the build-up, the drop the peak */
    get phase(): SetPiecePhase {
        switch (this.stage) {
            case 'bank_walk':
            case 'bank':
            case 'walk':
                return 'announce';
            case 'wait':
                return 'build';
            case 'bye':
                return 'end';
            case 'done':
                return 'done';
            default:
                return 'peak';
        }
    }

    shouldRun(_p: Player): boolean {
        return this.stage !== 'done';
    }

    isComplete(_p: Player): boolean {
        return this.stage === 'done';
    }

    /** the party is over (done or called off): the host goes back to its own task */
    finish(): void {
        if (this.stage === 'done') return;
        this.stage = 'done';
        releaseStandTile(this.run.host);
        if (this.run.host.modalMain !== -1) this.run.host.closeModal();
    }

    override reset(): void {
        // (BotPlayer resets a sub-task as it takes it on, and at a logout: the party's progress stays; its tile goes)
        super.reset();
        releaseStandTile(this.run.host);
    }

    tick(player: Player): void {
        const now = World.currentTick;
        this.lastTick = now;
        if (this.run.phase === 'done') return this.finish();
        // (moved off the venue once there: a random event's teleport, a death: the party is off)
        if (this.arrivedAt >= 0 && this.stage !== 'bye' && this.movedOff(player)) {
            this.run.abort('host moved');
            return;
        }
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        switch (this.stage) {
            case 'bank_walk':
                return this.bankWalk(player);
            case 'bank':
                return this.bank(player);
            case 'walk':
                return this.walkThere(player, now);
            case 'wait':
                return this.wait(player, now);
            case 'drop':
                return this.drop(player, now);
            case 'chest':
                return this.chest(player, now);
            case 'lever':
                return this.lever(player, now, false);
            case 'pop':
                return this.popBalloons(player, now);
            case 'knights':
                return this.lever(player, now, true);
            case 'linger':
                return this.linger(player, now);
            case 'bye':
                if (now >= this.byeAt) this.finish();
                return;
        }
    }

    private line(kind: string, opts: { wave?: boolean } = {}): void {
        if (this.said.has(kind)) return;
        this.said.add(kind);
        this.run.hostLine(kind, opts);
    }

    /** to a bank: the Seers' bank for the Party Room, the nearest for a drop party; the first call at the booth */
    private bankWalk(player: Player): void {
        const v = this.run.venue;
        const result = advanceBankWalk(player, this.stuck, v.bank ? [v.bank[0], v.bank[1], 0] : undefined);
        if (result === 'walk') {
            if (++this.walkTicks > WALK_LIMIT) this.run.abort('host stuck');
            return;
        }
        this.walkTicks = 0;
        this.cooldown = result === 'ready' ? humanDelay(player, 'bank') : 1;
        this.stage = 'bank';
        this.line(`call-first-${v.key}`);
    }

    private bank(player: Player): void {
        const kit = withdrawKit(player, this.run.kit);
        if (player.modalMain !== -1) player.closeModal();
        if (!kit) {
            this.run.abort('no kit');
            return;
        }
        this.run.kit = kit;
        this.run.record.kitValue = kit.value;
        this.run.record.kitDrops = kit.drops;
        this.stage = 'walk';
        this.stuck.reset();
        this.cooldown = humanDelay(player, 'bank');
    }

    /** where it stands: the drop square's middle, the room's */
    private spot(): [number, number] {
        return this.run.venue.drop;
    }

    private movedOff(player: Player): boolean {
        const [x, z] = this.spot();
        return player.level !== this.run.venue.level || cheb(player.x, player.z, x, z) > MOVED_OFF;
    }

    private walkThere(player: Player, now: number): void {
        const [x, z] = this.spot();
        if (player.level === 0 && cheb(player.x, player.z, x, z) <= 2) {
            player.clearWaypoints();
            this.stage = 'wait';
            this.arrivedAt = now;
            this.nextFidget = now + randInt(20, 60);
            return;
        }
        if (++this.walkTicks > WALK_LIMIT) {
            this.run.abort('host stuck');
            return;
        }
        if (cheb(player.x, player.z, x, z) <= 10) {
            if (!player.hasWaypoints() && !stepToTile(player, x, z)) walkTo(player, x, z);
            return;
        }
        if (!this.stuck.check(player, x, z)) walkTo(player, x, z);
        else if (this.stuck.desperatelyStuck) {
            teleportNear(player, x, z);
            this.stuck.reset();
        } else walkTo(player, player.x + randInt(-5, 5), player.z + randInt(-5, 5));
    }

    /** at the venue until the lead is over: a call or two, a beckon now and then */
    private wait(player: Player, now: number): void {
        const until = Math.max(this.run.dropAt, this.arrivedAt + 30);
        const left = until - now;
        const v = this.run.venue;
        if (left <= 200 && left > 60) this.line(v.kind === 'party_room' ? 'call-soon-party_room' : 'call-soon');
        else if (left <= 90 && v.kind === 'drop_party') this.line(`call-again-${v.key}`, { wave: true });
        if (now >= this.nextFidget && !player.hasWaypoints()) {
            this.nextFidget = now + randInt(60, 160);
            botEmote(player, Math.random() < 0.5 ? 'beckon' : 'wave');
        }
        if (now < until) return;
        if (v.kind === 'drop_party') {
            this.stage = 'drop';
            this.line('call-now');
        } else {
            this.stage = 'chest';
            this.line('call-chest');
        }
    }

    // ── F2P: the drop ─────────────────────────────────────────────────────────────────────────────────────────────

    /** the next pile in the pack (anything but its tools), its slot; -1: none left */
    private nextPile(player: Player): number {
        const inv = player.getInventory(InvType.INV);
        for (let s = 0; inv && s < inv.capacity; s++) {
            const item = inv.get(s);
            if (item && !isTool(item.id)) return s;
        }
        return -1;
    }

    private drop(player: Player, now: number): void {
        if (player.delayed || player.hasWaypoints()) return;
        const inv = player.getInventory(InvType.INV);
        const slot = this.nextPile(player);
        if (!inv || slot === -1) {
            this.run.dropsDone = true;
            this.stage = 'linger';
            this.lingerUntil = Math.max(now + 20, this.run.lastRevealAt + 50);
            return;
        }
        // (a step to a neighbouring tile of the square now and then: the piles spread out)
        if (!this.steppedAfter) {
            this.steppedAfter = true;
            if (Math.random() < 0.6) {
                const tile = this.stepTile(player);
                if (tile && stepToTile(player, tile[0], tile[1])) return;
            }
        }
        const item = inv.get(slot)!;
        if (!interactHeldOp(player, inv, item.id, slot, 5)) return;
        this.steppedAfter = false;
        // (the pile: on the host's tile, its own until 274 shows it)
        const obj = this.ownObjAt(player, item.id);
        if (obj) {
            this.noted.add(obj);
            this.run.noteDrop(obj);
        }
        this.cooldown = randInt(0, 2);
    }

    /** a walkable tile of the drop square next to the host (never its own) */
    private stepTile(player: Player): [number, number] | null {
        const [cx, cz] = this.run.venue.drop;
        const square = tilesInSquare(player.level, cx, cz, 2);
        const near: [number, number][] = [];
        for (const k of square) {
            const x = k >> 14;
            const z = k & 0x3fff;
            if ((x !== player.x || z !== player.z) && cheb(x, z, player.x, player.z) <= 1) near.push([x, z]);
        }
        return near.length ? near[Math.floor(Math.random() * near.length)] : null;
    }

    /** the newest object of this type on the host's tile that is its own (a drop just made) */
    private ownObjAt(player: Player, type: number): Obj | null {
        const zone = World.gameMap.getZone(player.x, player.z, player.level);
        let found: Obj | null = null;
        for (const obj of zone.getAllObjsSafe()) {
            if (obj.x === player.x && obj.z === player.z && obj.type === type && obj.receiver64 === player.hash64 && !this.noted.has(obj)) found = obj;
        }
        return found;
    }

    /** until the last pile has shown for 30 s: a dance, "wait for it lol"; then the goodbye and a bow */
    private linger(player: Player, now: number): void {
        if (this.run.kind === 'drop_party' && this.run.firstRevealAt > now && this.run.firstRevealAt - now < 70) this.line('call-wait');
        if (now >= this.nextFidget && !player.hasWaypoints()) {
            this.nextFidget = now + randInt(40, 120);
            botEmote(player, Math.random() < 0.6 ? 'dance' : 'cheer');
        }
        if (now < this.lingerUntil) return;
        this.line('call-end');
        botEmote(player, 'bow');
        this.stage = 'bye';
        this.byeAt = now + randInt(3, 8);
    }

    // ── the Party Room: the chest, the lever, the balloons ─────────────────────────────────────────────────────────

    /** the chest, shut or open (274's loc_2417, partyroom_chestopen for 300 ticks once opened), the lever */
    private chestLoc(open: boolean): Loc | null {
        const at = this.run.venue.chest;
        if (!at) return null;
        return open ? findLocByName(at[0], at[1], 0, 'partyroom_chestopen', 2) : findLocByName(at[0], at[1], 0, 'loc_2417', 2);
    }

    private leverLoc(): Loc | null {
        const at = this.run.venue.lever;
        return at ? findLocByName(at[0], at[1], 0, 'loc_2416', 2) : null;
    }

    private chest(player: Player, now: number): void {
        const v = this.run.venue;
        const record = this.run.record.chest!;
        if (this.chestStep === 'open') {
            if (this.chestLoc(true)) {
                this.chestStep = 'window';
                return;
            }
            const closed = this.chestLoc(false);
            if (!closed || ++this.chestTries > 6) return this.run.abort('no chest');
            interactLocOp(player, closed, 1);
            this.cooldown = randInt(4, 7);
            return;
        }
        if (this.chestStep === 'window') {
            if (player.modalMain !== -1 && player.modalSide !== -1) {
                if (record.before < 0) record.before = chestSlotsFilled();
                this.chestStep = 'deposit';
                this.cooldown = humanDelay(player, 'page');
                return;
            }
            const open = this.chestLoc(true);
            if (!open) {
                // (it shut meanwhile: open it again)
                this.chestStep = 'open';
                return;
            }
            if (++this.chestTries > 12) return this.run.abort('no chest');
            interactLocOp(player, open, 2);
            this.cooldown = randInt(3, 5);
            return;
        }
        if (this.chestStep === 'deposit') {
            if (player.modalMain === -1) {
                // (the window closed under it: what was not accepted came back to the pack; open it again)
                this.chestStep = 'open';
                return;
            }
            const temp = player.getInventory(InvType.getId('partyroom_tempinv'));
            const used = temp ? TEMP_SLOTS - temp.freeSlotCount : 0;
            const slot = this.nextDeposit(player);
            if (used >= TEMP_SLOTS || (slot === -1 && used > 0)) {
                interactIfButtonByName(player, 'party_drop_chest:com_89');
                this.cooldown = randInt(1, 3);
                return;
            }
            if (slot === -1) {
                this.chestStep = 'close';
                return;
            }
            if (player.delayed) return;
            const inv = player.getInventory(InvType.INV)!;
            const item = inv.get(slot)!;
            const coins = item.id === coinsItem();
            const before = this.carried(player, item.id);
            const ok = coins
                ? pressInvButtonExact(player, 'party_drop_chest_side:inv', 'inv', item.id, Math.min(this.run.kit.coins, item.count - this.run.kit.leverCoins))
                : ObjType.get(item.id).stackable
                  ? pressInvButtonExact(player, 'party_drop_chest_side:inv', 'inv', item.id, item.count)
                  : pressInvButtonAll(player, 'party_drop_chest_side:inv', 'inv', item.id);
            // (refused or not moved: tried again a moment later, left in the pack after three)
            if (!ok || this.carried(player, item.id) === before) {
                const n = (this.depositFails.get(item.id) ?? 0) + 1;
                this.depositFails.set(item.id, n);
                if (n >= 3) this.skipDeposit.add(item.id);
            } else if (coins) this.coinsIn = true;
            this.cooldown = randInt(1, 2);
            return;
        }
        // close: the window shut (anything unaccepted back in the pack), on to the lever
        if (player.modalMain !== -1) player.closeModal();
        record.after = chestSlotsFilled();
        this.stage = 'lever';
        this.cooldown = randInt(2, 4);
        void now;
    }

    /** kit items that could not be deposited (refused three times): left in the pack */
    private readonly skipDeposit = new Set<number>();
    private readonly depositFails = new Map<number, number>();

    private carried(player: Player, id: number): number {
        const inv = player.getInventory(InvType.INV);
        let n = 0;
        for (let s = 0; inv && s < inv.capacity; s++) if (inv.get(s)?.id === id) n += inv.get(s)!.count;
        return n;
    }

    /** the next kit item in the pack to put in the chest (its coins beyond the lever's), its slot; -1: done */
    private nextDeposit(player: Player): number {
        const inv = player.getInventory(InvType.INV);
        const coins = coinsItem();
        for (let s = 0; inv && s < inv.capacity; s++) {
            const item = inv.get(s);
            if (!item || isTool(item.id) || this.skipDeposit.has(item.id)) continue;
            if (item.id === coins) {
                if (this.run.kit.coins > 0 && item.count > this.run.kit.leverCoins && !this.coinsIn) return s;
                continue;
            }
            return s;
        }
        return -1;
    }

    private coinsIn = false;

    private coinsCarried(player: Player): number {
        const inv = player.getInventory(InvType.INV);
        let n = 0;
        for (let s = 0; inv && s < inv.capacity; s++) if (inv.get(s)?.id === coinsItem()) n += inv.get(s)!.count;
        return n;
    }

    /** the lever: Balloon Bonanza (1,000 coins), or the knights' Nightly Dance (500); Party Pete must be near */
    private lever(player: Player, now: number, knights: boolean): void {
        if (!this.dialog) {
            const lever = this.leverLoc();
            if (!lever) return this.run.abort('no lever');
            this.coinsBefore = this.coinsCarried(player);
            interactLocOp(player, lever, 1);
            this.dialog = walkDialogue(player, knights ? [2, 1, 1] : [1, 1, 1], 25);
            return;
        }
        const st = this.dialog.tick();
        if (st === 'walking') return;
        this.dialog = null;
        const paid = this.coinsBefore - this.coinsCarried(player);
        if (knights) {
            if (paid >= 500) {
                this.run.record.knights = true;
                this.line('call-knights');
            }
            this.knightsDone = true;
            this.stage = 'linger';
            this.lingerUntil = now + randInt(60, 120);
            return;
        }
        if (paid >= 1000) {
            this.run.record.lever = true;
            this.run.balloonsAt = now;
            this.run.dropsDone = true;
            this.line('call-lever');
            this.stage = 'pop';
            // (8-20; the more with fewer guests)
            this.pop.max = randInt(Math.min(20, 8 + 3 * Math.max(0, 4 - this.run.guests.size)), 20);
            this.pop.until = now + 360;
            this.cooldown = randInt(4, 10);
            return;
        }
        // (no pull: Party Pete is not within 16 tiles, or a page was not answered; a moment, then once more)
        if (++this.leverTries < 2) {
            this.cooldown = randInt(10, 20);
            return;
        }
        this.run.abort('no pete');
    }

    private popBalloons(player: Player, now: number): void {
        if (this.pop.pops === 1) this.line('call-pop');
        const r = popStep(player, this.run, this.pop, now);
        if (r === 'popped') this.run.record.pops.host++;
        if (r !== 'over') return;
        if (this.run.kit.knights && !this.knightsDone) {
            this.stage = 'knights';
            this.cooldown = randInt(3, 8);
            return;
        }
        this.stage = 'linger';
        this.lingerUntil = now + randInt(30, 80);
    }
}

/** (the tests) the loc's debugname */
export function locName(loc: Loc): string {
    return LocType.get(loc.type).debugname ?? '';
}
