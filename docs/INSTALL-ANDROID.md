# Install 2004Scape on Android

> **What you need:** an Android phone with **Android 11 or newer**, and about **1.2 GB free** (full app) or **150 MB
> free** (lite app). No computer, no account, about 10 minutes.

2004Scape is not on the Google Play Store. You download the app file yourself from the project's download page and open
it. Android calls this "installing an unknown app" (some people call it "sideloading"), and it shows a few warnings on
the way. This guide walks you through each one.

An **APK** is an Android app in a single file, like the ones the Play Store installs for you behind the scenes.

- [1. Check your phone](#1-check-your-phone)
- [2. Pick a file: full or lite](#2-pick-a-file-full-or-lite)
- [3. Download it](#3-download-it)
- [4. Install it](#4-install-it)
- [5. If a warning blocks the install](#5-if-a-warning-blocks-the-install)
- [6. First launch](#6-first-launch)
- [Updating](#updating), [Backing up your saves](#backing-up-your-saves), [Uninstalling](#uninstalling)
- More: [Troubleshooting](#troubleshooting), [Is my download genuine?](#is-my-download-genuine), [Stuck?](#stuck)

## 1. Check your phone

1. Open **Settings** › **About phone** (on Samsung, then **Software information**) and look for **Android version**.
   It must be **11** or higher. You can also search Settings for "Android version".
2. Check your free space: search Settings for **Storage**. You need about **1.2 GB** for the full app or **150 MB** for
   the lite one.
3. Nearly every phone from the last several years works. If yours can't run it, the install simply says
   **App not installed**, and nothing is harmed.

## 2. Pick a file: full or lite

Open the [download page](https://github.com/PureXYZ/2004scape-sp-mobile/releases/latest) on your phone. You don't need
to sign in to GitHub. Scroll down to **Assets** and tap **one** file:

| The file ending in | Size | Pick it if |
|---|---|---|
| **android.apk** (for example **2004Scape-1.0.0-android.apk**) | about 580 MB | You want the full app. The computer players ("bots") can answer you in their own words, using a small chat program that runs on the phone. |
| **android-lite.apk** (for example **2004Scape-1.0.0-android-lite.apk**) | about 54 MB | Your phone is short on space, or you are on mobile data. Everything else is the same: the bots are there and chat with their own ready-made lines. |

**Not sure?** On Wi-Fi with space to spare, take the full app; otherwise the lite one. You can switch later: installing
one over the other keeps your saves.

Ignore everything else on the page: the `.ipa` files (for iPhone), the `.gguf` and `.txt` files, and **Source code**.

## 3. Download it

1. Tap the file name. Use Wi-Fi for the full app.
2. Your browser (Chrome, Samsung Internet or another) may warn that this type of file can harm your phone. It says this
   for every app file from a website. Choose to download it anyway.
3. Wait for the download to finish. The full app takes a few minutes.

## 4. Install it

> **Samsung phone?** Do this first: open **Settings** › **Security and privacy** › **Auto Blocker** and turn it
> **off**. Turn it back on after the install (the game keeps working). Other phones: skip this.

1. When the download finishes, tap **Open** in the browser, or tap the download in your notifications. Later, you'll
   find the file in **Downloads**: in Samsung's **My Files** app, the **Files** app on other phones, or your browser's
   menu › **Downloads**.
2. The first time, Android says your phone isn't allowed to install unknown apps from this source. Tap **Settings**.
3. Turn on **Allow from this source**. Android warns that unknown apps can harm your phone; it says this for every app
   from outside the Play Store. It only lets this browser (or file app) install apps, and you can turn it off again
   afterwards.
4. Tap the back arrow. Android asks **Do you want to install this app?** Tap **Install**. The full app can take a
   minute or two.
5. Google Play Protect may check the app first (next section). When it is done, tap **Open**, or find **2004Scape** in
   your app list.

## 5. If a warning blocks the install

These are normal for an app from outside the Play Store. 2004Scape needs no special permissions, but Google has not
seen it installed by many people, so it asks.

### Google Play Protect

Play Protect is the virus check built into Android phones with Google Play. Leave it on. You may see one of these:

- **"App scan recommended"**: "Play Protect hasn't seen this app before…". Tap **Scan app**. When the scan finishes,
  tap **Install**.
- **"Send app for security check"**: Google asks to see the app. **Don't send** is fine (sending the full app uses a lot
  of data).
- **"Unsafe app blocked"**: Google shows this for apps it hasn't seen many people install. It doesn't mean it found
  anything. Tap **More details**, then **Install anyway**, and confirm with your fingerprint or PIN if asked.

**Stop if** Play Protect says it **found** a problem, for example **Harmful app blocked** or a named threat. Delete the
file, download it again from the [download page](https://github.com/PureXYZ/2004scape-sp-mobile/releases/latest) only,
and if it happens again, ask on [GitHub Issues](https://github.com/PureXYZ/2004scape-sp-mobile/issues).

### Samsung phones: Auto Blocker

If a message mentions **Auto Blocker**, or **Allow from this source** is greyed out, turn Auto Blocker off as in
[step 4](#4-install-it) and try again. It is on by default on newer Galaxy phones and stops installs from outside the
Galaxy Store and Play Store. Turn it back on afterwards; do the same when you install an update.

### Xiaomi, Redmi, POCO and other brands

Some brands run their own security scan before installing. Wait for it to finish, then continue. The menu names in
step 4 can differ a little (for example **Install unknown apps** or **Trust this source**).

## 6. First launch

1. Open **2004Scape** and hold the phone sideways. The game only plays in landscape.
2. Tap **New User**. Type a name of up to 12 letters, numbers or spaces.
3. The screen also asks for a **password**, as it did in 2004. Leave it empty and tap **Log in** on the keyboard.
   Nothing is checked: there is no account, and everything stays on your phone.
4. Your new character starts on Tutorial Island. Next time, tap **Continue as** (your name). The
   [README](../README.md#playing) explains the touch controls.

The game works with no internet connection. If the phone gets warm, use fewer bots: tap **⚙** (on the right side of the
screen) › **World** › **Bots**, pick a smaller number, and tap **Restart to apply** at the top of that page. Your
character is saved first.

## Updating

1. Download the newer APK from the [download page](https://github.com/PureXYZ/2004scape-sp-mobile/releases/latest).
2. Open it and tap **Update** (or **Install**).

That's all. **Your saves are kept.** Do not uninstall first.

- Android only accepts an update signed by the same developer. Every release from the download page is, so it just
  works.
- You can't go back to an older version over a newer one. (Uninstalling to do that deletes your saves unless you back
  them up first.)
- If you move from lite to full, the bots keep using their ready-made lines until you choose
  ⚙ › **Bot chat** › **On-device**.

**For confident users: automatic updates.** [Obtainium](https://github.com/ImranR98/Obtainium) can watch for new
releases and install them for you. Add the app with the URL `https://github.com/PureXYZ/2004scape-sp-mobile`. When it
asks which file, choose the one ending in **android.apk** or **android-lite.apk**.

## Backing up your saves

Your characters are saved on the phone while you play. Two kinds of backup:

**Automatic:** if your phone's backup to your Google account is on, Android includes 2004Scape's saves and settings. On
a new phone, install 2004Scape again from the download page; Android then brings back the saves from your Google backup.
The backup runs about once a day, so for your very latest progress, also copy the folders by hand.

**By hand:** first close 2004Scape completely (swipe it away in the app switcher). Then you need Android's own file
browser, the one with a **☰** side menu that lists **2004Scape**:

- On many phones (Pixel, for example) it's the **Files** app: tap **☰** and choose **2004Scape**.
- On Samsung it has no icon (Samsung's **My Files** app doesn't show 2004Scape), but you can reach it through Google
  Drive: open **Drive**, tap **+** › **Upload**, tap **☰**, and choose **2004Scape**.

The **players** folder holds your characters (inside **players** › **main**, one file per character, like
**zezima.sav**). The **bots** folder holds the computer players' world. Copy them to Google Drive, a computer or a
memory card.

**To restore** (in the Files app): close the game, delete the **players** folder that is there now, and copy your saved
one in its place.

**Undo the last save:** every save keeps the previous version beside it, ending in `.bak`. Close the game, open
**players** › **main**, delete **zezima.sav**, then rename **zezima.sav.bak** to **zezima.sav**.

## Uninstalling

1. Back up your saves first if you might come back.
2. Open **Settings** › **Apps** (then **See all apps** if 2004Scape isn't listed) › **2004Scape** › **Uninstall**.
3. Android may offer to **keep app data** (the wording depends on the phone). Tick it if you plan to reinstall: your
   characters will be there when you install 2004Scape again.

## Troubleshooting

**"App not installed"** has a few causes:

- **Not enough space.** Free up space and try again. The full app needs about 1.2 GB during the install (the download
  plus the installed copy). Afterwards you can delete the downloaded file from **Downloads**.
- **Another copy is installed that was signed differently** (for example one you built yourself, or got somewhere other
  than the download page). The message may say the package "conflicts with an existing package". Back up your saves,
  uninstall the other copy, install again, and copy your saves back.
- **You are installing an older version over a newer one.** Get the newest release instead.
- **The phone is 32-bit, or older than Android 11.** 2004Scape can't run on it.
- **The download is broken.** Delete it and download it again.

**"Allow from this source" is greyed out.** On Samsung, turn off Auto Blocker first ([step 4](#4-install-it)). On a work
or school phone, your organisation may block it.

**The app opens with "Android System WebView is too old".** 2004Scape runs inside Android System WebView, the part of
Android that shows web pages inside apps. It needs version 122 or newer. Tap **Update** in that message, or update
[Android System WebView](https://play.google.com/store/apps/details?id=com.google.android.webview) in the Play Store,
then open 2004Scape again.

**The phone gets warm, or the battery drains fast.** Use fewer bots: tap **⚙** › **World** › **Bots**, pick a smaller
number, and tap **Restart to apply** at the top of that page.

## Is my download genuine?

If you downloaded it from the [download page](https://github.com/PureXYZ/2004scape-sp-mobile/releases/latest), yes:
that's the only official place. Android also makes sure every update comes from the same developer as the copy you
have.

For technical readers: each file's SHA-256 is shown on the release page and in `SHA256SUMS.txt`. The APKs are signed
with the project's key; `apksigner verify --print-certs <file>.apk` (Android SDK build tools) prints its certificate
digest in lowercase without colons:

```
Signer #1 certificate SHA-256 digest: 88475c3fc029420546563ecaf8872137b135386a0f5d53240dbe1b0dab128265
```

The same fingerprint with colons: `88:47:5C:3F:C0:29:42:05:46:56:3E:CA:F8:87:21:37:B1:35:38:6A:0F:5D:53:24:0D:BE:1B:0D:AB:12:82:65`.

## Stuck?

Ask on [GitHub Issues](https://github.com/PureXYZ/2004scape-sp-mobile/issues): tap **New issue** (you need a free GitHub
account). Say which phone you have, its Android version, which file you downloaded, and the exact message you see.
Take a screenshot (on most phones, press the power and volume-down buttons together) and attach it.

## Good to know: Google's 2027 changes

**You don't need to do anything now.** Google plans extra checks for apps from outside the Play Store from 2027. When
they reach this app, this page will explain what to do. The details, as of October 2026:

- **Today: nothing changes.** Since 30 September 2026, phones in Brazil, Indonesia, Singapore and Thailand check
  apps from **participating app stores** (such as Google Play and the Galaxy Store). An APK you download from a website,
  like this one, is not checked yet, anywhere.
- **From 2027:** Google plans to check all apps on Android phones with Google Play, worldwide. An app from a developer
  who has not registered with Google will then only install after a one-time **advanced flow**: you turn on developer
  options, confirm nobody is pressuring you, restart, **wait one day**, and confirm with your PIN or fingerprint. After
  that you can install such apps (for 7 days or for good), with a warning and an **Install Anyway** button.
- Updates are checked the same way, so this matters for updates too.

Google's details and dates may still change. Google's own words:
[Android developer verification](https://developer.android.com/developer-verification) and its
[FAQ](https://developer.android.com/developer-verification/guides/faq).
