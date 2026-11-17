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
- for Seedsow Lullaby: a compatible Artemis launcher save with HTTP mode
  available. keep the Switch and Mac on the same network.
- for kaiHEN: a Switch SD card formatted FAT32 or exFAT.

[block console updates before testing](https://gitlab.com/a/90dns).

### direct offline ethernet

mac2jb can connect to the Switch through a dedicated Mac ethernet adapter
without a router. connect that adapter directly to the Switch dock or ethernet
adapter, then open **Offline Ethernet** on mac2jb's main screen and start the
responder. macOS asks for administrator access to add a temporary
`192.168.2.2/24` address and listen on local DNS and HTTP ports. mac2jb uses
`192.168.2.2` as the host address for this connection.

set the Switch's wired connection manually: IPv4 `192.168.2.1`, subnet mask
`255.255.255.0`, gateway and both DNS fields `192.168.2.2`, with proxy and
IPv6 off. disable automatic connection to saved Switch wi-fi networks. the
app shows when a request from the Switch reaches the Mac; a local ready check
alone does not establish that the Switch connected. this service answers the
connection check; it does not provide internet access. it cannot run alongside
DNSwitch because both use ports 53 and 80. stop the responder and choose
**Restore Mac Ethernet** when finished to remove the temporary address.

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

1. download the current macOS arm64 release ZIP, extract it and open `mac2jb.app`.
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
2. click **Jailbreak with SmileBASIC 4**, then **Open first-time setup** in the compact
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

## install kaiHEN

mac2jb places kaiHEN first, with three entry points: **Civilization VII**,
**SmileBASIC 4**, and **Seedsow Lullaby**. choose the matching button on the
main screen. **Upstream updates** checks the [kaiHEN releases](https://github.com/ouncebrew/kaihen/releases)
and other bundled components; a newer release is reported without changing the
bundled copy during an active session.

### Civilization VII

the [Civ7 kaiHEN host](https://github.com/s8n/CivSwitchFS-kaiHEN) uses the
saved CivSwitch Remote JS Loader. select **Jailbreak with Civilization VII**,
enter the Switch IPv4 address, and open the saved loader with **Load Game**.
if this is the first run, use **Open first-time setup** to send the loader
through the game's chat screen, then install its boot trigger. prepare the
kaiHEN SD files with **Write files to SD card…** or **Prepare copy folder**,
confirm that the loader is open, and choose **Jailbreak with kaiHEN**. wait
for the HEN PID and completion message before leaving the game.

developer options also offer **Install persistent kaiHEN trigger**. after
installation, later **Load Game** launches can run the FS and kaiHEN chain
without the Mac host. this semi-untethered path is experimental and not
recommended.

### SmileBASIC 4

the [kurumuz ns2jb host](https://gitlab.com/kurumuz/ns2jb) starts kaiHEN
from SmileBASIC. select **Jailbreak with SmileBASIC 4** and prepare the kaiHEN
SD files in its setup window. use **Open first-time setup** if the matching
Kurumuz bootstrap is not already saved. open SmileBASIC in Direct mode and
confirm the USB power direction. mac2jb types `LOAD`, `RUN`, `REMOVE`, and the
five-argument `V=START(...)` command. wait for the HEN PID and completion
message before leaving SmileBASIC.

### Seedsow Lullaby

select **Jailbreak with Seedsow Lullaby**. open your existing Artemis launcher save
in Seedsow Lullaby and press **Y** to enter HTTP mode. enter the Switch IPv4
address in mac2jb, confirm that HTTP mode is open, then start the jailbreak.
keep Seedsow and mac2jb open while the host runs.

after kaiHEN starts, close the entry-point game normally. hold **R** while
opening a native Switch 2 game to open hbmenu. on a fresh setup, the first
launch may save the game's policy and open the game normally; close it and
hold **R** on the next launch. kaiHEN lasts until the Switch restarts.

## advanced tools

**Console & Developer Options** contains host-only sessions, held-RPC tools,
SaveKit, CivSwitch loader controls, and research utilities. **CivHomebrew** runs
`.civapp` packages through the CivSwitch loader; its **Browse apps** catalog
defaults to [civapp-db](https://github.com/cpypwn/civapp-db) and accepts custom
sources.

## save data

after 4/4 verification with RPC held, choose **Start SaveKit** to inspect,
export, or change a game's save. close the game first. to export it, select
the title and account, choose **Back up save**, then **Open verified save
export**. keep the complete folder, including `manifest.json`.

SaveKit backs up and verifies an existing save before a write, restore, or
delete. mac2jb does not bundle game saves.

## homebrew

for a supported ns2jb host-only session with held RPC, choose MintBrew after
4/4 verification in **Console & Developer Options**. you can also attach to
an existing local held-RPC session there.

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
a GPU frame fallback.

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
put mods on the Switch SD card under `SD:/ns2jb-modloader/contents/<TITLE_ID>/romfs/`
or `SD:/ns2jb-modloader/contents/<TITLE_ID>/exefs/`, where `TITLE_ID` is the
game's 16-digit title ID. global patches can go under
`SD:/ns2jb-modloader/exefs_patches/`. choose **Install modloader** to run all
compatible mods already on the SD card in one session. if you would like to
add more mods to your SD card, choose **Write mods to SD card, then install modloader…**
and select an unpacked folder with `contents/` and/or `exefs_patches/`.
mac2jb copies the mods to the Switch SD card, verifies the files, then starts
the modloader using all compatible mods now on the card. files already there
with the same contents are skipped; files with the same path and different
contents are replaced. other mods stay in place. game files and mods are not
bundled.

wait for **READY**, then choose **Finish session** and let the host close.
close SmileBASIC or Civilization VII without restarting the Switch, then open the modded game.
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

**Upstream updates** is above the jailbreak choices. in **Console & Developer
Options**, **ns2jb host** is followed by **Additional tools**. **Host timeouts**
and **Live keyboard** appear below **Console**.

- choose pepsipu, kurumuz, Cellenseres, Astral or BermTheSequel as the host. use
  its matching saved bootstrap, or type and save one if needed. pepsipu uses the original
  nine-argument pairing command and does not support held rpc; kurumuz,
  Cellenseres, Astral and BermTheSequel support held rpc and the demo.
  kurumuz is the default and supports SaveKit and native HBLauncher alongside Cellenseres and Astral. kurumuz supports the microSD Express
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
  verify `.nx` archives. NXConvert 1.0.4 is bundled and verified before use;
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
- [Rodpad](https://github.com/Rodpad) — [SW2NES](https://github.com/Rodpad/SW2NES), the bundled CivHomebrew NES emulator.
- [THZoria](https://github.com/THZoria) and [SaoriYuki](https://github.com/THZoria/jellyfin) — the bundled CivHomebrew Jellyfin client.
- [pepsipu](https://gitlab.com/pepsipu) — [ns2jb](https://gitlab.com/pepsipu/ns2jb), the original Switch 2 exploit and filesystem research.
- [kurumuz](https://gitlab.com/kurumuz) — [ns2jb](https://gitlab.com/kurumuz/ns2jb), compatibility updates, microSD Express update support and demo support.
- [BermTheSequel](https://gitlab.com/BermTheSequel) — [ns2jb2](https://gitlab.com/BermTheSequel/ns2jb2), demo support.
- [shinyquagsire](https://github.com/shinyquagsire23) — [libusbd](https://github.com/shinyquagsire23/libusbd) and [macos_usb_gadget_poc](https://github.com/shinyquagsire23/macos_usb_gadget_poc), usb device emulation and macOS gadget-driver work.
- [duszmox](https://github.com/duszmox) — [PR #11](https://github.com/cpypwn/mac2jb/pull/11), automatic USB controller discovery through the IORegistry.
- [misshexa66](https://github.com/misshexa66) — the original [OunceCake](https://github.com/misshexa66/OunceCake), game-content export.
- [alula](https://github.com/alula) — [switch-artemis-launcher](https://github.com/alula/switch-artemis-launcher), the Seedsow and Nora save launchers and HTTP interface.
- [purple442](https://github.com/purple442) — [Seedsow Lua Editor Pro](https://github.com/purple442/seedsow-lua-editor-pro), the Lua editor project.
- [soniciso1](https://github.com/soniciso1) — [Seedsow full-game patch](https://github.com/alula/switch-artemis-launcher/pull/8), full-game save research.
- [figurophobia](https://github.com/figurophobia) — [Gravity Circuit Switch RCE](https://github.com/figurophobia/GravCirc-Switch-rce), the Gravity Circuit Lua/FTP launcher.
- [Luminger](https://github.com/Luminger) — [Balatro Switch RCE](https://github.com/Luminger/balatro-switch-rce), Lua/FTP research used by Gravity Circuit Switch RCE.
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
