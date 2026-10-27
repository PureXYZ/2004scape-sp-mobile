// The bots' additions to the page protocol (docs/BOTS.md §4.1), in engine-bots.js only: src/entry-bots.ts wraps the
// entry's attach() with these, so that entry.ts (and engine.js) stay as they are.
//
//   engine -> page  {type:'bots', active:false, reason, detail}
//                       The bots asked for (init config.bots.count > 0) are off for this session; posted once, when the
//                       glue switches them off (state.ts disableBots). reason: 'store-unreadable' (bots.sav could not be
//                       read), 'store-corrupt' (bots.sav and its .bak are damaged), 'mismatch' (the bots do not fit this
//                       engine or its scripts), 'failed' (they failed while starting or running); detail: the logged
//                       reason. boot.js posts the same message with 'no-bundle' or 'load-failed' when it cannot load them.
//                   {type:'lifecycle-done', reqId, ok, error?, bots: {ok, error?}}
//                       While the bot store is in use: bots.ok = every bot save the engine made so far is in bots.sav
//                       (`ok` itself stays about the humans' saves); error = why the last write failed.
//   page -> engine  {type:'lifecycle', event:'resume'|'foreground'}
//                       A bot store that could not be written (it is kept in memory) is written first.
// The language model (the realism work, phase 7: '#/engine/bot/port/BotModelTypes' has the shapes):
//   engine -> page  {type:'bots-lm', id, mode, local, online, maxChars, timeoutMs}
//                       A bot's reply for the model to write (the page hands it to native: docs/ARCHITECTURE.md §7).
//   page -> engine  {type:'bots-lm-reply', id, text, source, error?, ms}
//                       The model's line (or null, and why); the bots guard it and say it, or the rules' line.
//                   {type:'bots-lm-mode', mode, local, online}
//                       The player's choice (Settings › Bot chat) and what is there; until it comes, the rules alone.
//                   {type:'bots-lm-notice', lines}
//                       Lines for the humans' chatboxes, as game messages (host.js lm.notice: the on-device model rests
//                       while the phone is low on memory, and is back).
import World from '#/engine/World.js';
import type Player from '#/engine/entity/Player.js';
import type { EngineMessage, Post } from '../host.js';
import { onModelReply, setModelChannel, setModelMode, setModelOutcomeLog } from '#/engine/bot/port/BotModel.js';
import type { ModelModeMessage, ModelReplyMessage } from '#/engine/bot/port/BotModelTypes.js';
import { botStore } from './store.js';

const isBot = (p: Player) => (p as Player & { is_bot?: boolean }).is_bot === true;

/** The 2004 chatbox shows about 80 characters of a game message; a longer one is cut. */
const NOTICE_MAX_CHARS = 80;

/** A notice's lines to every human in the world, as game messages (written with the next tick's output). */
function noticeToHumans(lines: unknown): void {
    if (!Array.isArray(lines)) return;
    const texts = lines.filter((l): l is string => typeof l === 'string' && l.length > 0).map(l => l.slice(0, NOTICE_MAX_CHARS));
    for (const p of World.playerLoop.all()) {
        if (isBot(p)) continue;
        for (const text of texts) p.messageGame(text);
    }
}

/** Why the bots asked for are off for this session, as the page hears it (host.js words it for the player). */
export type BotsOffReason = 'store-unreadable' | 'store-corrupt' | 'mismatch' | 'failed';

type BotsOffMessage = { type: 'bots'; active: false; reason: BotsOffReason; detail: string };
type BotsSaved = { ok: boolean; error?: string };

let post: Post | null = null;
let pending: BotsOffMessage | null = null;

function postNow(msg: BotsOffMessage): void {
    try {
        post!(msg as unknown as EngineMessage);
    } catch (e) {
        console.error('[bots] postMessage failed', e);
    }
}

/** The bots are off for this session (state.ts disableBots): tell the page, once it is attached. */
export function postBotsOff(reason: BotsOffReason, detail: string): void {
    const msg: BotsOffMessage = { type: 'bots', active: false, reason, detail };
    if (post) postNow(msg);
    else pending ??= msg; // switched off while the bundle evaluated (a missing hook target): after attach
}

/** entry-bots.ts, right after the entry's attach(): the page's `post`. */
export function attachPage(hostPost: Post): void {
    post = hostPost;
    // (phase 7: the bots' model requests go to the page)
    setModelChannel(msg => {
        try {
            hostPost(msg as unknown as EngineMessage);
        } catch (e) {
            console.error('[bots] posting a model request failed', e);
        }
    });
    // (2026-10-26: what happened to each reply the model was to write, in the app's log: said, or which fallback and why)
    setModelOutcomeLog(line => console.info(line));
    if (!pending) return;
    const msg = pending;
    pending = null;
    queueMicrotask(() => postNow(msg)); // after boot.js's 'booted', which it posts once attach() returned
}

/** Whether the bot store holds every bot save so far (null: no bot store this session). */
export function botsSaved(): BotsSaved | null {
    if (!botStore.loaded) return null;
    return botStore.dirty ? { ok: false, ...(botStore.lastError ? { error: botStore.lastError } : {}) } : { ok: true };
}

/** Every engine -> page message: lifecycle-done also says whether the bots were saved. */
export function onEngineMessage(msg: EngineMessage): EngineMessage {
    if (msg.type !== 'lifecycle-done') return msg;
    const saved = botsSaved();
    return saved ? ({ ...msg, bots: saved } as EngineMessage) : msg;
}

const RESUME = new Set(['resume', 'foreground']);

/**
 * Every page -> engine message, before the entry handles it. Never throws. True when it was the bots' own (the language
 * model's: phase 7): entry-bots.ts then keeps it from the entry, which knows no such message (it would warn of each).
 */
export function onPageMessage(msg: unknown): boolean {
    const m = msg as { type?: unknown; event?: unknown } | null;
    // (phase 7: the model's replies and the player's choice; the mode comes at start and on every change, and until it
    // comes the bots' chat is the rules' alone: port/BotModel asks nothing)
    if (m?.type === 'bots-lm-reply' || m?.type === 'bots-lm-mode') {
        try {
            if (m.type === 'bots-lm-reply') onModelReply(msg as ModelReplyMessage);
            else setModelMode(msg as ModelModeMessage);
        } catch (e) {
            console.error('[bots] a model message failed', e);
        }
        return true;
    }
    if (m?.type === 'bots-lm-notice') {
        try {
            noticeToHumans((msg as { lines?: unknown }).lines);
        } catch (e) {
            console.error('[bots] a model notice failed', e);
        }
        return true;
    }
    if (m?.type !== 'lifecycle' || !RESUME.has(m.event as string) || !botStore.dirty) return false;
    try {
        botStore.flush('resume');
    } catch (e) {
        console.error('[bots] writing the bot store on resume failed', e);
    }
    return false;
}
