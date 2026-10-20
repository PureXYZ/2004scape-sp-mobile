#!/bin/sh
# Builds a release of both apps into dist/<version>/ (VERSION says which), checks every file, and optionally uploads it
# to GitHub Releases as a draft. Runs on a Mac with Xcode, the Android SDK and Node (README.md, Build from source).
#
#   scripts/release.sh                 # build dist/<version>/ from a clean tree
#   scripts/release.sh --allow-dirty   # build although the tree has uncommitted changes (a test build: never upload it)
#   scripts/release.sh --upload        # upload dist/<version>/ as the DRAFT release v<version> (built first when it is
#                                      # missing or was built from another commit), plus the release model-v1 with the
#                                      # chat model when that does not exist yet (also a draft). Needs gh, logged in.
#   options: --skip-ios, --skip-android (a partial dist/: --upload refuses it), --repo <owner/name> (for --upload;
#            default PureXYZ/2004scape-sp-mobile)
#
# What it makes, in dist/<version>/ (git-ignored):
#   2004Scape-<version>-android.apk        the Android app with the bots' on-device chat model (signed with the release
#   2004Scape-<version>-android-lite.apk   key in ~/.android/2004scape) and without it
#   2004Scape-<version>-ios.ipa            the iPhone app, unsigned (AltStore, SideStore or Sideloadly sign it with the
#   2004Scape-<version>-ios-lite.ipa       player's own Apple Account), with and without the model
#   bots-2004-q4km.gguf                    the model on its own (models/bots-2004.json pins its size and sha256)
#   licenses.txt                           LICENSE and THIRD_PARTY_NOTICES.md with every licence text (the apps' own copy)
#   SHA256SUMS.txt, RELEASE_NOTES.md       checksums; the notes (CHANGELOG.md's section for the version, install steps)
#
# Steps: the web bundle (release, the engine's packer, the bots required), llama.cpp for both apps, the iOS app built
# twice (Release, generic/platform=iOS, CODE_SIGNING_ALLOWED=NO, stripped: lite with an empty build/Model, full after
# ios/scripts/prepare-model.sh), each zipped as Payload/LostCity.app; the Android release APK twice (-Plc.model=none, then
# with android/scripts/prepare-model.sh's model), each checked with apksigner (the release key's certificate, never the
# SDK's debug key); then the checksums and notes, and a scan of every file in dist/<version>/, unpacked (and the zips
# inside, but not the game cache's gzip entries or the .jag archives' bzip2 ones), for a builder's local paths and ids,
# which fails the release. The commits being released (their authors, committers and messages) are checked for the same
# ids: a warning when building, a refusal with --upload (publish the history with GitHub's noreply address instead).
# Afterwards build/Model and android/build/model-assets hold the full model (what deploy.sh then installs).
#
# Environment: ANDROID_HOME (default ~/Library/Android/sdk), JAVA_HOME (default Android Studio's JBR), LC_CACHE_DIR
# (scripts/lib/cache.sh: the cached chat model and llama.cpp), RELEASE_CERT_SHA256 (the release key's certificate
# SHA-256, colons or not; default the 2004Scape key's), PRIVATE_PATTERNS (extra extended regexps for the scan, one per
# line: a builder's own name or device id; every user.email in git's config and the signing team are added by
# themselves), TEAM (as for ios/scripts/deploy.sh: only added to the scan, the release builds are unsigned).
set -eu

cd "$(dirname "$0")/.."
ROOT=$(pwd)
. scripts/lib/cache.sh

REPO=PureXYZ/2004scape-sp-mobile
ALLOW_DIRTY=0
UPLOAD=0
DO_IOS=1
DO_ANDROID=1
while [ $# -gt 0 ]; do
    case "$1" in
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --upload) UPLOAD=1 ;;
    --skip-ios) DO_IOS=0 ;;
    --skip-android) DO_ANDROID=0 ;;
    --repo)
        [ $# -ge 2 ] || { echo "release: --repo takes <owner/name>" >&2; exit 2; }
        REPO=$2
        shift
        ;;
    *)
        awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0" >&2
        exit 2
        ;;
    esac
    shift
done

VERSION=$(tr -d ' \n\r' < VERSION)
case "$VERSION" in
[0-9]*.[0-9]*.[0-9]*) ;;
*)
    echo "release: VERSION is '$VERSION'; it must be major.minor.patch" >&2
    exit 1
    ;;
