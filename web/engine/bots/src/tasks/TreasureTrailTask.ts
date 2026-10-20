// port (the variety work, round 2, Track M: members places and minigames; "a Treasure Trail" extra, the plan's
// "a clue scroll from a real drop, then walking, digging with a spade, talking and emotes, and the casket's real reward if
// 274 runs it for a bot"): a bot follows an easy clue scroll it got from a kill (274's own drop tables; CombatTask picks it
// up with its loot) through 274's game_trail, by the real clicks:
//   - the clue from its bank first when it banked it; read (its Read: the clue's window, a moment, closed);
//   - each step as the clue says (port/BotClues, from the game's own data): walked to, then dug with a spade (274's
//     opheld1 spade: the casket), searched (the crate, drawers, chest or boxes at the clue's coord: their Search), or
//     the named NPC talked to (their scripts take the clue and give the next one);
//   - each casket opened (274's opheld1: the next clue, or the trail's end and its reward, 274's own roll: black
//     trimmed, wizard trimmed, a highwayman mask, a beret, coins ...: earned through play);
//   - a spade from a spawn on the way when it has none (Falador's park, Draynor Manor's garden, East Ardougne: the
//     real Take);
//   - a step it cannot do (upstairs, underground) or one that came to nothing after a few tries: the clue dropped
//     (its Drop), as 2004's players dropped a clue too hard for them.
// Lines: setting out, asking about a clue now and then, digging, a new clue, the reward, giving up (port/BotOutings
// sayMembers, kind 'setpiece'). On the registry as a 'trail' (its own cap: port/BotOutings trailBudget).
import {
    BotTask,
    Player,
    InvType,
    walkTo,
    findNpcByName,
    interactNpcOp,
    countItem,
    StuckDetector,
    teleportNear,
    advanceBankWalk,
    bankInvId,
    humanDelay,
    randInt,
    findLocByName
} from '#/engine/bot/tasks/BotTaskBase.js';
import World from '#/engine/World.js';
import ObjType from '#/cache/config/ObjType.js';
import LocType from '#/cache/config/LocType.js';
import { botAnswerDialogue, botScript, findObjNear, interactHeldOp, interactLocOp, interactObjOp } from '#/engine/bot/BotAction.js';
import { moveItems } from '#/engine/bot/port/BotInventoryCompat.js';
import { SPADE_SPAWNS, bankedEasyClue, carriedTrailItem, clueStep, type ClueStep } from '#/engine/bot/port/BotClues.js';
import { countMinigame, noteOutingEnd, noteOutingStart, sayMembers } from '#/engine/bot/port/BotOutings.js';

/** a trail is over after this long whatever happened (ticks: 40 minutes) */
const TRAIL_TICKS = 4000;
/** clicks on a step before it is given up */
const STEP_TRIES = 4;

/** (tests, the runner) trails begun, steps by kind, clues, caskets, rewards, give-ups and why */
export const trailStats = { trails: 0, steps: { dig: 0, search: 0, talk: 0 } as Record<string, number>, clues: 0, caskets: 0, rewards: 0, items: 0, gaveUp: {} as Record<string, number>, ended: {} as Record<string, number> };

let spadeId = -1;
function spade(): number {
    if (spadeId === -1) spadeId = ObjType.getId('spade');
    return spadeId;
}

/** the slot of `id` in the pack, or -1 */
function slotOf(player: Player, id: number): number {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return -1;
    for (let i = 0; i < inv.capacity; i++) if (inv.get(i)?.id === id) return i;
    return -1;
}

export class TreasureTrailTask extends BotTask {
    private state: 'fetch' | 'read' | 'step' | 'spade' | 'casket' | 'reward' | 'giveup' | 'done' = 'read';
    private readonly stuck = new StuckDetector(40, 4, 3);
    private started = false;
    private startedAt = 0;
    private stateAt = 0;
    private lastClick = 0;
    private tries = 0;
    /** the clue (or casket) it holds now, and its step */
    private item = -1;
    private step: ClueStep | null = null;
    private outcome = 'done';
    private _player: Player | null = null;
    private packBefore = 0;
    private lostTicks = 0;

