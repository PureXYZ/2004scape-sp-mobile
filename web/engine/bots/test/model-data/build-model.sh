#!/bin/sh
# The bots' 2004 chat model, end to end (the realism work, phase 7, Track L; README.md beside this file): the writers'
# replies rendered in the training format, a LoRA trained on Qwen3.5-0.8B with mlx-lm, merged into the base's own
# checkpoint, converted by llama.cpp b11297's converter and quantized to Q4_K_M with an importance matrix from the
# training text, checked on the valid set, published to the lm cache with its sha256 and model.json
# (ios/scripts/prepare-model.sh and android/scripts/prepare-model.sh bundle it), and evaluated on the 300 held-out situations.
#
#   web/engine/bots/test/model-data/build-model.sh <step>...
#     assemble train                     the training files; the LoRA (3 epochs, adapters after each)
#     merge convert quantize             the adapters of EPOCH (default: the last) as a Q4_K_M GGUF in $RUN/epoch<N>
#     valid                              that GGUF on the valid situations (150; the retrain's 200: llama-server, eval.mjs; choose an epoch)
#     publish                            that GGUF to $LM_CACHE/models (bots-2004-q4km.gguf, .sha256, model.json)
#     eval-base                          the base model prompted alone (renderLocal + 6 examples) on the 300 held out
#     eval                               that GGUF on the 300 held out (eval.mjs, beside the base, the rules and, when
#                                        $EVAL/gen-r1.jsonl is there, the first model's lines; with the note:
#                                        gen-lora-think.jsonl, scored beside gen-lora.jsonl when both are there)
#     target-old                         the first model (OLD_GGUF) on the target situations (a retrain's data dir):
#                                        $EVAL/target-gen-r1.jsonl (select-r2.mjs finish already wrote it)
#     target                             that GGUF on the target situations, scored beside the first model's lines,
#                                        the rules' and the writers' replies: $RUN/epoch<N>/target-gen.jsonl, target-report.json
#     all                                assemble train merge convert quantize valid publish eval-base eval
#
# Environment (defaults in brackets): LM_CACHE [the shared cache of scripts/lib/cache.sh: LC_CACHE_DIR, else
# ~/Library/Caches/2004scape; besides models/ and downloads/ it holds the training environment: venv/, venv-convert/,
# llama.cpp/, runs/], PHASE7_DATA [required: the phase 7 training data, which is not published], RUN [$LM_CACHE/runs/r16-e3], EPOCH [3], PORT [18093], NAME [the model's name], LORA_CONFIG [lora.yaml beside this
# file: its settings, with this data's counts written into $RUN/lora.yaml], OLD_GGUF [$LM_CACHE/runs/r16-e3/epoch2/
# bots-2004-q4km.gguf: the first published model], LM_DIR [$PHASE7_DATA/lm: the assembled files], OUT_DIR
# [$LM_CACHE/models: where publish puts the GGUF and its model.json], THINK [unset; 1: the note variant:
# assemble with NOTES (notes.mjs's {id, note}), the loss on the note and the reply, valid, eval and target with the
# note, model.json's template qwen-chatml-think], BOTH [unset; with THINK=1, 1: every example twice, without and with its
# note: one model in both modes, template qwen-chatml-hybrid, the app's switch picks; VALID_PLAIN=1 runs valid, eval and
# target without the note], NOTES [$PHASE7_DATA/notes.jsonl]. An epoch is as many steps as $LM_DIR/train.jsonl has rows
# (2,850; the retrain's 3,800; twice that with BOTH); EPOCHS [3] of them. Run from anywhere.
set -eu

cd "$(dirname "$0")/../../../../.."
HERE=web/engine/bots/test/model-data
. scripts/lib/cache.sh
LM_CACHE=${LM_CACHE:-$CACHE_DIR}
if [ -z "${PHASE7_DATA:-}" ]; then
    echo "build-model: set PHASE7_DATA to the phase 7 training data (the writers' replies and situations): it is not published with the repo" >&2
    exit 2
