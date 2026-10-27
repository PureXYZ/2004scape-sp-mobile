# Online mode

2004Scape can play on a game server instead of the world on the phone: a Lost City (Engine-TS) server of revision 274
that you or a friend run, on your home network or on the internet. Online, the world, your character and the other
players are the server's; the phone draws the game and runs the same touch interface as offline. The world on the phone,
its saves and its bots stay as they are, and you can switch back at any time.

What it is good for, honestly: **playing with other people**, and **memory**: the phone no longer runs the world, so the
game takes less memory (on an iPhone an estimated 110 MB less without bots and up to about 375 MB less with 500;
measured on the simulator and the emulator below) and the bots' chat model never loads. It is **not a big battery
saving**: drawing the game is most of the work (75-80 % of the game's CPU on an iPhone 13 mini), and that stays on the
phone; the world itself costs 1-2 % of a core without bots and about 4-6 % with 500-1,000. The radio stays awake while
you play (the game talks to the server at least once a second): cheap on Wi-Fi, but on a mobile network it may cost more
than the phone saves. If battery is the goal, lower Settings › World › Bots, use Frame rate 30, or set the silent switch
to Mute.

### Measured (not on a phone)

On 2026-10-26, with the app's test run (`app-test`, BUILDING.md) on the iOS simulator (an iPhone 13 mini on a Mac) and
the Android emulator (the Medium Phone AVD, API 37), against Lost City's server on the same Mac. A simulator's and an
emulator's memory and times are the Mac's, not a phone's: compare the rows with each other, not with a phone.

| | This phone, 500 bots | This phone, no bots | Online |
|---|---|---|---|
| Web view's process in game: iOS simulator (WebContent footprint) | 408-414 MB | 362 MB | 105-114 MB |
| Web view's process in game: Android emulator (the renderer's PSS) | 402-416 MB | 342 MB | 220-280 MB |
| The title, after the page starts loading: iOS simulator | 1.3 s | 0.7-0.8 s | 0.9-1.1 s |
| The title, after the page starts loading: Android emulator | 2.3-2.7 s | 1.5-2.0 s | 1.7-2.1 s |

The app itself (outside the web view) is the same either way (Android: about 115 MB), except that offline it may load
the bots' chat model (about 500 MB while it is loaded). Starting up gains little: without bots the phone's world is
ready as soon as the client is, while online the app first asks the server for its file list; against 500 bots online
starts a few tenths of a second sooner.

The game's own messages, in Draynor's bank with its bankers and no other player, both apps alike: about **0.2 KB a
minute sent and 1.2-1.3 KB received** standing, and **0.5 KB sent and 1.4 KB received** walking, in 320-370 messages a
minute. Each message also carries the network's own headers (the WebSocket's, TCP's and IP's, and on `https://` the
encryption's), which outweigh such small messages: estimated from the message counts, about 20-40 KB a minute in all, or
1-2.5 MB an hour. A crowd costs more: every player and NPC in view is described as it moves.

## Playing on a server

- **The World button** under the title's box shows where you play ("This phone" or the server's name). It opens the
  worlds: This phone (offline) first, then your servers, then **Add server**. A tap on a world plays there: the game restarts in
  that world. Settings › World › Play on › **Change** opens the same list in game.
