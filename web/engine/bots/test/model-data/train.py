# Trains the 2004 LoRA (the realism work, phase 7, Track L): mlx-lm's own `lora` command with two changes on its
# training path, and the settings in lora.yaml (rank 16, alpha 32 = scale 2.0, dropout 0.05, lr 1e-4
# cosine, 3 epochs, the prompt masked, the valid loss each epoch). Any mlx-lm `lora` argument may follow, as for
# `python -m mlx_lm lora`.
#   - The gated delta rule in chunks (gdn_chunked.py): mlx-lm 0.32.0's one-step-per-token loop over Qwen3.5's 18
#     linear-attention layers ran the M2 out of memory at a batch of 4 and took ~10 s a step at a batch of 1.
#   - The loss on the reply only (`reply_loss`): the vocabulary head (248,320 x 1,024) runs on the reply's positions,
#     not the ~300 of the prompt that --mask-prompt throws away (the same loss, a quarter less work). It also leaves out
#     the one position mlx-lm's default_loss counts past the end of each sequence (predicting the padding after the
#     final newline), so its numbers are a little lower than default_loss's.
#
#   $LM_CACHE/venv/bin/python -I web/engine/bots/test/model-data/train.py -c web/engine/bots/test/model-data/lora.yaml \
#       --model <Qwen3.5-0.8B dir> --data <phase7-data/lm> --adapter-path <run>/adapters
import functools
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import mlx.core as mx  # noqa: E402
import mlx.nn as nn  # noqa: E402

import gdn_chunked  # noqa: E402


# the reply's targets a row may have (the replies are at most 80 characters: 18 tokens with <|im_end|> and the newline
# in the training data); a fixed width keeps the step's shapes static for mx.compile. THINK=1 (the note variant): the note in the think block is trained too (at most 160 characters, about 40 tokens) and the masked
# prompt ends at the open think block (the template's enable_thinking), so the width is 96.
THINK = os.environ.get('THINK') == '1'
REPLY_WIDTH = 96 if THINK else 32


def reply_loss(model, batch, lengths):
    """mlx-lm's masked cross-entropy, computed on the reply's positions only: (mean loss, token count). `lengths` is
    [offset, length] per row (the prompt's tokens, the row's tokens); position p predicts token p + 1, and the reply's
    targets are tokens offset .. length - 1 (the reply, <|im_end|> and the template's newline): the last REPLY_WIDTH
    positions of the row hold them."""
    lm = model.language_model if hasattr(model, 'language_model') else model
    inputs = batch[:, :-1]
    targets = batch[:, 1:]
    offsets = lengths[:, 0]
    ends = lengths[:, 1]
    hidden = lm.model(inputs)
    starts = mx.maximum(ends - 1 - REPLY_WIDTH, 0)
    index = starts[:, None] + mx.arange(REPLY_WIDTH)[None, :]  # [B, W]: the last W positions up to length - 2
    mask = mx.logical_and(index >= (offsets[:, None] - 1), index <= (ends[:, None] - 2))
    picked = mx.take_along_axis(hidden, index[..., None], axis=1)
    if getattr(lm.args, 'tie_word_embeddings', False):
        logits = lm.model.embed_tokens.as_linear(picked)
    else:
        logits = lm.lm_head(picked)
    ce = nn.losses.cross_entropy(logits, mx.take_along_axis(targets, index, axis=1)) * mask
    ntoks = mask.sum()
    return ce.astype(mx.float32).sum() / ntoks, ntoks


def _think_process(self, d):
    """mlx-lm's ChatDataset.process with the prompt masked up to the open think block (enable_thinking) for a row with a
    note: the note and the reply are the targets; a row without one (assemble --both) as mlx-lm masks it, the reply after
    the empty think block. The prompt's tokens must be the row's own first tokens (checked)."""
    messages = d[self.chat_key]
    tokens = self.tokenizer.apply_chat_template(messages, return_dict=False)
    if not self.mask_prompt:
        return (tokens, 0)
    noted = '<think>' in str(messages[-1].get('content', ''))
    prompt = self.tokenizer.apply_chat_template(messages[:-1], add_generation_prompt=True, enable_thinking=noted, return_dict=False)
    if list(tokens[: len(prompt)]) != list(prompt):
        raise ValueError('train.py THINK: the prompt with the open think block is not the start of the row')
    if len(tokens) - len(prompt) > REPLY_WIDTH:
        raise ValueError(f'train.py THINK: a note and reply of {len(tokens) - len(prompt)} tokens (more than {REPLY_WIDTH})')
    return (tokens, len(prompt))


def install() -> None:
    gdn_chunked.install()
    from mlx_lm import lora
    from mlx_lm.tuner import trainer

    if THINK:
        from mlx_lm.tuner import datasets

        datasets.ChatDataset.process = _think_process
    lora.train = functools.partial(trainer.train, loss=reply_loss)


if __name__ == '__main__':
    install()
    from mlx_lm import lora

    lora.main()
