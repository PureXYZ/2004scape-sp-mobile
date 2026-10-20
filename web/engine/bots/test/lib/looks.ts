// test/looks.test.mjs's world (the realism work, phase 4: looks): test/lib/simworld.ts with the appearance, the looks
// (port/BotLooks), ageing (simworld's `Age`) and gear (port/BotGear) beside it, through one module graph.
import Player from '#/engine/entity/Player.js';
import InvType from '#/cache/config/InvType.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import Packet from '#/io/Packet.js';
import { getExpByLevel } from '#/engine/entity/Player.js';
import { Locations } from '#/engine/bot/BotKnowledge.js';
import { initBotFields } from '#/engine/bot/port/PlayerBotFields.js';

export * from './simworld.js';
export { default as ObjType } from '#/cache/config/ObjType.js';
export { default as IdkType } from '#/cache/config/IdkType.js';
export { normalizeBotName } from '#/engine/bot/port/BotRoster.js';
export { BotAppearance, designDefaults, paletteSizes, starterWeaponOf } from '#/engine/bot/BotAppearance.js';
export * as Looks from '#/engine/bot/port/BotLooks.js';
export * as Gear from '#/engine/bot/port/BotGear.js';
// (the variety work, round 1, track W: what bots wear) the styles, ladders, weapon kinds and skill clothes
export * as Outfits from '#/engine/bot/port/BotOutfits.js';
// (the variety work, round 2, track W2: fashion) the status pieces, members fashion and novelty pieces
export * as Fashion from '#/engine/bot/port/BotFashion.js';
export { CombatTask, SCIMITAR_TIERS } from '#/engine/bot/tasks/CombatTask.js';
export { WoodcuttingTask } from '#/engine/bot/tasks/WoodcuttingTask.js';
export { ShopTripTask } from '#/engine/bot/tasks/ShopTripTask.js';
export { InitTask } from '#/engine/bot/tasks/UtilTasks.js';
export { viableItemIds, _equipLoot } from '#/engine/bot/BotAction.js';
export * as Vendor from '#/engine/bot/tasks/VendorTask.js';
export { setHangoutRateForTest } from '#/engine/bot/port/BotHangout.js';
export { setHabitRatesForTest } from '#/engine/bot/port/BotHabits.js';
// (the variety work, round 1, track F: a login near the human lingers 10-40 s, its InitTask waiting: off with the habits' lingers)
export { setLingerForTest } from '#/engine/bot/port/BotLinger.js';
export { Items, Locations, SkillProgression } from '#/engine/bot/BotKnowledge.js';
export { getExpByLevel, getLevelByExp } from '#/engine/entity/Player.js';
// (the variety work, round 1, Track D) the power-droppers (port/BotFavourites): a full pack of willows is dropped, not banked
export { isDropper } from '#/engine/bot/port/BotFavourites.js';

/** A bot as BotManager makes a fresh one (no save), not in the world: the Lumbridge spawn, Herblore 3, its planner's fields. */
export function freshBot(name: string, planner = 'balanced'): Player {
    const player = PlayerLoading.load(name, new Packet(new Uint8Array(0)), null);
    const [x, z, level] = Locations.LUMBRIDGE_SPAWN;
    player.x = x;
    player.z = z;
    player.level = level;
    player.baseLevels[15] = 3;
    player.levels[15] = 3;
    player.stats[15] = getExpByLevel(3);
    initBotFields(player, planner);
    return player;
}

export function items(player: Player, invId: number): { slot: number; id: number; count: number }[] {
    const inv = invId === -1 ? null : player.getInventory(invId);
    const out: { slot: number; id: number; count: number }[] = [];
    for (let slot = 0; slot < (inv?.capacity ?? 0); slot++) {
        const it = inv!.get(slot);
        if (it) out.push({ slot, id: it.id, count: it.count });
    }
    return out;
}

export function bankId(): number {
    return InvType.getId('bank');
}

/** The task a fresh bot "runs" for the modules that ask its AI (port/BotGear atASkill): a stand-in with that name. */
export function setTask(player: Player, name: string | null): void {
    (player as unknown as { _bot: { currentTask: { name: string } | null } })._bot = { currentTask: name ? { name } : null };
}

/** The gender, body, colours and worn items of a bot: what the same name must give again. */
export function bodyOf(player: Player): string {
    return JSON.stringify({ gender: player.gender, body: Array.from(player.body), colors: Array.from(player.colors), worn: items(player, InvType.WORN) });
}
