// Stub of the real library's port/BotModel (the realism work, phase 7): what the glue (src/runtime/bots/page.ts) calls.
// The stub's bots never ask a model; `seen` records the page's messages (test hook).
import type { ChatModelMode, ModelModeMessage, ModelReplyMessage, ModelRequestMessage } from './BotModelTypes.js';

export const seen: { mode: ChatModelMode; replies: ModelReplyMessage[]; channel: boolean } = { mode: 'rules', replies: [], channel: false };

export function setModelMode(msg: Pick<ModelModeMessage, 'mode' | 'local' | 'online'>): void {
    seen.mode = msg.mode === 'local' || msg.mode === 'online' ? msg.mode : 'rules';
}

export function setModelChannel(fn: ((msg: ModelRequestMessage) => void) | null): void {
    seen.channel = fn !== null;
}

export function onModelReply(msg: ModelReplyMessage): void {
    seen.replies.push(msg);
}
