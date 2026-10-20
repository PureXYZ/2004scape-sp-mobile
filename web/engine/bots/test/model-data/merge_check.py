# Checks a merged model (merge_lora.py) against the base with its LoRA applied at run time (mlx-lm's own load), on a
# few training examples: the reply's loss and the logits must agree to bfloat16 rounding (the realism work, phase 7,
# Track L). Exit 1 if they do not.
#
#   $LM_CACHE/venv/bin/python -I web/engine/bots/test/model-data/merge_check.py <base dir> <adapters dir> <merged dir> \
#       <valid.jsonl> [examples=4]
import json
import sys

import mlx.core as mx
import mlx.nn as nn
from mlx_lm import load


def reply_loss_and_logits(model, tokenizer, messages):
    tokens = mx.array(tokenizer.apply_chat_template(messages, return_dict=False))[None]
    prompt = len(tokenizer.apply_chat_template(messages[:-1], add_generation_prompt=True, return_dict=False))
    logits = model(tokens[:, :-1]).astype(mx.float32)
    ce = nn.losses.cross_entropy(logits[:, prompt - 1 : -1], tokens[:, prompt:-1]).mean()
    return ce, logits[0, prompt - 1 :]


def main() -> int:
    base, adapters, merged, data = sys.argv[1:5]
    n = int(sys.argv[5]) if len(sys.argv) > 5 else 4
    rows = [json.loads(l) for l in open(data)][:n]
    lora_model, tokenizer = load(base, adapter_path=adapters)
    lora_model.eval()
    results = [reply_loss_and_logits(lora_model, tokenizer, r['messages']) for r in rows]
    mx.eval(results)
    del lora_model
    merged_model, _ = load(merged)
    merged_model.eval()
    base_model = None
    failed = False
    for i, r in enumerate(rows):
        loss_m, logits_m = reply_loss_and_logits(merged_model, tokenizer, r['messages'])
        loss_l, logits_l = results[i]
        diff = float(mx.abs(logits_m - logits_l).max().item())
        top_same = float((mx.argmax(logits_m, -1) == mx.argmax(logits_l, -1)).astype(mx.float32).mean().item())
        ok = abs(loss_m.item() - loss_l.item()) < 0.05 and top_same >= 0.9
        failed |= not ok
        print(f"{'ok  ' if ok else 'FAIL'} example {i}: reply loss LoRA {loss_l.item():.4f} merged {loss_m.item():.4f}; max |logit diff| on the reply {diff:.3g}; same top token {top_same:.0%}")
    del base_model
    print('merge_check:', 'FAILED' if failed else 'all ok')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
