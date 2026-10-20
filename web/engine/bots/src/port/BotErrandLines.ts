/**
 * port (the variety work, round 2, Track D2: new activities) an errand's lines (tasks/ErrandTask's `say` steps): a line of
 * data/lines2004-activities.json for the moment (event 'errand', the moment's kind: 'q-cook-egg', 'chain-hides-go',
 * 'wild-close'; BotLines.setPieceLine: one that fits the bot and is fresh, in its persona's style), now and then, only
 * with another player within 15 tiles ("said near others"), typed as a player types it (BotChat.sayTyped). Loaded with
 * the planner's offers (port/BotD2Picks).
 * port (the variety work, round 2, the fixes: B2) routine talk, not a set piece: the kind 'errand' (the humanlike report
 * counts it as chatter, in H7; it was 'setpiece', out of H7 and in X2), held by the speaker's voice's share of a busy
 * place (port/BotVoice) as its other optional lines, and in the place of its next line of its own (BotChatter.
 * countAsOwnLine, the exact debt; countAsBudgetedLine's push of the next due line leaked).
 */
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { setPieceLine } from '#/engine/bot/port/BotLines.js';
import { sayTyped } from '#/engine/bot/port/BotChat.js';
import { countAsOwnLine } from '#/engine/bot/port/BotChatter.js';
import { voiceFree } from '#/engine/bot/port/BotVoice.js';
import { setErrandLineHook } from '#/engine/bot/tasks/ErrandTask.js';

/** another player this near, on its floor */
const COMPANY_TILES = 15;

/** the errands' lines: said, and by kind (the report: QA1's detail, the tests) */
export const errandLineStats = { said: 0, alone: 0, none: 0, byKind: {} as Record<string, number>, quest: 0, held: 0 };

function companyNear(bot: Player): boolean {
    for (const p of World.playerLoop.all()) {
        if (p !== bot && p.level === bot.level && Math.abs(p.x - bot.x) <= COMPANY_TILES && Math.abs(p.z - bot.z) <= COMPANY_TILES) return true;
    }
    return false;
}

/** an errand's line now (`chance`), near others: true when one was said */
export function sayErrandLine(bot: Player, kind: string, chance: number): boolean {
    if (Math.random() >= chance) return false;
    if (!companyNear(bot)) {
        errandLineStats.alone++;
        return false;
    }
    // (the fixes, B2: over its share of a busy place's talk it says nothing this time, as its idle lines)
    if (!voiceFree(bot)) {
        errandLineStats.held++;
        return false;
    }
    const text = setPieceLine(bot, 'errand', { kind });
    if (!text) {
        errandLineStats.none++;
        return false;
    }
    sayTyped(bot, text, { to: null, kind: 'errand' });
    countAsOwnLine(bot);
    errandLineStats.said++;
    errandLineStats.byKind[kind] = (errandLineStats.byKind[kind] ?? 0) + 1;
    if (kind.startsWith('q-')) errandLineStats.quest++;
    return true;
}

setErrandLineHook((bot, kind, chance) => sayErrandLine(bot, kind, chance));
