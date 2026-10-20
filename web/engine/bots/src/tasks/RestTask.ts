/**
 * RestTask.ts (port; the realism work, phase 5a, Track F: the danger check)
 *
 * A hurt bot at (or bound for) a place where monsters hunt it gets its Hitpoints back first, as a careful player did:
 *   - food in its pack: it eats, a bite at a person's pace, up to EAT_TO of its Hitpoints;
 *   - food in the bank: it walks to the nearest bank where nothing hunts it (port/BotDanger: not Draynor's, beside its
 *     dark wizards, for a low-level bot), takes 2-4 pieces (enough for EAT_TO) and eats them there.
 * Done at EAT_TO, when its food runs out, after REST_LIMIT_TICKS, or when its HP is back for any reason. The planner hands
 * it out (step 1e: the next task's spot is hunted and the bot is hurt), and so does port/BotDefence during a task (a
 * sub-task: the task resumes after it). With no food anywhere it is not handed out: the bot heals to REST_TO doing
 * something where nothing hunts it (port/BotDefence isHealing, the planner's step 1e; 274 gives a Hitpoint back a
 * minute). A stand of minutes at a bank instead was the humanlike report's idle stand (H19: 10 more in 138 levelling
 * bot-hours, half of them at Draynor's bank among the wizards).
 *
 * Before, a hurt woodcutter went on chopping beside dark wizards that hunted it.
 */
import {
    BotTask, Player, InvType, Locations,
    StuckDetector, advanceBankWalk, bankInvId, nearestBank,
    currentHp, maxHp, hpBelow, carriedFood, bankedFood, eatBestFood, edibleFoodIds, humanDelay
} from '#/engine/bot/tasks/BotTaskBase.js';
import { moveItems } from '#/engine/bot/port/BotInventoryCompat.js';
import { bankStop } from '#/engine/bot/port/BotHabits.js';
import { dangerAt, huntsMe } from '#/engine/bot/port/BotDanger.js';
import { isAllowedCoord } from '#/engine/bot/port/BotWorldRules.js';
import World from '#/engine/World.js';

/** eat up to this share of the Hitpoints */
export const EAT_TO = 0.8;
/** with no food, the bot heals to this share away from monsters that hunt it (port/BotDefence isHealing) */
export const REST_TO = 0.7;
/** a rest is over after this long, whatever (15 minutes) */
export const REST_LIMIT_TICKS = 1500;
/** a bank where nothing hunts the bot is worth this much more walk than the nearest (tiles) */
const SAFE_BANK_EXTRA = 150;

/** the banks a bot uses (BotTaskBase's, which it keeps to itself) */
const REST_BANKS: readonly (readonly [number, number, number])[] = [
    Locations.DRAYNOR_BANK,
    Locations.VARROCK_WEST_BANK,
    Locations.VARROCK_EAST_BANK,
    Locations.AL_KHARID_BANK,
    Locations.FALADOR_WEST_BANK,
    Locations.FALADOR_EAST_BANK,
    Locations.SEERS_BANK,
    Locations.EDGEVILLE_BANK,
    Locations.YANILLE_BANK,
    Locations.CATHERBY_BANK,
    Locations.ARDOUGNE_NORTH_BANK,
    Locations.ARDOUGNE_SOUTH_BANK,
    Locations.GNOME_NORTH_BANK,
    Locations.GNOME_SOUTH_BANK
];

/**
 * The bank a hurt bot fetches its food from: the nearest where no monster hunts it (port/BotDanger), within
 * SAFE_BANK_EXTRA tiles more than the nearest one; else the nearest. On a free world, a free bank.
 */
