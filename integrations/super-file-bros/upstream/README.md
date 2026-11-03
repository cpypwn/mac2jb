# Super File Bros.

**A file manager for Nintendo Switch 2.** Browse your console and SD card, download files and ZIP folders, manage SD files, and open a read-only FTP export in your preferred file manager.

[Safety notice](DISCLAIMER.md) · [Release notes](RELEASE_NOTES.md)

> **Use with caution.** Modifying, corrupting or deleting files can have unexpected consequences, including consequences that appear later. You may lose screenshots, installed content, saves or access to software. Back up important data first. Folder deletion is permanent and includes its contents. You are responsible for the operations you choose; the software is provided without warranty.

## Compatibility

Super File Bros. connects to a **verified, retained FS RPC session**. Connection options and availability:

| Launcher | Required launch mode | Instructions |
| --- | --- | --- |
| [IZ2S-Platform](https://github.com/byizmysh/IZ2S-Platform) | Coming in the next few days | Integration will be available in the next few days. |
| [BermTheSequel/ns2jb2](https://gitlab.com/BermTheSequel/ns2jb2) | `node run.cjs --rpc` | Follow that project's current setup and console requirements. |
| [kurumuz/ns2jb](https://gitlab.com/kurumuz/ns2jb) | `node run.cjs --rpc` | Follow that project's current setup and console requirements. |

The application checks the run folder, matching session proof and live FS endpoint before connecting. An old run folder, GPU mode, native RPC alone, or a normal run that has already closed its endpoint is insufficient. Compatibility depends on the upstream run format and a successful live session, not just the repository name.

## Requirements

- A PC running Windows, macOS or Linux and a current browser.
- [Node.js](https://nodejs.org/) **20.20 or newer; 22+ recommended**, available on PATH. The selected upstream launcher may impose a higher minimum.
- One of the launchers above, running on the **same PC**, with its complete held run folder available locally.
- A reachable console IPv4 address on your local network.
- Optional: an FTP-capable file manager such as FileZilla or Dolphin.

No `npm install`, Python, compiler or administrator privileges are required to run this manager. Required upstream files are read from your existing run folder; do not copy only its JSON files.

## Installation: download, extract, launch

1. Download the archive for your operating system from the GitHub release assets:

   | System | Archive |
   | --- | --- |
   | Windows | `super-file-bros-0.1.0-windows.zip` |
   | macOS | `super-file-bros-0.1.0-macos.zip` |
   | Linux | `super-file-bros-0.1.0-linux.tar.gz` |

   Each package includes the matching launchers, a platform-specific **START_HERE.md**, and the complete English instructions. Node.js is installed separately; these are portable source packages, not standalone native executables. They use the architecture of your installed Node.js runtime.
2. Extract the **entire** archive to a folder you can write to. Do not start it inside the archive. Keep the folder's contents together.
3. Install Node.js from its official website if it is not already installed, then reopen your terminal or launcher.
4. Start the application:

| OS | Start | Optional shortcut |
| --- | --- | --- |
| Windows | Double-click **Start Windows.cmd** | Run **Install Windows.cmd**; creates a Start menu shortcut for your user. |
| macOS | Double-click **Start macOS.command** | Run **Install macOS.command**; creates `~/Applications/Super File Bros.app`. |
| Linux | Run **`sh start.sh`** from the extracted folder | Run **`sh "Install shortcut.sh"`**; creates an application-menu entry. |

If macOS/Linux reports that a script is not executable, use `sh "Start macOS.command"` or `sh start.sh` in a terminal. If the OS blocks an unsigned script, use the terminal commands after reviewing the source and follow your OS's normal security guidance.

The optional installers create shortcuts only: they do not download dependencies, change the original RPC launcher, copy the manager to another location or require root/admin access. Keep this portable folder in place after creating a shortcut; rerun the installer if you move it. On macOS, shortcut diagnostics go to `super-file-bros.log` in this folder.

For any OS, the universal alternative is:

```sh
node start.cjs
```

## First connection, step by step

1. Have an active FS RPC connection from **ns2jb2** or **ns2jb** in `--rpc` mode, and leave that connection application running. Refer to the selected project's own connection instructions.
2. Start Super File Bros. Its local page opens automatically. If it does not, use the private link printed in its terminal.
3. The manager revalidates saved settings and searches nearby **ns2jb2/ns2jb** folders for active `runs/switch2-*` sessions. The detected path is filled into Connection settings. **Detect session** repeats this search.
4. Enter **Console IPv4** if it has not been saved. If your session is stored elsewhere, enter the full **Held FS run folder** manually, for example `/path/to/ns2jb2/runs/switch2-ABC123`, then click **Connect**. Select the complete current session folder, not the repository root.
5. Choose **Installed games** or **SD & console storage** and wait for **ready**.

Automatic detection searches near the application folder and the previously selected location, not the entire disk or LAN. A valid saved folder takes priority; otherwise the newest active nearby session is selected. The console IP may need to be entered on first connection.

You can supply both values directly instead of filling the form:

```sh
node start.cjs --run "/absolute/path/to/ns2jb2/runs/switch2-ABC123" --host 192.168.1.20
```

On Windows, for example:

```powershell
node start.cjs --run "C:\Tools\ns2jb\runs\switch2-ABC123" --host 192.168.1.20
```

`--no-open` prints the local URL without opening a browser. `--help` prints the command syntax. The private URL key controls this local tool: do not publish it or share your live run folder. An IP alone cannot replace the run folder or retained FS handles. After restarting the console, establish a new session and select its new run folder.

## What you can do

### Installed games

The list identifies **Console storage**, **SD card** or **Game card**. Multiple reported locations are shown together. Select **Connect** beside a game to prepare its accessible decoded content using OunceCake. Large games can take several minutes. Select **Open in file manager** once ready, or use the displayed FTP address in your own client. One export is active at a time.

### SD & console storage

Click **Start storage FTP**. Open folders under `/sd`, `/system` and `/user`; only mounts opened by your current session are shown. Directory contents are loaded as you browse. Raw storage mode shows on-disk files; the separate game mode exposes decoded game content. Raw partition access and general save decryption are not provided.

| Action | SD browser | Internal console browser | FTP / decoded game export |
| --- | --- | --- | --- |
| Browse and download | Yes | Yes, when accessible | Yes, read-only |
| Download folder as ZIP | Yes | Yes | Through the browser's storage view only |
| Upload files/folders | Yes | No | No |
| Create folder, rename, delete | Yes | No | No |

**Downloads:** use **Download**, **Download ZIP**, or **Download this folder (ZIP)**. Files go to the browser's chosen download location. The **Downloads** section shows transferred bytes and cancellation. Folders stream as uncompressed ZIP64 archives with nested and empty directories; file contents are not buffered as a complete archive. A disconnected download cannot resume: restart it and discard the partial file.

**Uploads:** inside `/sd`, select **Upload files** or **Upload folder**. Progress and **Cancel upload** appear in the panel. Existing names are rejected rather than overwritten. A file is written in 32 KiB chunks to a temporary file, verified in the console buffer, flushed, then renamed into place after completion. Cancelling removes the current incomplete file; files already completed and folders already created remain. Browser folder uploads preserve supplied relative paths; use **New folder** for empty folders.

**Rename and delete:** use the buttons beside an SD entry. Rename cannot replace an existing destination. **Delete permanently** requires confirmation and recursively deletes folder contents. Mounted roots and internal console partitions cannot be changed through these controls. Read the safety notice before editing files, especially inside `Nintendo`.

**Keep both applications running** until transfers finish. Do not launch competing exports of the same console services. Changing the selected game/mode or disconnecting an export is blocked while a browser transfer is active. These are not transactional backups and do not guarantee recovery from network failure or console crashes.

## File manager / FTP setup

Select a file manager and click **Open in file manager**. Presets include FileZilla, Dolphin, Nautilus, Nemo, Thunar, Finder and the system FTP handler where applicable. A custom executable path is also supported; provide an executable, not a shell command.

Use the exact console address and port shown in the panel, **anonymous login**, **passive mode**, and **one simultaneous connection**. Ports rotate within **2122–2199** when exports restart; do not assume a fixed port. FTP itself remains read-only; use the browser's SD controls for uploads, rename and delete. A browser alone may not open `ftp://` links. FTP is unencrypted and anonymous: use a trusted local network, avoid port forwarding and stop the export when finished.

## Stopping, upgrading and uninstalling

Finish or cancel transfers, then click **Disconnect export**. Close the manager with **Ctrl+C** in its terminal. A macOS app shortcut runs in the background; to stop its process, use Activity Monitor and identify the `node` process whose command points to this installation. Close the original RPC launcher only after all manager operations have finished; follow its cleanup instructions.

For upgrades, stop the old instance and extract the new version into a new folder. You may copy its `data/state/fs-rpc-browser/connection.json` locally to preserve preferences; saved session details still need to be valid. Never include `data/` in a public repository or release. Rerun the optional shortcut installer to point to the new folder. Remove the old folder only after preserving anything you need.

To uninstall, stop the manager, remove its portable folder and delete its optional shortcut: the Windows Start menu entry, `~/Applications/Super File Bros.app` on macOS, or `super-file-bros.desktop` under your Linux user application directory. Your console data is separate from the manager installation.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Node not found / unsupported version | Install the required Node.js version, reopen the terminal, check `node --version`. |
| No active session detected | Use Connection settings with the exact current run folder and console IPv4. First-time upstream runs may need manual selection; auto-detection does not scan the LAN or all folders on disk. |
| Run folder is not qualified | The launcher must finish its held FS checks with `--rpc`; a regular completed run or native/GPU-only connection cannot be upgraded by this manager. |
| Service busy / not responding | Wait for preparation or a transfer. Check the original launcher and console, then retry. Do not replay uncertain native operations. If the session ended, start a new qualified run. |
| FTP is unreachable | Check console IP, local routing/firewall, the current port and the active upstream session. Allow only the required local-network traffic; do not disable the firewall globally. |
| File manager did not open | Install an FTP-capable client or set its exact executable path. FileZilla is an alternative when the system handler has no FTP support. |
| Upload or rename reports an existing name | Choose a new name. The tool intentionally does not overwrite existing entries. |
| Partial upload after a crash | Cancel through the still-running manager when possible. Abandoned uploads expire while the service is alive; after a terminated service, a `.ns2-upload-*.part` file may need manual cleanup. Inspect the path first. |
| Internal folder is unavailable | The current session could not open that mount; this is not resolved by enabling SD write controls. |

## Privacy and security

The web UI listens only on `127.0.0.1` and uses a private access key. There is no cloud account, telemetry or remote control service. Settings and local export metadata are written under `data/`. Console FTP is a separate network service with the limitations above. A local private UI does not make anonymous FTP safe on an untrusted network.

## Source, building and GitHub releases

Each platform archive contains the runnable source tree and required static/native assets. It is also ready to use as the initial contents of a GitHub repository: include the files inside `super-file-bros/`, including hidden `.github/` and `.gitignore`, and exclude all generated `data/`, logs and captures. No repository or release is published automatically by the desktop application.

Development verification requires Node.js and Python 3 (used for ZIP tests and packaging only):

```sh
npm test
python3 tools/fs-rpc-browser/release.py
```

The build creates separate reproducible Windows/macOS ZIPs and a Linux tar.gz, SHA-256 checksums and per-platform file manifests under `dist/super-file-bros/`. The included GitHub Actions workflow checks the source on Windows/macOS/Linux and builds the release assets. Its manual run uploads an artifact; pushing a `v*` tag also creates a **draft release** for review. Review its notes, assets and disclaimer before publishing. GitHub automatically generated source archives differ from the platform release assets until you run the builder.

## Credits and license

GPL-2.0-only; see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Unmodified [OunceCake](https://github.com/misshexa66/OunceCake), revision `6fcf9e80d302ff43c96dd5d912c9b08a11913daf`, supplies decoded game exports and its console payload. Its license, payload source and build files are included. The connection projects are separate projects; their current instructions and requirements remain authoritative. Use only content and consoles you are authorized to access. No Nintendo branding or game assets are included.

## English-only distribution

All project instructions, interface text, comments and release materials are in English. The release builder checks all packaged UTF-8 text files and rejects Cyrillic text, including in source comments and tests. Console filenames and game names are displayed as provided by the console; the manager does not translate or rename your data.
