# The bots' 2004 chat model: how it was made

With Settings › Bot chat › On-device, a bot's reply to the player is worded by **Qwen3.5-0.8B with a 2004 LoRA**, run
on the phone by llama.cpp. The bots' rules still decide whether and when a bot replies and what it does, and their own
line is the fallback ([docs/BOTS.md](../../../../../docs/BOTS.md) §4.9). This folder holds the tools that made that
model: sampling training situations from the simulator, checking the written replies, assembling the training files,
training the LoRA, merging, converting and quantizing it, and evaluating it.

**The published model** is `bots-2004-q4km.gguf` on the GitHub release `model-v1`, pinned in
[models/bots-2004.json](../../../../../models/bots-2004.json): 529,297,472 bytes, sha256
`94ef25e02ce7badd1f1d8600bd191f1e8c172acebc59541ff3b54e504867b9c4`, chat template `qwen-chatml-hybrid` (one model
trained in both modes: the request's `think`, Settings › Bot chat › Think first, decides whether it writes a short note
before its reply). `ios/scripts/prepare-model.sh --download` and `android/scripts/prepare-model.sh --download` fetch
and bundle it. It is a derivative of Qwen3.5-0.8B (Apache-2.0).

**The training data is not published.** It is about 4,450 situations sampled from the bot simulator and about 3,800
replies written for them in a 2004 player's voice by Claude (Anthropic) agents working to a written brief, plus the
held-out and target sets and the evaluation outputs. The tools are here so the method can be read, checked and reused
with data of your own; every tool that reads the data takes its folder as an argument (`--data`, `--prompts`, or
`PHASE7_DATA` for `build-model.sh`) and refuses to run without it.

## The format

The model's prompt is `port/BotModelPrompt` **`renderLocal`**: the bot's persona and real state (levels, place,
activity, gear and pack, recent events), the chat near it, the player's line and the rules' own answer as a hint, in
Qwen's chat template with the empty think block (`chatml.mjs`, the same string native builds). renderLocal's text is
the training format: if it changes, the model must be retrained (below). The note mode prompts with the think block
open; the note reads "asks: <topic>. uses: <the facts it will state>. tone: <the persona's>." (`notes.mjs` derives the
notes from the written replies; nobody wrote them).

## The steps

`<data>` is the data folder; `$LM_CACHE` is the shared cache of `scripts/lib/cache.sh` (`LC_CACHE_DIR`, else
`~/Library/Caches/2004scape`), which also holds the training environment.

