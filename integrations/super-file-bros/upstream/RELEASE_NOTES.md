# Super File Bros. 0.1.0

English-only platform release for **Super File Bros.**. A file manager for Nintendo Switch 2, using an existing qualified held FS RPC run from [ns2jb2](https://gitlab.com/BermTheSequel/ns2jb2) or [ns2jb](https://gitlab.com/kurumuz/ns2jb).

## Included

- Installed game list with console/SD/game-card locations and decoded read-only game exports through OunceCake.
- Direct browsing of accessible SD and internal console filesystems.
- Browser downloads of files and streaming ZIP64 folders, progress and cancellation.
- SD uploads of files/folders, new folders, rename and confirmed permanent deletion; existing names are not overwritten.
- Optional file-manager launch with the displayed read-only FTP URL.
- Separate Windows, macOS and Linux packages with matching launchers, optional user-level shortcuts, English-only setup guides and dependency checks.
- Source, third-party notices, SHA-256 manifest and automated build workflow.

## Before starting

Install Node.js 20.20+ (22+ recommended), extract the entire asset, establish `node run.cjs --rpc` with your chosen upstream launcher, and leave it running. The session folder is detected from saved settings or nearby ns2jb2/ns2jb runs. Enter the console IPv4 if needed; a manual folder selection remains available. Read README.md for complete steps.

## Limitations

SD writes are available through the browser. Internal mounts, decoded game exports and FTP remain read-only. Only one active export is supported. Transfers require the original session and console to remain available. Downloads cannot resume after disconnection. Browser folder uploads do not enumerate empty directories. Current upstream requirements still apply.

## Safety disclaimer

**Use with caution: modifying, corrupting or deleting files can have unexpected consequences, including consequences that appear later. Back up important data first. Folder deletion is permanent and recursive. The software is provided without warranty; you are responsible for the operations you choose.** Read DISCLAIMER.md before changing files.

## Assets

- `super-file-bros-0.1.0-windows.zip` — Windows launchers and source.
- `super-file-bros-0.1.0-macos.zip` — macOS launchers and source.
- `super-file-bros-0.1.0-linux.tar.gz` — Linux scripts and source, preserving executable permissions.
- `SHA256SUMS` — checksums for all three archives.
- `SOURCE-MANIFEST-windows.json`, `SOURCE-MANIFEST-macos.json`, `SOURCE-MANIFEST-linux.json` — per-file checksums, also included inside each package as `SOURCE-MANIFEST.json`.

Each archive includes **START_HERE.md**, the full **README.md**, the safety notice and source. Node.js is required separately. All distributed project text is in English.
Keep private run folders, `data/`, logs and console content out of public issues and release uploads. Publish only the generated release assets.
