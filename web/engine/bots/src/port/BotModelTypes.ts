// port (the realism work, phase 7: the language model): the shapes a bot's model-written reply travels in, from the
// engine worker to the page and on to native, and back (docs/BOTS.md §4.1, docs/ARCHITECTURE.md §7), and the
// situation a reply is written for: the bot's real state, the lines it heard, the human's line and what the rules
// understood (the same object the training data keeps: the research).
//
//   engine -> page   {type:'bots-lm', id, mode, local, online, maxChars, timeoutMs}
//                        A reply for a bot to write. `local` is the prompt as the on-device model takes it (its system
//                        and user turns; native wraps them in the model's chat template), `online` as Claude takes it (a
//                        static style guide to cache, the bot's own context, its user turn). `mode` is the backend the
//                        player chose; native falls back from online to local, and from either to nothing (text null,
//                        with the error): the engine then says the rules' line, or nothing where the rules had none.
//   page -> engine   {type:'bots-lm-reply', id, text, source, error?, ms}
//                        The model's line as it came (the engine guards and styles it: port/BotModelGuard), or null and
//                        why ('unavailable', 'timeout', 'busy', 'refused', 'failed: ...'); ms: from the page's send.
//                    {type:'bots-lm-mode', mode, local, online}
//                        At start and whenever it changes: the player's choice (Settings › Bot chat) and what is there
//                        (an on-device model in the app; a Claude key saved). The engine asks only when the chosen
//                        backend, or the fallback, is there; with 'rules' (and in every sim) it never asks.
//
// Nothing here is in engine.js: the bots' bundle only (bots off stays vanilla). Model text never decides a game outcome:
// the rules decide whether a bot replies and when, and what it does; a model only writes the words of a reply already
// decided.
import type { AgeBand } from '#/engine/bot/port/BotPersona.js';

/** The player's choice: the rules alone, the model in the app, or Claude online (the player's own key). */
export type ChatModelMode = 'rules' | 'local' | 'online';
/** Who wrote a reply. */
export type ModelSource = 'local' | 'online';

/** How a human's line reached the bot (port/BotChat ReplyRequest's `via`). */
export type ReplyVia = 'named' | 'window' | 'conversation' | 'crowd' | 'second' | 'private' | 'market' | 'reaction';

/** The on-device model's turns (native applies the chat template: Qwen's ChatML with an empty think block). */
export interface LocalPrompt {
    system: string;
    user: string;
}

/** Claude's: `system` is the same for every bot and request (cached), `context` the bot's own facts (a second system block), `user` the chat. */
export interface OnlinePrompt {
    system: string;
    context: string;
    user: string;
}

export interface ModelRequestMessage {
    type: 'bots-lm';
    id: number;
    mode: Exclude<ChatModelMode, 'rules'>;
    local: LocalPrompt;
    online: OnlinePrompt;
    /** the longest line the engine will say (274's chat: 80) */
    maxChars: number;
    /** after this long native gives up and answers null ('timeout'): the engine's own deadline is a little longer */
    timeoutMs: number;
}

export interface ModelReplyMessage {
    type: 'bots-lm-reply';
    id: number;
    text: string | null;
    source: ModelSource | null;
    error?: string;
    ms: number;
}

export interface ModelModeMessage {
    type: 'bots-lm-mode';
    mode: ChatModelMode;
    /** an on-device model is in the app */
    local: boolean;
    /** a Claude key is saved */
    online: boolean;
}

/** One line of what the bot heard or said lately, oldest first. */
export interface SituationLine {
    /** 'you': the bot itself; 'them': the human it replies to; 'other': anyone else */
    who: 'you' | 'them' | 'other';
    /** the speaker's name as the chat shows it */
    name: string;
    text: string;
    /** seconds before the human's line */
    ago: number;
    /** a private message (between the bot and the human) */
    pm?: boolean;
}

/**
 * What a reply is written for: everything true about the bot that a prompt may use, and nothing else. Pure data (JSON):
 * the training data keeps it as it is, and the prompts are rendered from it (port/BotModelPrompt).
 */
export interface Situation {
    v: 1;
    bot: {
        /** its name as the chat shows it */
        name: string;
        age: number;
        ageBand: AgeBand;
        region: string;
        /** its planner (skiller, fighter, balanced, random, extras_pker, extras_edgeville_pker, extras_social, extras_vendor) */
        kind: string;
        newbie: boolean;
        voice: {
            /** -1 rude .. 1 friendly */
            friendliness: number;
            /** 0-1: answers and helps */
            helpfulness: number;
            /** non-trade lines an hour it aims at (most 1-10) */
            chattiness: number;
            /** 0-1: "u", "ur", "plz" */
            abbreviate: number;
            rude: boolean;
            /** carries upstream's meta and modern jokes (about 1 bot in 8): never in a model line all the same */
            meme: boolean;
        };
    };
    world: { members: boolean };
    facts: {
        combat: number;
        /** total level as 274's skill guide adds it */
        total: number;
        /** every skill's base level, by its short name (att def str hp range pray mage cook wc fletch fish fm craft smith mine herb agil thief rc) */
        levels: Record<string, number>;
        /** hitpoints now and at full */
        hp: [number, number];
        /** where it stands, in its own words ("at the draynor willows"), null where no place is named */
        place: string | null;
        /** what it is doing ("cutting willows"), null when nothing says */
        activity: string | null;
        /** what it wears (item names) */
        worn: string[];
        /** a few things it carries ("26 willow logs", "coins 12k") */
        carrying: string[];
        /** minutes online this session */
        online: number;
        /** the Wilderness level it stands in, 0 outside */
        wilderness: number;
        /** what happened to it lately, in plain words ("levelled woodcutting to 61, 2 min ago", "died, 8 min ago") */
        events: string[];
        /** friends of its own near it (its clique) */
        friendsNear: string[];
    };
    human: {
        name: string;
        combat: number;
        /** a few things the human wears (what the bot can see) */
        worn: string[];
        /** tiles away (Chebyshev), -1 for a private message from far */
        distance: number;
    };
    /** the last lines it heard or said near it and with the human, oldest first (at most HISTORY_MAX) */
    history: SituationLine[];
    heard: { text: string; channel: 'public' | 'private'; via: ReplyVia; greeted: boolean };
    /** what the rules understood in the line and their answer from the bot's state: the facts a reply keeps (its wording is not binding); null: nothing understood */
    hint: { intent: string; text: string } | null;
    /**
     * (phase 7, Track E: the guard's, never in a prompt) the bot's own lines of the last 10 minutes, public and private,
     * newest last: a model line that repeats one is refused (port/BotModelGuard). Absent in the foundation's captures.
     */
    said?: string[];
}

/**
 * Why a model's reply was not said (port/BotModel's fallbacks; the rules' line, or nothing, instead): no answer by the
 * engine's own deadline ('deadline': the rules' line at once); native's or the page's 'timeout' (the rules' line at its
 * typing time, as an error's: the review of the merge); an error answer ('refused', 'failed: ...'); the world's or native's queue full; the
 * guard refused the line; no channel to the page; a newer reply of the bot's; no backend (the mode switched to one that
 * is not there, or native's 'unavailable').
 */
export type ModelFallback = 'deadline' | 'timeout' | 'error' | 'busy' | 'guard' | 'channel' | 'superseded' | 'unavailable';
