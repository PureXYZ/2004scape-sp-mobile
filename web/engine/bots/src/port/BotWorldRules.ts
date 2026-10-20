// Free worlds (Settings › World › Members off, BOTS.md §4.4). Upstream assumed a members world: its planner picks
// Catherby, Seers, the gnome course or Ardougne as readily as Lumbridge, and 274's canTravel stops a non-member at
// the F2P border, so those bots would walk into the border until a watchdog teleported them through it. On a free
// world the bots keep to what a free player can do: the members skills (Agility, Herblore, Thieving, Fletching) and
// every progression step whose place or items are members-only are dropped once at start, and a bot that ends up
// outside F2P goes back to Lumbridge like a non-member logging in there (World.ts, 274).
import ObjType from '#/cache/config/ObjType.js';
import World from '#/engine/World.js';
import { SkillProgression, type SkillStep } from '#/engine/bot/BotKnowledge.js';

/** Members-only skills in 2004 (their tasks need members areas and items anyway). */
export const MEMBERS_SKILLS: ReadonlySet<string> = new Set(['AGILITY', 'HERBLORE', 'THIEVING', 'FLETCHING']);

/** Where a non-member who logs in outside F2P is put (World.ts, 274). */
export const FREE_WORLD_SAFE_TILE: [number, number, number] = [3221, 3219, 0];

let membersWorld = true;

export function isMembersWorld(): boolean {
    return membersWorld;
}

/** May a bot be at (x, z) on this world? */
export function isAllowedCoord(x: number, z: number): boolean {
    return membersWorld || World.gameMap.isFreeToPlay(x, z);
}

function isMembersObj(id: number | undefined): boolean {
    return id !== undefined && id !== -1 && ObjType.get(id).members;
}

/** Can a free player do this step: a free place, and no members-only product or consumable? */
export function isFreeStep(skill: string, step: SkillStep): boolean {
    if (MEMBERS_SKILLS.has(skill)) return false;
    if (!World.gameMap.isFreeToPlay(step.location[0], step.location[1])) return false;
    if (step.via && !World.gameMap.isFreeToPlay(step.via[0], step.via[1])) return false;
    if (isMembersObj(step.itemGained) || isMembersObj(step.itemConsumed)) return false;
    if (step.toolItemIds.length > 0 && step.toolItemIds.every(isMembersObj)) return false;
    return true;
}

/**
 * Called once by BotManager.start. On a free world it removes every step a free player cannot do from
 * SkillProgression, in place, so the planner and the tasks (which all read SkillProgression) only see free ones.
 * Returns the number of steps removed.
 */
export function applyWorldRules(members: boolean): number {
    membersWorld = members;
    if (members) return 0;
    let removed = 0;
    for (const [skill, steps] of Object.entries(SkillProgression)) {
        const kept = steps.filter(step => isFreeStep(skill, step));
        removed += steps.length - kept.length;
        steps.length = 0;
        steps.push(...kept);
    }
    return removed;
}
