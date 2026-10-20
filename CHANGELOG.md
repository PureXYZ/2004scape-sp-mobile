# Changelog

All notable changes to 2004Scape. Versions follow `VERSION` (major.minor.patch); each one is a GitHub release `v<version>`
with an Android APK and an iPhone IPA, with and without the bots' chat model.

## [1.0.0] - 2026-10-20

The first public release: Lost City (RuneScape revision 274, as of 2004) as a single-player game that runs entirely on
the phone, on iPhone and Android. It is a derived work of Lost City (Engine-TS, Client-TS, Content) and of
2004sp-progressive's bot AI, and most of its own code was generated with Claude (Anthropic) through Claude Code.

- **The whole game, offline.** The Engine-TS game server runs inside the app next to the Client-TS web client: no
  server, no account, no network. Type any name to make a character (no password), and **Continue as <name>** brings
  it back with one tap. Saves stay on the phone and can be copied out with the Files app.
- **A mobile interface in the 2004 look.** Full-screen landscape world with the round minimap, orbs, the 13 classic tabs
  on stone slabs and sliding panels; taps, hold for the options menu, drag to turn the camera, pinch to zoom; a native
  keyboard bridge with chips for amounts and commands; tap-to-drop; the action label beside your finger. The original
  765×503 **Classic** layout is one setting away.
- **Bots.** Up to 1,000 other players (500 by default) run by the AI of 2004sp-progressive: they train, bank, sell at
  Varrock West, fight, PK in the Wilderness, come and go in sessions, add you as a friend and answer when you talk to
  them. Their world and progress are saved between launches.
- **Bot chat.** Bots answer in their own words with a small on-device language model (Qwen3.5 0.8B trained on
  2004-style chat; offline, in the full builds), with the built-in rules, or with Claude online using your own API key.
- **World settings.** Members, XP rate (1× to 50×), Jmod (developer commands on or off) and bots online, applied by
  a restart. Also **Tap options** for Attack and **Saved data** (delete a character, reset the world), which apply at once.
- **World map.** The 2004 world map with its key, overview and underground views.
- **About.** Settings › About shows the version and build, the disclaimer, the credits and the licences of everything
  the app is made from (LICENSE, THIRD_PARTY_NOTICES.md).
- **Builds.** Android 11+ (arm64) APKs signed with the 2004Scape key; unsigned iPhone IPAs (iOS 18.4+) for SideStore,
  AltStore or Sideloadly; each in a full (with the chat model) and a lite (without) variant.
