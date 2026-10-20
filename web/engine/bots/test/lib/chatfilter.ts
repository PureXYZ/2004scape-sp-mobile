// The game's word filter with the real 274 data, the public-chat codec and what the bots say, for
// test/chat-filter.test.mjs (loaded in a scratch engine clone, test/lib/clone.mjs: data/raw/wordenc is Server's). The
// realism work: the conversation's answers (port/BotAnswers), the practices (data/practices.json, port/BotStage) and
// the reactions' lines (port/BotReactions).
import '#/engine/World.js'; // the engine's graph has cycles: evaluate it from World, as the engine's own entry does
import WordEnc from '#/cache/wordenc/WordEnc.js';
import NpcType from '#/cache/config/NpcType.js';
import { PlayerStatNameMap } from '#/engine/entity/PlayerStat.js';
import Packet from '#/io/Packet.js';
import WordPack from '#/wordenc/WordPack.js';
import { fillName } from '#/engine/bot/BotPlayer.js';
import { allLevelUpLines, levelUpCandidates, NEW_LINES, PK_LINES, UPSTREAM_LEVELUP } from '#/engine/bot/port/BotLines.js';
import { BOT_NAMES } from '#/engine/bot/port/BotRoster.js';
import { BOT_CHAT_LINES, isAddressingBot, joinGreeting } from '#/engine/bot/port/BotChat.js';
import { toDisplayName } from '#/util/JString.js';

import { activityFor } from '#/engine/bot/port/BotActivity.js';
import { allPlacePhrases, placePhrase } from '#/engine/bot/port/BotPlaces.js';
import { SkillProgression } from '#/engine/bot/BotKnowledge.js';
import { NEWBIE_BEGS, NEWBIE_QUESTIONS } from '#/engine/bot/port/BotNewbie.js';
import { ESCAPE_LINES, KILL_LINES } from '#/engine/bot/port/BotPkTactics.js';
import { TRADE_TALK, vendorAdverts, vendorStock } from '#/engine/bot/tasks/VendorTask.js';
import ObjType from '#/cache/config/ObjType.js';
import { ANSWER_LINES, ANSWER_WORDS } from '#/engine/bot/port/BotAnswers.js';
import { PRACTICES } from '#/engine/bot/port/BotStage.js';
import { GEAR_LINES, REACTION_LINES } from '#/engine/bot/port/BotReactions.js';
import { formatGp } from '#/engine/bot/port/BotPrices.js';
// (phase 3, track C: social life) the regulars', lures' and cliques' lines, and the names friends call each other
import { SOCIAL_LINES } from '#/engine/bot/tasks/SocialTask.js';
import { CLIQUE_LINES, allCliques, nickOf } from '#/engine/bot/port/BotCliques.js';

export { BOT_NAMES, BOT_CHAT_LINES, fillName, isAddressingBot, joinGreeting, toDisplayName, activityFor, allPlacePhrases, placePhrase, SkillProgression, NEWBIE_BEGS, NEWBIE_QUESTIONS, KILL_LINES, ESCAPE_LINES, vendorAdverts, vendorStock, TRADE_TALK, NEW_LINES, PK_LINES, UPSTREAM_LEVELUP, ANSWER_LINES, ANSWER_WORDS, PRACTICES, GEAR_LINES, REACTION_LINES, formatGp, SOCIAL_LINES, CLIQUE_LINES, allCliques, nickOf };
// (realism phase 5b, track P: scam callers) the callers' use of upstream's own lines
export { UPSTREAM_SCAM_LINES } from '#/engine/bot/port/BotScams.js';
// (the variety work, round 1, Track S: the slots a line may hold and their values; a seller's talk and breaks)
export * as Slots from '#/engine/bot/port/BotSlots.js';
export { VENDOR_BREAK, VENDOR_PATTER } from '#/engine/bot/tasks/VendorTask.js';
// (the variety work, round 2, Track S2: the threads' pools, the clans' names for {clan})
export { THREAD_LINES } from '#/engine/bot/port/BotThreads.js';

/** the name a vendor's adverts give a stock item (VendorTask: its alias, else the game's name) */
export function vendorItemName(item: { itemId: number; name: string; alias?: string }): string {
    return item.alias ?? ObjType.get(item.itemId)?.name ?? item.name;
}

/** (the realism work, phase 4) how VendorTask advertises a stock item: a rare, gear (equipment) or bulk */
export function advertKindOf(item: { itemId: number; rare?: boolean }): 'rare' | 'gear' | 'bulk' {
    return item.rare ? 'rare' : ObjType.get(item.itemId)?.wearpos !== -1 ? 'gear' : 'bulk';
}

/**
 * As World.start does (WordEnc reads data/raw/wordenc, whatever the directory), with the NPC names the activity lines
 * say ("Killing dark wizards": without them a line fell back to the debugname, "bearded_dark_wizards", which the game
 * never says) and the item names vendors advertise
 */
export function loadWordEnc(): void {
    WordEnc.load('data/pack');
    NpcType.load('data/pack');
    ObjType.load('data/pack');
}

/** What every bot line goes through (port/BotSay) and the server does to a human's public line. */
export function filter(text: string): string {
    return WordEnc.filter(text);
}

/**
 * Every level-up line a bot may say for every stat at `level` (port/BotLines: the 2004 forms with upstream's phrases
 * folded in, the ones the filter leaves whole), and every candidate before that check (to show how many it masks).
 */
export function levelUpLines(level: number): { said: string[]; candidates: string[] } {
    const said: string[] = [];
    const candidates: string[] = [];
    for (const stat of PlayerStatNameMap.values()) {
        if (stat === 'STAT18' || stat === 'STAT19') continue;
        said.push(...allLevelUpLines(stat, level));
        candidates.push(...levelUpCandidates(stat, level));
    }
    return { said, candidates };
}

/**
 * Does every character of the line survive the 274 chat codec (WordPack, as public chat and private messages travel)?
 * It carries lower-case letters (upper case is lowered), digits, the space and !?.,:;()-&*\'@#+=£$%"[] (a backslash
 * too); anything else (/ ^ _ < > ~ …) arrives as a space. Checked in pieces of 80 characters (the codec's limit;
 * BotSay splits a longer line).
 */
export function survivesWordPack(line: string): boolean {
    for (let i = 0; i < line.length; i += 80) {
        const part = line.slice(i, i + 80);
        const buf = Packet.alloc(0);
        WordPack.pack(buf, part);
        const length = buf.pos;
        buf.pos = 0;
        const unpacked = WordPack.unpack(buf, length);
        buf.release();
        // (an odd number of half-bytes leaves a padding space at the end)
        if (unpacked.slice(0, part.length).toLowerCase() !== part.toLowerCase()) return false;
    }
    return true;
}

/** The characters of the line the chat codec cannot carry (each arrives as a space). */
export function lostInWordPack(line: string): string[] {
    return [...new Set(line)].filter(c => !survivesWordPack(c));
}

/**
 * A human's public chat line as the bots hear it: the client packs it (WordPack: lower case, at most 80 characters),
 * MessagePublicHandler unpacks it (sentence case) and the runtime's hook filters it (hooks.ts: WordEnc.filter).
 */
export function heardLine(typed: string): string {
    const buf = Packet.alloc(0);
    WordPack.pack(buf, typed);
    const length = buf.pos;
    buf.pos = 0;
    const unpacked = WordPack.unpack(buf, length);
    buf.release();
    return WordEnc.filter(unpacked);
}
