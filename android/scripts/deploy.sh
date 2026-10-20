#!/bin/sh
# Builds the Android app, installs it on a connected phone (or the emulator) and launches it (ports ios/scripts/deploy.sh;
# docs/ANDROID.md §1 Install).
#
#   android/scripts/deploy.sh                  # the connected phone (adb devices)
#   LOGS=1 android/scripts/deploy.sh           # also stream the app's log (incl. the page's console) here; Ctrl-C then QUITS the app
#   android/scripts/deploy.sh --emu            # the emulator: the running one, or AVD (default Medium_Phone_API_37.0) started
#   DEVICE=<serial> android/scripts/deploy.sh  # a specific device or emulator (adb devices)
#   CONFIG=Release android/scripts/deploy.sh   # R8-minified and not debuggable; Debug (the default) has the debug hooks and
#                                              # chrome://inspect. Both are signed with the 2004Scape key, so either installs
#                                              # over the other and the saves stay (docs/ANDROID.md §1 Signing)
#   WEB_DEBUG=1 android/scripts/deploy.sh      # unminified web build with sourcemaps + console (inspect it in a Debug build)
#   NO_BUILD_WEB=1 android/scripts/deploy.sh   # skip the web build (reuse android/build/web/Game)
#   PACK=1 android/scripts/deploy.sh           # let the web build run the engine's packer (after content changes)
#   VERBOSE=1 android/scripts/deploy.sh        # launch with the verbose native log on (it stays on until VERBOSE=0; Debug only)
#
# There is no 7-day expiry and no trust step on Android. Installing never deletes the saves (adb install -r).
set -eu

cd "$(dirname "$0")/.."
# (exported: Gradle finds the SDK through it when there is no android/local.properties, as in a fresh checkout)
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$ANDROID_HOME/platform-tools/adb"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
PKG=io.github.purexyz.scape2004
AVD="${AVD:-Medium_Phone_API_37.0}"
CONFIG="${CONFIG:-Debug}"
case "$(printf '%s' "$CONFIG" | tr '[:upper:]' '[:lower:]')" in
debug) VARIANT=Debug ;;
release) VARIANT=Release ;;
*)
    echo "CONFIG must be Debug or Release (got $CONFIG)" >&2
    exit 2
    ;;
esac
EMU=0
for arg in "$@"; do
    case "$arg" in
    --emu) EMU=1 ;;
    *)
        echo "unknown option $arg (see the top of $0)" >&2
        exit 2
        ;;
    esac
done

# ---------------------------------------------------------------------------------------------------- the web bundle

build_web() {
    set -- --out android/build/web/Game
    [ "${PACK:-0}" = "1" ] || set -- "$@" --skip-pack
    [ "${WEB_DEBUG:-0}" = "1" ] && set -- "$@" --debug
    (cd .. && node scripts/build-web.mjs "$@")
}
if [ "${NO_BUILD_WEB:-0}" != "1" ]; then
    build_web
elif grep -q '"autotest": true' build/web/Game/build-info.json 2>/dev/null; then
    # the in-app test leaves its self-playing variant in android/build/web/Game; never install that as the app
    echo "android/build/web/Game is the autotest variant; rebuilding the normal web bundle"
    build_web
elif [ ! -f build/web/Game/index.html ]; then
    echo "android/build/web/Game is missing; building it"
    build_web
fi

# ---------------------------------------------------------------------------------------------------- the device

listed() { "$ADB" devices | awk -v state="$1" 'NR > 1 && $2 == state { print $1 }'; }

if [ -z "${DEVICE:-}" ] && [ "$EMU" = "1" ]; then
    EMULATORS=$(listed device | grep '^emulator-' || true)
    DEVICE=$(printf '%s\n' "$EMULATORS" | head -n 1)
    if [ "$(printf '%s\n' "$EMULATORS" | grep -c .)" -gt 1 ]; then
        echo "Several emulators are running; using $DEVICE (pick one with DEVICE=<serial>):"
        printf '  %s\n' $EMULATORS
    fi
    if [ -z "$DEVICE" ]; then
        echo "Starting the emulator ($AVD)…"
        "$ANDROID_HOME/emulator/emulator" -avd "$AVD" -no-snapshot-save >/dev/null 2>&1 &
        while [ -z "$DEVICE" ]; do
            sleep 2
            DEVICE=$( (listed device; listed offline) | grep '^emulator-' | head -n 1 || true)
        done
    fi
