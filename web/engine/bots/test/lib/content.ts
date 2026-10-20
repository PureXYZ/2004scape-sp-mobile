// The 274 configs and the bot library's data tables, for test/content-names.test.mjs (loaded in a scratch engine
// clone, test/lib/clone.mjs: the bot modules import World, which reads data/ at import).
import '#/engine/World.js'; // the engine's graph has cycles: evaluate it from World, as the engine's own entry does
import CategoryType from '#/cache/config/CategoryType.js';
import Component from '#/cache/config/Component.js';
import InvType from '#/cache/config/InvType.js';
import LocType from '#/cache/config/LocType.js';
import NpcType from '#/cache/config/NpcType.js';
import ObjType from '#/cache/config/ObjType.js';
import ParamType from '#/cache/config/ParamType.js';
import SeqType from '#/cache/config/SeqType.js';
import SpotanimType from '#/cache/config/SpotanimType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import { AgilityCourses, Items, SkillProgression } from '#/engine/bot/BotKnowledge.js';
import { BOT_VARPS } from '#/engine/bot/BotManager.js';
import { ShopTripTask } from '#/engine/bot/tasks/ShopTripTask.js';

export { AgilityCourses, Items, SkillProgression, BOT_VARPS, ShopTripTask };

export function load(pack: string): void {
    for (const type of [CategoryType, Component, InvType, LocType, NpcType, ObjType, ParamType, SeqType, SpotanimType, VarPlayerType]) {
        type.load(pack);
    }
}

function names(type: { count: number; get(id: number): { debugname?: string | null } | undefined }): string[] {
    const out: string[] = [];
    for (let id = 0; id < type.count; id++) {
        const name = type.get(id)?.debugname;
        if (name) out.push(name);
    }
    return out;
}

/** Every debugname per config kind, and the exact-name lookups the bots use. */
export function configs() {
    return {
        loc: { getId: (n: string) => LocType.getId(n), names: names(LocType) },
        npc: { getId: (n: string) => NpcType.getId(n), names: names(NpcType) },
        obj: { getId: (n: string) => ObjType.getId(n), names: names(ObjType) },
        com: { getId: (n: string) => Component.getId(n), names: [] as string[] },
        varp: { getId: (n: string) => VarPlayerType.getId(n), names: [] as string[] },
        param: { getId: (n: string) => ParamType.getId(n), names: [] as string[] },
        seq: { getId: (n: string) => SeqType.getId(n), names: [] as string[] },
        spotanim: { getId: (n: string) => SpotanimType.getId(n), names: [] as string[] },
        inv: { getId: (n: string) => InvType.getId(n), names: [] as string[] },
        category: { getId: (n: string) => CategoryType.getId(n), names: [] as string[] }
    };
}

export function objName(id: number): string | null {
    return id >= 0 && id < ObjType.count ? (ObjType.get(id).debugname ?? null) : null;
}

/** ShopTripTask's shop key → NPC table (a private static upstream). */
export function shopNpcNames(): string[] {
    return Object.values((ShopTripTask as unknown as { NPC_NAMES: Record<string, string> }).NPC_NAMES);
}