| Step | Tool | Out |
|---|---|---|
| 1. The player's lines | `human-lines.mjs [--check]`: 1,884 lines a 2004 player could type, by category (state, small talk, odd, insults, "r u a bot", help, gear, slang, members) | `test/data/model-human-lines.json` (committed: humanlike's `--probe-lines` reads it) |
| 2. Sample situations | `sample.mjs --out=<raw>`: humanlike runs with a probing human and `--model-capture`, over members and free worlds, 1× and 10× XP, 100 and 250 bots, aged worlds and new characters | `<raw>/*.jsonl` (captures) |
| 3. Select | `select.mjs --raw=<raw> --data=<data>`: rules-only intents dropped, deduplicated, the simulator's human renamed, stratified by how the line reached the bot, 300 held out, batches | `situations.jsonl`, `eval.jsonl`, `batches/` |
| 4. Write | Replies written to the brief; `check-replies.mjs <batch> <replies>` checks each (format, length, charset, the guard, effects, promises, levels, numbers: `checks.mjs`) | `replies/batch-NN.jsonl` |
| 5. Assemble | `assemble.mjs --data=<data>`: renderLocal of each situation plus its reply; 1 in 20 kept for the valid loss | `lm/train.jsonl`, `valid.jsonl`, `eval-prompts.jsonl`, `calibration.txt`, `manifest.json` |
| 6. Train | `train.py -c lora.yaml` (mlx-lm 0.32.0's `lora`, with `gdn_chunked.py` and the reply-only loss; `gdn_check.py` checks the chunks) | `<run>/adapters/` (after each epoch) |
| 7. Merge | `merge_lora.py`, then `merge_check.py` | `<run>/epoch<N>/merged/` (Hugging Face layout) |
| 8. Convert, quantize | llama.cpp b11297's `convert_hf_to_gguf.py --outtype f32 --no-mtp --model-name bots-2004 --metadata gguf-metadata.json` (the base model and the Apache-2.0 modification notice; `model-v1` was converted before this and names Qwen3.5-0.8B-Base, from the model card); `llama-imatrix` on `calibration.txt`; `llama-quantize Q4_K_M` | `<run>/epoch<N>/bots-2004-q4km.gguf` |
| 9. Choose an epoch | `build-model.sh valid` per epoch (the valid situations: the guard, the checks, the shape) and the valid loss | `valid-report.json` |
| 10. Publish | `build-model.sh publish`: the GGUF without the metadata keys that name local paths, its sha256 and `model.json` | `$LM_CACHE/models/` |
| 11. Evaluate | `build-model.sh eval-base eval` (`eval.mjs gen` through a llama-server with native's sampling, `eval.mjs score`); `review.mjs` (a blind judge sheet, a blind A/B test) | `<data>/eval/` |

`build-model.sh` runs steps 5-11 (`build-model.sh all`, or the steps by name: `assemble train merge convert quantize
valid publish eval-base eval`, and `target` for a target split). Its header lists the environment it reads: `PHASE7_DATA`
(required), `RUN`, `EPOCH`, `THINK=1` (the note variant), `BOTH=1` (with `THINK=1`: every example without and with its
note, one model in both modes), `VALID_PLAIN=1`, `LM_DIR`, `OUT_DIR`, `NOTES`, `LORA_CONFIG`, `PORT`, `NAME`. Run the
node tools from the repository root.

The published model came from two rounds. The first trained on 3,000 situations (2,850 train, 150 valid; 300 held
out). A blind test against the rules' lines and Claude-written lines showed its weak spots: it missed the question
asked, dropped its own counts and levels, and now and then ended in a garbled phrase. The second round sampled 1,150
more situations aimed at those (`human-lines.mjs --focus`, `sample.mjs --set=r2`, `select-r2.mjs select` then `finish`:
facts 40 %, follow-ups 20 %, the long tail 20 %, ordinary lines 20 %; 150 kept as a `target` split, never trained on),
and trained one model in both modes on 3,800 replies, each with and without its note (`lora-r2.yaml`, 2 epochs; the
second was published). `fact-use.mjs` measures how many lines state the facts a reference reply states.

### Training notes

- **The gated delta rule in chunks** (`gdn_chunked.py`). Qwen3.5 is a hybrid: 18 of its 24 layers are Gated DeltaNet
  (linear attention), and mlx-lm 0.32.0 trains them with a Python loop of one recurrent step per token. Over a
  ~300-token prompt that ran a 16 GB M2 out of memory at a batch of 4 and took ~10 s a step at a batch of 1. The
  chunked form (64 tokens a chunk; the WY/UT form, the triangular solve by exact block recursion) is the same
  function: `gdn_check.py` finds the outputs equal to 1e-7 and the gradients to 1e-5 on random inputs, and the model's
  loss equal to 4 decimals in float32 against both mlx-lm's loop and its inference kernel.
- **The reply-only loss** (`train.py`): the vocabulary head (248,320 × 1,024) runs on the reply's positions only (the
  prompt is masked anyway), a quarter less work. It also drops a position mlx-lm's `default_loss` counts past the end
  of each row (predicting padding after the final newline), so its numbers are mlx-lm's minus that term.
- **The merge** is done on the original checkpoint, not by `mlx_lm fuse`: mlx-lm's layout adds 1 to Qwen3.5's RMSNorm
  weights and moves the conv1d axes, which llama.cpp's converter would then do a second time. `merge_check.py` compares
  the merged model with the LoRA applied at run time (the same top token on every reply position, the loss within
  bf16 rounding).
- **The quantization** uses an importance matrix from the training text (`calibration.txt`: 400 chunks of 512 tokens,
  never the held-out set), as unsloth did for the base's own Q4_K_M.
- **Choosing the epoch** uses the valid set (and in the second round the target split) only, so the held-out 300 stay
  untouched until the final evaluation.
- On the M2 a training epoch took about 1 h 45 min with the GPU to itself (about 0.7 s a step at a batch of 1, a peak
  footprint of about 6.8 GB); an epoch's merge 1 minute, its conversion and quantization 4.

### Retraining

After a change to renderLocal's text, the replies or the settings: `build-model.sh assemble train`, then for each epoch
`EPOCH=n build-model.sh merge convert quantize valid` and pick by the valid loss (in `train.log`) and the valid report,
then `EPOCH=n build-model.sh publish eval-base eval`. A new model gets a new release tag and its size, sha256 and URL
in `models/bots-2004.json`; then `prepare-model.sh --download` in each app.

## Results

**The held-out 300**, first round (`eval.mjs score`; the base is unsloth's Q4_K_M of Qwen3.5-0.8B, prompted with
renderLocal and 6 examples; "rules" is what the game says without a model; "writers" is the shape of 300 training
replies):

| | base + 6 examples | **LoRA** | rules | writers |
|---|---|---|---|---|
| answered | 100 % | 100 % | 55 % | |
| the guard passes | 97.0 % | **99.7 %** | 97.0 % | |
| every check passes (of answered) | 81.7 % | **99.3 %** | 95.8 % | |
| fact contradictions | 12.7 % | **0.3 %** | 0 % | |
| characters a line, mean / median | 67.2 / 76 | **19.0 / 17** | 9.8 / 7 | 18.0 / 17 |
| words a line, mean | 14.5 | **4.4** | 2.3 | 4.0 |
| reply tokens, mean | 26.5 | **6.3** | | |

A blind judge pass on 100 of them (an agent scoring both models' lines, shuffled as X and Y): "sounds like a 2004
player" 1.31 of 5 for the base and **4.43** for the LoRA, "true to the facts" 61 % and **96 %**, the LoRA preferred 99
times in 100. Its weak lines were non sequiturs and a few slips; the base rambled, invented numbers, copied its
examples and wrote markup.

**The target 150**, second round (never trained on; the judge as above, three lines shuffled):

| | guard | facts recalled (of 52) | judge: 2004 (1-5) | true to the facts | answers the line |
|---|---|---|---|---|---|
| first-round model | 100 % | 31 | 3.80 | 94.0 % | 78.0 % |
| published model, plain | 99.3 % | **39** | 3.98 | 97.3 % | 85.3 % |
| published model, with the note | 100 % | 36 | **4.15** | 97.3 % | **88.0 %** |

On the held-out 300 the published model passes the guard on 100 % of its plain replies (99.7 % of all checks) and
99.3 % with the note. In a second blind A/B test by a person, the new model and the first were close (4 wins, 3
losses, 7 both fine), and Think first on against off made little difference (0 to 1, 12 both fine).

**Speed.** On the M2 (llama.cpp b11297, Metal) a reply takes about 250 ms in all through llama-server, about 53 ms
of it generation (260 ms with the note). On an iPhone 13 mini with 500 bots and a reply every 5 s with the note, a
reply took 1.09 s at the median (p95 1.46), the game held 50 fps, and the phone became thermally "serious" after
about 15 minutes; in play the model rests while the phone is hot, and chat comes far less often than that.

## Environment (pinned)

| What | Version, checksum |
|---|---|
| Base | `Qwen/Qwen3.5-0.8B` @ `2fc06364715b967f1860aea9cf38778875588b17` (the safetensors checked by sha256, the small files against the revision's git blob ids) |
| llama.cpp | b11297 (commit `ca2e2037b68ae7d821113d538110e6ce6903864c`): the macOS arm64 binaries (`llama-b11297-bin-macos-arm64.tar.gz`) and the tag's source tarball for `convert_hf_to_gguf.py` and gguf-py |
| Training | `$LM_CACHE/venv` (uv, CPython 3.12.11): mlx 0.32.3, mlx-lm 0.32.0, transformers 5.19.0 |
| Converting | `$LM_CACHE/venv-convert`: the converter's own pins (torch 2.11.0, transformers 4.57.6, numpy 2.2.6, sentencepiece, protobuf < 5) |