fi
# (eval.mjs and review.mjs read their held-out prompts from it when no --prompts is given)
export PHASE7_DATA
RUN=${RUN:-$LM_CACHE/runs/r16-e3}
EPOCH=${EPOCH:-3}
PORT=${PORT:-18093}
BASE=$LM_CACHE/downloads/Qwen3.5-0.8B-2fc0636
LLAMA=$LM_CACHE/llama.cpp/bin-b11297/llama-b11297
SRC=$LM_CACHE/llama.cpp/src-b11297
PY=$LM_CACHE/venv/bin/python
PYC=$LM_CACHE/venv-convert/bin/python
NAME=${NAME:-"2004 chat (Qwen3.5 0.8B + LoRA)"}
LORA_CONFIG=${LORA_CONFIG:-$HERE/lora.yaml}
OLD_GGUF=${OLD_GGUF:-$LM_CACHE/runs/r16-e3/epoch2/bots-2004-q4km.gguf}
WORK=$RUN/epoch$EPOCH
LM_DIR=${LM_DIR:-$PHASE7_DATA/lm}
OUT_DIR=${OUT_DIR:-$LM_CACHE/models}
OUT=$OUT_DIR/bots-2004-q4km.gguf
EVAL=${EVAL:-$PHASE7_DATA/eval}
THINK=${THINK:-}
BOTH=${BOTH:-}
NOTES=${NOTES:-$PHASE7_DATA/notes.jsonl}
if [ "$THINK" = 1 ] && [ "$BOTH" = 1 ]; then
    # (one model in both modes: the app's "Think first" switch picks per reply; valid and eval run the note mode, and
    # VALID_PLAIN=1 / an eval without THINK_ARG the other)
    TEMPLATE=qwen-chatml-hybrid
    THINK_ARG=--think
    BOTH_ARG=--both
elif [ "$THINK" = 1 ]; then
    TEMPLATE=qwen-chatml-think
    THINK_ARG=--think
    BOTH_ARG=
else
    TEMPLATE=qwen-chatml-nothink
    THINK_ARG=
    BOTH_ARG=
fi
[ "${VALID_PLAIN:-}" = 1 ] && THINK_ARG=

# the iterations of an epoch: the run's (written when it trained), else the assembled train count, else the first run's
epoch_iters() {
    if [ -f "$RUN/epoch-iters" ]; then cat "$RUN/epoch-iters"
    else train_rows; fi
}

# the training rows (an epoch's steps at a batch of 1): the assembled train.jsonl's lines (2,850 before it exists)
train_rows() {
    if [ -f "$LM_DIR/train.jsonl" ]; then wc -l < "$LM_DIR/train.jsonl" | tr -d ' '; else echo 2850; fi
}

adapters() {
    printf '%s/adapters/%07d_adapters.safetensors' "$RUN" $((EPOCH * $(epoch_iters)))
}

# llama-server on $PORT with a GGUF for the duration of a command: with_server <gguf> <command>...
with_server() {
    MODEL=$1
    shift
    mkdir -p "$WORK"
    "$LLAMA/llama-server" -m "$MODEL" -c 2048 -np 1 -ngl 99 -t 4 --host 127.0.0.1 --port "$PORT" --no-webui -cram 0 > "$WORK/server.log" 2>&1 &
    SERVER=$!
    trap 'kill $SERVER 2>/dev/null || true' EXIT
    i=0
    until curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; do
        i=$((i + 1))
        [ $i -lt 120 ] || { echo "build-model: llama-server did not start (see $WORK/server.log)" >&2; exit 1; }
        sleep 1
    done
    "$@"
    kill $SERVER 2>/dev/null || true
    wait $SERVER 2>/dev/null || true
    trap - EXIT
}

