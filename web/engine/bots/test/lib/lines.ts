// The bots' lines (port/BotLines, port/BotStyle, port/BotChatter's pools) with the real 274 word filter, for
// test/lines.test.mjs (loaded in a scratch engine clone, test/lib/clone.mjs: data/raw/wordenc is Server's).
import '#/engine/World.js'; // the engine's graph has cycles: evaluate it from World, as the engine's own entry does
import NpcType from '#/cache/config/NpcType.js';
import ObjType from '#/cache/config/ObjType.js';
import WordEnc from '#/cache/wordenc/WordEnc.js';
import * as Lines from '#/engine/bot/port/BotLines.js';
import { sayable, styleLine } from '#/engine/bot/port/BotStyle.js';
import { personaOf } from '#/engine/bot/port/BotPersona.js';
import { BOT_NAMES, plannerOf } from '#/engine/bot/port/BotRoster.js';
import { NEWBIE_BEGS, NEWBIE_QUESTIONS } from '#/engine/bot/port/BotNewbie.js';
import { ESCAPE_LINES, KILL_LINES } from '#/engine/bot/port/BotPkTactics.js';
import { lostInWordPack } from './chatfilter.js';

export { Lines, sayable, styleLine, personaOf, BOT_NAMES, plannerOf, NEWBIE_BEGS, NEWBIE_QUESTIONS, KILL_LINES, ESCAPE_LINES, lostInWordPack };
// (the variety work, round 1, Track S: the slots a line may hold, and the classes the responses follow)
export * as Slots from '#/engine/bot/port/BotSlots.js';

/** As World.start does: the filter's data, and the item and NPC names the lines' targets use */
export function loadWordEnc(): void {
    WordEnc.load('data/pack');
    ObjType.load('data/pack');
    NpcType.load('data/pack');
}

/** what every bot line goes through (port/BotSay) */
export function filter(text: string): string {
    return WordEnc.filter(text);
}
