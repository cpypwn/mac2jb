# IZ2S Platform

**0.16.0-rc.5 · Linux x64 / ARM64**

IZ2S Platform runs a control panel on your computer. **IZlauncher** is the menu shown on Switch 2 through SmileBASIC. The PC application, ARM input agent, console bootstrap and modules are installed/started separately.

**Read the [detailed FAQ and practical guide](FAQ.md)** for plain-English explanations, folder locations, first setup, backups, Git, safe testing and troubleshooting.

**Host OS:** Linux only. Windows and macOS are unsupported; ARM64 remains a declared target with incomplete hardware validation. [Support details](SUPPORT.md).


## What’s new in 0.16.0-rc.5

- Fix the empty module library in **IZPSlauncher**. The native process previously rejected every package requiring IZlauncher because it compared the module-format name with the new visual shell ID.
- IZPSlauncher now explicitly declares the IZlauncher module format it implements. The panel, startup selection and native library evaluate the same selected-shell contract; host and console-ABI checks remain enforced.
- Add regression checks that reproduce the native IZPSlauncher environment, publish a nonempty console picker and complete a browser-queued load through the package/catalog boundary using local mock storage.
## Modules for IZ2S Platform

Extend IZlauncher with these separately installed modules:

| Module | What it does | Get it |
| --- | --- | --- |
| **[BlitBun](https://github.com/byizmysh/BlitBun)** | Stream a PC application's video and audio to NS2, with live resolution changes, separate Dock/Handheld profiles and optional forwarding of controllers paired with the console. | [Download and install](https://github.com/byizmysh/BlitBun/releases/latest) |
| **[VacooTube](https://github.com/byizmysh/VacooTube)** | A YouTube player for NS2 with touch and controller navigation. Browsing, search, playback and settings are controlled entirely from the console after setup; the application runs on the PC in the background. Includes its own bundled BlitBun streaming engine. | [Download and install](https://github.com/byizmysh/VacooTube/releases/latest) |

Install IZ2S Platform first, then follow the chosen module's README. Both modules include their PC and console components and can be installed independently: neither requires the other. They are optional downloads and are not bundled with the platform installer.

## PC control panel

Choose a connection engine, prepare your ARM input device and manage the modules available to your console.

<table align="center">
  <tr>
    <td align="center" width="50%">
      <a href="docs/images/connection.jpg"><img src="docs/images/connection.jpg" width="420" alt="PC panel showing connection engines and hardware configuration"></a><br>
      <sub><strong>Connection setup</strong><br>Choose an engine and configure the PC, ARM input device and console.</sub>
    </td>
    <td align="center" width="50%">
      <a href="docs/images/app-library.jpg"><img src="docs/images/app-library.jpg" width="420" alt="PC panel showing module selection in the App library"></a><br>
      <sub><strong>App library</strong><br>Browse available modules and select what to load on your Switch 2.</sub>
    </td>
  </tr>
</table>

<p align="center"><sub>Panel previews without a connected console. Click either image to enlarge.</sub></p>

## IZlauncher

**IZlauncher** is the console-side homebrew menu for NS2. Browse loaded apps, filter or search the library, and add available modules using controller or touch controls. The PC panel manages the connection and host components; IZlauncher provides the interface on your Switch 2.

<p align="center">
  <a href="docs/images/izlauncher.jpg"><img src="docs/images/izlauncher.jpg" width="680" alt="IZlauncher console menu with File Exchange selected, app navigation and search"></a><br>
  <sub><strong>The console menu</strong> — File Exchange selected, with app navigation, search and the Add app shortcut.</sub>
</p>

## What is included?

- **File Exchange**, for SmileBASIC title-owned file browsing and FTP.
- **ns2jb by IZMYSH**, the only preinstalled engine.
- Adapters for pepsipu and kurumuz. Download their original source explicitly in the panel, or copy it into `engines/<id>/upstream/` and choose **Check manual folder**.

BlitBun and VacooTube are available as [separate module downloads](#modules-for-iz2s-platform). Games and experimental test applications are **not bundled** in this release. Original-engine files are not downloaded by the installer.

## Install and start

Download the installation archive from [Releases](https://github.com/byizmysh/IZ2S-Platform/releases), extract it, open a terminal in the extracted directory, then run:

```sh
./install.sh --check
./install.sh
```

The installer supports Debian/Ubuntu and Arch-based package managers. Missing OS dependencies may require sudo. On Arch, that operation includes a synchronized system upgrade; review the package-manager prompt. Other Linux distributions can install requirements manually and use `--no-system-packages`.

The installer uses Node.js 22+ when available, otherwise downloads a private Node.js 24 runtime and verifies its official SHA256 list. System Node.js stays unchanged. Required base tools are Python 3/Pillow, glslangValidator, spirv-val, Git, curl/CA certificates, tar, xz, SSH client, iproute2, ping and DejaVu Sans. A browser displays the panel.

A new versioned installation is created below `~/.local/share/iz2s-platform/releases/`; the exact path is printed. Existing installation folders are never overwritten. A normal install updates the ordinary IZ2S application-menu shortcut to the installed copy. Start it there or run `start.sh` in that installed folder.

To keep the existing shortcut and all system packages unchanged, when dependencies are already present:

```sh
./install.sh --prefix "$HOME/iz2s-trial" --no-system-packages --no-desktop
```

The destination must not exist. A private Node runtime may still be downloaded into it. Installation does not start a console session or type a bootstrap.

## See the interface without installing

```sh
./preview.sh
```

This opens a temporary copy with separate settings and an automatically allocated local panel port. Stop it with Ctrl+C. It does not connect Switch. It is a convenience preview, not an OS security sandbox.

## Connect the console

Choose **PC + ARM PC**, the enabled default. Install/check the ARM agent through **First-time setup**, connect its USB data/OTG port to Switch, and follow the panel's engine instructions. [Hardware overview](hardware/README.md).

Bootstrap installation uses a selected program slot 0–3, default **0**. Existing code in that slot and an existing named save can be overwritten: back up first. Source entry, source checking, Save and Launch are separate steps. After saving, fully restart Switch and open **SmileBASIC → Make a Program → Direct** before a fresh launch. Use current generated commands, not an old START line.

The App library distinguishes a loaded console module from a locally installed PC component. Opening File Exchange starts its FTP listener on the console at port **2121**. Use the console's current IP, anonymous/passive FTP and one simultaneous connection. `/save` and `/tmp` allow writes; `/rom` is read-only. This is not access to the entire console. [File Exchange guide](modules/iz-exchange/README.md).

## Where to look next

| Folder | Purpose |
| --- | --- |
| `panel/`, `core/` | PC interface and shared session services |
| `engines/` | Separate connection-engine implementations/adapters |
| `shells/izlauncher/` | Console menu, renderer and host adapter |
| `modules/iz-exchange/` | File Exchange console and PC halves |
| `hardware/`, `packages/` | Device setup, ARM source and deployable archive |
| `data/` | Private local settings, logs, caches and credentials; keep private |
| `modules/<id>/data/`, `runtime/` | Private module settings and extra installed programs |

The [FAQ](FAQ.md) explains every major folder and common failure. The [development guide](distribution/README-development.md) explains Git, promotion, containers and VM snapshots. Developer commands require the source repository; they are deliberately absent from the minimal installed runtime.

This release uses the ordinary bootstrap. Video-only recovery and recovery after the main console session ends are different; the ordinary bootstrap cannot recreate its ended main connection. Host checks do not prove physical Switch/ARM64 behavior. See `LICENSE` and `THIRD_PARTY.json`: inherited license-review notices are retained and must be addressed before public redistribution.

## Project license

Independently authored IZMYSH code is licensed under **GPL-2.0-or-later**.
See [LICENSE](LICENSE), [COPYRIGHT](COPYRIGHT) and [license scope](LICENSE-SCOPE.md).
Existing component licenses and prior MIT grants remain applicable; this is not
a blanket relicensing of third-party material.

## Build from source

The prepared installation archive already contains compiled console shaders. Use the source repository to modify and rebuild the menus:

```sh
git clone https://github.com/byizmysh/IZ2S-Platform.git
cd IZ2S-Platform
git checkout v0.16.0-rc.5
node shells/izpslauncher/build.cjs
node shells/izlauncher/server/build-app.cjs
node distribution/verify.cjs
node --test distribution/tests/*.test.cjs
```

Use Node.js 22 or newer. The existing installer guide lists the required Linux tools, Python/Pillow, DejaVu fonts and shader compilers. `node distribution/verify.cjs` validates descriptors, packaged modules, source syntax and documentation links.

To create an installation archive from a clean, committed source tree:

```sh
node distribution/build.cjs
```

If rebuilding changed tracked shader/font files, review and commit those outputs before packaging. The builder refuses a dirty tree. It writes `dist/iz2s-platform-<version>-file-exchange.tar.gz` and the matching `.sha256` file, with the exact source commit recorded in `release.json` inside the archive. Private settings, downloads and experimental modules are excluded. See the [development guide](distribution/README-development.md) for isolated installation checks and the [release template](distribution/RELEASE-TEMPLATE.md) for the required release sections.