elif [ -z "${DEVICE:-}" ]; then
    PHONES=$(listed device | grep -v '^emulator-' || true)
    DEVICE=$(printf '%s\n' "$PHONES" | head -n 1)
    if [ "$(printf '%s\n' "$PHONES" | grep -c .)" -gt 1 ]; then
        echo "Several phones are connected; using $DEVICE (pick one with DEVICE=<serial>):"
        printf '  %s\n' $PHONES
    fi
    if [ -z "$DEVICE" ] && [ -n "$(listed unauthorized)" ]; then
        echo "The phone has not allowed this computer yet: unlock it and accept \"Allow USB debugging?\" (then run this again)." >&2
        exit 1
    fi
fi
if [ -z "$DEVICE" ]; then
    echo "No Android device found (adb devices). Enable Developer options › USB debugging, connect and allow this computer, or pass DEVICE=<serial> (--emu for the emulator)." >&2
    exit 1
fi
ADB_D() { "$ADB" -s "$DEVICE" "$@"; }

# Gradle builds while the device boots.
./gradlew ":app:assemble$VARIANT" -PnoBuildWeb -q --console=plain
APK="app/build/outputs/apk/$(printf '%s' "$VARIANT" | tr '[:upper:]' '[:lower:]')/app-$(printf '%s' "$VARIANT" | tr '[:upper:]' '[:lower:]').apk"

ADB_D wait-for-device
if [ "$(ADB_D shell getprop sys.boot_completed | tr -d '\r')" != "1" ]; then
    echo "Waiting for $DEVICE to finish booting…"
    while [ "$(ADB_D shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; do sleep 2; done
fi

if ! OUTPUT=$(ADB_D install -r "$APK" 2>&1); then
    echo "$OUTPUT" >&2
    case "$OUTPUT" in
    *INSTALL_FAILED_UPDATE_INCOMPATIBLE*)
        echo "The 2004Scape installed there is signed with another key. Uninstalling it would DELETE ITS SAVES unless" >&2
        echo "\"Keep app data\" is ticked: copy them out first (Files › 2004Scape), then: $ADB -s $DEVICE uninstall $PKG" >&2
        ;;
    *INSTALL_FAILED_USER_RESTRICTED* | *INSTALL_CANCELED_BY_USER*)
        echo "The phone refused the install: allow \"Install via USB\" in Developer options (Xiaomi, Oppo, Vivo) and accept the prompt." >&2
        ;;
    *INSTALL_FAILED_INSUFFICIENT_STORAGE*)
        echo "The phone is out of storage." >&2
        ;;
    esac
    exit 1
fi

# Android installs while the phone is locked; the launch waits for the unlock.
locked() { ADB_D shell dumpsys window 2>/dev/null | grep -qE 'isKeyguardShowing=true|mDreamingLockscreen=true'; }
if locked; then
    ADB_D shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
    echo "Unlock your phone to launch…"
    while locked; do sleep 2; done
fi

set -- shell am start -W -S -n "$PKG/.GameActivity"
[ -n "${VERBOSE:-}" ] && set -- "$@" --ez lostcity.verbose "$([ "$VERBOSE" = "1" ] && echo true || echo false)"
ADB_D "$@" >/dev/null
MODEL=$(ADB_D shell getprop ro.product.model | tr -d '\r')
if [ "${LOGS:-0}" = "1" ]; then
    echo "Streaming the app's log; Ctrl-C quits the app on $MODEL."
    trap 'ADB_D shell am force-stop "$PKG"; echo; exit 0' INT
    PID=""
    while [ -z "$PID" ]; do PID=$(ADB_D shell pidof -s "$PKG" | tr -d '\r'); [ -n "$PID" ] || sleep 1; done
    ADB_D logcat -v time --pid="$PID" LostCity:V chromium:W '*:S' || true
    exit 0
fi
echo "2004Scape is running on $MODEL."
