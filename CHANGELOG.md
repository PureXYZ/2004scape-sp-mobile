# Changelog

All notable changes to 2004Scape. Versions follow `VERSION` (major.minor.patch); each one is a GitHub release `v<version>`
with an Android APK and an iPhone IPA, with and without the bots' chat model.

## [Unreleased]

- **Minimap zooms out further.** The minimap's zoom slider now goes out to half the 2004 zoom (it stopped at three
  quarters), showing about 32 tiles around you; the 2004 zoom is now the middle of the groove. Past the edge of the area
  the game has loaded, the map is black.
- **Camera drag is slower.** Each Camera drag choice turns the camera more slowly: the new Normal is the old Slow, Slow
  is slower still, and Fast is the old Normal. A phone that was on Slow is on Normal now, at the same speed.
- **Battery.** The phone's battery level shows small and faint in the top left corner while you play (the status bar
  is hidden): red when low, green on the charger. It steps aside for windows and the keyboard, and the game's hover
  text moves just under it.
- **Online mode.** The app can play on a Lost City (Engine-TS 274) server that you or a friend run, on your Wi-Fi or
  on the internet, instead of the world on the phone: the title's new **World** button (and Settings › World › Play on)
  chooses This phone or a server, **Add server** takes an address and checks it, and switching restarts the game in
  that world (logging out first, or saving the phone's world first). Online you log in with a name and the server's
  password; a **Remember** box in the keyboard bar keeps it in the iPhone's Keychain (on Android encrypted with the
  Keystore) for **Continue as**, and **Accounts** lists the names played there. The touch interface is the same, Report
  abuse comes back to the chat bar, and the world settings, Bot chat and Saved data, which are the phone's world's, step
  aside. A server whose game data differs from the app's works too: what differs is downloaded and kept. A server
  that cannot be reached, or takes the connection and never answers, says so in a box, with Try again, Play offline
  and Choose world. On Android 17 the app asks for the local network permission before it connects to a server on your
  network; on the iPhone, when the local network is not allowed, the app says where to allow it. Lost City's
  official worlds are not supported. It saves the phone's memory (no world, no bots, no chat model on the phone), not
  much battery: drawing stays on the phone. How to run a server: [docs/ONLINE.md](docs/ONLINE.md). The world on the
  phone plays as before.

Performance work that changes nothing a player can see or hear: the same game state and bot behaviour, the same pixels
and sound samples, 600 ms ticks, and saves that are byte for byte the same. Each change was checked against the code it
replaces, and main and this build were run side by side from the same seeds at 0, 500 and 1,000 bots. The numbers below
are from a Mac (M2), in WebKit as the iPhone runs it and in Chrome as Android's WebView does, except the audio line's
and the chat model's, from an iPhone 13 mini, and Android's frame stalls, from the Android emulator. On that iPhone the
whole phone uses about 20 % less CPU standing in the world or at the title (11 % walking), the title is up 0.8 s sooner,
and the game holds 50 to 80 MB less memory while playing. The only new text is in Settings › About's licences: libbzip2
is now used by the client and the World map too.

- **Faster start.** The client unpacks its archives with the engine's libbzip2 instead of its JavaScript decoder, the
  engine starts while the page builds its controls, and song lengths and animation timings come from a table made at
  build time instead of being worked out at every start. The title is up in about 0.56 s instead of 1.25 s (WebKit;
  Chrome 0.67 s instead of 1.42 s), and the page's peak memory while starting is about 160 MB lower.
- **Lighter drawing.** Each canvas gets only the pixels that changed since its last frame, and none when nothing moved:
  WebKit's GPU process works about 55 % less at the title and about 75 % less standing in the world, at the same frame
  rate. On Android a canvas gets its whole frame when any of its pixels changed, and none when nothing moved (only the
  changed part made the frames stall there): on the emulator a frame of 100 ms or more comes a third to three quarters
  as often as before (about half as often walking, alone or with 500 bots), at 1.5 to 3 more frames a second. The 3D
  renderer makes no garbage per frame. On Android the HUD updates right after each game frame instead of on every
  display frame.
- **Less drawing standing still.** While the camera does not move, the 3D world is drawn again only where something in
  it changed (a player or NPC moving or animating, a fire, the fountain's water), with the same pixels as when it is
  drawn whole. Standing at Varrock West with 500 bots, WebKit's web process (the page and the engine) works about 23 %
  less and the page's main thread in Chrome about 38 % less; at Lumbridge without bots 19 % and 29 % less. Walking and
  turning the camera are as before. It holds about 5 to 7 MB more memory (the last frame and what it drew). Every frame
  of the test play-throughs was checked against a full drawing of it, in WebKit and in Chrome, and a new test suite
  (`web/test/render-verify`) plays 35 scenarios for it (people and NPCs coming and going, 500 bots, doors, fires, water,
  fights, menus, every panel, other screen sizes, low detail) and compares each frame with a full drawing of it, pixel
  by pixel and in what the frame leaves behind (the options menu, where a tap walks, the water's animation): over
  400,000 frames drawn in part, in WebKit, in Chrome and as the Android app's page, and none differed.
- **Less memory.** Collision zones with nothing in them share one array, the scripts' bytecode is kept in typed arrays,
  and the music lets go of the sound it has played: the engine's heap after start is about 39 MB smaller in
  JavaScriptCore. The 30 MB of files the engine reads only to start are freed as soon as the world has started instead
  of at the engine's next full garbage collection, up to a minute or so later. The World map no longer loads four grids
  that only the 2004 applet's keys draw, keys the phone's map does not have: 9 MB less from its first opening on.
- **Audio at rest.** With Settings › Sound on Mute, the game's audio stops after 10 s with nothing playing and starts
  again with the next sound: on an iPhone 13 mini a silent stretch costs about 23 points of a core less, and a sound with
  no touch before it comes out about 7 ms later (about 40 ms after minutes of silence). Play, the default, is as before.
- **The chat model when you chat.** With the bots and the on-device chat model, the model now loads when you start
  typing (or open a private message), not each time you enter the world, and a Jmod's `::` command does not load it:
  an iPhone 13 mini keeps about 100 MB less for the 5 minutes after entering the world in a session without chat.
  Measured on that phone, no bot's reply came later (43 trials). The first load after an install or an update, the slow
  one, still starts on entering the world.
- **A cheaper world tick.** The engine's loops run without generators and skip work whose result is already there; the
  bots' route and zone searches, player lists, word filter and walking graph do the same work with less. A tick with 500
  bots takes about 21 % less time in JavaScriptCore (about 26 % in V8), with 1,000 bots about 18 % (32 %).

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
