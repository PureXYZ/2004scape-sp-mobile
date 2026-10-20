#!/bin/sh
# Puts llama.cpp's prebuilt xcframework (release b11297, pinned by its sha256) in build/Vendor/llama.xcframework, which the
# app links and embeds for the bots' on-device chat model (ios/LostCity/LocalModel.swift; docs/ARCHITECTURE.md §7.1). Also
# makes build/Model/ (the model folder the app bundles as Model/; empty until ios/scripts/prepare-model.sh fills it: the app
# then builds and runs without a model, and Settings › Bot chat says it has none).
#
#   ios/scripts/fetch-llama.sh            # quick when it is there already (deploy.sh and app-test.mjs run it before building)
#   ios/scripts/fetch-llama.sh --force    # unzip again
#
# The zip is kept in the shared cache's downloads/ (scripts/lib/cache.sh: LC_CACHE_DIR, else ~/Library/Caches/2004scape),
# so a clean build/ does not download it again. Both folders are git-ignored (build/).
set -eu

cd "$(dirname "$0")/../.."
. scripts/lib/cache.sh
TAG=b11297
ZIP="llama-$TAG-xcframework.zip"
SHA256=9ddc157ee28d9b40c477bfe8e5e30599f67c25589f5061b94628f52b981687ab
URL="https://github.com/ggml-org/llama.cpp/releases/download/$TAG/$ZIP"
CACHE="$CACHE_DIR/downloads"
VENDOR=build/Vendor
STAMP="$VENDOR/llama.xcframework/.lostcity-$TAG"

mkdir -p build/Model

if [ "${1:-}" != "--force" ] && [ -f "$STAMP" ]; then
    exit 0
fi

mkdir -p "$CACHE"
if [ ! -f "$CACHE/$ZIP" ] || [ "$(sha "$CACHE/$ZIP")" != "$SHA256" ]; then
    echo "fetch-llama: downloading $URL"
    curl -fL --retry 3 -o "$CACHE/$ZIP.part" "$URL"
    mv "$CACHE/$ZIP.part" "$CACHE/$ZIP"
fi
GOT=$(sha "$CACHE/$ZIP")
if [ "$GOT" != "$SHA256" ]; then
    echo "fetch-llama: $CACHE/$ZIP has sha256 $GOT, expected $SHA256; not using it" >&2
    exit 1
fi

# The release zip holds build-apple/llama.xcframework (every Apple platform; Xcode embeds only the slice it builds for).
WORK=$(mktemp -d "${TMPDIR:-/tmp}/fetch-llama.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
unzip -q "$CACHE/$ZIP" -d "$WORK"
FOUND=$(find "$WORK" -maxdepth 3 -type d -name llama.xcframework | head -n 1)
if [ -z "$FOUND" ] || [ ! -f "$FOUND/Info.plist" ]; then
    echo "fetch-llama: no llama.xcframework in $ZIP" >&2
    exit 1
fi
mkdir -p "$VENDOR"
rm -rf "$VENDOR/llama.xcframework"
mv "$FOUND" "$VENDOR/llama.xcframework"
echo "$SHA256" > "$STAMP"
echo "fetch-llama: $VENDOR/llama.xcframework ($TAG; $(ls "$VENDOR/llama.xcframework" | grep -c -- '-') slices)"
