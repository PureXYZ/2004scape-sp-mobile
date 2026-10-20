// The bot names and the pool with the engine's name functions and the NPC configs, for test/names.test.mjs (loaded in
// a scratch engine clone, test/lib/clone.mjs).
import '#/engine/World.js'; // the engine's graph has cycles: evaluate it from World, as the engine's own entry does
import NpcType from '#/cache/config/NpcType.js';
import { fromBase37, toBase37, toDisplayName } from '#/util/JString.js';
import { BOT_NAMES, NameSource, PLANNERS, LEVELLING_SHARE, ROSTER_SLOTS, groupCap, initialPool, isLevelling, normalizeBotName, onlineShare, plannerOf, poolShare, poolSize } from '#/engine/bot/port/BotRoster.js';

export { BOT_NAMES, NameSource, PLANNERS, LEVELLING_SHARE, ROSTER_SLOTS, groupCap, initialPool, isLevelling, normalizeBotName, onlineShare, plannerOf, poolShare, poolSize, fromBase37, toBase37, toDisplayName };

/** Every NPC's in-game name, lower case. */
export function npcNames(pack: string): Set<string> {
    NpcType.load(pack);
    const out = new Set<string>();
    for (let id = 0; id < NpcType.count; id++) {
        const name = NpcType.get(id)?.name;
        if (name) out.add(name.toLowerCase());
    }
    return out;
}