step() {
    case "$1" in
    assemble)
        if [ "$THINK" = 1 ]; then
            node "$HERE/notes.mjs" --data="$PHASE7_DATA" --out="$NOTES"
            node "$HERE/assemble.mjs" --data="$PHASE7_DATA" --out="$LM_DIR" --notes="$NOTES" $BOTH_ARG
        else
            node "$HERE/assemble.mjs" --data="$PHASE7_DATA" --out="$LM_DIR"
        fi
        ;;
    train)
        N=$(train_rows)
        mkdir -p "$RUN"
        # (LORA_CONFIG's settings with this data's counts: 3 epochs, the adapters and the valid loss after each, an
        # optimizer step every 4, the cosine after the warmup)
        echo "$N" > "$RUN/epoch-iters"
        ITERS=$((${EPOCHS:-3} * N))
        DECAY=$((ITERS / 4 - 51))
        sed -e "s/^iters: .*/iters: $ITERS/" -e "s/^steps_per_eval: .*/steps_per_eval: $N/" -e "s/^save_every: .*/save_every: $N/" \
            -e "s/^  arguments: .*/  arguments: [1.0e-4, $DECAY, 1.0e-6]/" "$LORA_CONFIG" > "$RUN/lora.yaml"
        THINK=$THINK "$PY" -I "$HERE/train.py" -c "$RUN/lora.yaml" --model "$BASE" --data "$LM_DIR" --adapter-path "$RUN/adapters" > "$RUN/train.log" 2>&1
        grep -a 'val' "$RUN/train.log" | tail -4
        ;;
    merge)
        mkdir -p "$WORK"
        rm -rf "$WORK/merged"
        "$PY" -I "$HERE/merge_lora.py" "$BASE" "$(adapters)" "$RUN/adapters/adapter_config.json" "$WORK/merged"
        # (the merged weights against the LoRA applied at run time by mlx-lm's own load, which wants a folder)
        mkdir -p "$WORK/check-adapters"
        cp "$RUN/adapters/adapter_config.json" "$WORK/check-adapters/adapter_config.json"
        cp "$(adapters)" "$WORK/check-adapters/adapters.safetensors"
        "$PY" -I "$HERE/merge_check.py" "$BASE" "$WORK/check-adapters" "$WORK/merged" "$LM_DIR/valid.jsonl" 6
        rm -rf "$WORK/check-adapters"
        ;;
    convert)
        # (--no-mtp: the text model without Qwen3.5's multi-token-prediction head, as unsloth's GGUF of the base;
        # --metadata: the base model and the Apache-2.0 modification notice, which the converter would otherwise take
        # from the model card, naming Qwen3.5-0.8B-Base)
        META="$(pwd)/$HERE/gguf-metadata.json"
        (cd "$WORK" && "$PYC" "$SRC/convert_hf_to_gguf.py" "$WORK/merged" --outfile "$WORK/bots-2004-f32.gguf" --outtype f32 --no-mtp --model-name "bots-2004" --metadata "$META" > "$WORK/convert.log" 2>&1)
        grep -E 'n_tensors|successfully' "$WORK/convert.log"
        ;;
    quantize)
        "$LLAMA/llama-imatrix" -m "$WORK/bots-2004-f32.gguf" -f "$LM_DIR/calibration.txt" --parse-special -c 512 --chunks 400 -ngl 99 -o "$WORK/imatrix.gguf" > "$WORK/imatrix.log" 2>&1
        "$LLAMA/llama-quantize" --imatrix "$WORK/imatrix.gguf" "$WORK/bots-2004-f32.gguf" "$WORK/bots-2004-q4km.gguf" Q4_K_M > "$WORK/quantize.log" 2>&1
        grep -E 'model size|quant size' "$WORK/quantize.log" | tail -2
        ;;
    valid)
        # (an if: under set -e, an assignment from a failed test would end the script)
        if [ -n "$THINK_ARG" ]; then SFX=-think; else SFX=; fi
        with_server "$WORK/bots-2004-q4km.gguf" node "$HERE/eval.mjs" gen --server="http://127.0.0.1:$PORT" --variant=lora $THINK_ARG --prompts="$LM_DIR/valid-prompts.jsonl" --out="$WORK/valid-gen$SFX.jsonl"
        node "$HERE/eval.mjs" score --prompts="$LM_DIR/valid-prompts.jsonl" --reference="$PHASE7_DATA/replies" --json="$WORK/valid-report$SFX.json" "epoch$EPOCH$SFX=$WORK/valid-gen$SFX.jsonl"
        ;;
    publish)
        mkdir -p "$OUT_DIR"
        # (without llama-quantize's two keys that name the imatrix and calibration files by their absolute paths: the
        # apps bundle this file and it is the release asset; the weights are unchanged)
        rm -f "$OUT"
        "$PYC" -B "$SRC/gguf-py/gguf/scripts/gguf_new_metadata.py" --force --remove-metadata quantize.imatrix.file --remove-metadata quantize.imatrix.dataset "$WORK/bots-2004-q4km.gguf" "$OUT" > "$WORK/publish.log" 2>&1
        SHA=$(shasum -a 256 "$OUT" | awk '{ print $1 }')
        BYTES=$(stat -f %z "$OUT")
        echo "$SHA  bots-2004-q4km.gguf" > "$OUT.sha256"
        cat > "$OUT_DIR/model.json" <<EOF
{
    "name": "$NAME",
    "file": "bots-2004-q4km.gguf",
    "bytes": $BYTES,
    "sha256": "$SHA",
    "ctx": 1024,
    "template": "$TEMPLATE",
    "base": "Qwen/Qwen3.5-0.8B@2fc06364715b967f1860aea9cf38778875588b17",
    "lora": {"rank": 16, "alpha": 32, "dropout": 0.05, "epochs": $EPOCH, "adapters": "$(basename "$(adapters)")", "run": "$(basename "$RUN")"},
    "quant": "Q4_K_M, imatrix from the training text (llama.cpp b11297)",
    "made": "web/engine/bots/test/model-data/build-model.sh"
}
EOF
        echo "build-model: $OUT ($BYTES bytes, sha256 $SHA)"
        ;;
    eval-base)
        # (the base model prompted alone, renderLocal and 6 examples: unsloth's Q4_K_M of the base, the phone spike's)
        mkdir -p "$EVAL"
        with_server "$LM_CACHE/downloads/Qwen3.5-0.8B-Q4_K_M.gguf" node "$HERE/eval.mjs" gen --server="http://127.0.0.1:$PORT" --variant=base --out="$EVAL/gen-base-fewshot.jsonl"
        ;;
    eval)
        mkdir -p "$EVAL"
        if [ -n "$THINK_ARG" ]; then SFX=-think; else SFX=; fi
        with_server "$WORK/bots-2004-q4km.gguf" node "$HERE/eval.mjs" gen --server="http://127.0.0.1:$PORT" --variant=lora $THINK_ARG --prompts="$LM_DIR/eval-prompts.jsonl" --out="$EVAL/gen-lora$SFX.jsonl"
        # (beside the base, the first model's lines when they are there, and both modes of a model in both)
        LINES="base=$EVAL/gen-base-fewshot.jsonl"
        [ ! -f "$EVAL/gen-r1.jsonl" ] || LINES="$LINES r1=$EVAL/gen-r1.jsonl"
        [ ! -f "$EVAL/gen-lora.jsonl" ] || LINES="$LINES lora=$EVAL/gen-lora.jsonl"
        [ ! -f "$EVAL/gen-lora-think.jsonl" ] || LINES="$LINES lora-think=$EVAL/gen-lora-think.jsonl"
        # shellcheck disable=SC2086
        node "$HERE/eval.mjs" score --prompts="$LM_DIR/eval-prompts.jsonl" --reference="$PHASE7_DATA/replies" --json="$EVAL/report.json" $LINES
        ;;
    target-old)
        mkdir -p "$EVAL"
        with_server "$OLD_GGUF" node "$HERE/eval.mjs" gen --server="http://127.0.0.1:$PORT" --variant=lora --prompts="$LM_DIR/target-prompts.jsonl" --out="$EVAL/target-gen-r1.jsonl"
        ;;
    target)
        [ -f "$LM_DIR/target-prompts.jsonl" ] || { echo "build-model: no $LM_DIR/target-prompts.jsonl (a retrain's data dir, assembled)" >&2; exit 1; }
        [ -f "$EVAL/target-gen-r1.jsonl" ] || step target-old
        with_server "$WORK/bots-2004-q4km.gguf" node "$HERE/eval.mjs" gen --server="http://127.0.0.1:$PORT" --variant=lora $THINK_ARG --prompts="$LM_DIR/target-prompts.jsonl" --out="$WORK/target-gen$( [ -n "$THINK_ARG" ] && echo -think ).jsonl"
        node "$HERE/eval.mjs" score --prompts="$LM_DIR/target-prompts.jsonl" --reference="$PHASE7_DATA/replies" --json="$WORK/target-report$( [ -n "$THINK_ARG" ] && echo -think ).json" "r1=$EVAL/target-gen-r1.jsonl" "epoch$EPOCH$( [ -n "$THINK_ARG" ] && echo -think )=$WORK/target-gen$( [ -n "$THINK_ARG" ] && echo -think ).jsonl"
        ;;
    all)
        for s in assemble train merge convert quantize valid publish eval-base eval; do step "$s"; done
        ;;
    *)
        sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//' >&2
        exit 2
        ;;
    esac
}

[ $# -gt 0 ] || { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
for s in "$@"; do step "$s"; done
