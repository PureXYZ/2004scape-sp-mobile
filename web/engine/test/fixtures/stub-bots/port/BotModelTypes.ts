// Stub of the real library's port/BotModelTypes (the realism work, phase 7): the page <-> engine messages the glue
// (src/runtime/bots/page.ts) routes. The real one also has the Situation a reply is written for.
export type ChatModelMode = 'rules' | 'local' | 'online';
export type ModelSource = 'local' | 'online';

export interface ModelRequestMessage {
    type: 'bots-lm';
    id: number;
    mode: Exclude<ChatModelMode, 'rules'>;
    local: { system: string; user: string };
    online: { system: string; context: string; user: string };
    maxChars: number;
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
    local: boolean;
    online: boolean;
}
