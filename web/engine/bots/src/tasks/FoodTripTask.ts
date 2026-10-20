/**
 * FoodTripTask.ts (port)
 *
 * Earned food (Phase 3): a new bot's bank no longer holds 999,999,999 swordfish, so a fighter with no
 * food buys kebabs from Karim in Al Kharid, a coin each, as a 2004 newbie did: 274's kebab_seller dialogue ("Would you
 * like to buy a nice kebab? Only one gold." / "Yes please."), one kebab a talk. The coins come from the bank first.
 * port (the realism work, phase 5a, Track F: forgotten food): a careless bot now and then stops after 2-4 (FEW_FOOD times
 * its carelessness, port/BotFumble), as a player in a hurry did, and is back for more sooner.
 */
import {
    BotTask, Player, InvType,
    walkTo, interactNpcOp, findNpcByName,
    countItem, isNear, isInventoryFull,
    Items, StuckDetector, advanceBankWalk, bankInvId,
    teleportNear, openNearbyGate, randInt, humanDelay,
} from '#/engine/bot/tasks/BotTaskBase.js';
import { bankStop } from '#/engine/bot/port/BotHabits.js';
import { botAnswerDialogue, botScript } from '#/engine/bot/BotAction.js';
import { coinsOwned, noteTripFailed } from '#/engine/bot/BotNeeds.js';
import { moveItems } from '#/engine/bot/port/BotInventoryCompat.js';
import { carelessFactor, FEW_FOOD } from '#/engine/bot/port/BotFumble.js';

/** where Karim stands (274: kebab_seller) */
export const KEBAB_SELLER: [number, number] = [3272, 3182];
/** kebabs a trip buys */
const WANT = 10;
/** Karim's choice: "Yes please." is its second option */
const YES_PLEASE = 2;

export class FoodTripTask extends BotTask {
    private state: 'bank_walk' | 'withdraw' | 'walk' | 'talk' | 'done' = 'walk';
    private startKebabs = -1;
    private talks = 0;
    /** port (phase 5a): the kebabs this trip buys (WANT, or 2-4 for a careless bot in a hurry) */
    private want = -1;
    private readonly stuck = new StuckDetector(30, 4, 2);

    constructor() {
        super('FoodTrip');
    }

    shouldRun(player: Player): boolean {
        return this.state !== 'done' && coinsOwned(player) >= 1 && !isInventoryFull(player);
    }

    isComplete(_p: Player): boolean {
        return this.state === 'done';
    }

    override reset(): void {
        super.reset();
        this.state = 'walk';
        this.startKebabs = -1;
        this.talks = 0;
        this.want = -1;
        this.stuck.reset();
    }

    tick(player: Player): void {
        if (this.interrupted) return;
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        // the coins first, from the bank
        if (this.state === 'walk' && countItem(player, Items.COINS) < WANT && coinsOwned(player) > countItem(player, Items.COINS)) this.state = 'bank_walk';
        if (this.state === 'bank_walk') {
            const result = advanceBankWalk(player, this.stuck);
            if (result === 'walk') return;
            // port (the realism work): a person's stop at the booth, never the same twice (port/BotHabits.bankStop)
            this.cooldown = result === 'ready' ? bankStop(player) : 0;
            this.state = 'withdraw';
            return;
        }
        if (this.state === 'withdraw') {
            const bid = bankInvId();
            const bank = bid === -1 ? null : player.getInventory(bid);
            const inv = player.getInventory(InvType.INV);
            const short = WANT - countItem(player, Items.COINS);
            if (bank && inv && short > 0) moveItems(bank, inv, Items.COINS, short);
            this.stuck.reset();
            this.state = 'walk';
            return;
        }
        const [kx, kz] = KEBAB_SELLER;
        if (this.state === 'walk') {
            if (!isNear(player, kx, kz, 4)) {
                this._walk(player, kx, kz);
                return;
            }
            this.state = 'talk';
            this.startKebabs = countItem(player, Items.KEBAB);
            // port (phase 5a, Track F): now and then only a few (a careless bot's hurry)
            this.want = Math.random() < Math.min(0.25, FEW_FOOD * carelessFactor(player)) ? randInt(2, 4) : WANT;
            return;
        }
        if (this.state === 'talk') {
            // his dialogue: pages continued, the choice "Yes please."
            // port (the realism work): each page read before the click, as a person's (BotTiming 'page'); upstream
            // clicked through in a tick, and every kebab took the same time (73-79 % identical intervals)
            if (botAnswerDialogue(player, YES_PLEASE) !== null) {
                this.cooldown = humanDelay(player, 'page');
                return;
            }
            if (player.delayed || botScript(player)) return;
            const kebabs = countItem(player, Items.KEBAB);
            if (kebabs - this.startKebabs >= (this.want > 0 ? this.want : WANT) || countItem(player, Items.COINS) < 1 || isInventoryFull(player) || this.talks >= WANT + 3) {
                if (kebabs <= this.startKebabs) noteTripFailed(player, Items.KEBAB);
                this.state = 'done';
                return;
            }
            const karim = findNpcByName(player.x, player.z, player.level, 'kebab_seller', 10);
            if (!karim) {
                this._walk(player, kx, kz);
                if (++this.talks >= WANT + 3) this.state = 'done';
                return;
            }
            interactNpcOp(player, karim, 1);
            this.talks++;
            // port (the realism work): the next talk when a person clicks him again (BotTiming 'next')
            this.cooldown = 1 + humanDelay(player, 'next');
        }
    }

    private _walk(player: Player, x: number, z: number): void {
        if (!this.stuck.check(player, x, z)) {
            walkTo(player, x, z);
            return;
        }
        if (this.stuck.desperatelyStuck) {
            teleportNear(player, x, z);
            this.stuck.reset();
            return;
        }
        if (openNearbyGate(player, 5)) return;
        walkTo(player, player.x + randInt(-8, 8), player.z + randInt(-8, 8));
    }
}
