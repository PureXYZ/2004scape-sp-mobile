// port (the bots ideas work, round 1, Track B: loot): where port/BotLoot finds the sub-task a pile asks for. A module of
// its own with nothing to import (types only), so it is whole before anyone reads it: tasks/LootPileTask registers its
// class here as it loads, and port/BotLoot (which loads no task class: an early import of one met a task class half made
// once, a TDZ crash) asks for it at a death.
import type Player from '#/engine/entity/Player.js';
import type { BotTask } from '#/engine/bot/tasks/BotTaskBase.js';
import type { Pile, VultureTrait } from '#/engine/bot/port/BotLoot.js';

export type LootTaskFactory = (pile: Pile, role: 'killer' | 'vulture', trait: VultureTrait, bot: Player) => BotTask | null;

/** the factory tasks/LootPileTask registered (null before it loads: no pile gets a sub-task) */
export const lootTasks: { make: LootTaskFactory | null } = { make: null };