    constructor() {
        super('TreasureTrail');
    }

    shouldRun(_player: Player): boolean {
        return this.state !== 'done' && !this.interrupted;
    }

    isComplete(_player: Player): boolean {
        return this.state === 'done';
    }

    override interrupt(): void {
        super.interrupt();
        this._end(null, 'interrupted');
    }

    override reset(): void {
        super.reset();
        if (this.started && this.state !== 'done') this._end(null, 'reset');
    }

    tick(player: Player): void {
        if (this.interrupted || this.state === 'done') return;
        this._player = player;
        const now = World.currentTick;
        if (!this.started) {
            this.started = true;
            this.startedAt = now;
            trailStats.trails++;
            noteOutingStart(player, 'TreasureTrail', 'trail', 'trail');
            this._set(carriedTrailItem(player) ? 'read' : 'fetch');
            if (Math.random() < 0.4) sayMembers(player, 'trail-go');
        }
        if (now - this.startedAt > TRAIL_TICKS) {
            this._end(player, 'time');
            return;
        }
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        // (an NPC's pages, the casket's box: continued as a player clicks them)
        if (this.state !== 'read' && botAnswerDialogue(player, 1) !== null) return;
        if (player.delayed) return;

        switch (this.state) {
            case 'fetch': {
                // (the clue from its bank: the bank it is near)
                const result = advanceBankWalk(player, this.stuck);
                if (result === 'walk') return;
                const bid = bankInvId();
                const bank = bid === -1 ? null : player.getInventory(bid);
                const inv = player.getInventory(InvType.INV);
                const id = bankedEasyClue(player, bid);
                if (bank && inv && id !== -1) moveItems(bank, inv, id, 1);
                // (and its spade, when it banked one)
                if (bank && inv && countItem(player, spade()) === 0 && bank.getItemCount(spade()) > 0) moveItems(bank, inv, spade(), 1);
                this.cooldown = result === 'ready' ? humanDelay(player, 'bank') : 0;
                this.stuck.reset();
                if (!carriedTrailItem(player)) this._end(player, 'no-clue');
                else this._set('read');
                return;
            }
            case 'read': {
                const held = carriedTrailItem(player);
                if (!held) {
                    this._end(player, this.item !== -1 ? 'done' : 'no-clue');
                    return;
                }
                if (held.casket) {
                    this.item = held.id;
                    this._set('casket');
                    return;
                }
                // (its window a moment, then closed; the step from what it says)
                if (player.containsModalInterface()) {
                    if (now - this.stateAt >= randInt(3, 6)) {
                        player.closeModal();
                        this._readStep(player, held.id);
                    }
                    return;
                }
                if (now - this.lastClick < 4) return;
                const inv = player.getInventory(InvType.INV)!;
                this.lastClick = now;
                if (!interactHeldOp(player, inv, held.id, held.slot, 1) || now - this.stateAt > 12) this._readStep(player, held.id);
                return;
            }
            case 'spade': {
                if (countItem(player, spade()) > 0) {
                    this._set('step');
                    return;
                }
                const at = this._nearestSpawn(player);
                if (!at) {
                    this._giveUp(player, 'no-spade');
                    return;
                }
                const [sx, sz] = at;
                if (Math.max(Math.abs(player.x - sx), Math.abs(player.z - sz)) > 2) {
                    this._walk(player, sx, sz);
                    return;
                }
                const obj = findObjNear(player, sx, sz, 0, spade(), 2);
                if (obj && now - this.lastClick >= 6) {
                    this.lastClick = now;
                    interactObjOp(player, obj, 3);
                }
                // (taken by someone else: it waits for the spawn a while, then tries the next)
                if (now - this.stateAt > 300) this._giveUp(player, 'no-spade');
                return;
            }
            case 'step': {
                const held = carriedTrailItem(player);
                if (!held) {
                    // (an NPC took the last clue and the trail is done: 274's trail_complete opens the reward's window)
                    if (player.containsModalInterface()) {
                        trailStats.steps[this.step?.kind ?? 'talk'] = (trailStats.steps[this.step?.kind ?? 'talk'] ?? 0) + 1;
                        this._set('reward');
                        return;
                    }
                    if (++this.lostTicks > 4) this._end(player, 'lost');
                    return;
                }
                this.lostTicks = 0;
                // (the clue changed: the step done; a casket, or the next clue to read)
                if (held.id !== this.item) {
                    trailStats.steps[this.step?.kind ?? 'dig'] = (trailStats.steps[this.step?.kind ?? 'dig'] ?? 0) + 1;
                    countMinigame('TreasureTrail', 'steps');
                    if (!held.casket) {
                        trailStats.clues++;
                        if (Math.random() < 0.3) sayMembers(player, 'trail-step');
                    }
                    this.item = held.id;
                    this._set(held.casket ? 'casket' : 'read');
                    return;
                }
                this._doStep(player, now);
                return;
            }
            case 'casket': {
                const held = carriedTrailItem(player);
                if (!held || !held.casket) {
                    // (opened: the next clue, or the reward's window)
                    if (player.containsModalInterface()) {
                        this._set('reward');
                        return;
                    }
                    if (held) {
                        trailStats.clues++;
                        this.item = held.id;
                        this._set('read');
                        return;
                    }
                    this._set('reward');
                    return;
                }
                if (now - this.lastClick < 5) return;
                this.lastClick = now;
                trailStats.caskets++;
                countMinigame('TreasureTrail', 'caskets');
                this.packBefore = this._packCount(player);
                interactHeldOp(player, player.getInventory(InvType.INV)!, held.id, held.slot, 1);
                return;
            }
            case 'reward': {
                // (the reward's window a moment, then closed: its items are in the pack, 274's trail_give_reward)
                if (player.containsModalInterface()) {
                    if (now - this.stateAt >= randInt(4, 8)) player.closeModal();
                    return;
                }
                const held = carriedTrailItem(player);
                if (held) {
                    this.item = held.id;
                    this._set(held.casket ? 'casket' : 'read');
                    return;
                }
                const items = Math.max(0, this._packCount(player) - this.packBefore + 1);
                trailStats.rewards++;
                trailStats.items += items;
                countMinigame('TreasureTrail', 'rewards');
                if (Math.random() < 0.6) sayMembers(player, 'trail-done');
                this._end(player, 'done');
                return;
            }
            case 'giveup': {
                // (the clue dropped: its Drop)
                const held = carriedTrailItem(player);
                if (!held) {
                    this._end(player, this.outcome);
                    return;
                }
                if (now - this.lastClick < 4) return;
                this.lastClick = now;
                if (!interactHeldOp(player, player.getInventory(InvType.INV)!, held.id, held.slot, 5) || now - this.stateAt > 30) this._end(player, this.outcome);
                return;
            }
        }
    }

