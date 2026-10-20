// Rev 274's Inventory, rev 254's (test/ref) and port/BotInventoryCompat, for test/inventory.test.mjs (loaded in a
// scratch engine clone, test/lib/clone.mjs: the configs come from data/pack).
import '#/engine/World.js'; // the engine's graph has cycles: evaluate it from World, as the engine's own entry does
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import { Inventory } from '#/engine/Inventory.js';
import { canAddAll, invAddAll, moveItems, roomFor } from '#/engine/bot/port/BotInventoryCompat.js';
import { Inventory as Inventory254 } from '../ref/Inventory254.js';

export { Inventory, Inventory254, canAddAll, invAddAll, moveItems, roomFor, InvType, ObjType };

export function load(pack: string): void {
    InvType.load(pack);
    ObjType.load(pack);
}
