# Shared by the apps' shell scripts (ios/scripts, android/scripts): the download and model cache, and portable file
# helpers. Sourced, not run:
#
#   . "$(dirname "$0")/../../scripts/lib/cache.sh"
#
# CACHE_DIR is the one cache both apps use, so a clean build/ (or a second checkout) downloads nothing again:
# LC_CACHE_DIR when set, else ~/Library/Caches/2004scape on macOS, else ${XDG_CACHE_HOME:-~/.cache}/2004scape.
#   $CACHE_DIR/downloads/   llama.cpp's release archives and the untrained spike model, each pinned by its sha256
#   $CACHE_DIR/models/      the trained chat model (models/bots-2004.json in the repo says which: size and sha256)

if [ -n "${LC_CACHE_DIR:-}" ]; then
    CACHE_DIR=$LC_CACHE_DIR
elif [ "$(uname -s)" = Darwin ]; then
    CACHE_DIR=$HOME/Library/Caches/2004scape
else
    CACHE_DIR=${XDG_CACHE_HOME:-$HOME/.cache}/2004scape
fi

# sha <file>: its sha256, lower-case hex (shasum on macOS, sha256sum on Linux)
sha() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{ print $1 }'
    else
        shasum -a 256 "$1" | awk '{ print $1 }'
    fi
}

# bytes <file>: its size
bytes() {
    wc -c < "$1" | tr -d ' '
}

# clone_file <from> <to>: an APFS clone (macOS) or a reflink (Linux) where the file system has them, else a copy
clone_file() {
    cp -c "$1" "$2" 2>/dev/null || cp --reflink=auto "$1" "$2" 2>/dev/null || cp "$1" "$2"
}

# json_field <file> <key>: a top-level string or number of a JSON file, or nothing (node is needed for the build anyway)
json_field() {
    node -e 'try { const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (v !== undefined && v !== null && typeof v !== "object") process.stdout.write(String(v)); } catch {}' "$1" "$2"
}

# no_local_paths <file or folder> <repo root>: fails (naming the files) when any file there contains the home folder or
# the repo's folder (either as given or its real path), so a model with a builder's path in its metadata is never bundled
no_local_paths() {
    set -- "$1" "$2" "$HOME" "$(cd "$HOME" 2>/dev/null && pwd -P)" "$(cd "$2" && pwd)" "$(cd "$2" && pwd -P)"
    target=$1
    shift 2
    patterns=
    for p in "$@"; do
        # (a path of one character or none would match everything)
        [ "${#p}" -gt 1 ] && patterns="$patterns$p
"
    done
    [ -n "$patterns" ] || return 0
    found=$(printf '%s' "$patterns" | LC_ALL=C grep -r -l -a -F -f - "$target" || true)
    if [ -n "$found" ]; then
        echo "$found" | sed 's/^/  names a local folder: /' >&2
        return 1
    fi
}