- **Add server** asks for an **Address** (`192.168.1.20`, `my-mac.local:8888`, `https://scape.example.com`) and an
  optional **Name**. The app then checks the address and says what it found: "Ready: a members world, world 1.", or
  what failed (nothing answered, not a 2004Scape server, …). **Use** plays there now, **Save** keeps it for later,
  **Cancel** forgets it. Each server has **Edit** (another address or name, checked again) and **Delete** (it asks
  first; the server's accounts, any passwords kept for them and its downloaded game files go from the phone). Edit the
  server you play on and tap **Use**, and the game loads again there: the way back when the server's computer got a new
  address. When an edit gives a server another address and passwords are kept for it, the app asks whether it is the
  same server: **Forget** them if it is another one ("Continue as" would send them there).
- **Switching** saves the world on the phone first (as Restart does). Online and in the world, the game logs you out
  first, as the Logout tab does: closing the app instead would leave your character in that world for up to a minute,
  and logging in again meanwhile says "Your account is already logged in." A character in combat cannot log out for a
  few seconds: try again then. While the connection is lost (the game is trying to reconnect) the switch goes ahead
  without a logout.
- **Logging in**: online the password is the server's to check. A server without its login server (Lost City's
  default) takes any password and makes a new character for a new name; a server with one wants your password, and
  may need you to register on its website first. The keyboard bar has a **Remember** box for the password: ticked,
  the password is kept in the iPhone's Keychain (on Android encrypted on the phone, with a key in the Android Keystore)
  after the login works, and **Continue as** logs in with one tap next time. If the server no longer takes the kept
  password (it was changed there), type the new one on the same form: it is kept in place of the old. It is never kept
  anywhere else, and only the names are in the app's settings. On the iPhone a kept password whose server is no longer
  in the list (after the app was deleted and installed again) is removed when the app starts. **Accounts** lists the names you played on this server (a key mark where a
  password is kept), with Log in, Forget password and Remove.
- **What is the same**: the whole touch interface, staying logged in while the app is open, Tap options, the camera and
  minimap zoom, the large options menu, tap-to-drop, Space to continue. **What differs**: Report abuse is back in the
  chat bar (there are other players to report); there is no Save now (the server saves you); Settings › World's world
  settings (World type, XP rate, Jmod, Bots) and Settings › Bot chat and Saved data are for the world on the phone, so
  they are hidden online (Detail stays, and applies the next time the game loads); the loader says "online". When you leave the app the connection soon drops, and the server
  logs your character out about half a minute later (a minute at most); back sooner, the game reconnects by itself.
- **If the server cannot be reached**, or refuses the game, a box says so within a few seconds, in plain words, with
  **Try again**, **Play offline** and **Choose world**. A server that takes the connection and then never answers the
  login (a server whose login part did not start) gets the same box after the game's own 30-second wait.

## Running a server

The server is Lost City's own: [github.com/LostCityRS/Server](https://github.com/LostCityRS/Server).

1. Install [Node.js 24 or later](https://nodejs.org/) (an up-to-date 24.x: with 24.3 the server's worker threads, its
   login among them, did not start in our tests) and Git, download the Server repository and run its start script
   (`start.sh`, or `start.bat` on Windows). Pick revision **274** when it asks, then **Start Server**. Wait for "World
   ready".
2. Its web port is **80** on macOS and Windows and **8888** on Linux (the game, its files and the socket all use that
   one port). The settings are in `engine/data/config/world.json` (or the setup page on the management port, 8898).
3. Find the computer's address on your network: on a Mac, System Settings › Wi-Fi › Details › IP Address (or
   `ipconfig getifaddr en0` in Terminal), on Windows `ipconfig`, on Linux `hostname -I`. A Mac's own name also works on
   most home networks: System Settings › General › Sharing shows it as "Local hostname" (`my-mac.local`).
4. In the app: World › Add server, the address with the port when it is not 80 (`192.168.1.20` on a Mac or Windows,
   `192.168.1.20:8888` on Linux). The phone must be on the same Wi-Fi. The iPhone asks once to find devices on the
   local network, during the first Add server of a local address: allow it, and the check goes on by itself (it waits
   up to 30 seconds for your answer). If you said no, the app says the phone did not reach your local network: allow
   it in Settings › Privacy & Security › Local Network. Android 17 may ask the
   same when the server is on your network ("local network" in the app's words): allow it, then try again (Settings ›
   Apps › 2004Scape › Permissions, if you said no).

### Over the internet

