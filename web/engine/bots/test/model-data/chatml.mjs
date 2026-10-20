// The on-device prompt as native builds it (the realism work, phase 7: ios/LostCity/LocalModel.swift promptTokens, model.json
// template 'qwen-chatml-nothink'): Qwen's ChatML with the turns trimmed and thinking off (the template's empty think
// block), the same string Qwen3.5's own chat template renders for [system, user] with add_generation_prompt and the
// prefix it renders before a trained reply (assemble.mjs, train.py).
export function chatPrompt(system, user) {
    return `<|im_start|>system\n${system.trim()}<|im_end|>\n<|im_start|>user\n${user.trim()}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}

/** a whole training example as text (the prompt, the reply and its end), e.g. for llama-imatrix's calibration */
export function chatExample(system, user, reply) {
    return `${chatPrompt(system, user)}${reply.trim()}<|im_end|>\n`;
}

/**
 * (the note variant, model.json template 'qwen-chatml-think': ) the prompt opens the think block and
 * the model writes its short note in it, closes it and replies: Qwen3.5's template with enable_thinking, the string it
 * renders before a trained note.
 */
export function chatPromptThink(system, user) {
    return `<|im_start|>system\n${system.trim()}<|im_end|>\n<|im_start|>user\n${user.trim()}<|im_end|>\n<|im_start|>assistant\n<think>\n`;
}

/** the note variant's whole example: the note in the think block, then the reply */
export function chatExampleThink(system, user, note, reply) {
    return `${chatPromptThink(system, user)}${note.trim()}\n</think>\n\n${reply.trim()}<|im_end|>\n`;
}

/** the note variant's assistant turn as mlx-lm's chat data takes it (the template moves the think block into place) */
export function thinkContent(note, reply) {
    return `<think>\n${note.trim()}\n</think>\n\n${reply.trim()}`;
}

/** what the note variant generated, after its prompt: {note, reply} (the reply: the first line after the think block) */
export function splitThink(generated) {
    const text = String(generated ?? '');
    const end = text.indexOf('</think>');
    if (end < 0) return { note: text.trim(), reply: '' };
    return { note: text.slice(0, end).trim(), reply: (text.slice(end + '</think>'.length).replace(/^\s+/, '').split('\n')[0] ?? '').trim() };
}
