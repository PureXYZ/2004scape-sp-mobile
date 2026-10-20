# The gated delta rule in chunks, for training Qwen3.5's linear-attention layers with mlx-lm (the realism work,
# phase 7, Track L: test/model-data/README.md).
#
# mlx-lm 0.32.0 trains Qwen3.5 through `gated_delta_ops`, a Python loop of one recurrent step per token. Over a ~300-token
# prompt that is ~5,400 steps through the 18 linear-attention layers, each keeping a 1 MB state per sequence for the
# backward pass: a batch of 4 ran the M2 out of memory (12.9 GB) and a batch of 1 took ~10 s a step. This is the same
# recurrence in the chunked form (the WY/UT form of "Gated Delta Networks", Yang et al. 2024, as transformers'
# `torch_chunk_gated_delta_rule` writes it): within a chunk of C tokens the updates are matrix products, and the state
# passes between chunks only. The unit lower-triangular solve is a block recursion (exact, no series), so the result is
# the sequential rule's up to float rounding: gdn_check.py compares them on random inputs and on the model's own logits.
#
# Only training uses it (`use_kernel=False`, no cache, no mask: mlx-lm's training path); inference keeps mlx-lm's Metal
# kernel and llama.cpp its own. `install()` swaps it into mlx_lm.models.qwen3_5.
from typing import Optional, Tuple

import mlx.core as mx
import mlx.nn as nn

CHUNK = 64


def _inv_unit_lower(m: mx.array) -> mx.array:
    """(I + L)^-1 for unit lower-triangular `m` [..., n, n], n a power of two: [[A, 0], [C, D]]^-1 =
    [[A^-1, 0], [-D^-1 C A^-1, D^-1]], A and D inverted together one level down."""
    n = m.shape[-1]
    if n == 1:
        return mx.ones_like(m)
    h = n // 2
    a = m[..., :h, :h]
    c = m[..., h:, :h]
    d = m[..., h:, h:]
    ad = _inv_unit_lower(mx.stack([a, d], axis=0))
    ai, di = ad[0], ad[1]
    x = -(di @ (c @ ai))
    z = mx.zeros_like(c)
    top = mx.concatenate([ai, z], axis=-1)
    bottom = mx.concatenate([x, di], axis=-1)
    return mx.concatenate([top, bottom], axis=-2)


