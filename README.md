# mac2jb

an all-in-one ns2 jailbreaking tool for Mac.

## what you need

- an apple silicon Mac with macOS 14 or newer.
- a Switch 2 on firmware 23.0.1 (earlier versions should also work), with SmileBASIC full version 4.4.9 or demo 4.4.6.
- more than 20 mib free in the game's save. keep the game on internal storage.
- a usb-c data cable. the Switch must use ethernet; the Mac may use wi-fi or
  ethernet. both devices must be on the same local network.
- the Switch's usb keyboard setting set to us english.

[block console updates before testing](https://consolemods.org/wiki/Switch:Blocking_OFW_Updates#90DNS).

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

1. extract the supplied v0.6.0 zip and open `mac2jb.app`.
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

## type and save the new bootstrap

replace your previous bootstrap when updating from an older build or changing hosts.
choose your host in developer options; changing hosts requires
typing and saving that host's matching bootstrap. see [developer options](#developer-options).

1. open SmileBASIC → make a program with an empty editor in slot 0.
2. open first time setup in mac2jb. tick the demo checkbox only for demo 4.4.6.
3. start typing and wait until it finishes. the app defaults to 10 ms per key. after it sends the second enter to confirm load, it waits 1 second for the bootstrap to load before sending run. the other command waits are 0; timing remains adjustable.
4. press x on the Switch controller to return to direct mode.
5. confirm that direct mode has an empty command prompt, then click type save command. mac2jb types the command for your selected edition and presses enter once.
6. confirm saving on the Switch. overwrite the existing file if prompted. after saving finishes, confirm saving in mac2jb.

the skip option is for a complete copy of this build's bootstrap already in slot 0.
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

## jailbreak

1. restart the Switch and open SmileBASIC → make a program → direct mode.
2. connect usb and the Switch's ethernet. connect the Mac to the same network
   by wi-fi or ethernet, then select the Mac's address for that network in mac2jb.
3. tick the demo checkbox if you use the demo; leave it off for the full version.
4. confirm the Switch is ready, then click jailbreak.
5. keep SmileBASIC focused and wait for 4/4 verification. MintBrew then launches automatically.

if verification fails at 2/4 while the Mac is on wi-fi, retry with the Mac on
ethernet. if it fails at 3/4, try a different host and save that host's matching
bootstrap before retrying.

after rpc is verified, the usb cable can be disconnected if the Switch keeps
its separate ethernet connection and the Mac stays on the same network over
wi-fi or ethernet.
keep SmileBASIC and mac2jb open for the session. switching the Switch from
ethernet to wi-fi closes the current rpc connection; v0.6.0 does not resume it.

for the demo, select either kurumuz or BermTheSequel in developer options. the
current kurumuz version also fixes the issue on consoles that installed the
update offered when first inserting a microSD Express card. on those consoles,
the update is marked `(B)` beside item 3 under system settings → support/health
& safety.

## homebrew

the standard gui jailbreak launches MintBrew automatically after held rpc is
verified. for host-only with hold rpc or an existing held rpc session, launch
MintBrew from developer options.

MintBrew combines Stremio, DOOM, Froggy Road, OunceCake, ftpd-sb, a CPU-to-GPU
probe, Hello World and a CHIP-8 test emulator. add or remove compatible gpu apps
while it is open, then refresh the list on the Switch. hold B or Minus to return
from a running app and choose another in the same held rpc session.

DOOM is a GPU POC based on PureDOOM, bundled with DOOM shareware v1.9 (Episode 1).

ftpd-sb shares SmileBASIC's `/save` and `/tmp` files with read/write access
and `/rom` with read-only access. press A in ftpd-sb to start its server, then
connect to the console IP shown on screen using anonymous, passive FTP on port
5000. ftpd-sb does not expose other games' files; use OunceCake for a selected
game's read-only FTP share.

in MintBrew's OunceCake app, press A on a game to prepare its read-only ftp
share. connect from the Mac to the address shown on the Switch when ftp is
ready. press B to close that connection and return to the game list; hold B or
Minus to return to MintBrew. the CPU-to-GPU probe is an experimental display
check and does not run arbitrary CPU application code. the CHIP-8 test emulator
runs its original moving-sprite program on the gpu: use the D-pad to move, A to
recenter, and B or Minus to return. it does not load external ROMs. its 60 Hz
timers use the verified console CPU clock through the CPU-to-GPU mailbox, with
a GPU frame fallback. console behavior still needs testing.

the MintNES and MintFTP prototypes remain in the source tree for further work.
neither is included in the v0.6.0 MintBrew app list.
IZlauncher and its Mac module adaptations also remain in source for further work;
they are not available in the v0.6.0 app.

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

## finish or retry

close any ftp connection, choose finish session and wait for cleanup.
restart the Switch before another attempt. never send remove twice in the same SmileBASIC session.
if typing stops partway through, inspect and clear the partial input before retrying.
saving the bootstrap does not preserve a live jailbreak connection.

## developer options

- choose pepsipu, kurumuz, BermTheSequel or IZMYSH as the host. type and save the selected
  host's matching bootstrap before running it. pepsipu uses the original
  nine-argument pairing command and does not support held rpc; kurumuz and
  BermTheSequel support held rpc and the demo. IZMYSH uses its NS2I bootstrap,
  port 39395 and a nine-argument pairing command; this GUI profile verifies the
  native session and closes it without exposing held rpc or homebrew controls.
  kurumuz is the default and is recommended when the
  microSD Express update is installed, identified by `(B)` beside item 3 under
  system settings → support/health & safety.
- in additional tools, run host only starts the selected host and waits for
  SmileBASIC commands. enter them manually, use the send commands over USB
  button, or connect live keyboard while the host waits. the USB button uses
  the current host's pairing command and requires the driver. checking hold rpc
  after success shows homebrew directly below it; launch buttons become
  available after 4/4 verification and a held connection.
- rpc already held is also in additional tools. select the original run folder
  for a host still running on this Mac, then connect. mac2jb verifies its live
  connection before enabling homebrew. disconnecting leaves the original host
  running. remote hosts and ssh are not supported.
- live keyboard forwards keys while its capture area is focused. connect it,
  paste text into the text field and click send text to send a string at the
  configured key delay. send up to 16 kib of printable us keyboard characters,
  tabs and line breaks; each line break sends enter. no extra enter is added at the end.
  stop keyboard cancels a transfer and releases keys.
- usb & timing lets you select a controller and adjust typing delays. defaults
  are 10 ms per key, 1 second after the second load enter, and no other command waits.

## build from source

on an apple silicon Mac, install xcode command line tools, cmake and the official
node v24.22.1 macOS arm64 or universal executable, then run:

```sh
bash scripts/check.sh
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

- [pepsipu](https://gitlab.com/pepsipu) — [ns2jb](https://gitlab.com/pepsipu/ns2jb), the original Switch 2 exploit and filesystem research.
- [kurumuz](https://gitlab.com/kurumuz) — [ns2jb](https://gitlab.com/kurumuz/ns2jb), the default host with compatibility updates, microSD Express update support and demo support.
- [BermTheSequel](https://gitlab.com/BermTheSequel) — [ns2jb2](https://gitlab.com/BermTheSequel/ns2jb2), demo support.
- [shinyquagsire](https://github.com/shinyquagsire23) — [libusbd](https://github.com/shinyquagsire23/libusbd) and [macos_usb_gadget_poc](https://github.com/shinyquagsire23/macos_usb_gadget_poc), usb device emulation and macOS gadget-driver work.
- [misshexa66](https://github.com/misshexa66) — [OunceCake](https://github.com/misshexa66/OunceCake), game-content export.
- [ravensclawx](https://github.com/ravensclawx) — [HBLauncher](https://github.com/ravensclawx/HBLauncher), the SmileBASIC gpu app launcher and sdk, and [ftpd-sb](https://github.com/ravensclawx/ftpd-sb), bundled with MintBrew and the base for the MintFTP prototype.
- [niftynova](https://github.com/NiftyNova) — [gpubrewlauncher](https://github.com/NiftyNova/GPUBrewLauncher), the updated gpu app launcher.
- [byizmysh](https://github.com/byizmysh) — [IZ2S Platform](https://github.com/byizmysh/IZ2S-Platform), [BlitBun](https://github.com/byizmysh/BlitBun), [VacooTube](https://github.com/byizmysh/VacooTube) and [IZDOOM](https://github.com/byizmysh/IZDOOM). mac2jb includes DOOM in MintBrew and retains the IZlauncher and Mac module adaptations in source.
- [Stremio](https://github.com/Stremio/stremio-web) — the official app icon used in MintBrew.
- [id Software](https://github.com/id-Software) — the original [Doom engine source](https://github.com/id-Software/DOOM) used by doomgeneric.
- [ozkl](https://github.com/ozkl) — [doomgeneric](https://github.com/ozkl/doomgeneric), the Doom-compatible engine in the BlitBun Mac adaptation source.
- [Freedoom contributors](https://freedoom.github.io/) — [Freedoom: Phase 1](https://github.com/freedoom/freedoom), free game data retained with the BlitBun Mac adaptation source.
- [Khronos Group](https://github.com/KhronosGroup) — [glslang](https://github.com/KhronosGroup/glslang) and [SPIRV-Tools](https://github.com/KhronosGroup/SPIRV-Tools), shader compilation and validation.
- [Electron](https://www.electronjs.org/) — the Mac runtime referenced by the VacooTube adaptation source.

see the bundled notices, licenses and upstream documentation for attribution and reuse terms.
