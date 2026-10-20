// For test/knowledge.test.mjs: every gathering, thieving and combat step of BotKnowledge.SkillProgression checked
// against the real 274 map, with the step's own task's search from the step's spot: is there something to do there?
// (A step with nothing in reach sends its bots to stand about: the Falador yews had no yew within 29 tiles, the
// shark step looked for the wrong kind of fishing spot.)
import Player from '#/engine/entity/Player.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import Packet from '#/io/Packet.js';
import LocType from '#/cache/config/LocType.js';
import NpcType from '#/cache/config/NpcType.js';
import World from '#/engine/World.js';
import { SkillProgression, Items, type SkillStep } from '#/engine/bot/BotKnowledge.js';
import { WoodcuttingTask } from '#/engine/bot/tasks/WoodcuttingTask.js';
import { MiningTask } from '#/engine/bot/tasks/MiningTask.js';
import { FishingTask } from '#/engine/bot/tasks/FishingTask.js';
import { ThievingTask } from '#/engine/bot/tasks/ThievingTask.js';
import { CombatTask } from '#/engine/bot/tasks/CombatTask.js';
import { setWorld } from '#/engine/bot/BotWorld.js';

export { World, NpcType, LocType };

export interface StepCheck {
    skill: string;
    action: string;
    at: string;
    what: string;
    /** what the task's search found from the step's spot, or null */
    found: string | null;
    /** a target of the step's own kind (a mining step's own ore, not the fallback rocks) */
    own: boolean;
    members: boolean;
}

const ORE_OF: Record<number, string> = {
    [Items.COPPER_ORE]: 'copperrock',
    [Items.TIN_ORE]: 'tinrock',
    [Items.IRON_ORE]: 'ironrock',
    [Items.COAL]: 'coalrock',
    [Items.GOLD_ORE]: 'goldrock',
    [Items.MITHRIL_ORE]: 'mithrilrock',
    [Items.ADAMANTITE_ORE]: 'adamantiterock',
    [Items.RUNITE_ORE]: 'runiterock',
    [Items.CLAY]: 'clayrock'
};

/** A player standing on the step's spot with the step's level in every skill (it searches from there, not in the world). */
function standIn(step: SkillStep): Player {
    const player = PlayerLoading.load('knowledge test', new Packet(new Uint8Array(0)), null);
    [player.x, player.z, player.level] = step.location;
    for (let stat = 0; stat < player.baseLevels.length; stat++) {
        if (stat === 18 || stat === 19) continue;
        player.setLevel(stat, Math.max(stat === PlayerStat.HITPOINTS ? 10 : 1, Math.min(99, step.minLevel)));
    }
    return player;
}

type Finder = (player: Player) => { name: string } | null;

export function checkSteps(): StepCheck[] {
    setWorld(World);
    const out: StepCheck[] = [];
    for (const [skill, steps] of Object.entries(SkillProgression)) {
        for (const step of steps) {
            let what = '';
            let find: Finder | null = null;
            let own = (found: string | null): boolean => found !== null;
            const loc = (l: { type: number } | null): { name: string } | null => (l ? { name: LocType.get(l.type).debugname ?? `loc ${l.type}` } : null);
            const npc = (n: { type: number } | null): { name: string } | null => (n ? { name: NpcType.get(n.type).debugname ?? `npc ${n.type}` } : null);
            if (step.action === 'woodcut') {
                const task = new WoodcuttingTask(step) as unknown as { _findTree(p: Player): { type: number } | null; _treePrefix(): string };
                what = `tree ${task._treePrefix()}`;
                find = p => loc(task._findTree(p));
            } else if (step.action === 'mine') {
                const task = new MiningTask(step) as unknown as { _findRock(p: Player): { type: number } | null };
                const ore = step.itemGained !== undefined ? ORE_OF[step.itemGained] : undefined;
                what = `rock ${ore ?? '?'}`;
                find = p => loc(task._findRock(p));
                own = found => found !== null && (!ore || found.startsWith(ore));
            } else if (step.action === 'fish') {
                const task = new FishingTask(step) as unknown as { _findFishSpot(p: Player): { type: number } | null };
                what = `fishing spot for ${step.toolItemIds.join('/')}`;
                find = p => npc(task._findFishSpot(p));
            } else if (step.action === 'thieve') {
                const task = new ThievingTask(step) as unknown as { _findNpc(p: Player): { type: number } | null };
                what = `npc ${String(step.extra?.npcName ?? step.extra?.npcType ?? 'man')}`;
                find = p => npc(task._findNpc(p));
            } else if (step.action === 'thieve_stall') {
                const task = new ThievingTask(step) as unknown as { _findStall(p: Player): { type: number } | null };
                what = `stall ${String(step.extra?.locName ?? '?')}`;
                find = p => loc(task._findStall(p));
            } else if (step.action === 'combat') {
                const task = new CombatTask(step, PlayerStat.ATTACK) as unknown as { _findTargetNpc(p: Player): { type: number } | null };
                const extra = step.extra as { npcType?: string; npcTypes?: string[]; npcName?: string } | undefined;
                what = `npc ${[...(extra?.npcTypes ?? []), extra?.npcType, extra?.npcName].filter(Boolean).join('/')}`;
                find = p => npc(task._findTargetNpc(p));
            }
            if (!find) continue;
            const player = standIn(step);
            let found: string | null = null;
            try {
                found = find(player)?.name ?? null;
            } catch (e) {
                found = null;
                what += ` (search failed: ${e instanceof Error ? e.message : e})`;
            }
            out.push({ skill, action: step.action, at: step.location.join(','), what, found, own: own(found), members: !World.gameMap.isFreeToPlay(step.location[0], step.location[1]) });
        }
    }
    return out;
}
