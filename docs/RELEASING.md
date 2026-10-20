# Releasing 2004Scape

How a release is made and published on GitHub Releases. Releases are built on the maintainer's Mac (there is no CI),
with `scripts/release.sh`. Each release carries four apps, the chat model, their checksums and release notes:

| File | What |
|---|---|
| `2004Scape-<version>-android.apk` | Android, with the on-device chat model (about 580 MB) |
| `2004Scape-<version>-android-lite.apk` | Android, without the model (about 54 MB) |
| `2004Scape-<version>-ios.ipa` | iPhone, unsigned (a sideloading tool signs it), with the model (about 550 MB) |
| `2004Scape-<version>-ios-lite.ipa` | iPhone, unsigned, without the model (about 40 MB) |
| `bots-2004-q4km.gguf` | The chat model on its own, for building from source (about 530 MB) |
| `licenses.txt` | LICENSE and THIRD_PARTY_NOTICES.md with every licence's full text, as the apps carry it (the model's Apache License 2.0 among them) |
| `SHA256SUMS.txt` | The sha256 of every file above |
| `RELEASE_NOTES.md` | The notes the release page shows |

Sizes here and in the release notes are decimal megabytes (1 MB = 1,000,000 bytes).

The chat model is also published once as a release of its own, tagged **`model-v1`** (with `licenses.txt`): that is the
URL [models/bots-2004.json](../models/bots-2004.json) pins and `prepare-model.sh --download` fetches.

## What you need

- Everything in [BUILDING.md](BUILDING.md) for both apps, with the chat model in the cache
  (`ios/scripts/prepare-model.sh --download` once).
- The Android release key in `~/.android/2004scape/` (below). Without it `release.sh` stops rather than sign with the
  SDK's debug key (an APK signed with that could not update the installed app), and it checks every APK's
  certificate against the release key's (`RELEASE_CERT_SHA256` overrides the expected fingerprint).
- The GitHub CLI, `gh`, logged in to an account that can publish releases on the repository.

## Steps

1. **Bump the version.** Edit [VERSION](../VERSION) (`major.minor.patch`; minor and patch at most 99). Both apps take
   their version from it: Android's versionName and versionCode (major × 10000 + minor × 100 + patch, which must grow
   with every release so Android accepts the update) and the iPhone's version. Commit it.
2. **Build.** `scripts/release.sh` builds everything into `dist/<version>/` (git-ignored): both APKs, both IPAs, the
   model file, `SHA256SUMS.txt` and `RELEASE_NOTES.md` (CHANGELOG.md's section for the version, install steps, the
   checksums, the commit, the certificate fingerprint and the disclaimer). It refuses a tree with uncommitted changes
   (`--allow-dirty` makes a test build, which `--upload` never uploads) and a cached model that is not the one
   `models/bots-2004.json` pins. `--skip-ios` and `--skip-android` make a partial build for testing. Every file in
   `dist/<version>/`, the notes and checksums included, is then searched as it is and unpacked (the apps, and the zips
   inside them) for a builder's local paths and ids (home folders, temporary folders, every `user.email` in git's
   config, the signing team from `TEAM` or `ios/Config/Local.xcconfig`, iPhone device ids, and any extra regular
   expressions in `PRIVATE_PATTERNS`, one per line); a hit fails the release. The scan does not open the game cache's
   gzip entries (`cache/main_file_cache.dat`) or the bzip2 entries of the `.jag` archives, which the engine's packer
   makes from Lost City's Content. It also checks the commits being released for the same ids (below: The public
   history) and warns when it finds them. The whole build takes about five minutes.
