#!/bin/sh
# Builds the app, installs it on a connected iPhone (or a simulator) and launches it.
#
#   ios/scripts/deploy.sh                   # device: the connected/paired iPhone
#   LOGS=1 ios/scripts/deploy.sh            # also stream the app's log (incl. JS console) here; Ctrl-C then QUITS the app
#   ios/scripts/deploy.sh --sim             # simulator: "iPhone 17" (override with SIM_NAME)
#   DEVICE=<udid> ios/scripts/deploy.sh     # a specific device
#   CONFIG=Release ios/scripts/deploy.sh    # optimized native build
#   WEB_DEBUG=1 ios/scripts/deploy.sh       # unminified web build with sourcemaps + console (for Safari Web Inspector)
#   NO_BUILD_WEB=1 ios/scripts/deploy.sh    # skip the web/data build step (reuse build/Game)
#   TEAM=<team id> [BUNDLE_ID=<id>] ios/scripts/deploy.sh   # sign with your own Apple ID's team (see README)
#
# Signing comes from ios/Config/Signing.xcconfig and a builder's own ios/Config/Local.xcconfig (git-ignored:
# DEVELOPMENT_TEAM, BUNDLE_ID_SUFFIX; Local.xcconfig.example). TEAM overrides the team; with TEAM and no BUNDLE_ID the
# bundle id is io.github.purexyz.scape2004.<team id>. BUNDLE_ID alone overrides the bundle id.
set -eu

cd "$(dirname "$0")/../.."
CONFIG="${CONFIG:-Debug}"
DERIVED="build/DerivedData"

# Signing overrides (ios/Config/Signing.xcconfig and Local.xcconfig are used when neither is set).
SIGNING=""
if [ -n "${TEAM:-}" ]; then
    SIGNING="DEVELOPMENT_TEAM=$TEAM PRODUCT_BUNDLE_IDENTIFIER=${BUNDLE_ID:-io.github.purexyz.scape2004.$TEAM}"
elif [ -n "${BUNDLE_ID:-}" ]; then
    SIGNING="PRODUCT_BUNDLE_IDENTIFIER=$BUNDLE_ID"
fi

# the bundle id the build was made with (Signing.xcconfig, Local.xcconfig's suffix, or the overrides above)
bundle_id() {
    /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Info.plist"
}

build_web() {
    if [ "${WEB_DEBUG:-0}" = "1" ]; then
        node scripts/build-web.mjs --debug
    else
        node scripts/build-web.mjs
    fi
}
if [ "${NO_BUILD_WEB:-0}" != "1" ]; then
    build_web
elif grep -q '"autotest": true' build/Game/build-info.json 2>/dev/null; then
    # web/test/app-test.mjs leaves its self-playing variant in build/Game; never install that as the app
    echo "build/Game is the autotest variant; rebuilding the normal web bundle"
    build_web
fi

# llama.cpp's framework for the bots' on-device chat model, and the model folder (empty unless ios/scripts/prepare-model.sh
# filled it): the app links and bundles both (docs/ARCHITECTURE.md §7.1)
ios/scripts/fetch-llama.sh

if [ "${1:-}" = "--sim" ]; then
    SIM_NAME="${SIM_NAME:-iPhone 17}"
    # shellcheck disable=SC2086 # SIGNING is a list of build settings
    xcodebuild -project ios/LostCity.xcodeproj -scheme LostCity -configuration "$CONFIG" \
        -destination "platform=iOS Simulator,name=$SIM_NAME" -derivedDataPath "$DERIVED" $SIGNING build -quiet
    APP="$DERIVED/Build/Products/$CONFIG-iphonesimulator/LostCity.app"
    xcrun simctl boot "$SIM_NAME" 2>/dev/null || true
    open -a DeviceHub 2>/dev/null || open -a Simulator 2>/dev/null || true  # Xcode 27 replaced Simulator.app with DeviceHub
    xcrun simctl install "$SIM_NAME" "$APP"
    exec xcrun simctl launch --console-pty --terminate-running-process "$SIM_NAME" "$(bundle_id "$APP")"