esac
TAG="v$VERSION"
DIST="dist/$VERSION"
WORK="build/release"
NAME="2004Scape-$VERSION"
APK_FULL="$NAME-android.apk"
APK_LITE="$NAME-android-lite.apk"
IPA_FULL="$NAME-ios.ipa"
IPA_LITE="$NAME-ios-lite.ipa"
MODEL_FILE=bots-2004-q4km.gguf
LICENSES_FILE=licenses.txt
MODEL_TAG=model-v1
BUNDLE_ID=io.github.purexyz.scape2004
# the 2004Scape release key's certificate (public): an APK signed with anything else is not this project's release
RELEASE_CERT_SHA256=$(printf '%s' "${RELEASE_CERT_SHA256:-88:47:5C:3F:C0:29:42:05:46:56:3E:CA:F8:87:21:37:B1:35:38:6A:0F:5D:53:24:0D:BE:1B:0D:AB:12:82:65}" | tr -d ':' | tr '[:upper:]' '[:lower:]')

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
KEY_DIR="$HOME/.android/2004scape"

say() {
    printf '\n== %s\n' "$*"
}
die() {
    echo "release: $*" >&2
    exit 1
}
# mb <file>: its size in decimal megabytes, rounded (as the README and the release notes give sizes)
mb() {
    echo $(( ($(bytes "$1") + 500000) / 1000000 ))
}
# size <file>: "<n> MB", or "<n> KB" below a megabyte (decimal)
size() {
    if [ "$(bytes "$1")" -lt 1000000 ]; then echo "$(( ($(bytes "$1") + 500) / 1000 )) KB"; else echo "$(mb "$1") MB"; fi
}

COMMIT=$(git rev-parse HEAD)
DIRTY=$(git status --porcelain --untracked-files=normal)

# ---------------------------------------------------------------------------------------------------- private ids