export function restBankFor(player: Player): [number, number, number] {
    const dist = (b: readonly [number, number, number]): number => Math.max(Math.abs(b[0] - player.x), Math.abs(b[1] - player.z));
    const banks = REST_BANKS.filter(b => isAllowedCoord(b[0], b[1])).sort((a, b) => dist(a) - dist(b));
    if (banks.length === 0) return nearestBank(player);
    const nearest = dist(banks[0]);
    for (const b of banks) {
        if (dist(b) - nearest > SAFE_BANK_EXTRA) break;
        if (!huntsMe(player, dangerAt(b[0], b[1], b[2]))) return [b[0], b[1], b[2]];
    }
    return [banks[0][0], banks[0][1], banks[0][2]];
}

export class RestTask extends BotTask {
    private state: 'start' | 'eat' | 'bank_walk' | 'bank' | 'done' = 'start';
    private began = -1;
    private bank: [number, number, number] | null = null;
    private banked = false;
    private readonly stuck = new StuckDetector(30, 4, 2);

    constructor() {
        super('Rest');
    }

    shouldRun(player: Player): boolean {
        return this.state !== 'done' && player.levels[3] > 0;
    }

    isComplete(player: Player): boolean {
        if (this.state === 'done') return true;
        // (its Hitpoints back however: eaten, a level-up)
        return this.state !== 'start' && !hpBelow(player, EAT_TO);
    }

    tick(player: Player): void {
        if (this.interrupted || this.state === 'done') return;
        const now = World.currentTick;
        if (this.began < 0) this.began = now;
        if (now - this.began > REST_LIMIT_TICKS) {
            this.state = 'done';
            return;
        }
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }

        if (this.state === 'start') {
            this.state = carriedFood(player) > 0 ? 'eat' : this._toBank(player);
            return;
        }

        if (this.state === 'eat') {
            if (!hpBelow(player, EAT_TO)) {
                this.state = 'done';
                return;
            }
            if (carriedFood(player) === 0) {
                this.state = this._toBank(player);
                return;
            }
            // (a bite at a person's pace; busy (a script's delay): again next tick)
            if (eatBestFood(player)) this.cooldown = 2 + humanDelay(player, 'page');
            return;
        }

        if (this.state === 'bank_walk') {
            const result = advanceBankWalk(player, this.stuck, this.bank ?? undefined);
            if (result === 'walk') return;
            this.cooldown = result === 'ready' ? bankStop(player) : 0;
            this.state = 'bank';
            return;
        }

        // at the bank: 2-4 pieces, enough for EAT_TO (a piece heals about 3-8 Hitpoints: the bot takes what it would eat)
        const missing = Math.ceil(maxHp(player) * EAT_TO) - currentHp(player);
        const want = Math.max(2, Math.min(4, Math.ceil(missing / 5)));
        if (bankedFood(player) > 0) this._withdraw(player, want);
        if (player.modalMain !== -1) player.closeModal();
        this.banked = true;
        this.state = carriedFood(player) > 0 ? 'eat' : 'done';
    }

    /** to a bank for food (once, where nothing hunts it), or done: no food there either */
    private _toBank(player: Player): 'bank_walk' | 'done' {
        if (this.banked || bankedFood(player) === 0) return 'done';
        this.bank = restBankFor(player);
        return 'bank_walk';
    }

    /** `count` pieces of the best food in the bank into the pack */
    private _withdraw(player: Player, count: number): void {
        const bid = bankInvId();
        const inv = player.getInventory(InvType.INV);
        const bank = bid === -1 ? null : player.getInventory(bid);
        if (!inv || !bank) return;
        let need = count;
        for (const foodId of edibleFoodIds()) {
            if (need <= 0) break;
            let inBank = 0;
            for (let slot = 0; slot < bank.capacity; slot++) {
                const it = bank.get(slot);
                if (it && it.id === foodId) inBank += it.count;
            }
            if (inBank <= 0) continue;
            need -= moveItems(bank, inv, foodId, Math.min(need, inBank));
        }
    }

    override interrupt(): void {
        super.interrupt();
        this.state = 'done';
    }

    override reset(): void {
        super.reset();
        this.state = 'start';
        this.began = -1;
        this.bank = null;
        this.banked = false;
        this.stuck.reset();
    }
}