fi

# A device build needs a team: TEAM, or DEVELOPMENT_TEAM in ios/Config/Local.xcconfig.
if [ -z "${TEAM:-}" ] && ! grep -Eq '^[[:space:]]*DEVELOPMENT_TEAM[[:space:]]*=[[:space:]]*[A-Za-z0-9]' ios/Config/Local.xcconfig 2>/dev/null; then
    echo "No signing team: copy ios/Config/Local.xcconfig.example to ios/Config/Local.xcconfig and set DEVELOPMENT_TEAM (and" >&2
    echo "BUNDLE_ID_SUFFIX), or run TEAM=<your team id> ios/scripts/deploy.sh (Xcode › Settings › Accounts shows the id)." >&2
    exit 1
fi

if [ -z "${DEVICE:-}" ]; then
    PHONES=$(xcrun devicectl list devices 2>/dev/null | awk '(/available \(paired\)/ || / connected /) && !/simulated/ && /iPhone/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$/) print $i }')
    DEVICE=$(printf '%s\n' "$PHONES" | head -n 1)
    if [ "$(printf '%s\n' "$PHONES" | grep -c .)" -gt 1 ]; then
        echo "Several iPhones are connected; using $DEVICE (pick one with DEVICE=<udid>):"
        printf '  %s\n' $PHONES
    fi
fi
if [ -z "$DEVICE" ]; then
    echo "No paired iPhone found (xcrun devicectl list devices). Connect and unlock it, or pass DEVICE=<udid>." >&2
    exit 1
fi

# A generic device build works while the phone is locked; installing needs it unlocked.
# shellcheck disable=SC2086
xcodebuild -project ios/LostCity.xcodeproj -scheme LostCity -configuration "$CONFIG" \
    -destination "generic/platform=iOS" -derivedDataPath "$DERIVED" -allowProvisioningUpdates $SIGNING build -quiet
APP="$DERIVED/Build/Products/$CONFIG-iphoneos/LostCity.app"
BUNDLE_ID=$(bundle_id "$APP")
# Release strips the binary (ios/Config/Signing.xcconfig): a debug map left in it names this Mac's folders
if [ "$CONFIG" = "Release" ] && nm -ap "$APP/LostCity" 2>/dev/null | grep -q ' OSO '; then
    echo "warning: $APP/LostCity is not stripped (it has debug map entries with local paths): do not distribute it" >&2
fi

locked() {
    xcrun devicectl device info lockState --device "$DEVICE" 2>/dev/null | grep -q "passcodeRequired: true"
}
if locked; then
    echo "Unlock your iPhone to install…"
    while locked; do sleep 2; done
fi
xcrun devicectl device install app --device "$DEVICE" "$APP"

# The first install from an Apple ID will not launch until the developer is trusted on the phone; a suspended
# test launch tells us when that has happened.
HINTED=""
while ! OUTPUT=$(xcrun devicectl device process launch --device "$DEVICE" --terminate-existing --start-stopped "$BUNDLE_ID" 2>&1); do
    case "$OUTPUT" in
    *"explicitly trusted"* | *"invalid code signature"*)
        if [ -z "$HINTED" ]; then
            echo "iOS has not trusted this developer yet. On the iPhone open Settings › General › VPN & Device Management,"
            echo "tap the \"Apple Development\" profile, then Trust (needs internet). Waiting…"
            HINTED=1
        fi
        ;;
    *locked*)
        locked && echo "Unlock your iPhone to launch…"
        while locked; do sleep 2; done
        ;;
    *)
        echo "$OUTPUT" >&2
        exit 1
        ;;
    esac
    sleep 4
done
if [ "${LOGS:-0}" = "1" ]; then
    echo "Streaming the app's log; Ctrl-C quits the app on the phone."
    exec xcrun devicectl device process launch --device "$DEVICE" --terminate-existing --console "$BUNDLE_ID"
fi
xcrun devicectl device process launch --device "$DEVICE" --terminate-existing "$BUNDLE_ID" >/dev/null
echo "2004Scape is running on the iPhone."
