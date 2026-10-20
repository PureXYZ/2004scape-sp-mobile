#!/bin/sh
# Puts llama.cpp's prebuilt libraries of release b11297 (each pinned by its sha256) in android/build/vendor/llama-b11297,
# for the bots' on-device chat model (android/llm: the C++ core and its JNI layer; docs/ARCHITECTURE.md §7.1,
# docs/ANDROID.md §1 Bot chat). The Android twin of the iOS app's ios/scripts/fetch-llama.sh: the same
# release, the same cache, the upstream prebuilts rather than a build of our own.
#
#   android/scripts/fetch-llama.sh            # quick when it is there already (Gradle's :llm build and the harness run it)
#   android/scripts/fetch-llama.sh --force    # unpack again
#
# What it makes (all git-ignored, under android/build):
#   link/arm64-v8a/      libllama.so, libggml.so, libggml-base.so   (linked by CMake, packaged as IMPORTED libraries)
#   variants/arm64-v8a/  libggml-cpu-android_*.so (7)              (ggml's CPU backend per CPU generation: the C++ core
#                                                                   picks the best one at run time, packaged as jniLibs)
#   include/             llama.h, ggml*.h, gguf.h                   (from the source archive: the binaries ship none)
#   macos/               libllama / libggml* dylibs                 (the Mac JVM harness, android/test/native/lm-harness.mjs)
#   LICENSE
#
# The archives are kept in the shared cache's downloads/ (scripts/lib/cache.sh: LC_CACHE_DIR, else
# ~/Library/Caches/2004scape on macOS or ~/.cache/2004scape), shared with the iOS app (which keeps its framework's zip
# there too), so a clean build/ does not download them again.
set -eu

cd "$(dirname "$0")/.."
. ../scripts/lib/cache.sh
TAG=b11297
ANDROID_TGZ="llama-$TAG-bin-android-arm64.tar.gz"
ANDROID_SHA=6eb0266b2d814561aa59536e4a5ab59acfeb078a2033c2605614a2e823d6dd65
MAC_TGZ="llama-$TAG-bin-macos-arm64.tar.gz"
MAC_SHA=847818016ababf61f009ae003957d60d561aa545cfdd82f101f8e5703818885f
# (the source archive of the tag, as GitHub serves it; the name is the one the iOS work already cached it under)
SRC_TGZ="llama.cpp-$TAG-src.tar.gz"
SRC_SHA=d39f39b05fc36185cbe83a363dc542af414e12d3bc35a7adf6b6920140d76be6
RELEASE="https://github.com/ggml-org/llama.cpp/releases/download/$TAG"
SRC_URL="https://github.com/ggml-org/llama.cpp/archive/refs/tags/$TAG.tar.gz"
CACHE="$CACHE_DIR/downloads"
OUT="build/vendor/llama-$TAG"
STAMP="$OUT/.lostcity-$TAG"

if [ "${1:-}" != "--force" ] && [ -f "$STAMP" ]; then
    exit 0
fi

# fetch <file> <url> <sha256>: downloads it into the cache unless it is there with the right hash, then checks the hash
fetch() {
    if [ ! -f "$CACHE/$1" ] || [ "$(sha "$CACHE/$1")" != "$3" ]; then
        echo "fetch-llama: downloading $2"
        curl -fL --retry 3 -o "$CACHE/$1.part" "$2"
        mv "$CACHE/$1.part" "$CACHE/$1"
    fi
    got=$(sha "$CACHE/$1")
    if [ "$got" != "$3" ]; then
        echo "fetch-llama: $CACHE/$1 has sha256 $got, expected $3; not using it" >&2
        exit 1
    fi
}

mkdir -p "$CACHE"
fetch "$ANDROID_TGZ" "$RELEASE/$ANDROID_TGZ" "$ANDROID_SHA"
fetch "$MAC_TGZ" "$RELEASE/$MAC_TGZ" "$MAC_SHA"
fetch "$SRC_TGZ" "$SRC_URL" "$SRC_SHA"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/fetch-llama.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/android" "$WORK/macos" "$WORK/src"
tar -xzf "$CACHE/$ANDROID_TGZ" -C "$WORK/android"
tar -xzf "$CACHE/$MAC_TGZ" -C "$WORK/macos"
# (only the public headers of the source archive: llama.cpp-<tag>/include and ggml/include)
tar -xzf "$CACHE/$SRC_TGZ" -C "$WORK/src" "llama.cpp-$TAG/include" "llama.cpp-$TAG/ggml/include"

A="$WORK/android/llama-$TAG"
M="$WORK/macos/llama-$TAG"
S="$WORK/src/llama.cpp-$TAG"
for f in libllama.so libggml.so libggml-base.so LICENSE; do
    [ -f "$A/$f" ] || { echo "fetch-llama: no $f in $ANDROID_TGZ" >&2; exit 1; }
done
VARIANTS=$(cd "$A" && ls libggml-cpu-android_*.so)
if [ "$(echo "$VARIANTS" | wc -l | tr -d ' ')" != 7 ]; then
    echo "fetch-llama: expected 7 CPU variants in $ANDROID_TGZ, found: $VARIANTS" >&2
    exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT/link/arm64-v8a" "$OUT/variants/arm64-v8a" "$OUT/include" "$OUT/macos"
cp "$A/libllama.so" "$A/libggml.so" "$A/libggml-base.so" "$OUT/link/arm64-v8a/"
for v in $VARIANTS; do
    cp "$A/$v" "$OUT/variants/arm64-v8a/"
done
cp "$S"/include/*.h "$S"/ggml/include/*.h "$OUT/include/"
# (the dylibs with their version symlinks: libllama.dylib -> libllama.0.dylib -> libllama.0.5.0.dylib)
(cd "$M" && tar -cf - libllama*.dylib libggml*.dylib) | (cd "$OUT/macos" && tar -xf -)
rm -f "$OUT"/macos/libllama-*-impl.dylib "$OUT"/macos/libllama-common*.dylib
cp "$A/LICENSE" "$OUT/LICENSE"
printf '%s  %s\n%s  %s\n%s  %s\n' "$ANDROID_SHA" "$ANDROID_TGZ" "$MAC_SHA" "$MAC_TGZ" "$SRC_SHA" "$SRC_TGZ" > "$STAMP"
echo "fetch-llama: $OUT ($TAG: 3 libraries + $(echo "$VARIANTS" | wc -l | tr -d ' ') CPU variants for arm64-v8a, $(ls "$OUT/include" | wc -l | tr -d ' ') headers, the macOS dylibs)"
