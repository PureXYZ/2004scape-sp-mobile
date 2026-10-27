// Runtime patches for the cost of a tick (imported by the entry after World: the classes come through World's
// imports). Each one keeps the engine's behaviour exactly - the same calls in the same order, the same state, the same
// random draws and the same bytes to the client - shown by seeded worlds hashed every tick with and without them, on V8
// and JavaScriptCore, idle, with 5 humans and with 250/500 bots (numbers per patch below), and each
// one by its own test against upstream's code.
//
// 1. The collection loops without generators (runtime/iterators.ts): JavaScriptCore -29.5 % instructions a tick with
//    one player, -8..-12 % with 500 bots; V8 6.3 -> 2.75 MB of garbage a tick.
// 2. HuntType.get(-1) without the lookup, 3. ScriptRunner.HANDLERS as a packed array, 4. rsbuf's per-tick reset of
//    the ids it wrote only: three slow paths of V8 (Android); V8 -6.1 % / -3.8 % (with bots) / -4.5 % a tick, JSC
//    -1 %, ±0, -1 %.
// 5. processInfo leaves out the npcs whose rsbuf mirror already holds their info: JSC -2.3..-2.7 % a tick idle.
import HuntType from '#/cache/config/HuntType.js';
import DoublyLinkList from '#/datastruct/DoublyLinkList.js';
import HashTable from '#/datastruct/HashTable.js';
import LinkList from '#/datastruct/LinkList.js';
import { CoordGrid } from '#/engine/CoordGrid.js';
import { NpcList } from '#/engine/entity/EntityList.js';
import ScriptRunner from '#/engine/script/ScriptRunner.js';
import World from '#/engine/World.js';
import Zone from '#/engine/zone/Zone.js';

import { installPlainIterators } from './iterators.js';
import { installHuntGet, packHandlers } from './lookups.js';
import { installNpcInfoSkip } from './npc-info.js';
import { installRendererResets } from './rsbuf.js';

// 1. plain iterators (runtime/iterators.ts, test/iterators.test.mjs)
installPlainIterators({
    entityList: Object.getPrototypeOf(NpcList.prototype),
    linkList: LinkList,
    doublyLinkList: DoublyLinkList,
    hashTable: HashTable,
    zone: Zone,
    coordGrid: CoordGrid
});

// 2. HuntType.get(-1), 3. ScriptRunner.HANDLERS (runtime/lookups.ts, test/tick.test.mjs)
installHuntGet(HuntType as unknown as { configs: HuntType[]; get(id: number): HuntType });
packHandlers(ScriptRunner as unknown as { HANDLERS: object });

// 4. rsbuf: reset only the ids written this tick (runtime/rsbuf.ts, test/rsbuf.test.mjs)
installRendererResets();

// 5. processInfo: leave out the npcs whose rsbuf mirror already holds their info (runtime/npc-info.ts, test/tick.test.mjs)
installNpcInfoSkip(Object.getPrototypeOf(World));
