# IZ2S Platform

**0.16.0-rc.3 · Linux x64 / ARM64 · File Exchange release**

IZ2S Platform runs a control panel on your computer. **IZlauncher** and **IZPSlauncher** are the menus shown on Switch 2 through SmileBASIC. The PC application, ARM input agent, console bootstrap and modules are installed/started separately.

**Read the [detailed FAQ and practical guide](../FAQ.md)** for plain-English explanations, folder locations, first setup, backups, Git, safe testing and troubleshooting.

**Host OS:** Linux only. Windows and macOS are unsupported; ARM64 remains a declared target with incomplete hardware validation. [Support details](../SUPPORT.md).

## What’s new in 0.16.0-rc.5

- Fix the empty module library in **IZPSlauncher**. The native process previously rejected every package requiring IZlauncher because it compared the module-format name with the new visual shell ID.
- IZPSlauncher now explicitly declares the IZlauncher module format it implements. The panel, startup selection and native library evaluate the same selected-shell contract; host and console-ABI checks remain enforced.
- Add regression checks that reproduce the native IZPSlauncher environment, publish a nonempty console picker and complete a browser-queued load through the package/catalog boundary using local mock storage.
## What is included?

- **File Exchange**, for SmileBASIC title-owned file browsing and FTP.
- **ns2jb by IZMYSH**, the only preinstalled engine.
- Adapters for pepsipu and kurumuz. Download their original source explicitly in the panel, or copy it into `engines/<id>/upstream/` and choose **Check manual folder**.

Streaming, games, YouTube and test applications from the experimental project are **not bundled** in this release. Original-engine files are not downloaded by the installer.

## Install and start

Extract the archive, open a terminal in the extracted directory, then run:

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

Choose **PC + ARM PC**, the enabled default. Install/check the ARM agent through **First-time setup**, connect its USB data/OTG port to Switch, and follow the panel's engine instructions. [Hardware overview](../hardware/README.md).

Bootstrap installation uses a selected program slot 0–3, default **0**. Existing code in that slot and an existing named save can be overwritten: back up first. Source entry, source checking, Save and Launch are separate steps. After saving, fully restart Switch and open **SmileBASIC → Make a Program → Direct** before a fresh launch. Use current generated commands, not an old START line.

The App library distinguishes a loaded console module from a locally installed PC component. Opening File Exchange starts its FTP listener on the console at port **2121**. Use the console's current IP, anonymous/passive FTP and one simultaneous connection. `/save` and `/tmp` allow writes; `/rom` is read-only. This is not access to the entire console. [File Exchange guide](../modules/iz-exchange/README.md).

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

The [FAQ](../FAQ.md) explains every major folder and common failure. The [development guide](README-development.md) explains Git, promotion, containers and VM snapshots. Developer commands require the source repository; they are deliberately absent from the minimal installed runtime.

This release uses the ordinary bootstrap. Video-only recovery and recovery after the main console session ends are different; the ordinary bootstrap cannot recreate its ended main connection. Host checks do not prove physical Switch/ARM64 behavior. See `LICENSE` and `THIRD_PARTY.json`: inherited license-review notices are retained and must be addressed before public redistribution.

## Project license

Independently authored IZMYSH code is licensed under **GPL-2.0-or-later**.
See [LICENSE](../LICENSE), [COPYRIGHT](../COPYRIGHT) and [license scope](../LICENSE-SCOPE.md).
Existing component terms and prior MIT grants remain applicable.