def chunked_gated_delta(
    q: mx.array,
    k: mx.array,
    v: mx.array,
    log_g: mx.array,
    beta: mx.array,
    chunk: int = CHUNK,
) -> mx.array:
    """The gated delta rule from a zero state, chunk by chunk.

    q, k: [B, T, Hk, Dk] (normalized as mlx-lm's normalize_qk leaves them: k unit, q with the Dk**-0.5 readout scale);
    v: [B, T, Hv, Dv]; log_g: [B, T, Hv], the log of the decay; beta: [B, T, Hv]. Returns y [B, T, Hv, Dv] in q's dtype:
      S_t = g_t S_{t-1} (I - beta_t k_t k_t^T) + beta_t v_t k_t^T,  y_t = S_t q_t.
    """
    B, T, Hk, Dk = q.shape
    Hv, Dv = v.shape[-2:]
    dtype = q.dtype
    if (repeat := Hv // Hk) > 1:
        q = mx.repeat(q, repeat, -2)
        k = mx.repeat(k, repeat, -2)
    f32 = mx.float32
    pad = (-T) % chunk
    if pad:
        # (zeros after the end: no update, no decay; the outputs there are cut off)
        q = mx.pad(q, [(0, 0), (0, pad), (0, 0), (0, 0)])
        k = mx.pad(k, [(0, 0), (0, pad), (0, 0), (0, 0)])
        v = mx.pad(v, [(0, 0), (0, pad), (0, 0), (0, 0)])
        log_g = mx.pad(log_g, [(0, 0), (0, pad), (0, 0)])
        beta = mx.pad(beta, [(0, 0), (0, pad), (0, 0)])
    n = (T + pad) // chunk

    def chunks(x):  # [B, T', H, D] -> [B, H, n, C, D]
        return x.astype(f32).reshape(B, n, chunk, Hv, x.shape[-1]).transpose(0, 3, 1, 2, 4)

    qc, kc, vc = chunks(q), chunks(k), chunks(v)
    gc = log_g.astype(f32).reshape(B, n, chunk, Hv).transpose(0, 3, 1, 2)  # [B, H, n, C]
    bc = beta.astype(f32).reshape(B, n, chunk, Hv).transpose(0, 3, 1, 2)
    g = mx.cumsum(gc, axis=-1)  # the decay from the chunk's start, in logs

    rows = mx.arange(chunk)
    lower = rows[:, None] >= rows[None, :]  # incl. the diagonal
    strict = rows[:, None] > rows[None, :]
    diff = g[..., :, None] - g[..., None, :]
    decay = mx.where(lower, mx.exp(mx.where(lower, diff, 0.0)), 0.0)  # [B, H, n, C, C]: exp(g_i - g_j), i >= j

    kb = kc * bc[..., None]
    vb = vc * bc[..., None]
    lmat = mx.where(strict, (kb @ kc.swapaxes(-1, -2)) * decay, 0.0)
    tmat = _inv_unit_lower(lmat + mx.eye(chunk, dtype=f32))
    u = tmat @ vb  # [B, H, n, C, Dv]
    w = tmat @ (kb * mx.exp(g)[..., None])  # [B, H, n, C, Dk]

    state = mx.zeros((B, Hv, Dk, Dv), dtype=f32)
    outs = []
    for i in range(n):
        q_i, k_i = qc[:, :, i], kc[:, :, i]
        g_i = g[:, :, i]
        attn = (q_i @ k_i.swapaxes(-1, -2)) * decay[:, :, i]
        v_new = u[:, :, i] - w[:, :, i] @ state
        outs.append((q_i * mx.exp(g_i)[..., None]) @ state + attn @ v_new)
        g_last = g_i[..., -1]
        state = state * mx.exp(g_last)[..., None, None] + (k_i * mx.exp(g_last[..., None] - g_i)[..., None]).swapaxes(-1, -2) @ v_new
    y = mx.stack(outs, axis=2).reshape(B, Hv, n * chunk, Dv).transpose(0, 2, 1, 3)
    return y[:, :T].astype(dtype)


def gated_delta_update_chunked(
    q: mx.array,
    k: mx.array,
    v: mx.array,
    a: mx.array,
    b: mx.array,
    A_log: mx.array,
    dt_bias: mx.array,
    state: Optional[mx.array] = None,
    mask: Optional[mx.array] = None,
    *,
    use_kernel: bool = True,
    lower_bound: float | None = None,
    allow_neg_eigval: bool = False,
    _original=None,
) -> Tuple[mx.array, Optional[mx.array]]:
    """mlx-lm's gated_delta_update, with the chunked rule on its training path (no kernel, no state, no mask)."""
    if use_kernel or state is not None or mask is not None or lower_bound is not None:
        return _original(q, k, v, a, b, A_log, dt_bias, state, mask, use_kernel=use_kernel, lower_bound=lower_bound, allow_neg_eigval=allow_neg_eigval)
    beta = mx.sigmoid(b)
    if allow_neg_eigval:
        beta = beta * 2.0
    # log of mlx-lm's compute_g, exp(-exp(A_log) * softplus(a + dt_bias)), taken directly (no log of an underflow)
    log_g = -mx.exp(A_log.astype(mx.float32)) * nn.softplus(a + dt_bias)
    y = chunked_gated_delta(q, k, v, log_g, beta)
    return y, None


def install() -> None:
    """Swap the chunked rule into mlx-lm's Qwen3.5 (and Qwen3-Next, the same layer) for training."""
    import mlx_lm.models.qwen3_5 as qwen3_5

    original = qwen3_5.gated_delta_update
    if getattr(original, '_chunked', False):
        return

    def patched(*args, **kwargs):
        return gated_delta_update_chunked(*args, _original=original, **kwargs)

    patched._chunked = True
    qwen3_5.gated_delta_update = patched