3. **Check.**
   - `cd dist/<version> && shasum -a 256 -c SHA256SUMS.txt`
   - `apksigner verify --print-certs 2004Scape-<version>-android.apk` (apksigner is in the SDK's build tools) shows the
     release certificate below, and the same for the lite APK.
   - Install the APK over the previous release on a phone or the emulator: it must update in place and keep the saves.
   - Sideload an IPA (README: Install on iPhone) and play for a minute.
   - Read `RELEASE_NOTES.md` and edit it if needed.
4. **Upload as a draft.** Push the commit first. `scripts/release.sh --upload` (with `--repo <owner/name>` for another
   repository than PureXYZ/2004scape-sp-mobile) uses `dist/<version>/` when it was built from this commit on a clean tree
   and its checksums hold, or builds it first; then it creates a **draft** GitHub release `v<version>` with `gh` and
   uploads the files. A commit rewritten after the build (a rebase, an amend, the squash below) is another commit, so
   `--upload` builds again, about five minutes, with new checksums and notes: check those, not the earlier build's. It
   refuses when the commits being released name a private id (The public history). The first time, it also creates
   the `model-v1` release with the model and `licenses.txt`; after that `model-v1` already exists and is left alone (the model only changes with a new tag and a new URL in `models/bots-2004.json`).
5. **Publish.** Open the drafts on GitHub, check the files and the notes, and publish them: `model-v1` first (the first
   time), because `prepare-model.sh --download` needs it public, then `v<version>`. Publishing makes the tag
   `v<version>` on GitHub if it is not there yet (`git fetch --tags` brings it here).

### The public history

Every commit pushed to GitHub publishes its author's and committer's name and email, and its message, for good: only
rewriting the history takes them out again. Publish the history with GitHub's noreply address, never a personal one:

- Commit what you push as the noreply address, for example
  `git -c user.name=PureXYZ -c user.email=13581337+PureXYZ@users.noreply.github.com commit ...` (the number is the
  account's id, from GitHub › Settings › Emails). Leave git's own `user.email` as it is: `release.sh` reads it to scan
  for it.
- A squash (`git merge --squash`) writes the squashed commits' authors, with their emails, into its message: write a
  message of your own (`git commit -m ...`) rather than keeping that one.
- Before pushing: `git log --format='%an <%ae> | %cn <%ce>'` shows only the noreply address, and `scripts/release.sh`
  prints no warning about the history.
- On GitHub, turn on Settings › Emails › **Block command line pushes that expose my email**, which refuses such a push.

### File names and Obtainium

Keep the file names exactly as above. Obtainium (README: Install on Android) tracks the repository's releases and picks
the APK by a regular expression on its name (`android\.apk$` or `android-lite\.apk$`), and the version in the release
tag (`v<version>`) is how it sees an update. Do not attach other APKs to a release.

## The Android signing key

Every APK is signed with one key, `~/.android/2004scape/release.jks`, with its passwords in
`~/.android/2004scape/keystore.properties`. Android installs an update only when it is signed with the same key as the
installed app, so this key is what lets every user update without losing their saves.

- Certificate: `CN=2004Scape`, created 2026-10-20, valid for 36,500 days.
- SHA-256 fingerprint (also in the README, so users can check their download):
  `88:47:5C:3F:C0:29:42:05:46:56:3E:CA:F8:87:21:37:B1:35:38:6A:0F:5D:53:24:0D:BE:1B:0D:AB:12:82:65`

Look after it:

- **Never put the key or its passwords in the repository**, an issue, a log or a release.
- **Back up the whole `~/.android/2004scape/` folder** somewhere safe and offline-capable: a password manager's file
  storage or an encrypted disk, ideally in two places.
- **Losing it cannot be undone.** A new key makes a different app as far as Android is concerned: every user would have
  to uninstall (deleting their saves unless they back them up or keep the app's data) before installing the next
  release, and Obtainium's updates would fail. The same goes for a leaked key: anyone with it can make an "update" that
  replaces the app.

## The iPhone builds

The IPAs are unsigned on purpose: SideStore, AltStore and Sideloadly sign an app with the installer's own Apple Account, and an
unsigned build carries no provisioning profile, team or device list from the build machine. Before publishing, check
that the app inside has no `embedded.mobileprovision` (`unzip -l <file>.ipa | grep -c embedded.mobileprovision` prints
0) and that its version is the new one.
