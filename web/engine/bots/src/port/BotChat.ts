// The bots' chat AI, the vendor marketplace and the "come here" private message: Progressive's additions to its
// rev-254 Player.ts (sendMessageToNearbyBots … getGreeting), MessagePublicHandler and MessagePrivateHandler, as free
// functions. The runtime glue calls onPublicMessage after the stock public-chat handler accepted a human's line and
// onPrivateMessage from World.sendPrivateMessage (BOTS.md §4.2).
//
// port changes:
//   - A bot is addressed only by its whole name on word boundaries ("hi yew cutter"). Upstream stripped the digits
//     from the name and matched any fragment, so with its sk1/fi1/ra1 names "ask", "fish" and "trade" got answers.
//     Once addressed, a bot keeps answering that player for 30 s (upstream's engaged conversation), but only lines it
//     understands and not lines that name another bot (upstream answered everything, with fillers such as "Can you
//     say that another way?", and two bots greeted in turn both answered every line).
//   - Replies are scheduled in world ticks (port/BotSchedule), not with setTimeout; cooldowns are in ticks.
//   - Conversation memory lives in a side table instead of a field on every Player.
//   - A bot that ended a conversation ("Alright, I'm off for now.") listens again after 30 s; upstream's stayed mute
//     until the server restarted. {total} is the total level (upstream gave the Attack level). {name} is the
//     speaker's display name.
//   - The marketplace takes only clear requests for real items, and the line still reaches the bots' chat
//     (getRequestedTradeText, handleVendorMarketplaceMessage).
//   - "come here": only a PKer follows a player into the Wilderness (handleBotPrivateCommand, port/ComeHereTask).
//   - Every line a bot says goes through the game's word filter (port/BotSay), which also reads across words: a
//     reply is put together (greeting and answer, a "lol" or ":D") only where the filter leaves the whole line alone.
//   - Chat (Phase 2): a bot is also addressed by its name typed without its spaces or with its
//     letters and digits apart, by its first name where no other bot in earshot has it, and by the next line within
//     30 s of something it said unprompted, when that line is a greeting or a question it understands; "gz" after a
//     level-up line gets a "ty", and a "hi" meant for nobody now and then a "hi" back. Bots answer private messages,
//     and a friend bot now and then messages the player first.
//   - The realism work, phase 2: the conversation:
//       - a reply takes a person's time: it reads the line, thinks and types it at its own speed (port/BotTiming,
//         port/BotPersona), a long one in parts each typed in turn, one line at a time; the conversation's 30 s run
//         from when the reply is said (upstream: 1.2-2.4 s for any length, about 16 characters a second);
//       - a greeting answers only a greeting ("hey X" → "hey", "sup"); content gets its answer without upstream's
//         "Yes Casey?" in front; the human's name comes in about one reply in five (by persona); a named line no intent
//         understands now and then gets "?" or "wat" (a rude one's), else nothing;
//       - new intents answered from the bot's state (port/BotAnswers: directions, the nearest bank, prices, asl, PK
//         invites, "follow me" (a short real Follow for a sociable bot that is free: port/BotFollow), play time,
//         quests, "u there?", "wanna team up", begging, where to mine, fish or cut, newbie questions, item slang);
//       - a question or request said to nobody gets at most one bot's answer (floor control: by helpfulness and
//         distance, not a busy bot nor one talking with someone else) and now and then a second bot's;
//       - bots answer bots (onBotLine): a question, a level-up's gz and the leveller's ty, a hello, with chains of at
//         most 3 lines and cooldowns per bot and per area; a bot that is away (port/BotHabits) hears nothing;
//       - the marketplace answers in character: the vendor's private message ("i got lobs 160 ea, at varrock west
//         bank") or its line when it is near; no game message and no hint arrow (upstream's mod feature, not 2004);
//       - every reply text to a human is made by composeReply (the rules' intent, the bot's state and persona → a
//         line), which a language model may replace later (phase 7); adverts, trades, PK and "come here" stay rules;
//       - exchanges between two bots near a human (port/BotStage) and reactions to a human (port/BotReactions) are
//         ticked from here (tickTalk).
//   - The realism work, phase 7 (the language model): with a model there
//     (Settings › Bot chat, port/BotModel), a reply in its scope (wantsModel: the vias named, window, conversation,
//     crowd, second and private, not a rules-only intent, not a rude line) is worded by it: the rules decide whether
//     and when, the request carries the bot's situation (port/BotModelPrompt), the answer passes the guard and the
//     persona's style (port/BotStyle) and is said at max(its arrival + 1, the decision + the extra ticks + its typing
//     time), one line at a time; with no usable answer by the deadline (20 ticks) the rules' line at once, or nothing
//     where they had none; a newer reply of the bot's supersedes it. Lines the rules leave unanswered get a model reply
//     now and then (a named line or a PM: the persona's chance; a conversation's line 0.75; a reply-window answer 0.6; a
//     question to nobody: the crowd's chance, one responder), on chatDice. Without a model (every sim) nothing of this
//     draws a die: the world is the rules' as before.
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import WordEnc from '#/cache/wordenc/WordEnc.js';
import { Inventory } from '#/engine/Inventory.js';
import { MoveSpeed } from '#/engine/entity/MoveSpeed.js';
import { isClientConnected } from '#/engine/entity/NetworkPlayer.js';
import Npc from '#/engine/entity/Npc.js';
import Player from '#/engine/entity/Player.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import World from '#/engine/World.js';
import MessagePrivate from '#/network/game/server/model/MessagePrivate.js';
import Environment from '#/util/Environment.js';
import { toBase37, toDisplayName } from '#/util/JString.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { botWalkPath, pathBudgetLeft } from '#/engine/bot/port/BotPathing.js';
import { scheduleInTicks } from '#/engine/bot/port/BotSchedule.js';
import { ComeHereTask, WILDERNESS_REFUSALS, adjacentFreeTile, followsIntoWilderness, outsideWilderness, pickWildernessRefusal } from '#/engine/bot/port/ComeHereTask.js';
import { botSay, lastChatAt, splitLine, type LineKind } from '#/engine/bot/port/BotSay.js';
import { lastHeard, lastSpokenTo, noteSpoke } from '#/engine/bot/port/BotSpoke.js';
import { ChatModePrivate } from '#/engine/entity/ChatModes.js';
import { itemByNickname, VENDOR_ALIASES, vendorAskOf, vendorStock } from '#/engine/bot/tasks/VendorTask.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { activityLine } from '#/engine/bot/port/BotActivity.js';
import { botEmote, type Emote } from '#/engine/bot/port/BotEmote.js';
import { placePhrase } from '#/engine/bot/port/BotPlaces.js';
import { personaOf, type Persona } from '#/engine/bot/port/BotPersona.js';
import { reactionTicks, typingTicks } from '#/engine/bot/port/BotTiming.js';
import { isAway } from '#/engine/bot/port/BotHabits.js';
import { freshLine, skillShort } from '#/engine/bot/port/BotLines.js';
// (the variety work, round 1, S9: a friend's first message is about what it does, or a level it just got)
import { recentEventsOf } from '#/engine/bot/port/BotChatter.js';
// (the variety work, round 2, the fixes: B3, the conversation's new chains each in the place of a line of its own)
import { countAsOwnLine } from '#/engine/bot/port/BotChatter.js';
import { ANSWER_LINES, CROWD_INTENTS, expandSlang, itemKey, stateAnswer, type StateAnswer } from '#/engine/bot/port/BotAnswers.js';
import { FollowTask } from '#/engine/bot/port/BotFollow.js';
import { buyPrice, categoryOf, formatGp, isRare, sellPrice } from '#/engine/bot/port/BotPrices.js';
import { stallOf } from '#/engine/bot/port/BotTradeSpots.js';
import { inPractice, tickStage } from '#/engine/bot/port/BotStage.js';
import { tickReactions } from '#/engine/bot/port/BotReactions.js';
// (the variety work, round 2, Track S2: topic threads, witnesses and reactions)
import { COUNTER_RX, levelUpMore, noteCounter, THREAD_LINES, withoutCounter } from '#/engine/bot/port/BotThreads.js';
import { tickWitness } from '#/engine/bot/port/BotWitness.js';
import { noteVoiceHeld, voiceRoom } from '#/engine/bot/port/BotVoice.js';
import type { PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { sameClique } from '#/engine/bot/port/BotCliques.js';
import { botConsole } from '#/engine/bot/port/BotLog.js';
// (the realism work's phase 5a, Track F: rude replies from rude talkers, port/BotRude)
import { isRude } from '#/engine/bot/port/BotPersona.js';
import { noteRudeReply, rudeReply, RUDE_LINES } from '#/engine/bot/port/BotRude.js';
import { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';
import { askModel, CANDIDATE_CHANCE, MODEL_DEADLINE_TICKS, modelAvailable, noteCandidate, noteComposed, supersedeModelReply, unansweredChance, wantsModel, type ModelLogEntry, type ModelScopeRequest } from '#/engine/bot/port/BotModel.js';
import { notePrivateLine, notePublicLine } from '#/engine/bot/port/BotModelHistory.js';
import { renderLocal, renderOnline, situationOf } from '#/engine/bot/port/BotModelPrompt.js';
import { styleLine } from '#/engine/bot/port/BotStyle.js';
import chatResponsesJson from '../../data/chat_responses.json';

interface Reply {
    text: string;
    weight?: number;
    mood?: string;
}

interface IntentEntry {
    id: string;
    patterns: string[];
    replies: (Reply | string)[];
}

interface ChatResponses {
    greetings: { patterns: string[]; replies: (Reply | string)[] };
    help: { patterns: string[]; replies: (Reply | string)[] };
    intents: IntentEntry[];
    greetingReplies: (Reply | string)[];
    /** port: upstream's fillers for a line no intent matches; never said (processIntent) */
    fallback: (Reply | string)[];
    /** port: a greeting back to "hey X" (the realism work: "hey", "sup"; upstream's greetingReplies now and then) */
    greetingBack: (Reply | string)[];
}

const chatResponses = chatResponsesJson as ChatResponses;

const GOODBYE_REPLIES = ['See you later, {name}!', 'Bye {name}!', 'Catch you later!', 'Alright, see you soon :)'];
const LAUGH_PREFIXES = ['Haha :D', 'Lol', ':D'];
const YES_PREFIXES = ['Alright', 'Nice', 'Fair'];
const NO_PREFIXES = ['Oh fair enough', 'Alright then'];
const ENDING = "Alright, I'm off for now.";
/** A bot in a trade answers "come here" with one of these (a private message). */
const COME_HERE_TRADING = ['Busy trading, one sec', 'In a trade, hold on', 'Sec, trading'];
/** port: a bot in a fight answers "come here" with one of these (a private message). */
const COME_HERE_FIGHTING = ['Busy fighting, sec', 'In a fight, one sec', 'Fighting atm, hold on'];
/** port (the realism work, phase 5b): a bot with a part in a set piece (a duel, a party, a clan walk) answers with one of these */
const COME_HERE_BUSY = ['Busy atm, sec', 'Cant rn, one sec', 'Bit busy, hold on'];
/** port: a friend bot's private message now and then, unasked */
const FRIEND_OPENERS = ['hey', 'hey whats up', 'hows it going', 'sup', 'hi :)', 'what u up to?', 'wanna train together?', 'how many lvls today?', 'where r u?', 'u around?'];
/** port: an answer now and then to a "hi" meant for nobody in particular */
const HI_ANSWERS = ['hey', 'hi', 'hello', 'yo', 'sup'];
/** port: the bot that just said a level-up line, to the "gz" that follows */
const TY_ANSWERS = ['ty', 'ty :)', 'thanks', 'thx', 'ty!'];
/** port: a newbie newcomer's thanks to the line that came after its question (port/BotNewbie), now and then */
const NEWBIE_THANKS = ['ok ty', 'thx', 'ty :)', 'oh ok thanks', 'kk ty'];
const NEWBIE_THANKS_CHANCE = 0.6;
// port: answers from the bot's own state (Phase 3: livelier chat). Upstream had none for its combat
// level ("whats ur cb" got "Training combat gets boring fast lol"), where it is or what it does ("Just chilling, you?")
const COMBAT_LEVEL_QUESTIONS = ['combat level', 'what is your combat', 'your combat', 'what combat are you', 'what combat you', 'what level are you', 'what level you'];
const COMBAT_LEVEL_REPLIES = ['{combat}', 'Level {combat}', '{combat} cb', "I'm {combat}", 'Cb {combat}'];
/** a line about one skill's level ("what level are you in fishing") is for the skill intents */
const SKILL_WORDS = new Set(['attack', 'atk', 'strength', 'str', 'defence', 'def', 'hitpoints', 'hp', 'ranged', 'range', 'prayer', 'pray', 'magic', 'mage', 'cooking', 'cook', 'woodcutting', 'woodcut', 'wc', 'fletching', 'fletch', 'fishing', 'fish', 'firemaking', 'fm', 'crafting', 'craft', 'smithing', 'smith', 'mining', 'mine', 'herblore', 'herb', 'herby', 'agility', 'agil', 'thieving', 'thief', 'runecraft', 'runecrafting', 'rc', 'slayer', 'slay', 'total', 'overall']);
const WHERE_QUESTIONS = ['where are you', 'where you at', 'where abouts are you', 'whereabouts are you', 'wru'];
/** {place}: "In Varrock", "Near Draynor", "On Karamja" (port/BotPlaces) */
const WHERE_REPLIES = ['{place}', '{place} atm', '{place}, why?', '{place} lol'];
const NOWHERE_REPLIES = ['Middle of nowhere lol', 'No idea tbh', 'Somewhere lol'];
const DOING_QUESTIONS = ['what are you doing', 'what you doing', 'wyd', 'what are you up to', 'what you up to', 'wuu2'];
/** after what it does ("Cutting willows in Draynor", port/BotActivity) */
const DOING_SUFFIXES = ['', ', you?', ' atm', ' lol'];
// port: and emotes (port/BotEmote): a wave with a greeting or a goodbye, a laugh at a joke, a dance when asked
const DANCE_REQUESTS = ['dance', 'can you dance', 'dance for me', 'lets dance', 'party time'];
const DANCE_REPLIES = [':D', 'Party!', 'Woo!', "Let's go :D"];
/** how often a greeting or an unasked "hi" comes with a wave, a goodbye with one, a laugh with a laugh (halved
 * 2026-10-19, "emotes rare and special": 0.3, 0.5, 0.4 before) */
const WAVE_HELLO_CHANCE = 0.15;
const WAVE_BYE_CHANCE = 0.25;
const LAUGH_CHANCE = 0.2;

// ── The realism work, phase 2: the conversation's own lines ──────────────────────────────────────────────────────
/** a named line no intent understands: a rude bot's, anyone else's (now and then; else nothing) */
const CONFUSED_RUDE = ['wat', 'wut', 'wat?', 'what'];
const CONFUSED = ['?', 'huh', 'huh?', '??', 'what?'];
/** the second bot's reaction to a crowd's answer: agreeing, laughing, rude */
const SECOND_AGREE = ['ya', 'yep', 'what he said', 'ya that', 'true', 'yea'];
const SECOND_LAUGH = ['lol', 'lmao', 'haha', 'rofl'];
const SECOND_RUDE = ['lol nub', 'nub', 'lol no', 'figure it out lol', 'use ur map'];
/** a rude answer to a crowd's question (friendliness; more in phase 5) */
const CROWD_RUDE = ['figure it out', 'lol', 'no idea nub', 'ask some1 else', 'idk go away', 'use ur map lol'];
/** a market request no vendor has: now and then a bot near the human says so */
const NOBODY_SELLS = ['nobody sells that here lol', 'no1 has any lol', 'try varrock west', 'idk try the shop', 'nobody has any'];
/** the vendor's answer in character ({item} as the human wrote it, {price} in 2004 numbers, {where} its bank) */
const VENDOR_PM_SELL = ['i got {item} {price} ea, at {where}', 'selling {item} {price} ea at {where}, trade me there', 'got {item} {price} ea, im at {where}', 'i have {item}, {price} ea at {where}'];
const VENDOR_PM_BUY = ['ill buy ur {item} {price} ea, im at {where}', 'buying {item} {price} ea at {where}', 'i buy {item} {price} ea, {where}'];
const VENDOR_NEAR_SELL = ['i got {item} {price} ea', '{price} ea, trade me', 'i have some, {price} ea', 'got some, {price} ea'];
const VENDOR_NEAR_BUY = ['ill buy them {price} ea', '{price} ea, trade me', 'i buy {item} {price} ea'];
/** bots to bots: a gz to a level-up line, the leveller's ty, an asker's ack, a yes/no to "anyone ...?", a hello */
const BOT_GZ = ['gz', 'gz m8', 'gratz', 'grats', 'gj', 'gz!', 'congrats', 'nice one', 'gz man', 'gratz!'];
const BOT_ACK = ['ty', 'k ty', 'ok', 'oh ok', 'k', 'thx', 'kk', 'ok ty', 'ah ok'];
const BOT_YES = ['me', 'sure', 'me lol', 'ya', 'i do'];
const BOT_NO = ['no', 'nah', 'nope', 'not me', 'no lol'];
const BOT_HELLO = ['hey', 'hi', 'yo', 'sup', 'hiya'];
/**
 * (the variety work, round 1, SAY-7) a newbie's statement that it is new ("im new lol", "first day playing :)"): now and
 * then one bot near it welcomes it, and the newbie now and then thanks it
 */
const NEWBIE_WELCOME = ['welcome', 'welcome to rs', 'gl', 'gl newbie', 'hi newbie', 'welcome lol', 'have fun', 'welcome :)', 'gl have fun', 'u will love it'];
const NEWBIE_WELCOME_TY = ['ty', 'ty :)', 'thx', 'thanks'];
const NEWBIE_WELCOME_CHANCE = 0.35;
/** what a newbie says when it says it is new */
const SAYS_NEW = /\b(im new|i am new|new here|first day|just started|first time)\b/i;
/**
 * (the variety work, round 1, S9: ISS-14, 2026-10-13 kept) a friend's first message is about what it
 * is doing ({doing}: "cutting willows in draynor") or a level it just got ({n} {skill}); FRIEND_OPENERS when it has
 * nothing to tell; no more often than before (OPENER_GAP)
 */
const FRIEND_DOING = ['hey, {doing}', 'sup, {doing} lol', 'yo im {doing}', '{doing}, wanna come?', 'hey im {doing}, u?', '{doing} atm lol', 'hi :) {doing}'];
const FRIEND_LEVEL = ['just got {n} {skill}!!', 'hey i got {n} {skill} lol', 'woot {n} {skill}', 'guess what, {n} {skill}', 'finally {n} {skill}!!'];
/** a level-up this recent is news for a friend (10 minutes) */
const FRIEND_LEVEL_TICKS = 1000;
/** (variety round 2, S2-1) the intents of a question about the bot itself: its answer asks back now and then ("41 u?") */
const ASK_BACK_INTENTS = new Set(['asl', 'age', 'from', 'skill', 'combat', 'playtime', 'doing', 'whereami', 'how', 'whatsup']);
const ASK_BACK_CHANCE = 0.5;
const ASK_BACK = [' u?', ', u?', ' wbu', ', wbu?', ' and u?'];
/**
 * port (the variety work, round 2, the fixes: B1) a question back said as a line of its own, after an answer from
 * upstream's chat_responses.json ("I'm alright" / "u?"): upstream's lines keep their words ("keep upstream
 * flavour"), nothing is joined to them
 */
const ASK_BACK_ALONE = ['u?', 'wbu?', 'and u?', 'hbu?', 'what about u?'];
/**
 * (variety round 2, S2-1) an answer about itself with a question back, now and then, when the filter leaves it whole.
 * (The fixes, B1: the question joined only to the port's own answers, "41 u?"; an answer of upstream's is said as it is,
 * its question back a line of its own after it, `after`.)
 */
function askBack(answer: string, intent: IntentResult | null, canAnswer: () => boolean): { text: string; after?: string } {
    if (intent === null || !ASK_BACK_INTENTS.has(intent.id) || COUNTER_RX.test(answer.trim()) || chatDice.roll() >= ASK_BACK_CHANCE || !canAnswer()) return { text: answer };
    if (intent.upstream) return { text: answer, after: pickOf(ASK_BACK_ALONE) };
    const asked = `${answer.trim().replace(/[.!]+$/, '')}${pickOf(ASK_BACK)}`;
    return { text: WordEnc.filter(asked) === asked && asked.length <= 60 ? asked : answer };
}

/** (variety round 2, S2-1) the answerer's word on the asker's own answer back, now and then */
const BACK_WORDS = ['nice', 'cool', 'lol', 'oh nice', 'ah ok', 'lol same', 'nice :)'];
const BACK_WORD_CHANCE = 0.35;

/** Every line this module says besides chat_responses.json, for test/chat-filter.test.mjs ({name} is the speaker). */
export const BOT_CHAT_LINES = {
    goodbye: GOODBYE_REPLIES,
    laughPrefixes: LAUGH_PREFIXES,
    yesPrefixes: YES_PREFIXES,
    noPrefixes: NO_PREFIXES,
    ending: [ENDING],
    wildernessRefusals: WILDERNESS_REFUSALS,
    tradingRefusals: COME_HERE_TRADING,
    fightingRefusals: COME_HERE_FIGHTING,
    friendOpeners: FRIEND_OPENERS,
    hiAnswers: HI_ANSWERS,
    tyAnswers: TY_ANSWERS,
    newbieThanks: NEWBIE_THANKS,
    combatLevel: COMBAT_LEVEL_REPLIES,
    where: WHERE_REPLIES,
    nowhere: NOWHERE_REPLIES,
    doingSuffixes: DOING_SUFFIXES,
    dance: DANCE_REPLIES,
    confused: [...CONFUSED_RUDE, ...CONFUSED],
    secondAgree: SECOND_AGREE,
    secondLaugh: SECOND_LAUGH,
    secondRude: SECOND_RUDE,
    crowdRude: CROWD_RUDE,
    nobodySells: NOBODY_SELLS,
    vendorPm: [...VENDOR_PM_SELL, ...VENDOR_PM_BUY],
    vendorNear: [...VENDOR_NEAR_SELL, ...VENDOR_NEAR_BUY],
    botGz: BOT_GZ,
    botAck: BOT_ACK,
    botYes: BOT_YES,
    botNo: BOT_NO,
    botHello: BOT_HELLO,
    // (the variety work, round 2, S2-1: the answerer's word on the asker's own answer)
    backWords: BACK_WORDS,
    askBack: ASK_BACK,
    // (the variety work, round 2, the fixes: B1, a question back after an upstream answer, a line of its own)
    askBackAlone: ASK_BACK_ALONE,
    // (the variety work, round 1: a welcome to a newbie and its thanks; a friend's first message about what it does)
    newbieWelcome: NEWBIE_WELCOME,
    newbieWelcomeTy: NEWBIE_WELCOME_TY,
    friendDoing: FRIEND_DOING,
    friendLevel: FRIEND_LEVEL,
    // (the realism work's phase 5a, Track F: a rude talker's replies, port/BotRude; "{answer} nub" after a plain answer)
    rudeDirections: RUDE_LINES.directions,
    rudeBeg: RUDE_LINES.beg,
    rudeNo: RUDE_LINES.no,
    rudeGear: RUDE_LINES.gear,
    rudePersonal: RUDE_LINES.personal,
    rudeMood: RUDE_LINES.mood,
    rudePrice: RUDE_LINES.price,
    rudeAddon: RUDE_LINES.addon
} as const;

interface BotMemory {
    // Conversation ownership
    lastSpeakerId?: string;
    lastMessage?: string;
    lastInteractionTime?: number; // port: World.currentTick

    // Conversation state
    state?: 'idle' | 'engaged' | 'ending';

    // Context & history
    context: string[]; // recent messages (chat history)
    topic?: string; // current detected topic

    // Anti-repetition system
    lastReplies: string[]; // recently used replies
    repetitions: number; // number of exchanges in this convo
    maxRepetitions: number; // limit before ending

    // Personality / mood system
    mood?: 'neutral' | 'happy' | 'annoyed' | 'bored';

    // port: a private conversation (the human it is with, and the tick of its last message either way)
    privateWith?: string;
    privateAt?: number;
    /** port: the unprompted line a reply-window answer was given to (one answer per line) */
    answeredSpokeAt?: number;
    /** port: an emote to do with the line being answered (processIntent sets it, its caller takes it: takeEmote) */
    emote?: Emote;
    /** port (the realism work): the tick the line it is typing is said (the next one waits for it) */
    typingUntil?: number;
    /** port (the realism work): the tick it last answered another bot, and said gz to one (cooldowns) */
    botTalkAt?: number;
    gzAt?: number;
}

/** 30 s: how long a conversation stays open (upstream: 30000 ms). */
const CONVERSATION_TICKS = 50;
/** A bot farther away than this (Chebyshev, tiles) does not hear a public line. */
const HEARING_DISTANCE = 14;
/** port (the realism work): a public line reaches the bots in earshot the next tick (they read it, then think and type) */
const HEAR_TICKS = 2;
/** Marketplace reply cooldown per player, request and item (upstream: 30 s). */
const VENDOR_COOLDOWN_TICKS = 50;
/** port (the realism work): a vendor this near the human (and on its floor) answers a market request out loud */
const MARKET_NEAR = 15;
/** port (the realism work): how often a bot near the human says nobody sells the item a market request asks for */
const NOBODY_SELLS_CHANCE = 0.12;
/** port: the reply window: a human's line this soon after a bot's unprompted line may be meant for it (30 s) */
const REPLY_WINDOW_TICKS = 50;
/** port: a private conversation stays open this long (3 minutes: a private message waits longer for its answer) */
const PRIVATE_CONVERSATION_TICKS = 300;
/** port: at most one unasked "hi" back to a human in this long (2 minutes) */
const HI_ANSWER_GAP_TICKS = 200;
/**
 * port: how often a "hi" meant for nobody gets one: with one bot in earshot HI_ANSWER_CHANCE, more with more bots around
 * (up to HI_ANSWER_MAX). (Each bot in earshot used to roll 25 % on its own, the first to answer taking it: about 76 %
 * with five bots; now one roll for the crowd, the realism work's floor control)
 */
const HI_ANSWER_CHANCE = 0.3;
const HI_ANSWER_MAX = 0.7;
/** port: a friend bot's unasked private message: one about every this many ticks of play (uniform), 20-40 minutes */
const OPENER_GAP: [number, number] = [2000, 4000];
/** port (the realism work): a crowd's answer to a question said to nobody: its chance, by the bots in earshot */
const CROWD_CHANCE: [number, number] = [0.4, 0.8];
/** port (the realism work): a second bot's reaction to the crowd's answer, 2-6 s after it, now and then */
const SECOND_CHANCE = 0.3;
/** port (the realism work): a named line no intent understands gets "?" or "wat" this often (else nothing) */
const CONFUSED_CHANCE = 0.4;
/**
 * port (the realism work): a rude bot's answer to a crowd is a rude one this often. (Phase 5a, Track F: a rude talker's,
 * port/BotPersona isRude, friendliness below -0.1, about 17 % of levelling bots; it was below -0.3, PKers only)
 */
const RUDE_CHANCE = 0.25;
/** port (the realism work): bots answering bots: a bot answers another at most this often; an area starts at most
 * one exchange this often; a bot says gz at most this often */
const BOT_TALK_GAP = 150;
const AREA_TALK_GAP = 20;
const GZ_GAP = 200;
/** port (the realism work): a bot's question answered by a bot in earshot: the chance when one understands it, else */
const BOT_ANSWER_CHANCE = 0.75;
const BOT_SHRUG_CHANCE = 0.35;
/** port (the realism work): the asker's "ty"/"ok" to a bot's answer, the leveller's "ty" to a gz */
const BOT_ACK_CHANCE = 0.35;
const LEVELLER_TY_CHANCE = 0.5;
/** port (the realism work): questions about the bot itself: a second bot gives its own answer, never a "ya" */
const PERSONAL_INTENTS = new Set(['asl', 'age', 'from', 'gender', 'pk', 'fight', 'team', 'playtime', 'presence', 'skill', 'combat']);
/** port (the realism work): JSON intents that read as a filler to another bot: a bot gets a shrug instead */
const BOT_SKIP_INTENTS = new Set(['where', 'about', 'advice', 'area', 'area2', 'repeat', 'chilling', 'goals', 'mood', 'bad_mood', 'help', 'gratsorwelcome', 'thanks', 'bye', 'noob', 'insult']);

const memories = new WeakMap<Player, BotMemory>();

/**
 * port (the realism work, phase 5b: set pieces): told of a human's public line (as typed) before the bots near it answer:
 * the Duel Arena's challenge lines ("stake?", "box me": Track A's port/BotArena), the player-mod bot hearing spam (Track
 * A's port/BotModBot). A listener that returns true has answered the line: the bots near do not.
 */
export const humanLineListeners: ((human: Player, text: string) => boolean | void)[] = [];

let repliesSent = 0;
const repliesByBot = new WeakMap<Player, number>();

export const BotChat = {
    /** A human's public chat line (as typed: port, the runtime passed the filtered line), after the stock handler accepted it. */
    onPublicMessage(player: Player, text: string): void {
        const mes = text.trim();
        if (!mes.length || player.is_bot) return;
        // (phase 7: what was said lately, for a model-written reply's situation: port/BotModelHistory)
        notePublicLine(player, mes);
        // port (phase 5b): the set pieces hear it first (humanLineListeners)
        let answered = false;
        for (const listener of humanLineListeners) {
            try {
                if (listener(player, mes) === true) answered = true;
            } catch (err) {
                botConsole.error('[BotChat] a set piece failed on a human\'s line', err);
            }
        }
        if (answered) return;
        const name = speakerName(player);
        // port: a market request goes on to the bots too (upstream returned here: a bot addressed by its whole name in
        // a line with "need" or "buy" never answered, and a trading bot never heard its partner's line)
        const market = handleVendorMarketplaceMessage(player, name, mes);
        sendMessageToNearbyBots(player, name, mes, market);
    },

    /** A human's private message to `targetName`. True when it was a bot command ("come here") and is consumed. */
    onPrivateMessage(player: Player, targetName: string, text: string): boolean {
        if (handleBotPrivateCommand(player, targetName, text)) return true;
        // port: any other one to a bot gets an answer, as its public lines do
        answerPrivate(player, targetName, text);
        return false;
    },

    /**
     * port: now and then a friend bot messages a human first: about every 20-40 minutes of play, one
     * that is online and not busy, to a human whose private chat is not off. `isFriend`: a human has that bot as a
     * friend. Called every tick by BotManager.
     */
    tickOpeners(isFriend: (name: string) => boolean): void {
        const now = World.currentTick;
        if (nextOpener === -1) nextOpener = now + uniformTicks(OPENER_GAP);
        if (now < nextOpener) return;
        nextOpener = now + uniformTicks(OPENER_GAP);
        const pick = pickOpener(isFriend);
        if (pick) sendFriendOpener(pick.human, pick.bot);
    },

    /**
     * port (the realism work, phase 2): the bots' talk of their own, every tick a human is in the world (BotManager):
     * short exchanges between two bots near a human (port/BotStage) and reactions to a human (port/BotReactions).
     */
    tickTalk(): void {
        tickReactions();
        tickStage();
        // (variety round 2, S2: a death seen, a rare or status gear near, a level 90 passing, a bot's new kit: port/BotWitness)
        tickWitness();
    },

    /** Chat lines the bots said in reply (for tests and stats). */
    get repliesSent(): number {
        return repliesSent;
    },

    /** port: the public replies one bot said (for tests) */
    repliesBy(bot: Player): number {
        return repliesByBot.get(bot) ?? 0;
    },

    /** port: the bot is talking with a human (addressed within the last 30 s): its session waits for a goodbye. */
    inConversation(bot: Player): boolean {
        const memory = memories.get(bot);
        return memory !== undefined && memory.state === 'engaged' && World.currentTick - (memory.lastInteractionTime ?? 0) < CONVERSATION_TICKS;
    },

    /**
     * port (the realism work): the bot is typing a line (a reply, an answer to a bot, a practice's turn) or is in a
     * practice with another bot (port/BotStage): port/BotHabits starts no break or look then.
     */
    midTalk(bot: Player): boolean {
        return (memories.get(bot)?.typingUntil ?? 0) > World.currentTick || inPractice(bot);
    },

    /**
     * port (the realism work, phase 2): a bot said `line` (of `kind`) where other bots may hear it: a question to anyone,
     * a level-up line, a greeting. Nearby bots answer it as they answer a human (bots talk to each
     * other): one answers a question (processIntent from its own view; "idk" when it knows no answer), 0-2 say gz to a
     * level-up and the leveller now and then thanks the first, a bot it names or one near it says hello back. At most
     * 3 lines from the first, a cooldown per bot and per area, nothing from a bot that is away. Called by the chatter
     * after the line is said.
     */
    onBotLine(bot: Player, line: string, kind: LineKind): void {
        if (!bot.is_bot || BotManager.botFor(bot) === null || isAway(bot)) return;
        const text = line.trim();
        if (!text) return;
        if (kind === 'levelup') {
            lastLevelUpLine.set(bot, text);
            return void botLevelUp(bot);
        }
        // (the variety work, round 1, SAY-7: a newbie's line is a question only when it is one: "im new lol" got "Lmao",
        // then "oh ok thanks")
        const question = isQuestionText(text);
        if (!question && !isPureGreeting(text) && !/[a-z]/i.test(text)) return;
        // (the bots in earshot, once: a scan over the bots per line said)
        const crowd = earshot(bot, null, null);
        if (crowd.length === 0) return;
        const named = namedBotIn(crowd, text);
        if (named) return void botNamed(bot, named, text);
        if (question) return void botQuestion(bot, text, kind === 'newbie', crowd);
        if (isPureGreeting(text)) botGreeting(bot, crowd);
        else if (kind === 'newbie' && SAYS_NEW.test(text)) botWelcome(bot, crowd);
    },

    /**
     * port: its session is over in the middle of a conversation: it says upstream's ending line ("Alright, I'm off for
     * now."), typed as any reply (the realism work); the ticks until it is said.
     */
    sayGoodbye(bot: Player): number {
        const memory = memoryOf(bot);
        memory.state = 'idle';
        sayTyped(bot, ENDING, { to: null, kind: 'departure', count: true });
        return Math.max(0, (memory.typingUntil ?? World.currentTick) - World.currentTick);
    }
};

// ── Addressing ────────────────────────────────────────────────────────────────

/** The bot's whole name, as the player sees it (display name, any case, spaces or underscores), on word boundaries. */
export function isAddressingBot(message: string, bot: Player): boolean {
    return namesBot(addressingText(message), bot);
}

/** A chat line as the bots' names are looked up in it: lower case, single spaces, a space at each end. */
function addressingText(message: string): string {
    return ` ${message.toLowerCase().replace(/[_-]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

function namesBot(text: string, bot: Player): boolean {
    for (const variant of nameVariants(bot)) if (text.includes(` ${variant} `)) return true;
    return false;
}

const variants = new WeakMap<Player, string[]>();

/** port: the bot's name as people type it: "lumby larry" and "lumbylarry"; "kevin1991" and "kevin 1991" */
function nameVariants(bot: Player): string[] {
    let list = variants.get(bot);
    if (!list) {
        const name = bot.displayName.toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
        const apart = name.replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2');
        list = [...new Set([name, name.replace(/ /g, ''), apart])].filter(v => v.length > 0);
        variants.set(bot, list);
    }
    return list;
}

/**
 * port: words that do not make a first name: chat words, places, titles. The first words of item names ("iron",
 * "rune", "lobster") are left out too (firstNameOf), so "anyone selling iron" is no call to Iron Fist.
 */
const NOT_FIRST_NAMES = new Set(['hi', 'hey', 'yo', 'sup', 'lol', 'gz', 'gl', 'ty', 'thx', 'pk', 'pker', 'noob', 'newb', 'mr', 'mrs', 'sir', 'lord', 'king', 'lil', 'the', 'my', 'ur', 'im', 'its', 'not', 'no', 'yes', 'ok', 'okay', 'well', 'good', 'nice', 'cool', 'bad', 'best', 'top', 'pro', 'old', 'new', 'real', 'sweet', 'super', 'mega', 'ultra', 'master', 'hello', 'dude', 'bro', 'man', 'guy', 'lady', 'miss', 'captain', 'capt', 'dr', 'doc', 'prince', 'princess', 'lumby', 'varrock', 'fally', 'draynor', 'edge', 'edgeville', 'karamja', 'ardy', 'seers', 'catherby', 'wildy', 'wild', 'bank', 'team', 'clan', 'pure', 'main', 'str', 'att', 'def', 'hp', 'mage', 'range', 'ranger', 'melee', 'tank', 'trade', 'buy', 'sell', 'any', 'all', 'one', 'two', 'big', 'small', 'little', 'fat', 'mad', 'evil', 'dark', 'lost', 'ice', 'fire', 'death', 'shadow', 'silent', 'quick', 'fast', 'slow', 'lucky',
    // port: and words a line about something else may start or end with ("ask the fish trader" called Trader Ted):
    // trades and roles, monsters, places, skills and chat words
    'trader', 'dealer', 'merchant', 'merch', 'market', 'shop', 'stall', 'stock', 'price', 'deal', 'cheap', 'profit', 'money', 'cash', 'loot', 'warrior', 'wizard', 'witch', 'knight', 'archer', 'hunter', 'killer', 'pirate', 'ninja', 'viking', 'chef', 'baker', 'blacksmith', 'smithy', 'tanner', 'fletcher', 'lumberjack', 'gnome', 'goblin', 'giant', 'troll', 'ogre', 'imp', 'elf', 'wolf', 'bear', 'cow', 'sheep', 'crab', 'rat', 'chicken', 'dragon', 'demon', 'ghost', 'scorpion', 'monster', 'boss', 'guild', 'castle', 'dungeon', 'arena', 'kitchen', 'farm', 'road', 'fish', 'fishing', 'mining', 'mine', 'tree', 'wood', 'rock', 'ore', 'ores', 'help', 'party', 'quest', 'level', 'lvl', 'skill', 'combat', 'fight', 'duel', 'train', 'run', 'tele', 'spec', 'free', 'members', 'noted', 'safe', 'risk', 'where', 'just', 'need', 'going', 'done', 'gone', 'know', 'name', 'back', 'talk', 'cheers', 'omg', 'afk', 'brb', 'haha', 'rofl', 'lag', 'random', 'easy', 'hard']);

const firstNames = new WeakMap<Player, string | null>();

/** port: the first word of a bot's two-word name, when it can be a name ("matty" of Matty B; not "iron" of Iron Fist) */
export function firstNameOf(bot: Player): string | null {
    let first = firstNames.get(bot);
    if (first === undefined) {
        const words = bot.displayName.toLowerCase().replace(/[_-]/g, ' ').trim().split(/\s+/);
        first = words.length >= 2 ? words[0] : null;
        if (first !== null && (first.length < 3 || /\d/.test(first) || NOT_FIRST_NAMES.has(first) || itemFirstWords().has(first))) first = null;
        firstNames.set(bot, first);
    }
    return first;
}

let itemFirstWordSet: Set<string> | null = null;

/** The first word of every object's name ("iron" of Iron ore, "lobster" of Lobster pot). */
function itemFirstWords(): Set<string> {
    if (!itemFirstWordSet) {
        itemFirstWordSet = new Set();
        for (let id = 0; id < ObjType.count; id++) {
            const name = ObjType.get(id)?.name;
            if (name) itemFirstWordSet.add(name.toLowerCase().split(/\s+/)[0]);
        }
    }
    return itemFirstWordSet;
}

/**
 * port: the line calls the bot by its first name: first, last, or after a greeting ("hey matty", "matty u there",
 * "nice one matty"), and no other bot in earshot of the human has that first name.
 */
function callsByFirstName(message: string, bot: Player, human: Player): boolean {
    const first = firstNameOf(bot);
    if (first === null) return false;
    const words = addressingText(message).trim().split(' ');
    const at = words.indexOf(first);
    if (at === -1) return false;
    const vocative = at === 0 || at === words.length - 1 || ['hi', 'hey', 'hello', 'yo', 'oi', 'sup', 'hiya'].includes(words[at - 1]);
    if (!vocative) return false;
    for (const other of BotManager.activeBots()) {
        if (other !== bot && other.level === human.level && chebyshev(other, human) <= HEARING_DISTANCE && firstNameOf(other) === first) return false;
    }
    return true;
}

/** port: the line names another bot in the world by its whole name: it is meant for that one. */
function addressesAnotherBot(message: string, bot: Player): boolean {
    const text = addressingText(message);
    for (const other of BotManager.activeBots()) {
        if (other !== bot && namesBot(text, other)) return true;
    }
    return false;
}

function speakerName(player: Player): string {
    return player.displayName || toDisplayName(player.username);
}

// ── Public chat → nearby bots ────────────────────────────────────────────────

/** port (the realism work): each human's lines, numbered: a bot that takes one (its name, its conversation, the reply window) keeps the crowd out of it */
let lineCount = 0;
const lineTaken = new WeakMap<Player, number>();

function sendMessageToNearbyBots(human: Player, name: string, mes: string, market: MarketOutcome): void {
    const lineId = ++lineCount;
    for (const bot of BotManager.activeBots()) {
        if (bot.botTradeTargetPid !== -1) {
            if (bot.botTradeTargetPid === human.uid) {
                // the trading tasks read what their partner says
                bot.botTradeTargetChatName = name;
                bot.botTradeTargetChatMessage = mes;
                // port (the realism work): the line is for its trade partner, not for the crowd
                lineTaken.set(human, lineId);
                continue;
            }

            // Vendors should still answer marketplace requests while they
            // are serving somebody else.
            if (bot.botPlanner !== 'extras_vendor') continue;
        } else {
            bot.botTradeTargetChatName = '';
            bot.botTradeTargetChatMessage = '';
        }

        // port: only bots that could still be in earshot when the check runs (it tests HEARING_DISTANCE)
        if (chebyshev(bot, human) > HEARING_DISTANCE * 2) continue;
        // port (the realism work): it reads the line the next tick; its answer takes its typing time (sayTyped)
        scheduleInTicks(HEAR_TICKS, () => botChatCheck(human, name, mes, bot, lineId));
    }
    // port (the realism work): a line said to nobody: one bot of the crowd may answer it (after the bots above judged it)
    scheduleInTicks(HEAR_TICKS, () => crowdAnswer(human, name, mes, lineId, market));
}

function botChatCheck(human: Player, name: string, mes: string, bot: Player, lineId: number): void {
    // port: this Player object, not just the name: a bot that logged out and back in is a new Player
    if (!bot || BotManager.botFor(bot) === null) return;
    if (isClientConnected(bot)) return;
    if (!bot.is_bot) return;
    if (human.slot === -1) return;
    // port (the realism work): a bot on a short break (port/BotHabits) hears nothing
    if (isAway(bot)) return;

    if (chebyshev(bot, human) > HEARING_DISTANCE) return;

    const memory = memoryOf(bot);
    const now = World.currentTick;

    // a conversation that just ended stays ended for a while (upstream: until the server restarted)
    if (memory.state === 'idle' && memory.lastSpeakerId && now - (memory.lastInteractionTime ?? 0) < CONVERSATION_TICKS) return;

    // port: addressed by name (whole, a variant, or a first name nobody else in earshot has), or the human's answer
    // within 30 s of the bot speaking to them first (a social bot's question, an idle line with their name: the newest
    // such line, once), when it is a greeting or a line the bot understands; "gz" just after its level-up line gets a
    // thanks.
    const other = addressesAnotherBot(mes, bot);
    const named = isAddressingBot(mes, bot) || (!other && callsByFirstName(mes, bot, human));
    const cleanedLine = cleanMessage(mes);
    if (!named && !other) {
        const levelled = lastHeard(human.x, human.z, human.level, now, REPLY_WINDOW_TICKS, HEARING_DISTANCE, 'levelup');
        // (a short "gz", "nice one": not a question that starts with "nice", which the research's probe saw swallowed:
        // "nice, what lvl are you" got "ty!")
        const gz = matchesAny(cleanedLine, ['gz', 'nice', 'gj', 'well done']) && !isQuestionText(mes) && cleanedLine.split(' ').length <= 4;
        if (levelled !== null && levelled.bot === bot && memory.answeredSpokeAt !== levelled.tick && gz) {
            memory.answeredSpokeAt = levelled.tick;
            lineTaken.set(human, lineId);
            if (chatDice.roll() < 0.8) {
                supersedeModelReply(bot); // (phase 7: a newer reply to the human; nothing without a model)
                sayTyped(bot, TY_ANSWERS[Math.floor(Math.random() * TY_ANSWERS.length)], { to: human, kind: 'reply', count: true });
            }
            return;
        }
        // port: a newbie's question just before, near the human: this line may be the answer (port/BotNewbie)
        const asked = lastHeard(human.x, human.z, human.level, now, REPLY_WINDOW_TICKS, HEARING_DISTANCE, 'newbie');
        if (asked !== null && asked.bot === bot && memory.answeredSpokeAt !== asked.tick) {
            memory.answeredSpokeAt = asked.tick;
            lineTaken.set(human, lineId);
            if (chatDice.roll() < NEWBIE_THANKS_CHANCE) {
                supersedeModelReply(bot);
                sayTyped(bot, NEWBIE_THANKS[Math.floor(Math.random() * NEWBIE_THANKS.length)], { to: human, kind: 'reply', count: true });
            }
            return;
        }
    }
    const spoke = named || other ? null : lastSpokenTo(human, now, REPLY_WINDOW_TICKS);
    const talking = memory.lastSpeakerId === name && now - (memory.lastInteractionTime ?? 0) < CONVERSATION_TICKS;
    const windowed = spoke !== null && spoke.bot === bot && memory.answeredSpokeAt !== spoke.tick && !talking;
    // (phase 7: a reply-window answer nothing understands that a model answers, rolled here: CANDIDATE_CHANCE.window)
    let modelWindow = false;
    if (windowed) {
        const scratch = scratchMemory(memory);
        if (!matchesAny(cleanedLine, chatResponses.greetings.patterns) && processIntent(mes, scratch, bot, human) === null) {
            // (phase 7: an answer to its line that nothing understands: a model could answer it)
            noteCandidate({ bot, to: human, heard: mes, channel: 'public', via: 'window', greeted: false, intent: null });
            if (!modelCandidate({ bot, via: 'window', intent: null }, CANDIDATE_CHANCE.window)) return;
            modelWindow = true;
        }
        memory.answeredSpokeAt = spoke.tick;
    }

    if (named || windowed) {
        lineTaken.set(human, lineId);
        memory.lastSpeakerId = name;
        memory.lastInteractionTime = now;
        memory.state = 'engaged';
        memory.context = [];
        memory.repetitions = 0;
        memory.topic = undefined; // port: a new conversation starts on no topic

        // port: without the bot's name ("Chicken Chaz whats ur cb" is about combat, not chickens)
        const line = withoutName(mes, bot);
        const cleaned = cleanMessage(line);

        // port: a greeting alone ("hey kevin1991") gets a greeting back; a line with more in it ("hey kevin1991 whats ur
        // cb") its answer (the realism work: no "Yes Casey?" in front of it). Upstream tested the greetings as substrings
        // of the whole line, its name too: "this", "which", "fishing", "thieving" or "chicken" made any question a
        // greeting alone, and 80 of the 2,400 bots (Sophie 2003, Chicken Chaz) only ever greeted
        const isGreeting = matchesAny(cleaned, chatResponses.greetings.patterns);
        const rest = isGreeting ? withoutPatterns(cleaned, chatResponses.greetings.patterns) : cleaned;

        // port: null when nothing is understood (upstream picked a filler here and threw it away by its text)
        const intent = rest.length > 1 ? processIntent(line, memory, bot, human) : isGreeting ? greetingBack(memory, bot) : null;
        const req: ReplyRequest = { bot, to: human, heard: mes, channel: 'public', via: named ? 'named' : 'window', greeted: isGreeting, intent };
        const reply = composeNoted(req);
        const model = modelWrites(req, reply, modelWindow);
        if (!reply.text && !model) return;

        // port: with an emote now and then (a wave to a greeting; the answer's own: a laugh, a dance)
        const emote = takeEmote(memory) ?? (isGreeting && chatDice.roll() < WAVE_HELLO_CHANCE ? 'wave' : undefined);
        sayReply(req, reply, model, { to: human, kind: 'reply', emote, count: true, talk: true, follow: intent?.follow ? human : null });
        return;
    }

    // CONTINUE CONVERSATION
    if (memory.lastSpeakerId === name && now - (memory.lastInteractionTime ?? 0) < CONVERSATION_TICKS) {
        // port: a line that names another bot is for that one, and a line no intent matches gets no reply (upstream
        // sent a filler such as "Can you say that another way?"); neither keeps the conversation open
        if (addressesAnotherBot(mes, bot)) return;
        const intent = processIntent(withoutName(mes, bot), memory, bot, human);
        // (phase 7: a line of the conversation nothing understands that a model answers, rolled here: CANDIDATE_CHANCE.conversation;
        // the conversation goes on as with a line the rules understood)
        let modelLine = false;
        if (!intent) {
            // (phase 7: a line of the conversation no intent matches: a model could answer it)
            noteCandidate({ bot, to: human, heard: mes, channel: 'public', via: 'conversation', greeted: false, intent: null });
            if (!modelCandidate({ bot, via: 'conversation', intent: null }, CANDIDATE_CHANCE.conversation)) return;
            modelLine = true;
        }
        lineTaken.set(human, lineId);

        memory.context.push(mes);
        memory.lastMessage = mes;
        memory.lastInteractionTime = now;
        memory.repetitions++;

        // End conversation if too long
        if (memory.repetitions > memory.maxRepetitions) {
            // (phase 7: a model reply it still waits for falls back to the rules' line first: nothing without a model)
            supersedeModelReply(bot);
            memory.state = 'idle';
            memory.emote = undefined;
            return sayTyped(bot, ENDING, { to: human, kind: 'reply', count: true, emote: chatDice.roll() < WAVE_BYE_CHANCE ? 'wave' : undefined });
        }

        const req: ReplyRequest = { bot, to: human, heard: mes, channel: 'public', via: 'conversation', greeted: false, intent };
        const reply = composeNoted(req);
        const model = modelWrites(req, reply, modelLine);
        if (reply.text || model) sayReply(req, reply, model, { to: human, kind: 'reply', emote: takeEmote(memory), count: true, talk: true, follow: intent?.follow ? human : null });
    }
}

/** port: the dice of these unasked answers (a test can load them) */
export const chatDice = { roll: (): number => Math.random() };

/** port: the tick each human last got an unasked "hi" back */
const hiAnswered = new WeakMap<Player, number>();

/**
 * port: "hi", "hey all", "hello everyone": a greeting and nothing else. (The variety work, round 1, SAY-7: smileys gone and
 * stretched letters collapsed first, "Heyy kev :)" and "heyyy" are greetings; the bots' own greetings are in the
 * patterns, yo, heya, heyy, wassup, ello, o hey: "Heyy {name} :)" got "??" from the bot it named.)
 */
function isPureGreeting(mes: string): boolean {
    const cleaned = greetingText(mes);
    if (!matchesAny(cleaned, chatResponses.greetings.patterns)) return false;
    return withoutPatterns(cleaned, GREETING_WORDS).length === 0;
}
/** (variety round 1) a greeting's words, the longest first ("o hey" before "hey") */
const GREETING_WORDS = [...chatResponses.greetings.patterns, 'all', 'everyone', 'every1', 'guys', 'people', 'there'].sort((a, b) => b.length - a.length);

/** (variety round 1, SAY-7) a line as a greeting is read: no smileys, stretched letters collapsed ("heyyyy" hey, "hiii" hi) */
function greetingText(mes: string): string {
    return cleanMessage(mes.replace(/[:;=]-?[()dpo3]/gi, ' ').replace(/([a-z])\1{2,}/gi, '$1'));
}

/** (variety round 1, SAY-7: for the tests) is the line a greeting and nothing else, as the bots read one? */
export function isGreetingLine(mes: string): boolean {
    return isPureGreeting(mes);
}

/** The bot's conversation memory (made at its first conversation). */
function memoryOf(bot: Player): BotMemory {
    let memory = memories.get(bot);
    if (!memory) {
        memory = { state: 'idle', context: [], lastReplies: [], repetitions: 0, maxRepetitions: 10, mood: 'neutral' };
        memories.set(bot, memory);
    }
    return memory;
}

/** port: a copy of the memory to try a line on (what processIntent sets stays in the copy) */
function scratchMemory(memory: BotMemory): BotMemory {
    return { ...memory, context: [...memory.context], lastReplies: [...memory.lastReplies], topic: undefined, emote: undefined };
}

/**
 * port (the realism work): what `bot` would answer `mes` from `asker` (a human or a bot) outside a conversation (its
 * memory untouched); `keep`: the bot says it, so its pick counts against repeating itself
 */
function intentOf(mes: string, bot: Player, asker: Player, keep = false): IntentResult | null {
    const memory = memoryOf(bot);
    const scratch = scratchMemory(memory);
    const intent = processIntent(mes, scratch, bot, asker);
    if (keep) memory.lastReplies = scratch.lastReplies;
    return intent;
}

// ── The crowd: a line said to nobody (the realism work: floor control) ───────────────────────────────────────────

/**
 * port (the realism work): the bots in earshot of `around` that could answer a line: on its floor, not away, not in a
 * fight, a trade or a bank or shop window, not talking with somebody else, not typing a line already; nearest first.
 */
function earshot(around: Player, speakerName: string | null, exclude: Player | null, distance = HEARING_DISTANCE): Player[] {
    const now = World.currentTick;
    const found: { bot: Player; d: number }[] = [];
    for (const bot of BotManager.activeBots()) {
        if (bot === around || bot === exclude || bot.level !== around.level) continue;
        const d = chebyshev(bot, around);
        if (d > distance || isAway(bot) || isBusy(bot)) continue;
        const memory = memories.get(bot);
        if (memory) {
            if ((memory.typingUntil ?? 0) > now) continue;
            const talking = memory.state === 'engaged' && now - (memory.lastInteractionTime ?? 0) < CONVERSATION_TICKS;
            if (talking && memory.lastSpeakerId !== speakerName) continue;
        }
        found.push({ bot, d });
    }
    return found.sort((a, b) => a.d - b.d).map(f => f.bot);
}

/** port (the realism work): the bots within `distance` of `around` free to talk (port/BotStage, port/BotReactions), nearest first */
export function botsFreeNear(around: Player, distance: number): Player[] {
    return earshot(around, null, null, distance);
}

/** port (the realism work): what `bot` would answer `mes` asked by `asker` (a newbie's question in a practice: port/BotStage) */
export function answerFor(mes: string, bot: Player, asker: Player): IntentResult | null {
    return intentOf(mes, bot, asker, true);
}

/**
 * at a monster or a player (a fight, a pickpocket, a follow), in a trade, a bank or shop window: it neither joins a
 * crowd nor answers a bot, and thinks longer before a reply (O(1): a tree or a rock is no bother)
 */
export function isBusy(bot: Player): boolean {
    return bot.botTradeTargetPid !== -1 || bot.target instanceof Npc || bot.target instanceof Player || bot.containsModalInterface();
}

/**
 * port (the realism work): a bot that said something in the last 3 minutes is at its keyboard, chatting: it answers a
 * crowd's line or a bot's question sooner (CHATTING_WEIGHT), and says gz more readily, than one grinding in silence.
 * Spread over the silent ones the answers left few quiet stretches (H6) and evened out the talkers' bursts (C2).
 */
const CHATTING_TICKS = 300;
const CHATTING_WEIGHT = 3;
function chatting(bot: Player): boolean {
    return World.currentTick - lastChatAt(bot) <= CHATTING_TICKS;
}

/**
 * port (the realism work, phase 3: "bot friend cliques"): friends answer each other first: a bot of
 * the asker's clique (port/BotCliques) in earshot weighs this much more as the one who answers
 */
const CLIQUE_WEIGHT = 5;

/** one bot of `crowd`, weighted by `weight`, by chatting lately, by being the asker's friend (port/BotCliques) and by nearness to `around` */
function pickResponder(crowd: Player[], around: Player, weight: (persona: Persona) => number): Player {
    const weights = crowd.map(bot => (weight(botPersona(bot)) * (chatting(bot) ? CHATTING_WEIGHT : 1) * (sameClique(bot.username, around.username) ? CLIQUE_WEIGHT : 1)) / (1 + chebyshev(bot, around) / 5));
    let x = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < crowd.length; i++) {
        x -= weights[i];
        if (x <= 0) return crowd[i];
    }
    return crowd[crowd.length - 1];
}

/** a crowd's chance to answer: more bots, likelier; their helpfulness on average */
function crowdChance(crowd: Player[]): number {
    const [lo, hi] = CROWD_CHANCE;
    const help = crowd.slice(0, 6).reduce((sum, bot) => sum + botPersona(bot).helpfulness, 0) / Math.min(6, crowd.length);
    return Math.max(lo, Math.min(hi, lo + 0.08 * (crowd.length - 1) + 0.3 * (help - 0.5)));
}

/**
 * port (the realism work): a question or request said to nobody (no bot took it: its name, its conversation, the reply
 * window): at most one bot answers it, by helpfulness and nearness, about half the time (0.4-0.8 by the crowd), and now
 * and then a second bot reacts 2-6 s later. A greeting to nobody now and then gets one "hi" back (at most one in 2
 * minutes for a human); a market request no vendor has, rarely a "nobody sells that here lol".
 */
function crowdAnswer(human: Player, name: string, mes: string, lineId: number, market: MarketOutcome): void {
    if (human.slot === -1 || lineTaken.get(human) === lineId) return;
    if (addressesAnotherBot(mes, human)) return;
    const crowd = earshot(human, name, null);
    if (crowd.length === 0) return;
    const now = World.currentTick;

    if (isPureGreeting(mes)) {
        const last = hiAnswered.get(human) ?? -Infinity;
        const chance = Math.min(HI_ANSWER_MAX, HI_ANSWER_CHANCE + 0.08 * (crowd.length - 1));
        if (now - last < HI_ANSWER_GAP_TICKS || chatDice.roll() >= chance) return;
        hiAnswered.set(human, now);
        const bot = pickResponder(crowd, human, p => 0.2 + p.sociability);
        const req: ReplyRequest = { bot, to: human, heard: mes, channel: 'public', via: 'crowd', greeted: true, intent: { id: 'greeting', text: HI_ANSWERS[Math.floor(Math.random() * HI_ANSWERS.length)] } };
        const reply = composeNoted(req);
        const model = modelWrites(req, reply);
        if (reply.text || model) sayReply(req, reply, model, { to: human, kind: 'reply', count: true, emote: chatDice.roll() < WAVE_HELLO_CHANCE ? 'wave' : undefined });
        return;
    }

    if (market === 'none' && chatDice.roll() < NOBODY_SELLS_CHANCE) {
        const bot = pickResponder(crowd, human, p => 0.2 + p.helpfulness);
        // (a market line: the rules', never a model's)
        const req: ReplyRequest = { bot, to: human, heard: mes, channel: 'public', via: 'crowd', greeted: false, intent: { id: 'market_none', text: NOBODY_SELLS[Math.floor(Math.random() * NOBODY_SELLS.length)] } };
        const reply = composeNoted(req);
        if (reply.text) sayReply(req, reply, false, { to: human, kind: 'reply', count: true });
        return;
    }
    if (market !== null) return;

    // what the line asks (as the nearest bot reads it): only questions and requests a crowd answers
    const probe = intentOf(mes, crowd[0], human);
    if (!probe || !CROWD_INTENTS.has(probe.id)) {
        // (phase 7: a question to nobody the rules do not answer: a model could, by the nearest bot as the capture has it)
        if (!probe && isQuestionText(mes)) {
            noteCandidate({ bot: crowd[0], to: human, heard: mes, channel: 'public', via: 'crowd', greeted: false, intent: null });
            // (phase 7: with a model, one bot answers it now and then, at the crowd's own chance; no second bot)
            if (modelAvailable() && chatDice.roll() < crowdChance(crowd)) {
                const bot = pickResponder(crowd, human, p => 0.15 + p.helpfulness);
                const req: ReplyRequest = { bot, to: human, heard: mes, channel: 'public', via: 'crowd', greeted: false, intent: null };
                const reply = composeNoted(req);
                if (modelWrites(req, reply, true)) sayReply(req, reply, true, { to: human, kind: 'reply', count: true, then: () => noteSpoke(bot, 'social', World.currentTick, human) });
            }
        }
        return;
    }
    if (chatDice.roll() >= crowdChance(crowd)) return;

    const bot = pickResponder(crowd, human, p => 0.15 + p.helpfulness);
    const persona = botPersona(bot);
    let intent = intentOf(mes, bot, human, true);
    if (isRude(persona) && Math.random() < RUDE_CHANCE) intent = { id: 'rude', text: CROWD_RUDE[Math.floor(Math.random() * CROWD_RUDE.length)] };
    const req: ReplyRequest = { bot, to: human, heard: mes, channel: 'public', via: 'crowd', greeted: false, intent };
    const reply = composeNoted(req);
    const model = modelWrites(req, reply);
    if (!reply.text && !model) return;
    sayReply(req, reply, model, {
        to: human,
        kind: 'reply',
        count: true,
        then: () => {
            // (the human's next line may be for it: "ty", "where?": the reply window, port/BotSpoke)
            noteSpoke(bot, 'social', World.currentTick, human);
            crowdSecond(human, name, mes, bot, intent);
        }
    });
}

/** port (the realism work): another bot's reaction 2-6 s after a crowd's answer, now and then: its own answer, a "ya", a "lol", a rude one */
function crowdSecond(human: Player, name: string, mes: string, first: Player, firstIntent: IntentResult | null): void {
    if (human.slot === -1) return;
    const crowd = earshot(human, name, first);
    if (crowd.length === 0 || chatDice.roll() >= SECOND_CHANCE) return;
    const bot = pickResponder(crowd, human, p => 0.2 + p.sociability);
    const persona = botPersona(bot);
    const own = intentOf(mes, bot, human, true);
    // (its own answer: always to a question about the bots themselves, "asl", "u from uk?"; half the time to one about
    // the world, else "ya": a "ya" to "nah im too low" would read as a yes)
    const personal = PERSONAL_INTENTS.has(firstIntent?.id ?? '');
    let intent: IntentResult;
    // (phase 5a, Track F: a rude talker's, isRude; it was friendliness below -0.3, PKers only)
    if (isRude(persona) && Math.random() < 0.5) intent = { id: 'second', text: pickOf(SECOND_RUDE) };
    else if (firstIntent?.id === 'rude' || firstIntent?.id === 'beg') intent = { id: 'second', text: pickOf(SECOND_LAUGH) };
    else if (own && own.text !== firstIntent?.text && (personal || Math.random() < 0.5)) intent = own;
    else intent = { id: 'second', text: pickOf(!personal && Math.random() < 0.7 ? SECOND_AGREE : SECOND_LAUGH) };
    const req: ReplyRequest = { bot, to: human, heard: mes, channel: 'public', via: 'second', greeted: false, intent };
    const reply = composeNoted(req);
    const model = modelWrites(req, reply);
    if (reply.text || model) sayReply(req, reply, model, { to: human, kind: 'reply', count: true }, 1 + Math.floor(Math.random() * 4));
}

// ── Bots to bots (the realism work: onBotLine) ─────────────────────────────────────────────────────────────────────

/** the area (274's 64-tile map square) of a bot: one bot-to-bot exchange starts there at most every AREA_TALK_GAP */
const areaTalkAt = new Map<string, number>();
function areaFree(bot: Player, now: number): boolean {
    const key = `${bot.x >> 6}_${bot.z >> 6}_${bot.level}`;
    if (now - (areaTalkAt.get(key) ?? -Infinity) < AREA_TALK_GAP) return false;
    areaTalkAt.set(key, now);
    if (areaTalkAt.size > 4096) areaTalkAt.clear();
    return true;
}

/** a line said to anyone: a question ("where can i mine iron?", "anyone wanna be friends?") */
export function isQuestionText(text: string): boolean {
    return text.includes('?') || /^(how|where|what|whats|who|why|when|which|anyone|any1|anybody|does anyone|is there|can (i|you|u|some|any)|wanna|want to|do you|do u)\b/i.test(text.trim());
}

/** a yes-or-no question to anyone ("anyone wanna be friends?", "is there a bank here?", "wanna race?") */
function isYesNoQuestion(text: string): boolean {
    return /^(anyone|any1|anybody|does anyone|is there|can (some|any)|wanna|want to|do you|do u|who wants|any one)\b/i.test(text.trim());
}

/** a bot named in the line (its whole name or a first name), of those in earshot of the speaker and free to answer */
function namedBotIn(crowd: Player[], text: string): Player | null {
    const said = addressingText(text);
    for (const bot of crowd) {
        if (namesBot(said, bot)) return bot;
        const first = firstNameOf(bot);
        if (first !== null && said.startsWith(` ${first} `)) return bot;
    }
    return null;
}

/**
 * a bot's answer to another bot's line (`to`), at most 3 lines deep: the answer, then now and then the asker's "ty"; (variety
 * round 2) or, when the answer asks back (`question`: what was asked), the asker's own answer (answerBack). (The fixes, B1:
 * `askAfter`, the question back as a line of its own after an answer of upstream's, "I'm alright" / "u?".)
 */
function botAnswer(bot: Player, to: Player, text: string, ack: { chance: number; lines: readonly string[] } | null, question?: string, askAfter?: string): void {
    const now = World.currentTick;
    memoryOf(bot).botTalkAt = now;
    sayTyped(bot, text, {
        to,
        kind: 'botreply',
        then: () => {
            if (question !== undefined && askAfter !== undefined) {
                // (the fixes, B3: a line the answer had no room for before, in the place of one of its own: the talk budget)
                if (BotManager.botFor(bot) === null || isAway(bot)) return;
                countAsOwnLine(bot);
                return void sayTyped(bot, askAfter, { to, kind: 'botreply', then: () => answerBack(to, bot, question) });
            }
            if (question !== undefined) return void answerBack(to, bot, question);
            // (depth 2: the asker's "ty" or "ok"; nothing answers that)
            if (!ack || BotManager.botFor(to) === null || isAway(to) || chebyshev(bot, to) > HEARING_DISTANCE || chatDice.roll() >= ack.chance) return;
            sayTyped(to, ack.lines[Math.floor(Math.random() * ack.lines.length)], { to: bot, kind: 'botreply' });
        }
    }, reactionTicks(botPersona(bot), 'notice'));
}

/**
 * (variety round 2, S2-2) one of `crowd`, as `pick` draws it, under its voice's share of a busy place (port/BotVoice), or
 * null. (The fixes, B4: the dice first, then the cap on the one drawn, a few draws at most, as port/BotThreads.partnerFor;
 * a screen of the whole crowd cost about 0.5 ms a crowd of 50 at every line and counted each bot it held.)
 */
function pickUnderCap(crowd: readonly Player[], now: number, pick: (from: Player[]) => Player): Player | null {
    const left = [...crowd];
    for (let tries = 0; tries < 3 && left.length; tries++) {
        const bot = pick(left);
        if (voiceRoom(bot, now)) return bot;
        left.splice(left.indexOf(bot), 1);
    }
    // (one line held, however many were drawn: the report's count)
    if (crowd.length) noteVoiceHeld();
    return null;
}

/** of the bots in earshot, those that may answer a bot line now: not answered a bot lately */
function botCrowd(inEarshot: Player[]): Player[] {
    const now = World.currentTick;
    return inEarshot.filter(bot => now - (memoryOf(bot).botTalkAt ?? -Infinity) >= BOT_TALK_GAP);
}

/** a bot's question to anyone: one bot in earshot answers it now and then (from its view: processIntent), "idk" when it knows no answer */
function botQuestion(asker: Player, text: string, newbie: boolean, inEarshot: Player[]): void {
    const now = World.currentTick;
    const crowd = botCrowd(inEarshot);
    if (crowd.length === 0 || !areaFree(asker, now)) return;
    const understood = botIntent(text, crowd[0], asker) !== null;
    const chance = Math.min(0.9, (understood ? BOT_ANSWER_CHANCE : BOT_SHRUG_CHANCE) * (crowd.length > 2 ? 1.15 : 1) + (newbie ? 0.15 : 0));
    if (chatDice.roll() >= chance) return;
    // (variety round 2, S2-2: one under its share of a busy place's talk answers: port/BotVoice; the fixes, B4: checked on
    // the one drawn)
    const bot = pickUnderCap(crowd, now, from => pickResponder(from, asker, p => 0.15 + p.helpfulness * 0.6 + p.sociability * 0.4));
    if (bot === null) return;
    const intent = botIntent(text, bot, asker, true);
    // (variety round 1: a shrug another bot said here lately, or the human heard, is not said again: the registry, W4)
    const answer = intent?.text ?? (isYesNoQuestion(text) ? pickOf(Math.random() < 0.3 ? BOT_YES : BOT_NO) : freshLine(bot, ANSWER_LINES.shrug));
    if (answer === null) return;
    // (variety round 1, SAY-7: no "ty" for a laugh, a shrug or a "?": nothing to thank)
    // (variety round 2, S2-1: an answer that asks back, "41 u?", "cutting willows, you?": the asker answers from its own
    // state, no "ty"; an answer about itself asks back now and then, as 2004's did)
    // (asked back only when the asker has an answer of its own to give)
    // (the fixes, B1: an answer of upstream's keeps its words, its question back a line of its own: askBack)
    const said = askBack(botFill(answer, asker), intent, () => botIntent(text, asker, bot) !== null);
    if (said.after !== undefined || COUNTER_RX.test(said.text.trim())) return void botAnswer(bot, asker, said.text, null, text, said.after);
    botAnswer(bot, asker, said.text, noAnswer(answer) ? null : { chance: newbie ? NEWBIE_THANKS_CHANCE : BOT_ACK_CHANCE, lines: newbie ? NEWBIE_THANKS : BOT_ACK });
}

/**
 * (the variety work, round 2, S2-1: the counter-question rule) `bot` answered `asker`'s `question` and asked back ("41 u?",
 * "cutting willows, you?"): the asker gives its own answer, from its state (processIntent from its view, any question
 * back of its own cut), when it is still here and knows one; now and then the answerer says a word to it ("nice")
 */
function answerBack(asker: Player, bot: Player, question: string): void {
    const here = BotManager.botFor(asker) !== null && !isAway(asker) && chebyshev(bot, asker) <= HEARING_DISTANCE;
    const text = here ? ownAnswerBack(question, asker, bot) : null;
    noteCounter(text !== null && text.length > 0);
    if (!text) return;
    // (the fixes, B3: the answer back and the word on it are lines the exchange had no room for before, each in the place
    // of one of its sayer's own: the talk budget, H7)
    countAsOwnLine(asker);
    sayTyped(asker, botFill(text, bot), { to: bot, kind: 'botreply', then: () => {
        if (BotManager.botFor(bot) === null || isAway(bot) || chatDice.roll() >= BACK_WORD_CHANCE) return;
        const word = freshLine(bot, BACK_WORDS);
        if (word === null) return;
        countAsOwnLine(bot);
        sayTyped(bot, word, { to: asker, kind: 'botreply' });
    } }, reactionTicks(botPersona(asker), 'notice'));
}

/**
 * (the fixes, B1) the asker's own answer to the question it asked, from its state, its question back cut ("41 u?" is 41);
 * one of upstream's as it is: one of them that asks back ("Just chilling, you?") is drawn again, a few times, else none
 */
function ownAnswerBack(question: string, asker: Player, bot: Player): string | null {
    for (let i = 0; i < 3; i++) {
        const own = botIntent(question, asker, bot, true);
        if (!own) return null;
        if (!own.upstream) return withoutCounter(own.text) ?? own.text;
        if (!COUNTER_RX.test(own.text.trim())) return own.text;
    }
    return null;
}


/** (variety round 1, SAY-7) an answer that answers nothing: a laugh, a smiley, a shrug, a "?" */
function noAnswer(answer: string): boolean {
    const t = answer.trim().toLowerCase();
    return isLaugh(cleanMessage(t)) || /^[:;=]-?[()dpo3]$/.test(t) || (CONFUSED as readonly string[]).includes(t) || (ANSWER_LINES.shrug as readonly string[]).includes(answer);
}

/** (variety round 1, SAY-7) a newbie said it is new: now and then one bot near it welcomes it ("welcome", "gl") */
function botWelcome(newbie: Player, inEarshot: Player[]): void {
    const now = World.currentTick;
    const crowd = botCrowd(inEarshot);
    if (crowd.length === 0 || !areaFree(newbie, now) || chatDice.roll() >= NEWBIE_WELCOME_CHANCE) return;
    const bot = pickResponder(crowd, newbie, p => Math.max(0.05, 0.1 + p.helpfulness * 0.5 + p.friendliness * 0.3));
    botAnswer(bot, newbie, pickOf(NEWBIE_WELCOME), { chance: 0.4, lines: NEWBIE_WELCOME_TY });
}

/** what a bot would answer another bot (null: nothing it knows; upstream's fillers do not count) */
function botIntent(text: string, bot: Player, asker: Player, keep = false): IntentResult | null {
    const intent = intentOf(text, bot, asker, keep);
    return intent && !BOT_SKIP_INTENTS.has(intent.id) && intent.id !== 'follow' ? intent : null;
}

/** {name} in a bot's answer to a bot: the asker's name now and then, else none */
function botFill(text: string, to: Player): string {
    return text.includes('{name}') ? (Math.random() < 0.3 ? text.replaceAll('{name}', firstNameOf(to) ?? to.displayName) : dropName(text)) : text;
}

/** a line that names a bot in earshot ("hey kevin1991 :)", "sammy jo have you met ..."): that bot answers it, now and then */
function botNamed(speaker: Player, bot: Player, text: string): void {
    const now = World.currentTick;
    if (now - (memoryOf(bot).botTalkAt ?? -Infinity) < BOT_TALK_GAP || !areaFree(speaker, now)) return;
    const line = withoutName(text, bot);
    const greeting = isPureGreeting(line) || line.trim() === '';
    const intent = greeting ? { id: 'greeting', text: pickOf(BOT_HELLO) } : botIntent(line, bot, speaker, true);
    const chance = intent ? 0.7 * (0.5 + botPersona(bot).sociability) : 0.25;
    if (chatDice.roll() >= chance) return;
    const answer = intent?.text ?? pickOf(isQuestionText(line) ? ANSWER_LINES.shrug : CONFUSED);
    // (variety round 2, S2-1: an answer that asks back gets the asker's own: the counter-question rule)
    // (the fixes, B1: an answer of upstream's keeps its words, its question back a line of its own: askBack)
    const said = intent && !greeting ? askBack(botFill(answer, speaker), intent, () => botIntent(line, speaker, bot) !== null) : { text: botFill(answer, speaker) };
    if (intent && !greeting && (said.after !== undefined || COUNTER_RX.test(said.text.trim()))) return void botAnswer(bot, speaker, said.text, null, line, said.after);
    botAnswer(bot, speaker, said.text, greeting || noAnswer(answer) ? null : { chance: BOT_ACK_CHANCE * 0.6, lines: BOT_ACK });
}

/** a bot's hello to everyone ("hi all"): one bot near it says hello back, now and then */
function botGreeting(greeter: Player, inEarshot: Player[]): void {
    const now = World.currentTick;
    const crowd = botCrowd(inEarshot);
    if (crowd.length === 0 || !areaFree(greeter, now)) return;
    if (chatDice.roll() >= Math.min(0.5, 0.2 + 0.05 * crowd.length)) return;
    const bot = pickResponder(crowd, greeter, p => 0.1 + p.sociability);
    botAnswer(bot, greeter, pickOf(BOT_HELLO), null);
}

/**
 * a bot's level-up line: 0-2 bots within 15 tiles say gz (by sociability; each at most every GZ_GAP), and the leveller
 * now and then thanks the first (the research's C8: gz to at least 30 % of the level-ups near other bots).
 * (The variety work, round 2, S2-6: whether anyone says gz is one roll for the crowd, by how many are near (GZ_ANY: a
 * lone friend about half the time, a crowd more), then who: the first by sociability, chatting lately and friendship
 * (port/BotCliques), a second now and then. Each bot's own roll gave a lone bot near about a fifth and a crowd of eight
 * four in five: C8 27-60 % by the world. A level-up line that names no skill ("lvl!", "40!!") now and then gets "in
 * what?" instead, and the leveller's answer, "wc lol".)
 */
function botLevelUp(leveller: Player): void {
    const now = World.currentTick;
    // (port, phase 3: a friend of its clique first, and more readily: port/BotCliques)
    const crowd = earshot(leveller, null, null, 15).filter(bot => now - (memoryOf(bot).gzAt ?? -Infinity) >= GZ_GAP);
    if (crowd.length === 0) return;
    const any = Math.min(GZ_ANY[1], GZ_ANY[0] + GZ_ANY_STEP * (crowd.length - 1)) * (crowd.some(b => sameClique(b.username, leveller.username)) ? 1.2 : 1);
    if (chatDice.roll() >= any) return;
    const weight = (bot: Player): number => {
        const persona = botPersona(bot);
        return (0.1 + 0.4 * persona.sociability + (persona.friendliness > 0.3 ? 0.1 : 0)) * (chatting(bot) ? 2 : 1) * (sameClique(bot.username, leveller.username) ? 3 : 1);
    };
    // (variety round 2, S2-2: one under its share of a busy place's talk; the fixes, B4: checked on the one drawn, the
    // second too)
    const first = pickUnderCap(crowd, now, from => pickWeighted(from, weight));
    if (first === null) return;
    const line = lastLevelUpLine.get(leveller) ?? '';
    // (variety round 2: "lvl!" names no skill: "in what?" now and then, and the leveller says which)
    if (!namesSkill(line) && chatDice.roll() < IN_WHAT_CHANCE && askInWhat(first, leveller, now)) return;
    const responders = [first];
    if (crowd.length >= 2 && chatDice.roll() < GZ_SECOND) {
        const second = pickUnderCap(crowd.filter(b => b !== first), now, from => pickWeighted(from, weight));
        if (second !== null) responders.push(second);
    }
    responders.forEach((bot, i) => {
        // (a gz another bot said here lately is not said again: the repetition registry, port/BotLines)
        const gz = freshLine(bot, BOT_GZ);
        if (gz === null) return;
        memoryOf(bot).gzAt = now;
        sayTyped(bot, gz, {
            to: leveller,
            kind: 'botreply',
            then: i === 0
                ? () => {
                      if (BotManager.botFor(leveller) === null || isAway(leveller)) return;
                      const thanks = chatDice.roll() < LEVELLER_TY_CHANCE * (0.6 + 0.4 * botPersona(leveller).friendliness);
                      const ty = thanks ? freshLine(leveller, TY_ANSWERS) : null;
                      // (variety round 2, S2-1: now and then a question on it, "how long did that take", and its answer)
                      const more = (): void => {
                          if (chatDice.roll() >= LEVEL_MORE_CHANCE || BotManager.botFor(bot) === null || isAway(bot) || chebyshev(bot, leveller) > HEARING_DISTANCE) return;
                          const qa = levelUpMore(bot, leveller);
                          if (qa === null) return;
                          // (the fixes, B3: the question and its answer each in the place of a line of its sayer's own)
                          countAsOwnLine(bot);
                          sayTyped(bot, qa[0], { to: leveller, kind: 'botreply', then: () => {
                              if (BotManager.botFor(leveller) === null || isAway(leveller)) return;
                              countAsOwnLine(leveller);
                              sayTyped(leveller, qa[1], { to: bot, kind: 'botreply' }, reactionTicks(botPersona(leveller), 'notice'));
                          } }, reactionTicks(botPersona(bot), 'notice'));
                      };
                      if (ty !== null) sayTyped(leveller, ty, { to: bot, kind: 'botreply', then: more });
                      else more();
                  }
                : undefined
        }, reactionTicks(botPersona(bot), 'notice') + (i === 0 ? 0 : 2));
    });
}

/** (variety round 2, tests) the chance a level-up line gets a gz from a crowd of `n` free bots near (no friend among them) */
export function gzChanceForTest(n: number): number {
    return n <= 0 ? 0 : Math.min(GZ_ANY[1], GZ_ANY[0] + GZ_ANY_STEP * (n - 1));
}

/** (variety round 2, S2-6) a gz from the crowd: its chance with one bot near, each more adds, at most; a second one's */
const GZ_ANY: [number, number] = [0.6, 0.85];
const GZ_ANY_STEP = 0.06;
const GZ_SECOND = 0.3;
/** (variety round 2, S2-1) the first gz's sayer asks on now and then ("how long did that take") */
const LEVEL_MORE_CHANCE = 0.3;
/** (variety round 2) "in what?" to a level-up line that names no skill */
const IN_WHAT_CHANCE = 0.3;
/** (variety round 2) the level-up line each bot said last (BotChatter: onBotLine's text), for "in what?" */
const lastLevelUpLine = new WeakMap<Player, string>();

/** one of `list` by `weight` */
function pickWeighted(list: readonly Player[], weight: (bot: Player) => number): Player {
    let x = chatDice.roll() * list.reduce((s, b) => s + weight(b), 0);
    for (const b of list) if ((x -= weight(b)) <= 0) return b;
    return list[list.length - 1];
}

/** (variety round 2) does a level-up line name its skill ("40 wc!!" does, "lvl!" and "40!!" do not)? */
function namesSkill(line: string): boolean {
    return splitWords(cleanMessage(line)).some(w => SKILL_WORDS.has(w));
}

/** (variety round 2) "in what?" to the leveller, its answer from its last level-up ("wc lol"), and "nice gz" now and then */
function askInWhat(asker: Player, leveller: Player, now: number): boolean {
    const ev = recentEventsOf(leveller, now, 200).find(e => e.name === 'levelup' && e.stat);
    const ask = THREAD_LINES.topics.inwhat;
    if (!ev?.stat || !ask) return false;
    const q = freshLine(asker, ask.ask);
    if (q === null) return false;
    memoryOf(asker).gzAt = now;
    sayTyped(asker, q, {
        to: leveller,
        kind: 'botreply',
        then: () => {
            if (BotManager.botFor(leveller) === null || isAway(leveller) || chebyshev(asker, leveller) > HEARING_DISTANCE) return;
            const skill = skillShort(ev.stat!);
            const answers = (ask.answer as string[]).map(a => a.replace('{v}', skill)).filter(a => WordEnc.filter(a) === a);
            const answer = answers.length ? freshLine(leveller, answers) : null;
            noteCounter(answer !== null);
            if (answer === null) return;
            // (the fixes, B3: "in what?" stands in for a gz; its answer and the word after it are lines of their own: the
            // talk budget)
            countAsOwnLine(leveller);
            sayTyped(leveller, answer, {
                to: asker,
                kind: 'botreply',
                then: () => {
                    if (BotManager.botFor(asker) === null || chatDice.roll() >= 0.6) return;
                    const word = freshLine(asker, (ask.after as string[]) ?? []);
                    if (word === null) return;
                    countAsOwnLine(asker);
                    sayTyped(asker, word, { to: leveller, kind: 'botreply' });
                }
            }, reactionTicks(botPersona(leveller), 'notice'));
        }
    }, reactionTicks(botPersona(asker), 'notice'));
    return true;
}

// ── Typing (the realism work): a line takes its sayer's time ─────────────────────────────────────────────────────

interface TypedLine {
    /** whom it answers (a human or a bot), for the say listeners */
    to: Player | null;
    kind: LineKind;
    /** the emote said with it (port/BotEmote) */
    emote?: Emote;
    /** a public reply to a human: counted (repliesSent, repliesBy) */
    count?: boolean;
    /** a willing bot follows this player a little way once it said it (port/BotFollow) */
    follow?: Player | null;
    /** said in a private message to this player instead of out loud */
    pm?: Player;
    /** a turn of its conversation with `to`: its 30 s run again from when the line is said */
    talk?: boolean;
    /** once the whole line is said */
    then?: () => void;
    // (no colour or effect: typed talk is plain yellow, 2026-10-18: 2004's players dressed up their adverts, not their talk)
}

/** a bot's persona (its name and planner: port/BotPersona), kept with its Player (personaOf normalises the name each call) */
const personas = new WeakMap<Player, Persona>();
export function botPersona(bot: Player): Persona {
    let persona = personas.get(bot);
    if (!persona) {
        persona = personaOf(bot.username, bot.botPlanner as PlannerKey);
        personas.set(bot, persona);
    }
    return persona;
}

/**
 * port (the realism work): the bot types `text` and says it: after `extra` ticks (reading, noticing), its thinking and
 * typing time (port/BotTiming.typingTicks: its persona's speed, slower when busy), a long line in parts each typed in
 * turn, one line at a time (a second waits for the first). Dropped if the bot left or went away meanwhile.
 */
export function sayTyped(bot: Player, text: string, line: TypedLine, extra = 0): void {
    const persona = botPersona(bot);
    const memory = memoryOf(bot);
    const now = World.currentTick;
    const busy = isBusy(bot);
    const parts = splitLine(text);
    let due = Math.max(now, memory.typingUntil ?? 0) + extra;
    const dues = parts.map((part, i) => (due += i === 0 ? typingTicks(persona, part, { busy }) : partTicks(persona, part)));
    memory.typingUntil = due;
    sayParts(bot, parts, dues, line, null);
}

/**
 * (phase 7) a reply typed from its decision (port/BotModel: the model's words, or the rules' line when they fall back):
 * its first part said at `firstDue` (at once when that is now), the rest each typed in turn after it, one line at a time
 * (the bot's typingUntil); `correction` (a typo's "*word", port/BotStyle) 2-4 ticks after the line.
 */
function sayTypedAt(bot: Player, text: string, line: TypedLine, firstDue: number, correction: string | null = null): void {
    const persona = botPersona(bot);
    const memory = memoryOf(bot);
    const parts = splitLine(text);
    let due = Math.max(World.currentTick, firstDue);
    const dues = parts.map((part, i) => (i === 0 ? due : (due += partTicks(persona, part))));
    memory.typingUntil = Math.max(memory.typingUntil ?? 0, due);
    sayParts(bot, parts, dues, line, correction);
}

/** a line's parts said at their ticks (sayTyped, sayTypedAt) */
function sayParts(bot: Player, parts: string[], dues: number[], line: TypedLine, correction: string | null): void {
    const memory = memoryOf(bot);
    const now = World.currentTick;
    parts.forEach((part, i) => {
        const say = (): void => {
            // port: still this login (a reply for a bot that left, or left and came back, is dropped), and not away
            if (BotManager.botFor(bot) === null || isAway(bot)) return;
            if (line.pm) {
                if (line.pm.slot === -1) return;
                privateMessage(bot, line.pm, part);
                memory.privateAt = World.currentTick;
            } else {
                botSay(bot, part, undefined, line.kind, line.to);
            }
            if (i === 0) {
                // port: and the emote with it (port/BotEmote: not while the bot is busy)
                if (line.emote) botEmote(bot, line.emote);
                if (line.count) {
                    repliesSent++;
                    repliesByBot.set(bot, (repliesByBot.get(bot) ?? 0) + 1);
                }
                if (line.follow && line.follow.slot !== -1 && chebyshev(bot, line.follow) <= HEARING_DISTANCE) {
                    BotManager.botFor(bot)?.setSubTask(new FollowTask(line.follow, 34 + Math.floor(Math.random() * 34)));
                }
            }
            if (i === parts.length - 1) {
                // port: the conversation's 30 s run from when the reply is said
                if (line.talk && line.to && memory.state === 'engaged' && memory.lastSpeakerId === speakerName(line.to)) memory.lastInteractionTime = World.currentTick;
                line.then?.();
                if (correction !== null) sayCorrection(bot, correction, line);
            }
        };
        if (dues[i] <= now) say();
        else scheduleInTicks(dues[i] - now, say);
    });
}

/** (phase 7) a typo's "*word" a moment after the line (port/BotStyle), the same way (out loud or in the private message) */
function sayCorrection(bot: Player, text: string, line: TypedLine): void {
    scheduleInTicks(2 + Math.floor(chatDice.roll() * 3), () => {
        if (BotManager.botFor(bot) === null || isAway(bot)) return;
        if (line.pm) {
            if (line.pm.slot !== -1) privateMessage(bot, line.pm, text);
        } else botSay(bot, text, undefined, line.kind, line.to);
    });
}

/** a long line's next part: only its typing (the thinking was done), at least 2 ticks */
function partTicks(persona: Persona, part: string): number {
    return Math.max(2, Math.round(part.length / persona.typingCps / 0.6));
}

function pickOf<T>(list: readonly T[]): T {
    return list[Math.floor(Math.random() * list.length)];
}

// ── composeReply (the realism work): every reply text to a human ────────────────────────────────────────────────

/** What the rules understood in a line, and their answer from the bot's state. */
export interface IntentResult {
    /** the intent: a JSON intent's id ('joke', 'bot', 'total' ...), or the code's ('greeting', 'combat', 'where', 'doing', 'asl', 'directions', 'price' ...) */
    id: string;
    /** the answer as the rules put it, its slots filled; {name} (the human's name) is composeReply's to keep or drop */
    text: string;
    /** a short real Follow comes with it (port/BotFollow) */
    follow?: boolean;
    /**
     * port (the variety work, round 2, the fixes: B1) the answer is upstream's (chat_responses.json, its goodbyes), word for
     * word: no question back is joined to it nor cut from it (askBack, answerBack: "keep upstream flavour")
     */
    upstream?: boolean;
}

/** One reply to a human, as composeReply takes it. */
export interface ReplyRequest {
    bot: Player;
    to: Player;
    /** the human's line as typed */
    heard: string;
    channel: 'public' | 'private';
    /** how the line reached the bot: its name, the reply window, its conversation, said to nobody (the crowd, a second bot), a private message, the marketplace, a reaction of its own (port/BotReactions) */
    via: 'named' | 'window' | 'conversation' | 'crowd' | 'second' | 'private' | 'market' | 'reaction';
    /** the human greeted in the line */
    greeted: boolean;
    /** what the rules understood (null: nothing) */
    intent: IntentResult | null;
}

/**
 * port (the realism work, phase 2): every reply text a bot says to a human, from what the rules understood (the
 * intent and its answer from the bot's state) and the bot's persona: no greeting in front of an answer (now and then a
 * "hey" when the human greeted), the human's name in about one reply in five (the persona's echo), a "?" or "wat" now
 * and then for a named line nothing understands (else null: nothing said), a smiley or laugh of the persona's now and
 * then; whole under the word filter or the plainer line. Phase 7's language model replaces only this function (the
 * marketplace and reactions' rule lines it must keep as they are: trades and errands stay rules).
 */
export function composeReply(req: ReplyRequest): string | null {
    return composeNoted(req).text;
}

/** the rules' reply, and whether it is one of phase 5a's rude lines (they stay the rules' with a model: port/BotModel) */
interface RulesReply {
    text: string | null;
    rude: boolean;
}

/** a RulesReply (its fields shorthand: test/chat-filter.test.mjs follows the strings a line is made of by their names) */
function rulesReply(text: string | null, rude = false): RulesReply {
    return { text, rude };
}

/** composeReply's rules, told to a capture's listeners (port/BotModel: every reply the rules composed; no dice, no effect) */
function composeNoted(req: ReplyRequest): RulesReply {
    const reply = composeRulesReply(req);
    noteComposed(req, reply.text);
    return reply;
}

/** composeReply's rules (the realism work, phases 2-5) */
function composeRulesReply(req: ReplyRequest): RulesReply {
    const persona = botPersona(req.bot);
    const intent = req.intent;
    if (!intent) {
        if ((req.via === 'named' || req.via === 'private') && chatDice.roll() < CONFUSED_CHANCE * (req.via === 'private' ? 0.5 : 1)) {
            return rulesReply(pickOf(persona.friendliness < -0.2 ? CONFUSED_RUDE : CONFUSED));
        }
        return rulesReply(null);
    }
    if (req.via === 'market') return rulesReply(intent.text);
    const name = speakerName(req.to);
    const echo = Math.random() < echoChance(persona);
    const nameless = dropName(intent.text);
    let text = nameless;
    if (echo && intent.text.includes('{name}')) text = intent.text.replaceAll('{name}', name);
    else if (echo && intent.id === 'greeting' && /^[a-z]+!?$/i.test(nameless)) text = `${nameless} ${name}`;
    // (a name the filter reads into the line, "gz Hit N Run", goes)
    const plain = isClean(text) ? text : nameless;
    text = plain;
    // (the realism work's phase 5a, Track F: a rude talker's reply is now and then a rude one where the question allows
    // ("use ur map lol", "get a job lol", "who asked", "{answer} nub": port/BotRude); the crowd's and the second bot's
    // rude answers are rude replies too; never to a "follow me" it agrees to, nor in a reaction of its own)
    if (intent.id === 'rude' || (intent.id === 'second' && (SECOND_RUDE as readonly string[]).includes(intent.text))) {
        noteRudeReply(req.bot, plain);
        return rulesReply(plain, true);
    }
    if (RUDE_VIAS.has(req.via)) {
        const rude = rudeReply(req.bot, intent.id, nameless, intent.follow === true);
        if (rude !== null && isClean(rude)) {
            noteRudeReply(req.bot, rude);
            return rulesReply(rude, true);
        }
    }
    // a "hey" before the answer, now and then, when the human greeted
    if (req.greeted && intent.id !== 'greeting' && (req.via === 'named' || req.via === 'private') && Math.random() < 0.15) text = joinGreeting(pickOf(HI_ANSWERS), text);
    // a smiley or a laugh of the persona's, now and then, on a line without one (not its sad face: on an answer it reads
    // as sulking)
    if (!/[:;][)(dpo]|\b(lol|lmao|haha|rofl|xd|hehe)\b/i.test(text) && Math.random() < 0.08) {
        const tokens = [...persona.style.smileys.filter(t => t !== ':('), ...persona.style.laughs];
        if (tokens.length) text = `${text} ${pickOf(tokens)}`;
    }
    return rulesReply(isClean(text) ? text : plain);
}

// ── The language model (the realism work, phase 7: port/BotModel) ────────────────────────────────────────────────

/**
 * (phase 7) whether a model words this reply (spec §3): one in its scope (port/BotModel wantsModel: the vias, the
 * rules-only intents, not a rude line) with a model there; a named line or a private message nothing understood at the
 * persona's chance (else the rules' "?" or nothing, as before); a line the rules left unanswered elsewhere was rolled
 * where it came (`rolled`). Draws a die only with a model.
 */
function modelWrites(req: ReplyRequest, reply: RulesReply, rolled = false): boolean {
    if (!wantsModel(req, reply.rude)) return false;
    if (req.intent || rolled) return true;
    if (req.via === 'named' || req.via === 'private') return chatDice.roll() < unansweredChance(botPersona(req.bot));
    return false;
}

/** (phase 7) a line the rules left unanswered gets a model reply: a model is there and the die says so (`chance`) */
function modelCandidate(req: ModelScopeRequest, chance: number): boolean {
    return wantsModel(req) && chatDice.roll() < chance;
}

/**
 * A reply to a human: the rules' line typed as before, or (phase 7) a model asked for its words, the rules' line its
 * fallback. A newer reply of the bot's supersedes a model reply it still waits for (port/BotModel).
 */
function sayReply(req: ReplyRequest, reply: RulesReply, model: boolean, line: TypedLine, extra = 0): void {
    supersedeModelReply(req.bot);
    if (model) requestModelReply(req, reply.text, line, extra);
    else if (reply.text) sayTyped(req.bot, reply.text, line, extra);
}

/**
 * (phase 7) the request for a model's words (port/BotModel askModel) and what is done with the answer. From the decision
 * the bot is at its keyboard until the deadline (its typingUntil: no other line of its own meanwhile, as when it types
 * one); the model's line, through the guard and the persona's style, is said at max(the answer + 1, the decision + the
 * extra ticks + its typing time); a fallback says the rules' line timed the same way (at the deadline: at once), or
 * nothing where the rules had none or, superseded, when the conversation moved on.
 */
function requestModelReply(req: ReplyRequest, ruleText: string | null, line: TypedLine, extra: number): void {
    const bot = req.bot;
    const persona = botPersona(bot);
    const memory = memoryOf(bot);
    const now = World.currentTick;
    const busy = isBusy(bot);
    const start = Math.max(now, memory.typingUntil ?? 0);
    const deadline = start + extra + MODEL_DEADLINE_TICKS;
    memory.typingUntil = deadline;
    const release = (): void => {
        if (memory.typingUntil === deadline) memory.typingUntil = start;
    };
    const situation = situationOf(req, now);
    askModel({
        bot,
        to: req.to,
        via: req.via,
        intent: req.intent?.id ?? null,
        candidate: req.intent === null,
        heard: req.heard,
        situation,
        local: renderLocal(situation),
        online: renderOnline(situation),
        ruleText,
        deadline,
        keepName: chatDice.roll() < echoChance(persona),
        use: (text, entry) => {
            release();
            const styled = styleLine(text, persona, chatDice.roll);
            const due = Math.max(World.currentTick + 1, start + extra + typingTicks(persona, styled.line, { busy }));
            sayTypedAt(bot, styled.line, saidInto(line, entry, styled.line), due, styled.correction);
        },
        fallback: reason => {
            release();
            if (ruleText === null || (reason === 'superseded' && movedOn(req))) return;
            const t = World.currentTick;
            // (at once only at the engine's own deadline, when its typing time is spent; native's earlier 'timeout', an
            // error, the guard: typed from the decision, as the rules' own reply would have been: the review of the merge)
            const due = reason === 'deadline' ? t : Math.max(t + 1, start + extra + typingTicks(persona, ruleText, { busy }));
            sayTypedAt(bot, ruleText, line, due);
        }
    });
}

/** (phase 7) the conversation a superseded reply belonged to is over: the human left, the bot talks with someone else or ended it */
function movedOn(req: ReplyRequest): boolean {
    if (req.to.slot === -1) return true;
    const memory = memoryOf(req.bot);
    const name = speakerName(req.to);
    if (req.via === 'private') return memory.privateWith !== name;
    if (req.via === 'named' || req.via === 'window' || req.via === 'conversation') return !(memory.state === 'engaged' && memory.lastSpeakerId === name);
    return false;
}

/** (phase 7) the line, noting in the model's log what was said and when (humanlike's MD4) */
function saidInto(line: TypedLine, entry: ModelLogEntry, text: string): TypedLine {
    const then = line.then;
    return {
        ...line,
        then: () => {
            entry.said = text;
            entry.saidAt = World.currentTick;
            then?.();
        }
    };
}

/** (phase 5a, Track F) the replies a rude talker's may be rude in: to a line it was asked (not a reaction of its own, the marketplace) */
const RUDE_VIAS: ReadonlySet<ReplyRequest['via']> = new Set(['named', 'window', 'conversation', 'crowd', 'private']);

/** how often a bot says the human's name in a reply (its persona): 4-34 %, about one in five on average */
function echoChance(persona: Persona): number {
    return (0.04 + 0.3 * persona.sociability) * (persona.friendliness < 0 ? 0.6 : 1);
}

/** a reply without the human's name: "Thanks, {name}" → "Thanks", "Yes {name}?" → "Yes?", "Hey {name}, how's it going?" → "Hey, how's it going?" */
function dropName(text: string): string {
    return text
        .replace(/,?\s*\{name\}/g, '')
        .replace(/\{name\},?\s*/g, '')
        .replace(/\s+([?!.,])/g, '$1')
        .replace(/,([?!.])/g, '$1')
        .replace(/,$/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * a greeting back to "hey X": the port's ("hey", "sup", "yeah?"), upstream's greetingReplies ("Yes {name}?", "What do
 * you need, {name}?": every named line got one in front of it) one time in five, their name only with the echo
 */
const GREETING_BACK: Reply[] = [...chatResponses.greetingBack.map(normalizeReply), ...chatResponses.greetingReplies.map(normalizeReply).map(r => ({ ...r, weight: (r.weight ?? 1) * 0.25 }))];
function greetingBack(memory: BotMemory, bot: Player): IntentResult {
    return { id: 'greeting', text: pickSmart(GREETING_BACK, memory, bot), upstream: true };
}

// ── Private messages (port: answered) ─────────────────────

/** port: the tick the next friend bot's unasked message is due (-1: not drawn yet) */
let nextOpener = -1;

/** port: who a friend bot's unasked message goes to, and from which one: a human whose private chat is not off, and an online friend bot that is not busy (null: none) */
export function pickOpener(isFriend: (name: string) => boolean): { human: Player; bot: Player } | null {
    const humans = [...World.playerLoop.all()].filter(p => !p.is_bot && isClientConnected(p) && p.privateChat !== ChatModePrivate.OFF);
    if (humans.length === 0) return null;
    const human = humans[Math.floor(Math.random() * humans.length)];
    const friends = [...BotManager.activeBots()].filter(b => isFriend(b.username) && b.botTradeTargetPid === -1 && !inFight(b) && !BotChat.inConversation(b) && !isAway(b));
    if (friends.length === 0) return null;
    return { human, bot: friends[Math.floor(Math.random() * friends.length)] };
}

/** port: the friend bot's message, which opens a private conversation (the human's answer gets one back) */
export function sendFriendOpener(human: Player, bot: Player): void {
    const memory = memoryOf(bot);
    memory.privateWith = speakerName(human);
    memory.privateAt = World.currentTick;
    privateMessage(bot, human, friendOpener(bot));
    repliesSent++;
}

/**
 * (the variety work, round 1, S9) a friend's first message: a level it got in the last 10 minutes ("just got 40 wc!!"),
 * else what it is doing and where ("hey, cutting willows in draynor"), else one of FRIEND_OPENERS; whole under the word
 * filter and within a private message's 80 characters
 */
export function friendOpener(bot: Player): string {
    const now = World.currentTick;
    const options: string[] = [];
    const level = recentEventsOf(bot, now, FRIEND_LEVEL_TICKS).find(e => e.name === 'levelup' && e.stat && e.level);
    if (level && Math.random() < 0.6) options.push(pickOf(FRIEND_LEVEL).replace('{n}', String(level.level)).replace('{skill}', skillShort(level.stat!)));
    const doing = activityLine(bot);
    if (doing && Math.random() < 0.75) options.push(pickOf(FRIEND_DOING).replace('{doing}', doing.toLowerCase()));
    const said = options.find(line => line.length <= 80 && isClean(line));
    return said ?? FRIEND_OPENERS[Math.floor(Math.random() * FRIEND_OPENERS.length)];
}

function uniformTicks([min, max]: [number, number]): number {
    return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * port: a private message to a bot gets an answer, as an addressed public line does: a greeting to a greeting and what
 * it understands at the start of a private conversation, then what it understands, for 3 minutes after the last
 * message. The realism work: it notices the message (a moment), then thinks and types the answer at its own speed,
 * each part of a long one typed in turn; no "Yes Casey?" in front; a bot that is away answers nothing. Upstream dropped
 * every private message but "come here".
 */
function answerPrivate(human: Player, targetName: string, text: string): void {
    const bot = World.getPlayerByUsername(targetName);
    if (!bot || !bot.is_bot || isClientConnected(bot) || !BotManager.isActiveBot(bot.username)) return;
    const mes = text.trim();
    if (!mes || isAway(bot)) return;
    // (phase 7: the thread, for a model-written reply's situation)
    notePrivateLine(bot, human, mes, false);
    const memory = memoryOf(bot);
    const now = World.currentTick;
    const name = speakerName(human);
    const ongoing = memory.privateWith === name && now - (memory.privateAt ?? -Infinity) < PRIVATE_CONVERSATION_TICKS;
    memory.privateWith = name;
    memory.privateAt = now;
    const cleaned = cleanMessage(mes);
    let intent: IntentResult | null;
    let greeted = false;
    if (ongoing) {
        intent = processIntent(mes, memory, bot, human);
    } else {
        memory.topic = undefined;
        greeted = matchesAny(cleaned, chatResponses.greetings.patterns);
        const rest = greeted ? withoutPatterns(cleaned, chatResponses.greetings.patterns) : cleaned;
        intent = rest.length > 1 ? processIntent(mes, memory, bot, human) : greeted ? greetingBack(memory, bot) : null;
    }
    memory.emote = undefined; // (a private message comes with no emote: the human may be anywhere)
    const req: ReplyRequest = { bot, to: human, heard: mes, channel: 'private', via: 'private', greeted, intent };
    const reply = composeNoted(req);
    const model = modelWrites(req, reply);
    if (!reply.text && !model) return;
    // (it notices the message first: a few seconds; port/BotTiming)
    sayReply(req, reply, model, { to: human, kind: 'reply', pm: human }, 1 + reactionTicks(botPersona(bot), 'notice'));
    repliesSent++;
}

/**
 * The addressed bot's greeting and its answer as one line: "Hey Casey, I'm alright", "Yes Casey? I'm alright" (port:
 * upstream always put a comma after the greeting, "Yes Casey?, …"). Just the answer when the two together would trip
 * the word filter ("Yes Teddy? Kevin1991" has "dyk" in it, "Hey Casey, Gl!" reads as a web address).
 */
export function joinGreeting(greeting: string, response: string): string {
    const joined = `${greeting}${/[a-z0-9]$/i.test(greeting) ? ',' : ''} ${response}`;
    return isClean(joined) ? joined : response;
}

/** port: the game's word filter (port/BotSay) leaves the line as it is. */
function isClean(text: string): boolean {
    return WordEnc.filter(text) === text;
}

/** port: the emote that goes with the line being answered, if any (processIntent sets it), taken off the memory */
function takeEmote(memory: BotMemory): Emote | undefined {
    const emote = memory.emote;
    memory.emote = undefined;
    return emote;
}

// ── Intents ───────────────────────────────────────────────────────────────────

/** port: where the bot is (port/BotPlaces): "In Varrock atm", "Near Draynor, why?" */
function whereReply(memory: BotMemory, bot: Player): string {
    const place = placePhrase(bot.x, bot.z);
    if (!place) return pickSmart(NOWHERE_REPLIES, memory, bot);
    const said = pickSmart(WHERE_REPLIES, memory, bot).replace('{place}', place[0].toUpperCase() + place.slice(1));
    return isClean(said) ? said : place[0].toUpperCase() + place.slice(1);
}

/** port: what the bot is doing and where (port/BotActivity): "Cutting willows in Draynor, you?"; null with nothing to tell */
function doingReply(bot: Player): string | null {
    const line = activityLine(bot);
    if (!line) return null;
    const said = line + DOING_SUFFIXES[Math.floor(Math.random() * DOING_SUFFIXES.length)];
    return isClean(said) ? said : isClean(line) ? line : null;
}

/**
 * The reply to a line, or null when no intent matches it (port: upstream fell back to a filler). The realism work: the
 * intent comes with it (composeReply reads it), and `asker` (the human, or a bot) is who asked: directions start where
 * they stand, quests and money tips suit their levels (port/BotAnswers, checked before the greetings).
 */
function processIntent(message: string, memory: BotMemory, bot: Player, asker: Player | null = null): IntentResult | null {
    if (memory.context.length > 6) {
        memory.topic = undefined;
        memory.repetitions = 0;
    }
    const data = chatResponses;
    const msg = cleanMessage(message);

    const signals = {
        yes: isYes(msg),
        no: isNo(msg),
        laugh: isLaugh(msg)
    };

    let response: string | null = null;
    let id = '';
    // port (the variety work, round 2, the fixes: B1) a reply of upstream's (chat_responses.json): its words stay its own
    let upstream = false;

    // GOODBYE
    if (matchesAny(msg, ['bye', 'goodbye', 'see you', 'cya', 'later', 'see ya'])) {
        memory.state = 'idle';
        memory.lastSpeakerId = undefined;

        response = pickSmart(GOODBYE_REPLIES, memory, bot);
        if (chatDice.roll() < WAVE_BYE_CHANCE) memory.emote = 'wave';

        return { id: 'goodbye', text: applySignals(response, signals, memory, bot), upstream: true };
    }

    // port (the realism work): the new intents, answered from the bot's state (port/BotAnswers). Their slots can meet
    // in a way the word filter reads across ("14 f uk"): a line it would mask is drawn again, and not said if it stays so
    let state: StateAnswer | null = null;
    for (let i = 0; i < 4; i++) {
        state = stateAnswer({ bot, persona: botPersona(bot), asker, raw: message, msg, pick: pool => pickSmart([...pool], memory, bot) });
        if (!state || isClean(state.text)) break;
    }
    if (state && !isClean(state.text)) state = null;
    if (state) {
        memory.repetitions = (memory.repetitions ?? 0) + 1;
        return { id: state.id, text: state.text, follow: state.follow };
    }

    // Priority intents (questions)
    if (matchesAny(msg, ['how are you', 'how r u', 'you ok', 'you alright', 'u alright', 'are you well'])) {
        response = pickSmart(data.intents.find(i => i.id === 'how')?.replies ?? [], memory, bot);
        id = 'how';
        upstream = true;
    } else if ((msg === 'combat' || matchesAny(msg, COMBAT_LEVEL_QUESTIONS)) && !splitWords(msg).some(w => SKILL_WORDS.has(w))) {
        // port: from its own state ("cb?" alone is "combat": cleanMessage)
        response = pickSmart(COMBAT_LEVEL_REPLIES, memory, bot);
        id = 'combat';
    } else if (matchesAny(msg, WHERE_QUESTIONS)) {
        response = whereReply(memory, bot);
        id = 'whereami';
    } else if (matchesAny(msg, DOING_QUESTIONS)) {
        // port: what it does and where; upstream's fillers ("Just chilling, you?") when it has nothing to tell
        const own = doingReply(bot);
        response = own ?? pickSmart(data.intents.find(i => i.id === 'doing')?.replies ?? [], memory, bot);
        id = 'doing';
        upstream = own === null;
    } else if (matchesAny(msg, DANCE_REQUESTS)) {
        response = pickSmart(DANCE_REPLIES, memory, bot);
        memory.emote = 'dance';
        id = 'dance';
    }

    // Greetings
    else if (matchesAny(msg, data.greetings.patterns)) {
        response = pickSmart(data.greetings.replies, memory, bot);
        id = 'greeting';
        upstream = true;
    }

    // Help
    else if (matchesAny(msg, data.help.patterns)) {
        memory.topic = 'help';
        memory.repetitions = 0;
        response = pickSmart(data.help.replies, memory, bot);
        id = 'help';
        upstream = true;
    }

    // SMART INTENT MATCHING
    else {
        let bestIntent: IntentEntry | null = null;
        let bestScore = 0;

        const text = ` ${msg} `;

        for (const intent of data.intents) {
            let score = 0;

            for (const pattern of intent.patterns) {
                // port: the pattern cleaned as the line is, and as whole words (upstream: substrings, so "ty" in
                // "matty" was thanks)
                const p = cleanPattern(pattern);
                if (!p) continue;

                if (msg === p) {
                    score += 5;
                } else if (text.includes(` ${p} `)) {
                    score += 3;
                }
            }

            // bonus for multi-pattern intents
            if (score > 0 && intent.patterns.length > 1) {
                score += 1;
            }

            // weaker, safer topic memory boost
            if (memory.topic === intent.id && score > 0) {
                score += 1;
            }

            if (score > bestScore) {
                bestScore = score;
                bestIntent = intent;
            }
        }

        // confidence gate
        if (bestIntent && bestScore >= 3) {
            memory.topic = bestIntent.id;
            memory.repetitions = 0;

            response = pickSmart(bestIntent.replies, memory, bot);
            id = bestIntent.id;
            upstream = true;
            // port: a joke gets a laugh now and then (port/BotEmote)
            if (bestIntent.id === 'joke' && chatDice.roll() < LAUGH_CHANCE) memory.emote = 'laugh';
        }
    }

    // port: no fallback. Upstream answered a line it did not understand with a filler from data.fallback ("I don't
    // quite understand, could you rephrase?"), or with "You just said that lol" when memory.lastMessage (the raw,
    // sentence-cased line) equalled this cleaned one, which it never does. A bot now answers only what it understands.
    if (!response) return null;

    memory.repetitions = (memory.repetitions ?? 0) + 1;

    const text = applySignals(response, signals, memory, bot);
    return upstream ? { id, text, upstream } : { id, text };
}

/**
 * port: a line (or a pattern: both go through this, so "gz!" and "see that?" in chat_responses.json can match) as the
 * intents read it: lower case, 2004 shorthand spelled out, no punctuation. Upstream removed the word "bot" (so the
 * "are you a bot" intent could never fire), did not touch the patterns (the punctuated ones never matched) and knew
 * only u, r and w.
 */
function cleanMessage(msg: string): string {
    let text = msg
        .toLowerCase()
        // remove punctuation (an apostrophe joins: "what's" is "whats")
        .replace(/'/g, '')
        .replace(/[^\w\s:()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    for (const [short, long] of SHORTHAND) text = text.replace(short, long);
    return text.replace(/\s+/g, ' ').trim();
}

/** port: 2004 chat shorthand, spelled out (whole words) */
const SHORTHAND: [RegExp, string][] = [
    [/\bu\b/g, 'you'],
    [/\br\b/g, 'are'],
    [/\bw\b/g, 'with'],
    [/\bur\b/g, 'your'],
    [/\byr\b/g, 'your'],
    [/\blvl\b/g, 'level'],
    [/\blvls\b/g, 'levels'],
    [/\bcb\b/g, 'combat'],
    [/\b(thx|thnx|tx|ty)\b/g, 'thanks'],
    [/\b(wat|wut|wot)\b/g, 'what'],
    [/\b(pls|plz)\b/g, 'please'],
    [/\bppl\b/g, 'people'],
    [/\bidk\b/g, 'i dont know'],
    [/\bnvm\b/g, 'never mind'],
    [/\bwhats\b/g, 'what is'],
    [/\bwheres\b/g, 'where is'],
    [/\bhows\b/g, 'how is'],
    [/\b(gratz|grats|congrats)\b/g, 'gz'],
    [/\bim\b/g, 'i am']
];

/** port: the line without the bot's whole name (as isAddressingBot finds it) */
function withoutName(message: string, bot: Player): string {
    // port: and without the other ways it is called (nameVariants, its first name)
    let out = message;
    for (const rx of nameRegexes(bot)) out = out.replace(rx, '$1');
    return out.replace(/\s+/g, ' ').trim();
}

/** port (the realism work): each way the bot is called, as a pattern, made once per bot (bots hear each other now) */
const nameRegexCache = new WeakMap<Player, RegExp[]>();
function nameRegexes(bot: Player): RegExp[] {
    let list = nameRegexCache.get(bot);
    if (!list) {
        const first = firstNameOf(bot);
        list = [...nameVariants(bot), ...(first ? [first] : [])].map(name => {
            const words = name.split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            return new RegExp(`(^|[^a-z0-9])${words.join('[ _-]+')}(?=$|[^a-z0-9])`, 'gi');
        });
        nameRegexCache.set(bot, list);
    }
    return list;
}

/** port: the cleaned line without these patterns' words */
function withoutPatterns(cleaned: string, patterns: string[]): string {
    let text = ` ${cleaned} `;
    for (const p of patterns.map(cleanPattern)) if (p) text = text.split(` ${p} `).join(' ');
    return text.replace(/\s+/g, ' ').trim();
}

function pickSmart(replies: (Reply | string)[], memory: BotMemory, bot: Player): string {
    const normalized = replies.map(normalizeReply);

    // safer anti-repeat system (prevents empty pool bug)
    let pool = normalized;

    const antiRepeat = normalized.filter(r => !memory.lastReplies.includes(r.text));

    if (antiRepeat.length >= 2) {
        pool = antiRepeat;
    }

    const totalWeight = pool.reduce((sum, r) => sum + (r.weight ?? 1), 0);
    let rand = Math.random() * totalWeight;

    for (const r of pool) {
        rand -= r.weight ?? 1;

        if (rand <= 0) {
            memory.lastReplies.push(r.text);

            if (memory.lastReplies.length > 5) {
                memory.lastReplies.shift();
            }

            return formatReply(r, memory, bot);
        }
    }

    return formatReply(pool[0], memory, bot);
}

function normalizeReply(reply: Reply | string): Reply {
    if (typeof reply === 'string') {
        return { text: reply, weight: 1 };
    }
    return reply;
}

const STAT_TOKENS = ['attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'magic', 'cooking', 'woodcutting', 'fletching', 'fishing', 'firemaking', 'crafting', 'smithing', 'mining', 'herblore', 'agility', 'thieving', 'slayer', 'stat19', 'runecraft'];

/**
 * A reply's slots filled from the bot's state ({myname}, {total}, the skills, {combat}). port (the realism work): the
 * human's {name} is left for composeReply (which says it in about one reply in five), and no " :)", " :D" or " lol" is
 * added at random any more (one in five replies had one: composeReply adds the persona's own now and then).
 */
function formatReply(reply: Reply | string | undefined, _memory: BotMemory, bot: Player): string {
    if (!reply) return '';
    const normalized = normalizeReply(reply);
    let text = normalized.text || '';

    text = text.replace('{myname}', bot.displayName);
    // port: the total level as 274 shows it (skills 18 and 19 do not exist in 2004: upstream counted them, 2 high)
    text = text.replace('{total}', String(bot.baseLevels.reduce((sum, level, stat) => (stat === 18 || stat === 19 ? sum : sum + level), 0)));
    for (let stat = 0; stat < STAT_TOKENS.length; stat++) {
        text = text.replace(`{${STAT_TOKENS[stat]}}`, String(bot.baseLevels[stat]));
    }
    // port: and its combat level, as the game shows it
    text = text.replace('{combat}', String(bot.combatLevel));

    return text;
}

/**
 * port: a pattern as a whole word or phrase of the line (both cleaned: cleanMessage). Upstream matched substrings: "hi"
 * in "this", "ty" in "matty".
 */
function matchesAny(msg: string, patterns: string[]): boolean {
    const text = ` ${msg} `;
    return patterns.some(p => {
        const pattern = cleanPattern(p);
        return pattern.length > 0 && text.includes(` ${pattern} `);
    });
}

/** port (the realism work): a pattern cleaned once (the patterns are the code's and the data's: a few hundred) */
const cleanPatterns = new Map<string, string>();
function cleanPattern(pattern: string): string {
    let cleaned = cleanPatterns.get(pattern);
    if (cleaned === undefined) {
        cleaned = cleanMessage(pattern);
        if (cleanPatterns.size < 4096) cleanPatterns.set(pattern, cleaned);
    }
    return cleaned;
}

function applySignals(base: string, signals: { yes: boolean; no: boolean; laugh: boolean }, memory: BotMemory, bot: Player): string {
    // port: a reaction only where the word filter leaves the line alone (":D I can try help" spells "dic", "Nice, Gl!"
    // reads as a web address)
    const react = (line: string): string => (isClean(line) ? line : base);

    // small chance to react
    // port (the realism work): no laugh before a line that already laughs ("Haha :D Lol lol")
    if (signals.laugh && !/\b(lol|lmao|haha|rofl)\b|:d/i.test(base) && Math.random() < 0.4) {
        if (Math.random() < 0.5) memory.emote ??= 'laugh'; // port: and laughs now and then (port/BotEmote)
        return react(pickSmart(LAUGH_PREFIXES, memory, bot) + ' ' + base);
    }

    if (signals.yes && Math.random() < 0.3) {
        return react(pickSmart(YES_PREFIXES, memory, bot) + ', ' + base);
    }

    if (signals.no && Math.random() < 0.3) {
        return react(pickSmart(NO_PREFIXES, memory, bot) + ', ' + base);
    }

    return base;
}

function splitWords(msg: string): string[] {
    return msg.split(/\s+/);
}

function isYes(msg: string): boolean {
    return splitWords(msg).some(w => ['yes', 'yeah', 'yep', 'y'].includes(w));
}

function isNo(msg: string): boolean {
    return splitWords(msg).some(w => ['no', 'nah', 'nope', 'n'].includes(w));
}

function isLaugh(msg: string): boolean {
    // port: whole words (upstream: substrings, so "lollipop" and "xdragon" laughed)
    return splitWords(msg).some(w => ['lol', 'haha', 'hahaha', 'lmao', 'rofl', ':d', 'xd', 'x[)'].includes(w));
}

// ── Marketplace ("buying logs", "selling coal") ─────────────────────────────

interface MarketRequest {
    mode: 'buy' | 'sell';
    /** the item's name as itemKey gives it */
    item: string;
    /** the item as the player wrote it ("yew logs", "lobs") */
    text: string;
}

/** a market request a vendor answered ('vendor'), one no vendor has ('none'), or no market request at all (null) */
type MarketOutcome = 'vendor' | 'none' | null;

/**
 * A public market request: one matching vendor bot answers it. port (the realism work: an
 * in-character marketplace): in character, a private message with its price and where it stands ("i got lobs 160 ea,
 * at varrock west bank"), or its line when it is near the human; upstream's game messages ("No vendor is currently
 * available for X.", "Marketplace: <vendor> matched <item>; location marked.") and its hint arrow across the map are
 * gone (a mod feature, not 2004). The line goes on to the bots' chat either way (BotChat.onPublicMessage).
 */
function handleVendorMarketplaceMessage(human: Player, name: string, mes: string): MarketOutcome {
    const tradeRequest = getRequestedTradeText(mes);
    if (!tradeRequest) {
        return null;
    }

    // Marketplace lookup is global and deterministic. Pick one matching vendor.
    for (const bot of BotManager.activeBots()) {
        if (bot.uid === -1 || isClientConnected(bot) || !bot.is_bot) {
            continue;
        }

        if (tryVendorAnswer(human, name, bot, tradeRequest)) {
            return 'vendor';
        }
    }

    return 'none';
}

function tryVendorAnswer(human: Player, name: string, bot: Player, request: MarketRequest): boolean {
    if (bot.botPlanner !== 'extras_vendor') {
        return false;
    }

    if (!isClientConnected(human) || isAway(bot)) {
        return false;
    }

    // port: the item's whole name (upstream also matched either name inside the other: "a" found "Dragon dagger")
    const activeStockMatches = bot.botVendorStockItemId !== -1 && stockAnswers(itemKey(bot.botVendorStockName), request.item) && offeredHere(bot.botVendorStockItemId);
    const inv = bot.getInventory(InvType.INV);
    const match = activeStockMatches ? { id: bot.botVendorStockItemId, name: bot.botVendorStockName, noted: bot.botVendorStockNoted } : inv ? findMatchingVendorItem(inv, request.item) : null;
    if (!match) {
        return false;
    }

    if (request.mode === 'sell' && !match.noted) {
        return false;
    }

    const price = vendorPrice(bot, match.id, match.noted, request.mode);
    if (price <= 0) {
        return false;
    }

    // asked again within 30 s: it answered already (port: upstream sent a game message and the arrow again)
    const now = World.currentTick;
    const cooldownKey = `${name}:${request.mode}:${match.id}`;
    if ((bot.botVendorPmCooldowns[cooldownKey] ?? 0) > now) {
        return true;
    }
    bot.botVendorPmCooldowns[cooldownKey] = now + VENDOR_COOLDOWN_TICKS;

    // port (the realism work): its answer in character, rules (a trade line: phase 7's model keeps it as it is). A rare
    // is one (phase 4: VendorTask sells it singly): its price without "ea", and not "some"
    const single = request.mode === 'buy' && isRare(match.id);
    const fill = (template: string): string => (single ? template.replace('{price} ea', '{price}') : template).replace('{item}', request.text).replace('{price}', formatGp(price)).replace('{where}', vendorWhere(bot));
    const near = bot.level === human.level && chebyshev(bot, human) <= MARKET_NEAR;
    const pool = near ? (request.mode === 'buy' ? VENDOR_NEAR_SELL : VENDOR_NEAR_BUY) : request.mode === 'buy' ? VENDOR_PM_SELL : VENDOR_PM_BUY;
    // (within the 80 characters a private message holds; the client shows "From <name>:" already)
    const lines = pool.filter(t => !single || !t.includes('some')).map(fill).filter(l => l.length <= 80 && isClean(l));
    if (lines.length === 0) return false;
    const reply = composeReply({ bot, to: human, heard: request.text, channel: near ? 'public' : 'private', via: 'market', greeted: false, intent: { id: 'market', text: pickOf(lines) } });
    if (!reply) return false;
    if (near) sayTyped(bot, reply, { to: human, kind: 'reply', count: true }, 1);
    else sayTyped(bot, reply, { to: human, kind: 'reply', pm: human }, 1 + reactionTicks(botPersona(bot), 'notice'));
    return true;
}

/** port (the realism work): what a vendor asks for its stock item, or pays for one (port/BotPrices, as VendorTask prices it) */
function vendorPrice(bot: Player, tradeId: number, noted: boolean, mode: 'buy' | 'sell'): number {
    const obj = ObjType.get(tradeId);
    const base = obj.certtemplate !== -1 && obj.certlink !== -1 ? obj.certlink : tradeId;
    const listed = vendorStock().find(s => s.itemId === base);
    const category = categoryOf(base, listed?.rare === true, listed?.market === true);
    const sell = sellPrice(base, bot.username, category, listed?.priceEach ?? 0);
    // (variety round 1, S8: the vendor's ask now, its price drifted down a little while unsold: "glory 95k"; what it pays
    // stays its stocking's)
    if (mode === 'buy') return vendorAskOf(bot, base) ?? sell;
    return noted ? buyPrice(base, sell, category) : 0;
}

/** port (the realism work): where a vendor stands, as players named it ("varrock west bank"; port/BotTradeSpots) */
const BANK_SAY: Record<string, string> = {
    varrock_west: 'varrock west bank', varrock_east: 'varrock east bank', falador_west: 'fally west bank', falador_east: 'fally east bank',
    draynor: 'draynor bank', edgeville: 'edge bank', al_kharid: 'al kharid bank', catherby: 'catherby bank', seers: 'seers bank',
    ardougne_south: 'ardy south bank', ardougne_north: 'ardy north bank'
};
function vendorWhere(bot: Player): string {
    const bank = stallOf(bot)?.bank.key;
    if (bank && BANK_SAY[bank]) return BANK_SAY[bank];
    return (placePhrase(bot.x, bot.z) ?? 'varrock west bank').toLowerCase();
}

/** What may stand before the item's name: a count, "noted", an article ("wtb 100 noted coal"). */
const MARKET_QUANTITY = /^(?:\d+[km]?x?|x\d+|noted|some|any|a|an|the|my|your|ur|all|of)$/;
/** Where the item's name ends: a price, or the rest of the advert ("wts lobsters 150 ea pm me"). */
const MARKET_ITEM_END = /^(?:\d+(?:k|m|b|gp|kgp|mgp)?|k|m|gp|ea|each|pls|plz|please|pm|trade|paying|for|at|cheap|fast|now|or|and|with)$/;

/**
 * port: a line is a market request only when it clearly is one: it starts with buying, selling, wtb or wts followed by
 * an item's name, or with buy or sell followed by nothing but an item's name (a count before it, a price or "pls"
 * after it). The name is a real object's, whole, singular or plural. Upstream took "need", "lf", "looking for",
 * "buy" or "sell" anywhere in the line followed by any words ("I need help" asked the vendors for "help") and
 * matched names by substring. The realism work: also "anyone selling X" (a buyer) and "anyone buying X" (a seller),
 * and 2004's item slang ("lobs", "ess", "nats", "addy", "mith", "scim", "d long": port/BotAnswers.expandSlang); since
 * phase 4 the vendors' own nicknames for their stock ("glory", "str pots", "cowhides": marketItem).
 */
function getRequestedTradeText(message: string): MarketRequest | null {
    let words = message.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/);
    // "anyone selling lobs" asks to buy, "any1 buying coal" to sell
    if (/^(anyone|any1|anybody|any)$/.test(words[0]) && /^(selling|buying)$/.test(words[1] ?? '')) words = [words[1] === 'selling' ? 'buying' : 'selling', ...words.slice(2)];
    const verb = words[0];
    const mode = verb === 'buying' || verb === 'wtb' || verb === 'buy' ? 'buy' : verb === 'selling' || verb === 'wts' || verb === 'sell' ? 'sell' : null;
    if (!mode) {
        return null;
    }

    let start = 1;
    while (start < words.length && MARKET_QUANTITY.test(words[start])) start++;
    let end = start;
    while (end < words.length && !MARKET_ITEM_END.test(words[end])) end++;

    // "buy"/"sell": all of it is the name; "buying"/"wtb"…: the longest run of words from the start that is one
    // ("buying yew logs and maples", "selling lobsters cheap")
    const strict = verb === 'buy' || verb === 'sell';
    for (let n = end - start; n > 0; n--) {
        const typed = words.slice(start, start + n);
        const item = marketItem(typed);
        if (item !== null) {
            return { mode, item, text: typed.join(' ') };
        }
        if (strict) {
            break;
        }
    }

    return null;
}

/**
 * The item a request's words name, as itemKey gives its name, or null: a real object's name (slang spelled out), else
 * port (the realism work, phase 4): a vendor's nickname for it, the words its adverts use ("glory", "str pots",
 * "cowhides", "pray pots", "d spear(p)": VendorTask.itemByNickname), else a potion without its dose ("attack potions":
 * the (4), else the (3)).
 */
function marketItem(typed: readonly string[]): string | null {
    const item = itemKey(expandSlang(typed).join(' '));
    if (isItemName(item)) return item;
    // port (the review of phase 4): a rare without its colour ("anyone selling phat", "buying hween"): any a vendor holds
    if (COLOURLESS_RARES.has(item)) return item;
    const nick = itemByNickname(typed.join(' '));
    if (nick !== null) return itemKey(nick.name);
    for (const dose of ['4', '3']) if (item.split(' ').length >= 2 && isItemName(`${item} ${dose}`)) return `${item} ${dose}`;
    return null;
}

/** port (the realism work, phase 4): the market request a line is, or null (for the tests: the parser alone) */
export function marketRequestOf(message: string): { mode: 'buy' | 'sell'; item: string; text: string } | null {
    return getRequestedTradeText(message);
}

/** port (the review of phase 4): rares players named without a colour (expandSlang: "phat", "hween") */
const COLOURLESS_RARES: ReadonlySet<string> = new Set(['partyhat', 'halloween mask']);

/** Does a vendor's stock (its name as itemKey gives it) answer the request? A colourless rare: any colour of it. */
function stockAnswers(stockKey: string, requested: string): boolean {
    return stockKey === requested || (COLOURLESS_RARES.has(requested) && stockKey.endsWith(` ${requested}`));
}

/** Every object's name as itemKey gives it (built at the first market request). */
let itemNames: Set<string> | null = null;

function isItemName(key: string): boolean {
    if (!itemNames) {
        itemNames = new Set();
        for (let id = 0; id < ObjType.count; id++) {
            const type = ObjType.get(id);
            if (type?.name && type.certtemplate === -1) {
                itemNames.add(itemKey(type.name));
            }
        }
        // port: and the names vendors go by where the game's is ambiguous ("grimy ranarr" for a Herb)
        for (const alias of VENDOR_ALIASES) itemNames.add(itemKey(alias));
    }
    return key.length > 0 && itemNames.has(key);
}

/** port: a free world's vendor neither sells nor buys a members item (the engine makes them untradeable there). */
function offeredHere(id: number): boolean {
    return isMembersWorld() || !ObjType.get(id)?.members;
}

function findMatchingVendorItem(inv: Inventory, requested: string): { id: number; name: string; noted: boolean } | null {
    for (let slot = 0; slot < inv.capacity; slot++) {
        const item = inv.get(slot);
        if (!item || item.id === 995 || !offeredHere(item.id)) {
            continue;
        }

        const type = ObjType.get(item.id);
        const itemName = type?.name ?? type?.debugname ?? '';
        if (!itemName) {
            continue;
        }

        if (stockAnswers(itemKey(itemName), requested)) {
            return { id: item.id, name: type?.name ?? type?.debugname ?? 'items', noted: type !== undefined && type.certtemplate !== -1 };
        }
    }

    return null;
}

/** A private message from a bot to a human (the game's encoder filters it like any private message). */
function privateMessage(bot: Player, human: Player, text: string): void {
    const pmId = (Environment.node.id << 24) + ((Math.random() * 0xff) << 16) + World.pmCount++;
    human.write(new MessagePrivate(toBase37(bot.username), pmId, Math.min(bot.staffModLevel, 2), text));
    notePrivateLine(bot, human, text, true);
}

// ── "come here" (private message to a bot) ───────────────────────────────────

function handleBotPrivateCommand(player: Player, targetName: string, message: string): boolean {
    if (message.trim().toLowerCase() !== 'come here') {
        return false;
    }

    const bot = World.getPlayerByUsername(targetName);
    if (!bot || !bot.is_bot || isClientConnected(bot) || !BotManager.isActiveBot(bot.username)) {
        return false;
    }

    if (bot.level !== player.level || Math.max(Math.abs(bot.x - player.x), Math.abs(bot.z - player.z)) > 50) {
        return false;
    }

    // port: only a PKer follows a player into the Wilderness; any other bot answers that it will not go when the
    // player, or the tile next to them it would run to, is in there (port/ComeHereTask)
    const intoWilderness = followsIntoWilderness(bot);
    // port: a walkable one (upstream could pick a wall or tree tile and stop short)
    const free = adjacentFreeTile(player, bot, intoWilderness ? undefined : outsideWilderness);
    const destination = free ? { x: free[0], z: free[1] } : getAdjacentTileNearestPlayer(player, bot);
    if (!intoWilderness && (!outsideWilderness(player.x, player.z) || !outsideWilderness(destination.x, destination.z))) {
        privateMessage(bot, player, pickWildernessRefusal());
        return true;
    }
    // port: a bot in a fight with a player stays in it. Upstream's "come here" stopped a PKer mid-fight (no attacks, no
    // eating, no specials, for 30 s at every message): a player who knew it killed it in a third of the time, for its coins
    if (inFight(bot)) {
        privateMessage(bot, player, COME_HERE_FIGHTING[Math.floor(Math.random() * COME_HERE_FIGHTING.length)]);
        return true;
    }
    // port: a bot in a trade stays in it (the run below would close the trade window: "Other player declined trade.")
    if (bot.botTradeTargetPid !== -1) {
        privateMessage(bot, player, COME_HERE_TRADING[Math.floor(Math.random() * COME_HERE_TRADING.length)]);
        return true;
    }
    // port (phase 5b): a bot with a part in a set piece stays at it (its duel screens, its party, its clan's line)
    if (eventRoleOf(bot) !== null) {
        privateMessage(bot, player, COME_HERE_BUSY[Math.floor(Math.random() * COME_HERE_BUSY.length)]);
        return true;
    }

    bot.botComeHereReturnX = bot.x;
    bot.botComeHereReturnZ = bot.z;
    bot.clearPendingAction();
    bot.clearWaypoints();
    bot.run = 1;
    bot.moveSpeed = MoveSpeed.RUN;
    runBotTo(bot, destination.x, destination.z);
    // port: and wait there, its own task paused (upstream's next task tick usually walked it back)
    BotManager.botFor(bot)?.setSubTask(new ComeHereTask(player, intoWilderness));
    return true;
}

/** port: is the bot in a fight with a player (attacking one, or attacked by one)? An NPC fight a bot leaves when called. */
/**
 * port (phase 3): in a fight, from the bot's own state only (O(1): inFight looks at every player for one attacking it):
 * it attacks a player, or the game's logout lock of a fight (a hit given or taken lately) is on. For the cliques' checks,
 * which ask it of every member every few ticks and of every follower every tick.
 */
export function inFightQuick(bot: Player): boolean {
    const op = bot.targetOp;
    if (bot.target instanceof Player && (op === ServerTriggerType.APPLAYER2 || op === ServerTriggerType.OPPLAYER2)) return true;
    return World.currentTick < bot.preventLogoutUntil;
}

export function inFight(bot: Player): boolean {
    const op = bot.targetOp;
    if (bot.target instanceof Player && (op === ServerTriggerType.APPLAYER2 || op === ServerTriggerType.OPPLAYER2)) return true;
    for (const p of World.playerLoop.all()) {
        if (p !== bot && p.target === bot && (p.targetOp === ServerTriggerType.APPLAYER2 || p.targetOp === ServerTriggerType.OPPLAYER2)) return true;
    }
    return false;
}

function runBotTo(bot: Player, x: number, z: number): void {
    // port: one search (upstream's botFindPath fallback cannot succeed where botWalkPath did not), within the bots'
    // per-tick budget: when it is spent the bot steps toward the player and ComeHereTask finds the route next tick
    const path = pathBudgetLeft() > 0 ? botWalkPath(bot.level, bot.x, bot.z, x, z) : new Uint32Array(0);

    if (path.length > 0) {
        bot.queueWaypoints(path);
        return;
    }

    bot.queueWaypoint(x, z);
}

function getAdjacentTileNearestPlayer(player: Player, bot: Player): { x: number; z: number } {
    const offsets = [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1]
    ];

    let best = { x: player.x + offsets[0][0], z: player.z + offsets[0][1] };
    let bestDistance = Number.MAX_SAFE_INTEGER;
    for (const [dx, dz] of offsets) {
        const x = player.x + dx;
        const z = player.z + dz;
        const distance = Math.max(Math.abs(bot.x - x), Math.abs(bot.z - z));
        if (distance < bestDistance) {
            best = { x, z };
            bestDistance = distance;
        }
    }

    return best;
}

function chebyshev(a: Player, b: Player): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}