Engine-TS speaks plain HTTP and WebSocket, unencrypted. On the internet put a TLS reverse proxy in front of it and add
the `https://` address in the app; for example [Caddy](https://caddyserver.com/), which gets a certificate by itself and
passes WebSockets through:

```
scape.example.com {
    reverse_proxy 127.0.0.1:80
}
```

The app trusts the certificates the phone trusts: a self-signed certificate is not supported (the check says the secure
connection failed). A plain `http://` server
on the internet works, but everything goes unencrypted, the login too.

### A public server: before anyone else connects

- Set **`node.debug` to `false`** in `world.json`. Debug mode (the default) serves the server's `data/` folder (its
  private login key and the players' saves) and takes `PUT /content/…` writes from anyone; it also turns the AFK
  logout off.
- **Firewall the management port, 8898.** Its setup page changes the server's settings with no password.
- Set `node.production` to `true`: login rate limits, and players are normal players (without it every character logs
  in as staff, with the `::` commands).
- Run a login server (`login.enabled`, with its database) so that passwords are checked: without one any password logs
  in to any name.

### A server with its own login key or other game data

- A server whose login key is not the Engine-TS repository's (it ran `tools/server/rsa.ts`) puts its key in the client
  it serves (`/client/client.js`). The app reads it from there when you add the server; a key that does not match shows
  "This server runs a different game version or key." at login. Edit the server to read it again.
- A server whose game data differs from the app's (another Lost City Content commit, its own changes) works too: the
  app downloads the archives and the models, maps, animations and music that differ, checks them and keeps them for
  next time (iOS: the app's Caches folder; Android: its cache folder; Delete removes them). What cannot differ is the
  game's protocol: the server must be Engine-TS revision 274, which the app's client speaks.

## Lost City's official worlds

They are not supported, and the app has no list or link for them. Their client is a private, obfuscated build with
another login key, another login packet and other opcodes, so this app's client cannot speak to them; their game hosts
also accept the game's connection only from their own web pages. Their rules forbid modified third-party clients (and
defeating the AFK logout, which "stay logged in" does), so playing there with this app would risk the account. The app
does not refuse any address you type: that choice is yours, but expect the box that says the connection was refused.

## How it works

The page never touches the network: native code does, for the one server the page load plays on.

- **The socket bridge.** Online the page's `window.WebSocket` is `NativeSocket` (host.js): each socket is opened by
  native code (iOS `URLSessionWebSocketTask`, Android OkHttp) to the server's socket URL (`ws://`/`wss://`, subprotocol
  `binary`, no `Origin`), and messages go both ways in base64. The client's reconnect after a dropped connection is its
  own (login opcode 18).
- **The proxy.** Native answers `/crc` and the 8 archives the client asks for: the bundled archive when its name (its
  CRC) is the server's, else a cached copy, else the server's own, checked against its CRC and cached. It also probes an
  address for Add server (`/server-probe`: `/crc`, the world settings in `/rs2.cgi`, the login key in
  `/client/client.js`).
- **The client** (patch 0030) encrypts the login with the server's key when it has its own; patch 0031 turns a login
  the server never answers into "Error connecting to server." instead of a client that stops. **LocalOnDemand** checks
  the bundled models, maps, animations and music against the server's versionlist; a file of another version comes
  from the app's cache of the server's files, else over a second socket with the OnDemand protocol of Lost City's own
  client, and is stored for next time. The world map stays the bundled one.
- **The page** (host.js) boots online without the engine (no world, no bots, no chat model), keeps the server list,
  the accounts and the Remember choices in the settings (never a password), and switches worlds by reloading.

The contracts between the page and native code are in [ARCHITECTURE.md](ARCHITECTURE.md#72-online-mode); what Android
does differently, in [ANDROID.md](ANDROID.md). Tests, all against a Lost City server on the computer and never against
the official worlds ([BUILDING.md](BUILDING.md#online-mode)): `web/test/serve.mjs --server <url>` plays online in a
desktop browser through a stand-in for the native code (`web/test/online/native-double.mjs`); `web/test/e2e.mjs --engine
<dir>` runs the end-to-end checks against the server and its variants (passwords, its own key, full, a refused
connection, a server that is down, a server that never answers, other game data); `web/client/test/run.mjs` checks the login key and LocalOnDemand's
downloads with stub hosts; `web/test/gallery/gallery.mjs` shows every online screen at every size. In the apps,
`drive.mjs --online` checks the native layer (iOS `web/test/native/`, Android `android/test/`) and `app-test --server`
plays the whole thing in the real app on the iOS simulator and the Android emulator: add the server, log in with
Remember, play, leave the app 5 to 70 seconds, lose the web view's process, switch worlds, a server that stops, and a
server with other game data.
