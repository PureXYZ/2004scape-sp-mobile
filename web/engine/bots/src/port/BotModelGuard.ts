// port (the realism work, phase 7: the language model): what a model's line must pass before a bot says it; anything
// refused falls back to the rules' line (or nothing, where they had none). The foundation's first cut: one line of the
// chat's characters within 80, the game's word filter, and the plainest tells (assistant talk, things that did not
// exist in 2004, a bot owning up). Track E completed it (Guard a-f, and a
// language model's markup: "**bold**", "*winks*", which the base Qwen wrote in the first llama-server run):
//   (a) promises: offers or agreements to trade, follow, meet, give items or coins, come, teach ("ill give u 1k", "omw",
//       "meet me at edge", "wanna team?"), unless the rules' answer (the hint) made one: the rules decide what a bot does,
//       and a promise it would not keep is a tell;
//   (b) facts: a number next to a skill's name, "lvl", "cb", "combat" or "total" is the bot's own level, unless it is
//       about someone else ("ur 40 att"), a requirement or a goal ("need 40 att", "going for 70 wc", "3 more lvls"),
//       or the hint or the human's line has that number; "like 60" may be within 3. A direct answer about levels (the
//       hint's intent is one) keeps the hint's numbers. "im in/at <place>" is where the bot is (and with a "where r u"
//       hint every place named); a price is the hint's (or the human's own, or the coins the bot carries);
//   (c) repeats: not one of the bot's own lines of the last 10 minutes (Situation.said), not the human's line echoed
//       back; both only for lines of 2 words and 8 letters or more ("lol" twice is a person);
//   (d) the human's name at the persona's echo rate (port/BotChat rolls it: opts.keepName false drops the name);
//   (e) other players' names: only the human's, a friend's near the bot, one in its history or in the human's line
//       (opts.names: the players online; absent, not checked);
//   (f) "brb", "gtg", "afk" and the like: each is an effect line in the rules (an AFK or a logout that would not follow).
// The persona's style (port/BotStyle) runs after it, as on the new 2004 lines. Pure: no dice and no game state beyond
// what it is given (Track L's checker runs it over the writers' replies with the captured situations).
import WordEnc from '#/cache/wordenc/WordEnc.js';
import { MAX_LINE } from '#/engine/bot/port/BotSay.js';
import type { Situation } from '#/engine/bot/port/BotModelTypes.js';

export interface GuardResult {
    ok: boolean;
    /** the line as cleaned (when ok) */
    text: string;
    /** why it was refused */
    reason?: string;
}

/** (Track E) what the guard is told beyond the situation (both optional: Track L's checker passes neither) */
export interface GuardOptions {
    /** the persona's echo roll (port/BotChat): false drops the human's name from the line; true or absent keeps it as written */
    keepName?: boolean;
    /** the display names of the players in the world, for (e); absent: names are not checked */
    names?: Iterable<string>;
}

/** every reason a line is refused (the stats and the tests) */
export const GUARD_REASONS = ['empty', 'charset', 'long', 'assistant', 'anachronism', 'confession', 'filter', 'markup', 'effect', 'promise', 'level', 'place', 'price', 'echo', 'repeat', 'name'] as const;
export type GuardReason = (typeof GUARD_REASONS)[number];

