// port (the variety work, round 2, Track M: members places and minigames, research
// the research): an outing to a far town. Far places scale with N, about 3 bots at
// a time in far towns and minigames at 100 online, a real presence at 250 and 500; port/BotMinigames' hook offers them.
//
// An outing is a long plan (OUTING_MINUTES) at one of the far towns' spots (BotKnowledge OUTING_STEPS: Yanille's ogres
// and watchmen, Karamja's jogres, Burthorpe's soldiers, Rellekka's lobsters, Shilo's river), worked by the skill's own
// task (CombatTask, ThievingTask, FishingTask), walked to with the real boats and fares (BotAction.walkTo's gateways) and,
// for Shilo, the real cart from Brimhaven (Hajedy: his dialogue, 5 % of the coins carried, 274's p_teleport; Vigroy's
// back). This task wraps the skill's: it says where it is going and that it got there now and then (port/BotOutings
// sayMembers: kind 'setpiece', out of H7), keeps the time, and ends:
//   - at its time (OUTING_MINUTES), or when the skill's task is over (no food, no arrows, a full pack with no bank near);
//   - when the skill's task would bank at a bank more than FAR_BANK_TILES from the spot (Burthorpe, Rellekka, the jungle:
//     no bank there in 2004; the next plan banks the load where the bot is going);
//   - leaving Shilo by the cart, its walls' only way out for a bot (the jungle path's gate is the quest's).
// Its name is the skill's kind with ':outing:<key>' after it, so the planner, the chatter and the humanlike runner see a
// fight as a fight (Combat), a thief as a thief.
import {
    BotTask,
    Player,
    walkTo,
    findNpcByName,
    interactNpcOp,
    countItem,
    Items,
    StuckDetector,
    teleportNear,
    nearestBankTo,
    randInt,
    bankInvId,
    InvType,
    edibleFoodIds
} from '#/engine/bot/tasks/BotTaskBase.js';
import { moveItems } from '#/engine/bot/port/BotInventoryCompat.js';
import type { SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import World from '#/engine/World.js';
import { botAnswerDialogue, botScript, interactHeldOp, noteMove } from '#/engine/bot/BotAction.js';
import ObjType from '#/cache/config/ObjType.js';
import { MembersPlaces, SkillProgression, inShilo } from '#/engine/bot/BotKnowledge.js';
import { noteOutingEnd, noteOutingStart, sayMembers } from '#/engine/bot/port/BotOutings.js';
import { buildingAt, climbLeg } from '#/engine/bot/port/BotUpstairs.js';
import { SHILO_FARES_BOTH, shiloCartOut } from '#/engine/bot/port/BotExits.js';

/** how long an outing lasts (world minutes, drawn once) */
export const OUTING_MINUTES: readonly [number, number] = [20, 45];
/** the skill's task banking farther than this from the spot ends the outing (Yanille's bank, 108 from the ogres, is near) */
export const FAR_BANK_TILES = 120;
/** loot cheaper than this (gp) is junk to a fighter far from a bank (dropped as the pack fills) */
const JUNK_COST = 200;
/** Shilo's bank stops an outing makes (then the next full pack ends it) */
const SHILO_BANKS = 3;
/** what a Shilo fisher banks there: the river's catch */
const SHILO_CATCH: ReadonlySet<number> = new Set([Items.RAW_TROUT, Items.RAW_SALMON, Items.RAW_PIKE]);
/** within this of the spot the bot is "there" (its arrival line, now and then) */
const THERE_TILES = 20;
/** a line on setting out, on arriving, on leaving: this often */
const GO_LINE = 0.35;
const THERE_LINE = 0.3;
const LEAVE_LINE = 0.3;

/** (the variety work, round 2, the fixes) every skill's tools (the planner's bank trip keeps them: BotGoalPlanner) */
let toolsMemo: ReadonlySet<number> | null = null;
function progressionTools(): ReadonlySet<number> {
    if (!toolsMemo) {
        const ids = new Set<number>();
        for (const steps of Object.values(SkillProgression)) for (const step of steps ?? []) for (const id of step.toolItemIds) ids.add(id);
        toolsMemo = ids;
    }
    return toolsMemo;
}

/** the outings so far and how they ended (the tests) */
export const outingTaskStats = { begun: 0, arrived: 0, ended: {} as Record<string, number>, carts: 0 };

type Tasked = BotTask & { state?: unknown };

export class OutingTask extends BotTask {
    readonly key: string;
    readonly town: string;
    readonly inner: Tasked;
    private readonly step: SkillStep | null;
    private phase: 'travel' | 'there' | 'leave' | 'done' = 'travel';
    private readonly minutes: number;
    private endsAt = -1;
    private started = false;
    private outcome = 'done';
    private readonly stuck = new StuckDetector(40, 4, 3);
    /** the cart: when it last asked the driver, how often */
    private cartAt = -1000;
    private cartTries = 0;
    /** the last junk it dropped (a moment between drops) */
    private dropAt = -100;
    /** Shilo's bank: its stops so far, and when it clicked the banker */
    private shiloBanks = 0;
    private bankAt = -1;
    /** where the bot was last tick (a ride's p_teleport is marked as the game's move when seen) */
    private lastX = -1;
    private lastZ = -1;
    /** (the variety work, round 2, the fixes) the items the pack held at the outing's start: never junk to drop */
    private readonly ownItems = new Set<number>();

    constructor(key: string, town: string, inner: BotTask, minutes = randInt(OUTING_MINUTES[0], OUTING_MINUTES[1])) {
        super(`${inner.name.split(':')[0]}:outing:${key}`);
        this.key = key;
        this.town = town;
        this.inner = inner as Tasked;
        this.minutes = minutes;
        let step: SkillStep | null = null;
        try {
            step = inner.activityStep();
        } catch {
            step = null;
        }
        this.step = step;
    }

    /** the skill's task's state (the runner's FM1 and the debugger read a task's state) */
    get state(): unknown {
        return this.phase === 'there' || this.phase === 'travel' ? this.inner.state : this.phase;
    }

    override activityStep(): SkillStep | null {
        return this.step;
    }

    shouldRun(player: Player): boolean {
        if (this.phase === 'done' || this.interrupted) return false;
        if (this.phase === 'leave') return true;
        // (on the way to Shilo the skill's task cannot see its spot yet: the cart first)
        if (this._shiloStep() && !inShilo(player.x, player.z)) return true;
        if (this.inner.shouldRun(player)) return true;
        // (the variety work, round 2, the fixes) the skill's task is over (the feathers gone, its Hitpoints low) behind
        // Shilo's walls or upstairs in the watchtower: the outing runs on to its own way out (tick: 'leave'). It ended there,
        // and the next task's walk was rescue-jumped 450+ tiles
        return this.started && this._mustLeave(player);
    }

    /** behind Shilo's walls, or on an upper floor of one of port/BotUpstairs' buildings */
    private _mustLeave(player: Player): boolean {
        return (player.level === 0 && inShilo(player.x, player.z)) || (player.level > 0 && buildingAt(player.x, player.z) !== null);
    }

    isComplete(_player: Player): boolean {
        return this.phase === 'done';
    }

    override interrupt(): void {
        super.interrupt();
        this.inner.interrupt();
        this._end(null, 'interrupted');
    }

    override reset(): void {
        super.reset();
        // (a reset of a task under way, as BotPlayer's switch: its outing is over)
        if (this.started && this.phase !== 'done') this._end(null, 'reset');
        this.inner.reset();
    }

    tick(player: Player): void {
        if (this.interrupted || this.phase === 'done') return;
        const now = World.currentTick;
        this._player = player;
        // (a cart ride's p_teleport, seen in the tick it landed: the game's move, for the humanlike runner (noteMove), as
        // Aubury's teleport is)
        if (this.lastX !== -1 && Math.max(Math.abs(player.x - this.lastX), Math.abs(player.z - this.lastZ)) > 20 && inShilo(player.x, player.z) !== inShilo(this.lastX, this.lastZ)) noteMove(player, 'event');
        this.lastX = player.x;
        this.lastZ = player.z;
        if (!this.started) {
            this.started = true;
            this.endsAt = now + this.minutes * 100;
            const inv = player.getInventory(InvType.INV);
            if (inv) for (let i = 0; i < inv.capacity; i++) if (inv.get(i)) this.ownItems.add(inv.get(i)!.id);
            outingTaskStats.begun++;
            noteOutingStart(player, this.key, this.town, 'outing');
            if (Math.random() < GO_LINE) sayMembers(player, `outing-go-${this.town}`);
        }
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        if (this.phase !== 'leave' && now >= this.endsAt) this._leave(player, 'time');

        if (this.phase === 'leave') {
            // (upstairs, Yanille's watchtower: down its ladder first, never left on a floor the next walk cannot leave)
            if (player.level > 0 && climbLeg(player, [player.x, player.z, 0])) return;
            // (Shilo's walls: the cart back to Brimhaven, then the outing is over; the variety work, round 2, the fixes:
            // BotAction.walkTo's own way out, port/BotExits, the coins from Shilo's bank first when short of the fare)
            if (inShilo(player.x, player.z) && player.level === 0 && shiloCartOut(player)) return;
            this._end(player, this.outcome);
            return;
        }

        // ── travel: the cart into Shilo; else the skill's task walks there itself ──
        if (this._shiloStep() && !inShilo(player.x, player.z)) {
            const r = this._cart(player);
            if (r === 'failed') this._leave(player, 'cart');
            return;
        }

        if (this.phase === 'travel' && this.step) {
            const [sx, sz, sl] = this.step.location;
            if (player.level === sl && Math.max(Math.abs(player.x - sx), Math.abs(player.z - sz)) <= THERE_TILES) {
                this.phase = 'there';
                outingTaskStats.arrived++;
                if (Math.random() < THERE_LINE) sayMembers(player, `outing-there-${this.town}`);
            }
        }

        // ── the skill's own task ──
        if (this.inner.isComplete(player) || this.inner.interrupted || !this.inner.shouldRun(player)) {
            this._leave(player, 'over');
            return;
        }
        // (Shilo's own bank, its bankers by the cart: the catch banked there, then back to the river, as Shilo's fishers did)
        if (this.phase === 'there' && this._banking() && this._shiloStep() && inShilo(player.x, player.z) && this.shiloBanks < SHILO_BANKS) {
            this._shiloBank(player);
            return;
        }
        // (no bank near: the junk of its loot dropped as the pack fills (a jogre's, an Imperial Guard's: the cheap ones),
        // its Drop, one a moment, as 2004's fighters far from a bank did; the fight goes on)
        if (this.phase === 'there' && !this._banking() && this._bankFar(player) && this._dropJunk(player)) return;
        // (its bank is far from here: the outing ends with its load; the next plan banks it on the way)
        if (this.phase === 'there' && this._banking() && this._bankFar(player)) {
            this._leave(player, 'bank');
            return;
        }
        this.inner.tick(player);
    }

    /** with 2 slots or fewer free, the cheapest junk in the pack dropped (its Drop, op 5): true when it dropped one */
    private _dropJunk(player: Player): boolean {
        const inv = player.getInventory(InvType.INV);
        if (!inv || inv.freeSlotCount > 2 || player.delayed || player.target !== null) return false;
        const now = World.currentTick;
        if (now - this.dropAt < randInt(2, 4)) return true;
        const food = new Set(edibleFoodIds());
        // (the variety work, round 2, the fixes) and never what the pack held when it set out, nor a tool of any skill (the
        // planner's bank trip keeps them so: a tinderbox, a hammer or a chisel costs 1 gp, as bones do, and went first)
        const keep = new Set<number>([Items.COINS, ...(this.step?.toolItemIds ?? []), ...this.ownItems]);
        const tools = progressionTools();
        let slot = -1;
        let cheapest = JUNK_COST;
        for (let i = 0; i < inv.capacity; i++) {
            const it = inv.get(i);
            if (!it || food.has(it.id) || keep.has(it.id) || tools.has(it.id)) continue;
            const type = ObjType.get(it.id);
            const name = type.debugname ?? '';
            if (name.startsWith('trail_') || type.stackable || type.wearpos >= 0) continue;
            if (type.cost < cheapest) {
                cheapest = type.cost;
                slot = i;
            }
        }
        if (slot === -1) return false;
        this.dropAt = now;
        interactHeldOp(player, inv, inv.get(slot)!.id, slot, 5);
        return true;
    }

    /** the skill's task is on its way to a bank */
    private _banking(): boolean {
        const s = this.inner.state;
        return s === 'bank_walk' || s === 'bank' || s === 'banking';
    }

    /** the bank the skill's task would walk to (the one nearest the bot) is far from here, or behind Shilo's walls */
    private _bankFar(player: Player): boolean {
        const [bx, bz] = nearestBankTo(player.x, player.z);
        return Math.max(Math.abs(bx - player.x), Math.abs(bz - (player.z >= 6400 ? player.z - 6400 : player.z))) > FAR_BANK_TILES || this._shiloStep();
    }

    /**
     * The catch into Shilo's bank (its bankers, op 3 Bank, as advanceBankWalk's banker), the rest kept; then the fishing
     * again from its start (the skill's task reset: back to the river)
     */
    private _shiloBank(player: Player): void {
        const [bx, bz] = MembersPlaces.SHILO_BANK;
        const now = World.currentTick;
        if (this.bankAt === -1) {
            if (Math.max(Math.abs(player.x - bx), Math.abs(player.z - bz)) > 3) {
                if (!player.hasWaypoints()) walkTo(player, bx, bz, 0);
                return;
            }
            const banker = findNpcByName(player.x, player.z, player.level, 'shilobanker', 8);
            // (the variety work, round 2, the fixes: no banker, no bank: no more stops, and the full pack ends the outing;
            // the catch went into the bank with nobody clicked)
            if (!banker) {
                this.shiloBanks = SHILO_BANKS;
                return;
            }
            interactNpcOp(player, banker, 3);
            this.bankAt = now;
            return;
        }
        if (now - this.bankAt < 3) return;
        const bid = bankInvId();
        const bank = bid === -1 ? null : player.getInventory(bid);
        const inv = player.getInventory(InvType.INV);
        if (bank && inv) {
            for (let slot = 0; slot < inv.capacity; slot++) {
                const item = inv.get(slot);
                if (item && SHILO_CATCH.has(item.id)) moveItems(inv, bank, item.id, inv.getItemCount(item.id));
            }
        }
        if (player.containsModalInterface()) player.closeModal();
        this.bankAt = -1;
        this.shiloBanks++;
        this.cooldown = randInt(2, 6);
        this.inner.reset();
    }

    private _shiloStep(): boolean {
        return this.step?.extra?.shilo === true;
    }

    private _leave(player: Player, outcome: string): void {
        if (this.phase === 'leave' || this.phase === 'done') return;
        this.phase = 'leave';
        this.outcome = outcome;
        this.inner.interrupt();
        if (Math.random() < LEAVE_LINE) sayMembers(player, `outing-leave-${this.town}`);
    }

    private _end(player: Player | null, outcome: string): void {
        if (this.phase === 'done') return;
        this.phase = 'done';
        outingTaskStats.ended[outcome] = (outingTaskStats.ended[outcome] ?? 0) + 1;
        const p = player ?? null;
        if (p) noteOutingEnd(p, outcome);
        else if (this.lastPlayer) noteOutingEnd(this.lastPlayer, outcome);
    }

    private get lastPlayer(): Player | null {
        return this._player;
    }
    private _player: Player | null = null;

    /**
     * Shilo's cart in, the game's way (Hajedy in Brimhaven): to the driver, his dialogue (pages continued, "Yes please"
     * chosen), 274's p_teleport, marked as the game's move for the humanlike runner. 'walking' or 'talking' while under way,
     * 'done' across, 'failed' after a few tries (no driver, no coins). (The variety work, round 2, the fixes: the way back is
     * port/BotExits' shiloCartOut, BotAction.walkTo's own.)
     */
    private _cart(player: Player): 'walking' | 'talking' | 'done' | 'failed' {
        this._player = player;
        if (inShilo(player.x, player.z)) return 'done';
        if (botAnswerDialogue(player, 1) !== null) return 'talking';
        if (player.delayed || botScript(player)) return 'talking';
        const now = World.currentTick;
        const [cx, cz] = MembersPlaces.BRIMHAVEN_CART;
        if (Math.max(Math.abs(player.x - cx), Math.abs(player.z - cz)) > 4 || player.level !== 0) {
            if (!this.stuck.check(player, cx, cz)) walkTo(player, cx, cz, 0);
            else if (this.stuck.desperatelyStuck) {
                teleportNear(player, cx, cz, 0);
                this.stuck.reset();
            } else {
                player.clearWaypoints();
                walkTo(player, cx, cz, 0);
            }
            return 'walking';
        }
        if (now - this.cartAt < 12) return 'talking';
        // (the variety work, round 2, the fixes: the fares of both rides carried, 274's calc_shilocart_cost each way: a ride in
        // with 10 coins carried left none for Vigroy's fare back)
        if (this.cartTries >= 4 || countItem(player, Items.COINS) < SHILO_FARES_BOTH) return 'failed';
        const driver = findNpcByName(player.x, player.z, player.level, 'brimhavencartdriver', 10);
        if (!driver) return 'failed';
        interactNpcOp(player, driver, 1);
        this.cartAt = now;
        this.cartTries++;
        outingTaskStats.carts++;
        return 'talking';
    }
}
