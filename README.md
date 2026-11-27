# mac2jb

an all-in-one ns2 jailbreaking tool for Mac.

## what you need

- an apple silicon Mac with macOS 14 or newer. a usb-c data cable is needed for
  first-time bootstrap writing or automatic SmileBASIC command typing.
- for Civilization VII (CivSwitch): a Switch 2 on firmware 23.0.1 with a
  physical Switch 1 edition cartridge at version 1.0.0. set the system language
  to English (US), and set
  Controllers & Accessories → USB Keyboard to English (US). the Switch and Mac
  must be on the same network so mac2jb can reach the console's IPv4 address.
- for Seedsow Lullaby: a compatible Artemis launcher save with HTTP mode
  available. keep the Switch and Mac on the same network.
- for SmileBASIC 4 (ns2jb): a Switch 2 on firmware 23.0.1
  with SmileBASIC full version 4.4.9 or demo 4.4.6. keep the game on internal
  storage with more than 20 mib free in its save. the Switch must use ethernet;
  the Mac may use wi-fi or ethernet. set the Switch's usb keyboard to English (US).
- for kaiHEN: a Switch SD card formatted FAT32 or exFAT.

[block console updates before testing](https://gitlab.com/a/90dns).

## get the app

download the macOS arm64 ZIP from the [latest release](https://github.com/cpypwn/mac2jb/releases/latest),
extract it, and open `mac2jb.app`. if macOS blocks it, open system settings →
privacy & security and choose **Open Anyway** if offered, then reopen the app.

## direct offline ethernet

mac2jb can connect to the Switch directly by ethernet without a router. any
compatible Mac ethernet adapter works. connect it to the Switch dock or
ethernet adapter, then choose **Offline Ethernet** from the Mac connection menu
and select **Start offline Ethernet**. if the adapter or wired link is missing,
the setup window identifies the problem; connect it and refresh the adapter list.
macOS asks for administrator access to add a temporary
`192.168.2.2/24` address and listen on local DNS and HTTP ports. mac2jb uses
`192.168.2.2` as the host address for this connection.

set the Switch's wired connection manually: IPv4 `192.168.2.1`, subnet mask
`255.255.255.0`, gateway and both DNS fields `192.168.2.2`, with proxy and
IPv6 off. disable automatic connection to saved Switch wi-fi networks. the
app shows when a request from the Switch reaches the Mac; a local ready check
alone does not establish that the Switch connected. this service answers the
connection check; it does not provide internet access. mac2jb restores a
recorded previous session before starting Offline Ethernet again. use the
Offline Ethernet settings to stop and restore it manually when finished.

## install kaiHEN

mac2jb places kaiHEN first, with three entry points: **Civilization VII**,
**Seedsow Lullaby**, and **SmileBASIC 4**. choose the matching button on the
main screen under **kaiHEN installer**. **Upstream updates** checks the [kaiHEN releases](https://github.com/ouncebrew/kaihen/releases)
and other bundled components.

### Civilization VII

the [Civ7 kaiHEN host](https://github.com/s8n/civ7-fs-kaihen) uses the
saved CivSwitch Remote JS Loader. select **Jailbreak with CivSwitch** under Civilization VII,
enter the Switch IPv4 address, and open the saved loader with **Load Game**.
if this is the first run, use **Open first-time setup**. before sending the loader
through the game's chat screen, switch the on-screen keyboard to english (qwerty),
without a pinyin/ime candidate bar. then install its boot trigger. leave an SD card
in the Switch; the host transfers kaiHEN files after FS succeeds. confirm that
the loader is open, and choose **Jailbreak with CivSwitch**. wait
for the HEN PID and completion message before leaving the game.

the **Semi-untethered · experimental** option in the Civilization VII setup
window installs a persistent kaiHEN trigger. later **Load Game** launches can
run without the Mac host. its kaiHEN files must already be on the SD card;
the standard Civilization VII jailbreak can place them there first.

### Seedsow Lullaby

select **Jailbreak with Seedsow FS** under Seedsow Lullaby. open your existing Artemis launcher save
in Seedsow Lullaby and press **Y** to enter HTTP mode. enter the Switch IPv4
address in mac2jb, confirm that HTTP mode is open, then select **Jailbreak with Seedsow FS**.
the host transfers kaiHEN files to the inserted SD card after FS succeeds.
keep Seedsow and mac2jb open while the host runs.

the **Semi-untethered · experimental** option in the Seedsow setup window uses
the [Seedsow uploader](https://gitlab.com/rushinz/seedsow-semi-untethered).
it requires an existing Artemis save in HTTP mode and kaiHEN files on the SD card.
back up the save before uploading.
uploading its scripts does not verify FS escalation.

### SmileBASIC 4

the [kurumuz ns2jb host](https://gitlab.com/kurumuz/ns2jb) starts kaiHEN
from SmileBASIC. select **Jailbreak with ns2jb** under SmileBASIC 4 and leave an SD card in
the Switch; the host transfers kaiHEN files after FS succeeds. use **Open first-time setup** if the matching
Kurumuz bootstrap is not already saved. open SmileBASIC in Direct mode and
confirm the USB power direction. with the USB driver loaded, mac2jb types
`LOAD`, `RUN`, `REMOVE`, and the five-argument `V=START(...)` command. without
the driver, enter these commands manually. wait for the HEN PID and completion
message before leaving SmileBASIC.

### after kaiHEN starts

close the entry-point game normally. hold **R** while
opening a native Switch 2 game to open hbmenu. on a fresh setup, the first
launch may save the game's policy and open the game normally; close it and
hold **R** on the next launch. kaiHEN lasts until the Switch restarts.

## first-time bootstrap writing (optional)

only install the USB driver when mac2jb must type a Civilization VII or
SmileBASIC bootstrap over USB. running an existing CivSwitch loader or the
Seedsow HTTP path does not require it. SmileBASIC Direct mode commands can also
be entered manually without the driver.

the bundled driver is unsigned. Mac startup security and sip must permit unsigned
kernel extensions. if the driver already works with your partial/custom sip
configuration, keep that setup.

### 1. configure macOS recovery

1. shut down the Mac.
2. hold the power button until loading startup options appears.
3. select options → continue. authenticate with an administrator account if asked.
4. open utilities → startup security utility. select your startup disk and click security policy.
5. select reduced security.
6. tick allow user management of kernel extensions from identified developers.
7. confirm the changes, authenticate if asked, then close startup security utility.
8. open utilities → terminal and enter:

   ```sh
   csrutil disable
   ```

9. follow the confirmation and administrator prompts, then choose apple menu → restart.
10. back in macOS, open terminal and enter:

    ```sh
    csrutil status
    ```

    for this route, confirm it reports `System Integrity Protection status: disabled.`
    an existing working partial/custom configuration can report a different status.

### 2. install and load the usb driver

1. open the first-time bootstrap setup and click **Install & load driver…**. approve the administrator prompt.
2. if prompted, open system settings → privacy & security and allow the driver.
3. accept the restart prompt or choose apple menu → restart.
4. reopen mac2jb and wait for the driver check. continue when the driver is loaded and no driver-install restart is pending.

refresh driver status to check it; each reinstall creates a new restart requirement.
disabling sip reduces macOS protection. mac2jb does not change these settings.
fully re-enabling sip with this unsigned driver has not been verified and may
stop it working after a kernel-collection rebuild. see
[apple's startup-security guidance](https://support.apple.com/en-euro/guide/mac-help/mchl768f7291/27/mac/27)
and [sip documentation](https://developer.apple.com/documentation/security/disabling-and-enabling-system-integrity-protection).

### 3. check usb power direction

a loaded driver does not confirm that the cable is connected correctly.
the Switch should supply power to the Mac; the Mac should not charge the Switch.
if power is flowing the wrong way, unplug the usb-c cable from the Switch,
wait about 1 second, then plug it back into the Switch. check that the Switch
is now supplying power to the Mac.

## type and save the ns2jb bootstrap

a matching saved bootstrap can be reused. pepsipu uses a nine-argument
program. kurumuz and BermTheSequel use their own five-argument programs, so keep each host's saved copy separate. if the matching program is already saved under the selected host's name,
use the normal jailbreak setup. otherwise, choose the host in developer options
and follow these steps.

1. open SmileBASIC → make a program with an empty editor in slot 0.
2. click **Jailbreak with ns2jb** under SmileBASIC 4, then **Open first-time setup** in the compact
   card at the top of the popup. tick the demo checkbox on the first-time page
   only when using the SmileBASIC demo with a host that supports it.
3. start typing and wait until it finishes. the app defaults to 10 ms per key. after it sends the second enter to confirm load, it waits 1 second for the bootstrap to load before sending run. the other command waits are 0; timing remains adjustable.
4. press x on the Switch controller to return to direct mode.
5. confirm that direct mode has an empty command prompt, then click type save command. mac2jb types the command for your selected edition and presses enter once.
6. confirm saving on the Switch. overwrite the existing file if prompted. after saving finishes, confirm saving in mac2jb.

**Skip typing** is for a complete matching bootstrap already in slot 0 that
still needs saving. if the matching file is already saved, use **Use saved
bootstrap** on the setup page to skip both typing and saving.
the commands below remain available if you prefer to save manually.

### full version

save with:

```basic
SAVE "NS2"
```

mac2jb loads it with `LOAD "TXT:NS2"` and accepts its confirmation.

### demo version

save every line in slot 0 with this command:

```basic
PRGEDIT 0:C$="":FOR I=0 TO PRGSIZE(0)-1:C$=C$+PRGGET$() :NEXT:SAVEV "TXT:NS2",C$
```

the closed `PRGGET$()` call reads one line and advances to the next, so the loop
is needed to collect the entire bootstrap. see the [SmileBASIC reference](https://sup4.smilebasic.com/en/doku.php?id=reference%3ASource_Code_Operation).

with the demo box ticked, mac2jb loads it using:

```basic
PRGEDIT 0:LOADV "TXT:NS2" OUT C$:PRGSET C$
```

mac2jb types this command and presses enter twice to accept ok, then waits
1 second for the bootstrap to load before sending run.

## build from source

on an apple silicon Mac, install xcode command line tools, cmake and the official
node v24.22.1 macOS arm64 or universal executable, then run:

```sh
bash scripts/check.sh
make
make gui
build/mac2jb.app/Contents/MacOS/mac2jb --self-test
```

this uses the existing build workflow and produces `build/mac2jb.app`, including
its offline runtime and source archive. if node is elsewhere, set `NODE_BINARY`
to its absolute executable path. the build prepares pinned homebrew dependencies
when needed. the self-test checks the packaged runtime without sending console
commands. the full macOS fixture and node check list is in
[the build workflow](https://github.com/cpypwn/mac2jb/blob/main/.github/workflows/build.yml).

## help and source

use the console and session logs to investigate failures.
for support, join the [StonedCold Discord server](https://discord.gg/Sy6QUkR5t).

## credits

- [ouncebrew](https://github.com/ouncebrew/kaihen) — kaiHEN.
- [Gezine](https://github.com/Gezine/CivSwitch) and s8n's [Civ7 host](https://github.com/s8n/civ7-fs-kaihen) and [CivSwitchFS-kaiHEN](https://github.com/s8n/CivSwitchFS-kaiHEN) — the Civilization VII entry point and kaiHEN paths.
- [pepsipu](https://gitlab.com/pepsipu/ns2jb), [kurumuz](https://gitlab.com/kurumuz/ns2jb), and [BermTheSequel](https://gitlab.com/BermTheSequel/ns2jb2) — the SmileBASIC hosts.
- [Malev0](https://github.com/Malev0/seedsow-fs-kaihen) — the Seedsow kaiHEN path.
- [shinyquagsire](https://github.com/shinyquagsire23/libusbd) — macOS USB gadget support.
- [dougchansan](https://github.com/dougchansan/ns2-savekit) — SaveKit.

see the bundled notices, licenses and upstream documentation for attribution and reuse terms.