    /** the step of the clue just read: to it, or given up */
    private _readStep(player: Player, id: number): void {
        this.item = id;
        this.step = clueStep(id);
        this.tries = 0;
        if (this.step.kind === 'skip') {
            if (Math.random() < 0.3) sayMembers(player, 'trail-ask');
            this._giveUp(player, this.step.why);
            return;
        }
        if (Math.random() < 0.08) sayMembers(player, 'trail-ask');
        this._set(this.step.kind === 'dig' && countItem(player, spade()) === 0 ? 'spade' : 'step');
    }

    /** to the step's place, then its click: a dig, a search, a talk */
    private _doStep(player: Player, now: number): void {
        const step = this.step;
        if (!step || step.kind === 'skip') return;
        const [x, z] = step.at;
        const near = step.kind === 'dig' ? 0 : step.kind === 'search' ? 1 : 4;
        if (Math.max(Math.abs(player.x - x), Math.abs(player.z - z)) > near || player.level !== 0) {
            if (step.kind === 'search' && Math.max(Math.abs(player.x - x), Math.abs(player.z - z)) <= 6) {
                // (by it: the click walks to it, the game's own route)
            } else {
                this._walk(player, x, z);
                return;
            }
        }
        if (botScript(player) || player.target !== null || now - this.lastClick < 8) return;
        if (++this.tries > STEP_TRIES) {
            this._giveUp(player, `${step.kind}-failed`);
            return;
        }
        this.lastClick = now;
        this.packBefore = this._packCount(player);
        if (step.kind === 'dig') {
            const slot = slotOf(player, spade());
            if (slot === -1) {
                this._set('spade');
                return;
            }
            if (this.tries === 1 && Math.random() < 0.3) sayMembers(player, 'trail-dig');
            interactHeldOp(player, player.getInventory(InvType.INV)!, spade(), slot, 1);
            return;
        }
        if (step.kind === 'search') {
            const loc = this._locAt(x, z);
            if (!loc) {
                this._giveUp(player, 'no-loc');
                return;
            }
            const ops = (LocType.get(loc.type).op ?? []).map(o => String(o ?? '').toLowerCase());
            const i = ops.findIndex(o => o === 'search');
            interactLocOp(player, loc, (i >= 0 ? i + 1 : 1) as 1 | 2 | 3 | 4 | 5);
            return;
        }
        for (const name of step.npcs) {
            const npc = findNpcByName(player.x, player.z, player.level, name, 12);
            if (npc) {
                interactNpcOp(player, npc, 1);
                return;
            }
        }
        // (nobody of theirs here: a few looks round, then given up)
        walkTo(player, x + randInt(-3, 3), z + randInt(-3, 3), 0);
    }