# What names a builder's machine or Apple account, as extended regexps, one per line (case-sensitive: /Users/ is macOS's
# home folder, while URLs have /users/). Allowed: llama.cpp's own CI paths (/Users/runner/...) and the GitHub Actions
# runner's (/Users/runner is GitHub's macOS user).
PATTERNS=$(mktemp "${TMPDIR:-/tmp}/release-patterns.XXXXXX")
trap 'rm -f "$PATTERNS"' EXIT
cat > "$PATTERNS" <<'EOF'
/Users/[^/[:space:][:cntrl:]"'<>]+
/private/(tmp|var/folders)
claude-[0-9]{3}
lostcity-port
00008110-[0-9A-Fa-f]{16}
EOF
# and the builder's own, read here so that none has to be written in this file: every user.email in git's config (all
# scopes: a commit made with GitHub's noreply address still scans for the real one) and the signing team (TEAM, or
# ios/Config/Local.xcconfig's). (A home folder is /Users/<name>, above.)
{
    git config --get-all user.email || true
    [ -n "${TEAM:-}" ] && printf '%s\n' "$TEAM"
    sed -n -E 's/^[[:space:]]*DEVELOPMENT_TEAM[[:space:]]*=[[:space:]]*([A-Za-z0-9]+).*/\1/p' ios/Config/Local.xcconfig 2>/dev/null || true
} | grep -v -E '^$' | grep -v -E '@users\.noreply\.github\.com$' | sort -u | sed 's/[][\.*^$+?(){}|/]/\\&/g' >> "$PATTERNS"
[ -n "${PRIVATE_PATTERNS:-}" ] && printf '%s\n' "$PRIVATE_PATTERNS" >> "$PATTERNS"
ALLOWED='^/Users/runner$'

# history_hits: the private ids in the commits being released (HEAD and its ancestors: authors, committers, messages),
# one per line. Once pushed they are public and only a rewrite of the history takes them out, so the public history is
# committed as GitHub's noreply address (docs/RELEASING.md, The public history).
history_hits() {
    git log --format='%an <%ae>%n%cn <%ce>%n%B' HEAD | LC_ALL=C grep -o -E -f "$PATTERNS" | LC_ALL=C grep -v -E "$ALLOWED" | sort | uniq -c |
        awk '{ n = $1; $1 = ""; sub(/^ /, ""); printf "%s (%d times in the history)\n", $0, n }'
}

# ---------------------------------------------------------------------------------------------------- upload

# built_ok: dist/<version>/ is complete, built from this commit from a clean tree, and its checksums still hold
built_ok() {
    [ -f "$DIST/.build.json" ] && [ -f "$DIST/SHA256SUMS.txt" ] && [ -f "$DIST/RELEASE_NOTES.md" ] || return 1
    [ "$(json_field "$DIST/.build.json" commit)" = "$COMMIT" ] || return 1
    [ "$(json_field "$DIST/.build.json" dirty)" = "false" ] || return 1
    [ "$(json_field "$DIST/.build.json" complete)" = "true" ] || return 1
    for f in "$APK_FULL" "$APK_LITE" "$IPA_FULL" "$IPA_LITE" "$MODEL_FILE" "$LICENSES_FILE"; do
        grep -q "  $f\$" "$DIST/SHA256SUMS.txt" || return 1
    done
    (cd "$DIST" && shasum -a 256 -c SHA256SUMS.txt >/dev/null 2>&1)
}

upload() {
    command -v gh >/dev/null 2>&1 || die "--upload needs the GitHub CLI (gh), logged in (gh auth login)"
    gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"
    gh api "repos/$REPO" >/dev/null 2>&1 || die "no GitHub repository $REPO (or no access to it): create it and push first"
    gh api "repos/$REPO/commits/$COMMIT" >/dev/null 2>&1 || die "$REPO does not have commit $COMMIT: push it first (the release's tag is made on it)"
    if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
        die "$REPO already has a release $TAG: delete the draft (gh release delete $TAG --repo $REPO) or raise VERSION"
    fi
    if gh release view "$MODEL_TAG" --repo "$REPO" >/dev/null 2>&1; then
        echo "release: $REPO has $MODEL_TAG already; not uploading the model there again"
    else
        say "Draft release $MODEL_TAG (the chat model on its own)"
        sums=$(grep "  $MODEL_FILE\$" "$DIST/SHA256SUMS.txt" | awk '{ print $1 }')
        notes=$(mktemp "${TMPDIR:-/tmp}/release-model.XXXXXX")
        cat > "$notes" <<EOF
The bots' on-device chat model: Qwen3.5 0.8B with a LoRA trained on 2004-style chat, quantized to Q4_K_M with llama.cpp.
The full app builds carry it already; this copy is for building the apps from source (\`ios/scripts/prepare-model.sh --download\`
and \`android/scripts/prepare-model.sh --download\` fetch it from here and check it against \`models/bots-2004.json\`).

- $MODEL_FILE: $(bytes "$DIST/$MODEL_FILE") bytes, sha256 \`$sums\`
- Base model: $(json_field models/bots-2004.json base)

Licence: Apache License 2.0. This is a modified version of Qwen3.5-0.8B, Copyright 2026 Alibaba Cloud, changed for
this project in 2026: a LoRA (rank 16) fine-tuned on game chat lines, merged into the base weights, converted to GGUF with llama.cpp
and quantised to Q4_K_M. (Its GGUF metadata names Qwen3.5-0.8B-Base as the base model, copied from Qwen3.5-0.8B's model
card by the converter; the weights it was made from are Qwen/Qwen3.5-0.8B's, above.) The licence's full text is in
$LICENSES_FILE, attached, and in THIRD_PARTY_NOTICES.md (section E).
EOF
        gh release create "$MODEL_TAG" --repo "$REPO" --draft --latest=false --target "$COMMIT" \
            --title "Chat model v1" --notes-file "$notes" "$DIST/$MODEL_FILE" "$DIST/$LICENSES_FILE"
        rm -f "$notes"
    fi
    say "Draft release $TAG"
    gh release create "$TAG" --repo "$REPO" --draft --target "$COMMIT" --title "2004Scape $VERSION" \
        --notes-file "$DIST/RELEASE_NOTES.md" \
        "$DIST/$APK_FULL" "$DIST/$APK_LITE" "$DIST/$IPA_FULL" "$DIST/$IPA_LITE" "$DIST/$MODEL_FILE" "$DIST/$LICENSES_FILE" \
        "$DIST/SHA256SUMS.txt"
    echo
    echo "Drafts made on https://github.com/$REPO/releases: check them, then publish $MODEL_TAG first (prepare-model.sh"
    echo "--download needs it public) and $TAG after it."
}

HISTORY_HITS=$(history_hits)
if [ -n "$HISTORY_HITS" ]; then
    echo "$HISTORY_HITS" | head -n 20 | sed 's/^/  /' >&2
    if [ "$UPLOAD" = "1" ]; then
        die "the commits being released name the private ids above (authors, committers or messages). Rewrite them with GitHub's noreply address and a clean message, push that history, then upload (docs/RELEASING.md, The public history)"
    fi
    echo "release: warning: the commits name the private ids above; do not push this history (docs/RELEASING.md, The public history)" >&2
fi

if [ "$UPLOAD" = "1" ]; then
    [ -z "$DIRTY" ] || die "the tree has uncommitted changes; an upload is built from a clean, pushed commit (git status)"
    [ "$DO_IOS" = "1" ] && [ "$DO_ANDROID" = "1" ] || die "--upload uploads a whole release; it does not go with --skip-ios or --skip-android"
    if built_ok; then
        echo "release: $DIST is complete and was built from $COMMIT; uploading it"
        upload
        exit 0
    fi
    echo "release: $DIST is missing, partial or from another commit; building it first"
fi

# ---------------------------------------------------------------------------------------------------- checks

if [ -n "$DIRTY" ]; then
    if [ "$ALLOW_DIRTY" != "1" ]; then
        echo "$DIRTY" | sed 's/^/  /' >&2
        die "the tree has uncommitted changes (above): commit them, or pass --allow-dirty for a test build"
    fi
    echo "release: building from a dirty tree (--allow-dirty): a test build, not for upload"
fi
command -v node >/dev/null 2>&1 || die "node is needed (Node 24 or later)"
if [ "$DO_IOS" = "1" ]; then
    command -v xcodebuild >/dev/null 2>&1 || die "xcodebuild is needed for the iOS app (Xcode; or --skip-ios)"
fi
if [ "$DO_ANDROID" = "1" ]; then
    [ -d "$ANDROID_HOME" ] || die "no Android SDK at $ANDROID_HOME (set ANDROID_HOME; or --skip-android)"
    [ -x "$JAVA_HOME/bin/java" ] || die "no JDK at $JAVA_HOME (set JAVA_HOME to Android Studio's JBR; or --skip-android)"
    # A release is never signed with the SDK's debug key (every machine has its own, so updates would fail to install):
    # the release key must be there, and the APKs are checked against its certificate below.
    [ -f "$KEY_DIR/keystore.properties" ] || die "no release key: $KEY_DIR/keystore.properties is missing (docs/RELEASING.md, Signing). The build would be signed with the SDK's debug key; not making a release with it"
    store=$(sed -n 's/^storeFile=//p' "$KEY_DIR/keystore.properties" | tail -n 1)
    case "$store" in
    /*) ;;
    *) store="$KEY_DIR/$store" ;;
    esac
    [ -n "$store" ] && [ -f "$store" ] || die "no release key: $KEY_DIR/keystore.properties names the key store '$store', which is not there"
fi

# The chat model, from the cache, as models/bots-2004.json pins it
MODEL_SRC="$CACHE_DIR/models/$(json_field models/bots-2004.json file)"
MODEL_BYTES=$(json_field models/bots-2004.json bytes)
MODEL_SHA=$(json_field models/bots-2004.json sha256)
if [ ! -f "$MODEL_SRC" ] || [ "$(bytes "$MODEL_SRC")" != "$MODEL_BYTES" ] || [ "$(sha "$MODEL_SRC")" != "$MODEL_SHA" ]; then
    die "the chat model in $MODEL_SRC is missing or is not the one models/bots-2004.json pins ($MODEL_BYTES bytes, sha256 $MODEL_SHA): ios/scripts/prepare-model.sh --download fetches it"
fi

STARTED=$(date +%s)
rm -rf "$DIST" "$WORK"
mkdir -p "$DIST" "$WORK"

# ---------------------------------------------------------------------------------------------------- the web bundle

say "Web bundle (release; the engine's packer; the bots required)"
node scripts/build-web.mjs --require-bots
grep -q '"autotest": false' build/Game/build-info.json || die "build/Game/build-info.json does not say autotest false"
if [ "$DO_ANDROID" = "1" ]; then
    # (the same bundle for the APK: the pack is fresh now, so the second build skips the packer)
    node scripts/build-web.mjs --require-bots --skip-pack --out android/build/web/Game
fi

# ---------------------------------------------------------------------------------------------------- iOS

# ios_build <lite|full>: the unsigned Release app for devices, in its own DerivedData (Xcode copies the Model folder
# reference as a whole, and a separate build per variant keeps a stale copy of it out of the other one)
ios_build() {
    dd="$WORK/ios-$1"
    xcodebuild -project ios/LostCity.xcodeproj -scheme LostCity -configuration Release \
        -destination generic/platform=iOS -derivedDataPath "$dd" \
        CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= CODE_SIGN_ENTITLEMENTS= \
        DEVELOPMENT_TEAM= PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
        build -quiet
    app="$dd/Build/Products/Release-iphoneos/LostCity.app"
    [ -d "$app" ] || die "the iOS build made no $app"
    got=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")
    [ "$got" = "$BUNDLE_ID" ] || die "$app has the bundle id $got, not $BUNDLE_ID"
    got=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Info.plist")
    [ "$got" = "$VERSION" ] || die "$app has the version $got, not $VERSION"
    [ ! -e "$app/embedded.mobileprovision" ] || die "$app has an embedded.mobileprovision (a team's profile); the release is unsigned"
    [ ! -e "$app/_CodeSignature" ] || die "$app is signed (_CodeSignature); the release is unsigned"
    if nm -ap "$app/LostCity" 2>/dev/null | grep -q ' OSO '; then
        die "$app/LostCity is not stripped (debug map entries name the build folders)"
    fi
    if [ "$1" = full ]; then
        [ -f "$app/Model/model.json" ] && [ -f "$app/Model/bots-2004.gguf" ] || die "$app has no Model/ (the full build carries the chat model)"
    else
        [ -z "$(ls -A "$app/Model" 2>/dev/null)" ] || die "$app/Model is not empty (the lite build carries no model)"
    fi
    # Payload/LostCity.app at the zip's root: what AltStore, SideStore and Sideloadly unpack and sign
    stage="$WORK/ipa-$1"
    rm -rf "$stage"
    mkdir -p "$stage/Payload"
    ditto "$app" "$stage/Payload/LostCity.app"
    (cd "$stage" && COPYFILE_DISABLE=1 zip -qry -X "$ROOT/$DIST/$2" Payload)
    echo "release: $DIST/$2 ($(mb "$DIST/$2") MB)"
}

if [ "$DO_IOS" = "1" ]; then
    say "iOS: llama.cpp"
    ios/scripts/fetch-llama.sh
    say "iOS: lite (no model)"
    ios/scripts/prepare-model.sh --none
    ios_build lite "$IPA_LITE"
    say "iOS: full (the chat model)"
    ios/scripts/prepare-model.sh
    ios_build full "$IPA_FULL"
fi

# ---------------------------------------------------------------------------------------------------- Android

APKSIGNER=""
if [ "$DO_ANDROID" = "1" ]; then
    APKSIGNER=$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -n 1)
    [ -n "$APKSIGNER" ] || die "no apksigner in $ANDROID_HOME/build-tools"
fi

# android_build <lite|full> <apk name>
android_build() {
    set -- "$1" "$2" :app:assembleRelease -PnoBuildWeb --console=plain -q
    [ "$1" = lite ] && set -- "$@" -Plc.model=none
    variant=$1
    name=$2
    shift 2
    (cd android && ./gradlew "$@")
    apk=android/app/build/outputs/apk/release/app-release.apk
    [ -f "$apk" ] || die "the Android build made no $apk"
    certs=$("$APKSIGNER" verify --verbose --print-certs "$apk") || die "apksigner verify failed for $apk"
    # (minSdk 30: AGP signs with v3 alone, which Android 9 and later check; v1/v2 would add nothing here)
    echo "$certs" | grep -Eq 'Verified using v[23] scheme \(APK Signature Scheme v[23]\): true' || die "$apk has no v2 or v3 signature"
    case "$certs" in
    *"CN=Android Debug"*) die "$apk is signed with the SDK's debug key, not the release key" ;;
    esac
    digest=$(echo "$certs" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | tr -d ':' | tr '[:upper:]' '[:lower:]')
    [ "$digest" = "$RELEASE_CERT_SHA256" ] || die "$apk is signed with the certificate $digest, not the release key's $RELEASE_CERT_SHA256 (RELEASE_CERT_SHA256 for another key)"
    entries=$(unzip -Z1 "$apk")
    if [ "$variant" = full ]; then
        echo "$entries" | grep -qx 'assets/Model/bots-2004.gguf' || die "$apk has no assets/Model/bots-2004.gguf"
    else
        ! echo "$entries" | grep -q '^assets/Model/' || die "$apk carries a model (the lite build has none)"
    fi
    echo "$entries" | grep -qx 'assets/Game/index.html' || die "$apk has no assets/Game/index.html"
    cp "$apk" "$DIST/$name"
    echo "release: $DIST/$name ($(mb "$DIST/$name") MB), signed with $(echo "$certs" | sed -n 's/^Signer #1 certificate DN: //p')"
}

if [ "$DO_ANDROID" = "1" ]; then
    say "Android: llama.cpp"
    android/scripts/fetch-llama.sh
    say "Android: lite (no model)"
    android_build lite "$APK_LITE"
    say "Android: full (the chat model)"
    android/scripts/prepare-model.sh
    android_build full "$APK_FULL"
fi

say "The model on its own"
clone_file "$MODEL_SRC" "$DIST/$MODEL_FILE"
[ "$(sha "$DIST/$MODEL_FILE")" = "$MODEL_SHA" ] || die "$DIST/$MODEL_FILE does not have the sha256 $MODEL_SHA"
# (every licence text and notice, as the apps carry it: it goes with the release's assets, the model above among them)
cp build/Game/licenses.txt "$DIST/$LICENSES_FILE"

# ---------------------------------------------------------------------------------------------------- checksums, notes

say "Checksums and release notes"
(cd "$DIST" && shasum -a 256 $(ls | grep -v -e '^SHA256SUMS.txt$' -e '^RELEASE_NOTES.md$' ) > SHA256SUMS.txt)
cat "$DIST/SHA256SUMS.txt"

# CHANGELOG.md's section for this version: from its "## [x.y.z]" (or "## x.y.z") heading to the next "## "
changes=$(awk -v v="$VERSION" '
    /^## / { if (found) exit; h = $0; gsub(/[][]/, "", h); split(h, w, " "); if (w[2] == v) { found = 1; next } }
    found { print }
' CHANGELOG.md 2>/dev/null | sed -e '/./,$!d')
[ -n "$changes" ] || changes="First release."
sum_of() { grep "  $1\$" "$DIST/SHA256SUMS.txt" | awk '{ print $1 }'; }
DL="https://github.com/$REPO/releases/download/$TAG"
{
    printf '## What'"'"'s new\n\n%s\n\n' "$changes"
    cat <<EOF
## Install

The **full** builds carry the bots' on-device chat model (about 530 MB), so bots answer you in their own words with no
network. The **lite** builds leave it out: bots then chat with the built-in rules (or Claude online, with your own API
key). Everything else is the same.

**Android** (Android 11 or later, 64-bit ARM): download [$APK_FULL]($DL/$APK_FULL) or [$APK_LITE]($DL/$APK_LITE) on the
phone and open it; allow "Install unknown apps" for your browser or Files app when Android asks. A new version installs
over the old one and keeps your saves. Step by step: [INSTALL-ANDROID.md](https://github.com/$REPO/blob/main/docs/INSTALL-ANDROID.md).

**iPhone** (iOS 18.4 or later): the IPAs are unsigned. Install [$IPA_FULL]($DL/$IPA_FULL) or [$IPA_LITE]($DL/$IPA_LITE)
with [Sideloadly](https://sideloadly.io), [AltStore](https://altstore.io) or [SideStore](https://sidestore.io), which sign
it with your own Apple Account (a free one must refresh the app every 7 days; refreshing keeps your saves). Or build it
yourself with Xcode: see [BUILDING.md](https://github.com/$REPO/blob/main/docs/BUILDING.md). Step by step: [INSTALL-IPHONE.md](https://github.com/$REPO/blob/main/docs/INSTALL-IPHONE.md).

The model on its own, [$MODEL_FILE]($DL/$MODEL_FILE), is only for building the apps from source; the full builds already
have it.

## Licences

2004Scape's own code is MIT licensed; the third-party parts keep their own licences. [$LICENSES_FILE]($DL/$LICENSES_FILE)
lists them all, with each licence's full text (the same file as the apps' Settings › About › Licences, and
THIRD_PARTY_NOTICES.md in the repository). The chat model, $MODEL_FILE (also inside the full builds), is a modified
version of Qwen3.5-0.8B (Apache License 2.0, Copyright 2026 Alibaba Cloud): changed for this project in 2026 with a LoRA
fine-tune merged into the weights, converted to GGUF and quantised to Q4_K_M with llama.cpp. It is distributed under the
Apache License 2.0.

## Checksums (SHA-256)

| File | Size | SHA-256 |
| --- | --- | --- |
EOF
    for f in $(awk '{ print $2 }' "$DIST/SHA256SUMS.txt"); do
        printf '| %s | %s | `%s` |\n' "$f" "$(size "$DIST/$f")" "$(sum_of "$f")"
    done
    cat <<EOF

Built from commit $COMMIT. Signed with the 2004Scape release key (Android certificate SHA-256
\`$(echo "$RELEASE_CERT_SHA256" | tr '[:lower:]' '[:upper:]' | sed 's/../&:/g; s/:$//')\`).

2004Scape is a derived work: it runs Lost City's game (Engine-TS, Client-TS, Content) and a port of 2004SP Progressive's
bot AI, and most of this project's own code was generated with Claude (Anthropic) through Claude Code. Credits: the
README and THIRD_PARTY_NOTICES.md.

---

2004Scape is an unofficial fan project. It is not affiliated with, endorsed by or connected to Jagex Ltd or the Lost City project. RuneScape is a registered trademark of Jagex Ltd. The game data the app is built from is the intellectual property of Jagex Ltd. This project is free: no ads, no payments, no accounts.
EOF
} > "$DIST/RELEASE_NOTES.md"

# ---------------------------------------------------------------------------------------------------- the scan

# Every file in dist/ is searched as it is and, for the apps, unpacked with the zips inside them (the server's maps), for
# what names a builder's machine or Apple account ($PATTERNS, above). Not opened: the game cache's gzip entries
# (cache/main_file_cache.dat) and the bzip2 entries of the .jag archives, which the engine's packer makes from Content.
say "Scan for local paths and ids"
SCAN="$WORK/scan"
HITS="$WORK/scan-hits.txt"
: > "$HITS"
# scan <label> <file or folder>: every match as "<label>: <file>:<match>", but the allowed ones
scan() {
    LC_ALL=C grep -r -H -a -o -E -f "$PATTERNS" "$2" 2>/dev/null | while IFS= read -r line; do
        match=${line#*:}
        printf '%s\n' "$match" | LC_ALL=C grep -q -E "$ALLOWED" && continue
        printf '%s: %s\n' "$1" "${line#"$SCAN"/}" >> "$HITS"
    done
}
# unzip_nested <folder>: unpacks every zip inside it into <zip>.d/, three levels deep
unzip_nested() {
    for _ in 1 2 3; do
        find "$1" -type f -name '*.zip' | while IFS= read -r z; do
            [ -d "$z.d" ] && continue
            mkdir -p "$z.d"
            unzip -q "$z" -d "$z.d" || die "could not unpack $z to scan it"
        done
    done
}
for f in "$DIST"/*; do
    base=$(basename "$f")
    scan "$base" "$f" # (as it is: the entries' names, the stored entries)
    case "$base" in
    *.apk | *.ipa)
        rm -rf "$SCAN"
        mkdir -p "$SCAN"
        unzip -q "$f" -d "$SCAN"
        unzip_nested "$SCAN"
        scan "$base" "$SCAN"
        ;;
    esac
done
rm -rf "$SCAN"
if [ -s "$HITS" ]; then
    sort -u "$HITS" | head -n 40 >&2
    die "the artifacts contain local paths or private ids (above; all of them in $HITS): not releasing them"
fi
echo "release: no local paths or private ids in $(ls "$DIST" | wc -l | tr -d ' ') files"

COMPLETE=false
[ "$DO_IOS" = "1" ] && [ "$DO_ANDROID" = "1" ] && COMPLETE=true
cat > "$DIST/.build.json" <<EOF
{ "version": "$VERSION", "commit": "$COMMIT", "dirty": $([ -n "$DIRTY" ] && echo true || echo false), "complete": $COMPLETE }
EOF

say "Done in $(( $(date +%s) - STARTED )) s: $DIST"
ls -l "$DIST" | awk 'NR > 1 { printf "  %12s  %s\n", $5, $9 }'

if [ "$UPLOAD" = "1" ]; then
    built_ok || die "the build in $DIST does not check out (SHA256SUMS.txt, build.json); not uploading it"
    upload
fi
