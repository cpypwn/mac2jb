# mac2jb

an all-in-one ns2 jailbreaking tool for Mac.

## what you need

- an apple silicon Mac with macOS 14 or newer and a usb-c data cable.
- for ns2jb: a Switch 2 on firmware 23.0.1 (earlier versions should also work),
  with SmileBASIC full version 4.4.9 or demo 4.4.6. keep the game on internal
  storage with more than 20 mib free in its save. the Switch must use ethernet;
  the Mac may use wi-fi or ethernet. set the Switch's usb keyboard to us english.
- for CivSwitch: a physical Switch 1 edition Civilization VII cartridge at
  version 1.0.0. set the Switch system language to English (US). the Switch and
  Mac must be on the same network so mac2jb can reach the console's IPv4 address.

[block console updates before testing](https://gitlab.com/a/90dns).

## set up the usb driver

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

1. download `mac2jb-v0.8.0-macos-arm64.zip`, extract it and open `mac2jb.app`.
2. if macOS blocks the app, open system settings → privacy & security and choose open anyway if offered, then reopen the app.
3. click install & load driver… and approve the administrator prompt.
4. if prompted, open system settings → privacy & security and allow the driver.
5. accept the restart prompt or choose apple menu → restart.
6. reopen mac2jb and wait for the driver check. continue when the driver is loaded and no driver-install restart is pending.

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
program. kurumuz and Cellenseres share the same five-argument program.
BermTheSequel uses a different five-argument copy with an extra check, so keep its own saved
copy. if the matching program is already saved under the selected host's name,
use the normal jailbreak setup. otherwise, choose the host in developer options
and follow these steps.

1. open SmileBASIC → make a program with an empty editor in slot 0.
2. click **Jailbreak with ns2jb**, then **Open first-time setup** in the compact
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

## jailbreak with ns2jb

1. restart the Switch and open SmileBASIC → make a program → direct mode.
2. connect usb and the Switch's ethernet. connect the Mac to the same network
   by wi-fi or ethernet, then select the Mac's address for that network in mac2jb.
3. click **Jailbreak with ns2jb**. in the setup popup, tick the demo checkbox
   if you use the demo, or leave it off for the full version.
4. confirm the Switch is ready and connected by usb, then click **Start jailbreak**.
5. keep SmileBASIC focused and wait for 4/4 verification. the default kurumuz
   host holds rpc open and offers MintBrew, SaveKit, and Artemis launcher saves
   or native HBLauncher. launch
   one homebrew at a time while rpc is held.

if verification fails at 2/4 while the Mac is on wi-fi, retry with the Mac on
ethernet. if it fails at 3/4, try a different host and save that host's matching
bootstrap before retrying.

after rpc is verified, the usb cable can be disconnected if the Switch keeps
its separate ethernet connection and the Mac stays on the same network over
wi-fi or ethernet.
keep SmileBASIC and mac2jb open for the session. retained rpc keeps the same
network connection open; switching the Switch from ethernet to wi-fi closes it.
this build does not reconnect that session.

## jailbreak with CivSwitch

[CivSwitch](https://github.com/Gezine/CivSwitch) uses Civilization VII's chat
entry point. upstream supports the physical Switch 1 edition cartridge at
version 1.0.0 and reports tests on Switch 2 firmware 20.4.0 and 23.0.1.

if the boot trigger is already saved, open Civilization VII and choose
**Load Game**. once the loader says **Awaiting payload**, click
**Jailbreak with CivSwitch** in mac2jb, enter the Switch IPv4 address, select
the Mac network address on the main screen and click **Start jailbreak**. keep the Switch and Mac
on the same network. this returning-user path does not type the chat payload
again or need USB input.

for first-time setup, choose the keyboard transfer option in CivSwitch setup:

1. load the mac2jb USB driver. set the Switch system language to English (US),
   insert the supported cartridge, and keep the Switch and Mac on the same
   network.
2. in Civilization VII, open multiplayer → wireless → create game → host lobby
   → chat. in docked mode, focus the chat input. connect the Switch to the Mac
   by USB with power flowing Switch → Mac.
3. choose **Open first-time setup**, enter the Switch IPv4 address and confirm
   the chat screen is ready, then start the keyboard transfer. the full-screen
   progress view tracks the 87-line chat payload, which currently takes about
   20–25 minutes. keep the game and mac2jb open. mac2jb then checks the
   JavaScript loader on TCP port 9026 and returns to CivSwitch setup.
4. click **Install boot trigger** to back up Civilization VII's single-player
   saves and install the persistent Load Game trigger. this replaces files in
   `save:/saves/Single/`; verified originals are kept under
   `~/Library/Application Support/mac2jb/CivSwitch/Backups`.
5. restart Civilization VII and choose **Load Game** for later sessions.

to use the JavaScript loader without starting filesystem acquisition,
**Connect to open loader** attaches to an existing session. after verification,
**Send JavaScript…** sends a `.js` file directly to port 9026. **Install boot
trigger** also works on that connection after backing up the game's
single-player saves.

**Open CivHomebrew** sends its pinned v0.4.3 launcher through a verified
CivSwitch loader. **Connect to running CivHomebrew** in the CivHomebrew card
attaches to its companion when the launcher was started from a saved
boot trigger. **Install CivHomebrew boot trigger** verifies and keeps the
original trigger backup before replacing it; **Restore original CivSwitch
trigger** puts that backup back. both actions need the open loader. source is
downloaded and checked when first used.
**Install Moonlight** adds the pinned v0.1.3 app to a running CivHomebrew
launcher. **Open Moonlight** starts it from the Mac; Sunshine must run on the
streaming computer, which may be another computer on the same network. the
Moonlight package is downloaded and verified when installed. these paths need
console testing in mac2jb.

the ordinary CivSwitch loader is separate from ns2jb's held rpc session.
MintBrew and native HBLauncher still require ns2jb. CivSwitch filesystem access
can start a separate held host for save installers, SaveKit and OunceCake.

### CivSwitch fs access

this path has reached 4/4 verification on a Switch. it uses the physical
Civilization VII cartridge and the open CivSwitch JavaScript loader described
above. keep the Switch and Mac on the same network.

1. select the Mac network address on the main screen and enter the Switch IPv4
   address in CivSwitch setup. open the
   saved CivSwitch loader in Civilization VII, then choose **Start jailbreak**.
   mac2jb waits for and verifies the loader, then sends the FS bridge once.
2. wait for 4/4 verification. each step can take several minutes. keep
   Civilization VII and mac2jb open; the progress page shows the current step,
   and its console log is in **Console & Developer Options**.
3. after verification, mac2jb opens the held-session choices automatically.
   use the save installers, SaveKit or OunceCake. test a read-only
   title list or backup before writing a save.
4. finish the session when done. restart Civilization VII before another
   loader session.

this Mac-side path does not change the saved trigger. restore the original
CivSwitch trigger first if CivHomebrew's saved trigger is installed. if
acquisition fails, keep its run logs and restart the console before another
FS attempt. MintBrew and native HBLauncher are not available through the
CivSwitch filesystem host. the CivSwitch ns2jb-modloader port is experimental.

## bundled game saves

create a normal save, close the game, and complete a jailbreak with rpc held.
choose the matching installer in mac2jb and select the save's console account if
prompted. mac2jb verifies the bundled files, backs up the original save when
present, and verifies each write. installation can replace game progress and
settings. the backup remains available in the app. once the write finishes,
you can choose another held-rpc option; finish the session before opening the
game.

| game | bundled save | what it opens |
| --- | --- | --- |
| Seedsow Lullaby, Nora Princess 2, Nora, Princess and Stray Cat HD, Hamidashi Creative | [Artemis launcher v2](https://github.com/alula/switch-artemis-launcher/releases/tag/v2) | an HTTP Lua launcher on port `8080`; load its save and press Y to start the server. Seedsow supports its demo and full game, with separate installers. |
| Seedsow Lullaby demo | [Lua Editor Pro v0.4.0](https://github.com/purple442/seedsow-lua-editor-pro/releases/tag/v0.4.0) | bundles the Artemis launcher with the Lua editor and its script slots. it does not support the full game. |
| Balatro | [RCE v1.1.0](https://github.com/Luminger/balatro-switch-rce/releases/tag/v1.1.0) | a Lua service on port `9026` and FTP on ports `5000` and `5001`. it requires the physical Switch 1 cartridge in compatibility mode. |
| Gravity Circuit | [Switch RCE](https://github.com/figurophobia/GravCirc-Switch-rce) | the same Lua and FTP services as Balatro. supported game versions are 1.0.0 and 1.2.1. |

for an Artemis save, use **Console & Developer Options → Artemis launcher HTTP**
to connect to the Switch's IPv4 address on the same network. its controls can
send Lua to `/eval`, upload files to `save:/`, and delete selected save files.
these HTTP controls do not need a held SmileBASIC rpc session. **Check for
upstream update** reports newer releases without changing the bundled saves.

the **Seedsow FS · experimental** control is in **Console &
Developer Options**. first open a Seedsow Lullaby launcher save on the Switch
and leave its HTTP server running. enter the Switch IPv4 address, then start
the filesystem attempt. mac2jb sends the bridge through `/eval`; it does not
install or replace the save. this path has not yet passed a console test.
the current bridge supports Seedsow Lullaby only, not Nora or other Artemis
games.

## save data and research tools

after a regular jailbreak with kurumuz, Cellenseres or Astral, **Start SaveKit** opens
the full set of save actions in the held session: account, title and archive
lists; inspection and verified backups; and the experimental write, restore,
delete and verify controls. the bundled research source catalog is available
there too. the same controls are available under **Console & Developer Options →
Additional tools** after a host-only run with **Hold RPC after success** checked
and 4/4 verification complete.
list installed titles from internal storage, SD and game card. **List save archives**
reads the console's save index, including saves for games that are no longer
installed; select an archive there to fill its title, account and archive fields.
the installed-title picker shows names when available. enter a title ID manually
if needed. read-only backups work for any selected title.
each write, delete or restore backs up an existing save and verifies it before
changing files. repeated save opens
can interrupt the host; if rpc is lost, restart the Switch and start a fresh
session.

archive filters and an optional all-archive scan are available for titles with more than one save. the game
being inspected must be fully closed.

to collect an untouched save, select its title and account, then click
**Back up save** and **Open verified save export**. for archives outside the
normal account save, use **Scan all matching archives** before backing up.
retain the complete export folder, including `manifest.json`. the Nora
Princess 2 trial title ID is `010012900D38A000` if it is absent from the
installed list. this read-only step does not install a Lua payload.

the SaveKit panel can compare a live save with an export, write a folder of flat
save files, or delete one root file for any selected title with an accessible
save archive. it can also restore a verified mac2jb export to the selected
title's Account or Device archive at rank 0 and index 0. restore replaces files
in the export and keeps other live files. every write, delete or restore
requires confirmation and a verified backup when a current save exists.
large files are verified in chunks after writing. the separate **SaveKit
research sources** catalog keeps the previous research utilities and adds the current
upstream save and Artemis tools. it provides source paths and syntax checks;
utilities with hardware or local path requirements are run manually after review.

for the demo, select Cellenseres, kurumuz or BermTheSequel in developer options. the
current kurumuz version also fixes the issue on consoles that installed the
update offered when first inserting a microSD Express card. on those consoles,
the update is marked `(B)` beside item 3 under system settings → support/health
& safety.

## homebrew

when ns2jb reaches 4/4 and holds rpc, choose MintBrew on the next screen. for
host-only with hold rpc or an existing held rpc session, launch MintBrew from
developer options.

to try a different standalone launcher while rpc stays held, click **Stop
current homebrew** and wait until mac2jb confirms that it stopped cleanly.
then choose another homebrew from the same panel. this switch is experimental;
if cleanup or rpc verification fails, restart the Switch and begin a new
session. inside MintBrew, use B or Minus to return from an app to its list.

MintBrew combines Stremio, Froggy Road, OunceCake, ftpd-sb, a CPU-to-GPU
probe, Hello World and a CHIP-8 test emulator. add or remove compatible gpu apps
while it is open, then refresh the list on the Switch. hold B or Minus to return
from a running app and choose another in the same held rpc session.

ftpd-sb shares SmileBASIC's `/save` and `/tmp` files with read/write access
and `/rom` with read-only access. press A in ftpd-sb to start its server, then
connect to the console IP shown on screen using anonymous, passive FTP on port
5000. ftpd-sb does not expose other games' files; use OunceCake for a selected
game's read-only WebDAV share.

in MintBrew's OunceCake app, press A on a game to share its files. the Switch
shows both the HTTP/WebDAV address and the read-only FTP address for an
anonymous, passive FTP client on this Mac. the root WebDAV page offers **Download
all as ZIP on this Mac**
when the game's file count permits it; WebDAV and FTP remain available for
larger games. keep mac2jb open while transferring files. press B to close the
share and return to the game list; hold B or Minus to return to MintBrew.

OunceCake is also available directly from the post-jailbreak or developer
held-rpc homebrew choices. enter the Switch's IPv4 address, choose WebDAV or
FTP on this Mac, then select a game. mac2jb displays the address to use. the
FTP address uses `127.0.0.1` and works on the Mac running mac2jb.

the CPU-to-GPU probe is an experimental display
check and does not run arbitrary CPU application code. the CHIP-8 test emulator
runs its original moving-sprite program on the gpu: use the D-pad to move, A to
recenter, and B or Minus to return. it does not load external ROMs. its 60 Hz
timers use the verified console CPU clock through the CPU-to-GPU mailbox, with
a GPU frame fallback. console behavior still needs testing.

the earlier GPU MintNES and MintFTP prototypes remain in the source tree.
neither is included in the MintBrew app list. a separate native MintNES test
app is included with HBLauncher.
HBLauncher is a separate native ABI 3 choice after a fresh Cellenseres or
kurumuz held rpc session. this release includes its Hello CPU and GPU Triangle sample apps,
plus MintNES. MintNES runs its NES CPU and graphics emulation on the Switch CPU
and displays the result through HBLauncher's renderer. it includes the
open-source Diamond Chase ROM. place supported `.nes` files in
`/sd/roms/nes` on the Switch SD card, or enter another folder under `/sd/` in
mac2jb's SD ROM folder field. mac2jb reads those files through held rpc before
HBLauncher starts and adds them to MintNES's ROM list without changing the SD
card. for Mac ROMs, click **open MintNES ROM folder** and add `.nes` files there.
the bundled ROM remains available if the SD folder is absent. press X in the
MintNES ROM list to refresh Mac ROMs added or removed during this session.
MintNES currently supports mapper 0 ROMs with 16 or 32 KB PRG and CHR ROM or
RAM. MintNES presses NES Start once after a short loading delay unless you
press Plus first. Plus sends NES Start, X sends Select, A/B are NES A/B, and
the D-pad or left stick moves. press Minus once during a game to return to the ROM
list; hold Minus to return to HBLauncher. the native audio path is attempted
and falls back to silent play if the console rejects it.
choose HBLauncher before starting MintBrew or another app, then use its app
library on the Switch. you can open the native apps folder in mac2jb and add
compatible built ABI 3 packages before launching it. the current MintBrew GPU
session keeps its own display resources alive, so native apps cannot yet be
opened from MintBrew's menu in the same session.

the [Animal Crossing](https://github.com/ravensclawx/AnimalCrossing-HBLauncher)
and [Twilight Princess](https://github.com/ravensclawx/TwilightPrincess-HBLauncher)
ports need their own built packages, the HBLauncher Linux personality runtime,
user-supplied GameCube game data and a local file server. neither game is
bundled or verified in this Mac release.

Stremio runs from MintBrew and requires Stremio installed on the Mac. leave the
manual add-on field empty to use account add-ons.

Stremio sends larger video and menu frames through a dedicated tcp receiver in
the existing held session. small frames that fit one rpc write keep the existing
path. audio and session control still use rpc. keep the Mac and Switch on the
same network; the receiver stops if a complete frame cannot be confirmed.
use the d-pad to move through the playback controls and audio/subtitle options;
move the left stick left or right to seek while the playback controls are open.
while browsing, L/R switches the top tabs. resume reuses the last selected source
for that video when it is still available; a new movie or episode opens source
selection. use the Switch's volume controls for playback volume.

for extra launcher apps, click open apps folder below MintBrew and copy the
complete compatible app folder into its app folder during the held rpc session.
add or remove app folders while the launcher is open, then refresh its app list
on the Switch.
keep your originals elsewhere; each new session has a fresh app library.

**Custom homebrew** is an experimental developer choice under **Hold RPC after
success** for a built GPU app, native HBLauncher ABI 3 app, launcher folder or
supported RPC package in the current held session. choose the built folder after 4/4
verification. native apps require kurumuz, Cellenseres or Astral. an
OunceCake-compatible WebDAV package also needs the Switch's IPv4 address. launch formats are validated before
transfer; an unsupported folder is rejected while RPC remains held.

## modloader

with a microSD card inserted and ns2jb or CivSwitch holding a verified 4/4 RPC session,
choose **Modloader** and select a folder on the Mac containing `contents/`
and, optionally, `exefs_patches/`. put RomFS or ExeFS files under
`contents/<TITLE_ID>/romfs/` or `contents/<TITLE_ID>/exefs/`, where `TITLE_ID`
is the game's 16-digit title ID. a folder copied from an Atmosphere mod layout
works if those paths are preserved. mac2jb checks the layout, uploads the
selected files to a session folder on the Switch SD card, verifies them, then
installs the mods through held rpc. game files and mods are not bundled.

wait for **READY**, then choose **Finish session** and let the host close.
close SmileBASIC or Civilization VII without restarting the Switch, then open the modded game.
the CivSwitch port is experimental and still needs a console mod install test.
the installed overlay lasts until the console reboots. modloader uses this
session as its final action; choose it before another homebrew app. it supports
RomFS and ExeFS replacements, IPS patches and `.pchtxt` patches. runtime
cheats need a separate runtime. see [ns2jb-modloader](https://github.com/SebaaMG/ns2jb-modloader)
for the complete mod layout and compatibility notes.

## finish or retry

close any FTP or WebDAV connection, choose finish session and wait for cleanup.
restart the Switch before another attempt. never send remove twice in the same SmileBASIC session.
if typing stops partway through, inspect and clear the partial input before retrying.
saving the bootstrap does not preserve a live jailbreak connection.

## developer options

- choose pepsipu, kurumuz, Cellenseres, Astral or BermTheSequel as the host. use
  its matching saved bootstrap, or type and save one if needed. pepsipu uses the original
  nine-argument pairing command and does not support held rpc; kurumuz,
  Cellenseres, Astral and BermTheSequel support held rpc and the demo.
  kurumuz is the default and supports SaveKit, Artemis save installation
  and native HBLauncher alongside Cellenseres and Astral. kurumuz supports the microSD Express
  update identified by `(B)` beside item 3 under system settings →
  support/health & safety.
- in additional tools, run host only starts the selected host and waits for
  SmileBASIC commands. enter them manually, use the send commands over USB
  button, or connect live keyboard while the host waits. the USB button uses
  the current host's pairing command and requires the driver. checking hold rpc
  after success shows homebrew directly below it; launch buttons become
  available after 4/4 verification and a held connection.
- rpc already held is also in additional tools. click **Find open RPC** to search
  for verified local sessions and connect when one is found. if several are
  open, choose one; you can also select a `switch2-*` run folder manually.
  mac2jb verifies the live connection before enabling homebrew. disconnecting
  leaves the original host running. remote hosts and ssh are not supported.
- live keyboard forwards keys while its capture area is focused. connect it,
  paste text into the text field and click send text to send a string at the
  configured key delay. send up to 16 kib of printable us keyboard characters,
  tabs and line breaks; each line break sends enter. no extra enter is added at the end.
  stop keyboard cancels a transfer and releases keys.
- usb & timing lets you select a controller and adjust typing delays. defaults
  are 10 ms per key, 1 second after the second load enter, and no other command waits.
- switch browser research offers mac2jb's seven local diagnostics for runtime,
  media, network, boundaries, fonts and WebKit behavior, plus the included
  [Jmesmykil research scripts](https://github.com/Jmesmykil/switch2-captive-portal-research).
  choose either included source or a local folder in developer options, then
  start its page. mac2jb copies included scripts to Application Support and
  stores reports there. use the page URL with DNSwitch and run the Switch
  connection test. if the portal stays open, tap cpypwn to load the probe.
  portal entry is experimental and may loop or fail to open.
  stop DNSwitch and restore the Switch's DNS settings when finished. this panel
  is separate from jailbreak and rpc; desktop checks do not
  establish that a probe works on Switch hardware.
- NSP-Box packages an already-extracted ExeFS/RomFS game or DLC snapshot into
  an NSP on this Mac. its Windows emulator patch is not included. the tool is
  under developer options and never reads a retail encrypted game or console
  key.
- NXFormat converts an already-decrypted game folder or `.nup` into a verified
  `.nx` archive on this Mac. its developer panel can also inspect, list and
  verify `.nx` archives. NXConvert 1.0.2 is bundled and verified before use;
  it works offline and does not need rpc.
- NUP can pack an extracted game dump into a compressed `.nup` file, inspect
  and verify a NUP, list its files, or extract it. click **Get pinned NUP source**
  in developer options first; mac2jb fetches that revision from upstream and
  checks its hash before running it locally. the bundled zstandard dependency
  provides compression. neither tool needs an rpc session.

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
[the build workflow](.github/workflows/build.yml).

## help and source

use the console and session logs to investigate failures.
for support, join the [StonedCold Discord server](https://discord.gg/Sy6QUkR5t).

## credits

- [Gezine](https://github.com/Gezine) — [CivSwitch](https://github.com/Gezine/CivSwitch), the Civilization VII chat entry point, payload and USB macro adapted for the Mac flow.
- [XITRIX](https://github.com/XITRIX) — [CivHomebrew](https://github.com/XITRIX/CivHomebrew) and [Moonlight-CivSwitch](https://github.com/XITRIX/Moonlight-CivSwitch), the CivSwitch launcher and Sunshine client fetched on request.
- [pepsipu](https://gitlab.com/pepsipu) — [ns2jb](https://gitlab.com/pepsipu/ns2jb), the original Switch 2 exploit and filesystem research.
- [kurumuz](https://gitlab.com/kurumuz) — [ns2jb](https://gitlab.com/kurumuz/ns2jb), compatibility updates, microSD Express update support and demo support.
- [BermTheSequel](https://gitlab.com/BermTheSequel) — [ns2jb2](https://gitlab.com/BermTheSequel/ns2jb2), demo support.
- [shinyquagsire](https://github.com/shinyquagsire23) — [libusbd](https://github.com/shinyquagsire23/libusbd) and [macos_usb_gadget_poc](https://github.com/shinyquagsire23/macos_usb_gadget_poc), usb device emulation and macOS gadget-driver work.
- [duszmox](https://github.com/duszmox) — [PR #11](https://github.com/cpypwn/mac2jb/pull/11), automatic USB controller discovery through the IORegistry.
- [misshexa66](https://github.com/misshexa66) — the original [OunceCake](https://github.com/misshexa66/OunceCake), game-content export.
- [alula](https://github.com/alula) — [switch-artemis-launcher](https://github.com/alula/switch-artemis-launcher), the Seedsow and Nora save launchers and HTTP interface.
- [purple442](https://github.com/purple442) — [Seedsow Lua Editor Pro](https://github.com/purple442/seedsow-lua-editor-pro), the bundled v0.4.0 demo save.
- [soniciso1](https://github.com/soniciso1) — [Seedsow full-game patch](https://github.com/alula/switch-artemis-launcher/pull/8), adapted for a verified SaveKit backup.
- [figurophobia](https://github.com/figurophobia) — [Gravity Circuit Switch RCE](https://github.com/figurophobia/GravCirc-Switch-rce), the bundled Gravity Circuit save and Lua/FTP launcher.
- [Luminger](https://github.com/Luminger) — [Balatro Switch RCE](https://github.com/Luminger/balatro-switch-rce), the Balatro save and native Lua/FTP research used by Gravity Circuit Switch RCE.
- [smarkyie](https://github.com/smarkyie) — [NSP-Box](https://github.com/smarkyie/NSP-Box), the extracted-snapshot packager adapted for Mac.
- [fab918](https://github.com/fab918) — [nxformat](https://github.com/fab918/nxformat), the bundled NX archive tool.
- [a55uka](https://github.com/a55uka) — [nup](https://github.com/a55uka/nup), the NUP format and reference tool fetched on request.
- [Cellenseres](https://github.com/Cellenseres) — the [ns2jb host](https://github.com/Cellenseres/ns2jb) with retained rpc and native IPC handling, and the updated [OunceCake fork](https://github.com/Cellenseres/OunceCake) for read-only HTTP and WebDAV game browsing.
- [SebaaMG](https://github.com/SebaaMG) — [ns2jb-modloader](https://github.com/SebaaMG/ns2jb-modloader), the RomFS and ExeFS loader integrated for held RPC sessions.
- [ravensclawx](https://github.com/ravensclawx) — [HBLauncher](https://github.com/ravensclawx/HBLauncher), the native app launcher and sdk, and [ftpd-sb](https://github.com/ravensclawx/ftpd-sb), bundled with MintBrew and the base for the MintFTP prototype.
- [niftynova](https://github.com/NiftyNova) — [gpubrewlauncher](https://github.com/NiftyNova/GPUBrewLauncher), the updated gpu app launcher.
- [Stremio](https://github.com/Stremio/stremio-web) — the official app icon used in MintBrew.
- [Jmesmykil](https://github.com/Jmesmykil) — [Switch 2 captive portal research scripts](https://github.com/Jmesmykil/switch2-captive-portal-research), included with permission for browser diagnostics.
- [Khronos Group](https://github.com/KhronosGroup) — [glslang](https://github.com/KhronosGroup/glslang) and [SPIRV-Tools](https://github.com/KhronosGroup/SPIRV-Tools), shader compilation and validation.
- [Northernside](https://github.com/Northernside) — [PR #9](https://github.com/cpypwn/mac2jb/pull/9), measured keystroke timing for the bootstrap ETA.

see the bundled notices, licenses and upstream documentation for attribution and reuse terms.
