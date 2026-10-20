#!/bin/sh
# Puts the bots' on-device chat model in android/build/model-assets/Model/, which the APK carries as assets/Model/
# (stored, never deflated, and 32-byte aligned so llama.cpp can mmap it straight from the APK: the plugin
# lostcity.model in android/build-logic; LocalModel reads Model/model.json through ModelAssets; docs/ARCHITECTURE.md
# §7.1). The Android twin of the iOS app's ios/scripts/prepare-model.sh: the same command line, the
# same model.json, the same pins, the same cache.
#
#   android/scripts/prepare-model.sh               # the trained 2004 model (models/bots-2004.json, the iPhone's) from the
#                                                  # shared cache's models/, when it is there; bundled as bots-2004.gguf
#   android/scripts/prepare-model.sh --download    # the same, downloaded into the cache first when it is not there
#                                                  # (checked against models/bots-2004.json's size and sha256)
#   android/scripts/prepare-model.sh <file.gguf>   # a model of our own (the 2004 LoRA, fused and quantized); bundled as
#                                                  # bots-2004.gguf. Its name and template come from a model.json beside it
#   android/scripts/prepare-model.sh --spike       # unsloth's Qwen3.5-0.8B Q4_K_M, as it is (no LoRA), downloaded once
#                                                  # (pinned revision, size and sha256) into the cache
#   android/scripts/prepare-model.sh --none        # no model: the app builds and runs, and Settings › Bot chat says it has none
#
# model.json: {name, file, bytes, sha256, ctx, template}. The template says whether the model writes a short note before
# its reply: 'qwen-chatml-nothink' never (the default), 'qwen-chatml-think' always, 'qwen-chatml-hybrid' when the request
# asks (Settings › Bot chat › Think first). The GGUF is copied as an APFS clone (or a reflink) where it can be (no second
# 0.5 GB on disk). The cache: scripts/lib/cache.sh (LC_CACHE_DIR, else ~/Library/Caches/2004scape on macOS or
# ~/.cache/2004scape). A build with -Plc.model=none leaves the model out whatever is here. Runs on macOS and Linux
# (sh, curl, node).
set -eu
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

# A model path is taken relative to where the script was run from: it is made absolute before the cd below, which moves
# to android/ (a file that is not there is reported further down, with the path as it was given).
case "${1:-}" in
"" | -*) ;;
*)
    if [ -f "$1" ]; then
        set -- "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
    fi
    ;;
esac

cd "$(dirname "$0")/.."
. ../scripts/lib/cache.sh
CACHE="$CACHE_DIR"
OUT=build/model-assets/Model
CTX=1024
TEMPLATE=qwen-chatml-nothink

SPIKE_REPO=unsloth/Qwen3.5-0.8B-GGUF
SPIKE_REV=6ab461498e2023f6e3c1baea90a8f0fe38ab64d0
SPIKE_FILE=Qwen3.5-0.8B-Q4_K_M.gguf
SPIKE_BYTES=532517120
SPIKE_SHA256=bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517

# The trained model: what models/bots-2004.json pins (its file name in the cache, size, sha256, release URL)
TRAINED=../models/bots-2004.json
TRAINED_FILE=$(json_field "$TRAINED" file)
TRAINED_BYTES=$(json_field "$TRAINED" bytes)
TRAINED_SHA256=$(json_field "$TRAINED" sha256)
TRAINED_URL=$(json_field "$TRAINED" url)

usage() {
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$SELF" >&2
    exit 2
}

