# IZ2S Platform — FAQ and practical guide

This guide is written for someone who wants to use and maintain the platform without already knowing its internals. It describes the current **0.16.0-rc.5** implementation. A feature being described here does not mean it was physically tested on every device.

[Back to the main README](README.md)

## Contents

- [What the platform does](#what-the-platform-does)
- [Installed, running and connected](#installed-running-and-connected)
- [Installing the PC application](#installing-the-pc-application)
- [First console setup](#first-console-setup)
- [ARM board and USB keyboard](#arm-board-and-usb-keyboard)
- [Connection, network and recovery](#connection-network-and-recovery)
- [Modules and File Exchange](#modules-and-file-exchange)
- [Streaming and controllers](#streaming-and-controllers)
- [Files, folders and backups](#files-folders-and-backups)
- [Git and release work](#git-and-release-work)
- [Safe previews and installation tests](#safe-previews-and-installation-tests)
- [Troubleshooting checklist](#troubleshooting-checklist)
- [Small glossary](#small-glossary)

## What the platform does

### What are IZ2S Platform, IZlauncher, an engine and a module?

**IZ2S Platform** is the whole project. Its **panel** is the page you open on the computer. An **engine** establishes the console connection. **IZlauncher** is the menu displayed on the console after a compatible engine connects. A **module** is an application or integration opened from that menu, such as File Exchange.

Think of them as the control desk, connection method, console menu and individual applications. They have separate folders so one can be changed without putting every feature into the engine.

### Is the PC emulating Switch 2?

No console emulator is part of this platform. In streaming modules, the game or application runs on the PC, the PC prepares video/audio, and the console receives and presents it through the existing SmileBASIC session. The console also supplies supported input. Local modules can instead implement their own console interface and GPU logic. Not every module is a video stream.

### Does this load arbitrary native Switch applications?

The current console application format uses GLSL/SPIR-V and the existing qualified session services. An `.izm` is not an NRO loader, a replacement operating system or a promise of unrestricted console access. Ordinary File Exchange exposes only the storage available to the SmileBASIC title.

### What does the public release contain?

The prepared release profile includes **File Exchange** and the preinstalled **IZMYSH** engine. The pepsipu and kurumuz adapters remain available, with folders for optional downloads/manual installation. Their original server source is not bundled by default.

The test project also contains streaming, games, calculator and other experiments. An app mentioned in this guide may therefore be absent from a clean public release. Extra modules and their prerequisites must be supplied separately; the public package does not install them secretly.

## Installed, running and connected

### If an icon exists, is everything installed and running?

An icon is a shortcut. It proves neither that dependencies are installed nor that a server is currently running. The ordinary IZ2S shortcut starts/restarts the server for the copy it points to, then opens its panel. It does not install the ARM agent, type a bootstrap or start a console session on its own.

| State | What it means | How to check |
| --- | --- | --- |
| Sources prepared | Program files exist | Open the project folder |
| PC application installed | A usable copy was created by the installer | Read the installer's destination and run its `start.sh` |
| Panel/server running | The local control page can talk to its server | Open the panel; inspect its current state |
| ARM reachable | The input board can be contacted over the network | ARM/input card and SSH checks |
| USB ready | The board's keyboard link to Switch is configured | **ARM Type C - Switch** card |
| Console connected | A live console session exists | Connection state and App library console status |
| Module loaded | The module is in the active console catalog | Console tile / library state |
| Module running | The application has been opened | Its console interface and session log |

### Why are some app icons gray?

A colored icon indicates the app is loaded in the active console catalog. A gray icon is not loaded there; hovering or keyboard focus reveals its original color. Installing a PC-side runtime is a different operation and is shown inside the card. The checkbox, local runtime state and active console state should not be treated as the same thing.

### Does closing the browser stop the console session?

Closing a tab or browser window normally leaves the server/session running. Reopening the shortcut returns to the panel. Use **Disconnect safely** to request normal cleanup. **! STOP** is the emergency action if normal cleanup is stuck; it can leave the console requiring a full restart.

### What do the local Release shortcuts do?

In this prepared development workspace, **IZ2S Release - Git** opens the release repository in VS Code. **IZ2S Release - Preview** opens a temporary preview of that repository. The existing IZ2S Platform shortcut remains the test installation. These extra shortcuts are local conveniences, not a feature automatically present on every user's PC.

## Installing the PC application

### What do I need on the PC?

The prepared installer targets Linux x64 and ARM64. It supports apt-based Debian/Ubuntu and pacman-based Arch systems. Other distributions need manual dependency installation. A desktop browser is needed for the panel. Individual optional apps can require more software than the base platform.

The base dependency list is Python 3 with Pillow, glslangValidator, spirv-val, Git, curl and CA certificates, tar, xz, OpenSSH client, iproute2, ping and DejaVu Sans. A compatible Node.js 22+ is used when present. Otherwise the installer downloads a private Node.js 24 runtime into the application; it does not replace system Node.js.

### How do I install the release?

Extract the release archive. Open a terminal in the extracted directory:

```sh
./install.sh --check
./install.sh
```

`--check` reports missing requirements without installing them. A nonzero result can simply mean that requirements are missing, including a Node runtime that the actual installer can download. A normal installation may request sudo through your package manager. On Arch, missing packages are installed with a synchronized system upgrade; read its prompt.

The default destination is a new versioned directory below `~/.local/share/iz2s-platform/releases/`. The installer prints its exact path. Start the installed copy with its `start.sh`, or the updated application-menu shortcut. You do not need to run the application itself as root.

### Can I install without changing the current shortcut or system packages?

Yes. Use an absolute destination that does not already exist:

```sh
./install.sh --prefix "$HOME/iz2s-trial" --no-system-packages --no-desktop
```

All system dependencies must already exist. A private Node runtime can still be downloaded into this new folder. Existing destinations are refused rather than overwritten. `--no-desktop` leaves application-menu and desktop shortcuts unchanged.

### Where is the installed application compared with the extracted archive?

The extracted archive is the source you run the installer from. The installer creates a separate usable copy at its destination. Editing the extracted source afterward does not update that installed copy. Similarly, rebuilding an archive does not install or restart it. Always check which folder a shortcut points to before testing a change.

### How do I update or go back?

Install the new artifact into a new versioned folder. Keep the older folder until the new one works. Start the old folder's `start.sh` to return to it. Running its `install-desktop.sh` deliberately repoints the ordinary shortcut to that copy. Stop an active console session first; do not switch versions underneath one.

There is no automatic migration of every private setting or game profile between unrelated copies. Back up data, then move only the settings you understand. An old session directory is a diagnostic record, not a resumable console session.

### How do I remove a trial installation?

Stop its panel/session, then remove only its dedicated installation directory. If it installed shortcuts, inspect/remove or repoint the matching IZ2S shortcut separately. Do not remove the separate test/release source repositories by mistake. Removing a PC copy does not uninstall the ARM agent or erase a saved SmileBASIC program.

## First console setup

### Which hardware configuration should I choose?

Choose **PC + ARM PC**, the enabled default. The PC runs the server; the ARM board supplies USB keyboard input; Switch runs SmileBASIC. ARM PC Only and PC + Cardputer ADV are currently disabled presets. Their folders describe possible future configurations, not completed support. Mac integration is hidden in the test project and omitted from the release.

### What should be open on Switch?

Follow the panel's current step. For source installation or a new launch after a full restart, open **SmileBASIC → Make a Program → Direct**. Do not confirm a fresh Direct screen while an old IZlauncher session is still running. The panel's fresh-screen confirmation is meaningful: it cannot infer every on-console state safely.

### What is the bootstrap?

It is a small SmileBASIC source program used to establish the engine's connection. It is separate from the much larger PC application and from `.izm` modules. Each engine declares its own exact source, checksum and saved filename. Renaming a file does not convert one engine's source into another.

### Which program slot should I choose? What does LIST 1:1 mean?

There are four selectable installation slots: 0, 1, 2 and 3. `LIST 1:1` opens the program list for slot 1 at line 1; the first number is the slot. `LIST 0:1` selects slot 0. The default is **0**. Installation edits the selected slot, so existing source there can be overwritten.

Use an empty slot or back up its source first. Selecting slot 1 protects slot 0 from this source-entry operation, but does not make an existing save filename safe to overwrite. Slot selection and the saved filename are separate choices.

### What is saved, and why does later launch use slot 0?

For example, IZMYSH installed in slot 2 uses:

```text
LIST 2:1
SAVE "TXT:NS2I",2
```

The SAVE command writes slot 2's program to the named file. Later `LOAD "TXT:NS2I"` loads that saved program into the default launch slot 0. Installation can therefore use a spare slot while launch still uses the engine's normal slot-0 path. Back up any unsaved slot-0 work before launching too.

### Are the saved filenames the same for every engine?

No. Current engine descriptors specify:

| Engine | Default save name | START argument count |
| --- | --- | --- |
| IZMYSH | `NS2I` | 9 |
| pepsipu | `NS2P` | 9 |
| kurumuz | `NS2K` | 5 |

These describe this platform's current recipes. Follow the selected engine's generated instructions rather than an old screenshot or a file with a similar name. Do not overwrite one engine's save with another engine's source unless that is an intentional installation.

### Why are source entry, checking, saving and launching separate?

A completed typing job does not prove that the console saved the correct program. The source checker uses character counts and rolling checksums, not a byte-for-byte file readback. Inspect the source/check results, save through the intended command, confirm that step, then fully restart before launching. This separation helps avoid using half-entered or unsaved code.

### Why does START change? Can I copy yesterday's command?

The engine generates a fresh command for the current server and network address. Its argument count also depends on the engine/bootstrap. Use the current panel sequence. Repeating RUN/REMOVE/START after a failed attempt in the same console process can reuse an invalid state; perform a full console restart instead of guessing another command.

### Which console/software versions are supported?

The current engine descriptors list Switch 2, system version **23.0.1** and SmileBASIC **4.4.9**. Treat this as the declared target of these adapters, not a claim that other versions work. The project does not automatically upgrade/downgrade the console or bypass a failed compatibility check.

### Why is an optional engine unavailable?

An adapter in the panel is not the upstream server itself. Choose **Download original engine**, or copy its complete repository into `engines/<id>/upstream/` and choose **Check manual folder**. A couple of files copied from a web page are insufficient when the engine needs libraries/subdirectories. The platform checks the required files and bootstrap hash.

IZMYSH and kurumuz can attach IZlauncher. pepsipu uses **Original**. kurumuz's **Keep RPC active (--rpc)** affects Original mode; IZlauncher keeps the needed RPC automatically. The original repository's files are not rewritten by the adapter.

## ARM board and USB keyboard

### What is installed on ARM, and where?

The deployable package lives in `hardware/agents/arm-input/` on the PC, with a generated archive at `packages/iz2s-arm-input.tar.gz`. The default board destination is `/opt/iz2s/arm-input`. The package supplies input jobs and a local discovery service. It is separate from the PC's Node server and the console bootstrap.

The panel's **First-time setup** provides the archive, manual instructions and explicit SSH installation. [Full ARM instructions](hardware/agents/arm-input/README.md).

### Does any ARM board with USB-C work?

No. It needs Linux, Python 3, systemd, SSH, a USB device/OTG controller and a configured keyboard gadget, normally `/dev/hidg0`. Some USB-C ports provide power or host mode only. This package does not install a board-specific USB driver or rewrite boot configuration to create a gadget.

### Where do the cables go?

The PC and ARM board need a working network path. The ARM board's **data/OTG** USB port connects to Switch. A power-only cable can power a board without carrying keyboard data. Connecting that keyboard gadget to the PC may show a keyboard there, but does not simultaneously connect it to Switch or provide an administrative shell into ARM.

### Do I need to give the panel an SSH password?

The automatic installer uses trusted SSH key authentication, not a saved password. On first use, connect from a terminal, verify the board's host-key fingerprint and configure a key if needed. Passwords are entered in that terminal. The private key stays on the PC. An existing key/SSH agent can be reused; do not overwrite an existing key casually.

Password-only users can download/copy the archive and install from a terminal on the board. The ARM package needs root-equivalent rights for HID access and its systemd jobs. The detailed guide explains both paths.

### Ping works, but SSH says Connection refused. Is the password wrong?

The failure happens before authentication. The address responds, but SSH is unavailable on the requested port. Start the existing SSH service locally on the board, for example `sudo systemctl enable --now ssh` or `sshd` according to its OS. If the address belongs to the wrong device, correct it first. Changing a password does not start a stopped service.

### Why can ARM be ready while USB is waiting?

Network access and USB enumeration are different checks. SSH can succeed while the cable is wrong, the keyboard gadget is absent, or Switch has not configured the link. Check the **ARM Type C - Switch** card separately. Inspecting these cards does not type commands on Switch.

### What survives reboot?

An installed/enabled discovery service starts with the ARM OS. SSH remains the board OS's own service and must be enabled separately if needed. USB gadget persistence depends on the board's OS setup. A persistent service does not preserve a live Switch session across console reboot.

## Connection, network and recovery

### Should automatic discovery find every device?

It can find a compatible ARM discovery service on the reachable local network. It is not a universal network scanner, and it does not assume fresh SmileBASIC Direct has a discovery responder. Switch initiates its main connection through the generated START command. Manual addresses remain available when discovery cannot choose a route or several input boards answer.

Broadcast/multicast filtering, guest networks, AP isolation and different subnets can prevent discovery even when internet access works. Discovery supplies an address; it does not replace SSH host-key trust or enable a network adapter.

### What are the PC, ARM and console addresses?

The **PC/server address** is the PC interface reachable from the console. It should not be `127.0.0.1` for a remote console: that means the device itself. The **ARM address** is used for its SSH input service. The **console addresses** identify its LAN/Wi-Fi paths. They are separate fields, not interchangeable numbers.

Use dots for IPv4, for example `192.168.1.20`. Gateway/DNS values belong to network setup and are not substitutes for the console's own IP. The example is not an address to copy blindly.

### Why does the browser use 127.0.0.1 when Switch needs a LAN address?

The control page is intentionally local to the PC, usually port **39517**. The console connection is a separate listener on the selected PC network interface. File Exchange uses its own console FTP port. Streaming modules allocate their own control/video listeners. There is no single global port that serves every purpose.

### Can LAN and Wi-Fi both be selected?

They can be configured/observed separately. The console OS chooses its active route; selecting two boxes does not create two simultaneous copies of a video stream or force Ethernet to connect. The current address may change when moving between dock and handheld. A remembered address can become stale.

### Does docked mode prove Ethernet is active?

No. Dock state and network type are independent observations. A docked console can still be using Wi-Fi. Check the system's wired connection and the platform's reported route separately. The PC must also have a route back to the console's current address.

### Why is the screen black during a transition?

The streaming display gate intentionally hides old/unready video while a source, resolution or route changes. It opens after a fresh complete validated frame. A black waiting screen is expected briefly; staying black means the required route or fresh video has not arrived. Audio can have a separate state, so hearing sound alone does not prove video resumed.

### Will any lost connection automatically recover?

There are two different failures. A **video-only** connection can restart while the main native console session remains valid. Once the ordinary bootstrap's **main native connection** has ended, it cannot open that connection again by itself. Recreating a PC socket or renaming a save file cannot restore the lost console process.

The normal bootstrap remains unchanged. Historical recovery protocol code is dormant; the platform does not silently install a replacement bootstrap. When the main session is gone or cleanup cannot safely join a native worker, use a fresh full console restart and the panel's new launch sequence.

### Why does STOP leave a launch blocked?

**! STOP** requests host termination and input cancellation. If the platform cannot confirm that the remote keyboard job stopped, it blocks another launch to avoid overlapping commands. It does not claim that killing the PC process released every remote key. Check ARM/input cancellation and fully restart the console when instructed; do not repeatedly click Launch into an uncertain state.

## Modules and File Exchange

### What is in an .izm? Why can it be so small?

It is a ZIP-based module package with a descriptor, declared console/server files, resources, documentation and checksums. Only the declared `switch.files` inventory is sent to Switch. A small integration can call a separately installed large application, so a small IZM does not mean a full game, Electron runtime or operating system fits in those bytes.

The descriptor `module.json` says what the package needs. Downloaded programs live in the module's `runtime/`; private profiles live in its `data/`. Their size is additional. The source for a bundled integration can be larger than its compiled console payload.

### Where does the server half live?

Inside the same module folder, usually `modules/<id>/server/`. It runs on the PC. The console half is under `switch/`. A module may contain one half or both. Declaring a host component does not launch it during catalog discovery: it starts through the relevant module/session lifecycle.

### How do I add or update a module?

Place its valid package in `modules/<id>/<id>.izm`. For a source checkout, keep `module.json`, `switch/` and `server/` together and repack after changes. Use the App library to select/load the module; install any declared PC-side dependencies separately. Missing required module dependencies prevent activation.

Normal startup publishes valid source changes into packages. Explicit packaging is clearer during development:

```sh
./tools/node sdk/pack.cjs modules/iz-exchange
./tools/node sdk/check.cjs
```

A running session retains its verified `.versions/<hash>/` snapshot. Updating source/IZM does not replace code beneath the active session. End it safely and use a fresh session to apply the changed version.

### Can opening a folder run its code?

Catalog discovery reads descriptors; it does not run a newly added extension's installer or application. Starting/installing that extension is a separate action. A running host module is ordinary code under your user account, not an OS sandbox. Install modules from sources you trust.

### How do I use File Exchange?

Load File Exchange, then open its tile on Switch. Its FTP service starts only while the app is open. In an FTP client on your computer, use the **console's current IP**, port **2121**, anonymous login, passive mode and **one simultaneous connection**. Do not use the panel's `127.0.0.1` address for console FTP.

`/save` and `/tmp` allow reading/writing. `/rom` is read-only. A opens a folder, B opens its parent, X refreshes, L/R change pages, Y toggles FTP and Minus returns to IZlauncher. Leaving closes this module's service. [File Exchange details](modules/iz-exchange/README.md).

### Can File Exchange browse all console games, cartridges or system files?

Ordinary access is limited to SmileBASIC's title-owned mounts. The separate experimental game-storage adapter needs `held-filesystem-rpc`, which IZMYSH does not provide. Installing File Exchange does not add that capability or unrestricted cartridge access. The retained OunceCake source has different prerequisites and its own GPL-2.0 notice.

### Are uploads safe to interrupt?

File Exchange writes uploads directly. Replacing a file can leave a partial file if transfer fails. Back up important files and verify the upload before relying on it. The separate experimental **Files** module has its own replacement behavior; do not assume every module implements identical transfer guarantees.

### Does changing a module README require packaging again?

Yes: the README travels inside the IZM and its checksum inventory. Repack that module after editing it. Documentation outside a module does not change its console shaders, but still needs a release rebuild to enter the distribution archive.

## Streaming and controllers

### Why are streaming features described if the release only has File Exchange?

They exist in the experimental project and explain the architecture and known limitations. They are not installed by the File Exchange release. Keep the `pc-screen` module and its declared dependencies when supplying a separate streaming package.

### Where do capture, compression and ports belong?

The **BlitBun** streaming module owns capture, codecs, compression, audio and its listeners. Other game modules reuse its declared components. Video does not pass through the panel page for extra copying. A module's PC controls normally open in an adjacent tab.

### Can I change resolution while streaming?

The ordinary shared stream controls offer automatic docked/handheld sizes or manual output size, plus FPS and render/compression settings. Compatible game integrations use that shared service. A change can briefly close the display gate and recreate a receiver; the selected source is retained where supported. The game's own render resolution and the transmitted image size are separate settings.

The current GTA adapter starts the game at 1280×720. Its customized Thomas tile is a display-name/icon change; it still launches the GTA integration. YouTube uses its own capture surface and 480p source-video preference, which are also separate values.

### Does removing compression guarantee 60 FPS?

No. It reduces some processing and increases network use. Capture, encoding, upload, GPU work, acknowledgements, network conditions and source frame rate can each limit output. In the ordinary module, **Additional compression: Off** and **Rendering: RAM dictionaries** are available choices; keep a known-good profile for comparison. BC1 itself is lossy even when the additional transport compression preserves its encoded bytes exactly.

A gigabit cable is a link rating, not a measurement of end-to-end throughput or minimum displayed FPS. See the streaming module's own README in the test project for exact settings and diagnostic boundaries.

### Should a controller pair with the PC or Switch?

The physical Pro Controller/Joy-Con stays paired **natively with Switch**. The Controllers module reads supported input there and exposes a **virtual** PC gamepad to games. Choosing a physical source and choosing the PC's Nintendo/Xbox output profile are separate settings. Some games need a restart after a virtual-device/profile change. Gyro and rumble forwarding are not implemented.

### What opens the stream menu? Why is Minus delayed?

In the ordinary shared game stream, a quick **double Minus** opens/closes the overlay; a single Minus is forwarded as the game's Back/Select after the 250 ms classification interval. Other buttons/sticks keep their normal path. Plus belongs to the game. Other modules, especially YouTube, can have different controls; read their own guide.

### Why can sound stop when a game is in the background?

The game may mute itself on focus loss. That is separate from the stream's audio capture and from pausing the game. For example, GTA's Mute Audio On Focus Loss is separate from Pause Game On Focus Loss. A running game can keep old settings in memory, so use its menu or restart it normally after saving progress. A profile installer cannot reliably rewrite an in-memory setting.

### How does YouTube work? Does clearing local settings delete account history?

The experimental YouTube module starts VacuumTube on demand on the PC and streams its owned offscreen application. Its source, integration, runtime and private profile stay under the YouTube module folder. Source video defaults to 480p when available; the streamed interface surface is separate. Audio is captured from a private silent sink rather than the PC speakers.

Local profile maintenance does **not** delete YouTube's server-side account history. Account operations and local cache/settings changes are different actions. The platform does not sign in or accept consent screens automatically.

## Files, folders and backups

### What is the top-level folder map?

| Path | What belongs there | Share it? |
| --- | --- | --- |
| `README.md`, `FAQ.md` | Start page and this guide | Yes |
| `panel/` | PC browser interface/controller | Source, yes |
| `core/` | Shared session, storage and console services | Source, yes |
| `engines/<id>/` | Engine descriptor, adapter and bundled IZMYSH server | Source subject to notices |
| `engines/<id>/upstream/` | User-installed original engine checkout | Excluded from the curated release |
| `shells/izlauncher/` | Console menu shaders, resources and host adapter | Source subject to notices |
| `modules/<id>/` | One module and its owned files | Package/source subject to notices |
| `hardware/` | Devices, configurations, transports and ARM package source | Source, yes |
| `profiles/` | Configuration API and compatibility entry files | Source, yes |
| `sdk/` | Formats, schemas and available developer helpers | Source, yes |
| `distribution/` | Release profile, installer and available development tooling | Source, yes |
| `packages/` | Generated ARM package for deployment | Generated distributable, yes |
| `tests/` | Host development tests, present only in the lab | Not in the user runtime |
| `data/` | Settings, session records, caches and possible credentials | Keep private |
| `dist/` | Built archives and local Git bundle | Inspect the specific artifact first |
| `.git/` | Local source history | Never put it inside the runtime archive |
| `.dev/` | Ignored paths linking local projects/shortcuts | Keep private |
| `.release/` | Source import bookkeeping in the release Git project | Developer source only |

### What is inside a module folder?

`module.json` describes it. `switch/` contains the console payload; `server/` contains the PC integration; `assets/` can hold shared resources. `<id>.izm` is the generated portable archive. `.versions/<hash>/` contains a verified version pinned for a session. `runtime/` contains downloaded programs or compiled helpers. `data/` contains private application preferences/profiles. Do not publish mutable runtime/profile folders by accident.

YouTube can also contain `vacuumtube/`, its local upstream source checkout. A checkout, dependencies in `node_modules/`, an installed Electron runtime and private browser data are different things. A source README does not mean the runtime is installed.

### Which files should I edit?

Edit interface behavior in `panel/`, connection-engine behavior in its `engines/<id>/`, console menu rendering in `shells/izlauncher/`, application behavior inside its module, and hardware behavior in its hardware module/transport. `core/` holds truly shared services. Small compatibility forwards are intentional; follow them to the canonical implementation instead of creating another copy.

Do not edit `.versions/`, generated archives, session snapshots or `data/extensions/` as your development source. A future refresh can replace them, and an active session may still use its old version.

### What should I back up?

Commit source changes to Git. Separately back up private platform `data/`, important module `data/`, any user-supplied external game files and the console's important saved programs/files. Git intentionally ignores most private/runtime data. A Git commit is therefore not a full backup of the installed environment or Switch saves.

Keep private backups out of the public repository. Logs can contain local paths, IP addresses and diagnostics even when access keys are redacted. Review them before sharing.

### Can I delete caches or old versions?

Do not delete files underneath an active session. Stop it first. Keep diagnostic records until the issue is understood, and back up settings/profiles before deleting anything called `data`. Downloaded runtimes may need another download/import if removed. When unsure, move a dedicated folder aside with a recognizable backup name instead of deleting unrelated directories.

## Git and release work

### What is a repository, commit, branch and remote?

A **repository** is a source folder with Git history. A **commit** is a saved source checkpoint with a message. A **branch** is a named line of checkpoints, such as `experiments`, `main` or `candidate/...`. A **remote** points to another repository, for example GitHub. Local commits do not require GitHub or an internet connection.

The prepared lab and release are separate repositories. `experiments` holds the lab; `main` holds the accepted curated release. The local preparation configures no GitHub remote and uploads nothing.

### What is the everyday workflow in VS Code?

1. Open the **test project**. In Source Control, click changed files and read the highlighted differences.
2. Stage only the finished files you want saved; do not stage somebody else's unfinished experiment. Write a clear message and commit. Uncommitted work stays outside release promotion.
3. Open **IZ2S Release - Git**. Use **Terminal → Run Task → Release: prepare candidate from lab**.
4. Use **Release: review candidate**, then **Release: verify**. Open **Release: preview** to inspect the interface. Use the isolated-install task when installer behavior changed.
5. If satisfied, use **Release: accept candidate into main**. Build with **Ctrl+Shift+B** or **Release: build archive**.

These tasks prepare local files only. Accepting a candidate is not publishing a GitHub release or installing the artifact on your PC.

### How do I do the same from a terminal?

After committing the desired changes in the lab, run these in the release source repository:

```sh
python3 distribution/workflow.py prepare
python3 distribution/workflow.py review
python3 distribution/workflow.py verify
./preview.sh
# Stop the preview with Ctrl+C, then, once satisfied:
python3 distribution/workflow.py accept
python3 distribution/workflow.py build
```

The local `.dev/local.json` identifies the lab. If absent, pass `--source /absolute/path/to/lab` to `prepare`. Developer workflow scripts are in the source repository, not the minimal installed runtime. [Detailed development guide](distribution/README-development.md).

### Does promotion copy every experiment?

No. The release profile and exporter allow only the curated source set. Currently that means File Exchange, IZMYSH, optional engine adapters and needed platform code/docs. Other modules, tests, downloaded engines, personal state and game runtimes are omitted. An unrelated new module folder does not enter the release just because it exists in the lab.

Promotion takes a **committed** lab snapshot. It does not change the running lab's branch. The release candidate is a new branch; accepted `main` is unchanged until acceptance. A clean release working tree is required, so commit/review local edits before preparing.

### Will release-only edits be lost?

If a file changed only in the release and the corresponding lab file stayed unchanged, the importer preserves the release edit. If both changed differently, it stops and names the conflict before overwriting anything. Review/merge that file deliberately; do not use a destructive reset to silence the message. Keeping common fixes in the lab first usually makes future promotion simpler.

### How do I undo a bad change without losing everything?

For an already committed change, use a new revert commit; it records the undo in history. Before discarding uncommitted edits, read the diff and save anything you need. Do not use `git reset --hard` or `git clean` as routine cleanup while learning. To leave an unaccepted candidate, commit any needed edits and switch back to `main`; the candidate branch remains available.

### What does Build produce?

A clean committed release tree becomes `dist/iz2s-platform-<version>-file-exchange.tar.gz`, its `.sha256` file, and an internal file checksum list. `release.json` records the source commit and release profile. Building regenerates the module/ARM packages in a temporary staging folder rather than modifying the current console session.

A separately created `iz2s-platform-local.bundle` is an offline copy of local Git history. It is not the installer archive and does not include ignored private settings. Regenerate it after source history changes if you need a fresh Git backup.

### Is the local Git author already my GitHub identity?

The initial local commits use the technical placeholder `IZMYSH <local@iz2s.invalid>`. Before public work, set your chosen repository-local name/email, for example a GitHub no-reply address. The placeholder is not a real mailbox. Changing your identity affects future commits; it does not rewrite earlier history automatically.

### What remains before GitHub publication?

Review tracked files, inherited license notices, author identity and the built artifact. Then create/select a remote and push deliberately using SSH or a credential manager. Do not place a token in a remote URL or commit credentials. Checksums show integrity, not authorship. The existing license-review markers remain meaningful; documentation updates do not resolve upstream redistribution permissions.

## Safe previews and installation tests

### Which test should I use for which change?

| Change | Smallest useful check |
| --- | --- |
| README/FAQ | Check links and included docs; rebuild artifact |
| Panel layout | Temporary preview; inspect it visually |
| Package filtering/module metadata | Release verification and inspect the built archive |
| Installer file placement | Isolated installation with no system packages/shortcuts |
| OS dependency installation | Clean container, then a clean VM for desktop behavior |
| ARM USB, Switch rendering, dock/Wi-Fi | Dedicated physical hardware session |

### Is Preview a sandbox?

It uses a temporary application copy, separate settings and an automatically allocated port. It is useful for seeing the interface without disturbing the current panel. It still executes normal local program code and is not an isolation boundary for untrusted extensions. Stop it with Ctrl+C to remove its temporary copy.

### What does the isolated installer test change?

`./distribution/test-install.sh` in the release source repository creates a temporary installation, disables system-package changes and desktop installation, checks it, then removes it. Missing base dependencies cause failure; a private Node download can still happen inside the temporary folder. It does not deploy ARM software or touch Switch.

### What does Docker/Podman test? Has it run here?

The recipe builds a Linux image, runs the installer inside it and exposes a read-only preview on host loopback, normally port 39518. It mounts no host source folders, USB devices, SSH keys or Docker socket. Rootless operation is preferred. It does not prove the actual Switch/ARM/desktop workflow.

In the initial local preparation, the Docker command was installed but its daemon was unavailable; the container image was **not built or run**. The recipe is prepared, not a reported pass. There is no automatic Docker installation/service enablement. Recheck the host setup before running `./distribution/container.sh`.

### Why would I also use a virtual machine?

A VM has its own guest OS. Take a clean snapshot, install the release, inspect dependency prompts, the desktop shortcut and first launch, then restore the snapshot. That tests system changes without changing your everyday OS. A container shares the host kernel and does not reproduce a complete desktop by itself. The [development guide](distribution/README-development.md#complete-installation-in-a-vm) gives the steps.

## Troubleshooting checklist

### The shortcut does nothing or opens an old version

Check its target folder, confirm that folder still exists, and start its `start.sh` from a terminal to see the error. The ordinary desktop installer repoints the ordinary shortcut to its own copy. The Release Git/Preview shortcuts serve separate purposes. A newly built tar archive does not update any shortcut automatically.

### The panel says the port is in use

Another copy/process can own port 39517. Reopen the correct existing panel first. An explicit restart can hand over a verified prior IZ2S panel; unrelated processes are not stopped. A temporary preview uses a different port. Do not kill an unknown process merely because it occupies that port.

### An engine appears, but Download/Launch fails

Read that engine's log. Check internet access for downloads, its complete manual folder, bootstrap checksum and the engine mode. A successful download does not type source into Switch. A valid host file is not evidence that the console saved the same source.

### SmileBASIC reports Syntax error, Type mismatch or Wrong number of arguments

Stop the failed attempt. Verify the selected engine, its saved filename and the actual source previously saved on the console. A nine-argument saved program is not a five-argument program. Do not keep retrying memory-preparation commands in the failed process. Use a full console restart and the correct saved bootstrap/sequence. Save a clear photo and the matching session log if reporting the failure.

### The module immediately returns to IZlauncher

Check the matching session/module log, missing declared dependencies and the packaged version. The core can return to the menu after a fatal module error once it has safely cleaned up. A folder existing on the PC does not prove its runtime, compiled resources or console package is usable. Do not replace a pinned `.versions/` file by hand.

### The stream has sound but no picture, or remains black

Confirm the source window exists and the desired physical mode/network are reported separately. Check the docked/handheld sizes and whether the profile is waiting for Ethernet/Wi-Fi. Verify fresh video arrival; audio alone cannot open the video gate. If the main native session ended, do not expect the video socket alone to restore it.

### How do I report an issue usefully?

Record the release version/commit if available, engine, module, last working step, actual console screen and whether the main session is alive. For streaming, add source size, selected output size, dock/handheld mode, actual LAN/Wi-Fi route and when the transition occurred. Share the relevant bounded log after checking it for private data. A short reproducible sequence is more useful than running every unrelated test.

## Small glossary

| Term | Plain meaning |
| --- | --- |
| Host / server | The computer running the platform/application service |
| Runtime | Software/files needed to actually run an app, beyond its adapter |
| Descriptor | JSON metadata telling the platform what an extension contains/needs |
| Bootstrap | Saved SmileBASIC connection program |
| RPC | Requests the PC sends through the established console connection |
| ABI | The agreed layout/calling rules shared by compatible components |
| Checksum / hash | A fingerprint used to detect changed/corrupt bytes |
| Pinned version | A verified snapshot kept fixed while a session uses it |
| Commit | Saved Git source checkpoint |
| Candidate | Proposed release changes awaiting review/acceptance |
| Build / artifact | Creating the distributable archive / the resulting file |
| Install | Creating a usable application copy on a machine |
| Launch | Starting a process/session from already prepared files |

[Back to the main README](README.md)

## Choosing IZPSlauncher and unloading apps

### How do I select the blue console menu?

Choose **IZPSlauncher** in the panel’s Console connection / Launch mode selector before starting the next session. The panel discovers both shell descriptors automatically. The current session keeps the shell it started with. IZlauncher remains available.

### How do I remove a loaded app from the console menu?

In the PC App library, click **Remove from console** on a loaded app card and confirm. Alternatively, select the app in either console shell, press **Minus**, then A to confirm or B to cancel. Touch also works on the footer action and confirmation buttons.

This removes the session catalog entry. Its IZM package, PC component and saved settings remain available on the computer, so it can be loaded again. A module currently in use is not stopped; pending changes wait for a return to the console menu. There is no Uninstall from PC action.

### What happens when there is no activity?

IZPSlauncher shows one compact No recent activity row. It uses actual completed package jobs, never file modification timestamps. The feed and scroll limits grow with the available events and shrink when there are fewer rows. Example events in documentation screenshots are demonstration data.

### Why was the IZPSlauncher library empty in rc.4?

rc.4 treated the visual shell ID as the only module compatibility key. Existing modules require the IZlauncher module format, so the IZPSlauncher process filtered them all out. rc.5 declares that format explicitly through `moduleShells` in its shell descriptor and uses it consistently for the panel, startup selection and native package library. Update the panel, fully restart the console after an ended session, choose IZPSlauncher and start a fresh session. Application modules do not need to be repacked just for the new shell name.