/** the characters 274's chat codec carries (port/BotStyle's, lower-cased) */
const CHARSET = /^[a-z0-9 !?.,:;()\-&*'@#+=£$%"[\]]*$/;
/** typographic characters a model writes, as the chat has them */
const PLAIN: readonly [RegExp, string][] = [
    [/[‘’‛′]/g, "'"],
    [/[“”‟″]/g, '"'],
    [/[–—−]/g, '-'],
    [/…/g, '...'],
    [/[   ]/g, ' ']
];
/** an assistant's phrasing */
const ASSISTANT = /\b(as an ai|language model|i'?m an ai|i am an ai|happy to help|i'?d be happy|certainly[,!]|great question|feel free|let me know if|is there anything else|how can i (help|assist)|i can'?t assist|i'?m sorry, but)\b/i;
/** what did not exist in late 2004 (the model's lines only: upstream's own lines keep theirs) */
const ANACHRONISM = /\b(grand exchange|g\.?e\.?|slayer|construction|hunter|summoning|dungeoneering|osrs|old ?school|rs3|runescape 3|jagex account|wiki|discord|twitch|youtube|reddit|tiktok|instagram|iphone|android|smartphone|chatgpt|gpt|chatbot|emoji|twitter|tweet|streamer|stream)\b/i;
/** a bot owning up */
const CONFESSION = /\b(i'?m|i am|im) (a |an )?(bot|ai|robot|program|npc|computer)\b/i;
/** (the integration, Track L's evaluation) "lol! yeah, just a bot": owning up without "i'm", unless it is said of someone else */
const CONFESSION_BARE = /\b(just|only|really|actually) (a |an )?(bot|ai|robot|program)\b/i;
const OF_SOMEONE_ELSE = /\b(ur|you'?re|youre|u r|you are|u are|he'?s|hes|she'?s|shes|they'?re|theyre|that'?s|thats|its|it'?s|he|she|they|u|you)\s+(just|only|really|actually) (a |an )?(bot|ai|robot|program)\b/i;
/** (the integration) the 2004 quests whose names hold a word of ANACHRONISM (Track L: a hint's "demon slayer, its easy" was refused) */
const QUEST_NAMES = /\b(demon|dragon|vampire) slayer\b/gi;
/** (the integration) slang that came long after 2004 (model lines only) */
const MODERN_SLANG = /\b(rizz|rizzler|bruh|no cap|lowkey|highkey|ngl|fr fr|bussin|yeet|yeeted|pog|poggers|pogchamp|simp|simping|goated|gyatt|skibidi|sigma|sus|vibe check|deadass|on god|dg)\b/i;
/** (Track E) a language model's markup: markdown ("**al kharid**", "__x__") and stage directions in asterisks ("*winks*"); backticks the chat cannot carry are dropped before */
const MARKUP = /\*\*|__|\*[a-z][a-z' ]*\*/i;

// ---- (f) effect lines: the rules' AFKs and logouts ----
const EFFECT = /\b(brb|b r b|gtg|g2g|got ?2 ?go|gotta go|got to go|afk|bbl|be right back|be back later|back in a (sec|min|bit)|log(ging)? (off|out)|going to (bed|sleep)|off to bed|gonna log)\b/gi;
/** the words before one that make it the human's ("r u afk?"), not the bot's */
const ASKED_OF_YOU = /\b(u|you|ur|youre|r u|are you|are u|were you|was u|did u|did you)\s+$/i;

// ---- (a) promises ----
const PROMISES: readonly RegExp[] = [
    // (the review of the merge: a goods or service promise needs the human as its object, "ill give u", "i can show u"
    // ("i could buy one later" is a plan); coming, following, meeting and guarding are promises as they are)
    /\b(i'?ll|ill|i will|i can|i could|lemme|let me|i'?m gonna|im gonna|i am gonna|i'?m going to|im going to)\s+(come|follow|meet|guard|protect|walk with|tele|teleport)\b/i,
    /\b(i'?ll|ill|i will|i can|i could|lemme|let me|i'?m gonna|im gonna|i am gonna|i'?m going to|im going to)\s+(give|trade|sell|buy|lend|loan|teach|show|bring|drop|pay)\s+(?:\w+\s+){0,2}?(u|you|ya|ur|your)\b/i,
    /\b(meet|see)\s+(you|u|ya)\s+(at|in|there|by|near)\b/i,
    /\b(meet me|follow me|come with me|come here|come to me|trade me|duel me|add me|wait for me|wait here)\b/i,
    /\b(i'?m|im|i am)\s+(coming|heading (over|there))\b/i,
    /\b(omw|on my way|be right there|be there in)\b/i,
    /\bhere (u go|you go|take (it|this))\b|\btake (this|some|mine|my)\b/i,
    // (an invitation: at the line's start, after a word ("lol wanna duel"), or "u/we wanna ..."; "i want to train fletch
    // after" is a plan and "lets go!" an exclamation: the review of the merge)
    /^(?:(?!(?:i|im|i'm)\b)[a-z']+[,!.]?\s+)?(wanna|want to|lets|let's|let us)\s+(trade|team|duel|meet|train|pk|fight|quest|skill|hunt|go\s+(?!$|[!.?])\S)/i,
    /\b(u|you|we)\s+(wanna|want to)\s+(trade|team|duel|go|meet|train|pk|fight|quest|skill|hunt)\b/i,
    /\bfree (stuff|items?|armou?r|gp|coins|money|gear|food)\b/i
];

// ---- (a') a yes the rules never gave (the review of the merge): to "r u a bot", to a beg they turned down ----
/** the human asks whether the bot is a bot ("r u a bot", "bot?", "ur a macroer") */
const ASKED_BOT = /\b(r|are|is)\s+(u|you|ya|this|that)\s+(a\s+)?(bot|botter|botting|macro|macroer|macroing|auto|autoer|autoing|ai|robot|program)\b|^\s*(bot|macro|macroer|botter)\s*\?*\s*$|\b(ur|youre|you're|u r)\s+(a\s+)?(bot|botter|macro|macroer|robot)\b|\bu\s+(a\s+)?(bot|macroer|botter|robot)\s*\?/i;
/** a reply that opens with a yes */
const AFFIRMATIVE = /^\s*(yes|ya|yah|yeah|yea|yep|yup|ye|yh|i am|maybe|kinda|sorta|true|correct)\b/i;
/** a reply that opens with an "ok" to giving something */
const GIVE_YES = /^\s*(sure|ok|okay|k|kk|ya|yah|yeah|yea|yes|yep|yup|np|here|fine|alright|aight)\b/i;
/** a no anywhere in the reply ("ya right no", "yes... no lol") */
const NEGATION = /\b(no|nah|nope|not|never|dont|don't|isnt|isn't|aint|wtf)\b/i;
/** the rules' intents of a beg (port/BotAnswers' 'beg', the JSON's 'begging'): their answers all refuse */
const BEG_INTENTS: ReadonlySet<string> = new Set(['beg', 'begging']);

// ---- (b) facts: levels ----
/** a skill as players named it, by its short name (ambiguous words are left out: "fish", "mine", "cook" and "hits" count things) */
const STAT_WORDS: Readonly<Record<string, string>> = {
    att: 'att', atk: 'att', attack: 'att', str: 'str', strength: 'str', def: 'def', defence: 'def', defense: 'def', hp: 'hp', hitpoints: 'hp',
    range: 'range', ranged: 'range', ranging: 'range', pray: 'pray', prayer: 'pray', mage: 'mage', magic: 'mage', cooking: 'cook', wc: 'wc',
    woodcut: 'wc', woodcutting: 'wc', fletch: 'fletch', fletching: 'fletch', fishing: 'fish', fm: 'fm', firemaking: 'fm', craft: 'craft',
    crafting: 'craft', smith: 'smith', smithing: 'smith', mining: 'mine', herb: 'herb', herblore: 'herb', agil: 'agil', agility: 'agil',
    thief: 'thief', thieving: 'thief', rc: 'rc', runecraft: 'rc', runecrafting: 'rc'
};
const COMBAT_WORDS: ReadonlySet<string> = new Set(['cb', 'combat']);
const TOTAL_WORDS: ReadonlySet<string> = new Set(['total', 'overall']);
const LEVEL_WORDS: ReadonlySet<string> = new Set(['lvl', 'lvls', 'level', 'levels', 'lv']);
/** words before a number that make it someone else's, a requirement or a goal, not a claim about the bot */
const NOT_ITS_OWN: ReadonlySet<string> = new Set([
    'u', 'you', 'ur', 'your', 'youre', 'yours', 'he', 'she', 'his', 'her', 'hes', 'shes', 'they', 'their', 'theyre', 'them', 'him', 'ppl', 'people', 'someone', 'some1', 'everyone',
    'need', 'needs', 'req', 'reqs', 'require', 'requires', 'required', 'requirement', 'for', 'till', 'til', 'until', 'to', 'more', 'another', 'over', 'under', 'than', 'least',
    'min', 'minimum', 'max', 'aim', 'aiming', 'want', 'wanna', 'going', 'goin', 'gonna', 'get', 'getting', 'reach', 'when'
]);
/** a hedge: "like 60 wc" may be within 3 */
const HEDGES: ReadonlySet<string> = new Set(['like', 'about', 'around', 'almost', 'nearly', 'bout', 'roughly', 'abt', 'close', 'prob', 'probably']);
/** the rules' intents that answer a level directly (their numbers are the facts) */
const LEVEL_INTENTS: ReadonlySet<string> = new Set(['combat', 'skill', 'total', 'attack', 'strength', 'defence', 'hitpoints', 'ranged', 'prayer', 'magic', 'cooking', 'woodcutting', 'fletching', 'fishing', 'firemaking', 'crafting', 'smithing', 'mining', 'herblore', 'agility', 'thieving', 'runecraft']);

// ---- (b) facts: places (274's towns and landmarks as players named them; port/BotAnswers' TOWNS, port/BotPlaces) ----
const PLACES: readonly [string, readonly string[]][] = [
    ['lumbridge', ['lumbridge', 'lumby', 'lumbrige', 'lumbridge castle']],
    ['lumbridge swamp', ['lumbridge swamp', 'lumby swamp', 'the swamp']],
    ['varrock', ['varrock', 'varock', 'varrok']],
    ['falador', ['falador', 'fally', 'fallador', 'faly']],
    ['draynor', ['draynor', 'draynor village']],
    ['draynor manor', ['draynor manor']],
    ['al kharid', ['al kharid', 'alkharid', 'kharid']],
    ['edgeville', ['edgeville', 'edge', 'edgville']],
    ['port sarim', ['port sarim', 'sarim']],
    ['rimmington', ['rimmington', 'rimmy']],
    ['barbarian village', ['barbarian village', 'barb village']],
    ['karamja', ['karamja', 'musa point']],
    ['wilderness', ['wilderness', 'wildy', 'wild']],
    ['duel arena', ['duel arena']],
    ['taverley', ['taverley', 'taverly']],
    ['burthorpe', ['burthorpe']],
    ['catherby', ['catherby']],
    ['camelot', ['camelot', 'cammy']],
    ['seers', ['seers', 'seers village']],
    ['ardougne', ['ardougne', 'ardy']],
    ['yanille', ['yanille']],
    ['brimhaven', ['brimhaven']],
    ['entrana', ['entrana']],
    ['shilo village', ['shilo village', 'shilo']],
    ['port khazard', ['port khazard', 'khazard']],
    ['witchaven', ['witchaven']],
    ['gnome stronghold', ['gnome stronghold', 'tree gnome stronghold']],
    ['tree gnome village', ['tree gnome village', 'gnome village']],
    ['barbarian outpost', ['barbarian outpost', 'barb outpost']],
    ['white wolf mountain', ['white wolf mountain']],
    ['ice mountain', ['ice mountain']],
    ['monastery', ['monastery']],
    ['goblin village', ['goblin village']],
    ['crafting guild', ['crafting guild']],
    ['champions guild', ['champions guild', 'champs guild']],
    ['fishing guild', ['fishing guild']],
    ['dwarven mine', ['dwarven mine', 'dwarf mine']],
    ['dungeon', ['dungeon']]
];
const PLACE_KEY = new Map<string, string>(PLACES.flatMap(([key, aliases]) => aliases.map(alias => [alias, key] as [string, string])));
const PLACE_ALTERNATION = [...PLACE_KEY.keys()].sort((a, b) => b.length - a.length).map(escapeRx).join('|');
const PLACE_RX = new RegExp(`\\b(${PLACE_ALTERNATION})\\b`, 'g');
/** the rules' intents whose answer is the way somewhere or where the bot is: a reply names no other place */
const STRICT_PLACE_INTENTS: ReadonlySet<string> = new Set(['directions', 'whereami', 'bank', 'town']);
/** "im in lumby", "i'm at the draynor willows", "im near fally" */
const PLACE_CLAIM = new RegExp(`\\b(?:i'?m|i am|im)\\s+(?:just\\s+|still\\s+|now\\s+)?(?:at|in|on|near|by|around|outside|inside)\\s+(?:the\\s+)?(${PLACE_ALTERNATION})\\b`, 'i');

// ---- (b) facts: prices ----
/** an amount: "15k", "1.2m" (the k or m written on), "500gp", "160 ea", "12 coins"; a number inside a word is none ("kevin1991") */
const MONEY = /(?<![a-z0-9.])(\d+(?:\.\d+)?)(?:(k|m|mil)\b|\s*(gp|coins?|ea|each)\b)?(?![a-z0-9])/gi;

/**
 * The model's raw text as a line a bot may say, or why not. `s` is the situation it was written for (null: only the
 * checks that need none); `opts` the persona's echo roll and who is online (port/BotModel passes both).
 */
export function guardReply(raw: string | null | undefined, s: Situation | null, opts: GuardOptions = {}): GuardResult {
    if (typeof raw !== 'string') return refuse('empty');
    let text = raw.replace(/\r/g, '').split('\n').find(l => l.trim().length > 0) ?? '';
    for (const [rx, to] of PLAIN) text = text.replace(rx, to);
    text = text.trim();
    // (a speaker's name in front, the prompt's "[pm]" mark, quotes around it)
    text = text.replace(/^\[pm\]\s*/i, '');
    if (s) {
        const prefix = new RegExp(`^(${escapeRx(s.bot.name)}|me|you)\\s*:\\s*`, 'i');
        text = text.replace(prefix, '');
    }
    text = text.replace(/^["'`]+|["'`]+$/g, '').replace(/\s{2,}/g, ' ').trim();
    if (!text) return refuse('empty');
    // (characters the codec drops: a few go, more is a line in another script or full of emoji)
    let dropped = 0;
    text = [...text].filter(ch => (CHARSET.test(ch.toLowerCase()) ? true : (dropped++, false))).join('').replace(/\s{2,}/g, ' ').trim();
    if (dropped > 3 || !text) return refuse('charset');
    if (text.length > MAX_LINE) {
        const cut = text.lastIndexOf(' ', MAX_LINE);
        if (cut < MAX_LINE * 0.6) return refuse('long');
        text = text.slice(0, cut).replace(/[,;:\-]+$/, '');
    }
    if (ASSISTANT.test(text)) return refuse('assistant');
    // (a word the rules' own answer has is not the model's anachronism: their hint can name a 2004 quest)
    const plainText = text.replace(QUEST_NAMES, '');
    const anachronism = plainText.match(ANACHRONISM);
    if (anachronism && !(s?.hint && new RegExp(`\\b${escapeRx(anachronism[0])}\\b`, 'i').test(s.hint.text.replace(QUEST_NAMES, '')))) return refuse('anachronism');
    if (MODERN_SLANG.test(text)) return refuse('anachronism');
    if (CONFESSION.test(text) || (CONFESSION_BARE.test(text) && !OF_SOMEONE_ELSE.test(text))) return refuse('confession');
    if (WordEnc.filter(text) !== text) return refuse('filter');
    if (MARKUP.test(text)) return refuse('markup');
    if (!s) return { ok: true, text };

    const hint = s.hint?.text ?? '';
    // (f) an AFK or a logout the rules would not follow
    if (effectLine(text) && !effectLine(hint)) return refuse('effect');
    // (a) a promise the rules did not make
    if (PROMISES.some(rx => rx.test(text) && !rx.test(hint))) return refuse('promise');
    // (a') a yes to "r u a bot" owns up; a yes to a beg the rules turned down promises (the review of the merge)
    if ((s.hint?.intent === 'bot' || ASKED_BOT.test(s.heard.text)) && AFFIRMATIVE.test(text) && !NEGATION.test(text)) return refuse('confession');
    if (s.hint && BEG_INTENTS.has(s.hint.intent) && GIVE_YES.test(text) && !NEGATION.test(text)) return refuse('promise');
    // (b) facts
    const fact = factProblem(text, s);
    if (fact) return refuse(fact);
    // (c) the human's line echoed back, one of its own lines again
    const said = norm(text);
    const heard = norm(withoutName(s.heard.text, s.bot.name));
    if (substantial(heard) && (said === heard || (heard.length >= 12 && said.includes(heard)))) return refuse('echo');
    if ((s.said ?? []).some(own => substantial(norm(own)) && norm(own) === said)) return refuse('repeat');
    // (e) another player's name, not one the bot can know
    if (opts.names && otherName(text, s, opts.names)) return refuse('name');
    // (d) the human's name at the persona's rate
    if (opts.keepName === false) {
        text = withoutName(text, s.human.name);
        if (!text) return refuse('empty');
        if (WordEnc.filter(text) !== text) return refuse('filter');
    }
    return { ok: true, text };
}

function refuse(reason: GuardReason): GuardResult {
    return { ok: false, text: '', reason };
}

/** (f) the line says the bot goes AFK or leaves ("brb", "gtg", "afk lol"), not asked of the human ("r u afk?") */
function effectLine(text: string): boolean {
    for (const m of text.matchAll(EFFECT)) if (!ASKED_OF_YOU.test(text.slice(0, m.index))) return true;
    return false;
}

// ── (b) facts ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** the first fact of the line that contradicts the situation ('level', 'place', 'price'), or null */
function factProblem(text: string, s: Situation): GuardReason | null {
    const hint = s.hint?.text ?? '';
    const hintNumbers = numbersIn(hint);
    const heardNumbers = numbersIn(s.heard.text);
    const tokens = tokensOf(text);
    const claims = levelClaims(tokens);
    // a direct answer about levels keeps the hint's numbers (a number of its own, not next to a skill's name)
    if (s.hint && LEVEL_INTENTS.has(s.hint.intent) && hintNumbers.size > 0) {
        for (let i = 0; i < tokens.length; i++) {
            if (!/^\d{1,4}$/.test(tokens[i]) || claims.some(c => c.index === i)) continue;
            const n = Number(tokens[i]);
            if (!hintNumbers.has(n) && !heardNumbers.has(n)) return 'level';
        }
    }
    for (const claim of claims) {
        if (hintNumbers.has(claim.n) || heardNumbers.has(claim.n)) continue;
        const before = tokens.slice(Math.max(0, claim.at - 3), claim.at);
        if (before.some(w => NOT_ITS_OWN.has(w))) continue;
        const slack = claim.hedged || before.some(w => HEDGES.has(w)) || tokens[claim.end + 1] === 'ish' ? 3 : 0;
        if (!truthsFor(claim, s).some(v => Math.abs(v - claim.n) <= slack)) return 'level';
    }
    // places
    const here = new Set<string>([...placeKeys(s.facts.place ?? ''), ...placeKeys(s.facts.activity ?? '')]);
    if (s.facts.wilderness > 0) here.add('wilderness');
    if (s.hint?.intent === 'whereami') for (const k of placeKeys(hint)) here.add(k);
    const claimed = PLACE_CLAIM.exec(text.toLowerCase());
    if (claimed && !here.has(PLACE_KEY.get(claimed[1].toLowerCase()) ?? '')) return 'place';
    if (s.hint?.intent === 'whereami' && [...placeKeys(text)].some(k => !here.has(k))) return 'place';
    // (the integration's http run: "where do u fish sharks" -> "fishing guild i think, near lumby", the rules' answer the
    // guild's alone) an answer about where things are names only places the situation has: the rules' answer, the human's
    // line, the lines before, where the bot is and works
    // (the integration's second run: "where do i respawn" -> "lumbridge", "where do i get an egg" -> "the chicken farm near
    // lumby" are a player's knowledge, right, and were refused: only where the rules' answer names a place, or gives the
    // way somewhere, must the reply keep to the places the situation has)
    const hintPlaces = placeKeys(hint);
    if (s.hint && (hintPlaces.size > 0 || STRICT_PLACE_INTENTS.has(s.hint.intent))) {
        const ground = new Set<string>([...here, ...hintPlaces, ...placeKeys(s.heard.text), ...s.history.flatMap(l => [...placeKeys(l.text)])]);
        if ([...placeKeys(text)].some(k => !ground.has(k))) return 'place';
    }
    // prices
    const priceTalk = s.hint?.intent === 'price';
    const asked = moneyIn(text, priceTalk);
    if (asked.length > 0) {
        const known = [...moneyIn(hint, true), ...moneyIn(s.heard.text, true)];
        for (const c of s.facts.carrying) if (c.startsWith('coins ')) known.push(...moneyIn(c.slice(6), true));
        for (const v of asked) if (!known.some(k => Math.abs(k - v) <= Math.max(1, k * 0.02))) return 'price';
    }
    return null;
}

interface LevelClaim {
    n: number;
    kind: 'skill' | 'combat' | 'total' | 'level';
    /** the skill's short name (kind 'skill') */
    stat: string | null;
    /** the number's token, and the claim's first and last */
    index: number;
    at: number;
    end: number;
    /** "cb is like 45": a hedge between the words */
    hedged: boolean;
}

type LevelWord = { kind: LevelClaim['kind']; stat: string | null };

function levelWord(word: string | undefined): LevelWord | null {
    if (word === undefined) return null;
    if (STAT_WORDS[word]) return { kind: 'skill', stat: STAT_WORDS[word] };
    if (COMBAT_WORDS.has(word)) return { kind: 'combat', stat: null };
    if (TOTAL_WORDS.has(word)) return { kind: 'total', stat: null };
    if (LEVEL_WORDS.has(word)) return { kind: 'level', stat: null };
    return null;
}

/** words between a skill's name and its number ("wc is 60", "cb is like 45", "wc at 60 now") */
const BETWEEN: ReadonlySet<string> = new Set(['is', 'at', 'was', 'only', 'just', 'now', 'like', 'about', 'around', 'bout', 'almost', 'nearly']);
/** "lvl" and "level" after a number: one level ("45 lvl"); "3 lvls", "2 levels" count levels and claim none */
const ONE_LEVEL: ReadonlySet<string> = new Set(['lvl', 'level', 'lv']);

/** "60 wc", "45 cb", "600 total", "60 lvl wc", "wc 60", "cb 45", "lvl 45", "wc lvl 60", "my wc is 60" */
function levelClaims(tokens: string[]): LevelClaim[] {
    const out: LevelClaim[] = [];
    for (let i = 0; i < tokens.length; i++) {
        if (!/^\d{1,4}$/.test(tokens[i])) continue;
        const n = Number(tokens[i]);
        let word = levelWord(tokens[i + 1]);
        let at = i;
        let end = i + 1;
        let hedged = false;
        if (word?.kind === 'level') {
            const more = levelWord(tokens[i + 2]);
            if (more && more.kind !== 'level') {
                word = more;
                end = i + 2;
            } else if (!ONE_LEVEL.has(tokens[i + 1])) word = null;
        }
        if (!word) {
            let j = i - 1;
            for (let k = 0; k < 2 && BETWEEN.has(tokens[j]); k++) {
                if (HEDGES.has(tokens[j])) hedged = true;
                j--;
            }
            const back = levelWord(tokens[j]);
            if (back && (back.kind !== 'level' || ONE_LEVEL.has(tokens[j]))) {
                word = back;
                at = j;
                end = i;
                if (back.kind === 'level') {
                    const more = levelWord(tokens[j - 1]);
                    if (more && more.kind !== 'level') {
                        word = more;
                        at = j - 1;
                    }
                }
            }
        }
        if (word) out.push({ n, kind: word.kind, stat: word.stat, index: i, at, end, hedged });
    }
    return out;
}

/** what the claim could truly be: its skill's level, the combat level, the total; a bare "lvl" is any of those the talk is about */
function truthsFor(claim: LevelClaim, s: Situation): number[] {
    const f = s.facts;
    // (hitpoints: the level, or the hitpoints it has now: "8 hp lol" to "u low hp?" at 8 of 11; the round-2 data)
    if (claim.kind === 'skill' && claim.stat === 'hp') return [f.levels.hp, f.hp[0]].filter((v): v is number => v !== undefined);
    if (claim.kind === 'skill') return claim.stat !== null && f.levels[claim.stat] !== undefined ? [f.levels[claim.stat]] : [];
    if (claim.kind === 'combat') return [f.combat];
    if (claim.kind === 'total') return [f.total];
    const out = [f.combat, f.total];
    for (const text of [s.heard.text, s.hint?.text ?? '']) {
        for (const t of tokensOf(text)) {
            const word = levelWord(t);
            if (word?.kind === 'skill' && word.stat !== null && f.levels[word.stat] !== undefined) out.push(f.levels[word.stat]);
        }
    }
    return out;
}

/** the line's words; a level word written onto its number comes apart ("lvl60", "45cb", "60wc"), a name's digits do not ("kevin1991") */
function tokensOf(text: string): string[] {
    const out: string[] = [];
    const words = text.toLowerCase().replace(/'/g, '').replace(/\.(?!\d)/g, ' ').replace(/[^a-z0-9.]+/g, ' ').trim().split(/\s+/);
    for (const w of words) {
        if (!w) continue;
        const front = /^([a-z]+)(\d+)$/.exec(w);
        const back = /^(\d+)([a-z]+)$/.exec(w);
        if (front && levelWord(front[1])) out.push(front[1], front[2]);
        else if (back && levelWord(back[2])) out.push(back[1], back[2]);
        else out.push(w);
    }
    return out;
}

function numbersIn(text: string): Set<number> {
    const out = new Set<number>();
    for (const t of tokensOf(text)) if (/^\d{1,7}$/.test(t)) out.add(Number(t));
    return out;
}

/** the places a text names, by their keys */
function placeKeys(text: string): Set<string> {
    const out = new Set<string>();
    for (const m of text.toLowerCase().matchAll(PLACE_RX)) {
        const key = PLACE_KEY.get(m[1]);
        if (key) out.add(key);
    }
    return out;
}

/** amounts of coins in a text ("160 ea", "1.2k", "15k", "2m", "500gp"); `bare`: plain numbers count too (talk about a price) */
function moneyIn(text: string, bare: boolean): number[] {
    const out: number[] = [];
    for (const m of text.toLowerCase().matchAll(MONEY)) {
        const times = m[2] ?? '';
        if (!bare && !times && !m[3]) continue;
        const n = Number(m[1]);
        if (!Number.isFinite(n)) continue;
        out.push(times === 'k' ? n * 1000 : times ? n * 1_000_000 : n);
    }
    return out;
}

// ── (c), (d), (e): words and names ──────────────────────────────────────────────────────────────────────────────

/** lower case, letters and digits, single spaces (names: "_" and "-" as spaces) */
function norm(text: string): string {
    return text.toLowerCase().replace(/[_-]/g, ' ').replace(/'/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** a line worth the repeat and echo checks: 2 words and 8 letters or more */
function substantial(normed: string): boolean {
    return normed.length >= 8 && normed.split(' ').length >= 2;
}

/** a line the repeat and echo checks look at (2 words and 8 letters or more, as the chat's words) */
export function substantialLine(text: string): boolean {
    return substantial(norm(text));
}

/** `text` without `name` (any case, its words joined by spaces, "_", "-" or nothing), and the comma it leaves */
export function withoutName(text: string, name: string): string {
    const words = norm(name).split(' ').filter(Boolean);
    if (words.length === 0) return text;
    const rx = new RegExp(`(^|[^a-z0-9])${words.map(escapeRx).join('[ _-]*')}(?=$|[^a-z0-9])`, 'gi');
    return text
        .replace(rx, '$1')
        .replace(/\s+([,?!.])/g, '$1')
        .replace(/,\s*,/g, ',')
        .replace(/^[\s,]+|[\s,]+$/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * a player's name in the line the bot cannot know (not the human's, its own, a friend's near it, one in its history or
 * the human's line). Only names with a digit count ("kevin1991", "Battle Axe 9"): more than half the bots' names are
 * plain words or phrases ("Cheers Mate", "Just Chillin", "Rune Miner", "Black Arrow"), and a line using those words is
 * no name (the review of the merge: 3 of the 300 held-out lines were refused with all the names online).
 */
function otherName(text: string, s: Situation, names: Iterable<string>): string | null {
    const allowed = new Set<string>([s.human.name, s.bot.name, ...s.facts.friendsNear, ...s.history.map(l => l.name)].map(norm));
    const said = ` ${norm(text)} `;
    const heard = ` ${norm(s.heard.text)} `;
    for (const name of names) {
        const n = norm(name);
        if (n.length < 3 || allowed.has(n) || !/\d/.test(n)) continue;
        const forms = n.includes(' ') ? [n, n.replace(/ /g, '')] : [n];
        if (forms.some(f => said.includes(` ${f} `) && !heard.includes(` ${f} `))) return name;
    }
    return null;
}

function escapeRx(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