# JSON string (the names here are plain ASCII; quotes and backslashes escaped anyway)
json_string() {
    printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

install_model() { # <source gguf> <bundled file name> <display name> <sha256>
    rm -rf "$OUT"
    mkdir -p "$OUT"
    clone_file "$1" "$OUT/$2"
    # (the apps ship this file, and llama-quantize writes the imatrix's absolute paths into the GGUF's metadata)
    if ! no_local_paths "$OUT" "$(cd .. && pwd)"; then
        rm -rf "$OUT"
        mkdir -p "$OUT" # (an empty model folder: the app builds without a model)
        echo "prepare-model: $1 names a local folder (its metadata, as llama-quantize writes it); not bundling it" >&2
        exit 1
    fi
    size=$(bytes "$OUT/$2")
    cat > "$OUT/model.json" <<EOF
{
    "name": $(json_string "$3"),
    "file": $(json_string "$2"),
    "bytes": $size,
    "sha256": "$4",
    "ctx": $CTX,
    "template": "$TEMPLATE"
}
EOF
    echo "prepare-model: $OUT/$2 ($(( size / 1048576 )) MB, $TEMPLATE): $3"
}

# install_own <gguf> <meta json>: bundled as bots-2004.gguf, its name and template from the meta file when there is one
install_own() {
    NAME="2004 chat model"
    if [ -f "$2" ]; then
        FOUND=$(json_field "$2" name)
        [ -n "$FOUND" ] && NAME="$FOUND"
        # (the note variant writes a note in the think block before its reply: model.json's template says so)
        FOUND=$(json_field "$2" template)
        [ -n "$FOUND" ] && TEMPLATE="$FOUND"
    fi
    # (the app treats a template it does not know as 'qwen-chatml-nothink': a typo would silently lose the note)
    case "$TEMPLATE" in
    qwen-chatml-nothink | qwen-chatml-think | qwen-chatml-hybrid) ;;
    *)
        echo "prepare-model: $2 has the template '$TEMPLATE'; the app knows qwen-chatml-nothink, qwen-chatml-think and qwen-chatml-hybrid" >&2
        exit 1
        ;;
    esac
    install_model "$1" bots-2004.gguf "$NAME" "${3:-$(sha "$1")}"
}

# trained_ok <file>: the cached trained model is there with models/bots-2004.json's size and sha256
trained_ok() {
    [ -f "$1" ] && [ "$(bytes "$1")" = "$TRAINED_BYTES" ] && [ "$(sha "$1")" = "$TRAINED_SHA256" ]
}

case "${1:-}" in
"" | --download)
    FILE="$CACHE/models/$TRAINED_FILE"
    if ! trained_ok "$FILE"; then
        if [ "${1:-}" != "--download" ]; then
            if [ -f "$FILE" ]; then
                echo "prepare-model: $FILE is not the model $TRAINED pins ($TRAINED_BYTES bytes, sha256 $TRAINED_SHA256); --download fetches it again" >&2
            else
                echo "prepare-model: no trained model in $CACHE/models/ ($TRAINED_FILE). --download fetches it; or give a .gguf, --spike or --none" >&2
            fi
            exit 1
        fi
        mkdir -p "$CACHE/models"
        echo "prepare-model: downloading $TRAINED_URL"
        if ! curl -fL --retry 3 -C - -o "$FILE.part" "$TRAINED_URL"; then
            echo "prepare-model: could not download $TRAINED_URL (is it published yet?). Put the model at $FILE, or give its path: android/scripts/prepare-model.sh <file.gguf>" >&2
            exit 1
        fi
        if ! trained_ok "$FILE.part"; then
            echo "prepare-model: $TRAINED_URL is not the model $TRAINED pins ($(bytes "$FILE.part") bytes, sha256 $(sha "$FILE.part")); not using it" >&2
            exit 1
        fi
        mv "$FILE.part" "$FILE"
    fi
    install_own "$FILE" "$TRAINED" "$TRAINED_SHA256"
    ;;
--spike)
    mkdir -p "$CACHE/downloads"
    FILE="$CACHE/downloads/$SPIKE_FILE"
    if [ ! -f "$FILE" ] || [ "$(bytes "$FILE")" != "$SPIKE_BYTES" ]; then
        URL="https://huggingface.co/$SPIKE_REPO/resolve/$SPIKE_REV/$SPIKE_FILE"
        echo "prepare-model: downloading $URL"
        curl -fL --retry 3 -C - -o "$FILE.part" "$URL"
        mv "$FILE.part" "$FILE"
    fi
    GOT=$(sha "$FILE")
    if [ "$GOT" != "$SPIKE_SHA256" ] || [ "$(bytes "$FILE")" != "$SPIKE_BYTES" ]; then
        echo "prepare-model: $FILE has sha256 $GOT ($(bytes "$FILE") bytes), expected $SPIKE_SHA256 ($SPIKE_BYTES); not using it" >&2
        exit 1
    fi
    install_model "$FILE" "$SPIKE_FILE" "Qwen3.5 0.8B (no 2004 training)" "$SPIKE_SHA256"
    ;;
--none)
    rm -rf "$OUT"
    mkdir -p "$OUT"
    echo "prepare-model: $OUT is empty (no model in the app)"
    ;;
-*)
    usage
    ;;
*)
    [ -f "$1" ] || { echo "prepare-model: no file $1" >&2; exit 1; }
    install_own "$1" "$(dirname "$1")/model.json"
    ;;
esac
