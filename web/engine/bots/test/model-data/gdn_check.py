# Checks gdn_chunked.py against mlx-lm's own gated delta rule (the realism work, phase 7, Track L): random inputs
# (outputs and gradients, sequential ops vs chunks) and the base model's loss and logits on real training examples
# (mlx-lm's training path with and without the chunks, and its inference kernel). Exit 1 if any difference is too big.
#
#   $LM_CACHE/venv/bin/python -I web/engine/bots/test/model-data/gdn_check.py <model dir> <train.jsonl>
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import mlx.core as mx
import mlx.nn as nn
import numpy as np

import gdn_chunked
from mlx_lm.models.gated_delta import compute_g, gated_delta_ops, normalize_qk

failed = False


def report(name, a, b, tol):
    global failed
    a = np.array(a.astype(mx.float32))
    b = np.array(b.astype(mx.float32))
    diff = float(np.max(np.abs(a - b)))
    scale = float(np.max(np.abs(a))) or 1.0
    ok = diff <= tol * scale
    failed |= not ok
    print(f"{'ok  ' if ok else 'FAIL'} {name}: max |diff| {diff:.3g} (max |ref| {scale:.3g}, tol {tol:g} x)")


def random_inputs(B, T, H, D, seed):
    mx.random.seed(seed)
    q = mx.random.normal((B, T, H, D))
    k = mx.random.normal((B, T, H, D))
    q, k = normalize_qk(q, k, inv_scale=D**-0.5, eps=1e-6)
    v = mx.random.normal((B, T, H, D)) * 0.5
    a = mx.random.normal((B, T, H))
    b = mx.random.normal((B, T, H))
    A_log = mx.log(mx.random.uniform(low=0.5, high=8.0, shape=(H,)))
    dt_bias = mx.random.normal((H,)) * 0.5
    return q, k, v, a, b, A_log, dt_bias


def sequential(q, k, v, a, b, A_log, dt_bias):
    g = compute_g(A_log, a, dt_bias)
    y, _ = gated_delta_ops(q, k, v, g, mx.sigmoid(b), None, None)
    return y


def chunked(q, k, v, a, b, A_log, dt_bias):
    log_g = -mx.exp(A_log.astype(mx.float32)) * nn.softplus(a + dt_bias)
    return gdn_chunked.chunked_gated_delta(q, k, v, log_g, mx.sigmoid(b))


# 1. outputs, random inputs (a length that is not a multiple of the chunk)
for B, T, H, D, seed in [(2, 150, 16, 128, 1), (1, 64, 4, 32, 2), (3, 7, 2, 16, 3), (1, 300, 16, 128, 4)]:
    args = random_inputs(B, T, H, D, seed)
    report(f"outputs B{B} T{T} H{H} D{D}", sequential(*args), chunked(*args), 1e-4)

# 2. gradients, random inputs
B, T, H, D = 1, 90, 4, 32
args = random_inputs(B, T, H, D, 5)
weights = mx.random.normal((B, T, H, D), key=mx.random.key(9))
grad_seq = mx.grad(lambda *x: (sequential(*x) * weights).sum(), argnums=(0, 1, 2, 3, 4))(*args)
grad_chk = mx.grad(lambda *x: (chunked(*x) * weights).sum(), argnums=(0, 1, 2, 3, 4))(*args)
for name, gs, gc in zip(['q', 'k', 'v', 'a', 'b'], grad_seq, grad_chk):
    report(f"gradient wrt {name}", gs, gc, 1e-3)

# 3. the model: loss and logits on real examples, training path (ops) vs chunks vs the inference kernel; in float32
#    (the paths must agree to rounding) and in bfloat16 as trained (the paths differ by bf16 rounding: the chunks must be
#    no further from the kernel than mlx-lm's own ops path is)
if len(sys.argv) >= 3:
    from mlx.utils import tree_map_with_path
    from mlx_lm import load
    import mlx_lm.models.qwen3_5 as qwen3_5

    model, tokenizer = load(sys.argv[1])
    rows = [json.loads(l) for l in open(sys.argv[2])][:3]
    original = qwen3_5.gated_delta_update
    for dtype in (mx.float32, mx.bfloat16):
        model.update(tree_map_with_path(lambda path, x: x if path.endswith('A_log') else x.astype(dtype), model.parameters()))
        tag = 'f32' if dtype == mx.float32 else 'bf16'
        for i, row in enumerate(rows):
            tokens = mx.array(tokenizer.apply_chat_template(row['messages'], return_dict=False))[None]
            prompt = len(tokenizer.apply_chat_template(row['messages'][:-1], add_generation_prompt=True, return_dict=False))
            inputs, targets = tokens[:, :-1], tokens[:, 1:]

            def loss_and_logits():
                logits = model(inputs).astype(mx.float32)
                ce = nn.losses.cross_entropy(logits[:, prompt - 1 :], targets[:, prompt - 1 :])
                return ce.mean(), logits

            model.eval()
            qwen3_5.gated_delta_update = original
            loss_kernel, logits_kernel = loss_and_logits()
            model.train()
            loss_ops, logits_ops = loss_and_logits()
            gdn_chunked.install()
            loss_chk, logits_chk = loss_and_logits()
            qwen3_5.gated_delta_update = original
            mx.eval(loss_kernel, loss_ops, loss_chk)
            print(f"{tag} example {i}: {tokens.shape[1]} tokens, reply {tokens.shape[1] - prompt}; reply loss kernel {loss_kernel.item():.4f} ops {loss_ops.item():.4f} chunks {loss_chk.item():.4f}")
            if dtype == mx.float32:
                report(f"{tag} example {i} logits, ops vs chunks", logits_ops[0], logits_chk[0], 1e-4)
                report(f"{tag} example {i} logits, kernel vs chunks", logits_kernel[0], logits_chk[0], 1e-4)
                if abs(loss_ops.item() - loss_chk.item()) > 1e-3:
                    failed = True
                    print(f"FAIL {tag} example {i}: the reply loss differs by {abs(loss_ops.item() - loss_chk.item()):.4f}")
            else:
                ref = float(mx.abs(logits_kernel - logits_ops).max().item())
                got = float(mx.abs(logits_kernel - logits_chk).max().item())
                ok = got <= 2 * ref + 1e-3
                failed |= not ok
                print(f"{'ok  ' if ok else 'FAIL'} {tag} example {i}: max |logit diff| from the kernel: ops {ref:.3g}, chunks {got:.3g}")
        model.eval()

print('gdn_check:', 'FAILED' if failed else 'all ok')
sys.exit(1 if failed else 0)
