# Install 2004Scape on iPhone

> **What you need:** an iPhone (or iPad) with **iOS or iPadOS 18.4 or newer**, a **Mac or Windows PC**, a cable that
> connects the iPhone to the computer (the one that came with the phone works if it fits the computer's port; a cheap
> charge-only cable won't), and an **Apple Account** (formerly called Apple ID: the email you use for the App Store).
> About 30 minutes the first time.

## Why this takes more steps than Android

2004Scape is not on the App Store. Apple only lets an iPhone run apps from outside the App Store (this is called
"sideloading") if they are **signed**: stamped with an Apple Account, so the phone knows who installed them. Apple lets
anyone do this with their own free Apple Account, as if they were a developer testing their own app. The catch: **an
app signed this way stops opening after 7 days** until you sign it again ("refresh" it). Refreshing takes a minute and
**keeps your saves**.

A free program on your computer, **Sideloadly**, does the signing for you.

- [1. Check your iPhone](#1-check-your-iphone)
- [2. Pick a file: full or lite](#2-pick-a-file-full-or-lite)
- [3. Set up Sideloadly on your computer](#3-set-up-sideloadly-on-your-computer)
- [4. Which Apple Account to use](#4-which-apple-account-to-use)
- [5. Install 2004Scape](#5-install-2004scape)
- [6. Allow the app on your iPhone](#6-allow-the-app-on-your-iphone)
- [Every 7 days: refresh](#every-7-days-refresh), [Updating](#updating), [Backing up your saves](#backing-up-your-saves)
- [Is my Apple Account safe?](#is-my-apple-account-safe)
- More: [Troubleshooting](#troubleshooting), [Stuck?](#stuck), [Other tools: AltStore and SideStore](#other-tools-altstore-and-sidestore)

## 1. Check your iPhone

1. Open **Settings** › **General** › **About** and look at **iOS Version**. It must be **18.4** or higher. If it is
   lower, update in **Settings** › **General** › **Software Update**. iOS 18 runs on iPhone XR, XS, SE (2nd generation)
   and newer; an older iPhone can't run 2004Scape.
2. The iPhone needs a passcode (**Settings** › **Face ID & Passcode**, or **Touch ID & Passcode**): iOS asks for it
   during setup.
3. It also needs free space (**Settings** › **General** › **iPhone Storage**): about **1 GB** for the full app,
   **100 MB** for the lite app.

## 2. Pick a file: full or lite

On your **computer**, open the [download page](https://github.com/PureXYZ/2004scape-sp-mobile/releases/latest). You
don't need to sign in to GitHub. Scroll down to **Assets** and download **one** file:

| The file ending in | Size | Pick it if |
|---|---|---|
| **ios.ipa** (for example **2004Scape-1.0.0-ios.ipa**) | about 550 MB | You want the full app. The computer players ("bots") can answer you in their own words, using a small chat program that runs on the phone. |
| **ios-lite.ipa** (for example **2004Scape-1.0.0-ios-lite.ipa**) | about 40 MB | Your iPhone is short on space. Everything else is the same: the bots are there and chat with their own ready-made lines. |

An **IPA** is an iPhone app in a single file. **Not sure?** With space to spare, take the full app. You can switch
between full and lite later the same way you refresh: your saves stay.

Ignore everything else on the page: the `.apk` files (for Android), the `.gguf` and `.txt` files, and **Source code**.

## 3. Set up Sideloadly on your computer

### On a Mac

1. Go to [sideloadly.io](https://sideloadly.io) and click **Download for macOS**.
2. Open the downloaded file and drag **Sideloadly** into **Applications**.
3. Open **Sideloadly** from Applications. If the Mac asks whether you're sure you want to open an app from the
   internet, click **Open**.
4. If it says Sideloadly "cannot be opened because the developer cannot be verified", open **System Settings** ›
   **Privacy & Security**, scroll down, click **Open Anyway** next to Sideloadly, and enter your Mac password.

You don't need Sideloadly's Mail plug-in (an old, optional extra).

### On Windows

Sideloadly needs Apple's iTunes and iCloud, in the versions from the web, **not** the Microsoft Store. Apple's newer
Microsoft Store apps also get in the way: with them installed, iTunes stops handling iPhones.

1. Open **Settings** › **Apps** › **Installed apps** (Windows 10: **Apps & features**). If you see **iTunes**,
   **iCloud**, **Apple Devices**, **Apple Music** or **Apple TV**, uninstall them. You'll install the right versions
   next.
2. On [sideloadly.io](https://sideloadly.io), click **Web iTunes 64-bit** and install it. Then click **Web iCloud** and
   install it. If iCloud asks you to sign in, you can close it: Sideloadly only needs it installed. (Ignore the 32-bit
   link. Almost every PC is 64-bit, and every Windows 11 PC is.)
3. Download Sideloadly for **Windows** from the same page and install it. If Windows shows "Windows protected your PC",
   click **More info** › **Run anyway**.
4. Restart the computer.

## 4. Which Apple Account to use

Sideloadly needs you to sign in with an Apple Account. It says it sends your password only to Apple
([Sideloadly's privacy policy](https://sideloadly.io/privacy)).

- **Simplest:** use the one you already have.
- **Extra peace of mind:** make a free spare one just for this ([how](https://support.apple.com/en-us/108647)). It
  doesn't need to be the account signed in on your iPhone.

Whichever you pick, **use the same one every time**. With a different account, your iPhone gets a second, empty copy of
the game, without your saves.

## 5. Install 2004Scape

1. Connect the iPhone to the computer with the cable. Unlock the iPhone.
2. On the iPhone, **Trust This Computer?** appears. Tap **Trust** and enter your passcode.
3. **Mac:** if the Mac asks **Allow accessory to connect?**, click **Allow**.\
   **Windows:** open **iTunes** once. If it asks to access the iPhone, allow it, and tap **Trust** on the iPhone again
   if asked. You can close iTunes afterwards.
4. Open **Sideloadly**. Your iPhone appears in the **iDevice** box.
5. Open your **Downloads** folder (Finder on a Mac, File Explorer on Windows). Drag the 2004Scape file you downloaded
   (on Windows it may show as just **2004Scape-1.0.0-ios**, without .ipa) onto the **IPA** icon at the top left of
   Sideloadly.
6. Type your Apple Account email in the **Apple account** box. Leave everything else as it is.
7. Click **Start**.
8. Type your Apple Account **password** (your normal one; why? see [Is my Apple Account safe?](#is-my-apple-account-safe)).
   Apple then checks it's really you: your other iPhone, iPad or Mac may show a sign-in notification, maybe with a map.
   The place on the map can be wrong; that's normal. Tap **Allow**, and type the 6-digit code it shows into Sideloadly.
   With no other Apple device, the code comes by text message. Apple may also email you that your account was used to
   sign in. That was you.
9. Sideloadly shows a scrolling log while it works. Don't unplug the iPhone. Wait until Sideloadly says it's finished
   (the full app takes a few minutes). A 2004Scape icon then appears on the iPhone's Home Screen or in the App Library.

2004Scape is now on your iPhone, but it won't open yet.

## 6. Allow the app on your iPhone

You do this once.

**Turn on Developer Mode** (it lets the iPhone run apps you installed yourself):

1. Tap the **2004Scape** icon. iOS says Developer Mode is required. Close the message.
2. Open **Settings** › **Privacy & Security**. Scroll to the bottom and tap **Developer Mode**.
3. Turn it on. Tap **Restart**.
4. After the restart, unlock the iPhone. Tap **Turn On** and enter your passcode.

iOS may warn that Developer Mode lowers the iPhone's security. It's needed for any app you install yourself. It doesn't
install anything or change your data, and you can turn it off again in the same place (2004Scape then stops opening
until you turn it back on).

**Trust your Apple Account** (it tells the iPhone you signed this app yourself):

1. If you tap 2004Scape now, iOS says **Untrusted Developer**. Tap **Cancel**.
2. Open **Settings** › **General** › **VPN & Device Management**.
3. Under **Developer App**, tap your Apple Account email.
4. Tap **Trust "Apple Development: …"**, then **Trust**. (On some iOS versions it says **Allow & Restart** and asks
   for your passcode.)

**Play:**

1. Open **2004Scape** and hold the iPhone sideways. The game only plays in landscape.
2. Tap **New User**. Type a name of up to 12 letters, numbers or spaces.
3. The screen also asks for a **password**, as it did in 2004. Leave it empty and tap **Log in** on the keyboard.
   Nothing is checked: there is no account, and everything stays on your phone.
4. Your new character starts on Tutorial Island. Next time, tap **Continue as** (your name). The
   [README](../README.md#playing) explains the touch controls.

## Every 7 days: refresh

**Tip:** set a repeating reminder on your phone for every 6 days, starting today.

After 7 days 2004Scape stops opening (it closes right away). **Your saves are still there.** To fix it, or before it
happens:

1. Connect the iPhone to the computer and open **Sideloadly**.
2. Drag the same `.ipa` onto the IPA icon (or a newer one, see [Updating](#updating)).
3. Use the **same Apple Account** as before. Click **Start**.

**Do not delete the app first.** Sideloadly installs over it, and your characters stay.

**Automatic refresh (optional):** Sideloadly installs a small background helper with it, and automatic refreshing is
on by default. The helper refreshes 2004Scape before the 7 days are up, but only while the computer is on and the
iPhone is plugged in, or awake and on the same Wi-Fi. For Wi-Fi: plug the iPhone in once, then in **Finder** (Mac)
tick **Show this iPhone when on Wi-Fi**, or in **iTunes** (Windows) tick **Sync with this iPhone over Wi-Fi**. If the
computer is often off, keep the reminder. More in [Sideloadly's FAQ](https://sideloadly.io/faq).

## Updating

Install the newer `.ipa` exactly like a refresh: same Apple Account, without deleting the app. Your saves are kept.

## Backing up your saves

**Deleting 2004Scape deletes your saves.** Back them up before anything risky: switching Apple Account or tool,
deleting the app, or resetting the phone.

1. Close 2004Scape completely (swipe it away in the app switcher).
2. Open the **Files** app › **Browse** › **On My iPhone** (**On My iPad** on an iPad) › **2004Scape**.
3. The **players** folder holds your characters (inside **players** › **main**, one file per character, like
   **zezima.sav**). The **bots** folder holds the computer players' world. Touch and hold each folder, tap **Copy**,
   and paste it into **iCloud Drive** or another place.

**To restore:** close the game, delete the **players** folder in **2004Scape**, and copy your saved one in its place
(the same for **bots**).

**Undo the last save:** every save keeps the previous version beside it, ending in `.bak`. Close the game, open
**players** › **main**, delete **zezima.sav**, then rename **zezima.sav.bak** to **zezima.sav**.

## Is my Apple Account safe?

Sideloadly needs your Apple Account password because Apple's signing service makes you sign in. Sideloadly says it
sends your login only to Apple ([privacy policy](https://sideloadly.io/privacy)). Only download Sideloadly from
[sideloadly.io](https://sideloadly.io). Want more peace of mind? Use a spare Apple Account (see
[Which Apple Account to use](#4-which-apple-account-to-use)).

## Troubleshooting

**2004Scape won't open, or opens and closes at once.** Most likely the 7 days are up:
[refresh it](#every-7-days-refresh). Your saves are safe; don't delete the app. If you only just installed it, check
that you did both parts of [step 6](#6-allow-the-app-on-your-iphone): Developer Mode on, and your Apple Account
trusted.

**Sideloadly doesn't show my iPhone.** Unlock the iPhone and tap **Trust** if it asks. Try another cable or USB port.
On Windows: make sure **Apple Devices**, **Apple Music** and **Apple TV** are not installed (step 3), open iTunes with
the phone connected, and if that doesn't help, reinstall the **Web** versions of iTunes and iCloud from
[sideloadly.io](https://sideloadly.io) and restart the computer.

**"Call to np_client_new failed: NP_E_CONN_FAILED"** (Windows). iTunes is the Microsoft Store version. Uninstall it,
install **Web iTunes** from [sideloadly.io](https://sideloadly.io), then try again.

**"This device has reached the maximum number of installed apps using a free developer profile".** A free Apple
Account allows **3 apps at a time** that you installed yourself. Delete one you don't need (back up anything in it
first), then try again.

**"Your maximum App ID limit has been reached. You may create up to 10 App IDs every 7 days".** Apple counts each
different app you sign in a week. Wait a few days and try again. (Another Apple Account would not update your copy: it
installs a separate one, without your saves.)

**"Failed to obtain anisette".** A temporary problem with a login helper. Try again later, or, in Sideloadly's
**Advanced options**, choose **Local Anisette** instead of Remote Anisette and try again.

**Sideloadly asks for an app-specific password, or one doesn't work.** Use your normal Apple Account password. An
app-specific password (a special password Apple makes for other apps) does not work with a free account
([Sideloadly FAQ](https://sideloadly.io/faq)).

**"Untrusted Developer".** Do [step 6](#6-allow-the-app-on-your-iphone), "Trust your Apple Account".

**Developer Mode is missing from Settings.** It only appears after an app like 2004Scape has been installed. Install
first, then look again.

**Not enough space.** The full app needs about 1 GB free on the iPhone. Free some space, or use the lite `.ipa`.

**The phone gets warm, or the battery drains fast.** Use fewer bots: tap **⚙** (on the right side of the screen) ›
**World** › **Bots**, pick a smaller number, and tap **Restart to apply** at the top of that page. Your character is
saved first.

More answers: [Sideloadly's FAQ](https://sideloadly.io/faq).

## Stuck?

Ask on [GitHub Issues](https://github.com/PureXYZ/2004scape-sp-mobile/issues): click **New issue** (you need a free
GitHub account). Say which iPhone and iOS version you have, which computer, which tool and file, and the exact error
message. Take a screenshot (iPhone with Face ID: side button and volume up together; with a Home button: side or top
button and Home together) and attach it.

If you have a Mac and know your way around Xcode, you can also build the app yourself:
[BUILDING.md](BUILDING.md).

## Other tools: AltStore and SideStore

**You don't need these if Sideloadly works for you.** They're free apps that live **on your iPhone** and refresh
2004Scape for you, for people who want the iPhone to refresh the game with less help from a computer. Their setup
changes from time to time, so follow their official guides. Pick one tool and stay with it: back up your saves before
you switch.

**[AltStore](https://altstore.io) (classic):** you install **AltServer** on a Mac or Windows PC, which puts the AltStore
app on your iPhone. Then, in AltStore, the **My Apps** tab has a **+** button: pick the `.ipa` (saved in the Files app on
the iPhone). AltStore refreshes in the background while AltServer runs on a computer on the same Wi-Fi. Guides:
[Mac](https://faq.altstore.io/altstore-classic/how-to-install-altstore-macos),
[Windows](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows),
[troubleshooting](https://faq.altstore.io/altstore-classic/troubleshooting-guide). This means AltStore **Classic**, not
AltStore PAL (the EU version). AltStore says your Apple Account and password are sent only to Apple
([install guide](https://faq.altstore.io/altstore-classic/how-to-install-altstore-macos)). AltStore counts as one of
your 3 apps.

**[SideStore](https://sidestore.io):** for not needing a computer after setup. You use a computer once, with a small
program called **iloader**, to put SideStore on the iPhone. After that, SideStore installs and refreshes apps on the
iPhone itself, over Wi-Fi, with the free **LocalDevVPN** app from the App Store switched on (a VPN that stays on the
phone; SideStore needs it to install and refresh apps). It signs in through an "anisette server" (a helper that makes
the login look like it comes from a Mac); SideStore says no private data is sent to it
([FAQ](https://docs.sidestore.io/docs/faq)). SideStore counts as one of your 3 apps. Guides:
[what you need](https://docs.sidestore.io/docs/installation/prerequisites),
[install](https://docs.sidestore.io/docs/installation/install),
[common issues](https://docs.sidestore.io/docs/troubleshooting/common-issues).