    /** the loc on the clue's tile (a crate, drawers, a chest, boxes) */
    private _locAt(x: number, z: number): ReturnType<typeof findLocByName> {
        const zone = World.gameMap.getZone(x, z, 0);
        if (!zone) return null;
        for (const loc of zone.getAllLocsSafe()) {
            if (loc.x === x && loc.z === z && loc.level === 0) {
                const ops = LocType.get(loc.type).op ?? [];
                if (ops.some(o => o)) return loc as ReturnType<typeof findLocByName>;
            }
        }
        return null;
    }

    private _nearestSpawn(player: Player): [number, number, number] | null {
        let best: [number, number, number] | null = null;
        let bestD = Infinity;
        for (const s of SPADE_SPAWNS) {
            const d = Math.max(Math.abs(player.x - s[0]), Math.abs(player.z - s[1]));
            if (d < bestD) {
                bestD = d;
                best = s;
            }
        }
        return bestD <= 600 ? best : null;
    }

    private _packCount(player: Player): number {
        const inv = player.getInventory(InvType.INV);
        return inv ? inv.capacity - inv.freeSlotCount : 0;
    }

    private _giveUp(player: Player, why: string): void {
        trailStats.gaveUp[why] = (trailStats.gaveUp[why] ?? 0) + 1;
        if (Math.random() < 0.5) sayMembers(player, 'trail-giveup');
        this.outcome = `gave-up:${why}`;
        this._set('giveup');
    }

    private _set(state: TreasureTrailTask['state']): void {
        this.state = state;
        this.stateAt = World.currentTick;
        this.lastClick = 0;
        this.stuck.reset();
    }

    private _end(player: Player | null, outcome: string): void {
        if (this.state === 'done') return;
        this.state = 'done';
        trailStats.ended[outcome] = (trailStats.ended[outcome] ?? 0) + 1;
        const p = player ?? this._player;
        if (p && this.started) noteOutingEnd(p, outcome);
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

/** may the bot follow a trail now: an easy clue in its pack or bank (members: 274 drops clues only there) */
export function holdsEasyClue(player: Player): boolean {
    return carriedTrailItem(player) !== null || bankedEasyClue(player, bankInvId()) !== -1;
}

