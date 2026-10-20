// The language model's guard and prompts for the training data's tools (the realism work, phase 7, Track L:
// test/model-data/check-replies.mjs, and the later assemble/eval steps), loaded in a scratch engine clone
// (test/lib/clone.mjs importInEngine) so the game's word filter has its real 274 data.
import '#/engine/World.js'; // the engine's graph has cycles: evaluate it from World, as the engine's own entry does
import WordEnc from '#/cache/wordenc/WordEnc.js';

export { guardReply } from '#/engine/bot/port/BotModelGuard.js';
export { renderLocal, renderOnline, SKILL_SHORT } from '#/engine/bot/port/BotModelPrompt.js';
export { MAX_LINE } from '#/engine/bot/port/BotSay.js';

/** As World.start does (WordEnc reads data/pack). */
export function loadWordEnc(): void {
    WordEnc.load('data/pack');
}

/** What the game's filter makes of a line (stars where it masks). */
export function filter(text: string): string {
    return WordEnc.filter(text);
}
